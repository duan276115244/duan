# 📖 段先生 v19.0 — 跨机器安装指南

> 在新的电脑 / 服务器上安装并运行段先生 v19.0 的完整步骤。
> 适用：Windows 10/11, macOS 12+, Ubuntu/Debian, Linux 任意发行版

---

## 目录
1. [系统要求](#1-系统要求)
2. [准备工作：获取源代码](#2-准备工作获取源代码)
3. [Windows 安装](#3-windows-安装)
4. [macOS 安装](#4-macos-安装)
5. [Linux 安装](#5-linux-安装)
6. [配置与启动](#6-配置与启动)
7. [验证安装](#7-验证安装)
8. [常见问题与故障排除](#8-常见问题与故障排除)

---

## 1. 系统要求

| 项目 | 最低要求 | 推荐配置 |
|---|---|---|
| **操作系统** | Windows 10 / macOS 12 / Ubuntu 20.04 | Windows 11 / macOS 14 / Ubuntu 22.04+ |
| **Node.js** | ≥ 18.0.0 | **20.x LTS**（稳定且兼容性最佳） |
| **npm** | 随 Node.js 自动安装 | 10.x 或更高 |
| **磁盘空间** | ≥ 2 GB（依赖 + 日志 + 缓存） | 5 GB+ |
| **内存** | ≥ 4 GB | 8 GB+ |
| **网络** | 可访问 GitHub / 模型供应商 API | 稳定 10Mbps+ |
| **CPU** | 双核 | 四核 2GHz+ |

### 1.1 检查当前环境

```bash
# 打开 PowerShell (Windows) 或 Terminal (macOS/Linux)，运行：
node --version    # 应输出 v18.x.x 或更高
npm --version     # 应输出 10.x 或更高

# 如果没有安装，跳转到对应 OS 的安装章节
```

---

## 2. 准备工作：获取源代码

### 方式 A：使用加密备份包恢复（推荐，无需联网下载）

如果您已将 `backup/duan-source-v19-xxxx.enc.zip` 复制到新机器：

```bash
# 1. 创建工作目录
mkdir C:\duan-agent && cd C:\duan-agent   # Windows
# mkdir ~/duan-agent && cd ~/duan-agent    # macOS/Linux

# 2. 将脚本和加密包放入目录
#    从 U 盘/网盘复制以下文件：
#    - scripts/backup-source.cjs
#    - backup/duan-source-v19-xxxx.enc.zip

# 3. 解密恢复（约 1-3 分钟）
node scripts/backup-source.cjs --restore backup/duan-source-v19-xxxx.enc.zip --password "DuanV19-Secure-Backup-2026"

# 4. 将恢复内容移到工作目录根
Copy-Item backup\restored-*\* . -Recurse -Force  # PowerShell
# cp -r backup/restored-*/. .                      # macOS/Linux
```

详细解密说明：[DECRYPTION.md](DECRYPTION.md)

### 方式 B：从 GitHub 克隆（如有仓库地址）

```bash
# 替换为您的实际 GitHub 用户名和仓库名
git clone https://github.com/YOUR_USERNAME/duan-agent.git
cd duan-agent

# 切换到 v19.0 版本（如有 tag）
git checkout v19.0.0
```

---

## 3. Windows 安装

### 3.1 安装 Node.js

1. 访问 https://nodejs.org/en/download
2. 下载 **Windows Installer (.msi)** 的 **LTS** 版本（20.x）
3. 双击安装，全部使用默认选项
4. 重启 **PowerShell**（重要：旧窗口不识别新命令）
5. 验证安装：
   ```powershell
   node --version     # 输出 v20.x.x
   npm --version      # 输出 10.x.x
   ```

### 3.2 安装 Git（可选，仅当使用 git clone 方式时需要）

1. 访问 https://git-scm.com/download/win
2. 下载安装，使用默认配置即可

### 3.3 安装依赖

```powershell
# 进入项目目录
cd C:\duan-agent

# 安装依赖（首次运行较慢，2-5 分钟）
npm install

# 输出最后几行应包含：
#   audited xxx packages in xxxs
#   0 vulnerabilities
```

### 3.4 验证 npm 安装

```powershell
# 如遇到 "EPERM: operation not permitted" —— 以管理员身份重新打开 PowerShell
# 如遇到 npm 下载缓慢 —— 切换为国内镜像
npm config set registry https://registry.npmmirror.com
npm install     # 再次安装
```

---

## 4. macOS 安装

### 4.1 安装 Node.js（Homebrew 方式，推荐）

```bash
# 1. 如未安装 Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. 安装 Node.js LTS
brew install node@20

# 3. 验证
node --version    # v20.x.x
npm --version     # 10.x.x
```

### 4.2 安装 Node.js（官方安装包方式）

1. 访问 https://nodejs.org/en/download
2. 下载 **macOS Installer (.pkg)**，安装
3. 打开新的 Terminal 窗口验证 `node --version`

### 4.3 安装项目依赖

```bash
cd ~/duan-agent
npm install
```

### 4.4 如遇到权限问题

```bash
# 修复 npm 全局权限（如报错 EACCES）
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /usr/local/lib/node_modules
```

---

## 5. Linux 安装

### 5.1 Ubuntu / Debian 系

```bash
# 使用 NodeSource 安装 Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node --version    # v20.x.x
npm --version     # 10.x.x

# 安装项目
cd ~/duan-agent
npm install
```

### 5.2 CentOS / RHEL 系

```bash
# 使用 NodeSource YUM 仓库
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

cd ~/duan-agent
npm install
```

### 5.3 Arch Linux

```bash
sudo pacman -S nodejs npm
cd ~/duan-agent
npm install
```

---

## 6. 配置与启动

### 6.1 创建环境变量配置文件

```bash
# Windows PowerShell
cd C:\duan-agent
copy .env.example .env

# macOS/Linux
cp .env.example .env
```

### 6.2 编辑 `.env`，填写至少一个模型 API Key

用文本编辑器（记事本 / VS Code / nano / vim）打开 `.env`，找到并填写：

```env
# ============ 🇨🇳 国内用户首选（性价比最高） ============
# 获取: https://platform.deepseek.com/api_keys
DEEPSEEK_API_KEY=sk-your-real-deepseek-key-here

# ============ 🌍 国际用户 ============
# 如使用 OpenAI:
# OPENAI_API_KEY=sk-your-openai-key

# ============ 默认模型（重要） ============
DEFAULT_MODEL=deepseek     # 或 openai / anthropic / ollama
```

> 🔐 **安全提示**：`.env` 已在 `.gitignore` 中排除，**绝不会**被提交到 Git。

### 6.3 三选一启动模式

#### 模式 1：CLI 终端模式（最简洁）

```bash
npm run dev
```

#### 模式 2：Web 控制台 + 移动端响应式（推荐新用户）

```bash
npm run dev:full
# 浏览器打开: http://localhost:3001
# 手机同一 Wi-Fi 下访问: http://[电脑IP]:3001
```

#### 模式 3：Electron 桌面端（需 electron 依赖）

```bash
# 1. 首次需要安装 electron（如 package.json 中已有则自动安装）
npm install

# 2. 启动
npm run dev:desktop
```

---

## 7. 验证安装

### 7.1 运行测试套件

```bash
# 运行所有测试
npm test

# 运行能力评估
node scripts/publish-github.cjs   # （不对，这是发布工具）

# 验证 Agent 功能
npm run dev
# 然后在终端输入："你好，用一句话介绍自己"
# 预期输出：Agent 返回自我介绍的文本
```

### 7.2 健康检查清单

| 检查项 | 命令 | 通过标准 |
|---|---|---|
| Node.js 版本 | `node --version` | ≥ v18.0.0 |
| npm 可运行 | `npm --version` | ≥ 10.x |
| 依赖已安装 | `ls node_modules/package.json` | 文件存在 |
| `.env` 已配置 | 检查 `DEEPSEEK_API_KEY` 不为空 | 以 `sk-` 开头 |
| 模型 API 可访问 | `curl https://api.deepseek.com`（或用浏览器）| 返回非错误响应 |
| Web 控制台可访问 | 打开 `http://localhost:3001` | 页面正常加载 |
| CLI 可交互 | 运行 `npm run dev` 并发送测试提问 | 返回响应文本 |

### 7.3 首次运行体验测试

1. ✅ 启动命令执行无报错
2. ✅ 发送简单消息（"你好"）得到回复
3. ✅ 代码辅助功能正常
4. ✅ 浏览器控制（如需）能打开网页
5. ✅ 退出正常（无数据丢失）

---

## 8. 常见问题与故障排除

### ❌ Q1：`npm install` 卡在 "idealTree" 或极慢

**原因**：网络访问 npm registry 受限

**解决**：切换到国内镜像
```bash
npm config set registry https://registry.npmmirror.com
rm -rf node_modules package-lock.json   # macOS/Linux
Remove-Item node_modules, package-lock.json -Recurse -Force  # PowerShell
npm install
```

### ❌ Q2："Error: Cannot find module 'express'" 或类似

**原因**：依赖未正确安装

**解决**：
```bash
rm -rf node_modules package-lock.json
npm install
npm install express    # 如仍缺失，手动安装特定包
```

### ❌ Q3：API Key 无效 / 401 认证失败

**原因**：`.env` 未正确填写或 Key 已过期

**解决**：
```bash
# 1. 检查 .env 是否存在
cat .env | grep DEEPSEEK   # Linux/macOS
# Select-String .env -Pattern DEEPSEEK  # PowerShell

# 2. 验证 API Key 有效性（使用 DeepSeek 示例）
curl -X POST https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-你的Key" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"say hi"}]}'
```

### ❌ Q4：端口 3001 被占用（`EADDRINUSE`）

**解决**：
```bash
# Windows PowerShell
netstat -ano | findstr :3001
taskkill /PID <进程ID> /F

# macOS/Linux
lsof -i :3001
kill -9 <PID>
```

### ❌ Q5：Electron 桌面端启动失败（Windows 权限）

**解决**：以管理员身份运行 PowerShell 后再执行 `npm run dev:desktop`

### ❌ Q6：从加密备份恢复后，node_modules 缺失

**原因**：备份排除了 `node_modules/`（约占 300MB，加密包会很大）

**解决**：恢复后需要重新安装依赖（这是正常流程）
```bash
cd D:\duan-agent
npm install    # 正常安装，会自动读取 package.json
```

### ❌ Q7：恢复的文件中文路径乱码

**原因**：跨平台传输时的编码问题（Windows GBK vs UTF-8）

**解决**：
- 推荐使用方法 A 的 `backup-source.cjs`（已内置 UTF-8 处理）
- 如手动拷贝，确保使用 `robocopy / UNICODE` 方式传文件

---

## 9. 下一步

安装并启动成功后：

1. 📖 阅读 [README.md](README.md) 了解系统架构
2. 🚀 阅读 [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md) 了解版本状态
3. 🧪 尝试示例任务（见 [docs/USAGE.md](docs/USAGE.md)）
4. 📝 将使用反馈（好的 / 不好的 / bug）通过 GitHub Issues 或邮件发给我们

---

## 10. 命令速查表

| 需求 | 命令 |
|---|---|
| 安装依赖 | `npm install` |
| CLI 模式启动 | `npm run dev` |
| Web 控制台 | `npm run dev:full` |
| Electron 桌面端 | `npm run dev:desktop` |
| 生产构建 | `npm run build` |
| 前端构建 | `npm run build:frontend` |
| 运行测试 | `npm test` |
| 类型检查 | `npm run typecheck` |
| 代码规范检查 | `npm run lint` |
| 完整验证 | `npm run verify:all` |
| 生成加密备份 | `node scripts/backup-source.cjs --password "你的口令"` |
| 解密恢复 | `node scripts/backup-source.cjs --restore file.enc.zip --password "你的口令"` |
| 核心代码加密 | `node scripts/encrypt-core.cjs encrypt-all --password "你的口令"` |

---

**文档版本**：v19.0-2026.07.07
**适用**：段先生 v19.0.x 所有版本
**问题反馈**：GitHub Issues / 内测群 / 邮件
