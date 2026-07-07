/**
 * ChannelManager — 统一消息通道管理器
 *
 * 对标 OpenClaw channels.* 配置模式，提供：
 * - 统一通道配置（channels.xxx 结构）
 * - 通道生命周期管理（启动/停止/重启）
 * - 通道健康监控（状态/心跳）
 * - 访问策略（dmPolicy / allowFrom / groupPolicy）
 * - 事件广播（通知、错误、状态变更）
 */

import * as fs from 'fs';
import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 通道类型 */
export type ChannelType =
  | 'telegram' | 'discord' | 'slack' | 'whatsapp'
  | 'wecom' | 'feishu' | 'dingtalk' | 'wechat'
  | 'email' | 'webhook' | 'console' | 'eventbus'
  | 'teams' | 'sms' | 'qq' | 'wechat_oa'
  | 'serverchan' | 'bark';

/** DM 访问策略（对标 OpenClaw dmPolicy） */
export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';

/** 群组策略 */
export type GroupPolicy = 'allowlist' | 'open' | 'disabled';

/** 消息队列丢弃策略 */
export type DropStrategy = 'old' | 'new' | 'summarize';

/** 通道心跳配置 */
export interface ChannelHeartbeat {
  enabled?: boolean;
  intervalMs?: number;
  to?: string;
  prompt?: string;
}

/** 消息队列配置 */
export interface MessageQueueConfig {
  mode?: 'collect' | 'interrupt' | 'queue';
  debounceMs?: number;
  cap?: number;
  drop?: DropStrategy;
}

/** 通道访问控制 */
export interface ChannelAccessConfig {
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: string[];
  requireMention?: boolean;
}

/** 单个通道配置（对标 OpenClaw channels.* 结构） */
export interface ChannelConfig extends ChannelAccessConfig {
  id?: string;
  enabled: boolean;
  type: ChannelType;
  label?: string;
  botToken?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPort?: number;
  webhookPath?: string;
  webhookHost?: string;
  /** 飞书/Lark App ID（格式: cli_xxx） */
  appId?: string;
  /** 飞书/Lark App Secret */
  appSecret?: string;
  /** 飞书事件订阅校验令牌（Webhook 模式） */
  verificationToken?: string;
  /** 飞书事件加密密钥（Encrypt Key） */
  encryptKey?: string;
  /** 飞书连接模式：websocket（默认）或 webhook */
  connectionMode?: 'websocket' | 'webhook';
  /** 飞书域名：feishu（国内，默认）或 lark（国际版） */
  domain?: 'feishu' | 'lark';
  /** 飞书机器人名称 */
  botName?: string;
  /** 企业微信 CorpID（企业 ID） */
  corpId?: string;
  /** 企业微信 AgentID（应用 ID） */
  agentId?: string;
  /** 企业微信应用 Secret */
  wecomSecret?: string;
  /** 企业微信回调 Token */
  wecomToken?: string;
  /** 企业微信消息加解密密钥 EncodingAESKey */
  encodingAESKey?: string;
  /** 钉钉 AppKey（Client ID） */
  appKey?: string;
  /** 钉钉 AppSecret（Client Secret） */
  appSecretDing?: string;
  /** 钉钉机器人 Robot Code */
  robotCode?: string;
  /** 钉钉回调 AES Key */
  aesKey?: string;
  /** Telegram Chat ID（目标会话/群组） */
  chatId?: string;
  /** Discord Application ID（Client ID） */
  applicationId?: string;
  /** Discord Guild ID（服务器 ID） */
  guildId?: string;
  /** Discord Channel ID（频道 ID） */
  channelId?: string;
  /** Slack Signing Secret（签名密钥） */
  signingSecret?: string;
  /** Slack App-Level Token（Socket Mode） */
  appToken?: string;
  /** Slack Channel ID */
  slackChannelId?: string;
  /** Server酱 SendKey */
  sendKey?: string;
  /** Bark Device Key */
  deviceKey?: string;
  /** Bark 自定义服务器地址（默认 https://api.day.app） */
  barkServerUrl?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpTo?: string;
  apiKey?: string;
  apiUrl?: string;
  heartbeat?: ChannelHeartbeat;
  queue?: MessageQueueConfig;
  maxMessageLength?: number;
  groups?: Record<string, { enabled?: boolean; requireMention?: boolean; allowFrom?: string[] }>;
}

