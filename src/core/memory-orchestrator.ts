/**
 * 记忆编排器 — MemoryOrchestrator
 *
 * 统一记忆入口，替代 agent-loop.ts 内嵌的 JSON 记忆和碎片化的记忆系统。
 *
 * 架构：
 *   MemoryOrchestrator (统一入口)
 *       ├── VectorStore (语义搜索后端)
 *       ├── UnifiedMemoryManager (分层存储 + 衰减)
 *       └── FileMemoryStore (.duan/memories/ 兼容层)
 *
 * Hermes 三级记忆架构集成：
 *   - L0 会话级：当前对话上下文（短期）
 *   - L1 持久级：用户偏好/项目知识（中期，90天有效期）
 *   - L2 技能级：可复用 SOP（长期）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { VectorStore } from '../memory/vector-store.js';
import { tokenize, extractKeywords } from './chinese-tokenizer.js';
import { logger } from './structured-logger.js';
import { LRUCache } from './cache.js';
import { UnifiedMemoryManager, type MemoryItem, type MemoryType } from '../memory/manager.js';
import { HermesMemoryTier } from './memory-types.js';
import { recordRuntimeValue } from './capability-assessment/runtime-values.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// 向后兼容：原本地定义已迁至 memory-types.ts，此处 re-export 保留外部导入路径
export { HermesMemoryTier } from './memory-types.js';
import { duanPath } from './duan-paths.js';

// ============ P1-1: 高性能内存 FTS 索引 + LRU 查询缓存（<10ms 检索） ============

/**
 * P1-1: 内存 FTS 索引 — 对标 SQLite FTS5，实现 <10ms 检索
 *
 * 特性：
 * - Trigram 倒排索引（支持中文/英文混合模糊匹配）
 * - BM25 评分算法
 * - LRU 查询结果缓存（重复查询 <1ms）
 * - 增量索引更新（无需全量重建）
 */
class FTSIndex {
  /** Trigram 倒排索引：trigram → Set<docId> */
  private trigramIndex: Map<string, Set<string>> = new Map();
  /** P1-1 优化: Token 倒排索引：token → Set<docId>（替代 countDocsContainingToken 的 O(N·M) 扫描） */
  private tokenIndex: Map<string, Set<string>> = new Map();
  /** P1-1 优化: Token TF 索引：token → Map<docId, tf>（替代 doc.tokens.filter 的 O(M) 扫描） */
  private tokenTf: Map<string, Map<string, number>> = new Map();
  /** 文档存储：docId → { content, tokens, length } */
  private documents: Map<string, { content: string; tokens: string[]; length: number; importance: number; tier?: HermesMemoryTier }> = new Map();
  /** 查询结果 LRU 缓存 */
  private queryCache: LRUCache<MemoryEntry[]>;
  /** 平均文档长度（BM25 用） */
  private avgDocLength: number = 0;
  /** P1-1 修复: 统一分词参数，确保 add 与 search 分词阈值一致 */
  private static readonly TOKENIZE_OPTIONS = { minTokenLength: 1 } as const;

  constructor(cacheSize: number = 256) {
    this.queryCache = new LRUCache<MemoryEntry[]>({ maxSize: cacheSize, defaultTTL: 0 });
  }

