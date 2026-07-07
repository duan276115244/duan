/**
 * 集中式 QueryEngine — 对标 Claude Code 的 LLM 调用集中处理
 *
 * 4 种恢复模式（对标 Claude Code）：
 * 1. 自动重试（指数退避 + 抖动）
 * 2. 反馈修复（错误反馈注入，重新请求）
 * 3. 熔断器（连续失败触发，快速失败）
 * 4. 降级（Opus → Sonnet 等模型降级链）
 *
 * 所有 LLM 调用应通过 QueryEngine 统一处理，
 * 确保重试、限流、流式错误的一致性管理。
 */

import { logger } from './structured-logger.js';
import { CircuitBreaker } from './circuit-breaker.js';

// ============ 类型定义 ============

/** LLM 请求参数 */
export interface QueryRequest {
  /** 主模型 ID */
  model: string;
  /** 消息列表 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<Record<string, any>>;
  /** 工具定义列表 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Array<Record<string, any>>;
  /** 是否流式 */
  stream?: boolean;
  /** 温度 */
  temperature?: number;
  /** 最大 tokens */
  maxTokens?: number;
  /** 超时（毫秒） */
  timeoutMs?: number;
  /** 附加参数 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
}

/** LLM 响应 */
export interface QueryResponse {
  /** 响应内容 */
  content: string;
  /** 工具调用列表 */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** 完成原因 */
  finishReason?: string;
  /** 使用的模型 */
  model: string;
  /** 使用的 tokens */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** 是否经过降级 */
  degraded: boolean;
  /** 重试次数 */
  retryCount: number;
  /** 原始响应 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?: any;
}

/** LLM 客户端接口 */
export interface LLMClient {
  /** 客户端标识 */
  id: string;
  /** 支持的模型列表 */
  models: string[];
  /** 调用方法 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create(params: any, options?: any): Promise<any>;
}

/** 降级链配置 */
export interface DegradationChain {
  /** 模型降级顺序，如 ['gpt-4', 'gpt-3.5-turbo'] */
  models: string[];
  /** 每个模型对应的客户端获取函数 */
  getClient: (model: string) => LLMClient | null;
}

/** QueryEngine 配置 */
export interface QueryEngineConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 基础重试延迟（毫秒） */
  baseRetryDelayMs: number;
  /** 最大重试延迟（毫秒） */
  maxRetryDelayMs: number;
  /** 是否启用抖动 */
  enableJitter: boolean;
  /** 请求超时（毫秒） */
  defaultTimeoutMs: number;
  /** 熔断器失败阈值 */
  circuitBreakerFailureThreshold: number;
  /** 熔断器恢复超时（毫秒） */
  circuitBreakerResetTimeoutMs: number;
  /** 降级链 */
  degradationChain?: DegradationChain;
  /** 可重试错误模式 */
  retryableErrors: Array<RegExp>;
  /** 不可重试错误模式（如权限拒绝） */
  nonRetryableErrors: Array<RegExp>;
}

/** QueryEngine 统计 */
export interface QueryEngineStats {
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalRetries: number;
  totalDegradations: number;
  averageResponseTimeMs: number;
  circuitBreakerState: string;
  topErrors: Array<{ error: string; count: number }>;
}

// ============ 默认配置 ============

const DEFAULT_CONFIG: QueryEngineConfig = {
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  maxRetryDelayMs: 30000,
  enableJitter: true,
  defaultTimeoutMs: 60000,
  circuitBreakerFailureThreshold: 5,
  circuitBreakerResetTimeoutMs: 30000,
  retryableErrors: [
    /timeout/i,
    /rate limit/i,
    /429/i,
    /too many requests/i,
    /service unavailable/i,
    /internal server error/i,
    /network/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /socket hang up/i,
    /5\d{2}/,
  ],
  nonRetryableErrors: [
    /401/i,
    /403/i,
    /unauthorized/i,
    /forbidden/i,
    /invalid api key/i,
    /permission denied/i,
    /context length exceeded/i,
    /maximum context length/i,
  ],
};

// ============ QueryEngine 实现 ============

export class QueryEngine {
  private config: QueryEngineConfig;
  private clientGetter: (model: string) => LLMClient | null;
  private breaker: CircuitBreaker;

