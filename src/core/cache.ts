/**
 * 多级缓存系统
 * L1: 内存缓存（LRU）
 * L2: 相似查询缓存（基于向量相似度）
 */

/** 缓存条目 */
interface CacheEntry<T> {
  key: string;
  value: T;
  embedding?: number[];
  createdAt: number;
  accessedAt: number;
  hitCount: number;
  ttl: number; // 过期时间(ms)，0表示永不过期
}

/** 缓存统计 */
interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  evictions: number;
}

/** LRU缓存配置 */
interface LRUCacheConfig {
  maxSize: number;
  defaultTTL: number; // 默认过期时间(ms)
}

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private config: LRUCacheConfig;
  private stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(config: Partial<LRUCacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize || 1000,
      defaultTTL: config.defaultTTL || 3600000, // 默认1小时
    };
  }

  /**
   * 获取缓存
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // 检查是否过期
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // 更新访问信息（LRU）
    entry.accessedAt = Date.now();
    entry.hitCount++;
    this.stats.hits++;

    // 移到末尾（最近使用）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * 设置缓存
   */
  set(key: string, value: T, ttl?: number): void {
    // 如果已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 检查容量，淘汰最久未使用的
    while (this.cache.size >= this.config.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.stats.evictions++;
      }
    }

    this.cache.set(key, {
      key,
      value,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      hitCount: 0,
      ttl: ttl ?? this.config.defaultTTL,
    });
  }

  /**
   * 检查是否存在
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 删除缓存
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * 获取统计信息
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      size: this.cache.size,
      evictions: this.stats.evictions,
    };
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 清理过期条目
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, entry] of this.cache) {
      if (entry.ttl > 0 && now - entry.createdAt > entry.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }
}

/**
 * 查询结果缓存
 * 专门缓存模型查询结果
 */
export class QueryCache {
  private cache: LRUCache<string>;
  private embeddingCache: LRUCache<number[]>;

  constructor(maxSize: number = 500) {
    this.cache = new LRUCache<string>({ maxSize, defaultTTL: 1800000 }); // 30分钟
    this.embeddingCache = new LRUCache<number[]>({ maxSize: 1000, defaultTTL: 7200000 }); // 2小时
  }

  /**
   * 生成查询哈希键
   */
  private hashQuery(prompt: string, system?: string): string {
    const combined = `${system || ''}|||${prompt}`;
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转为32位整数
    }
    return `q_${Math.abs(hash).toString(36)}`;
  }

  /**
   * 获取缓存的查询结果
   */
  get(prompt: string, system?: string): string | undefined {
    const key = this.hashQuery(prompt, system);
    return this.cache.get(key);
  }

  /**
   * 缓存查询结果
   */
  set(prompt: string, result: string, system?: string): void {
    const key = this.hashQuery(prompt, system);
    this.cache.set(key, result);
  }

  /**
   * 获取缓存的嵌入向量
   */
  getEmbedding(text: string): number[] | undefined {
    return this.embeddingCache.get(text);
  }

  /**
   * 缓存嵌入向量
   */
  setEmbedding(text: string, embedding: number[]): void {
    this.embeddingCache.set(text, embedding);
  }

  /**
   * 获取统计信息
   */
  getStats(): { query: CacheStats; embedding: CacheStats } {
    return {
      query: this.cache.getStats(),
      embedding: this.embeddingCache.getStats(),
    };
  }

  /**
   * 清理过期缓存
   */
  cleanup(): { query: number; embedding: number } {
    return {
      query: this.cache.cleanup(),
      embedding: this.embeddingCache.cleanup(),
    };
  }
}
