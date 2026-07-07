/**
 * 上下文保持与长期依赖追踪系统 — ContextRetentionSystem
 *
 * 改进扩展交互中的上下文管理，在长对话中保持相关信息，
 * 并提供可衡量的上下文窗口利用效率。
 *
 * 核心能力：
 * - 上下文追踪：带重要性评分、过期时间、标签的上下文项存储
 * - 多策略检索：精确匹配 → 标签匹配 → 语义相似 → 时间近因
 * - 对话摘要：提取关键决策、事实、承诺、行动项和用户偏好
 * - 上下文漂移检测：识别对话是否偏离原始主题
 * - 上下文窗口报告：Token 使用分解与高低价值上下文识别
 * - 上下文优化：在 Token 预算内优先保留高重要性上下文
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { EventBus } from './event-bus.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface ContextItem {
  id: string;
  key: string;
  value: string;
  importance: number;       // 1-10
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  expiresAt?: number;
  tags: string[];
  source: 'user' | 'agent' | 'tool' | 'system';

  supersededBy?: string;
}

export interface ContextOptions {
  importance?: number;
  ttl?: number;             // 毫秒
  tags?: string[];
  source?: string;
}

export interface RetrievalOptions {
  limit?: number;
  minImportance?: number;
  tags?: string[];
  includeExpired?: boolean;
}

export interface ContextWindowReport {
  totalItems: number;
  estimatedTokens: number;
  tokenBudget: number;
  utilizationRate: number;  // 0-1
  breakdown: {
    system: number;
    history: number;
    context: number;
    tools: number;
  };
  highValueItems: number;
  lowValueItems: number;
  recommendations: string[];
}

export interface ContextDriftAnalysis {
  driftDetected: boolean;
  originalTopic: string;
  currentTopic: string;
  driftScore: number;       // 0-1
  lostContext: string[];
  refocusSuggestions: string[];
}

// ============ 持久化用的可序列化类型 ============

interface SerializableContextItem {
  id: string;
  key: string;
  value: string;
  importance: number;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  expiresAt?: number;
  tags: string[];
  source: 'user' | 'agent' | 'tool' | 'system';
  supersededBy?: string;
}

interface ContextRetentionData {
  items: SerializableContextItem[];
  originalTopic: string;
  conversationTopics: string[];
  historySummary: string;
  lastDriftCheck: number;
}

// ============ 常量 ============

/** 默认 Token 预算（128K 上下文窗口） */
const DEFAULT_TOKEN_BUDGET = 128000;

/** 每个字符的估算 Token 数（中英混合平均） */
const CHARS_PER_TOKEN = 2.5;

/** 高价值上下文的重要性阈值 */
const HIGH_VALUE_THRESHOLD = 7;

/** 低价值上下文的重要性阈值 */
const LOW_VALUE_THRESHOLD = 3;

/** 漂移检测的阈值 */
const DRIFT_THRESHOLD = 0.5;

/** 摘要中保留的最大消息数 */
const _MAX_SUMMARY_MESSAGES = 50;

/** 上下文项的最大数量 */
const MAX_CONTEXT_ITEMS = 500;

/** 持久化文件名 */
const PERSIST_FILENAME = 'context-store.json';

// ============ 主类 ============

export class ContextRetentionSystem {
  private items: Map<string, ContextItem> = new Map();
  private originalTopic: string = '';
  private conversationTopics: string[] = [];
  private historySummary: string = '';
  private lastDriftCheck: number = 0;
  private contextDir: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private log = logger.child({ module: 'ContextRetention' });

  constructor() {
    // P0 跨平台修复：使用统一的 duanPath 解析
    this.contextDir = duanPath('context');
    this.loadFromDisk();
  }

  // ============ 1. 上下文追踪 ============

