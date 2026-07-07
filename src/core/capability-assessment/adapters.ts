/**
 * 适配器层 — 从 6 个现有评估系统只读拉取指标值
 *
 * 设计原则：
 * - 非破坏性：现有系统继续运行，本层只读
 * - 优雅降级：单个系统不可用或抛错时返回 null，不阻断整体评估
 * - 显式注入：所有系统实例通过 MetricSources 显式传入（可选）
 *
 * 适配器不修改任何现有系统状态。
 */

import type { MetricAdapter } from './types.js';

// ============ 现有系统类型（最小接口，避免强耦合） ============

/** EvolutionMetrics 最小接口（实际类在 src/core/evolution-metrics.ts） */
export interface EvolutionMetricsLike {
  getMetric(id: string): { currentValue: number } | undefined;
  getLastReport(): { overallScore: number } | null;
}

/** LearningEvalSystem 最小接口（实际类在 src/core/learning-eval-system.ts） */
export interface LearningEvalLike {
  getAccuracy(): number;
  generateReport(): LearningEvalReportLike;
}

/** LearningEvalSystem.generateReport() 返回的最小结构 */
export interface LearningEvalReportLike {
  overallScore: number;
  accuracy: number;
  accuracyTarget: number;
  accuracyMet: boolean;
  dimensionScores: Partial<Record<'accuracy' | 'efficiency' | 'coverage' | 'retention' | 'adaptation', number>>;
  trend: 'improving' | 'stable' | 'declining';
  velocity: number;
  abTests: unknown[];
  warnings: string[];
}

/** MemoryOrchestrator 最小接口（用于 recall_latency） */
export interface MemoryOrchestratorLike {
  /** 如果实际类暴露了延迟统计则用，否则适配器返回 null */
  getStats?(): { avgLatencyMs?: number };
}

/** SelfAssessment 最小接口（实际类在 src/core/self-assessment.ts） */
export interface SelfAssessmentLike {
  generateReport(): { overall: number };
}

/** Benchmark 最小接口（实际类在 src/core/benchmark.ts） */
export interface BenchmarkLike {
  getSnapshots(): Array<{ summary: { passRate: number; avgResponseTime: number } }>;
}

/** 所有可用数据源（全部可选，缺失时优雅降级） */
export interface MetricSources {
  evolutionMetrics?: EvolutionMetricsLike;
  learningEval?: LearningEvalLike;
  memoryOrchestrator?: MemoryOrchestratorLike;
  selfAssessment?: SelfAssessmentLike;
  benchmark?: BenchmarkLike;
}

// ============ 适配器实现 ============

/**
 * EvolutionMetrics 适配器
 *
 * adapterKey 约定：
 * - '__overall__' → 取 getLastReport().overallScore（D7 evolution_score）
 * - 其他 → 取 getMetric(adapterKey).currentValue
 */
class EvolutionMetricsAdapter implements MetricAdapter {
  name = 'evolution_metrics';
  constructor(private src: EvolutionMetricsLike) {}

  availableMetrics(): string[] {
    // EvolutionMetrics 已知 16 指标 + __overall__
    return [
      'plan_quality', 'reflection_depth', 'strategy_adaptation', 'decision_accuracy',
      'learning_velocity', 'knowledge_growth', 'experience_replay_efficiency', 'error_avoidance_rate',
      'tool_coverage', 'feature_availability',
      'response_latency', 'token_efficiency', 'task_completion_efficiency',
      'task_completion_rate', 'error_rate', 'doom_loop_rate',
      '__overall__',
    ];
  }

  async getMetricValue(metricId: string): Promise<number | null> {
    try {
      if (metricId === '__overall__') {
        const report = this.src.getLastReport();
        return report ? report.overallScore : null;
      }
      const m = this.src.getMetric(metricId);
      return m ? m.currentValue : null;
    } catch {
      return null;
    }
  }
}

/**
 * LearningEvalSystem 适配器
 *
 * adapterKey 取 dimensionScores 中的一个维度键：
 * - 'accuracy' | 'efficiency' | 'coverage' | 'retention' | 'adaptation'
 * - 'overall' → generateReport().overallScore
 * - 'getAccuracy' → getAccuracy()
 */
class LearningEvalAdapter implements MetricAdapter {
  name = 'learning_eval';
  constructor(private src: LearningEvalLike) {}

  availableMetrics(): string[] {
    return ['accuracy', 'efficiency', 'coverage', 'retention', 'adaptation', 'overall', 'getAccuracy'];
  }

  async getMetricValue(metricId: string): Promise<number | null> {
    try {
      if (metricId === 'getAccuracy') {
        return this.src.getAccuracy();
      }
      const report = this.src.generateReport();
      if (metricId === 'overall') {
        return report.overallScore ?? null;
      }
      const val = report.dimensionScores[metricId as 'accuracy'];
      return typeof val === 'number' ? val : null;
    } catch {
      return null;
    }
  }
}

/**
 * MemoryOrchestrator 适配器（仅用于 recall_latency）
 */
class MemoryOrchestratorAdapter implements MetricAdapter {
  name = 'memory_orchestrator';
  constructor(private src: MemoryOrchestratorLike) {}

  availableMetrics(): string[] {
    return ['recall_latency_ms'];
  }

  async getMetricValue(metricId: string): Promise<number | null> {
    try {
      if (metricId !== 'recall_latency_ms') return null;
      if (typeof this.src.getStats !== 'function') return null;
      const stats = this.src.getStats();
      return stats?.avgLatencyMs ?? null;
    } catch {
      return null;
    }
  }
}

// ============ 适配器注册表 ============

/**
 * 根据可用数据源构建适配器映射表
 *
 * @returns Map<source, MetricAdapter> 仅包含可用系统
 */
export function buildAdapters(sources: MetricSources): Map<string, MetricAdapter> {
  const map = new Map<string, MetricAdapter>();
  if (sources.evolutionMetrics) {
    map.set('evolution_metrics', new EvolutionMetricsAdapter(sources.evolutionMetrics));
  }
  if (sources.learningEval) {
    map.set('learning_eval', new LearningEvalAdapter(sources.learningEval));
  }
  if (sources.memoryOrchestrator) {
    map.set('memory_orchestrator', new MemoryOrchestratorAdapter(sources.memoryOrchestrator));
  }
  return map;
}

/**
 * 通过指标规格的 source + adapterKey 拉取值
 *
 * @returns 数值或 null（缺失/失败）
 */
export async function fetchMetricValue(
  adapters: Map<string, MetricAdapter>,
  source: string,
  adapterKey: string | undefined,
): Promise<{ value: number | null; sourceLabel: string }> {
  if (!adapterKey) return { value: null, sourceLabel: 'no-adapter-key' };
  const adapter = adapters.get(source);
  if (!adapter) return { value: null, sourceLabel: `adapter-${source}-unavailable` };
  const value = await adapter.getMetricValue(adapterKey);
  return { value, sourceLabel: `${adapter.name}:${adapterKey}` };
}
