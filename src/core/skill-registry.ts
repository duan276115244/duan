/**
 * 领域技能注册系统
 * SkillRegistry
 *
 * 核心能力：
 * 1. 技能注册与管理 - 动态注册领域专用技能
 * 2. 技能匹配 - 根据意图自动匹配最合适的技能
 * 3. 技能执行 - 带错误处理和超时的技能执行
 * 4. 技能学习 - 从执行结果中学习技能效果
 * 5. 技能组合 - 支持多技能组合执行
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { ModelLibrary } from './model-library.js';
import { duanPath } from './duan-paths.js';

/** 技能定义 */
export interface Skill {
  id: string;
  name: string;
  domain: string;                    // 领域：code | data | design | security | devops | research | writing | math
  description: string;
  keywords: string[];                // 触发关键词
  examples: string[];                // 示例输入
  handler: SkillHandler;             // 技能处理函数
  prerequisites?: string[];          // 前置技能ID
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  averageExecutionTime: number;      // 平均执行时间(ms)
  successRate: number;               // 成功率
  usageCount: number;                // 使用次数
}

/** 技能处理函数 */
export type SkillHandler = (input: SkillInput) => Promise<SkillOutput>;

/** 技能输入 */
export interface SkillInput {
  query: string;
  context?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters?: Record<string, any>;
  userId?: string;
}

/** 技能输出 */
export interface SkillOutput {
  success: boolean;
  result: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifacts?: Record<string, any>;   // 产出物（代码、图表等）
  followUpSuggestions?: string[];
  confidence: number;
  executionTime: number;
}

/** 技能匹配结果 */
export interface SkillMatch {
  skill: Skill;
  relevance: number;  // 0-1 相关度
  matchReason: string;
}

/** 技能组合 */
interface SkillComposition {
  skills: Skill[];
  executionOrder: 'sequential' | 'parallel' | 'conditional';
  description: string;
}

export class SkillRegistry extends EventEmitter {
  private skills: Map<string, Skill> = new Map();
  private domainIndex: Map<string, Set<string>> = new Map();  // domain -> skill IDs
  private keywordIndex: Map<string, Set<string>> = new Map(); // keyword -> skill IDs
  private executionHistory: Array<{
    skillId: string;
    success: boolean;
    duration: number;
    timestamp: Date;
  }> = [];
  private _modelLibrary?: ModelLibrary;

  constructor(modelLibrary?: ModelLibrary) {
    super();
    this._modelLibrary = modelLibrary;
    this.registerBuiltinSkills();
  }

  /**
   * 获取 ModelLibrary 实例（懒加载）
   */
  private getModelLibrary(): ModelLibrary {
    if (!this._modelLibrary) {
      // 复用进程级单例，避免独立 clients Map / LRU 缓存造成连接池翻倍
      this._modelLibrary = ModelLibrary.getInstance();
    }
    return this._modelLibrary;
  }

  /**
   * 注册技能
   */
  register(skill: Omit<Skill, 'usageCount' | 'successRate' | 'averageExecutionTime'>): void {
    const fullSkill: Skill = {
      ...skill,
      usageCount: 0,
      successRate: 0.5,
      averageExecutionTime: 1000,
    };

    this.skills.set(skill.id, fullSkill);

    // 更新领域索引
    if (!this.domainIndex.has(skill.domain)) {
      this.domainIndex.set(skill.domain, new Set());
    }
    this.domainIndex.get(skill.domain)!.add(skill.id);

    // 更新关键词索引
    for (const keyword of skill.keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (!this.keywordIndex.has(lowerKeyword)) {
        this.keywordIndex.set(lowerKeyword, new Set());
      }
      this.keywordIndex.get(lowerKeyword)!.add(skill.id);
    }

    this.emit('skill_registered', { id: skill.id, name: skill.name });
  }

  /**
   * 注销技能
   */
  unregister(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    this.skills.delete(skillId);

    // 清理索引
    this.domainIndex.get(skill.domain)?.delete(skillId);
    for (const keyword of skill.keywords) {
      this.keywordIndex.get(keyword.toLowerCase())?.delete(skillId);
    }

    this.emit('skill_unregistered', { id: skillId });
    return true;
  }

