// ============================================================
// Channels Routes — 消息通道 RESTful API
// 对标 OpenClaw channels.* 配置模式
// 提供通道的 CRUD + 启停 + 健康报告 + 模板
// ============================================================

import type express from 'express';
import { getChannelManager, type ChannelConfig, type ChannelType } from '../../core/channel-manager.js';
import { UnifiedConfigManager } from '../../core/unified-config.js';

/** 通道模板定义：每种通道需要的字段 */
const CHANNEL_TEMPLATES: Record<string, {
  type: ChannelType;
  label: string;
  description: string;
  icon: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'number' | 'select';
    required: boolean;
    placeholder?: string;
    options?: string[];
    help?: string;
  }>;
  accessControl: boolean;
}> = {
  wecom: {
    type: 'wecom',
    label: '企业微信',
    description: '企业微信智能机器人，使用长连接模式接收消息',
    icon: 'wechat',
    fields: [
      { key: 'botId', label: 'Bot ID', type: 'text', required: true, placeholder: '机器人唯一标识', help: '在企业微信工作台→智能机器人→创建机器人(API模式)获取' },
      { key: 'secret', label: 'Secret', type: 'password', required: true, placeholder: '机器人密钥', help: '妥善保管，不要分享给他人' },
    ],
    accessControl: true,
  },
  feishu: {
    type: 'feishu',
    label: '飞书',
    description: '飞书/Lark 机器人，支持 WebSocket 长连接和 Webhook 两种模式',
    icon: 'feishu',
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: 'cli_xxx', help: '在飞书开放平台→凭证与基础信息获取' },
      { key: 'appSecret', label: 'App Secret', type: 'password', required: true, placeholder: '应用密钥', help: '妥善保管，不要分享给他人' },
      { key: 'connectionMode', label: '连接模式', type: 'select', required: true, options: ['websocket', 'webhook'], help: 'WebSocket（默认）：无需公网地址；Webhook：需配置事件订阅 URL' },
      { key: 'verificationToken', label: '校验令牌 (Verification Token)', type: 'password', required: false, placeholder: 'Webhook 模式必填', help: '在飞书开放平台→事件与回调→加密策略获取，Webhook 模式下必填' },
      { key: 'encryptKey', label: '加密密钥 (Encrypt Key)', type: 'password', required: false, placeholder: '可选，用于事件加密', help: '在飞书开放平台→事件与回调→加密策略获取' },
      { key: 'domain', label: '域名', type: 'select', required: false, options: ['feishu', 'lark'], help: 'feishu：国内版（默认）；lark：国际版' },
      { key: 'botName', label: '机器人名称', type: 'text', required: false, placeholder: '可选，机器人显示名称' },
    ],
    accessControl: true,
  },
  dingtalk: {
    type: 'dingtalk',
    label: '钉钉',
    description: '钉钉群机器人，通过 Webhook 接收消息',
    icon: 'dingtalk',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://oapi.dingtalk.com/robot/send?...' },
      { key: 'webhookSecret', label: '加签密钥', type: 'password', required: false, placeholder: 'SEC...' },
    ],
    accessControl: true,
  },
  telegram: {
    type: 'telegram',
    label: 'Telegram',
    description: 'Telegram Bot，通过 Bot Token 收发消息',
    icon: 'telegram',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...', help: '在 @BotFather 创建机器人获取' },
    ],
    accessControl: true,
  },
  discord: {
    type: 'discord',
    label: 'Discord',
    description: 'Discord Bot，通过 Bot Token 收发消息',
    icon: 'discord',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: 'MTk4NjIy...' },
      { key: 'webhookUrl', label: 'Webhook URL (可选)', type: 'text', required: false, placeholder: 'https://discord.com/api/webhooks/...' },
    ],
    accessControl: true,
  },
  slack: {
    type: 'slack',
    label: 'Slack',
    description: 'Slack Bot，通过 Bot Token 收发消息',
    icon: 'slack',
    fields: [
      { key: 'botToken', label: 'Bot Token (xoxb-)', type: 'password', required: true, placeholder: 'xoxb-...' },
      { key: 'webhookSecret', label: 'Signing Secret', type: 'password', required: false },
    ],
    accessControl: true,
  },
  email: {
    type: 'email',
    label: '邮件',
    description: '通过 SMTP 收发邮件',
    icon: 'mail',
    fields: [
      { key: 'smtpHost', label: 'SMTP 主机', type: 'text', required: true, placeholder: 'smtp.gmail.com' },
      { key: 'smtpPort', label: 'SMTP 端口', type: 'number', required: true, placeholder: '465' },
      { key: 'smtpUser', label: '用户名', type: 'text', required: true, placeholder: 'user@example.com' },
      { key: 'smtpPass', label: '密码', type: 'password', required: true },
      { key: 'smtpFrom', label: '发件人地址', type: 'text', required: true, placeholder: 'user@example.com' },
    ],
    accessControl: false,
  },
  webhook: {
    type: 'webhook',
    label: 'Webhook',
    description: '通用 Webhook，可对接任意支持 HTTP 回调的系统',
    icon: 'webhook',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://...' },
      { key: 'webhookSecret', label: '签名密钥', type: 'password', required: false },
      { key: 'webhookPort', label: '监听端口', type: 'number', required: false, placeholder: '3000' },
      { key: 'webhookPath', label: '回调路径', type: 'text', required: false, placeholder: '/webhook' },
    ],
    accessControl: false,
  },
  whatsapp: {
    type: 'whatsapp',
    label: 'WhatsApp',
    description: 'WhatsApp Business Cloud API，通过 Meta 平台收发消息',
    icon: 'whatsapp',
    fields: [
      { key: 'phoneNumberId', label: 'Phone Number ID', type: 'text', required: true, placeholder: '1234567890', help: '在 Meta for Developers → WhatsApp → API Setup 获取' },
      { key: 'accessToken', label: 'Access Token', type: 'password', required: true, placeholder: 'EAAG...', help: '永久或临时访问令牌' },
      { key: 'verifyToken', label: 'Verify Token', type: 'password', required: true, placeholder: '自定义校验令牌', help: 'Webhook 订阅时填写的验证令牌' },
    ],
    accessControl: true,
  },
  teams: {
    type: 'teams',
    label: 'Microsoft Teams',
    description: 'Microsoft Teams 机器人，通过 Incoming Webhook 收发消息',
    icon: 'teams',
    fields: [
      { key: 'webhookUrl', label: 'Incoming Webhook URL', type: 'text', required: true, placeholder: 'https://outlook.office.com/webhook/...', help: '在 Teams 频道→连接器→Incoming Webhook 创建' },
      { key: 'botToken', label: 'Bot Token (可选)', type: 'password', required: false, placeholder: '用于主动发消息（Bot Framework）' },
    ],
    accessControl: true,
  },
  sms: {
    type: 'sms',
    label: '短信 (SMS)',
    description: '短信通道，支持 Twilio 和阿里云短信服务',
    icon: 'sms',
    fields: [
      { key: 'provider', label: '服务商', type: 'select', required: true, options: ['twilio', 'aliyun'], help: 'twilio: 国际短信；aliyun: 阿里云短信' },
      { key: 'accountSid', label: 'Account SID / AccessKey', type: 'text', required: true, placeholder: 'Twilio: ACxxx；阿里云: LTAIxxx' },
      { key: 'authToken', label: 'Auth Token / Secret', type: 'password', required: true },
      { key: 'fromNumber', label: '发送方号码/签名', type: 'text', required: true, placeholder: 'Twilio: +1234...；阿里云: 签名名称' },
    ],
    accessControl: false,
  },
  qq: {
    type: 'qq',
    label: 'QQ',
    description: 'QQ 机器人，通过 QQ 开放平台 Bot Webhook 收发消息',
    icon: 'qq',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '在 QQ 开放平台创建机器人获取' },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://api.sgroup.qq.com/...', help: 'QQ 机器人回调地址' },
    ],
    accessControl: true,
  },
  wechat_oa: {
    type: 'wechat_oa',
    label: '微信公众号',
    description: '微信公众号客服消息接口，通过公众号收发消息',
    icon: 'wechat',
    fields: [
      { key: 'appId', label: 'AppID', type: 'text', required: true, placeholder: 'wx1234567890abcdef', help: '在微信公众平台→基本配置获取' },
      { key: 'appSecret', label: 'AppSecret', type: 'password', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true, help: '服务器配置中的自定义 Token' },
      { key: 'encodingAesKey', label: 'EncodingAESKey', type: 'password', required: false, help: '消息加解密密钥（可选）' },
    ],
    accessControl: true,
  },
};

