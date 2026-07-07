/**
 * 持续学习框架 — ContinuousLearningFramework
 *
 * 实现增量学习与知识保留（防止灾难性遗忘），目标知识保留率 95%+
 *
 * 核心机制：
 * - 增量学习 (Incremental Learning): 新知识逐步融入，版本追踪，冲突检测
 * - 知识保留 (Knowledge Retention): 冲突检测 → 合并/版本化，永不覆盖
 * - 记忆巩固 (Memory Consolidation): 合并重复、强化高频、衰减低频、解决矛盾
 * - 受控遗忘 (Controlled Forgetting): 软删除（降低重要性），追踪遗忘曲线
 * - 知识图谱更新: 学习新知识时自动更新关联边
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { tokenize } from './chinese-tokenizer.js';
import { EventBus } from './event-bus.js';
import type { ModelLibrary } from './model-library.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 知识条目 */
export interface KnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  domain: string;
  version: number;
  importance: number;       // 1-10
  accessCount: number;
  createdAt: number;
  lastAccessed: number;
  relatedTopics: string[];
  source: 'learning' | 'experience' | 'inference' | 'user_input';
  confidence: number;       // 0-1
  supersededBy?: string;    // 被更新版本替代时的ID
}

/** 保留分析结果 */
export interface RetentionAnalysis {
  retentionScore: number;   // 0-1, 目标 >= 0.95
  conflicts: KnowledgeConflict[];
  affectedEntries: string[];
  recommendation: 'proceed' | 'merge' | 'version' | 'reject';
}

/** 知识冲突 */
export interface KnowledgeConflict {
  existingId: string;
  existingContent: string;
  conflictType: 'contradiction' | 'partial_overlap' | 'outdated' | 'ambiguity';
  resolution: string;
}

/** 巩固报告 */
export interface ConsolidationReport {
  mergedEntries: number;
  strengthenedEntries: number;
  decayedEntries: number;
  resolvedContradictions: number;
  retentionRate: number;
}

/** 学习统计 */
export interface LearningStats {
  totalEntries: number;
  entriesByDomain: Record<string, number>;
  retentionRate: number;
  learningVelocity: number;       // 每日新增条目数
  conflictResolutionRate: number;
  knowledgeAgeDistribution: {
    last24h: number;
    last7d: number;
    last30d: number;
    older: number;
  };
}

/** 学习结果 */
export interface LearningResult {
  id: string;
  topic: string;
  domain: string;
  version: number;
  retentionScore: number;
  conflicts: number;
  action: 'created' | 'updated' | 'merged' | 'versioned' | 'rejected';
}

// ============ 持续学习框架 ============

export class ContinuousLearningFramework {
  private knowledgeBase: Map<string, KnowledgeEntry> = new Map();
  private modelLibrary: ModelLibrary | null;
  private knowledgeDir: string;
  private log = logger.child({ module: 'ContinuousLearning' });

  // 统计追踪
  private totalConflicts = 0;
  private resolvedConflicts = 0;
  private creationTimestamps: number[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary ?? null;
    // P0 跨平台修复：使用统一的 duanPath 解析
    this.knowledgeDir = duanPath('knowledge');
    this.loadKnowledge();
    this.log.info('持续学习框架初始化完成', {
      existingEntries: this.knowledgeBase.size,
      knowledgeDir: this.knowledgeDir,
    });
  }

  // ========== 核心接口 ==========

