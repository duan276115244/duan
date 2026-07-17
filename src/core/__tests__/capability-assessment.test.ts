/**
 * 能力评估框架 — 自身测试
 *
 * 覆盖：
 * 1. 维度定义完整性（10 维度、指标权重和为 1.0）
 * 2. 评分公式正确性（higher/lower-better 边界）
 * 3. 适配器从现有系统拉取（mock）
 * 4. CapabilityAssessor 完整评估流程
 * 5. 报告生成（Markdown + HTML 结构）
 * 6. Runtime 埋点值读写
 * 7. Baseline 对比（topImprovements / topRegressions）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_METRICS,
  getMetricsByDimension,
  getMetricSpec,
} from '../capability-assessment/dimensions.js';
import { computeScore, CapabilityAssessor } from '../capability-assessment/assessor.js';
import { buildAdapters, fetchMetricValue } from '../capability-assessment/adapters.js';
import type { MetricSources, EvolutionMetricsLike, LearningEvalLike } from '../capability-assessment/adapters.js';
import { generateMarkdownReport, generateHtmlReport } from '../capability-assessment/report-generator.js';
import {
  recordRuntimeValue,
  loadRuntimeValues,
  clearRuntimeValues,
  _setRuntimeValuesFileForTesting,
} from '../capability-assessment/runtime-values.js';
import type { CapabilityReport, CapabilityTestSuite, CapabilityDimensionId } from '../capability-assessment/types.js';

// ============ Mock 数据源 ============

function makeMockEvolutionMetrics(): EvolutionMetricsLike {
  const metrics: Record<string, number> = {
    plan_quality: 80,
    task_completion_rate: 85,
    learning_velocity: 4,
    decision_accuracy: 88,
    error_rate: 12,
  };
  return {
    getMetric: (id: string) => (id in metrics ? { currentValue: metrics[id] } : undefined),
    getLastReport: () => ({ overallScore: 72 }),
  };
}

function makeMockLearningEval(): LearningEvalLike {
  return {
    getAccuracy: () => 0.88,
    generateReport: () => ({
      overallScore: 78,
      accuracy: 0.88,
      accuracyTarget: 0.9,
      accuracyMet: false,
      dimensionScores: {
        accuracy: 0.88,
        efficiency: 0.75,
        coverage: 0.82,
        retention: 0.79,
        adaptation: 0.70,
      },
      trend: 'stable' as const,
      velocity: 0.5,
      abTests: [],
      warnings: [],
    }),
  };
}

function makeMockSuite(score: number): CapabilityTestSuite {
  return {
    dimension: 'thinking' as CapabilityDimensionId,
    name: 'mock-suite',
    run: async () => [
      { caseId: 'case1', score },
      { caseId: 'case2', score },
      { caseId: 'case3', score },
    ],
  };
}

// ============ 测试 ============

describe('CapabilityAssessment Framework', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-capability-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------- 1. 维度定义完整性 ----------

  describe('维度定义完整性', () => {
    it('应有 10 个维度', () => {
      expect(CAPABILITY_DIMENSIONS).toHaveLength(10);
    });

    it('维度权重总和应为 1.0', () => {
      const total = CAPABILITY_DIMENSIONS.reduce((s, d) => s + d.weight, 0);
      expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    });

    it('每个维度至少有 1 个指标', () => {
      for (const dim of CAPABILITY_DIMENSIONS) {
        const metrics = getMetricsByDimension(dim.id);
        expect(metrics.length).toBeGreaterThan(0);
      }
    });

    it('每个维度的指标权重和应为 1.0', () => {
      for (const dim of CAPABILITY_DIMENSIONS) {
        const metrics = getMetricsByDimension(dim.id);
        const total = metrics.reduce((s, m) => s + m.weight, 0);
        expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
      }
    });

    it('所有指标 id 唯一', () => {
      const ids = CAPABILITY_METRICS.map(m => m.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('指标 id 可通过 getMetricSpec 查找', () => {
      for (const m of CAPABILITY_METRICS) {
        expect(getMetricSpec(m.id)).toBeDefined();
      }
    });
  });

  // ---------- 2. 评分公式 ----------

  describe('computeScore 评分公式', () => {
    it('higher-better: 值=目标 → 100 分', () => {
      expect(computeScore({ target: 90, lowerIsBetter: false }, 90)).toBeCloseTo(100, 1);
    });

    it('higher-better: 值=0 → 0 分', () => {
      expect(computeScore({ target: 90, lowerIsBetter: false }, 0)).toBe(0);
    });

    it('higher-better: 值=目标的 50% → 50 分', () => {
      expect(computeScore({ target: 100, lowerIsBetter: false }, 50)).toBeCloseTo(50, 1);
    });

    it('higher-better: 值=目标的 150% → 100 分（封顶）', () => {
      expect(computeScore({ target: 100, lowerIsBetter: false }, 150)).toBe(100);
    });

    it('higher-better: 值=目标的 200% → 100 分（封顶，非 200）', () => {
      expect(computeScore({ target: 100, lowerIsBetter: false }, 200)).toBe(100);
    });

    it('lower-better: 值=目标 → 50 分', () => {
      // score = max(0, 100 - (value/target)*50) = 100 - 50 = 50
      expect(computeScore({ target: 100, lowerIsBetter: true }, 100)).toBeCloseTo(50, 1);
    });

    it('lower-better: 值=0 → 100 分', () => {
      expect(computeScore({ target: 100, lowerIsBetter: true }, 0)).toBe(100);
    });

    it('lower-better: 值=目标的 200% → 0 分（触底）', () => {
      expect(computeScore({ target: 100, lowerIsBetter: true }, 200)).toBe(0);
    });

    it('target=0 → 0 分（避免除零）', () => {
      expect(computeScore({ target: 0, lowerIsBetter: false }, 100)).toBe(0);
    });
  });

  // ---------- 3. 适配器 ----------

  describe('适配器', () => {
    it('buildAdapters 应跳过未提供的源', () => {
      const adapters = buildAdapters({});
      expect(adapters.size).toBe(0);
    });

    it('buildAdapters 应注册已提供的源', () => {
      const adapters = buildAdapters({
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      });
      expect(adapters.has('evolution_metrics')).toBe(true);
      expect(adapters.has('learning_eval')).toBe(true);
      expect(adapters.has('memory_orchestrator')).toBe(false);
    });

    it('EvolutionMetricsAdapter 应拉取已有指标', async () => {
      const adapters = buildAdapters({ evolutionMetrics: makeMockEvolutionMetrics() });
      const { value } = await fetchMetricValue(adapters, 'evolution_metrics', 'task_completion_rate');
      expect(value).toBe(85);
    });

    it('EvolutionMetricsAdapter __overall__ 应取 lastReport.overallScore', async () => {
      const adapters = buildAdapters({ evolutionMetrics: makeMockEvolutionMetrics() });
      const { value } = await fetchMetricValue(adapters, 'evolution_metrics', '__overall__');
      expect(value).toBe(72);
    });

    it('EvolutionMetricsAdapter 拉取不存在的 key 应返回 null', async () => {
      const adapters = buildAdapters({ evolutionMetrics: makeMockEvolutionMetrics() });
      const { value } = await fetchMetricValue(adapters, 'evolution_metrics', 'nonexistent_key');
      expect(value).toBeNull();
    });

    it('LearningEvalAdapter 应拉取 retention 维度', async () => {
      const adapters = buildAdapters({ learningEval: makeMockLearningEval() });
      const { value } = await fetchMetricValue(adapters, 'learning_eval', 'retention');
      expect(value).toBe(0.79);
    });

    it('fetchMetricValue 缺失适配器应返回 null', async () => {
      const adapters = buildAdapters({});
      const { value, sourceLabel } = await fetchMetricValue(adapters, 'evolution_metrics', 'plan_quality');
      expect(value).toBeNull();
      expect(sourceLabel).toContain('unavailable');
    });
  });

  // ---------- 4. CapabilityAssessor 完整流程 ----------

  describe('CapabilityAssessor 完整评估', () => {
    it('应能运行评估并产出报告', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({
        sources,
        suites: { thinking: makeMockSuite(0.9) },
        dataPath: tmpDir,
      });
      const report = await assessor.runAssessment('current');

      expect(report).toBeDefined();
      expect(report.label).toBe('current');
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(100);
      expect(report.dimensions).toHaveLength(10);
    });

    it('未配置套件的 suite 指标应被跳过', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({ sources, dataPath: tmpDir });
      const report = await assessor.runAssessment('current');

      expect(report.skipped.length).toBeGreaterThan(0);
      const skippedIds = report.skipped.map(s => s.metricId);
      // thinking 维度的 suite 指标应被跳过
      expect(skippedIds).toContain('reasoning_depth');
      expect(skippedIds).toContain('solution_validity');
    });

    it('配置的套件应被运行并计入分数', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({
        sources,
        suites: { thinking: makeMockSuite(0.95) },
        dataPath: tmpDir,
      });
      const report = await assessor.runAssessment('current');

      const thinkingDim = report.dimensions.find(d => d.dimension === 'thinking');
      expect(thinkingDim).toBeDefined();
      const reasoningDepth = thinkingDim!.metrics.find(m => m.spec.id === 'reasoning_depth');
      expect(reasoningDepth).toBeDefined();
      expect(reasoningDepth!.error).toBeUndefined();
      // 套件均分 0.95，目标 0.85 → score = (0.95/0.85)*100 ≈ 111.7 封顶 100
      expect(reasoningDepth!.value).toBeCloseTo(0.95, 2);
    });

    it('runtime 埋点值应被 source=new 的指标使用', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({ sources, dataPath: tmpDir });
      assessor.recordRuntimeValue('on_time_completion_rate', 0.88);

      const report = await assessor.runAssessment('current');
      const execDim = report.dimensions.find(d => d.dimension === 'execution');
      const onTime = execDim!.metrics.find(m => m.spec.id === 'on_time_completion_rate');
      expect(onTime).toBeDefined();
      expect(onTime!.value).toBeCloseTo(0.88, 2);
      expect(onTime!.error).toBeUndefined();
    });
  });

  // ---------- 5. 报告生成 ----------

  describe('报告生成', () => {
    it('Markdown 报告应包含关键章节', () => {
      const report: CapabilityReport = {
        timestamp: Date.now(),
        label: 'current',
        overallScore: 75.5,
        dimensions: [
          {
            dimension: 'thinking',
            name: '思考能力',
            score: 80,
            weight: 0.12,
            metrics: [],
          },
        ],
        topImprovements: [{ metricId: 'thinking', metricName: '思考能力', delta: 5.2 }],
        topRegressions: [],
        recommendations: ['优先提升执行能力'],
        skipped: [],
      };
      const md = generateMarkdownReport(report);

      expect(md).toContain('能力评估报告');
      expect(md).toContain('总分');
      expect(md).toContain('10 维度记分卡');
      expect(md).toContain('思考能力');
      expect(md).toContain('Top 改进');
      expect(md).toContain('建议');
    });

    it('HTML 报告应包含关键元素', () => {
      const report: CapabilityReport = {
        timestamp: Date.now(),
        label: 'baseline',
        overallScore: 60,
        dimensions: [
          {
            dimension: 'execution',
            name: '执行能力',
            score: 65,
            weight: 0.12,
            metrics: [],
          },
        ],
        topImprovements: [],
        topRegressions: [],
        recommendations: [],
        skipped: [],
      };
      const html = generateHtmlReport(report);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('能力评估报告');
      expect(html).toContain('执行能力');
      expect(html).toContain('summary-card');
    });

    it('Markdown 报告应列出跳过的指标', () => {
      const report: CapabilityReport = {
        timestamp: Date.now(),
        label: 'current',
        overallScore: 50,
        dimensions: [],
        topImprovements: [],
        topRegressions: [],
        recommendations: [],
        skipped: [{ metricId: 'recall_latency_ms', reason: 'adapter-unavailable' }],
      };
      const md = generateMarkdownReport(report);
      expect(md).toContain('跳过的指标');
      expect(md).toContain('recall_latency_ms');
    });
  });

  // ---------- 6. Runtime 埋点值 ----------

  describe('Runtime 埋点值', () => {
    // 通过 _setRuntimeValuesFileForTesting() 将 runtime 埋点值文件重定向到 tmpDir，
    // 避免测试写入 ~/.duan/ 触发沙箱限制 + 消除跨用例污染 + 无需备份/恢复真实数据
    let testRuntimeFile: string;

    /** EPERM 安全的文件删除（Windows 并发 I/O 下可能瞬时锁定） */
    function safeUnlink(filePath: string, retries = 5): void {
      for (let i = 0; i < retries; i++) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          return;
        } catch {
          // EPERM/EBUSY: 等待 50ms 后重试
          const start = Date.now();
          while (Date.now() - start < 50) { /* busy-wait */ }
        }
      }
    }

    beforeEach(() => {
      // 每个用例使用独立的临时文件，避免跨用例污染
      testRuntimeFile = path.join(tmpDir, `runtime-values-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      _setRuntimeValuesFileForTesting(testRuntimeFile);
    });

    afterEach(() => {
      // 恢复默认路径 + 清理临时文件
      _setRuntimeValuesFileForTesting(null);
      safeUnlink(testRuntimeFile);
    });

    it('recordRuntimeValue + loadRuntimeValues 应往返', () => {
      recordRuntimeValue('test_metric_a', 0.92);
      recordRuntimeValue('test_metric_b', 42);
      const values = loadRuntimeValues();
      expect(values.test_metric_a).toBe(0.92);
      expect(values.test_metric_b).toBe(42);
    });

    it('loadRuntimeValues 对不存在的文件应返回空对象', () => {
      clearRuntimeValues();
      const values = loadRuntimeValues();
      expect(values).toEqual({});
    });

    it('clearRuntimeValues 应清除所有值', () => {
      recordRuntimeValue('test_metric_c', 1);
      clearRuntimeValues();
      expect(fs.existsSync(testRuntimeFile)).toBe(false);
    });
  });

  // ---------- 7. Baseline 对比 ----------

  describe('Baseline 对比', () => {
    it('无 baseline 时 topImprovements/topRegressions 应为空', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({ sources, dataPath: tmpDir });
      const report = await assessor.runAssessment('current');

      expect(report.topImprovements).toHaveLength(0);
      expect(report.topRegressions).toHaveLength(0);
      expect(report.baseline).toBeNull();
    });

    it('有 baseline 时应计算 delta', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({ sources, dataPath: tmpDir });

      // 先存 baseline
      await assessor.saveBaseline();
      // 再跑 current
      const report = await assessor.runAssessment('current');

      expect(report.baseline).not.toBeNull();
      // 同样的 sources，delta 应为 0 附近
      const delta = report.overallScore - report.baseline!.overallScore;
      expect(Math.abs(delta)).toBeLessThan(0.1);
    });

    it('baseline 持久化到磁盘并可加载', async () => {
      const sources: MetricSources = {
        evolutionMetrics: makeMockEvolutionMetrics(),
        learningEval: makeMockLearningEval(),
      };
      const assessor = new CapabilityAssessor({ sources, dataPath: tmpDir });
      await assessor.saveBaseline();

      // 新实例从磁盘加载
      const assessor2 = new CapabilityAssessor({ sources, dataPath: tmpDir });
      const loaded = assessor2.loadBaseline();
      expect(loaded).not.toBeNull();
      expect(loaded!.label).toBe('baseline');
    });
  });
});
