import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PromptCache,
  getPromptCache,
  resetPromptCache,
} from '../prompt-cache.js';

// ============ PromptCache 单元测试 ============
// 覆盖三层缓存（stable/context/volatile）、内容哈希、token 预算、
// 命中率统计、增量组装、LRU 淘汰、TTL 过期、失效与边界情况

describe('PromptCache', () => {
  let cache: PromptCache;

  beforeEach(() => {
    cache = new PromptCache();
  });

  // ============ 构造与配置 ============

  describe('构造与配置', () => {
    it('默认配置可正常构造', () => {
      const c = new PromptCache();
      expect(c).toBeDefined();
      // 初始统计全为 0
      const stats = c.getStats();
      expect(stats.cacheSize.stable).toBe(0);
      expect(stats.cacheSize.context).toBe(0);
      expect(stats.cacheSize.volatile).toBe(0);
    });

    it('自定义配置覆盖默认 maxEntries', async () => {
      const c = new PromptCache({
        stable: { maxEntries: 2, ttlMs: 0 },
      });
      // 插入 3 个，应淘汰 1 个，保留 2 个
      await c.getOrBuild('stable', 'k1', () => 'a');
      await c.getOrBuild('stable', 'k2', () => 'b');
      await c.getOrBuild('stable', 'k3', () => 'c');
      const stats = c.getStats();
      expect(stats.cacheSize.stable).toBe(2);
    });

    it('部分自定义配置与默认合并', async () => {
      // 仅覆盖 context 的 maxEntries，其他字段保持默认
      const c = new PromptCache({
        context: { maxEntries: 1 },
      });
      await c.getOrBuild('context', 'k1', () => 'a');
      await c.getOrBuild('context', 'k2', () => 'b'); // 淘汰 k1
      const stats = c.getStats();
      expect(stats.cacheSize.context).toBe(1);
    });

    it('自定义 ttlMs 生效', async () => {
      const c = new PromptCache({ stable: { ttlMs: 50 } });
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'x';
      };
      await c.getOrBuild('stable', 'k', builder);
      expect(buildCount).toBe(1);
      await new Promise(r => setTimeout(r, 80));
      await c.getOrBuild('stable', 'k', builder);
      expect(buildCount).toBe(2);
    });
  });

  // ============ getOrBuild 基本操作 ============

  describe('getOrBuild 基本操作', () => {
    it('首次调用未命中，调用 builder', async () => {
      let buildCount = 0;
      const entry = await cache.getOrBuild('stable', 'k', () => {
        buildCount++;
        return 'content';
      });
      expect(buildCount).toBe(1);
      expect(entry.content).toBe('content');
      expect(entry.hitCount).toBe(0);
      expect(entry.hash).toHaveLength(16);
    });

    it('第二次调用命中，不调用 builder', async () => {
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'content';
      };
      await cache.getOrBuild('stable', 'k', builder);
      const entry = await cache.getOrBuild('stable', 'k', builder);
      expect(buildCount).toBe(1);
      expect(entry.hitCount).toBe(1);
    });

    it('多次命中 hitCount 递增', async () => {
      const builder = () => 'x';
      await cache.getOrBuild('stable', 'k', builder); // miss, hitCount=0
      const e1 = await cache.getOrBuild('stable', 'k', builder); // hit, hitCount=1
      // 注意：getOrBuild 返回同一对象引用，需在下一次调用前捕获值
      const hitCountAfterFirstHit = e1.hitCount;
      const e2 = await cache.getOrBuild('stable', 'k', builder); // hit, hitCount=2
      expect(hitCountAfterFirstHit).toBe(1);
      expect(e2.hitCount).toBe(2);
    });

    it('支持 async builder', async () => {
      const entry = await cache.getOrBuild('stable', 'k', async () => {
        return Promise.resolve('async-content');
      });
      expect(entry.content).toBe('async-content');
    });

    it('返回的 entry 包含全部字段', async () => {
      const entry = await cache.getOrBuild('stable', 'k', () => 'hello');
      expect(entry).toHaveProperty('hash');
      expect(entry).toHaveProperty('content');
      expect(entry).toHaveProperty('tokenCount');
      expect(entry).toHaveProperty('createdAt');
      expect(entry).toHaveProperty('lastHitAt');
      expect(entry).toHaveProperty('hitCount');
      expect(typeof entry.hash).toBe('string');
      expect(typeof entry.tokenCount).toBe('number');
      expect(typeof entry.createdAt).toBe('number');
      expect(typeof entry.lastHitAt).toBe('number');
    });

    it('相同内容产生相同 hash', async () => {
      const e1 = await cache.getOrBuild('stable', 'k1', () => 'same');
      cache.invalidate('stable', 'k1');
      const e2 = await cache.getOrBuild('stable', 'k1', () => 'same');
      expect(e1.hash).toBe(e2.hash);
    });

    it('不同内容产生不同 hash', async () => {
      const e1 = await cache.getOrBuild('stable', 'k1', () => 'content-a');
      const e2 = await cache.getOrBuild('stable', 'k2', () => 'content-b');
      expect(e1.hash).not.toBe(e2.hash);
    });

    it('命中后 lastHitAt 更新', async () => {
      const builder = () => 'x';
      const e1 = await cache.getOrBuild('stable', 'k', builder);
      await new Promise(r => setTimeout(r, 10));
      const e2 = await cache.getOrBuild('stable', 'k', builder);
      expect(e2.lastHitAt).toBeGreaterThan(e1.createdAt);
    });
  });

  // ============ 三层缓存独立 ============

  describe('三层缓存独立', () => {
    it('三层各自独立缓存（同 key 不冲突）', async () => {
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'x';
      };
      // 同 key 在不同层独立构建
      await cache.getOrBuild('stable', 'same-key', builder);
      await cache.getOrBuild('context', 'same-key', builder);
      await cache.getOrBuild('volatile', 'same-key', builder);
      expect(buildCount).toBe(3);
    });

    it('同层不同 key 独立', async () => {
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'x';
      };
      await cache.getOrBuild('stable', 'k1', builder);
      await cache.getOrBuild('stable', 'k2', builder);
      expect(buildCount).toBe(2);
    });

    it('cacheSize 按层统计', async () => {
      await cache.getOrBuild('stable', 'k1', () => 'a');
      await cache.getOrBuild('context', 'k1', () => 'b');
      await cache.getOrBuild('volatile', 'k1', () => 'c');
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(1);
      expect(stats.cacheSize.context).toBe(1);
      expect(stats.cacheSize.volatile).toBe(1);
    });

    it('三层 hits/misses 分别统计', async () => {
      await cache.getOrBuild('stable', 'k', () => 's'); // miss
      await cache.getOrBuild('stable', 'k', () => 's'); // hit
      await cache.getOrBuild('context', 'k', () => 'c'); // miss
      const stats = cache.getStats();
      expect(stats.hitsByLayer.stable).toBe(1);
      expect(stats.missesByLayer.stable).toBe(1);
      expect(stats.hitsByLayer.context).toBe(0);
      expect(stats.missesByLayer.context).toBe(1);
      expect(stats.hitsByLayer.volatile).toBe(0);
      expect(stats.missesByLayer.volatile).toBe(0);
    });
  });

  // ============ 内容哈希 hasChanged ============

  describe('内容哈希 hasChanged', () => {
    it('缓存不存在时返回 true', () => {
      expect(cache.hasChanged('stable', 'k', 'content')).toBe(true);
    });

    it('内容相同返回 false', async () => {
      await cache.getOrBuild('stable', 'k', () => 'same');
      expect(cache.hasChanged('stable', 'k', 'same')).toBe(false);
    });

    it('内容不同返回 true', async () => {
      await cache.getOrBuild('stable', 'k', () => 'original');
      expect(cache.hasChanged('stable', 'k', 'changed')).toBe(true);
    });

    it('各层独立判断', async () => {
      await cache.getOrBuild('stable', 'k', () => 's');
      await cache.getOrBuild('context', 'k', () => 'c');
      expect(cache.hasChanged('stable', 'k', 's')).toBe(false);
      expect(cache.hasChanged('context', 'k', 'c')).toBe(false);
      expect(cache.hasChanged('stable', 'k', 'c')).toBe(true);
    });

    it('空字符串内容哈希一致', async () => {
      await cache.getOrBuild('stable', 'k', () => '');
      expect(cache.hasChanged('stable', 'k', '')).toBe(false);
    });
  });

  // ============ TTL 过期 ============

  describe('TTL 过期', () => {
    it('TTL 过期后重新构建', async () => {
      const c = new PromptCache({ stable: { ttlMs: 50 } });
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'x';
      };
      await c.getOrBuild('stable', 'k', builder);
      expect(buildCount).toBe(1);
      await new Promise(r => setTimeout(r, 80));
      await c.getOrBuild('stable', 'k', builder);
      expect(buildCount).toBe(2);
    });

    it('TTL=0 永不过期', async () => {
      const c = new PromptCache({ stable: { ttlMs: 0 } });
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'x';
      };
      await c.getOrBuild('stable', 'k', builder);
      await new Promise(r => setTimeout(r, 30));
      await c.getOrBuild('stable', 'k', builder);
      expect(buildCount).toBe(1);
    });

    it('过期后计入 miss 而非 hit', async () => {
      const c = new PromptCache({ stable: { ttlMs: 50 } });
      await c.getOrBuild('stable', 'k', () => 'x'); // miss
      await new Promise(r => setTimeout(r, 80));
      await c.getOrBuild('stable', 'k', () => 'x'); // miss（过期重建）
      const stats = c.getStats();
      expect(stats.missesByLayer.stable).toBe(2);
      expect(stats.hitsByLayer.stable).toBe(0);
    });

    it('未过期命中计入 hit', async () => {
      const c = new PromptCache({ stable: { ttlMs: 1000 } });
      await c.getOrBuild('stable', 'k', () => 'x'); // miss
      await c.getOrBuild('stable', 'k', () => 'x'); // hit
      const stats = c.getStats();
      expect(stats.hitsByLayer.stable).toBe(1);
      expect(stats.missesByLayer.stable).toBe(1);
    });

    it('过期重建后新条目可正常命中', async () => {
      const c = new PromptCache({ stable: { ttlMs: 50 } });
      const builder = () => 'x';
      await c.getOrBuild('stable', 'k', builder); // miss
      await new Promise(r => setTimeout(r, 80));
      await c.getOrBuild('stable', 'k', builder); // miss（重建）
      await c.getOrBuild('stable', 'k', builder); // hit
      const stats = c.getStats();
      expect(stats.missesByLayer.stable).toBe(2);
      expect(stats.hitsByLayer.stable).toBe(1);
    });
  });

  // ============ Token 预算与估算 ============

  describe('Token 预算与估算', () => {
    it('纯英文 token 估算约 4 字符/token', async () => {
      const entry = await cache.getOrBuild('stable', 'k', () => 'hello world');
      // 11 字符 / 4 = 2.75 → ceil = 3
      expect(entry.tokenCount).toBe(3);
    });

    it('纯中文 token 估算约 1.5 token/字', async () => {
      const entry = await cache.getOrBuild('stable', 'k', () => '你好世界');
      // 4 中文字 * 1.5 = 6
      expect(entry.tokenCount).toBe(6);
    });

    it('中英文混合分别计算', async () => {
      const entry = await cache.getOrBuild('stable', 'k', () => 'hello 你好');
      // 中文 2 字 * 1.5 = 3, 其他 6 字符 / 4 = 1.5 → ceil(4.5) = 5
      expect(entry.tokenCount).toBe(Math.ceil(2 * 1.5 + 6 / 4));
    });

    it('空字符串 token 为 0', async () => {
      const entry = await cache.getOrBuild('stable', 'k', () => '');
      expect(entry.tokenCount).toBe(0);
    });

    it('cachedTokens 按层累加', async () => {
      await cache.getOrBuild('stable', 'k1', () => 'aaa'); // 1 token
      await cache.getOrBuild('stable', 'k2', () => 'bbb'); // 1 token
      const stats = cache.getStats();
      expect(stats.cachedTokens.stable).toBe(2);
    });

    it('cachedTokens 各层独立', async () => {
      await cache.getOrBuild('stable', 'k', () => 'aaaa'); // 1 token
      await cache.getOrBuild('context', 'k', () => 'bbbbbbbb'); // 2 tokens
      await cache.getOrBuild('volatile', 'k', () => 'cccccccccccc'); // 3 tokens
      const stats = cache.getStats();
      expect(stats.cachedTokens.stable).toBe(1);
      expect(stats.cachedTokens.context).toBe(2);
      expect(stats.cachedTokens.volatile).toBe(3);
    });

    it('自定义 tokenBudget 配置可接受', () => {
      const c = new PromptCache({
        stable: { tokenBudget: 1000 },
        context: { tokenBudget: 2000 },
        volatile: { tokenBudget: 500 },
      });
      expect(c).toBeDefined();
    });

    it('长内容 token 估算正确', async () => {
      const long = 'a'.repeat(10000);
      const entry = await cache.getOrBuild('stable', 'k', () => long);
      expect(entry.tokenCount).toBe(2500);
    });
  });

  // ============ 命中率统计 ============

  describe('命中率统计', () => {
    it('初始统计全为 0', () => {
      const stats = cache.getStats();
      expect(stats.hitsByLayer.stable).toBe(0);
      expect(stats.hitsByLayer.context).toBe(0);
      expect(stats.hitsByLayer.volatile).toBe(0);
      expect(stats.missesByLayer.stable).toBe(0);
      expect(stats.missesByLayer.context).toBe(0);
      expect(stats.missesByLayer.volatile).toBe(0);
      expect(stats.overallHitRate).toBe(0);
      expect(stats.totalSavedMs).toBe(0);
    });

    it('正确统计 hits 和 misses', async () => {
      await cache.getOrBuild('stable', 'k', () => 'x'); // miss
      await cache.getOrBuild('stable', 'k', () => 'x'); // hit
      await cache.getOrBuild('stable', 'miss', () => 'y'); // miss
      const stats = cache.getStats();
      expect(stats.hitsByLayer.stable).toBe(1);
      expect(stats.missesByLayer.stable).toBe(2);
    });

    it('hitRateByLayer 计算', async () => {
      await cache.getOrBuild('stable', 'k', () => 'x'); // miss
      await cache.getOrBuild('stable', 'k', () => 'x'); // hit
      const stats = cache.getStats();
      // 1 hit / (1 hit + 1 miss) = 0.5
      expect(stats.hitRateByLayer.stable).toBeCloseTo(0.5);
    });

    it('overallHitRate 计算', async () => {
      await cache.getOrBuild('stable', 'k', () => 'x'); // miss
      await cache.getOrBuild('stable', 'k', () => 'x'); // hit
      await cache.getOrBuild('context', 'k', () => 'x'); // miss
      const stats = cache.getStats();
      // 1 hit / 3 total ≈ 0.333
      expect(stats.overallHitRate).toBeCloseTo(1 / 3);
    });

    it('无访问时 hitRate 为 0', () => {
      const stats = cache.getStats();
      expect(stats.hitRateByLayer.stable).toBe(0);
      expect(stats.hitRateByLayer.context).toBe(0);
      expect(stats.hitRateByLayer.volatile).toBe(0);
      expect(stats.overallHitRate).toBe(0);
    });

    it('resetStats 重置统计但不清缓存', async () => {
      await cache.getOrBuild('stable', 'k', () => 'x');
      cache.resetStats();
      const stats = cache.getStats();
      expect(stats.hitsByLayer.stable).toBe(0);
      expect(stats.missesByLayer.stable).toBe(0);
      expect(stats.totalSavedMs).toBe(0);
      // 缓存条目不被清除
      expect(stats.cacheSize.stable).toBe(1);
    });

    it('resetStats 后仍可正常命中', async () => {
      const builder = () => 'x';
      await cache.getOrBuild('stable', 'k', builder); // miss
      cache.resetStats();
      await cache.getOrBuild('stable', 'k', builder); // hit
      const stats = cache.getStats();
      expect(stats.hitsByLayer.stable).toBe(1);
      expect(stats.missesByLayer.stable).toBe(0);
    });

    it('cacheSize 反映当前条目数', async () => {
      await cache.getOrBuild('stable', 'k1', () => 'a');
      await cache.getOrBuild('stable', 'k2', () => 'b');
      await cache.getOrBuild('context', 'k1', () => 'c');
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(2);
      expect(stats.cacheSize.context).toBe(1);
      expect(stats.cacheSize.volatile).toBe(0);
    });

    it('totalSavedMs 反映构建成本与命中节省', async () => {
      // 设计契约（P0 D3.1）：totalSavedMs 不钳制为 0 ——
      // 首次构建成本 > 0 时允许负值（表示"缓存尚未回本"），命中后逐步回正。
      const builder = () => 'x';
      await cache.getOrBuild('stable', 'k', builder); // miss
      const afterMiss = cache.getStats();
      expect(typeof afterMiss.totalSavedMs).toBe('number');

      // 命中后 totalSavedMs 增加（节省了重建成本），最终回正为非负
      await cache.getOrBuild('stable', 'k', builder); // hit
      const afterHit = cache.getStats();
      expect(afterHit.totalSavedMs).toBeGreaterThanOrEqual(afterMiss.totalSavedMs);
    });

    it('stats 返回的对象是副本（修改不影响内部状态）', async () => {
      await cache.getOrBuild('stable', 'k', () => 'x');
      const stats1 = cache.getStats();
      stats1.hitsByLayer.stable = 999;
      const stats2 = cache.getStats();
      expect(stats2.hitsByLayer.stable).not.toBe(999);
    });
  });

  // ============ 增量组装 assemble ============

  describe('增量组装 assemble', () => {
    it('三层合并为完整 prompt', async () => {
      const result = await cache.assemble(
        () => 'STABLE',
        () => 'CONTEXT',
        () => 'VOLATILE',
      );
      expect(result.content).toBe('STABLE\n\n---\n\nCONTEXT\n\n---\n\nVOLATILE');
    });

    it('totalTokens 累加三层', async () => {
      const result = await cache.assemble(
        () => 'aaaa', // 1 token
        () => 'bbbb', // 1 token
        () => 'cccc', // 1 token
      );
      expect(result.totalTokens).toBe(3);
    });

    it('layerContributions 包含三层完整信息', async () => {
      const result = await cache.assemble(
        () => 'S',
        () => 'C',
        () => 'V',
      );
      expect(result.layerContributions.stable).toHaveProperty('tokens');
      expect(result.layerContributions.stable).toHaveProperty('cached');
      expect(result.layerContributions.stable).toHaveProperty('hash');
      expect(result.layerContributions.context).toHaveProperty('tokens');
      expect(result.layerContributions.context).toHaveProperty('cached');
      expect(result.layerContributions.context).toHaveProperty('hash');
      expect(result.layerContributions.volatile).toHaveProperty('tokens');
      expect(result.layerContributions.volatile).toHaveProperty('cached');
      expect(result.layerContributions.volatile).toHaveProperty('hash');
    });

    it('首次组装 cached=false（未命中）', async () => {
      const result = await cache.assemble(
        () => 'S',
        () => 'C',
        () => 'V',
      );
      expect(result.layerContributions.stable.cached).toBe(false);
      expect(result.layerContributions.context.cached).toBe(false);
      expect(result.layerContributions.volatile.cached).toBe(false);
    });

    it('第二次组装 cached=true（命中缓存）', async () => {
      const builder = () => 'x';
      await cache.assemble(builder, builder, builder);
      const result = await cache.assemble(builder, builder, builder);
      expect(result.layerContributions.stable.cached).toBe(true);
      expect(result.layerContributions.context.cached).toBe(true);
      expect(result.layerContributions.volatile.cached).toBe(true);
    });

    it('第二次组装不调用 builder（增量复用）', async () => {
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'x';
      };
      await cache.assemble(builder, builder, builder);
      await cache.assemble(builder, builder, builder);
      // 首次 3 次，第二次 0 次
      expect(buildCount).toBe(3);
    });

    it('仅变更层重建，未变更层复用', async () => {
      // 首次组装建立全部缓存
      let stableBuilds = 0;
      let contextBuilds = 0;
      let volatileBuilds = 0;
      await cache.assemble(
        () => {
          stableBuilds++;
          return 'S';
        },
        () => {
          contextBuilds++;
          return 'C';
        },
        () => {
          volatileBuilds++;
          return 'V';
        },
      );
      // 失效上下文层
      cache.invalidateOnFileChange();
      // 再次组装：stable/volatile 命中，context 重建
      await cache.assemble(
        () => {
          stableBuilds++;
          return 'S';
        },
        () => {
          contextBuilds++;
          return 'C';
        },
        () => {
          volatileBuilds++;
          return 'V';
        },
      );
      expect(stableBuilds).toBe(1);
      expect(contextBuilds).toBe(2);
      expect(volatileBuilds).toBe(1);
    });

    it('assemblyMs 非负', async () => {
      const result = await cache.assemble(() => 'a', () => 'b', () => 'c');
      expect(result.assemblyMs).toBeGreaterThanOrEqual(0);
    });

    it('空内容层被跳过', async () => {
      const result = await cache.assemble(
        () => 'STABLE',
        () => '',
        () => 'VOLATILE',
      );
      expect(result.content).toBe('STABLE\n\n---\n\nVOLATILE');
    });

    it('全空内容返回空字符串', async () => {
      const result = await cache.assemble(() => '', () => '', () => '');
      expect(result.content).toBe('');
      expect(result.totalTokens).toBe(0);
    });

    it('使用固定 key: system-prompt/project-context/runtime-state', async () => {
      // assemble 后再单独 getOrBuild 同 key 应命中
      await cache.assemble(() => 'S', () => 'C', () => 'V');
      let buildCount = 0;
      const builder = () => {
        buildCount++;
        return 'S';
      };
      await cache.getOrBuild('stable', 'system-prompt', builder);
      expect(buildCount).toBe(0); // 命中
    });

    it('fullyCached 首次为 true（刚创建）', async () => {
      const result = await cache.assemble(() => 'a', () => 'b', () => 'c');
      // 首次创建，Date.now() - createdAt < 10 → fullyCached=true
      expect(result.fullyCached).toBe(true);
    });

    it('fullyCached 第二次为 true（命中缓存）', async () => {
      const builder = () => 'x';
      await cache.assemble(builder, builder, builder);
      const result = await cache.assemble(builder, builder, builder);
      expect(result.fullyCached).toBe(true);
    });

    it('支持 async builder', async () => {
      const result = await cache.assemble(
        async () => Promise.resolve('S'),
        async () => Promise.resolve('C'),
        async () => Promise.resolve('V'),
      );
      expect(result.content).toBe('S\n\n---\n\nC\n\n---\n\nV');
    });

    it('layerContributions.hash 与 entry.hash 一致', async () => {
      const result = await cache.assemble(() => 'S', () => 'C', () => 'V');
      const stableEntry = await cache.getOrBuild('stable', 'system-prompt', () => 'S');
      expect(result.layerContributions.stable.hash).toBe(stableEntry.hash);
    });
  });

  // ============ invalidate 失效 ============

  describe('invalidate 失效', () => {
    it('失效单层单 key', async () => {
      await cache.getOrBuild('stable', 'k1', () => 'a');
      await cache.getOrBuild('stable', 'k2', () => 'b');
      cache.invalidate('stable', 'k1');
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(1);
    });

    it('失效整层', async () => {
      await cache.getOrBuild('stable', 'k1', () => 'a');
      await cache.getOrBuild('stable', 'k2', () => 'b');
      cache.invalidate('stable');
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(0);
    });

    it('失效不影响其他层', async () => {
      await cache.getOrBuild('stable', 'k', () => 'a');
      await cache.getOrBuild('context', 'k', () => 'b');
      cache.invalidate('stable');
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(0);
      expect(stats.cacheSize.context).toBe(1);
    });

    it('无参数失效全部', async () => {
      await cache.getOrBuild('stable', 'k', () => 'a');
      await cache.getOrBuild('context', 'k', () => 'b');
      await cache.getOrBuild('volatile', 'k', () => 'c');
      cache.invalidate();
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(0);
      expect(stats.cacheSize.context).toBe(0);
      expect(stats.cacheSize.volatile).toBe(0);
    });

    it('invalidateOnToolsChange 仅失效 stable/system-prompt', async () => {
      await cache.assemble(() => 'S', () => 'C', () => 'V');
      cache.invalidateOnToolsChange();
      const stats = cache.getStats();
      expect(stats.cacheSize.stable).toBe(0);
      // context/volatile 不受影响
      expect(stats.cacheSize.context).toBe(1);
      expect(stats.cacheSize.volatile).toBe(1);
    });

    it('invalidateOnFileChange 仅失效 context/project-context', async () => {
      await cache.assemble(() => 'S', () => 'C', () => 'V');
      cache.invalidateOnFileChange();
      const stats = cache.getStats();
      expect(stats.cacheSize.context).toBe(0);
      expect(stats.cacheSize.stable).toBe(1);
      expect(stats.cacheSize.volatile).toBe(1);
    });

    it('失效后重新构建计入 miss', async () => {
      await cache.getOrBuild('stable', 'k', () => 'a'); // miss
      await cache.getOrBuild('stable', 'k', () => 'a'); // hit
      cache.invalidate('stable', 'k');
      await cache.getOrBuild('stable', 'k', () => 'a'); // miss
      const stats = cache.getStats();
      expect(stats.missesByLayer.stable).toBe(2);
      expect(stats.hitsByLayer.stable).toBe(1);
    });

    it('失效后 hasChanged 返回 true', async () => {
      await cache.getOrBuild('stable', 'k', () => 'same');
      expect(cache.hasChanged('stable', 'k', 'same')).toBe(false);
      cache.invalidate('stable', 'k');
      expect(cache.hasChanged('stable', 'k', 'same')).toBe(true);
    });
  });

  // ============ LRU 淘汰 ============

  describe('LRU 淘汰', () => {
    it('超过 maxEntries 淘汰最久未使用', async () => {
      const c = new PromptCache({ stable: { maxEntries: 2, ttlMs: 0 } });
      await c.getOrBuild('stable', 'k1', () => 'a');
      await c.getOrBuild('stable', 'k2', () => 'b');
      await c.getOrBuild('stable', 'k3', () => 'c'); // 淘汰 k1
      const stats = c.getStats();
      expect(stats.cacheSize.stable).toBe(2);
      // k1 被淘汰，重新构建计入 miss
      let buildCount = 0;
      await c.getOrBuild('stable', 'k1', () => {
        buildCount++;
        return 'a';
      });
      expect(buildCount).toBe(1);
    });

    it('命中更新 lastHitAt 影响淘汰顺序', async () => {
      const c = new PromptCache({ stable: { maxEntries: 2, ttlMs: 0 } });
      await c.getOrBuild('stable', 'k1', () => 'a');
      await new Promise(r => setTimeout(r, 5)); // 确保 lastHitAt 时间戳不同
      await c.getOrBuild('stable', 'k2', () => 'b');
      await new Promise(r => setTimeout(r, 5));
      // 命中 k1，使其成为最近使用
      await c.getOrBuild('stable', 'k1', () => 'a');
      await new Promise(r => setTimeout(r, 5));
      // 插入 k3，应淘汰 k2（最久未使用）
      await c.getOrBuild('stable', 'k3', () => 'c');
      const stats = c.getStats();
      expect(stats.cacheSize.stable).toBe(2);
      // 先验证 k1 仍在缓存（命中，不触发重建）
      let k1BuildCount = 0;
      await c.getOrBuild('stable', 'k1', () => {
        k1BuildCount++;
        return 'a';
      });
      expect(k1BuildCount).toBe(0);
      // 再验证 k2 已被淘汰（需重建）
      let k2BuildCount = 0;
      await c.getOrBuild('stable', 'k2', () => {
        k2BuildCount++;
        return 'b';
      });
      expect(k2BuildCount).toBe(1);
    });

    it('刚好等于 maxEntries 不淘汰', async () => {
      const c = new PromptCache({ stable: { maxEntries: 3, ttlMs: 0 } });
      await c.getOrBuild('stable', 'k1', () => 'a');
      await c.getOrBuild('stable', 'k2', () => 'b');
      await c.getOrBuild('stable', 'k3', () => 'c');
      const stats = c.getStats();
      expect(stats.cacheSize.stable).toBe(3);
    });
  });

  // ============ 边界情况 ============

  describe('边界情况', () => {
    it('空字符串 builder', async () => {
      const entry = await cache.getOrBuild('stable', 'k', () => '');
      expect(entry.content).toBe('');
      expect(entry.tokenCount).toBe(0);
      expect(entry.hash).toHaveLength(16);
    });

    it('builder 返回特殊字符', async () => {
      const special = 'Hello\n\t世界 🎉 "quotes"';
      const entry = await cache.getOrBuild('stable', 'k', () => special);
      expect(entry.content).toBe(special);
    });

    it('builder 抛错时异常传播', async () => {
      await expect(
        cache.getOrBuild('stable', 'k', () => {
          throw new Error('build-failed');
        }),
      ).rejects.toThrow('build-failed');
    });

    it('async builder 抛错时异常传播', async () => {
      await expect(
        cache.getOrBuild('stable', 'k', async () => {
          throw new Error('async-failed');
        }),
      ).rejects.toThrow('async-failed');
    });

    it('builder 抛错后下次仍可构建', async () => {
      try {
        await cache.getOrBuild('stable', 'k', () => {
          throw new Error('fail');
        });
      } catch {
        // 忽略
      }
      const entry = await cache.getOrBuild('stable', 'k', () => 'success');
      expect(entry.content).toBe('success');
    });

    it('长内容不报错', async () => {
      const long = 'a'.repeat(10000);
      const entry = await cache.getOrBuild('stable', 'k', () => long);
      expect(entry.content).toHaveLength(10000);
      expect(entry.tokenCount).toBe(2500);
    });

    it('hasChanged 不存在的层/key 返回 true', () => {
      expect(cache.hasChanged('volatile', 'nope', 'x')).toBe(true);
    });

    it('invalidate 不存在的 key 不报错', () => {
      expect(() => cache.invalidate('stable', 'nope')).not.toThrow();
    });

    it('invalidate 不存在的层不报错', () => {
      expect(() => cache.invalidate()).not.toThrow();
    });

    it('resetStats 多次调用不报错', () => {
      expect(() => {
        cache.resetStats();
        cache.resetStats();
      }).not.toThrow();
    });

    it('getStats 多次调用结果一致', async () => {
      await cache.getOrBuild('stable', 'k', () => 'x');
      const stats1 = cache.getStats();
      const stats2 = cache.getStats();
      expect(stats2.hitsByLayer.stable).toBe(stats1.hitsByLayer.stable);
      expect(stats2.missesByLayer.stable).toBe(stats1.missesByLayer.stable);
    });
  });

  // ============ 单例 ============

  describe('单例 getPromptCache/resetPromptCache', () => {
    beforeEach(() => {
      resetPromptCache();
    });

    afterEach(() => {
      resetPromptCache();
    });

    it('getPromptCache 返回同一实例', () => {
      const a = getPromptCache();
      const b = getPromptCache();
      expect(a).toBe(b);
    });

    it('resetPromptCache 后获取新实例', () => {
      const a = getPromptCache();
      resetPromptCache();
      const b = getPromptCache();
      expect(a).not.toBe(b);
    });

    it('单例可正常使用', async () => {
      const c = getPromptCache();
      const entry = await c.getOrBuild('stable', 'k', () => 'x');
      expect(entry.content).toBe('x');
    });
  });
});
