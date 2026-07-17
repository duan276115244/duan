/**
 * v21 Hooks 增强内置钩子 — 对标 Claude Code Hooks 体系
 *
 * 在 lifecycle-hooks.ts 基础上新增 5 个内置钩子：
 * 1. ProjectContextHook — UserPromptSubmit 时自动注入项目上下文
 * 2. StopNotificationHook — Stop 时发送系统通知
 * 3. PreCompactGitHook — PreCompact 时注入 git 状态
 * 4. AutoFormatHook — PostToolUse 后自动格式化代码
 * 5. DangerousCommandHook — PreToolUse 拦截危险命令
 * 6. PromptSafetyHook — 使用 LLM 判断命令安全性（复杂场景）
 *
 * 另含配置文件加载器：从 .duan/settings.json 的 hooks 字段加载用户自定义钩子配置
 */

import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  LifecycleEvent,
  LifecycleHookManager,
  createLifecycleHookManager,
  type HookContext,
  type HookResult,
  type HookHandler,
} from './lifecycle-hooks.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import { duanPath } from './duan-paths.js';
import { matchDangerousCommand } from './security-config.js';

// ============ 1. 项目上下文钩子 ============

/**
 * 项目上下文钩子 — ProjectContextHook
 *
 * 监听 ON_USER_PROMPT_SUBMIT，每次用户提交 prompt 时自动注入项目上下文：
 * - 当前 git 分支
 * - 最近一次 commit 信息
 * - 最近修改的文件列表
 *
 * 对标 Claude Code UserPromptSubmit Hook
 */
export class ProjectContextHook {
  name = 'project_context';
  priority = 30;
  /** 工作目录 */
  private cwd: string;
  /** 是否已检测到 git 仓库 */
  private isGitRepo: boolean | null = null;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  handler = (context: HookContext): Promise<HookResult> => {
    // 检测是否为 git 仓库（只检测一次）
    if (this.isGitRepo === null) {
      this.isGitRepo = this.checkGitRepo();
    }
    if (!this.isGitRepo) {
      return Promise.resolve({ action: 'continue' });
    }

    try {
      const branch = this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      const lastCommit = this.execGit(['log', '-1', '--pretty=%h %s']);
      const modifiedFiles = this.execGit(['status', '--short', '--untracked-files=no']);

      const projectContext = [
        `## 项目上下文（自动注入）`,
        `- Git 分支: ${branch}`,
        `- 最近提交: ${lastCommit}`,
        `- 修改文件:`,
        ...modifiedFiles.split('\n').filter(Boolean).slice(0, 10).map((f) => `  - ${f}`),
      ].join('\n');

      return Promise.resolve({
        action: 'modify',
        modifiedData: { projectContext },
        reason: '注入项目上下文（git 分支/最近 commit/修改文件）',
      });
    } catch {
      // git 命令失败时不阻断流程
      return Promise.resolve({ action: 'continue' });
    }
  };

