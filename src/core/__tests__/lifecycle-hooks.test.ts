import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LifecycleEvent,
  LifecycleHookManager,
  type HookResult,
} from '../lifecycle-hooks.js';

describe('LifecycleHookManager', () => {
  let manager: LifecycleHookManager;

  beforeEach(() => {
    manager = new LifecycleHookManager();
  });

  // ============ register / trigger 基础 ============

  describe('register / trigger 基础', () => {
    it('注册 continue 钩子 → trigger 返回 allowed=true', async () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'continue-hook',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });

      const result = await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, {
        prompt: 'hello',
      });

      expect(result.allowed).toBe(true);
      expect(result.blockedReason).toBeUndefined();
    });

    it('注册 block 钩子 → trigger 返回 allowed=false 并携带 blockedReason', async () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'block-hook',
        priority: 100,
        handler: async () => ({ action: 'block', reason: '被阻止' }),
      });

      const result = await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, {
        prompt: 'hello',
      });

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe('被阻止');
    });

    it('register 返回取消注册函数 → 调用后钩子被移除', async () => {
      const unregister = manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'temp-hook',
        priority: 100,
        handler: async () => ({ action: 'block', reason: '临时阻止' }),
      });

      // 注册后触发应被阻止
      const before = await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, {});
      expect(before.allowed).toBe(false);

      // 取消注册
      unregister();

      // 取消后触发应放行
      const after = await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, {});
      expect(after.allowed).toBe(true);
      expect(manager.getHooks(LifecycleEvent.ON_LLM_REQUEST)).toHaveLength(0);
    });

    it('同名钩子注册两次 → 第二次替换第一次（无重复）', async () => {
      const firstSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));
      const secondSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'same-name',
        priority: 100,
        handler: firstSpy,
      });
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'same-name',
        priority: 100,
        handler: secondSpy,
      });

      // 只应有一个钩子
      expect(manager.getHooks(LifecycleEvent.ON_LLM_REQUEST)).toHaveLength(1);

      await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, {});

      // 只有第二个处理器被调用
      expect(firstSpy).not.toHaveBeenCalled();
      expect(secondSpy).toHaveBeenCalledTimes(1);
    });

    it('无钩子时 trigger → 返回 allowed=true', async () => {
      const result = await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, {
        prompt: 'hello',
      });

      expect(result.allowed).toBe(true);
      expect(result.blockedReason).toBeUndefined();
      expect(result.modifiedData).toBeUndefined();
    });
  });

  // ============ 优先级排序 ============

  describe('优先级排序', () => {
    it('钩子按优先级数值升序执行（数值越小越先执行）', async () => {
      const order: string[] = [];

      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'low-priority',
        priority: 200,
        handler: async () => {
          order.push('low');
          return { action: 'continue' };
        },
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'high-priority',
        priority: 10,
        handler: async () => {
          order.push('high');
          return { action: 'continue' };
        },
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'mid-priority',
        priority: 100,
        handler: async () => {
          order.push('mid');
          return { action: 'continue' };
        },
      });

      await manager.trigger(LifecycleEvent.ON_TOOL_CALL, {});

      expect(order).toEqual(['high', 'mid', 'low']);
    });

    it('高优先级钩子 block 后阻止低优先级钩子执行', async () => {
      const lowSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'low',
        priority: 200,
        handler: lowSpy,
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'high',
        priority: 10,
        handler: async () => ({ action: 'block', reason: '高优先级拦截' }),
      });

      const result = await manager.trigger(LifecycleEvent.ON_TOOL_CALL, {});

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe('高优先级拦截');
      expect(lowSpy).not.toHaveBeenCalled();
    });

    it('使用 spy 函数验证执行顺序', async () => {
      const spyA = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));
      const spyB = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));
      const spyC = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_ERROR, { name: 'c', priority: 50, handler: spyC });
      manager.register(LifecycleEvent.ON_ERROR, { name: 'a', priority: 10, handler: spyA });
      manager.register(LifecycleEvent.ON_ERROR, { name: 'b', priority: 30, handler: spyB });

      await manager.trigger(LifecycleEvent.ON_ERROR, {});

      expect(spyA).toHaveBeenCalledTimes(1);
      expect(spyB).toHaveBeenCalledTimes(1);
      expect(spyC).toHaveBeenCalledTimes(1);

      // 验证调用顺序：a (10) → b (30) → c (50)
      const aCallOrder = spyA.mock.invocationCallOrder[0];
      const bCallOrder = spyB.mock.invocationCallOrder[0];
      const cCallOrder = spyC.mock.invocationCallOrder[0];
      expect(aCallOrder).toBeLessThan(bCallOrder);
      expect(bCallOrder).toBeLessThan(cCallOrder);
    });
  });

  // ============ HookResult 动作 ============

  describe('HookResult 动作', () => {
    it('continue 动作 → 允许后续钩子继续执行', async () => {
      const secondSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_LLM_RESPONSE, {
        name: 'first',
        priority: 10,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_LLM_RESPONSE, {
        name: 'second',
        priority: 20,
        handler: secondSpy,
      });

      const result = await manager.trigger(LifecycleEvent.ON_LLM_RESPONSE, {});

      expect(result.allowed).toBe(true);
      expect(secondSpy).toHaveBeenCalledTimes(1);
    });

    it('block 动作 → 立即停止执行并返回 blockedReason', async () => {
      const laterSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_LLM_RESPONSE, {
        name: 'blocker',
        priority: 10,
        handler: async () => ({ action: 'block', reason: '拦截执行' }),
      });
      manager.register(LifecycleEvent.ON_LLM_RESPONSE, {
        name: 'later',
        priority: 20,
        handler: laterSpy,
      });

      const result = await manager.trigger(LifecycleEvent.ON_LLM_RESPONSE, {});

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe('拦截执行');
      expect(laterSpy).not.toHaveBeenCalled();
    });

    it('modify 动作 → modifiedData 传递给后续钩子并出现在返回结果中', async () => {
      let receivedData: Record<string, any> = {};

      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'modifier',
        priority: 10,
        handler: async () => ({
          action: 'modify',
          modifiedData: { injected: true },
          reason: '注入字段',
        }),
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'observer',
        priority: 20,
        handler: async (ctx) => {
          receivedData = { ...ctx.data };
          return { action: 'continue' };
        },
      });

      const result = await manager.trigger(LifecycleEvent.ON_TOOL_CALL, { original: 1 });

      // 后续钩子收到修改后的数据
      expect(receivedData).toEqual({ original: 1, injected: true });

      // 返回结果包含修改后的数据
      expect(result.allowed).toBe(true);
      expect(result.modifiedData).toEqual({ original: 1, injected: true });
    });

    it('delay 动作 → 等待指定毫秒后继续执行', async () => {
      vi.useFakeTimers();
      try {
        const laterSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

        manager.register(LifecycleEvent.ON_LOOP_COMPLETE, {
          name: 'delayer',
          priority: 10,
          handler: async () => ({ action: 'delay', ms: 500, reason: '延迟等待' }),
        });
        manager.register(LifecycleEvent.ON_LOOP_COMPLETE, {
          name: 'after-delay',
          priority: 20,
          handler: laterSpy,
        });

        const triggerPromise = manager.trigger(LifecycleEvent.ON_LOOP_COMPLETE, {});

        // 推进 500ms 让 setTimeout 完成
        await vi.advanceTimersByTimeAsync(500);

        const result = await triggerPromise;

        expect(result.allowed).toBe(true);
        expect(laterSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('钩子抛出错误 → 视为 continue，不阻断流程', async () => {
      const laterSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_ERROR, {
        name: 'thrower',
        priority: 10,
        handler: async () => {
          throw new Error('钩子内部异常');
        },
      });
      manager.register(LifecycleEvent.ON_ERROR, {
        name: 'later',
        priority: 20,
        handler: laterSpy,
      });

      const result = await manager.trigger(LifecycleEvent.ON_ERROR, {});

      expect(result.allowed).toBe(true);
      expect(laterSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============ unregister / getHooks / clear ============

  describe('unregister / getHooks / clear', () => {
    it('unregister 已存在的钩子 → 返回 true', () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'to-remove',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });

      const result = manager.unregister(LifecycleEvent.ON_LLM_REQUEST, 'to-remove');

      expect(result).toBe(true);
      expect(manager.getHooks(LifecycleEvent.ON_LLM_REQUEST)).toHaveLength(0);
    });

    it('unregister 不存在的钩子 → 返回 false', () => {
      const result = manager.unregister(LifecycleEvent.ON_LLM_REQUEST, 'nonexistent');

      expect(result).toBe(false);
    });

    it('unregister 不存在的事件 → 返回 false', () => {
      const result = manager.unregister(LifecycleEvent.ON_SESSION_END, 'any');

      expect(result).toBe(false);
    });

    it('getHooks(event) 返回按优先级排序的钩子列表', () => {
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'c',
        priority: 300,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'a',
        priority: 50,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'b',
        priority: 150,
        handler: async () => ({ action: 'continue' }),
      });

      const hooks = manager.getHooks(LifecycleEvent.ON_TOOL_CALL);

      expect(hooks.map((h) => h.name)).toEqual(['a', 'b', 'c']);
    });

    it('getHooks() 不传 event → 返回所有事件的钩子（按优先级排序）', () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'req',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'tool',
        priority: 10,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_ERROR, {
        name: 'err',
        priority: 50,
        handler: async () => ({ action: 'continue' }),
      });

      const all = manager.getHooks();

      expect(all).toHaveLength(3);
      // 按优先级升序：tool(10) → err(50) → req(100)
      expect(all.map((h) => h.name)).toEqual(['tool', 'err', 'req']);
    });

    it('clear(event) 仅移除指定事件的钩子', () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'a',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'b',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });

      manager.clear(LifecycleEvent.ON_LLM_REQUEST);

      expect(manager.getHooks(LifecycleEvent.ON_LLM_REQUEST)).toHaveLength(0);
      expect(manager.getHooks(LifecycleEvent.ON_TOOL_CALL)).toHaveLength(1);
    });

    it('clear() 不传 event → 移除所有钩子', () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'a',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_TOOL_CALL, {
        name: 'b',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });
      manager.register(LifecycleEvent.ON_ERROR, {
        name: 'c',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });

      manager.clear();

      expect(manager.getHooks()).toHaveLength(0);
    });

    it('getHooks 返回的是副本，修改不影响内部状态', () => {
      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'a',
        priority: 100,
        handler: async () => ({ action: 'continue' }),
      });

      const hooks = manager.getHooks(LifecycleEvent.ON_LLM_REQUEST);
      hooks.pop();

      // 内部状态不应被影响
      expect(manager.getHooks(LifecycleEvent.ON_LLM_REQUEST)).toHaveLength(1);
    });
  });

  // ============ 边界情况 ============

  describe('边界情况', () => {
    it('trigger 传入空数据对象 → 正常执行', async () => {
      let capturedData: Record<string, any> | undefined;

      manager.register(LifecycleEvent.ON_SESSION_START, {
        name: 'observer',
        priority: 100,
        handler: async (ctx) => {
          capturedData = ctx.data;
          return { action: 'continue' };
        },
      });

      const result = await manager.trigger(LifecycleEvent.ON_SESSION_START, {});

      expect(result.allowed).toBe(true);
      expect(result.modifiedData).toBeUndefined();
      // 钩子收到的上下文 data 应为空对象
      expect(capturedData).toEqual({});
    });

    it('多个 modify 钩子链式累积修改', async () => {
      let midData: Record<string, any> = {};
      let finalData: Record<string, any> = {};

      manager.register(LifecycleEvent.ON_CONTEXT_COMPRESS, {
        name: 'modifier-1',
        priority: 10,
        handler: async () => ({
          action: 'modify',
          modifiedData: { step1: true },
          reason: '第一步修改',
        }),
      });
      manager.register(LifecycleEvent.ON_CONTEXT_COMPRESS, {
        name: 'observer',
        priority: 20,
        handler: async (ctx) => {
          midData = { ...ctx.data };
          return { action: 'continue' };
        },
      });
      manager.register(LifecycleEvent.ON_CONTEXT_COMPRESS, {
        name: 'modifier-2',
        priority: 30,
        handler: async () => ({
          action: 'modify',
          modifiedData: { step2: true },
          reason: '第二步修改',
        }),
      });
      manager.register(LifecycleEvent.ON_CONTEXT_COMPRESS, {
        name: 'final-observer',
        priority: 40,
        handler: async (ctx) => {
          finalData = { ...ctx.data };
          return { action: 'continue' };
        },
      });

      const result = await manager.trigger(LifecycleEvent.ON_CONTEXT_COMPRESS, {
        base: 0,
      });

      // 中间观察者只看到第一步修改
      expect(midData).toEqual({ base: 0, step1: true });
      // 最终观察者看到两步修改
      expect(finalData).toEqual({ base: 0, step1: true, step2: true });
      // 返回结果包含累积修改
      expect(result.modifiedData).toEqual({ base: 0, step1: true, step2: true });
    });

    it('modify + block 组合（先 modify 后 block）→ 返回 allowed=false 且不返回 modifiedData', async () => {
      const laterSpy = vi.fn(async (): Promise<HookResult> => ({ action: 'continue' }));

      manager.register(LifecycleEvent.ON_SUBAGENT_DISPATCH, {
        name: 'modifier',
        priority: 10,
        handler: async () => ({
          action: 'modify',
          modifiedData: { tagged: true },
          reason: '标记派发',
        }),
      });
      manager.register(LifecycleEvent.ON_SUBAGENT_DISPATCH, {
        name: 'blocker',
        priority: 20,
        handler: async () => ({ action: 'block', reason: '派发被阻止' }),
      });
      manager.register(LifecycleEvent.ON_SUBAGENT_DISPATCH, {
        name: 'never-runs',
        priority: 30,
        handler: laterSpy,
      });

      const result = await manager.trigger(LifecycleEvent.ON_SUBAGENT_DISPATCH, {
        agentId: 'a1',
      });

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe('派发被阻止');
      // block 中断后不返回 modifiedData
      expect(result.modifiedData).toBeUndefined();
      // 后续钩子未执行
      expect(laterSpy).not.toHaveBeenCalled();
    });

    it('LifecycleEvent 枚举包含全部 16 个事件（v20 基础 11 个 + v21 新增 5 个）', () => {
      const events = Object.values(LifecycleEvent);
      expect(events).toHaveLength(16);
      // v20 基础事件（11 个）
      expect(LifecycleEvent.ON_LLM_REQUEST).toBe('on_llm_request');
      expect(LifecycleEvent.ON_LLM_RESPONSE).toBe('on_llm_response');
      expect(LifecycleEvent.ON_TOOL_CALL).toBe('on_tool_call');
      expect(LifecycleEvent.ON_TOOL_RESULT).toBe('on_tool_result');
      expect(LifecycleEvent.ON_ERROR).toBe('on_error');
      expect(LifecycleEvent.ON_LOOP_COMPLETE).toBe('on_loop_complete');
      expect(LifecycleEvent.ON_SESSION_START).toBe('on_session_start');
      expect(LifecycleEvent.ON_SESSION_END).toBe('on_session_end');
      expect(LifecycleEvent.ON_CONTEXT_COMPRESS).toBe('on_context_compress');
      expect(LifecycleEvent.ON_SUBAGENT_DISPATCH).toBe('on_subagent_dispatch');
      expect(LifecycleEvent.ON_SUBAGENT_RESULT).toBe('on_subagent_result');
      // v21 新增事件（5 个，对标 Claude Code Hooks）
      expect(LifecycleEvent.ON_USER_PROMPT_SUBMIT).toBe('on_user_prompt_submit');
      expect(LifecycleEvent.ON_STOP).toBe('on_stop');
      expect(LifecycleEvent.ON_PRE_COMPACT).toBe('on_pre_compact');
      expect(LifecycleEvent.ON_SUBAGENT_START).toBe('on_subagent_start');
      expect(LifecycleEvent.ON_SUBAGENT_STOP).toBe('on_subagent_stop');
    });

    it('trigger 不修改原始 data 对象（内部使用副本）', async () => {
      const original = { prompt: 'hello' };
      const originalSnapshot = { ...original };

      manager.register(LifecycleEvent.ON_LLM_REQUEST, {
        name: 'modifier',
        priority: 100,
        handler: async () => ({
          action: 'modify',
          modifiedData: { extra: 'injected' },
          reason: '注入字段',
        }),
      });

      await manager.trigger(LifecycleEvent.ON_LLM_REQUEST, original);

      // 原始对象不应被修改
      expect(original).toEqual(originalSnapshot);
    });
  });
});
