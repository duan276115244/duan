import { errMsg } from './utils.js';
/**
 * 协同工作系统
 * 提供多任务并行处理、跨应用集成、工作流定制和状态跟踪
 */

/** 工作流步骤 */
export interface WorkflowStep {
  id: string;
  name: string;
  type: 'input' | 'process' | 'output' | 'decision' | 'parallel' | 'loop';
  config: Record<string, unknown>;
  nextSteps: string[];         // 下一步骤ID
  condition?: string;          // 条件表达式
  timeout?: number;            // 超时(ms)
  retryCount?: number;        // 重试次数
}

/** 工作流定义 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  variables: Record<string, unknown>; // 工作流变量
  createdAt: number;
  updatedAt: number;
}

/** 工作流执行状态 */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  currentStepId: string;
  completedSteps: string[];
  variables: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  error?: string;
  results: Map<string, unknown>;
}

/** 任务定义 */
export interface Task {
  id: string;
  name: string;
  type: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  dependencies: string[];      // 依赖的任务ID
  assignedAgent: string;       // 分配的Agent
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  subtasks: string[];          // 子任务ID
  parentTaskId?: string;       // 父任务ID
}

/** 资源调度信息 */
export interface ResourceAllocation {
  agentId: string;
  currentTasks: number;
  maxTasks: number;
  capabilities: string[];
  utilization: number;         // 0-1
}

export class CollaborativeWorkspace {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private executions: Map<string, WorkflowExecution> = new Map();
  private tasks: Map<string, Task> = new Map();
  private agents: Map<string, ResourceAllocation> = new Map();
  private taskQueue: Task[] = [];

  constructor() {
    this.initializeAgents();
    this.initializeWorkflows();
  }

  /** 初始化Agent资源 */
  private initializeAgents(): void {
    const agentList: ResourceAllocation[] = [
      { agentId: '段先生', currentTasks: 0, maxTasks: 5, capabilities: ['general', 'coordination', 'reasoning'], utilization: 0 },
      { agentId: '开发者', currentTasks: 0, maxTasks: 3, capabilities: ['coding', 'debugging', 'reviewing'], utilization: 0 },
      { agentId: '设计师', currentTasks: 0, maxTasks: 2, capabilities: ['design', 'ux', 'creative'], utilization: 0 },
      { agentId: '研究员', currentTasks: 0, maxTasks: 3, capabilities: ['research', 'analysis', 'web_search'], utilization: 0 },
      { agentId: '分析师', currentTasks: 0, maxTasks: 3, capabilities: ['data_analysis', 'visualization', 'statistics'], utilization: 0 },
      { agentId: '文案师', currentTasks: 0, maxTasks: 2, capabilities: ['writing', 'translation', 'editing'], utilization: 0 },
      { agentId: '规划师', currentTasks: 0, maxTasks: 2, capabilities: ['planning', 'scheduling', 'risk_assessment'], utilization: 0 },
    ];

    for (const agent of agentList) {
      this.agents.set(agent.agentId, agent);
    }
  }

