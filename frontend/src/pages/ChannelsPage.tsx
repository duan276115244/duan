import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, Plus, Trash2, Save, TestTube2, CheckCircle, XCircle, Loader2, Radio, MessageSquare, Mail, Webhook, Send, Briefcase, Bell, Phone, MessageCircle, Hash, KeyRound } from 'lucide-react';
import { PairingPage } from './PairingPage';

// 通道类型图标映射
const CHANNEL_ICONS: Record<string, any> = {
  wecom: Briefcase,
  feishu: MessageSquare,
  dingtalk: Bell,
  telegram: Send,
  discord: Hash,
  slack: Hash,
  email: Mail,
  webhook: Webhook,
  whatsapp: Phone,
  teams: MessageSquare,
  sms: MessageSquare,
  qq: MessageCircle,
  qqbot: MessageCircle,
  wechat_oa: MessageSquare,
  signal: Radio,
  mattermost: MessageSquare,
  imessage: MessageCircle,
};

const CHANNEL_COLORS: Record<string, string> = {
  wecom: '#07c160',
  feishu: '#3370ff',
  dingtalk: '#0089FF',
  telegram: '#0088cc',
  discord: '#5865F2',
  slack: '#4A154B',
  email: '#f59e0b',
  webhook: '#8b5cf6',
  whatsapp: '#25D366',
  teams: '#6264a7',
  sms: '#f97316',
  qq: '#12B7F5',
  qqbot: '#12B7F5',
  wechat_oa: '#07c160',
  signal: '#3a76f0',
  mattermost: '#0058cc',
  imessage: '#34c759',
};

interface ChannelField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select';
  required: boolean;
  placeholder?: string;
  options?: string[];
  help?: string;
  default?: string | number;
}

interface ChannelTemplate {
  type: string;
  label: string;
  description: string;
  fields: ChannelField[];
  accessControl: boolean;
}

interface ChannelConfig {
  id: string;
  type: string;
  label?: string;
  enabled?: boolean;
  // 通用字段
  botToken?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  secret?: string;
  botId?: string;
  // 飞书
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  connectionMode?: string;
  domain?: string;
  botName?: string;
  // 企业微信
  corpId?: string;
  agentId?: string;
  encodingAesKey?: string;
  // 钉钉
  appKey?: string;
  robotCode?: string;
  // Telegram
  allowFrom?: string[];
  groups?: string;
  historyLimit?: number;
  streaming?: string;
  // WhatsApp
  phoneNumberId?: string;
  accessToken?: string;
  verifyToken?: string;
  apiVersion?: string;
  // Discord
  guildId?: string;
  channelId?: string;
  // Slack
  signingSecret?: string;
  appToken?: string;
  // QQ Bot
  token?: string;
  sandbox?: string;
  // Signal
  signalNumber?: string;
  signalCliPath?: string;
  configDir?: string;
  // Mattermost
  serverUrl?: string;
  botUsername?: string;
  mattermostAccessToken?: string;
  // iMessage
  bridgeEmail?: string;
  appPassword?: string;
  imapServer?: string;
  smtpServer?: string;
  // 微信公众号
  // token?: string; // 已在企业微信中定义
  // 邮件
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  imapHost?: string;
  imapPort?: number;
  // 访问控制
  dmPolicy?: string;
  groupPolicy?: string;
  requireMention?: boolean;
}

