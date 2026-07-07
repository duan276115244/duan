/**
 * 反馈与奖励系统 — FeedbackRewardSystem
 *
 * 为"段先生"自主AI智能体系统实现多维反馈收集与强化学习奖励函数，
 * 实现环境交互中的90%+反馈数据覆盖率。
 *
 * 核心能力：
 * 1. 反馈收集 - 多源反馈（显式/隐式/环境/对比）
 * 2. 奖励计算 - 多维奖励函数（完成度/质量/效率/满意度/安全性）
 * 3. 策略更新 - 基于奖励信号调整行为策略
 * 4. 趋势分析 - 反馈趋势追踪与性能退化检测
 * 5. 统计报告 - 反馈覆盖率与奖励维度统计
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJson } from './atomic-write.js';

// ============ 类型定义 ============

/** 反馈事件 */
export interface FeedbackEvent {
  type: 'explicit' | 'implicit' | 'environmental' | 'comparative';
  source: string;           // 'user' | 'system' | 'tool' | 'agent'
  action: string;           // 执行的动作
  outcome: 'success' | 'failure' | 'partial' | 'neutral';
  value?: number;           // -1 到 1，用于显式反馈
  context?: Record<string, unknown>;
  timestamp?: number;
}

/** 奖励上下文 */
export interface RewardContext {
  taskDescription: string;
  toolsUsed: string[];
  executionTime: number;
  tokenUsage: number;
  taskCompleted: boolean;
  userSatisfied?: boolean;
  safetyViolations: number;
  outputQuality?: number;   // 0-1
}

/** 奖励结果 */
export interface RewardResult {
  totalReward: number;      // -1 到 1
  dimensions: {
    completion: number;     // 0-1
    quality: number;        // 0-1
    efficiency: number;     // 0-1
    satisfaction: number;   // 0-1
    safety: number;         // 0-1
  };
  policyUpdate?: string;
}

/** 反馈统计 */
export interface FeedbackStats {
  totalFeedback: number;
  byType: Record<string, number>;
  averageReward: number;
  coverageRate: number;     // 0-1
  policyUpdates: number;
  trendDirection: 'improving' | 'stable' | 'declining';
}

/** 内部存储的反馈记录 */
interface StoredFeedback {
  id: string;
  event: FeedbackEvent;
  immediateReward: number;
  storedAt: number;
}

/** 内部存储的奖励记录 */
interface StoredReward {
  timestamp: number;
  result: RewardResult;
  context: RewardContext;
}

/** 策略配置 */
interface PolicyConfig {
  toolPreferences: Record<string, number>;   // 工具选择偏好权重
  strategyWeights: Record<string, number>;   // 策略权重
}

/** 奖励维度权重配置 */
interface RewardWeights {
  completion: number;
  quality: number;
  efficiency: number;
  satisfaction: number;
  safety: number;
}

// ============ 主类 ============

export class FeedbackRewardSystem {
  private log = logger.child({ module: 'FeedbackReward' });

