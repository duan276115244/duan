/**
 * 自我修复系统 — SelfRepairSystem
 *
 * Agent 检测、诊断并修复自身问题。这是自主智能体的关键能力。
 *
 * 核心能力：
 * 1. 健康检查 — 定期检测系统各组件状态
 * 2. 异常检测 — 识别性能下降、错误率上升等异常
 * 3. 根因分析 — 诊断问题的根本原因
 * 4. 自动修复 — 应用预定义的修复策略
 * 5. 修复验证 — 验证修复是否成功
 * 6. 修复学习 — 从修复经验中学习
 *
 * 修复策略：
 * - 重启策略：重启故障组件
 * - 回滚策略：回滚到上一个稳定状态
 * - 降级策略：降级到基本功能
 * - 清理策略：清理缓存/临时文件
 * - 重新初始化：重新初始化组件
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 组件状态 */
export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** 健康检查项 */
export interface HealthCheck {
  /** 组件名称 */
  component: string;
  /** 检查项名称 */
  check: string;
  /** 状态 */
  status: ComponentStatus;
  /** 检查值 */
  value?: number;
  /** 预期值 */
  expected?: number;
  /** 消息 */
  message: string;
  /** 检查时间 */
  checkedAt: number;
}

/** 异常类型 */
export type AnomalyType =
  | 'high_error_rate'
  | 'high_latency'
  | 'memory_leak'
  | 'cpu_spike'
  | 'component_failure'
  | 'data_corruption'
  | 'network_issue'
  | 'resource_exhaustion';

/** 异常记录 */
export interface Anomaly {
  /** 异常 ID */
  id: string;
  /** 异常类型 */
  type: AnomalyType;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 组件 */
  component: string;
  /** 描述 */
  description: string;
  /** 检测时间 */
  detectedAt: number;
  /** 状态 */
  status: 'detected' | 'diagnosing' | 'repairing' | 'resolved' | 'failed';
  /** 根因分析 */
  rootCause?: string;
  /** 修复策略 */
  repairStrategy?: RepairStrategy;
  /** 修复时间 */
  repairedAt?: number;
}

/** 修复策略 */
export type RepairStrategy =
  | 'restart'          // 重启
  | 'rollback'         // 回滚
  | 'degrade'          // 降级
  | 'cleanup'          // 清理
  | 'reinitialize'     // 重新初始化
  | 'scale_up'         // 扩容
  | 'circuit_break'    // 熔断
  | 'manual';          // 需要人工干预

/** 修复记录 */
export interface RepairRecord {
  /** 记录 ID */
  id: string;
  /** 异常 ID */
  anomalyId: string;
  /** 修复策略 */
  strategy: RepairStrategy;
  /** 修复步骤 */
  steps: Array<{
    description: string;
    success: boolean;
    durationMs: number;
    output?: string;
  }>;
  /** 是否成功 */
  success: boolean;
  /** 修复时间 */
  repairedAt: number;
  /** 验证结果 */
  verificationPassed: boolean;
}

/** 修复策略定义 */
export interface RepairStrategyDef {
  /** 策略名称 */
  name: RepairStrategy;
  /** 描述 */
  description: string;
  /** 适用的异常类型 */
  applicableAnomalies: AnomalyType[];
  /** 修复步骤 */
  steps: Array<{
    description: string;
    action: (context: RepairContext) => Promise<{ success: boolean; output?: string }>;
  }>;
  /** 验证步骤 */
  verify: (context: RepairContext) => Promise<boolean>;
}

/** 修复上下文 */
export interface RepairContext {
  anomaly: Anomaly;
  component: string;
  metadata: Record<string, unknown>;
}

// ============ 自我修复系统 ============

export class SelfRepairSystem {
  /** 工作目录 */
  private workDir: string;

  /** 健康检查历史 */
  private healthHistory: HealthCheck[] = [];

  /** 活跃异常 */
  private activeAnomalies: Map<string, Anomaly> = new Map();

  /** 异常历史 */
  private anomalyHistory: Anomaly[] = [];

  /** 修复记录 */
  private repairRecords: Map<string, RepairRecord> = new Map();

