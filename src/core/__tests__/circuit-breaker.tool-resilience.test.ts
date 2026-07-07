/**
 * 维度 5 P1：executeToolResiliently 单元测试
 *
 * 验证：
 * 1. 未启用熔断时行为与原 executeToolWithTimeout 一致（默认路径）
 * 2. 启用熔断后正确 recordSuccess/recordFailure
 * 3. 熔断打开时快速失败（不消耗资源执行工具）
 * 4. 超时保护始终生效
 * 5. USE_TOOL_CIRCUIT_BREAKER 环境变量灰度开关正确解析
 *
 * 见 v19 方案 §3.5.1 "circuit-breaker 接入工具执行路径"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeToolResiliently, resilienceChain } from '../circuit-breaker.js';

// 测试间用唯一 toolName 隔离 resilienceChain 单例状态
let toolNameSeq = 0;
function uniqueToolName(prefix: string): string {
  return `${prefix}_${++toolNameSeq}`;
}

describe('executeToolResiliently', () => {
  describe('未启用熔断时（默认）', () => {
    it('工具成功返回字符串', async () => {
      const r = await executeToolResiliently(uniqueToolName('default_ok'), async () => 'hello');
      expect(r.result).toBe('hello');
      expect(r.success).toBe(true);
      expect(r.circuitState).toBeUndefined();
    });

    it('工具返回非字符串时 JSON 序列化', async () => {
      const r = await executeToolResiliently(uniqueToolName('default_obj'), async () => ({ a: 1 }));
      expect(r.result).toBe(JSON.stringify({ a: 1 }));
      expect(r.success).toBe(true);
    });

    it('工具返回 null 时与原 executeToolWithTimeout 行为一致（序列化为双引号空串）', async () => {
      // 原 executeToolWithTimeout 逻辑：typeof null === 'object' → JSON.stringify(null ?? '') = '""'
      // 保持行为兼容，未启用熔断路径不变
      const r = await executeToolResiliently(uniqueToolName('default_null'), async () => null);
      expect(r.result).toBe('""');
      expect(r.success).toBe(true);
    });

    it('工具返回 undefined 时与原 executeToolWithTimeout 行为一致', async () => {
      // typeof undefined === 'undefined' → JSON.stringify(undefined ?? '') = '""'
      const r = await executeToolResiliently(uniqueToolName('default_undef'), async () => undefined);
      expect(r.result).toBe('""');
      expect(r.success).toBe(true);
    });

    it('工具返回 ❌ 字符串时 success=false', async () => {
      const r = await executeToolResiliently(uniqueToolName('default_fail'), async () => '❌ 操作失败');
      expect(r.success).toBe(false);
      expect(r.result).toBe('❌ 操作失败');
    });

    it('工具抛异常时返回错误字符串', async () => {
      const r = await executeToolResiliently(uniqueToolName('default_throw'), async () => {
        throw new Error('boom');
      });
      expect(r.result).toContain('boom');
      expect(r.result).toContain('❌ 工具执行失败');
      expect(r.success).toBe(false);
    });

    it('不传 useCircuitBreaker 时默认走非熔断路径', async () => {
      const r = await executeToolResiliently(uniqueToolName('default_unset'), async () => 'ok');
      expect(r.circuitState).toBeUndefined();
    });
  });

  describe('启用熔断（useCircuitBreaker=true）', () => {
    it('工具成功返回时 circuitState=closed', async () => {
      const toolName = uniqueToolName('cb_ok');
      const r = await executeToolResiliently(toolName, async () => 'success', {
        useCircuitBreaker: true,
      });
      expect(r.result).toBe('success');
      expect(r.success).toBe(true);
      expect(r.circuitState).toBe('closed');
    });

    it('工具成功时 recordSuccess 增加成功计数', async () => {
      const toolName = uniqueToolName('cb_success_count');
      await executeToolResiliently(toolName, async () => 'ok', { useCircuitBreaker: true });
      const stats = resilienceChain.getCircuitBreaker(`tool_${toolName}`).getStats();
      expect(stats.totalSuccesses).toBeGreaterThanOrEqual(1);
    });

    it('工具返回 ❌ 字符串时 recordFailure', async () => {
      const toolName = uniqueToolName('cb_fail_str');
      const r = await executeToolResiliently(toolName, async () => '❌ 业务错误', {
        useCircuitBreaker: true,
      });
      expect(r.success).toBe(false);
      expect(r.result).toBe('❌ 业务错误');
      // 默认阈值 5 次失败才熔断，1 次失败后仍 closed
      expect(r.circuitState).toBe('closed');
      const stats = resilienceChain.getCircuitBreaker(`tool_${toolName}`).getStats();
      expect(stats.failureCount).toBeGreaterThanOrEqual(1);
    });

    it('工具抛异常时 recordFailure', async () => {
      const toolName = uniqueToolName('cb_throw');
      const r = await executeToolResiliently(toolName, async () => {
        throw new Error('exception failure');
      }, { useCircuitBreaker: true });
      expect(r.success).toBe(false);
      expect(r.result).toContain('exception failure');
      const stats = resilienceChain.getCircuitBreaker(`tool_${toolName}`).getStats();
      expect(stats.failureCount).toBeGreaterThanOrEqual(1);
    });

    it('连续失败达阈值后熔断打开，快速失败', async () => {
      const toolName = uniqueToolName('cb_trip');
      // 默认 failureThreshold=5，触发熔断需 5+ 次失败
      for (let i = 0; i < 6; i++) {
        await executeToolResiliently(toolName, async () => {
          throw new Error('always fail');
        }, { useCircuitBreaker: true });
      }
      // 下一次调用应快速失败（不执行工具）
      let callCount = 0;
      const r = await executeToolResiliently(toolName, async () => {
        callCount++;
        return 'never run';
      }, { useCircuitBreaker: true });
      expect(r.success).toBe(false);
      expect(r.result).toContain('已熔断');
      expect(r.circuitState).toBe('open');
      expect(callCount).toBe(0);
    });

    it('熔断打开时返回特殊错误字符串（含工具名）', async () => {
      const toolName = uniqueToolName('cb_msg');
      for (let i = 0; i < 6; i++) {
        await executeToolResiliently(toolName, async () => {
          throw new Error('fail');
        }, { useCircuitBreaker: true });
      }
      const r = await executeToolResiliently(toolName, async () => 'never', {
        useCircuitBreaker: true,
      });
      expect(r.result).toMatch(/已熔断/);
      expect(r.result).toContain(toolName);
      expect(r.success).toBe(false);
      expect(r.circuitState).toBe('open');
    });

    it('不同工具名独立熔断（互不影响）', async () => {
      const failingTool = uniqueToolName('cb_independent_fail');
      const healthyTool = uniqueToolName('cb_independent_ok');
      // 让 failingTool 熔断
      for (let i = 0; i < 6; i++) {
        await executeToolResiliently(failingTool, async () => {
          throw new Error('fail');
        }, { useCircuitBreaker: true });
      }
      // healthyTool 仍可正常调用
      const r = await executeToolResiliently(healthyTool, async () => 'still works', {
        useCircuitBreaker: true,
      });
      expect(r.success).toBe(true);
      expect(r.result).toBe('still works');
      expect(r.circuitState).toBe('closed');
    });
  });

  describe('超时保护', () => {
    it('未启用熔断时超时也生效', async () => {
      const r = await executeToolResiliently(uniqueToolName('timeout_default'), async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'late';
      }, { timeoutMs: 50 });
      expect(r.success).toBe(false);
      expect(r.result).toContain('执行超时');
      expect(r.circuitState).toBeUndefined();
    });

    it('启用熔断时超时也生效', async () => {
      const toolName = uniqueToolName('timeout_cb');
      const r = await executeToolResiliently(toolName, async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'late';
      }, { timeoutMs: 50, useCircuitBreaker: true });
      expect(r.success).toBe(false);
      expect(r.result).toContain('执行超时');
      // 超时算失败，触发 recordFailure
      const stats = resilienceChain.getCircuitBreaker(`tool_${toolName}`).getStats();
      expect(stats.failureCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('灰度开关（USE_TOOL_CIRCUIT_BREAKER 环境变量）', () => {
    const ENV_KEY = 'USE_TOOL_CIRCUIT_BREAKER';
    let originalValue: string | undefined;

    beforeEach(() => {
      originalValue = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (originalValue === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalValue;
    });

    it('USE_TOOL_CIRCUIT_BREAKER=true 时启用熔断', async () => {
      process.env[ENV_KEY] = 'true';
      const r = await executeToolResiliently(uniqueToolName('env_true'), async () => 'ok');
      expect(r.circuitState).toBe('closed');
    });

    it('USE_TOOL_CIRCUIT_BREAKER 未设时关闭熔断', async () => {
      delete process.env[ENV_KEY];
      const r = await executeToolResiliently(uniqueToolName('env_unset'), async () => 'ok');
      expect(r.circuitState).toBeUndefined();
    });

    it('USE_TOOL_CIRCUIT_BREAKER=false 时关闭熔断', async () => {
      process.env[ENV_KEY] = 'false';
      const r = await executeToolResiliently(uniqueToolName('env_false'), async () => 'ok');
      expect(r.circuitState).toBeUndefined();
    });

    it('显式 useCircuitBreaker=false 优先于环境变量', async () => {
      process.env[ENV_KEY] = 'true';
      const r = await executeToolResiliently(uniqueToolName('env_override_false'), async () => 'ok', {
        useCircuitBreaker: false,
      });
      expect(r.circuitState).toBeUndefined();
    });

    it('显式 useCircuitBreaker=true 优先于环境变量未设', async () => {
      delete process.env[ENV_KEY];
      const r = await executeToolResiliently(uniqueToolName('env_override_true'), async () => 'ok', {
        useCircuitBreaker: true,
      });
      expect(r.circuitState).toBe('closed');
    });
  });
});
