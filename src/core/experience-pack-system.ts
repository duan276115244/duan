/**
 * 统一经验包系统 — ExperiencePackSystem
 *
 * 对标主流 Agent（Claude Code 的 CLAUDE.md 记忆、Cursor 的规则学习、Devin 的知识库），
 * 整合项目中 7 套碎片化经验存储：
 *   - .duan/experiences/        (self-evolution-engine)
 *   - .duan/learning/           (self-learning-system)
 *   - .duan/memories/           (memory-orchestrator)
 *   - .awareness/skills.json    (skill-extractor)
 *   - .duan/generated-skills/   (skill-generator)
 *   - .duan/meta-learning/      (meta-learning)
 *   - reflection-engine SOPs    (reflection-engine)
 *
 * 核心能力：
 * 1. 统一经验包格式 — ExperiencePack 标准结构
 * 2. 自动总结 — 任务完成后自动提取经验包（规则提取，不依赖 LLM）
 * 3. 经验匹配 — 新任务来时匹配历史经验（TF-IDF + 关键词 + 语义）
 * 4. 经验复用 — 命中经验时直接返回执行路径，不消耗 token
 * 5. 质量评估 — 经验包质量评分 + 淘汰机制
 * 6. 导入/导出 — 经验包跨项目迁移
 * 7. 闭环验证 — 追踪经验复用后的效果，反哺质量评分
 *
 * 复用：
 * - neural-network.ts（本地匹配）
 * - memory-orchestrator.ts（持久化后端）
 * - reflection-engine.ts（SOP 提取）
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 统一经验包格式 ============

export interface ExperiencePack {
  /** 唯一 ID */
  id: string;
  /** 经验包名称（自动生成或用户命名） */
  name: string;
  /** 原始任务描述 */
  task: string;
  /** 任务分类 */
  category: string;
  /** 任务标签 */
  tags: string[];
  /** 执行步骤（结构化，可直接复用） */
  steps: ExperienceStep[];
  /** 使用的工具序列 */
  toolsUsed: string[];
  /** 最终结果 */
  result: string;
  /** 是否成功 */
  success: boolean;
  /** 经验教训（结构化） */
  lessons: ExperienceLesson[];
  /** 适用场景描述 */
  applicableScenarios: string[];
  /** 前置条件 */
  preconditions: string[];
  /** 预期效果 */
  expectedOutcome: string;
  /** 质量评分（0-100，基于成功率、复用次数、用户反馈） */
  qualityScore: number;
  /** 复用次数 */
  reuseCount: number;
  /** 复用成功次数 */
  reuseSuccessCount: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后使用时间 */
  lastUsedAt: number;
  /** 来源（哪个系统提取的） */
  source: 'auto' | 'reflection' | 'skill-extractor' | 'skill-generator' | 'manual' | 'imported';
  /** TF-IDF 关键词向量（用于匹配） */
  keywordVector?: Map<string, number>;
  /** 版本号（经验演化追踪） */
  version: number;
  /** 父经验 ID（版本演化时指向上一版） */
  parentExperienceId?: string;
}

export interface ExperienceStep {
  /** 步骤序号 */
  order: number;
  /** 步骤描述 */
  description: string;
  /** 使用的工具 */
  tool?: string;
  /** 工具参数 */
  toolParams?: Record<string, unknown>;
  /** 预期结果 */
  expectedOutcome: string;
  /** 备选方案 */
  alternativeAction?: string;
  /** 实际执行耗时（ms） */
  actualDurationMs?: number;
}

export interface ExperienceLesson {
  /** 教训内容 */
  content: string;
  /** 教训类型 */
  type: 'success_factor' | 'pitfall' | 'optimization' | 'precondition';
  /** 置信度（0-1） */
  confidence: number;
}

export interface ExperienceMatchResult {
  /** 匹配的经验包 */
  experience: ExperiencePack;
  /** 匹配分数（0-1） */
  score: number;
  /** 匹配原因 */
  reason: string;
  /** 是否可直接复用（score > 0.8） */
  canReuseDirectly: boolean;
}

export interface ExperienceStats {
  total: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  avgQuality: number;
  totalReuses: number;
  reuseSuccessRate: number;
  topExperiences: ExperiencePack[];
}

// ============ TF-IDF 向量化器 ============

class TfidfVectorizer {
  private vocabulary: Map<string, number> = new Map(); // 词 -> 文档频率
  private documentCount = 0;
  private readonly stopWords: Set<string>;

