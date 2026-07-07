/**
 * Planner/Executor/Verifier 三智能体闭环编排器 — ThreeAgentOrchestrator
 *
 * 对标 Manus 的 Planner/Executor/Verifier 三智能体协作模式。
 *
 * 核心闭环：
 *   Plan → Execute → Verify → (通过→下一步 / 失败→Replan) → ... → 完成
 *
 * 设计理念：
 * - Planner：分解任务为可执行步骤，维护全局计划，失败即换路径
 * - Executor：执行单个步骤，返回结果和证据
 * - Verifier：验证执行结果，生成验证报告
 * - 闭环：验证失败自动触发重规划，最多 3 轮重规划
 *
 * 与现有组件的关系：
 * - 独立于 task-planner.ts / task-execution-engine.ts / adversarial-verifier.ts
 * - 可与 VirtualMemoryWorkflow 集成，将计划写入 todo.md
 * - 可与 PlannerCritic 集成，Critic 作为 Verifier 的一种实现
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { VirtualMemoryWorkflow } from './virtual-memory-workflow.js';

// ============ 类型定义 ============

/** 步骤状态 */
export type StepStatus = 'pending' | 'executing' | 'verified' | 'failed' | 'skipped';

/** 执行步骤 */
export interface PlanStep {
  /** 步骤 ID */
  stepId: string;
  /** 步骤描述 */
  description: string;
  /** 推荐工具 */
  suggestedTool?: string;
  /** 预期结果 */
  expectedResult?: string;
  /** 依赖步骤 ID 列表 */
  dependsOn?: string[];
  /** 状态 */
  status: StepStatus;
  /** 执行结果 */
  result?: StepResult;
  /** 尝试次数 */
  attempts: number;
}

/** 步骤执行结果 */
export interface StepResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（ms） */
  durationMs: number;
  /** 证据（用于验证） */
  evidence?: string[];
  /** 使用的工具 */
  toolUsed?: string;
}

/** 验证报告 */
export interface VerificationReport {
  /** 是否通过 */
  passed: boolean;
  /** 验证分数（0-1） */
  score: number;
  /** 验证维度 */
  checks: VerificationCheck[];
  /** 失败原因（如果不通过） */
  failureReason?: string;
  /** 修正建议 */
  suggestions?: string[];
}

/** 验证检查项 */
export interface VerificationCheck {
  /** 检查名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 详细信息 */
  detail: string;
}

/** 执行计划 */
export interface ExecutionPlan {
  /** 计划 ID */
  planId: string;
  /** 原始任务 */
  task: string;
  /** 步骤列表 */
  steps: PlanStep[];
  /** 创建时间 */
  createdAt: number;
  /** 版本号（重规划递增） */
  version: number;
}

/** 闭环执行结果 */
export interface OrchestrationResult {
  /** 是否整体成功 */
  success: boolean;
  /** 执行的计划 */
  plan: ExecutionPlan;
  /** 完成的步骤数 */
  completedSteps: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 重规划次数 */
  replanCount: number;
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 最终输出 */
  finalOutput: string;
  /** 执行历史 */
  history: Array<{
    stepId: string;
    stepDescription: string;
    attempt: number;
    result: StepResult;
    verification: VerificationReport;
    timestamp: number;
  }>;
}

/** 执行器函数类型 */
export type ExecutorFn = (step: PlanStep) => Promise<StepResult>;

/** 验证器函数类型 */
export type VerifierFn = (step: PlanStep, result: StepResult) => Promise<VerificationReport>;

// ============ 常量 ============

/** 最大重规划次数 */
const MAX_REPLAN_ATTEMPTS = 3;

/** 最大单步重试次数 */
const MAX_STEP_RETRIES = 2;

// ============ 三智能体闭环编排器 ============

export class ThreeAgentOrchestrator {
  /** 执行器函数 */
  private executorFn: ExecutorFn;

  /** 验证器函数 */
  private verifierFn: VerifierFn;

  /** 虚拟内存工作流（可选集成） */
  private vmWorkflow?: VirtualMemoryWorkflow;

  private log = logger.child({ module: 'ThreeAgentOrchestrator' });

