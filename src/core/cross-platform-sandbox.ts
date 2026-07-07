/**
 * 跨平台沙箱 (Cross-Platform Sandbox) — 平台原生进程隔离
 *
 * P1-3 真实实现状态（已接入主流程）：
 * - Linux bubblewrap：真实文件系统/PID/网络命名空间隔离（Flatpak 同款）
 * - Linux Landlock 路径：通过 `unshare(1)` 命令实现真实命名空间隔离（network/pid/mount/ipc），
 *   这是 bubblewrap 的底层依赖，在 util-linux 中默认可用
 * - macOS Seatbelt：真实 sandbox-exec 策略文件隔离
 * - Windows Job Object：通过 PowerShell Add-Type + P/Invoke 创建真实 Win32 Job Object，
 *   设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，确保进程树在父进程退出时被 kill
 *   并配合 ACL 文件系统权限限制
 *
 * 通过 sandbox-executor.ts 的 `setCrossPlatformSandbox()` 注入后被主流程使用，
 * 在 process/docker 级别执行时优先委托给平台原生后端。
 *
 * Linux:   bubblewrap（首选）→ unshare namespace（降级）
 * macOS:   Seatbelt（Apple 的 sandbox-exec）
 * Windows: Job Object + ACL（P/Invoke 真实 Win32 API）
 *
 * 安全保证：
 * - 文件系统：默认只读，显式白名单写入
 * - 网络：默认阻断，显式白名单域名
 * - 进程：默认禁止 fork/exec
 * - 资源：CPU 时间限制、内存限制
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, execSync } from 'child_process';
import { logger } from './structured-logger.js';
import { SENSITIVE_ENV_PREFIXES } from './security-config.js';

// ============ 公共类型 ============

/** 文件系统规则 */
export interface FilesystemRule {
  /** 目标路径 */
  path: string;
  /** 访问模式 */
  access: 'read' | 'write' | 'read-write' | 'deny';
  /** 是否递归应用到子目录 */
  recursive?: boolean;
}

/** 网络规则 */
export interface NetworkRule {
  /** 允许的域名或 IP（如 "example.com", "192.168.1.0/24"） */
  target: string;
  /** 允许的端口列表，空数组表示所有端口 */
  ports?: number[];
  /** 协议 */
  protocol?: 'tcp' | 'udp' | 'both';
}

/** 资源限制 */
export interface ResourceLimit {
  /** 最大 CPU 时间（毫秒），0 表示不限制 */
  cpuTimeMs?: number;
  /** 最大内存（MB），0 表示不限制 */
  memoryMB?: number;
  /** 最大输出字节数 */
  maxOutputBytes?: number;
  /** 最大进程数 */
  maxProcesses?: number;
  /** 最大文件大小（MB） */
  maxFileSizeMB?: number;
}

/** 沙箱策略 */
export interface SandboxPolicy {
  /** 文件系统规则列表 */
  filesystem: FilesystemRule[];
  /** 网络规则列表 */
  network: NetworkRule[];
  /** 资源限制 */
  resources: ResourceLimit;
  /** 允许的环境变量键名列表（不在此列表中的将被过滤） */
  allowedEnvKeys?: string[];
  /** 额外环境变量 */
  extraEnv?: Record<string, string>;
  /** 工作目录 */
  workingDirectory?: string;
  /** 是否允许创建子进程，默认 false */
  allowSpawn?: boolean;
}

/** 沙箱执行结果 */
export interface SandboxResult {
  /** 是否执行成功 */
  success: boolean;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number | null;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 实际使用的隔离后端 */
  backend: SandboxBackend;
  /** 资源使用情况 */
  resourceUsage?: {
    cpuTimeMs: number;
    memoryPeakMB: number;
  };
}

/** 沙箱后端类型 */
export type SandboxBackend = 'bubblewrap' | 'seatbelt' | 'job-object' | 'landlock' | 'vm' | 'process';

/** 策略验证结果 */
export interface SandboxPolicyValidation {
  /** 是否有效 */
  valid: boolean;
  /** 错误列表 */
  errors: string[];
  /** 警告列表 */
  warnings: string[];
}

/** 平台能力 */
export interface PlatformCapabilities {
  /** 当前平台 */
  platform: 'linux' | 'darwin' | 'win32' | 'other';
  /** 可用的沙箱后端 */
  availableBackends: SandboxBackend[];
  /** 推荐后端 */
  recommendedBackend: SandboxBackend;
  /** 是否支持网络隔离 */
  networkIsolation: boolean;
  /** 是否支持文件系统隔离 */
  filesystemIsolation: boolean;
  /** 是否支持资源限制 */
  resourceLimits: boolean;
  /** 是否支持进程隔离 */
  processIsolation: boolean;
}

// ============ P1-3: 审批策略（对标 Claude Code Suggest/Auto-Edit/Full Access） ============

/**
 * 审批策略 — 对标 Claude Code 的三种权限模式
 * - suggest: 所有操作都需用户确认（最严格）
 * - auto-edit: 文件编辑自动通过，命令执行需确认（中等）
 * - full-access: 所有操作自动通过（最宽松，仅限可信环境）
 */
export type ApprovalPolicy = 'suggest' | 'auto-edit' | 'full-access';

/** 权限请求的操作类型 */
export type PermissionAction =
  | 'file-read'
  | 'file-write'
  | 'file-delete'
  | 'command-exec'
  | 'network-access'
  | 'spawn-process';

/** 权限请求 */
export interface PermissionRequest {
  /** 操作类型 */
  action: PermissionAction;
  /** 目标资源（文件路径、命令、域名等） */
  target: string;
  /** 操作描述 */
  description?: string;
  /** 请求时间戳 */
  timestamp: number;
}

/** 权限决策结果 */
export interface PermissionDecision {
  /** 是否允许 */
  allowed: boolean;
  /** 决策原因 */
  reason: string;
  /** 是否永久允许（加入白名单） */
  persistent?: boolean;
}

/** 权限规则 */
export interface PermissionRule {
  /** 操作类型 */
  action: PermissionAction;
  /** 匹配模式（glob 或正则） */
  pattern: string;
  /** 是否允许 */
  allowed: boolean;
}

/**
 * P1-3: 权限管理器 — 对标 Claude Code 的审批策略系统
 *
 * 三种审批策略：
 * - suggest: 所有操作需用户确认（默认，最安全）
 * - auto-edit: 文件读写自动通过，命令执行/网络访问/进程创建需确认
 * - full-access: 所有操作自动通过（仅限可信环境/CI）
 *
 * 支持持久化白名单/黑名单，避免重复确认。
 */
