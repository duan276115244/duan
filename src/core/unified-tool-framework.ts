/**
 * 统一工具执行框架 - UnifiedToolFramework
 *
 * 核心设计原则（借鉴 Codex CLI + ClawHub）：
 * 1. 所有工具通过 ToolRegistry 统一注册，消除硬编码
 * 2. 每个工具声明风险等级、执行策略、沙箱需求
 * 3. ApprovalGate 对高风险操作进行安全审批
 * 4. 工具执行结果统一格式化与错误处理
 * 5. 支持动态注册/注销工具（插件化）
 *
 * 与 enhanced-agent-loop.ts 的 ToolRegistry 互补：
 * - enhanced-agent-loop.ts 中的 ToolRegistry 是轻量级运行时注册表
 * - 本模块是完整的工具生命周期管理框架
 */

// ============ 核心类型 ============

/** 工具风险等级 */
export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

/** 执行策略 */
export type ExecutionPolicy = 'parallel' | 'serial' | 'approval_required';

/** 沙箱类型 */
export type SandboxType = 'none' | 'vm' | 'docker' | 'process';

/** 工具状态 */
export type ToolStatus = 'active' | 'disabled' | 'error';

/** 工具执行结果 */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: {
    executionTime: number;
    sandboxed: boolean;
    riskLevel: RiskLevel;
    approvedBy?: string;
  };
}

/** 工具定义（增强版） */
export interface UnifiedToolDefinition {
  /** 唯一标识 */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数定义 */
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validation?: (value: any) => boolean;
  }>;
  /** 执行函数 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context?: ToolExecutionContext) => Promise<ToolResult>;
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 执行策略 */
  executionPolicy: ExecutionPolicy;
  /** 沙箱配置 */
  sandbox: {
    type: SandboxType;
    timeout: number;     // 超时毫秒
    maxMemory: number;   // 最大内存MB
    maxOutput: number;   // 最大输出字符数
  };
  /** 审批提示信息 */
  approvalMessage: string;
  /** 工具分类 */
  category: string;
  /** 标签 */
  tags: string[];
  /** 版本 */
  version: string;
  /** 是否为内置工具 */
  builtIn: boolean;
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  /** 工作目录 */
  workingDirectory: string;
  /** 项目根目录 */
  projectRoot: string;
  /** 环境变量 */
  env: Record<string, string>;
  /** 调用者信息 */
  caller?: string;
  /** 请求ID */
  requestId: string;
  /** 是否在沙箱中执行 */
  sandboxed: boolean;
}

/** 工具注册信息 */
export interface ToolRegistration {
  definition: UnifiedToolDefinition;
  status: ToolStatus;
  registeredAt: number;
  lastUsed?: number;
  useCount: number;
  errorCount: number;
  avgExecutionTime: number;
}

/** 审批回调类型 */
export type ApprovalCallback = (request: {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  approvalMessage: string;
}) => Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown>; reason?: string }>;

/** 工具框架配置 */
export interface ToolFrameworkConfig {
  /** 项目根目录 */
  projectRoot: string;
  /** 自动批准安全工具 */
  autoApproveSafe: boolean;
  /** 默认沙箱类型 */
  defaultSandbox: SandboxType;
  /** 默认超时 */
  defaultTimeout: number;
  /** 最大输出长度 */
  maxOutputLength: number;
  /** 审批回调 */
  approvalCallback?: ApprovalCallback;
}

// ============ UnifiedToolFramework: 统一工具框架 ============

export class UnifiedToolFramework {
  private registry: Map<string, ToolRegistration> = new Map();
  private config: ToolFrameworkConfig;
  private executionLog: Array<{
    toolId: string;
    timestamp: number;
    success: boolean;
    executionTime: number;
  }> = [];

  constructor(config?: Partial<ToolFrameworkConfig>) {
    this.config = {
      projectRoot: process.cwd(),
      autoApproveSafe: true,
      defaultSandbox: 'vm',
      defaultTimeout: 30000,
      maxOutputLength: 10000,
      ...config,
    };
    // P1-1 优化：移除 registerBuiltInTools() — 16 个内置工具与 src/tools/built-in/ 完全重复且从未被执行。
    // 实际工具执行走 ScalableToolRegistry + allBuiltInTools。UnifiedToolFramework 仅保留管理 API。
  }

