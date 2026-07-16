/**
 * v20.0 §3.2 动态上下文发现 — ContextDiscoverer
 *
 * 对标 Cursor dynamic discovery：Agent 主动发现相关文件，而非用户指定。
 *
 * 三大发现策略：
 * 1. 从用户问题提取关键词 → 查代码库索引（CodebaseIndexer.searchSemantic）
 * 2. 从当前打开文件 → 找相关文件（import / require 关系）
 * 3. 从 git diff → 找最近变更文件
 *
 * 上下文预算：token 限制下动态裁剪（保留最相关 N 个文件）
 * 透明化：在思考阶段输出"我发现这些文件相关：..."
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';
import type { CodebaseIndexer, SearchResult } from './codebase-indexer.js';

// ============ 类型定义 ============

/** 发现来源 */
export type DiscoverySource = 'query' | 'openfile' | 'gitdiff';

/** 上下文发现结果项 */
export interface DiscoveredFile {
  /** 文件相对路径（相对项目根目录） */
  filePath: string;
  /** 相关性分数（0-1，越高越相关） */
  score: number;
  /** 发现来源 */
  source: DiscoverySource;
  /** 相关原因 */
  reason: string;
  /** 匹配的符号（仅 query 来源） */
  matchedSymbols?: string[];
  /** 估算的 token 数（粗略：字符数/4） */
  estimatedTokens?: number;
}

/** 发现选项 */
export interface DiscoveryOptions {
  /** 项目根目录 */
  cwd?: string;
  /** 当前打开的文件路径（相对或绝对） */
  openFilePath?: string;
  /** token 预算上限（默认 8000） */
  tokenBudget?: number;
  /** 最大返回文件数（默认 20） */
  maxFiles?: number;
  /** 是否包含 git diff 来源（默认 true） */
  includeGitDiff?: boolean;
}

/** 发现汇总 */
export interface DiscoveryResult {
  /** 发现的文件列表（按分数降序） */
  files: DiscoveredFile[];
  /** 总估算 token 数 */
  totalEstimatedTokens: number;
  /** 是否因 token 预算被裁剪 */
  truncated: boolean;
  /** 各来源的文件数 */
  bySource: Record<DiscoverySource, number>;
  /** 透明化摘要（可直接输出给用户） */
  summary: string;
}

// ============ 常量 ============

/** 默认 token 预算 */
const DEFAULT_TOKEN_BUDGET = 8000;
/** 默认最大文件数 */
const DEFAULT_MAX_FILES = 20;
/** 粗略 token 估算：4 字符 ≈ 1 token */
const CHARS_PER_TOKEN = 4;
/** 单文件最大 token 数（避免超大文件撑爆预算） */
const MAX_TOKENS_PER_FILE = 2000;
/** git diff 最大返回文件数 */
const MAX_GIT_DIFF_FILES = 15;

/** import/require 语句正则 */
const IMPORT_PATTERNS = [
  // ES module: import ... from '...' / import '...'
  /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  // CommonJS: require('...') / require("...")
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python: import ... / from ... import ...
  /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm,
  // Go: import "..." / import ( ... )
  /\bimport\s+(?:\(\s*[\s\S]*?\s*\)|\s*["']([^"']+)["'])/g,
  // Rust: use ...
  /^\s*use\s+([^;]+);/gm,
];

/** 忽略的目录（与 CodebaseIndexer 一致） */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'coverage', '.cache', '.duan', 'out', 'target',
  '.gradle', '.idea', '.vscode',
]);

/** 支持的代码文件扩展名 */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs',
  '.json', '.md', '.yaml', '.yml', '.toml',
]);

// ============ 主类 ============

export class ContextDiscoverer {
  private log = logger.child({ module: 'ContextDiscoverer' });
  private _gitDiffCache: string[] | null = null;
  private _gitDiffCacheTime = 0;
  private readonly _gitDiffCacheTtlMs = 10_000;
  private _codebaseIndexer: CodebaseIndexer | null = null;

