/**
 * 主动记忆注入引擎 — ProactiveMemoryInjector
 *
 * 核心理念：记忆不应被动等待查询，而应在关键决策点主动注入。
 *
 * 注入时机：
 * 1. 规划阶段：注入相似任务的历史经验和教训
 * 2. 工具选择阶段：注入用户工具偏好和历史失败教训
 * 3. 输出生成阶段：注入用户风格偏好（简洁/详细/图表/文字）
 * 4. 错误发生时：注入历史相似错误的修复方案
 *
 * Hermes 三级记忆架构集成：
 * - L0 会话级：注入当前对话上下文相关记忆
 * - L1 持久级：注入用户偏好与项目知识（90天有效期）
 * - L2 技能级：注入可复用 SOP 与历史解决方案
 *
 * 对标：Devin的"主动写笔记外部化状态" + Manus的"任务理解阶段注入用户偏好"
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { tokenize } from './chinese-tokenizer.js';
import { duanPath } from './duan-paths.js';
import { HermesMemoryTier } from './memory-types.js';

// HermesMemoryTier 已迁至 ./memory-types.ts（单一来源）

export interface ProactiveMemoryContext {
  /** 当前用户输入 */
  userInput: string;
  /** 任务意图 */
  intent?: string;
  /** 当前规划阶段 */
  phase: 'planning' | 'tool_selection' | 'execution' | 'output' | 'error_recovery';
  /** 当前计划步骤（如果有） */
  currentStep?: string;
  /** 正在考虑的工具（如果有） */
  candidateTools?: string[];
  /** 最近错误信息（如果有） */
  recentError?: string;
  /** Hermes：指定注入的层级（可选，默认全层级） */
  tier?: HermesMemoryTier;
  /** Hermes：用户ID（用于偏好注入） */
  userId?: string;
}

export interface InjectedMemory {
  /** 注入来源 */
  source: 'experience' | 'user_preference' | 'tool_lesson' | 'error_history' | 'skill_pattern';
  /** 注入内容 */
  content: string;
  /** 相关度 0-1 */
  relevance: number;
  /** 注入原因 */
  reason: string;
  /** Hermes：记忆层级 */
  tier?: HermesMemoryTier;
  /** Hermes：置信度（仅偏好类注入） */
  confidence?: number;
}

export class ProactiveMemoryInjector {
  private memoryDir: string;
  private experiencesDir: string;
  private learningDir: string;
  private userProfilePath: string;
  private toolLessonsPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private userProfileCache: any = null;
  private userProfileCacheTime: number = 0;
  private static readonly CACHE_TTL = 60_000; // 1分钟缓存

  /** Hermes：经验记忆缓存 + 关键词索引，加速 ≤100ms 注入 */
  private experiencesCache: Array<{ content: string; tags: string[]; timestamp: number; relevance: number }> | null = null;
  private experiencesIndex: Map<string, Set<number>> = new Map();
  private experiencesCacheTime: number = 0;
  private static readonly EXPERIENCES_CACHE_TTL = 30_000; // 30秒缓存

  /** Hermes：重要性衰减半衰期（30 天） */
  private readonly DECAY_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(baseDir?: string) {
    // P0 D2 修复：baseDir 为空时走 duanPath()（全局 ~/.duan），而非 process.cwd()/.duan
    const dir = baseDir;
    this.memoryDir = dir ? path.join(dir, '.duan', 'memories') : duanPath('memories');
    this.experiencesDir = dir ? path.join(dir, '.duan', 'experiences') : duanPath('experiences');
    this.learningDir = dir ? path.join(dir, '.duan', 'learning') : duanPath('learning');
    this.userProfilePath = dir ? path.join(dir, '.learnings', 'USER_PROFILE.json') : duanPath('user-profile.json');
    this.toolLessonsPath = dir ? path.join(dir, '.duan-tool-lessons.json') : duanPath('tool-lessons.json');
  }

