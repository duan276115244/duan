# 段先生 v21.1 升级计划 — 主流 Agent 差异化能力补全

> **版本**：v21.1（在 v21.0 基础上升级）
> **日期**：2026-07-16
> **目标**：补全已有能力的"最后一公里"接入 + 新增 3 项主流 Agent 差异化能力

## 调研结论

基于 2026 年主流 Agent（Claude Code/Cursor/Devin/OpenHands/Windsurf/Aider/Continue.dev/Spec Kit/Trae/Codex CLI/Gemini CLI）调研，发现项目已实现大量基础设施但未完整接入主循环。本计划聚焦"打通已有能力 + 补齐关键缺失"。

## P0-A：打通已有能力最后一公里

### 问题
4 个已完整实现的模块缺失 `smart-tool-selector` 工具元信息注册，导致 LLM 在非 `mixed` 意图下看不到这些工具：
- `shadow-git.ts` — 4 个工具（checkpoint_create/restore/list/diff）
- `tree-sitter-ast.ts` — 6 个工具（ast_parse/project/usages/smells/structure/dependencies）
- `code-knowledge-graph.ts` — 3 个工具（code_graph_query/stats/analyze）
- `git-worktree.ts` — 7 个工具（worktree_create/remove/list/exec/merge/diff/sync）

### 实施
1. 在 `smart-tool-selector.ts` 的 `BUILTIN_TOOL_METAS` 注册 20 个工具元信息
2. 更新 `INTENT_KEYWORDS` 添加相关关键词
3. 补全单元测试（7 个模块中仅 code-knowledge-graph 有测试）

### 验收
- 20 个工具元信息全部注册
- LLM 在 code/file 意图下能看到 ast_*/checkpoint_*/worktree_* 工具
- 新增测试覆盖核心功能

---

## P0-B：Spec-Driven Development（对标 GitHub Spec Kit）

### 背景
GitHub Spec Kit 的四阶段流程（specify → plan → tasks → implement）解决了"氛围编程目标漂移"问题，是长任务可信交付的关键。

### 设计
新建 `spec-driven-dev.ts` 模块：

```
spec/
├── constitution.md          # 项目宪法（持久约束）
├── 001-feature-name/
│   ├── spec.md              # 需求规范（what & why）
│   ├── plan.md              # 技术方案（how）
│   ├── tasks.md             # 任务清单（可执行步骤）
│   └── checklist.md         # 验收清单（acceptance criteria）
```

### 四阶段流程
1. **/specify** — 需求澄清，生成 spec.md（多轮交互）
2. **/plan** — 技术方案，生成 plan.md（指定技术栈/架构）
3. **/tasks** — 任务拆解，生成 tasks.md（可执行步骤 + 前置依赖）
4. **/implement** — 按任务清单执行，每完成一项勾选

### Self Check
- `spec_check` — 验证当前实现是否符合 spec.md
- `spec_checklist` — 检查 checklist.md 项是否全部通过

### LLM 工具（7 个）
- `spec_create` — 创建新 spec
- `spec_plan` — 生成技术方案
- `spec_tasks` — 拆解任务
- `spec_implement` — 执行下一任务
- `spec_check` — 自查实现合规性
- `spec_list` — 列出所有 spec
- `spec_get` — 获取指定 spec 详情

### 验收
- 能创建 spec 并走完四阶段流程
- 工件文件落盘到 `spec/` 目录
- self check 能检测未完成的 checklist 项

---

## P0-C：Repo Map 重要性排序（对标 Aider RepoMap）

### 背景
Aider 的 RepoMap 基于 tree-sitter 解析代码结构，按符号重要性排序后注入 LLM 上下文，比暴力塞全文省 token 且更准。我们已有 `tree-sitter-ast.ts`（1649 行）但未提供"按重要性排序的压缩上下文"能力。

### 设计
新建 `repo-map.ts` 模块，基于 `TreeSitterAST` 实现：

1. **符号重要性评分**
   - 被引用次数（fan-in）× 2.0
   - 导出符号 × 1.5
   - 公共 API（public class/function）× 1.3
   - 复杂度权重 × 0.8
   - 文件大小惩罚 × 0.5

2. **压缩上下文生成**
   - 按重要性 Top-N 符号生成紧凑的代码结构树
   - 格式：`文件路径:行号 符号名 (类型) [引用数]`
   - Token 预算控制（默认 4096 tokens）

3. **增量更新**
   - 文件修改时只重新解析受影响文件
   - 60 秒缓存

### LLM 工具（3 个）
- `repo_map_generate` — 生成项目 Repo Map
- `repo_map_query` — 查询指定符号的重要性
- `repo_map_symbols` — 列出 Top-N 重要符号

### 验收
- 能生成压缩的代码结构上下文
- Token 消耗比全文注入减少 70%+
- 符号重要性排序合理（被引用多的排前面）

---

## P0-D：Plan Mode 可编辑计划（对标 Cursor Plan Mode）

### 背景
Cursor 的 Plan Mode 在生成代码前先产出可编辑的 Markdown 计划，用户确认后再执行，避免方向跑偏。适合长任务和复杂需求。

### 设计
新建 `plan-mode.ts` 模块：

1. **计划生成**
   - 分析用户需求 → 生成结构化 Markdown 计划
   - 计划格式：目标 / 步骤 / 涉及文件 / 风险 / 验收标准
   - 支持多轮细化

2. **计划状态机**
   ```
   draft → reviewing → approved → executing → completed
                  ↓
               rejected → draft
   ```

3. **计划执行追踪**
   - 每个步骤标记 pending/in_progress/completed/skipped
   - 执行时自动勾选完成项
   - 支持中途调整计划

4. **计划持久化**
   - 存储到 `.duan/plans/<plan-id>.json`
   - 支持历史计划查询

### LLM 工具（5 个）
- `plan_create` — 创建新计划
- `plan_update` — 更新计划内容/状态
- `plan_confirm` — 确认计划开始执行
- `plan_cancel` — 取消计划
- `plan_list` — 列出所有计划

### 验收
- 能生成结构化 Markdown 计划
- 计划状态机正确流转
- 执行时自动追踪进度

---

## 实施顺序

1. **P0-A**（最小工作量，最大即时收益）— 补全工具元信息注册 + 测试
2. **P0-B**（Spec-Driven）— 新建模块，独立性强
3. **P0-C**（Repo Map）— 依赖已有 tree-sitter-ast
4. **P0-D**（Plan Mode）— 新建模块
5. **集成** — bootstrap.ts 五步接线 + smart-tool-selector 关键词
6. **验证** — 完整测试套件 + tsc
7. **发布** — 版本号升级 + Git 提交推送

## 预期成果

| 项目 | 数量 |
|------|------|
| 新增模块 | 3 个（spec-driven-dev/repo-map/plan-mode） |
| 补全元信息工具 | 20 个 |
| 新增 LLM 工具 | 15 个（7+3+5） |
| 新增测试 | ~150 个 |
| 对标主流 Agent | Aider/Cursor/Spec Kit/Gemini CLI/Codex CLI |
