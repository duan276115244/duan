/**
 * 分层记忆架构
 * 工作记忆 + 情景记忆 + 语义记忆 + 程序记忆
 *
 * Hermes 三级记忆架构映射：
 * - L0 会话级（短期）：工作记忆 + 情景记忆（当前对话上下文）
 * - L1 持久级（中期）：语义记忆（用户偏好/项目知识，90天有效期）
 * - L2 技能级（长期）：程序记忆（可复用 SOP，不自动过期）
 */

import { tokenize, extractKeywords, textSimilarity } from './chinese-tokenizer.js';

/** Hermes 三级记忆层级 */
export enum HermesTier {
  /** L0 会话级：短期，当前对话上下文 */
  L0_SESSION = 'L0',
  /** L1 持久级：中期，用户偏好/项目知识（90天有效期） */
  L1_PERSISTENT = 'L1',
  /** L2 技能级：长期，可复用 SOP */
  L2_SKILL = 'L2',
}

/** 记忆条目 */
interface MemoryEntry {
  id: string;
  content: string;
  type: 'working' | 'episodic' | 'semantic' | 'procedural';
  importance: number; // 0-1
  accessCount: number;
  createdAt: number;
  accessedAt: number;
  expiresAt?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>;
}

/** Hermes：用户偏好条目（带置信度与 90 天过期） */
export interface HermesPreference {
  /** 偏好键 */
  key: string;
  /** 偏好值 */
  value: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后确认时间 */
  lastConfirmedAt: number;
  /** 过期时间（默认 90 天） */
  expiresAt: number;
  /** 确认次数 */
  confirmCount: number;
}

/** 工作记忆 - 当前会话核心信息 */
interface WorkingMemory {
  currentTopic: string;
  recentEntities: Map<string, string>;
  activeAssumptions: string[];
  pendingQuestions: string[];
  userIntent: string;
  contextWindow: MemoryEntry[];
}

/** 情景记忆 - 会话级上下文 */
interface EpisodicMemory {
  sessionId: string;
  startTime: number;
  topics: string[];
  keyDecisions: string[];
  userFeedback: Array<{ positive: boolean; context: string }>;
  summary: string;
}

/** 语义记忆 - 长期知识 */
interface SemanticMemory {
  concepts: Map<string, string>;
  relationships: Array<{ from: string; relation: string; to: string }>;
  facts: Map<string, { value: string; confidence: number; source: string }>;
}

/** 程序记忆 - 操作习惯 */
interface ProceduralMemory {
  userPreferences: Map<string, string>;
  commonPatterns: Map<string, number>;
  toolUsageStats: Map<string, { count: number; successRate: number }>;
}

/** 上下文压缩结果 */
interface _CompressedContext {
  summary: string;
  keyPoints: string[];
  entities: string[];
  sentiment: string;
  topic: string;
  compressionRatio: number;
}

export class HierarchicalMemory {
  private working: WorkingMemory;
  private episodic: EpisodicMemory[] = [];
  private semantic: SemanticMemory;
  private procedural: ProceduralMemory;
  private maxWorkingSize: number = 20;
  private maxEpisodicSize: number = 100;

  /** 语义索引：关键词 → 记忆ID集合，加速记忆检索 */
  private semanticIndex: Map<string, Set<string>> = new Map();

  /** 记忆衰减半衰期（毫秒）：1小时 */
  private readonly MEMORY_DECAY_HALFLIFE = 3600000;

  /** 工作记忆自动压缩阈值 */
  private readonly WORKING_COMPRESS_THRESHOLD = 15;

  /** 跨会话关联的相似度阈值 */
  private readonly CROSS_SESSION_SIMILARITY_THRESHOLD = 0.3;

  /** Hermes：用户偏好默认有效期 90 天 */
  private readonly PREFERENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  /** Hermes：偏好置信度阈值 */
  private readonly PREFERENCE_CONFIDENCE_THRESHOLD = 0.6;

  /** Hermes：偏好置信度单次确认增量 */
  private readonly PREFERENCE_CONFIDENCE_INCREMENT = 0.15;

  /** Hermes：偏好置信度上限 */
  private readonly PREFERENCE_CONFIDENCE_MAX = 1.0;