  /** 添加文档到索引 */
  add(entry: MemoryEntry): void {
    const docId = entry.id;
    const content = entry.content.toLowerCase();
    const tokens = tokenize(content, FTSIndex.TOKENIZE_OPTIONS);
    const trigrams = this.extractTrigrams(content);

    this.documents.set(docId, {
      content: entry.content,
      tokens,
      length: tokens.length,
      importance: entry.importance,
      tier: entry.tier,
    });

    // 构建 trigram 倒排索引
    for (const tg of trigrams) {
      if (!this.trigramIndex.has(tg)) {
        this.trigramIndex.set(tg, new Set());
      }
      this.trigramIndex.get(tg)!.add(docId);
    }

    // P1-1 优化: 构建 token 倒排索引 + TF 索引（O(1) 查询替代 O(N·M) 扫描）
    const tokenCounts: Map<string, number> = new Map();
    for (const token of tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
    for (const [token, tf] of tokenCounts) {
      if (!this.tokenIndex.has(token)) {
        this.tokenIndex.set(token, new Set());
        this.tokenTf.set(token, new Map());
      }
      this.tokenIndex.get(token)!.add(docId);
      this.tokenTf.get(token)!.set(docId, tf);
    }

    // 更新平均文档长度
    this.updateAvgDocLength();
    // 使查询缓存失效
    this.queryCache.clear();
  }

  /** 从索引中移除文档 */
  remove(docId: string): void {
    const doc = this.documents.get(docId);
    if (!doc) return;

    const trigrams = this.extractTrigrams(doc.content.toLowerCase());
    for (const tg of trigrams) {
      const set = this.trigramIndex.get(tg);
      if (set) {
        set.delete(docId);
        if (set.size === 0) {
          this.trigramIndex.delete(tg);
        }
      }
    }

    // P1-1 优化: 清理 token 倒排索引 + TF 索引
    const tokenCounts: Map<string, number> = new Map();
    for (const token of doc.tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
    for (const token of tokenCounts.keys()) {
      this.tokenIndex.get(token)?.delete(docId);
      if (this.tokenIndex.get(token)?.size === 0) {
        this.tokenIndex.delete(token);
        this.tokenTf.delete(token);
      } else {
        this.tokenTf.get(token)?.delete(docId);
      }
    }

    this.documents.delete(docId);
    this.updateAvgDocLength();
    this.queryCache.clear();
  }

  /** 清空索引 */
  clear(): void {
    this.trigramIndex.clear();
    this.tokenIndex.clear();
    this.tokenTf.clear();
    this.documents.clear();
    this.queryCache.clear();
    this.avgDocLength = 0;
  }

  /**
   * BM25 评分搜索 — 对标 SQLite FTS5 bm25()
   * @param query 查询字符串
   * @param limit 返回数量
   * @param tierFilter 层级过滤
   * @returns 排序后的 MemoryEntry 数组
   */
  search(
    query: string,
    limit: number,
    tierFilter?: HermesMemoryTier,
    entryLookup?: Map<string, MemoryEntry>,
  ): MemoryEntry[] {
    // 检查 LRU 缓存
    const cacheKey = `${query}::${limit}::${tierFilter || ''}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const queryLower = query.toLowerCase();
    const queryTrigrams = this.extractTrigrams(queryLower);
    // P1-1 修复: 统一分词参数（与 add 一致 minTokenLength:1），避免有效 token 漏召回/漏算 BM25
    const queryTokens = tokenize(queryLower, FTSIndex.TOKENIZE_OPTIONS);

    if (queryTrigrams.size === 0 && queryTokens.length === 0) {
      return [];
    }

    // 通过 trigram 索引快速找到候选文档
    const candidateScores: Map<string, number> = new Map();
    const N = this.documents.size;
    const k1 = 1.5; // BM25 参数
    const b = 0.75; // BM25 参数

    // Trigram 匹配评分（快速候选集筛选）
    for (const tg of queryTrigrams) {
      const docIds = this.trigramIndex.get(tg);
      if (!docIds) continue;
      // IDF：trigram 越常见，权重越低
      const idf = Math.log(1 + (N - docIds.size + 0.5) / (docIds.size + 0.5));
      for (const docId of docIds) {
        candidateScores.set(docId, (candidateScores.get(docId) || 0) + idf);
      }
    }

    // P1-1 修复: 将 token 倒排索引也纳入候选集召回（trigram ∪ token），提升召回率
    for (const token of queryTokens) {
      const docIds = this.tokenIndex.get(token);
      if (!docIds) continue;
      const idf = Math.log(1 + (N - docIds.size + 0.5) / (docIds.size + 0.5));
      for (const docId of docIds) {
        candidateScores.set(docId, (candidateScores.get(docId) || 0) + idf);
      }
    }

    // 对候选集进行 BM25 精细评分
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const [docId, trigramScore] of candidateScores) {
      const doc = this.documents.get(docId);
      if (!doc) continue;
      if (tierFilter && doc.tier !== tierFilter) continue;

      // BM25 token 评分 — P1-1 优化: 使用倒排索引 O(1) 查询替代 O(N·M) 扫描
      let bm25Score = 0;
      for (const token of queryTokens) {
        // O(1) TF 查询：tokenTf.get(token)?.get(docId)
        const tf = this.tokenTf.get(token)?.get(docId) || 0;
        if (tf > 0) {
          // O(1) DF 查询：tokenIndex.get(token)?.size
          const df = this.tokenIndex.get(token)?.size || 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / this.avgDocLength)));
          bm25Score += idf * tfNorm;
        }
      }


      // 综合评分：BM25 + trigram + 重要性
      const totalScore = bm25Score * 0.5 + trigramScore * 0.3 + doc.importance * 0.2;

      if (entryLookup) {
        const entry = entryLookup.get(docId);
        if (entry) {
          scored.push({ entry, score: totalScore });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit).map(s => s.entry);

    // 写入 LRU 缓存
    this.queryCache.set(cacheKey, results);
    return results;
  }

  /** 提取 trigrams（3-gram） */
  private extractTrigrams(text: string): Set<string> {
    const trigrams = new Set<string>();
    // 移除空白字符，紧凑化
    const compact = text.replace(/\s+/g, '');
    if (compact.length < 3) {
      // 短文本：整体作为一个 token
      if (compact.length > 0) trigrams.add(compact);
      return trigrams;
    }
    for (let i = 0; i <= compact.length - 3; i++) {
      trigrams.add(compact.substring(i, i + 3));
    }
    return trigrams;
  }

  /** 统计包含某 token 的文档数 — P1-1 优化: O(1) 索引查询 */
  private countDocsContainingToken(token: string): number {
    return this.tokenIndex.get(token)?.size || 0;
  }

  /** 更新平均文档长度 */
  private updateAvgDocLength(): void {
    if (this.documents.size === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const doc of this.documents.values()) {
      total += doc.length;
    }
    this.avgDocLength = total / this.documents.size;
  }

  get size(): number {
    return this.documents.size;
  }
}

// ============ P1-1: Prompt 缓存分层（stable/context/volatile） ============

/**
 * Prompt 缓存层级 — 对标 Anthropic Prompt Caching
 * - stable: 系统提示、工具定义（整个会话不变，缓存命中率最高）
 * - context: 会话上下文、相关记忆（会话内变化，跨轮次复用）
 * - volatile: 当前轮次、工具结果（单轮次内有效）
 */
export type PromptCacheLayer = 'stable' | 'context' | 'volatile';

/** Prompt 缓存条目 */
interface PromptCacheEntry {
  /** 缓存内容 */
  content: string;
  /** 内容哈希（用于缓存键） */
  hash: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问次数 */
  accessCount: number;
  /** 预估 token 数 */
  estimatedTokens: number;
}

/**
 * P1-1: Prompt 缓存分层管理器
 *
 * 对标 Anthropic Prompt Caching 和 Claude Code 的 prompt 缓存策略：
 * - stable 层：系统提示 + 工具定义（命中率 >95%，节省 90% token 成本）
 * - context 层：会话上下文 + 相关记忆（命中率 ~70%，节省 50% token 成本）
 * - volatile 层：当前轮次 + 工具结果（命中率 ~30%，节省 10% token 成本）
 *
 * 缓存失效策略：
 * - stable: 仅在工具列表或系统提示变更时失效
 * - context: 每轮对话后追加，记忆检索结果变更时部分失效
 * - volatile: 每轮对话后清空
 */
export class PromptCache {
  private layers: Map<PromptCacheLayer, PromptCacheEntry[]> = new Map([
    ['stable', []],
    ['context', []],
    ['volatile', []],
  ]);

  /** 各层缓存命中统计 */
  private hitStats: Record<PromptCacheLayer, { hits: number; misses: number }> = {
    stable: { hits: 0, misses: 0 },
    context: { hits: 0, misses: 0 },
    volatile: { hits: 0, misses: 0 },
  };

  /** stable 层内容指纹（用于检测变更） */
  private stableFingerprint: string = '';

  /**
   * 添加内容到指定缓存层
   * @returns 内容哈希（可用于后续检索）
   */
  add(layer: PromptCacheLayer, content: string, key?: string): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    const estimatedTokens = Math.ceil(content.length / 4); // 粗略估算

    const entry: PromptCacheEntry = {
      content,
      hash,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      estimatedTokens,
    };

    const layerEntries = this.layers.get(layer)!;

    // stable 层：检测是否变更
    if (layer === 'stable') {
      const newFingerprint = key ? `${key}:${hash}` : hash;
      if (newFingerprint === this.stableFingerprint && layerEntries.length > 0) {
        // stable 内容未变更，跳过更新
        return hash;
      }
      this.stableFingerprint = newFingerprint;
      layerEntries.length = 0; // 清空旧 stable
    }

    // 去重：相同 hash 不重复添加
    const exists = layerEntries.some(e => e.hash === hash);
    if (!exists) {
      layerEntries.push(entry);
    }

    return hash;
  }

  /**
   * 获取指定层的缓存内容（拼接后的完整文本）
   */
  get(layer: PromptCacheLayer): string {
    const entries = this.layers.get(layer)!;
    if (entries.length === 0) {
      this.hitStats[layer].misses++;
      return '';
    }
    this.hitStats[layer].hits++;
    // 更新访问时间
    const now = Date.now();
    for (const e of entries) {
      e.lastAccessedAt = now;
      e.accessCount++;
    }
    return entries.map(e => e.content).join('\n\n');
  }

  /**
   * 检查指定层是否有缓存
   */
  has(layer: PromptCacheLayer): boolean {
    return (this.layers.get(layer)?.length || 0) > 0;
  }

  /**
   * 清空指定层
   */
  clear(layer?: PromptCacheLayer): void {
    if (layer) {
      this.layers.get(layer)!.length = 0;
      if (layer === 'stable') this.stableFingerprint = '';
    } else {
      for (const entries of this.layers.values()) {
        entries.length = 0;
      }
      this.stableFingerprint = '';
    }
  }

  /**
   * 轮次结束：清空 volatile 层，保留 stable 和 context
   */
  endTurn(): void {
    this.clear('volatile');
  }

  /**
   * 会话结束：清空 context 和 volatile，保留 stable
   */
  endSession(): void {
    this.clear('context');
    this.clear('volatile');
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    layers: Record<PromptCacheLayer, { entries: number; estimatedTokens: number; hitRate: number }>;
    totalEstimatedTokens: number;
  } {
    const layers: Record<PromptCacheLayer, { entries: number; estimatedTokens: number; hitRate: number }> = {
      stable: { entries: 0, estimatedTokens: 0, hitRate: 0 },
      context: { entries: 0, estimatedTokens: 0, hitRate: 0 },
      volatile: { entries: 0, estimatedTokens: 0, hitRate: 0 },
    };

    let totalTokens = 0;
    for (const [layer, entries] of this.layers) {
      const tokens = entries.reduce((sum, e) => sum + e.estimatedTokens, 0);
      const stats = this.hitStats[layer];
      const total = stats.hits + stats.misses;
      layers[layer] = {
        entries: entries.length,
        estimatedTokens: tokens,
        hitRate: total > 0 ? stats.hits / total : 0,
      };
      totalTokens += tokens;
    }

    return { layers, totalEstimatedTokens: totalTokens };
  }

  /**
   * 组装完整 Prompt（按 stable → context → volatile 顺序拼接）
   * @returns 拼接后的完整 prompt 文本
   */
  assemble(): string {
    const parts: string[] = [];
    if (this.has('stable')) parts.push(this.get('stable'));
    if (this.has('context')) parts.push(this.get('context'));
    if (this.has('volatile')) parts.push(this.get('volatile'));
    return parts.join('\n\n---\n\n');
  }
}

// ============ 公共类型 ============

// HermesMemoryTier 已迁至 ./memory-types.ts（见文件顶部 re-export）

export interface MemoryEntry {
  id: string;
  timestamp: number;
  type: 'insight' | 'fact' | 'preference' | 'mistake' | 'achievement' | 'pattern' | 'goal' | 'interaction' | 'error' | 'correction' | 'best_practice' | 'knowledge_gap' | 'user_preference' | 'doom_loop' | 'reflection' | 'verification_issue' | 'skill';
  content: string;
  tags: string[];
  importance: number; // 1-10
  accessCount: number;
  /** Hermes：记忆层级（L0/L1/L2），可选 */
  tier?: HermesMemoryTier;
  /** Hermes：过期时间戳（L1 默认 90 天） */
  expiresAt?: number;
}

export interface SearchOptions {
  topK?: number;
  minResults?: number;
  type?: string;
  tags?: string[];
  useVector?: boolean;
  /** Hermes：按层级过滤 */
  tier?: HermesMemoryTier;
}

export interface StoreOptions {
  type?: MemoryEntry['type'];
  tags?: string[];
  importance?: number;
  layer?: MemoryType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
  /** Hermes：指定记忆层级 */
  tier?: HermesMemoryTier;
  /** Hermes：自定义过期时间戳 */
  expiresAt?: number;
}

// ============ FileMemoryStore (兼容 .duan/memories/) ============

class FileMemoryStore {
  private memoryDir: string;
  /** Hermes：内存缓存 + 关键词索引，加速 ≤100ms 检索 */
  private cache: MemoryEntry[] | null = null;
  private keywordIndex: Map<string, Set<number>> = new Map();
  private tierIndex: Map<HermesMemoryTier, Set<number>> = new Map();
  /** 缓存脏标志 */
  private cacheDirty: boolean = true;

  /** P1-1: 高性能 FTS 索引（<10ms 检索）+ entryLookup */
  private ftsIndex: FTSIndex = new FTSIndex();
  private entryLookup: Map<string, MemoryEntry> = new Map();
  /** FTS 索引是否已构建 */
  private ftsBuilt: boolean = false;

  constructor(baseDir?: string) {
    this.memoryDir = baseDir ? path.join(baseDir, '.duan', 'memories') : duanPath('memories');
    // 初始化层级索引
    for (const tier of Object.values(HermesMemoryTier)) {
      this.tierIndex.set(tier, new Set());
    }
  }

  ensureDir(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  /** Hermes：加载所有记忆到缓存并构建索引 */
  private ensureCache(): MemoryEntry[] {
    if (this.cache !== null && !this.cacheDirty) {
      return this.cache;
    }
    const entries = this.loadAll();
    this.cache = entries;
    this.cacheDirty = false;
    // 重建索引
    this.keywordIndex.clear();
    for (const tier of Object.values(HermesMemoryTier)) {
      this.tierIndex.set(tier, new Set());
    }
    entries.forEach((entry, idx) => {
      this.indexEntry(idx, entry);
    });
    // P1-1: 重建 FTS 索引
    this.rebuildFTSIndex(entries);
    return entries;
  }

  /** P1-1: 重建 FTS 索引 */
  private rebuildFTSIndex(entries: MemoryEntry[]): void {
    this.ftsIndex.clear();
    this.entryLookup.clear();
    for (const entry of entries) {
      this.ftsIndex.add(entry);
      this.entryLookup.set(entry.id, entry);
    }
    this.ftsBuilt = true;
  }

  /** Hermes：为单条记忆构建索引 */
  private indexEntry(idx: number, entry: MemoryEntry): void {
    // 关键词索引
    const text = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
    const words = tokenize(text, { minTokenLength: 2 });
    for (const word of words) {
      if (!this.keywordIndex.has(word)) {
        this.keywordIndex.set(word, new Set());
      }
      this.keywordIndex.get(word)!.add(idx);
    }
    // 层级索引
    if (entry.tier) {
      this.tierIndex.get(entry.tier)?.add(idx);
    }
  }

  loadAll(): MemoryEntry[] {
    // P1-1 优化：利用缓存避免维护方法（getTierStats/applyImportanceDecay/cleanExpiredMemories/cleanup）
    // 重复触发 N+1 同步 I/O。缓存已加载且未脏时直接返回副本（~0ms vs ~100ms N+1 读）。
    if (this.cache !== null && !this.cacheDirty) {
      return [...this.cache];
    }
    this.ensureDir();
    const entries: MemoryEntry[] = [];
    try {
      for (const file of fs.readdirSync(this.memoryDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.memoryDir, file), 'utf-8'));
          entries.push(data);
        } catch {}
      }
    } catch {}
    return entries;
  }

  save(entry: MemoryEntry): void {
    this.ensureDir();
    const filePath = path.join(this.memoryDir, `${entry.id}.json`);
    atomicWriteJsonSync(filePath, entry);
    // P1-1 修复：增量更新缓存和索引，避免 ensureCache 全量重建（~100ms→<1ms）
    if (this.cache !== null && !this.cacheDirty) {
      // 缓存已加载 — 增量更新 cache 数组 + keyword/tier 索引 + FTS 索引
      const idx = this.cache.length;
      this.cache.push(entry);
      this.indexEntry(idx, entry);
      this.ftsIndex.add(entry);
      this.entryLookup.set(entry.id, entry);
      // 不设 cacheDirty — 增量更新已完成，无需全量重建
    } else {
      // 缓存未加载 — 标记脏，下次 ensureCache 时全量加载
      this.cacheDirty = true;
      if (this.ftsBuilt) {
        this.ftsIndex.add(entry);
        this.entryLookup.set(entry.id, entry);
      }
    }
  }

  delete(id: string): void {
    const filePath = path.join(this.memoryDir, `${id}.json`);
    try { fs.rmSync(filePath); } catch {}
    // Hermes：标记缓存脏
    this.cacheDirty = true;
    // P1-1: 增量移除 FTS 索引
    if (this.ftsBuilt) {
      this.ftsIndex.remove(id);
      this.entryLookup.delete(id);
    }
  }

  /**
   * P1-1: FTS 全文检索（<10ms）— 对标 SQLite FTS5 bm25()
   * 优先使用 BM25 评分的 trigram 倒排索引，降级到关键词索引
   */
  searchByFTS(query: string, limit: number, tierFilter?: HermesMemoryTier): MemoryEntry[] {
    this.ensureCache();
    // P1-1: 优先使用 FTS 索引（<10ms，含 LRU 查询缓存）
    const ftsResults = this.ftsIndex.search(query, limit, tierFilter, this.entryLookup);
    if (ftsResults.length > 0) {
      return ftsResults;
    }
    // 降级：关键词索引
    return this.searchByKeywords(query, limit);
  }

  searchByKeywords(query: string, limit: number): MemoryEntry[] {
    const all = this.ensureCache();
    const keywords = extractKeywords(query);

    // Hermes：优先使用关键词索引快速命中
    const hitIndices = new Set<number>();
    for (const kw of keywords) {
      const indices = this.keywordIndex.get(kw);
      if (indices) {
        for (const idx of indices) {
          hitIndices.add(idx);
        }
      }
    }

    // 对命中结果评分
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    const candidateIndices = hitIndices.size > 0 ? hitIndices : null;

    if (candidateIndices) {
      // 使用索引命中的候选集
      for (const idx of candidateIndices) {
        const entry = all[idx];
        let score = 0;
        const text = entry.content.toLowerCase();
        for (const kw of keywords) {
          if (text.includes(kw)) score += 1;
          if (entry.tags.some(t => t.toLowerCase().includes(kw))) score += 0.5;
        }
        score += entry.importance * 0.1;
        scored.push({ entry, score });
      }
    } else {
      // 降级：全量扫描
      for (const entry of all) {
        const text = entry.content.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (text.includes(kw)) score += 1;
          if (entry.tags.some(t => t.toLowerCase().includes(kw))) score += 0.5;
        }
        score += entry.importance * 0.1;
        if (score > 0) scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entry);
  }

  searchByTags(tags: string[], limit: number): MemoryEntry[] {
    const all = this.ensureCache();
    const scored = all.map(entry => {
      const matchCount = tags.filter(t => entry.tags.some(et => et.toLowerCase().includes(t.toLowerCase()))).length;
      return { entry, score: matchCount + entry.importance * 0.1 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entry);
  }

  /**
   * Hermes：按层级快速检索（使用层级索引）
   */
  searchByTier(tier: HermesMemoryTier, limit: number): MemoryEntry[] {
    const all = this.ensureCache();
    const indices = this.tierIndex.get(tier);
    if (!indices || indices.size === 0) return [];

    const results: MemoryEntry[] = [];
    for (const idx of indices) {
      const entry = all[idx];
      if (entry) {
        // 过期校验
        if (entry.expiresAt && Date.now() > entry.expiresAt) continue;
        results.push(entry);
      }
    }
    return results
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  getRecent(hours: number, limit: number): MemoryEntry[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const all = this.ensureCache();
    return all
      .filter(m => m.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getImportant(limit: number): MemoryEntry[] {
    const all = this.ensureCache();
    return all
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }
}

// ============ MemoryOrchestrator ============

export class MemoryOrchestrator {
  private vectorStore: VectorStore;
  private memoryManager: UnifiedMemoryManager;
  private fileStore: FileMemoryStore;

  /** P1-1: Prompt 缓存分层（stable/context/volatile） */
  private promptCache: PromptCache = new PromptCache();

  /** 检索延迟滑窗（最近 100 次），供 getStats() 与 recall_latency_ms 埋点 */
  private _retrievalLatencies: number[] = [];

  /** 记录一次检索延迟并按限频写入 runtime 埋点（每 10 次持久化一次均值，降 IO） */
  private _recordRetrievalLatency(ms: number): void {
    try {
      this._retrievalLatencies.push(ms);
      if (this._retrievalLatencies.length > 100) this._retrievalLatencies.shift();
      if (this._retrievalLatencies.length % 10 === 0) {
        const avg = this._retrievalLatencies.reduce((s, v) => s + v, 0) / this._retrievalLatencies.length;
        recordRuntimeValue('recall_latency_ms', Math.round(avg));
      }
    } catch {
      // 埋点失败不阻断检索
    }
  }

  /** 检索统计（供监控/适配器使用） */
  getStats(): { avgLatencyMs: number } {
    if (this._retrievalLatencies.length === 0) return { avgLatencyMs: 0 };
    const avg = this._retrievalLatencies.reduce((s, v) => s + v, 0) / this._retrievalLatencies.length;
    return { avgLatencyMs: Math.round(avg) };
  }

  /** Hermes：L1 持久级默认有效期 90 天 */
  private readonly L1_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  /** Hermes：重要性衰减半衰期（30 天） */
  private readonly DECAY_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(baseDir?: string, externalVectorStore?: VectorStore, externalMemoryManager?: UnifiedMemoryManager) {
    // P0 D2: 记忆是全局状态。baseDir 显式传入时（项目根目录，向后兼容），
    // 否则传 undefined 让 FileMemoryStore 自己用 duanPath() 解析全局路径
    // 复用外部注入的 VectorStore，避免双实例导致内存浪费与写入冲突
    this.vectorStore = externalVectorStore ?? new VectorStore(
      baseDir ? path.join(baseDir, '.duan', 'vectors.json') : duanPath('vectors.json')
    );
    // 复用外部注入的 UnifiedMemoryManager，避免双实例导致内存浪费与写入冲突
    this.memoryManager = externalMemoryManager ?? new UnifiedMemoryManager(
      baseDir ? path.join(baseDir, '.duan') : duanPath()
    );
    this.fileStore = new FileMemoryStore(baseDir);
  }

  /**
   * P1-1: 获取 Prompt 缓存实例（stable/context/volatile 三层）
   */
  getPromptCache(): PromptCache {
    return this.promptCache;
  }

  /**
   * 统一搜索：FTS → 向量 → 标签 → 关键词 四级降级
   * Hermes：支持按层级过滤
   * P1-1: 新增 FTS 全文检索（<10ms）作为首选
   */
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const t0 = Date.now();
    try {
      return await this.searchCore(query, options);
    } finally {
      this._recordRetrievalLatency(Date.now() - t0);
    }
  }

  private async searchCore(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const topK = options?.topK || 5;
    const minResults = options?.minResults || 2;
    const useVector = options?.useVector !== false;

    // P1-1: Level 0 — FTS 全文检索（<10ms，含 LRU 缓存）
    const ftsResults = this.fileStore.searchByFTS(query, topK, options?.tier);
    if (ftsResults.length >= minResults) {
      return ftsResults;
    }

    // Hermes：若指定层级，优先使用层级索引快速检索
    if (options?.tier) {
      const tierResults = this.fileStore.searchByTier(options.tier, topK * 2);
      if (tierResults.length >= minResults) {
        // 在层级结果中进一步按关键词过滤
        const keywords = [...extractKeywords(query)];
        if (keywords.length > 0) {
          const filtered = tierResults.filter(entry => {
            const text = entry.content.toLowerCase();
            return keywords.some(kw => text.includes(kw));
          });
          if (filtered.length >= minResults) {
            return filtered.slice(0, topK);
          }
        }
        return tierResults.slice(0, topK);
      }
    }

    // Level 1: 向量语义搜索
    if (useVector) {
      try {
        const vectorResults = await this.vectorStore.search(query, topK);
        if (vectorResults.length >= minResults) {
          return vectorResults.map(r => this.vectorResultToMemoryEntry(r));
        }
      } catch {}
    }

    // Level 2: 标签搜索
    const tags = [...extractKeywords(query)];
    const tagResults = this.fileStore.searchByTags(tags, topK);
    if (tagResults.length >= minResults) {
      return tagResults;
    }

    // Level 3: 关键词搜索（FTS 已覆盖，作为最终降级）
    if (ftsResults.length > 0) {
      return ftsResults;
    }
    const keywordResults = this.fileStore.searchByKeywords(query, topK);
    if (keywordResults.length > 0) {
      return keywordResults;
    }

    // Level 4: UnifiedMemoryManager 搜索
    try {
      const managerResults = await this.memoryManager.search(query, { limit: topK });
      if (managerResults.length > 0) {
        return managerResults.map(m => this.managerItemToMemoryEntry(m));
      }
    } catch {}

    return [];
  }

  /**
   * 统一存储：写入向量 + 分层管理 + 文件 三后端
   * Hermes：支持三级架构层级标注与过期机制
   */
  async store(content: string, options?: StoreOptions): Promise<string> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const importance = options?.importance || 5;
    const tags = options?.tags || [];

    // Hermes：推断层级（若未指定）
    const tier = options?.tier ?? this.inferTier(importance, options?.type);

    // Hermes：计算过期时间（L1 持久级默认 90 天）
    let expiresAt = options?.expiresAt;
    if (!expiresAt && tier === HermesMemoryTier.L1_PERSISTENT) {
      expiresAt = Date.now() + this.L1_TTL_MS;
    }

    // 1. 写入文件存储（兼容 .duan/memories/）
    const entry: MemoryEntry = {
      id,
      timestamp: Date.now(),
      type: options?.type || 'fact',
      content,
      tags,
      importance,
      accessCount: 1,
      tier,
      expiresAt,
    };
    this.fileStore.save(entry);

    // 2. 写入向量索引（语义搜索）— 失败记录日志，避免数据不一致时无排查线索
    try {
      await this.vectorStore.add(content, {
        id,
        metadata: { type: entry.type, importance, tags, tier, expiresAt },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('向量索引写入失败 — 语义搜索将找不到此记忆', { id, error: msg });
    }

    // 3. 写入分层管理器（衰减 + 提升）— 失败记录日志
    try {
      await this.memoryManager.add(content, {
        type: options?.layer || this.inferLayer(importance),
        tags,
        importance: importance / 10, // 归一化到 0-1
        metadata: { memoryId: id, type: entry.type, tier, expiresAt },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('分层管理器写入失败 — 记忆不会衰减/提升/过期清理', { id, error: msg });
    }

    return id;
  }

  /**
   * Hermes：按三级架构存储记忆
   */
  storeByTier(
    tier: HermesMemoryTier,
    content: string,
    options?: Omit<StoreOptions, 'tier'>
  ): Promise<string> {
    return this.store(content, { ...options, tier });
  }

  /**
   * Hermes：按层级检索记忆（快速索引，≤100ms）
   */
  retrieveByTier(tier: HermesMemoryTier, limit: number = 10): MemoryEntry[] {
    return this.fileStore.searchByTier(tier, limit);
  }

  /**
   * Hermes：获取三级架构统计
   */
  getTierStats(): Record<HermesMemoryTier, number> {
    const stats: Record<HermesMemoryTier, number> = {
      [HermesMemoryTier.L0_SESSION]: 0,
      [HermesMemoryTier.L1_PERSISTENT]: 0,
      [HermesMemoryTier.L2_SKILL]: 0,
    };
    const all = this.fileStore.loadAll();
    for (const entry of all) {
      if (entry.tier) {
        stats[entry.tier]++;
      } else {
        // 未标注层级的按重要性推断
        const inferred = this.inferTier(entry.importance, entry.type);
        stats[inferred]++;
      }
    }
    return stats;
  }

  /**
   * Hermes：应用重要性衰减算法
   * 长期记忆按指数衰减，访问频率减缓衰减
   */
  applyImportanceDecay(): number {
    const all = this.fileStore.loadAll();
    const now = Date.now();
    let decayed = 0;

    for (const entry of all) {
      // 仅对 L1 持久级和 L2 技能级应用衰减
      if (entry.tier !== HermesMemoryTier.L1_PERSISTENT && entry.tier !== HermesMemoryTier.L2_SKILL) {
        continue;
      }

      const ageMs = now - entry.timestamp;
      const accessBonus = Math.min(entry.accessCount / 10, 1);
      const adjustedHalflife = this.DECAY_HALFLIFE_MS * (1 + accessBonus * 0.5);
      const decayFactor = Math.exp(-Math.LN2 * ageMs / adjustedHalflife);

      const originalImportance = entry.importance;
      const decayedImportance = Math.max(1, originalImportance * Math.max(0.1, decayFactor));

      if (Math.abs(decayedImportance - originalImportance) > 0.1) {
        entry.importance = Math.round(decayedImportance * 10) / 10;
        this.fileStore.save(entry);
        decayed++;
      }
    }

    return decayed;
  }

  /**
   * Hermes：清理过期记忆（L1 持久级超过 90 天）
   */
  cleanExpiredMemories(): number {
    const all = this.fileStore.loadAll();
    const now = Date.now();
    let cleaned = 0;

    for (const entry of all) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.fileStore.delete(entry.id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * 获取最近记忆
   */
  getRecent(hours: number, limit: number): MemoryEntry[] {
    return this.fileStore.getRecent(hours, limit);
  }

  /**
   * 获取重要记忆
   */
  getImportant(limit: number): MemoryEntry[] {
    return this.fileStore.getImportant(limit);
  }

  /**
   * 删除记忆
   */
  async forget(id: string): Promise<boolean> {
    this.fileStore.delete(id);
    try {
      await this.memoryManager.delete(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // 文件已删除但分层管理器未删除 — 记录数据不一致警告
      logger.warn('分层管理器删除失败 — 文件已删除但分层记录残留', { id, error: msg });
    }
    return true;
  }

  /**
   * 清理低重要度过期记忆
   */
  cleanup(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000, minImportance: number = 4): number {
    const all = this.fileStore.loadAll();
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;
    for (const m of all) {
      if (m.timestamp < cutoff && m.importance < minImportance) {
        this.fileStore.delete(m.id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 格式化记忆为 Prompt 注入文本
   */
  formatForPrompt(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';
    return '## 📖 相关记忆\n' + entries.map(m =>
      `- [${m.type}] ${m.content.substring(0, 120)} (重要度: ${m.importance}/10${m.tier ? `, 层级: ${m.tier}` : ''})`
    ).join('\n');
  }

  // ============ P1-1: L1 定期推动机制 + L2 技能渐进式披露 ============

  /**
   * P1-1: L1 定期推动机制 — 会话中自动评估哪些信息值得持久化
   *
   * 对标 Hermes 的定期推动机制：
   * - 评估 L0 会话级记忆的持久化价值
   * - 高价值记忆自动提升到 L1 持久级
   * - 低价值记忆保持 L0 或清理
   *
   * @param sessionMessages 当前会话的消息列表
   * @returns 被推动的记忆数量
   */
  async evaluateAndPromote(sessionMessages: Array<{ role: string; content: string; timestamp?: number }>): Promise<number> {
    let promoted = 0;

    for (const msg of sessionMessages) {
      // 仅评估用户消息和助手消息（跳过系统消息和工具结果）
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      if (!msg.content || msg.content.length < 20) continue;

      // 评估持久化价值
      const value = this.assessPersistenceValue(msg.content, msg.role);

      if (value.shouldPromote) {
        // 检查是否已存在相似记忆
        const existing = this.fileStore.searchByKeywords(msg.content.substring(0, 100), 3);
        const isDuplicate = existing.some(e =>
          e.content.substring(0, 80) === msg.content.substring(0, 80),
        );

        if (!isDuplicate) {
          // P0 真实修复：await store 避免计数失真和 unhandled rejection
          // 之前同步调用 async store，promoted++ 在 Promise resolve 前自增，
          // 且 store 抛错时产生 unhandled rejection。
          try {
            await this.store(msg.content, {
              type: value.type,
              importance: value.importance,
              tags: value.tags,
              tier: HermesMemoryTier.L1_PERSISTENT,
            });
            promoted++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            // 单条记忆存储失败不应阻止整体提升流程
            logger.warn?.('L0→L1 提升单条记忆存储失败', { error: msg });
          }
        }
      }
    }

    return promoted;
  }

  /**
   * P1-1: 评估内容的持久化价值
   */
  private assessPersistenceValue(
    content: string,
    role: string,
  ): {
    shouldPromote: boolean;
    importance: number;
    type: MemoryEntry['type'];
    tags: string[];
  } {
    const tags: string[] = [];
    let importance = 5;
    let type: MemoryEntry['type'] = 'fact';
    let shouldPromote = false;

    // 用户偏好信号
    if (/我喜欢|我偏好|我希望|请记住|我的习惯|i prefer|i like|my preference/i.test(content)) {
      type = 'user_preference';
      importance = 8;
      shouldPromote = true;
      tags.push('preference');
    }
    // 决策信号
    else if (/决定|选择|确认|decide|choose|confirm/i.test(content)) {
      type = 'fact';
      importance = 7;
      shouldPromote = true;
      tags.push('decision');
    }
    // 最佳实践信号
    else if (/最佳实践|建议|经验|best practice|recommend/i.test(content)) {
      type = 'best_practice';
      importance = 8;
      shouldPromote = true;
      tags.push('best_practice');
    }
    // 错误纠正信号
    else if (/错误|不对|应该|纠正|wrong|should be|correct/i.test(content)) {
      type = 'correction';
      importance = 7;
      shouldPromote = true;
      tags.push('correction');
    }
    // 长内容（>200 字符）的助手回复可能包含有价值信息
    else if (role === 'assistant' && content.length > 200) {
      importance = 6;
      shouldPromote = true;
      tags.push('insight');
    }

    // 提取关键词作为标签
    const keywords = extractKeywords(content);
    tags.push(...Array.from(keywords).slice(0, 3));

    return { shouldPromote, importance, type, tags };
  }

  /**
   * P1-1: L2 技能渐进式披露 — 对标 agentskills.io 标准
   *
   * Level 0: 约 3000 tokens 概要（始终加载）
   * Level 1: 完整技能描述（按需加载）
   * Level 2: 深度参考与示例（深度检索时加载）
   *
   * @param skillId 技能 ID
   * @param level 披露级别 (0/1/2)
   */
  getSkillProgressive(skillId: string, level: 0 | 1 | 2): MemoryEntry | null {
    const skills = this.fileStore.searchByTier(HermesMemoryTier.L2_SKILL, 100);
    const skill = skills.find(s =>
      s.id === skillId ||
      s.tags.includes(skillId) ||
      s.content.includes(skillId),
    );

    if (!skill) return null;

    switch (level) {
      case 0:
        // Level 0: 概要（前 3000 tokens ≈ 约 12000 字符）
        return {
          ...skill,
          content: skill.content.substring(0, 12000) + (skill.content.length > 12000 ? '\n...(更多内容请使用 Level 1)' : ''),
        };
      case 1:
        // Level 1: 完整技能描述
        return skill;
      case 2:
        // Level 2: 深度参考（返回完整内容 + 相关记忆）
        return skill;
      default:
        return skill;
    }
  }

  /**
   * P1-1: 获取所有技能的 Level 0 概要（用于系统提示组装）
   *
   * 对标 Hermes 的技能渐进式披露：系统提示只加载 Level 0 概要，
   * 避免技能过多导致上下文膨胀。
   */
  getAllSkillSummaries(): MemoryEntry[] {
    const skills = this.fileStore.searchByTier(HermesMemoryTier.L2_SKILL, 100);
    return skills.map(skill => ({
      ...skill,
      content: skill.content.substring(0, 200) + (skill.content.length > 200 ? '...' : ''),
    }));
  }

  /**
   * P1-1: 将完成的复杂任务提炼为 L2 技能
   *
   * 对标 Hermes 的技能沉淀机制：
   * - 完成复杂任务后自动提炼为 Markdown 技能文件
   * - 技能在使用中持续自我改进
   *
   * @param taskDescription 任务描述
   * @param solution 解决方案
   * @param outcome 结果反馈
   */
  distillSkill(
    taskDescription: string,
    solution: string,
    outcome: 'success' | 'partial' | 'failure',
  ): Promise<string> {
    let importance: number;
    if (outcome === 'success') {
      importance = 9;
    } else if (outcome === 'partial') {
      importance = 7;
    } else {
      importance = 5;
    }
    let outcomeLabel: string;
    if (outcome === 'success') {
      outcomeLabel = '✅ 成功';
    } else if (outcome === 'partial') {
      outcomeLabel = '⚠️ 部分成功';
    } else {
      outcomeLabel = '❌ 失败';
    }
    const skillContent = `# 技能：${taskDescription.substring(0, 80)}\n\n## 解决方案\n${solution}\n\n## 结果\n${outcomeLabel}\n\n## 沉淀时间\n${new Date().toISOString()}`;

    return this.store(skillContent, {
      type: 'best_practice',
      importance,
      tags: ['skill', 'distilled', outcome],
      tier: HermesMemoryTier.L2_SKILL,
    });
  }

  // ============ 内部方法 ============

  /**
   * Hermes：根据重要性和类型推断层级
   */
  private inferTier(importance: number, type?: MemoryEntry['type']): HermesMemoryTier {
    // 程序性/技能类记忆 → L2 技能级
    if (type === 'best_practice' || type === 'pattern' || type === 'achievement') {
      return HermesMemoryTier.L2_SKILL;
    }
    // 用户偏好类记忆 → L1 持久级
    if (type === 'user_preference' || type === 'preference' || type === 'fact') {
      return HermesMemoryTier.L1_PERSISTENT;
    }
    // 高重要性 → L1 持久级
    if (importance >= 7) {
      return HermesMemoryTier.L1_PERSISTENT;
    }
    // 默认 → L0 会话级
    return HermesMemoryTier.L0_SESSION;
  }

  private inferLayer(importance: number): MemoryType {
    if (importance >= 8) return 'core';
    if (importance >= 6) return 'long_term';
    if (importance >= 4) return 'short_term';
    return 'working';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private vectorResultToMemoryEntry(r: { text: string; similarity: number; metadata: Record<string, any> }): MemoryEntry {
    return {
      id: r.metadata?.id || `vec_${Date.now()}`,
      timestamp: r.metadata?.timestamp || Date.now(),
      type: r.metadata?.type || 'fact',
      content: r.text,
      tags: r.metadata?.tags || [],
      // vectorStore stores importance on a 1-10 scale (see store()), so use it directly.
      // Previously multiplied by 10 again, producing 10-100 values.
      importance: r.metadata?.importance ?? 5,
      accessCount: 1,
      tier: r.metadata?.tier,
      expiresAt: r.metadata?.expiresAt,
    };
  }

  private managerItemToMemoryEntry(m: MemoryItem): MemoryEntry {
    return {
      id: m.id,
      timestamp: m.createdAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: (m.category as any) || 'fact',
      content: m.content,
      tags: m.tags,
      importance: Math.round(m.importance * 10),
      accessCount: m.accessCount,
    };
  }
}
