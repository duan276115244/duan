import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, Server, Store, Shield, Loader2, CheckCircle, Download, Trash2, RefreshCw, Clock, X, Lock, AlertTriangle, Filter } from 'lucide-react';

// ===== 类型 =====
interface McpPlugin {
  id: string;
  name: string;
  description: string;
  author?: string;
  version?: string;
  type?: 'mcp-server' | 'tool-bundle';
  category?: string;
  tags?: string[];
  rating?: number;
  downloads?: number;
  trustLevel?: 'trusted' | 'verified' | 'untrusted' | 'blocked';
  enabled?: boolean;
  installStatus?: 'installed' | 'available';
  // ===== 富卡片增强字段（后端已富，前端优雅读取，缺失则跳过）=====
  ratingCount?: number;
  lastUpdated?: string;
  compatibility?: string;
  permissions?: string[];
  signature?: { signedBy?: string; valid?: boolean };
  maintenanceStatus?: 'active' | 'maintained' | 'deprecated' | 'unknown';
}

interface PendingApproval {
  approvalId: string;
  serverId: string;
  toolName: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  argsSummary: string;
  expiresInSeconds: number;
}

interface SecurityStatus {
  totalPlugins?: number;
  trusted?: number;
  blocked?: number;
  pending?: number;
}

// ===== API 辅助 =====
const API_BASE = ''; // 同源

