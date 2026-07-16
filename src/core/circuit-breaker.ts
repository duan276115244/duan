/**
 * Circuit Breaker + Retry with Exponential Backoff
 *
 * 大厂最佳实践（Google SRE / Meta / Netflix）:
 * - Circuit Breaker: 防止级联故障，快速失败
 * - Exponential Backoff: 避免重试风暴
 * - Jitter: 防止惊群效应
 * - Bulkhead: 资源隔离，防止单点故障扩散
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
  halfOpenMaxRequests: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryableErrors: Array<RegExp | string>;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  openTime: number | null;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
  avgResponseTime: number;
  /** 滑动窗口错误率 (0-1) */
  errorRate: number;
  /** p50 响应时间（毫秒） */
  p50ResponseTime: number;
  /** p95 响应时间（毫秒） */
  p95ResponseTime: number;
  /** p99 响应时间（毫秒） */
  p99ResponseTime: number;
  /** 滑动窗口内调用总数 */
  windowCalls: number;
}

/** 降级策略类型 */
export type FallbackStrategy<T> =
  | { type: 'cache'; cacheValue: T }
  | { type: 'default'; defaultValue: T }
  | { type: 'function'; fn: () => T | Promise<T> };

/**
 * 滑动窗口：记录最近 N 秒内的调用结果，用于错误率计算
 * 替代简单的 failureCount 累加计数器，避免旧失败永久影响
 *
 * 性能优化：
 * - 使用 head 指针 + 惰性压缩替代 Array.shift()（O(n) → 摊还 O(1)）
 * - 维护增量 success/failure 计数器，淘汰时同步更新，避免全量 filter
 * - 分位数排序结果缓存，窗口未变化时复用，避免重复 sort
 */
class SlidingWindow {
  private timestamps: number[] = [];
  private successes: boolean[] = [];
  private responseTimes: number[] = [];
  /** 有效区间起始下标（替代 shift，避免 O(n) 移动） */
  private head = 0;
  private failureCount = 0;
  private successCount = 0;
  /** 排序缓存及其版本号，窗口变化时失效 */
  private sortedCache: number[] | null = null;
  private version = 0;
  private sortedVersion = -1;
  private readonly windowMs: number;
  private readonly minCalls: number;

  constructor(windowMs: number = 60_000, minCalls: number = 5) {
    this.windowMs = windowMs;
    this.minCalls = minCalls;
  }

  /** 当前有效条目数 */
  private get size(): number {
    return this.timestamps.length - this.head;
  }

  /** 记录一次调用结果 */
  record(success: boolean, responseTime: number): void {
    this.timestamps.push(Date.now());
    this.successes.push(success);
    this.responseTimes.push(responseTime);
    if (success) this.successCount++; else this.failureCount++;
    this.version++;
    this.evict();
  }

  /** 清除窗口外的旧记录（仅推进 head 指针 + 增量计数，必要时压缩底层数组） */
  private evict(): void {
    const cutoff = Date.now() - this.windowMs;
    let evicted = false;
    while (this.head < this.timestamps.length && this.timestamps[this.head] < cutoff) {
      if (this.successes[this.head]) this.successCount--; else this.failureCount--;
      this.head++;
      evicted = true;
    }
    if (evicted) this.version++;
    // 当被淘汰的前缀占比过半时压缩底层数组，回收内存并保持指针有界
    if (this.head > 0 && this.head * 2 >= this.timestamps.length) {
      this.timestamps = this.timestamps.slice(this.head);
      this.successes = this.successes.slice(this.head);
      this.responseTimes = this.responseTimes.slice(this.head);
      this.head = 0;
    }
  }

  /** 计算错误率 (0-1)，调用数不足 minCalls 时返回 0 */
  getErrorRate(): number {
    this.evict();
    if (this.size < this.minCalls) return 0;
    return this.failureCount / this.size;
  }

  /** 窗口内调用总数 */
  getCount(): number {
    this.evict();
    return this.size;
  }

  /** 窗口内失败数 */
  getFailureCount(): number {
    this.evict();
    return this.failureCount;
  }

  /** 计算响应时间分位数 (p50/p95/p99)，排序结果按版本缓存复用 */
  getPercentile(p: number): number {
    this.evict();
    if (this.size === 0) return 0;
    if (this.sortedCache === null || this.sortedVersion !== this.version) {
      this.sortedCache = this.responseTimes
        .slice(this.head)
        .sort((a, b) => a - b);
      this.sortedVersion = this.version;
    }
    const sorted = this.sortedCache;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  }