  /**
   * 注册工具
   */
  register(definition: UnifiedToolDefinition): void {
    if (this.registry.has(definition.id)) {
      console.warn(`工具 ${definition.id} 已注册，将被覆盖`);
    }

    this.registry.set(definition.id, {
      definition,
      status: 'active',
      registeredAt: Date.now(),
      useCount: 0,
      errorCount: 0,
      avgExecutionTime: 0,
    });
  }

  /**
   * 注销工具
   */
  unregister(toolId: string): boolean {
    return this.registry.delete(toolId);
  }

  /**
   * 获取所有活跃工具
   */
  getActiveTools(): UnifiedToolDefinition[] {
    return Array.from(this.registry.values())
      .filter(r => r.status === 'active')
      .map(r => r.definition);
  }

  /**
   * 按分类获取工具
   */
  getToolsByCategory(category: string): UnifiedToolDefinition[] {
    return this.getActiveTools().filter(t => t.category === category);
  }

  /**
   * 按风险等级获取工具
   */
  getToolsByRiskLevel(riskLevel: RiskLevel): UnifiedToolDefinition[] {
    return this.getActiveTools().filter(t => t.riskLevel === riskLevel);
  }

  /**
   * 执行工具
   */
  async execute(
    toolId: string,
    args: Record<string, unknown>,
    context?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const reg = this.registry.get(toolId);
    if (!reg) {
      return {
        success: false,
        output: '',
        error: `工具 ${toolId} 未注册`,
      };
    }

    if (reg.status !== 'active') {
      return {
        success: false,
        output: '',
        error: `工具 ${toolId} 当前状态为 ${reg.status}，无法执行`,
      };
    }

    const def = reg.definition;

    // 参数验证
    const validationError = this.validateArgs(def, args);
    if (validationError) {
      return {
        success: false,
        output: '',
        error: validationError,
      };
    }

    // 安全审批：仅 dangerous 需要确认，safe/moderate 自动通过
    if (def.riskLevel === 'dangerous' || (!this.config.autoApproveSafe && def.riskLevel === 'moderate')) {
      const approvalResult = await this.checkApproval(def, args);
      if (!approvalResult.approved) {
        return {
          success: false,
          output: '',
          error: `操作被拒绝: ${approvalResult.reason || '需要用户确认'}`,
          metadata: {
            executionTime: 0,
            sandboxed: false,
            riskLevel: def.riskLevel,
          },
        };
      }
      if (approvalResult.modifiedArgs) {
        args = approvalResult.modifiedArgs;
      }
    }

    // 构建执行上下文
    const execContext: ToolExecutionContext = {
      workingDirectory: context?.workingDirectory || this.config.projectRoot,
      projectRoot: context?.projectRoot || this.config.projectRoot,
      env: context?.env || {},
      caller: context?.caller,
      requestId: context?.requestId || `req-${Date.now()}`,
      sandboxed: def.sandbox.type !== 'none',
    };

    // 执行工具
    const startTime = Date.now();
    try {
      const result = await def.execute(args, execContext);

      // 更新统计（统一逻辑）
      const executionTime = Date.now() - startTime;
      this.updateExecutionStats(reg, toolId, result.success, executionTime);

      return result;
    } catch (err: unknown) {
      const executionTime = Date.now() - startTime;
      this.updateExecutionStats(reg, toolId, false, executionTime);

      return {
        success: false,
        output: '',
        error: `工具执行异常: ${(err instanceof Error ? err.message : String(err))}`,
        metadata: {
          executionTime,
          sandboxed: execContext.sandboxed,
          riskLevel: def.riskLevel,
        },
      };
    }
  }

