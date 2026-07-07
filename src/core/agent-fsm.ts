/**
 * Agent 有限状态机 — AgentFSM
 *
 * Agent Loop 的核心状态管理，确保状态转换合法、可追踪、可观测：
 * - 严格的状态转换校验：仅允许预定义的合法转换
 * - 事件驱动：状态变更自动通知订阅者
 * - 外部控制：支持 pause / resume 暂停恢复
 * - 异步等待：waitForStatus 可等待特定状态到达
 * - 完整审计：每次转换记录 from → to 及附带数据
 */

import { logger } from './structured-logger.js';

// ============ 状态枚举 ============

/** Agent 运行状态 */
export enum AgentStatus {
  /** 空闲，等待任务 */
  IDLE = 'IDLE',
  /** 思考中，LLM 推理阶段 */
  THINKING = 'THINKING',
  /** 执行中，工具调用阶段 */
  EXECUTING = 'EXECUTING',
  /** 等待人工审批 */
  WAITING_HUMAN = 'WAITING_HUMAN',
  /** 已暂停 */
  PAUSED = 'PAUSED',
  /** 任务完成 */
  COMPLETED = 'COMPLETED',
  /** 错误状态 */
  ERROR = 'ERROR',
}

// ============ 事件类型 ============

/** FSM 事件类型 */
export type AgentEventType =
  | 'STATE_CHANGE'
  | 'AWAIT_APPROVAL'
  | 'TOOL_START'
  | 'DONE'
  | 'SYSTEM'
  | 'MULTIMODAL_INPUT'   // 多模态输入感知（图片/音频/视频）
  | 'MULTIMODAL_OUTPUT'; // 多模态输出生成（语音/图像/视频）

/** FSM 事件 */
export interface AgentEvent {
  /** 事件类型 */
  type: AgentEventType;
  /** 源状态 */
  fromStatus: AgentStatus;
  /** 目标状态 */
  toStatus: AgentStatus;
  /** 附带数据（错误信息、工具名等） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  /** 事件时间戳 */
  timestamp: number;
}

// ============ 转换规则 ============

/**
 * 合法状态转换映射表
 * key: 源状态, value: 允许转换到的目标状态集合
 */
const VALID_TRANSITIONS: ReadonlyMap<AgentStatus, ReadonlySet<AgentStatus>> = new Map([
  // IDLE → THINKING：开始新任务
  [AgentStatus.IDLE, new Set<AgentStatus>([AgentStatus.THINKING])],
  // THINKING → EXECUTING / COMPLETED / ERROR
  [AgentStatus.THINKING, new Set<AgentStatus>([AgentStatus.EXECUTING, AgentStatus.COMPLETED, AgentStatus.ERROR])],
  // EXECUTING → WAITING_HUMAN / THINKING / ERROR
  [AgentStatus.EXECUTING, new Set<AgentStatus>([AgentStatus.WAITING_HUMAN, AgentStatus.THINKING, AgentStatus.ERROR])],
  // WAITING_HUMAN → EXECUTING（批准）/ THINKING（拒绝）
  [AgentStatus.WAITING_HUMAN, new Set<AgentStatus>([AgentStatus.EXECUTING, AgentStatus.THINKING])],
  // PAUSED → THINKING / EXECUTING / WAITING_HUMAN：恢复执行（恢复到暂停前的状态）
  [AgentStatus.PAUSED, new Set<AgentStatus>([AgentStatus.THINKING, AgentStatus.EXECUTING, AgentStatus.WAITING_HUMAN])],
  // 终态：不可再转换
  [AgentStatus.COMPLETED, new Set<AgentStatus>()],
  [AgentStatus.ERROR, new Set<AgentStatus>()],
]);

/** 全局可转换状态：任意状态均可转向 PAUSED / ERROR / COMPLETED */
const GLOBAL_TARGETS = new Set([AgentStatus.PAUSED, AgentStatus.ERROR, AgentStatus.COMPLETED]);

