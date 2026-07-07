/**
 * 学习效率评估系统 — LearningEvalSystem
 *
 * 统一采集各学习子系统的评估指标，建立学习效率评估指标体系，
 * 确保系统知识更新准确率达到 90%+，能力提升效果通过 A/B 测试量化验证。
 *
 * 核心能力：
 * - 统一采集：从 SelfLearningSystem / ContinuousLearning / FeedbackReward 等采集指标
 * - 效率评估：知识更新准确率、学习速度、保留率、覆盖率的加权综合评分
 * - A/B 测试验证：对学习策略/模型变体进行对比测试
 * - 达标检测：90% 准确率目标追踪与预警
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

const DEFAULT_EVAL_DIR = duanPath('eval-metrics');

export type EvalDimension = 'accuracy' | 'efficiency' | 'coverage' | 'retention' | 'adaptation';

export interface EvalSnapshot {
  timestamp: number;
  dimensions: Partial<Record<EvalDimension, number>>;
  overall: number;
  sampleSize: number;
  source: string;
}

export interface ABTestConfig {
  id: string;
  variantA: string;
  variantB: string;
  dimension: EvalDimension;
  minSampleSize: number;
  startedAt: number;
  resultsA: number[];
  resultsB: number[];
  completedAt?: number;
  winner?: 'A' | 'B' | 'tie';
  effectSize?: number;
  confidence?: number;
}

export interface LearningEvalReport {
  accuracy: number;
  accuracyTarget: number;
  accuracyMet: boolean;
  overallScore: number;
  dimensionScores: Partial<Record<EvalDimension, number>>;
  abTests: ABTestConfig[];
  trend: 'improving' | 'stable' | 'declining';
  velocity: number;
  warnings: string[];
}

export interface LearningEvalSystemOptions {
  /** Skip loading persisted state on construction (for tests). Default: false */
  load?: boolean;
  /** Disable the periodic persist interval (for tests). Default: false */
  persist?: boolean;
  /** 自定义数据目录（用于测试注入） */
  dataDir?: string;
}

export class LearningEvalSystem {
  private log = logger.child({ module: 'LearningEvalSystem' });
  private snapshots: EvalSnapshot[] = [];
  private abTests: Map<string, ABTestConfig> = new Map();
  private readonly ACCURACY_TARGET = 0.90;
  private readonly MAX_SNAPSHOTS = 1000;
  private readonly PERSIST_INTERVAL = 5 * 60 * 1000;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  /** 持久化目录（支持依赖注入） */
  private readonly evalDir: string;

  constructor(options: LearningEvalSystemOptions = {}) {
    this.evalDir = options.dataDir
      ? path.join(options.dataDir, 'eval-metrics')
      : DEFAULT_EVAL_DIR;
    fs.mkdirSync(this.evalDir, { recursive: true });
    if (options.load !== false) {
      this.loadState();
    }
    if (options.persist !== false) {
      this.persistTimer = setInterval(() => this.persistState(), this.PERSIST_INTERVAL);
      // Don't keep the Node process alive solely for this timer
      this.persistTimer.unref?.();
    }
  }

