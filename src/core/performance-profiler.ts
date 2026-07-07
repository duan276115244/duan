/**
 * 性能分析系统 — PerformanceProfiler
 *
 * 分析代码性能，检测性能瓶颈和内存泄漏。
 *
 * 核心能力：
 * 1. 函数性能分析 — 测量函数执行时间
 * 2. 内存使用分析 — 检测内存泄漏和高内存使用
 * 3. 性能瓶颈检测 — 识别慢函数和热点
 * 4. CPU 分析 — 识别 CPU 密集型操作
 * 5. 性能基准测试 — 建立性能基线
 * 6. 性能报告 — 生成性能分析报告
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 性能测量记录 */
export interface PerformanceMeasurement {
  /** 测量 ID */
  id: string;
  /** 函数/操作名称 */
  name: string;
  /** 执行时间（ms） */
  durationMs: number;
  /** 内存变化（bytes） */
  memoryDelta: number;
  /** CPU 时间（ms） */
  cpuTimeMs: number;
  /** 调用次数 */
  callCount: number;
  /** 时间戳 */
  timestamp: number;
  /** 是否为瓶颈 */
  isBottleneck: boolean;
  /** 输入大小（可选） */
  inputSize?: number;
}

/** 性能瓶颈 */
export interface PerformanceBottleneck {
  /** 瓶颈 ID */
  id: string;
  /** 类型 */
  type: 'slow_function' | 'memory_leak' | 'cpu_intensive' | 'io_blocking' | 'n_plus_one';
  /** 严重程度 */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** 函数/位置名称 */
  name: string;
  /** 文件路径 */
  filePath?: string;
  /** 行号 */
  line?: number;
  /** 描述 */
  description: string;
  /** 度量值 */
  metric: number;
  /** 阈值 */
  threshold: number;
  /** 修复建议 */
  suggestion: string;
  /** 检测时间 */
  detectedAt: number;
}

/** 内存快照 */
export interface MemorySnapshot {
  /** 时间戳 */
  timestamp: number;
  /** RSS（常驻内存） */
  rss: number;
  /** 堆总量 */
  heapTotal: number;
  /** 堆使用 */
  heapUsed: number;
  /** 外部内存 */
  external: number;
  /** 数组缓冲区 */
  arrayBuffers: number;
}

/** 性能基准 */
export interface PerformanceBaseline {
  /** 基准名称 */
  name: string;
  /** 平均执行时间 */
  avgDurationMs: number;
  /** P50 执行时间 */
  p50DurationMs: number;
  /** P95 执行时间 */
  p95DurationMs: number;
  /** P99 执行时间 */
  p99DurationMs: number;
  /** 样本数 */
  sampleCount: number;
  /** 建立时间 */
  createdAt: number;
}

/** 性能分析报告 */
export interface PerformanceReport {
  /** 测量总数 */
  totalMeasurements: number;
  /** 瓶颈列表 */
  bottlenecks: PerformanceBottleneck[];
  /** 最慢的函数 */
  slowestFunctions: PerformanceMeasurement[];
  /** 内存使用趋势 */
  memoryTrend: MemorySnapshot[];
  /** 内存泄漏检测 */
  memoryLeaks: PerformanceBottleneck[];
  /** 性能基准 */
  baselines: PerformanceBaseline[];
  /** 性能评分 */
  performanceScore: number;
}

// ============ 阈值配置 ============

const PERF_THRESHOLDS = {
  functionDuration: { warn: 100, critical: 500 }, // ms
  memoryGrowth: { warn: 50 * 1024 * 1024, critical: 100 * 1024 * 1024 }, // 50MB / 100MB
  cpuUsage: { warn: 50, critical: 80 }, // %
  callFrequency: { warn: 100, critical: 1000 }, // 次数
};

// ============ 性能分析器 ============

export class PerformanceProfiler {
  /** 工作目录 */
  private workDir: string;

  /** 性能测量记录 */
  private measurements: PerformanceMeasurement[] = [];

  /** 最大记录数 */
  private maxMeasurements = 10000;

  /** 内存快照 */
  private memorySnapshots: MemorySnapshot[] = [];

