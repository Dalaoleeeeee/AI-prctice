# Git 常用命令指南（从 IDEA 图形界面到命令行）

对于习惯使用 IDEA Git 图形界面的开发者，这里是常用 Git 命令对照表。

## 📋 目录
1. [查看状态](#查看状态)
2. [提交代码](#提交代码)
3. [推送和拉取](#推送和拉取)
4. [分支操作](#分支操作)
5. [查看历史](#查看历史)
6. [撤销操作](#撤销操作)
7. [常用工作流](#常用工作流)

---

## 查看状态

### `git status`
**IDEA 对应**：底部 Git 窗口的 "Local Changes" 面板

查看工作区状态：哪些文件被修改、添加或删除。

```bash
git status
```

**示例输出**：
```
On branch main
Changes not staged for commit:
  modified:   attention.py
Untracked files:
  new_file.py
```

---

### `git diff`
**IDEA 对应**：双击文件查看差异（Diff View）

查看文件的详细改动。

```bash
# 查看所有改动
git diff

# 查看特定文件的改动
git diff attention.py

# 查看已暂存（Staged）的改动
git diff --staged
```

---

## 提交代码

### `git add`
**IDEA 对应**：右键文件 → "Git → Add to VCS" 或点击 "+" 号

将文件添加到暂存区（Staging Area）。

```bash
# 添加单个文件
git add attention.py

# 添加所有修改的文件（不包括删除的）
git add .

# 添加所有文件（包括删除的）
git add -A

# 交互式添加（可以部分添加文件的改动）
git add -p
```

---

### `git commit`
**IDEA 对应**：Commit 窗口，输入提交信息后点击 "Commit"

提交暂存区的改动。

```bash
# 提交并添加提交信息
git commit -m "修复了注意力机制的bug"

# 提交并自动添加所有已跟踪文件的改动（跳过 git add）
git commit -am "快速提交所有改动"

# 修改最后一次提交的信息
git commit --amend -m "新的提交信息"
```

---

### `git reset`
**IDEA 对应**：右键文件 → "Git → Rollback" 或 "Unstage"

撤销暂存区的文件（但保留工作区的修改）。

```bash
# 取消暂存所有文件（但保留修改）
git reset

# 取消暂存特定文件
git reset attention.py

# 完全撤销最后一次提交（保留文件修改）
git reset --soft HEAD~1

# 完全撤销最后一次提交（丢弃文件修改）⚠️ 危险操作
git reset --hard HEAD~1
```

---

## 推送和拉取

### `git pull`
**IDEA 对应**：点击 "Update Project" 或 "Pull"

从远程仓库拉取最新代码并合并。

```bash
# 拉取当前分支
git pull

# 拉取指定分支
git pull origin main

# 拉取但不自动合并（只获取，不合并）
git fetch
git merge origin/main
```

---

### `git push`
**IDEA 对应**：点击 "Push" 按钮

将本地提交推送到远程仓库。

```bash
# 推送到远程仓库（首次需要设置上游分支）
git push -u origin main

# 之后可以直接推送
git push

# 强制推送（覆盖远程历史）⚠️ 危险操作
git push --force
```

---

## 分支操作

### `git branch`
**IDEA 对应**：右下角分支切换器

查看、创建、删除分支。

```bash
# 查看所有本地分支（* 表示当前分支）
git branch

# 查看所有分支（包括远程）
git branch -a

# 创建新分支
git branch feature/new-feature

# 删除分支
git branch -d feature/old-feature

# 强制删除分支（即使未合并）⚠️
git branch -D feature/old-feature
```

---

### `git checkout`
**IDEA 对应**：右下角分支切换器 → 选择分支

切换分支。

```bash
# 切换到分支
git checkout main

# 创建并切换到新分支
git checkout -b feature/new-feature

# 切换到之前的分支
git checkout -
```

---

### `git switch`（Git 2.23+ 新命令，推荐）
**IDEA 对应**：同 checkout，但更语义化

切换分支（新语法，更清晰）。

```bash
# 切换到分支
git switch main

# 创建并切换到新分支
git switch -c feature/new-feature
```

---

### `git merge`
**IDEA 对应**：右键分支 → "Merge into Current"

合并分支到当前分支。

```bash
# 切换到目标分支
git checkout main

# 合并 feature 分支到 main
git merge feature/new-feature
```

---

## 查看历史

### `git log`
**IDEA 对应**：Git → Show History

查看提交历史。

```bash
# 查看提交历史
git log

# 简洁版（一行显示）
git log --oneline

# 图形化显示分支
git log --oneline --graph --all

# 查看特定文件的提交历史
git log attention.py

# 查看最近 5 次提交
git log -5
```

---

### `git show`
**IDEA 对应**：在提交历史中点击某个提交查看详情

查看某次提交的详细信息。

```bash
# 查看最后一次提交
git show

# 查看特定提交
git show abc1234
```

---

## 撤销操作

### 撤销工作区的修改
**IDEA 对应**：右键文件 → "Git → Rollback"

```bash
# 撤销单个文件的修改（恢复到上次提交的状态）
git checkout -- attention.py

# 撤销所有未暂存的修改 ⚠️ 危险操作
git checkout .
```

---

### `git restore`（Git 2.23+ 新命令，推荐）
**IDEA 对应**：同 checkout --，但更语义化

```bash
# 撤销工作区的修改
git restore attention.py

# 撤销暂存区的文件（取消 add）
git restore --staged attention.py
```

---

## 常用工作流

### 场景 1：日常开发（修改代码 → 提交 → 推送）

```bash
# 1. 查看状态
git status

# 2. 添加修改的文件
git add attention.py tokenizer.py

# 3. 提交
git commit -m "添加了新的功能"

# 4. 推送
git push
```

---

### 场景 2：从远程拉取最新代码

```bash
# 1. 拉取最新代码
git pull

# 如果出现冲突，解决后：
git add .
git commit -m "解决合并冲突"
git push
```

---

### 场景 3：创建新功能分支

```bash
# 1. 确保在主分支并拉取最新代码
git checkout main
git pull

# 2. 创建并切换到新分支
git checkout -b feature/new-feature

# 3. 开发、提交...
git add .
git commit -m "实现新功能"
git push -u origin feature/new-feature

# 4. 完成后合并回主分支
git checkout main
git merge feature/new-feature
git push
```

---

### 场景 4：查看谁改了什么（Blame）

**IDEA 对应**：右键文件 → "Git → Annotate with Git Blame"

```bash
# 查看文件每一行的作者和提交信息
git blame attention.py
```

---

### 场景 5：暂存当前工作（临时切换分支）

**IDEA 对应**：Git → Stash Changes

```bash
# 暂存当前所有修改
git stash

# 查看暂存列表
git stash list

# 恢复暂存
git stash pop

# 应用暂存但不删除
git stash apply
```

---

## 🔑 重要提示

1. **`git status` 是好朋友**：不确定状态时，先运行 `git status`
2. **提交前先拉取**：`git pull` 避免冲突
3. **提交信息要清晰**：好的提交信息有助于理解代码历史
4. **小心 `--force` 和 `--hard`**：这些操作可能丢失数据
5. **分支命名规范**：`feature/xxx`、`bugfix/xxx`、`hotfix/xxx`

---

## 🆚 IDEA vs 命令行的快速对照

| IDEA 操作 | Git 命令 |
|----------|---------|
| 查看改动 | `git status` / `git diff` |
| 添加到暂存区 | `git add <file>` |
| 提交 | `git commit -m "message"` |
| 推送 | `git push` |
| 拉取 | `git pull` |
| 切换分支 | `git checkout <branch>` 或 `git switch <branch>` |
| 查看历史 | `git log` |
| 撤销修改 | `git restore <file>` 或 `git checkout -- <file>` |
| 合并分支 | `git merge <branch>` |
| 暂存修改 | `git stash` |

---

## 💡 额外技巧

### 配置 Git 别名（简化命令）

```bash
# 添加到 ~/.gitconfig
git config --global alias.st status
git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.ci commit

# 使用
git st    # 等同于 git status
git co main    # 等同于 git checkout main
```

### 查看配置

```bash
# 查看所有配置
git config --list

# 查看用户名和邮箱
git config user.name
git config user.email

# 设置用户名和邮箱
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```
