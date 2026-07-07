/**
 * 认知引擎 — CognitiveEngine
 *
 * 桥接神经网络与主推理循环，让 Agent 真正"思考"。
 *
 * 核心能力：
 * 1. 自动特征提取 — 从上下文中提取 8 维认知特征（无需 LLM 手动填入）
 * 2. 神经决策 — 使用 NeuralNetwork 预测最优策略
 * 3. 策略影响 — 决策结果影响 temperature / 推理深度 / 工具选择
 * 4. 在线学习 — 任务成功/失败后反向传播训练 NN
 * 5. 认知周期 — 感知→推理→决策→行动→反思的完整闭环
 *
 * 架构隐喻：
 * - NeuralNetwork = 前额叶皮层（执行决策）
 * - 特征提取 = 感觉皮层（感知环境）
 * - 在线学习 = 海马体（经验固化）
 * - 认知周期 = 意识流（思考过程）
 *
 * 对标：
 * - Claude Code 的 ReAct 循环（thought→action→observation）
 * - Hermes 的自改进闭环（经验→技能）
 * - Codex 的 self-healing（stderr→新上下文）
 */

import { NeuralNetwork, type InferenceResult, type ActivationType } from './neural-network.js';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 认知策略 — NN 输出的决策类别 */
export type CognitiveStrategy =
  | 'direct_action'    // 简单任务，直接行动
  | 'careful_analysis' // 复杂任务，谨慎分析
  | 'decompose'        // 超复杂任务，分解为子任务
  | 'ask_user'         // 不确定任务，询问用户
  | 'retry_with_hint'; // 失败后重试

/** 认知特征 — 从上下文自动提取的 8 维向量 */
export interface CognitiveFeatures {
  /** 任务紧急度 0-1（deadline 越近越高） */
  urgency: number;
  /** 任务复杂度 0-1（代码行数/步骤数） */
  complexity: number;
  /** 任务新颖度 0-1（是否首次遇到） */
  novelty: number;
  /** 上下文丰富度 0-1（已有信息量） */
  contextRichness: number;
  /** 错误频率 0-1（近期错误比例） */
  errorRate: number;
  /** 工具使用频率 0-1（近期工具调用密度） */
  toolUsageRate: number;
  /** 用户满意度 0-1（历史反馈均值） */
  userSatisfaction: number;
  /** 任务类型 0-1（0=对话, 1=编程） */
  taskType: number;
}

/**
 * 特征向量的规范顺序 — 单一事实来源（Single Source of Truth）。
 *
 * NN 输入向量的构建（decide）、特征提取（extractFeatures）以及
 * 按索引访问特征（selectAlternativeStrategy 等）都必须依据此顺序，
 * 以消除三处之间的隐式耦合，避免顺序变更时静默引入错误。
 *
 * 修改特征时，只需更新此数组；通过 `featuresToVector` 与
 * `FEATURE_INDEX` 派生其余逻辑，无需再在多处手写索引。
 */
export const FEATURE_ORDER = [
  'urgency',
  'complexity',
  'novelty',
  'contextRichness',
  'errorRate',
  'toolUsageRate',
  'userSatisfaction',
  'taskType',
] as const satisfies readonly (keyof CognitiveFeatures)[];

/** 特征数量 — 即 NN 输入层维度，由 FEATURE_ORDER 派生 */
export const FEATURE_COUNT = FEATURE_ORDER.length;

/**
 * 特征名 -> 索引 的映射，供需要按索引访问的逻辑使用，
 * 取代 selectAlternativeStrategy 中的硬编码索引（如 features[1]）。
 * 例如：`vector[FEATURE_INDEX.complexity]` 而非 `vector[1]`。
 */
export const FEATURE_INDEX = FEATURE_ORDER.reduce(
  (acc, key, i) => {
    acc[key] = i;
    return acc;
  },
  {} as Record<keyof CognitiveFeatures, number>,
);