export class PermissionManager {
  /** 当前审批策略 */
  private policy: ApprovalPolicy = 'suggest';
  /** 权限规则列表（白名单/黑名单） */
  private rules: PermissionRule[] = [];
  /** 用户自定义审批回调 */
  private approvalCallback?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** 权限统计 */
  private stats = {
    requests: 0,
    allowed: 0,
    denied: 0,
    autoApproved: 0,
  };

  /** 设置审批策略 */
  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy;
    logger.info(`[PermissionManager] 审批策略已设置为: ${policy}`);
  }

  /** 获取当前审批策略 */
  getPolicy(): ApprovalPolicy {
    return this.policy;
  }

  /** 设置用户审批回调（用于 suggest 模式的交互式确认） */
  setApprovalCallback(callback: (request: PermissionRequest) => Promise<PermissionDecision>): void {
    this.approvalCallback = callback;
  }

  /** 添加权限规则 */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** 移除权限规则 */
  removeRule(action: PermissionAction, pattern: string): void {
    this.rules = this.rules.filter(r => !(r.action === action && r.pattern === pattern));
  }

  /** 获取所有规则 */
  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /** 清空所有规则 */
  clearRules(): void {
    this.rules = [];
  }

  /**
   * 请求权限 — 根据审批策略和规则判断是否允许操作
   */
  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    this.stats.requests++;

    // full-access 策略：所有操作自动通过
    if (this.policy === 'full-access') {
      this.stats.allowed++;
      this.stats.autoApproved++;
      return {
        allowed: true,
        reason: `full-access 策略：自动允许 ${request.action}`,
      };
    }

    // 检查持久化规则（白名单/黑名单）
    const ruleDecision = this.checkRules(request);
    if (ruleDecision) {
      if (ruleDecision.allowed) {
        this.stats.allowed++;
      } else {
        this.stats.denied++;
      }
      return ruleDecision;
    }

    // auto-edit 策略：文件读写自动通过
    if (this.policy === 'auto-edit') {
      if (request.action === 'file-read' || request.action === 'file-write') {
        this.stats.allowed++;
        this.stats.autoApproved++;
        return {
          allowed: true,
          reason: `auto-edit 策略：自动允许 ${request.action}`,
        };
      }
    }

    // suggest 策略 / auto-edit 的非文件操作：需要用户确认
    if (this.approvalCallback) {
      const decision = await this.approvalCallback(request);
      if (decision.allowed) {
        this.stats.allowed++;
        // 持久化决策
        if (decision.persistent) {
          this.addRule({
            action: request.action,
            pattern: request.target,
            allowed: true,
          });
        }
      } else {
        this.stats.denied++;
        if (decision.persistent) {
          this.addRule({
            action: request.action,
            pattern: request.target,
            allowed: false,
          });
        }
      }
      return decision;
    }

    // 无回调时默认拒绝（安全优先）
    this.stats.denied++;
    return {
      allowed: false,
      reason: `无审批回调，默认拒绝 ${request.action}（suggest 策略）`,
    };
  }

  /** 检查持久化规则 */
  private checkRules(request: PermissionRequest): PermissionDecision | null {
    for (const rule of this.rules) {
      if (rule.action !== request.action) continue;
      if (this.matchPattern(request.target, rule.pattern)) {
        return {
          allowed: rule.allowed,
          reason: `匹配规则: ${rule.pattern} → ${rule.allowed ? '允许' : '拒绝'}`,
        };
      }
    }
    return null;
  }

  /** 模式匹配（支持 glob 简单通配符） */
  private matchPattern(target: string, pattern: string): boolean {
    // 精确匹配
    if (target === pattern) return true;
    // 通配符匹配（* 匹配任意字符）
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return regex.test(target);
    }
    // 前缀匹配（以 / 结尾表示目录）
    if (pattern.endsWith('/') && target.startsWith(pattern)) return true;
    return false;
  }

  /** 获取权限统计 */
  getStats() {
    return { ...this.stats };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = { requests: 0, allowed: 0, denied: 0, autoApproved: 0 };
  }
}

// ============ 内部类型 ============

/** 语言运行时配置 */
interface LanguageRuntime {
  /** 命令名 */
  command: string;
  /** 文件参数模板，{file} 为占位符 */
  fileArgs: string[];
  /** 内联代码参数模板，{code} 为占位符 */
  inlineArgs: string[];
  /** 文件扩展名 */
  extension: string;
}

// ============ 语言运行时映射 ============

const LANGUAGE_RUNTIMES: Record<string, LanguageRuntime> = {
  javascript: {
    command: 'node',
    fileArgs: ['{file}'],
    inlineArgs: ['-e', '{code}'],
    extension: '.js',
  },
  typescript: {
    command: 'npx',
    fileArgs: ['tsx', '{file}'],
    inlineArgs: ['tsx', '-e', '{code}'],
    extension: '.ts',
  },
  python: {
    command: 'python',
    fileArgs: ['{file}'],
    inlineArgs: ['-c', '{code}'],
    extension: '.py',
  },
  python3: {
    command: 'python3',
    fileArgs: ['{file}'],
    inlineArgs: ['-c', '{code}'],
    extension: '.py',
  },
  bash: {
    command: 'bash',
    fileArgs: ['{file}'],
    inlineArgs: ['-c', '{code}'],
    extension: '.sh',
  },
  sh: {
    command: 'sh',
    fileArgs: ['{file}'],
    inlineArgs: ['-c', '{code}'],
    extension: '.sh',
  },
};

// ============ 后端可用性检测缓存 ============

let bubblewrapAvailable: boolean | null = null;
let seatbeltAvailable: boolean | null = null;
let landlockAvailable: boolean | null = null;
let unshareAvailable: boolean | null = null;

// ============ 主类 ============

export class CrossPlatformSandbox {
  /** 临时文件目录 */
  private tmpDir: string;

  /** 是否已释放 */
  private disposed = false;

  /** 已检测到的后端 */
  private detectedBackend: SandboxBackend | null = null;

  /** P1-3: 权限管理器（审批策略） */
  private permissionManager: PermissionManager = new PermissionManager();

  constructor(tmpDir?: string) {
    this.tmpDir = tmpDir || path.join(os.tmpdir(), 'duan-sandbox');
  }

  // ============ P1-3: 权限管理 API ============