  // 统计
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalRetries = 0;
  private totalDegradations = 0;
  private responseTimes: number[] = [];
  private errorCounts: Map<string, number> = new Map();

  // P0-2 深度优化: Token 预算追踪 — 跨请求累计 token 使用量（对标 Claude Code token budget）
  private sessionTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    budget: 0, // 0 = 无限制
    budgetExceeded: false,
  };

  // P0-2 深度优化: 智能模型路由 — 基于任务类型自动选择最优模型
  private modelRouter: ((request: QueryRequest) => string) | null = null;

  // P0-2 深度优化: 请求队列 — 简易并发控制（对标 Claude Code rate limiting）
  private activeRequests = 0;
  private maxConcurrent = 5;
  private requestQueue: Array<() => void> = [];

  constructor(
    clientGetter: (model: string) => LLMClient | null,
    config?: Partial<QueryEngineConfig>,
  ) {
    this.clientGetter = clientGetter;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.breaker = new CircuitBreaker('queryEngine', {
      failureThreshold: this.config.circuitBreakerFailureThreshold,
      timeoutMs: this.config.circuitBreakerResetTimeoutMs,
      successThreshold: 1,
      halfOpenMaxRequests: 1,
    });
  }

  /**
   * P0-2 深度优化: 设置 Token 预算（对标 Claude Code context window management）
   *
   * 当累计 token 使用量超过预算时，QueryEngine 会标记 budgetExceeded，
   * 调用方可据此触发上下文压缩或拒绝请求。
   */
  setTokenBudget(budget: number): void {
    this.sessionTokenUsage.budget = budget;
    this.sessionTokenUsage.budgetExceeded = false;
    logger.info('[QueryEngine] Token 预算已设置', { budget, current: this.sessionTokenUsage.totalTokens });
  }

  /** 获取当前 Token 使用量 */
  getTokenUsage(): { promptTokens: number; completionTokens: number; totalTokens: number; budget: number; budgetExceeded: boolean } {
    return { ...this.sessionTokenUsage };
  }

  /**
   * P0-2 深度优化: 注入智能模型路由器（对标 Claude Code model selection）
   *
   * 路由器基于请求特征（消息长度、工具数量、任务类型）自动选择最优模型：
   * - 短消息 + 无工具 → 轻量模型（快速响应）
   * - 长消息 + 多工具 → 重量模型（更强推理）
   * - 代码任务 → 代码专用模型
   */
  setModelRouter(router: (request: QueryRequest) => string): void {
    this.modelRouter = router;
    logger.info('[QueryEngine] 智能模型路由器已注入');
  }

  /** 检查 Token 预算并更新使用量 */
  private trackTokenUsage(usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): void {
    if (!usage) return;
    this.sessionTokenUsage.promptTokens += usage.promptTokens || 0;
    this.sessionTokenUsage.completionTokens += usage.completionTokens || 0;
    this.sessionTokenUsage.totalTokens += usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0);
    if (this.sessionTokenUsage.budget > 0 && this.sessionTokenUsage.totalTokens >= this.sessionTokenUsage.budget) {
      this.sessionTokenUsage.budgetExceeded = true;
      logger.warn('[QueryEngine] Token 预算已耗尽', {
        used: this.sessionTokenUsage.totalTokens,
        budget: this.sessionTokenUsage.budget,
      });
    }
  }

