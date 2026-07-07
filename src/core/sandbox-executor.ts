/**
 * 沙箱执行器 — 生产环境主沙箱
 *
 * 被 enhanced-agent-loop.ts:451 实例化并注入到 ToolExecutionPipeline。
 * 提供 4 级隔离的代码/命令执行环境：
 * - none:   无隔离，直接执行（仅限安全工具）
 * - vm:     Node.js vm 模块隔离，限制全局对象访问
 * - process: 子进程隔离，使用 execFile 避免注入，限制资源
 *           P1-3: 若注入了 CrossPlatformSandbox，则委托给平台原生后端
 *           （Linux bubblewrap/unshare, macOS seatbelt, Windows Job Object）
 * - docker: Docker 容器隔离，完全文件系统/网络隔离
 *
 * P1-3 集成：通过 setCrossPlatformSandbox() 注入 CrossPlatformSandbox 实例后，
 * process 级别会优先委托给平台原生后端，失败时降级到本类的 process 实现。
 *
 * 优化方案 Module 3 实现
 */

import * as vm from 'vm';
import { execFile } from 'child_process';
import * as path from 'path';
import { convertSandboxConfigToPolicy, type CrossPlatformSandbox } from './cross-platform-sandbox.js';
import { logger } from './structured-logger.js';

// ==================== 类型定义 ====================

/** 沙箱隔离级别 */
export type SandboxLevel = 'none' | 'vm' | 'process' | 'docker';

/** 沙箱配置 */
export interface SandboxConfig {
  /** 隔离级别 */
  level: SandboxLevel;
  /** 最大执行时间（毫秒），默认 30000 */
  timeout: number;
  /** 最大输出字符数，默认 50000 */
  maxOutput: number;
  /** 最大内存（MB），仅 process/docker 级别生效 */
  maxMemory?: number;
  /** 允许的文件系统根目录 */
  workspaceRoot: string;
  /** 命令白名单（process/docker 级别） */
  allowedCommands?: string[];
  /** 命令黑名单 */
  blockedCommands?: string[];
  /** 环境变量 */
  environment?: Record<string, string>;
}

/** 沙箱执行结果 */
export interface SandboxResult {
  /** 是否执行成功 */
  success: boolean;
  /** 标准输出内容 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** 退出码 */
  exitCode?: number;
  /** 执行耗时（毫秒） */
  duration: number;
  /** 实际使用的隔离级别 */
  level: SandboxLevel;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: Partial<SandboxConfig> = {
  timeout: 30000,
  maxOutput: 50000,
  blockedCommands: [
    'rm -rf /', 'mkfs', 'dd if=', 'format',
    'shutdown', 'reboot', 'init 0', 'init 6',
    ':(){:|:&};:', 'fork bomb',
    'chmod 777 /', 'chown root',
    'curl | sh', 'curl | bash', 'wget | sh', 'wget | bash',
    'nc -l', 'ncat', 'socat',
  ],
};

/** 敏感环境变量前缀，执行时需要过滤 */
const SENSITIVE_ENV_PREFIXES = [
  'API_KEY', 'SECRET', 'TOKEN', 'PASSWORD',
  'PRIVATE_KEY', 'ACCESS_KEY', 'AUTH',
  'CREDENTIAL', 'CERTIFICATE',
];

/** 安全工具列表 → none 级别 */
const SAFE_TOOLS = new Set([
  'file_read', 'list_directory', 'search_files', 'grep',
  'file_info', 'directory_tree', 'read_file',
]);

/** 中等风险工具列表 → vm 级别 */
const MODERATE_TOOLS = new Set([
  'file_write', 'code_execute', 'eval', 'execute_code',
  'run_javascript', 'run_typescript',
]);

/** 高风险工具列表 → process 级别 */
const DANGEROUS_TOOLS = new Set([
  'shell_execute', 'bash', 'exec', 'run_command',
  'command', 'terminal', 'cmd',
]);

/** 极高风险工具列表 → docker 级别（如果可用） */
const VERY_DANGEROUS_TOOLS = new Set([
  'docker_exec', 'container_run', 'system_command',
]);

// ==================== Docker 可用性检测缓存 ====================

let dockerAvailableCache: boolean | null = null;

/**
 * 检测 Docker 是否可用
 * 缓存结果避免重复检测
 */
function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== null) {
    return Promise.resolve(dockerAvailableCache);
  }

  return new Promise<boolean>((resolve) => {
    const timeout = 5000;
    const timer = setTimeout(() => {
      dockerAvailableCache = false;
      resolve(false);
    }, timeout);

    try {
      execFile('docker', ['--version'], { timeout }, (error, stdout) => {
        clearTimeout(timer);
        if (error || !stdout) {
          dockerAvailableCache = false;
        } else {
          dockerAvailableCache = stdout.toLowerCase().includes('docker');
        }
        resolve(dockerAvailableCache);
      });
    } catch {
      clearTimeout(timer);
      dockerAvailableCache = false;
      resolve(false);
    }
  });
}

