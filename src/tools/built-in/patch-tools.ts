import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { createCheckpointBeforeModify } from '../../core/checkpoint-singleton.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function fuzzyMatchLines(oldLines: string[], fileLines: string[], startIdx: number): number | null {
  const normalizePunct = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2013/g, '-').replace(/\u2014/g, '--').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const matchers = [
    (line: string) => line, (line: string) => line.trimEnd(),
    (line: string) => line.trim(), (line: string) => normalizePunct(line),
  ];
  for (let i = startIdx; i < fileLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (i + j >= fileLines.length) { allMatch = false; break; }
      const fileLine = fileLines[i + j];
      const match = matchers.some(m => m(fileLine) === m(oldLines[j]));
      if (!match) { allMatch = false; break; }
    }
    if (allMatch) return i;
  }
  return null;
}

export const patchTools: UnifiedToolDef[] = [
  {
    name: 'self_patch',
    description: '对项目文件应用精准修改。支持多hunk patch格式：*** Update File: path @@ context 旧行 --- 新行。支持新建/删除/移动文件。自动备份和模糊匹配。比self_write更精确。',
    parameters: {
      patch: { type: 'string', description: 'Patch内容，格式:\n*** Add File: path\n文件内容\n*** End of File\n\n或:\n*** Update File: path\n@@ 上下文\n旧行\n---\n新行\n\n或:\n*** Delete File: path', required: true },
    },
    execute: async (args) => {
      const patch = args.patch as string;
      if (!patch) return '错误: 请提供patch内容';
      const projectRoot = process.cwd();
      const results: string[] = [];
      const blocks = patch.split(/(?=\*\*\* (?:Add|Update|Delete) File:)/);
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        const addMatch = trimmed.match(/^\*\*\* Add File: (.+?)[\r\n]+([\s\S]*?)(?:\*\*\* End of File)?$/);
        const updateMatch = trimmed.match(/^\*\*\* Update File: (.+?)[\r\n]+([\s\S]*?)$/);
        const deleteMatch = trimmed.match(/^\*\*\* Delete File: (.+?)$/);
        try {
          if (addMatch) {
            const filePath = path.resolve(projectRoot, addMatch[1].trim());
            if (!filePath.startsWith(projectRoot)) { results.push(`❌ ${addMatch[1].trim()}: 路径越界`); continue; }
            if (await pathExists(filePath)) { results.push(`⚠️ ${addMatch[1].trim()}: 文件已存在，跳过创建`); continue; }
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.writeFile(filePath, addMatch[2].trimEnd() + '\n', 'utf-8');
            results.push(`✅ ${addMatch[1].trim()}: 新建成功`);
          } else if (deleteMatch) {
            const filePath = path.resolve(projectRoot, deleteMatch[1].trim());
            if (!filePath.startsWith(projectRoot)) { results.push(`❌ ${deleteMatch[1].trim()}: 路径越界`); continue; }
            if (!(await pathExists(filePath))) { results.push(`⚠️ ${deleteMatch[1].trim()}: 文件不存在`); continue; }
            // P0-3: 删除前创建 Checkpoint（对标 Claude Code）
            await createCheckpointBeforeModify([filePath], `self_patch delete: ${deleteMatch[1].trim()}`);
            const backupPath = filePath + '.backup.' + Date.now();
            await fs.promises.copyFile(filePath, backupPath);
            await fs.promises.rm(filePath);
            results.push(`✅ ${deleteMatch[1].trim()}: 已删除 (备份: ${path.basename(backupPath)})`);
          } else if (updateMatch) {
            const filePath = path.resolve(projectRoot, updateMatch[1].trim());
            if (!filePath.startsWith(projectRoot)) { results.push(`❌ ${updateMatch[1].trim()}: 路径越界`); continue; }
            if (!(await pathExists(filePath))) { results.push(`❌ ${updateMatch[1].trim()}: 文件不存在`); continue; }
            // P0-3: 更新前创建 Checkpoint（对标 Claude Code）
            await createCheckpointBeforeModify([filePath], `self_patch update: ${updateMatch[1].trim()}`);
            const backupPath = filePath + '.backup.' + Date.now();
            await fs.promises.copyFile(filePath, backupPath);
            const content = updateMatch[2];
            const hunks = content.split(/(?=@@)/).filter(h => h.trim());
            const fileLines = (await fs.promises.readFile(filePath, 'utf-8')).split('\n');
            const replacements: Array<{ start: number; end: number; newLines: string[] }> = [];
            let allApplied = true;
            for (const hunk of hunks) {
              const hunkTrimmed = hunk.trim();
              if (!hunkTrimmed) continue;
              const lines = hunkTrimmed.split('\n');
              const contextLine = lines[0].startsWith('@@') ? lines[0].replace(/^@@\s*/, '').replace(/\s*@@$/, '').trim() : '';
              const sepIdx = lines.findIndex(l => l.trim() === '---');
              if (sepIdx === -1) { results.push('⚠️ hunk缺少分隔符 "---"'); continue; }
              const oldLines = lines.slice(1, sepIdx).filter(l => !l.startsWith('@@')).map(l => l);
              const newLines = lines.slice(sepIdx + 1).map(l => l);
              if (oldLines.length === 0 && newLines.length === 0) continue;
              let found = false;
              for (let si = 0; si <= fileLines.length - oldLines.length; si++) {
                if (oldLines.length === 0) {
                  if (contextLine && !fileLines[si]?.includes(contextLine)) continue;
                  replacements.push({ start: si, end: si, newLines }); found = true; break;
                }
                const matchIdx = fuzzyMatchLines(oldLines, fileLines, si);
                if (matchIdx !== null) { replacements.push({ start: matchIdx, end: matchIdx + oldLines.length, newLines }); found = true; break; }
              }
              if (!found) { results.push(`⚠️ 未匹配到: ${contextLine || oldLines[0]?.substring(0, 40)}`); allApplied = false; }
            }
            if (replacements.length === 0 && !allApplied) { results.push(`❌ ${updateMatch[1].trim()}: 所有hunk均未匹配`); continue; }
            replacements.sort((a, b) => b.start - a.start);
            for (const r of replacements) fileLines.splice(r.start, r.end - r.start, ...r.newLines);
            await fs.promises.writeFile(filePath, fileLines.join('\n'), 'utf-8');
            const appCount = replacements.filter(r => r.newLines.length > 0 || r.start !== r.end).length;
            results.push(`✅ ${updateMatch[1].trim()}: 应用了 ${appCount}/${hunks.length} 个hunk (备份: ${path.basename(backupPath)})`);
          } else { results.push('⚠️ 无法识别的patch块'); }
        } catch (err: unknown) { results.push(`❌ 错误: ${err instanceof Error ? err.message : String(err)}`); }
      }
      return results.join('\n');
    },
  },
];
