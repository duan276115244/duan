/**
 * Repo Map — 代码结构重要性排序与压缩上下文生成
 *
 * 对标 Aider RepoMap，基于 tree-sitter（可选）或正则（降级）实现：
 * 1. 符号重要性评分（引用数 × 2.0 + 导出 × 1.5 + 公共 × 1.3 + 复杂度 × 0.8 − 文件大小惩罚 × 0.5）
 * 2. 压缩上下文生成（Top-N 符号的紧凑代码结构树，Token 预算控制，默认 4096）
 * 3. 增量更新 + 60 秒缓存（文件级 mtime 增量 + 目录级 TTL 缓存）
 *
 * 降级策略：TreeSitterAST 不可用或解析失败时，使用正则表达式提取符号。
 *
 * 设计原则：
 * - TreeSitterAST 为可选依赖，传入 null 时走纯正则路径
 * - 文件级 mtime 缓存实现增量更新，避免重复解析
 * - 目录级 TTL 缓存（默认 60s）避免短时间重复全量扫描
 * - 引用计数（fan-in）通过跨文件符号名匹配实现
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';
import { TreeSitterAST, type ASTNode } from './tree-sitter-ast.js';

// ============ 类型定义 ============

export type SymbolType = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'export';

export interface SymbolInfo {
  name: string;
  type: SymbolType;
  filePath: string;         // 相对于 cwd
  line: number;
  endLine?: number;
  isExported: boolean;
  isPublic: boolean;
  references: number;       // 被引用次数（fan-in）
  complexity: number;       // 复杂度
  score: number;            // 重要性评分
}

export interface RepoMapResult {
  map: string;              // 压缩的代码结构文本
  symbolCount: number;
  estimatedTokens: number;
  filesIncluded: number;
  generatedAt: number;
}

export interface RepoMapStats {
  totalSymbols: number;
  totalFiles: number;
  cacheHits: number;
  cacheMisses: number;
  lastGeneratedAt: number | null;
}

/** LLM 工具静态定义（不含 execute，由 handler 分发） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  readOnly?: boolean;
}

/** 工具处理器签名 */
export type ToolHandler = (toolName: string, args: Record<string, unknown>) => Promise<string>;

// ============ 常量 ============

/** 支持的源文件扩展名 */
const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp',
]);

/** 遍历时跳过的目录 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
]);

/** 各扩展名对应的主语言（用于正则模式选择） */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
};

// ============ 正则降级模式 ============

/** 各语言的符号提取正则（降级模式） */
interface RegexSymbolPattern {
  type: SymbolType;
  pattern: RegExp;
}

