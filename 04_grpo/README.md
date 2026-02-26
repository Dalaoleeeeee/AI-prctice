# 04 - GRPO（分组相对策略优化）

> DeepSeek-R1 的秘密武器：用可验证的奖励函数训练推理模型。

## 什么是 GRPO？

GRPO（Group Relative Policy Optimization）是 DeepSeek 提出的强化学习方法，是目前训练推理模型（如 DeepSeek-R1）的核心技术。

### 和 PPO / DPO 的对比

| | PPO | DPO | GRPO |
|---|---|---|---|
| 需要奖励模型？ | ✅ | ❌ | ❌ |
| 需要价值模型？ | ✅ | ❌ | ❌ |
| 需要偏好数据？ | ✅ | ✅ | ❌ |
| 需要什么？ | 奖励模型+价值模型 | 偏好数据对 | **可验证的奖励函数** |
| 显存占用 | 4 个模型 | 2 个模型 | 1 个模型 |
| 典型应用 | ChatGPT | Llama 2 | DeepSeek-R1 |

### GRPO 的核心思想

```
对同一个问题 x：
    1. 让模型生成一组（group）回答：y1, y2, ..., yG
    2. 用奖励函数给每个回答打分：r1, r2, ..., rG
    3. 计算组内相对优势（advantage）：
       - 高于平均分的 → 正优势（鼓励）
       - 低于平均分的 → 负优势（惩罚）
    4. 用优势加权的策略梯度更新模型
```

关键创新：
- **不需要单独的奖励模型**：直接用规则/函数判断回答对不对
- **不需要价值模型**：用组内平均作为基线，省掉 critic
- **适合可验证任务**：数学题、代码题等有明确对错的任务

## 奖励函数设计

GRPO 最有趣的部分是设计奖励函数。对于数学推理：

```python
def reward_function(response, ground_truth):
    score = 0.0
    # 1. 答案正确性（最重要）
    if extract_answer(response) == ground_truth:
        score += 1.0
    # 2. 格式奖励（鼓励使用思维链）
    if "<think>" in response and "</think>" in response:
        score += 0.2
    return score
```

## 运行方式

```bash
source venv/bin/activate
python 04_grpo/train_grpo.py
```

## 数据格式

GRPO 不需要偏好数据，只需要问题和标准答案：

```json
{
  "question": "小明有5个苹果，吃了2个，又买了3个，现在有几个？",
  "answer": "6"
}
```

## 和 DeepSeek-R1 的关系

DeepSeek-R1 的训练流程：
1. 基座模型（DeepSeek-V3）
2. **GRPO 训练**（用数学/代码等可验证任务）→ 模型自动学会了 `<think>...</think>` 推理
3. SFT 蒸馏 + 拒绝采样

最惊人的发现：模型不需要被教如何推理——只要奖励函数给正确答案高分，模型就会自己发展出 Chain-of-Thought 推理能力！

## 学完本章后

你应该能回答：
1. GRPO 比 PPO 节省了什么？（奖励模型和价值模型）
2. 为什么 GRPO 特别适合数学/代码任务？（因为有明确的对错标准）
3. GRPO 中的 "Group" 是什么意思？（对同一问题生成一组回答）
4. DeepSeek-R1 是怎么学会推理的？（GRPO + 正确性奖励 → 自发产生 CoT）
