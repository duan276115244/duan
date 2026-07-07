// ============================================================
// 统一移动端/远程交互桥接服务
// RemoteBridgeService — 为配置的移动通道提供实际 Bot 运行时
// ============================================================
// 功能：
//   1. 读取 ~/.duan/config.json 中配置的 mobileChannels
//   2. 为每个通道启动 Bot 监听器（Webhook 接收 / HTTP 长轮询）
//   3. 将收到的消息路由到 Agent 后端 /api/chat/stream
//   4. 将 Agent 响应回传到对应通道
//
// 支持的通道类型：
//   wecom      — 企业微信（回调验证 + 消息接收 Webhook）
//   feishu     — 飞书（事件订阅 Webhook）
//   dingtalk   — 钉钉（Outgoing Webhook）
//   webhook    — 通用 Webhook（直接转发）
//   telegram   — Telegram Bot（HTTP 长轮询 getUpdates）
//   discord    — Discord（Webhook 接收 + Webhook URL 发送）
//   slack      — Slack（Webhook 接收 + Webhook URL 发送）
//   wechat     — 个人微信桥接（Webhook 接收）
//   email      — 邮件（Webhook 接收邮件通知，如 Zapier/Make 转发）
//   whatsapp   — WhatsApp Business Cloud API（Webhook 接收 + Graph API 发送）
//   teams      — Microsoft Teams（Incoming Webhook 收发）
//   sms        — 短信（Twilio / 阿里云短信，Webhook 接收回执）
//   qq         — QQ 机器人（QQ 开放平台 Webhook）
//   wechat_oa  — 微信公众号（服务器配置验证 + 客服消息接口）
//
// 仅使用 Node.js 内置模块：http, https, crypto, url
// ============================================================

import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
// 飞书官方 SDK：用于 WebSocket 长连接模式（无需公网 URL）
import * as lark from '@larksuiteoapi/node-sdk';
// 企业微信智能机器人 SDK：用于 WebSocket 长连接模式
import AiBot, { generateReqId, type WsFrame, type TextMessage } from '@wecom/aibot-node-sdk';
// 配对管理器（ESM 必须在顶层 import，不能在函数内 require）
import { PairingManager } from '../../core/pairing-manager.js';
import { duanPath } from '../../core/duan-paths.js';

// ============================================================
// 类型定义
// ============================================================

/** 通道运行状态 */
export interface ChannelStatus {
  channelId: string;        // 通道标识（如 'telegram', 'wecom'）
  type: string;             // 通道类型
  running: boolean;         // 是否正在运行
  lastActivity?: string;    // 最后活动时间 ISO 字符串
  messageCount: number;     // 已处理消息数
  error?: string;           // 最近错误信息
}

/** 通道配置（与 ~/.duan/config.json 中 mobileChannels 格式一致） */
interface MobileChannel {
  type: string;
  config: Record<string, string>;
}

/** Agent 响应结果 */
interface AgentResponse {
  text: string;
  error?: string;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 读取 ~/.duan/config.json 中的通道配置
 * 兼容两种格式：
 *   1. 旧格式 mobileChannels: [{ type, config: { KEY: VALUE } }]
 *   2. 新格式 channels: { id: { enabled, type, appId, appSecret, ... } }（对标 OpenClaw）
 */
function loadMobileChannels(): MobileChannel[] {
  const configPath = duanPath('config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const result: MobileChannel[] = [];

      // 1. 旧格式：mobileChannels
      if (Array.isArray(raw.mobileChannels)) {
        result.push(...raw.mobileChannels);
      }

      // 2. 新格式：channels.*（对标 OpenClaw）
      if (raw.channels && typeof raw.channels === 'object') {
        const channelIds = Object.keys(raw.channels);
        console.info(`[RemoteBridge] 从配置文件读取到 ${channelIds.length} 个通道: ${channelIds.join(', ')}`);
        for (const [id, cfg] of Object.entries(raw.channels)) {
          const c = cfg as Record<string, unknown>;
          if (!c || typeof c !== 'object' || c.enabled === false) {
            console.info(`[RemoteBridge] 跳过通道 ${id} (enabled=false 或无效)`);
            continue;
          }
          const type = String(c.type || id);
          // 跳过已从 mobileChannels 加载的同类型通道
          if (result.some(m => m.type === type)) continue;
          // 将新格式的字段名转换为 FeishuChannel 等期望的 config 结构
          const config: Record<string, string> = {};
          for (const [k, v] of Object.entries(c)) {
            if (v === undefined || v === null) continue;
            if (typeof v === 'object') {
              // 数组和对象转为 JSON 字符串（如 allowFrom 数组、groups 对象）
              config[k] = JSON.stringify(v);
            } else {
              config[k] = String(v);
            }
          }
          // 调试日志：显示加载的配置（隐藏敏感字段）
          const debugKeys = Object.keys(config).filter(k =>
            !['appSecret', 'botToken', 'secret', 'token', 'apiKey'].includes(k)
          );
          const debugCfg = debugKeys.map(k => `${k}=${config[k]}`).join(', ');
          console.info(`[RemoteBridge] 加载通道 ${id} (type=${type}): ${debugCfg}`);
          result.push({ type, config });
        }
      } else {
        console.info('[RemoteBridge] 配置文件中未找到 channels 配置');
      }

      return result;
    } else {
      console.info(`[RemoteBridge] 配置文件不存在: ${configPath}`);
    }
  } catch (e) {
    console.error('[RemoteBridge] 读取配置失败:', (e as Error).message);
  }
  return [];
}

/**
 * 发起 HTTP/HTTPS 请求（基于 Node.js 内置模块）
 */
function httpRequest(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  } = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时: ${urlStr}`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * 统一授权拦截：检查用户是否有权使用机器人
 *
 * 授权流程（参考 OpenClaw 配对码机制）：
 * 1. 如果 dmPolicy === 'open'，直接放行
 * 2. 如果 dmPolicy === 'allowlist'，检查 allowFrom 列表
 * 3. 如果 dmPolicy === 'pairing'：
 *    a. 用户已配对 → 放行
 *    b. 用户输入的是配对码（6位数字）→ 验证并配对，返回"配对成功"提示
 *    c. 用户未配对且输入的不是配对码 → 返回配对引导提示
 * 4. 如果 dmPolicy === 'disabled'，拒绝
 *
 * @returns null=授权通过，string=拒绝原因（需回复给用户）
 */
function authorizeSender(
  channelType: string,
  userId: string,
  text: string,
  dmPolicy: string = 'pairing',
  allowFrom: string[] = [],
  displayName?: string,
): string | null {
  // 开放模式：任何人都能用
  if (dmPolicy === 'open') return null;

  // 禁用模式：拒绝所有人
  if (dmPolicy === 'disabled') return '机器人已禁用私聊功能';

  // 白名单模式
  if (dmPolicy === 'allowlist') {
    if (allowFrom.includes(userId) || allowFrom.includes('*')) return null;
    return '您不在白名单中，无法使用机器人';
  }

  // 配对模式（默认，参考 OpenClaw）
  if (dmPolicy === 'pairing') {
    const pairing = PairingManager.getInstance();

    // 已配对用户，直接放行
    if (pairing.isPaired(channelType, userId)) return null;

    // 检查是否输入了配对码（6位纯数字）
    const trimmed = text.trim();
    if (/^\d{6}$/.test(trimmed)) {
      // 验证配对码
      const ok = pairing.verifyAndPair(trimmed, channelType, userId, displayName);
      if (ok) {
        return '✅ 配对成功！现在您可以正常使用机器人了。';
      }
      return '❌ 配对码无效或已过期，请联系管理员获取新的配对码';
    }

    // 未配对用户，自动生成配对码并回复（参考 OpenClaw）
    // OpenClaw 流程：陌生用户发消息 → 机器人回复配对码 → 管理员批准
    const code = pairing.generateCode(`自动配对请求(${channelType}/${userId})`);
    return `🔒 您还未配对，无法使用机器人。\n\n您的配对码为: ${code}\n\n请联系管理员批准此配对码：\nduan pairing approve ${channelType} ${code}\n\n（配对码 5 分钟内有效）`;
  }

  // 未知策略，默认放行
  return null;
}

/**
 * 消息去重器 — 防止飞书/钉钉等平台重复推送同一事件
 * 基于 message_id 去重，自动清理 5 分钟前的记录
 */
class MessageDeduplicator {
  private seen: Map<string, number> = new Map();
  private readonly ttlMs = 5 * 60 * 1000; // 5 分钟

  /** 检查消息是否已处理过。true=重复消息应跳过，false=新消息 */
  isDuplicate(messageId: string): boolean {
    if (!messageId) return false;
    this.cleanup();
    return this.seen.has(messageId);
  }

  /** 标记消息已处理 */
  markProcessed(messageId: string): void {
    if (!messageId) return;
    this.seen.set(messageId, Date.now());
  }

  /** 清理过期记录 */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen.entries()) {
      if (now - ts > this.ttlMs) {
        this.seen.delete(id);
      }
    }
  }
}

/** 全局消息去重器实例 */
const deduplicator = new MessageDeduplicator();

/**
 * 会话历史管理器 — 为每个用户/群组维护独立的对话历史
 * 最多保留 20 条最近消息，避免内存无限增长
 */
class ConversationHistory {
  private histories: Map<string, Array<{ role: 'user' | 'assistant'; content: string }>> = new Map();
  private readonly maxHistory = 20;

  /** 获取会话历史 */
  get(conversationId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.histories.get(conversationId) || [];
  }

  /** 添加用户消息 */
  addUserMessage(conversationId: string, content: string): void {
    if (!this.histories.has(conversationId)) {
      this.histories.set(conversationId, []);
    }
    const hist = this.histories.get(conversationId)!;
    hist.push({ role: 'user', content });
    this.trim(conversationId, hist);
  }

  /** 添加助手回复 */
  addAssistantMessage(conversationId: string, content: string): void {
    const hist = this.histories.get(conversationId);
    if (hist) {
      hist.push({ role: 'assistant', content });
      this.trim(conversationId, hist);
    }
  }

  /** 清除会话历史 */
  clear(conversationId: string): void {
    this.histories.delete(conversationId);
  }

  /** 修剪历史记录，保留最近 maxHistory 条 */
  private trim(conversationId: string, hist: Array<{ role: 'user' | 'assistant'; content: string }>): void {
    if (hist.length > this.maxHistory) {
      hist.splice(0, hist.length - this.maxHistory);
    }
  }
}

/** 全局会话历史实例 */
const conversationHistory = new ConversationHistory();

/**
 * 调用 Agent 后端的 /api/chat/stream 端点，收集完整响应
 * 解析 SSE 流，提取思考过程、工具调用、工具结果和最终文本
 * 构建包含完整 Agent 推理链的回复，让用户能看到 Agent 的思考和行动
 * 带会话历史和失败重试
 */
async function callAgent(agentPort: number, message: string, userId: string): Promise<AgentResponse> {
  const conversationId = `bridge_${userId}`;
  const history = conversationHistory.get(conversationId);

  // 最多重试 2 次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `http://localhost:${agentPort}/api/chat/stream`;
      const body = JSON.stringify({
        message,
        conversationId,
        history,
      });

      const resp = await httpRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body,
        timeout: 180000, // Agent 可能需要较长时间（含工具调用）
      });

      // 解析 SSE 流，提取完整 Agent 推理链
      let fullText = '';
      const thinkParts: string[] = [];
      const toolParts: string[] = [];
      let hasError = false;
      let errorMsg = '';

      const lines = resp.body.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.substring(6).trim();
          if (data === '[DONE]') break;
          try {
            const event = JSON.parse(data);
            if (event.type === 'text' && event.content) {
              fullText += event.content;
            } else if (event.type === 'chunk' && event.content) {
              fullText += event.content;
            } else if (event.type === 'chunk' && event.chunk) {
              fullText += event.chunk;
            } else if (event.type === 'think' && event.content) {
              // 收集思考过程，让用户看到 Agent 在思考什么
              thinkParts.push(event.content);
            } else if (event.type === 'tool_call' && event.content) {
              // 收集工具调用，让用户看到 Agent 在做什么
              const toolName = event.toolName ? ` [${event.toolName}]` : '';
              toolParts.push(`🔧 ${event.content}${toolName}`);
            } else if (event.type === 'tool_result' && event.content) {
              // 工具结果：截断过长的结果
              const toolName = event.toolName ? ` [${event.toolName}]` : '';
              const resultPreview = event.content.length > 500
                ? event.content.substring(0, 500) + '...'
                : event.content;
              toolParts.push(`📋 结果${toolName}: ${resultPreview}`);
            } else if (event.type === 'error' && event.content) {
              hasError = true;
              errorMsg = event.content;
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }

      // 构建完整回复：思考过程 + 工具执行 + 最终文本
      let result = '';
      if (thinkParts.length > 0) {
        result += '💭 **思考过程:**\n' + thinkParts.join('\n') + '\n\n';
      }
      if (toolParts.length > 0) {
        result += '🔧 **执行操作:**\n' + toolParts.join('\n') + '\n\n';
      }
      if (fullText) {
        result += '📝 **回复:**\n' + fullText;
      }
      if (!result) {
        result = hasError ? `⚠️ Agent 处理出错: ${errorMsg}` : '（Agent 未返回内容，请检查 API Key 配置）';
      }

      // 保存会话历史（仅保存文本部分，避免历史过长）
      const historyText = fullText || result.substring(0, 2000);
      conversationHistory.addUserMessage(conversationId, message);
      conversationHistory.addAssistantMessage(conversationId, historyText);

      return { text: result, error: hasError ? errorMsg : undefined };
    } catch (e) {
      const err = e as Error;
      if (attempt === 0) {
        console.warn(`[RemoteBridge] Agent 调用失败，正在重试: ${err.message}`);
        // 等待 1 秒后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      console.error(`[RemoteBridge] Agent 调用重试后仍失败:`, err.message);
      return { text: '', error: err.message };
    }
  }
  return { text: '', error: 'Agent 调用失败' };
}

