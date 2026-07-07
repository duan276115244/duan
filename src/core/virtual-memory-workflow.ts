/**
 * Manus 式虚拟内存工作流 — VirtualMemoryWorkflow
 *
 * 对标 Manus 的「虚拟内存隐喻」：文件系统作为上下文外接硬盘。
 * 网页/PDF/API 响应写入文件，按需读取，不塞入上下文。
 *
 * 核心能力：
 * 1. todo.md 全局状态管理 — Planner 维护任务清单，失败即换路径
 * 2. 上下文外接硬盘 — 大内容写入文件，上下文只保留摘要+路径
 * 3. 按需读取 — 需要时才从文件加载具体内容到上下文
 *
 * 架构隐喻：
 * - 上下文窗口 = RAM（容量有限，存放当前需要的信息）
 * - 文件系统 = 硬盘（容量大，存放完整内容）
 * - todo.md = 进程控制块（记录当前执行状态）
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 任务状态 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';

/** todo.md 中的任务条目 */
export interface TodoTask {
  /** 任务 ID */
  id: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 优先级（1-5，1最高） */
  priority: number;
  /** 父任务 ID（支持子任务） */
  parentId?: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 失败原因 */
  failureReason?: string;
  /** 关联的外接文件路径 */
  relatedFiles?: string[];
  /** 任务元数据 */
  metadata?: Record<string, unknown>;
}

/** 外接硬盘存储条目 */
export interface OffloadedEntry {
  /** 条目 ID */
  id: string;
  /** 来源类型 */
  source: 'web_page' | 'pdf' | 'api_response' | 'code_analysis' | 'research' | 'custom';
  /** 标题/摘要 */
  summary: string;
  /** 文件路径 */
  filePath: string;
  /** 内容大小（字节） */
  size: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问次数 */
  accessCount: number;
  /** 标签 */
  tags: string[];
  /** 内容摘要（前 500 字符，用于上下文中展示） */
  contentPreview: string;
}

/** 按需读取结果 */
export interface ReadResult {
  /** 条目 ID */
  id: string;
  /** 完整内容 */
  content: string;
  /** 是否截断 */
  truncated: boolean;
  /** 实际读取长度 */
  length: number;
}

// ============ 虚拟内存工作流 ============

export class VirtualMemoryWorkflow {
  /** 工作目录 */
  private workDir: string;

  /** todo.md 文件路径 */
  private todoFilePath: string;

  /** 外接硬盘存储目录 */
  private offloadDir: string;

  /** 内存中的任务列表 */
  private tasks: Map<string, TodoTask> = new Map();

  /** 外接条目索引 */
  private offloadedEntries: Map<string, OffloadedEntry> = new Map();

  /** 摘要索引（按标签） */
  private tagIndex: Map<string, Set<string>> = new Map();

