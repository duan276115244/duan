/**
 * 自适应学习系统 - AdaptiveLearningSystem
 *
 * 根据环境变化和任务需求动态调整学习策略：
 * 1. 环境感知 - 监测任务分布变化和用户需求变化
 * 2. 策略选择 - 基于当前状态选择最优学习策略
 * 3. 课程学习 - 从简单到困难的渐进式学习
 * 4. 迁移学习 - 跨领域知识迁移
 * 5. 学习效果评估 - 量化学习效果并反馈调整
 */

import { EventEmitter } from 'events';
import { logger } from './structured-logger.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { cosineSimilarity } from './attention-mechanism.js';

/** 学习策略 */
export type LearningStrategy =
  | 'supervised'        // 有监督学习（基于标注数据）
  | 'self_supervised'   // 自监督学习（基于自身输出）
  | 'reinforcement'     // 强化学习（基于反馈奖励）
  | 'curriculum'        // 课程学习（渐进难度）
  | 'transfer'          // 迁移学习（跨领域）
  | 'meta_learning'     // 元学习（学习如何学习）
  | 'active_learning';  // 主动学习（选择性采样）

/** 学习任务 */
interface LearningTask {
  id: string;
  type: 'nlu_improvement' | 'reasoning_enhancement' | 'skill_acquisition' | 'knowledge_expansion' | 'error_correction';
  description: string;
  difficulty: number;                     // 1-5
  priority: number;                       // 1-10
  estimatedGain: number;                  // 预期收益 0-1
  strategy: LearningStrategy;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: LearningTaskResult;
  createdAt: Date;
}

/** 学习任务结果 */
interface LearningTaskResult {
  improvement: number;                    // 实际改进量
  confidence: number;
  sideEffects: string[];                  // 副作用
  verifiedAt?: Date;
}

/** 环境状态 */
interface EnvironmentState {
  taskDistribution: Map<string, number>;  // 任务类别分布
  avgDifficulty: number;                  // 平均难度
  errorPatterns: string[];                // 常见错误模式
  userSatisfactionTrend: 'improving' | 'stable' | 'declining';
  newDomainDetected: boolean;             // 是否检测到新领域
  timestamp: Date;
}

/** 学习效果记录 */
interface LearningEffectRecord {
  strategy: LearningStrategy;
  taskType: string;
  improvement: number;
  duration: number;
  sideEffects: string[];
  timestamp: Date;
}

/** 自适应配置 */
interface AdaptiveConfig {
  minSamplesForStrategySwitch: number;    // 策略切换最小样本数
  explorationRate: number;                // 探索率（尝试新策略的概率）
  curriculumPace: 'conservative' | 'moderate' | 'aggressive';
  maxConcurrentTasks: number;
}

export class AdaptiveLearningSystem extends EventEmitter {
  private config: AdaptiveConfig;
  private tasks: LearningTask[] = [];
  private effectHistory: LearningEffectRecord[] = [];
  private environmentHistory: EnvironmentState[] = [];
  private strategyPerformance: Map<LearningStrategy, { totalGain: number; count: number; avgGain: number }> = new Map();
  private currentStrategy: LearningStrategy = 'curriculum';

  constructor(config?: Partial<AdaptiveConfig>) {
    super();
    this.config = {
      minSamplesForStrategySwitch: 10,
      explorationRate: 0.15,
      curriculumPace: 'moderate',
      maxConcurrentTasks: 3,
      ...config,
    };

    this.initializeStrategyPerformance();
  }

  /**
   * 感知环境变化
   */
  senseEnvironment(interactionData: {
    taskCategories: string[];
    difficulties: number[];
    errors: string[];
    satisfactionTrend: 'improving' | 'stable' | 'declining';
  }): EnvironmentState {
    // 计算任务分布
    const taskDistribution = new Map<string, number>();
    for (const cat of interactionData.taskCategories) {
      taskDistribution.set(cat, (taskDistribution.get(cat) || 0) + 1);
    }

    // 计算平均难度
    const avgDifficulty = interactionData.difficulties.length > 0
      ? interactionData.difficulties.reduce((a, b) => a + b, 0) / interactionData.difficulties.length
      : 2;

    // 检测新领域
    const knownDomains = new Set(['code', 'data', 'security', 'devops', 'research', 'writing', 'math', 'design']);
    const newDomainDetected = interactionData.taskCategories.some(cat => !knownDomains.has(cat));

    const state: EnvironmentState = {
      taskDistribution,
      avgDifficulty,
      errorPatterns: [...new Set(interactionData.errors)],
      userSatisfactionTrend: interactionData.satisfactionTrend,
      newDomainDetected,
      timestamp: new Date(),
    };

    this.environmentHistory.push(state);

    // 限制历史
    if (this.environmentHistory.length > 100) {
      this.environmentHistory = this.environmentHistory.slice(-50);
    }

    // 根据环境变化调整策略
    this.adaptStrategy(state);

    this.emit('environment_sensed', state);

    return state;
  }