/** 通道运行时状态 */
export interface ChannelRuntimeStatus {
  channelId: string;
  type: ChannelType;
  label: string;
  enabled: boolean;
  running: boolean;
  connected: boolean;
  lastActivity: number | null;
  messageCount: number;
  errorCount: number;
  lastError: string | null;
  startedAt: number | null;
  config: ChannelConfig;
}

/** 通道健康报告 */
export interface ChannelHealthReport {
  totalChannels: number;
  enabledChannels: number;
  runningChannels: number;
  healthyChannels: number;
  channels: Array<{
    id: string;
    type: ChannelType;
    label: string;
    status: 'healthy' | 'degraded' | 'error' | 'stopped';
    uptime: number;
    messageCount: number;
    errorCount: number;
    lastError: string | null;
  }>;
}

// ============ 常量 ============

const CONFIG_PATH = duanPath('config.json');
const HEARTBEAT_DEFAULT_MS = 300000;

// ============ 通道管理器 ============

export class ChannelManager {
  private channels: Map<string, ChannelRuntimeStatus> = new Map();
  private eventBus: EventBus;
  private log = logger.child({ module: 'ChannelManager' });
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private _initialized = false;

  constructor() {
    this.eventBus = EventBus.getInstance();
  }

  get initialized(): boolean { return this._initialized; }

  /** 可持久化的通道字段白名单（统一用于 load/save，避免遗漏字段，如 groupAllowFrom） */
  private readonly persistableFields: (keyof ChannelConfig)[] = [
    'webhookSecret', 'webhookPort', 'webhookPath', 'webhookHost',
    'appId', 'appSecret', 'verificationToken', 'encryptKey', 'connectionMode',
    'domain', 'botName', 'corpId', 'agentId', 'wecomSecret', 'wecomToken',
    'encodingAESKey', 'appKey', 'appSecretDing', 'robotCode', 'aesKey',
    'chatId', 'applicationId', 'guildId', 'channelId', 'signingSecret',
    'appToken', 'slackChannelId', 'sendKey', 'deviceKey', 'barkServerUrl',
    'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom', 'smtpTo',
    'apiKey', 'apiUrl', 'allowFrom', 'groupAllowFrom', 'heartbeat',
    'queue', 'maxMessageLength', 'groups',
  ];

  /** 从 ~/.duan/config.json 加载通道配置 */
  loadConfig(): ChannelConfig[] {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        const channels = raw.channels || {};
        const configs: ChannelConfig[] = [];

        for (const [id, cfg] of Object.entries(channels)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const c = cfg as Record<string, any>;
          if (c && typeof c === 'object') {
            // 带默认值/环境变量回退的特殊字段单独处理
            const config: ChannelConfig = {
              enabled: c.enabled !== false,
              type: (c.type || id) as ChannelType,
              label: c.label || id,
              botToken: c.botToken || process.env[`${id.toUpperCase()}_BOT_TOKEN`] || undefined,
              webhookUrl: c.webhookUrl || process.env[`${id.toUpperCase()}_WEBHOOK`] || undefined,
              dmPolicy: c.dmPolicy || 'pairing',
              groupPolicy: c.groupPolicy || 'allowlist',
              requireMention: c.requireMention,
            };
            // 统一拷贝可持久化字段，避免遗漏
            for (const field of this.persistableFields) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (config as Record<string, any>)[field] = c[field];
            }
            configs.push(config);
          }
        }

