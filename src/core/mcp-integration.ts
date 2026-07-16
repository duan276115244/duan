/**
 * MCP 集成 — Model Context Protocol
 *
 * 设计源自 OpenCode + OpenClaw 的 MCP 实现：
 * - 支持 stdio, SSE, WebSocket 三种传输方式
 * - MCP 工具自动注册到 UnifiedToolFramework
 * - 工具调用结果事件通过 EventBus 广播
 * - 支持多个 MCP 服务器并行连接
 * - 自动重连和健康检查
 */

import { EventBus, Events } from './event-bus.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { getMCPSecurityGuard } from './mcp-security.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJson } from './atomic-write.js';

// ============ 类型定义 ============

export type MCPTransport = 'stdio' | 'sse' | 'websocket';

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: MCPTransport;
  /** 对于 stdio: command + args */
  command?: string;
  args?: string[];
  /** 对于 sse/websocket: url */
  url?: string;
  /** 备用 URL 列表：主 URL 失败时按序尝试 failover */
  fallbackUrls?: string[];
  /** 对于 sse: 自定义请求头 */
  headers?: Record<string, string>;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
  /** 自动重连 */
  autoReconnect?: boolean;
  /** 超时毫秒 */
  timeoutMs?: number;
  /** 最大工具数限制 */
  maxTools?: number;
  /** 心跳间隔毫秒（0 表示禁用，默认 30000） */
  heartbeatIntervalMs?: number;
  /** 心跳超时毫秒（超过此时间未收到响应则判定连接断开，默认 10000） */
  heartbeatTimeoutMs?: number;
}

/** 服务器能力声明 */
export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  completion?: Record<string, unknown>;
  /** 服务器自定义能力 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exported interface public field
  experimental?: Record<string, any>;
}

/** 协议版本协商结果 */
export interface ProtocolNegotiation {
  /** 客户端支持的版本列表（按优先级降序） */
  clientSupported: string[];
  /** 服务器支持的版本 */
  serverSupported?: string;
  /** 最终协商采用的版本 */
  agreed: string;
  /** 服务器能力 */
  capabilities: MCPServerCapabilities;
  /** 服务器信息 */
  serverInfo?: { name: string; version: string };
}

export interface MCPToolDefinition {
  serverId: string;
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exported interface public field
  inputSchema: Record<string, any>;
}

export interface MCPCallToolRequest {
  serverId: string;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exported interface public field
  arguments: Record<string, any>;
  timeoutMs?: number;
}

export interface MCPCallToolResult {
  success: boolean;
  output: string;
  error?: string;
  isError?: boolean;
  content?: Array<{
    type: 'text' | 'image' | 'resource' | 'audio';
    text?: string;
    mimeType?: string;
    data?: string;
    uri?: string;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exported interface public field
  metadata?: Record<string, any>;
}

// ============ JSON-RPC 消息 ============

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC 动态 payload
  params?: any;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC 动态 payload
  result?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC 动态 payload
  error?: { code: number; message: string; data?: any };
}

// ============ SSE 传输 ============

type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse;

class SSETransport {
  private endpoint: string;
  private sessionId: string | null = null;
  private messageEndpoint: string | null = null;
  private headers: Record<string, string>;
  private abortController: AbortController | null = null;
  private connected = false;
  private onMessage: ((msg: JSONRPCMessage) => void) | null = null;
  private readerLoop: Promise<void> | null = null;

  constructor(url: string, headers?: Record<string, string>) {
    this.endpoint = url;
    this.headers = headers || {};
  }

  /** 设置消息回调 */
  setMessageHandler(handler: (msg: JSONRPCMessage) => void): void {
    this.onMessage = handler;
  }

  /** 建立 SSE 连接 */
  async connect(timeoutMs: number = 10000): Promise<void> {
    if (this.connected) return;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    // 建立 SSE 连接
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      ...this.headers,
    };

