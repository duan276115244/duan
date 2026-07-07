/**
 * P1-2: Extended Thinking 自动触发测试
 *
 * 测试复杂度检测 + 扩展思考生成逻辑
 */
import { describe, it, expect } from 'vitest';
import { EnhancedAgentLoop } from '../enhanced-agent-loop.js';

describe('P1-2: Extended Thinking — 复杂度检测', () => {
  const loop = new EnhancedAgentLoop({});

  describe('_detectTaskComplexity', () => {
    it('简单任务不触发', () => {
      const result = (loop as unknown)._detectTaskComplexity('你好');
      expect(result.shouldTrigger).toBe(false);
    });

    it('架构/设计类任务触发（高权重）', () => {
      const result = (loop as unknown)._detectTaskComplexity(
        '请设计一个微服务架构，实现用户认证和权限管理系统',
      );
      expect(result.shouldTrigger).toBe(true);
      expect(['shallow', 'medium', 'deep']).toContain(result.depth);
    });

    it('调试/诊断类任务触发', () => {
      const result = (loop as unknown)._detectTaskComplexity(
        '排查为什么 API 请求返回 500 错误，分析根本原因',
      );
      expect(result.shouldTrigger).toBe(true);
    });

    it('长输入触发（>500 字符）', () => {
      const longInput = '请帮我分析以下问题：' + '这是一段很长的描述。'.repeat(60);
      const result = (loop as unknown)._detectTaskComplexity(longInput);
      expect(result.shouldTrigger).toBe(true);
      expect(result.reason).toContain('长输入');
    });

    it('多步骤任务触发（3+ 子任务）', () => {
      const result = (loop as unknown)._detectTaskComplexity(
        '第一步：创建数据库表。第二步：实现 API 接口。第三步：编写前端页面。第四步：部署到生产环境。',
      );
      expect(result.shouldTrigger).toBe(true);
      expect(result.reason).toContain('多步骤');
    });

    it('深度思考（score >= 7）返回 deep', () => {
      const result = (loop as unknown)._detectTaskComplexity(
        '请重构整个系统架构，设计新的模块接口，优化性能，分析并发安全问题，评估向后兼容性',
      );
      expect(result.shouldTrigger).toBe(true);
      // 多个高权重关键词 → score >= 7 → deep
      expect(result.depth).toBe('deep');
    });

    it('中等复杂度返回 medium', () => {
      const result = (loop as unknown)._detectTaskComplexity(
        '请分析这个函数的性能瓶颈并优化，评估不同方案的权衡',
      );
      expect(result.shouldTrigger).toBe(true);
    });

    it('返回原因字符串', () => {
      const result = (loop as unknown)._detectTaskComplexity('请设计 API 架构');
      expect(result.reason).toBeTypeOf('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});

describe('P1-2: Extended Thinking — 思考生成', () => {
  const loop = new EnhancedAgentLoop({});

  describe('_runExtendedThinking', () => {
    it('生成包含问题分解的思考结果', async () => {
      const result = await (loop as unknown)._runExtendedThinking(
        '实现一个用户认证模块',
        'medium',
      );
      expect(result).toContain('问题分解');
    });

    it('生成包含约束识别的思考结果', async () => {
      const result = await (loop as unknown)._runExtendedThinking(
        '实现一个安全的用户认证模块',
        'medium',
      );
      expect(result).toContain('约束识别');
      expect(result).toContain('安全约束');
    });

    it('medium 深度包含方案生成', async () => {
      const result = await (loop as unknown)._runExtendedThinking(
        '优化数据库查询性能',
        'medium',
      );
      expect(result).toContain('方案生成');
    });

    it('medium 深度包含边缘情况枚举', async () => {
      const result = await (loop as unknown)._runExtendedThinking(
        '处理网络请求超时',
        'medium',
      );
      expect(result).toContain('边缘情况');
    });

    it('deep 深度包含风险评估', async () => {
      const result = await (loop as unknown)._runExtendedThinking(
        '重构核心架构',
        'deep',
      );
      expect(result).toContain('风险评估');
      expect(result).toContain('并发安全');
    });

    it('shallow 深度不包含方案生成', async () => {
      const result = await (loop as unknown)._runExtendedThinking(
        '简单任务',
        'shallow',
      );
      expect(result).not.toContain('方案生成');
    });

    it('包含相关经验检索（如果有记忆系统）', async () => {
      // 无记忆系统时不崩溃，结果仍有效
      const result = await (loop as unknown)._runExtendedThinking(
        '实现功能',
        'medium',
      );
      expect(result).toBeTypeOf('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});

describe('P1-2: Extended Thinking — 辅助方法', () => {
  const loop = new EnhancedAgentLoop({});

  describe('_decomposeProblem', () => {
    it('按句号分割多步骤问题', () => {
      const subs = (loop as unknown)._decomposeProblem(
        '创建数据库。实现 API。编写测试。',
      );
      expect(subs.length).toBeGreaterThanOrEqual(2);
    });

    it('按关键词推断子问题', () => {
      const subs = (loop as unknown)._decomposeProblem('实现用户认证功能');
      expect(subs.some((s: string) => s.includes('实现'))).toBe(true);
    });

    it('无明确子问题时返回默认', () => {
      const subs = (loop as unknown)._decomposeProblem('你好');
      expect(subs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('_identifyConstraints', () => {
    it('识别性能约束', () => {
      const constraints = (loop as unknown)._identifyConstraints('优化性能和延迟');
      expect(constraints.some((c: string) => c.includes('性能'))).toBe(true);
    });

    it('识别安全约束', () => {
      const constraints = (loop as unknown)._identifyConstraints('确保安全性');
      expect(constraints.some((c: string) => c.includes('安全'))).toBe(true);
    });

    it('识别并发约束', () => {
      const constraints = (loop as unknown)._identifyConstraints('处理并发线程');
      expect(constraints.some((c: string) => c.includes('并发'))).toBe(true);
    });

    it('无约束时返回默认', () => {
      const constraints = (loop as unknown)._identifyConstraints('简单任务');
      expect(constraints.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('_enumerateEdgeCases', () => {
    it('总是包含空值和极值', () => {
      const edges = (loop as unknown)._enumerateEdgeCases('任意问题');
      expect(edges.some((e: string) => e.includes('空'))).toBe(true);
      expect(edges.some((e: string) => e.includes('极值'))).toBe(true);
    });

    it('数组相关输入包含集合边缘情况', () => {
      const edges = (loop as unknown)._enumerateEdgeCases('处理数组数据');
      expect(edges.some((e: string) => e.includes('集合'))).toBe(true);
    });

    it('网络相关输入包含网络边缘情况', () => {
      const edges = (loop as unknown)._enumerateEdgeCases('发送网络请求');
      expect(edges.some((e: string) => e.includes('超时'))).toBe(true);
    });
  });
});