  /**
   * 增量学习新知识
   * - 存储到知识库并追踪版本
   * - 运行保留检查（检测冲突）
   * - 冲突时合并或创建新版本（永不覆盖）
   * - 更新知识图谱边
   */
  learnKnowledge(topic: string, content: string, domain: string): Promise<LearningResult> {
    this.log.info('学习新知识', { topic, domain });

    // 1. 运行保留检查
    const retention = this.retainCheck(content, domain);

    // 2. 根据推荐决定操作
    let result: LearningResult;

    if (retention.conflicts.length === 0 || retention.recommendation === 'proceed') {
      // 无冲突，直接创建
      const entry = this.createEntry(topic, content, domain, 'learning');
      this.knowledgeBase.set(entry.id, entry);
      this.persistEntry(entry);

      result = {
        id: entry.id,
        topic,
        domain,
        version: entry.version,
        retentionScore: retention.retentionScore,
        conflicts: 0,
        action: 'created',
      };
    } else if (retention.recommendation === 'merge') {
      // 合并到已有条目
      const existingId = retention.conflicts[0].existingId;
      const existing = this.knowledgeBase.get(existingId);
      if (existing) {
        existing.content = this.mergeContent(existing.content, content);
        existing.importance = Math.min(10, existing.importance + 1);
        existing.lastAccessed = Date.now();
        existing.confidence = Math.min(1, existing.confidence + 0.05);
        this.persistEntry(existing);
        this.resolvedConflicts++;
      }

      result = {
        id: existingId,
        topic,
        domain,
        version: existing?.version ?? 1,
        retentionScore: retention.retentionScore,
        conflicts: retention.conflicts.length,
        action: 'merged',
      };
    } else if (retention.recommendation === 'version') {
      // 创建新版本，旧条目标记为被替代
      const existingId = retention.conflicts[0].existingId;
      const existing = this.knowledgeBase.get(existingId);
      const newVersion = (existing?.version ?? 0) + 1;

      const entry = this.createEntry(topic, content, domain, 'learning', newVersion);
      entry.relatedTopics = existing?.relatedTopics ?? [];
      this.knowledgeBase.set(entry.id, entry);
      this.persistEntry(entry);

      // 标记旧条目被替代
      if (existing) {
        existing.supersededBy = entry.id;
        this.persistEntry(existing);
      }

      result = {
        id: entry.id,
        topic,
        domain,
        version: newVersion,
        retentionScore: retention.retentionScore,
        conflicts: retention.conflicts.length,
        action: 'versioned',
      };
      this.resolvedConflicts++;
    } else {
      // reject — 拒绝学习
      result = {
        id: '',
        topic,
        domain,
        version: 0,
        retentionScore: retention.retentionScore,
        conflicts: retention.conflicts.length,
        action: 'rejected',
      };
      this.log.warn('知识学习被拒绝', { topic, domain, reason: 'retention check rejected' });
      return Promise.resolve(result);
    }

    this.totalConflicts += retention.conflicts.length;
    this.creationTimestamps.push(Date.now());

    // 更新知识图谱边
    this.updateKnowledgeGraphEdges(topic, domain);

    // 广播学习事件
    EventBus.getInstance().emitSync('learning.recorded', {
      id: result.id,
      topic,
      domain,
      action: result.action,
      retentionScore: result.retentionScore,
    }, { source: 'ContinuousLearning' });

    this.log.info('知识学习完成', {
      id: result.id,
      action: result.action,
      retentionScore: result.retentionScore,
    });

    return Promise.resolve(result);
  }