  constructor(options?: {
    executor?: ExecutorFn;
    verifier?: VerifierFn;
    vmWorkflow?: VirtualMemoryWorkflow;
  }) {
    // 使用默认执行器（如果没有提供）
    this.executorFn = options?.executor ?? this.defaultExecutor.bind(this);
    this.verifierFn = options?.verifier ?? this.defaultVerifier.bind(this);
    this.vmWorkflow = options?.vmWorkflow;
  }

  // ========== 闭环执行 ==========

  /**
   * 执行三智能体闭环
   *
   * Plan → Execute → Verify → (通过→下一步 / 失败→Replan) → ... → 完成
   */
  async orchestrate(task: string, initialPlan?: string[]): Promise<OrchestrationResult> {
    const startTime = Date.now();
    this.log.info('三智能体闭环启动', { task: task.substring(0, 100) });

    // === Planner 阶段：生成初始计划 ===
    let plan = this.plan(task, initialPlan);

    // 集成到 todo.md（如果配置了 VM 工作流）
    if (this.vmWorkflow) {
      for (const step of plan.steps) {
        this.vmWorkflow.addTask(step.description, 3);
      }
    }

    let replanCount = 0;
    const history: OrchestrationResult['history'] = [];

    // === 闭环执行 ===
    while (replanCount <= MAX_REPLAN_ATTEMPTS) {
      let allPassed = true;
      let failedStep: PlanStep | null = null;

      for (const step of plan.steps) {
        // 跳过已完成或已跳过的步骤
        if (step.status === 'verified' || step.status === 'skipped') continue;

        // 检查依赖是否已完成
        if (!this.checkDependencies(step, plan)) {
          step.status = 'skipped';
          continue;
        }

        // === Executor 阶段：执行步骤 ===
        step.status = 'executing';
        step.attempts++;

        EventBus.getInstance().emitSync('three-agent.execute.start', {
          stepId: step.stepId,
          description: step.description,
          attempt: step.attempts,
        });

        const execStart = Date.now();
        const result = await this.execute(step);
        const execDuration = Date.now() - execStart;

        step.result = result;

        // === Verifier 阶段：验证结果 ===
        const verification = await this.verify(step, result);

        history.push({
          stepId: step.stepId,
          stepDescription: step.description,
          attempt: step.attempts,
          result,
          verification,
          timestamp: Date.now(),
        });

        if (verification.passed) {
          // 验证通过
          step.status = 'verified';
          this.log.info('步骤验证通过', {
            stepId: step.stepId,
            score: verification.score,
            duration: execDuration,
          });

          // 更新 todo.md
          if (this.vmWorkflow) {
            // this.vmWorkflow.updateTaskStatus(step.stepId, 'completed');
          }

          EventBus.getInstance().emitSync('three-agent.verify.passed', {
            stepId: step.stepId,
            score: verification.score,
          });
        } else {
          // 验证失败
          step.status = 'failed';
          allPassed = false;
          failedStep = step;

          this.log.warn('步骤验证失败', {
            stepId: step.stepId,
            reason: verification.failureReason,
            attempt: step.attempts,
          });

          EventBus.getInstance().emitSync('three-agent.verify.failed', {
            stepId: step.stepId,
            reason: verification.failureReason,
          });

          // 如果还有重试次数，重试当前步骤
          if (step.attempts < MAX_STEP_RETRIES) {
            step.status = 'pending';
            continue;
          }

          // 超过重试次数，触发重规划
          break;
        }
      }

      // 所有步骤通过，返回成功
      if (allPassed) {
        const completedSteps = plan.steps.filter(s => s.status === 'verified').length;
        const totalDuration = Date.now() - startTime;

        this.log.info('三智能体闭环完成', {
          success: true,
          completedSteps,
          totalSteps: plan.steps.length,
          replanCount,
          totalDuration,
        });

        return {
          success: true,
          plan,
          completedSteps,
          totalSteps: plan.steps.length,
          replanCount,
          totalDurationMs: totalDuration,
          finalOutput: this.generateFinalOutput(plan),
          history,
        };
      }

      // === 外层状态机：重规划（内层单步重试已耗尽，转入重规划阶段）===
      replanCount++;
      if (replanCount > MAX_REPLAN_ATTEMPTS) {
        // 重规划次数耗尽，退出外层循环进入失败处理
        break;
      }

      this.log.info('触发重规划', {
        replanCount,
        failedStep: failedStep?.stepId,
      });

      EventBus.getInstance().emitSync('three-agent.replan', {
        replanCount,
        failedStep: failedStep?.stepId,
        reason: failedStep?.result?.error,
      });

      // === Planner 阶段：重规划（替代步骤会将该步骤 attempts 重置为 0）===
      plan = this.replan(task, plan, failedStep!, replanCount);
    }

    // 重规划次数耗尽，返回失败
    const completedSteps = plan.steps.filter(s => s.status === 'verified').length;
    const totalDuration = Date.now() - startTime;

    this.log.warn('三智能体闭环失败', {
      completedSteps,
      totalSteps: plan.steps.length,
      replanCount,
      totalDuration,
    });

    return {
      success: false,
      plan,
      completedSteps,
      totalSteps: plan.steps.length,
      replanCount,
      totalDurationMs: totalDuration,
      finalOutput: `任务未完成。已完成 ${completedSteps}/${plan.steps.length} 步骤，重规划 ${replanCount} 次。`,
      history,
    };
  }