    // eslint-disable-next-line no-async-promise-executor, @typescript-eslint/no-misused-promises
    const connectPromise = new Promise<void>(async (resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.abortController?.abort();
          reject(new Error('SSE 连接超时'));
        }
      }, timeoutMs);

      try {
        const response = await fetch(this.endpoint, {
          method: 'GET',
          headers,
          signal,
        });

        if (!response.ok) {
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            reject(new Error(`SSE 连接失败: HTTP ${response.status} ${response.statusText}`));
          }
          return;
        }

        if (!response.body) {
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            reject(new Error('SSE 连接失败: 响应体为空'));
          }
          return;
        }

        // 解析 SSE 事件流
        let buffer = '';
        const decoder = new TextDecoder();
        let currentEvent = '';
        let currentData = '';

        this.readerLoop = (async () => {
          const reader = response.body!.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('event:')) {
                  currentEvent = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  currentData += line.slice(5).trim();
                } else if (line === '' || line === '\r') {
                  // 空行表示事件结束
                  if (currentData) {
                    this.handleSSEEvent(currentEvent, currentData, resolve, () => {
                      if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                      }
                    });
                  }
                  currentEvent = '';
                  currentData = '';
                }
              }
            }
          } catch (err: unknown) {
            const errName = (err as { name?: string })?.name;
            if (errName !== 'AbortError') {
              console.error('[MCP:SSE] 读取流错误:', (err instanceof Error ? err.message : String(err)));
            }
          } finally {
            this.connected = false;
          }
        })();

        // 等待 endpoint 事件或超时
        // resolve 会在 handleSSEEvent 中收到 'endpoint' 事件后调用
      } catch (err: unknown) {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      }
    });

    await connectPromise;
  }

  /** 处理 SSE 事件 */
  private handleSSEEvent(
    event: string,
    data: string,
    connectResolve: () => void,
    markResolved: () => void,
  ): void {
    try {
      if (event === 'endpoint') {
        // endpoint 事件：获取消息发送端点
        const endpointPath = data.trim();
        // 如果是相对路径，拼接 base URL
        if (endpointPath.startsWith('/')) {
          const base = new URL(this.endpoint);
          this.messageEndpoint = `${base.protocol}//${base.host}${endpointPath}`;
        } else {
          this.messageEndpoint = endpointPath;
        }
        this.connected = true;
        markResolved();
        connectResolve();
        console.info(`[MCP:SSE] 获取消息端点: ${this.messageEndpoint}`);
      } else if (event === 'message' || event === '') {
        // message 事件或默认事件：JSON-RPC 消息
        const msg = JSON.parse(data);
        if (this.onMessage) {
          this.onMessage(msg);
        }
      }
    } catch {
      // 非 JSON 数据，忽略
    }
  }

  /** 发送 JSON-RPC 消息 */
  async send(message: JSONRPCMessage): Promise<JSONRPCResponse | null> {
    if (!this.messageEndpoint) {
      throw new Error('SSE 未连接: messageEndpoint 未获取');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };

    // 如果有 sessionId，附加到查询参数
    let url = this.messageEndpoint;
    if (this.sessionId) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}sessionId=${encodeURIComponent(this.sessionId)}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`SSE 发送失败: HTTP ${response.status} ${response.statusText}`);
    }

    // POST 请求可能返回空响应体（通知类消息），或返回 JSON-RPC 响应
    const text = await response.text();
    if (!text.trim()) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** 关闭 SSE 连接 */
  async close(): Promise<void> {
    this.connected = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.readerLoop !== null) {
      await this.readerLoop.catch(() => {});
      this.readerLoop = null;
    }
    this.messageEndpoint = null;
    this.sessionId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ============ MCP 客户端 ============

