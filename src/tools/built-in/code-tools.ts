import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { SandboxExecutor } from '../../core/sandbox-executor.js';
import { errMsg } from '../../core/utils.js';
import * as os from 'os';

/**
 * P0-2 修复：code_execute 工具统一接入 SandboxExecutor
 *
 * 原实现直接使用 vm.createContext + vm.Script，绕过了 SandboxExecutor 的
 * 4 级隔离架构（none/vm/process/docker），是一个安全旁路。
 *
 * 现在通过 SandboxExecutor 执行，获得：
 * - 统一的超时保护（默认 30s）
 * - 输出长度限制（50000 字符）
 * - 命令黑名单保护
 * - 环境变量过滤
 * - 可升级到 process/docker 级别隔离
 *
 * 使用 vm 级别隔离（适合纯计算，无文件/网络访问），
 * workspaceRoot 设为系统临时目录，避免访问项目源码。
 */
export const codeTools: UnifiedToolDef[] = [
  {
    name: 'code_execute',
    description: '在安全沙箱中执行JavaScript代码并返回结果。仅支持纯计算，无文件/网络访问。',
    readOnly: true,
    parameters: { code: { type: 'string', description: '要执行的JavaScript代码', required: true } },
    execute: async (args) => {
      try {
        if (!args.code || typeof args.code !== 'string') {
          return '错误: code 参数必须是非空字符串';
        }
        // P0-2 修复：长度限制，防止超长代码导致内存问题
        if (args.code.length > 100000) {
          return '错误: 代码长度超过限制（最大 100000 字符）';
        }

        const executor = new SandboxExecutor();
        const result = await executor.execute(args.code, {
          level: 'vm',
          timeout: 10000,
          maxOutput: 50000,
          workspaceRoot: os.tmpdir(),
        });

        if (!result.success) {
          return `执行错误: ${result.error || '未知错误'}`;
        }

        // SandboxExecutor 的 output 已经包含 console 输出和结果
        return result.output || '(无输出)';
      } catch (err: unknown) {
        return `执行错误: ${errMsg(err)}`;
      }
    },
  },
];
