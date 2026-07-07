import { describe, it, expect } from 'vitest';
import { getConcurrencyStats } from '../../server/middleware.js';

describe('Concurrency Middleware - getConcurrencyStats', () => {
  it('返回并发统计结构', () => {
    const stats = getConcurrencyStats();
    expect(stats).toHaveProperty('activeRequests');
    expect(stats).toHaveProperty('maxConcurrent');
    expect(stats).toHaveProperty('queueLength');
    expect(stats).toHaveProperty('maxQueueSize');
    expect(stats).toHaveProperty('utilization');
  });

  it('默认最大并发为 100', () => {
    const stats = getConcurrencyStats();
    expect(stats.maxConcurrent).toBe(100);
  });

  it('利用率在 0-1 范围内', () => {
    const stats = getConcurrencyStats();
    expect(stats.utilization).toBeGreaterThanOrEqual(0);
    expect(stats.utilization).toBeLessThanOrEqual(1);
  });

  it('队列长度非负', () => {
    const stats = getConcurrencyStats();
    expect(stats.queueLength).toBeGreaterThanOrEqual(0);
  });
});
