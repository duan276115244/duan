import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SelfAssessment } from '../self-assessment.js';

describe('SelfAssessment', () => {
  let sa: SelfAssessment;
  let tmpDir: string;
  let metricsFile: string;
  let reportFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-selfassess-'));
    metricsFile = path.join(tmpDir, 'metrics.json');
    reportFile = path.join(tmpDir, 'ASSESSMENT_REPORT.md');
    sa = new SelfAssessment(metricsFile, reportFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('record', () => {
    it('记录指标值，current更新为最近5次的平均值', () => {
      sa.record('task_completion_rate', 60);
      sa.record('task_completion_rate', 80);
      sa.record('task_completion_rate', 100);
      const metric = (sa as unknown).metrics.get('task_completion_rate');
      // (60 + 80 + 100) / 3 = 80
      expect(metric.current).toBe(80);
    });

    it('不存在的key不报错', () => {
      expect(() => sa.record('nonexistent_key', 100)).not.toThrow();
    });

    it('history超过100条时移除最旧的', () => {
      for (let i = 0; i < 105; i++) {
        sa.record('task_volume', i);
      }
      const metric = (sa as unknown).metrics.get('task_volume');
      expect(metric.history.length).toBe(100);
      // 最旧的5条被移除，最早值是5
      expect(metric.history[0].value).toBe(5);
    });

    it('trend: 连续记录递增值 → up', () => {
      sa.record('task_completion_rate', 10);
      sa.record('task_completion_rate', 20);
      sa.record('task_completion_rate', 30);
      sa.record('task_completion_rate', 40);
      sa.record('task_completion_rate', 50);
      const metric = (sa as unknown).metrics.get('task_completion_rate');
      expect(metric.trend).toBe('up');
    });

    it('trend: 连续记录递减值 → down', () => {
      sa.record('task_completion_rate', 50);
      sa.record('task_completion_rate', 40);
      sa.record('task_completion_rate', 30);
      sa.record('task_completion_rate', 20);
      sa.record('task_completion_rate', 10);
      const metric = (sa as unknown).metrics.get('task_completion_rate');
      expect(metric.trend).toBe('down');
    });

    it('trend: 小幅波动 → stable', () => {
      sa.record('task_completion_rate', 50);
      sa.record('task_completion_rate', 50);
      sa.record('task_completion_rate', 50);
      sa.record('task_completion_rate', 50);
      sa.record('task_completion_rate', 50);
      const metric = (sa as unknown).metrics.get('task_completion_rate');
      expect(metric.trend).toBe('stable');
    });
  });

  describe('recordTaskCompletion', () => {
    it('记录成功，task_completion_rate更新', () => {
      sa.recordTaskCompletion(true);
      const metric = (sa as unknown).metrics.get('task_completion_rate');
      expect(metric.current).toBe(100);
      expect(metric.history.length).toBe(1);
    });

    it('记录失败，task_completion_rate更新', () => {
      sa.recordTaskCompletion(false);
      const metric = (sa as unknown).metrics.get('task_completion_rate');
      expect(metric.current).toBe(0);
      expect(metric.history.length).toBe(1);
    });
  });

  describe('recordError', () => {
    it('记录错误，error_rate更新', () => {
      sa.recordError();
      const metric = (sa as unknown).metrics.get('error_rate');
      expect(metric.current).toBe(100);
      expect(metric.history.length).toBe(1);
    });
  });

  describe('recordToolSuccess', () => {
    it('记录成功，decision_accuracy更新', () => {
      sa.recordToolSuccess(true);
      const metric = (sa as unknown).metrics.get('decision_accuracy');
      expect(metric.current).toBe(100);
      expect(metric.history.length).toBe(1);
    });

    it('记录失败，decision_accuracy更新', () => {
      sa.recordToolSuccess(false);
      const metric = (sa as unknown).metrics.get('decision_accuracy');
      expect(metric.current).toBe(0);
      expect(metric.history.length).toBe(1);
    });
  });

  describe('updateCapabilityAverage / updateEvolutionLevel', () => {
    it('更新能力均值', () => {
      sa.updateCapabilityAverage(5);
      const metric = (sa as unknown).metrics.get('capability_average');
      expect(metric.current).toBe(5);
      expect(metric.history.length).toBe(1);
    });

    it('更新进化等级', () => {
      sa.updateEvolutionLevel(3);
      const metric = (sa as unknown).metrics.get('evolution_level');
      expect(metric.current).toBe(3);
      expect(metric.history.length).toBe(1);
    });
  });

  describe('generateReport', () => {
    it('返回AssessmentReport对象', () => {
      const report = sa.generateReport();
      expect(report).toBeDefined();
      expect(typeof report.timestamp).toBe('number');
      expect(typeof report.overall).toBe('number');
      expect(Array.isArray(report.metrics)).toBe(true);
      expect(typeof report.summary).toBe('string');
      expect(Array.isArray(report.improvements)).toBe(true);
      expect(Array.isArray(report.risks)).toBe(true);
    });

    it('overall在0-100之间', () => {
      const report = sa.generateReport();
      expect(report.overall).toBeGreaterThanOrEqual(0);
      expect(report.overall).toBeLessThanOrEqual(100);
    });

    it('metrics数组包含12个指标', () => {
      const report = sa.generateReport();
      expect(report.metrics).toHaveLength(12);
    });

    it('summary包含综合评分', () => {
      const report = sa.generateReport();
      expect(report.summary).toContain('综合评分');
    });

    it('无数据时improvements包含低指标', () => {
      const report = sa.generateReport();
      // 无数据时所有指标 current=0 < target*0.6
      expect(report.improvements.length).toBeGreaterThan(0);
    });

    it('有下降趋势时risks包含风险项', () => {
      // 制造下降趋势
      sa.record('task_completion_rate', 50);
      sa.record('task_completion_rate', 40);
      sa.record('task_completion_rate', 30);
      sa.record('task_completion_rate', 20);
      sa.record('task_completion_rate', 10);
      const report = sa.generateReport();
      expect(report.risks.length).toBeGreaterThan(0);
    });
  });

  describe('getFormattedReport', () => {
    it('返回包含"自评估报告"的字符串', () => {
      const report = sa.getFormattedReport();
      expect(typeof report).toBe('string');
      expect(report).toContain('自评估报告');
    });

    it('包含指标名称和数值', () => {
      sa.record('task_completion_rate', 80);
      const report = sa.getFormattedReport();
      expect(report).toContain('任务完成率');
    });
  });
});
