"""
==========================================================================
LoRA 原理演示：从零实现
==========================================================================
这个脚本用纯 PyTorch 从零实现 LoRA，帮助你理解它的数学原理。

LoRA 核心思想：
    微调时不更新原始权重 W，而是学习一个低秩的增量 ΔW = B × A
    其中 A ∈ R^{d×r}, B ∈ R^{r×d}，r << d

    前向传播：
        y = (W + ΔW) × x = W × x + B × A × x
        ↑原始输出         ↑LoRA 增量

使用方法：
    source venv/bin/activate
    python 02_lora/lora_principle.py

依赖：
    pip install torch
==========================================================================
"""

import torch
import torch.nn as nn


class LoRALinear(nn.Module):
    """
    给一个普通的 nn.Linear 层添加 LoRA 旁路。

    原始层：y = Wx + b
    LoRA 层：y = Wx + b + (B × A)x × (alpha/rank)

    可视化：
                    ┌─────────────┐
        x ──────────│  原始 Linear  │──────────── y_original
            │       │  (冻结不训练)  │                │
            │       └─────────────┘                │
            │                                      │ (+)
            │       ┌─────┐    ┌─────┐             │
            └───────│  A  │────│  B  │─── × scale ─┘
                    │ d→r │    │ r→d │         ↓
                    └─────┘    └─────┘      y_final
                    (降维)      (升维)
    """

    def __init__(self, original_linear: nn.Linear, rank: int = 8, alpha: float = 16.0):
        super().__init__()

        self.original_linear = original_linear
        self.rank = rank
        self.alpha = alpha

        # 获取原始线性层的维度
        in_features = original_linear.in_features   # 输入维度 d_in
        out_features = original_linear.out_features  # 输出维度 d_out

        # ---- 创建 LoRA 的 A 和 B 矩阵 ----
        # A: 降维矩阵 [d_in, rank]
        # 初始化为高斯随机值（kaiming 初始化）
        # 作用：把输入从 d_in 维压缩到 rank 维
        self.lora_A = nn.Parameter(torch.randn(in_features, rank) * 0.01)

        # B: 升维矩阵 [rank, d_out]
        # 初始化为全零（这是 LoRA 论文的关键设计）
        # 为什么初始化为 0？
        #   训练开始时 ΔW = B × A = 0 × A = 0
        #   这意味着 LoRA 层一开始不改变原始模型的输出
        #   模型从预训练权重的"起点"开始微调，而不是从随机状态开始
        self.lora_B = nn.Parameter(torch.zeros(rank, out_features))

        # 缩放因子
        # alpha/rank 控制 LoRA 更新的强度
        # 典型设置：alpha = 2 × rank，使得缩放因子 = 2.0
        self.scaling = alpha / rank

        # 冻结原始层的参数（不需要梯度）
        for param in self.original_linear.parameters():
            param.requires_grad = False

    def forward(self, x):
        """
        前向传播：
            y = W·x + b + (x·A)·B × scaling

        分步解释（假设 x 形状为 [batch, d_in]，d_in=512, rank=8, d_out=512）：
            1. original_output = W·x + b      → [batch, 512]  （原始输出，冻结不训练）
            2. lora_down = x @ A               → [batch, 8]    （降维：512→8）
            3. lora_up = lora_down @ B          → [batch, 512]  （升维：8→512）
            4. lora_output = lora_up * scaling  → [batch, 512]  （缩放）
            5. final = original + lora_output   → [batch, 512]  （相加）
        """
        # 原始层的输出（梯度不会传回原始权重，因为已经冻结）
        original_output = self.original_linear(x)

        # LoRA 旁路
        # x: [batch, d_in] → [batch, rank] → [batch, d_out]
        lora_output = (x @ self.lora_A) @ self.lora_B * self.scaling

        return original_output + lora_output


def count_params(model):
    """统计模型的总参数量和可训练参数量"""
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return total, trainable