  constructor() {
    // 中英文停用词
    this.stopWords = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'as', 'by', 'at', 'from', 'up', 'about', 'into', 'through', 'during',
    ]);
  }

  /** 中文分词（简易：二元组 + 单字） */
  tokenize(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();

    // 英文单词
    const englishWords = lower.match(/[a-z]+/g) || [];
    tokens.push(...englishWords.filter(w => w.length > 1 && !this.stopWords.has(w)));

    // 中文二元组
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    for (let i = 0; i < chineseChars.length - 1; i++) {
      const bigram = chineseChars[i] + chineseChars[i + 1];
      if (!this.stopWords.has(chineseChars[i]) && !this.stopWords.has(chineseChars[i + 1])) {
        tokens.push(bigram);
      }
    }
    // 中文单字（权重较低）
    for (const c of chineseChars) {
      if (!this.stopWords.has(c) && c.length === 1) {
        tokens.push(c);
      }
    }

    return tokens;
  }

  /** 计算 TF-IDF 向量 */
  vectorize(text: string): Map<string, number> {
    const tokens = this.tokenize(text);
    const tf: Map<string, number> = new Map();

    // 词频
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // TF-IDF
    const vector: Map<string, number> = new Map();
    for (const [token, freq] of tf) {
      const df = this.vocabulary.get(token) || 1;
      const idf = Math.log((this.documentCount + 1) / (df + 1)) + 1;
      const tfidf = (freq / tokens.length) * idf;
      vector.set(token, tfidf);
    }

    return vector;
  }

  /** 添加文档到语料库（更新 DF） */
  addDocument(text: string): void {
    this.documentCount++;
    const tokens = new Set(this.tokenize(text));
    for (const token of tokens) {
      this.vocabulary.set(token, (this.vocabulary.get(token) || 0) + 1);
    }
  }

  /** 计算两个向量的余弦相似度 */
  cosineSimilarity(v1: Map<string, number>, v2: Map<string, number>): number {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (const [key, val] of v1) {
      norm1 += val * val;
      if (v2.has(key)) {
        dotProduct += val * v2.get(key)!;
      }
    }
    for (const val of v2.values()) {
      norm2 += val * val;
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }
}

// ============ 统一经验包系统 ============

export class ExperiencePackSystem extends EventEmitter {
  private experiences: Map<string, ExperiencePack> = new Map();
  private vectorizer: TfidfVectorizer;
  private storeDir: string;
  private indexFile: string;
  private categoryIndex: Map<string, Set<string>> = new Map();
  private tagIndex: Map<string, Set<string>> = new Map();
  private toolIndex: Map<string, Set<string>> = new Map();
  private readonly maxExperiences = 1000;
  private readonly reuseThreshold = 0.75; // 直接复用阈值
  private readonly matchThreshold = 0.4;  // 匹配阈值

  constructor(storeDir?: string) {
    super();
    this.storeDir = storeDir || duanPath('experience-packs');
    this.indexFile = path.join(this.storeDir, 'index.json');
    this.vectorizer = new TfidfVectorizer();
    fs.mkdirSync(this.storeDir, { recursive: true });
    this.load();
  }

  // ========== 1. 自动总结 ==========

