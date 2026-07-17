/**
 * 任务管理器 — 对标 Claude Code TodoWrite
 *
 * v21.3 新功能：让 agent 在执行复杂多步骤任务时创建、更新、查询待办事项列表，
 * 跟踪进度并向用户展示清晰的工作计划。
 *
 * 设计要点：
 *   - 持久化：duanPath('tasks')/tasks.json，使用 atomicWriteJsonSync 原子写入
 *   - 节流保存：200ms 防抖，避免频繁磁盘 I/O
 *   - 单 in_progress 约束：同一时间只能有一个任务处于 in_progress，
 *     新设为 in_progress 时自动将其他 in_progress 任务回退为 pending
 *   - 单例：通过 getTaskManager() 获取全局实例，resetTaskManager() 用于测试重置
 *   - dispose：清理 saveTimer + 强制落盘 + 移除 process.once('exit') 监听器
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type TaskPriority = 'high' | 'medium' | 'low';

export interface Task {
  id: string;                    // 唯一 ID（task-{timestamp}-{random}）
  content: string;               // 任务描述
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;          // 标记 completed 时填写
  parentId?: string;             // 支持子任务层级
  summary?: string;              // 完成时的总结
}

export interface TaskStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  highPriority: number;
}

export interface TaskProgress {
  completed: number;
  total: number;
  percentage: number;
}

// ============ 常量 ============

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
const SAVE_DEBOUNCE_MS = 200;

// ============ TaskManager ============

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private dataPath: string;

  // —— 节流写盘状态 ——
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // 保存 exit 监听器引用以便 dispose 时移除（避免测试中累积监听器）
  private readonly exitListener: () => void;

  constructor(dataPath?: string) {
    this.dataPath = dataPath || path.join(duanPath('tasks'), 'tasks.json');
    // 目录不存在时自动创建（recursive 模式幂等）
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    this.load();
    // 进程退出时确保未写入的变更被持久化
    this.exitListener = () => this.flush();
    process.once('exit', this.exitListener);
  }

  // ============ ID 生成 ============

  private generateId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  // ============ 持久化 ============

  /** 从磁盘加载数据（覆盖内存中的任务列表） */
  load(): void {
    this.tasks.clear();
    try {
      const raw = fs.readFileSync(this.dataPath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const t of data) {
          if (t && typeof t.id === 'string') {
            this.tasks.set(t.id, t as Task);
          }
        }
      }
    } catch {
      // 文件不存在或损坏 — 视为空数据
    }
  }

  /** 实际的同步写盘动作（仅由 flush 调用） */
  private writeToDisk(): void {
    atomicWriteJsonSync(this.dataPath, Array.from(this.tasks.values()));
  }

  /**
   * 标记数据已变更并安排一次防抖异步写盘。
   * 200ms 内的多次变更只会触发一次写盘，避免 I/O 放大。
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 立即将待写入的变更落盘（取消挂起的防抖定时器） */
  private flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.writeToDisk();
    this.dirty = false;
  }

  /** 公开同步落盘 API（用于测试或显式同步场景） */
  save(): void {
    this.flush();
  }

  // ============ 核心操作 ============

  addTask(content: string, priority: TaskPriority = 'medium'): Task {
    const now = Date.now();
    const task: Task = {
      id: this.generateId(),
      content,
      status: 'pending',
      priority,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.scheduleSave();
    return task;
  }

  updateTask(
    id: string,
    updates: Partial<Pick<Task, 'content' | 'status' | 'priority' | 'summary'>>,
  ): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;

    // 单 in_progress 约束：将某任务设为 in_progress 时，
    // 自动将其他处于 in_progress 的任务回退为 pending
    if (updates.status === 'in_progress' && task.status !== 'in_progress') {
      for (const other of this.tasks.values()) {
        if (other.id !== id && other.status === 'in_progress') {
          other.status = 'pending';
          other.updatedAt = Date.now();
        }
      }
    }

    if (updates.content !== undefined) task.content = updates.content;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.summary !== undefined) task.summary = updates.summary;

    // 标记 completed 时设置 completedAt（仅首次）
    if (updates.status === 'completed' && task.completedAt === undefined) {
      task.completedAt = Date.now();
    }
    // 从 completed 回退到其他状态时清除 completedAt
    if (
      updates.status !== undefined &&
      updates.status !== 'completed' &&
      task.completedAt !== undefined
    ) {
      delete task.completedAt;
    }

    task.updatedAt = Date.now();
    this.scheduleSave();
    return task;
  }

  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  getTask(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  // ============ 批量操作 ============

  clearCompleted(): number {
    let cleared = 0;
    for (const [id, t] of this.tasks) {
      if (t.status === 'completed') {
        this.tasks.delete(id);
        cleared++;
      }
    }
    if (cleared > 0) this.scheduleSave();
    return cleared;
  }

  clearAll(): number {
    const count = this.tasks.size;
    this.tasks.clear();
    if (count > 0) this.scheduleSave();
    return count;
  }

  // ============ 查询 ============

  getStats(): TaskStats {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let highPriority = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'pending') pending++;
      else if (t.status === 'in_progress') inProgress++;
      else if (t.status === 'completed') completed++;
      if (t.priority === 'high') highPriority++;
    }
    return {
      total: this.tasks.size,
      pending,
      inProgress,
      completed,
      highPriority,
    };
  }

  /** 返回优先级最高且 pending 的任务（同优先级按创建时间先后） */
  getNextTask(): Task | null {
    const pending = Array.from(this.tasks.values()).filter(t => t.status === 'pending');
    if (pending.length === 0) return null;
    pending.sort((a, b) => {
      const pDiff = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
      if (pDiff !== 0) return pDiff;
      return a.createdAt - b.createdAt;
    });
    return pending[0];
  }

  getProgress(): TaskProgress {
    const total = this.tasks.size;
    const completed = Array.from(this.tasks.values()).filter(t => t.status === 'completed').length;
    return {
      completed,
      total,
      percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
    };
  }

  // ============ 资源释放 ============

  /**
   * 释放资源：清理 saveTimer + 移除 exit 监听器 + 强制落盘
   *
   * 测试中必须在删除临时目录前调用，否则 saveTimer 触发时写入已不存在的目录导致 ENOENT。
   * 同时移除 process.once('exit') 监听器避免测试中累积监听器导致内存泄漏。
   */
  dispose(): void {
    this.flush();
    process.removeListener('exit', this.exitListener);
  }
}

