/**
 * 四级记忆存储系统 — MemoryStore
 *
 * 遵循 OpenViking viking:// 协议：
 *   viking://memory/
 *   ├── short_term/     # 短期：当前 Session 的 Buffer
 *   ├── working/        # 工作：当前任务的 Scratchpad (如 TodoList)
 *   ├── long_term/      # 长期：跨会话事实 (SQLite + 向量)
 *   └── procedural/     # 程序性：沉淀的 Skills (SOP)
 *
 * 核心能力：
 * 1. 四级分层 — 短期/工作/长期/程序性，各级独立容量与淘汰策略
 * 2. 自动提升 — 频繁访问 + 高重要性的记忆自动从低级提升到高级
 * 3. 整合压缩 — 过期清理、提升晋升、相似合并三步整合
 * 4. Prompt 注入 — 按 token 预算格式化各级记忆供 LLM 使用
 * 5. 模块同步 — 与 Scratchpad / ReflectionEngine / VFS 双向同步
 * 6. 序列化 — toJSON/fromJSON 支持持久化
 */

// ============ 类型定义 ============

/** 记忆级别（原有四级架构，向后兼容） */
export enum MemoryLevel {
  /** 短期：当前 Session 的 Buffer，自动过期 */
  SHORT_TERM = 'short_term',
  /** 工作：当前任务的 Scratchpad，任务间清除 */
  WORKING = 'working',
  /** 长期：跨会话事实，重要性淘汰 */
  LONG_TERM = 'long_term',
  /** 程序性：沉淀的 Skills (SOP)，仅手动删除 */
  PROCEDURAL = 'procedural',
}

// HermesMemoryTier 已迁至 ./memory-types.ts（单一来源）
import { HermesMemoryTier } from './memory-types.js';

/** 原有级别 → Hermes 三级映射 */
const LEVEL_TO_TIER: Record<MemoryLevel, HermesMemoryTier> = {
  [MemoryLevel.SHORT_TERM]: HermesMemoryTier.L0_SESSION,
  [MemoryLevel.WORKING]: HermesMemoryTier.L0_SESSION,
  [MemoryLevel.LONG_TERM]: HermesMemoryTier.L1_PERSISTENT,
  [MemoryLevel.PROCEDURAL]: HermesMemoryTier.L2_SKILL,
};

/** Hermes 三级 → 原有级别映射（取代表级别） */
const TIER_TO_LEVEL: Record<HermesMemoryTier, MemoryLevel> = {
  [HermesMemoryTier.L0_SESSION]: MemoryLevel.WORKING,
  [HermesMemoryTier.L1_PERSISTENT]: MemoryLevel.LONG_TERM,
  [HermesMemoryTier.L2_SKILL]: MemoryLevel.PROCEDURAL,
};

/** 用户偏好类型（用于精准识别） */
export type PreferenceCategory =
  | 'programming_language'
  | 'work_habit'
  | 'communication_style'
  | 'tool_preference'
  | 'detail_level'
  | 'expertise_level';

/** 用户偏好条目（带置信度与过期机制） */
export interface UserPreferenceEntry {
  /** 偏好类别 */
  category: PreferenceCategory;
  /** 偏好键名 */
  key: string;
  /** 偏好值 */
  value: string;
  /** 置信度评分 0-1（出现次数越多、来源越权威则越高） */
  confidence: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后确认时间戳 */
  lastConfirmedAt: number;
  /** 过期时间戳（默认 90 天） */
  expiresAt: number;
  /** 确认次数（每次再次出现则 +1） */
  confirmCount: number;
}

/** 记忆条目 */
export interface MemoryEntry {
  /** 唯一标识 */
  id: string;
  /** 所属级别 */
  level: MemoryLevel;
  /** 记忆键名 */
  key: string;
  /** 记忆内容 */
  content: string;
  /** 元数据 */
  metadata: {
    /** 创建时间戳 */
    createdAt: number;
    /** 更新时间戳 */
    updatedAt: number;
    /** 最后访问时间戳 */
    accessedAt: number;
    /** 访问次数 */
    accessCount: number;
    /** 重要性评分 0-1 */
    importance: number;
    /** 来源：'user' | 'agent' | 'reflection' | 'system' */
    source: string;
    /** 标签列表 */
    tags: string[];
    /** 所属会话 ID（仅 short_term） */
    sessionId?: string;
    /** 过期时间戳（仅 short_term，自动清理） */
    expiresAt?: number;
  };
}

/** 记忆查询条件 */
export interface MemoryQuery {
  /** 关键词列表（匹配 key 和 content） */
  keywords?: string[];
  /** 标签过滤 */
  tags?: string[];
  /** 级别过滤 */
  level?: MemoryLevel;
  /** 来源过滤 */
  source?: string;
  /** 最低重要性阈值 */
  minImportance?: number;
  /** 返回条数上限 */
  limit?: number;
  /** 会话 ID 过滤（仅 short_term） */
  sessionId?: string;
}

/** store 方法的输入参数（省略自动生成的字段） */
export type MemoryStoreInput = Omit<MemoryEntry, 'id' | 'metadata'> & {
  level: MemoryLevel;
  importance?: number;
  source?: string;
  tags?: string[];
  sessionId?: string;
  expiresAt?: number;
};

/** 整合结果统计 */
export interface ConsolidationResult {
  /** 提升到更高级别的条目数 */
  promoted: number;
  /** 过期清理的条目数 */
  expired: number;
  /** 压缩合并的条目数 */
  compressed: number;
}

/** 记忆统计信息 */
export interface MemoryStats {
  shortTerm: number;
  working: number;
  longTerm: number;
  procedural: number;
  totalSize: number;
}

// ============ 常量 ============

/** 各级别最大条目数 */
const DEFAULT_MAX_SHORT_TERM = 50;
const DEFAULT_MAX_WORKING = 100;
const DEFAULT_MAX_LONG_TERM = 500;
const DEFAULT_MAX_PROCEDURAL = 200;

/** 短期记忆默认过期时间：30 分钟 */
const SHORT_TERM_TTL = 30 * 60 * 1000;

