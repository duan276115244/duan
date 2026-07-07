/**
 * 性能监控与自动优化系统 — PerformanceMonitor
 *
 * 实时性能监控、异常检测、自动瓶颈分析
 * 目标：响应时间降低 40%+，P95 < 1s，峰值容量提升 50%
 *
 * 核心能力：
 * 1. 实时监控 — 追踪响应时间、Token用量、工具调用耗时、内存占用、错误率
 * 2. 异常检测 — 基于滚动统计（> 2σ）自动检测异常指标
 * 3. 瓶颈分析 — 识别最慢工具、最高错误率操作、内存热点
 * 4. 告警规则 — 指标超阈值时通过 EventBus 广播事件
 * 5. 仪表盘 — 格式化关键指标、异常告警、趋势指示器
 * 6. Agent Loop 工具 — 通过 getToolDefinitions() 注册为可用工具
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 指标数据点 */
export interface MetricPoint {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

/** 指标统计信息 */
export interface MetricStats {
  name: string;
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stddev: number;
  lastValue: number;
  trend: 'up' | 'down' | 'stable';
  anomaly: boolean;
}

/** 瓶颈报告 */
export interface BottleneckReport {
  slowestTools: Array<{ name: string; p95: number; calls: number }>;
  highestErrorRates: Array<{ name: string; rate: number; count: number }>;
  memoryHotspots: Array<{ name: string; avgMemory: number }>;
  suggestions: OptimizationSuggestion[];
  overallHealth: 'healthy' | 'degraded' | 'critical';
}

/** 优化建议 */
export interface OptimizationSuggestion {
  area: string;
  current: string;
  suggested: string;
  expectedImprovement: string;
  priority: 'high' | 'medium' | 'low';
}

/** 告警规则 */
export interface AlertRule {
  id: string;
  metricName: string;
  operator: '>' | '<';
  threshold: number;
  enabled: boolean;
  triggered: number;
  lastTriggered?: number;
}


// ============ 内部辅助类型 ============

/** 滚动统计窗口 */
interface RollingWindow {
  values: number[];
  timestamps: number[];
  sum: number;
  sumSq: number;
}

/** 指标缓冲区 */
interface MetricBuffer {
  points: MetricPoint[];
  head: number;
  size: number;
}

// ============ 常量 ============

const BUFFER_CAPACITY = 10000;          // 环形缓冲区容量
const COLLECTION_INTERVAL_MS = 10000;   // 采集间隔 10s
const ANOMALY_SIGMA_MULTIPLIER = 2;     // 异常检测：2σ
const TREND_WINDOW_SIZE = 20;           // 趋势判断窗口大小
const PERCENTILE_EPSILON = 0.001;       // 百分位计算精度

// ============ 主类 ============

export class PerformanceMonitor {
  private log = logger.child({ module: 'PerformanceMonitor' });

  // 指标存储：环形缓冲区
  private buffers = new Map<string, MetricBuffer>();

  // 滚动统计
  private rollingWindows = new Map<string, RollingWindow>();

  // 缓存的统计结果
  private cachedStats = new Map<string, MetricStats>();

  // 告警规则
  private alertRules = new Map<string, AlertRule>();

  // 监控状态
  private monitoring = false;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  // 异常事件计数
  private anomalyCount = 0;
  private totalMetricsRecorded = 0;

  constructor() {
    this.log.info('PerformanceMonitor 已初始化');
  }

  // ============ 监控控制 ============

  /**
   * 启动实时监控
   * - 每 10 秒采集一次系统指标
   * - 自动检测异常（值 > 滚动均值 ± 2σ）
   */
  startMonitoring(): { status: string; interval: number; timestamp: number } {
    if (this.monitoring) {
      this.log.warn('监控已在运行中');
      return { status: 'already_running', interval: COLLECTION_INTERVAL_MS, timestamp: Date.now() };
    }

    this.monitoring = true;
    this.startTime = Date.now();
    this.log.info('实时监控已启动', { intervalMs: COLLECTION_INTERVAL_MS });

    // 定时采集系统级指标
    this.monitorTimer = setInterval(() => {
      this.collectSystemMetrics();
    }, COLLECTION_INTERVAL_MS);

    // 首次立即采集
    this.collectSystemMetrics();

    EventBus.getInstance().emitSync('perf.monitoring_started', {
      interval: COLLECTION_INTERVAL_MS,
      timestamp: this.startTime,
    }, { source: 'PerformanceMonitor' });

    return { status: 'started', interval: COLLECTION_INTERVAL_MS, timestamp: this.startTime };
  }

