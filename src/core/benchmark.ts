/**
 * 测试框架与性能基准对比系统
 * Benchmark
 *
 * 核心能力：
 * 1. 基准测试 - 运行标准化测试集，评估系统性能
 * 2. 回归测试 - 确保优化不引入新问题
 * 3. 性能对比 - 优化前后指标对比
 * 4. 测试报告 - 生成详细的测试报告
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJson } from './atomic-write.js';

/** 测试用例 */
export interface TestCase {
  id: string;
  name: string;
  category: 'nlu' | 'reasoning' | 'memory' | 'security' | 'performance' | 'integration';
  input: string;
  expectedIntent?: string;
  expectedKeywords?: string[];
  expectedMinConfidence?: number;
  expectedMaxResponseTime?: number;  // ms
  context?: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

/** 测试结果 */
interface TestResult {
  testCaseId: string;
  passed: boolean;
  actualOutput?: string;
  actualIntent?: string;
  actualConfidence?: number;
  actualResponseTime?: number;
  errors: string[];
  duration: number;
  timestamp: Date;
}

/** 基准快照 */
interface BenchmarkSnapshot {
  id: string;
  name: string;
  timestamp: Date;
  results: TestResult[];
  summary: BenchmarkSummary;
  gitCommit?: string;
}

/** 基准摘要 */
interface BenchmarkSummary {
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  avgResponseTime: number;
  avgConfidence: number;
  categoryBreakdown: Record<string, { total: number; passed: number; passRate: number }>;
}

/** 对比结果 */
interface ComparisonResult {
  baseline: BenchmarkSummary;
  current: BenchmarkSummary;
  improvements: string[];
  regressions: string[];
  overallChange: 'improved' | 'stable' | 'regressed';
}

/** runAll 运行选项 */
interface RunOptions {
  /**
   * 并发数。当处理器无副作用时可设置 > 1 以并发执行测试用例。
   * 默认为 1（串行执行，保证与原行为兼容）。
   */
  concurrency?: number;
}

export class Benchmark {
  private testCases: TestCase[] = [];
  /** id -> TestCase 的索引，避免反复 O(n) 查找 */
  private testCaseMap: Map<string, TestCase> = new Map();
  private snapshots: BenchmarkSnapshot[] = [];
  private dataDir: string;

  constructor(dataDir: string = './data/benchmarks') {
    this.dataDir = dataDir;
    this.initializeTestCases();
  }

