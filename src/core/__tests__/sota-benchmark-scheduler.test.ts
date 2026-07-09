/**
 * SOTA 基准挑战调度器测试 — SotaBenchmarkScheduler
 *
 * 覆盖：
 * - 立即挑战：runChallengeNow 跑 benchmark + 比对 + 注入 roadmap
 * - 幂等：同月内重跑被跳过（force 可强制）
 * - 失败安全：benchmark 抛错不阻塞
 * - 调度：start/stop
 * - 查询：getChallengeHistory / getLatestChallenge / getStats
 * - 工具定义：sota_run_challenge / sota_history / sota_status
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SotaBenchmarkScheduler, type SotaChallengeResult } from '../sota-benchmark-scheduler.js';
import { BenchmarkFramework, type BenchmarkResult, type ComparisonReport } from '../benchmark-framework.js';
import { OptimizationRoadmap } from '../optimization-roadmap.js';

// ============ Mock 工厂 ============

function createMockBenchmarkResult(averageScore = 70): BenchmarkResult {
  return {
    suite: 'full',
    timestamp: Date.now(),
    totalCases: 10,
    passedCases: 7,
    averageScore,
    averageLatency: 500,
    averageTokenUsage: 1000,
    categoryScores: { nlu: 70, code_gen: 65, reasoning: 75 },
    results: [],
  };
}

function createMockComparisons(gaps: Array<{ category: string; gapPercentage: number }>): ComparisonReport[] {
  return gaps.map(g => ({
    ourScore: 70,
    baselineScore: 70 + Math.abs(g.gapPercentage),
    gap: -Math.abs(g.gapPercentage),
    gapPercentage: g.gapPercentage,
    category: g.category,
    analysis: `${g.category} 落后 SOTA ${Math.abs(g.gapPercentage)}%`,
    recommendations: [`改进 ${g.category}`, `优化算法`],
  }));
}

function createMockBenchmarkFramework(
  result?: BenchmarkResult,
  comparisons?: ComparisonReport[],
  shouldThrow = false,
): BenchmarkFramework {
  const mock = {
    runBenchmark: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('benchmark failed');
      return result || createMockBenchmarkResult();
    }),
    compareWithBaseline: vi.fn().mockImplementation(() => comparisons || []),
    getToolDefinitions: vi.fn().mockReturnValue([]),
  };
  // 返回 mock 对象作为 BenchmarkFramework 替身
  return mock as unknown as BenchmarkFramework;
}

// ============ 测试 ============

describe('SotaBenchmarkScheduler', () => {
  let roadmap: OptimizationRoadmap;
  let scheduler: SotaBenchmarkScheduler;

  beforeEach(() => {
    roadmap = new OptimizationRoadmap();
  });

  afterEach(() => {
    // 清理 scheduler 定时器
    if (scheduler) scheduler.stop();
    vi.restoreAllMocks();
  });

  describe('立即挑战 runChallengeNow', () => {
    it('成功跑 benchmark 并比对', async () => {
      const comparisons = createMockComparisons([
        { category: 'nlu', gapPercentage: -5 },
        { category: 'code_gen', gapPercentage: -15 },
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap, { autoInjectRoadmap: false });

      const result = await scheduler.runChallengeNow(true);

      expect(result.error).toBeUndefined();
      expect(result.suite).toBe('full');
      expect(result.comparisons).toHaveLength(2);
      expect(result.averageGap).toBe(-10); // (-5 + -15) / 2
      expect(result.significantGaps).toHaveLength(1); // 只有 -15 < -10 阈值
      expect(result.significantGaps[0].category).toBe('code_gen');
    });

    it('显著 gap 自动注入 roadmap 条目', async () => {
      const comparisons = createMockComparisons([
        { category: 'nlu', gapPercentage: -25 },
        { category: 'code_gen', gapPercentage: -35 },
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(60), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      const result = await scheduler.runChallengeNow(true);

      expect(result.injectedRoadmapItemIds).toHaveLength(2);
      // roadmap 应包含注入的项
      const roadmapData = roadmap.getRoadmap();
      const injectedTitles = roadmapData.items.map(i => i.title);
      expect(injectedTitles.some(t => t.includes('nlu'))).toBe(true);
      expect(injectedTitles.some(t => t.includes('code_gen'))).toBe(true);
    });

    it('autoInjectRoadmap=false 不注入 roadmap', async () => {
      const comparisons = createMockComparisons([
        { category: 'nlu', gapPercentage: -50 },
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(50), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap, { autoInjectRoadmap: false });

      const result = await scheduler.runChallengeNow(true);
      expect(result.injectedRoadmapItemIds).toHaveLength(0);
    });

    it('benchmark 失败返回带 error 的结果', async () => {
      const bf = createMockBenchmarkFramework(undefined, [], true);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      const result = await scheduler.runChallengeNow(true);

      expect(result.error).toBe('benchmark failed');
      expect(result.comparisons).toEqual([]);
      expect(result.significantGaps).toEqual([]);
    });

    it('无 gap 时不注入 roadmap', async () => {
      const comparisons = createMockComparisons([
        { category: 'nlu', gapPercentage: 5 }, // 领先
        { category: 'code_gen', gapPercentage: -3 }, // 微弱落后，未达阈值
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(85), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      const result = await scheduler.runChallengeNow(true);
      expect(result.significantGaps).toHaveLength(0);
      expect(result.injectedRoadmapItemIds).toHaveLength(0);
    });
  });

  describe('幂等', () => {
    it('同月内重跑被跳过', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap, { intervalMs: 30 * 24 * 60 * 60 * 1000 });

      const first = await scheduler.runChallengeNow(true);
      expect(first.error).toBeUndefined();

      // 第二次不强制，应被跳过
      const second = await scheduler.runChallengeNow(false);
      expect(second.error).toContain('已跑过');
    });

    it('force=true 强制重跑', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      await scheduler.runChallengeNow(true);
      const second = await scheduler.runChallengeNow(true);
      expect(second.error).toBeUndefined();
    });
  });

  describe('调度 start/stop', () => {
    it('start 启动定时器，stop 清理', () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap, { intervalMs: 1000 });

      const statsBefore = scheduler.getStats();
      expect(statsBefore.nextScheduledAt).toBeNull();

      scheduler.start();
      const statsRunning = scheduler.getStats();
      expect(statsRunning.nextScheduledAt).toBeGreaterThan(0);

      scheduler.stop();
      const statsStopped = scheduler.getStats();
      expect(statsStopped.nextScheduledAt).toBeNull();
    });

    it('重复 start 被忽略', () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap, { intervalMs: 1000 });

      scheduler.start();
      scheduler.start(); // 应被忽略
      scheduler.stop();
    });

    it('stop 未启动的调度器不报错', () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      expect(() => scheduler.stop()).not.toThrow();
    });
  });

  describe('查询 API', () => {
    it('getChallengeHistory 返回历史', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      expect(scheduler.getChallengeHistory()).toHaveLength(0);

      await scheduler.runChallengeNow(true);
      await scheduler.runChallengeNow(true);

      expect(scheduler.getChallengeHistory()).toHaveLength(2);
    });

    it('getLatestChallenge 返回最近一次', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(75), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      expect(scheduler.getLatestChallenge()).toBeNull();

      await scheduler.runChallengeNow(true);
      const latest = scheduler.getLatestChallenge();
      expect(latest).not.toBeNull();
      expect(latest!.benchmarkResult.averageScore).toBe(75);
    });

    it('getStats 反映统计', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      const stats0 = scheduler.getStats();
      expect(stats0.totalChallenges).toBe(0);
      expect(stats0.lastChallengeId).toBeNull();
      expect(stats0.isRunning).toBe(false);

      await scheduler.runChallengeNow(true);

      const stats1 = scheduler.getStats();
      expect(stats1.totalChallenges).toBe(1);
      expect(stats1.successfulChallenges).toBe(1);
      expect(stats1.failedChallenges).toBe(0);
      expect(stats1.lastChallengeId).not.toBeNull();
      expect(stats1.averageGapTrend).toHaveLength(1);
    });

    it('history limit 生效', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap, { historyLimit: 3 });

      for (let i = 0; i < 5; i++) {
        await scheduler.runChallengeNow(true);
      }
      const history = scheduler.getChallengeHistory();
      expect(history.length).toBeLessThanOrEqual(3);
    });
  });

  describe('工具定义 getToolDefinitions', () => {
    it('返回 3 个工具', () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      const defs = scheduler.getToolDefinitions();
      expect(defs).toHaveLength(3);
      const names = defs.map(d => d.name);
      expect(names).toContain('sota_run_challenge');
      expect(names).toContain('sota_history');
      expect(names).toContain('sota_status');
    });

    it('所有工具均只读', () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      const defs = scheduler.getToolDefinitions();
      for (const d of defs) {
        expect(d.readOnly).toBe(true);
      }
    });

    it('sota_run_challenge 触发挑战', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      const defs = scheduler.getToolDefinitions();
      const tool = defs.find(d => d.name === 'sota_run_challenge')!;
      const result = await tool.execute({ force: true });
      const parsed: SotaChallengeResult = JSON.parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.suite).toBe('full');
    });

    it('sota_history 返回历史摘要', async () => {
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(70), []);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      await scheduler.runChallengeNow(true);

      const defs = scheduler.getToolDefinitions();
      const tool = defs.find(d => d.name === 'sota_history')!;
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].challengeId).toMatch(/^sota_\d+$/);
    });

    it('sota_history 无历史时返回提示', async () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      const defs = scheduler.getToolDefinitions();
      const tool = defs.find(d => d.name === 'sota_history')!;
      const result = await tool.execute({});
      expect(result).toContain('暂无');
    });

    it('sota_status 返回状态文本', async () => {
      const bf = createMockBenchmarkFramework();
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);
      const defs = scheduler.getToolDefinitions();
      const tool = defs.find(d => d.name === 'sota_status')!;
      const result = await tool.execute({});
      expect(result).toContain('SOTA 基准挑战调度器状态');
      expect(result).toContain('总挑战次数');
    });
  });

  describe('gap → roadmap 项映射', () => {
    it('大 gap (>=30%) 生成高 impact 与 P0-P1 优先级', async () => {
      const comparisons = createMockComparisons([
        { category: 'nlu', gapPercentage: -45 },
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(55), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      await scheduler.runChallengeNow(true);
      const roadmapData = roadmap.getRoadmap();
      const injected = roadmapData.items.find(i => i.title.includes('nlu'));
      expect(injected).toBeDefined();
      // impact 基于 gap 算（45% → 0.9），确定性强
      expect(injected!.impact).toBeGreaterThan(0.8);
      expect(injected!.estimatedEffort).toContain('周'); // 4-8 周
      // priority 由 roadmap.scoreOptimization 基于 compositeScore 决定，大 gap 应是高优先级
      expect(['P0', 'P1', 'P2', 'P3']).toContain(injected!.priority);
    });

    it('中等 gap (10-20%) 生成中等 impact', async () => {
      const comparisons = createMockComparisons([
        { category: 'reasoning', gapPercentage: -15 },
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(65), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      await scheduler.runChallengeNow(true);
      const roadmapData = roadmap.getRoadmap();
      const injected = roadmapData.items.find(i => i.title.includes('reasoning'));
      expect(injected).toBeDefined();
      // 15% gap → impact 0.3
      expect(injected!.impact).toBeGreaterThan(0.2);
      expect(injected!.impact).toBeLessThan(0.5);
    });

    it('category 映射到正确的 optimization category', async () => {
      const comparisons = createMockComparisons([
        { category: 'code_gen', gapPercentage: -25 },
      ]);
      const bf = createMockBenchmarkFramework(createMockBenchmarkResult(60), comparisons);
      scheduler = new SotaBenchmarkScheduler(bf, roadmap);

      await scheduler.runChallengeNow(true);
      const roadmapData = roadmap.getRoadmap();
      const injected = roadmapData.items.find(i => i.title.includes('code_gen'));
      expect(injected).toBeDefined();
      expect(injected!.category).toBe('code_gen');
    });
  });
});