// ============================================================
// 通道实现
// ============================================================

// ---- Webhook 通道基类 ----

interface _WebhookHandler {
  /** 处理收到的 Webhook 请求，返回 HTTP 响应体 */
  handle(reqBody: unknown, res: unknown): Promise<void>;
}

// ---- SDK 客户端最小化类型（用于去除 any，保留结构化方法调用） ----

/** 企业微信 WSClient 最小化接口 */
interface WeComWsClient {
  on(event: string, handler: unknown): void;
  connect(): void;
  disconnect(): void;
  replyStream(...args: unknown[]): Promise<void>;
  replyWelcome(...args: unknown[]): Promise<void>;
}

/** 飞书 WSClient 最小化接口 */
interface FeishuWsClient {
  start(opts: unknown): Promise<void>;
  close?(): void;
  disconnect?(): void;
}

/** 通道实例公共接口（供 RemoteBridgeService 和路由使用） */
interface BridgeChannel {
  start(): Promise<void> | void;
  stop?(): void;
  getStatus(): ChannelStatus;
  handleMessage(body: unknown): Promise<unknown>;
  handleMessage(body: unknown): Promise<unknown>;
  // 修复：部分通道（WhatsApp/Teams/Sms/QQ/WeChatOA）使用 receiveMessage 接收回调
  receiveMessage?(body: unknown): Promise<unknown>;
  handleVerification?(body: Record<string, unknown>): unknown;
  verifyWebhook?(query: Record<string, unknown>): string | null;
  verifySignature?(query: Record<string, unknown>): string | null;
  verifySignature?(timestamp: string, body: string, signature: string): boolean;
  signingSecret?: string;
  agentPort: number;
}

// ---- 企业微信通道 ----

class WeComChannel {
  readonly channelId = 'wecom';
  private botId = '';
  private secret = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;
  private wsClient: WeComWsClient | null = null;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    // 支持 OpenClaw 配置格式：botId + secret
    this.botId = config.botId || config.WECOM_BOT_ID || '';
    this.secret = config.secret || config.wecomSecret || config.WECOM_SECRET || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'wecom', running: false, messageCount: 0 };
  }

  /**
   * 启动 WebSocket 长连接（参考 OpenClaw 企业微信配置方案）
   *
   * OpenClaw 企业微信配置流程：
   *   1. 企业微信客户端 → 工作台 → 智能机器人 → 创建机器人 → API 模式
   *   2. 选择"使用长连接"方式创建
   *   3. 获取 Bot ID 和 Secret
   *   4. 配置文件：{ channels: { wecom: { botId, secret, dmPolicy } } }
   *   5. 启动网关 → 自动建立 WebSocket 长连接
   */
  start(): void {
    if (!this.botId) {
      console.error('[WeCom] ❌ Bot ID 为空，无法启动。请运行 duan setup 配置企业微信通道');
      this.status.running = false;
      this.status.error = 'Bot ID 为空';
      return;
    }
    if (!this.secret) {
      console.error('[WeCom] ❌ Secret 为空，无法启动。请运行 duan setup 配置企业微信通道');
      this.status.running = false;
      this.status.error = 'Secret 为空';
      return;
    }

    console.info(`[WeCom] 配置检查: botId=${this.botId.substring(0, 8)}..., secret=***${this.secret.substring(this.secret.length - 4)}, dmPolicy=${this.dmPolicy}`);

    try {
      // 创建 WSClient 实例（企业微信智能机器人 SDK）
      this.wsClient = new AiBot.WSClient({
        botId: this.botId,
        secret: this.secret,
        maxReconnectAttempts: -1, // 无限重连
      }) as unknown as WeComWsClient;

      // 监听认证成功
      this.wsClient.on('authenticated', () => {
        console.info('[WeCom] ✅ 认证成功，WebSocket 长连接已建立');
      });

      // 监听连接建立
      this.wsClient.on('connected', () => {
        console.info('[WeCom] WebSocket 连接已建立，等待认证...');
      });

      // 监听文本消息
      this.wsClient.on('message.text', async (frame: WsFrame<TextMessage>) => {
        try {
          const body = frame.body;
          if (!body) return;

          const userMessage = body.text?.content || '';
          const userId = body.from?.userid || '';
          const _chatId = body.chatid || '';
          const chatType = body.chattype || 'single';
          const msgId = body.msgid || '';

          console.info(`[WeCom] 📩 收到消息: userId=${userId}, chatType=${chatType}, text=${userMessage.substring(0, 50)}`);

          // 消息去重
          if (msgId && deduplicator.isDuplicate(msgId)) {
            console.info(`[WeCom] 跳过重复消息: ${msgId}`);
            return;
          }
          if (msgId) deduplicator.markProcessed(msgId);

          this.status.messageCount++;
          this.status.lastActivity = new Date().toISOString();

          // 授权拦截（配对码机制）
          const denyReason = authorizeSender('wecom', userId, userMessage, this.dmPolicy, this.allowFrom);
          if (denyReason) {
            // 回复配对码提示
            const streamId = generateReqId('stream');
            await this.wsClient.replyStream(frame, streamId, denyReason, true).catch(() => {});
            return;
          }

          // 调用 Agent
          const agentResp = await callAgent(this.agentPort, userMessage, `wecom_${userId}`);

          // 流式回复
          const replyStreamId = generateReqId('stream');
          const replyText = agentResp.error
            ? '处理失败，请稍后重试'
            : agentResp.text.substring(0, 20480); // 企业微信限制 20480 字节

          await this.wsClient.replyStream(frame, replyStreamId, replyText, true).catch((err: Error) => {
            console.error('[WeCom] 回复消息失败:', err.message);
          });

          console.info(`[WeCom] ✅ 已回复消息给 ${userId}`);
        } catch (e) {
          console.error('[WeCom] 处理消息异常:', (e as Error).message);
        }
      });

      // 监听进入会话事件（发送欢迎语）
      this.wsClient.on('event.enter_chat', async (frame: Record<string, unknown>) => {
        try {
          const body = frame.body as { from?: { userid?: string } } | undefined;
          const userId = body?.from?.userid || '用户';
          console.info(`[WeCom] 用户进入会话: ${userId}`);
          // 发送欢迎语
          const welcomeBody = {
            msgtype: 'text' as const,
            text: { content: `你好！我是段先生智能助手，有什么可以帮你的吗？\n\n（如需配对，请发送配对码）` },
          };
          await this.wsClient.replyWelcome(frame, welcomeBody).catch(() => {});
        } catch (e) {
          console.error('[WeCom] 发送欢迎语失败:', (e as Error).message);
        }
      });

      // 监听连接断开
      this.wsClient.on('disconnected', (reason: string) => {
        console.info(`[WeCom] ⚠️ 连接断开: ${reason}，正在重连...`);
        this.status.running = false;
      });

      // 监听重连
      this.wsClient.on('reconnecting', (attempt: number) => {
        console.info(`[WeCom] 正在重连... (第 ${attempt} 次)`);
      });

      // 监听错误
      this.wsClient.on('error', (error: Error) => {
        console.error('[WeCom] ❌ WebSocket 错误:', error.message);
        if (error.message.includes('AUTH_FAILURE')) {
          console.error('[WeCom] 认证失败！请检查 Bot ID 和 Secret 是否正确');
        }
      });

      // 建立连接
      this.wsClient.connect();
      this.status.running = true;
      this.status.lastActivity = new Date().toISOString();
      console.info('[WeCom] 正在建立 WebSocket 长连接（企业微信智能机器人）...');
      console.info('[WeCom] ⚠️  如果发消息无反应，请检查企业微信配置：');
      console.info('[WeCom]    1. 企业微信客户端 → 工作台 → 智能机器人 → 确认已创建');
      console.info('[WeCom]    2. 创建时选择"API 模式" → "使用长连接"');
      console.info('[WeCom]    3. Bot ID 和 Secret 是否填写正确');
      console.info('[WeCom]    4. 机器人可见范围是否包含当前用户');
    } catch (e) {
      console.error('[WeCom] 启动失败:', (e as Error).message);
      this.status.running = false;
      this.status.error = (e as Error).message;
    }
  }

  stop(): void {
    if (this.wsClient) {
      try {
        this.wsClient.disconnect();
      } catch {}
      this.wsClient = null;
    }
    this.status.running = false;
    console.info('[WeCom] 通道已停止');
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }
}

