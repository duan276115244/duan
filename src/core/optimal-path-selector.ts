/**
 * 最优捷径选择器 — OptimalPathSelector
 *
 * 让 Agent 面对复杂任务时学会思考最优捷径
 *
 * 核心能力：
 * 1. 路径评估 — 多维度评估执行路径（成功率、耗时、token消耗、复杂度）
 * 2. 捷径识别 — 识别可跳过/并行/合并的步骤
 * 3. 路径推荐 — 基于历史数据推荐最优执行路径
 * 4. 动态规划 — 根据实时反馈调整路径
 * 5. A/B 对比 — 对比不同路径的效果
 *
 * 评估维度：
 * - 成功率（权重 40%）：历史成功概率
 * - 耗时（权重 25%）：预估执行时间
 * - Token 消耗（权重 20%）：API 调用成本
 * - 复杂度（权重 15%）：步骤数量和依赖关系
 *
 * 复用：
 * - experience-pack-system.ts（历史经验）
 * - local-inference-engine.ts（本地推理）
 */

import { logger } from './structured-logger.js';
import type { ExperiencePackSystem, ExperiencePack } from './experience-pack-system.js';

// ============ 类型定义 ============

export interface ExecutionPath {
  /** 路径 ID */
  id: string;
  /** 路径名称 */
  name: string;
  /** 步骤列表 */
  steps: PathStep[];
  /** 来源经验包 ID（如果有） */
  sourceExperienceId?: string;
  /** 预估总耗时（ms） */
  estimatedDurationMs: number;
  /** 预估 token 消耗 */
  estimatedTokens: number;
  /** 历史成功率（0-1） */
  successRate: number;
  /** 历史执行次数 */
  executionCount: number;
  /** 路径评分（0-100） */
  score: number;
}

export interface PathStep {
  /** 步骤 ID */
  id: string;
  /** 描述 */
  description: string;
  /** 工具 */
  tool?: string;
  /** 是否可跳过 */
  skippable?: boolean;
  /** 是否可并行 */
  parallelizable?: boolean;
  /** 是否可合并 */
  mergeable?: boolean;
  /** 依赖步骤 */
  dependsOn?: string[];
  /** 预估耗时（ms） */
  estimatedDurationMs?: number;
  /** 预估 token */
  estimatedTokens?: number;
}

export interface PathEvaluation {
  path: ExecutionPath;
  dimensions: {
    successRate: number;     // 0-1
    timeEfficiency: number;  // 0-1
    tokenEfficiency: number; // 0-1
    simplicity: number;      // 0-1
  };
  totalScore: number;
  shortcuts: Shortcut[];
  recommendation: string;
}

export interface Shortcut {
  type: 'skip' | 'parallel' | 'merge' | 'reuse_experience' | 'local_inference';
  description: string;
  targetStepIds: string[];
  estimatedSavingMs: number;
  estimatedSavingTokens: number;
  confidence: number;
}

export interface PathRecommendation {
  recommendedPath: ExecutionPath;
  alternativePaths: ExecutionPath[];
  evaluation: PathEvaluation;
  reasoning: string;
  estimatedSavings: {
    timeMs: number;
    tokens: number;
    successRateImprovement: number;
  };
}

// ============ 最优捷径选择器 ============

export class OptimalPathSelector {
  private experienceSystem: ExperiencePackSystem;
  private pathHistory: Map<string, ExecutionPath[]> = new Map(); // taskSignature -> paths
  private readonly maxHistoryPerTask = 10;

  /** 评估权重 */
  private readonly weights = {
    successRate: 0.40,
    timeEfficiency: 0.25,
    tokenEfficiency: 0.20,
    simplicity: 0.15,
  };

  constructor(experienceSystem: ExperiencePackSystem) {
    this.experienceSystem = experienceSystem;
  }

