import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';

export const fixTools: UnifiedToolDef[] = [
  {
    name: 'self_fix',
    description: 'LLM驱动的智能代码修复。分析编译错误，自动生成修复方案并验证。',
    parameters: { file: { type: 'string', description: '要修复的文件路径（可选，不填则自动检测全部错误）', required: false } },
    execute: async (args) => {
      const file = args.file as string;
      try {
        const { stdout: tscResult } = await execAsync('npx tsc --noEmit --skipLibCheck 2>&1 || true', { cwd: process.cwd(), encoding: 'utf-8', timeout: 120000 });
        const ownErrors = tscResult.split('\n').filter(l => !l.includes('node_modules') && l.includes('error TS'));
        if (ownErrors.length === 0) return '✅ 无编译错误';
        const filtered = file ? ownErrors.filter(e => e.includes(file)) : ownErrors;
        if (filtered.length === 0) return `✅ 文件 "${file}" 无编译错误`;
        const modelLib = toolContext.modelLibrary;
        if (!modelLib) return `发现 ${filtered.length} 个错误，但LLM修复功能需要 modelLibrary 初始化。\n\n前5个错误:\n${filtered.slice(0, 5).join('\n')}`;
        const available = modelLib.getAvailableModels();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clients = (modelLib as any).clients as Map<string, any>;
        if (!clients || clients.size === 0) return `未找到可用的LLM客户端，无法自动修复。\n\n错误:\n${filtered.slice(0, 5).join('\n')}`;
        const firstEntry = clients.entries().next().value;
        if (!firstEntry) return `未找到LLM客户端。\n\n错误:\n${filtered.slice(0, 5).join('\n')}`;
        const [modelId, client] = firstEntry;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = available.find((m: any) => m.id === modelId);
        const errorContext = filtered.slice(0, 10).join('\n');
        const resp = await client.chat.completions.create({
          model: entry?.model || modelId,
          messages: [
            { role: 'system', content: '你是一个TypeScript修复专家。分析编译错误并给出修复方案。请直接返回需要修改的代码，不要解释。' },
            { role: 'user', content: `修复以下TypeScript编译错误:\n${errorContext}` },
          ],
          max_tokens: 2000,
        });
        const fix = resp.choices?.[0]?.message?.content || '';
        return `🤖 LLM修复建议:\n${fix.substring(0, 3000)}\n\n---\n请使用 self_patch 或 self_write 应用修复，然后运行 self_test 验证。`;
      } catch (err: unknown) { return `修复分析失败: ${errMsg(err)}`; }
    },
  },
];