// ---- 飞书通道 ----

class FeishuChannel {
  readonly channelId = 'feishu';
  private appId = '';
  private appSecret = '';
  private verificationToken = '';
  private encryptKey = '';
  private connectionMode: 'websocket' | 'webhook' = 'websocket';
  private domain: 'feishu' | 'lark' = 'feishu';
  private botName = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private requireMention: boolean = true; // 群聊中是否必须 @机器人才回复
  private agentPort: number;
  private status: ChannelStatus;
  private tenantAccessToken: string = '';
  private tokenExpiresAt: number = 0;
  // WebSocket 长连接客户端（websocket 模式）
  private wsClient: FeishuWsClient | null = null;
  // 飞书 API 客户端（用于发送消息）
  private larkClient: unknown = null;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;

    // 支持 OpenClaw 的 accounts.main 多账号配置结构
    // OpenClaw 格式: { accounts: { main: { appId, appSecret, botName } } }
    // 我们的格式: { appId, appSecret, botName }
    let accountCfg: Record<string, string> = {};
    if (config.accounts) {
      try {
        const accounts = typeof config.accounts === 'string' ? JSON.parse(config.accounts) : config.accounts;
        // 取第一个账号（通常是 main）
        const firstAccount = accounts.main || accounts.default || Object.values(accounts)[0];
        if (firstAccount && typeof firstAccount === 'object') {
          accountCfg = firstAccount;
        }
      } catch (e) {
        console.warn('[Feishu] 解析 accounts 配置失败:', (e as Error).message);
      }
    }

    // 合并配置：优先使用 accounts.main 中的字段，其次使用顶层字段
    const cfg = { ...config, ...accountCfg };
    this.appId = cfg.FEISHU_APP_ID || cfg.appId || '';
    this.appSecret = cfg.FEISHU_APP_SECRET || cfg.appSecret || '';
    this.verificationToken = cfg.FEISHU_VERIFICATION_TOKEN || cfg.verificationToken || '';
    this.encryptKey = cfg.FEISHU_ENCRYPT_KEY || cfg.encryptKey || '';
    this.connectionMode = (cfg.FEISHU_CONNECTION_MODE || cfg.connectionMode || 'websocket') as 'websocket' | 'webhook';
    this.domain = (cfg.FEISHU_DOMAIN || cfg.domain || 'feishu') as 'feishu' | 'lark';
    this.botName = cfg.FEISHU_BOT_NAME || cfg.botName || '';
    this.dmPolicy = cfg.dmPolicy || cfg.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = cfg.allowFrom || cfg.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.requireMention = cfg.requireMention !== 'false' && cfg.REQUIRE_MENTION !== 'false';
    this.status = { channelId: this.channelId, type: 'feishu', running: false, messageCount: 0 };

