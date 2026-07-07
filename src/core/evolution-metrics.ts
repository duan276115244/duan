/**
 * 自我进化评估指标体系 - EvolutionMetrics
 *
 * 在现有 SelfAssessment 基础上，增加以下关键维度：
 * 1. 智能决策能力指标：规划质量、反思深度、策略适配度
 * 2. 自主进化能力指标：学习速度、知识增长率、经验回放效率
 * 3. 功能完整性指标：工具覆盖率、功能可用率、安全合规率
 * 4. 性能效率指标：响应延迟、token效率、任务完成效率
 *
 * 所有指标可量化、可追踪、可对比，形成完整的进化评估报告
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 指标类别 */
export type MetricCategory = 'intelligence' | 'evolution' | 'functionality' | 'performance' | 'reliability';

/** 指标级别 */
export type MetricLevel = 'critical' | 'important' | 'supplementary';


/** 趋势方向 */
export type TrendDirection = 'improving' | 'declining' | 'stable';

/** 单个指标 */
export interface EvolutionMetric {
  id: string;
  name: string;
  description: string;
  category: MetricCategory;
  level: MetricLevel;
  unit: string;
  target: number;
  currentValue: number;
  history: Array<{ timestamp: number; value: number }>;
  trend: TrendDirection;
  weight: number; // 在综合评分中的权重 0-1
  lastUpdated: number;
}

/** 评估报告 */
export interface EvolutionReport {
  timestamp: number;
  overallScore: number;           // 综合评分 0-100
  categoryScores: Record<MetricCategory, number>;
  criticalMetricsStatus: Array<{
    name: string;
    status: 'on_track' | 'at_risk' | 'off_track';
    value: number;
    target: number;
    gap: number;
  }>;
  topImprovements: string[];      // 最需要改进的方向
  evolutionVelocity: number;      // 进化速度（评分变化率）
  recommendations: string[];      // 改进建议
  comparisonWithLast: {           // 与上次报告对比
    overallDelta: number;
    improved: string[];
    declined: string[];
  };
}

/** 指标快照（用于对比） */
export interface MetricSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
  overallScore: number;
}

// ============ 自我进化评估指标体系 ============

export class EvolutionMetrics {
  private metrics: Map<string, EvolutionMetric> = new Map();
  private snapshots: MetricSnapshot[] = [];
  private dataPath: string;
  private lastReport: EvolutionReport | null = null;
  /** P0 修复: 跟踪已警告过的未知 key，每个只警告一次避免刷屏 */
  private _warnedUnknownMetrics: Set<string> = new Set();

  constructor(dataPath?: string) {
    this.dataPath = dataPath || duanPath('evolution-metrics');
    this.initializeMetrics();
    this.loadData();
  }

  /**
   * 记录指标值
   */
  record(metricId: string, value: number): void {
    const metric = this.metrics.get(metricId);
    if (!metric) {
      // P0 修复: 原 `if (!metric) return` 静默丢弃未知 key，导致进化评分从未积累
      // (self-evolution-engine.ts 曾用 camelCase key 'learningVelocity' 调用，全部被丢弃)
      // 现加防御日志，每个未知 key 只警告一次，避免刷屏
      if (!this._warnedUnknownMetrics.has(metricId)) {
        this._warnedUnknownMetrics.add(metricId);
        console.warn(`[EvolutionMetrics] 未知指标 key 被丢弃: '${metricId}'。已知 key: plan_quality, reflection_depth, strategy_adaptation, decision_accuracy, learning_velocity, knowledge_growth, experience_replay_efficiency, error_avoidance_rate, tool_coverage, feature_availability, response_latency, token_efficiency, task_completion_efficiency, task_completion_rate, error_rate, doom_loop_rate`);
      }
      return;
    }

    metric.currentValue = value;
    metric.history.push({ timestamp: Date.now(), value });
    // 保留最近200个历史记录
    if (metric.history.length > 200) {
      metric.history = metric.history.slice(-200);
    }
    metric.lastUpdated = Date.now();
    metric.trend = this.calculateTrend(metric);

    this.saveData();
  }

