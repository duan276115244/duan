import fs from 'fs';
import path from 'path';
import * as vm from 'vm';
import { errMsg } from './app-context.js';
import type { ToolDef } from '../../core/unified-tool-def.js';
import type { ScalableToolRegistry } from '../../core/scalable-tool-registry.js';
import { matchSensitivePath, matchDangerousCommand } from '../../core/security-config.js';
import { atomicWriteWithVerify } from '../../tools/built-in/file-tools.js';

/** 敏感路径检测（统一来源: security-config.ts） */
function isSensitivePath(p: string): boolean {
  return matchSensitivePath(p) !== null;
}

/** 危险命令检测（统一来源: security-config.ts） */
function isDangerousCommand(cmd: string): boolean {
  return matchDangerousCommand(cmd) !== null;
}

/** 代码安全检查 — 阻止访问危险全局对象 */
function isUnsafeCode(code: string): boolean {
  const dangerous = [
    /\bprocess\b/, /\brequire\b/, /\bimport\b/, /\b__dirname\b/, /\b__filename\b/,
    /\beval\s*\(/, /\bFunction\s*\(/, /\bglobal\b/, /\bglobalThis\b/,
    /\bchild_process\b/, /\bfs\b/, /\bnet\b/, /\bhttp\b/, /\bhttps\b/,
    /\bos\b/, /\bpath\b/, /\bcrypto\b/, /\bBuffer\b/, /\bstream\b/,
  ];
  return dangerous.some(p => p.test(code));
}

export const tools: ToolDef[] = [
  {
    name: 'code_execute',
    description: '在安全沙箱中执行JavaScript代码并返回结果。仅支持纯计算，无文件/网络访问。',
    parameters: {
      code: { type: 'string', description: '要执行的JavaScript代码', required: true },
    },
    execute: async (args) => {
      const code = args.code as string;
      if (isUnsafeCode(code)) {
        return '安全限制: 代码包含不允许的模块或全局对象（process/require/fs等）';
      }
      if (code.length > 10000) {
        return '安全限制: 代码长度超过 10000 字符限制';
      }
      try {
        // 使用 vm 沙箱替代 new Function（修复 RCE 风险）
        const sandbox = {
          console: { log: () => {}, error: () => {} },
          JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, Promise,
        };
        const context = vm.createContext(sandbox);
        const script = new vm.Script(`(async () => { ${code} })()`, { filename: 'code-execute.js' });
        const promise = script.runInContext(context, { timeout: 5000 }) as Promise<unknown>;
        // 定时器泄漏修复：Promise.race 完成后立即清理 setTimeout，避免 10s 内定时器句柄滞留
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('代码执行超时（10秒）')), 10000);
            }),
          ]);
          return JSON.stringify(result, null, 2);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      } catch (err) {
        return `执行错误: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'file_read',
    description: '读取指定路径的文件内容。支持 offset/limit 参数分段读取大文件。',
    parameters: {
      path: { type: 'string', description: '文件路径（绝对或相对路径）', required: true },
      offset: { type: 'number', description: '读取起始位置（字符偏移量），默认0' },
      limit: { type: 'number', description: '读取字符数，默认16000，最大50000' },
    },
    execute: async (args) => {
      const filePath = args.path as string;
      try {
        const resolved = path.resolve(filePath);
        if (isSensitivePath(resolved)) return '安全限制: 拒绝访问敏感路径';
        const stat = await fs.promises.stat(resolved);
        if (stat.size > 10 * 1024 * 1024) return '错误: 文件超过10MB大小限制';
        const content = await fs.promises.readFile(resolved, 'utf-8');
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
      } catch (err) {
        return `读取失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'file_write',
    description: '将内容写入指定路径的文件（自动创建父目录）',
    parameters: {
      path: { type: 'string', description: '文件路径（绝对或相对路径）', required: true },
      content: { type: 'string', description: '文件内容', required: true },
    },
    execute: async (args) => {
      // V17 修复：参数名兼容
      const filePath = (args.path || args.filePath || args.filename || args.file_path || args.file) as string;
      let content: string;
      if (args.content !== undefined) content = args.content;
      else if (args.text !== undefined) content = args.text;
      else content = args.data;
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return '❌ file_write 需要提供 path 参数（文件路径）';
      }
      if (typeof content !== 'string') {
        return '❌ file_write 需要提供 content 参数（文件内容）';
      }
      try {
        const resolved = path.resolve(filePath);
        if (isSensitivePath(resolved)) return '安全限制: 拒绝访问敏感路径';
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        // V17: 原子写入 + 写后语法验证
        const writeResult = await atomicWriteWithVerify(resolved, content);
        if (!writeResult.ok) {
          return `❌ 文件写入成功但语法验证失败，已回滚未修改原文件。错误: ${writeResult.verifyError}\n请修复语法错误后重试。`;
        }
        return '✅ 文件写入成功';
      } catch (err) {
        return `写入失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'list_directory',
    description: '列出指定目录的内容',
    parameters: {
      path: { type: 'string', description: '目录路径', required: true },
    },
    execute: async (args) => {
      const dirPath = args.path as string;
      try {
        const resolved = path.resolve(dirPath);
        const items = await fs.promises.readdir(resolved, { withFileTypes: true });
        return items.map(item => {
          const prefix = item.isDirectory() ? '📁' : '📄';
          return `${prefix} ${item.name}`;
        }).join('\n');
      } catch (err) {
        return `列出目录失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'search_files',
    description: '在指定目录中搜索文件（支持 glob 通配符，如 *.ts、*.tsx、test*）',
    parameters: {
      pattern: { type: 'string', description: '文件名 glob 模式，如 *.ts', required: true },
      root: { type: 'string', description: '搜索根目录', required: false },
    },
    execute: async (args) => {
      const pattern = (args.pattern as string) || '';
      const root = (args.root as string) || '.';
      if (!pattern) return '❌ 缺少参数: pattern';
      try {
        const resolved = path.resolve(root);
        // V17 修复：正确的 glob 匹配
        const globToRegex = (glob: string): RegExp => {
          let r = '^';
          for (const ch of glob) {
            if (ch === '*') r += '[^/\\\\]*';
            else if (ch === '?') r += '[^/\\\\]';
            else if ('.+^${}()|[]\\'.includes(ch)) r += '\\' + ch;
            else r += ch;
          }
          return new RegExp(r + '$', 'i');
        };
        const fileRegex = globToRegex(pattern);
        const results: string[] = [];
        const walkDir = async (dir: string, depth: number = 0) => {
          if (depth > 10) return;
          let entries: fs.Dirent[];
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) { await walkDir(fullPath, depth + 1); }
            else if (fileRegex.test(entry.name)) results.push(fullPath);
          }
        };
        await walkDir(resolved);
        const limited = results.slice(0, 50);
        return limited.length > 0
          ? `🔍 找到 ${results.length} 个文件匹配 "${pattern}":\n${limited.join('\n')}${results.length > 50 ? `\n... 还有 ${results.length - 50} 个` : ''}`
          : `未找到匹配 "${pattern}" 的文件`;
      } catch (err) {
        return `搜索失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'file_edit',
    description: '精确编辑文件局部内容（search-replace 模式）。找到 old_text 并替换为 new_text，避免整文件重写。参数支持 path/filePath/file_path/filename/file 任一名称。',
    parameters: {
      path: { type: 'string', description: '文件路径', required: true },
      old_text: { type: 'string', description: '要替换的原文（必须精确匹配）', required: true },
      new_text: { type: 'string', description: '替换后的新文本', required: true },
      replace_all: { type: 'boolean', description: '是否替换所有匹配，默认false', required: false },
    },
    execute: async (args) => {
      const filePath = (args.path || args.filePath || args.filename || args.file_path || args.file) as string;
      const oldText = (args.old_text || args.oldText || args.search || args.find) as string;
      const newText = (args.new_text || args.newText || args.replace || args.replacement) as string;
      if (!filePath) return '❌ 缺少参数: path';
      if (oldText === undefined || oldText === null) return '❌ 缺少参数: old_text';
      if (newText === undefined || newText === null) return '❌ 缺少参数: new_text';
      try {
        const resolved = path.resolve(filePath);
        if (isSensitivePath(resolved)) return '安全限制: 拒绝访问敏感路径';
        try { await fs.promises.access(resolved); } catch { return `❌ 文件不存在: ${resolved}`; }
        const content = await fs.promises.readFile(resolved, 'utf-8');
        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) {
          return `❌ 未找到匹配的文本。请检查 old_text 是否精确匹配（包括缩进和换行）。文件共 ${content.length} 字符。`;
        }
        if (occurrences > 1 && !args.replace_all) {
          return `❌ 找到 ${occurrences} 处匹配。请提供更长的 old_text 确保唯一，或设置 replace_all=true。`;
        }
        const newContent = args.replace_all
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);
        // V17: 原子写入 + 写后语法验证
        const editResult = await atomicWriteWithVerify(resolved, newContent);
        if (!editResult.ok) {
          return `❌ 编辑后语法验证失败，已回滚未修改原文件。错误: ${editResult.verifyError}\n请检查 new_text 的语法，修复后重试。`;
        }
        return `✅ 编辑成功: ${resolved} (替换 ${args.replace_all ? occurrences : 1} 处，${content.length}→${newContent.length} 字符)`;
      } catch (err) {
        return `编辑失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'grep_search',
    description: '在文件内容中搜索匹配正则表达式的行（类似 grep/ripgrep）。用于查找代码实现、函数定义等。支持多扩展名过滤(如 "*.ts, *.tsx")。',
    parameters: {
      pattern: { type: 'string', description: '正则表达式模式', required: true },
      path: { type: 'string', description: '搜索目录，默认当前目录', required: false },
      include: { type: 'string', description: '文件名过滤，如 *.ts 或 *.ts, *.tsx', required: false },
      max_results: { type: 'number', description: '最大结果数，默认50', required: false },
      max_depth: { type: 'number', description: '最大递归深度，默认10', required: false },
    },
    execute: async (args) => {
      const pattern = args.pattern as string;
      if (!pattern) return '❌ 缺少参数: pattern';
      const searchDir = path.resolve((args.path as string) || '.');
      if (isSensitivePath(searchDir)) return '安全限制: 拒绝访问敏感路径';
      const include = args.include as string | undefined;
      const maxResults = (args.max_results as number) || 50;
      const maxDepth = (args.max_depth as number) || 10;
      const maxFileSize = 5 * 1024 * 1024; // 5MB
      let regex: RegExp;
      try { regex = new RegExp(pattern, 'i'); } catch { return `❌ 无效正则: ${pattern}`; }
      const results: string[] = [];
      // V17: 支持多扩展名
      const includeExts = include
        ? include.split(/[,\s]+/).map(s => s.replace(/\*/g, '').toLowerCase()).filter(s => s)
        : null;
      const walk = async (dir: string, depth: number) => {
        if (results.length >= maxResults) return;
        if (depth > maxDepth) return; // V17: 递归深度限制
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (results.length >= maxResults) break;
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full, depth + 1);
            else if (e.isFile()) {
              // V17: 多扩展名过滤
              if (includeExts) {
                const fileExt = e.name.toLowerCase();
                const matched = includeExts.some(ext => fileExt.endsWith(ext));
                if (!matched) continue;
              }
              if (/\.(png|jpg|jpeg|gif|bmp|ico|woff|woff2|ttf|eot|zip|tar|gz|exe|dll|so|class|jar|wasm)$/.test(e.name)) continue;
              // V17: 文件大小限制
              try {
                const stat = await fs.promises.stat(full);
                if (stat.size > maxFileSize) continue;
              } catch { continue; }
              try {
                const text = await fs.promises.readFile(full, 'utf-8');
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                  if (regex.test(lines[i])) results.push(`${full}:${i + 1}: ${lines[i].trim().substring(0, 200)}`);
                }
              } catch {}
            }
          }
        } catch {}
      };
      await walk(searchDir, 0);
      return results.length > 0
        ? `🔍 找到 ${results.length} 处匹配 "${pattern}":\n${results.join('\n')}`
        : `🔍 未找到匹配 "${pattern}" 的内容`;
    },
  },
  {
    name: 'shell_execute',
    description: '在系统中执行Shell命令并返回结果。V17跨平台兼容：自动转换Unix命令为Windows格式，智能超时。',
    parameters: {
      command: { type: 'string', description: '要执行的Shell命令（支持Unix和Windows语法）', required: true },
      timeout: { type: 'number', description: '超时时间(ms)，默认60000。npm install自动延长到300000' },
    },
    execute: async (args) => {
      const command = args.command as string;
      if (isDangerousCommand(command)) {
        return '安全限制: 命令被危险操作防护拦截';
      }
      try {
        // V17: 使用跨平台 Shell 执行器（修复：使用智能超时计算的 timeout）
        const { executeShell, formatShellResult, getSmartTimeout } = await import('../../core/cross-platform-shell.js');
        const { timeout, reason } = getSmartTimeout(command, args.timeout as number | undefined);
        const result = executeShell({ command, timeout });
        return formatShellResult(result, reason);
      } catch (err) {
        const e = err as { message: string; stdout?: string; stderr?: string };
        return `执行失败: ${e.message}\n${e.stdout || ''}\n${e.stderr || ''}`.trim();
      }
    },
  },
  {
    name: 'web_search',
    description: '网络搜索，返回搜索结果摘要',
    parameters: {
      query: { type: 'string', description: '搜索关键词', required: true },
    },
    execute: async (args) => {
      const query = args.query as string;
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          signal: AbortSignal.timeout(30000),
        });
        const html = await res.text();
        const results: Array<{title: string, url: string, snippet: string}> = [];
        const blocks = html.split('result__body');
        for (let i = 1; i < blocks.length && results.length < 8; i++) {
          const block = blocks[i];
          const titleMatch = block.match(/result__a[^>]*>([\s\S]*?)<\/a>/);
          const urlMatch = block.match(/href="([^"]+)"/);
          const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\/[a-z]+>/);
          const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';
          if (title || snippet) results.push({ title, url: urlMatch ? urlMatch[1] : '', snippet });
        }
        if (results.length === 0) {
          const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          return text.substring(0, 2000) || '未找到相关结果';
        }
        return `🔍 搜索 "${query}" 结果:\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')}`;
      } catch {
        try {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, {
            signal: AbortSignal.timeout(30000),
          });
          const data = await res.json() as {
            AbstractText?: string;
            AbstractURL?: string;
            Answer?: string;
            RelatedTopics?: Array<{ Text?: string }>;
          };
          const parts: string[] = [];
          if (data.AbstractText) parts.push(`📖 ${data.AbstractText}`);
          if (data.AbstractURL) parts.push(`🔗 ${data.AbstractURL}`);
          if (data.Answer) parts.push(`✅ ${data.Answer}`);
          if (data.RelatedTopics?.length > 0) {
            parts.push('\n📋 相关内容:');
            data.RelatedTopics.filter(t => t.Text).slice(0, 5).forEach(t => parts.push(`  • ${t.Text}`));
          }
          return parts.length > 0 ? parts.join('\n') : `搜索 "${query}" 完成，未找到直接结果。`;
        } catch { return `搜索服务暂时不可用，请基于已有知识回答。`; }
      }
    },
  },
  {
    name: 'web_fetch',
    description: '获取指定URL的内容',
    parameters: {
      url: { type: 'string', description: '要获取的URL', required: true },
    },
    execute: async (args) => {
      const url = args.url as string;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const text = await response.text();
        return text.substring(0, 10000);
      } catch (err) {
        return `获取失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'current_time',
    description: '获取当前日期和时间',
    parameters: {},
    execute: () => Promise.resolve(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })),
  },
  {
    name: 'http_request',
    description: '发送HTTP请求（支持GET/POST/PUT/DELETE）',
    parameters: {
      url: { type: 'string', description: '请求URL', required: true },
      method: { type: 'string', description: 'HTTP方法，默认GET' },
      headers: { type: 'string', description: '请求头，JSON格式' },
      body: { type: 'string', description: '请求体（字符串）' },
    },
    execute: async (args) => {
      const url = args.url as string;
      const method = (args.method as string) || 'GET';
      try {
        const headers = args.headers ? JSON.parse(args.headers as string) : {};
        const response = await fetch(url, { method, headers, body: args.body as string, signal: AbortSignal.timeout(30000) });
        const text = await response.text();
        return `状态码: ${response.status}\n\n${text.substring(0, 5000)}`;
      } catch (err) {
        return `请求失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'desktop_open',
    description: '打开本地软件、文件或目录。可启动应用程序、用默认程序打开文件、打开资源管理器。',
    parameters: {
      target: { type: 'string', description: '要打开的目标: 软件名(如 chrome/notepad/calc)、文件路径、目录路径、URL', required: true },
    },
    execute: async (args) => {
      const target = args.target as string;
      try {
        const { spawn } = await import('child_process');
        if (process.platform === 'win32') {
          const quotedTarget = target.includes(' ') ? `"${target}"` : target;
          if (target.match(/^[A-Za-z]:\\/) || target.startsWith('.') || target.startsWith('/')) {
            spawn('cmd', ['/c', 'start', '', quotedTarget], { detached: true, stdio: 'ignore' }).unref();
            return `✅ 已打开: ${target}`;
          }
          if (target.startsWith('http://') || target.startsWith('https://')) {
            spawn('cmd', ['/c', 'start', '', quotedTarget], { detached: true, stdio: 'ignore' }).unref();
            return `✅ 已在浏览器中打开: ${target}`;
          }
          spawn('cmd', ['/c', 'start', '', quotedTarget], { detached: true, stdio: 'ignore' }).unref();
          return `✅ 已启动: ${target}`;
        } else if (process.platform === 'darwin') {
          spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
          return `✅ 已打开: ${target}`;
        } else {
          spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
          return `✅ 已打开: ${target}`;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `❌ 打开失败: ${msg}`;
      }
    },
  },
  {
    name: 'browser_operate',
    description: '操作浏览器（基于Puppeteer），支持打开网页、点击元素、输入文字、截图、提取文本等操作',
    parameters: {
      action: { type: 'string', description: '操作类型: goto(打开网页)/click(点击)/type(输入)/screenshot(截图)/extract(提取文本)/info(页面信息)/wait(等待)/press(按键)/evaluate(执行JS)', required: true },
      url: { type: 'string', description: '目标URL（action=goto时必填）' },
      selector: { type: 'string', description: 'CSS选择器或XPath（click/type/wait时使用）' },
      text: { type: 'string', description: '输入文字（action=type时使用）或点击文本（action=click时替代selector）' },
      key: { type: 'string', description: '按键名称（action=press时使用，如Enter/Tab/Escape）' },
      script: { type: 'string', description: 'JavaScript代码（action=evaluate时使用）' },
      timeout: { type: 'number', description: '超时时间ms（action=wait时使用，默认5000）' },
    },
    execute: async (args) => {
      try {
        const { browserGoto, browserClick, browserType, browserScreenshot, browserExtract, browserInfo, browserWait, browserPress, browserEvaluate } = await import('../../utils/browser-operator.js');
        const action = args.action as string;
        const toStr = (r: { success: boolean; data?: string; error?: string }) =>
          r.success ? (r.data || '✅ 操作成功') : `❌ ${r.error || '操作失败'}`;
        switch (action) {
          case 'goto': return toStr(await browserGoto(args.url as string));
          case 'click': return toStr(await browserClick(args.selector as string || args.text as string));
          case 'type': return toStr(await browserType(args.selector as string, args.text as string));
          case 'screenshot': return toStr(await browserScreenshot());
          case 'extract': return toStr(await browserExtract());
          case 'info': return toStr(await browserInfo());
          case 'wait': return toStr(await browserWait(args.selector as string, (args.timeout as number) || 5000));
          case 'press': return toStr(await browserPress(args.key as string));
          case 'evaluate': return toStr(await browserEvaluate(args.script as string));
          default: return `❌ 未知操作: ${action}，支持: goto/click/type/screenshot/extract/info/wait/press/evaluate`;
        }
      } catch (err) {
        return `❌ 浏览器操作失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'security_audit',
    description: '对代码进行安全审计，检测潜在安全漏洞',
    parameters: {
      code: { type: 'string', description: '要审计的代码', required: true },
    },
    execute: (args) => {
      const code = args.code as string;
      const issues: Array<{ line: number; severity: string; message: string }> = [];
      const lines = code.split('\n');
      lines.forEach((line: string, i: number) => {
        if (line.includes('eval(')) issues.push({ line: i + 1, severity: 'high', message: '使用eval()可能导致代码注入' });
        if (line.includes('innerHTML')) issues.push({ line: i + 1, severity: 'medium', message: '使用innerHTML可能导致XSS攻击' });
        if (line.includes('document.write')) issues.push({ line: i + 1, severity: 'medium', message: '使用document.write可能导致XSS' });
        if (line.match(/password|secret|apiKey|token\s*=\s*['"][^'"]+['"]/i)) issues.push({ line: i + 1, severity: 'high', message: '硬编码的密钥或密码' });
        if (line.includes('exec(') || line.includes('execSync(')) issues.push({ line: i + 1, severity: 'high', message: '执行系统命令可能导致命令注入' });
        if (line.includes('SQL') && (line.includes('+') || line.includes('$'))) issues.push({ line: i + 1, severity: 'high', message: '可能的SQL注入' });
      });
      if (issues.length === 0) return Promise.resolve('✅ 未发现安全漏洞');
      return Promise.resolve(`⚠️ 发现 ${issues.length} 个安全问题:\n` + issues.map(i => `[${i.severity}] 行${i.line}: ${i.message}`).join('\n'));
    },
  },
];

/**
 * 消灭孤岛 I-2：工具定义查询统一委托 ScalableToolRegistry
 *
 * 注入 registry 后，getToolDefinitionsForAPI / getOpenAITools / getSmartTools
 * 优先委托 registry（获得全部已注册工具：built-in + MCP + 各模块 getToolDefinitions），
 * 找不到时回退到本地 tools[] 数组（保持测试与未注入场景的行为不变）。
 *
 * 这样 ScalableToolRegistry 成为唯一的工具注册与查询枢纽，
 * 消除 tools.ts tools[] 与 registry 之间的双重数据源。
 *
 * 详见 v19 方案 §4.1 I-2。
 */
export function getToolDefinitionsForAPI(): Array<{ name: string; description: string; input_schema: object }> {
  // I-2：注入 registry 时从 registry 查询（含 MCP + 各模块工具），否则用本地 tools[]
  if (toolRegistry) {
    return toolRegistry.getAllDefinitions().map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.parameters,
        required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
      },
    }));
  }
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object' as const,
      properties: t.parameters,
      required: Object.entries(t.parameters).filter(([, v]) => v.required).map(([k]) => k),
    },
  }));
}

export function getOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] } } }> {
  // I-2：注入 registry 时委托 registry.getOpenAITools（含全部已注册工具）
  if (toolRegistry) {
    return toolRegistry.getOpenAITools();
  }
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,  // 不截断描述，保留完整信息供LLM理解
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, val]) => [key, { type: val.type, description: val.description || '' }])
        ),
        required: Object.entries(tool.parameters).filter(([, val]) => val.required).map(([key]) => key),
      },
    },
  }));
}

export function getSmartTools(userMessage?: string): Array<{ type: 'function'; function: { name: string; description: string; parameters: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] } } }> {
  // I-2：注入 registry 时委托 registry.getOpenAITools(userMessage)（走 selectToolsForContext 智能筛选）
  if (toolRegistry) {
    return toolRegistry.getOpenAITools(userMessage);
  }
  const coreToolNames = new Set(['code_execute', 'file_read', 'file_write', 'web_search', 'shell_execute', 'web_fetch', 'list_directory', 'browser_operate', 'desktop_open']);
  let selectedTools = tools;
  if (tools.length > 60) {
    selectedTools = tools.filter(t => {
      if (coreToolNames.has(t.name)) return true;
      return true;
    });
  }
  return selectedTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, val]) => [key, { type: val.type, description: val.description }])
        ),
        required: Object.entries(tool.parameters).filter(([, val]) => val.required).map(([key]) => key),
      },
    },
  }));
}

/**
 * 消灭孤岛 I-3：可选 ScalableToolRegistry 注入
 *
 * 注入后 executeTool() 优先委托 registry（获得熔断/监控/沙箱路由能力），
 * 找不到该工具时回退到本地 tools[] 数组。未注入时行为完全不变。
 *
 * 调用方：CLI/Web 入口在 setupAgentLoop() 后调用 setToolRegistry(registry)。
 * 详见 v19 方案 §4.2 I-3。
 */
let toolRegistry: ScalableToolRegistry | null = null;

export function setToolRegistry(registry: ScalableToolRegistry | null): void {
  toolRegistry = registry;
}

/** 查询当前注入的 registry（主要用于测试） */
export function getToolRegistry(): ScalableToolRegistry | null {
  return toolRegistry;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  // 消灭孤岛 I-3：注入 registry 时优先委托（获得熔断/监控/沙箱路由能力），
  // 找不到时回退到本地 tools[] 数组（保持测试与未注入场景的行为不变）
  if (toolRegistry) {
    const registered = await toolRegistry.getTool(name);
    if (registered) {
      return toolRegistry.executeTool(name, args);
    }
  }

  const tool = tools.find(t => t.name === name);
  if (!tool) return `未知工具: ${name}`;
  // 超时时间根据工具类型动态调整
  // V17: shell_execute 使用智能超时（内部已处理 npm install 等长命令），外层不限制
  // 网络类工具需要更长时间
  const networkTools = ['web_search', 'web_fetch', 'http_request', 'browser_operate'];
  let timeout: number;
  if (name === 'shell_execute') timeout = 600000;
  else if (networkTools.includes(name)) timeout = 60000;
  else timeout = 30000;
  return Promise.race([
    tool.execute(args),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`工具 ${name} 执行超时(${timeout/1000}s)`)), timeout)),
  ]).catch(err => `工具执行失败: ${err instanceof Error ? err.message : String(err)}`);
}