    // 启动时打印配置信息（隐藏敏感字段）
    console.info(`[Feishu] 配置加载: appId=${this.appId ? this.appId.substring(0, 12) + '...' : '未配置'}, mode=${this.connectionMode}, domain=${this.domain}, dmPolicy=${this.dmPolicy}`);
  }

  /** 获取飞书 API 基础 URL（根据域名配置） */
  private getApiBaseUrl(): string {
    return this.domain === 'lark'
      ? 'https://open.larksuite.com/open-apis'
      : 'https://open.feishu.cn/open-apis';
  }

  /** 获取 tenant_access_token（带缓存） */
  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantAccessToken;
    }
    const url = `${this.getApiBaseUrl()}/auth/v3/tenant_access_token/internal`;
    const resp = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });
    const data = JSON.parse(resp.body);
    if (!data.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败: ${data.msg || 'unknown'}`);
    }
    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire - 300) * 1000; // 提前5分钟过期
    return this.tenantAccessToken;
  }

  /** 解密飞书加密事件（如配置了 Encrypt Key） */
  private decryptEvent(encryptedData: string): string {
    if (!this.encryptKey) return encryptedData;
    try {
      const key = Buffer.from(this.encryptKey, 'base64');
      const iv = key.subarray(0, 16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(encryptedData, 'base64'), decipher.final()]);
      const pad = decrypted[decrypted.length - 1];
      const content = decrypted.subarray(0, decrypted.length - pad);
      return content.toString('utf-8');
    } catch (e) {
      console.error('[Feishu] 事件解密失败:', (e as Error).message);
      return encryptedData;
    }
  }

  /** 验证飞书事件订阅 URL（Webhook 模式） */
  handleVerification(body: Record<string, unknown>): unknown {
    if (body.challenge) {
      return {
        challenge: body.challenge,
        token: this.verificationToken || body.token,
      };
    }
    return null;
  }

  /** 处理飞书事件回调（Webhook 模式 + WebSocket 模式统一入口） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<void> {
    try {
      // 如果配置了 Encrypt Key，需先解密（Webhook 模式）
      let eventData = body;
      if (body.encrypt && this.encryptKey) {
        const decrypted = this.decryptEvent(body.encrypt);
        try {
          eventData = JSON.parse(decrypted);
        } catch {
          console.error('[Feishu] 解密后 JSON 解析失败');
          return;
        }
      }

      // 飞书事件格式：event.message.content
      const event = eventData.event as {
        type?: string;
        message?: {
          message_id?: string;
          msg_type?: string;
          message_type?: string;
          content?: string;
          chat_id?: string;
          chat_type?: string;
          mentions?: Array<Record<string, unknown>>;
        };
        sender?: {
          sender_id?: {
            user_id?: string;
            open_id?: string;
          };
        };
      } | undefined;
      if (!event || event.type !== 'message') return;

      // ===== 消息去重（防止 WebSocket 重连重复推送） =====
      const messageId = event.message?.message_id;
      if (messageId && deduplicator.isDuplicate(messageId)) {
        console.info(`[Feishu] 跳过重复消息: ${messageId}`);
        return;
      }
      if (messageId) deduplicator.markProcessed(messageId);

      // 兼容 Webhook（msg_type）和 WebSocket（message_type）两种字段名
      const msgType = event.message?.msg_type || event.message?.message_type;
      if (msgType !== 'text') return; // 仅处理文本消息

      const content = JSON.parse(event.message.content || '{}');
      let text = content.text || '';
      const userId = event.sender?.sender_id?.user_id || event.sender?.sender_id?.open_id || 'unknown';
      const chatId = event.message?.chat_id || '';
      const chatType = event.message?.chat_type || 'p2p'; // p2p=私聊, group=群聊

      // ===== 群聊 @提及处理 =====
      if (chatType === 'group') {
        // 检查是否 @了机器人
        const mentions = event.message?.mentions || [];
        const mentionedBot = mentions.some((m: Record<string, unknown>) => m.name === this.botName || (m.id as { open_id?: string })?.open_id === this.appId);
        if (!mentionedBot && this.requireMention) {
          return; // 群聊中未 @机器人，忽略
        }
        // 剥离 @机器人 文本（飞书文本中 @机器人 会显示为 @机器人名称）
        for (const m of mentions) {
          text = text.replace(`@${m.name || ''}`, '').trim();
        }
      }

      if (!text) return;

      console.info(`[Feishu] 收到消息: userId=${userId}, chatId=${chatId}, chatType=${chatType}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('feishu', userId, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        await this.sendReply(event.message?.message_id, chatId, userId, denyReason);
        return;
      }

      // 调用 Agent（带会话历史和重试）
      const agentResp = await callAgent(this.agentPort, text, `feishu_${userId}`);

      // 通过飞书 API 发送回复（包含完整的思考过程和工具执行）
      const replyText = agentResp.text.substring(0, 4000);
      await this.sendReply(event.message?.message_id, chatId, userId, replyText);
    } catch (e) {
      console.error('[Feishu] 处理消息异常:', (e as Error).message);
    }
  }

  /** 通过飞书 API 发送回复消息 */
  private async sendReply(messageId: string | undefined, chatId: string, userId: string, text: string): Promise<void> {
    if (!this.appId || !this.appSecret) {
      console.warn('[Feishu] 未配置 App ID / App Secret，跳过发送回复');
      return;
    }
    try {
      const token = await this.getTenantAccessToken();
      const url = `${this.getApiBaseUrl()}/im/v1/messages`;

      // 优先回复消息（reply），其次发新消息到聊天
      const sendUrl = messageId
        ? `${url}/${messageId}/reply`
        : `${url}?receive_id_type=chat_id`;

      const body = messageId
        ? { msg_type: 'text', content: JSON.stringify({ text }) }
        : { receive_id: chatId || userId, msg_type: 'text', content: JSON.stringify({ text }) };

      await httpRequest(sendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error('[Feishu] 发送回复失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  /**
   * 启动飞书通道
   * - websocket 模式：使用飞书 SDK 的 WSClient 建立长连接，无需公网 URL
   * - webhook 模式：仅标记就绪，等待飞书事件回调（需在开放平台配置回调 URL）
   */
  start(): void {
    if (!this.appId || !this.appSecret) {
      console.warn('[Feishu] 未配置 App ID / App Secret，跳过启动');
      return;
    }
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    const domainLabel = this.domain === 'lark' ? 'Lark' : '飞书';

    if (this.connectionMode === 'websocket') {
      // ===== WebSocket 长连接模式（推荐，无需公网 URL） =====
      this.startWebSocket(domainLabel);
    } else {
      // ===== Webhook 模式（需公网 HTTPS 回调） =====
      console.info(`[Feishu] 通道已就绪（${domainLabel}，Webhook 模式，等待事件回调）`);
      console.info(`[Feishu] 请在飞书开放平台配置事件订阅 URL: https://your-domain/api/bridge/webhook/feishu`);
    }
  }

  /** 启动 WebSocket 长连接（参考 OpenClaw 实现方式） */
  private startWebSocket(domainLabel: string): void {
    // 启动前验证配置
    if (!this.appId) {
      console.error('[Feishu] ❌ App ID 为空，无法启动 WebSocket。请运行 duan setup 重新配置飞书通道');
      this.status.running = false;
      this.status.error = 'App ID 为空';
      return;
    }
    if (!this.appSecret) {
      console.error('[Feishu] ❌ App Secret 为空，无法启动 WebSocket。请运行 duan setup 重新配置飞书通道');
      this.status.running = false;
      this.status.error = 'App Secret 为空';
      return;
    }
    console.info(`[Feishu] 配置检查: appId=${this.appId.substring(0, 10)}..., appSecret=***${this.appSecret.substring(this.appSecret.length - 4)}, mode=${this.connectionMode}, domain=${this.domain}, dmPolicy=${this.dmPolicy}`);

    try {
      // 1. 创建事件分发器，注册 im.message.receive_v1 事件
      // 官方 Node.js SDK 示例：
      //   eventDispatcher: new Lark.EventDispatcher({}).register({
      //     'im.message.receive_v1': async (data) => {
      //       const { message: { chat_id, content } } = data;
      //     }
      //   })
      // 注意：SDK 回调的 data 直接包含 message 和 sender，不是 data.event.message
      const eventDispatcher = new lark.EventDispatcher({}).register({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'im.message.receive_v1': async (data: Record<string, any>) => {
          console.info('[Feishu] 📩 收到消息事件！');
          console.info('[Feishu] 事件数据:', JSON.stringify(data).substring(0, 200));

          // SDK 回调的 data 直接包含 message 和 sender（不是 data.event.message）
          // 兼容两种数据结构
          const msg = data.message || data.event?.message || {};
          const sender = data.sender || data.event?.sender || {};

          await this.handleMessage({
            event: {
              type: 'message',
              message: {
                message_id: msg.message_id,
                chat_id: msg.chat_id,
                chat_type: msg.chat_type, // p2p 或 group（关键：群聊检测）
                message_type: msg.message_type,
                msg_type: msg.message_type, // 兼容字段
                content: msg.content,
                mentions: msg.mentions || [], // @提及列表（关键：群聊@剥离）
              },
              sender: {
                sender_id: sender.sender_id,
              },
            },
          });
        },
      });

      // 2. 创建 WSClient（eventDispatcher 在 start() 时传入）
      const sdkDomain = this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
      this.wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: sdkDomain,
        loggerLevel: lark.LoggerLevel.debug, // 使用 debug 级别，便于排查事件接收问题
      }) as unknown as FeishuWsClient;

      // 3. 启动长连接（传入 eventDispatcher）
      this.wsClient.start({ eventDispatcher }).then(() => {
        console.info(`[Feishu] ✅ WebSocket 长连接已建立（${domainLabel}，无需公网 URL）`);
        console.info(`[Feishu] 现在可以在飞书中 @机器人 发送消息进行对话`);
        console.info('');
        console.info('[Feishu] ⚠️  如果发消息无反应，请检查飞书开放平台配置：');
        console.info('[Feishu]    1. 事件与回调 → 事件配置 → 订阅方式 → 选择"使用长连接接收事件"');
        console.info('[Feishu]    2. 添加事件 → 搜索 im.message.receive_v1 → 勾选并开通权限');
        console.info('[Feishu]    3. 版本管理与发布 → 创建版本并发布应用');
        console.info('[Feishu]    4. 应用能力 → 机器人 → 确认已开启机器人能力');
        console.info('[Feishu]    详细文档: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case');
        console.info('');
      }).catch((err: Error) => {
        console.error(`[Feishu] ❌ WebSocket 连接失败: ${err.message}`);
        console.error(`[Feishu] 请检查：1) App ID/App Secret 是否正确 2) 应用是否已发布 3) 是否已订阅 im.message.receive_v1 事件`);
        this.status.running = false;
        this.status.error = err.message;
      });

      console.info(`[Feishu] 正在建立 WebSocket 长连接（${domainLabel}）...`);
    } catch (e) {
      console.error(`[Feishu] 启动 WebSocket 失败: ${(e as Error).message}`);
      this.status.running = false;
      this.status.error = (e as Error).message;
    }
  }

  stop(): void {
    this.status.running = false;
    this.tenantAccessToken = '';
    this.tokenExpiresAt = 0;
    // 关闭 WebSocket 连接
    if (this.wsClient) {
      try {
        if (typeof this.wsClient.close === 'function') {
          this.wsClient.close();
        } else if (typeof this.wsClient.disconnect === 'function') {
          this.wsClient.disconnect();
        }
      } catch {
        // 忽略关闭错误
      }
      this.wsClient = null;
    }
    console.info('[Feishu] 通道已停止');
  }
}

// ---- 钉钉通道 ----

class DingTalkChannel {
  readonly channelId = 'dingtalk';
  private webhookUrl = '';
  private secret = '';
  private appKey = '';
  private appSecret = '';
  private robotCode = '';
  private aesKey = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;
  private accessToken: string = '';
  private tokenExpiresAt: number = 0;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    // 兼容新格式（小驼峰，setup-wizard 保存）和旧格式（大写下划线）
    this.webhookUrl = config.webhookUrl || config.DINGTALK_WEBHOOK || '';
    this.secret = config.webhookSecret || config.DINGTALK_SECRET || '';
    this.appKey = config.appKey || config.DINGTALK_APP_KEY || '';
    this.appSecret = config.appSecretDing || config.appSecret || config.DINGTALK_APP_SECRET || '';
    this.robotCode = config.robotCode || config.DINGTALK_ROBOT_CODE || '';
    this.aesKey = config.aesKey || config.DINGTALK_AES_KEY || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'dingtalk', running: false, messageCount: 0 };
  }

  /** 处理钉钉 Outgoing Webhook 消息 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // ===== 消息去重 =====
      const msgId = String(body.msgId || body.uuid || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[DingTalk] 跳过重复消息: ${msgId}`);
        return { msgtype: 'empty' };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      // 修复：body 各字段为 unknown，断言为 string 以满足 authorizeSender/callAgent 调用
      const text = ((body.text as { content?: string })?.content) || (body.content as string) || '';
      const userId = (body.senderStaffId as string) || (body.senderId as string) || (body.senderNick as string) || 'unknown';

      if (!text) return { msgtype: 'empty' };

      console.info(`[DingTalk] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('dingtalk', userId, text, this.dmPolicy, this.allowFrom, body.senderNick as string);
      if (denyReason) {
        return {
          msgtype: 'text',
          text: { content: denyReason },
        };
      }

      // 调用 Agent
      const agentResp = await callAgent(this.agentPort, text, `dingtalk_${userId}`);

      const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 20000);

      // 钉钉 Outgoing 支持直接在响应体中返回消息
      return {
        msgtype: 'text',
        text: { content: replyText },
      };
    } catch (e) {
      console.error('[DingTalk] 处理消息异常:', (e as Error).message);
      return { msgtype: 'text', text: { content: '处理异常' } };
    }
  }

  /** 通过 Webhook 主动发送消息 */
  async sendMessage(text: string): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      let url = this.webhookUrl;
      // 如有 secret，生成签名
      if (this.secret) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${this.secret}`;
        const hmac = crypto.createHmac('sha256', this.secret);
        hmac.update(stringToSign);
        const sign = encodeURIComponent(hmac.digest('base64'));
        url += `&timestamp=${timestamp}&sign=${sign}`;
      }
      await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: text },
        }),
      });
    } catch (e) {
      console.error('[DingTalk] 发送消息失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[DingTalk] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[DingTalk] 通道已停止');
  }
}

// ---- Telegram 通道（HTTP 长轮询） ----

class TelegramChannel {
  readonly channelId = 'telegram';
  private token = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private pollInterval = 2000; // 2秒轮询
  private lastUpdateId = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.token = config.TELEGRAM_BOT_TOKEN || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'telegram', running: false, messageCount: 0 };
  }

  /** 启动长轮询 */
  start(): void {
    if (!this.token) {
      console.warn('[Telegram] 未配置 Bot Token，跳过启动');
      return;
    }
    this.running = true;
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[Telegram] 启动长轮询...');

    // 立即执行一次
    void this.poll();
    // 定时轮询
    this.timer = setInterval(() => void this.poll(), this.pollInterval);
  }

  /** 停止轮询 */
  stop(): void {
    this.running = false;
    this.status.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.info('[Telegram] 长轮询已停止');
  }

  /** 轮询 getUpdates */
  private async poll(): Promise<void> {
    if (!this.running || !this.token) return;

    try {
      const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30&allowed_updates=["message"]`;
      const resp = await httpRequest(url, { timeout: 35000 });

      if (resp.statusCode !== 200) {
        console.error(`[Telegram] getUpdates 返回状态码 ${resp.statusCode}`);
        return;
      }

      const data = JSON.parse(resp.body);
      if (!data.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        this.lastUpdateId = update.update_id;
        if (update.message?.text) {
          await this.handleMessage(update.message);
        }
      }
    } catch (e) {
      // 轮询错误不中断，仅记录
      if (this.running) {
        console.error('[Telegram] 轮询错误:', (e as Error).message);
      }
    }
  }

  /** 处理收到的消息 */
  private async handleMessage(msg: { message_id?: number; from?: { id: number; first_name?: string }; chat: { id: number }; text: string }): Promise<void> {
    // ===== 消息去重 =====
    const msgId = String(msg.message_id || '');
    if (msgId && deduplicator.isDuplicate(msgId)) {
      console.info(`[Telegram] 跳过重复消息: ${msgId}`);
      return;
    }
    if (msgId) deduplicator.markProcessed(msgId);

    const userId = String(msg.from?.id || msg.chat.id);
    const text = msg.text;

    console.info(`[Telegram] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
    this.status.messageCount++;
    this.status.lastActivity = new Date().toISOString();

    // ===== 授权拦截（配对码机制） =====
    const denyReason = authorizeSender('telegram', userId, text, this.dmPolicy, this.allowFrom, msg.from?.first_name);
    if (denyReason) {
      await this.sendMessage(msg.chat.id, denyReason);
      return;
    }

    // 调用 Agent
    const agentResp = await callAgent(this.agentPort, text, `telegram_${userId}`);

    // 发送回复
    const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 4096); // Telegram 单条消息限制
    await this.sendMessage(msg.chat.id, replyText);
  }

  /** 发送消息到 Telegram */
  private async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
        }),
      });
    } catch (e) {
      console.error('[Telegram] 发送消息失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }
}

// ---- Discord 通道（Webhook 接收 + Webhook URL 发送） ----

class DiscordChannel {
  readonly channelId = 'discord';
  private webhookUrl = '';
  private botToken = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.botToken = config.DISCORD_BOT_TOKEN || '';
    this.webhookUrl = config.DISCORD_WEBHOOK_URL || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'discord', running: false, messageCount: 0 };
  }

  /** 处理通过 Webhook 接收的 Discord 消息 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // ===== 消息去重 =====
      const msgId = String(body.id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[Discord] 跳过重复消息: ${msgId}`);
        return { type: 6 };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      // 修复：body.content/body.author 为 unknown，断言为具体结构
      const text = (body.content as string) || '';
      const author = body.author as { id?: string; username?: string; bot?: boolean; global_name?: string } | undefined;
      const userId = author?.id || author?.username || 'unknown';

      if (!text) return { type: 6 }; // ACK

      // 忽略 Bot 自己的消息，防止循环
      if (author?.bot) return { type: 6 };

      console.info(`[Discord] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('discord', userId, text, this.dmPolicy, this.allowFrom, body.author?.global_name || body.author?.username);
      if (denyReason) {
        // 尝试通过 webhook 发送拒绝消息
        if (this.webhookUrl) {
          try {
            await httpRequest(this.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: denyReason }),
            });
          } catch (e) {
            console.error('[Discord] 发送拒绝消息失败:', (e as Error).message);
          }
        }
        // 无论是否有 webhookUrl，都在响应体中返回拒绝消息
        return { type: 4, data: { content: denyReason } };
      }

      // 调用 Agent
      const agentResp = await callAgent(this.agentPort, text, `discord_${userId}`);

      // 通过 Webhook URL 发送回复
      if (this.webhookUrl) {
        const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 2000);
        await httpRequest(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: replyText,
          }),
        });
      }

      return { type: 6 }; // Discord Interaction 回复类型：ACK
    } catch (e) {
      console.error('[Discord] 处理消息异常:', (e as Error).message);
      return { type: 6 };
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[Discord] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[Discord] 通道已停止');
  }
}

// ---- Slack 通道（Webhook 接收 + Webhook URL 发送） ----

class SlackChannel {
  readonly channelId = 'slack';
  private botToken = '';
  private signingSecret = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.botToken = config.SLACK_BOT_TOKEN || '';
    this.signingSecret = config.SLACK_SIGNING_SECRET || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'slack', running: false, messageCount: 0 };
  }

  /** 验证 Slack 请求签名 */
  verifySignature(timestamp: string, body: string, signature: string): boolean {
    // P1 修复：未配置签名密钥时拒绝请求（而非跳过验证），防止伪造请求
    if (!this.signingSecret) return false;
    const sigBase = `v0:${timestamp}:${body}`;
    const hash = 'v0=' + crypto.createHmac('sha256', this.signingSecret).update(sigBase).digest('hex');
    // P1 修复：检查 Buffer 长度一致后再比较，避免 timingSafeEqual 抛出 RangeError
    const hashBuf = Buffer.from(hash);
    const sigBuf = Buffer.from(signature);
    if (hashBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, sigBuf);
  }

  /** 处理 Slack 事件回调 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // URL 验证
      if (body.challenge) {
        return { challenge: body.challenge };
      }

      // ===== 消息去重（Slack 事件会重试推送） =====
      const msgId = String(body.event_id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[Slack] 跳过重复消息: ${msgId}`);
        return {};
      }
      if (msgId) deduplicator.markProcessed(msgId);

      // 事件回调
      const event = body.event;
      if (!event || event.type !== 'message') return {};
      if (event.bot_id) return {}; // 忽略 Bot 消息

      const text = event.text || '';
      const userId = event.user || 'unknown';

      if (!text) return {};

      console.info(`[Slack] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('slack', userId, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        console.info(`[Slack] 授权拒绝: ${denyReason}`);
        if (this.botToken && event.channel) {
          try {
            await httpRequest('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel: event.channel, text: denyReason }),
            });
          } catch (e) {
            console.error('[Slack] 发送拒绝消息失败:', (e as Error).message);
          }
        }
        return { ok: true, denied: true, reply: denyReason };
      }

      // 调用 Agent
      const agentResp = await callAgent(this.agentPort, text, `slack_${userId}`);

      // 通过 chat.postMessage 发送回复
      if (this.botToken && event.channel) {
        const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 40000);
        await httpRequest('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.botToken}`,
          },
          body: JSON.stringify({
            channel: event.channel,
            text: replyText,
          }),
        });
      }

      return {};
    } catch (e) {
      console.error('[Slack] 处理消息异常:', (e as Error).message);
      return {};
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[Slack] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[Slack] 通道已停止');
  }
}

