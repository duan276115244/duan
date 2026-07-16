# 段先生 v21.0 升级计划 — 对标主流 Agent 差异化能力

> **目标**：参考 2026 年主流 Agent（Claude Code / Codex CLI / Cursor / Devin / Windsurf）的核心差异化能力，补齐段先生 v20 的短板，打造最强 Agent 智能助手。
>
> **原则**：每项实现后立即测试，tsc 0 错误，测试全过，git 可回滚。

---

## 调研结论（主流 Agent 亮点）

| Agent | 核心亮点 | 段先生 v20 现状 |
|-------|---------|----------------|
| Claude Code | 10 种 Hook 事件 + 5 种 Handler + updatedInput 修改原始命令 | 已有 11 种事件 + 6 内置钩子，但缺 UserPromptSubmit/Stop/PreCompact/prompt 类型/配置加载 |
| Codex CLI | AGENTS.md 三层记忆（全局/项目/子目录 override） | 有 .duan/memory/*.md 但非 AGENTS.md 标准 |
| Cursor | 文件即接口，工具结果文件化，节省 47% Token | 工具结果直接塞入上下文，无文件化 |
| Devin | 异步任务托管，分配任务后异步执行+通知 | 无异步任务队列 |
| Windsurf | 并行 Cascade + git worktree 隔离 + 待办清单 | 有 agent-team-orchestrator 但无 worktree 隔离 |
| OpenClaw | ClawHub 5490+ 技能生态 + ClawRouter 多模型路由 | 有技能市场但生态规模小 |

---

## v21 升级项（4 项 P0）

### §1 Hooks 生命周期系统增强（对标 Claude Code）

**现状**：`lifecycle-hooks.ts` 已有 11 种事件 + 6 内置钩子（RateLimit/TokenBudget/SecurityAudit/CostTracking/ErrorRecovery/SessionCleanup）

**升级内容**：
1. **新增 4 种 Hook 事件**：
   - `ON_USER_PROMPT_SUBMIT` — 每次用户提交 prompt 时触发，自动注入项目上下文（git 分支/技术栈/最近修改）
   - `ON_STOP` — 任务完成时触发，发送系统通知（Windows toast / macOS notification）
   - `ON_PRE_COMPACT` — 上下文压缩前触发，注入关键信息（git 状态/未完成任务）
   - `ON_SUBAGENT_START` / `ON_SUBAGENT_STOP` — 子 Agent 全链路追踪（细化现有 ON_SUBAGENT_DISPATCH/RESULT）

2. **增强 HookResult**：新增 `updatedInput` 字段，允许钩子修改 AI 原始命令（如过滤测试输出只看失败用例）

3. **新增 prompt 类型 Hook**：`PromptSafetyHook` 使用 LLM 判断命令安全性（复杂场景）

4. **配置文件加载**：从 `.duan/settings.json` 的 `hooks` 字段加载用户自定义钩子配置

5. **新增内置钩子**：
   - `ProjectContextHook` — UserPromptSubmit 时自动注入 git 分支、最近 commit、修改文件
   - `StopNotificationHook` — Stop 时发送系统通知
   - `PreCompactGitHook` — PreCompact 时注入 git status
   - `AutoFormatHook` — PostToolUse 后自动格式化（prettier/black/gofmt）
   - `DangerousCommandHook` — PreToolUse 拦截 `rm -rf /` / `DROP TABLE` / `git push --force`

**实现文件**：`src/core/lifecycle-hooks.ts`（增强）+ `src/core/__tests__/lifecycle-hooks-enhanced.test.ts`

---

### §2 AGENTS.md 三层记忆体系（对标 Codex CLI）

**现状**：`project-memory-loader.ts` 支持 .duan/memory/*.md 三级（用户全局/仓库根/子目录），但非 AGENTS.md 标准

**升级内容**：
1. **AGENTS.md 标准格式**：对标 Codex CLI，支持 `~/.duan/AGENTS.md`（全局）→ `<repo>/AGENTS.md`（项目根）→ `<subdir>/AGENTS.override.md`（子目录覆盖）

2. **向上递归查找**：从当前工作目录向上查找所有 AGENTS.md，按层级拼接

3. **冲突覆盖语义**：子目录 override > 项目根 > 全局，冲突时深层覆盖浅层，非冲突指令叠加

4. **`/init` 命令增强**：扫描项目结构自动生成 starter AGENTS.md（技术栈/构建命令/代码规范/关键路径）

5. **与现有 ProjectMemoryLoader 共存**：AGENTS.md 作为新的标准入口，.duan/memory/*.md 保留兼容

**实现文件**：`src/core/agents-md-loader.ts`（新建）+ `src/core/__tests__/agents-md-loader.test.ts`

---

### §3 文件即接口上下文工程（对标 Cursor）

**现状**：工具结果直接塞入上下文，大 JSON/日志会撑爆上下文窗口

**升级内容**：
1. **工具结果文件化**：工具返回大结果（>4KB）时自动写入临时文件 `.duan/tmp/tool-output-<hash>.txt`，上下文只保留文件路径 + 摘要（前 500 字符 + tail 200 字符）

2. **历史记录文件引用**：上下文压缩时给"历史记录文件"引用，可 grep 搜索找回，替代有损压缩

3. **技能懒加载增强**：技能初始只加载 name+description，使用时才读取完整内容（现有 skill-registry 部分实现，需增强）

4. **MCP 工具懒加载**：只给工具名字，详情同步到文件夹，按需读取

5. **终端输出文件化**：终端输出同步为本地文件，grep 搜索无需手动粘贴

**预期效果**：节省 40%+ Token 消耗

**实现文件**：`src/core/file-context-engine.ts`（新建）+ `src/core/__tests__/file-context-engine.test.ts`

---

### §4 异步任务托管模式（对标 Devin）

**现状**：所有任务同步执行，长耗时任务阻塞会话

**升级内容**：
1. **任务队列**：提交任务到后台队列，立即返回 task-id，异步执行

2. **进度追踪**：任务执行过程中实时更新状态（pending/running/completed/failed/cancelled）+ 进度百分比 + 日志流

3. **结果通知**：任务完成时通过配置的通道（飞书/微信/邮件/webhook）发送通知

4. **中断恢复**：进程重启后加载未完成任务，可继续执行或标记为 interrupted

5. **并行任务**：支持多个异步任务并行执行，每个任务独立上下文

6. **任务模板**：预定义常见异步任务模板（大规模重构/批量测试/文档生成/代码审查）

**实现文件**：`src/core/async-task-manager.ts`（新建）+ `src/core/__tests__/async-task-manager.test.ts`

---

## 实施顺序

1. §1 Hooks 生命周期系统增强（扩展现有模块）
2. §2 AGENTS.md 三层记忆体系（新建模块）
3. §3 文件即接口上下文工程（新建模块）
4. §4 异步任务托管模式（新建模块）
5. 版本号 v20 → v21 + 安装包更新
6. 完整测试套件 + tsc 验证
7. Git 提交推送

---

## 验收标准

- 每项功能：tsc 0 错误 + 新增测试全过
- 整体：`npm run test` 通过率 ≥ 99.5%
- 新增工具：在 smart-tool-selector BUILTIN_TOOL_METAS 注册
- 新增模块：在 bootstrap.ts 完成五步接线
- 文档：README.md 更新为 v21
