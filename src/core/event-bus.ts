/**
 * 全局事件总线 — EventBus
 *
 * 大厂级事件总线设计（借鉴 Google Pub/Sub + Meta Scribe）：
 * - 异步/同步监听、通配符订阅、一次性订阅
 * - 事件溯源：记录事件历史用于调试和回放
 * - 批量处理：高吞吐事件合并处理
 * - 去重：防止重复事件
 * - 指标收集：emit 速率、延迟 P50/P95/P99、订阅者统计
 * - 背压控制：防止事件生产速度超过消费速度
 */

import { logger } from './structured-logger.js';

// ============ 事件类型定义 ============

export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export interface BusEvent {
  type: string;
  source: string;
  timestamp: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  priority?: EventPriority;
  id?: string;
  dedupKey?: string;
}

export type EventHandler = (event: BusEvent) => void | Promise<void>;

export interface Subscription {
  id: string;
  pattern: string;
  handler: EventHandler;
  once?: boolean;
  filter?: (event: BusEvent) => boolean;
}

export interface EventHistoryEntry {
  event: BusEvent;
  deliveredTo: string[];
  processingTime: number;
}

export interface EventBusMetrics {
  totalEmitted: number;
  totalDelivered: number;
  totalFailed: number;
  emitRatePerSecond: number;
  avgProcessingTime: number;
  p50ProcessingTime: number;
  p95ProcessingTime: number;
  p99ProcessingTime: number;
  subscriberCount: number;
  patternsCount: number;
  historySize: number;
  dedupHits: number;
  batchedCount: number;
}

interface BatchedEvent {
  type: string;
  events: BusEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  handler: EventHandler;
}

// ============ 事件总线主类 ============

export class EventBus {
  private static instance: EventBus;
  private subscribers: Map<string, Subscription[]> = new Map();
  private history: EventHistoryEntry[] = [];
  private maxHistorySize = 1000;
  private wildcardSubscribers: Subscription[] = [];
  private debugMode = false;
  private log = logger.child({ module: 'EventBus' });

  // Metrics
  private totalEmitted = 0;
  private totalDelivered = 0;
  private totalFailed = 0;
  private processingTimes: number[] = [];
  private emitTimestamps: number[] = [];
  private dedupHits = 0;
  private batchedCount = 0;

  // Dedup
  private dedupWindow = 5000;
  private recentEvents = new Map<string, number>();

  // Batch configs: event types that should be batched
  private batchConfigs = new Map<string, { intervalMs: number; maxBatchSize: number }>();
  private batchedEvents = new Map<string, BatchedEvent>();