// ---- 个人微信桥接通道 ----

class WeChatBridgeChannel {
  readonly channelId = 'wechat';
  private botUrl = '';
  private apiKey = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    // 兼容新格式（小驼峰，setup-wizard 保存）和旧格式（大写下划线）
    this.botUrl = config.apiUrl || config.WECHAT_BOT_URL || config.WECHAT_API_URL || '';
    this.apiKey = config.apiKey || config.WECHAT_API_KEY || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'wechat', running: false, messageCount: 0 };
  }

  /** 处理微信桥接消息 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // ===== 消息去重 =====
      const msgId = String(body.msgId || body.messageId || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[WeChat] 跳过重复消息: ${msgId}`);
        return { success: true };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      const text = body.content || body.text || body.message || '';
      const userId = body.from || body.userId || body.sender || 'unknown';

      if (!text) return { success: true };

      console.info(`[WeChat] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('wechat', userId, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        if (this.botUrl) {
          await httpRequest(`${this.botUrl}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: userId,
              content: denyReason,
            }),
          }).catch(() => {});
        }
        return { success: true, reply: denyReason };
      }

      // 调用 Agent
      const agentResp = await callAgent(this.agentPort, text, `wechat_${userId}`);

      // 如果配置了 botUrl，通过桥接服务发送回复
      if (this.botUrl) {
        const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text;
        await httpRequest(`${this.botUrl}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: userId,
            content: replyText,
          }),
        }).catch(() => {});
      }

      return { success: true, reply: agentResp.text };
    } catch (e) {
      console.error('[WeChat] 处理消息异常:', (e as Error).message);
      return { success: false, error: (e as Error).message };
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[WeChat] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[WeChat] 通道已停止');
  }
}

// ---- 通用 Webhook 通道 ----

class GenericWebhookChannel {
  readonly channelId = 'webhook';
  private targetUrl = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.targetUrl = config.WEBHOOK_URL || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'webhook', running: false, messageCount: 0 };
  }

  /** 处理通用 Webhook 消息 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // ===== 消息去重 =====
      const msgId = String(body.msgId || body.messageId || body.id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[Webhook] 跳过重复消息: ${msgId}`);
        return { success: true, message: '重复消息已忽略' };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      const text = body.text || body.content || body.message || '';
      const userId = body.userId || body.from || body.sender || 'unknown';

      if (!text) return { success: true, message: '空消息已忽略' };

      console.info(`[Webhook] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('webhook', userId, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        console.info(`[Webhook] 授权拒绝: ${denyReason}`);
        // 尝试通过 targetUrl 推送拒绝消息
        if (this.targetUrl) {
          try {
            await httpRequest(this.targetUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: denyReason, type: 'reply' }),
            });
          } catch (e) {
            console.error('[Webhook] 推送拒绝消息失败:', (e as Error).message);
          }
        }
        return { success: false, reply: denyReason, denied: true };
      }

      // 调用 Agent
      const agentResp = await callAgent(this.agentPort, text, `webhook_${userId}`);

      // 如果配置了目标 URL，转发回复
      if (this.targetUrl) {
        await httpRequest(this.targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: agentResp.text,
            userId,
            error: agentResp.error,
          }),
        }).catch(() => {});
      }

      return { success: true, reply: agentResp.text };
    } catch (e) {
      console.error('[Webhook] 处理消息异常:', (e as Error).message);
      return { success: false, error: (e as Error).message };
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[Webhook] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[Webhook] 通道已停止');
  }
}

// ---- 邮件通道（Webhook 接收邮件通知） ----

class EmailChannel {
  readonly channelId = 'email';
  private smtpHost = '';
  private smtpPort = '';
  private smtpUser = '';
  private smtpPass = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.smtpHost = config.SMTP_HOST || '';
    this.smtpPort = config.SMTP_PORT || '587';
    this.smtpUser = config.SMTP_USER || '';
    this.smtpPass = config.SMTP_PASS || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'email', running: false, messageCount: 0 };
  }

  /** 处理通过 Webhook 接收的邮件通知（如 Zapier/Make 转发） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // ===== 消息去重 =====
      const msgId = String(body.messageId || body.id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[Email] 跳过重复消息: ${msgId}`);
        return { success: true };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      const subject = body.subject || '';
      const from = body.from || body.sender || 'unknown';
      const text = body.text || body.body || body.content || subject;

      if (!text) return { success: true };

      console.info(`[Email] 收到邮件: from=${from}, subject=${subject.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('email', from, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        console.info(`[Email] 拒绝消息（来自 ${from}）: ${denyReason}`);
        return { success: true, reply: denyReason, denied: true };
      }

      // 构造消息：包含邮件上下文
      const fullMessage = `[邮件] 发件人: ${from}\n主题: ${subject}\n内容: ${text}`;

      // 调用 Agent
      const agentResp = await callAgent(this.agentPort, fullMessage, `email_${from}`);

      return { success: true, reply: agentResp.text };
    } catch (e) {
      console.error('[Email] 处理消息异常:', (e as Error).message);
      return { success: false, error: (e as Error).message };
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[Email] 通道已就绪（Webhook 模式，等待邮件通知回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[Email] 通道已停止');
  }
}

// ---- WhatsApp 通道（Cloud API） ----

class WhatsAppChannel {
  readonly channelId = 'whatsapp';
  private phoneNumberId = '';
  private accessToken = '';
  private verifyToken = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID || '';
    this.accessToken = config.WHATSAPP_ACCESS_TOKEN || '';
    this.verifyToken = config.WHATSAPP_VERIFY_TOKEN || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'whatsapp', running: false, messageCount: 0 };
  }

  /** Webhook 订阅验证（GET 请求） */
  verifyWebhook(query: Record<string, string>): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && token === this.verifyToken && challenge) {
      return challenge;
    }
    return null;
  }

  /** 处理 WhatsApp Webhook 回调 */
  async receiveMessage(body: Record<string, unknown>): Promise<{ success: boolean }> {
    try {
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      if (!message) return { success: true }; // 非消息事件（如状态更新）

      // ===== 消息去重 =====
      const msgId = String(message.id || message.message_id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[WhatsApp] 跳过重复消息: ${msgId}`);
        return { success: true };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      const text = message.text?.body || '';
      const userId = message.from || 'unknown';
      if (!text) return { success: true };

      console.info(`[WhatsApp] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('whatsapp', userId, text, this.dmPolicy, this.allowFrom, change?.value?.contacts?.[0]?.profile?.name);
      if (denyReason) {
        await this.sendMessage(userId, denyReason);
        return { success: true };
      }

      const agentResp = await callAgent(this.agentPort, text, `whatsapp_${userId}`);
      const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 4096);
      await this.sendMessage(userId, replyText);

      return { success: true };
    } catch (e) {
      console.error('[WhatsApp] 处理消息异常:', (e as Error).message);
      return { success: false };
    }
  }

  /** 通过 WhatsApp Cloud API 发送消息 */
  async sendMessage(to: string, content: string): Promise<void> {
    if (!this.phoneNumberId || !this.accessToken) {
      console.warn('[WhatsApp] 未配置 Phone Number ID 或 Access Token，跳过发送');
      return;
    }
    try {
      const url = `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`;
      await httpRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: content },
        }),
      });
    } catch (e) {
      console.error('[WhatsApp] 发送消息失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.phoneNumberId || !this.accessToken) {
      console.warn('[WhatsApp] 未配置 Phone Number ID / Access Token，跳过启动');
      return;
    }
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[WhatsApp] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[WhatsApp] 通道已停止');
  }
}