  /**
   * 停止监控
   * - 返回最终统计信息
   */
  stopMonitoring(): { status: string; duration: number; totalMetrics: number; anomalyCount: number; timestamp: number } {
    if (!this.monitoring) {
      return { status: 'not_running', duration: 0, totalMetrics: 0, anomalyCount: 0, timestamp: Date.now() };
    }

    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    const duration = Date.now() - this.startTime;
    this.monitoring = false;

    this.log.info('实时监控已停止', {
      durationMs: duration,
      totalMetrics: this.totalMetricsRecorded,
      anomalies: this.anomalyCount,
    });

    EventBus.getInstance().emitSync('perf.monitoring_stopped', {
      duration,
      totalMetrics: this.totalMetricsRecorded,
      anomalyCount: this.anomalyCount,
    }, { source: 'PerformanceMonitor' });

    return {
      status: 'stopped',
      duration,
      totalMetrics: this.totalMetricsRecorded,
      anomalyCount: this.anomalyCount,
      timestamp: Date.now(),
    };
  }

  // ============ 指标记录 ============

  /**
   * 记录指标
   * - 存入环形缓冲区（最近 10000 个点）
   * - 更新滚动统计（mean, p50, p95, p99, min, max）
   * - 检查异常阈值
   * - 返回是否检测到异常
   */
  recordMetric(name: string, value: number, tags?: Record<string, string>): boolean {
    const point: MetricPoint = {
      name,
      value,
      timestamp: Date.now(),
      tags,
    };

    // 写入环形缓冲区
    let buffer = this.buffers.get(name);
    if (!buffer) {
      buffer = { points: new Array<MetricPoint>(BUFFER_CAPACITY), head: 0, size: 0 };
      this.buffers.set(name, buffer);
    }
    buffer.points[buffer.head] = point;
    buffer.head = (buffer.head + 1) % BUFFER_CAPACITY;
    if (buffer.size < BUFFER_CAPACITY) buffer.size++;

    // 更新滚动窗口
    this.updateRollingWindow(name, value);

    // 重新计算统计
    const stats = this.computeStats(name);
    this.cachedStats.set(name, stats);

    // 异常检测
    const isAnomaly = this.detectAnomaly(name, value, stats);
    if (isAnomaly) {
      this.anomalyCount++;
      this.log.debug('异常指标检测', {
        metric: name,
        value,
        mean: stats.mean.toFixed(2),
        stddev: stats.stddev.toFixed(2),
        sigma: ((value - stats.mean) / (stats.stddev || PERCENTILE_EPSILON)).toFixed(2),
      });

      // 异步派发异常事件，避免在指标记录主路径上同步阻塞订阅者处理
      const anomalyPayload = {
        metric: name,
        value,
        mean: stats.mean,
        stddev: stats.stddev,
        timestamp: point.timestamp,
        tags,
      };
      queueMicrotask(() => {
        try {
          EventBus.getInstance().emit('perf.anomaly_detected', anomalyPayload, { source: 'PerformanceMonitor' });
        } catch {
          // 事件派发失败不应影响指标记录主路径
        }
      });
    }

    // 检查告警规则
    this.checkAlerts(name, value);

    this.totalMetricsRecorded++;
    return isAnomaly;
  }

  /**
   * 获取指标当前值和统计信息
   * - 如果 names 为空，返回所有指标
   */
  getMetrics(names?: string[]): Record<string, MetricStats> {
    const result: Record<string, MetricStats> = {};
    const targetNames = names && names.length > 0 ? names : Array.from(this.cachedStats.keys());

    for (const name of targetNames) {
      const stats = this.cachedStats.get(name);
      if (stats) {
        result[name] = { ...stats };
      }
    }

    return result;
  }

