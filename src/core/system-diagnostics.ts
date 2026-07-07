/**
 * 系统诊断模块 - SystemDiagnostics
 * 提供系统健康检查、性能诊断、功能测试和闭环改进能力
 */

/** 诊断级别 */
export type DiagnosticLevel = 'critical' | 'warning' | 'healthy' | 'info';

/** 诊断项 */
export interface DiagnosticItem {
  name: string;
  level: DiagnosticLevel;
  message: string;
  suggestion?: string;
  metric?: string;
  value?: number;
  threshold?: number;
}

/** 性能快照（诊断用） */
export interface DiagnosticSnapshot {
  responseTime: number;
  memoryUsage: number;
  cacheHitRate: number;
  intentAccuracy: number;
  taskCompletionRate: number;
  errorRate: number;
  activeConnections: number;
  throughput: number;
}

/** 优化建议 */
export interface OptimizationSuggestion {
  id: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'proposed' | 'accepted' | 'implementing' | 'completed';
  technicalPath: string;
  expectedImprovement: string;
  relatedMetrics: string[];
}

/** 功能测试用例 */
export interface FunctionalTestCase {
  name: string;
  category: string;
  input: string;
  expectedBehavior: string;
}

/** 功能测试结果 */
export interface FunctionalTestResult {
  name: string;
  category: string;
  status: 'passed' | 'failed';
  actualResult: string;
  executionTime: number;
}

/** 功能测试报告 */
export interface FunctionalTestReport {
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  results: FunctionalTestResult[];
  coverageByCategory: Record<string, { total: number; passed: number; rate: number }>;
}

/** 改进周期 */
export interface ImprovementCycle {
  id: string;
  phase: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  diagnostics: DiagnosticItem[];
  suggestions: OptimizationSuggestion[];
  startedAt: string;
  completedAt?: string;
}

/** 阈值配置 */
export interface ThresholdConfig {
  responseTime: { warning: number; critical: number };
  memoryUsage: { warning: number; critical: number };
  cacheHitRate: { warning: number; critical: number };
  intentAccuracy: { warning: number; critical: number };
  taskCompletionRate: { warning: number; critical: number };
  errorRate: { warning: number; critical: number };
}

/** 性能趋势数据点 */
export interface TrendDataPoint {
  timestamp: string;
  value: number;
}

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  responseTime: { warning: 2000, critical: 5000 },
  memoryUsage: { warning: 0.7, critical: 0.9 },
  cacheHitRate: { warning: 0.3, critical: 0.1 },
  intentAccuracy: { warning: 0.7, critical: 0.5 },
  taskCompletionRate: { warning: 0.7, critical: 0.5 },
  errorRate: { warning: 0.2, critical: 0.4 },
};

const FUNCTIONAL_TEST_CASES: FunctionalTestCase[] = [
  { name: '基础意图识别', category: 'NLU', input: '帮我写一个Python爬虫', expectedBehavior: '识别代码生成意图' },
  { name: '情感分析', category: 'NLU', input: '这个功能太棒了！', expectedBehavior: '识别积极情感' },
  { name: '实体提取', category: 'NLU', input: '明天下午3点在北京开会', expectedBehavior: '提取时间地点实体' },
  { name: '多意图检测', category: 'NLU', input: '帮我写代码并搜索相关资料', expectedBehavior: '检测多个意图' },
  { name: '歧义消解', category: 'NLU', input: '苹果怎么样', expectedBehavior: '消解歧义' },
  { name: '金融意图', category: 'NLU', input: '今天股市行情如何', expectedBehavior: '识别金融意图' },
  { name: '医疗意图', category: 'NLU', input: '头疼应该吃什么药', expectedBehavior: '识别医疗意图' },
  { name: '推理能力', category: '推理', input: '如果A大于B，B大于C，那么A和C的关系？', expectedBehavior: '正确推理' },
  { name: '工具调用', category: '执行', input: '搜索最新的AI新闻', expectedBehavior: '调用搜索工具' },
  { name: '上下文记忆', category: '记忆', input: '刚才我们讨论了什么？', expectedBehavior: '回忆上下文' },
  { name: '自我评估', category: '进化', input: '分析你当前的能力水平', expectedBehavior: '执行自我评估' },
  { name: 'PII检测', category: '安全', input: '我的手机号是13800138000', expectedBehavior: '检测PII信息' },
  { name: '交互能力', category: '交互', input: '你好，请介绍一下你自己', expectedBehavior: '正常交互' },
  { name: '知识查询', category: '知识', input: '什么是机器学习？', expectedBehavior: '知识检索' },
];

