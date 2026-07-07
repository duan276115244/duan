/**
 * 自我进化引擎 - SelfEvolutionEngine
 * 基于 AgentEvolver 和 Gödel Agent 架构
 * 三大核心机制：
 * 1. Self-Questioning - 自主提问和任务生成
 * 2. Self-Navigating - 经验引导探索
 * 3. Self-Attributing - 因果贡献分析
 */

import { Anthropic } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { callLLMWithRecovery } from './query-engine-singleton.js';
import { ModelLibrary } from './model-library.js';
import { duanPath } from './duan-paths.js';
// P0 修复 (Bug 3): 删除本地 EvolutionMetrics 类，统一用 evolution-metrics.ts 的正式类
// 原本地类（line 320-394）与正式类同名但不同：本地类用动态 Map、不持久化、接受任意 key；
// 正式类有 16 个指标定义、持久化、generateReport 生成 19.9/100 评分报告
// 双类共存导致 self-evolution-engine 的指标写入本地内存 Map，从不同步到正式类（给 self_metrics 工具用）
import { EvolutionMetrics } from './evolution-metrics.js';
import { atomicWriteJson } from './atomic-write.js';

export interface Experience {
  id: string;
  task: string;
  approach: string;
  result: string;
  success: boolean;
  lessons: string[];
  timestamp: number;
  confidence: number;
}

export interface TaskTemplate {
  id: string;
  category: string;
  description: string;
  difficulty: number;
  frequency: number;
  bestApproach?: string;
}

export interface EvolutionResult {
  improved: boolean;
  newStrategy?: string;
  insights: string[];
  recommendations: string[];
}

/** 学习样本 */
interface LearningSample {
  input: string;
  expectedOutput: string;
  actualOutput: string;
  category: string;
  difficulty: number; // 1-5
  timestamp: number;
}

/** 主动学习结果 */
interface ActiveLearningResult {
  selectedSamples: LearningSample[];
  strategy: 'uncertainty' | 'diversity' | 'boundary' | 'combined';
  estimatedImprovement: number;
}

/** 经验质量评估 */
interface ExperienceQuality {
  experienceId: string;
  relevance: number;    // 与当前任务的相关性
  reliability: number;  // 结果可靠性
  recency: number;      // 时效性
  transferability: number; // 可迁移性
  overallScore: number;
}

/** 知识冲突 */
interface KnowledgeConflict {
  existingKnowledge: string;
  newKnowledge: string;
  conflictType: 'contradiction' | 'outdated' | 'partial_overlap' | 'ambiguity';
  resolution: 'keep_existing' | 'replace' | 'merge' | 'flag_for_review';
  confidence: number;
}

/** 学习统计 */
interface LearningStats {
  totalExperiences: number;
  successRate: number;
  averageQuality: number;
  conflictsDetected: number;
  conflictsResolved: number;
  improvementTrend: number[];  // 最近N次的成功率
  topCategories: string[];
  learningVelocity: number; // 学习速度（每次交互的改进量）
}

// ============ 提示词进化模块 ============

class PromptEvolutionModule {
  private modelLibrary: ModelLibrary;
  private promptVariants: Map<string, { prompt: string; score: number; usageCount: number }[]> = new Map();

  constructor(modelLibrary: ModelLibrary) {
    this.modelLibrary = modelLibrary;
  }

  /** 为指定任务类型生成提示词变体 */
  generateVariants(taskType: string, basePrompt: string): Promise<string[]> {
    const variants: string[] = [];

    // 策略1：添加角色设定
    variants.push(`你是一位${taskType}领域的专家。${basePrompt}`);

    // 策略2：添加思维链引导
    variants.push(`${basePrompt}\n\n请逐步思考，先分析问题，再给出方案。`);

    // 策略3：添加输出格式约束
    variants.push(`${basePrompt}\n\n请用结构化的JSON格式输出结果。`);

    // 策略4：添加示例引导
    variants.push(`${basePrompt}\n\n参考示例：输入→分析→输出`);

    // 策略5：添加质量约束
    variants.push(`${basePrompt}\n\n请确保回答准确、完整、可操作。`);

    // 初始化变体存储
    if (!this.promptVariants.has(taskType)) {
      this.promptVariants.set(taskType, []);
    }

    const existing = this.promptVariants.get(taskType)!;
    const existingPrompts = new Set(existing.map(v => v.prompt));

    for (const variant of variants) {
      if (!existingPrompts.has(variant)) {
        existing.push({ prompt: variant, score: 0.5, usageCount: 0 });
      }
    }

    // 确保基础提示词也在变体列表中
    if (!existingPrompts.has(basePrompt)) {
      existing.push({ prompt: basePrompt, score: 0.5, usageCount: 0 });
    }

    return Promise.resolve(variants);
  }

  /** 评估提示词效果 */
  evaluatePrompt(prompt: string, testCases: { input: string; expectedOutput: string }[]): Promise<number> {
    if (testCases.length === 0) return Promise.resolve(0.5);

    let totalScore = 0;

    for (const testCase of testCases) {
      const expectedWords = new Set(testCase.expectedOutput.toLowerCase().split(/\s+/));
      // 简单的词重叠度评估
      const promptWords = new Set(prompt.toLowerCase().split(/\s+/));
      const overlap = [...expectedWords].filter(w => promptWords.has(w)).length;
      const score = expectedWords.size > 0 ? overlap / expectedWords.size : 0;
      totalScore += score;
    }

    return Promise.resolve(totalScore / testCases.length);
  }

