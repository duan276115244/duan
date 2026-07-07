/**
 * GEPA 自进化引擎 — GEPAEvolutionEngine
 *
 * 灵感来源 Hermes 框架，实现 Generate-Evaluate-Patch-Analyze 闭环迭代优化 prompt。
 * 核心循环：生成变体 → 评估打分 → 定向修补 → 收敛分析 → 重复直至收敛
 *
 * 收敛条件：
 * - 最近10轮分数提升 < 0.01
 * - 达到最大迭代次数（默认500）
 * - 达到目标分数（默认0.95）
 *
 * 持久化：.duan/gepa-state.json
 * 事件：通过 EventBus 发送 gepa.* 前缀事件
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { ModelLibrary } from './model-library.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJson, atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** GEPA 运行选项 */
export interface GEPAOptions {
  /** 最大迭代次数，默认 500 */
  maxIterations?: number;
  /** 目标分数（0-1），达到后提前停止，默认 0.95 */
  targetScore?: number;
  /** 收敛窗口大小（最近N轮），默认 10 */
  convergenceWindow?: number;
  /** 收敛阈值：窗口内分数提升小于此值视为收敛，默认 0.01 */
  convergenceThreshold?: number;
  /** 每轮生成的变体数量，默认 5 */
  variantsPerCycle?: number;
  /** 评估时使用的模型ID（不指定则Auto） */
  evaluationModelId?: string;
  /** 是否持久化状态，默认 true */
  persistState?: boolean;
  /** 变异算子权重配置 */
  mutationWeights?: Partial<Record<MutationOperator, number>>;
}

/** prompt 变体 */
export interface PromptVariant {
  /** 变体ID */
  id: string;
  /** 变体内容 */
  prompt: string;
  /** 产生该变体的变异算子 */
  mutationOperator: MutationOperator;
  /** 父变体ID（空表示基础prompt） */
  parentId: string;
  /** 评估分数（0-1） */
  score: number;
  /** 评估反馈文本 */
  feedback: string;
  /** 创建时间 */
  createdAt: number;
}

/** 评估分数 */
export interface EvaluationScore {
  /** 总分（0-1） */
  overall: number;
  /** 各评估维度的分数 */
  dimensions: Record<string, number>;
  /** 评估反馈 */
  feedback: string;
}

/** 单轮进化循环记录 */
export interface EvolutionCycle {
  /** 循环序号 */
  iteration: number;
  /** 时间戳 */
  timestamp: number;
  /** 本轮生成的变体 */
  variants: PromptVariant[];
  /** 本轮最佳分数 */
  bestScore: number;
  /** 本轮平均分数 */
  avgScore: number;
  /** 与上一轮最佳分数的差值 */
  scoreDelta: number;
  /** 分数方差（衡量变体间差异） */
  scoreVariance: number;
  /** 是否已收敛 */
  converged: boolean;
  /** 收敛原因 */
  convergenceReason?: string;
}

/** 进化结果 */
export interface EvolutionResult {
  /** 最终最优 prompt */
  bestPrompt: string;
  /** 最终最优分数 */
  bestScore: number;
  /** 总迭代次数 */
  totalIterations: number;
  /** 是否收敛 */
  converged: boolean;
  /** 收敛原因 */
  convergenceReason?: string;
  /** 进化历史 */
  history: EvolutionCycle[];
  /** 最终最优变体 */
  bestVariant: PromptVariant;
  /** 耗时（ms） */
  elapsedMs: number;
}

/** 变异算子类型 */
export type MutationOperator =
  | 'paraphrase'         // 改写：用不同措辞表达相同含义
  | 'add_constraint'     // 添加约束：增加明确的限制条件
  | 'remove_redundancy'  // 去冗余：删除重复或无用的部分
  | 'restructure'        // 重构：改变prompt的结构/组织方式
  | 'add_example';       // 添加示例：增加few-shot示例

/** GEPA 持久化状态 */
interface GEPAState {
  taskType: string;
  basePrompt: string;
  evaluationCriteria: string[];
  bestPrompt: string;
  bestScore: number;
  cycles: EvolutionCycle[];
  allVariants: PromptVariant[];
  lastUpdated: number;
}

// ============ P2-2: 行为记录与技能沉淀类型 ============

/** 行为记录 — 记录真实任务执行行为（对标 GEPA 闭环的"行为记录"环节） */
export interface BehaviorRecord {
  /** 行为ID */
  id: string;
  /** 任务类型 */
  taskType: string;
  /** 任务描述 */
  taskDescription: string;
  /** 使用的 prompt（来自 GEPA 优化的最优 prompt） */
  promptUsed: string;
  /** 执行的工具调用序列 */
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; success: boolean }>;
  /** 执行结果 */
  result: 'success' | 'partial' | 'failure';
  /** 效果评分（0-1，基于结果质量） */
  effectScore: number;
  /** 耗时（ms） */
  durationMs: number;
  /** 时间戳 */
  timestamp: number;
  /** 用户反馈（可选） */
  userFeedback?: 'positive' | 'negative' | 'neutral';
  /** 错误信息（若失败） */
  errorMessage?: string;
}

/** 技能记录 — 从行为中提炼的技能（带版本管理） */
export interface SkillRecord {
  /** 技能ID */
  skillId: string;
  /** 任务类型 */
  taskType: string;
  /** 技能标题 */
  title: string;
  /** 技能内容（Markdown 格式） */
  content: string;
  /** 版本号（语义化版本） */
  version: string;
  /** 来源行为ID列表 */
  sourceBehaviorIds: string[];
  /** 父版本ID（版本链） */
  parentVersionId: string | null;
  /** 效果评分（该技能在后续使用中的平均效果） */
  effectScore: number;
  /** 使用次数 */
  usageCount: number;
  /** 成功次数 */
  successCount: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后使用时间 */
  lastUsedAt: number;
  /** 标签 */
  tags: string[];
}

// ============ GEPA 引擎主类 ============

export class GEPAEvolutionEngine {
  private modelLibrary: ModelLibrary;
  private eventBus: EventBus;
  private log = logger.child({ module: 'GEPAEvolutionEngine' });

  /** 按任务类型存储的进化状态 */
  private states: Map<string, GEPAState> = new Map();

  /** P2-2: 行为记录存储（按任务类型分组） */
  private behaviorRecords: Map<string, BehaviorRecord[]> = new Map();

  /** P2-2: 技能记录存储（按 skillId 分组，支持多版本） */
  private skills: Map<string, SkillRecord[]> = new Map();

  /** P2-2: 标记是否已从磁盘加载过技能 — 防止 dispose 后重新加载 */
  private skillsLoadedFromDisk = false;

  /** P2-2: 技能提炼统计（按任务类型） */
  private distillationStats: Map<string, { attempts: number; successes: number }> = new Map();

  /** P2-2: 自动提炼阈值 — 成功行为数达到此值时自动触发技能提炼 */
  private static readonly AUTO_DISTILL_THRESHOLD = 10;

  /** P2-2: 收敛区间 — 验收标准 100-500 次收敛 */
  private static readonly CONVERGENCE_RANGE = { min: 100, max: 500 } as const;