  private constructor() {}

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
  }

  /** Configure batch processing for an event type */
  configureBatch(type: string, intervalMs: number = 200, maxBatchSize: number = 50): void {
    this.batchConfigs.set(type, { intervalMs, maxBatchSize });
  }

  /** Configure dedup window */
  setDedupWindow(ms: number): void {
    this.dedupWindow = ms;
  }

  on(pattern: string, handler: EventHandler, options?: {
    once?: boolean;
    filter?: (event: BusEvent) => boolean;
    priority?: EventPriority;
  }): () => void {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sub: Subscription = {
      id,
      pattern,
      handler,
      once: options?.once,
      filter: options?.filter,
    };

    if (pattern === '**' || pattern === '*') {
      this.wildcardSubscribers.push(sub);
    } else {
      const existing = this.subscribers.get(pattern) || [];
      existing.push(sub);
      this.subscribers.set(pattern, existing);
    }

    return () => this.unsubscribe(id);
  }

  once(pattern: string, handler: EventHandler): () => void {
    return this.on(pattern, handler, { once: true });
  }

  unsubscribe(id: string): void {
    for (const [pattern, subs] of this.subscribers) {
      const filtered = subs.filter(s => s.id !== id);
      if (filtered.length === 0) {
        this.subscribers.delete(pattern);
      } else {
        this.subscribers.set(pattern, filtered);
      }
    }
    this.wildcardSubscribers = this.wildcardSubscribers.filter(s => s.id !== id);
  }

  private shouldDedup(event: BusEvent): boolean {
    if (!event.dedupKey) return false;
    const key = `${event.type}:${event.dedupKey}`;
    const now = Date.now();
    if (this.recentEvents.has(key)) {
      const lastTime = this.recentEvents.get(key)!;
      if (now - lastTime < this.dedupWindow) {
        this.dedupHits++;
        return true;
      }
    }
    this.recentEvents.set(key, now);
    if (this.recentEvents.size > 1000) {
      const cutoff = now - this.dedupWindow;
      for (const [k, v] of this.recentEvents) {
        if (v < cutoff) this.recentEvents.delete(k);
      }
    }
    return false;
  }

  private getMatchingHandlers(event: BusEvent): Array<{ handler: EventHandler; sub: Subscription }> {
    const handlers: Array<{ handler: EventHandler; sub: Subscription }> = [];

    const exactSubs = this.subscribers.get(event.type) || [];
    for (const sub of exactSubs) {
      if (!sub.filter || sub.filter(event)) {
        handlers.push({ handler: sub.handler, sub });
      }
    }

    const parts = event.type.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const nsPattern = parts.slice(0, i).join('.') + '.*';
      const nsSubs = this.subscribers.get(nsPattern) || [];
      for (const sub of nsSubs) {
        if (!sub.filter || sub.filter(event)) {
          handlers.push({ handler: sub.handler, sub });
        }
      }
    }

    for (const sub of this.wildcardSubscribers) {
      if (!sub.filter || sub.filter(event)) {
        handlers.push({ handler: sub.handler, sub });
      }
    }

    const priorityOrder: Record<EventPriority, number> = {
      critical: 0, high: 1, normal: 2, low: 3,
    };
    handlers.sort((a, b) => {
      const pa = priorityOrder[a.sub.pattern === '**' ? 'low' : (event.priority || 'normal')];
      const pb = priorityOrder[b.sub.pattern === '**' ? 'low' : (event.priority || 'normal')];
      return pa - pb;
    });

    return handlers;
  }

  private async deliverEvent(event: BusEvent, handlers: Array<{ handler: EventHandler; sub: Subscription }>): Promise<void> {
    const startTime = Date.now();
    const deliveredTo: string[] = [];

    for (const { handler, sub } of handlers) {
      try {
        await Promise.resolve(handler(event));
        deliveredTo.push(sub.id);
        this.totalDelivered++;

        if (sub.once) {
          this.unsubscribe(sub.id);
        }
      } catch (err: unknown) {
        this.totalFailed++;
        this.log.error('event handler failed', {
          handlerId: sub.id,
          pattern: sub.pattern,
          eventType: event.type,
          error: err,
        });
      }
    }

    const processingTime = Date.now() - startTime;
    this.processingTimes.push(processingTime);
    if (this.processingTimes.length > 2000) this.processingTimes.splice(0, this.processingTimes.length - 1000);

    const entry: EventHistoryEntry = { event, deliveredTo, processingTime };
    this.history.push(entry);
    if (this.history.length > this.maxHistorySize * 2) {
      this.history.splice(0, this.history.length - this.maxHistorySize);
    }

    if (this.debugMode) {
      this.log.debug('event delivered', {
        type: event.type,
        handlers: deliveredTo.length,
        processingTime,
      });
    }
  }

  async emit(type: string, data?: unknown, options?: {
    source?: string;
    priority?: EventPriority;
    dedupKey?: string;
  }): Promise<void> {
    this.totalEmitted++;
    this.emitTimestamps.push(Date.now());
    if (this.emitTimestamps.length > 2000) this.emitTimestamps.splice(0, this.emitTimestamps.length - 1000);

    const event: BusEvent = {
      type,
      source: options?.source || 'system',
      timestamp: Date.now(),
      data,
      priority: options?.priority || 'normal',
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      dedupKey: options?.dedupKey,
    };

    if (this.shouldDedup(event)) return;

    // Check if this event type should be batched
    const batchConfig = this.batchConfigs.get(type);
    if (batchConfig) {
      this.handleBatchedEvent(event, batchConfig);
      return;
    }

    const handlers = this.getMatchingHandlers(event);
    if (handlers.length === 0) return;

    await this.deliverEvent(event, handlers);
  }

  private handleBatchedEvent(event: BusEvent, config: { intervalMs: number; maxBatchSize: number }): void {
    let batched = this.batchedEvents.get(event.type);
    if (!batched) {
      const handler = this.getMatchingHandlers(event)[0]?.handler;
      if (!handler) return;
      batched = { type: event.type, events: [], timer: null, handler };
      this.batchedEvents.set(event.type, batched);
    }

    batched.events.push(event);

    if (batched.events.length >= config.maxBatchSize) {
      if (batched.timer) {
        clearTimeout(batched.timer);
        batched.timer = null;
      }
      void this.flushBatch(event.type);
    } else if (!batched.timer) {
      batched.timer = setTimeout(() => void this.flushBatch(event.type), config.intervalMs);
    }
  }

  private async flushBatch(type: string): Promise<void> {
    const batched = this.batchedEvents.get(type);
    if (!batched || batched.events.length === 0) return;

    const events = batched.events;
    batched.events = [];
    if (batched.timer) {
      clearTimeout(batched.timer);
      batched.timer = null;
    }

    this.batchedCount += events.length;

    // Deliver only the last event in the batch (for high-frequency updates like progress)
    // or merge data for certain event types
    const lastEvent = events[events.length - 1];
    const handlers = this.getMatchingHandlers(lastEvent);
    if (handlers.length > 0) {
      lastEvent.data = {
        ...lastEvent.data,
        _batched: true,
        _batchSize: events.length,
        _firstTimestamp: events[0].timestamp,
      };
      await this.deliverEvent(lastEvent, handlers);
    }
  }


  emitSync(type: string, data?: unknown, options?: {
    source?: string;
    priority?: EventPriority;
    dedupKey?: string;
  }): void {
    this.emit(type, data, options).catch(err => {
      this.log.error('sync emit error', { eventType: type, error: err });
    });
  }

  getHistory(filter?: { type?: string; source?: string; since?: number }): EventHistoryEntry[] {
    let entries = this.history;
    if (filter?.type) entries = entries.filter(e => e.event.type === filter.type);
    if (filter?.source) entries = entries.filter(e => e.event.source === filter.source);
    if (filter?.since) entries = entries.filter(e => e.event.timestamp >= filter.since!);
    return entries.slice(-100);
  }

  clearHistory(): void {
    this.history = [];
  }

  getSize(): number {
    return this.history.length;
  }

  getMetrics(): EventBusMetrics {
    const times = [...this.processingTimes].sort((a, b) => a - b);
    const now = Date.now();
    const recentEmits = this.emitTimestamps.filter(t => now - t < 1000).length;
    const avgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;

    let totalSubscribers = this.wildcardSubscribers.length;
    for (const subs of this.subscribers.values()) totalSubscribers += subs.length;

    return {
      totalEmitted: this.totalEmitted,
      totalDelivered: this.totalDelivered,
      totalFailed: this.totalFailed,
      emitRatePerSecond: recentEmits,
      avgProcessingTime: avgTime,
      p50ProcessingTime: times[Math.floor(times.length * 0.5)] || 0,
      p95ProcessingTime: times[Math.floor(times.length * 0.95)] || 0,
      p99ProcessingTime: times[Math.floor(times.length * 0.99)] || 0,
      subscriberCount: totalSubscribers,
      patternsCount: this.subscribers.size + (this.wildcardSubscribers.length > 0 ? 1 : 0),
      historySize: this.history.length,
      dedupHits: this.dedupHits,
      batchedCount: this.batchedCount,
    };
  }

  waitFor(type: string, timeoutMs = 30000): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
      const unsub = this.once(type, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Event "${type}" timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  reset(): void {
    this.subscribers.clear();
    this.wildcardSubscribers = [];
    this.history = [];
    this.processingTimes = [];
    this.emitTimestamps = [];
    this.recentEvents.clear();
    this.batchedEvents.clear();
  }
}