/**
 * 重置 Docker 可用性缓存（用于测试）
 */
export function resetDockerCache(): void {
  dockerAvailableCache = null;
}

// ==================== 环境变量过滤 ====================

/**
 * 过滤敏感环境变量
 * 移除包含 API Key、Secret、Token 等的环境变量
 */
function filterEnvironment(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    const isSensitive = SENSITIVE_ENV_PREFIXES.some(prefix =>
      upperKey.includes(prefix)
    );
    if (!isSensitive) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// ==================== 输出截断 ====================

/**
 * 截断输出到最大长度
 */
function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) {
    return output;
  }
  const truncated = output.substring(0, maxLength);
  return truncated + `\n... [输出已截断，原始长度: ${output.length} 字符]`;
}

// ==================== 沙箱执行器 ====================

export class SandboxExecutor {
  /** P1-3: 跨平台原生沙箱实例（可选，注入后启用平台原生隔离） */
  private crossPlatformSandbox: CrossPlatformSandbox | null = null;

  /**
   * P1-3: 注入跨平台原生沙箱
   *
   * 注入后，process 级别的命令执行会优先委托给平台原生后端
   * （Linux bubblewrap/unshare, macOS seatbelt, Windows Job Object）。
   * 若原生后端不可用或执行失败，自动降级到本类的 process 实现。
   */
  setCrossPlatformSandbox(sandbox: CrossPlatformSandbox | null): void {
    this.crossPlatformSandbox = sandbox;
    if (sandbox) {
      logger.info('[SandboxExecutor] P1-3: 跨平台原生沙箱已注入，process 级别将委托给平台原生后端');
    }
  }

  /**
   * P1-3: 查询当前是否已注入跨平台原生沙箱
   */
  hasCrossPlatformSandbox(): boolean {
    return this.crossPlatformSandbox !== null;
  }

