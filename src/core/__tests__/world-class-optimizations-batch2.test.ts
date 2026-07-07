/**
 * 第二批优化模块测试 — 验证世界级 Agent 优化组件
 *
 * 覆盖：
 * - IntelligentErrorRecovery（智能错误恢复）
 * - ToolOrchestrationEngine（工具编排引擎）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IntelligentErrorRecovery,
} from '../intelligent-error-recovery.js';
import {
  ToolOrchestrationEngine,
  type OrchestrationStep,
} from '../tool-orchestration-engine.js';

// ============ IntelligentErrorRecovery 测试 ============

describe('IntelligentErrorRecovery', () => {
  let recovery: IntelligentErrorRecovery;

  beforeEach(() => {
    recovery = new IntelligentErrorRecovery();
  });

  it('应该分类网络错误', () => {
    const errorInfo = recovery.createErrorInfo(
      { message: 'connect ECONNREFUSED 127.0.0.1:3000', code: 'ECONNREFUSED' },
      'http_client',
    );
    expect(errorInfo.type).toBe('network');
  });

  it('应该分类权限错误', () => {
    const errorInfo = recovery.createErrorInfo(
      { message: 'permission denied', code: 'EACCES' },
      'file_read',
    );
    expect(errorInfo.type).toBe('permission');
  });

  it('应该分类资源错误', () => {
    const errorInfo = recovery.createErrorInfo(
      { message: 'ENOENT: no such file', code: 'ENOENT' },
      'file_read',
    );
    expect(errorInfo.type).toBe('resource');
  });

  it('应该选择正确的恢复策略', () => {
    const analysis = recovery.analyzeError(
      recovery.createErrorInfo({ message: 'ECONNREFUSED' }, 'http'),
    );
    expect(analysis.type).toBe('network');
    expect(analysis.strategy).toBe('retry_with_backoff');
  });

  it('应该对权限错误选择上报策略', () => {
    const analysis = recovery.analyzeError(
      recovery.createErrorInfo({ message: 'permission denied' }, 'file'),
    );
    expect(analysis.strategy).toBe('escalate');
  });

  it('应该执行重试恢复', async () => {
    let attempts = 0;
    const retryFn = async () => {
      attempts++;
      if (attempts < 2) throw new Error('still failing');
      return 'success';
    };

    const errorInfo = recovery.createErrorInfo({ message: 'ECONNREFUSED' }, 'test');
    const result = await recovery.recover(errorInfo, retryFn);

    expect(result.recovered).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.result).toBe('success');
  });

  it('应该在重试耗尽后失败', async () => {
    const retryFn = async () => {
      throw new Error('always fails');
    };

    const errorInfo = recovery.createErrorInfo({ message: 'ECONNREFUSED' }, 'test');
    const result = await recovery.recover(errorInfo, retryFn);

    expect(result.recovered).toBe(false);
  });

  it('应该执行替代方案', async () => {
    const altFn = async () => 'alternative result';
    const errorInfo = recovery.createErrorInfo({ message: 'ENOENT: no such file' }, 'file_read');
    const result = await recovery.recover(errorInfo, undefined, altFn);

    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('alternative');
    expect(result.result).toBe('alternative result');
  });

  it('应该统计恢复率', async () => {
    const retryFn = async () => 'ok';
    await recovery.recover(
      recovery.createErrorInfo({ message: 'ECONNREFUSED' }, 'test'),
      retryFn,
    );

    const stats = recovery.getStats();
    expect(stats.totalErrors).toBe(1);
    expect(stats.recoveredErrors).toBe(1);
    expect(stats.recoveryRate).toBe(1);
  });
});

// ============ ToolOrchestrationEngine 测试 ============

describe('ToolOrchestrationEngine', () => {
  let engine: ToolOrchestrationEngine;

  beforeEach(() => {
    engine = new ToolOrchestrationEngine();
  });

  it('应该执行工具管道', async () => {
    const steps: OrchestrationStep[] = [
      { id: 'step1', type: 'tool', toolName: 'read', args: { path: '/test' }, resultKey: 'content', onError: 'abort' },
      { id: 'step2', type: 'tool', toolName: 'process', args: { data: '{{results.content}}' }, resultKey: 'processed', onError: 'abort' },
    ];

    const executor = async (name: string, args: any) => {
      if (name === 'read') return 'file content';
      if (name === 'process') return `processed: ${args.data}`;
      return null;
    };

    const result = await engine.orchestrate(steps, {}, executor);

    expect(result.success).toBe(true);
    expect(result.context.results.content).toBe('file content');
    expect(result.context.results.processed).toBe('processed: file content');
  });

  it('应该执行并行步骤', async () => {
    const steps: OrchestrationStep[] = [
      {
        id: 'parallel',
        type: 'parallel',
        parallelSteps: [
          { id: 'p1', type: 'tool', toolName: 'task1', args: {}, onError: 'continue' },
          { id: 'p2', type: 'tool', toolName: 'task2', args: {}, onError: 'continue' },
        ],
        resultKey: 'parallelResults',
        onError: 'continue',
      },
    ];

    const executor = async (name: string) => `result-${name}`;
    const result = await engine.orchestrate(steps, {}, executor);

    expect(result.success).toBe(true);
    expect(result.context.results.parallelResults).toHaveLength(2);
  });

  it('应该执行条件分支', async () => {
    const steps: OrchestrationStep[] = [
      {
        id: 'check',
        type: 'conditional',
        condition: (ctx) => ctx.input.shouldRun === true,
        trueSteps: [
          { id: 'run', type: 'tool', toolName: 'execute', args: {}, resultKey: 'executed', onError: 'abort' },
        ],
        falseSteps: [
          { id: 'skip', type: 'tool', toolName: 'noop', args: {}, resultKey: 'skipped', onError: 'abort' },
        ],
      },
    ];

    const executor = async (name: string) => `done-${name}`;

    const resultTrue = await engine.orchestrate(steps, { shouldRun: true }, executor);
    expect(resultTrue.context.results.executed).toBe('done-execute');

    const resultFalse = await engine.orchestrate(steps, { shouldRun: false }, executor);
    expect(resultFalse.context.results.skipped).toBe('done-noop');
  });

  it('应该处理工具失败', async () => {
    const steps: OrchestrationStep[] = [
      { id: 'fail', type: 'tool', toolName: 'fail', args: {}, resultKey: 'result', onError: 'abort' },
    ];

    const executor = async () => {
      throw new Error('tool failed');
    };

    const result = await engine.orchestrate(steps, {}, executor);

    expect(result.success).toBe(false);
    expect(result.error).toContain('abort');
  });

  it('应该支持模板执行', async () => {
    // 注册自定义模板
    engine.registerTemplate({
      id: 'custom-template',
      name: '自定义模板',
      description: '测试模板',
      steps: [
        { id: 'step1', type: 'tool', toolName: 'echo', args: { msg: '{{input.message}}' }, resultKey: 'echo', onError: 'abort' },
      ],
    });

    const executor = async (name: string, args: any) => args.msg;
    const result = await engine.orchestrateWithTemplate('custom-template', { message: 'hello' }, executor);

    expect(result.success).toBe(true);
    expect(result.context.results.echo).toBe('hello');
  });

  it('应该解析参数引用', async () => {
    const steps: OrchestrationStep[] = [
      { id: 's1', type: 'tool', toolName: 'get', args: {}, resultKey: 'value', onError: 'abort' },
      { id: 's2', type: 'tool', toolName: 'use', args: { val: '{{results.value}}' }, resultKey: 'used', onError: 'abort' },
    ];

    const executor = async (name: string, args: any) => {
      if (name === 'get') return 42;
      return args.val;
    };

    const result = await engine.orchestrate(steps, {}, executor);
    expect(result.context.results.used).toBe(42);
  });
});