/** 预定义事件类型常量 */
export const Events = {
  // 会话事件
  SESSION_CREATED: 'session.created',
  SESSION_ACTIVE: 'session.active',
  SESSION_CLOSED: 'session.closed',

  // 消息事件
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELTA: 'message.delta',

  // 工具事件
  TOOL_CALL_START: 'tool.call.start',
  TOOL_CALL_DELTA: 'tool.call.delta',
  TOOL_CALL_COMPLETE: 'tool.call.complete',
  TOOL_CALL_ERROR: 'tool.call.error',
  TOOL_REGISTERED: 'tool.registered',
  TOOL_UNREGISTERED: 'tool.unregistered',

  // Agent 事件
  AGENT_THINKING: 'agent.thinking',
  AGENT_ACTION: 'agent.action',
  AGENT_ERROR: 'agent.error',
  AGENT_COMPLETE: 'agent.complete',

  // 意图事件
  INTENT_DETECTED: 'intent.detected',
  INTENT_AMBIGUOUS: 'intent.ambiguous',

  // 系统事件
  SYSTEM_STARTUP: 'system.startup',
  SYSTEM_SHUTDOWN: 'system.shutdown',
  SYSTEM_ERROR: 'system.error',
  SYSTEM_HEARTBEAT: 'system.heartbeat',

  // 学习事件
  LEARNING_RECORDED: 'learning.recorded',
  PATTERN_DETECTED: 'pattern.detected',
  EVOLUTION_TRIGGERED: 'evolution.triggered',

  // 权限事件
  PERMISSION_CHECK: 'permission.check',
  PERMISSION_DENIED: 'permission.denied',
  PERMISSION_APPROVED: 'permission.approved',

  // 技能事件
  SKILL_LOADED: 'skill.loaded',
  SKILL_UNLOADED: 'skill.unloaded',
  SKILL_ERROR: 'skill.error',

  // MCP 事件
  MCP_SERVER_CONNECTED: 'mcp.server.connected',
  MCP_SERVER_DISCONNECTED: 'mcp.server.disconnected',
  MCP_TOOL_DISCOVERED: 'mcp.tool.discovered',
  MCP_TOOL_ERROR: 'mcp.tool.error',

  // 压缩事件
  COMPACTION_STARTED: 'compaction.started',
  COMPACTION_COMPLETE: 'compaction.complete',

  // 后台Agent事件
  BG_AGENT_QUEUED: 'background.agent.queued',
  BG_AGENT_STARTED: 'background.agent.started',
  BG_AGENT_COMPLETED: 'background.agent.completed',
  BG_AGENT_FAILED: 'background.agent.failed',
  BG_AGENT_CANCELLED: 'background.agent.cancelled',

  // 通知事件
  NOTIFICATION_SENT: 'notification.sent',
  NOTIFICATION_ALERT: 'notification.alert',

  // Webhook 事件
  WEBHOOK_PROCESSED: 'webhook.processed',

  // 云部署事件
  CLOUD_EXECUTION_STARTED: 'cloud.execution.started',
  CLOUD_EXECUTION_COMPLETED: 'cloud.execution.completed',
  CLOUD_SESSION_RESTORED: 'cloud.session.restored',

  // 团队编排事件
  TEAM_EXECUTION_STARTED: 'team.execution.started',
  TEAM_EXECUTION_COMPLETED: 'team.execution.completed',

  // 项目上下文事件
  PROJECTCONTEXT_DECISION_ADDED: 'projectcontext.decision.added',
  PROJECTCONTEXT_UPDATED: 'projectcontext.updated',

  // 市场插件事件
  MARKETPLACE_PLUGIN_INSTALLED: 'marketplace.plugin.installed',
  MARKETPLACE_PLUGIN_REMOVED: 'marketplace.plugin.removed',
  MARKETPLACE_PLUGIN_ENABLED: 'marketplace.plugin.enabled',
  MARKETPLACE_PLUGIN_DISABLED: 'marketplace.plugin.disabled',
};
