/**
 * v20.0 §2.4 斜杠命令系统 — SlashCommands
 *
 * 对标 Claude Code 的 .claude/commands/*.md，用户可创建自定义命令模板。
 *
 * 命令目录：
 *   - 全局：~/.duan/commands/*.md
 *   - 项目：<repo>/.duan/commands/*.md
 *
 * 文件名即命令名：fix-issue.md → /fix-issue
 *
 * 模板占位符：
 *   - $ARGUMENTS  — 用户输入的参数
 *   - $CLIPBOARD  — 剪贴板内容
 *   - $FILE:path  — 指定文件内容
 *   - $SELECTION  — 当前选中文本（IDE 模式）
 *
 * 内置命令：
 *   /init     — 生成 .duan/memory 项目记忆
 *   /review   — 代码审查
 *   /test     — 编写测试
 *   /deploy   — 部署流程
 *   /subagent — 子代理预设派发
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { getDuanDataDir } from './duan-paths.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

export interface SlashCommand {
  /** 命令名（不含 /，如 fix-issue） */
  name: string;
  /** 命令描述（从 markdown frontmatter 或首行提取） */
  description: string;
  /** 模板内容（含 $ARGUMENTS 等占位符） */
  template: string;
  /** 来源：builtin / global / project */
  source: 'builtin' | 'global' | 'project';
  /** 文件路径（仅 global/project） */
  filePath?: string;
}

export interface SlashCommandRenderResult {
  /** 渲染后的命令文本 */
  text: string;
  /** 命令定义 */
  command: SlashCommand;
  /** 替换的占位符列表 */
  replacedPlaceholders: string[];
  /** 未替换的占位符列表（缺少数据） */
  unresolvedPlaceholders: string[];
}

// ============ 占位符正则 ============

/** $ARGUMENTS — 用户参数 */
const RE_ARGUMENTS = /\$ARGUMENTS\b/g;
/** $CLIPBOARD — 剪贴板 */
const RE_CLIPBOARD = /\$CLIPBOARD\b/g;
/** $SELECTION — 选中文本 */
const RE_SELECTION = /\$SELECTION\b/g;
/** $FILE:path — 文件内容 */
const RE_FILE = /\$FILE:([^\s$]+)/g;
/** $DATE / $TIME — 当前日期时间 */
const RE_DATE = /\$DATE\b/g;
const RE_TIME = /\$TIME\b/g;
/** $CWD — 当前工作目录 */
const RE_CWD = /\$CWD\b/g;

// ============ 内置命令 ============

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'init',
    description: '初始化项目记忆（.duan/memory）',
    source: 'builtin',
    template: `请为当前项目初始化项目记忆。执行以下步骤：

1. 扫描项目结构，识别技术栈（语言/框架/构建工具）
2. 查看 package.json / pyproject.toml / go.mod 等配置文件
3. 识别项目约定（命名规范、目录结构、代码风格）
4. 生成 .duan/memory/conventions.md 记录项目约定
5. 生成 .duan/memory/tech-stack.md 记录技术栈

$ARGUMENTS`,
  },
  {
    name: 'review',
    description: '代码审查（派发到 code-reviewer 子代理）',
    source: 'builtin',
    template: `请对以下内容进行代码审查：

$ARGUMENTS

审查维度：
1. 代码风格（命名、格式、注释）
2. 安全漏洞（注入、XSS、硬编码密钥）
3. 性能问题（N+1 查询、内存泄漏、阻塞调用）
4. 逻辑错误（边界条件、空值、异常处理）
5. 可维护性（重复代码、耦合度）

输出格式：按严重程度分级（🔴严重 / 🟡警告 / 🔵建议），给出总体评价。`,
  },
  {
    name: 'test',
    description: '编写测试（派发到 test-engineer 子代理）',
    source: 'builtin',
    template: `请为以下代码编写测试：

$ARGUMENTS

要求：
1. 优先使用项目已有测试框架
2. 覆盖正常、边界、异常场景
3. 测试命名清晰：should_预期_当_条件
4. 使用 mock 隔离外部依赖
5. 覆盖率目标 > 80%`,
  },
  {
    name: 'deploy',
    description: '部署流程指引',
    source: 'builtin',
    template: `请指导部署流程。项目信息：

$ARGUMENTS

请执行：
1. 检查部署前置条件（环境变量、依赖、配置）
2. 提供部署步骤（构建 → 测试 → 打包 → 发布）
3. 验证部署结果（健康检查、冒烟测试）
4. 提供回滚方案`,
  },
  {
    name: 'subagent',
    description: '子代理预设派发（/subagent <preset> <task>）',
    source: 'builtin',
    template: `$ARGUMENTS`,
  },
  {
    name: 'help',
    description: '显示可用命令',
    source: 'builtin',
    template: `__HELP__`,
  },
];

