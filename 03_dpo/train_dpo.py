"""
==========================================================================
DPO（直接偏好优化）训练脚本
==========================================================================
这个脚本演示了 DPO（Direct Preference Optimization）训练流程。

DPO 的核心思想：
    传统 RLHF 需要三步：SFT → 训练奖励模型 → PPO 强化学习
    DPO 把后两步合并成一步：直接用偏好数据优化模型

    DPO 论文证明了：最优的 RLHF 策略可以用一个简单的分类损失来等价表示。

DPO 损失函数：
    L = -log σ(β × (log π(y_w|x)/π_ref(y_w|x) - log π(y_l|x)/π_ref(y_l|x)))

    其中：
    - y_w: chosen（人类偏好的回答）
    - y_l: rejected（人类不偏好的回答）
    - π: 当前正在训练的模型
    - π_ref: 参考模型（冻结的 SFT 模型）
    - β: 温度参数（控制偏离参考模型的程度）

    直觉：让模型给好回答更高的概率（相对于参考模型），
          同时给差回答更低的概率。

使用方法：
    source venv/bin/activate
    python 03_dpo/train_dpo.py

依赖：
    pip install torch transformers trl datasets
==========================================================================
"""

import json
import os
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModelForCausalLM

# ======================================================================
#  配置参数
# ======================================================================
CONFIG = {
    # --- 模型配置 ---
    "model_name": "gpt2",

    # --- DPO 配置 ---
    "beta": 0.1,              # β 参数：控制 KL 约束的强度
                               # 越大 → 越保守（不敢偏离参考模型）
                               # 越小 → 越激进（可能 reward hacking）
                               # 典型值：0.1 - 0.5

    # --- 数据配置 ---
    "data_path": "03_dpo/data/dpo_data.jsonl",
    "max_length": 256,

    # --- 训练配置 ---
    "num_epochs": 2,
    "batch_size": 1,           # DPO 需要更多显存（同时计算两个回答）
    "learning_rate": 5e-7,     # DPO 用非常小的学习率（模型已经 SFT 过了）

    # --- 输出配置 ---
    "output_dir": "03_dpo/output",
    "log_every": 3,
}


# ======================================================================
#  数据集类
# ======================================================================
class DPODataset(Dataset):
    """
    DPO 数据集：每条数据包含 prompt + chosen（好回答）+ rejected（差回答）

    和 SFT 数据集的区别：
        SFT: (instruction, output)     → 一个样本
        DPO: (prompt, chosen, rejected) → 一对样本

    DPO 训练时需要同时处理 chosen 和 rejected，
    计算它们各自的 log probability，然后比较。
    """

    def __init__(self, data_path, tokenizer, max_length=256):
        self.tokenizer = tokenizer
        self.max_length = max_length
        self.data = []

        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    self.data.append(json.loads(line))

        print(f"[数据集] 加载了 {len(self.data)} 条偏好数据对")

    def __len__(self):
        return len(self.data)

    def _encode_pair(self, prompt_text, response_text):
        """
        编码一个 (prompt, response) 对。
        返回 input_ids, attention_mask, 以及 response 部分的起始位置。
        """
        formatted_prompt = f"### 指令：\n{prompt_text}\n\n### 回答：\n"
        full_text = formatted_prompt + response_text

        prompt_enc = self.tokenizer(formatted_prompt, add_special_tokens=False)
        full_enc = self.tokenizer(full_text, max_length=self.max_length,
                                  truncation=True, add_special_tokens=False)

        input_ids = full_enc["input_ids"]
        if self.tokenizer.eos_token_id is not None:
            input_ids = input_ids + [self.tokenizer.eos_token_id]

        prompt_len = len(prompt_enc["input_ids"])

        # 构造 labels（只对回答部分计算 log probability）
        labels = [-100] * prompt_len + input_ids[prompt_len:]

        pad_length = self.max_length - len(input_ids)
        if pad_length > 0:
            input_ids = input_ids + [self.tokenizer.pad_token_id or 0] * pad_length
            labels = labels + [-100] * pad_length
        else:
            input_ids = input_ids[:self.max_length]
            labels = labels[:self.max_length]

        attention_mask = [1 if i < (self.max_length - max(pad_length, 0)) else 0
                          for i in range(self.max_length)]

        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention_mask, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }

    def __getitem__(self, idx):
        item = self.data[idx]

        # 编码 chosen（好回答）和 rejected（差回答）
        chosen = self._encode_pair(item["prompt"], item["chosen"])
        rejected = self._encode_pair(item["prompt"], item["rejected"])

        return {
            "chosen_input_ids": chosen["input_ids"],
            "chosen_attention_mask": chosen["attention_mask"],
            "chosen_labels": chosen["labels"],
            "rejected_input_ids": rejected["input_ids"],
            "rejected_attention_mask": rejected["attention_mask"],
            "rejected_labels": rejected["labels"],
        }


