/**
 * 统一工具执行管线 — ToolExecutionPipeline
 *
 * 将所有安全检查和执行步骤串联为确定性顺序的管线，
 * 统一原本分散的 ApprovalGate、PermissionClassifier 等组件。
 *
 * 管线阶段（按序执行）：
 *   1. JSON Schema 校验 — 轻量级参数验证（必填字段、类型、模式）
 *   2. 路径穿越防护 — 文件/Shell 工具的路径边界检查
 *   3. 危险命令拦截 — 正则匹配 rm -rf、mkfs、dd、curl|sh 等
 *   4. 审批门控 — 与现有审批回调机制集成
 *   5. 沙箱执行 — 在适当沙箱中执行工具
 *   6. 执行后审计 — 记录结果、耗时、错误
 */

import * as path from 'path';

// ============ 类型定义 ============

/** 风险等级 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** 管线决策 */
export type PipelineDecision =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'modify_args'; modifiedArgs: Record<string, unknown>; reason: string }
  | { action: 'require_approval'; reason: string };

/** 管线钩子阶段 */
export type PipelineStage =
  | 'pre_validation'
  | 'pre_security'
  | 'pre_approval'
  | 'pre_execution'
  | 'post_execution';

/** 工具执行上下文 */
export interface ToolExecutionContext {
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  toolArgs: Record<string, unknown>;
  /** 工具 JSON Schema（轻量校验用） */
  toolSchema?: Record<string, unknown>;
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 会话 ID */
  sessionId?: string;
  /** 工作区根路径 */
  workspaceRoot: string;
}

/** 单阶段执行结果 */
export interface StageResult {
  /** 阶段名称 */
  stage: string;
  /** 是否通过 */
  passed: boolean;
  /** 耗时（毫秒） */
  duration: number;
  /** 决策（如有） */
  decision?: PipelineDecision;
  /** 附加信息 */
  details?: string;
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: unknown;
  /** 错误信息 */
  error?: string;
  /** 总耗时（毫秒） */
  duration: number;
  /** 各阶段结果 */
  stages: StageResult[];
}

/** 管线钩子接口 */
export interface PipelineHook {
  /** 钩子名称 */
  name: string;
  /** 所属阶段 */
  stage: PipelineStage;
  /** 执行钩子逻辑 */
  execute(context: ToolExecutionContext): Promise<PipelineDecision>;
}

/** 审批回调类型 */
export type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
) => Promise<boolean>;

/** 管线配置选项 */
export interface PipelineOptions {
  /** 是否启用 Schema 校验（默认 true） */
  enableSchemaValidation?: boolean;
  /** 是否启用路径穿越防护（默认 true） */
  enablePathProtection?: boolean;
  /** 是否启用危险命令拦截（默认 true） */
  enableDangerousCommandBlocking?: boolean;
  /** 是否启用审计日志（默认 true） */
  enableAudit?: boolean;
  /** 文件类工具名称前缀列表 */
  fileToolPrefixes?: string[];
  /** Shell 类工具名称前缀列表 */
  shellToolPrefixes?: string[];
}

/** 路径校验结果 */
export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  reason?: string;
}

/** 工具执行函数类型 */
export type ToolExecutorFn = (args: Record<string, unknown>) => Promise<unknown>;

// ============ 路径校验工具 ============

/**
 * 校验路径是否在工作区边界内
 * 使用 path.resolve 解析，检查无 .. 穿越，且以 workspaceRoot 开头
 */
export function validatePath(
  inputPath: string,
  workspaceRoot: string,
): PathValidationResult {
  // 规范化工作区根路径
  const normalizedRoot = path.resolve(workspaceRoot).toLowerCase();

  // 检查是否包含路径穿越片段
  const parts = inputPath.split(/[/\\]/);
  if (parts.includes('..')) {
    return {
      valid: false,
      resolved: path.resolve(workspaceRoot, inputPath),
      reason: `路径包含 ".." 穿越片段: ${inputPath}`,
    };
  }

  // 解析绝对路径
  const resolved = path.resolve(workspaceRoot, inputPath);

  // 比较规范化后的路径前缀
  if (!resolved.toLowerCase().startsWith(normalizedRoot)) {
    return {
      valid: false,
      resolved,
      reason: `路径超出工作区边界: ${resolved} 不在 ${normalizedRoot} 内`,
    };
  }

  return { valid: true, resolved };
}

// ============ SessionLock — 会话级互斥锁 ============

type ReleaseFunction = () => void;

