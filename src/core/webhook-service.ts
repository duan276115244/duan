/**
 * WebhookService — Webhook 接收与处理服务
 *
 * 监听 Git webhook 事件（CI/CD 完成、PR 变更等），
 * 自动触发 Agent 动作（如 CI 失败时自动修复、PR 自动审查）。
 */

import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export type WebhookEventType = 'ci_complete' | 'ci_failure' | 'pr_opened' | 'pr_updated' | 'pr_merged' | 'push' | 'deploy';

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  source: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  timestamp: number;
  processed: boolean;
  result?: string;
}

export interface WebhookHandler {
  eventType: WebhookEventType;
  handler: (event: WebhookEvent) => Promise<string>;
  description: string;
}

export interface WebhookConfig {
  enabled: boolean;
  autoFixCI: boolean;
  autoReviewPR: boolean;
  autoDeploy: boolean;
  allowedSources: string[];
}

const DEFAULT_CONFIG: WebhookConfig = {
  enabled: false,
  autoFixCI: false,
  autoReviewPR: false,
  autoDeploy: false,
  allowedSources: ['github', 'gitlab', 'gitee'],
};

// ============ 主类 ============

export class WebhookService {
  private config: WebhookConfig;
  private handlers: WebhookHandler[] = [];
  private history: WebhookEvent[] = [];
  private persistPath: string;
  private eventBus: EventBus;
  private log = logger.child({ module: 'WebhookService' });

  constructor(persistDir?: string) {
    this.config = { ...DEFAULT_CONFIG };
    this.eventBus = EventBus.getInstance();
    this.persistPath = path.join(persistDir || duanPath(), 'webhooks.json');
    this.registerDefaultHandlers();
    this.load();
  }

  /** 更新配置 */
  configure(config: Partial<WebhookConfig>): void {
    this.config = { ...this.config, ...config };
    this.save();
    this.log.info('Webhook 配置已更新', { autoFixCI: this.config.autoFixCI, autoReviewPR: this.config.autoReviewPR });
  }

  /** 获取配置 */
  getConfig(): WebhookConfig {
    return { ...this.config };
  }

  /** 注册自定义 handler */
  registerHandler(handler: WebhookHandler): void {
    this.handlers.push(handler);
  }

  /** 接收并处理 webhook 事件 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async receiveEvent(type: WebhookEventType, source: string, payload: any): Promise<string> {
    const id = `webhook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const event: WebhookEvent = {
      id, type, source, payload, timestamp: Date.now(), processed: false,
    };

    this.log.info('收到 Webhook 事件', { id, type, source });

    if (!this.config.enabled) {
      event.processed = false;
      event.result = 'Webhook 服务未启用';
      this.recordEvent(event);
      return `⏸️ Webhook 未启用: ${type} (id=${id})`;
    }

    if (!this.config.allowedSources.includes(source)) {
      event.processed = false;
      event.result = `来源 ${source} 不在白名单中`;
      this.recordEvent(event);
      return `❌ 拒绝来源: ${source}`;
    }

    // 查找匹配的 handler
    const matching = this.handlers.filter(h => h.eventType === type);
    if (matching.length === 0) {
      event.processed = true;
      event.result = `无 handler 处理 ${type}`;
      this.recordEvent(event);
      return `ℹ️ 已收到但未处理: ${type}`;
    }

    // 执行 handler
    const results: string[] = [];
    for (const h of matching) {
      try {
        const result = await h.handler(event);
        results.push(result);
      } catch (err: unknown) {
        results.push(`错误: ${(err instanceof Error ? err.message : String(err))}`);
      }
    }

    event.processed = true;
    event.result = results.join('\n');
    this.recordEvent(event);

    this.eventBus.emitSync('webhook.processed', {
      id, type, source, success: results.every(r => !r.startsWith('错误')),
    }, { source: 'WebhookService' });

    return results.join('\n');
  }

  /** 模拟 CI 完成事件（用于测试或手动触发） */
  simulateCIComplete(project: string, status: 'success' | 'failure', details?: string): Promise<string> {
    return this.receiveEvent(status === 'success' ? 'ci_complete' : 'ci_failure', 'github', {
      project,
      status,
      details,
      sha: 'simulated',
      branch: 'main',
    });
  }

  /** 获取事件历史 */
  getHistory(limit: number = 20): WebhookEvent[] {
    return [...this.history].reverse().slice(0, limit);
  }

  /** 获取统计 */
  getStats(): { total: number; processed: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    let processed = 0;
    for (const e of this.history) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.processed) processed++;
    }
    return { total: this.history.length, processed, byType };
  }

  // ============ 默认 Handler ============

  private registerDefaultHandlers(): void {
    this.handlers.push(
      {
        eventType: 'ci_failure',
        handler: (event) => {
          this.log.warn('CI 构建失败', { project: event.payload?.project });
          return Promise.resolve(`⚠️ CI 失败: ${event.payload?.project || '未知项目'}. 详情: ${event.payload?.details || '无'}`);
        },
        description: 'CI 构建失败通知',
      },
      {
        eventType: 'ci_complete',
        handler: (event) => {
          this.log.info('CI 构建成功', { project: event.payload?.project });
          return Promise.resolve(`✅ CI 成功: ${event.payload?.project}`);
        },
        description: 'CI 构建成功通知',
      },
      {
        eventType: 'pr_opened',
        handler: (event) => {
          this.log.info('PR 已创建', { pr: event.payload?.prNumber, title: event.payload?.title });
          return Promise.resolve(`📝 PR #${event.payload?.prNumber}: ${event.payload?.title || '无标题'}`);
        },
        description: 'PR 创建通知',
      },
      {
        eventType: 'pr_merged',
        handler: (event) => {
          this.log.info('PR 已合并', { pr: event.payload?.prNumber });
          return Promise.resolve(`✅ PR #${event.payload?.prNumber} 已合并到 ${event.payload?.branch || 'main'}`);
        },
        description: 'PR 合并通知',
      },
    );
  }

  private recordEvent(event: WebhookEvent): void {
    this.history.push(event);
    if (this.history.length > 200) {
      this.history = this.history.slice(-200);
    }
    this.save();
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
        history: this.history.slice(-50),
      });
    } catch { /* ignore */ }
  }
}
