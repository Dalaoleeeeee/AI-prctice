import torch
import torch.nn as nn
import torch.nn.functional as F
import math

class ScaledDotProductAttention(nn.Module):
    """
    缩放点积注意力机制 (Scaled Dot-Product Attention)
    公式: Attention(Q, K, V) = softmax(QK^T / sqrt(d_k))V
    """
    def __init__(self, dropout=0.1):
        super(ScaledDotProductAttention, self).__init__()
        self.dropout = nn.Dropout(dropout)

    def forward(self, query, key, value, mask=None):
        print(query.shape, key.shape, value.shape, mask.shape)
        
        """
        Args:
            query: [batch_size, num_heads, len_q, d_k]
            key:   [batch_size, num_heads, len_k, d_k]
            value: [batch_size, num_heads, len_v, d_v]
            mask:  [batch_size, 1, len_q, len_k] (可选)
        
        Returns:
            output: [batch_size, num_heads, len_q, d_v]
            attn:   [batch_size, num_heads, len_q, len_k]
        """
        # 获取每个头中向量的维度 d_k。
        # 假设我们有一个 batch，句子长度是 3 个词 (I, love, you)，d_model=512，分了 8 个头。
        # 那么每个头处理的向量维度 d_k = 512 / 8 = 64。
        # query 的形状可能是 [Batch=1, Heads=8, Len=3, Dim=64]
        # 这里取最后一维 64，用于后面的缩放。
        d_k = query.size(-1)
        
        # 1. 计算注意力分数: Q * K^T / sqrt(d_k)
        # -----------------------------------------------------------
        # 线性代数解释：
        # 我们要计算 Query (查询) 和 Key (键) 的相似度。最常用的方法是“点积”。
        # 两个向量越相似，点积越大。
        # 
        # 矩阵运算：
        # query: [..., len_q, d_k]  (例如: 1 x 8 x 3 x 64)
        # key:   [..., len_k, d_k]  (例如: 1 x 8 x 3 x 64)
        # 
        # 我们需要让 query 的每一行(词)去乘 key 的每一行(词)。
        # 为了符合矩阵乘法规则 (M x N) * (N x P)，我们需要把 key 转置。
        # key.transpose(-2, -1) 将最后两个维度互换。
        # key 转置后形状: [..., d_k, len_k] (例如: 1 x 8 x 64 x 3)
        # 
        # matmul (矩阵乘法) 结果:
        # [..., len_q, d_k] * [..., d_k, len_k] -> [..., len_q, len_k]
        # (1 x 8 x 3 x 64) * (1 x 8 x 64 x 3) -> (1 x 8 x 3 x 3)
        # 
        # 结果是一个 3x3 的矩阵 (针对每个头)，表示 3 个词两两之间的相似度分数。
        # 
        # 缩放 (Scaling) / math.sqrt(d_k):
        # 如果 d_k 很大 (比如 64)，点积结果方差变大，可能出现很大的值 (如 20, 50)。
        # 这会导致 Softmax 函数进入梯度极小的“饱和区”。
        # 除以 sqrt(64)=8，把数值拉回类似标准正态分布的范围，利于梯度传播。
        scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(d_k)
        
        # 2. 应用掩码 (Masking)
        if mask is not None:
            # mask 通常用于两个场景：
            # a) Padding Mask: 句子长短不一，补 0 的位置不能算注意力。
            # b) Sequence Mask (Decoder): 预测第 t 个词时，不能看 t 之后的词。
            # masked_fill: 把 mask 为 0 (需要遮挡) 的位置，分数设为 -1e9 (负无穷)。
            # 这样 Softmax(-1e9) ≈ 0，权重就没了。
            scores = scores.masked_fill(mask == 0, -1e9)
        
        # 3. Softmax 归一化
        # 将原始分数转化为概率分布（权重和为 1）。
        # dim=-1 表示对最后一个维度（Key 的维度）做归一化。
        # 例如对于单词 "I" (第1行)，它对 "I", "love", "you" 三个词的原始分数是 [2.0, 1.0, 0.5]
        # Softmax 后变成概率: [0.6, 0.25, 0.15]
        attn_weights = F.softmax(scores, dim=-1)
        
        # 4. Dropout
        # 随机丢弃一些注意力权重，防止过拟合。
        attn_weights = self.dropout(attn_weights)
        
        # 5. 加权求和: attn_weights * V
        # -----------------------------------------------------------
        # 线性代数解释：
        # 现在我们有了权重矩阵 attn_weights [..., len_q, len_k] (3x3)。
        # 还有内容矩阵 Value [..., len_v, d_v] (3x64)。
        # 矩阵乘法：权重矩阵 * Value矩阵
        # (3x3) * (3x64) -> (3x64)
        # 
        # 物理意义：
        # 对于每个查询词，根据算出来的概率权重，把 Value 里的对应信息加起来。
        # 比如 "I" 的新向量 = 0.6 * V("I") + 0.25 * V("love") + 0.15 * V("you")
        # 这样 "I" 就融合了上下文的信息。
        output = torch.matmul(attn_weights, value)
        
        return output, attn_weights