  /** 初始化预置工作流 */
  private initializeWorkflows(): void {
    // 代码开发工作流
    this.workflows.set('code_dev', {
      id: 'code_dev',
      name: '代码开发工作流',
      description: '从需求分析到代码部署的完整开发流程',
      steps: [
        { id: 'req_analysis', name: '需求分析', type: 'process', config: { agent: '规划师' }, nextSteps: ['design'] },
        { id: 'design', name: '方案设计', type: 'process', config: { agent: '开发者' }, nextSteps: ['code_review'] },
        { id: 'code_review', name: '代码审查', type: 'decision', config: { agent: '开发者' }, nextSteps: ['implement', 'design'], condition: 'review_passed' },
        { id: 'implement', name: '代码实现', type: 'process', config: { agent: '开发者' }, nextSteps: ['test'] },
        { id: 'test', name: '测试验证', type: 'process', config: { agent: '开发者' }, nextSteps: ['deploy'] },
        { id: 'deploy', name: '部署上线', type: 'output', config: { agent: '开发者' }, nextSteps: [] },
      ],
      variables: { project_name: '', requirements: '' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 研究分析工作流
    this.workflows.set('research', {
      id: 'research',
      name: '研究分析工作流',
      description: '从问题定义到报告输出的研究流程',
      steps: [
        { id: 'problem_def', name: '问题定义', type: 'input', config: { agent: '研究员' }, nextSteps: ['literature'] },
        { id: 'literature', name: '文献调研', type: 'parallel', config: { agent: '研究员', parallelTasks: ['web_search', 'knowledge_query'] }, nextSteps: ['analysis'] },
        { id: 'analysis', name: '深度分析', type: 'process', config: { agent: '分析师' }, nextSteps: ['report'] },
        { id: 'report', name: '报告撰写', type: 'output', config: { agent: '文案师' }, nextSteps: [] },
      ],
      variables: { topic: '', depth: 'standard' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 产品设计工作流
    this.workflows.set('product_design', {
      id: 'product_design',
      name: '产品设计工作流',
      description: '从用户需求到设计方案的完整设计流程',
      steps: [
        { id: 'user_research', name: '用户研究', type: 'process', config: { agent: '研究员' }, nextSteps: ['ideation'] },
        { id: 'ideation', name: '创意构思', type: 'parallel', config: { agent: '设计师', parallelTasks: ['brainstorm', 'competitor_analysis'] }, nextSteps: ['prototype'] },
        { id: 'prototype', name: '原型设计', type: 'process', config: { agent: '设计师' }, nextSteps: ['review'] },
        { id: 'review', name: '设计评审', type: 'decision', config: { agent: '设计师' }, nextSteps: ['deliver', 'prototype'], condition: 'approved' },
        { id: 'deliver', name: '交付输出', type: 'output', config: { agent: '设计师' }, nextSteps: [] },
      ],
      variables: { product_name: '', target_users: '' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** 创建任务 */
  createTask(name: string, type: string, priority: Task['priority'], input: Record<string, unknown>, dependencies: string[] = [], assignedAgent?: string): Task {
    const task: Task = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name,
      type,
      priority,
      status: 'pending',
      dependencies,
      assignedAgent: assignedAgent || this.selectBestAgent(type),
      input,
      createdAt: Date.now(),
      subtasks: [],
    };

    this.tasks.set(task.id, task);
    this.taskQueue.push(task);
    this.sortTaskQueue();

    return task;
  }

  /** 选择最佳Agent */
  private selectBestAgent(taskType: string): string {
    let bestAgent = '段先生';
    let bestScore = 0;

    for (const [agentId, allocation] of this.agents) {
      if (allocation.currentTasks >= allocation.maxTasks) continue;

      const capabilityMatch = allocation.capabilities.includes(taskType) ? 1 : 0;
      const availability = 1 - allocation.utilization;
      const score = capabilityMatch * 0.7 + availability * 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agentId;
      }
    }

    return bestAgent;
  }

  /** 排序任务队列（按优先级） */
  private sortTaskQueue(): void {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    this.taskQueue.sort((a, b) => {
      // 先检查依赖
      const aDepsMet = a.dependencies.every(d => { const dep = this.tasks.get(d); return dep && dep.status === 'completed'; });
      const bDepsMet = b.dependencies.every(d => { const dep = this.tasks.get(d); return dep && dep.status === 'completed'; });
      if (aDepsMet !== bDepsMet) return aDepsMet ? -1 : 1;
      // 再按优先级
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /** 并行执行多个独立任务 */
  async executeParallel(taskIds: string[]): Promise<Map<string, { success: boolean; result?: unknown; error?: string }>> {
    const results = new Map<string, { success: boolean; result?: unknown; error?: string }>();

    // 检查依赖是否满足
    const readyTasks = taskIds.filter(id => {
      const task = this.tasks.get(id);
      if (!task) return false;
      return task.dependencies.every(d => { const dep = this.tasks.get(d); return dep && dep.status === 'completed'; });
    });

    // 并行执行
    const promises = readyTasks.map(async (id) => {
      const task = this.tasks.get(id)!;
      task.status = 'running';
      task.startedAt = Date.now();

      try {
        // 模拟任务执行
        const result = await this.executeTask(task);
        task.status = 'completed';
        task.completedAt = Date.now();
        task.output = result as Record<string, unknown>;
        results.set(id, { success: true, result });
      } catch (error: unknown) {
        task.status = 'failed';
        task.error = errMsg(error);
        results.set(id, { success: false, error: task.error });
      }
    });

    await Promise.all(promises);
    return results;
  }

  /** 执行单个任务 */
  private executeTask(task: Task): Promise<unknown> {
    // 根据任务类型执行
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ taskId: task.id, type: task.type, agent: task.assignedAgent, completed: true });
      }, 100); // 模拟执行时间
    });
  }

  /** 启动工作流 */
  startWorkflow(workflowId: string, variables?: Record<string, unknown>): WorkflowExecution {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`工作流 ${workflowId} 不存在`);

    const execution: WorkflowExecution = {
      id: `exec_${Date.now()}`,
      workflowId,
      status: 'running',
      currentStepId: workflow.steps[0]?.id || '',
      completedSteps: [],
      variables: { ...workflow.variables, ...variables },
      startTime: Date.now(),
      results: new Map(),
    };

    this.executions.set(execution.id, execution);
    return execution;
  }

  /** 获取工作流执行状态 */
  getExecutionStatus(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  /** 获取所有工作流 */
  getWorkflows(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }

  /** 获取任务状态 */
  getTaskStatus(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** 获取所有任务 */
  getAllTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /** 获取Agent资源状态 */
  getAgentStatus(): ResourceAllocation[] {
    return [...this.agents.values()];
  }

  /** 获取任务队列 */
  getTaskQueue(): Task[] {
    return this.taskQueue.filter(t => t.status === 'pending');
  }

  /** 创建自定义工作流 */
  createWorkflow(name: string, description: string, steps: WorkflowStep[]): WorkflowDefinition {
    const workflow: WorkflowDefinition = {
      id: `wf_${Date.now()}`,
      name,
      description,
      steps,
      variables: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  /** 生成工作区报告 */
  generateReport(): { totalWorkflows: number; activeExecutions: number; totalTasks: number; pendingTasks: number; agentUtilization: Record<string, number> } {
    return {
      totalWorkflows: this.workflows.size,
      activeExecutions: [...this.executions.values()].filter(e => e.status === 'running').length,
      totalTasks: this.tasks.size,
      pendingTasks: this.taskQueue.filter(t => t.status === 'pending').length,
      agentUtilization: Object.fromEntries([...this.agents.values()].map(a => [a.agentId, Math.round(a.utilization * 100)])),
    };
  }
}
