/**
 * LearningProgressVisualizer 测试 — §5.4 进度可视化
 *
 * 覆盖：初始化 / 学习曲线 / 能力雷达图 / 技能树 / 趋势分析 / 知识盲区 / 快照 / 完整报告 / Markdown / LLM 工具 / 单例 / 边缘情况
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  LearningProgressVisualizer,
  getLearningProgressVisualizer,
  type ProgressDataSource,
  type LearningRecordLite,
  type SkillLevelLite,
  type EvolutionMetricLite,
  type CapabilityDimensionLite,
  type AssessmentMetricLite,
  type UserProfileLite,
} from '../learning-progress-visualizer.js';

// ============ 测试工具 ============

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'progress-viz-test-'));
}

function newVisualizer(): LearningProgressVisualizer {
  const dir = path.join(tmpDir, 'progress');
  const v = new LearningProgressVisualizer(dir);
  v.initialize();
  return v;
}

/** 构造 mock 数据源 */
function makeMockSource(overrides: Partial<ProgressDataSource> = {}): ProgressDataSource {
  return {
    getLearningRecords: () => [],
    getSkillLevels: () => [],
    getKnowledgeGaps: () => [],
    getEvolutionMetrics: () => [],
    getCapabilityDimensions: () => [],
    getAssessmentMetrics: () => [],
    getUserProfile: () => null,
    ...overrides,
  };
}

/** 构造学习记录 */
function makeRecord(overrides: Partial<LearningRecordLite> = {}): LearningRecordLite {
  const now = Date.now();
  return {
    id: `rec-${now}`,
    type: 'best_practice',
    category: 'coding',
    content: '测试记录',
    confidence: 0.8,
    frequency: 1,
    lastSeen: now,
    firstSeen: now,
    applied: false,
    appliedCount: 0,
    outcome: 'positive',
    tags: ['test'],
    ...overrides,
  };
}

/** 构造能力维度 */
function makeDimension(overrides: Partial<CapabilityDimensionLite> = {}): CapabilityDimensionLite {
  return {
    id: 'dim-test',
    name: '测试维度',
    category: 'core',
    currentScore: 7,
    targetScore: 10,
    subItems: [],
    lastUpdated: Date.now(),
    ...overrides,
  };
}

// ============ 测试用例 ============

