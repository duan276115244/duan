/**
 * Slash 命令系统（对标 Claude Code / Devin CLI）
 *
 * 用户在输入框键入 / 即弹出命令自动完成菜单，一键执行常用操作。
 * 命令注册表 + 执行器，纯前端实现，不新增后端 API。
 *
 * 设计：
 * - execute 返回 string → 作为本地助手消息注入当前对话（适用于 /help /steps 等纯信息展示）
 * - execute 返回 void → 纯 UI 操作（如 /clear /model /revert /compact /plan），由 ctx 回调处理
 */

/** Slash 命令执行上下文 — 由 ChatArea 提供具体实现 */
export interface SlashCommandContext {
  /** 清空当前对话 */
  clearConversation: () => void;
  /** 打开配置页（模型切换） */
  openConfig: () => void;
  /** 回退最近一条 assistant 消息（复用 handleRollback） */
  rollbackLastAssistant: () => void;
  /** 重试最近一条 assistant 消息（复用 handleRetry） */
  retryLastAssistant: () => void;
  /** 切换计划模式标志（下一条消息前缀"请先制定执行计划再动手"） */
  togglePlanMode: () => void;
  /** 触发上下文压缩（发送特殊提示给 agent） */
  compactNow: () => void;
  /** 当前对话已执行的工具调用步数 */
  stepCount: () => number;
}

export interface SlashCommand {
  /** 命令名（不含 /），如 'help' */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 别名 */
  aliases?: string[];
  /**
   * 执行命令。
   * 返回 string → 作为本地助手消息注入当前对话（纯信息展示，不发送给 LLM）。
   * 返回 void → 纯 UI 操作，已由 ctx 回调完成。
   */
  execute: (ctx: SlashCommandContext) => void | string;
}

/** 生成 /help 命令的输出文本 */
function helpText(): string {
  const lines = ALL_SLASH_COMMANDS.map(c => {
    const alias = c.aliases && c.aliases.length > 0 ? ` (别名: ${c.aliases.map(a => '/' + a).join(', ')})` : '';
    return `- **/${c.name}**${alias} — ${c.description}`;
  });
  return `**可用 Slash 命令**\n\n${lines.join('\n')}\n\n输入 \`/<命令>\` 后按 Enter 执行。按 ↑↓ 选择，Esc 关闭菜单。`;
}

/** 生成 /steps 命令的输出文本 */
function stepsText(count: number): string {
  if (count === 0) return '**执行步数**\n\n当前对话尚未执行任何工具调用。';
  return `**执行步数**\n\n当前对话已执行 **${count}** 步工具调用。\n\n使用 \`/revert\` 可回退最近一次回复。`;
}

/** 所有已注册的 Slash 命令（顺序即菜单展示顺序） */
export const ALL_SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'help',
    description: '显示所有可用命令',
    execute: () => helpText(),
  },
  {
    name: 'clear',
    description: '清空当前对话',
    execute: (ctx) => { ctx.clearConversation(); },
  },
  {
    name: 'model',
    description: '切换模型（打开配置页）',
    execute: (ctx) => { ctx.openConfig(); },
  },
  {
    name: 'compact',
    description: '立即压缩上下文',
    execute: (ctx) => { ctx.compactNow(); },
  },
  {
    name: 'plan',
    description: '进入/退出计划模式',
    execute: (ctx) => { ctx.togglePlanMode(); },
  },
  {
    name: 'steps',
    description: '查看当前对话执行步数',
    execute: (ctx) => stepsText(ctx.stepCount()),
  },
  {
    name: 'revert',
    description: '回退最近一次回复',
    aliases: ['undo'],
    execute: (ctx) => { ctx.rollbackLastAssistant(); },
  },
  {
    name: 'memory',
    description: '查看项目记忆概览（v20.0 分层记忆）',
    aliases: ['mem'],
    execute: () => memoryHelpText(),
  },
];

/** /memory 命令输出 — 项目分层记忆系统说明 */
function memoryHelpText(): string {
  return `**项目分层记忆系统（v20.0）**

对标 Claude Code 的 CLAUDE.md 多层级记忆机制，支持三级项目约定加载：

**三级层级**
- 🌐 **用户全局层**：\`~/.duan/project-memory/*.md\`（所有项目共享的通用约定）
- 📦 **仓库根层**：\`<repo>/.duan/memory/*.md\`（项目级约定）
- 📁 **子目录层**：\`<subdir>/.duan/memory/*.md\`（子模块级约定，向上递归查找）

**优先级**：子目录 > 仓库根 > 用户全局（同名文件，子目录层优先）

**使用方式**
1. 直接让我"记住这个约定" → 自动写入项目级记忆
2. 询问"当前项目有哪些记忆" → 我会查询并展示
3. 手动创建 \`<repo>/.duan/memory/conventions.md\` 写入约定

**示例记忆文件**
\`\`\`markdown
# 编码约定
- 使用 TypeScript strict 模式
- 函数必须有返回类型注解
- 提交前运行 npm run typecheck
\`\`\`

记忆文件会在每次对话时自动加载并注入到我的上下文中。`;
}

/**
 * 根据输入查询过滤命令。
 * @param query 不含 / 的查询串（如 'he'、'' ）
 * @returns 匹配的命令列表（按 name 前缀匹配，其次别名前缀匹配）
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...ALL_SLASH_COMMANDS];
  return ALL_SLASH_COMMANDS.filter(c =>
    c.name.startsWith(q) || (c.aliases?.some(a => a.startsWith(q)) ?? false),
  );
}

/**
 * 精确匹配命令名（用于 handleSend 拦截时查找命令）。
 * @param cmdName 不含 / 的命令名
 */
export function findSlashCommand(cmdName: string): SlashCommand | undefined {
  const name = cmdName.toLowerCase();
  return ALL_SLASH_COMMANDS.find(c => c.name === name || (c.aliases?.includes(name) ?? false));
}
