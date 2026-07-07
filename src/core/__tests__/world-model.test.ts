import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorldModel } from '../world-model.js';

describe('WorldModel', () => {
  let tmpDir: string;
  let model: WorldModel;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-model-test-'));
    model = new WorldModel(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('状态编码', () => {
    it('encodeState 返回状态对象', () => {
      const state = model.encodeState({ x: 0.5, y: 0.3 }, '起点');
      expect(state.id).toBeTruthy();
      expect(state.features).toEqual({ x: 0.5, y: 0.3 });
      expect(state.description).toBe('起点');
      expect(state.timestamp).toBeGreaterThan(0);
    });

    it('相同特征产生相同状态 ID', () => {
      const s1 = model.encodeState({ x: 1, y: 2 });
      const s2 = model.encodeState({ x: 1, y: 2 });
      expect(s1.id).toBe(s2.id);
    });

    it('不同特征产生不同状态 ID', () => {
      const s1 = model.encodeState({ x: 1, y: 2 });
      const s2 = model.encodeState({ x: 1, y: 3 });
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('转移记录', () => {
    it('recordTransition 记录转移', () => {
      const s1 = model.encodeState({ x: 0 }, 's1');
      const s2 = model.encodeState({ x: 1 }, 's2');
      const action = { id: 'move_right', name: '右移', description: '向右移动' };
      const record = model.recordTransition(s1, action, s2, 1, false);
      expect(record.id).toBeTruthy();
      expect(record.fromState.id).toBe(s1.id);
      expect(record.toState.id).toBe(s2.id);
      expect(record.reward).toBe(1);
    });

    it('recordTransition 更新统计', () => {
      const s1 = model.encodeState({ x: 0 });
      const s2 = model.encodeState({ x: 1 });
      const action = { id: 'a1', name: '动作', description: '' };
      model.recordTransition(s1, action, s2, 1, false);
      const stats = model.getStats();
      expect(stats.totalTransitions).toBe(1);
    });
  });

  describe('预测', () => {
    it('predict 无历史返回当前状态', () => {
      const state = model.encodeState({ x: 0.5 });
      const action = { id: 'a1', name: '动作', description: '' };
      const result = model.predict(state, action);
      expect(result.predictedState).toBeDefined();
      expect(typeof result.predictedReward).toBe('number');
      expect(typeof result.confidence).toBe('number');
      expect(result.featureChanges).toBeDefined();
    });

    it('predict 有历史返回更高置信度', () => {
      const s1 = model.encodeState({ x: 0 });
      const s2 = model.encodeState({ x: 1 });
      const action = { id: 'a1', name: '动作', description: '' };
      // 多次记录相同转移
      for (let i = 0; i < 5; i++) {
        model.recordTransition(s1, action, s2, 1, false);
      }
      const result = model.predict(s1, action);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.predictedReward).toBe(1);
    });

    it('predictMultiStep 返回多步预测', () => {
      const s1 = model.encodeState({ x: 0 });
      const s2 = model.encodeState({ x: 1 });
      const action = { id: 'a1', name: '动作', description: '' };
      model.recordTransition(s1, action, s2, 1, false);
      const results = model.predictMultiStep(s1, [action, action, action]);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.state).toBeDefined();
        expect(typeof r.reward).toBe('number');
        expect(typeof r.confidence).toBe('number');
      }
    });
  });

  describe('规划', () => {
    it('plan 返回规划结果', () => {
      const s1 = model.encodeState({ x: 0 }, '起点');
      const actions = [
        { id: 'a1', name: '动作1', description: '' },
        { id: 'a2', name: '动作2', description: '' },
      ];
      const result = model.plan(s1, actions, 3);
      expect(result).toHaveProperty('actions');
      expect(result).toHaveProperty('expectedTotalReward');
      expect(result).toHaveProperty('predictedStates');
      expect(result).toHaveProperty('risk');
      expect(['low', 'medium', 'high']).toContain(result.risk);
      expect(result.depth).toBe(3);
    });
  });

  describe('反事实推理', () => {
    it('counterfactual 返回对比结果', () => {
      const s1 = model.encodeState({ x: 0 }, 's1');
      const s2 = model.encodeState({ x: 1 }, 's2');
      const actualAction = { id: 'a1', name: '实际动作', description: '' };
      const hypoAction = { id: 'a2', name: '假设动作', description: '' };
      model.recordTransition(s1, actualAction, s2, 1, false);

      const result = model.counterfactual(s1, actualAction, s2, 1, hypoAction);
      expect(result.actual).toBeDefined();
      expect(result.hypothetical).toBeDefined();
      expect(result.difference).toHaveProperty('rewardDelta');
      expect(result.difference).toHaveProperty('stateChanges');
      expect(typeof result.causalInference).toBe('string');
    });
  });

  describe('查询', () => {
    it('getStats 返回统计', () => {
      const s1 = model.encodeState({ x: 0 });
      const s2 = model.encodeState({ x: 1 });
      const action = { id: 'a1', name: '动作', description: '' };
      model.recordTransition(s1, action, s2, 1, false);
      const stats = model.getStats();
      expect(stats.totalTransitions).toBe(1);
      expect(stats.uniqueStates).toBe(2);
      expect(stats.uniqueActions).toBe(1);
      expect(stats.transitionModelSize).toBe(1);
      expect(stats.rewardModelSize).toBe(1);
    });

    it('getRecentTransitions 返回最近转移', () => {
      for (let i = 0; i < 5; i++) {
        const s1 = model.encodeState({ x: i });
        const s2 = model.encodeState({ x: i + 1 });
        model.recordTransition(s1, { id: 'a1', name: 'a' }, s2, 1, false);
      }
      const recent = model.getRecentTransitions(3);
      expect(recent).toHaveLength(3);
    });
  });

  describe('持久化', () => {
    it('saveModel 保存模型文件', () => {
      const s1 = model.encodeState({ x: 0 });
      const s2 = model.encodeState({ x: 1 });
      model.recordTransition(s1, { id: 'a1', name: 'a' }, s2, 1, false);
      model.saveModel();
      expect(fs.existsSync(path.join(tmpDir, 'world-model-data.json'))).toBe(true);
    });

    it('loadModel 加载已保存模型', () => {
      const s1 = model.encodeState({ x: 0 });
      const s2 = model.encodeState({ x: 1 });
      model.recordTransition(s1, { id: 'a1', name: 'a' }, s2, 1, false);
      model.saveModel();

      const model2 = new WorldModel(tmpDir);
      const stats = model2.getStats();
      expect(stats.totalTransitions).toBeGreaterThan(0);
    });
  });
});
