# 📖 段先生 v19.0 用户引导指南

> 本指南帮助内测用户在 15 分钟内完成段先生的安装、配置与首次任务体验。

---

## 阶段 1：环境准备（5 分钟）

### 1.1 系统要求
- **Node.js** ≥ 18.0.0（推荐 20.x LTS）
- **操作系统**：Windows 10+ / macOS 12+ / Linux（Ubuntu 20.04+）
- **磁盘空间**：≥ 500 MB（含依赖）
- **网络**：可访问至少一个模型供应商 API

### 1.2 获取模型 API Key（推荐三选一）

| 供应商 | 获取地址 | 特点 |
|---|---|---|
| 🇨🇳 DeepSeek | https://platform.deepseek.com/api_keys | 推荐首选，性价比最高 |
| 🌍 OpenAI | https://platform.openai.com/api-keys | GPT-4o 系列 |
| 🔗 OpenRouter | https://openrouter.ai/keys | 聚合 200+ 模型，一个 Key 通吃 |

> 💡 国内用户推荐 DeepSeek；想体验多模型推荐 OpenRouter。

### 1.3 安装

```bash
# 克隆仓库
git clone <repo-url> jws
cd jws

# 安装依赖
npm install
```

---

## 阶段 2：配置（3 分钟）

### 2.1 基础配置

```bash
# 复制环境配置模板
cp .env.example .env
```

编辑 `.env` 文件，至少填写以下内容：

```bash
# 必填：至少一个模型供应商
DEEPSEEK_API_KEY=sk-你的真实key

# 必填：默认模型
DEFAULT_MODEL=deepseek

# 建议开启：API 认证（Web/桌面端访问需提供）
AUTH_ENABLED=true
AUTH_API_KEYS=your-local-api-key-1
```

### 2.2（可选）配置消息通道

如需通过飞书/Discord 等通道使用段先生，编辑 `~/.duan/config.json`：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "botToken": "你的飞书机器人token",
      "dmPolicy": "open",
      "requireMention": false
    }
  }
}
```

> ⚠️ 飞书通道必须包含 `dmPolicy: "open"` 和 `requireMention: false`，否则收不到消息。

---

## 阶段 3：首次启动（2 分钟）

### 选择你的平台

```bash
# 方式 A：CLI 终端（最简单，推荐首次体验）
npm run dev

# 方式 B：Web 控制台（功能最全，移动端友好）
npm run dev:full
# 然后浏览器访问 http://localhost:3001

# 方式 C：Electron 桌面端（桌面自动化能力）
npm run dev:desktop
```

### 首次任务体验

启动后，尝试输入你的第一个任务：

```
你好，请介绍一下你自己，然后帮我搜索一下今天的天气
```

段先生会：
1. **规划** — 理解你的意图
2. **执行** — 调用搜索工具
3. **反思** — 总结结果
4. **学习** — 记录本次经验

---

## 阶段 4：进阶体验（5 分钟）

### 4.1 尝试多工具协同

```
帮我在 D:\work 目录下创建一个项目计划文档，包含三个部分：
1. 项目背景
2. 里程碑（用表格）
3. 风险清单
然后保存为 markdown 文件
```

### 4.2 体验桌面自动化（仅桌面端）

```
帮我打开微信，然后把窗口分屏到屏幕左侧
```

### 4.3 查看能力评估

```bash
npm run capability:report
```

这会展示段先生当前在 10 个维度上的能力评分。

---

## 常见问题

### Q1：启动报错 "API Key 无效"
- 检查 `.env` 中的 `DEEPSEEK_API_KEY` 是否填写正确
- 确认 `DEFAULT_MODEL` 与你提供的 Key 供应商一致

### Q2：Web 端访问需要认证
- 若开启 `AUTH_ENABLED=true`，请求需带 `Authorization: Bearer your-local-api-key-1`

### Q3：桌面端打不开微信
- 新版微信进程名是 `Weixin`（非 `WeChat`），段先生 v19.0 已修正此问题
- 确保微信已登录且窗口未最小化

### Q4：飞书收不到消息
- 确认 `~/.duan/config.json` 的 `channels.feishu` 包含 `dmPolicy: "open"` 和 `requireMention: false`

### Q5：如何切换模型
- Web/桌面端：在设置界面热切换（无需重启）
- 配置文件：修改 `DEFAULT_MODEL` 后重启

---

## 下一步

- 📚 阅读 [完整文档](../README.md#文档导航)
- 💬 加入内测群交流用法
- 📝 使用 [反馈模板](FEEDBACK-TEMPLATE.md) 提交反馈
- 🎯 挑战复杂任务，探索段先生的能力边界

---

> 遇到任何问题，不要犹豫，随时反馈。段先生的进化需要你的声音。 🚀
