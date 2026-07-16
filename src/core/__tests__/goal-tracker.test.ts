/**
 * v20.0 §3.7 长期目标追踪测试
 *
 * 测试 GoalTracker 的核心功能：
 * - 目标 CRUD（创建/读取/列表/更新/删除）
 * - 里程碑/子任务管理
 * - 进度计算（0-100%）
 * - 自主迭代（getNextSubtask / advanceToNextSubtask）
 * - 中断恢复（getResumableGoals / resumeGoal）
 * - 目标模板（3 个内置模板：refactor-project / learn-new-tech / product-iteration）
 * - 自动级联完成（子任务完成 → 里程碑自动完成 → 目标自动完成）
 * - 持久化（<dataDir>/goals/<goal-id>.json）
 * - LLM 工具定义与执行
 *
 * 测试隔离策略：每个测试用例创建独立的临时数据目录，通过构造函数注入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  GoalTracker,
  BUILTIN_GOAL_TEMPLATES,
  getGoalTracker,
} from '../goal-tracker.js';

// ============ 工具：创建独立临时数据目录 ============

let tempDirCounter = 0;

function createTempDataDir(): string {
  tempDirCounter++;
  const dir = path.join(
    os.tmpdir(),
    `duan-goals-test-${Date.now()}-${process.pid}-${tempDirCounter}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============ 测试 ============

describe('v20.0 §3.7: GoalTracker', () => {
  let tracker: GoalTracker;
  let dataDir: string;

  beforeEach(() => {
    // 每个测试使用独立的临时目录，通过构造函数注入
    dataDir = createTempDataDir();
    tracker = new GoalTracker(dataDir);
  });

  afterEach(() => {
    // 清理临时目录
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ============ 初始化 ============

  describe('initialize', () => {
    it('初始化后创建 goals 目录', async () => {
      await tracker.initialize();
      const goalsDir = path.join(dataDir, 'goals');
      expect(fs.existsSync(goalsDir)).toBe(true);
    });

    it('重复调用 initialize 是幂等的', async () => {
      await tracker.initialize();
      await tracker.initialize();
      // 不抛错即视为通过
      expect(true).toBe(true);
    });

    it('初始化时加载已有目标文件', async () => {
      await tracker.initialize();
      // 先创建一个目标
      const createResult = await tracker.createGoal('测试目标', '测试描述');
      expect(createResult.success).toBe(true);
      const goalId = createResult.data!.id;

      // 用新实例加载（同一个 dataDir）
      const newTracker = new GoalTracker(dataDir);
      await newTracker.initialize();
      const loaded = newTracker.getGoal(goalId);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('测试目标');
    });
  });

  // ============ 目标 CRUD ============

  describe('createGoal', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('创建基本目标', async () => {
      const result = await tracker.createGoal('学习 Rust', '系统学习 Rust 编程语言');
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.title).toBe('学习 Rust');
      expect(result.data!.description).toBe('系统学习 Rust 编程语言');
      expect(result.data!.status).toBe('planning');
      expect(result.data!.priority).toBe('medium');
      expect(result.data!.milestones).toEqual([]);
      expect(result.data!.id).toMatch(/^goal-\d{8}-[a-z0-9]+$/);
    });

    it('创建带优先级和截止日期的目标', async () => {
      const result = await tracker.createGoal('紧急项目', '描述', {
        priority: 'critical',
        dueDate: '2026-12-31',
        tags: ['urgent', 'backend'],
      });
      expect(result.success).toBe(true);
      expect(result.data!.priority).toBe('critical');
      expect(result.data!.dueDate).toBe('2026-12-31');
      expect(result.data!.tags).toEqual(['urgent', 'backend']);
    });

    it('创建带里程碑和子任务的目标', async () => {
      const result = await tracker.createGoal('重构项目', '描述', {
        milestones: [
          {
            title: '阶段1',
            description: '第一阶段',
            subtasks: [
              { title: '任务1', estimatedMinutes: 30 },
              { title: '任务2' },
            ],
          },
          {
            title: '阶段2',
            subtasks: [{ title: '任务3' }],
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data!.milestones).toHaveLength(2);
      expect(result.data!.milestones[0].id).toBe('milestone-001');
      expect(result.data!.milestones[0].title).toBe('阶段1');
      expect(result.data!.milestones[0].description).toBe('第一阶段');
      expect(result.data!.milestones[0].status).toBe('pending');
      expect(result.data!.milestones[0].subtasks).toHaveLength(2);
      expect(result.data!.milestones[0].subtasks[0].id).toBe('subtask-1-001');
      expect(result.data!.milestones[0].subtasks[0].title).toBe('任务1');
      expect(result.data!.milestones[0].subtasks[0].estimatedMinutes).toBe(30);
      expect(result.data!.milestones[0].subtasks[0].status).toBe('pending');
      expect(result.data!.milestones[1].id).toBe('milestone-002');
      expect(result.data!.milestones[1].subtasks[0].id).toBe('subtask-2-001');
    });

    it('标题为空时返回错误', async () => {
      const result = await tracker.createGoal('', '描述');
      expect(result.success).toBe(false);
      expect(result.error).toContain('标题不能为空');
    });

    it('描述为空时返回错误', async () => {
      const result = await tracker.createGoal('标题', '');
      expect(result.success).toBe(false);
      expect(result.error).toContain('描述不能为空');
    });

    it('创建后持久化到文件', async () => {
      const result = await tracker.createGoal('持久化测试', '测试文件是否生成');
      const goalId = result.data!.id;
      const filePath = path.join(dataDir, 'goals', `${goalId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.title).toBe('持久化测试');
    });
  });

  describe('getGoal / listGoals', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('getGoal 返回存在的目标', async () => {
      const result = await tracker.createGoal('查询测试', '描述');
      const goal = tracker.getGoal(result.data!.id);
      expect(goal).not.toBeNull();
      expect(goal!.title).toBe('查询测试');
    });

    it('getGoal 返回 null 当目标不存在', () => {
      const goal = tracker.getGoal('nonexistent-id');
      expect(goal).toBeNull();
    });

    it('listGoals 返回所有目标摘要', async () => {
      await tracker.createGoal('目标1', '描述1');
      await tracker.createGoal('目标2', '描述2');
      const summaries = tracker.listGoals();
      expect(summaries).toHaveLength(2);
      expect(summaries.map(s => s.title)).toContain('目标1');
      expect(summaries.map(s => s.title)).toContain('目标2');
    });

    it('listGoals 按更新时间倒序', async () => {
      const r1 = await tracker.createGoal('旧目标', '描述');
      await new Promise(r => setTimeout(r, 10));
      const r2 = await tracker.createGoal('新目标', '描述');
      const summaries = tracker.listGoals();
      expect(summaries[0].id).toBe(r2.data!.id);
      expect(summaries[1].id).toBe(r1.data!.id);
    });

    it('listGoals 按状态过滤', async () => {
      const r1 = await tracker.createGoal('活跃目标', '描述');
      await tracker.updateGoalStatus(r1.data!.id, 'active');
      await tracker.createGoal('计划目标', '描述');
      const activeSummaries = tracker.listGoals({ status: 'active' });
      expect(activeSummaries).toHaveLength(1);
      expect(activeSummaries[0].title).toBe('活跃目标');
    });

    it('listGoals 按优先级过滤', async () => {
      await tracker.createGoal('低优先级', '描述', { priority: 'low' });
      await tracker.createGoal('高优先级', '描述', { priority: 'high' });
      const highSummaries = tracker.listGoals({ priority: 'high' });
      expect(highSummaries).toHaveLength(1);
      expect(highSummaries[0].title).toBe('高优先级');
    });

    it('listGoals 按标签过滤', async () => {
      await tracker.createGoal('标签测试', '描述', { tags: ['frontend', 'react'] });
      await tracker.createGoal('无标签', '描述');
      const tagged = tracker.listGoals({ tag: 'react' });
      expect(tagged).toHaveLength(1);
      expect(tagged[0].title).toBe('标签测试');
    });

    it('listGoals 返回正确的进度摘要', async () => {
      const r = await tracker.createGoal('进度测试', '描述', {
        milestones: [
          {
            title: 'M1',
            subtasks: [
              { title: 'S1' },
              { title: 'S2' },
            ],
          },
          {
            title: 'M2',
            subtasks: [{ title: 'S3' }],
          },
        ],
      });
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      // 完成 1/3 子任务
      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');

      const summaries = tracker.listGoals();
      const target = summaries.find(s => s.id === goalId)!;
      expect(target.totalMilestones).toBe(2);
      expect(target.completedMilestones).toBe(0);
      expect(target.totalSubtasks).toBe(3);
      expect(target.completedSubtasks).toBe(1);
      expect(target.progress).toBe(33); // 1/3 ≈ 33%
    });
  });

  describe('updateGoalStatus / deleteGoal', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('更新目标状态为 active', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const result = await tracker.updateGoalStatus(r.data!.id, 'active');
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('active');
    });

    it('更新为 completed 时设置 completedAt', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const result = await tracker.updateGoalStatus(r.data!.id, 'completed');
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('completed');
      expect(result.data!.completedAt).toBeDefined();
    });

    it('更新不存在的目标返回错误', async () => {
      const result = await tracker.updateGoalStatus('nonexistent', 'active');
      expect(result.success).toBe(false);
      expect(result.error).toContain('目标不存在');
    });

    it('删除目标', async () => {
      const r = await tracker.createGoal('待删除', '描述');
      const goalId = r.data!.id;
      const delResult = await tracker.deleteGoal(goalId);
      expect(delResult.success).toBe(true);
      expect(tracker.getGoal(goalId)).toBeNull();
      // 文件也应被删除
      const filePath = path.join(dataDir, 'goals', `${goalId}.json`);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('删除不存在的目标返回错误', async () => {
      const result = await tracker.deleteGoal('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  // ============ 里程碑操作 ============

  describe('addMilestone / updateMilestoneStatus', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('添加里程碑', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const result = await tracker.addMilestone(r.data!.id, '新里程碑', '描述', '2026-12-31');
      expect(result.success).toBe(true);
      expect(result.data!.title).toBe('新里程碑');
      expect(result.data!.description).toBe('描述');
      expect(result.data!.status).toBe('pending');
      expect(result.data!.subtasks).toEqual([]);
      expect(result.data!.dueDate).toBe('2026-12-31');
      expect(result.data!.id).toBe('milestone-001');
    });

    it('添加第二个里程碑 ID 递增', async () => {
      const r = await tracker.createGoal('目标', '描述');
      await tracker.addMilestone(r.data!.id, 'M1');
      const m2 = await tracker.addMilestone(r.data!.id, 'M2');
      expect(m2.data!.id).toBe('milestone-002');
    });

    it('空标题返回错误', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const result = await tracker.addMilestone(r.data!.id, '');
      expect(result.success).toBe(false);
    });

    it('更新里程碑状态为 completed', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m = await tracker.addMilestone(r.data!.id, 'M1');
      const result = await tracker.updateMilestoneStatus(r.data!.id, m.data!.id, 'completed');
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('completed');
      expect(result.data!.completedAt).toBeDefined();
    });

    it('更新里程碑状态为 in_progress 时清除 completedAt', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m = await tracker.addMilestone(r.data!.id, 'M1');
      await tracker.updateMilestoneStatus(r.data!.id, m.data!.id, 'completed');
      const result = await tracker.updateMilestoneStatus(r.data!.id, m.data!.id, 'in_progress');
      expect(result.data!.status).toBe('in_progress');
      expect(result.data!.completedAt).toBeUndefined();
    });
  });

  // ============ 子任务操作 ============

  describe('addSubtask / updateSubtaskStatus', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('添加子任务', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m = await tracker.addMilestone(r.data!.id, 'M1');
      const result = await tracker.addSubtask(
        r.data!.id,
        m.data!.id,
        '子任务1',
        '描述',
        60,
      );
      expect(result.success).toBe(true);
      expect(result.data!.title).toBe('子任务1');
      expect(result.data!.description).toBe('描述');
      expect(result.data!.estimatedMinutes).toBe(60);
      expect(result.data!.status).toBe('pending');
      expect(result.data!.id).toBe('subtask-1-001');
    });

    it('添加第二个子任务 ID 递增', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m = await tracker.addMilestone(r.data!.id, 'M1');
      await tracker.addSubtask(r.data!.id, m.data!.id, 'S1');
      const s2 = await tracker.addSubtask(r.data!.id, m.data!.id, 'S2');
      expect(s2.data!.id).toBe('subtask-1-002');
    });

    it('子任务 ID 包含里程碑序号', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m1 = await tracker.addMilestone(r.data!.id, 'M1');
      const m2 = await tracker.addMilestone(r.data!.id, 'M2');
      const s1 = await tracker.addSubtask(r.data!.id, m1.data!.id, 'S1');
      const s2 = await tracker.addSubtask(r.data!.id, m2.data!.id, 'S2');
      expect(s1.data!.id).toBe('subtask-1-001');
      expect(s2.data!.id).toBe('subtask-2-001');
    });

    it('更新子任务状态为 completed 并记录备注', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m = await tracker.addMilestone(r.data!.id, 'M1');
      const s = await tracker.addSubtask(r.data!.id, m.data!.id, 'S1');
      const result = await tracker.updateSubtaskStatus(
        r.data!.id,
        m.data!.id,
        s.data!.id,
        'completed',
        '完成备注',
      );
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('completed');
      expect(result.data!.completedAt).toBeDefined();
      expect(result.data!.notes).toBe('完成备注');
    });

    it('操作不存在的目标/里程碑/子任务返回错误', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const m = await tracker.addMilestone(r.data!.id, 'M1');

      expect((await tracker.addSubtask('nonexistent', m.data!.id, 'S1')).success).toBe(false);
      expect((await tracker.addSubtask(r.data!.id, 'nonexistent', 'S1')).success).toBe(false);
      expect((await tracker.addSubtask(r.data!.id, m.data!.id, '')).success).toBe(false);

      expect((await tracker.updateSubtaskStatus('nonexistent', m.data!.id, 's1', 'completed')).success).toBe(false);
      expect((await tracker.updateSubtaskStatus(r.data!.id, 'nonexistent', 's1', 'completed')).success).toBe(false);
      expect((await tracker.updateSubtaskStatus(r.data!.id, m.data!.id, 'nonexistent', 'completed')).success).toBe(false);
    });
  });

  // ============ 自动级联完成 ============

  describe('自动级联完成', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('完成里程碑下所有子任务 → 里程碑自动完成', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          {
            title: 'M1',
            subtasks: [{ title: 'S1' }, { title: 'S2' }],
          },
        ],
      });
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;
      const s2Id = r.data!.milestones[0].subtasks[1].id;

      // 完成第一个子任务，里程碑不应自动完成
      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');
      let goal = tracker.getGoal(goalId)!;
      expect(goal.milestones[0].status).toBe('pending');

      // 完成第二个子任务，里程碑应自动完成
      await tracker.updateSubtaskStatus(goalId, m1Id, s2Id, 'completed');
      goal = tracker.getGoal(goalId)!;
      expect(goal.milestones[0].status).toBe('completed');
      expect(goal.milestones[0].completedAt).toBeDefined();
    });

    it('skipped 子任务也算作完成', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          {
            title: 'M1',
            subtasks: [{ title: 'S1' }, { title: 'S2' }],
          },
        ],
      });
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;
      const s2Id = r.data!.milestones[0].subtasks[1].id;

      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');
      await tracker.updateSubtaskStatus(goalId, m1Id, s2Id, 'skipped');

      const goal = tracker.getGoal(goalId)!;
      expect(goal.milestones[0].status).toBe('completed');
    });

    it('所有里程碑完成 → 目标自动完成', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }] },
          { title: 'M2', subtasks: [{ title: 'S2' }] },
        ],
      });
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const m2Id = r.data!.milestones[1].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;
      const s2Id = r.data!.milestones[1].subtasks[0].id;

      // 完成 M1
      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');
      let goal = tracker.getGoal(goalId)!;
      expect(goal.status).not.toBe('completed');

      // 完成 M2 → 目标自动完成
      await tracker.updateSubtaskStatus(goalId, m2Id, s2Id, 'completed');
      goal = tracker.getGoal(goalId)!;
      expect(goal.status).toBe('completed');
      expect(goal.completedAt).toBeDefined();
    });

    it('空里程碑（无子任务）不自动完成', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [] }],
      });
      const goalId = r.data!.id;
      const goal = tracker.getGoal(goalId)!;
      // 空里程碑不应触发自动完成（allSubtasks.length === 0 时返回 false）
      expect(goal.milestones[0].status).toBe('pending');
      expect(goal.status).not.toBe('completed');
    });
  });

  // ============ 进度计算 ============

  describe('calculateProgress', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('无子任务时进度为 0', async () => {
      const r = await tracker.createGoal('目标', '描述');
      expect(tracker.calculateProgress(r.data!.id)).toBe(0);
    });

    it('部分完成计算正确', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }, { title: 'S3' }, { title: 'S4' }] },
        ],
      });
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');
      expect(tracker.calculateProgress(goalId)).toBe(25); // 1/4
    });

    it('全部完成进度为 100', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }] },
        ],
      });
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');
      expect(tracker.calculateProgress(goalId)).toBe(100);
    });

    it('不存在的目标进度为 0', () => {
      expect(tracker.calculateProgress('nonexistent')).toBe(0);
    });
  });

  // ============ 自主迭代 ============

  describe('getNextSubtask', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('无目标时返回 null', () => {
      expect(tracker.getNextSubtask()).toBeNull();
    });

    it('所有目标都在 planning 状态时返回首个 pending 子任务', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }] }],
      });
      const next = tracker.getNextSubtask();
      expect(next).not.toBeNull();
      expect(next!.goal.id).toBe(r.data!.id);
      expect(next!.subtask.title).toBe('S1');
    });

    it('active 目标优先于 planning 目标', async () => {
      const rPlan = await tracker.createGoal('计划目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'Plan-S1' }] }],
      });
      const rActive = await tracker.createGoal('活跃目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'Active-S1' }] }],
      });
      await tracker.updateGoalStatus(rActive.data!.id, 'active');

      const next = tracker.getNextSubtask();
      expect(next!.goal.id).toBe(rActive.data!.id);
      expect(next!.subtask.title).toBe('Active-S1');
    });

    it('优先返回 in_progress 子任务', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      // S1 设为 in_progress
      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'in_progress');
      const next = tracker.getNextSubtask();
      expect(next!.subtask.id).toBe(s1Id);
      expect(next!.subtask.status).toBe('in_progress');
    });

    it('跳过 completed 里程碑', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }] },
          { title: 'M2', subtasks: [{ title: 'S2' }] },
        ],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m2Id = r.data!.milestones[1].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;
      const s2Id = r.data!.milestones[1].subtasks[0].id;

      // 完成 M1
      await tracker.updateSubtaskStatus(goalId, r.data!.milestones[0].id, s1Id, 'completed');
      // M1 应该已自动完成
      expect(tracker.getGoal(goalId)!.milestones[0].status).toBe('completed');

      // 下一个应是 M2 的 S2
      const next = tracker.getNextSubtask();
      expect(next!.milestone.id).toBe(m2Id);
      expect(next!.subtask.id).toBe(s2Id);
    });

    it('所有子任务完成时返回 null', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      await tracker.updateSubtaskStatus(goalId, m1Id, s1Id, 'completed');
      // 目标应已自动完成
      expect(tracker.getGoal(goalId)!.status).toBe('completed');
      expect(tracker.getNextSubtask()).toBeNull();
    });
  });

  describe('advanceToNextSubtask', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('完成当前子任务并返回下一个', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;
      const s2Id = r.data!.milestones[0].subtasks[1].id;

      const result = await tracker.advanceToNextSubtask(goalId, m1Id, s1Id);
      expect(result.success).toBe(true);
      expect(result.data).not.toBeNull();
      expect(result.data!.subtask.id).toBe(s2Id);

      // 验证 S1 已完成
      const goal = tracker.getGoal(goalId)!;
      expect(goal.milestones[0].subtasks[0].status).toBe('completed');
    });

    it('最后一个子任务完成后返回 null', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      const result = await tracker.advanceToNextSubtask(goalId, m1Id, s1Id);
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
      // 目标应已自动完成
      expect(tracker.getGoal(goalId)!.status).toBe('completed');
    });

    it('记录实际耗时', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }] },
        ],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      await tracker.advanceToNextSubtask(goalId, m1Id, s1Id, { actualMinutes: 45 });
      const goal = tracker.getGoal(goalId)!;
      expect(goal.milestones[0].subtasks[0].actualMinutes).toBe(45);
    });

    it('记录完成备注', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }] },
        ],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;
      const m1Id = r.data!.milestones[0].id;
      const s1Id = r.data!.milestones[0].subtasks[0].id;

      await tracker.advanceToNextSubtask(goalId, m1Id, s1Id, { notes: '完成顺利' });
      const goal = tracker.getGoal(goalId)!;
      expect(goal.milestones[0].subtasks[0].notes).toBe('完成顺利');
    });

    it('当前子任务不存在时返回错误', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }] }],
      });
      const result = await tracker.advanceToNextSubtask(
        r.data!.id,
        r.data!.milestones[0].id,
        'nonexistent',
      );
      expect(result.success).toBe(false);
    });
  });

  // ============ 中断恢复 ============

  describe('中断恢复', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('getResumableGoals 返回未完成的目标', async () => {
      const r1 = await tracker.createGoal('活跃目标', '描述');
      await tracker.updateGoalStatus(r1.data!.id, 'active');
      const r2 = await tracker.createGoal('计划目标', '描述');
      const r3 = await tracker.createGoal('已完成目标', '描述');
      await tracker.updateGoalStatus(r3.data!.id, 'completed');
      const r4 = await tracker.createGoal('已放弃目标', '描述');
      await tracker.updateGoalStatus(r4.data!.id, 'abandoned');

      const resumable = tracker.getResumableGoals();
      expect(resumable).toHaveLength(2);
      const titles = resumable.map(g => g.title);
      expect(titles).toContain('活跃目标');
      expect(titles).toContain('计划目标');
    });

    it('resumeGoal 将 paused 改为 active', async () => {
      const r = await tracker.createGoal('目标', '描述');
      await tracker.updateGoalStatus(r.data!.id, 'active');
      await tracker.updateGoalStatus(r.data!.id, 'paused');
      const result = await tracker.resumeGoal(r.data!.id);
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('active');
    });

    it('resumeGoal 将 planning 改为 active', async () => {
      const r = await tracker.createGoal('目标', '描述');
      // 初始状态为 planning
      const result = await tracker.resumeGoal(r.data!.id);
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('active');
    });

    it('resumeGoal 拒绝 completed 状态', async () => {
      const r = await tracker.createGoal('目标', '描述');
      await tracker.updateGoalStatus(r.data!.id, 'completed');
      const result = await tracker.resumeGoal(r.data!.id);
      expect(result.success).toBe(false);
      expect(result.error).toContain('不可恢复');
    });

    it('resumeGoal 拒绝 abandoned 状态', async () => {
      const r = await tracker.createGoal('目标', '描述');
      await tracker.updateGoalStatus(r.data!.id, 'abandoned');
      const result = await tracker.resumeGoal(r.data!.id);
      expect(result.success).toBe(false);
    });

    it('跨实例恢复：新实例加载持久化目标', async () => {
      const r = await tracker.createGoal('持久化目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const goalId = r.data!.id;

      // 新实例（同一个 dataDir）
      const newTracker = new GoalTracker(dataDir);
      await newTracker.initialize();
      const resumable = newTracker.getResumableGoals();
      expect(resumable).toHaveLength(1);
      expect(resumable[0].id).toBe(goalId);
      expect(resumable[0].status).toBe('active');
    });
  });

  // ============ 目标模板 ============

  describe('目标模板', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('内置 3 个模板', () => {
      expect(BUILTIN_GOAL_TEMPLATES).toHaveLength(3);
      const names = BUILTIN_GOAL_TEMPLATES.map(t => t.name);
      expect(names).toContain('refactor-project');
      expect(names).toContain('learn-new-tech');
      expect(names).toContain('product-iteration');
    });

    it('每个模板都有里程碑和子任务', () => {
      for (const t of BUILTIN_GOAL_TEMPLATES) {
        expect(t.milestoneTemplates.length).toBeGreaterThan(0);
        for (const m of t.milestoneTemplates) {
          expect(m.subtaskTitles.length).toBeGreaterThan(0);
        }
      }
    });

    it('listTemplates 返回所有模板', () => {
      const templates = tracker.listTemplates();
      expect(templates).toHaveLength(3);
    });

    it('createGoalFromTemplate 替换变量', async () => {
      const result = await tracker.createGoalFromTemplate(
        'refactor-project',
        { projectName: 'MyApp' },
      );
      expect(result.success).toBe(true);
      expect(result.data!.title).toBe('重构 MyApp 项目');
      expect(result.data!.description).toContain('MyApp');
      expect(result.data!.fromTemplate).toBe('refactor-project');
      expect(result.data!.priority).toBe('high'); // refactor-project 默认 high
    });

    it('createGoalFromTemplate learn-new-tech', async () => {
      const result = await tracker.createGoalFromTemplate(
        'learn-new-tech',
        { techName: 'WebAssembly' },
      );
      expect(result.success).toBe(true);
      expect(result.data!.title).toBe('学习 WebAssembly');
      expect(result.data!.fromTemplate).toBe('learn-new-tech');
      expect(result.data!.priority).toBe('medium');
    });

    it('createGoalFromTemplate product-iteration', async () => {
      const result = await tracker.createGoalFromTemplate(
        'product-iteration',
        { featureName: '用户认证' },
      );
      expect(result.success).toBe(true);
      expect(result.data!.title).toBe('用户认证 产品迭代');
      expect(result.data!.fromTemplate).toBe('product-iteration');
    });

    it('createGoalFromTemplate 生成里程碑和子任务', async () => {
      const result = await tracker.createGoalFromTemplate(
        'refactor-project',
        { projectName: 'Test' },
      );
      expect(result.data!.milestones.length).toBeGreaterThan(0);
      const firstMilestone = result.data!.milestones[0];
      expect(firstMilestone.title).toBe('代码评估与计划');
      expect(firstMilestone.subtasks.length).toBeGreaterThan(0);
      expect(firstMilestone.subtasks[0].status).toBe('pending');
    });

    it('createGoalFromTemplate 未知模板返回错误', async () => {
      const result = await tracker.createGoalFromTemplate('nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('未知模板');
    });

    it('createGoalFromTemplate 缺少变量返回错误', async () => {
      const result = await tracker.createGoalFromTemplate('refactor-project', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('未提供');
    });

    it('createGoalFromTemplate 自定义优先级覆盖模板默认', async () => {
      const result = await tracker.createGoalFromTemplate(
        'learn-new-tech',
        { techName: 'Rust' },
        { priority: 'critical' },
      );
      expect(result.data!.priority).toBe('critical');
    });
  });

  // ============ 报告展示 ============

  describe('getGoalReport / getOverview', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('getGoalReport 返回格式化报告', async () => {
      const r = await tracker.createGoal('测试目标', '测试描述', {
        priority: 'high',
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }] },
        ],
      });
      const report = tracker.getGoalReport(r.data!.id);
      expect(report).toContain('测试目标');
      expect(report).toContain('测试描述');
      expect(report).toContain('M1');
      expect(report).toContain('S1');
      expect(report).toContain('high');
    });

    it('getGoalReport 不存在的目标', () => {
      const report = tracker.getGoalReport('nonexistent');
      expect(report).toContain('不存在');
    });

    it('getOverview 无目标时返回提示', () => {
      const overview = tracker.getOverview();
      expect(overview).toContain('暂无目标');
    });

    it('getOverview 有目标时返回列表', async () => {
      await tracker.createGoal('目标1', '描述1');
      await tracker.createGoal('目标2', '描述2');
      const overview = tracker.getOverview();
      expect(overview).toContain('目标1');
      expect(overview).toContain('目标2');
      expect(overview).toContain('长期目标');
    });
  });

  // ============ LLM 工具定义 ============

  describe('getToolDefinitions', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('返回 11 个工具定义', () => {
      const tools = tracker.getToolDefinitions();
      expect(tools).toHaveLength(11);
      const names = tools.map(t => t.name);
      expect(names).toContain('goal_create');
      expect(names).toContain('goal_create_from_template');
      expect(names).toContain('goal_list');
      expect(names).toContain('goal_info');
      expect(names).toContain('goal_progress');
      expect(names).toContain('goal_advance');
      expect(names).toContain('goal_update_status');
      expect(names).toContain('goal_add_subtask');
      expect(names).toContain('goal_complete_subtask');
      expect(names).toContain('goal_delete');
      expect(names).toContain('goal_template_list');
    });

    it('goal_create 工具成功创建目标', async () => {
      const tools = tracker.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'goal_create')!;
      const result = await createTool.execute!({
        title: '工具创建目标',
        description: '通过 LLM 工具创建',
        priority: 'high',
      } as Record<string, unknown>);
      expect(result).toContain('工具创建目标');
      expect(result).toContain('✅');
    });

    it('goal_create 工具缺少参数返回错误', async () => {
      const tools = tracker.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'goal_create')!;
      const result = await createTool.execute!({ title: '只有标题' } as Record<string, unknown>);
      expect(result).toContain('❌');
      expect(result).toContain('description');
    });

    it('goal_create 工具无效优先级返回错误', async () => {
      const tools = tracker.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'goal_create')!;
      const result = await createTool.execute!({
        title: 'T',
        description: 'D',
        priority: 'invalid',
      } as Record<string, unknown>);
      expect(result).toContain('❌');
      expect(result).toContain('无效优先级');
    });

    it('goal_list 工具列出目标', async () => {
      await tracker.createGoal('A', 'desc');
      await tracker.createGoal('B', 'desc');
      const tools = tracker.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'goal_list')!;
      const result = await listTool.execute!({} as Record<string, unknown>);
      expect(result).toContain('A');
      expect(result).toContain('B');
    });

    it('goal_template_list 工具列出模板', async () => {
      const tools = tracker.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'goal_template_list')!;
      const result = await listTool.execute!({} as Record<string, unknown>);
      expect(result).toContain('refactor-project');
      expect(result).toContain('learn-new-tech');
      expect(result).toContain('product-iteration');
    });

    it('goal_create_from_template 工具成功', async () => {
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_create_from_template')!;
      const result = await tool.execute!({
        template: 'learn-new-tech',
        variables: { techName: 'Go' },
      } as Record<string, unknown>);
      expect(result).toContain('学习 Go');
      expect(result).toContain('✅');
    });

    it('goal_progress 工具返回下一个子任务', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const tools = tracker.getToolDefinitions();
      const progressTool = tools.find(t => t.name === 'goal_progress')!;
      const result = await progressTool.execute!({} as Record<string, unknown>);
      expect(result).toContain('S1');
      expect(result).toContain('下一个');
    });

    it('goal_progress 工具无待办时返回提示', async () => {
      const tools = tracker.getToolDefinitions();
      const progressTool = tools.find(t => t.name === 'goal_progress')!;
      const result = await progressTool.execute!({} as Record<string, unknown>);
      expect(result).toContain('无待推进');
    });

    it('goal_advance 工具推进子任务', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }] }],
      });
      await tracker.updateGoalStatus(r.data!.id, 'active');
      const tools = tracker.getToolDefinitions();
      const advanceTool = tools.find(t => t.name === 'goal_advance')!;
      const result = await advanceTool.execute!({
        goalId: r.data!.id,
        milestoneId: r.data!.milestones[0].id,
        subtaskId: r.data!.milestones[0].subtasks[0].id,
        actualMinutes: 30,
        notes: '完成',
      } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('S2');
    });

    it('goal_update_status 工具更新状态', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_update_status')!;
      const result = await tool.execute!({
        goalId: r.data!.id,
        status: 'active',
      } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('active');
    });

    it('goal_update_status 工具无效状态返回错误', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_update_status')!;
      const result = await tool.execute!({
        goalId: r.data!.id,
        status: 'invalid',
      } as Record<string, unknown>);
      expect(result).toContain('❌');
      expect(result).toContain('无效状态');
    });

    it('goal_add_subtask 工具添加子任务', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [{ title: 'M1', subtasks: [] }],
      });
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_add_subtask')!;
      const result = await tool.execute!({
        goalId: r.data!.id,
        milestoneId: r.data!.milestones[0].id,
        title: '新子任务',
        description: '描述',
        estimatedMinutes: 60,
      } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('新子任务');
    });

    it('goal_complete_subtask 工具完成子任务', async () => {
      const r = await tracker.createGoal('目标', '描述', {
        milestones: [
          { title: 'M1', subtasks: [{ title: 'S1' }, { title: 'S2' }] },
        ],
      });
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_complete_subtask')!;
      const result = await tool.execute!({
        goalId: r.data!.id,
        milestoneId: r.data!.milestones[0].id,
        subtaskId: r.data!.milestones[0].subtasks[0].id,
        notes: '完成',
      } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('S1');
    });

    it('goal_delete 工具删除目标', async () => {
      const r = await tracker.createGoal('目标', '描述');
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_delete')!;
      const result = await tool.execute!({
        goalId: r.data!.id,
      } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(tracker.getGoal(r.data!.id)).toBeNull();
    });

    it('goal_info 工具返回报告', async () => {
      const r = await tracker.createGoal('查询目标', '描述');
      const tools = tracker.getToolDefinitions();
      const tool = tools.find(t => t.name === 'goal_info')!;
      const result = await tool.execute!({
        goalId: r.data!.id,
      } as Record<string, unknown>);
      expect(result).toContain('查询目标');
    });
  });

  // ============ 单例 ============

  describe('单例', () => {
    it('getGoalTracker 返回同一实例', () => {
      const a = getGoalTracker();
      const b = getGoalTracker();
      expect(a).toBe(b);
    });
  });

  // ============ 边缘情况 ============

  describe('边缘情况', () => {
    beforeEach(async () => {
      await tracker.initialize();
    });

    it('空标题（仅空格）被拒绝', async () => {
      const r = await tracker.createGoal('   ', '描述');
      expect(r.success).toBe(false);
    });

    it('标题被 trim', async () => {
      const r = await tracker.createGoal('  目标  ', '描述');
      expect(r.success).toBe(true);
      expect(r.data!.title).toBe('目标');
    });

    it('损坏的目标文件被跳过', async () => {
      // 写入一个损坏的 JSON 文件
      const goalsDir = path.join(dataDir, 'goals');
      const corruptFile = path.join(goalsDir, 'corrupt-goal.json');
      fs.writeFileSync(corruptFile, '{ invalid json', 'utf-8');

      // 新实例加载，应跳过损坏文件
      const newTracker = new GoalTracker(dataDir);
      await newTracker.initialize();
      // 不崩溃即视为通过
      expect(newTracker.listGoals()).toEqual([]);
    });

    it('目标文件缺少必要字段被跳过', async () => {
      const goalsDir = path.join(dataDir, 'goals');
      const invalidFile = path.join(goalsDir, 'invalid-goal.json');
      // 有 id 但无 title
      fs.writeFileSync(invalidFile, JSON.stringify({ id: 'test', foo: 'bar' }), 'utf-8');

      const newTracker = new GoalTracker(dataDir);
      await newTracker.initialize();
      expect(newTracker.getGoal('test')).toBeNull();
    });
  });
});
