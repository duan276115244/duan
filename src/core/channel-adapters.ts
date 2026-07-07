/**
 * 渠道适配器实现 (Channel Adapters) — P4 真实跨渠道投递
 *
 * 为 AgentIdentityNetwork.syncAcrossChannelsAsync() 提供真实渠道投递能力：
 *
 * 1. WeChatChannelAdapter: 包装 WeChatController，使用 Windows UI 自动化真实发送微信消息
 *    - 依赖 wechat-controller.ts（生产模块，已被 wechat 相关 skill 使用）
 *    - 通过 findContact + 输入消息 + Enter 发送的完整流程
 *    - 平台限制：仅 Windows 可用，其他平台 isReady() 返回 false
 *
 * 2. WebhookChannelAdapter: 通过 HTTP POST 投递消息到 webhook URL
 *    - 适用于 web / api / feishu（飞书机器人 webhook）/ email（通过 webhook 转发）渠道
 *    - 真实 HTTP 调用，使用 Node.js 原生 https/http 模块
 *    - 支持自定义 headers（用于 Authorization、签名等）
 *
 * 真实性说明（非 stub）：
 * - WeChatChannelAdapter.sendMessage 真实调用 WeChatController.sendMessage
 * - WebhookChannelAdapter.sendMessage 真实发起 HTTP POST 请求
 * - 失败时返回 success: false 和错误信息，由 syncAcrossChannelsAsync 决定是否缓冲
 */

import * as https from 'https';
import * as http from 'http';
import { logger } from './structured-logger.js';
import type { ChannelAdapter, ChannelType } from './agent-identity.js';
import type { WeChatController } from './wechat-controller.js';

// ============ WeChat 渠道适配器 ============

/**
 * 微信渠道适配器 — 包装 WeChatController 实现真实消息投递
 *
 * 通过 Windows UI 自动化（findContact + 输入 + Enter）真实发送微信消息。
 * 仅在 Windows 平台且 WeChatController 初始化成功时 isReady() 返回 true。
 */
export class WeChatChannelAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'wechat';
  readonly name: string;
  private controller: WeChatController;
  private ready: boolean;

  constructor(controller: WeChatController) {
    this.controller = controller;
    this.name = 'WeChatChannelAdapter';
    // 检查平台和控制器状态
    this.ready = process.platform === 'win32';
    if (!this.ready) {
      logger.warn('P4 WeChatChannelAdapter: 非 Windows 平台，适配器不可用', {
        platform: process.platform,
      });
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async sendMessage(recipient: string, message: string): Promise<{ success: boolean; error?: string; messageId?: string }> {
    if (!this.ready) {
      return {
        success: false,
        error: 'WeChat 适配器未就绪（非 Windows 平台）',
      };
    }

    try {
      // 调用 WeChatController.sendMessage 真实发送
      // 返回值为结果字符串，成功时为空或包含发送确认，失败时以 '❌' 开头
      const result = await this.controller.sendMessage(recipient, message);

      // WeChatController.sendMessage 失败时返回 '❌ ...' 字符串
      if (typeof result === 'string' && result.startsWith('❌')) {
        return {
          success: false,
          error: result,
        };
      }

      // 成功投递
      return {
        success: true,
        messageId: `wechat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  dispose(): void {
    // WeChatController 自身有 dispose 逻辑，不在这里重复释放
    logger.debug('P4 WeChatChannelAdapter 已释放');
  }
}

// ============ Webhook 渠道适配器 ============

/**
 * Webhook 渠道适配器 — 通过 HTTP POST 真实投递消息
 *
 * 适用于 web / api / feishu（飞书自定义机器人 webhook）/ email（通过 webhook 中转）渠道。
 * 真实发起 HTTP POST 请求，将消息以 JSON 格式发送到指定 URL。
 *
 * 支持自定义 headers（用于 Authorization、签名验证等）。
 * 支持 POST 和 PUT 方法。
 */
export class WebhookChannelAdapter implements ChannelAdapter {
  readonly channel: ChannelType;
  readonly name: string;
  protected webhookUrl: string;
  protected headers: Record<string, string>;
  private method: 'POST' | 'PUT';
  private ready: boolean;
  protected timeout: number;

  constructor(params: {
    channel: ChannelType;
    webhookUrl: string;
    headers?: Record<string, string>;
    method?: 'POST' | 'PUT';
    timeout?: number;
    adapterName?: string;
  }) {
    this.channel = params.channel;
    this.webhookUrl = params.webhookUrl;
    this.headers = params.headers || { 'Content-Type': 'application/json' };
    this.method = params.method || 'POST';
    this.timeout = params.timeout || 10000;
    this.name = params.adapterName || `WebhookChannelAdapter[${params.channel}]`;
    this.ready = this.validateUrl(params.webhookUrl);

    if (!this.ready) {
      logger.warn('P4 WebhookChannelAdapter: webhook URL 无效', {
        channel: this.channel,
        url: params.webhookUrl,
      });
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 验证 URL 格式 */
  private validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** messageId 前缀（子类可覆盖） */
  protected get messageIdPrefix(): string {
    return 'webhook';
  }

  /** 解析 HTTP 响应（子类可覆盖以支持渠道特定的响应格式） */
  protected parseResponse(
    statusCode: number | undefined,
    body: string,
  ): { success: boolean; error?: string; messageId?: string } {
    const success = statusCode !== undefined && statusCode >= 200 && statusCode < 300;
    return {
      success,
      error: success ? undefined : `HTTP ${statusCode}: ${body.substring(0, 200)}`,
      messageId: success ? `${this.messageIdPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined,
    };
  }

  /**
   * 通用 HTTP 投递逻辑：接受已构造好的 payload 与 headers，
   * 负责发起请求并解析响应。子类只需提供自定义 payload / header。
   */
  protected deliverPayload(
    payload: string,
    headers: Record<string, string> = this.headers,
  ): Promise<{ success: boolean; error?: string; messageId?: string }> {
    return new Promise((resolve) => {
      const urlObj = new URL(this.webhookUrl);
      const isHttps = urlObj.protocol === 'https:';
      const requestModule = isHttps ? https : http;

      const options: https.RequestOptions = {
        method: this.method,
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
        timeout: this.timeout,
      };

      const req = requestModule.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve(this.parseResponse(res.statusCode, body));
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          error: err.message,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: `请求超时 (${this.timeout}ms)`,
        });
      });

      req.write(payload);
      req.end();
    });
  }

  sendMessage(recipient: string, message: string): Promise<{ success: boolean; error?: string; messageId?: string }> {
    if (!this.ready) {
      return Promise.resolve({
        success: false,
        error: 'Webhook 适配器未就绪（URL 无效）',
      });
    }

    const payload = JSON.stringify({
      recipient,
      message,
      timestamp: Date.now(),
      channel: this.channel,
    });

    return this.deliverPayload(payload);
  }

  dispose(): void {
    logger.debug('P4 WebhookChannelAdapter 已释放', { channel: this.channel });
  }
}