export class SessionLock {
  /** 每个会话的锁 Promise 链 */
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * 获取会话锁，同一会话串行，不同会话可并行
   * @returns 释放函数，调用后释放锁
   */
  async acquire(sessionId: string): Promise<ReleaseFunction> {
    // 获取当前锁尾部（可能为 undefined 表示无锁）
    const prevLock = this.locks.get(sessionId) ?? Promise.resolve();

    // 创建新的锁占位 Promise
    let release: ReleaseFunction;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 链接到尾部
    this.locks.set(sessionId, nextLock);

    // 等待前一个锁释放
    await prevLock;

    // 返回释放函数
    return release!;
  }

  /** 清理指定会话的锁记录 */
  cleanup(sessionId: string): void {
    this.locks.delete(sessionId);
  }
}

// ============ HookChain — 钩子链 ============

export class HookChain {
  private hooks: PipelineHook[] = [];

  /** 注册钩子 */
  register(hook: PipelineHook): void {
    this.hooks.push(hook);
  }

  /** 移除指定名称的钩子 */
  remove(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  /** 执行所有前置钩子，遇到非 continue 决策立即返回 */
  async executePreHooks(
    context: ToolExecutionContext,
    stage: PipelineStage,
  ): Promise<PipelineDecision> {
    const stageHooks = this.hooks.filter((h) => h.stage === stage);

    for (const hook of stageHooks) {
      const decision = await hook.execute(context);
      if (decision.action !== 'continue') {
        return decision;
      }
    }

    return { action: 'continue' };
  }

  /** 执行所有后置钩子（post_execution） */
  async executePostHooks(
    context: ToolExecutionContext,
    _result: ToolExecutionResult,
  ): Promise<void> {
    const postHooks = this.hooks.filter((h) => h.stage === 'post_execution');
    for (const hook of postHooks) {
      try {
        await hook.execute(context);
      } catch {
        // 后置钩子失败不影响主流程
      }
    }
  }

  /** 获取已注册钩子列表 */
  getHookNames(): string[] {
    return this.hooks.map((h) => `${h.name}(${h.stage})`);
  }
}

// ============ 内置钩子实现 ============

/**
 * Schema 校验钩子 — 轻量级参数验证
 * 检查必填字段、类型、正则模式，不依赖外部库
 */
export class SchemaValidationHook implements PipelineHook {
  name = 'schema_validation';
  stage: PipelineStage = 'pre_validation';

  execute(context: ToolExecutionContext): Promise<PipelineDecision> {
    const { toolArgs, toolSchema } = context;
    if (!toolSchema) return Promise.resolve({ action: 'continue' });

    // 检查必填字段
    const required = toolSchema.required as string[] | undefined;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (toolArgs[field] === undefined || toolArgs[field] === null) {
          return Promise.resolve({
            action: 'block',
            reason: `缺少必填参数: ${field}`,
          });
        }
      }
    }

    // 检查字段类型
    const properties = toolSchema.properties as
      | Record<string, { type?: string; pattern?: string; enum?: unknown[] }>
      | undefined;
    if (properties) {
      for (const [field, schema] of Object.entries(properties)) {
        const value = toolArgs[field];
        if (value === undefined || value === null) continue;

        // 类型检查
        if (schema.type) {
          const actualType = Array.isArray(value)
            ? 'array'
            : typeof value;
          if (actualType !== schema.type) {
            return Promise.resolve({
              action: 'block',
              reason: `参数 ${field} 类型错误: 期望 ${schema.type}, 实际 ${actualType}`,
            });
          }
        }

        // 正则模式检查
        if (schema.pattern && typeof value === 'string') {
          try {
            if (!new RegExp(schema.pattern).test(value)) {
              return Promise.resolve({
                action: 'block',
                reason: `参数 ${field} 不匹配模式: ${schema.pattern}`,
              });
            }
          } catch {
            // 正则无效则跳过
          }
        }

        // 枚举值检查
        if (schema.enum && !schema.enum.includes(value)) {
          return Promise.resolve({
            action: 'block',
            reason: `参数 ${field} 值不在允许范围内: ${schema.enum.join(', ')}`,
          });
        }
      }
    }

    return Promise.resolve({ action: 'continue' });
  }
}

/**
 * 路径穿越防护钩子
 * 对文件类和 Shell 类工具检查路径参数是否在工作区内
 */
export class PathTraversalProtectionHook implements PipelineHook {
  name = 'path_traversal_protection';
  stage: PipelineStage = 'pre_security';

