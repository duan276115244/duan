/**
 * 技能包系统 — SkillPackageSystem
 *
 * 设计源自 OpenClaw 的技能系统 + ClawHub：
 * - 每个技能是一个 SKILL.md 包（自包含指令 + 工具 + 钩子）
 * - 技能可从本地目录或远程仓库安装
 * - 技能通过 EventBus 与其他组件通信
 * - 技能可以注入系统提示词、注册工具、监听事件
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { EventBus, Events } from './event-bus.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license?: string;

  homepage?: string;
  /** 技能注入的系统提示指令 */
  systemPrompt?: string;
  /** 该技能需要的工具列表 */
  requiredTools?: string[];
  /** 该技能注册的自定义工具路径 */
  tools?: string[];
  /** 依赖的其他技能 ID */
  dependencies?: string[];
  /** 适用场景关键词（用于自动激活） */
  triggers?: string[];
  /** 配置模式 */
  config?: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'select';
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default?: any;
    options?: string[];
    required?: boolean;
  }>;
}

export interface SkillPackage {
  manifest: SkillManifest;
  /** SKILL.md 原始内容 */
  rawContent: string;
  /** 技能目录路径 */
  dir: string;
  /** 是否已加载 */
  loaded: boolean;
  /** 加载时间 */
  loadedAt?: number;
  /** 技能配置值 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configValues: Record<string, any>;
  /** 注册的工具清理函数 */
  cleanupFns: Array<() => void>;
}

export interface SkillInstallOptions {
  source: 'local' | 'git' | 'npm' | 'url';
  location: string;
  version?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any>;
}

// ============ 技能包系统主类 ============

export class SkillPackageSystem {
  private skills: Map<string, SkillPackage> = new Map();
  private skillsDir: string;
  private eventBus: EventBus;
  private systemPromptInjections: Map<string, string> = new Map();
  private loadCallbacks: Array<(skill: SkillPackage) => void> = [];

  constructor(skillsDir: string = duanPath('skills')) {
    this.skillsDir = skillsDir;
    this.eventBus = EventBus.getInstance();
  }

  /** 注册加载完成回调 */
  onLoad(cb: (skill: SkillPackage) => void): void {
    this.loadCallbacks.push(cb);
  }