  /**
   * 自适应策略调整
   */
  adaptStrategy(envState: EnvironmentState): LearningStrategy {
    const previousStrategy = this.currentStrategy;

    // 基于环境状态选择策略
    if (envState.newDomainDetected) {
      // 新领域：使用迁移学习
      this.currentStrategy = 'transfer';
    } else if (envState.errorPatterns.length > 3) {
      // 多种错误模式：使用主动学习重点攻克
      this.currentStrategy = 'active_learning';
    } else if (envState.userSatisfactionTrend === 'declining') {
      // 满意度下降：使用强化学习快速调整
      this.currentStrategy = 'reinforcement';
    } else if (envState.avgDifficulty < 2) {
      // 任务简单：使用课程学习逐步提升
      this.currentStrategy = 'curriculum';
    } else if (envState.avgDifficulty > 4) {
      // 任务困难：使用元学习学习如何应对
      this.currentStrategy = 'meta_learning';
    } else {
      // 默认：基于历史效果选择最优策略
      this.currentStrategy = this.selectBestStrategy();
    }

    // 探索：以一定概率尝试新策略
    if (Math.random() < this.config.explorationRate) {
      const strategies: LearningStrategy[] = ['supervised', 'self_supervised', 'reinforcement', 'curriculum', 'transfer', 'meta_learning', 'active_learning'];
      this.currentStrategy = strategies[Math.floor(Math.random() * strategies.length)];
    }

    if (previousStrategy !== this.currentStrategy) {
      this.emit('strategy_changed', { from: previousStrategy, to: this.currentStrategy, reason: this.getStrategyChangeReason(envState) });
    }

    return this.currentStrategy;
  }

  /**
   * 创建学习任务
   */
  createLearningTask(task: Omit<LearningTask, 'id' | 'status' | 'result' | 'createdAt'>): string {
    const id = `lt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const fullTask: LearningTask = {
      ...task,
      id,
      status: 'pending',
      createdAt: new Date(),
    };

    this.tasks.push(fullTask);
    this.emit('task_created', fullTask);

    return id;
  }

  /**
   * 执行学习任务
   */
  async executeTask(taskId: string, executor: (task: LearningTask) => Promise<number>): Promise<LearningTaskResult> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return { improvement: 0, confidence: 0, sideEffects: ['任务不存在'] };
    }

    task.status = 'in_progress';
    const startTime = Date.now();

    try {
      const improvement = await executor(task);

      const result: LearningTaskResult = {
        improvement,
        confidence: Math.min(0.5 + improvement * 2, 0.95),
        sideEffects: [],
      };

      task.result = result;
      task.status = 'completed';

      // 记录学习效果
      this.recordEffect(task.strategy, task.type, improvement, Date.now() - startTime, []);

      this.emit('task_completed', task);

      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      task.status = 'failed';
      const result: LearningTaskResult = {
        improvement: 0,
        confidence: 0,
        sideEffects: [`执行失败: ${msg}`],
      };
      task.result = result;

      this.emit('task_failed', task);

      return result;
    }
  }

  /**
   * 生成课程学习计划
   */
  generateCurriculum(targetCapability: string, currentLevel: number, targetLevel: number): LearningTask[] {
    const steps = Math.ceil(targetLevel - currentLevel);
    const curriculum: LearningTask[] = [];

    let paceMultiplier: number;
    if (this.config.curriculumPace === 'conservative') {
      paceMultiplier = 0.5;
    } else if (this.config.curriculumPace === 'aggressive') {
      paceMultiplier = 2.0;
    } else {
      paceMultiplier = 1.0;
    }

    for (let i = 0; i < steps; i++) {
      const difficulty = currentLevel + (i + 1) * paceMultiplier;
      if (difficulty > targetLevel) break;

      curriculum.push({
        id: `curr_${Date.now()}_${i}`,
        type: 'skill_acquisition',
        description: `${targetCapability} - 难度等级 ${difficulty.toFixed(1)}`,
        difficulty: Math.min(difficulty, 5),
        priority: 10 - i,
        estimatedGain: 0.1 * paceMultiplier,
        strategy: 'curriculum',
        status: 'pending',
        createdAt: new Date(),
      });
    }

    return curriculum;
  }

  /**
   * 获取当前策略
   */
  getCurrentStrategy(): LearningStrategy {
    return this.currentStrategy;
  }

  // ========== P1-5: 增量学习模块 ==========

  /** 知识项（增量学习） */
  private knowledgeStore: Map<string, {
    id: string;
    content: string;
    weight: number;
    lastAccessed: number;
    accessCount: number;
    source: 'web' | 'user' | 'inference' | 'skill';
    conflictsWith?: string[];
    /** P1-5 真实升级：知识项的语义向量（注入 EmbeddingProvider 后异步生成） */
    vector?: number[];
  }> = new Map();

  /**
   * P1-5 真实升级：可注入的语义嵌入提供者
   *
   * 注入后：
   * - absorbKnowledgeAsync() 会异步生成知识向量并存储
   * - recallKnowledgeAsync() 使用真实向量相似度（余弦相似度）召回
   * 未注入时：
   * - absorbKnowledge / recallKnowledge 保持原有关键词匹配行为（合理降级）
   */
  private embeddingProvider: EmbeddingProvider | null = null;

  /**
   * P1-5: 新知识吸收 — web_search 获取的新信息 → 存储
   * 支持增量学习，不遗忘旧知识
   */
  absorbKnowledge(content: string, source: 'web' | 'user' | 'inference' | 'skill' = 'inference'): string {
    const id = `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.knowledgeStore.set(id, {
      id,
      content,
      weight: 1.0,
      lastAccessed: Date.now(),
      accessCount: 0,
      source,
    });
    this.emit('knowledge_absorbed', { id, source });
    return id;
  }

