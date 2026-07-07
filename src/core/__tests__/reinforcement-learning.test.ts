import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReinforcementLearningSystem } from '../reinforcement-learning.js';

describe('ReinforcementLearningSystem', () => {
  let tmpDir: string;
  let rl: ReinforcementLearningSystem;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-test-'));
    rl = new ReinforcementLearningSystem(tmpDir);
    rl.registerActions([
      { id: 'up', name: '上', description: '向上移动' },
      { id: 'down', name: '下', description: '向下移动' },
      { id: 'left', name: '左', description: '向左移动' },
      { id: 'right', name: '右', description: '向右移动' },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('动作空间管理', () => {
    it('注册并获取动作', () => {
      expect(rl.getActions()).toHaveLength(4);
      expect(rl.getActions().map((a) => a.id)).toContain('up');
    });

    it('批量注册动作', () => {
      rl.registerActions([
        { id: 'jump', name: '跳跃', description: '跳跃动作' },
      ]);
      expect(rl.getActions()).toHaveLength(5);
    });
  });

  describe('Q-learning', () => {
    it('chooseAction 返回已注册的动作', () => {
      const state = { id: 's1', features: [0, 0], description: '起点' };
      const action = rl.chooseAction(state);
      expect(action).toBeDefined();
      expect(['up', 'down', 'left', 'right']).toContain(action.id);
    });

    it('chooseAction 限定可用动作', () => {
      const state = { id: 's1', features: [0], description: 's1' };
      const action = rl.chooseAction(state, ['up', 'down']);
      expect(['up', 'down']).toContain(action.id);
    });

    it('learn 更新 Q 值', () => {
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      const action = { id: 'right', name: '右', description: '右移' };
      rl.learn(s1, action, 1, s2, false);
      const q = rl.getQValues('s1');
      expect(q).not.toBeNull();
      expect(q!.has('right')).toBe(true);
    });

    it('多次学习后 Q 值更新', () => {
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      const action = { id: 'right', name: '右', description: '右移' };
      for (let i = 0; i < 10; i++) {
        rl.learn(s1, action, 1, s2, false);
      }
      const q = rl.getQValues('s1')!.get('right')!;
      expect(q).toBeGreaterThan(0);
    });

    it('learn 衰减探索率', () => {
      const statsBefore = rl.getStats();
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      const action = { id: 'up', name: '上', description: '上移' };
      for (let i = 0; i < 20; i++) {
        rl.learn(s1, action, 0.5, s2, false);
      }
      const statsAfter = rl.getStats();
      expect(statsAfter.epsilon).toBeLessThanOrEqual(statsBefore.epsilon);
    });
  });

  describe('奖励塑造', () => {
    it('setRewardShapingWeight 设置权重', () => {
      rl.setRewardShapingWeight('efficiency', 0.5);
      const shaped = rl.shapeReward(1, { efficiency: 2 });
      expect(shaped).toBe(2); // 1 + 0.5*2
    });

    it('未设置权重的因子不影响奖励', () => {
      const shaped = rl.shapeReward(1, { unknown: 100 });
      expect(shaped).toBe(1);
    });
  });

  describe('查询', () => {
    it('getQValues 未学习的状态返回 null', () => {
      expect(rl.getQValues('nonexistent')).toBeNull();
    });

    it('getBestAction 返回最优动作', () => {
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      // 强化 'up' 动作
      for (let i = 0; i < 20; i++) {
        rl.learn(s1, { id: 'up', name: '上', description: '' }, 1, s2, false);
      }
      // 弱化 'down' 动作
      for (let i = 0; i < 20; i++) {
        rl.learn(s1, { id: 'down', name: '下', description: '' }, -1, s2, false);
      }
      const best = rl.getBestAction(s1);
      expect(best).not.toBeNull();
      expect(best!.id).toBe('up');
    });

    it('getBestAction 未学习返回 null', () => {
      const s = { id: 'unknown', features: [], description: '' };
      expect(rl.getBestAction(s)).toBeNull();
    });

    it('getStats 返回统计', () => {
      const stats = rl.getStats();
      expect(stats).toHaveProperty('totalEpisodes');
      expect(stats).toHaveProperty('totalSteps');
      expect(stats).toHaveProperty('averageReward');
      expect(stats).toHaveProperty('epsilon');
      expect(stats).toHaveProperty('qTableSize');
      expect(stats).toHaveProperty('experienceBufferSize');
    });

    it('getPolicySummary 返回策略摘要', () => {
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      rl.learn(s1, { id: 'up', name: '上', description: '' }, 1, s2, false);
      const summary = rl.getPolicySummary();
      expect(summary.length).toBeGreaterThan(0);
      expect(summary[0]).toHaveProperty('stateId');
      expect(summary[0]).toHaveProperty('bestAction');
      expect(summary[0]).toHaveProperty('qValue');
      expect(summary[0]).toHaveProperty('confidence');
    });
  });

  describe('持久化', () => {
    it('saveModel 保存模型文件', () => {
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      rl.learn(s1, { id: 'up', name: '上', description: '' }, 1, s2, false);
      rl.saveModel();
      expect(fs.existsSync(path.join(tmpDir, 'rl-model.json'))).toBe(true);
    });

    it('loadModel 加载已保存的模型', () => {
      const s1 = { id: 's1', features: [], description: 's1' };
      const s2 = { id: 's2', features: [], description: 's2' };
      rl.learn(s1, { id: 'up', name: '上', description: '' }, 1, s2, false);
      rl.saveModel();

      const rl2 = new ReinforcementLearningSystem(tmpDir);
      const q = rl2.getQValues('s1');
      expect(q).not.toBeNull();
      expect(q!.has('up')).toBe(true);
    });
  });
});
