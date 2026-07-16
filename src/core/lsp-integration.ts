/**
 * 深度 LSP 集成模块 — LSPIntegration
 *
 * 为"段先生"自主 AI Agent 系统提供语言服务器协议（LSP）深度集成：
 * - 实时诊断：获取文件级别的错误、警告、提示
 * - 符号导航：文档符号、引用查找、定义跳转
 * - 智能补全：上下文感知的代码补全
 * - 悬停信息：类型信息和文档
 * - 支持 TypeScript、Python、Go、Rust 等语言
 * - JSON-RPC 2.0 协议通过 stdio 传输
 * - 自动重启崩溃的语言服务器
 * - 通过 EventBus 广播 LSP 生命周期事件
 * - 通过 getToolDefinitions() 注册为 Agent Loop 可用工具
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** LSP 服务器状态 */
export type LSPServerStatus = 'starting' | 'ready' | 'error' | 'stopped';

/** LSP 服务器实例 */
export interface LSPServer {
  /** 语言标识 */
  language: string;
  /** 子进程实例 */
  process: ChildProcess | null;
  /** 当前状态 */
  status: LSPServerStatus;
  /** 项目根目录 */
  projectRoot: string;
  /** 请求 ID 计数器 */
  requestId: number;
  /** 等待响应的请求映射 */
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>;
  /** 接收缓冲区 */
  buffer: string;
  /** 当前消息内容长度 */
  contentLength: number;
  /** 初始化能力 */
  capabilities: Record<string, unknown>;
  /** 上次活动时间 */
  lastActivity: number;
  /** 重启次数 */
  restartCount: number;
  /** 自动重启定时器 */
  restartTimer: ReturnType<typeof setTimeout> | null;
}

/** 诊断项 */
export interface DiagnosticItem {
  /** 严重程度 */
  severity: 'error' | 'warning' | 'information' | 'hint';
  /** 起始行号（0-based） */
  line: number;
  /** 起始列号（0-based） */
  character: number;
  /** 结束行号 */
  endLine: number;
  /** 结束列号 */
  endCharacter: number;
  /** 诊断消息 */
  message: string;
  /** 来源（如 tsserver, pylsp 等） */
  source?: string;
  /** 诊断代码 */
  code?: string;
}

/** 诊断结果 */
export interface DiagnosticResult {
  /** 文件路径 */
  filePath: string;
  /** 诊断项列表 */
  diagnostics: DiagnosticItem[];
  /** 错误数 */
  errorCount: number;
  /** 警告数 */
  warningCount: number;
}

/** 符号项 */
export interface SymbolItem {
  /** 符号名称 */
  name: string;
  /** 符号种类 */
  kind: 'function' | 'class' | 'variable' | 'interface' | 'method' | 'property' | 'enum' | 'namespace' | 'module' | 'constructor' | 'constant' | 'type' | 'field' | 'file';
  /** 行范围 */
  range: { startLine: number; endLine: number };
  /** 子符号 */
  children?: SymbolItem[];
}

/** 位置信息 */
export interface Location {
  /** 文件路径 */
  filePath: string;
  /** 行号（0-based） */
  line: number;
  /** 列号（0-based） */
  character: number;
  /** 结束行号 */
  endLine?: number;
  /** 结束列号 */
  endCharacter?: number;
}

/** 悬停信息 */
export interface HoverResult {
  /** 类型/签名信息 */
  typeInfo: string;
  /** 文档内容 */
  documentation?: string;
}

/** 补全项 */
export interface CompletionItem {
  /** 补全标签 */
  label: string;
  /** 补全种类 */
  kind: string;
  /** 详细信息 */
  detail?: string;
  /** 文档 */
  documentation?: string;
}


// ============ 语言服务器配置 ============

interface LanguageServerConfig {
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 文件扩展名映射 */
  extensions: string[];
  /** 语言 ID */
  languageId: string;
}

/** 支持的语言服务器配置 */
const LANGUAGE_SERVERS: Record<string, LanguageServerConfig> = {
  typescript: {
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    languageId: 'typescript',
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi', '.pyw'],
    languageId: 'python',
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    extensions: ['.go'],
    languageId: 'go',
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    languageId: 'rust',
  },
};

/** LSP SymbolKind 到字符串的映射 */
const SYMBOL_KIND_MAP: Record<number, SymbolItem['kind']> = {
  1: 'file',
  2: 'namespace',
  3: 'namespace',
  4: 'namespace',
  5: 'method',
  6: 'method',
  7: 'constructor',
  8: 'field',
  9: 'namespace',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'class',
  15: 'class',
  16: 'constant',
  17: 'constant',
  18: 'namespace',
  19: 'method',
  20: 'method',
  21: 'namespace',
  22: 'type',
  23: 'type',
  24: 'namespace',
  25: 'constant',
  26: 'module',
};

/** 严重程度映射（LSP DiagnosticSeverity → 字符串） */
const SEVERITY_MAP: Record<number, DiagnosticItem['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
};

/** 默认请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30000;

/** 最大重启次数 */
const MAX_RESTART_COUNT = 3;

/** 重启延迟（毫秒） */
const RESTART_DELAY_MS = 3000;

// ============ 主类 ============

export class LSPIntegration {
  /** 已启动的语言服务器映射 */
  private servers: Map<string, LSPServer> = new Map();