  /**
   * 从任务执行路径自动提取经验包（不依赖 LLM）
   * 在任务完成后调用
   */
  autoExtractFromExecution(executionPath: {
    task: string;
    steps: Array<{
      description: string;
      tool?: string;
      toolParams?: Record<string, unknown>;
      result?: string;
      success?: boolean;
      durationMs?: number;
    }>;
    finalResult: string;
    success: boolean;
    durationMs: number;
  }): ExperiencePack {
    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const category = this.inferCategory(executionPath.task, executionPath.steps.map(s => s.tool).filter(Boolean) as string[]);

    // 结构化步骤
    const steps: ExperienceStep[] = executionPath.steps.map((s, i) => ({
      order: i + 1,
      description: s.description,
      tool: s.tool,
      toolParams: s.toolParams,
      expectedOutcome: s.result || '',
      actualDurationMs: s.durationMs,
    }));

    // 自动提取教训（规则，不依赖 LLM）
    const lessons = this.extractLessonsByRules(executionPath);

    // 推断适用场景
    const applicableScenarios = this.inferScenarios(executionPath.task, category);

    // 推断前置条件
    const preconditions = this.inferPreconditions(executionPath.steps);

    const pack: ExperiencePack = {
      id,
      name: this.generateName(executionPath.task, category),
      task: executionPath.task,
      category,
      tags: this.extractTags(executionPath.task),
      steps,
      toolsUsed: executionPath.steps.map(s => s.tool).filter(Boolean) as string[],
      result: executionPath.finalResult,
      success: executionPath.success,
      lessons,
      applicableScenarios,
      preconditions,
      expectedOutcome: executionPath.success ? '任务成功完成' : '任务执行失败',
      qualityScore: executionPath.success ? 60 : 20, // 初始分
      reuseCount: 0,
      reuseSuccessCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      source: 'auto',
      version: 1,
    };

    // 计算 TF-IDF 向量
    pack.keywordVector = this.vectorizer.vectorize(`${pack.task} ${pack.tags.join(' ')} ${pack.applicableScenarios.join(' ')}`);

    // 添加到语料库
    this.vectorizer.addDocument(`${pack.task} ${pack.tags.join(' ')} ${pack.applicableScenarios.join(' ')}`);

    // 检查是否与已有经验重复
    const similar = this.findSimilar(pack.task, 0.85);
    if (similar.length > 0) {
      // 合并到相似经验（版本升级）
      const existing = similar[0].experience;
      this.mergeExperience(existing, pack);
      logger.info('经验包合并到已有经验', {
        module: 'ExperiencePackSystem',
        existingId: existing.id,
        newVersion: existing.version,
      });
      return existing;
    }

    // 存储新经验
    this.store(pack);
    logger.info('经验包已提取', {
      module: 'ExperiencePackSystem',
      id,
      category,
      steps: steps.length,
      tools: pack.toolsUsed.length,
      success: pack.success,
    });

    this.emit('experienceExtracted', pack);
    return pack;
  }

  // ========== 2. 经验匹配 ==========