/**
 * 按 FEATURE_ORDER 将 CognitiveFeatures 转为 NN 输入向量，
 * 保证向量顺序与字段顺序、索引访问完全一致。
 */
export function featuresToVector(features: CognitiveFeatures): number[] {
  return FEATURE_ORDER.map((key) => features[key]);
}

/** 认知决策 — NN 推理结果 + 策略建议 */
export interface CognitiveDecision {
  /** 选择的策略 */

  strategy: CognitiveStrategy;
  /** 置信度 0-1 */
  confidence: number;
  /** 建议的 LLM temperature */
  temperature: number;
  /** 建议的最大推理轮次 */
  maxIterations: number;
  /** 是否触发任务分解 */
  shouldDecompose: boolean;
  /** 是否触发深度反思 */
  shouldReflect: boolean;
  /** 推理路径（用于内省） */
  reasoning: string;
  /** NN 原始输出 */
  rawOutput: number[];
}

/** 任务结果 — 用于在线学习 */
export interface TaskOutcome {
  /** 任务特征（决策时的快照） */
  features: number[];
  /** 选择的策略 */
  strategy: CognitiveStrategy;
  /** 是否成功 */
  success: boolean;
  /** 耗时（ms） */
  durationMs: number;
  /** 用户反馈 0-1（可选） */
  userFeedback?: number;
}

/** 认知周期 — 一次完整的思考过程 */
export interface CognitiveCycle {
  /** 感知：提取的特征 */
  perception: CognitiveFeatures;
  /** 决策：NN 输出 */
  decision: CognitiveDecision;
  /** 行动：执行的工具调用数 */
  actionsTaken: number;
  /** 反思：结果评估 */
  reflection: string;
  /** 时间戳 */
  timestamp: number;
}

// ============ 认知引擎 ============

const STRATEGY_LABELS: CognitiveStrategy[] = [
  'direct_action',
  'careful_analysis',
  'decompose',
  'ask_user',
  'retry_with_hint',
];

export class CognitiveEngine {
  /** 决策网络 */
  private decisionNet: NeuralNetwork;
  /** 模型路径 */
  private modelPath: string;
  /** 认知周期历史（最近 100 次） */
  private cycles: CognitiveCycle[] = [];
  /** 任务结果历史（用于在线学习） */
  private outcomes: TaskOutcome[] = [];
  /** 近期错误计数（滑动窗口） */
  private recentErrors: boolean[] = new Array(20).fill(false);
  /** 近期工具调用计数 */
  private recentToolCalls: number[] = new Array(20).fill(0);
  /** 已见任务签名（用于新颖度计算） */
  private seenTaskSignatures: Map<string, number> = new Map();
  /** 总决策次数 */
  private totalDecisions: number = 0;
  /** 成功决策次数 */
  private successDecisions: number = 0;
  /** 在线学习次数 */
  private onlineLearnCount: number = 0;

  private log = logger.child({ module: 'CognitiveEngine' });

  constructor(modelPath: string = './data/cognitive-net.json') {
    this.modelPath = modelPath;
    this.decisionNet = new NeuralNetwork({
      inputSize: 8,
      layers: [
        { size: 16, activation: 'relu' as ActivationType },
        { size: 12, activation: 'relu' as ActivationType },
        { size: 8, activation: 'relu' as ActivationType },
        { size: 5, activation: 'softmax' as ActivationType },
      ],
      learningRate: 0.005,
      l2Lambda: 0.001,
      modelPath: this.modelPath,
    });
    this.decisionNet.setLabelMap(STRATEGY_LABELS);
  }

  // ========== 特征提取（自动） ==========

