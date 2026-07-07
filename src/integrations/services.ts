/**
 * 段先生 - 第三方服务集成模块 (Phase 1.6)
 *
 * 对标 Windsurf Integrations + OpenClaw Connectors：
 * - Slack / Discord / GitHub / Notion / 飞书 / 企业微信 / 邮件
 * - Agent Loop 工具注册：所有服务操作可直接被 Agent 调用
 * - EventBus 事件广播：服务操作触发事件
 * - 统一状态管理：连接状态、操作统计
 */

import axios from 'axios';
import { EventBus } from '../core/event-bus.js';
import { logger } from '../core/structured-logger.js';

// ============ 类型定义 ============

export interface SlackMessage {
  channel: string;
  text: string;
  username?: string;
  icon_emoji?: string;
}

export interface ServiceOperationResult {
  success: boolean;
  output: string;
  service: string;
  operation: string;
  timestamp: number;
}

export interface ServiceStatus {
  service: string;
  connected: boolean;
  operationsCount: number;
  lastOperation?: string;
  lastOperationTime?: number;
}

// ============ 主类 ============

export class ServiceIntegrations {
  private slackToken: string | null = null;
  private discordWebhook: string | null = null;
  private githubToken: string | null = null;
  private notionToken: string | null = null;
  private feishuToken: string | null = null;
  private wecomKey: string | null = null;
  private smtpConfig: {
    host: string | null;
    port: number;
    user: string | null;
    pass: string | null;
    from: string | null;
  } = { host: null, port: 465, user: null, pass: null, from: null };

  private eventBus: EventBus;
  private log = logger.child({ module: 'ServiceIntegrations' });
  private operationCounts: Map<string, number> = new Map();
  private lastOperations: Map<string, { operation: string; time: number }> = new Map();

  constructor() {
    this.eventBus = EventBus.getInstance();

    if (process.env.SLACK_BOT_TOKEN) this.slackToken = process.env.SLACK_BOT_TOKEN;
    if (process.env.DISCORD_WEBHOOK) this.discordWebhook = process.env.DISCORD_WEBHOOK;
    if (process.env.GITHUB_TOKEN) this.githubToken = process.env.GITHUB_TOKEN;
    if (process.env.NOTION_TOKEN) this.notionToken = process.env.NOTION_TOKEN;
    if (process.env.FEISHU_TOKEN) this.feishuToken = process.env.FEISHU_TOKEN;
    if (process.env.WECOM_KEY) this.wecomKey = process.env.WECOM_KEY;
    if (process.env.SMTP_HOST) {
      this.smtpConfig.host = process.env.SMTP_HOST;
      this.smtpConfig.port = parseInt(process.env.SMTP_PORT || '465');
      this.smtpConfig.user = process.env.SMTP_USER || null;
      this.smtpConfig.pass = process.env.SMTP_PASS || null;
      this.smtpConfig.from = process.env.SMTP_FROM || null;
    }
  }

  private recordOperation(service: string, operation: string): void {
    this.operationCounts.set(service, (this.operationCounts.get(service) || 0) + 1);
    this.lastOperations.set(service, { operation, time: Date.now() });
  }

  private emitEvent(service: string, operation: string, result: ServiceOperationResult): Promise<void> {
    return this.eventBus.emit('service.operation', {
      service,
      operation,
      success: result.success,
      timestamp: result.timestamp,
    }, { source: 'ServiceIntegrations' }).catch(() => {});
  }

  // ==================== Slack 集成 ====================