  /**
   * 批量记录
   */
  recordBatch(values: Record<string, number>): void {
    for (const [id, value] of Object.entries(values)) {
      this.record(id, value);
    }
  }

  // ===== P0 运行时指标（source='new'）— read-and-reset delta + 50 样本滚动窗口 =====
  // Hard Constraint: source='new' 指标须用 read-and-reset delta 维护 50 样本滚动平均；
  // 直接 recordRuntimeValue() 仅限 regression_rate / improvement_velocity。
  // 5 个指标：on_time_completion_rate / quality_gate_pass_rate / gap_probing_rate（delta）
  //          improvement_velocity / regression_rate（direct）
  private _runtimeDeltas: Map<string, number> = new Map();
  private _runtimeSamples: Map<string, number[]> = new Map();
  private static readonly RUNTIME_WINDOW = 50;

  /**
   * 运行时指标记录（source='new'）。
   * @param mode 'delta' — 累加增量，由 flushRuntimeDeltas() 读取并清零后推入滚动窗口；
   *             'direct' — 直接推入滚动窗口（仅 regression_rate / improvement_velocity）
   */
  recordRuntimeValue(metricId: string, value: number, mode: 'delta' | 'direct' = 'delta'): void {
    if (mode === 'direct') {
      this._pushRuntimeSample(metricId, value);
      return;
    }
    this._runtimeDeltas.set(metricId, (this._runtimeDeltas.get(metricId) ?? 0) + value);
  }