  /**
   * 追踪一个上下文项
   * 自动检测是否更新或取代已有上下文，返回追踪 ID
   */
  trackContext(key: string, value: string, options?: ContextOptions): string {
    const now = Date.now();

    // 检测是否已有同 key 的上下文项（更新/取代逻辑）
    const existingItem = this.findExistingItem(key);

    if (existingItem) {
      // 标记旧项被取代
      existingItem.supersededBy = `ctx_${now.toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
      this.log.info('上下文项被取代', {
        oldId: existingItem.id,
        oldKey: key,
        supersededBy: existingItem.supersededBy,
      });
    }

    const id = existingItem?.supersededBy
      || `ctx_${now.toString(36)}_${Math.random().toString(36).substr(2, 6)}`;

    const source = this.normalizeSource(options?.source);

    const item: ContextItem = {
      id,
      key,
      value,
      importance: Math.min(10, Math.max(1, options?.importance ?? 5)),
      createdAt: now,
      lastAccessed: now,
      accessCount: 1,
      expiresAt: options?.ttl ? now + options.ttl : undefined,
      tags: options?.tags || [],
      source,
    };

    this.items.set(id, item);

    // 容量控制：超出上限时淘汰低价值项
    if (this.items.size > MAX_CONTEXT_ITEMS) {
      this.evictLowValueItems();
    }

    this.markDirty();

    this.log.info('上下文项已追踪', {
      id,
      key,
      importance: item.importance,
      source: item.source,
      isUpdate: !!existingItem,
    });

    // 广播事件
    EventBus.getInstance().emitSync('context.tracked', {
      id,
      key,
      importance: item.importance,
      source: item.source,
      isUpdate: !!existingItem,
    });

    return id;
  }

  // ============ 2. 上下文检索 ============

  /**
   * 多策略检索相关上下文
   * 策略优先级：精确匹配 → 标签匹配 → 语义相似 → 时间近因
   */
  retrieveContext(query: string, options?: RetrievalOptions): ContextItem[] {
    const now = Date.now();
    const limit = options?.limit ?? 10;
    const minImportance = options?.minImportance ?? 1;
    const filterTags = options?.tags || [];
    const includeExpired = options?.includeExpired ?? false;

    // 过滤有效上下文项
    const candidates = Array.from(this.items.values()).filter(item => {
      // 重要性过滤
      if (item.importance < minImportance) return false;
      // 过期过滤
      if (!includeExpired && item.expiresAt && item.expiresAt < now) return false;
      // 被取代的项不参与检索
      if (item.supersededBy) return false;
      // 标签过滤
      if (filterTags.length > 0) {
        const hasTag = filterTags.some(tag => item.tags.includes(tag));
        if (!hasTag) return false;
      }
      return true;
    });

    // 多策略评分
    const scored = candidates.map(item => {
      let score = 0;
      const queryLower = query.toLowerCase();
      const keyLower = item.key.toLowerCase();
      const valueLower = item.value.toLowerCase();

      // 策略1：精确匹配（最高权重）
      if (keyLower === queryLower) {
        score += 20;
      } else if (valueLower === queryLower) {
        score += 18;
      }

      // 策略2：部分精确匹配
      if (keyLower.includes(queryLower) || queryLower.includes(keyLower)) {
        score += 12;
      }
      if (valueLower.includes(queryLower)) {
        score += 8;
      }

      // 策略3：标签匹配
      const queryTokens = this.tokenize(queryLower);
      for (const tag of item.tags) {
        const tagLower = tag.toLowerCase();
        if (queryLower.includes(tagLower) || tagLower.includes(queryLower)) {
          score += 6;
        }
        for (const token of queryTokens) {
          if (tagLower.includes(token)) {
            score += 3;
          }
        }
      }

      // 策略4：语义相似度（基于词汇重叠）
      const keyTokens = this.tokenize(keyLower);
      const valueTokens = this.tokenize(valueLower);
      const allItemTokens = new Set([...keyTokens, ...valueTokens]);
      const overlap = queryTokens.filter(t => allItemTokens.has(t)).length;
      const union = new Set([...queryTokens, ...allItemTokens]).size;
      const jaccardSimilarity = union > 0 ? overlap / union : 0;
      score += jaccardSimilarity * 10;

      // 策略5：时间近因加分
      const ageMs = now - item.lastAccessed;
      const ageHours = ageMs / (1000 * 60 * 60);
      // 1小时内 +5，1天内 +3，1周内 +1
      if (ageHours < 1) score += 5;
      else if (ageHours < 24) score += 3;
      else if (ageHours < 168) score += 1;

      // 重要性加权
      score *= (0.5 + item.importance / 20);

      // 访问频率加分
      score += Math.log(item.accessCount + 1) * 0.5;

      return { item, score };
    });

    // 按分数排序
    scored.sort((a, b) => b.score - a.score);

    // 更新被检索到的项的访问信息
    const results = scored.slice(0, limit);
    for (const { item } of results) {
      item.lastAccessed = now;
      item.accessCount++;
    }

    this.markDirty();

    this.log.debug('上下文检索完成', {
      query,
      resultCount: results.length,
      topScore: results[0]?.score ?? 0,
    });

    return results.map(r => r.item);
  }

  // ============ 3. 对话历史摘要 ============

  /**
   * 摘要对话历史
   * 提取关键决策、事实、承诺，保留行动项和用户偏好
   */
  summarizeHistory(messages: Array<{ role: string; content: string }>): string {
    if (messages.length === 0) return '无对话历史';

    const _now = Date.now();
    const sections: string[] = [];

    // 提取关键决策
    const decisions = this.extractDecisions(messages);
    if (decisions.length > 0) {
      sections.push('【关键决策】');
      sections.push(...decisions.map(d => `  - ${d}`));
    }

    // 提取事实与约束
    const facts = this.extractFacts(messages);
    if (facts.length > 0) {
      sections.push('【事实与约束】');
      sections.push(...facts.map(f => `  - ${f}`));
    }

    // 提取承诺与行动项
    const commitments = this.extractCommitments(messages);
    if (commitments.length > 0) {
      sections.push('【承诺与行动项】');
      sections.push(...commitments.map(c => `  - ${c}`));
    }

    // 提取用户偏好
    const preferences = this.extractPreferences(messages);
    if (preferences.length > 0) {
      sections.push('【用户偏好】');
      sections.push(...preferences.map(p => `  - ${p}`));
    }

    // 话题轨迹
    const topicTrail = this.extractTopicTrail(messages);
    if (topicTrail.length > 0) {
      sections.push('【话题轨迹】');
      sections.push(`  ${topicTrail.join(' → ')}`);
    }

    // 更新原始主题（取第一个话题）
    if (!this.originalTopic && topicTrail.length > 0) {
      this.originalTopic = topicTrail[0];
    }

    // 更新对话主题列表
    this.conversationTopics = topicTrail;

    const summary = sections.length > 0
      ? sections.join('\n')
      : '对话历史中未提取到关键信息';

    this.historySummary = summary;

    // 将摘要作为上下文项追踪
    this.trackContext('conversation_summary', summary, {
      importance: 8,
      tags: ['summary', 'auto-generated'],
      source: 'system',
    });

    this.log.info('对话历史摘要已生成', {
      messageCount: messages.length,
      decisionCount: decisions.length,
      factCount: facts.length,
      commitmentCount: commitments.length,
    });

    EventBus.getInstance().emitSync('context.summary_generated', {
      messageCount: messages.length,
      sectionCount: sections.length,
    });

    return summary;
  }

  // ============ 4. 上下文漂移检测 ============

  /**
   * 检测对话是否偏离原始上下文
   * 比较当前主题与追踪的上下文，返回漂移分析与重聚焦建议
   */
  detectContextDrift(currentInput: string): ContextDriftAnalysis {
    const now = Date.now();
    this.lastDriftCheck = now;

    // 如果没有原始主题，无法检测漂移
    if (!this.originalTopic) {
      return {
        driftDetected: false,
        originalTopic: '未设定',
        currentTopic: this.extractCurrentTopic(currentInput),
        driftScore: 0,
        lostContext: [],
        refocusSuggestions: [],
      };
    }

    const currentTopic = this.extractCurrentTopic(currentInput);
    const originalTokens = this.tokenize(this.originalTopic.toLowerCase());
    const currentTokens = this.tokenize(currentTopic.toLowerCase());

    // 计算 Jaccard 相似度
    const originalSet = new Set(originalTokens);
    const currentSet = new Set(currentTokens);
    let intersection = 0;
    for (const token of currentSet) {
      if (originalSet.has(token)) intersection++;
    }
    const union = new Set([...originalSet, ...currentSet]).size;
    const similarity = union > 0 ? intersection / union : 0;

    // 漂移分数 = 1 - 相似度
    const driftScore = Math.min(1, 1 - similarity);
    const driftDetected = driftScore >= DRIFT_THRESHOLD;

    // 识别丢失的上下文
    const lostContext = this.identifyLostContext(currentInput);

    // 生成重聚焦建议
    const refocusSuggestions = driftDetected
      ? this.generateRefocusSuggestions(lostContext)
      : [];

    const analysis: ContextDriftAnalysis = {
      driftDetected,
      originalTopic: this.originalTopic,
      currentTopic,
      driftScore,
      lostContext,
      refocusSuggestions,
    };

    this.log.info('上下文漂移检测完成', {
      driftDetected,
      driftScore: driftScore.toFixed(2),
      originalTopic: this.originalTopic,
      currentTopic,
      lostContextCount: lostContext.length,
    });

    if (driftDetected) {
      EventBus.getInstance().emitSync('context.drift_detected', {
        driftScore,
        originalTopic: this.originalTopic,
        currentTopic,
      });
    }

    return analysis;
  }

  // ============ 5. 上下文窗口报告 ============

  /**
   * 获取当前上下文窗口利用率
   * 计算 Token 使用分解，识别高低价值上下文
   */
  getContextWindow(): ContextWindowReport {
    const now = Date.now();
    let totalTokens = 0;
    let highValueItems = 0;
    let lowValueItems = 0;
    const breakdown = {
      system: 0,
      history: 0,
      context: 0,
      tools: 0,
    };

    for (const item of this.items.values()) {
      // 跳过已过期或被取代的项
      if (item.expiresAt && item.expiresAt < now) continue;
      if (item.supersededBy) continue;

      const tokens = this.estimateTokens(item.value);

      // 按来源分类
      switch (item.source) {
        case 'system':
          breakdown.system += tokens;
          break;
        case 'user':
        case 'agent':
          breakdown.history += tokens;
          break;
        case 'tool':
          breakdown.tools += tokens;
          break;
      }
      // 所有项都计入 context
      breakdown.context += tokens;
      totalTokens += tokens;

      // 高低价值分类
      if (item.importance >= HIGH_VALUE_THRESHOLD) {
        highValueItems++;
      } else if (item.importance <= LOW_VALUE_THRESHOLD) {
        lowValueItems++;
      }
    }

    // 避免重复计算：history 包含 user+agent，context 包含全部
    // 重新计算 breakdown 使其更合理
    breakdown.context = totalTokens;
    breakdown.history = Math.floor(totalTokens * 0.4);  // 估算历史占比
    breakdown.system = Math.floor(totalTokens * 0.1);    // 估算系统占比
    breakdown.tools = Math.floor(totalTokens * 0.15);    // 估算工具占比

    const utilizationRate = Math.min(1, totalTokens / DEFAULT_TOKEN_BUDGET);

    // 生成建议
    const recommendations = this.generateWindowRecommendations(
      utilizationRate,
      highValueItems,
      lowValueItems,
      totalTokens,
    );

    const activeItemCount = Array.from(this.items.values()).filter(
      item => !item.supersededBy && (!item.expiresAt || item.expiresAt >= now)
    ).length;

    return {
      totalItems: activeItemCount,
      estimatedTokens: totalTokens,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      utilizationRate,
      breakdown,
      highValueItems,
      lowValueItems,
      recommendations,
    };
  }

  // ============ 6. 上下文优化 ============

  /**
   * 在 Token 预算内优化上下文
   * 优先保留高重要性上下文，压缩或移除低价值项
   */
  optimizeContext(budget: number): string {
    const now = Date.now();
    const report = this.getContextWindow();
    const optimizationLog: string[] = [];

    optimizationLog.push(`优化前: ${report.estimatedTokens} tokens / ${budget} budget (${(report.utilizationRate * 100).toFixed(1)}%)`);

    if (report.estimatedTokens <= budget) {
      optimizationLog.push('当前上下文在预算内，无需优化');
      return optimizationLog.join('\n');
    }

    // 收集所有活跃项并按优先级排序
    const activeItems = Array.from(this.items.values()).filter(
      item => !item.supersededBy && (!item.expiresAt || item.expiresAt >= now)
    );

    // 按重要性降序、访问频率降序、时间近因降序排列
    activeItems.sort((a, b) => {
      // 重要性优先
      if (a.importance !== b.importance) return b.importance - a.importance;
      // 访问频率次之
      if (a.accessCount !== b.accessCount) return b.accessCount - a.accessCount;
      // 最近访问次之
      return b.lastAccessed - a.lastAccessed;
    });

    let usedTokens = 0;
    const kept: ContextItem[] = [];
    const removed: ContextItem[] = [];
    const compressed: ContextItem[] = [];

    // 贪心选择：优先保留高重要性项
    for (const item of activeItems) {
      const itemTokens = this.estimateTokens(item.value);

      if (usedTokens + itemTokens <= budget) {
        // 直接保留
        kept.push(item);
        usedTokens += itemTokens;
      } else if (item.importance >= HIGH_VALUE_THRESHOLD) {
        // 高价值项：尝试压缩而非移除
        const compressedValue = this.compressValue(item.value);
        const compressedTokens = this.estimateTokens(compressedValue);

        if (usedTokens + compressedTokens <= budget) {
          // 压缩后可保留
          item.value = compressedValue;
          kept.push(item);
          usedTokens += compressedTokens;
          compressed.push(item);
        } else {
          removed.push(item);
        }
      } else {
        // 低价值项：移除
        removed.push(item);
      }
    }

    // 标记被移除的项
    for (const item of removed) {
      this.items.delete(item.id);
    }

    this.markDirty();

    // 生成报告
    optimizationLog.push(`优化后: ${usedTokens} tokens / ${budget} budget (${((usedTokens / budget) * 100).toFixed(1)}%)`);
    optimizationLog.push(`保留: ${kept.length} 项, 压缩: ${compressed.length} 项, 移除: ${removed.length} 项`);

    if (removed.length > 0) {
      optimizationLog.push('已移除的低价值项:');
      for (const item of removed.slice(0, 5)) {
        optimizationLog.push(`  - [${item.key}] 重要度:${item.importance} 访问:${item.accessCount}次`);
      }
      if (removed.length > 5) {
        optimizationLog.push(`  ... 共 ${removed.length} 项`);
      }
    }

    if (compressed.length > 0) {
      optimizationLog.push('已压缩的高价值项:');
      for (const item of compressed) {
        optimizationLog.push(`  - [${item.key}] 重要度:${item.importance}`);
      }
    }

    this.log.info('上下文优化完成', {
      budget,
      beforeTokens: report.estimatedTokens,
      afterTokens: usedTokens,
      keptCount: kept.length,
      compressedCount: compressed.length,
      removedCount: removed.length,
    });

    EventBus.getInstance().emitSync('context.optimized', {
      beforeTokens: report.estimatedTokens,
      afterTokens: usedTokens,
      removedCount: removed.length,
      compressedCount: compressed.length,
    });

    return optimizationLog.join('\n');
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'context_track',
        description: '追踪上下文项：存储带重要性评分、过期时间和标签的上下文信息。自动检测是否更新或取代已有上下文。用于记录关键决策、用户偏好、任务约束等需要跨轮次保持的信息。',
        parameters: {
          key: { type: 'string', description: '上下文键名，用于标识和检索', required: true },
          value: { type: 'string', description: '上下文值内容', required: true },
          importance: { type: 'string', description: '重要度 1-10（默认5，10最关键）', required: false },
          ttl: { type: 'string', description: '存活时间（毫秒），超时后自动过期', required: false },
          tags: { type: 'string', description: '标签，逗号分隔，用于分类和检索', required: false },
          source: { type: 'string', description: '来源: user/agent/tool/system（默认agent）', required: false },
        },
        execute: (args) => {
          try {
            const id = self.trackContext(
              args.key as string,
              args.value as string,
              {
                importance: parseInt(args.importance as string) || 5,
                ttl: args.ttl ? parseInt(args.ttl as string) : undefined,
                tags: args.tags ? (args.tags as string).split(',').map(t => t.trim()) : [],
                source: (args.source as string) || 'agent',
              }
            );
            return Promise.resolve(`✅ 上下文已追踪 (ID: ${id}, 键: ${args.key}, 重要度: ${args.importance || 5})`);
          } catch (err: unknown) {
            return Promise.resolve(`❌ 追踪上下文失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'context_retrieve',
        description: '检索相关上下文：多策略检索（精确匹配→标签匹配→语义相似→时间近因），返回按相关性排序的上下文项列表。',
        parameters: {
          query: { type: 'string', description: '检索查询关键词', required: true },
          limit: { type: 'string', description: '返回条数（默认10）', required: false },
          min_importance: { type: 'string', description: '最低重要度过滤（默认1）', required: false },
          tags: { type: 'string', description: '标签过滤，逗号分隔', required: false },
          include_expired: { type: 'string', description: '是否包含已过期项（默认false）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const results = self.retrieveContext(
              args.query as string,
              {
                limit: parseInt(args.limit as string) || 10,
                minImportance: parseInt(args.min_importance as string) || 1,
                tags: args.tags ? (args.tags as string).split(',').map(t => t.trim()) : [],
                includeExpired: args.include_expired === 'true',
              }
            );
            if (results.length === 0) return Promise.resolve('🔍 未找到相关上下文');
            return Promise.resolve(results.map(item =>
              `  [${item.key}] ${item.value.substring(0, 100)} (重要度:${item.importance}, 来源:${item.source}, 访问:${item.accessCount}次)`
            ).join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 检索上下文失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'context_window',
        description: '获取上下文窗口报告：展示 Token 使用分解、高低价值上下文统计、利用率及优化建议。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const report = self.getContextWindow();
            const lines = [
              `📊 上下文窗口报告`,
              `  总项数: ${report.totalItems}`,
              `  估算 Token: ${report.estimatedTokens} / ${report.tokenBudget}`,
              `  利用率: ${(report.utilizationRate * 100).toFixed(1)}%`,
              `  Token 分解: 系统=${report.breakdown.system} 历史=${report.breakdown.history} 工具=${report.breakdown.tools}`,
              `  高价值项: ${report.highValueItems}, 低价值项: ${report.lowValueItems}`,
            ];
            if (report.recommendations.length > 0) {
              lines.push('  💡 建议:');
              report.recommendations.forEach(r => lines.push(`    - ${r}`));
            }
            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 获取窗口报告失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'context_optimize',
        description: '优化上下文：在指定 Token 预算内，优先保留高重要性上下文，压缩或移除低价值项。返回优化报告。',
        parameters: {
          budget: { type: 'string', description: 'Token 预算上限（默认64000）', required: false },
        },
        execute: (args) => {
          try {
            const budget = parseInt(args.budget as string) || 64000;
            return Promise.resolve(self.optimizeContext(budget));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 优化上下文失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'context_drift',
        description: '检测上下文漂移：分析当前对话是否偏离原始主题，返回漂移分数、丢失的上下文和重聚焦建议。',
        parameters: {
          current_input: { type: 'string', description: '当前用户输入，用于与原始主题对比', required: true },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const analysis = self.detectContextDrift(args.current_input as string);
            const lines = [
              `🧭 上下文漂移分析`,
              `  原始主题: ${analysis.originalTopic}`,
              `  当前主题: ${analysis.currentTopic}`,
              `  漂移分数: ${analysis.driftScore.toFixed(2)} (阈值: ${DRIFT_THRESHOLD})`,
              `  漂移检测: ${analysis.driftDetected ? '⚠️ 是' : '✅ 否'}`,
            ];
            if (analysis.lostContext.length > 0) {
              lines.push('  丢失的上下文:');
              analysis.lostContext.forEach(c => lines.push(`    - ${c}`));
            }
            if (analysis.refocusSuggestions.length > 0) {
              lines.push('  💡 重聚焦建议:');
              analysis.refocusSuggestions.forEach(s => lines.push(`    - ${s}`));
            }
            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 检测漂移失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
    ];
  }

  // ============ 内部辅助方法 ============

  /** 查找已有同 key 的上下文项 */
  private findExistingItem(key: string): ContextItem | undefined {
    const keyLower = key.toLowerCase();
    for (const item of this.items.values()) {
      if (item.key.toLowerCase() === keyLower && !item.supersededBy) {
        return item;
      }
    }
    return undefined;
  }

  /** 规范化来源类型 */
  private normalizeSource(source?: string): ContextItem['source'] {
    const validSources: ContextItem['source'][] = ['user', 'agent', 'tool', 'system'];
    if (source && validSources.includes(source as ContextItem['source'])) {
      return source as ContextItem['source'];
    }
    return 'agent';
  }

  /** 分词：支持中英文混合 */
  private tokenize(text: string): string[] {
    // 中文字符单独拆分，英文按空格拆分
    const tokens: string[] = [];
    // 提取中文词（每个字作为一个 token）
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
    tokens.push(...chineseChars);
    // 提取英文单词
    const englishWords = text
      .replace(/[\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);
    tokens.push(...englishWords);
    return tokens;
  }

  /** 估算文本的 Token 数 */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /** 淘汰低价值项以控制容量 */
  private evictLowValueItems(): void {
    const items = Array.from(this.items.values())
      .filter(item => !item.supersededBy)
      .sort((a, b) => {
        // 先按重要性升序，再按访问次数升序，再按创建时间升序
        if (a.importance !== b.importance) return a.importance - b.importance;
        if (a.accessCount !== b.accessCount) return a.accessCount - b.accessCount;
        return a.createdAt - b.createdAt;
      });

    // 淘汰前 10% 的低价值项
    const evictCount = Math.max(1, Math.floor(items.length * 0.1));
    for (let i = 0; i < evictCount && i < items.length; i++) {
      this.items.delete(items[i].id);
    }

    this.log.info('低价值上下文项已淘汰', { evictCount });
  }

  /** 提取关键决策 */
  private extractDecisions(messages: Array<{ role: string; content: string }>): string[] {
    const decisions: string[] = [];
    const decisionPatterns = [
      /决定(?:使用|采用|选择|选)[了]?\s*(.+)/,
      /(?:我们|我)(?:决定|选择|确定|确认)[了]?\s*(.+)/,
      /(?:最终|最后)(?:选择|决定|采用)\s*(.+)/,
      /(?:用|采用|使用)\s*(.+?)\s*(?:方案|方式|方法|技术|框架|库)/,
      /decided?\s+(?:to\s+)?(?:use|go\s+with|adopt)\s+(.+)/i,
    ];

    for (const msg of messages) {
      for (const pattern of decisionPatterns) {
        const match = msg.content.match(pattern);
        if (match && match[1]) {
          decisions.push(match[1].trim().substring(0, 100));
        }
      }
    }

    return [...new Set(decisions)].slice(0, 10);
  }

  /** 提取事实与约束 */
  private extractFacts(messages: Array<{ role: string; content: string }>): string[] {
    const facts: string[] = [];
    const factPatterns = [
      /(?:项目|系统|应用)(?:使用|基于|运行在)\s*(.+)/,
      /(?:环境|版本|配置)[是为：:]\s*(.+)/,
      /(?:要求|约束|限制|必须|需要)(?:是|：:)?\s*(.+)/,
      /(?:不支持|不能|不可|无法)(.+)/,
      /running\s+(?:on|with)\s+(.+)/i,
      /requires?\s+(.+)/i,
    ];

    for (const msg of messages) {
      for (const pattern of factPatterns) {
        const match = msg.content.match(pattern);
        if (match && match[1]) {
          facts.push(match[1].trim().substring(0, 100));
        }
      }
    }

    return [...new Set(facts)].slice(0, 10);
  }

  /** 提取承诺与行动项 */
  private extractCommitments(messages: Array<{ role: string; content: string }>): string[] {
    const commitments: string[] = [];
    const commitmentPatterns = [
      /(?:我会|我来|我将|我帮你|让我)(.+)/,
      /(?:待办|TODO|todo|后续|接下来)(?:需要|要|做)?\s*(.+)/,
      /(?:需要|应该|必须)(?:先|再)?(?:做|完成|实现|处理)\s*(.+)/,
      /will\s+(?:do|complete|implement|handle)\s+(.+)/i,
      /need\s+to\s+(.+)/i,
    ];

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue; // 只从助手消息中提取承诺
      for (const pattern of commitmentPatterns) {
        const match = msg.content.match(pattern);
        if (match && match[1]) {
          commitments.push(match[1].trim().substring(0, 100));
        }
      }
    }

    return [...new Set(commitments)].slice(0, 10);
  }

  /** 提取用户偏好 */
  private extractPreferences(messages: Array<{ role: string; content: string }>): string[] {
    const preferences: string[] = [];
    const preferencePatterns = [
      /(?:我喜欢|偏好|希望|想要|习惯)(.+)/,
      /(?:不要|不用|避免|排斥)(.+)/,
      /(?:风格|格式|方式)[是为：:]\s*(.+)/,
      /prefer\s+(.+)/i,
      /don'?t\s+(?:want|like|use)\s+(.+)/i,
    ];

    for (const msg of messages) {
      if (msg.role !== 'user') continue; // 只从用户消息中提取偏好
      for (const pattern of preferencePatterns) {
        const match = msg.content.match(pattern);
        if (match && match[1]) {
          preferences.push(match[1].trim().substring(0, 100));
        }
      }
    }

    return [...new Set(preferences)].slice(0, 10);
  }

  /** 提取话题轨迹 */
  private extractTopicTrail(messages: Array<{ role: string; content: string }>): string[] {
    const topicKeywords: Record<string, string[]> = {
      '编程语言': ['python', 'java', 'javascript', 'typescript', 'go', 'rust', 'c++', 'c#'],
      '前端': ['react', 'vue', 'angular', 'html', 'css', '前端', 'frontend'],
      '后端': ['node', 'express', 'spring', 'django', 'flask', '后端', 'backend', 'api'],
      '数据库': ['mysql', 'postgresql', 'mongodb', 'redis', 'sqlite', '数据库', 'database'],
      '部署': ['docker', 'kubernetes', 'k8s', 'nginx', '部署', 'deploy', 'ci/cd'],
      '测试': ['测试', 'test', 'jest', 'pytest', '单元测试'],
      '架构': ['架构', '设计', 'architecture', '微服务', 'monorepo'],
      'AI/ML': ['ai', 'ml', '深度学习', '机器学习', 'llm', 'gpt', 'claude'],
      '安全': ['安全', 'security', '加密', '认证', '授权'],
      '性能': ['性能', '优化', 'performance', '缓存', 'cache'],
    };

    const topics: string[] = [];
    const seenTopics = new Set<string>();

    for (const msg of messages) {
      const text = msg.content.toLowerCase();
      for (const [topic, keywords] of Object.entries(topicKeywords)) {
        if (keywords.some(kw => text.includes(kw)) && !seenTopics.has(topic)) {
          seenTopics.add(topic);
          topics.push(topic);
        }
      }
    }

    return topics.slice(0, 8);
  }

  /** 提取当前输入的主题 */
  private extractCurrentTopic(input: string): string {
    const topicKeywords: Record<string, string[]> = {
      '编程语言': ['python', 'java', 'javascript', 'typescript', 'go', 'rust', 'c++'],
      '前端': ['react', 'vue', 'angular', 'html', 'css', '前端', 'frontend'],
      '后端': ['node', 'express', 'spring', 'django', '后端', 'backend', 'api'],
      '数据库': ['mysql', 'postgresql', 'mongodb', 'redis', '数据库', 'database'],
      '部署': ['docker', 'kubernetes', '部署', 'deploy', 'ci/cd'],
      '测试': ['测试', 'test', 'jest', 'pytest'],
      '架构': ['架构', '设计', 'architecture', '微服务'],
      'AI/ML': ['ai', 'ml', '深度学习', '机器学习', 'llm', 'gpt'],
      '安全': ['安全', 'security', '加密'],
      '性能': ['性能', '优化', 'performance'],
    };

    const inputLower = input.toLowerCase();
    const matched: string[] = [];

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(kw => inputLower.includes(kw))) {
        matched.push(topic);
      }
    }

    return matched.length > 0 ? matched.join(', ') : '通用对话';
  }

  /** 识别丢失的上下文 */
  private identifyLostContext(currentInput: string): string[] {
    const now = Date.now();
    const lost: string[] = [];
    const inputLower = currentInput.toLowerCase();
    const inputTokens = new Set(this.tokenize(inputLower));

    for (const item of this.items.values()) {
      // 跳过已过期或被取代的项
      if (item.supersededBy) continue;
      if (item.expiresAt && item.expiresAt < now) continue;
      // 只关注高重要性项
      if (item.importance < HIGH_VALUE_THRESHOLD) continue;

      const itemTokens = new Set(this.tokenize(item.value.toLowerCase()));
      // 计算与当前输入的交集
      let overlap = 0;
      for (const token of inputTokens) {
        if (itemTokens.has(token)) overlap++;
      }

      // 如果高重要性项与当前输入几乎无交集，认为可能丢失
      if (overlap === 0 && item.importance >= HIGH_VALUE_THRESHOLD) {
        lost.push(`${item.key}: ${item.value.substring(0, 80)}`);
      }
    }

    return lost.slice(0, 5);
  }

  /** 生成重聚焦建议 */
  private generateRefocusSuggestions(lostContext: string[]): string[] {
    const suggestions: string[] = [];

    if (this.originalTopic) {
      suggestions.push(`考虑回到原始主题: ${this.originalTopic}`);
    }

    if (lostContext.length > 0) {
      suggestions.push('以下重要上下文可能被忽略，建议重新关注:');
      for (const ctx of lostContext.slice(0, 3)) {
        suggestions.push(`  → ${ctx}`);
      }
    }

    // 基于对话主题的建议
    if (this.conversationTopics.length > 1) {
      const recentTopic = this.conversationTopics[this.conversationTopics.length - 1];
      const originalTopic = this.conversationTopics[0];
      if (recentTopic !== originalTopic) {
        suggestions.push(`当前话题"${recentTopic}"与初始话题"${originalTopic}"不同，确认是否需要切换`);
      }
    }

    suggestions.push('如果话题切换是有意的，可以使用 context_track 更新当前上下文焦点');

    return suggestions;
  }

  /** 生成上下文窗口建议 */
  private generateWindowRecommendations(
    utilizationRate: number,
    highValueItems: number,
    lowValueItems: number,
    totalTokens: number,
  ): string[] {
    const recommendations: string[] = [];

    if (utilizationRate > 0.8) {
      recommendations.push('上下文利用率超过80%，建议执行 context_optimize 释放空间');
    }

    if (utilizationRate > 0.9) {
      recommendations.push('⚠️ 上下文利用率超过90%，存在溢出风险，强烈建议立即优化');
    }

    if (lowValueItems > 10) {
      recommendations.push(`存在 ${lowValueItems} 个低价值上下文项，考虑清理以提高效率`);
    }

    if (highValueItems === 0 && totalTokens > 0) {
      recommendations.push('没有高价值上下文项，建议为核心信息设置更高重要度（≥7）');
    }

    if (utilizationRate < 0.3 && totalTokens > 0) {
      recommendations.push('上下文利用率较低，可以存储更多上下文信息');
    }

    // 检查过期项
    const now = Date.now();
    const expiredCount = Array.from(this.items.values()).filter(
      item => item.expiresAt && item.expiresAt < now && !item.supersededBy
    ).length;
    if (expiredCount > 0) {
      recommendations.push(`存在 ${expiredCount} 个已过期上下文项，将在下次优化时清理`);
    }

    return recommendations;
  }

  /** 压缩上下文值（保留关键信息） */
  private compressValue(value: string): string {
    // 简单压缩策略：保留首尾，中间用省略号
    if (value.length <= 100) return value;

    const headLen = 60;
    const tailLen = 30;
    const head = value.substring(0, headLen);
    const tail = value.substring(value.length - tailLen);
    return `${head}...[${value.length - headLen - tailLen}字已压缩]...${tail}`;
  }

  // ============ 持久化 ============

  /** 标记数据已变更，延迟保存 */
  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), 2000);
  }

