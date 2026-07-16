/**
 * v20.0 §2.5 分级许可清单 — ToolPermissionRegistry
 *
 * 对标 Claude Code permissions：4 种方式管理工具许可，提升安全与便利平衡。
 *
 * 四级来源（优先级从高到低）：
 * 1. 会话级（session）：运行时 grant/revoke，进程结束即失效
 * 2. CLI 标志（cli）：`duan --allow Edit --allow "Bash(git:*)"` 启动时注入
 * 3. 项目级（project）：`.duan/settings.json` 的 `permissions` 字段
 * 4. 全局级（global）：`~/.duan/settings.json` 的 `permissions` 字段
 *
 * 决策语义：
 * - `allow`  → 自动放行（跳过 ApprovalGate）
 * - `deny`   → 自动拒绝（工具不执行）
 * - `ask`    → 走 ApprovalGate 审批流程
 *
 * 模式匹配（兼容 Claude Code 语法）：
 * - `Edit`              精确匹配工具名
 * - `Bash(git:*)`       匹配 Bash 工具且参数以 git: 开头
 * - `Read(*)`           匹配 Read 工具的任意参数
 * - `*`                 匹配所有工具
 *
 * 与现有架构融合：
 * - 不替换 PermissionManager（RBAC）和 ApprovalGate
 * - 在 ApprovalGate.checkApproval 之前作为快速筛选层
 * - RBAC 管角色，本模块管会话/项目/全局许可覆盖
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 许可决策 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** 许可来源（优先级从高到低） */
export type PermissionSource = 'session' | 'cli' | 'project' | 'global';

/** 单条许可规则 */
export interface PermissionRule {
  /** 模式：工具名或模式（如 `Edit`、`Bash(git:*)`、`*`） */
  pattern: string;
  /** 决策 */
  decision: PermissionDecision;
  /** 来源 */
  source: PermissionSource;
  /** 备注（可选） */
  note?: string;
  /** 创建时间 */
  createdAt: number;
}

/** settings.json 中的 permissions 字段结构 */
export interface PermissionsConfig {
  /** 允许的工具模式列表 */
  allow?: string[];
  /** 拒绝的工具模式列表 */
  deny?: string[];
  /** 需要询问的工具模式列表 */
  ask?: string[];
}

/** settings.json 完整结构 */
export interface SettingsJson {
  permissions?: PermissionsConfig;
  // 保留扩展字段（未来可加 model、theme 等）
  [key: string]: unknown;
}

/** 检查结果 */
export interface PermissionCheckResult {
  /** 最终决策 */
  decision: PermissionDecision;
  /** 命中的规则（null 表示未命中任何规则，走默认策略） */
  matchedRule: PermissionRule | null;
  /** 所有命中的规则（按优先级排序） */
  matchedRules: PermissionRule[];
  /** 决策原因 */
  reason: string;
}

// ============ 主类 ============

export class ToolPermissionRegistry {
  private log = logger.child({ module: 'ToolPermissionRegistry' });

  /** 四级规则存储：source → rules[] */
  private rulesBySource: Map<PermissionSource, PermissionRule[]> = new Map([
    ['session', []],
    ['cli', []],
    ['project', []],
    ['global', []],
  ]);

  /** 默认决策（无任何规则命中时） */
  private defaultDecision: PermissionDecision = 'ask';

  /** 已加载的项目根目录（用于 project 级配置） */
  private projectRoot: string | null = null;

  /** 全局 settings.json 路径 */
  private globalSettingsPath: string;

  /** 项目 settings.json 路径 */
  private projectSettingsPath: string | null = null;

  constructor() {
    this.globalSettingsPath = duanPath('settings.json');
  }

  // ============ 加载 ============

  /**
   * 加载全局 + 项目级 settings.json
   * @param projectRoot 项目根目录（默认 process.cwd()）
   */
  load(projectRoot?: string): void {
    this.projectRoot = projectRoot || process.cwd();
    this.projectSettingsPath = path.join(this.projectRoot, '.duan', 'settings.json');

    // 1. 加载全局级
    this.loadFromSource('global', this.globalSettingsPath);

    // 2. 加载项目级（覆盖全局）
    if (this.projectSettingsPath && fs.existsSync(this.projectSettingsPath)) {
      this.loadFromSource('project', this.projectSettingsPath);
    }

    this.log.info('许可清单已加载', {
      global: this.rulesBySource.get('global')!.length,
      project: this.rulesBySource.get('project')!.length,
      cli: this.rulesBySource.get('cli')!.length,
      session: this.rulesBySource.get('session')!.length,
    });
  }

