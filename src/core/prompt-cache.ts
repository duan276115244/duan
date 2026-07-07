/**
 * 三层 Prompt 缓存系统 — PromptCache
 *
 * 对标 Hermes 的 stable/context/volatile 三层 prompt 缓存架构，
 * 解决首字符响应延迟高（800ms → 目标 400ms）的问题。
 *
 * 三层缓存设计：
 * - Stable（稳定层）：身份、工具定义、技能列表 — 极少变化，缓存命中率最高
 * - Context（上下文层）：项目文件、最近对话上下文 — 偶尔变化
 * - Volatile（易变层）：记忆快照、用户画像、时间戳 — 频繁变化
 *
 * 核心机制：
 * 1. 内容哈希指纹：每层内容生成 SHA-256 指纹，变更才重建
 * 2. 增量组装：仅重建变更层，复用未变更层的缓存
 * 3. Token 预算：各层分配 token 预算，避免单层膨胀
 * 4. 命中统计：监控缓存命中率，指导优化
 *
 * 借鉴来源：
 * - Hermes：stable/context/volatile 三层分层
 * - Claude Code：prompt prefix caching
 * - OpenAI：自动 prompt caching（前缀匹配）
 */

import { createHash } from 'crypto';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 缓存层标识 */
export type CacheLayer = 'stable' | 'context' | 'volatile';

/** 缓存条目 */
interface CacheEntry {
  /** 内容哈希 */
  hash: string;
  /** 序列化内容 */
  content: string;
  /** token 估算 */
  tokenCount: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后命中时间 */
  lastHitAt: number;
  /** 命中次数 */
  hitCount: number;
  /** P0 D3.1 修复：构建耗时（毫秒）— 命中时用于估算节省的时间 */
  buildMs?: number;
}

/** 层配置 */
export interface LayerConfig {
  /** token 预算 */
  tokenBudget: number;
  /** 最大条目数 */
  maxEntries: number;
  /** TTL（毫秒），0 表示永不过期 */
  ttlMs: number;
}

/** 缓存统计 */
export interface PromptCacheStats {
  /** 各层命中次数 */
  hitsByLayer: Record<CacheLayer, number>;
  /** 各层未命中次数 */
  missesByLayer: Record<CacheLayer, number>;
  /** 各层命中率 */
  hitRateByLayer: Record<CacheLayer, number>;
  /** 总命中率 */
  overallHitRate: number;
  /** 节省的 token 重组时间（毫秒） */
  totalSavedMs: number;
  /** 当前缓存大小（条目数） */
  cacheSize: Record<CacheLayer, number>;
  /** 当前缓存 token 数 */
  cachedTokens: Record<CacheLayer, number>;
}

/** 组装结果 */
export interface AssembledPrompt {
  /** 完整 prompt 内容 */
  content: string;
  /** 总 token 估算 */
  totalTokens: number;
  /** 各层贡献 */
  layerContributions: Record<CacheLayer, { tokens: number; cached: boolean; hash: string }>;
  /** 组装耗时（毫秒） */
  assemblyMs: number;
  /** 是否完全命中缓存 */
  fullyCached: boolean;
}

// ============ 默认配置 ============

const DEFAULT_CONFIGS: Record<CacheLayer, LayerConfig> = {
  // 稳定层：身份、工具、技能 — 缓存 1 小时
  stable: {
    tokenBudget: 8000,
    maxEntries: 10,
    ttlMs: 60 * 60 * 1000,
  },
  // 上下文层：项目文件、最近对话 — 缓存 5 分钟
  context: {
    tokenBudget: 16000,
    maxEntries: 20,
    ttlMs: 5 * 60 * 1000,
  },
  // 易变层：记忆快照、用户画像、时间戳 — 缓存 30 秒
  volatile: {
    tokenBudget: 4000,
    maxEntries: 30,
    ttlMs: 30 * 1000,
  },
};

// ============ Token 估算器 ============

