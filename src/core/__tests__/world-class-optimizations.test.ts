/**
 * 新增优化模块测试 — 验证世界级 Agent 优化组件
 *
 * 覆盖：
 * - PromptCache（三层 prompt 缓存）
 * - StructuredOutputEnforcer（结构化输出约束）
 * - ToolResultCache（工具结果缓存）
 * - ReasoningChainVerifier（推理链验证器）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PromptCache,
  resetPromptCache,
} from '../prompt-cache.js';
import {
  StructuredOutputEnforcer,
  resetStructuredOutputEnforcer,
  type ToolSchema,
} from '../structured-output-enforcer.js';
import {
  ToolResultCache,
  resetToolResultCache,
} from '../tool-result-cache.js';
import {
  ReasoningChainVerifier,
  type ReasoningStep,
} from '../reasoning-chain-verifier.js';

// ============ PromptCache 测试 ============

describe('PromptCache', () => {
  let cache: PromptCache;

  beforeEach(() => {
    resetPromptCache();
    cache = new PromptCache();
  });

  it('应该缓存稳定层内容', async () => {
    let buildCount = 0;
    const builder = () => {
      buildCount++;
      return 'stable content';
    };

    const r1 = await cache.getOrBuild('stable', 'system-prompt', builder);
    const r2 = await cache.getOrBuild('stable', 'system-prompt', builder);

    expect(buildCount).toBe(1); // 只构建一次
    expect(r1.content).toBe('stable content');
    expect(r2.content).toBe('stable content');
    expect(r2.hitCount).toBe(1);
  });

  it('应该区分不同层的 TTL', async () => {
    const stableBuilder = () => 'stable';
    const volatileBuilder = () => `volatile-${Date.now()}`;

    await cache.getOrBuild('stable', 'key1', stableBuilder);
    await cache.getOrBuild('volatile', 'key1', volatileBuilder);

    const stats = cache.getStats();
    expect(stats.cacheSize.stable).toBe(1);
    expect(stats.cacheSize.volatile).toBe(1);
  });

  it('应该支持三层组装', async () => {
    const result = await cache.assemble(
      () => 'stable layer',
      () => 'context layer',
      () => 'volatile layer',
    );

    expect(result.content).toContain('stable layer');
    expect(result.content).toContain('context layer');
    expect(result.content).toContain('volatile layer');
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('应该支持失效操作', async () => {
    await cache.getOrBuild('stable', 'key1', () => 'content1');
    cache.invalidate('stable', 'key1');

    const stats = cache.getStats();
    expect(stats.cacheSize.stable).toBe(0);
  });

  it('应该统计命中率', async () => {
    await cache.getOrBuild('stable', 'key1', () => 'content');
    await cache.getOrBuild('stable', 'key1', () => 'content'); // 命中
    await cache.getOrBuild('stable', 'key1', () => 'content'); // 命中

    const stats = cache.getStats();
    expect(stats.hitsByLayer.stable).toBe(2);
    expect(stats.missesByLayer.stable).toBe(1);
    expect(stats.hitRateByLayer.stable).toBeCloseTo(2 / 3, 1);
  });
});

// ============ StructuredOutputEnforcer 测试 ============

describe('StructuredOutputEnforcer', () => {
  let enforcer: StructuredOutputEnforcer;

  beforeEach(() => {
    resetStructuredOutputEnforcer();
    enforcer = new StructuredOutputEnforcer();
  });

  const testSchema: ToolSchema = {
    name: 'test_tool',
    description: '测试工具',
    parameters: {
      path: { type: 'string', required: true, description: '文件路径' },
      mode: { type: 'enum', enum: ['read', 'write'], required: true, description: '模式' },
      count: { type: 'integer', required: false, default: 1, description: '数量' },
    },
  };

  it('应该严格解析合法 JSON', () => {
    const result = enforcer.parseToolCallArgs('{"path": "/test", "mode": "read"}', testSchema);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('strict');
    expect(result.data.path).toBe('/test');
    expect(result.data.mode).toBe('read');
  });

  it('应该修复尾逗号', () => {
    const result = enforcer.parseToolCallArgs('{"path": "/test", "mode": "read",}', testSchema);
    expect(result.success).toBe(true);
    expect(result.repairs).toContain('移除尾逗号');
  });

  it('应该从代码块提取 JSON', () => {
    const result = enforcer.parseToolCallArgs(
      '```json\n{"path": "/test", "mode": "read"}\n```',
      testSchema,
    );
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('regex');
  });

  it('应该验证枚举值', () => {
    const result = enforcer.parseToolCallArgs('{"path": "/test", "mode": "invalid"}', testSchema);
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('枚举'))).toBe(true);
  });

  it('应该填充默认值', () => {
    const result = enforcer.parseToolCallArgs('{"path": "/test", "mode": "read"}', testSchema);
    expect(result.data.count).toBe(1); // 默认值
  });

  it('应该生成 JSON Schema', () => {
    const schema = enforcer.generateJsonSchema(testSchema);
    expect(schema.type).toBe('object');
    expect(schema.properties.path.type).toBe('string');
    expect(schema.required).toContain('path');
  });
});

// ============ ToolResultCache 测试 ============

describe('ToolResultCache', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    resetToolResultCache();
    cache = new ToolResultCache(100, 10 * 1024 * 1024);
  });

  it('应该缓存幂等工具结果', () => {
    cache.set('read_file', { path: '/test.txt' }, 'file content');

    const result = cache.get('read_file', { path: '/test.txt' });
    expect(result.hit).toBe(true);
    expect(result.result).toBe('file content');
  });

  it('不应该缓存非幂等工具', () => {
    cache.set('write_file', { path: '/test.txt' }, 'written');

    const result = cache.get('write_file', { path: '/test.txt' });
    expect(result.hit).toBe(false);
  });

  it('应该支持文件变更失效', () => {
    cache.set('read_file', { path: '/test.txt' }, 'content');
    cache.set('read_file', { path: '/test.txt', lines: 10 }, 'content with lines');

    const invalidated = cache.invalidateOnFileChange('/test.txt');
    expect(invalidated).toBe(2);

    const result = cache.get('read_file', { path: '/test.txt' });
    expect(result.hit).toBe(false);
  });

  it('应该统计命中率', () => {
    cache.set('read_file', { path: '/a' }, 'a');
    cache.get('read_file', { path: '/a' }); // 命中
    cache.get('read_file', { path: '/a' }); // 命中
    cache.get('read_file', { path: '/b' }); // 未命中

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 1);
  });

  it('应该自动识别可缓存工具', () => {
    // read/list/get/search 开头的工具默认可缓存
    cache.set('list_files', { dir: '/' }, ['file1', 'file2']);
    const result = cache.get('list_files', { dir: '/' });
    expect(result.hit).toBe(true);
  });
});

// ============ ReasoningChainVerifier 测试 ============

describe('ReasoningChainVerifier', () => {
  let verifier: ReasoningChainVerifier;

  beforeEach(() => {
    verifier = new ReasoningChainVerifier();
  });

  it('应该通过有效的推理链', () => {
    const steps: ReasoningStep[] = [
      {
        id: 1,
        description: '前提',
        content: '根据生物学研究，鸟类具有飞行能力',
        conclusion: '鸟类普遍具备飞行的生理结构',
        confidence: 0.9,
      },
      {
        id: 2,
        description: '推导',
        content: '因此，麻雀作为鸟类的一种，也会飞行',
        dependsOn: [1],
        conclusion: '麻雀能够飞行',
        confidence: 0.85,
      },
    ];

    const result = verifier.verifyChain(steps);
    expect(result.passed).toBe(true);
    expect(result.overallConfidence).toBeGreaterThan(0.7);
  });

  it('应该检测循环推理', () => {
    const steps: ReasoningStep[] = [
      {
        id: 1,
        description: '步骤1',
        content: '因为步骤2',
        dependsOn: [2],
        conclusion: 'A',
      },
      {
        id: 2,
        description: '步骤2',
        content: '因为步骤1',
        dependsOn: [1],
        conclusion: 'B',
      },
    ];

    const result = verifier.verifyChain(steps);
    expect(result.allIssues.some(i => i.type === 'circular_reasoning')).toBe(true);
  });

  it('应该检测缺失前提', () => {
    const steps: ReasoningStep[] = [
      {
        id: 1,
        description: '推导',
        content: '基于不存在的步骤',
        dependsOn: [99], // 不存在
        conclusion: '结果',
      },
    ];

    const result = verifier.verifyChain(steps);
    expect(result.allIssues.some(i => i.type === 'missing_premise')).toBe(true);
  });

  it('应该检测绝对化声明', () => {
    const steps: ReasoningStep[] = [
      {
        id: 1,
        description: '声明',
        content: '所有代码总是完美的',
        claims: ['所有代码总是完美的'],
        conclusion: '代码完美',
      },
    ];

    const result = verifier.verifyChain(steps);
    expect(result.allIssues.some(i => i.type === 'unsupported_claim')).toBe(true);
  });

  it('应该计算整体置信度', () => {
    const steps: ReasoningStep[] = [
      { id: 1, description: 's1', content: 'c1', conclusion: 'r1', confidence: 0.9 },
      { id: 2, description: 's2', content: 'c2', conclusion: 'r2', confidence: 0.8 },
    ];

    const result = verifier.verifyChain(steps);
    expect(result.overallConfidence).toBeGreaterThan(0);
    expect(result.overallConfidence).toBeLessThanOrEqual(1);
  });
});
