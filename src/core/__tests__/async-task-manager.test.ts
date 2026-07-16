/**
 * 异步任务托管管理器单元测试
 *
 * 验证对标 Devin 的异步任务托管模式：
 * 1. 任务提交与队列
 * 2. 任务状态追踪
 * 3. 任务取消
 * 4. 并行任务
 * 5. 任务模板
 * 6. 通知发送
 * 7. 中断恢复
 * 8. 持久化
 * 9. 统计与清理
 * 10. LLM 工具
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AsyncTaskManager,
  getAsyncTaskToolDefinitions,
  createAsyncTaskToolHandler,
  type TaskExecutor,
  type NotificationSender,
} from '../async-task-manager.js';

describe('异步任务托管管理器', () => {
  let manager: AsyncTaskManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-task-test-'));
    manager = new AsyncTaskManager({ dataDir: tmpDir, maxConcurrent: 2 });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // 辅助：等待任务完成
  async function waitForTask(taskId: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = manager.getTask(taskId);
      if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ========== 1. 任务提交与队列 ==========
  describe('任务提交与队列', () => {
    it('应能提交任务并返回 task-id', () => {
      const id = manager.submitTask('测试任务', '描述', 'test-type', { key: 'value' });
      expect(id).toBeTruthy();
      expect(id).toMatch(/^task-\d+-/);
    });

    it('提交的任务初始状态应为 pending 或 running', () => {
      // 注册一个延迟执行器，让任务保持 pending/running
      manager.registerExecutor('test-type', async (task, ctx) => {
        await new Promise((r) => setTimeout(r, 500));
        return 'done';
      });
      const id = manager.submitTask('测试', '描述', 'test-type');
      const task = manager.getTask(id);
      expect(task).toBeDefined();
      // 任务可能立即开始执行（状态变为 running），也可能是 pending
      expect(['pending', 'running']).toContain(task!.status);
      expect(task!.progress).toBe(0);
      expect(task!.createdAt).toBeGreaterThan(0);
    });

    it('无执行器的任务应标记为 failed', async () => {
      const id = manager.submitTask('无执行器', '', 'unknown-type');
      await waitForTask(id);
      const task = manager.getTask(id);
      expect(task!.status).toBe('failed');
      expect(task!.error).toContain('未注册');
    });
  });

  // ========== 2. 任务状态追踪 ==========
  describe('任务状态追踪', () => {
    it('执行器应能更新进度', async () => {
      manager.registerExecutor('progress-test', async (task, ctx) => {
        ctx.updateProgress(50);
        await new Promise((r) => setTimeout(r, 50));
        ctx.updateProgress(100);
        return 'done';
      });

      const id = manager.submitTask('进度测试', '', 'progress-test');
      await waitForTask(id);
      const task = manager.getTask(id);
      expect(task!.status).toBe('completed');
      expect(task!.progress).toBe(100);
    });

    it('执行器应能记录日志', async () => {
      manager.registerExecutor('log-test', async (task, ctx) => {
        ctx.log('info', '开始处理');
        ctx.log('warn', '警告信息');
        ctx.log('error', '错误信息');
        return 'done';
      });

      const id = manager.submitTask('日志测试', '', 'log-test');
      await waitForTask(id);
      const logs = manager.getTaskLogs(id);
      expect(logs.length).toBeGreaterThanOrEqual(3);
      expect(logs.some((l) => l.message === '开始处理')).toBe(true);
      expect(logs.some((l) => l.message === '警告信息')).toBe(true);
    });

    it('任务完成后应有结果', async () => {
      manager.registerExecutor('result-test', async () => {
        return { data: 'test-result' };
      });

      const id = manager.submitTask('结果测试', '', 'result-test');
      await waitForTask(id);
      const task = manager.getTask(id);
      expect(task!.result).toEqual({ data: 'test-result' });
    });

    it('执行器抛错应标记为 failed', async () => {
      manager.registerExecutor('error-test', async () => {
        throw new Error('测试错误');
      });

      const id = manager.submitTask('错误测试', '', 'error-test');
      await waitForTask(id);
      const task = manager.getTask(id);
      expect(task!.status).toBe('failed');
      expect(task!.error).toBe('测试错误');
    });
  });

  // ========== 3. 任务取消 ==========
  describe('任务取消', () => {
    it('应能取消 pending 任务', () => {
      // 使用 maxConcurrent=0 的独立管理器，确保任务保持 pending 状态不被调度执行
      const pendingMgr = new AsyncTaskManager({ dataDir: tmpDir, maxConcurrent: 0 });
      const id = pendingMgr.submitTask('待取消', '', 'pending-type');
      const task = pendingMgr.getTask(id);
      expect(task!.status).toBe('pending');
      const cancelled = pendingMgr.cancelTask(id);
      expect(cancelled).toBe(true);
      const updated = pendingMgr.getTask(id);
      expect(updated!.status).toBe('cancelled');
    });

    it('应能取消 running 任务', async () => {
      manager.registerExecutor('cancel-test', async (task, ctx) => {
        while (!ctx.isCancelled()) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return 'cancelled';
      });

      const id = manager.submitTask('可取消任务', '', 'cancel-test');
      await new Promise((r) => setTimeout(r, 100)); // 等任务开始
      const cancelled = manager.cancelTask(id);
      expect(cancelled).toBe(true);
      await waitForTask(id);
      const task = manager.getTask(id);
      expect(task!.status).toBe('cancelled');
    });

    it('取消已完成的任务应返回 false', async () => {
      manager.registerExecutor('quick', async () => 'done');
      const id = manager.submitTask('快速', '', 'quick');
      await waitForTask(id);
      const cancelled = manager.cancelTask(id);
      expect(cancelled).toBe(false);
    });
  });

  // ========== 4. 并行任务 ==========
  describe('并行任务', () => {
    it('应支持并行执行多个任务', async () => {
      let runningCount = 0;
      let maxRunning = 0;
      manager.registerExecutor('parallel', async (task, ctx) => {
        runningCount++;
        maxRunning = Math.max(maxRunning, runningCount);
        await new Promise((r) => setTimeout(r, 100));
        runningCount--;
        return 'done';
      });

      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(manager.submitTask(`并行-${i}`, '', 'parallel'));
      }

      for (const id of ids) {
        await waitForTask(id);
      }

      // maxConcurrent = 2，所以最大并行数应该是 2
      expect(maxRunning).toBeLessThanOrEqual(2);
      expect(maxRunning).toBeGreaterThanOrEqual(1);
    });
  });

  // ========== 5. 任务模板 ==========
  describe('任务模板', () => {
    it('应列出内置模板', () => {
      const templates = manager.listTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(4);
      const names = templates.map((t) => t.name);
      expect(names).toContain('code-review');
      expect(names).toContain('batch-test');
      expect(names).toContain('doc-generation');
      expect(names).toContain('large-refactor');
    });

    it('应能从模板创建任务', () => {
      const id = manager.submitFromTemplate('code-review', { target: 'src/' });
      expect(id).toBeTruthy();
      const task = manager.getTask(id);
      expect(task).toBeDefined();
      expect(task!.title).toBe('代码审查');
      expect(task!.params.target).toBe('src/');
    });

    it('不存在的模板应返回 null', () => {
      const id = manager.submitFromTemplate('nonexistent');
      expect(id).toBeNull();
    });

    it('应能注册自定义模板', () => {
      manager.registerTemplate({
        name: 'custom',
        title: '自定义任务',
        description: '测试',
        type: 'custom-type',
        defaultParams: { foo: 'bar' },
        defaultPriority: 'high',
        defaultNotifyChannels: [],
      });
      const templates = manager.listTemplates();
      expect(templates.some((t) => t.name === 'custom')).toBe(true);
    });
  });

  // ========== 6. 通知发送 ==========
  describe('通知发送', () => {
    it('任务完成时应发送通知', async () => {
      const notifications: Array<{ channel: string; title: string; message: string }> = [];
      const notifier: NotificationSender = async (channel, title, message) => {
        notifications.push({ channel, title, message });
      };
      manager.registerNotifier(notifier);
      manager.registerExecutor('notify-test', async () => 'done');

      const id = manager.submitTask('通知测试', '', 'notify-test', {}, {
        notifyChannels: ['feishu', 'email'],
      });
      await waitForTask(id);
      // 等待通知发送
      await new Promise((r) => setTimeout(r, 200));

      expect(notifications.length).toBe(2);
      expect(notifications[0].channel).toBe('feishu');
      expect(notifications[0].title).toContain('完成');
    });

    it('任务失败时也应发送通知', async () => {
      const notifications: string[] = [];
      manager.registerNotifier(async () => {
        notifications.push('called');
      });
      manager.registerExecutor('fail-notify', async () => {
        throw new Error('失败');
      });

      const id = manager.submitTask('失败通知', '', 'fail-notify', {}, {
        notifyChannels: ['webhook'],
      });
      await waitForTask(id);
      await new Promise((r) => setTimeout(r, 200));

      expect(notifications.length).toBe(1);
    });
  });

  // ========== 7. 中断恢复 ==========
  describe('中断恢复', () => {
    it('进程重启后 running 任务应标记为 interrupted', () => {
      const dataDir = path.join(tmpDir, 'sub');
      const mgr1 = new AsyncTaskManager({ dataDir });
      manager.registerExecutor('interrupt-test', async (task, ctx) => {
        while (!ctx.isCancelled()) {
          await new Promise((r) => setTimeout(r, 50));
        }
      });

      // 直接操作 tasks 模拟 running 状态
      const id = 'test-interrupt';
      mgr1['tasks'].set(id, {
        id,
        title: '中断测试',
        description: '',
        type: 'interrupt-test',
        status: 'running',
        priority: 'medium',
        createdAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
        progress: 50,
        logs: [],
        result: null,
        error: null,
        params: {},
        notifyChannels: [],
        tags: [],
      });
      mgr1['saveTasks']();

      // 创建新管理器模拟重启
      const mgr2 = new AsyncTaskManager({ dataDir });
      const task = mgr2.getTask(id);
      expect(task).toBeDefined();
      expect(task!.status).toBe('interrupted');
      expect(task!.error).toContain('中断');
    });
  });

  // ========== 8. 统计与清理 ==========
  describe('统计与清理', () => {
    it('应返回正确的统计信息', async () => {
      manager.registerExecutor('stats-test', async () => 'done');
      const id1 = manager.submitTask('任务1', '', 'stats-test');
      const id2 = manager.submitTask('任务2', '', 'stats-test');
      manager.submitTask('任务3', '', 'unknown'); // 会 failed

      await waitForTask(id1);
      await waitForTask(id2);
      await waitForTask(manager.listTasks().find((t) => t.title === '任务3')!.id);

      const stats = manager.getStats();
      expect(stats.total).toBeGreaterThanOrEqual(3);
      expect(stats.completed).toBeGreaterThanOrEqual(2);
      expect(stats.failed).toBeGreaterThanOrEqual(1);
    });

    it('cleanupCompleted 应清理已完成任务', async () => {
      manager.registerExecutor('cleanup-test', async () => 'done');
      const id = manager.submitTask('清理测试', '', 'cleanup-test');
      await waitForTask(id);

      const cleaned = manager.cleanupCompleted();
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(manager.getTask(id)).toBeUndefined();
    });
  });

  // ========== 9. LLM 工具 ==========
  describe('LLM 工具', () => {
    it('应返回 7 个工具定义', () => {
      const tools = getAsyncTaskToolDefinitions();
      expect(tools).toHaveLength(7);
      const names = tools.map((t) => t.name);
      expect(names).toContain('async_task_submit');
      expect(names).toContain('async_task_status');
      expect(names).toContain('async_task_list');
      expect(names).toContain('async_task_cancel');
      expect(names).toContain('async_task_logs');
      expect(names).toContain('async_task_templates');
      expect(names).toContain('async_task_stats');
    });

    it('async_task_submit 应提交任务', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      const result = await handler('async_task_submit', {
        title: '工具测试',
        type: 'test',
        description: '描述',
      }) as { taskId: string };
      expect(result.taskId).toBeTruthy();
    });

    it('async_task_status 应返回任务状态', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      const id = manager.submitTask('状态测试', '', 'test');
      const result = await handler('async_task_status', { taskId: id });
      expect(result).toMatchObject({ id, status: expect.any(String) });
    });

    it('async_task_status 不存在的任务应返回错误', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      const result = await handler('async_task_status', { taskId: 'nonexistent' });
      expect(result).toMatchObject({ error: '任务不存在' });
    });

    it('async_task_list 应返回任务列表', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      manager.submitTask('列表1', '', 'type-a');
      manager.submitTask('列表2', '', 'type-b');
      const result = await handler('async_task_list', {}) as unknown[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('async_task_cancel 应取消任务', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      // 注册一个会长时间运行的执行器
      manager.registerExecutor('long-running', async (task, ctx) => {
        while (!ctx.isCancelled()) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return 'cancelled';
      });
      const id = manager.submitTask('取消测试', '', 'long-running');
      await new Promise((r) => setTimeout(r, 100)); // 等任务开始运行
      const result = await handler('async_task_cancel', { taskId: id });
      expect(result).toMatchObject({ cancelled: true });
    });

    it('async_task_logs 应返回日志', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      manager.registerExecutor('log-tool-test', async (task, ctx) => {
        ctx.log('info', '测试日志');
        return 'done';
      });
      const id = manager.submitTask('日志工具测试', '', 'log-tool-test');
      await waitForTask(id);
      const result = await handler('async_task_logs', { taskId: id }) as unknown[];
      expect(Array.isArray(result)).toBe(true);
    });

    it('async_task_templates 应返回模板列表', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      const result = await handler('async_task_templates', {}) as unknown[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(4);
    });

    it('async_task_stats 应返回统计', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      const result = await handler('async_task_stats', {});
      expect(result).toMatchObject({ total: expect.any(Number) });
    });

    it('未知工具应返回错误', async () => {
      const handler = createAsyncTaskToolHandler(manager);
      const result = await handler('unknown_tool', {});
      expect(result).toMatchObject({ error: '未知工具: unknown_tool' });
    });
  });
});
