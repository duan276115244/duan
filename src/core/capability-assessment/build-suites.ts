/**
 * 集中收集所有已实现的 CapabilityTestSuite，供 web-server.ts / cli.ts 复用。
 *
 * 套件按维度注册，每个 suite 模块用 `export default` 导出 CapabilityTestSuite 实例。
 * 未实现的维度（execution/learning/self_iteration）不在此注册——
 * 它们的指标由 evolution_metrics / learning_eval 适配器覆盖（非 suite 源）。
 *
 * 套件覆盖实况（10 维度中 7 个有 suite）：
 *   thinking       — reasoning_depth / solution_validity / strategy_diversity
 *   memory         — recall_accuracy / context_coherence / recall_latency_ms
 *   self_repair    — error_detection_rate / fix_success_rate / regression_rate
 *   computer_ops   — op_success_rate / focus_recovery_rate / parallel_throughput
 *   code           — code_correctness / refactor_safety / debug_loop_success
 *   inference      — causal_accuracy / prediction_accuracy / counterfactual_validity
 *   cross_platform — sync_consistency / sync_latency_ms / pwa_installability / conflict_resolution_rate
 */

import type { CapabilityDimensionId, CapabilityTestSuite } from './types.js';
import thinkingSuite from './suites/thinking.suite.js';
import memorySuite from './suites/memory.suite.js';
import selfRepairSuite from './suites/self-repair.suite.js';
import computerOpsSuite from './suites/computer-ops.suite.js';
import codeSuite from './suites/code.suite.js';
import inferenceSuite from './suites/inference.suite.js';
import crossPlatformSuite from './suites/cross-platform.suite.js';

/**
 * 收集所有已实现的测试套件。
 * 返回 Partial<Record<CapabilityDimensionId, CapabilityTestSuite>>，
 * assessor 会按维度查找对应套件；未注册的维度的 suite 指标会被跳过。
 */
export function buildSuites(): Partial<Record<CapabilityDimensionId, CapabilityTestSuite>> {
  return {
    thinking: thinkingSuite,
    memory: memorySuite,
    self_repair: selfRepairSuite,
    computer_ops: computerOpsSuite,
    code: codeSuite,
    inference: inferenceSuite,
    cross_platform: crossPlatformSuite,
  };
}