  /** Clear periodic timer and release resources. Safe to call multiple times. */
  dispose(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  recordSnapshot(dimensions: Partial<Record<EvalDimension, number>>, source: string, sampleSize: number): EvalSnapshot {
    const dims = Object.keys(dimensions) as EvalDimension[];
    const avg = dims.reduce((s, d) => s + (dimensions[d] || 0), 0);
    const snapshot: EvalSnapshot = {
      timestamp: Date.now(),
      dimensions,
      overall: dims.length > 0 ? avg / dims.length : 0,
      sampleSize,
      source,
    };
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-this.MAX_SNAPSHOTS);
    }
    EventBus.getInstance().emit('eval.snapshot', snapshot, { source: 'LearningEvalSystem' }).catch(() => {});
    this.log.info('学习评估快照', { overall: snapshot.overall, source, dimensions });
    return snapshot;
  }

  getAccuracy(): number {
    const recent = this.snapshots.slice(-50);
    if (recent.length === 0) return 0;
    const accuracyScores = recent
      .filter(s => s.dimensions.accuracy !== undefined)
      .map(s => s.dimensions.accuracy!);
    if (accuracyScores.length === 0) return 0;
    return accuracyScores.reduce((a, b) => a + b, 0) / accuracyScores.length;
  }

  isAccuracyTargetMet(): boolean {
    return this.getAccuracy() >= this.ACCURACY_TARGET;
  }

  createABTest(config: Omit<ABTestConfig, 'startedAt' | 'resultsA' | 'resultsB'>): ABTestConfig {
    const test: ABTestConfig = {
      ...config,
      startedAt: Date.now(),
      resultsA: [],
      resultsB: [],
    };
    this.abTests.set(test.id, test);
    this.log.info('A/B 测试创建', { id: test.id, dimension: test.dimension, variantA: test.variantA, variantB: test.variantB });
    return test;
  }

  recordABResult(testId: string, variant: 'A' | 'B', score: number): void {
    const test = this.abTests.get(testId);
    if (!test) return;
    if (variant === 'A') test.resultsA.push(score);
    else test.resultsB.push(score);
    const total = test.resultsA.length + test.resultsB.length;
    if (total >= test.minSampleSize && !test.completedAt) {
      this.completeABTest(testId);
    }
  }

  private completeABTest(testId: string): void {
    const test = this.abTests.get(testId);
    if (!test || test.completedAt) return;
    const meanA = test.resultsA.reduce((s, v) => s + v, 0) / test.resultsA.length;
    const meanB = test.resultsB.reduce((s, v) => s + v, 0) / test.resultsB.length;
    const varA = test.resultsA.reduce((s, v) => s + (v - meanA) ** 2, 0) / test.resultsA.length;
    const varB = test.resultsB.reduce((s, v) => s + (v - meanB) ** 2, 0) / test.resultsB.length;
    const pooledStd = Math.sqrt((varA + varB) / 2);
    test.effectSize = pooledStd > 0 ? Math.abs(meanB - meanA) / pooledStd : 0;
    const totalSamples = test.resultsA.length + test.resultsB.length;
    test.confidence = Math.min(1, totalSamples / 30 * 0.5 + (test.effectSize || 0) * 0.5);
    const diff = meanB - meanA;
    test.winner = (() => {
      if (diff > 0.05) return 'B';
      if (diff < -0.05) return 'A';
      return 'tie';
    })();
    test.completedAt = Date.now();
    this.log.info('A/B 测试完成', { id: testId, winner: test.winner, effectSize: test.effectSize, confidence: test.confidence });
  }

  getABTest(testId: string): ABTestConfig | undefined {
    return this.abTests.get(testId);
  }

  getActiveABTests(): ABTestConfig[] {
    return Array.from(this.abTests.values()).filter(t => !t.completedAt);
  }

  getSnapshots(limit?: number, offset?: number): EvalSnapshot[] {
    const start = offset || 0;
    const end = limit ? start + limit : this.snapshots.length;
    return this.snapshots.slice(start, end);
  }

  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  generateReport(): LearningEvalReport {
    const accuracy = this.getAccuracy();
    const dims: EvalDimension[] = ['accuracy', 'efficiency', 'coverage', 'retention', 'adaptation'];
    const dimensionScores: Partial<Record<EvalDimension, number>> = {};
    for (const d of dims) {
      const scores = this.snapshots.slice(-30).filter(s => s.dimensions[d] !== undefined).map(s => s.dimensions[d]!);
      dimensionScores[d] = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    }
    const overallValues = Object.values(dimensionScores).filter(v => v !== undefined) as number[];
    const overallScore = overallValues.length > 0 ? overallValues.reduce((a, b) => a + b, 0) / overallValues.length : 0;
    const recent = this.snapshots.slice(-20);
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (recent.length >= 5) {
      const half = Math.floor(recent.length / 2);
      const firstHalf = recent.slice(0, half).reduce((s, r) => s + r.overall, 0) / half;
      const secondHalf = recent.slice(half).reduce((s, r) => s + r.overall, 0) / (recent.length - half);
      if (secondHalf - firstHalf > 0.03) {
        trend = 'improving';
      } else if (firstHalf - secondHalf > 0.03) {
        trend = 'declining';
      } else {
        trend = 'stable';
      }
    }
    const now = Date.now();
    const recentSnapshots = this.snapshots.filter(s => now - s.timestamp < 7 * 24 * 60 * 60 * 1000);
    const velocity = recentSnapshots.length > 0 ? recentSnapshots.length / 7 : 0;
    const warnings: string[] = [];
    if (accuracy < this.ACCURACY_TARGET) {
      warnings.push(`知识更新准确率 ${(accuracy * 100).toFixed(1)}% 低于目标 ${(this.ACCURACY_TARGET * 100).toFixed(0)}%`);
    }
    if (overallScore < 0.6) warnings.push('综合学习评分偏低，建议检查各子系统状态');
    const incompleteTests = this.getActiveABTests();
    if (incompleteTests.length > 5) warnings.push(`有 ${incompleteTests.length} 个 A/B 测试未完成`);
    return {
      accuracy,
      accuracyTarget: this.ACCURACY_TARGET,
      accuracyMet: accuracy >= this.ACCURACY_TARGET,
      overallScore,
      dimensionScores,
      abTests: Array.from(this.abTests.values()),
      trend,
      velocity,
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, any>; execute: (args: any) => any }> {
    return [
      {
        name: 'eval_report',
        description: '获取学习效率评估报告，包含准确率、各维度评分、A/B测试结果和趋势分析',
        parameters: {},
        execute: () => JSON.stringify(this.generateReport(), null, 2),
      },
      {
        name: 'eval_create_abtest',
        description: '创建A/B测试来对比不同学习策略或模型变体的效果',
        parameters: {
          id: { type: 'string', description: '测试ID', required: true },
          variantA: { type: 'string', description: '对照组名称', required: true },
          variantB: { type: 'string', description: '实验组名称', required: true },
          dimension: { type: 'string', description: '评估维度: accuracy/efficiency/coverage/retention/adaptation', required: true },
          minSampleSize: { type: 'number', description: '最小样本量(默认30)', required: false },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: (args: any) => {
          const test = this.createABTest({
            id: args.id,
            variantA: args.variantA,
            variantB: args.variantB,
            dimension: args.dimension as EvalDimension,
            minSampleSize: args.minSampleSize || 30,
          });
          return JSON.stringify(test, null, 2);
        },
      },
      {
        name: 'eval_record_abresult',
        description: '记录A/B测试的单个结果',
        parameters: {
          testId: { type: 'string', description: '测试ID', required: true },
          variant: { type: 'string', description: '分组: A 或 B', required: true },
          score: { type: 'number', description: '评分(0-1)', required: true },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: (args: any) => {
          this.recordABResult(args.testId, args.variant as 'A' | 'B', args.score);
          return '✅ 已记录';
        },
      },
    ];
  }

  /**
   * 从快照数据自动生成 A/B 测试
   * 分析历史快照，对比不同时间段的指标变化，生成有意义的 A/B 测试数据
   */
  autoGenerateABTests(): void {
    if (this.snapshots.length < 4) return; // 至少需要 4 个快照

    const dimensions = ['accuracy', 'efficiency', 'coverage', 'retention', 'adaptation'] as const;
    const midPoint = Math.floor(this.snapshots.length / 2);
    const earlySnapshots = this.snapshots.slice(0, midPoint);
    const lateSnapshots = this.snapshots.slice(midPoint);

    for (const dim of dimensions) {
      const testId = `auto-${dim}-${Date.now()}`;
      // 避免重复创建
      if (Array.from(this.abTests.values()).some(t => t.dimension === dim && t.id.startsWith('auto-'))) continue;

      const earlyScores = earlySnapshots.map(s => this.getDimensionScore(s, dim)).filter(s => s > 0);
      const lateScores = lateSnapshots.map(s => this.getDimensionScore(s, dim)).filter(s => s > 0);

      if (earlyScores.length < 2 || lateScores.length < 2) continue;

      const earlyAvg = earlyScores.reduce((a, b) => a + b, 0) / earlyScores.length;
      const lateAvg = lateScores.reduce((a, b) => a + b, 0) / lateScores.length;

      // 只在有显著差异时创建测试
      if (Math.abs(lateAvg - earlyAvg) < 0.05) continue;

      this.createABTest({
        id: testId,
        variantA: '早期策略',
        variantB: '近期策略',
        dimension: dim,
        minSampleSize: Math.min(earlyScores.length, lateScores.length),
      });

      // 记录结果
      for (const score of earlyScores) this.recordABResult(testId, 'A', score);
      for (const score of lateScores) this.recordABResult(testId, 'B', score);
    }
  }

  /** 从快照中提取维度分数 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getDimensionScore(snapshot: any, dimension: string): number {
    const map: Record<string, string> = {
      accuracy: 'intentAccuracy',
      efficiency: 'avgResponseTime',
      coverage: 'contextCoherence',
      retention: 'selfCorrectionRate',
      adaptation: 'toolCallSuccessRate',
    };
    const field = map[dimension];
    if (!field || snapshot[field] === undefined) return 0;
    // 响应时间越低越好，取反
    if (dimension === 'efficiency') return Math.max(0, 1 - snapshot[field] / 10000);
    return snapshot[field];
  }

  private loadState(): void {
    try {
      const path_ = path.join(this.evalDir, 'state.json');
      if (fs.existsSync(path_)) {
        const raw = JSON.parse(fs.readFileSync(path_, 'utf-8'));
        this.snapshots = raw.snapshots || [];
        if (raw.abTests) {
          for (const t of raw.abTests) this.abTests.set(t.id, t);
        }
      }
    } catch { this.log.warn('学习评估状态加载失败，使用默认值'); }

    // 加载完成后自动从快照生成 A/B 测试数据
    try { this.autoGenerateABTests(); } catch { /* ignore */ }
  }

  private persistState(): void {
    try {
      const data = JSON.stringify({
        snapshots: this.snapshots,
        abTests: Array.from(this.abTests.values()),
      });
      const tmp = path.join(this.evalDir, `state.${process.pid}.tmp`);
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, path.join(this.evalDir, 'state.json'));
    } catch { this.log.warn('学习评估状态持久化失败'); }
  }
}
