import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { LearningEvalSystem } from '../learning-eval-system.js';
import { SkillGenerator } from '../skill-generator.js';
import { UnifiedUserProfileCenter } from '../unified-user-profile.js';

function uid(): string { return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`; }

function mockLLM(id: string, name: string, desc: string, cat: string, tags: string[]): () => Promise<string> {
  return async () => `---
id: ${id}
name: ${name}
version: 1.0.0
description: ${desc}
category: ${cat}
tags: [${tags.join(', ')}]
requires: []
---
## 功能描述
${desc}

## 使用场景
Testing

## 工作流程
1. Step one
2. Step two

## 示例
- Input: test
- Output: result

## 注意事项
None`;
}

describe('E2E: LearningEvalSystem full pipeline', () => {
  let sys: LearningEvalSystem;

  beforeEach(() => { sys = new LearningEvalSystem({ load: false, persist: false }); });
  afterEach(() => { sys?.dispose(); });

  it('records snapshots across all 5 dimensions and generates valid report', () => {
    for (let i = 0; i < 60; i++) {
      sys.recordSnapshot({
        accuracy: 0.85 + Math.random() * 0.1,
        efficiency: 0.7 + Math.random() * 0.2,
        coverage: 0.8 + Math.random() * 0.15,
        retention: 0.75 + Math.random() * 0.2,
        adaptation: 0.6 + Math.random() * 0.3,
      }, 'e2e-test', 50 + i);
    }
    const report = sys.generateReport();
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.accuracy).toBeGreaterThan(0.8);
    expect(Object.keys(report.dimensionScores).length).toBe(5);
    expect(report.velocity).toBeGreaterThan(0);
    expect(typeof report.trend).toBe('string');
  });

  it('triggers accuracy warning when below target', () => {
    for (let i = 0; i < 60; i++) {
      sys.recordSnapshot({ accuracy: 0.5 + Math.random() * 0.1 }, 'low-acc', 10);
    }
    const report = sys.generateReport();
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.accuracyMet).toBe(false);
    expect(report.accuracy).toBeLessThan(0.9);
  });

  it('achieves accuracy target with high scores', () => {
    for (let i = 0; i < 60; i++) {
      sys.recordSnapshot({ accuracy: 0.92 + Math.random() * 0.05 }, 'high-acc', 100);
    }
    expect(sys.isAccuracyTargetMet()).toBe(true);
    const report = sys.generateReport();
    expect(report.accuracyMet).toBe(true);
    expect(report.warnings.filter(w => w.includes('准确率')).length).toBe(0);
  });

  it('completes A/B test with clear winner', () => {
    sys.createABTest({ id: 'e2e-ab', variantA: 'control', variantB: 'experiment', dimension: 'accuracy', minSampleSize: 10 });
    for (let i = 0; i < 10; i++) {
      sys.recordABResult('e2e-ab', 'A', 0.7 + Math.random() * 0.1);
      sys.recordABResult('e2e-ab', 'B', 0.85 + Math.random() * 0.1);
    }
    const test = sys.getABTest('e2e-ab');
    expect(test?.completedAt).toBeDefined();
    expect(test?.winner).toBe('B');
    expect(test?.effectSize).toBeGreaterThan(0);
    expect(test?.confidence).toBeGreaterThan(0);
  });

  it('exposes snapshots via public API', () => {
    for (let i = 0; i < 25; i++) {
      sys.recordSnapshot({ accuracy: 0.9, efficiency: 0.8 }, 'api-test', 10);
    }
    expect(sys.getSnapshotCount()).toBe(25);
    const snapshots = sys.getSnapshots(10, 0);
    expect(snapshots.length).toBe(10);
    expect(snapshots[0].timestamp).toBeGreaterThan(0);
    expect(snapshots[0].overall).toBeGreaterThan(0);
  });

  it('generates report with trend detection', () => {
    for (let i = 0; i < 30; i++) {
      sys.recordSnapshot({ accuracy: 0.8 + (i / 30) * 0.15 }, 'trend-up', 10);
    }
    const report = sys.generateReport();
    expect(report.trend).toBe('improving');
  });
});

describe('E2E: SkillGenerator full pipeline', () => {
  let gen: SkillGenerator;

  beforeEach(() => {
    // P0 D4.3 修复：使用临时目录避免加载/写入 ~/.duan/generated-skills/
    const sgTmp = path.join(os.tmpdir(), `jws-sg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    gen = new SkillGenerator({ dataDir: sgTmp });
  });

  it('generates a skill from natural language description', async () => {
    const id = uid();
    const meta = await gen.generateFromNL('Create email validator', mockLLM(id, 'EmailValidator', 'Validates emails', 'validation', ['email', 'regex']));
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe(id);
    expect(meta!.version).toBe('1.0.0');
    expect(meta!.category).toBe('validation');
  });

  it('lists all generated skills and finds newly created ones', async () => {
    const id1 = uid(); const id2 = uid(); const id3 = uid();
    await gen.generateFromNL('Parse JSON', mockLLM(id1, 'JsonParser', 'Parse JSON', 'data', ['json']));
    await gen.generateFromNL('Format dates', mockLLM(id2, 'DateFormatter', 'Format dates', 'development', ['date']));
    await gen.generateFromNL('HTTP wrapper', mockLLM(id3, 'HttpClient', 'HTTP wrapper', 'development', ['http']));
    const all = gen.listSkills();
    expect(all.find(s => s.id === id1)).toBeDefined();
    expect(all.find(s => s.id === id2)).toBeDefined();
    expect(all.find(s => s.id === id3)).toBeDefined();
  });

  it('retrieves skill content', async () => {
    const id = uid();
    await gen.generateFromNL('Test content', mockLLM(id, 'TestSkill', 'A test', 'test', ['test']));
    expect(gen.getSkill(id)).toBeDefined();
    expect(gen.getSkillContent(id)).toContain('TestSkill');
  });

  it('generates quality report with 4 dimensions', async () => {
    const id = uid();
    await gen.generateFromNL('Quality test', mockLLM(id, 'QualitySkill', 'Quality testing', 'qa', ['quality']));
    const meta = gen.getSkill(id);
    expect(meta).toBeDefined();
    for (let i = 0; i < 10; i++) {
      gen.recordExecution(meta!.id, true, 500);
    }
    const report = gen.generateQualityReport(meta!.id);
    expect(report).not.toBeNull();
    expect(report!.skillId).toBe(meta!.id);
    expect(report!.executionSuccessRate).toBe(1);
    expect(report!.overallScore).toBeGreaterThan(0);
    expect(report!.dimensions.correctness).toBeGreaterThan(0);
    expect(report!.dimensions.completeness).toBeGreaterThan(0);
    expect(report!.dimensions.usability).toBeGreaterThan(0);
    expect(report!.dimensions.performance).toBeGreaterThan(0);
  });

  it('maintains version history and supports rollback', async () => {
    const id = uid();
    await gen.generateFromNL('Version 1', mockLLM(id, 'RollbackSkill', 'v1', 'test', ['v1']));
    await gen.generateFromNL('Version 2', mockLLM(id, 'RollbackSkill', 'v2', 'test', ['v1']));
    await gen.generateFromNL('Version 3', mockLLM(id, 'RollbackSkill', 'v3', 'test', ['v1']));
    const versions = gen.getVersionHistory(id);
    expect(versions.length).toBe(3);
    expect(versions[0].version).toBe('1.0.0');
    expect(versions[1].version).toBe('1.0.1');
    expect(versions[2].version).toBe('1.0.2');
    expect(gen.rollback(id, '1.0.1')).toBe(true);
    expect(gen.getSkillContent(id)).toContain('v2');
  });

  it('deletes a skill cleanly', async () => {
    const id = uid();
    await gen.generateFromNL('Delete me', mockLLM(id, 'Deletable', 'will be deleted', 'test', ['delete']));
    expect(gen.getSkill(id)).toBeDefined();
    expect(gen.deleteSkill(id)).toBe(true);
    expect(gen.getSkill(id)).toBeUndefined();
    expect(gen.getSkillContent(id)).toBeNull();
  });

  it('sorts skills by success rate', async () => {
    const id1 = uid(); const id2 = uid(); const id3 = uid();
    await gen.generateFromNL('Low', mockLLM(id1, 'LowSkill', 'low', 'test', ['a']));
    await gen.generateFromNL('Medium', mockLLM(id2, 'MedSkill', 'med', 'test', ['b']));
    await gen.generateFromNL('High', mockLLM(id3, 'HighSkill', 'high', 'test', ['c']));
    gen.recordExecution(id1, true, 300);
    gen.recordExecution(id1, false, 300);
    gen.recordExecution(id2, true, 300);
    gen.recordExecution(id2, true, 300);
    gen.recordExecution(id3, true, 300);
    gen.recordExecution(id3, true, 300);
    gen.recordExecution(id3, true, 300);
    const sorted = gen.listSkills().filter(s => [id1, id2, id3].includes(s.id));
    expect(sorted[0].successRate).toBeGreaterThanOrEqual(sorted[1].successRate);
    expect(sorted[1].successRate).toBeGreaterThanOrEqual(sorted[2].successRate);
  });
});

