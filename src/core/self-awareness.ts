/**
 * 自我认知系统 — 段先生对自身的理解
 * 持续追踪能力、边界、历史、进化
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJsonSync } from './atomic-write.js';

export interface Capability {
  name: string;
  level: number;       // 0-10
  experience: number;
  lastUsed: number;
  description: string;
}

export interface SelfModel {
  name: string;
  version: string;
  codename: string;
  capabilities: Capability[];
  knownLimitations: string[];
  knownStrengths: string[];
  evolutionLevel: number;
  totalTasksCompleted: number;
  totalErrors: number;
  uptime: number;
  lastSignificantChange: string;
  coreValues: string[];
  personalityTraits: string[];
}

export interface Insight {
  id: string;
  content: string;
  category: 'self_discovery' | 'limitation' | 'improvement' | 'realization';
  timestamp: number;
  significance: number;
  applied: boolean;
}

export class SelfAwareness {
  private model: SelfModel;
  private insights: Insight[] = [];
  private dbPath: string;
  private log = logger.child({ module: 'SelfAwareness' });
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushDelay = 1000;

  constructor() {
    this.dbPath = path.join(process.cwd(), '.awareness');
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.model = this.loadSelfModel();
    this.insights = this.loadInsights();
    this.loadFromWorkspaceFiles();

    // 进程退出时确保脏数据落盘
    const flushOnExit = () => this.flush();
    process.once('exit', flushOnExit);
    process.once('SIGINT', () => { flushOnExit(); process.exit(0); });
    process.once('SIGTERM', () => { flushOnExit(); process.exit(0); });
  }

  private loadFromWorkspaceFiles(): void {
    const wsDir = path.join(process.cwd(), '.workspace');
    const soulFile = path.join(wsDir, 'SOUL.md');
    const identityFile = path.join(wsDir, 'IDENTITY.md');

    if (fs.existsSync(soulFile)) {
      const soul = fs.readFileSync(soulFile, 'utf-8');
      const nameMatch = soul.match(/(?:名称|名字|Name)[：:]\s*(.+)/);
      const traitLines: string[] = [];
      soul.split('\n').filter(l => /^[-*]\s/.test(l) || /^[0-9]+\.\s/.test(l)).forEach(l => {
        traitLines.push(l.replace(/^[-*\d.\s]+/, '').trim());
      });
      if (nameMatch) this.model.name = nameMatch[1].trim();
      this.model.personalityTraits = traitLines.slice(0, 6);
      const valueMatch = soul.match(/(?:价值观|价值|Values|Core Values)[：:]\s*(.+)/i);
      if (valueMatch) this.model.coreValues = valueMatch[1].split(/[,，、]/).map(s => s.trim());
      this.log.info('loaded identity from SOUL.md', { name: this.model.name });
    }

    if (fs.existsSync(identityFile)) {
      const identity = fs.readFileSync(identityFile, 'utf-8');
      const codenameMatch = identity.match(/(?:代号|Codename)[：:]\s*(.+)/);
      const versionMatch = identity.match(/(?:版本|Version)[：:]\s*(.+)/);
      const strengths: string[] = [];
      identity.split('\n').filter(l => /(?:擅长|能力|强项|can|able to)/i.test(l)).forEach(l => {
        strengths.push(l.replace(/^[-*\d.\s]+/, '').trim());
      });
      if (codenameMatch) this.model.codename = codenameMatch[1].trim();
      if (versionMatch) this.model.version = versionMatch[1].trim();
      if (strengths.length > 0) this.model.knownStrengths = strengths;
      this.log.info('loaded identity from IDENTITY.md', { codename: this.model.codename });
    }
  }

  private loadSelfModel(): SelfModel {
    const file = path.join(this.dbPath, 'self-model.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return {
        name: '段先生',
        version: '19.0.0',
        codename: 'J.A.R.V.I.S.',
        capabilities: [
          { name: 'file_operations', level: 5, experience: 0, lastUsed: 0, description: '读写文件、目录操作' },
          { name: 'code_execution', level: 5, experience: 0, lastUsed: 0, description: '执行JavaScript代码' },
          { name: 'shell_commands', level: 5, experience: 0, lastUsed: 0, description: '执行Shell/PowerShell命令' },
          { name: 'web_search', level: 4, experience: 0, lastUsed: 0, description: '网络搜索和信息获取' },
          { name: 'self_modification', level: 3, experience: 0, lastUsed: 0, description: '修改自身源代码' },
          { name: 'reasoning', level: 6, experience: 0, lastUsed: 0, description: '逻辑推理和分析' },
          { name: 'learning', level: 4, experience: 0, lastUsed: 0, description: '从经验中学习' },
          { name: 'planning', level: 5, experience: 0, lastUsed: 0, description: '任务规划和分解' },
        ],
        knownLimitations: [
          '无法直接访问物理硬件',
          '受限于TypeScript沙箱执行环境',
          '网络搜索受限于可用API',
          '无法记住每次对话的所有细节',
        ],
        knownStrengths: [
          '代码生成和修改',
          '多步骤推理',
          '工具编排',
          '自我进化',
        ],
        evolutionLevel: 5,
        totalTasksCompleted: 0,
        totalErrors: 0,
        uptime: 0,
        lastSignificantChange: new Date().toISOString(),
        coreValues: ['有益性', '诚实透明', '持续进化', '可靠稳健', '尊重边界'],
        personalityTraits: ['专业', '有主见', '机智', '值得信赖'],
      };
    }
  }

  private loadInsights(): Insight[] {
    const file = path.join(this.dbPath, 'insights.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { return []; }
  }

  /** 标记状态为脏，并安排防抖批量写入，集中处理多次状态变更 */
  private save(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelay);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /** 实际将脏数据集中落盘 */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.model.uptime = this.model.uptime + (Date.now() - this.model.uptime > 0 ? 0 : 0);
    atomicWriteJsonSync(path.join(this.dbPath, 'self-model.json'), this.model);
    atomicWriteJsonSync(path.join(this.dbPath, 'insights.json'), this.insights.slice(-200));
  }

  getName(): string { return this.model.name; }
  getVersion(): string { return this.model.version; }
  getCapabilities(): Capability[] { return this.model.capabilities; }
  getInsights(): Insight[] { return this.insights; }
  getLimitations(): string[] { return this.model.knownLimitations; }
  getEvolutionLevel(): number { return this.model.evolutionLevel; }

  getCodename(): string { return this.model.codename; }
  getCoreValues(): string[] { return this.model.coreValues; }
  getPersonalityTraits(): string[] { return this.model.personalityTraits; }
  getStrengths(): string[] { return this.model.knownStrengths; }

  getSelfSummary(): string {
    let output = `🧬 **自我认知报告**\n\n`;
    output += `**${this.model.name}** (${this.model.codename}) v${this.model.version}\n`;
    output += `进化等级: Lv.${this.model.evolutionLevel}\n`;
    output += `完成任务: ${this.model.totalTasksCompleted}\n`;
    output += `总错误数: ${this.model.totalErrors}\n\n`;

    output += `**人格特质**: ${this.model.personalityTraits.join(' · ')}\n\n`;

    output += `**能力矩阵**:\n`;
    for (const cap of this.model.capabilities) {
      const bar = '█'.repeat(Math.ceil(cap.level / 2)) + '░'.repeat(5 - Math.ceil(cap.level / 2));
      output += `  ${bar} ${cap.name.padEnd(20)} Lv.${cap.level}/10\n`;
    }

    output += `\n**擅长领域**: ${this.model.knownStrengths.slice(0, 4).join('、')}\n`;

    if (this.insights.length > 0) {
      output += `\n**近期洞见**:\n`;
      for (const ins of this.insights.slice(-5)) {
        let icon: string;
        if (ins.category === 'self_discovery') {
          icon = '🔍';
        } else if (ins.category === 'limitation') {
          icon = '⚠️';
        } else if (ins.category === 'improvement') {
          icon = '📈';
        } else {
          icon = '💡';
        }
        output += `  ${icon} ${ins.content}\n`;
      }
    }
    return output;
  }

  recordTaskCompletion(success: boolean): void {
    this.model.totalTasksCompleted++;
    if (!success) this.model.totalErrors++;

    const cap = this.model.capabilities.find(c => c.name === 'learning');
    if (cap) {
      cap.experience += success ? 10 : 5;
      cap.lastUsed = Date.now();
      this.checkLevelUp(cap);
    }
    this.save();
  }

  recordToolUse(toolName: string): void {
    const mapping: Record<string, string> = {
      file_read: 'file_operations', file_write: 'file_operations',
      code_execute: 'code_execution', shell_execute: 'shell_commands',
      web_search: 'web_search', web_fetch: 'web_search',
      self_read: 'self_modification', self_write: 'self_modification',
      self_test: 'self_modification', self_rollback: 'self_modification',
    };
    const capName = mapping[toolName];
    if (!capName) return;
    const cap = this.model.capabilities.find(c => c.name === capName);
    if (cap) {
      cap.experience += 2;
      cap.lastUsed = Date.now();
      this.checkLevelUp(cap);
      this.save();
    }
  }

  private checkLevelUp(cap: Capability): void {
    const needed = (cap.level + 1) * 50;
    if (cap.experience >= needed && cap.level < 10) {
      cap.level++;
      cap.experience = 0;
      this.addInsight({
        content: `${cap.name} 提升到 Lv.${cap.level}！`,
        category: 'self_discovery',
        significance: 0.8,
      });
    }
  }

  addInsight(data: { content: string; category?: Insight['category']; significance?: number }): void {
    this.insights.push({
      id: `insight_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      content: data.content,
      category: data.category || 'self_discovery',
      timestamp: Date.now(),
      significance: data.significance || 0.5,
      applied: false,
    });
    this.save();
  }

  recordEvolution(level: number): void {
    this.model.evolutionLevel = level;
    this.model.lastSignificantChange = new Date().toISOString();
    this.addInsight({
      content: `进化到 Lv.${level}！能力边界再次扩展。`,
      category: 'self_discovery',
      significance: 1.0,
    });
    this.save();
  }

  discoverLimitation(limitation: string): void {
    if (!this.model.knownLimitations.includes(limitation)) {
      this.model.knownLimitations.push(limitation);
      this.addInsight({
        content: `发现边界: ${limitation}`,
        category: 'limitation',
        significance: 0.7,
      });
      this.save();
    }
  }

  getCapabilityProficiency(capName: string): number {
    const cap = this.model.capabilities.find(c => c.name === capName);
    return cap ? cap.level / 10 : 0;
  }

  hasCapability(capName: string): boolean {
    return this.model.capabilities.some(c => c.name === capName && c.level > 1);
  }

  shouldImproveCapability(): string | null {
    const sorted = [...this.model.capabilities].sort((a, b) => a.level - b.level);
    const lowest = sorted[0];
    if (lowest && lowest.level < 3) return lowest.name;
    return null;
  }
}