  /**
   * 主入口：根据当前上下文主动注入记忆
   * Hermes：支持按层级过滤，应用重要性衰减
   */
  async inject(context: ProactiveMemoryContext): Promise<InjectedMemory[]> {
    const injections: InjectedMemory[] = [];

    try {
      switch (context.phase) {
        case 'planning':
          injections.push(...await this.injectForPlanning(context));
          break;
        case 'tool_selection':
          injections.push(...await this.injectForToolSelection(context));
          break;
        case 'output':
          injections.push(...await this.injectForOutput(context));
          break;
        case 'error_recovery':
          injections.push(...await this.injectForErrorRecovery(context));
          break;
        case 'execution':
          // 执行阶段轻量注入
          injections.push(...await this.injectForExecution(context));
          break;
      }
    } catch (err: unknown) {
      logger.warn('ProactiveMemoryInjector注入失败', { error: (err instanceof Error ? err.message : String(err)) });
    }

    // Hermes：按层级过滤（若指定）
    let filtered = injections;
    if (context.tier) {
      filtered = injections.filter(inj => !inj.tier || inj.tier === context.tier);
    }

    // Hermes：应用重要性衰减调整相关度
    filtered = filtered.map(inj => ({
      ...inj,
      relevance: this.applyDecayToRelevance(inj),
    }));

    // 按相关度排序，只返回top 5
    return filtered
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 5);
  }

  /**
   * Hermes：应用重要性衰减到相关度
   * 时间越久远的记忆相关度衰减越多
   */
  private applyDecayToRelevance(inj: InjectedMemory): number {
    // 偏好类记忆不衰减（用户偏好相对稳定）
    if (inj.source === 'user_preference') {
      return inj.relevance;
    }
    // 技能类记忆衰减更慢
    if (inj.tier === HermesMemoryTier.L2_SKILL) {
      return inj.relevance * 0.95;
    }
    // L1 持久级记忆轻微衰减
    if (inj.tier === HermesMemoryTier.L1_PERSISTENT) {
      return inj.relevance * 0.9;
    }
    // L0 会话级记忆不衰减（当前对话）
    return inj.relevance;
  }

  /**
   * 将注入的记忆格式化为系统提示词片段
   */
  formatForPrompt(injections: InjectedMemory[]): string {
    if (injections.length === 0) return '';

    const sections: string[] = ['## 🧠 主动记忆注入'];

    for (const inj of injections) {
      const icon = this.getSourceIcon(inj.source);
      sections.push(`### ${icon} ${inj.reason} (相关度: ${(inj.relevance * 100).toFixed(0)}%)`);
      sections.push(inj.content);
    }

    return sections.join('\n');
  }

  // ============ 规划阶段注入 ============

  private injectForPlanning(ctx: ProactiveMemoryContext): Promise<InjectedMemory[]> {
    const injections: InjectedMemory[] = [];

    // 1. 注入相似任务的历史经验（L1 持久级）
    const experiences = this.loadExperiencesCached();
    const relevantExperiences = this.matchExperiences(experiences, ctx.userInput);
    for (const exp of relevantExperiences.slice(0, 2)) {
      injections.push({
        source: 'experience',
        content: exp.content,
        relevance: exp.relevance,
        reason: '历史相似任务经验',
        tier: HermesMemoryTier.L1_PERSISTENT,
      });
    }

    // 2. 注入用户画像中的任务偏好（L1 持久级）
    const profile = this.getUserProfile();
    if (profile) {
      const prefHint = this.extractTaskPreference(profile, ctx.userInput);
      if (prefHint) {
        injections.push({
          source: 'user_preference',
          content: prefHint,
          relevance: 0.75,
          reason: '用户任务偏好',
          tier: HermesMemoryTier.L1_PERSISTENT,
          confidence: 0.8,
        });
      }
    }

    // 3. 注入已掌握的技能SOP（L2 技能级）
    const skills = this.loadSkillPatterns();
    const matchedSkill = this.matchSkill(skills, ctx.userInput);
    if (matchedSkill) {
      injections.push({
        source: 'skill_pattern',
        content: matchedSkill.content,
        relevance: matchedSkill.relevance,
        reason: '已掌握的技能模式',
        tier: HermesMemoryTier.L2_SKILL,
      });
    }

    return Promise.resolve(injections);
  }

  // ============ 工具选择阶段注入 ============

  private injectForToolSelection(ctx: ProactiveMemoryContext): Promise<InjectedMemory[]> {
    const injections: InjectedMemory[] = [];

    // 1. 注入工具失败教训（L2 技能级）
    const lessons = this.loadToolLessons();
    const relevantLessons = lessons.filter(l =>
      ctx.candidateTools?.some(t => t === l.toolName || t.includes(l.toolName))
    );
    for (const lesson of relevantLessons.slice(0, 3)) {
      injections.push({
        source: 'tool_lesson',
        content: `工具 ${lesson.toolName} 的教训: ${lesson.lesson}\n修复建议: ${lesson.fixSuggestion}\n成功率: ${(lesson.successRate * 100).toFixed(0)}%`,
        relevance: Math.max(0.5, lesson.successRate),
        reason: `工具 ${lesson.toolName} 历史教训`,
        tier: HermesMemoryTier.L2_SKILL,
      });
    }

    // 2. 注入用户工具偏好（L1 持久级）
    const profile = this.getUserProfile();
    if (profile?.performance?.preferredTools?.length > 0) {
      const topTools = profile.performance.preferredTools.slice(0, 3);
      const toolPrefs = topTools.map((t: { tool?: string; count?: number }) => `${t.tool} (使用${t.count}次)`).join(', ');
      injections.push({
        source: 'user_preference',
        content: `用户常用工具: ${toolPrefs}`,
        relevance: 0.6,
        reason: '用户工具偏好',
        tier: HermesMemoryTier.L1_PERSISTENT,
        confidence: 0.7,
      });
    }

    return Promise.resolve(injections);
  }

  // ============ 输出阶段注入 ============

  private injectForOutput(_ctx: ProactiveMemoryContext): Promise<InjectedMemory[]> {
    const injections: InjectedMemory[] = [];

    const profile = this.getUserProfile();
    if (profile) {
      const styleHints: string[] = [];

      // 通信风格
      if (profile.cognitive?.communicationStyle) {
        const styleMap: Record<string, string> = {
          formal: '正式',
          casual: '随意',
          technical: '技术性',
          friendly: '友好',
        };
        styleHints.push(`沟通风格: ${styleMap[profile.cognitive.communicationStyle] || profile.cognitive.communicationStyle}`);
      }

      // 详细程度
      if (profile.cognitive?.detailLevel) {
        const detailMap: Record<string, string> = {
          brief: '简洁（只给关键结论）',
          moderate: '适中（结论+简要说明）',
          detailed: '详细（完整解释+示例）',
        };
        styleHints.push(`详细程度: ${detailMap[profile.cognitive.detailLevel] || profile.cognitive.detailLevel}`);
      }

      // 是否偏好代码
      if (profile.cognitive?.prefersCode !== undefined) {
        styleHints.push(profile.cognitive.prefersCode ? '偏好代码示例' : '偏好文字描述');
      }

      // 是否偏好分步骤
      if (profile.cognitive?.prefersStepByStep !== undefined) {
        styleHints.push(profile.cognitive.prefersStepByStep ? '偏好分步骤呈现' : '偏好直接给结果');
      }

      // 专业水平
      if (profile.cognitive?.expertiseLevel) {
        const levelMap: Record<string, string> = {
          beginner: '初学者（需要更多解释）',
          intermediate: '中级（可以省略基础解释）',
          advanced: '高级（可以直接用术语）',
          expert: '专家（可以省略所有解释）',
        };
        styleHints.push(`专业水平: ${levelMap[profile.cognitive.expertiseLevel] || profile.cognitive.expertiseLevel}`);
      }

      if (styleHints.length > 0) {
        injections.push({
          source: 'user_preference',
          content: `请按以下用户偏好调整输出:\n${styleHints.join('\n')}`,
          relevance: 0.85,
          reason: '用户输出风格偏好',
          tier: HermesMemoryTier.L1_PERSISTENT,
          confidence: 0.9,
        });
      }
    }

    return Promise.resolve(injections);
  }

  // ============ 错误恢复阶段注入 ============

  private injectForErrorRecovery(ctx: ProactiveMemoryContext): Promise<InjectedMemory[]> {
    const injections: InjectedMemory[] = [];

    if (!ctx.recentError) return Promise.resolve(injections);

    // 1. 搜索历史相似错误（L2 技能级 - 历史解决方案）
    const errorMemories = this.loadErrorMemories();
    const matched = this.matchErrors(errorMemories, ctx.recentError);
    for (const err of matched.slice(0, 2)) {
      injections.push({
        source: 'error_history',
        content: err.content,
        relevance: err.relevance,
        reason: '历史相似错误及修复方案',
        tier: HermesMemoryTier.L2_SKILL,
      });
    }

    // 2. 搜索工具教训中的修复建议（L2 技能级）
    const lessons = this.loadToolLessons();
    const errorStr = ctx.recentError || '';
    const errorLessons = lessons.filter(l =>
      errorStr.includes(l.toolName) || l.pattern.includes(errorStr.substring(0, 30))
    );
    for (const lesson of errorLessons.slice(0, 2)) {
      injections.push({
        source: 'tool_lesson',
        content: `修复建议: ${lesson.fixSuggestion}`,
        relevance: 0.8,
        reason: `工具 ${lesson.toolName} 的修复方案`,
        tier: HermesMemoryTier.L2_SKILL,
      });
    }

    return Promise.resolve(injections);
  }

  // ============ 执行阶段注入 ============

  private injectForExecution(ctx: ProactiveMemoryContext): Promise<InjectedMemory[]> {
    const injections: InjectedMemory[] = [];

    // 轻量注入：只注入最相关的1条经验（L1 持久级）
    const experiences = this.loadExperiencesCached();
    const relevant = this.matchExperiences(experiences, ctx.currentStep || ctx.userInput);
    if (relevant.length > 0 && relevant[0].relevance > 0.7) {
      injections.push({
        source: 'experience',
        content: relevant[0].content,
        relevance: relevant[0].relevance,
        reason: '当前步骤相关经验',
        tier: HermesMemoryTier.L1_PERSISTENT,
      });
    }

    return Promise.resolve(injections);
  }

  // ============ 数据加载方法 ============

  /**
   * Hermes：带缓存的经验加载，加速 ≤100ms 注入
   * 维护关键词索引实现快速匹配
   */
  private loadExperiencesCached(): Array<{ content: string; tags: string[]; timestamp: number; relevance: number }> {
    const now = Date.now();
    // 缓存有效期内直接返回
    if (this.experiencesCache !== null && now - this.experiencesCacheTime < ProactiveMemoryInjector.EXPERIENCES_CACHE_TTL) {
      return this.experiencesCache;
    }

    const experiences = this.loadExperiences();
    this.experiencesCache = experiences;
    this.experiencesCacheTime = now;

    // 重建关键词索引（使用中文分词器，与匹配算法保持一致）
    this.experiencesIndex.clear();
    experiences.forEach((exp, idx) => {
      const text = `${exp.content} ${exp.tags.join(' ')}`.toLowerCase();
      const words = tokenize(text).filter(w => w.length >= 2);
      for (const word of words) {
        if (!this.experiencesIndex.has(word)) {
          this.experiencesIndex.set(word, new Set());
        }
        this.experiencesIndex.get(word)!.add(idx);
      }
    });

    return experiences;
  }

  private loadExperiences(): Array<{ content: string; tags: string[]; timestamp: number; relevance: number }> {
    const results: Array<{ content: string; tags: string[]; timestamp: number; relevance: number }> = [];
    try {
      if (!fs.existsSync(this.experiencesDir)) return results;
      for (const file of fs.readdirSync(this.experiencesDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.experiencesDir, file), 'utf-8'));
          results.push({
            content: data.content || data.lesson || data.summary || JSON.stringify(data),
            tags: data.tags || [],
            timestamp: data.timestamp || 0,
            relevance: 0,
          });
        } catch {}
      }
    } catch {}
    return results;
  }

  private loadErrorMemories(): Array<{ content: string; tags: string[]; timestamp: number; relevance: number }> {
    const results: Array<{ content: string; tags: string[]; timestamp: number; relevance: number }> = [];
    try {
      if (!fs.existsSync(this.memoryDir)) return results;
      for (const file of fs.readdirSync(this.memoryDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.memoryDir, file), 'utf-8'));
          if (data.type === 'error' || data.type === 'mistake' || data.type === 'correction' || data.type === 'doom_loop') {
            results.push({
              content: data.content || '',
              tags: data.tags || [],
              timestamp: data.timestamp || 0,
              relevance: 0,
            });
          }
        } catch {}
      }
    } catch {}
    return results;
  }

  private loadToolLessons(): Array<{ toolName: string; pattern: string; lesson: string; fixSuggestion: string; successRate: number; tags: string[] }> {
    try {
      if (!fs.existsSync(this.toolLessonsPath)) return [];
      const data = JSON.parse(fs.readFileSync(this.toolLessonsPath, 'utf-8'));
      return data.lessons || data || [];
    } catch {
      return [];
    }
  }

  private loadSkillPatterns(): Array<{ content: string; tags: string[]; relevance: number }> {
    const results: Array<{ content: string; tags: string[]; relevance: number }> = [];
    try {
      const skillsPath = path.join(this.learningDir, 'skills.json');
      if (!fs.existsSync(skillsPath)) return results;
      const data = JSON.parse(fs.readFileSync(skillsPath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const skill of data) {
          results.push({
            content: skill.description || skill.content || skill.name || '',
            tags: skill.tags || skill.keywords || [],
            relevance: 0,
          });
        }
      }
    } catch {}

    // 也从 .duan/memories/ 中加载 skill 类型
    try {
      if (!fs.existsSync(this.memoryDir)) return results;
      for (const file of fs.readdirSync(this.memoryDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.memoryDir, file), 'utf-8'));
          if (data.type === 'skill' || data.type === 'best_practice' || data.type === 'pattern') {
            results.push({
              content: data.content || '',
              tags: data.tags || [],
              relevance: 0,
            });
          }
        } catch {}
      }
    } catch {}

    return results;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getUserProfile(): any {
    // 缓存检查
    const now = Date.now();
    if (this.userProfileCache && now - this.userProfileCacheTime < ProactiveMemoryInjector.CACHE_TTL) {
      return this.userProfileCache;
    }

    try {
      if (!fs.existsSync(this.userProfilePath)) return null;
      const data = JSON.parse(fs.readFileSync(this.userProfilePath, 'utf-8'));
      this.userProfileCache = data;
      this.userProfileCacheTime = now;
      return data;
    } catch {
      return null;
    }
  }

  // ============ 匹配算法（增强版：中文分词 + TF-IDF 加权 + 同义词扩展） ============

  /** 技术同义词映射（提升语义匹配准确率） */
  private static readonly SYNONYM_MAP: Record<string, string[]> = {
    '错误': ['error', 'bug', '异常', 'exception', 'fail', '失败', '报错'],
    '失败': ['fail', 'failed', 'error', '错误', '不成功'],
    '超时': ['timeout', 'timed out', '超时'],
    '权限': ['permission', 'denied', 'unauthorized', 'forbidden', '授权', '拒绝'],
    '网络': ['network', 'connection', 'econn', '连接', 'socket'],
    '文件': ['file', '文件', 'path', '路径'],
    '搜索': ['search', 'grep', 'find', '查找', '查询'],
    '执行': ['execute', 'run', 'bash', 'shell', '命令', 'command'],
    '配置': ['config', 'configure', '设置', 'setting', '部署', 'deploy'],
    '测试': ['test', '测试', 'spec', 'vitest', 'jest'],
    '安装': ['install', '安装', 'npm', 'yarn', 'pnpm', '依赖'],
    '构建': ['build', '构建', 'compile', '编译', 'webpack', 'vite'],
    '调试': ['debug', '调试', '断点', 'breakpoint'],
    '优化': ['optimize', '优化', '性能', 'performance', '提升'],
    '重构': ['refactor', '重构', '重写', 'rewrite'],
  };

  /** 停用词（匹配时忽略） */
  private static readonly STOP_WORDS = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'this', 'that', 'it',
  ]);

  /** 增强分词：使用中文分词器 + 同义词扩展 */
  private tokenizeAndExpand(text: string): string[] {
    const tokens = tokenize(text.toLowerCase())
      .filter(t => t.length > 1 && !ProactiveMemoryInjector.STOP_WORDS.has(t));

    // 同义词扩展：为每个 token 添加同义词
    const expanded = new Set<string>(tokens);
    for (const token of tokens) {
      for (const [canonical, synonyms] of Object.entries(ProactiveMemoryInjector.SYNONYM_MAP)) {
        if (token === canonical || synonyms.includes(token)) {
          expanded.add(canonical);
          synonyms.forEach(s => expanded.add(s));
        }
      }
    }
    return Array.from(expanded);
  }

  /** 计算 TF-IDF 式权重：罕见词权重更高 */
  private computeTermWeights(
    queryTokens: string[],
    corpus: Array<{ content: string; tags: string[] }>,
  ): Map<string, number> {
    const weights = new Map<string, number>();
    const docFreq = new Map<string, number>(); // 包含该词的文档数

    for (const token of queryTokens) {
      docFreq.set(token, 0);
    }

    // 统计每个 query token 在多少文档中出现
    for (const doc of corpus) {
      const docText = `${doc.content} ${doc.tags.join(' ')}`.toLowerCase();
      for (const token of queryTokens) {
        if (docText.includes(token)) {
          docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
      }
    }

    // IDF = log(N / df)，df=0 时给最高权重
    const N = Math.max(1, corpus.length);
    for (const token of queryTokens) {
      const df = docFreq.get(token) || 0;
      const idf = df === 0 ? Math.log(N + 1) : Math.log(N / df);
      // 罕见词权重高，但至少 0.5
      weights.set(token, Math.max(0.5, idf));
    }

    return weights;
  }

  private matchExperiences(
    experiences: Array<{ content: string; tags: string[]; timestamp: number; relevance: number }>,
    query: string,
  ): Array<{ content: string; relevance: number }> {
    const queryTokens = this.tokenizeAndExpand(query);
    if (queryTokens.length === 0) return [];

    // Hermes：优先使用关键词索引快速命中
    const hitIndices = new Set<number>();
    for (const word of queryTokens) {
      const indices = this.experiencesIndex.get(word);
      if (indices) {
        for (const idx of indices) {
          hitIndices.add(idx);
        }
      }
    }

    // 候选集：索引命中的优先，未命中的降级扫描
    const candidateIndices = hitIndices.size > 0
      ? Array.from(hitIndices)
      : experiences.map((_, idx) => idx);

    // TF-IDF 权重：罕见查询词权重更高
    const termWeights = this.computeTermWeights(queryTokens, experiences);

    return candidateIndices
      .map(idx => {
        const exp = experiences[idx];
        if (!exp) return null;
        const contentLower = exp.content.toLowerCase();
        const tagsLower = exp.tags.map(t => t.toLowerCase());
        let score = 0;

        // TF-IDF 加权关键词匹配
        for (const token of queryTokens) {
          const weight = termWeights.get(token) || 1;
          if (contentLower.includes(token)) score += 0.15 * weight;
          if (tagsLower.some(t => t.includes(token))) score += 0.12 * weight;
        }

        // bigram 匹配增强：连续两词共现加权
        for (let i = 0; i < queryTokens.length - 1; i++) {
          const bigram = `${queryTokens[i]} ${queryTokens[i + 1]}`;
          if (contentLower.includes(bigram) || contentLower.includes(queryTokens[i] + queryTokens[i + 1])) {
            score += 0.2; // bigram 命中额外加分
          }
        }

        // 时间衰减：越近期的经验权重越高（指数衰减更合理）
        const ageDays = (Date.now() - exp.timestamp) / (1000 * 60 * 60 * 24);
        const timeDecay = Math.max(0.3, Math.exp(-ageDays / 30)); // 指数衰减，30天半衰期

        score *= timeDecay;

        return { content: exp.content, relevance: Math.min(1, score) };
      })
      .filter((e): e is { content: string; relevance: number } => e !== null && e.relevance > 0.2)
      .sort((a, b) => b.relevance - a.relevance);
  }

  private matchErrors(
    errors: Array<{ content: string; tags: string[]; timestamp: number; relevance: number }>,
    errorMsg: string,
  ): Array<{ content: string; relevance: number }> {
    const errorTokens = this.tokenizeAndExpand(errorMsg);
    if (errorTokens.length === 0) return [];

    // 扩展错误类型匹配模式（基于同义词映射自动覆盖）
    const errorTypePatterns: Array<[string[], number]> = [
      [['超时', 'timeout', 'timed out'], 0.35],
      [['限流', 'rate', '429', 'too many'], 0.35],
      [['权限', 'auth', 'unauthorized', 'forbidden', '401', '403'], 0.35],
      [['网络', 'network', 'connection', 'econn', 'socket'], 0.35],
      [['资源', 'enoent', 'not found', '404', '不存在'], 0.35],
      [['内存', 'memory', 'oom', 'ENOMEM'], 0.35],
      [['语法', 'syntax', 'parse', '解析'], 0.3],
      [['类型', 'type', 'undefined', 'null'], 0.3],
    ];

    return errors
      .map(err => {
        const contentLower = err.content.toLowerCase();
        let score = 0;

        // TF-IDF 式 token 匹配
        for (const token of errorTokens) {
          if (contentLower.includes(token)) score += 0.2;
        }

        // 错误类型模式匹配（增强：更多类型）
        for (const [patterns, bonus] of errorTypePatterns) {
          const contentHasType = patterns.some(p => contentLower.includes(p));
          const errorHasType = patterns.some(p => errorMsg.toLowerCase().includes(p));
          if (contentHasType && errorHasType) score += bonus;
        }

        // 标签匹配加权
        for (const tag of err.tags) {
          if (errorTokens.some(t => tag.toLowerCase().includes(t))) score += 0.15;
        }

        return { content: err.content, relevance: Math.min(1, score) };
      })
      .filter(e => e.relevance > 0.3)
      .sort((a, b) => b.relevance - a.relevance);
  }

  private matchSkill(
    skills: Array<{ content: string; tags: string[]; relevance: number }>,
    query: string,
  ): { content: string; relevance: number } | null {
    const queryTokens = this.tokenizeAndExpand(query);
    if (queryTokens.length === 0) return null;

    let bestMatch: { content: string; relevance: number } | null = null;

    for (const skill of skills) {
      let score = 0;
      const contentLower = skill.content.toLowerCase();
      const _tagsLower = skill.tags.map(t => t.toLowerCase());

      // 标签匹配（高权重：标签是人工标注的关键词）
      for (const tag of skill.tags) {
        const tagLower = tag.toLowerCase();
        if (queryTokens.some(t => t === tagLower || tagLower.includes(t))) {
          score += 0.35;
        }
        // 同义词标签匹配
        for (const [canonical, synonyms] of Object.entries(ProactiveMemoryInjector.SYNONYM_MAP)) {
          if ((tagLower === canonical || synonyms.includes(tagLower)) &&
              queryTokens.some(t => t === canonical || synonyms.includes(t))) {
            score += 0.2;
            break;
          }
        }
      }

      // 内容匹配（TF-IDF 式加权）
      for (const token of queryTokens) {
        if (contentLower.includes(token)) score += 0.1;
      }

      // bigram 匹配增强
      for (let i = 0; i < queryTokens.length - 1; i++) {
        if (contentLower.includes(queryTokens[i] + queryTokens[i + 1])) {
          score += 0.15;
        }
      }

      if (score > 0.3 && (!bestMatch || score > bestMatch.relevance)) {
        bestMatch = { content: skill.content, relevance: Math.min(1, score) };
      }
    }

    return bestMatch;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTaskPreference(profile: any, userInput: string): string | null {
    const hints: string[] = [];

    // 从常见任务中匹配
    if (profile.behavioral?.commonTasks?.length > 0) {
      const inputLower = userInput.toLowerCase();
      for (const task of profile.behavioral.commonTasks) {
        if (inputLower.includes(task.pattern?.toLowerCase())) {
          hints.push(`用户常做此类任务（${task.count}次）`);
          break;
        }
      }
    }

    // 从偏好领域匹配
    if (profile.behavioral?.preferredDomains?.length > 0) {
      const topDomain = profile.behavioral.preferredDomains[0];
      if (topDomain?.domain) {
        hints.push(`用户主要领域: ${topDomain.domain}`);
      }
    }

    return hints.length > 0 ? hints.join('; ') : null;
  }

  private getSourceIcon(source: string): string {
    const icons: Record<string, string> = {
      experience: '📖',
      user_preference: '👤',
      tool_lesson: '🔧',
      error_history: '⚠️',
      skill_pattern: '⚡',
    };
    return icons[source] || '📝';
  }
}
