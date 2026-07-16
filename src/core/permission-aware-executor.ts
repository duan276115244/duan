/**
 * 权限感知工具执行器
 *
 * 将 PermissionManager 集成到工具执行流程中：
 * - 执行前检查权限（支持 allow/deny/ask 三种模式）
 * - 高风险操作自动要求审批
 * - 通过 EventBus 发布权限事件
 * - 支持命令级别的细粒度控制（类似 OpenCode 的 BashArity）
 */

import type { PermissionManager, PermissionResult, SecurityContext } from './permissions.js';
import { EventBus, Events } from './event-bus.js';
import type { LazyToolDef, LazyToolRegistry } from './lazy-tool-registry.js';

export type ApprovalStrategy = 'auto_allow' | 'auto_deny' | 'require_approval';

export interface ExecutorConfig {
  approvalStrategy: ApprovalStrategy;
  securityContext?: Partial<SecurityContext>;
  /** 信任的 bash 命令前缀（不需要审批） */
  trustedCommands?: string[];
  /** 危险命令黑名单（始终拒绝） */
  deniedCommands?: string[];
  /** 审批超时毫秒（默认 30 秒） */
  approvalTimeoutMs?: number;
  /** 路径级权限规则（glob 模式） */
  pathRules?: PathPermissionRule[];
  /** per-user 调用频率限制（每分钟） */
  rateLimitPerMinute?: number;
}

/** 路径权限规则 */
export interface PathPermissionRule {
  pattern: string;        // glob 模式，如 /etc/** 或 /tmp/**
  allowed: boolean;       // true=允许，false=禁止
  tools?: string[];       // 适用工具名，空=所有工具
}

/** 危险命令黑名单（始终拒绝） */
const DEFAULT_DENIED_COMMANDS = [
  'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -rf .',
  'mkfs', 'dd if=', 'format ', 'shutdown', 'reboot',
  ':(){:|:&};:',  // fork bomb
  'chmod -R 777 /',
  'curl | sh', 'curl | bash', 'wget | sh', 'wget | bash',
  '> /dev/sda', '> /dev/hda',
];

const DEFAULT_TRUSTED_COMMANDS = [
  'npm run', 'npm test', 'npm start', 'npx tsx',
  'git status', 'git diff', 'git log', 'git branch',
  'ls', 'pwd', 'cat', 'head', 'tail', 'echo',
  'node -e', 'node --version', 'npm --version',
  'tsc --noEmit', 'tsc --version',
];

