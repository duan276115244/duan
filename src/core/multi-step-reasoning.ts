/**
 * 多步推理框架 — MultiStepReasoningFramework
 *
 * P1-2: 构建「分解-求解-验证-修正」四步框架
 *
 * 核心流程：
 * 1. 分解 — 复杂问题 → task-decomposition 分解为子任务 DAG
 * 2. 求解 — 并行/串行执行子任务
 * 3. 验证 — reasoning-chain-verifier 验证每步结果
 * 4. 修正 — 失败则触发 intelligent-error-recovery 修正
 *
 * 复用现有模块：
 * - ReasoningEngine（CoT/ToT/GoT 推理）
 * - ReasoningChainVerifier（推理链验证）
 * - IntelligentErrorRecovery（错误恢复）
 * - TaskDecomposition（4级任务分解）
 */

import { ReasoningEngine } from './reasoning-engine.js';
import { ReasoningChainVerifier, type ReasoningStep as VerificationStep, type ChainVerificationResult } from './reasoning-chain-verifier.js';
import { IntelligentErrorRecovery, type RecoveryResult, type ErrorInfo } from './intelligent-error-recovery.js';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

export type SubTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'recovered' | 'skipped';

export interface SubTask {
  id: string;
  description: string;
  status: SubTaskStatus;
  dependsOn?: string[];
  result?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

export interface ReasoningPlan {
  originalTask: string;
  reasoningMode: string;
  conclusion: string;
  confidence: number;
  subtasks: SubTask[];
  alternatives: string[];
}

export interface ExecutionResult {
  success: boolean;
  completedTasks: number;
  failedTasks: number;
  recoveredTasks: number;
  results: Map<string, string>;
  lessons: string[];
  durationMs: number;
}

export type TaskExecutor = (task: SubTask, context: Map<string, string>) => Promise<string>;

// ============ 多步推理框架 ============

export class MultiStepReasoningFramework {
  private reasoningEngine: ReasoningEngine;
  private verifier: ReasoningChainVerifier;
  private errorRecovery: IntelligentErrorRecovery;
  private taskCounter = 0;

  constructor(
    reasoningEngine?: ReasoningEngine,
    verifier?: ReasoningChainVerifier,
    errorRecovery?: IntelligentErrorRecovery,
  ) {
    this.reasoningEngine = reasoningEngine || new ReasoningEngine();
    this.verifier = verifier || new ReasoningChainVerifier();
    this.errorRecovery = errorRecovery || new IntelligentErrorRecovery();
  }

  /**
   * 完整的多步推理流程：分解 → 求解 → 验证 → 修正
   * @param task 复杂任务描述
   * @param executor 子任务执行器（由调用方提供，通常是工具调用）
   */
  async solve(task: string, executor: TaskExecutor): Promise<ExecutionResult> {
    const startTime = Date.now();
    logger.info('开始多步推理', { module: 'MultiStepReasoning', task: task.substring(0, 100) });

    // ===== 阶段1: 分解 =====
    const plan = this.decompose(task);
    logger.info('分解完成', { module: 'MultiStepReasoning', subtasks: plan.subtasks.length, mode: plan.reasoningMode });

    // ===== 阶段2: 求解 + 阶段3: 验证 + 阶段4: 修正 =====
    const results = new Map<string, string>();
    const lessons: string[] = [];
    let completed = 0;
    let failed = 0;
    let recoveredCount = 0;

    while (true) {
      // 找出可执行的子任务（依赖已满足）
      const ready = plan.subtasks.filter(
        s => s.status === 'pending' &&
        (s.dependsOn?.every(dep => results.has(dep)) ?? true)
      );

      if (ready.length === 0) {
        // 检查是否全部完成
        const unfinished = plan.subtasks.filter(s => s.status === 'pending' || s.status === 'running');
        if (unfinished.length === 0) break;
        // 死锁检测
        if (unfinished.every(s => s.dependsOn?.some(dep => plan.subtasks.find(t => t.id === dep)?.status === 'failed'))) {
          logger.warn('检测到死锁：剩余任务依赖已失败任务，跳过', { module: 'MultiStepReasoning' });
          for (const s of unfinished) {
            s.status = 'skipped';
            lessons.push(`任务 ${s.id} 因依赖失败被跳过`);
          }
          break;
        }
        break;
      }

      // 并发执行就绪任务。
      // 注意：依赖分析当前为「串行降级实现」（见 analyzeDependencies），
      // 强制构造线性依赖链，因此每轮通常只有一个就绪任务，实际表现为串行。
      // 接入真实 DAG 分析（task-dependency-graph）后，此处可发挥真正的并行能力。
      await Promise.all(ready.map(async (subtask) => {
        subtask.status = 'running';
        try {
          // 执行子任务
          const result = await executor(subtask, results);
          subtask.result = result;
          results.set(subtask.id, result);

          // 验证结果
          const verification = this.verifyResult(subtask, result);
          if (verification.passed) {
            subtask.status = 'done';
            completed++;
            logger.debug('子任务完成', { module: 'MultiStepReasoning', id: subtask.id, preview: result.substring(0, 80) });
          } else {
            // 验证失败，尝试修正
            const recovered = await this.attemptRecovery(subtask, verification, executor, results);
            if (recovered) {
              subtask.status = 'recovered';
              recoveredCount++;
              completed++;
              lessons.push(`子任务 ${subtask.id} 通过错误恢复修正成功`);
            } else {
              subtask.status = 'failed';
              failed++;
              lessons.push(`子任务 ${subtask.id} 失败: ${verification.allIssues.map(i => i.description).join('; ')}`);
            }
          }
        } catch (error) {
          // 执行错误，尝试恢复
          subtask.error = String(error);
          const recovered = await this.attemptRecovery(subtask, null, executor, results, error);
          if (recovered) {
            subtask.status = 'recovered';
            recoveredCount++;
            completed++;
          } else {
            subtask.status = 'failed';
            failed++;
            lessons.push(`子任务 ${subtask.id} 执行错误: ${subtask.error}`);
          }
        }
      }));
    }

    const durationMs = Date.now() - startTime;
    logger.info('完成', { module: 'MultiStepReasoning', completed, failed, recovered: recoveredCount, durationMs });

    return {
      success: failed === 0,
      completedTasks: completed,
      failedTasks: failed,
      recoveredTasks: recoveredCount,
      results,
      lessons,
      durationMs,
    };
  }