  /**
   * 从当前上下文自动提取 8 维认知特征
   * 这是关键改进——不需要 LLM 手动填入特征
   */
  extractFeatures(params: {
    input: string;
    contextMessages?: Array<{ role: string; content: string }>;
    turnCount?: number;
    errorCount?: number;
    toolCallCount?: number;
    hasDeadline?: boolean;
    taskHistory?: string[];
  }): CognitiveFeatures {
    const { input, contextMessages = [], turnCount: _turnCount = 0, errorCount: _errorCount = 0, toolCallCount: _toolCallCount = 0, hasDeadline = false, taskHistory: _taskHistory = [] } = params;

    // 1. 紧急度：有 deadline → 高，短输入 → 高，长输入 → 中
    const urgency = hasDeadline ? 0.9 : Math.min(0.8, input.length / 500 + 0.2);

    // 2. 复杂度：基于输入长度、代码块数、步骤关键词
    const codeBlocks = (input.match(/```[\s\S]*?```/g) || []).length;
    const stepKeywords = (input.match(/步骤|第[一二三四五六七八九十]+|step\s*\d|首先|然后|最后/gi) || []).length;
    const complexity = Math.min(1, (input.length / 2000) * 0.3 + codeBlocks * 0.15 + stepKeywords * 0.1 + 0.1);

    // 3. 新颖度：是否首次遇到此类任务
    const signature = this.computeTaskSignature(input);
    const seenCount = this.seenTaskSignatures.get(signature) || 0;
    const novelty = seenCount === 0 ? 1.0 : Math.max(0.1, 1.0 - seenCount * 0.2);
    this.seenTaskSignatures.set(signature, seenCount + 1);

    // 4. 上下文丰富度：已有消息数和内容量
    const contextLength = contextMessages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const contextRichness = Math.min(1, contextLength / 10000);

    // 5. 错误频率：近期错误比例
    const errorRate = this.recentErrors.filter(Boolean).length / this.recentErrors.length;

    // 6. 工具使用频率：近期工具调用密度
    const avgToolCalls = this.recentToolCalls.reduce((a, b) => a + b, 0) / this.recentToolCalls.length;
    const toolUsageRate = Math.min(1, avgToolCalls / 10);

    // 7. 用户满意度：历史成功率
    const userSatisfaction = this.totalDecisions > 0 ? this.successDecisions / this.totalDecisions : 0.5;

    // 8. 任务类型：0=对话, 1=编程
    const codeKeywords = /(代码|函数|bug|编译|运行|测试|refactor|api|class|import|error|stack|trace|git|commit|file|文件|目录|终端|命令)/gi;
    const codeMatches = (input.match(codeKeywords) || []).length;
    const taskType = Math.min(1, codeMatches * 0.2 + (input.includes('```') ? 0.3 : 0));

    return { urgency, complexity, novelty, contextRichness, errorRate, toolUsageRate, userSatisfaction, taskType };
  }

