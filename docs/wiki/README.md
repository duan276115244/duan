# 段先生 (Duan Xiansheng) v19.0 Code Wiki

> Super AI Assistant (J.A.R.V.I.S.) — Experience learning + Local reasoning + Optimal path

本 Wiki 是对 `d:\good\jws` 项目的完整代码级文档，覆盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系以及项目运行方式。

---

## 目录

| 章节 | 文档 | 内容 |
|------|------|------|
| 01 | [项目概览](./01-项目概览.md) | 项目定位、技术栈、目录结构、三端架构 |
| 02 | [核心架构](./02-核心架构.md) | 入口文件、Bootstrap 装配、EnhancedAgentLoop 主循环、状态机 |
| 03 | [工具系统](./03-工具系统.md) | 工具注册、智能选择、执行管道、熔断器、沙箱 |
| 04 | [记忆与学习系统](./04-记忆与学习系统.md) | 分层记忆、知识图谱、6 大学习子系统、进化指标 |
| 05 | [模型与配置系统](./05-模型与配置系统.md) | ModelLibrary 单例、统一配置、原子写、损坏防护 |
| 06 | [服务器与 API 层](./06-服务器与API层.md) | 路由注册、中间件、SSE 流式、API 端点清单 |
| 07 | [前端架构](./07-前端架构.md) | React 19、Zustand、组件、页面、useApi Hook |
| 08 | [桌面应用](./08-桌面应用.md) | Electron、IPC 通信、进程管理、窗口与托盘 |
| 09 | [高级子系统](./09-高级子系统.md) | 意识认知、推理引擎、自进化、Agent 协作、MCP、安全 |
| 10 | [运行与部署](./10-运行与部署.md) | 安装、启动命令、测试、构建打包、Docker |

---

## 项目定位

段先生是一个**自我进化的自主 AI Agent 系统**，定位为"世界级 AI 助手"，对标 J.A.R.V.I.S.。核心能力包括：

- **统一主循环**：Plan → Execute → Reflect → Learn 四阶段闭环
- **多模态运行**：CLI（TUI）、Web（HTTP/SSE）、Desktop（Electron）三端互通
- **150+ 内置工具**：覆盖文件、代码、Shell、浏览器、桌面、办公、视频等场景
- **分层记忆系统**：FTS5 全文检索 + 向量语义检索 + 知识图谱
- **自我进化**：Gödel Agent 架构 + 代码级 git 快照进化 + 自愈 + 竞品对比
- **多 Agent 协作**：SubAgent / 团队 / 三 Agent 闭环 / Handoff / 后台 Agent
- **意识模拟**：5 种意识状态 + 双神经网络 + 7 种推理模式
- **多供应商**：60+ 内置模型，支持 OpenAI / Anthropic / DeepSeek / 通义 / 智谱 / 豆包等

## 技术栈速览

| 层级 | 技术 |
|------|------|
| 后端语言 | TypeScript (Node.js >= 18) |
| Web 框架 | Express 4 |
| 桌面框架 | Electron 28 |
| 前端框架 | React 19 + Vite 6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 4 |
| 测试 | Vitest 4 |
| LLM SDK | OpenAI SDK + Anthropic SDK |
| 桌面自动化 | Puppeteer + screenshot-desktop |
| 语音 | ffmpeg + edge-tts |

## 快速启动

```bash
# 安装依赖
npm run duan:install

# CLI 模式（TUI 交互式）
npm run duan

# Web 模式（HTTP 服务 + Web UI）
npm run duan:web

# 桌面模式（Electron）
npm run duan:desktop

# 运行测试
npm test

# 类型检查
npm run typecheck
```

详细运行方式见 [10-运行与部署](./10-运行与部署.md)。