  /**
   * 从三套外部技能存储同步技能描述到注册表（消除"三套独立存储不互通"gap）
   *
   * 三套存储统一通过 SkillRegistry.match() 消费：
   * 1. .awareness/skills.json        (skill-extractor 提取的技能)
   * 2. .duan/learning/skills.json    (self-learning-system 学习的技能)
   * 3. .duan/skills/discovered.json  (skill-discovery 发现的技能)
   *
   * 导入为"描述型技能"（handler 为 no-op），仅用于 match() 匹配和 context 注入，
   * 不参与 execute()。已存在的技能 ID 不覆盖（运行时注册优先）。
   *
   * 带 60 秒缓存，避免每轮主循环都读文件。
   */
  private _lastExternalSyncAt = 0;
  private static readonly EXTERNAL_SYNC_INTERVAL_MS = 60_000;

  syncFromExternalStores(): number {
    const now = Date.now();
    if (now - this._lastExternalSyncAt < SkillRegistry.EXTERNAL_SYNC_INTERVAL_MS) {
      return 0; // 缓存未过期，跳过
    }
    this._lastExternalSyncAt = now;

    let imported = 0;
    const stores = [
      { path: path.join(process.cwd(), '.awareness', 'skills.json'), source: 'skill-extractor' },
      { path: path.join(duanPath(), 'learning', 'skills.json'), source: 'self-learning' },
      { path: path.join(duanPath(), 'skills', 'discovered.json'), source: 'skill-discovery' },
    ];

    for (const store of stores) {
      try {
        if (!fs.existsSync(store.path)) continue;
        const raw = fs.readFileSync(store.path, 'utf-8');
        const data = JSON.parse(raw);
        // 三套存储均为数组格式（discovered.json 可能是对象，尝试兼容）
        const skills: Array<Record<string, unknown>> = Array.isArray(data)
          ? data
          : Array.isArray((data as { skills?: unknown[] }).skills)
            ? (data as { skills: unknown[] }).skills
            : [];
        for (const s of skills) {
          if (!s || typeof s !== 'object') continue;
          const id = String(s.id ?? `${store.source}_${s.name ?? Date.now()}`);
          if (this.skills.has(id)) continue; // 不覆盖已注册技能
          const name = String(s.name ?? '');
          if (!name) continue;
          const description = String(s.description ?? '');
          const domain = String(s.domain ?? s.category ?? 'general');
          // 关键词：优先 keywords，回退 tags
          const keywordsRaw = s.keywords ?? s.tags ?? [];
          const keywords = Array.isArray(keywordsRaw)
            ? keywordsRaw.map(k => String(k)).filter(Boolean)
            : [];
          this.register({
            id,
            name,
            domain,
            description,
            keywords,
            examples: Array.isArray(s.examples) ? s.examples.map((e: unknown) => String(e)) : [],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: (): Promise<any> => Promise.resolve({
              success: false,
              result: `外部技能（来源: ${store.source}）无执行 handler，仅用于 match 匹配`,
              confidence: 0,
              executionTime: 0,
            }),
            prerequisites: Array.isArray(s.prerequisites) ? s.prerequisites.map((p: unknown) => String(p)) : undefined,
            estimatedComplexity: (s.estimatedComplexity as 'simple' | 'moderate' | 'complex') ?? 'moderate',
          });
          imported++;
        }
      } catch {
        // 容错：单个存储损坏不影响其他
      }
    }
    return imported;
  }

