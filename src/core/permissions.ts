/**
 * 增强权限管理器
 * 支持 RBAC + ABAC 混合权限控制
 */

import { atomicWriteJson } from './atomic-write.js';

/** 权限定义 */
export interface Permission {
  id: string;
  toolName: string;
  allowed: boolean;
  restrictions?: string[];
  scope?: 'global' | 'project' | 'session';
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval?: boolean;
}

/** 角色定义 */
export interface Role {
  name: string;
  permissions: string[];
  maxRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

/** 安全上下文 */
export interface SecurityContext {
  userId?: string;
  sessionId?: string;
  projectPath?: string;
  ipAddress?: string;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  isTrustedEnvironment?: boolean;
}

/** 权限检查结果 */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  riskLevel?: string;
  conditions?: string[];
}

/** 安全策略 */
interface SecurityPolicy {
  name: string;
  description: string;
  condition: (context: SecurityContext) => boolean;
  effect: 'allow' | 'deny';
  priority: number;
}

export class PermissionManager {
  private permissions: Map<string, Permission> = new Map();
  private roles: Map<string, Role> = new Map();
  private userRoles: Map<string, string[]> = new Map();
  private policies: SecurityPolicy[] = [];
  private deniedLog: Array<{ toolName: string; timestamp: Date; reason: string }> = [];

  constructor() {
    this.initDefaultPermissions();
    this.initDefaultRoles();
    this.initDefaultPolicies();
  }

  private initDefaultPermissions(): void {
    const defaultPermissions: Permission[] = [
      { id: 'read_file', toolName: 'read_file', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'write_file', toolName: 'write_file', allowed: true, scope: 'project', riskLevel: 'medium', requiresApproval: false },
      { id: 'edit_file', toolName: 'edit_file', allowed: true, scope: 'project', riskLevel: 'medium' },
      { id: 'delete_file', toolName: 'delete_file', allowed: true, scope: 'project', riskLevel: 'high', requiresApproval: true },
      { id: 'list_files', toolName: 'list_files', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'search_code', toolName: 'search_code', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'execute_command', toolName: 'execute_command', allowed: true, scope: 'project', riskLevel: 'high', restrictions: ['node', 'npm', 'git', 'python', 'pip'], requiresApproval: false },
      { id: 'execute_dangerous_command', toolName: 'execute_command', allowed: false, scope: 'project', riskLevel: 'critical', restrictions: ['rm', 'format', 'del', 'shutdown', 'reboot'] },
      { id: 'web_search', toolName: 'web_search', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'web_fetch', toolName: 'web_fetch', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'generate_image', toolName: 'generate_image', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'generate_video', toolName: 'generate_video', allowed: true, scope: 'global', riskLevel: 'low' },
      { id: 'system_config', toolName: 'system_config', allowed: true, scope: 'global', riskLevel: 'high', requiresApproval: true },
      { id: 'network_access', toolName: 'network_access', allowed: true, scope: 'global', riskLevel: 'medium' },
    ];

    for (const permission of defaultPermissions) {
      this.permissions.set(permission.id, permission);
    }
  }

  private initDefaultRoles(): void {
    const defaultRoles: Role[] = [
      {
        name: 'viewer',
        permissions: ['read_file', 'list_files', 'search_code', 'web_search'],
        maxRiskLevel: 'low',
        description: '只读权限，仅可查看和搜索',
      },
      {
        name: 'developer',
        permissions: ['read_file', 'write_file', 'edit_file', 'list_files', 'search_code', 'execute_command', 'web_search', 'web_fetch', 'generate_image'],
        maxRiskLevel: 'high',
        description: '开发者权限，可读写和执行常规命令',
      },
      {
        name: 'admin',
        permissions: Array.from(this.permissions.keys()),
        maxRiskLevel: 'critical',
        description: '管理员权限，可执行所有操作',
      },
    ];

    for (const role of defaultRoles) {
      this.roles.set(role.name, role);
    }

    // 默认用户角色
    this.userRoles.set('default', ['developer']);
  }

  private initDefaultPolicies(): void {
    this.policies = [
      {
        name: 'deny_dangerous_commands',
        description: '拒绝危险命令',
        condition: (ctx) => !ctx.isTrustedEnvironment,
        effect: 'deny',
        priority: 100,
      },
      {
        name: 'restrict_night_operations',
        description: '夜间限制高风险操作',
        condition: (ctx) => ctx.timeOfDay === 'night',
        effect: 'deny',
        priority: 50,
      },
    ];
  }

