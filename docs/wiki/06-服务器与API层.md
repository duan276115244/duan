# 06 - 服务器与 API 层

本章覆盖路由注册、中间件、SSE 流式通信和完整 API 端点清单。

## 整体架构

```
src/web-server.ts (入口，构建 ServerContext)
  ↓
src/server/middleware.ts: setupMiddleware(app)         // 中间件
src/server/routes/registry.ts: registerRoutes(app, ctx) // 路由注册
src/server/middleware.ts: setupErrorHandlers(app)       // 错误处理
src/server/start-server.ts: startServer(app, info, cb)  // 端口监听
```

关键设计：`ServerContext` 作为单一依赖容器，由 `web-server.ts` 在启动时构造并注入到所有路由模块。

## ServerContext

### `src/server/services/app-context.ts`（L58-130）

```typescript
export interface ServerContext {
  // 基础元信息
  VERSION: string;
  appConfig: AppConfig;
  modelLibrary: CoreModules['modelLibrary'];
  conversations: Map<string, Conversation>;
  MAX_CONTEXT_MESSAGES: number;  // 默认 50
  agents: AgentInfo[];
  systemPrompt: string;

  // 核心智能模块
  nluEngine / promptOptimizer / continuousLearning / performanceMetrics
  knowledgeGraph / systemDiagnostics / autonomousCapabilities / capabilityManager
  subAgentOrchestrator / agentTeamOrchestrator
  heartbeat / selfEvolve / selfEvolutionEngine
  strategyEngine / skillExtractor / selfAssessment / taskPlanner
  projectConfig / selfLearningSystem
  learningEval / skillGen / userProfile

  // 独立初始化的模块
  contextMemory / smartPrompt / codeQuality / superReasoning
  faultTolerant / dynamicWorkflowEngine / voiceSystem / kb

  // 可选注入
  loop?: EnhancedAgentLoop              // 统一主循环实例
  capabilityAssessor?: CapabilityAssessor  // 10 维度能力评估器
}
```

### 注入方式

`web-server.ts` 在启动时：
1. 调用 `setupAgentLoop()` 获得 `{ modules, registry, loop }`
2. 通过 `setToolRegistry(registry)` 注入到 `tools.ts`
3. 构造 `serverCtx` 对象字面量
4. 调用 `registerRoutes(app, serverCtx)`

每个路由模块的注册函数签名：`export function registerXxxRoutes(app: express.Application, ctx?: ServerContext): void`

## 中间件

### `src/server/middleware.ts`

`setupMiddleware(app)` (L116) 挂载顺序：

1. **响应时间追踪**（L118-134）— 最先挂载，记录所有请求耗时
2. **CORS**（L139-149）— 默认仅允许 `localhost/127.0.0.1/file://` 源；`CORS_ALLOW_ALL=true` 放开
3. **JSON 解析**（L152）— `express.json({ limit: '10mb' })`
4. **请求/响应超时**（L155-159）— req 30s, res 60s
5. **并发控制**（L162-222，仅限 `/api/chat` 与 `/api/chat/stream`）：
   - `MAX_CONCURRENT=100`，`MAX_QUEUE_SIZE=200`，`QUEUE_TIMEOUT_MS=30000`
   - 队列满返回 503，排队超时返回 504
6. **静态文件**（L225）— 挂载 `web/` 目录
7. **安全头**（L231）— `securityHeaders()`
8. **认证**（L234）— `AUTH_ENABLED=true` 启用，默认关闭
9. **速率限制**（L238）— `RateLimiter(100, 60000)` 即 60 秒内 100 次

### 错误处理器

`setupErrorHandlers(app)` (L245)：
1. `/api/*` 404 处理 — 列出可用端点
2. 全局错误处理 — 生产环境隐藏错误详情；headers 已发送时通过 SSE 写入 `{type:'error', content:'...'}`
3. SPA fallback — 非 API/静态资源请求回退到 `web/index.html`

## 路由注册

### `src/server/routes/registry.ts`

`registerRoutes(app, ctx)` (L29) 按顺序注册 20 个路由组：

