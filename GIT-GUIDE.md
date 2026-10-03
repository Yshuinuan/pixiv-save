# 如何把项目传到 GitHub

从零开始：装 Git → 第一次提交 → 推到 GitHub。

---

## 第 0 步：先决定仓库放哪

推荐把项目放在一个**普通目录**，例如：

```
D:\Projects\pixiv-save\
```

**不建议直接放在 `D:\存图`**，原因是这个目录的权限（ACL）有异常，Git 和部分命令行工具在那里可能报错。如果你的图库就在 `D:\存图`，用另一个目录放代码更省心。

下面所有命令都以 `D:\Projects\pixiv-save` 为例，路径换成你自己的即可。

---

## 第 1 步：安装 Git

### 方式 A：官网下载（推荐）

打开 <https://git-scm.com/download/win>，下载 64 位安装包，一路「下一步」即可。

安装选项里如果有 **"Git Bash Here"** 和 **"Add Git to PATH"**，保持默认勾选。

### 方式 B：winget 一条命令

在 PowerShell 里执行：

```powershell
winget install --id Git.Git -e --source winget
```

### 验证

**关闭并重新打开** PowerShell（让 PATH 生效），然后：

```powershell
git --version
```

看到 `git version 2.x.x` 就成功了。

---

## 第 2 步：配置身份

Git 需要知道每次提交是谁做的。**只需配置一次**（`--global` 表示对这台机器上所有仓库生效）：

```powershell
git config --global user.name "你的名字或ID"
git config --global user.email "你的邮箱"
```

邮箱建议用你注册 GitHub 的那个，这样提交能正确关联到你的账号。

顺手设置换行符处理和默认分支名（Windows 上很关键）：

```powershell
git config --global core.autocrlf true
git config --global init.defaultBranch main
```

检查配置：

```powershell
git config --global --list
```

---

## 第 3 步：把项目文件放好

在你的项目目录里，应该有这样这些文件：

```
pixiv-save\
├─ pixiv-save.user.js     主脚本
├─ selftest-novel.js      离线自检
├─ README.md
├─ DISCLAIMER.md
├─ LICENSE
└─ .gitignore
```

把之前生成的这几个文件复制进去。

> `.gitignore` 是隐藏文件（以点开头），在资源管理器里需要开启「显示隐藏的项目」才能看到，**但它必须存在**——它决定了哪些文件不会被提交。

---

## 第 4 步：初始化仓库并提交

在项目目录里打开 PowerShell（在文件夹空白处 `Shift + 右键` → 「在此处打开 PowerShell 窗口」），然后依次执行：

```powershell
# 1. 初始化仓库
git init

# 2. 查看当前状态（会列出待提交文件）
git status

# 3. 把所有文件加入暂存区
git add .

# 4. 提交
git commit -m "初始提交：Pixiv 存图用户脚本"
```

### 检查有没有误提交

**这一步很重要**，确认 `.gitignore` 生效了：

```powershell
git ls-files
```

输出的应该是你那几个源码/文档文件。如果看到 `.jpg` `.png` 或临时文件，说明 `.gitignore` 没生效，先别急着 push，检查一下文件名拼写。

### 如果 `git commit` 报错说需要身份

回去做第 2 步。

---

## 第 5 步：在 GitHub 上建仓库

1. 登录 <https://github.com>
2. 右上角 **`+`** → **New repository**
3. 填写：
   - **Repository name**：`pixiv-save`（或你喜欢的名字）
   - **Description**（可选）：`Pixiv 插画原图 / 小说一键保存到指定文件夹的油猴脚本`
   - **Public / Private**：想分享选 Public，自己用选 Private
4. **重要：下面的 "Initialize this repository with" 三个选项全部不要勾**
   （不要勾 README、不要勾 .gitignore、不要勾 license——你本地已经有了，勾了会导致冲突）
5. 点 **Create repository**

创建后会看到一个空仓库页面，上面有命令提示。**先别关，下一步要用到里面的网址。**

---

## 第 6 步：关联远程仓库并推送

### 认证方式一：HTTPS + Personal Access Token（较简单）

先告诉 Git 你的远程地址（把 `你的用户名` 换成 GitHub 用户名）：

```powershell
git remote add origin https://github.com/你的用户名/pixiv-save.git
git branch -M main
git push -u origin main
```