  /**
   * 让出事件循环 — 避免长任务（同步持久化 / O(n²) 巩固）阻塞主线程
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
  }

  /**
   * 保留检查 — 检测新知识是否与已有知识冲突
   * - 比较同域所有已有知识
   * - 计算保留分数 (0-1)
   * - 识别冲突事实
   */
  retainCheck(newKnowledge: string, domain?: string): RetentionAnalysis {
    const candidates = this.getEntriesByDomain(domain);
    const conflicts: KnowledgeConflict[] = [];
    const affectedEntries: string[] = [];

    const newTokens = this.tokenizeText(newKnowledge.toLowerCase());

    for (const entry of candidates) {
      const existingTokens = this.tokenizeText(entry.content.toLowerCase());

      // 关键词重叠度
      const overlap = this.computeOverlap(newTokens, existingTokens);

      if (overlap > 0.3) {
        // 有显著重叠，进一步分析冲突类型
        const conflictType = this.classifyConflict(newKnowledge, entry.content, overlap);
        const resolution = this.suggestResolution(conflictType, overlap);

        conflicts.push({
          existingId: entry.id,
          existingContent: entry.content.substring(0, 200),
          conflictType,
          resolution,
        });
        affectedEntries.push(entry.id);
      }
    }

    // 保留分数：无冲突时为1，冲突越多越低
    const retentionScore = conflicts.length === 0
      ? 1.0
      : Math.max(0, 1 - conflicts.length * 0.15);

    // 推荐操作
    let recommendation: RetentionAnalysis['recommendation'];
    if (conflicts.length === 0) {
      recommendation = 'proceed';
    } else if (conflicts.some(c => c.conflictType === 'contradiction')) {
      recommendation = 'version';
    } else if (conflicts.some(c => c.conflictType === 'partial_overlap')) {
      recommendation = 'merge';
    } else if (retentionScore < 0.5) {
      recommendation = 'reject';
    } else {
      recommendation = 'proceed';
    }

    return {
      retentionScore,
      conflicts,
      affectedEntries,
      recommendation,
    };
  }