  /** 注入 CodebaseIndexer（用于语义搜索） */
  setCodebaseIndexer(indexer: CodebaseIndexer | null): void {
    this._codebaseIndexer = indexer;
  }

  /**
   * 综合发现：合并三个来源，按分数排序，token 预算裁剪
   *
   * @param query 用户问题
   * @param codebaseIndexer 可选的代码库索引器（覆盖实例注入的）
   * @param options 发现选项
   */
  async discover(
    query: string,
    codebaseIndexer?: CodebaseIndexer | null,
    options: DiscoveryOptions = {},
  ): Promise<DiscoveryResult> {
    const cwd = options.cwd || process.cwd();
    const tokenBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
    const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
    const includeGitDiff = options.includeGitDiff !== false;
    const indexer = codebaseIndexer !== undefined ? codebaseIndexer : this._codebaseIndexer;

    this.log.debug('开始动态上下文发现', { query: query.substring(0, 80), cwd });

    const allFiles = new Map<string, DiscoveredFile>();

    // 1. 从用户问题发现（通过代码库索引）
    const queryFiles = this.discoverFromQuery(query, indexer);
    for (const f of queryFiles) {
      allFiles.set(f.filePath, f);
    }

    // 2. 从当前打开文件发现（import 关系）
    if (options.openFilePath) {
      const openFiles = await this.discoverFromOpenFile(options.openFilePath, cwd);
      for (const f of openFiles) {
        if (!allFiles.has(f.filePath)) {
          allFiles.set(f.filePath, f);
        } else {
          // 合并分数
          const existing = allFiles.get(f.filePath)!;
          existing.score = Math.min(1, existing.score + f.score * 0.5);
          existing.reason += `; ${f.reason}`;
        }
      }
    }

    // 3. 从 git diff 发现
    if (includeGitDiff) {
      const gitFiles = this.discoverFromGitDiff(cwd);
      for (const f of gitFiles) {
        if (!allFiles.has(f.filePath)) {
          allFiles.set(f.filePath, f);
        } else {
          // git diff 来源加分（最近变更的文件更可能相关）
          const existing = allFiles.get(f.filePath)!;
          existing.score = Math.min(1, existing.score + 0.15);
          existing.reason += `; 最近变更`;
        }
      }
    }

    // 按分数排序
    const sorted = Array.from(allFiles.values()).sort((a, b) => b.score - a.score);

    // 估算 token 数并裁剪
    const result = this.applyTokenBudget(sorted, tokenBudget, maxFiles);

    this.log.info('上下文发现完成', {
      total: result.files.length,
      truncated: result.truncated,
      tokens: result.totalEstimatedTokens,
    });

    return result;
  }

  /**
   * 策略 1：从用户问题提取关键词 → 查代码库索引
   */
  discoverFromQuery(query: string, codebaseIndexer: CodebaseIndexer | null): DiscoveredFile[] {
    if (!codebaseIndexer) {
      this.log.debug('未提供 CodebaseIndexer，跳过 query 来源');
      return [];
    }

    const results: SearchResult[] = codebaseIndexer.searchSemantic(query, 30);
    if (results.length === 0) return [];

    // 按文件分组，取每文件的最高分
    const byFile = new Map<string, DiscoveredFile>();
    for (const r of results) {
      const filePath = r.symbol.filePath;
      const existing = byFile.get(filePath);
      if (!existing || r.score > existing.score) {
        byFile.set(filePath, {
          filePath,
          score: Math.min(1, r.score),
          source: 'query',
          reason: r.reason,
          matchedSymbols: [r.symbol.name],
        });
      } else if (existing.matchedSymbols) {
        if (!existing.matchedSymbols.includes(r.symbol.name)) {
          existing.matchedSymbols.push(r.symbol.name);
        }
      }
    }

    return Array.from(byFile.values());
  }

