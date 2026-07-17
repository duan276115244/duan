/**
 * @-mention 上下文引用解析器 — MentionResolver
 *
 * 对标 Cursor IDE 的 @-mention 语法，用户在对话中输入
 * `@file:path` / `@symbol:name` / `@web:url` / `@folder:path` / `@search:query`，
 * 系统自动解析并注入相关上下文，让 agent 能精准获取用户引用的内容。
 *
 * 支持的 @-mention 类型：
 * 1. @file:path      — 文件引用，读取文件内容（带行号），大文件截断，二进制检测
 * 2. @symbol:name     — 符号引用，在 src/ 下搜索函数/类定义 + 代码块
 * 3. @web:url         — 网页引用，fetch URL 并提取正文（10s 超时，5000 字符截断）
 * 4. @folder:path      — 目录引用，递归列出目录树（3 层深度，100 文件上限）
 * 5. @search:query     — 项目内搜索，grep 找到所有引用（50 匹配上限）
 *
 * 设计原则：
 * - 纯解析器，无持久化状态
 * - 每次创建新实例（projectRoot 可能不同）
 * - 路径安全：拒绝 .. 路径遍历攻击
 * - 并发限制：resolveAll 最多 5 个并发
 */

import * as fs from 'fs';
import * as path from 'path';
import { promises as fsp } from 'fs';

// ============ 类型定义 ============

/** @-mention 类型 */
export type MentionType = 'file' | 'symbol' | 'web' | 'folder' | 'search';

/** 解析后的 @-mention 上下文 */
export interface MentionContext {
  type: MentionType;
  /** 原始 @-mention 查询内容（@type: 之后的部分） */
  query: string;
  /** 是否成功解析 */
  resolved: boolean;
  /** 解析后的上下文内容 */
  content: string;
  /** 解析失败时的错误信息 */
  error?: string;
  metadata?: {
    filePath?: string;
    lineCount?: number;
    fileSize?: number;
    matchCount?: number;
  };
}

/** 解析出的 @-mention 标记 */
export interface ParsedMention {
  type: MentionType;
  /** @-mention 后的查询内容 */
  query: string;
  /** 完整的 @-mention 字符串 */
  raw: string;
  /** 在原文中的起始位置 */
  start: number;
  /** 结束位置 */
  end: number;
}

/** LLM 工具静态定义（不含 execute，由 handler 分发） */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  readOnly?: boolean;
}

/** 工具处理器签名 */
export type ToolHandler = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

// ============ 常量 ============

/** @-mention 解析正则：query 部分遇到空格、@、行尾停止 */
const MENTION_REGEX = /@(file|symbol|web|folder|search):([^\s@]+)/g;

/** 支持的源文件扩展名（符号搜索） */
const SYMBOL_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/** 搜索时跳过的目录 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

/** 搜索时扫描的文件扩展名 */
const SEARCH_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.html', '.css', '.yml', '.yaml', '.sh', '.xml',
]);

// ============ 配置 ============

/** MentionResolver 构造选项 */
export interface MentionResolverOptions {
  projectRoot?: string;
  /** 网页请求超时（毫秒），默认 10000 */
  webTimeoutMs?: number;
  /** 批量解析并发上限，默认 5 */
  maxConcurrent?: number;
  /** 文件行数截断阈值，默认 500 */
  maxFileLines?: number;
  /** 大文件保留头部行数，默认 100 */
  fileHead?: number;
  /** 大文件保留尾部行数，默认 100 */
  fileTail?: number;
  /** 网页内容最大字符数，默认 5000 */
  maxWebLength?: number;
  /** 搜索匹配上限，默认 50 */
  maxSearchMatches?: number;
  /** 目录树最大深度，默认 3 */
  maxFolderDepth?: number;
  /** 目录树最大文件数，默认 100 */
  maxFolderFiles?: number;
}

// ============ 主类 ============

export class MentionResolver {
  private projectRoot: string;
  private webTimeoutMs: number;
  private maxConcurrent: number;
  private maxFileLines: number;
  private fileHead: number;
  private fileTail: number;
  private maxWebLength: number;
  private maxSearchMatches: number;
  private maxFolderDepth: number;
  private maxFolderFiles: number;

