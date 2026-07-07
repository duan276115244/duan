/**
 * P0-1: 5 层 Compaction 系统 + 三级阈值 + 熔断器 测试
 *
 * 对标 Claude Code 的上下文管理机制：
 * - 三级阈值：70% 自动压缩 / 90% 警告 / 98% 阻断
 * - 熔断器：连续失败 3 次后开启，5 分钟后半开
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CompactionSystem,
  THREE_LEVEL_THRESHOLDS,
  CIRCUIT_BREAKER_CONFIG,
  type CompactionMessage,
} from '../compaction-system.js';

describe('THREE_LEVEL_THRESHOLDS — 三级阈值常量（对标 Claude Code）', () => {
  it('70% 触发自动压缩', () => {
    expect(THREE_LEVEL_THRESHOLDS.COMPACT_THRESHOLD).toBe(0.70);
  });

  it('90% 触发用户警告', () => {
    expect(THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD).toBe(0.90);
  });

  it('98% 阻止新请求', () => {
    expect(THREE_LEVEL_THRESHOLDS.BLOCK_THRESHOLD).toBe(0.98);
  });

  it('阈值递增：compact < warn < block', () => {
    expect(THREE_LEVEL_THRESHOLDS.COMPACT_THRESHOLD).toBeLessThan(THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD);
    expect(THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD).toBeLessThan(THREE_LEVEL_THRESHOLDS.BLOCK_THRESHOLD);
  });
});

describe('CIRCUIT_BREAKER_CONFIG — 熔断器配置（对标 Claude Code）', () => {
  it('连续失败 3 次触发熔断', () => {
    expect(CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_FAILURES).toBe(3);
  });

  it('5 分钟后自动恢复', () => {
    expect(CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

describe('CompactionSystem — 三级阈值状态', () => {
  let system: CompactionSystem;

  beforeEach(() => {
    // 使用 2000 tokens 窗口便于精确控制阈值
    system = new CompactionSystem({
      contextWindowSize: 2000,
      autoCompact: false, // 禁用自动压缩，手动控制
    });
  });

  afterEach(() => {
    system.dispose();
  });

  it('空系统使用率为 0，级别为 normal', () => {
    const status = system.getThresholdStatus();
    expect(status.usage).toBe(0);
    expect(status.level).toBe('normal');
    expect(status.recommendedAction).toBe('continue');
  });

  it('使用率 < 70% 时级别为 normal', () => {
    // 添加少量消息（约 150 tokens < 1400 = 70%）
    system.addMessage({ role: 'user', content: '你好，请帮我写一个函数' });
    const status = system.getThresholdStatus();
    expect(status.usage).toBeLessThan(THREE_LEVEL_THRESHOLDS.COMPACT_THRESHOLD);
    expect(status.level).toBe('normal');
  });

  it('使用率 ≥ 70% 时建议压缩（compact）', () => {
    // 1 条消息：Layer1(~1300 tokens) + Layer4(~125 tokens) ≈ 1429 tokens ≈ 71.5%
    // content = 5200 chars → 1300 tokens (Layer1) + 500 chars → 125 tokens (Layer4)
    system.addMessage({ role: 'assistant', content: 'x'.repeat(5200) });
    const status = system.getThresholdStatus();
    expect(status.usage).toBeGreaterThanOrEqual(THREE_LEVEL_THRESHOLDS.COMPACT_THRESHOLD);
    expect(status.usage).toBeLessThan(THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD);
    expect(status.recommendedAction).toBe('compact');
  });

  it('使用率 ≥ 90% 时级别为 warn', () => {
    // content = 6800 chars → 1700 tokens (Layer1) + 125 tokens (Layer4) ≈ 1829 ≈ 91.5%
    system.addMessage({ role: 'assistant', content: 'x'.repeat(6800) });
    const status = system.getThresholdStatus();
    expect(status.usage).toBeGreaterThanOrEqual(THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD);
    expect(status.usage).toBeLessThan(THREE_LEVEL_THRESHOLDS.BLOCK_THRESHOLD);
    expect(status.level).toBe('warn');
    expect(status.recommendedAction).toBe('warn_user');
  });

  it('使用率 ≥ 98% 时级别为 block', () => {
    // content = 7400 chars → 1850 tokens (Layer1) + 125 tokens (Layer4) ≈ 1979 ≈ 99%
    system.addMessage({ role: 'assistant', content: 'x'.repeat(7400) });
    const status = system.getThresholdStatus();
    expect(status.usage).toBeGreaterThanOrEqual(THREE_LEVEL_THRESHOLDS.BLOCK_THRESHOLD);
    expect(status.level).toBe('block');
    expect(status.recommendedAction).toBe('block');
  });
});

describe('CompactionSystem — 熔断器', () => {
  let system: CompactionSystem;

  beforeEach(() => {
    system = new CompactionSystem({ autoCompact: false });
  });

  afterEach(() => {
    system.dispose();
  });

  it('初始状态熔断器关闭', () => {
    const status = system.getCircuitBreakerStatus();
    expect(status.isOpen).toBe(false);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.maxFailures).toBe(CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_FAILURES);
  });

  it('压缩成功后重置失败计数', async () => {
    // 添加消息然后压缩
    system.addMessage({ role: 'user', content: '测试消息' });
    system.addMessage({ role: 'assistant', content: '回复' });

    // 手动触发 getContext（成功路径）
    await system.getContext(1000);

    const status = system.getCircuitBreakerStatus();
    expect(status.consecutiveFailures).toBe(0);
    expect(status.isOpen).toBe(false);
  });
});

describe('CompactionSystem — 消息管理与压缩', () => {
  let system: CompactionSystem;

  beforeEach(() => {
    system = new CompactionSystem({
      contextWindowSize: 5000,
      autoCompact: false,
    });
  });

  afterEach(() => {
    system.dispose();
  });

  it('addMessage 后消息进入 Layer 1', () => {
    const msg: CompactionMessage = {
      id: 'test-1',
      role: 'user',
      content: '测试消息',
      timestamp: Date.now(),
    };
    system.addMessage(msg);

    const stats = system.getStats();
    expect(stats.layer1MessageCount).toBe(1);
  });

  it('系统消息重要性默认为 10', () => {
    system.addMessage({ role: 'system', content: '系统提示' });
    const stats = system.getStats();
    expect(stats.layer1MessageCount).toBe(1);
  });

  it('getContext 在 token 预算内返回压缩上下文', async () => {
    // 添加多条消息
    for (let i = 0; i < 10; i++) {
      system.addMessage({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `这是第 ${i} 条消息，包含一些内容用于测试压缩功能。`,
        timestamp: Date.now() + i,
      });
    }

    const result = await system.getContext(500);
    expect(result.messages).toBeDefined();
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeLessThanOrEqual(500);
    expect(result.tokenBudget).toBe(500);
  });

  it('多次 addMessage 后统计正确', () => {
    for (let i = 0; i < 5; i++) {
      system.addMessage({
        role: 'user',
        content: `消息 ${i}`,
      });
    }
    const stats = system.getStats();
    expect(stats.layer1MessageCount).toBe(5);
    expect(stats.totalTokens).toBeGreaterThan(0);
  });
});

describe('CompactionSystem — 自动压缩触发', () => {
  it('autoCompact=true 时 70% 自动触发压缩', () => {
    const system = new CompactionSystem({
      contextWindowSize: 500,
      autoCompact: true,
    });

    // spy forceCompaction
    const spy = vi.spyOn(system as any, 'forceCompaction').mockResolvedValue(undefined);

    // 添加消息使使用率超过 70%
    const bigContent = 'x'.repeat(1000);
    system.addMessage({ role: 'assistant', content: bigContent });

    expect(spy).toHaveBeenCalled();
    system.dispose();
  });

  it('autoCompact=false 时不自动触发压缩', () => {
    const system = new CompactionSystem({
      contextWindowSize: 500,
      autoCompact: false,
    });

    const spy = vi.spyOn(system as any, 'forceCompaction').mockResolvedValue(undefined);

    const bigContent = 'x'.repeat(1000);
    system.addMessage({ role: 'assistant', content: bigContent });

    expect(spy).not.toHaveBeenCalled();
    system.dispose();
  });
});

describe('CompactionSystem — 98% 阻断保护', () => {
  it('autoCompact=true 且使用率 ≥ 98% 时 addMessage 抛出错误', () => {
    const system = new CompactionSystem({
      contextWindowSize: 200,
      autoCompact: true,
    });

    // mock forceCompaction 避免实际压缩
    vi.spyOn(system as any, 'forceCompaction').mockResolvedValue(undefined);

    // 填满到 98% 以上
    const bigContent = 'x'.repeat(1000);
    expect(() => {
      system.addMessage({ role: 'assistant', content: bigContent });
    }).toThrow(/上下文已满/);

    system.dispose();
  });
});

describe('CompactionSystem — dispose 生命周期', () => {
  it('dispose 后 addMessage 抛出错误', () => {
    const system = new CompactionSystem();
    system.dispose();
    expect(() => system.addMessage({ role: 'user', content: 'test' })).toThrow(/已释放/);
  });

  it('dispose 后 getContext 抛出错误', async () => {
    const system = new CompactionSystem();
    system.dispose();
    await expect(system.getContext(1000)).rejects.toThrow(/已释放/);
  });
});
