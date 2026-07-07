/**
 * ProjectContext — 项目级持久上下文系统
 *
 * 类似 Claude Code 的 CLAUDE.md，自动维护 PROJECT.md 项目配置文件，
 * 持久化记录项目决策、编码标准、关键事实，支持工具白名单/黑名单。
 * 自动从会话中提取关键信息，保持项目上下文持续更新。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface ProjectDecision {
  id: string;
  timestamp: number;
  summary: string;
  detail: string;
  category: string;
}

export interface ProjectStandard {
  category: 'coding_style' | 'naming' | 'architecture' | 'testing' | 'dependencies' | 'communication' | 'custom';
  rule: string;
  priority: 'must' | 'should' | 'could';
}

export interface ProjectContextData {
  projectName: string;
  description: string;
  techStack: string[];
  decisions: ProjectDecision[];
  standards: ProjectStandard[];
  facts: string[];
  preferences: string[];
  allowedTools: string[];
  blockedTools: string[];
  lastUpdated: number;
  sessionCount: number;
}

export interface ProjectContextSummary {
  projectName: string;
  techStack: string[];
  activeDecisions: number;
  standards: number;
  facts: number;
  allowedTools: number;
  blockedTools: number;
  sessionCount: number;
}

// ============ 默认值 ============

const DEFAULT_CONTEXT: ProjectContextData = {
  projectName: '',
  description: '',
  techStack: [],
  decisions: [],
  standards: [],
  facts: [],
  preferences: [],
  allowedTools: [],
  blockedTools: [],
  lastUpdated: Date.now(),
  sessionCount: 0,
};

// ============ 主类 ============

export class ProjectContext {
  private data: ProjectContextData;
  private projectRoot: string;
  private markdownPath: string;
  private jsonPath: string;
  private eventBus: EventBus;
  private log = logger.child({ module: 'ProjectContext' });
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
    this.markdownPath = path.join(this.projectRoot, 'PROJECT.md');
    this.jsonPath = path.join(this.projectRoot, '.duan', 'project-context.json');
    this.eventBus = EventBus.getInstance();
    this.data = { ...DEFAULT_CONTEXT, lastUpdated: Date.now() };
    this.load();
  }

  // ============ 公共接口 ============

  /** 获取完整上下文数据 */
  getData(): ProjectContextData {
    return { ...this.data };
  }

  /** 获取上下文摘要 */
  getSummary(): ProjectContextSummary {
    return {
      projectName: this.data.projectName,
      techStack: [...this.data.techStack],
      activeDecisions: this.data.decisions.length,
      standards: this.data.standards.length,
      facts: this.data.facts.length,
      allowedTools: this.data.allowedTools.length,
      blockedTools: this.data.blockedTools.length,
      sessionCount: this.data.sessionCount,
    };
  }

  /** 获取系统提示片段 — 注入到 agent 的 system prompt */
  getSystemPromptAddition(): string {
    const parts: string[] = [];

    if (this.data.projectName) {
      parts.push(`## 项目: ${this.data.projectName}`);
    }

    if (this.data.techStack.length > 0) {
      parts.push(`技术栈: ${this.data.techStack.join(', ')}`);
    }

    if (this.data.standards.length > 0) {
      parts.push('\n### 编码规范');
      for (const s of this.data.standards.slice(0, 10)) {
        parts.push(`- [${s.priority}] [${s.category}] ${s.rule}`);
      }
    }

    if (this.data.facts.length > 0) {
      parts.push('\n### 项目关键事实');
      for (const f of this.data.facts.slice(0, 15)) {
        parts.push(`- ${f}`);
      }
    }

    if (this.data.decisions.length > 0) {
      parts.push('\n### 已做出的决策（请遵守）');
      for (const d of this.data.decisions.slice(-8)) {
        parts.push(`- ${d.summary}`);
      }
    }

    if (this.data.preferences.length > 0) {
      parts.push('\n### 用户偏好');
      for (const p of this.data.preferences.slice(0, 5)) {
        parts.push(`- ${p}`);
      }
    }

    if (this.data.blockedTools.length > 0) {
      parts.push(`\n禁止使用的工具: ${this.data.blockedTools.join(', ')}`);
    }

    if (this.data.allowedTools.length > 0) {
      parts.push(`\n仅允许使用的工具: ${this.data.allowedTools.join(', ')}`);
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /** 检查工具是否被允许 */
  isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
    if (this.data.blockedTools.includes(toolName)) {
      return { allowed: false, reason: `${toolName} 已被项目禁止使用` };
    }
    if (this.data.allowedTools.length > 0 && !this.data.allowedTools.includes(toolName)) {
      return { allowed: false, reason: `项目只允许使用以下工具: ${this.data.allowedTools.join(', ')}` };
    }
    return { allowed: true };
  }

  /** 添加决策 */
  addDecision(summary: string, detail: string, category: string = 'general'): string {
    const id = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.data.decisions.push({ id, timestamp: Date.now(), summary, detail, category });
    this.markDirty();
    this.eventBus.emitSync('projectcontext.decision.added', {
      id, summary, category,
    }, { source: 'ProjectContext' });
    return id;
  }

  /** 添加编码规范 */
  addStandard(category: ProjectStandard['category'], rule: string, priority: ProjectStandard['priority'] = 'should'): void {
    this.data.standards.push({ category, rule, priority });
    this.markDirty();
  }

  /** 添加关键事实 */
  addFact(fact: string): void {
    if (!this.data.facts.includes(fact)) {
      this.data.facts.push(fact);
      if (this.data.facts.length > 50) this.data.facts = this.data.facts.slice(-50);
      this.markDirty();
    }
  }

  /** 添加用户偏好 */
  addPreference(preference: string): void {
    if (!this.data.preferences.includes(preference)) {
      this.data.preferences.push(preference);
      if (this.data.preferences.length > 20) this.data.preferences = this.data.preferences.slice(-20);
      this.markDirty();
    }
  }

  /** 移除决策 */
  removeDecision(id: string): boolean {
    const idx = this.data.decisions.findIndex(d => d.id === id);
    if (idx === -1) return false;
    this.data.decisions.splice(idx, 1);
    this.markDirty();
    return true;
  }

  /** 添加工具到黑名单 */
  blockTool(toolName: string): void {
    if (!this.data.blockedTools.includes(toolName)) {
      this.data.blockedTools.push(toolName);
      this.data.allowedTools = this.data.allowedTools.filter(t => t !== toolName);
      this.markDirty();
    }
  }

  /** 添加工具到白名单 */
  allowTool(toolName: string): void {
    if (!this.data.allowedTools.includes(toolName)) {
      this.data.allowedTools.push(toolName);
      this.markDirty();
    }
  }

  /** 清除工具限制 */
  clearToolRestrictions(): void {
    this.data.allowedTools = [];
    this.data.blockedTools = [];
    this.markDirty();
  }

  /** 更新项目信息 */
  updateProjectInfo(name: string, description: string, techStack?: string[]): void {
    this.data.projectName = name;
    this.data.description = description;
    if (techStack) this.data.techStack = techStack;
    this.markDirty();
  }

  /** 增加会话计数 */
  incrementSession(): void {
    this.data.sessionCount++;
    this.data.lastUpdated = Date.now();
    this.markDirty();
  }

  /** 从对话中自动提取关键信息 */
  autoExtract(conversation: Array<{ role: string; content: string }>): { decisions: number; facts: number; preferences: number } {
    let decisions = 0, facts = 0, preferences = 0;

    for (const msg of conversation) {
      if (msg.role !== 'assistant' && msg.role !== 'user') continue;
      const content = msg.content;

      // 检测决策模式: "决定"/"选择"/"采用"/"改用"
      const decisionPatterns = /(?:决定|选择|采用|改用|确定|约定|统一使用)\s*[:：]?\s*([^。\n]{10,})/g;
      let dm;
      while ((dm = decisionPatterns.exec(content)) !== null) {
        const decision = dm[1].trim();
        if (decision.length > 10 && decision.length < 200) {
          this.addDecision(decision, `从对话中自动提取`, 'auto-extracted');
          decisions++;
        }
      }

      // 检测事实模式: "注意"/"记住"/"关键是"/"实际上"
      const factPatterns = /(?:注意|记住|关键是|实际上|本项目|当前项目|这个项目)\s*[:：]?\s*([^。\n]{15,})/g;
      let fm;
      while ((fm = factPatterns.exec(content)) !== null) {
        const fact = fm[1].trim();
        if (fact.length < 300) {
          this.addFact(fact);
          facts++;
        }
      }

      // 检测偏好: "我喜欢"/"我习惯"/"我更倾向于"/"不要"
      const prefMatch = content.match(/(?:我喜欢|我习惯|我更倾向于|请(?:不要|避免|别)|偏好|prefer|avoid)\s*[:：]?\s*([^。\n]{10,})/i);
      if (prefMatch) {
        this.addPreference(prefMatch[1].trim());
        preferences++;
      }
    }

    if (decisions > 0 || facts > 0 || preferences > 0) {
      this.log.info('自动提取项目上下文', { decisions, facts, preferences });
    }

    return { decisions, facts, preferences };
  }

  /** 生成 PROJECT.md 内容（用户可读的 Markdown） */
  generateMarkdown(): string {
    let md = `# ${this.data.projectName || '项目配置'}\n\n`;

    if (this.data.description) md += `${this.data.description}\n\n`;
    if (this.data.techStack.length > 0) md += `**技术栈**: ${this.data.techStack.join(', ')}\n\n`;

    md += `最后更新: ${new Date(this.data.lastUpdated).toLocaleString()} | 会话数: ${this.data.sessionCount}\n\n`;

    if (this.data.standards.length > 0) {
      md += `## 编码规范\n\n`;
      const byPriority = (p: string) => this.data.standards.filter(s => s.priority === p);
      for (const s of byPriority('must')) md += `- [必须] [${s.category}] ${s.rule}\n`;
      for (const s of byPriority('should')) md += `- [建议] [${s.category}] ${s.rule}\n`;
      for (const s of byPriority('could')) md += `- [可选] [${s.category}] ${s.rule}\n`;
      md += '\n';
    }

    if (this.data.decisions.length > 0) {
      md += `## 关键决策\n\n`;
      for (const d of [...this.data.decisions].reverse().slice(0, 20)) {
        md += `- **${d.summary}** (${new Date(d.timestamp).toLocaleDateString()})\n`;
      }
      md += '\n';
    }

    if (this.data.facts.length > 0) {
      md += `## 项目事实\n\n`;
      for (const f of this.data.facts) md += `- ${f}\n`;
      md += '\n';
    }

    if (this.data.preferences.length > 0) {
      md += `## 用户偏好\n\n`;
      for (const p of this.data.preferences) md += `- ${p}\n`;
      md += '\n';
    }

    if (this.data.blockedTools.length > 0) {
      md += `## 禁止工具\n\n`;
      for (const t of this.data.blockedTools) md += `- \`${t}\`\n`;
      md += '\n';
    }

    if (this.data.allowedTools.length > 0) {
      md += `## 允许工具\n\n`;
      for (const t of this.data.allowedTools) md += `- \`${t}\`\n`;
      md += '\n';
    }

    md += `---\n*此文件由 ProjectContext 自动维护。手动编辑的规范将会保留。*\n`;
    return md;
  }

  /** 根据当前上下文数据更新 PROJECT.md */
  syncMarkdown(): void {
    try {
      const md = this.generateMarkdown();
      fs.writeFileSync(this.markdownPath, md, 'utf-8');
    } catch (err: unknown) {
      this.log.warn('写入 PROJECT.md 失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  // ============ 持久化 ============

  private load(): void {
    // 先加载 JSON（程序化数据）
    try {
      if (fs.existsSync(this.jsonPath)) {
        const raw = fs.readFileSync(this.jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = { ...DEFAULT_CONTEXT, ...parsed };
      }
    } catch (err: unknown) {
      this.log.warn('加载 project-context.json 失败', { error: (err instanceof Error ? err.message : String(err)) });
    }

    // 尝试从 PROJECT.md 提取项目名
    try {
      if (fs.existsSync(this.markdownPath)) {
        const md = fs.readFileSync(this.markdownPath, 'utf-8');
        const nameMatch = md.match(/^#\s+(.+)/m);
        if (nameMatch && !this.data.projectName) {
          this.data.projectName = nameMatch[1].trim();
        }
      }
    } catch { /* ignore */ }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => this.flush(), 2000);
    }
  }

  private flush(): void {
    this.persistTimer = null;
    if (!this.dirty) return;
    this.dirty = false;

    this.data.lastUpdated = Date.now();

    try {
      const dir = path.dirname(this.jsonPath);
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteJsonSync(this.jsonPath, this.data);
      this.syncMarkdown();
    } catch (err: unknown) {
      this.log.warn('持久化项目上下文失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** 将内存数据立即落盘 */
  flushNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.flush();
  }
}
