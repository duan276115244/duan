import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as vm from 'vm';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { errMsg } from '../../core/utils.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _dynamicTools = new Map<string, any>();

type ToolListProvider = () => UnifiedToolDef[];
export let getBuiltInTools: ToolListProvider = () => [];
export function setBuiltInToolsProvider(provider: ToolListProvider) {
  getBuiltInTools = provider;
}

export { _dynamicTools };

/**
 * H4 修复：使用 vm 模块隔离执行动态工具代码，替代 new Function
 * - 创建沙箱上下文，仅暴露安全的 API
 * - 阻止原型链逃逸
 * - 限制执行超时
 */
function createSandboxedExecutor(code: string): (args: unknown) => Promise<string> {
  // 构建安全的沙箱上下文（仅暴露白名单 API）
  const sandbox = {
    // 安全的工具函数
    console: {
      log: (..._args: unknown[]) => { /* 静默日志，防止信息泄露 */ },
      error: (..._args: unknown[]) => { /* 静默错误日志 */ },
    },
    JSON: JSON,
    Math: Math,
    Date: Date,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Array: Array,
    Object: Object,
    RegExp: RegExp,
    Error: Error,
    Promise: Promise,
    // 不暴露 process/require/child_process/fs 等危险对象
  };

  // 创建 vm 上下文
  const context = vm.createContext(sandbox);

  // 编译并执行：将代码包装为 async 函数（修复 return 顶层语法错误）
  const getFnScript = new vm.Script(`
    (async (args) => {
      ${code}
    })
  `, { filename: 'dynamic-tool-fn.js' });

  const fn = getFnScript.runInContext(context, { timeout: 5000 });

  if (typeof fn !== 'function') {
    throw new Error('代码必须返回一个 async 函数');
  }

  // 返回包装函数：每次调用都在沙箱超时保护下执行
  return async (args: unknown): Promise<string> => {
    try {
      const result = await Promise.race([
        fn(args),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('工具执行超时（30秒）')), 30000)
        ),
      ]);
      return result;
    } catch (err: unknown) {
      return `工具执行错误: ${errMsg(err)}`;
    }
  };
}

