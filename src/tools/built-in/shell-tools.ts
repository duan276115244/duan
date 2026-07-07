import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { errMsg } from '../../core/utils.js';
import { matchDangerousCommand } from '../../core/security-config.js';
import { executeShell, formatShellResult, getSmartTimeout } from '../../core/cross-platform-shell.js';

/**
 * 检测命令是否危险（统一来源: security-config.ts）
 */
function isDangerousCommand(cmd: string): { dangerous: boolean; reason?: string } {
  const matchedPattern = matchDangerousCommand(cmd);
  if (matchedPattern) {
    return { dangerous: true, reason: `匹配危险模式: ${matchedPattern.source}` };
  }
  return { dangerous: false };
}

export const shellTools: UnifiedToolDef[] = [
  {
    name: 'shell_execute',
    description: '在指定目录中执行Shell/PowerShell命令并返回结果。适用于运行脚本、编译代码、安装包、文件操作等。V17跨平台兼容：自动将Unix命令(mkdir -p/rm -rf/ls等)转换为Windows兼容格式，Windows上使用PowerShell。智能超时：npm install/git clone等长命令自动延长超时。',
    readOnly: false,
    parameters: {
      command: { type: 'string', description: '要执行的Shell/PowerShell命令（支持Unix和Windows语法，自动跨平台转换）', required: true },
      timeout: { type: 'number', description: '超时时间(毫秒)，默认60000。npm install等长命令会自动延长到300000', required: false },
      workdir: { type: 'string', description: '工作目录(可选，默认项目根目录)', required: false },
    },
    execute: (args) => {
      const cmd = args.command as string;
      if (!cmd || typeof cmd !== 'string') return Promise.resolve('❌ 缺少参数: command');
      const userTimeout = args.timeout as number | undefined;
      const workdir = (args.workdir as string) || process.cwd();

      // H2 修复：增强危险命令检测
      const dangerCheck = isDangerousCommand(cmd);
      if (dangerCheck.dangerous) {
        return Promise.resolve(`❌ 安全限制：不允许执行破坏性命令（${dangerCheck.reason}）。如需执行 "${cmd.substring(0, 50)}..."，请手动操作。`);
      }

      try {
        // V17: 使用跨平台 Shell 执行器（修复：使用智能超时计算的 timeout 而非 userTimeout）
        const { timeout, reason } = getSmartTimeout(cmd, userTimeout);
        const result = executeShell({ command: cmd, timeout, workdir });
        return Promise.resolve(formatShellResult(result, reason));
      } catch (err: unknown) {
        const e = err as { stdout?: { toString(): string }; stderr?: { toString(): string } };
        let msg = '';
        if (e.stdout) msg += e.stdout.toString();
        if (e.stderr) msg += (msg ? '\n--- stderr ---\n' : '') + e.stderr.toString().substring(0, 5000);
        if (!msg) msg = `命令执行失败: ${errMsg(err)}`;
        return Promise.resolve(msg);
      }
    },
  },
  {
    name: 'current_time',
    description: '获取当前时间',
    readOnly: true,
    parameters: { timezone: { type: 'string', description: '时区', required: false } },
    execute: (args) => {
      const tz = (args.timezone as string) || 'Asia/Shanghai';
      return Promise.resolve(new Date().toLocaleString('zh-CN', { timeZone: tz }));
    },
  },
];
