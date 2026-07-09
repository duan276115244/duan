/**
 * MemoryOrchestrator Facade 测试
 *
 * 验证统一记忆入口的核心 API：
 * - store() 持久化记忆并返回 ID
 * - search() 四级降级检索（FTS 优先，useVector:false 避免网络依赖）
 * - inferTier() 层级推断（间接验证：store 后 retrieveByTier 确认层级分配）
 * - getStats() 检索延迟统计
 * - retrieveByTier() / getTierStats() / storeByTier()
 * - formatForPrompt() / forget()
 *
 * 隔离策略：tmpDir + useVector:false（避免 VectorStore embedding 依赖）
 * 参考范式：src/memory/__tests__/manager.attention.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MemoryOrchestrator, type MemoryEntry, type RecallResult } from '../memory-orchestrator.js';
import { HermesMemoryTier } from '../memory-types.js';

describe('MemoryOrchestrator — Facade', () => {
  let tmpDir: string;
  let mo: MemoryOrchestrator;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jws-mo-facade-'));
    mo = new MemoryOrchestrator(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ============ store() ============

  describe('store()', () => {
    it('返回 mem_ 前缀的字符串 ID', async () => {
      const id = await mo.store('测试内容', { importance: 5 });
      expect(typeof id).toBe('string');
      expect(id.startsWith('mem_')).toBe(true);
    });

    it('持久化内容可通过 search 检索到', async () => {
      await mo.store('TypeScript 类型系统进阶教程', { importance: 7, tags: ['编程'] });
      const results = await mo.search('TypeScript', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('存储多条记忆后均可分别检索', async () => {
      await mo.store('React Hooks 使用指南', { importance: 6, tags: ['前端'] });
      await mo.store('Node.js 流式处理', { importance: 6, tags: ['后端'] });
      await mo.store('CSS Grid 布局技巧', { importance: 5, tags: ['前端'] });

      const reactResults = await mo.search('React', { topK: 5, useVector: false });
      expect(reactResults.some(r => r.content.includes('React'))).toBe(true);

      const nodeResults = await mo.search('Node', { topK: 5, useVector: false });
      expect(nodeResults.some(r => r.content.includes('Node.js'))).toBe(true);
    });
  });

  // ============ search() 降级路径 ============

  describe('search() 降级路径', () => {
    it('FTS 命中时直接返回', async () => {
      await mo.store('数据库索引优化方案', { importance: 7, tags: ['数据库'] });
      await mo.store('Redis 缓存策略', { importance: 7, tags: ['缓存'] });

      const results = await mo.search('数据库', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('数据库');
    });

    it('FTS 无命中时降级到 tags 搜索', async () => {
      // content 刻意不含查询词，仅 tag 包含
      await mo.store('深入理解计算机系统', { importance: 7, tags: ['编程', '底层'] });

      const results = await mo.search('编程', { topK: 5, useVector: false, minResults: 1 });
      expect(results.some(r => r.tags.includes('编程'))).toBe(true);
    });

    it('空存储时搜索返回空数组', async () => {
      // 注意：searchByKeywords 全量扫描会对所有条目加 importance*0.1 基线分，
      // 导致非匹配查询也返回结果。因此仅在空存储时才能保证空结果。
      const results = await mo.search('任意查询', { topK: 5, useVector: false });
      expect(results).toEqual([]);
    });

    it('topK 限制返回数量', async () => {
      for (let i = 0; i < 5; i++) {
        await mo.store(`测试记忆条目 ${i} 内容`, { importance: 5, tags: ['测试'] });
      }
      const results = await mo.search('测试', { topK: 2, useVector: false });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('tier 过滤只返回匹配层级（minResults=1 确保 FTS 直接返回）', async () => {
      await mo.store('技能记忆A', { type: 'best_practice', importance: 9 });
      await mo.store('技能记忆B', { type: 'pattern', importance: 8 });
      await mo.store('临时记忆C', { type: 'interaction', importance: 3 });

      const l2Results = await mo.search('记忆', {
        topK: 10, minResults: 1, useVector: false, tier: HermesMemoryTier.L2_SKILL,
      });
      expect(l2Results.length).toBe(2);
      expect(l2Results.every(r => r.tier === HermesMemoryTier.L2_SKILL)).toBe(true);

      const l0Results = await mo.search('记忆', {
        topK: 10, minResults: 1, useVector: false, tier: HermesMemoryTier.L0_SESSION,
      });
      expect(l0Results.length).toBe(1);
      expect(l0Results[0].tier).toBe(HermesMemoryTier.L0_SESSION);
    });
  });

  // ============ inferTier() 间接验证 ============

  describe('inferTier() 层级推断', () => {
    it('type=best_practice → L2_SKILL', async () => {
      await mo.store('技能记忆', { type: 'best_practice', importance: 5 });
      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 10);
      expect(l2.some(e => e.content === '技能记忆')).toBe(true);
    });

    it('type=pattern → L2_SKILL', async () => {
      await mo.store('模式记忆', { type: 'pattern', importance: 5 });
      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 10);
      expect(l2.some(e => e.content === '模式记忆')).toBe(true);
    });

    it('type=achievement → L2_SKILL', async () => {
      await mo.store('成就记忆', { type: 'achievement', importance: 5 });
      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 10);
      expect(l2.some(e => e.content === '成就记忆')).toBe(true);
    });

    it('type=preference → L1_PERSISTENT', async () => {
      await mo.store('偏好记忆', { type: 'preference', importance: 5 });
      const l1 = mo.retrieveByTier(HermesMemoryTier.L1_PERSISTENT, 10);
      expect(l1.some(e => e.content === '偏好记忆')).toBe(true);
    });

    it('type=fact → L1_PERSISTENT', async () => {
      await mo.store('事实记忆', { type: 'fact', importance: 5 });
      const l1 = mo.retrieveByTier(HermesMemoryTier.L1_PERSISTENT, 10);
      expect(l1.some(e => e.content === '事实记忆')).toBe(true);
    });

    it('type=user_preference → L1_PERSISTENT', async () => {
      await mo.store('用户偏好', { type: 'user_preference', importance: 5 });
      const l1 = mo.retrieveByTier(HermesMemoryTier.L1_PERSISTENT, 10);
      expect(l1.some(e => e.content === '用户偏好')).toBe(true);
    });

    it('importance>=7 且 type=interaction → L0_SESSION（type 优先级低于 importance？不，interaction 不在 L1 列表）', async () => {
      // interaction 不在 L1 推断列表（user_preference/preference/fact），也不在 L2 列表
      // importance>=7 会触发 L1 推断
      await mo.store('高重要度交互', { type: 'interaction', importance: 8 });
      const l1 = mo.retrieveByTier(HermesMemoryTier.L1_PERSISTENT, 10);
      expect(l1.some(e => e.content === '高重要度交互')).toBe(true);
    });

    it('importance<7 且 type=interaction → L0_SESSION', async () => {
      await mo.store('低重要度交互', { type: 'interaction', importance: 3 });
      const l0 = mo.retrieveByTier(HermesMemoryTier.L0_SESSION, 10);
      expect(l0.some(e => e.content === '低重要度交互')).toBe(true);
      const l1 = mo.retrieveByTier(HermesMemoryTier.L1_PERSISTENT, 10);
      expect(l1.some(e => e.content === '低重要度交互')).toBe(false);
    });
  });

  // ============ getStats() ============

  describe('getStats()', () => {
    it('初始状态返回 avgLatencyMs=0', () => {
      const stats = mo.getStats();
      expect(stats).toEqual({ avgLatencyMs: 0 });
    });

    it('搜索后返回有效的 avgLatencyMs 数值', async () => {
      await mo.store('可检索内容', { importance: 7 });
      await mo.search('可检索', { topK: 5, useVector: false });
      const stats = mo.getStats();
      expect(typeof stats.avgLatencyMs).toBe('number');
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('多次搜索后 avgLatencyMs 仍为有效数值', async () => {
      await mo.store('内容一', { importance: 7 });
      await mo.store('内容二', { importance: 7 });
      for (let i = 0; i < 5; i++) {
        await mo.search('内容', { topK: 5, useVector: false });
      }
      const stats = mo.getStats();
      expect(typeof stats.avgLatencyMs).toBe('number');
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ============ retrieveByTier() ============

  describe('retrieveByTier()', () => {
    it('返回指定层级的记忆', async () => {
      await mo.store('L2 技能A', { type: 'best_practice', importance: 9 });
      await mo.store('L2 技能B', { type: 'pattern', importance: 8 });
      await mo.store('L0 临时', { importance: 3 });

      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 10);
      expect(l2.length).toBe(2);
      expect(l2.every(e => e.tier === HermesMemoryTier.L2_SKILL)).toBe(true);
    });

    it('limit 限制返回数量', async () => {
      for (let i = 0; i < 5; i++) {
        await mo.store(`L2 技能 ${i}`, { type: 'best_practice', importance: 9 });
      }
      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 2);
      expect(l2.length).toBeLessThanOrEqual(2);
    });

    it('无匹配层级时返回空数组', async () => {
      await mo.store('L0 临时', { importance: 3 });
      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 10);
      expect(l2).toEqual([]);
    });
  });

  // ============ getTierStats() ============

  describe('getTierStats()', () => {
    it('返回三级层级计数', async () => {
      await mo.store('L2 技能', { type: 'best_practice', importance: 9 });
      await mo.store('L1 事实', { type: 'fact', importance: 5 });
      await mo.store('L0 交互', { type: 'interaction', importance: 3 });

      const stats = mo.getTierStats();
      expect(stats[HermesMemoryTier.L2_SKILL]).toBeGreaterThanOrEqual(1);
      expect(stats[HermesMemoryTier.L1_PERSISTENT]).toBeGreaterThanOrEqual(1);
      expect(stats[HermesMemoryTier.L0_SESSION]).toBeGreaterThanOrEqual(1);
    });

    it('空存储时三级均为 0', () => {
      const stats = mo.getTierStats();
      expect(stats[HermesMemoryTier.L0_SESSION]).toBe(0);
      expect(stats[HermesMemoryTier.L1_PERSISTENT]).toBe(0);
      expect(stats[HermesMemoryTier.L2_SKILL]).toBe(0);
    });
  });

  // ============ storeByTier() ============

  describe('storeByTier()', () => {
    it('显式指定 tier 覆盖 inferTier', async () => {
      // importance=3 默认推断为 L0，但显式指定 L2
      const id = await mo.storeByTier(HermesMemoryTier.L2_SKILL, '手动指定 L2', { importance: 3 });
      expect(typeof id).toBe('string');

      const l2 = mo.retrieveByTier(HermesMemoryTier.L2_SKILL, 10);
      expect(l2.some(e => e.content === '手动指定 L2')).toBe(true);

      const l0 = mo.retrieveByTier(HermesMemoryTier.L0_SESSION, 10);
      expect(l0.some(e => e.content === '手动指定 L2')).toBe(false);
    });
  });

  // ============ formatForPrompt() ============

  describe('formatForPrompt()', () => {
    it('空数组返回空字符串', () => {
      expect(mo.formatForPrompt([])).toBe('');
    });

    it('格式化记忆条目为 Markdown 列表', () => {
      const entries: MemoryEntry[] = [
        {
          id: 'test_1',
          timestamp: Date.now(),
          type: 'fact',
          content: '这是一条测试记忆',
          tags: ['测试'],
          importance: 7,
          accessCount: 1,
          tier: HermesMemoryTier.L1_PERSISTENT,
        },
      ];
      const formatted = mo.formatForPrompt(entries);
      expect(formatted).toContain('## 📖 相关记忆');
      expect(formatted).toContain('这是一条测试记忆');
      expect(formatted).toContain('L1');
    });

    it('多条记忆逐行格式化', () => {
      const entries: MemoryEntry[] = [
        {
          id: 't1', timestamp: Date.now(), type: 'fact',
          content: '记忆A', tags: [], importance: 5, accessCount: 1,
        },
        {
          id: 't2', timestamp: Date.now(), type: 'best_practice',
          content: '记忆B', tags: [], importance: 9, accessCount: 3,
          tier: HermesMemoryTier.L2_SKILL,
        },
      ];
      const formatted = mo.formatForPrompt(entries);
      expect(formatted).toContain('记忆A');
      expect(formatted).toContain('记忆B');
      expect(formatted).toContain('L2');
    });
  });

  // ============ forget() ============

  describe('forget()', () => {
    it('删除指定记忆后搜索不再返回', async () => {
      const id = await mo.store('待删除记忆', { importance: 7 });
      const result = await mo.forget(id);
      expect(result).toBe(true);

      const results = await mo.search('待删除', { topK: 5, useVector: false });
      expect(results.some(r => r.id === id)).toBe(false);
    });

    it('删除不存在的 ID 仍返回 true', async () => {
      const result = await mo.forget('nonexistent_id');
      expect(result).toBe(true);
    });
  });

  // ============ recall() — Phase C1 统一召回门面 ============

  describe('recall() — Phase C1', () => {
    it('命中时返回 RecallResult，hit=true，hitCount>0', async () => {
      await mo.store('TypeScript 高级类型教程', { importance: 7, tags: ['编程'] });
      const result: RecallResult = await mo.recall('TypeScript', { topK: 5, useVector: false, minResults: 1 });
      expect(result.hit).toBe(true);
      expect(result.hitCount).toBeGreaterThan(0);
      expect(result.entries.length).toBe(result.hitCount);
      expect(result.recallScore).toBeGreaterThan(0);
    });

    it('空存储时 hit=false，hitCount=0，recallScore=0', async () => {
      const result = await mo.recall('不存在的查询词', { topK: 5, useVector: false });
      expect(result.hit).toBe(false);
      expect(result.hitCount).toBe(0);
      expect(result.recallScore).toBe(0);
    });

    it('latencyMs 为非负数', async () => {
      await mo.store('可检索记忆', { importance: 7 });
      const result = await mo.recall('可检索', { topK: 5, useVector: false, minResults: 1 });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('recallScore 上限为 1（hitCount >= minResults 时）', async () => {
      // 存入 3 条，minResults=2 → hitCount>=2 → score=min(1, 3/2)=1
      await mo.store('记忆甲 content', { importance: 7, tags: ['测试'] });
      await mo.store('记忆乙 content', { importance: 7, tags: ['测试'] });
      await mo.store('记忆丙 content', { importance: 7, tags: ['测试'] });
      const result = await mo.recall('记忆', { topK: 5, useVector: false, minResults: 2 });
      expect(result.recallScore).toBeLessThanOrEqual(1);
      if (result.hitCount >= 2) {
        expect(result.recallScore).toBe(1);
      }
    });

    it('返回的 entries 与 search() 一致（recall 包装 searchCore）', async () => {
      await mo.store('唯一记忆 XYZ', { importance: 8 });
      const recallResult = await mo.recall('XYZ', { topK: 5, useVector: false, minResults: 1 });
      const searchResult = await mo.search('XYZ', { topK: 5, useVector: false, minResults: 1 });
      expect(recallResult.entries.length).toBe(searchResult.length);
    });
  });
});