/** 多模态上下文 — 追踪当前多模态任务类型和模态 */
export interface MultimodalContext {
  /** 模态类型 */
  modality: 'image' | 'audio' | 'video' | 'screen' | 'mixed';
  /** 方向：输入感知 / 输出生成 */
  direction: 'input' | 'output';
  /** 关联的工具名（如 voice_speak, image_generate, screen_capture） */
  toolName?: string;
  /** 资源标识（文件路径/data URL/URL） */
  resourceRef?: string;
}

// ============ 回调类型 ============

/** 状态转换回调 */
export type TransitionCallback = (from: AgentStatus, to: AgentStatus, event: AgentEvent) => void;

// ============ AgentFSM 主类 ============

export class AgentFSM {
  private status: AgentStatus = AgentStatus.IDLE;
  private callbacks: TransitionCallback[] = [];
  private statusResolvers: Map<AgentStatus, Array<() => void>> = new Map();
  private previousStatus: AgentStatus | null = null;
  /** 暂停前保存的状态，用于 resume 恢复 */
  private statusBeforePause: AgentStatus | null = null;
  private eventLog: AgentEvent[] = [];
  private maxEventLog = 200;
  /** P0 多模态集成：当前多模态上下文（感知/生成） */
  private multimodalCtx: MultimodalContext | null = null;
  /** 多模态任务历史（最近 N 个） */
  private multimodalHistory: Array<MultimodalContext & { timestamp: number }> = [];
  private maxMultimodalHistory = 50;
  private log = logger.child({ module: 'AgentFSM' });

  /** 获取当前状态 */
  getStatus(): AgentStatus {
    return this.status;
  }

  /** 获取上一个状态（转换前） */
  getPreviousStatus(): AgentStatus | null {
    return this.previousStatus;
  }

  /** 判断从当前状态是否可转换到目标状态 */
  canTransition(to: AgentStatus): boolean {
    return this.isValidTransition(this.status, to);
  }

