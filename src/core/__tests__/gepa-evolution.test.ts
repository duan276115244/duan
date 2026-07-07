/**
 * P2-2: GEPA 自进化引擎测试
 *
 * 覆盖核心闭环：行为记录 → 效果评估 → 技能沉淀
 * 以及技能版本管理：版本升级/回滚/使用统计/导出
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GEPAEvolutionEngine, type BehaviorRecord } from '../gepa-evolution.js';

// ============ 测试工具 ============

let tmpDir: string;

function createEngine(): GEPAEvolutionEngine {
  return new GEPAEvolutionEngine(undefined, tmpDir);
}

function makeBehavior(overrides: Partial<Omit<BehaviorRecord, 'id' | 'timestamp'>> = {}) {
  return {
    taskType: 'coding',
    taskDescription: '实现一个排序函数',
    promptUsed: '请实现快速排序',
    toolCalls: [
      { tool: 'write_file', args: {}, success: true },
      { tool: 'run_tests', args: {}, success: true },
    ],
    result: 'success' as const,
    effectScore: 0.9,
    durationMs: 1500,
    ...overrides,
  };
}

// ============ 测试 ============

describe('GEPAEvolutionEngine', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gepa-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===== 行为记录 =====

  describe('行为记录 (recordBehavior)', () => {
    it('记录行为并返回 ID', () => {
      const engine = createEngine();
      const id = engine.recordBehavior(makeBehavior());
      expect(id).toMatch(/^beh_\d+_/);
    });

    it('记录多条行为', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ taskDescription: '任务1' }));
      engine.recordBehavior(makeBehavior({ taskDescription: '任务2' }));
      engine.recordBehavior(makeBehavior({ taskDescription: '任务3' }));

      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.totalBehaviors).toBe(3);
    });

    it('不同 taskType 的行为互不干扰', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ taskType: 'coding' }));
      engine.recordBehavior(makeBehavior({ taskType: 'debugging' }));

      expect(engine.evaluateBehaviorEffect('coding').totalBehaviors).toBe(1);
      expect(engine.evaluateBehaviorEffect('debugging').totalBehaviors).toBe(1);
    });

    it('超过 500 条时自动裁剪', () => {
      const engine = createEngine();
      for (let i = 0; i < 510; i++) {
        engine.recordBehavior(makeBehavior({ taskDescription: `任务${i}` }));
      }
      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.totalBehaviors).toBe(500);
    });
  });

  // ===== 效果评估 =====

  describe('效果评估 (evaluateBehaviorEffect)', () => {
    it('空记录返回默认值', () => {
      const engine = createEngine();
      const effect = engine.evaluateBehaviorEffect('nonexistent');
      expect(effect.totalBehaviors).toBe(0);
      expect(effect.successRate).toBe(0);
      expect(effect.avgEffectScore).toBe(0);
      expect(effect.improvementTrend).toBe('stable');
    });

    it('计算成功率', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ result: 'success', effectScore: 0.9 }));
      engine.recordBehavior(makeBehavior({ result: 'success', effectScore: 0.8 }));
      engine.recordBehavior(makeBehavior({ result: 'failure', effectScore: 0.2 }));

      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.totalBehaviors).toBe(3);
      expect(effect.successRate).toBeCloseTo(2 / 3, 2);
    });

    it('计算平均效果分数', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ effectScore: 0.6 }));
      engine.recordBehavior(makeBehavior({ effectScore: 0.8 }));

      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.avgEffectScore).toBeCloseTo(0.7, 2);
    });

    it('提取常见失败模式', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({
        result: 'failure',
        effectScore: 0.1,
        errorMessage: 'TypeError: Cannot read property of undefined',
      }));
      engine.recordBehavior(makeBehavior({
        result: 'failure',
        effectScore: 0.1,
        errorMessage: 'TypeError: Cannot read property of undefined',
      }));

      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.commonFailurePatterns.length).toBeGreaterThan(0);
      expect(effect.commonFailurePatterns[0]).toContain('TypeError');
    });

    it('检测改进趋势', () => {
      const engine = createEngine();
      // 前半段低分
      for (let i = 0; i < 5; i++) {
        engine.recordBehavior(makeBehavior({ effectScore: 0.3 }));
      }
      // 后半段高分
      for (let i = 0; i < 5; i++) {
        engine.recordBehavior(makeBehavior({ effectScore: 0.9 }));
      }

      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.improvementTrend).toBe('improving');
    });

    it('检测下降趋势', () => {
      const engine = createEngine();
      for (let i = 0; i < 5; i++) {
        engine.recordBehavior(makeBehavior({ effectScore: 0.9 }));
      }
      for (let i = 0; i < 5; i++) {
        engine.recordBehavior(makeBehavior({ effectScore: 0.3 }));
      }

      const effect = engine.evaluateBehaviorEffect('coding');
      expect(effect.improvementTrend).toBe('declining');
    });
  });

  // ===== 技能沉淀 =====

  describe('技能沉淀 (distillSkillFromBehavior)', () => {
    it('从成功行为中提炼技能', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({
        result: 'success',
        effectScore: 0.9,
        toolCalls: [
          { tool: 'write_file', args: {}, success: true },
          { tool: 'run_tests', args: {}, success: true },
        ],
      }));

      const skillId = engine.distillSkillFromBehavior('coding', 0.7);
      expect(skillId).not.toBeNull();
      expect(skillId).toMatch(/^skill_coding_\d+$/);
    });

    it('效果分数低于阈值时不提炼', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ effectScore: 0.5 }));

      const skillId = engine.distillSkillFromBehavior('coding', 0.7);
      expect(skillId).toBeNull();
    });

    it('无成功行为时不提炼', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({
        result: 'failure',
        effectScore: 0.2,
      }));

      const skillId = engine.distillSkillFromBehavior('coding', 0.7);
      expect(skillId).toBeNull();
    });

    it('提炼的技能包含工具调用模式', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({
        toolCalls: [
          { tool: 'write_file', args: {}, success: true },
          { tool: 'write_file', args: {}, success: true },
          { tool: 'run_tests', args: {}, success: true },
        ],
      }));

      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;
      const skill = engine.getSkillVersion(skillId)!;
      expect(skill.content).toContain('write_file');
      expect(skill.content).toContain('2 次');
    });

    it('提炼的技能包含元数据', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());

      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;
      const skill = engine.getSkillVersion(skillId)!;
      expect(skill.taskType).toBe('coding');
      expect(skill.version).toBe('1.0.0');
      expect(skill.sourceBehaviorIds.length).toBe(1);
      expect(skill.tags).toContain('distilled');
      expect(skill.tags).toContain('gepa');
    });

    it('同任务类型多次提炼触发版本升级', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const id1 = engine.distillSkillFromBehavior('coding', 0.7)!;

      engine.recordBehavior(makeBehavior());
      const id2 = engine.distillSkillFromBehavior('coding', 0.7)!;

      expect(id1).not.toBe(id2);
      const skill2 = engine.getSkillVersion(id2)!;
      expect(skill2.version).toBe('1.1.0');
    });
  });

  // ===== 技能版本管理 =====

  describe('技能版本管理', () => {
    it('列出技能所有版本', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const id1 = engine.distillSkillFromBehavior('coding', 0.7)!;
      engine.recordBehavior(makeBehavior());
      const id2 = engine.distillSkillFromBehavior('coding', 0.7)!;

      // 同一 skillId 的版本列表
      const versions1 = engine.listSkillVersions(id1);
      const versions2 = engine.listSkillVersions(id2);
      // id1 和 id2 是不同的 skillId（每次提炼生成新 ID）
      expect(versions1.length).toBe(1);
      expect(versions2.length).toBe(1);
    });

    it('回滚技能版本', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;
      const skill = engine.getSkillVersion(skillId)!;

      const rolled = engine.rollbackSkillVersion(skillId, skill.version);
      expect(rolled).toBe(true);
      // 回滚到当前版本后，版本数不变
      expect(engine.listSkillVersions(skillId).length).toBe(1);
    });

    it('回滚不存在的版本返回 false', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;

      const rolled = engine.rollbackSkillVersion(skillId, '99.0.0');
      expect(rolled).toBe(false);
    });

    it('记录技能使用统计', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;

      engine.recordSkillUsage(skillId, true, 0.95);
      const skill = engine.getSkillVersion(skillId)!;
      expect(skill.usageCount).toBe(1);
      expect(skill.successCount).toBe(1);
      expect(skill.effectScore).toBeCloseTo(0.95, 2);
    });

    it('多次使用后效果分数滑动平均', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ effectScore: 0.8 }));
      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;

      engine.recordSkillUsage(skillId, true, 0.9);
      engine.recordSkillUsage(skillId, true, 0.7);

      const skill = engine.getSkillVersion(skillId)!;
      expect(skill.usageCount).toBe(2);
      // (0.9 + 0.7) / 2 = 0.8
      expect(skill.effectScore).toBeCloseTo(0.8, 2);
    });
  });

  // ===== 技能查询 =====

  describe('技能查询', () => {
    it('按任务类型查找技能', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ taskType: 'coding' }));
      engine.distillSkillFromBehavior('coding', 0.7);

      engine.recordBehavior(makeBehavior({ taskType: 'debugging' }));
      engine.distillSkillFromBehavior('debugging', 0.7);

      const codingSkills = engine.findSkillsByTaskType('coding');
      const debuggingSkills = engine.findSkillsByTaskType('debugging');

      expect(codingSkills.length).toBe(1);
      expect(codingSkills[0].taskType).toBe('coding');
      expect(debuggingSkills.length).toBe(1);
      expect(debuggingSkills[0].taskType).toBe('debugging');
    });

    it('列出所有技能', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior({ taskType: 'coding' }));
      engine.distillSkillFromBehavior('coding', 0.7);
      engine.recordBehavior(makeBehavior({ taskType: 'testing' }));
      engine.distillSkillFromBehavior('testing', 0.7);

      const all = engine.listAllSkills();
      expect(all.length).toBe(2);
    });

    it('导出技能为 Markdown', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;

      const content = engine.exportSkillAsMarkdown(skillId);
      expect(content).not.toBeNull();
      expect(content).toContain('# 技能：coding');
    });

    it('导出技能到文件', () => {
      const engine = createEngine();
      engine.recordBehavior(makeBehavior());
      const skillId = engine.distillSkillFromBehavior('coding', 0.7)!;

      const outputPath = path.join(tmpDir, 'exported-skill.md');
      engine.exportSkillAsMarkdown(skillId, outputPath);
      expect(fs.existsSync(outputPath)).toBe(true);
      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(content).toContain('# 技能：coding');
    });
  });

  // ===== Prompt 查询 =====

  describe('Prompt 查询', () => {
    it('无进化历史时 getBestPrompt 返回 null', () => {
      const engine = createEngine();
      expect(engine.getBestPrompt('coding')).toBeNull();
    });

    it('无进化历史时 getEvolutionHistory 返回空数组', () => {
      const engine = createEngine();
      expect(engine.getEvolutionHistory('coding')).toEqual([]);
    });
  });

  describe('资源释放 (dispose)', () => {
    it('dispose 后技能和行为记录被清空', () => {
      const engine = createEngine();
      // 记录行为并沉淀技能
      engine.recordBehavior({
        taskType: 'coding',
        taskDescription: '测试任务',
        promptUsed: '写一个函数',
        toolCalls: [{ tool: 'file_write', args: {}, success: true }],
        result: 'success',
        effectScore: 0.9,
        durationMs: 1000,
      });
      engine.distillSkillFromBehavior('coding');
      expect(engine.findSkillsByTaskType('coding').length).toBeGreaterThan(0);

      engine.dispose();

      // dispose 后技能和状态被清空
      expect(engine.findSkillsByTaskType('coding')).toEqual([]);
      expect(engine.listAllSkills()).toEqual([]);
    });
  });
});