  /** 初始化：扫描并加载所有已安装的技能 */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.skillsDir, { recursive: true });
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

      const loadPromises: Promise<void | SkillPackage>[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillDir = path.join(this.skillsDir, entry.name);
          loadPromises.push(
            this.loadSkillFromDir(skillDir).catch((err: Error) => {
              console.warn(`[SkillSystem] 跳过技能 ${entry.name}: ${err.message}`);
            })
          );
        }
      }

      await Promise.all(loadPromises);
      // SkillSystem loaded (suppressed in production)
    } catch (err: unknown) {
      console.error('[SkillSystem] 初始化失败:', err);
    }
  }

  /** 从目录加载技能 */
  private async loadSkillFromDir(skillDir: string): Promise<SkillPackage> {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const configPath = path.join(skillDir, 'config.json');

    let rawContent: string;
    try {
      rawContent = await fs.readFile(skillMdPath, 'utf-8');
    } catch {
      throw new Error(`缺少 SKILL.md`);
    }

    const manifest = this.parseManifest(rawContent, path.basename(skillDir));

    let configValues: Record<string, unknown> = {};
    try {
      configValues = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    } catch {}

    const skill: SkillPackage = {
      manifest,
      rawContent,
      dir: skillDir,
      loaded: false,
      configValues,
      cleanupFns: [],
    };

    // 检查重复
    if (this.skills.has(manifest.id)) {
      throw new Error(`技能 ${manifest.id} 已存在`);
    }

    // 检查依赖
    if (manifest.dependencies) {
      for (const depId of manifest.dependencies) {
        if (!this.skills.has(depId)) {
          console.warn(`[SkillSystem] 技能 ${manifest.id} 依赖 ${depId} 未安装`);
        }
      }
    }

    this.skills.set(manifest.id, skill);
    return skill;
  }

  /** 解析 SKILL.md 中的 YAML frontmatter */
  private parseManifest(content: string, fallbackId: string): SkillManifest {
    const manifest: SkillManifest = {
      id: fallbackId,
      name: fallbackId,
      version: '1.0.0',
      description: '',
      author: 'unknown',
    };

    // 解析 YAML frontmatter (--- 包裹的元数据)
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) return manifest;

    const fm = fmMatch[1];
    const lines = fm.split('\n');

    for (const line of lines) {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();

      switch (key.trim()) {
        case 'id': manifest.id = value; break;
        case 'name': manifest.name = value; break;
        case 'version': manifest.version = value; break;
        case 'description': manifest.description = value.replace(/^["']|["']$/g, ''); break;
        case 'author': manifest.author = value; break;
        case 'license': manifest.license = value; break;
        case 'homepage': manifest.homepage = value; break;
        case 'systemPrompt': {
          // 多行 systemPrompt 从下一行开始读取，直到下一个 key 或结束
          const promptLines: string[] = [];
          let inPrompt = false;
          for (const l of lines.slice(lines.indexOf(line) + 1)) {
            if (/^\w+:/.test(l.trim())) break;
            if (inPrompt || l.trim()) {
              inPrompt = true;
              promptLines.push(l.replace(/^\s{2,}/, ''));
            }
          }
          manifest.systemPrompt = promptLines.join('\n').trim();
          break;
        }
      }
    }

    // 解析 triggers
    const triggerMatch = fm.match(/triggers:\n((?:\s+- .+\n?)*)/);
    if (triggerMatch) {
      manifest.triggers = triggerMatch[1]
        .split('\n')
        .map(l => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
    }

    return manifest;
  }

  /** 加载技能（激活） */
  async activate(skillId: string): Promise<boolean> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      console.error(`[SkillSystem] 技能 ${skillId} 未找到`);
      return false;
    }
    if (skill.loaded) return true;

    // 检查并激活依赖
    if (skill.manifest.dependencies) {
      for (const depId of skill.manifest.dependencies) {
        await this.activate(depId);
      }
    }

    skill.loaded = true;
    skill.loadedAt = Date.now();

    // 注入系统提示
    if (skill.manifest.systemPrompt) {
      this.systemPromptInjections.set(skillId, skill.manifest.systemPrompt);
    }

    // 触发事件
    await this.eventBus.emit(Events.SKILL_LOADED, {
      skillId,
      name: skill.manifest.name,
      version: skill.manifest.version,
      systemPrompt: skill.manifest.systemPrompt,
      triggers: skill.manifest.triggers,
    }, { source: 'skill-system' });

    // 通知回调
    for (const cb of this.loadCallbacks) {
      try { cb(skill); } catch {}
    }

    console.info(`[SkillSystem] 激活技能: ${skill.manifest.name} v${skill.manifest.version}`);
    return true;
  }

  /** 卸载技能 */
  async deactivate(skillId: string): Promise<boolean> {
    const skill = this.skills.get(skillId);
    if (!skill || !skill.loaded) return false;

    // 执行清理
    for (const cleanup of skill.cleanupFns) {
      try { cleanup(); } catch {}
    }
    skill.cleanupFns = [];

    this.systemPromptInjections.delete(skillId);
    skill.loaded = false;

    await this.eventBus.emit(Events.SKILL_UNLOADED, {
      skillId,
      name: skill.manifest.name,
    }, { source: 'skill-system' });

    return true;
  }

  /** 安装技能 */
  async install(options: SkillInstallOptions): Promise<boolean> {
    const { source, location } = options;

    if (source === 'local') {
      const skillDir = path.resolve(location);
      try {
        const stat = await fs.stat(skillDir);
        if (!stat.isDirectory()) throw new Error('路径不是目录');
      } catch {
        // 如果是文件路径，可能是一个 SKILL.md 文件
        if (location.endsWith('.md')) {
          const skillDir = path.join(this.skillsDir, path.basename(location, '.md'));
          await fs.mkdir(skillDir, { recursive: true });
          await fs.copyFile(location, path.join(skillDir, 'SKILL.md'));
        } else {
          throw new Error(`无法访问: ${location}`);
        }
        return true;
      }

      // 复制到技能目录
      const skillName = path.basename(skillDir);
      const targetDir = path.join(this.skillsDir, skillName);
      await fs.cp(skillDir, targetDir, { recursive: true });

      // 加载
      await this.loadSkillFromDir(targetDir);
      return true;
    }

    if (source === 'url') {
      // 从 URL 下载 SKILL.md
      try {
        const response = await fetch(location, { signal: AbortSignal.timeout(15000) });
        const content = await response.text();

        // 解析名称
        const nameMatch = content.match(/^---\n[\s\S]*?\nname:\s*(.+)\n/);
        const skillName = nameMatch ? nameMatch[1].trim() : `skill_${Date.now()}`;

        const targetDir = path.join(this.skillsDir, skillName);
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, 'SKILL.md'), content, 'utf-8');

        await this.loadSkillFromDir(targetDir);
        return true;
      } catch (err: unknown) {
        console.error(`[SkillSystem] 从 URL 安装失败:`, err);
        return false;
      }
    }

    console.warn(`[SkillSystem] 暂不支持从 ${source} 安装`);
    return false;
  }

  /** 卸载技能 */
  async uninstall(skillId: string): Promise<boolean> {
    await this.deactivate(skillId);
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    try {
      await fs.rm(skill.dir, { recursive: true, force: true });
    } catch {}

    this.skills.delete(skillId);
    return true;
  }

  /** 获取所有技能列表 */
  listSkills(): Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    loaded: boolean;
    hasSystemPrompt: boolean;
    triggers: string[];
  }> {
    return Array.from(this.skills.values()).map(s => ({
      id: s.manifest.id,
      name: s.manifest.name,
      version: s.manifest.version,
      description: s.manifest.description,
      author: s.manifest.author,
      loaded: s.loaded,
      hasSystemPrompt: !!s.manifest.systemPrompt,
      triggers: s.manifest.triggers || [],
    }));
  }

  /** 获取已激活的系统提示注入 */
  getActiveSystemPrompts(): string[] {
    return Array.from(this.systemPromptInjections.values());
  }

  /** 获取所有系统提示的合并文本 */
  getMergedSystemPrompt(): string {
    return Array.from(this.systemPromptInjections.values()).join('\n\n');
  }

  /** 根据输入文本匹配合适的技能触发器 */
  findMatchingSkills(text: string): SkillPackage[] {
    const lowerText = text.toLowerCase();
    const matches: SkillPackage[] = [];

    for (const skill of this.skills.values()) {
      if (!skill.loaded) continue;
      const triggers = skill.manifest.triggers || [];
      if (triggers.some(t => lowerText.includes(t.toLowerCase()))) {
        matches.push(skill);
      }
    }

    return matches;
  }

  /** 获取技能详情 */
  getSkill(id: string): SkillPackage | undefined {
    return this.skills.get(id);
  }

  /** 注册清理函数（技能内部调用） */
  registerCleanup(skillId: string, fn: () => void): void {
    const skill = this.skills.get(skillId);
    if (skill) {
      skill.cleanupFns.push(fn);
    }
  }

  /**
   * 释放所有技能的 cleanupFns + 清空内存中的 skills
   * P0 D3.4 修复：技能系统未加入 dispose 链，技能内注册的资源（文件句柄、子进程、定时器）会泄漏
   */
  dispose(): void {
    for (const skill of this.skills.values()) {
      for (const cleanup of skill.cleanupFns) {
        try { cleanup(); } catch {}
      }
      skill.cleanupFns = [];
      skill.loaded = false;
    }
    this.skills.clear();
    this.systemPromptInjections.clear();
    this.loadCallbacks.length = 0;
  }
}
