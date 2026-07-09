/**
 * 自我学习系统 - SelfLearningSystem
 *
 * 真正的Agent必须能从经验中学习：
 * 1. 交互学习：从每次对话中提取知识
 * 2. 错误学习：从失败中总结教训
 * 3. 模式识别：发现重复模式，形成经验
 * 4. 知识迁移：将一个领域的经验应用到另一个领域
 * 5. 技能等级：跟踪各项能力的成长
 * 6. 持久化：学习结果持久保存，重启不丢失
 */

import type { ModelLibrary } from './model-library.js';
import * as fs from 'fs';
import * as path from 'path';
import { tokenize } from './chinese-tokenizer.js';
import { EventBus, Events } from './event-bus.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import { duanPath } from './duan-paths.js';
import { SimpleEmbedder, CrossAttention } from './attention-mechanism.js';

// ============ 类型定义 ============

/** 学习记录类型 */
export type LearningType =
  | 'interaction'     // 交互经验
  | 'error'           // 错误教训
  | 'correction'      // 修正经验
  | 'best_practice'   // 最佳实践
  | 'user_preference' // 用户偏好
  | 'knowledge_gap'   // 知识盲区
  | 'skill_upgrade'   // 技能升级
  | 'pattern';        // 模式识别

/** 学习记录 */
export interface LearningRecord {
  id: string;
  type: LearningType;
  category: string;           // 分类：coding, analysis, creative, etc.
  content: string;            // 学习内容
  context: string;            // 上下文
  source: string;             // 来源
  confidence: number;         // 置信度 0-1
  frequency: number;          // 出现频率
  lastSeen: number;           // 最后出现时间
  firstSeen: number;          // 首次出现时间
  applied: boolean;           // 是否已应用
  appliedCount: number;       // 应用次数
  outcome?: 'positive' | 'negative' | 'neutral';  // 应用结果
  tags: string[];             // 标签
}

/** 技能定义 */
export interface Skill {
  id: string;
  name: string;
  category: string;
  level: number;              // 1-10
  experience: number;         // 经验值
  nextLevelAt: number;        // 升级所需经验
  recentPerformance: number[];// 最近表现
  learnedFrom: string[];      // 学习来源
}

  /** 知识条目 */
  export interface KnowledgeEntry {
    id: string;
    topic: string;
    content: string;
    source: 'interaction' | 'self_discovery' | 'user_teaching' | 'web_learning';
    verified: boolean;
    confidence: number;
    relatedTopics: string[];
    lastUpdated: number;
    usageCount: number;
    /** 跨领域关联：从哪些其他知识条目推导而来 */
    derivedFrom?: string[];
    /** 是否与其他知识条目存在潜在矛盾 */
    conflictsWith?: string[];
  }

  /** 交互模式 */
  export interface InteractionPattern {
    id: string;
    patternType: 'repeated_query' | 'similar_task' | 'recurring_issue' | 'user_habit';
    description: string;
    triggerCount: number;
    firstSeen: number;
    lastSeen: number;
    confidence: number;
    tags: string[];
    relatedRecords: string[];
    suggestedResponse?: string;
  }

/** 学习报告 */
export interface LearningReport {
  totalRecords: number;
  skillsCount: number;
  knowledgeCount: number;
  topSkills: Array<{ name: string; level: number }>;
  recentLearnings: Array<{ type: string; content: string }>;
  knowledgeGaps: string[];
  improvementSuggestions: string[];
  learningVelocity: number;   // 学习速度
  retentionRate: number;      // 知识保留率
}

// ============ 主类 ============

export class SelfLearningSystem {
  private modelLibrary: ModelLibrary;
  private records: Map<string, LearningRecord> = new Map();
  private skills: Map<string, Skill> = new Map();
  private knowledge: Map<string, KnowledgeEntry> = new Map();
  private patterns: Map<string, InteractionPattern> = new Map();
  private dataPath: string;
  /** tags → recordId 倒排索引，加速模式匹配 */
  private tagIndex: Map<string, Set<string>> = new Map();
  /** 保存节流：上次保存时间 */
  private lastSaveTime: number = 0;
  /** 保存节流间隔（毫秒）：最多每5秒保存一次 */
  private readonly SAVE_THROTTLE_MS = 5000;
  /** 待保存标记 */
  private savePending: boolean = false;
  /** Part G: 语义嵌入器（lazy 初始化，复用 smart-tool-selector 同款哈希向量） */
  private embedder?: SimpleEmbedder;
  private crossAttention?: CrossAttention;
  /** 记录向量缓存（recordId → 向量），saveData 时失效 */
  private recordVectorCache: Map<string, number[]> = new Map();