// ---- Microsoft Teams 通道（Incoming Webhook） ----

class TeamsChannel {
  readonly channelId = 'teams';
  private webhookUrl = '';
  private botToken = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.webhookUrl = config.TEAMS_WEBHOOK_URL || '';
    this.botToken = config.TEAMS_BOT_TOKEN || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'teams', running: false, messageCount: 0 };
  }

  /** 处理 Teams Bot Framework 回调 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async receiveMessage(body: Record<string, any>): Promise<unknown> {
    try {
      const activity = body;
      if (activity.type !== 'message') return { status: 'ignored' };

      // ===== 消息去重 =====
      const msgId = String(activity.id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[Teams] 跳过重复消息: ${msgId}`);
        return { status: 'ignored' };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      // 修复：activity.text/activity.from 为 unknown，断言为具体结构
      const text = (activity.text as string) || '';
      const from = activity.from as { id?: string; name?: string } | undefined;
      const userId = from?.id || from?.name || 'unknown';
      if (!text) return { status: 'ignored' };

      console.info(`[Teams] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('teams', userId, text, this.dmPolicy, this.allowFrom, from?.name);
      if (denyReason) {
        await this.sendMessage(denyReason);
        return { status: 'ok' };
      }

      const agentResp = await callAgent(this.agentPort, text, `teams_${userId}`);
      const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 4096);

      // 通过 Incoming Webhook 发送回复
      await this.sendMessage(replyText);

      return { status: 'ok' };
    } catch (e) {
      console.error('[Teams] 处理消息异常:', (e as Error).message);
      return { status: 'error', error: (e as Error).message };
    }
  }

  /** 通过 Incoming Webhook 发送消息 */
  async sendMessage(to: string, content?: string): Promise<void> {
    // 兼容两种调用方式：sendMessage(text) 和 sendMessage(to, content)
    const text = content !== undefined ? content : to;
    if (!this.webhookUrl) {
      console.warn('[Teams] 未配置 Webhook URL，跳过发送');
      return;
    }
    try {
      await httpRequest(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
        }),
      });
    } catch (e) {
      console.error('[Teams] 发送消息失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.webhookUrl) {
      console.warn('[Teams] 未配置 Webhook URL，跳过启动');
      return;
    }
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[Teams] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[Teams] 通道已停止');
  }
}

// ---- SMS 短信通道（Twilio / 阿里云） ----

class SmsChannel {
  readonly channelId = 'sms';
  private provider = 'twilio';
  private accountSid = '';
  private authToken = '';
  private fromNumber = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.provider = config.SMS_PROVIDER || 'twilio';
    this.accountSid = config.TWILIO_ACCOUNT_SID || config.ALIYUN_SMS_ACCESS_KEY || '';
    this.authToken = config.TWILIO_AUTH_TOKEN || config.ALIYUN_SMS_SECRET || '';
    this.fromNumber = config.TWILIO_FROM_NUMBER || config.ALIYUN_SMS_SIGN_NAME || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'sms', running: false, messageCount: 0 };
  }

  /** 处理短信回执 Webhook（Twilio / 阿里云回执） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async receiveMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // ===== 消息去重 =====
      const msgId = String(body.MessageSid || body.messageId || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[SMS] 跳过重复消息: ${msgId}`);
        return { success: true };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      // Twilio 回执格式
      const text = body.Body || body.Message || body.content || '';
      const from = body.From || body.from || body.sender || 'unknown';
      if (!text) return { success: true };

      console.info(`[SMS/${this.provider}] 收到消息: from=${from}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('sms', from, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        await this.sendMessage(from, denyReason);
        if (this.provider === 'twilio') {
          return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
        }
        return { success: true };
      }

      const agentResp = await callAgent(this.agentPort, text, `sms_${from}`);
      const replyText = agentResp.error ? '处理失败' : agentResp.text.substring(0, 1000);
      await this.sendMessage(from, replyText);

      // Twilio 期望返回 TwiML
      if (this.provider === 'twilio') {
        return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
      }
      return { success: true };
    } catch (e) {
      console.error(`[SMS/${this.provider}] 处理消息异常:`, (e as Error).message);
      return { success: false, error: (e as Error).message };
    }
  }

  /** 发送短信 */
  async sendMessage(to: string, content: string): Promise<void> {
    if (!this.accountSid || !this.authToken) {
      console.warn('[SMS] 未配置凭证，跳过发送');
      return;
    }
    try {
      if (this.provider === 'twilio') {
        await this.sendViaTwilio(to, content);
      } else if (this.provider === 'aliyun') {
        await this.sendViaAliyun(to, content);
      } else {
        console.warn(`[SMS] 不支持的服务商: ${this.provider}`);
      }
    } catch (e) {
      console.error(`[SMS/${this.provider}] 发送失败:`, (e as Error).message);
    }
  }

  /** Twilio 发送 */
  private async sendViaTwilio(to: string, content: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const formBody = new URLSearchParams({
      To: to,
      From: this.fromNumber,
      Body: content,
    }).toString();
    await httpRequest(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    });
  }

  /** 阿里云短信发送（简化实现，使用短信 API） */
  private async sendViaAliyun(to: string, content: string): Promise<void> {
    // 阿里云短信需签名，这里简化为通过 HTTP 调用中转服务
    // 实际生产应使用 @alicloud/dysmsapi20170525 SDK
    const url = 'https://dysmsapi.aliyuncs.com/';
    const params = new URLSearchParams({
      PhoneNumbers: to,
      SignName: this.fromNumber,
      TemplateParam: JSON.stringify({ content }),
      Action: 'SendSms',
      Version: '2017-05-25',
      AccessKeyId: this.accountSid,
    });
    console.warn('[SMS/aliyun] 阿里云短信需配合 SDK 签名，此处仅记录请求参数');
    await httpRequest(url + '?' + params.toString(), { method: 'GET' }).catch(() => {
      // 预期失败（缺签名），仅作占位实现
    });
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.accountSid) {
      console.warn('[SMS] 未配置凭证，跳过启动');
      return;
    }
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info(`[SMS] 通道已就绪（provider=${this.provider}，Webhook 模式）`);
  }

  stop(): void {
    this.status.running = false;
    console.info('[SMS] 通道已停止');
  }
}