  private log = logger.child({ module: 'VirtualMemoryWorkflow' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('virtual-memory-workflow');
    this.todoFilePath = path.join(this.workDir, 'todo.md');
    this.offloadDir = path.join(this.workDir, 'offloaded');

    // 确保目录存在
    fs.mkdirSync(this.offloadDir, { recursive: true });

    // 加载已有数据
    this.loadTodoFile();
    this.loadOffloadIndex();
  }

  // ========== todo.md 全局状态管理 ==========

  /**
   * 添加任务到 todo.md
   */
  addTask(description: string, priority: number = 3, parentId?: string): TodoTask {
    const task: TodoTask = {
      id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      description,
      status: 'pending',
      priority: Math.max(1, Math.min(5, priority)),
      parentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(task.id, task);
    this.persistTodoFile();

    this.log.info('任务已添加', { taskId: task.id, description: description.substring(0, 50) });
    EventBus.getInstance().emitSync('vm.task.added', { taskId: task.id, description });
    return task;
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: TaskStatus, failureReason?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = status;
    task.updatedAt = Date.now();

    if (status === 'completed') {
      task.completedAt = Date.now();
    }

    if (status === 'failed' && failureReason) {
      task.failureReason = failureReason;
    }

    this.persistTodoFile();

    this.log.info('任务状态已更新', { taskId, status });
    EventBus.getInstance().emitSync('vm.task.updated', { taskId, status });
    return true;
  }

  /**
   * 获取当前待执行任务（按优先级排序）
   *
   * 对标 Manus：失败即换路径，不一次性定死计划。
   */
  getNextTask(): TodoTask | null {
    const pending = Array.from(this.tasks.values())
      .filter(t => t.status === 'pending' || t.status === 'blocked')
      .sort((a, b) => {
        // 优先级高的先执行
        if (a.priority !== b.priority) return a.priority - b.priority;
        // 同优先级按创建时间
        return a.createdAt - b.createdAt;
      });

    return pending[0] ?? null;
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): TodoTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 获取任务统计
   */
  getTaskStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
    failed: number;
  } {
    const stats = { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0, failed: 0 };
    for (const task of this.tasks.values()) {
      stats.total++;
      switch (task.status) {
        case 'pending': stats.pending++; break;
        case 'in_progress': stats.inProgress++; break;
        case 'completed': stats.completed++; break;
        case 'blocked': stats.blocked++; break;
        case 'failed': stats.failed++; break;
      }
    }
    return stats;
  }

  /**
   * 生成 todo.md 内容
   */
  generateTodoMarkdown(): string {
    const stats = this.getTaskStats();
    const lines: string[] = [
      '# TODO — 全局任务状态',
      '',
      `> 最后更新: ${new Date().toISOString()}`,
      `> 总计: ${stats.total} | 待执行: ${stats.pending} | 进行中: ${stats.inProgress} | 已完成: ${stats.completed} | 阻塞: ${stats.blocked} | 失败: ${stats.failed}`,
      '',
    ];

    // 按状态分组
    const groups: Record<TaskStatus, TodoTask[]> = {
      in_progress: [],
      pending: [],
      blocked: [],
      failed: [],
      completed: [],
    };

    for (const task of this.tasks.values()) {
      groups[task.status].push(task);
    }

    const statusEmojis: Record<TaskStatus, string> = {
      pending: '⬜',
      in_progress: '🔄',
      completed: '✅',
      blocked: '🚫',
      failed: '❌',
    };

    const statusNames: Record<TaskStatus, string> = {
      pending: '待执行',
      in_progress: '进行中',
      completed: '已完成',
      blocked: '已阻塞',
      failed: '已失败',
    };

    for (const status of ['in_progress', 'pending', 'blocked', 'failed', 'completed'] as TaskStatus[]) {
      const tasks = groups[status];
      if (tasks.length === 0) continue;

      lines.push(`## ${statusEmojis[status]} ${statusNames[status]} (${tasks.length})`);
      lines.push('');

      // 按优先级排序
      tasks.sort((a, b) => a.priority - b.priority);

      for (const task of tasks) {
        const priorityMark = '!'.repeat(Math.max(1, 6 - task.priority));
        lines.push(`- ${statusEmojis[status]} [P${task.priority}] ${task.description} ${priorityMark}`);

        if (task.failureReason) {
          lines.push(`  - 失败原因: ${task.failureReason}`);
        }

        if (task.relatedFiles && task.relatedFiles.length > 0) {
          lines.push(`  - 关联文件: ${task.relatedFiles.join(', ')}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ========== 上下文外接硬盘 ==========

  /**
   * 将大内容写入外接硬盘，上下文只保留摘要
   *
   * 对标 Manus：网页/PDF/API 响应写文件，按需读取，不塞上下文。
   */
  offloadContent(params: {
    source: OffloadedEntry['source'];
    summary: string;
    content: string;
    tags?: string[];
  }): OffloadedEntry {
    const id = `off_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const fileName = `${id}.md`;
    const filePath = path.join(this.offloadDir, fileName);

    // 写入文件
    const header = `# ${params.summary}\n\n> 来源: ${params.source}\n> 时间: ${new Date().toISOString()}\n> ID: ${id}\n\n---\n\n`;
    fs.writeFileSync(filePath, header + params.content, 'utf-8');

    // 生成内容预览（前 500 字符）
    const contentPreview = params.content.substring(0, 500) + (params.content.length > 500 ? '...' : '');

    const entry: OffloadedEntry = {
      id,
      source: params.source,
      summary: params.summary,
      filePath,
      size: Buffer.byteLength(params.content, 'utf-8'),
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      tags: params.tags ?? [],
      contentPreview,
    };

    this.offloadedEntries.set(id, entry);

    // 更新标签索引
    for (const tag of entry.tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(id);
    }

    this.persistOffloadIndex();

    this.log.info('内容已外接到硬盘', {
      id,
      source: params.source,
      size: entry.size,
      summary: params.summary.substring(0, 50),
    });

    EventBus.getInstance().emitSync('vm.content.offloaded', { id, source: params.source, size: entry.size });
    return entry;
  }

  /**
   * 按需读取外接内容
   *
   * 对标 Manus：需要时才从文件加载具体内容到上下文。
   */
  readOffloaded(id: string, maxLength?: number): ReadResult | null {
    const entry = this.offloadedEntries.get(id);
    if (!entry) return null;

    let content = fs.readFileSync(entry.filePath, 'utf-8');
    const fullLength = content.length;

    if (maxLength && content.length > maxLength) {
      content = content.substring(0, maxLength) + '\n\n... [内容已截断，完整内容请读取文件]';
    }

    // 更新访问统计
    entry.lastAccessedAt = Date.now();
    entry.accessCount++;
    this.schedulePersistOffloadIndex();

    this.log.info('按需读取外接内容', { id, length: content.length });
    return {
      id,
      content,
      truncated: maxLength ? fullLength > maxLength : false,
      length: content.length,
    };
  }

  /**
   * 获取外接条目列表（只返回摘要，不加载完整内容）
   */
  listOffloaded(tag?: string): OffloadedEntry[] {
    if (tag) {
      const ids = this.tagIndex.get(tag);
      if (!ids) return [];
      return Array.from(ids)
        .map(id => this.offloadedEntries.get(id))
        .filter((e): e is OffloadedEntry => e !== undefined)
        .sort((a, b) => b.createdAt - a.createdAt);
    }

    return Array.from(this.offloadedEntries.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 搜索外接内容（按摘要关键词）
   */
  searchOffloaded(query: string): OffloadedEntry[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.offloadedEntries.values())
      .filter(entry =>
        entry.summary.toLowerCase().includes(lowerQuery)
        || entry.contentPreview.toLowerCase().includes(lowerQuery)
        || entry.tags.some(t => t.toLowerCase().includes(lowerQuery)),
      )
      .sort((a, b) => b.accessCount - a.accessCount);
  }

  /**
   * 删除外接条目
   */
  deleteOffloaded(id: string): boolean {
    const entry = this.offloadedEntries.get(id);
    if (!entry) return false;

    // 删除文件
    try {
      fs.unlinkSync(entry.filePath);
    } catch {
      // 文件可能已不存在
    }

    // 从索引中移除
    this.offloadedEntries.delete(id);
    for (const ids of this.tagIndex.values()) {
      ids.delete(id);
    }

    this.schedulePersistOffloadIndex();
    this.log.info('外接条目已删除', { id });
    return true;
  }

  /**
   * 获取外接硬盘统计
   */
  getOffloadStats(): {
    totalEntries: number;
    totalSize: number;
    bySource: Record<string, number>;
    totalAccessCount: number;
  } {
    const stats = {
      totalEntries: this.offloadedEntries.size,
      totalSize: 0,
      bySource: {} as Record<string, number>,
      totalAccessCount: 0,
    };

    for (const entry of this.offloadedEntries.values()) {
      stats.totalSize += entry.size;
      stats.totalAccessCount += entry.accessCount;
      stats.bySource[entry.source] = (stats.bySource[entry.source] ?? 0) + 1;
    }

    return stats;
  }

  // ========== 持久化 ==========

  /** 防抖写入延迟（毫秒），合并短时间内的多次变更 */
  private readonly persistDebounceMs = 300;
  private todoPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private offloadPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** 调度一次 todo.md 防抖写入 */
  private scheduleTodoPersist(): void {
    if (this.disposed) return;
    if (this.todoPersistTimer) clearTimeout(this.todoPersistTimer);
    this.todoPersistTimer = setTimeout(() => {
      this.todoPersistTimer = null;
      void this.persistTodoFile();
    }, this.persistDebounceMs);
  }

  /** 调度一次外接索引防抖写入 */
  private schedulePersistOffloadIndex(): void {
    if (this.disposed) return;
    if (this.offloadPersistTimer) clearTimeout(this.offloadPersistTimer);
    this.offloadPersistTimer = setTimeout(() => {
      this.offloadPersistTimer = null;
      void this.persistOffloadIndex();
    }, this.persistDebounceMs);
  }

  /** 立即将所有挂起的变更落盘 */
  async flush(): Promise<void> {
    if (this.todoPersistTimer) {
      clearTimeout(this.todoPersistTimer);
      this.todoPersistTimer = null;
      await this.persistTodoFile();
    }
    if (this.offloadPersistTimer) {
      clearTimeout(this.offloadPersistTimer);
      this.offloadPersistTimer = null;
      await this.persistOffloadIndex();
    }
  }

  /** 释放资源：落盘所有挂起变更并停止后续调度 */
  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
  }

  /** 持久化 todo.md */
  private async persistTodoFile(): Promise<void> {

    try {
      const content = this.generateTodoMarkdown();
      fs.writeFileSync(this.todoFilePath, content, 'utf-8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化 todo.md 失败', { error: msg });
    }
  }

  /** 加载 todo.md */
  private loadTodoFile(): void {
    try {
      if (!fs.existsSync(this.todoFilePath)) return;

      const content = fs.readFileSync(this.todoFilePath, 'utf-8');
      // 从 Markdown 中解析任务（简化版：只解析状态和描述）
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(/^-\s*[⬜🔄✅🚫❌]\s*\[P(\d)\]\s*(.+?)(?:\s+!+)?$/u);
        if (match) {
          const priority = parseInt(match[1], 10);
          const description = match[2].trim();
          const statusChar = line.match(/[⬜🔄✅🚫❌]/u)?.[0];
          const statusMap: Record<string, TaskStatus> = {
            '⬜': 'pending',
            '🔄': 'in_progress',
            '✅': 'completed',
            '🚫': 'blocked',
            '❌': 'failed',
          };
          const status = statusMap[statusChar ?? '⬜'] ?? 'pending';

          const task: TodoTask = {
            id: `task_loaded_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            description,
            status,
            priority,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.tasks.set(task.id, task);
        }
      }

      this.log.info('todo.md 已加载', { taskCount: this.tasks.size });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载 todo.md 失败', { error: msg });
    }
  }

  /** 持久化外接索引 */
  private persistOffloadIndex(): void {
    try {
      const indexPath = path.join(this.offloadDir, '_index.json');
      const data = {
        entries: Array.from(this.offloadedEntries.values()),
        tagIndex: Array.from(this.tagIndex.entries()).map(([tag, ids]) => ({
          tag,
          ids: Array.from(ids),
        })),
      };
      atomicWriteJsonSync(indexPath, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化外接索引失败', { error: msg });
    }
  }

  /** 加载外接索引 */
  private loadOffloadIndex(): void {
    try {
      const indexPath = path.join(this.offloadDir, '_index.json');
      if (!fs.existsSync(indexPath)) return;

      const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

      for (const entry of data.entries ?? []) {
        this.offloadedEntries.set(entry.id, entry);
      }

      for (const { tag, ids } of data.tagIndex ?? []) {
        this.tagIndex.set(tag, new Set(ids));
      }

      this.log.info('外接索引已加载', { entryCount: this.offloadedEntries.size });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载外接索引失败', { error: msg });
    }
  }

  /**
   * P0 真实修复：暴露工具定义 — 使 VirtualMemoryWorkflow 可注册到主循环作为工具
   *
   * 之前该类不暴露 getToolDefinitions()，导致它无法注册到 standardToolModules，
   * 主循环无法主动调用虚拟内存工作流（todo.md 管理 + 长文外接存储）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具定义需兼容 ToolDef[] (parameters: Record<string,any> / execute: (args:any)),见 bootstrap.ts standardToolModules
  getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, any>; readOnly?: boolean; execute: (args: any) => Promise<string> }> {
    return [
      {
        name: 'vm_add_task',
        description: '在 todo.md 中添加新任务（虚拟内存工作流 — 全局状态管理）',
        parameters: {
          description: { type: 'string', description: '任务描述', required: true },
          priority: { type: 'number', description: '优先级 1-5（5 最高）', required: false },
          parentId: { type: 'string', description: '父任务 ID（可选）', required: false },
        },
        readOnly: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON
        execute: (args: any) => {
          const task = this.addTask(args.description, args.priority, args.parentId);
          return Promise.resolve(JSON.stringify({ taskId: task.id, status: task.status, priority: task.priority }, null, 2));
        },
      },
      {
        name: 'vm_next_task',
        description: '获取下一个最高优先级的待办任务',
        parameters: {},
        readOnly: true,
        execute: () => {
          const task = this.getNextTask();
          if (!task) return Promise.resolve(JSON.stringify({ message: '无待办任务' }, null, 2));
          return Promise.resolve(JSON.stringify(task, null, 2));
        },
      },
      {
        name: 'vm_task_stats',
        description: '获取 todo.md 任务统计（待办/进行中/已完成数量）',
        parameters: {},
        readOnly: true,
        execute: () => {
          return Promise.resolve(JSON.stringify(this.getTaskStats(), null, 2));
        },
      },
      {
        name: 'vm_offload_content',
        description: '将长文内容外接到磁盘存储（释放上下文窗口）',
        parameters: {
          content: { type: 'string', description: '要外接的内容', required: true },
          summary: { type: 'string', description: '内容摘要', required: true },
          source: { type: 'string', description: '来源类型 (web/pdf/api/text)', required: false },
          tags: { type: 'array', description: '标签列表', required: false },
        },
        readOnly: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON
        execute: (args: any) => {
          const entry = this.offloadContent({
            source: args.source || 'text',
            summary: args.summary || args.title || 'offloaded content',
            content: args.content,
            tags: args.tags || [],
          });
          return Promise.resolve(JSON.stringify({ offloadedId: entry.id, message: '内容已外接到磁盘' }, null, 2));
        },
      },
      {
        name: 'vm_search_offloaded',
        description: '搜索外接到磁盘的内容',
        parameters: {
          query: { type: 'string', description: '搜索查询', required: true },
        },
        readOnly: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON
        execute: (args: any) => {
          const results = this.searchOffloaded(args.query);
          return Promise.resolve(JSON.stringify(results, null, 2));
        },
      },
    ];
  }
}
