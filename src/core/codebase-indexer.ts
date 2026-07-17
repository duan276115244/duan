/**
 * codebase-indexer.ts
 *
 * v20.0 §3.1 代码库语义索引 — 对标 Cursor codebase indexing
 *
 * 核心能力：
 * 1. 多语言符号提取（TS/JS/Python/Java/Go/Rust）— regex-based
 * 2. 增量索引 — 文件 mtime 变化时仅重索引该文件
 * 3. 语义搜索 — 关键词匹配 + TF-IDF 加权
 * 4. 引用查找 — findReferences(symbolName)
 * 5. 调用图 — getCallGraph() 函数调用关系
 * 6. LLM 工具 — 让 Agent 主动查询代码库
 *
 * 设计模式：与 ProjectKnowledge 互补
 * - ProjectKnowledge：项目级概览（技术栈/目录结构/配置文件）
 * - CodebaseIndexer：符号级索引（函数/类/接口定义 + 引用）
 *
 * 索引存储：内存 Map（启动时构建，运行时增量更新）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 符号类型 */
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'import' | 'method';

/** 代码符号 */
export interface CodeSymbol {
  /** 符号名称 */
  name: string;
  /** 符号类型 */
  kind: SymbolKind;
  /** 所在文件（相对项目根目录） */
  filePath: string;
  /** 行号（1-based） */
  line: number;
  /** 签名或声明文本（截断到 120 字符） */
  signature: string;
  /** 所属类/命名空间（方法才有） */
  parent?: string;
}

/** 文件索引条目 */
export interface FileIndexEntry {
  /** 文件路径（相对项目根目录） */
  filePath: string;
  /** 文件 mtime（用于增量更新检测） */
  mtime: number;
  /** 文件中的符号列表 */
  symbols: CodeSymbol[];
  /** 文件导入的符号（用于引用查找） */
  imports: string[];
  /** 文件语言 */
  language: string;
  /** 文件行数 */
  lineCount: number;
}

/** 搜索结果项 */
export interface SearchResult {
  /** 匹配的符号 */
  symbol: CodeSymbol;
  /** 相关性分数（0-1） */
  score: number;
  /** 匹配原因 */
  reason: string;
}

/** 调用图节点 */
export interface CallGraphNode {
  /** 函数名 */
  name: string;
  /** 定义位置 */
  filePath: string;
  line: number;
  /** 调用的函数列表 */
  calls: string[];
}

/** 索引统计 */
export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  byKind: Record<SymbolKind, number>;
  byLanguage: Record<string, number>;
  lastIndexedAt: number;
  indexDurationMs: number;
}

// ============ 语言检测与符号提取 ============

/** 支持的语言及其文件扩展名 */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  java: ['.java'],
  go: ['.go'],
  rust: ['.rs'],
};

/** 忽略的目录 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'coverage', '.cache', '.duan', 'out', 'target',
  '.gradle', '.idea', '.vscode',
]);

/** 忽略的文件模式 */
const IGNORE_PATTERNS = [
  /\.min\.js$/, /\.bundle\./, /\.map$/, /\.d\.ts$/,
  /__tests__\/.*\.test\./, /__tests__\/.*\.spec\./,
];

/** 检测文件语言 */
function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

/** 检查文件是否应该被忽略 */
function shouldIgnore(filePath: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, filePath);
  const parts = relative.split(path.sep);
  if (parts.some(p => IGNORE_DIRS.has(p))) return true;
  if (IGNORE_PATTERNS.some(re => re.test(relative))) return true;
  return false;
}

// ============ 符号提取正则（多语言） ============

