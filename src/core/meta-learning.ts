/**
 * 元学习系统 — MetaLearningSystem
 *
 * Agent 学会如何更好地学习。"学会学习"是智能体的核心能力。
 *
 * 核心能力：
 * 1. 学习策略优化 — 自动调整学习率、探索率等超参数
 * 2. 跨任务知识迁移 — 将学到的知识迁移到新任务
 * 3. 学习进度监控 — 评估学习效率，识别学习瓶颈
 * 4. 自适应学习率 — 根据学习进度动态调整
 * 5. 经验蒸馏 — 从多次学习经验中提取通用规律
 *
 * 设计理念：
 * - 元学习 = 学习如何学习
 * - 通过监控学习过程，发现什么学习策略最有效
 * - 知识迁移让 Agent 在新任务上学习更快
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 学习任务 */
export interface LearningTask {
  /** 任务 ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务类型 */
  type: string;
  /** 任务描述 */
  description: string;
  /** 创建时间 */
  createdAt: number;
  /** 初始难度评估（0-1） */
  initialDifficulty: number;
}

/** 学习会话 */
export interface LearningSession {
  /** 会话 ID */
  id: string;
  /** 任务 ID */
  taskId: string;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 */
  endedAt?: number;
  /** 学习策略 */
  strategy: LearningStrategy;
  /** 超参数 */
  hyperparams: Hyperparameters;
  /** 学习进度记录 */
  progressLog: Array<{
    timestamp: number;
    step: number;
    metric: string;
    value: number;
  }>;
  /** 最终结果 */
  result?: {
    success: boolean;
    finalMetric: number;
    learningSpeed: number; // 每步提升量
    totalSteps: number;
  };
}

/** 学习策略 */
export type LearningStrategy =
  | 'incremental'    // 增量学习
  | 'batch'          // 批量学习
  | 'transfer'       // 迁移学习
  | 'curriculum'     // 课程学习
  | 'active'         // 主动学习
  | 'reinforcement'; // 强化学习

/** 超参数 */
export interface Hyperparameters {
  learningRate: number;
  batchSize: number;
  explorationRate: number;
  regularization: number;
  iterations: number;
}

/** 知识迁移记录 */
export interface TransferRecord {
  /** 源任务 ID */
  sourceTaskId: string;
  /** 目标任务 ID */
  targetTaskId: string;
  /** 迁移的知识 */
  knowledge: string;
  /** 迁移效果（0-1，提升比例） */
  effectiveness: number;
  /** 迁移时间 */
  transferredAt: number;
}

/** 学习经验总结 */
export interface LearningExperience {
  /** 经验 ID */
  id: string;
  /** 任务类型 */
  taskType: string;
  /** 有效的学习策略 */
  effectiveStrategies: LearningStrategy[];
  /** 最佳超参数 */
  bestHyperparams: Hyperparameters;
  /** 学习速度 */
  learningSpeed: number;
  /** 成功率 */
  successRate: number;
  /** 总结的规律 */
  lessons: string[];
  /** 创建时间 */
  createdAt: number;
}

// ============ 元学习系统 ============

export class MetaLearningSystem {
  /** 工作目录 */
  private workDir: string;

  /** 学习任务 */
  private tasks: Map<string, LearningTask> = new Map();

  /** 学习会话 */
  private sessions: Map<string, LearningSession> = new Map();

  /** 当前活跃会话 */
  private activeSession: LearningSession | null = null;

  /** 知识迁移记录 */
  private transferRecords: TransferRecord[] = [];

  /** 学习经验库 */
  private experiences: Map<string, LearningExperience> = new Map();

  /** 全局最佳超参数（按任务类型） */
  private bestHyperparams: Map<string, Hyperparameters> = new Map();

  /** 学习策略效果统计 */
  private strategyEffectiveness: Map<LearningStrategy, { totalUses: number; totalSuccess: number; avgSpeed: number }> = new Map();

