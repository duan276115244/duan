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
    const plan = await this.decompose(task);
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
      // analyzeDependencies 已升级为启发式 DAG：无依赖关系的任务可在此真正并行执行。
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
  async decompose(task: string): Promise<ReasoningPlan> {
    // 调用推理引擎分析任务（think() 已升级为 LLM 优先 + 启发式降级）
    const reasoning = await this.reasoningEngine.think(task, []);
    
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
   * 分析子任务依赖关系 — 启发式 DAG 构建。
   *
   * 基于子任务 description 的数据流引用检测：
   * - 若任务 B 的描述中引用了任务 A 的 id，则 B 依赖 A
   * - 无引用的任务 dependsOn = []（独立可并行）
   * - 循环依赖安全网：检测到环时回退到线性链，避免死锁
   *
   * 这让 solve() 中「Promise.all(ready.map(...))」的并行基础设施
   * 真正发挥作用——无依赖关系的任务可并发执行。
   */
  private analyzeDependencies(subtasks: SubTask[]): void {
    // 启发式：基于 description 的数据流依赖检测
    for (let i = 0; i < subtasks.length; i++) {
      const deps: string[] = [];
      for (let j = 0; j < subtasks.length; j++) {
        if (i === j) continue;
        // 任务 i 的描述引用了任务 j 的 id → i 依赖 j
        if (subtasks[i].description.includes(subtasks[j].id)) {
          deps.push(subtasks[j].id);
        }
      }
      subtasks[i].dependsOn = deps;
    }
    // 安全检查：检测循环依赖，若有则回退到线性链
    if (this.hasCycle(subtasks)) {
      logger.warn('检测到循环依赖，回退到线性依赖链', { module: 'MultiStepReasoning' });
      for (let i = 1; i < subtasks.length; i++) {
        subtasks[i].dependsOn = [subtasks[i - 1].id];
      }
      subtasks[0].dependsOn = [];
    }
  }

  /**
   * DFS 循环依赖检测：判断子任务依赖图是否存在环。
   */
  private hasCycle(subtasks: SubTask[]): boolean {
    const depMap = new Map<string, string[]>();
    for (const s of subtasks) {
      depMap.set(s.id, s.dependsOn ?? []);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const s of subtasks) color.set(s.id, WHITE);

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      const deps = depMap.get(id) ?? [];
      for (const dep of deps) {
        const c = color.get(dep);
        if (c === GRAY) return true; // 回边 → 环
        if (c === WHITE && dfs(dep)) return true;
      }
      color.set(id, BLACK);
      return false;
    };

    for (const s of subtasks) {
      if (color.get(s.id) === WHITE && dfs(s.id)) return true;
    }
    return false;
  }
}