export const dynamicTools: UnifiedToolDef[] = [
  {
    name: 'create_tool',
    description: '动态创建新的工具。用JavaScript代码定义工具的执行逻辑。代码必须是 async (args) => { ... } 形式，返回字符串结果。',
    parameters: {
      name: { type: 'string', description: '工具名称', required: true },
      description: { type: 'string', description: '工具描述', required: true },
      parameters: { type: 'string', description: '参数字符串（JSON格式）', required: true },
      code: { type: 'string', description: '执行代码 (async (args) => { ... })', required: true },
    },
    execute: async (args) => {
      const name = args.name as string;
      const description = args.description as string;
      const paramsStr = args.parameters as string;
      const code = args.code as string;
      if (!name || !description || !paramsStr || !code) return '错误: 请提供 name, description, parameters, code';

      // H4 修复：增强安全检查（多层防护）
      // 层1：危险模式检测（阻止字符串拼接绕过）
      const dangerousPatterns = [
        /\bprocess\b/, /\brequire\b/, /\bimport\b/, /\bchild_process\b/,
        /\beval\s*\(/, /\bFunction\s*\(/, /\b__dirname\b/, /\b__filename\b/,
        /\bglobal\b/, /\bglobalThis\b/, /\bwindow\b/, /\bdocument\b/,
        /\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
        /\bspawn\b/, /\bexec\b/, /\bexecFile\b/, /\bfork\b/,
        /\bfs\./, /\bos\./, /\bnet\./, /\bhttp\./, /\bhttps\./,
        /\bBuffer\b/, /\bstream\b/, /\bcrypto\b/,
        // 阻止原型链攻击
        /\b__proto__\b/, /\bprototype\b/, /\bconstructor\b/,
        // 阻止 this 绑定逃逸
        /\bthis\s*\[/,
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(code)) {
          return `安全限制: 代码包含不允许的模块或对象（${pattern.source}）。仅允许使用 console/JSON/Math/Date/String/Number/Boolean/Array/Object/RegExp/Error/Promise。`;
        }
      }

      // 层2：代码长度限制（防止超大代码攻击）
      if (code.length > 10000) {
        return '安全限制: 代码长度超过 10000 字符限制';
      }

      // 层3：工具名格式校验
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return '错误: 工具名必须以小写字母开头，仅包含小写字母、数字、下划线';
      }

      try {
        const params = JSON.parse(paramsStr);

        // H4 修复：使用 vm 沙箱替代 new Function
        const fn = createSandboxedExecutor(code);

        // 测试执行（传入测试参数）
        const testResult = await fn({ test: true });
        if (testResult === undefined) return '错误: 测试执行未返回结果';
        if (typeof testResult !== 'string') return '错误: 工具必须返回字符串结果';

        _dynamicTools.set(name, { name, description, parameters: params, execute: fn, readOnly: false });
        return `✅ 工具 "${name}" 已创建并注册（沙箱隔离模式）。可通过 list_tools 查看。`;
      } catch (err: unknown) { return `创建失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'list_tools',
    description: '列出所有可用工具（包括内置工具和动态创建的工具）',
    readOnly: true,
    parameters: {},
    execute: () => {
      const builtIn = getBuiltInTools().map(t => `  🔧 ${t.name}: ${(t.description || '').split('.')[0]}`);
      const dynamic = Array.from(_dynamicTools.values()).map((t: { name: string; description: string }) => `  ⚡ ${t.name}: ${t.description}`);
      return Promise.resolve(`📋 可用工具 (${builtIn.length + dynamic.length}个):\n\n内置工具:\n${builtIn.join('\n')}${dynamic.length ? '\n\n动态工具:\n' + dynamic.join('\n') : ''}`);
    },
  },
  {
    name: 'tool_install',
    description: '自动检测并安装项目所需的依赖包。支持npm/yarn/pnpm包管理器。',
    parameters: {
      packages: { type: 'string', description: '要安装的包名，多个用空格分隔', required: true },
      manager: { type: 'string', description: '包管理器: npm/yarn/pnpm，默认根据项目自动检测', required: false },
    },
    execute: async (args) => {
      const packages = args.packages as string;
      if (!packages) return '错误: 请提供要安装的包名';
      // 安全检查：包名只允许字母、数字、@、/、-、.、_
      const pkgList = packages.trim().split(/\s+/);
      const invalidPkg = pkgList.find(p => !/^[@a-zA-Z0-9._/-@]+$/.test(p));
      if (invalidPkg) return `安全限制: 包名 "${invalidPkg}" 包含非法字符`;
      try {
        let manager = (args.manager as string) || '';
        if (!manager) {
          let whichPnpm = '';
          try {
            const { stdout } = await execAsync('which pnpm 2>/dev/null || where pnpm 2>nul || echo ""', { encoding: 'utf-8', timeout: 5000 });
            whichPnpm = stdout.trim();
          } catch { /* 命令不存在，忽略 */ }
          if (whichPnpm) manager = 'pnpm';
          else {
            let whichYarn = '';
            try {
              const { stdout } = await execAsync('which yarn 2>/dev/null || where yarn 2>nul || echo ""', { encoding: 'utf-8', timeout: 5000 });
              whichYarn = stdout.trim();
            } catch { /* 命令不存在，忽略 */ }
            manager = whichYarn ? 'yarn' : 'npm';
          }
        }
        // 使用 execFile 而非 execSync 避免 shell 注入
        const { stdout: result } = await execFileAsync(manager, ['add', ...pkgList], { cwd: process.cwd(), encoding: 'utf-8', timeout: 120000 });
        return `✅ 安装完成 (${manager})\n${result.substring(0, 1000)}`;
      } catch (err: unknown) { return `安装失败: ${errMsg(err)}`; }
    },
  },
];
