import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LearningEvalSystem } from '../learning-eval-system.js';

describe('LearningEvalSystem', () => {
  let evalSys: LearningEvalSystem;

  beforeEach(() => {
    // load:false avoids pollution from persisted state on disk;
    // persist:false avoids leaking a setInterval across tests.
    evalSys = new LearningEvalSystem({ load: false, persist: false });
  });

  afterEach(() => {
    evalSys.dispose();
  });

  it('starts with zero accuracy', () => {
    expect(evalSys.getAccuracy()).toBe(0);
  });

  it('records a snapshot and updates accuracy', () => {
    evalSys.recordSnapshot({ accuracy: 0.9 }, 'test', 10);
    expect(evalSys.getAccuracy()).toBe(0.9);
  });

  it('averages accuracy over multiple snapshots', () => {
    evalSys.recordSnapshot({ accuracy: 0.8 }, 'test', 10);
    evalSys.recordSnapshot({ accuracy: 1.0 }, 'test', 10);
    expect(evalSys.getAccuracy()).toBeCloseTo(0.9, 2);
  });

  it('returns accuracy target not met initially', () => {
    expect(evalSys.isAccuracyTargetMet()).toBe(false);
  });

  it('detects accuracy target met when above 90%', () => {
    for (let i = 0; i < 50; i++) {
      evalSys.recordSnapshot({ accuracy: 0.92 }, 'test', 10);
    }
    expect(evalSys.isAccuracyTargetMet()).toBe(true);
  });

  it('generates report with all dimension scores', () => {
    evalSys.recordSnapshot({ accuracy: 0.85, efficiency: 0.7, coverage: 0.9, retention: 0.8, adaptation: 0.6 }, 'test', 50);
    const report = evalSys.generateReport();
    expect(report.accuracy).toBe(0.85);
    expect(report.dimensionScores).toHaveProperty('accuracy');
    expect(report.dimensionScores).toHaveProperty('efficiency');
    expect(report.dimensionScores).toHaveProperty('coverage');
    expect(report.dimensionScores).toHaveProperty('retention');
    expect(report.dimensionScores).toHaveProperty('adaptation');
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.trend).toMatch(/improving|stable|declining/);
  });

  it('generates warning when accuracy below target', () => {
    evalSys.recordSnapshot({ accuracy: 0.5 }, 'test', 10);
    const report = evalSys.generateReport();
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings[0]).toContain('低于目标');
  });

  it('creates and completes A/B test', () => {
    const test = evalSys.createABTest({
      id: 'test_001', variantA: 'v1', variantB: 'v2',
      dimension: 'accuracy', minSampleSize: 5,
    });
    expect(test.id).toBe('test_001');
    expect(test.startedAt).toBeGreaterThan(0);
    expect(evalSys.getABTest('test_001')).toBeDefined();
  });

  it('records A/B test results and determines winner', () => {
    evalSys.createABTest({ id: 'ab_001', variantA: 'old', variantB: 'new', dimension: 'accuracy', minSampleSize: 6 });
    for (let i = 0; i < 3; i++) {
      evalSys.recordABResult('ab_001', 'A', 0.7 + Math.random() * 0.1);
      evalSys.recordABResult('ab_001', 'B', 0.85 + Math.random() * 0.1);
    }
    const test = evalSys.getABTest('ab_001');
    expect(test).toBeDefined();
    if (test) {
      expect(test.winner).toBeDefined();
      expect(test.completedAt).toBeGreaterThan(0);
    }
  });

  it('lists active A/B tests', () => {
    evalSys.createABTest({ id: 'active_001', variantA: 'a', variantB: 'b', dimension: 'accuracy', minSampleSize: 100 });
    evalSys.createABTest({ id: 'active_002', variantA: 'x', variantB: 'y', dimension: 'efficiency', minSampleSize: 100 });
    const active = evalSys.getActiveABTests();
    expect(active.length).toBe(2);
  });

  it('provides tool definitions', () => {
    const tools = evalSys.getToolDefinitions();
    expect(tools.length).toBe(3);
    expect(tools.map(t => t.name)).toEqual(['eval_report', 'eval_create_abtest', 'eval_record_abresult']);
  });
});
