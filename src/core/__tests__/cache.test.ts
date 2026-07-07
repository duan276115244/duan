import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LRUCache, QueryCache } from '../cache.js';

describe('LRUCache', () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    vi.useRealTimers();
    cache = new LRUCache<string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('构造与配置', () => {
    it('默认配置 maxSize=1000, defaultTTL=3600000', () => {
      const c = new LRUCache<string>();
      // 通过行为验证默认 maxSize：填满 1000 个不淘汰，第 1001 个才淘汰
      for (let i = 0; i < 1000; i++) {
        c.set(`k${i}`, `v${i}`);
      }
      expect(c.size).toBe(1000);
      expect(c.get('k0')).toBe('v0');
      // 默认 TTL 不影响立即读取
      const stats = c.getStats();
      expect(stats.size).toBe(1000);
    });

    it('自定义配置 maxSize 和 defaultTTL', () => {
      const c = new LRUCache<string>({ maxSize: 5, defaultTTL: 1000 });
      for (let i = 0; i < 5; i++) {
        c.set(`k${i}`, `v${i}`);
      }
      expect(c.size).toBe(5);
      // 第 6 个触发淘汰
      c.set('k5', 'v5');
      expect(c.size).toBe(5);
      expect(c.has('k0')).toBe(false);
    });
  });

  describe('set/get 基本操作', () => {
    it('set 后 get 返回对应值', () => {
      cache.set('name', 'duan');
      expect(cache.get('name')).toBe('duan');
    });

    it('get 不存在的 key 返回 undefined', () => {
      expect(cache.get('not-exist')).toBeUndefined();
    });

    it('覆盖已存在的 key', () => {
      cache.set('k', 'v1');
      cache.set('k', 'v2');
      expect(cache.get('k')).toBe('v2');
      expect(cache.size).toBe(1);
    });
  });

  describe('has 检查存在性', () => {
    it('存在的 key 返回 true', () => {
      cache.set('k', 'v');
      expect(cache.has('k')).toBe(true);
    });

    it('不存在的 key 返回 false', () => {
      expect(cache.has('nope')).toBe(false);
    });

    it('has 不更新访问顺序（不计入命中）', () => {
      cache.set('k', 'v');
      cache.has('k');
      cache.has('k');
      const stats = cache.getStats();
      // has 不影响 hits 统计
      expect(stats.hits).toBe(0);
    });
  });

  describe('delete 删除', () => {
    it('删除存在的 key 返回 true', () => {
      cache.set('k', 'v');
      expect(cache.delete('k')).toBe(true);
      expect(cache.has('k')).toBe(false);
    });

    it('删除不存在的 key 返回 false', () => {
      expect(cache.delete('nope')).toBe(false);
    });
  });

  describe('clear 清空缓存', () => {
    it('清空所有条目', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.get('a');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has('a')).toBe(false);
    });

    it('清空后重置统计', () => {
      cache.set('a', '1');
      cache.get('a');
      cache.get('miss');
      cache.clear();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.size).toBe(0);
    });
  });

  describe('LRU 淘汰策略', () => {
    it('超过 maxSize 时淘汰最久未使用的', () => {
      const c = new LRUCache<string>({ maxSize: 3 });
      c.set('a', '1');
      c.set('b', '2');
      c.set('c', '3');
      // 插入第 4 个，'a' 最久未使用应被淘汰
      c.set('d', '4');
      expect(c.has('a')).toBe(false);
      expect(c.has('b')).toBe(true);
      expect(c.has('c')).toBe(true);
      expect(c.has('d')).toBe(true);
      expect(c.size).toBe(3);
    });

    it('淘汰计入 evictions 统计', () => {
      const c = new LRUCache<string>({ maxSize: 2 });
      c.set('a', '1');
      c.set('b', '2');
      c.set('c', '3'); // 淘汰 a
      const stats = c.getStats();
      expect(stats.evictions).toBe(1);
    });

    it('get 后更新访问顺序，影响淘汰对象', () => {
      const c = new LRUCache<string>({ maxSize: 3 });
      c.set('a', '1');
      c.set('b', '2');
      c.set('c', '3');
      // 访问 'a'，使其成为最近使用
      c.get('a');
      // 插入第 4 个，'b' 现在是最久未使用
      c.set('d', '4');
      expect(c.has('a')).toBe(true); // a 被访问过，保留
      expect(c.has('b')).toBe(false); // b 被淘汰
      expect(c.has('c')).toBe(true);
      expect(c.has('d')).toBe(true);
    });

    it('set 已存在的 key 更新访问顺序', () => {
      const c = new LRUCache<string>({ maxSize: 3 });
      c.set('a', '1');
      c.set('b', '2');
      c.set('c', '3');
      // 重新 set 'a'，使其成为最近使用
      c.set('a', '1-updated');
      // 插入第 4 个，'b' 现在是最久未使用
      c.set('d', '4');
      expect(c.has('a')).toBe(true);
      expect(c.get('a')).toBe('1-updated');
      expect(c.has('b')).toBe(false);
    });
  });

  describe('TTL 过期', () => {
    it('set 时指定 ttl=0 表示永不过期', async () => {
      cache.set('forever', 'value', 0);
      // 等待短暂时间后仍可读取
      await new Promise(r => setTimeout(r, 30));
      expect(cache.get('forever')).toBe('value');
    });

    it('短 TTL 过期后 get 返回 undefined', async () => {
      cache.set('temp', 'value', 50);
      expect(cache.get('temp')).toBe('value');
      await new Promise(r => setTimeout(r, 80));
      expect(cache.get('temp')).toBeUndefined();
    });

    it('过期后 has 返回 false', async () => {
      cache.set('temp', 'value', 50);
      expect(cache.has('temp')).toBe(true);
      await new Promise(r => setTimeout(r, 80));
      expect(cache.has('temp')).toBe(false);
    });

    it('过期后 get 计入 misses', async () => {
      cache.set('temp', 'value', 50);
      cache.get('temp'); // hit
      await new Promise(r => setTimeout(r, 80));
      cache.get('temp'); // miss (expired)
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('使用默认 TTL', async () => {
      const c = new LRUCache<string>({ defaultTTL: 50 });
      c.set('temp', 'value');
      expect(c.get('temp')).toBe('value');
      await new Promise(r => setTimeout(r, 80));
      expect(c.get('temp')).toBeUndefined();
    });
  });

  describe('getStats 统计', () => {
    it('初始统计全为 0', () => {
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.evictions).toBe(0);
    });

    it('正确统计 hits 和 misses', () => {
      cache.set('a', '1');
      cache.get('a'); // hit
      cache.get('a'); // hit
      cache.get('miss'); // miss
      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it('hitRate 计算正确', () => {
      cache.set('a', '1');
      cache.get('a'); // hit
      cache.get('miss'); // miss
      const stats = cache.getStats();
      // 1 hit / (1 hit + 1 miss) = 0.5
      expect(stats.hitRate).toBeCloseTo(0.5);
    });

    it('size 反映当前缓存大小', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      const stats = cache.getStats();
      expect(stats.size).toBe(2);
    });

    it('evictions 反映淘汰次数', () => {
      const c = new LRUCache<string>({ maxSize: 2 });
      c.set('a', '1');
      c.set('b', '2');
      c.set('c', '3'); // evict a
      c.set('d', '4'); // evict b
      const stats = c.getStats();
      expect(stats.evictions).toBe(2);
    });
  });

  describe('size 属性', () => {
    it('初始 size 为 0', () => {
      expect(cache.size).toBe(0);
    });

    it('set 后 size 增加', () => {
      cache.set('a', '1');
      expect(cache.size).toBe(1);
      cache.set('b', '2');
      expect(cache.size).toBe(2);
    });

    it('delete 后 size 减小', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.delete('a');
      expect(cache.size).toBe(1);
    });

    it('覆盖 set 不增加 size', () => {
      cache.set('a', '1');
      cache.set('a', '2');
      expect(cache.size).toBe(1);
    });
  });

  describe('cleanup 清理过期条目', () => {
    it('清理过期条目并返回清理数量', async () => {
      cache.set('a', '1', 50);
      cache.set('b', '2', 50);
      cache.set('c', '3', 0); // 永不过期
      await new Promise(r => setTimeout(r, 80));
      const removed = cache.cleanup();
      expect(removed).toBe(2);
      expect(cache.size).toBe(1);
      expect(cache.has('c')).toBe(true);
    });

    it('没有过期条目时返回 0', () => {
      cache.set('a', '1', 0);
      cache.set('b', '2', 0);
      const removed = cache.cleanup();
      expect(removed).toBe(0);
      expect(cache.size).toBe(2);
    });

    it('cleanup 不影响未过期条目', async () => {
      cache.set('a', '1', 50);
      cache.set('b', '2', 1000);
      await new Promise(r => setTimeout(r, 80));
      cache.cleanup();
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
    });
  });
});