export function ChannelsPage({ onBack }: { onBack?: () => void }) {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [templates, setTemplates] = useState<Record<string, ChannelTemplate>>({});
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingChannel, setEditingChannel] = useState<ChannelConfig | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // V17: 标签页切换（通道列表 / 配对管理）
  const [activeTab, setActiveTab] = useState<'channels' | 'pairing'>('channels');

  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

  // 加载通道列表
  const loadChannels = useCallback(async () => {
    if (!isElectron) return;
    try {
      setLoading(true);
      const api = (window as any).electronAPI;
      const result = await api.channel.list();
      if (result?.success) {
        setChannels(result.data || []);
      }
    } catch (err) {
      console.error('加载通道失败:', err);
    } finally {
      setLoading(false);
    }
  }, [isElectron]);

  // 加载模板
  useEffect(() => {
    if (!isElectron) return;
    const api = (window as any).electronAPI;
    api.channel.templates().then((result: any) => {
      if (result?.success) setTemplates(result.data || {});
    }).catch(() => {});
  }, [isElectron]);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  // 保存通道
  const handleSave = useCallback(async (channel: ChannelConfig) => {
    if (!isElectron) return;
    try {
      const api = (window as any).electronAPI;
      const result = await api.channel.save(channel);
      if (result?.success) {
        showMessage('success', `通道 ${channel.id} 保存成功`);
        setShowAddModal(false);
        setEditingChannel(null);
        await loadChannels();
      } else {
        showMessage('error', result?.message || '保存失败');
      }
    } catch (err: any) {
      showMessage('error', err.message);
    }
  }, [isElectron, loadChannels]);

  // 删除通道
  const handleDelete = async (id: string) => {
    if (!isElectron) return;
    if (!confirm(`确定删除通道 ${id} 吗？`)) return;
    try {
      const api = (window as any).electronAPI;
      const result = await api.channel.delete(id);
      if (result?.success) {
        showMessage('success', `通道 ${id} 已删除`);
        await loadChannels();
      } else {
        showMessage('error', result?.message || '删除失败');
      }
    } catch (err: any) {
      showMessage('error', err.message);
    }
  };

  // 测试通道
  const handleTest = async (channel: ChannelConfig) => {
    if (!isElectron) return;
    try {
      const api = (window as any).electronAPI;
      const result = await api.channel.test(channel);
      if (result?.success) {
        showMessage('success', result.message);
      } else {
        showMessage('error', result?.message || '测试失败');
      }
    } catch (err: any) {
      showMessage('error', err.message);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 头部 + 标签页 */}
      <div style={{ padding: '24px 24px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={{ padding: 8, borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
          <div style={{ flex: 1 }}>
            <h1 className="title-decorate" style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#e2e8f0' }}>消息通道</h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>配置飞书、企微、钉钉、Telegram 等消息通道，管理配对码与已配对用户</p>
          </div>
          {activeTab === 'channels' && (
            <button onClick={() => { setEditingChannel(null); setShowAddModal(true); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, background: 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.1))', border: '1px solid rgba(6,182,212,.25)', cursor: 'pointer', color: '#06b6d4', fontSize: 13, fontWeight: 500 }}>
              <Plus style={{ width: 16, height: 16 }} />
              添加通道
            </button>
          )}
        </div>

        {/* 标签页切换栏 */}
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,.06)' }}>
          <TabButton active={activeTab === 'channels'} onClick={() => setActiveTab('channels')} icon={Radio} label="通道列表" />
          <TabButton active={activeTab === 'pairing'} onClick={() => setActiveTab('pairing')} icon={KeyRound} label="配对管理" />
        </div>
      </div>

      {/* 标签页内容 */}
      {activeTab === 'pairing' ? (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <PairingPage />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {/* 消息提示 */}
          {message && (
            <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 10, background: message.type === 'success' ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)', border: `1px solid ${message.type === 'success' ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`, color: message.type === 'success' ? '#10b981' : '#ef4444', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              {message.type === 'success' ? <CheckCircle style={{ width: 16, height: 16 }} /> : <XCircle style={{ width: 16, height: 16 }} />}
              {message.text}
            </div>
          )}

          {/* 通道列表 */}
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, color: '#475569' }}>
              <Loader2 style={{ width: 24, height: 24, animation: 'spin 1s linear infinite' }} />
            </div>
          ) : channels.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, color: '#475569' }}>
              <Radio style={{ width: 48, height: 48, marginBottom: 16, opacity: 0.3 }} />
              <div style={{ fontSize: 15, marginBottom: 8 }}>暂无消息通道</div>
              <div style={{ fontSize: 13, color: '#334155', marginBottom: 20 }}>点击"添加通道"开始配置</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
              {channels.map((ch) => {
                const Icon = CHANNEL_ICONS[ch.type] || Radio;
                const color = CHANNEL_COLORS[ch.type] || '#64748b';
                const template = templates[ch.type];
                return (
                  <div key={ch.id} style={{ background: 'rgba(255,255,255,.03)', borderRadius: 14, border: '1px solid rgba(255,255,255,.06)', padding: 18, transition: 'border-color .15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${color}30`; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.06)'; }}
                  >
                    {/* 通道头部 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}15`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon style={{ width: 20, height: 20, color }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 8 }}>
                          {ch.label || ch.id}
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: ch.enabled ? 'rgba(16,185,129,.15)' : 'rgba(100,116,139,.15)', color: ch.enabled ? '#10b981' : '#64748b', fontWeight: 500 }}>
                            {ch.enabled ? '已启用' : '已禁用'}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{template?.description || ch.type}</div>
                      </div>
                    </div>

                    {/* 通道信息 */}
                    <div style={{ fontSize: 12, color: '#475569', marginBottom: 14, lineHeight: 1.6 }}>
                      {ch.connectionMode && <div>模式: <span style={{ color: '#94a3b8' }}>{ch.connectionMode}</span></div>}
                      {ch.webhookUrl && <div>Webhook: <span style={{ color: '#94a3b8' }}>{ch.webhookUrl.substring(0, 50)}...</span></div>}
                      {/* P1-8 修复：敏感信息统一脱敏，仅保留最后 4 位 */}
                      {ch.botToken && <div>Token: <span style={{ color: '#94a3b8' }}>****{ch.botToken.slice(-4)}</span></div>}
                      {ch.appId && <div>App ID: <span style={{ color: '#94a3b8' }}>{ch.appId.length > 8 ? `${ch.appId.substring(0, 4)}****${ch.appId.slice(-4)}` : ch.appId}</span></div>}
                      {ch.appKey && <div>App Key: <span style={{ color: '#94a3b8' }}>****{ch.appKey.slice(-4)}</span></div>}
                      {ch.appSecret && <div>App Secret: <span style={{ color: '#94a3b8' }}>****{ch.appSecret.slice(-4)}</span></div>}
                      {ch.phoneNumberId && <div>Phone ID: <span style={{ color: '#94a3b8' }}>{ch.phoneNumberId}</span></div>}
                      {ch.corpId && <div>Corp ID: <span style={{ color: '#94a3b8' }}>{ch.corpId}</span></div>}
                      {ch.botId && <div>Bot ID: <span style={{ color: '#94a3b8' }}>{ch.botId}</span></div>}
                      {ch.signalNumber && <div>号码: <span style={{ color: '#94a3b8' }}>{ch.signalNumber}</span></div>}
                      {ch.serverUrl && <div>服务器: <span style={{ color: '#94a3b8' }}>{ch.serverUrl}</span></div>}
                      {ch.bridgeEmail && <div>邮箱: <span style={{ color: '#94a3b8' }}>{ch.bridgeEmail}</span></div>}
                      {ch.smtpHost && <div>SMTP: <span style={{ color: '#94a3b8' }}>{ch.smtpHost}:{ch.smtpPort}</span></div>}
                      {ch.dmPolicy && <div>访问策略: <span style={{ color: '#94a3b8' }}>{ch.dmPolicy}</span></div>}
                    </div>

                    {/* 操作按钮 */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => { setEditingChannel(ch); setShowAddModal(true); }} style={{ flex: 1, padding: '8px 12px', borderRadius: 8, background: 'rgba(6,182,212,.08)', border: '1px solid rgba(6,182,212,.15)', cursor: 'pointer', color: '#06b6d4', fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        编辑
                      </button>
                      <button onClick={() => handleTest(ch)} style={{ flex: 1, padding: '8px 12px', borderRadius: 8, background: 'rgba(139,92,246,.08)', border: '1px solid rgba(139,92,246,.15)', cursor: 'pointer', color: '#a78bfa', fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <TestTube2 style={{ width: 13, height: 13 }} />
                        测试
                      </button>
                      <button onClick={() => handleDelete(ch.id)} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.15)', cursor: 'pointer', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Trash2 style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 添加/编辑弹窗 */}
          {showAddModal && (
            <ChannelModal
              templates={templates}
              editingChannel={editingChannel}
              onSave={handleSave}
              onClose={() => { setShowAddModal(false); setEditingChannel(null); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ===== 标签页按钮 =====
function TabButton({ active, onClick, icon: Icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 18px', cursor: 'pointer',
        background: 'transparent', border: 'none', borderBottom: active ? '2px solid #06b6d4' : '2px solid transparent',
        color: active ? '#06b6d4' : '#64748b',
        fontSize: 13, fontWeight: active ? 600 : 400, fontFamily: 'inherit',
        transition: 'color .15s, border-color .15s',
        marginBottom: -1,
      }}
    >
      <Icon style={{ width: 15, height: 15 }} />
      {label}
    </button>
  );
}

// ===== 通道添加/编辑弹窗 =====
const ChannelModal = React.memo(function ChannelModal({ templates, editingChannel, onSave, onClose }: {
  templates: Record<string, ChannelTemplate>;
  editingChannel: ChannelConfig | null;
  onSave: (channel: ChannelConfig) => void;
  onClose: () => void;
}) {
  const [selectedType, setSelectedType] = useState(editingChannel?.type || '');
  const [config, setConfig] = useState<Record<string, any>>(editingChannel || {});
  const [testing, setTesting] = useState(false);
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

  const template = useMemo(() => templates[selectedType], [templates, selectedType]);

  // 生成通道 ID
  const generateId = (type: string) => {
    const existing = ['main', 'default', 'primary'];
    let id = type;
    let counter = 1;
    while (existing.includes(id)) {
      id = `${type}-${counter}`;
      counter++;
    }
    return id;
  };

  const handleFieldChange = useCallback((key: string, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  }, []);

  // P2-1 修复：通道配置校验函数
  const validateConfig = (): { ok: boolean; error?: string } => {
    if (!selectedType) return { ok: false, error: '请选择通道类型' };

    // 校验通道 ID（仅新增时）
    if (!editingChannel && config.id) {
      const id = String(config.id).trim();
      if (id.length < 1 || id.length > 64) {
        return { ok: false, error: '通道 ID 长度必须在 1-64 之间' };
      }
      if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
        return { ok: false, error: '通道 ID 只能包含字母、数字、下划线、横线' };
      }
    }

    // 校验显示名称长度
    if (config.label && String(config.label).length > 128) {
      return { ok: false, error: '显示名称长度不能超过 128 字符' };
    }

    // 根据模板必填字段校验
    if (template?.fields) {
      for (const field of template.fields) {
        if (field.required) {
          const val = config[field.key];
          if (val === undefined || val === null || String(val).trim() === '') {
            return { ok: false, error: `字段「${field.label}」为必填项` };
          }
        }
      }
    }

    // 通用敏感字段校验（token/secret/key 类）
    const sensitiveKeys = ['botToken', 'appSecret', 'appKey', 'secret', 'accessToken',
      'signingSecret', 'appToken', 'token', 'mattermostAccessToken', 'appPassword',
      'smtpPass', 'encodingAesKey', 'encryptKey', 'webhookSecret', 'verifyToken',
      'verificationToken', 'apiKey'];
    for (const key of sensitiveKeys) {
      if (config[key]) {
        const val = String(config[key]);
        if (val.length > 1024) {
          return { ok: false, error: `字段「${key}」长度超限（最多 1024 字符）` };
        }
        if (/\s/.test(val)) {
          return { ok: false, error: `字段「${key}」不能包含空格` };
        }
        if (/[\x00-\x1f\x7f]/.test(val)) {
          return { ok: false, error: `字段「${key}」不能包含控制字符` };
        }
        if (/<script|javascript:|on\w+\s*=/i.test(val)) {
          return { ok: false, error: `字段「${key}」包含非法字符` };
        }
      }
    }

    // URL 字段校验
    const urlKeys = ['webhookUrl', 'serverUrl', 'domain'];
    for (const key of urlKeys) {
      if (config[key]) {
        const val = String(config[key]).trim();
        if (val.length > 512) {
          return { ok: false, error: `字段「${key}」URL 长度超限` };
        }
        // webhookUrl/serverUrl 必须是 http(s)://
        if (key !== 'domain' && !/^https?:\/\//i.test(val)) {
          return { ok: false, error: `字段「${key}」必须以 http:// 或 https:// 开头` };
        }
        if (key === 'webhookUrl' || key === 'serverUrl') {
          try {
            // eslint-disable-next-line no-new
            new URL(val);
          } catch {
            return { ok: false, error: `字段「${key}」URL 格式不合法` };
          }
        }
      }
    }

    // 主机名字段校验
    const hostKeys = ['smtpHost', 'imapHost', 'imapServer', 'smtpServer'];
    for (const key of hostKeys) {
      if (config[key]) {
        const val = String(config[key]).trim();
        if (val.length > 255) {
          return { ok: false, error: `字段「${key}」长度超限` };
        }
        if (/\s/.test(val)) {
          return { ok: false, error: `字段「${key}」不能包含空格` };
        }
        // 简单主机名/IPv4 校验
        const hostOk = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$/.test(val)
          || /^(\d{1,3}\.){3}\d{1,3}$/.test(val);
        if (!hostOk) {
          return { ok: false, error: `字段「${key}」主机名格式不合法` };
        }
      }
    }

    // 端口字段校验
    const portKeys = ['smtpPort', 'imapPort'];
    for (const key of portKeys) {
      if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
        const port = Number(config[key]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { ok: false, error: `字段「${key}」必须是 1-65535 之间的整数` };
        }
      }
    }

    // 通用字符串字段长度校验（防超长输入）
    const maxLenKeys = ['appId', 'botId', 'robotCode', 'guildId', 'channelId',
      'corpId', 'agentId', 'phoneNumberId', 'botUsername', 'bridgeEmail',
      'smtpUser', 'smtpFrom', 'signalNumber', 'signalCliPath', 'configDir',
      'botName', 'apiVersion', 'connectionMode'];
    for (const key of maxLenKeys) {
      if (config[key] && String(config[key]).length > 256) {
        return { ok: false, error: `字段「${key}」长度超限（最多 256 字符）` };
      }
    }

    return { ok: true };
  };

  const handleSave = () => {
    if (!selectedType) return;

    // P2-1 修复：保存前校验
    const validation = validateConfig();
    if (!validation.ok) {
      alert('❌ 校验失败：' + validation.error);
      return;
    }

    const id = editingChannel?.id || config.id || generateId(selectedType);
    // 将白名单字符串转换为数组
    const allowFrom = typeof config.allowFromStr === 'string'
      ? config.allowFromStr.split(',').map((s: string) => s.trim()).filter(Boolean)
      : config.allowFrom;
    const { allowFromStr, ...rest } = config;
    const channel: ChannelConfig = {
      id,
      type: selectedType,
      label: config.label || templates[selectedType]?.label || id,
      enabled: config.enabled ?? true,
      ...rest,
      ...(allowFrom && allowFrom.length > 0 ? { allowFrom } : {}),
    };
    // 清理空值
    Object.keys(channel).forEach(k => {
      if (channel[k as keyof ChannelConfig] === '' || channel[k as keyof ChannelConfig] === undefined) {
        delete channel[k as keyof ChannelConfig];
      }
    });
    channel.id = id;
    channel.type = selectedType;
    onSave(channel);
  };

  const handleTest = async () => {
    if (!isElectron) return;

    // P2-1 修复：测试前校验
    const validation = validateConfig();
    if (!validation.ok) {
      alert('❌ 校验失败：' + validation.error);
      return;
    }

    setTesting(true);
    try {
      const api = (window as any).electronAPI;
      const result = await api.channel.test({ type: selectedType, ...config });
      if (result?.success) {
        alert('✅ ' + result.message);
      } else {
        alert('❌ ' + (result?.message || '测试失败'));
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onClose}>
      <div style={{ width: '90vw', maxWidth: 600, maxHeight: '85vh', background: 'rgba(15,20,35,.95)', borderRadius: 16, border: '1px solid rgba(255,255,255,.1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        {/* 弹窗头部 */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>{editingChannel ? '编辑通道' : '添加消息通道'}</h2>
          <button onClick={onClose} style={{ padding: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
            <XCircle style={{ width: 20, height: 20 }} />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {/* 通道类型选择（仅新增时） */}
          {!editingChannel && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 8, display: 'block' }}>选择通道类型</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {Object.entries(templates).map(([key, tpl]) => {
                  const Icon = CHANNEL_ICONS[key] || Radio;
                  const color = CHANNEL_COLORS[key] || '#64748b';
                  return (
                    <button key={key} onClick={() => { setSelectedType(key); setConfig({}); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, background: selectedType === key ? `${color}15` : 'rgba(255,255,255,.03)', border: `1px solid ${selectedType === key ? color + '40' : 'rgba(255,255,255,.06)'}`, cursor: 'pointer', textAlign: 'left', transition: 'all .15s' }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon style={{ width: 16, height: 16, color }} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: selectedType === key ? color : '#e2e8f0' }}>{tpl.label}</div>
                        <div style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 通道字段配置 */}
          {template && (
            <>
              {/* 通道 ID（仅新增时） */}
              {!editingChannel && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 6, display: 'block' }}>通道 ID</label>
                  <input type="text" value={config.id || ''} onChange={(e) => handleFieldChange('id', e.target.value)} placeholder={selectedType} style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }} />
                </div>
              )}

              {/* 显示名称 */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 6, display: 'block' }}>显示名称</label>
                <input type="text" value={config.label || ''} onChange={(e) => handleFieldChange('label', e.target.value)} placeholder={template.label} style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }} />
              </div>

              {/* 启用开关 */}
              <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,.06)' }}>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>启用此通道</span>
                <button onClick={() => handleFieldChange('enabled', !config.enabled)} style={{ width: 40, height: 22, borderRadius: 11, background: config.enabled !== false ? '#06b6d4' : '#334155', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background .2s' }}>
                  <div style={{ position: 'absolute', top: 2, left: config.enabled !== false ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
                </button>
              </div>

              {/* 动态字段 */}
              {template.fields.map((field) => (
                <div key={field.key} style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {field.label}
                    {field.required && <span style={{ color: '#ef4444', fontSize: 11 }}>*</span>}
                  </label>
                  {field.type === 'select' && field.options ? (
                    <select
                      value={config[field.key] ?? field.default ?? ''}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }}
                    >
                      <option value="">请选择...</option>
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                      value={config[field.key] ?? field.default ?? ''}
                      onChange={(e) => handleFieldChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                      placeholder={field.placeholder || ''}
                      style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }}
                    />
                  )}
                  {field.help && <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{field.help}</div>}
                </div>
              ))}

              {/* 访问控制（仅支持 accessControl 的通道） */}
              {template.accessControl && (
                <>
                  <div style={{ height: 1, background: 'rgba(255,255,255,.06)', margin: '20px 0' }} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 12 }}>访问控制</div>

                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 6, display: 'block' }}>私聊策略 (dmPolicy)</label>
                    <select value={config.dmPolicy || 'pairing'} onChange={(e) => handleFieldChange('dmPolicy', e.target.value)} style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }}>
                      <option value="pairing">配对模式（默认，陌生用户收到配对码）</option>
                      <option value="allowlist">白名单模式（仅允许 allowFrom 列表用户）</option>
                      <option value="open">开放模式（允许所有人）</option>
                      <option value="disabled">禁用私聊</option>
                    </select>
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 6, display: 'block' }}>群组策略 (groupPolicy)</label>
                    <select value={config.groupPolicy || 'allowlist'} onChange={(e) => handleFieldChange('groupPolicy', e.target.value)} style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }}>
                      <option value="allowlist">白名单模式（仅允许 groupAllowFrom 用户）</option>
                      <option value="open">开放模式（允许群组所有人）</option>
                      <option value="disabled">禁用群组消息</option>
                    </select>
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginBottom: 6, display: 'block' }}>白名单用户 ID（逗号分隔）</label>
                    <input type="text" value={config.allowFromStr ?? (Array.isArray(config.allowFrom) ? config.allowFrom.join(',') : '')} onChange={(e) => handleFieldChange('allowFromStr', e.target.value)} placeholder="user1, user2, *" style={{ width: '100%', padding: '10px 14px', fontSize: 14, background: 'rgba(255,255,255,.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)', outline: 'none', color: '#e2e8f0', boxSizing: 'border-box' }} />
                  </div>

                  <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,.06)' }}>
                    <div>
                      <span style={{ fontSize: 13, color: '#94a3b8' }}>需要 @提及才响应</span>
                      <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>群组中需要 @机器人 才会响应</div>
                    </div>
                    <button onClick={() => handleFieldChange('requireMention', !config.requireMention)} style={{ width: 40, height: 22, borderRadius: 11, background: config.requireMention ? '#06b6d4' : '#334155', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background .2s' }}>
                      <div style={{ position: 'absolute', top: 2, left: config.requireMention ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* 弹窗底部 */}
        {template && (
          <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(255,255,255,.06)', display: 'flex', gap: 10 }}>
            <button onClick={handleTest} disabled={testing} style={{ padding: '10px 16px', borderRadius: 10, background: 'rgba(139,92,246,.1)', border: '1px solid rgba(139,92,246,.2)', cursor: testing ? 'wait' : 'pointer', color: '#a78bfa', fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
              {testing ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} /> : <TestTube2 style={{ width: 14, height: 14 }} />}
              测试
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={onClose} style={{ padding: '10px 16px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', cursor: 'pointer', color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
              取消
            </button>
            <button onClick={handleSave} style={{ padding: '10px 20px', borderRadius: 10, background: 'linear-gradient(135deg, #06b6d4, #3b82f6)', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Save style={{ width: 14, height: 14 }} />
              保存
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
