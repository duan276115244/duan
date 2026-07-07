/**
 * 增强任务执行引擎 — TaskExecutionEngine
 *
 * 核心能力：
 * 1. 目标分解：将复杂目标分解为可执行步骤（模板匹配 → LLM → 规则回退）
 * 2. 动态调整：根据执行结果动态调整计划（重试、跳过、重新规划）
 * 3. 成功追踪：基于步骤完成/失败/跳过计算成功分数
 * 4. 持久化：自动保存执行状态，支持断点续行
 * 5. 工具集成：通过 toolExecutor 回调调用任意注册工具
 *
 * 设计原则：
 * - 渐进式降级：模板 → LLM → 规则，确保总能产出执行计划
 * - 失败容错：关键步骤重试，可选步骤跳过，连续失败建议调整
 * - 可观测性：结构化日志 + 事件总线，全链路追踪执行过程
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { TaskPlanner } from './task-planner.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface ExecutionStep {
  id: string;
  description: string;
  toolName?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolArgs?: Record<string, any>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: string;
  error?: string;
  retryCount: number;
  dependencies: string[];
  estimatedDuration: number;
  actualDuration?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ExecutionLogEntry {
  stepId: string;
  action: string;
  result: string;
  success: boolean;
  timestamp: number;
  duration: number;
}

export interface TaskExecution {
  id: string;
  originalGoal: string;
  decomposedSteps: ExecutionStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'paused' | 'adjusting';
  executionLog: ExecutionLogEntry[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  retryCount: number;
  maxRetries: number;
  parentTaskId?: string;
  successScore: number;
}

export interface TaskTemplate {
  name: string;
  description: string;
  goalPattern: RegExp;
  steps: Array<{
    description: string;
    toolName: string;
    argsTemplate: string;
  }>;
  requiredEntities: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolExecutor = (toolName: string, args: any) => Promise<string>;

export interface TaskExecutionEngineConfig {
  maxRetries?: number;
  stepTimeout?: number;
  persistenceDir?: string;
  autoSave?: boolean;
}

// ============ 内置任务模板 ============

const BUILT_IN_TEMPLATES: TaskTemplate[] = [
  {
    name: '打开微信给好友发送消息',
    description: '打开微信，查找联系人并发送消息',
    goalPattern: /微信.*发[送消息]|发[送消息].*微信|打开微信.*消息|给.*发微信/,
    steps: [
      { description: '打开微信应用', toolName: 'openWeChat', argsTemplate: '{}' },
      { description: '查找联系人 {contact}', toolName: 'findContact', argsTemplate: '{"contact":"{contact}"}' },
      { description: '发送消息 {message}', toolName: 'sendMessage', argsTemplate: '{"message":"{message}"}' },
    ],
    requiredEntities: ['contact', 'message'],
  },
  {
    name: '搜索并总结',
    description: '搜索指定内容并生成总结',
    goalPattern: /搜索.*总结|搜索.*概[要括]|查找.*总结|search.*summar/i,
    steps: [
      { description: '搜索 {query}', toolName: 'search', argsTemplate: '{"query":"{query}"}' },
      { description: '总结搜索结果', toolName: 'summarize', argsTemplate: '{"content":"{searchResult}"}' },
    ],
    requiredEntities: ['query'],
  },
  {
    name: '代码审查并修复',
    description: '审查代码、识别问题并修复',
    goalPattern: /代码审查.*修复|审查.*代码.*修|code.?review.*fix|审查并修复/,
    steps: [
      { description: '审查代码 {filePath}', toolName: 'codeReview', argsTemplate: '{"filePath":"{filePath}"}' },
      { description: '识别代码问题', toolName: 'identifyIssues', argsTemplate: '{"reviewResult":"{reviewResult}"}' },
      { description: '修复识别出的问题', toolName: 'fixIssues', argsTemplate: '{"issues":"{issues}"}' },
    ],
    requiredEntities: ['filePath'],
  },
  {
    name: '部署项目',
    description: '构建、测试并部署项目',
    goalPattern: /部署.*项目|deploy.*project|发布.*项目|上线/,
    steps: [
      { description: '构建项目', toolName: 'build', argsTemplate: '{"projectPath":"{projectPath}"}' },
      { description: '运行测试', toolName: 'test', argsTemplate: '{"projectPath":"{projectPath}"}' },
      { description: '部署到目标环境', toolName: 'deploy', argsTemplate: '{"projectPath":"{projectPath}","environment":"{environment}"}' },
    ],
    requiredEntities: ['projectPath'],
  },
];

// ============ 任务执行引擎主类 ============

export class TaskExecutionEngine {
  private tasks: Map<string, TaskExecution> = new Map();
  private templates: TaskTemplate[] = [];
  private taskPlanner: TaskPlanner;
  private eventBus: EventBus;
  private log = logger.child({ module: 'TaskExecutionEngine' });
  private toolExecutor: ToolExecutor;
  private config: Required<TaskExecutionEngineConfig>;
  private currentTaskId: string | null = null;
  private consecutiveFailures = 0;
  private executionPatterns: Map<string, { successRate: number; avgDuration: number; sampleCount: number }> = new Map();
  /** 懒加载标记 */
  private tasksLoaded = false;

  constructor(
    toolExecutor: ToolExecutor,
    config: TaskExecutionEngineConfig = {},
  ) {
    this.toolExecutor = toolExecutor;
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      stepTimeout: config.stepTimeout ?? 30000,
      persistenceDir: config.persistenceDir ?? duanPath('tasks'),
      autoSave: config.autoSave ?? true,
    };
    this.taskPlanner = new TaskPlanner();
    this.eventBus = EventBus.getInstance();

    // 注册内置模板
    for (const tmpl of BUILT_IN_TEMPLATES) {
      this.templates.push(tmpl);
    }
    // 不在构造函数中执行同步 I/O，延迟到首次访问
  }

  /** 懒加载：首次访问任务时才从磁盘加载 */
  private ensureTasksLoaded(): void {
    if (this.tasksLoaded) return;
    this.tasksLoaded = true;
    this.loadTasks();
  }

  // ============ 核心方法 ============

  /**
   * 主入口：分解目标 → 创建执行计划 → 逐步执行
   */
  async planAndExecute(goal: string, entities?: Record<string, string>): Promise<TaskExecution> {
    const task = this.createTask(goal);
    this.currentTaskId = task.id;

    this.log.info('开始规划并执行任务', { taskId: task.id, goal });
    this.eventBus.emitSync('task.planning', { taskId: task.id, goal }, { source: 'TaskExecutionEngine' });

    // 分解目标
    task.status = 'planning';
    this.saveTask(task);

    const steps = this.decomposeGoal(goal, entities);
    task.decomposedSteps = steps;
    task.currentStepIndex = 0;
    task.status = 'executing';
    this.saveTask(task);

    this.log.info('目标分解完成，开始执行', {
      taskId: task.id,
      stepCount: steps.length,
      steps: steps.map(s => s.description),
    });
    this.eventBus.emitSync('task.executing', { taskId: task.id, stepCount: steps.length }, { source: 'TaskExecutionEngine' });

    // 同步到 TaskPlanner
    this.syncToPlanner(task);

    // 逐步执行
    while (task.status === 'executing') {
      const hasMore = await this.executeNextStep();
      if (!hasMore) break;
    }

    return task;
  }

  /**
   * 分解复杂目标为步骤：模板匹配 → LLM（预留）→ 规则回退
   */
  decomposeGoal(goal: string, entities?: Record<string, string>): ExecutionStep[] {
    // 1. 尝试模板匹配
    const matchedTemplate = this.templates.find(t => t.goalPattern.test(goal));
    if (matchedTemplate) {
      this.log.info('匹配到任务模板', { templateName: matchedTemplate.name, goal });
      return this.instantiateTemplate(matchedTemplate, entities || {});
    }

    // 2. LLM 分解（预留接口，当前降级到规则）
    // TODO: 当 LLM 可用时，调用 LLM 进行智能分解
    // const llmSteps = await this.decomposeWithLLM(goal, entities);
    // if (llmSteps) return llmSteps;

    // 3. 规则回退：基于关键词的简单分解
    this.log.info('使用规则回退分解目标', { goal });
    return this.ruleBasedDecompose(goal, entities);
  }

  /**
   * 执行下一个待执行步骤
   */
  async executeNextStep(): Promise<boolean> {
    const task = this.getCurrentTask();
    if (!task || task.status !== 'executing') return false;

    // 查找下一个可执行的步骤（依赖已满足 + 状态为 pending）
    const nextStep = this.findNextExecutableStep(task);
    if (!nextStep) {
      // 检查是否所有步骤都已完成
      const allDone = task.decomposedSteps.every(
        s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped',
      );
      if (allDone) {
        this.finalizeTask(task);
      }
      return false;
    }

    await this.executeStep(nextStep.id);
    return task.status === 'executing';
  }

  /**
   * 执行指定步骤
   */
  async executeStep(stepId: string): Promise<void> {
    const task = this.getCurrentTask();
    if (!task) return;

    const step = task.decomposedSteps.find(s => s.id === stepId);
    if (!step || step.status !== 'pending') return;

    step.status = 'in_progress';
    step.startedAt = Date.now();
    this.saveTask(task);

    this.log.info('开始执行步骤', { stepId, description: step.description });
    this.eventBus.emitSync('task.step.start', {
      taskId: task.id,
      stepId,
      description: step.description,
    }, { source: 'TaskExecutionEngine' });

    try {
      let result: string;

      if (step.toolName) {
        // 带超时的工具执行
        result = await this.executeWithTimeout(step.toolName, step.toolArgs || {});
      } else {
        result = `步骤 "${step.description}" 已完成（无工具调用）`;
      }

      step.status = 'completed';
      step.result = result;
      step.completedAt = Date.now();
      step.actualDuration = step.completedAt - (step.startedAt ?? step.completedAt);
      this.consecutiveFailures = 0;

      // 记录执行日志
      const logEntry: ExecutionLogEntry = {
        stepId,
        action: step.description,
        result: result.substring(0, 500),
        success: true,
        timestamp: Date.now(),
        duration: step.actualDuration,
      };
      task.executionLog.push(logEntry);

      // 更新执行模式统计
      this.recordPattern(step.toolName || 'none', true, step.actualDuration);

      this.log.info('步骤执行成功', {
        stepId,
        duration: step.actualDuration,
        resultPreview: result.substring(0, 100),
      });
      this.eventBus.emitSync('task.step.complete', {
        taskId: task.id,
        stepId,
        duration: step.actualDuration,
      }, { source: 'TaskExecutionEngine' });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      step.error = errorMsg;
      step.retryCount++;
      this.consecutiveFailures++;

      this.log.warn('步骤执行失败', {
        stepId,
        error: errorMsg,
        retryCount: step.retryCount,
        consecutiveFailures: this.consecutiveFailures,
      });

      await this.handleStepFailure(stepId, errorMsg);
    }

    task.updatedAt = Date.now();
    this.saveTask(task);
  }

  /**
   * 处理步骤失败：重试、跳过或调整计划
   */
  handleStepFailure(stepId: string, error: string): Promise<void> {
    const task = this.getCurrentTask();
    if (!task) return Promise.resolve();

    const step = task.decomposedSteps.find(s => s.id === stepId);
    if (!step) return Promise.resolve();

    // 记录失败日志
    const logEntry: ExecutionLogEntry = {
      stepId,
      action: step.description,
      result: error,
      success: false,
      timestamp: Date.now(),
      duration: step.startedAt ? Date.now() - step.startedAt : 0,
    };
    task.executionLog.push(logEntry);

    // 更新执行模式统计
    this.recordPattern(step.toolName || 'none', false, logEntry.duration);

    // 判断步骤是否为关键步骤（有后续步骤依赖它）
    const isCritical = this.isStepCritical(task, stepId);

    if (isCritical) {
      // 关键步骤：重试直到达到上限
      if (step.retryCount < task.maxRetries) {
        this.log.info('关键步骤重试', { stepId, retryCount: step.retryCount, maxRetries: task.maxRetries });
        step.status = 'pending';
        step.error = undefined;
        this.eventBus.emitSync('task.step.retry', {
          taskId: task.id,
          stepId,
          retryCount: step.retryCount,
        }, { source: 'TaskExecutionEngine' });
      } else {
        // 重试次数耗尽，标记任务失败
        step.status = 'failed';
        step.completedAt = Date.now();
        task.status = 'failed';
        task.completedAt = Date.now();
        this.log.error('关键步骤失败且重试耗尽，任务标记为失败', { stepId, error });
        this.eventBus.emitSync('task.failed', {
          taskId: task.id,
          stepId,
          error,
        }, { source: 'TaskExecutionEngine' });
      }
    } else {
      // 非关键步骤：跳过并继续
      step.status = 'skipped';
      step.completedAt = Date.now();
      this.log.info('非关键步骤跳过', { stepId });
      this.eventBus.emitSync('task.step.skipped', {
        taskId: task.id,
        stepId,
      }, { source: 'TaskExecutionEngine' });
    }

    // 连续失败 2 次以上，建议调整计划
    if (this.consecutiveFailures >= 2) {
      this.log.warn('连续失败次数较多，建议调整执行计划', { consecutiveFailures: this.consecutiveFailures });
      this.eventBus.emitSync('task.adjustment.suggested', {
        taskId: task.id,
        consecutiveFailures: this.consecutiveFailures,
        reason: `连续 ${this.consecutiveFailures} 次步骤失败`,
      }, { source: 'TaskExecutionEngine' });
    }
    return Promise.resolve();
  }

  /**
   * 动态调整执行计划
   */
  adjustPlan(reason: string): void {
    const task = this.getCurrentTask();
    if (!task) return;

    const prevStatus = task.status;
    task.status = 'adjusting';
    this.log.info('开始调整执行计划', { taskId: task.id, reason });
    this.eventBus.emitSync('task.adjusting', {
      taskId: task.id,
      reason,
    }, { source: 'TaskExecutionEngine' });

    // 分析失败模式
    const failedSteps = task.decomposedSteps.filter(s => s.status === 'failed');
    const skippedSteps = task.decomposedSteps.filter(s => s.status === 'skipped');
    const pendingSteps = task.decomposedSteps.filter(s => s.status === 'pending');

    if (failedSteps.length === 0 && skippedSteps.length === 0) {
      // 没有失败步骤，恢复原状态
      task.status = prevStatus === 'adjusting' ? 'executing' : prevStatus;
      this.log.info('无需调整，恢复执行', { taskId: task.id });
      this.saveTask(task);
      return;
    }

    // 尝试为失败的步骤生成替代路径
    for (const failedStep of failedSteps) {
      if (failedStep.retryCount >= task.maxRetries) {
        // 已达重试上限，检查是否可以跳过
        if (!this.isStepCritical(task, failedStep.id)) {
          failedStep.status = 'skipped';
          this.log.info('调整：跳过失败的非关键步骤', { stepId: failedStep.id });
        } else {
          // 关键步骤无法跳过，尝试简化
          const alternativeStep = this.generateAlternativeStep(failedStep);
          if (alternativeStep) {
            // 插入替代步骤
            const insertIndex = task.decomposedSteps.indexOf(failedStep) + 1;
            task.decomposedSteps.splice(insertIndex, 0, alternativeStep);
            // 后续步骤的依赖关系更新
            this.updateDependenciesAfterInsert(task, failedStep.id, alternativeStep.id);
            failedStep.status = 'skipped';
            this.log.info('调整：插入替代步骤', { originalStepId: failedStep.id, alternativeStepId: alternativeStep.id });
          }
        }
      }
    }

    // 重置连续失败计数
    this.consecutiveFailures = 0;

    // 恢复执行状态
    task.status = 'executing';
    task.updatedAt = Date.now();
    this.saveTask(task);

    this.log.info('执行计划调整完成', {
      taskId: task.id,
      pendingSteps: pendingSteps.length,
      failedSteps: failedSteps.length,
      skippedSteps: skippedSteps.length,
    });
    this.eventBus.emitSync('task.adjusted', {
      taskId: task.id,
      reason,
      pendingCount: pendingSteps.length,
    }, { source: 'TaskExecutionEngine' });
  }

  /**
   * 注册任务模板
   */
  registerTemplate(template: TaskTemplate): void {
    const existing = this.templates.findIndex(t => t.name === template.name);
    if (existing >= 0) {
      this.templates[existing] = template;
      this.log.info('更新任务模板', { templateName: template.name });
    } else {
      this.templates.push(template);
      this.log.info('注册任务模板', { templateName: template.name });
    }
  }

  /**
   * 获取执行状态详情
   */
  getExecutionStatus(taskId: string): TaskExecution | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * 暂停当前执行
   */
  pauseExecution(): boolean {
    const task = this.getCurrentTask();
    if (!task || task.status !== 'executing') return false;

    task.status = 'paused';
    task.updatedAt = Date.now();
    this.saveTask(task);

    this.log.info('任务执行已暂停', { taskId: task.id });
    this.eventBus.emitSync('task.paused', { taskId: task.id }, { source: 'TaskExecutionEngine' });
    return true;
  }

  /**
   * 恢复执行
   */
  resumeExecution(): boolean {
    const task = this.getCurrentTask();
    if (!task || task.status !== 'paused') return false;

    task.status = 'executing';
    task.updatedAt = Date.now();
    this.saveTask(task);

    this.log.info('任务执行已恢复', { taskId: task.id });
    this.eventBus.emitSync('task.resumed', { taskId: task.id }, { source: 'TaskExecutionEngine' });
    return true;
  }

  /**
   * 计算成功分数（0-1）
   */
  calculateSuccessScore(taskId: string): number {
    const task = this.tasks.get(taskId);
    if (!task) return 0;

    const total = task.decomposedSteps.length;
    if (total === 0) return 0;

    const completed = task.decomposedSteps.filter(s => s.status === 'completed').length;
    const failed = task.decomposedSteps.filter(s => s.status === 'failed').length;
    const skipped = task.decomposedSteps.filter(s => s.status === 'skipped').length;

    // 权重：完成=1, 跳过=0.5, 失败=0
    const weightedScore = completed * 1 + skipped * 0.5 + failed * 0;
    const score = weightedScore / total;

    // 考虑重试惩罚
    const totalRetries = task.decomposedSteps.reduce((sum, s) => sum + s.retryCount, 0);
    const retryPenalty = Math.min(totalRetries * 0.05, 0.3);

    return Math.max(0, Math.min(1, score - retryPenalty));
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (params: any) => Promise<string>;
  }> {
    return [
      {
        name: 'task_execute',
        description: '规划并执行一个复杂目标，自动分解为步骤并逐步执行',
        parameters: {
          goal: { type: 'string', description: '要执行的复杂目标' },
          entities: { type: 'string', description: '实体参数 JSON 字符串，如 {"contact":"张三","message":"你好"}' },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (params: any) => {
          const goal = params.goal as string;
          let entities: Record<string, string> | undefined;
          if (params.entities) {
            try {
              entities = JSON.parse(params.entities as string);
            } catch {
              entities = undefined;
            }
          }
          const task = await this.planAndExecute(goal, entities);
          return JSON.stringify({
            taskId: task.id,
            status: task.status,
            successScore: task.successScore,
            steps: task.decomposedSteps.map(s => ({
              id: s.id,
              description: s.description,
              status: s.status,
              result: s.result?.substring(0, 200),
            })),
          }, null, 2);
        },
      },
      {
        name: 'task_status',
        description: '获取当前任务执行状态',
        parameters: {
          taskId: { type: 'string', description: '任务ID，不传则获取当前任务' },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: (params: any) => {
          const taskId = (params.taskId as string) || this.currentTaskId;
          if (!taskId) return Promise.resolve('没有活跃的任务');
          const task = this.getExecutionStatus(taskId);
          if (!task) return Promise.resolve(`任务 ${taskId} 不存在`);
          const score = this.calculateSuccessScore(taskId);
          return Promise.resolve(JSON.stringify({
            id: task.id,
            goal: task.originalGoal,
            status: task.status,
            currentStepIndex: task.currentStepIndex,
            successScore: score,
            steps: task.decomposedSteps.map(s => ({
              id: s.id,
              description: s.description,
              status: s.status,
              result: s.result?.substring(0, 100),
              error: s.error?.substring(0, 100),
            })),
            log: task.executionLog.slice(-5),
          }, null, 2));
        },
      },
      {
        name: 'task_adjust',
        description: '动态调整当前执行计划',
        parameters: {
          reason: { type: 'string', description: '调整原因' },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: (params: any) => {
          this.adjustPlan(params.reason as string);
          return Promise.resolve('执行计划已调整');
        },
      },
      {
        name: 'task_pause',
        description: '暂停当前任务执行',
        parameters: {},
        execute: () => {
          const paused = this.pauseExecution();
          return Promise.resolve(paused ? '任务已暂停' : '无法暂停（没有正在执行的任务）');
        },
      },
      {
        name: 'task_resume',
        description: '恢复暂停的任务执行',
        parameters: {},
        execute: () => {
          const resumed = this.resumeExecution();
          return Promise.resolve(resumed ? '任务已恢复执行' : '无法恢复（没有暂停的任务）');
        },
      },
    ];
  }

  // ============ 私有方法 ============

  private createTask(goal: string): TaskExecution {
    const task: TaskExecution = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      originalGoal: goal,
      decomposedSteps: [],
      currentStepIndex: 0,
      status: 'planning',
      executionLog: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
      maxRetries: this.config.maxRetries,
      successScore: 0,
    };
    this.tasks.set(task.id, task);
    this.saveTask(task);
    return task;
  }

  private getCurrentTask(): TaskExecution | null {
    if (!this.currentTaskId) return null;
    return this.tasks.get(this.currentTaskId) ?? null;
  }

  private instantiateTemplate(template: TaskTemplate, entities: Record<string, string>): ExecutionStep[] {
    return template.steps.map((step, index) => {
      // 替换模板中的 {entity} 占位符
      let argsStr = step.argsTemplate;
      for (const [key, value] of Object.entries(entities)) {
        argsStr = argsStr.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }

      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(argsStr);
      } catch {
        toolArgs = { raw: argsStr };
      }

      return {
        id: `step_${index + 1}`,
        description: step.description.replace(/\{(\w+)\}/g, (_, key) => entities[key] || `{${key}}`),
        toolName: step.toolName,
        toolArgs,
        status: 'pending' as const,
        retryCount: 0,
        dependencies: index > 0 ? [`step_${index}`] : [],
        estimatedDuration: 5000,
      };
    });
  }

  private ruleBasedDecompose(goal: string, entities?: Record<string, string>): ExecutionStep[] {
    const steps: ExecutionStep[] = [];

    // 基于关键词的简单分解规则
    const goalLower = goal.toLowerCase();

    if (goalLower.includes('搜索') || goalLower.includes('查找') || goalLower.includes('search')) {
      steps.push({
        id: 'step_1',
        description: `搜索: ${entities?.query || goal}`,
        toolName: 'search',
        toolArgs: { query: entities?.query || goal },
        status: 'pending',
        retryCount: 0,
        dependencies: [],
        estimatedDuration: 10000,
      });
    }

    if (goalLower.includes('总结') || goalLower.includes('概要') || goalLower.includes('summarize')) {
      steps.push({
        id: `step_${steps.length + 1}`,
        description: '总结内容',
        toolName: 'summarize',
        toolArgs: { content: '{previousResult}' },
        status: 'pending',
        retryCount: 0,
        dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
        estimatedDuration: 8000,
      });
    }

    if (goalLower.includes('修复') || goalLower.includes('fix') || goalLower.includes('修bug')) {
      steps.push({
        id: `step_${steps.length + 1}`,
        description: '分析问题',
        toolName: 'analyze',
        toolArgs: { target: entities?.filePath || goal },
        status: 'pending',
        retryCount: 0,
        dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
        estimatedDuration: 15000,
      });
      steps.push({
        id: `step_${steps.length + 1}`,
        description: '执行修复',
        toolName: 'fix',
        toolArgs: { target: entities?.filePath || goal },
        status: 'pending',
        retryCount: 0,
        dependencies: [steps[steps.length - 1].id],
        estimatedDuration: 20000,
      });
    }

    if (goalLower.includes('部署') || goalLower.includes('deploy')) {
      steps.push({
        id: `step_${steps.length + 1}`,
        description: '构建项目',
        toolName: 'build',
        toolArgs: { projectPath: entities?.projectPath || '.' },
        status: 'pending',
        retryCount: 0,
        dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
        estimatedDuration: 30000,
      });
      steps.push({
        id: `step_${steps.length + 1}`,
        description: '运行测试',
        toolName: 'test',
        toolArgs: { projectPath: entities?.projectPath || '.' },
        status: 'pending',
        retryCount: 0,
        dependencies: [steps[steps.length - 1].id],
        estimatedDuration: 20000,
      });
      steps.push({
        id: `step_${steps.length + 1}`,
        description: '部署到目标环境',
        toolName: 'deploy',
        toolArgs: { projectPath: entities?.projectPath || '.', environment: entities?.environment || 'production' },
        status: 'pending',
        retryCount: 0,
        dependencies: [steps[steps.length - 1].id],
        estimatedDuration: 60000,
      });
    }

    // 如果没有匹配到任何规则，创建一个通用执行步骤
    if (steps.length === 0) {
      steps.push({
        id: 'step_1',
        description: `执行目标: ${goal}`,
        toolName: 'execute',
        toolArgs: { goal, ...entities },
        status: 'pending',
        retryCount: 0,
        dependencies: [],
        estimatedDuration: 15000,
      });
    }

    return steps;
  }

  private findNextExecutableStep(task: TaskExecution): ExecutionStep | null {
    for (const step of task.decomposedSteps) {
      if (step.status !== 'pending') continue;

      // 检查依赖是否全部满足
      const depsSatisfied = step.dependencies.every(depId => {
        const dep = task.decomposedSteps.find(s => s.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'skipped');
      });

      if (depsSatisfied) return step;
    }
    return null;
  }

  private executeWithTimeout(toolName: string, args: unknown): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`工具 "${toolName}" 执行超时 (${this.config.stepTimeout}ms)`));
      }, this.config.stepTimeout);

      this.toolExecutor(toolName, args)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private isStepCritical(task: TaskExecution, stepId: string): boolean {
    // 检查是否有后续步骤依赖此步骤
    return task.decomposedSteps.some(
      s => s.dependencies.includes(stepId) && s.status === 'pending',
    );
  }

  private generateAlternativeStep(failedStep: ExecutionStep): ExecutionStep | null {
    // 简单的替代步骤生成策略
    if (!failedStep.toolName) return null;

    const alternativeToolMap: Record<string, { toolName: string; description: string }> = {
      search: { toolName: 'webSearch', description: `使用备用搜索: ${failedStep.description}` },
      build: { toolName: 'rebuild', description: `重新构建: ${failedStep.description}` },
      deploy: { toolName: 'rollbackDeploy', description: `回滚部署: ${failedStep.description}` },
    };

    const alternative = alternativeToolMap[failedStep.toolName];
    if (!alternative) return null;

    return {
      id: `step_alt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: alternative.description,
      toolName: alternative.toolName,
      toolArgs: failedStep.toolArgs,
      status: 'pending',
      retryCount: 0,
      dependencies: failedStep.dependencies,
      estimatedDuration: failedStep.estimatedDuration,
    };
  }

  private updateDependenciesAfterInsert(task: TaskExecution, oldStepId: string, newStepId: string): void {
    for (const step of task.decomposedSteps) {
      const idx = step.dependencies.indexOf(oldStepId);
      if (idx >= 0) {
        step.dependencies[idx] = newStepId;
      }
    }
  }

  private finalizeTask(task: TaskExecution): void {
    const hasFailed = task.decomposedSteps.some(s => s.status === 'failed');
    task.status = hasFailed ? 'failed' : 'completed';
    task.completedAt = Date.now();
    task.successScore = this.calculateSuccessScore(task.id);
    task.updatedAt = Date.now();

    this.log.info('任务执行完成', {
      taskId: task.id,
      status: task.status,
      successScore: task.successScore,
      totalSteps: task.decomposedSteps.length,
      completedSteps: task.decomposedSteps.filter(s => s.status === 'completed').length,
      failedSteps: task.decomposedSteps.filter(s => s.status === 'failed').length,
      skippedSteps: task.decomposedSteps.filter(s => s.status === 'skipped').length,
    });

    this.eventBus.emitSync('task.completed', {
      taskId: task.id,
      status: task.status,
      successScore: task.successScore,
    }, { source: 'TaskExecutionEngine' });

    this.saveTask(task);
  }

  private syncToPlanner(task: TaskExecution): void {
    try {
      const planSteps = task.decomposedSteps.map((step, _index) => ({
        description: step.description,
        dependencies: step.dependencies
          .map(depId => {
            const depIndex = task.decomposedSteps.findIndex(s => s.id === depId);
            return depIndex >= 0 ? depIndex + 1 : 0;
          })
          .filter(d => d > 0),
      }));

      this.taskPlanner.createPlan(task.originalGoal, task.originalGoal, planSteps);
    } catch (err: unknown) {
      this.log.warn('同步到 TaskPlanner 失败', { error: err });
    }
  }

  private recordPattern(toolName: string, success: boolean, duration: number): void {
    const existing = this.executionPatterns.get(toolName);
    if (existing) {
      const totalSamples = existing.sampleCount + 1;
      const newSuccessRate = (existing.successRate * existing.sampleCount + (success ? 1 : 0)) / totalSamples;
      const newAvgDuration = (existing.avgDuration * existing.sampleCount + duration) / totalSamples;
      this.executionPatterns.set(toolName, {
        successRate: newSuccessRate,
        avgDuration: newAvgDuration,
        sampleCount: totalSamples,
      });
    } else {
      this.executionPatterns.set(toolName, {
        successRate: success ? 1 : 0,
        avgDuration: duration,
        sampleCount: 1,
      });
    }
  }

  // ============ 持久化 ============

  private saveTask(task: TaskExecution): void {
    if (!this.config.autoSave) return;
    try {
      const filePath = path.join(this.config.persistenceDir, `${task.id}.json`);
      fs.mkdirSync(this.config.persistenceDir, { recursive: true });
      atomicWriteJsonSync(filePath, task);
    } catch (err: unknown) {
      this.log.error('保存任务状态失败', { taskId: task.id, error: err });
    }
  }

  private loadTasks(): void {
    try {
      if (!fs.existsSync(this.config.persistenceDir)) return;
      const files = fs.readdirSync(this.config.persistenceDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.config.persistenceDir, file), 'utf-8')) as TaskExecution;
          this.tasks.set(data.id, data);
          // 恢复未完成的任务为当前任务
          if (data.status === 'executing' || data.status === 'paused') {
            this.currentTaskId = data.id;
          }
        } catch {
          // 跳过损坏的文件
        }
      }
      if (this.tasks.size > 0) {
        this.log.info('加载持久化任务', { taskCount: this.tasks.size });
      }
    } catch (err: unknown) {
      this.log.warn('加载任务失败', { error: err });
    }
  }

  // ============ 辅助方法 ============

  getAllTasks(): TaskExecution[] {
    this.ensureTasksLoaded();
    return Array.from(this.tasks.values());
  }

  getActiveTasks(): TaskExecution[] {
    this.ensureTasksLoaded();
    return Array.from(this.tasks.values()).filter(
      t => t.status === 'executing' || t.status === 'paused' || t.status === 'planning',
    );
  }

  getTemplates(): TaskTemplate[] {
    return [...this.templates];
  }

  getExecutionPatterns(): Map<string, { successRate: number; avgDuration: number; sampleCount: number }> {
    return new Map(this.executionPatterns);
  }

  deleteTask(taskId: string): boolean {
    const deleted = this.tasks.delete(taskId);
    if (deleted) {
      try {
        const filePath = path.join(this.config.persistenceDir, `${taskId}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // 忽略删除失败
      }
      if (this.currentTaskId === taskId) {
        this.currentTaskId = null;
      }
    }
    return deleted;
  }
}