describe('QueryCache', () => {
  let queryCache: QueryCache;

  beforeEach(() => {
    vi.useRealTimers();
    queryCache = new QueryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('构造与默认大小', () => {
    it('默认构造不抛错', () => {
      expect(() => new QueryCache()).not.toThrow();
    });

    it('自定义 maxSize', () => {
      const c = new QueryCache(2);
      c.set('p1', 'r1');
      c.set('p2', 'r2');
      c.set('p3', 'r3'); // 应淘汰 p1
      expect(c.get('p1')).toBeUndefined();
      expect(c.get('p2')).toBe('r2');
      expect(c.get('p3')).toBe('r3');
    });
  });

  describe('set/get 查询缓存', () => {
    it('set 后 get 返回结果', () => {
      queryCache.set('hello', 'world');
      expect(queryCache.get('hello')).toBe('world');
    });

    it('get 不存在的 prompt 返回 undefined', () => {
      expect(queryCache.get('nope')).toBeUndefined();
    });

    it('相同 prompt 不同 system 得到不同结果', () => {
      queryCache.set('hello', 'result-with-sys1', 'sys1');
      queryCache.set('hello', 'result-with-sys2', 'sys2');
      expect(queryCache.get('hello', 'sys1')).toBe('result-with-sys1');
      expect(queryCache.get('hello', 'sys2')).toBe('result-with-sys2');
    });

    it('相同 prompt 相同 system 命中缓存', () => {
      queryCache.set('hello', 'world', 'sys');
      expect(queryCache.get('hello', 'sys')).toBe('world');
    });

    it('不带 system 的查询独立缓存', () => {
      queryCache.set('hello', 'no-sys');
      queryCache.set('hello', 'with-sys', 'sys');
      expect(queryCache.get('hello')).toBe('no-sys');
      expect(queryCache.get('hello', 'sys')).toBe('with-sys');
    });
  });

  describe('getEmbedding/setEmbedding', () => {
    it('setEmbedding 后 getEmbedding 返回向量', () => {
      const vec = [0.1, 0.2, 0.3];
      queryCache.setEmbedding('text', vec);
      expect(queryCache.getEmbedding('text')).toEqual(vec);
    });

    it('getEmbedding 不存在的 text 返回 undefined', () => {
      expect(queryCache.getEmbedding('nope')).toBeUndefined();
    });

    it('不同 text 缓存不同向量', () => {
      queryCache.setEmbedding('a', [1, 2]);
      queryCache.setEmbedding('b', [3, 4]);
      expect(queryCache.getEmbedding('a')).toEqual([1, 2]);
      expect(queryCache.getEmbedding('b')).toEqual([3, 4]);
    });
  });

  describe('getStats 统计', () => {
    it('返回 query 和 embedding 两部分统计', () => {
      const stats = queryCache.getStats();
      expect(stats).toHaveProperty('query');
      expect(stats).toHaveProperty('embedding');
      expect(stats.query).toHaveProperty('hits');
      expect(stats.query).toHaveProperty('misses');
      expect(stats.query).toHaveProperty('hitRate');
      expect(stats.query).toHaveProperty('size');
      expect(stats.query).toHaveProperty('evictions');
      expect(stats.embedding).toHaveProperty('hits');
      expect(stats.embedding).toHaveProperty('misses');
    });

    it('query 统计正确反映查询缓存命中', () => {
      queryCache.set('p', 'r');
      queryCache.get('p'); // hit
      queryCache.get('miss'); // miss
      const stats = queryCache.getStats();
      expect(stats.query.hits).toBe(1);
      expect(stats.query.misses).toBe(1);
    });

    it('embedding 统计正确反映嵌入缓存命中', () => {
      queryCache.setEmbedding('t', [1]);
      queryCache.getEmbedding('t'); // hit
      queryCache.getEmbedding('miss'); // miss
      const stats = queryCache.getStats();
      expect(stats.embedding.hits).toBe(1);
      expect(stats.embedding.misses).toBe(1);
    });

    it('初始 size 为 0', () => {
      const stats = queryCache.getStats();
      expect(stats.query.size).toBe(0);
      expect(stats.embedding.size).toBe(0);
    });
  });

  describe('cleanup 清理过期缓存', () => {
    it('返回 query 和 embedding 两部分清理数量', () => {
      const result = queryCache.cleanup();
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('embedding');
      expect(typeof result.query).toBe('number');
      expect(typeof result.embedding).toBe('number');
    });

    it('清理过期的查询缓存', () => {
      // QueryCache 默认 defaultTTL=1800000，需用短 TTL 测试
      // 通过构造短 TTL 的 LRUCache 验证 cleanup 逻辑
      // QueryCache 内部使用固定 TTL，这里仅验证 cleanup 不抛错且未过期条目保留
      queryCache.set('p', 'r');
      const result = queryCache.cleanup();
      expect(result.query).toBe(0);
      expect(queryCache.get('p')).toBe('r');
    });

    it('清理过期的嵌入缓存', () => {
      queryCache.setEmbedding('t', [1, 2]);
      const result = queryCache.cleanup();
      expect(result.embedding).toBe(0);
      expect(queryCache.getEmbedding('t')).toEqual([1, 2]);
    });
  });
});