  /**
   * 匹配最合适的技能
   */
  match(query: string, domain?: string): SkillMatch[] {
    const matches: SkillMatch[] = [];
    const queryLower = query.toLowerCase();

    // 1. 关键词匹配
    for (const [keyword, skillIds] of this.keywordIndex) {
      if (queryLower.includes(keyword)) {
        for (const skillId of skillIds) {
          const skill = this.skills.get(skillId);
          if (!skill) continue;

          // 如果指定了领域，只匹配该领域
          if (domain && skill.domain !== domain) continue;

          const relevance = this.computeRelevance(queryLower, skill);
          matches.push({
            skill,
            relevance,
            matchReason: `关键词匹配: "${keyword}"`,
          });
        }
      }
    }

    // 2. 领域匹配（如果指定了领域但关键词没匹配到）
    if (domain && matches.length === 0) {
      const domainSkills = this.domainIndex.get(domain);
      if (domainSkills) {
        for (const skillId of domainSkills) {
          const skill = this.skills.get(skillId);
          if (!skill) continue;

          matches.push({
            skill,
            relevance: 0.5,
            matchReason: `领域匹配: ${domain}`,
          });
        }
      }
    }

    // 3. 示例匹配（如果前两种都没匹配到）
    if (matches.length === 0) {
      for (const [, skill] of this.skills) {
        if (domain && skill.domain !== domain) continue;

        for (const example of skill.examples) {
          const exampleLower = example.toLowerCase();
          const overlap = this.computeWordOverlap(queryLower, exampleLower);
          if (overlap > 0.3) {
            matches.push({
              skill,
              relevance: overlap * 0.7,
              matchReason: `示例匹配: "${example.substring(0, 30)}..."`,
            });
            break; // 每个技能只匹配一次
          }
        }
      }
    }

    // 去重并排序
    const seen = new Set<string>();
    const uniqueMatches = matches.filter(m => {
      if (seen.has(m.skill.id)) return false;
      seen.add(m.skill.id);
      return true;
    });

    uniqueMatches.sort((a, b) => {
      // 综合考虑相关度和成功率
      const scoreA = a.relevance * 0.7 + a.skill.successRate * 0.3;
      const scoreB = b.relevance * 0.7 + b.skill.successRate * 0.3;
      return scoreB - scoreA;
    });

    return uniqueMatches.slice(0, 5);
  }