describe('E2E: UnifiedUserProfileCenter full pipeline', () => {
  let profile: UnifiedUserProfileCenter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `jws-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    profile = new UnifiedUserProfileCenter({ dataDir: tmpDir });
  });

  afterEach(() => {
    profile?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('returns default profile for unknown user', () => {
    const p = profile.getProfile(uid());
    expect(p.userId).toBeTruthy();
    expect(p.behavioral.totalInteractions).toBe(0);
    expect(p.cognitive.preferredLanguages).toContain('中文');
  });

  it('syncs from personalization engine source', () => {
    const u = uid();
    profile.syncFromSource(u, {
      type: 'personalization',
      data: { expertiseLevel: 'advanced', preferredLanguages: ['Python', 'TypeScript'], interests: ['AI', 'testing'] },
    });
    const p = profile.getProfile(u);
    expect(p.cognitive.expertiseLevel).toBe('advanced');
    expect(p.cognitive.preferredLanguages).toContain('Python');
    expect(p.cognitive.interests).toContain('AI');
  });

  it('syncs from learning source', () => {
    const u = uid();
    profile.syncFromSource(u, {
      type: 'learning', data: {
        interests: ['coding', 'debugging', 'refactoring'],
        preferredLanguages: ['中文', 'English'],
      },
    });
    const p = profile.getProfile(u);
    expect(p.cognitive.interests).toContain('coding');
    expect(p.cognitive.preferredLanguages).toContain('English');
  });

  it('syncs from performance/task tracker source', () => {
    const u = uid();
    profile.syncFromSource(u, {
      type: 'task_tracker', data: { successRate: 0.92, avgResponseTime: 1800, satisfactionScore: 4.2, totalInteractions: 200 },
    });
    const p = profile.getProfile(u);
    expect(p.performance.taskSuccessRate).toBe(0.92);
    expect(p.performance.avgResponseTime).toBe(1800);
    expect(p.performance.satisfactionScore).toBe(4.2);
    expect(p.behavioral.totalInteractions).toBe(200);
  });

  it('records intents and builds prediction history', () => {
    const u = uid();
    const intents = [
      '写一个Python函数', '帮我优化代码', '解释这段代码', '写一个Python函数',
      '帮我调试程序', '解释这段代码', '写一个Python函数', '写一个单元测试',
    ];
    for (const intent of intents) {
      profile.recordIntent(u, intent);
    }
    const p = profile.getProfile(u);
    expect(p.behavioral.totalInteractions).toBe(0);
    expect(p.predictions?.nextIntent).toBeTruthy();
  });

  it('records task results and updates interaction stats', () => {
    const u = uid();
    profile.recordTaskResult(u, '写一个Python函数', true, ['python'], 1500);
    profile.recordTaskResult(u, '帮我优化代码', true, ['python'], 2000);
    profile.recordTaskResult(u, '解释这段代码', false, ['python'], 3000);
    const p = profile.getProfile(u);
    expect(p.behavioral.totalInteractions).toBe(3);
    expect(p.performance.taskSuccessRate).toBeCloseTo(2 / 3, 1);
  });

  it('returns personalized services from predictions', () => {
    const u = uid();
    profile.syncFromSource(u, {
      type: 'personalization',
      data: { expertiseLevel: 'intermediate', interests: ['web development', 'React', 'Node.js'] },
    });
    profile.recordIntent(u, 'build a web app');
    profile.recordIntent(u, 'build a web app');
    profile.recordIntent(u, 'build a web app');
    const p = profile.getProfile(u);
    expect(Array.isArray(p.predictions.personalizedServices)).toBe(true);
    expect(p.predictions.suggestedTopics.length).toBeGreaterThan(0);
  });

  it('syncs from multiple sources and merges correctly', () => {
    const u = uid();
    profile.syncFromSource(u, { type: 'personalization', data: { expertiseLevel: 'beginner', interests: ['Python'] } });
    profile.syncFromSource(u, { type: 'learning', data: { interests: ['Python', 'AI'], preferredLanguages: ['English'] } });
    profile.syncFromSource(u, { type: 'task_tracker', data: { totalInteractions: 50, successRate: 0.7, avgResponseTime: 2500 } });
    profile.recordIntent(u, '学习Python基础');
    const p = profile.getProfile(u);
    expect(p.behavioral.totalInteractions).toBeGreaterThanOrEqual(50);
    expect(p.cognitive.interests).toContain('Python');
    expect(p.cognitive.interests).toContain('AI');
    expect(typeof p.performance.taskSuccessRate).toBe('number');
  });

  it('handles profile for multiple distinct users', () => {
    const ua = uid(); const ub = uid(); const uc = uid();
    profile.recordTaskResult(ua, '写代码', true, ['python'], 1000);
    profile.syncFromSource(ub, { type: 'personalization', data: { expertiseLevel: 'beginner', interests: ['UI'] } });
    profile.syncFromSource(uc, { type: 'task_tracker', data: { totalInteractions: 5 } });
    expect(profile.getProfile(ua).behavioral.totalInteractions).toBe(1);
    expect(profile.getProfile(uc).behavioral.totalInteractions).toBe(5);
    expect(profile.getProfile(ua).userId).not.toBe(profile.getProfile(uc).userId);
  });
});

describe('E2E: Cross-module integration', () => {
  it('LearningEvalSystem snapshots produce consistent report', () => {
    const sys = new LearningEvalSystem({ load: false, persist: false });
    sys.recordSnapshot({ accuracy: 0.85, efficiency: 0.7, coverage: 0.9, retention: 0.8, adaptation: 0.6 }, 'integration', 100);
    sys.recordSnapshot({ accuracy: 0.88, efficiency: 0.72, coverage: 0.91, retention: 0.82, adaptation: 0.65 }, 'integration', 100);
    const report = sys.generateReport();
    expect(report.dimensionScores.accuracy).toBeCloseTo(0.865, 1);
    expect(report.dimensionScores.efficiency).toBeCloseTo(0.71, 1);
    const snapshots = sys.getSnapshots(1, 1);
    expect(snapshots[0].dimensions.accuracy).toBe(0.88);
    sys.dispose();
  });

  it('SkillGenerator records executions then generates quality report', async () => {
    const sgTmp2 = path.join(os.tmpdir(), `jws-sg2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const gen = new SkillGenerator({ dataDir: sgTmp2 });
    const id = uid();
    await gen.generateFromNL('Integration skill', mockLLM(id, 'IntegrationSkill', 'cross-module', 'integration', ['e2e']));
    for (let i = 0; i < 20; i++) {
      gen.recordExecution(id, i < 18, 300 + Math.random() * 200);
    }
    const report = gen.generateQualityReport(id);
    expect(report).not.toBeNull();
    expect(report!.executionSuccessRate).toBeCloseTo(0.9, 1);
    expect(report!.sampleSize).toBe(20);
  });

  it('UnifiedUserProfileCenter merges learning + task source data', () => {
    const mergeTmpDir = path.join(os.tmpdir(), `jws-merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const center = new UnifiedUserProfileCenter({ dataDir: mergeTmpDir });
    const u = uid();
    center.syncFromSource(u, { type: 'personalization', data: { interests: ['coding'], expertiseLevel: 'intermediate' } });
    center.syncFromSource(u, { type: 'learning', data: { interests: ['coding', 'debugging'], preferredLanguages: ['TypeScript'] } });
    center.syncFromSource(u, { type: 'task_tracker', data: { totalInteractions: 150, successRate: 0.85, avgResponseTime: 1500, satisfactionScore: 4.0 } });
    const p = center.getProfile(u);
    expect(p.behavioral.totalInteractions).toBe(150);
    expect(p.performance.taskSuccessRate).toBe(0.85);
    expect(p.performance.avgResponseTime).toBe(1500);
    expect(p.cognitive.interests).toContain('coding');
    expect(p.cognitive.interests).toContain('debugging');
    expect(p.cognitive.expertiseLevel).toBe('intermediate');
    center.stop();
    try { fs.rmSync(mergeTmpDir, { recursive: true, force: true }); } catch {}
  });
});