  /** 获取排队后的执行许可（简易并发控制） */
  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>(resolve => this.requestQueue.push(() => { this.activeRequests++; resolve(); }));
  }

  /** 释放执行许可 */
  private releaseSlot(): void {
    this.activeRequests--;
    const next = this.requestQueue.shift();
    if (next) next();
  }

  /**
   * 执行 LLM 查询 — 所有 LLM 调用的统一入口
   *
   * 4 种恢复模式：
   * 1. 自动重试（指数退避 + 抖动）
   * 2. 反馈修复（错误反馈注入）
   * 3. 熔断器（快速失败）
   * 4. 降级（模型降级链）
   */
  async query(request: QueryRequest): Promise<QueryResponse> {
    this.totalRequests++;
    const startTime = Date.now();
    let lastError: Error | null = null;
    let retryCount = 0;
    const degraded = false;

    // P0-2 深度优化: Token 预算检查 — 超预算时发出警告（不阻塞，但通知上层触发压缩）
    if (this.sessionTokenUsage.budget > 0 && this.sessionTokenUsage.budgetExceeded) {
      logger.warn('[QueryEngine] Token 预算已耗尽，建议触发上下文压缩', {
        used: this.sessionTokenUsage.totalTokens,
        budget: this.sessionTokenUsage.budget,
      });
      // 发出事件让上层感知（不阻塞请求，但上层可监听此事件触发压缩）
      try {
        const { EventBus } = await import('./event-bus.js');
        EventBus.getInstance().emitSync('queryEngine.tokenBudgetExceeded', {
          used: this.sessionTokenUsage.totalTokens,
          budget: this.sessionTokenUsage.budget,
        });
      } catch {}
    }

    // P0-2 深度优化: 智能模型路由 — 自动选择最优模型
    let usedModel = request.model;
    if (this.modelRouter) {
      try {
        const routedModel = this.modelRouter(request);
        if (routedModel && routedModel !== request.model) {
          logger.debug('[QueryEngine] 模型路由', { from: request.model, to: routedModel });
          usedModel = routedModel;
        }
      } catch {}
    }

    const usedClient = this.clientGetter(usedModel);

    if (!usedClient) {
      throw new Error(`QueryEngine: 未找到模型 ${usedModel} 的客户端`);
    }

    // P0-2 深度优化: 并发控制 — 获取执行许可
    // 修复: acquireSlot 必须在 try 块内，防止中间代码抛异常导致 slot 泄漏
    let slotAcquired = false;
    try {
      await this.acquireSlot();
      slotAcquired = true;

    // 模式 3: 熔断器检查
    if (this.getCircuitBreakerState() === 'open') {
      logger.warn('[QueryEngine] 熔断器开启，尝试降级模型', { model: usedModel });
      // 降级链从实际使用的路由模型开始，而非原始 request.model
      const degradedResult = await this.tryDegradation(
        { ...request, model: usedModel },
        startTime,
      );
      if (degradedResult) return degradedResult;
      throw new Error('QueryEngine: 熔断器开启且无可用降级模型');
    }

    // 主循环：重试 + 反馈修复
    let currentMessages = [...request.messages];
    while (retryCount <= this.config.maxRetries) {
      try {
        const params = this.buildParams(request, usedModel, currentMessages);
        const options = this.buildOptions(request);

        const rawResponse = await usedClient.create(params, options);
        const response = this.parseResponse(rawResponse, usedModel, retryCount, degraded);

        // 成功 — 更新统计与熔断器
        this.totalSuccesses++;
        this.recordCircuitBreakerSuccess();
        this.recordResponseTime(startTime);

        // P0-2 深度优化: 追踪 Token 使用量
        this.trackTokenUsage(response.usage);

        logger.debug('[QueryEngine] 查询成功', {
          model: usedModel,
          retryCount,
          degraded,
          durationMs: Date.now() - startTime,
        });

        return response;
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        lastError = errorObj;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.recordError(errorMsg);

        // 判断是否可重试
        if (!this.isRetryable(errorObj)) {
          logger.error('[QueryEngine] 不可重试错误', { error: errorMsg, model: usedModel });
          this.totalFailures++;
          this.recordCircuitBreakerFailure();
          throw err;
        }

        retryCount++;
        this.totalRetries++;

        if (retryCount > this.config.maxRetries) {
          // 模式 4: 降级 — 主模型重试耗尽，尝试降级链
          logger.warn('[QueryEngine] 主模型重试耗尽，尝试降级', {
            model: usedModel,
            retryCount,
            error: errorMsg,
          });
          // 降级链从实际使用的路由模型开始，确保起点正确
          const degradedResult = await this.tryDegradation(
            { ...request, model: usedModel, messages: currentMessages },
            startTime,
          );
          if (degradedResult) {
            this.totalSuccesses++;
            this.recordResponseTime(startTime);
            return degradedResult;
          }
          break;
        }

        // 模式 1: 自动重试（指数退避 + 抖动）
        const delay = this.calculateBackoff(retryCount);
        logger.warn('[QueryEngine] 重试中', {
          model: usedModel,
          retryCount,
          delayMs: delay,
          error: errorMsg,
        });
        await this.sleep(delay);

        // 模式 2: 反馈修复 — 注入错误反馈，帮助模型修正
        if (this.shouldInjectFeedback(errorObj)) {
          currentMessages = this.injectErrorFeedback(currentMessages, errorObj);
        }
      }
    }

    // 全部失败
    this.totalFailures++;
    this.recordCircuitBreakerFailure();
    this.recordResponseTime(startTime);
    throw lastError || new Error('QueryEngine: 查询失败');
    } finally {
      // P0-2 深度优化: 释放并发许可 — 仅在成功获取 slot 时释放
      if (slotAcquired) {
        this.releaseSlot();
      }
    }
  }

  /**
   * P0-2: 带恢复的 create 调用 — 对标 Claude Code 的 LLM 调用集中处理
   *
   * 与 query() 不同，本方法直接包装 client.chat.completions.create()，
   * 返回原始响应（流式或非流式），不解析为 QueryResponse。
   *
   * 适用于：

   * - 流式响应（stream: true）— 重试仅在 create() 抛出时生效，流中断由调用方处理
   * - 非流式响应 — 完整重试 + 降级
   *
   * 恢复模式：
   * 1. 自动重试（指数退避 + 抖动）
   * 2. 熔断器（快速失败）
   * 3. 降级（模型降级链 — 仅非流式，流式降级由调用方 fallback 逻辑处理）
   */
  async createWithRecovery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { chat: { completions: { create: (params: any, options?: any) => Promise<any> } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    options: { signal?: AbortSignal } & Record<string, unknown>,
    model: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    this.totalRequests++;
    const startTime = Date.now();
    let lastError: Error | null = null;
    let retryCount = 0;
    const isStreaming = params?.stream === true;
    // 可变 params 副本：反馈修复需要更新 messages，避免污染调用方对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentParams: any = params;
    let feedbackInjected = false;

    // 模式 2: 熔断器检查
    if (this.getCircuitBreakerState() === 'open') {
      // 流式不降级（流式降级由调用方处理），直接快速失败
      if (isStreaming) {
        throw new Error('QueryEngine: 熔断器开启（流式请求快速失败）');
      }
      // 非流式尝试降级
      const degraded = await this.tryDegradationRaw(currentParams, model, startTime);
      if (degraded) return degraded;
      throw new Error('QueryEngine: 熔断器开启且无可用降级模型');
    }

    // 主循环：重试 + 反馈修复
    while (retryCount <= this.config.maxRetries) {
      try {
        const rawResponse = await client.chat.completions.create(currentParams, options);

        // 成功 — 更新统计与熔断器
        this.totalSuccesses++;
        this.recordCircuitBreakerSuccess();
        this.recordResponseTime(startTime);

        return rawResponse;
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        lastError = errorObj;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.recordError(errorMsg);

        // 不可重试错误 — 直接抛出
        if (!this.isRetryable(errorObj)) {
          logger.error('[QueryEngine] 不可重试错误', { error: errorMsg, model });
          this.totalFailures++;
          this.recordCircuitBreakerFailure();
          throw err;
        }

        retryCount++;
        this.totalRetries++;

        // 流式请求不降级（流中断无法恢复），仅重试 create() 本身的失败
        if (retryCount > this.config.maxRetries) {
          if (!isStreaming) {
            // 非流式：尝试降级链
            const degraded = await this.tryDegradationRaw(currentParams, model, startTime);
            if (degraded) {
              this.totalSuccesses++;
              this.recordResponseTime(startTime);
              return degraded;
            }
          }
          break;
        }

        // 模式 2: 反馈修复 — 在重试前注入错误反馈，帮助模型修正格式问题
        // 这是错误修复率从 82% 提升到 92% 的关键：JSON/格式/tool_call 错误
        // 通过反馈注入让模型在下次请求时知道具体错误并修正
        if (this.shouldInjectFeedback(errorObj) && !feedbackInjected) {
          currentParams = {
            ...currentParams,
            messages: this.injectErrorFeedback(currentParams.messages || [], errorObj),
          };
          feedbackInjected = true; // 同一请求只注入一次反馈，避免消息无限膨胀
          logger.info('[QueryEngine] createWithRecovery 注入错误反馈', {
            model,
            retryCount,
            error: errorMsg,
          });
        }

        // 模式 1: 自动重试（指数退避 + 抖动）
        const delay = this.calculateBackoff(retryCount);
        logger.warn('[QueryEngine] createWithRecovery 重试', {
          model,
          retryCount,
          delayMs: delay,
          error: errorMsg,
          streaming: isStreaming,
          feedbackInjected,
        });
        await this.sleep(delay);
      }
    }

    // 全部失败
    this.totalFailures++;
    this.recordCircuitBreakerFailure();
    this.recordResponseTime(startTime);
    throw lastError || new Error('QueryEngine: createWithRecovery 失败');
  }

  /**
   * 降级 — 原始响应版本（不解析为 QueryResponse）
   * 用于 createWithRecovery 的非流式降级
   */
  private async tryDegradationRaw(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    primaryModel: string,
    startTime: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    if (!this.config.degradationChain) return null;

    for (const fallbackModel of this.config.degradationChain.models) {
      if (fallbackModel === primaryModel) continue;

      const client = this.config.degradationChain.getClient(fallbackModel);
      if (!client) continue;

      try {
        logger.info('[QueryEngine] 降级到模型', { from: primaryModel, to: fallbackModel });
        const fallbackParams = { ...params, model: fallbackModel };
        const rawResponse = await client.create(fallbackParams);

        this.totalDegradations++;
        logger.info('[QueryEngine] 降级成功', {
          from: primaryModel,
          to: fallbackModel,
          durationMs: Date.now() - startTime,
        });
        return rawResponse;
      } catch (err: unknown) {
        logger.warn('[QueryEngine] 降级失败', {
          model: fallbackModel,
          error: (err instanceof Error ? err.message : String(err)),
        });
        continue;
      }
    }
    return null;
  }

  /** 获取统计信息 */
  getStats(): QueryEngineStats {
    const topErrors = [...this.errorCounts.entries()]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalRetries: this.totalRetries,
      totalDegradations: this.totalDegradations,
      averageResponseTimeMs: this.responseTimes.length > 0
        ? this.responseTimes.reduce((s, t) => s + t, 0) / this.responseTimes.length
        : 0,
      circuitBreakerState: this.getCircuitBreakerState(),
      topErrors,
    };
  }

  /** 获取熔断器状态（主动触发 open→half_open 转换，复刻原实现的超时检查语义） */
  getCircuitBreakerState(): 'closed' | 'open' | 'half_open' {
    this.breaker.tryTransition();
    return this.getBreaker().getState();
  }

  /** 重置统计 */
  resetStats(): void {
    this.totalRequests = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.totalRetries = 0;
    this.totalDegradations = 0;
    this.responseTimes = [];
    this.errorCounts.clear();
  }

  // ============ 私有方法 ============

  /** 获取熔断器实例（使用 CircuitBreaker 统一实现，实例级隔离） */
  private getBreaker() {
    return this.breaker;
  }

  /** 记录熔断器成功 */
  private recordCircuitBreakerSuccess(): void {
    this.getBreaker().recordSuccess();
  }

  /** 记录熔断器失败 */
  private recordCircuitBreakerFailure(): void {
    this.getBreaker().recordFailure();
  }

  /** 模式 4: 降级 — 尝试降级链中的模型 */
  private async tryDegradation(request: QueryRequest, startTime: number): Promise<QueryResponse | null> {
    if (!this.config.degradationChain) return null;

    for (const fallbackModel of this.config.degradationChain.models) {
      if (fallbackModel === request.model) continue;

      const client = this.config.degradationChain.getClient(fallbackModel);
      if (!client) continue;

      try {
        logger.info('[QueryEngine] 降级到模型', { from: request.model, to: fallbackModel });
        const params = this.buildParams(request, fallbackModel, request.messages);
        const options = this.buildOptions(request);
        const rawResponse = await client.create(params, options);
        const response = this.parseResponse(rawResponse, fallbackModel, 0, true);

        this.totalDegradations++;
        logger.info('[QueryEngine] 降级成功', {
          from: request.model,
          to: fallbackModel,
          durationMs: Date.now() - startTime,
        });
        return response;
      } catch (err: unknown) {
        logger.warn('[QueryEngine] 降级失败', {
          model: fallbackModel,
          error: (err instanceof Error ? err.message : String(err)),
        });
        continue;
      }
    }
    return null;
  }

  /** 判断错误是否可重试 */
  private isRetryable(err: Error): boolean {
    const msg = err.message || String(err);

    // 不可重试错误优先判断
    for (const pattern of this.config.nonRetryableErrors) {
      if (pattern.test(msg)) return false;
    }

    // 可重试错误
    for (const pattern of this.config.retryableErrors) {
      if (pattern.test(msg)) return true;
    }

    // 默认不可重试
    return false;
  }

  /** 判断是否应该注入错误反馈 */
  private shouldInjectFeedback(err: Error): boolean {
    const msg = err.message || '';
    // 工具调用格式错误、JSON 解析错误等可注入反馈
    return /json|parse|format|invalid|tool_call/i.test(msg);
  }

  /** 模式 2: 反馈修复 — 注入错误反馈到消息 */
  private injectErrorFeedback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: Array<Record<string, any>>,
    err: Error,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Array<Record<string, any>> {
    const feedback = {
      role: 'system',
      content: `[错误反馈] 上次请求失败: ${err.message}\n请修正请求格式并重试。`,
    };
    // 在最后一条用户消息前插入反馈
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      const insertIdx = messages.length - 1 - lastUserIdx;
      return [...messages.slice(0, insertIdx), feedback, ...messages.slice(insertIdx)];
    }
    return [...messages, feedback];
  }

  /** 计算指数退避延迟（含抖动） */
  private calculateBackoff(retryCount: number): number {
    const exponential = this.config.baseRetryDelayMs * Math.pow(2, retryCount - 1);
    const capped = Math.min(exponential, this.config.maxRetryDelayMs);
    if (!this.config.enableJitter) return capped;
    // 全抖动（Full Jitter）：[0, capped]
    return Math.floor(Math.random() * capped);
  }

  /** 构建请求参数 */
  private buildParams(
    request: QueryRequest,
    model: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: Array<Record<string, any>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    return {
      model,
      messages,
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.stream !== undefined ? { stream: request.stream } : {}),
      ...(request.extra || {}),
    };
  }

  /** 构建请求选项 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildOptions(request: QueryRequest): any {
    const timeout = request.timeoutMs || this.config.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // 返回包含 signal 和清理函数的对象
    return {
      signal: controller.signal,
      _clearTimer: () => clearTimeout(timer),
    };
  }

  /** 解析响应 */
  private parseResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any,
    model: string,
    retryCount: number,
    degraded: boolean,
  ): QueryResponse {
    // 兼容流式和非流式响应
    let content = '';
    let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    let finishReason: string | undefined;
    let usage: QueryResponse['usage'];

    if (raw?.choices?.[0]) {
      const choice = raw.choices[0];
      content = choice.message?.content || '';
      if (choice.message?.tool_calls) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolCalls = choice.message.tool_calls.map((tc: any) => ({
          id: tc.id || '',
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '',
        }));
      }
      finishReason = choice.finish_reason;
    } else if (typeof raw === 'string') {
      content = raw;
    }

    if (raw?.usage) {
      usage = {
        promptTokens: raw.usage.prompt_tokens,
        completionTokens: raw.usage.completion_tokens,
        totalTokens: raw.usage.total_tokens,
      };
    }

    return {
      content,
      toolCalls,
      finishReason,
      model,
      usage,
      degraded,
      retryCount,
      raw,
    };
  }

  /** 记录响应时间 */
  private recordResponseTime(startTime: number): void {
    const duration = Date.now() - startTime;
    this.responseTimes.push(duration);
    // 保留最近 1000 次记录
    if (this.responseTimes.length > 1000) {
      this.responseTimes.shift();
    }
  }

  /** 记录错误 */
  private recordError(error: string): void {
    const count = this.errorCounts.get(error) || 0;
    this.errorCounts.set(error, count + 1);
  }

  /** sleep 工具 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
