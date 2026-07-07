import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { errMsg } from '../../core/utils.js';
import { matchSensitivePath } from '../../core/security-config.js';
import { createCheckpointBeforeModify } from '../../core/checkpoint-singleton.js';

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============ V17 代码语法验证 ============

/**
 * 验证代码文件语法
 * - .js/.mjs/.cjs: node --check
 * - .json: JSON.parse
 * - .ts/.tsx/.jsx: 括号匹配检查
 */
async function verifyCodeSyntax(filePath: string): Promise<{ ok: boolean; error?: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const jsExts = ['.js', '.mjs', '.cjs'];

  if (ext === '.json') {
    try {
      JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: `JSON 语法错误: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  if (jsExts.includes(ext)) {
    try {
      await execFileAsync('node', ['--check', filePath], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
      return { ok: true };
    } catch (err: unknown) {
      const e = err as { stderr?: unknown };
      const errMessage = err instanceof Error ? err.message : String(err);
      const stderr = e.stderr ? String(e.stderr).trim() : errMessage;
      return { ok: false, error: `node --check 失败: ${stderr}` };
    }
  }

  if (['.ts', '.tsx', '.jsx'].includes(ext)) {
    const issues = checkBracketBalance(await fs.promises.readFile(filePath, 'utf-8'));
    if (issues) return { ok: false, error: `括号不匹配: ${issues}` };
    return { ok: true };
  }

  return { ok: true };
}

/** 基础括号匹配检查（字符串/模板/注释感知） */
function checkBracketBalance(content: string): string | null {
  const stack: Array<{ char: string; line: number }> = [];
  const opens = new Set(['(', '[', '{']);
  const closes = new Set([')', ']', '}']);
  const reversePairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let inString = false, stringChar = '', inTemplate = false, inLineComment = false, inBlockComment = false, escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1] || '';
    const line = content.substring(0, i).split('\n').length;

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && (inString || inTemplate)) { escaped = true; continue; }
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') inBlockComment = false; continue; }
    if (inString) { if (ch === stringChar) inString = false; continue; }
    if (inTemplate) { if (ch === '`') inTemplate = false; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
    if (ch === '`') { inTemplate = true; continue; }

    if (opens.has(ch)) stack.push({ char: ch, line });
    else if (closes.has(ch)) {
      if (stack.length === 0) return `多余的闭合括号 '${ch}' 在第 ${line} 行`;
      const top = stack[stack.length - 1];
      if (top.char !== reversePairs[ch]) return `括号不匹配: '${top.char}' (第${top.line}行) 被 '${ch}' 闭合 (第${line}行)`;
      stack.pop();
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return `未闭合的括号 '${top.char}' 在第 ${top.line} 行`;
  }
  return null;
}

/**
 * V17 原子写入 + 写后验证：先写临时文件，验证通过后 rename
 * 验证失败则删除临时文件，不修改原文件
 * @export 供 tools.ts 等其他模块复用
 */
export async function atomicWriteWithVerify(targetPath: string, content: string): Promise<{ ok: boolean; verifyError?: string }> {
  const ext = path.extname(targetPath).toLowerCase();
  const codeExts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
  if (!codeExts.includes(ext)) {
    await fs.promises.writeFile(targetPath, content, 'utf-8');
    return { ok: true };
  }
  const tmpPath = targetPath + '.tmp.' + Date.now();
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    const result = await verifyCodeSyntax(tmpPath);
    if (!result.ok) {
      try { await fs.promises.unlink(tmpPath); } catch {}
      return { ok: false, verifyError: result.error };
    }
    await fs.promises.rename(tmpPath, targetPath);
    return { ok: true };
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

/**
 * 校验路径安全性：拦截敏感路径 + 工作区边界检查
 * @param inputPath 用户输入的路径
 * @param allowOutsideCwd 是否允许访问工作目录外的路径（默认false，强制工作区边界）
 * @returns { valid: boolean; resolved: string; error?: string }
 */
export function validateFilePath(
  inputPath: string,
  allowOutsideCwd: boolean = false
): { valid: boolean; resolved: string; error?: string } {
  if (!inputPath || typeof inputPath !== 'string') {
    return { valid: false, resolved: '', error: '路径不能为空' };
  }
  // 规范化路径（修复 M1: 路径校验未规范化，Windows 大小写可绕过）
  const resolved = path.resolve(inputPath).toLowerCase();
  const normalizedInput = inputPath.replace(/\\/g, '/').toLowerCase();

  // 1. 敏感路径黑名单检查（统一来源: security-config.ts）
  const matchedPattern = matchSensitivePath(inputPath);
  if (matchedPattern) {
    return { valid: false, resolved, error: `安全限制: 拒绝访问敏感路径 ${inputPath}` };
  }

  // 2. 工作区边界检查（防止 LLM 读取/写入任意绝对路径）
  if (!allowOutsideCwd) {
    const cwd = process.cwd().toLowerCase();
    const home = (process.env.HOME || process.env.USERPROFILE || '').toLowerCase();
    // 允许访问：工作目录内、用户主目录内的项目、系统临时目录
    const allowedRoots = [cwd];
    // 允许访问工作目录的父目录（用于 monorepo 场景），但不超过用户主目录
    if (home && cwd.startsWith(home)) {
      // 允许访问主目录下 2 层以内的路径（覆盖常见项目结构）
      const cwdRelative = cwd.substring(home.length).replace(/^[/\\]/, '');
      const parts = cwdRelative.split(/[/\\]/);
      if (parts.length >= 2) {
        const projectRoot = path.join(home, parts[0], parts[1]).toLowerCase();
        allowedRoots.push(projectRoot);
      }
    }
    // 系统临时目录允许访问
    // P0 跨平台修复：之前用 process.env.TMP || TEMP || '/tmp'，
    // macOS TMPDIR 是 /var/folders/...，Windows 无 TMP/TEMP 时回退 /tmp（无效）。
    // 现在用 os.tmpdir() 统一获取平台原生临时目录。
    const tmpDir = (process.env.TMP || process.env.TEMP || os.tmpdir()).toLowerCase();
    allowedRoots.push(tmpDir);

    const isAllowed = allowedRoots.some(root => resolved.startsWith(root));
    if (!isAllowed) {
      return {
        valid: false,
        resolved,
        error: `安全限制: 路径 ${inputPath} 超出工作区边界。仅允许访问工作目录、项目根目录和临时目录。`
      };
    }
  }

  // 3. 路径穿越检查（防止 .. 注入）
  if (normalizedInput.includes('../') || normalizedInput.includes('..\\')) {
    // 已通过 path.resolve 规范化，再检查是否逃逸工作区
    const cwd = process.cwd().toLowerCase();
    if (!resolved.startsWith(cwd) && !allowOutsideCwd) {
      return {
        valid: false,
        resolved,
        error: `安全限制: 路径穿越被拦截 ${inputPath}`
      };
    }
  }

  return { valid: true, resolved };
}

export const fileTools: UnifiedToolDef[] = [
  {
    name: 'file_read',
    description: '读取指定路径的文件内容。支持 offset/limit 参数分段读取大文件。',
    readOnly: true,
    parameters: {
      path: { type: 'string', description: '文件路径', required: true },
      offset: { type: 'number', description: '读取起始位置（字符偏移量），默认0', required: false },
      limit: { type: 'number', description: '读取字符数，默认16000，最大50000', required: false },
    },
    execute: async (args) => {
      try {
        const inputPath = args.path as string;
        if (!inputPath) return '❌ 缺少参数: path';
        // H1 修复：工作区边界检查
        const check = validateFilePath(inputPath, false);
        if (!check.valid) return `❌ ${check.error}`;
        if (!(await pathExists(check.resolved))) return `❌ 文件不存在: ${check.resolved}`;
        const stat = await fs.promises.stat(check.resolved);
        if (stat.isDirectory()) return `❌ 路径是目录而非文件: ${check.resolved}`;
        const content = await fs.promises.readFile(check.resolved, 'utf-8');
        // V17: 支持 offset/limit 分段读取
        const offset = typeof args.offset === 'number' ? args.offset : 0;
        const limit = typeof args.limit === 'number' ? args.limit : 16000;
        const maxLimit = 50000;
        const effectiveLimit = Math.min(limit, maxLimit);
        const totalLength = content.length;
        if (offset > 0) {
          const slice = content.substring(offset, offset + effectiveLimit);
          const hasNext = offset + effectiveLimit < totalLength;
          return slice + (hasNext ? `\n\n[分段读取：offset=${offset}, limit=${effectiveLimit}, 已读 ${offset + slice.length}/${totalLength} 字符。如需继续，使用 offset=${offset + effectiveLimit}]` : `\n\n[分段读取完成：offset=${offset}, 已读至文件末尾，共 ${totalLength} 字符]`);
        }
        const truncated = content.substring(0, effectiveLimit);
        if (totalLength > effectiveLimit) {
          return truncated + `\n\n[文件已截断：显示前 ${effectiveLimit} 字符，共 ${totalLength} 字符。如需查看后续内容，请使用 offset=${effectiveLimit} 参数继续读取]`;
        }
        return truncated;
      } catch (err: unknown) { return `读取失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'file_write',
    description: '将内容写入指定路径的文件',
    parameters: { path: { type: 'string', description: '文件路径', required: true }, content: { type: 'string', description: '文件内容', required: true } },
    execute: async (args) => {
      try {
        // V17 修复：参数名兼容（LLM 可能传递 path/filePath/filename 等变体）
        const inputPath = (args.path || args.filePath || args.filename || args.file_path || args.file) as string;
        let content: string;
        if (args.content !== undefined) content = args.content;
        else if (args.text !== undefined) content = args.text;
        else content = args.data;
        if (!inputPath) return '❌ 缺少参数: path';
        if (!content && content !== '') return '❌ 缺少参数: content（文件内容被截断，请重试）';
        // H1 修复：工作区边界检查
        const check = validateFilePath(inputPath, false);
        if (!check.valid) return `❌ ${check.error}`;

        // P0-3: 文件修改前自动创建 Checkpoint（对标 Claude Code）
        if (await pathExists(check.resolved)) {
          await createCheckpointBeforeModify([check.resolved], `file_write: ${path.basename(check.resolved)}`);
        }

        await fs.promises.mkdir(path.dirname(check.resolved), { recursive: true });
        // V17: 原子写入 + 写后语法验证（代码文件验证失败则不写入，返回错误）
        const writeResult = await atomicWriteWithVerify(check.resolved, content);
        if (!writeResult.ok) {
          return `❌ 文件写入成功但语法验证失败，已回滚未修改原文件。错误: ${writeResult.verifyError}\n请修复语法错误后重试。`;
        }
        return `写入成功: ${check.resolved} (${content.length} 字符)`;
      } catch (err: unknown) { return `写入失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'list_directory',
    description: '列出目录中的文件和子目录',
    readOnly: true,
    parameters: { path: { type: 'string', description: '目录路径，默认为当前目录', required: false } },
    execute: async (args) => {
      const dirPath = (args.path as string) || '.';
      try {
        // H1 修复：目录访问也需边界检查
        const check = validateFilePath(dirPath, false);
        if (!check.valid) return `❌ ${check.error}`;
        const entries = await fs.promises.readdir(check.resolved, { withFileTypes: true });
        const items: string[] = [];
        for (const e of entries) {
          const stats = await fs.promises.stat(path.join(check.resolved, e.name));
          items.push(`${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ` (${(stats.size / 1024).toFixed(1)}KB)`}`);
        }
        return `📂 ${check.resolved}\n\n${items.join('\n')}`;
      } catch (err: unknown) { return `列出失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'search_files',
    description: '在工作目录中按文件名搜索文件（支持 glob 模式，如 *.ts、*.tsx、test*）',
    readOnly: true,
    parameters: { pattern: { type: 'string', description: '文件名 glob 模式，如 *.ts、*.tsx、*test*', required: true } },
    execute: async (args) => {
      const pattern = (args.pattern as string) || '';
      if (!pattern) return '❌ 缺少参数: pattern';
      const results: string[] = [];
      // V17 修复：正确的 glob 匹配（替代错误的 includes）
      // 将 glob 模式转换为正则：* → [^/\\]*，? → [^/\\]
      const globToRegex = (glob: string): RegExp => {
        let regex = '^';
        for (const ch of glob) {
          if (ch === '*') regex += '[^/\\\\]*';
          else if (ch === '?') regex += '[^/\\\\]';
          else if ('.+^${}()|[]\\'.includes(ch)) regex += '\\' + ch;
          else regex += ch;
        }
        regex += '$';
        return new RegExp(regex, 'i');
      };
      const fileRegex = globToRegex(pattern);
      const search = async (dir: string, depth: number = 0) => {
        if (depth > 10) return; // 防止无限递归
        try {
          for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await search(full, depth + 1);
            else if (fileRegex.test(e.name)) results.push(full);
          }
        } catch {}
      };
      await search(process.cwd());
      const limited = results.slice(0, 50);
      return `🔍 找到 ${results.length} 个文件匹配 "${pattern}":\n${limited.join('\n')}${results.length > 50 ? `\n... 还有 ${results.length - 50} 个` : ''}`;
    },
  },
  {
    name: 'file_edit',
    description: '精确编辑文件局部内容（search-replace 模式）。找到 old_text 并替换为 new_text，避免整文件重写。参数支持 path/filePath/file_path/filename/file 任一名称。old_text 必须与文件中的内容完全匹配（包括缩进）。',
    parameters: {
      path: { type: 'string', description: '文件路径', required: true },
      old_text: { type: 'string', description: '要替换的原文（必须精确匹配，包括缩进和换行）', required: true },
      new_text: { type: 'string', description: '替换后的新文本', required: true },
    },
    execute: async (args) => {
      try {
        // V17 参数名兼容
        const inputPath = (args.path || args.filePath || args.filename || args.file_path || args.file) as string;
        const oldText = (args.old_text || args.oldText || args.search || args.find) as string;
        const newText = (args.new_text || args.newText || args.replace || args.replacement) as string;
        if (!inputPath) return '❌ 缺少参数: path';
        if (oldText === undefined || oldText === null) return '❌ 缺少参数: old_text';
        if (newText === undefined || newText === null) return '❌ 缺少参数: new_text';

        const check = validateFilePath(inputPath, false);
        if (!check.valid) return `❌ ${check.error}`;
        if (!(await pathExists(check.resolved))) return `❌ 文件不存在: ${check.resolved}`;

        // 修改前创建 Checkpoint
        await createCheckpointBeforeModify([check.resolved], `file_edit: ${path.basename(check.resolved)}`);

        const content = await fs.promises.readFile(check.resolved, 'utf-8');
        const occurrences = content.split(oldText).length - 1;

        if (occurrences === 0) {
          return `❌ 未找到匹配的文本。请检查 old_text 是否与文件内容完全一致（包括缩进和换行）。文件共 ${content.length} 字符。`;
        }
        if (occurrences > 1 && !args.replace_all) {
          return `❌ 找到 ${occurrences} 处匹配。请提供更长的 old_text 以确保唯一匹配，或设置 replace_all=true 替换所有。`;
        }

        const newContent = args.replace_all
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);

        // V17: 原子写入 + 写后语法验证（代码文件验证失败则不修改原文件）
        const editResult = await atomicWriteWithVerify(check.resolved, newContent);
        if (!editResult.ok) {
          return `❌ 编辑后语法验证失败，已回滚未修改原文件。错误: ${editResult.verifyError}\n请检查 new_text 的语法，修复后重试。`;
        }
        return `✅ 编辑成功: ${check.resolved} (替换 ${args.replace_all ? occurrences : 1} 处，文件 ${content.length}→${newContent.length} 字符)`;
      } catch (err: unknown) { return `编辑失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'grep_search',
    description: '在文件内容中搜索匹配正则表达式的行（类似 grep/ripgrep）。用于查找代码实现、函数定义、变量引用等。支持多扩展名过滤(如 "*.ts, *.tsx")。',
    readOnly: true,
    parameters: {
      pattern: { type: 'string', description: '正则表达式模式', required: true },
      path: { type: 'string', description: '搜索目录路径，默认当前目录', required: false },
      include: { type: 'string', description: '文件名过滤，如 *.ts 或 *.ts, *.tsx', required: false },
      max_results: { type: 'number', description: '最大返回结果数，默认50', required: false },
      max_depth: { type: 'number', description: '最大递归深度，默认10', required: false },
    },
    execute: async (args) => {
      try {
        const pattern = args.pattern as string;
        const searchDir = (args.path as string) || process.cwd();
        const include = args.include as string | undefined;
        const maxResults = (args.max_results as number) || 50;
        const maxDepth = (args.max_depth as number) || 10;
        const maxFileSize = 5 * 1024 * 1024; // 5MB

        if (!pattern) return '❌ 缺少参数: pattern';

        const check = validateFilePath(searchDir, false);
        if (!check.valid) return `❌ ${check.error}`;

        let regex: RegExp;
        try {
          regex = new RegExp(pattern, 'i');
        } catch {
          return `❌ 无效的正则表达式: ${pattern}`;
        }

        const results: Array<{ file: string; line: number; text: string }> = [];
        // V17: 支持多扩展名
        const includeExts = include
          ? include.split(/[,\s]+/).map(s => s.replace(/\*/g, '').toLowerCase()).filter(s => s)
          : null;

        const searchInDir = async (dir: string, depth: number) => {
          if (results.length >= maxResults) return;
          if (depth > maxDepth) return; // V17: 递归深度限制
          try {
            for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
              if (results.length >= maxResults) break;
              if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                await searchInDir(full, depth + 1);
              } else if (e.isFile()) {
                // V17: 多扩展名过滤
                if (includeExts) {
                  const fileExt = e.name.toLowerCase();
                  const matched = includeExts.some(ext => fileExt.endsWith(ext));
                  if (!matched) continue;
                }
                // 跳过二进制文件
                if (/\.(png|jpg|jpeg|gif|bmp|ico|woff|woff2|ttf|eot|zip|tar|gz|exe|dll|so|dylib|class|jar|wasm)$/.test(e.name)) continue;
                // V17: 文件大小限制
                try {
                  const stat = await fs.promises.stat(full);
                  if (stat.size > maxFileSize) continue;
                } catch { continue; }
                try {
                  const content = await fs.promises.readFile(full, 'utf-8');
                  const lines = content.split('\n');
                  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                    if (regex.test(lines[i])) {
                      results.push({ file: full, line: i + 1, text: lines[i].trim().substring(0, 200) });
                    }
                  }
                } catch {}
              }
            }
          } catch {}
        };

        await searchInDir(check.resolved, 0);

        if (results.length === 0) {
          return `🔍 未找到匹配 "${pattern}" 的内容`;
        }

        const output = results.map(r => `${r.file}:${r.line}: ${r.text}`).join('\n');
        return `🔍 找到 ${results.length} 处匹配 "${pattern}":\n${output}`;
      } catch (err: unknown) { return `搜索失败: ${errMsg(err)}`; }
    },
  },
];
