/**
 * 文件即接口上下文引擎 — FileContextEngine
 *
 * 对标 Cursor IDE 的"文件即接口"哲学：
 * 1. 工具结果文件化：大结果（>4KB）写入临时文件，上下文只保留路径+摘要
 * 2. 历史记录文件引用：压缩时给"历史记录文件"引用，可 grep 搜索找回
 * 3. 终端输出文件化：终端输出同步为本地文件
 * 4. 上下文摘要生成：自动生成工具结果的摘要（前 500 字符 + tail 200 字符）
 *
 * 核心理念：从"推"上下文给模型，转向构建环境让模型自己"拉"取信息
 * 预期效果：节省 40%+ Token 消耗
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// ============ 类型定义 ============

/** 文件化的工具结果 */
export interface FiledToolResult {
  /** 原始工具名 */
  toolName: string;
  /** 原始结果内容 */
  rawContent: string;
  /** 文件化后的文件路径（绝对路径） */
  filePath: string;
  /** 摘要（前 500 字符 + tail 200 字符） */
  summary: string;
  /** 原始内容长度 */
  rawLength: number;
  /** 是否被文件化（小于阈值的不会被文件化） */
  filed: boolean;
  /** 时间戳 */
  timestamp: number;
}

/** 上下文摘要统计 */
export interface FileContextStats {
  /** 总工具结果数 */
  totalResults: number;
  /** 文件化数量 */
  filedCount: number;
  /** 原始内容总字节数 */
  totalRawBytes: number;
  /** 摘要总字节数（节省后的上下文大小） */
  totalSummaryBytes: number;
  /** 节省比例（0-1） */
  savingsRatio: number;
  /** 临时目录路径 */
  tmpDir: string;
}

/** 历史记录文件引用 */
export interface HistoryFileRef {
  /** 引用 ID */
  id: string;
  /** 文件路径 */
  filePath: string;
  /** 描述（用于 LLM 理解引用内容） */
  description: string;
  /** 创建时间 */
  createdAt: number;
  /** 内容大小（字节） */
  size: number;
}

// ============ 文件即接口上下文引擎 ============

export class FileContextEngine {
  /** 临时目录（存放文件化的工具结果） */
  private tmpDir: string;
  /** 文件化阈值（字节），超过此值的结果才文件化 */
  private threshold: number;
  /** 摘要头部长度 */
  private summaryHead: number;
  /** 摘要尾部长度 */
  private summaryTail: number;
  /** 已文件化的结果记录 */
  private filedResults: FiledToolResult[] = [];
  /** 历史记录文件引用 */
  private historyRefs: Map<string, HistoryFileRef> = new Map();
  /** 最大保留文件数 */
  private maxFiles: number;

  constructor(options?: {
    tmpDir?: string;
    threshold?: number;
    summaryHead?: number;
    summaryTail?: number;
    maxFiles?: number;
  }) {
    this.tmpDir = options?.tmpDir ?? path.join(os.tmpdir(), 'duan-file-context');
    this.threshold = options?.threshold ?? 4096; // 4KB
    this.summaryHead = options?.summaryHead ?? 500;
    this.summaryTail = options?.summaryTail ?? 200;
    this.maxFiles = options?.maxFiles ?? 100;
    this.ensureTmpDir();
  }

  /**
   * 处理工具结果，根据大小决定是否文件化
   * @param toolName 工具名
   * @param content  原始结果内容
   * @returns 文件化结果
   */
  processToolResult(toolName: string, content: string): FiledToolResult {
    const rawLength = content.length;
    const timestamp = Date.now();

    // 小结果不文件化，直接返回
    if (rawLength < this.threshold) {
      return {
        toolName,
        rawContent: content,
        filePath: '',
        summary: content,
        rawLength,
        filed: false,
        timestamp,
      };
    }

    // 大结果文件化
    const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    const fileName = `${toolName}-${timestamp}-${hash}.txt`;
    const filePath = path.join(this.tmpDir, fileName);

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch {
      // 写入失败则不文件化
      return {
        toolName,
        rawContent: content,
        filePath: '',
        summary: content,
        rawLength,
        filed: false,
        timestamp,
      };
    }

    // 生成摘要
    const summary = this.generateSummary(content);

    const result: FiledToolResult = {
      toolName,
      rawContent: content,
      filePath,
      summary,
      rawLength,
      filed: true,
      timestamp,
    };

    this.filedResults.push(result);
    this.enforceMaxFiles();

    return result;
  }

  /**
   * 生成内容摘要（前 N 字符 + 中间省略 + 后 N 字符）
   */
  generateSummary(content: string): string {
    const len = content.length;
    if (len <= this.summaryHead + this.summaryTail + 50) {
      return content;
    }

    const head = content.substring(0, this.summaryHead);
    const tail = content.substring(len - this.summaryTail);
    const omitted = len - this.summaryHead - this.summaryTail;

    return `${head}\n\n... [已省略 ${omitted} 字符，完整内容见文件] ...\n\n${tail}`;
  }

  /**
   * 生成给 LLM 的上下文表示
   * 文件化的结果只返回摘要 + 文件路径引用
   */
  toContextString(result: FiledToolResult): string {
    if (!result.filed) {
      return result.rawContent;
    }

    return [
      `<!-- 文件化工具结果 -->`,
      `<!-- 工具: ${result.toolName} | 原始大小: ${result.rawLength} 字节 | 文件: ${result.filePath} -->`,
      `<!-- 可使用 file_read 工具读取完整内容，或使用 grep_search 搜索文件 -->`,
      ``,
      result.summary,
    ].join('\n');
  }