class MultiHeadAttention(nn.Module):
    """
    多头注意力机制 (Multi-Head Attention)
    """
    def __init__(self, d_model, num_heads, dropout=0.1):
        super(MultiHeadAttention, self).__init__()
        assert d_model % num_heads == 0, "d_model 必须能被 num_heads 整除"
        
        self.d_model = d_model
        self.num_heads = num_heads
        self.d_k = d_model // num_heads  # 每个头的维度
        
        # 定义 W_Q, W_K, W_V 线性变换矩阵
        self.w_q = nn.Linear(d_model, d_model)
        self.w_k = nn.Linear(d_model, d_model)
        self.w_v = nn.Linear(d_model, d_model)
        
        self.attention = ScaledDotProductAttention(dropout)
        
        # 最后的线性变换 W_O
        self.fc = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, query, key, value, mask=None):
        """
        Args:
            query: [batch_size, len_q, d_model]
            key:   [batch_size, len_k, d_model]
            value: [batch_size, len_v, d_model]
            mask:  [batch_size, 1, len_q, len_k] (可选)
        """
        batch_size = query.size(0)
        
        # 1. 线性投影并分头 (Linear Projections & Split Heads)
        # -----------------------------------------------------------
        # 为了让模型能从不同的角度（子空间）理解信息，我们把大向量切分成多个小向量。
        # 假设 d_model=512, num_heads=8, d_k=64。
        # 
        # a) self.w_q(query): 
        #    全连接层投影。输入 [Batch, Len, 512] -> 输出 [Batch, Len, 512]
        #    这相当于把原始特征映射到一个新的空间。
        #
        # b) .view(batch_size, -1, self.num_heads, self.d_k):
        #    重塑形状。把 512 拆成 8 x 64。
        #    [Batch, Len, 512] -> [Batch, Len, 8, 64]
        #
        # c) .transpose(1, 2):
        #    交换维度 1 和 2 (Len 和 Heads)。
        #    [Batch, Len, 8, 64] -> [Batch, 8, Len, 64]
        #    为什么要交换？
        #    因为我们要对每个 Head 独立计算注意力。
        #    PyTorch 的 matmul 是处理最后两个维度的，把 8 放到前面，
        #    就相当于把 Batch 和 Head 当作并行的“批次”来处理。
        q = self.w_q(query).view(batch_size, -1, self.num_heads, self.d_k).transpose(1, 2)
        k = self.w_k(key).view(batch_size, -1, self.num_heads, self.d_k).transpose(1, 2)
        v = self.w_v(value).view(batch_size, -1, self.num_heads, self.d_k).transpose(1, 2)
        
        # 2. 计算缩放点积注意力
        # 这里调用的就是上面详细注释过的 ScaledDotProductAttention。
        # 输入 q, k, v 的形状都是 [Batch, 8, Len, 64]。
        # 计算完后 x 的形状也是 [Batch, 8, Len, 64]。
        # attn 是注意力权重矩阵 [Batch, 8, Len, Len]。
        x, attn = self.attention(q, k, v, mask=mask)
        
        # 3. 拼接所有头 (Concat Heads)
        # -----------------------------------------------------------
        # 现在要把分散在 8 个头里的信息重新拼回去。
        # 
        # a) .transpose(1, 2):
        #    把维度换回来。
        #    [Batch, 8, Len, 64] -> [Batch, Len, 8, 64]
        #
        # b) .contiguous():
        #    由于 transpose 操作并未改变内存布局，只是改变了步长 (stride)，
        #    view 操作需要连续的内存，所以必须调用 contiguous() 重新拷贝内存。
        #
        # c) .view(batch_size, -1, self.d_model):
        #    拼接。把最后两个维度 8 和 64 合并回 512。
        #    [Batch, Len, 8, 64] -> [Batch, Len, 512]
        x = x.transpose(1, 2).contiguous().view(batch_size, -1, self.d_model)
        
        # 4. 最后的线性变换 (Final Linear)
        # 拼接后的向量 [Batch, Len, 512] 再经过一层全连接。
        # 这一步是为了混合不同头的信息，因为之前的注意力计算是各头独立的。
        x = self.fc(x)
        x = self.dropout(x)
        
        return x, attn

# 测试代码
if __name__ == "__main__":
    # 超参数
    BATCH_SIZE = 2
    SEQ_LEN = 10
    D_MODEL = 512
    NUM_HEADS = 8
    
    # 随机生成输入数据
    x = torch.randn(BATCH_SIZE, SEQ_LEN, D_MODEL)
    
    # 初始化多头注意力层
    mha = MultiHeadAttention(d_model=D_MODEL, num_heads=NUM_HEADS)
    
    # 前向传播 (Self-Attention: Q=K=V=x)
    output, attn_weights = mha(x, x, x)
    
    print(f"Input shape: {x.shape}")
    print(f"Output shape: {output.shape}")
    print(f"Attention weights shape: {attn_weights.shape}")
    
    assert output.shape == (BATCH_SIZE, SEQ_LEN, D_MODEL), "输出形状错误"
    print("测试通过！")

