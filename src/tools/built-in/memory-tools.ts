import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { duanPath } from '../../core/duan-paths.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

// P0 跨平台修复：使用统一的 duanPath 解析（默认 ~/.duan，可用 DUAN_DATA_DIR 覆盖）
const MEMORY_DIR = duanPath('memories');
const MAX_MEMORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface MemEntry {
  id: string; timestamp: number; type: string; content: string;
  tags: string[]; importance: number; accessCount: number;
}

async function ensureMemoryDir() { await fs.promises.mkdir(MEMORY_DIR, { recursive: true }); }

async function loadMemories(): Promise<MemEntry[]> {
  try {
    await ensureMemoryDir();
    const files = (await fs.promises.readdir(MEMORY_DIR)).filter(f => f.endsWith('.json'));
    const entries = await mapWithConcurrency(files, 8, async f => {
      try { return JSON.parse(await fs.promises.readFile(path.join(MEMORY_DIR, f), 'utf-8')); } catch { return null; }
    });
    return entries.filter(Boolean) as MemEntry[];
  } catch { return []; }
}

async function saveMemory(entry: MemEntry) {
  await ensureMemoryDir();
  await fs.promises.writeFile(path.join(MEMORY_DIR, `${entry.id}.json`), JSON.stringify(entry), 'utf-8');
}

async function searchMemories(query: string, limit: number): Promise<MemEntry[]> {
  const q = query.toLowerCase();
  return (await loadMemories())
    .map(m => ({ ...m, score: (m.content.toLowerCase().includes(q) ? 2 : 0) + (m.tags.some(t => t.toLowerCase().includes(q)) ? 1 : 0) + m.importance / 10 }))
    .filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function getRecentMemories(hours: number, limit: number): Promise<MemEntry[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return (await loadMemories()).filter(m => m.timestamp > cutoff).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

async function getImportantMemories(limit: number): Promise<MemEntry[]> {
  return (await loadMemories()).sort((a, b) => b.importance - a.importance).slice(0, limit);
}

export const memoryTools: UnifiedToolDef[] = [
  {
    name: 'self_memory',
    description: '持久化记忆系统。存储和检索重要信息、经验教训、用户偏好、模式识别。记忆跨会话持久保存，让Agent越来越了解用户和项目。',
    parameters: {
      action: { type: 'string', description: '操作: add/search/recent/important/forget', required: true },
      content: { type: 'string', description: '记忆内容 (add时需要)', required: false },
      type: { type: 'string', description: '类型: insight/fact/preference/mistake/achievement/pattern/goal (add时需要)', required: false },
      tags: { type: 'string', description: '标签，逗号分隔 (add时需要)', required: false },
      importance: { type: 'string', description: '重要度 1-10 (add时可选，默认5)', required: false },
      query: { type: 'string', description: '搜索关键词 (search时需要)', required: false },
      limit: { type: 'string', description: '返回条数，默认5', required: false },
    },
    execute: async (args) => {
      await ensureMemoryDir();
      const act = args.action as string;
      const limit = parseInt(args.limit as string) || 5;
      try {
        if (act === 'add') {
          if (!args.content || !args.type) return '错误: 需要 content 和 type';
          const entry: MemEntry = {
            id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            timestamp: Date.now(),
            type: args.type as string,
            content: args.content as string,
            tags: ((args.tags as string) || '').split(',').map((t: string) => t.trim()).filter(Boolean),
            importance: Math.min(10, Math.max(1, parseInt(args.importance as string) || 5)),
            accessCount: 1,
          };
          await saveMemory(entry);
          const total = (await loadMemories()).length;
          return `✅ 记忆已存储 (${entry.type}, 重要度${entry.importance})。当前共${total}条记忆。`;
        }
        if (act === 'search') {
          if (!args.query) return '错误: 需要 query';
          const results = await searchMemories(args.query as string, limit);
          if (results.length === 0) return '🔍 未找到相关记忆';
          return results.map(m =>
            `  [${m.type}] ${m.content.substring(0, 120)} (重要度: ${m.importance}/10)`
          ).join('\n');
        }
        if (act === 'recent') {
          const recent = await getRecentMemories(48, limit);
          if (recent.length === 0) return '📭 最近48小时无新记忆';
          return recent.map(m =>
            `  [${m.type}] ${m.content.substring(0, 100)}`
          ).join('\n');
        }
        if (act === 'important') {
          const important = await getImportantMemories(limit);
          if (important.length === 0) return '📭 无高重要度记忆';
          return important.map(m =>
            `  ⭐ [${m.type}] ${m.content.substring(0, 120)} (重要度: ${m.importance}/10)`
          ).join('\n');
        }
        if (act === 'forget') {
          const all = await loadMemories();
          const before = all.length;
          const cutoff = Date.now() - MAX_MEMORY_AGE_MS;
          for (const m of all) {
            if (m.timestamp < cutoff && m.importance < 4) {
              try { await fs.promises.rm(path.join(MEMORY_DIR, `${m.id}.json`)); } catch {}
            }
          }
          return `🧹 已清理低重要度过期记忆 (${before} → ${(await loadMemories()).length}条)`;
        }
        return '用法: action=add|search|recent|important|forget';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `操作失败: ${msg}`;
      }
    },
  },
];
