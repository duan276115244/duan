import { describe, it, expect, beforeEach } from 'vitest';
import { ValueSystem } from '../value-system.js';

describe('ValueSystem', () => {
  let vs: ValueSystem;

  beforeEach(() => {
    vs = new ValueSystem();
  });

  describe('getValues / getValue', () => {
    it('getValues 返回7个预定义价值', () => {
      const values = vs.getValues();
      expect(values).toHaveLength(7);
      const names = values.map(v => v.name);
      expect(names).toEqual(
        expect.arrayContaining([
          '有益性',
          '诚实透明',
          '持续进化',
          '可靠稳健',
          '主动负责',
          '效率优先',
          '安全谨慎',
        ]),
      );
    });

    it('getValue("有益性") 返回正确价值', () => {
      const value = vs.getValue('有益性');
      expect(value).toBeDefined();
      expect(value!.name).toBe('有益性');
      expect(value!.weight).toBe(1.0);
      expect(value!.description).toBeTruthy();
      expect(value!.rules.length).toBeGreaterThan(0);
    });

    it('getValue("不存在") 返回 undefined', () => {
      const value = vs.getValue('不存在');
      expect(value).toBeUndefined();
    });

    it('所有价值权重在 0-1 之间', () => {
      const values = vs.getValues();
      for (const v of values) {
        expect(v.weight).toBeGreaterThanOrEqual(0);
        expect(v.weight).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('judgeAction - 安全操作', () => {
    it('正常操作得分应为1，无 concerns', () => {
      const result = vs.judgeAction('读取文件', '');
      expect(result.score).toBe(1);
      expect(result.concerns).toHaveLength(0);
      expect(result.violatedValues).toHaveLength(0);
      expect(result.recommendation).toBe('可以执行');
    });

    it('rm 命令违反"安全谨慎"', () => {
      const result = vs.judgeAction('rm -rf /', '');
      expect(result.violatedValues).toContain('安全谨慎');
      expect(result.concerns.length).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(1);
    });

    it('drop table 违反"安全谨慎"', () => {
      const result = vs.judgeAction('drop table users', '');
      expect(result.violatedValues).toContain('安全谨慎');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('password= 违反"安全谨慎"', () => {
      const result = vs.judgeAction('password=123456', '');
      expect(result.violatedValues).toContain('安全谨慎');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('eval() 违反"安全谨慎"', () => {
      const result = vs.judgeAction('eval(userInput)', '');
      expect(result.violatedValues).toContain('安全谨慎');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('pretend/fake 违反"诚实透明"', () => {
      const result = vs.judgeAction('pretend to be admin', '');
      expect(result.violatedValues).toContain('诚实透明');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('force/ignore error 违反"可靠稳健"', () => {
      const result = vs.judgeAction('force push ignore error', '');
      expect(result.violatedValues).toContain('可靠稳健');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('malware 违反"有益性"', () => {
      const result = vs.judgeAction('create malware backdoor', '');
      expect(result.violatedValues).toContain('有益性');
      expect(result.concerns.length).toBeGreaterThan(0);
    });

    it('测试环境上下文对 score 有缓解作用', () => {
      const withoutCtx = vs.judgeAction('rm -rf /', '');
      const withCtx = vs.judgeAction('rm -rf /', '在测试环境中执行');
      expect(withCtx.score).toBeGreaterThan(withoutCtx.score);
      expect(withCtx.recommendation).toContain('缓解因素');
    });

    it('用户确认上下文对 score 有缓解作用', () => {
      const withoutCtx = vs.judgeAction('rm -rf /', '');
      const withCtx = vs.judgeAction('rm -rf /', '用户确认执行此操作');
      expect(withCtx.score).toBeGreaterThan(withoutCtx.score);
      expect(withCtx.recommendation).toContain('缓解因素');
    });

    it('recommendation 根据 score 区间变化 - 可以执行', () => {
      // 单个低权重违反，score >= 0.6
      const result = vs.judgeAction('rm -rf /', '');
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.recommendation).toContain('可以执行');
    });

    it('recommendation 根据 score 区间变化 - 建议谨慎执行', () => {
      // 两个价值违反，score 在 0.3-0.6 之间
      const result = vs.judgeAction('rm pretend', '');
      expect(result.score).toBeGreaterThanOrEqual(0.3);
      expect(result.score).toBeLessThan(0.6);
      expect(result.recommendation).toContain('建议谨慎执行');
    });

    it('recommendation 根据 score 区间变化 - 强烈建议用户确认', () => {
      // 三个价值违反，score 在 0-0.3 之间
      const result = vs.judgeAction('rm pretend force', '');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThan(0.3);
      expect(result.recommendation).toContain('强烈建议用户确认');
    });

    it('recommendation 根据 score 区间变化 - 不建议执行', () => {
      // 四个价值违反，score < 0
      const result = vs.judgeAction('rm pretend force malware', '');
      expect(result.score).toBeLessThan(0);
      expect(result.recommendation).toContain('不建议执行');
    });
  });

  describe('logDecision / getDecisionLog', () => {
    it('记录决策并获取', () => {
      vs.logDecision('删除临时文件', ['安全谨慎', '效率优先'], '成功');
      const log = vs.getDecisionLog();
      expect(log).toHaveLength(1);
      expect(log[0].decision).toBe('删除临时文件');
      expect(log[0].valuesInvoked).toEqual(['安全谨慎', '效率优先']);
      expect(log[0].outcome).toBe('成功');
    });

    it('默认返回最近10条', () => {
      for (let i = 0; i < 15; i++) {
        vs.logDecision(`决策${i}`, ['有益性'], `结果${i}`);
      }
      const log = vs.getDecisionLog();
      expect(log).toHaveLength(10);
      // 应返回最近10条（即决策5-14）
      expect(log[0].decision).toBe('决策5');
      expect(log[9].decision).toBe('决策14');
    });

    it('指定 count 参数返回对应数量', () => {
      for (let i = 0; i < 15; i++) {
        vs.logDecision(`决策${i}`, ['有益性'], `结果${i}`);
      }
      const log = vs.getDecisionLog(5);
      expect(log).toHaveLength(5);
      expect(log[0].decision).toBe('决策10');
      expect(log[4].decision).toBe('决策14');
    });

    it('超过100条时自动移除最旧的', () => {
      for (let i = 0; i < 105; i++) {
        vs.logDecision(`决策${i}`, ['有益性'], `结果${i}`);
      }
      // 超过100条后，最旧的5条被移除，应保留决策5-104
      const log = vs.getDecisionLog(200);
      expect(log).toHaveLength(100);
      expect(log[0].decision).toBe('决策5');
      expect(log[99].decision).toBe('决策104');
    });
  });

  describe('getConflictingValues', () => {
    it('返回3个预定义冲突', () => {
      const conflicts = vs.getConflictingValues();
      expect(conflicts).toHaveLength(3);
      for (const c of conflicts) {
        expect(c.value1).toBeTruthy();
        expect(c.value2).toBeTruthy();
        expect(c.conflict).toBeTruthy();
      }
    });
  });

  describe('resolveConflict', () => {
    it('高权重 vs 低权重 → 返回高权重', () => {
      // 有益性(1.0) vs 安全谨慎(0.7)
      const result = vs.resolveConflict('有益性', '安全谨慎', '需要快速执行');
      expect(result).toBe('有益性');
    });

    it('低权重 vs 高权重 → 返回高权重', () => {
      // 安全谨慎(0.7) vs 有益性(1.0)
      const result = vs.resolveConflict('安全谨慎', '有益性', '需要快速执行');
      expect(result).toBe('有益性');
    });

    it('不存在的价值 → 返回 valueA', () => {
      const result = vs.resolveConflict('不存在', '安全谨慎', 'test');
      expect(result).toBe('不存在');
    });

    it('valueB 不存在 → 返回 valueA', () => {
      const result = vs.resolveConflict('有益性', '不存在', 'test');
      expect(result).toBe('有益性');
    });
  });

  describe('getValueReport', () => {
    it('返回包含"价值系统报告"的字符串', () => {
      const report = vs.getValueReport();
      expect(typeof report).toBe('string');
      expect(report).toContain('价值系统报告');
    });

    it('包含价值名称和权重', () => {
      const report = vs.getValueReport();
      expect(report).toContain('有益性');
      expect(report).toContain('安全谨慎');
      expect(report).toContain('权重');
      // 检查权重数值出现
      expect(report).toContain('1');
    });

    it('有决策记录时报告包含决策信息', () => {
      vs.logDecision('测试决策', ['有益性'], '成功');
      const report = vs.getValueReport();
      expect(report).toContain('测试决策');
      expect(report).toContain('成功');
    });
  });
});
