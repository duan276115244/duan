# 段先生 v21.1 — 自主进化超级智能体

> **"I am J.A.R.V.I.S., your autonomous AI agent."**
> 段先生是一个对标 OpenClaw + Codex CLI + ClawHub 体系的自主进化 AI 智能体系统。

> **🚧 状态：Private Beta** — v21.1 主流 Agent 差异化能力补全完成，4 项 P0 全部就绪。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                       段先生 v21.1                           │
├─────────────────────────────────────────────────────────────┤
│  CLI 终端  │  Web 控制台  │  Electron 桌面端                  │
│            │  (移动端响应式) │  (Windows/macOS/Linux/UOS/麒麟)  │
├─────────────────────────────────────────────────────────────┤
│  EnhancedAgentLoop — 统一主循环 (Plan/Execute/Reflect/Learn) │
│  + L1-L4 思考预算分级 (500/1500/3000/6000 tokens)            │
│  + Hooks 生命周期系统 (16 事件 · 11 内置钩子 · update 动作)   │
├─────────────────────────────────────────────────────────────┤
│  180+ 内置工具  │  技能系统  │  通道管理器  │  记忆系统       │
│  44 办公工具   │  协作引擎  │  模型微调    │  离线协调器     │
│  AGENTS.md 三层记忆 │ 文件即接口上下文 │ 异步任务托管       │
├─────────────────────────────────────────────────────────────┤
│  25+ 模型供应商 · 58+ 模型 · 运行时热切换 · LoRA 微调         │
├─────────────────────────────────────────────────────────────┤
│  飞书 │ Telegram │ Discord │ Slack │ 企微 │ 钉钉 │ 邮件      │
│  WhatsApp │ Teams │ QQ │ 微信公众号                          │
├─────────────────────────────────────────────────────────────┤
│  国产系统：统信 UOS V20/V25 · 银河麒麟 V10                    │
│  CPU 架构：x86_64 · ARM64 (飞腾/鲲鹏) · LoongArch64 (龙芯)   │
└─────────────────────────────────────────────────────────────┘
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

> **Windows 一键安装**：双击 `install.bat` 安装依赖，双击 `duan.bat` 启动
> **生产构建**：`npm run build:all && npm start`
> **打包桌面安装包**：`npm run build:exe`
> **构建分发安装包**：`node scripts/make-package.cjs`（明文源码模式，无需解密）

## v21.1 升级亮点（主流 Agent 差异化能力补全 · 4 项 P0 全部完成）

### P0-A：打通已有能力最后一公里
补全 4 个已完整实现模块的工具元信息注册（20 个工具），让 LLM 在所有意图下都能看到这些工具：
- `shadow-git.ts` — 4 个工具（checkpoint_create/restore/list/diff），对标 Gemini CLI /restore
- `tree-sitter-ast.ts` — 6 个工具（ast_parse/project/usages/smells/structure/dependencies），对标 Aider Repo Map 解析
- `code-knowledge-graph.ts` — 3 个工具（code_graph_query/stats/analyze），对标 Cursor 代码索引
- `git-worktree.ts` — 7 个工具（worktree_create/remove/list/exec/merge/diff/sync），对标 Cursor 2.0 多 Agent 并行

### P0-B：Spec-Driven Development（对标 GitHub Spec Kit）
四阶段结构化任务工件流程，解决"氛围编程目标漂移"问题：
- `/specify` → spec.md（需求规范）→ `/plan` → plan.md（技术方案）→ `/tasks` → tasks.md（任务清单）→ `/implement`
- 项目宪法 `constitution.md` 持久化项目约束
- Self Check 验证当前实现是否符合 spec 和 checklist
- 7 个 LLM 工具：spec_create/plan/tasks/implement/check/list/get
- 63 个单元测试全过

