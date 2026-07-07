# 段先生 v19.0 — 自主进化超级智能体

> **"I am J.A.R.V.I.S., your autonomous AI agent."**
> 段先生是一个对标 OpenClaw + Codex CLI + ClawHub 体系的自主进化 AI 智能体系统。

> **🚧 状态：Private Beta** — 当前版本面向受邀小范围用户进行灰度测试。如需加入内测，请参阅 [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md)。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    段先生 v19.0                          │
├─────────────────────────────────────────────────────────┤
│  CLI 终端  │  Web 控制台  │  Electron 桌面端              │
│            │  (移动端响应式) │  (Windows/macOS/Linux)       │
├─────────────────────────────────────────────────────────┤
│  EnhancedAgentLoop — 统一主循环 (Plan/Execute/Reflect/Learn) │
├─────────────────────────────────────────────────────────┤
│  120+ 内置工具  │  技能系统  │  通道管理器  │  记忆系统    │
│  (含 44 个办公工具四批分层架构)                              │
├─────────────────────────────────────────────────────────┤
│  25+ 模型供应商 · 58+ 模型 · 运行时热切换                   │
├─────────────────────────────────────────────────────────┤
│  飞书 │ Telegram │ Discord │ Slack │ 企微 │ 钉钉 │ 邮件   │
│  WhatsApp │ Teams │ QQ │ 微信公众号                       │
└─────────────────────────────────────────────────────────┘
```

## 三平台快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入至少一个模型供应商的 API Key

# 3a. CLI 终端模式
npm run dev

# 3b. Web 控制台模式（含移动端响应式）
npm run dev:full
# 浏览器访问 http://localhost:3001

# 3c. Electron 桌面端模式
npm run dev:desktop
```

> **生产构建**：`npm run build:all && npm start`（后端 + 前端）
> **打包桌面安装包**：`npm run build:exe`（产出 Windows NSIS 安装包）

## 文档导航

| 文档 | 说明 | 适用读者 |
|---|---|---|
| 🔐 [加密解密指南](DECRYPTION.md) | 备份恢复方法、核心代码解密、口令说明 | **新机器部署必读** |
| 📖 [跨平台安装指南](docs/INSTALL.md) | Windows/macOS/Linux 完整安装步骤 | **新机器部署必读** |
| 📖 [安装指南](docs/installation.md) | 系统要求、安装步骤、Docker 部署 | 运维/新用户 |
| ⚙️ [配置指南](docs/configuration.md) | 消息通道、环境变量、安全设置 | 所有用户 |
| 🎮 [使用指南](docs/usage.md) | 聊天命令、交互模式、故障排除 | 最终用户 |
| 🛠️ [技能与工具](docs/skills-tools.md) | 120+ 工具参考、技能系统 | 开发者 |
| 🧠 [模型供应商](docs/model-providers.md) | 25+ 供应商 · 58+ 模型配置、故障转移 | 所有人 |
| 🔄 [自动化](docs/automation.md) | 自进化、定时任务、自愈系统 | 高级用户 |
| 🚀 [上线就绪报告](docs/LAUNCH-READINESS.md) | v19.0 质量验证、已知问题、灰度策略 | 内测用户/审查者 |
| 📢 [内测邀请公告](docs/BETA-ANNOUNCEMENT.md) | 能力一览、快速上手、内测须知 | 受邀内测用户 |
| 📖 [用户引导指南](docs/ONBOARDING.md) | 15 分钟从安装到首次任务 | 新内测用户 |
| 📝 [反馈模板](docs/FEEDBACK-TEMPLATE.md) | Bug 报告、建议、NPS、优秀案例 | 所有内测用户 |

## 核心特性

### 🧠 多模型支持
支持 25+ AI 模型供应商 · 58+ 模型，自动故障转移，运行时无缝热切换（通过 `config.external.changed` 事件驱动 ModelLibrary 单例清缓存）。

### 📡 消息通道
对标 OpenClaw 的 `channels.*` 配置模式，支持飞书、Telegram、Discord、Slack、企业微信、钉钉、邮件、WhatsApp、Teams、QQ、微信公众号等通道，含访问控制（dmPolicy）与健康监控。

### 🛠️ 120+ 内置工具
浏览器自动操作、Shell 命令、文件系统、桌面控制、代码生成、网络搜索、视频生成等。其中 **44 个办公工具**采用四批分层架构（基础/扩展/进阶/终极），覆盖文档/数据/媒体/PPT/CRM/简历/合同/财务/PDF/笔记/看板/工作流等场景。

### 🔄 自主进化
统一主循环（Plan/Execute/Reflect/Learn）自动分析任务质量，发现改进点并应用修复。**反馈链汇聚点**（`_recordOutcomeToEvolutionMetrics`）在任务终止路径喂养 5 个 `source='new'` 运行时指标（on_time_completion_rate、quality_gate_pass_rate、gap_probing_rate、improvement_velocity、regression_rate），维护 50 样本滚动平均。

### 🧩 技能系统
内置 11+ 技能 + AI 自动萃取新技能，跨会话复用经验。

### 🔒 安全机制
- **ApprovalGate** 审批 — 高风险操作需用户确认
- **GuardrailSystem** 护栏 — 输出安全检查
- **CircuitBreaker** 死循环检测 — 最多 6 次策略切换（DOOM_LOOP_THRESHOLD=3）
- **CSP 硬化** — `script-src` 已移除 `'unsafe-inline'`，防 XSS 注入执行
- **原子写** — 所有 JSON 写入使用 `atomicWriteJson(Sync)`，防部分写入损坏
- **CorruptionGuard** — JSON 文件损坏自动检测+修复+备份（最多保留 5 份）

### 🖥️ 三平台一致性
- **CLI**：完整命令行交互
- **Web**：响应式控制台，移动端触控适配（44px 触控目标、safe-area-inset、clamp 字体）
- **Desktop**：Electron 桌面端，桌面自动化（WeChat/窗口管理/系统设置）

## 质量验证

```bash
# 完整验证套件
npm run verify:all   # typecheck + lint + test + capability:check

# 单项验证
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 代码规范
npm run test         # Vitest 单元测试
npm run capability:check  # 能力评估（10 维度）
```

详见 [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md) 获取 v19.0 上线前完整质量验证报告。

## 许可证

MIT License

---

**🤖 "您好，我是段先生。我会成为您最得力的助手！"**
