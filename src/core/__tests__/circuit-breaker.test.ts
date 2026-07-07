import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, Bulkhead, BulkheadRejectedError, CircuitBreakerOpenError } from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker('test', {
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 5000,
      halfOpenMaxRequests: 1,
    }, {
      maxRetries: 0,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: false,
      retryableErrors: [/test error/i],
    });
  });

  describe('正常场景', () => {
    it('成功调用返回结果', async () => {
      const result = await cb.call(async () => 'success');
      expect(result).toBe('success');
      expect(cb.getState()).toBe('closed');
    });

    it('成功后统计正确', async () => {
      await cb.call(async () => 'ok');
      const stats = cb.getStats();
      expect(stats.totalSuccesses).toBe(1);
      expect(stats.totalCalls).toBeGreaterThanOrEqual(1);
    });

    it('记录响应时间', async () => {
      await cb.call(async () => {
        await new Promise(r => setTimeout(r, 50));
        return 'ok';
      });
      const stats = cb.getStats();
      expect(stats.avgResponseTime).toBeGreaterThan(0);
    });
  });

  describe('熔断场景', () => {
    it('连续失败达到阈值后熔断', async () => {
      const failFn = async () => { throw new Error('test error'); };
      // 失败 3 次（failureThreshold=3）
      for (let i = 0; i < 3; i++) {
        try { await cb.call(failFn); } catch {}
      }
      expect(cb.getState()).toBe('open');
    });

    it('熔断状态下调用抛出 CircuitBreakerOpenError', async () => {
      const failFn = async () => { throw new Error('test error'); };
      for (let i = 0; i < 3; i++) {
        try { await cb.call(failFn); } catch {}
      }
      await expect(cb.call(async () => 'should not reach')).rejects.toThrow(CircuitBreakerOpenError);
    });
  });

  describe('重置', () => {
    it('reset 后状态回到 closed', async () => {
      const failFn = async () => { throw new Error('test error'); };
      for (let i = 0; i < 3; i++) {
        try { await cb.call(failFn); } catch {}
      }
      expect(cb.getState()).toBe('open');
      cb.reset();
      expect(cb.getState()).toBe('closed');
      expect(cb.getStats().failureCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('返回完整统计结构', () => {
      const stats = cb.getStats();
      expect(stats).toHaveProperty('state');
      expect(stats).toHaveProperty('failureCount');
      expect(stats).toHaveProperty('successCount');
      expect(stats).toHaveProperty('totalCalls');
      expect(stats).toHaveProperty('totalFailures');
      expect(stats).toHaveProperty('totalSuccesses');
      expect(stats).toHaveProperty('avgResponseTime');
    });
  });
});

describe('Bulkhead', () => {
  it('并发数内正常执行', async () => {
    const bulkhead = new Bulkhead(3, 10);
    const results = await Promise.all([
      bulkhead.call(async () => 'a'),
      bulkhead.call(async () => 'b'),
      bulkhead.call(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('超过并发数时拒绝', async () => {
    // maxConcurrent=1, queueSize=0 → 第二个调用立即拒绝
    const bulkhead = new Bulkhead(1, 0);
    let releaseFirst!: () => void;
    // 第一个占用槽位（不释放）
    const slow = bulkhead.call(async () => {
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      return 'slow';
    });
    // 等待第一个调用真正开始执行（activeCount 已递增）
    await new Promise(r => setTimeout(r, 50));
    // 第二个应被立即拒绝（队列容量为 0）
    await expect(bulkhead.call(async () => 'fast')).rejects.toThrow(BulkheadRejectedError);
    releaseFirst();
    await slow;
  });

  it('getStats 返回正确统计', async () => {
    const bulkhead = new Bulkhead(5, 50);
    await bulkhead.call(async () => 'ok');
    const stats = bulkhead.getStats();
    expect(stats.maxConcurrent).toBe(5);
    expect(stats).toHaveProperty('activeCount');
    expect(stats).toHaveProperty('queueLength');
  });
});