  private checkGitRepo(): boolean {
    try {
      this.execGit(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  private execGit(args: string[]): string {
    try {
      const result = execSync(`git ${args.join(' ')}`, {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return result.trim();
    } catch {
      return '';
    }
  }
}

// ============ 2. 任务完成通知钩子 ============

/**
 * 任务完成通知钩子 — StopNotificationHook
 *
 * 监听 ON_STOP，任务完成时发送系统通知。
 * 支持 Windows (toast) / macOS (osascript) / Linux (notify-send)。
 *
 * 对标 Claude Code Stop Hook
 */
export class StopNotificationHook {
  name = 'stop_notification';
  priority = 50;

  /** 通知标题 */
  private title: string;
  /** 是否启用声音 */
  private sound: boolean;
  /** 平台 */
  private platform: string;

  constructor(title: string = '段先生任务完成', sound: boolean = true) {
    this.title = title;
    this.sound = sound;
    this.platform = process.platform;
  }

  handler = (context: HookContext): Promise<HookResult> => {
    const message = (context.data.message as string) ?? '任务已完成';
    this.notify(this.title, message);

    return Promise.resolve({ action: 'continue' });
  };

  private notify(title: string, message: string): void {
    try {
      if (this.platform === 'win32') {
        // Windows: 使用 PowerShell toast 通知
        // 安全：用 -EncodedCommand + Base64 避免 title/message 中的 shell 元字符注入
        const psScript = `
          [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
          $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
          $textNodes = $template.GetElementsByTagName("text")
          $textNodes.Item(0).AppendChild($template.CreateTextNode([System.String]::Join('', ${JSON.stringify(title).replace(/^"|"$/g, "'")}.ToCharArray()))) | Out-Null
          $textNodes.Item(1).AppendChild($template.CreateTextNode([System.String]::Join('', ${JSON.stringify(message).replace(/^"|"$/g, "'")}.ToCharArray()))) | Out-Null
          $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
          [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("段先生").Show($toast)
        `;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
          timeout: 5000,
          stdio: 'ignore',
          shell: false,
        });
      } else if (this.platform === 'darwin') {
        // macOS: 使用 osascript
        // 安全：execFileSync + 数组参数，title/message 作为独立参数传递，不经过 shell 解释
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${this.sound ? ' sound name "Glass"' : ''}`;
        execFileSync('osascript', ['-e', script], { timeout: 5000, stdio: 'ignore', shell: false });
      } else {
        // Linux: 使用 notify-send
        // 安全：execFileSync + 数组参数，title/message 作为独立参数传递
        execFileSync('notify-send', [title, message], { timeout: 5000, stdio: 'ignore', shell: false });
      }
    } catch {
      // 通知失败不影响主流程
    }
  }
}

// ============ 3. 上下文压缩前 Git 注入钩子 ============

/**
 * 上下文压缩前 Git 注入钩子 — PreCompactGitHook
 *
 * 监听 ON_PRE_COMPACT，上下文压缩前注入关键信息：
 * - git status 完整输出
 * - 未完成的任务列表（从 data 中读取）
 * - 重要的上下文标记
 *
 * 对标 Claude Code PreCompact Hook
 */
export class PreCompactGitHook {
  name = 'pre_compact_git';
  priority = 40;
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  handler = (context: HookContext): Promise<HookResult> => {
    const criticalInfo: string[] = ['## 压缩前关键信息（请保留）'];

    // 注入 git status
    try {
      const status = execSync('git status --short', {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (status) {
        criticalInfo.push('### Git 状态');
        criticalInfo.push('```');
        criticalInfo.push(status);
        criticalInfo.push('```');
      }
    } catch {
      // 非 git 仓库或 git 不可用
    }

    // 注入未完成任务
    const pendingTasks = context.data.pendingTasks as string[] | undefined;
    if (pendingTasks && pendingTasks.length > 0) {
      criticalInfo.push('### 未完成任务');
      for (const task of pendingTasks) {
        criticalInfo.push(`- ${task}`);
      }
    }

    // 注入当前会话摘要
    const sessionSummary = context.data.sessionSummary as string | undefined;
    if (sessionSummary) {
      criticalInfo.push('### 会话摘要');
      criticalInfo.push(sessionSummary);
    }

    if (criticalInfo.length === 1) {
      // 没有关键信息可注入
      return Promise.resolve({ action: 'continue' });
    }

    return Promise.resolve({
      action: 'modify',
      modifiedData: { criticalContext: criticalInfo.join('\n') },
      reason: '压缩前注入 git 状态和关键信息',
    });
  };
}

// ============ 4. 自动格式化钩子 ============

/**
 * 自动格式化钩子 — AutoFormatHook
 *
 * 监听 ON_TOOL_RESULT，当工具修改了文件后自动运行格式化工具。
 * 支持的格式化工具：
 * - TypeScript/JavaScript: prettier
 * - Python: black
 * - Go: gofmt
 * - Rust: rustfmt
 *
 * 对标 Claude Code PostToolUse Hook（自动格式化）
 */
export class AutoFormatHook {
  name = 'auto_format';
  priority = 60;

  /** 文件扩展名到格式化工具的映射 */
  private formatterMap: Map<string, { cmd: string; args: string[] }> = new Map([
    ['.ts', { cmd: 'prettier', args: ['--write'] }],
    ['.tsx', { cmd: 'prettier', args: ['--write'] }],
    ['.js', { cmd: 'prettier', args: ['--write'] }],
    ['.jsx', { cmd: 'prettier', args: ['--write'] }],
    ['.json', { cmd: 'prettier', args: ['--write'] }],
    ['.css', { cmd: 'prettier', args: ['--write'] }],
    ['.html', { cmd: 'prettier', args: ['--write'] }],
    ['.md', { cmd: 'prettier', args: ['--write'] }],
    ['.py', { cmd: 'black', args: ['--quiet'] }],
    ['.go', { cmd: 'gofmt', args: ['-w'] }],
    ['.rs', { cmd: 'rustfmt', args: ['--edition', '2021'] }],
  ]);

  /** 工具名 → 是否会修改文件 */
  private fileModifyingTools = new Set([
    'file_write',
    'file_edit',
    'self_write',
    'self_patch',
    'multi_file_edit',
    'diff_apply',
  ]);

  handler = (context: HookContext): Promise<HookResult> => {
    const toolName = context.data.toolName as string;
    const toolResult = context.data.toolResult as { files?: string[] } | undefined;

    // 只对文件修改类工具生效
    if (!this.fileModifyingTools.has(toolName)) {
      return Promise.resolve({ action: 'continue' });
    }

    const files = toolResult?.files ?? (context.data.files as string[] | undefined) ?? [];
    const formattedFiles: string[] = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const formatter = this.formatterMap.get(ext);
      if (!formatter) continue;

      try {
        // 安全：execFileSync + 数组参数 + shell:false，file 作为独立参数传递不经过 shell 解释
        execFileSync(formatter.cmd, [...formatter.args, file], {
          timeout: 10000,
          stdio: 'ignore',
          cwd: path.dirname(file),
          shell: false,
        });
        formattedFiles.push(file);
      } catch {
        // 格式化工具不可用或格式化失败，跳过
      }
    }

    if (formattedFiles.length > 0) {
      return Promise.resolve({
        action: 'modify',
        modifiedData: { formattedFiles },
        reason: `自动格式化 ${formattedFiles.length} 个文件`,
      });
    }

    return Promise.resolve({ action: 'continue' });
  };

  /** 注册自定义格式化工具 */
  registerFormatter(extension: string, cmd: string, args: string[]): void {
    this.formatterMap.set(extension, { cmd, args });
  }
}

// ============ 5. 危险命令拦截钩子 ============

/**
 * 危险命令拦截钩子 — DangerousCommandHook
 *
 * 监听 ON_TOOL_CALL，拦截危险命令：
 * - rm -rf / (根目录删除)
 * - DROP TABLE / DROP DATABASE (数据库删除)
 * - git push --force (强制推送)
 * - mkfs (格式化磁盘)
 * - :(){:|:&};: (fork 炸弹)
 * - chmod -R 777 / (全盘权限修改)
 *
 * 对标 Claude Code PreToolUse Hook（危险命令拦截）
 */
export class DangerousCommandHook {
  name = 'dangerous_command';
  priority = 5; // 最高优先级，尽早拦截

  /** 危险命令正则模式 */
  private dangerousPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /rm\s+-rf\s+\/(\s|$)/, reason: '禁止删除根目录' },
    { pattern: /rm\s+-rf\s+~/, reason: '禁止删除用户主目录' },
    { pattern: /rm\s+-rf\s+\*\s*$/, reason: '禁止删除当前目录所有文件' },
    { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, reason: '禁止 DROP TABLE/DATABASE/SCHEMA' },
    { pattern: /TRUNCATE\s+TABLE/i, reason: '禁止 TRUNCATE TABLE' },
    { pattern: /git\s+push\s+.*--force/, reason: '禁止 git push --force（使用 --force-with-lease）' },
    { pattern: /git\s+push\s+-f\s/, reason: '禁止 git push -f（使用 --force-with-lease）' },
    { pattern: /mkfs/i, reason: '禁止格式化磁盘' },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: '禁止 fork 炸弹' },
    { pattern: /chmod\s+-R\s+777\s+\//, reason: '禁止全盘 777 权限' },
    { pattern: /dd\s+.*of=\/dev\//, reason: '禁止写入设备文件' },
    { pattern: /shutdown|reboot|halt|poweroff/i, reason: '禁止关机/重启命令' },
    { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/, reason: '禁止 curl | shell（可能执行恶意脚本）' },
    { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/, reason: '禁止 wget | shell（可能执行恶意脚本）' },
  ];

  /** 需要检查的工具名 */
  private commandTools = new Set([
    'shell_execute',
    'code_execute',
    'terminal_operate',
    'app_operate',
  ]);

  handler = (context: HookContext): Promise<HookResult> => {
    const toolName = context.data.toolName as string;
    if (!this.commandTools.has(toolName)) {
      return Promise.resolve({ action: 'continue' });
    }

    // 提取命令字符串
    const command = (context.data.command as string) ??
      (context.data.toolArgs as { command?: string } | undefined)?.command ??
      '';

    if (!command) {
      return Promise.resolve({ action: 'continue' });
    }

    for (const { pattern, reason } of this.dangerousPatterns) {
      if (pattern.test(command)) {
        return Promise.resolve({
          action: 'block',
          reason: `危险命令拦截: ${reason}（命令: ${command.substring(0, 80)}）`,
        });
      }
    }

    return Promise.resolve({ action: 'continue' });
  };

  /** 添加自定义危险命令模式 */
  addDangerousPattern(pattern: RegExp, reason: string): void {
    this.dangerousPatterns.push({ pattern, reason });
  }

  /** 获取所有危险命令模式 */
  getPatterns(): ReadonlyArray<{ pattern: RegExp; reason: string }> {
    return this.dangerousPatterns;
  }
}

// ============ 6. Prompt 安全审查钩子（LLM 判断） ============

/**
 * Prompt 安全审查钩子 — PromptSafetyHook
 *
 * 监听 ON_USER_PROMPT_SUBMIT，对复杂的用户输入使用规则引擎判断安全性。
 * （完整 LLM 判断需要注入 ModelLibrary，此处先实现规则引擎版本，后续可扩展）
 *
 * 对标 Claude Code prompt 类型 Hook（AI 模型判断命令安全性）
 */
export class PromptSafetyHook {
  name = 'prompt_safety';
  priority = 10; // 最高优先级，尽早检查