  /** 持久化路径 */
  private stateDir: string;

  /** 默认变异算子权重 */
  private readonly DEFAULT_MUTATION_WEIGHTS: Record<MutationOperator, number> = {
    paraphrase: 1.0,
    add_constraint: 1.2,
    remove_redundancy: 0.8,
    restructure: 1.0,
    add_example: 1.1,
  };

  constructor(modelLibrary?: ModelLibrary, baseDir?: string) {
    // 未注入时回退到进程级单例，与其它消费者共享缓存
    this.modelLibrary = modelLibrary ?? ModelLibrary.getInstance();
    this.eventBus = EventBus.getInstance();
    this.stateDir = baseDir ? path.join(baseDir, '.duan') : duanPath();
  }

  // ========== 核心进化循环 ==========

  /**
   * 执行 GEPA 进化循环，迭代优化 prompt 直至收敛
   */
  async evolvePrompt(
    taskType: string,
    basePrompt: string,
    evaluationCriteria: string[],
    options?: GEPAOptions,
  ): Promise<EvolutionResult> {
    const startTime = Date.now();
    const opts = this.normalizeOptions(options);

    // 初始化或加载状态
    const state = this.getOrCreateState(taskType, basePrompt, evaluationCriteria);

    // 如果已有历史且基础prompt未变，从上次状态继续
    const previousBestScore = state.bestScore;

    const history: EvolutionCycle[] = [...state.cycles];
    let converged = false;
    let convergenceReason: string | undefined;

    this.log.info('GEPA进化开始', {
      taskType,
      maxIterations: opts.maxIterations,
      targetScore: opts.targetScore,
      previousBestScore,
    });

    await this.emitEvent('gepa.evolution.started', {
      taskType,
      maxIterations: opts.maxIterations,
      targetScore: opts.targetScore,
    });

    for (let i = history.length; i < opts.maxIterations; i++) {
      // ===== 1. GENERATE：生成变体 =====
      const parentPrompt = state.bestPrompt || basePrompt;
      const variants = await this.generateVariants(
        parentPrompt,
        opts.variantsPerCycle,
        opts.mutationWeights,
        state.allVariants,
      );

      // ===== 2. EVALUATE：评估每个变体 =====
      const scoredVariants: PromptVariant[] = [];
      for (const variant of variants) {
        const evalScore = await this.evaluateVariant(
          variant.prompt,
          taskType,
          evaluationCriteria,
          opts.evaluationModelId,
        );
        const scored: PromptVariant = {
          ...variant,
          score: evalScore.overall,
          feedback: evalScore.feedback,
        };
        scoredVariants.push(scored);
      }

      // 同时评估当前最佳prompt（作为基准）
      const baselineScore = previousBestScore > 0
        ? previousBestScore
        : (await this.evaluateVariant(state.bestPrompt || basePrompt, taskType, evaluationCriteria, opts.evaluationModelId)).overall;

      // ===== 3. PATCH：对低分变体进行定向修补 =====
      const patchedVariants = await this.patchUnderperformers(
        scoredVariants,
        taskType,
        evaluationCriteria,
        opts.evaluationModelId,
      );

      // 重新评估修补后的变体
      for (const patched of patchedVariants) {
        const patchScore = await this.evaluateVariant(
          patched.prompt,
          taskType,
          evaluationCriteria,
          opts.evaluationModelId,
        );
        // 如果修补后分数更高，替换原变体
        const originalIdx = scoredVariants.findIndex(v => v.id === patched.parentId || v.id === patched.id);
        if (originalIdx >= 0 && patchScore.overall > scoredVariants[originalIdx].score) {
          scoredVariants[originalIdx] = {
            ...patched,
            score: patchScore.overall,
            feedback: patchScore.feedback,
          };
        } else if (originalIdx < 0) {
          scoredVariants.push({
            ...patched,
            score: patchScore.overall,
            feedback: patchScore.feedback,
          });
        }
      }

      // ===== 4. ANALYZE：分析收敛情况 =====
      const cycleBest = Math.max(...scoredVariants.map(v => v.score), baselineScore);
      const cycleAvg = scoredVariants.length > 0
        ? scoredVariants.reduce((s, v) => s + v.score, 0) / scoredVariants.length
        : baselineScore;
      const scoreDelta = cycleBest - (state.bestScore || 0);
      const scoreVariance = this.computeVariance(scoredVariants.map(v => v.score));

      // 更新全局最优
      if (cycleBest > state.bestScore) {
        const bestVariant = scoredVariants.find(v => v.score === cycleBest)!;
        state.bestScore = cycleBest;
        state.bestPrompt = bestVariant.prompt;
      }

      // 记录本轮循环
      const cycle: EvolutionCycle = {
        iteration: i,
        timestamp: Date.now(),
        variants: scoredVariants,
        bestScore: cycleBest,
        avgScore: cycleAvg,
        scoreDelta,
        scoreVariance,
        converged: false,
      };

      history.push(cycle);
      state.cycles = history;
      state.allVariants.push(...scoredVariants);

      // 收敛检测
      const convergenceCheck = this.checkConvergence(history, opts);
      if (convergenceCheck.converged) {
        converged = true;
        convergenceReason = convergenceCheck.reason;
        cycle.converged = true;
        cycle.convergenceReason = convergenceReason;
      }

      // 发送进度事件
      await this.emitEvent('gepa.cycle.completed', {
        taskType,
        iteration: i,
        bestScore: cycleBest,
        scoreDelta,
        converged,
      });

      this.log.debug('GEPA循环完成', {
        taskType,
        iteration: i,
        bestScore: cycleBest.toFixed(4),
        scoreDelta: scoreDelta.toFixed(4),
        converged,
      });

      if (converged) break;
    }

    // 构建最终结果
    const bestVariant: PromptVariant = {
      id: `final_${taskType}`,
      prompt: state.bestPrompt,
      mutationOperator: 'paraphrase',
      parentId: '',
      score: state.bestScore,
      feedback: '',
      createdAt: Date.now(),
    };

    // 从历史中找到实际最优变体
    for (const cycle of history) {
      for (const v of cycle.variants) {
        if (v.score >= state.bestScore && v.prompt === state.bestPrompt) {
          bestVariant.id = v.id;
          bestVariant.mutationOperator = v.mutationOperator;
          bestVariant.parentId = v.parentId;
          bestVariant.feedback = v.feedback;
          bestVariant.createdAt = v.createdAt;
          break;
        }
      }
    }

    const result: EvolutionResult = {
      bestPrompt: state.bestPrompt,
      bestScore: state.bestScore,
      totalIterations: history.length,
      converged,
      convergenceReason,
      history,
      bestVariant,
      elapsedMs: Date.now() - startTime,
    };

    // 持久化
    state.lastUpdated = Date.now();
    this.states.set(taskType, state);
    if (opts.persistState !== false) {
      await this.persistState(taskType);
    }

    await this.emitEvent('gepa.evolution.completed', {
      taskType,
      bestScore: state.bestScore,
      totalIterations: history.length,
      converged,
      elapsedMs: result.elapsedMs,
    });

    this.log.info('GEPA进化完成', {
      taskType,
      bestScore: state.bestScore.toFixed(4),
      totalIterations: history.length,
      converged,
      elapsedMs: result.elapsedMs,
    });

    return result;
  }

