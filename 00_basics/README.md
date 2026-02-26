# 00 - 基础知识：注意力机制与分词器

> 这是学习大模型的第一步，理解 Transformer 的核心组件。

## 本章内容

| 文件 | 说明 |
|---|---|
| `attention.py` | Scaled Dot-Product Attention 和 Multi-Head Attention 的 PyTorch 实现 |
| `tokenizer.py` | 使用 OpenAI tiktoken 库演示 GPT-2 分词过程 |

## 前置知识

- Python 基础
- PyTorch 张量操作（`torch.matmul`, `view`, `transpose`）
- 线性代数基础（矩阵乘法、点积、转置）

## 运行方式

```bash
# 激活虚拟环境
source venv/bin/activate

# 运行注意力机制演示（含自测断言）
python 00_basics/attention.py

# 运行分词器演示
python 00_basics/tokenizer.py
```

## 核心概念

### 注意力机制（Attention）

注意力机制的本质是一种**加权求和**：对于序列中的每个位置，计算它和其他所有位置的相关程度（注意力权重），然后用这些权重对 Value 向量加权求和。

```
Attention(Q, K, V) = softmax(QK^T / √d_k) × V
```

### Multi-Head Attention

多头注意力把输入拆分成多个"头"，每个头独立计算注意力，最后拼接起来。这让模型能从不同的"视角"理解输入序列。

### 分词（Tokenization）

大模型不直接处理文本字符串，而是把文本切分成 **token**（子词单元），每个 token 对应一个整数 ID。分词器定义了这个映射关系。

## 学完本章后

你应该能回答：
1. 为什么要除以 √d_k？（防止 softmax 饱和）
2. Multi-Head Attention 相比单头有什么优势？（多个子空间、并行计算）
3. 为什么需要分词？模型能直接处理文本吗？（不能，模型只处理数字）