  /**
   * 为任务选择最优执行路径
   */
  selectOptimalPath(
    task: string,
    candidatePaths: ExecutionPath[],
    context?: {
      preferSpeed?: boolean;
      preferTokenSaving?: boolean;
      maxDurationMs?: number;
      maxTokens?: number;
    },
  ): PathRecommendation {
    logger.info('选择最优路径', {
      module: 'OptimalPathSelector',
      task: task.substring(0, 80),
      candidates: candidatePaths.length,
    });

    // 1. 从经验系统获取匹配经验
    const experienceMatches = this.experienceSystem.match(task, 5);

    // 2. 如果有高匹配经验，构建经验路径
    if (experienceMatches.length > 0 && experienceMatches[0].canReuseDirectly) {
      const expPath = this.buildPathFromExperience(experienceMatches[0].experience);
      candidatePaths = [expPath, ...candidatePaths];
    }

    // 3. 评估所有候选路径
    const evaluations = candidatePaths.map(p => this.evaluatePath(p, task, experienceMatches));

    // 4. 识别捷径
    for (const evaluation of evaluations) {
      evaluation.shortcuts = this.identifyShortcuts(evaluation.path, experienceMatches);
    }

    // 5. 应用上下文偏好调整评分
    if (context?.preferSpeed) {
      for (const eval_ of evaluations) {
        eval_.totalScore = eval_.totalScore * 0.7 + eval_.dimensions.timeEfficiency * 30;
      }
    }
    if (context?.preferTokenSaving) {
      for (const eval_ of evaluations) {
        eval_.totalScore = eval_.totalScore * 0.7 + eval_.dimensions.tokenEfficiency * 30;
      }
    }

    // 6. 过滤不满足约束的路径
    let filtered = evaluations;
    if (context?.maxDurationMs) {
      filtered = filtered.filter(e => e.path.estimatedDurationMs <= context.maxDurationMs!);
    }
    if (context?.maxTokens) {
      filtered = filtered.filter(e => e.path.estimatedTokens <= context.maxTokens!);
    }
    if (filtered.length === 0) filtered = evaluations; // 全部超约束则不过滤

    // 7. 排序选择最优
    filtered.sort((a, b) => b.totalScore - a.totalScore);
    const best = filtered[0];
    const alternatives = filtered.slice(1, 3);

    // 8. 计算节省
    const baseline = evaluations.find(e => !e.path.sourceExperienceId);
    const savings = this.calculateSavings(best, baseline);

    // 9. 生成推荐
    const recommendation: PathRecommendation = {
      recommendedPath: best.path,
      alternativePaths: alternatives.map(a => a.path),
      evaluation: best,
      reasoning: this.generateReasoning(best, experienceMatches, savings),
      estimatedSavings: savings,
    };

    logger.info('最优路径已选择', {
      module: 'OptimalPathSelector',
      pathName: best.path.name,
      score: best.totalScore.toFixed(1),
      shortcuts: best.shortcuts.length,
      savingsTokens: savings.tokens,
    });

    return recommendation;
  }

  /**
   * 评估单条路径
   */
  evaluatePath(
    path: ExecutionPath,
    task: string,
    experienceMatches?: Array<{ experience: ExperiencePack; score: number }>,
  ): PathEvaluation {
    // 维度1: 成功率
    const successRate = this.computeSuccessRate(path, experienceMatches);

    // 维度2: 时间效率（与基准比较）
    const baselineTime = this.estimateBaselineTime(task, path.steps.length);
    const timeEfficiency = Math.min(1, baselineTime / Math.max(path.estimatedDurationMs, 1));

    // 维度3: Token 效率
    const baselineTokens = this.estimateBaselineTokens(task, path.steps.length);
    const tokenEfficiency = Math.min(1, baselineTokens / Math.max(path.estimatedTokens, 1));

    // 维度4: 简洁性（步骤越少越好）
    const simplicity = Math.max(0, 1 - (path.steps.length - 1) / 10);

    // 总分
    const totalScore =
      successRate * this.weights.successRate * 100 +
      timeEfficiency * this.weights.timeEfficiency * 100 +
      tokenEfficiency * this.weights.tokenEfficiency * 100 +
      simplicity * this.weights.simplicity * 100;

    return {
      path,
      dimensions: { successRate, timeEfficiency, tokenEfficiency, simplicity },
      totalScore,
      shortcuts: [],
      recommendation: this.generatePathRecommendation(path, successRate, timeEfficiency, tokenEfficiency),
    };
  }