  /** 保存到磁盘 */
  private saveToDisk(): void {
    if (!this.dirty) return;

    try {
      // 确保目录存在
      if (!fs.existsSync(this.contextDir)) {
        fs.mkdirSync(this.contextDir, { recursive: true });
      }

      const _now = Date.now();
      const data: ContextRetentionData = {
        items: Array.from(this.items.values()).map(item => ({
          id: item.id,
          key: item.key,
          value: item.value,
          importance: item.importance,
          createdAt: item.createdAt,
          lastAccessed: item.lastAccessed,
          accessCount: item.accessCount,
          expiresAt: item.expiresAt,
          tags: item.tags,
          source: item.source,
          supersededBy: item.supersededBy,
        })),
        originalTopic: this.originalTopic,
        conversationTopics: this.conversationTopics,
        historySummary: this.historySummary,
        lastDriftCheck: this.lastDriftCheck,
      };

      const filePath = path.join(this.contextDir, PERSIST_FILENAME);
      atomicWriteJsonSync(filePath, data);
      this.dirty = false;

      this.log.debug('上下文数据已持久化', {
        itemCount: data.items.length,
        filePath,
      });
    } catch (err: unknown) {
      this.log.error('上下文持久化失败', { error: err });
    }
  }

  /** 从磁盘加载 */
  private loadFromDisk(): void {
    try {
      const filePath = path.join(this.contextDir, PERSIST_FILENAME);
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, 'utf-8');
      const data: ContextRetentionData = JSON.parse(content);

      // 恢复上下文项
      this.items.clear();
      if (data.items) {
        for (const item of data.items) {
          this.items.set(item.id, {
            id: item.id,
            key: item.key,
            value: item.value,
            importance: item.importance,
            createdAt: item.createdAt,
            lastAccessed: item.lastAccessed,
            accessCount: item.accessCount,
            expiresAt: item.expiresAt,
            tags: item.tags || [],
            source: item.source || 'agent',
            supersededBy: item.supersededBy,
          });
        }
      }

      // 恢复元数据
      this.originalTopic = data.originalTopic || '';
      this.conversationTopics = data.conversationTopics || [];
      this.historySummary = data.historySummary || '';
      this.lastDriftCheck = data.lastDriftCheck || 0;

      this.log.info('上下文数据已从磁盘加载', {
        itemCount: this.items.size,
        originalTopic: this.originalTopic,
      });
    } catch (err: unknown) {
      this.log.warn('上下文数据加载失败，使用空状态', { error: err });
    }
  }

  /**
   * P0 资源消耗修复：dispose — 清理 saveTimer 并强制落盘
   *
   * 之前 ContextRetentionSystem 无 dispose 方法，saveTimer 在进程退出时泄漏，
   * pending 的上下文数据（最长 2 秒窗口）会丢失。
   * 现在 bootstrap.ts 的 dispose 链会调用此方法。
   */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 强制 flush 待写入数据，避免丢失最近 2 秒内的上下文变更
    if (this.dirty) {
      try { this.saveToDisk(); } catch {}
    }
  }
}
