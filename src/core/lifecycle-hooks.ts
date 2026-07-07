/**
 * 生命周期钩子管理器 — LifecycleHookManager
 *
 * 子系统四: Hooks 生命周期与确定性工程
 *
 * 覆盖 Agent 完整生命周期（区别于 ToolExecutionPipeline 仅覆盖工具执行阶段），
 * 提供 LLM 请求/响应、工具调用、错误恢复、会话管理、上下文压缩、子 Agent 调度等
 * 全链路钩子拦截能力。
 *
 * 核心设计：
 * - 优先级排序：priority 越小越先执行（默认 100）
 * - 顺序执行：钩子按优先级依次串行执行
 * - block 立即中断：任一钩子返回 block 则停止后续执行
 * - modify 传递修改：修改后的 data 传递给后续钩子
 * - delay 延迟继续：等待指定毫秒后继续执行后续钩子
 */

import { SENSITIVE_FIELD_KEYWORDS } from './security-config.js';

// ============ 生命周期事件枚举 ============

/** 生命周期事件类型 */
export enum LifecycleEvent {
  /** 发送 LLM 请求前 */
  ON_LLM_REQUEST = 'on_llm_request',
  /** 收到 LLM 响应后 */
  ON_LLM_RESPONSE = 'on_llm_response',
  /** 执行工具前 */
  ON_TOOL_CALL = 'on_tool_call',
  /** 工具执行后 */
  ON_TOOL_RESULT = 'on_tool_result',
  /** 发生错误时 */
  ON_ERROR = 'on_error',
  /** 循环迭代完成时 */
  ON_LOOP_COMPLETE = 'on_loop_complete',
  /** 会话开始时 */
  ON_SESSION_START = 'on_session_start',
  /** 会话结束时 */
  ON_SESSION_END = 'on_session_end',
  /** 上下文压缩触发时 */
  ON_CONTEXT_COMPRESS = 'on_context_compress',
  /** 子 Agent 派发前 */
  ON_SUBAGENT_DISPATCH = 'on_subagent_dispatch',
  /** 子 Agent 完成后 */
  ON_SUBAGENT_RESULT = 'on_subagent_result',
}

// ============ 类型定义 ============

/** 钩子上下文 */
export interface HookContext {
  /** 触发的生命周期事件 */
  event: LifecycleEvent;
  /** 会话 ID（可选） */
  sessionId?: string;
  /** 事件时间戳 */
  timestamp: number;
  /** 事件相关数据 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

/** 钩子执行结果 */
export type HookResult =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { action: 'modify'; modifiedData: Record<string, any>; reason: string }
  | { action: 'delay'; ms: number; reason: string };

/** 钩子处理器 */
export interface HookHandler {
  /** 钩子名称（同一事件内唯一标识） */
  name: string;
  /** 优先级：数值越小越先执行，默认 100 */
  priority: number;
  /** 钩子处理函数 */
  handler: (context: HookContext) => Promise<HookResult>;
}

/** trigger 返回结果 */
export interface TriggerResult {
  /** 是否允许继续 */
  allowed: boolean;
  /** 修改后的数据（如有 modify 操作） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modifiedData?: Record<string, any>;
  /** 被阻止的原因（如有 block 操作） */
  blockedReason?: string;
}

// ============ 生命周期钩子管理器 ============

export class LifecycleHookManager {
  /** 按事件类型分组的钩子注册表 */
  private hooks: Map<LifecycleEvent, HookHandler[]> = new Map();

  /**
   * 注册钩子
   * @param event  监听的生命周期事件
   * @param handler 钩子处理器
   * @returns 取消注册的函数
   */
  register(event: LifecycleEvent, handler: HookHandler): () => void {
    const handlers = this.hooks.get(event) ?? [];
    // 防止同名钩子重复注册
    const existingIdx = handlers.findIndex((h) => h.name === handler.name);
    if (existingIdx !== -1) {
      handlers[existingIdx] = handler;
    } else {
      handlers.push(handler);
    }
    this.hooks.set(event, handlers);

    // 返回取消注册函数
    return () => {
      this.unregister(event, handler.name);
    };
  }

