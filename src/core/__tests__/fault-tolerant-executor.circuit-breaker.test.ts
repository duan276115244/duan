/**
 * FaultTolerantExecutor 熔断器接入测试
 *
 * 验证 executeStepWithRetry 中 USE_STEP_CIRCUIT_BREAKER 灰度开关和熔断器交互：
 * - 未启用时行为兼容（与原重试逻辑一致）
 * - 启用后 recordSuccess / recordFailure / 熔断 open 快速失败 / 重试中熔断跳过
 * - 不同工具独立熔断
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FaultTolerantExecutor, type ExecutionStep, type ToolExecutorFn } from '../fault-tolerant-executor.js';
import { resilienceChain } from '../circuit-breaker.js';

let seq = 0;
function uniqueToolName(prefix: string): string {
  return `${prefix}_${++seq}`;
}

function makeStep(toolName: string, maxRetries = 3): ExecutionStep {
  return {
    id: `step_${++seq}`,
    toolName,
    args: {},
    description: 'test',
    timeout: 5000,
    retries: 0,
    maxRetries,
    dependsOn: [],
    status: 'pending',
  };
}

function makeOkExecutor(result = 'ok'): ToolExecutorFn {
  return async () => result;
}

function makeFailExecutor(errorMsg = 'fail'): ToolExecutorFn {
  return async () => {
    throw new Error(errorMsg);
  };
}

describe('FaultTolerantExecutor circuit breaker integration', () => {
  let executor: FaultTolerantExecutor;
  let tempDir: string;
  let savedEnv: string | undefined;
  let sleepSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `fte_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    executor = new FaultTolerantExecutor(tempDir);
    savedEnv = process.env.USE_STEP_CIRCUIT_BREAKER;
    // mock sleep 避免重试时实际等待
    sleepSpy = vi.spyOn(executor as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.USE_STEP_CIRCUIT_BREAKER;
    else process.env.USE_STEP_CIRCUIT_BREAKER = savedEnv;
    sleepSpy.mockRestore();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // ============ 未启用熔断时行为兼容 ============

  describe('未启用熔断时行为兼容', () => {
    beforeEach(() => {
      delete process.env.USE_STEP_CIRCUIT_BREAKER;
    });

    it('成功返回结果', async () => {
      const toolName = uniqueToolName('compat_ok');
      const step = makeStep(toolName);
      const result = await (executor as unknown as {
        executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
      }).executeStepWithRetry(step, makeOkExecutor('done'));
      expect(result).toBe('done');
    });

    it('失败后重试成功', async () => {
      const toolName = uniqueToolName('compat_retry');
      const step = makeStep(toolName, 3);
      let calls = 0;
      const exec: ToolExecutorFn = async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return 'recovered';
      };
      const result = await (executor as unknown as {
        executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
      }).executeStepWithRetry(step, exec);
      expect(result).toBe('recovered');
      expect(calls).toBe(2);
    });

    it('全部失败后抛出错误', async () => {
      const toolName = uniqueToolName('compat_fail');
      const step = makeStep(toolName, 2);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, makeFailExecutor('persistent')),
      ).rejects.toThrow('persistent');
    });

    it('权限错误不重试', async () => {
      const toolName = uniqueToolName('compat_perm');
      const step = makeStep(toolName, 5);
      let calls = 0;
      const exec: ToolExecutorFn = async () => {
        calls++;
        throw new Error('permission denied');
      };
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, exec),
      ).rejects.toThrow('permission denied');
      expect(calls).toBe(1);
    });
  });

  // ============ 启用熔断后 ============

  describe('启用熔断后', () => {
    beforeEach(() => {
      process.env.USE_STEP_CIRCUIT_BREAKER = 'true';
    });

    it('成功时 recordSuccess — breaker 保持 closed', async () => {
      const toolName = uniqueToolName('cb_ok');
      const step = makeStep(toolName);
      const result = await (executor as unknown as {
        executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
      }).executeStepWithRetry(step, makeOkExecutor('ok'));
      expect(result).toBe('ok');
      const breaker = resilienceChain.getCircuitBreaker(`step_${toolName}`);
      expect(breaker.getState()).toBe('closed');
    });

    it('单次失败不熔断 — breaker 保持 closed', async () => {
      const toolName = uniqueToolName('cb_single');
      const step = makeStep(toolName, 0);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, makeFailExecutor('err')),
      ).rejects.toThrow('err');
      const breaker = resilienceChain.getCircuitBreaker(`step_${toolName}`);
      expect(breaker.getState()).toBe('closed');
    });

    it('连续失败 5 次触发熔断 — breaker 变为 open', async () => {
      const toolName = uniqueToolName('cb_trip');
      const exec = makeFailExecutor('always fails');
      for (let i = 0; i < 5; i++) {
        const step = makeStep(toolName, 0);
        await expect(
          (executor as unknown as {
            executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
          }).executeStepWithRetry(step, exec),
        ).rejects.toThrow();
      }
      const breaker = resilienceChain.getCircuitBreaker(`step_${toolName}`);
      expect(breaker.getState()).toBe('open');
    });

    it('熔断 open 时快速失败不执行工具', async () => {
      const toolName = uniqueToolName('cb_fastfail');
      const exec = makeFailExecutor('fail');
      // 先触发熔断
      for (let i = 0; i < 5; i++) {
        const step = makeStep(toolName, 0);
        await expect(
          (executor as unknown as {
            executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
          }).executeStepWithRetry(step, exec),
        ).rejects.toThrow();
      }
      expect(resilienceChain.getCircuitBreaker(`step_${toolName}`).getState()).toBe('open');

      // 再调用应快速失败
      let calls = 0;
      const trackExec: ToolExecutorFn = async () => {
        calls++;
        return 'should not reach';
      };
      const step = makeStep(toolName, 3);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, trackExec),
      ).rejects.toThrow('circuit breaker open');
      expect(calls).toBe(0);
    });

    it('熔断在重试过程中打开时跳过剩余重试', async () => {
      const toolName = uniqueToolName('cb_midopen');
      const exec = makeFailExecutor('always fails');
      // maxRetries=10，但 5 次失败后熔断打开应 break
      const step = makeStep(toolName, 10);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, exec),
      ).rejects.toThrow();
      // 5 次失败后熔断打开，break。attempt=4 时第 5 次 recordFailure 触发 open
      expect(step.retries).toBe(4);
      expect(resilienceChain.getCircuitBreaker(`step_${toolName}`).getState()).toBe('open');
    });

    it('不同工具独立熔断', async () => {
      const toolA = uniqueToolName('cb_indepA');
      const toolB = uniqueToolName('cb_indepB');
      const execFail = makeFailExecutor('fail');
      const execOk = makeOkExecutor('ok');

      // toolA 失败 5 次触发熔断
      for (let i = 0; i < 5; i++) {
        const step = makeStep(toolA, 0);
        await expect(
          (executor as unknown as {
            executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
          }).executeStepWithRetry(step, execFail),
        ).rejects.toThrow();
      }
      expect(resilienceChain.getCircuitBreaker(`step_${toolA}`).getState()).toBe('open');

      // toolB 不受影响
      const stepB = makeStep(toolB);
      const result = await (executor as unknown as {
        executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
      }).executeStepWithRetry(stepB, execOk);
      expect(result).toBe('ok');
      expect(resilienceChain.getCircuitBreaker(`step_${toolB}`).getState()).toBe('closed');
    });
  });

  // ============ 灰度开关 ============

  describe('灰度开关 USE_STEP_CIRCUIT_BREAKER', () => {
    it('未设置时不启用熔断 — 行为与原逻辑一致', async () => {
      delete process.env.USE_STEP_CIRCUIT_BREAKER;
      const toolName = uniqueToolName('env_unset');
      const step = makeStep(toolName, 0);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, makeFailExecutor('err')),
      ).rejects.toThrow('err');
    });

    it('true 时启用熔断', async () => {
      process.env.USE_STEP_CIRCUIT_BREAKER = 'true';
      const toolName = uniqueToolName('env_true');
      const step = makeStep(toolName, 0);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, makeFailExecutor('err')),
      ).rejects.toThrow('err');
      const breaker = resilienceChain.getCircuitBreaker(`step_${toolName}`);
      expect(breaker.getState()).toBe('closed');
    });

    it('显式 false 时不启用熔断', async () => {
      process.env.USE_STEP_CIRCUIT_BREAKER = 'false';
      const toolName = uniqueToolName('env_false');
      const step = makeStep(toolName, 0);
      await expect(
        (executor as unknown as {
          executeStepWithRetry: (s: ExecutionStep, fn: ToolExecutorFn) => Promise<string>;
        }).executeStepWithRetry(step, makeFailExecutor('err')),
      ).rejects.toThrow('err');
    });
  });
});
