import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft, KeyRound, UserPlus, Trash2, CheckCircle, XCircle, Loader2,
  Copy, Clock, Users, BarChart3, Radio, MessageSquare, Bell, Send,
  Hash, Mail, Webhook, Phone, MessageCircle, Briefcase,
} from 'lucide-react';

// 通道类型图标映射（与 ChannelsPage 保持一致）
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
  wechat: MessageCircle,
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
  wechat: '#07c160',
  signal: '#3a76f0',
  mattermost: '#0058cc',
  imessage: '#34c759',
};

interface PairedUser {
  channelType: string;
  userId: string;
  displayName?: string;
  pairedAt: string;
  pairedByCode: string;
}

interface PairingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  note?: string;
}

interface PairingStatus {
  totalPairedUsers: number;
  pendingCodes: number;
  byChannel: Record<string, number>;
}

// 格式化剩余时间（mm:ss）
function formatRemaining(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt - now);
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// 格式化 ISO 时间为可读字符串
function formatISOTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function PairingPage({ onBack }: { onBack?: () => void }) {
  const [pairedUsers, setPairedUsers] = useState<PairedUser[]>([]);
  const [pendingCodes, setPendingCodes] = useState<PairingCode[]>([]);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [filterChannel, setFilterChannel] = useState<string>('');
  const [generatedCode, setGeneratedCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [showWhitelistModal, setShowWhitelistModal] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState<PairedUser | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // 每秒更新当前时间（用于倒计时显示）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const showMessage = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  // 加载所有配对数据
  const loadData = useCallback(async () => {
    try {
      const isE = typeof window !== 'undefined' && !!(window as any).electronAPI;
      const api = (window as any).electronAPI;

      let usersRes: any, codesRes: any, statusRes: any;
      if (isE && api?.pairing) {
        // Electron 模式：通过 IPC 转发
        [usersRes, codesRes, statusRes] = await Promise.all([
          api.pairing.users(),
          api.pairing.codes(),
          api.pairing.status(),
        ]);
      } else {
        // Web 模式：直接 fetch
        const safeJson = async (resp: Response) => {
          if (!resp.ok) return null;
          try { return await resp.json(); } catch { return null; }
        };
        [usersRes, codesRes, statusRes] = await Promise.all([
          fetch('/api/pairing/users').then(safeJson).catch(() => null),
          fetch('/api/pairing/codes').then(safeJson).catch(() => null),
          fetch('/api/pairing/status').then(safeJson).catch(() => null),
        ]);
      }
      if (usersRes?.success) setPairedUsers(usersRes.users || []);
      if (codesRes?.success) setPendingCodes(codesRes.codes || []);
      if (statusRes?.success) {
        setStatus({
          totalPairedUsers: statusRes.totalPairedUsers || 0,
          pendingCodes: statusRes.pendingCodes || 0,
          byChannel: statusRes.byChannel || {},
        });
      }
    } catch (err) {
      console.error('加载配对数据失败:', err);
      showMessage('error', '加载配对数据失败');
    }
  }, [showMessage]);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  // 生成配对码
  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const isE = typeof window !== 'undefined' && !!(window as any).electronAPI;
      const api = (window as any).electronAPI;
      let data: any;
      if (isE && api?.pairing) {
        // Electron 模式：通过 IPC 转发
        data = await api.pairing.generate('');
      } else {
        // Web 模式：直接 fetch
        const resp = await fetch('/api/pairing/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        data = await resp.json();
      }
      if (data?.success) {
        setGeneratedCode({
          code: data.code,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        showMessage('success', '配对码已生成');
        await loadData();
      } else {
        showMessage('error', data?.error || '生成配对码失败');
      }
    } catch (err) {
      console.error('生成配对码失败:', err);
      showMessage('error', '生成配对码失败');
    } finally {
      setGenerating(false);
    }
  };

  // 解除配对
  const handleUnpair = async (user: PairedUser) => {
    try {
      const isE = typeof window !== 'undefined' && !!(window as any).electronAPI;
      if (isE) {
        const api = (window as any).electronAPI;
        if (api?.pairing?.unpair) {
          const result = await api.pairing.unpair(user.channelType, user.userId);
          if (result?.success) {
            showMessage('success', `已解除 ${user.displayName || user.userId} 的配对`);
            await loadData();
          } else {
            showMessage('error', result?.error || result?.message || '解除配对失败');
          }
          setConfirmUnpair(null);
          return;
        }
      }
      const resp = await fetch(
        `/api/pairing/users/${encodeURIComponent(user.channelType)}/${encodeURIComponent(user.userId)}`,
        { method: 'DELETE' }
      );
      const data = await resp.json();
      if (data?.success) {
        showMessage('success', `已解除 ${user.displayName || user.userId} 的配对`);
        await loadData();
      } else {
        showMessage('error', data?.message || data?.error || '解除配对失败');
      }
    } catch (err) {
      console.error('解除配对失败:', err);
      showMessage('error', '解除配对失败');
    }
    setConfirmUnpair(null);
  };

  // 添加白名单
  const handleAddWhitelist = async (channelType: string, userId: string, displayName: string) => {
    try {
      // Electron 模式下也通过 HTTP 调用本地 Agent 服务器（main.js 中无专门 whitelist IPC）
      const resp = await fetch('/api/pairing/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelType, userId, displayName: displayName || undefined }),
      });
      const data = await resp.json();
      if (data?.success) {
        showMessage('success', '已添加到白名单');
        setShowWhitelistModal(false);
        await loadData();
      } else {
        showMessage('error', data?.error || '添加白名单失败');
      }
    } catch (err) {
      console.error('添加白名单失败:', err);
      showMessage('error', '添加白名单失败');
    }
  };

  // 复制到剪贴板
  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (err) {
      console.error('复制失败:', err);
      showMessage('error', '复制失败');
    }
  };

  // 筛选已配对用户
  const filteredUsers = filterChannel
    ? pairedUsers.filter(u => u.channelType === filterChannel)
    : pairedUsers;

  // 过滤掉已过期的配对码（前端实时过滤）
  const activePendingCodes = pendingCodes.filter(c => c.expiresAt > now);

  // 获取所有通道类型（用于筛选下拉框）
  const channelTypes = Object.keys(status?.byChannel || {});

  // 渲染通道图标
  const renderChannelIcon = (channelType: string, iconSize: number = 16) => {
    const Icon = CHANNEL_ICONS[channelType] || Radio;
    const color = CHANNEL_COLORS[channelType] || '#64748b';
    return (
      <div style={{
        width: iconSize + 8, height: iconSize + 8, borderRadius: 6,
        background: `${color}15`, border: `1px solid ${color}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon style={{ width: iconSize, height: iconSize, color }} />
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: onBack ? 24 : '0 24px 24px', overflow: 'auto' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, paddingTop: onBack ? 0 : 16 }}>
        {onBack && (
          <button onClick={onBack} style={{
            padding: 8, borderRadius: 10,
            background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
            cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center',
          }}>
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
        )}
        <div style={{ flex: 1 }}>
          {onBack && (
            <>
              <h1 className="title-decorate" style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#e2e8f0' }}>配对管理</h1>
              <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>生成配对码、管理已配对用户和白名单</p>
            </>
          )}
        </div>
        <button onClick={() => setShowWhitelistModal(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10,
          background: 'rgba(139,92,246,.1)', border: '1px solid rgba(139,92,246,.2)',
          cursor: 'pointer', color: '#a78bfa', fontSize: 13, fontWeight: 500,
        }}>
          <UserPlus style={{ width: 16, height: 16 }} />
          添加白名单
        </button>
        <button onClick={handleGenerate} disabled={generating} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.1))',
          border: '1px solid rgba(6,182,212,.25)',
          cursor: generating ? 'wait' : 'pointer', color: '#06b6d4', fontSize: 13, fontWeight: 500,
        }}>
          {generating ? <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} /> : <KeyRound style={{ width: 16, height: 16 }} />}
          生成配对码
        </button>
      </div>

      {/* 消息提示 */}
      {message && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 10,
          background: message.type === 'success' ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
          border: `1px solid ${message.type === 'success' ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`,
          color: message.type === 'success' ? '#10b981' : '#ef4444',
          fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {message.type === 'success' ? <CheckCircle style={{ width: 16, height: 16 }} /> : <XCircle style={{ width: 16, height: 16 }} />}
          {message.text}
        </div>
      )}

      {/* 状态概览 */}
      {status && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
          <div style={{ padding: 16, borderRadius: 12, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Users style={{ width: 16, height: 16, color: '#06b6d4' }} />
              <span style={{ fontSize: 12, color: '#94a3b8' }}>已配对用户</span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#e2e8f0' }}>{status.totalPairedUsers}</div>
          </div>
          <div style={{ padding: 16, borderRadius: 12, background: 'rgba(139,92,246,.04)', border: '1px solid rgba(139,92,246,.1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <KeyRound style={{ width: 16, height: 16, color: '#a78bfa' }} />
              <span style={{ fontSize: 12, color: '#94a3b8' }}>待使用配对码</span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#e2e8f0' }}>{status.pendingCodes}</div>
          </div>
          <div style={{ padding: 16, borderRadius: 12, background: 'rgba(16,185,129,.04)', border: '1px solid rgba(16,185,129,.1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <BarChart3 style={{ width: 16, height: 16, color: '#10b981' }} />
              <span style={{ fontSize: 12, color: '#94a3b8' }}>通道数</span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#e2e8f0' }}>{Object.keys(status?.byChannel || {}).length}</div>
          </div>
        </div>
      )}

      {/* 按通道统计 */}
      {status && status.byChannel && Object.keys(status.byChannel).length > 0 && (
        <div style={{
          marginBottom: 24, padding: 16, borderRadius: 12,
          background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 12 }}>按通道统计</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(status?.byChannel || {}).map(([ch, count]) => {
              const color = CHANNEL_COLORS[ch] || '#64748b';
              return (
                <div key={ch} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
                  background: `${color}0a`, border: `1px solid ${color}20`,
                }}>
                  {renderChannelIcon(ch, 12)}
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{ch}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color }}>{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 待使用配对码 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <KeyRound style={{ width: 16, height: 16, color: '#a78bfa' }} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>待使用配对码</h2>
          <span style={{ fontSize: 12, color: '#64748b' }}>({activePendingCodes.length})</span>
        </div>
        {activePendingCodes.length === 0 ? (
          <div style={{
            padding: 20, borderRadius: 12,
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
            textAlign: 'center', color: '#475569', fontSize: 13,
          }}>
            暂无待使用配对码，点击"生成配对码"创建
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {activePendingCodes.map((pc) => {
              const remaining = formatRemaining(pc.expiresAt, now);
              const isExpiringSoon = pc.expiresAt - now < 60000;
              return (
                <div key={pc.code} style={{
                  padding: 16, borderRadius: 12,
                  background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{
                      fontSize: 24, fontWeight: 700, color: '#06b6d4',
                      fontFamily: 'monospace, monospace', letterSpacing: 4,
                    }}>{pc.code}</span>
                    <button onClick={() => handleCopy(pc.code)} style={{
                      padding: 4, borderRadius: 6,
                      background: copiedCode === pc.code ? 'rgba(16,185,129,.1)' : 'rgba(255,255,255,.04)',
                      border: '1px solid rgba(255,255,255,.08)',
                      cursor: 'pointer',
                      color: copiedCode === pc.code ? '#10b981' : '#94a3b8',
                      display: 'flex', alignItems: 'center',
                    }}>
                      {copiedCode === pc.code ? <CheckCircle style={{ width: 14, height: 14 }} /> : <Copy style={{ width: 14, height: 14 }} />}
                    </button>
                  </div>
                  {pc.note && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>备注: {pc.note}</div>}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
                    color: isExpiringSoon ? '#ef4444' : '#475569',
                  }}>
                    <Clock style={{ width: 11, height: 11 }} />
                    {isExpiringSoon ? '即将过期 ' : '剩余 '}{remaining}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 已配对用户 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Users style={{ width: 16, height: 16, color: '#06b6d4' }} />
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>已配对用户</h2>
          <span style={{ fontSize: 12, color: '#64748b' }}>({filteredUsers.length})</span>
          <div style={{ flex: 1 }} />
          {/* 通道筛选 */}
          <select
            value={filterChannel}
            onChange={(e) => setFilterChannel(e.target.value)}
            style={{
              padding: '6px 12px', fontSize: 12,
              background: 'rgba(255,255,255,.04)', borderRadius: 8,
              border: '1px solid rgba(255,255,255,.08)', outline: 'none',
              color: '#e2e8f0', cursor: 'pointer',
            }}
          >
            <option value="">全部通道</option>
            {channelTypes.map(ch => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, color: '#475569' }}>
            <Loader2 style={{ width: 24, height: 24, animation: 'spin 1s linear infinite' }} />
          </div>
        ) : filteredUsers.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 60, color: '#475569',
          }}>
            <Users style={{ width: 48, height: 48, marginBottom: 16, opacity: 0.3 }} />
            <div style={{ fontSize: 15, marginBottom: 8 }}>暂无已配对用户</div>
            <div style={{ fontSize: 13, color: '#334155' }}>生成配对码或添加白名单开始</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredUsers.map((user) => {
              const color = CHANNEL_COLORS[user.channelType] || '#64748b';
              return (
                <div
                  key={`${user.channelType}:${user.userId}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 10,
                    background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
                    transition: 'border-color .15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${color}30`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.06)'; }}
                >
                  {renderChannelIcon(user.channelType, 18)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
                        {user.displayName || user.userId}
                      </span>
                      <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: `${color}15`, color, fontWeight: 500,
                      }}>{user.channelType}</span>
                      {user.pairedByCode === 'manual' && (
                        <span style={{
                          fontSize: 10, padding: '2px 6px', borderRadius: 4,
                          background: 'rgba(139,92,246,.15)', color: '#a78bfa', fontWeight: 500,
                        }}>手动添加</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: '#475569' }}>
                      <span>ID: {user.userId}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Clock style={{ width: 10, height: 10 }} />
                        {formatISOTime(user.pairedAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setConfirmUnpair(user)}
                    style={{
                      padding: '8px 12px', borderRadius: 8,
                      background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.15)',
                      cursor: 'pointer', color: '#ef4444', fontSize: 12, fontWeight: 500,
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <Trash2 style={{ width: 13, height: 13 }} />
                    解除配对
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 生成配对码弹窗（醒目显示） */}
      {generatedCode && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
          onClick={() => setGeneratedCode(null)}
        >
          <div
            style={{
              width: '90vw', maxWidth: 480,
              background: 'rgba(15,20,35,.95)', borderRadius: 16,
              border: '1px solid rgba(6,182,212,.2)', padding: 32, textAlign: 'center',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
              <KeyRound style={{ width: 20, height: 20, color: '#06b6d4' }} />
              <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>配对码已生成</h2>
            </div>
            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 24px' }}>
              将此配对码发送给用户，用户在聊天中输入即可完成配对
            </p>
            {/* 醒目显示配对码（大字号） */}
            <div style={{
              padding: '24px 16px', borderRadius: 12,
              background: 'linear-gradient(135deg, rgba(6,182,212,.08), rgba(139,92,246,.06))',
              border: '1px solid rgba(6,182,212,.2)', marginBottom: 16,
            }}>
              <div style={{
                fontSize: 56, fontWeight: 800, color: '#06b6d4',
                fontFamily: 'monospace, monospace', letterSpacing: 12,
                textShadow: '0 0 20px rgba(6,182,212,.4)',
              }}>
                {generatedCode.code}
              </div>
            </div>
            {/* 倒计时 */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              marginBottom: 24, fontSize: 13,
              color: generatedCode.expiresAt - now < 60000 ? '#ef4444' : '#94a3b8',
            }}>
              <Clock style={{ width: 14, height: 14 }} />
              <span>
                {generatedCode.expiresAt - now > 0
                  ? `剩余 ${formatRemaining(generatedCode.expiresAt, now)}（5分钟有效）`
                  : '已过期'}
              </span>
            </div>
            {/* 操作按钮 */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button
                onClick={() => handleCopy(generatedCode.code)}
                style={{
                  padding: '10px 20px', borderRadius: 10,
                  background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.2)',
                  cursor: 'pointer', color: '#06b6d4', fontSize: 13, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {copiedCode === generatedCode.code ? <CheckCircle style={{ width: 14, height: 14 }} /> : <Copy style={{ width: 14, height: 14 }} />}
                {copiedCode === generatedCode.code ? '已复制' : '复制配对码'}
              </button>
              <button
                onClick={() => setGeneratedCode(null)}
                style={{
                  padding: '10px 20px', borderRadius: 10,
                  background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                  border: 'none', cursor: 'pointer', color: '#fff', fontSize: 13, fontWeight: 600,
                }}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 添加白名单弹窗 */}
      {showWhitelistModal && (
        <WhitelistModal onAdd={handleAddWhitelist} onClose={() => setShowWhitelistModal(false)} />
      )}

      {/* 解除配对确认弹窗 */}
      {confirmUnpair && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
          onClick={() => setConfirmUnpair(null)}
        >
          <div
            style={{
              width: '90vw', maxWidth: 420,
              background: 'rgba(15,20,35,.95)', borderRadius: 16,
              border: '1px solid rgba(239,68,68,.2)', padding: 24,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Trash2 style={{ width: 20, height: 20, color: '#ef4444' }} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>确认解除配对</h3>
                <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0' }}>解除后用户将无法与 Agent 通信</p>
              </div>
            </div>
            <div style={{
              padding: 14, borderRadius: 10,
              background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)',
              marginBottom: 20,
            }}>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
                <span style={{ color: '#64748b' }}>通道:</span> {confirmUnpair.channelType}
              </div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
                <span style={{ color: '#64748b' }}>用户 ID:</span> {confirmUnpair.userId}
              </div>
              {confirmUnpair.displayName && (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>
                  <span style={{ color: '#64748b' }}>显示名:</span> {confirmUnpair.displayName}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmUnpair(null)}
                style={{
                  padding: '10px 16px', borderRadius: 10,
                  background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
                  cursor: 'pointer', color: '#94a3b8', fontSize: 13, fontWeight: 500,
                }}
              >
                取消
              </button>
              <button
                onClick={() => handleUnpair(confirmUnpair)}
                style={{
                  padding: '10px 16px', borderRadius: 10,
                  background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.2)',
                  cursor: 'pointer', color: '#ef4444', fontSize: 13, fontWeight: 600,
                }}
              >
                确认解除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 添加白名单弹窗 =====
function WhitelistModal({ onAdd, onClose }: {
  onAdd: (channelType: string, userId: string, displayName: string) => void;
  onClose: () => void;
}) {
  const [channelType, setChannelType] = useState('');
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');

  const canSubmit = channelType.trim() !== '' && userId.trim() !== '';

  const handleSubmit = () => {
    if (!canSubmit) return;
    onAdd(channelType.trim(), userId.trim(), displayName.trim());
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '90vw', maxWidth: 480,
          background: 'rgba(15,20,35,.95)', borderRadius: 16,
          border: '1px solid rgba(255,255,255,.1)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserPlus style={{ width: 18, height: 18, color: '#a78bfa' }} />
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>添加白名单用户</h2>
          </div>
          <button onClick={onClose} style={{
            padding: 4, background: 'transparent', border: 'none',
            cursor: 'pointer', color: '#64748b',
          }}>
            <XCircle style={{ width: 20, height: 20 }} />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div style={{ padding: 24 }}>
          {/* 通道类型 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              fontSize: 13, fontWeight: 500, color: '#94a3b8',
              marginBottom: 6, display: 'block',
            }}>
              通道类型 <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <select
              value={channelType}
              onChange={(e) => setChannelType(e.target.value)}
              style={{
                width: '100%', padding: '10px 14px', fontSize: 14,
                background: 'rgba(255,255,255,.04)', borderRadius: 8,
                border: '1px solid rgba(255,255,255,.08)', outline: 'none',
                color: '#e2e8f0', boxSizing: 'border-box',
              }}
            >
              <option value="">请选择通道...</option>
              {Object.keys(CHANNEL_ICONS).map(ch => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
          </div>

          {/* 用户 ID */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              fontSize: 13, fontWeight: 500, color: '#94a3b8',
              marginBottom: 6, display: 'block',
            }}>
              用户 ID <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="如 open_id / chat_id / user_id"
              style={{
                width: '100%', padding: '10px 14px', fontSize: 14,
                background: 'rgba(255,255,255,.04)', borderRadius: 8,
                border: '1px solid rgba(255,255,255,.08)', outline: 'none',
                color: '#e2e8f0', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* 显示名 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              fontSize: 13, fontWeight: 500, color: '#94a3b8',
              marginBottom: 6, display: 'block',
            }}>
              显示名（可选）
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="如 张三"
              style={{
                width: '100%', padding: '10px 14px', fontSize: 14,
                background: 'rgba(255,255,255,.04)', borderRadius: 8,
                border: '1px solid rgba(255,255,255,.08)', outline: 'none',
                color: '#e2e8f0', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* 弹窗底部 */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid rgba(255,255,255,.06)',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button onClick={onClose} style={{
            padding: '10px 16px', borderRadius: 10,
            background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
            cursor: 'pointer', color: '#94a3b8', fontSize: 13, fontWeight: 500,
          }}>
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: '10px 20px', borderRadius: 10,
              background: canSubmit ? 'linear-gradient(135deg, #8b5cf6, #6366f1)' : 'rgba(139,92,246,.05)',
              border: 'none',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              color: canSubmit ? '#fff' : '#475569',
              fontSize: 13, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <UserPlus style={{ width: 14, height: 14 }} />
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
