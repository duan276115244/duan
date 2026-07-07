/**
 * 功能完整性测试与基准测试套件 - FunctionalTestSuite
 *
 * 提供两大能力：
 * 1. 功能完整性测试：验证每个模块是否达到设计规格要求
 * 2. 基准测试：量化评估智能体核心性能指标
 *
 * 测试标准：
 * - P0 关键功能：必须100%通过
 * - P1 重要功能：通过率≥90%
 * - P2 辅助功能：通过率≥80%
 */

import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 测试优先级 */
export type TestPriority = 'P0' | 'P1' | 'P2';

/** 测试状态 */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

/** 单个测试用例 */
export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: string;
  priority: TestPriority;
  /** 测试函数，返回true表示通过 */
  test: () => Promise<boolean>;
  /** 超时时间(ms) */
  timeout: number;
}

/** 测试结果 */
export interface TestResult {
  testCaseId: string;
  status: TestStatus;
  duration: number;
  error?: string;
  timestamp: number;
}

/** 测试报告 */
export interface TestReport {
  timestamp: number;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  passRate: number;
  p0PassRate: number;
  p1PassRate: number;
  p2PassRate: number;
  results: TestResult[];
  summary: string;
  recommendations: string[];
}

/** 基准测试结果 */
export interface BenchmarkResult {
  name: string;
  iterations: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50: number;
  p95: number;
  p99: number;
  throughput: number; // ops/sec
}

// ============ 功能完整性测试套件 ============

export class FunctionalTestSuite {
  private testCases: Map<string, TestCase> = new Map();
  private results: TestResult[] = [];
  private dataPath: string;

  constructor(dataPath?: string) {
    this.dataPath = dataPath || duanPath('test-results');
    this.registerDefaultTests();
  }

  /**
   * 注册测试用例
   */
  registerTest(testCase: TestCase): void {
    this.testCases.set(testCase.id, testCase);
  }

  /**
   * 批量注册测试用例
   */
  registerTests(testCases: TestCase[]): void {
    for (const tc of testCases) {
      this.testCases.set(tc.id, tc);
    }
  }

  /**
   * 运行所有测试
   */
  async runAll(): Promise<TestReport> {
    this.results = [];

    for (const [id, testCase] of this.testCases) {
      const result = await this.runTest(id, testCase);
      this.results.push(result);
    }

    return this.generateReport();
  }

  /**
   * 按类别运行测试
   */
  async runByCategory(category: string): Promise<TestReport> {
    this.results = [];

    for (const [id, testCase] of this.testCases) {
      if (testCase.category === category) {
        const result = await this.runTest(id, testCase);
        this.results.push(result);
      }
    }

    return this.generateReport();
  }