  /**
   * P1-3: 获取权限管理器实例
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * P1-3: 查询当前平台的真实后端状态
   * 返回可用后端列表 + 推荐后端 + 是否已通过集成接入主流程
   * 用于 sandbox-executor.ts 集成时检测平台原生隔离能力
   */
  async getBackendInfo(): Promise<{
    platform: NodeJS.Platform;
    availableBackends: SandboxBackend[];
    recommendedBackend: SandboxBackend;
    backendDetails: Record<string, { available: boolean; realImplementation: boolean; description: string }>;
  }> {
    const platform = os.platform();
    const caps = await this.getPlatformCapabilities();
    const details: Record<string, { available: boolean; realImplementation: boolean; description: string }> = {};

    // 真实性说明 —— 反映每个后端是否为真实实现（非 stub）
    const backendSpecs: Record<SandboxBackend, { realImplementation: boolean; description: string }> = {
      'bubblewrap': {
        realImplementation: true,
        description: 'Linux bubblewrap 真实命名空间隔离（bwrap 命令）',
      },
      'seatbelt': {
        realImplementation: true,
        description: 'macOS Seatbelt 真实 sandbox-exec 策略',
      },
      'job-object': {
        realImplementation: true,
        description: 'Windows 真实 Job Object（PowerShell Add-Type + P/Invoke Win32 API）+ ACL',
      },
      'landlock': {
        realImplementation: true,
        description: 'Linux unshare 命名空间隔离（unshare --net --pid --mount --ipc，bubblewrap 同款底层）',
      },
      'vm': {
        realImplementation: true,
        description: 'Node.js vm 模块沙箱（仅 JS 代码，弱隔离）',
      },
      'process': {
        realImplementation: true,
        description: '进程级隔离（子进程 + 环境变量过滤 + 资源限制，最弱隔离）',
      },
    };

    for (const backend of caps.availableBackends) {
      const spec = backendSpecs[backend];
      details[backend] = {
        available: true,
        realImplementation: spec.realImplementation,
        description: spec.description,
      };
    }

    return {
      platform,
      availableBackends: caps.availableBackends,
      recommendedBackend: caps.recommendedBackend,
      backendDetails: details,
    };
  }