  // ============ 瓶颈分析 ============

  /**
   * 分析性能瓶颈
   * - 识别最慢工具（按 P95 延迟）
   * - 识别最高错误率操作
   * - 识别内存密集操作
   * - 生成优化建议
   */
  analyzeBottlenecks(): BottleneckReport {
    const allStats = this.getMetrics();

    // 按类别分组指标
    const toolLatencyStats: Array<{ name: string; p95: number; calls: number }> = [];
    const errorRateStats: Array<{ name: string; rate: number; count: number }> = [];
    const memoryStats: Array<{ name: string; avgMemory: number }> = [];

    for (const [metricName, stats] of Object.entries(allStats)) {
      if (metricName.includes('tool.') && metricName.includes('.duration')) {
        // 工具调用延迟
        const toolName = metricName.replace('tool.', '').replace('.duration', '');
        toolLatencyStats.push({ name: toolName, p95: stats.p95, calls: stats.count });
      } else if (metricName.includes('error_rate') || metricName.includes('.error_rate')) {
        // 错误率
        const opName = metricName.replace('.error_rate', '').replace('error_rate', 'global');
        errorRateStats.push({ name: opName, rate: stats.lastValue, count: stats.count });
      } else if (metricName.includes('memory') || metricName.includes('.memory')) {
        // 内存
        const opName = metricName.replace('.memory', '').replace('memory', 'global');
        memoryStats.push({ name: opName, avgMemory: stats.mean });
      }
    }

    // 排序
    const slowestTools = toolLatencyStats
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 10);

    const highestErrorRates = errorRateStats
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 10);

    const memoryHotspots = memoryStats
      .sort((a, b) => b.avgMemory - a.avgMemory)
      .slice(0, 10);

    // 生成优化建议
    const suggestions = this.generateSuggestions(slowestTools, highestErrorRates, memoryHotspots, allStats);


    // 判断整体健康状态
    const overallHealth = this.assessHealth(slowestTools, highestErrorRates, allStats);

    const report: BottleneckReport = {
      slowestTools,
      highestErrorRates,
      memoryHotspots,
      suggestions,
      overallHealth,
    };

    this.log.info('瓶颈分析完成', {
      health: overallHealth,
      slowTools: slowestTools.length,
      errorOps: highestErrorRates.length,
      memoryHotspots: memoryHotspots.length,
      suggestions: suggestions.length,
    });

    EventBus.getInstance().emitSync('perf.bottleneck_analyzed', {
      health: overallHealth,
      slowToolsCount: slowestTools.length,
      suggestionsCount: suggestions.length,
    }, { source: 'PerformanceMonitor' });