### P0-C：Repo Map 重要性排序（对标 Aider RepoMap）
基于 tree-sitter 符号评分的压缩上下文，比暴力塞全文省 token 且更准：
- 符号重要性评分：被引用次数 × 2.0 + 导出 × 1.5 + 公共 API × 1.3 + 复杂度 × 0.8 - 文件大小惩罚 × 0.5
- Token 预算控制（默认 4096 tokens），按重要性 Top-N 截断
- 增量更新 + 60 秒缓存 + 优雅降级（WASM 不可用时用正则）
- 3 个 LLM 工具：repo_map_generate/query/symbols
- 54 个单元测试全过

### P0-D：Plan Mode 可编辑计划（对标 Cursor Plan Mode）
先生成可编辑 Markdown 计划，用户确认后再执行，避免方向跑偏：
- 状态机：draft → reviewing → approved → executing → completed / rejected → draft
- 步骤追踪：pending/in_progress/completed/skipped/failed + 自动进度计算
- Markdown 双向转换：生成可读计划 + 从 Markdown 导入
- 持久化到 `.duan/plans/<plan-id>.json`
- 5 个 LLM 工具：plan_create/update/confirm/cancel/list
- 98 个单元测试全过

---

## v21.0 升级亮点（主流 Agent 对标 · 4 项 P0 全部完成）

### §1 Hooks 生命周期系统（对标 Claude Code）
| 能力 | 说明 |
|------|------|
| 5 种新事件 | ON_USER_PROMPT_SUBMIT / ON_STOP / ON_PRE_COMPACT / ON_SUBAGENT_START / ON_SUBAGENT_STOP |
| 6 个新内置钩子 | ProjectContext（注入 git 状态）/ StopNotification（系统通知）/ PreCompactGit（压缩前注入摘要）/ AutoFormat（自动 prettier/black/gofmt/rustfmt）/ DangerousCommand（拦截 14 种危险命令）/ PromptSafety（拦截 prompt 注入） |
| update 动作 | 对标 Claude Code `updatedInput`，允许钩子修改 AI 原始命令 |
| 配置持久化 | `.duan/settings.json` 的 `hooks` 字段 |
| LLM 工具 | hooks_list / hooks_register / hooks_unregister / hooks_config_get / hooks_config_set |

### §2 AGENTS.md 三层记忆体系（对标 Codex CLI）
| 能力 | 说明 |
|------|------|
| 四级递归加载 | 全局（`~/.duan/AGENTS.md`）→ 项目（`<repo>/AGENTS.md`）→ 子目录（每一级）→ override（`AGENTS.override.md`） |
| 仓库根检测 | `git rev-parse --show-toplevel` 自动识别仓库边界 |
| 60 秒缓存 | 重复加载零开销 |
| 自动初始化 | `AgentsMdInitializer` 扫描项目（npm/pip/poetry/go/cargo/maven/gradle/docker）生成 starter AGENTS.md |
| LLM 工具 | agents_md_load / agents_md_init / agents_md_list |

### §3 文件即接口上下文工程（对标 Cursor）
| 能力 | 说明 |
|------|------|
| 工具结果文件化 | >4KB 的工具输出自动写入临时文件，返回摘要（前 500 + tail 200 字符） |
| 历史引用 | 长会话历史自动归档为文件引用，节省 40%+ Token |
| 终端输出文件化 | 长命令输出归档为文件，避免污染上下文 |
| 统计 & 清理 | 文件化数量/节省比例统计，FIFO 淘汰（maxFiles=100）+ 定时清理 |
| LLM 工具 | file_context_stats / file_context_search / file_context_history_list / file_context_cleanup |

### §4 异步任务托管模式（对标 Devin）
| 能力 | 说明 |
|------|------|
| 任务队列 | submitTask 立即返回 task-id，后台异步执行 |
| 进度追踪 | updateProgress / log / isCancelled 实时上下文 |
| 中断恢复 | 启动时加载 running 任务标记为 interrupted，支持 resume |
| 并行任务 | maxConcurrent 限制并行数（默认 3） |
| 任务模板 | 4 个内置模板：code-review / batch-test / doc-generation / large-refactor |
| LLM 工具 | async_task_submit / status / list / cancel / logs / templates / stats |