// ============ 单例 ============

let singletonInstance: TaskManager | null = null;

/** 获取全局 TaskManager 单例 */
export function getTaskManager(): TaskManager {
  if (!singletonInstance) {
    singletonInstance = new TaskManager();
  }
  return singletonInstance;
}

/** 重置单例（测试用） — dispose 旧实例并清空引用 */
export function resetTaskManager(): void {
  if (singletonInstance) {
    singletonInstance.dispose();
    singletonInstance = null;
  }
}

// ============ LLM 工具定义 ============

/**
 * 任务管理 LLM 工具定义（对标 Claude Code TodoWrite）
 *
 * 暴露 5 个工具：task_create / task_update / task_list / task_delete / task_stats
 */
export function getTaskToolDefinitions() {
  return [
    {
      name: 'task_create',
      description: '创建新的待办任务（对标 Claude Code TodoWrite）。用于在执行复杂多步骤任务时跟踪进度。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: '任务描述' },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: '优先级（默认 medium）',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'task_update',
      description: '更新任务（content/status/priority/summary）。同一时间只能有一个 in_progress 任务，新设为 in_progress 时会自动将其他 in_progress 任务回退为 pending。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: '任务 ID' },
          content: { type: 'string', description: '新的任务描述' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: '新状态',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: '新优先级',
          },
          summary: {
            type: 'string',
            description: '完成总结（标记 completed 时填写）',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'task_list',
      description: '列出任务（可按状态过滤，默认返回全部）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'all'],
            description: '状态过滤（默认 all）',
          },
        },
      },
    },
    {
      name: 'task_delete',
      description: '删除任务',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: '任务 ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'task_stats',
      description: '获取任务统计信息（总数/各状态数/高优先级数/完成进度百分比）',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ];
}

/**
 * 创建任务管理工具的处理器
 *
 * @param manager 目标 TaskManager 实例
 * @returns 异步处理函数 (toolName, args) => result
 */
export function createTaskToolHandler(manager: TaskManager) {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'task_create': {
        const { content, priority } = args as { content: string; priority?: TaskPriority };
        if (!content || typeof content !== 'string') {
          return { error: 'content 是必填项' };
        }
        return manager.addTask(content, priority);
      }
      case 'task_update': {
        const { id, content, status, priority, summary } = args as {
          id: string;
          content?: string;
          status?: TaskStatus;
          priority?: TaskPriority;
          summary?: string;
        };
        if (!id) return { error: 'id 是必填项' };
        const updates: Partial<Pick<Task, 'content' | 'status' | 'priority' | 'summary'>> = {};
        if (content !== undefined) updates.content = content;
        if (status !== undefined) updates.status = status;
        if (priority !== undefined) updates.priority = priority;
        if (summary !== undefined) updates.summary = summary;
        const updated = manager.updateTask(id, updates);
        if (!updated) return { error: `任务不存在: ${id}` };
        return updated;
      }
      case 'task_list': {
        const { status } = args as { status?: TaskStatus | 'all' };
        if (!status || status === 'all') {
          return manager.getAllTasks();
        }
        return manager.getTasksByStatus(status);
      }
      case 'task_delete': {
        const { id } = args as { id: string };
        const success = manager.deleteTask(id);
        return { success };
      }
      case 'task_stats': {
        const stats = manager.getStats();
        const progress = manager.getProgress();
        return { ...stats, progress };
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