  /**
   * P1-5: 知识巩固 — 高频使用知识提升权重，低频知识衰减
   * 基于艾宾浩斯遗忘曲线
   */
  consolidateKnowledge(): void {
    const now = Date.now();
    for (const [_id, item] of this.knowledgeStore) {
      const daysSinceAccess = (now - item.lastAccessed) / (1000 * 60 * 60 * 24);
      // 遗忘曲线：权重随时间衰减
      const decayFactor = Math.exp(-daysSinceAccess / 7);
      // 访问频率提升权重
      const frequencyBoost = Math.log(item.accessCount + 1) * 0.1;
      item.weight = Math.max(0.1, decayFactor + frequencyBoost);
    }
  }

  /**
   * P1-5: 知识召回 — 根据查询召回相关知识
   *
   * 真实性说明：
   * - 未注入 EmbeddingProvider：使用关键词匹配（原行为，合理降级）
   * - 已注入 EmbeddingProvider：仍用关键词匹配（同步路径无法 await）
   *   要获取真实语义召回，请使用 recallKnowledgeAsync()
   */
  recallKnowledge(query: string, topK = 5): Array<{ id: string; content: string; weight: number }> {
    const results: Array<{ id: string; content: string; weight: number; score: number }> = [];
    const queryLower = query.toLowerCase();
    for (const [id, item] of this.knowledgeStore) {
      // 关键词匹配（降级路径；真实语义召回见 recallKnowledgeAsync）
      const contentLower = item.content.toLowerCase();
      let matchScore = 0;
      for (const word of queryLower.split(/\s+/)) {
        if (word.length > 1 && contentLower.includes(word)) {
          matchScore += 1;
        }
      }
      if (matchScore > 0) {
        // 更新访问记录
        item.lastAccessed = Date.now();
        item.accessCount++;
        results.push({ id, content: item.content, weight: item.weight, score: matchScore * item.weight });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * P1-5 真实升级：注入语义嵌入提供者
   *
   * @param provider EmbeddingProvider 实例（OpenAI/TF-IDF/Composite 之一）
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    this.embeddingProvider = provider;
    if (provider) {
      logger.info('[AdaptiveLearning] P1-5 已注入语义嵌入提供者', {
        provider: provider.name,
        dimension: provider.dimension,
        isSemantic: provider.isSemantic,
      });
    } else {
      logger.info('[AdaptiveLearning] P1-5 嵌入提供者已移除，降级为关键词匹配');
    }
  }

  /** P1-5: 查询是否已注入真实语义嵌入提供者 */
  hasSemanticProvider(): boolean {
    return this.embeddingProvider !== null;
  }

  /**
   * P1-5 真实升级：异步吸收知识 — 优先生成真实语义向量
   *
   * 已注入 provider 时调用 provider.embed(content) 生成真实语义向量并存储；
   * 否则降级为同步 absorbKnowledge（不生成向量）。
   */
  async absorbKnowledgeAsync(
    content: string,
    source: 'web' | 'user' | 'inference' | 'skill' = 'inference',
  ): Promise<{ id: string; vectorGenerated: boolean }> {
    const id = `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let vector: number[] | undefined;

    if (this.embeddingProvider) {
      try {
        vector = await this.embeddingProvider.embed(content);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[AdaptiveLearning] P1-5 语义向量生成失败，仅存储文本', {
          error: msg,
        });
      }
    }

    this.knowledgeStore.set(id, {
      id,
      content,
      weight: 1.0,
      lastAccessed: Date.now(),
      accessCount: 0,
      source,
      vector,
    });

    return { id, vectorGenerated: !!vector };
  }

  /**
   * P1-5 真实升级：异步语义召回 — 使用真实向量相似度（余弦相似度）
   *
   * 真实性说明（非 stub）：
   * - 已注入 provider 且知识库中有向量：真实计算查询向量与知识向量的余弦相似度
   * - 未注入 provider 或无向量知识：降级为关键词匹配（recallKnowledge）
   *
   * @returns 召回结果 + 使用的召回源（semantic-provider / keyword-fallback）
   */
  async recallKnowledgeAsync(
    query: string,
    topK = 5,
  ): Promise<{
    results: Array<{ id: string; content: string; weight: number }>;
    source: 'semantic-provider' | 'keyword-fallback';
  }> {
    // 检查是否有 provider 且知识库中有向量化的知识
    const hasVectors = Array.from(this.knowledgeStore.values()).some(k => k.vector);
    if (!this.embeddingProvider || !hasVectors) {
      const syncResults = this.recallKnowledge(query, topK);
      return { results: syncResults, source: 'keyword-fallback' };
    }

    // 真实生成查询向量
    let queryVec: number[];
    try {
      queryVec = await this.embeddingProvider!.embed(query);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[AdaptiveLearning] P1-5 查询向量生成失败，降级为关键词匹配', {
        error: msg,
      });
      const syncResults = this.recallKnowledge(query, topK);
      return { results: syncResults, source: 'keyword-fallback' };
    }

    // 真实计算余弦相似度并排序
    const scored: Array<{ id: string; content: string; weight: number; score: number }> = [];
    for (const [id, item] of this.knowledgeStore) {
      if (!item.vector) continue; // 跳过无向量的知识项（旧数据）
      const sim = cosineSimilarity(queryVec, item.vector);
      if (sim > 0) {
        // 更新访问记录
        item.lastAccessed = Date.now();
        item.accessCount++;
        // 综合分数 = 语义相似度 × 知识权重
        scored.push({ id, content: item.content, weight: item.weight, score: sim * item.weight });
      }
    }

    const results = scored.sort((a, b) => b.score - a.score).slice(0, topK);
    return { results, source: 'semantic-provider' };
  }

  /**
   * P1-5: 遗忘曲线复习 — 返回需要复习的知识
   * 基于艾宾浩斯曲线的复习间隔：1, 3, 7, 15, 30 天
   */
  scheduleReview(): Array<{ id: string; content: string; daysSinceAccess: number }> {
    const now = Date.now();
    const reviewIntervals = [1, 3, 7, 15, 30];
    const toReview: Array<{ id: string; content: string; daysSinceAccess: number }> = [];
    for (const [id, item] of this.knowledgeStore) {
      if (item.weight < 0.5) continue; // 低权重知识不复习
      const daysSinceAccess = (now - item.lastAccessed) / (1000 * 60 * 60 * 24);
      if (reviewIntervals.some(interval => Math.abs(daysSinceAccess - interval) < 0.5)) {
        toReview.push({ id, content: item.content, daysSinceAccess });
      }
    }
    return toReview;
  }

  /**
   * P1-5: 获取知识库统计
   */
  getKnowledgeStats(): { total: number; bySource: Record<string, number>; avgWeight: number } {
    const bySource: Record<string, number> = {};
    let totalWeight = 0;
    for (const item of this.knowledgeStore.values()) {
      bySource[item.source] = (bySource[item.source] || 0) + 1;
      totalWeight += item.weight;
    }
    return {
      total: this.knowledgeStore.size,
      bySource,
      avgWeight: this.knowledgeStore.size > 0 ? totalWeight / this.knowledgeStore.size : 0,
    };
  }

  /**
   * 获取策略效果统计
   */
  getStrategyStats(): Map<LearningStrategy, { totalGain: number; count: number; avgGain: number }> {
    return new Map(this.strategyPerformance);
  }

  /**
   * 获取待执行任务
   */
  getPendingTasks(limit: number = 10): LearningTask[] {
    return this.tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => b.priority - a.priority)
      .slice(0, limit);
  }

  /**
   * 获取学习效果历史
   */
  getEffectHistory(strategy?: LearningStrategy): LearningEffectRecord[] {
    if (strategy) {
      return this.effectHistory.filter(e => e.strategy === strategy);
    }
    return [...this.effectHistory];
  }

  /**
   * 生成学习报告
   */
  generateReport(): string {
    const lines: string[] = [];
    const completedTasks = this.tasks.filter(t => t.status === 'completed');
    const failedTasks = this.tasks.filter(t => t.status === 'failed');
    const totalImprovement = completedTasks.reduce((sum, t) => sum + (t.result?.improvement || 0), 0);

    lines.push('📚 自适应学习报告');
    lines.push('');
    lines.push('━━━ 当前状态 ━━━');
    lines.push(`当前策略: ${this.currentStrategy}`);
    lines.push(`探索率: ${(this.config.explorationRate * 100).toFixed(0)}%`);
    lines.push(`课程节奏: ${this.config.curriculumPace}`);
    lines.push('');

    lines.push('━━━ 学习统计 ━━━');
    lines.push(`总任务: ${this.tasks.length}`);
    lines.push(`已完成: ${completedTasks.length}`);
    lines.push(`失败: ${failedTasks.length}`);
    lines.push(`总改进量: ${(totalImprovement * 100).toFixed(1)}%`);
    lines.push('');

    lines.push('━━━ 策略效果 ━━━');
    for (const [strategy, perf] of this.strategyPerformance) {
      const icon = strategy === this.currentStrategy ? '👉' : '  ';
      lines.push(`${icon} ${strategy}: 平均改进 ${(perf.avgGain * 100).toFixed(1)}% (${perf.count}次)`);
    }

    return lines.join('\n');
  }

  // ========== 私有方法 ==========

  private initializeStrategyPerformance(): void {
    const strategies: LearningStrategy[] = ['supervised', 'self_supervised', 'reinforcement', 'curriculum', 'transfer', 'meta_learning', 'active_learning'];
    for (const strategy of strategies) {
      this.strategyPerformance.set(strategy, { totalGain: 0, count: 0, avgGain: 0 });
    }
  }

  private selectBestStrategy(): LearningStrategy {
    let bestStrategy: LearningStrategy = 'curriculum';
    let bestGain = 0;

    for (const [strategy, perf] of this.strategyPerformance) {
      if (perf.count >= this.config.minSamplesForStrategySwitch && perf.avgGain > bestGain) {
        bestGain = perf.avgGain;
        bestStrategy = strategy;
      }
    }

    return bestStrategy;
  }

  private recordEffect(strategy: LearningStrategy, taskType: string, improvement: number, duration: number, sideEffects: string[]): void {
    this.effectHistory.push({
      strategy,
      taskType,
      improvement,
      duration,
      sideEffects,
      timestamp: new Date(),
    });

    // 更新策略性能
    const perf = this.strategyPerformance.get(strategy);
    if (perf) {
      perf.totalGain += improvement;
      perf.count++;
      perf.avgGain = perf.totalGain / perf.count;
    }

    // 限制历史
    if (this.effectHistory.length > 1000) {
      this.effectHistory = this.effectHistory.slice(-500);
    }
  }

  private getStrategyChangeReason(envState: EnvironmentState): string {
    if (envState.newDomainDetected) return '检测到新领域';
    if (envState.errorPatterns.length > 3) return '多种错误模式';
    if (envState.userSatisfactionTrend === 'declining') return '满意度下降';
    if (envState.avgDifficulty < 2) return '任务较简单';
    if (envState.avgDifficulty > 4) return '任务较困难';
    return '基于历史效果优化';
  }
}