  private log = logger.child({ module: 'MetaLearningSystem' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('meta-learning');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.loadData();
  }

  // ========== 任务管理 ==========

  /**
   * 注册学习任务
   */
  registerTask(name: string, type: string, description: string, initialDifficulty: number = 0.5): LearningTask {
    const task: LearningTask = {
      id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      type,
      description,
      createdAt: Date.now(),
      initialDifficulty,
    };
    this.tasks.set(task.id, task);
    this.log.info('学习任务已注册', { taskId: task.id, name, type });
    return task;
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): LearningTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * 获取所有任务
   */
  getTasks(): LearningTask[] {
    return Array.from(this.tasks.values());
  }

  // ========== 学习会话 ==========

  /**
   * 开始学习会话
   */
  startSession(taskId: string, strategy?: LearningStrategy): LearningSession {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    // 推荐最佳策略和超参数
    const recommendedStrategy = strategy ?? this.recommendStrategy(task.type);
    const recommendedHyperparams = this.recommendHyperparams(task.type);

    const session: LearningSession = {
      id: `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      startedAt: Date.now(),
      strategy: recommendedStrategy,
      hyperparams: recommendedHyperparams,
      progressLog: [],
    };

    this.sessions.set(session.id, session);
    this.activeSession = session;

    this.log.info('学习会话已开始', {
      sessionId: session.id,
      taskId,
      strategy: recommendedStrategy,
      learningRate: recommendedHyperparams.learningRate,
    });

    EventBus.getInstance().emitSync('meta-learning.session.started', {
      sessionId: session.id,
      taskId,
      strategy: recommendedStrategy,
    });

    return session;
  }

  /**
   * 记录学习进度
   */
  recordProgress(metric: string, value: number): void {
    if (!this.activeSession) {
      this.log.warn('无活跃学习会话');
      return;
    }

    this.activeSession.progressLog.push({
      timestamp: Date.now(),
      step: this.activeSession.progressLog.length,
      metric,
      value,
    });

    // 自适应调整超参数
    this.adaptHyperparameters();
  }

  /**
   * 结束学习会话
   */
  endSession(success: boolean, finalMetric: number): LearningExperience | null {
    if (!this.activeSession) return null;

    const session = this.activeSession;
    session.endedAt = Date.now();
    session.result = {
      success,
      finalMetric,
      learningSpeed: this.calculateLearningSpeed(session),
      totalSteps: session.progressLog.length,
    };

    // 更新策略效果统计
    this.updateStrategyEffectiveness(session.strategy, success, session.result.learningSpeed);

    // 提取学习经验
    const experience = this.extractExperience(session);

    // 更新最佳超参数
    if (success) {
      this.updateBestHyperparams(session);
    }

    this.log.info('学习会话已结束', {
      sessionId: session.id,
      success,
      learningSpeed: session.result.learningSpeed,
      totalSteps: session.result.totalSteps,
    });

    this.activeSession = null;
    this.saveData();

    return experience;
  }

  // ========== 自适应学习 ==========

  /**
   * 推荐学习策略
   */
  recommendStrategy(taskType: string): LearningStrategy {
    // 查找该任务类型的历史经验
    const relevantExperiences = Array.from(this.experiences.values())
      .filter(exp => exp.taskType === taskType);

    if (relevantExperiences.length === 0) {
      // 无历史经验，使用默认策略
      return 'incremental';
    }

    // 选择成功率最高的策略
    const strategyStats: Map<LearningStrategy, { success: number; total: number }> = new Map();
    for (const exp of relevantExperiences) {
      for (const strategy of exp.effectiveStrategies) {
        if (!strategyStats.has(strategy)) {
          strategyStats.set(strategy, { success: 0, total: 0 });
        }
        const stats = strategyStats.get(strategy)!;
        stats.success += exp.successRate;
        stats.total += 1;
      }
    }

    let bestStrategy: LearningStrategy = 'incremental';
    let bestScore = 0;
    for (const [strategy, stats] of strategyStats) {
      const score = stats.success / stats.total;
      if (score > bestScore) {
        bestScore = score;
        bestStrategy = strategy;
      }
    }

    return bestStrategy;
  }

  /**
   * 推荐超参数
   */
  recommendHyperparams(taskType: string): Hyperparameters {
    const best = this.bestHyperparams.get(taskType);
    if (best) return { ...best };

    // 默认超参数
    return {
      learningRate: 0.01,
      batchSize: 32,
      explorationRate: 0.1,
      regularization: 0.001,
      iterations: 100,
    };
  }

  /**
   * 自适应调整超参数
   *
   * 根据学习进度动态调整：
   * - 学习停滞 → 增大学习率或探索率
   * - 学习震荡 → 减小学习率
   * - 学习顺利 → 保持当前参数
   */
  private adaptHyperparameters(): void {
    if (!this.activeSession || this.activeSession.progressLog.length < 10) return;

    const recent = this.activeSession.progressLog.slice(-10);
    const values = recent.map(p => p.value);

    // 计算变化趋势
    const firstVal = values[0];
    const lastVal = values[values.length - 1];
    const improvement = lastVal - firstVal;

    // 计算方差（震荡程度）
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    const hp = this.activeSession.hyperparams;

    if (Math.abs(improvement) < 0.001 && stdDev < 0.01) {
      // 学习停滞：增大学习率和探索率
      hp.learningRate = Math.min(0.5, hp.learningRate * 1.2);
      hp.explorationRate = Math.min(0.5, hp.explorationRate * 1.1);
      this.log.debug('学习停滞，增大学习率', { learningRate: hp.learningRate });
    } else if (stdDev > 0.1) {
      // 学习震荡：减小学习率
      hp.learningRate = Math.max(0.0001, hp.learningRate * 0.8);
      this.log.debug('学习震荡，减小学习率', { learningRate: hp.learningRate });
    }
  }

  // ========== 知识迁移 ==========

  /**
   * 迁移知识到新任务
   */
  transferKnowledge(sourceTaskId: string, targetTaskId: string, knowledge: string): TransferRecord {
    const record: TransferRecord = {
      sourceTaskId,
      targetTaskId,
      knowledge,
      effectiveness: 0, // 待评估
      transferredAt: Date.now(),
    };

    this.transferRecords.push(record);

    this.log.info('知识已迁移', {
      sourceTaskId,
      targetTaskId,
      knowledge: knowledge.substring(0, 50),
    });

    EventBus.getInstance().emitSync('meta-learning.transfer.applied', record);
    return record;
  }

  /**
   * 评估迁移效果
   */
  evaluateTransfer(record: TransferRecord, effectiveness: number): void {
    record.effectiveness = effectiveness;
    this.log.info('迁移效果已评估', { effectiveness });
  }

  /**
   * 获取迁移记录
   */
  getTransferRecords(): TransferRecord[] {
    return [...this.transferRecords];
  }

  // ========== 经验提取 ==========

  /**
   * 从学习会话中提取经验
   */
  private extractExperience(session: LearningSession): LearningExperience {
    const task = this.tasks.get(session.taskId);

    // 分析有效策略
    const effectiveStrategies: LearningStrategy[] = [session.strategy];
    if (session.result?.success) {
      // 如果成功，记录策略为有效
    }

    // 提取经验教训
    const lessons: string[] = [];
    if (session.result) {
      if (session.result.learningSpeed > 0.01) {
        lessons.push(`${session.strategy} 策略在此类任务上学习速度较快`);
      } else {
        lessons.push(`${session.strategy} 策略在此类任务上学习速度较慢，建议尝试其他策略`);
      }

      if (session.hyperparams.learningRate > 0.1 && session.result.success) {
        lessons.push(`学习率 ${session.hyperparams.learningRate} 适合此类任务`);
      }

      if (session.progressLog.length > 100) {
        lessons.push('此任务需要较多学习步骤，考虑使用课程学习分解任务');
      }
    }

    const experience: LearningExperience = {
      id: `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      taskType: task?.type ?? 'unknown',
      effectiveStrategies,
      bestHyperparams: { ...session.hyperparams },
      learningSpeed: session.result?.learningSpeed ?? 0,
      successRate: session.result?.success ? 1 : 0,
      lessons,
      createdAt: Date.now(),
    };

    this.experiences.set(experience.id, experience);

    this.log.info('学习经验已提取', {
      experienceId: experience.id,
      taskType: experience.taskType,
      lessons: experience.lessons.length,
    });

    return experience;
  }

  /**
   * 获取所有学习经验
   */
  getExperiences(): LearningExperience[] {
    return Array.from(this.experiences.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ========== 辅助方法 ==========

  /**
   * 计算学习速度
   */
  private calculateLearningSpeed(session: LearningSession): number {
    if (session.progressLog.length < 2) return 0;

    const first = session.progressLog[0].value;
    const last = session.progressLog[session.progressLog.length - 1].value;
    const steps = session.progressLog.length;

    return (last - first) / steps;
  }

  /**
   * 更新策略效果统计
   */
  private updateStrategyEffectiveness(strategy: LearningStrategy, success: boolean, speed: number): void {
    if (!this.strategyEffectiveness.has(strategy)) {
      this.strategyEffectiveness.set(strategy, { totalUses: 0, totalSuccess: 0, avgSpeed: 0 });
    }
    const stats = this.strategyEffectiveness.get(strategy)!;
    stats.totalUses++;
    if (success) stats.totalSuccess++;
    stats.avgSpeed = (stats.avgSpeed * (stats.totalUses - 1) + speed) / stats.totalUses;
  }

  /**
   * 更新最佳超参数
   */
  private updateBestHyperparams(session: LearningSession): void {
    const task = this.tasks.get(session.taskId);
    if (!task) return;

    const current = this.bestHyperparams.get(task.type);
    if (!current || session.result!.learningSpeed > 0) {
      // 如果没有当前最佳，或者这次学习速度为正，则更新
      this.bestHyperparams.set(task.type, { ...session.hyperparams });
    }
  }

  /**
   * 获取学习统计
   */
  getStats(): {
    totalTasks: number;
    totalSessions: number;
    totalExperiences: number;
    totalTransfers: number;
    strategyStats: Array<{ strategy: string; uses: number; successRate: number; avgSpeed: number }>;
  } {
    const strategyStats = Array.from(this.strategyEffectiveness.entries()).map(([strategy, stats]) => ({
      strategy,
      uses: stats.totalUses,
      successRate: stats.totalUses > 0 ? stats.totalSuccess / stats.totalUses : 0,
      avgSpeed: stats.avgSpeed,
    }));

    return {
      totalTasks: this.tasks.size,
      totalSessions: this.sessions.size,
      totalExperiences: this.experiences.size,
      totalTransfers: this.transferRecords.length,
      strategyStats,
    };
  }

  // ========== 持久化 ==========

  /** 保存数据 */
  saveData(): void {
    try {
      const data = {
        tasks: Array.from(this.tasks.entries()),
        sessions: Array.from(this.sessions.entries()),
        transferRecords: this.transferRecords,
        experiences: Array.from(this.experiences.entries()),
        bestHyperparams: Array.from(this.bestHyperparams.entries()),
        strategyEffectiveness: Array.from(this.strategyEffectiveness.entries()),
      };
      const dataPath = path.join(this.workDir, 'meta-learning-data.json');
      atomicWriteJsonSync(dataPath, data);
    } catch (err: unknown) {
      this.log.error('保存元学习数据失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** 加载数据 */
  private loadData(): void {
    try {
      const dataPath = path.join(this.workDir, 'meta-learning-data.json');
      if (!fs.existsSync(dataPath)) return;

      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

      for (const [id, task] of data.tasks ?? []) {
        this.tasks.set(id, task);
      }
      for (const [id, session] of data.sessions ?? []) {
        this.sessions.set(id, session);
      }
      this.transferRecords = data.transferRecords ?? [];
      for (const [id, exp] of data.experiences ?? []) {
        this.experiences.set(id, exp);
      }
      for (const [type, hp] of data.bestHyperparams ?? []) {
        this.bestHyperparams.set(type, hp);
      }
      for (const [strategy, stats] of data.strategyEffectiveness ?? []) {
        this.strategyEffectiveness.set(strategy, stats);
      }

      this.log.info('元学习数据已加载', {
        tasks: this.tasks.size,
        sessions: this.sessions.size,
        experiences: this.experiences.size,
      });
    } catch (err: unknown) {
      this.log.error('加载元学习数据失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }
}
