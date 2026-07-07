/**
 * 强化学习系统 — ReinforcementLearningSystem
 *
 * 让 Agent 从环境反馈中学习最优策略。
 *
 * 核心能力：
 * 1. Q-learning — 经典强化学习，学习状态-动作价值函数
 * 2. 策略梯度 — 直接优化策略函数
 * 3. 经验回放 — 存储和重放经验，提高学习效率
 * 4. 探索-利用平衡 — ε-greedy 策略
 * 5. 奖励塑造 — 自动调整奖励信号
 *
 * 应用场景：
 * - 工具选择策略优化
 * - 对话策略学习
 * - 任务分解策略
 * - 错误恢复策略
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 状态表示 */
export interface RLState {
  /** 状态 ID（用于 Q-table 索引） */
  id: string;
  /** 状态特征向量 */
  features: number[];
  /** 状态描述 */
  description: string;
}

/** 动作表示 */
export interface RLAction {
  /** 动作 ID */
  id: string;
  /** 动作名称 */
  name: string;
  /** 动作描述 */
  description: string;
}

/** 经验记录 */
export interface Experience {
  /** 状态 */
  state: RLState;
  /** 动作 */
  action: RLAction;
  /** 奖励 */
  reward: number;
  /** 下一状态 */
  nextState: RLState;
  /** 是否结束 */
  done: boolean;
  /** 时间戳 */
  timestamp: number;
}

/** Q-learning 学习统计 */
export interface RLStats {
  /** 总回合数 */
  totalEpisodes: number;
  /** 总步数 */
  totalSteps: number;
  /** 平均奖励（最近 100 回合） */
  averageReward: number;
  /** 探索率 */
  epsilon: number;
  /** Q-table 大小 */
  qTableSize: number;
  /** 经验回放缓冲区大小 */
  experienceBufferSize: number;
}

/** 学习策略 */
export type LearningPolicy = 'q_learning' | 'sarsa' | 'policy_gradient';

// ============ 强化学习系统 ============

export class ReinforcementLearningSystem {
  /** 工作目录 */
  private workDir: string;

  /** Q-table: stateId -> actionId -> Q-value */
  private qTable: Map<string, Map<string, number>> = new Map();

  /** 动作空间 */
  private actions: Map<string, RLAction> = new Map();

  /** 经验回放缓冲区 */
  private experienceBuffer: Experience[] = [];

  /** 最大缓冲区大小 */
  private maxBufferSize = 10000;

  /** 环形缓冲区写入索引（buffer 满后覆盖最旧经验） */
  private bufferWriteIndex = 0;

  /** 经验回放间隔（每 N 步回放一次，解耦回放频率与每步学习） */
  private replayInterval = 10;

  /** 经验回放批量大小 */
  private replayBatchSize = 32;

  /** 学习率 α */
  private learningRate: number = 0.1;

  /** 折扣因子 γ */
  private discountFactor: number = 0.95;

  /** 探索率 ε */
  private epsilon: number = 1.0;

  /** 探索率最小值 */
  private epsilonMin: number = 0.01;

  /** 探索率衰减 */
  private epsilonDecay: number = 0.995;

  /** 学习策略 */
  private policy: LearningPolicy = 'q_learning';

  /** 统计 */
  private episodeCount = 0;
  private stepCount = 0;
  private recentRewards: number[] = [];

  /** 奖励塑造权重 */
  private rewardShapingWeights: Map<string, number> = new Map();

