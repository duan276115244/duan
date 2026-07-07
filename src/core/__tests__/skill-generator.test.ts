import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { SkillGenerator } from '../skill-generator.js';

function uid(): string { return `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

// P0 D4.3 修复：使用唯一临时目录避免持久化状态干扰测试 + 污染用户目录
const tmpDir = path.join(os.tmpdir(), `skill-gen-test-${process.pid}-${Date.now()}`);

describe('SkillGenerator', () => {
  let gen: SkillGenerator;

  beforeEach(() => {
    gen = new SkillGenerator({ dataDir: tmpDir });
  });

  it('returns an array from list', () => {
    expect(Array.isArray(gen.listSkills())).toBe(true);
  });

  it('returns undefined for non-existent skill', () => {
    expect(gen.getSkill('nonexistent-' + uid())).toBeUndefined();
  });

  it('returns null content for non-existent skill', () => {
    expect(gen.getSkillContent('nonexistent-' + uid())).toBeNull();
  });

  it('generates a skill from natural language description', async () => {
    const id = 'code-review-' + uid();
    const llmCall = async () => `---
id: ${id}
name: 代码审查助手
version: 1.0.0
description: 自动审查代码质量
category: development
tags: [code, review, quality]
requires: []
---
## 功能描述
自动审查代码并提供改进建议

## 使用场景
代码提交前审查

## 工作流程
1. 读取代码
2. 分析问题
3. 生成报告

## 示例
- 输入: 代码片段
- 输出: 审查报告

## 注意事项
- 仅支持主流语言`;
    const meta = await gen.generateFromNL('帮我审查代码', llmCall);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('代码审查助手');
    expect(meta!.version).toBe('1.0.0');
    expect(meta!.category).toBe('development');
    expect(meta!.tags).toContain('code');
  });

  it('returns generated skill by id', async () => {
    const id = 'test-skill-' + uid();
    const llmCall = async () => `---
id: ${id}
name: Test Skill
version: 1.0.0
description: A test skill
category: automation
tags: [test]
requires: []
---
content`;
    await gen.generateFromNL('test', llmCall);
    const skill = gen.getSkill(id);
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('Test Skill');
  });

  it('increments version on re-generation', async () => {
    const id = 'skill-ver-' + uid();
    const llmCall1 = async () => `---
id: ${id}
name: Skill One
version: 1.0.0
description: first
category: automation
tags: []
requires: []
---
content`;
    const llmCall2 = async () => `---
id: ${id}
name: Skill One Updated
version: 1.0.0
description: updated
category: automation
tags: []
requires: []
---
content v2`;
    await gen.generateFromNL('first', llmCall1);
    await gen.generateFromNL('updated', llmCall2);
    const skill = gen.getSkill(id);
    expect(skill!.version).toBe('1.0.1');
  });

  it('lists skills with most recent first', async () => {
    const id1 = 'skill-a-' + uid();
    const id2 = 'skill-b-' + uid();
    const llmCall1 = async () => `---
id: ${id1}
name: A
version: 1.0.0
description: first
category: automation
tags: []
requires: []
---
a`;
    const llmCall2 = async () => `---
id: ${id2}
name: B
version: 1.0.0
description: second
category: development
tags: []
requires: []
---
b`;
    await gen.generateFromNL('first', llmCall1);
    await gen.generateFromNL('second', llmCall2);
    const skills = gen.listSkills();
    const skillA = skills.find(s => s.id === id1);
    const skillB = skills.find(s => s.id === id2);
    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();
    expect(skills[0].id).toBe(id2);
  });

  it('generates quality report for existing skill', async () => {
    const id = 'quality-' + uid();
    const llmCall = async () => `---
id: ${id}
name: Quality Skill
version: 1.0.0
description: For quality testing
category: development
tags: [tested]
requires: []
---
## 功能描述
A detailed skill for testing quality reports with enough content to pass the length check.

## 使用场景
Testing scenarios

## 工作流程
1. Step one
2. Step two

## 示例
Example here

## 注意事项
Be careful`;
    const meta = await gen.generateFromNL('quality test', llmCall);
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
  });

  it('returns null quality report for non-existent skill', () => {
    expect(gen.generateQualityReport('no-skill-' + uid())).toBeNull();
  });

  it('provides rollback support', async () => {
    const id = 'rollback-' + uid();
    const llmCall1 = async () => `---
id: ${id}
name: Rollback Test
version: 1.0.0
description: version 1
category: automation
tags: []
requires: []
---
v1 content`;
    const llmCall2 = async () => `---
id: ${id}
name: Rollback Test Updated
version: 1.0.1
description: version 2
category: automation
tags: []
requires: []
---
v2 content`;
    await gen.generateFromNL('v1', llmCall1);
    await gen.generateFromNL('v2', llmCall2);
    const versions = gen.getVersionHistory(id);
    expect(versions.length).toBe(2);
    const ok = gen.rollback(id, '1.0.0');
    expect(ok).toBe(true);
    const content = gen.getSkillContent(id);
    expect(content).toContain('v1 content');
    expect(content).toContain('id: ' + id);
  });

  it('fails rollback for invalid version', () => {
    expect(gen.rollback('no-skill-' + uid(), '1.0.0')).toBe(false);
  });

  it('deletes a skill', async () => {
    const id = 'deletable-' + uid();
    const llmCall = async () => `---
id: ${id}
name: Deletable
version: 1.0.0
description: will be deleted
category: automation
tags: []
requires: []
---
content`;
    await gen.generateFromNL('delete me', llmCall);
    expect(gen.getSkill(id)).toBeDefined();
    const ok = gen.deleteSkill(id);
    expect(ok).toBe(true);
    expect(gen.getSkill(id)).toBeUndefined();
  });

  it('provides tool definitions with llmCall injection', async () => {
    const llmCall = async () => 'mock response';
    const tools = gen.getToolDefinitions(llmCall);
    expect(tools.length).toBe(4);
    expect(tools.map(t => t.name)).toEqual(['skill_generate', 'skill_list', 'skill_quality', 'skill_rollback']);
  });
});