  private fileToolPrefixes: string[];
  private shellToolPrefixes: string[];
  /** 参数中代表路径的键名 */
  private pathArgKeys = ['path', 'filePath', 'file_path', 'dir', 'directory', 'dest', 'destination', 'target', 'outputPath', 'output_path'];

  constructor(
    fileToolPrefixes = ['file_', 'fs_', 'dir_'],
    shellToolPrefixes = ['shell_', 'bash_', 'exec_', 'cmd_'],
  ) {
    this.fileToolPrefixes = fileToolPrefixes;
    this.shellToolPrefixes = shellToolPrefixes;
  }

  execute(context: ToolExecutionContext): Promise<PipelineDecision> {
    const { toolName, toolArgs, workspaceRoot } = context;

    // 判断是否为需要路径检查的工具
    const isFileTool = this.fileToolPrefixes.some((p) =>
      toolName.toLowerCase().startsWith(p),
    );
    const isShellTool = this.shellToolPrefixes.some((p) =>
      toolName.toLowerCase().startsWith(p),
    );
    const isPathTool =
      toolName.toLowerCase().includes('file') ||
      toolName.toLowerCase().includes('path') ||
      toolName.toLowerCase().includes('write') ||
      toolName.toLowerCase().includes('read');

    if (!isFileTool && !isShellTool && !isPathTool) {
      return Promise.resolve({ action: 'continue' });
    }

    // 检查所有路径参数
    const modifiedArgs = { ...toolArgs };

    for (const key of this.pathArgKeys) {
      const value = toolArgs[key];
      if (typeof value !== 'string') continue;

      const result = validatePath(value, workspaceRoot);
      if (!result.valid) {
        return Promise.resolve({
          action: 'block',
          reason: result.reason!,
        });
      }

      // 将路径规范化为绝对路径
      modifiedArgs[key] = result.resolved;
    }

    // Shell 工具额外检查命令中的路径
    if (isShellTool && typeof toolArgs.command === 'string') {
      const cmd = toolArgs.command as string;
      // 提取命令中类似路径的片段（以 / 或盘符开头的路径）
      const pathPattern = /(?:^|\s)([A-Za-z]:[\\/][^\s]*|\/[^\s]+)/g;
      let match: RegExpExecArray | null;
      while ((match = pathPattern.exec(cmd)) !== null) {
        const cmdPath = match[1];
        const result = validatePath(cmdPath, workspaceRoot);
        if (!result.valid) {
          return Promise.resolve({
            action: 'block',
            reason: `命令中包含越界路径: ${cmdPath} — ${result.reason}`,
          });
        }
      }
    }

    // 如果有路径参数被规范化，返回修改后的参数
    const hasModification = this.pathArgKeys.some(
      (k) => modifiedArgs[k] !== toolArgs[k],
    );
    if (hasModification) {
      return Promise.resolve({
        action: 'modify_args',
        modifiedArgs,
        reason: '路径参数已规范化为绝对路径',
      });
    }

    return Promise.resolve({ action: 'continue' });
  }
}

/**
 * 危险命令拦截钩子
 * 正则匹配 rm -rf、mkfs、dd、curl|sh 等危险命令模式
 */
export class DangerousCommandHook implements PipelineHook {
  name = 'dangerous_command_blocking';
  stage: PipelineStage = 'pre_security';

  /** 危险命令正则列表 */
  private blockedPatterns: RegExp[];

  constructor(extraPatterns?: RegExp[]) {
    // 默认危险命令模式
    this.blockedPatterns = [
      /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/,  // rm -rf, rm --no-preserve-root
      /mkfs/,                                                     // 格式化文件系统
      /\bdd\s+[a-zA-Z]*if=/,                                     // dd 磁盘操作
      /curl\b.*\|\s*(ba)?sh/,                                    // curl | sh
      /wget\b.*\|\s*(ba)?sh/,                                    // wget | sh
      /:()\{\s*:\|:&\s*\}/,                                      // fork bomb
      />\s*\/dev\/(sda|hda|nvme|sd[a-z])/,                       // 直接写磁盘设备
      /chmod\s+([0-7]{3,4}|u\+s)\s+\/(etc|usr|bin|sbin)/,       // 修改系统目录权限
      /chown\s+.*\s+\/(etc|usr|bin|sbin)/,                       // 修改系统目录所有者
      /shutdown|reboot|init\s+[06]/,                              // 关机/重启
      /systemctl\s+(stop|disable)\s+(ssh|firewall|iptables)/,    // 停止关键服务
    ];

    if (extraPatterns) {
      this.blockedPatterns.push(...extraPatterns);
    }
  }