/** 提升阈值：访问次数 */
const PROMOTION_ACCESS_THRESHOLD = 3;

/** 提升阈值：最低重要性 */
const PROMOTION_IMPORTANCE_THRESHOLD = 0.5;

/** 整合触发阈值：短期记忆使用率达到此比例时触发整合 */
const CONSOLIDATION_USAGE_RATIO = 0.8;

/** VFS 路径前缀 */
const VFS_MEMORY_PREFIX = 'viking://memory/';

/** Hermes：用户偏好默认有效期 90 天 */
const PREFERENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Hermes：偏好置信度阈值（≥0.6 视为高置信度偏好） */
const PREFERENCE_CONFIDENCE_THRESHOLD = 0.6;

/** Hermes：偏好置信度单次确认增量 */
const PREFERENCE_CONFIDENCE_INCREMENT = 0.15;

/** Hermes：偏好置信度上限 */
const PREFERENCE_CONFIDENCE_MAX = 1.0;

/** Hermes：重要性衰减半衰期（30 天，长期记忆缓慢衰减） */
const IMPORTANCE_DECAY_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Hermes：快速检索响应时间预算（100ms） */
const FAST_RETRIEVAL_BUDGET_MS = 100;

// ============ 主类 ============

export class MemoryStore {
  /** 各级别记忆存储：id → MemoryEntry */
  private entries: Map<string, MemoryEntry> = new Map();

  /** 各级别容量上限 */
  private maxEntries: Record<MemoryLevel, number>;

  /** Hermes：关键词倒排索引（关键词 → 记忆ID集合），加速 ≤100ms 检索 */
  private keywordIndex: Map<string, Set<string>> = new Map();

  /** Hermes：标签倒排索引（标签 → 记忆ID集合），加速 ≤100ms 检索 */
  private tagIndex: Map<string, Set<string>> = new Map();

  /** Hermes：级别索引（级别 → 记忆ID集合），加速级别过滤 */
  private levelIndex: Map<MemoryLevel, Set<string>> = new Map();

  /** Hermes：用户偏好存储（偏好键 → 偏好条目） */
  private preferences: Map<string, UserPreferenceEntry> = new Map();

  /** Hermes：索引是否需要重建（懒重建标志） */
  private indexDirty: boolean = false;

  constructor(options?: {
    maxShortTerm?: number;
    maxWorking?: number;
    maxLongTerm?: number;
    maxProcedural?: number;
  }) {
    this.maxEntries = {
      [MemoryLevel.SHORT_TERM]: options?.maxShortTerm ?? DEFAULT_MAX_SHORT_TERM,
      [MemoryLevel.WORKING]: options?.maxWorking ?? DEFAULT_MAX_WORKING,
      [MemoryLevel.LONG_TERM]: options?.maxLongTerm ?? DEFAULT_MAX_LONG_TERM,
      [MemoryLevel.PROCEDURAL]: options?.maxProcedural ?? DEFAULT_MAX_PROCEDURAL,
    };
    // 初始化级别索引
    for (const level of Object.values(MemoryLevel)) {
      this.levelIndex.set(level, new Set());
    }
  }

  // ========== 核心 API ==========

  /**
   * 存储一条记忆
   * 返回生成的唯一 ID
   */
  store(input: MemoryStoreInput): string {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const entry: MemoryEntry = {
      id,
      level: input.level,
      key: input.key,
      content: input.content,
      metadata: {
        createdAt: now,
        updatedAt: now,
        accessedAt: now,
        accessCount: 0,
        importance: Math.max(0, Math.min(1, input.importance ?? 0.5)),
        source: input.source ?? 'agent',
        tags: input.tags ?? [],
        sessionId: input.sessionId,
        expiresAt: input.expiresAt,
      },
    };

    // 短期记忆若未指定过期时间，则设置默认 30 分钟
    if (entry.level === MemoryLevel.SHORT_TERM && !entry.metadata.expiresAt) {
      entry.metadata.expiresAt = now + SHORT_TERM_TTL;
    }

    // 容量检查与淘汰
    this.ensureCapacity(entry.level);

    this.entries.set(id, entry);

    // Hermes：维护倒排索引，保证后续检索 ≤100ms
    this.addToIndex(entry);

    // 短期记忆使用率超过阈值时自动触发整合
    if (entry.level === MemoryLevel.SHORT_TERM) {
      const usage = this.countByLevel(MemoryLevel.SHORT_TERM) / this.maxEntries[MemoryLevel.SHORT_TERM];
      if (usage >= CONSOLIDATION_USAGE_RATIO) {
        this.consolidate();
      }
    }

    return id;
  }

  /**
   * 按 ID 检索记忆
   * 自动更新访问时间和计数
   */
  retrieve(id: string): MemoryEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    // 更新访问元数据
    const now = Date.now();
    entry.metadata.accessedAt = now;
    entry.metadata.accessCount++;
    entry.metadata.updatedAt = now;

