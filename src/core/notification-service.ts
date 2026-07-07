/**
 * NotificationService — 统一通知服务
 *
 * 支持多渠道通知：控制台、EventBus、Webhook、Slack。
 * 所有集成的通知基础设施，支持优先级路由、去重、频率限制。
 */

import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import { getChannelManager } from './channel-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export type NotificationChannel = 'console' | 'eventbus' | 'webhook' | 'slack';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';
export type NotificationType = 'info' | 'warning' | 'error' | 'success' | 'alert';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  source: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
  timestamp: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
  dedupKey?: string;
}

export interface NotificationChannelConfig {
  enabled: boolean;
  webhookUrl?: string;
  slackToken?: string;
  slackChannel?: string;
  rateLimitMs?: number;
}

export interface NotificationServiceConfig {
  channels: Partial<Record<NotificationChannel, NotificationChannelConfig>>;
  maxHistory: number;
}

const DEFAULT_CONFIG: NotificationServiceConfig = {
  channels: {
    console: { enabled: true },
    eventbus: { enabled: true },
    webhook: { enabled: false, rateLimitMs: 5000 },
    slack: { enabled: false, rateLimitMs: 10000 },
  },
  maxHistory: 500,
};

export class NotificationService {
  private config: NotificationServiceConfig;
  private history: Notification[] = [];
  private lastSent: Map<string, number> = new Map();
  private persistPath: string;
  private eventBus: EventBus;
  private log = logger.child({ module: 'NotificationService' });

  constructor(persistDir?: string) {
    this.config = { ...DEFAULT_CONFIG, channels: { ...DEFAULT_CONFIG.channels } };
    this.eventBus = EventBus.getInstance();
    this.persistPath = path.join(persistDir || path.join(process.cwd(), '.duan'), 'notifications.json');
    this.load();
  }

  /** 更新通道配置 */
  configureChannel(channel: NotificationChannel, config: Partial<NotificationChannelConfig>): void {
    this.config.channels[channel] = { ...this.config.channels[channel], ...config } as NotificationChannelConfig;
    this.save();
    this.log.info('通知通道已配置', { channel });
  }

  /** 获取配置 */
  getConfig(): NotificationServiceConfig {
    return { ...this.config, channels: { ...this.config.channels } };
  }

  /** 发送通知 */
  async notify(type: NotificationType, title: string, message: string, options?: {
    source?: string;
    channel?: NotificationChannel;
    priority?: NotificationPriority;
    metadata?: Record<string, unknown>;
    dedupKey?: string;
  }): Promise<string> {
    const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const notification: Notification = {
      id,
      type,
      title,
      message,
      source: options?.source || 'system',
      channel: options?.channel || 'console',
      priority: options?.priority || 'normal',
      timestamp: Date.now(),
      metadata: options?.metadata,
      dedupKey: options?.dedupKey,
    };

    // 去重检查
    if (notification.dedupKey) {
      const last = this.lastSent.get(notification.dedupKey);
      if (last && Date.now() - last < 30000) return id;
      this.lastSent.set(notification.dedupKey, Date.now());
    }

    // 频率限制检查
    const channelConfig = this.config.channels[notification.channel];
    if (channelConfig?.rateLimitMs) {
      const channelKey = `rate_${notification.channel}`;
      const lastChan = this.lastSent.get(channelKey) || 0;
      if (Date.now() - lastChan < channelConfig.rateLimitMs) return id;
      this.lastSent.set(channelKey, Date.now());
    }

    // 路由到各通道
    await this.dispatch(notification);

    // 记录历史
    this.history.push(notification);
    if (this.history.length > this.config.maxHistory) {
      this.history = this.history.slice(-this.config.maxHistory);
    }
    this.save();

    this.eventBus.emitSync('notification.sent', {
      id, type, title, source: notification.source, channel: notification.channel,
    }, { source: 'NotificationService' });

    return id;
  }

  /** 快捷方法 */
  info(title: string, message: string, source?: string): Promise<string> {
    return Promise.resolve(this.notify('info', title, message, { source, channel: 'console' }));
  }

  warn(title: string, message: string, source?: string): Promise<string> {
    return Promise.resolve(this.notify('warning', title, message, { source, priority: 'high', channel: 'console' }));
  }

  error(title: string, message: string, source?: string): Promise<string> {
    return Promise.resolve(this.notify('error', title, message, { source, priority: 'high', channel: 'console' }));
  }

  success(title: string, message: string, source?: string): Promise<string> {
    return Promise.resolve(this.notify('success', title, message, { source, channel: 'console' }));
  }

  /** 获取通知历史 */
  getHistory(options?: { type?: NotificationType; source?: string; limit?: number }): Notification[] {
    let filtered = [...this.history];
    if (options?.type) filtered = filtered.filter(n => n.type === options.type);
    if (options?.source) filtered = filtered.filter(n => n.source === options.source);
    filtered.reverse();
    return filtered.slice(0, options?.limit || 50);
  }

  /** 获取统计 */
  getStats(): { total: number; byType: Record<string, number>; bySource: Record<string, number> } {
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const n of this.history) {
      byType[n.type] = (byType[n.type] || 0) + 1;
      bySource[n.source] = (bySource[n.source] || 0) + 1;
    }
    return { total: this.history.length, byType, bySource };
  }

  /** 清除历史 */
  clearHistory(): void {
    this.history = [];
    this.save();
  }

  /** 发送 Slack 通知（如果已配置） */
  async sendSlack(message: string): Promise<boolean> {
    const slackConfig = this.config.channels.slack;
    if (!slackConfig?.enabled || !slackConfig.webhookUrl) return false;
    try {
      const response = await fetch(slackConfig.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, channel: slackConfig.slackChannel }),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** 发送 Webhook（如果已配置） */
  async sendWebhook(payload: unknown): Promise<boolean> {
    const whConfig = this.config.channels.webhook;
    if (!whConfig?.enabled || !whConfig.webhookUrl) return false;
    try {
      const response = await fetch(whConfig.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async dispatch(notification: Notification): Promise<void> {
    const cfg = this.config.channels[notification.channel];
    if (!cfg?.enabled) return;

    const cm = getChannelManager();
    cm.recordActivity(notification.channel);

    const logMsg = `[${notification.type.toUpperCase()}] ${notification.title}: ${notification.message}`;
    switch (notification.channel) {
      case 'console':
        console.info(logMsg);
        break;
      case 'eventbus':
        this.eventBus.emitSync('notification.alert', {
          type: notification.type,
          title: notification.title,
          message: notification.message,
          source: notification.source,
          timestamp: notification.timestamp,
        });
        break;
      case 'webhook':
        try { await this.sendWebhook(notification); } catch {}
        if (notification.type === 'error') cm.recordActivity(notification.channel, notification.message);
        break;
      case 'slack':
        try { await this.sendSlack(logMsg); } catch {}
        if (notification.type === 'error') cm.recordActivity(notification.channel, notification.message);
        break;
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const data = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...data.config };
        this.history = data.history || [];
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteJsonSync(this.persistPath, {
        config: this.config,
        history: this.history.slice(-100),
      });
    } catch { /* ignore */ }
  }
}
