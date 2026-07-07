/**
 * 容错执行引擎 — FaultTolerantExecutor
 *
 * 核心能力：
 * 1. 并行执行：自动分析步骤依赖，并行执行独立步骤
 * 2. 自动回滚：关键步骤失败时，按逆序回滚已完成步骤
 * 3. 错误恢复：指数退避重试、超时延长、网络重试、权限跳过
 * 4. 异常检测：识别错误模式、意外模式、安全模式
 * 5. 持久化：执行历史保存至 .duan/execution/history.json
 *
 * 设计原则：
 * - 关键步骤失败 → 回滚所有已完成步骤
 * - 非关键步骤失败 → 跳过并继续
 * - 回滚操作是尽力而为（失败不阻断其他回滚）
 * - 检查点在每个成功步骤后保存
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { CheckpointManager } from './checkpoint-rewind.js';
import { resilienceChain } from './circuit-breaker.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface ExecutionPlan {
  id: string;
  steps: ExecutionStep[];
  rollbackPlan: RollbackAction[];
  timeout: number;
  maxRetries: number;
  parallelGroups: number[][];
}

export interface ExecutionStep {
  id: string;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  description: string;
  timeout: number;
  retries: number;
  maxRetries: number;
  rollback?: RollbackAction;
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  result?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
  critical?: boolean;
}

export interface RollbackAction {
  stepId: string;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  description: string;
}

export interface ExecutionResult {
  planId: string;
  status: 'completed' | 'partial' | 'failed' | 'rolled_back';
  completedSteps: number;
  totalSteps: number;
  results: Map<string, string>;
  errors: Map<string, string>;
  duration: number;
  rolledBack: boolean;
}

export interface ExecutionCheckpoint {
  stepId: string;
  timestamp: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  canRollback: boolean;
}

export interface AnomalyDetection {
  isAnomaly: boolean;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface ExecutionStats {
  totalPlans: number;
  completedPlans: number;
  failedPlans: number;
  rolledBackPlans: number;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  retriedSteps: number;
  avgPlanDuration: number;
  avgStepDuration: number;
  rollbackCount: number;
  anomalyCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolExecutorFn = (name: string, args: any) => Promise<string>;

// ============ 容错执行引擎 ============

export class FaultTolerantExecutor {
  private log = logger.child({ module: 'FaultTolerantExecutor' });
  private eventBus = EventBus.getInstance();
  private checkpointManager: CheckpointManager;
  private historyDir: string;

  private stats: ExecutionStats = {
    totalPlans: 0,
    completedPlans: 0,
    failedPlans: 0,
    rolledBackPlans: 0,
    totalSteps: 0,
    completedSteps: 0,
    failedSteps: 0,
    retriedSteps: 0,
    avgPlanDuration: 0,
    avgStepDuration: 0,
    rollbackCount: 0,
    anomalyCount: 0,
  };

  private planDurations: number[] = [];
  private stepDurations: number[] = [];

  constructor(historyDir?: string) {
    this.historyDir = historyDir || duanPath('execution');
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.checkpointManager = new CheckpointManager(
      path.join(this.historyDir, 'checkpoints'),
    );
    this.loadHistory();
  }

  // ============ 核心方法 ============

  /**
   * 执行计划 — 完整容错执行
   * - 按依赖和并行组执行步骤
   * - 失败时指数退避重试
   * - 关键步骤失败则回滚
   * - 非关键步骤失败则跳过
   * - 每步成功后保存检查点
   */
  async executePlan(
    plan: ExecutionPlan,
    toolExecutor: ToolExecutorFn,
  ): Promise<ExecutionResult> {
    const planStart = Date.now();
    this.stats.totalPlans++;

    this.log.info('plan execution started', {
      planId: plan.id,
      steps: plan.steps.length,
      parallelGroups: plan.parallelGroups.length,
    });

    this.eventBus.emitSync('fault-tolerant.plan.started', {
      planId: plan.id,
      stepCount: plan.steps.length,
    });

    const results = new Map<string, string>();
    const errors = new Map<string, string>();
    const checkpoints: ExecutionCheckpoint[] = [];
    let completedSteps = 0;
    let _rolledBack = false;

    // 重置步骤状态
    for (const step of plan.steps) {
      step.status = 'pending';
      step.retries = 0;
      step.result = undefined;
      step.error = undefined;
      step.startTime = undefined;
      step.endTime = undefined;
    }

    try {
      // 按并行组顺序执行
      for (let groupIdx = 0; groupIdx < plan.parallelGroups.length; groupIdx++) {
        const group = plan.parallelGroups[groupIdx];

        // 检查该组步骤的依赖是否都已满足
        const readySteps = group
          .map(idx => plan.steps[idx])
          .filter(step => {
            if (step.status === 'completed') return false;
            if (step.dependsOn.length === 0) return true;
            return step.dependsOn.every(depId => {
              const dep = plan.steps.find(s => s.id === depId);
              return dep && dep.status === 'completed';
            });
          });

        if (readySteps.length === 0) {
          this.log.warn('no ready steps in parallel group', {
            planId: plan.id,
            groupIdx,
          });
          continue;
        }

        // 并行执行该组步骤
        const groupResults = await this.executeParallel(
          readySteps,
          toolExecutor,
          3,
        );

        // 处理每个步骤结果
        for (const step of readySteps) {
          this.stats.totalSteps++;
          const stepResult = groupResults.get(step.id);

          if (step.status === 'completed' && stepResult !== undefined) {
            results.set(step.id, stepResult);
            completedSteps++;
            this.stats.completedSteps++;

            // 保存检查点
            const checkpoint: ExecutionCheckpoint = {
              stepId: step.id,
              timestamp: Date.now(),
              state: { result: stepResult, step: step.description },
              canRollback: !!step.rollback,
            };
            checkpoints.push(checkpoint);

            // 异常检测
            const anomaly = this.detectAnomaly(stepResult);
            if (anomaly.isAnomaly) {
              this.stats.anomalyCount++;
              this.log.warn('anomaly detected in step result', {
                planId: plan.id,
                stepId: step.id,
                anomalyType: anomaly.type,
                severity: anomaly.severity,
              });

              this.eventBus.emitSync('fault-tolerant.anomaly.detected', {
                planId: plan.id,
                stepId: step.id,
                anomaly,
              });

              // 关键异常直接回滚
              if (anomaly.severity === 'critical') {
                this.log.error('critical anomaly, triggering rollback', {
                  planId: plan.id,
                  stepId: step.id,
                });
                await this.rollbackWithPlan(checkpoints, toolExecutor, plan.rollbackPlan);
                _rolledBack = true;

                const duration = Date.now() - planStart;
                this.recordPlanDuration(duration);

                return {
                  planId: plan.id,
                  status: 'rolled_back',
                  completedSteps,
                  totalSteps: plan.steps.length,
                  results,
                  errors,
                  duration,
                  rolledBack: true,
                };
              }
            }
          } else if (step.status === 'failed') {
            const stepError = step.error || 'unknown error';
            errors.set(step.id, stepError);
            this.stats.failedSteps++;

            // 判断是否关键步骤
            if (step.critical !== false) {
              // 关键步骤失败 → 回滚
              this.log.error('critical step failed, triggering rollback', {
                planId: plan.id,
                stepId: step.id,
                error: stepError,
              });

              await this.rollbackWithPlan(checkpoints, toolExecutor, plan.rollbackPlan);
              _rolledBack = true;
              this.stats.rolledBackPlans++;

              const duration = Date.now() - planStart;
              this.recordPlanDuration(duration);

              this.persistExecution(plan, 'rolled_back', completedSteps, duration);

              return {
                planId: plan.id,
                status: 'rolled_back',
                completedSteps,
                totalSteps: plan.steps.length,
                results,
                errors,
                duration,
                rolledBack: true,
              };
            } else {
              // 非关键步骤失败 → 跳过并继续
              this.log.warn('non-critical step failed, skipping', {
                planId: plan.id,
                stepId: step.id,
                error: stepError,
              });
            }
          }
        }
      }

      // 全部完成
      const duration = Date.now() - planStart;
      this.recordPlanDuration(duration);

      const allCompleted = completedSteps === plan.steps.length;
      let status: ExecutionResult['status'];
      if (allCompleted) {
        status = 'completed';
      } else if (completedSteps > 0) {
        status = 'partial';
      } else {
        status = 'failed';
      }

      if (status === 'completed') this.stats.completedPlans++;
      else if (status === 'failed') this.stats.failedPlans++;

      this.persistExecution(plan, status, completedSteps, duration);

      this.eventBus.emitSync('fault-tolerant.plan.completed', {
        planId: plan.id,
        status,
        completedSteps,
        totalSteps: plan.steps.length,
        duration,
      });

      return {
        planId: plan.id,
        status,
        completedSteps,
        totalSteps: plan.steps.length,
        results,
        errors,
        duration,
        rolledBack: false,
      };
    } catch (err: unknown) {
      this.log.error('plan execution unexpected error', {
        planId: plan.id,
        error: (err instanceof Error ? err.message : String(err)),
      });

      this.stats.failedPlans++;
      const duration = Date.now() - planStart;
      this.recordPlanDuration(duration);

      return {
        planId: plan.id,
        status: 'failed',
        completedSteps,
        totalSteps: plan.steps.length,
        results,
        errors,
        duration,
        rolledBack: false,
      };
    }
  }

  /**
   * 并行执行多个独立步骤
   * - 可配置并发数（默认 3）
   * - 每个步骤独立重试
   * - 返回每个步骤的结果
   */
  async executeParallel(
    steps: ExecutionStep[],
    toolExecutor: ToolExecutorFn,
    concurrency: number = 3,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const queue = [...steps];
    const running: Promise<void>[] = [];

    const runStep = async (step: ExecutionStep): Promise<void> => {
      step.status = 'running';
      step.startTime = Date.now();

      try {
        const result = await this.executeStepWithRetry(step, toolExecutor);
        step.status = 'completed';
        step.result = result;
        step.endTime = Date.now();
        results.set(step.id, result);

        const stepDuration = step.endTime - step.startTime;
        this.stepDurations.push(stepDuration);
        if (this.stepDurations.length > 500) this.stepDurations.shift();
      } catch (err: unknown) {
        step.status = 'failed';
        step.error = (err instanceof Error ? err.message : String(err));
        step.endTime = Date.now();
      }
    };

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const step = queue.shift();
        if (!step) break;
        await runStep(step);
      }
    };

    const workerCount = Math.min(concurrency, steps.length);
    for (let i = 0; i < workerCount; i++) {
      running.push(worker());
    }

    await Promise.all(running);
    return results;
  }

  /**
   * 回滚已执行步骤（逆序）
   * - 尽力而为：回滚失败不阻断其他回滚
   * - 每次回滚记录日志
   */
  async rollback(
    checkpoints: ExecutionCheckpoint[],
    toolExecutor: ToolExecutorFn,
  ): Promise<void> {
    this.stats.rollbackCount++;
    const rollbackable = checkpoints.filter(cp => cp.canRollback).reverse();

    this.log.info('starting rollback', {
      totalCheckpoints: checkpoints.length,
      rollbackableSteps: rollbackable.length,
    });

    this.eventBus.emitSync('fault-tolerant.rollback.started', {
      stepCount: rollbackable.length,
    });

    for (const checkpoint of rollbackable) {
      try {
        const stepState = checkpoint.state;
        if (!stepState?.step) continue;

        // 查找对应的回滚动作
        const rollbackAction = this.findRollbackAction(checkpoint.stepId);
        if (!rollbackAction) {
          this.log.warn('no rollback action for step', {
            stepId: checkpoint.stepId,
          });
          continue;
        }

        this.log.info('rolling back step', {
          stepId: checkpoint.stepId,
          rollbackTool: rollbackAction.toolName,
        });

        await toolExecutor(rollbackAction.toolName, rollbackAction.args);

        this.eventBus.emitSync('fault-tolerant.rollback.step', {
          stepId: checkpoint.stepId,
        });
      } catch (err: unknown) {
        // 回滚是尽力而为，失败不阻断
        this.log.error('rollback step failed (best-effort, continuing)', {
          stepId: checkpoint.stepId,
          error: (err instanceof Error ? err.message : String(err)),
        });
      }
    }

    this.log.info('rollback completed', { stepsRolledBack: rollbackable.length });

    this.eventBus.emitSync('fault-tolerant.rollback.completed', {
      stepsRolledBack: rollbackable.length,
    });
  }

  /**
   * 从步骤描述创建执行计划
   * - 自动检测依赖关系
   * - 自动生成分行组
   */
  createPlan(
    steps: Array<{
      tool: string;
      args: Record<string, unknown>;
      description: string;
      critical?: boolean;
      rollback?: { tool: string; args: Record<string, unknown> };
    }>,
  ): ExecutionPlan {
    const planId = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const executionSteps: ExecutionStep[] = [];
    const rollbackPlan: RollbackAction[] = [];

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepId = `step_${i}_${Math.random().toString(36).slice(2, 6)}`;

      const step: ExecutionStep = {
        id: stepId,
        toolName: s.tool,
        args: s.args,
        description: s.description,
        timeout: 30000,
        retries: 0,
        maxRetries: 3,
        dependsOn: i > 0 ? [executionSteps[i - 1].id] : [],
        status: 'pending',
        critical: s.critical ?? true,
      };

      if (s.rollback) {
        const rollbackAction: RollbackAction = {
          stepId,
          toolName: s.rollback.tool,
          args: s.rollback.args,
          description: `Rollback for: ${s.description}`,
        };
        step.rollback = rollbackAction;
        rollbackPlan.push(rollbackAction);
      }

      executionSteps.push(step);
    }

    // 自动检测并行组：基于依赖拓扑排序
    const parallelGroups = this.buildParallelGroups(executionSteps);

    return {
      id: planId,
      steps: executionSteps,
      rollbackPlan,
      timeout: 60000,
      maxRetries: 3,
      parallelGroups,
    };
  }

  /**
   * 异常检测
   * - 错误模式：❌, Error:, 失败, timeout, ECONNREFUSED
   * - 意外模式：空结果、超长结果(>10K)、重复内容
   * - 安全模式：permission denied, access denied, unauthorized
   */
  detectAnomaly(stepResult: string): AnomalyDetection {
    if (!stepResult) {
      return { isAnomaly: true, type: 'empty_result', severity: 'low' };
    }

    // 错误模式
    const errorPatterns = [
      { pattern: /❌/, type: 'error_emoji', severity: 'medium' as const },
      { pattern: /Error:/i, type: 'error_keyword', severity: 'medium' as const },
      { pattern: /失败/, type: 'error_chinese', severity: 'medium' as const },
      { pattern: /timeout/i, type: 'timeout', severity: 'high' as const },
      { pattern: /ECONNREFUSED/i, type: 'connection_refused', severity: 'high' as const },
    ];

    for (const { pattern, type, severity } of errorPatterns) {
      if (pattern.test(stepResult)) {
        return { isAnomaly: true, type, severity };
      }
    }

    // 安全模式
    const securityPatterns = [
      { pattern: /permission denied/i, type: 'permission_denied', severity: 'critical' as const },
      { pattern: /access denied/i, type: 'access_denied', severity: 'critical' as const },
      { pattern: /unauthorized/i, type: 'unauthorized', severity: 'critical' as const },
    ];

    for (const { pattern, type, severity } of securityPatterns) {
      if (pattern.test(stepResult)) {
        return { isAnomaly: true, type, severity };
      }
    }

    // 意外模式：超长结果
    if (stepResult.length > 10000) {
      return { isAnomaly: true, type: 'excessive_length', severity: 'low' };
    }

    // 意外模式：重复内容
    const lines = stepResult.split('\n');
    if (lines.length > 5) {
      const uniqueLines = new Set(lines);
      const repetitionRatio = 1 - uniqueLines.size / lines.length;
      if (repetitionRatio > 0.7) {
        return { isAnomaly: true, type: 'repeated_content', severity: 'low' };
      }
    }

    return { isAnomaly: false, type: 'none', severity: 'low' };
  }

  /**
   * 获取执行统计
   */
  getExecutionStats(): ExecutionStats {
    return {
      ...this.stats,
      avgPlanDuration: this.planDurations.length > 0
        ? this.planDurations.reduce((a, b) => a + b, 0) / this.planDurations.length
        : 0,
      avgStepDuration: this.stepDurations.length > 0
        ? this.stepDurations.reduce((a, b) => a + b, 0) / this.stepDurations.length
        : 0,
    };
  }

  // ============ 工具定义 ============

  getToolDefinitions() {
    return [
      {
        name: 'execute_plan',
        description: '执行多步骤容错计划，支持依赖管理、并行执行、自动回滚和错误恢复',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'string',
              description: 'JSON 字符串，步骤数组。每项包含 tool, args, description, critical?, rollback?',
            },
          },
          required: ['steps'],
        },
      },
      {
        name: 'execute_parallel',
        description: '并行执行多个独立步骤，支持并发控制',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'string',
              description: 'JSON 字符串，步骤数组。每项包含 tool, args, description',
            },
            concurrency: {
              type: 'number',
              description: '最大并发数，默认 3',
            },
          },
          required: ['steps'],
        },
      },
    ];
  }

  /**
   * 执行工具调用
   */
  async executeTool(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: Record<string, any>,
    toolExecutor: ToolExecutorFn,
  ): Promise<string> {
    switch (toolName) {
      case 'execute_plan': {
        const steps = JSON.parse(args.steps);
        const plan = this.createPlan(steps);
        const result = await this.executePlan(plan, toolExecutor);
        return JSON.stringify({
          planId: result.planId,
          status: result.status,
          completedSteps: result.completedSteps,
          totalSteps: result.totalSteps,
          duration: result.duration,
          rolledBack: result.rolledBack,
          results: Object.fromEntries(result.results),
          errors: Object.fromEntries(result.errors),
        });
      }
      case 'execute_parallel': {
        const stepsData = JSON.parse(args.steps);
        const concurrency = args.concurrency || 3;
        const execSteps: ExecutionStep[] = stepsData.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any, i: number) => ({
            id: `par_${i}_${Math.random().toString(36).slice(2, 6)}`,
            toolName: s.tool,
            args: s.args,
            description: s.description,
            timeout: 30000,
            retries: 0,
            maxRetries: 2,
            dependsOn: [],
            status: 'pending' as const,
          }),
        );
        const results = await this.executeParallel(execSteps, toolExecutor, concurrency);
        return JSON.stringify(Object.fromEntries(results));
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ============ 私有方法 ============

  /**
   * 带重试的步骤执行
   * - 指数退避：1s, 2s, 4s, 8s（带抖动）
   * - 不同错误类型不同策略
   */
  private async executeStepWithRetry(
    step: ExecutionStep,
    toolExecutor: ToolExecutorFn,
  ): Promise<string> {
    const maxRetries = step.maxRetries;
    let lastError: Error | null = null;

    const useBreaker = process.env.USE_STEP_CIRCUIT_BREAKER === 'true';
    const breaker = useBreaker
      ? resilienceChain.getCircuitBreaker(`step_${step.toolName}`)
      : null;

    if (breaker && breaker.getState() === 'open') {
      throw new Error(`Step ${step.id} skipped: circuit breaker open for tool ${step.toolName}`);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 带超时执行
        const result = await Promise.race([
          toolExecutor(step.toolName, step.args),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Step timeout after ${step.timeout}ms`)),
              step.timeout,
            ),
          ),
        ]);

        if (attempt > 0) {
          this.log.info('step succeeded after retry', {
            stepId: step.id,
            attempt,
          });
        }

        if (breaker) breaker.recordSuccess();
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        step.retries = attempt;
        if (breaker) breaker.recordFailure();

        const errorType = this.classifyError((err instanceof Error ? err.message : String(err)));

        if (breaker && breaker.getState() === 'open') {
          this.log.warn('circuit breaker opened, skipping remaining retries', {
            stepId: step.id,
            toolName: step.toolName,
            attempt,
          });
          break;
        }

        // 权限错误不重试
        if (errorType === 'permission') {
          this.log.error('permission error, not retrying', {
            stepId: step.id,
            error: (err instanceof Error ? err.message : String(err)),
          });
          break;
        }

        // 最后一次不等待
        if (attempt < maxRetries) {
          const baseDelay = Math.pow(2, attempt) * 1000;
          const jitter = Math.random() * 500;
          const delay = baseDelay + jitter;

          // 超时错误：延长下次超时
          if (errorType === 'timeout') {
            step.timeout = Math.min(step.timeout * 1.5, 120000);
            this.log.warn('timeout error, extending timeout and retrying', {
              stepId: step.id,
              newTimeout: step.timeout,
              attempt: attempt + 1,
            });
          }

          this.log.warn('step failed, retrying', {
            stepId: step.id,
            attempt: attempt + 1,
            maxRetries,
            delay: Math.round(delay),
            errorType,
          });

          this.stats.retriedSteps++;
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error(`Step ${step.id} failed after ${maxRetries} retries`);
  }

  /**
   * 错误分类
   */
  private classifyError(errorMessage: string): 'timeout' | 'permission' | 'network' | 'tool' {
    if (/timeout|ETIMEDOUT|timed out/i.test(errorMessage)) return 'timeout';
    if (/permission denied|access denied|unauthorized|EACCES|EPERM/i.test(errorMessage)) return 'permission';
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(errorMessage)) return 'network';
    return 'tool';
  }

  /**
   * 构建并行组
   * - 拓扑排序分析依赖
   * - 无依赖关系的步骤归入同一组
   */
  private buildParallelGroups(steps: ExecutionStep[]): number[][] {
    if (steps.length === 0) return [];

    const groups: number[][] = [];
    const completed = new Set<string>();

    let remaining = steps.map((_, idx) => idx);

    while (remaining.length > 0) {
      const readyIndices = remaining.filter(idx => {
        const step = steps[idx];
        if (step.dependsOn.length === 0) return true;
        return step.dependsOn.every(depId => completed.has(depId));
      });

      if (readyIndices.length === 0) {
        // 循环依赖，强制将剩余步骤加入
        groups.push(remaining);
        break;
      }

      groups.push(readyIndices);

      for (const idx of readyIndices) {
        completed.add(steps[idx].id);
      }

      remaining = remaining.filter(idx => !readyIndices.includes(idx));
    }

    return groups;
  }

  /**
   * 查找步骤的回滚动作
   */
  private findRollbackAction(stepId: string): RollbackAction | undefined {
    // 从当前执行上下文查找 — 由 rollback 方法调用时
    // 通过 eventBus 查找最近的回滚计划
    return this._currentRollbackPlan?.find(a => a.stepId === stepId);
  }

  private _currentRollbackPlan: RollbackAction[] | null = null;

  /**
   * 公开回滚接口 — 修复之前公开 rollback() 因 _currentRollbackPlan
   * 为 null 而静默失败的问题。现在公开接口直接接受回滚计划参数。
   */
  async rollbackWithActions(
    checkpoints: ExecutionCheckpoint[],
    toolExecutor: ToolExecutorFn,
    rollbackPlan: RollbackAction[],
  ): Promise<void> {
    this._currentRollbackPlan = rollbackPlan;
    try {
      await this.rollback(checkpoints, toolExecutor);
    } finally {
      this._currentRollbackPlan = null;
    }
  }

  /**
   * 覆写 rollback 以注入回滚计划（内部使用）
   */
  private async rollbackWithPlan(
    checkpoints: ExecutionCheckpoint[],
    toolExecutor: ToolExecutorFn,
    rollbackPlan: RollbackAction[],
  ): Promise<void> {
    this._currentRollbackPlan = rollbackPlan;
    try {
      await this.rollback(checkpoints, toolExecutor);
    } finally {
      this._currentRollbackPlan = null;
    }
  }

  /**
   * 记录计划执行时长
   */
  private recordPlanDuration(duration: number): void {
    this.planDurations.push(duration);
    if (this.planDurations.length > 200) this.planDurations.shift();
  }

  /**
   * 持久化执行记录
   */
  private persistExecution(
    plan: ExecutionPlan,
    status: string,
    completedSteps: number,
    duration: number,
  ): void {
    try {
      const historyFile = path.join(this.historyDir, 'history.json');
      let history: unknown[] = [];

      if (fs.existsSync(historyFile)) {
        try {
          history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        } catch { /* corrupted, start fresh */ }
      }

      history.push({
        planId: plan.id,
        status,
        completedSteps,
        totalSteps: plan.steps.length,
        duration,
        timestamp: Date.now(),
        steps: plan.steps.map(s => ({
          id: s.id,
          toolName: s.toolName,
          description: s.description,
          status: s.status,
          retries: s.retries,
          error: s.error,
          duration: s.startTime && s.endTime ? s.endTime - s.startTime : undefined,
        })),
      });

      // 保留最近 200 条
      if (history.length > 200) {
        history = history.slice(-200);
      }

      atomicWriteJsonSync(historyFile, history);
    } catch (err: unknown) {
      this.log.error('failed to persist execution history', {
        error: (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  /**
   * 加载历史记录
   */
  private loadHistory(): void {
    try {
      const historyFile = path.join(this.historyDir, 'history.json');
      if (!fs.existsSync(historyFile)) return;

      const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      if (!Array.isArray(history)) return;

      // 恢复基本统计
      for (const entry of history) {
        this.stats.totalPlans++;
        if (entry.status === 'completed') this.stats.completedPlans++;
        else if (entry.status === 'failed') this.stats.failedPlans++;
        else if (entry.status === 'rolled_back') this.stats.rolledBackPlans++;

        if (entry.steps) {
          for (const step of entry.steps) {
            this.stats.totalSteps++;
            if (step.status === 'completed') this.stats.completedSteps++;
            else if (step.status === 'failed') this.stats.failedSteps++;
            if (step.retries > 0) this.stats.retriedSteps++;
          }
        }

        if (entry.duration) {
          this.planDurations.push(entry.duration);
        }
      }

      // 只保留最近 200 条时长记录
      if (this.planDurations.length > 200) {
        this.planDurations = this.planDurations.slice(-200);
      }
    } catch {
      // 无法加载历史，忽略
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
