/**
 * P0-2: QueryEngine — 集中式 LLM 调用 + 重试/熔断/降级 测试
 *
 * 对标 Claude Code 的 LLM 调用集中处理机制：
 * - 自动重试（指数退避 + 抖动）
 * - 熔断器（连续失败触发，快速失败）
 * - 降级（模型降级链）
 * - 流式/非流式统一处理
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryEngine, type LLMClient, type QueryEngineConfig } from '../query-engine.js';

// ============ 测试辅助 ============

/** 创建 mock LLM 客户端 */
function createMockClient(
  createFn: (params: any, options?: any) => Promise<any>,
  id = 'mock-client',
  models = ['gpt-4'],
): LLMClient {
  return {
    id,
    models,
    create: vi.fn(createFn) as any,
  };
}

/** 创建 OpenAI 风格的 mock 客户端（带 chat.completions.create） */
function createOpenAIMockClient(
  createFn: (params: any, options?: any) => Promise<any>,
): any {
  return {
    chat: {
      completions: {
        create: vi.fn(createFn),
      },
    },
  };
}

/** 快速配置（短重试延迟，便于测试） */
const FAST_CONFIG: Partial<QueryEngineConfig> = {
  maxRetries: 2,
  baseRetryDelayMs: 10,
  maxRetryDelayMs: 50,
  enableJitter: false,
  defaultTimeoutMs: 5000,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerResetTimeoutMs: 100,
};

// ============ 测试 ============

describe('QueryEngine — createWithRecovery 基本调用', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    engine = new QueryEngine(() => null, FAST_CONFIG);
  });

  it('成功调用返回原始响应', async () => {
    const mockResponse = { choices: [{ message: { content: 'hello' } }] };
    const client = createOpenAIMockClient(async () => mockResponse);

    const result = await engine.createWithRecovery(
      client,
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      {},
      'gpt-4',
    );

    expect(result).toBe(mockResponse);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('成功调用后统计正确', async () => {
    const client = createOpenAIMockClient(async () => ({ choices: [] }));
    await engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4');

    const stats = engine.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalSuccesses).toBe(1);
    expect(stats.totalFailures).toBe(0);
    expect(stats.totalRetries).toBe(0);
  });

  it('流式调用（stream: true）成功返回流对象', async () => {
    const mockStream = { [Symbol.asyncIterator]: async function* () { yield { choices: [] }; } };
    const client = createOpenAIMockClient(async () => mockStream);

    const result = await engine.createWithRecovery(
      client,
      { model: 'gpt-4', messages: [], stream: true },
      {},
      'gpt-4',
    );

    expect(result).toBe(mockStream);
  });
});

