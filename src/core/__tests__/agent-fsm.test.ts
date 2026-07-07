import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentFSM, AgentStatus } from '../agent-fsm.js';

/** 辅助：创建一个处于指定状态的 FSM */
function createFsmAt(status: AgentStatus): AgentFSM {
  const fsm = new AgentFSM();
  switch (status) {
    case AgentStatus.IDLE:
      return fsm;
    case AgentStatus.THINKING:
      fsm.transition(AgentStatus.THINKING);
      return fsm;
    case AgentStatus.EXECUTING:
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      return fsm;
    case AgentStatus.WAITING_HUMAN:
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.transition(AgentStatus.WAITING_HUMAN);
      return fsm;
    case AgentStatus.PAUSED:
      fsm.transition(AgentStatus.PAUSED);
      return fsm;
    case AgentStatus.COMPLETED:
      fsm.transition(AgentStatus.COMPLETED);
      return fsm;
    case AgentStatus.ERROR:
      fsm.transition(AgentStatus.ERROR);
      return fsm;
    default:
      return fsm;
  }
}

describe('AgentFSM', () => {
  let fsm: AgentFSM;

  beforeEach(() => {
    fsm = new AgentFSM();
  });

  // ============ 初始状态 ============

  describe('初始状态', () => {
    it('初始状态为 IDLE', () => {
      expect(fsm.getStatus()).toBe(AgentStatus.IDLE);
    });

    it('初始 previousStatus 为 null', () => {
      expect(fsm.getPreviousStatus()).toBeNull();
    });

    it('初始事件日志为空', () => {
      expect(fsm.getEventLog()).toEqual([]);
    });
  });

  // ============ 合法状态转换 ============

  describe('合法状态转换', () => {
    // 包含表内转换 + 全局目标（PAUSED / ERROR / COMPLETED）
    const validTransitions: Array<[AgentStatus, AgentStatus]> = [
      // IDLE →
      [AgentStatus.IDLE, AgentStatus.THINKING],
      [AgentStatus.IDLE, AgentStatus.PAUSED],
      [AgentStatus.IDLE, AgentStatus.COMPLETED],
      [AgentStatus.IDLE, AgentStatus.ERROR],
      // THINKING →
      [AgentStatus.THINKING, AgentStatus.EXECUTING],
      [AgentStatus.THINKING, AgentStatus.COMPLETED],
      [AgentStatus.THINKING, AgentStatus.ERROR],
      [AgentStatus.THINKING, AgentStatus.PAUSED],
      // EXECUTING →
      [AgentStatus.EXECUTING, AgentStatus.WAITING_HUMAN],
      [AgentStatus.EXECUTING, AgentStatus.THINKING],
      [AgentStatus.EXECUTING, AgentStatus.ERROR],
      [AgentStatus.EXECUTING, AgentStatus.PAUSED],
      [AgentStatus.EXECUTING, AgentStatus.COMPLETED],
      // WAITING_HUMAN →
      [AgentStatus.WAITING_HUMAN, AgentStatus.EXECUTING],
      [AgentStatus.WAITING_HUMAN, AgentStatus.THINKING],
      [AgentStatus.WAITING_HUMAN, AgentStatus.PAUSED],
      [AgentStatus.WAITING_HUMAN, AgentStatus.COMPLETED],
      [AgentStatus.WAITING_HUMAN, AgentStatus.ERROR],
      // PAUSED → THINKING / EXECUTING / WAITING_HUMAN：恢复到暂停前状态
      [AgentStatus.PAUSED, AgentStatus.THINKING],
      [AgentStatus.PAUSED, AgentStatus.EXECUTING],
      [AgentStatus.PAUSED, AgentStatus.WAITING_HUMAN],
      [AgentStatus.PAUSED, AgentStatus.COMPLETED],
      [AgentStatus.PAUSED, AgentStatus.ERROR],
      // COMPLETED → 全局目标仍可转换
      [AgentStatus.COMPLETED, AgentStatus.PAUSED],
      [AgentStatus.COMPLETED, AgentStatus.ERROR],
      // ERROR → 全局目标仍可转换
      [AgentStatus.ERROR, AgentStatus.PAUSED],
      [AgentStatus.ERROR, AgentStatus.COMPLETED],
    ];

    it.each(validTransitions)('%s → %s 应成功', (from, to) => {
      const f = createFsmAt(from);
      f.transition(to);
      expect(f.getStatus()).toBe(to);
      expect(f.getPreviousStatus()).toBe(from);
    });
  });

  // ============ 非法状态转换 ============

  describe('非法状态转换', () => {
    const invalidTransitions: Array<[AgentStatus, AgentStatus]> = [
      // IDLE →
      [AgentStatus.IDLE, AgentStatus.EXECUTING],
      [AgentStatus.IDLE, AgentStatus.WAITING_HUMAN],
      // THINKING →
      [AgentStatus.THINKING, AgentStatus.IDLE],
      [AgentStatus.THINKING, AgentStatus.WAITING_HUMAN],
      // EXECUTING →
      [AgentStatus.EXECUTING, AgentStatus.IDLE],
      // WAITING_HUMAN →
      [AgentStatus.WAITING_HUMAN, AgentStatus.IDLE],
      // PAUSED →
      [AgentStatus.PAUSED, AgentStatus.IDLE],
      // PAUSED → EXECUTING / WAITING_HUMAN 合法（resume 恢复到暂停前状态）
      // COMPLETED → 终态，仅全局目标可转
      [AgentStatus.COMPLETED, AgentStatus.IDLE],
      [AgentStatus.COMPLETED, AgentStatus.THINKING],
      [AgentStatus.COMPLETED, AgentStatus.EXECUTING],
      [AgentStatus.COMPLETED, AgentStatus.WAITING_HUMAN],
      // ERROR → 终态，仅全局目标可转
      [AgentStatus.ERROR, AgentStatus.IDLE],
      [AgentStatus.ERROR, AgentStatus.THINKING],
      [AgentStatus.ERROR, AgentStatus.EXECUTING],
      [AgentStatus.ERROR, AgentStatus.WAITING_HUMAN],
    ];

    it.each(invalidTransitions)('%s → %s 应抛出错误', (from, to) => {
      const f = createFsmAt(from);
      expect(() => f.transition(to)).toThrow(/非法状态转换/);
      // 状态未改变
      expect(f.getStatus()).toBe(from);
    });

    it.each(Object.values(AgentStatus) as AgentStatus[])(
      '相同状态 %s → %s 应抛出错误',
      (status) => {
        const f = createFsmAt(status);
        expect(() => f.transition(status)).toThrow(/非法状态转换/);
        expect(f.getStatus()).toBe(status);
      },
    );

    it('非法转换不记录事件日志', () => {
      fsm.transition(AgentStatus.THINKING);
      const logLen = fsm.getEventLog().length;
      expect(() => fsm.transition(AgentStatus.WAITING_HUMAN)).toThrow();
      expect(fsm.getEventLog().length).toBe(logLen);
    });

    it('非法转换不通知订阅者', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      expect(() => fsm.transition(AgentStatus.EXECUTING)).toThrow();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ============ canTransition ============

  describe('canTransition', () => {
    it('合法转换返回 true', () => {
      expect(fsm.canTransition(AgentStatus.THINKING)).toBe(true);
      expect(fsm.canTransition(AgentStatus.PAUSED)).toBe(true);
      expect(fsm.canTransition(AgentStatus.COMPLETED)).toBe(true);
      expect(fsm.canTransition(AgentStatus.ERROR)).toBe(true);
    });

    it('非法转换返回 false', () => {
      expect(fsm.canTransition(AgentStatus.EXECUTING)).toBe(false);
      expect(fsm.canTransition(AgentStatus.WAITING_HUMAN)).toBe(false);
    });

    it('相同状态返回 false', () => {
      expect(fsm.canTransition(AgentStatus.IDLE)).toBe(false);
    });

    it('canTransition 不改变状态', () => {
      fsm.canTransition(AgentStatus.THINKING);
      expect(fsm.getStatus()).toBe(AgentStatus.IDLE);
      expect(fsm.getEventLog()).toHaveLength(0);
    });

    it('不同源状态下的 canTransition 判断', () => {
      // THINKING 状态
      fsm.transition(AgentStatus.THINKING);
      expect(fsm.canTransition(AgentStatus.EXECUTING)).toBe(true);
      expect(fsm.canTransition(AgentStatus.IDLE)).toBe(false);

      // EXECUTING 状态
      fsm.transition(AgentStatus.EXECUTING);
      expect(fsm.canTransition(AgentStatus.WAITING_HUMAN)).toBe(true);
      expect(fsm.canTransition(AgentStatus.THINKING)).toBe(true);
      expect(fsm.canTransition(AgentStatus.IDLE)).toBe(false);
    });
  });

  // ============ 事件订阅 / 通知 ============

  describe('事件订阅 / 通知', () => {
    it('转换时通知订阅者', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        AgentStatus.IDLE,
        AgentStatus.THINKING,
        expect.objectContaining({
          type: 'STATE_CHANGE',
          fromStatus: AgentStatus.IDLE,
          toStatus: AgentStatus.THINKING,
        }),
      );
    });

    it('事件包含 timestamp', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      const before = Date.now();
      fsm.transition(AgentStatus.THINKING);
      const event = cb.mock.calls[0][2];
      expect(event.timestamp).toBeTypeOf('number');
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('data 透传到事件', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING, { reason: 'start', taskId: 42 });
      const event = cb.mock.calls[0][2];
      expect(event.data).toEqual({ reason: 'start', taskId: 42 });
    });

    it('未传 data 时事件 data 为 undefined', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      expect(cb.mock.calls[0][2].data).toBeUndefined();
    });

    it('多个订阅者都被通知', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      fsm.onTransition(cb1);
      fsm.onTransition(cb2);
      fsm.transition(AgentStatus.THINKING);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('订阅者抛出异常不影响其他订阅者', () => {
      const cb1 = vi.fn(() => {
        throw new Error('cb1 error');
      });
      const cb2 = vi.fn();
      fsm.onTransition(cb1);
      fsm.onTransition(cb2);
      expect(() => fsm.transition(AgentStatus.THINKING)).not.toThrow();
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('取消订阅后不再接收事件', () => {
      const cb = vi.fn();
      const unsub = fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      expect(cb).toHaveBeenCalledTimes(1);
      unsub();
      fsm.transition(AgentStatus.EXECUTING);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('取消订阅函数可安全重复调用', () => {
      const cb = vi.fn();
      const unsub = fsm.onTransition(cb);
      unsub();
      expect(() => unsub()).not.toThrow();
      fsm.transition(AgentStatus.THINKING);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ============ pause / resume ============

  describe('pause / resume', () => {
    it('pause 从 IDLE 进入 PAUSED', () => {
      fsm.pause();
      expect(fsm.getStatus()).toBe(AgentStatus.PAUSED);
      expect(fsm.getPreviousStatus()).toBe(AgentStatus.IDLE);
    });

    it('pause 已是 PAUSED 时为空操作', () => {
      fsm.pause();
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.pause();
      expect(fsm.getStatus()).toBe(AgentStatus.PAUSED);
      expect(cb).not.toHaveBeenCalled();
    });

    it('pause 携带 data', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.pause({ reason: 'user' });
      expect(cb.mock.calls[0][2].data).toEqual({ reason: 'user' });
    });

    it('pause 从任意运行状态进入 PAUSED', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.pause();
      expect(fsm.getStatus()).toBe(AgentStatus.PAUSED);
      expect(fsm.getPreviousStatus()).toBe(AgentStatus.EXECUTING);
    });

    it('resume 非 PAUSED 状态抛出错误', () => {
      expect(() => fsm.resume()).toThrow(/resume 只能在 PAUSED 状态调用/);
      fsm.transition(AgentStatus.THINKING);
      expect(() => fsm.resume()).toThrow(/resume 只能在 PAUSED 状态调用/);
    });

    it('resume 从 PAUSED 恢复到暂停前状态（THINKING）', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.pause();
      fsm.resume();
      expect(fsm.getStatus()).toBe(AgentStatus.THINKING);
    });

    it('resume 恢复到 EXECUTING（PAUSED 允许恢复到暂停前状态）', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.pause();
      // PAUSED → EXECUTING 合法（resume 恢复到暂停前状态）
      fsm.resume();
      expect(fsm.getStatus()).toBe(AgentStatus.EXECUTING);
    });

    it('resume 恢复到 WAITING_HUMAN（PAUSED 允许恢复到暂停前状态）', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.transition(AgentStatus.WAITING_HUMAN);
      fsm.pause();
      // PAUSED → WAITING_HUMAN 合法（resume 恢复到暂停前状态）
      fsm.resume();
      expect(fsm.getStatus()).toBe(AgentStatus.WAITING_HUMAN);
    });

    it('从 IDLE 暂停后 resume 恢复到 THINKING', () => {
      fsm.pause(); // IDLE → PAUSED
      fsm.resume();
      expect(fsm.getStatus()).toBe(AgentStatus.THINKING);
    });

    it('resume 携带 data', () => {
      const cb = vi.fn();
      fsm.transition(AgentStatus.THINKING);
      fsm.pause();
      fsm.onTransition(cb);
      fsm.resume({ resumed: true });
      expect(cb.mock.calls[0][2].data).toEqual({ resumed: true });
    });

    it('resume 后再次 pause 恢复正确状态', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.pause();
      fsm.resume();
      expect(fsm.getStatus()).toBe(AgentStatus.THINKING);
      fsm.pause();
      fsm.resume();
      expect(fsm.getStatus()).toBe(AgentStatus.THINKING);
    });
  });

  // ============ waitForStatus ============

  describe('waitForStatus', () => {
    it('当前已是目标状态则立即 resolve', async () => {
      await fsm.waitForStatus(AgentStatus.IDLE);
      expect(fsm.getStatus()).toBe(AgentStatus.IDLE);
    });

    it('转换到目标状态后 resolve', async () => {
      const promise = fsm.waitForStatus(AgentStatus.EXECUTING);
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      await promise;
      expect(fsm.getStatus()).toBe(AgentStatus.EXECUTING);
    });

    it('只对目标状态 resolve，中间状态不 resolve', async () => {
      const cb = vi.fn();
      const promise = fsm.waitForStatus(AgentStatus.EXECUTING);
      promise.then(cb);
      fsm.transition(AgentStatus.THINKING); // 中间状态
      await Promise.resolve(); // 让微任务跑一轮
      expect(cb).not.toHaveBeenCalled();
      fsm.transition(AgentStatus.EXECUTING); // 目标状态
      await promise;
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('多个等待者同时被唤醒', async () => {
      const p1 = fsm.waitForStatus(AgentStatus.THINKING);
      const p2 = fsm.waitForStatus(AgentStatus.THINKING);
      fsm.transition(AgentStatus.THINKING);
      await Promise.all([p1, p2]);
    });
  });

  describe('waitForStatus 超时', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('超时后 reject', async () => {
      const promise = fsm.waitForStatus(AgentStatus.COMPLETED, 1000);
      // 预先附加 catch 避免 unhandled rejection
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).rejects.toThrow(/超时/);
    });

    it('超时前到达状态则正常 resolve', async () => {
      const promise = fsm.waitForStatus(AgentStatus.THINKING, 5000);
      fsm.transition(AgentStatus.THINKING);
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ============ 事件日志 ============

  describe('事件日志', () => {
    it('记录每次转换', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      const log = fsm.getEventLog();
      expect(log).toHaveLength(2);
      expect(log[0].fromStatus).toBe(AgentStatus.IDLE);
      expect(log[0].toStatus).toBe(AgentStatus.THINKING);
      expect(log[1].fromStatus).toBe(AgentStatus.THINKING);
      expect(log[1].toStatus).toBe(AgentStatus.EXECUTING);
    });

    it('getEventLog 返回副本，修改不影响内部', () => {
      fsm.transition(AgentStatus.THINKING);
      const log = fsm.getEventLog();
      log.push({} as any);
      log.length = 0;
      expect(fsm.getEventLog()).toHaveLength(1);
    });

    it('事件日志上限 200 条（FIFO 淘汰）', () => {
      // IDLE → THINKING，之后 THINKING ↔ EXECUTING 循环
      fsm.transition(AgentStatus.THINKING); // E1
      for (let i = 0; i < 100; i++) {
        fsm.transition(AgentStatus.EXECUTING);
        fsm.transition(AgentStatus.THINKING);
      }
      // 总计 1 + 200 = 201 次转换，日志上限 200
      const log = fsm.getEventLog();
      expect(log).toHaveLength(200);
      // 最早的事件（IDLE → THINKING）已被淘汰，首条为 THINKING → EXECUTING
      expect(log[0].fromStatus).toBe(AgentStatus.THINKING);
      expect(log[0].toStatus).toBe(AgentStatus.EXECUTING);
      // 末条为 EXECUTING → THINKING
      expect(log[199].fromStatus).toBe(AgentStatus.EXECUTING);
      expect(log[199].toStatus).toBe(AgentStatus.THINKING);
    });
  });

  // ============ 事件类型推断 ============

  describe('事件类型推断', () => {
    it('进入 WAITING_HUMAN 推断为 AWAIT_APPROVAL', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.transition(AgentStatus.WAITING_HUMAN);
      expect(cb.mock.calls[2][2].type).toBe('AWAIT_APPROVAL');
    });

    it('THINKING → EXECUTING 推断为 TOOL_START', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      expect(cb.mock.calls[1][2].type).toBe('TOOL_START');
    });

    it('WAITING_HUMAN → EXECUTING 推断为 STATE_CHANGE（非 TOOL_START）', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.transition(AgentStatus.WAITING_HUMAN);
      fsm.transition(AgentStatus.EXECUTING);
      expect(cb.mock.calls[3][2].type).toBe('STATE_CHANGE');
    });

    it.each([
      [AgentStatus.IDLE],
      [AgentStatus.THINKING],
      [AgentStatus.EXECUTING],
    ] as AgentStatus[][])('%s → COMPLETED 推断为 DONE', (from) => {
      const f = createFsmAt(from);
      const cb = vi.fn();
      f.onTransition(cb);
      f.transition(AgentStatus.COMPLETED);
      expect(cb.mock.calls[0][2].type).toBe('DONE');
    });

    it.each([
      [AgentStatus.IDLE],
      [AgentStatus.THINKING],
      [AgentStatus.EXECUTING],
    ] as AgentStatus[][])('%s → PAUSED 推断为 SYSTEM', (from) => {
      const f = createFsmAt(from);
      const cb = vi.fn();
      f.onTransition(cb);
      f.transition(AgentStatus.PAUSED);
      expect(cb.mock.calls[0][2].type).toBe('SYSTEM');
    });

    it.each([
      [AgentStatus.IDLE],
      [AgentStatus.THINKING],
      [AgentStatus.EXECUTING],
    ] as AgentStatus[][])('%s → ERROR 推断为 SYSTEM', (from) => {
      const f = createFsmAt(from);
      const cb = vi.fn();
      f.onTransition(cb);
      f.transition(AgentStatus.ERROR);
      expect(cb.mock.calls[0][2].type).toBe('SYSTEM');
    });

    it('IDLE → THINKING 推断为 STATE_CHANGE', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      expect(cb.mock.calls[0][2].type).toBe('STATE_CHANGE');
    });

    it('EXECUTING → THINKING 推断为 STATE_CHANGE', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.transition(AgentStatus.THINKING);
      expect(cb.mock.calls[2][2].type).toBe('STATE_CHANGE');
    });

    it('PAUSED → THINKING 推断为 STATE_CHANGE', () => {
      const cb = vi.fn();
      fsm.onTransition(cb);
      fsm.transition(AgentStatus.PAUSED);
      fsm.transition(AgentStatus.THINKING);
      expect(cb.mock.calls[1][2].type).toBe('STATE_CHANGE');
    });
  });

  // ============ reset ============

  describe('reset', () => {
    it('重置后状态回到 IDLE', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.EXECUTING);
      fsm.reset();
      expect(fsm.getStatus()).toBe(AgentStatus.IDLE);
    });

    it('重置后 previousStatus 为 null', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.reset();
      expect(fsm.getPreviousStatus()).toBeNull();
    });

    it('重置后事件日志为空', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.reset();
      expect(fsm.getEventLog()).toEqual([]);
    });

    it('重置后可重新开始状态转换', () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.transition(AgentStatus.COMPLETED);
      fsm.reset();
      expect(fsm.getStatus()).toBe(AgentStatus.IDLE);
      fsm.transition(AgentStatus.THINKING);
      expect(fsm.getStatus()).toBe(AgentStatus.THINKING);
    });

    it('重置后 waitForStatus 可正常工作', async () => {
      fsm.transition(AgentStatus.THINKING);
      fsm.reset();
      const promise = fsm.waitForStatus(AgentStatus.THINKING);
      fsm.transition(AgentStatus.THINKING);
      await promise;
      expect(fsm.getStatus()).toBe(AgentStatus.THINKING);
    });
  });

  // ============ previousStatus 跟踪 ============

  describe('previousStatus 跟踪', () => {
    it('转换后 previousStatus 为转换前状态', () => {
      fsm.transition(AgentStatus.THINKING);
      expect(fsm.getPreviousStatus()).toBe(AgentStatus.IDLE);
      fsm.transition(AgentStatus.EXECUTING);
      expect(fsm.getPreviousStatus()).toBe(AgentStatus.THINKING);
      fsm.transition(AgentStatus.THINKING);
      expect(fsm.getPreviousStatus()).toBe(AgentStatus.EXECUTING);
    });
  });
});
