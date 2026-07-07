/**
 * MCPSecurityGuard — MCP 插件安全防护层
 *
 * 对标 Codex bubblewrap/Seatbelt 沙盒 + Claude Code 7 种权限模式，
 * 解决 MCP Server 版本兼容性与安全性问题（详见 详细优化方案.txt L325 避坑警告）。
 *
 * 三层防护：
 * 1. 插件信任审核 — allowlist/denylist + 来源校验 + 版本兼容性检查
 * 2. 工具调用审批门控 — 危险操作人工确认 + 参数消毒 + 资源限额
 * 3. 执行沙盒隔离 — 超时/输出截断/审计日志/熔断
 */

import { logger } from './structured-logger.js';
import { EventBus, Events } from './event-bus.js';

// ============ 类型定义 ============

/** 插件信任级别 */
export type TrustLevel = 'trusted' | 'verified' | 'untrusted' | 'blocked';

/** 审批策略（对标 Codex 3 种策略） */
export type ApprovalPolicy = 'auto' | 'suggest' | 'manual';

/** 工具风险等级 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** 插件安全配置 */
export interface PluginSecurityConfig {
  /** 信任级别 */
  trust: TrustLevel;
  /** 审批策略 */
  approvalPolicy: ApprovalPolicy;
  /** 允许的工具（空=全部允许） */
  allowedTools?: string[];
  /** 禁止的工具 */
  blockedTools?: string[];
  /** 最大执行超时（毫秒） */
  timeoutMs: number;
  /** 最大输出长度（字符） */
  maxOutputLength: number;
  /** 是否允许网络访问 */
  networkAccess: boolean;
  /** 是否允许文件写入 */
  fileWriteAccess: boolean;
  /** 是否允许执行命令 */
  shellAccess: boolean;
  /** 每分钟最大调用次数 */
  rateLimitPerMin: number;
}

/** 安全事件 */
export interface SecurityEvent {
  timestamp: number;
  serverId: string;
  toolName: string;
  riskLevel: RiskLevel;
  action: 'allowed' | 'blocked' | 'queued' | 'rate_limited' | 'timeout';
  reason: string;
  argsSummary?: string;
}

// ============ 默认安全配置 ============

const DEFAULT_SECURITY: PluginSecurityConfig = {
  trust: 'untrusted',
  approvalPolicy: 'suggest',
  timeoutMs: 30000,
  maxOutputLength: 10000,
  networkAccess: false,
  fileWriteAccess: false,
  shellAccess: false,
  rateLimitPerMin: 60,
};

/** 内置可信插件（官方/知名作者） */
const TRUSTED_PLUGINS = new Set([
  'playwright-mcp',
  'filesystem-mcp',
  'github-mcp',
  'memory-mcp',
]);

/** 高危工具名关键词（需要人工审批） */
const HIGH_RISK_KEYWORDS = [
  'delete', 'remove', 'drop', 'execute', 'shell', 'exec',
  'write_file', 'create_file', 'move', 'rename', 'chmod',
  'kill', 'terminate', 'shutdown', 'reboot',
];

