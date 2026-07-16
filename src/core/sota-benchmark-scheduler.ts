/**
 * SOTA 基准挑战调度器 — SotaBenchmarkScheduler
 *
 * 文档七·持续进化的落地实现。每月自动跑 SOTA 基准挑战：
 * 1. 用 BenchmarkFramework 跑完整 benchmark suite
 * 2. compareWithBaseline 与行业 SOTA 工具比对，识别 gap
 * 3. 对显著 gap 的类别，自动注入 OptimizationItem 到路线图
 * 4. 记录挑战历史，便于追踪月度趋势
 *
 * 价值：
 * - "本月我们在 NLU 上相比 GPT-4 还差多少分" — 量化差距
 * - 自动把 gap 转成可执行的优化项 — 闭环到路线图
 * - 月度趋势追踪 — 看清进化曲线
 *
 * 设计原则：
 * 1. 调度解耦 — 用 setInterval，可 start/stop，不依赖 Heartbeat 内部
 * 2. 失败安全 — 单次挑战失败不阻塞下次调度
 * 3. 幂等 — 同月内已跑过则跳过（除非 force=true）
 * 4. 可观测 — 每次挑战 emit EventBus 事件 + 日志
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { BenchmarkFramework, type BenchmarkResult, type ComparisonReport } from './benchmark-framework.js';
import { OptimizationRoadmap, type OptimizationItem, type OptimizationCategory, type Priority } from './optimization-roadmap.js';

// ============ 类型定义 ============

export interface SotaChallengeResult {
  challengeId: string;
  timestamp: number;
  suite: string;
  benchmarkResult: BenchmarkResult;
  comparisons: ComparisonReport[];
  /** 与 SOTA 的平均 gap（正值=领先，负值=落后） */
  averageGap: number;
  /** 显著落后的类别（gap < -10%） */
  significantGaps: Array<{
    category: string;
    gap: number;
    gapPercentage: number;
    analysis: string;
    recommendations: string[];
  }>;
  /** 基于此挑战自动注入的 roadmap 项 ID */
  injectedRoadmapItemIds: string[];
  durationMs: number;
  error?: string;
}

export interface SotaSchedulerStats {
  totalChallenges: number;
  successfulChallenges: number;
  failedChallenges: number;
  lastChallengeAt: number;
  lastChallengeId: string | null;
  nextScheduledAt: number | null;
  isRunning: boolean;
  averageGapTrend: number[]; // 最近 N 次挑战的平均 gap
}

export interface SchedulerConfig {
  /** 调度间隔（毫秒），默认 30 天 */
  intervalMs?: number;
  /** 跑哪个 benchmark suite，默认 'full' */
  suite?: string;
  /** 与哪个 SOTA 工具比对，默认 'GPT-4' */
  baselineTool?: string;
  /** gap 阈值（百分比），低于此值视为显著 gap，默认 -10 */
  significantGapThreshold?: number;
  /** 是否自动注入 roadmap 条目，默认 true */
  autoInjectRoadmap?: boolean;
  /** 历史保留数量，默认 12（一年） */
  historyLimit?: number;
}

// ============ 默认配置 ============

const DEFAULT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const DEFAULT_SUITE = 'full';
const DEFAULT_BASELINE_TOOL = 'GPT-4';
const DEFAULT_GAP_THRESHOLD = -10; // 落后 10% 视为显著
const DEFAULT_HISTORY_LIMIT = 12;

// ============ 主类 ============

export class SotaBenchmarkScheduler {
  private log = logger.child({ module: 'SotaBenchmarkScheduler' });

  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private history: SotaChallengeResult[] = [];
  private lastChallengeAt = 0;
  private lastChallengeId: string | null = null;
  private nextScheduledAt: number | null = null;

  private readonly config: Required<SchedulerConfig>;

  constructor(
    private readonly benchmarkFramework: BenchmarkFramework,
    private readonly roadmap: OptimizationRoadmap,
    config: SchedulerConfig = {},
  ) {
    this.config = {
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      suite: config.suite ?? DEFAULT_SUITE,
      baselineTool: config.baselineTool ?? DEFAULT_BASELINE_TOOL,
      significantGapThreshold: config.significantGapThreshold ?? DEFAULT_GAP_THRESHOLD,
      autoInjectRoadmap: config.autoInjectRoadmap ?? true,
      historyLimit: config.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    };
    this.log.info('SOTA 基准挑战调度器初始化完成', {
      intervalMs: this.config.intervalMs,
      suite: this.config.suite,
      baselineTool: this.config.baselineTool,
      gapThreshold: this.config.significantGapThreshold,
    });
  }

