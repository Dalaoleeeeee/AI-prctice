"""
==========================================================================
GRPO（分组相对策略优化）训练脚本
==========================================================================
这个脚本从零实现 GRPO（Group Relative Policy Optimization）算法，
这是 DeepSeek-R1 训练推理模型的核心方法。

GRPO 的核心思想：
    1. 对同一个问题，让模型生成 G 个回答（一组）
    2. 用奖励函数（不是奖励模型！）给每个回答打分
    3. 计算组内的相对优势（advantage）：
       advantage_i = (reward_i - mean(rewards)) / std(rewards)
    4. 用优势加权的策略梯度更新模型

和 PPO 的关键区别：
    - PPO: 需要 4 个模型（策略、参考、奖励、价值）
    - GRPO: 只需要 2 个模型（策略、参考），用组内统计量替代价值模型

使用方法：
    source venv/bin/activate
    python 04_grpo/train_grpo.py

依赖：
    pip install torch transformers
==========================================================================
"""

import json
import re
import os
import torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

# ======================================================================
#  配置参数
# ======================================================================
CONFIG = {
    # --- 模型配置 ---
    "model_name": "gpt2",

    # --- GRPO 配置 ---
    "group_size": 4,           # G: 每个问题生成的回答数量
                                # 越大 → advantage 估计越准，但计算量越大
                                # DeepSeek-R1 用的 G=64，我们教学用 G=4
    "beta": 0.04,              # KL 约束强度
    "clip_epsilon": 0.2,       # PPO 风格的裁剪范围

    # --- 生成配置 ---
    "max_new_tokens": 80,      # 生成回答的最大 token 数
    "temperature": 0.8,        # 生成温度（高一些以增加多样性）

    # --- 数据配置 ---
    "data_path": "04_grpo/data/grpo_math.jsonl",
    "max_prompt_length": 64,

    # --- 训练配置 ---
    "num_epochs": 2,
    "learning_rate": 1e-6,     # GRPO 用极小的学习率

    # --- 输出配置 ---
    "output_dir": "04_grpo/output",
}


