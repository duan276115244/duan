/**
 * 项目级配置系统 — ProjectConfig
 *
 * 类似 CLAUDE.md / .cursorrules 的项目级配置机制：
 * 1. 从 .duan/CONFIG.md（Markdown 格式）或 .duan/config.json（JSON 格式）加载配置
 * 2. 兼容 AGENTS.md（Codex 格式）
 * 3. 支持编码规则、工具偏好、技术栈等上下文定义
 * 4. 生成系统提示词附加内容
 * 5. 文件监听与热重载
 * 6. Agent Loop 工具注册
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

export interface ProjectRule {
  id: string;
  category: 'coding_style' | 'naming' | 'architecture' | 'testing' | 'deployment' | 'communication' | 'custom';
  rule: string;
  priority: 'must' | 'should' | 'could';
  enabled: boolean;
}

export interface ProjectContext {
  name: string;
  description: string;
  techStack: string[];
  codeStyle: string;
  testFramework: string;
  deployTarget: string;
  customRules: ProjectRule[];
  preferredTools: Record<string, string>;  // task → preferred tool
  excludedTools: string[];  // tools to never use
  maxIterations: number;
  autoCommit: boolean;
  language: string;
}

import type { ToolDef } from './unified-tool-def.js';

// ============ 默认配置 ============

const DEFAULT_CONTEXT: ProjectContext = {
  name: 'unnamed-project',
  description: '',
  techStack: [],
  codeStyle: 'eslint',
  testFramework: 'jest',
  deployTarget: 'local',
  customRules: [],
  preferredTools: {},
  excludedTools: [],
  maxIterations: 15,
  autoCommit: true,
  language: '中文',
};

// ============ 主类 ============

export class ProjectConfig {
  private log = logger.child({ module: 'ProjectConfig' });
  private context: ProjectContext | null = null;
  private watchers: Map<string, fs.FSWatcher> = new Map();

  constructor() {}

  // ========== 核心方法 ==========

  /**
   * 加载项目配置
   * 优先级：.duan/CONFIG.md > .duan/config.json > AGENTS.md > 默认值
   */
  load(projectDir?: string): ProjectContext {
    const dir = projectDir || process.cwd();
    const startTime = Date.now();

    // 1. 尝试 .duan/CONFIG.md
    const mdPath = path.join(dir, '.duan', 'CONFIG.md');
    if (fs.existsSync(mdPath)) {
      this.context = this.parseConfigMd(mdPath);
      this.log.info('从 .duan/CONFIG.md 加载配置', { path: mdPath, durationMs: Date.now() - startTime });
      return this.context;
    }

    // 2. 尝试 .duan/config.json
    const jsonPath = path.join(dir, '.duan', 'config.json');
    if (fs.existsSync(jsonPath)) {
      this.context = this.parseConfigJson(jsonPath);
      this.log.info('从 .duan/config.json 加载配置', { path: jsonPath, durationMs: Date.now() - startTime });
      return this.context;
    }

    // 3. 尝试 AGENTS.md（Codex 兼容）
    const agentsPath = path.join(dir, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      this.context = this.parseAgentsMd(agentsPath);
      this.log.info('从 AGENTS.md 加载配置（兼容模式）', { path: agentsPath, durationMs: Date.now() - startTime });
      return this.context;
    }

    // 4. 回退到默认值
    this.context = { ...DEFAULT_CONTEXT };
    this.log.info('未找到配置文件，使用默认配置', { projectDir: dir });
    return this.context;
  }

  /**
   * 保存配置到 .duan/CONFIG.md
   */
  save(projectDir: string, config: ProjectContext): void {
    const duanDir = path.join(projectDir, '.duan');
    if (!fs.existsSync(duanDir)) {
      fs.mkdirSync(duanDir, { recursive: true });
    }

    const mdPath = path.join(duanDir, 'CONFIG.md');
    const content = this.serializeConfigMd(config);
    fs.writeFileSync(mdPath, content, 'utf-8');

    this.context = { ...config };
    this.log.info('配置已保存', { path: mdPath });
  }

  /**
   * 获取所有活跃规则
   */
  getRules(): ProjectRule[] {
    if (!this.context) return [];
    return this.context.customRules.filter(r => r.enabled);
  }

  /**
   * 获取指定任务的偏好工具
   */
  getPreferredTool(task: string): string | undefined {
    if (!this.context) return undefined;
    return this.context.preferredTools[task];
  }

  /**
   * 生成系统提示词附加内容
   */
  generateSystemPromptAddition(): string {
    if (!this.context) return '';

    const sections: string[] = [];

    // 项目基本信息
    sections.push('## 项目信息');
    sections.push(`- 项目名: ${this.context.name}`);
    if (this.context.description) {
      sections.push(`- 描述: ${this.context.description}`);
    }

    // 技术栈
    if (this.context.techStack.length > 0) {
      sections.push(`- 技术栈: ${this.context.techStack.join(', ')}`);
    }

    // 编码风格
    sections.push('## 编码风格');
    sections.push(`- 代码风格: ${this.context.codeStyle}`);
    sections.push(`- 测试框架: ${this.context.testFramework}`);
    sections.push(`- 部署目标: ${this.context.deployTarget}`);
    sections.push(`- 语言: ${this.context.language}`);

    // 自定义规则
    const activeRules = this.getRules();
    if (activeRules.length > 0) {
      sections.push('## 编码规则');
      for (const rule of activeRules) {
        let prefix: string;
        if (rule.priority === 'must') {
          prefix = '[MUST]';
        } else if (rule.priority === 'should') {
          prefix = '[SHOULD]';
        } else {
          prefix = '[COULD]';
        }
        sections.push(`- ${prefix} ${rule.rule}`);
      }
    }

    // 工具偏好
    const toolEntries = Object.entries(this.context.preferredTools);
    if (toolEntries.length > 0) {
      sections.push('## 工具偏好');
      for (const [task, tool] of toolEntries) {
        sections.push(`- ${task}: ${tool}`);
      }
    }

    // 排除工具
    if (this.context.excludedTools.length > 0) {
      sections.push('## 排除工具');
      sections.push(`- 不使用: ${this.context.excludedTools.join(', ')}`);
    }

    // 高级设置
    sections.push('## 高级设置');
    sections.push(`- 最大迭代次数: ${this.context.maxIterations}`);
    sections.push(`- 自动提交: ${this.context.autoCommit}`);

    return sections.join('\n');
  }

  /**
   * 监听配置文件变更并热重载
   */
  watch(projectDir: string, callback: (config: ProjectContext) => void): void {
    const dir = projectDir || process.cwd();
    const watchPaths = [
      path.join(dir, '.duan', 'CONFIG.md'),
      path.join(dir, '.duan', 'config.json'),
      path.join(dir, 'AGENTS.md'),
    ];

    // 清理已有的监听器
    this.unwatchAll();

    for (const filePath of watchPaths) {
      if (!fs.existsSync(filePath)) continue;

      try {
        const watcher = fs.watch(filePath, (eventType) => {
          if (eventType === 'change') {
            this.log.info('配置文件变更，热重载', { path: filePath });
            try {
              const config = this.load(dir);
              callback(config);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              this.log.error('热重载失败', { path: filePath, error: msg });
            }
          }
        });
        this.watchers.set(filePath, watcher);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('无法监听配置文件', { path: filePath, error: msg });
      }
    }
  }

  /**
   * 创建默认配置文件
   */
  createDefault(projectDir: string, options?: Partial<ProjectContext>): void {
    const config: ProjectContext = {
      ...DEFAULT_CONTEXT,
      ...options,
      customRules: options?.customRules || [
        {
          id: 'rule_001',
          category: 'coding_style',
          rule: '使用 TypeScript strict 模式',
          priority: 'must',
          enabled: true,
        },
        {
          id: 'rule_002',
          category: 'coding_style',
          rule: '所有函数必须有返回类型注解',
          priority: 'must',
          enabled: true,
        },
        {
          id: 'rule_003',
          category: 'architecture',
          rule: '优先使用函数式组件',
          priority: 'should',
          enabled: true,
        },
        {
          id: 'rule_004',
          category: 'coding_style',
          rule: '添加 JSDoc 注释',
          priority: 'could',
          enabled: true,
        },
      ],
      preferredTools: options?.preferredTools || {
        '代码格式化': 'eslint',
        '包管理': 'npm',
        'Git': 'conventional commits',
      },
      excludedTools: options?.excludedTools || ['app_launch'],
    };

    this.save(projectDir, config);
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'project_config_load',
        description: '加载项目级配置。从 .duan/CONFIG.md、.duan/config.json 或 AGENTS.md 读取项目规则、技术栈、工具偏好等配置。',
        parameters: {
          projectDir: {
            type: 'string',
            description: '项目根目录的绝对路径',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const config = self.load(args.projectDir as string);
            return Promise.resolve(JSON.stringify(config, null, 2));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 加载配置失败: ${msg}`);
          }
        },
      },
      {
        name: 'project_config_save',
        description: '保存项目级配置到 .duan/CONFIG.md。config 参数为完整的 ProjectContext JSON 对象。',
        parameters: {
          config: {
            type: 'string',
            description: 'ProjectContext JSON 字符串，包含 name, description, techStack, codeStyle, testFramework, deployTarget, customRules, preferredTools, excludedTools, maxIterations, autoCommit, language',
            required: true,
          },
          projectDir: {
            type: 'string',
            description: '项目根目录的绝对路径',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const config = JSON.parse(args.config as string) as ProjectContext;
            self.save(args.projectDir as string, config);
            return Promise.resolve(`✅ 配置已保存到 ${args.projectDir}/.duan/CONFIG.md`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 保存配置失败: ${msg}`);
          }
        },
      },
      {
        name: 'project_config_rules',
        description: '获取当前项目所有活跃规则。返回 enabled=true 的 ProjectRule 列表，按优先级排序（must > should > could）。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const rules = self.getRules();
            if (rules.length === 0) {
              return Promise.resolve('⚠️ 未加载项目配置或无活跃规则');
            }
            const priorityOrder = { must: 0, should: 1, could: 2 };
            rules.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
            return Promise.resolve(JSON.stringify(rules, null, 2));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 获取规则失败: ${msg}`);
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 解析 .duan/CONFIG.md（Markdown 格式） */
  private parseConfigMd(filePath: string): ProjectContext {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ctx: ProjectContext = { ...DEFAULT_CONTEXT };

    const lines = content.split('\n');
    let currentSection = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // 识别章节标题
      if (line.startsWith('## ')) {
        currentSection = line.substring(3).trim();
        continue;
      }

      // 跳过空行和一级标题
      if (!line || line.startsWith('# ')) continue;

      // 根据章节解析
      if (currentSection === '基本信息') {
        this.parseBasicInfo(line, ctx);
      } else if (currentSection === '编码规则') {
        this.parseRule(line, ctx);
      } else if (currentSection === '工具偏好') {
        this.parseToolPreference(line, ctx);
      } else if (currentSection === '排除工具') {
        this.parseExcludedTool(line, ctx);
      } else if (currentSection === '高级设置') {
        this.parseAdvancedSetting(line, ctx);
      }
    }

    return ctx;
  }

  /** 解析基本信息行 */
  private parseBasicInfo(line: string, ctx: ProjectContext): void {
    const match = line.match(/^-?\s*(.+?):\s*(.+)$/);
    if (!match) return;

    const [, key, value] = match;
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();

    switch (normalizedKey) {
      case '项目名':
        ctx.name = normalizedValue;
        break;
      case '描述':
        ctx.description = normalizedValue;
        break;
      case '技术栈':
        ctx.techStack = normalizedValue.split(/[,，]/).map(s => s.trim()).filter(s => s.length > 0);
        break;
      case '代码风格':
        ctx.codeStyle = normalizedValue;
        break;
      case '测试框架':
        ctx.testFramework = normalizedValue;
        break;
      case '部署目标':
        ctx.deployTarget = normalizedValue;
        break;
    }
  }

  /** 解析编码规则行 */
  private parseRule(line: string, ctx: ProjectContext): void {
    // 格式: - [MUST] 规则内容
    const match = line.match(/^-?\s*\[(MUST|SHOULD|COULD)\]\s*(.+)$/i);
    if (!match) return;

    const priority = match[1].toLowerCase() as 'must' | 'should' | 'could';
    const rule = match[2].trim();
    const id = `rule_${String(ctx.customRules.length + 1).padStart(3, '0')}`;

    ctx.customRules.push({
      id,
      category: this.inferCategory(rule),
      rule,
      priority,
      enabled: true,
    });
  }

  /** 从规则内容推断类别 */
  private inferCategory(rule: string): ProjectRule['category'] {
    if (/类型|type|strict|模式|注释|格式|缩进|分号|引号/.test(rule)) return 'coding_style';
    if (/命名|变量|函数名|class|interface/.test(rule)) return 'naming';
    if (/架构|组件|模块|分层|设计模式/.test(rule)) return 'architecture';
    if (/测试|test|spec|coverage/.test(rule)) return 'testing';
    if (/部署|deploy|docker|k8s|CI|CD/.test(rule)) return 'deployment';
    if (/沟通|文档|review|PR|commit/.test(rule)) return 'communication';
    return 'custom';
  }

  /** 解析工具偏好行 */
  private parseToolPreference(line: string, ctx: ProjectContext): void {
    const match = line.match(/^-?\s*(.+?):\s*(.+)$/);
    if (!match) return;
    ctx.preferredTools[match[1].trim()] = match[2].trim();
  }

  /** 解析排除工具行 */
  private parseExcludedTool(line: string, ctx: ProjectContext): void {
    const match = line.match(/^-?\s*不使用:\s*(.+)$/);
    if (!match) return;
    ctx.excludedTools = match[1].split(/[,，]/).map(s => s.trim()).filter(s => s.length > 0);
  }

  /** 解析高级设置行 */
  private parseAdvancedSetting(line: string, ctx: ProjectContext): void {
    const match = line.match(/^-?\s*(.+?):\s*(.+)$/);
    if (!match) return;

    const key = match[1].trim();
    const value = match[2].trim();

    switch (key) {
      case '最大迭代次数':
        ctx.maxIterations = parseInt(value, 10) || DEFAULT_CONTEXT.maxIterations;
        break;
      case '自动提交':
        ctx.autoCommit = value === 'true';
        break;
      case '语言':
        ctx.language = value;
        break;
    }
  }

  /** 解析 .duan/config.json */
  private parseConfigJson(filePath: string): ProjectContext {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return { ...DEFAULT_CONTEXT, ...parsed };
  }

  /** 解析 AGENTS.md（Codex 兼容格式） */
  private parseAgentsMd(filePath: string): ProjectContext {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ctx: ProjectContext = { ...DEFAULT_CONTEXT };

    // 从 AGENTS.md 提取项目名（从一级标题）
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      ctx.name = titleMatch[1].trim();
    }

    // 将每个段落作为一条规则
    const sections = content.split(/\n{2,}/).filter(s => s.trim().length > 0);
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i].trim();
      if (section.startsWith('#')) continue; // 跳过标题

      ctx.customRules.push({
        id: `agents_rule_${String(i + 1).padStart(3, '0')}`,
        category: 'custom',
        rule: section.split('\n')[0].substring(0, 100),
        priority: 'should',
        enabled: true,
      });
    }

    // 将整个内容作为 AI 指令的描述
    ctx.description = content.substring(0, 200).trim();

    return ctx;
  }

  /** 将 ProjectContext 序列化为 CONFIG.md 格式 */
  private serializeConfigMd(config: ProjectContext): string {
    const lines: string[] = [];

    lines.push('# 项目配置');
    lines.push('');

    // 基本信息
    lines.push('## 基本信息');
    lines.push(`- 项目名: ${config.name}`);
    if (config.description) {
      lines.push(`- 描述: ${config.description}`);
    }
    lines.push(`- 技术栈: ${config.techStack.join(', ')}`);
    lines.push(`- 代码风格: ${config.codeStyle}`);
    lines.push(`- 测试框架: ${config.testFramework}`);
    lines.push(`- 部署目标: ${config.deployTarget}`);
    lines.push('');

    // 编码规则
    const activeRules = config.customRules.filter(r => r.enabled);
    if (activeRules.length > 0) {
      lines.push('## 编码规则');
      for (const rule of activeRules) {
        let prefix: string;
        if (rule.priority === 'must') {
          prefix = '[MUST]';
        } else if (rule.priority === 'should') {
          prefix = '[SHOULD]';
        } else {
          prefix = '[COULD]';
        }
        lines.push(`- ${prefix} ${rule.rule}`);
      }
      lines.push('');
    }

    // 工具偏好
    const toolEntries = Object.entries(config.preferredTools);
    if (toolEntries.length > 0) {
      lines.push('## 工具偏好');
      for (const [task, tool] of toolEntries) {
        lines.push(`- ${task}: ${tool}`);
      }
      lines.push('');
    }

    // 排除工具
    if (config.excludedTools.length > 0) {
      lines.push('## 排除工具');
      lines.push(`- 不使用: ${config.excludedTools.join(', ')}`);
      lines.push('');
    }

    // 高级设置
    lines.push('## 高级设置');
    lines.push(`- 最大迭代次数: ${config.maxIterations}`);
    lines.push(`- 自动提交: ${config.autoCommit}`);
    lines.push(`- 语言: ${config.language}`);
    lines.push('');

    return lines.join('\n');
  }

  /** 停止所有文件监听 */
  private unwatchAll(): void {
    for (const [filePath, watcher] of this.watchers) {
      watcher.close();
      this.log.debug('停止监听配置文件', { path: filePath });
    }
    this.watchers.clear();
  }
}
