/**
 * 世界模型 — WorldModel
 *
 * Agent 对外部世界的内部模型，可以预测环境变化和行动后果。
 *
 * 核心能力：
 * 1. 状态表示 — 将环境状态编码为内部表示
 * 2. 转移预测 — 预测行动后的下一个状态
 * 3. 奖励预测 — 预测行动的奖励
 * 4. 反事实推理 — "如果采取不同行动会怎样？"
 * 5. 规划 — 通过模拟多个未来来选择最优行动
 * 6. 不确定性估计 — 评估预测的置信度
 *
 * 架构：
 * - 编码器：将原始观察编码为潜在状态
 * - 转移模型：预测状态转移
 * - 奖励模型：预测奖励
 * - 解码器：从潜在状态解码为观察
 *
 * 应用场景：
 * - 行动规划：模拟多个行动，选择最优
 * - 风险评估：预测行动的潜在风险
 * - 因果推理：理解行动与结果的因果关系
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 世界状态 */
export interface WorldState {
  /** 状态 ID */
  id: string;
  /** 状态特征 */
  features: Record<string, number>;
  /** 时间戳 */
  timestamp: number;
  /** 状态描述 */
  description?: string;
}

/** 行动 */
export interface WorldAction {
  /** 行动 ID */
  id: string;
  /** 行动名称 */
  name: string;
  /** 行动参数 */
  params?: Record<string, unknown>;
}

/** 状态转移记录 */
export interface TransitionRecord {
  /** 记录 ID */
  id: string;
  /** 起始状态 */
  fromState: WorldState;
  /** 行动 */
  action: WorldAction;
  /** 结果状态 */
  toState: WorldState;
  /** 奖励 */
  reward: number;
  /** 是否终止 */
  done: boolean;
  /** 时间戳 */
  timestamp: number;
}

/** 预测结果 */
export interface PredictionResult {
  /** 预测的下一个状态 */
  predictedState: WorldState;
  /** 预测的奖励 */
  predictedReward: number;
  /** 置信度（0-1） */
  confidence: number;
  /** 预测的特征变化 */
  featureChanges: Record<string, { from: number; to: number; change: number }>;
}

/** 规划结果 */
export interface PlanResult {
  /** 推荐的行动序列 */
  actions: WorldAction[];
  /** 预测的总奖励 */
  expectedTotalReward: number;
  /** 每步的预测状态 */
  predictedStates: WorldState[];
  /** 风险评估 */
  risk: 'low' | 'medium' | 'high';
  /** 规划深度 */
  depth: number;
}

/** 反事实结果 */
export interface CounterfactualResult {
  /** 实际结果 */
  actual: { state: WorldState; reward: number };
  /** 假设结果 */
  hypothetical: { state: WorldState; reward: number };
  /** 差异分析 */
  difference: {
    rewardDelta: number;
    stateChanges: Record<string, number>;
  };
  /** 因果推断 */
  causalInference: string;
}

// ============ 世界模型 ============

export class WorldModel {
  /** 工作目录 */
  private workDir: string;

  /** 状态转移历史 */
  private transitions: TransitionRecord[] = [];

  /** 最大历史记录数 */
  private maxTransitions = 50000;

  /** 状态编码映射（特征→索引） */
  private featureIndex: Map<string, number> = new Map();

  /** 转移概率模型：stateActionKey → Map<stateKey, probability> */
  private transitionModel: Map<string, Map<string, number>> = new Map();

  /** 奖励模型：stateActionKey → average reward */
  private rewardModel: Map<string, { total: number; count: number; avg: number }> = new Map();

  /** 状态访问频率 */
  private stateFrequency: Map<string, number> = new Map();

  /** 规划深度（默认 5 步） */
  private planningDepth = 5;

  /** 模拟次数（规划时） */
  private simulationCount = 100;