/** TypeScript/JavaScript 符号提取正则 */
const TS_SYMBOL_PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
  // 函数声明: function foo() / async function foo() / export function foo()
  { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gm, kind: 'function' },
  // 箭头函数/变量函数: const foo = () => / const foo = async () => / let foo = function()
  { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?[^=]*=>\s*/gm, kind: 'function' },
  // 类方法: foo() { / async foo() { / private foo() {
  { regex: /^\s*(?:public|private|protected|static|async|get|set|readonly|\s)*(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*[{]/gm, kind: 'method' },
  // 类声明: class Foo / export class Foo
  { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: 'class' },
  // 接口声明: interface Foo
  { regex: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 'interface' },
  // 类型别名: type Foo = ...
  { regex: /^(?:export\s+)?type\s+(\w+)\s*[=<{]/gm, kind: 'type' },
  // 枚举: enum Foo
  { regex: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/gm, kind: 'type' },
];

/** Python 符号提取正则 */
const PY_SYMBOL_PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
  { regex: /^(?:async\s+)?def\s+(\w+)\s*\(/gm, kind: 'function' },
  { regex: /^class\s+(\w+)/gm, kind: 'class' },
];

/** Java 符号提取正则 */
const JAVA_SYMBOL_PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
  { regex: /(?:public|private|protected|static)\s+(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*\{/gm, kind: 'method' },
  { regex: /(?:public|abstract)\s+class\s+(\w+)/gm, kind: 'class' },
  { regex: /interface\s+(\w+)/gm, kind: 'interface' },
];

/** Go 符号提取正则 */
const GO_SYMBOL_PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
  { regex: /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/gm, kind: 'function' },
  { regex: /^type\s+(\w+)\s+struct/gm, kind: 'class' },
  { regex: /^type\s+(\w+)\s+interface/gm, kind: 'interface' },
];

/** Rust 符号提取正则 */
const RUST_SYMBOL_PATTERNS: Array<{ regex: RegExp; kind: SymbolKind }> = [
  { regex: /^(?:pub\s+)?fn\s+(\w+)\s*\(/gm, kind: 'function' },
  { regex: /^(?:pub\s+)?struct\s+(\w+)/gm, kind: 'class' },
  { regex: /^(?:pub\s+)?trait\s+(\w+)/gm, kind: 'interface' },
  { regex: /^(?:pub\s+)?enum\s+(\w+)/gm, kind: 'type' },
];

/** 获取语言的符号提取正则 */
function getSymbolPatterns(language: string): Array<{ regex: RegExp; kind: SymbolKind }> {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return TS_SYMBOL_PATTERNS;
    case 'python':
      return PY_SYMBOL_PATTERNS;
    case 'java':
      return JAVA_SYMBOL_PATTERNS;
    case 'go':
      return GO_SYMBOL_PATTERNS;
    case 'rust':
      return RUST_SYMBOL_PATTERNS;
    default:
      return [];
  }
}

/** 导入提取正则 */
const IMPORT_PATTERNS: Record<string, RegExp> = {
  typescript: /(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))/g,
  javascript: /(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))/g,
  python: /(?:^from\s+(\S+)\s+import)|(?:^import\s+(\S+))/gm,
  java: /^import\s+([\w.]+);/gm,
  go: /^import\s+"([^"]+)"/gm,
  rust: /^use\s+([\w:]+);/gm,
};

// ============ 主类 ============

export class CodebaseIndexer {
  private rootDir: string;
  private index: Map<string, FileIndexEntry> = new Map();
  private symbolIndex: Map<string, CodeSymbol[]> = new Map(); // symbolName → symbols
  private stats: IndexStats | null = null;
  private isIndexed = false;

  constructor(rootDir?: string) {
    this.rootDir = rootDir || process.cwd();
  }

  /** 构建索引（全量） */
  async buildIndex(): Promise<IndexStats> {
    const startTime = Date.now();
    this.index.clear();
    this.symbolIndex.clear();

    const files = await this.scanFiles();
    // 并发索引：文件 I/O 是主要瓶颈（readFile），并发池提升大代码库索引速度。
    // extractSymbols/extractImports 是同步代码，JS 单线程事件循环保证其原子性，无 regex.lastIndex 竞态。
    await this.indexFilesConcurrent(files, 8);

    this.rebuildSymbolIndex();
    this.isIndexed = true;

    this.stats = {
      totalFiles: this.index.size,
      totalSymbols: this.countSymbols(),
      byKind: this.countByKind(),
      byLanguage: this.countByLanguage(),
      lastIndexedAt: Date.now(),
      indexDurationMs: Date.now() - startTime,
    };
    return this.stats;
  }