async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function apiPost(path: string, body?: unknown): Promise<{ success: boolean; message?: string; error?: string }> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ===== 主组件 =====
export function McpManagePage({ onBack }: { onBack?: () => void }) {
  const [tab, setTab] = useState<'servers' | 'market' | 'security'>('servers');
  const [installed, setInstalled] = useState<McpPlugin[]>([]);
  const [marketPlugins, setMarketPlugins] = useState<McpPlugin[]>([]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus>({});
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // ===== 市场 Tab 富功能 state =====
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'rating' | 'downloads' | 'lastUpdated'>('rating');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.electronAPI;
      const useIpc = !!api?.mcp?.listMarketplace;
      // Electron 模式优先 IPC（生产 file:// origin 无法裸 fetch /api）；Web 模式回退 fetch
      const installedP: Promise<{ success: boolean; plugins?: McpPlugin[] }> = useIpc
        ? api!.mcp.listInstalled()
        : apiGet<{ success: boolean; plugins: McpPlugin[] }>('/api/mcp/marketplace/installed');
      const marketP: Promise<{ success: boolean; plugins?: McpPlugin[] }> = useIpc
        ? api!.mcp.listMarketplace()
        : apiGet<{ success: boolean; plugins: McpPlugin[] }>('/api/mcp/marketplace/list');
      const pendingP: Promise<{ total: number; pending: PendingApproval[] }> = useIpc
        ? api!.mcp.listMarketplace().then(() => ({ total: 0, pending: [] as PendingApproval[] }))
        : apiGet<{ total: number; pending: PendingApproval[] }>('/api/mcp/security/pending');
      const statusP: Promise<SecurityStatus> = useIpc
        ? Promise.resolve({})
        : apiGet<SecurityStatus>('/api/mcp/security/status');

      const [installedResp, marketResp, pendingResp, statusResp] = await Promise.allSettled([
        installedP, marketP, pendingP, statusP,
      ]);
      if (installedResp.status === 'fulfilled') setInstalled(installedResp.value.plugins || []);
      if (marketResp.status === 'fulfilled') setMarketPlugins(marketResp.value.plugins || []);
      if (pendingResp.status === 'fulfilled') setPending(pendingResp.value.pending || []);
      if (statusResp.status === 'fulfilled') setSecurityStatus(statusResp.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleInstall = async (id: string) => {
    setActionId(id);
    try {
      const api = window.electronAPI;
      const r = api?.mcp?.installPlugin
        ? await api.mcp.installPlugin(id)
        : await apiPost(`/api/mcp/marketplace/install/${encodeURIComponent(id)}`);
      if (r.success) showToast(`✅ ${r.message || '安装成功'}`);
      else showToast(`❌ ${r.error || '安装失败'}`);
      await loadAll();
    } catch (e) {
      showToast(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionId(null);
    }
  };

  const handleUninstall = async (id: string) => {
    setActionId(id);
    try {
      const api = window.electronAPI;
      const r = api?.mcp?.uninstallPlugin
        ? await api.mcp.uninstallPlugin(id)
        : await apiPost(`/api/mcp/marketplace/uninstall/${encodeURIComponent(id)}`);
      if (r.success) showToast(`✅ ${r.message || '卸载成功'}`);
      else showToast(`❌ ${r.error || '卸载失败'}`);
      await loadAll();
    } catch (e) {
      showToast(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionId(null);
    }
  };

  const handleApprove = async (approvalId: string, approved: boolean) => {
    setActionId(approvalId);
    try {
      const r = await apiPost('/api/mcp/security/approve', { approvalId, approved });
      if (r.success) showToast(approved ? '✅ 已批准' : '✅ 已拒绝');
      else showToast(`❌ ${r.error || '操作失败'}`);
      await loadAll();
    } catch (e) {
      showToast(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionId(null);
    }
  };

  const RISK_COLOR: Record<string, string> = { low: '#10b981', medium: '#f59e0b', high: '#f97316', critical: '#ef4444' };

  // ===== 市场 Tab：分类 facet 聚合 + 过滤排序 =====
  const tagFacets = useMemo(() => {
    const facets: Record<string, number> = {};
    marketPlugins.forEach(p => {
      (p.tags || []).forEach(tag => {
        facets[tag] = (facets[tag] || 0) + 1;
      });
    });
    return facets;
  }, [marketPlugins]);

  const filteredAndSortedMarketPlugins = useMemo(() => {
    const list = selectedTag
      ? marketPlugins.filter(p => (p.tags || []).includes(selectedTag))
      : marketPlugins;
    const sorted = [...list];
    switch (sortBy) {
      case 'rating':
        sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        break;
      case 'downloads':
        sorted.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
        break;
      case 'lastUpdated':
        sorted.sort((a, b) => {
          const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
          const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
          return tb - ta;
        });
        break;
    }
    return sorted;
  }, [marketPlugins, selectedTag, sortBy]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: '#e2e8f0', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* 顶部栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        {onBack && (
          <button onClick={onBack} style={{ padding: 6, borderRadius: 6, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', cursor: 'pointer', color: '#94a3b8' }}>
            <ArrowLeft style={{ width: 16, height: 16 }} />
          </button>
        )}
        <Server style={{ width: 18, height: 18, color: '#06b6d4' }} />
        <span style={{ fontSize: 16, fontWeight: 600 }}>MCP 管理</span>
        <span style={{ fontSize: 11, color: '#64748b', marginLeft: 4 }}>
          已安装 {installed.length} · 市场 {marketPlugins.length} · 待审批 {pending.length}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={loadAll}
          disabled={loading}
          style={{ padding: '6px 12px', borderRadius: 6, background: 'rgba(6,182,212,.08)', border: '1px solid rgba(6,182,212,.15)', cursor: 'pointer', color: '#06b6d4', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {loading ? <Loader2 style={{ width: 12, height: 12 }} className="spin" /> : <RefreshCw style={{ width: 12, height: 12 }} />}
          刷新
        </button>
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        {([
          { id: 'servers', label: '已连接服务器', icon: Server },
          { id: 'market', label: '插件市场', icon: Store },
          { id: 'security', label: `安全审批${pending.length > 0 ? ` (${pending.length})` : ''}`, icon: Shield },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 14px', background: 'transparent', border: 'none', borderBottom: tab === t.id ? '2px solid #06b6d4' : '2px solid transparent',
              color: tab === t.id ? '#06b6d4' : '#64748b', fontSize: 13, fontWeight: tab === t.id ? 500 : 400, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <t.icon style={{ width: 13, height: 13 }} />
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {error && (
          <div style={{ padding: 12, marginBottom: 12, borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)', color: '#ef4444', fontSize: 13 }}>
            ⚠️ {error}（请确保 Agent 后端服务已启动）
          </div>
        )}

        {/* 已连接服务器 Tab */}
        {tab === 'servers' && (
          <div>
            {installed.length === 0 ? (
              <EmptyState icon={Server} text="暂无已安装的 MCP 服务器" hint="前往「插件市场」安装第一个 MCP 服务器" />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                {installed.map(p => (
                  <PluginCard
                    key={p.id}
                    plugin={p}
                    isInstalled
                    actionLoading={actionId === p.id}
                    onUninstall={() => handleUninstall(p.id)}
                    onInstall={() => handleInstall(p.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* 插件市场 Tab */}
        {tab === 'market' && (
          <div>
            {marketPlugins.length === 0 ? (
              <EmptyState icon={Store} text="市场暂无可用插件" hint="后端 MCPMarketplace 注册表为空" />
            ) : (
              <div style={{ display: 'flex', gap: 16 }}>
                {/* 分类筛选侧栏 */}
                <div style={{ width: 180, flexShrink: 0 }}>
                  <div className="glass-effect" style={{ padding: 12, borderRadius: 10, position: 'sticky', top: 0 }}>
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Filter style={{ width: 12, height: 12 }} />
                      分类筛选
                    </div>
                    <button
                      onClick={() => setSelectedTag(null)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '6px 8px', marginBottom: 4, borderRadius: 6,
                        background: selectedTag === null ? 'rgba(6,182,212,.1)' : 'transparent',
                        border: '1px solid ' + (selectedTag === null ? 'rgba(6,182,212,.2)' : 'transparent'),
                        color: selectedTag === null ? '#06b6d4' : '#94a3b8',
                        cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
                      }}
                    >
                      全部 <span style={{ color: '#475569' }}>({marketPlugins.length})</span>
                    </button>
                    {Object.entries(tagFacets).sort((a, b) => b[1] - a[1]).map(([tag, count]) => (
                      <button
                        key={tag}
                        onClick={() => setSelectedTag(tag)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '6px 8px', marginBottom: 4, borderRadius: 6,
                          background: selectedTag === tag ? 'rgba(6,182,212,.1)' : 'transparent',
                          border: '1px solid ' + (selectedTag === tag ? 'rgba(6,182,212,.2)' : 'transparent'),
                          color: selectedTag === tag ? '#06b6d4' : '#94a3b8',
                          cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
                        }}
                      >
                        {tag} <span style={{ color: '#475569' }}>({count})</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 主区：排序 + 卡片网格 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* 排序下拉 */}
                  <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: 11, color: '#64748b' }}>排序:</span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as 'rating' | 'downloads' | 'lastUpdated')}
                      style={{
                        padding: '5px 10px', borderRadius: 6, fontSize: 12,
                        background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                        color: '#e2e8f0', fontFamily: 'inherit', outline: 'none', cursor: 'pointer',
                      }}
                    >
                      <option value="rating">评分</option>
                      <option value="downloads">下载量</option>
                      <option value="lastUpdated">最近更新</option>
                    </select>
                    <span style={{ fontSize: 11, color: '#475569' }}>
                      {filteredAndSortedMarketPlugins.length} / {marketPlugins.length}
                    </span>
                  </div>

                  {/* 卡片网格 */}
                  {filteredAndSortedMarketPlugins.length === 0 ? (
                    <EmptyState icon={Filter} text="该分类下暂无插件" hint="试试选择其他分类或「全部」" />
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                      {filteredAndSortedMarketPlugins.map(p => {
                        const isInstalled = installed.some(i => i.id === p.id) || p.installStatus === 'installed';
                        return (
                          <PluginCard
                            key={p.id}
                            plugin={p}
                            isInstalled={isInstalled}
                            actionLoading={actionId === p.id}
                            onUninstall={() => handleUninstall(p.id)}
                            onInstall={() => handleInstall(p.id)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 安全审批 Tab */}
        {tab === 'security' && (
          <div>
            {/* 安全状态概览 */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <StatCard label="总插件数" value={securityStatus.totalPlugins ?? installed.length} color="#06b6d4" />
              <StatCard label="受信任" value={securityStatus.trusted ?? 0} color="#10b981" />
              <StatCard label="已阻止" value={securityStatus.blocked ?? 0} color="#ef4444" />
              <StatCard label="待审批" value={pending.length} color="#f59e0b" />
            </div>

            {pending.length === 0 ? (
              <EmptyState icon={Shield} text="暂无待审批请求" hint="MCP 工具调用时如有安全风险会出现在这里" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pending.map(a => (
                  <div key={a.approvalId} style={{ padding: 14, borderRadius: 10, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Shield style={{ width: 14, height: 14, color: RISK_COLOR[a.riskLevel] }} />
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{a.toolName}</span>
                        <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: `${RISK_COLOR[a.riskLevel]}1a`, color: RISK_COLOR[a.riskLevel], border: `1px solid ${RISK_COLOR[a.riskLevel]}30` }}>
                          {a.riskLevel}
                        </span>
                      </div>
                      <span style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Clock style={{ width: 11, height: 11 }} />
                        {a.expiresInSeconds}s 后过期
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
                      <span style={{ color: '#64748b' }}>服务器:</span> {a.serverId}
                    </div>
                    <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 10, padding: 8, background: 'rgba(0,0,0,.2)', borderRadius: 6, fontFamily: 'monospace' }}>
                      {a.argsSummary}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => handleApprove(a.approvalId, true)}
                        disabled={actionId === a.approvalId}
                        style={{ padding: '6px 14px', borderRadius: 6, background: 'rgba(16,185,129,.12)', border: '1px solid rgba(16,185,129,.25)', color: '#10b981', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <CheckCircle style={{ width: 12, height: 12 }} /> 批准
                      </button>
                      <button
                        onClick={() => handleApprove(a.approvalId, false)}
                        disabled={actionId === a.approvalId}
                        style={{ padding: '6px 14px', borderRadius: 6, background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.2)', color: '#ef4444', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <X style={{ width: 12, height: 12 }} /> 拒绝
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', padding: '10px 18px', borderRadius: 8, background: 'rgba(15,23,42,.95)', border: '1px solid rgba(255,255,255,.1)', color: '#e2e8f0', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,.4)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ===== 子组件 =====
function PluginCard({ plugin, isInstalled, actionLoading, onInstall, onUninstall }: {
  plugin: McpPlugin;
  isInstalled: boolean;
  actionLoading: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const TRUST_COLOR: Record<string, string> = { trusted: '#10b981', verified: '#06b6d4', untrusted: '#f59e0b', blocked: '#ef4444' };
  return (
    <div style={{ padding: 14, borderRadius: 10, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)', transition: 'all .2s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{plugin.name}</span>
            {plugin.version && <span style={{ fontSize: 10, color: '#64748b' }}>v{plugin.version}</span>}
          </div>
          {plugin.author && <div style={{ fontSize: 11, color: '#64748b' }}>by {plugin.author}</div>}
        </div>
        {isInstalled ? (
          <CheckCircle style={{ width: 14, height: 14, color: '#10b981', flexShrink: 0 }} />
        ) : (
          <Download style={{ width: 14, height: 14, color: '#06b6d4', flexShrink: 0 }} />
        )}
      </div>
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '6px 0 10px', lineHeight: 1.5 }}>{plugin.description}</p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {plugin.type && <Tag text={plugin.type} color="#8b5cf6" />}
        {plugin.trustLevel && <Tag text={plugin.trustLevel} color={TRUST_COLOR[plugin.trustLevel] || '#64748b'} />}
        {plugin.category && <Tag text={plugin.category} color="#06b6d4" />}
        {typeof plugin.rating === 'number' && <Tag text={`★ ${plugin.rating.toFixed(1)}${plugin.ratingCount ? ` (${plugin.ratingCount})` : ''}`} color="#f59e0b" />}
        {typeof plugin.downloads === 'number' && <Tag text={`↓ ${plugin.downloads}`} color="#64748b" />}
      </div>
      {/* ===== 富卡片增强：维护状态 / 权限 / 兼容性 / 签名 / 更新时间 ===== */}
      {(plugin.maintenanceStatus || (plugin.permissions && plugin.permissions.length > 0) || plugin.compatibility || (plugin.signature && plugin.signature.signedBy) || plugin.lastUpdated) && (
        <div style={{ marginBottom: 10, padding: 8, borderRadius: 6, background: 'rgba(0,0,0,.15)', border: '1px solid rgba(255,255,255,.03)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {plugin.maintenanceStatus && <MaintenanceBadge status={plugin.maintenanceStatus} />}
          {plugin.permissions && plugin.permissions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Lock style={{ width: 10, height: 10, color: '#64748b', flexShrink: 0 }} />
              {plugin.permissions.slice(0, 3).map((perm, i) => (
                <span key={i} style={{ fontSize: 10, color: '#94a3b8' }}>{perm}</span>
              ))}
              {plugin.permissions.length > 3 && (
                <span style={{ fontSize: 10, color: '#64748b' }}>+{plugin.permissions.length - 3}</span>
              )}
            </div>
          )}
          {plugin.compatibility && (
            <div style={{ fontSize: 10, color: '#64748b' }}>兼容: {plugin.compatibility}</div>
          )}
          {plugin.signature && plugin.signature.signedBy && (
            <div style={{ fontSize: 10, color: plugin.signature.valid === false ? '#f59e0b' : '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
              {plugin.signature.valid === false
                ? <AlertTriangle style={{ width: 10, height: 10 }} />
                : <Lock style={{ width: 10, height: 10 }} />}
              {plugin.signature.valid === false ? `签名无效 (${plugin.signature.signedBy})` : `签名: ${plugin.signature.signedBy}`}
            </div>
          )}
          {plugin.lastUpdated && (
            <div style={{ fontSize: 10, color: '#475569', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock style={{ width: 10, height: 10 }} />
              更新于 {new Date(plugin.lastUpdated).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
      <div>
        {isInstalled ? (
          <button
            onClick={onUninstall}
            disabled={actionLoading}
            style={{ width: '100%', padding: '7px 12px', borderRadius: 6, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.15)', color: '#ef4444', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            {actionLoading ? <Loader2 style={{ width: 12, height: 12 }} className="spin" /> : <Trash2 style={{ width: 12, height: 12 }} />}
            卸载
          </button>
        ) : (
          <button
            onClick={onInstall}
            disabled={actionLoading}
            style={{ width: '100%', padding: '7px 12px', borderRadius: 6, background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.2)', color: '#06b6d4', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            {actionLoading ? <Loader2 style={{ width: 12, height: 12 }} className="spin" /> : <Download style={{ width: 12, height: 12 }} />}
            安装
          </button>
        )}
      </div>
    </div>
  );
}

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: `${color}1a`, color, border: `1px solid ${color}30` }}>{text}</span>
  );
}

function MaintenanceBadge({ status }: { status: 'active' | 'maintained' | 'deprecated' | 'unknown' }) {
  const colors: Record<string, string> = {
    active: '#10b981',
    maintained: '#06b6d4',
    deprecated: '#ef4444',
    unknown: '#64748b',
  };
  const labels: Record<string, string> = {
    active: '活跃',
    maintained: '维护中',
    deprecated: '已弃用',
    unknown: '未知',
  };
  const color = colors[status] || '#64748b';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', boxShadow: `0 0 4px ${color}80` }} />
      {labels[status] || status}
    </span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ flex: 1, padding: 12, borderRadius: 8, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)' }}>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function EmptyState({ icon: Icon, text, hint }: { icon: React.ComponentType<{ style?: React.CSSProperties }>; text: string; hint?: string }) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <Icon style={{ width: 32, height: 32, color: '#475569', margin: '0 auto 12px' }} />
      <p style={{ fontSize: 14, color: '#64748b' }}>{text}</p>
      {hint && <p style={{ fontSize: 12, marginTop: 4, color: '#475569' }}>{hint}</p>}
    </div>
  );
}