  /** 诊断缓存（文件路径 → 诊断结果） */
  private diagnosticsCache: Map<string, DiagnosticResult> = new Map();

  /** 日志记录器 */
  private log = logger.child({ module: 'LSPIntegration' });

  /** 事件总线 */
  private eventBus = EventBus.getInstance();

  /** 统计信息 */
  private stats = {
    serversStarted: 0,
    serversStopped: 0,
    serversRestarted: 0,
    diagnosticsRequested: 0,
    symbolsRequested: 0,
    referencesRequested: 0,
    definitionsRequested: 0,
    hoversRequested: 0,
    completionsRequested: 0,
    requestsFailed: 0,
  };

  constructor() {}

  /**
   * 异步检查路径是否存在
   * @param filePath 文件路径
   * @returns 是否存在
   */
  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ============ 服务器管理 ============

  /**
   * 启动语言服务器
   * @param language 语言标识（typescript/python/go/rust）
   * @param projectRoot 项目根目录
   * @returns 服务器状态描述
   */
  async startServer(language: string, projectRoot: string): Promise<string> {
    const normalizedLang = language.toLowerCase();
    const config = LANGUAGE_SERVERS[normalizedLang];

    if (!config) {
      return `❌ 不支持的语言: ${language}。支持的语言: ${Object.keys(LANGUAGE_SERVERS).join(', ')}`;
    }

    // 如果已有同语言服务器在运行，先停止
    const existing = this.servers.get(normalizedLang);
    if (existing && existing.status !== 'stopped') {
      await this.stopServer(normalizedLang);
    }

    // 解析项目根目录为绝对路径
    const absRoot = path.resolve(projectRoot);
    if (!(await this.pathExists(absRoot))) {
      return `❌ 项目根目录不存在: ${absRoot}`;
    }

    this.log.info('正在启动语言服务器', { language: normalizedLang, projectRoot: absRoot });

    const server: LSPServer = {
      language: normalizedLang,
      process: null,
      status: 'starting',
      projectRoot: absRoot,
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
      contentLength: -1,
      capabilities: {},
      lastActivity: Date.now(),
      restartCount: 0,
      restartTimer: null,
    };

    this.servers.set(normalizedLang, server);

    try {
      // 启动子进程
      const childProcess = spawn(config.command, config.args, {
        cwd: absRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      server.process = childProcess;

      // 处理进程错误
      childProcess.on('error', (err) => {
        this.log.error('语言服务器进程错误', { language: normalizedLang, error: err.message });
        server.status = 'error';
        this.clearPendingRequests(server, `语言服务器进程错误: ${err.message}`);
        this.eventBus.emitSync('lsp.server.error', {
          language: normalizedLang,
          error: err.message,
        }, { source: 'LSPIntegration' });
      });

      // 处理进程退出
      childProcess.on('exit', (code, signal) => {
        this.log.warn('语言服务器进程退出', { language: normalizedLang, code, signal });
        if (server.status !== 'stopped') {
          server.status = 'error';
          this.clearPendingRequests(server, `语言服务器进程退出 (code=${code}, signal=${signal})`);
          this.attemptRestart(normalizedLang);
        }
      });

      // 处理 stderr 输出
      childProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          this.log.debug('语言服务器 stderr', { language: normalizedLang, output: msg.substring(0, 500) });
        }
      });

      // 处理 stdout 输出（LSP 消息）
      childProcess.stdout?.on('data', (data: Buffer) => {
        this.handleServerData(server, data);
      });

      // 发送 initialize 请求
      const initResult = (await this.sendRequest(server, 'initialize', {
        processId: process.pid,
        rootUri: this.pathToUri(absRoot),
        rootPath: absRoot,
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            completion: { completionItem: { snippetSupport: false } },
            hover: { contentFormat: ['plaintext', 'markdown'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: {
            workspaceFolders: true,
          },
        },
        workspaceFolders: [{ uri: this.pathToUri(absRoot), name: path.basename(absRoot) }],
      })) as { capabilities?: Record<string, unknown> };

      // 发送 initialized 通知
      this.sendNotification(server, 'initialized', {});

      // 保存服务器能力
      // 修复：sendRequest 返回 unknown，断言为含 capabilities 的结构
      server.capabilities = (initResult as { capabilities?: Record<string, unknown> })?.capabilities || {};
      server.status = 'ready';
      this.stats.serversStarted++;

      this.log.info('语言服务器已就绪', { language: normalizedLang, projectRoot: absRoot });

      this.eventBus.emitSync('lsp.server.ready', {
        language: normalizedLang,
        projectRoot: absRoot,
      }, { source: 'LSPIntegration' });

      return `✅ ${normalizedLang} 语言服务器已启动\n` +
        `  项目根目录: ${absRoot}\n` +
        `  服务器能力: ${Object.keys(server.capabilities).join(', ') || '基础'}`;

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      server.status = 'error';
      this.log.error('启动语言服务器失败', { language: normalizedLang, error: message });

      this.eventBus.emitSync('lsp.server.error', {
        language: normalizedLang,
        error: message,
      }, { source: 'LSPIntegration' });

      return `❌ 启动 ${normalizedLang} 语言服务器失败: ${message}`;
    }
  }

