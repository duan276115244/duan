/**
 * 记忆系统共享类型 — 单一来源
 *
 * 消除 HermesMemoryTier 在 memory-orchestrator / memory-store /
 * context-memory / proactive-memory-injector 四处的重复定义。
 *
 * 各原定义站点改为 `import { HermesMemoryTier } from './memory-types.js'`；
 * memory-orchestrator 额外 re-export 以保持向后兼容。
 */

/** Hermes 三级记忆层级 */
export enum HermesMemoryTier {
  /** L0 会话级：短期，当前对话上下文 */
  L0_SESSION = 'L0',
  /** L1 持久级：中期，用户偏好/项目知识（90 天有效期） */
  L1_PERSISTENT = 'L1',
  /** L2 技能级：长期，可复用 SOP */
  L2_SKILL = 'L2',
}