  private log = logger.child({ module: 'WorldModel' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('world-model');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.loadModel();
  }

  // ========== 状态管理 ==========

  /**
   * 编码世界状态
   */
  encodeState(features: Record<string, number>, description?: string): WorldState {
    // 更新特征索引
    for (const key of Object.keys(features)) {
      if (!this.featureIndex.has(key)) {
        this.featureIndex.set(key, this.featureIndex.size);
      }
    }

    // 生成状态 ID（基于特征哈希）
    const featureStr = Object.entries(features)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join('|');

    const stateId = `state_${this.hashString(featureStr)}`;

    return {
      id: stateId,
      features,
      timestamp: Date.now(),
      description,
    };
  }

  /**
   * 记录状态转移
   */
  recordTransition(
    fromState: WorldState,
    action: WorldAction,
    toState: WorldState,
    reward: number,
    done: boolean = false,
  ): TransitionRecord {
    const record: TransitionRecord = {
      id: `trans_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      fromState,
      action,
      toState,
      reward,
      done,
      timestamp: Date.now(),
    };

    this.transitions.push(record);
    if (this.transitions.length > this.maxTransitions) {
      this.transitions.shift();
    }

    // 更新模型
    this.updateTransitionModel(record);
    this.updateRewardModel(record);
    this.updateStateFrequency(toState.id);

    EventBus.getInstance().emitSync('world-model.transition.recorded', {
      fromStateId: fromState.id,
      actionId: action.id,
      toStateId: toState.id,
      reward,
    });

    return record;
  }

  // ========== 预测 ==========

  /**
   * 预测行动后的下一个状态
   */
  predict(currentState: WorldState, action: WorldAction): PredictionResult {
    const stateActionKey = this.getStateActionKey(currentState, action);

    // 1. 预测下一个状态
    const transitionProbs = this.transitionModel.get(stateActionKey);
    let predictedStateId = currentState.id;
    let confidence = 0;

    if (transitionProbs && transitionProbs.size > 0) {
      // 选择概率最高的状态
      let maxProb = 0;
      for (const [stateId, prob] of transitionProbs) {
        if (prob > maxProb) {
          maxProb = prob;
          predictedStateId = stateId;
        }
      }
      confidence = maxProb;
    }

    // 构建预测状态
    const predictedState = this.reconstructState(predictedStateId, currentState);

    // 2. 预测奖励
    const rewardData = this.rewardModel.get(stateActionKey);
    const predictedReward = rewardData?.avg ?? 0;

    // 3. 计算特征变化
    const featureChanges: Record<string, { from: number; to: number; change: number }> = {};
    for (const [key, fromVal] of Object.entries(currentState.features)) {
      const toVal = predictedState.features[key] ?? fromVal;
      featureChanges[key] = {
        from: fromVal,
        to: toVal,
        change: toVal - fromVal,
      };
    }

    return {
      predictedState,
      predictedReward,
      confidence,
      featureChanges,
    };
  }

  /**
   * 多步预测
   */
  predictMultiStep(currentState: WorldState, actions: WorldAction[]): Array<{ state: WorldState; reward: number; confidence: number }> {
    const results: Array<{ state: WorldState; reward: number; confidence: number }> = [];
    let state = currentState;
    let cumulativeConfidence = 1;

    for (const action of actions) {
      const prediction = this.predict(state, action);
      cumulativeConfidence *= prediction.confidence;
      results.push({
        state: prediction.predictedState,
        reward: prediction.predictedReward,
        confidence: cumulativeConfidence,
      });
      state = prediction.predictedState;
    }

    return results;
  }

  // ========== 规划 ==========

  /**
   * 规划最优行动序列
   *
   * 通过蒙特卡洛模拟多个未来，选择期望奖励最高的行动序列。
   */
  plan(
    currentState: WorldState,
    availableActions: WorldAction[],
    depth: number = this.planningDepth,
  ): PlanResult {
    let bestPlan: WorldAction[] = [];
    let bestReward = -Infinity;
    let bestStates: WorldState[] = [];
    let bestRisk: 'low' | 'medium' | 'high' = 'high';

    // 蒙特卡洛模拟
    for (let sim = 0; sim < this.simulationCount; sim++) {
      const result = this.simulateRollout(currentState, availableActions, depth);

      if (result.totalReward > bestReward) {
        bestReward = result.totalReward;
        bestPlan = result.actions;
        bestStates = result.states;
        bestRisk = result.risk;
      }
    }

    return {
      actions: bestPlan,
      expectedTotalReward: bestReward,
      predictedStates: bestStates,
      risk: bestRisk,
      depth,
    };
  }

  /**
   * 模拟一次行动序列
   */
  private simulateRollout(
    currentState: WorldState,
    availableActions: WorldAction[],
    depth: number,
  ): { actions: WorldAction[]; states: WorldState[]; totalReward: number; risk: 'low' | 'medium' | 'high' } {
    const actions: WorldAction[] = [];
    const states: WorldState[] = [];
    let state = currentState;
    let totalReward = 0;
    let negativeCount = 0;

    for (let d = 0; d < depth; d++) {
      // 随机选择行动（ε-greedy 简化版）
      const action = availableActions[Math.floor(Math.random() * availableActions.length)];

      // 预测
      const prediction = this.predict(state, action);

      actions.push(action);
      states.push(prediction.predictedState);
      totalReward += prediction.predictedReward;

      if (prediction.predictedReward < 0) {
        negativeCount++;
      }

      state = prediction.predictedState;
    }

    let risk: 'low' | 'medium' | 'high';
    if (negativeCount > depth * 0.5) risk = 'high';
    else if (negativeCount > depth * 0.2) risk = 'medium';
    else risk = 'low';

    return { actions, states, totalReward, risk };
  }

  // ========== 反事实推理 ==========

  /**
   * 反事实推理："如果采取不同行动会怎样？"
   */
  counterfactual(
    actualState: WorldState,
    actualAction: WorldAction,
    actualNextState: WorldState,
    actualReward: number,
    hypotheticalAction: WorldAction,
  ): CounterfactualResult {
    // 预测假设行动的结果
    const prediction = this.predict(actualState, hypotheticalAction);

    // 计算差异
    const rewardDelta = prediction.predictedReward - actualReward;
    const stateChanges: Record<string, number> = {};

    for (const key of Object.keys(prediction.predictedState.features)) {
      const actualVal = actualNextState.features[key] ?? 0;
      const hypoVal = prediction.predictedState.features[key] ?? 0;
      stateChanges[key] = hypoVal - actualVal;
    }

    // 因果推断
    let causalInference: string;
    if (Math.abs(rewardDelta) < 0.1) {
      causalInference = '行动选择对结果影响较小';
    } else if (rewardDelta > 0) {
      causalInference = `假设行动 "${hypotheticalAction.name}" 可能比实际行动 "${actualAction.name}" 更优（预期奖励提升 ${rewardDelta.toFixed(2)}）`;
    } else {
      causalInference = `实际行动 "${actualAction.name}" 是更优选择（假设行动预期奖励降低 ${Math.abs(rewardDelta).toFixed(2)}）`;
    }

    return {
      actual: { state: actualNextState, reward: actualReward },
      hypothetical: { state: prediction.predictedState, reward: prediction.predictedReward },
      difference: { rewardDelta, stateChanges },
      causalInference,
    };
  }

  // ========== 模型更新 ==========

  /**
   * 更新转移模型
   */
  private updateTransitionModel(record: TransitionRecord): void {
    const key = this.getStateActionKey(record.fromState, record.action);
    if (!this.transitionModel.has(key)) {
      this.transitionModel.set(key, new Map());
    }
    const probs = this.transitionModel.get(key)!;

    const toStateId = record.toState.id;
    const currentCount = probs.get(toStateId) ?? 0;
    probs.set(toStateId, currentCount + 1);

    // 归一化为概率
    const total = Array.from(probs.values()).reduce((a, b) => a + b, 0);
    for (const [stateId, count] of probs) {
      probs.set(stateId, count / total);
    }
  }

  /**
   * 更新奖励模型
   */
  private updateRewardModel(record: TransitionRecord): void {
    const key = this.getStateActionKey(record.fromState, record.action);
    if (!this.rewardModel.has(key)) {
      this.rewardModel.set(key, { total: 0, count: 0, avg: 0 });
    }
    const data = this.rewardModel.get(key)!;
    data.total += record.reward;
    data.count += 1;
    data.avg = data.total / data.count;
  }

  /**
   * 更新状态频率
   */
  private updateStateFrequency(stateId: string): void {
    this.stateFrequency.set(stateId, (this.stateFrequency.get(stateId) ?? 0) + 1);
  }

  // ========== 辅助方法 ==========

  /**
   * 获取状态-行动键
   */
  private getStateActionKey(state: WorldState, action: WorldAction): string {
    return `${state.id}::${action.id}`;
  }

  /**
   * 重构状态
   */
  private reconstructState(stateId: string, referenceState: WorldState): WorldState {
    // 查找历史中该状态的特征
    for (let i = this.transitions.length - 1; i >= 0; i--) {
      const trans = this.transitions[i];
      if (trans.toState.id === stateId) {
        return { ...trans.toState, timestamp: Date.now() };
      }
    }

    // 如果找不到，基于参考状态微调
    const features = { ...referenceState.features };
    // 添加少量随机扰动模拟不确定性
    for (const key of Object.keys(features)) {
      features[key] += (Math.random() - 0.5) * 0.1;
    }

    return {
      id: stateId,
      features,
      timestamp: Date.now(),
      description: '预测状态',
    };
  }

  /**
   * 字符串哈希
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  // ========== 查询 ==========

  /**
   * 获取模型统计
   */
  getStats(): {
    totalTransitions: number;
    uniqueStates: number;
    uniqueActions: number;
    transitionModelSize: number;
    rewardModelSize: number;
    avgConfidence: number;
  } {
    const uniqueStates = new Set<string>();
    const uniqueActions = new Set<string>();

    for (const trans of this.transitions) {
      uniqueStates.add(trans.fromState.id);
      uniqueStates.add(trans.toState.id);
      uniqueActions.add(trans.action.id);
    }

    // 计算平均置信度
    let totalConfidence = 0;
    let confidenceCount = 0;
    for (const probs of this.transitionModel.values()) {
      for (const prob of probs.values()) {
        totalConfidence += prob;
        confidenceCount++;
      }
    }

    return {
      totalTransitions: this.transitions.length,
      uniqueStates: uniqueStates.size,
      uniqueActions: uniqueActions.size,
      transitionModelSize: this.transitionModel.size,
      rewardModelSize: this.rewardModel.size,
      avgConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    };
  }

  /**
   * 获取最近转移
   */
  getRecentTransitions(count: number = 10): TransitionRecord[] {
    return this.transitions.slice(-count).reverse();
  }

  // ========== 持久化 ==========

  /** 保存模型 */
  saveModel(): void {
    try {
      const data = {
        transitions: this.transitions.slice(-5000),
        featureIndex: Array.from(this.featureIndex.entries()),
        transitionModel: Array.from(this.transitionModel.entries()).map(([key, probs]) => ({
          key,
          probs: Array.from(probs.entries()),
        })),
        rewardModel: Array.from(this.rewardModel.entries()),
        stateFrequency: Array.from(this.stateFrequency.entries()),
      };
      const modelPath = path.join(this.workDir, 'world-model-data.json');
      atomicWriteJsonSync(modelPath, data);
    } catch (err: unknown) {
      this.log.error('保存世界模型失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 加载模型 */
  private loadModel(): void {
    try {
      const modelPath = path.join(this.workDir, 'world-model-data.json');
      if (!fs.existsSync(modelPath)) return;

      const data = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));

      this.transitions = data.transitions ?? [];

      for (const [feature, idx] of data.featureIndex ?? []) {
        this.featureIndex.set(feature, idx);
      }

      for (const { key, probs } of data.transitionModel ?? []) {
        this.transitionModel.set(key, new Map(probs));
      }

      for (const [key, rewardData] of data.rewardModel ?? []) {
        this.rewardModel.set(key, rewardData);
      }

      for (const [stateId, freq] of data.stateFrequency ?? []) {
        this.stateFrequency.set(stateId, freq);
      }

      this.log.info('世界模型已加载', {
        transitions: this.transitions.length,
        transitionModelSize: this.transitionModel.size,
      });
    } catch (err: unknown) {
      this.log.error('加载世界模型失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