// ============ 主类 ============

export class SlashCommandRegistry {
  private log = logger.child({ module: 'SlashCommandRegistry' });
  private _cache: Map<string, SlashCommand> | null = null;
  private _cacheTime = 0;
  private readonly _cacheTtlMs = 30_000; // 30 秒缓存

  /**
   * 加载所有命令（内置 + 全局 + 项目级）
   *
   * 优先级：项目级 > 全局 > 内置（同名覆盖）
   */
  loadAll(cwd: string = process.cwd(), forceRefresh = false): Map<string, SlashCommand> {
    const now = Date.now();
    if (!forceRefresh && this._cache && now - this._cacheTime < this._cacheTtlMs) {
      return this._cache;
    }

    const commands = new Map<string, SlashCommand>();

    // 1. 内置命令（最低优先级）
    for (const cmd of BUILTIN_COMMANDS) {
      commands.set(cmd.name, cmd);
    }

    // 2. 全局命令（~/.duan/commands/*.md）
    const globalDir = path.join(getDuanDataDir(), 'commands');
    this.loadFromDir(globalDir, 'global', commands);

    // 3. 项目级命令（<repo>/.duan/commands/*.md）
    const projectDir = path.join(cwd, '.duan', 'commands');
    this.loadFromDir(projectDir, 'project', commands);

    this._cache = commands;
    this._cacheTime = now;

    this.log.debug('斜杠命令已加载', {
      total: commands.size,
      builtin: BUILTIN_COMMANDS.length,
      custom: commands.size - BUILTIN_COMMANDS.length,
    });

    return commands;
  }

  /** 从目录加载 .md 命令文件 */
  private loadFromDir(dir: string, source: 'global' | 'project', commands: Map<string, SlashCommand>): void {
    if (!fs.existsSync(dir)) return;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        const name = file.replace(/\.md$/i, '');
        const description = this.extractDescription(content);

        commands.set(name, {
          name,
          description,
          template: content,
          source,
          filePath,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('读取命令文件失败', { filePath, error: msg });
      }
    }
  }