  /**
   * 识别捷径（可跳过/并行/合并/复用经验）
   */
  identifyShortcuts(
    path: ExecutionPath,
    experienceMatches?: Array<{ experience: ExperiencePack; score: number }>,
  ): Shortcut[] {
    const shortcuts: Shortcut[] = [];

    // 捷径1: 可跳过的步骤
    for (const step of path.steps) {
      if (step.skippable) {
        shortcuts.push({
          type: 'skip',
          description: `跳过步骤"${step.description}"（标记为可跳过）`,
          targetStepIds: [step.id],
          estimatedSavingMs: step.estimatedDurationMs || 1000,
          estimatedSavingTokens: step.estimatedTokens || 50,
          confidence: 0.7,
        });
      }
    }

    // 捷径2: 可并行的步骤
    const parallelGroups = this.findParallelGroups(path.steps);
    for (const group of parallelGroups) {
      const maxDuration = Math.max(...group.map(s => s.estimatedDurationMs || 1000));
      const totalDuration = group.reduce((s, step) => s + (step.estimatedDurationMs || 1000), 0);
      shortcuts.push({
        type: 'parallel',
        description: `并行执行 ${group.length} 个独立步骤: ${group.map(s => s.description).join(', ')}`,
        targetStepIds: group.map(s => s.id),
        estimatedSavingMs: totalDuration - maxDuration,
        estimatedSavingTokens: 0,
        confidence: 0.8,
      });
    }

    // 捷径3: 可合并的步骤
    const mergeableGroups = this.findMergeableGroups(path.steps);
    for (const group of mergeableGroups) {
      shortcuts.push({
        type: 'merge',
        description: `合并 ${group.length} 个相似步骤: ${group.map(s => s.description).join(' + ')}`,
        targetStepIds: group.map(s => s.id),
        estimatedSavingMs: 500 * (group.length - 1),
        estimatedSavingTokens: 30 * (group.length - 1),
        confidence: 0.6,
      });
    }

    // 捷径4: 经验复用
    if (experienceMatches && experienceMatches.length > 0) {
      const bestMatch = experienceMatches[0];
      if (bestMatch.score > 0.7) {
        shortcuts.push({
          type: 'reuse_experience',
          description: `复用历史经验"${bestMatch.experience.name}"（相似度=${(bestMatch.score * 100).toFixed(0)}%）`,
          targetStepIds: path.steps.map(s => s.id), // 全部步骤可被经验替代
          estimatedSavingMs: path.estimatedDurationMs * 0.7,
          estimatedSavingTokens: path.estimatedTokens, // 经验复用零 token
          confidence: bestMatch.score,
        });
      }
    }

    // 捷径5: 本地推理（简单步骤用 NN 替代 LLM）
    for (const step of path.steps) {
      if (step.estimatedTokens && step.estimatedTokens > 100 && this.isSimpleStep(step)) {
        shortcuts.push({
          type: 'local_inference',
          description: `步骤"${step.description}"可用本地推理替代 LLM`,
          targetStepIds: [step.id],
          estimatedSavingMs: 0,
          estimatedSavingTokens: step.estimatedTokens,
          confidence: 0.6,
        });
      }
    }

    return shortcuts;
  }

  /**
   * 应用捷径优化路径
   */
  applyShortcuts(path: ExecutionPath, shortcuts: Shortcut[]): ExecutionPath {
    let optimizedSteps = [...path.steps];
    let savedMs = 0;
    let savedTokens = 0;

    // 按类型应用
    for (const shortcut of shortcuts) {
      switch (shortcut.type) {
        case 'skip':
          // 移除可跳过步骤
          optimizedSteps = optimizedSteps.filter(s => !shortcut.targetStepIds.includes(s.id));
          savedMs += shortcut.estimatedSavingMs;
          savedTokens += shortcut.estimatedSavingTokens;
          break;

        case 'merge':
          // 合并步骤（保留第一个，移除其余）
          if (shortcut.targetStepIds.length > 1) {
            const firstIdx = optimizedSteps.findIndex(s => s.id === shortcut.targetStepIds[0]);
            if (firstIdx >= 0) {
              optimizedSteps[firstIdx].description += ` (合并: ${shortcut.targetStepIds.length}步)`;
              optimizedSteps = optimizedSteps.filter((s, i) =>
                i <= firstIdx || !shortcut.targetStepIds.includes(s.id),
              );
              savedMs += shortcut.estimatedSavingMs;
              savedTokens += shortcut.estimatedSavingTokens;
            }
          }
          break;

        case 'reuse_experience':
          // 经验复用：标记为本地执行（零 token）
          for (const step of optimizedSteps) {
            if (shortcut.targetStepIds.includes(step.id)) {
              step.estimatedTokens = 0;
            }
          }
          savedTokens += shortcut.estimatedSavingTokens;
          savedMs += shortcut.estimatedSavingMs;
          break;

        case 'local_inference':
          // 本地推理：token 设为 0
          for (const step of optimizedSteps) {
            if (shortcut.targetStepIds.includes(step.id)) {
              step.estimatedTokens = 0;
            }
          }
          savedTokens += shortcut.estimatedSavingTokens;
          break;

        case 'parallel':
          // 并行：耗时取最大值（已在 identifyShortcuts 中计算节省）
          savedMs += shortcut.estimatedSavingMs;
          break;
      }
    }

    // 由 applyShortcuts 产生的最终路径指标，与原路径做差值统一计算节省
    const optimizedDurationMs = optimizedSteps.reduce((s, step) => s + (step.estimatedDurationMs || 0), 0);
    const optimizedTokens = optimizedSteps.reduce((s, step) => s + (step.estimatedTokens || 0), 0);

    return {
      ...path,
      steps: optimizedSteps,
      estimatedDurationMs: Math.max(0, optimizedDurationMs),
      estimatedTokens: Math.max(0, optimizedTokens),
      name: `${path.name} (优化)`,
    };
  }

