/**
 * v20.0 §3.4 自主工程任务测试
 *
 * 测试 AutonomousEngineer 的核心功能：
 * - 任务 CRUD（创建/读取/列表/更新/删除）
 * - 5 阶段流水线执行（需求分析 → 架构设计 → 编码实现 → 测试验证 → 部署上线）
 * - 阶段失败重试（最大重试次数耗尽则中止）
 * - 产出物追踪（artifacts）
 * - 持久化（<dataDir>/engineering/<task-id>.json）
 * - 中断恢复（pause/resume/getResumableTasks）
 * - 部署目标（local/docker/vercel/netlify/k8s/none）
 * - 阶段执行器注入（mock 执行器测试）
 * - LLM 工具定义与执行
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AutonomousEngineer,
  ENGINEERING_PHASES,
  getAutonomousEngineer,
  type PhaseExecutionResult,
  type EngineeringTask,
  type PhaseRecord,
} from '../autonomous-engineer.js';

// ============ 工具：创建独立临时数据目录 ============

let tempDirCounter = 0;

function createTempDataDir(): string {
  tempDirCounter++;
  const dir = path.join(
    os.tmpdir(),
    `duan-eng-test-${Date.now()}-${process.pid}-${tempDirCounter}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============ Mock 执行器工厂 ============

/** 创建始终成功的 mock 执行器 */
function createSuccessExecutor(): (task: EngineeringTask, phase: PhaseRecord, prompt: string) => Promise<PhaseExecutionResult> {
  return vi.fn(async (_task: EngineeringTask, phase: PhaseRecord, _prompt: string) => ({
    success: true,
    output: `${phase.phase} 阶段产出`,
    artifacts: [
      { type: 'document', title: `${phase.phase}-output`, content: '测试产出', generatedAt: Date.now() },
    ],
    logs: [`[mock] ${phase.phase} 执行成功`],
  }));
}

/** 创建始终失败的 mock 执行器 */
function createFailureExecutor(errorMessage = '模拟执行失败'): (task: EngineeringTask, phase: PhaseRecord, prompt: string) => Promise<PhaseExecutionResult> {
  return vi.fn(async () => ({
    success: false,
    error: errorMessage,
  }));
}

/** 创建前 N 次失败、之后成功的执行器 */
function createFlakyExecutor(failCount: number): (task: EngineeringTask, phase: PhaseRecord, prompt: string) => Promise<PhaseExecutionResult> {
  let callCount = 0;
  return vi.fn(async (_task: EngineeringTask, phase: PhaseRecord, _prompt: string) => {
    callCount++;
    if (callCount <= failCount) {
      return { success: false, error: `第 ${callCount} 次失败` };
    }
    return {
      success: true,
      output: `${phase.phase} 阶段产出（第 ${callCount} 次成功）`,
      artifacts: [],
      logs: [`[mock] ${phase.phase} 第 ${callCount} 次成功`],
    };
  });
}

/** 创建抛异常的执行器 */
function createThrowingExecutor(errorMsg = '执行异常'): (task: EngineeringTask, phase: PhaseRecord, prompt: string) => Promise<PhaseExecutionResult> {
  return vi.fn(async () => {
    throw new Error(errorMsg);
  });
}

// ============ 测试 ============

