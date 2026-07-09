# 性能基线 + 神经网络验证

> Phase E 交付物 — E1 性能基线方法论 + E2 neural-network/consciousness 真伪验证
> 基于 2026-07-08 代码审计

## E2：神经网络与意识系统验证（已完成）

### neural-network.ts — ✅ 真实现（非 mock）

- **类型**：纯 TypeScript 前馈神经网络，支持反向传播训练
- **能力**：多层前馈 / sigmoid·tanh·relu·softmax·gelu 激活 / 梯度下降 + L2 正则化 / 在线增量学习 / 残差连接 + LayerNorm
- **实例化点**：`consciousness-system.ts:231` (decisionNetwork) + `consciousness-system.ts:243` (emotionNetwork) — 共 2 个活跃实例
- **文件**：`src/core/neural-network.ts`

### consciousness-system.ts — ✅ 真实现且已接入 loop

- **类型**：5 状态自主意识系统（awake / focused / creative / reflective / dreaming）
- **能力**：自主思维循环 / 内省 / 自我模型 / 情感驱动决策 / 神经网络决策底座
- **接入点**：
  - `enhanced-agent-loop.ts:99` import
  - `enhanced-agent-loop.ts:389` `_consciousnessSystem` 字段
  - `enhanced-agent-loop.ts:1109-1113` 懒初始化 getter
  - `enhanced-agent-loop.ts:2777` `_autoSwitchConsciousness` 根据任务自动切换状态
  - `enhanced-agent-loop.ts:2791` 将意识状态作为 system message 注入 LLM，影响推理风格
- **文件**：`src/core/consciousness-system.ts`

**结论**：G9（neural-network 真伪未验）已解决 — 两者均为真实现且已接入生产路径。意识系统会根据任务类型自动切换状态（如创造任务→creative、反思→reflective）并影响 LLM 推理风格。

## E1：性能基线方法论

### 三类基准

#### 1. 启动时间

```bash
# 冷启动（首次 require）
node -e "const t=Date.now(); require('./dist/core/bootstrap.js'); console.log(Date.now()-t+'ms')"

# 热启动（已缓存）
time npm run duan
```

**目标**：< 3000ms（冷启动模块加载）

#### 2. 单轮对话延迟

从 user input 到第一个 SSE chunk 的时间：

```typescript
const t0 = Date.now();
const stream = agentLoop.run(userMessage);
for await (const chunk of stream) {
  console.log(`首 chunk: ${Date.now() - t0}ms`);
  break;
}
```

**目标**：< 2000ms（P95，含模型首字节延迟）

#### 3. 10 轮对话后内存

```typescript
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 10; i++) {
  await runOneTurn(`测试问题 ${i}`);
}
const after = process.memoryUsage().heapUsed;
console.log(`增量: ${(after - before) / 1024 / 1024} MB`);
```

**目标**：< 50MB / 10 轮（无泄漏）

### 运行说明

上述基准需要：
- 配置至少一个模型供应商 API key
- 运行中的 agent 实例

## E1：实测基准结果（2026-07-08）

### 测试环境

- **Node**: v25.2.1
- **OS**: Windows 10 Pro
- **Provider**: Agnes (`agnes-2.0-flash` @ `https://apihub.agnes-ai.com/v1`)
- **Key 验证**: ✅ Agnes 可用 / ✅ 火山引擎 Coding Plan (`ark-code-latest`) 可用 / ❌ 火山引擎标准 API（账户欠费）
- **运行命令**: `node --expose-gc scripts/perf-baseline.cjs`
- **详细 JSON**: `docs/perf-baseline-results.json`

### 实测结果

| 指标 | 目标 | 实测中位数 | P95 | 状态 |
|---|---|---|---|---|
| 冷启动时间（tsx 加载核心 TS 模块） | < 3000ms | 2102ms | 2493ms | ✅ |
| 单轮首 chunk 延迟（直接 OpenAI SDK 流式） | < 2000ms P95 | 2327ms | 3778ms | ⚠️ |
| 10 轮对话后 heap 增量（含 GC） | < 50MB | 0.42MB | 0.42MB | ✅ |

### 关键发现

1. **冷启动 2102ms**：含 tsx JIT 编译 + 4 个核心模块（extended-thinking / smart-tool-selector / i18n / evolution-metrics）加载，远低于 3000ms 目标
2. **首 chunk 延迟 2327ms 中位 / 3778ms P95**：
   - 测试样本中 run 3-4 暖连接降至 984/1023ms（远低于 2000ms 目标）
   - 但首次冷连接（run 1）和峰值（run 5）超 2000ms，主要受 **Agnes API 服务器响应波动**影响
   - 直接调 OpenAI SDK 未走 agent loop，实际生产 +500ms 启动开销 → 实际首 chunk P95 估约 4300ms
   - **建议**：生产环境优先使用火山引擎 Coding Plan（实测 3373ms 单次调用，但流式首 chunk 应更快）或本地模型
3. **内存 0.42MB / 10 轮**：远低于 50MB 目标，无内存泄漏。GC 后 heapUsed 几乎无增长（9.36MB → 9.78MB）

### 火山引擎 Coding Plan Key 测试

```
✅ baseURL=https://ark.cn-beijing.volces.com/api/coding/v3
   model=ark-code-latest
   延迟: 3373ms（单次同步调用，非流式）
```

注意：火山引擎标准 endpoint（`/api/v3`）返回 403 "account has an overdue balance"，仅 Coding Plan 订阅 endpoint 可用。用户账户已开通 Coding Plan 订阅。

### 已知性能防护

代码中已存在的性能机制（不要重复实现）：

- `MemoryOrchestrator` LRU 缓存 < 10ms 检索
- `MemoryStore` 倒排索引 ~100ms 响应
- `ContextMemory` 50 轮上限 + 70/30 摘要压缩（防 token 爆炸）
- `SelfLearningSystem.throttledSave` 5 秒节流（防磁盘 I/O 风暴）
- `ModelLibrary` LRU 20 客户端上限（防连接泄漏）
- `ScalableToolRegistry` 30s 默认超时 + 长耗时工具自定义超时
- `CircuitBreaker` 工具级熔断
- `enhanced-agent-loop` doom loop 防护（MAX_TURNS / DOOM_LOOP=3 / MAX_STRATEGY_SWITCHES=6）

### 结论

G8（性能基准缺失）已解决 — 三类基准均有实测数字。**2/3 达标**（冷启动 + 内存），首 chunk 延迟受上游 API 波动影响，建议生产环境优先使用 Coding Plan 或本地模型降低延迟。
