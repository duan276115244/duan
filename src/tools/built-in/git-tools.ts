import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';

const execFileAsync = promisify(execFile);

/**
 * H3 修复：使用 execFile + 参数数组替代 execSync 字符串拼接
 * 彻底消除 shell 注入风险（commit 消息、分支名等参数不再需要转义）
 * 异步版本：用 promisify(execFile) 替代 spawnSync，避免阻塞事件循环
 */
export const gitTools: UnifiedToolDef[] = [
  {
    name: 'self_git',
    description: '执行Git操作：查看仓库状态、提交历史、文件差异、创建提交等。用于版本管理和代码审查。',
    parameters: {
      action: { type: 'string', description: '操作: status/diff/log/commit/branch/add/checkout', required: true },
      args: { type: 'string', description: '额外参数，如 commit时的提交信息，branch时的分支名', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const extra = (args.args as string) || '';

      // H3 修复：使用 execFile 参数数组，避免 shell 注入（异步版本）
      const execGit = async (gitArgs: string[]): Promise<string> => {
        try {
          const { stdout, stderr } = await execFileAsync('git', gitArgs, {
            cwd: process.cwd(),
            encoding: 'utf-8',
            timeout: 15000,
            // execFile 默认不使用 shell，无需 shell: false
          });
          if (stderr && stderr.trim()) return `Git错误: ${stderr.trim()}`;
          return stdout || '(无输出)';
        } catch (e: unknown) {
          const err = e as { stderr?: string };
          const stderr = err?.stderr;
          return `Git错误: ${stderr || (e instanceof Error ? e.message : String(e))}`;
        }
      };

      // 校验 action 白名单
      const validActions = ['status', 'diff', 'log', 'commit', 'branch', 'add', 'checkout'];
      if (!validActions.includes(action)) {
        return `用法: action=${validActions.join('|')}`;
      }

      // 校验 extra 参数（分支名/提交信息）不含控制字符
      if (extra && /[\n\r\t]/.test(extra)) {
        return '❌ 安全限制: 参数包含控制字符（换行/制表符）';
      }

      // 分支名格式校验（Git 分支名规范：字母、数字、/、-、_、.）
      const branchNamePattern = /^[a-zA-Z0-9._/-]+$/;

      switch (action) {
        case 'status':
          return await execGit(['status', '--short']);
        case 'diff':
          return await execGit(['diff']);
        case 'log':
          return await execGit(['log', '--oneline', '-20']);
        case 'branch':
          if (extra) {
            if (!branchNamePattern.test(extra)) {
              return '❌ 安全限制: 分支名包含非法字符（仅允许字母、数字、/、-、_、.）';
            }
            return await execGit(['checkout', '-b', extra]);
          }
          return await execGit(['branch', '-a']);
        case 'add':
          return (await execGit(['add', '-A'])) + '\n' + (await execGit(['status', '--short']));
        case 'commit':
          if (!extra) return '错误: 请提供提交信息 (args)';
          // 参数数组传递，无需转义，彻底消除注入
          return await execGit(['commit', '-m', extra]);
        case 'checkout':
          if (!extra) return '错误: 请提供分支名 (args)';
          if (!branchNamePattern.test(extra)) {
            return '❌ 安全限制: 分支名包含非法字符';
          }
          return await execGit(['checkout', extra]);
        default:
          return `用法: action=${validActions.join('|')}`;
      }
    },
  },
];
