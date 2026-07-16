/**
 * BackgroundAgentManager — 后台Agent管理系统
 *
 * 支持优先级队列、异步执行、持久化、EventBus通知。
 * Agent在后台独立运行，不阻塞主Agent循环，完成后可通过工具检索结果。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { AgentRunner } from './sub-agent-orchestrator.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface BackgroundAgentConfig {
  name: string;
  goal: string;
  context?: string;
  priority?: 'high' | 'normal' | 'low';
  tokenBudget?: number;
  maxTurns?: number;
  createdBy?: string;
}

export type BackgroundAgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundAgentRecord {
  id: string;
  name: string;
  goal: string;
  context?: string;
  priority: 'high' | 'normal' | 'low';
  tokenBudget: number;
  maxTurns: number;
  status: BackgroundAgentStatus;
  result?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  turnCount: number;
  createdBy?: string;
}

export interface BackgroundAgentSummary {
  id: string;
  name: string;
  status: BackgroundAgentStatus;
  priority: string;
  goal: string;
  createdAt: number;
  duration?: number;
}

// ============ 优先级权重 ============

const PRIORITY_WEIGHT: Record<string, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

// ============ 主类 ============

export class BackgroundAgentManager {
  private agents: Map<string, BackgroundAgentRecord> = new Map();
  private queue: string[] = [];
  private runningCount = 0;
  private maxConcurrent: number;
  private persistDir: string;
  private persistPath: string;
  private agentRunner: AgentRunner | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private log = logger.child({ module: 'BackgroundAgentManager' });
  private eventBus: EventBus;

  /** 懒加载标记 */
  private stateLoaded = false;

  constructor(
    persistDir?: string,
    maxConcurrent: number = 2,
  ) {
    this.persistDir = persistDir || duanPath('background');
    this.persistPath = path.join(this.persistDir, 'agents.json');
    this.maxConcurrent = maxConcurrent;
    this.eventBus = EventBus.getInstance();
    // 不在构造函数中执行同步 I/O，延迟到首次访问
  }

  /** 懒加载：首次访问数据时才从磁盘加载 */
  private ensureStateLoaded(): void {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    this.ensureDir();
    this.loadFromDisk();
  }

  /** 注入 Agent Runner */
  setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
  }

  /** 设置最大并发数 */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  // ============ 公共方法 ============

  /** 创建一个后台Agent（加入队列） */
  spawn(config: BackgroundAgentConfig): Promise<string> {
    this.ensureStateLoaded();
    const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: BackgroundAgentRecord = {
      id,
      name: config.name,
      goal: config.goal,
      context: config.context,
      priority: config.priority || 'normal',
      tokenBudget: config.tokenBudget || 20000,
      maxTurns: config.maxTurns || 50,
      status: 'queued',
      createdAt: Date.now(),
      turnCount: 0,
      createdBy: config.createdBy,
    };

    this.agents.set(id, record);
    this.insertIntoQueue(id);
    this.markDirty();

    this.log.info('后台Agent已排队', { id, name: config.name, priority: config.priority });
    this.eventBus.emitSync('background.agent.queued', {
      agentId: id, name: config.name, goal: config.goal, priority: config.priority,
    }, { source: 'BackgroundAgentManager' });

    void this.processQueue();
    return Promise.resolve(id);
  }

  /** 获取单个Agent记录 */
  get(id: string): BackgroundAgentRecord | undefined {
    this.ensureStateLoaded();
    return this.agents.get(id);
  }

  /** 获取所有Agent */
  getAll(): BackgroundAgentRecord[] {
    this.ensureStateLoaded();
    return Array.from(this.agents.values());
  }

  /** 获取Agent摘要列表（按创建时间倒序） */
  getSummaries(): BackgroundAgentSummary[] {
    return this.getAll()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        priority: a.priority,
        goal: a.goal.length > 80 ? a.goal.slice(0, 80) + '...' : a.goal,
        createdAt: a.createdAt,
        duration: a.completedAt && a.startedAt ? a.completedAt - a.startedAt : undefined,
      }));
  }

  /** 获取特定状态的Agent */
  getByStatus(status: BackgroundAgentStatus): BackgroundAgentRecord[] {
    return this.getAll().filter(a => a.status === status);
  }

  /** 取消一个正在排队或运行的Agent */
  cancel(id: string): boolean {
    this.ensureStateLoaded();
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.status === 'completed' || agent.status === 'cancelled') return false;

    agent.status = 'cancelled';
    agent.completedAt = Date.now();
    this.queue = this.queue.filter(qid => qid !== id);
    this.markDirty();

    this.eventBus.emitSync('background.agent.cancelled', {
      agentId: id, name: agent.name,
    }, { source: 'BackgroundAgentManager' });

    return true;
  }

  /** 等待特定Agent完成 */
  async waitFor(id: string, timeoutMs: number = 120000): Promise<BackgroundAgentRecord | null> {
    this.ensureStateLoaded();
    const agent = this.agents.get(id);
    if (!agent) return null;
    if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
      return agent;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = this.agents.get(id);
      if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled')) {
        return current;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return this.agents.get(id) || null;
  }

  /** 获取队列统计 */
  getStats(): { total: number; queued: number; running: number; completed: number; failed: number; cancelled: number } {
    const all = this.getAll();
    return {
      total: all.length,
      queued: all.filter(a => a.status === 'queued').length,
      running: all.filter(a => a.status === 'running').length,
      completed: all.filter(a => a.status === 'completed').length,
      failed: all.filter(a => a.status === 'failed').length,
      cancelled: all.filter(a => a.status === 'cancelled').length,
    };
  }

  /** 清理旧记录（保留最近N条） */
  cleanup(keepCount: number = 100): number {
    const all = this.getAll().sort((a, b) => b.createdAt - a.createdAt);
    if (all.length <= keepCount) return 0;
    const toRemove = all.slice(keepCount);
    for (const agent of toRemove) {
      if (agent.status === 'running') continue;
      this.agents.delete(agent.id);
    }
    this.queue = this.queue.filter(id => this.agents.has(id));
    this.markDirty();
    return toRemove.length;
  }

  // ============ 内部方法 ============

  private insertIntoQueue(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;

    const weight = PRIORITY_WEIGHT[agent.priority] || PRIORITY_WEIGHT.normal;

    // 按优先级插入（高优先级在前，同优先级按FIFO）
    let insertIdx = this.queue.length;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const existing = this.agents.get(this.queue[i]);
      const existingWeight = existing ? (PRIORITY_WEIGHT[existing.priority] || PRIORITY_WEIGHT.normal) : 0;
      if (existingWeight < weight) {
        insertIdx = i;
      } else {
        break;
      }
    }
    this.queue.splice(insertIdx, 0, id);
  }

  private processQueue(): Promise<void> {
    if (!this.agentRunner) return Promise.resolve();

    while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;

      const agent = this.agents.get(id);
      if (!agent || agent.status === 'cancelled') continue;

      this.runningCount++;
      agent.status = 'running';
      agent.startedAt = Date.now();
      this.markDirty();

      this.eventBus.emitSync('background.agent.started', {
        agentId: id, name: agent.name,
      }, { source: 'BackgroundAgentManager' });

      void this.executeAgent(agent).finally(() => {
        this.runningCount--;
        void this.processQueue();
      });
    }
    return Promise.resolve();
  }

  private async executeAgent(agent: BackgroundAgentRecord): Promise<void> {
    const runner = this.agentRunner;
    if (!runner) {
      agent.status = 'failed';
      agent.error = 'Agent Runner 未注入';
      agent.completedAt = Date.now();
      this.markDirty();
      return;
    }

    const contextMessages = agent.context
      ? [{ role: 'user' as const, content: agent.context }]
      : [];

    const systemPrompt = `你是后台Agent "${agent.name}"，以静默模式在后台运行。
你的任务: ${agent.goal}
请专注于完成这个任务。
完成后给出简洁清晰的结果总结。`;

    const generator = runner(agent.goal, contextMessages, {
      tokenBudget: agent.tokenBudget,
      customSystemPrompt: systemPrompt,
    });

    try {
      for await (const event of generator) {
        if (event.type === 'tool_call') {
          agent.turnCount++;
        }
      }
      agent.status = 'completed';
      agent.completedAt = Date.now();
      this.eventBus.emitSync('background.agent.completed', {
        agentId: agent.id, name: agent.name, goal: agent.goal,
        turnCount: agent.turnCount,
        duration: agent.completedAt - (agent.startedAt || agent.createdAt),
      }, { source: 'BackgroundAgentManager' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      agent.status = 'failed';
      agent.error = msg;
      agent.completedAt = Date.now();
      this.eventBus.emitSync('background.agent.failed', {
        agentId: agent.id, name: agent.name, error: msg,
      }, { source: 'BackgroundAgentManager' });
    }

    this.markDirty();
  }

  // ============ 持久化 ============

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
    } catch { /* ignore */ }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data: { agents: BackgroundAgentRecord[]; queue: string[] } = JSON.parse(raw);
      if (data.agents) {
        for (const agent of data.agents) {
          this.agents.set(agent.id, agent);
        }
      }
      if (data.queue) {
        this.queue = data.queue.filter(id => this.agents.has(id));
      }

      // 恢复运行时对正在运行的Agent标记为failed
      for (const agent of this.agents.values()) {
        if (agent.status === 'running') {
          agent.status = 'failed';
          agent.error = '进程重启导致运行中断';
          agent.completedAt = Date.now();
        }
      }

      this.log.info(`已恢复 ${this.agents.size} 个后台Agent记录`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('加载后台Agent持久化数据失败', { error: msg });
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => this.flush(), 2000);
      if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
    }
  }

  private flush(): void {
    this.persistTimer = null;
    if (!this.dirty) return;
    this.dirty = false;

    try {
      this.ensureDir();
      const data = {
        agents: Array.from(this.agents.values()),
        queue: this.queue,
        savedAt: Date.now(),
      };
      atomicWriteJsonSync(this.persistPath, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('持久化后台Agent状态失败', { error: msg });
    }
  }

  /**
   * 释放资源 — 清理 persistTimer 并强制落盘 pending 数据。
   *
   * 修复背景：原先 BackgroundAgentManager 在 markDirty() 中启动 setTimeout
   * 但无 dispose，进程退出后 pending 写入丢失，定时器回调可能命中已销毁实例。
   * bootstrap.ts 的 dispose 链此前遗漏本类，现统一补齐。
   */
  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // 强制同步落盘，避免丢失 pending 状态
    if (this.dirty) {
      this.dirty = false;
      try {
        this.ensureDir();
        const data = {
          agents: Array.from(this.agents.values()),
          queue: this.queue,
          savedAt: Date.now(),
        };
        atomicWriteJsonSync(this.persistPath, data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('dispose 时持久化失败', { error: msg });
      }
    }
  }
}