  /**
   * 执行状态转换
   * @throws Error 如果转换不合法
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transition(to: AgentStatus, data?: any): void {
    if (!this.canTransition(to)) {
      const msg = `非法状态转换: ${this.status} → ${to}`;
      this.log.error(msg, { from: this.status, to, data });
      throw new Error(msg);
    }

    const from = this.status;
    this.previousStatus = from;
    this.status = to;

    // 暂停时记录前一个状态
    if (to === AgentStatus.PAUSED) {
      this.statusBeforePause = from;
    }

    // 构造事件
    const event = this.buildEvent(from, to, data);
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxEventLog) {
      this.eventLog.shift();
    }

    this.log.info('状态转换', { from, to, eventType: event.type });

    // 通知订阅者
    for (const cb of this.callbacks) {
      try {
        cb(from, to, event);
      } catch (err) {
        this.log.error('转换回调异常', { from, to, error: err });
      }
    }

    // 唤醒等待该状态的 Promise
    this.resolveWaiters(to);
  }

  /** 订阅状态转换事件，返回取消订阅函数 */
  onTransition(callback: TransitionCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx !== -1) this.callbacks.splice(idx, 1);
    };
  }

  /** 外部暂停：从任意状态转入 PAUSED */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pause(data?: any): void {
    if (this.status === AgentStatus.PAUSED) return;
    this.transition(AgentStatus.PAUSED, data);
  }

  /** 恢复执行：从 PAUSED 恢复到暂停前的状态（默认 THINKING） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resume(data?: any): void {
    if (this.status !== AgentStatus.PAUSED) {
      throw new Error(`resume 只能在 PAUSED 状态调用，当前状态: ${this.status}`);
    }
    const target = this.statusBeforePause === AgentStatus.IDLE
      ? AgentStatus.THINKING
      : (this.statusBeforePause ?? AgentStatus.THINKING);
    this.statusBeforePause = null;
    this.transition(target, data);
  }

  /**
   * 异步等待特定状态
   * 如果当前已经是目标状态则立即 resolve，否则等待转换到达
   */
  waitForStatus(status: AgentStatus, timeoutMs = 60000): Promise<void> {
    if (this.status === status) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后移除 resolver
        const arr = this.statusResolvers.get(status);
        if (arr) {
          const idx = arr.indexOf(resolve);
          if (idx !== -1) arr.splice(idx, 1);
        }
        reject(new Error(`waitForStatus(${status}) 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      const arr = this.statusResolvers.get(status) || [];
      arr.push(wrappedResolve);
      this.statusResolvers.set(status, arr);
    });
  }

  /** 获取事件日志 */
  getEventLog(): AgentEvent[] {
    return [...this.eventLog];
  }

  /** 重置 FSM 到初始状态 */
  reset(): void {
    this.status = AgentStatus.IDLE;
    this.previousStatus = null;
    this.statusBeforePause = null;
    this.eventLog = [];
    this.statusResolvers.clear();
    this.multimodalCtx = null;
    this.multimodalHistory = [];
  }

  // ============ P0 多模态集成 ============

  /**
   * 标记开始多模态感知/生成任务
   *
   * 在工具执行前调用，使 FSM 感知当前正在处理多模态任务。
   * 这不改变状态机的 status（仍为 EXECUTING），而是为事件添加多模态上下文。
   */
  beginMultimodalTask(ctx: MultimodalContext): void {
    this.multimodalCtx = ctx;
    this.log.info('多模态任务开始', {
      modality: ctx.modality,
      direction: ctx.direction,
      tool: ctx.toolName,
    });
  }

  /** 标记多模态任务结束（记录到历史） */
  endMultimodalTask(): void {
    if (this.multimodalCtx) {
      this.multimodalHistory.push({
        ...this.multimodalCtx,
        timestamp: Date.now(),
      });
      if (this.multimodalHistory.length > this.maxMultimodalHistory) {
        this.multimodalHistory.shift();
      }
      this.log.info('多模态任务结束', {
        modality: this.multimodalCtx.modality,
        direction: this.multimodalCtx.direction,
      });
      this.multimodalCtx = null;
    }
  }

  /** 获取当前进行中的多模态上下文（无则 null） */
  getCurrentMultimodalContext(): MultimodalContext | null {
    return this.multimodalCtx;
  }

  /** 是否正在处理多模态任务 */
  isMultimodalActive(): boolean {
    return this.multimodalCtx !== null;
  }

  /** 获取多模态任务历史 */
  getMultimodalHistory(): Array<MultimodalContext & { timestamp: number }> {
    return [...this.multimodalHistory];
  }

  // ---- 内部方法 ----

  /** 校验状态转换是否合法 */
  private isValidTransition(from: AgentStatus, to: AgentStatus): boolean {
    if (from === to) return false;
    // 全局目标：任意状态均可转向
    if (GLOBAL_TARGETS.has(to)) return true;
    // 查表
    const allowed = VALID_TRANSITIONS.get(from);
    return allowed ? allowed.has(to) : false;
  }

  /** 构造 FSM 事件 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildEvent(from: AgentStatus, to: AgentStatus, data?: any): AgentEvent {
    return {
      type: this.inferEventType(from, to),
      fromStatus: from,
      toStatus: to,
      data,
      timestamp: Date.now(),
    };
  }

  /** 根据转换方向推断事件类型 */
  private inferEventType(from: AgentStatus, to: AgentStatus): AgentEventType {
    if (to === AgentStatus.WAITING_HUMAN) return 'AWAIT_APPROVAL';
    if (to === AgentStatus.EXECUTING && from === AgentStatus.THINKING) {
      // 多模态任务时返回多模态事件类型
      if (this.multimodalCtx) {
        return this.multimodalCtx.direction === 'input' ? 'MULTIMODAL_INPUT' : 'MULTIMODAL_OUTPUT';
      }
      return 'TOOL_START';
    }
    if (to === AgentStatus.COMPLETED) return 'DONE';
    if (to === AgentStatus.PAUSED || to === AgentStatus.ERROR) return 'SYSTEM';
    return 'STATE_CHANGE';
  }

  /** 唤醒等待特定状态的 Promise */
  private resolveWaiters(status: AgentStatus): void {
    const resolvers = this.statusResolvers.get(status);
    if (!resolvers) return;
    for (const resolve of resolvers) {
      resolve();
    }
    this.statusResolvers.delete(status);
  }
}
