# 01 - SFT（监督微调）

> 监督微调是让基座模型变成对话模型的关键步骤。

## 什么是 SFT？

SFT（Supervised Fine-Tuning）是用人工标注的「指令-回答」数据对来微调预训练语言模型。

### 训练前 vs 训练后

| | 基座模型（预训练后） | SFT 模型（微调后） |
|---|---|---|
| 能力 | 续写文本（"今天天气" → "很好，适合出门"） | 按指令回答（"今天天气怎么样？" → "根据您的位置..."） |
| 训练数据 | 海量无标注文本 | 高质量指令-回答对 |
| 损失函数 | Next Token Prediction | Next Token Prediction（相同！） |

### 关键理解

SFT 的损失函数和预训练**完全一样**，都是预测下一个 token 的交叉熵损失。区别在于数据格式——SFT 数据是按照 `[指令] + [回答]` 格式组织的，而且通常只对回答部分计算损失。

## 数据格式

本项目使用 Alpaca 格式的指令数据：

```json
{
  "instruction": "请解释什么是机器学习。",
  "input": "",
  "output": "机器学习是人工智能的一个分支..."
}
```

- `instruction`：用户的问题或指令
- `input`：可选的额外输入（本数据集未使用）
- `output`：期望的回答

## 运行方式

```bash
source venv/bin/activate
python 01_sft/train_sft.py
```

### 可配置参数

在脚本顶部的 `CONFIG` 字典中修改：

```python
CONFIG = {
    "model_name": "gpt2",           # 模型名称，可换成 Qwen/Qwen2.5-0.5B
    "num_epochs": 3,                # 训练轮数
    "batch_size": 2,                # 批大小
    "learning_rate": 2e-5,          # 学习率
    "max_length": 256,              # 最大序列长度
}
```

## 在你的 Mac 上跑更大模型

```python
CONFIG = {
    "model_name": "Qwen/Qwen2.5-0.5B",  # 5亿参数，Mac M3 Pro 18GB 可跑
    "num_epochs": 1,
    "batch_size": 1,
    "learning_rate": 2e-5,
    "max_length": 256,
}
```

## 学完本章后

你应该能回答：
1. SFT 和预训练的损失函数有什么不同？（本质相同，都是交叉熵）
2. 为什么只对回答部分计算损失？（防止模型学到"复述问题"的行为）
3. SFT 数据质量为什么比数量更重要？（少量高质量数据 > 大量低质量数据）