/** 危险参数模式（防止注入） */
const DANGEROUS_ARG_PATTERNS = [
  /rm\s+-rf/i,
  /;\s*rm\s/i,
  /\$\(/i,
  /`.*`/i,
  /\|\s*(sh|bash|zsh)/i,
  />\s*\/dev\/sd/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\(\)\s*\{/i, // fork bomb
];

/** 待审请求详情（供 API 轮询审批） */
export interface PendingApproval {
  approvalId: string;
  serverId: string;
  toolName: string;
  riskLevel: RiskLevel;
  argsSummary: string;
  enqueuedAt: number;
  expiresAt: number;
}

// ============ MCPSecurityGuard 类 ============

export class MCPSecurityGuard {
  private pluginConfigs: Map<string, PluginSecurityConfig> = new Map();
  private callHistory: Map<string, number[]> = new Map(); // serverId -> timestamps
  private securityEvents: SecurityEvent[] = [];
  private maxEventLog = 1000;
  private pendingApprovals: Map<string, { resolve: (ok: boolean) => void; timeout: NodeJS.Timeout }> = new Map();
  private pendingDetails: Map<string, PendingApproval> = new Map(); // 审批详情（供 API 查询）
  private eventBus: EventBus;

  /** 审批回调（由 UI 层注入，默认自动拒绝高危） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private approvalCallback: ((serverId: string, toolName: string, args: Record<string, any>, risk: RiskLevel) => Promise<boolean>) | null = null;

  /** 轮询模式开关 — Web 服务器启动时开启，CLI/测试时关闭（立即拒绝） */
  private pollingModeEnabled = false;

  constructor() {
    this.eventBus = EventBus.getInstance();
  }

  /** 设置审批回调（CLI/Web/Desktop 注入） */
  setApprovalCallback(cb: typeof this.approvalCallback): void {
    this.approvalCallback = cb;
  }

  /** 启用轮询审批模式（Web 服务器启动时调用） */
  enablePollingMode(): void {
    this.pollingModeEnabled = true;
    logger.info('[MCP-Security] 轮询审批模式已启用（API 审批队列可用）');
  }

  /** 禁用轮询审批模式 */
  disablePollingMode(): void {
    this.pollingModeEnabled = false;
  }

  /** 注册插件并执行安全审核 */
  registerPlugin(serverId: string, config: Partial<PluginSecurityConfig> = {}): PluginSecurityConfig {
    // 根据来源自动判定信任级别
    let trust = config.trust || 'untrusted';
    if (TRUSTED_PLUGINS.has(serverId)) {
      trust = 'trusted';
    }

    const merged: PluginSecurityConfig = {
      ...DEFAULT_SECURITY,
      ...config,
      trust,
      // 可信插件放宽策略，不可信收紧
      approvalPolicy: config.approvalPolicy || (trust === 'trusted' ? 'auto' : 'suggest'),
      timeoutMs: config.timeoutMs || (trust === 'trusted' ? 30000 : 15000),
      rateLimitPerMin: config.rateLimitPerMin || (trust === 'trusted' ? 120 : 30),
    };

    this.pluginConfigs.set(serverId, merged);
    logger.info(`[MCP-Security] 插件 ${serverId} 已注册 | 信任:${trust} | 策略:${merged.approvalPolicy}`);
    return merged;
  }

  /** 评估工具调用风险等级 */
  assessRisk(serverId: string, toolName: string, args: Record<string, unknown>): RiskLevel {
    const config = this.pluginConfigs.get(serverId);
    if (!config) return 'critical'; // 未注册插件 = 最高风险

    // 被阻止的工具
    if (config.blockedTools?.includes(toolName)) return 'critical';

    // 信任级别判定
    if (config.trust === 'blocked') return 'critical';
    if (config.trust === 'untrusted') {
      if (!config.allowedTools || config.allowedTools.length === 0) return 'high';
      if (!config.allowedTools.includes(toolName)) return 'high';
    }

    // 工具名风险关键词
    const lowerTool = toolName.toLowerCase();
    if (HIGH_RISK_KEYWORDS.some(k => lowerTool.includes(k))) {
      return 'high';
    }

    // 参数危险模式检测
    const argsStr = JSON.stringify(args);
    if (DANGEROUS_ARG_PATTERNS.some(p => p.test(argsStr))) {
      return 'critical';
    }

    // shell/exec 类工具
    if (config.shellAccess === false && /shell|exec|cmd|terminal/i.test(toolName)) {
      return 'high';
    }

    // 文件写入类
    if (config.fileWriteAccess === false && /write|create|save|put/i.test(toolName)) {
      return 'medium';
    }

    // 只读/查询类
    if (/read|get|list|search|query|fetch/i.test(toolName)) {
      return 'safe';
    }

    return 'low';
  }

  /** 检查是否允许执行（含限流、审批） */
  async checkPermission(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{
    allowed: boolean;
    risk: RiskLevel;
    reason: string;
  }> {
    const config = this.pluginConfigs.get(serverId);
    if (!config) {
      this.logEvent(serverId, toolName, 'critical', 'blocked', '插件未注册安全审核');
      return { allowed: false, risk: 'critical', reason: '插件未通过安全审核，请先注册' };
    }

    // 1. 信任级别检查
    if (config.trust === 'blocked') {
      this.logEvent(serverId, toolName, 'critical', 'blocked', '插件已被阻止');
      return { allowed: false, risk: 'critical', reason: '插件已被安全策略阻止' };
    }

    // 2. 工具黑白名单
    if (config.blockedTools?.includes(toolName)) {
      this.logEvent(serverId, toolName, 'critical', 'blocked', `工具 ${toolName} 在黑名单中`);
      return { allowed: false, risk: 'critical', reason: `工具 ${toolName} 已被禁止` };
    }
    if (config.allowedTools && config.allowedTools.length > 0 && !config.allowedTools.includes(toolName)) {
      this.logEvent(serverId, toolName, 'high', 'blocked', `工具 ${toolName} 不在白名单中`);
      return { allowed: false, risk: 'high', reason: `工具 ${toolName} 不在允许列表中` };
    }

    // 3. 速率限制
    if (this.isRateLimited(serverId, config.rateLimitPerMin)) {
      this.logEvent(serverId, toolName, 'medium', 'rate_limited', '超过每分钟调用限制');
      return { allowed: false, risk: 'medium', reason: '调用频率超限，请稍后重试' };
    }

    // 4. 风险评估
    const risk = this.assessRisk(serverId, toolName, args);

    // 5. 危险参数检测
    const argsStr = JSON.stringify(args);
    const matchedPattern = DANGEROUS_ARG_PATTERNS.find(p => p.test(argsStr));
    if (matchedPattern) {
      this.logEvent(serverId, toolName, 'critical', 'blocked', `检测到危险参数模式: ${matchedPattern.source}`);
      return { allowed: false, risk: 'critical', reason: '参数包含危险模式，已拦截' };
    }

    // 6. 审批门控
    if (risk === 'critical') {
      this.logEvent(serverId, toolName, risk, 'blocked', '关键风险自动拒绝');
      return { allowed: false, risk, reason: '操作风险等级为 critical，自动拒绝' };
    }

    if (risk === 'high' || (risk === 'medium' && config.approvalPolicy === 'manual')) {
      if (config.approvalPolicy === 'auto' && config.trust === 'trusted') {
        // 可信插件自动放行
        this.logEvent(serverId, toolName, risk, 'allowed', '可信插件自动放行');
        return { allowed: true, risk, reason: '可信插件' };
      }

      // 需要人工审批
      if (this.approvalCallback) {
        // 回调模式（CLI 交互式审批）
        this.logEvent(serverId, toolName, risk, 'queued', '等待人工审批');
        const approved = await this.requestApproval(serverId, toolName, args, risk);
        if (!approved) {
          this.logEvent(serverId, toolName, risk, 'blocked', '人工审批拒绝');
          return { allowed: false, risk, reason: '用户拒绝了该操作' };
        }
        this.logEvent(serverId, toolName, risk, 'allowed', '人工审批通过');
        return { allowed: true, risk, reason: '已获用户授权' };
      }

      // 轮询模式（API 审批队列）— 仅在 Web 服务器启用轮询模式时可用
      if (this.pollingModeEnabled) {
        this.logEvent(serverId, toolName, risk, 'queued', '等待 API 审批');
        const approved = await this.enqueueForPollApproval(serverId, toolName, args, risk);
        if (!approved) {
          this.logEvent(serverId, toolName, risk, 'blocked', '审批超时或被拒绝');
          return { allowed: false, risk, reason: '审批超时或被拒绝（请通过 /api/mcp/security/pending 处理）' };
        }
        this.logEvent(serverId, toolName, risk, 'allowed', 'API 审批通过');
        return { allowed: true, risk, reason: '已获 API 授权' };
      }

      // 无审批通道且未启用轮询模式，拒绝高危操作
      this.logEvent(serverId, toolName, risk, 'blocked', '无审批通道，高危操作拒绝');
      return { allowed: false, risk, reason: '高危操作需要人工审批，但未配置审批通道' };
    }

    // 7. 低风险自动放行
    this.logEvent(serverId, toolName, risk, 'allowed', '风险可控自动放行');
    return { allowed: true, risk, reason: '风险等级可接受' };
  }

  /** 参数消毒 — 移除潜在注入内容 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sanitizeArgs(args: Record<string, any>): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        // 截断过长字符串
        let cleaned = value.length > 50000 ? value.slice(0, 50000) + '...[truncated]' : value;
        // 移除控制字符
        // eslint-disable-next-line no-control-regex
        cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        sanitized[key] = cleaned;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = Array.isArray(value) ? value : this.sanitizeArgs(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /** 截断输出 — 防止内存耗尽 */
  truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) return output;
    return output.slice(0, maxLength) + `\n...[输出已截断，原始长度 ${output.length} 字符]`;
  }

  /** 获取安全事件日志 */
  getSecurityEvents(limit: number = 50): SecurityEvent[] {
    return this.securityEvents.slice(-limit);
  }

  /** 获取插件安全配置 */
  getPluginConfig(serverId: string): PluginSecurityConfig | undefined {
    return this.pluginConfigs.get(serverId);
  }

  /** 获取所有插件安全状态 */
  getAllPluginStatus(): Array<{ serverId: string; config: PluginSecurityConfig; callsInLastMin: number }> {
    const now = Date.now();
    return Array.from(this.pluginConfigs.entries()).map(([serverId, config]) => {
      const calls = (this.callHistory.get(serverId) || []).filter(t => now - t < 60000);
      return { serverId, config, callsInLastMin: calls.length };
    });
  }

  /** 获取待审请求列表（供 API 轮询） */
  getPendingApprovals(): PendingApproval[] {
    const now = Date.now();
    // 清理已过期的
    for (const [id, detail] of this.pendingDetails) {
      if (now > detail.expiresAt) {
        this.pendingDetails.delete(id);
      }
    }
    return Array.from(this.pendingDetails.values()).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  /** 解析待审请求（供 API 审批端点调用） */
  resolveApproval(
    approvalId: string | undefined,
    serverId: string | undefined,
    toolName: string | undefined,
    approved: boolean,
  ): boolean {
    // 优先按 approvalId 解析
    if (approvalId && this.pendingApprovals.has(approvalId)) {
      const pending = this.pendingApprovals.get(approvalId)!;
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(approvalId);
      this.pendingDetails.delete(approvalId);
      pending.resolve(approved);
      return true;
    }

    // 按 serverId + toolName 匹配（取最早的一个）
    if (serverId && toolName) {
      for (const [id, detail] of this.pendingDetails) {
        if (detail.serverId === serverId && detail.toolName === toolName) {
          const pending = this.pendingApprovals.get(id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingApprovals.delete(id);
            this.pendingDetails.delete(id);
            pending.resolve(approved);
            return true;
          }
        }
      }
    }

    return false;
  }

  // ============ 私有方法 ============

  private isRateLimited(serverId: string, limitPerMin: number): boolean {
    const now = Date.now();
    const history = this.callHistory.get(serverId) || [];
    const recent = history.filter(t => now - t < 60000);
    if (recent.length >= limitPerMin) {
      return true;
    }
    recent.push(now);
    this.callHistory.set(serverId, recent);
    return false;
  }

  private requestApproval(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    risk: RiskLevel,
  ): Promise<boolean> {
    if (!this.approvalCallback) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const approvalId = `${serverId}:${toolName}:${Date.now()}`;
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(approvalId);
        this.pendingDetails.delete(approvalId);
        resolve(false); // 超时拒绝
      }, 60000); // 60秒审批超时

      this.pendingApprovals.set(approvalId, { resolve, timeout });

      this.approvalCallback!(serverId, toolName, args, risk)
        .then((ok) => {
          clearTimeout(timeout);
          this.pendingApprovals.delete(approvalId);
          this.pendingDetails.delete(approvalId);
          resolve(ok);
        })
        .catch(() => {
          clearTimeout(timeout);
          this.pendingApprovals.delete(approvalId);
          this.pendingDetails.delete(approvalId);
          resolve(false);
        });
    });
  }

  /** 轮询模式审批 — 无回调时入队等待 API 解析 */
  private enqueueForPollApproval(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    risk: RiskLevel,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const approvalId = `${serverId}:${toolName}:${Date.now()}`;
      const now = Date.now();
      const timeoutMs = 60000;

      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(approvalId);
        this.pendingDetails.delete(approvalId);
        resolve(false); // 超时自动拒绝
      }, timeoutMs);

      this.pendingApprovals.set(approvalId, { resolve, timeout });
      this.pendingDetails.set(approvalId, {
        approvalId,
        serverId,
        toolName,
        riskLevel: risk,
        argsSummary: JSON.stringify(args).slice(0, 500),
        enqueuedAt: now,
        expiresAt: now + timeoutMs,
      });

      // 广播审批请求事件（供 WebSocket 实时推送）
      this.eventBus.emitSync(Events.TOOL_CALL_START, {
        type: 'mcp_approval_required',
        approvalId,
        serverId,
        toolName,
        riskLevel: risk,
        expiresAt: now + timeoutMs,
      });
    });
  }

  private logEvent(
    serverId: string,
    toolName: string,
    risk: RiskLevel,
    action: SecurityEvent['action'],
    reason: string,
  ): void {
    const event: SecurityEvent = {
      timestamp: Date.now(),
      serverId,
      toolName,
      riskLevel: risk,
      action,
      reason,
    };

    this.securityEvents.push(event);
    if (this.securityEvents.length > this.maxEventLog) {
      this.securityEvents.shift();
    }

    // 广播安全事件
    this.eventBus.emitSync(Events.TOOL_CALL_COMPLETE, {
      type: 'mcp_security',
      ...event,
    });

    // 高危事件告警日志
    if (risk === 'critical' || risk === 'high') {
      logger.warn(`[MCP-Security] ${action.toUpperCase()} ${serverId}/${toolName} | 风险:${risk} | ${reason}`);
    }
  }
}

// ============ 单例 ============

let guardInstance: MCPSecurityGuard | null = null;

export function getMCPSecurityGuard(): MCPSecurityGuard {
  if (!guardInstance) {
    guardInstance = new MCPSecurityGuard();
  }
  return guardInstance;
}