describe('QueryEngine — createWithRecovery 重试逻辑', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    engine = new QueryEngine(() => null, FAST_CONFIG);
  });

  it('可重试错误（如 429）触发重试，最终成功', async () => {
    let callCount = 0;
    const client = createOpenAIMockClient(async () => {
      callCount++;
      if (callCount < 3) throw new Error('429 Too Many Requests');
      return { choices: [{ message: { content: 'success' } }] };
    });

    const result = await engine.createWithRecovery(
      client,
      { model: 'gpt-4', messages: [] },
      {},
      'gpt-4',
    );

    expect(result.choices[0].message.content).toBe('success');
    expect(callCount).toBe(3); // 2 次重试 + 1 次成功
    const stats = engine.getStats();
    expect(stats.totalRetries).toBe(2);
    expect(stats.totalSuccesses).toBe(1);
  });

  it('不可重试错误（如 401）立即抛出，不重试', async () => {
    const client = createOpenAIMockClient(async () => {
      throw new Error('401 Unauthorized');
    });

    await expect(
      engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow(/401/);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const stats = engine.getStats();
    expect(stats.totalFailures).toBe(1);
    expect(stats.totalRetries).toBe(0);
  });

  it('超过最大重试次数后抛出错误', async () => {
    const client = createOpenAIMockClient(async () => {
      throw new Error('500 Internal Server Error');
    });

    await expect(
      engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow(/Internal Server Error/);

    // maxRetries=2 → 1 次初始 + 2 次重试 = 3 次
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it('网络错误（ECONNRESET）可重试', async () => {
    let callCount = 0;
    const client = createOpenAIMockClient(async () => {
      callCount++;
      if (callCount === 1) throw new Error('ECONNRESET');
      return { choices: [] };
    });

    await engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4');
    expect(callCount).toBe(2);
  });
});

describe('QueryEngine — createWithRecovery 熔断器', () => {
  it('连续失败达到阈值后熔断器开启', async () => {
    const engine = new QueryEngine(() => null, {
      ...FAST_CONFIG,
      circuitBreakerFailureThreshold: 2,
      maxRetries: 0, // 不重试，快速失败
    });

    const failClient = createOpenAIMockClient(async () => {
      throw new Error('500 Internal Server Error');
    });

    // 第一次失败
    await expect(
      engine.createWithRecovery(failClient, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow();

    // 第二次失败 → 熔断器开启
    await expect(
      engine.createWithRecovery(failClient, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow();

    expect(engine.getCircuitBreakerState()).toBe('open');

    // 第三次调用 — 熔断器开启，快速失败
    await expect(
      engine.createWithRecovery(failClient, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow(/熔断器开启/);
  });

  it('熔断器开启后流式请求快速失败', async () => {
    const engine = new QueryEngine(() => null, {
      ...FAST_CONFIG,
      circuitBreakerFailureThreshold: 1,
      maxRetries: 0,
    });

    // 先触发熔断器
    const failClient = createOpenAIMockClient(async () => {
      throw new Error('500 Internal Server Error');
    });
    await expect(
      engine.createWithRecovery(failClient, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow();

    expect(engine.getCircuitBreakerState()).toBe('open');

    // 流式请求应快速失败
    await expect(
      engine.createWithRecovery(
        failClient,
        { model: 'gpt-4', messages: [], stream: true },
        {},
        'gpt-4',
      ),
    ).rejects.toThrow(/熔断器开启.*流式/);
  });

  it('熔断器超时后进入半开状态', async () => {
    const engine = new QueryEngine(() => null, {
      ...FAST_CONFIG,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerResetTimeoutMs: 50, // 50ms 后半开
      maxRetries: 0,
    });

    const failClient = createOpenAIMockClient(async () => {
      throw new Error('500 Internal Server Error');
    });
    await expect(
      engine.createWithRecovery(failClient, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow();

    expect(engine.getCircuitBreakerState()).toBe('open');

    // 等待熔断器超时
    await new Promise(resolve => setTimeout(resolve, 60));

    // 半开状态 — 成功调用应关闭熔断器
    const successClient = createOpenAIMockClient(async () => ({ choices: [] }));
    await engine.createWithRecovery(successClient, { model: 'gpt-4', messages: [] }, {}, 'gpt-4');

    expect(engine.getCircuitBreakerState()).toBe('closed');
  });
});

describe('QueryEngine — createWithRecovery 降级链', () => {
  it('非流式请求重试耗尽后降级到备用模型', async () => {
    const fallbackClient = createMockClient(
      async () => ({ choices: [{ message: { content: 'fallback response' } }] }),
      'fallback-client',
      ['gpt-3.5-turbo'],
    );

    const engine = new QueryEngine(
      (model) => (model === 'gpt-3.5-turbo' ? fallbackClient : null),
      {
        ...FAST_CONFIG,
        maxRetries: 1,
        degradationChain: {
          models: ['gpt-3.5-turbo'],
          getClient: (model) => (model === 'gpt-3.5-turbo' ? fallbackClient : null),
        },
      },
    );

    const primaryClient = createOpenAIMockClient(async () => {
      throw new Error('500 Internal Server Error');
    });

    const result = await engine.createWithRecovery(
      primaryClient,
      { model: 'gpt-4', messages: [] },
      {},
      'gpt-4',
    );

    expect(result.choices[0].message.content).toBe('fallback response');
    expect(fallbackClient.create).toHaveBeenCalledTimes(1);
    const stats = engine.getStats();
    expect(stats.totalDegradations).toBe(1);
  });

  it('流式请求不降级（流中断无法恢复）', async () => {
    const fallbackClient = createMockClient(
      async () => ({ choices: [] }),
      'fallback-client',
      ['gpt-3.5-turbo'],
    );

    const engine = new QueryEngine(
      () => null,
      {
        ...FAST_CONFIG,
        maxRetries: 1,
        degradationChain: {
          models: ['gpt-3.5-turbo'],
          getClient: () => fallbackClient,
        },
      },
    );

    const primaryClient = createOpenAIMockClient(async () => {
      throw new Error('500 Internal Server Error');
    });

    // 流式请求应抛出错误，不降级
    await expect(
      engine.createWithRecovery(
        primaryClient,
        { model: 'gpt-4', messages: [], stream: true },
        {},
        'gpt-4',
      ),
    ).rejects.toThrow();

    expect(fallbackClient.create).not.toHaveBeenCalled();
  });
});

describe('QueryEngine — createWithRecovery 统计', () => {
  it('记录平均响应时间', async () => {
    const engine = new QueryEngine(() => null, FAST_CONFIG);
    const client = createOpenAIMockClient(async () => {
      await new Promise(r => setTimeout(r, 20));
      return { choices: [] };
    });

    await engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4');

    const stats = engine.getStats();
    expect(stats.averageResponseTimeMs).toBeGreaterThanOrEqual(15);
  });

  it('记录 top errors', async () => {
    const engine = new QueryEngine(() => null, { ...FAST_CONFIG, maxRetries: 0 });
    const client = createOpenAIMockClient(async () => {
      throw new Error('429 Too Many Requests');
    });

    await expect(
      engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4'),
    ).rejects.toThrow();

    const stats = engine.getStats();
    expect(stats.topErrors.length).toBeGreaterThan(0);
    expect(stats.topErrors[0].error).toContain('429');
  });

  it('resetStats 清空统计', async () => {
    const engine = new QueryEngine(() => null, FAST_CONFIG);
    const client = createOpenAIMockClient(async () => ({ choices: [] }));

    await engine.createWithRecovery(client, { model: 'gpt-4', messages: [] }, {}, 'gpt-4');
    engine.resetStats();

    const stats = engine.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.totalSuccesses).toBe(0);
  });
});
