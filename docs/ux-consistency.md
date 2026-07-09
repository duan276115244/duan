# 三端 UX 一致性契约

> Phase B2 交付物 — web/console/desktop 三端共享的交互契约
> 目标：用户在任一端学到的交互模式可无缝迁移到其他端

---

## 一、共享命令动词（Plan/Execute/Reflect/Learn）

所有三端必须使用**同一套四相动词**描述 agent 的主循环阶段：

| 阶段 | 动词 | 中文标签 | 说明 |
|---|---|---|---|
| Plan | `Plan` | 规划 | 任务分解 + 步骤排序 |
| Execute | `Execute` | 执行 | 工具调用 + 结果收集 |
| Reflect | `Reflect` | 反思 | 验证结果 + 提炼教训 |
| Learn | `Learn` | 学习 | 持久化经验 + 更新画像 |

**禁止变体**：`思考`（混淆 Extended Thinking）、`行动`（混淆桌面操作）、`总结`（混淆最终回复）。

### 事件类型 → UI 渲染映射

`enhanced-agent-loop.ts` 的 async generator 产出以下事件类型，三端必须按统一映射渲染：

| 事件 `type` | 含义 | Web 渲染 | Console 渲染 | Desktop 渲染 |
|---|---|---|---|---|
| `think` | 推理/思考片段 | 折叠面板 `💭 {content}` | 灰色 `◈ {content}` | 折叠面板 `💭 {content}` |
| `plan` | 执行计划结构 | 步骤列表卡片 | 步骤列表 `📋 {step}` | 步骤列表卡片 |
| `tool_call` | 工具开始执行 | `🔧 {toolName}` 行 + spinner | `🔧 {toolName}...` | `🔧 {toolName}` 行 + spinner |
| `tool_result` | 工具返回结果 | `✓ {toolName}: {content}` 折叠 | `✓ {content}` | `✓ {toolName}: {content}` 折叠 |
| `error` | 错误（可恢复） | `⚠️ {content}` 红底 | `⚠️ {content}` | `⚠️ {content}` 红底 |
| `completed` | 任务终态成功 | 最终回复气泡 | `✅ {summary}` | 最终回复气泡 |

**禁止**：console 用 `>` 前缀、web 用 `>` 前缀、desktop 用不同图标 — 三端图标/前缀必须一致。

---

## 二、错误展示统一格式

### 2.1 可恢复错误（继续执行）

格式：`⚠️ {summary}。正在尝试更换策略 (n/6)...`

- `n` = 当前策略切换次数
- `6` = `MAX_STRATEGY_SWITCHES` 上限（`enhanced-agent-loop.ts:88`）
- 不阻断流，agent 自动重试

**示例**：
```
⚠️ browser_operate 工具超时（30s）。正在尝试更换策略 (2/6)...
⚠️ API 连接失败: ETIMEDOUT。正在尝试更换策略 (3/6)...
```

### 2.2 不可恢复错误（终止）

格式：`❌ {summary}` + 可选 `{建议修复步骤}`

- 终止当前任务，返回 `{ type: 'completed', summary: '...' }` 或抛出
- 必须含**可操作**的修复步骤（"请运行 X" / "请在设置中 Y"）

**示例**：
```
❌ 未配置 API Key。请先运行: config setup 或使用 model config 命令
❌ API 余额不足 (HTTP 402)，请充值或切换 Provider
❌ 模型 "gpt-5" 不可用 (HTTP 404)，请检查模型名称或切换 Provider
```

### 2.3 安全护栏拦截

格式：`🛑 {reason}`（阻断）/ `⚠️ {reason}`（修改后放行）

**示例**：
```
🛑 输入被护栏阻止: 检测到敏感指令注入
⚠️ 输入已被护栏修改: 自动移除可疑 URL
```

---

## 三、流式输出格式统一

### 3.1 单轮对话时序