# ======================================================================
#  DPO 损失函数
# ======================================================================
def compute_log_probs(model, input_ids, attention_mask, labels):
    """
    计算模型对指定 token 序列的 log probability。

    这是 DPO 的核心计算。对于每个位置，模型输出一个概率分布，
    我们取真实 token 对应的 log 概率，然后求和。

    数学表达：
        log π(y|x) = Σ_{t} log P(y_t | y_{<t}, x)

    只对 labels != -100 的位置（即回答部分）计算。
    """
    # 前向传播：获取每个位置的 logits
    outputs = model(input_ids=input_ids, attention_mask=attention_mask)
    logits = outputs.logits  # [batch, seq_len, vocab_size]

    # 对齐 logits 和 labels
    # logits[:, :-1] 预测的是 labels[:, 1:] 的 token
    # （因为语言模型是预测"下一个 token"）
    shift_logits = logits[:, :-1, :]   # [batch, seq_len-1, vocab_size]
    shift_labels = labels[:, 1:]       # [batch, seq_len-1]

    # 计算每个位置的 log probability
    log_probs = F.log_softmax(shift_logits, dim=-1)  # [batch, seq_len-1, vocab_size]

    # 取出真实 token 对应的 log probability
    # gather: 从 vocab_size 维度中取出 shift_labels 指定的值
    per_token_log_probs = log_probs.gather(
        dim=-1,
        index=shift_labels.unsqueeze(-1).clamp(min=0),  # clamp 处理 -100
    ).squeeze(-1)  # [batch, seq_len-1]

    # 创建掩码：只对回答部分（labels != -100）求和
    mask = (shift_labels != -100).float()

    # 求和得到整个回答的 log probability
    # log π(y|x) = Σ log P(y_t | y_{<t}, x)
    total_log_prob = (per_token_log_probs * mask).sum(dim=-1)  # [batch]

    return total_log_prob


def dpo_loss(policy_chosen_logps, policy_rejected_logps,
             ref_chosen_logps, ref_rejected_logps, beta):
    """
    计算 DPO 损失。

    公式：
        L = -log σ(β × (log π(y_w|x)/π_ref(y_w|x) - log π(y_l|x)/π_ref(y_l|x)))

    等价于：
        L = -log σ(β × ((log π(y_w|x) - log π_ref(y_w|x))
                       - (log π(y_l|x) - log π_ref(y_l|x))))

    直觉理解：
        - log π(y_w|x) - log π_ref(y_w|x)：chosen 相对于参考模型的 "隐式奖励"
        - log π(y_l|x) - log π_ref(y_l|x)：rejected 相对于参考模型的 "隐式奖励"
        - 我们希望 chosen 的隐式奖励 > rejected 的隐式奖励
        - 通过 sigmoid + log 把这个差异转化为损失

    Args:
        policy_chosen_logps:   当前模型对 chosen 的 log prob
        policy_rejected_logps: 当前模型对 rejected 的 log prob
        ref_chosen_logps:      参考模型对 chosen 的 log prob
        ref_rejected_logps:    参考模型对 rejected 的 log prob
        beta:                  温度参数

    Returns:
        loss: 标量损失
        chosen_rewards: chosen 的隐式奖励（用于监控）
        rejected_rewards: rejected 的隐式奖励（用于监控）
    """
    # 计算隐式奖励
    chosen_rewards = beta * (policy_chosen_logps - ref_chosen_logps)
    rejected_rewards = beta * (policy_rejected_logps - ref_rejected_logps)

    # DPO 损失 = -log σ(chosen_reward - rejected_reward)
    # 直觉：chosen 的奖励越高于 rejected，损失越小
    loss = -F.logsigmoid(chosen_rewards - rejected_rewards).mean()

    return loss, chosen_rewards.detach(), rejected_rewards.detach()