  /**
   * 运行所有测试
   *
   * 默认串行执行。若处理器无副作用，可通过 options.concurrency 配置并发执行以提升吞吐。
   */
  async runAll(
    processor: (input: string, context?: string) => Promise<{
      response: string;
      intent?: string;
      confidence?: number;
      processingTime?: number;
    }>,
    options: RunOptions = {}
  ): Promise<BenchmarkSnapshot> {
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const results: TestResult[] = new Array(this.testCases.length);

    if (concurrency === 1) {
      // 串行执行，保持与原行为一致
      for (let i = 0; i < this.testCases.length; i++) {
        results[i] = await this.runSingle(this.testCases[i], processor);
      }
    } else {
      // 并发执行（仅适用于无副作用的处理器），使用索引保证结果顺序稳定
      let nextIndex = 0;
      const workerCount = Math.min(concurrency, this.testCases.length);
      const worker = async (): Promise<void> => {
        while (true) {
          const current = nextIndex++;
          if (current >= this.testCases.length) break;
          results[current] = await this.runSingle(this.testCases[current], processor);
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    const summary = this.computeSummary(results);

    const snapshot: BenchmarkSnapshot = {
      id: `bench_${Date.now()}`,
      name: `Benchmark ${new Date().toISOString()}`,
      timestamp: new Date(),
      results,
      summary,
    };

    this.snapshots.push(snapshot);
    await this.saveSnapshot(snapshot);

    return snapshot;
  }

  /**
   * 运行单个测试
   */
  private async runSingle(
    testCase: TestCase,
    processor: (input: string, context?: string) => Promise<{ response: string; intent?: string; confidence?: number; processingTime?: number }>
  ): Promise<TestResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let passed = true;
    let actualOutput: string | undefined;
    let actualIntent: string | undefined;
    let actualConfidence: number | undefined;
    let actualResponseTime: number | undefined;

    try {
      const result = await processor(testCase.input, testCase.context);

      actualOutput = result.response;
      actualIntent = result.intent;
      actualConfidence = result.confidence;
      actualResponseTime = result.processingTime || (Date.now() - startTime);

      // 验证意图
      if (testCase.expectedIntent && actualIntent !== testCase.expectedIntent) {
        errors.push(`意图不匹配: 期望 "${testCase.expectedIntent}", 实际 "${actualIntent}"`);
        passed = false;
      }

      // 验证置信度
      if (testCase.expectedMinConfidence && (actualConfidence || 0) < testCase.expectedMinConfidence) {
        errors.push(`置信度过低: 期望 >= ${testCase.expectedMinConfidence}, 实际 ${actualConfidence}`);
        passed = false;
      }

      // 验证响应时间
      if (testCase.expectedMaxResponseTime && actualResponseTime !== undefined && actualResponseTime > testCase.expectedMaxResponseTime) {
        errors.push(`响应时间过长: 期望 <= ${testCase.expectedMaxResponseTime}ms, 实际 ${actualResponseTime}ms`);
        passed = false;
      }

      // 验证关键词
      if (testCase.expectedKeywords) {
        const outputLower = (actualOutput || '').toLowerCase();
        const missingKeywords = testCase.expectedKeywords.filter(
          kw => !outputLower.includes(kw.toLowerCase())
        );
        if (missingKeywords.length > 0) {
          errors.push(`缺少关键词: ${missingKeywords.join(', ')}`);
          passed = false;
        }
      }

    } catch (error: unknown) {
      passed = false;
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`执行错误: ${msg}`);
    }

    return {
      testCaseId: testCase.id,
      passed,
      actualOutput,
      actualIntent,
      actualConfidence,
      actualResponseTime,
      errors,
      duration: Date.now() - startTime,
      timestamp: new Date(),
    };
  }

  /**
   * 与基准对比
   */
  compareWithBaseline(current: BenchmarkSnapshot): ComparisonResult {
    const baseline = this.snapshots.length > 1
      ? this.snapshots[this.snapshots.length - 2]
      : current;

    const improvements: string[] = [];
    const regressions: string[] = [];

    // 对比通过率
    if (current.summary.passRate > baseline.summary.passRate) {
      improvements.push(`通过率提升: ${(baseline.summary.passRate * 100).toFixed(1)}% → ${(current.summary.passRate * 100).toFixed(1)}%`);
    } else if (current.summary.passRate < baseline.summary.passRate) {
      regressions.push(`通过率下降: ${(baseline.summary.passRate * 100).toFixed(1)}% → ${(current.summary.passRate * 100).toFixed(1)}%`);
    }

    // 对比响应时间
    if (current.summary.avgResponseTime < baseline.summary.avgResponseTime * 0.9) {
      improvements.push(`响应时间改善: ${baseline.summary.avgResponseTime.toFixed(0)}ms → ${current.summary.avgResponseTime.toFixed(0)}ms`);
    } else if (current.summary.avgResponseTime > baseline.summary.avgResponseTime * 1.1) {
      regressions.push(`响应时间退化: ${baseline.summary.avgResponseTime.toFixed(0)}ms → ${current.summary.avgResponseTime.toFixed(0)}ms`);
    }

    // 对比置信度
    if (current.summary.avgConfidence > baseline.summary.avgConfidence + 0.05) {
      improvements.push(`置信度提升: ${baseline.summary.avgConfidence.toFixed(2)} → ${current.summary.avgConfidence.toFixed(2)}`);
    } else if (current.summary.avgConfidence < baseline.summary.avgConfidence - 0.05) {
      regressions.push(`置信度下降: ${baseline.summary.avgConfidence.toFixed(2)} → ${current.summary.avgConfidence.toFixed(2)}`);
    }

    // 对比各类别
    for (const category of Object.keys(current.summary.categoryBreakdown)) {
      const currentCat = current.summary.categoryBreakdown[category];
      const baselineCat = baseline.summary.categoryBreakdown[category];

      if (baselineCat && currentCat.passRate > baselineCat.passRate + 0.05) {
        improvements.push(`${category}类别通过率提升: ${(baselineCat.passRate * 100).toFixed(1)}% → ${(currentCat.passRate * 100).toFixed(1)}%`);
      } else if (baselineCat && currentCat.passRate < baselineCat.passRate - 0.05) {
        regressions.push(`${category}类别通过率下降: ${(baselineCat.passRate * 100).toFixed(1)}% → ${(currentCat.passRate * 100).toFixed(1)}%`);
      }
    }

    let overallChange: ComparisonResult['overallChange'] = 'stable';
    if (improvements.length > regressions.length) {
      overallChange = 'improved';
    } else if (regressions.length > improvements.length) {
      overallChange = 'regressed';
    }

    return {
      baseline: baseline.summary,
      current: current.summary,
      improvements,
      regressions,
      overallChange,
    };
  }

  /**
   * 生成测试报告
   */
  generateReport(snapshot: BenchmarkSnapshot): string {
    const comparison = this.compareWithBaseline(snapshot);
    const lines: string[] = [];

    lines.push('🧪 性能基准测试报告');
    lines.push(`测试时间: ${snapshot.timestamp.toLocaleString('zh-CN')}`);
    lines.push(`测试名称: ${snapshot.name}`);
    lines.push('');

    // 总体结果
    lines.push('━━━ 总体结果 ━━━');
    lines.push(`总测试数: ${snapshot.summary.totalTests}`);
    lines.push(`通过: ${snapshot.summary.passed} ✅`);
    lines.push(`失败: ${snapshot.summary.failed} ❌`);
    lines.push(`通过率: ${(snapshot.summary.passRate * 100).toFixed(1)}%`);
    lines.push(`平均响应时间: ${snapshot.summary.avgResponseTime.toFixed(0)}ms`);
    lines.push(`平均置信度: ${snapshot.summary.avgConfidence.toFixed(2)}`);
    lines.push('');

    // 分类结果
    lines.push('━━━ 分类结果 ━━━');
    for (const [category, data] of Object.entries(snapshot.summary.categoryBreakdown)) {
      let icon: string;
      if (data.passRate >= 0.8) icon = '✅';
      else if (data.passRate >= 0.5) icon = '🟡';
      else icon = '❌';
      lines.push(`${icon} ${category}: ${data.passed}/${data.total} (${(data.passRate * 100).toFixed(1)}%)`);
    }
    lines.push('');

    // 优化前后对比
    lines.push('━━━ 优化前后对比 ━━━');
    let overallChangeLabel: string;
    if (comparison.overallChange === 'improved') {
      overallChangeLabel = '✅ 改善';
    } else if (comparison.overallChange === 'regressed') {
      overallChangeLabel = '❌ 退化';
    } else {
      overallChangeLabel = '➡️ 稳定';
    }
    lines.push(`整体变化: ${overallChangeLabel}`);
    lines.push('');

    if (comparison.improvements.length > 0) {
      lines.push('改善项:');
      for (const imp of comparison.improvements) {
        lines.push(`  ✅ ${imp}`);
      }
      lines.push('');
    }

    if (comparison.regressions.length > 0) {
      lines.push('退化项:');
      for (const reg of comparison.regressions) {
        lines.push(`  ❌ ${reg}`);
      }
      lines.push('');
    }

    // 失败详情
    const failedTests = snapshot.results.filter(r => !r.passed);
    if (failedTests.length > 0) {
      lines.push('━━━ 失败详情 ━━━');
      for (const failed of failedTests) {
        const testCase = this.testCaseMap.get(failed.testCaseId);
        lines.push(`❌ ${testCase?.name || failed.testCaseId}:`);
        for (const error of failed.errors) {
          lines.push(`   - ${error}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取测试用例
   */
  getTestCases(): TestCase[] {
    return [...this.testCases];
  }

  /**
   * 添加测试用例
   */
  addTestCase(testCase: TestCase): void {
    this.testCases.push(testCase);
    this.testCaseMap.set(testCase.id, testCase);
  }

  /**
   * 获取历史快照
   */
  getSnapshots(): BenchmarkSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * 加载历史数据
   */
  async load(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const files = await fs.readdir(this.dataDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().slice(-10);

      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
          const snapshot = JSON.parse(content);
          snapshot.timestamp = new Date(snapshot.timestamp);
          this.snapshots.push(snapshot);
        } catch {
          // 跳过
        }
      }
    } catch {
      // 目录不存在
    }
  }

  // ========== 私有方法 ==========

  private computeSummary(results: TestResult[]): BenchmarkSummary {
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;

    const categoryBreakdown: Record<string, { total: number; passed: number; passRate: number }> = {};
    for (const result of results) {
      const testCase = this.testCaseMap.get(result.testCaseId);
      const category = testCase?.category || 'unknown';

      if (!categoryBreakdown[category]) {
        categoryBreakdown[category] = { total: 0, passed: 0, passRate: 0 };
      }
      categoryBreakdown[category].total++;
      if (result.passed) {
        categoryBreakdown[category].passed++;
      }
    }

    for (const cat of Object.keys(categoryBreakdown)) {
      const data = categoryBreakdown[cat];
      data.passRate = data.total > 0 ? data.passed / data.total : 0;
    }

    const responseTimes = results.map(r => r.duration).filter(d => d > 0);
    const confidences = results.map(r => r.actualConfidence).filter((c): c is number => c !== undefined);

    return {
      totalTests: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? passed / results.length : 0,
      avgResponseTime: responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
      avgConfidence: confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
      categoryBreakdown,
    };
  }

  private async saveSnapshot(snapshot: BenchmarkSnapshot): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const filePath = path.join(this.dataDir, `benchmark-${date}-${snapshot.id}.json`);
      await atomicWriteJson(filePath, snapshot);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('保存基准快照失败', { module: 'Benchmark', error: msg });
    }
  }

  /**
   * 初始化标准测试用例
   */
  private initializeTestCases(): void {
    this.testCases = [
      // ---- NLU 测试 ----
      {
        id: 'nlu_001',
        name: '代码生成意图识别',
        category: 'nlu',
        input: '帮我写一个排序函数',
        expectedIntent: 'code_generation',
        expectedMinConfidence: 0.7,
        difficulty: 'easy',
      },
      {
        id: 'nlu_002',
        name: '架构分析意图识别',
        category: 'nlu',
        input: '分析这个系统的架构设计',
        expectedIntent: 'architecture_analysis',
        expectedMinConfidence: 0.7,
        difficulty: 'easy',
      },
      {
        id: 'nlu_003',
        name: '性能优化意图识别',
        category: 'nlu',
        input: '这个接口太慢了，怎么优化',
        expectedIntent: 'performance_optimization',
        expectedMinConfidence: 0.7,
        difficulty: 'easy',
      },
      {
        id: 'nlu_004',
        name: '对比分析意图识别',
        category: 'nlu',
        input: 'React和Vue哪个好',
        expectedIntent: 'comparison',
        expectedMinConfidence: 0.6,
        difficulty: 'medium',
      },
      {
        id: 'nlu_005',
        name: '安全审计意图识别',
        category: 'nlu',
        input: '检查代码中的安全漏洞',
        expectedIntent: 'security_audit',
        expectedMinConfidence: 0.7,
        difficulty: 'easy',
      },

      // ---- 推理测试 ----
      {
        id: 'reason_001',
        name: '简单逻辑推理',
        category: 'reasoning',
        input: '如果A大于B，B大于C，那么A和C的关系是什么？',
        expectedKeywords: ['大于', 'A', 'C'],
        expectedMinConfidence: 0.7,
        difficulty: 'easy',
      },
      {
        id: 'reason_002',
        name: '多步推理',
        category: 'reasoning',
        input: '一个项目有3个模块，每个模块有5个功能点，每个功能点需要2天开发，1天测试，整个项目需要多少天完成？',
        expectedKeywords: ['天', '30', '模块'],
        expectedMinConfidence: 0.6,
        difficulty: 'medium',
      },
      {
        id: 'reason_003',
        name: '因果推理',
        category: 'reasoning',
        input: '为什么高并发场景下数据库连接池会耗尽？',
        expectedKeywords: ['连接', '并发', '池'],
        expectedMinConfidence: 0.6,
        difficulty: 'hard',
      },

      // ---- 安全测试 ----
      {
        id: 'sec_001',
        name: 'PII检测-手机号',
        category: 'security',
        input: '我的手机号是13812345678，请帮我注册',
        expectedKeywords: ['***', '脱敏', '隐藏'],
        difficulty: 'easy',
      },
      {
        id: 'sec_002',
        name: 'PII检测-API密钥',
        category: 'security',
        input: '我的API key是sk-abc123def456ghi789jkl012mno345',
        expectedKeywords: ['***', '隐藏', '脱敏'],
        difficulty: 'easy',
      },

      // ---- 性能测试 ----
      {
        id: 'perf_001',
        name: '简单查询响应时间',
        category: 'performance',
        input: '什么是TypeScript？',
        expectedMaxResponseTime: 5000,
        expectedMinConfidence: 0.5,
        difficulty: 'easy',
      },
      {
        id: 'perf_002',
        name: '复杂查询响应时间',
        category: 'performance',
        input: '请分析微服务架构的优缺点，并给出在什么场景下应该选择微服务而不是单体架构',
        expectedMaxResponseTime: 10000,
        expectedMinConfidence: 0.5,
        difficulty: 'hard',
      },

      // ---- 集成测试 ----
      {
        id: 'int_001',
        name: '端到端处理流程',
        category: 'integration',
        input: '帮我设计一个用户认证系统的API接口',
        expectedKeywords: ['API', '认证', '接口'],
        expectedMinConfidence: 0.5,
        difficulty: 'medium',
      },
      {
        id: 'int_002',
        name: '多轮对话上下文',
        category: 'integration',
        input: '首先，什么是Docker？然后，如何在项目中使用Docker？',
        expectedKeywords: ['Docker', '容器'],
        expectedMinConfidence: 0.5,
        difficulty: 'medium',
      },
    ];

    // 构建 id -> TestCase 索引，供 computeSummary / generateReport O(1) 查找
    this.testCaseMap = new Map(this.testCases.map(tc => [tc.id, tc]));
  }
}