  /**
   * 在沙箱中执行 JavaScript 代码
   * @param code 要执行的代码
   * @param config 沙箱配置
   */
  async execute(code: string, config: SandboxConfig): Promise<SandboxResult> {
    const mergedConfig = this.mergeConfig(config);
    const startTime = Date.now();

    try {
      switch (mergedConfig.level) {
        case 'none':
          return await this.executeNone(code, mergedConfig, startTime);
        case 'vm':
          return await this.executeVm(code, mergedConfig, startTime);
        case 'process':
          // process 级别不支持直接执行代码，需要通过 node -e 执行
          return await this.executeProcessCode(code, mergedConfig, startTime);
        case 'docker':
          return await this.executeDockerCode(code, mergedConfig, startTime);
        default:
          return {
            success: false,
            output: '',
            error: `未知的沙箱级别: ${mergedConfig.level}`,
            duration: Date.now() - startTime,
            level: mergedConfig.level,
          };
      }
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - startTime,
        level: mergedConfig.level,
      };
    }
  }

  /**
   * 在沙箱中执行 Shell 命令
   * @param command 命令名称（如 'node', 'python'）
   * @param args 命令参数
   * @param config 沙箱配置
   */
  async executeCommand(
    command: string,
    args: string[],
    config: SandboxConfig,
  ): Promise<SandboxResult> {
    const mergedConfig = this.mergeConfig(config);
    const startTime = Date.now();

    // 检查命令黑名单
    const fullCommand = `${command} ${args.join(' ')}`;
    if (this.isCommandBlocked(fullCommand, mergedConfig)) {
      return {
        success: false,
        output: '',
        error: `命令被黑名单拦截: ${command}`,
        duration: Date.now() - startTime,
        level: mergedConfig.level,
      };
    }

    // 检查命令白名单（如果配置了）
    if (mergedConfig.allowedCommands && mergedConfig.allowedCommands.length > 0) {
      const isAllowed = mergedConfig.allowedCommands.some(allowed =>
        command === allowed || fullCommand.startsWith(allowed)
      );
      if (!isAllowed) {
        return {
          success: false,
          output: '',
          error: `命令不在白名单中: ${command}`,
          duration: Date.now() - startTime,
          level: mergedConfig.level,
        };
      }
    }

    try {
      switch (mergedConfig.level) {
        case 'none':
          return await this.executeCommandNone(command, args, mergedConfig, startTime);
        case 'vm':
          // vm 级别不支持 shell 命令，降级为 process
          return await this.executeCommandProcess(command, args, mergedConfig, startTime);
        case 'process':
          return await this.executeCommandProcess(command, args, mergedConfig, startTime);
        case 'docker':
          return await this.executeCommandDocker(command, args, mergedConfig, startTime);
        default:
          return {
            success: false,
            output: '',
            error: `未知的沙箱级别: ${mergedConfig.level}`,
            duration: Date.now() - startTime,
            level: mergedConfig.level,
          };
      }
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - startTime,
        level: mergedConfig.level,
      };
    }
  }

  /**
   * 根据工具名称和风险等级自动选择沙箱级别
   * @param toolName 工具名称
   * @param riskLevel 风险等级（safe/moderate/dangerous/very_dangerous）
   */
  async selectLevel(toolName: string, riskLevel: string): Promise<SandboxLevel> {
    // 极高风险工具 → docker（如果可用）
    if (riskLevel === 'very_dangerous' || VERY_DANGEROUS_TOOLS.has(toolName)) {
      const dockerOk = await isDockerAvailable();
      return dockerOk ? 'docker' : 'process';
    }

    // 高风险工具 → process
    if (riskLevel === 'dangerous' || DANGEROUS_TOOLS.has(toolName)) {
      return 'process';
    }

    // 中等风险工具 → vm
    if (riskLevel === 'moderate' || MODERATE_TOOLS.has(toolName)) {
      return 'vm';
    }

    // 安全工具 → none
    if (riskLevel === 'safe' || SAFE_TOOLS.has(toolName)) {
      return 'none';
    }

    // 默认：未知工具按中等风险处理
    return 'vm';
  }

  // ==================== none 级别实现 ====================

  /**
   * 无隔离执行代码
   * 仅用于安全工具，使用 vm.Script 提供基础隔离（替代 new Function）
   */
  private executeNone(
    code: string,
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    try {
      // 使用 vm.Script 替代 new Function，提供基础作用域隔离
      const script = new vm.Script(`(function() { return (function() { ${code} })(); })()`, {
        filename: 'sandbox-none.js',
      });
      const sandbox = { console, JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, Promise };
      const context = vm.createContext(sandbox);
      const result = script.runInContext(context, { timeout: config.timeout || 5000 });
      const output = result !== undefined ? String(result) : '';
      return Promise.resolve({
        success: true,
        output: truncateOutput(output, config.maxOutput),
        duration: Date.now() - startTime,
        level: 'none',
      });
    } catch (err: unknown) {
      return Promise.resolve({
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - startTime,
        level: 'none',
      });
    }
  }

  /**
   * 无隔离执行命令
   */
  private executeCommandNone(
    command: string,
    args: string[],
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          success: false,
          output: '',
          error: `执行超时 (${config.timeout}ms)`,
          exitCode: -1,
          duration: Date.now() - startTime,
          level: 'none',
        });
      }, config.timeout);

      execFile(command, args, {
        cwd: config.workspaceRoot,
        env: { ...filterEnvironment(process.env as Record<string, string>), ...config.environment },
        maxBuffer: config.maxOutput * 2, // maxBuffer 按 bytes 计算
      }, (error, stdout, stderr) => {
        clearTimeout(timeout);
        const output = truncateOutput(String(stdout || ''), config.maxOutput);
        if (error) {
          resolve({
            success: false,
            output,
            error: String(stderr || '') || error.message,
            exitCode: typeof error.code === 'number' ? error.code : -1,
            duration: Date.now() - startTime,
            level: 'none',
          });
        } else {
          resolve({
            success: true,
            output,
            error: stderr ? String(stderr) : undefined,
            exitCode: 0,
            duration: Date.now() - startTime,
            level: 'none',
          });
        }
      });
    });
  }

  // ==================== vm 级别实现 ====================

  /**
   * VM 沙箱执行代码
   * 使用 Node.js vm 模块创建隔离上下文
   * 提供有限的全局对象，禁止访问 require/process/fs 等
   */
  private executeVm(
    code: string,
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      // 超时控制
      const timeoutHandle = setTimeout(() => {
        resolve({
          success: false,
          output: '',
          error: `VM 执行超时 (${config.timeout}ms)`,
          duration: Date.now() - startTime,
          level: 'vm',
        });
      }, config.timeout);

      try {
        // 构建安全的沙箱全局对象，预先注入输出收集器
        const __outputs: string[] = [];
        const sandbox = this.createVmSandbox(config);
        // 劫持 console 方法收集输出（在沙箱对象上直接修改）
        // 注意：使用块体而非箭头函数表达式体，确保返回 undefined（不污染脚本完成值）
        sandbox.console = {
          log: (...args: unknown[]) => { __outputs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
          error: (...args: unknown[]) => { __outputs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
          warn: (...args: unknown[]) => { __outputs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
          info: (...args: unknown[]) => { __outputs.push('[INFO] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
          debug: (...args: unknown[]) => { __outputs.push('[DEBUG] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
          table: (...args: unknown[]) => { __outputs.push('[TABLE] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
          time: () => {},
          timeEnd: () => {},
        };

        // 创建隔离上下文
        const context = vm.createContext(sandbox);

        // 安全修复：完全移除 eval() 和 new Function()
        // 直接将用户代码编译为 vm.Script，runInContext 返回脚本的完成值
        // 完成值 = 最后一个表达式语句的值（与 eval 行为一致）
        // 用户代码在沙箱上下文中执行，只能访问 sandbox 中暴露的全局对象
        const userScript = new vm.Script(code, {
          filename: 'sandbox-user-code.js',
        });

        let success = true;
        let resultValue: unknown;
        let errorMsg: string | undefined;

        try {
          resultValue = userScript.runInContext(context, {
            timeout: config.timeout,
          });
        } catch (err: unknown) {
          success = false;
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        clearTimeout(timeoutHandle);

        if (success) {
          const outputParts = [...__outputs];
          if (resultValue !== undefined) {
            outputParts.push(
              typeof resultValue === 'object'
                ? JSON.stringify(resultValue, null, 2)
                : String(resultValue)
            );
          }
          resolve({
            success: true,
            output: truncateOutput(outputParts.join('\n'), config.maxOutput),
            duration: Date.now() - startTime,
            level: 'vm',
          });
        } else {
          resolve({
            success: false,
            output: truncateOutput(__outputs.join('\n'), config.maxOutput),
            error: errorMsg,
            duration: Date.now() - startTime,
            level: 'vm',
          });
        }
      } catch (err: unknown) {
        clearTimeout(timeoutHandle);
        resolve({
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - startTime,
          level: 'vm',
        });
      }
    });
  }

  /**
   * 创建 VM 沙箱的全局对象
   * 仅提供安全的内置对象，禁止 require/process/fs 等
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createVmSandbox(config: SandboxConfig): Record<string, any> {
    // 受限的 setTimeout：强制超时限制
    const safeSetTimeout = (fn: (...args: unknown[]) => void, delay: number) => {
      const maxDelay = Math.min(delay, config.timeout);
      return setTimeout(fn, maxDelay);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: Record<string, any> = {
      // 安全的全局对象
      console: {
        log: (..._args: unknown[]) => {},
        error: (..._args: unknown[]) => {},
        warn: (..._args: unknown[]) => {},
        info: (..._args: unknown[]) => {},
        debug: (..._args: unknown[]) => {},
        table: (..._args: unknown[]) => {},
        time: () => {},
        timeEnd: () => {},
      },
      JSON,
      Math,
      Date,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      RegExp,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      ReferenceError,
      URIError,
      EvalError,
      Array,
      Boolean,
      Number,
      String,
      Object,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Symbol,
      Proxy,
      Reflect,
      ArrayBuffer,
      DataView,
      Float32Array,
      Float64Array,
      Int8Array,
      Int16Array,
      Int32Array,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Uint8ClampedArray,
      setTimeout: safeSetTimeout,
      clearTimeout,
      setInterval: (fn: (...args: unknown[]) => void, delay: number) => setInterval(fn, Math.min(delay, config.timeout)),
      clearInterval,

      // 显式禁止的对象（设为 undefined）
      require: undefined,
      module: undefined,
      exports: undefined,
      process: undefined,
      global: undefined,
      globalThis: undefined,
      __dirname: undefined,
      __filename: undefined,
      Buffer: undefined,
      __proto__: undefined,

      // 辅助函数
      atob: (str: string) => Buffer.from(str, 'base64').toString('binary'),
      btoa: (str: string) => Buffer.from(str, 'binary').toString('base64'),
    };

    return sandbox;
  }

  // ==================== process 级别实现 ====================

  /**
   * 进程沙箱执行代码
   * 通过 `node -e` 在子进程中执行，限制资源
   */
  private executeProcessCode(
    code: string,
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    // 使用 node -e 在子进程中执行代码
    return this.executeCommandProcess(
      'node',
      ['-e', code],
      config,
      startTime,
    );
  }

  /**
   * 进程沙箱执行命令
   * 使用 execFile（非 exec）避免 shell 注入
   * 限制超时、输出大小、工作目录和环境变量
   */
  private async executeCommandProcess(
    command: string,
    args: string[],
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    // P1-3: 优先委托给跨平台原生沙箱（Linux bubblewrap/unshare, macOS seatbelt, Windows Job Object）
    if (this.crossPlatformSandbox) {
      try {
        const policy = convertSandboxConfigToPolicy(config);
        const nativeResult = await this.crossPlatformSandbox.executeCommandNative(command, args, policy);
        // 转换 CrossPlatformSandbox 的 SandboxResult 到 SandboxExecutor 的 SandboxResult 格式
        return {
          success: nativeResult.success,
          output: nativeResult.stdout,
          error: nativeResult.stderr || undefined,
          exitCode: nativeResult.exitCode ?? undefined,
          duration: nativeResult.durationMs,
          level: 'process',
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 降级到本类的 process 实现 —— 不让集成失败导致整体不可用
        logger.warn('[SandboxExecutor] P1-3 跨平台原生沙箱失败，降级到本类 process 实现', {
          error: msg,
          command,
        });
      }
    }

    return new Promise((resolve) => {
      // 构建安全的环境变量
      const safeEnv = filterEnvironment(process.env as Record<string, string>);
      const env = { ...safeEnv, ...config.environment };

      // 构建子进程选项
      const options: Parameters<typeof execFile>[2] = {
        cwd: config.workspaceRoot,
        env,
        timeout: config.timeout,
        maxBuffer: config.maxOutput * 2, // maxBuffer 按 bytes 计算
        windowsHide: true,
      };

      // 如果指定了内存限制，通过 Node.js 参数限制
      if (config.maxMemory && command === 'node') {
        const memoryArg = `--max-old-space-size=${config.maxMemory}`;
        args = [memoryArg, ...args];
      }

      execFile(command, args, options, (error, stdout, stderr) => {
        const output = truncateOutput(String(stdout || ''), config.maxOutput);
        const duration = Date.now() - startTime;

        if (error) {
          // 区分超时和其他错误
          const isTimeout = (error as unknown as { killed?: boolean }).killed === true;
          resolve({
            success: false,
            output,
            error: isTimeout
              ? `进程执行超时 (${config.timeout}ms)`
              : (String(stderr || '') || error.message),
            exitCode: (() => {
              if (isTimeout) return -1;
              if (typeof error.code === 'number') return error.code;
              return -1;
            })(),
            duration,
            level: 'process',
          });
        } else {
          resolve({
            success: true,
            output,
            error: stderr ? String(stderr) : undefined,
            exitCode: 0,
            duration,
            level: 'process',
          });
        }
      });
    });
  }

  // ==================== docker 级别实现 ====================

  /**
   * Docker 沙箱执行代码
   * 在隔离容器中通过 node -e 执行
   */
  private async executeDockerCode(
    code: string,
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    // 检查 Docker 是否可用
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      // 降级到进程沙箱
      return this.executeProcessCode(code, { ...config, level: 'process' }, startTime);
    }

    // 将代码写入临时文件并通过 volume 挂载执行
    // 使用 node -e 直接传递代码（短代码）
    // 对于长代码，使用 stdin 传递
    const dockerArgs = this.buildDockerArgs(
      'node',
      ['-e', code],
      config,
    );

    return this.executeDockerCommand(dockerArgs, config, startTime);
  }

  /**
   * Docker 沙箱执行命令
   * 在隔离容器中执行命令
   */
  private async executeCommandDocker(
    command: string,
    args: string[],
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    // 检查 Docker 是否可用
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      // 降级到进程沙箱
      return this.executeCommandProcess(command, args, { ...config, level: 'process' }, startTime);
    }

    const dockerArgs = this.buildDockerArgs(command, args, config);
    return this.executeDockerCommand(dockerArgs, config, startTime);
  }

  /**
   * 构建 Docker run 参数
   * 包含资源限制、网络隔离、文件系统只读等安全措施
   */
  private buildDockerArgs(
    command: string,
    args: string[],
    config: SandboxConfig,
  ): string[] {
    const dockerArgs: string[] = ['run', '--rm'];

    // 禁用网络访问
    dockerArgs.push('--network', 'none');

    // 内存限制（默认 512MB）
    const memoryMB = config.maxMemory || 512;
    dockerArgs.push('--memory', `${memoryMB}m`);

    // CPU 限制（默认 1 核）
    dockerArgs.push('--cpus', '1');

    // 只读文件系统
    dockerArgs.push('--read-only');

    // 挂载工作目录（根据需要读写或只读）
    const workspaceMount = path.resolve(config.workspaceRoot);
    dockerArgs.push('-v', `${workspaceMount}:/workspace`);

    // 临时文件系统（用于写入操作）
    dockerArgs.push('--tmpfs', '/tmp:size=100m');

    // 禁止特权升级
    dockerArgs.push('--security-opt', 'no-new-privileges');

    // 设置用户（避免 root）
    dockerArgs.push('--user', 'nobody');

    // 设置工作目录
    dockerArgs.push('-w', '/workspace');

    // 环境变量
    if (config.environment) {
      for (const [key, value] of Object.entries(config.environment)) {
        dockerArgs.push('-e', `${key}=${value}`);
      }
    }

    // 使用 node 镜像
    dockerArgs.push('node:20-slim');

    // 使用 timeout 命令包装以限制执行时间
    const timeoutSecs = Math.ceil(config.timeout / 1000);
    dockerArgs.push('timeout', String(timeoutSecs), command, ...args);

    return dockerArgs;
  }

  /**
   * 执行 Docker 命令
   * 如果 Docker 不可用则降级到进程沙箱
   */
  private executeDockerCommand(
    dockerArgs: string[],
    config: SandboxConfig,
    startTime: number,
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      // Docker 命令超时需要额外缓冲
      const dockerTimeout = config.timeout + 10000;

      execFile('docker', dockerArgs, {
        timeout: dockerTimeout,
        maxBuffer: config.maxOutput * 2,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const output = truncateOutput(String(stdout || ''), config.maxOutput);
        const duration = Date.now() - startTime;

        if (error) {
          const isTimeout = (error as unknown as { killed?: boolean }).killed === true;
          // Docker 超时退出码为 124
          const isDockerTimeout = (error as unknown as { code?: string | number }).code === 124;

          resolve({
            success: false,
            output,
            error: (isTimeout || isDockerTimeout)
              ? `Docker 执行超时 (${config.timeout}ms)`
              : (String(stderr || '') || error.message),
            exitCode: (() => {
              if (isTimeout) return -1;
              if (typeof error.code === 'number') return error.code;
              return -1;
            })(),
            duration,
            level: 'docker',
          });
        } else {
          resolve({
            success: true,
            output,
            error: stderr ? String(stderr) : undefined,
            exitCode: 0,
            duration,
            level: 'docker',
          });
        }
      });
    });
  }

  // ==================== 辅助方法 ====================

  /**
   * 合并默认配置
   */
  private mergeConfig(config: SandboxConfig): SandboxConfig {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      blockedCommands: [
        ...(DEFAULT_CONFIG.blockedCommands || []),
        ...(config.blockedCommands || []),
      ],
    } as SandboxConfig;
  }

  /**
   * 检查命令是否被黑名单拦截
   */
  private isCommandBlocked(fullCommand: string, config: SandboxConfig): boolean {
    if (!config.blockedCommands || config.blockedCommands.length === 0) {
      return false;
    }
    const normalized = fullCommand.toLowerCase().trim();
    return config.blockedCommands.some(blocked =>
      normalized.includes(blocked.toLowerCase())
    );
  }
}