export class PermissionAwareExecutor {
  private permissionManager: PermissionManager;
  private toolRegistry: LazyToolRegistry;
  private eventBus: EventBus;
  private config: ExecutorConfig;
  private approvalQueue: Map<string, {
    toolId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,需在审批描述中访问具体字段
    args: any;
    resolve: (allowed: boolean) => void;
    timestamp: number;
    description: string;
  }> = new Map();
  /** per-user 调用频率追踪 — Map<userId, timestamp[]> */
  private rateLimitTracker: Map<string, number[]> = new Map();
  /** 审批超时 timer 句柄 — Map<requestId, setTimeout handle>，便于审批响应或 dispose 时清理 */
  private approvalTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    permissionManager: PermissionManager,
    toolRegistry: LazyToolRegistry,
    config?: Partial<ExecutorConfig>,
  ) {
    this.permissionManager = permissionManager;
    this.toolRegistry = toolRegistry;
    this.eventBus = EventBus.getInstance();
    this.config = {
      approvalStrategy: config?.approvalStrategy || 'require_approval',
      securityContext: config?.securityContext,
      trustedCommands: config?.trustedCommands || [...DEFAULT_TRUSTED_COMMANDS],
      deniedCommands: config?.deniedCommands || [...DEFAULT_DENIED_COMMANDS],
      approvalTimeoutMs: config?.approvalTimeoutMs || 30000,
      pathRules: config?.pathRules || [],
      rateLimitPerMinute: config?.rateLimitPerMinute || 60,
    };
  }

  /** 执行工具（带权限检查） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON,需透传至权限检查与工具执行
  async execute(toolId: string, args: any, context?: {
    userId?: string;
    sessionId?: string;
  }): Promise<string> {
    // P1-4 修复：O(1) Map 查找替代 O(n) 线性扫描
    const tool = await this.toolRegistry.getTool(toolId);
    if (!tool) return `错误: 工具 ${toolId} 未找到`;

    // 1. 构建安全上下文
    const securityContext: SecurityContext = {
      userId: context?.userId || 'default',
      sessionId: context?.sessionId,
      projectPath: process.cwd(),
      isTrustedEnvironment: true,
      timeOfDay: this.getTimeOfDay(),
      ...this.config.securityContext,
    };

    // 2. 权限检查
    const permissionCheck = await this.checkPermission(tool, args, securityContext);

    // 发布权限检查事件
    await this.eventBus.emit(Events.PERMISSION_CHECK, {
      toolId,
      toolName: tool.name,
      allowed: permissionCheck.allowed,
      requiresApproval: permissionCheck.requiresApproval,
      riskLevel: tool.riskLevel,
      reason: permissionCheck.reason,
    }, { source: 'permission-executor' });

    if (!permissionCheck.allowed && !permissionCheck.requiresApproval) {
      await this.eventBus.emit(Events.PERMISSION_DENIED, {
        toolId,
        toolName: tool.name,
        reason: permissionCheck.reason,
      }, { source: 'permission-executor' });
      return `权限不足: ${permissionCheck.reason || '操作被拒绝'}`;
    }

    // 3. 需要审批
    if (permissionCheck.requiresApproval && this.config.approvalStrategy !== 'auto_allow') {
      const allowed = await this.requestApproval(tool, args);
      if (!allowed) {
        return '操作已被用户取消';
      }
      await this.eventBus.emit(Events.PERMISSION_APPROVED, {
        toolId,
        toolName: tool.name,
      }, { source: 'permission-executor' });
    }

    // 4. 执行工具
    return this.toolRegistry.executeTool(toolId, args);
  }

  /** 检查权限 */
  private async checkPermission(
    tool: LazyToolDef,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,需访问 path/command 等字段
    args: any,
    context: SecurityContext,
  ): Promise<PermissionResult> {
    // 0. 频率限制检查
    if (context.userId) {
      const allowed = this.checkRateLimit(context.userId);
      if (!allowed) {
        return { allowed: false, reason: '调用频率超限，请稍后重试' };
      }
    }

    // 1. 路径级权限规则检查
    if (this.config.pathRules && this.config.pathRules.length > 0) {
      const pathArg = args?.path || args?.filePath || args?.file_path || args?.file;
      if (pathArg) {
        const pathResult = this.checkPathRules(String(pathArg), tool.name);
        if (pathResult) {
          return pathResult;
        }
      }
    }

    // 低风险工具自动放行
    if (tool.riskLevel === 'safe') {
      return { allowed: true };
    }

    // 2. 检查 bash 命令安全性（修复 startsWith 安全漏洞）
    if (tool.category === 'bash' && args?.command) {
      const command = args.command.trim();

      // 2a. 黑名单检查（始终拒绝）
      const isDenied = this.config.deniedCommands!.some(
        denied => command.toLowerCase().includes(denied.toLowerCase())
      );
      if (isDenied) {
        return { allowed: false, reason: `危险命令被拒绝: 命令匹配黑名单` };
      }

      // 2b. 命令链注入检测（包含 ; | && || 等元字符）
      const hasChain = /[;|&]|\|\||&&/.test(command);
      if (hasChain) {
        // 拆分为子命令，每个子命令都必须在白名单中
        const subCommands = command.split(/[;|&]|\|\||&&/).map(s => s.trim()).filter(Boolean);
        const allTrusted = subCommands.every(subCmd =>
          this.isCommandTrusted(subCmd)
        );
        if (!allTrusted) {
          return { allowed: false, requiresApproval: true, reason: '命令链包含非白名单子命令，需要审批' };
        }
        return { allowed: true };
      }

      // 2c. 单命令白名单检查（安全匹配：解析命令名而非 startsWith）
      if (this.isCommandTrusted(command)) {
        return { allowed: true };
      }
    }

    // 使用 PermissionManager 检查
    const result = await this.permissionManager.check(
      tool.name,
      args,
      context,
    );

    // 高风险+未信任环境需要审批
    if (tool.riskLevel === 'dangerous' && !context.isTrustedEnvironment) {
      return {
        allowed: false,
        requiresApproval: true,
        riskLevel: 'high',
        reason: `高风险操作 ${tool.name} 需要审批`,
      };
    }

    return result;
  }

  /**
   * 安全的命令白名单匹配（修复 startsWith 漏洞）
   * 将命令拆分为 argv 数组，检查第一个 token（命令名）+ 第二个 token（子命令）
   */
  private isCommandTrusted(command: string): boolean {
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;

    const cmdName = tokens[0];
    const subCmd = tokens[1] || '';

    // 精确匹配：完整命令在白名单中
    const fullCmd = subCmd ? `${cmdName} ${subCmd}` : cmdName;
    if (this.config.trustedCommands!.includes(fullCmd)) {
      return true;
    }

    // 前缀匹配：但要求边界是空格或命令结束（防止 git status; rm 注入）
    for (const trusted of this.config.trustedCommands!) {
      if (command === trusted) return true;
      // 只允许前缀后紧跟空格的情况
      if (command.startsWith(trusted + ' ') && !command.slice(trusted.length).match(/[;|&]/)) {
        return true;
      }
    }

    return false;
  }

  /** 路径权限规则检查 */
  private checkPathRules(filePath: string, toolName: string): PermissionResult | null {
    for (const rule of this.config.pathRules!) {
      // 简单 glob 匹配：** 匹配任意层级，* 匹配单层
      if (this.matchGlob(filePath, rule.pattern)) {
        // 检查工具是否适用
        if (rule.tools && rule.tools.length > 0 && !rule.tools.includes(toolName)) {
          continue;
        }
        if (!rule.allowed) {
          return { allowed: false, reason: `路径 ${filePath} 被规则禁止访问` };
        }
        return { allowed: true };
      }
    }
    return null;
  }

  /** 简单 glob 匹配 */
  private matchGlob(path: string, pattern: string): boolean {
    // 将 glob 转为正则：** → .*，* → [^/]*
    const regex = pattern
      .replace(/\*\*/g, '___GLOBSTAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___GLOBSTAR___/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${regex}$`).test(path);
  }

  /** 频率限制检查 */
  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 分钟窗口
    const timestamps = this.rateLimitTracker.get(userId) || [];

    // 清理过期时间戳
    const valid = timestamps.filter(ts => now - ts < windowMs);

    if (valid.length >= this.config.rateLimitPerMinute!) {
      return false;
    }

    valid.push(now);
    this.rateLimitTracker.set(userId, valid);
    return true;
  }

  /** 请求用户审批 */
  private requestApproval(tool: LazyToolDef, // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,透传至审批描述与事件
  args: any): Promise<boolean> {
    return new Promise((resolve) => {
      const description = this.formatApprovalDescription(tool, args);
      const requestId = `approval_${Date.now()}`;

      this.approvalQueue.set(requestId, {
        toolId: tool.id,
        args,
        resolve,
        timestamp: Date.now(),
        description,
      });

      console.info(`\n⚠️  需要审批: ${tool.name}`);
      console.info(`   ${description}`);
      console.info(`   输入 y/N 或 approve/deny 以继续:`);

      // 在实际 CLUI 中，这里会调用审批回调
      // 默认策略：如果配置时间内无响应，根据配置决定
      const timer = setTimeout(() => {
        const request = this.approvalQueue.get(requestId);
        if (request) {
          this.approvalQueue.delete(requestId);
          this.approvalTimers.delete(requestId);
          if (this.config.approvalStrategy === 'auto_deny') {
            resolve(false);
          } else {
            console.info(`   ⏰ 审批超时，自动${this.config.approvalStrategy === 'auto_allow' ? '允许' : '拒绝'}`);
            resolve(this.config.approvalStrategy === 'auto_allow');
          }
        }
      }, this.config.approvalTimeoutMs);
      // 保存 timer 句柄，便于审批响应或 dispose 时 clearTimeout
      this.approvalTimers.set(requestId, timer);

      // 发布审批请求事件
      this.eventBus.emitSync('permission.approval.requested', {
        requestId,
        toolId: tool.id,
        toolName: tool.name,
        description,
        args,
      }, { source: 'permission-executor' });
    });
  }

  /** 处理审批响应 */
  handleApprovalResponse(requestId: string, approved: boolean): boolean {
    const request = this.approvalQueue.get(requestId);
    if (!request) return false;
    this.approvalQueue.delete(requestId);
    // 清理对应的审批超时 timer
    const timer = this.approvalTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.approvalTimers.delete(requestId);
    }
    request.resolve(approved);
    return true;
  }

  /** 格式化审批描述 */
  private formatApprovalDescription(tool: LazyToolDef, // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,访问 command/path/url 字段
  args: any): string {
    const parts: string[] = [tool.description];

    if (tool.category === 'bash' && args?.command) {
      parts.push(`\n  命令: ${args.command.substring(0, 200)}`);
      parts.push(`  风险: ${tool.riskLevel}`);
    }
    if (tool.category === 'file' && args?.path) {
      parts.push(`\n  路径: ${args.path}`);
      parts.push(`  操作: ${args.operation || tool.name}`);
    }
    if (args?.url) {
      parts.push(`\n  URL: ${args.url}`);
    }

    return parts.join('');
  }

  /** 获取待处理的审批 */
  getPendingApprovals(): Array<{
    requestId: string;
    toolName: string;
    description: string;
    timestamp: number;
  }> {
    return Array.from(this.approvalQueue.entries()).map(([id, req]) => ({
      requestId: id,
      toolName: req.toolId,
      description: req.description,
      timestamp: req.timestamp,
    }));
  }

  /** 设置审批策略 */
  setApprovalStrategy(strategy: ApprovalStrategy): void {
    this.config.approvalStrategy = strategy;
  }

  /** 添加信任命令 */
  addTrustedCommand(command: string): void {
    if (!this.config.trustedCommands!.includes(command)) {
      this.config.trustedCommands!.push(command);
    }
  }

  /** 获取当前时间时段 */
  private getTimeOfDay(): SecurityContext['timeOfDay'] {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 23) return 'evening';
    return 'night';
  }

  /** 清理所有 pending 审批超时 timer，避免进程退出前 timer 泄漏 */
  dispose(): void {
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
    this.approvalQueue.clear();
  }
}