# ======================================================================
#  奖励函数
# ======================================================================
def extract_number(text):
    """
    从模型的回答中提取数字答案。

    尝试多种模式匹配：
    1. "答案是 42" / "答案为 42"
    2. "= 42"
    3. 最后出现的数字
    """
    # 模式1：匹配"答案是/为/：XX"
    patterns = [
        r"答案[是为：:]\s*(-?\d+\.?\d*)",
        r"[=＝]\s*(-?\d+\.?\d*)\s*$",
        r"结果[是为：:]\s*(-?\d+\.?\d*)",
        r"所以[是为：:]*\s*(-?\d+\.?\d*)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1)

    # 模式2：取最后一个数字
    numbers = re.findall(r'-?\d+\.?\d*', text)
    if numbers:
        return numbers[-1]

    return None


def reward_function(response, ground_truth):
    """
    奖励函数：评估模型回答的质量。

    这是 GRPO 最核心的设计——不使用训练出来的奖励模型，
    而是用规则/函数来判断回答的质量。

    对于数学任务，奖励设计：
        - 答案正确：+1.0（最重要的信号）
        - 包含推理过程：+0.2（鼓励 Chain-of-Thought）
        - 格式规范：+0.1（鼓励清晰表达）

    在 DeepSeek-R1 中，奖励函数主要就是"答案对不对"，
    但模型自己学会了用 <think>...</think> 来推理。
    """
    reward = 0.0

    # --- 核心奖励：答案正确性 ---
    predicted = extract_number(response)
    if predicted is not None and str(predicted).strip() == str(ground_truth).strip():
        reward += 1.0  # 答案正确，给最大奖励

    # --- 格式奖励：鼓励展示推理过程 ---
    reasoning_keywords = ["所以", "因此", "首先", "然后", "计算", "等于", "得到"]
    has_reasoning = any(kw in response for kw in reasoning_keywords)
    if has_reasoning:
        reward += 0.2

    # --- 长度惩罚：太短的回答可能没有推理 ---
    if len(response) < 5:
        reward -= 0.3

    return reward


# ======================================================================
#  GRPO 核心算法
# ======================================================================
def compute_sequence_log_probs(model, input_ids, attention_mask, response_start_idx):
    """
    计算模型对 response 部分的 log probability。

    和 DPO 中的 compute_log_probs 类似，但这里需要处理
    prompt + generated response 的拼接序列。
    """
    outputs = model(input_ids=input_ids, attention_mask=attention_mask)
    logits = outputs.logits

    # 只计算 response 部分的 log prob
    shift_logits = logits[:, :-1, :]
    shift_labels = input_ids[:, 1:]

    log_probs = F.log_softmax(shift_logits, dim=-1)
    per_token_log_probs = log_probs.gather(
        dim=-1,
        index=shift_labels.unsqueeze(-1)
    ).squeeze(-1)

    # 创建掩码：只计算 response 部分
    mask = torch.zeros_like(per_token_log_probs)
    for i in range(mask.size(0)):
        start = max(response_start_idx[i] - 1, 0)
        mask[i, start:] = 1.0

    # attention_mask 也要考虑
    mask = mask * attention_mask[:, 1:]

    total_log_prob = (per_token_log_probs * mask).sum(dim=-1)
    return total_log_prob


def grpo_step(policy_model, ref_model, tokenizer, questions, answers, config, device):
    """
    GRPO 的一个训练步骤。

    流程：
    1. 对每个问题，生成 group_size 个回答
    2. 用奖励函数给每个回答打分
    3. 计算组内相对优势（advantage）
    4. 用 advantage 加权的策略梯度更新模型

    数学公式（简化版）：
        advantage_i = (r_i - mean(r)) / (std(r) + ε)
        loss = -Σ advantage_i × log π(y_i | x)
             + β × KL(π || π_ref)
    """
    G = config["group_size"]
    all_losses = []
    all_rewards = []
    all_advantages = []

    for q_idx, (question, answer) in enumerate(zip(questions, answers)):
        # ---- Step 1: 格式化提示 ----
        prompt = f"问题：{question}\n请一步步思考并给出答案：\n"
        prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
        prompt_len = len(prompt_ids)

        # ---- Step 2: 生成一组回答 ----
        prompt_tensor = torch.tensor([prompt_ids]).to(device)
        attention_mask = torch.ones_like(prompt_tensor)

        group_input_ids = []
        group_attention_masks = []
        group_responses = []
        group_rewards = []

        policy_model.eval()
        with torch.no_grad():
            for g in range(G):
                outputs = policy_model.generate(
                    input_ids=prompt_tensor,
                    attention_mask=attention_mask,
                    max_new_tokens=config["max_new_tokens"],
                    temperature=config["temperature"],
                    do_sample=True,
                    top_p=0.95,
                    pad_token_id=tokenizer.eos_token_id,
                )

                generated_ids = outputs[0].tolist()
                response_text = tokenizer.decode(
                    generated_ids[prompt_len:], skip_special_tokens=True)
                group_responses.append(response_text)

                # 计算奖励
                r = reward_function(response_text, answer)
                group_rewards.append(r)

                # 填充到统一长度
                max_len = config["max_prompt_length"] + config["max_new_tokens"]
                padded = generated_ids[:max_len]
                pad_len = max_len - len(padded)
                attn = [1] * len(padded) + [0] * pad_len
                padded = padded + [tokenizer.eos_token_id or 0] * pad_len

                group_input_ids.append(padded)
                group_attention_masks.append(attn)

        rewards_tensor = torch.tensor(group_rewards, dtype=torch.float32)
        all_rewards.extend(group_rewards)

        # ---- Step 3: 计算组内相对优势（Advantage）----
        # 这是 GRPO 的核心创新：
        # 用组内的均值和标准差归一化奖励，替代价值模型
        #
        # advantage_i = (r_i - mean) / (std + ε)
        #
        # 直觉：
        #   - 如果某个回答的奖励高于平均 → advantage > 0 → 鼓励
        #   - 如果某个回答的奖励低于平均 → advantage < 0 → 惩罚
        #   - 如果所有回答奖励相同 → advantage ≈ 0 → 不更新
        mean_reward = rewards_tensor.mean()
        std_reward = rewards_tensor.std()

        if std_reward < 1e-8:
            advantages = torch.zeros_like(rewards_tensor)
        else:
            advantages = (rewards_tensor - mean_reward) / (std_reward + 1e-8)

        all_advantages.extend(advantages.tolist())

        # ---- Step 4: 计算策略梯度损失 ----
        policy_model.train()

        input_ids_batch = torch.tensor(group_input_ids, dtype=torch.long).to(device)
        attn_mask_batch = torch.tensor(group_attention_masks, dtype=torch.long).to(device)
        response_starts = [prompt_len] * G

        # 当前策略的 log probs
        policy_logps = compute_sequence_log_probs(
            policy_model, input_ids_batch, attn_mask_batch, response_starts)

        # 参考模型的 log probs（用于 KL 约束）
        with torch.no_grad():
            ref_logps = compute_sequence_log_probs(
                ref_model, input_ids_batch, attn_mask_batch, response_starts)

        # KL 散度：防止模型偏离参考模型太远
        kl = (ref_logps - policy_logps).mean()

        # GRPO 损失：
        # L = -Σ advantage_i × log π(y_i | x) + β × KL
        advantages_device = advantages.to(device)
        policy_loss = -(advantages_device * policy_logps).mean()
        total_loss = policy_loss + config["beta"] * kl

        all_losses.append(total_loss.item())

        # 打印这组的详情
        print(f"\n  [问题 {q_idx+1}] {question}")
        print(f"    标准答案: {answer}")
        for g in range(G):
            r_str = f"{group_rewards[g]:.1f}"
            a_str = f"{advantages[g]:.2f}"
            resp_preview = group_responses[g][:60].replace('\n', ' ')
            print(f"    回答{g+1}: reward={r_str}, adv={a_str} | {resp_preview}...")

        # 反向传播
        total_loss.backward()

    return sum(all_losses) / max(len(all_losses), 1), all_rewards


# ======================================================================
#  训练函数
# ======================================================================
def train():
    print("=" * 60)
    print("  GRPO（分组相对策略优化）训练开始")
    print("=" * 60)
    print("  这是 DeepSeek-R1 训练推理模型的核心算法！")

    # ---- 1. 加载模型 ----
    print(f"\n[步骤1] 加载模型: {CONFIG['model_name']}")
    tokenizer = AutoTokenizer.from_pretrained(CONFIG["model_name"])
    policy_model = AutoModelForCausalLM.from_pretrained(CONFIG["model_name"])
    ref_model = AutoModelForCausalLM.from_pretrained(CONFIG["model_name"])

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        policy_model.config.pad_token_id = tokenizer.eos_token_id
        ref_model.config.pad_token_id = tokenizer.eos_token_id

    for param in ref_model.parameters():
        param.requires_grad = False
    ref_model.eval()

    total_params = sum(p.numel() for p in policy_model.parameters())
    print(f"  模型参数量: {total_params:,}")
    print(f"  Group Size (G): {CONFIG['group_size']}")
    print(f"  β (KL 约束): {CONFIG['beta']}")

    # ---- 2. 加载数据 ----
    print(f"\n[步骤2] 加载数学题数据集")
    data = []
    with open(CONFIG["data_path"], "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                data.append(json.loads(line))
    print(f"  加载了 {len(data)} 道数学题")

    # 只用前几道题做演示（完整训练需要更多数据和更大模型）
    demo_data = data[:5]

    # ---- 3. 训练 ----
    print(f"\n[步骤3] 开始 GRPO 训练")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device: {device}")
    policy_model.to(device)
    ref_model.to(device)

    optimizer = torch.optim.AdamW(
        policy_model.parameters(),
        lr=CONFIG["learning_rate"],
    )

    for epoch in range(CONFIG["num_epochs"]):
        print(f"\n{'='*40} Epoch {epoch+1}/{CONFIG['num_epochs']} {'='*40}")
        epoch_rewards = []

        for item in demo_data:
            optimizer.zero_grad()

            avg_loss, rewards = grpo_step(
                policy_model, ref_model, tokenizer,
                [item["question"]], [item["answer"]],
                CONFIG, device,
            )

            torch.nn.utils.clip_grad_norm_(policy_model.parameters(), max_norm=1.0)
            optimizer.step()

            epoch_rewards.extend(rewards)

        avg_reward = sum(epoch_rewards) / len(epoch_rewards)
        correct_rate = sum(1 for r in epoch_rewards if r >= 1.0) / len(epoch_rewards)
        print(f"\n  >>> Epoch {epoch+1} 总结:")
        print(f"      平均奖励: {avg_reward:.3f}")
        print(f"      正确率: {correct_rate:.1%}")

    # ---- 4. 保存模型 ----
    print(f"\n[步骤4] 保存模型到 {CONFIG['output_dir']}")
    os.makedirs(CONFIG["output_dir"], exist_ok=True)
    policy_model.save_pretrained(CONFIG["output_dir"])
    tokenizer.save_pretrained(CONFIG["output_dir"])

    # ---- 5. 最终测试 ----
    print(f"\n[步骤5] 最终测试")
    policy_model.eval()
    test_questions = [
        ("计算: 15 + 27 = ?", "42"),
        ("小明有8个苹果，吃了3个，现在有几个？", "5"),
    ]

    for q, expected in test_questions:
        prompt = f"问题：{q}\n请一步步思考并给出答案：\n"
        inputs = tokenizer(prompt, return_tensors="pt").to(device)

        with torch.no_grad():
            outputs = policy_model.generate(
                **inputs,
                max_new_tokens=80,
                temperature=0.3,
                do_sample=True,
                pad_token_id=tokenizer.eos_token_id,
            )

        response = tokenizer.decode(outputs[0], skip_special_tokens=True)
        response = response[len(prompt):]
        predicted = extract_number(response)
        correct = "✓" if str(predicted) == expected else "✗"
        print(f"\n  {correct} 问题: {q}")
        print(f"    期望: {expected}")
        print(f"    模型: {response[:100]}")
        print(f"    提取: {predicted}")

    print("\n" + "=" * 60)
    print("  GRPO 训练完成！")
    print("  注意：GPT-2 是英文模型，中文数学推理效果有限。")
    print("  在 Qwen2.5-0.5B 等中文模型上效果会好得多。")
    print("  但代码逻辑是完整的——换个模型就能跑！")
    print("=" * 60)


if __name__ == "__main__":
    train()