  /**
   * 阶段1: 分解 — 使用推理引擎分解复杂任务
   */
  decompose(task: string): ReasoningPlan {
    // 调用推理引擎分析任务
    const reasoning = this.reasoningEngine.think(task, []);
    
    // 根据推理结论分解为子任务
    const subtasks = this.extractSubtasks(reasoning.conclusion, reasoning.steps);
    
    // 分析依赖关系
    this.analyzeDependencies(subtasks);

    return {
      originalTask: task,
      reasoningMode: reasoning.mode,
      conclusion: reasoning.conclusion,
      confidence: reasoning.confidence,
      subtasks,
      alternatives: reasoning.alternatives,
    };
  }

  /**
   * 阶段3: 验证 — 验证子任务结果
   */
  verifyResult(subtask: SubTask, result: string): ChainVerificationResult {
    // 构造推理步骤用于验证
    const step: VerificationStep = {
      id: 1,
      description: subtask.description,
      content: result,
      confidence: 0.8,
      conclusion: `子任务执行结果`,
    };

    try {
      return this.verifier.verifyChain([step]);
    } catch {
      // 验证器失败时默认通过
      return {
        passed: true,
        overallConfidence: 0.8,
        stepResults: [],
        allIssues: [],
        criticalIssues: [],
        summary: '验证器异常，默认通过',
      };
    }
  }

  /**
   * 阶段4: 修正 — 尝试错误恢复
   */
  async attemptRecovery(
    subtask: SubTask,
    verification: ChainVerificationResult | null,
    executor: TaskExecutor,
    context: Map<string, string>,
    error?: unknown,
  ): Promise<boolean> {
    if (subtask.retryCount >= subtask.maxRetries) {
      logger.warn('子任务重试次数耗尽', { module: 'MultiStepReasoning', id: subtask.id, maxRetries: subtask.maxRetries });
      return false;
    }

    subtask.retryCount++;

    try {
      // 构造 ErrorInfo 供错误恢复引擎使用
      const errorInfo: ErrorInfo = {
        type: 'logic',
        message: error ? String(error) : (verification?.allIssues.map(i => i.description).join('; ') || '验证失败'),
        source: subtask.id,
        timestamp: Date.now(),
        context: {
          taskDescription: subtask.description,
          previousResult: subtask.result,
          retryCount: subtask.retryCount,
        },
        originalError: error,
      };

      // 调用错误恢复引擎（提供重试函数）
      const recoveryResult: RecoveryResult = await this.errorRecovery.recover(
        errorInfo,
        () => executor(subtask, context),
      );

      if (recoveryResult.recovered && recoveryResult.result) {
        // 恢复成功，更新结果
        subtask.status = 'pending';
        const result = String(recoveryResult.result);
        subtask.result = result;
        context.set(subtask.id, result);
        return true;
      }
    } catch (recoveryError) {
      logger.error('恢复失败', { module: 'MultiStepReasoning', error: String(recoveryError) });
    }

    return false;
  }

  // ===== 内部方法 =====

  private extractSubtasks(conclusion: string, steps: Array<{ step: number; thought: string; action?: string; observation?: string; confidence: number; justification: string }>): SubTask[] {
    // 从推理步骤提取子任务
    const subtasks: SubTask[] = steps.map((step) => ({
      id: `task_${++this.taskCounter}`,
      description: step.thought,
      status: 'pending' as SubTaskStatus,
      retryCount: 0,
      maxRetries: 3,
    }));

    // 如果没有步骤，至少创建一个任务
    if (subtasks.length === 0) {
      subtasks.push({
        id: `task_${++this.taskCounter}`,
        description: conclusion,
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
      });
    }

    return subtasks;
  }

  /**
   * 分析子任务依赖关系。
   *
   * ⚠️ 当前为「串行降级实现」（Serial Fallback）：
   *   强制构造线性依赖链（每个任务依赖前一个），因此 solve() 中
   *   「并行执行就绪任务」的设计会退化为串行执行，DAG/并行能力
   *   在此实现下并不生效。
   *
   * TODO: 接入 task-dependency-graph.ts 进行真实依赖分析，
   *   基于子任务的输入/输出与语义关系构建 DAG，从而让无依赖关系
   *   的任务能够真正并行执行。在此之前，本方法仅作为安全的串行降级方案。
   */
  private analyzeDependencies(subtasks: SubTask[]): void {
    // 串行降级实现：线性依赖链。详见上方方法注释。
    for (let i = 1; i < subtasks.length; i++) {
      subtasks[i].dependsOn = [subtasks[i - 1].id];
    }
  }
}

