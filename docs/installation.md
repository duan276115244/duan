# 安装指南

## 系统要求

| 项目 | 最低要求 | 推荐 |
|---|---|---|
| Node.js | >= 18.0.0 | >= 20.0.0 |
| 操作系统 | Windows 10+ / macOS 12+ / Linux | Windows 11 / macOS 14+ |
| 内存 | 4 GB | 16 GB |
| 磁盘 | 2 GB | 10 GB (含模型缓存) |
| 网络 | 可访问 AI API | 宽带连接 |

## 安装方式

### 方式一：从源码安装（推荐）

```bash
# 1. 克隆或进入项目目录
cd D:\good\jws

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入至少一个 API Key

# 4. 编译 TypeScript
npm run build

# 5. 启动
npm run dev          # CLI 模式
# 或
npm run dev:desktop  # Electron 桌面模式
# 或
npm run dev:web      # Web 服务模式
```

### 方式二：使用预编译版本

从发布页面下载 `duan.exe` (Windows) 或对应平台的可执行文件：

```bash
# Windows: 直接双击 duan.exe
# 或者命令行运行:
duan.exe
```

### 方式三：Docker 部署

```bash
# 构建镜像
docker build -t duan-agent .

# 运行容器
docker run -d \
  --name duan-agent \
  -p 3001:3001 \
  -v ~/.duan:/root/.duan \
  -e DEEPSEEK_API_KEY=your_key_here \
  duan-agent
```

## 首次配置

### 交互式向导

```bash
npm run dev
```

首次运行会自动进入配置向导：
1. 选择 AI 模型提供商（DeepSeek / OpenAI / Anthropic / 等）
2. 输入 API Key
3. 配置消息通道（可选）
4. 完成初始化

### 手动配置

编辑 `~/.duan/config.json`：

```json
{
  "version": "2.0",
  "activeProfile": "default",
  "profiles": {
    "default": {
      "provider": "deepseek",
      "apiKey": "enc:AES-256-GCM-encrypted-key",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com"
    }
  },
  "preferences": {
    "theme": "dark",
    "language": "zh-CN",
    "autoApprove": ["read", "list"]
  }
}
```

API Key 会被自动加密存储（AES-256-GCM），密钥基于机器特征派生。

## 验证安装

```bash
# 检查版本
npx tsx src/duan-v15.0.ts --version

# 启动后输入 /status 查看系统状态
# 输入 /channels 查看通道状态
# 输入 /help 获取帮助
```

## 常见问题

### 启动报错 "Cannot find module"

```bash
# 重新安装依赖
rm -rf node_modules && npm install
```

### Puppeteer 浏览器启动失败

```bash
# 手动下载 Chrome
npx puppeteer browsers install chrome
```

### Windows 上 shell_execute 报 ENOENT

已在 v15.0 中修复。确保 `C:\Windows\System32\cmd.exe` 存在。
如果使用 Git Bash / WSL，在 `~/.duan/config.json` 中配置 shell 路径。