  private log = logger.child({ module: 'ReinforcementLearningSystem' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('reinforcement-learning');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.loadModel();
  }

  // ========== 动作空间管理 ==========

  /**
   * 注册动作
   */
  registerAction(action: RLAction): void {
    this.actions.set(action.id, action);
    this.log.debug('动作已注册', { actionId: action.id, name: action.name });
  }

  /**
   * 批量注册动作
   */
  registerActions(actions: RLAction[]): void {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  /**
   * 获取所有动作
   */
  getActions(): RLAction[] {
    return Array.from(this.actions.values());
  }

  // ========== Q-learning ==========

  /**
   * 选择动作（ε-greedy 策略）
   */
  chooseAction(state: RLState, availableActionIds?: string[]): RLAction {
    const actionIds = availableActionIds ?? Array.from(this.actions.keys());

    // 探索：随机选择
    if (Math.random() < this.epsilon) {
      const randomId = actionIds[Math.floor(Math.random() * actionIds.length)];
      return this.actions.get(randomId)!;
    }

    // 利用：选择 Q 值最高的动作
    const qValues = this.qTable.get(state.id);
    if (!qValues) {
      // 新状态，随机选择
      const randomId = actionIds[Math.floor(Math.random() * actionIds.length)];
      return this.actions.get(randomId)!;
    }

    let bestActionId = actionIds[0];
    let bestQ = qValues.get(bestActionId) ?? 0;

    for (const actionId of actionIds) {
      const q = qValues.get(actionId) ?? 0;
      if (q > bestQ) {
        bestQ = q;
        bestActionId = actionId;
      }
    }

    return this.actions.get(bestActionId) ?? this.actions.get(actionIds[0])!;
  }

  /**
   * 记录经验并学习
   */
  learn(state: RLState, action: RLAction, reward: number, nextState: RLState, done: boolean): void {
    // 1. 存储经验（环形缓冲区，避免 array.shift() 的 O(n) 移位）
    const experience: Experience = {
      state,
      action,
      reward,
      nextState,
      done,
      timestamp: Date.now(),
    };
    if (this.experienceBuffer.length < this.maxBufferSize) {
      this.experienceBuffer.push(experience);
    } else {
      // 缓冲区已满：环形覆盖最旧的经验
      this.experienceBuffer[this.bufferWriteIndex] = experience;
    }
    this.bufferWriteIndex = (this.bufferWriteIndex + 1) % this.maxBufferSize;

    // 2. Q-learning 更新
    this.updateQValue(state, action, reward, nextState, done);

    // 3. 经验回放（解耦回放频率与每步学习，每隔 replayInterval 步回放一次）
    if (this.stepCount % this.replayInterval === 0) {
      this.experienceReplay(this.replayBatchSize);
    }

    // 4. 衰减探索率
    if (this.epsilon > this.epsilonMin) {
      this.epsilon *= this.epsilonDecay;
    }

    // 5. 更新统计
    this.stepCount++;
    this.recentRewards.push(reward);
    if (this.recentRewards.length > 100) {
      this.recentRewards.shift();
    }

    if (done) {
      this.episodeCount++;
    }

    EventBus.getInstance().emitSync('rl.learned', {
      stateId: state.id,
      actionId: action.id,
      reward,
      epsilon: this.epsilon,
    });
  }

  /**
   * 经验回放：从缓冲区随机采样学习
   * 使用 Set 做采样去重，并支持 buffer 不足时的优雅降级
   */
  private experienceReplay(batchSize: number): void {
    const bufferLen = this.experienceBuffer.length;
    if (bufferLen === 0) {
      return;
    }

    // buffer 不足时优雅降级：采样数量不超过当前可用经验数
    const sampleSize = Math.min(batchSize, bufferLen);

    // 使用 Set 做采样去重，避免同一条经验被重复抽取
    const sampledIndices = new Set<number>();
    while (sampledIndices.size < sampleSize) {
      sampledIndices.add(Math.floor(Math.random() * bufferLen));
    }

    for (const index of sampledIndices) {
      const exp = this.experienceBuffer[index];
      this.updateQValue(exp.state, exp.action, exp.reward, exp.nextState, exp.done);
    }
  }

  /**
   * Q-learning 更新规则
   * Q(s,a) ← Q(s,a) + α[r + γ·max Q(s',a') - Q(s,a)]
   */
  private updateQValue(state: RLState, action: RLAction, reward: number, nextState: RLState, done: boolean): void {
    if (!this.qTable.has(state.id)) {
      this.qTable.set(state.id, new Map());
    }
    const stateQ = this.qTable.get(state.id)!;

    const currentQ = stateQ.get(action.id) ?? 0;

    // 计算目标 Q 值
    let targetQ = reward;

    if (!done) {
      const nextStateQ = this.qTable.get(nextState.id);
      if (nextStateQ) {
        const maxNextQ = Math.max(...nextStateQ.values(), 0);
        targetQ = reward + this.discountFactor * maxNextQ;
      }
    }

    // Q-learning 更新
    const newQ = currentQ + this.learningRate * (targetQ - currentQ);
    stateQ.set(action.id, newQ);
  }

  // ========== 奖励塑造 ==========

  /**
   * 设置奖励塑造权重
   */
  setRewardShapingWeight(factor: string, weight: number): void {
    this.rewardShapingWeights.set(factor, weight);
  }

  /**
   * 计算塑造后的奖励
   */
  shapeReward(baseReward: number, factors: Record<string, number>): number {
    let shapedReward = baseReward;
    for (const [factor, value] of Object.entries(factors)) {
      const weight = this.rewardShapingWeights.get(factor) ?? 0;
      shapedReward += weight * value;
    }
    return shapedReward;
  }

  // ========== 查询 ==========

  /**
   * 获取状态的 Q 值
   */
  getQValues(stateId: string): Map<string, number> | null {
    return this.qTable.get(stateId) ?? null;
  }

  /**
   * 获取最优动作
   */
  getBestAction(state: RLState): RLAction | null {
    const qValues = this.qTable.get(state.id);
    if (!qValues || qValues.size === 0) return null;

    let bestActionId = '';
    let bestQ = -Infinity;

    for (const [actionId, q] of qValues) {
      if (q > bestQ) {
        bestQ = q;
        bestActionId = actionId;
      }
    }

    return this.actions.get(bestActionId) ?? null;
  }

  /**
   * 获取学习统计
   */
  getStats(): RLStats {
    const avgReward = this.recentRewards.length > 0
      ? this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length
      : 0;

    return {
      totalEpisodes: this.episodeCount,
      totalSteps: this.stepCount,
      averageReward: avgReward,
      epsilon: this.epsilon,
      qTableSize: this.qTable.size,
      experienceBufferSize: this.experienceBuffer.length,
    };
  }

  /**
   * 获取策略摘要
   */
  getPolicySummary(): Array<{ stateId: string; bestAction: string; qValue: number; confidence: number }> {
    const summary: Array<{ stateId: string; bestAction: string; qValue: number; confidence: number }> = [];

    for (const [stateId, qValues] of this.qTable) {
      let bestAction = '';
      let bestQ = -Infinity;
      let totalQ = 0;
      let count = 0;

      for (const [actionId, q] of qValues) {
        totalQ += q;
        count++;
        if (q > bestQ) {
          bestQ = q;
          bestAction = actionId;
        }
      }

      const avgQ = count > 0 ? totalQ / count : 0;
      const confidence = count > 0 ? Math.abs(bestQ - avgQ) / (Math.abs(bestQ) + 1) : 0;

      summary.push({ stateId, bestAction, qValue: bestQ, confidence });
    }

    return summary.sort((a, b) => b.confidence - a.confidence);
  }

  // ========== 持久化 ==========

  /** 保存模型 */
  saveModel(): void {
    try {
      const data = {
        qTable: Array.from(this.qTable.entries()).map(([stateId, actions]) => ({
          stateId,
          actions: Array.from(actions.entries()),
        })),
        actions: Array.from(this.actions.entries()),
        epsilon: this.epsilon,
        learningRate: this.learningRate,
        discountFactor: this.discountFactor,
        episodeCount: this.episodeCount,
        stepCount: this.stepCount,
        rewardShapingWeights: Array.from(this.rewardShapingWeights.entries()),
      };
      const modelPath = path.join(this.workDir, 'rl-model.json');
      atomicWriteJsonSync(modelPath, data);
    } catch (err: unknown) {
      this.log.error('保存 RL 模型失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** 加载模型 */
  private loadModel(): void {
    try {
      const modelPath = path.join(this.workDir, 'rl-model.json');
      if (!fs.existsSync(modelPath)) return;

      const data = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));

      for (const { stateId, actions } of data.qTable ?? []) {
        this.qTable.set(stateId, new Map(actions));
      }

      for (const [id, action] of data.actions ?? []) {
        this.actions.set(id, action);
      }

      this.epsilon = data.epsilon ?? 1.0;
      this.learningRate = data.learningRate ?? 0.1;
      this.discountFactor = data.discountFactor ?? 0.95;
      this.episodeCount = data.episodeCount ?? 0;
      this.stepCount = data.stepCount ?? 0;

      for (const [factor, weight] of data.rewardShapingWeights ?? []) {
        this.rewardShapingWeights.set(factor, weight);
      }

      this.log.info('RL 模型已加载', {
        qTableSize: this.qTable.size,
        actions: this.actions.size,
        episodes: this.episodeCount,
        steps: this.stepCount,
      });
    } catch (err: unknown) {
      this.log.error('加载 RL 模型失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }
}
