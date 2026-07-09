# 记忆系统架构矩阵

> Phase C3 交付物 — 审计 10+ memory 模块的职责、调用方、活跃状态
> 基于 2026-07-08 Grep 验证（非臆测）

## 设计决策

**不删除任何模块** — 审计显示各模块职责不同（facade / store / working / graph / pattern 各司其职）。碎片化的解法是"单一召回门面（`MemoryOrchestrator.recall()`）+ 职责矩阵文档"，不是删代码。

## 模块职责矩阵

| 模块 | 职责 | 调用方 | 活跃状态 | 备注 |
|---|---|---|---|---|
| `memory-orchestrator.ts` (1386 行) | **统一门面**：FTS 检索 + LRU 缓存 + 三级降级 + prompt 格式化 | enhanced-agent-loop, web-server | ✅ 活跃 | Phase C1 强化为 `recall()` 唯一入口 |
| `memory-store.ts` (1563 行) | 四层存储：short-term(50) / working(100) / long-term(500) / procedural(200) + 倒排索引 | memory-orchestrator | ✅ 活跃 | 物理存储层 |
| `memory-types.ts` | Hermes 三级枚举 L0_SESSION / L1_PERSISTENT / L2_SKILL | 多模块 | ✅ 活跃 | 纯类型 |
| `unified-memory.ts` (523 行) | 层级记忆 + 衰减 + 提升 + 语义召回 | enhanced-agent-loop | ✅ 活跃 | |
| `context-memory.ts` (1343 行) | 工作记忆：50 轮上下文 + 实体消解 + 话题栈 + 8000 token 预算 | enhanced-agent-loop | ✅ 活跃 | L0 工作记忆 |
| `session-persistence.ts` (1638 行) | JSONL 会话日志 + 状态快照 + 恢复 | bootstrap.ts, corruption-guard | ✅ 活跃 | 跨会话连续性 |
| `self-learning-system.ts` (1039 行) | 学习记录 + 技能 + 知识 + 模式 + 衰减清理 | enhanced-agent-loop | ✅ 活跃 | 经验学习 |
| `knowledge-graph-memory.ts` | 知识图谱：跨领域关联 + 矛盾检测 | 有测试覆盖 | ✅ 活跃 | 关联推理 |
| `proactive-memory-injector.ts` | 主动注入：根据上下文预取相关记忆 | enhanced-agent-loop, unified-memory | ✅ 活跃 | 预取优化 |
| `hierarchical-memory.ts` | 层级分组 + 语义聚类 | — | ⚠️ 待确认 | 需 grep 调用点 |
| `virtual-memory-workflow.ts` | 虚拟记忆工作流编排 | bootstrap, advanced-tools, three-agent-orchestrator | ✅ 活跃 | |
| `session-memory-replay.ts` | 会话记忆回放 | bootstrap, corruption-guard | ✅ 活跃 | |

## 学习系统模块矩阵

| 模块 | 职责 | 活跃状态 |
|---|---|---|
| `self-learning-system.ts` | 核心学习：交互/错误/最佳实践/偏好 | ✅ |
| `tool-learning-system.ts` | 工具使用学习 | ✅ 有测试 |
| `reinforcement-learning.ts` | 强化学习 | ✅ 有测试 |
| `meta-learning.ts` | 元学习（学会学习） | ✅ 有测试 |
| `learning-engine.ts` | 外部知识集成 + 技能提取 | ✅ |
| `adaptive-learning.ts` | 自适应学习模式 | ✅ |
| `continuous-learning.ts` | 持续学习循环 | ✅ |
| `learning-eval-system.ts` | 学习评估 | ✅ 有测试 |

## 召回链路（Phase C1 目标）

**现状**：enhanced-agent-loop.ts 分散调用多个 memory 模块（context-memory / memory-orchestrator / self-learning / proactive-injector），无统一入口。

**目标**：`MemoryOrchestrator.recall(query)` 成为 Plan 阶段唯一记忆入口：

```
recall(query)
  ├─ context-memory.retrieve(query)        // L0 工作记忆
  ├─ memory-store.search(query)            // L1/L2 持久记忆
  ├─ knowledge-graph.related(query)        // 关联推理
  ├─ self-learning.getPatternContext(query) // 经验模式
  └─ proactive-injector.prefetch(query)     // 预取
  → RecallResult { entries, sources, latencyMs }
```

## 容量与衰减参数

| 层级 | 容量 | 衰减 |
|---|---|---|
| L0_SESSION (工作记忆) | 50 轮 / 8000 token | 1 小时半衰期 |
| L1_PERSISTENT | 无上限 | 7 天半衰期，访问延长 |
| L2_SKILL | 无上限 | 不衰减 |
| MemoryStore.SHORT_TERM | 50 条 | 30 分钟 TTL |
| MemoryStore.WORKING | 100 条 | — |
| MemoryStore.LONG_TERM | 500 条 | — |
| MemoryStore.PROCEDURAL | 200 条 | — |
| SelfLearning.knowledge | 500 条上限 | 7 天未用降置信度，超限淘汰最低分 |
| SelfLearning.records | — | confidence<0.15 且 >30 天 → 清理 |
