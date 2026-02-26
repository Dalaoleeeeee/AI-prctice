"""
==========================================================================
LoRA 微调训练脚本（使用 HuggingFace PEFT 库）
==========================================================================
这个脚本演示了如何使用 PEFT（Parameter-Efficient Fine-Tuning）库
对预训练模型进行 LoRA 微调。

和 01_sft 的全量微调相比：
    - 全量微调：更新模型的全部参数（124M for GPT-2）
    - LoRA 微调：冻结原始参数，只训练 LoRA 适配器（约 0.5M）

使用方法：
    source venv/bin/activate
    python 02_lora/train_lora.py

依赖：
    pip install torch transformers peft datasets accelerate
==========================================================================
"""

import json
import os
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModelForCausalLM, get_linear_schedule_with_warmup
from peft import LoraConfig, get_peft_model, TaskType

# ======================================================================
#  配置参数
# ======================================================================
CONFIG = {
    # --- 模型配置 ---
    "model_name": "gpt2",

    # --- LoRA 配置 ---
    "lora_rank": 8,            # 秩（越大越强但参数越多）
    "lora_alpha": 16,          # 缩放因子（通常设为 2 × rank）
    "lora_dropout": 0.05,      # LoRA 层的 Dropout 概率
    # 要添加 LoRA 的模块名称
    # GPT-2 的 attention 层名称是 c_attn（包含了 Q/K/V 三个投影）
    # 对于 LLaMA/Qwen，用 ["q_proj", "v_proj", "k_proj", "o_proj"]
    "lora_target_modules": ["c_attn"],

    # --- 数据配置 ---
    "data_path": "02_lora/data/lora_data.jsonl",
    "max_length": 256,

    # --- 训练配置 ---
    "num_epochs": 3,
    "batch_size": 2,
    "learning_rate": 1e-4,     # LoRA 可以用更大的学习率（因为参数少）
    "warmup_steps": 5,

    # --- 输出配置 ---
    "output_dir": "02_lora/output",
    "log_every": 5,
}


# ======================================================================
#  数据集类（和 SFT 相同的格式）
# ======================================================================
class InstructionDataset(Dataset):
    """指令微调数据集，和 01_sft 中的 SFTDataset 完全一样。"""

    def __init__(self, data_path, tokenizer, max_length=256):
        self.tokenizer = tokenizer
        self.max_length = max_length
        self.data = []

        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    self.data.append(json.loads(line))

        print(f"[数据集] 加载了 {len(self.data)} 条训练样本")

    def __len__(self):
        return len(self.data)

    def __getitem__(self, idx):
        item = self.data[idx]

        prompt = f"### 指令：\n{item['instruction']}\n\n### 回答：\n"
        full_text = prompt + item["output"]

        prompt_enc = self.tokenizer(prompt, add_special_tokens=False)
        full_enc = self.tokenizer(full_text, max_length=self.max_length,
                                  truncation=True, add_special_tokens=False)

        input_ids = full_enc["input_ids"]
        if self.tokenizer.eos_token_id is not None:
            input_ids = input_ids + [self.tokenizer.eos_token_id]

        prompt_len = len(prompt_enc["input_ids"])
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