  /**
   * 停止语言服务器
   * @param language 语言标识
   * @returns 操作结果
   */
  async stopServer(language: string): Promise<string> {
    const normalizedLang = language.toLowerCase();
    const server = this.servers.get(normalizedLang);

    if (!server) {
      return `⚠️ 未找到 ${normalizedLang} 语言服务器`;
    }

    if (server.status === 'stopped') {
      return `⚠️ ${normalizedLang} 语言服务器已停止`;
    }

    this.log.info('正在停止语言服务器', { language: normalizedLang });

    // 取消重启定时器
    if (server.restartTimer) {
      clearTimeout(server.restartTimer);
      server.restartTimer = null;
    }

    try {
      // 发送 shutdown 请求
      if (server.process && server.status === 'ready') {
        try {
          await this.sendRequest(server, 'shutdown', undefined, 5000);
        } catch {
          // shutdown 请求可能超时，继续执行 exit
        }
        // 发送 exit 通知
        this.sendNotification(server, 'exit', {});
      }
    } catch {
      // 忽略退出时的错误
    }

    // 强制杀死进程
    if (server.process && !server.process.killed) {
      try {
        server.process.kill('SIGTERM');
        // 给进程 2 秒时间优雅退出
        setTimeout(() => {
          if (server.process && !server.process.killed) {
            server.process.kill('SIGKILL');
          }
        }, 2000);
      } catch {
        // 进程可能已退出
      }
    }

    // 清理待处理请求
    this.clearPendingRequests(server, '语言服务器已停止');

    server.status = 'stopped';
    server.process = null;
    this.stats.serversStopped++;

    this.log.info('语言服务器已停止', { language: normalizedLang });

    this.eventBus.emitSync('lsp.server.stopped', {
      language: normalizedLang,
    }, { source: 'LSPIntegration' });

    return `✅ ${normalizedLang} 语言服务器已停止`;
  }

  // ============ 文档同步 ============

  /**
   * 通知服务器打开文件
   */
  private didOpen(server: LSPServer, filePath: string): void {
    const absPath = path.resolve(filePath);
    let text = '';
    try {
      text = fs.readFileSync(absPath, 'utf-8');
    } catch {
      this.log.warn('无法读取文件内容', { filePath: absPath });
      return;
    }

    const languageId = LANGUAGE_SERVERS[server.language]?.languageId || server.language;

    this.sendNotification(server, 'textDocument/didOpen', {
      textDocument: {
        uri: this.pathToUri(absPath),
        languageId,
        version: 1,
        text,
      },
    });
  }

  /**
   * 通知服务器文件变更
   */
  private didChange(server: LSPServer, filePath: string): void {
    const absPath = path.resolve(filePath);
    let text = '';
    try {
      text = fs.readFileSync(absPath, 'utf-8');
    } catch {
      this.log.warn('无法读取文件内容', { filePath: absPath });
      return;
    }

    this.sendNotification(server, 'textDocument/didChange', {
      textDocument: {
        uri: this.pathToUri(absPath),
        version: Date.now(),
      },
      contentChanges: [{ text }],
    });
  }

  // ============ LSP 功能方法 ============

  /**
   * 获取文件诊断信息
   * @param filePath 文件路径
   * @returns 诊断结果
   */
  async getDiagnostics(filePath: string): Promise<DiagnosticResult> {
    const absPath = path.resolve(filePath);
    const language = this.detectLanguage(absPath);
    const server = this.getServerForFile(absPath);

    const emptyResult: DiagnosticResult = {
      filePath: absPath,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
    };

    if (!server || server.status !== 'ready') {
      this.log.warn('无可用的语言服务器获取诊断', { filePath: absPath, language });
      return emptyResult;
    }

    this.stats.diagnosticsRequested++;

    try {
      // 通知服务器打开/变更文件
      this.didOpen(server, absPath);

      // 等待诊断推送（LSP 通过 textDocument/publishDiagnostics 推送）
      // 使用短暂延迟等待服务器处理
      await this.delay(500);

      // 尝试通过 pullDiagnostics（部分服务器支持）
      let diagnostics: DiagnosticItem[] = [];
      try {
        const result = (await this.sendRequest(server, 'textDocument/diagnostic', {
          textDocument: { uri: this.pathToUri(absPath) },
        }, 5000)) as { items?: unknown[] };

        if (result?.items) {
          diagnostics = result.items.map((d: unknown) => this.mapDiagnostic(d));
        }
      } catch {
        // 不支持 pullDiagnostics，使用缓存
        const cached = this.diagnosticsCache.get(absPath);
        if (cached) {
          return cached;
        }
      }

      // 如果没有通过 pull 获取到，检查缓存
      if (diagnostics.length === 0) {
        const cached = this.diagnosticsCache.get(absPath);
        if (cached) {
          return cached;
        }
      }

      const result: DiagnosticResult = {
        filePath: absPath,
        diagnostics,
        errorCount: diagnostics.filter(d => d.severity === 'error').length,
        warningCount: diagnostics.filter(d => d.severity === 'warning').length,
      };

      // 更新缓存
      this.diagnosticsCache.set(absPath, result);

      this.eventBus.emitSync('lsp.diagnostics.received', {
        filePath: absPath,
        errorCount: result.errorCount,
        warningCount: result.warningCount,
      }, { source: 'LSPIntegration' });

      return result;

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('获取诊断失败', { filePath: absPath, error: msg });
      this.stats.requestsFailed++;
      return emptyResult;
    }
  }