  // ========== 调度控制 ==========

  /**
   * 启动月度调度
   */
  start(): void {
    if (this.timer) {
      this.log.warn('调度器已在运行，忽略重复 start');
      return;
    }
    this.nextScheduledAt = Date.now() + this.config.intervalMs;
    this.timer = setInterval(() => {
      void this.runChallengeNow().catch(err => {
        this.log.error('调度挑战失败', { error: err instanceof Error ? err.message : String(err) });
      });
    }, this.config.intervalMs);
    // 防止定时器阻止进程优雅退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log.info('SOTA 挑战调度已启动', {
      nextRunAt: new Date(this.nextScheduledAt).toISOString(),
      intervalDays: Math.round(this.config.intervalMs / (24 * 60 * 60 * 1000)),
    });
  }

  /**
   * 停止调度
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.nextScheduledAt = null;
      this.log.info('SOTA 挑战调度已停止');
    }
  }

  // ========== 立即执行 ==========

  /**
   * 立即跑一次 SOTA 挑战
   * @param force 是否强制跑（忽略同月幂等检查）
   */
  async runChallengeNow(force: boolean = false): Promise<SotaChallengeResult> {
    const challengeId = `sota_${Date.now()}`;
    const startTime = Date.now();

    // 幂等检查：同月内已跑过则跳过（除非 force）
    if (!force && this.lastChallengeAt > 0) {
      const elapsed = Date.now() - this.lastChallengeAt;
      if (elapsed < this.config.intervalMs) {
        this.log.info('本月已跑过 SOTA 挑战，跳过', {
          lastChallengeAt: new Date(this.lastChallengeAt).toISOString(),
          elapsedDays: Math.round(elapsed / (24 * 60 * 60 * 1000)),
        });
        const latest = this.history[this.history.length - 1];
        return {
          ...latest,
          challengeId,
          error: '本月已跑过，跳过（force=true 可强制重跑）',
        };
      }
    }

    this.isRunning = true;
    this.log.info('开始 SOTA 基准挑战', { challengeId, suite: this.config.suite, baselineTool: this.config.baselineTool });

    try {
      // 1. 跑 benchmark
      const benchmarkResult = await this.benchmarkFramework.runBenchmark(this.config.suite);

      // 2. 比对 SOTA baseline
      const comparisons = this.benchmarkFramework.compareWithBaseline(
        benchmarkResult,
        this.config.baselineTool,
      );

      // 3. 识别显著 gap
      const significantGaps = comparisons
        .filter(c => c.gapPercentage < this.config.significantGapThreshold)
        .map(c => ({
          category: c.category,
          gap: c.gap,
          gapPercentage: c.gapPercentage,
          analysis: c.analysis,
          recommendations: c.recommendations,
        }));

      // 4. 计算平均 gap
      const averageGap = comparisons.length > 0
        ? comparisons.reduce((sum, c) => sum + c.gapPercentage, 0) / comparisons.length
        : 0;

      // 5. 自动注入 roadmap 条目
      const injectedIds: string[] = [];
      if (this.config.autoInjectRoadmap && significantGaps.length > 0) {
        for (const gap of significantGaps) {
          const itemId = `sota_gap_${gap.category}_${Date.now()}`;
          const item: OptimizationItem = {
            id: itemId,
            title: `SOTA 挑战发现 ${gap.category} 类别落后 ${Math.abs(gap.gapPercentage).toFixed(1)}%`,
            description: gap.analysis,
            category: this.mapCategoryToOptimization(gap.category),
            sourceTool: 'sota-benchmark-scheduler',
            sourceTechnique: `月度 SOTA 基准挑战 vs ${this.config.baselineTool}`,
            impact: this.estimateImpact(gap.gapPercentage),
            feasibility: 0.5, // 默认中等可行性
            resourceRequired: this.estimateResource(gap.gapPercentage),
            strategicAlignment: 0.8, // SOTA gap 对齐战略价值高
            compositeScore: 0, // 由 roadmap.addOptimizationItem 计算
            priority: this.estimatePriority(gap.gapPercentage),
            status: 'planned',
            dependencies: [],
            estimatedEffort: this.estimateEffort(gap.gapPercentage),
            successMetrics: [
              `${gap.category} 类别 benchmark 分数提升至 SOTA 的 90%`,
              `gap 收窄到 -5% 以内`,
              ...gap.recommendations.slice(0, 2),
            ],
            risks: [
              `当前落后 ${Math.abs(gap.gapPercentage).toFixed(1)}%，差距较大`,
              '可能需要架构层面改进',
            ],
          };
          try {
            this.roadmap.addOptimizationItem(item);
            injectedIds.push(itemId);
          } catch (err: unknown) {
            this.log.warn('注入 roadmap 条目失败', { itemId, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      const result: SotaChallengeResult = {
        challengeId,
        timestamp: Date.now(),
        suite: this.config.suite,
        benchmarkResult,
        comparisons,
        averageGap,
        significantGaps,
        injectedRoadmapItemIds: injectedIds,
        durationMs: Date.now() - startTime,
      };

      // 6. 记录历史
      this.history.push(result);
      if (this.history.length > this.config.historyLimit) {
        this.history = this.history.slice(-this.config.historyLimit);
      }
      this.lastChallengeAt = result.timestamp;
      this.lastChallengeId = challengeId;

      // 7. emit 事件
      try {
        EventBus.getInstance().emitSync('sota.challenge.completed', {
          challengeId,
          suite: this.config.suite,
          averageGap,
          significantGaps: significantGaps.length,
          injectedRoadmapItems: injectedIds.length,
          durationMs: result.durationMs,
        }, { source: 'SotaBenchmarkScheduler' });
      } catch { /* 事件失败不影响挑战 */ }

      this.log.info('SOTA 基准挑战完成', {
        challengeId,
        averageGap: `${averageGap.toFixed(2)}%`,
        significantGaps: significantGaps.length,
        injectedRoadmapItems: injectedIds.length,
        durationMs: result.durationMs,
      });

      return result;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('SOTA 挑战失败', { challengeId, error: errorMsg });

      const failedResult: SotaChallengeResult = {
        challengeId,
        timestamp: Date.now(),
        suite: this.config.suite,
        benchmarkResult: {
          suite: this.config.suite,
          timestamp: Date.now(),
          totalCases: 0,
          passedCases: 0,
          averageScore: 0,
          averageLatency: 0,
          averageTokenUsage: 0,
          categoryScores: {},
          results: [],
        },
        comparisons: [],
        averageGap: 0,
        significantGaps: [],
        injectedRoadmapItemIds: [],
        durationMs: Date.now() - startTime,
        error: errorMsg,
      };
      this.history.push(failedResult);
      if (this.history.length > this.config.historyLimit) {
        this.history = this.history.slice(-this.config.historyLimit);
      }
      this.lastChallengeAt = failedResult.timestamp;
      this.lastChallengeId = challengeId;
      return failedResult;
    } finally {
      this.isRunning = false;
    }
  }

  // ========== 查询 API ==========

  /**
   * 获取挑战历史
   */
  getChallengeHistory(): SotaChallengeResult[] {
    return [...this.history];
  }

  /**
   * 获取最近一次挑战
   */
  getLatestChallenge(): SotaChallengeResult | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /**
   * 获取调度器状态
   */
  getStats(): SotaSchedulerStats {
    return {
      totalChallenges: this.history.length,
      successfulChallenges: this.history.filter(h => !h.error).length,
      failedChallenges: this.history.filter(h => h.error).length,
      lastChallengeAt: this.lastChallengeAt,
      lastChallengeId: this.lastChallengeId,
      nextScheduledAt: this.nextScheduledAt,
      isRunning: this.isRunning,
      averageGapTrend: this.history.map(h => h.averageGap),
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    return [
      {
        name: 'sota_run_challenge',
        description: '触发一次 SOTA 基准挑战：跑完整 benchmark suite，与行业 SOTA 工具（如 GPT-4）比对，识别显著 gap，自动注入优化项到路线图。耗时操作。',
        parameters: {
          force: { type: 'boolean', description: '是否强制重跑（忽略月度幂等检查），默认 false', required: false },
        },
        readOnly: true, // 只读 benchmark + roadmap（roadmap 添加是规划层不算副作用）
        execute: async (args) => {
          const force = args.force === true;
          try {
            const result = await engine.runChallengeNow(force);
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`SOTA 挑战失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      {
        name: 'sota_history',
        description: '查看 SOTA 基准挑战历史：最近 N 次挑战的平均 gap、显著 gap 类别、注入的 roadmap 项。只读。',
        parameters: {
          limit: { type: 'number', description: '返回最近 N 条历史（默认全部）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const limit = typeof args.limit === 'number' ? args.limit : undefined;
          const history = limit ? engine.getChallengeHistory().slice(-limit) : engine.getChallengeHistory();
          if (history.length === 0) {
            return Promise.resolve('暂无 SOTA 挑战历史。调用 sota_run_challenge 触发首次挑战。');
          }
          const summary = history.map(h => ({
            challengeId: h.challengeId,
            timestamp: new Date(h.timestamp).toISOString(),
            averageGap: `${h.averageGap.toFixed(2)}%`,
            significantGaps: h.significantGaps.length,
            injectedRoadmapItems: h.injectedRoadmapItemIds.length,
            error: h.error,
          }));
          return Promise.resolve(JSON.stringify(summary, null, 2));
        },
      },
      {
        name: 'sota_status',
        description: '查看 SOTA 调度器状态：是否运行中、下次调度时间、挑战统计、gap 趋势。只读。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const stats = engine.getStats();
          const lines = [
            `📊 SOTA 基准挑战调度器状态:`,
            `  运行中: ${stats.isRunning ? '是' : '否'}`,
            `  总挑战次数: ${stats.totalChallenges}（成功 ${stats.successfulChallenges} | 失败 ${stats.failedChallenges}）`,
            `  最近挑战: ${stats.lastChallengeAt ? new Date(stats.lastChallengeAt).toISOString() : '未运行'}`,
            `  最近挑战 ID: ${stats.lastChallengeId || '无'}`,
            `  下次调度: ${stats.nextScheduledAt ? new Date(stats.nextScheduledAt).toISOString() : '未启动调度'}`,
            `  平均 gap 趋势: [${stats.averageGapTrend.map(g => g.toFixed(2) + '%').join(', ')}]`,
          ];
          return Promise.resolve(lines.join('\n'));
        },
      },
    ];
  }

  // ========== 私有辅助 ==========

  /** benchmark category → optimization category 映射 */
  private mapCategoryToOptimization(benchmarkCategory: string): OptimizationCategory {
    const cat = benchmarkCategory.toLowerCase();
    if (cat.includes('code') || cat.includes('programming')) return 'code_gen';
    if (cat.includes('reason') || cat.includes('logic')) return 'reasoning';
    if (cat.includes('nlu') || cat.includes('language')) return 'nlu';
    if (cat.includes('tool') || cat.includes('function')) return 'tool_integration';
    if (cat.includes('context') || cat.includes('memory')) return 'context';
    if (cat.includes('task') || cat.includes('decomp')) return 'task_decomp';
    if (cat.includes('interact') || cat.includes('ux')) return 'interaction';
    if (cat.includes('perform') || cat.includes('latency')) return 'performance';
    return 'architecture';
  }

  /** gap → impact 估算（落后越多 impact 越高） */
  private estimateImpact(gapPercentage: number): number {
    const abs = Math.abs(gapPercentage);
    return Math.min(1, abs / 50); // 50% gap → impact 1.0
  }

  /** gap → resource 估算（落后越多需要资源越多） */
  private estimateResource(gapPercentage: number): number {
    const abs = Math.abs(gapPercentage);
    return Math.min(1, abs / 30); // 30% gap → resource 1.0
  }

  /** gap → priority 估算 */
  private estimatePriority(gapPercentage: number): Priority {
    const abs = Math.abs(gapPercentage);
    if (abs >= 30) return 'P0';
    if (abs >= 20) return 'P1';
    if (abs >= 10) return 'P2';
    return 'P3';
  }

  /** gap → effort 估算 */
  private estimateEffort(gapPercentage: number): string {
    const abs = Math.abs(gapPercentage);
    if (abs >= 30) return '4-8 周（架构改进）';
    if (abs >= 20) return '2-4 周';
    if (abs >= 10) return '1-2 周';
    return '3-5 天';
  }
}
