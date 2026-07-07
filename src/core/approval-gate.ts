/**
 * 审批门控系统 — ApprovalGate
 *
 * 借鉴 OpenClaw 审批门控机制，在执行危险或高影响操作前要求审批：
 * - 可配置的审批规则：定义哪些操作需要审批、风险等级、自动批准条件
 * - 三级决策：auto_approved / requires_approval / blocked
 * - 冷却期控制：同一操作的最短审批间隔
 * - 自动批准限流：每小时最大自动批准次数
 * - 审批历史与统计：完整的审计追踪
 * - Agent Loop 工具：通过 getToolDefinitions() 注册为可用工具
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** 审批规则 */
export interface ApprovalRule {
  id: string;
  name: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** 操作名称的 Glob 匹配模式，如 'file_delete_*', 'shell_exec_*' */
  operationPatterns: string[];
  /** 自动批准条件列表 */
  autoApproveConditions?: Array<{
    /** 参数字段名，如 'filePath', 'command', 'targetAgent' */
    field: string;
    /** 比较运算符 */
    operator: 'equals' | 'contains' | 'matches' | 'not_contains';
    /** 比较值 */
    value: string;
  }>;
  /** 谁必须审批 */
  requireApprovalFrom: 'user' | 'admin' | 'auto';
  /** 每小时最大自动批准次数 */
  maxAutoApprovePerHour?: number;
  /** 同一操作的最短审批间隔（毫秒） */
  cooldownMs?: number;
  /** 规则是否启用 */
  enabled: boolean;
}

/** 操作请求 */
export interface OperationRequest {
  /** 操作名称 */
  operationName: string;
  /** 操作参数 */
  parameters: Record<string, unknown>;
  /** 发起者（Agent 或工具名） */
  requester: string;
  /** 风险等级（可选，由规则覆盖） */
  riskLevel?: string;
  /** 操作描述 */
  description: string;
  /** 请求时间戳 */
  timestamp: number;
}

/** 审批决策 */
export interface ApprovalDecision {
  /** 决策结果 */
  decision: 'auto_approved' | 'requires_approval' | 'blocked';
  /** 请求唯一标识 */
  requestId: string;
  /** 匹配到的规则 ID 列表 */
  matchedRules: string[];
  /** 风险等级 */
  riskLevel: string;
  /** 决策原因 */
  reason: string;
  /** 附加条件 */
  conditions?: string[];
  /** 过期时间（毫秒时间戳） */
  expiresAt?: number;
}

/** 审批记录 */
export interface ApprovalRecord {
  /** 记录唯一标识 */
  id: string;
  /** 关联的请求 ID */
  requestId: string;
  /** 操作名称 */
  operation: string;
  /** 决策结果 */
  decision: string;
  /** 审批人 */
  approver?: string;
  /** 时间戳 */
  timestamp: number;
  /** 附加条件 */
  conditions?: string[];
  /** 拒绝原因 */
  denialReason?: string;
}

/** 审批统计 */
export interface ApprovalStats {
  /** 总请求数 */
  totalRequests: number;
  /** 自动批准数 */
  autoApproved: number;
  /** 需要审批数 */
  requiresApproval: number;
  /** 被阻止数 */
  blocked: number;
  /** 已批准数 */
  granted: number;
  /** 已拒绝数 */
  denied: number;
  /** 待审批数 */
  pending: number;
  /** 已注册规则数 */
  ruleCount: number;
  /** 各风险等级统计 */
  byRiskLevel: Record<string, number>;
}

/** 待审批请求条目 */
interface PendingApproval {
  requestId: string;
  operation: OperationRequest;
  decision: ApprovalDecision;
  createdAt: number;
  expiresAt?: number;
}

/** 自动批准计数器 */
interface AutoApproveCounter {
  count: number;
  windowStart: number;
}

/** 冷却期记录 */
interface CooldownRecord {
  lastApprovedAt: number;
}

// ============ 辅助函数 ============

/** 生成唯一 ID */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 简易 Glob 匹配
 * 支持 *（任意字符序列）和 ?（单个字符）
 */
function globMatch(pattern: string, text: string): boolean {
  // 将 glob 模式转换为正则表达式
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义正则特殊字符
    .replace(/\*/g, '.*')                    // * → .*
    .replace(/\?/g, '.');                    // ? → .
  const regex = new RegExp(`^${regexStr}$`, 'i');
  return regex.test(text);
}