  constructor(projectRootOrOptions?: string | MentionResolverOptions) {
    const opts: MentionResolverOptions = typeof projectRootOrOptions === 'string'
      ? { projectRoot: projectRootOrOptions }
      : (projectRootOrOptions ?? {});

    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.webTimeoutMs = opts.webTimeoutMs ?? 10000;
    this.maxConcurrent = opts.maxConcurrent ?? 5;
    this.maxFileLines = opts.maxFileLines ?? 500;
    this.fileHead = opts.fileHead ?? 100;
    this.fileTail = opts.fileTail ?? 100;
    this.maxWebLength = opts.maxWebLength ?? 5000;
    this.maxSearchMatches = opts.maxSearchMatches ?? 50;
    this.maxFolderDepth = opts.maxFolderDepth ?? 3;
    this.maxFolderFiles = opts.maxFolderFiles ?? 100;
  }

  // ============ 核心方法 ============

  /**
   * 解析文本中的所有 @-mention
   * 支持一行多个 @-mention，query 遇到空格/@/行尾停止。
   */
  parseMentions(text: string): ParsedMention[] {
    const mentions: ParsedMention[] = [];
    const regex = new RegExp(MENTION_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      mentions.push({
        type: match[1] as MentionType,
        query: match[2],
        raw: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return mentions;
  }

  /**
   * 解析单个 @-mention，根据类型分发到对应的解析器。
   */
  async resolveMention(mention: ParsedMention): Promise<MentionContext> {
    switch (mention.type) {
      case 'file':
        return this.resolveFile(mention.query);
      case 'symbol':
        return this.resolveSymbol(mention.query);
      case 'web':
        return this.resolveWeb(mention.query);
      case 'folder':
        return this.resolveFolder(mention.query);
      case 'search':
        return this.resolveSearch(mention.query);
      default:
        return {
          type: mention.type,
          query: mention.query,
          resolved: false,
          content: '',
          error: `不支持的 @-mention 类型: ${mention.type}`,
        };
    }
  }

  /**
   * 批量解析所有 @-mention（并发，最多 maxConcurrent 个一批）
   */
  async resolveAll(text: string): Promise<MentionContext[]> {
    const mentions = this.parseMentions(text);
    if (mentions.length === 0) return [];

    const contexts: MentionContext[] = [];
    for (let i = 0; i < mentions.length; i += this.maxConcurrent) {
      const batch = mentions.slice(i, i + this.maxConcurrent);
      const results = await Promise.all(batch.map((m) => this.resolveMention(m)));
      contexts.push(...results);
    }
    return contexts;
  }

  /**
   * 将解析结果格式化为上下文字符串（注入到 system prompt）
   */
  formatContext(contexts: MentionContext[]): string {
    if (contexts.length === 0) return '';

    const sections: string[] = ['=== @-mention 上下文 ==='];

    for (const ctx of contexts) {
      sections.push('');
      sections.push(`--- @${ctx.type}:${ctx.query} ---`);
      if (ctx.resolved) {
        sections.push(ctx.content);
        const metaParts: string[] = [];
        if (ctx.metadata?.lineCount !== undefined) metaParts.push(`行数: ${ctx.metadata.lineCount}`);
        if (ctx.metadata?.fileSize !== undefined) metaParts.push(`大小: ${ctx.metadata.fileSize} bytes`);
        if (ctx.metadata?.matchCount !== undefined) metaParts.push(`匹配: ${ctx.metadata.matchCount}`);
        if (metaParts.length > 0) sections.push(`(${metaParts.join(', ')})`);
      } else {
        sections.push(`[解析失败] ${ctx.error || '未知错误'}`);
      }
    }

    return sections.join('\n');
  }

  /**
   * 处理用户输入：解析 + 注入上下文，返回增强后的文本
   */
  async processInput(input: string): Promise<{
    input: string;
    context: string;
    contexts: MentionContext[];
  }> {
    const contexts = await this.resolveAll(input);
    const context = this.formatContext(contexts);
    return { input, context, contexts };
  }

  // ============ 项目搜索（供 mention_search 工具使用）============

  /**
   * 在 src/ 目录下搜索符号定义
   * 返回所有匹配的 { file, line, content }
   */
  async searchSymbol(name: string): Promise<{ file: string; line: number; content: string }[]> {
    const srcDir = path.join(this.projectRoot, 'src');
    const files = await this.walkFiles(srcDir, SYMBOL_EXTENSIONS);
    const escapedName = this.escapeRegex(name);
    const symbolRegex = new RegExp(
      `(export\\s+)?(class|function|interface|type|const|let|var)\\s+${escapedName}\\b`
    );

    const results: { file: string; line: number; content: string }[] = [];
    for (const filePath of files) {
      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        const match = symbolRegex.exec(content);
        if (match) {
          const block = this.extractCodeBlock(content, match.index);
          results.push({
            file: path.relative(this.projectRoot, filePath),
            line: block.startLine,
            content: block.code,
          });
        }
      } catch {
        // 跳过不可读文件
      }
    }
    return results;
  }

  /**
   * 在项目内搜索文本（grep 模式）
   * 返回所有匹配的 { file, line, content }，最多 maxSearchMatches 个
   */
  async searchProject(query: string): Promise<{ file: string; line: number; content: string }[]> {
    const files = await this.walkFiles(this.projectRoot, SEARCH_EXTENSIONS);
    const matches: { file: string; line: number; content: string }[] = [];

    for (const filePath of files) {
      if (matches.length >= this.maxSearchMatches) break;
      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= this.maxSearchMatches) break;
          if (lines[i].includes(query)) {
            matches.push({
              file: path.relative(this.projectRoot, filePath),
              line: i + 1,
              content: lines[i].trim(),
            });
          }
        }
      } catch {
        // 跳过不可读文件
      }
    }
    return matches;
  }

  // ============ LLM 工具定义 ============

  /**
   * 暴露 LLM 工具定义（2 个工具）
   * - mention_resolve: 解析文本中的 @-mention 并返回上下文
   * - mention_search: 项目内搜索（不要求 @-mention 前缀）
   */
  getToolDefinitions(): ToolDef[] {
    return getMentionToolDefinitions();
  }

  // ============ 内部方法：@file ============

  private async resolveFile(query: string): Promise<MentionContext> {
    const filePath = path.resolve(this.projectRoot, query);
    if (!this.isPathSafe(filePath)) {
      return this.errorContext('file', query, '路径遍历攻击被拒绝');
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return this.errorContext('file', query, '文件不存在');
    }
    if (!stat.isFile()) {
      return this.errorContext('file', query, '路径不是文件');
    }

    // 读取为 Buffer 检测二进制
    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(filePath);
    } catch (err) {
      return this.errorContext('file', query, `读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (this.isBinary(buffer)) {
      return {
        type: 'file',
        query,
        resolved: true,
        content: `{二进制文件，大小: ${buffer.length} bytes}`,
        metadata: {
          filePath: path.relative(this.projectRoot, filePath),
          fileSize: buffer.length,
        },
      };
    }

    const content = buffer.toString('utf-8');
    const lines = content.split('\n');
    const lineCount = lines.length;
    let formatted: string;

    if (lineCount > this.maxFileLines) {
      const head = lines.slice(0, this.fileHead);
      const tail = lines.slice(-this.fileTail);
      const omitted = lineCount - this.fileHead - this.fileTail;
      formatted = [
        ...head.map((line, i) => `${i + 1}: ${line}`),
        `... [已省略 ${omitted} 行] ...`,
        ...tail.map((line, i) => `${lineCount - this.fileTail + i + 1}: ${line}`),
      ].join('\n');
    } else {
      formatted = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    }

    return {
      type: 'file',
      query,
      resolved: true,
      content: formatted,
      metadata: {
        filePath: path.relative(this.projectRoot, filePath),
        lineCount,
        fileSize: buffer.length,
      },
    };
  }

  // ============ 内部方法：@symbol ============

  private async resolveSymbol(query: string): Promise<MentionContext> {
    const results = await this.searchSymbol(query);
    if (results.length === 0) {
      return this.errorContext('symbol', query, `未找到符号 "${query}"`);
    }

    // 取第一个匹配（如果多个，全部展示）
    const sections: string[] = [];
    for (const r of results) {
      sections.push(`📄 ${r.file}:${r.line}`);
      sections.push(r.content);
      sections.push('');
    }

    return {
      type: 'symbol',
      query,
      resolved: true,
      content: sections.join('\n').trimEnd(),
      metadata: {
        filePath: results[0].file,
        lineCount: results.length,
        matchCount: results.length,
      },
    };
  }

  // ============ 内部方法：@web ============

  private async resolveWeb(query: string): Promise<MentionContext> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.webTimeoutMs);
      let response: Response;
      try {
        response = await fetch(query, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        return this.errorContext('web', query, `HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const text = this.extractTextFromHtml(html);
      const truncated =
        text.length > this.maxWebLength ? text.slice(0, this.maxWebLength) : text;

      return {
        type: 'web',
        query,
        resolved: true,
        content: truncated,
        metadata: { fileSize: html.length },
      };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      return this.errorContext(
        'web',
        query,
        isTimeout ? `请求超时 (${this.webTimeoutMs}ms)` : (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // ============ 内部方法：@folder ============

  private async resolveFolder(query: string): Promise<MentionContext> {
    const folderPath = path.resolve(this.projectRoot, query);
    if (!this.isPathSafe(folderPath)) {
      return this.errorContext('folder', query, '路径遍历攻击被拒绝');
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(folderPath);
    } catch {
      return this.errorContext('folder', query, '目录不存在');
    }
    if (!stat.isDirectory()) {
      return this.errorContext('folder', query, '路径不是目录');
    }

    const tree = await this.buildFolderTree(folderPath, 0, { count: 0 });
    return {
      type: 'folder',
      query,
      resolved: true,
      content: tree,
      metadata: { filePath: path.relative(this.projectRoot, folderPath) },
    };
  }

  // ============ 内部方法：@search ============

  private async resolveSearch(query: string): Promise<MentionContext> {
    const matches = await this.searchProject(query);
    const content =
      matches.length > 0
        ? matches.map((m) => `${m.file}:${m.line}: ${m.content}`).join('\n')
        : '无匹配结果';

    return {
      type: 'search',
      query,
      resolved: true,
      content,
      metadata: { matchCount: matches.length },
    };
  }

  // ============ 内部方法：文件遍历 ============

  /**
   * 递归遍历目录，收集指定扩展名的文件（跳过 IGNORE_DIRS）
   */
  private async walkFiles(dir: string, extensions: Set<string> | string[]): Promise<string[]> {
    const extSet = Array.isArray(extensions) ? new Set(extensions) : extensions;
    const results: string[] = [];
    const walk = async (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extSet.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    };
    await walk(dir);
    return results;
  }

  // ============ 内部方法：目录树 ============

  /**
   * 递归构建目录树（最多 maxFolderDepth 层，最多 maxFolderFiles 个文件）
   */
  private async buildFolderTree(
    dir: string,
    depth: number,
    counter: { count: number }
  ): Promise<string> {
    if (depth > this.maxFolderDepth || counter.count >= this.maxFolderFiles) {
      return '';
    }

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return '';
    }

    // 目录优先排序
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = [];
    for (const entry of entries) {
      if (counter.count >= this.maxFolderFiles) {
        lines.push('... [已达文件数上限] ...');
        break;
      }
      const fullPath = path.join(dir, entry.name);
      const indent = '  '.repeat(depth);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        lines.push(`${indent}${entry.name}/`);
        counter.count++;
        const subTree = await this.buildFolderTree(fullPath, depth + 1, counter);
        if (subTree) lines.push(subTree);
      } else {
        let size = 0;
        try {
          size = (await fsp.stat(fullPath)).size;
        } catch {
          // 忽略 stat 失败
        }
        lines.push(`${indent}${entry.name} (${this.formatSize(size)})`);
        counter.count++;
      }
    }
    return lines.join('\n');
  }

  // ============ 内部方法：代码块提取 ============

  /**
   * 从匹配位置提取代码块（花括号匹配，到下一个同级定义或文件末尾）
   */
  private extractCodeBlock(content: string, startIndex: number): {
    startLine: number;
    endLine: number;
    code: string;
  } {
    const lines = content.split('\n');
    const startLine = content.slice(0, startIndex).split('\n').length;

    // 寻找第一个 { 后的匹配 }
    let braceIndex = content.indexOf('{', startIndex);
    if (braceIndex === -1) {
      // 无花括号（如 type 别名、单行声明），返回定义行
      return {
        startLine,
        endLine: startLine,
        code: lines[startLine - 1] || '',
      };
    }

    let depth = 1;
    let inString = false;
    let stringChar = '';
    for (let i = braceIndex + 1; i < content.length; i++) {
      const ch = content[i];
      const prev = i > 0 ? content[i - 1] : '';
      if (inString) {
        if (ch === stringChar && prev !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const endLine = content.slice(0, i).split('\n').length;
          const code = lines.slice(startLine - 1, endLine).join('\n');
          return { startLine, endLine, code };
        }
      }
    }

    // 未找到匹配的 }，返回到文件末尾
    const code = lines.slice(startLine - 1).join('\n');
    return { startLine, endLine: lines.length, code };
  }

  // ============ 内部方法：HTML 文本提取 ============

  /**
   * 从 HTML 中提取纯文本（去除 script/style/标签，解码基本实体）
   */
  private extractTextFromHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ============ 内部方法：辅助 ============

  /** 路径安全检查：拒绝 .. 路径遍历攻击 */
  private isPathSafe(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(this.projectRoot);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  /** 检测二进制文件：包含 \0 字符视为二进制 */
  private isBinary(buffer: Buffer): boolean {
    return buffer.includes(0);
  }

  /** 格式化文件大小 */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 构造错误上下文 */
  private errorContext(type: MentionType, query: string, error: string): MentionContext {
    return {
      type,
      query,
      resolved: false,
      content: '',
      error,
    };
  }
}

// ============ LLM 工具定义 ============

/**
 * 暴露 @-mention 解析器的 LLM 工具静态定义（2 个工具）
 * - mention_resolve: 解析文本中的 @-mention 并返回上下文
 * - mention_search: 项目内搜索（不要求 @-mention 前缀）
 */
export function getMentionToolDefinitions(): ToolDef[] {
  return [
    {
      name: 'mention_resolve',
      description:
        '解析文本中的 @-mention 并返回上下文。支持 @file:path / @symbol:name / @web:url / @folder:path / @search:query 五种引用类型。用于从用户引用中提取上下文注入对话。只读。',
      parameters: {
        text: {
          type: 'string',
          description: '包含 @-mention 的文本',
          required: true,
        },
      },
      readOnly: true,
    },
    {
      name: 'mention_search',
      description:
        '在项目内搜索符号定义或文本内容（不要求 @-mention 前缀）。type=symbol 在 src/ 下搜索函数/类定义，type=search 全项目 grep。只读。',
      parameters: {
        query: {
          type: 'string',
          description: '搜索查询',
          required: true,
        },
        type: {
          type: 'string',
          description: "搜索类型: 'symbol' 或 'search'（默认 'search'）",
          required: false,
        },
      },
      readOnly: true,
    },
  ];
}

/**
 * 创建 @-mention 解析器工具处理器
 * 根据工具名分发到对应的 MentionResolver 方法。
 */
export function createMentionToolHandler(resolver: MentionResolver): ToolHandler {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'mention_resolve': {
        const text = String(args.text ?? '');
        if (!text) return { error: '缺少 text 参数' };
        const contexts = await resolver.resolveAll(text);
        const formattedContext = resolver.formatContext(contexts);
        return { contexts, formattedContext };
      }
      case 'mention_search': {
        const query = String(args.query ?? '');
        if (!query) return { error: '缺少 query 参数' };
        const type = (args.type as 'symbol' | 'search') || 'search';
        if (type === 'symbol') {
          const matches = await resolver.searchSymbol(query);
          return { matches, count: matches.length };
        }
        const matches = await resolver.searchProject(query);
        return { matches, count: matches.length };
      }
      default:
        return { error: `未知工具: ${toolName}。支持: mention_resolve, mention_search` };
    }
  };
}