  /**
   * 获取文档符号
   * @param filePath 文件路径
   * @returns 符号列表
   */
  async getSymbols(filePath: string): Promise<SymbolItem[]> {
    const absPath = path.resolve(filePath);
    const server = this.getServerForFile(absPath);

    if (!server || server.status !== 'ready') {
      this.log.warn('无可用的语言服务器获取符号', { filePath: absPath });
      return [];
    }

    this.stats.symbolsRequested++;

    try {
      this.didOpen(server, absPath);

      const result = await this.sendRequest(server, 'textDocument/documentSymbol', {
        textDocument: { uri: this.pathToUri(absPath) },
      });

      if (!result) return [];

      const symbols = Array.isArray(result) ? result : [];
      return symbols.map((s: unknown) => this.mapSymbol(s));

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('获取文档符号失败', { filePath: absPath, error: msg });
      this.stats.requestsFailed++;
      return [];
    }
  }

  /**
   * 查找符号引用
   * @param filePath 文件路径
   * @param line 行号（0-based）
   * @param character 列号（0-based）
   * @returns 引用位置列表
   */
  async findReferences(filePath: string, line: number, character: number): Promise<Location[]> {
    const absPath = path.resolve(filePath);
    const server = this.getServerForFile(absPath);

    if (!server || server.status !== 'ready') {
      this.log.warn('无可用的语言服务器查找引用', { filePath: absPath });
      return [];
    }

    this.stats.referencesRequested++;

    try {
      this.didOpen(server, absPath);

      const result = await this.sendRequest(server, 'textDocument/references', {
        textDocument: { uri: this.pathToUri(absPath) },
        position: { line, character },
        context: { includeDeclaration: true },
      });

      if (!result || !Array.isArray(result)) return [];

      return result.map((loc: unknown) => this.mapLocation(loc));

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('查找引用失败', { filePath: absPath, line, character, error: msg });
      this.stats.requestsFailed++;
      return [];
    }
  }

  /**
   * 跳转到定义
   * @param filePath 文件路径
   * @param line 行号（0-based）
   * @param character 列号（0-based）
   * @returns 定义位置
   */
  async gotoDefinition(filePath: string, line: number, character: number): Promise<Location | null> {
    const absPath = path.resolve(filePath);
    const server = this.getServerForFile(absPath);

    if (!server || server.status !== 'ready') {
      this.log.warn('无可用的语言服务器查找定义', { filePath: absPath });
      return null;
    }

    this.stats.definitionsRequested++;

    try {
      this.didOpen(server, absPath);

      const result = await this.sendRequest(server, 'textDocument/definition', {
        textDocument: { uri: this.pathToUri(absPath) },
        position: { line, character },
      });

      if (!result) return null;

      // definition 可能返回单个 Location 或 LocationLink[]
      if (Array.isArray(result)) {
        if (result.length === 0) return null;
        const first = result[0];
        // LocationLink 格式
        if (first.targetUri) {
          return {
            filePath: this.uriToPath(first.targetUri),
            line: first.targetRange?.start?.line ?? 0,
            character: first.targetRange?.start?.character ?? 0,
            endLine: first.targetRange?.end?.line,
            endCharacter: first.targetRange?.end?.character,
          };
        }
        // Location 格式
        return this.mapLocation(first);
      }

      // 单个 Location
      if ((result as { uri?: unknown }).uri) {
        return this.mapLocation(result);
      }

      return null;

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('查找定义失败', { filePath: absPath, line, character, error: msg });
      this.stats.requestsFailed++;
      return null;
    }
  }