class MCPClient {
  config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private sseTransport: SSETransport | null = null;
  /** WebSocket 传输实例（websocket 模式） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws 库实例，需访问其属性/方法
  private wsSocket: any | null = null;
  private pendingRequests: Map<string | number, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC 动态结果
    resolve: (value: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态 reject 原因
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private buffer = '';
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId = 0;
  private tools: MCPToolDefinition[] = [];
  private eventBus: EventBus;
  private retryCount = 0;           // 重试计数
  private maxRetries = 3;           // 最大重试次数
  private permanentFailure = false; // 永久失败标记（如 ENOENT）
  private lastError: string = '';   // 上次错误信息
  /** 协议协商结果 */
  private negotiation: ProtocolNegotiation | null = null;
  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳超时定时器 */
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前使用的 URL（failover 时会变化） */
  private currentUrl: string | null = null;
  /** 已尝试的 failover 索引 */
  private failoverIndex = 0;
  /** 客户端支持的协议版本（按优先级降序） */
  private static readonly CLIENT_PROTOCOL_VERSIONS = [
    '2025-06-18',  // 最新
    '2025-03-26',
    '2024-11-05',  // 兼容旧版
  ];

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.eventBus = EventBus.getInstance();
  }

  /** 获取协议协商结果 */
  getNegotiation(): ProtocolNegotiation | null {
    return this.negotiation;
  }

  /** 获取服务器能力 */
  getServerCapabilities(): MCPServerCapabilities | null {
    return this.negotiation?.capabilities || null;
  }

  async connect(): Promise<boolean> {
    if (this.connected) return true;
    // 永久失败则不再重试
    if (this.permanentFailure) {
      console.warn(`[MCP] 跳过连接: ${this.config.name} (永久失败: ${this.lastError})`);
      return false;
    }
    // 超过最大重试次数则不再重试
    if (this.retryCount >= this.maxRetries) {
      console.warn(`[MCP] 跳过连接: ${this.config.name} (已重试${this.maxRetries}次)`);
      return false;
    }

    try {
      if (this.config.transport === 'stdio') {
        await this.connectStdio();
      } else if (this.config.transport === 'sse') {
        // 传输 failover：主 URL 失败时尝试备用 URL
        await this.connectSSEWithFailover();
      } else if (this.config.transport === 'websocket') {
        // WebSocket failover：主 URL 失败时尝试备用 URL
        await this.connectWebsocketWithFailover();
      }

      this.connected = true;
      this.retryCount = 0; // 连接成功，重置重试计数
      console.info(`[MCP] 已连接: ${this.config.name} (${this.config.transport}${this.currentUrl ? ` @ ${this.currentUrl}` : ''})`);

      // 初始化并获取工具列表
      await this.initialize();
      await this.discoverTools();

      // 启动心跳
      this.startHeartbeat();

      await this.eventBus.emit(Events.MCP_SERVER_CONNECTED, {
        serverId: this.config.id,
        name: this.config.name,
        transport: this.config.transport,
        toolCount: this.tools.length,
      }, { source: 'mcp' });

      return true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.lastError = errMsg;

      // 永久失败情况：命令不存在、包不存在(404)、npm lock损坏、依赖缺失
      const errCode = (err as { code?: string })?.code;
      const isPermanent =
        errCode === 'ENOENT' ||
        errMsg.includes('ENOENT') ||
        errMsg.includes('E404') ||
        errMsg.includes('404 Not Found') ||
        errMsg.includes('ECOMPROMISED') ||
        errMsg.includes('code E404') ||
        errMsg.includes('Please provide a database URL');

      if (isPermanent) {
        this.permanentFailure = true;
        console.error(`[MCP] 连接永久失败: ${this.config.name} (${errMsg.substring(0, 100)}) — 已禁用重试`);
      } else {
        this.retryCount++;
        console.error(`[MCP] 连接失败: ${this.config.name} (重试 ${this.retryCount}/${this.maxRetries})`, (err instanceof Error ? err.message : String(err)) || err);
      }

      await this.handleDisconnect();
      return false;
    }
  }

  /**
   * SSE 连接带 failover：主 URL 失败时按序尝试 fallbackUrls
   */
  private async connectSSEWithFailover(): Promise<void> {
    const urls = [this.config.url, ...(this.config.fallbackUrls || [])].filter(Boolean) as string[];
    if (urls.length === 0) {
      throw new Error('SSE 模式需要 url 或 fallbackUrls');
    }

    let lastErr: Error | null = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        this.currentUrl = urls[i];
        this.failoverIndex = i;
        await this.connectSSE(urls[i]);
        return; // 成功则返回
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.warn(`[MCP] SSE 连接失败 (${i + 1}/${urls.length}): ${urls[i]} — ${(err instanceof Error ? err.message : String(err))}`);
        // 清理当前失败的连接
        if (this.sseTransport) {
          await this.sseTransport.close().catch(() => {});
          this.sseTransport = null;
        }
      }
    }
    // 所有 URL 都失败
    this.currentUrl = null;
    throw lastErr || new Error('所有 SSE 端点均不可用');
  }

  /**
   * WebSocket 连接带 failover：主 URL 失败时按序尝试 fallbackUrls
   *
   * 真实实现（非 stub）：使用 `ws` 库建立 WebSocket 连接，支持 JSON-RPC 双向通信。
   */
  private async connectWebsocketWithFailover(): Promise<void> {
    const urls = [this.config.url, ...(this.config.fallbackUrls || [])].filter(Boolean) as string[];
    if (urls.length === 0) {
      throw new Error('WebSocket 模式需要 url 或 fallbackUrls');
    }

    let lastErr: Error | null = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        this.currentUrl = urls[i];
        this.failoverIndex = i;
        await this.connectWebsocket(urls[i]);
        return; // 成功则返回
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.warn(`[MCP] WebSocket 连接失败 (${i + 1}/${urls.length}): ${urls[i]} — ${(err instanceof Error ? err.message : String(err))}`);
        // 清理当前失败的连接
        if (this.wsSocket) {
          try {
            this.wsSocket.removeAllListeners();
            if (this.wsSocket.readyState === 1 /* OPEN */) {
              this.wsSocket.close();
            }
          } catch {}
          this.wsSocket = null;
        }
      }
    }
    // 所有 URL 都失败
    this.currentUrl = null;
    throw lastErr || new Error('所有 WebSocket 端点均不可用');
  }

  /**
   * 真实建立 WebSocket 连接（使用 `ws` 库）
   *
   * 实现要点：
   * 1. 动态 import 'ws' 库（项目已有 ws@^8.16.0 依赖）
   * 2. 建立 WebSocket 连接，附带自定义 headers
   * 3. 设置 on('message') 回调处理 JSON-RPC 响应（复用 handleWebsocketMessage）
   * 4. 设置 on('close') / on('error') 回调触发重连
   * 5. 等待 'open' 事件或超时
   */
  private async connectWebsocket(targetUrl?: string): Promise<void> {
    const url = targetUrl || this.config.url;
    if (!url) {
      throw new Error('WebSocket 模式需要 url');
    }

    // 动态 import ws 库（避免在未使用 websocket 模式时加载）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws 库动态 import，需作为构造函数调用
    let WebSocketCtor: any;
    try {
      const wsModule = await import('ws');
      WebSocketCtor = wsModule.WebSocket || wsModule.default || wsModule;
    } catch (err: unknown) {
      throw new Error(`WebSocket 传输需要 'ws' 库，但未安装: ${(err instanceof Error ? err.message : String(err))}`);
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.config.timeoutMs || 10000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws 库 options，需动态赋值 headers
      const wsOptions: any = {};
      if (this.config.headers) {
        wsOptions.headers = { ...this.config.headers };
      }

      const socket = new WebSocketCtor(url, wsOptions);
      let settled = false;

      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.removeAllListeners();
          if (socket.readyState === 1 /* OPEN */) {
            socket.close();
          }
        } catch {}
        reject(new Error(`WebSocket 连接超时: ${url} (${timeoutMs}ms)`));
      }, timeoutMs);

      socket.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.wsSocket = socket;
        console.info(`[MCP] WebSocket 已连接: ${this.config.name} @ ${url}`);
        resolve();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws message 回调参数，可能为 Buffer/string
      socket.on('message', (data: any) => {
        // ws 库的 message 事件可能传 Buffer 或字符串
        let text: string;
        if (Buffer.isBuffer(data)) {
          text = data.toString('utf-8');
        } else if (typeof data === 'string') {
          text = data;
        } else {
          text = String(data);
        }
        this.handleWebsocketMessage(text);
      });

      socket.on('error', (err: Error) => {
        if (settled) {
          // 连接建立后发生的错误
          console.warn(`[MCP] WebSocket 错误: ${this.config.name} — ${err.message}`);
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error(`WebSocket 连接错误: ${err.message}`));
      });

      socket.on('close', (code: number, reason: Buffer) => {
        if (settled && this.connected) {
          // 连接建立后异常关闭，触发重连
          const reasonText = reason ? reason.toString('utf-8') : '';
          console.warn(`[MCP] WebSocket 连接关闭: ${this.config.name} (code=${code} reason=${reasonText})`);
          this.handleDisconnect().catch(() => {});
        }
      });
    });
  }

  /**
   * 处理 WebSocket 推送的 JSON-RPC 消息
   *
   * 与 SSE/stdio 的消息处理逻辑一致，但 WebSocket 消息是完整的 JSON-RPC 帧
   * （不需要像 stdio 那样按行分割 buffer）。
   */
  private handleWebsocketMessage(text: string): void {
    try {
      const msg = JSON.parse(text);

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        // 响应消息
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        // 服务端主动推送的通知
        console.info(`[MCP] 收到通知: ${msg.method}`);
      }
    } catch {
      // 非 JSON 数据，忽略
    }
  }

  /**
   * 启动心跳：定期 ping 检查连接活性
   */
  private startHeartbeat(): void {
    const intervalMs = this.config.heartbeatIntervalMs ?? 30000;
    if (intervalMs <= 0) return; // 0 表示禁用心跳

    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
      if (!this.connected) return;
      try {
        // 设置心跳超时
        const timeoutMs = this.config.heartbeatTimeoutMs ?? 10000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          this.heartbeatTimeoutTimer = setTimeout(() => {
            reject(new Error('心跳超时'));
          }, timeoutMs);
        });

        await Promise.race([
          this.sendRequest('ping'),
          timeoutPromise,
        ]);

        // 心跳成功，清除超时定时器
        if (this.heartbeatTimeoutTimer) {
          clearTimeout(this.heartbeatTimeoutTimer);
          this.heartbeatTimeoutTimer = null;
        }
      } catch (err: unknown) {
        console.warn(`[MCP] 心跳失败: ${this.config.name} — ${(err instanceof Error ? err.message : String(err))}`);
        if (this.heartbeatTimeoutTimer) {
          clearTimeout(this.heartbeatTimeoutTimer);
          this.heartbeatTimeoutTimer = null;
        }
        // 心跳失败触发重连
        this.handleDisconnect().catch(() => {});
      }
      })();
    }, intervalMs);
    // 防止定时器阻止进程优雅退出
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /** 停止心跳 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private connectStdio(): Promise<void> {
    const { command, args, env, cwd } = this.config;

    return new Promise((resolve, reject) => {
      if (!command) {
        reject(new Error('stdio 模式需要 command'));
        return;
      }

      const child = spawn(command, args || [], {
        env: { ...process.env, ...(env || {}) },
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,  // Windows下npx是npx.cmd，需要shell模式
      });

      this.process = child;
      let resolved = false;
      let stderrOutput = '';
      let readyTimer: ReturnType<typeof setTimeout> | undefined;

      child.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        console.warn(`[MCP:${this.config.name} stderr]`, text);
      });

      child.on('error', (err) => {
        if (readyTimer) clearTimeout(readyTimer);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      child.on('close', (code) => {
        // 如果进程立即退出且非0，说明配置有问题
        if (code !== 0 && code !== null) {
          const errMsg = stderrOutput.trim();
          // 检测常见配置错误
          if (errMsg.includes('Please provide') || errMsg.includes('required') || errMsg.includes('missing')) {
            this.permanentFailure = true;
            this.lastError = `配置缺失: ${errMsg.substring(0, 100)}`;
            console.error(`[MCP] 配置错误(永久失败): ${this.config.name} — ${errMsg.substring(0, 100)}`);
          } else if (errMsg.includes('E404') || errMsg.includes('not found') || errMsg.includes('ENOENT')) {
            this.permanentFailure = true;
            this.lastError = `包不存在: ${errMsg.substring(0, 100)}`;
            console.error(`[MCP] 包不存在(永久失败): ${this.config.name} — ${errMsg.substring(0, 100)}`);
          }
        }
        console.warn(`[MCP] 进程退出: ${this.config.name} (code=${code})`);
        this.handleDisconnect().catch(() => {});
      });

      // 等待进程就绪（保存句柄以便在 spawn/error 时清理）
      readyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 500);

      // 进程正常启动后即就绪，清理超时兜底
      child.on('spawn', () => {
        if (readyTimer) clearTimeout(readyTimer);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  }

  private async connectSSE(targetUrl?: string): Promise<void> {
    const { headers } = this.config;
    const url = targetUrl || this.config.url;

    if (!url) {
      throw new Error('SSE 模式需要 url');
    }

    this.sseTransport = new SSETransport(url, headers);

    // 设置消息回调，处理服务端推送的 JSON-RPC 响应
    this.sseTransport.setMessageHandler((msg) => {
      this.handleSSEMessage(msg);
    });

    // 建立连接（10秒超时）
    await this.sseTransport.connect(this.config.timeoutMs || 10000);
  }

  /** 处理 SSE 推送的 JSON-RPC 消息 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC 动态消息，需访问 id/result/error/method
  private handleSSEMessage(msg: any): void {
    try {
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        // 响应消息
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        // 服务端主动推送的通知
        console.info(`[MCP] 收到通知: ${msg.method}`);
      }
    } catch {
      // 忽略解析错误
    }
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;

    // 处理 JSON-RPC 消息（按行分割）
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          // 响应消息
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if (msg.method) {
          // 服务端主动推送的通知（暂不处理）
          console.info(`[MCP] 收到通知: ${msg.method}`);
        }
      } catch {
        // 非 JSON 数据，忽略
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC 动态 params/result
  private sendRequest(method: string, params?: any): Promise<any> {
    const id = ++this.messageId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, this.config.timeoutMs || 60000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      if (this.config.transport === 'sse' && this.sseTransport) {
        // SSE 模式：通过 POST 发送消息，响应通过 SSE 流异步接收
        this.sseTransport.send(request).then((response) => {
          // 如果 POST 直接返回了响应（某些实现），直接处理
          if (response && response.id !== undefined) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
          }
          // 否则响应会通过 SSE 流的 message 事件到达 handleSSEMessage
        }).catch((err) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        });
      } else if (this.config.transport === 'websocket' && this.wsSocket && this.wsSocket.readyState === 1) {
        // WebSocket 模式：通过 ws.send 发送 JSON-RPC 帧
        // 响应会通过 ws 的 'message' 事件到达 handleWebsocketMessage
        try {
          this.wsSocket.send(JSON.stringify(request));
        } catch (err: unknown) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`WebSocket 发送失败: ${(err instanceof Error ? err.message : String(err))}`));
        }
      } else if (this.process?.stdin?.writable) {
        // stdio 模式：写入 stdin
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } else {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error('MCP 未连接'));
      }
    });
  }

  /**
   * 初始化握手：协议版本协商 + 能力发现
   * 客户端声明支持的所有版本，服务器返回其支持的版本和能力，
   * 双方采用客户端列表中第一个被服务器支持的版本。
   */
  private async initialize(): Promise<void> {
    const clientVersions = MCPClient.CLIENT_PROTOCOL_VERSIONS;
    const result = await this.sendRequest('initialize', {
      // 声明客户端支持的最高版本（按 MCP 规范，单个字段）
      // 客户端会在 capabilities 中声明完整支持列表，服务器可据此协商
      protocolVersion: clientVersions[0],
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        logging: {},
        completion: {},
        // 客户端额外支持的协议版本（用于版本协商）
        experimental: {
          'client-protocol-versions': clientVersions,
        },
      },
      clientInfo: {
        name: 'duan-agent',
        version: '19.0.0',
      },
    });

    // 解析服务器响应，进行版本协商
    const serverVersion = result?.protocolVersion;
    const serverCapabilities = (result?.capabilities || {}) as MCPServerCapabilities;
    const serverInfo = result?.serverInfo;

    // 协商规则：优先采用服务器版本（如果客户端支持），否则降级到客户端默认
    let agreedVersion: string;
    if (serverVersion && clientVersions.includes(serverVersion)) {
      agreedVersion = serverVersion;
    } else if (serverVersion) {
      // 服务器版本客户端不支持，降级使用客户端最高版本（尽力兼容）
      console.warn(`[MCP] 服务器协议版本 ${serverVersion} 不在客户端支持列表，降级使用 ${clientVersions[0]}`);
      agreedVersion = clientVersions[0];
    } else {
      agreedVersion = clientVersions[0];
    }

    this.negotiation = {
      clientSupported: [...clientVersions],
      serverSupported: serverVersion,
      agreed: agreedVersion,
      capabilities: serverCapabilities,
      serverInfo: serverInfo,
    };

    console.info(`[MCP] 协议协商完成: ${this.config.name} — 版本 ${agreedVersion}（服务器声明 ${serverVersion || '未知'}），能力: ${Object.keys(serverCapabilities).join('/') || '无'}`);

    // 发送 initialized 通知（MCP 规范要求）
    try {
      await this.sendRequest('notifications/initialized');
    } catch {
      // 某些服务器可能不支持此通知，忽略错误
    }
  }

  private async discoverTools(): Promise<void> {
    try {
      const result = await this.sendRequest('tools/list');
      if (result?.tools) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP 工具定义，需访问 name/description/inputSchema
        this.tools = result.tools.map((t: any) => ({
          serverId: this.config.id,
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || {},
        }));

        await this.eventBus.emit(Events.MCP_TOOL_DISCOVERED, {
          serverId: this.config.id,
          tools: this.tools.map(t => t.name),
          count: this.tools.length,
        }, { source: 'mcp' });
      }
    } catch (err: unknown) {
      console.error(`[MCP] 获取工具列表失败: ${this.config.name}`, err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具参数透传至 JSON-RPC
  async callTool(toolName: string, args: Record<string, any>): Promise<MCPCallToolResult> {
    if (!this.connected) {
      return { success: false, output: '', error: 'MCP 服务器未连接' };
    }

    try {
      const result = await this.sendRequest('tools/call', {
        name: toolName,
        arguments: args,
      });

      return {
        success: true,
        output: result?.content?.[0]?.text || JSON.stringify(result),
        content: result?.content,
        isError: result?.isError,
      };
    } catch (err: unknown) {
      await this.eventBus.emit(Events.MCP_TOOL_ERROR, {
        serverId: this.config.id,
        toolName,
        error: (err instanceof Error ? err.message : String(err)),
      }, { source: 'mcp' });
      return { success: false, output: '', error: (err instanceof Error ? err.message : String(err)) };
    }
  }

  getTools(): MCPToolDefinition[] {
    return [...this.tools];
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async handleDisconnect(): Promise<void> {
    this.connected = false;
    this.process = null;

    // 停止心跳
    this.stopHeartbeat();

    // 关闭 SSE 连接
    if (this.sseTransport) {
      await this.sseTransport.close().catch(() => {});
      this.sseTransport = null;
    }

    // 拒绝所有挂起的请求
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP 连接断开'));
    }
    this.pendingRequests.clear();

    await this.eventBus.emit(Events.MCP_SERVER_DISCONNECTED, {
      serverId: this.config.id,
      name: this.config.name,
    }, { source: 'mcp' });

    // 永久失败或超过最大重试次数，不再重连
    if (this.permanentFailure || this.retryCount >= this.maxRetries) {
      console.warn(`[MCP] 停止重连: ${this.config.name} (永久失败:${this.permanentFailure}, 重试:${this.retryCount}/${this.maxRetries})`);
      return;
    }

    // 自动重连（带指数退避：5s, 10s, 20s）
    if (this.config.autoReconnect !== false) {
      const delay = 5000 * Math.pow(2, this.retryCount);
      console.info(`[MCP] 将在 ${delay/1000}s 后重连: ${this.config.name}`);
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {});
      }, delay);
    }
  }

  async disconnect(): Promise<void> {
    // 停止心跳和重连定时器
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.sseTransport) {
      await this.sseTransport.close().catch(() => {});
      this.sseTransport = null;
    }
    // WebSocket 模式：关闭 ws 连接
    if (this.wsSocket) {
      try {
        this.wsSocket.removeAllListeners();
        if (this.wsSocket.readyState === 1 /* OPEN */) {
          this.wsSocket.close();
        }
      } catch {}
      this.wsSocket = null;
    }
    this.connected = false;
  }
}

