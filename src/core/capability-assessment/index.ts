/**
 * 能力评估框架 — 统一入口（barrel export）
 *
 * 使用示例：
 *   import { CapabilityAssessor, recordRuntimeValue } from './capability-assessment/index.js';
 *   const assessor = new CapabilityAssessor({ sources: { evolutionMetrics, learningEval } });
 *   await assessor.runAssessment('baseline');
 */

export { CapabilityAssessor, computeScore } from './assessor.js';
export type { CapabilityAssessorConfig } from './assessor.js';
export {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_METRICS,
  DIMENSION_NAME,
  DIMENSION_WEIGHT,
  getMetricsByDimension,
  getMetricSpec,
} from './dimensions.js';
export {
  buildAdapters,
  fetchMetricValue,
} from './adapters.js';
export type { MetricSources, EvolutionMetricsLike, LearningEvalLike } from './adapters.js';
export {
  generateMarkdownReport,
  generateHtmlReport,
  writeMarkdownReport,
  writeHtmlReport,
} from './report-generator.js';
export {
  loadRuntimeValues,
  recordRuntimeValue,
  recordRuntimeValues,
  clearRuntimeValues,
  RUNTIME_VALUES_FILE,
} from './runtime-values.js';
export type {
  CapabilityDimensionId,
  CapabilityDimensionSpec,
  CapabilityMetricSpec,
  CapabilityMetricResult,
  CapabilityDimensionResult,
  CapabilityReport,
  CapabilityMetricSnapshot,
  CapabilityTestCase,
  CapabilityTestSuite,
  MetricAdapter,
  MetricSource,
} from './types.js';
