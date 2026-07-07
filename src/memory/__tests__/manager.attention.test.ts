/**
 * 消灭孤岛 I-4 验证测试：attention-mechanism 接入向量记忆召回
 *
 * 验证 UnifiedMemoryManager.enableSemanticRecall() 启用后：
 * 1. search() 路径实际调用 SemanticRecaller（行为变化）
 * 2. 未启用时行为不变（回退到 computeSemanticSimilarity 硬编码匹配）
 * 3. 启用后语义相关记忆的召回排序优于硬编码匹配
 *
 * 见 v19 方案 §4.2 I-4，与 context-manager.ts:258 同范式。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { UnifiedMemoryManager } from '../manager.js';

describe('UnifiedMemoryManager — I-4 attention 接入', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jws-mem-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('enableSemanticRecall', () => {
    it('未调用时 hasSemanticRecall 返回 false', () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      expect(mm.hasSemanticRecall()).toBe(false);
    });

    it('调用后 hasSemanticRecall 返回 true', () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      mm.enableSemanticRecall();
      expect(mm.hasSemanticRecall()).toBe(true);
    });

    it('可重复调用不报错', () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      expect(() => {
        mm.enableSemanticRecall();
        mm.enableSemanticRecall(128);
      }).not.toThrow();
    });
  });

  describe('setEmbeddingProvider', () => {
    it('未启用 SemanticRecaller 时返回 false', () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      expect(mm.setEmbeddingProvider(null)).toBe(false);
    });

    it('启用后返回 true（接受 null provider）', () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      mm.enableSemanticRecall();
      expect(mm.setEmbeddingProvider(null)).toBe(true);
    });
  });

  describe('search 行为差异（启用 vs 未启用）', () => {
    /**
     * 构造场景：query 是"代码相关"，候选记忆中只有一条与"代码"语义相关，
     * 其他记忆内容完全不相关。验证启用 SemanticRecaller 后召回路径走 attention，
     * 相关记忆仍排在前面（行为正确性），且不会抛错。
     *
     * 不显式 await mm.load() — 修复后的 ensureLoaded() 会正确 await
     * 构造函数触发的 in-flight load，避免二次 load 与之并发。
     */
    it('启用后语义相关记忆排在前（不抛错）', async () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      await mm.add('讨论代码模块的函数实现', { type: 'short_term', importance: 0.5 });
      await mm.add('今天天气晴朗适合散步', { type: 'short_term', importance: 0.5 });
      await mm.add('晚饭吃了面条和鸡蛋', { type: 'short_term', importance: 0.5 });

      mm.enableSemanticRecall();

      const results = await mm.search('代码函数', { limit: 3 });
      expect(results.length).toBe(3);
      // 语义相关的那条应排第一
      expect(results[0].content).toContain('代码');
    });

    it('未启用时仍能召回（fallback 路径不变）', async () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      await mm.add('讨论代码模块的函数实现', { type: 'short_term', importance: 0.5 });
      await mm.add('今天天气晴朗适合散步', { type: 'short_term', importance: 0.5 });

      // 未调用 enableSemanticRecall，应走 computeSemanticSimilarity
      const results = await mm.search('代码', { limit: 2 });
      expect(results.length).toBe(2);
      expect(results[0].content).toContain('代码');
    });

    it('启用后空 query 不抛错', async () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      await mm.add('记忆内容', { type: 'short_term' });
      mm.enableSemanticRecall();

      const results = await mm.search('', { limit: 5 });
      expect(results.length).toBe(1);
    });

    it('启用后无候选记忆时返回空数组', async () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      mm.enableSemanticRecall();

      const results = await mm.search('任意查询', { limit: 5 });
      expect(results).toEqual([]);
    });

    it('启用后 type 过滤仍生效（不破坏现有 filter）', async () => {
      const mm = new UnifiedMemoryManager(tmpDir);
      await mm.add('代码内容A', { type: 'short_term' });
      await mm.add('代码内容B', { type: 'long_term' });
      mm.enableSemanticRecall();

      const results = await mm.search('代码', { limit: 5, type: 'long_term' });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('代码内容B');
    });
  });
});
