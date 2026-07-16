/**
 * 异步任务托管管理器 — AsyncTaskManager
 *
 * 对标 Devin 的异步任务托管模式：
 * 1. 任务队列：提交任务到后台队列，立即返回 task-id，异步执行
 * 2. 进度追踪：实时更新状态 + 进度百分比 + 日志流
 * 3. 结果通知：任务完成时通过通道发送通知
 * 4. 中断恢复：进程重启后加载未完成任务
 * 5. 并行任务：多个异步任务并行执行
 * 6. 任务模板：预定义常见异步任务模板
 *
 * 核心理念：用户可以"分配任务后去做别的"，适合长耗时任务
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteJsonSync } from './atomic-write.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** 任务优先级 */
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** 异步任务 */
export interface AsyncTask {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description: string;
  /** 任务类型 */
  type: string;
  /** 状态 */
  status: TaskStatus;
  /** 优先级 */
  priority: TaskPriority;
  /** 创建时间 */
  createdAt: number;
  /** 开始时间 */
  startedAt: number | null;
  /** 完成时间 */
  completedAt: number | null;
  /** 进度（0-100） */
  progress: number;
  /** 日志条目 */
  logs: TaskLogEntry[];
  /** 结果（任务完成后） */
  result: unknown;
  /** 错误信息（任务失败时） */
  error: string | null;
  /** 任务参数 */
  params: Record<string, unknown>;
  /** 通知通道（完成后通知） */
  notifyChannels: string[];
  /** 标签 */
  tags: string[];
}

/** 任务日志条目 */
export interface TaskLogEntry {
  /** 时间戳 */
  timestamp: number;
  /** 日志级别 */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** 日志消息 */
  message: string;
  /** 附加数据 */
  data?: Record<string, unknown>;
}

/** 任务执行器函数 */
export type TaskExecutor = (task: AsyncTask, context: TaskExecutionContext) => Promise<unknown>;

/** 任务执行上下文 */
export interface TaskExecutionContext {
  /** 更新进度 */
  updateProgress: (progress: number) => void;
  /** 记录日志 */
  log: (level: TaskLogEntry['level'], message: string, data?: Record<string, unknown>) => void;
  /** 检查是否被取消 */
  isCancelled: () => boolean;
  /** 任务参数 */
  params: Record<string, unknown>;
}

/** 任务模板 */
export interface TaskTemplate {
  /** 模板名 */
  name: string;
  /** 显示标题 */
  title: string;
  /** 描述 */
  description: string;
  /** 任务类型 */
  type: string;
  /** 默认参数 */
  defaultParams: Record<string, unknown>;
  /** 默认优先级 */
  defaultPriority: TaskPriority;
  /** 默认通知通道 */
  defaultNotifyChannels: string[];
}

/** 通知发送器 */
export type NotificationSender = (channel: string, title: string, message: string) => Promise<void>;

// ============ 异步任务管理器 ============

export class AsyncTaskManager {
  /** 任务存储目录 */
  private dataDir: string;
  /** 任务映射表（id → task） */
  private tasks: Map<string, AsyncTask> = new Map();
  /** 任务执行器映射表（type → executor） */
  private executors: Map<string, TaskExecutor> = new Map();
  /** 运行中的任务 Promise 映射表 */
  private runningPromises: Map<string, Promise<unknown>> = new Map();
  /** 取消标志映射表 */
  private cancelFlags: Map<string, boolean> = new Map();
  /** 通知发送器 */
  private notifier: NotificationSender | null = null;
  /** 最大并行任务数 */
  private maxConcurrent: number;
  /** 当前运行中的任务数 */
  private runningCount: number = 0;
  /** 任务队列（等待执行） */
  private queue: string[] = [];
  /** 内置任务模板 */
  private templates: Map<string, TaskTemplate> = new Map();

  constructor(options?: { dataDir?: string; maxConcurrent?: number }) {
    this.dataDir = options?.dataDir ?? duanPath('async-tasks');
    this.maxConcurrent = options?.maxConcurrent ?? 3;
    this.ensureDataDir();
    this.loadTasks();
    this.registerBuiltinTemplates();
  }

