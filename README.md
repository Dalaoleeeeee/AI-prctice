# AI Practice — 大模型后训练实战教程

> 从注意力机制到 GRPO，一步步掌握大模型的后训练技术。

## 学习路线图

```
00_basics          01_sft           02_lora          03_dpo           04_grpo
注意力机制     →    监督微调     →   LoRA微调     →  直接偏好优化  →  分组相对策略优化
(Attention)       (SFT)           (LoRA)          (DPO)           (GRPO)
 基础原理          全量微调         高效微调         对齐：偏好数据    对齐：可验证奖励
                                                                  (DeepSeek-R1 方法)
```

## 项目结构

| 目录 | 内容 | 关键文件 |
|---|---|---|
| `00_basics/` | 注意力机制、分词器 | `attention.py`, `tokenizer.py` |
| `01_sft/` | 监督微调 (Supervised Fine-Tuning) | `train_sft.py`, `data/sft_data.jsonl` |
| `02_lora/` | LoRA 低秩适应微调 | `lora_principle.py`, `train_lora.py` |
| `03_dpo/` | DPO 直接偏好优化 | `train_dpo.py`, `data/dpo_data.jsonl` |
| `04_grpo/` | GRPO 分组相对策略优化 | `train_grpo.py`, `data/grpo_math.jsonl` |

## 快速开始

### 环境安装

```bash
# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装所有依赖
pip install -r requirements.txt
```

### 按顺序学习

```bash
# 0. 基础：理解注意力机制
python 00_basics/attention.py
python 00_basics/tokenizer.py

# 1. SFT：全量监督微调
python 01_sft/train_sft.py

# 2. LoRA：先看原理，再跑训练
python 02_lora/lora_principle.py    # 从零实现 LoRA（强烈建议先看这个）
python 02_lora/train_lora.py        # 使用 PEFT 库的实战训练

# 3. DPO：直接偏好优化
python 03_dpo/train_dpo.py

# 4. GRPO：分组相对策略优化（DeepSeek-R1 方法）
python 04_grpo/train_grpo.py
```

## 环境要求

- Python 3.8+
- PyTorch 2.0+
- 8GB+ 内存（CPU 可运行所有脚本）

### 在 Mac M3 Pro 上使用更大的模型

所有脚本默认使用 GPT-2（124M 参数），可以在任何环境上运行。如果你有 Mac M3 Pro（18GB），可以在脚本中把 `model_name` 改为：

```python
CONFIG = {
    "model_name": "Qwen/Qwen2.5-0.5B",  # 5 亿参数，中文支持
    ...
}
```

## 数据集说明

所有数据集都在 `data/` 子目录中，已准备好可直接使用：

| 数据集 | 条数 | 格式 | 用途 |
|---|---|---|---|
| `01_sft/data/sft_data.jsonl` | 30 | instruction/output | SFT 指令微调 |
| `02_lora/data/lora_data.jsonl` | 15 | instruction/output | LoRA 微调 |
| `03_dpo/data/dpo_data.jsonl` | 15 | prompt/chosen/rejected | DPO 偏好优化 |
| `04_grpo/data/grpo_math.jsonl` | 25 | question/answer | GRPO 数学推理 |

## 技术栈全景

```
预训练 (Pre-training)         ← 你已经理解了
    ↓
监督微调 (SFT)               ← 01_sft: 让模型学会按指令回答
    ↓
参数高效微调 (LoRA)           ← 02_lora: 用 1% 参数达到接近全量效果
    ↓
偏好对齐 (DPO)               ← 03_dpo: 直接用偏好数据优化
    ↓
推理对齐 (GRPO)              ← 04_grpo: DeepSeek-R1 的训练方法
```

## 推荐的进阶项目

学完本教程后，推荐以下项目：

1. **[MiniMind](https://github.com/jingyaogong/minimind)** — 26M 参数的完整训练流程
2. **[LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory)** — 工业级微调框架
3. **[self-llm](https://github.com/datawhalechina/self-llm)** — 开源大模型食用指南
4. **[Unsloth](https://github.com/unslothai/unsloth)** — 高效 LoRA/GRPO 训练