        return configs;
      }
    } catch (e) {
      this.log.warn('读取通道配置失败', { error: (e as Error).message });
    }
    return [];
  }

  /** 保存通道配置到 ~/.duan/config.json */
  saveConfig(configs: ChannelConfig[]): void {
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(CONFIG_PATH)) {
        existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      }
      const channels: Record<string, unknown> = {};
      for (const c of configs) {
        const id = c.id || c.label || c.type;
        // 始终持久化的基础字段
        const entry: Record<string, unknown> = {
          enabled: c.enabled,
          type: c.type,
        };
        if (c.label) entry.label = c.label;
        if (c.botToken) entry.botToken = c.botToken;
        if (c.webhookUrl) entry.webhookUrl = c.webhookUrl;
        if (c.dmPolicy) entry.dmPolicy = c.dmPolicy;
        if (c.groupPolicy) entry.groupPolicy = c.groupPolicy;
        if (c.requireMention !== undefined) entry.requireMention = c.requireMention;
        // 统一写入可持久化字段（仅在有值时），避免遗漏
        for (const field of this.persistableFields) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const value = (c as Record<string, any>)[field];
          if (value !== undefined && value !== null && value !== '') {
            entry[field] = value;
          }
        }
        channels[id] = entry;
      }
      existing.channels = channels;
      atomicWriteJsonSync(CONFIG_PATH, existing);
    } catch (e) {
      this.log.error('保存通道配置失败', { error: (e as Error).message });
    }
  }

  /** 注册并启动通道 */
  registerChannel(channelId: string, config: ChannelConfig): void {
    const existing = this.channels.get(channelId);
    if (existing) {
      this.channels.set(channelId, {
        ...existing,
        config,
        enabled: config.enabled,
      });
      return;
    }

    const status: ChannelRuntimeStatus = {
      channelId,
      type: config.type,
      label: config.label || channelId,
      enabled: config.enabled,
      running: false,
      connected: false,
      lastActivity: null,
      messageCount: 0,
      errorCount: 0,
      lastError: null,
      startedAt: null,
      config,
    };
    this.channels.set(channelId, status);

    if (config.enabled) {
      this.startChannel(channelId);
    }
  }

  /** 启动通道 */
  startChannel(channelId: string): boolean {
    const status = this.channels.get(channelId);
    if (!status) {
      this.log.warn(`通道不存在: ${channelId}`);
      return false;
    }
    if (status.running) return true;

    status.running = true;
    status.connected = true;
    status.startedAt = Date.now();
    this.log.info(`通道已启动: ${channelId} (${status.type})`);

    this.eventBus.emitSync('channel.status_change', {
      channelId,
      type: status.type,
      status: 'running',
      timestamp: Date.now(),
    });

    this.startHeartbeat(channelId);
    return true;
  }

  /** 停止通道 */
  stopChannel(channelId: string): boolean {
    const status = this.channels.get(channelId);
    if (!status) return false;

    this.stopHeartbeat(channelId);
    status.running = false;
    status.connected = false;
    this.log.info(`通道已停止: ${channelId}`);

    this.eventBus.emitSync('channel.status_change', {
      channelId,
      type: status.type,
      status: 'stopped',
      timestamp: Date.now(),
    });
    return true;
  }

  /** 检查调用方是否有权限访问某通道 */
  checkAccess(channelId: string, senderId: string, chatType: 'dm' | 'group' = 'dm'): boolean {
    const status = this.channels.get(channelId);
    if (!status) return false;
    const cfg = status.config;
    const channelType = status.type;

    if (chatType === 'dm') {
      switch (cfg.dmPolicy) {
        case 'disabled': return false;
        case 'open': return true;
        case 'allowlist':
          return cfg.allowFrom?.includes(senderId) || cfg.allowFrom?.includes('*') || false;
        case 'pairing':
          // 配对模式：检查用户是否已在配对列表中（通过 PairingManager）
          // 延迟导入避免循环依赖
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { PairingManager } = require('./pairing-manager');
            return PairingManager.getInstance().isPaired(channelType, senderId);
          } catch {
            return false;
          }
        default: return true;
      }
    }

    switch (cfg.groupPolicy) {
      case 'disabled': return false;
      case 'open': return true;
      case 'allowlist':
        return cfg.groupAllowFrom?.includes(senderId) || cfg.groupAllowFrom?.includes('*') || false;
      default: return true;
    }
  }

  /** 记录通道活动 */
  recordActivity(channelId: string, error?: string): void {
    const status = this.channels.get(channelId);
    if (!status) return;
    status.lastActivity = Date.now();
    status.messageCount++;
    if (error) {
      status.errorCount++;
      status.lastError = error;
      status.connected = false;
    } else {
      status.connected = true;
    }
  }

  /** 获取单个通道状态 */
  getChannelStatus(channelId: string): ChannelRuntimeStatus | undefined {
    return this.channels.get(channelId);
  }

  /** 获取所有通道状态 */
  getAllStatuses(): ChannelRuntimeStatus[] {
    return Array.from(this.channels.values());
  }

  /** 获取已启用的通道列表 */
  getEnabledChannels(): ChannelRuntimeStatus[] {
    return this.getAllStatuses().filter(s => s.enabled);
  }

  /** 生成通道健康报告（对标 OpenClaw channels status） */
  getHealthReport(): ChannelHealthReport {
    const channels = Array.from(this.channels.values()).map(s => {
      let chanStatus: 'healthy' | 'degraded' | 'error' | 'stopped';
      if (!s.running) chanStatus = 'stopped';
      else if (s.errorCount > 5 && s.lastError) chanStatus = 'error';
      else if (s.errorCount > 0) chanStatus = 'degraded';
      else chanStatus = 'healthy';

      return {
        id: s.channelId,
        type: s.type,
        label: s.label,
        status: chanStatus,
        uptime: s.startedAt ? Date.now() - s.startedAt : 0,
        messageCount: s.messageCount,
        errorCount: s.errorCount,
        lastError: s.lastError,
      };
    });

    return {
      totalChannels: channels.length,
      enabledChannels: channels.filter(s => {
        const orig = this.channels.get(s.id);
        return orig?.enabled === true;
      }).length,
      runningChannels: channels.filter(s => {
        const orig = this.channels.get(s.id);
        return orig?.running === true;
      }).length,

      healthyChannels: channels.filter(s => s.status === 'healthy').length,
      channels,
    };
  }

  /** 从环境变量回退读取通道凭证（向后兼容） */
  getCredentialsFromEnv(type: ChannelType): Record<string, string> {
    const map: Record<string, string[]> = {
      slack: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
      discord: ['DISCORD_BOT_TOKEN', 'DISCORD_WEBHOOK'],
      telegram: ['TELEGRAM_BOT_TOKEN'],
      wecom: ['WECOM_KEY', 'WECOM_CORP_ID', 'WECOM_AGENT_ID'],
      feishu: ['FEISHU_TOKEN', 'FEISHU_WEBHOOK'],
      dingtalk: ['DINGTALK_WEBHOOK', 'DINGTALK_SECRET'],
      email: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
      webhook: ['WEBHOOK_URL'],
      wechat: ['WECHAT_BOT_URL'],
      whatsapp: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN'],
      teams: ['TEAMS_WEBHOOK_URL', 'TEAMS_BOT_TOKEN'],
      sms: ['SMS_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'ALIYUN_SMS_ACCESS_KEY', 'ALIYUN_SMS_SECRET', 'ALIYUN_SMS_SIGN_NAME'],
      qq: ['QQ_BOT_TOKEN', 'QQ_WEBHOOK_URL'],
      wechat_oa: ['WECHAT_OA_APP_ID', 'WECHAT_OA_APP_SECRET', 'WECHAT_OA_TOKEN', 'WECHAT_OA_ENCODING_AES_KEY'],
    };

    const keys = map[type] || [];
    const result: Record<string, string> = {};
    for (const k of keys) {
      const v = process.env[k];
      if (v) result[k] = v;
    }
    return result;
  }

  /** 心跳管理 */
  private startHeartbeat(channelId: string): void {
    this.stopHeartbeat(channelId);
    const status = this.channels.get(channelId);
    if (!status?.config.heartbeat?.enabled) return;

    const interval = status.config.heartbeat.intervalMs || HEARTBEAT_DEFAULT_MS;
    const timer = setInterval(() => {
      const s = this.channels.get(channelId);
      if (!s?.running) { this.stopHeartbeat(channelId); return; }
      this.eventBus.emitSync('channel.heartbeat', {
        channelId,
        type: s.type,
        connected: s.connected,
        messageCount: s.messageCount,
        errorCount: s.errorCount,
        timestamp: Date.now(),
      });
    }, interval);
    this.heartbeatTimers.set(channelId, timer);
  }

  private stopHeartbeat(channelId: string): void {
    const timer = this.heartbeatTimers.get(channelId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(channelId);
    }
  }

  /** 销毁所有通道 */
  destroy(): Promise<void> {
    for (const [id] of this.heartbeatTimers) {
      this.stopHeartbeat(id);
    }
    for (const [id] of this.channels) {
      this.stopChannel(id);
    }
    this.channels.clear();
    this._initialized = false;
    return Promise.resolve();
  }
}

/** 全局单例 */
let _channelManager: ChannelManager | null = null;

export function getChannelManager(): ChannelManager {
  if (!_channelManager) {
    _channelManager = new ChannelManager();
  }
  return _channelManager;
}
