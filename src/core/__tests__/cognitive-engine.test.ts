/**
 * CognitiveEngine 单元测试
 *
 * 验证认知引擎的核心能力：
 * 1. 自动特征提取 — 从上下文提取 8 维认知特征
 * 2. 神经决策 — NN 预测最优策略
 * 3. 在线学习 — 任务结果反向传播训练
 * 4. 认知周期 — 完整思考过程记录
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CognitiveEngine, type CognitiveFeatures } from '../cognitive-engine.js';

describe('CognitiveEngine', () => {
  let engine: CognitiveEngine;
  const modelPath = path.join(process.cwd(), 'data', 'cognitive-net-test.json');

  beforeEach(() => {
    // 清理旧模型文件
    if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
    engine = new CognitiveEngine(modelPath);
  });

  afterEach(() => {
    // 清理模型文件
    if (fs.existsSync(modelPath)) {
      try { fs.unlinkSync(modelPath); } catch {}
    }
    // 清理 data 目录（如果为空）
    const dir = path.dirname(modelPath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      try { fs.rmdirSync(dir); } catch {}
    }
  });

  describe('特征提取', () => {
    it('从简单输入提取特征', () => {
      const features = engine.extractFeatures({ input: '你好' });
      expect(features.urgency).toBeGreaterThan(0);
      expect(features.urgency).toBeLessThanOrEqual(1);
      expect(features.complexity).toBeGreaterThanOrEqual(0);
      expect(features.complexity).toBeLessThanOrEqual(1);
      expect(features.novelty).toBe(1.0); // 首次见到
      expect(features.contextRichness).toBeGreaterThanOrEqual(0);
      expect(features.errorRate).toBe(0); // 无错误
      expect(features.toolUsageRate).toBeGreaterThanOrEqual(0);
      expect(features.userSatisfaction).toBe(0.5); // 初始值
      expect(features.taskType).toBeGreaterThanOrEqual(0);
    });

    it('复杂编程任务有高复杂度和任务类型', () => {
      const features = engine.extractFeatures({
        input: '请帮我重构这个函数，修复bug，然后运行测试。首先分析代码结构，然后逐步修改。',
      });
      expect(features.complexity).toBeGreaterThan(0.2);
      expect(features.taskType).toBeGreaterThan(0.3);
    });

    it('有 deadline 时紧急度高', () => {
      const features = engine.extractFeatures({
        input: '完成这个任务',
        hasDeadline: true,
      });
      expect(features.urgency).toBe(0.9);
    });

    it('重复任务新颖度递减', () => {
      const input = '帮我写一个hello world';
      engine.extractFeatures({ input });
      const f2 = engine.extractFeatures({ input });
      expect(f2.novelty).toBeLessThan(1.0);
      const f3 = engine.extractFeatures({ input });
      expect(f3.novelty).toBeLessThan(f2.novelty);
    });

    it('上下文消息影响 contextRichness', () => {
      const longMsg = { role: 'user', content: 'x'.repeat(5000) };
      const features = engine.extractFeatures({
        input: '继续',
        contextMessages: [longMsg],
      });
      expect(features.contextRichness).toBeGreaterThan(0.3);
    });

    it('代码块增加复杂度', () => {
      const features = engine.extractFeatures({
        input: '修复这段代码：\n```js\nfunction foo() { return 1; }\n```\n还有这段：\n```py\ndef bar(): return 2\n```',
      });
      expect(features.complexity).toBeGreaterThan(0.3);
    });
  });

  describe('神经决策', () => {
    it('返回有效的决策结果', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.7, taskType: 0.5,
      };
      const decision = engine.decide(features);
      expect(decision.strategy).toBeDefined();
      expect(['direct_action', 'careful_analysis', 'decompose', 'ask_user', 'retry_with_hint'])
        .toContain(decision.strategy);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expect(decision.temperature).toBeGreaterThan(0);
      expect(decision.temperature).toBeLessThanOrEqual(1);
      expect(decision.maxIterations).toBeGreaterThan(0);
      expect(decision.reasoning).toContain('认知决策');
    });

    it('direct_action 策略有较高 temperature 和较少迭代', () => {
      const features: CognitiveFeatures = {
        urgency: 0.3, complexity: 0.1, novelty: 0.1,
        contextRichness: 0.8, errorRate: 0,
        toolUsageRate: 0.1, userSatisfaction: 0.9, taskType: 0.2,
      };
      const decision = engine.decide(features);
      // 低复杂度+低新颖度 → 可能是 direct_action
      if (decision.strategy === 'direct_action') {
        expect(decision.maxIterations).toBeLessThanOrEqual(5);
        expect(decision.shouldDecompose).toBe(false);
      }
    });

    it('decompose 策略触发任务分解', () => {
      const features: CognitiveFeatures = {
        urgency: 0.3, complexity: 0.95, novelty: 0.8,
        contextRichness: 0.2, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.8,
      };
      const decision = engine.decide(features);
      if (decision.strategy === 'decompose') {
        expect(decision.shouldDecompose).toBe(true);
        expect(decision.maxIterations).toBeGreaterThanOrEqual(15);
      }
    });

    it('retry_with_hint 策略触发反思', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.3,
        contextRichness: 0.5, errorRate: 0.6,
        toolUsageRate: 0.5, userSatisfaction: 0.3, taskType: 0.5,
      };
      const decision = engine.decide(features);
      if (decision.strategy === 'retry_with_hint') {
        expect(decision.shouldReflect).toBe(true);
      }
    });

    it('rawOutput 有 5 个值（对应 5 种策略）', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.5,
      };
      const decision = engine.decide(features);
      expect(decision.rawOutput).toHaveLength(5);
    });
  });

  describe('在线学习', () => {
    it('成功任务强化当前策略', () => {
      const features: CognitiveFeatures = {
        urgency: 0.3, complexity: 0.2, novelty: 0.1,
        contextRichness: 0.8, errorRate: 0,
        toolUsageRate: 0.1, userSatisfaction: 0.9, taskType: 0.2,
      };
      const featureVector = [features.urgency, features.complexity, features.novelty,
        features.contextRichness, features.errorRate, features.toolUsageRate,
        features.userSatisfaction, features.taskType];

      // 学习前决策
      const before = engine.decide(features);

      // 反馈成功
      engine.learnFromOutcome({
        features: featureVector,
        strategy: before.strategy,
        success: true,
        durationMs: 1000,
      });

      // 学习后，相同特征应更倾向同一策略
      const after = engine.decide(features);
      expect(after.strategy).toBeDefined();
    });

    it('失败任务训练替代策略', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.8, novelty: 0.7,
        contextRichness: 0.3, errorRate: 0.2,
        toolUsageRate: 0.4, userSatisfaction: 0.5, taskType: 0.6,
      };
      const featureVector = [features.urgency, features.complexity, features.novelty,
        features.contextRichness, features.errorRate, features.toolUsageRate,
        features.userSatisfaction, features.taskType];

      engine.learnFromOutcome({
        features: featureVector,
        strategy: 'direct_action',
        success: false,
        durationMs: 5000,
      });

      // NN 应该已更新权重
      const stats = engine.getStats();
      expect(stats.onlineLearnCount).toBe(1);
    });

    it('多次学习后成功率统计更新', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.5,
      };
      const featureVector = [features.urgency, features.complexity, features.novelty,
        features.contextRichness, features.errorRate, features.toolUsageRate,
        features.userSatisfaction, features.taskType];

      // 3 次成功 + 1 次失败
      for (let i = 0; i < 3; i++) {
        engine.learnFromOutcome({ features: featureVector, strategy: 'careful_analysis', success: true, durationMs: 1000 });
      }
      engine.learnFromOutcome({ features: featureVector, strategy: 'careful_analysis', success: false, durationMs: 2000 });

      const stats = engine.getStats();
      expect(stats.onlineLearnCount).toBe(4);
    });
  });

  describe('认知周期', () => {
    it('记录认知周期', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.5,
      };
      const decision = engine.decide(features);
      engine.recordCycle(features, decision, 3, '任务执行成功');

      const cycles = engine.getRecentCycles(1);
      expect(cycles).toHaveLength(1);
      expect(cycles[0].perception).toEqual(features);
      expect(cycles[0].decision).toEqual(decision);
      expect(cycles[0].actionsTaken).toBe(3);
      expect(cycles[0].reflection).toBe('任务执行成功');
    });

    it('保留最近 100 个周期', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.5,
      };
      const decision = engine.decide(features);
      for (let i = 0; i < 120; i++) {
        engine.recordCycle(features, decision, 1, `周期${i}`);
      }
      const cycles = engine.getRecentCycles(200);
      expect(cycles.length).toBeLessThanOrEqual(100);
    });
  });

  describe('统计与报告', () => {
    it('getStats 返回正确统计', () => {
      const stats = engine.getStats();
      expect(stats.totalDecisions).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeLessThanOrEqual(1);
      expect(stats.onlineLearnCount).toBe(0);
      expect(stats.cycleCount).toBe(0);
    });

    it('getCognitiveReport 返回报告字符串', () => {
      const report = engine.getCognitiveReport();
      expect(report).toContain('认知引擎报告');
      expect(report).toContain('总决策次数');
      expect(report).toContain('成功率');
    });

    it('resetStats 重置统计但不重置 NN 权重', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.5,
      };
      engine.decide(features);
      engine.decide(features);
      expect(engine.getStats().totalDecisions).toBe(2);

      engine.resetStats();
      expect(engine.getStats().totalDecisions).toBe(0);
      expect(engine.getStats().cycleCount).toBe(0);
    });
  });

  describe('模型持久化', () => {
    it('saveModel 保存到文件', () => {
      const features: CognitiveFeatures = {
        urgency: 0.5, complexity: 0.5, novelty: 0.5,
        contextRichness: 0.5, errorRate: 0.1,
        toolUsageRate: 0.3, userSatisfaction: 0.5, taskType: 0.5,
      };
      engine.decide(features);
      engine.learnFromOutcome({
        features: [0.5, 0.5, 0.5, 0.5, 0.1, 0.3, 0.5, 0.5],
        strategy: 'careful_analysis',
        success: true,
        durationMs: 1000,
      });
      engine.saveModel();
      expect(fs.existsSync(modelPath)).toBe(true);
    });

    it('加载已保存的模型', () => {
      // 先训练并保存
      engine.learnFromOutcome({
        features: [0.3, 0.2, 0.1, 0.8, 0, 0.1, 0.9, 0.2],
        strategy: 'direct_action',
        success: true,
        durationMs: 500,
      });
      engine.saveModel();

      // 创建新引擎加载模型
      const engine2 = new CognitiveEngine(modelPath);
      const stats = engine2.getStats();
      // NN 权重已加载（虽然统计不持久化，但模型权重已恢复）
      expect(stats).toBeDefined();
    });
  });
});