describe('LearningProgressVisualizer', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    LearningProgressVisualizer._resetInstance();
  });

  afterEach(() => {
    LearningProgressVisualizer._resetInstance();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ========== 初始化 ==========

  describe('初始化', () => {
    it('应创建数据目录并加载空数据', () => {
      const dir = path.join(tmpDir, 'progress');
      const v = new LearningProgressVisualizer(dir);
      v.initialize();
      expect(fs.existsSync(dir)).toBe(true);
      expect(v.getStats().snapshotsCount).toBe(0);
      expect(v.getStats().reportsCount).toBe(0);
      expect(v.getStats().hasDataSource).toBe(false);
    });

    it('应加载已持久化的快照', () => {
      const dir = path.join(tmpDir, 'progress');
      const v1 = new LearningProgressVisualizer(dir);
      v1.initialize();
      v1.setDataSource(makeMockSource());
      v1.generateSnapshot();

      const v2 = new LearningProgressVisualizer(dir);
      v2.initialize();
      expect(v2.getStats().snapshotsCount).toBe(1);
    });

    it('setDataSource 应注入数据源', () => {
      const v = newVisualizer();
      expect(v.getStats().hasDataSource).toBe(false);
      v.setDataSource(makeMockSource());
      expect(v.getStats().hasDataSource).toBe(true);
    });
  });

  // ========== 学习曲线 ==========

  describe('学习曲线', () => {
    it('无数据源应返回空曲线', () => {
      const v = newVisualizer();
      const curve = v.generateLearningCurve();
      expect(curve.points.length).toBe(0);
      expect(curve.totalRecords).toBe(0);
    });

    it('无学习记录应返回空曲线', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({ getLearningRecords: () => [] }));
      const curve = v.generateLearningCurve();
      expect(curve.points.length).toBe(0);
    });

    it('应按日聚合同一天记录', () => {
      const v = newVisualizer();
      const now = Date.now();
      const records: LearningRecordLite[] = [
        makeRecord({ id: 'r1', lastSeen: now, firstSeen: now }),
        makeRecord({ id: 'r2', lastSeen: now, firstSeen: now }),
        makeRecord({ id: 'r3', lastSeen: now, firstSeen: now }),
      ];
      v.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const curve = v.generateLearningCurve('daily', 1);
      expect(curve.points.length).toBe(1);
      expect(curve.points[0].newRecords).toBe(3);
      expect(curve.points[0].totalRecords).toBe(3);
    });

    it('应按周聚合', () => {
      const v = newVisualizer();
      const now = Date.now();
      const records: LearningRecordLite[] = [
        makeRecord({ id: 'r1', lastSeen: now, firstSeen: now }),
        makeRecord({ id: 'r2', lastSeen: now - 2 * 24 * 60 * 60 * 1000, firstSeen: now - 2 * 24 * 60 * 60 * 1000 }),
      ];
      v.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const curve = v.generateLearningCurve('weekly', 30);
      expect(curve.granularity).toBe('weekly');
    });

    it('应按月聚合', () => {
      const v = newVisualizer();
      const now = Date.now();
      const records: LearningRecordLite[] = [
        makeRecord({ id: 'r1', lastSeen: now, firstSeen: now }),
      ];
      v.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const curve = v.generateLearningCurve('monthly', 60);
      expect(curve.granularity).toBe('monthly');
      expect(curve.points.length).toBeGreaterThan(0);
    });

    it('应正确计算累积总数', () => {
      const v = newVisualizer();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const records: LearningRecordLite[] = [
        makeRecord({ id: 'r1', lastSeen: now - 2 * day, firstSeen: now - 2 * day }),
        makeRecord({ id: 'r2', lastSeen: now - day, firstSeen: now - day }),
        makeRecord({ id: 'r3', lastSeen: now, firstSeen: now }),
      ];
      v.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const curve = v.generateLearningCurve('daily', 7);
      expect(curve.points.length).toBe(3);
      expect(curve.points[0].totalRecords).toBe(1);
      expect(curve.points[1].totalRecords).toBe(2);
      expect(curve.points[2].totalRecords).toBe(3);
    });

    it('应统计 applied 和 outcome', () => {
      const v = newVisualizer();
      const now = Date.now();
      const records: LearningRecordLite[] = [
        makeRecord({ id: 'r1', lastSeen: now, firstSeen: now, applied: true, outcome: 'positive' }),
        makeRecord({ id: 'r2', lastSeen: now, firstSeen: now, applied: false, outcome: 'negative' }),
      ];
      v.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const curve = v.generateLearningCurve('daily', 1);
      expect(curve.points[0].appliedRecords).toBe(1);
      expect(curve.points[0].positiveOutcomes).toBe(1);
      expect(curve.points[0].negativeOutcomes).toBe(1);
    });

    it('应计算平均置信度', () => {
      const v = newVisualizer();
      const now = Date.now();
      const records: LearningRecordLite[] = [
        makeRecord({ id: 'r1', lastSeen: now, firstSeen: now, confidence: 0.6 }),
        makeRecord({ id: 'r2', lastSeen: now, firstSeen: now, confidence: 0.8 }),
      ];
      v.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const curve = v.generateLearningCurve('daily', 1);
      expect(curve.points[0].averageConfidence).toBeCloseTo(0.7, 2);
    });
  });

  // ========== 能力雷达图 ==========

  describe('能力雷达图', () => {
    it('无数据源应返回空雷达图', () => {
      const v = newVisualizer();
      const radar = v.generateRadarChart();
      expect(radar.dimensions.length).toBe(0);
      expect(radar.overallScore).toBe(0);
    });

    it('应优先使用 CapabilityScoreMatrix', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [
          makeDimension({ id: 'd1', name: '维度1', currentScore: 8, targetScore: 10 }),
          makeDimension({ id: 'd2', name: '维度2', currentScore: 6, targetScore: 10 }),
        ],
        getEvolutionMetrics: () => [], // 不应使用
      }));

      const radar = v.generateRadarChart();
      expect(radar.source).toBe('capability_matrix');
      expect(radar.dimensions.length).toBe(2);
      expect(radar.dimensions[0].current).toBe(80); // 8/10 * 100
      expect(radar.dimensions[0].target).toBe(100);
    });

    it('应回退到 EvolutionMetrics', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [],
        getEvolutionMetrics: () => [
          {
            id: 'm1', name: '指标1', description: '', category: 'intelligence',
            unit: '%', target: 100, currentValue: 75,
            history: [], trend: 'improving', weight: 1, lastUpdated: Date.now(),
          } as EvolutionMetricLite,
          {
            id: 'm2', name: '指标2', description: '', category: 'performance',
            unit: '%', target: 100, currentValue: 60,
            history: [], trend: 'stable', weight: 1, lastUpdated: Date.now(),
          } as EvolutionMetricLite,
        ],
      }));

      const radar = v.generateRadarChart();
      expect(radar.source).toBe('evolution_metrics');
      expect(radar.dimensions.length).toBe(2);
    });

    it('应最后回退到 SelfAssessment', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [],
        getEvolutionMetrics: () => [],
        getAssessmentMetrics: () => [
          {
            key: 'a1', name: '评估1', description: '', unit: '%',
            target: 100, current: 70, trend: 'up', history: [],
          } as AssessmentMetricLite,
        ],
      }));

      const radar = v.generateRadarChart();
      expect(radar.source).toBe('assessment');
      expect(radar.dimensions.length).toBe(1);
    });

    it('应正确归一化 0-10 分数到 0-100', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [
          makeDimension({ id: 'd1', name: '测试', currentScore: 5, targetScore: 10 }),
        ],
      }));

      const radar = v.generateRadarChart();
      expect(radar.dimensions[0].current).toBe(50);
      expect(radar.dimensions[0].target).toBe(100);
      expect(radar.dimensions[0].gap).toBe(50);
    });

    it('应计算综合评分', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [
          makeDimension({ id: 'd1', name: '维度1', currentScore: 8, targetScore: 10 }),
          makeDimension({ id: 'd2', name: '维度2', currentScore: 6, targetScore: 10 }),
        ],
      }));

      const radar = v.generateRadarChart();
      // (80 + 60) / 2 = 70
      expect(radar.overallScore).toBe(70);
    });
  });

  // ========== 技能树 ==========

  describe('技能树', () => {
    it('无数据源应返回空技能树', () => {
      const v = newVisualizer();
      const tree = v.generateSkillTree();
      expect(tree.roots.length).toBe(0);
      expect(tree.totalSkills).toBe(0);
    });

    it('应按分类分组', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getSkillLevels: () => [
          { name: 'code-review', level: 5, progress: 50 } as SkillLevelLite,
          { name: 'test-gen', level: 4, progress: 40 } as SkillLevelLite,
          { name: 'doc-write', level: 3, progress: 30 } as SkillLevelLite,
        ],
      }));

      const tree = v.generateSkillTree();
      expect(tree.totalSkills).toBe(3);
      // code-review 和 test-gen 应归入不同分类
      expect(tree.roots.length).toBeGreaterThanOrEqual(2);
    });

    it('应计算根节点平均等级', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getSkillLevels: () => [
          { name: 'code-1', level: 6, progress: 60 } as SkillLevelLite,
          { name: 'code-2', level: 8, progress: 80 } as SkillLevelLite,
        ],
      }));

      const tree = v.generateSkillTree();
      const codingRoot = tree.roots.find(r => r.name === '编程');
      expect(codingRoot).toBeDefined();
      expect(codingRoot!.level).toBe(7); // (6 + 8) / 2
    });

    it('应计算全局平均等级', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getSkillLevels: () => [
          { name: 'a', level: 4, progress: 40 } as SkillLevelLite,
          { name: 'b', level: 6, progress: 60 } as SkillLevelLite,
        ],
      }));

      const tree = v.generateSkillTree();
      expect(tree.averageLevel).toBe(5);
    });
  });

  // ========== 趋势分析 ==========

  describe('趋势分析', () => {
    it('无数据源应返回零趋势', () => {
      const v = newVisualizer();
      const trends = v.generateTrendStats();
      expect(trends.total).toBe(0);
      expect(trends.improving).toBe(0);
    });

    it('应统计 improving/declining/stable', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getEvolutionMetrics: () => [
          { id: 'm1', name: '指标1', description: '', category: 'intelligence', unit: '', target: 100, currentValue: 80, history: [], trend: 'improving', weight: 1, lastUpdated: Date.now() } as EvolutionMetricLite,
          { id: 'm2', name: '指标2', description: '', category: 'performance', unit: '', target: 100, currentValue: 50, history: [], trend: 'declining', weight: 1, lastUpdated: Date.now() } as EvolutionMetricLite,
          { id: 'm3', name: '指标3', description: '', category: 'reliability', unit: '', target: 100, currentValue: 70, history: [], trend: 'stable', weight: 1, lastUpdated: Date.now() } as EvolutionMetricLite,
        ],
      }));

      const trends = v.generateTrendStats();
      expect(trends.total).toBe(3);
      expect(trends.improving).toBe(1);
      expect(trends.declining).toBe(1);
      expect(trends.stable).toBe(1);
      expect(trends.improvingMetrics).toContain('指标1');
      expect(trends.decliningMetrics).toContain('指标2');
    });
  });

  // ========== 知识盲区视图 ==========

  describe('知识盲区视图', () => {
    it('无数据源应返回空视图', () => {
      const v = newVisualizer();
      const view = v.generateKnowledgeGapView();
      expect(view.totalGaps).toBe(0);
      expect(view.totalErrorPatterns).toBe(0);
    });

    it('应聚合 SelfLearningSystem 和 Persona 的盲区', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getKnowledgeGaps: () => ['TypeScript 泛型', 'Docker 网络'],
        getUserProfile: (): UserProfileLite => ({
          masteredDomains: [],
          knowledgeGaps: [
            { domain: 'SQL 优化', evidence: '查询超时', detectedAt: Date.now() },
          ],
          interests: [],
          errorPatterns: [
            { pattern: '未检查 null', count: 5, lastOccurrence: Date.now() },
          ],
        }),
      }));

      const view = v.generateKnowledgeGapView();
      expect(view.totalGaps).toBe(3); // 2 + 1
      expect(view.totalErrorPatterns).toBe(1);
      expect(view.gaps.some(g => g.source === 'learning')).toBe(true);
      expect(view.gaps.some(g => g.source === 'persona')).toBe(true);
    });

    it('getUserProfile 返回 null 应不报错', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getUserProfile: () => null,
      }));

      const view = v.generateKnowledgeGapView();
      expect(view.totalGaps).toBe(0);
    });
  });

  // ========== 快照 ==========

  describe('快照', () => {
    it('generateSnapshot 应生成并持久化快照', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getSkillLevels: () => [{ name: 'test', level: 5, progress: 50 } as SkillLevelLite],
        getCapabilityDimensions: () => [makeDimension({ currentScore: 7 })],
      }));

      const snapshot = v.generateSnapshot();
      expect(snapshot.date).toBeDefined();
      expect(snapshot.totalSkills).toBe(1);
      expect(snapshot.capabilityOverall).toBe(70); // 7/10 * 100
      expect(v.getStats().snapshotsCount).toBe(1);
    });

    it('同日多次快照应覆盖', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());

      v.generateSnapshot();
      v.generateSnapshot();
      v.generateSnapshot();
      expect(v.getStats().snapshotsCount).toBe(1);
    });

    it('getLatestSnapshot 应返回最新', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());
      expect(v.getLatestSnapshot()).toBeNull();

      const snap = v.generateSnapshot();
      const latest = v.getLatestSnapshot();
      expect(latest).not.toBeNull();
      expect(latest!.timestamp).toBe(snap.timestamp);
    });

    it('getRecentSnapshots 应按天数过滤', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());

      // 生成快照
      v.generateSnapshot();
      // 手动插入一个旧的快照
      const oldSnapshot = {
        timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 天前
        date: '2020-01-01',
        totalLearningRecords: 0, totalSkills: 0, averageSkillLevel: 0,
        capabilityOverall: 0, evolutionOverall: null, assessmentOverall: null,
        knowledgeGapsCount: 0, errorPatternsCount: 0,
        topSkills: [], topGaps: [],
        trendStats: { improving: 0, declining: 0, stable: 0, total: 0, improvingMetrics: [], decliningMetrics: [] },
      };
      // 通过反射注入
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v as any).snapshots.push(oldSnapshot);

      const recent = v.getRecentSnapshots(30);
      expect(recent.length).toBe(1); // 只有今天这个
    });
  });

  // ========== 完整报告 ==========

  describe('完整报告', () => {
    it('generateReport 应返回完整报告', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord()],
        getSkillLevels: () => [{ name: 'test', level: 5, progress: 50 } as SkillLevelLite],
        getCapabilityDimensions: () => [makeDimension()],
        getEvolutionMetrics: () => [],
      }));

      const report = v.generateReport();
      expect(report.generatedAt).toBeGreaterThan(0);
      expect(report.summary).toBeDefined();
      expect(report.radarChart).toBeDefined();
      expect(report.learningCurve).toBeDefined();
      expect(report.skillTree).toBeDefined();
      expect(report.knowledgeGaps).toBeDefined();
      expect(report.recommendations).toBeDefined();
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it('无数据源也应生成报告（降级）', () => {
      const v = newVisualizer();
      const report = v.generateReport();
      expect(report.summary.totalLearningRecords).toBe(0);
      expect(report.recommendations.length).toBeGreaterThan(0); // 应有默认建议
    });

    it('生成报告应记录报告索引', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());
      v.generateReport();
      expect(v.getStats().reportsCount).toBe(1);
    });
  });

  // ========== Markdown 报告 ==========

  describe('Markdown 报告', () => {
    it('应生成 Markdown 格式', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord()],
        getCapabilityDimensions: () => [makeDimension({ name: '测试维度' })],
        getSkillLevels: () => [{ name: 'code-test', level: 5, progress: 50 } as SkillLevelLite],
      }));

      const md = v.generateMarkdownReport();
      expect(md).toContain('# 学习进度报告');
      expect(md).toContain('## 概要');
      expect(md).toContain('## 能力雷达图');
      expect(md).toContain('## 学习曲线');
      expect(md).toContain('## 技能树');
      expect(md).toContain('## 知识盲区');
      expect(md).toContain('## 建议');
    });

    it('空数据应显示"暂无"', () => {
      const v = newVisualizer();
      const md = v.generateMarkdownReport();
      expect(md).toContain('暂无学习曲线数据') ; // 无数据源
    });
  });

  // ========== LLM 工具 ==========

  describe('LLM 工具', () => {
    it('应返回 8 个工具', () => {
      const v = newVisualizer();
      const tools = v.getToolDefinitions();
      expect(tools.length).toBe(8);
      const names = tools.map(t => t.name);
      expect(names).toContain('progress_overview');
      expect(names).toContain('progress_learning_curve');
      expect(names).toContain('progress_radar_chart');
      expect(names).toContain('progress_skill_tree');
      expect(names).toContain('progress_knowledge_gaps');
      expect(names).toContain('progress_trends');
      expect(names).toContain('progress_snapshot');
      expect(names).toContain('progress_report');
    });

    it('progress_overview 工具应返回统计', async () => {
      const v = newVisualizer();
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_overview')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result).toHaveProperty('snapshotsCount');
      expect(result).toHaveProperty('hasDataSource');
    });

    it('progress_learning_curve 工具应返回曲线', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord()],
      }));
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_learning_curve')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result).toHaveProperty('points');
      expect(result).toHaveProperty('granularity');
    });

    it('progress_radar_chart 工具应返回雷达图', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [makeDimension()],
      }));
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_radar_chart')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result).toHaveProperty('dimensions');
      expect(result).toHaveProperty('overallScore');
    });

    it('progress_skill_tree 工具应返回技能树', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getSkillLevels: () => [{ name: 'code', level: 5, progress: 50 } as SkillLevelLite],
      }));
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_skill_tree')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result).toHaveProperty('roots');
      expect(result).toHaveProperty('totalSkills');
    });

    it('progress_knowledge_gaps 工具应返回盲区视图', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getKnowledgeGaps: () => ['测试盲区'],
      }));
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_knowledge_gaps')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result).toHaveProperty('totalGaps');
      expect(result.totalGaps).toBe(1);
    });

    it('progress_trends 工具应返回趋势统计', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getEvolutionMetrics: () => [
          { id: 'm1', name: '指标1', description: '', category: 'intelligence', unit: '', target: 100, currentValue: 80, history: [], trend: 'improving', weight: 1, lastUpdated: Date.now() } as EvolutionMetricLite,
        ],
      }));
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_trends')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result.total).toBe(1);
      expect(result.improving).toBe(1);
    });

    it('progress_snapshot 工具应生成快照', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_snapshot')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result.success).toBe(true);
      expect(result.snapshot).toBeDefined();
      expect(v.getStats().snapshotsCount).toBe(1);
    });

    it('progress_report 工具默认返回 markdown', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_report')!;
      const result = await tool.execute!({} as never) as string;
      expect(result).toContain('# 学习进度报告');
    });

    it('progress_report 工具支持 json 格式', async () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource());
      const tool = v.getToolDefinitions().find(t => t.name === 'progress_report')!;
      const result = JSON.parse(await tool.execute!({ format: 'json' } as never) as string);
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('radarChart');
    });
  });

  // ========== 单例 ==========

  describe('单例', () => {
    it('getInstance 应返回同一实例', () => {
      const a = LearningProgressVisualizer.getInstance();
      const b = LearningProgressVisualizer.getInstance();
      expect(a).toBe(b);
    });

    it('getLearningProgressVisualizer 应返回单例', () => {
      const a = getLearningProgressVisualizer();
      const b = getLearningProgressVisualizer();
      expect(a).toBe(b);
    });

    it('_resetInstance 应重置单例', () => {
      const a = LearningProgressVisualizer.getInstance();
      LearningProgressVisualizer._resetInstance();
      const b = LearningProgressVisualizer.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ========== 边缘情况 ==========

  describe('边缘情况', () => {
    it('损坏的 snapshots.json 应降级为空', () => {
      const dir = path.join(tmpDir, 'progress');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'snapshots.json'), '{invalid json');
      const v = new LearningProgressVisualizer(dir);
      v.initialize();
      expect(v.getStats().snapshotsCount).toBe(0);
    });

    it('损坏的 reports.json 应降级为空', () => {
      const dir = path.join(tmpDir, 'progress');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'reports.json'), '{invalid json');
      const v = new LearningProgressVisualizer(dir);
      v.initialize();
      expect(v.getStats().reportsCount).toBe(0);
    });

    it('无 getUserProfile 方法应不报错', () => {
      const v = newVisualizer();
      v.setDataSource({
        getLearningRecords: () => [],
        // 没有 getUserProfile
      });
      const view = v.generateKnowledgeGapView();
      expect(view.totalGaps).toBe(0);
    });

    it('maxScore 为 0 时归一化应返回 0', () => {
      const v = newVisualizer();
      v.setDataSource(makeMockSource({
        getCapabilityDimensions: () => [
          makeDimension({ currentScore: 5, targetScore: 0 }),
        ],
      }));
      const radar = v.generateRadarChart();
      // target=0 → target=0, current=5/10*100=50
      expect(radar.dimensions[0].current).toBe(50);
      expect(radar.dimensions[0].target).toBe(0);
    });
  });
});
