import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoalSystem } from '../goal-system.js';

describe('GoalSystem', () => {
  let system: GoalSystem;
  let tmpDir: string;
  let goalsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-goal-'));
    goalsFile = path.join(tmpDir, 'goals.json');
    system = new GoalSystem(goalsFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createGoal', () => {
    it('创建目标，默认priority为medium，status为proposed，progress为0', () => {
      const goal = system.createGoal({
        title: '测试目标',
        description: '这是一个测试目标',
      });
      expect(goal.title).toBe('测试目标');
      expect(goal.description).toBe('这是一个测试目标');
      expect(goal.priority).toBe('medium');
      expect(goal.status).toBe('proposed');
      expect(goal.progress).toBe(0);
      expect(goal.parentId).toBeNull();
      expect(goal.subgoals).toEqual([]);
      expect(goal.notes).toEqual([]);
      expect(goal.tags).toEqual([]);
      expect(goal.valueAlignment).toEqual([]);
      expect(goal.deadline).toBeNull();
      expect(goal.id).toBeTruthy();
      expect(goal.created).toBeGreaterThan(0);
      expect(goal.updated).toBeGreaterThan(0);
    });

    it('创建带自定义priority的目标', () => {
      const goal = system.createGoal({
        title: '高优先级目标',
        description: '重要目标',
        priority: 'critical',
        deadline: Date.now() + 86400000,
        valueAlignment: ['有益性'],
        tags: ['紧急', '重要'],
      });
      expect(goal.priority).toBe('critical');
      expect(goal.deadline).toBeGreaterThan(0);
      expect(goal.valueAlignment).toEqual(['有益性']);
      expect(goal.tags).toEqual(['紧急', '重要']);
    });

    it('创建带parentId的子目标，父目标的subgoals包含子目标id', () => {
      const parent = system.createGoal({
        title: '父目标',
        description: '父目标描述',
      });
      const child = system.createGoal({
        title: '子目标',
        description: '子目标描述',
        parentId: parent.id,
      });
      expect(child.parentId).toBe(parent.id);
      // 重新获取父目标检查 subgoals
      const allGoals = system.getAllGoals();
      const updatedParent = allGoals.find(g => g.id === parent.id);
      expect(updatedParent!.subgoals).toContain(child.id);
    });
  });

  describe('状态转换', () => {
    it('activateGoal: proposed → active', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.activateGoal(goal.id);
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('active');
    });

    it('activateGoal对非proposed状态无效', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.activateGoal(goal.id); // proposed → active
      system.activateGoal(goal.id); // active 状态再次激活，应无效
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('active');
    });

    it('startGoal: active → in_progress', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.activateGoal(goal.id);
      system.startGoal(goal.id);
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('in_progress');
    });

    it('startGoal: paused → in_progress', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.activateGoal(goal.id);
      system.startGoal(goal.id); // → in_progress
      system.pauseGoal(goal.id); // → paused
      system.startGoal(goal.id); // → in_progress
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('in_progress');
    });

    it('pauseGoal: in_progress → paused', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.activateGoal(goal.id);
      system.startGoal(goal.id);
      system.pauseGoal(goal.id);
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('paused');
    });

    it('pauseGoal对非in_progress状态无效', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.activateGoal(goal.id); // → active
      system.pauseGoal(goal.id); // active 状态暂停，应无效
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('active');
    });
  });

  describe('updateProgress', () => {
    it('更新进度', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.updateProgress(goal.id, 50);
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.progress).toBe(50);
    });

    it('progress限制在0-100', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.updateProgress(goal.id, 150);
      let updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.progress).toBe(100);

      system.updateProgress(goal.id, -50);
      updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.progress).toBe(0);
    });

    it('progress>=100时status变为completed', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.updateProgress(goal.id, 100);
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.progress).toBe(100);
      expect(updated!.status).toBe('completed');
    });

    it('带note的进度更新', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.updateProgress(goal.id, 30, '完成了一部分');
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.progress).toBe(30);
      expect(updated!.notes.length).toBe(1);
      expect(updated!.notes[0]).toContain('完成了一部分');
    });
  });

  describe('abandonGoal', () => {
    it('放弃目标，status变为abandoned', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.abandonGoal(goal.id, '不再需要');
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.status).toBe('abandoned');
    });

    it('放弃目标时子目标也被放弃', () => {
      const parent = system.createGoal({
        title: '父目标',
        description: '描述',
      });
      const child = system.createGoal({
        title: '子目标',
        description: '描述',
        parentId: parent.id,
      });
      system.abandonGoal(parent.id, '整体放弃');
      const updatedChild = system.getAllGoals().find(g => g.id === child.id);
      expect(updatedChild!.status).toBe('abandoned');
    });

    it('放弃原因记录在notes中', () => {
      const goal = system.createGoal({
        title: '目标',
        description: '描述',
      });
      system.abandonGoal(goal.id, '优先级变化');
      const updated = system.getAllGoals().find(g => g.id === goal.id);
      expect(updated!.notes.length).toBeGreaterThan(0);
      const hasReason = updated!.notes.some(n => n.includes('优先级变化'));
      expect(hasReason).toBe(true);
    });
  });

  describe('decomposeGoal', () => {
    it('分解目标为子目标', () => {
      const parent = system.createGoal({
        title: '父目标',
        description: '描述',
      });
      const children = system.decomposeGoal(parent.id, [
        { title: '子目标1', description: '描述1' },
        { title: '子目标2', description: '描述2' },
      ]);
      expect(children).toHaveLength(2);
      expect(children[0].title).toBe('子目标1');
      expect(children[1].title).toBe('子目标2');
      // 子目标的 parentId 应指向父目标
      expect(children[0].parentId).toBe(parent.id);
      expect(children[1].parentId).toBe(parent.id);
      // 父目标的 subgoals 应包含子目标 id
      const updatedParent = system.getAllGoals().find(g => g.id === parent.id);
      expect(updatedParent!.subgoals).toHaveLength(2);
      expect(updatedParent!.subgoals).toContain(children[0].id);
      expect(updatedParent!.subgoals).toContain(children[1].id);
    });

    it('子目标继承父目标的属性', () => {
      const parent = system.createGoal({
        title: '父目标',
        description: '描述',
        priority: 'high',
        valueAlignment: ['有益性', '持续进化'],
        tags: ['重要', '长期'],
      });
      const children = system.decomposeGoal(parent.id, [
        { title: '子目标1', description: '描述1' },
      ]);
      expect(children[0].priority).toBe('high');
      expect(children[0].valueAlignment).toEqual(['有益性', '持续进化']);
      expect(children[0].tags).toEqual(['重要', '长期']);
    });

    it('不存在的目标返回空数组', () => {
      const result = system.decomposeGoal('nonexistent-id', [
        { title: '子目标1', description: '描述1' },
      ]);
      expect(result).toEqual([]);
    });
  });

  describe('查询', () => {
    it('getAllGoals 返回所有目标', () => {
      system.createGoal({ title: '目标1', description: '描述' });
      system.createGoal({ title: '目标2', description: '描述' });
      system.createGoal({ title: '目标3', description: '描述' });
      const all = system.getAllGoals();
      expect(all).toHaveLength(3);
    });

    it('getActiveGoals 只返回active和in_progress，按priority排序', () => {
      const gLow = system.createGoal({ title: '低', description: '', priority: 'low' });
      const gCritical = system.createGoal({ title: '关键', description: '', priority: 'critical' });
      const gMedium = system.createGoal({ title: '中', description: '', priority: 'medium' });
      system.createGoal({ title: '未激活', description: '', priority: 'high' });

      // 激活三个目标，留一个为 proposed
      system.activateGoal(gLow.id);
      system.activateGoal(gCritical.id);
      system.activateGoal(gMedium.id);
      // 将 medium 目标转为 in_progress
      system.startGoal(gMedium.id);

      const active = system.getActiveGoals();
      // 只包含 active 和 in_progress，不包含 proposed
      expect(active).toHaveLength(3);
      const titles = active.map(g => g.title);
      expect(titles).not.toContain('未激活');

      // 按 priority 排序：critical < medium < low
      expect(active[0].title).toBe('关键');
      expect(active[1].title).toBe('中');
      expect(active[2].title).toBe('低');
    });

    it('getNextTask 返回下一个任务', () => {
      // 无活跃目标时返回 null
      expect(system.getNextTask()).toBeNull();

      // 有活跃目标且无子目标时，返回该目标
      const goal = system.createGoal({ title: '任务', description: '描述' });
      system.activateGoal(goal.id);
      const next = system.getNextTask();
      expect(next).not.toBeNull();
      expect(next!.id).toBe(goal.id);
    });

    it('getNextTask 优先返回未完成的子目标', () => {
      const parent = system.createGoal({ title: '父目标', description: '描述' });
      system.decomposeGoal(parent.id, [
        { title: '子目标1', description: '描述1' },
        { title: '子目标2', description: '描述2' },
      ]);
      // decomposeGoal 会将 proposed 父目标转为 active
      // 子目标为 proposed（未完成、未放弃），应被返回
      const next = system.getNextTask();
      expect(next).not.toBeNull();
      expect(next!.title).toBe('子目标1');
    });

    it('getGoalTree 返回树形字符串', () => {
      const parent = system.createGoal({ title: '父目标', description: '描述' });
      const tree = system.getGoalTree(parent.id);
      expect(typeof tree).toBe('string');
      expect(tree).toContain('父目标');
      expect(tree).toContain('0%');
    });

    it('getGoalTree 返回包含子目标的树形字符串', () => {
      const parent = system.createGoal({ title: '父目标', description: '描述' });
      system.decomposeGoal(parent.id, [
        { title: '子目标A', description: '描述' },
      ]);
      const tree = system.getGoalTree(parent.id);
      expect(tree).toContain('父目标');
      expect(tree).toContain('子目标A');
    });

    it('getGoalTree 对不存在的目标返回空字符串', () => {
      const tree = system.getGoalTree('nonexistent-id');
      expect(tree).toBe('');
    });
  });

  describe('suggestNextGoals / getStats', () => {
    it('suggestNextGoals 返回建议数组', () => {
      const suggestions = system.suggestNextGoals('学习新技能');
      expect(Array.isArray(suggestions)).toBe(true);
      // 无活跃目标时（active < 3），应包含设定新目标的建议
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('suggestNextGoals 在活跃目标少于3个时给出建议', () => {
      const suggestions = system.suggestNextGoals('');
      expect(suggestions).toContain('考虑设定新的学习目标');
      expect(suggestions).toContain('检查是否有可以改进的现有功能');
    });

    it('suggestNextGoals 有待处理目标时给出激活建议', () => {
      // 创建一个 proposed 目标（不激活）
      system.createGoal({ title: '待处理', description: '描述' });
      const suggestions = system.suggestNextGoals('');
      const hasPendingHint = suggestions.some(s => s.includes('待处理') && s.includes('待激活'));
      expect(hasPendingHint).toBe(true);
    });

    it('getStats 返回统计字符串', () => {
      const stats = system.getStats();
      expect(typeof stats).toBe('string');
      expect(stats).toContain('目标统计');
      expect(stats).toContain('总');
      expect(stats).toContain('进行中');
      expect(stats).toContain('完成');
      expect(stats).toContain('放弃');
      expect(stats).toContain('平均进度');
    });

    it('getStats 反映正确的统计数据', () => {
      const g1 = system.createGoal({ title: '目标1', description: '' });
      const g2 = system.createGoal({ title: '目标2', description: '' });
      system.activateGoal(g1.id);
      system.startGoal(g1.id);
      system.updateProgress(g1.id, 50);
      system.abandonGoal(g2.id, '测试放弃');

      const stats = system.getStats();
      // 2 总 / 1 进行中 / 0 完成 / 1 放弃
      expect(stats).toContain('2总');
      expect(stats).toContain('1进行中');
      expect(stats).toContain('1放弃');
    });
  });
});
