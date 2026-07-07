import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../event-bus.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = EventBus.getInstance();
    bus.reset();
  });

  describe('单例', () => {
    it('getInstance 返回同一实例', () => {
      const a = EventBus.getInstance();
      const b = EventBus.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('on/emit 基本操作', () => {
    it('订阅并接收事件', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      await bus.emit('test.event');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emit 传递 data', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      await bus.emit('test.event', { key: 'value', num: 42 });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ data: { key: 'value', num: 42 } }),
      );
    });

    it('emit 传递 source', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      await bus.emit('test.event', undefined, { source: 'my-source' });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'my-source' }),
      );
    });

    it('handler 接收正确的 BusEvent', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);
      await bus.emit('test.event', { foo: 'bar' }, { source: 'src', priority: 'high' });
      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.type).toBe('test.event');
      expect(event.source).toBe('src');
      expect(event.data).toEqual({ foo: 'bar' });
      expect(event.priority).toBe('high');
      expect(event.timestamp).toBeTypeOf('number');
      expect(event.id).toBeTypeOf('string');
    });
  });

  describe('once', () => {
    it('once 只触发一次', async () => {
      const handler = vi.fn();
      bus.once('test.once', handler);
      await bus.emit('test.once');
      await bus.emit('test.once');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('once 后自动取消订阅', async () => {
      const handler = vi.fn();
      bus.once('test.once', handler);
      const beforeCount = bus.getMetrics().subscriberCount;
      await bus.emit('test.once');
      const afterCount = bus.getMetrics().subscriberCount;
      expect(afterCount).toBe(beforeCount - 1);
    });
  });

  describe('unsubscribe', () => {
    it('on 返回的取消函数有效', async () => {
      const handler = vi.fn();
      const unsub = bus.on('test.unsub', handler);
      unsub();
      await bus.emit('test.unsub');
      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe 取消订阅', async () => {
      const handler = vi.fn();
      const unsub = bus.on('test.unsub', handler);
      const beforeCount = bus.getMetrics().subscriberCount;
      unsub();
      const afterCount = bus.getMetrics().subscriberCount;
      expect(afterCount).toBe(beforeCount - 1);
      await bus.emit('test.unsub');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('通配符匹配', () => {
    it("'*' 匹配所有事件", async () => {
      const handler = vi.fn();
      bus.on('*', handler);
      await bus.emit('anything.happened');
      await bus.emit('other.event');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("'**' 匹配所有事件", async () => {
      const handler = vi.fn();
      bus.on('**', handler);
      await bus.emit('anything.happened');
      await bus.emit('other.event');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("'user.*' 匹配 'user.created'", async () => {
      const handler = vi.fn();
      bus.on('user.*', handler);
      await bus.emit('user.created');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("'user.*' 匹配 'user.updated'", async () => {
      const handler = vi.fn();
      bus.on('user.*', handler);
      await bus.emit('user.updated');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("'user.*' 不匹配 'system.startup'", async () => {
      const handler = vi.fn();
      bus.on('user.*', handler);
      await bus.emit('system.startup');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('filter', () => {
    it('filter 过滤事件', async () => {
      const handler = vi.fn();
      bus.on('test.filter', handler, {
        filter: (event) => event.data?.status === 'ok',
      });
      await bus.emit('test.filter', { status: 'fail' });
      await bus.emit('test.filter', { status: 'ok' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].data).toEqual({ status: 'ok' });
    });
  });

  describe('去重', () => {
    it('相同 dedupKey 的事件在窗口期内被去重', async () => {
      const handler = vi.fn();
      bus.on('test.dedup', handler);
      await bus.emit('test.dedup', { v: 1 }, { dedupKey: 'same-key' });
      await bus.emit('test.dedup', { v: 2 }, { dedupKey: 'same-key' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('不同 dedupKey 的事件不被去重', async () => {
      const handler = vi.fn();
      bus.on('test.dedup', handler);
      await bus.emit('test.dedup', { v: 1 }, { dedupKey: 'key-a' });
      await bus.emit('test.dedup', { v: 2 }, { dedupKey: 'key-b' });
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('getHistory', () => {
    it('返回事件历史', async () => {
      bus.on('test.history', vi.fn());
      await bus.emit('test.history', { n: 1 });
      const history = bus.getHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[history.length - 1].event.type).toBe('test.history');
    });

    it('按 type 过滤', async () => {
      bus.on('type.a', vi.fn());
      bus.on('type.b', vi.fn());
      await bus.emit('type.a');
      await bus.emit('type.b');
      await bus.emit('type.a');
      const history = bus.getHistory({ type: 'type.a' });
      expect(history.every((e) => e.event.type === 'type.a')).toBe(true);
      expect(history.length).toBe(2);
    });

    it('按 source 过滤', async () => {
      bus.on('test.src', vi.fn());
      await bus.emit('test.src', undefined, { source: 'src1' });
      await bus.emit('test.src', undefined, { source: 'src2' });
      const history = bus.getHistory({ source: 'src1' });
      expect(history.every((e) => e.event.source === 'src1')).toBe(true);
      expect(history.length).toBe(1);
    });

    it('clearHistory 清空历史', async () => {
      bus.on('test.clear', vi.fn());
      await bus.emit('test.clear');
      expect(bus.getSize()).toBeGreaterThan(0);
      bus.clearHistory();
      expect(bus.getSize()).toBe(0);
      expect(bus.getHistory().length).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('totalEmitted 统计', async () => {
      const before = bus.getMetrics().totalEmitted;
      await bus.emit('test.metric');
      await bus.emit('test.metric');
      await bus.emit('test.metric');
      const after = bus.getMetrics().totalEmitted;
      expect(after - before).toBe(3);
    });

    it('totalDelivered 统计', async () => {
      const handler = vi.fn();
      bus.on('test.delivered', handler);
      const before = bus.getMetrics().totalDelivered;
      await bus.emit('test.delivered');
      const after = bus.getMetrics().totalDelivered;
      expect(after - before).toBe(1);
    });

    it('subscriberCount 统计', () => {
      expect(bus.getMetrics().subscriberCount).toBe(0);
      bus.on('test.sub', vi.fn());
      bus.on('test.sub', vi.fn());
      bus.on('other.sub', vi.fn());
      expect(bus.getMetrics().subscriberCount).toBe(3);
    });

    it('patternsCount 统计', () => {
      expect(bus.getMetrics().patternsCount).toBe(0);
      bus.on('pattern.a', vi.fn());
      bus.on('pattern.b', vi.fn());
      expect(bus.getMetrics().patternsCount).toBe(2);
    });
  });

  describe('waitFor', () => {
    it('waitFor 等待事件', async () => {
      const promise = bus.waitFor('test.wait', 2000);
      setTimeout(() => {
        void bus.emit('test.wait', { ok: true });
      }, 50);
      const event = await promise;
      expect(event.type).toBe('test.wait');
      expect(event.data).toEqual({ ok: true });
    });

    it('waitFor 超时拒绝', async () => {
      await expect(bus.waitFor('test.timeout', 100)).rejects.toThrow(/timeout/);
    });
  });

  describe('reset', () => {
    it('reset 清空所有订阅者和历史', async () => {
      const handler = vi.fn();
      bus.on('test.reset', handler);
      await bus.emit('test.reset', { v: 1 });
      expect(bus.getMetrics().subscriberCount).toBeGreaterThan(0);
      expect(bus.getSize()).toBeGreaterThan(0);

      bus.reset();

      expect(bus.getMetrics().subscriberCount).toBe(0);
      expect(bus.getSize()).toBe(0);
      await bus.emit('test.reset', { v: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('异步 handler', () => {
    it('async handler 正确执行', async () => {
      const handler = vi.fn(async (event: any) => {
        await new Promise((r) => setTimeout(r, 10));
        return event.data;
      });
      bus.on('test.async', handler);
      await bus.emit('test.async', { value: 42 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].data).toEqual({ value: 42 });
    });

    it('handler 抛出错误不影响其他 handler', async () => {
      const handler1 = vi.fn(() => {
        throw new Error('boom');
      });
      const handler2 = vi.fn();
      bus.on('test.error', handler1);
      bus.on('test.error', handler2);
      await bus.emit('test.error');
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });
});