  /** 计算任务签名（用于新颖度判断） */
  private computeTaskSignature(input: string): string {
    // 提取关键词的前 5 个，排序后作为签名
    const words = input.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 5)
      .sort();
    return words.join('|');
  }

  // ========== 神经决策 ==========

  /**
   * 使用神经网络进行认知决策
   * 这是核心方法——NN 真正参与 Agent 的决策过程
   */
  decide(features: CognitiveFeatures): CognitiveDecision {
    const input = [
      features.urgency,
      features.complexity,
      features.novelty,
      features.contextRichness,
      features.errorRate,
      features.toolUsageRate,
      features.userSatisfaction,
      features.taskType,
    ];

    const result: InferenceResult = this.decisionNet.predict(input);
    const strategy = (result.predictedLabel || 'careful_analysis') as CognitiveStrategy;
    this.totalDecisions++;

    // 根据策略映射执行参数
    const { temperature, maxIterations, shouldDecompose, shouldReflect } = this.mapStrategyToParams(strategy, features, result.confidence);

    const reasoning = this.generateReasoning(strategy, features, result.confidence);

    return {
      strategy,
      confidence: result.confidence,
      temperature,
      maxIterations,
      shouldDecompose,
      shouldReflect,
      reasoning,
      rawOutput: result.output,
    };
  }

  /** 策略 → 执行参数映射 */
  private mapStrategyToParams(
    strategy: CognitiveStrategy,
    features: CognitiveFeatures,
    _confidence: number,
  ): { temperature: number; maxIterations: number; shouldDecompose: boolean; shouldReflect: boolean } {
    switch (strategy) {
      case 'direct_action':
        // 简单任务：高温度（创造性）、少轮次、不分解
        return {
          temperature: 0.7 + features.novelty * 0.2,
          maxIterations: 3,
          shouldDecompose: false,
          shouldReflect: false,
        };
      case 'careful_analysis':
        // 复杂任务：低温度（精确性）、多轮次、不分解但反思
        return {
          temperature: 0.3,
          maxIterations: 10,
          shouldDecompose: false,
          shouldReflect: true,
        };
      case 'decompose':
        // 超复杂任务：低温度、多轮次、分解 + 反思
        return {
          temperature: 0.2,
          maxIterations: 20,
          shouldDecompose: true,
          shouldReflect: true,
        };
      case 'ask_user':
        // 不确定：中温度、少轮次、不分解
        return {
          temperature: 0.5,
          maxIterations: 2,
          shouldDecompose: false,
          shouldReflect: false,
        };
      case 'retry_with_hint':
        // 失败重试：低温度、中轮次、反思
        return {
          temperature: 0.2,
          maxIterations: 5,
          shouldDecompose: false,
          shouldReflect: true,
        };
      default:
        return { temperature: 0.4, maxIterations: 8, shouldDecompose: false, shouldReflect: true };
    }
  }

  /** 生成推理路径（用于内省和调试） */
  private generateReasoning(strategy: CognitiveStrategy, features: CognitiveFeatures, confidence: number): string {
    const reasons: string[] = [];
    if (features.complexity > 0.7) reasons.push(`任务复杂度高(${features.complexity.toFixed(2)})`);
    if (features.novelty > 0.7) reasons.push(`首次遇到此类任务(新颖度${features.novelty.toFixed(2)})`);
    if (features.errorRate > 0.3) reasons.push(`近期错误率高(${features.errorRate.toFixed(2)})`);
    if (features.urgency > 0.7) reasons.push(`任务紧急(${features.urgency.toFixed(2)})`);
    if (features.contextRichness < 0.2) reasons.push(`上下文不足(${features.contextRichness.toFixed(2)})`);

    const strategyDesc: Record<CognitiveStrategy, string> = {
      direct_action: '直接行动——任务简单，无需过度分析',
      careful_analysis: '谨慎分析——任务需要仔细推理',
      decompose: '任务分解——复杂度高，需拆分为子任务',
      ask_user: '询问用户——信息不足，需用户补充',
      retry_with_hint: '带提示重试——从错误中学习，调整策略',
    };

    return `认知决策: ${strategyDesc[strategy]} (置信度${(confidence * 100).toFixed(0)}%)。${reasons.join('；')}`;
  }

  // ========== 在线学习（关键！） ==========

  /**
   * 从任务结果中学习——这是让 Agent "越用越聪明"的核心
   * 任务成功时强化正确策略，失败时训练替代策略
   */
  learnFromOutcome(outcome: TaskOutcome): void {
    this.outcomes.push(outcome);
    if (this.outcomes.length > 1000) this.outcomes.shift();

    // 构建训练目标
    const strategyIdx = STRATEGY_LABELS.indexOf(outcome.strategy);
    if (strategyIdx < 0) return;

    const target = new Array(5).fill(0.1); // 低置信度惩罚
    if (outcome.success) {
      // 成功：强化当前策略
      target[strategyIdx] = 0.9;
      this.successDecisions++;
    } else {
      // 失败：降低当前策略置信度，提升替代策略
      target[strategyIdx] = 0.1;
      // 选择一个替代策略（基于特征选择最可能的替代）
      const altIdx = this.selectAlternativeStrategy(outcome.features, strategyIdx);
      target[altIdx] = 0.7;
    }

    // 在线学习
    this.decisionNet.learnOnline(outcome.features, target);
    this.onlineLearnCount++;

    // 更新滑动窗口
    this.recentErrors.shift();
    this.recentErrors.push(!outcome.success);

    if (this.onlineLearnCount % 10 === 0) {
      this.log.info('认知引擎在线学习', {
        totalDecisions: this.totalDecisions,
        successRate: (this.successDecisions / this.totalDecisions * 100).toFixed(1) + '%',
        onlineLearnCount: this.onlineLearnCount,
      });
    }
  }

  /** 选择替代策略（失败时） */
  private selectAlternativeStrategy(features: number[], failedIdx: number): number {
    // 基于特征启发式选择替代策略
    if (features[1] > 0.7 && failedIdx !== 2) return 2;       // complexity 高 → decompose
    if (features[4] > 0.3 && failedIdx !== 4) return 4;       // errorRate 高 → retry_with_hint
    if (features[3] < 0.2 && failedIdx !== 3) return 3;       // contextRichness 低 → ask_user
    if (failedIdx !== 1) return 1;                             // 默认 → careful_analysis
    return 0;                                                   // 最后 → direct_action
  }

  // ========== 认知周期 ==========

  /**
   * 记录一个完整的认知周期
   * 感知→决策→行动→反思
   */
  recordCycle(perception: CognitiveFeatures, decision: CognitiveDecision, actionsTaken: number, reflection: string): void {
    this.cycles.push({
      perception,
      decision,
      actionsTaken,
      reflection,
      timestamp: Date.now(),
    });
    if (this.cycles.length > 100) this.cycles.shift();

    // 更新工具调用滑动窗口
    this.recentToolCalls.shift();
    this.recentToolCalls.push(actionsTaken);
  }

  // ========== 状态查询 ==========

  /** 获取认知统计 */
  getStats(): {
    totalDecisions: number;
    successRate: number;
    onlineLearnCount: number;
    avgConfidence: number;
    recentStrategy: CognitiveStrategy | null;
    cycleCount: number;
  } {
    const recentCycles = this.cycles.slice(-20);
    const avgConfidence = recentCycles.length > 0
      ? recentCycles.reduce((sum, c) => sum + c.decision.confidence, 0) / recentCycles.length
      : 0;
    const recentStrategy = recentCycles.length > 0
      ? recentCycles[recentCycles.length - 1].decision.strategy
      : null;

    return {
      totalDecisions: this.totalDecisions,
      successRate: this.totalDecisions > 0 ? this.successDecisions / this.totalDecisions : 0,
      onlineLearnCount: this.onlineLearnCount,
      avgConfidence,
      recentStrategy,
      cycleCount: this.cycles.length,
    };
  }

  /** 获取最近 N 个认知周期（用于内省） */
  getRecentCycles(count: number = 10): CognitiveCycle[] {
    return this.cycles.slice(-count);
  }

  /** 获取认知报告（用于自我意识） */
  getCognitiveReport(): string {
    const stats = this.getStats();
    const recentCycles = this.getRecentCycles(5);
    const lines = [
      '=== 认知引擎报告 ===',
      `总决策次数: ${stats.totalDecisions}`,
      `成功率: ${(stats.successRate * 100).toFixed(1)}%`,
      `在线学习次数: ${stats.onlineLearnCount}`,
      `平均置信度: ${(stats.avgConfidence * 100).toFixed(1)}%`,
      `当前策略: ${stats.recentStrategy || '无'}`,
      '',
      '最近认知周期:',
    ];
    for (const c of recentCycles) {
      lines.push(`  [${new Date(c.timestamp).toISOString()}] ${c.decision.strategy} → ${c.reflection}`);
    }
    return lines.join('\n');
  }

  /** 保存模型 */
  saveModel(): void {
    this.decisionNet.saveModel();
  }

  /** 重置统计（不重置 NN 权重） */
  resetStats(): void {
    this.cycles = [];
    this.outcomes = [];
    this.recentErrors = new Array(20).fill(false);
    this.recentToolCalls = new Array(20).fill(0);
    this.totalDecisions = 0;
    this.successDecisions = 0;
  }
}
