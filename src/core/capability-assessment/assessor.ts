/**
 * CapabilityAssessor — 统一能力评估器
 *
 * 职责：
 * 1. 遍历 10 维度的所有指标规格
 * 2. 对每个指标，按 source 分流取值：
 *    - 'suite'              → 运行对应维度的测试套件，聚合得分
 *    - 'evolution_metrics'  → 通过适配器从 EvolutionMetrics 拉取
 *    - 'learning_eval'      → 通过适配器从 LearningEvalSystem 拉取
 *    - 'memory_orchestrator'→ 通过适配器从 MemoryOrchestrator 拉取
 *    - 'new'                → 从 runtimeValues 取值（由代码埋点设置）
 * 3. 用 EvolutionMetrics 已验证公式计算 0-100 评分
 * 4. 聚合维度分 + 总分
 * 5. 持久化快照（baseline / current / manual）
 * 6. 与 baseline 对比产出 topImprovements / topRegressions
 *
 * 评分公式（与 EvolutionMetrics 一致）：
 *   higher-better:  score = min(100, min(current/target, 1.5) × 100)
 *   lower-better:   score = max(0, 100 - (current/target) × 50)
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { duanPath } from '../duan-paths.js';
import { CAPABILITY_DIMENSIONS, getMetricsByDimension } from './dimensions.js';
import { buildAdapters, fetchMetricValue } from './adapters.js';
import type { MetricSources } from './adapters.js';
import type {
  CapabilityDimensionId,
  CapabilityDimensionResult,
  CapabilityMetricResult,
  CapabilityMetricSpec,
  CapabilityReport,
  CapabilityTestSuite,
  CapabilityMetricSnapshot,
  MetricAdapter,
} from './types.js';

// ============ 评分公式（与 EvolutionMetrics 一致） ============

export function computeScore(spec: { target: number; lowerIsBetter: boolean }, value: number): number {
  if (spec.target <= 0) return 0;
  if (spec.lowerIsBetter) {
    return Math.max(0, 100 - (value / spec.target) * 50);
  }
  const achievementRate = Math.min(value / spec.target, 1.5);
  return Math.min(100, achievementRate * 100);
}

// ============ Assessor ============

export interface CapabilityAssessorConfig {
  sources?: MetricSources;
  /** 维度 → 测试套件（source='suite' 的指标从套件取值） */
  suites?: Partial<Record<CapabilityDimensionId, CapabilityTestSuite>>;
  /** 数据目录（默认 ~/.duan/capability-assessment/） */
  dataPath?: string;
}

export class CapabilityAssessor {
  private dataPath: string;
  private adapters: Map<string, MetricAdapter>;
  private suites: Partial<Record<CapabilityDimensionId, CapabilityTestSuite>>;
  /** runtime 埋点值（source='new' 的指标从此取） */
  private runtimeValues: Map<string, number> = new Map();
  /** 套件运行结果缓存（同一次评估内复用，避免重跑） */
  private suiteResultsCache: Map<CapabilityDimensionId, Array<{ caseId: string; score: number }>> = new Map();
  /** 套件运行失败原因（用于 skipped 明细，避免裸错误冒泡到 UI） */
  private suiteFailureReasons: Map<CapabilityDimensionId, string> = new Map();

  constructor(config: CapabilityAssessorConfig = {}) {
    this.dataPath = config.dataPath || duanPath('capability-assessment');
    this.adapters = buildAdapters(config.sources || {});
    this.suites = config.suites || {};
    this.loadData();
  }

  // ---------- 公共 API ----------

  /** 记录 source='new' 的指标值（由代码埋点调用） */
  recordRuntimeValue(metricId: string, value: number): void {
    this.runtimeValues.set(metricId, value);
  }

  /**
   * 运行一次完整评估
   */
  async runAssessment(label: 'baseline' | 'current' | 'manual' = 'current'): Promise<CapabilityReport> {
    const timestamp = Date.now();
    const dimensionResults: CapabilityDimensionResult[] = [];
    const skipped: Array<{ metricId: string; reason: string }> = [];

    // 按维度遍历
    for (const dimSpec of CAPABILITY_DIMENSIONS) {
      const metrics = getMetricsByDimension(dimSpec.id);
      const metricResults: CapabilityMetricResult[] = [];

      for (const spec of metrics) {
        const result = await this.measureMetric(spec);
        if (result.value === null || result.error) {
          skipped.push({ metricId: spec.id, reason: result.error || 'value-is-null' });
        } else {
          metricResults.push(result);
        }
      }

      // 维度分 = 加权平均
      const dimensionScore = this.aggregateDimensionScore(metricResults);
      dimensionResults.push({
        dimension: dimSpec.id,
        name: dimSpec.name,
        score: dimensionScore,
        weight: dimSpec.weight,
        metrics: metricResults,
      });
    }

    // 总分 = 维度加权平均
    const overallScore = this.aggregateOverallScore(dimensionResults);

    // 加载 baseline 做对比
    const baseline = label !== 'baseline' ? this.loadBaseline() : null;
    const { topImprovements, topRegressions } = this.compareToBaseline(
      dimensionResults,
      baseline?.dimensions || [],
    );
    const recommendations = this.generateRecommendations(dimensionResults, baseline);

    const report: CapabilityReport = {
      timestamp,
      label,
      overallScore,
      dimensions: dimensionResults,
      baseline,
      topImprovements,
      topRegressions,
      recommendations,
      skipped,
    };

    this.saveSnapshot(report, label);
    if (label === 'baseline') {
      this.persistBaselineReport(report);
    }
    this.saveLastReport(report);

    // 清理套件缓存
    this.suiteResultsCache.clear();
    this.suiteFailureReasons.clear();

    return report;
  }