```
用户输入
  ↓
🧠 检测到复杂任务（{reason}），自动进入 Extended Thinking...   ← think (可选)
💭 {推理片段 1}                                                ← think
💭 {推理片段 2}                                                ← think
📋 执行计划                                                    ← plan
  1. {step1} [toolHint: file_read]
  2. {step2} [toolHint: code_execute]
🔧 file_read                                                   ← tool_call
✓ file_read: {内容预览 300 字}                                 ← tool_result
🔧 code_execute                                                ← tool_call
✓ code_execute: {执行输出}                                     ← tool_result
🧠 反思: {教训/验证}                                           ← think (Reflect)
📚 学习: {持久化经验}                                          ← think (Learn)
✅ {最终回复}                                                  ← completed
```

### 3.2 工具调用展示规则

- **工具名**：始终用 `🔧 {toolName}` 前缀（不用 `→` / `>` / `调用`）
- **结果预览**：截断到 300 字 + 折叠展开（`tool_result.content.substring(0, 300)`，已在 `enhanced-agent-loop.ts:4770,4894,4943` 实现）
- **并行工具**：`🔧 并行执行: {tool1}, {tool2}`（已在 `enhanced-agent-loop.ts:4709` 实现）
- **失败工具**：`❌ {toolName} {错误摘要}`

### 3.3 思考片段展示规则

- **思考**：`💭 {content}`，默认折叠，用户点击展开
- **意识状态**：`🧩 意识状态: {desc}`（已在 `enhanced-agent-loop.ts:2809` 实现）
- **认知推理**：`🧠 {reasoning}`（已在 `enhanced-agent-loop.ts:2794` 实现）
- **经验命中**：`📦 命中历史经验包 "{name}"` / `📚 找到 {n} 条相关经验`

### 3.4 进度反馈

- **计划进度**：`📊 计划进度: {completed}/{total} 步骤完成`（每 `PLAN_REASSESS_INTERVAL` 轮报告，已在 `enhanced-agent-loop.ts:3027` 实现）
- **死循环检测**：`⚠️ 检测到死循环，自动结束`（`DOOM_LOOP_THRESHOLD=3`，已在 `enhanced-agent-loop.ts:2987` 实现）
- **收益递减**：`⚠️ 连续多轮无进展，自动结束`（`MAX_DIMINISHING_RETURNS=5`，已在 `enhanced-agent-loop.ts:3012` 实现）

---

## 四、i18n 回复语言契约（Phase B1）

agent 自动检测用户输入语言并影响回复语言：

| 输入特征 | 检测 locale | 回复语言指令 |
|---|---|---|
| 假名占比 > 5% | `ja-JP` | 追加 `Reply in Japanese.` |
| CJK 占比 > 20% | `zh-CN` | 默认，不追加指令 |
| ASCII 占比 > 40% | `en-US` | 追加 `Reply in English.` |

**实现位置**：`enhanced-agent-loop.ts:2692-2698`（构造 state 前调 `detectAndSetLocale(input)` + 追加 `getRespondInstruction()`）

**三端契约**：
- 事件 `content` 字段的语言跟随用户输入语言（agent 回复语言自动适配）
- UI 框架文字（按钮/标签/提示）由前端 i18n 资源控制，与 agent 回复独立
- 错误信息（`⚠️`/`❌`）的正文跟随 agent locale，但前缀图标三端一致

---

## 五、验收检查清单

三端各跑 1 个典型任务（写代码 + 浏览器导航 + 桌面操作），对比：

- [ ] 三端均出现 `💭` 思考折叠块
- [ ] 三端均出现 `🔧 {toolName}` 工具调用行
- [ ] 三端均出现 `✓`/`❌` 工具结果标记
- [ ] 三端错误格式一致（`⚠️ {summary}。正在尝试更换策略 (n/6)...`）
- [ ] 英文输入 → 三端 agent 均用英文回复
- [ ] 中文输入 → 三端 agent 均用中文回复
- [ ] 计划进度 `📊 计划进度: x/y` 三端均显示

---

## 六、已知差异（不视为违规）

- **desktop** 端有原生窗口控件（最小化/最大化/关闭），web/console 无 — 这是平台特性，不要求统一
- **console** 端无折叠面板（终端不支持），思考片段改为缩进显示 — 已在上表注明
- **web** 端有侧边栏导航，desktop 端有标题栏菜单 — 导航结构差异允许，但功能入口必须等价