  /**
   * 匹配历史经验（新任务来时调用）
   * 返回按分数排序的匹配结果
   */
  match(task: string, limit: number = 5): ExperienceMatchResult[] {
    const queryVector = this.vectorizer.vectorize(task);
    const results: ExperienceMatchResult[] = [];

    for (const exp of this.experiences.values()) {
      if (!exp.success && exp.qualityScore < 30) continue; // 跳过低质量失败经验

      const score = this.computeMatchScore(task, queryVector, exp);
      if (score >= this.matchThreshold) {
        results.push({
          experience: exp,
          score,
          reason: this.generateMatchReason(score, exp),
          canReuseDirectly: score >= this.reuseThreshold,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 查找相似经验（用于去重）
   */
  findSimilar(task: string, threshold: number = 0.85): ExperienceMatchResult[] {
    const queryVector = this.vectorizer.vectorize(task);
    const results: ExperienceMatchResult[] = [];

    for (const exp of this.experiences.values()) {
      const score = this.computeMatchScore(task, queryVector, exp);
      if (score >= threshold) {
        results.push({
          experience: exp,
          score,
          reason: '高相似度匹配',
          canReuseDirectly: true,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * 获取可直接复用的经验（score > 阈值）
   * 返回 null 表示无匹配，需要正常执行
   */
  getReusableExperience(task: string): ExperiencePack | null {
    const matches = this.match(task, 1);
    if (matches.length > 0 && matches[0].canReuseDirectly) {
      const exp = matches[0].experience;
      logger.info('命中可复用经验，跳过 LLM 调用', {
        module: 'ExperiencePackSystem',
        experienceId: exp.id,
        score: matches[0].score,
        reuseCount: exp.reuseCount + 1,
      });
      return exp;
    }
    return null;
  }

  // ========== 3. 经验复用效果追踪（闭环验证） ==========

  /**
   * 记录经验复用结果（闭环验证）
   * 复用成功 → 提升质量分；复用失败 → 降低质量分
   */
  recordReuseOutcome(experienceId: string, success: boolean, _durationMs?: number): void {
    const exp = this.experiences.get(experienceId);
    if (!exp) return;

    exp.reuseCount++;
    if (success) {
      exp.reuseSuccessCount++;
      exp.qualityScore = Math.min(100, exp.qualityScore + 5);
    } else {
      exp.qualityScore = Math.max(0, exp.qualityScore - 10);
    }
    exp.lastUsedAt = Date.now();

    // 如果复用失败次数过多，降低版本可信度
    if (exp.reuseCount > 3 && exp.reuseSuccessCount / exp.reuseCount < 0.3) {
      exp.qualityScore = Math.max(0, exp.qualityScore - 20);
      logger.warn('经验包复用成功率低，已降级', {
        module: 'ExperiencePackSystem',
        experienceId,
        successRate: exp.reuseSuccessCount / exp.reuseCount,
      });
    }

    this.persist(exp);
    this.emit('reuseOutcomeRecorded', { experienceId, success, qualityScore: exp.qualityScore });
  }

  // ========== 4. 质量评估与淘汰 ==========

  /**
   * 评估所有经验包质量并淘汰低质量经验
   */
  evaluateAndEvict(): { evaluated: number; evicted: number } {
    let evicted = 0;
    const now = Date.now();

    for (const [id, exp] of this.experiences) {
      // 时间衰减：30 天未使用降分
      const daysSinceUse = (now - exp.lastUsedAt) / (1000 * 60 * 60 * 24);
      if (daysSinceUse > 30) {
        exp.qualityScore = Math.max(0, exp.qualityScore - Math.floor(daysSinceUse / 30) * 5);
      }

      // 淘汰条件：质量分 < 10 或 复用成功率 < 20%（至少复用 5 次）
      const reuseRate = exp.reuseCount > 0 ? exp.reuseSuccessCount / exp.reuseCount : 1;
      if (exp.qualityScore < 10 || (exp.reuseCount >= 5 && reuseRate < 0.2)) {
        this.experiences.delete(id);
        this.removeFromIndex(exp);
        evicted++;
        logger.info('淘汰低质量经验包', {
          module: 'ExperiencePackSystem',
          id,
          qualityScore: exp.qualityScore,
          reuseRate,
        });
      }
    }

    // 容量限制
    if (this.experiences.size > this.maxExperiences) {
      const sorted = Array.from(this.experiences.values())
        .sort((a, b) => a.qualityScore - b.qualityScore);
      const toRemove = sorted.slice(0, this.experiences.size - this.maxExperiences);
      for (const exp of toRemove) {
        this.experiences.delete(exp.id);
        this.removeFromIndex(exp);
        evicted++;
      }
    }

    this.save();
    return { evaluated: this.experiences.size, evicted };
  }

  // ========== 5. 导入/导出 ==========

  /**
   * 导出经验包（跨项目迁移）
   */
  exportExperiences(filter?: { category?: string; minQuality?: number }): string {
    let experiences = Array.from(this.experiences.values());
    if (filter) {
      if (filter.category) experiences = experiences.filter(e => e.category === filter.category);
      if (filter.minQuality !== undefined) experiences = experiences.filter(e => e.qualityScore >= filter.minQuality!);
    }

    const exportData = {
      version: '1.0.0',
      exportedAt: Date.now(),
      count: experiences.length,
      experiences: experiences.map(e => ({
        ...e,
        keywordVector: undefined, // 导出时不包含内部向量
      })),
    };

    const exportPath = path.join(this.storeDir, `export_${Date.now()}.json`);
    atomicWriteJsonSync(exportPath, exportData);
    logger.info('经验包已导出', { module: 'ExperiencePackSystem', count: experiences.length, path: exportPath });
    return exportPath;
  }

  /**
   * 导入经验包
   *
   * 修复：原实现直接 `JSON.parse(fs.readFileSync(...))` 无 try/catch 包裹，
   * 畸形 JSON 会让异常冒泡到调用方进程级；且未校验 data 形状（非对象/缺 experiences 字段）。
   * 现增加边界校验，畸形文件返回 0 导入并附带错误信息，不抛错。
   */
  importExperiences(filePath: string): { imported: number; skipped: number; error?: string } {
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: { experiences?: any[] };
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      const errorMsg = `经验包 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn('经验包导入失败', { module: 'ExperiencePackSystem', path: filePath, error: errorMsg });
      return { imported: 0, skipped: 0, error: errorMsg };
    }

    // 边界校验：data 必须是对象且 experiences 必须是数组（缺字段视为空数组）
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const errorMsg = '经验包文件结构非法（应为对象含 experiences 数组）';
      logger.warn('经验包结构非法', { module: 'ExperiencePackSystem', path: filePath, error: errorMsg });
      return { imported: 0, skipped: 0, error: errorMsg };
    }

    const experiences = Array.isArray(data.experiences) ? data.experiences : [];
    let imported = 0;
    let skipped = 0;

    for (const exp of experiences) {
      // 边界校验：单条经验必须含必要字段，缺失则跳过
      if (!exp || typeof exp !== 'object' || !exp.task) {
        skipped++;
        continue;
      }

      // 检查是否已存在
      if (this.experiences.has(exp.id)) {
        skipped++;
        continue;
      }

      // 重新计算向量（tags/applicableScenarios 缺失时降级为空数组）
      const tags = Array.isArray(exp.tags) ? exp.tags : [];
      const applicableScenarios = Array.isArray(exp.applicableScenarios) ? exp.applicableScenarios : [];
      exp.keywordVector = this.vectorizer.vectorize(`${exp.task} ${tags.join(' ')} ${applicableScenarios.join(' ')}`);
      this.vectorizer.addDocument(`${exp.task} ${tags.join(' ')} ${applicableScenarios.join(' ')}`);
      exp.source = 'imported';
      exp.id = `exp_imported_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      this.store(exp);
      imported++;
    }

    this.save();
    logger.info('经验包已导入', { module: 'ExperiencePackSystem', imported, skipped });
    return { imported, skipped };
  }

  // ========== 6. 查询接口 ==========

  /**
   * 获取统计信息
   */
  getStats(): ExperienceStats {
    const experiences = Array.from(this.experiences.values());
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let totalQuality = 0;
    let totalReuses = 0;
    let totalReuseSuccesses = 0;

    for (const exp of experiences) {
      byCategory[exp.category] = (byCategory[exp.category] || 0) + 1;
      bySource[exp.source] = (bySource[exp.source] || 0) + 1;
      totalQuality += exp.qualityScore;
      totalReuses += exp.reuseCount;
      totalReuseSuccesses += exp.reuseSuccessCount;
    }

    return {
      total: experiences.length,
      byCategory,
      bySource,
      avgQuality: experiences.length > 0 ? totalQuality / experiences.length : 0,
      totalReuses,
      reuseSuccessRate: totalReuses > 0 ? totalReuseSuccesses / totalReuses : 0,
      topExperiences: experiences
        .sort((a, b) => b.qualityScore - a.qualityScore)
        .slice(0, 10),
    };
  }

  /**
   * 按分类获取经验
   */
  getByCategory(category: string): ExperiencePack[] {
    const ids = this.categoryIndex.get(category);
    if (!ids) return [];
    return Array.from(ids).map(id => this.experiences.get(id)).filter((e): e is ExperiencePack => !!e);
  }

  /**
   * 候选预筛选：基于 categoryIndex/tagIndex/toolIndex 收敛候选集合，
   * 避免 match()/findSimilar() 每次对全部经验做 O(n) 余弦相似度计算。
   * match()/findSimilar() 应优先调用本方法获取候选，再仅对候选做向量相似度计算。
   *
   * 说明：当未提供任何过滤条件、或索引命中为空时，回退到全集以保证不漏召回。
   */
  private getCandidates(opts?: { category?: string; tags?: string[]; tools?: string[] }): ExperiencePack[] {
    const hasFilter = !!opts && (!!opts.category || !!opts.tags?.length || !!opts.tools?.length);
    if (!hasFilter) {
      return Array.from(this.experiences.values());
    }

    const ids = new Set<string>();
    if (opts!.category) {
      const set = this.categoryIndex.get(opts!.category);
      if (set) for (const id of set) ids.add(id);
    }
    if (opts!.tags) {
      for (const tag of opts!.tags) {
        const set = this.tagIndex.get(tag);
        if (set) for (const id of set) ids.add(id);
      }
    }
    if (opts!.tools) {
      for (const tool of opts!.tools) {
        const set = this.toolIndex.get(tool);
        if (set) for (const id of set) ids.add(id);
      }
    }

    // 候选为空时回退到全集，避免索引未命中导致漏召回
    if (ids.size === 0) {
      return Array.from(this.experiences.values());
    }

    return Array.from(ids)
      .map(id => this.experiences.get(id))
      .filter((e): e is ExperiencePack => !!e);
  }


  /**
   * 按标签获取经验
   */
  getByTag(tag: string): ExperiencePack[] {
    const ids = this.tagIndex.get(tag);
    if (!ids) return [];
    return Array.from(ids).map(id => this.experiences.get(id)).filter((e): e is ExperiencePack => !!e);
  }

  /**
   * 获取所有经验
   */
  getAll(): ExperiencePack[] {
    return Array.from(this.experiences.values());
  }

  /**
   * 获取单个经验
   */
  get(id: string): ExperiencePack | undefined {
    return this.experiences.get(id);
  }

  /**
   * 手动添加经验
   */
  add(pack: Omit<ExperiencePack, 'id' | 'createdAt' | 'lastUsedAt' | 'reuseCount' | 'reuseSuccessCount' | 'qualityScore' | 'version' | 'keywordVector'>): string {
    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fullPack: ExperiencePack = {
      ...pack,
      id,
      qualityScore: 50,
      reuseCount: 0,
      reuseSuccessCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      source: pack.source || 'manual',
      version: 1,
    };
    fullPack.keywordVector = this.vectorizer.vectorize(`${fullPack.task} ${fullPack.tags.join(' ')} ${fullPack.applicableScenarios.join(' ')}`);
    this.vectorizer.addDocument(`${fullPack.task} ${fullPack.tags.join(' ')} ${fullPack.applicableScenarios.join(' ')}`);
    this.store(fullPack);
    return id;
  }

  /**
   * 删除经验
   */
  remove(id: string): boolean {
    const exp = this.experiences.get(id);
    if (!exp) return false;
    this.experiences.delete(id);
    this.removeFromIndex(exp);
    this.save();
    return true;
  }

  // ========== 内部方法 ==========

  /** 计算匹配分数（TF-IDF 语义 + 关键词 + 分类 + 工具） */
  private computeMatchScore(task: string, queryVector: Map<string, number>, exp: ExperiencePack): number {
    // 1. TF-IDF 语义相似度（权重 0.5）
    const semanticScore = exp.keywordVector
      ? this.vectorizer.cosineSimilarity(queryVector, exp.keywordVector)
      : 0;

    // 2. 关键词重叠（权重 0.2）
    const taskTokens = new Set(this.vectorizer.tokenize(task));
    const expTokens = new Set(this.vectorizer.tokenize(`${exp.task} ${exp.tags.join(' ')}`));
    let overlap = 0;
    for (const t of taskTokens) {
      if (expTokens.has(t)) overlap++;
    }
    const keywordScore = taskTokens.size > 0 ? overlap / taskTokens.size : 0;

    // 3. 分类匹配（权重 0.15）
    const categoryScore = this.inferCategory(task, []) === exp.category ? 1 : 0;

    // 4. 质量加权（权重 0.15）
    const qualityScore = exp.qualityScore / 100;

    const totalScore = semanticScore * 0.5 + keywordScore * 0.2 + categoryScore * 0.15 + qualityScore * 0.15;

    return totalScore;
  }

  /** 规则提取教训（不依赖 LLM） */
  private extractLessonsByRules(executionPath: {
    task: string;
    steps: Array<{ description: string; tool?: string; result?: string; success?: boolean; durationMs?: number }>;
    finalResult: string;
    success: boolean;
    durationMs: number;
  }): ExperienceLesson[] {
    const lessons: ExperienceLesson[] = [];

    if (executionPath.success) {
      // 成功因素
      const successfulTools = executionPath.steps.filter(s => s.success && s.tool).map(s => s.tool!);
      if (successfulTools.length > 0) {
        lessons.push({
          content: `成功使用工具序列: ${successfulTools.join(' → ')}`,
          type: 'success_factor',
          confidence: 0.8,
        });
      }

      // 耗时优化建议
      const slowSteps = executionPath.steps.filter(s => s.durationMs && s.durationMs > 5000);
      for (const step of slowSteps) {
        lessons.push({
          content: `步骤"${step.description}"耗时较长(${(step.durationMs! / 1000).toFixed(1)}s)，可考虑优化或并行化`,
          type: 'optimization',
          confidence: 0.6,
        });
      }

      // 关键步骤
      const keySteps = executionPath.steps.filter(s => s.tool && s.success).slice(0, 3);
      for (const step of keySteps) {
        lessons.push({
          content: `关键步骤: ${step.description}（使用 ${step.tool}）`,
          type: 'success_factor',
          confidence: 0.7,
        });
      }
    } else {
      // 失败教训
      const failedSteps = executionPath.steps.filter(s => s.success === false);
      for (const step of failedSteps) {
        lessons.push({
          content: `步骤"${step.description}"失败${step.result ? `: ${step.result}` : ''}，下次应${step.tool ? '更换工具或' : ''}调整参数`,
          type: 'pitfall',
          confidence: 0.7,
        });
      }

      if (failedSteps.length === 0 && !executionPath.success) {
        lessons.push({
          content: '任务整体失败，建议分解为更小步骤或寻求用户澄清',
          type: 'pitfall',
          confidence: 0.6,
        });
      }
    }

    // 前置条件
    if (executionPath.steps.some(s => s.tool && s.tool.includes('file'))) {
      lessons.push({
        content: '涉及文件操作，需确认文件存在且有读写权限',
        type: 'precondition',
        confidence: 0.5,
      });
    }

    return lessons;
  }

  /** 推断分类 */
  private inferCategory(task: string, tools: string[]): string {
    const taskLower = task.toLowerCase();
    const categoryKeywords: Record<string, string[]> = {
      development: ['代码', '函数', 'bug', '重构', '编译', 'code', 'function', 'class', 'debug'],
      research: ['研究', '调研', '论文', '搜索', 'research', 'search', 'investigate'],
      analysis: ['分析', '统计', '图表', '数据', 'analyze', 'statistics', 'chart'],
      configuration: ['配置', '设置', '安装', '部署', 'config', 'setup', 'install', 'deploy'],
      writing: ['写作', '文档', '文章', 'write', 'document', 'article'],
      testing: ['测试', '验证', 'test', 'verify', 'validate'],
      devops: ['docker', 'k8s', 'ci/cd', '部署', '容器', 'deploy', 'container'],
    };

    for (const [cat, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some(k => taskLower.includes(k.toLowerCase()))) return cat;
    }

    // 基于工具推断
    if (tools.some(t => t.includes('file') || t.includes('edit'))) return 'development';
    if (tools.some(t => t.includes('search') || t.includes('web'))) return 'research';
    if (tools.some(t => t.includes('test'))) return 'testing';

    return 'general';
  }

  /** 推断适用场景 */
  private inferScenarios(task: string, category: string): string[] {
    const scenarios: string[] = [];
    scenarios.push(`类似${category}任务`);
    if (task.length > 50) scenarios.push('复杂多步骤任务');
    if (task.includes('修复') || task.includes('fix')) scenarios.push('问题修复场景');
    if (task.includes('创建') || task.includes('create')) scenarios.push('创建类任务');
    if (task.includes('分析') || task.includes('analyze')) scenarios.push('分析类任务');
    return scenarios;
  }

  /** 推断前置条件 */
  private inferPreconditions(steps: Array<{ tool?: string }>): string[] {
    const preconditions: string[] = [];
    const tools = new Set(steps.map(s => s.tool).filter(Boolean) as string[]);

    if (tools.has('file_read') || tools.has('file_write') || tools.has('edit')) {
      preconditions.push('目标文件存在且有权限');
    }
    if (tools.has('web_search') || tools.has('web_fetch')) {
      preconditions.push('网络连接可用');
    }
    if (tools.has('run_command')) {
      preconditions.push('命令行工具可用');
    }
    return preconditions;
  }

  /** 提取标签 */
  private extractTags(task: string): string[] {
    const tags: string[] = [];
    const tagPatterns: Array<{ pattern: RegExp; tag: string }> = [
      { pattern: /代码|code|function|class/i, tag: 'coding' },
      { pattern: /bug|错误|fix|修复/i, tag: 'debugging' },
      { pattern: /测试|test/i, tag: 'testing' },
      { pattern: /文档|doc|document/i, tag: 'documentation' },
      { pattern: /部署|deploy|docker|k8s/i, tag: 'devops' },
      { pattern: /分析|analyze|data/i, tag: 'analysis' },
      { pattern: /搜索|search|research/i, tag: 'research' },
      { pattern: /重构|refactor/i, tag: 'refactoring' },
      { pattern: /优化|optimize|performance/i, tag: 'optimization' },
    ];

    for (const { pattern, tag } of tagPatterns) {
      if (pattern.test(task) && !tags.includes(tag)) {
        tags.push(tag);
      }
    }
    return tags;
  }

  /** 生成经验名称 */
  private generateName(task: string, category: string): string {
    const shortTask = task.length > 30 ? task.substring(0, 30) + '...' : task;
    return `[${category}] ${shortTask}`;
  }

  /** 生成匹配原因 */
  private generateMatchReason(score: number, exp: ExperiencePack): string {
    if (score >= 0.9) return `高度匹配（${exp.category}）：${exp.name}`;
    if (score >= 0.75) return `强匹配（${exp.category}）：${exp.name}`;
    if (score >= 0.5) return `部分匹配（${exp.category}）：${exp.name}`;
    return `弱匹配（${exp.category}）：${exp.name}`;
  }

  /** 合并经验（版本升级） */
  private mergeExperience(existing: ExperiencePack, newPack: ExperiencePack): void {
    existing.version++;
    existing.reuseCount++;
    if (newPack.success) {
      existing.reuseSuccessCount++;
      existing.qualityScore = Math.min(100, existing.qualityScore + 3);
    }
    existing.lastUsedAt = Date.now();

    // 合并教训（去重）
    for (const lesson of newPack.lessons) {
      if (!existing.lessons.some(l => l.content === lesson.content)) {
        existing.lessons.push(lesson);
      }
    }

    // 合并步骤（如果新步骤更优）
    if (newPack.steps.length > existing.steps.length && newPack.success) {
      existing.steps = newPack.steps;
      existing.toolsUsed = newPack.toolsUsed;
    }

    this.persist(existing);
  }

  /** 存储经验包（内存 + 索引） */
  private store(pack: ExperiencePack): void {
    this.experiences.set(pack.id, pack);
    this.addToIndex(pack);
    this.persist(pack);
    this.save();
  }

  /** 持久化单个经验包到文件 */
  private persist(pack: ExperiencePack): void {
    const filePath = path.join(this.storeDir, `${pack.id}.json`);
    try {
      const data = { ...pack, keywordVector: undefined }; // 不持久化向量
      atomicWriteJsonSync(filePath, data);
    } catch (err) {
      logger.error('经验包持久化失败', { module: 'ExperiencePackSystem', id: pack.id, error: String(err) });
    }
  }

  /** 添加到索引 */
  private addToIndex(pack: ExperiencePack): void {
    if (!this.categoryIndex.has(pack.category)) {
      this.categoryIndex.set(pack.category, new Set());
    }
    this.categoryIndex.get(pack.category)!.add(pack.id);

    for (const tag of pack.tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(pack.id);
    }

    for (const tool of pack.toolsUsed) {
      if (!this.toolIndex.has(tool)) {
        this.toolIndex.set(tool, new Set());
      }
      this.toolIndex.get(tool)!.add(pack.id);
    }
  }

  /** 从索引移除 */
  private removeFromIndex(pack: ExperiencePack): void {
    this.categoryIndex.get(pack.category)?.delete(pack.id);
    for (const tag of pack.tags) {
      this.tagIndex.get(tag)?.delete(pack.id);
    }
    for (const tool of pack.toolsUsed) {
      this.toolIndex.get(tool)?.delete(pack.id);
    }
  }

  /** 保存索引 */
  private save(): void {
    const index = {
      version: '1.0.0',
      savedAt: Date.now(),
      count: this.experiences.size,
      ids: Array.from(this.experiences.keys()),
    };
    try {
      atomicWriteJsonSync(this.indexFile, index);
    } catch (err) {
      logger.error('索引保存失败', { module: 'ExperiencePackSystem', error: String(err) });
    }
  }

  /** 加载所有经验包 */
  private load(): void {
    if (!fs.existsSync(this.indexFile)) return;

    try {
      const files = fs.readdirSync(this.storeDir).filter(f => f.startsWith('exp_') && f.endsWith('.json'));
      let loaded = 0;

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.storeDir, file), 'utf-8'));
          // 重新计算向量
          data.keywordVector = this.vectorizer.vectorize(`${data.task} ${data.tags.join(' ')} ${data.applicableScenarios.join(' ')}`);
          this.vectorizer.addDocument(`${data.task} ${data.tags.join(' ')} ${data.applicableScenarios.join(' ')}`);
          this.experiences.set(data.id, data);
          this.addToIndex(data);
          loaded++;
        } catch {}
      }

      logger.info('经验包已加载', { module: 'ExperiencePackSystem', count: loaded });
    } catch (err) {
      logger.warn('经验包加载失败', { module: 'ExperiencePackSystem', error: String(err) });
    }
  }
}