  /**
   * 触发指定事件的所有钩子
   * 按优先级升序执行，遇到 block 立即中断
   * @param event 生命周期事件
   * @param data  事件数据
   * @returns 触发结果
   */
  async trigger(
    event: LifecycleEvent,
    data: Record<string, unknown>,
  ): Promise<TriggerResult> {
    const handlers = this.hooks.get(event) ?? [];

    // 按优先级升序排序（数值越小越先执行）
    const sorted = [...handlers].sort((a, b) => a.priority - b.priority);

    // 当前数据（可能被 modify 钩子修改）
    let currentData = { ...data };

    for (const hookHandler of sorted) {
      const context: HookContext = {
        event,
        timestamp: Date.now(),
        data: currentData,
      };

      let result: HookResult;
      try {
        result = await hookHandler.handler(context);
      } catch {
        // 钩子自身出错视为 continue，避免单个钩子异常阻断整个流程
        continue;
      }

      switch (result.action) {
        case 'continue':
          // 继续执行下一个钩子
          break;

        case 'block':
          // 立即中断，返回阻止原因
          return {
            allowed: false,
            blockedReason: result.reason,
          };

        case 'modify':
          // 更新数据，传递给后续钩子
          currentData = { ...currentData, ...result.modifiedData };
          break;

        case 'delay':
          // 等待指定时间后继续
          await this.sleep(result.ms);
          break;
      }
    }

    // 检查数据是否被修改过
    const dataModified = Object.keys(currentData).some(
      (key) => currentData[key] !== data[key],
    ) || Object.keys(currentData).length !== Object.keys(data).length;

    return {
      allowed: true,
      modifiedData: dataModified ? currentData : undefined,
    };
  }

  /**
   * 按名称移除钩子
   * @param event       生命周期事件
   * @param handlerName 钩子名称
   * @returns 是否成功移除
   */
  unregister(event: LifecycleEvent, handlerName: string): boolean {
    const handlers = this.hooks.get(event);
    if (!handlers) return false;

    const idx = handlers.findIndex((h) => h.name === handlerName);
    if (idx === -1) return false;

    handlers.splice(idx, 1);
    if (handlers.length === 0) {
      this.hooks.delete(event);
    }
    return true;
  }

  /**
   * 获取已注册的钩子列表
   * @param event 可选，指定事件类型则只返回该事件的钩子
   * @returns 钩子列表（按优先级排序）
   */
  getHooks(event?: LifecycleEvent): HookHandler[] {
    if (event) {
      const handlers = this.hooks.get(event) ?? [];
      return [...handlers].sort((a, b) => a.priority - b.priority);
    }

    // 返回所有事件的钩子
    const all: HookHandler[] = [];
    for (const handlers of this.hooks.values()) {
      all.push(...handlers);
    }
    return all.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 清除钩子
   * @param event 可选，指定事件类型则只清除该事件的钩子，否则清除全部
   */
  clear(event?: LifecycleEvent): void {
    if (event) {
      this.hooks.delete(event);
    } else {
      this.hooks.clear();
    }
  }

  /** 辅助：延迟等待 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============ 内置钩子实现 ============

/**
 * 速率限制钩子 — RateLimitHook
 *
 * 监听 ON_LLM_REQUEST，按 provider 维度限制每分钟最大请求数。
 * 默认：每个 provider 每分钟最多 20 次请求。
 * 超限时返回 delay，等待至窗口重置。
 */
export class RateLimitHook {
  name = 'rate_limit';
  priority = 10; // 高优先级，尽早拦截

  /** 每个 provider 的请求时间戳记录 */
  private requestTimestamps: Map<string, number[]> = new Map();
  /** 每个 provider 每分钟最大请求数 */
  private maxRequestsPerMinute: number;
  /** 时间窗口（毫秒） */
  private windowMs = 60_000;

  constructor(maxRequestsPerMinute = 20) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
  }

  handler = (context: HookContext): Promise<HookResult> => {
    const provider = context.data.provider ?? 'default';
    const now = Date.now();

    // 获取该 provider 的请求记录
    let timestamps = this.requestTimestamps.get(provider) ?? [];

    // 清除超出时间窗口的记录
    timestamps = timestamps.filter((ts) => now - ts < this.windowMs);

    // 检查是否超限
    if (timestamps.length >= this.maxRequestsPerMinute) {
      // 计算最早请求的过期时间
      const oldestInWindow = timestamps[0];
      const timeUntilReset = this.windowMs - (now - oldestInWindow);

      // 更新记录
      this.requestTimestamps.set(provider, timestamps);

      return Promise.resolve({
        action: 'delay',
        ms: timeUntilReset,
        reason: `速率限制: provider "${provider}" 已达 ${this.maxRequestsPerMinute} 次/分钟上限，需等待 ${timeUntilReset}ms`,
      });
    }

    // 记录本次请求
    timestamps.push(now);
    this.requestTimestamps.set(provider, timestamps);

    return Promise.resolve({ action: 'continue' });
  };

  /** 重置指定 provider 的速率限制记录 */
  resetProvider(provider: string): void {
    this.requestTimestamps.delete(provider);
  }

  /** 重置所有速率限制记录 */
  resetAll(): void {
    this.requestTimestamps.clear();
  }
}

/**
 * Token 预算钩子 — TokenBudgetHook
 *
 * 监听 ON_LLM_REQUEST，按会话维度跟踪累计 Token 消耗。
 * 默认：每个会话最多 200K tokens。
 * 超限时返回 block。
 */
export class TokenBudgetHook {
  name = 'token_budget';
  priority = 15; // 速率限制之后检查