  /**
   * 检查工具是否有权限执行（增强版 RBAC + ABAC）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,需透传至限制检查与审批
  check(toolName: string, parameters: any, context?: SecurityContext): Promise<PermissionResult> {
    const ctx = context || this.getDefaultContext();

    // 1. 检查安全策略
    const policyResult = this.evaluatePolicies(toolName, ctx);
    if (policyResult === 'deny') {
      this.logDenied(toolName, '安全策略拒绝');
      return Promise.resolve({ allowed: false, reason: '安全策略拒绝此操作' });
    }

    // 2. 检查权限定义
    const permission = this.findPermissionForTool(toolName);
    if (!permission) {
      this.logDenied(toolName, '未知工具');
      return Promise.resolve({ allowed: false, reason: `未知工具 "${toolName}"` });
    }

    if (!permission.allowed) {
      this.logDenied(toolName, '权限未开启');
      return Promise.resolve({ allowed: false, reason: `工具 "${toolName}" 未被允许` });
    }

    // 3. 检查限制条件
    if (permission.restrictions && permission.restrictions.length > 0) {
      const restrictionResult = this.checkRestrictions(toolName, parameters, permission.restrictions);
      if (!restrictionResult) {
        this.logDenied(toolName, '超出限制范围');
        return Promise.resolve({ allowed: false, reason: `操作超出工具 "${toolName}" 的限制范围` });
      }
    }

    // 4. 检查风险等级
    const riskLevel = permission.riskLevel || 'low';
    const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

    // 检查用户角色是否允许此风险等级
    const userRoleNames = ctx.userId ? (this.userRoles.get(ctx.userId) || ['developer']) : ['developer'];
    const maxAllowedRisk = Math.max(...userRoleNames.map(rn => {
      const role = this.roles.get(rn);
      return role ? riskOrder[role.maxRiskLevel] : 1;
    }));

    if ((riskOrder[riskLevel] || 0) > maxAllowedRisk) {
      this.logDenied(toolName, '风险等级超出角色权限');
      return Promise.resolve({ allowed: false, reason: `操作风险等级(${riskLevel})超出当前角色权限`, requiresApproval: true });
    }

    // 5. 检查是否需要审批
    if (permission.requiresApproval) {
      return Promise.resolve({
        allowed: true,
        requiresApproval: true,
        riskLevel: riskLevel,
        reason: '此操作需要审批确认',
      });
    }

    return Promise.resolve({ allowed: true, riskLevel: riskLevel });
  }

  /**
   * 查找工具对应的权限
   */
  private findPermissionForTool(toolName: string): Permission | undefined {
    // 精确匹配
    const perm = this.permissions.get(toolName);
    if (perm) return perm;

    // 前缀匹配
    for (const [, p] of this.permissions) {
      if (toolName.startsWith(p.toolName)) {
        return p;
      }
    }

    return undefined;
  }

  /**
   * 评估安全策略
   */
  private evaluatePolicies(toolName: string, context: SecurityContext): 'allow' | 'deny' | 'neutral' {
    // 按优先级排序
    const sorted = [...this.policies].sort((a, b) => b.priority - a.priority);

    for (const policy of sorted) {
      if (policy.condition(context)) {
        return policy.effect;
      }
    }

    return 'neutral';
  }

  /**
   * 获取默认安全上下文
   */
  private getDefaultContext(): SecurityContext {
    const hour = new Date().getHours();
    let timeOfDay: SecurityContext['timeOfDay'] = 'morning';
    if (hour >= 12 && hour < 18) timeOfDay = 'afternoon';
    else if (hour >= 18 && hour < 22) timeOfDay = 'evening';
    else if (hour >= 22 || hour < 6) timeOfDay = 'night';

    return {
      timeOfDay,
      isTrustedEnvironment: true,
    };
  }