  /**
   * 获取指定任务类型的最优prompt
   *
   * P2-2 修复：冷启动时从磁盘加载状态，避免重启后首次任务无 GEPA 提示。
   * 之前只查 in-memory states Map，重启后 Map 为空，getBestPrompt 永远返回 null，
   * 直到 accumulate 10 条行为触发 evolvePrompt 才能恢复。
   */
  getBestPrompt(taskType: string): string | null {
    let state = this.states.get(taskType);
    if (!state) {
      // 冷启动：尝试从磁盘加载
      state = this.loadStateFromDisk(taskType) ?? undefined;
      if (state) {
        this.states.set(taskType, state);
      }
    }
    return state?.bestPrompt ?? null;
  }

  /**
   * 获取指定任务类型的进化历史
   */
  getEvolutionHistory(taskType: string): EvolutionCycle[] {
    const state = this.states.get(taskType);
    return state?.cycles ?? [];
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.states.clear();
    this.behaviorRecords.clear();
    this.skills.clear();
    // P2-2: 标记已加载，防止 dispose 后 findSkillsByTaskType 重新从磁盘加载
    // dispose 意味着引擎停用，不应再自动加载磁盘数据
    this.skillsLoadedFromDisk = true;
  }

  // ========== GENERATE 阶段 ==========

  /**
   * 生成 prompt 变体
   */
  private async generateVariants(
    parentPrompt: string,
    count: number,
    weights?: Partial<Record<MutationOperator, number>>,
    existingVariants?: PromptVariant[],
  ): Promise<PromptVariant[]> {
    const operators = this.selectOperators(count, weights);
    const variants: PromptVariant[] = [];

    for (const op of operators) {
      const variantId = `var_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let mutatedPrompt: string;

      try {
        mutatedPrompt = await this.applyMutation(parentPrompt, op, existingVariants);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('变异算子执行失败，使用基础变异', { operator: op, error: msg });
        mutatedPrompt = this.fallbackMutation(parentPrompt, op);
      }

      variants.push({
        id: variantId,
        prompt: mutatedPrompt,
        mutationOperator: op,
        parentId: '',
        score: 0,
        feedback: '',
        createdAt: Date.now(),
      });
    }

    return variants;
  }

  /**
   * 根据权重选择变异算子
   */
  private selectOperators(
    count: number,
    weights?: Partial<Record<MutationOperator, number>>,
  ): MutationOperator[] {
    const allOps: MutationOperator[] = ['paraphrase', 'add_constraint', 'remove_redundancy', 'restructure', 'add_example'];
    const effectiveWeights: Record<MutationOperator, number> = { ...this.DEFAULT_MUTATION_WEIGHTS };
    if (weights) {
      for (const [op, w] of Object.entries(weights)) {
        if (w !== undefined) {
          effectiveWeights[op as MutationOperator] = w;
        }
      }
    }

    // 加权随机选择（可重复）
    const totalWeight = allOps.reduce((s, op) => s + effectiveWeights[op], 0);
    const selected: MutationOperator[] = [];

    for (let i = 0; i < count; i++) {
      let r = Math.random() * totalWeight;
      for (const op of allOps) {
        r -= effectiveWeights[op];
        if (r <= 0) {
          selected.push(op);
          break;
        }
      }
      // 兜底
      if (selected.length <= i) {
        selected.push(allOps[i % allOps.length]);
      }
    }

    return selected;
  }

  /**
   * 应用变异算子（使用LLM生成变异）
   */
  private async applyMutation(
    prompt: string,
    operator: MutationOperator,
    existingVariants?: PromptVariant[],
  ): Promise<string> {
    const operatorDescriptions: Record<MutationOperator, string> = {
      paraphrase: '用不同的措辞和表达方式重写以下prompt，保持语义不变但换一种表述风格',
      add_constraint: '在以下prompt基础上添加1-2个明确的约束条件或限制，使其更精确',
      remove_redundancy: '精简以下prompt，删除重复、冗余或无关的内容，使其更简洁高效',
      restructure: '重新组织以下prompt的结构，改变信息排列顺序或层次，使其更清晰',
      add_example: '在以下prompt中添加一个具体的示例（few-shot），帮助模型更好理解任务',
    };

    const instruction = operatorDescriptions[operator];

    // 构建上下文：包含已有变体信息以避免重复
    let contextHint = '';
    if (existingVariants && existingVariants.length > 0) {
      const recentPrompts = existingVariants.slice(-3).map(v => v.prompt.substring(0, 80)).join('\n');
      contextHint = `\n\n注意：以下是一些已有的变体（请避免产生相似的结果）：\n${recentPrompts}`;
    }

    const systemMsg = '你是一个prompt工程专家，擅长优化和改进AI系统提示词。只输出改进后的prompt，不要解释。';
    const userMsg = `${instruction}：\n\n---\n${prompt}\n---${contextHint}`;

    try {
      const response = await this.modelLibrary.call(
        [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
        { maxTokens: 2048, temperature: 0.8 },
      );

      const result = response.content.trim();
      // 验证变异结果有效性
      if (result.length < 10) {
        return this.fallbackMutation(prompt, operator);
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('LLM变异调用失败，使用基础变异', { operator, error: msg });
      return this.fallbackMutation(prompt, operator);
    }
  }

  /**
   * 基础变异（LLM不可用时的降级方案）
   */
  private fallbackMutation(prompt: string, operator: MutationOperator): string {
    switch (operator) {
      case 'paraphrase':
        return `请仔细完成以下任务：${prompt}`;
      case 'add_constraint':
        return `${prompt}\n\n约束条件：\n1. 回答必须准确且可验证\n2. 如不确定请明确说明`;
      case 'remove_redundancy':
        // 简单去重：移除连续重复的句子
        return prompt.replace(/([。！？\n])\1+/g, '$1');
      case 'restructure':
        return `## 任务要求\n${prompt}\n\n## 输出格式\n请按步骤给出结果`;
      case 'add_example':
        return `${prompt}\n\n示例：\n输入：典型输入\n输出：期望输出`;
      default:
        return prompt;
    }
  }

  // ========== EVALUATE 阶段 ==========

