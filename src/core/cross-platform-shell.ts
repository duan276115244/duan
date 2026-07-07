/**
 * 跨平台 Shell 命令兼容层 — CrossPlatformShell
 *
 * V17 修复：Agent 生成的 Unix 命令在 Windows 上失败的问题
 *
 * 核心能力：
 * 1. Unix→Windows 命令自动转换（mkdir -p, rm -rf, ls, cp, mv, touch, cat...）
 * 2. 智能超时（npm install/git clone 等长命令自动延长超时）
 * 3. PowerShell 优先（Windows 上使用 PowerShell 替代 cmd.exe，原生支持更多命令）
 * 4. 命令安全检测（保留原有危险命令拦截）
 *
 * 解决场景：
 * - `mkdir -p ai_video_factory/src` → Windows: `mkdir -Force ai_video_factory/src`
 * - `rm -rf dist` → Windows: `Remove-Item -Recurse -Force dist`
 * - `npm install` → 自动超时 300s（默认 60s 太短）
 */

import { spawnSync } from 'child_process';

// ============ 类型定义 ============

export interface ShellExecuteOptions {
  command: string;
  timeout?: number;
  workdir?: string;
  maxBuffer?: number;
  /** V17: 超时自动重试（默认 true） */
  retryOnTimeout?: boolean;
}

export interface ShellExecuteResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
  timedOut: boolean;
  originalCommand: string;
  translatedCommand: string;
  shellUsed: string;
}

// ============ 长命令超时配置 ============

const LONG_RUNNING_PATTERNS: Array<{ pattern: RegExp; timeout: number; reason: string }> = [
  { pattern: /npm\s+install|npm\s+i\s|npm\s+ci\b/i, timeout: 300000, reason: 'npm install 需要下载依赖，默认 300s' },
  { pattern: /npm\s+run\s+build|npm\s+run\s+dev/i, timeout: 180000, reason: '构建/开发服务器需要长时间运行' },
  { pattern: /git\s+clone/i, timeout: 180000, reason: 'git clone 需要下载仓库' },
  { pattern: /docker\s+build/i, timeout: 300000, reason: 'Docker 构建需要时间' },
  { pattern: /pip\s+install|pip3\s+install/i, timeout: 300000, reason: 'pip install 需要下载包' },
  { pattern: /yarn\s+install|yarn\s+add/i, timeout: 300000, reason: 'yarn install 需要下载依赖' },
  { pattern: /pnpm\s+install|pnpm\s+add/i, timeout: 300000, reason: 'pnpm install 需要下载依赖' },
  { pattern: /tsc\b|npm\s+run\s+typecheck/i, timeout: 120000, reason: 'TypeScript 编译需要时间' },
  { pattern: /webpack|vite\s+build|rollup/i, timeout: 180000, reason: '打包构建需要时间' },
];

const DEFAULT_TIMEOUT = 60000;

// ============ 跨平台命令转换 ============

/**
 * 将 Unix 命令转换为当前平台兼容的命令
 */
export function translateCommand(command: string): string {
  // 非 Windows 平台直接返回原命令
  if (process.platform !== 'win32') {
    return command;
  }

  let translated = command;

  // ===== mkdir -p → PowerShell mkdir（自动创建父目录） =====
  // mkdir -p path/to/dir → mkdir -Force path/to/dir
  translated = translated.replace(
    /mkdir\s+-p\s+/g,
    'mkdir -Force ',
  );

  // ===== rm -rf → Remove-Item -Recurse -Force =====
  translated = translated.replace(
    /rm\s+-rf\s+/g,
    'Remove-Item -Recurse -Force ',
  );
  translated = translated.replace(
    /rm\s+-r\s+-f\s+/g,
    'Remove-Item -Recurse -Force ',
  );
  translated = translated.replace(
    /rm\s+-f\s+/g,
    'Remove-Item -Force ',
  );

  // ===== touch → New-Item -ItemType File =====
  translated = translated.replace(
    /\btouch\s+/g,
    'New-Item -ItemType File -Path ',
  );

  // ===== cat → Get-Content =====
  translated = translated.replace(
    /\bcat\s+/g,
    'Get-Content ',
  );

  // ===== ls -la / ls -l → Get-ChildItem =====
  translated = translated.replace(
    /\bls\s+-la\b/g,
    'Get-ChildItem -Force',
  );
  translated = translated.replace(
    /\bls\s+-l\b/g,
    'Get-ChildItem',
  );
  translated = translated.replace(
    /\bls\s+-a\b/g,
    'Get-ChildItem -Force',
  );

  // ===== cp → Copy-Item =====
  translated = translated.replace(
    /\bcp\s+-r\s+/g,
    'Copy-Item -Recurse ',
  );
  translated = translated.replace(
    /\bcp\s+/g,
    'Copy-Item ',
  );

  // ===== mv → Move-Item =====
  translated = translated.replace(
    /\bmv\s+/g,
    'Move-Item ',
  );

  // ===== which → Get-Command =====
  translated = translated.replace(
    /\bwhich\s+/g,
    'Get-Command ',
  );

  // ===== pwd → Get-Location =====
  translated = translated.replace(
    /\bpwd\b/g,
    'Get-Location',
  );

  // ===== echo → Write-Output =====
  translated = translated.replace(
    /\becho\s+/g,
    'Write-Output ',
  );

  // ===== export VAR=val → $env:VAR='val' =====
  translated = translated.replace(
    /export\s+(\w+)=(\S+)/g,
    "\\$env:$1='$2'",
  );

  // ===== && 分隔符在 PowerShell 中也支持，保持不变 =====
  // ===== ; 分隔符在 PowerShell 中也支持，保持不变 =====

  return translated;
}