| 顺序 | 注册函数 | 文件 |
|------|---------|------|
| 1 | registerHealthRoutes | health-routes.ts |
| 2 | registerMCPSecurityRoutes | mcp-security-routes.ts |
| 3 | registerMCPMarketplaceRoutes | mcp-marketplace-routes.ts |
| 4 | registerSubAgentRoutes | subagent-routes.ts |
| 5 | registerWorkflowRoutes | workflow-routes.ts |
| 6 | registerApiV1Routes | api-v1-routes.ts |
| 7 | registerConfigRoutes | config-routes.ts |
| 8 | registerChannelsRoutes | channels-routes.ts |
| 9 | registerPairingRoutes | pairing-routes.ts |
| 10 | registerChatRoutes | chat-routes.ts |
| 11 | registerSystemRoutes | system-routes.ts |
| 12 | registerNluRoutes | nlu-routes.ts |
| 13 | registerEvolutionRoutes | evolution-routes.ts |
| 14 | registerKnowledgeRoutes | knowledge-routes.ts |
| 15 | registerCapabilitiesRoutes | capabilities-routes.ts |
| 16 | registerFeaturesRoutes | features-routes.ts |
| 17 | registerConsciousnessRoutes | consciousness-routes.ts |
| 18 | registerModuleRoutes | module-routes.ts |
| 19 | registerVoiceRoutes | voice-routes.ts |
| 20 | registerCapabilityRoutes | capability-routes.ts |

## 聊天 SSE 流式

### `POST /api/chat`（chat-routes.ts:105-377）

完整链路：

**Phase 1 - NLU 自然语言理解**（L117-134）
- `ctx.nluEngine.analyze(message, contextHistory)` 获取意图/实体/情感
- `ctx.knowledgeGraph.query(message)` 查询知识图谱

**Phase 2 - 提示词优化**（L136-137）

**Phase 3 - 上下文记忆**（L139-149）
- `ctx.contextMemory.addMessage('user', message)`

**Phase 4 - 智能模型选择**（L151-172）

**Phase 5 - 自主状态注入**（L174-202）
- 拼装情绪/认知/专注/能量/好奇心/置信度/创造力状态
- 注入能力/目标/价值观

**SSE 响应**（L204-336）
1. 设置 `Content-Type: text/event-stream`
2. 跟踪客户端断开：`res.on('close')`
3. 发送 `meta` + `status` 事件
4. **核心循环**：
   ```typescript
   const useUnifiedLoop = process.env.USE_UNIFIED_LOOP !== 'false';
   const eventStream = (useUnifiedLoop && ctx.loop)
     ? runViaUnifiedLoop(ctx.loop, contextMessages, enhancedSystemPrompt)
     : streamLLMResponse(contextMessages, model, provider, enhancedSystemPrompt);
   for await (const event of eventStream) {
     if (clientDisconnected) break;
     // 按 event.type 路由到 SSE data: JSON
   }
   ```
5. 发送 `done` 事件

### `POST /api/chat/stream`（chat-routes.ts:380-642）

前端新格式端点，不走统一循环，直接使用 `client.chat.completions.create({ stream: true, tools })`

**ReAct 多轮循环**（最多 15 轮）：
- 每轮调 LLM 流式输出 `delta.content` → 发 `{type:'text', content}`
- 收集 `delta.tool_calls`，组装后执行
- **防重复调用**：同工具+同参数 3 次跳过，同工具总调用 8 次上限
- 无 tool_calls 时退出循环

## loop-stream-adapter

### `src/server/services/loop-stream-adapter.ts`

将 `EnhancedAgentLoop` 的 `LoopEvent` 转换为 `StreamEvent`：

```typescript
export async function* runViaUnifiedLoop(
  loop: EnhancedAgentLoop,
  messages: Array<{ role: string; content: string }>,
  customSystemPrompt?: string,
): AsyncGenerator<StreamEvent>
```

### 事件映射表

| LoopEvent.type | StreamEvent.type | 说明 |
|---|---|---|
| `text` | `chunk` | 主响应文本 |
| `tool_call` | `tool_call` | 带 toolName/toolArgs |
| `tool_result` | `tool_result` | 带 toolName |
| `think` | `think` | 思考过程 |
| `plan` | `plan` | 结构化计划 |
| `warning` | `warning` | amber 横幅 |
| `compact` | `compact` | 压缩卡片 |
| `error` | `chunk` | 错误信息 |
| `state` / `done` | null（跳过） | 内部状态 |

## API 端点清单

### 聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/test-key` | 测试 API Key |
| POST | `/api/chat` | SSE 流式聊天（主链路） |
| POST | `/api/chat/stream` | SSE 流式聊天（ReAct 多轮） |
| POST | `/api/opencode/chat` | OpenCode 专用 |

