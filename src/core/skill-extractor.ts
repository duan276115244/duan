import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  steps: string[];
  toolsUsed: string[];
  tags: string[];
  successCount: number;
  failCount: number;
  created: number;
  lastUsed: number;
  source: 'auto_extracted' | 'manual' | 'predefined';
}

export class SkillExtractor {
  private skills: Map<string, Skill> = new Map();
  private dbPath: string;
  private extractLogPath: string;

  constructor() {
    this.dbPath = path.join(process.cwd(), '.awareness', 'skills.json');
    this.extractLogPath = path.join(process.cwd(), '.learnings', 'EXTRACTED_SKILLS.md');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.extractLogPath), { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
      if (Array.isArray(data)) for (const s of data) this.skills.set(s.id, s);
    } catch {}
  }

  private save(): void {
    atomicWriteJsonSync(this.dbPath, Array.from(this.skills.values()));
  }

  private genId(): string {
    return `skill_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  extractSkill(params: {
    name: string;
    description: string;
    category: string;
    steps: string[];
    toolsUsed: string[];
    tags: string[];
  }): Skill {
    const existing = Array.from(this.skills.values()).find(s =>
      s.name === params.name || s.description === params.description
    );
    if (existing) {
      existing.successCount++;
      existing.lastUsed = Date.now();
      this.save();
      return existing;
    }

    const skill: Skill = {
      id: this.genId(),
      name: params.name,
      description: params.description,
      category: params.category,
      steps: params.steps,
      toolsUsed: params.toolsUsed,
      tags: params.tags,
      successCount: 1,
      failCount: 0,
      created: Date.now(),
      lastUsed: Date.now(),
      source: 'auto_extracted',
    };
    this.skills.set(skill.id, skill);
    this.save();
    this.appendToLog(skill);
    return skill;
  }

  private appendToLog(skill: Skill): void {
    const md = `\n## ${skill.name} (${new Date().toISOString()})\n- **描述**: ${skill.description}\n- **分类**: ${skill.category}\n- **步骤**:\n${skill.steps.map(s => `  - ${s}`).join('\n')}\n- **工具**: ${skill.toolsUsed.join(', ')}\n`;
    try { fs.appendFileSync(this.extractLogPath, md, 'utf-8'); } catch {}
  }

  recordFail(skillId: string): void {
    const s = this.skills.get(skillId);
    if (s) { s.failCount++; this.save(); }
  }

  getSkills(options?: { category?: string; tag?: string; top?: number }): Skill[] {
    let result = Array.from(this.skills.values());
    if (options?.category) result = result.filter(s => s.category === options.category);
    if (options?.tag) result = result.filter(s => s.tags.includes(options.tag!));
    result.sort((a, b) => (b.successCount / (b.successCount + b.failCount || 1)) - (a.successCount / (a.successCount + a.failCount || 1)));
    return result.slice(0, options?.top || 20);
  }

  /** 从任务中自动萃取技能 */
  autoExtract(taskDescription: string, toolsUsed: string[], result: string): Skill | null {
    if (toolsUsed.length < 2 || !result || result.length < 20) return null;
    const domain = taskDescription.length > 20 ? taskDescription.substring(0, 20) + '...' : taskDescription;
    const safeName = domain.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').substring(0, 20) || 'auto_skill';
    return this.extractSkill({
      name: safeName,
      description: taskDescription.substring(0, 200),
      category: this.inferCategory(taskDescription, toolsUsed),
      steps: [`理解需求: ${taskDescription.substring(0, 100)}`, ...toolsUsed.map(t => `使用 ${t} 工具执行`)],
      toolsUsed,
      tags: [this.inferCategory(taskDescription, toolsUsed), ...toolsUsed],
    });
  }

  private inferCategory(task: string, tools: string[]): string {
    if (task.includes('代码') || task.includes('开发') || task.includes('bug') || task.includes('编译')) return 'development';
    if (task.includes('搜索') || task.includes('查询') || task.includes('找')) return 'research';
    if (task.includes('配置') || task.includes('设置') || task.includes('安装')) return 'configuration';
    if (task.includes('分析') || task.includes('诊断') || task.includes('测试')) return 'analysis';
    if (tools.some(t => t.includes('write') || t.includes('modify'))) return 'development';
    if (tools.some(t => t.includes('search') || t.includes('fetch'))) return 'research';
    return 'general';
  }

  getSkillContext(task: string): string {
    const relevant = Array.from(this.skills.values())
      .filter(s => task.includes(s.category) || s.tags.some(t => task.includes(t)))
      .sort((a, b) => b.successCount - a.successCount)
      .slice(0, 3);

    if (relevant.length === 0) return '';

    return `## 📚 相关技能经验\n${relevant.map(s =>
      `- ${s.name}: ${s.description.substring(0, 100)} (成功率: ${(s.successCount / (s.successCount + s.failCount || 1) * 100).toFixed(0)}%)`
    ).join('\n')}\n`;
  }

  getStats(): string {
    const total = this.skills.size;
    if (total === 0) return '📚 尚无萃取技能。完成任务后会自动生成。';
    const byCat = new Map<string, number>();
    for (const s of this.skills.values()) byCat.set(s.category, (byCat.get(s.category) || 0) + 1);
    const cats = Array.from(byCat.entries()).map(([k, v]) => `${k}=${v}`).join(', ');
    const top = Array.from(this.skills.values()).sort((a, b) => b.successCount - a.successCount).slice(0, 5);
    return `📚 技能萃取: ${total}个技能\n分类: ${cats}\n\n最常用:\n${top.map(s => `  ✅ ${s.name} (${s.successCount}次成功, ${s.failCount}次失败)`).join('\n')}`;
  }

  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }
}