// ============ MCP 管理器 ============

export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  private eventBus: EventBus;
  private configPath: string;
  /** 幂等初始化 promise — 避免双重 initialize() 导致重复连接 MCP 服务器 */
  private _initPromise: Promise<void> | null = null;

  constructor(configPath: string = duanPath('mcp-config.json')) {
    this.configPath = configPath;
    this.eventBus = EventBus.getInstance();
  }

  /** 初始化：加载配置并连接所有 MCP 服务器（幂等 — 重复调用返回同一 promise，不重复连接） */
  initialize(): Promise<void> {
    if (this._initPromise !== null) return this._initPromise;
    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      const configs = await this.loadConfig();
      const connectPromises: Promise<boolean | void>[] = [];

      for (const config of configs) {
        connectPromises.push(
          this.addServer(config).catch((err: Error) => {
            console.warn(`[MCP] 无法连接 ${config.name}: ${err.message}`);
          })
        );
      }

      await Promise.all(connectPromises);
      // MCP connection status (suppressed in production)
    } catch {
      // MCP未配置，跳过
    }
  }

  /** 添加并连接 MCP 服务器 */
  async addServer(config: MCPServerConfig): Promise<boolean> {
    if (this.clients.has(config.id)) {
      console.warn(`[MCP] 服务器 ${config.id} 已存在`);
      return false;
    }

    // v15.2 安全审核：注册插件到安全防护层
    const guard = getMCPSecurityGuard();
    guard.registerPlugin(config.id, {
      timeoutMs: config.timeoutMs || 30000,
      networkAccess: config.transport !== 'stdio',
    });

    const client = new MCPClient(config);
    const connected = await client.connect();

    if (connected) {
      this.clients.set(config.id, client);
      await this.saveConfig();
    }

    return connected;
  }

  /** 移除并断开 MCP 服务器 */
  async removeServer(serverId: string): Promise<boolean> {
    const client = this.clients.get(serverId);
    if (!client) return false;

    await client.disconnect();
    this.clients.delete(serverId);
    await this.saveConfig();
    return true;
  }

  /** 调用 MCP 工具（v15.2：集成安全防护层） */
  async callTool(request: MCPCallToolRequest): Promise<MCPCallToolResult> {
    const client = this.clients.get(request.serverId);
    if (!client) {
      return { success: false, output: '', error: `MCP 服务器 ${request.serverId} 未连接` };
    }

    // 1. 安全防护层检查
    const guard = getMCPSecurityGuard();
    const sanitizedArgs = guard.sanitizeArgs(request.arguments);
    const permission = await guard.checkPermission(request.serverId, request.toolName, sanitizedArgs);
    if (!permission.allowed) {
      return {
        success: false,
        output: '',
        error: `安全拦截: ${permission.reason} (风险等级: ${permission.risk})`,
        isError: true,
      };
    }

    // 2. 带超时执行（防止恶意 MCP Server 挂起）
    const config = guard.getPluginConfig(request.serverId);
    const timeoutMs = request.timeoutMs || config?.timeoutMs || 30000;

    try {
      const result = await Promise.race([
        client.callTool(request.toolName, sanitizedArgs),
        new Promise<MCPCallToolResult>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP 工具执行超时 (${timeoutMs}ms)`)), timeoutMs),
        ),
      ]);

      // 3. 输出截断（防止内存耗尽）
      if (result.output) {
        result.output = guard.truncateOutput(result.output, config?.maxOutputLength || 10000);
      }

      return result;
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: (err instanceof Error ? err.message : String(err)) || 'MCP 工具执行失败',
        isError: true,
      };
    }
  }

  /** 获取所有已发现的 MCP 工具 */
  getAllTools(): MCPToolDefinition[] {
    const allTools: MCPToolDefinition[] = [];
    for (const client of this.clients.values()) {
      allTools.push(...client.getTools());
    }
    return allTools;
  }

  /** 获取所有 MCP 工具（以 UnifiedToolFramework 兼容格式） */
  getToolsAsUnifiedDefinitions(): Array<{
    id: string;
    name: string;
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UnifiedToolFramework 兼容返回类型
    parameters: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute 参数透传至 callTool
    execute: (args: any) => Promise<string>;
    category: string;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具定义数组，元素属性需动态访问
    const tools: Array<any> = [];
    for (const client of this.clients.values()) {
      for (const mcpTool of client.getTools()) {
        const toolId = `mcp_${client.config.id}_${mcpTool.name}`;
        tools.push({
          id: toolId,
          name: mcpTool.name,
          description: `[MCP:${client.config.name}] ${mcpTool.description}`,
          parameters: this.schemaToParameters(mcpTool.inputSchema),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute 参数透传至 callTool
          execute: async (args: any) => {
            const result = await client.callTool(mcpTool.name, args);
            return result.success ? result.output : `错误: ${result.error}`;
          },
          category: 'mcp',
        });
      }
    }
    return tools;
  }

  /** 将 JSON Schema 转换为 UnifiedToolFramework 参数格式 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema 动态结构，需访问 properties/required
  private schemaToParameters(schema: Record<string, any>): Record<string, any> {
    if (!schema || !schema.properties) return {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 参数定义，需赋值 type/description/required
    const params: Record<string, any> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema 属性对象，需访问 type/description
    for (const [key, prop] of Object.entries<any>(schema.properties)) {
      params[key] = {
        type: prop.type || 'string',
        description: prop.description || '',
        required: schema.required?.includes(key) || false,
      };
    }
    return params;
  }

  /** 获取已连接的服务器列表（含协议协商和能力信息） */
  listServers(): Array<{
    id: string;
    name: string;
    transport: MCPTransport;
    toolCount: number;
    connected: boolean;
    protocolVersion?: string;
    serverInfo?: { name: string; version: string };
    capabilities?: MCPServerCapabilities;
    currentUrl?: string;
  }> {
    return Array.from(this.clients.entries()).map(([id, client]) => {
      const negotiation = client.getNegotiation();
      return {
        id,
        name: client.config.name,
        transport: client.config.transport,
        toolCount: client.getTools().length,
        connected: client.isConnected(),
        protocolVersion: negotiation?.agreed,
        serverInfo: negotiation?.serverInfo,
        capabilities: negotiation?.capabilities,
        currentUrl: (client as unknown as { currentUrl?: string | null }).currentUrl || undefined,
      };
    });
  }

  /** 加载配置文件 */
  private async loadConfig(): Promise<MCPServerConfig[]> {
    try {
      const absPath = path.resolve(this.configPath);
      const content = await fs.readFile(absPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /** 保存配置文件 */
  private async saveConfig(): Promise<void> {
    try {
      const configs: MCPServerConfig[] = [];
      for (const client of this.clients.values()) {
        configs.push(client.config);
      }
      const absPath = path.resolve(this.configPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await atomicWriteJson(absPath, configs);
    } catch (err: unknown) {
      console.error('[MCP] 保存配置失败:', err);
    }
  }

  /** 断开所有 MCP 连接 */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }
}