---

## v20.0 升级亮点（19 项全部完成）

### P0 — 基础能力
| 升级项 | 模块 | 能力 |
|--------|------|------|
| §2.1 项目分层记忆 | project-memory-loader | 三级 Markdown 记忆（用户全局/仓库根/子目录），递归向上搜索，60s 缓存 |
| §2.2 思考预算分级 | enhanced-agent-loop | L1-L4 四级预算（500/1500/3000/6000 tokens），L4 含 ToT 树搜索 + Gödel 自指验证 |
| §3.1 代码库语义索引 | codebase-indexer | 6 语言符号提取（TS/JS/Py/Java/Go/Rust），增量索引，语义搜索，引用查找，调用图 |
| §4.2 国产系统适配 | native-platform / native-deps | UOS/麒麟 + x86_64/ARM64/LoongArch64，系统 Chromium/ffmpeg 解析 |

### P1 — 工程能力
| 升级项 | 模块 | 能力 |
|--------|------|------|
| §2.3 专用子代理预设 | subagent-presets | 8 类预设角色（审查/测试/架构/调试/文档/安全/性能/调研）+ 意图派发 |
| §2.4 斜杠命令系统 | slash-commands | 对标 Claude Code `.claude/commands`，自定义命令模板 |
| §3.2 动态上下文发现 | context-discoverer | 对标 Cursor dynamic discovery，相关文件/import 关系/git diff 发现 |
| §3.3 多文件协同编辑 | multi-file-editor | 原子性多文件修改 + 回滚，跨文件批量操作 |

### P2 — 差异化能力
| 升级项 | 模块 | 能力 |
|--------|------|------|
| §2.5 分级许可清单 | tool-permissions | 对标 Claude Code permissions，allow/deny/ask 三级许可 |
| §3.6 角色人格系统 | persona-system | 多角色切换 + 人格注入，定制化助手风格 |
| §3.7 长期目标追踪 | goal-tracker | OKR 风格目标管理，进度追踪，里程碑 |
| §3.4 自主工程任务 | autonomous-engineer | 自动化工程任务执行，代码分析/重构/部署 |
| §5.1 多模态增强 | document-parser | PDF/Word/Excel/HTML/Markdown 解析，多格式文档理解 |
| §4.2.3 LoongArch64 | build-linux.sh | 龙芯架构支持，社区版 Electron 适配 |

### P3 — 高级能力
| 升级项 | 模块 | 能力 |
|--------|------|------|
| §5.4 主动提问 | proactive-question-engine | 主动知识盲区探测，智能追问 |
| §5.4 技能市场 | skill-market | 技能交易与评估，社区共享 |
| §5.2 离线能力 | offline-coordinator | 网络检测 + 本地模型（Ollama/llama.cpp）+ 离线知识库 |
| §5.4 进度可视化 | learning-progress-visualizer | 学习曲线/能力雷达图/技能树/趋势分析 |
| §3.5 模型微调 | model-fine-tuner | 数据收集/格式化（LoRA/QLoRA/Instruct/ChatML）/训练调度/模型注册 |
| §5.3 协作能力 | collaboration-engine | 团队管理/共享会话/任务派发/团队知识库 |

## 核心特性

### 🧠 多模型支持 + 模型微调
支持 25+ AI 模型供应商 · 58+ 模型，自动故障转移，运行时无缝热切换。v20 新增模型微调能力：从学习记录/交互历史收集训练数据，格式化为 LoRA/QLoRA/Instruct/ChatML，调度训练任务（Ollama/llama.cpp 后端），训练完成后自动注册到 ModelLibrary。

### 📡 消息通道 + 团队协作
对标 OpenClaw 的 `channels.*` 配置模式，支持飞书、Telegram、Discord、Slack、企业微信、钉钉、邮件、WhatsApp、Teams、QQ、微信公众号等通道。v20 新增协作引擎：团队成员管理、共享会话实时消息、任务派发（优先级/子任务/截止时间）、团队知识库（private/team/public 可见性）。