  /** Hermes：L1 持久级记忆（语义知识）默认有效期 90 天 */
  private readonly L1_PERSISTENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  /** Hermes：用户偏好存储（偏好键 → 偏好条目） */
  private hermesPreferences: Map<string, HermesPreference> = new Map();

  /** Hermes：L1 快速索引（关键词 → 语义记忆键集合），加速 ≤100ms 检索 */
  private l1KeywordIndex: Map<string, Set<string>> = new Map();

  constructor() {
    this.working = {
      currentTopic: '',
      recentEntities: new Map(),
      activeAssumptions: [],
      pendingQuestions: [],
      userIntent: '',
      contextWindow: [],
    };

    this.semantic = {
      concepts: new Map(),
      relationships: [],
      facts: new Map(),
    };

    this.procedural = {
      userPreferences: new Map(),
      commonPatterns: new Map(),
      toolUsageStats: new Map(),
    };
  }

  /**
   * 添加到工作记忆
   */
  addToWorking(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'createdAt' | 'accessedAt'>): void {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      accessCount: 0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
    };

    this.working.contextWindow.push(fullEntry);

    // 更新语义索引
    this.updateSemanticIndex(fullEntry.id, fullEntry.content);

    // 超出容量时压缩
    if (this.working.contextWindow.length > this.maxWorkingSize) {
      this.compressWorking();
    }

    // 工作记忆自动压缩：当超过阈值时，对低重要性记忆进行摘要压缩
    if (this.working.contextWindow.length > this.WORKING_COMPRESS_THRESHOLD) {
      this.autoCompressWorkingMemory();
    }

    // 更新实体
    if (entry.metadata?.entity) {
      this.working.recentEntities.set(entry.metadata.entity, entry.content);
    }