  /** 每个会话的累计 Token 消耗 */
  private sessionTokenUsage: Map<string, number> = new Map();
  /** 每个会话的 Token 预算上限 */
  private budgetPerSession: number;

  constructor(budgetPerSession = 200_000) {
    this.budgetPerSession = budgetPerSession;
  }

  handler = (context: HookContext): Promise<HookResult> => {
    const sessionId = context.sessionId ?? '__default__';
    const currentUsage = this.sessionTokenUsage.get(sessionId) ?? 0;

    // 估算本次请求的 Token 消耗（从 data 中获取，若无则估算为 0）
    const estimatedTokens = (context.data.estimatedTokens as number) ?? 0;

    if (currentUsage + estimatedTokens > this.budgetPerSession) {
      return Promise.resolve({
        action: 'block',
        reason: `Token 预算超限: 会话 "${sessionId}" 已使用 ${currentUsage} tokens，预算上限 ${this.budgetPerSession} tokens`,
      });
    }

    return Promise.resolve({ action: 'continue' });
  };

  /**
   * 记录 Token 消耗（通常在 ON_LLM_RESPONSE 时调用）
   * @param sessionId 会话 ID
   * @param tokens    消耗的 Token 数量
   */
  recordUsage(sessionId: string, tokens: number): void {
    const current = this.sessionTokenUsage.get(sessionId) ?? 0;
    this.sessionTokenUsage.set(sessionId, current + tokens);
  }

  /** 获取指定会话的 Token 使用量 */
  getUsage(sessionId: string): number {
    return this.sessionTokenUsage.get(sessionId) ?? 0;
  }

  /** 重置指定会话的 Token 使用记录 */
  resetSession(sessionId: string): void {
    this.sessionTokenUsage.delete(sessionId);
  }
}

/**
 * 安全审计钩子 — SecurityAuditHook
 *
 * 监听 ON_TOOL_CALL，记录所有工具调用用于安全审计。
 * 始终返回 continue，不阻断流程。
 */
export class SecurityAuditHook {
  name = 'security_audit';
  priority = 50;

  /** 审计日志条目 */
  private auditLog: Array<{
    timestamp: number;
    sessionId?: string;
    toolName: string;
    args: Record<string, unknown>;
    riskLevel?: string;
  }> = [];

  /** 敏感字段关键词（用于脱敏，统一来源: security-config.ts） */
  private sensitiveKeys = SENSITIVE_FIELD_KEYWORDS;

  handler = (context: HookContext): Promise<HookResult> => {
    const entry = {
      timestamp: context.timestamp,
      sessionId: context.sessionId,
      toolName: context.data.toolName ?? 'unknown',
      args: this.sanitize(context.data.toolArgs ?? {}),
      riskLevel: context.data.riskLevel,
    };

    this.auditLog.push(entry);

    // 限制内存占用，最多保留 5000 条
    if (this.auditLog.length > 5000) {
      this.auditLog = this.auditLog.slice(-2500);
    }

    return Promise.resolve({ action: 'continue' });
  };