export function registerChannelsRoutes(app: express.Application): void {
  const unified = UnifiedConfigManager.getInstance();

  // ============================================================
  // GET /api/channels/templates — 获取所有通道模板
  // ============================================================
  app.get('/api/channels/templates', (_req, res) => {
    res.json({ success: true, data: CHANNEL_TEMPLATES });
  });

  // ============================================================
  // GET /api/channels — 列出所有通道配置
  // ============================================================
  app.get('/api/channels', (_req, res) => {
    try {
      const channels = unified.getChannels();
      const cm = getChannelManager();
      const statuses = cm.getAllStatuses();
      const statusMap = new Map(statuses.map(s => [s.channelId, s]));

      const list = Object.entries(channels || {}).map(([id, cfg]) => {
        const status = statusMap.get(id);
        return {
          id,
          ...cfg,
          // 运行时状态
          running: status?.running ?? false,
          connected: status?.connected ?? false,
          messageCount: status?.messageCount ?? 0,
          errorCount: status?.errorCount ?? 0,
          lastError: status?.lastError ?? null,
          lastActivity: status?.lastActivity ?? null,
          startedAt: status?.startedAt ?? null,
        };
      });

      res.json({ success: true, data: list });
    } catch (error) {
      res.status(500).json({ success: false, message: '获取通道列表失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // POST /api/channels — 新增通道
  // ============================================================
  app.post('/api/channels', (req, res) => {
    try {
      const { id, ...cfg } = req.body;
      if (!id || !cfg.type) {
        return res.status(400).json({ success: false, message: '缺少 id 或 type' });
      }

      const channels = unified.getChannels();
      if (channels[id]) {
        return res.status(409).json({ success: false, message: `通道 ${id} 已存在` });
      }

      // 构建完整配置：保留所有传入的字段（避免遗漏 botId/secret/provider/accountSid 等）
      const { id: _ignored, type: _ignoredType, ...restCfg } = cfg;
      const config: ChannelConfig = {
        enabled: cfg.enabled ?? true,
        type: cfg.type,
        label: cfg.label || id,
        dmPolicy: cfg.dmPolicy || 'pairing',
        groupPolicy: cfg.groupPolicy || 'allowlist',
        ...restCfg,
      } as ChannelConfig;

      channels[id] = config;
      unified.setChannels(channels);

      // 注册到 ChannelManager
      const cm = getChannelManager();
      cm.registerChannel(id, config);

      res.json({ success: true, data: { id, ...config } });
    } catch (error) {
      res.status(500).json({ success: false, message: '新增通道失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // PUT /api/channels/:id — 更新通道配置
  // ============================================================
  app.put('/api/channels/:id', (req, res) => {
    try {
      const { id } = req.params;
      const channels = unified.getChannels();
      if (!channels[id]) {
        return res.status(404).json({ success: false, message: `通道 ${id} 不存在` });
      }

      const cfg = req.body;
      const existing = channels[id];
      const config: ChannelConfig = {
        ...existing,
        ...cfg,
        type: existing.type, // 类型不可更改
      };

      channels[id] = config;
      unified.setChannels(channels);

      // 更新 ChannelManager
      const cm = getChannelManager();
      cm.registerChannel(id, config);

      res.json({ success: true, data: { id, ...config } });
    } catch (error) {
      res.status(500).json({ success: false, message: '更新通道失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // DELETE /api/channels/:id — 删除通道
  // ============================================================
  app.delete('/api/channels/:id', (req, res) => {
    try {
      const { id } = req.params;
      const channels = unified.getChannels();
      if (!channels[id]) {
        return res.status(404).json({ success: false, message: `通道 ${id} 不存在` });
      }

      // 先停止通道
      const cm = getChannelManager();
      cm.stopChannel(id);

      delete channels[id];
      unified.setChannels(channels);

      res.json({ success: true, message: `通道 ${id} 已删除` });
    } catch (error) {
      res.status(500).json({ success: false, message: '删除通道失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // POST /api/channels/:id/start — 启动通道
  // ============================================================
  app.post('/api/channels/:id/start', (req, res) => {
    try {
      const { id } = req.params;
      const cm = getChannelManager();
      const status = cm.getChannelStatus(id);
      if (!status) {
        // 尝试从配置加载
        const channels = unified.getChannels();
        if (!channels[id]) {
          return res.status(404).json({ success: false, message: `通道 ${id} 不存在` });
        }
        cm.registerChannel(id, channels[id]);
      }
      const ok = cm.startChannel(id);
      res.json({ success: ok, message: ok ? `通道 ${id} 已启动` : `通道 ${id} 启动失败` });
    } catch (error) {
      res.status(500).json({ success: false, message: '启动通道失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // POST /api/channels/:id/stop — 停止通道
  // ============================================================
  app.post('/api/channels/:id/stop', (req, res) => {
    try {
      const { id } = req.params;
      const cm = getChannelManager();
      const ok = cm.stopChannel(id);
      res.json({ success: ok, message: ok ? `通道 ${id} 已停止` : `通道 ${id} 停止失败` });
    } catch (error) {
      res.status(500).json({ success: false, message: '停止通道失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // GET /api/channels/status — 健康报告
  // ============================================================
  app.get('/api/channels/status', (_req, res) => {
    try {
      const cm = getChannelManager();
      const report = cm.getHealthReport();
      res.json({ success: true, data: report });
    } catch (error) {
      res.status(500).json({ success: false, message: '获取健康报告失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // POST /api/channels/test — 测试通道连接（不发真实消息，仅验证凭证格式）
  // ============================================================
  app.post('/api/channels/test', (req, res) => {
    try {
      const { type, ...cfg } = req.body;
      const errors: string[] = [];

      switch (type) {
        case 'wecom':
          if (!cfg.botId) errors.push('缺少 Bot ID');
          if (!cfg.secret) errors.push('缺少 Secret');
          break;
        case 'feishu':
          if (!cfg.appId) errors.push('缺少 App ID');
          if (cfg.appId && !cfg.appId.startsWith('cli_')) errors.push('App ID 格式错误，应以 cli_ 开头');
          if (!cfg.appSecret) errors.push('缺少 App Secret');
          if (cfg.connectionMode === 'webhook' && !cfg.verificationToken) errors.push('Webhook 模式下校验令牌 (Verification Token) 为必填');
          break;
        case 'dingtalk':
        case 'webhook':
        case 'teams':
        case 'qq':
          if (!cfg.webhookUrl) errors.push('缺少 Webhook URL');
          if (cfg.webhookUrl && !cfg.webhookUrl.startsWith('http')) errors.push('Webhook URL 格式错误');
          break;
        case 'telegram':
          if (!cfg.botToken) errors.push('缺少 Bot Token');
          if (cfg.botToken && !cfg.botToken.includes(':')) errors.push('Bot Token 格式错误');
          break;
        case 'discord':
        case 'slack':
          if (!cfg.botToken) errors.push('缺少 Bot Token');
          break;
        case 'email':
          if (!cfg.smtpHost) errors.push('缺少 SMTP 主机');
          if (!cfg.smtpUser) errors.push('缺少用户名');
          if (!cfg.smtpPass) errors.push('缺少密码');
          break;
        case 'whatsapp':
          if (!cfg.phoneNumberId) errors.push('缺少 Phone Number ID');
          if (!cfg.accessToken) errors.push('缺少 Access Token');
          if (!cfg.verifyToken) errors.push('缺少 Verify Token');
          break;
        case 'sms':
          if (!cfg.provider) errors.push('缺少服务商 (provider)');
          if (cfg.provider && !['twilio', 'aliyun'].includes(cfg.provider)) errors.push('provider 必须为 twilio 或 aliyun');
          if (!cfg.accountSid) errors.push('缺少 Account SID / AccessKey');
          if (!cfg.authToken) errors.push('缺少 Auth Token / Secret');
          if (!cfg.fromNumber) errors.push('缺少发送方号码/签名');
          break;
        case 'wechat_oa':
          if (!cfg.appId) errors.push('缺少 AppID');
          if (!cfg.appSecret) errors.push('缺少 AppSecret');
          if (!cfg.token) errors.push('缺少 Token');
          break;
        default:
          errors.push(`未知通道类型: ${type}`);
      }

      if (errors.length > 0) {
        return res.json({ success: false, message: '验证失败: ' + errors.join('; '), data: { errors } });
      }

      res.json({ success: true, message: '凭证格式验证通过（未实际连接）' });
    } catch (error) {
      res.status(500).json({ success: false, message: '测试失败: ' + (error as Error).message });
    }
  });
}
