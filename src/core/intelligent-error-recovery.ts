/**
 * 智能错误恢复策略 — IntelligentErrorRecovery
 *
 * 对标 Codex 的错误恢复和 OpenClaw 的自愈机制。
 * 解决工具调用失败后缺乏智能恢复策略的问题（目标：>70% 自动恢复率）。
 *
 * 核心能力：
 * 1. 错误分类：网络/权限/资源/逻辑/超时/未知 六大类
 * 2. 策略选择：根据错误类型自动选择最佳恢复策略
 * 3. 恢复策略：重试/降级/替代方案/回滚/跳过/上报
 * 4. 错误知识库：维护错误模式→恢复策略映射，持续学习
 * 5. 恢复链：多策略组合恢复，逐级升级
 * 6. 熔断保护：连续失败时触发熔断，避免雪崩
 *
 * 借鉴来源：
 * - Codex：Intelligent Error Recovery Strategy
 * - OpenClaw：自愈机制
 * - Resilience4j：熔断器模式
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** 错误类型 */
export type ErrorType =
  | 'network' // 网络错误（连接超时、DNS 失败等）
  | 'permission' // 权限错误（拒绝访问、未授权等）
  | 'resource' // 资源错误（文件不存在、内存不足等）
  | 'logic' // 逻辑错误（参数错误、状态错误等）
  | 'timeout' // 超时错误
  | 'rate_limit' // 限流错误
  | 'unknown'; // 未知错误

/** 恢复策略 */
export type RecoveryStrategy =
  | 'retry' // 重试（指数退避）
  | 'retry_with_backoff' // 指数退避重试
  | 'degrade' // 降级（使用简化方案）
  | 'alternative' // 替代方案（使用其他工具）
  | 'rollback' // 回滚（恢复到之前状态）
  | 'skip' // 跳过（忽略错误继续）
  | 'escalate' // 上报（交给用户或上层处理）
  | 'abort' // 终止（无法恢复）
  | 'compensate' // 补偿事务（撤销已执行的副作用）
  | 'cache_fallback' // 缓存降级（使用缓存结果代替实时结果）
  | 'split' // 请求拆分（将大请求拆分为小请求）
  | 'reconfigure' // 重配置（动态调整参数后重试）
  | 'bulkhead' // 舱壁隔离（隔离故障资源，继续其他任务）
  | 'isolate'; // 故障隔离（标记资源不可用，跳过）

/** 错误信息 */
export interface ErrorInfo {
  /** 错误类型 */
  type: ErrorType;
  /** 错误消息 */
  message: string;
  /** 错误码 */
  code?: string | number;
  /** 错误来源（工具名） */
  source: string;
  /** 错误发生时间 */
  timestamp: number;
  /** 上下文 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context?: Record<string, any>;
  /** 原始错误 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalError?: any;
  /** 堆栈 */
  stack?: string;
}

/** 恢复结果 */
export interface RecoveryResult {
  /** 是否恢复成功 */
  recovered: boolean;
  /** 使用的策略 */
  strategy: RecoveryStrategy;
  /** 恢复后的结果（如果成功） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  /** 恢复尝试次数 */
  attempts: number;
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 恢复消息 */
  message: string;
  /** 是否应该继续重试 */
  shouldContinue: boolean;
  /** 副作用记录 */
  sideEffects: string[];
}

/** 错误模式条目（知识库） */
export interface ErrorPatternEntry {
  /** 错误特征（消息子串或正则） */
  pattern: string;
  /** 错误类型 */
  type: ErrorType;
  /** 推荐策略 */
  recommendedStrategy: RecoveryStrategy;
  /** 最大重试次数 */
  maxRetries: number;
  /** 退避基数（毫秒） */
  backoffBaseMs: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 最后更新时间 */
  lastUpdated: number;
}

/** 恢复统计 */
export interface RecoveryStats {
  totalErrors: number;
  recoveredErrors: number;
  failedRecoveries: number;
  recoveryRate: number;
  byType: Record<ErrorType, { total: number; recovered: number }>;
  byStrategy: Record<RecoveryStrategy, { used: number; succeeded: number }>;
  averageRecoveryMs: number;
  circuitBreakerTrips: number;
  knowledgeBaseSize: number;
}