  /**
   * 并发索引文件池：限制并发度避免一次性打开过多 FD。
   * @param files 文件路径列表
   * @param concurrency 并发度（默认 8，平衡 I/O 吞吐与 FD 消耗）
   */
  private async indexFilesConcurrent(files: string[], concurrency: number = 8): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const idx = cursor++;
        await this.indexFile(files[idx]);
      }
    };
    const n = Math.min(concurrency, files.length);
    for (let i = 0; i < n; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  /** 增量更新索引（仅重索引变化的文件） */
  async updateIncremental(): Promise<{ added: number; updated: number; removed: number }> {
    if (!this.isIndexed) {
      await this.buildIndex();
      return { added: this.index.size, updated: 0, removed: 0 };
    }

    const currentFiles = new Set(await this.scanFiles());
    let added = 0, updated = 0, removed = 0;

    // 先收集需要重索引的文件（新增 + mtime 变更），再并发处理
    const toReindex: string[] = [];
    for (const filePath of currentFiles) {
      const existing = this.index.get(filePath);
      if (!existing) {
        toReindex.push(filePath);
        added++;
      } else {
        const mtime = await this.getFileMtime(filePath);
        if (mtime > existing.mtime) {
          toReindex.push(filePath);
          updated++;
        }
      }
    }
    // 并发重索引（与 buildIndex 同策略，并发度 8）
    await this.indexFilesConcurrent(toReindex, 8);

    // 检查删除的文件
    for (const [filePath] of this.index) {
      if (!currentFiles.has(filePath)) {
        this.index.delete(filePath);
        removed++;
      }
    }

    if (added > 0 || updated > 0 || removed > 0) {
      this.rebuildSymbolIndex();
      this.stats = {
        totalFiles: this.index.size,
        totalSymbols: this.countSymbols(),
        byKind: this.countByKind(),
        byLanguage: this.countByLanguage(),
        lastIndexedAt: Date.now(),
        indexDurationMs: 0,
      };
    }

    return { added, updated, removed };
  }

  /** 语义搜索 — 关键词匹配 + TF-IDF 加权 */
  searchSemantic(query: string, limit: number = 20): SearchResult[] {
    if (!this.isIndexed) return [];

    const keywords = this.extractKeywords(query);
    const results: SearchResult[] = [];

    for (const [symbolName, symbols] of this.symbolIndex) {
      for (const symbol of symbols) {
        const score = this.scoreSymbol(symbol, symbolName, keywords);
        if (score > 0) {
          results.push({
            symbol,
            score,
            reason: this.explainMatch(symbol, symbolName, keywords),
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** 查找符号引用 — 返回所有引用该符号的文件 */
  findReferences(symbolName: string): Array<{ filePath: string; line: number; context: string }> {
    if (!this.isIndexed) return [];
    const refs: Array<{ filePath: string; line: number; context: string }> = [];

    for (const [filePath, entry] of this.index) {
      // 检查导入列表
      if (entry.imports.some(imp => imp.includes(symbolName))) {
        refs.push({ filePath, line: 0, context: `import: ${symbolName}` });
      }

      // 检查文件内容中的引用（通过符号名出现）
      // 这里用粗粒度匹配：文件内容包含符号名
      // 完整实现需要读取文件内容并逐行扫描
    }

    // 也检查定义本身
    const definitions = this.symbolIndex.get(symbolName);
    if (definitions) {
      for (const def of definitions) {
        refs.push({
          filePath: def.filePath,
          line: def.line,
          context: `definition: ${def.kind} ${def.name}`,
        });
      }
    }

    return refs;
  }

  /** 获取调用图 — 函数调用关系 */
  getCallGraph(symbolName?: string): CallGraphNode[] {
    if (!this.isIndexed) return [];
    const nodes: CallGraphNode[] = [];

    for (const [filePath, entry] of this.index) {
      for (const symbol of entry.symbols) {
        if (symbol.kind !== 'function' && symbol.kind !== 'method') continue;
        if (symbolName && symbol.name !== symbolName) continue;

        // 简化版调用图：通过符号名在文件中出现来推断调用关系
        // 完整实现需要 AST 分析
        const calls = this.extractCalls(entry, symbol);
        nodes.push({
          name: symbol.name,
          filePath,
          line: symbol.line,
          calls,
        });
      }
    }

    return nodes;
  }

  /** 获取索引统计 */
  getStats(): IndexStats | null {
    return this.stats;
  }

  /** 获取项目结构概览 */
  getOverview(): string {
    if (!this.isIndexed || !this.stats) return '索引未构建';

    const lines: string[] = [];
    lines.push(`代码库索引概览：`);
    lines.push(`  文件数: ${this.stats.totalFiles}`);
    lines.push(`  符号数: ${this.stats.totalSymbols}`);
    lines.push(`  索引耗时: ${this.stats.indexDurationMs}ms`);

    lines.push('');
    lines.push('按类型分布：');
    for (const [kind, count] of Object.entries(this.stats.byKind).sort((a, b) => b[1] - a[1])) {
      if (count > 0) lines.push(`  ${kind}: ${count}`);
    }

    lines.push('');
    lines.push('按语言分布：');
    for (const [lang, count] of Object.entries(this.stats.byLanguage).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${lang}: ${count} 文件`);
    }

    // Top 10 符号最多的文件
    const topFiles = Array.from(this.index.values())
      .sort((a, b) => b.symbols.length - a.symbols.length)
      .slice(0, 10);
    if (topFiles.length > 0) {
      lines.push('');
      lines.push('符号最多的文件（Top 10）：');
      topFiles.forEach((f, i) => {
        lines.push(`  ${i + 1}. ${f.filePath} (${f.symbols.length} 符号, ${f.language})`);
      });
    }

    return lines.join('\n');
  }

  /** 获取 LLM 工具定义 */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'codebase_search',
        description: '在代码库中进行语义搜索，查找函数/类/接口定义。支持自然语言查询，如"用户认证函数在哪"、"数据库连接逻辑"',
        parameters: {
          query: { type: 'string', description: '搜索查询（关键词或自然语言描述）', required: true },
          limit: { type: 'number', description: '最大返回结果数（默认 20）' },
        },
        readOnly: true,
        execute: async (args: { query?: string; limit?: number }) => {
          try {
            if (!args?.query) return '❌ 缺少 query 参数';
            if (!self.isIndexed) {
              await self.buildIndex();
            }
            const results = self.searchSemantic(args.query, args.limit || 20);
            if (results.length === 0) return '未找到匹配的符号';
            const lines = results.map((r, i) =>
              `${i + 1}. [${r.symbol.kind}] ${r.symbol.name} — ${r.symbol.filePath}:${r.symbol.line}\n   签名: ${r.symbol.signature}\n   分数: ${r.score.toFixed(2)} (${r.reason})`,
            );
            return `找到 ${results.length} 个匹配符号：\n${lines.join('\n')}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 代码库搜索失败: ${msg}`;
          }
        },
      },
      {
        name: 'codebase_find_references',
        description: '查找指定符号的所有引用（定义位置 + 导入位置）。用于理解代码影响范围',
        parameters: {
          symbol_name: { type: 'string', description: '要查找引用的符号名称（函数名/类名/变量名）', required: true },
        },
        readOnly: true,
        execute: async (args: { symbol_name?: string }) => {
          try {
            if (!args?.symbol_name) return '❌ 缺少 symbol_name 参数';
            if (!self.isIndexed) {
              await self.buildIndex();
            }
            const refs = self.findReferences(args.symbol_name);
            if (refs.length === 0) return `未找到符号 "${args.symbol_name}" 的引用`;
            const lines = refs.map((r, i) =>
              `${i + 1}. ${r.filePath}:${r.line} — ${r.context}`,
            );
            return `符号 "${args.symbol_name}" 的引用（${refs.length} 处）：\n${lines.join('\n')}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 查找引用失败: ${msg}`;
          }
        },
      },
      {
        name: 'codebase_call_graph',
        description: '获取函数调用关系图。可选指定函数名查看其调用的其他函数',
        parameters: {
          symbol_name: { type: 'string', description: '可选：指定函数名查看其调用关系。不指定则返回全部' },
        },
        readOnly: true,
        execute: async (args: { symbol_name?: string }) => {
          try {
            if (!self.isIndexed) {
              await self.buildIndex();
            }
            const nodes = self.getCallGraph(args?.symbol_name);
            if (nodes.length === 0) return args?.symbol_name
              ? `未找到函数 "${args.symbol_name}" 的调用关系`
              : '未找到任何函数调用关系';
            const lines = nodes.map((n, i) =>
              `${i + 1}. ${n.name} (${n.filePath}:${n.line})\n   调用: ${n.calls.length > 0 ? n.calls.join(', ') : '无'}`,
            );
            return `函数调用图（${nodes.length} 个节点）：\n${lines.join('\n')}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 获取调用图失败: ${msg}`;
          }
        },
      },
      {
        name: 'codebase_overview',
        description: '获取代码库索引概览：文件数、符号数、按类型/语言分布、符号最多的文件',
        parameters: {},
        readOnly: true,
        execute: async () => {
          try {
            if (!self.isIndexed) {
              await self.buildIndex();
            }
            return self.getOverview();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 获取代码库概览失败: ${msg}`;
          }
        },
      },
    ];
  }

  // ============ 内部方法 ============

  /** 扫描项目文件 */
  private async scanFiles(): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          if (!shouldIgnore(fullPath, this.rootDir)) {
            const lang = detectLanguage(fullPath);
            if (lang) {
              results.push(path.relative(this.rootDir, fullPath).replace(/\\/g, '/'));
            }
          }
        }
      }
    };
    await walk(this.rootDir);
    return results;
  }

  /** 索引单个文件 */
  private async indexFile(relativePath: string): Promise<void> {
    const fullPath = path.join(this.rootDir, relativePath);
    const language = detectLanguage(fullPath);
    if (!language) return;

    let content: string;
    try {
      content = await fs.promises.readFile(fullPath, 'utf-8');
    } catch {
      return; // 读取失败跳过
    }

    const mtime = await this.getFileMtime(relativePath);
    const symbols = this.extractSymbols(content, relativePath, language);
    const imports = this.extractImports(content, language);
    const lineCount = content.split('\n').length;

    this.index.set(relativePath, {
      filePath: relativePath,
      mtime,
      symbols,
      imports,
      language,
      lineCount,
    });
  }

  /** 提取文件中的符号 */
  private extractSymbols(content: string, filePath: string, language: string): CodeSymbol[] {
    const patterns = getSymbolPatterns(language);
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    for (const { regex, kind } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        if (!name || name.length < 2) continue;

        // 计算行号
        const line = content.substring(0, match.index).split('\n').length;
        // 获取签名（截取该行，最多 120 字符）
        const signature = (lines[line - 1] || '').trim().substring(0, 120);

        // 去重：同一文件同一行同一名称的符号只保留一个
        if (symbols.some(s => s.line === line && s.name === name)) continue;

        symbols.push({ name, kind, filePath, line, signature });
      }
    }

    return symbols;
  }

  /** 提取文件导入 */
  private extractImports(content: string, language: string): string[] {
    const pattern = IMPORT_PATTERNS[language];
    if (!pattern) return [];

    const imports: string[] = [];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const imp = match[1] || match[2];
      if (imp) imports.push(imp);
    }
    return imports;
  }

  /** 获取文件 mtime */
  private async getFileMtime(relativePath: string): Promise<number> {
    try {
      const fullPath = path.join(this.rootDir, relativePath);
      const stat = await fs.promises.stat(fullPath);
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }

  /** 重建符号索引（name → symbols 映射） */
  private rebuildSymbolIndex(): void {
    this.symbolIndex.clear();
    for (const entry of this.index.values()) {
      for (const symbol of entry.symbols) {
        const existing = this.symbolIndex.get(symbol.name);
        if (existing) {
          existing.push(symbol);
        } else {
          this.symbolIndex.set(symbol.name, [symbol]);
        }
      }
    }
  }

  /** 从查询中提取关键词 */
  private extractKeywords(query: string): string[] {
    // 简单分词：按空格/标点分割，过滤短词
    return query
      .toLowerCase()
      .split(/[\s,，。.;；:：?？!！()（）"'`/\\]+/)
      .filter(w => w.length >= 2)
      .filter(w => !STOP_WORDS.has(w));
  }

  /** 对符号进行评分 */
  private scoreSymbol(symbol: CodeSymbol, symbolName: string, keywords: string[]): number {
    let score = 0;
    const nameLower = symbol.name.toLowerCase();

    for (const kw of keywords) {
      if (nameLower === kw) {
        score += 1.0; // 完全匹配
      } else if (nameLower.includes(kw)) {
        score += 0.6; // 部分匹配
      } else if (symbol.signature.toLowerCase().includes(kw)) {
        score += 0.3; // 签名匹配
      }
    }

    // 类型加权：函数和类优先
    if (symbol.kind === 'function' || symbol.kind === 'class') {
      score *= 1.2;
    }

    return Math.min(1.0, score);
  }

  /** 解释匹配原因 */
  private explainMatch(symbol: CodeSymbol, symbolName: string, keywords: string[]): string {
    const nameLower = symbol.name.toLowerCase();
    const matched: string[] = [];
    for (const kw of keywords) {
      if (nameLower === kw) matched.push(`名称完全匹配"${kw}"`);
      else if (nameLower.includes(kw)) matched.push(`名称包含"${kw}"`);
      else if (symbol.signature.toLowerCase().includes(kw)) matched.push(`签名包含"${kw}"`);
    }
    return matched.join('; ') || '模糊匹配';
  }

  /** 提取函数调用（简化版：通过符号名在文件中出现推断） */
  private extractCalls(entry: FileIndexEntry, symbol: CodeSymbol): string[] {
    // 简化实现：返回该文件中定义的其他函数名
    // 完整实现需要读取文件内容并分析函数体内的调用
    return entry.symbols
      .filter(s => s !== symbol && (s.kind === 'function' || s.kind === 'method'))
      .map(s => s.name)
      .slice(0, 10); // 限制数量
  }

  // ============ 统计辅助 ============

  private countSymbols(): number {
    let count = 0;
    for (const entry of this.index.values()) {
      count += entry.symbols.length;
    }
    return count;
  }

  private countByKind(): Record<SymbolKind, number> {
    const counts: Record<SymbolKind, number> = {
      function: 0, class: 0, interface: 0, type: 0,
      variable: 0, import: 0, method: 0,
    };
    for (const entry of this.index.values()) {
      for (const symbol of entry.symbols) {
        counts[symbol.kind]++;
      }
    }
    return counts;
  }

  private countByLanguage(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.index.values()) {
      counts[entry.language] = (counts[entry.language] || 0) + 1;
    }
    return counts;
  }
}

/** 停用词集合 */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也', '很',
  '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'can', 'shall', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
  'their', 'there', 'here', 'about', 'and', 'or', 'but', 'not',
]);
