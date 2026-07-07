/**
 * 4 个新增能力评估套件的结构与评分正确性测试
 *
 * 覆盖：
 * 1. 套件结构完整性（dimension/name/run 方法）
 * 2. caseId 与 dimensions.ts 指标 id 一一对应
 * 3. score 值域合法性（比率类 0-1，延迟/吞吐量为正数）
 * 4. 评分逻辑正确性（嵌入用例的预期结果与 scorer 判定一致）
 */

import { describe, it, expect } from 'vitest';
import { getMetricsByDimension } from '../capability-assessment/dimensions.js';
import type { CapabilityTestSuite } from '../capability-assessment/types.js';
import computerOpsSuite from '../capability-assessment/suites/computer-ops.suite.js';
import codeSuite from '../capability-assessment/suites/code.suite.js';
import inferenceSuite from '../capability-assessment/suites/inference.suite.js';
import crossPlatformSuite from '../capability-assessment/suites/cross-platform.suite.js';

// ============ 辅助函数 ============

/** 校验套件结构 */
function expectValidSuite(suite: CapabilityTestSuite, dimension: string, namePattern: RegExp): void {
  expect(suite.dimension).toBe(dimension);
  expect(suite.name).toMatch(namePattern);
  expect(typeof suite.run).toBe('function');
}

/** 校验 caseId 与 dimensions.ts 指标 id 一一对应 */
async function expectCaseIdsMatchMetrics(
  suite: CapabilityTestSuite,
  dimension: string,
): Promise<void> {
  const metrics = getMetricsByDimension(dimension);
  const suiteMetrics = metrics.filter(m => m.source === 'suite');
  const results = await suite.run();
  const caseIds = results.map(r => r.caseId).sort();
  const metricIds = suiteMetrics.map(m => m.id).sort();
  expect(caseIds).toEqual(metricIds);
}

/** 校验比率类 score 在 0-1 范围 */
function expectRatioScore(score: number): void {
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThanOrEqual(1);
}

/** 校验正数 score（延迟/吞吐量） */
function expectPositiveScore(score: number): void {
  expect(score).toBeGreaterThan(0);
}

// ============ computer_ops 套件测试 ============

describe('computer-ops.suite', () => {
  it('套件结构完整', () => {
    expectValidSuite(computerOpsSuite, 'computer_ops', /电脑操作/);
  });

  it('caseId 与 dimensions.ts suite 源指标一一对应', async () => {
    await expectCaseIdsMatchMetrics(computerOpsSuite, 'computer_ops');
  });

  it('op_success_rate score 在 0-1 范围', async () => {
    const results = await computerOpsSuite.run();
    const op = results.find(r => r.caseId === 'op_success_rate');
    expect(op).toBeDefined();
    expectRatioScore(op!.score);
  });

  it('focus_recovery_rate score 在 0-1 范围', async () => {
    const results = await computerOpsSuite.run();
    const fr = results.find(r => r.caseId === 'focus_recovery_rate');
    expect(fr).toBeDefined();
    expectRatioScore(fr!.score);
  });

  it('parallel_throughput score 为正数（ops/sec）', async () => {
    const results = await computerOpsSuite.run();
    const pt = results.find(r => r.caseId === 'parallel_throughput');
    expect(pt).toBeDefined();
    expectPositiveScore(pt!.score);
  });

  it('op_success_rate 应正确判定无效快捷键失败', async () => {
    const results = await computerOpsSuite.run();
    const op = results.find(r => r.caseId === 'op_success_rate');
    // 5 个用例中 4 个应成功、1 个无效组合应失败，score 应为 1.0（全对）
    expect(op!.score).toBe(1.0);
  });

  it('focus_recovery_rate 应正确判定 orphan_process 不可恢复', async () => {
    const results = await computerOpsSuite.run();
    const fr = results.find(r => r.caseId === 'focus_recovery_rate');
    // 4 个场景全部正确预测，score 应为 1.0
    expect(fr!.score).toBe(1.0);
  });
});

// ============ code 套件测试 ============