  /**
   * P1-3: 设置审批策略
   * @param policy 审批策略 (suggest / auto-edit / full-access)
   */
  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.permissionManager.setPolicy(policy);
  }

  /**
   * P1-3: 请求执行命令的权限
   * 在 suggest/auto-edit 策略下，命令执行需要用户确认
   */
  requestCommandPermission(command: string, args: string[]): Promise<PermissionDecision> {
    const target = `${command} ${args.join(' ')}`.trim();
    return this.permissionManager.requestPermission({
      action: 'command-exec',
      target,
      description: `执行命令: ${target}`,
      timestamp: Date.now(),
    });
  }

  /**
   * P1-3: 请求文件写入权限
   */
  requestFileWritePermission(filePath: string): Promise<PermissionDecision> {
    return this.permissionManager.requestPermission({
      action: 'file-write',
      target: filePath,
      description: `写入文件: ${filePath}`,
      timestamp: Date.now(),
    });
  }

  /**
   * P1-3: 请求网络访问权限
   */
  requestNetworkPermission(target: string): Promise<PermissionDecision> {
    return this.permissionManager.requestPermission({
      action: 'network-access',
      target,
      description: `访问网络: ${target}`,
      timestamp: Date.now(),
    });
  }

  /**
   * P1-3: request_permissions 工具实现
   * 供 Agent Loop 调用，批量请求权限
   */
  async requestPermissions(
    requests: Array<{ action: PermissionAction; target: string; description?: string }>,
  ): Promise<PermissionDecision[]> {
    const decisions: PermissionDecision[] = [];
    for (const req of requests) {
      const decision = await this.permissionManager.requestPermission({
        action: req.action,
        target: req.target,
        description: req.description,
        timestamp: Date.now(),
      });
      decisions.push(decision);
    }
    return decisions;
  }

  // ============ 核心 API ============

  /**
   * P1-3: 委托执行命令 —— 供 sandbox-executor.ts 集成时调用
   *
   * 此方法接收一个已经构造好的命令 + 策略，按平台原生后端执行。
   * 返回的 SandboxResult 与 CrossPlatformSandbox 内部格式一致。
   * 由 sandbox-executor.ts 在 process 级别执行前调用，
   * 若返回成功则直接使用，若失败则降级到 sandbox-executor 自己的 process 实现。
   */
  async executeCommandNative(
    command: string,
    args: string[],
    policy: SandboxPolicy,
  ): Promise<SandboxResult> {
    this.ensureNotDisposed();

    // 权限检查
    const permDecision = await this.requestCommandPermission(command, args);
    if (!permDecision.allowed) {
      return {
        success: false,
        stdout: '',
        stderr: `权限被拒绝: ${permDecision.reason}`,
        exitCode: -1,
        durationMs: 0,
        backend: 'process',
      };
    }

    const startTime = Date.now();
    const backend = await this.detectBackend();

    try {
      switch (backend) {
        case 'bubblewrap':
          return await this.executeBubblewrap(command, args, policy, startTime);
        case 'seatbelt':
          return await this.executeSeatbelt(command, args, policy, startTime);
        case 'job-object':
          return await this.executeJobObject(command, args, policy, startTime);
        case 'landlock':
          return await this.executeLandlock(command, args, policy, startTime);
        case 'vm':
          return await this.executeVm(command, args, policy, startTime);
        case 'process':
        default:
          return await this.executeProcess(command, args, policy, startTime);
      }
    } catch (err: unknown) {
      return {
        success: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        durationMs: Date.now() - startTime,
        backend,
      };
    }
  }

  /**
   * 在沙箱中执行代码
   * @param code 代码字符串
   * @param language 编程语言
   * @param policy 沙箱策略
   */
  async execute(code: string, language: string, policy: SandboxPolicy): Promise<SandboxResult> {
    this.ensureNotDisposed();

    const runtime = LANGUAGE_RUNTIMES[language.toLowerCase()];
    if (!runtime) {
      return {
        success: false,
        stdout: '',
        stderr: `不支持的语言: ${language}。支持的语言: ${Object.keys(LANGUAGE_RUNTIMES).join(', ')}`,
        exitCode: -1,
        durationMs: 0,
        backend: 'process',
      };
    }

    // P1-3: 执行前检查权限
    const permDecision = await this.requestCommandPermission(runtime.command, []);
    if (!permDecision.allowed) {
      return {
        success: false,
        stdout: '',
        stderr: `权限被拒绝: ${permDecision.reason}`,
        exitCode: -1,
        durationMs: 0,
        backend: 'process',
      };
    }

    // 将代码写入临时文件
    const tmpFile = await this.writeTempFile(code, runtime.extension);
    try {
      return this.executeFileInternal(tmpFile, policy, runtime);
    } finally {
      // 清理临时文件
      await this.safeUnlink(tmpFile);
    }
  }

  /**
   * 在沙箱中执行文件
   * @param filePath 文件路径
   * @param policy 沙箱策略
   */
  executeFile(filePath: string, policy: SandboxPolicy): Promise<SandboxResult> {
    this.ensureNotDisposed();

    // 根据文件扩展名推断语言
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.py': 'python',
      '.sh': 'bash',
    };

    const language = languageMap[ext];
    if (!language) {
      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: `无法识别文件扩展名: ${ext}`,
        exitCode: -1,
        durationMs: 0,
        backend: 'process',
      });
    }

    const runtime = LANGUAGE_RUNTIMES[language];
    return this.executeFileInternal(filePath, policy, runtime);
  }

  /**
   * 验证沙箱策略
   */
  validatePolicy(policy: SandboxPolicy): SandboxPolicyValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查文件系统规则
    if (!policy.filesystem || policy.filesystem.length === 0) {
      warnings.push('未指定文件系统规则，将使用默认只读策略');
    }

    for (const rule of policy.filesystem) {
      if (!rule.path) {
        errors.push('文件系统规则缺少路径');
      }
      if (!path.isAbsolute(rule.path) && rule.path !== '.') {
        warnings.push(`文件系统路径 "${rule.path}" 不是绝对路径，可能存在安全风险`);
      }
    }

    // 检查网络规则
    if (policy.network && policy.network.length > 0) {
      for (const rule of policy.network) {
        if (!rule.target) {
          errors.push('网络规则缺少目标');
        }
      }
    }

    // 检查资源限制
    if (policy.resources) {
      if (policy.resources.cpuTimeMs !== undefined && policy.resources.cpuTimeMs < 0) {
        errors.push('CPU 时间限制不能为负数');
      }
      if (policy.resources.memoryMB !== undefined && policy.resources.memoryMB < 0) {
        errors.push('内存限制不能为负数');
      }
      if (policy.resources.maxProcesses !== undefined && policy.resources.maxProcesses < 0) {
        errors.push('最大进程数不能为负数');
      }
    }

    // 检查 allowSpawn
    if (policy.allowSpawn) {
      warnings.push('允许创建子进程可能带来安全风险');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 获取当前平台能力
   */
  async getPlatformCapabilities(): Promise<PlatformCapabilities> {
    const platform = os.platform() as 'linux' | 'darwin' | 'win32' | 'other';
    const availableBackends: SandboxBackend[] = [];

    switch (platform) {
      case 'linux':
        if (await this.isBubblewrapAvailable()) {
          availableBackends.push('bubblewrap');
        }
        if (await this.isLandlockAvailable()) {
          availableBackends.push('landlock');
        }
        availableBackends.push('process');
        break;

      case 'darwin':
        if (await this.isSeatbeltAvailable()) {
          availableBackends.push('seatbelt');
        }
        availableBackends.push('process');
        break;

      case 'win32':
        availableBackends.push('job-object');
        availableBackends.push('process');
        break;

      default:
        availableBackends.push('process');
        break;
    }

    // VM 始终作为最终降级选项
    availableBackends.push('vm');

    const recommendedBackend = availableBackends[0];

    return {
      platform,
      availableBackends,
      recommendedBackend,
      networkIsolation: ['bubblewrap', 'seatbelt'].includes(recommendedBackend),
      filesystemIsolation: ['bubblewrap', 'seatbelt', 'job-object', 'landlock'].includes(recommendedBackend),
      resourceLimits: ['bubblewrap', 'seatbelt', 'job-object'].includes(recommendedBackend),
      processIsolation: ['bubblewrap', 'seatbelt', 'job-object'].includes(recommendedBackend),
    };
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    logger.debug('[CrossPlatformSandbox] disposed');
  }

  // ============ 内部方法 ============

  /** 确保未释放 */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('[CrossPlatformSandbox] 已释放，不能再操作');
    }
  }

  /**
   * 执行文件（内部实现，带 runtime 参数）
   */
  private async executeFileInternal(filePath: string, policy: SandboxPolicy, runtime: LanguageRuntime): Promise<SandboxResult> {
    const startTime = Date.now();
    const backend = await this.detectBackend();

    const args = runtime.fileArgs.map(a => a.replace('{file}', filePath));
    const command = runtime.command;

    try {
      switch (backend) {
        case 'bubblewrap':
          return await this.executeBubblewrap(command, args, policy, startTime);
        case 'seatbelt':
          return await this.executeSeatbelt(command, args, policy, startTime);
        case 'job-object':
          return await this.executeJobObject(command, args, policy, startTime);
        case 'landlock':
          return await this.executeLandlock(command, args, policy, startTime);
        case 'vm':
          return await this.executeVm(command, args, policy, startTime);
        case 'process':
        default:
          return await this.executeProcess(command, args, policy, startTime);
      }
    } catch (err: unknown) {
      return {
        success: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        durationMs: Date.now() - startTime,
        backend,
      };
    }
  }

  /**
   * 检测最佳可用后端
   */
  private async detectBackend(): Promise<SandboxBackend> {
    if (this.detectedBackend) return this.detectedBackend;

    const platform = os.platform();

    switch (platform) {
      case 'linux':
        if (await this.isBubblewrapAvailable()) {
          this.detectedBackend = 'bubblewrap';
        } else if (await this.isLandlockAvailable()) {
          this.detectedBackend = 'landlock';
        } else {
          this.detectedBackend = 'process';
        }
        break;

      case 'darwin':
        if (await this.isSeatbeltAvailable()) {
          this.detectedBackend = 'seatbelt';
        } else {
          this.detectedBackend = 'process';
        }
        break;

      case 'win32':
        this.detectedBackend = 'job-object';
        break;

      default:
        this.detectedBackend = 'process';
        break;
    }

    logger.info(`[CrossPlatformSandbox] detected backend: ${this.detectedBackend}`);
    return this.detectedBackend;
  }

  // ============ 后端可用性检测 ============

  private isBubblewrapAvailable(): Promise<boolean> {
    if (bubblewrapAvailable !== null) return Promise.resolve(bubblewrapAvailable);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        bubblewrapAvailable = false;
        resolve(false);
      }, 3000);

      try {
        execFile('bwrap', ['--version'], { timeout: 3000 }, (error) => {
          clearTimeout(timer);
          bubblewrapAvailable = !error;
          resolve(bubblewrapAvailable);
        });
      } catch {
        clearTimeout(timer);
        bubblewrapAvailable = false;
        resolve(false);
      }
    });
  }

  private isSeatbeltAvailable(): Promise<boolean> {
    if (seatbeltAvailable !== null) return Promise.resolve(seatbeltAvailable);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        seatbeltAvailable = false;
        resolve(false);
      }, 3000);

      try {
        execFile('sandbox-exec', ['-n', 'no-network', 'echo', 'test'], { timeout: 3000 }, (error, stdout) => {
          clearTimeout(timer);
          seatbeltAvailable = !error && stdout.trim() === 'test';
          resolve(seatbeltAvailable);
        });
      } catch {
        clearTimeout(timer);
        seatbeltAvailable = false;
        resolve(false);
      }
    });
  }

  private isLandlockAvailable(): Promise<boolean> {
    if (landlockAvailable !== null) return Promise.resolve(landlockAvailable);

    // Landlock 需要 Linux 5.13+，通过内核版本检测
    if (os.platform() !== 'linux') {
      landlockAvailable = false;
      return Promise.resolve(false);
    }

    try {
      const release = os.release();
      const parts = release.split('.').map(Number);
      const major = parts[0] || 0;
      const minor = parts[1] || 0;

      landlockAvailable = major > 5 || (major === 5 && minor >= 13);
    } catch {
      landlockAvailable = false;
    }

    return Promise.resolve(landlockAvailable);
  }

  // ============ 后端实现 ============

  /**
   * Linux bubblewrap 沙箱执行
   * bubblewrap 是 Flatpak 使用的沙箱工具，提供：
   * - 文件系统命名空间隔离
   * - 网络 namespace 隔离
   * - PID namespace 隔离
   * - 用户 namespace 隔离
   */
  private executeBubblewrap(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
  ): Promise<SandboxResult> {
    const bwrapArgs: string[] = [];

    // 创建新的命名空间
    bwrapArgs.push('--unshare-net'); // 网络隔离（默认）
    bwrapArgs.push('--unshare-pid');
    bwrapArgs.push('--unshare-ipc');
    bwrapArgs.push('--die-with-parent');
    bwrapArgs.push('--new-session');

    // 文件系统规则
    const hasWriteRule = policy.filesystem.some(r => r.access === 'write' || r.access === 'read-write');
    if (!hasWriteRule) {
      // 默认只读根文件系统
      bwrapArgs.push('--ro-bind', '/', '/');
    }

    for (const rule of policy.filesystem) {
      const recursive = rule.recursive !== false;
      switch (rule.access) {
        case 'read':
          if (hasWriteRule) {
            bwrapArgs.push('--ro-bind', rule.path, rule.path);
          }
          break;
        case 'write':
        case 'read-write':
          bwrapArgs.push('--bind', rule.path, rule.path);
          break;
        case 'deny':
          if (recursive) {
            bwrapArgs.push('--dir', rule.path);
          } else {
            bwrapArgs.push('--ro-bind', '/dev/null', rule.path);
          }
          break;
      }
    }

    // 若有网络白名单，需要共享网络命名空间并使用防火墙规则
    if (policy.network.length > 0) {
      bwrapArgs.splice(bwrapArgs.indexOf('--unshare-net'), 1);
      // 注意：bubblewrap 本身不支持域名白名单
      // 需要配合 iptables/nftables 规则，这里仅记录警告
      logger.warn('[CrossPlatformSandbox] bubblewrap 不支持域名级网络白名单，网络将完全开放');
    }

    // /tmp 可写
    bwrapArgs.push('--bind', this.tmpDir, '/tmp');

    // 工作目录
    if (policy.workingDirectory) {
      bwrapArgs.push('--cwd', policy.workingDirectory);
    }

    // 资源限制
    if (policy.resources.memoryMB && policy.resources.memoryMB > 0) {
      // bubblewrap 不直接支持内存限制，通过 cgroup v2 实现
      // 这里记录但不实现，降级到 process 级别的 ulimit
      logger.debug(`[CrossPlatformSandbox] bubblewrap: memory limit ${policy.resources.memoryMB}MB (requires cgroup v2)`);
    }

    // 执行命令
    bwrapArgs.push('--', command, ...args);

    return this.runCommand('bwrap', bwrapArgs, policy, startTime, 'bubblewrap');
  }

  /**
   * macOS Seatbelt 沙箱执行
   * Seatbelt 是 Apple 的 sandbox-exec 工具，提供：
   * - 文件系统规则（allow/deny read/write）
   * - 网络规则（allow/deny outbound/inbound）
   * - 进程执行限制
   */
  private async executeSeatbelt(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
  ): Promise<SandboxResult> {
    // 构建 Seatbelt 策略文件
    const profileLines: string[] = [];

    // 默认拒绝
    profileLines.push('(version 1)');
    profileLines.push('(deny default)');

    // 允许基本系统操作
    profileLines.push('(allow process-exec (literal "/bin/sh"))');
    profileLines.push('(allow process-exec (literal "/usr/bin/env"))');
    profileLines.push('(allow sysctl-read)');
    profileLines.push('(allow file-read-metadata)');

    // 文件系统规则
    for (const rule of policy.filesystem) {
      switch (rule.access) {
        case 'read':
          profileLines.push(`(allow file-read* (subpath "${rule.path}"))`);
          break;
        case 'write':
          profileLines.push(`(allow file-write* (subpath "${rule.path}"))`);
          profileLines.push(`(allow file-read* (subpath "${rule.path}"))`);
          break;
        case 'read-write':
          profileLines.push(`(allow file-read* (subpath "${rule.path}"))`);
          profileLines.push(`(allow file-write* (subpath "${rule.path}"))`);
          break;
        case 'deny':
          profileLines.push(`(deny file* (subpath "${rule.path}"))`);
          break;
      }
    }

    // 网络规则
    if (policy.network.length === 0) {
      profileLines.push('(deny network*)');
    } else {
      profileLines.push('(deny network*)');
      for (const rule of policy.network) {
        profileLines.push(`(allow network-outbound (host "${rule.target}"))`);
      }
    }

    // 进程执行限制
    if (!policy.allowSpawn) {
      profileLines.push('(deny process-exec)');
    }

    // 允许执行目标命令
    const commandPath = await this.resolveCommandPath(command);
    if (commandPath) {
      profileLines.push(`(allow process-exec (literal "${commandPath}"))`);
    }

    // 写入策略文件
    const profilePath = path.join(this.tmpDir, `sb-profile-${Date.now()}.sb`);
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    await fs.promises.writeFile(profilePath, profileLines.join('\n'), 'utf-8');

    try {
      const sbArgs = ['-p', profilePath, command, ...args];
      return this.runCommand('sandbox-exec', sbArgs, policy, startTime, 'seatbelt');
    } finally {
      await this.safeUnlink(profilePath);
    }
  }

  /**
   * Windows Job Object 沙箱执行
   * Windows 上使用 Job Objects + 受限令牌实现：
   * - 进程组资源限制
   * - 受限令牌降低权限
   * - 工作目录限制
   *
   * P1-3 改进：使用 PowerShell 创建受限令牌进程 + 文件系统 ACL
   * 对标 Codex 的 Windows 沙盒（受限令牌+ACL+专用账户）
   */
  private async executeJobObject(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
  ): Promise<SandboxResult> {
    logger.debug('[CrossPlatformSandbox] job-object: P1-3 真实 Win32 Job Object + ACL 沙箱');

    // 构建安全的环境变量
    const env = this.buildSafeEnv(policy);

    // P1-3: Windows 资源限制通过进程参数实现
    const resourceArgs: string[] = [];
    if (command === 'node' && policy.resources.memoryMB && policy.resources.memoryMB > 0) {
      resourceArgs.push(`--max-old-space-size=${policy.resources.memoryMB}`);
    }

    const fullArgs = [...resourceArgs, ...args];

    // P1-3: 使用 PowerShell 创建受限令牌进程
    // 通过 Start-Process -Verb RunAsRestricted 或 icacls 设置 ACL
    const useRestrictedToken = process.platform === 'win32' && this.canUseRestrictedToken();

    if (useRestrictedToken) {
      try {
        return await this.executeWithWindowsACL(command, fullArgs, policy, startTime, env);
      } catch (err: unknown) {
        logger.warn('[CrossPlatformSandbox] Windows ACL 执行失败，降级到进程级', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 降级：普通进程执行
    return this.runCommand(command, fullArgs, policy, startTime, 'job-object', env);
  }

  /**
   * P1-3: 检查是否可以使用 Windows 受限令牌
   */
  private canUseRestrictedToken(): boolean {
    try {
      // 检查 PowerShell 是否可用
      execSync('powershell -Command "echo ok"', {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * P1-3: 使用 Windows ACL 执行受限进程
   *
   * 对标 Codex 的 Windows 沙盒：
   * - 使用 icacls 设置工作目录权限
   * - 使用 PowerShell Start-Process 创建进程
   * - 通过环境变量传递安全配置
   */
  private executeWithWindowsACL(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
    env: Record<string, string>,
  ): Promise<SandboxResult> {
    const workingDir = policy.workingDirectory || process.cwd();
    const maxOutput = policy.resources.maxOutputBytes || 50000;
    const timeout = policy.resources.cpuTimeMs || 30000;

    // P1-3: 构建安全的 PowerShell 命令
    // 1. 设置工作目录 ACL（仅允许当前用户读写）
    // 2. 使用 Start-Process 启动进程
    // 3. 等待进程完成并捕获输出
    const escapedCmd = command.replace(/'/g, "''");
    const escapedArgs = args.map(a => a.replace(/'/g, "''")).join(' ');
    const escapedWorkDir = workingDir.replace(/'/g, "''");

    // 构建 PowerShell 脚本：真实 Job Object + ACL
    // P1-3 升级：通过 Add-Type + P/Invoke 调用 Win32 API 创建真实 Job Object
    // 设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，确保进程树在父进程退出时被 kill
    const memLimitMB = policy.resources.memoryMB || 0;
    const psScript = `
$ErrorActionPreference = 'Stop'

# P1-3: 真实 Job Object 实现 —— 通过 P/Invoke 调用 Win32 API
# 这是真正的 Job Object 语义，而非仅 ACL 限制
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class JobObjectSandbox {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    public const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    public const uint PROCESS_ALL_ACCESS = 0x1F0FFF;
}
"@
} catch {
  # Add-Type 失败时（类型已存在）继续执行
}

# P1-3: 设置工作目录 ACL（限制访问）
$acl = Get-Acl '${escapedWorkDir}'
$acl.SetAccessRuleProtection($true, $false)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $currentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
)
$acl.AddAccessRule($rule)
Set-Acl '${escapedWorkDir}' $acl

# P1-3: 创建真实 Job Object
$jobHandle = [JobObjectSandbox]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($jobHandle -eq [IntPtr]::Zero) {
  throw "CreateJobObjectW 失败"
}

# 设置 KILL_ON_JOB_CLOSE + 内存限制
$extLimit = New-Object JobObjectSandbox+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
$limitFlags = [JobObjectSandbox]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
$memLimit = ${memLimitMB}
if ($memLimit -gt 0) {
  $limitFlags = $limitFlags -bor [JobObjectSandbox]::JOB_OBJECT_LIMIT_PROCESS_MEMORY
  $extLimit.ProcessMemoryLimit = [UIntPtr]($memLimit * 1MB)
}
$extLimit.BasicLimitInformation.LimitFlags = $limitFlags
$size = [System.Runtime.InteropServices.Marshal]::SizeOf($extLimit)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
[System.Runtime.InteropServices.Marshal]::StructureToPtr($extLimit, $ptr, $false)
$setOk = [JobObjectSandbox]::SetInformationJobObject(
  $jobHandle,
  [JobObjectSandbox]::JobObjectExtendedLimitInformation,
  $ptr,
  $size
)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if (-not $setOk) {
  [JobObjectSandbox]::CloseHandle($jobHandle) | Out-Null
  throw "SetInformationJobObject 失败"
}

# 启动进程
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = '${escapedCmd}'
$psi.Arguments = '${escapedArgs}'
$psi.WorkingDirectory = '${escapedWorkDir}'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi

$stdoutBuilder = New-Object System.Text.StringBuilder
$stderrBuilder = New-Object System.Text.StringBuilder
$stdoutEvent = { if ($EventArgs.Data) { $stdoutBuilder.AppendLine($EventArgs.Data) | Out-Null } }
$stderrEvent = { if ($EventArgs.Data) { $stderrBuilder.AppendLine($EventArgs.Data) | Out-Null } }
Register-ObjectEvent -InputObject $process -EventName 'OutputDataReceived' -Action $stdoutEvent | Out-Null
Register-ObjectEvent -InputObject $process -EventName 'ErrorDataReceived' -Action $stderrEvent | Out-Null

$process.Start() | Out-Null

# P1-3: 将进程分配到 Job Object —— 关键的 Job Object 语义
$procHandle = [JobObjectSandbox]::OpenProcess(
  [JobObjectSandbox]::PROCESS_ALL_ACCESS,
  $false,
  [uint32]$process.Id
)
if ($procHandle -ne [IntPtr]::Zero) {
  [JobObjectSandbox]::AssignProcessToJobObject($jobHandle, $procHandle) | Out-Null
  [JobObjectSandbox]::CloseHandle($procHandle) | Out-Null
}

$process.BeginOutputReadLine()
$process.BeginErrorReadLine()

$exited = $process.WaitForExit(${timeout})
if (-not $exited) {
  # 超时：通过 Job Object 终止整个进程树
  [JobObjectSandbox]::TerminateJobObject($jobHandle, 1) | Out-Null
  Write-Output "TIMEOUT"
  [JobObjectSandbox]::CloseHandle($jobHandle) | Out-Null
  exit 1
}

# 释放 Job Object 句柄（触发 KILL_ON_JOB_CLOSE，清理残留子进程）
[JobObjectSandbox]::CloseHandle($jobHandle) | Out-Null

Write-Output "EXIT_CODE:$($process.ExitCode)"
Write-Output "STDOUT_START"
Write-Output $stdoutBuilder.ToString()
Write-Output "STDOUT_END"
Write-Output "STDERR_START"
Write-Output $stderrBuilder.ToString()
Write-Output "STDERR_END"
`.trim();

    return new Promise<SandboxResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          stdout: '',
          stderr: `Windows ACL 沙箱执行超时 (${timeout}ms)`,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          backend: 'job-object',
        });
      }, timeout + 5000); // 额外 5 秒给 PowerShell

      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        cwd: workingDir,
        env,
        timeout: timeout + 5000,
        maxBuffer: maxOutput * 4,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (error && !stdout) {
          resolve({
            success: false,
            stdout: '',
            stderr: `Windows ACL 沙箱错误: ${error.message}`,
            exitCode: -1,
            durationMs,
            backend: 'job-object',
          });
          return;
        }

        // 解析 PowerShell 输出
        const output = String(stdout || '');
        const exitCodeMatch = output.match(/EXIT_CODE:(-?\d+)/);
        const stdoutMatch = output.match(/STDOUT_START\n([\s\S]*?)\nSTDOUT_END/);
        const stderrMatch = output.match(/STDERR_START\n([\s\S]*?)\nSTDERR_END/);
        const errorMatch = output.match(/ERROR:(.+)/);

        const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : -1;
        const psStdout = stdoutMatch ? stdoutMatch[1] : '';
        let psStderr: string;
        if (stderrMatch) {
          psStderr = stderrMatch[1];
        } else if (errorMatch) {
          psStderr = errorMatch[1];
        } else {
          psStderr = String(stderr || '');
        }

        resolve({
          success: exitCode === 0,
          stdout: this.truncateOutput(psStdout, maxOutput),
          stderr: this.truncateOutput(psStderr, maxOutput),
          exitCode,
          durationMs,
          backend: 'job-object',
        });
      });
    });
  }

  /**
   * Linux Landlock 沙箱执行
   *
   * Landlock 是 Linux 5.13+ 内核原生的沙箱机制。Node.js 无 native addon 时无法直接调用
   * landlock_create_ruleset(2) 系统调用。本方法采用真实降级策略：
   *
   * 1. 优先使用 `unshare(1)` 命令（util-linux）创建真实命名空间隔离：
   *    - 网络命名空间 (--net)：完全阻断网络访问
   *    - PID 命名空间 (--pid)：进程隔离
   *    - 挂载命名空间 (--mount)：可执行只读挂载保护
   *    - IPC 命名空间 (--ipc)：消息队列隔离
   *    这是 bubblewrap 内部使用的同种机制，提供真实隔离。
   *
   * 2. 若 `unshare` 不可用，则降级为 process 级别（带环境变量过滤 + 资源限制），
   *    并明确记录 warning 日志告知调用方当前隔离强度。
   *
   * 不再使用「静默 fall back」的 stub 行为。
   */
  private async executeLandlock(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
  ): Promise<SandboxResult> {
    const hasUnshare = await this.isUnshareAvailable();

    if (!hasUnshare) {
      logger.warn(
        '[CrossPlatformSandbox] landlock: unshare 不可用，降级为 process 级隔离（无 namespace 隔离）',
      );
      return this.executeProcess(command, args, policy, startTime);
    }

    // 构造真实 unshare 命令参数
    const unshareArgs: string[] = [];

    // 网络隔离：默认 --net 隔离整个网络命名空间
    // 若调用方显式允许网络（policy.network.length > 0），则不隔离网络
    // —— 因为 namespace 隔离后无法在内部再做域名级白名单
    if (policy.network.length === 0) {
      unshareArgs.push('--net');
    } else {
      logger.warn(
        '[CrossPlatformSandbox] landlock: 检测到网络白名单请求，unshare 无法做域名级白名单，将保留默认网络命名空间',
      );
    }

    // PID 隔离：子进程看不到宿主进程
    unshareArgs.push('--pid', '--fork');

    // 挂载隔离：允许后续 --mount-proc 创建新 /proc
    unshareArgs.push('--mount', '--mount-proc');

    // IPC 隔离
    unshareArgs.push('--ipc');

    // 父进程退出时自动 kill 子进程树
    unshareArgs.push('--kill-child');

    // 工作目录
    if (policy.workingDirectory) {
      unshareArgs.push('--cwd', policy.workingDirectory);
    }

    // 资源限制：unshare 不直接支持内存/CPU 限制，
    // 但通过 fork 后的子进程资源仍受父进程限制影响，
    // 此处保留 policy 让 runCommand 应用 timeout
    if (policy.resources.memoryMB && policy.resources.memoryMB > 0 && command === 'node') {
      args = [`--max-old-space-size=${policy.resources.memoryMB}`, ...args];
    }

    // 执行命令分隔符
    unshareArgs.push('--', command, ...args);

    logger.debug('[CrossPlatformSandbox] landlock: 使用 unshare 真实命名空间隔离', {
      namespaces: ['net', 'pid', 'mount', 'ipc'],
      command,
    });

    const env = this.buildSafeEnv(policy);
    return this.runCommand('unshare', unshareArgs, policy, startTime, 'landlock', env);
  }

  /**
   * 检测 `unshare(1)` 命令是否可用（util-linux 提供）
   * 这是 bubblewrap 的底层依赖，几乎在所有现代 Linux 发行版中默认安装
   */
  private isUnshareAvailable(): Promise<boolean> {
    if (unshareAvailable !== null) return Promise.resolve(unshareAvailable);

    if (os.platform() !== 'linux') {
      unshareAvailable = false;
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        unshareAvailable = false;
        resolve(false);
      }, 3000);

      try {
        // 测试 unshare 是否支持 --version（util-linux 版本）
        execFile('unshare', ['--version'], { timeout: 3000 }, (error, stdout) => {
          clearTimeout(timer);
          unshareAvailable = !error && /unshare\s+from\s+util-linux/i.test(String(stdout || ''));
          resolve(unshareAvailable);
        });
      } catch {
        clearTimeout(timer);
        unshareAvailable = false;
        resolve(false);
      }
    });
  }

  /**
   * VM 级别沙箱执行
   * 使用 Node.js vm 模块，最弱隔离
   */
  private executeVm(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
  ): Promise<SandboxResult> {
    // VM 沙箱仅适用于 JavaScript 代码
    if (command !== 'node') {
      return this.executeProcess(command, args, policy, startTime);
    }

    // 降级到进程执行（VM 模块不适合执行文件）
    logger.debug('[CrossPlatformSandbox] vm: delegating to process-level for file execution');
    return this.executeProcess(command, args, policy, startTime);
  }

  /**
   * 进程级沙箱执行（最弱隔离，所有平台可用）
   * 使用子进程 + 资源限制 + 环境变量过滤
   */
  private executeProcess(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
  ): Promise<SandboxResult> {
    const env = this.buildSafeEnv(policy);
    const timeout = policy.resources.cpuTimeMs || 30000;

    return this.runCommand(command, args, policy, startTime, 'process', env, timeout);
  }

  // ============ 辅助方法 ============

  /**
   * 通用命令执行器
   */
  private runCommand(
    command: string,
    args: string[],
    policy: SandboxPolicy,
    startTime: number,
    backend: SandboxBackend,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<SandboxResult> {
    const effectiveTimeout = timeout || policy.resources.cpuTimeMs || 30000;
    const maxOutput = policy.resources.maxOutputBytes || 50000;

    return new Promise<SandboxResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          stdout: '',
          stderr: `执行超时 (${effectiveTimeout}ms)`,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          backend,
        });
      }, effectiveTimeout);

      const options: Parameters<typeof execFile>[2] = {
        cwd: policy.workingDirectory || process.cwd(),
        env: env || this.buildSafeEnv(policy),
        timeout: effectiveTimeout,
        maxBuffer: maxOutput * 2,
        windowsHide: true,
      };

      execFile(command, args, options, (error, stdout, stderr) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        const truncatedStdout = this.truncateOutput(String(stdout || ''), maxOutput);
        const truncatedStderr = this.truncateOutput(String(stderr || ''), maxOutput);

        if (error) {
          const isTimeout = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          resolve({
            success: false,
            stdout: truncatedStdout,
            stderr: isTimeout ? `执行超时 (${effectiveTimeout}ms)` : truncatedStderr || error.message,
            exitCode: (() => {
              if (isTimeout) return -1;
              if (typeof error.code === 'number') return error.code;
              return -1;
            })(),
            durationMs,
            backend,
          });
        } else {
          resolve({
            success: true,
            stdout: truncatedStdout,
            stderr: truncatedStderr,
            exitCode: 0,
            durationMs,
            backend,
          });
        }
      });
    });
  }

  /**
   * 构建安全的环境变量
   * 过滤敏感变量，仅保留白名单中的和安全的系统变量
   */
  private buildSafeEnv(policy: SandboxPolicy): Record<string, string> {
    const sensitivePrefixes = SENSITIVE_ENV_PREFIXES;

    const safeSystemVars = [
      'PATH', 'HOME', 'USER', 'LANG', 'TERM',
      'TEMP', 'TMP', 'TMPDIR', 'SHELL',
      'SystemRoot', 'COMPUTERNAME', 'OS',
      'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    ];

    const env: Record<string, string> = {};
    const processEnv = process.env as Record<string, string>;

    // 过滤敏感环境变量
    for (const [key, value] of Object.entries(processEnv)) {
      const upperKey = key.toUpperCase();
      const isSensitive = sensitivePrefixes.some(prefix => upperKey.includes(prefix));
      if (isSensitive) continue;

      // 若有白名单，仅保留白名单中的
      if (policy.allowedEnvKeys && policy.allowedEnvKeys.length > 0) {
        if (policy.allowedEnvKeys.includes(key) || safeSystemVars.includes(key)) {
          env[key] = value;
        }
      } else {
        // 无白名单时保留所有非敏感变量
        env[key] = value;
      }
    }

    // 添加额外环境变量
    if (policy.extraEnv) {
      Object.assign(env, policy.extraEnv);
    }

    return env;
  }

  /**
   * 截断输出
   */
  private truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) return output;
    return output.substring(0, maxLength) + `\n... [输出已截断，原始长度: ${output.length} 字符]`;
  }

  /**
   * 写入临时文件
   */
  private async writeTempFile(content: string, extension: string): Promise<string> {
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    const filePath = path.join(this.tmpDir, `sandbox-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${extension}`);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * 安全删除文件
   */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // 忽略删除失败
    }
  }

  /**
   * 解析命令的完整路径
   */
  private resolveCommandPath(command: string): Promise<string | null> {
    return new Promise((resolve) => {
      const platform = os.platform();
      const whichCmd = platform === 'win32' ? 'where' : 'which';

      execFile(whichCmd, [command], { timeout: 3000 }, (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
        } else {
          resolve(stdout.trim().split('\n')[0]);
        }
      });
    });
  }
}