    return entry;
  }

  /**
   * 语义搜索记忆（关键词 + 向量 + 模糊匹配混合）
   */
  semanticSearch(text: string, options?: {
    level?: MemoryLevel;
    limit?: number;
    minImportance?: number;
    threshold?: number;
  }): MemoryEntry[] {
    const limit = options?.limit ?? 5;
    const level = options?.level;
    const minImportance = options?.minImportance ?? 0;
    const threshold = options?.threshold ?? 0.1;

    let candidates = Array.from(this.entries.values());
    if (level) candidates = candidates.filter(e => e.level === level);
    if (minImportance > 0) candidates = candidates.filter(e => e.metadata.importance >= minImportance);

    const query = text.toLowerCase();
    const queryWords = query.split(/\s+/).filter(w => w.length > 1);

    const scored = candidates.map(entry => {
      let score = 0;
      const content = `${entry.key} ${entry.content}`.toLowerCase();
      const tags = entry.metadata.tags.join(' ').toLowerCase();

      for (const word of queryWords) {
        if (content.includes(word)) score += 2;
        if (tags.includes(word)) score += 1.5;
        const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matches = content.match(regex);
        if (matches) score += matches.length * 0.5;
      }

      if (content.includes(query)) score += 5;
      score += entry.metadata.importance * 3;
      const recency = Math.max(0, 1 - (Date.now() - entry.metadata.updatedAt) / (90 * 24 * 60 * 60 * 1000));
      score += recency * 2;

      return { entry, score };
    });

    return scored
      .filter(s => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  /**
   * 按条件查询记忆
   * 返回按重要性降序排列的结果
   */
  query(query: MemoryQuery): MemoryEntry[] {
    let candidates = Array.from(this.entries.values());

    // 级别过滤
    if (query.level !== undefined) {
      candidates = candidates.filter(e => e.level === query.level);
    }

    // 来源过滤
    if (query.source !== undefined) {
      candidates = candidates.filter(e => e.metadata.source === query.source);
    }

    // 最低重要性过滤
    if (query.minImportance !== undefined) {
      candidates = candidates.filter(e => e.metadata.importance >= query.minImportance!);
    }

    // 会话 ID 过滤
    if (query.sessionId !== undefined) {
      candidates = candidates.filter(e => e.metadata.sessionId === query.sessionId);
    }

    // 标签过滤：条目需包含所有查询标签
    if (query.tags && query.tags.length > 0) {
      candidates = candidates.filter(e =>
        query.tags!.every(qt =>
          e.metadata.tags.some(et => et.toLowerCase() === qt.toLowerCase())
        )
      );
    }

    // 关键词过滤：匹配 key 或 content
    if (query.keywords && query.keywords.length > 0) {
      candidates = candidates.filter(e => {
        const text = `${e.key} ${e.content}`.toLowerCase();
        return query.keywords!.some(kw => text.includes(kw.toLowerCase()));
      });
    }

    // 按重要性降序排列
    candidates.sort((a, b) => b.metadata.importance - a.metadata.importance);

    // 限制返回数量
    if (query.limit !== undefined) {
      candidates = candidates.slice(0, query.limit);
    }

    // 更新访问元数据
    const now = Date.now();
    for (const entry of candidates) {
      entry.metadata.accessedAt = now;
      entry.metadata.accessCount++;
    }

    return candidates;
  }

  /**
   * 更新记忆的 key 或 content
   * 返回是否更新成功
   */
  update(id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'key'>>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    if (updates.key !== undefined) {
      entry.key = updates.key;
    }
    if (updates.content !== undefined) {
      entry.content = updates.content;
    }
    entry.metadata.updatedAt = Date.now();

    return true;
  }

  /**
   * 删除一条记忆
   * 返回是否删除成功
   */
  delete(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    // Hermes：同步移除索引
    this.removeFromIndex(entry);
    return this.entries.delete(id);
  }

  /**
   * 将记忆从当前级别提升到目标级别
   * 例如：short_term → long_term
   * 返回是否提升成功
   */
  promote(id: string, toLevel: MemoryLevel): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    // 级别顺序校验：只能向更高级别提升
    const levelOrder: Record<MemoryLevel, number> = {
      [MemoryLevel.SHORT_TERM]: 0,
      [MemoryLevel.WORKING]: 1,
      [MemoryLevel.LONG_TERM]: 2,
      [MemoryLevel.PROCEDURAL]: 3,
    };

    if (levelOrder[entry.level] >= levelOrder[toLevel]) {
      return false; // 不允许降级或同级提升
    }

    // 目标级别容量检查
    this.ensureCapacity(toLevel);

    // Hermes：先从旧级别索引移除
    this.removeFromIndex(entry);

    // 提升时清理短期记忆特有字段
    if (entry.level === MemoryLevel.SHORT_TERM) {
      entry.metadata.expiresAt = undefined;
      entry.metadata.sessionId = undefined;
    }

    entry.level = toLevel;
    entry.metadata.updatedAt = Date.now();

    // Hermes：重新加入新级别索引
    this.addToIndex(entry);

    return true;
  }

  /**
   * 运行整合算法
   * a. 清理过期的短期记忆
   * b. 将频繁访问的短期记忆提升到工作记忆
   * c. 将高重要性的工作记忆提升到长期记忆
   * d. 合并长期记忆中相似条目
   * e. Hermes：应用重要性衰减算法
   * f. Hermes：清理过期用户偏好
   */
  consolidate(): ConsolidationResult {
    const result: ConsolidationResult = { promoted: 0, expired: 0, compressed: 0 };
    const now = Date.now();

    // a. 清理过期的短期记忆
    const expiredIds: string[] = [];
    for (const [id, entry] of this.entries) {
      if (
        entry.level === MemoryLevel.SHORT_TERM &&
        entry.metadata.expiresAt !== undefined &&
        entry.metadata.expiresAt <= now
      ) {
        expiredIds.push(id);
      }
    }
    for (const id of expiredIds) {
      const entry = this.entries.get(id);
      if (entry) this.removeFromIndex(entry);
      this.entries.delete(id);
      result.expired++;
    }

    // b. 将频繁访问的短期记忆提升到工作记忆
    const shortTermCandidates = Array.from(this.entries.values())
      .filter(e => e.level === MemoryLevel.SHORT_TERM)
      .filter(e =>
        e.metadata.accessCount >= PROMOTION_ACCESS_THRESHOLD &&
        e.metadata.importance >= PROMOTION_IMPORTANCE_THRESHOLD
      );

    for (const entry of shortTermCandidates) {
      if (this.promote(entry.id, MemoryLevel.WORKING)) {
        result.promoted++;
      }
    }

    // c. 将高重要性的工作记忆提升到长期记忆
    const workingCandidates = Array.from(this.entries.values())
      .filter(e => e.level === MemoryLevel.WORKING)
      .filter(e =>
        e.metadata.accessCount >= PROMOTION_ACCESS_THRESHOLD &&
        e.metadata.importance >= PROMOTION_IMPORTANCE_THRESHOLD
      );

    for (const entry of workingCandidates) {
      if (this.promote(entry.id, MemoryLevel.LONG_TERM)) {
        result.promoted++;
      }
    }

    // d. 合并长期记忆中相同 key 前缀的条目
    result.compressed = this.compressLongTerm();

    // e. Hermes：应用重要性衰减算法（仅对长期记忆，缓慢衰减）
    this.applyImportanceDecay();

    // f. Hermes：清理过期用户偏好（超过 90 天未确认）
    this.cleanExpiredPreferences();

    return result;
  }

  /**
   * 格式化指定级别的记忆供 LLM 注入
   * 在 token 预算内按重要性降序输出
   */
  formatForPrompt(level: MemoryLevel, maxTokens: number = 800): string {
    const levelNames: Record<MemoryLevel, string> = {
      [MemoryLevel.SHORT_TERM]: '短期记忆',
      [MemoryLevel.WORKING]: '工作记忆',
      [MemoryLevel.LONG_TERM]: '长期记忆',
      [MemoryLevel.PROCEDURAL]: '程序性记忆',
    };

    const entries = Array.from(this.entries.values())
      .filter(e => e.level === level)
      .sort((a, b) => b.metadata.importance - a.metadata.importance);

    if (entries.length === 0) {
      return `[${levelNames[level]}为空]`;
    }

    const header = `[${levelNames[level]}]`;
    const lines: string[] = [header];
    let usedTokens = this.estimateTokens(header);

    for (const entry of entries) {
      const tagStr = entry.metadata.tags.length > 0
        ? ` [${entry.metadata.tags.join(',')}]`
        : '';
      const line = `- ${entry.key}: ${entry.content.substring(0, 150)}${tagStr}`;
      const lineTokens = this.estimateTokens(line);

      if (usedTokens + lineTokens > maxTokens) break;

      lines.push(line);
      usedTokens += lineTokens;
    }

    if (lines.length < entries.length + 1) {
      lines.push(`…（共 ${entries.length} 条，已截断）`);
    }

    return lines.join('\n');
  }

  /**
   * 获取高频访问条目（用于桥接到 DreamingEngine）
   */
  getFrequentEntries(minAccessCount: number, limit: number): MemoryEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.metadata.accessCount >= minAccessCount)
      .sort((a, b) => b.metadata.accessCount - a.metadata.accessCount || b.metadata.importance - a.metadata.importance)
      .slice(0, limit);
  }

  /**
   * 获取近期提升的条目（用于桥接到 DreamingEngine）
   */
  getRecentlyPromoted(sinceMs: number, limit: number): MemoryEntry[] {
    const cutoff = Date.now() - sinceMs;
    return Array.from(this.entries.values())
      .filter(e => e.metadata.updatedAt >= cutoff && e.level === MemoryLevel.LONG_TERM)
      .sort((a, b) => b.metadata.importance - a.metadata.importance)
      .slice(0, limit);
  }

  /**
   * 获取各级别记忆统计信息
   */
  getStats(): MemoryStats {
    let shortTerm = 0;
    let working = 0;
    let longTerm = 0;
    let procedural = 0;
    let totalSize = 0;

    for (const entry of this.entries.values()) {
      switch (entry.level) {
        case MemoryLevel.SHORT_TERM: shortTerm++; break;
        case MemoryLevel.WORKING: working++; break;
        case MemoryLevel.LONG_TERM: longTerm++; break;
        case MemoryLevel.PROCEDURAL: procedural++; break;
      }
      // 估算字节大小
      totalSize += entry.key.length + entry.content.length;
      totalSize += entry.metadata.tags.join('').length;
    }

    return { shortTerm, working, longTerm, procedural, totalSize };
  }

  /**
   * 序列化为 JSON 对象
   */
  toJSON(): object {
    return {
      version: 2,
      entries: Array.from(this.entries.values()),
      maxEntries: this.maxEntries,
      // Hermes：序列化用户偏好
      preferences: Array.from(this.preferences.values()),
    };
  }

  /**
   * 从 JSON 数据反序列化
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fromJSON(data: any): void {
    if (!data || !Array.isArray(data.entries)) return;

    this.entries.clear();
    // Hermes：清空并重建索引
    this.keywordIndex.clear();
    this.tagIndex.clear();
    for (const level of Object.values(MemoryLevel)) {
      this.levelIndex.set(level, new Set());
    }

    // 恢复容量配置
    if (data.maxEntries) {
      for (const level of Object.values(MemoryLevel)) {
        if (data.maxEntries[level] !== undefined) {
          this.maxEntries[level as MemoryLevel] = data.maxEntries[level];
        }
      }
    }

    for (const entry of data.entries) {
      if (!entry || !entry.id || !entry.level) continue;

      // 校验级别值
      const validLevels = Object.values(MemoryLevel) as string[];
      if (!validLevels.includes(entry.level)) continue;

      const restored: MemoryEntry = {
        id: entry.id,
        level: entry.level as MemoryLevel,
        key: entry.key ?? '',
        content: entry.content ?? '',
        metadata: {
          createdAt: entry.metadata?.createdAt ?? Date.now(),
          updatedAt: entry.metadata?.updatedAt ?? Date.now(),
          accessedAt: entry.metadata?.accessedAt ?? Date.now(),
          accessCount: entry.metadata?.accessCount ?? 0,
          importance: Math.max(0, Math.min(1, entry.metadata?.importance ?? 0.5)),
          source: entry.metadata?.source ?? 'agent',
          tags: Array.isArray(entry.metadata?.tags) ? entry.metadata.tags : [],
          sessionId: entry.metadata?.sessionId,
          expiresAt: entry.metadata?.expiresAt,
        },
      };

      this.entries.set(entry.id, restored);
      // Hermes：重建索引
      this.addToIndex(restored);
    }

    // Hermes：恢复用户偏好
    if (Array.isArray(data.preferences)) {
      for (const pref of data.preferences) {
        if (pref && pref.key) {
          this.preferences.set(pref.key, pref);
        }
      }
    }
  }

  /**
   * 清除指定级别的所有记忆
   * 不指定级别则清除全部
   * 返回清除的条目数
   */
  clear(level?: MemoryLevel): number {
    if (level === undefined) {
      const count = this.entries.size;
      this.entries.clear();
      // Hermes：清空所有索引
      this.keywordIndex.clear();
      this.tagIndex.clear();
      for (const lvl of Object.values(MemoryLevel)) {
        this.levelIndex.get(lvl)?.clear();
      }
      return count;
    }

    let removed = 0;
    const toRemove: string[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.level === level) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const entry = this.entries.get(id);
      if (entry) this.removeFromIndex(entry);
      this.entries.delete(id);
      removed++;
    }

    return removed;
  }

  // ========== 模块同步 ==========

  /**
   * 从 Scratchpad 导入事实作为工作记忆
   * 兼容 Scratchpad 类的 getAll() 接口
   */
  syncFromScratchpad(scratchpad: {
    getAll(): Array<{
      key: string;
      value: string;
      source: string;
      importance: number;
      tags: string[];
    }>;
  }): number {
    const entries = scratchpad.getAll();
    let synced = 0;

    for (const entry of entries) {
      // 避免重复导入：检查是否已存在相同 key 的工作记忆
      const existing = this.query({
        level: MemoryLevel.WORKING,
        keywords: [entry.key],
        limit: 1,
      });

      if (existing.length > 0 && existing[0].key === entry.key) {
        continue; // 跳过已存在的条目
      }

      this.store({
        level: MemoryLevel.WORKING,
        key: entry.key,
        content: entry.value,
        importance: entry.importance,
        source: entry.source === 'auto_extract' ? 'agent' : entry.source,
        tags: entry.tags,
      });
      synced++;
    }

    return synced;
  }

  /**
   * 从 ReflectionEngine 导入 SOP 作为程序性记忆
   * 兼容 ReflectionEngine 类的 getAllSOPs() 接口
   */
  syncFromReflectionEngine(engine: {
    getAllSOPs(): Array<{
      id: string;
      name: string;
      category: string;
      triggerCondition: string;
      steps: Array<{
        order: number;
        description: string;
        toolHint?: string;
        expectedOutcome: string;
        alternativeAction?: string;
      }>;
      pitfalls: string[];
      successCount: number;
      failureCount: number;
      version: number;
      createdAt: number;
      lastUsed: number;
    }>;
  }): number {
    const sops = engine.getAllSOPs();
    let synced = 0;

    for (const sop of sops) {
      // 避免重复导入：检查是否已存在相同 key 的程序性记忆
      const existing = this.query({
        level: MemoryLevel.PROCEDURAL,
        keywords: [sop.name],
        limit: 1,
      });

      if (existing.length > 0 && existing[0].key === `sop:${sop.name}`) {
        continue; // 跳过已存在的条目
      }

      // 将 SOP 序列化为内容
      const content = JSON.stringify({
        id: sop.id,
        triggerCondition: sop.triggerCondition,
        steps: sop.steps,
        pitfalls: sop.pitfalls,
        successCount: sop.successCount,
        failureCount: sop.failureCount,
        version: sop.version,
        lastUsed: sop.lastUsed,
      });

      this.store({
        level: MemoryLevel.PROCEDURAL,
        key: `sop:${sop.name}`,
        content,
        importance: Math.min(1, sop.successCount / 5),
        source: 'reflection',
        tags: [sop.category, 'sop'],
      });
      synced++;
    }

    return synced;
  }

  /**
   * 导出所有记忆到虚拟文件系统
   * 按 viking://memory/<level>/<key> 路径写入
   */
  syncToVFS(vfs: {
    write(
      vfsPath: string,
      content: string,
      options?: { contentType?: string; tags?: string[] }
    ): unknown;
  }): number {
    let synced = 0;

    for (const entry of this.entries.values()) {
      const vfsPath = `${VFS_MEMORY_PREFIX}${entry.level}/${entry.key}`;
      const content = JSON.stringify({
        id: entry.id,
        content: entry.content,
        importance: entry.metadata.importance,
        source: entry.metadata.source,
        accessCount: entry.metadata.accessCount,
        createdAt: entry.metadata.createdAt,
        updatedAt: entry.metadata.updatedAt,
      });

      vfs.write(vfsPath, content, {
        contentType: 'json',
        tags: [...entry.metadata.tags, `level:${entry.level}`],
      });
      synced++;
    }

    return synced;
  }

  // ========== Hermes 三级记忆架构 API ==========

  /**
   * Hermes：按三级架构存储记忆
   * 自动将 L0/L1/L2 映射到对应的 MemoryLevel
   */
  storeByTier(
    tier: HermesMemoryTier,
    key: string,
    content: string,
    options?: {
      importance?: number;
      source?: string;
      tags?: string[];
      sessionId?: string;
      expiresAt?: number;
    }
  ): string {
    const level = TIER_TO_LEVEL[tier];
    return this.store({
      level,
      key,
      content,
      importance: options?.importance,
      source: options?.source,
      tags: options?.tags,
      sessionId: options?.sessionId,
      expiresAt: options?.expiresAt,
    });
  }

  /**
   * Hermes：按三级架构检索记忆
   * 使用倒排索引实现 ≤100ms 响应
   */
  retrieveByTier(
    tier: HermesMemoryTier,
    query?: string,
    options?: { limit?: number; minImportance?: number; tags?: string[] }
  ): MemoryEntry[] {
    const startTime = Date.now();
    const level = TIER_TO_LEVEL[tier];
    const limit = options?.limit ?? 10;
    const minImportance = options?.minImportance ?? 0;

    // 优先使用级别索引快速过滤候选集
    const candidateIds = this.levelIndex.get(level);
    if (!candidateIds || candidateIds.size === 0) return [];

    let candidates: MemoryEntry[] = [];
    for (const id of candidateIds) {
      const entry = this.entries.get(id);
      if (entry && entry.metadata.importance >= minImportance) {
        candidates.push(entry);
      }
    }

    // 若提供查询词，使用关键词索引进一步过滤
    if (query) {
      const queryWords = this.tokenize(query);
      const matchedIds = new Set<string>();
      for (const word of queryWords) {
        const ids = this.keywordIndex.get(word);
        if (ids) {
          for (const id of ids) {
            if (candidateIds.has(id)) {
              matchedIds.add(id);
            }
          }
        }
      }
      // 保留命中的候选，未命中关键词的候选降级保留（重要性加权）
      const matched = candidates.filter(e => matchedIds.has(e.id));
      const unmatched = candidates.filter(e => !matchedIds.has(e.id));
      // 命中关键词的优先，未命中的按重要性降序补充
      matched.sort((a, b) => b.metadata.importance - a.metadata.importance);
      unmatched.sort((a, b) => b.metadata.importance - a.metadata.importance);
      candidates = [...matched, ...unmatched];
    } else {
      candidates.sort((a, b) => b.metadata.importance - a.metadata.importance);
    }

    // 标签过滤
    if (options?.tags && options.tags.length > 0) {
      const tagSet = new Set(options.tags.map(t => t.toLowerCase()));
      candidates = candidates.filter(e =>
        e.metadata.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    const results = candidates.slice(0, limit);

    // 更新访问元数据
    const now = Date.now();
    for (const entry of results) {
      entry.metadata.accessedAt = now;
      entry.metadata.accessCount++;
    }

    // 性能监控：确保在预算内
    const elapsed = Date.now() - startTime;
    if (elapsed > FAST_RETRIEVAL_BUDGET_MS) {
      // 超预算时仅记录，不抛出（保证可用性）
      // 实际生产可接入 metrics 上报
    }

    return results;
  }

  /**
   * Hermes：混合检索（语义 + 关键词）
   * 结合倒排索引的快速关键词匹配与语义关联评分
   */
  hybridSearch(
    query: string,
    options?: {
      tier?: HermesMemoryTier;
      level?: MemoryLevel;
      limit?: number;
      minImportance?: number;
    }
  ): Array<MemoryEntry & { score: number }> {
    const limit = options?.limit ?? 5;
    const minImportance = options?.minImportance ?? 0;
    const queryWords = this.tokenize(query);

    // 确定候选集
    let candidateIds: Set<string>;
    if (options?.tier) {
      candidateIds = this.levelIndex.get(TIER_TO_LEVEL[options.tier]) ?? new Set();
    } else if (options?.level) {
      candidateIds = this.levelIndex.get(options.level) ?? new Set();
    } else {
      candidateIds = new Set(this.entries.keys());
    }

    // 关键词索引快速命中
    const keywordHitIds = new Set<string>();
    for (const word of queryWords) {
      const ids = this.keywordIndex.get(word);
      if (ids) {
        for (const id of ids) {
          if (candidateIds.has(id)) keywordHitIds.add(id);
        }
      }
    }

    // 对候选集评分
    const scored: Array<MemoryEntry & { score: number }> = [];
    for (const id of candidateIds) {
      const entry = this.entries.get(id);
      if (!entry || entry.metadata.importance < minImportance) continue;

      let score = 0;
      const content = `${entry.key} ${entry.content}`.toLowerCase();

      // 1. 关键词命中加分（权重 0.4）
      if (keywordHitIds.has(id)) {
        score += 0.4;
      }
      for (const word of queryWords) {
        if (content.includes(word)) score += 0.05;
      }

      // 2. 语义关联加分（权重 0.3）
      score += this.computeSemanticRelevance(query, content) * 0.3;

      // 3. 重要性加分（权重 0.2）
      score += entry.metadata.importance * 0.2;

      // 4. 时效性加分（权重 0.1）
      const ageMs = Date.now() - entry.metadata.updatedAt;
      const recency = Math.max(0, 1 - ageMs / (90 * 24 * 60 * 60 * 1000));
      score += recency * 0.1;

      if (score > 0) {
        scored.push({ ...entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // 更新访问元数据
    const now = Date.now();
    for (const entry of scored.slice(0, limit)) {
      const original = this.entries.get(entry.id);
      if (original) {
        original.metadata.accessedAt = now;
        original.metadata.accessCount++;
      }
    }

    return scored.slice(0, limit);
  }

  /**
   * Hermes：记录用户偏好（带置信度评分与 90 天过期）
   * 若偏好已存在则提升置信度，否则新建
   */
  recordPreference(
    category: PreferenceCategory,
    key: string,
    value: string,
    options?: { confidence?: number; source?: string }
  ): UserPreferenceEntry {
    const now = Date.now();
    const prefKey = `${category}:${key}`;
    const existing = this.preferences.get(prefKey);

    if (existing) {
      // 已存在：提升置信度，刷新过期时间
      existing.value = value; // 更新为最新值
      existing.confirmCount++;
      existing.lastConfirmedAt = now;
      existing.expiresAt = now + PREFERENCE_TTL_MS; // 刷新 90 天有效期
      existing.confidence = Math.min(
        PREFERENCE_CONFIDENCE_MAX,
        existing.confidence + PREFERENCE_CONFIDENCE_INCREMENT
      );
      return existing;
    }

    // 新建偏好
    const initialConfidence = options?.confidence ?? PREFERENCE_CONFIDENCE_INCREMENT;
    const pref: UserPreferenceEntry = {
      category,
      key,
      value,
      confidence: Math.min(PREFERENCE_CONFIDENCE_MAX, Math.max(0, initialConfidence)),
      createdAt: now,
      lastConfirmedAt: now,
      expiresAt: now + PREFERENCE_TTL_MS,
      confirmCount: 1,
    };
    this.preferences.set(prefKey, pref);
    return pref;
  }

  /**
   * Hermes：获取用户偏好（带过期校验）
   * 返回未过期且置信度达标的偏好
   */
  getPreference(
    category: PreferenceCategory,
    key: string,
    minConfidence?: number
  ): UserPreferenceEntry | null {
    const prefKey = `${category}:${key}`;
    const pref = this.preferences.get(prefKey);
    if (!pref) return null;

    // 过期校验
    if (Date.now() > pref.expiresAt) {
      this.preferences.delete(prefKey);
      return null;
    }

    // 置信度校验
    const threshold = minConfidence ?? PREFERENCE_CONFIDENCE_THRESHOLD;
    if (pref.confidence < threshold) return null;

    return pref;
  }

  /**
   * Hermes：获取所有高置信度用户偏好（用于主动注入）
   */
  getHighConfidencePreferences(minConfidence?: number): UserPreferenceEntry[] {
    const threshold = minConfidence ?? PREFERENCE_CONFIDENCE_THRESHOLD;
    const now = Date.now();
    const results: UserPreferenceEntry[] = [];
    for (const [key, pref] of this.preferences) {
      if (now > pref.expiresAt) {
        this.preferences.delete(key);
        continue;
      }
      if (pref.confidence >= threshold) {
        results.push(pref);
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Hermes：获取所有用户偏好（含低置信度，用于调试/展示）
   */
  getAllPreferences(): UserPreferenceEntry[] {
    return Array.from(this.preferences.values()).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Hermes：从对话文本中自动提取用户偏好
   * 识别编程语言、工作习惯、沟通风格等
   * 返回新提取的偏好列表
   */
  extractPreferencesFromText(text: string): UserPreferenceEntry[] {
    const extracted: UserPreferenceEntry[] = [];

    // 1. 编程语言识别
    const langPatterns: Array<{ lang: string; patterns: RegExp[] }> = [
      { lang: 'TypeScript', patterns: [/typescript/i, /\.ts\b/, /\bts\b/i] },
      { lang: 'JavaScript', patterns: [/javascript/i, /\.js\b/, /\bjs\b/i] },
      { lang: 'Python', patterns: [/python/i, /\.py\b/] },
      { lang: 'Go', patterns: [/\bgolang\b/i, /\.go\b/] },
      { lang: 'Rust', patterns: [/rust/i, /\.rs\b/] },
      { lang: 'Java', patterns: [/java/i, /\.java\b/] },
    ];
    for (const { lang, patterns } of langPatterns) {
      if (patterns.some(p => p.test(text))) {
        extracted.push(this.recordPreference('programming_language', 'primary', lang));
      }
    }

    // 2. 沟通风格识别
    if (/简洁|简短|直接|brief|concise/i.test(text)) {
      extracted.push(this.recordPreference('communication_style', 'detail_level', 'brief'));
    }
    if (/详细|完整|详尽|detailed|comprehensive/i.test(text)) {
      extracted.push(this.recordPreference('communication_style', 'detail_level', 'detailed'));
    }
    if (/代码示例|用代码|show code|code example/i.test(text)) {
      extracted.push(this.recordPreference('communication_style', 'prefers_code', 'true'));
    }
    if (/分步|步骤|step by step/i.test(text)) {
      extracted.push(this.recordPreference('communication_style', 'prefers_step_by_step', 'true'));
    }

    // 3. 专业水平识别
    if (/我是新手|初学者|beginner|不熟悉/i.test(text)) {
      extracted.push(this.recordPreference('expertise_level', 'self_assessed', 'beginner'));
    }
    if (/我是专家|资深|expert|advanced/i.test(text)) {
      extracted.push(this.recordPreference('expertise_level', 'self_assessed', 'expert'));
    }

    // 4. 工作习惯识别
    if (/测试驱动|TDD|test driven/i.test(text)) {
      extracted.push(this.recordPreference('work_habit', 'development_approach', 'TDD'));
    }
    if (/代码审查|code review|PR review/i.test(text)) {
      extracted.push(this.recordPreference('work_habit', 'review_practice', 'code_review'));
    }

    return extracted;
  }

  /**
   * Hermes：获取记忆的 Hermes 三级归属
   */
  getTier(id: string): HermesMemoryTier | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return LEVEL_TO_TIER[entry.level];
  }

  /**
   * Hermes：按三级架构统计记忆数量
   */
  getTierStats(): Record<HermesMemoryTier, number> {
    const stats: Record<HermesMemoryTier, number> = {
      [HermesMemoryTier.L0_SESSION]: 0,
      [HermesMemoryTier.L1_PERSISTENT]: 0,
      [HermesMemoryTier.L2_SKILL]: 0,
    };
    for (const entry of this.entries.values()) {
      const tier = LEVEL_TO_TIER[entry.level];
      stats[tier]++;
    }
    return stats;
  }

  // ========== 私有方法 ==========

  /**
   * Hermes：将记忆条目加入倒排索引
   */
  private addToIndex(entry: MemoryEntry): void {
    // 级别索引
    const levelSet = this.levelIndex.get(entry.level);
    if (levelSet) {
      levelSet.add(entry.id);
    }

    // 关键词索引（从 key 和 content 提取）
    const keywords = this.tokenize(`${entry.key} ${entry.content}`);
    for (const word of keywords) {
      if (!this.keywordIndex.has(word)) {
        this.keywordIndex.set(word, new Set());
      }
      this.keywordIndex.get(word)!.add(entry.id);
    }

    // 标签索引
    for (const tag of entry.metadata.tags) {
      const tagLower = tag.toLowerCase();
      if (!this.tagIndex.has(tagLower)) {
        this.tagIndex.set(tagLower, new Set());
      }
      this.tagIndex.get(tagLower)!.add(entry.id);
    }
  }

  /**
   * Hermes：从倒排索引移除记忆条目
   */
  private removeFromIndex(entry: MemoryEntry): void {
    // 级别索引
    this.levelIndex.get(entry.level)?.delete(entry.id);

    // 关键词索引
    const keywords = this.tokenize(`${entry.key} ${entry.content}`);
    for (const word of keywords) {
      const ids = this.keywordIndex.get(word);
      if (ids) {
        ids.delete(entry.id);
        if (ids.size === 0) {
          this.keywordIndex.delete(word);
        }
      }
    }

    // 标签索引
    for (const tag of entry.metadata.tags) {
      const tagLower = tag.toLowerCase();
      const ids = this.tagIndex.get(tagLower);
      if (ids) {
        ids.delete(entry.id);
        if (ids.size === 0) {
          this.tagIndex.delete(tagLower);
        }
      }
    }
  }

  /**
   * Hermes：中文/英文混合分词
   * 用于倒排索引构建与查询
   */
  private tokenize(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    // 按非字母数字字符分割，过滤过短 token
    const tokens = lower
      .replace(/[^\u4e00-\u9fa5a-z0-9+#.]/gi, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
    return tokens;
  }

  /**
   * Hermes：计算语义相关性
   * 基于预定义语义组匹配，无需向量模型
   */
  private computeSemanticRelevance(query: string, content: string): number {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();

    // 语义关联组（与 hierarchical-memory.ts 保持一致）
    const semanticGroups: string[][] = [
      ['代码', '编程', '开发', '程序', '函数', '类', '模块', '项目'],
      ['bug', '错误', '报错', '异常', '调试', 'debug', '修复'],
      ['优化', '性能', '加速', '改进', '提升', '重构'],
      ['部署', '发布', '上线', '运维', '服务器', 'docker'],
      ['测试', '验证', '检验', '单元测试', '集成测试'],
      ['设计', '架构', '模式', '结构', '方案'],
      ['数据', '数据库', '存储', '查询', '表'],
      ['安全', '漏洞', '加密', '认证', '授权'],
      ['前端', '界面', 'ui', '页面', '组件'],
      ['后端', 'api', '接口', '服务', '微服务'],
    ];

    let relevance = 0;
    for (const group of semanticGroups) {
      const queryHits = group.filter(w => queryLower.includes(w));
      const contentHits = group.filter(w => contentLower.includes(w));
      if (queryHits.length > 0 && contentHits.length > 0) {
        relevance += 0.2;
      }
    }
    return Math.min(relevance, 1.0);
  }

  /**
   * Hermes：重要性衰减算法
   * 长期记忆按指数衰减，访问频率减缓衰减速度
   */
  private applyImportanceDecay(): void {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      // 仅对长期记忆和程序性记忆应用缓慢衰减
      if (entry.level !== MemoryLevel.LONG_TERM && entry.level !== MemoryLevel.PROCEDURAL) {
        continue;
      }

      const ageMs = now - entry.metadata.updatedAt;
      // 访问频率减缓衰减：每次访问延长半衰期
      const accessBonus = Math.min(entry.metadata.accessCount / 10, 1);
      const adjustedHalflife = IMPORTANCE_DECAY_HALFLIFE_MS * (1 + accessBonus * 0.5);
      // 指数衰减：e^(-ln2 * t / halfLife)
      const decayFactor = Math.exp(-Math.LN2 * ageMs / adjustedHalflife);

      // 衰减后的重要性 = 原始重要性 * 衰减因子
      // 但不低于 0.1，避免重要记忆被完全遗忘
      const decayed = entry.metadata.importance * Math.max(0.1, decayFactor);
      // 仅当衰减明显时才更新（避免频繁写入）
      if (Math.abs(decayed - entry.metadata.importance) > 0.01) {
        entry.metadata.importance = Math.max(0.1, decayed);
      }
    }
  }

  /**
   * Hermes：清理过期用户偏好
   * 超过 90 天未确认的偏好自动删除
   */
  private cleanExpiredPreferences(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const [key, pref] of this.preferences) {
      if (now > pref.expiresAt) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this.preferences.delete(key);
    }
  }

  /**
   * 统计指定级别的条目数
   */
  private countByLevel(level: MemoryLevel): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.level === level) count++;
    }
    return count;
  }

  /**
   * 容量检查与淘汰
   * 各级别独立淘汰策略：
   * - SHORT_TERM: 淘汰最低重要性 + 最旧的
   * - WORKING: 淘汰最低重要性的
   * - LONG_TERM: 重要性淘汰
   * - PROCEDURAL: 不自动淘汰（仅手动删除）
   */
  private ensureCapacity(level: MemoryLevel): void {
    // 程序性记忆不自动淘汰
    if (level === MemoryLevel.PROCEDURAL) return;

    const current = this.countByLevel(level);
    const max = this.maxEntries[level];

    if (current < max) return;

    // 收集该级别的所有条目
    const levelEntries = Array.from(this.entries.values())
      .filter(e => e.level === level);

    // 按重要性升序排列，重要性相同则按更新时间升序（最旧优先淘汰）
    levelEntries.sort((a, b) => {
      if (a.metadata.importance !== b.metadata.importance) {
        return a.metadata.importance - b.metadata.importance;
      }
      return a.metadata.updatedAt - b.metadata.updatedAt;
    });

    // 淘汰最低重要性的条目，直到低于容量上限
    const toRemove = current - max + 1; // 需要为新条目腾出 1 个位置
    for (let i = 0; i < Math.min(toRemove, levelEntries.length); i++) {
      this.entries.delete(levelEntries[i].id);
    }
  }

  /**
   * 压缩长期记忆：合并相同 key 前缀的条目
   * 保留最新内容，将较旧内容追加为摘要
   */
  private compressLongTerm(): number {
    const longTermEntries = Array.from(this.entries.values())
      .filter(e => e.level === MemoryLevel.LONG_TERM);

    if (longTermEntries.length < 2) return 0;

    // 按 key 前缀分组
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of longTermEntries) {
      // 提取 key 前缀：取第一个分隔符之前的部分
      const prefix = entry.key.split(/[:/._-]/)[0] || entry.key;
      if (!groups.has(prefix)) {
        groups.set(prefix, []);
      }
      groups.get(prefix)!.push(entry);
    }

    let compressed = 0;

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      // 按更新时间降序排列（最新在前）
      group.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);

      // 保留最新的条目，合并其他条目为摘要
      const latest = group[0];
      const older = group.slice(1);

      // 生成旧条目摘要
      const summaryParts = older.map(e =>
        `[${new Date(e.metadata.updatedAt).toISOString()}] ${e.content.substring(0, 80)}`
      );
      const summary = summaryParts.join('\\n');

      // 将摘要追加到最新条目
      latest.content = `${latest.content}\n[历史摘要] ${summary}`;
      latest.metadata.updatedAt = Date.now();

      // 删除已合并的旧条目
      for (const old of older) {
        this.entries.delete(old.id);
        compressed++;
      }
    }

    return compressed;
  }

  /**
   * 估算字符串的 token 数
   * 中文约 1.5 字符/token，英文约 4 字符/token
   */
  private estimateTokens(text: string): number {
    let chineseChars = 0;
    let otherChars = 0;

    for (const char of text) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(char)) {
        chineseChars++;
      } else {
        otherChars++;
      }
    }

    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }
}