  // ========== Planner：计划生成 ==========

  /**
   * Planner：分解任务为步骤
   */
  plan(task: string, initialPlan?: string[]): ExecutionPlan {
    const planId = `plan_${Date.now().toString(36)}`;
    const steps: PlanStep[] = [];

    if (initialPlan && initialPlan.length > 0) {
      // 使用提供的初始计划
      for (let i = 0; i < initialPlan.length; i++) {
        steps.push({
          stepId: `step_${i + 1}`,
          description: initialPlan[i],
          status: 'pending',
          attempts: 0,
          dependsOn: i > 0 ? [`step_${i}`] : [],
        });
      }
    } else {
      // 自动分解（简化版：按句号/分号/换行分解）
      const parts = task.split(/[。；;\n]/).map(s => s.trim()).filter(s => s.length > 0);
      for (let i = 0; i < parts.length; i++) {
        steps.push({
          stepId: `step_${i + 1}`,
          description: parts[i],
          status: 'pending',
          attempts: 0,
          dependsOn: i > 0 ? [`step_${i}`] : [],
        });
      }

      // 如果无法分解，创建单步计划
      if (steps.length === 0) {
        steps.push({
          stepId: 'step_1',
          description: task,
          status: 'pending',
          attempts: 0,
        });
      }
    }

    const plan: ExecutionPlan = {
      planId,
      task,
      steps,
      createdAt: Date.now(),
      version: 1,
    };

    this.log.info('计划已生成', {
      planId,
      stepCount: steps.length,
      version: plan.version,
    });

    EventBus.getInstance().emitSync('three-agent.plan.created', {
      planId,
      stepCount: steps.length,
    });

    return plan;
  }

  /**
   * Planner：重规划（失败后调整计划）
   */
  replan(task: string, oldPlan: ExecutionPlan, failedStep: PlanStep, _replanCount: number): ExecutionPlan {
    const newSteps: PlanStep[] = [];

    // 保留已验证的步骤
    for (const step of oldPlan.steps) {
      if (step.status === 'verified') {
        newSteps.push({ ...step });
      } else if (step.stepId === failedStep.stepId) {
        // 替换失败步骤为替代方案
        newSteps.push({
          stepId: step.stepId,
          description: `[替代方案] ${step.description}（原方案失败：${step.result?.error ?? '未知错误'}）`,
          status: 'pending',
          attempts: 0,
          dependsOn: step.dependsOn,
          suggestedTool: step.suggestedTool,
        });
      } else if (step.status === 'pending') {
        // 保留未执行的步骤
        newSteps.push({ ...step });
      }
    }

    const newPlan: ExecutionPlan = {
      planId: `plan_${Date.now().toString(36)}`,
      task,
      steps: newSteps,
      createdAt: oldPlan.createdAt,
      version: oldPlan.version + 1,
    };

    this.log.info('重规划完成', {
      oldPlanId: oldPlan.planId,
      newPlanId: newPlan.planId,
      version: newPlan.version,
      stepCount: newSteps.length,
    });

    return newPlan;
  }