// ---- QQ 机器人通道 ----

class QQChannel {
  readonly channelId = 'qq';
  private botToken = '';
  private webhookUrl = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    this.botToken = config.QQ_BOT_TOKEN || '';
    this.webhookUrl = config.QQ_WEBHOOK_URL || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'qq', running: false, messageCount: 0 };
  }

  /** 处理 QQ Bot Webhook 回调 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async receiveMessage(body: Record<string, any>): Promise<unknown> {
    try {
      // QQ 开放平台事件格式
      const eventType = body.t || body.event_type;
      if (eventType !== 'GROUP_AT_MESSAGE_CREATE' && eventType !== 'C2C_MESSAGE_CREATE' && eventType !== 'AT_MESSAGE_CREATE') {
        return { success: true }; // 忽略非消息事件
      }

      // 修复：body.d/body.data 为 unknown，断言为含消息字段的结构
      const data = (body.d || body.data || {}) as { id?: string; message_id?: string; content?: string; user_openid?: string; author?: { id?: string; member_openid?: string } };

      // ===== 消息去重 =====
      const msgId = String(data.id || data.message_id || '');
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[QQ] 跳过重复消息: ${msgId}`);
        return { success: true };
      }
      if (msgId) deduplicator.markProcessed(msgId);

      let text = data.content || '';
      // 剥离 @机器人 文本
      text = text.replace(/@[^@\s]+\s?/g, '').trim();
      const userId = data.author?.id || data.author?.member_openid || data.user_openid || 'unknown';
      if (!text) return { success: true };

      console.info(`[QQ] 收到消息: userId=${userId}, text=${text.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('qq', userId, text, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        const msgId = data.id || data.message_id;
        await this.sendMessage(userId, denyReason, msgId);
        return { success: true };
      }

      const agentResp = await callAgent(this.agentPort, text, `qq_${userId}`);
      const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 2000);

      // 主动回复消息
      if (msgId) {
        await this.sendMessage(userId, replyText, msgId);
      }

      return { success: true };
    } catch (e) {
      console.error('[QQ] 处理消息异常:', (e as Error).message);
      return { success: false, error: (e as Error).message };
    }
  }

  /** 通过 QQ Bot API 发送消息 */
  async sendMessage(to: string, content: string, msgId?: string): Promise<void> {
    if (!this.botToken) {
      console.warn('[QQ] 未配置 Bot Token，跳过发送');
      return;
    }
    try {
      // 通过 Webhook URL（QQ 开放平台回调地址）回传
      if (this.webhookUrl) {
        await httpRequest(this.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `QQBot ${this.botToken}`,
          },
          body: JSON.stringify({
            content,
            msg_id: msgId,
            to,
          }),
        });
      }
    } catch (e) {
      console.error('[QQ] 发送消息失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.botToken) {
      console.warn('[QQ] 未配置 Bot Token，跳过启动');
      return;
    }
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[QQ] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[QQ] 通道已停止');
  }
}

// ---- 微信公众号通道 ----

class WeChatOAChannel {
  readonly channelId = 'wechat_oa';
  private appId = '';
  private appSecret = '';
  private token = '';
  private encodingAesKey = '';
  private dmPolicy: string = 'pairing';
  private allowFrom: string[] = [];
  private agentPort: number;
  private status: ChannelStatus;
  private accessTokenCache: { token: string; expiresAt: number } | null = null;