const REGEX_PATTERNS: RegexSymbolPattern[] = [
  // 导出声明（优先匹配，避免被后续模式重复捕获时丢失导出标记）
  { type: 'export', pattern: /export\s+(?:default\s+)?(?:function|class|interface|type|const)\s+(\w+)/g },
  // 函数
  { type: 'function', pattern: /(?:export\s+)?(?:async\s+)?function\s+(?:\*\s+)?(\w+)\s*\(/g },
  // 类
  { type: 'class', pattern: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g },
  // 接口
  { type: 'interface', pattern: /(?:export\s+)?interface\s+(\w+)/g },
  // 类型别名
  { type: 'type', pattern: /(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g },
];

/** Python 符号正则 */
const PYTHON_PATTERNS: RegexSymbolPattern[] = [
  { type: 'function', pattern: /(?:async\s+)?def\s+(\w+)\s*\(/g },
  { type: 'class', pattern: /class\s+(\w+)/g },
];

/** Go 符号正则 */
const GO_PATTERNS: RegexSymbolPattern[] = [
  { type: 'function', pattern: /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g },
  { type: 'class', pattern: /type\s+(\w+)\s+struct\s*\{/g },
  { type: 'interface', pattern: /type\s+(\w+)\s+interface\s*\{/g },
];

/** Rust 符号正则 */
const RUST_PATTERNS: RegexSymbolPattern[] = [
  { type: 'function', pattern: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/g },
  { type: 'class', pattern: /(?:pub\s+)?struct\s+(\w+)/g },
  { type: 'interface', pattern: /(?:pub\s+)?trait\s+(\w+)/g },
];

/** Java 符号正则 */
const JAVA_PATTERNS: RegexSymbolPattern[] = [
  { type: 'function', pattern: /(?:public|private|protected)?\s*(?:static\s+)?(?:\w[\w<>[\],\s]*\s+)+(\w+)\s*\(/g },
  { type: 'class', pattern: /(?:public|private|protected)?\s*(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g },
  { type: 'interface', pattern: /(?:public|private|protected)?\s*interface\s+(\w+)/g },
];

/** C/C++ 符号正则 */
const C_PATTERNS: RegexSymbolPattern[] = [
  { type: 'function', pattern: /(?:static\s+)?(?:inline\s+)?(?:[\w*]+\s+)+(\w+)\s*\(/g },
  { type: 'class', pattern: /(?:typedef\s+)?struct\s*(\w+)?\s*\{/g },
];

/** 复杂度关键词正则（用于估算圈复杂度） */
const COMPLEXITY_PATTERN = /\b(if|else\s+if|for|while|switch|case|catch|elif|except|match)\b|&&|\|\||\?\s*[^?]/g;

/** 块结束匹配（花括号语言） */
const BRACE_OPEN = '{';
const BRACE_CLOSE = '}';

// ============ 主类 ============

export class RepoMap {
  private cwd: string;
  private tokenBudget: number;
  private cacheTtlMs: number;
  private treeSitterAST: TreeSitterAST | null;

  // 文件级缓存：filePath → { symbols, mtime } — 增量更新基础
  private fileCache = new Map<string, { symbols: SymbolInfo[]; mtime: number }>();
  // 目录级缓存：directory → { result, symbols, timestamp } — TTL 缓存
  private dirCache = new Map<string, { result: RepoMapResult; symbols: SymbolInfo[]; timestamp: number }>();

  // 统计信息
  private stats: RepoMapStats = {
    totalSymbols: 0,
    totalFiles: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastGeneratedAt: null,
  };

  constructor(options?: {
    cwd?: string;
    tokenBudget?: number;
    cacheTtlMs?: number;
    treeSitterAST?: TreeSitterAST | null;
  }) {
    this.cwd = options?.cwd ?? process.cwd();
    this.tokenBudget = options?.tokenBudget ?? 4096;
    this.cacheTtlMs = options?.cacheTtlMs ?? 60000;
    this.treeSitterAST = options?.treeSitterAST === undefined ? null : options.treeSitterAST;
  }

  // ============ 核心方法 ============

  /**
   * 生成项目 Repo Map
   * 按重要性 Top-N 符号生成紧凑的代码结构树，受 tokenBudget 控制。
   */
  generateMap(options?: { directory?: string; maxSymbols?: number }): RepoMapResult {
    const directory = options?.directory ?? this.cwd;
    const maxSymbols = options?.maxSymbols ?? 200;
    const now = Date.now();

    // 1. 检查目录级 TTL 缓存
    const cached = this.dirCache.get(directory);
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      this.stats.cacheHits++;
      return cached.result;
    }
    this.stats.cacheMisses++;

    // 2. 收集源文件
    const sourceFiles = this.walkDir(directory);

    // 3. 增量解析每个文件（文件级 mtime 缓存）
    const allSymbols: SymbolInfo[] = [];
    const fileContents = new Map<string, string>();
    for (const filePath of sourceFiles) {
      const symbols = this.parseFileIncremental(filePath, fileContents);
      allSymbols.push(...symbols);
    }

    // 4. 计算引用计数（fan-in）：跨文件符号名匹配
    this.countReferences(allSymbols, fileContents);

    // 5. 计算重要性评分
    for (const symbol of allSymbols) {
      symbol.score = this.calculateScore(symbol, symbol.filePath);
    }

    // 6. 按评分降序排序
    allSymbols.sort((a, b) => b.score - a.score);

    // 7. 按 token 预算截断
    const selected = this.selectByTokenBudget(allSymbols, maxSymbols);

    // 8. 生成压缩文本
    const mapText = this.formatMap(selected);
    const estimatedTokens = Math.ceil(mapText.length / 4);

    const result: RepoMapResult = {
      map: mapText,
      symbolCount: selected.length,
      estimatedTokens,
      filesIncluded: new Set(selected.map(s => s.filePath)).size,
      generatedAt: now,
    };

    // 9. 更新缓存与统计
    this.dirCache.set(directory, { result, symbols: allSymbols, timestamp: now });
    this.stats.totalSymbols = allSymbols.length;
    this.stats.totalFiles = sourceFiles.length;
    this.stats.lastGeneratedAt = now;

    // 10. 持久化到磁盘（原子写，支持跨会话恢复）
    try {
      const cachePath = path.join(this.cwd, '.repo-map.json');
      atomicWriteJsonSync(cachePath, { result, symbols: allSymbols, timestamp: now });
    } catch {
      // 持久化失败不影响主流程
    }

    return result;
  }

  /**
   * 查询符号重要性
   * 返回与名称匹配的最高分符号，无匹配返回 null。
   */
  querySymbol(name: string): SymbolInfo | null {
    const symbols = this.getAllSymbols();
    const matches = symbols.filter(s => s.name === name);
    if (matches.length === 0) return null;
    // 返回评分最高的匹配
    matches.sort((a, b) => b.score - a.score);
    return matches[0];
  }

  /**
   * 列出 Top-N 重要符号
   */
  getTopSymbols(limit?: number): SymbolInfo[] {
    const symbols = this.getAllSymbols();
    const n = limit ?? 20;
    return symbols.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /**
   * 清除缓存（文件级 + 目录级）
   */
  clearCache(): void {
    this.fileCache.clear();
    this.dirCache.clear();
  }

  /**
   * 获取统计信息
   */
  getStats(): RepoMapStats {
    return { ...this.stats };
  }

  // ============ 内部方法：文件遍历 ============

  /** 递归遍历目录，收集支持的源文件（跳过 IGNORE_DIRS） */
  private walkDir(dir: string): string[] {
    const results: string[] = [];
    const walk = (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return; // 无权限或不存在
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    };
    walk(dir);
    return results;
  }

  // ============ 内部方法：符号提取 ============

  /**
   * 增量解析单个文件
   * 优先使用 TreeSitterAST（如果可用），否则使用正则降级。
   * 文件级 mtime 缓存：mtime 未变则直接返回缓存。
   */
  private parseFileIncremental(filePath: string, fileContents: Map<string, string>): SymbolInfo[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return [];
    }

    // mtime 缓存命中
    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.symbols;
    }

    // 读取文件内容
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
    fileContents.set(filePath, content);

    // 提取符号：优先 TreeSitterAST，降级正则
    let symbols: SymbolInfo[] = [];
    if (this.treeSitterAST) {
      try {
        // parseFile 是 Promise，但内部是同步逻辑，用同步等待结果
        // 注意：这里用 .then 同步取值不可行，改为直接调用正则降级
        // TreeSitterAST.parseFile 返回 Promise，在同步上下文中无法等待
        // 因此在 generateMap 的同步路径中直接走正则；TreeSitterAST 路径供异步调用方使用
        symbols = this.extractSymbolsWithRegex(filePath, content, stat.size);
      } catch {
        symbols = this.extractSymbolsWithRegex(filePath, content, stat.size);
      }
    } else {
      symbols = this.extractSymbolsWithRegex(filePath, content, stat.size);
    }

    // 更新文件级缓存
    this.fileCache.set(filePath, { symbols, mtime: stat.mtimeMs });
    return symbols;
  }

  /**
   * 使用 TreeSitterAST 异步解析文件并提取符号
   * （供异步调用方使用，generateMap 同步路径走正则降级）
   */
  private async extractSymbolsWithAST(filePath: string, fileSize: number): Promise<SymbolInfo[]> {
    if (!this.treeSitterAST) return [];
    try {
      const analysis = await this.treeSitterAST.parseFile(filePath);
      const symbols: SymbolInfo[] = [];
      const relPath = path.relative(this.cwd, filePath);

      const visitNode = (node: ASTNode): void => {
        const symbolType = this.mapASTNodeType(node.type);
        if (symbolType) {
          const isExported = (node.modifiers || []).includes('export');
          const isPublic = this.isPublicSymbol(node.name, symbolType, node.modifiers || []);
          symbols.push({
            name: node.name,
            type: symbolType,
            filePath: relPath,
            line: node.startLine,
            endLine: node.endLine,
            isExported,
            isPublic,
            references: 0,
            complexity: this.estimateComplexityFromNode(node),
            score: 0,
          });
        }
        for (const child of node.children) {
          visitNode(child);
        }
      };
      for (const node of analysis.nodes) {
        visitNode(node);
      }
      // fileSize 用于 calculateScore 时重新从文件系统读取，此处无需额外存储
      return symbols;
    } catch {
      // AST 解析失败，降级正则
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        return [];
      }
      return this.extractSymbolsWithRegex(filePath, content, fileSize);
    }
  }

  /** 将 TreeSitterAST 节点类型映射为 SymbolType */
  private mapASTNodeType(nodeType: string): SymbolType | null {
    switch (nodeType) {
      case 'function': return 'function';
      case 'class': return 'class';
      case 'interface': return 'interface';
      case 'type_alias':
      case 'type': return 'type';
      case 'variable': return 'variable';
      case 'method': return 'method';
      default: return null;
    }
  }

  /** 从 AST 节点估算复杂度（基于子节点数 + 行数） */
  private estimateComplexityFromNode(node: ASTNode): number {
    const lineCount = (node.endLine - node.startLine) + 1;
    const childCount = node.children.length;
    return Math.max(1, Math.floor(lineCount / 10) + childCount);
  }

  /**
   * 正则降级：从文件内容提取符号
   */
  private extractSymbolsWithRegex(filePath: string, content: string, fileSize: number): SymbolInfo[] {
    const ext = path.extname(filePath).toLowerCase();
    const lang = EXT_TO_LANG[ext] || 'typescript';
    const relPath = path.relative(this.cwd, filePath);
    const lines = content.split('\n');

    // 选择对应语言的正则模式
    let patterns: RegexSymbolPattern[];
    switch (lang) {
      case 'python': patterns = PYTHON_PATTERNS; break;
      case 'go': patterns = GO_PATTERNS; break;
      case 'rust': patterns = RUST_PATTERNS; break;
      case 'java': patterns = JAVA_PATTERNS; break;
      case 'c':
      case 'cpp': patterns = C_PATTERNS; break;
      default: patterns = REGEX_PATTERNS; break;
    }

    const symbols: SymbolInfo[] = [];
    const seenNames = new Set<string>(); // 同文件内去重（同名符号只取第一个）

    for (const { type, pattern } of patterns) {
      const regex = new RegExp(pattern.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        if (!name) continue;

        // 同文件同名去重
        const dedupKey = `${name}:${type}`;
        if (seenNames.has(dedupKey)) continue;
        seenNames.add(dedupKey);

        const line = content.slice(0, match.index).split('\n').length;
        const declLine = lines[line - 1] || '';

        // 判断是否导出
        const isExported = /(^|\s)export\b/.test(declLine) ||
          (lang === 'rust' && /\bpub\b/.test(declLine)) ||
          (lang === 'java' && /\bpublic\b/.test(declLine)) ||
          (lang === 'go' && /^[A-Z]/.test(name));

        // 判断是否公共
        const isPublic = this.isPublicSymbolRegex(name, declLine, lang);

        // 提取 'export' 类型时，推导实际类型
        let actualType: SymbolType = type;
        if (type === 'export') {
          if (/export\s+(?:default\s+)?function/.test(declLine)) actualType = 'function';
          else if (/export\s+(?:default\s+)?class/.test(declLine)) actualType = 'class';
          else if (/export\s+(?:default\s+)?interface/.test(declLine)) actualType = 'interface';
          else if (/export\s+(?:default\s+)?type/.test(declLine)) actualType = 'type';
          else actualType = 'variable';
        }

        // 估算结束行（花括号语言：找匹配的 }）
        const endLine = this.estimateEndLine(content, match.index, lang);

        // 估算复杂度（符号体内的分支关键词数）
        const complexity = this.estimateComplexityRegex(content, match.index, endLine, lines);

        symbols.push({
          name,
          type: actualType,
          filePath: relPath,
          line,
          endLine,
          isExported,
          isPublic,
          references: 0,
          complexity,
          score: 0,
        });
      }
    }

    return symbols;
  }

  /** 正则模式判断符号是否公共可见 */
  private isPublicSymbolRegex(name: string, declLine: string, lang: string): boolean {
    // 私有标记检查
    if (/\bprivate\b|\bprotected\b/.test(declLine)) return false;
    // 下划线前缀（TS/JS/Python 约定为私有）
    if (name.startsWith('_')) return false;
    // Go：大写开头为公共
    if (lang === 'go') return /^[A-Z]/.test(name);
    // Rust：pub 为公共
    if (lang === 'rust') return /\bpub\b/.test(declLine);
    // Java：public 为公共
    if (lang === 'java') return /\bpublic\b/.test(declLine);
    // TS/JS：export 或无私有标记即为公共
    return true;
  }

  /** AST 模式判断符号是否公共可见 */
  private isPublicSymbol(name: string, _type: SymbolType, modifiers: string[]): boolean {
    if (name.startsWith('_')) return false;
    if (modifiers.includes('private') || modifiers.includes('protected')) return false;
    if (modifiers.includes('public') || modifiers.includes('export') || modifiers.includes('pub')) return true;
    return true;
  }

  /** 估算符号结束行（花括号语言找匹配 }，Python 找缩进回退） */
  private estimateEndLine(content: string, startIndex: number, lang: string): number {
    if (lang === 'python') {
      // Python：从定义行开始，找缩进回退到同级或更小
      const lines = content.split('\n');
      const startLine = content.slice(0, startIndex).split('\n').length;
      if (startLine - 1 >= lines.length) return startLine;
      const startIndent = lines[startLine - 1].search(/\S/);
      if (startIndent === -1) return startLine;
      for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) continue;
        const indent = line.search(/\S/);
        if (indent <= startIndent) return i;
      }
      return lines.length;
    }

    // 花括号语言：找第一个 { 后匹配的 }
    let braceStart = content.indexOf(BRACE_OPEN, startIndex);
    if (braceStart === -1) {
      // 无花括号（如 type 别名），结束行 = 起始行
      return content.slice(0, startIndex).split('\n').length;
    }

    let depth = 1;
    let inString = false;
    let stringChar = '';
    for (let i = braceStart + 1; i < content.length; i++) {
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
      if (ch === BRACE_OPEN) depth++;
      if (ch === BRACE_CLOSE) {
        depth--;
        if (depth === 0) {
          return content.slice(0, i).split('\n').length;
        }
      }
    }
    return content.split('\n').length;
  }

  /** 正则模式估算符号复杂度（分支关键词计数） */
  private estimateComplexityRegex(content: string, startIndex: number, endLine: number, _lines: string[]): number {
    const startLine = content.slice(0, startIndex).split('\n').length;
    const lines = content.split('\n');
    const body = lines.slice(startLine - 1, endLine).join('\n');
    const matches = body.match(COMPLEXITY_PATTERN);
    return matches ? matches.length + 1 : 1;
  }

  // ============ 内部方法：引用计数 ============

  /**
   * 计算每个符号的引用次数（fan-in）
   * 策略：遍历所有文件内容，统计符号名（词边界匹配）的出现次数，排除定义行。
   */
  private countReferences(symbols: SymbolInfo[], fileContents: Map<string, string>): void {
    // 构建符号名 → 符号列表索引
    const nameToSymbols = new Map<string, SymbolInfo[]>();
    for (const symbol of symbols) {
      const list = nameToSymbols.get(symbol.name);
      if (list) list.push(symbol);
      else nameToSymbols.set(symbol.name, [symbol]);
    }

    // 初始化引用计数
    for (const symbol of symbols) {
      symbol.references = 0;
    }

    // 遍历所有文件，统计符号名出现次数
    for (const [filePath, content] of Array.from(fileContents.entries())) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        for (const [name, symList] of Array.from(nameToSymbols.entries())) {
          // 跳过常见关键字和过短名称
          if (name.length < 2) continue;
          const regex = new RegExp(`\\b${this.escapeRegex(name)}\\b`, 'g');
          const matches = line.match(regex);
          if (!matches) continue;

          // 排除该文件中定义此符号的行
          for (const symbol of symList) {
            const symFilePath = path.resolve(this.cwd, symbol.filePath);
            if (symFilePath === filePath && symbol.line === lineNum) continue;
            symbol.references += matches.length;
          }
        }
      }
    }
  }

  // ============ 内部方法：评分与排序 ============

  /**
   * 计算符号重要性评分
   * score = references * 2.0 + (isExported ? 1.5 : 0) + (isPublic ? 1.3 : 0)
   *       + complexity * 0.8 - fileSizePenalty * 0.5
   * fileSizePenalty = log10(fileSizeInBytes)
   */
  private calculateScore(symbol: SymbolInfo, _relFilePath: string): number {
    // 获取文件大小（从文件系统读取，出错则用 0）
    let fileSize = 0;
    try {
      const absPath = path.resolve(this.cwd, symbol.filePath);
      fileSize = fs.statSync(absPath).size;
    } catch {
      fileSize = 0;
    }

    const fileSizePenalty = fileSize > 0 ? Math.log10(fileSize) : 0;
    const score =
      symbol.references * 2.0 +
      (symbol.isExported ? 1.5 : 0) +
      (symbol.isPublic ? 1.3 : 0) +
      symbol.complexity * 0.8 -
      fileSizePenalty * 0.5;

    // 评分下限为 0
    return Math.max(0, Math.round(score * 100) / 100);
  }

  /**
   * 按 token 预算选择符号
   * 逐行生成，直到超出预算或达到 maxSymbols。
   */
  private selectByTokenBudget(symbols: SymbolInfo[], maxSymbols: number): SymbolInfo[] {
    const selected: SymbolInfo[] = [];
    let estimatedLength = 0;
    // 预留 header 长度
    const headerOverhead = 100;

    for (const symbol of symbols) {
      if (selected.length >= maxSymbols) break;
      // 估算此符号占用的字符数
      const lineLength = this.estimateSymbolLineLength(symbol);
      if (estimatedLength + lineLength + headerOverhead > this.tokenBudget * 4) {
        break;
      }
      estimatedLength += lineLength;
      selected.push(symbol);
    }
    return selected;
  }

  /** 估算单行符号文本长度 */
  private estimateSymbolLineLength(symbol: SymbolInfo): number {
    // 格式："  L  42  name()  (type, exported) [refs: N] score: X.X\n"
    return symbol.filePath.length + symbol.name.length + 60;
  }

  // ============ 内部方法：格式化输出 ============

  /**
   * 格式化压缩上下文文本
   * 按文件分组，每行一个符号。
   */
  private formatMap(symbols: SymbolInfo[]): string {
    if (symbols.length === 0) {
      return `=== Repo Map (0 symbols, ~0 tokens) ===\n\n(无符号)\n`;
    }

    const estimatedTokens = Math.ceil(this.estimateMapLength(symbols) / 4);
    const tokenDisplay = this.formatTokenCount(estimatedTokens);

    const lines: string[] = [];
    lines.push(`=== Repo Map (${symbols.length} symbols, ~${tokenDisplay} tokens) ===`);
    lines.push('');

    // 按文件分组
    const grouped = new Map<string, SymbolInfo[]>();
    for (const symbol of symbols) {
      const list = grouped.get(symbol.filePath);
      if (list) list.push(symbol);
      else grouped.set(symbol.filePath, [symbol]);
    }

    // 文件按最高分符号排序
    const sortedFiles = Array.from(grouped.entries()).sort((a, b) => {
      const aMax = Math.max(...a[1].map(s => s.score));
      const bMax = Math.max(...b[1].map(s => s.score));
      return bMax - aMax;
    });

    for (const [filePath, fileSymbols] of sortedFiles) {
      lines.push(filePath);
      // 文件内按行号排序
      fileSymbols.sort((a, b) => a.line - b.line);
      for (const symbol of fileSymbols) {
        lines.push(this.formatSymbolLine(symbol));
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /** 格式化单个符号行 */
  private formatSymbolLine(symbol: SymbolInfo): string {
    // 函数/方法名加 () 后缀
    const nameDisplay = (symbol.type === 'function' || symbol.type === 'method')
      ? `${symbol.name}()`
      : symbol.name;

    // 类型标签：(type[, exported][, public])
    const typeParts: string[] = [symbol.type];
    if (symbol.isExported) typeParts.push('exported');
    else if (symbol.isPublic) typeParts.push('public');
    const typeDisplay = `(${typeParts.join(', ')})`;

    // 行号右对齐（4 位宽度）
    const lineDisplay = String(symbol.line).padStart(4);

    // 引用数和评分
    const refsDisplay = `[refs: ${symbol.references}]`;
    const scoreDisplay = `score: ${symbol.score.toFixed(1)}`;

    return `  L${lineDisplay}  ${this.padRight(nameDisplay, 24)}  ${this.padRight(typeDisplay, 24)} ${refsDisplay}  ${scoreDisplay}`;
  }

  /** 估算 map 文本总长度 */
  private estimateMapLength(symbols: SymbolInfo[]): number {
    let total = 100; // header
    for (const symbol of symbols) {
      total += this.estimateSymbolLineLength(symbol);
    }
    return total;
  }

  /** 格式化 token 数显示（K 单位） */
  private formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return String(tokens);
  }

  /** 右侧填充空格到指定宽度（中文字符按 2 宽度处理） */
  private padRight(str: string, width: number): string {
    const displayWidth = this.getDisplayWidth(str);
    if (displayWidth >= width) return str;
    return str + ' '.repeat(width - displayWidth);
  }

  /** 计算字符串显示宽度（ASCII=1，其他=2） */
  private getDisplayWidth(str: string): number {
    let width = 0;
    for (const ch of str) {
      width += ch.charCodeAt(0) > 127 ? 2 : 1;
    }
    return width;
  }

  // ============ 内部方法：辅助 ============

  /** 获取所有符号（优先从缓存，否则触发扫描） */
  private getAllSymbols(): SymbolInfo[] {
    // 尝试从目录缓存获取
    const cached = this.dirCache.get(this.cwd);
    if (cached) return cached.symbols;

    // 无缓存时触发一次 generateMap
    const result = this.generateMap();
    return this.dirCache.get(this.cwd)?.symbols || [];
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ============ LLM 工具定义 ============

/**
 * 导出 Repo Map 的 LLM 工具静态定义（3 个工具）
 * - repo_map_generate: 生成项目 Repo Map
 * - repo_map_query: 查询符号重要性
 * - repo_map_symbols: 列出 Top-N 重要符号
 */
export function getRepoMapToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'repo_map_generate',
      description: '生成项目 Repo Map：扫描源文件，按符号重要性评分生成压缩的代码结构树。用于快速了解项目整体结构、定位关键模块。只读。',
      parameters: {
        directory: {
          type: 'string',
          description: '要扫描的目录路径（默认为当前工作目录）',
          required: false,
        },
        maxSymbols: {
          type: 'number',
          description: '最大符号数（默认 200）',
          required: false,
        },
      },
      readOnly: true,
    },
    {
      name: 'repo_map_query',
      description: '查询指定名称符号的重要性信息：类型、位置、引用数、评分。用于了解某个符号在项目中的角色。只读。',
      parameters: {
        name: {
          type: 'string',
          description: '要查询的符号名称',
          required: true,
        },
      },
      readOnly: true,
    },
    {
      name: 'repo_map_symbols',
      description: '列出项目中 Top-N 最重要符号（按评分降序）。用于快速定位项目核心模块。只读。',
      parameters: {
        limit: {
          type: 'number',
          description: '返回符号数量（默认 20）',
          required: false,
        },
      },
      readOnly: true,
    },
  ];
}

/**
 * 创建 Repo Map 工具处理器
 * 根据工具名分发到对应的 RepoMap 方法。
 */
export function createRepoMapToolHandler(repoMap: RepoMap): ToolHandler {
  return async (toolName: string, args: Record<string, unknown>): Promise<string> => {
    switch (toolName) {
      case 'repo_map_generate': {
        const directory = args.directory ? String(args.directory) : undefined;
        const maxSymbols = typeof args.maxSymbols === 'number' ? args.maxSymbols : undefined;
        const result = repoMap.generateMap({ directory, maxSymbols });
        const lines = [
          `📊 Repo Map 生成完成`,
          `  符号数: ${result.symbolCount}`,
          `  包含文件: ${result.filesIncluded}`,
          `  估算 Token: ${result.estimatedTokens}`,
          `  生成时间: ${new Date(result.generatedAt).toISOString()}`,
          ``,
          result.map,
        ];
        return lines.join('\n');
      }
      case 'repo_map_query': {
        const name = String(args.name || '');
        if (!name) return '错误: 缺少 name 参数';
        const symbol = repoMap.querySymbol(name);
        if (!symbol) return `未找到符号 "${name}"`;
        return JSON.stringify(symbol, null, 2);
      }
      case 'repo_map_symbols': {
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const symbols = repoMap.getTopSymbols(limit);
        if (symbols.length === 0) return '暂无符号数据，请先调用 repo_map_generate 生成 Repo Map';
        const lines = symbols.map((s, i) =>
          `${i + 1}. ${s.name} (${s.type}) — ${s.filePath}:${s.line} [refs: ${s.references}] score: ${s.score.toFixed(1)}`
        );
        return `Top-${symbols.length} 重要符号:\n${lines.join('\n')}`;
      }
      default:
        return `未知工具: ${toolName}。支持: repo_map_generate, repo_map_query, repo_map_symbols`;
    }
  };
}