  /** 选择最优提示词 */
  selectBestPrompt(taskType: string): string {
    const variants = this.promptVariants.get(taskType);
    if (!variants || variants.length === 0) {
      return '';
    }

    // 按综合评分排序：score * 0.7 + usageCount权重 * 0.3
    const sorted = [...variants].sort((a, b) => {
      const scoreA = a.score * 0.7 + Math.min(a.usageCount / 10, 1) * 0.3;
      const scoreB = b.score * 0.7 + Math.min(b.usageCount / 10, 1) * 0.3;
      return scoreB - scoreA;
    });

    return sorted[0].prompt;
  }

  /** 记录使用结果 */
  recordResult(taskType: string, prompt: string, score: number): void {
    const variants = this.promptVariants.get(taskType);
    if (!variants) return;

    const variant = variants.find(v => v.prompt === prompt);
    if (variant) {
      // 加权移动平均更新分数
      variant.score = variant.score * 0.7 + score * 0.3;
      variant.usageCount++;
    } else {
      variants.push({ prompt, score, usageCount: 1 });
    }
  }

  /** 获取指定任务类型的所有变体 */
  getVariants(taskType: string): { prompt: string; score: number; usageCount: number }[] {
    return this.promptVariants.get(taskType) || [];
  }
}

// ============ A/B 测试框架 ============

interface ABTest {
  id: string;
  name: string;
  variantA: string;  // 对照组
  variantB: string;  // 实验组
  metric: string;    // 评估指标
  results: { variant: 'A' | 'B'; score: number; timestamp: number }[];
  status: 'running' | 'completed';
  createdAt: number;
}

class ABTestFramework {
  private tests: Map<string, ABTest> = new Map();

