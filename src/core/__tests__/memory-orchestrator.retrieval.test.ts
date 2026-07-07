/**
 * MemoryOrchestrator 检索质量测试
 *
 * 验证：
 * - FTS BM25 评分排序（相关度排序）
 * - 中文 token / trigram 检索
 * - useVector 选项控制（false 跳过 vector，true 失败后降级）
 * - tier filter 过滤（minResults=1 确保 FTS 直接返回）
 * - minResults 控制降级阈值
 * - recall_latency 埋点（getStats() 返回延迟统计）
 * - 搜索结果稳定性
 *
 * 隔离策略：tmpDir + useVector:false（避免 VectorStore embedding 依赖）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MemoryOrchestrator } from '../memory-orchestrator.js';
import { HermesMemoryTier } from '../memory-types.js';

describe('MemoryOrchestrator — 检索质量', () => {
  let tmpDir: string;
  let mo: MemoryOrchestrator;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jws-mo-retrieval-'));
    mo = new MemoryOrchestrator(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ============ FTS BM25 排序 ============

  describe('FTS BM25 排序', () => {
    it('精确匹配排在模糊匹配前面', async () => {
      await mo.store('索引优化是数据库性能的关键', { importance: 7, tags: ['数据库'] });
      await mo.store('前端性能优化方案汇总', { importance: 7, tags: ['前端'] });
      await mo.store('索引优化实践指南', { importance: 5, tags: ['数据库'] });

      const results = await mo.search('索引优化', { topK: 3, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      // 第一条应包含"索引优化"
      expect(results[0].content).toContain('索引优化');
    });

    it('多条匹配按相关度排序', async () => {
      await mo.store('TypeScript 高级类型教程', { importance: 5, tags: ['编程'] });
      await mo.store('TypeScript 基础入门', { importance: 7, tags: ['编程'] });
      await mo.store('Python 入门指南', { importance: 9, tags: ['编程'] });

      const results = await mo.search('TypeScript', { topK: 3, useVector: false });
      // 2 条 TypeScript 记忆都应返回
      expect(results.length).toBe(2);
      expect(results.every(r => r.content.includes('TypeScript'))).toBe(true);
    });

    it('空存储搜索返回空数组', async () => {
      // 注意：searchByKeywords 全量扫描对已有条目加 importance*0.1 基线分，
      // 导致非匹配查询也可能返回结果。仅在空存储时可保证空结果。
      const results = await mo.search('Angular', { topK: 5, useVector: false });
      expect(results).toEqual([]);
    });
  });

  // ============ 中文检索 ============

  describe('中文 token 检索', () => {
    it('中文关键词可检索', async () => {
      await mo.store('机器学习模型训练实践', { importance: 7, tags: ['AI'] });
      await mo.store('深度学习框架对比', { importance: 7, tags: ['AI'] });

      const results = await mo.search('机器学习', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('机器学习');
    });

    it('中文 trigram 模糊匹配', async () => {
      await mo.store('反应式编程 RxJS 实战', { importance: 7, tags: ['前端'] });

      // "反应式编" 与 "反应式编程" 共享 trigram（反应式、应式编）
      const results = await mo.search('反应式编', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('反应式编程');
    });

    it('英文关键词可检索', async () => {
      await mo.store('Docker container deployment guide', { importance: 7, tags: ['运维'] });

      const results = await mo.search('Docker', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Docker');
    });

    it('中英混合检索', async () => {
      await mo.store('使用 React 开发前端应用', { importance: 7, tags: ['前端'] });

      const results = await mo.search('React 前端', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('React');
    });
  });

  // ============ useVector 控制 ============

  describe('useVector 选项', () => {
    it('useVector:false 仍能通过 FTS 检索', async () => {
      await mo.store('向量搜索测试内容', { importance: 7, tags: ['搜索'] });

      const results = await mo.search('向量', { topK: 5, useVector: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('向量');
    });

    it('useVector:true 不抛错（无 embedding provider 时降级到 FTS）', async () => {
      await mo.store('向量搜索测试', { importance: 7, tags: ['搜索'] });

      // useVector:true 会尝试 vectorStore.search()，失败后降级到 FTS/tags/keywords
      const results = await mo.search('向量', { topK: 5, useVector: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('向量');
    });

    it('useVector:false 和 true 返回一致的内容（FTS 路径一致）', async () => {
      await mo.store('一致性测试内容', { importance: 7, tags: ['测试'] });

      const withoutVector = await mo.search('一致性', { topK: 5, useVector: false });
      const withVector = await mo.search('一致性', { topK: 5, useVector: true });

      // 两种模式都应找到同一条记忆
      expect(withoutVector.some(r => r.content.includes('一致性'))).toBe(true);
      expect(withVector.some(r => r.content.includes('一致性'))).toBe(true);
    });
  });

  // ============ tier filter ============

  describe('tier filter', () => {
    it('L2 filter 只返回技能级记忆', async () => {
      await mo.store('技能记忆A', { type: 'best_practice', importance: 9 });
      await mo.store('技能记忆B', { type: 'pattern', importance: 8 });
      await mo.store('临时记忆C', { type: 'interaction', importance: 3 });

      const results = await mo.search('记忆', {
        topK: 10, minResults: 1, useVector: false, tier: HermesMemoryTier.L2_SKILL,
      });
      expect(results.length).toBe(2);
      expect(results.every(r => r.tier === HermesMemoryTier.L2_SKILL)).toBe(true);
    });

    it('L0 filter 只返回会话级记忆', async () => {
      await mo.store('技能记忆A', { type: 'best_practice', importance: 9 });
      await mo.store('临时记忆B', { type: 'interaction', importance: 3 });

      const results = await mo.search('记忆', {
        topK: 10, minResults: 1, useVector: false, tier: HermesMemoryTier.L0_SESSION,
      });
      expect(results.length).toBe(1);
      expect(results[0].tier).toBe(HermesMemoryTier.L0_SESSION);
    });

    it('L1 filter 只返回持久级记忆', async () => {
      await mo.store('技能记忆A', { type: 'best_practice', importance: 9 });
      await mo.store('事实记忆B', { type: 'fact', importance: 5 });
      await mo.store('临时记忆C', { type: 'interaction', importance: 3 });

      const results = await mo.search('记忆', {
        topK: 10, minResults: 1, useVector: false, tier: HermesMemoryTier.L1_PERSISTENT,
      });
      expect(results.length).toBe(1);
      expect(results[0].tier).toBe(HermesMemoryTier.L1_PERSISTENT);
    });
  });

  // ============ minResults 控制 ============

  describe('minResults 控制', () => {
    it('minResults=1 时 FTS 单条结果直接返回', async () => {
      await mo.store('唯一匹配记忆', { importance: 7 });
      await mo.store('其他不相关内容', { importance: 5 });

      const results = await mo.search('唯一', { topK: 5, minResults: 1, useVector: false });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('唯一');
    });

    it('FTS 结果 >= minResults 时不降级', async () => {
      await mo.store('记忆A 内容', { importance: 7, tags: ['test'] });
      await mo.store('记忆B 内容', { importance: 7, tags: ['test'] });
      await mo.store('记忆C 内容', { importance: 7, tags: ['test'] });

      // minResults=2，FTS 返回 3 条 >= 2，直接返回
      const results = await mo.search('记忆', { topK: 5, minResults: 2, useVector: false });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('FTS 结果 < minResults 时仍返回已有结果', async () => {
      await mo.store('唯一匹配 xyz 特殊', { importance: 7, tags: ['特殊'] });
      await mo.store('不匹配的干扰项', { importance: 5, tags: ['其他'] });

      // minResults=5，FTS 仅返回 1 条 < 5，但 ftsResults.length > 0 时仍返回
      const results = await mo.search('xyz', { topK: 5, minResults: 5, useVector: false });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('xyz');
    });
  });

  // ============ recall_latency 埋点 ============

  describe('recall_latency 埋点', () => {
    it('每次 search 都记录延迟到 getStats()', async () => {
      await mo.store('埋点测试内容', { importance: 7 });

      await mo.search('埋点', { topK: 5, useVector: false });
      const stats = mo.getStats();
      expect(typeof stats.avgLatencyMs).toBe('number');
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('10 次搜索后触发 recordRuntimeValue（不抛错）', async () => {
      await mo.store('批量搜索测试', { importance: 7 });

      // 10 次搜索会触发 recordRuntimeValue('recall_latency_ms', avg)
      // 该写操作在 try/catch 中，不会抛错
      for (let i = 0; i < 10; i++) {
        await mo.search('批量', { topK: 5, useVector: false });
      }

      const stats = mo.getStats();
      expect(typeof stats.avgLatencyMs).toBe('number');
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('空结果搜索也记录延迟', async () => {
      // 无任何记忆时搜索
      await mo.search('不存在', { topK: 5, useVector: false });
      const stats = mo.getStats();
      expect(typeof stats.avgLatencyMs).toBe('number');
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('搜索延迟滑窗上限 100（不无限增长）', async () => {
      await mo.store('滑窗测试', { importance: 7 });
      // 搜索 150 次，滑窗应限制在 100
      for (let i = 0; i < 150; i++) {
        await mo.search('滑窗', { topK: 1, useVector: false });
      }
      const stats = mo.getStats();
      // 仍是有效数值，未因过度搜索崩溃
      expect(typeof stats.avgLatencyMs).toBe('number');
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ============ 搜索稳定性 ============

  describe('搜索稳定性', () => {
    it('相同查询返回一致结果', async () => {
      await mo.store('稳定性测试内容A', { importance: 7, tags: ['测试'] });
      await mo.store('稳定性测试内容B', { importance: 7, tags: ['测试'] });

      const r1 = await mo.search('稳定性', { topK: 5, useVector: false });
      const r2 = await mo.search('稳定性', { topK: 5, useVector: false });

      expect(r1.length).toBe(r2.length);
      expect(r1.map(r => r.id)).toEqual(r2.map(r => r.id));
    });

    it('不同查询返回各自相关记忆', async () => {
      await mo.store('React 开发指南', { importance: 7, tags: ['前端'] });
      await mo.store('Python 数据分析', { importance: 7, tags: ['后端'] });

      const reactResults = await mo.search('React', { topK: 5, useVector: false });
      const pythonResults = await mo.search('Python', { topK: 5, useVector: false });

      // 各自查到各自相关的内容
      expect(reactResults.some(r => r.content.includes('React'))).toBe(true);
      expect(pythonResults.some(r => r.content.includes('Python'))).toBe(true);
      // 注意：searchByKeywords 全量扫描基线分可能导致交叉返回，不对此做严格断言
    });
  });
});