// ============ 智能超时检测 ============

/**
 * 根据命令内容自动选择合适的超时时间
 */
export function getSmartTimeout(command: string, userTimeout?: number): { timeout: number; reason: string } {
  // 用户显式指定超时则优先使用
  if (userTimeout && userTimeout > 0) {
    return { timeout: userTimeout, reason: '用户指定超时' };
  }

  // 检测长命令模式
  for (const { pattern, timeout, reason } of LONG_RUNNING_PATTERNS) {
    if (pattern.test(command)) {
      return { timeout, reason };
    }
  }

  return { timeout: DEFAULT_TIMEOUT, reason: '默认超时' };
}

// ============ 跨平台 Shell 执行 ============

/**
 * 执行 Shell 命令（跨平台兼容）
 *
 * Windows 上使用 PowerShell（支持更多 Unix 别名），并自动转换 Unix 命令
 * Unix 上直接使用 /bin/sh
 *
 * V17: 超时自动重试 — 首次超时后自动延长超时时间重试一次
 */
export function executeShell(options: ShellExecuteOptions): ShellExecuteResult {
  const { command: originalCommand, workdir = process.cwd(), maxBuffer = 10 * 1024 * 1024, retryOnTimeout = true } = options;

  // 1. 智能超时
  const { timeout: smartTimeout, reason: _timeoutReason } = getSmartTimeout(originalCommand, options.timeout);

  // 2. 执行命令（带超时重试）
  const result = executeShellInternal(originalCommand, workdir, maxBuffer, smartTimeout);

  // 3. V17 超时自动重试：首次超时后用 2x 超时重试一次
  if (result.timedOut && retryOnTimeout) {
    const retryTimeout = Math.min(smartTimeout * 2, 600000); // 最大 10 分钟
    if (retryTimeout > smartTimeout) {
      const retryResult = executeShellInternal(originalCommand, workdir, maxBuffer, retryTimeout);
      // 标记为重试结果
      retryResult.stderr = `[自动重试] 首次执行超时（${smartTimeout / 1000}s），已用 ${retryTimeout / 1000}s 重试\n` + (retryResult.stderr || '');
      return retryResult;
    }
  }

  return result;
}

/**
 * 内部执行函数（不含重试逻辑）
 */
function executeShellInternal(
  originalCommand: string,
  workdir: string,
  maxBuffer: number,
  timeout: number,
): ShellExecuteResult {
  // 跨平台命令转换
  const translatedCommand = translateCommand(originalCommand);

  // 选择 Shell
  const isWin = process.platform === 'win32';
  const shellUsed = isWin ? 'powershell.exe' : '/bin/sh';

  // 判断是否需要 shell（包含管道、重定向、逻辑运算符）
  const needsShell = /[|>&;`$()]/.test(translatedCommand) || /\band\b|\bor\b/.test(translatedCommand);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;

  if (isWin) {
    // Windows: 使用 PowerShell 执行（比 cmd.exe 兼容性更好）
    result = spawnSync(shellUsed, ['-NoProfile', '-Command', translatedCommand], {
      cwd: workdir,
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  } else if (needsShell) {
    // Unix 复杂命令：使用 shell
    result = spawnSync(shellUsed, ['-c', translatedCommand], {
      cwd: workdir,
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  } else {
    // Unix 简单命令：拆分参数执行
    const parts = translatedCommand.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || [];
    const cleanParts = parts.map(p => p.replace(/^["']|["']$/g, ''));
    const executable = cleanParts[0];
    const argList = cleanParts.slice(1);

    result = spawnSync(executable, argList, {
      cwd: workdir,
      encoding: 'utf-8',
      timeout,
      maxBuffer,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  }

  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    error: result.error?.message,
    timedOut,
    originalCommand,
    translatedCommand,
    shellUsed,
  };
}

/**
 * 格式化执行结果为字符串
 */
export function formatShellResult(result: ShellExecuteResult, timeoutReason: string): string {
  let output = '';

  if (result.stdout) output += result.stdout;
  if (result.stderr) {
    output += (output ? '\n--- stderr ---\n' : '') + result.stderr.substring(0, 5000);
  }

  if (result.timedOut) {
    output += (output ? '\n' : '') + `⏱ 命令执行超时（${timeoutReason}）。如需更长时间，请指定 timeout 参数。`;
  }

  if (result.status !== 0 && !output) {
    output = `命令执行失败（退出码 ${result.status}）: ${result.error || '未知错误'}`;
  }

  // 如果命令被转换了，添加提示
  if (result.originalCommand !== result.translatedCommand) {
    output = `[跨平台兼容] 已将 Unix 命令转换为 ${result.shellUsed} 兼容格式:\n  原始: ${result.originalCommand}\n  转换: ${result.translatedCommand}\n\n${output}`;
  }

  return output || '(命令执行成功，无输出)';
}