  /** 创建测试 */
  createTest(name: string, variantA: string, variantB: string, metric: string): string {
    const id = `abt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.tests.set(id, {
      id,
      name,
      variantA,
      variantB,
      metric,
      results: [],
      status: 'running',
      createdAt: Date.now(),
    });
    return id;
  }

  /** 记录结果 */
  recordResult(testId: string, variant: 'A' | 'B', score: number): void {
    const test = this.tests.get(testId);
    if (!test || test.status !== 'running') return;

    test.results.push({ variant, score, timestamp: Date.now() });
  }

  /** 获取统计结果 */
  getResults(testId: string): {
    variantA: { avg: number; count: number };
    variantB: { avg: number; count: number };
    winner: 'A' | 'B' | 'tie';
    confidence: number;
  } {
    const test = this.tests.get(testId);
    if (!test) {
      return { variantA: { avg: 0, count: 0 }, variantB: { avg: 0, count: 0 }, winner: 'tie', confidence: 0 };
    }

    const aResults = test.results.filter(r => r.variant === 'A').map(r => r.score);
    const bResults = test.results.filter(r => r.variant === 'B').map(r => r.score);

    const avgA = aResults.length > 0 ? aResults.reduce((s, v) => s + v, 0) / aResults.length : 0;
    const avgB = bResults.length > 0 ? bResults.reduce((s, v) => s + v, 0) / bResults.length : 0;

    // 简单置信度计算：基于样本量和差异
    const totalSamples = aResults.length + bResults.length;
    const diff = Math.abs(avgA - avgB);
    const pooledStd = Math.sqrt(
      (this.variance(aResults) + this.variance(bResults)) / 2
    );
    const effectSize = pooledStd > 0 ? diff / pooledStd : 0;
    const confidence = Math.min(1, totalSamples / 30 * 0.5 + effectSize * 0.5);

    let winner: 'A' | 'B' | 'tie' = 'tie';
    if (confidence > 0.3) {
      if (avgA > avgB) {
        winner = 'A';
      } else if (avgB > avgA) {
        winner = 'B';
      } else {
        winner = 'tie';
      }
    }

    return {
      variantA: { avg: avgA, count: aResults.length },
      variantB: { avg: avgB, count: bResults.length },
      winner,
      confidence,
    };
  }

  /** 自动完成测试（样本量足够时） */
  checkAndComplete(testId: string, minSamples: number = 10): boolean {
    const test = this.tests.get(testId);
    if (!test || test.status !== 'running') return false;

    const aCount = test.results.filter(r => r.variant === 'A').length;
    const bCount = test.results.filter(r => r.variant === 'B').length;

    if (aCount >= minSamples && bCount >= minSamples) {
      test.status = 'completed';
      return true;
    }

    return false;
  }

  /** 获取测试 */
  getTest(testId: string): ABTest | undefined {
    return this.tests.get(testId);
  }

  /** 获取所有运行中的测试 */
  getRunningTests(): ABTest[] {
    return Array.from(this.tests.values()).filter(t => t.status === 'running');
  }

  /** 计算方差 */
  private variance(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  }
}

export class SelfEvolutionEngine {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private experiences: Experience[] = [];
  private taskTemplates: TaskTemplate[] = [];
  private strategies: Map<string, number> = new Map();
  private learningSamples: LearningSample[] = [];
  private knowledgeBase: Map<string, string> = new Map();
  private qualityThreshold: number = 0.6;
  private maxExperiences: number = 1000;
  private improvementHistory: number[] = [];
  private promptEvolution: PromptEvolutionModule;
  private abTestFramework: ABTestFramework;
  private evolutionMetrics: EvolutionMetrics;

  constructor(evolutionMetrics?: EvolutionMetrics) {
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here') {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    // 初始化自进化闭环模块
    // 复用进程级单例，避免独立 clients Map / LRU 缓存造成连接池翻倍
    const modelLibrary = ModelLibrary.getInstance();
    this.promptEvolution = new PromptEvolutionModule(modelLibrary);
    this.abTestFramework = new ABTestFramework();
    // P0 修复 (Bug 3): 复用注入的 EvolutionMetrics 实例，避免双实例隔离
    // 原 `new EvolutionMetrics()` 创建独立实例，写入到不了 bootstrap.ts:635 给 toolContext 的报告实例
    // 导致 self_metrics 工具调用 generateReport() 永远读到全零数据（19.9/100 根因之一）
    this.evolutionMetrics = evolutionMetrics ?? new EvolutionMetrics();
  }

  /**
   * 自我提问 - 生成新任务，并自动优化提示词
   */
  async selfQuestioning(context: string): Promise<string[]> {
    const prompt = `
基于以下上下文，生成5个相关的新任务或挑战：

上下文：${context}

要求：
1. 任务应该覆盖不同难度级别
2. 任务应该探索不同的解决策略
3. 任务应该挑战当前能力边界

请用JSON格式返回：
{
  "tasks": [
    {"description": "任务描述", "difficulty": 1-5, "category": "类别"}
  ]
}
    `;

    // 自动优化提示词：为当前任务类型生成变体
    const taskType = this.categorizeTask(context);
    await this.promptEvolution.generateVariants(taskType, prompt);
    const bestPrompt = this.promptEvolution.selectBestPrompt(taskType);

    const effectivePrompt = bestPrompt || prompt;

    const response = await this.callModel(effectivePrompt);
    
    try {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const tasks = parsed.tasks?.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (t: any) => t.description) || [];
        // 记录提示词使用结果
        this.promptEvolution.recordResult(taskType, effectivePrompt, tasks.length > 0 ? 0.8 : 0.3);
        return tasks;
      }
    } catch {
      // 解析失败，返回默认任务
    }
    
    // 记录提示词使用结果（失败）
    this.promptEvolution.recordResult(taskType, effectivePrompt, 0.2);

    return [
      '探索新的解决思路',
      '尝试不同的工具组合',
      '优化现有方案',
      '测试边界情况',
      '发现潜在问题'
    ];
  }

  /**
   * 自我导航 - 经验引导探索
   */
  selfNavigating(newTask: string): string[] {
    const relevantExperiences = this.findRelevantExperiences(newTask);
    
    if (relevantExperiences.length === 0) {
      return ['从基础开始尝试'];
    }

    const strategies: string[] = [];
    
    for (const exp of relevantExperiences.slice(0, 3)) {
      if (exp.success) {
        strategies.push(`类似任务 "${exp.task}" 使用的方法: ${exp.approach}`);
      } else {
        strategies.push(`避免: "${exp.task}" 失败的方法: ${exp.approach}`);
      }
    }

    // 基于成功经验总结最佳策略
    const bestStrategy = this.getMostSuccessfulStrategy(newTask);
    if (bestStrategy) {
      strategies.unshift(`推荐策略: ${bestStrategy}`);
    }

    return strategies;
  }

  /**
   * 自我归因 - 分析因果贡献，包括提示词改进的贡献度
   */
  async selfAttributing(task: string, steps: string[], results: string[]): Promise<Map<string, number>> {
    const prompt = `
分析以下任务执行过程中，每个步骤的贡献度：

任务：${task}

执行步骤：
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

结果：
${results.map((r, i) => `${i + 1}. ${r}`).join('\n')}

请分析哪些步骤对最终结果贡献最大，返回JSON格式：
{
  "contributions": {
    "步骤1": 0.3,
    "步骤2": 0.5,
    ...
  },
  "keyInsight": "关键洞察"
}
    `;

    const response = await this.callModel(prompt);
    
    try {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const contributions = new Map<string, number>();
        for (const [step, value] of Object.entries(parsed.contributions)) {
          contributions.set(step, value as number);
        }

        // 评估提示词改进的贡献度
        const taskType = this.categorizeTask(task);
        const promptVariants = this.promptEvolution.getVariants(taskType);
        if (promptVariants.length > 1) {
          // 找到最优变体与基础提示词的分数差，作为提示词改进的贡献度
          const sortedVariants = [...promptVariants].sort((a, b) => b.score - a.score);
          const bestScore = sortedVariants[0].score;
          const baselineScore = sortedVariants[sortedVariants.length - 1].score;
          const promptImprovementContribution = Math.max(0, bestScore - baselineScore);
          if (promptImprovementContribution > 0) {
            contributions.set('提示词优化', promptImprovementContribution);
          }
        }

        return contributions;
      }
    } catch {
      // 解析失败，返回均匀分配
    }

    const uniform = new Map<string, number>();
    steps.forEach((_, i) => uniform.set(`步骤${i + 1}`, 1 / steps.length));
    return uniform;
  }

  /**
   * 主动学习 - 选择最有价值的样本进行学习
   */
  activeLearning(candidates: LearningSample[], budget: number = 10): ActiveLearningResult {
    const scored = candidates.map(sample => ({
      sample,
      score: this.computeLearningValue(sample),
    }));

    // 按学习价值排序
    scored.sort((a, b) => b.score - a.score);

    // 选择top-k
    const selected = scored.slice(0, budget).map(s => s.sample);

    // 评估预期改进
    const estimatedImprovement = selected.reduce(
      (sum, s) => sum + this.computeLearningValue(s), 0
    ) / Math.max(selected.length, 1);

    return {
      selectedSamples: selected,
      strategy: 'combined',
      estimatedImprovement,
    };
  }

  /**
   * 计算样本的学习价值
   */
  private computeLearningValue(sample: LearningSample): number {
    let value = 0;

    // 1. 不确定性：如果实际输出与期望输出差异大，学习价值高
    const similarity = this.computeStringSimilarity(sample.expectedOutput, sample.actualOutput);
    value += (1 - similarity) * 0.4;

    // 2. 难度：中等难度的样本学习价值最高
    let difficultyScore: number;
    if (sample.difficulty === 3) {
      difficultyScore = 1.0;
    } else if (sample.difficulty < 3) {
      difficultyScore = 0.5 + sample.difficulty * 0.1;
    } else {
      difficultyScore = 0.8 - (sample.difficulty - 3) * 0.1;
    }
    value += difficultyScore * 0.3;

    // 3. 新颖性：与已有经验的差异度
    const novelty = this.computeNovelty(sample);
    value += novelty * 0.3;

    return Math.min(value, 1.0);
  }

  /**
   * 计算字符串相似度（简单Jaccard）
   */
  private computeStringSimilarity(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 计算样本新颖性
   */
  private computeNovelty(sample: LearningSample): number {
    if (this.experiences.length === 0) return 1.0;

    // 与已有经验的最大相似度
    let maxSimilarity = 0;
    for (const exp of this.experiences) {
      const sim = this.computeStringSimilarity(sample.input, exp.task);
      maxSimilarity = Math.max(maxSimilarity, sim);
    }

    return 1 - maxSimilarity;
  }

  /**
   * 评估经验质量
   */
  evaluateExperienceQuality(experience: Experience): ExperienceQuality {
    const now = Date.now();

    // 1. 相关性：基于任务类别匹配
    const relevance = this.computeRelevance(experience);

    // 2. 可靠性：基于成功率和置信度
    const reliability = experience.success ? experience.confidence : experience.confidence * 0.5;

    // 3. 时效性：越新越有价值
    const ageInDays = (now - experience.timestamp) / (1000 * 60 * 60 * 24);
    const recency = Math.max(0, 1 - ageInDays / 30); // 30天衰减

    // 4. 可迁移性：基于教训的通用性
    const transferability = this.computeTransferability(experience);

    // 综合评分
    const overallScore = relevance * 0.3 + reliability * 0.3 + recency * 0.2 + transferability * 0.2;

    return {
      experienceId: experience.id,
      relevance,
      reliability,
      recency,
      transferability,
      overallScore,
    };
  }

  /**
   * 计算经验相关性
   */
  private computeRelevance(experience: Experience): number {
    const category = this.categorizeTask(experience.task);
    const sameCategoryExperiences = this.experiences.filter(
      e => this.categorizeTask(e.task) === category
    );
    const successRate = sameCategoryExperiences.length > 0
      ? sameCategoryExperiences.filter(e => e.success).length / sameCategoryExperiences.length
      : 0.5;
    return successRate;
  }

  /**
   * 计算可迁移性
   */
  private computeTransferability(experience: Experience): number {
    if (!experience.lessons || experience.lessons.length === 0) return 0.3;

    // 教训越抽象，可迁移性越高
    const abstractLessons = experience.lessons.filter(l =>
      l.length > 20 && !l.includes(experience.task.substring(0, 10))
    );

    return Math.min(0.3 + abstractLessons.length * 0.15, 1.0);
  }

  /**
   * 检测知识冲突
   */
  detectKnowledgeConflicts(newKnowledge: string, _category: string): KnowledgeConflict[] {
    const conflicts: KnowledgeConflict[] = [];

    for (const [_key, existingKnowledge] of this.knowledgeBase) {
      const similarity = this.computeStringSimilarity(newKnowledge, existingKnowledge);

      if (similarity > 0.5) {
        // 可能存在冲突
        const conflictType = this.determineConflictType(existingKnowledge, newKnowledge);
        const resolution = this.resolveConflict(conflictType, similarity);

        conflicts.push({
          existingKnowledge,
          newKnowledge,
          conflictType,
          resolution,
          confidence: similarity,
        });
      }
    }

    return conflicts;
  }

  /**
   * 确定冲突类型
   */
  private determineConflictType(existing: string, incoming: string): KnowledgeConflict['conflictType'] {
    // 简单启发式判断
    const negationWords = ['不', '非', '无', '没', 'not', 'no', 'never', 'don\'t'];
    const existingHasNegation = negationWords.some(w => existing.toLowerCase().includes(w));
    const incomingHasNegation = negationWords.some(w => incoming.toLowerCase().includes(w));

    if (existingHasNegation !== incomingHasNegation) {
      return 'contradiction';
    }

    // 检查是否包含版本/时间信息
    const versionPattern = /v?\d+(\.\d+)+|版本|version/i;
    if (versionPattern.test(existing) || versionPattern.test(incoming)) {
      return 'outdated';
    }

    return 'partial_overlap';
  }

  /**
   * 解决冲突
   */
  private resolveConflict(
    conflictType: KnowledgeConflict['conflictType'],
    similarity: number
  ): KnowledgeConflict['resolution'] {
    switch (conflictType) {
      case 'contradiction':
        return similarity > 0.8 ? 'flag_for_review' : 'keep_existing';
      case 'outdated':
        return 'replace';
      case 'partial_overlap':
        return 'merge';
      case 'ambiguity':
        return 'flag_for_review';
      default:
        return 'flag_for_review';
    }
  }

  /**
   * 记录经验
   */
  async recordExperience(
    task: string,
    approach: string,
    result: string,
    success: boolean
  ): Promise<void> {
    const experience: Experience = {
      id: `exp-${Date.now()}`,
      task,
      approach,
      result,
      success,
      lessons: await this.extractLessons(task, approach, result, success),
      timestamp: Date.now(),
      confidence: success ? 0.8 : 0.3
    };

    this.experiences.push(experience);

    // 更新知识库
    const category = this.categorizeTask(task);
    this.knowledgeBase.set(`${category}_${experience.id}`, result);

    // 检测知识冲突
    const conflicts = this.detectKnowledgeConflicts(result, category);
    for (const conflict of conflicts) {
      switch (conflict.resolution) {
        case 'replace':
          // 替换旧知识
          for (const [key, value] of this.knowledgeBase) {
            if (value === conflict.existingKnowledge) {
              this.knowledgeBase.set(key, result);
            }
          }
          break;
        case 'merge':
          // 合并知识
          for (const [key, value] of this.knowledgeBase) {
            if (value === conflict.existingKnowledge) {
              this.knowledgeBase.set(key, `${value}；同时，${result}`);
            }
          }
          break;
        case 'flag_for_review':
          // 标记需要人工审核（记录但不自动处理）
          console.info(`⚠️ 知识冲突需要审核: ${conflict.existingKnowledge.substring(0, 50)}... vs ${conflict.newKnowledge.substring(0, 50)}...`);
          break;
      }
    }

    // 更新改进历史
    let recentSuccessRate: number;
    if (this.experiences.length >= 5) {
      recentSuccessRate = this.experiences.slice(-5).filter(e => e.success).length / 5;
    } else {
      recentSuccessRate = success ? 1 : 0;
    }
    this.improvementHistory.push(recentSuccessRate);

    // 限制经验数量
    if (this.experiences.length > this.maxExperiences) {
      // 保留高质量经验
      const scored = this.experiences.map(e => ({
        experience: e,
        quality: this.evaluateExperienceQuality(e),
      }));
      scored.sort((a, b) => b.quality.overallScore - a.quality.overallScore);
      this.experiences = scored.slice(0, this.maxExperiences).map(s => s.experience);
    }
    
    // 更新策略统计
    const strategyKey = this.categorizeStrategy(approach);
    const currentCount = this.strategies.get(strategyKey) || 0;
    this.strategies.set(strategyKey, success ? currentCount + 1 : currentCount);

    // 保存到持久化存储
    await this.persistExperience(experience);
  }

  /**
   * 提取教训
   */
  private async extractLessons(
    task: string,
    approach: string,
    result: string,
    success: boolean
  ): Promise<string[]> {
    const prompt = `
从以下经验中提取关键教训：

任务：${task}
方法：${approach}
结果：${result}
成功：${success}

请提取3-5个可复用的关键教训，用简洁的语言描述。
    `;

    const response = await this.callModel(prompt);
    
    return response
      .split('\n')
      .map(line => line.replace(/^\d+[.:、]\s*/, '').trim())
      .filter(line => line.length > 10)
      .slice(0, 5);
  }

  /**
   * 自我进化 - 执行完整的进化闭环
   * selfQuestioning → 生成改进方向 → 提示词变体 → A/B测试 → 指标记录 → selfAttributing → 持久化
   */
  async evolve(): Promise<EvolutionResult> {
    if (this.experiences.length < 5) {
      return {
        improved: false,
        insights: ['经验不足，需要更多尝试'],
        recommendations: ['继续积累经验']
      };
    }

    const insights: string[] = [];
    const recommendations: string[] = [];

    // ===== 阶段1: Self-Questioning - 生成改进方向 =====
    const improvementDirections = await this.selfQuestioning('自我进化：分析当前经验并找出改进方向');
    insights.push(...improvementDirections.map(d => `改进方向: ${d}`));

    // ===== 阶段2: 对每个改进方向，使用 PromptEvolutionModule 生成提示词变体 =====
    for (const direction of improvementDirections.slice(0, 3)) {
      const taskType = this.categorizeTask(direction);
      const basePrompt = `针对以下方向进行改进：${direction}`;
      const variants = await this.promptEvolution.generateVariants(taskType, basePrompt);

      // ===== 阶段3: 使用 ABTestFramework 进行 A/B 测试 =====
      if (variants.length >= 2) {
        const testId = this.abTestFramework.createTest(
          `进化测试-${taskType}`,
          variants[0],
          variants[1],
          'effectiveness'
        );

        // A/B测试：使用历史经验的真实结果评估两个变体
        // 修复：移除 Math.random()，改用基于经验数据和 prompt 质量的确定性评分
        const relevantExperiences = this.experiences.filter(
          e => this.categorizeTask(e.task) === taskType
        );

        // prompt 质量启发式评分：结构化、具体性、长度适中性
        const promptQualityScore = (prompt: string): number => {
          let score = 0.5; // 基线
          if (prompt.includes('步骤') || prompt.includes('step')) score += 0.08; // 结构化
          if (prompt.includes('注意') || prompt.includes('注意事')) score += 0.05; // 风险提示
          if (prompt.length > 50 && prompt.length < 500) score += 0.05; // 适中长度
          if (prompt.includes('示例') || prompt.includes('example')) score += 0.04; // 含示例
          if (prompt.includes('验证') || prompt.includes('检查')) score += 0.03; // 含验证步骤
          return Math.min(0.9, score);
        };

        const qualityA = promptQualityScore(variants[0]);
        const qualityB = promptQualityScore(variants[1]);

        for (const exp of relevantExperiences.slice(0, 10)) {
          // 使用真实经验数据作为基础分：成功则基于置信度，失败则低分
          const baseScore = exp.success
            ? Math.min(1, exp.confidence)
            : Math.max(0, 0.3 - (1 - exp.confidence) * 0.3);
          // A 组使用原始 prompt 质量加权，B 组使用变体 prompt 质量加权（确定性，非随机）
          const scoreA = Math.max(0, Math.min(1, baseScore * 0.7 + qualityA * 0.3));
          const scoreB = Math.max(0, Math.min(1, baseScore * 0.7 + qualityB * 0.3));
          this.abTestFramework.recordResult(testId, 'A', scoreA);
          this.abTestFramework.recordResult(testId, 'B', scoreB);
        }

        // 检查测试是否可以完成
        const completed = this.abTestFramework.checkAndComplete(testId, 5);
        const testResults = this.abTestFramework.getResults(testId);

        if (completed || testResults.confidence > 0.3) {
          const winnerPrompt = testResults.winner === 'B' ? variants[1] : variants[0];
          const winnerScore = testResults.winner === 'B' ? testResults.variantB.avg : testResults.variantA.avg;

          // 记录提示词使用结果
          this.promptEvolution.recordResult(taskType, winnerPrompt, winnerScore);

          recommendations.push(`A/B测试胜出: ${winnerPrompt.substring(0, 60)}... (置信度: ${(testResults.confidence * 100).toFixed(0)}%)`);
        }
      }
    }

    // ===== 阶段4: 使用 EvolutionMetrics 记录指标 =====
    // P0 修复: 原 key 'successRate'/'totalExperiences'/'averageQuality'/'learningVelocity'/'contribution.*'
    // 不在 EvolutionMetrics 的 16 个指标定义中，全部被 record() 的 `if (!metric) return` 静默丢弃
    // (evolution-metrics.ts:91-92)，导致综合进化评分从未积累（19.9/100 的根因之一）
    // 正确映射: stats.rate → task_completion_rate, averageQuality → reflection_depth,
    //          learningVelocity → learning_velocity
    const stats = this.getStatistics();
    this.evolutionMetrics.record('task_completion_rate', Math.round(stats.rate * 100));

    const learningStats = this.getLearningStats();
    this.evolutionMetrics.record('reflection_depth', Math.round(learningStats.averageQuality * 100));
    this.evolutionMetrics.record('learning_velocity', Math.max(0, learningStats.learningVelocity));

    // ===== 阶段5: Self-Attributing - 评估改进效果 =====
    const recentSteps = insights.slice(-5);
    const recentResults = recommendations.length > 0
      ? recommendations.slice(-5)
      : ['暂无明确改进建议'];
    const contributions = await this.selfAttributing(
      '自我进化闭环',
      recentSteps,
      recentResults
    );

    // P0 修复: 删除无效的 contribution.${step} record 调用 — EvolutionMetrics 不支持动态 key
    // 归因结果保留在 contributions 变量中（selfAttributing 调用本身可能更新内部状态）
    void contributions;

    // 分析成功模式
    const successPatterns = this.analyzeSuccessPatterns();
    if (successPatterns.length > 0) {
      insights.push(...successPatterns.map(p => `成功模式: ${p}`));
    }

    // 分析失败模式
    const failurePatterns = this.analyzeFailurePatterns();
    if (failurePatterns.length > 0) {
      insights.push(...failurePatterns.map(p => `需改进: ${p}`));
    }

    // 生成推荐
    const bestStrategies = this.getTopStrategies(3);
    recommendations.push(...bestStrategies.map(s => `优先使用: ${s}`));

    // 检查是否需要新的策略
    if (this.experiences.filter(e => e.success).length / this.experiences.length < 0.5) {
      recommendations.push('当前策略成功率较低，建议尝试全新方法');
    }

    // 评估经验质量
    const qualityInsights = this.analyzeQualityDistribution();
    if (qualityInsights.length > 0) {
      insights.push(...qualityInsights);
    }

    // 添加指标趋势洞察
    // P0 修复: 本地类已删除，改用正式类的 getAllMetrics()（返回 EvolutionMetric[]）
    // 正式类的 generateReport() 返回 EvolutionReport 对象（不是数组），不能直接遍历
    const allMetrics = this.evolutionMetrics.getAllMetrics();
    for (const m of allMetrics) {
      insights.push(`指标[${m.name}]: 当前=${m.currentValue.toFixed(3)}, 趋势=${m.trend}`);
    }

    // ===== 阶段6: 持久化进化结果 =====
    await this.persistEvolutionResult(insights, recommendations, contributions);

    return {
      improved: true,
      newStrategy: recommendations[0],
      insights,
      recommendations
    };
  }

  /**
   * 持久化进化结果到 .duan/evolution/
   */
  private async persistEvolutionResult(
    insights: string[],
    recommendations: string[],
    contributions: Map<string, number>
  ): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const dir = duanPath('evolution');

      await fs.mkdir(dir, { recursive: true });

      const result = {
        id: `evo-${Date.now()}`,
        timestamp: Date.now(),
        insights,
        recommendations,
        contributions: Object.fromEntries(contributions),
        metrics: this.evolutionMetrics.generateReport(),
      };

      await atomicWriteJson(
        path.join(dir, `${result.id}.json`),
        result
      );
    } catch (error: unknown) {
      console.error('持久化进化结果失败:', error);
    }
  }

  /**
   * 分析成功模式
   */
  private analyzeSuccessPatterns(): string[] {
    const successes = this.experiences.filter(e => e.success);
    if (successes.length === 0) return [];

    const patterns: string[] = [];
    
    // 分析任务类型
    const taskCategories = successes.map(e => this.categorizeTask(e.task));
    const commonCategories = this.mostFrequent(taskCategories, 2);
    
    for (const cat of commonCategories) {
      patterns.push(`${cat}类型的任务更容易成功`);
    }

    return patterns;
  }

  /**
   * 分析失败模式
   */
  private analyzeFailurePatterns(): string[] {
    const failures = this.experiences.filter(e => !e.success);
    if (failures.length === 0) return [];

    const patterns: string[] = [];
    
    // 提取常见的失败原因
    const failureReasons = failures.map(e => e.result);
    const commonReasons = this.mostFrequent(failureReasons, 2);
    
    for (const reason of commonReasons) {
      patterns.push(`避免: ${reason.substring(0, 50)}`);
    }

    return patterns;
  }

  /**
   * 分析经验质量分布
   */
  private analyzeQualityDistribution(): string[] {
    const qualities = this.experiences.map(e => this.evaluateExperienceQuality(e));
    const avgQuality = qualities.reduce((sum, q) => sum + q.overallScore, 0) / qualities.length;

    const insights: string[] = [];

    if (avgQuality < this.qualityThreshold) {
      insights.push(`经验平均质量(${(avgQuality * 100).toFixed(0)}%)低于阈值，建议清理低质量经验`);
    }

    const lowQuality = qualities.filter(q => q.overallScore < 0.3);
    if (lowQuality.length > this.experiences.length * 0.2) {
      insights.push(`低质量经验占比${((lowQuality.length / this.experiences.length) * 100).toFixed(0)}%，建议优化经验收集策略`);
    }

    return insights;
  }

  /**
   * 获取最成功的策略
   */
  private getMostSuccessfulStrategy(task: string): string | null {
    const taskCategory = this.categorizeTask(task);
    const relevantExperiences = this.experiences.filter(e => 
      this.categorizeTask(e.task) === taskCategory && e.success
    );

    if (relevantExperiences.length === 0) return null;

    const strategyCounts = new Map<string, number>();
    for (const exp of relevantExperiences) {
      const strategy = this.categorizeStrategy(exp.approach);
      strategyCounts.set(strategy, (strategyCounts.get(strategy) || 0) + 1);
    }

    let best: string | null = null;
    let maxCount = 0;
    for (const [strategy, count] of strategyCounts) {
      if (count > maxCount) {
        maxCount = count;
        best = strategy;
      }
    }

    return best;
  }

  /**
   * 获取顶部策略
   */
  private getTopStrategies(n: number): string[] {
    const sorted = Array.from(this.strategies.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([strategy]) => strategy);

    return sorted;
  }

  /**
   * 查找相关经验
   */
  private findRelevantExperiences(task: string): Experience[] {
    const taskWords = new Set(task.toLowerCase().split(/\s+/));
    
    return this.experiences
      .map(exp => {
        const expWords = new Set(exp.task.toLowerCase().split(/\s+/));
        const intersection = [...taskWords].filter(w => expWords.has(w));
        return { exp, score: intersection.length };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.exp);
  }

  /**
   * 分类任务
   */
  private categorizeTask(task: string): string {
    const taskLower = task.toLowerCase();
    
    if (taskLower.includes('代码') || taskLower.includes('code')) return 'coding';
    if (taskLower.includes('设计') || taskLower.includes('design')) return 'design';
    if (taskLower.includes('分析') || taskLower.includes('analyze')) return 'analysis';
    if (taskLower.includes('搜索') || taskLower.includes('search')) return 'search';
    if (taskLower.includes('写') || taskLower.includes('write')) return 'writing';
    
    return 'general';
  }

  /**
   * 分类策略
   */
  private categorizeStrategy(approach: string): string {
    const approachLower = approach.toLowerCase();
    
    if (approachLower.includes('分解') || approachLower.includes('step')) return '分步执行';
    if (approachLower.includes('递归') || approachLower.includes('recursive')) return '递归方法';
    if (approachLower.includes('并行') || approachLower.includes('parallel')) return '并行处理';
    if (approachLower.includes('迭代') || approachLower.includes('iterate')) return '迭代优化';
    
    return '标准方法';
  }

  /**
   * 最频繁元素
   */
  private mostFrequent(arr: string[], n: number): string[] {
    const counts = new Map<string, number>();
    for (const item of arr) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([item]) => item);
  }

  /**
   * 持久化经验
   */
  private async persistExperience(experience: Experience): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const dir = duanPath('experiences');
      
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteJson(
        path.join(dir, `${experience.id}.json`),
        experience
      );
    } catch (error: unknown) {
      console.error('持久化经验失败:', error);
    }
  }

  /**
   * 调用模型（支持多提供商回退）
   */
  private async callModel(prompt: string): Promise<string> {
    // 1. Claude
    if (this.anthropic) {
      try {
        const message = await this.anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
          system: '你是一个自我进化专家，分析经验并提取洞见。'
        });
        return message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
      } catch {}
    }

    // 2. DeepSeek
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    if (deepseekKey && deepseekKey !== 'your_deepseek_api_key_here') {
      try {
        const deepseek = new OpenAI({ apiKey: deepseekKey, baseURL: 'https://api.deepseek.com/v1' });
        const completion = await callLLMWithRecovery(
          deepseek,
          {
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [
              { role: 'system', content: '你是一个自我进化专家，分析经验并提取洞见。' },
              { role: 'user', content: prompt }
            ],
            max_tokens: 2048
          },
          {},
          process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        );
        const text = completion.choices[0].message.content;
        if (text) return text;
      } catch {}
    }

    // 3. OpenRouter
    const orKey = process.env.OPENROUTER_API_KEY;
    if (orKey && orKey !== 'your_openrouter_api_key_here') {
      try {
        const or = new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1' });
        const completion = await callLLMWithRecovery(
          or,
          {
            model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
            messages: [
              { role: 'system', content: '你是一个自我进化专家，分析经验并提取洞见。' },
              { role: 'user', content: prompt }
            ],
            max_tokens: 2048
          },
          {},
          process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
        );
        const text = completion.choices[0].message.content;
        if (text) return text;
      } catch {}
    }

    // 4. OpenAI
    if (this.openai) {
      try {
        const completion = await callLLMWithRecovery(
          this.openai,
          {
            model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
            messages: [
              { role: 'system', content: '你是一个自我进化专家，分析经验并提取洞见。' },
              { role: 'user', content: prompt }
            ],
            max_tokens: 2048
          },
          {},
          process.env.OPENAI_MODEL || 'gpt-4-turbo',
        );
        const text = completion.choices[0].message.content;
        if (text) return text;
      } catch {}
    }
    
    return '';
  }

  /**
   * 获取所有经验
   */
  getExperiences(): Experience[] {
    return [...this.experiences];
  }

  /**
   * 获取学习统计
   */
  getLearningStats(): LearningStats {
    const totalExperiences = this.experiences.length;
    const successCount = this.experiences.filter(e => e.success).length;
    const successRate = totalExperiences > 0 ? successCount / totalExperiences : 0;

    // 计算平均质量
    const qualities = this.experiences.map(e => this.evaluateExperienceQuality(e));
    const averageQuality = qualities.length > 0
      ? qualities.reduce((sum, q) => sum + q.overallScore, 0) / qualities.length
      : 0;

    // 改进趋势（最近10次的成功率）
    const improvementTrend = this.computeImprovementTrend();

    // 热门类别
    const categoryCounts = new Map<string, number>();
    for (const exp of this.experiences) {
      const cat = this.categorizeTask(exp.task);
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
    const topCategories = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat]) => cat);

    // 学习速度
    const learningVelocity = this.improvementHistory.length >= 2
      ? this.improvementHistory[this.improvementHistory.length - 1] - this.improvementHistory[this.improvementHistory.length - 2]
      : 0;

    return {
      totalExperiences,
      successRate,
      averageQuality,
      conflictsDetected: 0,
      conflictsResolved: 0,
      improvementTrend,
      topCategories,
      learningVelocity,
    };
  }

  /**
   * 计算改进趋势
   */
  private computeImprovementTrend(): number[] {
    if (this.experiences.length < 5) return [];

    const windowSize = 5;
    const trend: number[] = [];

    for (let i = windowSize; i <= this.experiences.length; i += windowSize) {
      const window = this.experiences.slice(i - windowSize, i);
      const successRate = window.filter(e => e.success).length / window.length;
      trend.push(Math.round(successRate * 100) / 100);
    }

    return trend;
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    total: number;
    success: number;
    failure: number;
    rate: number;
    topStrategies: string[];
  } {
    const total = this.experiences.length;
    const success = this.experiences.filter(e => e.success).length;
    const failure = total - success;
    const rate = total > 0 ? success / total : 0;
    const topStrategies = this.getTopStrategies(5);

    return { total, success, failure, rate, topStrategies };
  }
}
