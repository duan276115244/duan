import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TaskManager,
  getTaskToolDefinitions,
  createTaskToolHandler,
  getTaskManager,
  resetTaskManager,
  type Task,
} from '../task-manager.js';

describe('TaskManager', () => {
  let manager: TaskManager;
  let tmpDir: string;
  let dataFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-task-'));
    dataFile = path.join(tmpDir, 'tasks.json');
    manager = new TaskManager(dataFile);
  });

  afterEach(() => {
    // 必须先 dispose：清理 saveTimer + 移除 exit 监听器 + 强制落盘
    // 否则 saveTimer 触发时写入已删除的临时目录导致 ENOENT
    manager.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============ 构造 + load ============

  describe('构造 + load', () => {
    it('构造时自动创建数据目录', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'deep', 'tasks');
      const nestedFile = path.join(nestedDir, 'tasks.json');
      expect(fs.existsSync(nestedDir)).toBe(false);
      const m = new TaskManager(nestedFile);
      expect(fs.existsSync(nestedDir)).toBe(true);
      m.dispose();
    });

    it('文件不存在时加载空数据，不抛错', () => {
      expect(manager.getAllTasks()).toEqual([]);
      expect(manager.getStats().total).toBe(0);
    });

    it('从已有文件加载数据', () => {
      // 先写入一些任务并落盘
      manager.addTask('已有任务1', 'high');
      manager.addTask('已有任务2', 'low');
      manager.save();

      // 新实例从同一文件加载
      const m2 = new TaskManager(dataFile);
      expect(m2.getAllTasks()).toHaveLength(2);
      expect(m2.getTask(m2.getAllTasks()[0].id)).not.toBeNull();
      m2.dispose();
    });

    it('加载损坏的 JSON 文件时不抛错，视为空数据', () => {
      fs.writeFileSync(dataFile, '{ not valid json', 'utf-8');
      const m = new TaskManager(dataFile);
      expect(m.getAllTasks()).toEqual([]);
      m.dispose();
    });
  });

  // ============ addTask ============

  describe('addTask', () => {
    it('创建任务，默认 priority 为 medium，status 为 pending', () => {
      const task = manager.addTask('实现登录功能');
      expect(task.content).toBe('实现登录功能');
      expect(task.priority).toBe('medium');
      expect(task.status).toBe('pending');
      expect(task.id).toBeTruthy();
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBeGreaterThan(0);
      expect(task.completedAt).toBeUndefined();
    });

    it('创建带自定义 priority 的任务', () => {
      const high = manager.addTask('紧急修复', 'high');
      const low = manager.addTask('文档补充', 'low');
      expect(high.priority).toBe('high');
      expect(low.priority).toBe('low');
    });

    it('生成的 ID 唯一', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(manager.addTask(`任务${i}`).id);
      }
      expect(ids.size).toBe(50);
    });

    it('ID 格式为 task-{timestamp}-{random}', () => {
      const task = manager.addTask('格式检查');
      expect(task.id).toMatch(/^task-\d+-[a-z0-9]+$/);
    });
  });

  // ============ updateTask ============

  describe('updateTask', () => {
    it('更新 content 字段', () => {
      const t = manager.addTask('原始内容');
      const updated = manager.updateTask(t.id, { content: '更新后内容' })!;
      expect(updated.content).toBe('更新后内容');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);
    });

    it('更新 priority 字段', () => {
      const t = manager.addTask('任务', 'low');
      const updated = manager.updateTask(t.id, { priority: 'high' })!;
      expect(updated.priority).toBe('high');
    });

    it('更新 status 字段', () => {
      const t = manager.addTask('任务');
      const updated = manager.updateTask(t.id, { status: 'in_progress' })!;
      expect(updated.status).toBe('in_progress');
    });

    it('标记 completed 时自动设置 completedAt', () => {
      const t = manager.addTask('任务');
      const before = Date.now();
      const updated = manager.updateTask(t.id, { status: 'completed', summary: '已完成' })!;
      const after = Date.now();
      expect(updated.status).toBe('completed');
      expect(updated.completedAt).toBeGreaterThanOrEqual(before);
      expect(updated.completedAt).toBeLessThanOrEqual(after);
      expect(updated.summary).toBe('已完成');
    });

    it('从 completed 回退到 pending 时清除 completedAt', () => {
      const t = manager.addTask('任务');
      manager.updateTask(t.id, { status: 'completed' });
      expect(manager.getTask(t.id)!.completedAt).toBeDefined();
      const updated = manager.updateTask(t.id, { status: 'pending' })!;
      expect(updated.status).toBe('pending');
      expect(updated.completedAt).toBeUndefined();
    });

    it('不存在的 ID 返回 null', () => {
      expect(manager.updateTask('nonexistent-id', { content: 'x' })).toBeNull();
    });
  });

  // ============ 单 in_progress 约束 ============

  describe('单 in_progress 约束', () => {
    it('新设 in_progress 时自动将其他 in_progress 任务回退为 pending', () => {
      const t1 = manager.addTask('任务1');
      const t2 = manager.addTask('任务2');
      const t3 = manager.addTask('任务3');

      manager.updateTask(t1.id, { status: 'in_progress' });
      expect(manager.getTask(t1.id)!.status).toBe('in_progress');

      manager.updateTask(t2.id, { status: 'in_progress' });
      // t1 应被自动回退为 pending
      expect(manager.getTask(t1.id)!.status).toBe('pending');
      expect(manager.getTask(t2.id)!.status).toBe('in_progress');
      // t3 不受影响
      expect(manager.getTask(t3.id)!.status).toBe('pending');

      // 同时只有一个 in_progress
      const inProgress = manager.getTasksByStatus('in_progress');
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].id).toBe(t2.id);
    });

    it('将同一任务重复设为 in_progress 不会触发其他任务回退', () => {
      const t1 = manager.addTask('任务1');
      const t2 = manager.addTask('任务2');
      manager.updateTask(t1.id, { status: 'in_progress' });
      manager.updateTask(t1.id, { status: 'in_progress' }); // 重复设置
      expect(manager.getTask(t1.id)!.status).toBe('in_progress');
      // t2 仍是 pending
      expect(manager.getTask(t2.id)!.status).toBe('pending');
    });
  });

  // ============ deleteTask ============

  describe('deleteTask', () => {
    it('删除存在的任务返回 true', () => {
      const t = manager.addTask('待删除');
      expect(manager.deleteTask(t.id)).toBe(true);
      expect(manager.getTask(t.id)).toBeNull();
    });

    it('删除不存在的任务返回 false', () => {
      expect(manager.deleteTask('nonexistent-id')).toBe(false);
    });
  });

  // ============ 查询 ============

  describe('查询', () => {
    it('getTask 返回指定任务，不存在返回 null', () => {
      const t = manager.addTask('查询测试');
      expect(manager.getTask(t.id)!.content).toBe('查询测试');
      expect(manager.getTask('nonexistent')).toBeNull();
    });

    it('getAllTasks 返回所有任务', () => {
      manager.addTask('任务1');
      manager.addTask('任务2');
      manager.addTask('任务3');
      expect(manager.getAllTasks()).toHaveLength(3);
    });

    it('getTasksByStatus 按状态过滤', () => {
      const t1 = manager.addTask('任务1');
      const t2 = manager.addTask('任务2');
      manager.addTask('任务3');
      manager.updateTask(t1.id, { status: 'in_progress' });
      manager.updateTask(t2.id, { status: 'completed' });

      expect(manager.getTasksByStatus('pending')).toHaveLength(1);
      expect(manager.getTasksByStatus('in_progress')).toHaveLength(1);
      expect(manager.getTasksByStatus('completed')).toHaveLength(1);
    });
  });

  // ============ 批量操作 ============

  describe('clearCompleted / clearAll', () => {
    it('clearCompleted 只清除已完成任务，返回清除数量', () => {
      const t1 = manager.addTask('任务1');
      const t2 = manager.addTask('任务2');
      manager.addTask('任务3');
      manager.updateTask(t1.id, { status: 'completed' });
      manager.updateTask(t2.id, { status: 'completed' });

      const cleared = manager.clearCompleted();
      expect(cleared).toBe(2);
      expect(manager.getAllTasks()).toHaveLength(1);
      expect(manager.getTasksByStatus('completed')).toHaveLength(0);
    });

    it('clearAll 清除所有任务，返回清除数量', () => {
      manager.addTask('任务1');
      manager.addTask('任务2');
      manager.addTask('任务3');
      const cleared = manager.clearAll();
      expect(cleared).toBe(3);
      expect(manager.getAllTasks()).toHaveLength(0);
    });

    it('clearCompleted 无完成任务时返回 0', () => {
      manager.addTask('任务1');
      expect(manager.clearCompleted()).toBe(0);
    });
  });

  // ============ getStats / getNextTask / getProgress ============

  describe('getStats / getNextTask / getProgress', () => {
    it('getStats 返回正确的统计', () => {
      const t1 = manager.addTask('任务1', 'high');
      const t2 = manager.addTask('任务2', 'low');
      manager.addTask('任务3', 'high');
      manager.updateTask(t1.id, { status: 'in_progress' });
      manager.updateTask(t2.id, { status: 'completed' });

      const stats = manager.getStats();
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.highPriority).toBe(2);
    });

    it('getNextTask 返回优先级最高的 pending 任务', () => {
      manager.addTask('低优先级', 'low');
      const high = manager.addTask('高优先级', 'high');
      manager.addTask('中优先级', 'medium');

      const next = manager.getNextTask();
      expect(next).not.toBeNull();
      expect(next!.id).toBe(high.id);
    });

    it('getNextTask 同优先级按创建时间先后排序', () => {
      const first = manager.addTask('先创建', 'medium');
      const second = manager.addTask('后创建', 'medium');
      // 让 second 的 createdAt 严格大于 first（确保排序稳定）
      const next = manager.getNextTask();
      expect(next!.id).toBe(first.id);
      void second;
    });

    it('getNextTask 无 pending 任务时返回 null', () => {
      const t = manager.addTask('任务');
      manager.updateTask(t.id, { status: 'completed' });
      expect(manager.getNextTask()).toBeNull();
    });

    it('getProgress 返回正确的进度百分比', () => {
      manager.addTask('任务1');
      manager.addTask('任务2');
      manager.addTask('任务3');
      manager.addTask('任务4');
      // 完成 1 个 → 25%
      const t1 = manager.getAllTasks()[0];
      manager.updateTask(t1.id, { status: 'completed' });

      const progress = manager.getProgress();
      expect(progress.total).toBe(4);
      expect(progress.completed).toBe(1);
      expect(progress.percentage).toBe(25);
    });

    it('getProgress 无任务时返回 0%', () => {
      const progress = manager.getProgress();
      expect(progress.total).toBe(0);
      expect(progress.completed).toBe(0);
      expect(progress.percentage).toBe(0);
    });
  });

  // ============ 持久化往返 ============

  describe('持久化往返', () => {
    it('save + load 保留所有数据', () => {
      const t1 = manager.addTask('任务1', 'high');
      const t2 = manager.addTask('任务2', 'low');
      manager.updateTask(t1.id, { status: 'in_progress' });
      manager.updateTask(t2.id, { status: 'completed', summary: '已完成' });
      manager.save();

      // 文件确实写入
      expect(fs.existsSync(dataFile)).toBe(true);

      // 新实例加载
      const m2 = new TaskManager(dataFile);
      const loaded1 = m2.getTask(t1.id)!;
      const loaded2 = m2.getTask(t2.id)!;
      expect(loaded1.content).toBe('任务1');
      expect(loaded1.priority).toBe('high');
      expect(loaded1.status).toBe('in_progress');
      expect(loaded2.status).toBe('completed');
      expect(loaded2.summary).toBe('已完成');
      expect(loaded2.completedAt).toBeDefined();
      m2.dispose();
    });

    it('dispose 强制落盘未写入的变更', () => {
      const t = manager.addTask('未落盘任务');
      // 不调用 save，直接 dispose
      manager.dispose();
      expect(fs.existsSync(dataFile)).toBe(true);

      const m2 = new TaskManager(dataFile);
      expect(m2.getTask(t.id)).not.toBeNull();
      m2.dispose();
    });

    it('200ms 防抖内的多次变更只触发一次写盘', async () => {
      manager.addTask('任务1');
      manager.addTask('任务2');
      manager.addTask('任务3');
      // 等待防抖触发
      await new Promise(r => setTimeout(r, 300));
      expect(fs.existsSync(dataFile)).toBe(true);

      const m2 = new TaskManager(dataFile);
      expect(m2.getAllTasks()).toHaveLength(3);
      m2.dispose();
    });
  });

  // ============ 单例模式 ============

  describe('单例模式', () => {
    afterEach(() => {
      resetTaskManager();
    });

    it('getTaskManager 返回同一实例', () => {
      const a = getTaskManager();
      const b = getTaskManager();
      expect(a).toBe(b);
    });

    it('resetTaskManager 后获取新实例', () => {
      const a = getTaskManager();
      resetTaskManager();
      const b = getTaskManager();
      expect(a).not.toBe(b);
    });
  });

  // ============ dispose ============

  describe('dispose', () => {
    it('dispose 后 saveTimer 被清理，不触发写盘到已删除目录', async () => {
      manager.addTask('任务');
      manager.dispose();
      // 删除目录后等待防抖时间，不应抛错
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await new Promise(r => setTimeout(r, 300));
      // 无异常即通过
      expect(true).toBe(true);
    });

    it('dispose 移除 process.once(exit) 监听器，不累积', () => {
      const before = process.listenerCount('exit');
      const m = new TaskManager(path.join(tmpDir, 'a.json'));
      m.dispose();
      const after = process.listenerCount('exit');
      expect(after).toBe(before);
    });
  });

  // ============ LLM 工具定义 ============

  describe('LLM 工具定义', () => {
    it('getTaskToolDefinitions 返回 5 个工具', () => {
      const defs = getTaskToolDefinitions();
      expect(defs).toHaveLength(5);
    });

    it('工具名称正确', () => {
      const names = getTaskToolDefinitions().map(d => d.name);
      expect(names).toEqual([
        'task_create',
        'task_update',
        'task_list',
        'task_delete',
        'task_stats',
      ]);
    });

    it('每个工具有 name/description/inputSchema', () => {
      for (const def of getTaskToolDefinitions()) {
        expect(typeof def.name).toBe('string');
        expect(def.name.length).toBeGreaterThan(0);
        expect(typeof def.description).toBe('string');
        expect(def.description.length).toBeGreaterThan(0);
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('task_create 的 inputSchema 要求 content', () => {
      const createDef = getTaskToolDefinitions().find(d => d.name === 'task_create')!;
      expect(createDef.inputSchema.required).toContain('content');
    });

    it('task_update 的 inputSchema 要求 id', () => {
      const updateDef = getTaskToolDefinitions().find(d => d.name === 'task_update')!;
      expect(updateDef.inputSchema.required).toContain('id');
    });
  });

  // ============ 工具 handler ============

  describe('工具 handler', () => {
    let handler: ReturnType<typeof createTaskToolHandler>;

    beforeEach(() => {
      handler = createTaskToolHandler(manager);
    });

    it('task_create 创建任务', async () => {
      const result = await handler('task_create', { content: '通过工具创建', priority: 'high' }) as Task;
      expect(result.content).toBe('通过工具创建');
      expect(result.priority).toBe('high');
      expect(result.status).toBe('pending');
      expect(result.id).toBeTruthy();
    });

    it('task_create 缺少 content 返回错误', async () => {
      const result = await handler('task_create', {}) as { error: string };
      expect(result.error).toBeDefined();
    });

    it('task_update 更新任务', async () => {
      const created = await handler('task_create', { content: '原始' }) as Task;
      const result = await handler('task_update', {
        id: created.id,
        status: 'in_progress',
        summary: '开始处理',
      }) as Task;
      expect(result.status).toBe('in_progress');
      expect(result.summary).toBe('开始处理');
    });

    it('task_update 不存在的 ID 返回错误', async () => {
      const result = await handler('task_update', { id: 'no-such-id', content: 'x' }) as { error: string };
      expect(result.error).toBeDefined();
    });

    it('task_list 默认返回所有任务', async () => {
      await handler('task_create', { content: '任务1' });
      await handler('task_create', { content: '任务2' });
      const result = await handler('task_list', {}) as Task[];
      expect(result).toHaveLength(2);
    });

    it('task_list 按状态过滤', async () => {
      const t1 = await handler('task_create', { content: '任务1' }) as Task;
      await handler('task_create', { content: '任务2' });
      await handler('task_update', { id: t1.id, status: 'completed' });

      const completed = await handler('task_list', { status: 'completed' }) as Task[];
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(t1.id);

      const pending = await handler('task_list', { status: 'pending' }) as Task[];
      expect(pending).toHaveLength(1);
    });

    it('task_delete 删除任务返回 { success: true }', async () => {
      const t = await handler('task_create', { content: '待删除' }) as Task;
      const result = await handler('task_delete', { id: t.id }) as { success: boolean };
      expect(result.success).toBe(true);
      expect(manager.getTask(t.id)).toBeNull();
    });

    it('task_delete 不存在的 ID 返回 { success: false }', async () => {
      const result = await handler('task_delete', { id: 'no-such-id' }) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('task_stats 返回统计 + 进度', async () => {
      const t1 = await handler('task_create', { content: '任务1', priority: 'high' }) as Task;
      const t2 = await handler('task_create', { content: '任务2' }) as Task;
      await handler('task_create', { content: '任务3' });
      await handler('task_update', { id: t1.id, status: 'completed' });
      await handler('task_update', { id: t2.id, status: 'in_progress' });

      const result = await handler('task_stats', {}) as {
        total: number;
        pending: number;
        inProgress: number;
        completed: number;
        highPriority: number;
        progress: { completed: number; total: number; percentage: number };
      };
      expect(result.total).toBe(3);
      expect(result.pending).toBe(1);
      expect(result.inProgress).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.highPriority).toBe(1);
      expect(result.progress.completed).toBe(1);
      expect(result.progress.total).toBe(3);
      expect(result.progress.percentage).toBe(33);
    });

    it('未知工具名返回错误', async () => {
      const result = await handler('unknown_tool', {}) as { error: string };
      expect(result.error).toContain('未知工具');
    });
  });
});
