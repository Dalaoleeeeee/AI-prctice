# AI Practice

这是一个 AI 实践项目，包含注意力机制（Attention Mechanism）和 Tokenizer 的实现。

## 项目结构

- `attention.py` - PyTorch 实现的注意力机制（Scaled Dot-Product Attention 和 Multi-Head Attention）
- `tokenizer.py` - 使用 tiktoken 库的文本编码示例

## 环境要求

- Python 3.8+
- PyTorch 2.0+
- tiktoken

## 安装依赖

```bash
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install torch tiktoken
```

## 使用方法

### 运行注意力机制示例

```bash
python attention.py
```

### 运行 Tokenizer 示例

```bash
python tokenizer.py
```

## 说明

### Attention Mechanism

`attention.py` 实现了 Transformer 中使用的注意力机制：

- **ScaledDotProductAttention**: 缩放点积注意力，包含详细的数学原理解释和代码注释
- **MultiHeadAttention**: 多头注意力机制，支持并行计算多个注意力头

代码中包含详细的注释，解释了每一步的线性代数原理和实际例子。

### Tokenizer

`tokenizer.py` 演示了如何使用 tiktoken 库对文本进行编码，包括处理特殊 token 的方法。