执行 `push` 时会**弹出浏览器窗口要求登录 GitHub**（新版 Git 用的是 Git Credential Manager）。点授权即可，之后就不用再登录了。

如果它要求你输入**用户名和密码**：

- 用户名：你的 GitHub 用户名
- 密码：**不能填账号密码**，必须填 **Personal Access Token**

生成 Token 的步骤：

1. GitHub 右上角头像 → **Settings**
2. 左侧最下 → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)**
4. **Generate new token (classic)**
5. Note 随便填，Expiration 选 90 days 或 No expiration
6. 勾选权限：至少勾 **`repo`**
7. 点 **Generate token**，**立刻复制**（离开页面就再也看不到了）
8. 回到 PowerShell，把它当作密码粘贴进去

### 认证方式二：SSH 密钥（一次配置，长期省事）

```powershell
# 1. 生成密钥（一路回车即可，邮箱换成你的）
ssh-keygen -t ed25519 -C "你的邮箱"

# 2. 查看公钥并复制全部内容
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

然后：

1. GitHub 头像 → **Settings** → **SSH and GPG keys**
2. **New SSH key** → Title 随便填 → Key 粘贴上一步的内容 → **Add SSH key**
3. 测试：

```powershell
ssh -T git@github.com
```

看到 `Hi 你的用户名! You've successfully authenticated` 就成功了（提示 `does not provide shell access` 是正常的）。

4. 用 SSH 地址推送：

```powershell
git remote add origin git@github.com:你的用户名/pixiv-save.git
git branch -M main
git push -u origin main
```

---

## 第 7 步：验证

刷新 GitHub 上的仓库页面，应该能看到你的文件，README 会自动渲染显示在下方。

---

## 日常更新流程

以后每次改了代码，三步走：

```powershell
git status                          # 看看改了什么
git add .                           # 暂存全部改动
git commit -m "说明这次改了什么"      # 提交
git push                            # 推送到 GitHub
```

只提交某个文件：

```powershell
git add pixiv-save.user.js
git commit -m "修复章节缩进丢失的问题"
git push
```

查看历史：

```powershell
git log --oneline
```

---

## 不想用命令行？用 GitHub Desktop

如果命令行让你头疼，装 [GitHub Desktop](https://desktop.github.com/)：

1. 安装后用 GitHub 账号登录
2. **File → Add local repository** → 选你的项目目录
3. 左下角填一句提交说明 → 点 **Commit to main**
4. 右上角点 **Publish repository**（首次）或 **Push origin**（之后）

图形界面做的事和上面命令行完全一样，只是不用记命令。

---

## 常见问题

**`git push` 报 `failed to push some refs`**

远程仓库里有你本地没有的提交（通常是建仓库时勾了 README）。解决：

```powershell
git pull --rebase origin main
git push
```

**`git push` 报 `repository not found`**

远程地址写错了，或仓库名不对。检查：

```powershell
git remote -v
```

改地址：

```powershell
git remote set-url origin https://github.com/正确用户名/正确仓库名.git
```

**提交里出现了不该有的文件**

如果**还没 push**：

```powershell
git rm --cached 文件名
# 把它加进 .gitignore，然后
git commit --amend
```

如果**已经 push** 了，文件已经进入历史，需要 `git filter-repo` 之类的工具清理，比较麻烦。**所以第一次 push 前一定要用 `git ls-files` 检查。**

**中文文件名显示成乱码**

```powershell
git config --global core.quotepath false
```

---

## 可选：让别人一键安装并在每次更新时自动升级

用户脚本有个 GitHub 专属的便利——**Tampermonkey 支持从 raw 链接安装并自动检查更新**。

在 `pixiv-save.user.js` 顶部的元数据块里加两行：

```javascript
// @updateURL    https://raw.githubusercontent.com/你的用户名/pixiv-save/main/pixiv-save.user.js
// @downloadURL  https://raw.githubusercontent.com/你的用户名/pixiv-save/main/pixiv-save.user.js
```

加上之后，你每次 `git push` 新版本（记得同时改 `@version`），所有装了脚本的人 Tampermonkey 会自动提示更新。

README 里的安装说明也可以改成一句：

> 点这里安装：[安装 Pixiv 存图](https://raw.githubusercontent.com/你的用户名/pixiv-save/main/pixiv-save.user.js)

这才是油猴脚本在 GitHub 上最标准的分发方式。