/**
 * 粗略 token 估算 — 4 字符约 1 token（中英文混合）
 * 精确估算应使用 tiktoken，此处粗略估算避免依赖
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // 中文字符约 1 字 = 1-2 token，英文约 4 字符 = 1 token
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars / 4);
}

/** 计算内容哈希 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ============ PromptCache 主类 ============

export class PromptCache {
  private log = logger.child({ module: 'PromptCache' });
  private caches: Record<CacheLayer, Map<string, CacheEntry>> = {
    stable: new Map(),
    context: new Map(),
    volatile: new Map(),
  };
  private configs: Record<CacheLayer, LayerConfig>;
  private stats = {
    hitsByLayer: { stable: 0, context: 0, volatile: 0 } as Record<CacheLayer, number>,
    missesByLayer: { stable: 0, context: 0, volatile: 0 } as Record<CacheLayer, number>,
    totalSavedMs: 0,
  };

  constructor(configs?: Partial<Record<CacheLayer, Partial<LayerConfig>>>) {
    this.configs = {
      stable: { ...DEFAULT_CONFIGS.stable, ...configs?.stable },
      context: { ...DEFAULT_CONFIGS.context, ...configs?.context },
      volatile: { ...DEFAULT_CONFIGS.volatile, ...configs?.volatile },
    };
  }

  /**
   * 获取或构建缓存层内容
   *
   * @param layer 缓存层
   * @param key 缓存键（如 'system-prompt'、'project-files'）
   * @param builder 内容构建函数（仅在缓存未命中时调用）
   * @returns 缓存条目
   */
  async getOrBuild(
    layer: CacheLayer,
    key: string,
    builder: () => string | Promise<string>,
  ): Promise<CacheEntry> {
    const cache = this.caches[layer];
    const config = this.configs[layer];
    const now = Date.now();

    // 检查缓存
    const existing = cache.get(key);
    if (existing) {
      // TTL 检查
      if (config.ttlMs > 0 && now - existing.createdAt > config.ttlMs) {
        cache.delete(key);
      } else {
        // 命中
        existing.lastHitAt = now;
        existing.hitCount++;
        this.stats.hitsByLayer[layer]++;
        // P0 D3.1 修复：命中时累加节省的时间（用首次构建耗时估算）
        // 之前此处不更新 totalSavedMs，而 miss 路径只减不增，导致 getStats 的 Math.max(0,...) 永远返回 0
        if (typeof existing.buildMs === 'number' && existing.buildMs > 0) {
          this.stats.totalSavedMs += existing.buildMs;
        }
        return existing;
      }
    }

    // 未命中 — 构建
    this.stats.missesByLayer[layer]++;
    const buildStart = Date.now();
    const content = await builder();
    const buildMs = Date.now() - buildStart;
    this.stats.totalSavedMs -= buildMs; // 构建成本

    const entry: CacheEntry = {
      hash: contentHash(content),
      content,
      tokenCount: estimateTokens(content),
      createdAt: now,
      lastHitAt: now,
      hitCount: 0,
      buildMs, // P0 D3.1：记录构建耗时，命中时用于估算节省时间
    };

    // LRU 淘汰
    if (cache.size >= config.maxEntries) {
      this.evictLRU(layer);
    }

    cache.set(key, entry);
    return entry;
  }

  /**
   * 检查内容是否变更（用于决定是否重建）
   */
  hasChanged(layer: CacheLayer, key: string, content: string): boolean {
    const existing = this.caches[layer].get(key);
    if (!existing) return true;
    return existing.hash !== contentHash(content);
  }

  /**
   * 组装完整 prompt — 三层合并
   *
   * @param stableBuilder 稳定层构建器
   * @param contextBuilder 上下文层构建器
   * @param volatileBuilder 易变层构建器
   */
  async assemble(
    stableBuilder: () => string | Promise<string>,
    contextBuilder: () => string | Promise<string>,
    volatileBuilder: () => string | Promise<string>,
  ): Promise<AssembledPrompt> {
    const start = Date.now();

    const [stable, context, volatile] = await Promise.all([
      this.getOrBuild('stable', 'system-prompt', stableBuilder),
      this.getOrBuild('context', 'project-context', contextBuilder),
      this.getOrBuild('volatile', 'runtime-state', volatileBuilder),
    ]);

    // 组装：stable → context → volatile
    const parts: string[] = [];
    if (stable.content) parts.push(stable.content);
    if (context.content) parts.push(context.content);
    if (volatile.content) parts.push(volatile.content);

    const content = parts.join('\n\n---\n\n');
    const totalTokens = stable.tokenCount + context.tokenCount + volatile.tokenCount;
    const assemblyMs = Date.now() - start;

    // 计算节省时间（命中缓存的部分不需要重建）
    const cachedLayers = [stable, context, volatile].filter(
      e => e.hitCount > 0 || Date.now() - e.createdAt < 10,
    );
    const fullyCached = cachedLayers.length === 3;

    const result: AssembledPrompt = {
      content,
      totalTokens,
      layerContributions: {
        stable: { tokens: stable.tokenCount, cached: stable.hitCount > 0, hash: stable.hash },
        context: { tokens: context.tokenCount, cached: context.hitCount > 0, hash: context.hash },
        volatile: { tokens: volatile.tokenCount, cached: volatile.hitCount > 0, hash: volatile.hash },
      },
      assemblyMs,
      fullyCached,
    };

    this.log.debug('Prompt 组装完成', {
      totalTokens,
      assemblyMs,
      fullyCached,
      stableCached: result.layerContributions.stable.cached,
      contextCached: result.layerContributions.context.cached,
      volatileCached: result.layerContributions.volatile.cached,
    });

    return result;
  }

  /**
   * 使指定层/键失效
   */
  invalidate(layer?: CacheLayer, key?: string): void {
    if (layer) {
      if (key) {
        this.caches[layer].delete(key);
      } else {
        this.caches[layer].clear();
      }
    } else {
      // 全部失效
      this.caches.stable.clear();
      this.caches.context.clear();
      this.caches.volatile.clear();
    }
  }

  /**
   * P0-5 深度优化: 缓存预热 — 在系统启动时预构建常用 prompt
   *
   * 对标 Claude Code 的 prompt prefix caching 预热机制：
   * 在首次请求前预构建 stable 和 context 层，确保首字符延迟最低。
   *
   * @param builders 预热构建器列表
   */
  async prewarm(builders: Array<{
    layer: CacheLayer;
    key: string;
    build: () => string | Promise<string>;
  }>): Promise<void> {
    const start = Date.now();
    let prewarmed = 0;

    for (const { layer, key, build } of builders) {
      try {
        await this.getOrBuild(layer, key, build);
        prewarmed++;
      } catch (err) {
        this.log.warn('预热失败', { layer, key, error: (err as Error).message });
      }
    }

    const elapsed = Date.now() - start;
    this.log.info('PromptCache 预热完成', {
      prewarmed,
      total: builders.length,
      elapsedMs: elapsed,
    });
  }

  /**
   * 当工具列表变更时失效稳定层
   */
  invalidateOnToolsChange(): void {
    this.invalidate('stable', 'system-prompt');
    this.log.debug('工具变更，稳定层缓存已失效');
  }

  /**
   * 当项目文件变更时失效上下文层
   */
  invalidateOnFileChange(): void {
    this.invalidate('context', 'project-context');
    this.log.debug('文件变更，上下文层缓存已失效');
  }

  /**
   * 获取统计信息
   */
  getStats(): PromptCacheStats {
    const layers: CacheLayer[] = ['stable', 'context', 'volatile'];
    const hitRateByLayer = {} as Record<CacheLayer, number>;
    let totalHits = 0;
    let totalMisses = 0;

    for (const layer of layers) {
      const hits = this.stats.hitsByLayer[layer];
      const misses = this.stats.missesByLayer[layer];
      const total = hits + misses;
      hitRateByLayer[layer] = total > 0 ? hits / total : 0;
      totalHits += hits;
      totalMisses += misses;
    }

    const cacheSize = {} as Record<CacheLayer, number>;
    const cachedTokens = {} as Record<CacheLayer, number>;
    for (const layer of layers) {
      cacheSize[layer] = this.caches[layer].size;
      let tokens = 0;
      for (const entry of this.caches[layer].values()) {
        tokens += entry.tokenCount;
      }
      cachedTokens[layer] = tokens;
    }

    const overallTotal = totalHits + totalMisses;
    return {
      hitsByLayer: { ...this.stats.hitsByLayer },
      missesByLayer: { ...this.stats.missesByLayer },
      hitRateByLayer,
      overallHitRate: overallTotal > 0 ? totalHits / overallTotal : 0,
      // P0 D3.1 修复：移除 Math.max(0, ...) 钳制 — 允许负值表示"缓存尚未带来净收益"
      // （首次构建成本 > 0，需多次命中才能回本）。之前钳制导致用户永远看不到真实节省时间。
      totalSavedMs: this.stats.totalSavedMs,
      cacheSize,
      cachedTokens,
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      hitsByLayer: { stable: 0, context: 0, volatile: 0 },
      missesByLayer: { stable: 0, context: 0, volatile: 0 },
      totalSavedMs: 0,
    };
  }

  // ============ 私有方法 ============

  /** LRU 淘汰 */
  private evictLRU(layer: CacheLayer): void {
    const cache = this.caches[layer];
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of cache.entries()) {
      if (entry.lastHitAt < oldestTime) {
        oldestTime = entry.lastHitAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
}

// ============ 单例 ============

let promptCacheInstance: PromptCache | null = null;

/** 获取单例 */
export function getPromptCache(): PromptCache {
  if (!promptCacheInstance) {
    promptCacheInstance = new PromptCache();
  }
  return promptCacheInstance;
}

/** 重置单例（测试用） */
export function resetPromptCache(): void {
  promptCacheInstance = null;
}