  // ========== Executor：步骤执行 ==========


  /**
   * Executor：执行单个步骤
   */
  private async execute(step: PlanStep): Promise<StepResult> {
    const start = Date.now();
    try {
      const result = await this.executorFn(step);
      result.durationMs = Date.now() - start;
      return result;
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  // ========== Verifier：结果验证 ==========

  /**
   * Verifier：验证执行结果
   */
  private verify(step: PlanStep, result: StepResult): Promise<VerificationReport> {
    return this.verifierFn(step, result);
  }

  // ========== 辅助方法 ==========

  /** 检查步骤依赖是否已完成 */
  private checkDependencies(step: PlanStep, plan: ExecutionPlan): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) return true;

    for (const depId of step.dependsOn) {
      const dep = plan.steps.find(s => s.stepId === depId);
      if (!dep || dep.status !== 'verified') {
        return false;
      }
    }
    return true;
  }

  /** 生成最终输出 */
  private generateFinalOutput(plan: ExecutionPlan): string {
    const lines: string[] = [
      '# 任务执行完成',
      '',
      `**任务**: ${plan.task}`,
      `**计划版本**: v${plan.version}`,
      `**步骤数**: ${plan.steps.length}`,
      '',
      '## 步骤结果',
      '',
    ];

    for (const step of plan.steps) {
      let emoji: string;
      if (step.status === 'verified') emoji = '✅';
      else if (step.status === 'failed') emoji = '❌';
      else emoji = '⬜';
      lines.push(`${emoji} **${step.stepId}**: ${step.description}`);
      if (step.result?.output) {
        lines.push(`   - 输出: ${step.result.output.substring(0, 200)}`);
      }
    }

    return lines.join('\n');
  }

  // ========== 默认执行器和验证器 ==========

  /** 默认执行器（模拟执行） */
  private defaultExecutor(step: PlanStep): Promise<StepResult> {
    return Promise.resolve({
      success: true,
      output: `[模拟执行] ${step.description}`,
      durationMs: 0,
      evidence: ['模拟执行结果'],
    });
  }

  /** 默认验证器（基本检查） */
  private defaultVerifier(step: PlanStep, result: StepResult): Promise<VerificationReport> {
    const checks: VerificationCheck[] = [];

    // 检查1：执行是否成功
    checks.push({
      name: '执行成功',
      passed: result.success,
      detail: result.success ? '执行返回成功' : `执行失败: ${result.error ?? '未知错误'}`,
    });

    // 检查2：输出是否非空
    checks.push({
      name: '输出非空',
      passed: result.output.length > 0,
      detail: result.output.length > 0 ? `输出长度: ${result.output.length}` : '输出为空',
    });

    // 检查3：是否有证据
    if (step.expectedResult) {
      checks.push({
        name: '预期结果匹配',
        passed: result.output.includes(step.expectedResult) || result.success,
        detail: step.expectedResult,
      });
    }

    const passedChecks = checks.filter(c => c.passed).length;
    const score = checks.length > 0 ? passedChecks / checks.length : 0;
    const passed = score >= 0.6;

    return Promise.resolve({
      passed,
      score,
      checks,
      failureReason: passed ? undefined : `${checks.length - passedChecks}/${checks.length} 项检查未通过`,
      suggestions: passed ? undefined : ['考虑使用替代工具', '检查输入参数', '分解为更小步骤'],
    });
  }

  // ========== 配置方法 ==========

  /** 设置自定义执行器 */
  setExecutor(fn: ExecutorFn): void {
    this.executorFn = fn;
  }

  /** 设置自定义验证器 */
  setVerifier(fn: VerifierFn): void {
    this.verifierFn = fn;
  }

  /** 设置虚拟内存工作流 */
  setVMWorkflow(vm: VirtualMemoryWorkflow): void {
    this.vmWorkflow = vm;
  }
}