  constructor(config: Record<string, string>, agentPort: number) {
    this.agentPort = agentPort;
    // 兼容新格式（小驼峰，setup-wizard 保存）和旧格式（大写下划线）
    this.appId = config.appId || config.WECHAT_OA_APP_ID || '';
    this.appSecret = config.appSecret || config.WECHAT_OA_APP_SECRET || '';
    this.token = config.verificationToken || config.WECHAT_OA_TOKEN || '';
    this.encodingAesKey = config.encodingAESKey || config.WECHAT_OA_ENCODING_AES_KEY || '';
    this.dmPolicy = config.dmPolicy || config.DM_POLICY || 'pairing';
    this.allowFrom = (() => {
      const raw = config.allowFrom || config.ALLOW_FROM || '';
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return raw.split(',').map((s: string) => s.trim()).filter(Boolean); }
    })();
    this.status = { channelId: this.channelId, type: 'wechat_oa', running: false, messageCount: 0 };
  }

  /** 公众号服务器配置验证（GET 请求） */
  verifySignature(query: Record<string, string>): string | null {
    const { signature, timestamp, nonce, echostr } = query;
    if (!echostr) return null;
    if (!this.token) return echostr; // 未配置 token 时直接返回
    const arr = [this.token, timestamp, nonce].sort();
    const sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
    return sha1 === signature ? echostr : null;
  }

  /** 处理公众号消息回调（XML 格式） */
  async receiveMessage(xmlBody: string): Promise<string> {
    try {
      const contentMatch = xmlBody.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
      const fromUserMatch = xmlBody.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/);
      const toUserMatch = xmlBody.match(/<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/);

      if (!contentMatch || !fromUserMatch) {
        return 'success'; // 非文本消息，直接返回成功
      }

      const userMessage = contentMatch[1];
      const userId = fromUserMatch[1];
      const toUser = toUserMatch ? toUserMatch[1] : '';

      // ===== 消息去重 =====
      const msgIdMatch = xmlBody.match(/<MsgId>(.*?)<\/MsgId>/);
      const msgId = msgIdMatch ? msgIdMatch[1] : '';
      if (msgId && deduplicator.isDuplicate(msgId)) {
        console.info(`[WeChatOA] 跳过重复消息: ${msgId}`);
        return 'success';
      }
      if (msgId) deduplicator.markProcessed(msgId);

      console.info(`[WeChatOA] 收到消息: userId=${userId}, text=${userMessage.substring(0, 50)}`);
      this.status.messageCount++;
      this.status.lastActivity = new Date().toISOString();

      // ===== 授权拦截（配对码机制） =====
      const denyReason = authorizeSender('wechat_oa', userId, userMessage, this.dmPolicy, this.allowFrom);
      if (denyReason) {
        const createTime = Math.floor(Date.now() / 1000);
        return `<xml>
<ToUserName><![CDATA[${userId}]]></ToUserName>
<FromUserName><![CDATA[${toUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${denyReason}]]></Content>
</xml>`;
      }

      const agentResp = await callAgent(this.agentPort, userMessage, `wechat_oa_${userId}`);
      const replyText = agentResp.error ? '处理失败，请稍后重试' : agentResp.text.substring(0, 2048);

      // 被动回复 XML
      const createTime = Math.floor(Date.now() / 1000);
      return `<xml>
<ToUserName><![CDATA[${userId}]]></ToUserName>
<FromUserName><![CDATA[${toUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${replyText}]]></Content>
</xml>`;
    } catch (e) {
      console.error('[WeChatOA] 处理消息异常:', (e as Error).message);
      return 'success';
    }
  }

  /** 获取 access_token（带缓存） */
  private async getAccessToken(): Promise<string> {
    if (this.accessTokenCache && Date.now() < this.accessTokenCache.expiresAt) {
      return this.accessTokenCache.token;
    }
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`;
    const resp = await httpRequest(url);
    const data = JSON.parse(resp.body);
    if (!data.access_token) {
      throw new Error(`获取 access_token 失败: ${data.errmsg || 'unknown'}`);
    }
    this.accessTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 300) * 1000, // 提前5分钟过期
    };
    return data.access_token;
  }

  /** 通过公众号客服消息接口主动发送消息 */
  async sendMessage(to: string, content: string): Promise<void> {
    if (!this.appId || !this.appSecret) {
      console.warn('[WeChatOA] 未配置 AppID / AppSecret，跳过发送');
      return;
    }
    try {
      const accessToken = await this.getAccessToken();
      const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;
      await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: to,
          msgtype: 'text',
          text: { content },
        }),
      });
    } catch (e) {
      console.error('[WeChatOA] 发送消息失败:', (e as Error).message);
    }
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.appId || !this.appSecret) {
      console.warn('[WeChatOA] 未配置 AppID / AppSecret，跳过启动');
      return;
    }
    this.status.running = true;
    this.status.lastActivity = new Date().toISOString();
    console.info('[WeChatOA] 通道已就绪（Webhook 模式，等待回调）');
  }

  stop(): void {
    this.status.running = false;
    console.info('[WeChatOA] 通道已停止');
  }
}

// ============================================================
// RemoteBridgeService 主服务
// ============================================================

export class RemoteBridgeService {
  private agentPort: number;
  private channels: Map<string, {
    instance: unknown;
    type: string;
  }> = new Map();
  private started = false;

  constructor(agentPort: number) {
    this.agentPort = agentPort;
  }

  /** 动态更新 Agent 端口（当端口被占用自动切换时调用） */
  setAgentPort(port: number): void {
    if (this.agentPort === port) return;
    this.agentPort = port;
    // 更新所有已创建通道实例的 agentPort
    for (const { instance } of this.channels.values()) {
      if (instance && typeof instance === 'object' && 'agentPort' in instance) {
        (instance as { agentPort: number }).agentPort = port;
      }
    }
    console.info(`[RemoteBridge] Agent 端口已更新为 ${port}`);
  }

  /** 启动所有已配置的通道 Bot */
  start(): Promise<void> {
    if (this.started) {
      console.info('[RemoteBridge] 服务已在运行中');
      return Promise.resolve();
    }

    const mobileChannels = loadMobileChannels();
    if (mobileChannels.length === 0) {
      console.info('[RemoteBridge] 未配置任何移动通道，跳过启动');
      return Promise.resolve();
    }

    console.info(`[RemoteBridge] 发现 ${mobileChannels.length} 个已配置通道，正在启动...`);

    for (const ch of mobileChannels) {
      try {
        const instance = this.createChannelInstance(ch) as BridgeChannel;
        if (instance) {
          this.channels.set(ch.type, { instance, type: ch.type });
          void instance.start();
          console.info(`[RemoteBridge] ✅ 通道 ${ch.type} 已启动`);
        }
      } catch (e) {
        console.error(`[RemoteBridge] ❌ 通道 ${ch.type} 启动失败:`, (e as Error).message);
      }
    }

    this.started = true;
    console.info(`[RemoteBridge] 服务启动完成，${this.channels.size} 个通道运行中`);
    return Promise.resolve();
  }

  /** 停止所有通道 Bot */
  stop(): Promise<void> {
    if (!this.started) return Promise.resolve();

    this.channels.forEach(({ instance }, id) => {
      try {
        const ch = instance as BridgeChannel;
        ch.stop?.();
      } catch (e) {
        console.error(`[RemoteBridge] 停止通道 ${id} 失败:`, (e as Error).message);
      }
    });
    this.channels.clear();
    this.started = false;
    console.info('[RemoteBridge] 服务已停止');
    return Promise.resolve();
  }

  /** 获取所有通道状态 */
  getStatus(): ChannelStatus[] {
    const statuses: ChannelStatus[] = [];
    this.channels.forEach(({ instance }) => {
      const ch = instance as BridgeChannel;
      if (typeof ch.getStatus === 'function') {
        statuses.push(ch.getStatus());
      }
    });
    return statuses;
  }

  /** 获取指定通道实例（供 Webhook 路由使用） */
  getChannel(channelId: string): BridgeChannel | null {
    return (this.channels.get(channelId)?.instance || null) as BridgeChannel | null;
  }

  /** 根据配置创建通道实例 */
  private createChannelInstance(ch: MobileChannel): unknown {
    switch (ch.type) {
      case 'wecom':
        return new WeComChannel(ch.config, this.agentPort);
      case 'feishu':
        return new FeishuChannel(ch.config, this.agentPort);
      case 'dingtalk':
        return new DingTalkChannel(ch.config, this.agentPort);
      case 'telegram':
        return new TelegramChannel(ch.config, this.agentPort);
      case 'discord':
        return new DiscordChannel(ch.config, this.agentPort);
      case 'slack':
        return new SlackChannel(ch.config, this.agentPort);
      case 'wechat':
        return new WeChatBridgeChannel(ch.config, this.agentPort);
      case 'webhook':
        return new GenericWebhookChannel(ch.config, this.agentPort);
      case 'email':
        return new EmailChannel(ch.config, this.agentPort);
      case 'whatsapp':
        return new WhatsAppChannel(ch.config, this.agentPort);
      case 'teams':
        return new TeamsChannel(ch.config, this.agentPort);
      case 'sms':
        return new SmsChannel(ch.config, this.agentPort);
      case 'qq':
        return new QQChannel(ch.config, this.agentPort);
      case 'wechat_oa':
        return new WeChatOAChannel(ch.config, this.agentPort);
      default:
        console.warn(`[RemoteBridge] 未知通道类型: ${ch.type}，跳过`);
        return null;
    }
  }
}

// ============================================================
// Express 集成：注册 Webhook 路由并启动服务
// ============================================================

/** Express-like 请求类型（最小化，供桥接路由使用） */
interface BridgeReq {
  params: Record<string, string>;
  body: unknown;
  query: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

/** Express-like 响应类型（最小化，供桥接路由使用） */
interface BridgeRes {
  status(code: number): BridgeRes;
  json(data: unknown): void;
  send(data: unknown): void;
  setHeader(name: string, value: string): void;
}

/**
 * 在 Express 应用上设置远程桥接服务
 * - 注册 /api/bridge/webhook/:channelId 路由
 * - 启动轮询类通道（Telegram）
 * - 返回 RemoteBridgeService 实例
 */
export function setupRemoteBridge(
  app: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (path: string, handler: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (path: string, handler: any) => void;
  },
  agentPort: number,
): RemoteBridgeService {
  const service = new RemoteBridgeService(agentPort);

  // ---- 通用 Webhook 接收路由 ----
  // POST /api/bridge/webhook/:channelId
  // 各通道的消息统一通过此路由接收
  app.post('/api/bridge/webhook/:channelId', async (req: BridgeReq, res: BridgeRes) => {
    const channelId = req.params.channelId;
    const channel = service.getChannel(channelId);

    if (!channel) {
      return res.status(404).json({ error: `通道 ${channelId} 未配置或未启动` });
    }

    try {
      // 根据通道类型分发处理
      switch (channelId) {
        case 'wecom': {
          // 企业微信：GET 用于验证，POST 用于接收消息
          const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
          const reply = await channel.handleMessage(body);
          res.setHeader('Content-Type', 'application/xml');
          return res.send(reply);
        }

        case 'feishu': {
          // 修复：req.body 为 unknown，断言为 Record<string, unknown> 以访问 challenge 字段
          const body = req.body as Record<string, unknown>;
          // 飞书 URL 验证
          if (body.challenge) {
            const verification = channel.handleVerification(body);
            return res.json(verification);
          }
          // 飞书事件回调（需立即返回 200，异步处理消息）
          res.json({ code: 0 });
          // 异步处理，避免超时
          channel.handleMessage(body).catch((e: Error) => {
            console.error(`[Bridge/Feishu] 异步处理失败:`, e.message);
          });
          return;
        }

        case 'dingtalk': {
          const reply = await channel.handleMessage(req.body);
          return res.json(reply);
        }

        case 'discord': {
          const reply = await channel.handleMessage(req.body);
          return res.json(reply);
        }

        case 'slack': {
          // 修复：req.body 为 unknown，断言为 Record<string, unknown> 以访问 challenge 字段
          const body = req.body as Record<string, unknown>;
          // Slack URL 验证
          if (body.challenge) {
            return res.json({ challenge: body.challenge });
          }
          // 验证签名
          if (channel.signingSecret) {
            const timestamp = req.headers['x-slack-request-timestamp'] as string;
            const signature = req.headers['x-slack-signature'] as string;
            const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            if (!channel.verifySignature(timestamp, rawBody, signature)) {
              return res.status(401).json({ error: '签名验证失败' });
            }
          }
          // Slack 事件回调（需立即返回 200）
          res.json({});
          // 异步处理
          channel.handleMessage(body).catch((e: Error) => {
            console.error(`[Bridge/Slack] 异步处理失败:`, e.message);
          });
          return;
        }

        case 'wechat': {
          const reply = await channel.handleMessage(req.body);
          return res.json(reply);
        }

        case 'webhook': {
          const reply = await channel.handleMessage(req.body);
          return res.json(reply);
        }

        case 'email': {
          const reply = await channel.handleMessage(req.body);
          return res.json(reply);
        }

        case 'whatsapp': {
          // WhatsApp Webhook：立即返回 200，异步处理
          res.json({ success: true });
          channel.receiveMessage(req.body).catch((e: Error) => {
            console.error(`[Bridge/WhatsApp] 异步处理失败:`, e.message);
          });
          return;
        }

        case 'teams': {
          const reply = await channel.receiveMessage(req.body);
          return res.json(reply);
        }

        case 'sms': {
          const reply = await channel.receiveMessage(req.body);
          if (typeof reply === 'string') {
            res.setHeader('Content-Type', 'text/xml');
            return res.send(reply);
          }
          return res.json(reply);
        }

        case 'qq': {
          // QQ Bot Webhook：立即返回 200，异步处理
          res.json({ success: true });
          channel.receiveMessage(req.body).catch((e: Error) => {
            console.error(`[Bridge/QQ] 异步处理失败:`, e.message);
          });
          return;
        }

        case 'wechat_oa': {
          // 微信公众号：POST 接收消息（XML），GET 用于服务器验证
          const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
          const reply = await channel.receiveMessage(body);
          res.setHeader('Content-Type', 'application/xml');
          return res.send(reply);
        }

        default:
          return res.status(400).json({ error: `不支持的通道: ${channelId}` });
      }
    } catch (e) {
      console.error(`[Bridge] 处理 ${channelId} 消息异常:`, (e as Error).message);
      return res.status(500).json({ error: '内部处理错误' });
    }
  });

  // ---- 企业微信：已改用 WebSocket 长连接，无需 Webhook 路由 ----

  // ---- WhatsApp Webhook 订阅验证路由（GET） ----
  app.get('/api/bridge/webhook/whatsapp', (req: BridgeReq, res: BridgeRes) => {
    const channel = service.getChannel('whatsapp');
    if (!channel) {
      return res.status(404).send('通道未配置');
    }
    const challenge = channel.verifyWebhook(req.query || {});
    if (challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('验证失败');
  });

  // ---- 微信公众号服务器配置验证路由（GET） ----
  app.get('/api/bridge/webhook/wechat_oa', (req: BridgeReq, res: BridgeRes) => {
    const channel = service.getChannel('wechat_oa');
    if (!channel) {
      return res.status(404).send('通道未配置');
    }
    const echoStr = channel.verifySignature(req.query || {});
    if (echoStr) {
      return res.send(echoStr);
    }
    return res.status(403).send('验证失败');
  });

  // ---- 桥接服务状态路由 ----
  app.get('/api/bridge/status', (_req: BridgeReq, res: BridgeRes) => {
    res.json({
      running: service['started'],
      channels: service.getStatus(),
    });
  });

  // 启动服务（异步，不阻塞）
  service.start().catch((e: Error) => {
    console.error('[RemoteBridge] 启动失败:', e.message);
  });

  return service;
}