# ======================================================================
#  训练函数
# ======================================================================
def train():
    print("=" * 60)
    print("  DPO（直接偏好优化）训练开始")
    print("=" * 60)

    # ---- 1. 加载模型 ----
    # DPO 需要两个模型：
    #   policy_model: 正在训练的模型
    #   ref_model:    参考模型（冻结，用于计算 KL 约束）
    print(f"\n[步骤1] 加载模型: {CONFIG['model_name']}")
    tokenizer = AutoTokenizer.from_pretrained(CONFIG["model_name"])

    # 策略模型（要训练的）
    policy_model = AutoModelForCausalLM.from_pretrained(CONFIG["model_name"])
    # 参考模型（冻结，不训练）
    ref_model = AutoModelForCausalLM.from_pretrained(CONFIG["model_name"])

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        policy_model.config.pad_token_id = tokenizer.eos_token_id
        ref_model.config.pad_token_id = tokenizer.eos_token_id

    # 冻结参考模型（不需要梯度）
    for param in ref_model.parameters():
        param.requires_grad = False
    ref_model.eval()

    total_params = sum(p.numel() for p in policy_model.parameters())
    print(f"  模型参数量: {total_params:,}")
    print(f"  β (KL 约束强度): {CONFIG['beta']}")

    # ---- 2. 准备数据 ----
    print(f"\n[步骤2] 加载偏好数据集")
    dataset = DPODataset(CONFIG["data_path"], tokenizer, CONFIG["max_length"])
    dataloader = DataLoader(dataset, batch_size=CONFIG["batch_size"], shuffle=True)

    # ---- 3. 优化器 ----
    optimizer = torch.optim.AdamW(
        policy_model.parameters(),
        lr=CONFIG["learning_rate"],
    )

    # ---- 4. 训练循环 ----
    print(f"\n[步骤3] 开始训练")
    total_steps = len(dataloader) * CONFIG["num_epochs"]
    print(f"  Total Steps: {total_steps}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device: {device}")
    policy_model.to(device)
    ref_model.to(device)
    policy_model.train()

    global_step = 0
    for epoch in range(CONFIG["num_epochs"]):
        epoch_loss = 0.0
        for batch_idx, batch in enumerate(dataloader):
            # 把所有数据移到设备上
            chosen_ids = batch["chosen_input_ids"].to(device)
            chosen_mask = batch["chosen_attention_mask"].to(device)
            chosen_labels = batch["chosen_labels"].to(device)
            rejected_ids = batch["rejected_input_ids"].to(device)
            rejected_mask = batch["rejected_attention_mask"].to(device)
            rejected_labels = batch["rejected_labels"].to(device)

            # ---- 计算策略模型的 log probs ----
            policy_chosen_logps = compute_log_probs(
                policy_model, chosen_ids, chosen_mask, chosen_labels)
            policy_rejected_logps = compute_log_probs(
                policy_model, rejected_ids, rejected_mask, rejected_labels)

            # ---- 计算参考模型的 log probs（不需要梯度）----
            with torch.no_grad():
                ref_chosen_logps = compute_log_probs(
                    ref_model, chosen_ids, chosen_mask, chosen_labels)
                ref_rejected_logps = compute_log_probs(
                    ref_model, rejected_ids, rejected_mask, rejected_labels)

            # ---- 计算 DPO 损失 ----
            loss, chosen_rewards, rejected_rewards = dpo_loss(
                policy_chosen_logps, policy_rejected_logps,
                ref_chosen_logps, ref_rejected_logps,
                beta=CONFIG["beta"],
            )

            # ---- 反向传播 ----
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(policy_model.parameters(), max_norm=1.0)
            optimizer.step()

            epoch_loss += loss.item()
            global_step += 1

            if global_step % CONFIG["log_every"] == 0:
                # 监控关键指标
                reward_margin = (chosen_rewards - rejected_rewards).mean().item()
                print(f"  [Epoch {epoch+1}] Step {global_step}/{total_steps} | "
                      f"Loss: {loss.item():.4f} | "
                      f"Reward Margin: {reward_margin:.4f}")
                # Reward Margin > 0 说明模型学到了偏好
                # （chosen 的隐式奖励高于 rejected）

        avg_loss = epoch_loss / len(dataloader)
        print(f"  >>> Epoch {epoch+1} 完成 | 平均 Loss: {avg_loss:.4f}")

    # ---- 5. 保存模型 ----
    print(f"\n[步骤4] 保存模型到 {CONFIG['output_dir']}")
    os.makedirs(CONFIG["output_dir"], exist_ok=True)
    policy_model.save_pretrained(CONFIG["output_dir"])
    tokenizer.save_pretrained(CONFIG["output_dir"])

    # ---- 6. 测试 ----
    print(f"\n[步骤5] 测试生成效果")
    policy_model.eval()
    test_prompt = "### 指令：\n什么是深度学习？\n\n### 回答：\n"
    inputs = tokenizer(test_prompt, return_tensors="pt").to(device)

    with torch.no_grad():
        outputs = policy_model.generate(
            **inputs,
            max_new_tokens=100,
            temperature=0.7,
            do_sample=True,
            top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
        )

    generated = tokenizer.decode(outputs[0], skip_special_tokens=True)
    print(f"  输入: {test_prompt.strip()}")
    print(f"  生成: {generated[len(test_prompt):]}")

    print("\n" + "=" * 60)
    print("  DPO 训练完成！")
    print("  关键观察：Reward Margin 是否为正？")
    print("  （正值表示模型学会了区分好回答和差回答）")
    print("=" * 60)


if __name__ == "__main__":
    train()