    // 跨会话记忆关联：检查新内容是否与历史话题相关
    this.associateCrossSessionMemory(entry.content);
  }

  /**
   * 工作记忆自动压缩：当工作记忆超过阈值时，自动摘要压缩低重要性记忆
   */
  private autoCompressWorkingMemory(): void {
    const entries = this.working.contextWindow;
    const now = Date.now();

    // 将低重要性且较旧的记忆进行摘要压缩
    const lowImportance = entries.filter(e =>
      e.importance < 0.5 && (now - e.createdAt) > 300000 // 5分钟前的低重要性记忆
    );

    if (lowImportance.length < 3) return; // 至少3条才压缩

    // 按主题分组压缩
    const grouped = new Map<string, MemoryEntry[]>();
    for (const entry of lowImportance) {
      const topic = entry.metadata?.topic || entry.metadata?.intent || 'general';
      if (!grouped.has(topic)) grouped.set(topic, []);
      grouped.get(topic)!.push(entry);
    }

    // 对每组生成摘要并替换
    for (const [topic, group] of grouped) {
      if (group.length < 2) continue; // 至少2条才压缩

      const summary = group.map(e => e.content).join('；');
      const compressedEntry: MemoryEntry = {
        id: `compressed_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        content: `[压缩] ${summary.substring(0, 200)}${summary.length > 200 ? '...' : ''}`,
        type: 'working',
        importance: Math.max(...group.map(e => e.importance)) * 0.8,
        accessCount: group.reduce((sum, e) => sum + e.accessCount, 0),
        createdAt: Math.min(...group.map(e => e.createdAt)),
        accessedAt: now,
        metadata: { topic, compressed: true, originalCount: group.length },
      };

      // 从工作记忆中移除原始条目
      const removeIds = new Set(group.map(e => e.id));
      this.working.contextWindow = this.working.contextWindow.filter(e => !removeIds.has(e.id));

      // 添加压缩后的条目
      this.working.contextWindow.push(compressedEntry);
    }
  }

  /**
   * 跨会话记忆关联：当新对话涉及历史话题时，自动检索相关记忆
   */
  private associateCrossSessionMemory(content: string): void {
    const contentWords = extractKeywords(content);
    if (contentWords.size === 0) return;

    // 遍历情景记忆，查找与当前内容相关的历史会话
    for (const episodic of this.episodic) {
      // 跳过当前会话（1小时内）
      if (Date.now() - episodic.startTime < 3600000) continue;

      // 计算内容与历史话题的相似度
      const topicWords = extractKeywords(episodic.topics.join(' '));
      const intersection = [...contentWords].filter(w => topicWords.has(w));
      const similarity = intersection.length / Math.max(contentWords.size, 1);

      // 如果相似度超过阈值，将相关记忆提升到工作记忆
      if (similarity >= this.CROSS_SESSION_SIMILARITY_THRESHOLD) {
        const relatedEntry: MemoryEntry = {
          id: `cross_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          content: `[历史相关] ${episodic.summary || episodic.topics.join(', ')}`,
          type: 'working',
          importance: 0.4, // 跨会话关联记忆重要性较低
          accessCount: 0,
          createdAt: episodic.startTime,
          accessedAt: Date.now(),
          metadata: {
            source: 'cross_session',
            sessionId: episodic.sessionId,
            similarity: Math.round(similarity * 100) / 100,
          },
        };

        // 避免重复添加同一会话的关联
        const alreadyLinked = this.working.contextWindow.some(
          e => e.metadata?.sessionId === episodic.sessionId && e.metadata?.source === 'cross_session'
        );
        if (!alreadyLinked) {
          this.working.contextWindow.push(relatedEntry);
        }
      }
    }
  }

  /**
   * 更新工作记忆状态
   */
  updateWorkingState(update: Partial<WorkingMemory>): void {
    Object.assign(this.working, update);
  }

  /**
   * 获取工作记忆
   */
  getWorking(): WorkingMemory {
    return this.working;
  }

  /**
   * 获取当前上下文（用于模型输入）
   */
  getContextForModel(maxTokens: number = 4000): string {
    const entries = this.working.contextWindow;
    let context = '';
    let tokenEstimate = 0;

    // 从最新的开始，倒序填充
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const entryText = `[${entry.type}] ${entry.content}\n`;
      const estimatedTokens = entryText.length / 4; // 粗略估计

      if (tokenEstimate + estimatedTokens > maxTokens) break;

      context = entryText + context;
      tokenEstimate += estimatedTokens;
    }

    return context;
  }

  /**
   * 压缩工作记忆
   */
  private compressWorking(): void {
    const entries = this.working.contextWindow;

    // 按重要性排序，保留重要的
    const scored = entries.map(entry => ({
      entry,
      score: this.computeMemoryScore(entry),
    }));

    scored.sort((a, b) => b.score - a.score);

    // 保留前 maxWorkingSize 条
    const retained = scored.slice(0, this.maxWorkingSize).map(s => s.entry);

    // 将被移除的重要记忆降级到情景记忆
    const removed = scored.slice(this.maxWorkingSize);
    for (const item of removed) {
      if (item.score > 0.5) {
        this.addToEpisodic({
          content: item.entry.content,
          type: 'episodic',
          importance: item.entry.importance,
          metadata: item.entry.metadata,
        });
      }
    }

    this.working.contextWindow = retained;
  }

  /**
   * 计算记忆分数（含衰减机制）
   * 根据时间距离和访问频率调整记忆权重
   */
  private computeMemoryScore(entry: MemoryEntry): number {
    const now = Date.now();
    const ageInMs = now - entry.createdAt;

    // 1. 重要性权重
    const importanceScore = entry.importance;

    // 2. 时效性衰减：使用指数衰减函数，半衰期为 MEMORY_DECAY_HALFLIFE
    // 衰减公式：e^(-ln2 * t / halfLife)
    const decayFactor = Math.exp(-Math.LN2 * ageInMs / this.MEMORY_DECAY_HALFLIFE);
    const _recencyScore = Math.max(0, decayFactor);

    // 3. 访问频率奖励：频繁访问的记忆衰减更慢
    const accessBonus = Math.min(entry.accessCount / 5, 1);
    // 访问频率减缓衰减：每次访问延长半衰期
    const adjustedDecay = Math.exp(-Math.LN2 * ageInMs / (this.MEMORY_DECAY_HALFLIFE * (1 + accessBonus * 0.5)));
    const adjustedRecencyScore = Math.max(0, adjustedDecay);

    // 4. 最近访问时间奖励
    const timeSinceAccess = now - entry.accessedAt;
    const accessRecencyBonus = Math.max(0, 1 - timeSinceAccess / 1800000); // 30分钟内访问过

    // 综合评分：重要性 * 0.4 + 调整后时效性 * 0.3 + 访问频率 * 0.15 + 访问时效 * 0.15
    return importanceScore * 0.4 + adjustedRecencyScore * 0.3 + accessBonus * 0.15 + accessRecencyBonus * 0.15;
  }

  /**
   * 添加到情景记忆
   */
  addToEpisodic(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'createdAt' | 'accessedAt'>): void {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: `epi_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      accessCount: 0,
      createdAt: Date.now(),
      accessedAt: Date.now(),
    };

    // 查找或创建当前会话的情景记忆
    let currentEpisodic = this.episodic.find(e =>
      Date.now() - e.startTime < 3600000 // 1小时内的会话
    );

    if (!currentEpisodic) {
      currentEpisodic = {
        sessionId: `session_${Date.now()}`,
        startTime: Date.now(),
        topics: [],
        keyDecisions: [],
        userFeedback: [],
        summary: '',
      };
      this.episodic.push(currentEpisodic);
    }

    // 将条目内容存入情景记忆（之前遗漏了存储步骤，导致数据丢失）
    currentEpisodic.topics.push(fullEntry.content);

    // 限制情景记忆数量
    if (this.episodic.length > this.maxEpisodicSize) {
      this.episodic = this.episodic.slice(-this.maxEpisodicSize);
    }
  }

  /**
   * 添加到语义记忆
   * Hermes：L1 持久级，默认 90 天有效期
   */
  addToSemantic(concept: string, definition: string, source: string = 'learned'): void {
    this.semantic.concepts.set(concept, definition);
    this.semantic.facts.set(concept, {
      value: definition,
      confidence: 0.8,
      source,
    });
    // Hermes：维护 L1 关键词索引，加速 ≤100ms 检索
    this.updateL1KeywordIndex(concept, definition);
  }

  /**
   * 添加关系到语义记忆
   */
  addRelationship(from: string, relation: string, to: string): void {
    this.semantic.relationships.push({ from, relation, to });
  }

  /**
   * 从语义记忆查询
   * Hermes：L1 持久级快速查询
   */
  querySemantic(concept: string): string | undefined {
    return this.semantic.concepts.get(concept);
  }

  /**
   * Hermes：更新 L1 关键词索引
   * 加速语义记忆的 ≤100ms 检索
   */
  private updateL1KeywordIndex(concept: string, definition: string): void {
    const text = `${concept} ${definition}`;
    const keywords = tokenize(text, { minTokenLength: 2 });

    for (const keyword of keywords) {
      if (!this.l1KeywordIndex.has(keyword)) {
        this.l1KeywordIndex.set(keyword, new Set());
      }
      this.l1KeywordIndex.get(keyword)!.add(concept);
    }
  }

  /**
   * Hermes：L1 持久级快速检索
   * 使用关键词索引实现 ≤100ms 响应
   */
  searchL1Persistent(query: string, limit: number = 5): Array<{ concept: string; definition: string; confidence: number }> {
    const queryWords = tokenize(query, { minTokenLength: 2 });

    const matchedConcepts = new Set<string>();
    for (const word of queryWords) {
      const concepts = this.l1KeywordIndex.get(word);
      if (concepts) {
        for (const concept of concepts) {
          matchedConcepts.add(concept);
        }
      }
    }

    const results: Array<{ concept: string; definition: string; confidence: number }> = [];
    for (const concept of matchedConcepts) {
      const definition = this.semantic.concepts.get(concept);
      const fact = this.semantic.facts.get(concept);
      if (definition && fact) {
        results.push({
          concept,
          definition,
          confidence: fact.confidence,
        });
      }
    }

    return results
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  /**
   * Hermes：记录用户偏好（带置信度评分与 90 天过期）
   */
  recordHermesPreference(key: string, value: string, options?: { confidence?: number }): HermesPreference {
    const now = Date.now();
    const existing = this.hermesPreferences.get(key);

    if (existing) {
      // 已存在：提升置信度，刷新过期时间
      existing.value = value;
      existing.confirmCount++;
      existing.lastConfirmedAt = now;
      existing.expiresAt = now + this.PREFERENCE_TTL_MS;
      existing.confidence = Math.min(
        this.PREFERENCE_CONFIDENCE_MAX,
        existing.confidence + this.PREFERENCE_CONFIDENCE_INCREMENT
      );
      return existing;
    }

    // 新建偏好
    const initialConfidence = options?.confidence ?? this.PREFERENCE_CONFIDENCE_INCREMENT;
    const pref: HermesPreference = {
      key,
      value,
      confidence: Math.min(this.PREFERENCE_CONFIDENCE_MAX, Math.max(0, initialConfidence)),
      createdAt: now,
      lastConfirmedAt: now,
      expiresAt: now + this.PREFERENCE_TTL_MS,
      confirmCount: 1,
    };
    this.hermesPreferences.set(key, pref);
    return pref;
  }

  /**
   * Hermes：获取用户偏好（带过期与置信度校验）
   */
  getHermesPreference(key: string, minConfidence?: number): HermesPreference | null {
    const pref = this.hermesPreferences.get(key);
    if (!pref) return null;

    // 过期校验
    if (Date.now() > pref.expiresAt) {
      this.hermesPreferences.delete(key);
      return null;
    }

    // 置信度校验
    const threshold = minConfidence ?? this.PREFERENCE_CONFIDENCE_THRESHOLD;
    if (pref.confidence < threshold) return null;

    return pref;
  }

  /**
   * Hermes：获取所有高置信度用户偏好
   */
  getHighConfidenceHermesPreferences(minConfidence?: number): HermesPreference[] {
    const threshold = minConfidence ?? this.PREFERENCE_CONFIDENCE_THRESHOLD;
    const now = Date.now();
    const results: HermesPreference[] = [];
    for (const [key, pref] of this.hermesPreferences) {
      if (now > pref.expiresAt) {
        this.hermesPreferences.delete(key);
        continue;
      }
      if (pref.confidence >= threshold) {
        results.push(pref);
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Hermes：从对话文本中自动提取用户偏好
   * 识别编程语言、工作习惯、沟通风格等
   */
  extractHermesPreferences(text: string): HermesPreference[] {
    const extracted: HermesPreference[] = [];

    // 1. 编程语言识别
    const langPatterns: Array<{ lang: string; patterns: RegExp[] }> = [
      { lang: 'TypeScript', patterns: [/typescript/i, /\.ts\b/, /\bts\b/i] },
      { lang: 'JavaScript', patterns: [/javascript/i, /\.js\b/, /\bjs\b/i] },
      { lang: 'Python', patterns: [/python/i, /\.py\b/] },
      { lang: 'Go', patterns: [/\bgolang\b/i, /\.go\b/] },
      { lang: 'Rust', patterns: [/rust/i, /\.rs\b/] },
    ];
    for (const { lang, patterns } of langPatterns) {
      if (patterns.some(p => p.test(text))) {
        extracted.push(this.recordHermesPreference('programming_language', lang));
      }
    }

    // 2. 沟通风格识别
    if (/简洁|简短|直接|brief|concise/i.test(text)) {
      extracted.push(this.recordHermesPreference('detail_level', 'brief'));
    }
    if (/详细|完整|detailed|comprehensive/i.test(text)) {
      extracted.push(this.recordHermesPreference('detail_level', 'detailed'));
    }
    if (/代码示例|用代码|show code/i.test(text)) {
      extracted.push(this.recordHermesPreference('prefers_code', 'true'));
    }

    // 3. 专业水平识别
    if (/我是新手|初学者|beginner/i.test(text)) {
      extracted.push(this.recordHermesPreference('expertise_level', 'beginner'));
    }
    if (/我是专家|资深|expert|advanced/i.test(text)) {
      extracted.push(this.recordHermesPreference('expertise_level', 'expert'));
    }

    return extracted;
  }

  /**
   * Hermes：按三级架构获取记忆统计
   */
  getHermesTierStats(): Record<HermesTier, number> {
    return {
      [HermesTier.L0_SESSION]: this.working.contextWindow.length + this.episodic.length,
      [HermesTier.L1_PERSISTENT]: this.semantic.concepts.size + this.semantic.facts.size + this.hermesPreferences.size,
      [HermesTier.L2_SKILL]: this.procedural.userPreferences.size + this.procedural.commonPatterns.size + this.procedural.toolUsageStats.size,
    };
  }

  /**
   * Hermes：清理过期的 L1 持久级记忆
   * 超过 90 天未访问的语义知识降级或清理
   */
  cleanExpiredL1Memories(): number {
    const now = Date.now();
    let cleaned = 0;

    // 清理过期的用户偏好
    const expiredPrefKeys: string[] = [];
    for (const [key, pref] of this.hermesPreferences) {
      if (now > pref.expiresAt) {
        expiredPrefKeys.push(key);
      }
    }
    for (const key of expiredPrefKeys) {
      this.hermesPreferences.delete(key);
      cleaned++;
    }

    return cleaned;
  }

  /**
   * 更新程序记忆（用户偏好）
   */
  updateUserPreference(key: string, value: string): void {
    this.procedural.userPreferences.set(key, value);
  }

  /**
   * 获取用户偏好
   */
  getUserPreference(key: string): string | undefined {
    return this.procedural.userPreferences.get(key);
  }

  /**
   * 记录工具使用
   */
  recordToolUsage(toolName: string, success: boolean): void {
    const stats = this.procedural.toolUsageStats.get(toolName) || { count: 0, successRate: 0 };
    stats.count++;
    stats.successRate = ((stats.successRate * (stats.count - 1)) + (success ? 1 : 0)) / stats.count;
    this.procedural.toolUsageStats.set(toolName, stats);
  }

  /**
   * 记录常见模式
   */
  recordPattern(pattern: string): void {
    const count = this.procedural.commonPatterns.get(pattern) || 0;
    this.procedural.commonPatterns.set(pattern, count + 1);
  }

  /**
   * 获取最常见的模式
   */
  getCommonPatterns(topN: number = 5): string[] {
    return Array.from(this.procedural.commonPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([pattern]) => pattern);
  }

  /**
   * 搜索相关记忆（含语义相似度排序）
   * 使用词频重叠 + 语义关联进行排序
   */
  search(query: string, limit: number = 5): MemoryEntry[] {
    const queryWords = extractKeywords(query);
    const allEntries = [
      ...this.working.contextWindow,
    ];

    const scored = allEntries.map(entry => {
      const entryWords = extractKeywords(entry.content);

      // 1. 词频重叠得分
      const intersection = [...queryWords].filter(w => entryWords.has(w));
      const overlapScore = intersection.length / Math.max(queryWords.size, 1);

      // 2. 语义关联得分：基于共同的关键概念
      const semanticScore = this.computeSemanticSimilarity(query, entry.content);

      // 3. 记忆质量得分（考虑衰减）
      const qualityScore = this.computeMemoryScore(entry);

      // 综合得分：词频重叠 * 0.4 + 语义关联 * 0.3 + 记忆质量 * 0.3
      const totalScore = overlapScore * 0.4 + semanticScore * 0.3 + qualityScore * 0.3;

      return { entry, score: totalScore };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter(s => s.score > 0)
      .slice(0, limit)
      .map(s => {
        s.entry.accessCount++;
        s.entry.accessedAt = Date.now();
        return s.entry;
      });
  }

  /**
   * 计算语义相似度：基于关键词共现和语义关联
   */
  private computeSemanticSimilarity(query: string, content: string): number {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();

    // 语义关联映射：相关概念之间的关联度
    const semanticGroups: string[][] = [
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

    let similarity = 0;
    for (const group of semanticGroups) {
      const queryHits = group.filter(w => queryLower.includes(w));
      const contentHits = group.filter(w => contentLower.includes(w));
      if (queryHits.length > 0 && contentHits.length > 0) {
        similarity += 0.2; // 每个语义组匹配贡献0.2
      }
    }

    return Math.min(similarity, 1.0);
  }

  /**
   * 获取记忆统计
   */
  getStats(): {
    workingSize: number;
    episodicCount: number;
    semanticConcepts: number;
    semanticRelationships: number;
    userPreferences: number;
    toolUsageCount: number;
  } {
    return {
      workingSize: this.working.contextWindow.length,
      episodicCount: this.episodic.length,
      semanticConcepts: this.semantic.concepts.size,
      semanticRelationships: this.semantic.relationships.length,
      userPreferences: this.procedural.userPreferences.size,
      toolUsageCount: this.procedural.toolUsageStats.size,
    };
  }

  /**
   * 清空工作记忆
   */
  clearWorking(): void {
    // 将重要内容保存到情景记忆
    for (const entry of this.working.contextWindow) {
      if (entry.importance > 0.5) {
        this.addToEpisodic(entry);
      }
    }

    this.working = {
      currentTopic: '',
      recentEntities: new Map(),
      activeAssumptions: [],
      pendingQuestions: [],
      userIntent: '',
      contextWindow: [],
    };
  }

  /** 更新语义索引 */
  private updateSemanticIndex(memoryId: string, content: string): void {
    // 提取关键词（简单分词：按标点和空格分割，过滤短词）
    const keywords = content
      .replace(/[，。！？、；：""''（）【】《》\s]+/g, ' ')
      .split(' ')
      .filter(w => w.length >= 2)
      .map(w => w.toLowerCase());

    for (const keyword of keywords) {
      if (!this.semanticIndex.has(keyword)) {
        this.semanticIndex.set(keyword, new Set());
      }
      this.semanticIndex.get(keyword)!.add(memoryId);
    }
  }

  /** 通过语义索引快速检索 */
  searchByKeywords(keywords: string[]): MemoryEntry[] {
    const candidateIds = new Set<string>();
    for (const keyword of keywords) {
      const ids = this.semanticIndex.get(keyword.toLowerCase());
      if (ids) {
        for (const id of ids) {
          candidateIds.add(id);
        }
      }
    }

    // 从各层记忆中收集匹配的记忆
    const results: MemoryEntry[] = [];
    for (const id of candidateIds) {
      // 搜索工作记忆
      const wm = this.working.contextWindow.find(m => m.id === id);
      if (wm) { results.push(wm); continue; }
    }

    // 同时搜索语义记忆中的概念和事实
    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      // 搜索语义概念
      for (const [concept, definition] of this.semantic.concepts) {
        if (concept.toLowerCase().includes(keywordLower) || definition.toLowerCase().includes(keywordLower)) {
          results.push({
            id: `semantic_concept_${concept}`,
            content: `${concept}: ${definition}`,
            type: 'semantic',
            importance: 0.7,
            accessCount: 0,
            createdAt: Date.now(),
            accessedAt: Date.now(),
            metadata: { source: 'semantic_concepts' },
          });
        }
      }
      // 搜索语义事实
      for (const [key, fact] of this.semantic.facts) {
        if (key.toLowerCase().includes(keywordLower) || fact.value.toLowerCase().includes(keywordLower)) {
          results.push({
            id: `semantic_fact_${key}`,
            content: `${key}: ${fact.value} (置信度: ${fact.confidence})`,
            type: 'semantic',
            importance: fact.confidence,
            accessCount: 0,
            createdAt: Date.now(),
            accessedAt: Date.now(),
            metadata: { source: 'semantic_facts', confidence: fact.confidence },
          });
        }
      }
    }

    // 搜索情景记忆
    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      for (const ep of this.episodic) {
        const topicMatch = ep.topics.some(t => t.toLowerCase().includes(keywordLower));
        const summaryMatch = ep.summary.toLowerCase().includes(keywordLower);
        if (topicMatch || summaryMatch) {
          results.push({
            id: `episodic_${ep.sessionId}`,
            content: ep.summary || ep.topics.join(', '),
            type: 'episodic',
            importance: 0.6,
            accessCount: 0,
            createdAt: ep.startTime,
            accessedAt: Date.now(),
            metadata: { source: 'episodic', sessionId: ep.sessionId },
          });
        }
      }
    }

    // 去重
    const seen = new Set<string>();
    return results.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  /** 合并相似记忆 */
  mergeSimilarMemories(threshold: number = 0.8): { merged: number; remaining: number } {
    let mergedCount = 0;

    // 合并语义记忆中相似的概念
    const conceptEntries = [...this.semantic.concepts.entries()];
    const conceptsToRemove: string[] = [];

    for (let i = conceptEntries.length - 1; i >= 1; i--) {
      if (conceptsToRemove.includes(conceptEntries[i][0])) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (conceptsToRemove.includes(conceptEntries[j][0])) continue;

        const similarity = this.computeMemorySimilarity(conceptEntries[i][1], conceptEntries[j][1]);
        if (similarity >= threshold) {
          // 保留更完整的定义
          const keeper = conceptEntries[i][1].length >= conceptEntries[j][1].length ? i : j;
          const remover = keeper === i ? j : i;

          // 增强保留概念的相关事实置信度
          const keeperKey = conceptEntries[keeper][0];
          const removerKey = conceptEntries[remover][0];
          const fact = this.semantic.facts.get(removerKey);
          if (fact) {
            const keeperFact = this.semantic.facts.get(keeperKey);
            if (keeperFact) {
              keeperFact.confidence = Math.max(keeperFact.confidence, fact.confidence);
            }
            this.semantic.facts.delete(removerKey);
          }

          conceptsToRemove.push(conceptEntries[remover][0]);
          mergedCount++;
          break; // 一次只合并一对
        }
      }
    }

    // 移除冗余概念
    for (const key of conceptsToRemove) {
      this.semantic.concepts.delete(key);
    }

    // 合并语义记忆中相似的事实
    const factEntries = [...this.semantic.facts.entries()];
    const factsToRemove: string[] = [];

    for (let i = factEntries.length - 1; i >= 1; i--) {
      if (factsToRemove.includes(factEntries[i][0])) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (factsToRemove.includes(factEntries[j][0])) continue;

        const similarity = this.computeMemorySimilarity(factEntries[i][1].value, factEntries[j][1].value);
        if (similarity >= threshold) {
          const keeper = factEntries[i][1].value.length >= factEntries[j][1].value.length ? i : j;
          const remover = keeper === i ? j : i;

          // 增强保留事实的置信度
          factEntries[keeper][1].confidence = Math.max(
            factEntries[i][1].confidence,
            factEntries[j][1].confidence
          );

          factsToRemove.push(factEntries[remover][0]);
          mergedCount++;
          break;
        }
      }
    }

    // 移除冗余事实
    for (const key of factsToRemove) {
      this.semantic.facts.delete(key);
    }

    return {
      merged: mergedCount,
      remaining: this.semantic.concepts.size + this.semantic.facts.size,
    };
  }

  /** 计算记忆内容相似度（基于中文分词 + Jaccard 相似度） */
  private computeMemorySimilarity(content1: string, content2: string): number {
    return textSimilarity(content1, content2);
  }

  /** 生成记忆摘要 */
  generateMemorySummary(): { totalMemories: number; byLayer: Record<string, number>; topTopics: string[]; recentActivity: string } {
    const byLayer = {
      working: this.working.contextWindow.length,
      episodic: this.episodic.length,
      semantic: this.semantic.concepts.size + this.semantic.facts.size,
      procedural: this.procedural.userPreferences.size + this.procedural.commonPatterns.size + this.procedural.toolUsageStats.size,
    };

    // 提取高频主题：从语义概念和情景记忆话题中统计
    const topicFreq = new Map<string, number>();
    for (const [concept] of this.semantic.concepts) {
      const words = tokenize(concept, { minTokenLength: 2 });
      for (const word of words) {
        topicFreq.set(word, (topicFreq.get(word) || 0) + 1);
      }
    }
    for (const ep of this.episodic) {
      for (const topic of ep.topics) {
        const words = tokenize(topic, { minTokenLength: 2 });
        for (const word of words) {
          topicFreq.set(word, (topicFreq.get(word) || 0) + 1);
        }
      }
    }
    const topTopics = [...topicFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic]) => topic);

    // 最近活动：从情景记忆中获取
    const recentMemories = [...this.episodic]
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, 3)
      .map(m => (m.summary || m.topics.join(', ')).substring(0, 50))
      .join('; ');

    return {
      totalMemories: byLayer.working + byLayer.episodic + byLayer.semantic + byLayer.procedural,
      byLayer,
      topTopics,
      recentActivity: recentMemories || '暂无最近活动',
    };
  }
}