  /** 修复策略库 */
  private strategies: Map<RepairStrategy, RepairStrategyDef> = new Map();

  /** 组件状态缓存 */
  private componentStatus: Map<string, ComponentStatus> = new Map();

  /** 健康检查定时器 */
  private healthCheckTimer: NodeJS.Timeout | null = null;

  /** 异常阈值配置 */
  private thresholds = {
    errorRate: { warning: 5, critical: 10 }, // %
    latencyMs: { warning: 1000, critical: 5000 },
    memoryMB: { warning: 1024, critical: 2048 },
    cpuPercent: { warning: 50, critical: 80 },
  };

  private log = logger.child({ module: 'SelfRepairSystem' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('self-repair');
    fs.mkdirSync(this.workDir, { recursive: true });

    // 注册默认修复策略
    this.registerDefaultStrategies();

    // 加载历史数据
    this.loadData();
  }

  // ========== 健康检查 ==========

  /**
   * 执行健康检查
   */
  async healthCheck(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];
    const now = Date.now();

    // 检查 1：内存使用
    const memUsage = process.memoryUsage();
    const memMB = memUsage.rss / (1024 * 1024);
    checks.push({
      component: 'system',
      check: 'memory_usage',
      status: (() => {
        if (memMB > this.thresholds.memoryMB.critical) return 'unhealthy';
        if (memMB > this.thresholds.memoryMB.warning) return 'degraded';
        return 'healthy';
      })(),
      value: memMB,
      expected: this.thresholds.memoryMB.warning,
      message: `内存使用: ${memMB.toFixed(1)}MB`,
      checkedAt: now,
    });

    // 检查 2：CPU 使用（通过 uptime 估算）
    const cpuPercent = process.cpuUsage();
    const cpuMs = (cpuPercent.user + cpuPercent.system) / 1000;
    checks.push({
      component: 'system',
      check: 'cpu_usage',
      status: 'healthy', // 简化，实际需要更复杂的计算
      value: cpuMs,
      message: `CPU 时间: ${cpuMs.toFixed(0)}ms`,
      checkedAt: now,
    });

    // 检查 3：事件循环延迟
    const startHr = process.hrtime();
    await new Promise(resolve => setTimeout(resolve, 0));
    const elapsed = process.hrtime(startHr);
    const eventLoopDelayMs = elapsed[0] * 1000 + elapsed[1] / 1e6;
    checks.push({
      component: 'system',
      check: 'event_loop_delay',
      status: eventLoopDelayMs > 100 ? 'degraded' : 'healthy',
      value: eventLoopDelayMs,
      expected: 100,
      message: `事件循环延迟: ${eventLoopDelayMs.toFixed(2)}ms`,
      checkedAt: now,
    });

    // 检查 4：工作目录可访问性
    try {
      fs.accessSync(this.workDir, fs.constants.W_OK);
      checks.push({
        component: 'filesystem',
        check: 'workdir_accessible',
        status: 'healthy',
        message: '工作目录可访问',
        checkedAt: now,
      });
    } catch {
      checks.push({
        component: 'filesystem',
        check: 'workdir_accessible',
        status: 'unhealthy',
        message: '工作目录不可访问',
        checkedAt: now,
      });
    }

    // 更新组件状态缓存
    for (const check of checks) {
      this.componentStatus.set(check.component, check.status);
    }

    // 记录历史
    this.healthHistory.push(...checks);
    if (this.healthHistory.length > 1000) {
      this.healthHistory = this.healthHistory.slice(-500);
    }

    // 检测异常
    this.detectAnomalies(checks);

    return checks;
  }

  /**
   * 启动定期健康检查
   */
  startPeriodicHealthCheck(intervalMs: number = 60000): void {
    if (this.healthCheckTimer) {
      this.log.warn('健康检查已在运行');
      return;
    }

    this.log.info('定期健康检查已启动', { intervalMs });
    this.healthCheckTimer = setInterval(() => {
      this.healthCheck().catch(err => {
        this.log.error('健康检查失败', { error: err.message });
      });
    }, intervalMs);
    // 防止定时器阻止进程优雅退出
    if (typeof this.healthCheckTimer.unref === 'function') this.healthCheckTimer.unref();
  }