  // ============ 任务管理 ============

  /**
   * 提交新任务
   * @param title       任务标题
   * @param description 任务描述
   * @param type        任务类型
   * @param params      任务参数
   * @param options     额外选项
   * @returns 任务 ID
   */
  submitTask(
    title: string,
    description: string,
    type: string,
    params: Record<string, unknown> = {},
    options?: {
      priority?: TaskPriority;
      notifyChannels?: string[];
      tags?: string[];
    },
  ): string {
    const id = `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const task: AsyncTask = {
      id,
      title,
      description,
      type,
      status: 'pending',
      priority: options?.priority ?? 'medium',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      progress: 0,
      logs: [],
      result: null,
      error: null,
      params,
      notifyChannels: options?.notifyChannels ?? [],
      tags: options?.tags ?? [],
    };

    this.tasks.set(id, task);
    this.queue.push(id);
    this.saveTasks();
    this.processQueue();

    return id;
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    if (task.status === 'running') {
      this.cancelFlags.set(taskId, true);
    }

    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.addLog(taskId, 'info', '任务已取消');
    this.saveTasks();
    return true;
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): AsyncTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 列出所有任务
   */
  listTasks(filter?: {
    status?: TaskStatus;
    type?: string;
    priority?: TaskPriority;
    tag?: string;
  }): AsyncTask[] {
    let result = [...this.tasks.values()];
    if (filter?.status) result = result.filter((t) => t.status === filter.status);
    if (filter?.type) result = result.filter((t) => t.type === filter.type);
    if (filter?.priority) result = result.filter((t) => t.priority === filter.priority);
    if (filter?.tag) result = result.filter((t) => t.tags.includes(filter.tag!));
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取任务日志
   */
  getTaskLogs(taskId: string): TaskLogEntry[] {
    const task = this.tasks.get(taskId);
    return task?.logs ?? [];
  }

  /**
   * 删除任务
   */
  deleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') return false; // 运行中不能删除
    this.tasks.delete(taskId);
    this.saveTasks();
    return true;
  }

  // ============ 执行器注册 ============

  /**
   * 注册任务执行器
   */
  registerExecutor(type: string, executor: TaskExecutor): void {
    this.executors.set(type, executor);
  }

  /**
   * 注册通知发送器
   */
  registerNotifier(sender: NotificationSender): void {
    this.notifier = sender;
  }

  // ============ 任务模板 ============

  /**
   * 注册任务模板
   */
  registerTemplate(template: TaskTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * 列出所有模板
   */
  listTemplates(): TaskTemplate[] {
    return [...this.templates.values()];
  }

  /**
   * 从模板创建任务
   */
  submitFromTemplate(templateName: string, params?: Record<string, unknown>, options?: {
    priority?: TaskPriority;
    notifyChannels?: string[];
    tags?: string[];
  }): string | null {
    const template = this.templates.get(templateName);
    if (!template) return null;

    const mergedParams = { ...template.defaultParams, ...params };
    const id = this.submitTask(
      template.title,
      template.description,
      template.type,
      mergedParams,
      {
        priority: options?.priority ?? template.defaultPriority,
        notifyChannels: options?.notifyChannels ?? template.defaultNotifyChannels,
        tags: options?.tags ?? [],
      },
    );
    return id;
  }

  // ============ 内部实现 ============

  /** 处理任务队列 */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const taskId = this.queue.shift();
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'pending') continue;

      // 检查是否有对应的执行器
      const executor = this.executors.get(task.type);
      if (!executor) {
        task.status = 'failed';
        task.error = `未注册任务类型 "${task.type}" 的执行器`;
        task.completedAt = Date.now();
        this.addLog(taskId, 'error', `无执行器: ${task.type}`);
        this.saveTasks();
        continue;
      }

      // 启动任务
      this.runningCount++;
      task.status = 'running';
      task.startedAt = Date.now();
      this.cancelFlags.set(taskId, false);
      this.addLog(taskId, 'info', '任务开始执行');
      this.saveTasks();

      // 异步执行
      const promise = this.executeTask(task, executor);
      this.runningPromises.set(taskId, promise);

      promise.finally(() => {
        this.runningCount--;
        this.runningPromises.delete(taskId);
        this.cancelFlags.delete(taskId);
        this.processQueue();
      });
    }
  }

  /** 执行单个任务 */
  private async executeTask(task: AsyncTask, executor: TaskExecutor): Promise<void> {
    const context: TaskExecutionContext = {
      updateProgress: (progress: number) => {
        task.progress = Math.max(0, Math.min(100, progress));
        this.saveTasks();
      },
      log: (level, message, data) => {
        this.addLog(task.id, level, message, data);
      },
      isCancelled: () => this.cancelFlags.get(task.id) ?? false,
      params: task.params,
    };

    try {
      const result = await executor(task, context);

      if (this.cancelFlags.get(task.id)) {
        task.status = 'cancelled';
      } else {
        task.status = 'completed';
        task.result = result;
        task.progress = 100;
        this.addLog(task.id, 'info', '任务完成');
      }
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      this.addLog(task.id, 'error', `任务失败: ${task.error}`);
    }

    task.completedAt = Date.now();
    this.saveTasks();

    // 发送通知
    if (task.notifyChannels.length > 0 && this.notifier) {
      const title = `任务${task.status === 'completed' ? '完成' : '失败'}: ${task.title}`;
      const message = task.status === 'completed'
        ? `任务 "${task.title}" 已成功完成`
        : `任务 "${task.title}" 失败: ${task.error ?? '未知错误'}`;
      for (const channel of task.notifyChannels) {
        try {
          await this.notifier(channel, title, message);
        } catch {
          // 通知失败不影响任务
        }
      }
    }
  }

  /** 添加日志 */
  private addLog(taskId: string, level: TaskLogEntry['level'], message: string, data?: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.logs.push({
      timestamp: Date.now(),
      level,
      message,
      data,
    });
    // 限制日志数量
    if (task.logs.length > 500) {
      task.logs = task.logs.slice(-250);
    }
  }

  // ============ 持久化 ============

  /** 确保数据目录存在 */
  private ensureDataDir(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch {
      // 创建失败时使用临时目录
      this.dataDir = path.join(os.tmpdir(), 'duan-async-tasks');
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    }
  }

  /** 加载任务 */
  private loadTasks(): void {
    try {
      const filePath = path.join(this.dataDir, 'tasks.json');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as AsyncTask[];

      for (const task of data) {
        // 运行中的任务标记为 interrupted
        if (task.status === 'running') {
          task.status = 'interrupted';
          task.error = '进程重启，任务被中断';
          task.completedAt = Date.now();
        }
        this.tasks.set(task.id, task);
      }
    } catch {
      // 加载失败忽略
    }
  }

  /** 保存任务 */
  private saveTasks(): void {
    try {
      const filePath = path.join(this.dataDir, 'tasks.json');
      const data = [...this.tasks.values()].slice(-100); // 最多保存 100 个任务
      atomicWriteJsonSync(filePath, data);
    } catch {
      // 保存失败忽略
    }
  }

  /** 注册内置任务模板 */
  private registerBuiltinTemplates(): void {
    const templates: TaskTemplate[] = [
      {
        name: 'code-review',
        title: '代码审查',
        description: '对指定文件或目录进行代码审查，输出审查报告',
        type: 'code-review',
        defaultParams: { target: '', strictness: 'normal' },
        defaultPriority: 'medium',
        defaultNotifyChannels: [],
      },
      {
        name: 'batch-test',
        title: '批量测试',
        description: '批量运行测试套件，收集结果并生成报告',
        type: 'batch-test',
        defaultParams: { testCommand: 'npm test', reportFormat: 'json' },
        defaultPriority: 'high',
        defaultNotifyChannels: [],
      },
      {
        name: 'doc-generation',
        title: '文档生成',
        description: '扫描代码并生成 API 文档',
        type: 'doc-generation',
        defaultParams: { sourceDir: 'src', outputDir: 'docs' },
        defaultPriority: 'low',
        defaultNotifyChannels: [],
      },
      {
        name: 'large-refactor',
        title: '大规模重构',
        description: '执行大规模代码重构任务',
        type: 'large-refactor',
        defaultParams: { target: '', rules: [] },
        defaultPriority: 'high',
        defaultNotifyChannels: [],
      },
    ];

    for (const template of templates) {
      this.templates.set(template.name, template);
    }
  }

  // ============ 统计 ============

  /** 获取统计信息 */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    interrupted: number;
  } {
    const tasks = [...this.tasks.values()];
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      running: tasks.filter((t) => t.status === 'running').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      interrupted: tasks.filter((t) => t.status === 'interrupted').length,
    };
  }

  /** 清理已完成任务 */
  cleanupCompleted(): number {
    let cleaned = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id);
        cleaned++;
      }
    }
    this.saveTasks();
    return cleaned;
  }
}

// ============ LLM 工具定义 ============

/** 异步任务管理 LLM 工具定义 */
export function getAsyncTaskToolDefinitions() {
  return [
    {
      name: 'async_task_submit',
      description: '提交异步任务到后台队列执行（立即返回 task-id，不阻塞会话）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务描述' },
          type: { type: 'string', description: '任务类型（如 code-review, batch-test, doc-generation）' },
          params: { type: 'object', description: '任务参数' },
          priority: { type: 'string', description: '优先级: low/medium/high/urgent' },
          notifyChannels: { type: 'array', items: { type: 'string' }, description: '完成后通知的通道' },
        },
        required: ['title', 'type'],
      },
    },
    {
      name: 'async_task_status',
      description: '查询异步任务状态和进度',
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'async_task_list',
      description: '列出异步任务（可按状态过滤）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', description: '按状态过滤: pending/running/completed/failed/cancelled/interrupted' },
          type: { type: 'string', description: '按类型过滤' },
        },
      },
    },
    {
      name: 'async_task_cancel',
      description: '取消异步任务',
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'async_task_logs',
      description: '获取异步任务的日志',
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'async_task_templates',
      description: '列出可用的任务模板',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'async_task_stats',
      description: '获取异步任务统计信息',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ];
}

/** 异步任务工具处理器 */
export function createAsyncTaskToolHandler(manager: AsyncTaskManager) {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'async_task_submit': {
        const { title, description, type, params, priority, notifyChannels } = args as {
          title: string;
          description?: string;
          type: string;
          params?: Record<string, unknown>;
          priority?: TaskPriority;
          notifyChannels?: string[];
        };
        const id = manager.submitTask(
          title,
          description ?? '',
          type,
          params ?? {},
          { priority, notifyChannels },
        );
        return { taskId: id, submitted: true };
      }
      case 'async_task_status': {
        const { taskId } = args as { taskId: string };
        const task = manager.getTask(taskId);
        if (!task) return { error: '任务不存在' };
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          progress: task.progress,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          error: task.error,
        };
      }
      case 'async_task_list': {
        const { status, type } = args as { status?: TaskStatus; type?: string };
        const tasks = manager.listTasks({ status, type });
        return tasks.map((t) => ({
          id: t.id,
          title: t.title,
          type: t.type,
          status: t.status,
          priority: t.priority,
          progress: t.progress,
          createdAt: t.createdAt,
        }));
      }
      case 'async_task_cancel': {
        const { taskId } = args as { taskId: string };
        const cancelled = manager.cancelTask(taskId);
        return { cancelled, taskId };
      }
      case 'async_task_logs': {
        const { taskId } = args as { taskId: string };
        return manager.getTaskLogs(taskId);
      }
      case 'async_task_templates': {
        return manager.listTemplates();
      }
      case 'async_task_stats': {
        return manager.getStats();
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
