/**
 * 统一记忆管理器 (UnifiedMemoryManager)
 * 合并 manager.ts / enhanced-memory.ts / hierarchical-memory.ts 三者的优点：
 *   - JSON 文件持久化 + 时间衰减（来自 manager.ts）
 *   - type 分类 + tags 标签（来自 enhanced-memory.ts）
 *   - 分层架构：工作 / 短期 / 长期 / 核心（来自 hierarchical-memory.ts）
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SemanticRecaller } from '../core/attention-mechanism.js';
import type { EmbeddingProvider } from '../core/embedding-provider.js';
import { atomicWriteJson } from '../core/atomic-write.js';

// ============ 公共类型 ============

export interface MemoryItem {
  id: string;
  content: string;
  type: 'working' | 'short_term' | 'long_term' | 'core';
  category?: 'user' | 'assistant' | 'system' | 'knowledge' | 'experience';
  tags: string[];
  importance: number; // 0-1
  createdAt: number;
  accessedAt: number;
  accessCount: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

export type MemoryType = MemoryItem['type'];
export type MemoryCategory = NonNullable<MemoryItem['category']>;

/** 各层记忆的半衰期（毫秒） */
const HALF_LIVES: Record<MemoryType, number> = {
  working: 1 * 60 * 60 * 1000,       // 1 小时
  short_term: 6 * 60 * 60 * 1000,    // 6 小时
  long_term: 7 * 24 * 60 * 60 * 1000, // 7 天
  core: Infinity,                      // 不衰减
};

/** 层级提升顺序 */
const TYPE_ORDER: MemoryType[] = ['working', 'short_term', 'long_term', 'core'];

function nextType(t: MemoryType): MemoryType | null {
  const idx = TYPE_ORDER.indexOf(t);
  return idx < TYPE_ORDER.length - 1 ? TYPE_ORDER[idx + 1] : null;
}

// ============ 语义关联映射（来自 hierarchical-memory.ts） ============

const SEMANTIC_GROUPS: string[][] = [
  ['代码', '编程', '开发', '程序', '函数', '类', '模块', '项目'],
  ['bug', '错误', '报错', '异常', '调试', 'debug', '修复'],
  ['优化', '性能', '加速', '改进', '提升', '重构'],
  ['部署', '发布', '上线', '运维', '服务器', 'docker'],
  ['测试', '验证', '检验', '单元测试', '集成测试'],
  ['设计', '架构', '模式', '结构', '方案'],
  ['数据', '数据库', '存储', '查询', '表'],
  ['安全', '漏洞', '加密', '认证', '授权'],
  ['前端', '界面', 'UI', '页面', '组件'],
  ['后端', 'API', '接口', '服务', '微服务'],
];

// ============ UnifiedMemoryManager ============

export class UnifiedMemoryManager {
  private memories: Map<string, MemoryItem> = new Map();
  private dbPath: string;
  private maxEntries: number;
  private loaded: boolean = false;
  /**
   * 构造函数触发的 load() 的 in-flight Promise。
   * 用于避免 ensureLoaded() 在 loaded 还是 false 时二次调用 load() 与构造时的 load 并发，
   * 后完成者会 clear memories 导致刚 add 的数据丢失（生产 bug，I-4 测试暴露）。
   */
  private loadPromise: Promise<void> | null = null;
  private semanticRecaller: SemanticRecaller | null = null;

  constructor(dataDir?: string, maxEntries: number = 10000) {
    const dir = dataDir || './data';
    this.dbPath = path.join(dir, 'memories.json');
    this.maxEntries = maxEntries;
    // 启动时自动加载（追踪 in-flight promise，避免二次 load 与之并发）
    this.loadPromise = this.load();
  }

  /**
   * 启用基于注意力机制的语义召回（消灭孤岛 I-4）
   *
   * 启用后 search() 的语义关联得分将通过 SemanticRecaller 计算，
   * 取代原有的 SEMANTIC_GROUPS 硬编码关键词匹配。与 context-manager.ts
   * 的召回路径复用同一范式（见 context-manager.ts:122,133,258）。
   *
   * 未启用时回退到 computeSemanticSimilarity() 的硬编码匹配，行为不变。
   */
  enableSemanticRecall(dim = 256): void {
    this.semanticRecaller = new SemanticRecaller(dim);
  }