### 🛠️ 200+ 内置工具
浏览器自动操作、Shell 命令、文件系统、桌面控制、代码生成、网络搜索、视频生成等。其中 **44 个办公工具**采用四批分层架构（基础/扩展/进阶/终极）。v20 新增 80+ 工具：项目记忆管理、代码库语义搜索、斜杠命令、子代理派发、多文件编辑、许可管理、角色切换、目标追踪、文档解析、主动提问、技能市场、离线协调、进度可视化、模型微调、团队协作。v21.0 新增 19 个工具：Hooks 管理（5）、AGENTS.md 加载（3）、文件上下文引擎（4）、异步任务托管（7）。v21.1 新增 35 个工具：补全 AST/Checkpoint/CodeGraph/Worktree 工具元信息（20）+ Spec-Driven（7）+ Repo Map（3）+ Plan Mode（5）。

### 🔄 自主进化 + 离线能力
统一主循环（Plan/Execute/Reflect/Learn）自动分析任务质量，发现改进点并应用修复。v20 新增离线协调器：网络状态检测、本地模型检测（Ollama/llama.cpp）、离线模式自动切换、内置 10 条离线知识条目（TypeScript/Python/Git/Linux/正则/HTTP/SQL/Docker/npm/VSCode）。

### 🧩 技能系统 + 技能市场
内置 11+ 技能 + AI 自动萃取新技能，跨会话复用经验。v20 新增技能市场：技能交易、评估、社区共享。

### 📊 学习进度可视化
v20 新增学习进度可视化引擎：学习曲线（按日/周/月聚合）、能力雷达图（3-tier 回退：CapabilityScoreMatrix 8维 → EvolutionMetrics 5类 → SelfAssessment 12指标）、技能树（按分类分组）、趋势分析（improving/declining/stable）、Markdown 综合报告。

### 🔒 安全机制
- **ApprovalGate** 审批 — 高风险操作需用户确认
- **GuardrailSystem** 护栏 — 输出安全检查
- **CircuitBreaker** 死循环检测 — 最多 6 次策略切换（DOOM_LOOP_THRESHOLD=3）
- **CSP 硬化** — `script-src` 已移除 `'unsafe-inline'`，防 XSS 注入执行
- **原子写** — 所有 JSON 写入使用 `atomicWriteJson(Sync)`，防部分写入损坏
- **CorruptionGuard** — JSON 文件损坏自动检测+修复+备份（最多保留 5 份）
- **分级许可清单** — allow/deny/ask 三级许可，对标 Claude Code permissions
- **DangerousCommandHook** — v21 新增，拦截 14 种危险命令模式（rm -rf /、DROP TABLE、git push --force、fork 炸弹、curl|bash 等）
- **PromptSafetyHook** — v21 新增，拦截 prompt 注入攻击（ignore previous instructions、jailbreak、角色劫持等）

### 🖥️ 三平台一致性 + 国产系统适配
- **CLI**：完整命令行交互
- **Web**：响应式控制台，移动端触控适配（44px 触控目标、safe-area-inset、clamp 字体）
- **Desktop**：Electron 桌面端，桌面自动化（WeChat/窗口管理/系统设置）
- **国产系统**：统信 UOS V20/V25、银河麒麟 V10，支持 x86_64/ARM64（飞腾/鲲鹏）/LoongArch64（龙芯）

## 质量验证

```bash
# 完整验证套件
npm run verify:all   # typecheck + lint + test

# 单项验证
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 代码规范
npm run test         # Vitest 单元测试（~3981 测试）
```

## 安装包构建

```bash
# 构建明文源码安装包（无需解密，直接可运行）
node scripts/make-package.cjs
# 产出 duan-installer/ 目录（~657 文件，~19 MB）

# 打包为 zip 分发
# 用户解压后双击 install.bat 即可
```

## 许可证

MIT License

---

**🤖 "您好，我是段先生。我会成为您最得力的助手！"**