  /** 禁止的 prompt 模式 */
  private forbiddenPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i, reason: '检测到 prompt 注入尝试（忽略之前的指令）' },
    { pattern: /forget\s+(everything|all|previous)/i, reason: '检测到 prompt 注入尝试（忘记所有）' },
    { pattern: /you\s+are\s+(now|a)\s+(dan|evil|hacker)/i, reason: '检测到角色劫持尝试' },
    { pattern: /system\s*:\s*override/i, reason: '检测到系统覆盖尝试' },
    { pattern: /reveal\s+(your|the)\s+(system\s+)?prompt/i, reason: '检测到 prompt 泄露尝试' },
    { pattern: /jailbreak/i, reason: '检测到越狱尝试' },
  ];

  handler = (context: HookContext): Promise<HookResult> => {
    const prompt = (context.data.prompt as string) ??
      (context.data.userInput as string) ??
      '';

    if (!prompt || prompt.length < 5) {
      return Promise.resolve({ action: 'continue' });
    }

    for (const { pattern, reason } of this.forbiddenPatterns) {
      if (pattern.test(prompt)) {
        return Promise.resolve({
          action: 'block',
          reason: `安全拦截: ${reason}`,
        });
      }
    }

    return Promise.resolve({ action: 'continue' });
  };

  /** 添加自定义禁止模式 */
  addForbiddenPattern(pattern: RegExp, reason: string): void {
    this.forbiddenPatterns.push({ pattern, reason });
  }
}