  /**
   * 记忆巩固 — 合并重复、强化高频、衰减低频、解决矛盾
   * 真正异步执行：在重负载阶段之间让出事件循环，避免阻塞主线程
   */
  async consolidateMemories(): Promise<ConsolidationReport> {
    this.log.info('开始记忆巩固');

    const allEntries = Array.from(this.knowledgeBase.values());
    let mergedEntries = 0;
    let strengthenedEntries = 0;
    let decayedEntries = 0;
    let resolvedContradictions = 0;
    const now = Date.now();

    // 1. 合并重复条目
    const domainGroups = this.groupByDomain(allEntries);
    for (const [, entries] of Object.entries(domainGroups)) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const sim = this.computeSimilarity(entries[i].content, entries[j].content);
          if (sim > 0.85 && !entries[i].supersededBy && !entries[j].supersededBy) {
            // 合并到重要性更高的条目
            const [target, source] = entries[i].importance >= entries[j].importance
              ? [entries[i], entries[j]]
              : [entries[j], entries[i]];

            target.content = this.mergeContent(target.content, source.content);
            target.importance = Math.min(10, target.importance + 1);
            target.confidence = Math.min(1, Math.max(target.confidence, source.confidence));
            source.supersededBy = target.id;

            this.persistEntry(target);
            this.persistEntry(source);
            mergedEntries++;
          }
        }
      }
      // 每处理完一个域让出事件循环，避免 O(n²) 比较长时间阻塞
      await this.yieldToEventLoop();
    }

    // 2. 强化频繁访问的知识
    for (const entry of allEntries) {
      if (entry.supersededBy) continue;

      if (entry.accessCount > 5) {
        entry.importance = Math.min(10, entry.importance + 1);
        strengthenedEntries++;
      }

      // 3. 衰减长期未使用的知识
      const ageDays = (now - entry.lastAccessed) / (24 * 3600 * 1000);
      if (ageDays > 30 && entry.accessCount < 3) {
        entry.importance = Math.max(1, entry.importance - 1);
        decayedEntries++;
      }

      entry.lastAccessed = now;
      this.persistEntry(entry);
    }
    // 持久化批量写文件后让出事件循环
    await this.yieldToEventLoop();

    // 4. 检测并解决矛盾
    for (const [, entries] of Object.entries(domainGroups)) {
      const activeEntries = entries.filter(e => !e.supersededBy);
      for (let i = 0; i < activeEntries.length; i++) {
        for (let j = i + 1; j < activeEntries.length; j++) {
          const conflict = this.detectContradiction(activeEntries[i], activeEntries[j]);
          if (conflict) {
            // 保留置信度更高的条目
            const [keep, demote] = activeEntries[i].confidence >= activeEntries[j].confidence
              ? [activeEntries[i], activeEntries[j]]
              : [activeEntries[j], activeEntries[i]];

            demote.supersededBy = keep.id;
            demote.importance = Math.max(1, demote.importance - 2);
            this.persistEntry(keep);
            this.persistEntry(demote);
            resolvedContradictions++;
          }
        }
      }
      // 每处理完一个域让出事件循环
      await this.yieldToEventLoop();
    }

    // 计算巩固后保留率
    const retentionRate = this.calculateRetentionRate();

    const report: ConsolidationReport = {
      mergedEntries,
      strengthenedEntries,
      decayedEntries,
      resolvedContradictions,
      retentionRate,
    };

    EventBus.getInstance().emitSync('learning.recorded', {
      action: 'consolidated',
      report,
    }, { source: 'ContinuousLearning' });

    this.log.info('记忆巩固完成', { ...report });
    return report;
  }

  /**
   * 查询知识库 — 语义搜索（关键词匹配 + 重要性评分）
   */
  queryKnowledge(query: string, domain?: string): Array<{
    id: string;
    topic: string;
    content: string;
    domain: string;
    confidence: number;
    importance: number;
    score: number;
  }> {
    const queryTokens = this.tokenizeText(query.toLowerCase());
    const candidates = this.getEntriesByDomain(domain)
      .filter(e => !e.supersededBy);

    const results = candidates.map(entry => {
      const contentTokens = this.tokenizeText(entry.content.toLowerCase());
      const topicTokens = this.tokenizeText(entry.topic.toLowerCase());

      // 关键词匹配分数
      const contentMatch = this.computeOverlap(queryTokens, contentTokens);
      const topicMatch = this.computeOverlap(queryTokens, topicTokens);
      const keywordScore = topicMatch * 0.4 + contentMatch * 0.6;

      // 重要性加权
      const importanceBoost = entry.importance / 10;

      // 综合分数
      const score = keywordScore * 0.7 + importanceBoost * 0.3;

      // 更新访问计数
      entry.accessCount++;
      entry.lastAccessed = Date.now();
      this.persistEntry(entry);

      return {
        id: entry.id,
        topic: entry.topic,
        content: entry.content,
        domain: entry.domain,
        confidence: entry.confidence,
        importance: entry.importance,
        score,
      };
    });

    return results
      .filter(r => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  /**
   * 受控遗忘 — 降低重要性而非删除（软删除）
   */
  forgetKnowledge(topic: string): {
    success: boolean;
    topic: string;
    newImportance: number;
    message: string;
  } {
    const entry = this.findEntryByTopic(topic);

    if (!entry) {
      return {
        success: false,
        topic,
        newImportance: 0,
        message: `未找到主题为 "${topic}" 的知识条目`,
      };
    }

    // 软删除：降低重要性
    const oldImportance = entry.importance;
    entry.importance = Math.max(1, Math.floor(entry.importance * 0.3));
    entry.confidence = Math.max(0, entry.confidence - 0.3);
    entry.lastAccessed = Date.now();

    this.persistEntry(entry);

    this.log.info('知识已衰减', {
      topic,
      oldImportance,
      newImportance: entry.importance,
    });

    return {
      success: true,
      topic,
      newImportance: entry.importance,
      message: `知识 "${topic}" 重要性已从 ${oldImportance} 降至 ${entry.importance}（软删除）`,
    };
  }

  /**
   * 获取学习统计
   */
  getLearningStats(): LearningStats {
    const allEntries = Array.from(this.knowledgeBase.values());
    const activeEntries = allEntries.filter(e => !e.supersededBy);
    const now = Date.now();

    // 按域统计
    const entriesByDomain: Record<string, number> = {};
    for (const entry of activeEntries) {
      entriesByDomain[entry.domain] = (entriesByDomain[entry.domain] || 0) + 1;
    }

    // 保留率
    const retentionRate = this.calculateRetentionRate();


    // 学习速度（最近7天新增数 / 7）
    const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
    const recentCreations = this.creationTimestamps.filter(t => t > sevenDaysAgo);
    const learningVelocity = recentCreations.length / 7;

    // 冲突解决率
    const conflictResolutionRate = this.totalConflicts > 0
      ? this.resolvedConflicts / this.totalConflicts
      : 1.0;

    // 知识年龄分布
    const oneDayAgo = now - 24 * 3600 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;

    const knowledgeAgeDistribution = {
      last24h: activeEntries.filter(e => e.createdAt > oneDayAgo).length,
      last7d: activeEntries.filter(e => e.createdAt > sevenDaysAgo).length,
      last30d: activeEntries.filter(e => e.createdAt > thirtyDaysAgo).length,
      older: activeEntries.filter(e => e.createdAt <= thirtyDaysAgo).length,
    };

    return {
      totalEntries: activeEntries.length,
      entriesByDomain,
      retentionRate,
      learningVelocity,
      conflictResolutionRate,
      knowledgeAgeDistribution,
    };
  }

  /**
   * 获取工具定义 — 供 Agent Loop 调用
   */
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
        name: 'learn_knowledge',
        description: '学习新知识并执行保留检查。自动检测与已有知识的冲突，通过合并或版本化处理冲突，永不覆盖已有知识。返回学习结果和保留分数。',
        parameters: {
          topic: { type: 'string', description: '知识主题', required: true },
          content: { type: 'string', description: '知识内容', required: true },
          domain: { type: 'string', description: '知识领域（如 coding, web, system 等）', required: true },
        },
        execute: async (args) => {
          const topic = args.topic as string;
          const content = args.content as string;
          const domain = args.domain as string;

          if (!topic || !content || !domain) {
            return '错误: topic、content、domain 均为必填参数';
          }

          const result = await self.learnKnowledge(topic, content, domain);
          return `知识学习完成\n` +
            `- 主题: ${result.topic}\n` +
            `- 领域: ${result.domain}\n` +
            `- 版本: v${result.version}\n` +
            `- 操作: ${result.action}\n` +
            `- 保留分数: ${(result.retentionScore * 100).toFixed(1)}%\n` +
            `- 冲突数: ${result.conflicts}\n` +
            `- ID: ${result.id}`;
        },
      },
      {
        name: 'query_knowledge',
        description: '查询知识库。基于关键词匹配和重要性评分进行语义搜索，返回排序结果和置信度。',
        parameters: {
          query: { type: 'string', description: '查询关键词或描述', required: true },
          domain: { type: 'string', description: '限定领域（可选）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const query = args.query as string;
          const domain = args.domain as string | undefined;

          if (!query) return Promise.resolve('错误: query 为必填参数');

          const results = self.queryKnowledge(query, domain);
          if (results.length === 0) return Promise.resolve('未找到相关知识');

          return Promise.resolve(results.slice(0, 10).map((r, i) =>
            `${i + 1}. [${r.domain}] ${r.topic}\n` +
            `   内容: ${r.content.substring(0, 150)}\n` +
            `   置信度: ${(r.confidence * 100).toFixed(0)}% | 重要性: ${r.importance}/10 | 匹配分: ${r.score.toFixed(3)}`
          ).join('\n\n'));
        },
      },
      {
        name: 'consolidate_knowledge',
        description: '巩固和整理知识库。合并重复条目、强化高频访问知识、衰减低频知识、检测并解决矛盾。返回巩固报告。',
        parameters: {},
        execute: async () => {
          const report = await self.consolidateMemories();
          return `知识巩固完成\n` +
            `- 合并条目: ${report.mergedEntries}\n` +
            `- 强化条目: ${report.strengthenedEntries}\n` +
            `- 衰减条目: ${report.decayedEntries}\n` +
            `- 解决矛盾: ${report.resolvedContradictions}\n` +
            `- 保留率: ${(report.retentionRate * 100).toFixed(1)}%`;
        },
      },
      {
        name: 'learning_stats',
        description: '获取学习统计信息。包括总知识条目数、按领域分布、保留率、学习速度、冲突解决率、知识年龄分布。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const stats = self.getLearningStats();
          const domainBreakdown = Object.entries(stats.entriesByDomain)
            .map(([d, c]) => `  ${d}: ${c}`)
            .join('\n');

          return Promise.resolve(`学习统计\n` +
            `- 总知识条目: ${stats.totalEntries}\n` +
            `- 领域分布:\n${domainBreakdown || '  (无)'}\n` +
            `- 保留率: ${(stats.retentionRate * 100).toFixed(1)}%\n` +
            `- 学习速度: ${stats.learningVelocity.toFixed(1)} 条/天\n` +
            `- 冲突解决率: ${(stats.conflictResolutionRate * 100).toFixed(1)}%\n` +
            `- 年龄分布: 24h内=${stats.knowledgeAgeDistribution.last24h}, 7天内=${stats.knowledgeAgeDistribution.last7d}, 30天内=${stats.knowledgeAgeDistribution.last30d}, 更早=${stats.knowledgeAgeDistribution.older}`);
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 创建知识条目 */
  private createEntry(
    topic: string,
    content: string,
    domain: string,
    source: KnowledgeEntry['source'],
    version: number = 1,
  ): KnowledgeEntry {
    const id = `kl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    return {
      id,
      topic,
      content,
      domain,
      version,
      importance: 5,
      accessCount: 0,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      relatedTopics: [],
      source,
      confidence: 0.7,
    };
  }

  /** 合并内容 */
  private mergeContent(existing: string, incoming: string): string {
    // 简单合并：保留已有内容，追加新信息中不重复的部分
    const existingSentences = existing.split(/[。；\n]/).filter(s => s.trim());
    const incomingSentences = incoming.split(/[。；\n]/).filter(s => s.trim());

    const newSentences = incomingSentences.filter(
      inc => !existingSentences.some(
        ext => this.computeSimilarity(ext, inc) > 0.8
      )
    );

    if (newSentences.length === 0) return existing;
    return existing + '\n' + newSentences.join('。');
  }

  /** 计算两个文本的相似度 */
  private computeSimilarity(a: string, b: string): number {
    const tokensA = this.tokenizeText(a.toLowerCase());
    const tokensB = this.tokenizeText(b.toLowerCase());
    return this.computeOverlap(tokensA, tokensB);
  }

  /** 计算token重叠度 (Jaccard-like) */
  private computeOverlap(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0 && tokensB.length === 0) return 0;
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    let intersection = 0;
    for (const t of setA) {
      if (setB.has(t)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /** 分词 */
  private tokenizeText(text: string): string[] {
    return tokenize(text, { minTokenLength: 2 });
  }

  /** 分类冲突类型 */
  private classifyConflict(
    newContent: string,
    existingContent: string,
    overlap: number,
  ): KnowledgeConflict['conflictType'] {
    if (overlap > 0.7) {
      // 高重叠但内容有差异 → 可能是更新/过时
      return 'outdated';
    }
    if (overlap > 0.5) {
      // 中等重叠 → 部分重叠
      return 'partial_overlap';
    }
    // 检查否定词（简单矛盾检测）
    const negationPatterns = ['不', '非', '无', '未', '不是', '不能', 'not', "don't", "doesn't", "isn't"];
    const newHasNegation = negationPatterns.some(p => newContent.includes(p));
    const existingHasNegation = negationPatterns.some(p => existingContent.includes(p));

    if (newHasNegation !== existingHasNegation && overlap > 0.3) {
      return 'contradiction';
    }

    return 'ambiguity';
  }

  /** 建议冲突解决策略 */
  private suggestResolution(
    conflictType: KnowledgeConflict['conflictType'],
    _overlap: number,
  ): string {
    switch (conflictType) {
      case 'contradiction':
        return '存在直接矛盾，建议创建新版本保留两种观点';
      case 'partial_overlap':
        return '部分内容重叠，建议合并互补信息';
      case 'outdated':
        return '已有知识可能过时，建议创建新版本替代';
      case 'ambiguity':
        return '存在模糊性，建议保留两者并标注差异';
    }
  }

  /** 获取指定域的知识条目 */
  private getEntriesByDomain(domain?: string): KnowledgeEntry[] {
    const all = Array.from(this.knowledgeBase.values());
    if (!domain) return all;
    return all.filter(e => e.domain === domain);
  }

  /** 按域分组 */
  private groupByDomain(entries: KnowledgeEntry[]): Record<string, KnowledgeEntry[]> {
    const groups: Record<string, KnowledgeEntry[]> = {};
    for (const entry of entries) {
      if (!groups[entry.domain]) groups[entry.domain] = [];
      groups[entry.domain].push(entry);
    }
    return groups;
  }

  /** 检测两个条目之间的矛盾 */
  private detectContradiction(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
    // 同域同主题但置信度差异大的条目可能存在矛盾
    if (a.domain !== b.domain) return false;

    const topicSimilarity = this.computeSimilarity(a.topic, b.topic);
    if (topicSimilarity < 0.5) return false;

    const contentSimilarity = this.computeSimilarity(a.content, b.content);
    // 主题相似但内容差异大
    if (topicSimilarity > 0.7 && contentSimilarity < 0.3) return true;

    // 置信度差异悬殊
    if (Math.abs(a.confidence - b.confidence) > 0.5 && topicSimilarity > 0.5) return true;

    return false;
  }

  /** 计算保留率 */
  private calculateRetentionRate(): number {
    const all = Array.from(this.knowledgeBase.values());
    if (all.length === 0) return 1.0;

    // 保留率 = 仍活跃（未被替代）的知识比例
    const active = all.filter(e => !e.supersededBy).length;
    const rate = active / all.length;

    // 目标 95%+，如果低于目标则通过加权提升
    // 保留率本身反映的是知识的稳定性，不是人为调高的
    return Math.min(1, rate);
  }

  /** 根据主题查找条目 */
  private findEntryByTopic(topic: string): KnowledgeEntry | undefined {
    const topicLower = topic.toLowerCase();
    return Array.from(this.knowledgeBase.values()).find(
      e => e.topic.toLowerCase() === topicLower || e.topic.toLowerCase().includes(topicLower)
    );
  }

  /** 更新知识图谱边 */
  private updateKnowledgeGraphEdges(topic: string, domain: string): void {
    // 查找同域相关主题，建立关联
    const sameDomainEntries = this.getEntriesByDomain(domain)
      .filter(e => !e.supersededBy);

    for (const entry of sameDomainEntries) {
      const sim = this.computeSimilarity(topic, entry.topic);
      if (sim > 0.2 && sim < 1.0) {
        // 双向关联
        if (!entry.relatedTopics.includes(topic)) {
          entry.relatedTopics.push(topic);
          this.persistEntry(entry);
        }
      }
    }
  }

  // ========== 持久化 ==========

  /** 加载知识库 */
  private loadKnowledge(): void {
    try {
      if (!fs.existsSync(this.knowledgeDir)) return;

      const files = fs.readdirSync(this.knowledgeDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.knowledgeDir, file), 'utf-8'));
          this.knowledgeBase.set(data.id, data);
          this.creationTimestamps.push(data.createdAt);
        } catch {
          // 单个文件加载失败不影响整体
        }
      }

      this.log.info('知识库加载完成', { entries: this.knowledgeBase.size });
    } catch (err: unknown) {
      this.log.warn('知识库加载失败，使用空知识库', { error: err });
    }
  }

  /** 持久化单个条目 */
  private persistEntry(entry: KnowledgeEntry): void {
    try {
      fs.mkdirSync(this.knowledgeDir, { recursive: true });
      const filePath = path.join(this.knowledgeDir, `${entry.id}.json`);
      atomicWriteJsonSync(filePath, entry);
    } catch (err: unknown) {
      this.log.error('知识条目持久化失败', { id: entry.id, error: err });
    }
  }
}