  /**
   * 创建历史记录文件引用（上下文压缩时使用）
   * @param content  要保存的历史内容
   * @param description 描述
   * @returns 引用 ID
   */
  createHistoryRef(content: string, description: string): string {
    const id = `hist-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const filePath = path.join(this.tmpDir, `${id}.txt`);

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      const stat = fs.statSync(filePath);

      const ref: HistoryFileRef = {
        id,
        filePath,
        description,
        createdAt: Date.now(),
        size: stat.size,
      };

      this.historyRefs.set(id, ref);
      return id;
    } catch {
      return '';
    }
  }

  /**
   * 获取历史记录文件引用
   */
  getHistoryRef(id: string): HistoryFileRef | undefined {
    return this.historyRefs.get(id);
  }

  /**
   * 列出所有历史记录文件引用
   */
  listHistoryRefs(): HistoryFileRef[] {
    return [...this.historyRefs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 搜索历史记录文件（grep）
   * @param pattern 搜索模式（字符串或正则）
   * @returns 匹配的文件路径列表
   */
  searchHistoryFiles(pattern: string): string[] {
    const matchingFiles: string[] = [];
    try {
      const files = fs.readdirSync(this.tmpDir);
      for (const file of files) {
        if (!file.endsWith('.txt')) continue;
        const filePath = path.join(this.tmpDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.includes(pattern)) {
            matchingFiles.push(filePath);
          }
        } catch {
          // 读取失败跳过
        }
      }
    } catch {
      // 目录读取失败
    }
    return matchingFiles;
  }

  /**
   * 文件化终端输出
   * @param output  终端输出
   * @param command 原始命令
   * @returns 文件路径
   */
  fileTerminalOutput(output: string, command: string): string {
    const hash = crypto.createHash('sha256').update(output).digest('hex').substring(0, 16);
    const fileName = `terminal-${Date.now()}-${hash}.txt`;
    const filePath = path.join(this.tmpDir, fileName);

    try {
      const header = `# 终端输出文件化\n# 命令: ${command}\n# 时间: ${new Date().toISOString()}\n# 大小: ${output.length} 字节\n\n`;
      fs.writeFileSync(filePath, header + output, 'utf-8');
      return filePath;
    } catch {
      return '';
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): FileContextStats {
    const totalResults = this.filedResults.length;
    const filedCount = this.filedResults.filter((r) => r.filed).length;
    const totalRawBytes = this.filedResults.reduce((sum, r) => sum + r.rawLength, 0);
    const totalSummaryBytes = this.filedResults.reduce((sum, r) => sum + r.summary.length, 0);
    const savingsRatio = totalRawBytes > 0 ? 1 - totalSummaryBytes / totalRawBytes : 0;

    return {
      totalResults,
      filedCount,
      totalRawBytes,
      totalSummaryBytes,
      savingsRatio,
      tmpDir: this.tmpDir,
    };
  }

  /**
   * 清理过期的临时文件
   * @param maxAgeMs 最大年龄（毫秒），默认 1 小时
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleaned = 0;

    try {
      const files = fs.readdirSync(this.tmpDir);
      for (const file of files) {
        const filePath = path.join(this.tmpDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch {
          // 跳过
        }
      }
    } catch {
      // 目录读取失败
    }

    // 清理过期的历史引用记录
    for (const [id, ref] of this.historyRefs) {
      if (now - ref.createdAt > maxAgeMs) {
        this.historyRefs.delete(id);
      }
    }

    return cleaned;
  }

  /**
   * 清空所有临时文件
   */
  clear(): void {
    try {
      const files = fs.readdirSync(this.tmpDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.tmpDir, file));
        } catch {
          // 跳过
        }
      }
    } catch {
      // 目录读取失败
    }
    this.filedResults = [];
    this.historyRefs.clear();
  }

  /** 确保临时目录存在 */
  private ensureTmpDir(): void {
    try {
      if (!fs.existsSync(this.tmpDir)) {
        fs.mkdirSync(this.tmpDir, { recursive: true });
      }
    } catch {
      // 创建失败时使用系统临时目录
      this.tmpDir = os.tmpdir();
    }
  }

  /** 强制最大文件数限制 */
  private enforceMaxFiles(): void {
    while (this.filedResults.length > this.maxFiles) {
      const oldest = this.filedResults.shift();
      if (oldest?.filePath) {
        try {
          fs.unlinkSync(oldest.filePath);
        } catch {
          // 跳过
        }
      }
    }
  }
}

// ============ LLM 工具定义 ============

/** 文件上下文引擎 LLM 工具定义 */
export function getFileContextToolDefinitions() {
  return [
    {
      name: 'file_context_stats',
      description: '获取文件上下文引擎的统计信息（文件化数量、节省比例等）',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'file_context_search',
      description: '搜索文件化的工具结果和历史记录文件（grep 模式）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: '搜索模式（字符串）' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'file_context_history_list',
      description: '列出所有历史记录文件引用',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'file_context_cleanup',
      description: '清理过期的临时文件',
      inputSchema: {
        type: 'object' as const,
        properties: {
          maxAgeHours: {
            type: 'number',
            description: '最大年龄（小时），超过此年龄的文件将被清理（默认 1）',
          },
        },
      },
    },
  ];
}

/** 文件上下文引擎工具处理器 */
export function createFileContextToolHandler(engine: FileContextEngine) {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'file_context_stats':
        return engine.getStats();
      case 'file_context_search': {
        const pattern = args.pattern as string;
        const files = engine.searchHistoryFiles(pattern);
        return { pattern, matchedFiles: files, count: files.length };
      }
      case 'file_context_history_list':
        return engine.listHistoryRefs();
      case 'file_context_cleanup': {
        const maxAgeHours = (args.maxAgeHours as number) ?? 1;
        const cleaned = engine.cleanup(maxAgeHours * 3600000);
        return { cleaned, maxAgeHours };
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