  /**
   * 评估单个prompt变体
   */
  private async evaluateVariant(
    prompt: string,
    taskType: string,
    criteria: string[],
    modelId?: string,
  ): Promise<EvaluationScore> {
    const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const systemMsg = '你是一个prompt质量评估专家。请严格按照评估标准对prompt进行打分。只输出JSON格式的评估结果。';
    const userMsg = `请评估以下prompt的质量：

任务类型：${taskType}

评估标准：
${criteriaText}

待评估的prompt：
---
${prompt}
---

请按以下JSON格式输出评估结果（不要输出其他内容）：
{
  "overall": 0.0到1.0之间的总分,
  "dimensions": { ${criteria.map(c => `"${c}": 0.0到1.0之间的分数`).join(', ')} },
  "feedback": "具体的改进建议"
}`;

    try {
      const response = await this.modelLibrary.call(
        [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
        { modelId, maxTokens: 1024, temperature: 0.3 },
      );

      const parsed = this.parseEvaluationResponse(response.content, criteria);
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('LLM评估调用失败，使用启发式评估', { error: msg });
      return this.heuristicEvaluation(prompt, criteria);
    }
  }

  /**
   * 解析LLM返回的评估结果
   */
  private parseEvaluationResponse(content: string, criteria: string[]): EvaluationScore {
    try {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        return this.heuristicEvaluation(content, criteria);
      }

      const parsed = JSON.parse(match[0]);
      const overall = typeof parsed.overall === 'number'
        ? Math.max(0, Math.min(1, parsed.overall))
        : 0.5;

      const dimensions: Record<string, number> = {};
      if (parsed.dimensions && typeof parsed.dimensions === 'object') {
        for (const [key, value] of Object.entries(parsed.dimensions)) {
          dimensions[key] = Math.max(0, Math.min(1, value as number));
        }
      } else {
        // 如果没有维度分数，用总分填充
        for (const c of criteria) {
          dimensions[c] = overall;
        }
      }

      return {
        overall,
        dimensions,
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
      };
    } catch {
      return this.heuristicEvaluation(content, criteria);
    }
  }

