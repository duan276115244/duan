/**
 * ContinuousEvolutionSystem 单元测试
 *
 * 验证持续进化系统的核心能力：
 * 1. 竞品管理 — 添加/查询/种子初始化
 * 2. 每日进化周期 — 爬取→分析→对比→路线图→学习注入→QA
 * 3. 每周综合评审 — 汇总日周期，识别优先差距
 * 4. 每月战略重评估 — 竞争优势/战略差距识别
 * 5. 满意度反馈 — 记录/趋势/统计
 * 6. 路线图管理 — 添加/排序/状态更新
 * 7. 报告生成
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContinuousEvolutionSystem, type CompetitorInfo, type EnhancementItem, type SatisfactionFeedback } from '../continuous-evolution-system.js';

describe('ContinuousEvolutionSystem', () => {
  let system: ContinuousEvolutionSystem;
  let testDataDir: string;
  // 使用 os.tmpdir() 而非 process.cwd()/data/：避免污染项目目录 + Windows 并发 I/O 下 EPERM 更少

  /** EPERM 安全的递归删除（Windows 并发 I/O 下目录可能瞬时锁定） */
  function safeRmDir(dir: string, retries = 5): void {
    for (let i = 0; i < retries; i++) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        const start = Date.now();
        while (Date.now() - start < 50) { /* busy-wait 50ms */ }
      }
    }
  }

  beforeEach(() => {
    // 每个用例使用独立目录，彻底消除跨用例状态污染
    //（之前用 const testDataDir 共享同一目录，safeRmDir 在 Windows 下可能因文件锁失败导致残留）
    testDataDir = path.join(
      os.tmpdir(),
      'evolution-test-' + Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2),
    );
    system = new ContinuousEvolutionSystem(testDataDir);
  });

  afterEach(() => {
    try { system.stop(); } catch { /* ignore */ }
    // 清理测试数据（带 EPERM 重试）
    safeRmDir(testDataDir);
  });

  describe('竞品管理', () => {
    it('初始化种子竞品', () => {
      const count = system.initializeSeedCompetitors();
      expect(count).toBeGreaterThan(10);
      const competitors = system.getCompetitors();
      expect(competitors.length).toBeGreaterThan(10);
      expect(competitors.some(c => c.name === 'Claude Code')).toBe(true);
      expect(competitors.some(c => c.name === 'Codex')).toBe(true);
      expect(competitors.some(c => c.name === 'Hermes Agent')).toBe(true);
    });

    it('重复初始化不重复添加', () => {
      system.initializeSeedCompetitors();
      const count1 = system.getCompetitors().length;
      const added = system.initializeSeedCompetitors();
      expect(added).toBe(0);
      expect(system.getCompetitors().length).toBe(count1);
    });

    it('添加自定义竞品', () => {
      const competitor: CompetitorInfo = {
        name: 'TestAgent',
        organization: 'TestOrg',
        category: 'coding',
        platforms: ['cli'],
        url: 'https://example.com',
        description: 'Test agent',
        capabilities: ['test'],
        uniqueFeatures: ['feature1'],
        source: 'manual',
        discoveredAt: Date.now(),
      };
      system.addCompetitor(competitor);
      const competitors = system.getCompetitors();
      expect(competitors.some(c => c.name === 'TestAgent')).toBe(true);
    });

    it('数据持久化到文件', () => {
      system.initializeSeedCompetitors();
      const competitorsPath = path.join(testDataDir, 'competitors.json');
      expect(fs.existsSync(competitorsPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(competitorsPath, 'utf-8'));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(10);
    });
  });

  describe('每日进化周期', () => {
    it('执行完整的每日周期', async () => {
      const cycle = await system.runDailyCycle();
      expect(cycle.id).toMatch(/^daily-\d+$/);
      expect(cycle.type).toBe('daily');
      expect(cycle.startedAt).toBeGreaterThan(0);
      expect(cycle.completedAt).toBeGreaterThan(cycle.startedAt);
      expect(cycle.discoveredCompetitors.length).toBeGreaterThan(0);
      expect(cycle.analyses.length).toBeGreaterThan(0);
      expect(cycle.comparisons.length).toBeGreaterThan(0);
      expect(cycle.summary).toContain('进化周期');
    });

    it('每日周期生成分析报告', async () => {
      const cycle = await system.runDailyCycle();
      expect(cycle.analyses.length).toBeGreaterThan(0);
      const analysis = cycle.analyses[0];
      expect(analysis.competitor).toBeDefined();
      expect(analysis.architecture).toBeDefined();
      expect(analysis.architecture.reasoningParadigm).toBeDefined();
      expect(analysis.metrics).toBeDefined();
      expect(analysis.userFeedback).toBeDefined();
      expect(analysis.learnableHighlights).toBeDefined();
      expect(analysis.confidence).toBeGreaterThan(0);
    });

    it('每日周期生成对比结果', async () => {
      const cycle = await system.runDailyCycle();
      expect(cycle.comparisons.length).toBeGreaterThan(0);
      const comparison = cycle.comparisons[0];
      expect(comparison.competitorName).toBeDefined();
      expect(comparison.scores.length).toBe(6); // 6 个维度
      expect(comparison.ourTotal).toBeGreaterThan(0);
      expect(comparison.competitorTotal).toBeGreaterThan(0);
      expect(comparison.priorityActions).toBeDefined();
    });

    it('每日周期生成路线图更新', async () => {
      const cycle = await system.runDailyCycle();
      // 路线图更新可能为 0（如果没有差距），也可能有
      expect(cycle.roadmapUpdates).toBeDefined();
      for (const item of cycle.roadmapUpdates) {
        expect(item.title).toBeDefined();
        expect(item.type).toMatch(/adopt|fix|innovate/);
        expect(item.priority).toBeGreaterThanOrEqual(1);
        expect(item.priority).toBeLessThanOrEqual(5);
      }
    });

    it('每日周期注入知识', async () => {
      const cycle = await system.runDailyCycle();
      expect(cycle.injectedKnowledge.length).toBeGreaterThan(0);
      // 知识条目应包含竞品名称
      expect(cycle.injectedKnowledge.some(k => k.includes(':'))).toBe(true);
    });

    it('每日周期包含 QA 结果', async () => {
      const cycle = await system.runDailyCycle();
      expect(cycle.qaResult).toBeDefined();
      expect(cycle.qaResult!.regressionPassRate).toBeGreaterThan(0);
      expect(cycle.qaResult!.regressionPassRate).toBeLessThanOrEqual(1);
      expect(cycle.qaResult!.overallQuality).toBeGreaterThan(0);
      expect(typeof cycle.qaResult!.passed).toBe('boolean');
    });
  });

  describe('每周综合评审', () => {
    it('执行每周评审', async () => {
      // 先执行一个日周期
      await system.runDailyCycle();
      const cycle = await system.runWeeklyReview();
      expect(cycle.id).toMatch(/^weekly-\d+$/);
      expect(cycle.type).toBe('weekly');
      expect(cycle.summary).toContain('每周评审');
    }, 60000);

    it('每周评审识别优先差距', async () => {
      await system.runDailyCycle();
      const cycle = await system.runWeeklyReview();
      expect(cycle.roadmapUpdates).toBeDefined();
    }, 60000);
  });

  describe('每月战略重评估', () => {
    it('执行月度评估', async () => {
      await system.runDailyCycle();
      const cycle = await system.runMonthlyAssessment();
      expect(cycle.id).toMatch(/^monthly-\d+$/);
      expect(cycle.type).toBe('monthly');
      expect(cycle.summary).toContain('月度战略重评估');
    }, 60000); // 60s：runDailyCycle + runMonthlyAssessment 在并行测试下可能 > 30s

    it('月度评估识别竞争优势', async () => {
      await system.runDailyCycle();
      await system.runMonthlyAssessment();
      // 竞争优势应在报告中体现
      const report = system.generateEvolutionReport();
      expect(report).toContain('竞争优势');
    }, 60000);
  });

  describe('满意度反馈', () => {
    it('记录正面反馈', () => {
      const feedback: SatisfactionFeedback = {
        timestamp: Date.now(),
        rating: 5,
        category: 'positive',
        content: '非常好用',
      };
      system.recordFeedback(feedback);
      const stats = system.getFeedbackStats();
      expect(stats.total).toBe(1);
      expect(stats.positive).toBe(1);
      expect(stats.averageRating).toBe(5);
    });

    it('记录多条反馈并计算趋势', () => {
      // 记录一批较低评分
      for (let i = 0; i < 10; i++) {
        system.recordFeedback({
          timestamp: Date.now() - 10000,
          rating: 3,
          category: 'negative',
          content: '一般',
        });
      }
      // 记录一批较高评分
      for (let i = 0; i < 10; i++) {
        system.recordFeedback({
          timestamp: Date.now(),
          rating: 5,
          category: 'positive',
          content: '很好',
        });
      }
      const trend = system.getSatisfactionTrend(20);
      expect(trend.samples).toBe(20);
      expect(trend.average).toBeGreaterThan(3.5);
      expect(trend.trend).toBe('up'); // 近期评分更高
    });

    it('反馈分类统计', () => {
      system.recordFeedback({ timestamp: Date.now(), rating: 5, category: 'positive', content: '好' });
      system.recordFeedback({ timestamp: Date.now(), rating: 2, category: 'negative', content: '差' });
      system.recordFeedback({ timestamp: Date.now(), rating: 4, category: 'suggestion', content: '建议' });
      system.recordFeedback({ timestamp: Date.now(), rating: 1, category: 'bug', content: 'bug' });
      const stats = system.getFeedbackStats();
      expect(stats.total).toBe(4);
      expect(stats.positive).toBe(1);
      expect(stats.negative).toBe(1);
      expect(stats.suggestions).toBe(1);
      expect(stats.bugs).toBe(1);
    });
  });

  describe('路线图管理', () => {
    it('添加增强项', () => {
      const item: EnhancementItem = {
        title: '测试增强项',
        description: '测试描述',
        type: 'adopt',
        priority: 3,
        impactDimensions: ['nlu_quality'],
        estimatedEffort: 'M',
        acceptanceCriteria: ['标准1'],
        status: 'proposed',
        createdAt: Date.now(),
      };
      system.addEnhancement(item);
      const roadmap = system.getRoadmap();
      expect(roadmap.some(i => i.title === '测试增强项')).toBe(true);
    });

    it('按状态过滤路线图', () => {
      system.addEnhancement({
        title: '项1', description: '', type: 'adopt', priority: 3,
        impactDimensions: [], estimatedEffort: 'S', acceptanceCriteria: [],
        status: 'proposed', createdAt: Date.now(),
      });
      system.addEnhancement({
        title: '项2', description: '', type: 'fix', priority: 4,
        impactDimensions: [], estimatedEffort: 'M', acceptanceCriteria: [],
        status: 'completed', createdAt: Date.now(),
      });
      const proposed = system.getRoadmap('proposed');
      const completed = system.getRoadmap('completed');
      expect(proposed.some(i => i.title === '项1')).toBe(true);
      expect(proposed.some(i => i.title === '项2')).toBe(false);
      expect(completed.some(i => i.title === '项2')).toBe(true);
    });

    it('更新增强项状态', () => {
      system.addEnhancement({
        title: '状态测试', description: '', type: 'adopt', priority: 3,
        impactDimensions: [], estimatedEffort: 'S', acceptanceCriteria: [],
        status: 'proposed', createdAt: Date.now(),
      });
      const updated = system.updateEnhancementStatus('状态测试', 'in_progress');
      expect(updated).toBe(true);
      const inProgress = system.getRoadmap('in_progress');
      expect(inProgress.some(i => i.title === '状态测试')).toBe(true);
    });

    it('优先级排序', () => {
      system.addEnhancement({
        title: '低优先级大工作量', description: '', type: 'adopt', priority: 2,
        impactDimensions: [], estimatedEffort: 'XL', acceptanceCriteria: [],
        status: 'proposed', createdAt: Date.now(),
      });
      system.addEnhancement({
        title: '高优先级小工作量', description: '', type: 'adopt', priority: 5,
        impactDimensions: [], estimatedEffort: 'S', acceptanceCriteria: [],
        status: 'proposed', createdAt: Date.now(),
      });
      const prioritized = system.getPrioritizedRoadmap(10);
      expect(prioritized[0].title).toBe('高优先级小工作量');
    });
  });

  describe('周期管理', () => {
    it('记录和查询周期', async () => {
      await system.runDailyCycle();
      const recent = system.getRecentCycles(5);
      expect(recent.length).toBe(1);
      expect(recent[0].type).toBe('daily');
    });

    it('获取上一个周期', async () => {
      await system.runDailyCycle();
      const last = system.getLastCycle();
      expect(last).not.toBeNull();
      expect(last!.type).toBe('daily');
    });
  });

  describe('调度器', () => {
    it('启动和停止', () => {
      expect(system.isRunning()).toBe(false);
      system.start();
      expect(system.isRunning()).toBe(true);
      system.stop();
      expect(system.isRunning()).toBe(false);
    });
  });

  describe('报告生成', () => {
    it('生成进化报告', async () => {
      system.initializeSeedCompetitors();
      await system.runDailyCycle();
      const report = system.generateEvolutionReport();
      expect(report).toContain('持续进化系统报告');
      expect(report).toContain('已知竞品');
      expect(report).toContain('满意度');
      expect(report).toContain('竞争优势');
      expect(report).toContain('战略差距');
      expect(report).toContain('优先路线图');
    });
  });

  describe('对比维度', () => {
    it('6 个维度全覆盖', async () => {
      system.initializeSeedCompetitors();
      const cycle = await system.runDailyCycle();
      const comparison = cycle.comparisons[0];
      const dimensions = comparison.scores.map(s => s.dimension);
      expect(dimensions).toContain('nlu_quality');
      expect(dimensions).toContain('reasoning_ability');
      expect(dimensions).toContain('tool_utilization');
      expect(dimensions).toContain('learning_efficiency');
      expect(dimensions).toContain('response_speed');
      expect(dimensions).toContain('user_experience');
    });

    it('对比结果包含差距分析', async () => {
      system.initializeSeedCompetitors();
      const cycle = await system.runDailyCycle();
      for (const comparison of cycle.comparisons) {
        for (const score of comparison.scores) {
          expect(['leading', 'parity', 'behind', 'far_behind']).toContain(score.gap);
          expect(score.analysis).toBeDefined();
          expect(score.improvementSuggestion).toBeDefined();
        }
      }
    });
  });
});