  /**
   * 获取悬停信息
   * @param filePath 文件路径
   * @param line 行号（0-based）
   * @param character 列号（0-based）
   * @returns 悬停结果
   */
  async getHover(filePath: string, line: number, character: number): Promise<HoverResult | null> {
    const absPath = path.resolve(filePath);
    const server = this.getServerForFile(absPath);

    if (!server || server.status !== 'ready') {
      this.log.warn('无可用的语言服务器获取悬停信息', { filePath: absPath });
      return null;
    }

    this.stats.hoversRequested++;

    try {
      this.didOpen(server, absPath);

      const result = (await this.sendRequest(server, 'textDocument/hover', {
        textDocument: { uri: this.pathToUri(absPath) },
        position: { line, character },
      })) as { contents?: string | unknown[] | { value?: string } };

      if (!result || !result.contents) return null;

      let typeInfo = '';
      let documentation: string | undefined;

      if (typeof result.contents === 'string') {
        typeInfo = result.contents;
      } else if (Array.isArray(result.contents)) {
        // MarkupContent[]
        typeInfo = result.contents
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => (typeof c === 'string' ? c : c.value || ''))
          .filter(Boolean)
          .join('\n');
      } else if (result.contents.value) {
        // MarkupContent
        typeInfo = result.contents.value;
      }

      // 尝试分离类型信息和文档
      const lines = typeInfo.split('\n');
      if (lines.length > 3) {
        typeInfo = lines.slice(0, 3).join('\n');
        documentation = lines.slice(3).join('\n').trim() || undefined;
      }

      return { typeInfo, documentation };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('获取悬停信息失败', { filePath: absPath, line, character, error: msg });
      this.stats.requestsFailed++;
      return null;
    }
  }

  /**
   * 获取补全建议
   * @param filePath 文件路径
   * @param line 行号（0-based）
   * @param character 列号（0-based）
   * @returns 补全项列表
   */
  async getCompletions(filePath: string, line: number, character: number): Promise<CompletionItem[]> {
    const absPath = path.resolve(filePath);
    const server = this.getServerForFile(absPath);

    if (!server || server.status !== 'ready') {
      this.log.warn('无可用的语言服务器获取补全', { filePath: absPath });
      return [];
    }

    this.stats.completionsRequested++;

    try {
      this.didOpen(server, absPath);

      const result = (await this.sendRequest(server, 'textDocument/completion', {
        textDocument: { uri: this.pathToUri(absPath) },
        position: { line, character },
      })) as { items?: unknown[] };

      if (!result) return [];

      // CompletionList 或 CompletionItem[]
      const items = result.items || (Array.isArray(result) ? result : []);
      return items.slice(0, 50).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item: any) => ({
          label: item.label || '',
          kind: this.completionKindToString(item.kind),
          detail: item.detail || undefined,
          documentation: typeof item.documentation === 'string'
            ? item.documentation
            : item.documentation?.value || undefined,
        }),
      );

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('获取补全失败', { filePath: absPath, line, character, error: msg });
      this.stats.requestsFailed++;
      return [];
    }
  }

  // ============ JSON-RPC 2.0 协议实现 ============

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private sendRequest(server: LSPServer, method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!server.process || server.process.killed) {
        reject(new Error('语言服务器进程不可用'));
        return;
      }

      const id = ++server.requestId;
      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      };

      const timer = setTimeout(() => {
        server.pendingRequests.delete(id);
        reject(new Error(`请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      server.pendingRequests.set(id, { resolve, reject, timer });

      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

      try {
        server.process.stdin?.write(header + content);
      } catch (err: unknown) {
        server.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error(`写入请求失败: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /**
   * 发送 JSON-RPC 通知（不期望响应）
   */
  private sendNotification(server: LSPServer, method: string, params: unknown): void {
    if (!server.process || server.process.killed) {
      return;
    }

    const message = {
      jsonrpc: '2.0',
      method,
      params: params ?? {},
    };

    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

    try {
      server.process.stdin?.write(header + content);
    } catch (err: unknown) {
      this.log.error('发送通知失败', { method, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 处理服务器输出数据
   */
  private handleServerData(server: LSPServer, data: Buffer): void {
    server.buffer += data.toString();
    server.lastActivity = Date.now();

    // 循环解析完整的消息
    while (server.buffer.length > 0) {
      // 查找 Content-Length 头
      if (server.contentLength < 0) {
        const headerEnd = server.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break; // 头部不完整，等待更多数据

        const header = server.buffer.substring(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // 无效头部，丢弃
          server.buffer = server.buffer.substring(headerEnd + 4);
          continue;
        }

        server.contentLength = parseInt(match[1], 10);
        server.buffer = server.buffer.substring(headerEnd + 4);
      }

      // 检查消息体是否完整
      if (server.contentLength >= 0 && server.buffer.length >= server.contentLength) {
        const body = server.buffer.substring(0, server.contentLength);
        server.buffer = server.buffer.substring(server.contentLength);
        server.contentLength = -1;

        try {
          const message = JSON.parse(body);
          this.handleMessage(server, message);
        } catch (err: unknown) {
          this.log.error('解析 LSP 消息失败', { error: err instanceof Error ? err.message : String(err), body: body.substring(0, 200) });
        }
      } else {
        break; // 消息体不完整，等待更多数据
      }
    }
  }

  /**
   * 处理已解析的 LSP 消息
   */
  private handleMessage(server: LSPServer, message: unknown): void {
    const msg = message as Record<string, unknown>;
    // 响应消息
    if (msg.id !== undefined && msg.id !== null) {
      const pending = server.pendingRequests.get(msg.id as number);
      if (pending) {
        server.pendingRequests.delete(msg.id as number);
        clearTimeout(pending.timer);

        if (msg.error) {
          const errObj = msg.error as { message?: string };
          pending.reject(new Error(errObj.message || `LSP 错误: ${JSON.stringify(msg.error)}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 通知消息
    if (msg.method) {
      const method = msg.method as string;
      const params = msg.params as Record<string, unknown> | undefined;
      switch (method) {
        case 'textDocument/publishDiagnostics':
          this.handleDiagnostics(server, params);
          break;
        case 'window/logMessage':
          this.log.debug('语言服务器日志', {
            language: server.language,
            type: params?.type,
            message: (params?.message as string)?.substring(0, 300),
          });
          break;
        case 'window/showMessage':
          this.log.info('语言服务器消息', {
            language: server.language,
            type: params?.type,
            message: (params?.message as string)?.substring(0, 300),
          });
          break;
        default:
          this.log.debug('收到 LSP 通知', { method });
      }
    }
  }

  /**
   * 处理推送的诊断信息
   */
  private handleDiagnostics(server: LSPServer, params: unknown): void {
    const p = params as Record<string, unknown> | undefined;
    if (!p?.uri) return;

    const filePath = this.uriToPath(p.uri as string);
    const diagnostics: DiagnosticItem[] = (p.diagnostics as unknown[] || []).map((d) => this.mapDiagnostic(d));

    const result: DiagnosticResult = {
      filePath,
      diagnostics,
      errorCount: diagnostics.filter(d => d.severity === 'error').length,
      warningCount: diagnostics.filter(d => d.severity === 'warning').length,
    };

    this.diagnosticsCache.set(filePath, result);

    this.eventBus.emitSync('lsp.diagnostics.received', {
      filePath,
      language: server.language,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      totalDiagnostics: diagnostics.length,
    }, { source: 'LSPIntegration' });
  }

  // ============ 辅助方法 ============

  /**
   * 根据文件扩展名检测语言
   */
  private detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    for (const [lang, config] of Object.entries(LANGUAGE_SERVERS)) {
      if (config.extensions.includes(ext)) {
        return lang;
      }
    }
    return null;
  }

  /**
   * 根据文件路径获取对应的语言服务器
   */
  private getServerForFile(filePath: string): LSPServer | null {
    const language = this.detectLanguage(filePath);
    if (!language) return null;
    return this.servers.get(language) || null;
  }

  /**
   * 文件路径转 URI
   */
  private pathToUri(filePath: string): string {
    // 统一使用正斜杠
    const normalized = filePath.replace(/\\/g, '/');
    // Windows 路径需要额外前缀
    if (normalized.startsWith('/')) {
      return `file://${normalized}`;
    }
    return `file:///${normalized}`;
  }

  /**
   * URI 转文件路径
   */
  private uriToPath(uri: string): string {
    let filePath = uri;
    if (filePath.startsWith('file:///')) {
      filePath = filePath.substring('file:///'.length);
    } else if (filePath.startsWith('file://')) {
      filePath = filePath.substring('file://'.length);
    }
    // URL 解码
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      // 解码失败则使用原始值
    }
    // Windows 路径还原
    return filePath.replace(/\//g, path.sep);
  }

  /**
   * 映射 LSP Diagnostic 到 DiagnosticItem
   */
  private mapDiagnostic(d: unknown): DiagnosticItem {
    const r = d as Record<string, unknown>;
    const range = r.range as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined;
    return {
      severity: SEVERITY_MAP[r.severity as number] || 'information',
      line: range?.start?.line ?? 0,
      character: range?.start?.character ?? 0,
      endLine: range?.end?.line ?? 0,
      endCharacter: range?.end?.character ?? 0,
      message: r.message as string || '',
      source: r.source as string || undefined,
      code: r.code != null ? String(r.code) : undefined,
    };
  }

  /**
   * 映射 LSP DocumentSymbol 到 SymbolItem
   */
  private mapSymbol(s: unknown): SymbolItem {
    const r = s as Record<string, unknown>;
    const range = r.range as { start?: { line?: number }; end?: { line?: number } } | undefined;
    const location = r.location as { range?: { start?: { line?: number }; end?: { line?: number } } } | undefined;
    const item: SymbolItem = {
      name: r.name as string || '',
      kind: SYMBOL_KIND_MAP[r.kind as number] || 'variable',
      range: {
        startLine: range?.start?.line ?? location?.range?.start?.line ?? 0,
        endLine: range?.end?.line ?? location?.range?.end?.line ?? 0,
      },
    };

    if (r.children && Array.isArray(r.children) && r.children.length > 0) {
      item.children = (r.children as unknown[]).map((c) => this.mapSymbol(c));
    }

    return item;
  }

  /**
   * 映射 LSP Location 到 Location
   */
  private mapLocation(loc: unknown): Location {
    const r = loc as Record<string, unknown>;
    const range = r.range as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined;
    return {
      filePath: this.uriToPath(r.uri as string || ''),
      line: range?.start?.line ?? 0,
      character: range?.start?.character ?? 0,
      endLine: range?.end?.line,
      endCharacter: range?.end?.character,
    };
  }

  /**
   * 补全项种类转字符串
   */
  private completionKindToString(kind: number | undefined): string {
    if (!kind) return 'unknown';
    const kinds: Record<number, string> = {
      1: 'text', 2: 'method', 3: 'function', 4: 'constructor', 5: 'field',
      6: 'variable', 7: 'class', 8: 'interface', 9: 'module', 10: 'property',
      11: 'unit', 12: 'value', 13: 'enum', 14: 'keyword', 15: 'snippet',
      16: 'color', 17: 'file', 18: 'reference', 19: 'folder', 20: 'enumMember',
      21: 'constant', 22: 'struct', 23: 'event', 24: 'operator', 25: 'typeParameter',
    };
    return kinds[kind] || 'unknown';
  }

  /**
   * 清理服务器上所有待处理请求
   */
  private clearPendingRequests(server: LSPServer, reason: string): void {
    for (const [_id, pending] of server.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    server.pendingRequests.clear();
  }

  /**
   * 尝试自动重启崩溃的服务器
   */
  private attemptRestart(language: string): void {
    const server = this.servers.get(language);
    if (!server) return;

    if (server.restartCount >= MAX_RESTART_COUNT) {
      this.log.error('语言服务器重启次数已达上限', { language, restartCount: server.restartCount });
      this.eventBus.emitSync('lsp.server.error', {
        language,
        error: `重启次数已达上限 (${MAX_RESTART_COUNT})`,
      }, { source: 'LSPIntegration' });
      return;
    }

    server.restartCount++;
    this.log.info('计划重启语言服务器', { language, attempt: server.restartCount });

    server.restartTimer = setTimeout(() => {
      void (async () => {
        this.log.info('正在重启语言服务器', { language, attempt: server.restartCount });
        this.stats.serversRestarted++;
        await this.startServer(language, server.projectRoot);
      })();
    }, RESTART_DELAY_MS);
    if (typeof server.restartTimer.unref === 'function') server.restartTimer.unref();
  }

  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============ 统计信息 ============

  /**
   * 获取 LSP 集成统计信息
   */
  getStats(): string {
    const serverStatuses = [...this.servers.entries()].map(
      ([lang, srv]) => `  ${lang}: ${srv.status} (重启: ${srv.restartCount})`
    ).join('\n');

    return [
      `📊 LSP 集成统计:`,
      `  服务器启动: ${this.stats.serversStarted}`,
      `  服务器停止: ${this.stats.serversStopped}`,
      `  服务器重启: ${this.stats.serversRestarted}`,
      `  诊断请求: ${this.stats.diagnosticsRequested}`,
      `  符号请求: ${this.stats.symbolsRequested}`,
      `  引用请求: ${this.stats.referencesRequested}`,
      `  定义请求: ${this.stats.definitionsRequested}`,
      `  悬停请求: ${this.stats.hoversRequested}`,
      `  补全请求: ${this.stats.completionsRequested}`,
      `  请求失败: ${this.stats.requestsFailed}`,
      `  诊断缓存: ${this.diagnosticsCache.size} 个文件`,
      ``,
      `活跃服务器:`,
      serverStatuses || '  (无)',
    ].join('\n');
  }

  // ============ Agent Loop 工具注册 ============

  /**
   * 返回 ToolDef 兼容的工具定义列表，供 Agent Loop 注册
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const lsp = this;

    return [
      {
        name: 'lsp_diagnostics',
        description: '获取文件的实时诊断信息（错误、警告、提示）。需要对应语言的 LSP 服务器已启动。支持 TypeScript、Python、Go、Rust。',
        parameters: {
          file_path: { type: 'string', description: '文件路径', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const filePath = args.file_path as string;
            if (!filePath) return '错误: file_path 参数必填';

            const result = await lsp.getDiagnostics(filePath);

            if (result.diagnostics.length === 0) {
              return `✅ ${result.filePath}: 无诊断问题`;
            }

            const lines = [`📋 ${result.filePath} — ${result.diagnostics.length} 个诊断问题:`];
            lines.push(`  ❌ 错误: ${result.errorCount}  ⚠️ 警告: ${result.warningCount}`);
            lines.push('');

            for (const d of result.diagnostics.slice(0, 30)) {
              let icon: string;
              if (d.severity === 'error') {
                icon = '❌';
              } else if (d.severity === 'warning') {
                icon = '⚠️';
              } else if (d.severity === 'hint') {
                icon = '💡';
              } else {
                icon = 'ℹ️';
              }
              const source = d.source ? `[${d.source}]` : '';
              const code = d.code ? `(${d.code})` : '';
              lines.push(`  ${icon} L${d.line + 1}:${d.character + 1} ${source}${code} ${d.message}`);
            }

            if (result.diagnostics.length > 30) {
              lines.push(`  ... 还有 ${result.diagnostics.length - 30} 个问题`);
            }

            return lines.join('\n');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 获取诊断失败: ${msg}`;
          }
        },
      },
      {
        name: 'lsp_symbols',
        description: '获取文件中的文档符号（函数、类、变量、接口等）。返回层级结构的符号列表，帮助理解代码组织。',
        parameters: {
          file_path: { type: 'string', description: '文件路径', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const filePath = args.file_path as string;
            if (!filePath) return '错误: file_path 参数必填';

            const symbols = await lsp.getSymbols(filePath);

            if (symbols.length === 0) {
              return `⚠️ ${filePath}: 未找到符号（可能语言服务器未启动或不支持该语言）`;
            }

            const lines = [`📑 ${filePath} — ${symbols.length} 个符号:`];
            lines.push('');

            const formatSymbol = (s: SymbolItem, indent: string = '  '): string[] => {
              let icon: string;
              if (s.kind === 'class') {
                icon = '🏛️';
              } else if (s.kind === 'function' || s.kind === 'method') {
                icon = '⚡';
              } else if (s.kind === 'interface') {
                icon = '🔌';
              } else if (s.kind === 'variable' || s.kind === 'constant') {
                icon = '📌';
              } else if (s.kind === 'enum') {
                icon = '🎯';
              } else {
                icon = '📎';
              }
              const result = [`${indent}${icon} ${s.name} (${s.kind}) L${s.range.startLine + 1}-${s.range.endLine + 1}`];
              if (s.children) {
                for (const child of s.children) {
                  result.push(...formatSymbol(child, indent + '  '));
                }
              }
              return result;
            };

            for (const sym of symbols) {
              lines.push(...formatSymbol(sym));
            }

            return lines.join('\n');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 获取符号失败: ${msg}`;
          }
        },
      },
      {
        name: 'lsp_references',
        description: '查找符号的所有引用位置。返回文件路径和行列号列表，用于理解代码依赖关系和影响范围。',
        parameters: {
          file_path: { type: 'string', description: '文件路径', required: true },
          line: { type: 'number', description: '行号（1-based，即编辑器中显示的行号）', required: true },
          character: { type: 'number', description: '列号（1-based，即编辑器中显示的列号）', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const filePath = args.file_path as string;
            const line = Number(args.line) - 1;  // 转换为 0-based
            const character = Number(args.character) - 1;

            if (!filePath || isNaN(line) || isNaN(character)) {
              return '错误: file_path、line、character 参数必填';
            }

            const references = await lsp.findReferences(filePath, line, character);

            if (references.length === 0) {
              return `⚠️ 未找到引用`;
            }

            const lines = [`🔗 找到 ${references.length} 个引用:`];
            lines.push('');

            for (const ref of references.slice(0, 50)) {
              lines.push(`  📍 ${ref.filePath}:${ref.line + 1}:${ref.character + 1}`);
            }

            if (references.length > 50) {
              lines.push(`  ... 还有 ${references.length - 50} 个引用`);
            }

            return lines.join('\n');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 查找引用失败: ${msg}`;
          }
        },
      },
      {
        name: 'lsp_definition',
        description: '跳转到符号的定义位置。返回定义所在的文件、行号和列号，用于追踪代码实现。',
        parameters: {
          file_path: { type: 'string', description: '文件路径', required: true },
          line: { type: 'number', description: '行号（1-based，即编辑器中显示的行号）', required: true },
          character: { type: 'number', description: '列号（1-based，即编辑器中显示的列号）', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const filePath = args.file_path as string;
            const line = Number(args.line) - 1;
            const character = Number(args.character) - 1;

            if (!filePath || isNaN(line) || isNaN(character)) {
              return '错误: file_path、line、character 参数必填';
            }

            const definition = await lsp.gotoDefinition(filePath, line, character);

            if (!definition) {
              return `⚠️ 未找到定义`;
            }

            let result = `🎯 定义位置: ${definition.filePath}:${definition.line + 1}:${definition.character + 1}`;
            if (definition.endLine !== undefined) {
              result += ` — ${definition.endLine + 1}:${definition.endCharacter ?? 0}`;
            }
            return result;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 查找定义失败: ${msg}`;
          }
        },
      },
      {
        name: 'lsp_hover',
        description: '获取光标位置的悬停信息，包括类型签名和文档注释。用于理解符号的类型和用法。',
        parameters: {
          file_path: { type: 'string', description: '文件路径', required: true },
          line: { type: 'number', description: '行号（1-based，即编辑器中显示的行号）', required: true },
          character: { type: 'number', description: '列号（1-based，即编辑器中显示的列号）', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const filePath = args.file_path as string;
            const line = Number(args.line) - 1;
            const character = Number(args.character) - 1;

            if (!filePath || isNaN(line) || isNaN(character)) {
              return '错误: file_path、line、character 参数必填';
            }

            const hover = await lsp.getHover(filePath, line, character);

            if (!hover) {
              return `⚠️ 无悬停信息`;
            }

            const lines = [`💡 悬停信息:`];
            lines.push(`  类型: ${hover.typeInfo}`);
            if (hover.documentation) {
              lines.push(`  文档: ${hover.documentation}`);
            }
            return lines.join('\n');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 获取悬停信息失败: ${msg}`;
          }
        },
      },
    ];
  }

  /**
   * 释放所有资源 — 统一停止所有已启动的语言服务器子进程。
   *
   * 修复背景：原先 LSPIntegration 仅提供按语言的 stopServer(language)，
   * 缺少类级 dispose()/stopAll()，应用退出时若不逐个 stopServer 会遗留多个
   * LSP 子进程（pyright/typescript-language-server/gopls 等）成为孤儿进程。
   * bootstrap.ts 的 dispose 链此前遗漏本类，现统一补齐。
   *
   * 同步 dispose 立即 kill 进程（不等优雅退出）；异步 disposeAsync 走完整 LSP
   * shutdown 协议。
   */
  dispose(): void {
    for (const [language, server] of this.servers) {
      try {
        if (server.restartTimer) {
          clearTimeout(server.restartTimer);
          server.restartTimer = null;
        }
        if (server.process && !server.process.killed) {
          // 同步 dispose 直接 SIGKILL，避免 dispose 链被 LSP 协议握手阻塞
          server.process.kill('SIGKILL');
        }
        this.clearPendingRequests(server, 'LSPIntegration.dispose');
        server.status = 'stopped';
        server.process = null;
        this.log.info('LSP 服务器已强制停止', { language });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('LSP 服务器停止失败', { language, error: msg });
      }
    }
  }

  /** 异步释放 — 走完整 LSP shutdown 协议（最多 5s/语言） */
  async disposeAsync(): Promise<void> {
    const languages = Array.from(this.servers.keys());
    await Promise.all(
      languages.map(lang =>
        this.stopServer(lang).catch(err => {
          this.log.warn('LSP 服务器异步停止失败', { language: lang, error: err?.message ?? String(err) });
        }),
      ),
    );
  }
}