// ============ 配置文件加载器 ============

/** 用户自定义钩子配置（从 .duan/settings.json 加载） */
export interface HookConfig {
  /** 启用的内置钩子 */
  enabled?: string[];
  /** 禁用的内置钩子 */
  disabled?: string[];
  /** 自定义钩子参数 */
  options?: {
    rateLimitPerMinute?: number;
    tokenBudgetPerSession?: number;
    maxErrorRetries?: number;
    enableProjectContext?: boolean;
    enableStopNotification?: boolean;
    enablePreCompactGit?: boolean;
    enableAutoFormat?: boolean;
    enableDangerousCommandBlock?: boolean;
    enablePromptSafety?: boolean;
    stopNotificationTitle?: string;
    stopNotificationSound?: boolean;
  };
}

/** 从 .duan/settings.json 加载 hooks 配置 */
export function loadHookConfig(): HookConfig {
  try {
    const configPath = path.join(duanPath(''), 'settings.json');
    if (!fs.existsSync(configPath)) {
      return { options: {} };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    return config.hooks ?? { options: {} };
  } catch {
    return { options: {} };
  }
}

/** 保存 hooks 配置到 .duan/settings.json */
export function saveHookConfig(hookConfig: HookConfig): void {
  try {
    const configPath = path.join(duanPath(''), 'settings.json');
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    config.hooks = hookConfig;
    atomicWriteJsonSync(configPath, config);
  } catch {
    // 配置保存失败不影响主流程
  }
}

// ============ 增强工厂函数 ============

/** v21 增强版内置钩子配置选项 */
export interface EnhancedHooksOptions {
  // 基础选项（继承自 v20）
  rateLimitPerMinute?: number;
  tokenBudgetPerSession?: number;
  maxErrorRetries?: number;
  // v21 新增
  enableProjectContext?: boolean;
  enableStopNotification?: boolean;
  enablePreCompactGit?: boolean;
  enableAutoFormat?: boolean;
  enableDangerousCommandBlock?: boolean;
  enablePromptSafety?: boolean;
  stopNotificationTitle?: string;
  stopNotificationSound?: boolean;
  /** 工作目录 */
  cwd?: string;
}

/**
 * 创建 v21 增强版 LifecycleHookManager（包含 v20 基础钩子 + v21 新增钩子）
 */
export function createEnhancedLifecycleHookManager(options?: EnhancedHooksOptions) {
  // 先创建 v20 基础管理器
  const base = createLifecycleHookManager({
    rateLimitPerMinute: options?.rateLimitPerMinute,
    tokenBudgetPerSession: options?.tokenBudgetPerSession,
    maxErrorRetries: options?.maxErrorRetries,
  });
  const manager = base.manager;

  // v21 新增钩子
  const projectContextHook = new ProjectContextHook(options?.cwd);
  const stopNotificationHook = new StopNotificationHook(
    options?.stopNotificationTitle,
    options?.stopNotificationSound ?? true,
  );
  const preCompactGitHook = new PreCompactGitHook(options?.cwd);
  const autoFormatHook = new AutoFormatHook();
  const dangerousCommandHook = new DangerousCommandHook();
  const promptSafetyHook = new PromptSafetyHook();

  // 按需注册 v21 钩子
  if (options?.enableProjectContext !== false) {
    manager.register(LifecycleEvent.ON_USER_PROMPT_SUBMIT, {
      name: projectContextHook.name,
      priority: projectContextHook.priority,
      handler: projectContextHook.handler,
    });
  }

  if (options?.enableStopNotification !== false) {
    manager.register(LifecycleEvent.ON_STOP, {
      name: stopNotificationHook.name,
      priority: stopNotificationHook.priority,
      handler: stopNotificationHook.handler,
    });
  }

  if (options?.enablePreCompactGit !== false) {
    manager.register(LifecycleEvent.ON_PRE_COMPACT, {
      name: preCompactGitHook.name,
      priority: preCompactGitHook.priority,
      handler: preCompactGitHook.handler,
    });
  }

  if (options?.enableAutoFormat !== false) {
    manager.register(LifecycleEvent.ON_TOOL_RESULT, {
      name: autoFormatHook.name,
      priority: autoFormatHook.priority,
      handler: autoFormatHook.handler,
    });
  }

  if (options?.enableDangerousCommandBlock !== false) {
    manager.register(LifecycleEvent.ON_TOOL_CALL, {
      name: dangerousCommandHook.name,
      priority: dangerousCommandHook.priority,
      handler: dangerousCommandHook.handler,
    });
  }

  if (options?.enablePromptSafety !== false) {
    manager.register(LifecycleEvent.ON_USER_PROMPT_SUBMIT, {
      name: promptSafetyHook.name,
      priority: promptSafetyHook.priority,
      handler: promptSafetyHook.handler,
    });
  }

  return {
    manager,
    // v20 基础钩子
    rateLimitHook: base.rateLimitHook,
    tokenBudgetHook: base.tokenBudgetHook,
    securityAuditHook: base.securityAuditHook,
    costTrackingHook: base.costTrackingHook,
    errorRecoveryHook: base.errorRecoveryHook,
    sessionCleanupHook: base.sessionCleanupHook,
    // v21 新增钩子
    projectContextHook,
    stopNotificationHook,
    preCompactGitHook,
    autoFormatHook,
    dangerousCommandHook,
    promptSafetyHook,
  };
}

// ============ LLM 工具定义 ============

/** Hooks 管理 LLM 工具定义 */
export function getHooksToolDefinitions() {
  return [
    {
      name: 'hooks_list',
      description: '列出所有已注册的生命周期钩子，可按事件类型过滤',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event: {
            type: 'string',
            description: '按事件类型过滤（可选）。可选值: on_llm_request, on_llm_response, on_tool_call, on_tool_result, on_error, on_loop_complete, on_session_start, on_session_end, on_context_compress, on_subagent_dispatch, on_subagent_result, on_user_prompt_submit, on_stop, on_pre_compact, on_subagent_start, on_subagent_stop',
          },
        },
      },
    },
    {
      name: 'hooks_register',
      description: '注册自定义生命周期钩子（通过配置文件方式）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event: {
            type: 'string',
            description: '要监听的事件类型',
          },
          name: {
            type: 'string',
            description: '钩子名称（同一事件内唯一）',
          },
          priority: {
            type: 'number',
            description: '优先级（数值越小越先执行，默认 100）',
          },
          command: {
            type: 'string',
            description: '要执行的 shell 命令（钩子触发时执行）',
          },
        },
        required: ['event', 'name', 'command'],
      },
    },
    {
      name: 'hooks_unregister',
      description: '移除已注册的生命周期钩子',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event: { type: 'string', description: '事件类型' },
          name: { type: 'string', description: '钩子名称' },
        },
        required: ['event', 'name'],
      },
    },
    {
      name: 'hooks_config_get',
      description: '获取当前 hooks 配置（从 .duan/settings.json）',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'hooks_config_set',
      description: '更新 hooks 配置（启用/禁用内置钩子，调整参数）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          enabled: {
            type: 'array',
            items: { type: 'string' },
            description: '启用的内置钩子名称列表',
          },
          disabled: {
            type: 'array',
            items: { type: 'string' },
            description: '禁用的内置钩子名称列表',
          },
          options: {
            type: 'object',
            description: '钩子参数配置',
          },
        },
      },
    },
  ];
}