### 配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config/unified` | 获取 v2.0 配置（脱敏） |
| PUT | `/api/config` | 全量更新配置 |
| POST | `/api/config/profile` | 新增/更新配置 |
| DELETE | `/api/config/profile/:id` | 删除配置 |
| PUT | `/api/config/active/:id` | 设置激活配置 |
| GET | `/api/duan/config` | 旧版配置 |
| POST | `/api/duan/config/test` | 测试连接 |
| POST | `/api/duan/config/reset` | 重置配置 |

### 能力评估

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/capability/dimensions` | 10 维度/31 指标定义 |
| GET | `/api/capability/report` | 最近评估报告 |
| POST | `/api/capability/assess` | 触发新评估 |
| POST | `/api/capability/baseline` | 保存 baseline |
| GET | `/api/capability/snapshots` | 历史快照 |
| GET | `/api/capabilities` | 完整功能清单 |

### SubAgent

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/subagent/stream` | SSE 订阅事件流 |
| GET | `/api/subagent/agents` | 列出可用 SubAgent |
| POST | `/api/subagent/team/start` | 启动团队执行 |
| GET | `/api/subagent/team/history` | 执行历史 |

### MCP 市场

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mcp/marketplace/list` | 列出插件 |
| POST | `/api/mcp/marketplace/install/:id` | 安装插件 |
| POST | `/api/mcp/marketplace/uninstall/:id` | 卸载插件 |
| GET | `/api/mcp/marketplace/updates` | 检查更新 |

### 意识系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/consciousness` | 认知状态 |
| GET | `/api/goals` | 目标系统 |
| POST | `/api/goals/create` | 创建目标 |
| GET | `/api/heartbeat` | 心跳状态 |
| GET | `/api/self-evolve/history` | 进化历史 |
| GET | `/api/strategy-engine` | 策略引擎状态 |
| GET | `/api/skills` | 获取所有技能 |

### 通道

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/channels/templates` | 13 种通道模板 |
| GET/POST/PUT/DELETE | `/api/channels` | 通道 CRUD |
| POST | `/api/channels/:id/start` | 启动通道 |
| POST | `/api/channels/test` | 测试连接 |

### 语音

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/voice/status` | 语音系统状态 |
| GET | `/api/voice/voices` | 可用 TTS 语音 |
| POST | `/api/voice/speak` | 文字转语音 |
| POST | `/api/voice/transcribe` | 语音转文字 |

### 工作流

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/workflow/stream` | SSE 订阅事件 |
| GET/POST/DELETE | `/api/workflow` | 工作流 CRUD |
| POST | `/api/workflow/execute` | 执行工作流 |

### 健康

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health/live` | 存活探针 |
| GET | `/api/health/ready` | 就绪探针 |
| GET | `/api/health` | 完整健康状态 |

### 开放 API v1（`/api/v1` 前缀）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/openapi.json` | OpenAPI 3.0 规格 |
| POST | `/api/v1/chat` | 对话接口（支持 SSE） |
| POST | `/api/v1/task` | 任务执行 |
| GET | `/api/v1/skills` | 技能列表 |
| GET | `/api/v1/tools` | 工具列表 |

## 启动流程

### `src/server/start-server.ts`

`startServer(app, info, onPortChange, initialPort?)` (L10)：
- 注册进程级错误兜底（`unhandledRejection` / `uncaughtException`）
- 启动 `UnifiedConfigManager.startWatch()` 三端配置实时同步
- **端口探测**：`tryListen(port, attempts)` 递归，`EADDRINUSE` 时端口 +1，最多 10 次
- 默认端口 `BASE_PORT = process.env.PORT || 3001`
- 启动后输出 API Key 检测状态

## 关键设计要点

1. **ServerContext 单容器模式**：50+ 字段，路由模块按需解构
2. **SSE 双轨制**：`/api/chat` 走 `runViaUnifiedLoop`（可关），`/api/chat/stream` 走原生 ReAct
3. **并发控制粒度**：仅对 `/api/chat` 启用并发限制
4. **断连保护**：`res.on('close')`（非 `req.on('close')`）跟踪客户端断开
5. **字段契约**：错误必须用 `content` 字段（前端 `useApi.ts:404` 读此字段）
6. **fire-and-forget**：SubAgent/Workflow 立即返回 executionId，结果通过 SSE 推送