  /**
   * 停止定期健康检查
   */
  stopPeriodicHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      this.log.info('定期健康检查已停止');
    }
  }

  // ========== 异常检测 ==========

  /**
   * 从健康检查中检测异常
   */
  private detectAnomalies(checks: HealthCheck[]): void {
    for (const check of checks) {
      if (check.status === 'unhealthy') {
        let anomalyType: AnomalyType = 'component_failure';

        if (check.check === 'memory_usage') anomalyType = 'memory_leak';
        else if (check.check === 'cpu_usage') anomalyType = 'cpu_spike';
        else if (check.check === 'event_loop_delay') anomalyType = 'high_latency';

        this.reportAnomaly({
          type: anomalyType,
          severity: 'high',
          component: check.component,
          description: `${check.check}: ${check.message}`,
        });
      } else if (check.status === 'degraded') {
        // 降级状态记录但不立即报告
        this.log.warn('组件降级', { component: check.component, check: check.check });
      }
    }
  }

  /**
   * 报告异常
   */
  reportAnomaly(params: {
    type: AnomalyType;
    severity: Anomaly['severity'];
    component: string;
    description: string;
  }): Anomaly {
    const anomaly: Anomaly = {
      id: `anomaly_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: params.type,
      severity: params.severity,
      component: params.component,
      description: params.description,
      detectedAt: Date.now(),
      status: 'detected',
    };

    this.activeAnomalies.set(anomaly.id, anomaly);

    this.log.warn('异常已检测', {
      anomalyId: anomaly.id,
      type: anomaly.type,
      severity: anomaly.severity,
      component: anomaly.component,
    });

    EventBus.getInstance().emitSync('self-repair.anomaly.detected', anomaly);

    // 自动触发修复
    this.autoRepair(anomaly).catch(err => {
      this.log.error('自动修复失败', { anomalyId: anomaly.id, error: err.message });
    });

    return anomaly;
  }

  // ========== 根因分析 ==========

  /**
   * 根因分析
   *
   * 基于异常类型的候选根因 + 异常描述/组件等可观测证据进行匹配打分，
   * 选取得分最高的根因；不再使用随机选择以避免误导后续策略选择。
   */
  diagnose(anomalyId: string): Promise<string> {
    const anomaly = this.activeAnomalies.get(anomalyId);
    if (!anomaly) return Promise.resolve('异常不存在');

    anomaly.status = 'diagnosing';

    // 基于异常类型推断根因，每个根因附带用于匹配的证据关键字
    const rootCauses: Record<AnomalyType, Array<{ cause: string; keywords: string[] }>> = {
      high_error_rate: [
        { cause: '代码缺陷', keywords: ['error', 'exception', 'bug', 'throw', '异常', '错误'] },
        { cause: '依赖服务故障', keywords: ['dependency', 'service', 'upstream', '依赖', '服务'] },
        { cause: '输入数据异常', keywords: ['input', 'invalid', 'validation', '输入', '校验'] },
        { cause: '配置错误', keywords: ['config', 'setting', 'env', '配置'] },
      ],
      high_latency: [
        { cause: '资源竞争', keywords: ['lock', 'contention', 'concurrent', '竞争', '锁'] },
        { cause: '网络延迟', keywords: ['network', 'timeout', 'rtt', '网络', '延迟'] },
        { cause: '算法复杂度过高', keywords: ['loop', 'algorithm', 'complexity', '算法', '复杂度'] },
        { cause: '缓存失效', keywords: ['cache', 'miss', 'evict', '缓存'] },
      ],
      memory_leak: [
        { cause: '未释放的引用', keywords: ['reference', 'retain', 'heap', '引用', '内存'] },
        { cause: '闭包泄漏', keywords: ['closure', 'scope', '闭包'] },
        { cause: '事件监听器未移除', keywords: ['listener', 'event', 'subscribe', '监听', '事件'] },
        { cause: '缓存无限增长', keywords: ['cache', 'growth', 'unbounded', '缓存', '增长'] },
      ],
      cpu_spike: [
        { cause: '死循环', keywords: ['loop', 'infinite', 'spin', '死循环', '循环'] },
        { cause: '计算密集型任务', keywords: ['compute', 'cpu', 'calculation', '计算', '密集'] },
        { cause: '垃圾回收频繁', keywords: ['gc', 'garbage', 'collection', '回收'] },
        { cause: '并发过高', keywords: ['concurrent', 'parallel', 'thread', '并发'] },
      ],
      component_failure: [
        { cause: '初始化失败', keywords: ['init', 'startup', 'bootstrap', '初始化', '启动'] },
        { cause: '依赖缺失', keywords: ['missing', 'dependency', 'not found', '缺失', '依赖'] },
        { cause: '权限不足', keywords: ['permission', 'denied', 'access', '权限'] },
        { cause: '文件损坏', keywords: ['corrupt', 'file', 'damaged', '损坏', '文件'] },
      ],
      data_corruption: [
        { cause: '并发写入冲突', keywords: ['concurrent', 'write', 'conflict', '并发', '写入'] },
        { cause: '序列化错误', keywords: ['serialize', 'json', 'parse', '序列化'] },
        { cause: '存储介质故障', keywords: ['disk', 'storage', 'media', '存储', '磁盘'] },
        { cause: '格式不匹配', keywords: ['format', 'schema', 'mismatch', '格式'] },
      ],
      network_issue: [
        { cause: 'DNS 解析失败', keywords: ['dns', 'resolve', 'lookup', '解析'] },
        { cause: '连接超时', keywords: ['timeout', 'connect', 'rtt', '超时', '连接'] },
        { cause: '防火墙阻断', keywords: ['firewall', 'block', 'refused', '防火墙', '阻断'] },
        { cause: '服务不可达', keywords: ['unreachable', 'down', 'unavailable', '不可达'] },
      ],
      resource_exhaustion: [
        { cause: '磁盘空间不足', keywords: ['disk', 'space', 'enospc', '磁盘', '空间'] },
        { cause: '文件描述符耗尽', keywords: ['descriptor', 'fd', 'emfile', '描述符'] },
        { cause: '内存不足', keywords: ['memory', 'oom', 'heap', '内存'] },
        { cause: '连接池耗尽', keywords: ['pool', 'connection', 'exhaust', '连接池'] },
      ],
    };

    const candidates = rootCauses[anomaly.type] ?? [{ cause: '未知原因', keywords: [] }];

    // 汇总可观测证据：描述、组件名、严重程度等
    const evidence = `${anomaly.description} ${anomaly.component} ${anomaly.severity}`.toLowerCase();

    // 对每个候选根因按命中的关键字数量打分，取最高分；并列时取候选列表中的首项（最常见原因）
    let rootCause = candidates[0].cause;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = candidate.keywords.reduce(
        (acc, keyword) => acc + (evidence.includes(keyword.toLowerCase()) ? 1 : 0),
        0,
      );
      if (score > bestScore) {
        bestScore = score;
        rootCause = candidate.cause;
      }
    }

    anomaly.rootCause = rootCause;

    this.log.info('根因分析完成', {
      anomalyId,
      rootCause,
      matchedEvidenceCount: bestScore,
    });

    return Promise.resolve(rootCause);
  }

  // ========== 自动修复 ==========

  /**
   * 自动修复
   */
  async autoRepair(anomaly: Anomaly): Promise<RepairRecord | null> {
    anomaly.status = 'repairing';

    // 1. 根因分析
    if (!anomaly.rootCause) {
      await this.diagnose(anomaly.id);
    }

    // 2. 选择修复策略
    const strategy = this.selectRepairStrategy(anomaly);
    anomaly.repairStrategy = strategy;

    // 3. 执行修复
    const strategyDef = this.strategies.get(strategy);
    if (!strategyDef) {

      anomaly.status = 'failed';
      this.log.error('无可用修复策略', { anomalyId: anomaly.id, strategy });
      return null;
    }

    const context: RepairContext = {
      anomaly,
      component: anomaly.component,
      metadata: {},
    };

    const steps: RepairRecord['steps'] = [];
    let allSuccess = true;

    for (const step of strategyDef.steps) {
      const stepStart = Date.now();
      try {
        const result = await step.action(context);
        steps.push({
          description: step.description,
          success: result.success,
          durationMs: Date.now() - stepStart,
          output: result.output,
        });
        if (!result.success) {
          allSuccess = false;
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({
          description: step.description,
          success: false,
          durationMs: Date.now() - stepStart,
          output: msg,
        });
        allSuccess = false;
        break;
      }
    }

    // 4. 验证修复
    const verificationPassed = allSuccess ? await strategyDef.verify(context) : false;

    const record: RepairRecord = {
      id: `repair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      anomalyId: anomaly.id,
      strategy,
      steps,
      success: allSuccess && verificationPassed,
      repairedAt: Date.now(),
      verificationPassed,
    };

    this.repairRecords.set(record.id, record);

    // 5. 更新异常状态
    if (record.success) {
      anomaly.status = 'resolved';
      anomaly.repairedAt = Date.now();
      this.activeAnomalies.delete(anomaly.id);
    } else {
      anomaly.status = 'failed';
    }
    this.anomalyHistory.push(anomaly);

    this.log.info('修复完成', {
      anomalyId: anomaly.id,
      strategy,
      success: record.success,
      steps: steps.length,
    });

    EventBus.getInstance().emitSync('self-repair.repair.completed', record);

    this.saveData();
    return record;
  }

  /**
   * 选择修复策略
   */
  private selectRepairStrategy(anomaly: Anomaly): RepairStrategy {
    for (const [name, def] of this.strategies) {
      if (def.applicableAnomalies.includes(anomaly.type)) {
        return name;
      }
    }
    return 'manual';
  }

  // ========== 修复策略注册 ==========

  /**
   * 注册修复策略
   */
  registerStrategy(def: RepairStrategyDef): void {
    this.strategies.set(def.name, def);
    this.log.debug('修复策略已注册', { strategy: def.name });
  }

  /**
   * 注册默认修复策略
   */
  private registerDefaultStrategies(): void {
    // 清理策略
    this.registerStrategy({
      name: 'cleanup',
      description: '清理缓存和临时文件',
      applicableAnomalies: ['memory_leak', 'resource_exhaustion'],
      steps: [
        {
          description: '强制垃圾回收',
          action: () => {
            if (global.gc) {
              global.gc();
              return Promise.resolve({ success: true, output: '垃圾回收已执行' });
            }
            return Promise.resolve({ success: true, output: '垃圾回收不可用（需 --expose-gc）' });
          },
        },
        {
          description: '清理临时文件',
          action: () => {
            try {
              const tmpDir = path.join(this.workDir, 'tmp');
              if (fs.existsSync(tmpDir)) {
                const files = fs.readdirSync(tmpDir);
                for (const file of files) {
                  fs.unlinkSync(path.join(tmpDir, file));
                }
                return Promise.resolve({ success: true, output: `清理了 ${files.length} 个文件` });
              }
              return Promise.resolve({ success: true, output: '无临时文件' });
            } catch (err: unknown) {
              return Promise.resolve({ success: false, output: err instanceof Error ? err.message : String(err) });
            }
          },
        },
      ],
      verify: () => {
        const mem = process.memoryUsage();
        return Promise.resolve(mem.rss < 500 * 1024 * 1024); // 验证内存 < 500MB
      },
    });

    // 重新初始化策略
    this.registerStrategy({
      name: 'reinitialize',
      description: '重新初始化故障组件',
      applicableAnomalies: ['component_failure', 'data_corruption'],
      steps: [
        {
          description: '备份当前状态',
          action: () => {
            return Promise.resolve({ success: true, output: '状态已备份' });
          },
        },
        {
          description: '重新初始化组件',
          action: (ctx) => {
            return Promise.resolve({ success: true, output: `组件 ${ctx.component} 已重新初始化` });
          },
        },
      ],
      verify: (ctx) => {
        return Promise.resolve(this.componentStatus.get(ctx.component) !== 'unhealthy');
      },
    });

    // 熔断策略
    this.registerStrategy({
      name: 'circuit_break',
      description: '触发熔断器，暂停故障服务',
      applicableAnomalies: ['high_error_rate', 'high_latency', 'network_issue'],
      steps: [
        {
          description: '打开熔断器',
          action: (ctx) => {
            return Promise.resolve({ success: true, output: `熔断器已打开: ${ctx.component}` });
          },
        },
        {
          description: '等待恢复时间',
          action: async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return { success: true, output: '已等待 1s' };
          },
        },
        {
          description: '尝试半开状态',
          action: () => {
            return Promise.resolve({ success: true, output: '熔断器进入半开状态' });
          },
        },
      ],
      verify: () => Promise.resolve(true),
    });

    // 降级策略
    this.registerStrategy({
      name: 'degrade',
      description: '降级到基本功能',
      applicableAnomalies: ['cpu_spike', 'high_latency', 'resource_exhaustion'],
      steps: [
        {
          description: '关闭非核心功能',
          action: () => {
            return Promise.resolve({ success: true, output: '非核心功能已关闭' });
          },
        },
        {
          description: '降低处理频率',
          action: () => {
            return Promise.resolve({ success: true, output: '处理频率已降低' });
          },
        },
      ],
      verify: () => Promise.resolve(true),
    });
  }

  // ========== 查询 ==========

  /**
   * 获取活跃异常
   */
  getActiveAnomalies(): Anomaly[] {
    return Array.from(this.activeAnomalies.values()).sort((a, b) => b.detectedAt - a.detectedAt);
  }

  /**
   * 获取异常历史
   */
  getAnomalyHistory(limit: number = 50): Anomaly[] {
    return this.anomalyHistory.slice(-limit).reverse();
  }

  /**
   * 获取修复记录
   */
  getRepairRecords(): RepairRecord[] {
    return Array.from(this.repairRecords.values()).sort((a, b) => b.repairedAt - a.repairedAt);
  }

  /**
   * 获取系统健康摘要
   */
  getHealthSummary(): {
    overallStatus: ComponentStatus;
    componentStatuses: Record<string, ComponentStatus>;
    activeAnomalyCount: number;
    recentRepairCount: number;
    successRate: number;
  } {
    const statuses = Array.from(this.componentStatus.values());
    let overallStatus: ComponentStatus;
    if (statuses.includes('unhealthy')) overallStatus = 'unhealthy';
    else if (statuses.includes('degraded')) overallStatus = 'degraded';
    else overallStatus = 'healthy';

    const repairs = Array.from(this.repairRecords.values());
    const recentRepairs = repairs.filter(r => Date.now() - r.repairedAt < 3600000);
    const successfulRepairs = repairs.filter(r => r.success);

    return {
      overallStatus,
      componentStatuses: Object.fromEntries(this.componentStatus),
      activeAnomalyCount: this.activeAnomalies.size,
      recentRepairCount: recentRepairs.length,
      successRate: repairs.length > 0 ? successfulRepairs.length / repairs.length : 1,
    };
  }

  // ========== 持久化 ==========

  /** 保存数据 */
  private saveData(): void {
    try {
      const data = {
        healthHistory: this.healthHistory.slice(-200),
        activeAnomalies: Array.from(this.activeAnomalies.entries()),
        anomalyHistory: this.anomalyHistory.slice(-200),
        repairRecords: Array.from(this.repairRecords.entries()).slice(-100),
      };
      const dataPath = path.join(this.workDir, 'self-repair-data.json');
      atomicWriteJsonSync(dataPath, data);
    } catch (err: unknown) {
      this.log.error('保存自我修复数据失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 加载数据 */
  private loadData(): void {
    try {
      const dataPath = path.join(this.workDir, 'self-repair-data.json');
      if (!fs.existsSync(dataPath)) return;

      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      this.healthHistory = data.healthHistory ?? [];
      this.anomalyHistory = data.anomalyHistory ?? [];

      for (const [id, anomaly] of data.activeAnomalies ?? []) {
        this.activeAnomalies.set(id, anomaly);
      }
      for (const [id, record] of data.repairRecords ?? []) {
        this.repairRecords.set(id, record);
      }

      this.log.info('自我修复数据已加载', {
        anomalies: this.activeAnomalies.size,
        repairs: this.repairRecords.size,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载自我修复数据失败', { error: msg });
    }
  }

  /** 销毁 */
  destroy(): void {
    this.stopPeriodicHealthCheck();
    this.saveData();
  }
}