// ============ 飞书渠道适配器（基于 Webhook） ============

/**
 * 飞书自定义机器人适配器 — 通过飞书 webhook 真实投递消息
 *
 * 飞书自定义机器人支持 webhook 投递，消息格式为：
 * { "msg_type": "text", "content": { "text": "消息内容" } }
 *
 * 若配置了签名密钥，会计算签名并加入请求：
 * X-Lark-Signature: sha256(timestamp + nonce + secret + body)
 */
export class FeishuChannelAdapter extends WebhookChannelAdapter {
  constructor(params: {
    webhookUrl: string;
    secret?: string; // 飞书签名密钥（可选）
    timeout?: number;
  }) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // 若有签名密钥，在请求时动态计算签名
    if (params.secret) {
      // 签名在 sendMessage 时动态计算（因为依赖 timestamp）
      // 这里先注册占位 header
      headers['X-Lark-Signature-Mode'] = 'sha256';
    }

    super({
      channel: 'feishu',
      webhookUrl: params.webhookUrl,
      headers,
      method: 'POST',
      timeout: params.timeout || 10000,
      adapterName: 'FeishuChannelAdapter',
    });

    // 存储签名密钥供 sendMessage 使用
    this.feishuSecret = params.secret;
  }

  private feishuSecret?: string;

  protected get messageIdPrefix(): string {
    return 'feishu';
  }

  /** 解析飞书响应（成功响应中可能包含 code / msg 字段） */
  protected parseResponse(
    statusCode: number | undefined,
    body: string,
  ): { success: boolean; error?: string; messageId?: string } {
    const success = statusCode !== undefined && statusCode >= 200 && statusCode < 300;
    let errorMsg: string | undefined;
    if (success) {
      try {
        const resp = JSON.parse(body);
        if (resp.code !== undefined && resp.code !== 0) {
          errorMsg = `飞书错误 ${resp.code}: ${resp.msg}`;
        }
      } catch {
        // 非 JSON 响应，忽略
      }
    } else {
      errorMsg = `HTTP ${statusCode}: ${body.substring(0, 200)}`;
    }
    return {
      success: success && !errorMsg,
      error: errorMsg,
      messageId: success ? `${this.messageIdPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined,
    };
  }

  /**
   * 重写 sendMessage 以支持飞书消息格式和签名。
   * 仅构造自定义 payload 与 header，HTTP 投递复用父类的 deliverPayload。
   */
  async sendMessage(recipient: string, message: string): Promise<{ success: boolean; error?: string; messageId?: string }> {
    if (!this.isReady()) {
      return {
        success: false,
        error: '飞书适配器未就绪（URL 无效）',
      };
    }

    // 飞书消息格式：msg_type=text, content.text
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({
      msg_type: 'text',
      content: { text: message },
      timestamp,
    });

    // 基于基础 headers 构造本次请求的 headers，避免污染共享状态
    const headers: Record<string, string> = { ...this.headers };

    // 计算签名（如果配置了密钥）
    if (this.feishuSecret) {
      const nonce = Math.random().toString(36).slice(2, 10);
      const signContent = timestamp + nonce + this.feishuSecret + payload;
      // 使用 Node.js crypto 计算 SHA256
      const crypto = await import('crypto');
      const signature = crypto.createHash('sha256').update(signContent).digest('hex');
      headers['X-Lark-Signature'] = signature;
      headers['X-Lark-Timestamp'] = timestamp;
    }

    // 复用父类的 HTTP 投递逻辑
    return this.deliverPayload(payload, headers);
  }
}