# ======================================================================
#  训练函数
# ======================================================================
def train():
    print("=" * 60)
    print("  LoRA 微调训练开始")
    print("=" * 60)

    # ---- 1. 加载基座模型 ----
    print(f"\n[步骤1] 加载基座模型: {CONFIG['model_name']}")
    tokenizer = AutoTokenizer.from_pretrained(CONFIG["model_name"])
    model = AutoModelForCausalLM.from_pretrained(CONFIG["model_name"])

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id

    total_params = sum(p.numel() for p in model.parameters())
    print(f"  基座模型参数量: {total_params:,}")

    # ---- 2. 添加 LoRA 适配器 ----
    # 这是 LoRA 和全量 SFT 的关键区别
    print(f"\n[步骤2] 添加 LoRA 适配器")
    print(f"  rank = {CONFIG['lora_rank']}")
    print(f"  alpha = {CONFIG['lora_alpha']}")
    print(f"  target_modules = {CONFIG['lora_target_modules']}")

    # LoraConfig 定义了 LoRA 的超参数
    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,    # 任务类型：因果语言模型
        r=CONFIG["lora_rank"],            # 秩
        lora_alpha=CONFIG["lora_alpha"],  # 缩放因子
        lora_dropout=CONFIG["lora_dropout"],
        target_modules=CONFIG["lora_target_modules"],  # 要添加 LoRA 的模块
        # bias="none" 表示不训练偏置参数
        # LoRA 论文发现训练偏置带来的提升可以忽略不计
        bias="none",
    )

    # get_peft_model 做了两件事：
    # 1. 冻结原始模型的所有参数
    # 2. 在 target_modules 指定的层旁边插入 LoRA 旁路
    model = get_peft_model(model, lora_config)

    # 打印参数统计
    model.print_trainable_parameters()
    # 输出类似：trainable params: 294,912 || all params: 124,734,720 || trainable%: 0.2364%

    # ---- 3. 准备数据 ----
    print(f"\n[步骤3] 加载数据集")
    dataset = InstructionDataset(CONFIG["data_path"], tokenizer, CONFIG["max_length"])
    dataloader = DataLoader(dataset, batch_size=CONFIG["batch_size"], shuffle=True)

    # ---- 4. 优化器 ----
    # 注意：只需要优化 LoRA 参数（通过 requires_grad 过滤）
    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=CONFIG["learning_rate"],
    )

    total_steps = len(dataloader) * CONFIG["num_epochs"]
    scheduler = get_linear_schedule_with_warmup(
        optimizer,
        num_warmup_steps=CONFIG["warmup_steps"],
        num_training_steps=total_steps,
    )

    # ---- 5. 训练循环 ----
    print(f"\n[步骤4] 开始训练")
    print(f"  Epochs: {CONFIG['num_epochs']}")
    print(f"  Total Steps: {total_steps}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device: {device}")
    model.to(device)
    model.train()

    global_step = 0
    for epoch in range(CONFIG["num_epochs"]):
        epoch_loss = 0.0
        for batch_idx, batch in enumerate(dataloader):
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)

            # 前向传播（和全量 SFT 一模一样，PEFT 自动处理 LoRA 旁路）
            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                labels=labels,
            )
            loss = outputs.loss

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()

            epoch_loss += loss.item()
            global_step += 1

            if global_step % CONFIG["log_every"] == 0:
                avg_loss = epoch_loss / (batch_idx + 1)
                print(f"  [Epoch {epoch+1}/{CONFIG['num_epochs']}] "
                      f"Step {global_step}/{total_steps} | Loss: {avg_loss:.4f}")

        avg_epoch_loss = epoch_loss / len(dataloader)
        print(f"  >>> Epoch {epoch+1} 完成 | 平均 Loss: {avg_epoch_loss:.4f}")

    # ---- 6. 保存 LoRA 权重 ----
    # 注意：只保存 LoRA 适配器权重，不保存完整模型
    # LoRA 权重通常只有几 MB（而完整模型可能几十 GB）
    print(f"\n[步骤5] 保存 LoRA 适配器到 {CONFIG['output_dir']}")
    os.makedirs(CONFIG["output_dir"], exist_ok=True)
    model.save_pretrained(CONFIG["output_dir"])
    tokenizer.save_pretrained(CONFIG["output_dir"])

    # 查看保存的文件大小
    for f in os.listdir(CONFIG["output_dir"]):
        fpath = os.path.join(CONFIG["output_dir"], f)
        if os.path.isfile(fpath):
            size = os.path.getsize(fpath)
            print(f"  {f}: {size:,} bytes")

    # ---- 7. 测试生成 ----
    print(f"\n[步骤6] 测试生成效果")
    model.eval()
    test_prompt = "### 指令：\n什么是 Transformer？\n\n### 回答：\n"
    inputs = tokenizer(test_prompt, return_tensors="pt").to(device)

    with torch.no_grad():
        outputs = model.generate(
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
    print("  LoRA 微调完成！")
    print("  对比全量 SFT（01_sft），注意训练参数量的巨大差异。")
    print("=" * 60)


if __name__ == "__main__":
    train()