  /**
   * 记录拒绝操作
   */
  private logDenied(toolName: string, reason: string): void {
    this.deniedLog.push({ toolName, timestamp: new Date(), reason });
    // 只保留最近100条
    if (this.deniedLog.length > 100) {
      this.deniedLog = this.deniedLog.slice(-100);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,需访问 command 字段
  private checkRestrictions(toolName: string, parameters: any, restrictions: string[]): boolean {
    if (toolName === 'execute_command' && parameters.command) {
      const command = parameters.command as string;
      const commandParts = command.split(' ');
      const baseCommand = commandParts[0].toLowerCase();

      return restrictions.some(restriction => baseCommand.includes(restriction.toLowerCase()));
    }

    return true;
  }

  /**
   * 设置权限
   */
  setPermission(toolName: string, allowed: boolean, restrictions?: string[]): void {
    const existing = this.permissions.get(toolName);
    this.permissions.set(toolName, {
      id: existing?.id || toolName,
      toolName,
      allowed,
      restrictions: restrictions || existing?.restrictions,
      scope: existing?.scope || 'project',
      riskLevel: existing?.riskLevel || 'medium',
      requiresApproval: existing?.requiresApproval,
    });
  }

  /**
   * 添加安全策略
   */
  addPolicy(policy: SecurityPolicy): void {
    this.policies.push(policy);
  }

  /**
   * 为用户分配角色
   */
  assignRole(userId: string, roleName: string): void {
    const roles = this.userRoles.get(userId) || [];
    if (!roles.includes(roleName)) {
      roles.push(roleName);
      this.userRoles.set(userId, roles);
    }
  }

  /**
   * 获取所有权限
   */
  getAllPermissions(): Permission[] {
    return Array.from(this.permissions.values());
  }

  /**
   * 获取拒绝日志
   */
  getDeniedLog(): Array<{ toolName: string; timestamp: Date; reason: string }> {
    return [...this.deniedLog];
  }

  /**
   * 请求用户批准 (交互式)
   * 实现真正的审批逻辑：根据风险级别和工具类型决定是否需要人工确认
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数为动态 JSON,需序列化展示与透传给审批回调
  requestApproval(toolName: string, parameters: any): Promise<boolean> {
    // 获取工具的风险级别
    const permission = this.permissions.get(toolName);
    const riskLevel = permission?.riskLevel || 'moderate';

    // 低风险工具自动批准
    if (riskLevel === 'low') {
      console.info(`[权限] 低风险工具 ${toolName} 自动批准`);
      return Promise.resolve(true);
    }

    // 高风险/关键工具需要人工确认
    if (riskLevel === 'high' || riskLevel === 'critical') {
      console.warn(`⚠️ [权限] 高风险工具 ${toolName} 需要人工批准，参数: ${JSON.stringify(parameters, null, 2)}`);

      // 在有审批回调时使用回调，否则根据自动审批策略决定
      if (this.approvalCallback) {
        return this.approvalCallback(toolName, parameters, riskLevel);
      }

      // 无回调时：关键风险拒绝，高风险根据配置决定
      if (riskLevel === 'critical') {
        console.error(`[权限] 关键风险工具 ${toolName} 无审批回调，自动拒绝`);
        return Promise.resolve(false);
      }

      // 高风险：检查是否在自动批准列表中
      if (this.autoApproveTools.has(toolName)) {
        console.info(`[权限] 高风险工具 ${toolName} 在自动批准列表中`);
        return Promise.resolve(true);
      }

      console.warn(`[权限] 高风险工具 ${toolName} 无审批回调且不在自动批准列表中，拒绝执行`);
      return Promise.resolve(false);
    }

    // 中等风险：检查自动批准配置
    if (this.autoApproveTools.has(toolName)) {
      return Promise.resolve(true);
    }

    // 默认：有回调则询问，无回调则批准
    if (this.approvalCallback) {
      return this.approvalCallback(toolName, parameters, riskLevel);
    }

    console.info(`[权限] 中等风险工具 ${toolName} 无审批回调，默认批准`);
    return Promise.resolve(true);
  }

  /** 设置审批回调函数（用于 UI 交互式确认） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 回调接收动态 JSON 工具参数
  setApprovalCallback(callback: (toolName: string, params: any, riskLevel: string) => Promise<boolean>): void {
    this.approvalCallback = callback;
  }

  /** 添加自动批准工具 */
  addAutoApproveTool(toolName: string): void {
    this.autoApproveTools.add(toolName);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 回调接收动态 JSON 工具参数
  private approvalCallback: ((toolName: string, params: any, riskLevel: string) => Promise<boolean>) | null = null;
  private autoApproveTools: Set<string> = new Set();

  /**
   * 从文件加载权限配置
   */
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (data.permissions) {
        for (const permission of data.permissions as Permission[]) {
          this.permissions.set(permission.toolName, permission);
        }
      }

      if (data.roles) {
        for (const role of data.roles as Role[]) {
          this.roles.set(role.name, role);
        }
      }

      if (data.policies) {
        this.policies = data.policies;
      }

      console.info(`📜 权限配置已加载: ${filePath}`);
    } catch (error: unknown) {
      console.error('加载权限配置失败:', error);
    }
  }

  /**
   * 保存权限配置到文件
   */
  async saveToFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const data = {
        permissions: this.getAllPermissions(),
        roles: Array.from(this.roles.values()),
        policies: this.policies,
      };

      await atomicWriteJson(filePath, data);
      console.info(`📜 权限配置已保存: ${filePath}`);
    } catch (error: unknown) {
      console.error('保存权限配置失败:', error);
    }
  }
}