describe('v20.0 §3.4: AutonomousEngineer', () => {
  let engineer: AutonomousEngineer;
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDataDir();
    engineer = new AutonomousEngineer(dataDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ============ 初始化 ============

  describe('initialize', () => {
    it('初始化后创建 engineering 目录', async () => {
      await engineer.initialize();
      const dir = path.join(dataDir, 'engineering');
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('重复调用 initialize 是幂等的', async () => {
      await engineer.initialize();
      await engineer.initialize();
      expect(true).toBe(true);
    });

    it('初始化时加载已有任务文件', async () => {
      await engineer.initialize();
      const createResult = await engineer.createTask('测试需求');
      const taskId = createResult.data!.id;

      const newEngineer = new AutonomousEngineer(dataDir);
      await newEngineer.initialize();
      const loaded = newEngineer.getTask(taskId);
      expect(loaded).not.toBeNull();
      expect(loaded!.requirement).toBe('测试需求');
    });
  });

  // ============ 任务 CRUD ============

  describe('createTask', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('创建基本任务', async () => {
      const result = await engineer.createTask('实现一个用户登录功能');
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.requirement).toBe('实现一个用户登录功能');
      expect(result.data!.status).toBe('created');
      expect(result.data!.deploymentTarget).toBe('local');
      expect(result.data!.phases).toHaveLength(5);
      expect(result.data!.currentPhaseIndex).toBe(0);
      expect(result.data!.id).toMatch(/^eng-\d{8}-[a-z0-9]+$/);
    });

    it('自动从需求提炼标题', async () => {
      // 超过 30 字符的需求会被截断
      const longRequirement = '实现一个完整的用户认证授权系统，支持邮箱密码登录、手机验证码登录、第三方 OAuth 登录、单点登录 SSO 以及多因素认证 MFA';
      const result = await engineer.createTask(longRequirement);
      expect(result.data!.title.length).toBeLessThanOrEqual(33); // 30 + "..."
      expect(result.data!.title.endsWith('...')).toBe(true);
    });

    it('自定义标题优先', async () => {
      const result = await engineer.createTask('需求', { title: '自定义标题' });
      expect(result.data!.title).toBe('自定义标题');
    });

    it('创建带部署目标的任务', async () => {
      const result = await engineer.createTask('需求', { deploymentTarget: 'docker' });
      expect(result.data!.deploymentTarget).toBe('docker');
    });

    it('创建带标签的任务', async () => {
      const result = await engineer.createTask('需求', { tags: ['backend', 'auth'] });
      expect(result.data!.tags).toEqual(['backend', 'auth']);
    });

    it('空需求返回错误', async () => {
      const result = await engineer.createTask('');
      expect(result.success).toBe(false);
      expect(result.error).toContain('需求不能为空');
    });

    it('创建后持久化到文件', async () => {
      const result = await engineer.createTask('持久化测试');
      const taskId = result.data!.id;
      const filePath = path.join(dataDir, 'engineering', `${taskId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.requirement).toBe('持久化测试');
    });

    it('5 个阶段初始化正确', async () => {
      const result = await engineer.createTask('需求');
      const phases = result.data!.phases;
      expect(phases[0].phase).toBe('requirements');
      expect(phases[1].phase).toBe('design');
      expect(phases[2].phase).toBe('implementation');
      expect(phases[3].phase).toBe('testing');
      expect(phases[4].phase).toBe('deployment');
      for (const p of phases) {
        expect(p.status).toBe('pending');
        expect(p.retryCount).toBe(0);
        expect(p.logs).toEqual([]);
        expect(p.artifacts).toEqual([]);
      }
    });

    it('阶段 maxRetries 按配置设置', async () => {
      const result = await engineer.createTask('需求');
      const phases = result.data!.phases;
      // requirements: 2, design: 2, implementation: 3, testing: 3, deployment: 2
      expect(phases[0].maxRetries).toBe(2);
      expect(phases[1].maxRetries).toBe(2);
      expect(phases[2].maxRetries).toBe(3);
      expect(phases[3].maxRetries).toBe(3);
      expect(phases[4].maxRetries).toBe(2);
    });
  });

  describe('getTask / listTasks', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('getTask 返回存在的任务', async () => {
      const r = await engineer.createTask('查询测试');
      const task = engineer.getTask(r.data!.id);
      expect(task).not.toBeNull();
      expect(task!.requirement).toBe('查询测试');
    });

    it('getTask 返回 null 当任务不存在', () => {
      expect(engineer.getTask('nonexistent')).toBeNull();
    });

    it('listTasks 返回所有任务摘要', async () => {
      await engineer.createTask('任务1');
      await engineer.createTask('任务2');
      const summaries = engineer.listTasks();
      expect(summaries).toHaveLength(2);
    });

    it('listTasks 按更新时间倒序', async () => {
      const r1 = await engineer.createTask('旧任务');
      await new Promise(r => setTimeout(r, 10));
      const r2 = await engineer.createTask('新任务');
      const summaries = engineer.listTasks();
      expect(summaries[0].id).toBe(r2.data!.id);
      expect(summaries[1].id).toBe(r1.data!.id);
    });

    it('listTasks 按状态过滤', async () => {
      const r1 = await engineer.createTask('任务1');
      await engineer.updateTaskStatus(r1.data!.id, 'completed');
      await engineer.createTask('任务2');
      const completed = engineer.listTasks({ status: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].title).toBe('任务1');
    });

    it('listTasks 按部署目标过滤', async () => {
      await engineer.createTask('任务1', { deploymentTarget: 'docker' });
      await engineer.createTask('任务2', { deploymentTarget: 'vercel' });
      const dockerTasks = engineer.listTasks({ deploymentTarget: 'docker' });
      expect(dockerTasks).toHaveLength(1);
    });

    it('listTasks 按标签过滤', async () => {
      await engineer.createTask('任务1', { tags: ['urgent'] });
      await engineer.createTask('任务2', { tags: ['normal'] });
      const urgent = engineer.listTasks({ tag: 'urgent' });
      expect(urgent).toHaveLength(1);
    });
  });

  describe('updateTaskStatus / deleteTask', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('更新任务状态', async () => {
      const r = await engineer.createTask('任务');
      const result = await engineer.updateTaskStatus(r.data!.id, 'abandoned');
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('abandoned');
      expect(result.data!.completedAt).toBeDefined();
    });

    it('更新不存在的任务返回错误', async () => {
      const result = await engineer.updateTaskStatus('nonexistent', 'completed');
      expect(result.success).toBe(false);
    });

    it('删除任务', async () => {
      const r = await engineer.createTask('待删除');
      const taskId = r.data!.id;
      const delResult = await engineer.deleteTask(taskId);
      expect(delResult.success).toBe(true);
      expect(engineer.getTask(taskId)).toBeNull();
      const filePath = path.join(dataDir, 'engineering', `${taskId}.json`);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('删除不存在的任务返回错误', async () => {
      const result = await engineer.deleteTask('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  // ============ 阶段执行流水线 ============

  describe('runTask - 成功路径', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('全部阶段成功完成', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('实现登录功能');
      const taskId = r.data!.id;

      const runResult = await engineer.runTask(taskId);
      expect(runResult.success).toBe(true);
      expect(runResult.data!.status).toBe('completed');
      expect(runResult.data!.currentPhaseIndex).toBe(5);
      expect(runResult.data!.completedAt).toBeDefined();

      // 所有阶段都应完成
      for (const phase of runResult.data!.phases) {
        expect(phase.status).toBe('completed');
        expect(phase.output).toBeDefined();
        expect(phase.artifacts.length).toBeGreaterThan(0);
      }
    });

    it('阶段产出传递给下一阶段', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;

      await engineer.runTask(taskId);
      const task = engineer.getTask(taskId)!;
      // design 阶段的 input 应为 requirements 阶段的 output
      expect(task.phases[1].input).toBe(task.phases[0].output);
      expect(task.phases[2].input).toBe(task.phases[1].output);
    });

    it('每阶段记录日志', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      await engineer.runTask(r.data!.id);
      const task = engineer.getTask(r.data!.id)!;
      for (const phase of task.phases) {
        expect(phase.logs.length).toBeGreaterThan(0);
        expect(phase.logs.some(l => l.includes('开始执行'))).toBe(true);
        expect(phase.logs.some(l => l.includes('阶段完成'))).toBe(true);
      }
    });

    it('retryCount 为 0 当首次成功', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      await engineer.runTask(r.data!.id);
      const task = engineer.getTask(r.data!.id)!;
      for (const phase of task.phases) {
        expect(phase.retryCount).toBe(0);
      }
    });

    it('执行器接收正确的 prompt（含需求）', async () => {
      const executor = createSuccessExecutor();
      engineer.setPhaseExecutor(executor);
      await engineer.createTask('特殊需求 XYZ');
      const r = engineer.listTasks()[0];
      await engineer.runTask(r.id);

      const calls = (executor as ReturnType<typeof vi.fn>).mock.calls;
      // 第一阶段的 prompt 应包含需求
      const firstCallPrompt = calls[0][2] as string;
      expect(firstCallPrompt).toContain('特殊需求 XYZ');
    });

    it('部署目标注入到 deployment 阶段 prompt', async () => {
      const executor = createSuccessExecutor();
      engineer.setPhaseExecutor(executor);
      const r = await engineer.createTask('需求', { deploymentTarget: 'vercel' });
      await engineer.runTask(r.data!.id);

      const calls = (executor as ReturnType<typeof vi.fn>).mock.calls;
      // 第 5 个调用是 deployment 阶段
      const deploymentPrompt = calls[4][2] as string;
      expect(deploymentPrompt).toContain('vercel');
    });
  });

  describe('runTask - 失败重试', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('阶段失败后自动重试，最终成功', async () => {
      // requirements maxRetries=2，第 1 次失败，第 2 次成功
      engineer.setPhaseExecutor(createFlakyExecutor(1));
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;

      const runResult = await engineer.runTask(taskId);
      expect(runResult.success).toBe(true);
      const task = engineer.getTask(taskId)!;
      expect(task.phases[0].retryCount).toBe(1); // 重试 1 次后成功
      expect(task.phases[0].status).toBe('completed');
    });

    it('重试次数耗尽则任务失败', async () => {
      engineer.setPhaseExecutor(createFailureExecutor('持续失败'));
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;

      const runResult = await engineer.runTask(taskId);
      expect(runResult.success).toBe(false);
      expect(runResult.error).toContain('requirements');
      expect(runResult.error).toContain('持续失败');

      const task = engineer.getTask(taskId)!;
      expect(task.status).toBe('failed');
      expect(task.phases[0].status).toBe('failed');
      expect(task.phases[0].error).toBe('持续失败');
      // requirements maxRetries=2，所以总尝试 3 次，retryCount=2
      expect(task.phases[0].retryCount).toBe(2);
      // 后续阶段不应执行
      expect(task.phases[1].status).toBe('pending');
    });

    it('执行器抛异常被捕获并视为失败', async () => {
      engineer.setPhaseExecutor(createThrowingExecutor('网络错误'));
      const r = await engineer.createTask('需求');
      const runResult = await engineer.runTask(r.data!.id);
      expect(runResult.success).toBe(false);
      expect(runResult.error).toContain('网络错误');
    });

    it('第二阶段失败不影响第一阶段', async () => {
      // 设计一个执行器：requirements 成功，design 失败
      let callIndex = 0;
      const executor = vi.fn(async (_task: EngineeringTask, phase: PhaseRecord) => {
        callIndex++;
        if (phase.phase === 'design') {
          return { success: false, error: '设计失败' };
        }
        return {
          success: true,
          output: `${phase.phase} 产出`,
          artifacts: [],
          logs: [],
        };
      });
      engineer.setPhaseExecutor(executor);

      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;
      const runResult = await engineer.runTask(taskId);

      expect(runResult.success).toBe(false);
      const task = engineer.getTask(taskId)!;
      expect(task.phases[0].status).toBe('completed'); // requirements 完成
      expect(task.phases[1].status).toBe('failed'); // design 失败
      expect(task.phases[2].status).toBe('pending'); // implementation 未执行
    });

    it('已完成任务不能再次运行', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;
      await engineer.runTask(taskId); // 第一次执行完成

      const secondRun = await engineer.runTask(taskId);
      expect(secondRun.success).toBe(false);
      expect(secondRun.error).toContain('已完成');
    });

    it('running 状态不能再次运行', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;
      // 手动设为 running
      await engineer.updateTaskStatus(taskId, 'running');
      const runResult = await engineer.runTask(taskId);
      expect(runResult.success).toBe(false);
      expect(runResult.error).toContain('正在执行中');
    });
  });

  describe('runTask - 中断恢复', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('跳过已完成的阶段', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;

      // 手动标记第一阶段完成
      const task = engineer.getTask(taskId)!;
      task.phases[0].status = 'completed';
      task.phases[0].output = '已有产出';
      task.currentPhaseIndex = 1;
      await engineer.updateTaskStatus(taskId, 'created');

      const runResult = await engineer.runTask(taskId);
      expect(runResult.success).toBe(true);
      // 执行器只应被调用 4 次（跳过 requirements）
      const executor = engineer['phaseExecutor'] as ReturnType<typeof vi.fn>;
      expect(executor).toHaveBeenCalledTimes(4);
    });

    it('pause 暂停任务', async () => {
      const r = await engineer.createTask('需求');
      await engineer.updateTaskStatus(r.data!.id, 'running');
      const pauseResult = await engineer.pauseTask(r.data!.id);
      expect(pauseResult.success).toBe(true);
      expect(pauseResult.data!.status).toBe('paused');
    });

    it('非 running 状态不能暂停', async () => {
      const r = await engineer.createTask('需求');
      const result = await engineer.pauseTask(r.data!.id);
      expect(result.success).toBe(false);
      expect(result.error).toContain('不可暂停');
    });

    it('resume 恢复 paused 任务', async () => {
      const r = await engineer.createTask('需求');
      await engineer.updateTaskStatus(r.data!.id, 'running');
      await engineer.pauseTask(r.data!.id);
      const result = await engineer.resumeTask(r.data!.id);
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('created');
    });

    it('resume 恢复 failed 任务', async () => {
      engineer.setPhaseExecutor(createFailureExecutor());
      const r = await engineer.createTask('需求');
      await engineer.runTask(r.data!.id); // 失败
      const result = await engineer.resumeTask(r.data!.id);
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('created');
    });

    it('resume 重置当前阶段状态', async () => {
      engineer.setPhaseExecutor(createFailureExecutor());
      const r = await engineer.createTask('需求');
      const taskId = r.data!.id;
      await engineer.runTask(taskId); // 失败

      const beforeResume = engineer.getTask(taskId)!;
      expect(beforeResume.phases[0].status).toBe('failed');

      await engineer.resumeTask(taskId);
      const afterResume = engineer.getTask(taskId)!;
      expect(afterResume.phases[0].status).toBe('pending');
      expect(afterResume.phases[0].error).toBeUndefined();
    });

    it('completed 状态不能恢复', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      await engineer.runTask(r.data!.id);
      const result = await engineer.resumeTask(r.data!.id);
      expect(result.success).toBe(false);
    });

    it('getResumableTasks 返回未完成任务', async () => {
      const r1 = await engineer.createTask('任务1');
      await engineer.updateTaskStatus(r1.data!.id, 'running');
      const r2 = await engineer.createTask('任务2');
      const r3 = await engineer.createTask('任务3');
      await engineer.updateTaskStatus(r3.data!.id, 'completed');

      const resumable = engineer.getResumableTasks();
      expect(resumable).toHaveLength(2);
      const ids = resumable.map(t => t.id);
      expect(ids).toContain(r1.data!.id);
      expect(ids).toContain(r2.data!.id);
    });

    it('跨实例恢复：新实例加载持久化任务', async () => {
      const r = await engineer.createTask('持久化任务', { deploymentTarget: 'docker' });
      const taskId = r.data!.id;

      const newEngineer = new AutonomousEngineer(dataDir);
      await newEngineer.initialize();
      const loaded = newEngineer.getTask(taskId);
      expect(loaded).not.toBeNull();
      expect(loaded!.requirement).toBe('持久化任务');
      expect(loaded!.deploymentTarget).toBe('docker');
    });
  });

  // ============ 进度计算 ============

  describe('calculateProgress', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('初始进度为 0', async () => {
      const r = await engineer.createTask('需求');
      expect(engineer.calculateProgress(r.data!.id)).toBe(0);
    });

    it('全部完成后进度为 100', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('需求');
      await engineer.runTask(r.data!.id);
      expect(engineer.calculateProgress(r.data!.id)).toBe(100);
    });

    it('部分完成计算正确', async () => {
      const r = await engineer.createTask('需求');
      const task = engineer.getTask(r.data!.id)!;
      task.phases[0].status = 'completed';
      task.phases[1].status = 'completed';
      // 2/5 = 40%
      expect(engineer.calculateProgress(r.data!.id)).toBe(40);
    });

    it('不存在的任务进度为 0', () => {
      expect(engineer.calculateProgress('nonexistent')).toBe(0);
    });
  });

  // ============ 部署目标 ============

  describe('listDeploymentTargets', () => {
    it('返回 6 个部署目标', () => {
      const targets = engineer.listDeploymentTargets();
      expect(targets).toHaveLength(6);
      const names = targets.map(t => t.target);
      expect(names).toContain('local');
      expect(names).toContain('docker');
      expect(names).toContain('vercel');
      expect(names).toContain('netlify');
      expect(names).toContain('k8s');
      expect(names).toContain('none');
    });
  });

  // ============ 阶段配置 ============

  describe('ENGINEERING_PHASES', () => {
    it('定义 5 个阶段', () => {
      expect(ENGINEERING_PHASES).toHaveLength(5);
      const phases = ENGINEERING_PHASES.map(p => p.phase);
      expect(phases).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment']);
    });

    it('每个阶段都有 prompt 模板', () => {
      for (const p of ENGINEERING_PHASES) {
        expect(p.promptTemplate.length).toBeGreaterThan(0);
        expect(p.displayName).toBeDefined();
        expect(p.icon).toBeDefined();
        expect(p.subagentPreset).toBeDefined();
        expect(p.defaultMaxRetries).toBeGreaterThan(0);
      }
    });
  });

  // ============ 报告展示 ============

  describe('getTaskReport / getOverview', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('getTaskReport 返回格式化报告', async () => {
      const r = await engineer.createTask('测试任务', { deploymentTarget: 'docker' });
      const report = engineer.getTaskReport(r.data!.id);
      expect(report).toContain('测试任务');
      expect(report).toContain('docker');
      expect(report).toContain('需求分析');
      expect(report).toContain('架构设计');
      expect(report).toContain('编码实现');
      expect(report).toContain('测试验证');
      expect(report).toContain('部署上线');
    });

    it('getTaskReport 不存在的任务', () => {
      const report = engineer.getTaskReport('nonexistent');
      expect(report).toContain('不存在');
    });

    it('getOverview 无任务时返回提示', () => {
      const overview = engineer.getOverview();
      expect(overview).toContain('暂无');
    });

    it('getOverview 有任务时返回列表', async () => {
      await engineer.createTask('任务A');
      await engineer.createTask('任务B');
      const overview = engineer.getOverview();
      expect(overview).toContain('任务A');
      expect(overview).toContain('任务B');
    });
  });

  // ============ LLM 工具定义 ============

  describe('getToolDefinitions', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('返回 8 个工具定义', () => {
      const tools = engineer.getToolDefinitions();
      expect(tools).toHaveLength(8);
      const names = tools.map(t => t.name);
      expect(names).toContain('engineering_create');
      expect(names).toContain('engineering_list');
      expect(names).toContain('engineering_info');
      expect(names).toContain('engineering_run');
      expect(names).toContain('engineering_pause');
      expect(names).toContain('engineering_resume');
      expect(names).toContain('engineering_delete');
      expect(names).toContain('engineering_targets');
    });

    it('engineering_create 工具成功创建任务', async () => {
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_create')!;
      const result = await tool.execute!({
        requirement: '实现 API',
        deploymentTarget: 'docker',
      } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('实现 API');
      expect(result).toContain('docker');
    });

    it('engineering_create 缺少参数返回错误', async () => {
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_create')!;
      const result = await tool.execute!({} as Record<string, unknown>);
      expect(result).toContain('❌');
      expect(result).toContain('requirement');
    });

    it('engineering_create 无效部署目标返回错误', async () => {
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_create')!;
      const result = await tool.execute!({
        requirement: '需求',
        deploymentTarget: 'invalid',
      } as Record<string, unknown>);
      expect(result).toContain('❌');
      expect(result).toContain('无效部署目标');
    });

    it('engineering_list 工具列出任务', async () => {
      await engineer.createTask('A');
      await engineer.createTask('B');
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_list')!;
      const result = await tool.execute!({} as Record<string, unknown>);
      expect(result).toContain('A');
      expect(result).toContain('B');
    });

    it('engineering_info 工具返回报告', async () => {
      const r = await engineer.createTask('查询任务');
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_info')!;
      const result = await tool.execute!({ taskId: r.data!.id } as Record<string, unknown>);
      expect(result).toContain('查询任务');
    });

    it('engineering_run 工具执行任务', async () => {
      engineer.setPhaseExecutor(createSuccessExecutor());
      const r = await engineer.createTask('执行任务');
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_run')!;
      const result = await tool.execute!({ taskId: r.data!.id } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('完成');
    });

    it('engineering_pause 工具暂停任务', async () => {
      const r = await engineer.createTask('任务');
      await engineer.updateTaskStatus(r.data!.id, 'running');
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_pause')!;
      const result = await tool.execute!({ taskId: r.data!.id } as Record<string, unknown>);
      expect(result).toContain('⏸️');
    });

    it('engineering_resume 工具恢复任务', async () => {
      const r = await engineer.createTask('任务');
      await engineer.updateTaskStatus(r.data!.id, 'running');
      await engineer.pauseTask(r.data!.id);
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_resume')!;
      const result = await tool.execute!({ taskId: r.data!.id } as Record<string, unknown>);
      expect(result).toContain('▶️');
    });

    it('engineering_delete 工具删除任务', async () => {
      const r = await engineer.createTask('待删除');
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_delete')!;
      const result = await tool.execute!({ taskId: r.data!.id } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(engineer.getTask(r.data!.id)).toBeNull();
    });

    it('engineering_targets 工具列出部署目标', async () => {
      const tools = engineer.getToolDefinitions();
      const tool = tools.find(t => t.name === 'engineering_targets')!;
      const result = await tool.execute!({} as Record<string, unknown>);
      expect(result).toContain('local');
      expect(result).toContain('docker');
      expect(result).toContain('vercel');
      expect(result).toContain('k8s');
    });
  });

  // ============ 单例 ============

  describe('单例', () => {
    it('getAutonomousEngineer 返回同一实例', () => {
      const a = getAutonomousEngineer();
      const b = getAutonomousEngineer();
      expect(a).toBe(b);
    });
  });

  // ============ 边缘情况 ============

  describe('边缘情况', () => {
    beforeEach(async () => {
      await engineer.initialize();
    });

    it('空需求（仅空格）被拒绝', async () => {
      const r = await engineer.createTask('   ');
      expect(r.success).toBe(false);
    });

    it('需求被 trim', async () => {
      const r = await engineer.createTask('  需求  ');
      expect(r.success).toBe(true);
      expect(r.data!.requirement).toBe('需求');
    });

    it('损坏的任务文件被跳过', async () => {
      const dir = path.join(dataDir, 'engineering');
      const corruptFile = path.join(dir, 'corrupt.json');
      fs.writeFileSync(corruptFile, '{ invalid json', 'utf-8');

      const newEngineer = new AutonomousEngineer(dataDir);
      await newEngineer.initialize();
      expect(newEngineer.listTasks()).toEqual([]);
    });

    it('任务文件缺少必要字段被跳过', async () => {
      const dir = path.join(dataDir, 'engineering');
      const invalidFile = path.join(dir, 'invalid.json');
      fs.writeFileSync(invalidFile, JSON.stringify({ id: 'test', foo: 'bar' }), 'utf-8');

      const newEngineer = new AutonomousEngineer(dataDir);
      await newEngineer.initialize();
      expect(newEngineer.getTask('test')).toBeNull();
    });

    it('未注入执行器时使用默认模拟执行器', async () => {
      // 不调用 setPhaseExecutor
      const r = await engineer.createTask('需求');
      const runResult = await engineer.runTask(r.data!.id);
      expect(runResult.success).toBe(true);
      expect(runResult.data!.status).toBe('completed');
      // 默认执行器产出包含"模拟执行"
      expect(runResult.data!.phases[0].output).toContain('模拟执行');
    });
  });
});
