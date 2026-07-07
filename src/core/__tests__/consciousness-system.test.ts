import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConsciousnessSystem } from '../consciousness-system.js';

describe('ConsciousnessSystem', () => {
  let tmpDir: string;
  let system: ConsciousnessSystem;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conscious-test-'));
    system = new ConsciousnessSystem(tmpDir);
  });

  afterEach(() => {
    system.stopAutonomousThinking();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('意识状态管理', () => {
    it('初始状态为 awake', () => {
      expect(system.getState()).toBe('awake');
    });

    it('transitionTo 切换状态', () => {
      system.transitionTo('focused');
      expect(system.getState()).toBe('focused');
      system.transitionTo('creative');
      expect(system.getState()).toBe('creative');
    });

    it('autoSelectState 根据情境选择状态', () => {
      expect(system.autoSelectState({ isIdle: true })).toBe('dreaming');
      expect(system.autoSelectState({ isReflective: true })).toBe('reflective');
      expect(system.autoSelectState({ creativityRequired: true })).toBe('creative');
      expect(system.autoSelectState({ taskComplexity: 0.9 })).toBe('focused');
      expect(system.autoSelectState({})).toBe('awake');
    });
  });

  describe('思维流', () => {
    it('think 产生思维并加入流', () => {
      const thought = system.think('perception', '测试思维');
      expect(thought.id).toBeTruthy();
      expect(thought.content).toBe('测试思维');
      expect(thought.type).toBe('perception');
      expect(system.getThoughtStream()).toHaveLength(1);
    });

    it('getRecentThoughts 返回最近 N 条', () => {
      for (let i = 0; i < 15; i++) {
        system.think('perception', `思维 ${i}`);
      }
      const recent = system.getRecentThoughts(5);
      expect(recent).toHaveLength(5);
      expect(recent[4].content).toBe('思维 14');
    });

    it('思维流长度受限', () => {
      // 超过最大长度会被截断
      for (let i = 0; i < 600; i++) {
        system.think('perception', `思维 ${i}`);
      }
      expect(system.getThoughtStream().length).toBeLessThanOrEqual(500);
    });

    it('think 接受选项参数', () => {
      const thought = system.think('reflection', '反思', {
        valence: 0.5,
        activation: 0.8,
        relatedThoughtIds: ['other-id'],
      });
      expect(thought.valence).toBe(0.5);
      expect(thought.activation).toBe(0.8);
      expect(thought.relatedThoughtIds).toEqual(['other-id']);
    });
  });

  describe('自主思维循环', () => {
    it('startAutonomousThinking 启动循环', () => {
      system.startAutonomousThinking(100);
      // 等待一次循环
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          system.stopAutonomousThinking();
          resolve();
        }, 250);
      }).then(() => {
        // 自主思考应产生至少一条思维
        expect(system.getThoughtStream().length).toBeGreaterThan(0);
      });
    });

    it('stopAutonomousThinking 停止循环', () => {
      system.startAutonomousThinking(100);
      system.stopAutonomousThinking();
      const lengthBefore = system.getThoughtStream().length;
      return new Promise<void>((resolve) => setTimeout(resolve, 250)).then(() => {
        expect(system.getThoughtStream().length).toBe(lengthBefore);
      });
    });
  });

  describe('内省系统', () => {
    it('introspect 返回完整报告', () => {
      system.think('perception', '一条思维');
      system.think('reflection', '另一条思维');
      const report = system.introspect();
      expect(report.consciousnessState).toBe(system.getState());
      expect(report.thoughtStreamLength).toBe(2);
      expect(report.emotionalState).toBeDefined();
      expect(report.selfAwareness).toBeGreaterThanOrEqual(0);
      expect(report.cognitiveLoad).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(report.suggestions)).toBe(true);
    });

    it('内省提高自我认知度', () => {
      const before = system.introspect().selfAwareness;
      for (let i = 0; i < 5; i++) system.introspect();
      const after = system.introspect().selfAwareness;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('自我模型', () => {
    it('getSelfModel 返回初始模型', () => {
      const model = system.getSelfModel();
      expect(model.identity.name).toBe('段先生');
      expect(model.identity.capabilities.length).toBeGreaterThan(0);
      expect(model.selfAssessment.length).toBeGreaterThan(0);
      expect(model.personality).toBeDefined();
    });

    it('updateSelfAssessment 成功时提升能力', () => {
      const before = system.getSelfModel().selfAssessment[0].level;
      for (let i = 0; i < 10; i++) {
        system.updateSelfAssessment('编程能力', true);
      }
      const after = system.getSelfModel().selfAssessment[0].level;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('updateSelfAssessment 失败时降低能力', () => {
      const before = system.getSelfModel().selfAssessment[0].level;
      for (let i = 0; i < 10; i++) {
        system.updateSelfAssessment('编程能力', false);
      }
      const after = system.getSelfModel().selfAssessment[0].level;
      expect(after).toBeLessThanOrEqual(before);
    });
  });

  describe('神经网络决策', () => {
    it('decide 返回决策结果', () => {
      const result = system.decide({
        urgency: 0.8,
        complexity: 0.5,
        novelty: 0.3,
        riskTolerance: 0.6,
        availableTime: 0.7,
        resourceLevel: 0.8,
        confidence: 0.7,
        emotionalState: 0.2,
      });
      expect(['立即行动', '谨慎分析', '寻求帮助', '延迟决策']).toContain(result.decision);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.neuralOutput).toHaveLength(4);
    });

    it('learnFromDecisionOutcome 不抛错', () => {
      expect(() => {
        system.learnFromDecisionOutcome(
          {
            urgency: 0.5,
            complexity: 0.5,
            novelty: 0.5,
            riskTolerance: 0.5,
            availableTime: 0.5,
            resourceLevel: 0.5,
            confidence: 0.5,
            emotionalState: 0,
          },
          0,
          'success',
        );
      }).not.toThrow();
    });
  });

  describe('自主目标', () => {
    it('generateAutonomousGoal 返回目标', () => {
      const goal = system.generateAutonomousGoal();
      expect(goal).not.toBeNull();
      expect(goal!.id).toBeTruthy();
      expect(goal!.description).toBeTruthy();
      expect(goal!.motivation).toBeTruthy();
      expect(goal!.status).toBe('active');
      expect(goal!.progress).toBe(0);
    });

    it('getActiveGoals 返回活跃目标', () => {
      system.generateAutonomousGoal();
      system.generateAutonomousGoal();
      const goals = system.getActiveGoals();
      expect(goals.length).toBeGreaterThanOrEqual(2);
    });

    it('updateGoalProgress 更新进度', () => {
      const goal = system.generateAutonomousGoal();
      const ok = system.updateGoalProgress(goal!.id, 0.5);
      expect(ok).toBe(true);
      const goals = system.getActiveGoals();
      const updated = goals.find((g) => g.id === goal!.id);
      expect(updated?.progress).toBe(0.5);
    });

    it('updateGoalProgress 完成时标记为 achieved', () => {
      const goal = system.generateAutonomousGoal();
      system.updateGoalProgress(goal!.id, 1);
      const goals = system.getActiveGoals();
      // achieved 的目标不再出现在 active 列表中
      expect(goals.find((g) => g.id === goal!.id)).toBeUndefined();
    });

    it('updateGoalProgress 不存在的目标返回 false', () => {
      expect(system.updateGoalProgress('nonexistent', 0.5)).toBe(false);
    });
  });

  describe('记忆固化（梦境）', () => {
    it('dream 返回固化统计', () => {
      // 产生一些思维
      for (let i = 0; i < 10; i++) {
        system.think('perception', `思维 ${i}`, { activation: 0.8 });
      }
      const result = system.dream();
      expect(result).toHaveProperty('consolidated');
      expect(result).toHaveProperty('strengthened');
      expect(result).toHaveProperty('pruned');
      // 梦境后回到 awake
      expect(system.getState()).toBe('awake');
    });
  });
});