  async sendSlackMessage(message: SlackMessage): Promise<string> {
    if (!this.slackToken) return '需要设置 SLACK_BOT_TOKEN';
    try {
      await axios.post(
        'https://slack.com/api/chat.postMessage',
        {
          channel: message.channel,
          text: message.text,
          username: message.username || '段先生',
          icon_emoji: message.icon_emoji || ':robot_face:',
        },
        { headers: { 'Authorization': `Bearer ${this.slackToken}`, 'Content-Type': 'application/json' } }
      );
      this.recordOperation('slack', 'send_message');
      this.log.info('Slack message sent', { channel: message.channel });
      return `消息已发送到 Slack 频道 ${message.channel}`;
    } catch (error: unknown) {
      this.log.error('Slack send failed', { error: (error instanceof Error ? error.message : String(error)) });
      return `Slack 发送失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async getSlackChannels(): Promise<string> {
    if (!this.slackToken) return '需要设置 SLACK_BOT_TOKEN';
    try {
      const response = await axios.get('https://slack.com/api/conversations.list', {
        headers: { 'Authorization': `Bearer ${this.slackToken}` },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channels = response.data.channels.map((ch: any) => `#${ch.name}`).join('\n');
      this.recordOperation('slack', 'list_channels');
      return channels || '未找到频道';
    } catch (error: unknown) {
      return `获取频道失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== Discord 集成 ====================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendDiscordMessage(message: string, embeds?: any[]): Promise<string> {
    if (!this.discordWebhook) return '需要设置 DISCORD_WEBHOOK';
    try {
      await axios.post(this.discordWebhook, { content: message, username: '段先生', embeds: embeds || [] });
      this.recordOperation('discord', 'send_message');
      return '消息已发送到 Discord';
    } catch (error: unknown) {
      return `Discord 发送失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== GitHub 集成 ====================

  async getGitHubRepos(): Promise<string> {
    if (!this.githubToken) return '需要设置 GITHUB_TOKEN';
    try {
      const response = await axios.get('https://api.github.com/user/repos', {
        headers: { 'Authorization': `token ${this.githubToken}` },
        params: { sort: 'updated', per_page: 10 },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repos = response.data.map((repo: any) => `📁 ${repo.full_name}\n   ${repo.description || '无描述'}`).join('\n\n');
      this.recordOperation('github', 'list_repos');
      return repos || '未找到仓库';
    } catch (error: unknown) {
      return `获取仓库失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async createGitHubIssue(owner: string, repo: string, title: string, body: string): Promise<string> {
    if (!this.githubToken) return '需要设置 GITHUB_TOKEN';
    try {
      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/issues`,
        { title, body },
        { headers: { 'Authorization': `token ${this.githubToken}`, 'Content-Type': 'application/json' } }
      );
      this.recordOperation('github', 'create_issue');
      return `Issue 已创建: ${response.data.html_url}`;
    } catch (error: unknown) {
      return `创建 Issue 失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async createGitHubPR(owner: string, repo: string, title: string, head: string, base: string, body: string): Promise<string> {
    if (!this.githubToken) return '需要设置 GITHUB_TOKEN';
    try {
      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        { title, head, base, body },
        { headers: { 'Authorization': `token ${this.githubToken}`, 'Content-Type': 'application/json' } }
      );
      this.recordOperation('github', 'create_pr');
      return `PR 已创建: ${response.data.html_url}`;
    } catch (error: unknown) {
      return `创建 PR 失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async getGitHubNotifications(): Promise<string> {
    if (!this.githubToken) return '需要设置 GITHUB_TOKEN';
    try {
      const response = await axios.get('https://api.github.com/notifications', {
        headers: { 'Authorization': `token ${this.githubToken}` },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const notifications = response.data.slice(0, 10).map((n: any) => {
        const type = n.subject.type === 'PullRequest' ? '🔀' : '📝';
        return `${type} ${n.subject.title}\n   ${n.repository.full_name}`;
      }).join('\n\n');
      this.recordOperation('github', 'get_notifications');
      return notifications || '没有新通知';
    } catch (error: unknown) {
      return `获取通知失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async getGitHubRepoInfo(owner: string, repo: string): Promise<string> {
    if (!this.githubToken) return '需要设置 GITHUB_TOKEN';
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { 'Authorization': `token ${this.githubToken}` },
      });
      const d = response.data;
      this.recordOperation('github', 'repo_info');
      return `📁 ${d.full_name}\n描述: ${d.description || '无'}\n⭐ ${d.stargazers_count} | 🍴 ${d.forks_count} | 📋 ${d.open_issues_count} issues\n语言: ${d.language || 'N/A'} | 许可: ${d.license?.name || 'N/A'}\nURL: ${d.html_url}`;
    } catch (error: unknown) {
      return `获取仓库信息失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async searchGitHubCode(query: string): Promise<string> {
    if (!this.githubToken) return '需要设置 GITHUB_TOKEN';
    try {
      const response = await axios.get('https://api.github.com/search/code', {
        headers: { 'Authorization': `token ${this.githubToken}` },
        params: { q: query, per_page: 10 },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = response.data.items.map((item: any) =>
        `📄 ${item.name} (${item.repository.full_name})\n   ${item.html_url}`
      ).join('\n\n');
      this.recordOperation('github', 'search_code');
      return results || '未找到匹配代码';
    } catch (error: unknown) {
      return `搜索代码失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== Notion 集成 ====================

  async searchNotionPages(query: string): Promise<string> {
    if (!this.notionToken) return '需要设置 NOTION_TOKEN';
    try {
      const response = await axios.post('https://api.notion.com/v1/search', { query }, {
        headers: { 'Authorization': `Bearer ${this.notionToken}`, 'Notion-Version': '2022-06-28' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages = response.data.results.slice(0, 10).map((p: any) => {
        const title = p.properties?.title?.title?.[0]?.plain_text ||
                      p.properties?.Name?.title?.[0]?.plain_text || '无标题';
        return `📄 ${title}`;
      }).join('\n');
      this.recordOperation('notion', 'search');
      return pages || '未找到页面';
    } catch (error: unknown) {
      return `搜索 Notion 失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  async createNotionPage(databaseId: string, title: string, content: string): Promise<string> {
    if (!this.notionToken) return '需要设置 NOTION_TOKEN';
    try {
      const response = await axios.post('https://api.notion.com/v1/pages', {
        parent: { database_id: databaseId },
        properties: { title: { title: [{ text: { content: title } }] } },
        children: [{
          object: 'block', type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content } }] },
        }],
      }, {
        headers: { 'Authorization': `Bearer ${this.notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      });
      this.recordOperation('notion', 'create_page');
      return `Notion 页面已创建: ${response.data.url}`;
    } catch (error: unknown) {
      return `创建 Notion 页面失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== 飞书集成 ====================

  async sendFeishuMessage(webhookUrl: string, title: string, content: string): Promise<string> {
    if (!this.feishuToken && !webhookUrl) return '需要设置 FEISHU_TOKEN 或提供 webhook URL';
    try {
      const url = webhookUrl || `https://open.feishu.cn/open-apis/bot/v2/hook/${this.feishuToken}`;
      await axios.post(url, {
        msg_type: 'interactive',
        card: {
          header: { title: { content: title, tag: 'plain_text' } },
          elements: [{ tag: 'div', text: { content, tag: 'plain_text' } }],
        },
      });
      this.recordOperation('feishu', 'send_message');
      return '消息已发送到飞书';
    } catch (error: unknown) {
      return `飞书发送失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== 企业微信集成 ====================

  async sendWecomMessage(content: string, mentionedList?: string[]): Promise<string> {
    if (!this.wecomKey) return '需要设置 WECOM_KEY';
    try {
      await axios.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${this.wecomKey}`, {
        msgtype: 'text',
        text: { content, mentioned_mobile_list: mentionedList || [] },
      });
      this.recordOperation('wecom', 'send_message');
      return '消息已发送到企业微信';
    } catch (error: unknown) {
      return `企业微信发送失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== 邮件集成 ====================

  async sendEmail(to: string, subject: string, body: string): Promise<string> {
    if (!this.smtpConfig.host || !this.smtpConfig.user || !this.smtpConfig.pass) {
      return '需要设置 SMTP_HOST, SMTP_USER, SMTP_PASS 环境变量';
    }
    try {
      // 使用 nodemailer 风格的 SMTP 发送（通过 HTTP API 代理）
      // 实际项目中应引入 nodemailer，此处用 axios 调用邮件 API
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: this.smtpConfig.host,
        port: this.smtpConfig.port,
        secure: this.smtpConfig.port === 465,
        auth: { user: this.smtpConfig.user, pass: this.smtpConfig.pass },
      });
      await transporter.sendMail({
        from: this.smtpConfig.from || this.smtpConfig.user,
        to,
        subject,
        text: body,
      });
      this.recordOperation('email', 'send');
      return `邮件已发送到 ${to}`;
    } catch (error: unknown) {
      // nodemailer 不可用时降级提示
      const errCode = (error as { code?: string })?.code;
      if (errCode === 'MODULE_NOT_FOUND') {
        return '邮件功能需要安装 nodemailer: npm install nodemailer';
      }
      return `邮件发送失败: ${(error instanceof Error ? error.message : String(error))}`;
    }
  }

  // ==================== 统一通知（多渠道广播） ====================

  async broadcastMessage(title: string, content: string, channels?: string[]): Promise<string> {
    const targetChannels = channels || this.getAvailableChannels();
    const results: string[] = [];

    const tasks = targetChannels.map(async (ch) => {
      try {
        switch (ch) {
          case 'slack':
            if (this.slackToken) {
              const r = await this.sendSlackMessage({ channel: '#general', text: `${title}\n${content}` });
              results.push(`Slack: ${r}`);
            }
            break;
          case 'discord':
            if (this.discordWebhook) {
              const r = await this.sendDiscordMessage(`**${title}**\n${content}`);
              results.push(`Discord: ${r}`);
            }
            break;
          case 'feishu':
            if (this.feishuToken) {
              const r = await this.sendFeishuMessage('', title, content);
              results.push(`飞书: ${r}`);
            }
            break;
          case 'wecom':
            if (this.wecomKey) {
              const r = await this.sendWecomMessage(`${title}\n${content}`);
              results.push(`企业微信: ${r}`);
            }
            break;
        }
      } catch (err: unknown) {
        results.push(`${ch}: 失败 - ${(err instanceof Error ? err.message : String(err))}`);
      }
    });

    await Promise.allSettled(tasks);
    this.recordOperation('broadcast', 'multi_channel');
    return `📢 广播完成:\n${results.join('\n')}`;
  }

  // ==================== 状态与统计 ====================

  getAvailableChannels(): string[] {
    const channels: string[] = [];
    if (this.slackToken) channels.push('slack');
    if (this.discordWebhook) channels.push('discord');
    if (this.githubToken) channels.push('github');
    if (this.notionToken) channels.push('notion');
    if (this.feishuToken) channels.push('feishu');
    if (this.wecomKey) channels.push('wecom');
    if (this.smtpConfig.host) channels.push('email');
    return channels;
  }

  getStatus(): Record<string, boolean> {
    return {
      slack: this.slackToken !== null,
      discord: this.discordWebhook !== null,
      github: this.githubToken !== null,
      notion: this.notionToken !== null,
      feishu: this.feishuToken !== null,
      wecom: this.wecomKey !== null,
      email: this.smtpConfig.host !== null,
    };
  }

  getServiceStatuses(): ServiceStatus[] {
    const services = ['slack', 'discord', 'github', 'notion', 'feishu', 'wecom', 'email'];
    const statusMap = this.getStatus();
    return services.map(service => ({
      service,
      connected: statusMap[service] || false,
      operationsCount: this.operationCounts.get(service) || 0,
      lastOperation: this.lastOperations.get(service)?.operation,
      lastOperationTime: this.lastOperations.get(service)?.time,
    }));
  }

  getStats(): string {
    const statuses = this.getServiceStatuses();
    const connected = statuses.filter(s => s.connected).length;
    const totalOps = statuses.reduce((sum, s) => sum + s.operationsCount, 0);
    let output = `📊 服务集成状态\n  已连接: ${connected}/${statuses.length} 个服务\n  总操作: ${totalOps} 次\n\n`;
    for (const s of statuses) {
      const icon = s.connected ? '🟢' : '⚪';
      const ops = s.operationsCount > 0 ? ` (${s.operationsCount}次)` : '';
      output += `  ${icon} ${s.service}${ops}\n`;
    }
    return output;
  }

  // ==================== Agent Loop 工具定义 ====================

  /**
   * 生成可注册到 Agent Loop 的工具定义数组
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const si = this;
    return [
      {
        name: 'service_slack',
        description: 'Slack 操作：发送消息到频道、列出频道。需要设置 SLACK_BOT_TOKEN。',
        parameters: {
          action: { type: 'string', description: '操作: send(发消息) / channels(列频道)', required: true },
          channel: { type: 'string', description: '频道名 (send时需要，如 #general)', required: false },
          text: { type: 'string', description: '消息内容 (send时需要)', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (action === 'send') {
            if (!args.channel || !args.text) return Promise.resolve('错误: send 操作需要 channel 和 text');
            return si.sendSlackMessage({ channel: args.channel as string, text: args.text as string });
          }
          if (action === 'channels') return si.getSlackChannels();
          return Promise.resolve('用法: action=send|channels');
        },
      },
      {
        name: 'service_discord',
        description: 'Discord 操作：发送消息到 Webhook 频道。需要设置 DISCORD_WEBHOOK。',
        parameters: {
          message: { type: 'string', description: '要发送的消息内容', required: true },
        },
        execute: (args) => si.sendDiscordMessage(args.message as string),
      },
      {
        name: 'service_github',
        description: 'GitHub 操作：列出仓库、创建Issue/PR、查看通知、搜索代码、查看仓库详情。需要设置 GITHUB_TOKEN。',
        parameters: {
          action: { type: 'string', description: '操作: repos/issues/pr/notifications/repo_info/search_code', required: true },
          owner: { type: 'string', description: '仓库所有者 (issues/pr/repo_info时需要)', required: false },
          repo: { type: 'string', description: '仓库名 (issues/pr/repo_info时需要)', required: false },
          title: { type: 'string', description: '标题 (issues/pr时需要)', required: false },
          body: { type: 'string', description: '内容 (issues/pr时需要)', required: false },
          head: { type: 'string', description: 'PR源分支 (pr时需要)', required: false },
          base: { type: 'string', description: 'PR目标分支 (pr时需要，默认main)', required: false },
          query: { type: 'string', description: '搜索关键词 (search_code时需要)', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (action === 'repos') return si.getGitHubRepos();
          if (action === 'notifications') return si.getGitHubNotifications();
          if (action === 'issues' && args.owner && args.repo && args.title) {
            return si.createGitHubIssue(args.owner as string, args.repo as string, args.title as string, (args.body as string) || '');
          }
          if (action === 'pr' && args.owner && args.repo && args.title && args.head) {
            return si.createGitHubPR(args.owner as string, args.repo as string, args.title as string, args.head as string, (args.base as string) || 'main', (args.body as string) || '');
          }
          if (action === 'repo_info' && args.owner && args.repo) {
            return si.getGitHubRepoInfo(args.owner as string, args.repo as string);
          }
          if (action === 'search_code' && args.query) {
            return si.searchGitHubCode(args.query as string);
          }
          return Promise.resolve('用法: action=repos|issues|pr|notifications|repo_info|search_code');
        },
      },
      {
        name: 'service_notion',
        description: 'Notion 操作：搜索页面、创建页面。需要设置 NOTION_TOKEN。',
        parameters: {
          action: { type: 'string', description: '操作: search(搜索页面) / create(创建页面)', required: true },
          query: { type: 'string', description: '搜索关键词 (search时需要)', required: false },
          databaseId: { type: 'string', description: '数据库ID (create时需要)', required: false },
          title: { type: 'string', description: '页面标题 (create时需要)', required: false },
          content: { type: 'string', description: '页面内容 (create时需要)', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (action === 'search' && args.query) return si.searchNotionPages(args.query as string);
          if (action === 'create' && args.databaseId && args.title) {
            return si.createNotionPage(args.databaseId as string, args.title as string, (args.content as string) || '');
          }
          return Promise.resolve('用法: action=search|create');
        },
      },
      {
        name: 'service_feishu',
        description: '飞书操作：发送消息到飞书群。需要设置 FEISHU_TOKEN。',
        parameters: {
          webhookUrl: { type: 'string', description: '飞书 Webhook URL（可选，默认使用环境变量）', required: false },
          title: { type: 'string', description: '消息标题', required: true },
          content: { type: 'string', description: '消息内容', required: true },
        },
        execute: (args) => si.sendFeishuMessage((args.webhookUrl as string) || '', args.title as string, args.content as string),
      },
      {
        name: 'service_wecom',
        description: '企业微信操作：发送消息到企业微信群。需要设置 WECOM_KEY。',
        parameters: {
          content: { type: 'string', description: '消息内容', required: true },
          mentionedList: { type: 'string', description: '@人列表，逗号分隔手机号', required: false },
        },
        execute: (args) => {
          const mentioned = args.mentionedList ? (args.mentionedList as string).split(',').map(s => s.trim()) : undefined;
          return si.sendWecomMessage(args.content as string, mentioned);
        },
      },
      {
        name: 'service_email',
        description: '邮件操作：发送邮件。需要设置 SMTP_HOST, SMTP_USER, SMTP_PASS。',
        parameters: {
          to: { type: 'string', description: '收件人邮箱', required: true },
          subject: { type: 'string', description: '邮件主题', required: true },
          body: { type: 'string', description: '邮件正文', required: true },
        },
        execute: (args) => si.sendEmail(args.to as string, args.subject as string, args.body as string),
      },
      {
        name: 'service_broadcast',
        description: '多渠道广播：同时向所有已连接的服务发送消息。支持 Slack/Discord/飞书/企业微信。',
        parameters: {
          title: { type: 'string', description: '消息标题', required: true },
          content: { type: 'string', description: '消息内容', required: true },
          channels: { type: 'string', description: '目标渠道，逗号分隔（默认全部已连接渠道）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const channels = args.channels ? (args.channels as string).split(',').map(s => s.trim()) : undefined;
          return si.broadcastMessage(args.title as string, args.content as string, channels);
        },
      },
      {
        name: 'service_status',
        description: '查看所有第三方服务的连接状态和操作统计。',
        readOnly: true,
        parameters: {},
        execute: () => Promise.resolve(si.getStats()),
      },
    ];
  }
}