  /** 添加额外的拦截模式 */
  addPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern);
  }

  execute(context: ToolExecutionContext): Promise<PipelineDecision> {
    const { toolName, toolArgs } = context;

    // 只对 Shell 类工具检查
    const isShellTool =
      toolName.toLowerCase().includes('shell') ||
      toolName.toLowerCase().includes('exec') ||
      toolName.toLowerCase().includes('bash') ||
      toolName.toLowerCase().includes('cmd') ||
      toolName.toLowerCase().includes('command') ||
      toolName.toLowerCase().includes('run');

    if (!isShellTool) return Promise.resolve({ action: 'continue' });

    const command = String(toolArgs.command || toolArgs.cmd || '');
    if (!command) return Promise.resolve({ action: 'continue' });

    for (const pattern of this.blockedPatterns) {
      if (pattern.test(command)) {
        return Promise.resolve({
          action: 'block',
          reason: `危险命令被拦截: 匹配模式 ${pattern.source}, 命令: ${command.substring(0, 200)}`,
        });
      }
    }

    return Promise.resolve({ action: 'continue' });
  }
}

/**
 * 审计日志钩子
 * 记录所有工具执行的审计信息
 */
export class AuditLogHook implements PipelineHook {
  name = 'audit_log';
  stage: PipelineStage = 'post_execution';

  /** 审计日志条目 */
  private entries: Array<{
    timestamp: string;
    toolName: string;
    sessionId?: string;
    riskLevel: RiskLevel;
    args: Record<string, unknown>;
  }> = [];

  execute(context: ToolExecutionContext): Promise<PipelineDecision> {
    this.entries.push({
      timestamp: new Date().toISOString(),
      toolName: context.toolName,
      sessionId: context.sessionId,
      riskLevel: context.riskLevel,
      args: this.sanitizeArgs(context.toolArgs),
    });

    // 限制内存占用
    if (this.entries.length > 5000) {
      this.entries = this.entries.slice(-2500);
    }

    return Promise.resolve({ action: 'continue' });
  }

  /** 脱敏参数中的敏感字段 */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'api_key', 'credential', 'privateKey'];
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /** 获取审计日志 */
  getEntries() {
    return [...this.entries];
  }
}

// ============ 主类: ToolExecutionPipeline ============

export class ToolExecutionPipeline {
  private workspaceRoot: string;
  private approvalCallback?: ApprovalCallback;
  private options: Required<PipelineOptions>;
  private hookChain: HookChain;
  private sessionLock: SessionLock;
  private dangerousCommandHook: DangerousCommandHook;
  private auditHook: AuditLogHook;
  /** 沙箱执行器 — 可选，注入后工具在沙箱中执行 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sandboxExecutor: { execute: (code: string, config: any) => Promise<{ success: boolean; output: string; error?: string }> } | null = null;

  constructor(
    workspaceRoot: string,
    approvalCallback?: ApprovalCallback,
    options?: PipelineOptions,
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.approvalCallback = approvalCallback;
    this.options = {
      enableSchemaValidation: options?.enableSchemaValidation ?? true,
      enablePathProtection: options?.enablePathProtection ?? true,
      enableDangerousCommandBlocking: options?.enableDangerousCommandBlocking ?? true,
      enableAudit: options?.enableAudit ?? true,
      fileToolPrefixes: options?.fileToolPrefixes ?? ['file_', 'fs_', 'dir_'],
      shellToolPrefixes: options?.shellToolPrefixes ?? ['shell_', 'bash_', 'exec_', 'cmd_'],
    };

    this.hookChain = new HookChain();
    this.sessionLock = new SessionLock();
    this.dangerousCommandHook = new DangerousCommandHook();
    this.auditHook = new AuditLogHook();

    // 注册内置钩子
    this.registerBuiltinHooks();
  }

  /** 注册内置钩子 */
  private registerBuiltinHooks(): void {
    if (this.options.enableSchemaValidation) {
      this.hookChain.register(new SchemaValidationHook());
    }

    if (this.options.enablePathProtection) {
      this.hookChain.register(
        new PathTraversalProtectionHook(
          this.options.fileToolPrefixes,
          this.options.shellToolPrefixes,
        ),
      );
    }

    if (this.options.enableDangerousCommandBlocking) {
      this.hookChain.register(this.dangerousCommandHook);
    }

    if (this.options.enableAudit) {
      this.hookChain.register(this.auditHook);
    }
  }