  /** 重置窗口 */
  reset(): void {
    this.timestamps = [];
    this.successes = [];
    this.responseTimes = [];
    this.head = 0;
    this.failureCount = 0;
    this.successCount = 0;
    this.sortedCache = null;
    this.version++;
    this.sortedVersion = -1;
  }
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30000,
  halfOpenMaxRequests: 1,
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
  retryableErrors: [
    /timeout/i,
    /rate limit/i,
    /429/i,
    /5\d{2}/,
    /too many requests/i,
    /service unavailable/i,
    /internal server error/i,
    /network/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
  ],
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private openTime: number | null = null;
  private halfOpenRequests = 0;
  private responseTimes: number[] = [];
  /** 滑动窗口：用于错误率计算，替代简单计数器 */
  private slidingWindow: SlidingWindow;
  /** 错误率熔断阈值 (0-1)，窗口内错误率超过此值且调用数达标时熔断 */
  private readonly errorRateThreshold: number;

  private totalCalls = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;

  constructor(
    private name: string,
    private circuitConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    private retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    /** 滑动窗口大小（毫秒），默认 60s */
    windowMs: number = 60_000,
    /** 窗口内最少调用数才计算错误率，默认 5 */
    minCalls: number = 5,
    /** 错误率熔断阈值，默认 0.5（50%） */
    errorRateThreshold: number = 0.5,
  ) {
    this.slidingWindow = new SlidingWindow(windowMs, minCalls);
    this.errorRateThreshold = errorRateThreshold;
  }

  getState(): CircuitState { return this.state; }

  /**
   * 检查超时并尝试状态转换（open → half_open），供外部主动触发。
   *
   * CircuitBreaker 默认使用惰性转换：open→half_open 只在 call() 内由
   * shouldAttemptReset() 触发，getState() 不会主动转换。
   * 调用方在依赖 getState() 做决策前应先调用本方法，以复刻
   * "主动检查超时" 的语义（如 query-engine 原 getCircuitBreakerState）。
   */
  tryTransition(): void {
    if (this.state === 'open' && this.shouldAttemptReset()) {
      this.state = 'half_open';
      this.halfOpenRequests = 0;
    }
  }