  /** 保存 baseline 快照 */
  async saveBaseline(): Promise<CapabilityReport> {
    return this.runAssessment('baseline');
  }

  /** 加载 baseline */
  loadBaseline(): CapabilityReport | null {
    try {
      const file = path.join(this.dataPath, 'baseline.json');
      if (!fsSync.existsSync(file)) return null;
      return JSON.parse(fsSync.readFileSync(file, 'utf-8')) as CapabilityReport;
    } catch {
      return null;
    }
  }

  /** 加载上次报告 */
  loadLastReport(): CapabilityReport | null {
    try {
      const file = path.join(this.dataPath, 'last-report.json');
      if (!fsSync.existsSync(file)) return null;
      return JSON.parse(fsSync.readFileSync(file, 'utf-8')) as CapabilityReport;
    } catch {
      return null;
    }
  }

  /** 获取历史快照（趋势） */
  loadSnapshots(): CapabilityMetricSnapshot[] {
    try {
      const file = path.join(this.dataPath, 'snapshots.json');
      if (!fsSync.existsSync(file)) return [];
      return JSON.parse(fsSync.readFileSync(file, 'utf-8')) as CapabilityMetricSnapshot[];
    } catch {
      return [];
    }
  }

  // ---------- 内部方法 ----------

  /** 测量单个指标 */
  private async measureMetric(spec: CapabilityMetricSpec): Promise<CapabilityMetricResult> {
    let value: number | null = null;
    let sourceLabel: string = spec.source;
    let error: string | undefined;

    try {
      if (spec.source === 'suite') {
        value = await this.getSuiteMetricValue(spec);
        sourceLabel = `suite:${spec.dimension}`;
        if (value === null) {
          const failReason = this.suiteFailureReasons.get(spec.dimension);
          error = failReason
            ? `suite-run-failed (dimension='${spec.dimension}': ${failReason})`
            : `suite-not-configured (dimension='${spec.dimension}')`;
        }
      } else if (spec.source === 'new') {
        value = this.runtimeValues.has(spec.id) ? this.runtimeValues.get(spec.id)! : null;
        sourceLabel = `runtime:${spec.id}`;
        if (value === null) {
          error = `runtime-value-not-set (源='new' 的指标需先调用 recordRuntimeValue())`;
        }
      } else {
        // evolution_metrics / learning_eval / memory_orchestrator
        const fetched = await fetchMetricValue(this.adapters, spec.source, spec.adapterKey);
        value = fetched.value;
        sourceLabel = fetched.sourceLabel;
        if (value === null) {
          error = `adapter-unavailable (${fetched.sourceLabel})`;
        }
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
      value = null;
    }

    const score = value !== null ? computeScore(spec, value) : 0;

    return {
      spec,
      value: value ?? 0,
      score,
      source: sourceLabel,
      measuredAt: Date.now(),
      error,
    };
  }

  /**
   * 从测试套件取值：
   * 同维度的所有 source='suite' 指标共享一次套件运行结果，
   * 通过指标 id 映射到对应用例得分聚合
   *
   * 容错：套件运行失败（如依赖未就绪）时返回 null，指标被记为 skipped，
   * 不阻断维度其余指标或整体评估。
   */
  private async getSuiteMetricValue(spec: CapabilityMetricSpec): Promise<number | null> {
    const suite = this.suites[spec.dimension];
    if (!suite) {
      return null;
    }

    // 同维度套件只跑一次；失败则缓存空结果避免重试，并记录失败原因
    let results = this.suiteResultsCache.get(spec.dimension);
    if (!results) {
      try {
        const raw = await suite.run();
        results = raw.map(r => ({ caseId: r.caseId, score: r.score }));
      } catch (err: unknown) {
        // 套件运行失败（如 LLM/外部依赖未就绪）—— 不阻断整体评估
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[CapabilityAssessor] 套件 '${spec.dimension}' 运行失败，跳过该维度 suite 指标: ${reason}`);
        results = [];
        this.suiteFailureReasons.set(spec.dimension, reason);
      }
      this.suiteResultsCache.set(spec.dimension, results);
    }

    // 精细映射策略：优先用 caseId === spec.id 取对应用例得分；
    // 未命中则回退到维度均值（向后兼容旧 suite）。
    if (results.length === 0) return null;
    const exact = results.find(r => r.caseId === spec.id);
    if (exact) return exact.score;
    const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
    return avg;
  }

  /** 维度分 = 加权平均 */
  private aggregateDimensionScore(results: CapabilityMetricResult[]): number {
    let totalWeight = 0;
    let weighted = 0;
    for (const r of results) {
      weighted += r.score * r.spec.weight;
      totalWeight += r.spec.weight;
    }
    return totalWeight > 0 ? weighted / totalWeight : 0;
  }

  /** 总分 = 维度加权平均 */
  private aggregateOverallScore(dims: CapabilityDimensionResult[]): number {
    let totalWeight = 0;
    let weighted = 0;
    for (const d of dims) {
      weighted += d.score * d.weight;
      totalWeight += d.weight;
    }
    return totalWeight > 0 ? weighted / totalWeight : 0;
  }

  /** 与 baseline 对比 */
  private compareToBaseline(
    current: CapabilityDimensionResult[],
    baseline: CapabilityDimensionResult[],
  ): { topImprovements: CapabilityReport['topImprovements']; topRegressions: CapabilityReport['topRegressions'] } {
    if (baseline.length === 0) {
      return { topImprovements: [], topRegressions: [] };
    }
    const deltas: Array<{ metricId: string; metricName: string; delta: number }> = [];

    for (const dim of current) {
      const baseDim = baseline.find(b => b.dimension === dim.dimension);
      if (!baseDim) continue;
      const delta = dim.score - baseDim.score;
      deltas.push({
        metricId: dim.dimension,
        metricName: dim.name,
        delta,
      });
    }

    const sorted = [...deltas].sort((a, b) => b.delta - a.delta);
    return {
      topImprovements: sorted.filter(d => d.delta > 0).slice(0, 5),
      topRegressions: sorted.filter(d => d.delta < 0).slice(-5).reverse(),
    };
  }

  /** 生成建议 */
  private generateRecommendations(
    current: CapabilityDimensionResult[],
    baseline: CapabilityReport | null,
  ): string[] {
    const recs: string[] = [];
    const sorted = [...current].sort((a, b) => a.score - b.score);
    const lowest = sorted[0];
    if (lowest && lowest.score < 60) {
      recs.push(`优先提升${lowest.name}（当前 ${lowest.score.toFixed(1)}/100）`);
    }
    for (const dim of sorted.slice(0, 3)) {
      if (dim.score < 75) {
        recs.push(`关注${dim.name}：${dim.score.toFixed(1)}/100，目标 75+`);
      }
    }
    if (baseline && baseline.overallScore > 0) {
      const delta = current.reduce((s, d) => s + d.score * d.weight, 0) - baseline.overallScore;
      if (delta > 0) {
        recs.push(`总体较 baseline 提升 ${delta.toFixed(1)} 分`);
      } else if (delta < 0) {
        recs.push(`警告：总体较 baseline 下降 ${(-delta).toFixed(1)} 分，需排查回归`);
      }
    }
    return recs;
  }

  // ---------- 持久化 ----------

  private saveSnapshot(report: CapabilityReport, label: 'baseline' | 'current' | 'manual'): void {
    try {
      fsSync.mkdirSync(this.dataPath, { recursive: true });
      const snapshots = this.loadSnapshots();
      const snapshot: CapabilityMetricSnapshot = {
        timestamp: report.timestamp,
        label,
        overallScore: report.overallScore,
        dimensionScores: Object.fromEntries(
          report.dimensions.map(d => [d.dimension, d.score]),
        ) as Partial<Record<CapabilityDimensionId, number>>,
        metricValues: Object.fromEntries(
          report.dimensions.flatMap(d => d.metrics.map(m => [m.spec.id, m.value])),
        ),
      };
      snapshots.push(snapshot);
      if (snapshots.length > 200) {
        snapshots.splice(0, snapshots.length - 200);
      }
      fsSync.writeFileSync(
        path.join(this.dataPath, 'snapshots.json'),
        JSON.stringify(snapshots, null, 2),
        'utf-8',
      );
    } catch {
      // 持久化失败不阻断评估
    }
  }

  private persistBaselineReport(report: CapabilityReport): void {
    try {
      fsSync.mkdirSync(this.dataPath, { recursive: true });
      fsSync.writeFileSync(
        path.join(this.dataPath, 'baseline.json'),
        JSON.stringify(report, null, 2),
        'utf-8',
      );
    } catch {
      // 忽略
    }
  }

  private saveLastReport(report: CapabilityReport): void {
    try {
      fsSync.mkdirSync(this.dataPath, { recursive: true });
      fsSync.writeFileSync(
        path.join(this.dataPath, 'last-report.json'),
        JSON.stringify(report, null, 2),
        'utf-8',
      );
    } catch {
      // 忽略
    }
  }

  private loadData(): void {
    try {
      fsSync.mkdirSync(this.dataPath, { recursive: true });
    } catch {
      // 忽略
    }
  }
}