/**
 * 评估自动批准条件
 */
function evaluateCondition(
  condition: Exclude<ApprovalRule['autoApproveConditions'], undefined>[number],
  parameters: Record<string, unknown>,
): boolean {
  const fieldValue = parameters[condition.field];
  if (fieldValue === undefined || fieldValue === null) return false;

  const strValue = String(fieldValue);

  switch (condition.operator) {
    case 'equals':
      return strValue === condition.value;
    case 'contains':
      return strValue.includes(condition.value);
    case 'not_contains':
      return !strValue.includes(condition.value);
    case 'matches':
      try {
        return new RegExp(condition.value, 'i').test(strValue);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// ============ 主类 ============

export class ApprovalGate {
  private rules: Map<string, ApprovalRule> = new Map();
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private approvalHistory: ApprovalRecord[] = [];
  private autoApproveCounters: Map<string, AutoApproveCounter> = new Map();
  private cooldownRecords: Map<string, CooldownRecord> = new Map();
  private log = logger.child({ module: 'ApprovalGate' });

  // 统计
  private totalRequests = 0;
  private autoApprovedCount = 0;
  private requiresApprovalCount = 0;
  private blockedCount = 0;
  private grantedCount = 0;
  private deniedCount = 0;
  private byRiskLevel: Record<string, number> = {};

  constructor() {
    // 预注册默认审批规则
    this.registerDefaultRules();

    this.log.info('审批门控系统初始化完成', {
      defaultRules: this.rules.size,
    });
  }

  // ========== 默认规则注册 ==========

  private registerDefaultRules(): void {
    // 1. 文件删除 — 需要用户审批（高风险）
    this.registerRule({
      id: 'file_delete',
      name: '文件删除审批',
      description: '文件删除操作需要用户审批，防止误删重要文件',
      riskLevel: 'high',
      operationPatterns: ['file_delete_*', 'file_remove_*', 'delete_file', 'remove_file'],
      requireApprovalFrom: 'user',
      enabled: true,
    });

    // 2. Shell 命令执行 — 危险命令需要审批（关键风险）
    this.registerRule({
      id: 'shell_exec',
      name: 'Shell 命令执行审批',
      description: 'Shell 命令执行需要审批，特别是危险命令（rm、chmod、sudo 等）',
      riskLevel: 'critical',
      operationPatterns: ['shell_exec_*', 'bash_exec_*', 'execute_command', 'run_command'],
      autoApproveConditions: [
        { field: 'command', operator: 'not_contains', value: 'rm ' },
        { field: 'command', operator: 'not_contains', value: 'sudo' },
        { field: 'command', operator: 'not_contains', value: 'chmod' },
        { field: 'command', operator: 'not_contains', value: 'chown' },
        { field: 'command', operator: 'not_contains', value: 'mkfs' },
        { field: 'command', operator: 'not_contains', value: 'dd ' },
        { field: 'command', operator: 'not_contains', value: ':(){:|:&};:' },
        { field: 'command', operator: 'not_contains', value: 'format' },
      ],
      requireApprovalFrom: 'user',
      enabled: true,
    });

    // 3. 关键文件写入 — 需要审批（高风险）
    this.registerRule({
      id: 'file_write_critical',
      name: '关键文件写入审批',
      description: '写入关键配置文件（.env、config、package.json 等）需要审批',
      riskLevel: 'high',
      operationPatterns: ['file_write_*', 'file_update_*', 'write_file', 'update_file'],
      autoApproveConditions: [
        { field: 'filePath', operator: 'not_contains', value: '.env' },
        { field: 'filePath', operator: 'not_contains', value: 'config.' },
        { field: 'filePath', operator: 'not_contains', value: 'package.json' },
        { field: 'filePath', operator: 'not_contains', value: 'tsconfig.json' },
        { field: 'filePath', operator: 'not_contains', value: '.git' },
        { field: 'filePath', operator: 'not_contains', value: 'credentials' },
        { field: 'filePath', operator: 'not_contains', value: 'secret' },
      ],
      requireApprovalFrom: 'user',
      enabled: true,
    });

    // 4. Agent 交接 — 自动批准（低风险）
    this.registerRule({
      id: 'agent_handoff',
      name: 'Agent 交接审批',
      description: 'Agent 之间的任务交接，低风险自动批准',
      riskLevel: 'low',
      operationPatterns: ['agent_handoff_*', 'agent_transfer_*', 'handoff', 'transfer_task'],
      requireApprovalFrom: 'auto',
      maxAutoApprovePerHour: 100,
      enabled: true,
    });

    // 5. 代码修改 — 自动批准带冷却（中等风险）
    this.registerRule({
      id: 'code_modify',
      name: '代码修改审批',
      description: '代码修改操作自动批准，但设有冷却期防止频繁修改',
      riskLevel: 'medium',
      operationPatterns: ['code_modify_*', 'code_edit_*', 'edit_code', 'modify_code'],
      requireApprovalFrom: 'auto',
      maxAutoApprovePerHour: 60,
      cooldownMs: 5000,  // 5秒冷却期
      enabled: true,
    });

    // 6. 系统配置变更 — 需要审批（高风险）
    this.registerRule({
      id: 'system_config',
      name: '系统配置变更审批',
      description: '系统配置变更需要审批，防止不当配置影响系统稳定性',
      riskLevel: 'high',
      operationPatterns: ['system_config_*', 'config_update_*', 'update_config', 'change_setting'],
      requireApprovalFrom: 'admin',
      enabled: true,
    });

    // 7. 数据导出 — 需要审批（中等风险）
    this.registerRule({
      id: 'data_export',
      name: '数据导出审批',
      description: '数据导出操作需要审批，防止敏感数据泄露',
      riskLevel: 'medium',
      operationPatterns: ['data_export_*', 'export_*', 'download_data', 'extract_data'],
      requireApprovalFrom: 'user',
      enabled: true,
    });
  }

  // ========== 规则注册 ==========

  /**
   * 注册审批规则
   */
  registerRule(rule: ApprovalRule): { registered: boolean; id: string; message: string } {
    // 验证规则
    if (!rule.id || !rule.name) {
      this.log.warn('规则注册失败：缺少必要字段', { rule });
      return { registered: false, id: rule.id, message: '规则缺少 id 或 name' };
    }

    const isUpdate = this.rules.has(rule.id);
    this.rules.set(rule.id, rule);

    this.log.info(isUpdate ? '更新审批规则' : '注册审批规则', {
      id: rule.id,
      name: rule.name,
      riskLevel: rule.riskLevel,
      patterns: rule.operationPatterns,
    });

    EventBus.getInstance().emitSync('approval.rule.registered', {
      id: rule.id,
      name: rule.name,
      riskLevel: rule.riskLevel,
      isUpdate,
    });

    return {
      registered: true,
      id: rule.id,
      message: isUpdate ? `规则 ${rule.name} 已更新` : `规则 ${rule.name} 已注册`,
    };
  }

  // ========== 审批检查 ==========

  /**
   * 检查操作是否需要审批
   */
  checkApproval(operation: OperationRequest): ApprovalDecision {
    this.totalRequests++;

    const requestId = generateId('req');
    const matchedRules: string[] = [];
    let highestRisk: 'low' | 'medium' | 'high' | 'critical' = 'low';
    let bestMatchedRule: ApprovalRule | null = null;

    // 遍历所有规则，查找匹配的规则
    for (const rule of Array.from(this.rules.values())) {
      if (!rule.enabled) continue;

      const isMatch = rule.operationPatterns.some(pattern =>
        globMatch(pattern, operation.operationName),
      );

      if (isMatch) {
        matchedRules.push(rule.id);

        // 记录最高风险等级
        const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
        if (riskOrder[rule.riskLevel] > riskOrder[highestRisk]) {
          highestRisk = rule.riskLevel;
          bestMatchedRule = rule;
        }
      }
    }

    // 统计风险等级
    this.byRiskLevel[highestRisk] = (this.byRiskLevel[highestRisk] || 0) + 1;

    // 没有匹配的规则 → 自动批准
    if (matchedRules.length === 0 || !bestMatchedRule) {
      this.autoApprovedCount++;

      this.log.debug('操作无匹配规则，自动批准', {
        requestId,
        operation: operation.operationName,
      });

      return {
        decision: 'auto_approved',
        requestId,
        matchedRules: [],
        riskLevel: operation.riskLevel || 'low',
        reason: '无匹配的审批规则，默认自动批准',
        expiresAt: Date.now() + 3600000,  // 1小时有效期
      };
    }

    // 检查自动批准条件
    if (bestMatchedRule.autoApproveConditions && bestMatchedRule.autoApproveConditions.length > 0) {
      const allConditionsMet = bestMatchedRule.autoApproveConditions.every(condition =>
        evaluateCondition(condition, operation.parameters),
      );

      if (allConditionsMet) {
        // 检查自动批准限流
        if (!this.checkAutoApproveLimit(bestMatchedRule)) {
          this.requiresApprovalCount++;

          this.log.info('自动批准次数已达上限，转为人工审批', {
            requestId,
            ruleId: bestMatchedRule.id,
            operation: operation.operationName,
          });

          const pending = this.createPendingApproval(requestId, operation, highestRisk, matchedRules, bestMatchedRule);
          return pending.decision;
        }

        // 检查冷却期
        if (!this.checkCooldown(bestMatchedRule, operation.operationName)) {
          this.requiresApprovalCount++;

          this.log.info('操作处于冷却期，转为人工审批', {
            requestId,
            ruleId: bestMatchedRule.id,
            operation: operation.operationName,
          });

          const pending = this.createPendingApproval(requestId, operation, highestRisk, matchedRules, bestMatchedRule);
          return pending.decision;
        }

        // 自动批准
        this.autoApprovedCount++;
        this.recordAutoApprove(bestMatchedRule.id);
        this.recordCooldown(bestMatchedRule.id, operation.operationName);

        this.log.info('操作自动批准', {
          requestId,
          ruleId: bestMatchedRule.id,
          operation: operation.operationName,
          riskLevel: highestRisk,
        });

        EventBus.getInstance().emitSync('approval.auto_approved', {
          requestId,
          operation: operation.operationName,
          ruleId: bestMatchedRule.id,
          riskLevel: highestRisk,
        });

        // 记录到历史
        this.addHistoryRecord({
          id: generateId('rec'),
          requestId,
          operation: operation.operationName,
          decision: 'auto_approved',
          timestamp: Date.now(),
        });

        return {
          decision: 'auto_approved',
          requestId,
          matchedRules,
          riskLevel: highestRisk,
          reason: `匹配规则 ${bestMatchedRule.name}，所有自动批准条件已满足`,
          expiresAt: Date.now() + 3600000,
        };
      }
    }

    // 检查是否为自动批准类型（无条件的 auto 规则）
    if (bestMatchedRule.requireApprovalFrom === 'auto') {
      // 检查限流和冷却
      if (this.checkAutoApproveLimit(bestMatchedRule) && this.checkCooldown(bestMatchedRule, operation.operationName)) {
        this.autoApprovedCount++;
        this.recordAutoApprove(bestMatchedRule.id);
        this.recordCooldown(bestMatchedRule.id, operation.operationName);

        this.log.info('自动审批规则，自动批准', {
          requestId,
          ruleId: bestMatchedRule.id,
          operation: operation.operationName,
        });

        EventBus.getInstance().emitSync('approval.auto_approved', {
          requestId,
          operation: operation.operationName,
          ruleId: bestMatchedRule.id,
          riskLevel: highestRisk,
        });

        this.addHistoryRecord({
          id: generateId('rec'),
          requestId,
          operation: operation.operationName,
          decision: 'auto_approved',
          timestamp: Date.now(),
        });

        return {
          decision: 'auto_approved',
          requestId,
          matchedRules,
          riskLevel: highestRisk,
          reason: `规则 ${bestMatchedRule.name} 配置为自动审批`,
          expiresAt: Date.now() + 3600000,
        };
      }
    }

    // 关键风险且非自动审批 → 阻止
    if (highestRisk === 'critical' && bestMatchedRule.requireApprovalFrom !== 'auto') {
      this.blockedCount++;

      this.log.warn('关键风险操作被阻止', {
        requestId,
        operation: operation.operationName,
        ruleId: bestMatchedRule.id,
      });

      EventBus.getInstance().emitSync('approval.blocked', {
        requestId,
        operation: operation.operationName,
        ruleId: bestMatchedRule.id,
        riskLevel: highestRisk,
      });

      this.addHistoryRecord({
        id: generateId('rec'),
        requestId,
        operation: operation.operationName,
        decision: 'blocked',
        timestamp: Date.now(),
      });

      return {
        decision: 'blocked',
        requestId,
        matchedRules,
        riskLevel: highestRisk,
        reason: `关键风险操作 ${operation.operationName} 被阻止，需要 ${bestMatchedRule.requireApprovalFrom} 审批`,
      };
    }

    // 需要审批
    const pending = this.createPendingApproval(requestId, operation, highestRisk, matchedRules, bestMatchedRule);
    this.requiresApprovalCount++;

    this.log.info('操作需要审批', {
      requestId,
      operation: operation.operationName,
      riskLevel: highestRisk,
      requireFrom: bestMatchedRule.requireApprovalFrom,
    });

    EventBus.getInstance().emitSync('approval.requires_approval', {
      requestId,
      operation: operation.operationName,
      riskLevel: highestRisk,
      requireFrom: bestMatchedRule.requireApprovalFrom,
    });

    return pending.decision;
  }

  // ========== 审批操作 ==========

  /**
   * 批准待审批请求
   */
  grantApproval(requestId: string, approver: string, conditions?: string[]): { success: boolean; message: string } {
    const pending = this.pendingApprovals.get(requestId);

    if (!pending) {
      this.log.warn('审批失败：请求不存在或已处理', { requestId });
      return { success: false, message: `请求 ${requestId} 不存在或已处理` };
    }

    // 检查是否已过期
    if (pending.expiresAt && Date.now() > pending.expiresAt) {
      this.pendingApprovals.delete(requestId);
      this.log.warn('审批失败：请求已过期', { requestId });
      return { success: false, message: `请求 ${requestId} 已过期` };
    }

    // 移除待审批
    this.pendingApprovals.delete(requestId);
    this.grantedCount++;

    // 记录到历史
    this.addHistoryRecord({
      id: generateId('rec'),
      requestId,
      operation: pending.operation.operationName,
      decision: 'granted',
      approver,
      timestamp: Date.now(),
      conditions,
    });

    this.log.info('审批已批准', {
      requestId,
      operation: pending.operation.operationName,
      approver,
      conditions,
    });

    EventBus.getInstance().emitSync('approval.granted', {
      requestId,
      operation: pending.operation.operationName,
      approver,
      conditions,
    });

    return { success: true, message: `请求 ${requestId} 已由 ${approver} 批准` };
  }

  /**
   * 拒绝待审批请求
   */
  denyApproval(requestId: string, reason: string): { success: boolean; message: string } {
    const pending = this.pendingApprovals.get(requestId);

    if (!pending) {
      this.log.warn('拒绝失败：请求不存在或已处理', { requestId });
      return { success: false, message: `请求 ${requestId} 不存在或已处理` };
    }

    // 移除待审批
    this.pendingApprovals.delete(requestId);
    this.deniedCount++;

    // 记录到历史
    this.addHistoryRecord({
      id: generateId('rec'),
      requestId,
      operation: pending.operation.operationName,
      decision: 'denied',
      timestamp: Date.now(),
      denialReason: reason,
    });

    this.log.info('审批已拒绝', {
      requestId,
      operation: pending.operation.operationName,
      reason,
    });

    EventBus.getInstance().emitSync('approval.denied', {
      requestId,
      operation: pending.operation.operationName,
      reason,
    });

    return { success: true, message: `请求 ${requestId} 已被拒绝：${reason}` };
  }

  // ========== 查询 ==========

  /**
   * 获取所有待审批请求
   */
  getPendingApprovals(): Array<{
    requestId: string;
    operation: string;
    requester: string;
    description: string;
    riskLevel: string;
    matchedRules: string[];
    requireApprovalFrom: string;
    createdAt: number;
    expiresAt?: number;
  }> {
    const now = Date.now();
    const result: Array<{
      requestId: string;
      operation: string;
      requester: string;
      description: string;
      riskLevel: string;
      matchedRules: string[];
      requireApprovalFrom: string;
      createdAt: number;
      expiresAt?: number;
    }> = [];

    for (const [requestId, pending] of Array.from(this.pendingApprovals)) {
      // 清理已过期的请求
      if (pending.expiresAt && now > pending.expiresAt) {
        this.pendingApprovals.delete(requestId);
        continue;
      }

      // 获取匹配规则中的审批要求
      let requireFrom = 'user';
      for (const ruleId of pending.decision.matchedRules) {
        const rule = this.rules.get(ruleId);
        if (rule && rule.requireApprovalFrom !== 'auto') {
          requireFrom = rule.requireApprovalFrom;
          break;
        }
      }

      result.push({
        requestId,
        operation: pending.operation.operationName,
        requester: pending.operation.requester,
        description: pending.operation.description,
        riskLevel: pending.decision.riskLevel,
        matchedRules: pending.decision.matchedRules,
        requireApprovalFrom: requireFrom,
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
      });
    }

    return result;
  }

  /**
   * 获取审批历史
   */
  getApprovalHistory(limit: number = 50): ApprovalRecord[] {
    return this.approvalHistory.slice(-limit);
  }

  /**
   * 获取统计信息
   */
  getStats(): ApprovalStats {
    return {
      totalRequests: this.totalRequests,
      autoApproved: this.autoApprovedCount,
      requiresApproval: this.requiresApprovalCount,
      blocked: this.blockedCount,
      granted: this.grantedCount,
      denied: this.deniedCount,
      pending: this.pendingApprovals.size,
      ruleCount: this.rules.size,
      byRiskLevel: { ...this.byRiskLevel },
    };
  }

  // ========== 内部方法 ==========

  /**
   * 创建待审批请求
   */
  private createPendingApproval(
    requestId: string,
    operation: OperationRequest,
    riskLevel: string,
    matchedRules: string[],
    matchedRule: ApprovalRule,
  ): PendingApproval {
    const expiresAt = Date.now() + 1800000;  // 30分钟过期

    const decision: ApprovalDecision = {
      decision: 'requires_approval',
      requestId,
      matchedRules,
      riskLevel,
      reason: `操作 ${operation.operationName} 匹配规则 ${matchedRule.name}，需要 ${matchedRule.requireApprovalFrom} 审批`,
      expiresAt,
    };

    const pending: PendingApproval = {
      requestId,
      operation,
      decision,
      createdAt: Date.now(),
      expiresAt,
    };

    this.pendingApprovals.set(requestId, pending);
    return pending;
  }

  /**
   * 检查自动批准限流
   */
  private checkAutoApproveLimit(rule: ApprovalRule): boolean {
    if (!rule.maxAutoApprovePerHour) return true;

    const counter = this.autoApproveCounters.get(rule.id);
    const now = Date.now();

    if (!counter || (now - counter.windowStart) >= 3600000) {
      // 新窗口
      return true;
    }

    return counter.count < rule.maxAutoApprovePerHour;
  }

  /**
   * 记录自动批准计数
   */
  private recordAutoApprove(ruleId: string): void {
    const now = Date.now();
    const counter = this.autoApproveCounters.get(ruleId);

    if (!counter || (now - counter.windowStart) >= 3600000) {
      this.autoApproveCounters.set(ruleId, { count: 1, windowStart: now });
    } else {
      counter.count++;
    }
  }

  /**
   * 检查冷却期
   */
  private checkCooldown(rule: ApprovalRule, operationName: string): boolean {
    if (!rule.cooldownMs) return true;

    const key = `${rule.id}:${operationName}`;
    const record = this.cooldownRecords.get(key);

    if (!record) return true;

    return (Date.now() - record.lastApprovedAt) >= rule.cooldownMs!;
  }

  /**
   * 记录冷却期
   */
  private recordCooldown(ruleId: string, operationName: string): void {
    const key = `${ruleId}:${operationName}`;
    this.cooldownRecords.set(key, { lastApprovedAt: Date.now() });
  }

  /**
   * 添加历史记录
   */
  private addHistoryRecord(record: ApprovalRecord): void {
    this.approvalHistory.push(record);
    // 限制历史记录大小
    if (this.approvalHistory.length > 1000) {
      this.approvalHistory = this.approvalHistory.slice(-500);
    }
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const gate = this;

    return [
      {
        name: 'approval_check',
        description: '检查操作是否需要审批。评估操作名称和参数，返回审批决策（自动批准/需要审批/阻止）。此操作只读，不会改变任何状态。',
        parameters: {
          operationName: { type: 'string', description: '操作名称，如 file_delete_path、shell_exec_command', required: true },
          parameters: { type: 'string', description: '操作参数（JSON格式），如 {"filePath": "/tmp/test.txt"}', required: false },
          requester: { type: 'string', description: '发起者标识（Agent 或工具名）', required: false },
          description: { type: 'string', description: '操作描述', required: false },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const operation: OperationRequest = {
              operationName: args.operationName as string,
              parameters: args.parameters ? JSON.parse(args.parameters as string) : {},
              requester: (args.requester as string) || 'agent',
              description: (args.description as string) || '',
              timestamp: Date.now(),
            };

            const decision = gate.checkApproval(operation);
            return Promise.resolve(JSON.stringify(decision, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`审批检查失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'approval_grant',
        description: '批准一个待审批请求。需要提供请求ID和审批人信息，可附加条件。',
        parameters: {
          requestId: { type: 'string', description: '待审批请求的唯一标识', required: true },
          approver: { type: 'string', description: '审批人标识', required: true },
          conditions: { type: 'string', description: '附加条件（JSON数组格式），如 ["仅限测试环境"]', required: false },
        },
        execute: (args) => {
          try {
            const requestId = args.requestId as string;
            const approver = args.approver as string;
            let conditions: string[] | undefined;

            if (args.conditions) {
              try {
                conditions = JSON.parse(args.conditions as string);
              } catch {
                conditions = [(args.conditions as string)];
              }
            }

            const result = gate.grantApproval(requestId, approver, conditions);
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`审批批准失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'approval_deny',
        description: '拒绝一个待审批请求。需要提供请求ID和拒绝原因。',
        parameters: {
          requestId: { type: 'string', description: '待审批请求的唯一标识', required: true },
          reason: { type: 'string', description: '拒绝原因', required: true },
        },
        execute: (args) => {
          try {
            const requestId = args.requestId as string;
            const reason = args.reason as string;
            const result = gate.denyApproval(requestId, reason);
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`审批拒绝失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'approval_pending',
        description: '查看所有待审批请求列表。包括请求ID、操作名称、风险等级、发起者等信息。此操作只读。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const pending = gate.getPendingApprovals();

            if (pending.length === 0) {
              return Promise.resolve('当前没有待审批请求');
            }

            const lines = pending.map(p =>
              `  [${p.riskLevel}] ${p.requestId} — ${p.operation} (发起: ${p.requester})` +
              `\n    描述: ${p.description}` +
              `\n    需要审批: ${p.requireApprovalFrom} | 匹配规则: ${p.matchedRules.join(', ')}` +
              (p.expiresAt ? `\n    过期时间: ${new Date(p.expiresAt).toISOString()}` : ''),
            );

            return Promise.resolve([
              `📋 待审批请求 (${pending.length}个):`,
              '',
              ...lines,
            ].join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`获取待审批列表失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'approval_rules',
        description: '查看所有已注册的审批规则及其配置。包括规则ID、名称、风险等级、操作模式、自动批准条件等。此操作只读。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const rules = Array.from(gate.rules.values());
            const stats = gate.getStats();

            const lines = rules.map(r => {
              const status = r.enabled ? '✅' : '❌';
              const autoCond = r.autoApproveConditions
                ? ` | 自动条件: ${r.autoApproveConditions.length}个`
                : '';
              const limit = r.maxAutoApprovePerHour
                ? ` | 限流: ${r.maxAutoApprovePerHour}/h`
                : '';
              const cooldown = r.cooldownMs
                ? ` | 冷却: ${r.cooldownMs}ms`
                : '';

              return `  ${status} [${r.riskLevel}] ${r.id} — ${r.name}` +
                `\n    ${r.description}` +
                `\n    模式: ${r.operationPatterns.join(', ')} | 审批: ${r.requireApprovalFrom}${autoCond}${limit}${cooldown}`;
            });

            return Promise.resolve([
              `🔐 审批规则列表 (${rules.length}个):`,
              '',
              ...lines,
              '',
              `📊 统计: 总请求${stats.totalRequests} | 自动批准${stats.autoApproved} | 需审批${stats.requiresApproval} | 阻止${stats.blocked} | 已批准${stats.granted} | 已拒绝${stats.denied} | 待审批${stats.pending}`,
            ].join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`获取审批规则失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
    ];
  }
}
