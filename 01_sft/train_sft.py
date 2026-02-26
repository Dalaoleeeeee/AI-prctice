"""
==========================================================================
SFT（监督微调）训练脚本
==========================================================================
这个脚本演示了如何对预训练语言模型进行监督微调（Supervised Fine-Tuning）。

SFT 的核心思想：
    预训练模型学会了"语言能力"（理解和生成文本），
    但还不会"听从指令"。SFT 用指令-回答数据对训练模型，
    让它学会根据用户的指令生成有用的回答。

SFT 的本质：
    损失函数和预训练一模一样 —— 都是 Next Token Prediction（交叉熵损失）。
    唯一的区别在于数据格式：
    - 预训练数据："今天天气很好适合出门散步..."（纯文本续写）
    - SFT 数据：  "[指令] 请解释机器学习 [回答] 机器学习是..."（指令-回答对）

使用方法：
    source venv/bin/activate
    python 01_sft/train_sft.py

依赖：
    pip install torch transformers datasets
==========================================================================
"""

import json
import os
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModelForCausalLM, get_linear_schedule_with_warmup

# ======================================================================
#  配置参数
# ======================================================================
CONFIG = {
    # --- 模型配置 ---
    # 默认使用 GPT-2（124M 参数），任何环境都能跑
    # Mac M3 Pro 18GB 用户可以换成 "Qwen/Qwen2.5-0.5B"
    "model_name": "gpt2",

    # --- 数据配置 ---
    "data_path": "01_sft/data/sft_data.jsonl",
    "max_length": 256,      # 最大序列长度（token 数）

    # --- 训练配置 ---
    "num_epochs": 3,        # 训练轮数（微调通常 1-3 个 epoch 就够了）
    "batch_size": 2,        # 批大小（显存不够就减小到 1）
    "learning_rate": 2e-5,  # 学习率（微调用较小的学习率，防止遗忘预训练知识）
    "warmup_steps": 10,     # 预热步数（前几步用较小学习率，逐渐增大到目标值）
    "weight_decay": 0.01,   # 权重衰减（L2 正则化，防止过拟合）

    # --- 输出配置 ---
    "output_dir": "01_sft/output",
    "log_every": 5,         # 每隔多少步打印一次日志
}


# ======================================================================
#  数据集类
# ======================================================================
class SFTDataset(Dataset):
    """
    SFT 数据集：将 instruction + output 拼接成模型可以训练的格式。

    数据格式转换过程：
        原始数据：
            {"instruction": "什么是AI？", "output": "AI是人工智能的缩写..."}

        拼接为文本：
            "### 指令：\n什么是AI？\n\n### 回答：\nAI是人工智能的缩写...<|endoftext|>"

        编码为 token IDs：
            [21017, 233, 30266, ..., 50256]

        生成 labels（用于计算损失）：
            [-100, -100, ..., -100, 15836, 230, ...]
            ↑ 指令部分不计算损失      ↑ 只对回答部分计算损失

    为什么 labels 中指令部分是 -100？
        因为 PyTorch 的 CrossEntropyLoss 会忽略 label=-100 的位置。
        我们不希望模型学会"复述用户的问题"，只需要它学会"生成好的回答"。
    """

    def __init__(self, data_path, tokenizer, max_length=256):
        self.tokenizer = tokenizer
        self.max_length = max_length
        self.data = []

        # 读取 JSONL 格式的数据文件
        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    self.data.append(json.loads(line))

        print(f"[数据集] 加载了 {len(self.data)} 条训练样本")

    def __len__(self):
        return len(self.data)

    def __getitem__(self, idx):
        item = self.data[idx]

        # ---- 第一步：构造提示模板 ----
        # 这个模板定义了模型的"对话格式"
        # 不同模型用不同模板，如 ChatML、Alpaca 等
        instruction = item["instruction"]
        output = item["output"]

        # 指令部分（不计算损失的部分）
        prompt = f"### 指令：\n{instruction}\n\n### 回答：\n"
        # 完整文本 = 指令 + 回答
        full_text = prompt + output

        # ---- 第二步：编码为 token IDs ----
        # tokenizer 把文本转换成模型能理解的数字序列
        prompt_encoding = self.tokenizer(
            prompt,
            add_special_tokens=False,
        )
        full_encoding = self.tokenizer(
            full_text,
            max_length=self.max_length,
            truncation=True,
            add_special_tokens=False,
        )

        input_ids = full_encoding["input_ids"]

        # 添加结束符 (EOS token)，告诉模型"回答到此结束"
        if self.tokenizer.eos_token_id is not None:
            input_ids = input_ids + [self.tokenizer.eos_token_id]

        # ---- 第三步：构造 labels ----
        # labels 和 input_ids 形状相同，但指令部分被设为 -100
        prompt_len = len(prompt_encoding["input_ids"])
        labels = [-100] * prompt_len + input_ids[prompt_len:]

        # ---- 第四步：填充到统一长度 ----
        # DataLoader 需要同一 batch 内的所有样本长度相同
        pad_length = self.max_length - len(input_ids)
        if pad_length > 0:
            input_ids = input_ids + [self.tokenizer.pad_token_id or 0] * pad_length
            labels = labels + [-100] * pad_length  # 填充部分也不计算损失
        else:
            input_ids = input_ids[:self.max_length]
            labels = labels[:self.max_length]

        # attention_mask: 1 表示有效 token，0 表示填充
        attention_mask = [1 if i < (self.max_length - max(pad_length, 0)) else 0
                          for i in range(self.max_length)]

        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention_mask, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }


# ======================================================================
#  训练函数
# ======================================================================
def train():
    """
    SFT 训练的完整流程：
    1. 加载预训练模型和分词器
    2. 准备数据集
    3. 定义优化器和学习率调度器
    4. 训练循环：前向传播 → 计算损失 → 反向传播 → 更新参数
    5. 保存微调后的模型
    """
    print("=" * 60)
    print("  SFT（监督微调）训练开始")
    print("=" * 60)

    # ---- 1. 加载模型和分词器 ----
    print(f"\n[步骤1] 加载模型: {CONFIG['model_name']}")
    tokenizer = AutoTokenizer.from_pretrained(CONFIG["model_name"])
    model = AutoModelForCausalLM.from_pretrained(CONFIG["model_name"])

    # GPT-2 没有 pad_token，需要手动设置
    # 使用 eos_token 作为 pad_token 是常见做法
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id

    # 打印模型参数量
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"  总参数量: {total_params:,}")
    print(f"  可训练参数量: {trainable_params:,}")

    # ---- 2. 准备数据集 ----
    print(f"\n[步骤2] 加载数据集: {CONFIG['data_path']}")
    dataset = SFTDataset(CONFIG["data_path"], tokenizer, CONFIG["max_length"])
    dataloader = DataLoader(dataset, batch_size=CONFIG["batch_size"], shuffle=True)

    # ---- 3. 定义优化器和学习率调度器 ----
    # AdamW 是 Adam 的改进版本，修正了权重衰减的实现方式
    # 在大模型训练中，AdamW 是最常用的优化器
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=CONFIG["learning_rate"],
        weight_decay=CONFIG["weight_decay"],
    )

    # 线性学习率调度：warmup → 线性衰减
    # warmup 阶段让学习率从 0 逐步增大到目标值，防止训练初期的大梯度
    total_steps = len(dataloader) * CONFIG["num_epochs"]
    scheduler = get_linear_schedule_with_warmup(
        optimizer,
        num_warmup_steps=CONFIG["warmup_steps"],
        num_training_steps=total_steps,
    )

    # ---- 4. 训练循环 ----
    print(f"\n[步骤3] 开始训练")
    print(f"  Epochs: {CONFIG['num_epochs']}")
    print(f"  Batch Size: {CONFIG['batch_size']}")
    print(f"  Total Steps: {total_steps}")
    print(f"  Learning Rate: {CONFIG['learning_rate']}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device: {device}")
    model.to(device)
    model.train()  # 切换到训练模式（启用 Dropout 等）

    global_step = 0
    for epoch in range(CONFIG["num_epochs"]):
        epoch_loss = 0.0
        for batch_idx, batch in enumerate(dataloader):
            # 把数据移到对应设备（CPU 或 GPU）
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)

            # ---- 前向传播 ----
            # 模型接收 input_ids 和 labels，内部自动：
            # 1. 通过 Transformer 层计算每个位置的 logits
            # 2. 用 logits 和 labels 计算交叉熵损失
            # 注意：labels 中 -100 的位置会被自动忽略
            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                labels=labels,
            )
            loss = outputs.loss  # 这就是交叉熵损失

            # ---- 反向传播 ----
            # 计算损失对每个参数的梯度
            loss.backward()

            # ---- 梯度裁剪 ----
            # 防止梯度爆炸：如果梯度的总范数超过 1.0，就等比例缩小
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)

            # ---- 更新参数 ----
            optimizer.step()       # 用梯度更新模型参数
            scheduler.step()       # 更新学习率
            optimizer.zero_grad()  # 清零梯度，为下一步做准备

            epoch_loss += loss.item()
            global_step += 1

            if global_step % CONFIG["log_every"] == 0:
                avg_loss = epoch_loss / (batch_idx + 1)
                lr = scheduler.get_last_lr()[0]
                print(f"  [Epoch {epoch+1}/{CONFIG['num_epochs']}] "
                      f"Step {global_step}/{total_steps} | "
                      f"Loss: {avg_loss:.4f} | LR: {lr:.2e}")

        avg_epoch_loss = epoch_loss / len(dataloader)
        print(f"  >>> Epoch {epoch+1} 完成 | 平均 Loss: {avg_epoch_loss:.4f}")

    # ---- 5. 保存模型 ----
    print(f"\n[步骤4] 保存模型到 {CONFIG['output_dir']}")
    os.makedirs(CONFIG["output_dir"], exist_ok=True)
    model.save_pretrained(CONFIG["output_dir"])
    tokenizer.save_pretrained(CONFIG["output_dir"])
    print("  模型和分词器已保存！")

    # ---- 6. 测试生成 ----
    print(f"\n[步骤5] 测试生成效果")
    model.eval()  # 切换到推理模式（关闭 Dropout）
    test_prompt = "### 指令：\n什么是深度学习？\n\n### 回答：\n"
    inputs = tokenizer(test_prompt, return_tensors="pt").to(device)

    with torch.no_grad():  # 推理时不需要计算梯度
        outputs = model.generate(
            **inputs,
            max_new_tokens=100,
            temperature=0.7,       # 温度：越低越确定，越高越随机
            do_sample=True,        # 采样生成（而不是贪心搜索）
            top_p=0.9,             # 核采样：只从概率最高的 90% token 中采样
            pad_token_id=tokenizer.eos_token_id,
        )

    generated = tokenizer.decode(outputs[0], skip_special_tokens=True)
    print(f"  输入: {test_prompt.strip()}")
    print(f"  生成: {generated[len(test_prompt):]}")

    print("\n" + "=" * 60)
    print("  SFT 训练完成！")
    print("=" * 60)


if __name__ == "__main__":
    train()