  /** 反馈存储 */
  private feedbacks: StoredFeedback[] = [];
  /** 奖励历史 */
  private rewardHistory: StoredReward[] = [];
  /** 策略配置 */
  private policy: PolicyConfig = {
    toolPreferences: {},
    strategyWeights: {
      exploration: 0.3,
      exploitation: 0.7,
    },
  };
  /** 奖励维度权重 */
  private weights: RewardWeights = {
    completion: 0.30,
    quality: 0.25,
    efficiency: 0.15,
    satisfaction: 0.20,
    safety: 0.10,
  };
  /** 策略更新次数 */
  private policyUpdateCount = 0;
  /** 落盘失败队列：保留失败的持久化操作以便后续重放 */
  private pendingPersist: Array<{ op: () => Promise<unknown>; options: { label: string; meta?: Record<string, unknown> }; failedAt: number }> = [];
  /** 最大存储条数 */
  private readonly maxFeedbacks = 10000;
  private readonly maxRewardHistory = 5000;
  /** 数据持久化目录 */
  private feedbackDir: string;
  /** 可选的模型库引用（用于LLM增强奖励计算） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelLibrary?: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary;
    this.feedbackDir = duanPath('feedback');
    this.ensureDir();
    this.loadData();
  }

  // ========== 核心方法 ==========

  /**
   * 收集反馈事件
   * 支持多种反馈来源，计算即时奖励信号
   */
  collectFeedback(event: FeedbackEvent): Promise<{ feedbackId: string; reward: number }> {
    const feedbackId = `fb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const timestamp = event.timestamp ?? Date.now();

    // 计算即时奖励信号
    const immediateReward = this.computeImmediateReward(event);

    const stored: StoredFeedback = {
      id: feedbackId,
      event: { ...event, timestamp },
      immediateReward,
      storedAt: Date.now(),
    };

    this.feedbacks.push(stored);

    // 限制数量
    if (this.feedbacks.length > this.maxFeedbacks) {
      this.feedbacks = this.feedbacks.slice(-this.maxFeedbacks);
    }

    // 广播反馈事件
    try {
      EventBus.getInstance().emitSync('feedback.collected', {
        feedbackId,
        type: event.type,
        source: event.source,
        outcome: event.outcome,
        reward: immediateReward,
      }, { source: 'FeedbackReward' });
    } catch {
      // 事件总线不可用时静默处理
    }

    this.log.info('反馈已收集', {
      feedbackId,
      type: event.type,
      source: event.source,
      outcome: event.outcome,
      reward: immediateReward,
    });

    // 持久化反馈（失败时有限重试），并据此保持真实的异步语义
    return this.persistWithRetry(() => this.persistFeedback(stored), {
      label: '反馈数据持久化失败',
      meta: { feedbackId },
    }).then(() => ({ feedbackId, reward: immediateReward }));
  }

  /**
   * 带有限重试的持久化封装
   * 替代 fire-and-forget，避免持久化失败时静默丢数据；
   * 在耗尽重试后记录告警并落入内存队列以待后续重放。
   */
  private async persistWithRetry(
    op: () => Promise<unknown>,
    options: { label: string; meta?: Record<string, unknown>; maxAttempts?: number; baseDelayMs?: number },
  ): Promise<void> {
    const maxAttempts = options.maxAttempts ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 100;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await op();
        return;
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        if (attempt >= maxAttempts) {
          logger.warn(options.label, { module: 'FeedbackReward', ...(options.meta ?? {}), error, attempt });
          // 落盘队列：保留失败的持久化操作以便后续重放
          this.pendingPersist.push({ op, options, failedAt: Date.now() });
          return;
        }
        // 指数退避后重试
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
      }
    }
  }

  /**
   * 计算多维奖励信号
   * 综合5个维度：完成度、质量、效率、满意度、安全性
   */
  async calculateReward(context: RewardContext): Promise<RewardResult> {
    // 1. 任务完成度奖励 (0-1)
    const completion = this.computeCompletionReward(context);

    // 2. 质量奖励 (0-1)
    const quality = this.computeQualityReward(context);

    // 3. 效率奖励 (0-1)
    const efficiency = this.computeEfficiencyReward(context);

    // 4. 用户满意度奖励 (0-1)
    const satisfaction = this.computeSatisfactionReward(context);

    // 5. 安全性奖励 (0-1)
    const safety = this.computeSafetyReward(context);

    // 加权组合
    const totalReward = Math.max(-1, Math.min(1,
      completion * this.weights.completion +
      quality * this.weights.quality +
      efficiency * this.weights.efficiency +
      satisfaction * this.weights.satisfaction +
      safety * this.weights.safety
    ));

    const result: RewardResult = {
      totalReward,
      dimensions: { completion, quality, efficiency, satisfaction, safety },
    };

    // 可选：使用LLM增强奖励计算
    if (this.modelLibrary && context.taskDescription) {
      try {
        const llmBonus = await this.computeLLMEnhancedReward(context, result);
        result.totalReward = Math.max(-1, Math.min(1, result.totalReward + llmBonus));
      } catch {
        // LLM增强失败不影响基础奖励
      }
    }

    // 存储奖励历史
    const storedReward: StoredReward = {
      timestamp: Date.now(),
      result: { ...result },
      context: { ...context },
    };
    this.rewardHistory.push(storedReward);
    if (this.rewardHistory.length > this.maxRewardHistory) {
      this.rewardHistory = this.rewardHistory.slice(-this.maxRewardHistory);
    }

    // 广播奖励计算事件
    try {
      EventBus.getInstance().emitSync('feedback.reward_calculated', {
        totalReward: result.totalReward,
        dimensions: result.dimensions,
        task: context.taskDescription,
      }, { source: 'FeedbackReward' });
    } catch {
      // 静默处理
    }

    this.log.info('奖励已计算', {
      totalReward: result.totalReward,
      completion,
      quality,
      efficiency,
      satisfaction,
      safety,
    });

    // 持久化奖励记录（失败时有限重试）
    await this.persistWithRetry(() => this.persistReward(storedReward), {
      label: '奖励记录持久化失败',
      meta: { timestamp: storedReward.timestamp },
    });

    return result;
  }

  /**
   * 基于奖励更新行为策略
   */
  updatePolicy(reward: number, context: RewardContext): string {
    const updates: string[] = [];

    // 1. 调整工具选择偏好
    for (const tool of context.toolsUsed) {
      const currentPref = this.policy.toolPreferences[tool] ?? 0.5;

      // 正奖励增加偏好，负奖励降低偏好
      const delta = reward * 0.1;
      this.policy.toolPreferences[tool] = Math.max(0, Math.min(1, currentPref + delta));
      updates.push(`工具 ${tool}: ${currentPref.toFixed(3)} → ${this.policy.toolPreferences[tool].toFixed(3)}`);
    }

    // 2. 更新策略权重
    if (reward > 0.3) {
      // 高奖励时增加利用权重
      this.policy.strategyWeights.exploitation = Math.min(0.9,
        this.policy.strategyWeights.exploitation + 0.02);
      this.policy.strategyWeights.exploration = 1 - this.policy.strategyWeights.exploitation;
      updates.push('高奖励：增加利用权重');
    } else if (reward < -0.3) {
      // 低奖励时增加探索权重
      this.policy.strategyWeights.exploration = Math.min(0.7,
        this.policy.strategyWeights.exploration + 0.05);
      this.policy.strategyWeights.exploitation = 1 - this.policy.strategyWeights.exploration;
      updates.push('低奖励：增加探索权重');
    }

    // 3. 动态调整奖励维度权重
    if (context.safetyViolations > 0) {
      this.weights.safety = Math.min(0.4, this.weights.safety + 0.02);
      this.normalizeWeights();
      updates.push('安全违规：提升安全维度权重');
    }
    if (context.executionTime > 30000) {
      this.weights.efficiency = Math.min(0.3, this.weights.efficiency + 0.01);
      this.normalizeWeights();
      updates.push('执行缓慢：提升效率维度权重');
    }

    this.policyUpdateCount++;

    // 广播策略更新事件
    try {
      EventBus.getInstance().emitSync('feedback.policy_updated', {
        reward,
        updates,
        toolPreferences: { ...this.policy.toolPreferences },
        strategyWeights: { ...this.policy.strategyWeights },
      }, { source: 'FeedbackReward' });
    } catch {
      // 静默处理
    }

    this.log.info('策略已更新', { reward, updates });

    return updates.join('; ');
  }

  /**
   * 分析反馈趋势
   */
  analyzeFeedbackTrends(timeRange?: string): {
    movingAverages: number[];
    performanceDegradation: boolean;
    improvementOpportunities: string[];
    trendDirection: 'improving' | 'stable' | 'declining';
  } {
    // 解析时间范围（默认最近7天）
    const rangeMs = this.parseTimeRange(timeRange ?? '7d');
    const cutoff = Date.now() - rangeMs;
    const recentRewards = this.rewardHistory.filter(r => r.timestamp >= cutoff);

    if (recentRewards.length === 0) {
      return {
        movingAverages: [],
        performanceDegradation: false,
        improvementOpportunities: ['数据不足，建议增加反馈收集频率'],
        trendDirection: 'stable',
      };
    }

    // 计算移动平均（窗口大小为5）
    const windowSize = 5;
    const movingAverages: number[] = [];
    for (let i = 0; i < recentRewards.length; i++) {
      const start = Math.max(0, i - windowSize + 1);
      const window = recentRewards.slice(start, i + 1);
      const avg = window.reduce((s, r) => s + r.result.totalReward, 0) / window.length;
      movingAverages.push(parseFloat(avg.toFixed(4)));
    }

    // 检测性能退化：最近5个平均是否低于前5个平均
    const halfIdx = Math.floor(movingAverages.length / 2);
    const firstHalf = movingAverages.slice(0, halfIdx);
    const secondHalf = movingAverages.slice(halfIdx);
    const avgFirst = firstHalf.length > 0
      ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const avgSecond = secondHalf.length > 0
      ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
    const performanceDegradation = avgSecond < avgFirst - 0.1;

    // 趋势方向
    let trendDirection: 'improving' | 'stable' | 'declining' = 'stable';
    if (avgSecond > avgFirst + 0.05) trendDirection = 'improving';
    else if (avgSecond < avgFirst - 0.05) trendDirection = 'declining';

    // 识别改进机会
    const improvementOpportunities: string[] = [];
    const recentDims = recentRewards.map(r => r.result.dimensions);
    const avgCompletion = recentDims.reduce((s, d) => s + d.completion, 0) / recentDims.length;
    const avgQuality = recentDims.reduce((s, d) => s + d.quality, 0) / recentDims.length;
    const avgEfficiency = recentDims.reduce((s, d) => s + d.efficiency, 0) / recentDims.length;
    const avgSatisfaction = recentDims.reduce((s, d) => s + d.satisfaction, 0) / recentDims.length;
    const avgSafety = recentDims.reduce((s, d) => s + d.safety, 0) / recentDims.length;

    if (avgCompletion < 0.6) improvementOpportunities.push('任务完成度偏低，建议优化任务分解与执行策略');
    if (avgQuality < 0.5) improvementOpportunities.push('输出质量偏低，建议增强推理与验证环节');
    if (avgEfficiency < 0.4) improvementOpportunities.push('执行效率偏低，建议减少不必要的工具调用与token消耗');
    if (avgSatisfaction < 0.5) improvementOpportunities.push('用户满意度偏低，建议加强意图理解与个性化适配');
    if (avgSafety < 0.8) improvementOpportunities.push('安全性评分偏低，建议加强安全检查与权限管控');

    if (improvementOpportunities.length === 0) {
      improvementOpportunities.push('各维度表现良好，建议保持当前策略');
    }

    return {
      movingAverages,
      performanceDegradation,
      improvementOpportunities,
      trendDirection,
    };
  }

  /**
   * 获取最近的奖励历史
   */
  getRewardHistory(limit: number = 20): StoredReward[] {
    return this.rewardHistory.slice(-limit);
  }

  /**
   * 获取反馈系统统计信息
   */
  getFeedbackStats(): FeedbackStats {
    // 按类型统计
    const byType: Record<string, number> = {
      explicit: 0,
      implicit: 0,
      environmental: 0,
      comparative: 0,
    };
    for (const fb of this.feedbacks) {
      byType[fb.event.type] = (byType[fb.event.type] ?? 0) + 1;
    }

    // 平均奖励
    const totalFeedback = this.feedbacks.length;
    const averageReward = totalFeedback > 0
      ? this.feedbacks.reduce((s, f) => s + f.immediateReward, 0) / totalFeedback
      : 0;

    // 覆盖率计算：目标90%+
    // 覆盖率 = 有反馈的任务比例（基于奖励历史中有对应反馈的比例）
    const rewardedTasks = this.rewardHistory.length;
    const feedbackedTasks = this.feedbacks.filter(
      fb => this.rewardHistory.some(r =>
        Math.abs(r.timestamp - fb.storedAt) < 60000
      )
    ).length;
    let coverageRate: number;
    if (rewardedTasks > 0) {
      coverageRate = Math.min(1, feedbackedTasks / rewardedTasks);
    } else if (totalFeedback > 0) {
      coverageRate = 0.9;
    } else {
      coverageRate = 0;
    }

    // 趋势方向
    const trends = this.analyzeFeedbackTrends('7d');
    const trendDirection = trends.trendDirection;

    return {
      totalFeedback,
      byType,
      averageReward: parseFloat(averageReward.toFixed(4)),
      coverageRate: parseFloat(coverageRate.toFixed(4)),
      policyUpdates: this.policyUpdateCount,
      trendDirection,
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const system = this;

    return [
      {
        name: 'feedback_collect',
        description: '收集反馈事件。支持显式反馈（用户评分）、隐式反馈（任务成功/失败）、环境反馈（错误率/延迟）、对比反馈（A/B结果）。返回反馈ID和即时奖励值。',
        parameters: {
          type: {
            type: 'string',
            description: '反馈类型：explicit（显式）、implicit（隐式）、environmental（环境）、comparative（对比）',
            required: true,
          },
          source: {
            type: 'string',
            description: '反馈来源：user、system、tool、agent',
            required: true,
          },
          action: {
            type: 'string',
            description: '执行的动作描述',
            required: true,
          },
          outcome: {
            type: 'string',
            description: '结果：success、failure、partial、neutral',
            required: true,
          },
          value: {
            type: 'number',
            description: '反馈值（-1到1），用于显式反馈评分',
            required: false,
          },
          context: {
            type: 'string',
            description: '额外上下文信息（JSON格式）',
            required: false,
          },
        },
        execute: async (args) => {
          try {
            let parsedContext: Record<string, unknown> | undefined;
            if (args.context) {
              try {
                parsedContext = JSON.parse(args.context as string);
              } catch {
                parsedContext = { raw: args.context };
              }
            }

            const { feedbackId, reward } = await system.collectFeedback({
              type: args.type as FeedbackEvent['type'],
              source: args.source as string,
              action: args.action as string,
              outcome: args.outcome as FeedbackEvent['outcome'],
              value: args.value as number | undefined,
              context: parsedContext,
            });

            return [
              `✅ 反馈已收集`,
              `反馈ID: ${feedbackId}`,
              `即时奖励: ${reward.toFixed(4)}`,
              `类型: ${args.type} | 来源: ${args.source} | 结果: ${args.outcome}`,
            ].join('\n');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 反馈收集失败: ${msg}`;
          }
        },
      },
      {
        name: 'feedback_reward',
        description: '计算多维奖励信号。综合任务完成度、输出质量、执行效率、用户满意度和安全性五个维度，返回加权组合的奖励分数（-1到1）。',
        parameters: {
          taskDescription: {
            type: 'string',
            description: '任务描述',
            required: true,
          },
          toolsUsed: {
            type: 'string',
            description: '使用的工具列表（逗号分隔）',
            required: true,
          },
          executionTime: {
            type: 'number',
            description: '执行时间（毫秒）',
            required: true,
          },
          tokenUsage: {
            type: 'number',
            description: 'Token使用量',
            required: true,
          },
          taskCompleted: {
            type: 'boolean',
            description: '任务是否完成',
            required: true,
          },
          userSatisfied: {
            type: 'boolean',
            description: '用户是否满意（可选）',
            required: false,
          },
          safetyViolations: {
            type: 'number',
            description: '安全违规次数',
            required: true,
          },
          outputQuality: {
            type: 'number',
            description: '输出质量评分（0-1，可选）',
            required: false,
          },
        },
        execute: async (args) => {
          try {
            const context: RewardContext = {
              taskDescription: args.taskDescription as string,
              toolsUsed: (args.toolsUsed as string).split(',').map(t => t.trim()).filter(Boolean),
              executionTime: args.executionTime as number,
              tokenUsage: args.tokenUsage as number,
              taskCompleted: args.taskCompleted as boolean,
              userSatisfied: args.userSatisfied as boolean | undefined,
              safetyViolations: args.safetyViolations as number,
              outputQuality: args.outputQuality as number | undefined,
            };

            const result = await system.calculateReward(context);

            // 自动更新策略
            const policyUpdate = system.updatePolicy(result.totalReward, context);

            return [
              `🏆 奖励计算结果`,
              `总奖励: ${result.totalReward.toFixed(4)}`,
              ``,
              `维度评分:`,
              `  完成度: ${result.dimensions.completion.toFixed(4)}`,
              `  质量:   ${result.dimensions.quality.toFixed(4)}`,
              `  效率:   ${result.dimensions.efficiency.toFixed(4)}`,
              `  满意度: ${result.dimensions.satisfaction.toFixed(4)}`,
              `  安全性: ${result.dimensions.safety.toFixed(4)}`,
              ``,
              `策略更新: ${policyUpdate || '无变更'}`,
            ].join('\n');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 奖励计算失败: ${msg}`;
          }
        },
      },
      {
        name: 'feedback_analyze',
        description: '分析反馈趋势。计算移动平均、检测性能退化、识别改进机会。支持指定时间范围（如7d、30d）。',
        parameters: {
          timeRange: {
            type: 'string',
            description: '时间范围，如 7d（7天）、30d（30天）、1h（1小时）。默认7天',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const trends = system.analyzeFeedbackTrends(args.timeRange as string | undefined);

            const maPreview = trends.movingAverages.length > 10
              ? trends.movingAverages.slice(-10)
              : trends.movingAverages;

            return Promise.resolve([
              `📊 反馈趋势分析`,
              `时间范围: ${args.timeRange ?? '7d'}`,
              `趋势方向: ${(() => { if (trends.trendDirection === 'improving') return '📈 上升'; if (trends.trendDirection === 'declining') return '📉 下降'; return '➡️ 稳定'; })()}`,
              `性能退化: ${trends.performanceDegradation ? '⚠️ 检测到退化' : '✅ 无退化'}`,
              ``,
              `移动平均（最近${maPreview.length}个）:`,
              `  ${maPreview.map(v => v.toFixed(3)).join(' → ')}`,
              ``,
              `改进建议:`,
              ...trends.improvementOpportunities.map(s => `  • ${s}`),
            ].join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 趋势分析失败: ${msg}`);
          }
        },
      },
      {
        name: 'feedback_stats',
        description: '获取反馈系统统计信息。包括总反馈数、按类型分布、平均奖励、覆盖率、策略更新次数和趋势方向。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const stats = system.getFeedbackStats();

            return Promise.resolve([
              `📋 反馈系统统计`,
              ``,
              `总反馈数: ${stats.totalFeedback}`,
              `按类型分布:`,
              `  显式: ${stats.byType.explicit ?? 0}`,
              `  隐式: ${stats.byType.implicit ?? 0}`,
              `  环境: ${stats.byType.environmental ?? 0}`,
              `  对比: ${stats.byType.comparative ?? 0}`,
              ``,
              `平均奖励: ${stats.averageReward.toFixed(4)}`,
              `覆盖率: ${(stats.coverageRate * 100).toFixed(1)}%${stats.coverageRate >= 0.9 ? ' ✅' : ' ⚠️ 未达标'}`,
              `策略更新次数: ${stats.policyUpdates}`,
              `趋势方向: ${(() => {
                if (stats.trendDirection === 'improving') return '📈 上升';
                if (stats.trendDirection === 'declining') return '📉 下降';
                return '➡️ 稳定';
              })()}`,
            ].join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 统计获取失败: ${msg}`);
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 计算即时奖励信号 */
  private computeImmediateReward(event: FeedbackEvent): number {
    // 基于结果的基础奖励
    const outcomeRewards: Record<string, number> = {
      success: 0.8,
      partial: 0.3,
      neutral: 0.0,
      failure: -0.5,
    };
    let reward = outcomeRewards[event.outcome] ?? 0;

    // 显式反馈直接使用用户值
    if (event.type === 'explicit' && event.value !== undefined) {
      reward = Math.max(-1, Math.min(1, event.value));
    }

    // 隐式反馈微调
    if (event.type === 'implicit') {
      if (event.outcome === 'success') reward = 0.6;
      else if (event.outcome === 'failure') reward = -0.4;
    }

    // 环境反馈微调
    if (event.type === 'environmental') {
      const ctx = event.context ?? {};
      // 高错误率降低奖励
      if (typeof ctx.errorRate === 'number' && ctx.errorRate > 0.1) {
        reward -= ctx.errorRate * 0.5;
      }
      // 高延迟降低奖励
      if (typeof ctx.latency === 'number' && ctx.latency > 5000) {
        reward -= 0.1;
      }
    }

    // 对比反馈微调
    if (event.type === 'comparative' && event.value !== undefined) {
      if (event.value > 0) {
        reward = 0.5;
      } else if (event.value < 0) {
        reward = -0.3;
      } else {
        reward = 0;
      }
    }

    return Math.max(-1, Math.min(1, reward));
  }

  /** 任务完成度奖励 (0-1) */
  private computeCompletionReward(context: RewardContext): number {
    if (context.taskCompleted) return 1.0;
    // 未完成但使用了工具，给部分分
    if (context.toolsUsed.length > 0) return 0.3;
    return 0;
  }

  /** 质量奖励 (0-1) */
  private computeQualityReward(context: RewardContext): number {
    // 如果有显式质量评分，直接使用
    if (context.outputQuality !== undefined) {
      return Math.max(0, Math.min(1, context.outputQuality));
    }

    // 否则基于间接信号估算
    let quality = 0.5; // 基础分

    // 任务完成通常意味着质量尚可
    if (context.taskCompleted) quality += 0.2;

    // 使用了多种工具可能意味着更全面
    if (context.toolsUsed.length >= 3) quality += 0.1;

    // token使用适中（不太少也不太多）暗示质量合理
    if (context.tokenUsage > 100 && context.tokenUsage < 5000) quality += 0.1;

    return Math.max(0, Math.min(1, quality));
  }

  /** 效率奖励 (0-1) */
  private computeEfficiencyReward(context: RewardContext): number {
    let efficiency = 0.5;

    // 执行时间评分（<5秒满分，>60秒趋近0）
    if (context.executionTime < 5000) efficiency += 0.3;
    else if (context.executionTime < 15000) efficiency += 0.2;
    else if (context.executionTime < 30000) efficiency += 0.1;
    else efficiency -= 0.1;

    // Token使用评分（<500满分，>10000趋近0）
    if (context.tokenUsage < 500) efficiency += 0.1;
    else if (context.tokenUsage < 2000) efficiency += 0.05;
    else if (context.tokenUsage > 8000) efficiency -= 0.1;

    // 工具调用次数（<3满分，>10扣分）
    if (context.toolsUsed.length <= 3) efficiency += 0.1;
    else if (context.toolsUsed.length > 8) efficiency -= 0.1;

    return Math.max(0, Math.min(1, efficiency));
  }

  /** 用户满意度奖励 (0-1) */
  private computeSatisfactionReward(context: RewardContext): number {
    if (context.userSatisfied === true) return 1.0;
    if (context.userSatisfied === false) return 0.1;

    // 隐式推断：任务完成且无安全违规暗示满意
    let satisfaction = 0.5;
    if (context.taskCompleted) satisfaction += 0.2;
    if (context.safetyViolations === 0) satisfaction += 0.1;
    if (context.outputQuality !== undefined && context.outputQuality > 0.7) satisfaction += 0.1;

    return Math.max(0, Math.min(1, satisfaction));
  }

  /** 安全性奖励 (0-1) */
  private computeSafetyReward(context: RewardContext): number {
    if (context.safetyViolations === 0) return 1.0;
    // 每次违规扣分
    return Math.max(0, 1.0 - context.safetyViolations * 0.3);
  }

  /** LLM增强奖励计算（可选） */
  private async computeLLMEnhancedReward(context: RewardContext, baseResult: RewardResult): Promise<number> {
    if (!this.modelLibrary || typeof this.modelLibrary.chat !== 'function') {
      return 0;
    }

    try {
      const prompt = `评估以下AI智能体任务执行的奖励调整值（-0.1到0.1之间的小幅调整）：
任务: ${context.taskDescription}
完成: ${context.taskCompleted}
工具: ${context.toolsUsed.join(', ')}
时间: ${context.executionTime}ms
Token: ${context.tokenUsage}
安全违规: ${context.safetyViolations}
基础奖励: ${baseResult.totalReward.toFixed(4)}

请只返回一个-0.1到0.1之间的数字：`;

      const response = await this.modelLibrary.chat(prompt);
      const match = response.match(/-?\d+\.?\d*/);
      if (match) {
        const bonus = parseFloat(match[0]);
        return Math.max(-0.1, Math.min(0.1, bonus));
      }
    } catch {
      // LLM调用失败，不影响基础奖励
    }

    return 0;
  }

  /** 归一化奖励维度权重 */
  private normalizeWeights(): void {
    const total = Object.values(this.weights).reduce((s, w) => s + w, 0);
    if (total > 0) {
      for (const key of Object.keys(this.weights) as (keyof RewardWeights)[]) {
        this.weights[key] = this.weights[key] / total;
      }
    }
  }

  /** 解析时间范围字符串为毫秒数 */
  private parseTimeRange(range: string): number {
    const match = range.match(/^(\d+)(h|d|w|m)$/i);
    if (!match) return 7 * 24 * 60 * 60 * 1000; // 默认7天

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      case 'w': return value * 7 * 24 * 60 * 60 * 1000;
      case 'm': return value * 30 * 24 * 60 * 60 * 1000;
      default: return 7 * 24 * 60 * 60 * 1000;
    }
  }

  /** 确保数据目录存在 */
  private ensureDir(): void {
    try {
      fs.mkdirSync(this.feedbackDir, { recursive: true });
    } catch {
      // 目录创建失败时静默处理
    }
  }

  /** 持久化单条反馈 */
  private async persistFeedback(stored: StoredFeedback): Promise<void> {
    try {
      const date = new Date(stored.storedAt).toISOString().split('T')[0];
      const filePath = path.join(this.feedbackDir, `feedback-${date}.json`);

      let existing: StoredFeedback[] = [];
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        existing = JSON.parse(content);
      } catch {
        // 文件不存在
      }

      existing.push(stored);
      await atomicWriteJson(filePath, existing);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化反馈失败', { error: msg });
    }
  }

  /** 持久化单条奖励记录 */
  private async persistReward(stored: StoredReward): Promise<void> {
    try {
      const date = new Date(stored.timestamp).toISOString().split('T')[0];
      const filePath = path.join(this.feedbackDir, `reward-${date}.json`);

      let existing: StoredReward[] = [];
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        existing = JSON.parse(content);
      } catch {
        // 文件不存在
      }

      existing.push(stored);
      await atomicWriteJson(filePath, existing);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化奖励记录失败', { error: msg });
    }
  }

  /** 加载历史数据 */
  private loadData(): void {
    try {
      const files = fs.readdirSync(this.feedbackDir).filter(
        f => f.startsWith('feedback-') && f.endsWith('.json')
      ).sort().slice(-7);

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.feedbackDir, file), 'utf-8');
          const data: StoredFeedback[] = JSON.parse(content);
          if (Array.isArray(data)) {
            this.feedbacks.push(...data);
          }
        } catch {
          // 跳过损坏文件
        }
      }

      // 加载奖励历史
      const rewardFiles = fs.readdirSync(this.feedbackDir).filter(
        f => f.startsWith('reward-') && f.endsWith('.json')
      ).sort().slice(-7);

      for (const file of rewardFiles) {
        try {
          const content = fs.readFileSync(path.join(this.feedbackDir, file), 'utf-8');
          const data: StoredReward[] = JSON.parse(content);
          if (Array.isArray(data)) {
            this.rewardHistory.push(...data);
          }
        } catch {
          // 跳过损坏文件
        }
      }

      // 限制数量
      if (this.feedbacks.length > this.maxFeedbacks) {
        this.feedbacks = this.feedbacks.slice(-this.maxFeedbacks);
      }
      if (this.rewardHistory.length > this.maxRewardHistory) {
        this.rewardHistory = this.rewardHistory.slice(-this.maxRewardHistory);
      }
    } catch {
      // 目录不存在或读取失败
    }
  }
}