  /**
   * 启发式评估（LLM不可用时的降级方案）
   */
  private heuristicEvaluation(prompt: string, criteria: string[]): EvaluationScore {
    let score = 0.4;
    const dimensions: Record<string, number> = {};

    // 长度适中加分
    if (prompt.length > 50 && prompt.length < 2000) score += 0.1;
    // 有结构化标记加分
    if (/^\d+\.|^-|^##|^###/m.test(prompt)) score += 0.1;
    // 有约束条件加分
    if (/必须|确保|注意|约束|限制|不要|避免/i.test(prompt)) score += 0.05;
    // 有示例加分
    if (/示例|例如|比如|example/i.test(prompt)) score += 0.05;
    // 过长扣分
    if (prompt.length > 3000) score -= 0.1;
    // 过短扣分
    if (prompt.length < 20) score -= 0.1;

    score = Math.max(0.1, Math.min(0.9, score));

    for (const c of criteria) {
      dimensions[c] = score + (Math.random() - 0.5) * 0.1;
      dimensions[c] = Math.max(0.1, Math.min(0.9, dimensions[c]));
    }

    return {
      overall: score,
      dimensions,
      feedback: '启发式评估（LLM不可用）',
    };
  }

  // ========== PATCH 阶段 ==========

  /**
   * 对低分变体进行定向修补
   */
  private async patchUnderperformers(
    variants: PromptVariant[],
    taskType: string,
    criteria: string[],
    modelId?: string,
  ): Promise<PromptVariant[]> {
    if (variants.length === 0) return [];

    // 找到平均分，低于平均分的变体需要修补
    const avgScore = variants.reduce((s, v) => s + v.score, 0) / variants.length;
    const underperformers = variants.filter(v => v.score < avgScore);

    if (underperformers.length === 0) return [];

    const patched: PromptVariant[] = [];

    // 只修补最差的1-2个变体（节省LLM调用）
    const toPatch = underperformers
      .sort((a, b) => a.score - b.score)
      .slice(0, 2);

    for (const variant of toPatch) {
      const patchedPrompt = await this.applyPatch(
        variant.prompt,
        variant.feedback,
        taskType,
        criteria,
        modelId,
      );

      patched.push({
        id: `patch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        prompt: patchedPrompt,
        mutationOperator: variant.mutationOperator,
        parentId: variant.id,
        score: 0,
        feedback: '',
        createdAt: Date.now(),
      });
    }

    return patched;
  }

  /**
   * 应用定向修补
   */
  private async applyPatch(
    prompt: string,
    feedback: string,
    taskType: string,
    criteria: string[],
    modelId?: string,
  ): Promise<string> {
    const criteriaText = criteria.join('、');

    const systemMsg = '你是一个prompt修补专家。根据评估反馈，对prompt进行针对性改进。只输出改进后的prompt，不要解释。';
    const userMsg = `请根据以下评估反馈改进prompt：

任务类型：${taskType}
评估标准：${criteriaText}

原始prompt：
---
${prompt}
---

评估反馈：
${feedback || '该prompt在各评估维度上表现不佳，请全面改进。'}

请针对性地改进上述prompt的不足之处。`;

    try {
      const response = await this.modelLibrary.call(
        [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
        { modelId, maxTokens: 2048, temperature: 0.5 },
      );

      const result = response.content.trim();
      return result.length >= 10 ? result : prompt;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('LLM修补调用失败，返回原始prompt', { error: msg });
      return prompt;
    }
  }

  // ========== ANALYZE 阶段 ==========

  /**
   * 检查收敛条件
   */
  private checkConvergence(
    history: EvolutionCycle[],
    opts: Required<Pick<GEPAOptions, 'convergenceWindow' | 'convergenceThreshold' | 'targetScore'>>,
  ): { converged: boolean; reason?: string } {
    if (history.length === 0) return { converged: false };

    const latestCycle = history[history.length - 1];

    // 条件1：达到目标分数
    if (latestCycle.bestScore >= opts.targetScore) {
      return { converged: true, reason: `达到目标分数 ${opts.targetScore}` };
    }

    // 条件2：最近N轮分数提升小于阈值
    const windowSize = Math.min(opts.convergenceWindow, history.length);
    if (history.length >= windowSize) {
      const recentCycles = history.slice(-windowSize);
      const oldestScore = recentCycles[0].bestScore;
      const newestScore = recentCycles[recentCycles.length - 1].bestScore;
      const improvement = newestScore - oldestScore;

      if (improvement < opts.convergenceThreshold) {
        return {
          converged: true,
          reason: `最近${windowSize}轮分数提升(${improvement.toFixed(4)})小于阈值(${opts.convergenceThreshold})`,
        };
      }
    }

    return { converged: false };
  }

  // ========== 工具方法 ==========

  /**
   * 规范化选项，填充默认值
   */
  private normalizeOptions(options?: GEPAOptions): Required<GEPAOptions> & { mutationWeights: Partial<Record<MutationOperator, number>> } {
    return {
      maxIterations: options?.maxIterations ?? 500,
      targetScore: options?.targetScore ?? 0.95,
      convergenceWindow: options?.convergenceWindow ?? 10,
      convergenceThreshold: options?.convergenceThreshold ?? 0.01,
      variantsPerCycle: options?.variantsPerCycle ?? 5,
      evaluationModelId: options?.evaluationModelId ?? '',
      persistState: options?.persistState ?? true,
      mutationWeights: options?.mutationWeights ?? {},
    };
  }

  /**
   * 获取或创建进化状态
   */
  private getOrCreateState(
    taskType: string,
    basePrompt: string,
    evaluationCriteria: string[],
  ): GEPAState {
    let state = this.states.get(taskType);
    if (!state) {
      // 尝试从磁盘加载
      state = this.loadStateFromDisk(taskType) ?? undefined;
    }
    if (!state) {
      state = {
        taskType,
        basePrompt,
        evaluationCriteria,
        bestPrompt: basePrompt,
        bestScore: 0,
        cycles: [],
        allVariants: [],
        lastUpdated: Date.now(),
      };
    }
    this.states.set(taskType, state);
    return state;
  }

  /**
   * 计算方差
   */
  private computeVariance(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  }

  /**
   * 发送事件
   */
  private async emitEvent(type: string, data: unknown): Promise<void> {
    try {
      await this.eventBus.emit(type, data, { source: 'GEPAEvolutionEngine' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('事件发送失败', { type, error: msg });
    }
  }

  // ========== 持久化 ==========

  /**
   * 持久化状态到 .duan/gepa-state.json
   */
  private async persistState(taskType: string): Promise<void> {
    try {
      const state = this.states.get(taskType);
      if (!state) return;

      const filePath = path.join(this.stateDir, 'gepa-state.json');

      // 读取已有状态文件
      let allStates: Record<string, GEPAState> = {};
      if (await this.pathExists(filePath)) {
        try {
          const data = await fs.promises.readFile(filePath, 'utf-8');
          allStates = JSON.parse(data);
        } catch {
          // 文件损坏，覆盖
        }
      }

      // 只保留最近1000个变体（防止文件过大）
      if (state.allVariants.length > 1000) {
        state.allVariants = state.allVariants.slice(-1000);
      }

      allStates[taskType] = state;

      // 确保目录存在
      if (!(await this.pathExists(this.stateDir))) {
        await fs.promises.mkdir(this.stateDir, { recursive: true });
      }

      await atomicWriteJson(filePath, allStates);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('GEPA状态持久化失败', { taskType, error: msg });
    }
  }

  /**
   * 异步判断路径是否存在
   */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从磁盘加载状态
   */
  private loadStateFromDisk(taskType: string): GEPAState | null {
    try {
      const filePath = path.join(this.stateDir, 'gepa-state.json');
      if (!fs.existsSync(filePath)) return null;

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const state = data[taskType];
      if (state && state.taskType === taskType) {
        return state as GEPAState;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * P0 修复 (断裂点 #1): 从磁盘加载行为记录
   *
   * 原 loadStateFromDisk 只加载 states（bestPrompt/bestScore/cycles/allVariants），
   * 完全不加载 behaviorRecords，导致进程重启后行为记录清零。
   * 后果：evaluateBehaviorEffect 返回 totalBehaviors:0，_maybeTriggerGEPAEvolution 因 <10 直接 return，
   * 自进化循环在重启后停摆，需要再攒 10 条行为才能恢复（"越用越好"在重启后归零）。
   */
  private loadBehaviorsFromDisk(taskType: string): BehaviorRecord[] {
    try {
      const filePath = path.join(this.stateDir, 'gepa-behaviors.json');
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const records = data[taskType];
      return Array.isArray(records) ? records as BehaviorRecord[] : [];
    } catch {
      return [];
    }
  }

  /**
   * P0 修复 (断裂点 #1): 持久化行为记录到磁盘
   *
   * 原 persistState 只持久化 states，不写 behaviorRecords。
   * 现将 behaviorRecords 单独存入 gepa-behaviors.json（避免 gepa-state.json 过大）。
   * fire-and-forget 调用，失败不阻塞主流程。
   */
  private async persistBehaviors(taskType: string): Promise<void> {
    try {
      const records = this.behaviorRecords.get(taskType);
      if (!records) return;

      const filePath = path.join(this.stateDir, 'gepa-behaviors.json');

      // 读取已有行为文件
      let allBehaviors: Record<string, BehaviorRecord[]> = {};
      if (await this.pathExists(filePath)) {
        try {
          const data = await fs.promises.readFile(filePath, 'utf-8');
          allBehaviors = JSON.parse(data);
        } catch {
          // 文件损坏，覆盖
        }
      }

      // 只保留最近 500 条（与 recordBehavior 内的截断一致）
      const trimmed = records.slice(-500);
      allBehaviors[taskType] = trimmed;

      // 确保目录存在
      if (!(await this.pathExists(this.stateDir))) {
        await fs.promises.mkdir(this.stateDir, { recursive: true });
      }

      await atomicWriteJson(filePath, allBehaviors);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('GEPA行为记录持久化失败', { taskType, error: msg });
    }
  }

  // ========== P2-2: 行为记录 → 效果评估 → 技能沉淀闭环 ==========

  /**
   * P2-2: 记录任务执行行为
   *
   * 对标 GEPA 闭环的"行为记录"环节：记录真实任务执行过程，
   * 为后续的效果评估和技能沉淀提供数据基础。
   */
  recordBehavior(behavior: Omit<BehaviorRecord, 'id' | 'timestamp'>): string {
    const id = `beh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fullRecord: BehaviorRecord = {
      ...behavior,
      id,
      timestamp: Date.now(),
    };

    // P0 修复 (断裂点 #1): 首次访问时从磁盘加载历史行为记录，避免重启后清零
    let records = this.behaviorRecords.get(behavior.taskType);
    if (!records) {
      records = this.loadBehaviorsFromDisk(behavior.taskType);
    }
    records.push(fullRecord);
    // 只保留最近 500 条行为记录
    if (records.length > 500) {
      records.splice(0, records.length - 500);
    }
    this.behaviorRecords.set(behavior.taskType, records);

    // P0 修复 (断裂点 #1): fire-and-forget 持久化行为记录，防止重启丢失
    void this.persistBehaviors(behavior.taskType);

    this.log.info('行为已记录', {
      taskType: behavior.taskType,
      result: behavior.result,
      effectScore: behavior.effectScore,
    });

    this.eventBus.emitSync('gepa.behavior.recorded', {
      taskType: behavior.taskType,
      result: behavior.result,
      effectScore: behavior.effectScore,
    });

    // P2-2: 自动触发技能提炼 — 成功行为数达到阈值时自动提炼
    if (behavior.result === 'success') {
      const successCount = records.filter(r => r.result === 'success').length;
      if (successCount > 0 && successCount % GEPAEvolutionEngine.AUTO_DISTILL_THRESHOLD === 0) {
        this.log.info('自动触发技能提炼', {
          taskType: behavior.taskType,
          successCount,
          threshold: GEPAEvolutionEngine.AUTO_DISTILL_THRESHOLD,
        });
        const skillId = this.distillSkillFromBehavior(behavior.taskType);
        if (skillId) {
          this.eventBus.emitSync('gepa.skill.auto_distilled', {
            taskType: behavior.taskType,
            skillId,
            trigger: 'auto',
            successCount,
          });
        }
      }
    }

    return id;
  }

  /**
   * P2-2: 评估行为效果 — 聚合分析指定任务类型的行为记录
   *
   * 对标 GEPA 闭环的"效果评估"环节：从行为记录中提取模式，
   * 评估当前最优 prompt 的实际效果。
   */
  evaluateBehaviorEffect(taskType: string): {
    totalBehaviors: number;
    successRate: number;
    avgEffectScore: number;
    avgDurationMs: number;
    commonFailurePatterns: string[];
    improvementTrend: 'improving' | 'stable' | 'declining';
  } {
    const records = this.behaviorRecords.get(taskType) ?? [];
    if (records.length === 0) {
      return {
        totalBehaviors: 0,
        successRate: 0,
        avgEffectScore: 0,
        avgDurationMs: 0,
        commonFailurePatterns: [],
        improvementTrend: 'stable',
      };
    }

    const successCount = records.filter(r => r.result === 'success').length;
    const avgEffect = records.reduce((sum, r) => sum + r.effectScore, 0) / records.length;
    const avgDuration = records.reduce((sum, r) => sum + r.durationMs, 0) / records.length;

    // 提取失败模式
    const failurePatterns: Record<string, number> = {};
    for (const r of records) {
      if (r.result !== 'success' && r.errorMessage) {
        const pattern = r.errorMessage.substring(0, 50);
        failurePatterns[pattern] = (failurePatterns[pattern] ?? 0) + 1;
      }
    }
    const commonFailurePatterns = Object.entries(failurePatterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern]) => pattern);

    // 计算改进趋势（比较前半段和后半段的平均效果分数）
    const midpoint = Math.floor(records.length / 2);
    const firstHalf = records.slice(0, midpoint);
    const secondHalf = records.slice(midpoint);
    const firstAvg = firstHalf.length > 0
      ? firstHalf.reduce((s, r) => s + r.effectScore, 0) / firstHalf.length
      : 0;
    const secondAvg = secondHalf.length > 0
      ? secondHalf.reduce((s, r) => s + r.effectScore, 0) / secondHalf.length
      : 0;
    const trend = (() => {
      if (secondAvg - firstAvg > 0.05) return 'improving';
      if (secondAvg - firstAvg < -0.05) return 'declining';
      return 'stable';
    })();

    return {
      totalBehaviors: records.length,
      successRate: successCount / records.length,
      avgEffectScore: avgEffect,
      avgDurationMs: avgDuration,
      commonFailurePatterns,
      improvementTrend: trend,
    };
  }

  /**
   * P2-2: 从行为记录中提炼技能（自动生成 Markdown 技能文件）
   *
   * 对标 GEPA 闭环的"技能沉淀"环节：分析成功的行为记录，
   * 提炼为可复用的 Markdown 格式技能文件，带版本管理。
   *
   * @param taskType 任务类型
   * @param minEffectScore 最低效果分数阈值（默认 0.7）
   * @returns 新创建的技能 ID，若无可提炼的行为则返回 null
   */
  distillSkillFromBehavior(taskType: string, minEffectScore = 0.7): string | null {
    const records = (this.behaviorRecords.get(taskType) ?? [])
      .filter(r => r.effectScore >= minEffectScore && r.result === 'success');

    if (records.length === 0) {
      this.log.info('无可提炼的成功行为', { taskType, minEffectScore });
      // P2-2: 记录提炼尝试（失败）
      this.trackDistillationAttempt(taskType, false);
      return null;
    }

    // 获取该任务类型的最优 prompt
    const state = this.states.get(taskType);
    const bestPrompt = state?.bestPrompt ?? records[0].promptUsed;

    // 提取工具调用模式
    const toolUsage: Record<string, number> = {};
    for (const r of records) {
      for (const tc of r.toolCalls) {
        toolUsage[tc.tool] = (toolUsage[tc.tool] ?? 0) + 1;
      }
    }
    const topTools = Object.entries(toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => `- \`${tool}\` (${count} 次)`);

    // 生成技能 Markdown 内容
    const skillId = `skill_${taskType}_${Date.now()}`;
    const effect = this.evaluateBehaviorEffect(taskType);
    const version = this.getNextSkillVersion(taskType);

    const markdown = [
      `# 技能：${taskType}`,
      '',
      '## 元数据',
      `- **技能ID**: ${skillId}`,
      `- **版本**: ${version}`,
      `- **创建时间**: ${new Date().toISOString()}`,
      `- **来源行为数**: ${records.length}`,
      `- **平均效果分数**: ${effect.avgEffectScore.toFixed(2)}`,
      `- **成功率**: ${(effect.successRate * 100).toFixed(1)}%`,
      '',
      '## 最优 Prompt',
      '```',
      bestPrompt,
      '```',
      '',
      '## 工具调用模式',
      ...topTools,
      '',
      '## 典型任务示例',
      ...records.slice(0, 3).map((r, i) => `### 示例 ${i + 1}\n- **任务**: ${r.taskDescription}\n- **结果**: ${r.result}\n- **耗时**: ${r.durationMs}ms`),
      '',
      '## 失败模式（避免）',
      ...effect.commonFailurePatterns.map(p => `- ${p}`),
      '',
      '## 使用统计',
      `- **使用次数**: 0`,
      `- **成功次数**: 0`,
      `- **效果评分**: ${effect.avgEffectScore.toFixed(2)}`,
    ].join('\n');

    // 检查是否已有同任务类型的技能（版本升级）
    const existingSkills = this.findSkillsByTaskType(taskType);
    const parentVersionId = existingSkills.length > 0
      ? existingSkills[existingSkills.length - 1].skillId
      : null;

    const skill: SkillRecord = {
      skillId,
      taskType,
      title: `技能：${taskType}`,
      content: markdown,
      version,
      sourceBehaviorIds: records.map(r => r.id),
      parentVersionId,
      effectScore: effect.avgEffectScore,
      usageCount: 0,
      successCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      tags: ['distilled', 'gepa', taskType],
    };

    const skillVersions = this.skills.get(skillId) ?? [];
    skillVersions.push(skill);
    this.skills.set(skillId, skillVersions);

    // 持久化技能到文件
    this.persistSkill(skill);

    this.log.info('技能已沉淀', {
      taskType,
      skillId,
      version,
      sourceBehaviors: records.length,
    });

    this.eventBus.emitSync('gepa.skill.distilled', {
      taskType,
      skillId,
      version,
      effectScore: effect.avgEffectScore,
    });

    // P2-2: 记录提炼尝试（成功）
    this.trackDistillationAttempt(taskType, true);

    return skillId;
  }

  /**
   * P2-2: 获取技能的当前版本
   */
  getSkillVersion(skillId: string): SkillRecord | null {
    const versions = this.skills.get(skillId);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1];
  }

  /**
   * P2-2: 列出技能的所有版本
   */
  listSkillVersions(skillId: string): SkillRecord[] {
    return this.skills.get(skillId) ?? [];
  }

  /**
   * P2-2: 回滚技能到指定版本
   */
  rollbackSkillVersion(skillId: string, targetVersion: string): boolean {
    const versions = this.skills.get(skillId);
    if (!versions) return false;

    const targetIndex = versions.findIndex(v => v.version === targetVersion);
    if (targetIndex < 0) return false;

    // 移除目标版本之后的所有版本
    versions.splice(targetIndex + 1);
    this.log.info('技能版本已回滚', { skillId, targetVersion, remainingVersions: versions.length });
    return true;
  }

  /**
   * P2-2: 记录技能使用（更新使用统计）
   */
  recordSkillUsage(skillId: string, success: boolean, effectScore: number): void {
    const skill = this.getSkillVersion(skillId);
    if (!skill) return;

    skill.usageCount++;
    if (success) skill.successCount++;
    skill.lastUsedAt = Date.now();

    // 滑动平均更新效果评分
    skill.effectScore = (skill.effectScore * (skill.usageCount - 1) + effectScore) / skill.usageCount;
  }

  /**
   * P2-2: 导出技能为 Markdown 文件
   */
  exportSkillAsMarkdown(skillId: string, outputPath?: string): string | null {
    const skill = this.getSkillVersion(skillId);
    if (!skill) return null;

    if (outputPath) {
      try {
        if (!fs.existsSync(path.dirname(outputPath))) {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        }
        fs.writeFileSync(outputPath, skill.content, 'utf-8');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('技能导出失败', { skillId, error: msg });
        return null;
      }
    }

    return skill.content;
  }

  /**
   * P2-2: 查找指定任务类型的所有技能
   *
   * P2-2 修复：冷启动时从磁盘加载技能，避免重启后 findSkillsByTaskType 返回空。
   * 之前 persistSkill 写入 .md 文件后再无人读取，技能成孤儿。
   */
  findSkillsByTaskType(taskType: string): SkillRecord[] {
    // 冷启动：首次查询时从磁盘加载技能（仅一次，dispose 后不再加载）
    if (!this.skillsLoadedFromDisk && this.skills.size === 0) {
      this.skillsLoadedFromDisk = true;
      this.loadAllSkillsFromDisk();
    }
    const result: SkillRecord[] = [];
    for (const versions of this.skills.values()) {
      const latest = versions[versions.length - 1];
      if (latest && latest.taskType === taskType) {
        result.push(latest);
      }
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * P2-2: 列出所有技能（每个 skillId 的最新版本）
   */
  listAllSkills(): SkillRecord[] {
    const result: SkillRecord[] = [];
    for (const versions of this.skills.values()) {
      const latest = versions[versions.length - 1];
      if (latest) {
        result.push(latest);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 获取下一个语义化版本号 */
  private getNextSkillVersion(taskType: string): string {
    const existing = this.findSkillsByTaskType(taskType);
    if (existing.length === 0) return '1.0.0';

    const lastVersion = existing[existing.length - 1].version;
    const parts = lastVersion.split('.').map(Number);
    parts[1] += 1; // minor 版本升级
    return parts.join('.');
  }

  /** 持久化技能到文件系统 */
  private persistSkill(skill: SkillRecord): void {
    try {
      const skillDir = path.join(this.stateDir, 'gepa-skills');
      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }
      // P2-2 修复：同时写 .md（人类可读）和 .json（机器可读，含完整元数据）
      // 之前只写 .md，导致重启后无法重建 SkillRecord（元数据丢失）
      const mdPath = path.join(skillDir, `${skill.skillId}_v${skill.version}.md`);
      fs.writeFileSync(mdPath, skill.content, 'utf-8');
      const jsonPath = path.join(skillDir, `${skill.skillId}_v${skill.version}.json`);
      atomicWriteJsonSync(jsonPath, skill);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('技能持久化失败', { skillId: skill.skillId, error: msg });
    }
  }

  /**
   * P2-2: 从磁盘加载所有技能 — 重启后恢复 skills Map
   *
   * 之前 persistSkill 只写不读，技能 .md/.json 文件成孤儿。
   * 现在在 findSkillsByTaskType 首次查询（skills.size === 0）时触发加载。
   */
  private loadAllSkillsFromDisk(): void {
    try {
      const skillDir = path.join(this.stateDir, 'gepa-skills');
      if (!fs.existsSync(skillDir)) return;
      const files = fs.readdirSync(skillDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const filePath = path.join(skillDir, f);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SkillRecord;
          if (!data.skillId || !data.taskType) continue;
          const versions = this.skills.get(data.skillId) ?? [];
          versions.push(data);
          // 按 createdAt 排序，确保最新版本在末尾
          versions.sort((a, b) => a.createdAt - b.createdAt);
          this.skills.set(data.skillId, versions);
        } catch {
          // 单个文件损坏，跳过
        }
      }
      if (this.skills.size > 0) {
        this.log.info('GEPA 技能已从磁盘恢复', { skillCount: this.skills.size });
      }
    } catch {
      // 目录不存在或读取失败，忽略
    }
  }

  // ========== P2-2: 验收度量方法 ==========

  /**
   * P2-2: 追踪技能提炼尝试（成功/失败）
   *
   * 维护按任务类型分组的提炼统计，用于计算提炼率。
   * 提炼率 = 成功提炼次数 / 总提炼尝试次数
   *
   * @param taskType 任务类型
   * @param success 是否成功
   */
  private trackDistillationAttempt(taskType: string, success: boolean): void {
    const stats = this.distillationStats.get(taskType) ?? { attempts: 0, successes: 0 };
    stats.attempts++;
    if (success) stats.successes++;
    this.distillationStats.set(taskType, stats);
  }

  /**
   * P2-2: 验证收敛区间 — 检查进化结果是否在 100-500 次收敛区间内
   *
   * 验收标准：100-500 次收敛
   *
   * @param result 进化结果
   * @returns 验证结果，包含是否在区间内、偏离方向、建议
   */
  validateConvergenceRange(result: EvolutionResult): {
    inRange: boolean;
    totalIterations: number;
    deviation: 'below' | 'above' | 'none';
    message: string;
  } {
    const { min, max } = GEPAEvolutionEngine.CONVERGENCE_RANGE;
    const totalIterations = result.totalIterations;

    if (!result.converged) {
      return {
        inRange: false,
        totalIterations,
        deviation: 'below',
        message: `未收敛（已迭代 ${totalIterations} 次），需调整收敛阈值或增加最大迭代数`,
      };
    }

    if (totalIterations < min) {
      return {
        inRange: false,
        totalIterations,
        deviation: 'below',
        message: `收敛过快（${totalIterations} 次 < ${min}），可能存在过拟合或评估过于宽松`,
      };
    }

    if (totalIterations > max) {
      return {
        inRange: false,
        totalIterations,
        deviation: 'above',
        message: `收敛过慢（${totalIterations} 次 > ${max}），可能需要调整变异算子或收敛阈值`,
      };
    }

    return {
      inRange: true,
      totalIterations,
      deviation: 'none',
      message: `收敛次数 ${totalIterations} 在验收区间 [${min}, ${max}] 内`,
    };
  }

  /**
   * P2-2: 获取技能提炼率统计
   *
   * 验收标准：技能自动提炼 ≥85%
   *
   * @returns 全局及按任务类型的提炼率统计
   */
  getSkillDistillationRate(): {
    globalRate: number;
    totalAttempts: number;
    totalSuccesses: number;
    meetsTarget: boolean;
    byTaskType: Array<{ taskType: string; attempts: number; successes: number; rate: number }>;
  } {
    const TARGET_RATE = 0.85;
    let totalAttempts = 0;
    let totalSuccesses = 0;
    const byTaskType: Array<{ taskType: string; attempts: number; successes: number; rate: number }> = [];

    for (const [taskType, stats] of this.distillationStats.entries()) {
      totalAttempts += stats.attempts;
      totalSuccesses += stats.successes;
      byTaskType.push({
        taskType,
        attempts: stats.attempts,
        successes: stats.successes,
        rate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
      });
    }

    byTaskType.sort((a, b) => b.attempts - a.attempts);

    const globalRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0;

    return {
      globalRate,
      totalAttempts,
      totalSuccesses,
      meetsTarget: globalRate >= TARGET_RATE,
      byTaskType,
    };
  }

  /**
   * P2-2: 获取进化效率指标
   *
   * 综合评估指定任务类型的进化效率，包括：
   * - 收敛速度（是否在 100-500 区间）
   * - 提炼率（是否 ≥85%）
   * - 技能质量（平均效果分数）
   * - 行为改进趋势
   *
   * @param taskType 任务类型
   * @returns 进化效率指标报告
   */
  getEvolutionMetrics(taskType: string): {
    taskType: string;
    convergence: {
      iterations: number;
      inRange: boolean;
      bestScore: number;
    };
    distillation: {
      attempts: number;
      successes: number;
      rate: number;
      meetsTarget: boolean;
    };
    skillQuality: {
      skillCount: number;
      avgEffectScore: number;
      avgUsageCount: number;
      avgSuccessRate: number;
    };
    behavior: {
      totalBehaviors: number;
      successRate: number;
      improvementTrend: string;
    };
    overallScore: number;
  } {
    // 收敛指标
    const state = this.states.get(taskType);
    const iterations = state?.cycles.length ?? 0;
    const bestScore = state?.bestScore ?? 0;
    const inRange = iterations >= GEPAEvolutionEngine.CONVERGENCE_RANGE.min
      && iterations <= GEPAEvolutionEngine.CONVERGENCE_RANGE.max;

    // 提炼指标
    const distillStats = this.distillationStats.get(taskType) ?? { attempts: 0, successes: 0 };
    const distillRate = distillStats.attempts > 0
      ? distillStats.successes / distillStats.attempts
      : 0;

    // 技能质量指标
    const skills = this.findSkillsByTaskType(taskType);
    const avgEffectScore = skills.length > 0
      ? skills.reduce((s, sk) => s + sk.effectScore, 0) / skills.length
      : 0;
    const avgUsageCount = skills.length > 0
      ? skills.reduce((s, sk) => s + sk.usageCount, 0) / skills.length
      : 0;
    const avgSuccessRate = skills.length > 0
      ? skills.reduce((s, sk) => s + (sk.usageCount > 0 ? sk.successCount / sk.usageCount : 0), 0) / skills.length
      : 0;

    // 行为指标
    const behavior = this.evaluateBehaviorEffect(taskType);

    // 综合评分（0-1）
    let convergenceScore: number;
    if (inRange) {
      convergenceScore = 1.0;
    } else if (iterations > 0) {
      convergenceScore = 0.5;
    } else {
      convergenceScore = 0;
    }
    const distillScore = distillRate >= 0.85 ? 1.0 : distillRate;
    const skillScore = avgEffectScore;
    const behaviorScore = behavior.successRate;
    const overallScore = (convergenceScore + distillScore + skillScore + behaviorScore) / 4;

    return {
      taskType,
      convergence: {
        iterations,
        inRange,
        bestScore,
      },
      distillation: {
        attempts: distillStats.attempts,
        successes: distillStats.successes,
        rate: distillRate,
        meetsTarget: distillRate >= 0.85,
      },
      skillQuality: {
        skillCount: skills.length,
        avgEffectScore,
        avgUsageCount,
        avgSuccessRate,
      },
      behavior: {
        totalBehaviors: behavior.totalBehaviors,
        successRate: behavior.successRate,
        improvementTrend: behavior.improvementTrend,
      },
      overallScore,
    };
  }

  /**
   * P2-2: 验证技能质量
   *
   * 检查指定技能是否满足质量标准：
   * - 效果分数 ≥ 0.7
   * - 使用次数 ≥ 1（至少被使用过一次以验证）
   * - 成功率 ≥ 0.7
   * - 内容完整性（包含必要的章节）
   *
   * @param skillId 技能ID
   * @returns 验证结果，包含各项检查的通过情况
   */
  validateSkill(skillId: string): {
    valid: boolean;
    skillId: string;
    version: string;
    checks: {
      effectScore: { passed: boolean; value: number; threshold: number };
      usageCount: { passed: boolean; value: number; threshold: number };
      successRate: { passed: boolean; value: number; threshold: number };
      contentIntegrity: { passed: boolean; missingSections: string[] };
    };
    overallScore: number;
  } {
    const skill = this.getSkillVersion(skillId);
    if (!skill) {
      return {
        valid: false,
        skillId,
        version: '',
        checks: {
          effectScore: { passed: false, value: 0, threshold: 0.7 },
          usageCount: { passed: false, value: 0, threshold: 1 },
          successRate: { passed: false, value: 0, threshold: 0.7 },
          contentIntegrity: { passed: false, missingSections: ['技能不存在'] },
        },
        overallScore: 0,
      };
    }

    // 效果分数检查
    const effectThreshold = 0.7;
    const effectPassed = skill.effectScore >= effectThreshold;

    // 使用次数检查
    const usageThreshold = 1;
    const usagePassed = skill.usageCount >= usageThreshold;

    // 成功率检查
    const successThreshold = 0.7;
    const successRate = skill.usageCount > 0 ? skill.successCount / skill.usageCount : 0;
    const successPassed = skill.usageCount === 0 ? false : successRate >= successThreshold;

    // 内容完整性检查
    const requiredSections = ['## 元数据', '## 最优 Prompt', '## 工具调用模式', '## 使用统计'];
    const missingSections = requiredSections.filter(s => !skill.content.includes(s));
    const contentPassed = missingSections.length === 0;

    const allPassed = effectPassed && usagePassed && successPassed && contentPassed;
    const overallScore = (
      (effectPassed ? 1 : skill.effectScore / effectThreshold) +
      (usagePassed ? 1 : skill.usageCount / usageThreshold) +
      (successPassed ? 1 : successRate / successThreshold) +
      (contentPassed ? 1 : (requiredSections.length - missingSections.length) / requiredSections.length)
    ) / 4;

    return {
      valid: allPassed,
      skillId,
      version: skill.version,
      checks: {
        effectScore: { passed: effectPassed, value: skill.effectScore, threshold: effectThreshold },
        usageCount: { passed: usagePassed, value: skill.usageCount, threshold: usageThreshold },
        successRate: { passed: successPassed, value: successRate, threshold: successThreshold },
        contentIntegrity: { passed: contentPassed, missingSections },
      },
      overallScore,
    };
  }
}