  /** 从指定 settings.json 文件加载规则 */
  private loadFromSource(source: PermissionSource, filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const settings = JSON.parse(raw) as SettingsJson;
      const perms = settings.permissions;
      if (!perms) return;

      const rules: PermissionRule[] = [];
      const now = Date.now();

      for (const pattern of perms.allow || []) {
        rules.push({ pattern, decision: 'allow', source, createdAt: now });
      }
      for (const pattern of perms.deny || []) {
        rules.push({ pattern, decision: 'deny', source, createdAt: now });
      }
      for (const pattern of perms.ask || []) {
        rules.push({ pattern, decision: 'ask', source, createdAt: now });
      }

      this.rulesBySource.set(source, rules);
      this.log.debug(`从 ${source} settings.json 加载 ${rules.length} 条规则`, { path: filePath });
    } catch (err: unknown) {
      this.log.warn(`加载 ${source} settings.json 失败`, {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============ CLI 注入 ============

  /**
   * 从 CLI 标志注入规则
   * @param allowPatterns `--allow` 标志的模式列表
   * @param denyPatterns `--deny` 标志的模式列表
   */
  loadFromCli(allowPatterns: string[] = [], denyPatterns: string[] = []): void {
    const rules: PermissionRule[] = [];
    const now = Date.now();
    for (const pattern of allowPatterns) {
      rules.push({ pattern, decision: 'allow', source: 'cli', createdAt: now });
    }
    for (const pattern of denyPatterns) {
      rules.push({ pattern, decision: 'deny', source: 'cli', createdAt: now });
    }
    this.rulesBySource.set('cli', rules);
    this.log.info(`从 CLI 注入 ${rules.length} 条许可规则`, {
      allow: allowPatterns.length,
      deny: denyPatterns.length,
    });
  }

  // ============ 会话级运行时操作 ============

  /**
   * 会话级 grant（运行时授权）
   * @param pattern 工具模式
   * @param decision 决策（默认 allow）
   * @param note 备注
   */
  grant(pattern: string, decision: PermissionDecision = 'allow', note?: string): void {
    // 移除同模式的旧规则（避免重复）
    this.revoke(pattern, 'session');
    const rule: PermissionRule = {
      pattern,
      decision,
      source: 'session',
      note,
      createdAt: Date.now(),
    };
    this.rulesBySource.get('session')!.push(rule);
    this.log.info('会话级许可已授予', { pattern, decision, note });
  }

  /**
   * 会话级 revoke（运行时撤销）
   * @param pattern 工具模式
   * @param source 来源（默认 session，也可撤销其他来源）
   */
  revoke(pattern: string, source: PermissionSource = 'session'): void {
    const rules = this.rulesBySource.get(source)!;
    const filtered = rules.filter(r => r.pattern !== pattern);
    const removed = rules.length - filtered.length;
    this.rulesBySource.set(source, filtered);
    if (removed > 0) {
      this.log.info('许可已撤销', { pattern, source, removed });
    }
  }

  /** 清空会话级所有规则 */
  clearSession(): void {
    this.rulesBySource.set('session', []);
    this.log.info('会话级许可已全部清空');
  }

  // ============ 持久化 ============

  /**
   * 保存项目级 settings.json
   * @param perms 权限配置
   */
  saveProjectSettings(perms: PermissionsConfig): void {
    if (!this.projectSettingsPath) {
      throw new Error('项目根目录未初始化，请先调用 load()');
    }
    this.saveSettings(this.projectSettingsPath, perms, 'project');
  }

  /**
   * 保存全局级 settings.json
   * @param perms 权限配置
   */
  saveGlobalSettings(perms: PermissionsConfig): void {
    this.saveSettings(this.globalSettingsPath, perms, 'global');
  }

  /** 保存 settings.json（合并现有字段） */
  private saveSettings(filePath: string, perms: PermissionsConfig, source: PermissionSource): void {
    try {
      // 读取现有配置（保留其他字段）
      let settings: SettingsJson = {};
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        settings = JSON.parse(raw) as SettingsJson;
      }
      settings.permissions = perms;

      // 确保目录存在
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      atomicWriteJsonSync(filePath, settings);
      this.log.info(`${source} 级 settings.json 已保存`, { path: filePath });

      // 重新加载该来源
      this.loadFromSource(source, filePath);
    } catch (err: unknown) {
      this.log.error(`保存 ${source} settings.json 失败`, {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // ============ 检查 ============

  /**
   * 检查工具是否被允许
   * @param toolName 工具名（如 `Edit`、`Bash`、`file_write`）
   * @param toolArgs 工具参数（用于模式匹配，如 `git push` → 匹配 `Bash(git:*)`）
   * @returns 检查结果
   */
  check(toolName: string, toolArgs?: unknown): PermissionCheckResult {
    const matchedRules: PermissionRule[] = [];

    // 按优先级遍历四个来源
    const sources: PermissionSource[] = ['session', 'cli', 'project', 'global'];
    for (const source of sources) {
      const rules = this.rulesBySource.get(source)!;
      for (const rule of rules) {
        if (this.matchPattern(rule.pattern, toolName, toolArgs)) {
          matchedRules.push(rule);
        }
      }
    }

    // 无命中 → 默认决策
    if (matchedRules.length === 0) {
      return {
        decision: this.defaultDecision,
        matchedRule: null,
        matchedRules: [],
        reason: `无许可规则命中，走默认策略: ${this.defaultDecision}`,
      };
    }

    // 命中规则优先级：deny > allow > ask（安全优先）
    // 同一优先级内取最高来源（session > cli > project > global）
    const sorted = [...matchedRules].sort((a, b) => {
      const priority: Record<PermissionDecision, number> = { deny: 0, allow: 1, ask: 2 };
      if (priority[a.decision] !== priority[b.decision]) {
        return priority[a.decision] - priority[b.decision];
      }
      const sourcePriority: Record<PermissionSource, number> = { session: 0, cli: 1, project: 2, global: 3 };
      return sourcePriority[a.source] - sourcePriority[b.source];
    });

    const top = sorted[0];
    return {
      decision: top.decision,
      matchedRule: top,
      matchedRules: sorted,
      reason: `命中 ${top.source} 级规则: ${top.pattern} → ${top.decision}`,
    };
  }

  /**
   * 快速判断是否自动放行（不需询问）
   */
  isAutoAllowed(toolName: string, toolArgs?: unknown): boolean {
    return this.check(toolName, toolArgs).decision === 'allow';
  }

  /**
   * 快速判断是否自动拒绝
   */
  isAutoDenied(toolName: string, toolArgs?: unknown): boolean {
    return this.check(toolName, toolArgs).decision === 'deny';
  }

  // ============ 模式匹配 ============

  /**
   * 匹配工具模式
   * @param pattern 模式（如 `Edit`、`Bash(git:*)`、`Read(*)`、`*`）
   * @param toolName 实际工具名
   * @param toolArgs 实际工具参数
   */
  private matchPattern(pattern: string, toolName: string, toolArgs?: unknown): boolean {
    // 通配符匹配所有工具
    if (pattern === '*') return true;

    // 带参数的模式：ToolName(argPattern)
    const parenMatch = pattern.match(/^(\w+)\((.*)\)$/);
    if (parenMatch) {
      const [, patToolName, argPattern] = parenMatch;
      if (patToolName !== toolName) return false;
      // argPattern 为 * → 匹配任意参数
      if (argPattern === '*') return true;
      // argPattern 为 prefix:* → 匹配参数以 prefix 开头（作为命令前缀）
      // 语义：`Bash(git:*)` 匹配 `git push` / `git` / `git:fetch`，但不匹配 `github clone`
      if (argPattern.endsWith(':*')) {
        const prefix = argPattern.slice(0, -2); // 去掉 `:*`
        const argStr = this.argsToString(toolArgs);
        // 三种匹配形式：精确等于 prefix、以 "prefix " 开头（空格分隔）、以 "prefix:" 开头（冒号分隔）
        return argStr === prefix
          || argStr.startsWith(prefix + ' ')
          || argStr.startsWith(prefix + ':');
      }
      // 精确匹配参数字符串
      const argStr = this.argsToString(toolArgs);
      return argStr === argPattern;
    }

    // 纯工具名匹配
    return pattern === toolName;
  }

  /** 将工具参数转换为字符串（用于模式匹配） */
  private argsToString(toolArgs: unknown): string {
    if (toolArgs === undefined || toolArgs === null) return '';
    if (typeof toolArgs === 'string') return toolArgs;
    if (typeof toolArgs === 'object') {
      // 对于 Bash 类工具，通常有 command 字段
      const obj = toolArgs as Record<string, unknown>;
      if (typeof obj.command === 'string') return obj.command;
      if (typeof obj.cmd === 'string') return obj.cmd;
      try {
        return JSON.stringify(obj);
      } catch {
        return String(obj);
      }
    }
    return String(toolArgs);
  }

  // ============ 查询 ============

  /** 获取所有规则（按来源分组） */
  getAllRules(): Record<PermissionSource, PermissionRule[]> {
    return {
      session: [...this.rulesBySource.get('session')!],
      cli: [...this.rulesBySource.get('cli')!],
      project: [...this.rulesBySource.get('project')!],
      global: [...this.rulesBySource.get('global')!],
    };
  }

  /** 获取指定来源的规则 */
  getRulesBySource(source: PermissionSource): PermissionRule[] {
    return [...this.rulesBySource.get(source)!];
  }

  /** 设置默认决策（无规则命中时） */
  setDefaultDecision(decision: PermissionDecision): void {
    this.defaultDecision = decision;
    this.log.info('默认许可决策已设置', { decision });
  }

  /** 获取默认决策 */
  getDefaultDecision(): PermissionDecision {
    return this.defaultDecision;
  }

  /** 获取全局 settings.json 路径 */
  getGlobalSettingsPath(): string {
    return this.globalSettingsPath;
  }

  /** 获取项目 settings.json 路径 */
  getProjectSettingsPath(): string | null {
    return this.projectSettingsPath;
  }

  // ============ 概览 ============

  /** 生成许可清单概览文本 */
  getOverview(): string {
    const lines: string[] = [];
    lines.push('=== 分级许可清单 ===');
    lines.push('');

    const sources: Array<{ key: PermissionSource; label: string }> = [
      { key: 'session', label: '会话级（运行时，最高优先级）' },
      { key: 'cli', label: 'CLI 标志' },
      { key: 'project', label: '项目级（.duan/settings.json）' },
      { key: 'global', label: '全局级（~/.duan/settings.json）' },
    ];

    for (const { key, label } of sources) {
      const rules = this.rulesBySource.get(key)!;
      lines.push(`【${label}】 ${rules.length} 条`);
      if (rules.length > 0) {
        for (const r of rules) {
          const note = r.note ? ` (${r.note})` : '';
          lines.push(`  ${r.pattern} → ${r.decision}${note}`);
        }
      }
      lines.push('');
    }

    lines.push(`默认决策: ${this.defaultDecision}（无规则命中时）`);
    lines.push('');
    lines.push('用法:');
    lines.push('  - 会话级: permission_grant({ pattern: "Edit", decision: "allow" })');
    lines.push('  - 项目级: 在 .duan/settings.json 中配置 permissions.allow/deny/ask');
    lines.push('  - CLI: duan --allow Edit --deny "Bash(rm:*)"');
    lines.push('  - 模式: Edit / Bash(git:*) / Read(*) / *');

    return lines.join('\n');
  }

  // ============ LLM 工具 ============

  /**
   * v20.0 §2.5：暴露许可管理工具给 LLM
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'permission_list',
        description: '查看当前分级许可清单（会话/CLI/项目/全局四级）。返回所有规则和默认决策。',
        parameters: {},
        readOnly: true,
        execute: async () => {
          return this.getOverview();
        },
      },
      {
        name: 'permission_grant',
        description: '会话级授权工具许可。运行时生效，进程结束失效。pattern 支持工具名（Edit）或模式（Bash(git:*)）。decision: allow/deny/ask。',
        parameters: {
          pattern: { type: 'string', description: '工具模式（如 Edit / Bash(git:*) / Read(*) / *）', required: true },
          decision: { type: 'string', description: '决策: allow（放行）/ deny（拒绝）/ ask（询问）', required: false },
          note: { type: 'string', description: '备注（可选）', required: false },
        },
        execute: async (args: { pattern?: string; decision?: string; note?: string }) => {
          if (!args?.pattern) return '❌ 缺少 pattern 参数';
          const validDecisions: PermissionDecision[] = ['allow', 'deny', 'ask'];
          const decision = (args.decision as PermissionDecision) || 'allow';
          if (!validDecisions.includes(decision)) {
            return `❌ 无效 decision: ${args.decision}（应为 allow/deny/ask）`;
          }
          this.grant(args.pattern, decision, args.note);
          return `✅ 会话级许可已授予: ${args.pattern} → ${decision}${args.note ? ` (${args.note})` : ''}`;
        },
      },
      {
        name: 'permission_revoke',
        description: '撤销会话级工具许可。仅能撤销当前会话内通过 permission_grant 添加的规则。',
        parameters: {
          pattern: { type: 'string', description: '要撤销的工具模式', required: true },
        },
        execute: async (args: { pattern?: string }) => {
          if (!args?.pattern) return '❌ 缺少 pattern 参数';
          this.revoke(args.pattern, 'session');
          return `✅ 会话级许可已撤销: ${args.pattern}`;
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: ToolPermissionRegistry | null = null;

export function getToolPermissionRegistry(): ToolPermissionRegistry {
  if (!_instance) {
    _instance = new ToolPermissionRegistry();
  }
  return _instance;
}