def demo():
    """
    演示 LoRA 的工作原理和参数效率。
    """
    print("=" * 60)
    print("  LoRA 原理演示")
    print("=" * 60)

    # ---- 1. 创建一个简单的原始模型 ----
    # 假设这是一个 Transformer 中的某个线性层
    d_model = 512
    original_linear = nn.Linear(d_model, d_model)
    total, trainable = count_params(original_linear)
    print(f"\n[原始线性层]")
    print(f"  维度: {d_model} → {d_model}")
    print(f"  参数量: {total:,} (全部可训练)")

    # ---- 2. 添加 LoRA ----
    rank = 8
    alpha = 16.0
    lora_layer = LoRALinear(original_linear, rank=rank, alpha=alpha)
    total, trainable = count_params(lora_layer)
    print(f"\n[添加 LoRA 后]")
    print(f"  rank = {rank}, alpha = {alpha}, scaling = {alpha/rank}")
    print(f"  A 矩阵形状: [{d_model}, {rank}] = {d_model * rank:,} 参数")
    print(f"  B 矩阵形状: [{rank}, {d_model}] = {rank * d_model:,} 参数")
    print(f"  LoRA 总参数: {d_model * rank + rank * d_model:,}")
    print(f"  总参数量: {total:,}")
    print(f"  可训练参数量: {trainable:,} ({trainable/total*100:.2f}%)")

    # ---- 3. 验证初始状态下 LoRA 不改变输出 ----
    print(f"\n[验证] LoRA 初始化时不改变原始输出")
    x = torch.randn(2, d_model)

    with torch.no_grad():
        original_out = original_linear(x)
        lora_out = lora_layer(x)

    # 因为 B 初始化为 0，所以 LoRA 输出 = 原始输出
    diff = (original_out - lora_out).abs().max().item()
    print(f"  最大输出差异: {diff:.10f}")
    assert diff < 1e-6, "LoRA 初始输出应该和原始层相同！"
    print(f"  ✓ 验证通过：LoRA 初始化不改变模型行为")

    # ---- 4. 模拟训练过程 ----
    print(f"\n[模拟训练] 只更新 LoRA 参数")

    # 创建一个简单的回归目标
    target = torch.randn(2, d_model)
    criterion = nn.MSELoss()

    # 只有 LoRA 参数需要梯度
    optimizer = torch.optim.Adam(
        [p for p in lora_layer.parameters() if p.requires_grad],
        lr=0.01,
    )

    for step in range(50):
        output = lora_layer(x)
        loss = criterion(output, target)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        if (step + 1) % 10 == 0:
            print(f"  Step {step+1:3d} | Loss: {loss.item():.6f}")

    # 训练后，LoRA 输出应该和原始不同了
    with torch.no_grad():
        trained_out = lora_layer(x)
    diff_after = (original_out - trained_out).abs().max().item()
    print(f"\n  训练后最大输出差异: {diff_after:.4f}")
    print(f"  ✓ LoRA 已经学到了新的知识（输出发生了变化）")

    # ---- 5. 展示参数效率对比 ----
    print(f"\n{'='*60}")
    print(f"  参数效率对比（以典型 LLaMA-7B 为例）")
    print(f"{'='*60}")

    d = 4096  # LLaMA-7B 的隐藏维度
    num_layers = 32
    num_targets = 4  # q_proj, k_proj, v_proj, o_proj

    full_params = d * d * num_layers * num_targets
    for r in [4, 8, 16, 32, 64]:
        lora_params = (d * r + r * d) * num_layers * num_targets
        ratio = lora_params / full_params * 100
        print(f"  rank={r:2d}: LoRA 参数 {lora_params:>12,} / "
              f"全量参数 {full_params:>14,} = {ratio:.2f}%")

    print(f"\n{'='*60}")
    print(f"  LoRA 原理演示完成！")
    print(f"{'='*60}")


if __name__ == "__main__":
    demo()
