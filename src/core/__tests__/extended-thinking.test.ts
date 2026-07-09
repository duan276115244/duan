/**
 * P1-2: Extended Thinking 自动触发测试
 *
 * 测试复杂度检测 + 扩展思考生成逻辑
 *
 * Phase D1: 增加 runExtendedThinkingStream 流式变体测试
 */
import { describe, it, expect } from 'vitest';
import { EnhancedAgentLoop } from '../enhanced-agent-loop.js';
import {
  runExtendedThinkingStream,
  type ExtendedThinkingContext,
  type ThinkingPhaseEvent,
} from '../extended-thinking-service.js';

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

// ============================================================
// Phase D1: runExtendedThinkingStream 流式变体测试
// ============================================================

describe('Phase D1: runExtendedThinkingStream — 流式思考阶段', () => {
  /** 无记忆系统上下文（避免记忆检索副作用） */
  const noMemoryCtx: ExtendedThinkingContext = {
    memoryOrchestrator: null,
    searchMemoryWithCache: async () => [],
  };

  /** 收集流式阶段为列表 */
  async function collectStream(
    problem: string,
    depth: 'shallow' | 'medium' | 'deep',
  ): Promise<ThinkingPhaseEvent[]> {
    const phases: ThinkingPhaseEvent[] = [];
    for await (const phase of runExtendedThinkingStream(noMemoryCtx, problem, depth)) {
      phases.push(phase);
    }
    return phases;
  }

  describe('阶段 yield 顺序与内容', () => {
    it('shallow 深度仅 yield 问题分解 + 约束识别（2 个阶段）', async () => {
      const phases = await collectStream('实现一个简单功能', 'shallow');
      expect(phases.length).toBe(2);
      expect(phases[0].emoji).toBe('🧩');
      expect(phases[0].title).toBe('问题分解');
      expect(phases[1].emoji).toBe('🎯');
      expect(phases[1].title).toBe('约束识别');
    });

    it('medium 深度 yield 4 个阶段（含方案生成 + 边缘情况）', async () => {
      const phases = await collectStream('优化数据库查询性能', 'medium');
      expect(phases.length).toBe(4);
      expect(phases.map(p => p.title)).toEqual([
        '问题分解',
        '约束识别',
        expect.stringContaining('方案生成'),
        '边缘情况枚举',
      ]);
    });

    it('deep 深度 yield 5 个阶段（含风险评估）', async () => {
      const phases = await collectStream('重构核心架构', 'deep');
      expect(phases.length).toBe(5);
      expect(phases[4].emoji).toBe('⚠️');
      expect(phases[4].title).toBe('风险评估');
    });

    it('每个阶段 body 非空（除约束识别无约束场景）', async () => {
      const phases = await collectStream('实现功能', 'medium');
      // 问题分解至少有 1 个子问题（默认"分析核心需求和目标"）
      expect(phases[0].body.length).toBeGreaterThan(0);
      // 方案生成有内容
      const solutionsPhase = phases.find(p => p.title.includes('方案生成'));
      expect(solutionsPhase?.body.length).toBeGreaterThan(0);
    });

    it('约束识别为空时 body 含"未识别到明确约束"', async () => {
      const phases = await collectStream('简单任务', 'shallow');
      const constraintsPhase = phases.find(p => p.title === '约束识别');
      // "简单任务"无任何技术约束关键词 → 走默认 "无明显技术约束"
      expect(constraintsPhase?.body).toMatch(/未识别到明确约束|无明显技术约束/);
    });

    it('风险评估 body 含"并发安全"和"边界条件"', async () => {
      const phases = await collectStream('设计系统', 'deep');
      const riskPhase = phases.find(p => p.title === '风险评估');
      expect(riskPhase?.body).toContain('并发安全');
      expect(riskPhase?.body).toContain('边界条件');
      expect(riskPhase?.body).toContain('向后兼容');
    });

    it('方案生成阶段标题包含深度信息', async () => {
      const phases = await collectStream('优化性能', 'medium');
      const solutionsPhase = phases.find(p => p.title.includes('方案生成'));
      expect(solutionsPhase?.title).toContain('medium');
    });

    it('deep 深度方案生成 count=5（含备选方案兜底）', async () => {
      const phases = await collectStream('实现功能', 'deep');
      const solutionsPhase = phases.find(p => p.title.includes('方案生成'));
      // body 形如 "  方案1: ...\n  方案2: ..."，计数行数
      const solutionLines = solutionsPhase!.body.split('\n').filter(l => l.trim().startsWith('方案'));
      expect(solutionLines.length).toBe(5);
    });
  });

  describe('流式特性', () => {
    it('每个阶段作为独立 yield 事件返回（非字符串拼接）', async () => {
      const phases = await collectStream('实现功能', 'medium');
      // 验证返回的是结构化对象，而非拼接字符串
      phases.forEach(p => {
        expect(p).toHaveProperty('emoji');
        expect(p).toHaveProperty('title');
        expect(p).toHaveProperty('body');
        expect(typeof p.body).toBe('string');
        expect(typeof p.title).toBe('string');
        expect(p.emoji.length).toBeGreaterThan(0);
      });
    });

    it('阶段顺序固定：问题分解 → 约束识别 → 方案生成 → 边缘情况 → 风险评估', async () => {
      const phases = await collectStream('设计架构', 'deep');
      const titles = phases.map(p => p.title);
      // 验证前两阶段顺序固定
      expect(titles[0]).toBe('问题分解');
      expect(titles[1]).toBe('约束识别');
      // 方案生成在边缘情况之前
      const solutionsIdx = titles.findIndex(t => t.includes('方案生成'));
      const edgeIdx = titles.findIndex(t => t === '边缘情况枚举');
      const riskIdx = titles.findIndex(t => t === '风险评估');
      expect(solutionsIdx).toBeLessThan(edgeIdx);
      expect(edgeIdx).toBeLessThan(riskIdx);
    });

    it('无记忆系统时不 yield 相关经验阶段', async () => {
      const phases = await collectStream('实现功能', 'deep');
      const memoryPhase = phases.find(p => p.title === '相关经验');
      expect(memoryPhase).toBeUndefined();
    });

    it('有记忆系统时 yield 相关经验阶段', async () => {
      const mockMemories = [
        { type: 'pattern', content: '用户偏好简洁实现' },
        { type: 'lesson', content: '上次类似任务失败原因是并发问题' },
      ];
      const ctxWithMemory: ExtendedThinkingContext = {
        memoryOrchestrator: {} as unknown,
        searchMemoryWithCache: async () => mockMemories,
      };
      const phases: ThinkingPhaseEvent[] = [];
      for await (const phase of runExtendedThinkingStream(ctxWithMemory, '实现功能', 'medium')) {
        phases.push(phase);
      }
      const memoryPhase = phases.find(p => p.title === '相关经验');
      expect(memoryPhase).toBeDefined();
      expect(memoryPhase?.emoji).toBe('📚');
      expect(memoryPhase?.body).toContain('用户偏好简洁实现');
      expect(memoryPhase?.body).toContain('上次类似任务失败原因是并发问题');
    });

    it('记忆检索抛错时不影响其他阶段（容错）', async () => {
      const ctxWithError: ExtendedThinkingContext = {
        memoryOrchestrator: {} as unknown,
        searchMemoryWithCache: async () => {
          throw new Error('记忆系统故障');
        },
      };
      const phases: ThinkingPhaseEvent[] = [];
      for await (const phase of runExtendedThinkingStream(ctxWithError, '实现功能', 'medium')) {
        phases.push(phase);
      }
      // 仍应正常产出 4 个阶段（不含相关经验）
      expect(phases.length).toBe(4);
      expect(phases.find(p => p.title === '相关经验')).toBeUndefined();
    });

    it('记忆内容含 null content 时不崩溃（用 ?? 兜底）', async () => {
      const ctxWithNullContent: ExtendedThinkingContext = {
        memoryOrchestrator: {} as unknown,
        // @ts-expect-error — 测试 malformed data
        searchMemoryWithCache: async () => [{ type: 'pattern', content: null }],
      };
      const phases: ThinkingPhaseEvent[] = [];
      for await (const phase of runExtendedThinkingStream(ctxWithNullContent, '实现功能', 'medium')) {
        phases.push(phase);
      }
      // 相关经验阶段应正常 yield（不抛 TypeError）
      const memoryPhase = phases.find(p => p.title === '相关经验');
      expect(memoryPhase).toBeDefined();
    });
  });

  describe('与 _runExtendedThinking（向后兼容包装）一致性', () => {
    it('stream 拼接后内容包含原字符串方法返回的所有阶段标题', async () => {
      const loop = new EnhancedAgentLoop({});
      const problem = '设计微服务架构';
      const depth = 'deep' as const;

      // 1. 走兼容包装（_runExtendedThinking）
      const legacyResult = await (loop as unknown)._runExtendedThinking(problem, depth);

      // 2. 走流式接口 + 拼接
      const phases = await collectStream(problem, depth);
      const streamJoined = phases.map(p => `${p.emoji} ${p.title}\n${p.body}`).join('\n');

      // 两者的关键标题都应存在
      ['问题分解', '约束识别', '方案生成', '边缘情况枚举', '风险评估'].forEach(title => {
        expect(legacyResult).toContain(title);
        expect(streamJoined).toContain(title);
      });
    });
  });
});