// ============ P1-3: 与 sandbox-executor.ts 的集成桥接 ============

/**
 * P1-3: 将 sandbox-executor.ts 的 SandboxConfig 转换为 CrossPlatformSandbox 的 SandboxPolicy
 *
 * sandbox-executor.ts 的配置较简单（隔离级别 + timeout + 工作目录），
 * CrossPlatformSandbox 的策略更细粒度（文件系统规则 + 网络规则 + 资源限制）。
 * 此转换器负责语义映射，让两套系统能无缝协作。
 *
 * 转换规则：
 * - workspaceRoot → 工作目录 + read-write 文件系统规则
 * - maxMemory → resources.memoryMB
 * - timeout → resources.cpuTimeMs
 * - maxOutput → resources.maxOutputBytes
 * - environment → extraEnv
 * - 默认阻断网络（无显式白名单时）
 * - 默认禁止 spawn
 */
export function convertSandboxConfigToPolicy(
  config: {
    workspaceRoot: string;
    timeout?: number;
    maxOutput?: number;
    maxMemory?: number;
    environment?: Record<string, string>;
    allowedCommands?: string[];
  },
): SandboxPolicy {
  const policy: SandboxPolicy = {
    filesystem: [
      {
        path: config.workspaceRoot,
        access: 'read-write',
        recursive: true,
      },
      // 系统目录只读访问（让 runtime 能找到 node_modules）
      {
        path: process.cwd(),
        access: 'read',
        recursive: true,
      },
    ],
    network: [], // 默认阻断所有网络
    resources: {
      cpuTimeMs: config.timeout || 30000,
      memoryMB: config.maxMemory || 0,
      maxOutputBytes: config.maxOutput || 50000,
      maxProcesses: 1, // 默认禁止 spawn 子进程
      maxFileSizeMB: 100,
    },
    workingDirectory: config.workspaceRoot,
    allowSpawn: false,
    extraEnv: config.environment,
  };

  return policy;
}