  /** 内存监控定时器 */
  private memoryMonitorTimer: NodeJS.Timeout | null = null;

  /** 性能基准 */
  private baselines: Map<string, number[]> = new Map();

  /** 活跃测量（用于嵌套调用） */
  private activeMeasurements: Map<string, { start: number; memory: number; cpu: [number, number] }> = new Map();

  private log = logger.child({ module: 'PerformanceProfiler' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('performance');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.loadData();
  }

  // ========== 函数性能测量 ==========

  /**
   * 开始测量
   */
  startMeasure(_name: string, _inputSize?: number): string {
    const id = `perf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const memory = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();

    this.activeMeasurements.set(id, {
      start: performance.now(),
      memory,
      cpu: [cpu.user, cpu.system],
    });

    return id;
  }

  /**
   * 结束测量
   */
  endMeasure(id: string, name: string, inputSize?: number): PerformanceMeasurement | null {
    const active = this.activeMeasurements.get(id);
    if (!active) return null;

    const duration = performance.now() - active.start;
    const endMemory = process.memoryUsage().heapUsed;
    const endCpu = process.cpuUsage();
    const memoryDelta = endMemory - active.memory;
    const cpuTimeMs = (endCpu.user - active.cpu[0] + endCpu.system - active.cpu[1]) / 1000;

    this.activeMeasurements.delete(id);

    const isBottleneck = duration > PERF_THRESHOLDS.functionDuration.warn;

    const measurement: PerformanceMeasurement = {
      id,
      name,
      durationMs: duration,
      memoryDelta,
      cpuTimeMs,
      callCount: 1,
      timestamp: Date.now(),
      isBottleneck,
      inputSize,
    };

    this.measurements.push(measurement);
    if (this.measurements.length > this.maxMeasurements) {
      this.measurements.shift();
    }

    // 更新基准
    this.updateBaseline(name, duration);

    return measurement;
  }

  /**
   * 测量异步函数
   */
  async measureAsync<T>(name: string, fn: () => Promise<T>, inputSize?: number): Promise<{ result: T; measurement: PerformanceMeasurement }> {
    const id = this.startMeasure(name, inputSize);
    try {
      const result = await fn();
      const measurement = this.endMeasure(id, name, inputSize)!;
      return { result, measurement };
    } catch (err) {
      this.endMeasure(id, name, inputSize);
      throw err;
    }
  }

  /**
   * 测量同步函数
   */
  measureSync<T>(name: string, fn: () => T, inputSize?: number): { result: T; measurement: PerformanceMeasurement } {
    const id = this.startMeasure(name, inputSize);
    try {
      const result = fn();
      const measurement = this.endMeasure(id, name, inputSize)!;
      return { result, measurement };
    } catch (err) {
      this.endMeasure(id, name, inputSize);
      throw err;
    }
  }

  // ========== 内存监控 ==========

  /**
   * 开始内存监控
   */
  startMemoryMonitoring(intervalMs: number = 5000): void {
    if (this.memoryMonitorTimer) {
      this.log.warn('内存监控已在运行');
      return;
    }

    this.log.info('内存监控已启动', { intervalMs });
    this.memoryMonitorTimer = setInterval(() => {
      this.takeMemorySnapshot();
    }, intervalMs);
  }

  /**
   * 停止内存监控
   */
  stopMemoryMonitoring(): void {
    if (this.memoryMonitorTimer) {
      clearInterval(this.memoryMonitorTimer);
      this.memoryMonitorTimer = null;
      this.log.info('内存监控已停止');
    }
  }

  /**
   * 获取内存快照
   */
  takeMemorySnapshot(): MemorySnapshot {
    const mem = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };

    this.memorySnapshots.push(snapshot);
    if (this.memorySnapshots.length > 1000) {
      this.memorySnapshots.shift();
    }

    return snapshot;
  }

  /**
   * 检测内存泄漏
   */
  detectMemoryLeaks(): PerformanceBottleneck[] {
    const leaks: PerformanceBottleneck[] = [];

    if (this.memorySnapshots.length < 10) return leaks;

    // 分析内存增长趋势
    const recent = this.memorySnapshots.slice(-50);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const growth = last.heapUsed - first.heapUsed;
    const timeSpan = last.timestamp - first.timestamp;

    // 持续增长超过阈值
    if (growth > PERF_THRESHOLDS.memoryGrowth.warn) {
      const severity = growth > PERF_THRESHOLDS.memoryGrowth.critical ? 'critical' : 'high';
      leaks.push({
        id: `leak_${Date.now().toString(36)}`,
        type: 'memory_leak',
        severity,
        name: '堆内存持续增长',
        description: `堆内存在 ${(timeSpan / 1000).toFixed(0)}s 内增长 ${(growth / 1024 / 1024).toFixed(1)}MB`,
        metric: growth,
        threshold: PERF_THRESHOLDS.memoryGrowth.warn,
        suggestion: '检查是否有未释放的引用、事件监听器或闭包泄漏',
        detectedAt: Date.now(),
      });
    }

    // 分析线性增长趋势
    if (recent.length >= 10) {
      const slope = this.calculateMemoryGrowthRate(recent);
      if (slope > 1024 * 1024) { // 每秒增长 > 1MB
        leaks.push({
          id: `leak_slope_${Date.now().toString(36)}`,
          type: 'memory_leak',
          severity: 'high',
          name: '内存线性增长',
          description: `内存以 ${(slope / 1024).toFixed(0)}KB/s 的速率增长`,
          metric: slope,
          threshold: 1024 * 1024,
          suggestion: '可能存在内存泄漏，建议使用 heap snapshot 分析',
          detectedAt: Date.now(),
        });
      }
    }

    return leaks;
  }

  /**
   * 计算内存增长率
   */
  private calculateMemoryGrowthRate(snapshots: MemorySnapshot[]): number {
    if (snapshots.length < 2) return 0;

    const n = snapshots.length;
    const sumX = snapshots.reduce((sum, s, i) => sum + i, 0);
    const sumY = snapshots.reduce((sum, s) => sum + s.heapUsed, 0);
    const sumXY = snapshots.reduce((sum, s, i) => sum + i * s.heapUsed, 0);
    const sumX2 = snapshots.reduce((sum, _, i) => sum + i * i, 0);

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    const avgTimeDiff = (snapshots[n - 1].timestamp - snapshots[0].timestamp) / (n - 1) / 1000;
    const slope = (n * sumXY - sumX * sumY) / denominator;

    return slope / Math.max(1, avgTimeDiff); // bytes per second
  }

  // ========== 瓶颈检测 ==========

  /**
   * 检测性能瓶颈
   */
  detectBottlenecks(): PerformanceBottleneck[] {
    const bottlenecks: PerformanceBottleneck[] = [];

    // 1. 慢函数检测
    const functionStats = this.aggregateFunctionStats();
    for (const [name, stats] of functionStats) {
      if (stats.avgDuration > PERF_THRESHOLDS.functionDuration.critical) {
        bottlenecks.push({
          id: `bottleneck_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
          type: 'slow_function',
          severity: 'critical',
          name,
          description: `函数 "${name}" 平均执行时间 ${stats.avgDuration.toFixed(1)}ms`,
          metric: stats.avgDuration,
          threshold: PERF_THRESHOLDS.functionDuration.critical,
          suggestion: '优化算法复杂度，或使用缓存减少重复计算',
          detectedAt: Date.now(),
        });
      } else if (stats.avgDuration > PERF_THRESHOLDS.functionDuration.warn) {
        bottlenecks.push({
          id: `bottleneck_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
          type: 'slow_function',
          severity: 'high',
          name,
          description: `函数 "${name}" 平均执行时间 ${stats.avgDuration.toFixed(1)}ms`,
          metric: stats.avgDuration,
          threshold: PERF_THRESHOLDS.functionDuration.warn,
          suggestion: '考虑优化或缓存',
          detectedAt: Date.now(),
        });
      }

      // 高频调用
      if (stats.count > PERF_THRESHOLDS.callFrequency.critical) {
        bottlenecks.push({
          id: `freq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
          type: 'n_plus_one',
          severity: 'high',
          name,
          description: `函数 "${name}" 被调用 ${stats.count} 次`,
          metric: stats.count,
          threshold: PERF_THRESHOLDS.callFrequency.critical,
          suggestion: '可能存在 N+1 查询问题，考虑批量处理',
          detectedAt: Date.now(),
        });
      }
    }

    // 2. 内存泄漏检测
    bottlenecks.push(...this.detectMemoryLeaks());

    return bottlenecks.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  /**
   * 聚合函数统计
   */
  private aggregateFunctionStats(): Map<string, {
    count: number;
    avgDuration: number;
    maxDuration: number;
    totalDuration: number;
    avgMemory: number;
  }> {
    const stats = new Map<string, {
      count: number;
      avgDuration: number;
      maxDuration: number;
      totalDuration: number;
      avgMemory: number;
    }>();

    for (const m of this.measurements) {
      if (!stats.has(m.name)) {
        stats.set(m.name, {
          count: 0,
          avgDuration: 0,
          maxDuration: 0,
          totalDuration: 0,
          avgMemory: 0,
        });
      }
      const s = stats.get(m.name)!;
      s.count++;
      s.totalDuration += m.durationMs;
      s.maxDuration = Math.max(s.maxDuration, m.durationMs);
      s.avgMemory = (s.avgMemory * (s.count - 1) + m.memoryDelta) / s.count;
    }

    for (const s of stats.values()) {
      s.avgDuration = s.totalDuration / s.count;
    }

    return stats;
  }

  // ========== 性能基准 ==========

  /**
   * 更新性能基准
   */
  private updateBaseline(name: string, duration: number): void {
    if (!this.baselines.has(name)) {
      this.baselines.set(name, []);
    }
    const samples = this.baselines.get(name)!;
    samples.push(duration);
    if (samples.length > 100) {
      samples.shift();
    }
  }

  /**
   * 获取性能基准
   */
  getBaselines(): PerformanceBaseline[] {
    const result: PerformanceBaseline[] = [];

    for (const [name, samples] of this.baselines) {
      if (samples.length < 3) continue;

      const sorted = [...samples].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);

      result.push({
        name,
        avgDurationMs: sum / sorted.length,
        p50DurationMs: sorted[Math.floor(sorted.length * 0.5)],
        p95DurationMs: sorted[Math.floor(sorted.length * 0.95)],
        p99DurationMs: sorted[Math.floor(sorted.length * 0.99)],
        sampleCount: sorted.length,
        createdAt: Date.now(),
      });
    }

    return result.sort((a, b) => b.avgDurationMs - a.avgDurationMs);
  }

  // ========== 报告生成 ==========

  /**
   * 生成性能报告
   */
  generateReport(): PerformanceReport {
    const bottlenecks = this.detectBottlenecks();
    const functionStats = this.aggregateFunctionStats();

    // 最慢的函数
    const slowestFunctions = Array.from(functionStats.entries())
      .map(([name, stats]) => ({
        id: `slow_${name}`,
        name,
        durationMs: stats.avgDuration,
        memoryDelta: stats.avgMemory,
        cpuTimeMs: 0,
        callCount: stats.count,
        timestamp: Date.now(),
        isBottleneck: stats.avgDuration > PERF_THRESHOLDS.functionDuration.warn,
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20);

    // 内存泄漏
    const memoryLeaks = bottlenecks.filter(b => b.type === 'memory_leak');

    // 性能评分
    const performanceScore = this.calculatePerformanceScore(bottlenecks);

    return {
      totalMeasurements: this.measurements.length,
      bottlenecks,
      slowestFunctions,
      memoryTrend: this.memorySnapshots.slice(-50),
      memoryLeaks,
      baselines: this.getBaselines(),
      performanceScore,
    };
  }

  /**
   * 计算性能评分
   */
  private calculatePerformanceScore(bottlenecks: PerformanceBottleneck[]): number {
    let score = 100;

    for (const b of bottlenecks) {
      const penalty = { critical: 15, high: 8, medium: 4, low: 1 }[b.severity];
      score -= penalty;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 生成性能报告 Markdown
   */
  generateReportMarkdown(): string {
    const report = this.generateReport();
    const lines: string[] = [
      '# 性能分析报告',
      '',
      `> 生成时间: ${new Date().toISOString()}`,
      '',
      '## 概览',
      '',
      `| 指标 | 值 |`,
      `|------|-----|`,
      `| 总测量数 | ${report.totalMeasurements} |`,
      `| 瓶颈数 | ${report.bottlenecks.length} |`,
      `| 内存泄漏 | ${report.memoryLeaks.length} |`,
      `| 性能评分 | ${report.performanceScore}/100 |`,
      '',
    ];

    // 瓶颈列表
    if (report.bottlenecks.length > 0) {
      lines.push('## 性能瓶颈', '');
      lines.push(`| 严重程度 | 类型 | 名称 | 度量值 | 建议 |`);
      lines.push(`|---------|------|------|--------|------|`);
      for (const b of report.bottlenecks.slice(0, 20)) {
        const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[b.severity];
        lines.push(`| ${emoji} ${b.severity} | ${b.type} | ${b.name} | ${b.metric.toFixed(0)} | ${b.suggestion} |`);
      }
    }

    // 最慢函数
    if (report.slowestFunctions.length > 0) {
      lines.push('', '## 最慢的函数（前 10）', '');
      lines.push(`| 函数 | 平均耗时 | 调用次数 | 瓶颈 |`);
      lines.push(`|------|---------|---------|------|`);
      for (const f of report.slowestFunctions.slice(0, 10)) {
        lines.push(`| ${f.name} | ${f.durationMs.toFixed(1)}ms | ${f.callCount} | ${f.isBottleneck ? '⚠️' : '✅'} |`);
      }
    }

    // 内存趋势
    if (report.memoryTrend.length > 0) {
      lines.push('', '## 内存使用趋势', '');
      const first = report.memoryTrend[0];
      const last = report.memoryTrend[report.memoryTrend.length - 1];
      const growth = last.heapUsed - first.heapUsed;
      lines.push(`- 起始堆内存: ${(first.heapUsed / 1024 / 1024).toFixed(1)}MB`);
      lines.push(`- 当前堆内存: ${(last.heapUsed / 1024 / 1024).toFixed(1)}MB`);
      lines.push(`- 增长量: ${(growth / 1024 / 1024).toFixed(1)}MB`);
    }

    // 性能基准
    if (report.baselines.length > 0) {
      lines.push('', '## 性能基准', '');
      lines.push(`| 函数 | 平均 | P50 | P95 | P99 | 样本数 |`);
      lines.push(`|------|------|-----|-----|-----|--------|`);
      for (const b of report.baselines.slice(0, 10)) {
        lines.push(`| ${b.name} | ${b.avgDurationMs.toFixed(1)}ms | ${b.p50DurationMs.toFixed(1)}ms | ${b.p95DurationMs.toFixed(1)}ms | ${b.p99DurationMs.toFixed(1)}ms | ${b.sampleCount} |`);
      }
    }

    return lines.join('\n');
  }

  // ========== 持久化 ==========

  /** 保存数据 */
  saveData(): void {
    try {
      const data = {
        measurements: this.measurements.slice(-1000),
        memorySnapshots: this.memorySnapshots.slice(-200),
        baselines: Array.from(this.baselines.entries()).map(([name, samples]) => ({
          name,
          samples: samples.slice(-100),
        })),
      };
      const dataPath = path.join(this.workDir, 'performance-data.json');
      atomicWriteJsonSync(dataPath, data);
    } catch (err: unknown) {
      this.log.error('保存性能数据失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 加载数据 */
  private loadData(): void {
    try {
      const dataPath = path.join(this.workDir, 'performance-data.json');
      if (!fs.existsSync(dataPath)) return;

      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      this.measurements = data.measurements ?? [];
      this.memorySnapshots = data.memorySnapshots ?? [];

      for (const { name, samples } of data.baselines ?? []) {
        this.baselines.set(name, samples);
      }

      this.log.info('性能数据已加载', {
        measurements: this.measurements.length,
        memorySnapshots: this.memorySnapshots.length,
      });
    } catch (err: unknown) {
      this.log.error('加载性能数据失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 销毁 */
  destroy(): void {
    this.stopMemoryMonitoring();
    this.saveData();
  }
}