  /** 脱敏处理 */
  private sanitize(args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (this.sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** 获取审计日志 */
  getAuditLog() {
    return [...this.auditLog];
  }
}

/**
 * 成本追踪钩子 — CostTrackingHook
 *
 * 监听 ON_LLM_RESPONSE，追踪 Token 使用量和成本。
 * 始终返回 continue，不阻断流程。
 */
export class CostTrackingHook {
  name = 'cost_tracking';
  priority = 50;

  /** 每个会话的成本记录 */
  private sessionCosts: Map<string, {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
  }> = new Map();

  /** 每千 Token 的成本（美元），按模型区分 */
  private costPerThousand: Map<string, { prompt: number; completion: number }> = new Map([
    ['default', { prompt: 0.01, completion: 0.03 }],
  ]);

  handler = (context: HookContext): Promise<HookResult> => {
    const sessionId = context.sessionId ?? '__default__';
    const model = context.data.model ?? 'default';
    const promptTokens = (context.data.promptTokens as number) ?? 0;
    const completionTokens = (context.data.completionTokens as number) ?? 0;
    const totalTokens = promptTokens + completionTokens;

    // 获取模型定价
    const pricing = this.costPerThousand.get(model) ?? this.costPerThousand.get('default')!;
    const estimatedCost =
      (promptTokens / 1000) * pricing.prompt +
      (completionTokens / 1000) * pricing.completion;

    // 更新会话成本
    const existing = this.sessionCosts.get(sessionId) ?? {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCost: 0,
    };

    this.sessionCosts.set(sessionId, {
      totalTokens: existing.totalTokens + totalTokens,
      promptTokens: existing.promptTokens + promptTokens,
      completionTokens: existing.completionTokens + completionTokens,
      estimatedCost: existing.estimatedCost + estimatedCost,
    });

    return Promise.resolve({ action: 'continue' });
  };

  /** 设置模型定价 */
  setModelPricing(model: string, prompt: number, completion: number): void {
    this.costPerThousand.set(model, { prompt, completion });
  }

  /** 获取指定会话的成本统计 */
  getSessionCost(sessionId: string) {
    return this.sessionCosts.get(sessionId) ?? {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCost: 0,
    };
  }

  /** 获取所有会话的总成本 */
  getTotalCost() {
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let estimatedCost = 0;

    for (const cost of this.sessionCosts.values()) {
      totalTokens += cost.totalTokens;
      promptTokens += cost.promptTokens;
      completionTokens += cost.completionTokens;
      estimatedCost += cost.estimatedCost;
    }

    return { totalTokens, promptTokens, completionTokens, estimatedCost };
  }
}

/**
 * 错误恢复钩子 — ErrorRecoveryHook
 *
 * 监听 ON_ERROR，对瞬态错误自动重试（最多 2 次）。
 * 通过在 data 中标记 retryCount 和 shouldRetry 来指示重试。
 */
export class ErrorRecoveryHook {
  name = 'error_recovery';
  priority = 20;

  /** 最大重试次数 */
  private maxRetries: number;

  /** 可重试的错误模式 */
  private retryablePatterns: RegExp[] = [
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
    /ECONNREFUSED/i,
  ];

  constructor(maxRetries = 2) {
    this.maxRetries = maxRetries;
  }

  handler = (context: HookContext): Promise<HookResult> => {
    const error = context.data.error;
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    const retryCount = (context.data.retryCount as number) ?? 0;

    // 判断是否为可重试的瞬态错误
    const isRetryable = this.retryablePatterns.some((p) => p.test(errorMessage));

    if (!isRetryable) {
      // 非瞬态错误，不重试
      return Promise.resolve({ action: 'continue' });
    }

    if (retryCount >= this.maxRetries) {
      // 已达最大重试次数，不再重试
      return Promise.resolve({ action: 'continue' });
    }

    // 标记需要重试，并计算退避延迟
    const baseDelay = 1000;
    const delay = baseDelay * Math.pow(2, retryCount);

    return Promise.resolve({
      action: 'modify',
      modifiedData: {
        shouldRetry: true,
        retryCount: retryCount + 1,
        retryDelay: delay,
      },
      reason: `瞬态错误自动重试 (${retryCount + 1}/${this.maxRetries}): ${errorMessage.substring(0, 100)}`,
    });
  };

  /** 添加可重试的错误模式 */
  addRetryablePattern(pattern: RegExp): void {
    this.retryablePatterns.push(pattern);
  }
}

/**
 * 会话清理钩子 — SessionCleanupHook
 *
 * 监听 ON_SESSION_END，触发会话数据整合与清理。
 * 始终返回 continue，不阻断流程。
 */
export class SessionCleanupHook {
  name = 'session_cleanup';
  priority = 80; // 低优先级，在其他钩子之后执行

  /** 已清理的会话记录 */
  private cleanedSessions: Set<string> = new Set();

  /** 清理回调列表 */
  private cleanupCallbacks: Array<(sessionId: string) => Promise<void>> = [];

  handler = async (context: HookContext): Promise<HookResult> => {
    const sessionId = context.sessionId ?? '__default__';

    // 执行所有清理回调
    for (const callback of this.cleanupCallbacks) {
      try {
        await callback(sessionId);
      } catch {
        // 清理回调失败不影响主流程
      }
    }

    this.cleanedSessions.add(sessionId);

    return { action: 'continue' };
  };

  /** 注册清理回调 */
  onCleanup(callback: (sessionId: string) => Promise<void>): void {
    this.cleanupCallbacks.push(callback);
  }

  /** 检查会话是否已清理 */
  isCleaned(sessionId: string): boolean {
    return this.cleanedSessions.has(sessionId);
  }

  /** 获取已清理会话数量 */
  getCleanedCount(): number {
    return this.cleanedSessions.size;
  }
}

// ============ 工厂函数：创建预配置的管理器 ============

/** 内置钩子配置选项 */
export interface BuiltinHooksOptions {
  /** 每个 provider 每分钟最大请求数（默认 20） */
  rateLimitPerMinute?: number;
  /** 每个会话的 Token 预算上限（默认 200000） */
  tokenBudgetPerSession?: number;
  /** 错误恢复最大重试次数（默认 2） */
  maxErrorRetries?: number;
}

/**
 * 创建预配置了所有内置钩子的 LifecycleHookManager 实例
 * @param options 内置钩子配置
 * @returns 管理器实例及内置钩子引用
 */
export function createLifecycleHookManager(options?: BuiltinHooksOptions) {
  const manager = new LifecycleHookManager();

  // 实例化内置钩子
  const rateLimitHook = new RateLimitHook(options?.rateLimitPerMinute);
  const tokenBudgetHook = new TokenBudgetHook(options?.tokenBudgetPerSession);
  const securityAuditHook = new SecurityAuditHook();
  const costTrackingHook = new CostTrackingHook();
  const errorRecoveryHook = new ErrorRecoveryHook(options?.maxErrorRetries);
  const sessionCleanupHook = new SessionCleanupHook();

  // 注册内置钩子到对应事件
  manager.register(LifecycleEvent.ON_LLM_REQUEST, {
    name: rateLimitHook.name,
    priority: rateLimitHook.priority,
    handler: rateLimitHook.handler,
  });

  manager.register(LifecycleEvent.ON_LLM_REQUEST, {
    name: tokenBudgetHook.name,
    priority: tokenBudgetHook.priority,
    handler: tokenBudgetHook.handler,
  });

  manager.register(LifecycleEvent.ON_TOOL_CALL, {
    name: securityAuditHook.name,
    priority: securityAuditHook.priority,
    handler: securityAuditHook.handler,
  });

  manager.register(LifecycleEvent.ON_LLM_RESPONSE, {
    name: costTrackingHook.name,
    priority: costTrackingHook.priority,
    handler: costTrackingHook.handler,
  });

  manager.register(LifecycleEvent.ON_ERROR, {
    name: errorRecoveryHook.name,
    priority: errorRecoveryHook.priority,
    handler: errorRecoveryHook.handler,
  });

  manager.register(LifecycleEvent.ON_SESSION_END, {
    name: sessionCleanupHook.name,
    priority: sessionCleanupHook.priority,
    handler: sessionCleanupHook.handler,
  });

  return {
    manager,
    rateLimitHook,
    tokenBudgetHook,
    securityAuditHook,
    costTrackingHook,
    errorRecoveryHook,
    sessionCleanupHook,
  };
}