/** Hooks 工具处理器 */
export function createHooksToolHandler(manager: LifecycleHookManager) {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'hooks_list': {
        const event = args.event as string | undefined;
        const eventEnum = event ? (event as LifecycleEvent) : undefined;
        return manager.getHooks(eventEnum);
      }
      case 'hooks_register': {
        const { event, name, priority, command } = args as {
          event: string;
          name: string;
          priority?: number;
          command: string;
        };
        // 安全：拦截危险命令（rm -rf / del /f format 等），防止 LLM 被诱导执行破坏性操作
        const danger = matchDangerousCommand(command);
        if (danger) {
          return {
            registered: false,
            event,
            name,
            error: `命令被安全策略拦截：匹配危险模式 ${danger.source}`,
            pattern: danger.source,
          };
        }
        const handler: HookHandler = {
          name,
          priority: priority ?? 100,
          handler: async () => {
            try {
              execSync(command, { timeout: 30000, stdio: 'ignore' });
            } catch {
              // 命令执行失败不阻断流程
            }
            return { action: 'continue' };
          },
        };
        manager.register(event as LifecycleEvent, handler);
        return { registered: true, event, name };
      }
      case 'hooks_unregister': {
        const { event, name } = args as { event: string; name: string };
        const removed = manager.unregister(event as LifecycleEvent, name);
        return { removed, event, name };
      }
      case 'hooks_config_get': {
        return loadHookConfig();
      }
      case 'hooks_config_set': {
        const config = args as HookConfig;
        saveHookConfig(config);
        return { saved: true };
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