  /**
   * 记录路径执行结果（用于学习）
   */
  recordPathOutcome(
    task: string,
    path: ExecutionPath,
    outcome: { success: boolean; actualDurationMs: number; actualTokens: number },
  ): void {
    const signature = this.computeTaskSignature(task);

    if (!this.pathHistory.has(signature)) {
      this.pathHistory.set(signature, []);
    }

    const paths = this.pathHistory.get(signature)!;

    // 更新已有路径的统计
    const existing = paths.find(p => p.id === path.id);
    if (existing) {
      existing.executionCount++;
      existing.successRate = (existing.successRate * (existing.executionCount - 1) + (outcome.success ? 1 : 0)) / existing.executionCount;
      existing.estimatedDurationMs = (existing.estimatedDurationMs * (existing.executionCount - 1) + outcome.actualDurationMs) / existing.executionCount;
      existing.estimatedTokens = (existing.estimatedTokens * (existing.executionCount - 1) + outcome.actualTokens) / existing.executionCount;
    } else {
      paths.push({
        ...path,
        executionCount: 1,
        successRate: outcome.success ? 1 : 0,
        estimatedDurationMs: outcome.actualDurationMs,
        estimatedTokens: outcome.actualTokens,
      });
    }

    // 限制历史数量
    if (paths.length > this.maxHistoryPerTask) {
      paths.sort((a, b) => b.successRate - a.successRate);
      this.pathHistory.set(signature, paths.slice(0, this.maxHistoryPerTask));
    }

    logger.debug('路径执行结果已记录', {
      module: 'OptimalPathSelector',
      pathId: path.id,
      success: outcome.success,
      durationMs: outcome.actualDurationMs,
    });
  }

  /**
   * 获取任务的历史路径
   */
  getHistoricalPaths(task: string): ExecutionPath[] {
    const signature = this.computeTaskSignature(task);
    return this.pathHistory.get(signature) || [];
  }

  // ========== 内部方法 ==========

  /** 从经验包构建执行路径 */
  private buildPathFromExperience(exp: ExperiencePack): ExecutionPath {
    const steps: PathStep[] = exp.steps.map((s, i) => ({
      id: `step_${i + 1}`,
      description: s.description,
      tool: s.tool,
      estimatedDurationMs: s.actualDurationMs || 1000,
      estimatedTokens: 0, // 经验复用零 token
      parallelizable: !s.tool, // 无工具依赖的步骤可并行
    }));

    return {
      id: `exp_path_${exp.id}`,
      name: `经验路径: ${exp.name}`,
      steps,
      sourceExperienceId: exp.id,
      estimatedDurationMs: steps.reduce((s, step) => s + (step.estimatedDurationMs || 0), 0),
      estimatedTokens: 0, // 经验复用零 token
      successRate: exp.reuseCount > 0 ? exp.reuseSuccessCount / exp.reuseCount : exp.qualityScore / 100,
      executionCount: exp.reuseCount,
      score: 0, // 待评估
    };
  }

  /** 计算成功率维度 */
  private computeSuccessRate(
    path: ExecutionPath,
    experienceMatches?: Array<{ experience: ExperiencePack; score: number }>,
  ): number {
    // 有历史数据
    if (path.executionCount > 0) {
      return path.successRate;
    }

    // 有经验匹配
    if (experienceMatches && experienceMatches.length > 0) {
      const bestMatch = experienceMatches[0];
      const expSuccessRate = bestMatch.experience.reuseCount > 0
        ? bestMatch.experience.reuseSuccessCount / bestMatch.experience.reuseCount
        : bestMatch.experience.qualityScore / 100;
      return expSuccessRate * bestMatch.score;
    }

    // 默认估计
    return 0.5;
  }

  /** 估算基准时间 */
  private estimateBaselineTime(task: string, stepCount: number): number {
    // 基准：每步 3 秒
    return stepCount * 3000;
  }