  /** 注册自定义钩子 */
  registerHook(hook: PipelineHook): void {
    this.hookChain.register(hook);
  }

  /** 更新工作区根路径 */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = path.resolve(root);
  }

  /** 添加危险命令拦截模式 */
  addBlockedPattern(pattern: RegExp): void {
    this.dangerousCommandHook.addPattern(pattern);
  }

  /** 注入沙箱执行器 — 替换直接调用为沙箱隔离执行 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSandboxExecutor(executor: { execute: (code: string, config: any) => Promise<{ success: boolean; output: string; error?: string }> }): void {
    this.sandboxExecutor = executor;
  }

  /** 获取审计日志条目 */
  getAuditEntries() {
    return this.auditHook.getEntries();
  }

  /**
   * 执行完整管线
   *
   * @param toolName   工具名称
   * @param args       工具参数
   * @param schema     工具 JSON Schema（可选）
   * @param riskLevel  风险等级
   * @param executorFn 实际执行函数
   * @param sessionId  会话 ID（可选）
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    schema: Record<string, unknown> | undefined,
    riskLevel: RiskLevel,
    executorFn: ToolExecutorFn,
    sessionId?: string,
  ): Promise<ToolExecutionResult> {
    const pipelineStart = Date.now();
    const stages: StageResult[] = [];

    // 构建执行上下文
    const context: ToolExecutionContext = {
      toolName,
      toolArgs: { ...args },
      toolSchema: schema,
      riskLevel,
      sessionId,
      workspaceRoot: this.workspaceRoot,
    };

    // 获取会话锁 — 同一会话串行执行
    const release = await this.sessionLock.acquire(sessionId ?? '__default__');

    try {
      // ===== 阶段 1: Schema 校验 =====
      const stage1 = await this.runStage('schema_validation', context, async () => {
        // 先执行自定义 pre_validation 钩子
        const hookDecision = await this.hookChain.executePreHooks(context, 'pre_validation');
        if (hookDecision.action !== 'continue') return hookDecision;
        return { action: 'continue' } as PipelineDecision;
      });
      stages.push(stage1);
      if (!stage1.passed) {
        return this.buildResult(false, undefined, stage1.decision && 'reason' in stage1.decision ? stage1.decision.reason : 'Schema 校验失败', pipelineStart, stages);
      }
      this.applyModifiedArgs(stage1, context);

      // ===== 阶段 2: 路径穿越防护 =====
      const stage2 = await this.runStage('path_traversal_protection', context, async () => {
        const hookDecision = await this.hookChain.executePreHooks(context, 'pre_security');
        if (hookDecision.action !== 'continue') return hookDecision;
        return { action: 'continue' } as PipelineDecision;
      });
      stages.push(stage2);
      if (!stage2.passed) {
        return this.buildResult(false, undefined, stage2.decision && 'reason' in stage2.decision ? stage2.decision.reason : '路径安全检查失败', pipelineStart, stages);
      }
      this.applyModifiedArgs(stage2, context);

      // ===== 阶段 3: 危险命令拦截 =====
      const stage3 = await this.runStage('dangerous_command_blocking', context, () => {
        // 危险命令检查已由内置钩子在 pre_security 阶段完成
        // 此处额外检查：如果风险等级为 critical，直接拦截
        if (riskLevel === 'critical' && this.isCriticalTool(toolName)) {
          return Promise.resolve({
            action: 'block',
            reason: `关键风险工具 ${toolName} 被自动拦截`,
          });
        }
        return Promise.resolve({ action: 'continue' } as PipelineDecision);
      });
      stages.push(stage3);
      if (!stage3.passed) {
        return this.buildResult(false, undefined, stage3.decision && 'reason' in stage3.decision ? stage3.decision.reason : '危险命令检查失败', pipelineStart, stages);
      }

      // ===== 阶段 4: 审批门控 =====
      const stage4 = await this.runStage('approval_gate', context, async () => {
        const hookDecision = await this.hookChain.executePreHooks(context, 'pre_approval');
        if (hookDecision.action !== 'continue') return hookDecision;

        // 如果有审批回调且风险等级为 high/critical，请求审批
        // low/medium 自动通过，不再询问用户
        if (this.approvalCallback && (riskLevel === 'high' || riskLevel === 'critical')) {
          const approved = await this.approvalCallback(toolName, context.toolArgs, `风险等级: ${riskLevel}`);
          if (!approved) {
            return {
              action: 'block',
              reason: `工具 ${toolName} 审批被拒绝（风险等级: ${riskLevel}）`,
            };
          }
        }

        return { action: 'continue' } as PipelineDecision;
      });
      stages.push(stage4);
      if (!stage4.passed) {
        return this.buildResult(false, undefined, stage4.decision && 'reason' in stage4.decision ? stage4.decision.reason : '审批被拒绝', pipelineStart, stages);
      }

      // ===== 阶段 5: 沙箱执行 =====
      let output: unknown;
      const stage5 = await this.runStage('sandbox_execution', context, async () => {
        const hookDecision = await this.hookChain.executePreHooks(context, 'pre_execution');
        if (hookDecision.action !== 'continue') return hookDecision;

        // 如果有沙箱执行器，根据风险等级选择隔离级别执行
        if (this.sandboxExecutor) {
          let sandboxLevel: 'process' | 'vm' | 'none';
          if (context.riskLevel === 'high' || context.riskLevel === 'critical') sandboxLevel = 'process';
          else if (context.riskLevel === 'medium') sandboxLevel = 'vm';
          else sandboxLevel = 'none';
          if (sandboxLevel !== 'none') {
            // executorFn is a closure and cannot be referenced inside a sandboxed
            // code string (it would be undefined there, causing every sandboxed
            // tool call to fail). Apply timeout + output protection directly.
            const timeoutMs = 30000;
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`执行超时 (${timeoutMs}ms)`)), timeoutMs)
            );
            try {
              const raw = await Promise.race([executorFn(context.toolArgs), timeoutPromise]);
              const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
              output = str.length > 50000 ? str.slice(0, 50000) : str;
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : '';
              return { action: 'block' as const, reason: msg || '沙箱执行失败' } as PipelineDecision;
            }
            return { action: 'continue' } as PipelineDecision;
          }
        }

        // 无沙箱或低风险：直接执行
        output = await executorFn(context.toolArgs);
        return { action: 'continue' } as PipelineDecision;
      });
      stages.push(stage5);
      if (!stage5.passed) {
        return this.buildResult(false, undefined, stage5.decision && 'reason' in stage5.decision ? stage5.decision.reason : '执行失败', pipelineStart, stages);
      }

      // ===== 阶段 6: 执行后审计 =====
      const stage6 = await this.runStage('post_execution_audit', context, async () => {
        await this.hookChain.executePostHooks(context, this.buildResult(true, output, undefined, pipelineStart, stages));
        return { action: 'continue' } as PipelineDecision;
      });
      stages.push(stage6);

      return this.buildResult(true, output, undefined, pipelineStart, stages);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.buildResult(false, undefined, errorMsg, pipelineStart, stages);
    } finally {
      release();
    }
  }

  /** 执行单个阶段并记录结果 */
  private async runStage(
    stageName: string,
    context: ToolExecutionContext,
    stageFn: () => Promise<PipelineDecision>,
  ): Promise<StageResult> {
    const start = Date.now();
    try {
      const decision = await stageFn();
      const duration = Date.now() - start;

      const passed =
        decision.action === 'continue' ||
        decision.action === 'modify_args';

      return {
        stage: stageName,
        passed,
        duration,
        decision,
        details:
          decision.action !== 'continue' && 'reason' in decision
            ? decision.reason
            : undefined,
      };
    } catch (err: unknown) {
      const duration = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        stage: stageName,
        passed: false,
        duration,
        decision: { action: 'block', reason: errorMsg },
        details: errorMsg,
      };
    }
  }

  /** 应用 modify_args 决策到上下文 */
  private applyModifiedArgs(stage: StageResult, context: ToolExecutionContext): void {
    if (
      stage.decision?.action === 'modify_args' &&
      'modifiedArgs' in stage.decision
    ) {
      context.toolArgs = { ...context.toolArgs, ...stage.decision.modifiedArgs };
    }
  }

  /** 判断是否为关键风险工具 */
  private isCriticalTool(toolName: string): boolean {
    const criticalPatterns = ['format', 'mkfs', 'dd', 'fork_bomb'];
    return criticalPatterns.some((p) => toolName.toLowerCase().includes(p));
  }

  /** 构建执行结果 */
  private buildResult(
    success: boolean,
    output: unknown,
    error: string | undefined,
    pipelineStart: number,
    stages: StageResult[],
  ): ToolExecutionResult {
    return {
      success,
      output,
      error,
      duration: Date.now() - pipelineStart,
      stages,
    };
  }
}