export class SystemDiagnostics {
  private thresholds: ThresholdConfig;
  private snapshots: Array<{ timestamp: string; data: DiagnosticSnapshot }>;
  private improvementCycles: ImprovementCycle[];
  private optimizationSuggestions: OptimizationSuggestion[];
  private suggestionIdCounter: number;

  constructor() {
    this.thresholds = { ...DEFAULT_THRESHOLDS };
    this.snapshots = [];
    this.improvementCycles = [];
    this.optimizationSuggestions = [];
    this.suggestionIdCounter = 0;
  }

  /** 捕获性能快照 */
  capturePerformanceSnapshot(snapshot: DiagnosticSnapshot): DiagnosticSnapshot {
    this.snapshots.push({
      timestamp: new Date().toISOString(),
      data: { ...snapshot },
    });
    // 只保留最近100条
    if (this.snapshots.length > 100) {
      this.snapshots = this.snapshots.slice(-100);
    }
    return snapshot;
  }

  /** 运行系统诊断 */
  runDiagnostics(snapshot: DiagnosticSnapshot): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];

    // 响应时间检查
    if (snapshot.responseTime >= this.thresholds.responseTime.critical) {
      diagnostics.push({
        name: '响应时间',
        level: 'critical',
        message: '响应时间严重超标: ' + snapshot.responseTime + 'ms (阈值: ' + this.thresholds.responseTime.critical + 'ms)',
        suggestion: '优化数据库查询、增加缓存、启用流式响应',
        metric: 'responseTime',
        value: snapshot.responseTime,
        threshold: this.thresholds.responseTime.critical,
      });
    } else if (snapshot.responseTime >= this.thresholds.responseTime.warning) {
      diagnostics.push({
        name: '响应时间',
        level: 'warning',
        message: '响应时间偏高: ' + snapshot.responseTime + 'ms (阈值: ' + this.thresholds.responseTime.warning + 'ms)',
        suggestion: '检查慢查询，考虑增加缓存策略',
        metric: 'responseTime',
        value: snapshot.responseTime,
        threshold: this.thresholds.responseTime.warning,
      });
    } else {
      diagnostics.push({
        name: '响应时间',
        level: 'healthy',
        message: '响应时间正常: ' + snapshot.responseTime + 'ms',
        metric: 'responseTime',
        value: snapshot.responseTime,
      });
    }

    // 内存使用检查
    if (snapshot.memoryUsage >= this.thresholds.memoryUsage.critical) {
      diagnostics.push({
        name: '内存使用',
        level: 'critical',
        message: '内存使用率严重过高: ' + (snapshot.memoryUsage * 100).toFixed(1) + '%',
        suggestion: '检查内存泄漏，优化数据结构，增加垃圾回收频率',
        metric: 'memoryUsage',
        value: snapshot.memoryUsage,
        threshold: this.thresholds.memoryUsage.critical,
      });
    } else if (snapshot.memoryUsage >= this.thresholds.memoryUsage.warning) {
      diagnostics.push({
        name: '内存使用',
        level: 'warning',
        message: '内存使用率偏高: ' + (snapshot.memoryUsage * 100).toFixed(1) + '%',
        suggestion: '监控内存增长趋势，考虑优化缓存策略',
        metric: 'memoryUsage',
        value: snapshot.memoryUsage,
        threshold: this.thresholds.memoryUsage.warning,
      });
    } else {
      diagnostics.push({
        name: '内存使用',
        level: 'healthy',
        message: '内存使用正常: ' + (snapshot.memoryUsage * 100).toFixed(1) + '%',
        metric: 'memoryUsage',
        value: snapshot.memoryUsage,
      });
    }

    // 缓存命中率检查
    if (snapshot.cacheHitRate <= this.thresholds.cacheHitRate.critical) {
      diagnostics.push({
        name: '缓存命中率',
        level: 'critical',
        message: '缓存命中率极低: ' + (snapshot.cacheHitRate * 100).toFixed(1) + '%',
        suggestion: '检查缓存策略，增加缓存容量，优化缓存键设计',
        metric: 'cacheHitRate',
        value: snapshot.cacheHitRate,
        threshold: this.thresholds.cacheHitRate.critical,
      });
    } else if (snapshot.cacheHitRate <= this.thresholds.cacheHitRate.warning) {
      diagnostics.push({
        name: '缓存命中率',
        level: 'warning',
        message: '缓存命中率偏低: ' + (snapshot.cacheHitRate * 100).toFixed(1) + '%',
        suggestion: '优化缓存策略，考虑预热常用数据',
        metric: 'cacheHitRate',
        value: snapshot.cacheHitRate,
        threshold: this.thresholds.cacheHitRate.warning,
      });
    } else {
      diagnostics.push({
        name: '缓存命中率',
        level: 'healthy',
        message: '缓存命中率正常: ' + (snapshot.cacheHitRate * 100).toFixed(1) + '%',
        metric: 'cacheHitRate',
        value: snapshot.cacheHitRate,
      });
    }

    // 意图识别准确率检查
    if (snapshot.intentAccuracy <= this.thresholds.intentAccuracy.critical) {
      diagnostics.push({
        name: '意图识别准确率',
        level: 'critical',
        message: '意图识别准确率过低: ' + (snapshot.intentAccuracy * 100).toFixed(1) + '%',
        suggestion: '扩展意图规则库，增加训练样本，优化特征提取',
        metric: 'intentAccuracy',
        value: snapshot.intentAccuracy,
        threshold: this.thresholds.intentAccuracy.critical,
      });
    } else if (snapshot.intentAccuracy <= this.thresholds.intentAccuracy.warning) {
      diagnostics.push({
        name: '意图识别准确率',
        level: 'warning',
        message: '意图识别准确率偏低: ' + (snapshot.intentAccuracy * 100).toFixed(1) + '%',
        suggestion: '增加领域覆盖，优化歧义消解策略',
        metric: 'intentAccuracy',
        value: snapshot.intentAccuracy,
        threshold: this.thresholds.intentAccuracy.warning,
      });
    } else {
      diagnostics.push({
        name: '意图识别准确率',
        level: 'healthy',
        message: '意图识别准确率良好: ' + (snapshot.intentAccuracy * 100).toFixed(1) + '%',
        metric: 'intentAccuracy',
        value: snapshot.intentAccuracy,
      });
    }

    // 任务完成率检查
    if (snapshot.taskCompletionRate <= this.thresholds.taskCompletionRate.critical) {
      diagnostics.push({
        name: '任务完成率',
        level: 'critical',
        message: '任务完成率过低: ' + (snapshot.taskCompletionRate * 100).toFixed(1) + '%',
        suggestion: '增强工具调用可靠性，优化任务分解策略',
        metric: 'taskCompletionRate',
        value: snapshot.taskCompletionRate,
        threshold: this.thresholds.taskCompletionRate.critical,
      });
    } else if (snapshot.taskCompletionRate <= this.thresholds.taskCompletionRate.warning) {
      diagnostics.push({
        name: '任务完成率',
        level: 'warning',
        message: '任务完成率偏低: ' + (snapshot.taskCompletionRate * 100).toFixed(1) + '%',
        suggestion: '优化错误处理和重试机制',
        metric: 'taskCompletionRate',
        value: snapshot.taskCompletionRate,
        threshold: this.thresholds.taskCompletionRate.warning,
      });
    } else {
      diagnostics.push({
        name: '任务完成率',
        level: 'healthy',
        message: '任务完成率良好: ' + (snapshot.taskCompletionRate * 100).toFixed(1) + '%',
        metric: 'taskCompletionRate',
        value: snapshot.taskCompletionRate,
      });
    }

    // 错误率检查
    if (snapshot.errorRate >= this.thresholds.errorRate.critical) {
      diagnostics.push({
        name: '错误率',
        level: 'critical',
        message: '错误率过高: ' + (snapshot.errorRate * 100).toFixed(1) + '%',
        suggestion: '检查错误日志，修复高频错误，增强异常处理',
        metric: 'errorRate',
        value: snapshot.errorRate,
        threshold: this.thresholds.errorRate.critical,
      });
    } else if (snapshot.errorRate >= this.thresholds.errorRate.warning) {
      diagnostics.push({
        name: '错误率',
        level: 'warning',
        message: '错误率偏高: ' + (snapshot.errorRate * 100).toFixed(1) + '%',
        suggestion: '监控错误趋势，优化降级策略',
        metric: 'errorRate',
        value: snapshot.errorRate,
        threshold: this.thresholds.errorRate.warning,
      });
    } else {
      diagnostics.push({
        name: '错误率',
        level: 'healthy',
        message: '错误率正常: ' + (snapshot.errorRate * 100).toFixed(1) + '%',
        metric: 'errorRate',
        value: snapshot.errorRate,
      });
    }

    return diagnostics;
  }

  /** 生成优化建议 */
  generateOptimizationSuggestions(diagnostics: DiagnosticItem[]): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    for (const diag of diagnostics) {
      if (diag.level === 'critical') {
        this.suggestionIdCounter++;
        suggestions.push({
          id: 'sug_' + this.suggestionIdCounter,
          title: '紧急修复: ' + diag.name,
          description: diag.message,
          priority: 'critical',
          status: 'proposed',
          technicalPath: 'core/' + (diag.metric || 'system') + '/optimize',
          expectedImprovement: '预计提升' + diag.name + '至正常水平',
          relatedMetrics: [diag.metric || 'unknown'],
        });
      } else if (diag.level === 'warning') {
        this.suggestionIdCounter++;
        suggestions.push({
          id: 'sug_' + this.suggestionIdCounter,
          title: '优化建议: ' + diag.name,
          description: diag.message,
          priority: 'high',
          status: 'proposed',
          technicalPath: 'core/' + (diag.metric || 'system') + '/enhance',
          expectedImprovement: '预计改善' + diag.name + '表现',
          relatedMetrics: [diag.metric || 'unknown'],
        });
      }
    }

    // 保存建议
    this.optimizationSuggestions.push(...suggestions);
    // 只保留最近50条
    if (this.optimizationSuggestions.length > 50) {
      this.optimizationSuggestions = this.optimizationSuggestions.slice(-50);
    }

    return suggestions;
  }

  /** 运行功能测试 */
  runFunctionalTests(
    testRunner: (testCase: FunctionalTestCase) => { passed: boolean; actualResult: string; executionTime: number }
  ): FunctionalTestReport {
    const results: FunctionalTestResult[] = [];
    const categoryStats: Record<string, { total: number; passed: number }> = {};

    for (const tc of FUNCTIONAL_TEST_CASES) {
      const runnerResult = testRunner(tc);
      const status = runnerResult.passed ? 'passed' : 'failed';

      results.push({
        name: tc.name,
        category: tc.category,
        status,
        actualResult: runnerResult.actualResult,
        executionTime: runnerResult.executionTime,
      });

      if (!categoryStats[tc.category]) {
        categoryStats[tc.category] = { total: 0, passed: 0 };
      }
      categoryStats[tc.category].total++;
      if (runnerResult.passed) {
        categoryStats[tc.category].passed++;
      }
    }

    const passedCount = results.filter(r => r.status === 'passed').length;
    const coverageByCategory: Record<string, { total: number; passed: number; rate: number }> = {};
    for (const [cat, stats] of Object.entries(categoryStats)) {
      coverageByCategory[cat] = {
        total: stats.total,
        passed: stats.passed,
        rate: stats.passed / stats.total,
      };
    }

    return {
      totalTests: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      passRate: results.length > 0 ? passedCount / results.length : 0,
      results,
      coverageByCategory,
    };
  }

  /** 获取性能趋势 */
  getPerformanceTrend(metric: string, windowSize: number): TrendDataPoint[] {
    const trend: TrendDataPoint[] = [];
    const recentSnapshots = this.snapshots.slice(-windowSize);

    for (const snap of recentSnapshots) {
      let value = 0;
      switch (metric) {
        case 'responseTime':
          value = snap.data.responseTime;
          break;
        case 'memoryUsage':
          value = snap.data.memoryUsage;
          break;
        case 'cacheHitRate':
          value = snap.data.cacheHitRate;
          break;
        case 'intentAccuracy':
          value = snap.data.intentAccuracy;
          break;
        case 'taskCompletionRate':
          value = snap.data.taskCompletionRate;
          break;
        case 'errorRate':
          value = snap.data.errorRate;
          break;
        default:
          value = snap.data.responseTime;
      }
      trend.push({ timestamp: snap.timestamp, value });
    }

    return trend;
  }

  /** 获取改进周期列表 */
  getImprovementCycles(): ImprovementCycle[] {
    return [...this.improvementCycles];
  }

  /** 获取优化建议列表 */
  getOptimizationSuggestions(): OptimizationSuggestion[] {
    return [...this.optimizationSuggestions];
  }

  /** 启动改进周期 */
  startImprovementCycle(): ImprovementCycle {
    const lastSnapshot = this.snapshots.length > 0
      ? this.snapshots[this.snapshots.length - 1].data
      : null;

    let diagnostics: DiagnosticItem[] = [];
    let suggestions: OptimizationSuggestion[] = [];

    if (lastSnapshot) {
      diagnostics = this.runDiagnostics(lastSnapshot);
      suggestions = this.generateOptimizationSuggestions(diagnostics);
    }

    const cycle: ImprovementCycle = {
      id: 'cycle_' + Date.now(),
      phase: 'diagnosis',
      status: 'in_progress',
      diagnostics,
      suggestions,
      startedAt: new Date().toISOString(),
    };

    this.improvementCycles.push(cycle);
    // 只保留最近20个周期
    if (this.improvementCycles.length > 20) {
      this.improvementCycles = this.improvementCycles.slice(-20);
    }

    return cycle;
  }

  /** 获取阈值配置 */
  getThresholds(): ThresholdConfig {
    return { ...this.thresholds };
  }

  /** 更新阈值配置 */
  updateThresholds(newThresholds: Partial<ThresholdConfig>): void {
    if (newThresholds.responseTime) {
      this.thresholds.responseTime = { ...this.thresholds.responseTime, ...newThresholds.responseTime };
    }
    if (newThresholds.memoryUsage) {
      this.thresholds.memoryUsage = { ...this.thresholds.memoryUsage, ...newThresholds.memoryUsage };
    }
    if (newThresholds.cacheHitRate) {
      this.thresholds.cacheHitRate = { ...this.thresholds.cacheHitRate, ...newThresholds.cacheHitRate };
    }
    if (newThresholds.intentAccuracy) {
      this.thresholds.intentAccuracy = { ...this.thresholds.intentAccuracy, ...newThresholds.intentAccuracy };
    }
    if (newThresholds.taskCompletionRate) {
      this.thresholds.taskCompletionRate = { ...this.thresholds.taskCompletionRate, ...newThresholds.taskCompletionRate };
    }
    if (newThresholds.errorRate) {
      this.thresholds.errorRate = { ...this.thresholds.errorRate, ...newThresholds.errorRate };
    }
  }
}