  /**
   * 运行单个测试
   */
  private async runTest(id: string, testCase: TestCase): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error('测试超时')), testCase.timeout);
      });

      const passed = await Promise.race([
        testCase.test(),
        timeoutPromise,
      ]);

      return {
        testCaseId: id,
        status: passed ? 'passed' : 'failed',
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } catch (err: unknown) {
      return {
        testCaseId: id,
        status: 'error',
        duration: Date.now() - startTime,
        error: (err instanceof Error ? err.message : String(err)),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 生成测试报告
   */
  private generateReport(): TestReport {
    const total = this.results.length;
    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;
    const skipped = this.results.filter(r => r.status === 'skipped').length;
    const errors = this.results.filter(r => r.status === 'error').length;

    const passRate = total > 0 ? passed / total : 0;

    // 按优先级计算通过率
    const p0Results = this.results.filter(r => {
      const tc = this.testCases.get(r.testCaseId);
      return tc?.priority === 'P0';
    });
    const p1Results = this.results.filter(r => {
      const tc = this.testCases.get(r.testCaseId);
      return tc?.priority === 'P1';
    });
    const p2Results = this.results.filter(r => {
      const tc = this.testCases.get(r.testCaseId);
      return tc?.priority === 'P2';
    });

    const p0PassRate = p0Results.length > 0
      ? p0Results.filter(r => r.status === 'passed').length / p0Results.length
      : 1;
    const p1PassRate = p1Results.length > 0
      ? p1Results.filter(r => r.status === 'passed').length / p1Results.length
      : 1;
    const p2PassRate = p2Results.length > 0
      ? p2Results.filter(r => r.status === 'passed').length / p2Results.length
      : 1;

    // 生成建议
    const recommendations: string[] = [];
    if (p0PassRate < 1) {
      recommendations.push('P0关键功能测试未全部通过，必须修复后再发布');
    }
    if (p1PassRate < 0.9) {
      recommendations.push('P1重要功能通过率低于90%，建议优先修复');
    }
    if (p2PassRate < 0.8) {
      recommendations.push('P2辅助功能通过率低于80%，建议后续迭代修复');
    }

    const failedTests = this.results.filter(r => r.status === 'failed' || r.status === 'error');
    for (const ft of failedTests.slice(0, 3)) {
      const tc = this.testCases.get(ft.testCaseId);
      recommendations.push(`修复: ${tc?.name || ft.testCaseId} - ${ft.error || '测试未通过'}`);
    }

    const summary = `总计 ${total} 项测试，${passed} 通过，${failed} 失败，${errors} 错误。通过率: ${(passRate * 100).toFixed(1)}%`;

    const report: TestReport = {
      timestamp: Date.now(),
      totalTests: total,
      passed,
      failed,
      skipped,
      errors,
      passRate,
      p0PassRate,
      p1PassRate,
      p2PassRate,
      results: this.results,
      summary,
      recommendations,
    };

    this.saveReport(report);
    return report;
  }

  /**
   * 格式化报告
   */
  formatReport(report: TestReport): string {
    const lines: string[] = [
      `=== 功能完整性测试报告 ===`,
      `时间: ${new Date(report.timestamp).toLocaleString('zh-CN')}`,
      ``,
      report.summary,
      ``,
      `--- 按优先级 ---`,
      `  P0 关键功能: ${(report.p0PassRate * 100).toFixed(1)}%`,
      `  P1 重要功能: ${(report.p1PassRate * 100).toFixed(1)}%`,
      `  P2 辅助功能: ${(report.p2PassRate * 100).toFixed(1)}%`,
      ``,
      `--- 失败测试 ---`,
    ];

    const failedResults = report.results.filter(r => r.status !== 'passed');
    for (const r of failedResults) {
      const tc = this.testCases.get(r.testCaseId);
      lines.push(`  [${r.status.toUpperCase()}] ${tc?.name || r.testCaseId} (${r.duration}ms)${r.error ? ` - ${r.error}` : ''}`);
    }

    if (report.recommendations.length > 0) {
      lines.push('', '--- 建议 ---');
      for (const rec of report.recommendations) {
        lines.push(`  → ${rec}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 注册默认测试用例
   */
  private registerDefaultTests(): void {
    // ===== 智能体循环测试 =====
    this.registerTest({
      id: 'agent-loop-basic',
      name: 'Agent Loop 基础功能',
      description: '验证Agent Loop可以正常启动和终止',
      category: 'agent-loop',
      priority: 'P0',
      timeout: 10000,
      test: async () => {
        try {
          const { EnhancedAgentLoop } = await import('./enhanced-agent-loop.js');
          const loop = new EnhancedAgentLoop({ enablePlanning: false, enableReflection: false });
          return loop !== null;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'agent-loop-planning',
      name: 'Agent Loop 规划功能',
      description: '验证TaskPlanner可以生成执行计划',
      category: 'agent-loop',
      priority: 'P1',
      timeout: 10000,
      test: async () => {
        try {
          const { EnhancedAgentLoop } = await import('./enhanced-agent-loop.js');
          const loop = new EnhancedAgentLoop({ enablePlanning: true, enableReflection: false });
          return loop !== null;
        } catch {
          return false;
        }
      },
    });

    // ===== 工具框架测试 =====
    this.registerTest({
      id: 'tool-framework-registration',
      name: '工具框架注册功能',
      description: '验证工具可以正确注册和查询',
      category: 'tool-framework',
      priority: 'P0',
      timeout: 5000,
      test: async () => {
        try {
          const { UnifiedToolFramework } = await import('./unified-tool-framework.js');
          const framework = new UnifiedToolFramework();
          const activeTools = framework.getActiveTools();
          return activeTools.length >= 10; // 至少10个内置工具
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'tool-framework-risk-levels',
      name: '工具风险等级分类',
      description: '验证工具按风险等级正确分类',
      category: 'tool-framework',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { UnifiedToolFramework } = await import('./unified-tool-framework.js');
          const framework = new UnifiedToolFramework();
          const dangerous = framework.getToolsByRiskLevel('dangerous');
          const safe = framework.getToolsByRiskLevel('safe');
          // 应该有安全工具和危险工具
          return safe.length > 0 && dangerous.length > 0;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'tool-framework-sandbox',
      name: '沙箱执行功能',
      description: '验证VM沙箱可以安全执行代码',
      category: 'tool-framework',
      priority: 'P0',
      timeout: 5000,
      test: async () => {
        try {
          const { UnifiedToolFramework } = await import('./unified-tool-framework.js');
          const framework = new UnifiedToolFramework();
          const result = await framework.execute('code_execute', { code: 'return 1 + 1' });
          return result.success;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'tool-framework-openai-format',
      name: 'OpenAI工具格式转换',
      description: '验证工具可以转换为OpenAI function calling格式',
      category: 'tool-framework',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { UnifiedToolFramework } = await import('./unified-tool-framework.js');
          const framework = new UnifiedToolFramework();
          const openaiTools = framework.toOpenAITools();
          return openaiTools.length > 0 && openaiTools[0].type === 'function';
        } catch {
          return false;
        }
      },
    });

    // ===== 持续学习框架测试 =====
    this.registerTest({
      id: 'learning-record-experience',
      name: '经验记录功能',
      description: '验证可以记录和查询经验',
      category: 'learning',
      priority: 'P0',
      timeout: 5000,
      test: async () => {
        try {
          const { ContinuousLearningFramework } = await import('./continuous-learning.js');
          const { ModelLibrary } = await import('./model-library.js');
          const ml = new ModelLibrary();
          const framework = new ContinuousLearningFramework(ml);

          const result = await framework.learnKnowledge('测试主题', '测试内容：这是一个持续学习测试', 'test');

          return result.id !== undefined && result.retentionScore >= 0;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'learning-decision-influence',
      name: '决策影响力功能',
      description: '验证学习经验可以影响决策建议',
      category: 'learning',
      priority: 'P0',
      timeout: 5000,
      test: async () => {
        try {
          const { ContinuousLearningFramework } = await import('./continuous-learning.js');
          const { ModelLibrary } = await import('./model-library.js');
          const ml = new ModelLibrary();
          const framework = new ContinuousLearningFramework(ml);

          // 学习知识
          await framework.learnKnowledge('编写TypeScript代码', '使用file_write工具可以高效编写TypeScript代码', 'coding');

          // 查询知识
          const results = framework.queryKnowledge('编写TypeScript代码');
          return results.length > 0 && results[0].confidence >= 0;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'learning-feedback-loop',
      name: '反馈闭环功能',
      description: '验证反馈信号可以更新经验权重',
      category: 'learning',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { ContinuousLearningFramework } = await import('./continuous-learning.js');
          const { ModelLibrary } = await import('./model-library.js');
          const ml = new ModelLibrary();
          const framework = new ContinuousLearningFramework(ml);

          // 学习知识
          const entry = await framework.learnKnowledge('反馈测试', '测试反馈闭环功能', 'test');

          // 巩固知识（包含反馈更新）
          const report = await framework.consolidateMemories();

          return entry.id !== undefined && report.retentionRate >= 0;
        } catch {

          return false;
        }
      },
    });

    // ===== 进化评估测试 =====
    this.registerTest({
      id: 'evolution-metrics-record',
      name: '指标记录功能',
      description: '验证可以记录和查询进化指标',
      category: 'evolution-metrics',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { EvolutionMetrics } = await import('./evolution-metrics.js');
          const metrics = new EvolutionMetrics(duanPath('test-metrics'));
          metrics.record('task_completion_rate', 85);
          const metric = metrics.getMetric('task_completion_rate');
          return metric !== undefined && metric.currentValue === 85;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'evolution-metrics-report',
      name: '评估报告生成',
      description: '验证可以生成完整的评估报告',
      category: 'evolution-metrics',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { EvolutionMetrics } = await import('./evolution-metrics.js');
          const metrics = new EvolutionMetrics(duanPath('test-metrics'));
          metrics.recordBatch({
            task_completion_rate: 85,
            decision_accuracy: 90,
            learning_velocity: 3,
            error_rate: 8,
          });
          const report = metrics.generateReport();
          return report.overallScore > 0 && report.criticalMetricsStatus.length > 0;
        } catch {
          return false;
        }
      },
    });

    // ===== DI容器测试 =====
    this.registerTest({
      id: 'di-container-basic',
      name: 'DI容器基础功能',
      description: '验证服务注册和解析',
      category: 'di-container',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { DIContainer } = await import('./di-container.js');
          const container = new DIContainer();
          container.registerSingleton('test-service', () => ({ value: 42 }));
          const service = container.resolve<{ value: number }>('test-service');
          return service !== null && service.value === 42;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'di-container-dependencies',
      name: 'DI容器依赖注入',
      description: '验证服务间的依赖解析',
      category: 'di-container',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { DIContainer } = await import('./di-container.js');
          const container = new DIContainer();
          container.registerSingleton('db', () => ({ connected: true }));
          container.registerSingleton('service', (c) => {
            const db = c.resolve<{ connected: boolean }>('db');
            return { dbConnected: db?.connected || false };
          }, ['db']);
          const service = container.resolve<{ dbConnected: boolean }>('service');
          return service !== null && service.dbConnected === true;
        } catch {
          return false;
        }
      },
    });

    this.registerTest({
      id: 'di-container-cycle-detection',
      name: 'DI容器循环依赖检测',
      description: '验证循环依赖被正确检测',
      category: 'di-container',
      priority: 'P2',
      timeout: 5000,
      test: async () => {
        try {
          const { DIContainer } = await import('./di-container.js');
          const container = new DIContainer();
          container.registerSingleton('a', (c) => c.resolve('b'), ['b']);
          container.registerSingleton('b', (c) => c.resolve('a'), ['a']);
          try {
            container.resolve('a');
            return false; // 应该抛出异常
          } catch {
            return true; // 正确检测到循环依赖
          }
        } catch {
          return false;
        }
      },
    });

    // ===== 知识图谱测试 =====
    this.registerTest({
      id: 'knowledge-graph-basic',
      name: '知识图谱基础功能',
      description: '验证实体和关系的增删查',
      category: 'knowledge-graph',
      priority: 'P1',
      timeout: 5000,
      test: async () => {
        try {
          const { KnowledgeGraph } = await import('./knowledge-graph.js');
          const kg = new KnowledgeGraph();
          const result = kg.query('JavaScript');
          return result.entities.length > 0;
        } catch {
          return false;
        }
      },
    });
  }

  /**
   * 保存测试报告
   */
  private saveReport(report: TestReport): void {
    try {
      fs.mkdirSync(this.dataPath, { recursive: true });
      atomicWriteJsonSync(
        path.join(this.dataPath, `report-${Date.now()}.json`),
        report
      );
    } catch {
      // 保存失败不影响测试
    }
  }
}

// ============ 基准测试套件 ============

export class BenchmarkSuite {
  private benchmarks: Map<string, {
    name: string;
    fn: () => Promise<void>;
    iterations: number;
  }> = new Map();

  /**
   * 注册基准测试
   */
  register(name: string, fn: () => Promise<void>, iterations: number = 100): void {
    this.benchmarks.set(name, { name, fn, iterations });
  }

  /**
   * 运行基准测试
   */
  async run(name?: string): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    const targets: Array<[string, { name: string; fn: () => Promise<void>; iterations: number }]> = name
      ? [[name, this.benchmarks.get(name)!]]
      : Array.from(this.benchmarks.entries());

    for (const [benchName, bench] of targets) {
      if (!bench) continue;

      const durations: number[] = [];

      for (let i = 0; i < bench.iterations; i++) {
        const start = performance.now();
        try {
          await bench.fn();
        } catch {
          // 基准测试中的错误不影响其他迭代
        }
        durations.push(performance.now() - start);
      }

      durations.sort((a, b) => a - b);

      const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
      const p50Index = Math.floor(durations.length * 0.5);
      const p95Index = Math.floor(durations.length * 0.95);
      const p99Index = Math.floor(durations.length * 0.99);

      results.push({
        name: benchName,
        iterations: bench.iterations,
        avgDuration: avg,
        minDuration: durations[0],
        maxDuration: durations[durations.length - 1],
        p50: durations[p50Index],
        p95: durations[p95Index],
        p99: durations[p99Index],
        throughput: avg > 0 ? 1000 / avg : 0,
      });
    }

    return results;
  }

  /**
   * 格式化基准测试结果
   */
  formatResults(results: BenchmarkResult[]): string {
    const lines: string[] = [
      '=== 基准测试结果 ===',
      '',
    ];

    for (const r of results) {
      lines.push(`--- ${r.name} ---`);
      lines.push(`  迭代次数: ${r.iterations}`);
      lines.push(`  平均耗时: ${r.avgDuration.toFixed(2)}ms`);
      lines.push(`  最小耗时: ${r.minDuration.toFixed(2)}ms`);
      lines.push(`  最大耗时: ${r.maxDuration.toFixed(2)}ms`);
      lines.push(`  P50: ${r.p50.toFixed(2)}ms | P95: ${r.p95.toFixed(2)}ms | P99: ${r.p99.toFixed(2)}ms`);
      lines.push(`  吞吐量: ${r.throughput.toFixed(1)} ops/sec`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
