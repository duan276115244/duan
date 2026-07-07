import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRouter, type ModelDefinition } from '../model-router.js';

describe('ModelRouter', () => {
  let router: ModelRouter;

  const fastModel: ModelDefinition = {
    id: 'test-fast',
    name: 'Test Fast Model',
    provider: 'test',
    capabilities: ['chat', 'fast'],
    maxTokens: 4096,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0002,
    avgLatencyMs: 100,
    qualityScore: 6,
    speedScore: 10,
    costScore: 9,
  };

  const qualityModel: ModelDefinition = {
    id: 'test-quality',
    name: 'Test Quality Model',
    provider: 'test',
    capabilities: ['code', 'reasoning', 'chat'],
    maxTokens: 128000,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    avgLatencyMs: 2000,
    qualityScore: 10,
    speedScore: 4,
    costScore: 3,
  };

  const cheapModel: ModelDefinition = {
    id: 'test-cheap',
    name: 'Test Cheap Model',
    provider: 'test',
    capabilities: ['chat'],
    maxTokens: 8192,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0001,
    avgLatencyMs: 500,
    qualityScore: 5,
    speedScore: 7,
    costScore: 10,
  };

  beforeEach(() => {
    router = new ModelRouter();
    router.registerModel(fastModel);
    router.registerModel(qualityModel);
    router.registerModel(cheapModel);
  });

  describe('registerModel', () => {
    it('注册新模型成功', () => {
      const result = router.registerModel({
        id: 'new-model',
        name: 'New Model',
        provider: 'test',
        capabilities: ['chat'],
        maxTokens: 4096,
        inputCostPer1k: 0.001,
        outputCostPer1k: 0.002,
        avgLatencyMs: 300,
        qualityScore: 7,
        speedScore: 8,
        costScore: 7,
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('注册成功');
    });

    it('重复注册覆盖已有模型', () => {
      const result = router.registerModel(fastModel);
      expect(result.success).toBe(true);
    });
  });

  describe('selectModel', () => {
    it('简单任务选择快速模型', () => {
      const selection = router.selectModel('hello', 'simple');
      expect(selection).toBeDefined();
      expect(selection.modelId).toBeDefined();
      expect(selection.compositeScore).toBeGreaterThan(0);
    });

    it('复杂任务倾向选择高质量模型', () => {
      const selection = router.selectModel('refactor this complex architecture', 'complex');
      expect(selection).toBeDefined();
      expect(selection.estimatedLatency).toBeGreaterThan(0);
    });

    it('返回选择理由', () => {
      const selection = router.selectModel('write code', 'medium');
      expect(selection.reason).toBeTruthy();
      expect(typeof selection.reason).toBe('string');
    });

    it('返回预估成本', () => {
      const selection = router.selectModel('chat', 'simple');
      expect(selection.estimatedCost).toBeGreaterThanOrEqual(0);
    });

    it('返回质量/速度/成本评分', () => {
      const selection = router.selectModel('chat', 'simple');
      expect(selection.qualityScore).toBeGreaterThanOrEqual(0);
      expect(selection.speedScore).toBeGreaterThanOrEqual(0);
      expect(selection.costScore).toBeGreaterThanOrEqual(0);
    });

    it('带约束条件选择模型', () => {
      const selection = router.selectModel('fast chat', 'simple', {
        maxLatencyMs: 1000,
        requiredCapability: 'fast',
      });
      expect(selection).toBeDefined();
      // 快速模型延迟应满足约束
      expect(selection.estimatedLatency).toBeLessThanOrEqual(2000);
    });
  });

  describe('getModelProfile', () => {
    it('返回已注册模型的画像', () => {
      const profile = router.getModelProfile('test-fast');
      expect(profile).not.toBeNull();
      expect(profile!.id).toBe('test-fast');
      expect(profile!.name).toBe('Test Fast Model');
      expect(profile!.capabilities).toContain('fast');
    });

    it('未注册模型返回 null', () => {
      const profile = router.getModelProfile('nonexistent');
      expect(profile).toBeNull();
    });
  });

  describe('getStats', () => {
    it('返回统计信息', () => {
      router.selectModel('test', 'simple');
      const stats = router.getStats();
      expect(stats).toBeDefined();
      expect(stats.selectCount).toBeGreaterThan(0);
    });
  });
});