  /**
   * 执行受熔断器保护的调用
   * @param fn 要执行的异步函数
   * @param context 调用上下文描述（用于错误信息）
   * @param fallback 降级策略：熔断打开时返回的替代结果
   */
  async call<T>(fn: () => Promise<T>, context?: string, fallback?: FallbackStrategy<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.state = 'half_open';
        this.halfOpenRequests = 0;
      } else {
        this.totalFailures++;
        // 降级策略：熔断打开时返回替代结果而非抛错
        if (fallback) {
          return this.executeFallback(fallback);
        }

        throw new CircuitBreakerOpenError(this.name, context);
      }
    }

    if (this.state === 'half_open' && this.halfOpenRequests >= this.circuitConfig.halfOpenMaxRequests) {
      this.totalFailures++;
      if (fallback) {
        return this.executeFallback(fallback);
      }
      throw new CircuitBreakerOpenError(this.name, `${context} (half-open limited)`);
    }

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
      }

      try {
        if (this.state === 'half_open') {
          this.halfOpenRequests++;
        }

        const result = await this.executeWithTimeout(fn);
        this.onSuccess(Date.now() - startTime);
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.totalCalls++;

        if (!this.isRetryable(lastError) || attempt >= this.retryConfig.maxRetries) {
          this.onFailure();
          throw lastError;
        }
      }
    }

    this.onFailure();
    throw lastError || new Error(`CircuitBreaker: ${this.name} failed after ${this.retryConfig.maxRetries} retries`);
  }

  /** 执行降级策略 */
  private async executeFallback<T>(fallback: FallbackStrategy<T>): Promise<T> {
    switch (fallback.type) {
      case 'cache':
        return fallback.cacheValue;
      case 'default':
        return fallback.defaultValue;
      case 'function':
        return await fallback.fn();
    }
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const timeout = this.circuitConfig.timeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new TimeoutError(this.name, timeout)), timeout);
    });
    try {
      return await Promise.race([fn(), timer]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private onSuccess(responseTime: number): void {
    this.totalCalls++;
    this.totalSuccesses++;
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > 100) {
      this.responseTimes.shift();
    }
    // 记录到滑动窗口
    this.slidingWindow.record(true, responseTime);

    if (this.state === 'half_open') {
      this.successCount++;
      this.failureCount = 0;
      if (this.successCount >= this.circuitConfig.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
        this.openTime = null;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.totalFailures++;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    // 记录到滑动窗口
    this.slidingWindow.record(false, 0);

    if (this.state === 'half_open') {
      this.state = 'open';
      this.openTime = Date.now();
      this.successCount = 0;
    } else {
      // 双重熔断判定：1) 绝对失败数达阈值 2) 滑动窗口错误率超标
      const failureThresholdMet = this.failureCount >= this.circuitConfig.failureThreshold;
      const errorRateMet = this.slidingWindow.getErrorRate() >= this.errorRateThreshold
        && this.slidingWindow.getCount() >= 5;
      if (failureThresholdMet || errorRateMet) {
        this.state = 'open';
        this.openTime = Date.now();
        this.successCount = 0;
      }
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.openTime) return true;
    return Date.now() - this.openTime >= this.circuitConfig.timeoutMs;
  }

  private isRetryable(err: Error): boolean {
    return this.retryConfig.retryableErrors.some(pattern => {
      if (pattern instanceof RegExp) return pattern.test(err.message);
      return err.message.includes(pattern);
    });
  }

  private calculateBackoff(attempt: number): number {
    const delay = Math.min(
      this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1),
      this.retryConfig.maxDelayMs,
    );
    if (this.retryConfig.jitter) {
      return delay + Math.random() * (delay * 0.5);
    }
    return delay;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.openTime = null;
    this.lastFailureTime = null;
    this.slidingWindow.reset();
  }

  /**
   * 公共方法：手动记录成功（用于无法通过 call() 包装的场景，如 agent loop 中手动跟踪）
   * 内部调用 onSuccess()，确保滑动窗口、统计、状态转换全部正确更新。
   * 替代之前通过 as any 直接操纵私有字段的错误做法。
   */
  recordSuccess(responseTime: number = 0): void {
    this.onSuccess(responseTime);
  }

  /**
   * 公共方法：手动记录失败（用于无法通过 call() 包装的场景）
   * 内部调用 onFailure()，确保滑动窗口、统计、状态转换全部正确更新。
   */
  recordFailure(): void {
    this.onFailure();
  }

  getStats(): CircuitBreakerStats {
    const times = this.responseTimes;
    const avgResponseTime = times.length > 0
      ? times.reduce((a, b) => a + b, 0) / times.length
      : 0;
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      openTime: this.openTime,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      avgResponseTime,
      // 滑动窗口增强统计
      errorRate: this.slidingWindow.getErrorRate(),
      p50ResponseTime: this.slidingWindow.getPercentile(0.5),
      p95ResponseTime: this.slidingWindow.getPercentile(0.95),
      p99ResponseTime: this.slidingWindow.getPercentile(0.99),
      windowCalls: this.slidingWindow.getCount(),
    };
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(
    public circuitName: string,
    public context?: string,
  ) {
    super(`Circuit breaker "${circuitName}" is OPEN${context ? ` (${context})` : ''}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class TimeoutError extends Error {
  constructor(
    public circuitName: string,
    public timeoutMs: number,
  ) {
    super(`Circuit breaker "${circuitName}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Bulkhead: 资源隔离器
 * 限制对特定资源的并发访问，防止单点故障扩散
 */
export class Bulkhead {
  private activeCount = 0;
  private queue: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void; fn: () => Promise<unknown> }> = [];
  private maxConcurrent: number;
  private queueSize: number;

  constructor(maxConcurrent: number = 5, queueSize: number = 50) {
    this.maxConcurrent = maxConcurrent;
    this.queueSize = queueSize;
  }

  call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount < this.maxConcurrent) {
      return this.execute(fn);
    }

    if (this.queue.length >= this.queueSize) {
      return Promise.reject(new BulkheadRejectedError(this.maxConcurrent, this.queueSize));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ resolve: resolve as (v: unknown) => void, reject, fn: fn as () => Promise<unknown> });
    }) as Promise<T>;
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.execute(next.fn).then(next.resolve).catch(next.reject);
    }
  }

  getStats(): { activeCount: number; queueLength: number; maxConcurrent: number } {
    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

export class BulkheadRejectedError extends Error {
  constructor(maxConcurrent: number, queueSize: number) {
    super(`Bulkhead: max concurrent ${maxConcurrent}, queue full (${queueSize})`);
    this.name = 'BulkheadRejectedError';
  }
}

/**
 * ResilienceChain: 组合多种弹性模式
 * CircuitBreaker -> Bulkhead -> Retry -> Timeout
 */
export class ResilienceChain {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private bulkheads: Map<string, Bulkhead> = new Map();

  getCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, { ...DEFAULT_CIRCUIT_CONFIG, ...config });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  getBulkhead(name: string, maxConcurrent?: number): Bulkhead {
    let bulkhead = this.bulkheads.get(name);
    if (!bulkhead) {
      bulkhead = new Bulkhead(maxConcurrent);
      this.bulkheads.set(name, bulkhead);
    }
    return bulkhead;
  }

  callWithBreaker<T>(name: string, fn: () => Promise<T>, context?: string): Promise<T> {
    const breaker = this.getCircuitBreaker(name);
    return breaker.call(fn, context);
  }

  callWithBulkhead<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const bulkhead = this.getBulkhead(name);
    return bulkhead.call(fn);
  }

  callWithFullProtection<T>(
    breakerName: string,
    bulkheadName: string,
    fn: () => Promise<T>,
    context?: string,
  ): Promise<T> {
    const bulkhead = this.getBulkhead(bulkheadName);
    return bulkhead.call(() => {
      const breaker = this.getCircuitBreaker(breakerName);
      return breaker.call(fn, context);
    });
  }

  getAllStats(): Record<string, unknown> {
    const breakerStats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      breakerStats[name] = breaker.getStats();
    }
    const bulkheadStats: Record<string, { activeCount: number; queueLength: number; maxConcurrent: number }> = {};
    for (const [name, bh] of this.bulkheads) {
      bulkheadStats[name] = bh.getStats();
    }
    return { breakers: breakerStats, bulkheads: bulkheadStats };
  }
}