describe('code.suite', () => {
  it('套件结构完整', () => {
    expectValidSuite(codeSuite, 'code', /代码能力/);
  });

  it('caseId 与 dimensions.ts suite 源指标一一对应', async () => {
    await expectCaseIdsMatchMetrics(codeSuite, 'code');
  });

  it('code_correctness score 在 0-1 范围', async () => {
    const results = await codeSuite.run();
    const cc = results.find(r => r.caseId === 'code_correctness');
    expect(cc).toBeDefined();
    expectRatioScore(cc!.score);
  });

  it('refactor_safety score 在 0-1 范围', async () => {
    const results = await codeSuite.run();
    const rs = results.find(r => r.caseId === 'refactor_safety');
    expect(rs).toBeDefined();
    expectRatioScore(rs!.score);
  });

  it('debug_loop_success score 在 0-1 范围', async () => {
    const results = await codeSuite.run();
    const dl = results.find(r => r.caseId === 'debug_loop_success');
    expect(dl).toBeDefined();
    expectRatioScore(dl!.score);
  });

  it('code_correctness 应识别回文 bug 和二分查找 bug', async () => {
    const results = await codeSuite.run();
    const cc = results.find(r => r.caseId === 'code_correctness');
    // 5 个用例全部正确预测（3 shouldPass + 2 shouldNotPass），score 应为 1.0
    expect(cc!.score).toBe(1.0);
  });

  it('refactor_safety 应检测箭头函数 this 绑定丢失', async () => {
    const results = await codeSuite.run();
    const rs = results.find(r => r.caseId === 'refactor_safety');
    // 4 个用例全部正确预测，score 应为 1.0
    expect(rs!.score).toBe(1.0);
  });
});

// ============ inference 套件测试 ============

describe('inference.suite', () => {
  it('套件结构完整', () => {
    expectValidSuite(inferenceSuite, 'inference', /推理能力/);
  });

  it('caseId 与 dimensions.ts suite 源指标一一对应', async () => {
    await expectCaseIdsMatchMetrics(inferenceSuite, 'inference');
  });

  it('causal_accuracy score 在 0-1 范围', async () => {
    const results = await inferenceSuite.run();
    const ca = results.find(r => r.caseId === 'causal_accuracy');
    expect(ca).toBeDefined();
    expectRatioScore(ca!.score);
  });

  it('prediction_accuracy score 在 0-1 范围', async () => {
    const results = await inferenceSuite.run();
    const pa = results.find(r => r.caseId === 'prediction_accuracy');
    expect(pa).toBeDefined();
    expectRatioScore(pa!.score);
  });

  it('counterfactual_validity score 在 0-1 范围', async () => {
    const results = await inferenceSuite.run();
    const cv = results.find(r => r.caseId === 'counterfactual_validity');
    expect(cv).toBeDefined();
    expectRatioScore(cv!.score);
  });

  it('prediction_accuracy 应正确模拟状态转移', async () => {
    const results = await inferenceSuite.run();
    const pa = results.find(r => r.caseId === 'prediction_accuracy');
    // 4 个预测用例全部正确比对（3 correct + 1 incorrect），score 应为 1.0
    expect(pa!.score).toBe(1.0);
  });
});

// ============ cross_platform 套件测试 ============

describe('cross-platform.suite', () => {
  it('套件结构完整', () => {
    expectValidSuite(crossPlatformSuite, 'cross_platform', /三端互通/);
  });

  it('caseId 与 dimensions.ts suite 源指标一一对应', async () => {
    await expectCaseIdsMatchMetrics(crossPlatformSuite, 'cross_platform');
  });

  it('sync_consistency score 在 0-1 范围', async () => {
    const results = await crossPlatformSuite.run();
    const sc = results.find(r => r.caseId === 'sync_consistency');
    expect(sc).toBeDefined();
    expectRatioScore(sc!.score);
  });

  it('sync_latency_ms score 为正数（毫秒）', async () => {
    const results = await crossPlatformSuite.run();
    const sl = results.find(r => r.caseId === 'sync_latency_ms');
    expect(sl).toBeDefined();
    expectPositiveScore(sl!.score);
  });

  it('pwa_installability score 在 0-1 范围', async () => {
    const results = await crossPlatformSuite.run();
    const pi = results.find(r => r.caseId === 'pwa_installability');
    expect(pi).toBeDefined();
    expectRatioScore(pi!.score);
  });

  it('conflict_resolution_rate score 在 0-1 范围', async () => {
    const results = await crossPlatformSuite.run();
    const cr = results.find(r => r.caseId === 'conflict_resolution_rate');
    expect(cr).toBeDefined();
    expectRatioScore(cr!.score);
  });

  it('pwa_installability 应检测缺失字段、无 SW、browser 模式', async () => {
    const results = await crossPlatformSuite.run();
    const pi = results.find(r => r.caseId === 'pwa_installability');
    // 5 个 PWA 场景全部正确判定，score 应为 1.0
    expect(pi!.score).toBe(1.0);
  });

  it('sync_latency_ms 应低于 2000ms target（本地模拟无网络）', async () => {
    const results = await crossPlatformSuite.run();
    const sl = results.find(r => r.caseId === 'sync_latency_ms');
    // 本地模拟应远低于 2000ms target
    expect(sl!.score).toBeLessThan(2000);
  });
});