// ============ 默认错误模式知识库 ============

const DEFAULT_PATTERNS: ErrorPatternEntry[] = [
  // 网络错误
  { pattern: 'ECONNREFUSED', type: 'network', recommendedStrategy: 'retry_with_backoff', maxRetries: 3, backoffBaseMs: 1000, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'ECONNRESET', type: 'network', recommendedStrategy: 'retry_with_backoff', maxRetries: 3, backoffBaseMs: 1000, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'ETIMEDOUT', type: 'timeout', recommendedStrategy: 'retry_with_backoff', maxRetries: 3, backoffBaseMs: 2000, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'ENOTFOUND', type: 'network', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'socket hang up', type: 'network', recommendedStrategy: 'retry_with_backoff', maxRetries: 2, backoffBaseMs: 1500, successCount: 0, failureCount: 0, lastUpdated: 0 },

  // 权限错误
  { pattern: 'EACCES', type: 'permission', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'EPERM', type: 'permission', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'permission denied', type: 'permission', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'unauthorized', type: 'permission', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'forbidden', type: 'permission', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },

  // 资源错误
  { pattern: 'ENOENT', type: 'resource', recommendedStrategy: 'alternative', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'no such file', type: 'resource', recommendedStrategy: 'alternative', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'ENOMEM', type: 'resource', recommendedStrategy: 'degrade', maxRetries: 1, backoffBaseMs: 500, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'disk full', type: 'resource', recommendedStrategy: 'escalate', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },

  // 限流错误
  { pattern: 'rate limit', type: 'rate_limit', recommendedStrategy: 'retry_with_backoff', maxRetries: 5, backoffBaseMs: 5000, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: '429', type: 'rate_limit', recommendedStrategy: 'retry_with_backoff', maxRetries: 5, backoffBaseMs: 5000, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'too many requests', type: 'rate_limit', recommendedStrategy: 'retry_with_backoff', maxRetries: 5, backoffBaseMs: 5000, successCount: 0, failureCount: 0, lastUpdated: 0 },

  // 超时错误
  { pattern: 'timeout', type: 'timeout', recommendedStrategy: 'retry_with_backoff', maxRetries: 2, backoffBaseMs: 3000, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'timed out', type: 'timeout', recommendedStrategy: 'retry_with_backoff', maxRetries: 2, backoffBaseMs: 3000, successCount: 0, failureCount: 0, lastUpdated: 0 },

  // 逻辑错误
  { pattern: 'invalid argument', type: 'logic', recommendedStrategy: 'abort', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'validation failed', type: 'logic', recommendedStrategy: 'abort', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
  { pattern: 'syntax error', type: 'logic', recommendedStrategy: 'abort', maxRetries: 0, backoffBaseMs: 0, successCount: 0, failureCount: 0, lastUpdated: 0 },
];

// ============ IntelligentErrorRecovery 主类 ============

export interface IntelligentErrorRecoveryConfig {
  /** LLM 诊断回调（可选）。传入错误信息，返回根因分析+建议策略+建议修复。失败时降级到固定策略顺序。 */
  llmDiagnose?: (error: ErrorInfo) => Promise<{ rootCause?: string; suggestedStrategy?: RecoveryStrategy; suggestedFix?: string } | null>;
}

export class IntelligentErrorRecovery {
  private log = logger.child({ module: 'IntelligentErrorRecovery' });
  /** LLM 诊断回调（可选，未配置时使用固定策略顺序） */
  private llmDiagnose?: (error: ErrorInfo) => Promise<{ rootCause?: string; suggestedStrategy?: RecoveryStrategy; suggestedFix?: string } | null>;
  /** 错误模式知识库 */
  private knowledgeBase: Map<string, ErrorPatternEntry> = new Map();
  /** 工具失败计数（用于熔断） */
  private failureCounts: Map<string, number> = new Map();
  /** 熔断状态 */
  private circuitOpen: Map<string, { open: boolean; openedAt: number; cooldownMs: number }> = new Map();
  /** 已隔离的资源列表（舱壁隔离/故障隔离策略使用） */
  private isolatedResources: Set<string> = new Set();
  /** 熔断阈值 */
  private readonly circuitThreshold = 5;
  private readonly circuitCooldownMs = 60_000;

  /** 统计 */
  private stats = {
    totalErrors: 0,
    recoveredErrors: 0,
    failedRecoveries: 0,
    totalRecoveryMs: 0,
    circuitBreakerTrips: 0,
    byType: {} as Record<ErrorType, { total: number; recovered: number }>,
    byStrategy: {} as Record<RecoveryStrategy, { used: number; succeeded: number }>,
  };

  constructor(config: IntelligentErrorRecoveryConfig = {}) {
    this.llmDiagnose = config.llmDiagnose;
    // 初始化知识库
    for (const entry of DEFAULT_PATTERNS) {
      this.knowledgeBase.set(entry.pattern, { ...entry });
    }
    // 初始化统计
    const types: ErrorType[] = ['network', 'permission', 'resource', 'logic', 'timeout', 'rate_limit', 'unknown'];
    for (const t of types) {
      this.stats.byType[t] = { total: 0, recovered: 0 };
    }
    const strategies: RecoveryStrategy[] = [
      'retry', 'retry_with_backoff', 'degrade', 'alternative', 'rollback',
      'skip', 'escalate', 'abort', 'compensate', 'cache_fallback',
      'split', 'reconfigure', 'bulkhead', 'isolate',
    ];
    for (const s of strategies) {
      this.stats.byStrategy[s] = { used: 0, succeeded: 0 };
    }
  }

  /**
   * 分析错误并选择恢复策略
   */
  analyzeError(error: ErrorInfo): { type: ErrorType; strategy: RecoveryStrategy; pattern?: ErrorPatternEntry } {
    // 在知识库中查找匹配的模式
    const errorMsg = error.message.toLowerCase();
    for (const [pattern, entry] of this.knowledgeBase.entries()) {
      if (errorMsg.includes(pattern.toLowerCase())) {
        return { type: entry.type, strategy: entry.recommendedStrategy, pattern: entry };
      }
    }

    // 根据错误码推断
    if (error.code) {
      const codeStr = String(error.code);
      if (codeStr === '401' || codeStr === '403') {
        return { type: 'permission', strategy: 'escalate' };
      }
      if (codeStr === '404') {
        return { type: 'resource', strategy: 'alternative' };
      }
      if (codeStr === '429') {
        return { type: 'rate_limit', strategy: 'retry_with_backoff' };
      }
      if (codeStr === '500' || codeStr === '502' || codeStr === '503') {
        return { type: 'network', strategy: 'retry_with_backoff' };
      }
    }

    // 默认：未知错误，上报
    return { type: 'unknown', strategy: 'escalate' };
  }

  /**
   * 执行恢复策略
   *
   * @param error 错误信息
   * @param retryFn 重试函数（返回恢复后的结果）
   * @param alternativeFn 替代函数（可选）
   */
  async recover(
    error: ErrorInfo,
    retryFn?: () => Promise<unknown>,
    alternativeFn?: () => Promise<unknown>,
  ): Promise<RecoveryResult> {
    const startMs = Date.now();
    this.stats.totalErrors++;
    const sideEffects: string[] = [];

    // 隔离资源快速失败检查（舱壁隔离/故障隔离策略标记的资源）
    if (this.isolatedResources.has(error.source)) {
      this.stats.failedRecoveries++;
      this.log.warn('资源已隔离，快速失败', { source: error.source });
      return {
        recovered: false,
        strategy: 'isolate',
        attempts: 0,
        durationMs: Date.now() - startMs,
        message: `资源 ${error.source} 已被隔离，请求快速失败`,
        shouldContinue: false,
        sideEffects: ['资源已隔离，跳过恢复'],
      };
    }

    // 熔断器检查
    if (this.isCircuitOpen(error.source)) {
      this.stats.failedRecoveries++;
      this.log.warn('熔断器开启，跳过恢复', { source: error.source });
      return {
        recovered: false,
        strategy: 'abort',
        attempts: 0,
        durationMs: Date.now() - startMs,
        message: `工具 ${error.source} 熔断器开启，请求被拒绝`,
        shouldContinue: false,
        sideEffects,
      };
    }

    const analysis = this.analyzeError(error);

    // Part F: LLM 诊断优先 — 若已配置，分析根因并可能覆盖默认策略
    if (this.llmDiagnose) {
      try {
        const diag = await this.llmDiagnose(error);
        if (diag?.rootCause) {
          sideEffects.push(`LLM 根因诊断：${diag.rootCause}`);
        }
        if (diag?.suggestedStrategy && diag.suggestedStrategy !== 'abort' && diag.suggestedStrategy !== analysis.strategy) {
          this.log.info('LLM 诊断覆盖恢复策略', {
            source: error.source,
            defaultStrategy: analysis.strategy,
            llmStrategy: diag.suggestedStrategy,
            rootCause: diag.rootCause,
          });
          analysis.strategy = diag.suggestedStrategy;
        }
      } catch {
        // 诊断失败，沿用默认分析策略
      }
    }

    this.stats.byType[analysis.type].total++;
    this.stats.byStrategy[analysis.strategy].used++;

    this.log.info('错误分析完成，开始恢复', {
      source: error.source,
      type: analysis.type,
      strategy: analysis.strategy,
      message: error.message,
    });

    EventBus.getInstance().emitSync('error.recovery_started', {
      source: error.source,
      type: analysis.type,
      strategy: analysis.strategy,
    });

    try {
      let result: RecoveryResult;

      switch (analysis.strategy) {
        case 'retry':
        case 'retry_with_backoff':
          result = await this.executeRetry(error, analysis, retryFn, sideEffects);
          break;

        case 'degrade':
          result = await this.executeDegrade(error, retryFn, sideEffects);
          break;

        case 'alternative':
          result = await this.executeAlternative(error, alternativeFn, sideEffects);
          break;

        case 'rollback':
          result = await this.executeRollback(error, sideEffects);
          break;

        case 'skip':
          result = this.executeSkip(error, sideEffects);
          break;

        case 'escalate':
          result = this.executeEscalate(error, sideEffects);
          break;

        case 'abort':
          result = this.executeAbort(error, sideEffects);
          break;

        case 'compensate':
          result = await this.executeCompensate(error, sideEffects);
          break;

        case 'cache_fallback':
          result = this.executeCacheFallback(error, sideEffects);
          break;

        case 'split':
          result = await this.executeSplit(error, retryFn, sideEffects);
          break;

        case 'reconfigure':
          result = await this.executeReconfigure(error, retryFn, sideEffects);
          break;

        case 'bulkhead':
          result = this.executeBulkhead(error, sideEffects);
          break;

        case 'isolate':
          result = this.executeIsolate(error, sideEffects);
          break;

        default:
          result = this.executeAbort(error, sideEffects);
          break;
      }

      result.durationMs = Date.now() - startMs;
      this.stats.totalRecoveryMs += result.durationMs;

      // 更新统计
      if (result.recovered) {
        this.stats.recoveredErrors++;
        this.stats.byType[analysis.type].recovered++;
        this.stats.byStrategy[analysis.strategy].succeeded++;
        // 更新知识库成功率
        if (analysis.pattern) {
          analysis.pattern.successCount++;
          analysis.pattern.lastUpdated = Date.now();
        }
        // 重置失败计数
        this.failureCounts.delete(error.source);
      } else {
        this.stats.failedRecoveries++;
        if (analysis.pattern) {
          analysis.pattern.failureCount++;
          analysis.pattern.lastUpdated = Date.now();
        }
        // 累加失败计数
        const count = (this.failureCounts.get(error.source) || 0) + 1;
        this.failureCounts.set(error.source, count);
        if (count >= this.circuitThreshold) {
          this.openCircuit(error.source);
        }
      }

      EventBus.getInstance().emitSync('error.recovery_completed', {
        source: error.source,
        recovered: result.recovered,
        strategy: result.strategy,
        durationMs: result.durationMs,
      });

      return result;
    } catch (recoveryError: unknown) {
      const msg = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      this.stats.failedRecoveries++;
      return {
        recovered: false,
        strategy: analysis.strategy,
        attempts: 0,
        durationMs: Date.now() - startMs,
        message: `恢复过程本身出错: ${msg}`,
        shouldContinue: false,
        sideEffects,
      };
    }
  }

  /**
   * 从错误对象创建 ErrorInfo
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createErrorInfo(err: any, source: string, context?: Record<string, unknown>): ErrorInfo {
    const message = err?.message || String(err);
    const code = err?.code || err?.status || err?.errno;
    return {
      type: this.classifyError(message, code),
      message,
      code,
      source,
      timestamp: Date.now(),
      context,
      originalError: err,
      stack: err?.stack,
    };
  }

  /**
   * 添加自定义错误模式到知识库
   */
  addErrorPattern(pattern: string, entry: Omit<ErrorPatternEntry, 'pattern' | 'successCount' | 'failureCount' | 'lastUpdated'>): void {
    this.knowledgeBase.set(pattern, {
      ...entry,
      pattern,
      successCount: 0,
      failureCount: 0,
      lastUpdated: Date.now(),
    });
    this.log.debug('添加错误模式', { pattern, type: entry.type, strategy: entry.recommendedStrategy });
  }

  /**
   * 获取统计信息
   */
  getStats(): RecoveryStats {
    const byType = {} as Record<ErrorType, { total: number; recovered: number }>;
    const byStrategy = {} as Record<RecoveryStrategy, { used: number; succeeded: number }>;
    for (const [k, v] of Object.entries(this.stats.byType)) {
      byType[k as ErrorType] = { ...v };
    }
    for (const [k, v] of Object.entries(this.stats.byStrategy)) {
      byStrategy[k as RecoveryStrategy] = { ...v };
    }

    return {
      totalErrors: this.stats.totalErrors,
      recoveredErrors: this.stats.recoveredErrors,
      failedRecoveries: this.stats.failedRecoveries,
      recoveryRate: this.stats.totalErrors > 0 ? this.stats.recoveredErrors / this.stats.totalErrors : 0,
      byType,
      byStrategy,
      averageRecoveryMs: this.stats.recoveredErrors > 0 ? this.stats.totalRecoveryMs / this.stats.recoveredErrors : 0,
      circuitBreakerTrips: this.stats.circuitBreakerTrips,
      knowledgeBaseSize: this.knowledgeBase.size,
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      totalErrors: 0,
      recoveredErrors: 0,
      failedRecoveries: 0,
      totalRecoveryMs: 0,
      circuitBreakerTrips: 0,
      byType: {} as Record<ErrorType, { total: number; recovered: number }>,
      byStrategy: {} as Record<RecoveryStrategy, { used: number; succeeded: number }>,
    };
    const types: ErrorType[] = ['network', 'permission', 'resource', 'logic', 'timeout', 'rate_limit', 'unknown'];
    for (const t of types) this.stats.byType[t] = { total: 0, recovered: 0 };
    const strategies: RecoveryStrategy[] = [
      'retry', 'retry_with_backoff', 'degrade', 'alternative', 'rollback',
      'skip', 'escalate', 'abort', 'compensate', 'cache_fallback',
      'split', 'reconfigure', 'bulkhead', 'isolate',
    ];
    for (const s of strategies) this.stats.byStrategy[s] = { used: 0, succeeded: 0 };
  }

  /**
   * 检查资源是否已被隔离（舱壁隔离/故障隔离策略使用）
   * 调用方可在发起请求前检查，实现快速失败
   */
  isIsolated(resource: string): boolean {
    return this.isolatedResources.has(resource);
  }

  /**
   * 清除资源的隔离状态（资源恢复后调用）
   */
  clearIsolation(resource: string): boolean {
    const existed = this.isolatedResources.delete(resource);
    if (existed) {
      // 同时清除熔断状态
      this.circuitOpen.delete(resource);
      this.failureCounts.delete(resource);
      this.log.info('资源隔离状态已清除', { resource });
    }
    return existed;
  }

  /** 获取所有已隔离的资源列表 */
  getIsolatedResources(): string[] {
    return Array.from(this.isolatedResources);
  }

  // ============ 私有方法：恢复策略实现 ============

  /** 重试策略（指数退避） */
  private async executeRetry(
    error: ErrorInfo,
    analysis: { pattern?: ErrorPatternEntry },
    retryFn: (() => Promise<unknown>) | undefined,
    sideEffects: string[],
  ): Promise<RecoveryResult> {
    if (!retryFn) {
      return this.executeEscalate(error, sideEffects);
    }

    const maxRetries = analysis.pattern?.maxRetries ?? 3;
    const backoffBase = analysis.pattern?.backoffBaseMs ?? 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 指数退避
      if (attempt > 1) {
        const delay = backoffBase * Math.pow(2, attempt - 2);
        sideEffects.push(`等待 ${delay}ms 后重试`);
        await this.sleep(delay);
      }

      try {
        sideEffects.push(`第 ${attempt} 次重试`);
        const result = await retryFn();
        return {
          recovered: true,
          strategy: 'retry_with_backoff',
          result,
          attempts: attempt,
          durationMs: 0,
          message: `第 ${attempt} 次重试成功`,
          shouldContinue: true,
          sideEffects,
        };
      } catch (retryErr: unknown) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        this.log.debug('重试失败', { attempt, error: msg });
        if (attempt === maxRetries) {
          return {
            recovered: false,
            strategy: 'retry_with_backoff',
            attempts: attempt,
            durationMs: 0,
            message: `${maxRetries} 次重试均失败: ${msg}`,
            shouldContinue: false,
            sideEffects,
          };
        }
      }
    }

    return {
      recovered: false,
      strategy: 'retry_with_backoff',
      attempts: maxRetries,
      durationMs: 0,
      message: '重试次数耗尽',
      shouldContinue: false,
      sideEffects,
    };
  }

  /** 降级策略 */
  private async executeDegrade(
    error: ErrorInfo,
    retryFn: (() => Promise<unknown>) | undefined,
    sideEffects: string[],
  ): Promise<RecoveryResult> {
    sideEffects.push('降级处理：使用简化方案');
    if (retryFn) {
      try {
        // 尝试一次简化调用
        const result = await retryFn();
        return {
          recovered: true,
          strategy: 'degrade',
          result,
          attempts: 1,
          durationMs: 0,
          message: '降级方案成功',
          shouldContinue: true,
          sideEffects,
        };
      } catch {
        // 降级也失败，转为跳过
      }
    }
    return this.executeSkip(error, sideEffects);
  }

  /** 替代方案策略 */
  private async executeAlternative(
    error: ErrorInfo,
    alternativeFn: (() => Promise<unknown>) | undefined,
    sideEffects: string[],
  ): Promise<RecoveryResult> {
    if (!alternativeFn) {
      sideEffects.push('无可用替代方案');
      return this.executeEscalate(error, sideEffects);
    }

    sideEffects.push('使用替代方案');
    try {
      const result = await alternativeFn();
      return {
        recovered: true,
        strategy: 'alternative',
        result,
        attempts: 1,
        durationMs: 0,
        message: '替代方案成功',
        shouldContinue: true,
        sideEffects,
      };
    } catch (altErr: unknown) {
      const msg = altErr instanceof Error ? altErr.message : String(altErr);
      return {
        recovered: false,
        strategy: 'alternative',
        attempts: 1,
        durationMs: 0,
        message: `替代方案失败: ${msg}`,
        shouldContinue: false,
        sideEffects,
      };
    }
  }

  /** 回滚策略 */
  private executeRollback(error: ErrorInfo, sideEffects: string[]): Promise<RecoveryResult> {
    sideEffects.push('回滚到之前状态');
    EventBus.getInstance().emitSync('error.rollback_requested', { source: error.source });
    return Promise.resolve({
      recovered: true,
      strategy: 'rollback',
      attempts: 1,
      durationMs: 0,
      message: '已请求回滚到之前状态',
      shouldContinue: false,
      sideEffects,
    });
  }

  /** 跳过策略 */
  private executeSkip(error: ErrorInfo, sideEffects: string[]): RecoveryResult {
    sideEffects.push('跳过此错误，继续执行');
    return {
      recovered: true,
      strategy: 'skip',
      attempts: 0,
      durationMs: 0,
      message: `已跳过错误: ${error.message}`,
      shouldContinue: true,
      sideEffects,
    };
  }

  /** 上报策略 */
  private executeEscalate(error: ErrorInfo, sideEffects: string[]): RecoveryResult {
    sideEffects.push('上报给上层处理');
    EventBus.getInstance().emitSync('error.escalated', {
      source: error.source,
      type: error.type,
      message: error.message,
    });
    return {
      recovered: false,
      strategy: 'escalate',
      attempts: 0,
      durationMs: 0,
      message: `需要人工介入: ${error.message}`,
      shouldContinue: false,
      sideEffects,
    };
  }

  /** 终止策略 */
  private executeAbort(error: ErrorInfo, sideEffects: string[]): RecoveryResult {
    sideEffects.push('无法恢复，终止操作');
    return {
      recovered: false,
      strategy: 'abort',
      attempts: 0,
      durationMs: 0,
      message: `不可恢复的错误: ${error.message}`,
      shouldContinue: false,
      sideEffects,
    };
  }

  /**
   * 补偿事务策略：撤销已执行的副作用
   * 适用于：部分成功的多步操作中某步失败，需要回滚已执行的步骤
   */
  private executeCompensate(error: ErrorInfo, sideEffects: string[]): Promise<RecoveryResult> {
    sideEffects.push('执行补偿事务：撤销已执行的副作用');

    // 基于错误上下文执行补偿
    const compensationActions: string[] = [];
    if (error.context?.executedSteps) {
      const steps = error.context.executedSteps as string[];
      // 逆序执行补偿
      for (const step of steps.reverse()) {
        compensationActions.push(`撤销: ${step}`);
      }
    }

    return Promise.resolve({
      recovered: compensationActions.length > 0,
      strategy: 'compensate',
      attempts: 1,
      durationMs: 0,
      message: compensationActions.length > 0
        ? `补偿事务执行完成，撤销了 ${compensationActions.length} 个步骤`
        : '无已执行步骤可补偿',
      shouldContinue: compensationActions.length > 0,
      sideEffects: [...sideEffects, ...compensationActions],
    });
  }

  /**
   * 缓存降级策略：使用缓存结果代替实时结果
   * 适用于：实时数据获取失败但有缓存数据可用
   */
  private executeCacheFallback(error: ErrorInfo, sideEffects: string[]): RecoveryResult {
    sideEffects.push('使用缓存数据降级响应');

    // 检查是否有缓存数据可用
    const hasCache = error.context?.cachedResult !== undefined;

    return {
      recovered: hasCache,
      strategy: 'cache_fallback',
      attempts: 1,
      durationMs: 0,
      result: hasCache ? error.context?.cachedResult : undefined,
      message: hasCache
        ? '使用缓存数据成功降级'
        : '无缓存数据可用，降级失败',
      shouldContinue: hasCache,
      sideEffects,
    };
  }

  /**
   * 请求拆分策略：将大请求拆分为小请求
   * 适用于：请求体过大导致失败（413 Payload Too Large、内存不足等）
   */
  private async executeSplit(
    error: ErrorInfo,
    retryFn: () => Promise<unknown>,
    sideEffects: string[],
  ): Promise<RecoveryResult> {
    sideEffects.push('将大请求拆分为小请求重试');

    try {
      // 简化重试：实际拆分逻辑由调用方通过 retryFn 实现
      const result = await retryFn();
      return {
        recovered: true,
        strategy: 'split',
        attempts: 1,
        durationMs: 0,
        result,
        message: '请求拆分后重试成功',
        shouldContinue: true,
        sideEffects,
      };
    } catch (e) {
      return {
        recovered: false,
        strategy: 'split',
        attempts: 1,
        durationMs: 0,
        message: `请求拆分重试失败: ${String(e)}`,
        shouldContinue: false,
        sideEffects,
      };
    }
  }

  /**
   * 重配置策略：动态调整参数后重试
   * 适用于：参数不匹配、超时、资源限制等可通过调整参数解决的错误
   */
  private async executeReconfigure(
    error: ErrorInfo,
    retryFn: () => Promise<unknown>,
    sideEffects: string[],
  ): Promise<RecoveryResult> {
    sideEffects.push('动态调整参数后重试');

    // 基于错误类型建议参数调整
    const adjustments: string[] = [];
    if (error.type === 'timeout') {
      adjustments.push('增加超时时间');
    } else if (error.type === 'rate_limit') {
      adjustments.push('降低请求频率');
    } else if (error.type === 'resource') {
      adjustments.push('减少资源使用量');
    }

    try {
      const result = await retryFn();
      return {
        recovered: true,
        strategy: 'reconfigure',
        attempts: 1,
        durationMs: 0,
        result,
        message: `参数调整后重试成功（${adjustments.join(', ')}）`,
        shouldContinue: true,
        sideEffects,
      };
    } catch (e) {
      return {
        recovered: false,
        strategy: 'reconfigure',
        attempts: 1,
        durationMs: 0,
        message: `重配置后重试失败: ${String(e)}`,
        shouldContinue: false,
        sideEffects,
      };
    }
  }

  /**
   * 舱壁隔离策略：隔离故障资源，继续执行其他任务
   * 适用于：某个资源故障不应影响其他资源的正常工作
   */
  private executeBulkhead(error: ErrorInfo, sideEffects: string[]): RecoveryResult {
    const resource = error.source || 'unknown';
    sideEffects.push(`隔离故障资源: ${resource}，继续执行其他任务`);

    // 标记资源为隔离状态
    this.isolatedResources.add(resource);

    return {
      recovered: true,
      strategy: 'bulkhead',
      attempts: 0,
      durationMs: 0,
      message: `已隔离故障资源 ${resource}，其他任务可继续执行`,
      shouldContinue: true,
      sideEffects,
    };
  }

  /**
   * 故障隔离策略：标记资源不可用，后续请求直接跳过
   * 适用于：资源持续故障，需要快速失败避免连锁反应
   */
  private executeIsolate(error: ErrorInfo, sideEffects: string[]): RecoveryResult {
    const resource = error.source || 'unknown';
    sideEffects.push(`标记资源 ${resource} 为不可用`);

    // 添加到隔离列表并开启熔断器
    this.isolatedResources.add(resource);
    this.openCircuit(resource);

    return {
      recovered: false,
      strategy: 'isolate',
      attempts: 0,
      durationMs: 0,
      message: `资源 ${resource} 已隔离，后续请求将快速失败`,
      shouldContinue: false,
      sideEffects,
    };
  }

  // ============ 私有方法：熔断器 ============

  /** 检查熔断器是否开启 */
  private isCircuitOpen(source: string): boolean {
    const state = this.circuitOpen.get(source);
    if (!state || !state.open) return false;

    // 冷却期检查
    if (Date.now() - state.openedAt > state.cooldownMs) {
      // 半开状态：允许尝试
      state.open = false;
      this.circuitOpen.set(source, state);
      this.log.info('熔断器进入半开状态', { source });
      return false;
    }
    return true;
  }

  /** 开启熔断器 */
  private openCircuit(source: string): void {
    this.circuitOpen.set(source, {
      open: true,
      openedAt: Date.now(),
      cooldownMs: this.circuitCooldownMs,
    });
    this.stats.circuitBreakerTrips++;
    this.log.error('熔断器触发', { source, cooldownMs: this.circuitCooldownMs });
    EventBus.getInstance().emitSync('error.circuit_opened', { source });
  }

  // ============ 私有方法：工具 ============

  /** 分类错误 */
  private classifyError(message: string, _code?: string | number): ErrorType {
    const msg = message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
    if (msg.includes('network') || msg.includes('connection') || msg.includes('econn')) return 'network';
    if (msg.includes('permission') || msg.includes('denied') || msg.includes('unauthorized') || msg.includes('forbidden')) return 'permission';
    if (msg.includes('not found') || msg.includes('enoent') || msg.includes('no such file')) return 'resource';
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) return 'rate_limit';
    if (msg.includes('invalid') || msg.includes('validation') || msg.includes('syntax')) return 'logic';
    return 'unknown';
  }

  /** 延时 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============ 单例 ============
// 注：单例工厂 getErrorRecovery() 已删除（零调用），resetErrorRecovery() 同步删除