  /**
   * 执行技能
   */
  async execute(skillId: string, input: SkillInput): Promise<SkillOutput> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return {
        success: false,
        result: `技能 "${skillId}" 未注册`,
        confidence: 0,
        executionTime: 0,
      };
    }

    const startTime = Date.now();

    try {
      // 检查前置技能
      if (skill.prerequisites) {
        for (const prereqId of skill.prerequisites) {
          const prereq = this.skills.get(prereqId);
          if (!prereq) {
            return {
              success: false,
              result: `前置技能 "${prereqId}" 未注册`,
              confidence: 0,
              executionTime: Date.now() - startTime,
            };
          }
        }
      }

      // 执行技能
      const output = await Promise.race([
        skill.handler(input),
        new Promise<SkillOutput>((_, reject) =>
          setTimeout(() => reject(new Error('技能执行超时')), 30000)
        ),
      ]);

      const executionTime = Date.now() - startTime;

      // 更新统计
      skill.usageCount++;
      skill.averageExecutionTime = (skill.averageExecutionTime * (skill.usageCount - 1) + executionTime) / skill.usageCount;
      skill.successRate = (skill.successRate * (skill.usageCount - 1) + (output.success ? 1 : 0)) / skill.usageCount;

      // 记录执行历史
      this.executionHistory.push({
        skillId,
        success: output.success,
        duration: executionTime,
        timestamp: new Date(),
      });

      this.emit('skill_executed', { skillId, success: output.success, duration: executionTime });

      return {
        ...output,
        executionTime,
      };
    } catch (error: unknown) {
      const executionTime = Date.now() - startTime;

      skill.usageCount++;
      skill.successRate = (skill.successRate * (skill.usageCount - 1)) / skill.usageCount;

      this.executionHistory.push({
        skillId,
        success: false,
        duration: executionTime,
        timestamp: new Date(),
      });

      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        result: `技能执行失败: ${msg}`,
        confidence: 0,
        executionTime,
      };
    }
  }

  /**
   * 执行技能组合
   */
  async executeComposition(composition: SkillComposition, input: SkillInput): Promise<SkillOutput[]> {
    const results: SkillOutput[] = [];

    switch (composition.executionOrder) {
      case 'sequential':
        for (const skill of composition.skills) {
          const result = await this.execute(skill.id, input);
          results.push(result);
          if (!result.success) break; // 顺序执行中失败则停止
        }
        break;

      case 'parallel': {
        const parallelResults = await Promise.all(
          composition.skills.map(skill => this.execute(skill.id, input))
        );
        results.push(...parallelResults);
        break;
      }

      case 'conditional':
        for (const skill of composition.skills) {
          const result = await this.execute(skill.id, input);
          results.push(result);
          // 条件执行：如果成功则继续，否则跳过后续
          if (!result.success) break;
        }
        break;
    }

    return results;
  }

  /**
   * 获取所有技能
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 从 ReflectionEngine 的 SOP 创建并注册技能
   * 桥接 SOP（描述性流程）→ Skill（可执行技能）
   * SOP 的 steps 被封装为 handler，返回步骤指引供 Agent 执行
   * @param sop ReflectionEngine 中提取的 SOP 对象
   */
  registerFromSOP(sop: {
    id: string;
    name: string;
    triggerCondition: string;
    prerequisites: string[];
    steps: Array<{ order: number; description: string; toolHint?: string; expectedOutcome: string; alternativeAction?: string }>;
    pitfalls: string[];
    category: string;
    metrics: { successRate: number; usageCount: number; avgDuration: number };
    successCount: number;
    failureCount: number;
    lastUsed: number;
  }): void {
    // 跳过已注册的 SOP（避免重复）
    if (this.skills.has(`sop_${sop.id}`)) return;

    // 将 SOP steps 转为关键词和示例
    const keywords = sop.triggerCondition
      .split(/[,，、\s]+/)
      .filter(k => k.length > 1)
      .slice(0, 10);
    const examples = sop.steps.slice(0, 3).map(s => s.description.substring(0, 80));

    // 构建指引文本：将 SOP 步骤格式化为 Agent 可执行的指引
    const guidanceText = [
      `技能: ${sop.name}`,
      `触发条件: ${sop.triggerCondition}`,
      sop.prerequisites.length > 0 ? `前置条件: ${sop.prerequisites.join('; ')}` : '',
      '',
      '执行步骤:',
      ...sop.steps.map(s => `  ${s.order}. ${s.description}${s.toolHint ? ` [工具: ${s.toolHint}]` : ''} → ${s.expectedOutcome}${s.alternativeAction ? ` (备选: ${s.alternativeAction})` : ''}`),
      sop.pitfalls.length > 0 ? `\n注意事项:\n${sop.pitfalls.map(p => `  ⚠️ ${p}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    const totalUses = sop.successCount + sop.failureCount;
    this.register({
      id: `sop_${sop.id}`,
      name: sop.name,
      domain: sop.category || 'general',
      description: sop.triggerCondition,
      keywords,
      examples,
      handler: () => Promise.resolve({
        success: true,
        result: guidanceText,
        confidence: 0.8,
        executionTime: 0,
        followUpSuggestions: sop.pitfalls.slice(0, 3),
      }),
      prerequisites: sop.prerequisites,
      estimatedComplexity: (() => {
        if (sop.steps.length > 5) return 'complex';
        if (sop.steps.length > 2) return 'moderate';
        return 'simple';
      })(),
    });

    // 同步统计信息
    const skill = this.skills.get(`sop_${sop.id}`);
    if (skill) {
      skill.usageCount = totalUses;
      skill.successRate = totalUses > 0 ? sop.successCount / totalUses : 0.5;
      skill.averageExecutionTime = sop.metrics.avgDuration || 1000;
    }
  }

  /**
   * 获取指定领域的技能
   */
  getSkillsByDomain(domain: string): Skill[] {
    const skillIds = this.domainIndex.get(domain);
    if (!skillIds) return [];
    return Array.from(skillIds)
      .map(id => this.skills.get(id))
      .filter((s): s is Skill => !!s);
  }

  /**
   * 获取技能统计
   */
  getStats(): {
    totalSkills: number;
    domains: string[];
    totalExecutions: number;
    overallSuccessRate: number;
    topSkills: Array<{ name: string; usageCount: number; successRate: number }>;
  } {
    const skills = Array.from(this.skills.values());
    const totalExecutions = this.executionHistory.length;
    const successfulExecutions = this.executionHistory.filter(e => e.success).length;

    return {
      totalSkills: skills.length,
      domains: Array.from(this.domainIndex.keys()),
      totalExecutions,
      overallSuccessRate: totalExecutions > 0 ? successfulExecutions / totalExecutions : 0,
      topSkills: skills
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, 10)
        .map(s => ({ name: s.name, usageCount: s.usageCount, successRate: s.successRate })),
    };
  }

  /**
   * P1-6: 按领域列出技能（技能库分类管理）
   */
  listByDomain(domain: string): Skill[] {
    const skillIds = this.domainIndex.get(domain);
    if (!skillIds) return [];
    return Array.from(skillIds)
      .map(id => this.skills.get(id))
      .filter((s): s is Skill => s !== undefined)
      .sort((a, b) => b.usageCount - a.usageCount);
  }

  /**
   * P1-6: 按分类体系列出技能
   * 分类：operation(操作) | analysis(分析) | generation(生成) | integration(集成)
   */
  listByCategory(category: 'operation' | 'analysis' | 'generation' | 'integration'): Skill[] {
    const domainCategoryMap: Record<string, string> = {
      'code': 'generation',
      'data': 'analysis',
      'design': 'generation',
      'security': 'analysis',
      'devops': 'integration',
      'research': 'analysis',
      'writing': 'generation',
      'math': 'analysis',
    };
    const targetDomains = Object.entries(domainCategoryMap)
      .filter(([, cat]) => cat === category)
      .map(([domain]) => domain);
    const result: Skill[] = [];
    for (const domain of targetDomains) {
      result.push(...this.listByDomain(domain));
    }
    return result;
  }

  /**
   * P1-6: 更新技能统计（执行后调用）
   */
  updateSkillStats(skillId: string, success: boolean, duration: number): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    skill.usageCount++;
    // 滑动平均成功率
    const alpha = 0.1;
    skill.successRate = skill.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;
    skill.averageExecutionTime = skill.averageExecutionTime * (1 - alpha) + duration * alpha;
    this.executionHistory.push({ skillId, success, duration, timestamp: new Date() });
    // 保留最近 1000 条历史
    if (this.executionHistory.length > 1000) {
      this.executionHistory.shift();
    }
  }

  /**
   * P1-6: 退役低成功率技能
   * 使用次数 >= minUsage 且成功率 < threshold 的技能将被注销
   */
  decommissionLowPerforming(minUsage = 5, threshold = 0.3): string[] {
    const decommissioned: string[] = [];
    for (const [id, skill] of this.skills) {
      if (skill.usageCount >= minUsage && skill.successRate < threshold) {
        this.unregister(id);
        decommissioned.push(id);
      }
    }
    return decommissioned;
  }

  // ========== 私有方法 ==========

  private computeRelevance(query: string, skill: Skill): number {
    let score = 0;

    // 关键词匹配度
    const matchedKeywords = skill.keywords.filter(kw => query.includes(kw.toLowerCase()));
    score += (matchedKeywords.length / Math.max(skill.keywords.length, 1)) * 0.6;

    // 示例相似度
    const maxExampleSimilarity = Math.max(
      ...skill.examples.map(ex => this.computeWordOverlap(query, ex.toLowerCase())),
      0
    );
    score += maxExampleSimilarity * 0.2;

    // 成功率加权
    score += skill.successRate * 0.2;

    return Math.min(score, 1.0);
  }

  private computeWordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 注册内置领域技能
   */
  private registerBuiltinSkills(): void {
    // ---- 代码生成技能 ----
    this.register({
      id: 'code_generate',
      name: '代码生成',
      domain: 'code',
      description: '根据需求描述生成代码',
      keywords: ['写代码', '生成代码', '实现', '编写', 'code', 'implement', 'generate code'],
      examples: ['帮我写一个排序函数', '生成一个React组件', '实现一个API接口'],
      estimatedComplexity: 'moderate',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是专业开发者，根据需求生成高质量代码。请直接输出代码，必要时附上简要说明。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 代码审查技能 ----
    this.register({
      id: 'code_review',
      name: '代码审查',
      domain: 'code',
      description: '审查代码质量、安全性和最佳实践',
      keywords: ['审查', 'review', '代码质量', '代码检查', 'code review', 'lint'],
      examples: ['审查这段代码', '检查代码质量', '这个函数有什么问题'],
      estimatedComplexity: 'moderate',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是高级代码审查员，从安全性、性能、可维护性审查代码，给出具体的改进建议。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 代码重构技能 ----
    this.register({
      id: 'code_refactor',
      name: '代码重构',
      domain: 'code',
      description: '重构代码以提升可读性、性能和可维护性',
      keywords: ['重构', 'refactor', '优化代码', '改进代码', '重写'],
      examples: ['重构这个函数', '优化这段代码的结构', '简化这个类'],
      estimatedComplexity: 'complex',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是重构专家，改善代码结构、可读性和性能，输出重构后的完整代码并说明改动点。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 数据分析技能 ----
    this.register({
      id: 'data_analyze',
      name: '数据分析',
      domain: 'data',
      description: '分析数据集、生成统计报告和可视化',
      keywords: ['分析数据', '统计', '数据可视化', 'analyze data', 'statistics', 'chart'],
      examples: ['分析这份数据', '生成统计报告', '画出数据趋势图'],
      estimatedComplexity: 'complex',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是数据分析师，分析数据并提取洞察，输出结构化的分析报告和关键发现。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 安全扫描技能 ----
    this.register({
      id: 'security_scan',
      name: '安全扫描',
      domain: 'security',
      description: '扫描代码和配置中的安全漏洞',
      keywords: ['安全扫描', '漏洞检测', '安全审计', 'security', 'vulnerability', 'CVE'],
      examples: ['扫描安全漏洞', '检查XSS风险', '审计代码安全性'],
      estimatedComplexity: 'moderate',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是安全专家，检查代码中的安全漏洞，输出详细的安全报告，包括漏洞等级、影响范围和修复建议。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- DevOps部署技能 ----
    this.register({
      id: 'devops_deploy',
      name: '部署配置',
      domain: 'devops',
      description: '配置CI/CD、容器化和部署流程',
      keywords: ['部署', 'deploy', 'Docker', 'CI/CD', 'Kubernetes', '容器化'],
      examples: ['配置Docker部署', '设置CI/CD流水线', 'K8s部署配置'],
      estimatedComplexity: 'complex',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是DevOps专家，生成部署配置和流程，包括CI/CD流水线、容器化配置和运维方案。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 研究分析技能 ----
    this.register({
      id: 'research_analyze',
      name: '研究分析',
      domain: 'research',
      description: '深度研究技术方案、对比分析和趋势预测',
      keywords: ['研究', '调研', '对比分析', 'research', 'compare', '技术选型'],
      examples: ['研究React和Vue的优劣', '调研微服务架构方案', '对比分析数据库选型'],
      estimatedComplexity: 'complex',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是研究分析师，深入分析问题并提供见解，输出结构化的分析报告和结论。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 文档写作技能 ----
    this.register({
      id: 'writing_doc',
      name: '文档写作',
      domain: 'writing',
      description: '生成技术文档、API文档和使用指南',
      keywords: ['写文档', '生成文档', 'API文档', 'documentation', 'README', '使用指南'],
      examples: ['生成API文档', '写README', '编写使用指南'],
      estimatedComplexity: 'simple',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是技术文档专家，生成清晰完整的文档，包括API文档、使用指南和示例说明。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 数学计算技能 ----
    this.register({
      id: 'math_compute',
      name: '数学计算',
      domain: 'math',
      description: '执行数学计算、公式推导和数值分析',
      keywords: ['计算', '公式', '数学', '算法复杂度', 'compute', 'formula', 'math'],
      examples: ['计算算法时间复杂度', '推导数学公式', '数值积分计算'],
      estimatedComplexity: 'moderate',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是数学专家，解决数学问题并给出详细步骤，包括公式推导、计算过程和最终结果。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });

    // ---- 架构设计技能 ----
    this.register({
      id: 'arch_design',
      name: '架构设计',
      domain: 'design',
      description: '系统架构设计、技术方案设计和接口设计',
      keywords: ['架构设计', '系统设计', '接口设计', 'architecture', 'design', '方案设计'],
      examples: ['设计微服务架构', '设计数据库Schema', '系统架构方案'],
      estimatedComplexity: 'complex',
      handler: async (input) => {
        const startTime = Date.now();
        try {
          const lib = this.getModelLibrary();
          const result = await lib.call([
            { role: 'system', content: '你是系统架构师，设计可扩展的系统架构，输出架构图描述、模块划分和技术选型方案。' },
            { role: 'user', content: input.query || JSON.stringify(input) },
          ], { autoFallback: true });
          return {
            success: true,
            result: result.content,
            confidence: 0.85,
            executionTime: Date.now() - startTime,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            result: `技能执行失败: ${msg}`,
            confidence: 0.3,
            executionTime: Date.now() - startTime,
          };
        }
      },
    });
  }
}