    return report;
  }

  // ============ 仪表盘 ============

  /**
   * 获取格式化仪表盘视图
   * - 关键指标摘要
   * - 异常告警
   * - 趋势指示器
   */
  getDashboard(): string {
    const lines: string[] = [];
    const allStats = this.getMetrics();
    const now = Date.now();

    lines.push('╔══════════════════════════════════════════════════════════╗');
    lines.push('║          📊 段先生 — 性能监控仪表盘                      ║');
    lines.push('╚══════════════════════════════════════════════════════════╝');
    lines.push('');

    // 系统概览
    const uptime = this.startTime > 0 ? ((now - this.startTime) / 1000).toFixed(1) + 's' : '未启动';
    lines.push(`⏱  监控状态: ${this.monitoring ? '🟢 运行中' : '🔴 已停止'}  |  运行时间: ${uptime}`);
    lines.push(`📈 总指标数: ${this.totalMetricsRecorded}  |  异常次数: ${this.anomalyCount}  |  指标种类: ${Object.keys(allStats).length}`);
    lines.push('');

    // 关键指标
    lines.push('── 🔑 关键指标 ──────────────────────────────────────────');
    const keyMetrics = ['response_time', 'token_usage', 'error_rate', 'memory_usage'];
    for (const key of keyMetrics) {
      const stats = allStats[key];
      if (stats) {
        let trendIcon: string;
        if (stats.trend === 'up') {
          trendIcon = '📈';
        } else if (stats.trend === 'down') {
          trendIcon = '📉';
        } else {
          trendIcon = '➡️';
        }
        const anomalyIcon = stats.anomaly ? '⚠️' : '✅';
        lines.push(`  ${anomalyIcon} ${key}: ${stats.lastValue.toFixed(2)} ${trendIcon}`);
        lines.push(`     P50=${stats.p50.toFixed(2)}  P95=${stats.p95.toFixed(2)}  P99=${stats.p99.toFixed(2)}  Mean=${stats.mean.toFixed(2)}`);
      }
    }
    lines.push('');

    // 工具延迟排名
    lines.push('── 🔧 工具延迟 TOP5 ────────────────────────────────────');
    const toolMetrics = Object.entries(allStats)
      .filter(([name]) => name.includes('tool.') && name.includes('.duration'))
      .sort(([, a], [, b]) => b.p95 - a.p95)
      .slice(0, 5);

    if (toolMetrics.length > 0) {
      for (const [name, stats] of toolMetrics) {
        const toolName = name.replace('tool.', '').replace('.duration', '');
        lines.push(`  ${toolName}: P95=${stats.p95.toFixed(1)}ms  调用次数=${stats.count}`);
      }
    } else {
      lines.push('  (暂无工具调用数据)');
    }
    lines.push('');

    // 异常告警
    lines.push('── ⚠️ 异常告警 ─────────────────────────────────────────');
    const anomalies = Object.entries(allStats).filter(([, s]) => s.anomaly);
    if (anomalies.length > 0) {
      for (const [name, stats] of anomalies) {
        const sigmaDev = ((stats.lastValue - stats.mean) / (stats.stddev || PERCENTILE_EPSILON)).toFixed(1);
        lines.push(`  🚨 ${name}: 当前=${stats.lastValue.toFixed(2)}  均值=${stats.mean.toFixed(2)}  偏离=${sigmaDev}σ`);
      }
    } else {
      lines.push('  ✅ 所有指标正常');
    }
    lines.push('');

    // 告警规则状态
    lines.push('── 🔔 告警规则 ─────────────────────────────────────────');
    const activeAlerts = Array.from(this.alertRules.values()).filter(r => r.enabled);
    if (activeAlerts.length > 0) {
      for (const rule of activeAlerts) {
        const op = rule.operator === '>' ? '超过' : '低于';
        lines.push(`  ${rule.id}: ${rule.metricName} ${op} ${rule.threshold}  触发次数=${rule.triggered}`);
      }
    } else {
      lines.push('  (暂无告警规则)');
    }

    lines.push('');
    lines.push('──────────────────────────────────────────────────────────');

    return lines.join('\n');
  }

  // ============ 告警规则 ============

  /**
   * 设置告警规则
   * - 当指标超过/低于阈值时，通过 EventBus 广播事件
   * - 支持 > 和 < 运算符
   * - 返回告警 ID
   */
  setAlert(metricName: string, threshold: number, operator: '>' | '<' = '>'): string {
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const rule: AlertRule = {
      id,
      metricName,
      operator,
      threshold,
      enabled: true,
      triggered: 0,
    };

    this.alertRules.set(id, rule);

    this.log.info('告警规则已设置', {
      alertId: id,
      metric: metricName,
      operator,
      threshold,
    });

    return id;
  }

  // ============ 统计信息 ============

  /**
   * 获取监控统计摘要
   */
  getStats(): {
    monitoring: boolean;
    uptime: number;
    totalMetricsRecorded: number;
    anomalyCount: number;
    metricCount: number;
    alertRuleCount: number;
    bufferUtilization: number;
  } {
    let totalBufferUsed = 0;
    let totalBufferCapacity = 0;
    for (const buffer of Array.from(this.buffers.values())) {
      totalBufferUsed += buffer.size;
      totalBufferCapacity += BUFFER_CAPACITY;
    }

    return {
      monitoring: this.monitoring,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      totalMetricsRecorded: this.totalMetricsRecorded,
      anomalyCount: this.anomalyCount,
      metricCount: this.cachedStats.size,
      alertRuleCount: this.alertRules.size,
      bufferUtilization: totalBufferCapacity > 0 ? totalBufferUsed / totalBufferCapacity : 0,
    };
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pm = this;

    return [
      {
        name: 'perf_record',
        description: '记录性能指标。用于追踪响应时间、Token用量、工具调用耗时、内存占用等。系统自动检测异常（值偏离均值超过2倍标准差）。',
        parameters: {
          name: {
            type: 'string',
            description: '指标名称，如 response_time、tool.search.duration、error_rate、memory_usage',
            required: true,
          },
          value: {
            type: 'number',
            description: '指标值',
            required: true,
          },
          tags: {
            type: 'string',
            description: '可选标签，JSON 格式，如 {"tool":"search","version":"v2"}',
            required: false,
          },
        },
        execute: (args) => {
          try {
            const name = args.name as string;
            const value = Number(args.value);
            let tags: Record<string, string> | undefined;
            if (args.tags) {
              try {
                tags = JSON.parse(args.tags as string);
              } catch {
                tags = undefined;
              }
            }

            const isAnomaly = pm.recordMetric(name, value, tags);
            const stats = pm.getMetrics([name])[name];

            let result = `✅ 指标已记录: ${name}=${value}`;
            if (stats) {
              result += `\n   均值=${stats.mean.toFixed(2)}  P95=${stats.p95.toFixed(2)}  P99=${stats.p99.toFixed(2)}  趋势=${stats.trend}`;
            }
            if (isAnomaly) {
              result += `\n⚠️ 异常检测: ${name}=${value} 偏离均值超过2σ`;
            }
            return Promise.resolve(result);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 记录指标失败: ${msg}`);
          }
        },
      },
      {
        name: 'perf_analyze',
        description: '分析性能瓶颈。识别最慢工具（P95延迟）、最高错误率操作、内存热点，并生成优化建议。返回 BottleneckReport。',
        parameters: {
          detail: {
            type: 'string',
            description: '分析详细程度: summary(摘要) 或 full(完整报告)',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const report = pm.analyzeBottlenecks();
            const detail = (args.detail as string) || 'summary';

            const lines: string[] = [];
            lines.push(`📊 瓶颈分析报告 — 健康状态: ${report.overallHealth}`);

            if (report.slowestTools.length > 0) {
              lines.push('\n🐌 最慢工具 (P95延迟):');
              for (const t of report.slowestTools.slice(0, detail === 'full' ? 10 : 5)) {
                lines.push(`  - ${t.name}: P95=${t.p95.toFixed(1)}ms  调用=${t.calls}`);
              }
            }

            if (report.highestErrorRates.length > 0) {
              lines.push('\n❌ 最高错误率:');
              for (const e of report.highestErrorRates.slice(0, detail === 'full' ? 10 : 5)) {
                lines.push(`  - ${e.name}: 错误率=${(e.rate * 100).toFixed(1)}%  次数=${e.count}`);
              }
            }

            if (report.memoryHotspots.length > 0) {
              lines.push('\n💾 内存热点:');
              for (const m of report.memoryHotspots.slice(0, detail === 'full' ? 10 : 5)) {
                lines.push(`  - ${m.name}: 平均=${(m.avgMemory / 1024 / 1024).toFixed(1)}MB`);
              }
            }

            if (report.suggestions.length > 0) {
              lines.push('\n💡 优化建议:');
              for (const s of report.suggestions) {
                let prio: string;
                if (s.priority === 'high') {
                  prio = '🔴';
                } else if (s.priority === 'medium') {
                  prio = '🟡';
                } else {
                  prio = '🟢';
                }
                lines.push(`  ${prio} [${s.area}] ${s.current} → ${s.suggested}`);
                lines.push(`     预期提升: ${s.expectedImprovement}`);
              }
            }

            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 瓶颈分析失败: ${msg}`);
          }
        },
      },
      {
        name: 'perf_dashboard',
        description: '获取性能监控仪表盘。展示关键指标摘要、异常告警、趋势指示器和告警规则状态。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            return Promise.resolve(pm.getDashboard());
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 获取仪表盘失败: ${msg}`);
          }
        },
      },
      {
        name: 'perf_alert',
        description: '设置性能告警规则。当指标超过或低于阈值时，系统通过事件总线广播告警事件。',
        parameters: {
          metricName: {
            type: 'string',
            description: '要监控的指标名称，如 response_time、error_rate',
            required: true,
          },
          threshold: {
            type: 'number',
            description: '告警阈值',
            required: true,
          },
          operator: {
            type: 'string',
            description: '比较运算符: > (超过阈值告警) 或 < (低于阈值告警)，默认 >',
            required: false,
          },
        },
        execute: (args) => {
          try {
            const metricName = args.metricName as string;
            const threshold = Number(args.threshold);
            const operator = (args.operator as '>' | '<') || '>';

            if (operator !== '>' && operator !== '<') {
              return Promise.resolve('❌ operator 只支持 > 或 <');
            }

            const alertId = pm.setAlert(metricName, threshold, operator);
            const opText = operator === '>' ? '超过' : '低于';
            return Promise.resolve(`✅ 告警规则已设置\n   ID: ${alertId}\n   规则: ${metricName} ${opText} ${threshold} 时触发`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 设置告警失败: ${msg}`);
          }
        },
      },
    ];
  }

  // ============ 私有方法 ============

  /** 采集系统级指标 */
  private collectSystemMetrics(): void {
    const memUsage = process.memoryUsage();

    // 内存指标
    this.recordMetric('memory_usage', memUsage.heapUsed, { type: 'heap_used' });
    this.recordMetric('memory_rss', memUsage.rss, { type: 'rss' });
    this.recordMetric('memory_external', memUsage.external, { type: 'external' });

    // CPU 指标（Node.js process.cpuUsage 返回微秒）
    const cpuUsage = process.cpuUsage();
    this.recordMetric('cpu_user', cpuUsage.user / 1000, { type: 'user_ms' });
    this.recordMetric('cpu_system', cpuUsage.system / 1000, { type: 'system_ms' });

    this.log.debug('系统指标已采集', {
      heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(1) + 'MB',
      rss: (memUsage.rss / 1024 / 1024).toFixed(1) + 'MB',
    });
  }

  /** 更新滚动窗口 */
  private updateRollingWindow(name: string, value: number): void {
    let window = this.rollingWindows.get(name);
    if (!window) {
      window = { values: [], timestamps: [], sum: 0, sumSq: 0 };
      this.rollingWindows.set(name, window);
    }

    window.values.push(value);
    window.timestamps.push(Date.now());
    window.sum += value;
    window.sumSq += value * value;

    // 限制窗口大小，保持与缓冲区一致
    if (window.values.length > BUFFER_CAPACITY) {
      const removed = window.values.shift()!;
      window.timestamps.shift();
      window.sum -= removed;
      window.sumSq -= removed * removed;
    }
  }

  /** 计算指标统计信息 */
  private computeStats(name: string): MetricStats {
    const buffer = this.buffers.get(name);
    const window = this.rollingWindows.get(name);

    const count = buffer?.size ?? 0;
    const lastValue = buffer && buffer.size > 0
      ? buffer.points[(buffer.head - 1 + BUFFER_CAPACITY) % BUFFER_CAPACITY].value
      : 0;

    if (count === 0 || !window || window.values.length === 0) {
      return {
        name,
        count: 0,
        mean: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        stddev: 0,
        lastValue: 0,
        trend: 'stable',
        anomaly: false,
      };
    }

    const values = window.values;
    const mean = window.sum / values.length;
    const variance = Math.max(0, window.sumSq / values.length - mean * mean);
    const stddev = Math.sqrt(variance);

    // 排序后计算百分位
    const sorted = [...values].sort((a, b) => a - b);
    const p50 = this.percentile(sorted, 0.50);
    const p95 = this.percentile(sorted, 0.95);
    const p99 = this.percentile(sorted, 0.99);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // 趋势判断：比较最近窗口与之前窗口的均值
    const trend = this.computeTrend(values);

    // 异常标记
    const anomaly = this.detectAnomaly(name, lastValue, {
      name, count, mean, p50, p95, p99, min, max, stddev, lastValue, trend, anomaly: false,
    });

    return {
      name,
      count,
      mean,
      p50,
      p95,
      p99,
      min,
      max,
      stddev,
      lastValue,
      trend,
      anomaly,
    };
  }

  /** 计算百分位值 */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];

    const idx = p * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    const frac = idx - lower;

    if (lower === upper) return sorted[lower];
    return sorted[lower] * (1 - frac) + sorted[upper] * frac;
  }

  /** 计算趋势方向 */
  private computeTrend(values: number[]): 'up' | 'down' | 'stable' {
    if (values.length < TREND_WINDOW_SIZE) return 'stable';

    const recent = values.slice(-TREND_WINDOW_SIZE);
    const half = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, half);
    const secondHalf = recent.slice(half);

    const meanFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const meanSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    // 变化幅度 < 5% 视为稳定
    const changeRate = meanFirst !== 0 ? (meanSecond - meanFirst) / Math.abs(meanFirst) : 0;

    if (changeRate > 0.05) return 'up';
    if (changeRate < -0.05) return 'down';
    return 'stable';
  }

  /** 异常检测：值偏离均值超过 2σ */
  private detectAnomaly(_name: string, value: number, stats: MetricStats): boolean {
    if (stats.count < 10) return false; // 样本不足，跳过异常检测
    if (stats.stddev < PERCENTILE_EPSILON) return false; // 标准差过小，跳过

    const sigma = Math.abs(value - stats.mean) / stats.stddev;
    return sigma > ANOMALY_SIGMA_MULTIPLIER;
  }

  /** 检查告警规则 */
  private checkAlerts(metricName: string, value: number): void {
    for (const rule of Array.from(this.alertRules.values())) {
      if (!rule.enabled) continue;
      if (rule.metricName !== metricName) continue;

      const triggered = rule.operator === '>'
        ? value > rule.threshold
        : value < rule.threshold;

      if (triggered) {
        rule.triggered++;
        rule.lastTriggered = Date.now();

        this.log.warn('告警规则触发', {
          alertId: rule.id,
          metric: metricName,
          value,
          threshold: rule.threshold,
          operator: rule.operator,
        });

        EventBus.getInstance().emitSync('perf.alert_triggered', {
          alertId: rule.id,
          metric: metricName,
          value,
          threshold: rule.threshold,
          operator: rule.operator,
          triggeredCount: rule.triggered,
          timestamp: Date.now(),
        }, { source: 'PerformanceMonitor' });
      }
    }
  }

  /** 生成优化建议 */
  private generateSuggestions(
    slowestTools: Array<{ name: string; p95: number; calls: number }>,
    highestErrorRates: Array<{ name: string; rate: number; count: number }>,
    _memoryHotspots: Array<{ name: string; avgMemory: number }>,
    allStats: Record<string, MetricStats>,
  ): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // 针对慢工具的建议
    for (const tool of slowestTools) {
      if (tool.p95 > 2000) {
        suggestions.push({
          area: `工具延迟: ${tool.name}`,
          current: `P95=${tool.p95.toFixed(0)}ms`,
          suggested: '增加缓存层、并行化子任务、或使用更快的替代实现',
          expectedImprovement: '预计延迟降低 40-60%',
          priority: 'high',
        });
      } else if (tool.p95 > 1000) {
        suggestions.push({
          area: `工具延迟: ${tool.name}`,
          current: `P95=${tool.p95.toFixed(0)}ms`,
          suggested: '优化内部逻辑、减少不必要的 I/O、启用结果缓存',
          expectedImprovement: '预计延迟降低 20-40%',
          priority: 'medium',
        });
      }
    }

    // 针对高错误率的建议
    for (const err of highestErrorRates) {
      if (err.rate > 0.1) {
        suggestions.push({
          area: `错误率: ${err.name}`,
          current: `错误率=${(err.rate * 100).toFixed(1)}%`,
          suggested: '添加重试机制、增加输入校验、引入熔断器模式',
          expectedImprovement: '预计错误率降低 50-80%',
          priority: 'high',
        });
      } else if (err.rate > 0.05) {
        suggestions.push({
          area: `错误率: ${err.name}`,
          current: `错误率=${(err.rate * 100).toFixed(1)}%`,
          suggested: '增加异常处理和降级策略',
          expectedImprovement: '预计错误率降低 30-50%',
          priority: 'medium',
        });
      }
    }

    // 针对响应时间的建议
    const responseTimeStats = allStats['response_time'];
    if (responseTimeStats && responseTimeStats.p95 > 1000) {
      suggestions.push({
        area: '整体响应时间',
        current: `P95=${responseTimeStats.p95.toFixed(0)}ms (目标<1000ms)`,
        suggested: '启用上下文压缩、减少工具调用链深度、并行执行独立任务',
        expectedImprovement: '预计响应时间降低 40%+',
        priority: 'high',
      });
    }

    // 针对 Token 用量的建议
    const tokenStats = allStats['token_usage'];
    if (tokenStats && tokenStats.mean > 4000) {
      suggestions.push({
        area: 'Token 用量',
        current: `平均=${tokenStats.mean.toFixed(0)} tokens`,
        suggested: '启用 Prompt 压缩、使用更精简的系统提示、减少冗余上下文',
        expectedImprovement: '预计 Token 用量降低 30-50%',
        priority: 'medium',
      });
    }

    // 针对内存的建议
    const memStats = allStats['memory_usage'];
    if (memStats && memStats.lastValue > 500 * 1024 * 1024) {
      suggestions.push({
        area: '内存占用',
        current: `堆内存=${(memStats.lastValue / 1024 / 1024).toFixed(0)}MB`,
        suggested: '清理过期缓存、释放不用的引用、启用流式处理',
        expectedImprovement: '预计内存降低 30-50%',
        priority: memStats.lastValue > 1024 * 1024 * 1024 ? 'high' : 'medium',
      });
    }

    // 如果没有具体建议，给出通用建议
    if (suggestions.length === 0) {
      suggestions.push({
        area: '系统优化',
        current: '当前性能正常',
        suggested: '持续监控，关注趋势变化，定期进行瓶颈分析',
        expectedImprovement: '维持当前性能水平，预防退化',
        priority: 'low',
      });
    }

    return suggestions.sort((a, b) => {
      const prioMap = { high: 0, medium: 1, low: 2 };
      return prioMap[a.priority] - prioMap[b.priority];
    });
  }

  /** 评估整体健康状态 */
  private assessHealth(
    slowestTools: Array<{ name: string; p95: number; calls: number }>,
    highestErrorRates: Array<{ name: string; rate: number; count: number }>,
    allStats: Record<string, MetricStats>,
  ): 'healthy' | 'degraded' | 'critical' {
    let criticalCount = 0;
    let degradedCount = 0;

    // 检查响应时间
    const responseTimeStats = allStats['response_time'];
    if (responseTimeStats) {
      if (responseTimeStats.p95 > 3000) criticalCount++;
      else if (responseTimeStats.p95 > 1000) degradedCount++;
    }

    // 检查错误率
    for (const err of highestErrorRates) {
      if (err.rate > 0.2) criticalCount++;
      else if (err.rate > 0.05) degradedCount++;
    }

    // 检查工具延迟
    for (const tool of slowestTools) {
      if (tool.p95 > 5000) criticalCount++;
      else if (tool.p95 > 2000) degradedCount++;
    }

    // 检查内存
    const memStats = allStats['memory_usage'];
    if (memStats) {
      if (memStats.lastValue > 1024 * 1024 * 1024) criticalCount++;
      else if (memStats.lastValue > 500 * 1024 * 1024) degradedCount++;
    }

    // 检查异常指标数量
    const anomalyMetrics = Object.values(allStats).filter(s => s.anomaly).length;
    if (anomalyMetrics > 3) criticalCount++;
    else if (anomalyMetrics > 1) degradedCount++;

    if (criticalCount > 0) return 'critical';
    if (degradedCount > 0) return 'degraded';
    return 'healthy';
  }
}