  /**
   * 策略 2：从当前打开文件 → 找相关文件（import / require 关系）
   */
  async discoverFromOpenFile(openFilePath: string, cwd: string = process.cwd()): Promise<DiscoveredFile[]> {
    const absPath = path.isAbsolute(openFilePath)
      ? openFilePath
      : path.resolve(cwd, openFilePath);

    if (!fs.existsSync(absPath)) {
      this.log.debug('打开文件不存在', { path: absPath });
      return [];
    }

    const content = fs.readFileSync(absPath, 'utf-8');
    const ext = path.extname(absPath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      return [];
    }

    // 提取 import/require 语句
    const imports = this.extractImports(content);
    if (imports.length === 0) return [];

    const dir = path.dirname(absPath);
    const results: DiscoveredFile[] = [];

    for (const imp of imports) {
      const resolved = this.resolveImport(imp, dir, cwd);
      if (!resolved) continue;

      const relPath = path.relative(cwd, resolved);
      if (relPath.startsWith('..')) continue; // 跳过项目外文件
      if (this.shouldIgnore(relPath)) continue;

      if (fs.existsSync(resolved)) {
        results.push({
          filePath: this.normalizePath(relPath),
          score: 0.6,
          source: 'openfile',
          reason: `被 ${path.basename(openFilePath)} 导入`,
        });
      }
    }

    return results;
  }