  /**
   * 读取并清零所有 delta 计数器，将当前值推入滚动窗口。
   * 应在任务终止边界调用（每个任务 = 一个样本），以维护 50 任务滚动平均。
   * @returns 本次 flush 的 delta 快照 { metricId: value }
   */
  flushRuntimeDeltas(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, v] of this._runtimeDeltas) {
      out[id] = v;
      this._pushRuntimeSample(id, v);
    }
    this._runtimeDeltas.clear();
    return out;
  }

  /** 获取运行时指标的滚动平均（50 样本窗口）；无样本返回 0 */
  getRuntimeAverage(metricId: string): number {
    const samples = this._runtimeSamples.get(metricId);
    if (!samples || samples.length === 0) return 0;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  /** 获取运行时指标的当前样本数（用于诊断/测试） */
  getRuntimeSampleCount(metricId: string): number {
    return this._runtimeSamples.get(metricId)?.length ?? 0;
  }

  private _pushRuntimeSample(id: string, v: number): void {
    const arr = this._runtimeSamples.get(id) ?? [];
    arr.push(v);
    if (arr.length > EvolutionMetrics.RUNTIME_WINDOW) arr.shift();
    this._runtimeSamples.set(id, arr);
  }

  /**
   * 获取指标
   */
  getMetric(id: string): EvolutionMetric | undefined {
    return this.metrics.get(id);
  }

  /**
   * 获取所有指标
   */
  getAllMetrics(): EvolutionMetric[] {
    return Array.from(this.metrics.values());
  }

  /**
   * 按类别获取指标
   */
  getMetricsByCategory(category: MetricCategory): EvolutionMetric[] {
    return Array.from(this.metrics.values()).filter(m => m.category === category);
  }

  /**
   * 生成评估报告
   */
  generateReport(): EvolutionReport {
    const now = Date.now();

    // 计算各类别评分
    const categoryScores: Record<MetricCategory, number> = {
      intelligence: 0,
      evolution: 0,
      functionality: 0,
      performance: 0,
      reliability: 0,
    };

    for (const category of Object.keys(categoryScores) as MetricCategory[]) {
      categoryScores[category] = this.calculateCategoryScore(category);
    }

    // 计算综合评分
    const overallScore = this.calculateOverallScore(categoryScores);

    // 关键指标状态
    const criticalMetricsStatus = Array.from(this.metrics.values())
      .filter(m => m.level === 'critical')
      .map(m => {
        const achievementRate = m.target > 0 ? (m.currentValue / m.target) * 100 : 0;
        const gap = m.currentValue - m.target;
        let status: 'on_track' | 'at_risk' | 'off_track';
        if (achievementRate >= 90) status = 'on_track';
        else if (achievementRate >= 70) status = 'at_risk';
        else status = 'off_track';
        return { name: m.name, status, value: m.currentValue, target: m.target, gap };
      });

    // 改进方向
    const topImprovements = this.identifyTopImprovements();

    // 进化速度
    const evolutionVelocity = this.calculateEvolutionVelocity();

    // 改进建议
    const recommendations = this.generateRecommendations(categoryScores, criticalMetricsStatus);

    // 与上次对比
    const comparisonWithLast = this.compareWithLastReport(overallScore);

    const report: EvolutionReport = {
      timestamp: now,
      overallScore,
      categoryScores,
      criticalMetricsStatus,
      topImprovements,
      evolutionVelocity,
      recommendations,
      comparisonWithLast,
    };

    // 保存快照
    const snapshot: MetricSnapshot = {
      timestamp: now,
      metrics: Object.fromEntries(
        Array.from(this.metrics.entries()).map(([id, m]) => [id, m.currentValue])
      ),
      overallScore,
    };
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 100) {
      this.snapshots = this.snapshots.slice(-100);
    }

    this.lastReport = report;
    this.saveData();

    return report;
  }

  /**
   * 获取上次报告
   */
  getLastReport(): EvolutionReport | null {
    return this.lastReport;
  }

  /**
   * 获取格式化的报告文本
   */
  formatReport(report?: EvolutionReport): string {
    const r = report || this.lastReport;
    if (!r) return '暂无评估报告';

    const lines: string[] = [
      `=== 自我进化评估报告 ===`,
      `时间: ${new Date(r.timestamp).toLocaleString('zh-CN')}`,
      ``,
      `综合评分: ${r.overallScore.toFixed(1)}/100`,
      ``,
      `--- 类别评分 ---`,
      `  智能决策: ${r.categoryScores.intelligence.toFixed(1)}`,
      `  自主进化: ${r.categoryScores.evolution.toFixed(1)}`,
      `  功能完整: ${r.categoryScores.functionality.toFixed(1)}`,
      `  性能效率: ${r.categoryScores.performance.toFixed(1)}`,
      `  可靠性:   ${r.categoryScores.reliability.toFixed(1)}`,
      ``,
      `--- 关键指标状态 ---`,
    ];

    for (const m of r.criticalMetricsStatus) {
      let icon: string;
      if (m.status === 'on_track') {
        icon = '✓';
      } else if (m.status === 'at_risk') {
        icon = '⚠';
      } else {
        icon = '✗';
      }
      lines.push(`  ${icon} ${m.name}: ${m.value.toFixed(1)} (目标: ${m.target}, 差距: ${m.gap > 0 ? '+' : ''}${m.gap.toFixed(1)})`);
    }

    if (r.topImprovements.length > 0) {
      lines.push('', '--- 优先改进方向 ---');
      for (const imp of r.topImprovements) {
        lines.push(`  → ${imp}`);
      }
    }

    if (r.recommendations.length > 0) {
      lines.push('', '--- 改进建议 ---');
      for (const rec of r.recommendations) {
        lines.push(`  • ${rec}`);
      }
    }

    lines.push('', `进化速度: ${r.evolutionVelocity > 0 ? '+' : ''}${r.evolutionVelocity.toFixed(2)} 分/天`);

    if (r.comparisonWithLast.overallDelta !== 0) {
      const delta = r.comparisonWithLast.overallDelta;
      lines.push(`与上次对比: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}`);
    }

    return lines.join('\n');
  }

  // ========== 私有方法 ==========

  private initializeMetrics(): void {
    const metrics: EvolutionMetric[] = [
      // ===== 智能决策能力 (intelligence) =====
      {
        id: 'plan_quality',
        name: '规划质量',
        description: '任务规划步骤的合理性和完整性',
        category: 'intelligence',
        level: 'critical',
        unit: '%',
        target: 85,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.15,
        lastUpdated: 0,
      },
      {
        id: 'reflection_depth',
        name: '反思深度',
        description: '执行后反思提取的有效经验比例',
        category: 'intelligence',
        level: 'important',
        unit: '%',
        target: 70,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.10,
        lastUpdated: 0,
      },
      {
        id: 'strategy_adaptation',
        name: '策略适配度',
        description: '策略切换后任务成功率提升幅度',
        category: 'intelligence',
        level: 'important',
        unit: '%',
        target: 80,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.10,
        lastUpdated: 0,
      },
      {
        id: 'decision_accuracy',
        name: '决策准确率',
        description: '工具调用成功且有效的比例',
        category: 'intelligence',
        level: 'critical',
        unit: '%',
        target: 90,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.15,
        lastUpdated: 0,
      },

      // ===== 自主进化能力 (evolution) =====
      {
        id: 'learning_velocity',
        name: '学习速度',
        description: '每日新增有效经验数',
        category: 'evolution',
        level: 'critical',
        unit: '条/天',
        target: 5,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.12,
        lastUpdated: 0,
      },
      {
        id: 'knowledge_growth',
        name: '知识增长率',
        description: '知识图谱每日新增实体/关系数',
        category: 'evolution',
        level: 'important',
        unit: '个/天',
        target: 3,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.08,
        lastUpdated: 0,
      },
      {
        id: 'experience_replay_efficiency',
        name: '经验回放效率',
        description: '回放后决策改善的比例',
        category: 'evolution',
        level: 'important',
        unit: '%',
        target: 60,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.08,
        lastUpdated: 0,
      },
      {
        id: 'error_avoidance_rate',
        name: '错误避免率',
        description: '因学习经验而避免重复错误的比例',
        category: 'evolution',
        level: 'critical',
        unit: '%',
        target: 70,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.10,
        lastUpdated: 0,
      },

      // ===== 功能完整性 (functionality) =====
      {
        id: 'tool_coverage',
        name: '工具覆盖率',
        description: '可用工具占设计规格的比例',
        category: 'functionality',
        level: 'important',
        unit: '%',
        target: 95,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.05,
        lastUpdated: 0,
      },
      {
        id: 'feature_availability',
        name: '功能可用率',
        description: '功能模块正常运行的比例',
        category: 'functionality',
        level: 'critical',
        unit: '%',
        target: 95,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.05,
        lastUpdated: 0,
      },

      // ===== 性能效率 (performance) =====
      {
        id: 'response_latency',
        name: '响应延迟',
        description: '从接收输入到开始输出的平均时间',
        category: 'performance',
        level: 'important',
        unit: 'ms',
        target: 3000,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.05,
        lastUpdated: 0,
      },
      {
        id: 'token_efficiency',
        name: 'Token效率',
        description: '有效输出token占总消耗token的比例',
        category: 'performance',
        level: 'supplementary',
        unit: '%',
        target: 60,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.03,
        lastUpdated: 0,
      },
      {
        id: 'task_completion_efficiency',
        name: '任务完成效率',
        description: '实际轮次/预估轮次比率（越低越好）',
        category: 'performance',
        level: 'important',
        unit: '比率',
        target: 1.2,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.05,
        lastUpdated: 0,
      },

      // ===== 可靠性 (reliability) =====
      {
        id: 'task_completion_rate',
        name: '任务完成率',
        description: '成功完成任务的比例',
        category: 'reliability',
        level: 'critical',
        unit: '%',
        target: 90,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.12,
        lastUpdated: 0,
      },
      {
        id: 'error_rate',
        name: '错误率',
        description: '执行中的错误比例（越低越好）',
        category: 'reliability',
        level: 'critical',
        unit: '%',
        target: 10,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.10,
        lastUpdated: 0,
      },
      {
        id: 'doom_loop_rate',
        name: '死循环率',
        description: '检测到死循环的频率（越低越好）',
        category: 'reliability',
        level: 'important',
        unit: '%',
        target: 5,
        currentValue: 0,
        history: [],
        trend: 'stable',
        weight: 0.05,
        lastUpdated: 0,
      },
    ];

    for (const m of metrics) {
      this.metrics.set(m.id, m);
    }
  }

  /**
   * 计算类别评分
   */
  private calculateCategoryScore(category: MetricCategory): number {
    const categoryMetrics = Array.from(this.metrics.values())
      .filter(m => m.category === category);

    if (categoryMetrics.length === 0) return 0;

    let totalWeight = 0;
    let weightedScore = 0;

    for (const m of categoryMetrics) {
      const achievementRate = m.target > 0 ? Math.min(m.currentValue / m.target, 1.5) : 0;
      // 对于"越低越好"的指标（error_rate, doom_loop_rate, response_latency, task_completion_efficiency）
      const isLowerBetter = ['error_rate', 'doom_loop_rate', 'response_latency', 'task_completion_efficiency'].includes(m.id);
      const score = isLowerBetter
        ? Math.max(0, 100 - (m.currentValue / m.target) * 50)
        : Math.min(100, achievementRate * 100);

      weightedScore += score * m.weight;
      totalWeight += m.weight;
    }

    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }

  /**
   * 计算综合评分
   */
  private calculateOverallScore(categoryScores: Record<MetricCategory, number>): number {
    const weights: Record<MetricCategory, number> = {
      intelligence: 0.30,
      evolution: 0.25,
      functionality: 0.15,
      performance: 0.15,
      reliability: 0.15,
    };

    let total = 0;
    for (const [category, weight] of Object.entries(weights)) {
      total += categoryScores[category as MetricCategory] * weight;
    }

    return total;
  }

  /**
   * 计算趋势
   */
  private calculateTrend(metric: EvolutionMetric): TrendDirection {
    if (metric.history.length < 3) return 'stable';

    const recent = metric.history.slice(-5);
    const values = recent.map(h => h.value);

    // 简单线性趋势
    const firstHalf = values.slice(0, Math.ceil(values.length / 2));
    const secondHalf = values.slice(Math.ceil(values.length / 2));

    const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

    const changeRate = avgFirst > 0 ? (avgSecond - avgFirst) / avgFirst : 0;

    // 对于"越低越好"的指标，下降是改善
    const isLowerBetter = ['error_rate', 'doom_loop_rate', 'response_latency', 'task_completion_efficiency'].includes(metric.id);

    if (Math.abs(changeRate) < 0.05) return 'stable';
    if (changeRate > 0) return isLowerBetter ? 'declining' : 'improving';
    return isLowerBetter ? 'improving' : 'declining';
  }

  /**
   * 识别优先改进方向
   */
  private identifyTopImprovements(): string[] {
    const improvements: Array<{ name: string; gap: number; level: MetricLevel }> = [];

    for (const m of this.metrics.values()) {
      const isLowerBetter = ['error_rate', 'doom_loop_rate', 'response_latency', 'task_completion_efficiency'].includes(m.id);
      const gap = isLowerBetter
        ? m.currentValue - m.target
        : m.target - m.currentValue;

      if (gap > 0) {
        improvements.push({ name: m.name, gap, level: m.level });
      }
    }

    return improvements
      .sort((a, b) => {
        // critical优先，然后按差距大小
        if (a.level === 'critical' && b.level !== 'critical') return -1;
        if (a.level !== 'critical' && b.level === 'critical') return 1;
        return b.gap - a.gap;
      })
      .slice(0, 5)
      .map(i => `${i.name} (差距: ${i.gap.toFixed(1)})`);
  }

  /**
   * 计算进化速度
   */
  private calculateEvolutionVelocity(): number {
    if (this.snapshots.length < 2) return 0;

    const recent = this.snapshots.slice(-2);
    const first = recent[0];
    const last = recent[recent.length - 1];

    const daysDiff = (last.timestamp - first.timestamp) / (24 * 3600 * 1000);
    if (daysDiff === 0) return 0;

    return (last.overallScore - first.overallScore) / daysDiff;
  }

  /**
   * 生成改进建议
   */
  private generateRecommendations(
    categoryScores: Record<MetricCategory, number>,
    criticalStatus: EvolutionReport['criticalMetricsStatus'],
  ): string[] {
    const recommendations: string[] = [];

    // 基于类别评分
    const lowestCategory = (Object.entries(categoryScores) as [MetricCategory, number][])
      .sort(([, a], [, b]) => a - b)[0];

    const categoryNames: Record<MetricCategory, string> = {
      intelligence: '智能决策',
      evolution: '自主进化',
      functionality: '功能完整',
      performance: '性能效率',
      reliability: '可靠性',
    };

    if (lowestCategory[1] < 60) {
      recommendations.push(`优先提升${categoryNames[lowestCategory[0]]}能力（当前评分: ${lowestCategory[1].toFixed(1)}）`);
    }

    // 基于关键指标
    const offTrack = criticalStatus.filter(m => m.status === 'off_track');
    for (const m of offTrack.slice(0, 3)) {
      recommendations.push(`紧急: ${m.name}严重偏离目标，当前${m.value.toFixed(1)}，目标${m.target}`);
    }

    // 基于趋势
    const declining = Array.from(this.metrics.values())
      .filter(m => m.trend === 'declining' && m.level !== 'supplementary');
    for (const m of declining.slice(0, 2)) {
      recommendations.push(`关注: ${m.name}呈下降趋势，需要分析原因`);
    }

    return recommendations;
  }

  /**
   * 与上次报告对比
   */
  private compareWithLastReport(currentScore: number): EvolutionReport['comparisonWithLast'] {
    if (!this.lastReport) {
      return { overallDelta: 0, improved: [], declined: [] };
    }

    const improved: string[] = [];
    const declined: string[] = [];

    for (const m of this.metrics.values()) {
      const lastMetric = this.lastReport.criticalMetricsStatus.find(c => c.name === m.name);
      if (lastMetric) {
        const isLowerBetter = ['error_rate', 'doom_loop_rate', 'response_latency', 'task_completion_efficiency'].includes(m.id);
        if (isLowerBetter) {
          if (m.currentValue < lastMetric.value) improved.push(m.name);
          else if (m.currentValue > lastMetric.value) declined.push(m.name);
        } else {
          if (m.currentValue > lastMetric.value) improved.push(m.name);
          else if (m.currentValue < lastMetric.value) declined.push(m.name);
        }
      }
    }

    return {
      overallDelta: currentScore - this.lastReport.overallScore,
      improved,
      declined,
    };
  }

  // ========== 持久化 ==========

  private loadData(): void {
    try {
      fsSync.mkdirSync(this.dataPath, { recursive: true });

      const metricsFile = path.join(this.dataPath, 'metrics.json');
      if (fsSync.existsSync(metricsFile)) {
        const data = JSON.parse(fsSync.readFileSync(metricsFile, 'utf-8'));
        for (const [id, metricData] of Object.entries(data)) {
          const metric = this.metrics.get(id);
          if (metric) {
            Object.assign(metric, metricData);
          }
        }
      }

      const snapshotsFile = path.join(this.dataPath, 'snapshots.json');
      if (fsSync.existsSync(snapshotsFile)) {
        this.snapshots = JSON.parse(fsSync.readFileSync(snapshotsFile, 'utf-8'));
      }

      const reportFile = path.join(this.dataPath, 'last-report.json');
      if (fsSync.existsSync(reportFile)) {
        this.lastReport = JSON.parse(fsSync.readFileSync(reportFile, 'utf-8'));
      }
    } catch {
      // 加载失败使用默认值
    }
  }

  private saveData(): void {
    try {
      fsSync.mkdirSync(this.dataPath, { recursive: true });

      const metricsData: Record<string, unknown> = {};
      for (const [id, m] of this.metrics.entries()) {
        metricsData[id] = {
          currentValue: m.currentValue,
          history: m.history.slice(-200),
          trend: m.trend,
          lastUpdated: m.lastUpdated,
        };
      }

      // 原子写：指标数据是能力评估的依据，损坏会导致评估失真
      atomicWriteJsonSync(
        path.join(this.dataPath, 'metrics.json'),
        metricsData,
      );

      atomicWriteJsonSync(
        path.join(this.dataPath, 'snapshots.json'),
        this.snapshots.slice(-100),
      );

      if (this.lastReport) {
        atomicWriteJsonSync(
          path.join(this.dataPath, 'last-report.json'),
          this.lastReport,
        );
      }
    } catch {
      // 保存失败不影响运行
    }
  }
}