  /**
   * 注入真实语义嵌入提供者（OpenAI / TF-IDF 等）
   *
   * 注入后 SemanticRecaller 使用真实语义向量；未注入时使用哈希嵌入降级。
   * 必须先调用 enableSemanticRecall()。
   *
   * @returns true 表示注入成功，false 表示 SemanticRecaller 未启用
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): boolean {
    if (!this.semanticRecaller) return false;
    this.semanticRecaller.setEmbeddingProvider(provider);
    return true;
  }

  /** 查询是否已启用注意力召回 */
  hasSemanticRecall(): boolean {
    return this.semanticRecaller !== null;
  }

  // -------- 核心操作 --------

  async add(
    content: string,
    options?: {
      type?: MemoryType;
      category?: MemoryCategory;
      tags?: string[];
      importance?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<MemoryItem> {
    await this.ensureLoaded();

    const item: MemoryItem = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content,
      type: options?.type ?? 'working',
      category: options?.category,
      tags: options?.tags ?? [],
      importance: this.calculateImportance(content, options?.importance),
      createdAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 0,
      metadata: options?.metadata,
    };

    this.memories.set(item.id, item);
    await this.enforceLimit();
    await this.save();
    return item;
  }

  async search(
    query: string,
    options?: {
      limit?: number;
      type?: MemoryType;
      category?: MemoryCategory;
      tags?: string[];
    },
  ): Promise<MemoryItem[]> {
    await this.ensureLoaded();

    const limit = options?.limit ?? 5;
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const queryTags = options?.tags ?? [];

    const candidates = [...this.memories.values()].filter(item => {
      if (options?.type && item.type !== options.type) return false;
      if (options?.category && item.category !== options.category) return false;
      if (queryTags.length > 0 && !queryTags.some(t => item.tags.includes(t))) return false;
      return true;
    });

    // 消灭孤岛 I-4：启用注意力召回时，用 SemanticRecaller 计算语义得分（与
    // context-manager.ts:258 同范式）；未启用时回退到 computeSemanticSimilarity
    const semanticScoreMap = this.buildSemanticScoreMap(query, candidates);

    const scored = candidates.map(item => {
      const text = item.content.toLowerCase();

      // 1. 关键词匹配得分
      let keywordScore = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) keywordScore += 1;
      }
      keywordScore = keywords.length > 0 ? keywordScore / keywords.length : 0;

      // 2. tag 匹配得分
      let tagScore = 0;
      if (queryTags.length > 0) {
        const matched = queryTags.filter(t => item.tags.includes(t)).length;
        tagScore = matched / queryTags.length;
      }

      // 3. 语义关联得分（注意力召回或硬编码 fallback）
      const semanticScore = semanticScoreMap.get(item.id)
        ?? this.computeSemanticSimilarity(query, item.content);

      // 4. 重要性加权
      const importanceScore = item.importance;

      // 5. 时间衰减
      const decayScore = this.computeDecay(item);

      // 综合得分
      const totalScore =
        keywordScore * 0.35 +
        tagScore * 0.15 +
        semanticScore * 0.15 +
        importanceScore * 0.2 +
        decayScore * 0.15;

      return { item, score: totalScore };
    });

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, limit);
    for (const { item } of results) {
      item.accessCount++;
      item.accessedAt = Date.now();
    }

    // P1-1 修复：读操作不触发写盘 — accessCount 更新在内存中完成，
    // 下一次 add()/update()/delete() 的 save() 会顺带持久化。
    // 避免每次搜索都写整个 memories.json 到磁盘（~5-10ms I/O）
    return results.map(r => r.item);
  }

  async get(id: string): Promise<MemoryItem | null> {
    await this.ensureLoaded();
    const item = this.memories.get(id) ?? null;
    if (item) {
      item.accessCount++;
      item.accessedAt = Date.now();
    }
    return item;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.memories.delete(id);
    if (existed) await this.save();
    return existed;
  }

  async update(id: string, updates: Partial<MemoryItem>): Promise<boolean> {
    await this.ensureLoaded();
    const item = this.memories.get(id);
    if (!item) return false;

    // 不允许修改 id 和 createdAt
    const { id: _id, createdAt: _createdAt, ...safeUpdates } = updates as Partial<MemoryItem>;
    Object.assign(item, safeUpdates);
    item.accessedAt = Date.now();
    await this.save();
    return true;
  }

  // -------- 分层管理 --------

  /** 提升记忆层级（working → short_term → long_term → core） */
  async promote(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const item = this.memories.get(id);
    if (!item) return false;

    const next = nextType(item.type);
    if (!next) return false; // 已是最高层级

    item.type = next;
    item.accessedAt = Date.now();
    await this.save();
    return true;
  }

  /** 执行衰减，降级不活跃记忆 */
  async decay(): Promise<void> {
    await this.ensureLoaded();
    const toRemove: string[] = [];
    const toDemote: string[] = [];

    for (const [id, item] of this.memories) {
      if (item.type === 'core') continue; // 核心记忆不衰减

      const decay = this.computeDecay(item);
      if (decay < 0.05) {
        // 衰减到极低，直接删除
        toRemove.push(id);
      } else if (decay < 0.2) {
        // 衰减较低，降级一层
        const idx = TYPE_ORDER.indexOf(item.type);
        if (idx > 0) {
          toDemote.push(id);
        }
      }
    }

    for (const id of toRemove) {
      this.memories.delete(id);
    }
    for (const id of toDemote) {
      const item = this.memories.get(id);
      if (item) {
        const idx = TYPE_ORDER.indexOf(item.type);
        item.type = TYPE_ORDER[idx - 1];
      }
    }

    if (toRemove.length > 0 || toDemote.length > 0) {
      await this.save();
    }
  }

  // -------- 持久化 --------

  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      const data = [...this.memories.values()];
      await atomicWriteJson(this.dbPath, data);
    } catch (error) {
      console.error('保存记忆失败:', error);
    }
  }

  async load(): Promise<void> {
    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      const raw = await fs.readFile(this.dbPath, 'utf-8');
      const data: MemoryItem[] = JSON.parse(raw);
      this.memories.clear();
      for (const item of data) {
        this.memories.set(item.id, item);
      }
    } catch {
      this.memories.clear();
    }
    this.loaded = true;
  }

  // -------- 统计 --------

  getStats(): {
    total: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    const byType: Record<string, number> = { working: 0, short_term: 0, long_term: 0, core: 0 };
    const byCategory: Record<string, number> = {};

    for (const item of this.memories.values()) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
      const cat = item.category ?? 'uncategorized';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }

    return { total: this.memories.size, byType, byCategory };
  }

  // -------- 兼容旧接口 --------

  /** 获取所有记忆（兼容旧 MemoryManager.getAll） */
  getAll(): MemoryItem[] {
    return [...this.memories.values()];
  }

  /** 清空记忆 */
  async clear(): Promise<void> {
    this.memories.clear();
    await this.save();
  }

  // ============ 私有方法 ============

  private async ensureLoaded(): Promise<void> {
    // 优先 await 构造函数触发的 in-flight load，避免与之并发二次 load
    if (this.loadPromise !== null) {
      const p = this.loadPromise;
      this.loadPromise = null;
      await p;
    } else if (!this.loaded) {
      await this.load();
    }
  }

  /** 计算记忆重要性 */
  private calculateImportance(content: string, baseImportance?: number): number {
    let importance = baseImportance ?? 0.5;

    // 长内容更重要
    if (content.length > 500) importance += 0.1;
    if (content.length > 1000) importance += 0.1;

    // 包含代码的内容更重要
    if (content.includes('```')) importance += 0.2;

    // 包含重要关键词
    const importantKeywords = ['重要', '关键', '核心', 'important', 'key', 'critical'];
    if (importantKeywords.some(k => content.toLowerCase().includes(k))) {
      importance += 0.15;
    }

    // 包含错误信息
    if (content.includes('error') || content.includes('错误')) {
      importance += 0.1;
    }

    return Math.min(importance, 1);
  }

  /** 计算衰减分数（0-1，1 = 完全新鲜） */
  private computeDecay(item: MemoryItem): number {
    const halfLife = HALF_LIVES[item.type];
    if (halfLife === Infinity) return 1;

    const age = Date.now() - item.createdAt;
    // 基础衰减
    let decay = Math.exp(-Math.LN2 * age / halfLife);

    // 访问频率减缓衰减
    const accessBonus = Math.min(item.accessCount / 5, 1);
    decay = Math.exp(-Math.LN2 * age / (halfLife * (1 + accessBonus * 0.5)));

    // 最近访问奖励
    const timeSinceAccess = Date.now() - item.accessedAt;
    const accessRecency = Math.max(0, 1 - timeSinceAccess / 1800000); // 30 分钟内

    return Math.max(0, decay * 0.85 + accessRecency * 0.15);
  }

  /** 计算语义相似度（来自 hierarchical-memory.ts） */
  private computeSemanticSimilarity(query: string, content: string): number {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();

    let similarity = 0;
    for (const group of SEMANTIC_GROUPS) {
      const queryHits = group.filter(w => queryLower.includes(w));
      const contentHits = group.filter(w => contentLower.includes(w));
      if (queryHits.length > 0 && contentHits.length > 0) {
        similarity += 0.2;
      }
    }

    return Math.min(similarity, 1.0);
  }

  /**
   * 构建语义得分映射（消灭孤岛 I-4）
   *
   * 启用 SemanticRecaller 时，将候选记忆加入召回库，用注意力机制计算
   * 每条记忆与 query 的语义相关性，归一化到 [0, 1]。与 context-manager.ts
   * 的 computeSemanticScores() 同范式（见 context-manager.ts:245-277）。
   *
   * 未启用时返回空 Map，调用方回退到 computeSemanticSimilarity()。
   *
   * 失败时降级为空 Map（保持启发式评分继续工作，与 context-manager 行为一致）。
   */
  private buildSemanticScoreMap(
    query: string,
    candidates: MemoryItem[],
  ): Map<string, number> {
    if (!this.semanticRecaller || candidates.length === 0) {
      return new Map();
    }

    try {
      this.semanticRecaller.clear();
      candidates.forEach(item => {
        this.semanticRecaller!.add(item.id, item.content);
      });

      const recalled = this.semanticRecaller.recall(query, candidates.length);

      let maxScore = 0;
      const scoreMap = new Map<string, number>();
      for (const r of recalled) {
        scoreMap.set(r.id, r.score);
        if (r.score > maxScore) maxScore = r.score;
      }

      // 归一化到 [0, 1]，与 computeSemanticSimilarity 输出范围对齐
      if (maxScore > 0) {
        for (const [id, score] of scoreMap) {
          scoreMap.set(id, score / maxScore);
        }
      }
      return scoreMap;
    } catch {
      // 注意力计算失败时降级为空 Map，调用方回退到启发式
      return new Map();
    }
  }

  /** 限制记忆数量 + 自动提升 */
  private enforceLimit(): Promise<void> {
    // 自动提升：accessCount > 5 且 importance > 0.7 的短期记忆提升为长期
    for (const item of this.memories.values()) {
      if (item.type === 'short_term' && item.accessCount > 5 && item.importance > 0.7) {
        item.type = 'long_term';
      }
    }

    // 超出容量时移除低分记忆
    if (this.memories.size > this.maxEntries) {
      const scored = [...this.memories.values()].map(item => ({
        id: item.id,
        score: item.importance * 0.6 + this.computeDecay(item) * 0.4,
      }));
      scored.sort((a, b) => a.score - b.score);

      const removeCount = this.memories.size - this.maxEntries;
      for (let i = 0; i < removeCount; i++) {
        this.memories.delete(scored[i].id);
      }
    }
    return Promise.resolve();
  }
}

// -------- 向后兼容别名 --------
export const MemoryManager = UnifiedMemoryManager;