// ============================================================
// 维度 5 P1：工具执行韧性包装
//
// 背景：tools.ts executeTool 路径已通过 I-3 委托 ScalableToolRegistry
// 获得内置熔断保护；但 enhanced-agent-loop.ts L5345/L753/L5384 直接调用
// entry.definition.execute()，绕过 registry。本辅助函数将"熔断+超时"统一
// 为单一调用点，由 executeToolWithTimeout 内部调用，三处入口全覆盖。
//
// 语义对齐：工具执行约定返回字符串（成功）或 `❌` 开头字符串（失败但不抛）。
// 熔断器需要主动 recordSuccess/recordFailure 才能正确识别业务失败。
// ============================================================

export interface ExecuteToolResilientlyOptions {
  /** 工具执行超时（ms），默认 30s */
  timeoutMs?: number;
  /** 是否启用熔断保护，未传时根据 process.env.USE_TOOL_CIRCUIT_BREAKER === 'true' */
  useCircuitBreaker?: boolean;
}

export interface ExecuteToolResilientlyResult {
  /** 工具返回结果（已转为字符串） */
  result: string;
  /** 是否成功（不以 ❌ 开头） */
  success: boolean;
  /** 熔断器当前状态（启用熔断时返回，便于上层观测） */
  circuitState?: CircuitState;
}

/**
 * 工具执行韧性包装：超时保护 + 可选熔断保护
 *
 * - 超时保护始终生效（与 executeToolWithTimeout 原行为一致）
 * - 启用熔断时：
 *   - 熔断打开 → 快速失败，返回 `❌ 工具 X 已熔断` 字符串
 *   - 工具返回 `❌` 字符串 → 主动 recordFailure
 *   - 工具正常返回 → 主动 recordSuccess
 *   - 工具抛异常 → 主动 recordFailure
 * - 灰度开关：USE_TOOL_CIRCUIT_BREAKER=true 启用（默认关闭，行为不变）
 */
export async function executeToolResiliently(
  toolName: string,
  executorFn: () => Promise<unknown>,
  options: ExecuteToolResilientlyOptions = {},
): Promise<ExecuteToolResilientlyResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const useCircuitBreaker = options.useCircuitBreaker ?? (process.env.USE_TOOL_CIRCUIT_BREAKER === 'true');

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`工具 ${toolName} 执行超时 (${timeoutMs / 1000}s)`)),
      timeoutMs,
    );
  });

  // 未启用熔断：走原超时保护路径（行为不变）
  if (!useCircuitBreaker) {
    try {
      const rawResult = await Promise.race([executorFn(), timeoutPromise]);
      const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
      return { result, success: !result.startsWith('❌') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `❌ 工具执行失败: ${msg}`, success: false };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // 启用熔断
  const breaker = resilienceChain.getCircuitBreaker(`tool_${toolName}`);
  const state = breaker.getState();

  // 熔断打开时快速失败（不消耗资源执行工具）
  if (state === 'open') {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return {
      result: `❌ 工具 ${toolName} 已熔断（连续失败过多），稍后再试`,
      success: false,
      circuitState: 'open',
    };
  }

  try {
    const rawResult = await Promise.race([executorFn(), timeoutPromise]);
    const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
    const success = !result.startsWith('❌');
    if (success) {
      breaker.recordSuccess();
    } else {
      breaker.recordFailure();
    }
    return { result, success, circuitState: breaker.getState() };
  } catch (err) {
    breaker.recordFailure();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: `❌ 工具执行失败: ${msg}`,
      success: false,
      circuitState: breaker.getState(),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export const resilienceChain = new ResilienceChain();