  /** 估算基准 token */
  private estimateBaselineTokens(task: string, stepCount: number): number {
    // 基准：每步 200 token
    return stepCount * 200;
  }

  /** 查找可并行的步骤组 */
  private findParallelGroups(steps: PathStep[]): PathStep[][] {
    const groups: PathStep[][] = [];
    const parallelSteps = steps.filter(s => s.parallelizable && (!s.dependsOn || s.dependsOn.length === 0));

    // 按工具类型分组（相同工具的步骤可以批量执行）
    const byTool: Map<string, PathStep[]> = new Map();
    for (const step of parallelSteps) {
      const tool = step.tool || 'none';
      if (!byTool.has(tool)) byTool.set(tool, []);
      byTool.get(tool)!.push(step);
    }

    for (const group of byTool.values()) {
      if (group.length > 1) groups.push(group);
    }

    return groups;
  }

  /** 查找可合并的步骤组 */
  private findMergeableGroups(steps: PathStep[]): PathStep[][] {
    const groups: PathStep[][] = [];
    const mergeableSteps = steps.filter(s => s.mergeable);

    // 按工具类型分组
    const byTool: Map<string, PathStep[]> = new Map();
    for (const step of mergeableSteps) {
      const tool = step.tool || 'none';
      if (!byTool.has(tool)) byTool.set(tool, []);
      byTool.get(tool)!.push(step);
    }

    for (const group of byTool.values()) {
      if (group.length > 1) groups.push(group);
    }

    return groups;
  }

  /** 判断是否为简单步骤（可用本地推理） */
  private isSimpleStep(step: PathStep): boolean {
    const desc = step.description.toLowerCase();
    // 简单步骤：查找、读取、列表、检查
    return /search|find|list|check|read|查找|搜索|列表|检查|读取/i.test(desc);
  }

  /** 计算节省 */
  private calculateSavings(best: PathEvaluation, baseline?: PathEvaluation): {
    timeMs: number;
    tokens: number;
    successRateImprovement: number;
  } {

    if (!baseline) {
      return { timeMs: 0, tokens: 0, successRateImprovement: 0 };
    }

    return {
      timeMs: Math.max(0, baseline.path.estimatedDurationMs - best.path.estimatedDurationMs),
      tokens: Math.max(0, baseline.path.estimatedTokens - best.path.estimatedTokens),
      successRateImprovement: Math.max(0, best.dimensions.successRate - baseline.dimensions.successRate),
    };
  }

  /** 生成路径推荐说明 */
  private generatePathRecommendation(
    path: ExecutionPath,
    successRate: number,
    timeEfficiency: number,
    tokenEfficiency: number,
  ): string {
    const parts: string[] = [];
    if (successRate > 0.8) parts.push('高成功率');
    if (timeEfficiency > 0.7) parts.push('快速');
    if (tokenEfficiency > 0.7) parts.push('省 token');
    if (path.steps.length <= 3) parts.push('简洁');
    return parts.length > 0 ? parts.join('、') : '常规路径';
  }

  /** 生成推荐理由 */
  private generateReasoning(
    best: PathEvaluation,
    experienceMatches: Array<{ experience: ExperiencePack; score: number }>,
    savings: { timeMs: number; tokens: number; successRateImprovement: number },
  ): string {
    const parts: string[] = [];

    parts.push(`推荐路径"${best.path.name}"（评分=${best.totalScore.toFixed(1)}/100）`);

    if (best.path.sourceExperienceId) {
      parts.push('该路径基于历史经验，可直接复用执行步骤');
    }

    if (best.shortcuts.length > 0) {
      parts.push(`识别到 ${best.shortcuts.length} 个捷径:`);
      for (const s of best.shortcuts.slice(0, 3)) {
        parts.push(`  • ${s.description}`);
      }
    }

    if (savings.tokens > 0) {
      parts.push(`预计节省 ${savings.tokens} token`);
    }
    if (savings.timeMs > 0) {
      parts.push(`预计节省 ${(savings.timeMs / 1000).toFixed(1)}s`);
    }
    if (savings.successRateImprovement > 0) {
      parts.push(`成功率提升 ${(savings.successRateImprovement * 100).toFixed(0)}%`);
    }

    return parts.join('\n');
  }

  /** 计算任务签名（用于历史匹配） */
  private computeTaskSignature(task: string): string {
    // 简化签名：取关键词
    const words = task.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return words.slice(0, 5).sort().join('_');
  }
}