  /**
   * 策略 3：从 git diff → 找最近变更文件
   */
  discoverFromGitDiff(cwd: string = process.cwd()): DiscoveredFile[] {
    const now = Date.now();
    if (this._gitDiffCache && now - this._gitDiffCacheTime < this._gitDiffCacheTtlMs) {
      return this._gitDiffCache.map((f, i) => ({
        filePath: f,
        score: Math.max(0.3, 0.7 - i * 0.03),
        source: 'gitdiff' as const,
        reason: '最近 git 变更',
      }));
    }

    try {
      // 获取 git 变更文件（已暂存 + 未暂存 + 最近 commit）
      const output = execSync('git diff --name-only HEAD~3 2>nul || git diff --name-only --cached 2>nul || git status --short', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!output) {
        this._gitDiffCache = [];
        this._gitDiffCacheTime = now;
        return [];
      }

      const files = output
        .split('\n')
        .map(line => line.trim().replace(/^[AMDRC?]+\s+/, '')) // 去除 git status 前缀
        .filter(f => f && !f.includes('→')) // 去除重命名行
        .filter(f => CODE_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .filter(f => !this.shouldIgnore(f))
        .slice(0, MAX_GIT_DIFF_FILES);

      this._gitDiffCache = files;
      this._gitDiffCacheTime = now;

      return files.map((f, i) => ({
        filePath: this.normalizePath(f),
        score: Math.max(0.3, 0.7 - i * 0.03), // 越靠前分数越高
        source: 'gitdiff' as const,
        reason: '最近 git 变更',
      }));
    } catch (err: unknown) {
      // git 不可用或非 git 仓库
      this.log.debug('git diff 不可用', {
        error: err instanceof Error ? err.message : String(err),
      });
      this._gitDiffCache = [];
      this._gitDiffCacheTime = now;
      return [];
    }
  }

  /**
   * 应用 token 预算裁剪
   */
  private applyTokenBudget(
    files: DiscoveredFile[],
    tokenBudget: number,
    maxFiles: number,
  ): DiscoveryResult {
    const bySource: Record<DiscoverySource, number> = { query: 0, openfile: 0, gitdiff: 0 };
    const selected: DiscoveredFile[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const file of files) {
      if (selected.length >= maxFiles) {
        truncated = true;
        break;
      }

      // 估算文件 token 数
      const tokens = this.estimateTokens(file.filePath);
      if (totalTokens + tokens > tokenBudget) {
        truncated = true;
        break;
      }

      file.estimatedTokens = tokens;
      totalTokens += tokens;
      selected.push(file);
      bySource[file.source]++;
    }

    return {
      files: selected,
      totalEstimatedTokens: totalTokens,
      truncated,
      bySource,
      summary: this.buildSummary(selected, truncated),
    };
  }

  /** 构建透明化摘要 */
  private buildSummary(files: DiscoveredFile[], truncated: boolean): string {
    if (files.length === 0) {
      return '🔍 未发现相关文件';
    }

    const lines: string[] = [
      `🔍 动态上下文发现：找到 ${files.length} 个相关文件${truncated ? '（已裁剪）' : ''}`,
      '',
    ];

    for (const f of files.slice(0, 10)) {
      const symbols = f.matchedSymbols ? ` [${f.matchedSymbols.join(', ')}]` : '';
      lines.push(`  • ${f.filePath}${symbols} — ${f.reason} (score: ${f.score.toFixed(2)})`);
    }

    if (files.length > 10) {
      lines.push(`  ... 还有 ${files.length - 10} 个文件`);
    }

    return lines.join('\n');
  }

  // ============ 辅助方法 ============

  /** 从文件内容提取 import/require 路径 */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        // 取第一个捕获组
        const imp = match[1] || match[2];
        if (imp) imports.push(imp.trim());
      }
    }
    return imports;
  }

  /** 解析 import 路径为绝对路径 */
  private resolveImport(imp: string, fromDir: string, cwd: string): string | null {
    // 跳过 npm 包（非相对路径）
    if (!imp.startsWith('.') && !imp.startsWith('/')) {
      return null;
    }

    const base = imp.startsWith('/')
      ? path.resolve(cwd, imp.substring(1))
      : path.resolve(fromDir, imp);

    // 尝试原始路径
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;

    // 尝试添加扩展名
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']) {
      if (fs.existsSync(base + ext)) return base + ext;
    }

    // 尝试 index 文件
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const indexFile = path.join(base, `index${ext}`);
      if (fs.existsSync(indexFile)) return indexFile;
    }

    return null;
  }

  /** 估算文件 token 数（粗略：字符数/4） */
  private estimateTokens(filePath: string): number {
    try {
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(absPath)) return 200;
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return 200;
      const size = stat.size;
      const tokens = Math.ceil(size / CHARS_PER_TOKEN);
      return Math.min(tokens, MAX_TOKENS_PER_FILE);
    } catch {
      return 200;
    }
  }

  /** 检查文件是否应该被忽略 */
  private shouldIgnore(relPath: string): boolean {
    const parts = relPath.split(path.sep);
    return parts.some(p => IGNORE_DIRS.has(p));
  }

  /** 规范化路径（统一使用 / 分隔符） */
  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  /** 清除缓存（用于测试） */
  invalidateCache(): void {
    this._gitDiffCache = null;
    this._gitDiffCacheTime = 0;
  }

  /**
   * v20.0 §3.2：暴露 context_discover 工具给 LLM
   *
   * 使用实例注入的 CodebaseIndexer（通过 setCodebaseIndexer 设置）
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'context_discover',
        description: '动态发现与当前任务相关的文件。从用户问题、当前打开文件、git diff 三个来源综合发现，token 预算下裁剪。返回相关文件列表及原因。',
        parameters: {
          query: {
            type: 'string',
            description: '用户问题或任务描述（用于语义搜索）',
            required: true,
          },
          openFile: {
            type: 'string',
            description: '当前打开的文件路径（可选，用于发现 import 相关文件）',
            required: false,
          },
          tokenBudget: {
            type: 'number',
            description: 'token 预算上限（默认 8000）',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args: { query?: string; openFile?: string; tokenBudget?: number }) => {
          const query = args?.query as string;
          if (!query) return '❌ 缺少 query 参数';

          const result = await this.discover(query, this._codebaseIndexer, {
            openFilePath: args?.openFile as string | undefined,
            tokenBudget: args?.tokenBudget as number | undefined,
          });

          const lines: string[] = [result.summary, ''];
          for (const f of result.files) {
            const tokens = f.estimatedTokens ? ` (~${f.estimatedTokens} tokens)` : '';
            lines.push(`  ${f.filePath}${tokens} — ${f.reason} [${f.source}, score: ${f.score.toFixed(2)}]`);
          }
          return lines.join('\n');
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: ContextDiscoverer | null = null;

export function getContextDiscoverer(): ContextDiscoverer {
  if (!_instance) {
    _instance = new ContextDiscoverer();
  }
  return _instance;
}