  /** 从 markdown 内容提取描述 */
  private extractDescription(content: string): string {
    // 优先读 frontmatter 的 description
    const fmMatch = content.match(/^---\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/);
    if (fmMatch) return fmMatch[1].trim();

    // 否则取第一个非空非标题行
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        return trimmed.substring(0, 100);
      }
    }
    return '';
  }

  /**
   * 获取命令
   */
  getCommand(name: string, cwd?: string): SlashCommand | null {
    const commands = this.loadAll(cwd);
    return commands.get(name) || null;
  }

  /**
   * 列出所有命令名
   */
  listCommands(cwd?: string): string[] {
    return Array.from(this.loadAll(cwd).keys()).sort();
  }

  /**
   * 检测输入是否为斜杠命令
   *
   * @returns 命令名（不含 /），null 表示不是命令
   */
  detectCommand(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    // 提取命令名（/ 后到第一个空格或行尾）
    const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * 从输入中提取命令参数
   *
   * 例："/review src/api.ts" → "src/api.ts"
   */
  extractArguments(input: string): string {
    const trimmed = input.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx < 0) return '';
    return trimmed.substring(spaceIdx + 1).trim();
  }

  /**
   * 渲染命令模板（替换占位符）
   *
   * @param command 命令定义
   * @param options 占位符值
   */
  render(
    command: SlashCommand,
    options: {
      arguments?: string;
      clipboard?: string;
      selection?: string;
      cwd?: string;
    },
  ): SlashCommandRenderResult {
    let text = command.template;
    const replaced: string[] = [];
    const unresolved: string[] = [];

    // $ARGUMENTS
    if (RE_ARGUMENTS.test(text)) {
      if (options.arguments !== undefined) {
        text = text.replace(RE_ARGUMENTS, options.arguments);
        replaced.push('$ARGUMENTS');
      } else {
        unresolved.push('$ARGUMENTS');
        text = text.replace(RE_ARGUMENTS, '');
      }
    }
    RE_ARGUMENTS.lastIndex = 0;

    // $CLIPBOARD
    if (RE_CLIPBOARD.test(text)) {
      if (options.clipboard !== undefined) {
        text = text.replace(RE_CLIPBOARD, options.clipboard);
        replaced.push('$CLIPBOARD');
      } else {
        unresolved.push('$CLIPBOARD');
        text = text.replace(RE_CLIPBOARD, '[剪贴板为空]');
      }
    }
    RE_CLIPBOARD.lastIndex = 0;

    // $SELECTION
    if (RE_SELECTION.test(text)) {
      if (options.selection !== undefined) {
        text = text.replace(RE_SELECTION, options.selection);
        replaced.push('$SELECTION');
      } else {
        unresolved.push('$SELECTION');
        text = text.replace(RE_SELECTION, '[无选中文本]');
      }
    }
    RE_SELECTION.lastIndex = 0;

    // $FILE:path
    let fileMatch: RegExpExecArray | null;
    RE_FILE.lastIndex = 0;
    while ((fileMatch = RE_FILE.exec(text)) !== null) {
      const filePath = fileMatch[1];
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(options.cwd || process.cwd(), filePath);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        text = text.replace(fileMatch[0], content);
        replaced.push(`$FILE:${filePath}`);
      } catch {
        text = text.replace(fileMatch[0], `[文件不存在: ${filePath}]`);
        unresolved.push(`$FILE:${filePath}`);
      }
    }

    // $DATE
    if (RE_DATE.test(text)) {
      const date = new Date().toISOString().split('T')[0];
      text = text.replace(RE_DATE, date);
      replaced.push('$DATE');
    }
    RE_DATE.lastIndex = 0;

    // $TIME
    if (RE_TIME.test(text)) {
      const time = new Date().toISOString();
      text = text.replace(RE_TIME, time);
      replaced.push('$TIME');
    }
    RE_TIME.lastIndex = 0;

    // $CWD
    if (RE_CWD.test(text)) {
      text = text.replace(RE_CWD, options.cwd || process.cwd());
      replaced.push('$CWD');
    }
    RE_CWD.lastIndex = 0;

    return {
      text,
      command,
      replacedPlaceholders: replaced,
      unresolvedPlaceholders: unresolved,
    };
  }

  /**
   * 处理用户输入（检测命令 → 渲染模板）
   *
   * @returns 渲染后的文本，null 表示输入不是斜杠命令
   */
  processInput(
    input: string,
    options: {
      clipboard?: string;
      selection?: string;
      cwd?: string;
    } = {},
  ): SlashCommandRenderResult | null {
    const cmdName = this.detectCommand(input);
    if (!cmdName) return null;

    const command = this.getCommand(cmdName, options.cwd);
    if (!command) {
      return null;
    }

    const args = this.extractArguments(input);

    // 特殊处理 /help
    if (cmdName === 'help' || command.template === '__HELP__') {
      return {
        text: this.getHelpText(options.cwd),
        command,
        replacedPlaceholders: [],
        unresolvedPlaceholders: [],
      };
    }

    return this.render(command, {
      arguments: args,
      clipboard: options.clipboard,
      selection: options.selection,
      cwd: options.cwd,
    });
  }

  /** 获取帮助文本 */
  getHelpText(cwd?: string): string {
    const commands = this.loadAll(cwd);
    const lines: string[] = [
      '📋 可用斜杠命令',
      '',
    ];

    // 按来源分组
    const bySource: Record<string, SlashCommand[]> = { builtin: [], global: [], project: [] };
    for (const cmd of commands.values()) {
      bySource[cmd.source].push(cmd);
    }

    const labels: Record<string, string> = {
      builtin: '内置命令',
      global: '全局命令（~/.duan/commands/）',
      project: '项目命令（.duan/commands/）',
    };

    for (const source of ['builtin', 'global', 'project']) {
      const items = bySource[source];
      if (items.length === 0) continue;
      lines.push(`【${labels[source]}】`);
      for (const cmd of items.sort((a, b) => a.name.localeCompare(b.name))) {
        const desc = cmd.description ? ` — ${cmd.description}` : '';
        lines.push(`  /${cmd.name}${desc}`);
      }
      lines.push('');
    }

    lines.push('用法: /<命令名> <参数>');
    lines.push('占位符: $ARGUMENTS $CLIPBOARD $SELECTION $FILE:path $DATE $TIME $CWD');
    return lines.join('\n');
  }

  /**
   * 写入自定义命令
   */
  writeCommand(
    name: string,
    template: string,
    layer: 'global' | 'project' = 'project',
    cwd: string = process.cwd(),
  ): string {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeName) throw new Error('命令名只能包含字母、数字、下划线、连字符');

    const dir = layer === 'global'
      ? path.join(getDuanDataDir(), 'commands')
      : path.join(cwd, '.duan', 'commands');

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${safeName}.md`);
    fs.writeFileSync(filePath, template, 'utf-8');

    // 失效缓存
    this._cache = null;

    this.log.info('斜杠命令已写入', { filePath, layer });
    return filePath;
  }

  /**
   * v20.0 §2.4：暴露 slash_command 工具给 LLM
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'slash_command_list',
        description: '列出所有可用的斜杠命令（内置 + 全局 + 项目级）。',
        parameters: {},
        readOnly: true,
        execute: async () => {
          return this.getHelpText();
        },
      },
      {
        name: 'slash_command_execute',
        description: '执行斜杠命令并返回渲染后的文本。支持占位符：$ARGUMENTS $CLIPBOARD $SELECTION $FILE:path $DATE $TIME $CWD。',
        parameters: {
          command: {
            type: 'string',
            description: '命令名（不含 /，如 review、test、init）',
            required: true,
          },
          arguments: {
            type: 'string',
            description: '命令参数',
            required: false,
          },
        },
        execute: async (args: { command?: string; arguments?: string }) => {
          const cmdName = args?.command as string;
          const cmdArgs = (args?.arguments as string) || '';

          if (!cmdName) {
            return '❌ 缺少 command 参数。可用命令：' + this.listCommands().join(', ');
          }

          const command = this.getCommand(cmdName);
          if (!command) {
            return `❌ 未知命令 "/${cmdName}"。可用命令：` + this.listCommands().join(', ');
          }

          if (cmdName === 'help' || command.template === '__HELP__') {
            return this.getHelpText();
          }

          const result = this.render(command, { arguments: cmdArgs });
          return result.text;
        },
      },
    ];
  }

  /** 清除缓存 */
  invalidateCache(): void {
    this._cache = null;
  }
}

// ============ 单例 ============

let _instance: SlashCommandRegistry | null = null;

export function getSlashCommandRegistry(): SlashCommandRegistry {
  if (!_instance) {
    _instance = new SlashCommandRegistry();
  }
  return _instance;
}