  constructor(modelLibrary: ModelLibrary, dataPath?: string) {
    this.modelLibrary = modelLibrary;
    this.dataPath = dataPath || duanPath('learning');
    // 数据目录不存在时自动创建（递归），保证 loadData/saveData 路径拼接时父目录就绪
    if (!fs.existsSync(this.dataPath)) {
      try {
        fs.mkdirSync(this.dataPath, { recursive: true });
      } catch {
        // 权限/并发竞态忽略，后续 saveData 会重试 mkdir
      }
    }
    this.loadData();
    this.initializeDefaultSkills();
  }

  /**
   * 节流保存：避免频繁磁盘I/O
   */
  private throttledSave(): void {
    const now = Date.now();
    if (now - this.lastSaveTime >= this.SAVE_THROTTLE_MS) {
      this.saveData();
      this.lastSaveTime = now;
      this.savePending = false;
    } else if (!this.savePending) {
      this.savePending = true;
      // 延迟到节流间隔后保存
      setTimeout(() => {
        this.saveData();
        this.lastSaveTime = Date.now();
        this.savePending = false;
      }, this.SAVE_THROTTLE_MS - (now - this.lastSaveTime));
    }
  }

  // ========== 学习接口 ==========

  /**
   * 从交互中学习
   */
  learnFromInteraction(
    input: string,
    response: string,
    feedback?: 'positive' | 'negative' | 'neutral',
  ): LearningRecord {
    const category = this.categorizeInput(input);
    const content = this.extractLearning(input, response, feedback);

    // 检查是否已有类似记录
    const existingId = this.findSimilarRecord(content, category);
    if (existingId) {
      // 更新已有记录
      const existing = this.records.get(existingId)!;
      existing.frequency++;
      existing.lastSeen = Date.now();
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      if (feedback === 'positive') existing.outcome = 'positive';
      if (feedback === 'negative') existing.outcome = 'negative';

      // 更新技能经验
      this.addSkillExperience(category, feedback === 'positive' ? 2 : 1);

      // 检测模式：相同类型的任务反复出现
      this.detectAndRecordPattern(existing, input);

      this.saveData();
      return existing;
    }

    // 创建新记录
    const record: LearningRecord = {
      id: `learn-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      type: feedback === 'negative' ? 'correction' : 'interaction',
      category,
      content,
      context: input.substring(0, 200),
      source: 'interaction',
      confidence: (() => {
        if (feedback === 'positive') return 0.8;
        if (feedback === 'negative') return 0.3;
        return 0.5;
      })(),
      frequency: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applied: false,
      appliedCount: 0,
      outcome: feedback,
      tags: this.extractTags(input),
    };

    this.records.set(record.id, record);
    // 更新倒排索引（防御：tags 可能为 undefined，做兜底）
    for (const tag of record.tags || []) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(record.id);
    }

    this.addSkillExperience(category, feedback === 'positive' ? 2 : 1);

    // 提取知识（增强版：包含跨领域关联）
    this.extractKnowledge(input, response, category);

    // 检测交互模式
    this.detectAndRecordPattern(record, input);

    this.throttledSave();

    // 通过事件总线广播学习事件
    const eventBus = EventBus.getInstance();
    eventBus.emit(Events.LEARNING_RECORDED, {
      recordId: record.id, type: record.type, category: record.category,
      confidence: record.confidence, frequency: record.frequency,
      isNew: !existingId,
    }, { source: 'self-learning-system', priority: 'low' }).catch(() => {});

    return record;
  }

  /**
   * 检测并记录交互模式
   */
  private detectAndRecordPattern(record: LearningRecord, input: string): void {
    // 1. 检测重复查询模式：相同关键词出现3次以上
    const keywords = this.extractTags(input);
    for (const keyword of keywords) {
      // 使用倒排索引 O(1) 查询，代替 O(n) filter
      const indexedIds = this.tagIndex.get(keyword);
      const similarRecords = indexedIds
        ? Array.from(indexedIds)
            .filter(id => id !== record.id)
            .map(id => this.records.get(id)!)
            .filter(Boolean)
        : [];
      if (similarRecords.length >= 2) {
        const existingPattern = Array.from(this.patterns.values())
          .find(p => p.tags.includes(keyword) && p.patternType === 'repeated_query');
        if (existingPattern) {
          existingPattern.triggerCount++;
          existingPattern.lastSeen = Date.now();
          existingPattern.confidence = Math.min(1, existingPattern.confidence + 0.1);
          existingPattern.relatedRecords.push(record.id);
        } else {
          const pattern: InteractionPattern = {
            id: `pattern-${Date.now()}`,
            patternType: 'repeated_query',
            description: `用户频繁查询 "${keyword}" 相关内容 (已出现 ${similarRecords.length + 1} 次)`,
            triggerCount: similarRecords.length + 1,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            confidence: 0.5,
            tags: [keyword],
            relatedRecords: [record.id, ...similarRecords.slice(0, 5).map(r => r.id)],
          };
          this.patterns.set(pattern.id, pattern);
        }
      }
    }

    // 2. 检测相似任务模式
    if (record.category) {
      const categoryRecords = Array.from(this.records.values())
        .filter(r => r.category === record.category && r.id !== record.id);
      if (categoryRecords.length >= 3) {
        const patternId = `pattern-cat-${record.category}`;
        const existing = this.patterns.get(patternId);
        if (existing) {
          existing.triggerCount = categoryRecords.length + 1;
          existing.lastSeen = Date.now();
          existing.confidence = Math.min(1, 0.3 + categoryRecords.length * 0.1);
        } else {
          this.patterns.set(patternId, {
            id: patternId,
            patternType: 'similar_task',
            description: `用户经常在 "${record.category}" 领域请求帮助 (${categoryRecords.length + 1} 次)`,
            triggerCount: categoryRecords.length + 1,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            confidence: 0.4,
            tags: [record.category],
            relatedRecords: [],
          });
        }
      }
    }

    // 通过事件总线广播模式检测事件
    const newPatterns = Array.from(this.patterns.values())
      .filter(p => Date.now() - p.firstSeen < 10000); // 最近10秒内检测到的模式
    for (const p of newPatterns) {
      const eventBus = EventBus.getInstance();
      eventBus.emit(Events.PATTERN_DETECTED, {
        patternId: p.id, patternType: p.patternType,
        description: p.description, confidence: p.confidence,
        triggerCount: p.triggerCount, tags: p.tags,
      }, { source: 'self-learning-system', priority: 'low' }).catch(() => {});
    }
  }

  /**
   * 获取已检测到的交互模式
   */
  getPatterns(): InteractionPattern[] {
    return Array.from(this.patterns.values())
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 返回与当前输入相关的模式作为上下文提示
   */
  getPatternContext(input: string): string {
    const inputLower = input.toLowerCase();
    const relevant = Array.from(this.patterns.values())
      .filter(p => p.tags.some(t => inputLower.includes(t)) && p.triggerCount >= 2)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
    if (relevant.length === 0) return '';
    return '\n## 🔄 检测到的交互模式\n' + relevant.map(p =>
      `- ${p.description} (已出现 ${p.triggerCount} 次，置信度 ${(p.confidence * 100).toFixed(0)}%)`
    ).join('\n');
  }

  /**
   * 从错误中学习
   */
  learnFromError(
    error: string,
    context: string,
    recoveryAction?: string,
  ): LearningRecord {
    const content = recoveryAction
      ? `错误: ${error} | 修复: ${recoveryAction}`
      : `错误: ${error}`;

    // 检查是否是重复错误
    const existingId = this.findSimilarRecord(content, 'error');
    let result: LearningRecord;
    const eventBus = EventBus.getInstance();

    if (existingId) {
      const existing = this.records.get(existingId)!;
      existing.frequency++;
      existing.lastSeen = Date.now();
      existing.confidence = Math.max(0.1, existing.confidence - 0.1); // 重复错误降低置信度
      this.saveData();
      result = existing;
    } else {
      const record: LearningRecord = {
        id: `learn-err-${Date.now()}`,
        type: 'error',
        category: 'error',
        content,
        context,
        source: 'self_detection',
        confidence: 0.7,
        frequency: 1,
        lastSeen: Date.now(),
        firstSeen: Date.now(),
        applied: false,
        appliedCount: 0,
        tags: ['error', this.categorizeError(error)],
      };

      this.records.set(record.id, record);
      this.saveData();
      result = record;
    }

    eventBus.emit(Events.LEARNING_RECORDED, {
      recordId: result.id, type: 'error', category: 'error',
      confidence: result.confidence, frequency: result.frequency,
      isNew: !existingId, errorSummary: error.substring(0, 100),
    }, { source: 'self-learning-system', priority: 'normal' }).catch(() => {});

    return result;
  }

  /**
   * 学习最佳实践
   */
  learnBestPractice(
    practice: string,
    category: string,
    source: string = 'self_discovery',
  ): LearningRecord {
    const record: LearningRecord = {
      id: `learn-bp-${Date.now()}`,
      type: 'best_practice',
      category,
      content: practice,
      context: '',
      source,
      confidence: 0.8,
      frequency: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applied: false,
      appliedCount: 0,
      tags: ['best_practice', category],
    };

    this.records.set(record.id, record);
    this.addSkillExperience(category, 3);
    this.saveData();
    return record;
  }

  /**
   * 学习用户偏好
   */
  learnUserPreference(
    preference: string,
    category: string,
  ): LearningRecord {
    const record: LearningRecord = {
      id: `learn-pref-${Date.now()}`,
      type: 'user_preference',
      category,
      content: preference,
      context: '',
      source: 'user_feedback',
      confidence: 0.9, // 用户明确偏好，高置信度
      frequency: 1,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
      applied: false,
      appliedCount: 0,
      tags: ['user_preference', category],
    };

    this.records.set(record.id, record);
    this.saveData();
    return record;
  }

  // ========== 知识查询 ==========

  /**
   * 查询相关知识
   */
  queryKnowledge(query: string, limit: number = 5): KnowledgeEntry[] {
    const queryLower = query.toLowerCase();
    const queryWords = tokenize(query, { minTokenLength: 2 });

    const scored = Array.from(this.knowledge.values()).map(entry => {
      let score = 0;

      // 主题匹配
      if (entry.topic.toLowerCase().includes(queryLower)) score += 3;

      // 内容匹配
      const contentLower = entry.content.toLowerCase();
      for (const word of queryWords) {
        if (contentLower.includes(word)) score += 1;
      }

      // 标签匹配
      for (const topic of entry.relatedTopics) {
        if (queryLower.includes(topic.toLowerCase())) score += 2;
      }

      // 置信度和使用次数加权
      score += entry.confidence * 2;
      score += Math.min(entry.usageCount * 0.1, 3);

      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // 更新使用计数
    for (const { entry } of scored.slice(0, limit)) {
      entry.usageCount++;
    }

    return scored.slice(0, limit).map(s => s.entry);
  }

  /**
   * 获取相关学习记录
   */
  getRelevantLearnings(query: string, limit: number = 5): LearningRecord[] {
    const queryLower = query.toLowerCase();

    const scored = Array.from(this.records.values()).map(record => {
      let score = 0;

      // 内容匹配
      if (record.content.toLowerCase().includes(queryLower)) score += 3;

      // 分类匹配
      if (queryLower.includes(record.category)) score += 2;

      // 标签匹配（防御：tags 可能为 undefined）
      for (const tag of record.tags || []) {
        if (queryLower.includes(tag.toLowerCase())) score += 1;
      }

      // 频率和置信度加权
      score += Math.min(record.frequency * 0.5, 3);
      score += record.confidence * 2;

      // 最近使用加权
      const ageInHours = (Date.now() - record.lastSeen) / (1000 * 60 * 60);
      if (ageInHours < 1) score += 2;
      else if (ageInHours < 24) score += 1;

      return { record, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.record);
  }

  /**
   * 兼容 heartbeat 系统的学习记录查询
   */
  getLearnings(options?: { category?: string; limit?: number }): LearningRecord[] {
    const limit = options?.limit || 5;
    const category = options?.category;
    const all = Array.from(this.records.values());
    const filtered = category ? all.filter(r => r.type === category || r.category === category) : all;
    const sorted = filtered.sort((a, b) => b.lastSeen - a.lastSeen);
    return sorted.slice(0, limit);
  }

  /**
   * 获取学习上下文 - 为Agent提供学习到的知识
   */
  getLearningContext(query: string): string {
    const learnings = this.getRelevantLearnings(query, 3);
    const knowledge = this.queryKnowledge(query, 3);
    const preferences = Array.from(this.records.values())
      .filter(r => r.type === 'user_preference')
      .slice(0, 5);

    // 检测到的模式
    const patternContext = this.getPatternContext(query);

    const parts: string[] = [];

    if (learnings.length > 0) {
      parts.push('## 相关经验');
      for (const l of learnings) {
        parts.push(`- [${l.type}] ${l.content} (置信度${(l.confidence * 100).toFixed(0)}%)`);
      }
    }

    if (knowledge.length > 0) {
      parts.push('\n## 相关知识');
      for (const k of knowledge) {
        const crossTag = k.derivedFrom ? ' 🔗跨领域' : '';
        parts.push(`- ${k.topic}: ${k.content.substring(0, 100)}${crossTag}`);
      }
    }

    if (preferences.length > 0) {
      parts.push('\n## 用户偏好');
      for (const p of preferences) {
        parts.push(`- ${p.content}`);
      }
    }

    if (patternContext) {
      parts.push(patternContext);
    }

    return parts.join('\n');
  }

  // ========== 技能系统 ==========

  /**
   * 获取所有技能等级
   */
  getSkillLevels(): Array<Skill & { progress: number }> {
    return Array.from(this.skills.values()).map(skill => ({
      ...skill,
      progress: skill.experience / skill.nextLevelAt,
    }));
  }

  /**
   * 获取技能报告
   */
  getSkillReport(): string {
    const skills = this.getSkillLevels();
    const lines: string[] = ['💪 技能等级\n'];

    for (const skill of skills.sort((a, b) => b.level - a.level)) {
      const bar = '█'.repeat(skill.level) + '░'.repeat(10 - skill.level);
      const progress = (skill.progress * 100).toFixed(0);
      lines.push(`  ${skill.name}: [${bar}] Lv.${skill.level}/10 (${progress}%)`);
    }

    return lines.join('\n');
  }

  // ========== 学习报告 ==========

  /**
   * 生成学习报告
   */
  generateReport(): LearningReport {
    const records = Array.from(this.records.values());
    const totalRecords = records.length;

    // 技能统计
    const skills = Array.from(this.skills.values());
    const topSkills = skills
      .sort((a, b) => b.level - a.level)
      .slice(0, 5)
      .map(s => ({ name: s.name, level: s.level }));

    // 最近学习
    const recentLearnings = records
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 10)
      .map(r => ({ type: r.type, content: (r.content ?? '').substring(0, 80) }));

    // 知识盲区
    const knowledgeGaps = records
      .filter(r => r.type === 'knowledge_gap')
      .map(r => r.content);

    // 改进建议
    const improvementSuggestions = this.generateImprovementSuggestions();

    // 学习速度
    const recentRecords = records.filter(r => Date.now() - r.lastSeen < 24 * 60 * 60 * 1000);
    const learningVelocity = recentRecords.length;

    // 知识保留率
    const appliedRecords = records.filter(r => r.applied && r.outcome === 'positive');
    const retentionRate = records.length > 0 ? appliedRecords.length / records.length : 0;

    return {
      totalRecords,
      skillsCount: skills.length,
      knowledgeCount: this.knowledge.size,
      topSkills,
      recentLearnings,
      knowledgeGaps,
      improvementSuggestions,
      learningVelocity,
      retentionRate,
    };
  }

  /**
   * 格式化学习报告
   */
  formatReport(): string {
    const report = this.generateReport();
    const patterns = this.getPatterns();
    const lines: string[] = [
      '📚 自我学习报告\n',
      `总学习记录: ${report.totalRecords}`,
      `知识条目: ${report.knowledgeCount}`,
      `检测到模式: ${patterns.length} 个`,
      `学习速度: ${report.learningVelocity}条/天`,
      `知识保留率: ${(report.retentionRate * 100).toFixed(0)}%\n`,
    ];

    if (patterns.length > 0) {
      lines.push('🔄 检测到的交互模式:');
      for (const p of patterns.slice(0, 5)) {
        let typeIcon: string;
        if (p.patternType === 'repeated_query') typeIcon = '🔁';
        else if (p.patternType === 'similar_task') typeIcon = '📋';
        else typeIcon = '💡';
        lines.push(`  ${typeIcon} ${p.description}`);
      }
      lines.push('');
    }

    if (report.topSkills.length > 0) {
      lines.push('🏆 顶级技能:');
      for (const s of report.topSkills) {
        lines.push(`  ${s.name}: Lv.${s.level}`);
      }
    }

    if (report.recentLearnings.length > 0) {
      lines.push('\n📝 最近学习:');
      for (const l of report.recentLearnings.slice(0, 5)) {
        lines.push(`  [${l.type}] ${l.content}`);
      }
    }

    if (report.knowledgeGaps.length > 0) {
      lines.push('\n🔍 知识盲区:');
      for (const gap of report.knowledgeGaps.slice(0, 5)) {
        lines.push(`  - ${gap}`);
      }
    }

    if (report.improvementSuggestions.length > 0) {
      lines.push('\n💡 改进建议:');
      for (const s of report.improvementSuggestions) {
        lines.push(`  - ${s}`);
      }
    }

    return lines.join('\n');
  }

  // ========== 私有方法 ==========

  private initializeDefaultSkills(): void {
    const defaultSkills: Array<Omit<Skill, 'experience' | 'nextLevelAt' | 'recentPerformance' | 'learnedFrom'>> = [
      { id: 'coding', name: '代码生成', category: 'coding', level: 3 },
      { id: 'debugging', name: '调试排错', category: 'coding', level: 2 },
      { id: 'analysis', name: '深度分析', category: 'analysis', level: 2 },
      { id: 'creative', name: '创意写作', category: 'creative', level: 2 },
      { id: 'reasoning', name: '逻辑推理', category: 'reasoning', level: 3 },
      { id: 'tool_use', name: '工具调用', category: 'tool_use', level: 3 },
      { id: 'self_learning', name: '自我学习', category: 'meta', level: 2 },
      { id: 'self_repair', name: '自我修复', category: 'meta', level: 2 },
      { id: 'communication', name: '对话交流', category: 'communication', level: 3 },
    ];

    for (const skill of defaultSkills) {
      if (!this.skills.has(skill.id)) {
        this.skills.set(skill.id, {
          ...skill,
          experience: skill.level * 100,
          nextLevelAt: (skill.level + 1) * 150,
          recentPerformance: [],
          learnedFrom: [],
        });
      }
    }
  }

  private addSkillExperience(category: string, amount: number): void {
    // 找到相关技能
    const skillId = this.categoryToSkillId(category);
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.experience += amount;
    skill.recentPerformance.push(amount);
    if (skill.recentPerformance.length > 20) {
      skill.recentPerformance = skill.recentPerformance.slice(-20);
    }

    // 检查升级
    if (skill.experience >= skill.nextLevelAt && skill.level < 10) {
      skill.level++;
      skill.nextLevelAt = skill.level * 150;
    }
  }

  private categoryToSkillId(category: string): string {
    const mapping: Record<string, string> = {
      coding: 'coding',
      debug: 'debugging',
      debugging: 'debugging',
      analysis: 'analysis',
      creative: 'creative',
      reasoning: 'reasoning',
      tool_use: 'tool_use',
      communication: 'communication',
      error: 'self_repair',
      meta: 'self_learning',
    };
    return mapping[category] || 'communication';
  }

  private categorizeInput(input: string): string {
    const lower = input.toLowerCase();
    if (/代码|编程|函数|bug|调试|code|program/i.test(lower)) return 'coding';
    if (/分析|评估|比较|analyze/i.test(lower)) return 'analysis';
    if (/写|创作|设计|create|write/i.test(lower)) return 'creative';
    if (/推理|逻辑|为什么|reason|why/i.test(lower)) return 'reasoning';
    if (/搜索|执行|运行|search|execute/i.test(lower)) return 'tool_use';
    return 'communication';
  }

  private categorizeError(error: string): string {
    if (/timeout|ETIMEDOUT/i.test(error)) return 'network';
    if (/ENOENT|not found/i.test(error)) return 'file';
    if (/API|api_key|401|403/i.test(error)) return 'api';
    if (/syntax|parse|JSON/i.test(error)) return 'parsing';
    if (/memory|heap|OOM/i.test(error)) return 'memory';
    return 'unknown';
  }

  private extractLearning(input: string, response: string, feedback?: string): string {
    const shortInput = input.substring(0, 60);
    const responsePreview = response.substring(0, 80).replace(/\n/g, ' ');
    if (feedback === 'negative') return `不满意: ${shortInput} — 回应: ${responsePreview}...`;
    if (feedback === 'positive') return `成功处理: ${shortInput} → ${responsePreview}...`;
    return `交互: ${shortInput} → ${responsePreview}...`;
  }

  private extractTags(input: string): string[] {
    const tags: string[] = [];
    if (/代码|编程/i.test(input)) tags.push('coding');
    if (/分析/i.test(input)) tags.push('analysis');
    if (/写|创作/i.test(input)) tags.push('creative');
    if (/搜索/i.test(input)) tags.push('search');
    if (/文件/i.test(input)) tags.push('file');
    if (/网络|web/i.test(input)) tags.push('web');
    return tags;
  }

  private extractKnowledge(input: string, response: string, category: string): void {
    if (response.length < 100 || input.length < 5) return;
    const topic = input.substring(0, 60).replace(/[?？!！。，,\s]+$/g, '');

    const existingByTopic = Array.from(this.knowledge.values()).find(e =>
      this.computeOverlap(e.topic.toLowerCase(), topic.toLowerCase()) > 0.7
    );
    if (existingByTopic) {
      existingByTopic.content = response.substring(0, 500);
      existingByTopic.lastUpdated = Date.now();
      existingByTopic.usageCount++;
      if (existingByTopic.usageCount >= 3) existingByTopic.verified = true;
      if (existingByTopic.confidence < 0.7) existingByTopic.confidence = Math.min(0.7, existingByTopic.confidence + 0.1);
      return;
    }

    const id = `knowledge-${this.hashString(input + Date.now())}`;

    // 跨领域关联：查找与其他类别知识的相关性
    const relatedKnowledge = Array.from(this.knowledge.values())
      .filter(k => k.relatedTopics.includes(category) || k.topic.includes(category))
      .slice(0, 3)
      .map(k => k.id);

    this.knowledge.set(id, {
      id, topic,
      content: response.substring(0, 500),
      source: 'interaction',
      verified: false,
      confidence: 0.5,
      relatedTopics: [category, ...relatedKnowledge.length > 0 ? ['cross_domain'] : []],
      lastUpdated: Date.now(),
      usageCount: 1,
      derivedFrom: relatedKnowledge.length > 0 ? relatedKnowledge : undefined,
    });
  }

  /** Part G: lazy 获取嵌入器与交叉注意力对齐器（复用 smart-tool-selector 同款哈希向量） */
  private getEmbedder(): { embedder: SimpleEmbedder; align: CrossAttention } {
    if (!this.embedder) this.embedder = new SimpleEmbedder(256);
    if (!this.crossAttention) this.crossAttention = new CrossAttention();
    return { embedder: this.embedder, align: this.crossAttention };
  }

  /**
   * 查找相似记录 — Part G 升级为 embedding 余弦相似度，Jaccard 重叠兜底。
   *
   * 语义路径：用 SimpleEmbedder 将内容映射为哈希向量，CrossAttention.alignScore
   * 计算余弦相似度（与 smart-tool-selector 的 computeSemanticMatchScore 同源）。
   * 向量按 recordId 缓存，避免重复计算。
   * 兜底路径：embedder 异常时回退到原有的 Jaccard token 重叠。
   */
  private findSimilarRecord(content: string, category: string): string | null {
    const candidates: Array<{ id: string; content: string }> = [];
    for (const [id, record] of this.records) {
      if (record.category === category) candidates.push({ id, content: record.content });
    }
    if (candidates.length === 0) return null;

    // 语义路径：embedding 余弦相似度
    try {
      const { embedder, align } = this.getEmbedder();
      // 哈希嵌入的余弦相似度因共享 token 虚高（"交互:" "→" "ok..." 等公共前缀
      // 贡献相同维度），不适用于 dedup；仅在注入真实语义提供者时启用语义路径
      if (!embedder.hasSemanticProvider()) {
        throw new Error('hash-fallback embedder unsuitable for semantic dedup');
      }
      const queryVec = embedder.embed(content);
      let bestId: string | null = null;
      let bestScore = 0;
      for (const c of candidates) {
        let vec = this.recordVectorCache.get(c.id);
        if (!vec) {
          vec = embedder.embed(c.content);
          this.recordVectorCache.set(c.id, vec);
        }
        const score = align.alignScore(queryVec, vec);
        if (score > bestScore) { bestScore = score; bestId = c.id; }
      }
      // 语义阈值 0.55（真实语义提供者的余弦相似度分布）
      if (bestId && bestScore > 0.55) return bestId;
    } catch {
      // 降级到 Jaccard 重叠
    }

    // 兜底：Jaccard token 重叠
    const contentLower = content.toLowerCase();
    let bestId: string | null = null;
    let bestOverlap = 0;
    for (const c of candidates) {
      const overlap = this.computeOverlap(contentLower, c.content.toLowerCase());
      if (overlap > bestOverlap) { bestOverlap = overlap; bestId = c.id; }
    }
    return (bestId && bestOverlap > 0.6) ? bestId : null;
  }

  private computeOverlap(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  private generateImprovementSuggestions(): string[] {
    const suggestions: string[] = [];
    const records = Array.from(this.records.values());

    // 频繁错误
    const frequentErrors = records
      .filter(r => r.type === 'error' && r.frequency >= 3)
      .sort((a, b) => b.frequency - a.frequency);

    for (const err of frequentErrors.slice(0, 3)) {
      suggestions.push(`频繁错误需要修复: ${(err.content ?? '').substring(0, 60)}`);
    }

    // 低置信度领域
    const categoryConfidence: Record<string, number[]> = {};
    for (const r of records) {
      if (!categoryConfidence[r.category]) categoryConfidence[r.category] = [];
      categoryConfidence[r.category].push(r.confidence);
    }

    for (const [cat, confidences] of Object.entries(categoryConfidence)) {
      const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      if (avg < 0.5) {
        suggestions.push(`${cat}领域置信度较低(${(avg * 100).toFixed(0)}%)，需要更多练习`);
      }
    }

    // 知识盲区
    const gaps = records.filter(r => r.type === 'knowledge_gap');
    if (gaps.length > 0) {
      suggestions.push(`有${gaps.length}个知识盲区需要填补`);
    }

    return suggestions;
  }

  // ========== 持久化 ==========

  private loadData(): void {
    try {
      // 加载学习记录
      const recordsPath = path.join(this.dataPath, 'records.json');
      if (fs.existsSync(recordsPath)) {
        const data = JSON.parse(fs.readFileSync(recordsPath, 'utf-8'));
        for (const record of data) {
          // 边界校验：持久化 JSON 可能存在 schema 漂移
          // - content 缺失/非字符串：保证为字符串，避免 .substring 崩溃
          // - tags 缺失/非数组：保证为 string[]，避免 for...of 报 "record.tags is not iterable"
          if (typeof record.content !== 'string') record.content = '';
          if (!Array.isArray(record.tags)) record.tags = [];
          this.records.set(record.id, record);
        }
      }

      // 加载技能（防御：data 可能非数组、skill 可能缺 id）
      const skillsPath = path.join(this.dataPath, 'skills.json');
      if (fs.existsSync(skillsPath)) {
        const data = JSON.parse(fs.readFileSync(skillsPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const skill of data) {
            if (skill && typeof skill.id === 'string') this.skills.set(skill.id, skill);
          }
        }
      }

      // 加载知识
      const knowledgePath = path.join(this.dataPath, 'knowledge.json');
      if (fs.existsSync(knowledgePath)) {
        const data = JSON.parse(fs.readFileSync(knowledgePath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry && typeof entry.id === 'string') this.knowledge.set(entry.id, entry);
          }
        }
      }

      // 加载模式
      const patternsPath = path.join(this.dataPath, 'patterns.json');
      if (fs.existsSync(patternsPath)) {
        const data = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const pattern of data) {
            if (pattern && typeof pattern.id === 'string') this.patterns.set(pattern.id, pattern);
          }
        }
      }
    } catch {
      // 加载失败使用空数据
    }
  }

  private saveData(): void {
    this.recordVectorCache.clear(); // Part G4: 写盘前失效向量缓存，防御记录内容变更
    try {
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(this.dataPath, { recursive: true });
      }

      // 知识衰减：超过7天未使用的知识降置信度
      const now = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      for (const entry of this.knowledge.values()) {
        if (now - entry.lastUpdated > weekMs && entry.usageCount < 2) {
          entry.confidence = Math.max(0.1, entry.confidence - 0.1);
        }
      }

      // 清理：移除低置信度且旧的记录
      for (const [id, record] of this.records) {
        if (record.confidence < 0.15 && now - record.lastSeen > 30 * 24 * 60 * 60 * 1000) {
          this.records.delete(id);
        }
      }

      // 限制知识库大小
      if (this.knowledge.size > 500) {
        const sorted = Array.from(this.knowledge.entries())
          .sort(([, a], [, b]) => (a.usageCount + a.confidence) - (b.usageCount + b.confidence));
        for (const [id] of sorted.slice(0, sorted.length - 500)) {
          this.knowledge.delete(id);
        }
      }

      // 原子写：4 个学习数据文件连写，任一半写都会触发 corruption-guard 重建丢数据
      atomicWriteJsonSync(
        path.join(this.dataPath, 'records.json'),
        Array.from(this.records.values()),
      );
      atomicWriteJsonSync(
        path.join(this.dataPath, 'skills.json'),
        Array.from(this.skills.values()),
      );
      atomicWriteJsonSync(
        path.join(this.dataPath, 'knowledge.json'),
        Array.from(this.knowledge.values()),
      );
      atomicWriteJsonSync(
        path.join(this.dataPath, 'patterns.json'),
        Array.from(this.patterns.values()),
      );
    } catch {
      // 保存失败不影响运行
    }
  }
}
