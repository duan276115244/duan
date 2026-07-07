import * as fs from 'fs';
import * as path from 'path';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { atomicWriteJson } from '../../core/atomic-write.js';

export const sessionTools: UnifiedToolDef[] = [
  {
    name: 'self_session',
    description: '保存或恢复会话状态到文件，支持跨会话的上下文保持。保存所有消息历史，可在后续会话中恢复。',
    parameters: {
      action: { type: 'string', description: '操作: save/load/list/delete', required: true },
      name: { type: 'string', description: '会话名称 (save/load/delete时需要)', required: false },
    },
    execute: async (args) => {
      const sessionsDir = path.join(process.cwd(), '.sessions');
      await fs.promises.mkdir(sessionsDir, { recursive: true });
      const act = args.action as string;
      const name = args.name as string || `session-${Date.now()}`;
      try {
        if (act === 'list') {
          const files = (await fs.promises.readdir(sessionsDir)).filter(f => f.endsWith('.json')).sort().reverse();
          if (files.length === 0) return '📂 无已保存的会话';
          const stats = await Promise.all(
            files.map(async f => {
              const stat = await fs.promises.stat(path.join(sessionsDir, f));
              return { f, size: (stat.size / 1024).toFixed(1) };
            }),
          );
          return stats.map(({ f, size }) => `  📄 ${f.replace('.json', '')} (${size}KB)`).join('\n');
        }
        if (act === 'save') {
          const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
          const filePath = path.join(sessionsDir, `${safeName}.json`);
          try {
            await fs.promises.access(filePath);
          } catch {
            await atomicWriteJson(filePath, { savedAt: new Date().toISOString(), messages: [], tokensUsed: 0, totalCost: 0, turnCount: 0 });
          }
          return `✅ 会话已保存: ${safeName}`;
        }
        if (act === 'load') {
          const filePath = path.join(sessionsDir, `${name}.json`);
          try {
            await fs.promises.access(filePath);
          } catch {
            return `❌ 会话 "${name}" 不存在`;
          }
          const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
          return JSON.stringify({ type: 'session_restore', messages: data.messages, name, tokensUsed: data.tokensUsed, totalCost: data.totalCost });
        }
        if (act === 'delete') {
          const filePath = path.join(sessionsDir, `${name}.json`);
          try {
            await fs.promises.access(filePath);
          } catch {
            return `❌ 会话 "${name}" 不存在`;
          }
          await fs.promises.rm(filePath);
          return `🗑️ 已删除会话 "${name}"`;
        }
        return '用法: action=save|list|load|delete [name]';
      } catch (err: unknown) { return `操作失败: ${errMsg(err)}`; }
    },
  },
];