  /**
   * 统一的执行统计更新逻辑
   *
   * 同时被 execute() 与 recordExternalExecution() 调用，集中维护
   * useCount / errorCount / lastUsed / avgExecutionTime 与 executionLog（含裁剪）。
   *
   * @param reg 工具注册项
   * @param toolId 工具名
   * @param success 是否成功
   * @param executionTime 执行耗时（毫秒）
   */
  private updateExecutionStats(
    // lastUsed 在 ToolRegistration 中为可选（首次注册时未设置），此处允许 undefined
    reg: { useCount: number; errorCount: number; lastUsed?: number; avgExecutionTime: number },
    toolId: string,
    success: boolean,
    executionTime: number,
  ): void {
    reg.useCount++;
    if (!success) reg.errorCount++;
    reg.lastUsed = Date.now();
    reg.avgExecutionTime = (reg.avgExecutionTime * (reg.useCount - 1) + executionTime) / reg.useCount;

    this.executionLog.push({
      toolId,
      timestamp: Date.now(),
      success,
      executionTime,
    });

    // 防止 executionLog 无限增长（保留最近 5000 条）
    if (this.executionLog.length > 5000) {
      this.executionLog.splice(0, this.executionLog.length - 5000);
    }
  }

  /**
   * P0-1: 记录外部执行（由主循环 EnhancedAgentLoop 同步推送）
   *
   * 主循环已通过 ScalableToolRegistry 执行工具，但希望把统计同步到 UnifiedToolFramework，
   * 以便 getStats() 输出完整的 byCategory/byRiskLevel/successRate。
   * 此方法仅更新 registry 计数 + executionLog，不触发实际 execute。
   *
   * @param toolId 工具名（与 register 时的 id 一致；未注册则跳过）
   * @param success 是否成功
   * @param executionTime 执行耗时（毫秒）
   */
  recordExternalExecution(toolId: string, success: boolean, executionTime: number): void {
    const reg = this.registry.get(toolId);
    if (!reg) return; // 未注册的工具不记录（避免污染统计）
    this.updateExecutionStats(reg, toolId, success, executionTime);
  }

  /**
   * 获取工具统计信息
   */
  getStats(): {
    totalTools: number;
    activeTools: number;
    totalExecutions: number;
    successRate: number;
    avgExecutionTime: number;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
  } {
    const activeRegs = Array.from(this.registry.values()).filter(r => r.status === 'active');
    const totalExecutions = this.executionLog.length;
    const successCount = this.executionLog.filter(e => e.success).length;
    const avgTime = totalExecutions > 0
      ? this.executionLog.reduce((s, e) => s + e.executionTime, 0) / totalExecutions
      : 0;

    const byCategory: Record<string, number> = {};
    const byRiskLevel: Record<string, number> = {};
    for (const reg of activeRegs) {
      byCategory[reg.definition.category] = (byCategory[reg.definition.category] || 0) + 1;
      byRiskLevel[reg.definition.riskLevel] = (byRiskLevel[reg.definition.riskLevel] || 0) + 1;
    }

    return {
      totalTools: this.registry.size,
      activeTools: activeRegs.length,
      totalExecutions,
      successRate: totalExecutions > 0 ? successCount / totalExecutions : 0,
      avgExecutionTime: avgTime,
      byCategory,
      byRiskLevel,
    };
  }

  /**
   * 转换为OpenAI function calling格式
   */
  toOpenAITools(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };
    };
  }> {
    return this.getActiveTools().map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(

            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
          ),
          required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
        },
      },
    }));
  }

  // ============ 私有方法 ============

  /**
   * 参数验证
   */
  private validateArgs(def: UnifiedToolDefinition, args: Record<string, unknown>): string | null {
    for (const [key, param] of Object.entries(def.parameters)) {
      if (param.required && (args[key] === undefined || args[key] === null)) {
        return `缺少必需参数: ${key}`;
      }
      if (args[key] !== undefined && param.validation && !param.validation(args[key])) {
        return `参数 ${key} 验证失败`;
      }
    }
    return null;
  }

  /**
   * 安全审批检查
   */
  private async checkApproval(
    def: UnifiedToolDefinition,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown>; reason?: string }> {
    if (!this.config.approvalCallback) {
      // 无回调时：dangerous默认拒绝，moderate默认通过
      if (def.riskLevel === 'dangerous') {
        return { approved: false, reason: '高风险操作需要审批回调才能执行' };
      }
      return { approved: true };
    }

    try {
      return await this.config.approvalCallback({
        toolId: def.id,
        toolName: def.name,
        args,
        riskLevel: def.riskLevel,
        approvalMessage: def.approvalMessage,
      });
    } catch {
      return { approved: false, reason: '审批回调执行失败' };
    }
  }

}
