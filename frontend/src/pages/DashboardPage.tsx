import { useState, useEffect, useCallback } from 'react';
import { Activity, TrendingUp, AlertTriangle, Circle, ArrowLeft, Cpu, User, BarChart3, Zap, CheckCircle, RefreshCw, Target, BrainCircuit, Pause, Play, ChevronDown, ChevronUp, Monitor, MessageSquare, Clock, Database } from 'lucide-react';
import { Sparkline } from '../components/Sparkline';
import { Donut } from '../components/Donut';

interface PerfMetrics {
  intentAccuracy: number; taskCompletionRate: number; userSatisfaction: number;
  avgResponseTime: number; toolCallSuccessRate: number; totalInteractions: number;
  contextCoherence: number; selfCorrectionRate: number;
}

interface EvalSnapshot {
  timestamp: number; overall: number;
  dimensions: Partial<Record<'accuracy'|'efficiency'|'coverage'|'retention'|'adaptation', number>>;
}

interface EvalReport {
  accuracy: number; accuracyTarget: number; accuracyMet: boolean;
  overallScore: number; dimensionScores: Partial<Record<string, number>>;
  trend: 'improving'|'stable'|'declining'; velocity: number; warnings: string[];
  abTests: Array<{ id: string; dimension: string; winner?: string; completedAt?: number }>;
}

interface PredAccuracy {
  globalAccuracy: number; accuracyTarget: number; accuracyMet: boolean;
  totalPredictions: number; correctPredictions: number;
  userReports: Array<{ userId: string; total: number; correct: number; accuracy: number; recentHistory: Array<{ predicted: string; actual: string; correct: boolean }> }>;
}

interface SLAStatus {
  taskCompletionRate: { current: number; baseline: number; target: number; improvement: number; met: boolean };
  userSatisfaction: { current: number; baseline: number; target: number; improvement: number; met: boolean };
  avgResponseTime: { current: number; baseline: number; target: number; improvement: number; met: boolean };
  overall: { progress: number; phase: string };
}

interface RecStats {
  totalRecommendations: number;
  totalFeedback: number;
  avgRating: number;
  serviceStats: Array<{
    serviceName: string;
    recommendedCount: number;
    feedbackCount: number;
    avgRating: number;
    lastRecommended: number;
  }>;
}

interface DashboardSystemStats {
  totalConversations: number;
  totalMessages: number;
  totalToolCalls: number;
  toolCallSuccess: number;
  toolCallFail: number;
  totalSkills: number;
  totalLearningRecords: number;
  memoryUsage: number;
  configuredProviders: number;
  recentToolUsage: Record<string, number>;
  dailyActivity: Array<{ date: string; count: number }>;
}

interface DashboardCapabilityDimension {
  dimension: string;
  name?: string;
  score?: number;
}

interface DashboardCapability {
  success?: boolean;
  overallScore?: number;
  dimensions?: DashboardCapabilityDimension[];
  skipped?: unknown[];
}

interface DashboardData {
  systemStats?: DashboardSystemStats;
  capability?: DashboardCapability;
  [key: string]: unknown;
}

interface UserProfile {
  totalInteractions?: number;
  successRate?: number;
  interests?: string[];
  preferredLanguages?: string[];
  predictions?: { nextIntents?: string[] };
}

const DIM_COLORS: Record<string, string> = {
  accuracy: '#10b981', efficiency: '#06b6d4', coverage: '#8b5cf6',
  retention: '#f59e0b', adaptation: '#ec4899',
};
const DIM_LABELS: Record<string, string> = {
  accuracy: '准确率', efficiency: '效率', coverage: '覆盖率',
  retention: '保留率', adaptation: '适应度',
};

// metric 卡片 key → snapshots.dimensions 字段映射（用于 sparkline 历史趋势）
type EvalDimKey = 'accuracy' | 'efficiency' | 'coverage' | 'retention' | 'adaptation';
const METRIC_SPARK_DIM: Record<string, EvalDimKey> = {
  toolCallSuccessRate: 'efficiency',
  contextCoherence: 'retention',
  selfCorrectionRate: 'adaptation',
};

function EvalTrendChart({ snapshots }: { snapshots: EvalSnapshot[] }) {
  if (snapshots.length < 2) return <p style={{ fontSize: 12, color: '#475569', padding: 20, textAlign: 'center' }}>数据不足，无法绘制趋势图</p>;
  const w = 600; const h = 180; const pad = { top: 16, right: 16, bottom: 24, left: 36 };
  const cw = w - pad.left - pad.right; const ch = h - pad.top - pad.bottom;
  const dims = ['accuracy', 'efficiency', 'coverage', 'retention', 'adaptation'] as const;
  const dimData = dims.map(d => ({ key: d, values: snapshots.map(s => s.dimensions[d] ?? 0) }));
  const yMin = 0; const yMax = 1;
  const xScale = (i: number) => pad.left + (i / Math.max(snapshots.length - 1, 1)) * cw;
  const yScale = (v: number) => pad.top + ch - ((v - yMin) / (yMax - yMin)) * ch;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', maxWidth: w }}>
      {[0, 0.25, 0.5, 0.75, 1].map(v => (
        <g key={v}>
          <line x1={pad.left} y1={yScale(v)} x2={w - pad.right} y2={yScale(v)} stroke="rgba(148,163,184,.08)" strokeWidth={1} />
          <text x={pad.left - 6} y={yScale(v) + 3} textAnchor="end" fontSize={9} fill="#475569">{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      {dimData.map(d => (
        <polyline key={d.key} points={d.values.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ')}
          fill="none" stroke={DIM_COLORS[d.key] || '#64748b'} strokeWidth={1.5} strokeOpacity={0.7}
          strokeLinecap="round" strokeLinejoin="round" />
      ))}
      <text x={pad.left} y={h - 4} fontSize={9} fill="#475569">{new Date(snapshots[0].timestamp).toLocaleDateString()}</text>
      <text x={w - pad.right} y={h - 4} textAnchor="end" fontSize={9} fill="#475569">{new Date(snapshots[snapshots.length - 1].timestamp).toLocaleDateString()}</text>
    </svg>
  );
}

export function DashboardPage({ onBack }: { onBack?: () => void }) {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null);
  const [report, setReport] = useState<EvalReport | null>(null);
  const [snapshots, setSnapshots] = useState<EvalSnapshot[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sla, setSla] = useState<SLAStatus | null>(null);
  const [predAcc, setPredAcc] = useState<PredAccuracy | null>(null);
  const [recStats, setRecStats] = useState<RecStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d'>('24h');
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<{ uptime: number; version: string; model: string; status: string } | null>(null);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);

  const handleBack = useCallback(() => {
    if (onBack) onBack();
  }, [onBack]);

  const fetchAll = useCallback(async () => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (isE) {
      const api = window.electronAPI;
      let remoteOk = false;
      // 优先从 Web 服务器 API 获取真实数据（飞书等远程通道的对话也在这里）
      try {
        if (api?.dashboard?.remote) {
          const result = await api.dashboard.remote();
          // 放宽门控：只要 result 非 null 即采用（systemStats 在零活动时也有系统信息可展示）
          if (result) {
            remoteOk = true;
            setMetrics(result.metrics || null);
            setReport(result.report || null);
            setSnapshots(Array.isArray(result.snapshots) ? result.snapshots : []);
            setProfile(result.profile || null);
            setSla(result.sla || null);
            setPredAcc(result.predAcc || null);
            setRecStats(result.recStats || null);
            setDashboardData(result);
          }
        }
      } catch (error) {
        console.warn('从Web服务器获取仪表盘数据失败，回退到本地数据:', error);
      }
      // 远程数据不可用时，回退到本地 IPC 数据
      if (!remoteOk) {
        try {
          if (api?.dashboard?.data) {
            const result = await api.dashboard.data();
            if (result?.success || (result as DashboardData).systemStats || result?.metrics) {
              setMetrics(result.metrics || null);
              setReport(result.report || null);
              setSnapshots(Array.isArray(result.snapshots) ? result.snapshots : []);
              setProfile(result.profile || null);
              setSla(result.sla || null);
              setPredAcc(result.predAcc || null);
              setRecStats(result.recStats || null);
              setDashboardData(result);
            }
          }
        } catch { /* ignore */ }
      }
      // 额外拉取能力评估概览（即使零活动也能展示能力分）
      try {
        if (api?.capability?.report) {
          const cap = await api.capability.report();
          if (cap && cap.success !== false) {
            setDashboardData((prev) => prev ? { ...prev, capability: cap } : { capability: cap });
          }
        }
      } catch { /* 能力评估未就绪时忽略 */ }
      // 获取系统状态
      try {
        if (api?.system?.status) {
          const status = await api.system.status();
          if (status?.success || status?.version) {
            setSystemInfo({
              uptime: status.uptime || 0,
              version: status.version || '—',
              model: status.model || '—',
              status: status.status || (status.agentRunning ? 'running' : 'stopped'),
            });
          }
        }
      } catch { /* ignore */ }
      return;
    }
    // Web 模式：从后端 API 获取（P1 修复：传递 timeRange 参数 + 检查 response.ok）
    const range = timeRange;
    const safeJson = async (resp: Response) => {
      if (!resp.ok) return null;
      try { return await resp.json(); } catch { return null; }
    };
    const [m, r, s, p, slaData, pa, rs] = await Promise.all([
      fetch(`/api/performance/metrics?range=${range}`).then(safeJson).catch(() => null),
      fetch(`/api/eval/report?range=${range}`).then(safeJson).catch(() => null),
      fetch(`/api/eval/snapshots?limit=100&range=${range}`).then(safeJson).catch(() => [] as EvalSnapshot[]),
      fetch('/api/profile/default').then(safeJson).catch(() => null),
      fetch(`/api/performance/sla?range=${range}`).then(safeJson).catch(() => null),
      fetch('/api/profile/prediction-accuracy').then(safeJson).catch(() => null),
      fetch('/api/profile/recommendation-stats').then(safeJson).catch(() => null),
    ]);
    setMetrics(m); setReport(r); setSnapshots(Array.isArray(s) ? s : []); setProfile(p); setSla(slaData); setPredAcc(pa); setRecStats(rs);
  }, [timeRange]);

  useEffect(() => {
    let cancelled = false;
    // 首次加载：立即执行，并在 500ms 后重试一次（确保 Agent 服务器就绪后能拿到数据）
    fetchAll().finally(() => { if (!cancelled) setLoading(false); });
    // 延迟重试：Agent 服务器可能刚启动还未就绪，500ms 后再拉一次
    const retryTimer = setTimeout(() => { if (!cancelled) fetchAll(); }, 500);
    const interval = setInterval(() => { if (!cancelled && autoRefresh) fetchAll(); }, 15000);
    return () => { cancelled = true; clearTimeout(retryTimer); clearInterval(interval); };
  }, [fetchAll, autoRefresh]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0e1a' }}>
        <div style={{ textAlign: 'center' }}>
          <Activity style={{ width: 32, height: 32, color: '#06b6d4', margin: '0 auto 16px', animation: 'spin 1s linear infinite' }} />
          <p style={{ color: '#64748b', fontSize: 14 }}>加载监控数据...</p>
        </div>
      </div>
    );
  }

  // 检查数据是否真实可用（排除 { available: false } 占位对象）
  const isRealData = <T,>(v: T | null | undefined): v is T => v != null && typeof v === 'object' && (v as unknown as Record<string, unknown>).available !== false;

  return (
    <div style={{ height: '100%', width: '100%', overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div className="tech-bg" />
      <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* 顶部操作栏 - 返回按钮 + 操作 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 24px',
          borderBottom: '1px solid rgba(255,255,255,.06)',
          flexShrink: 0,
          background: 'rgba(10, 14, 26, 0.85)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={handleBack} style={{
              padding: 6, borderRadius: 10,
              background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
              cursor: 'pointer', color: '#94a3b8',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(12px)', transition: 'all .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
            >
              <ArrowLeft style={{ width: 16, height: 16 }} />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0' }}>智能监控中心</span>
              <span className="live-indicator">LIVE</span>
            </div>
            {isRealData(sla) && sla.overall && (
              <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 10, background: 'rgba(139,92,246,.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.2)' }}>
                {sla.overall.phase}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* 时间范围选择器 */}
            <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,.03)', borderRadius: 8, padding: 2, border: '1px solid rgba(255,255,255,.06)' }}>
              {(['1h', '24h', '7d'] as const).map(range => (
                <button key={range} onClick={() => setTimeRange(range)} style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                  background: timeRange === range ? 'rgba(6,182,212,.12)' : 'transparent',
                  border: timeRange === range ? '1px solid rgba(6,182,212,.2)' : '1px solid transparent',
                  color: timeRange === range ? '#06b6d4' : '#64748b',
                  cursor: 'pointer', transition: 'all .15s', fontFamily: 'inherit',
                }}>
                  {range === '1h' ? '1小时' : range === '24h' ? '24小时' : '7天'}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 10, color: '#475569' }}>{autoRefresh ? '每15s自动刷新' : '已暂停'}</span>
            <button onClick={() => setAutoRefresh(!autoRefresh)} style={{
              padding: 8, borderRadius: 10,
              background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
              cursor: 'pointer', color: autoRefresh ? '#06b6d4' : '#f59e0b',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(12px)', transition: 'all .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
            >
              {autoRefresh ? <Pause style={{ width: 14, height: 14 }} /> : <Play style={{ width: 14, height: 14 }} />}
            </button>
            <button onClick={handleRefresh} style={{
              padding: 8, borderRadius: 10,
              background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
              cursor: 'pointer', color: '#94a3b8',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(12px)', transition: 'all .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
            >
              <RefreshCw style={{ width: 14, height: 14, animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
            </button>
          </div>
        </div>

        {/* 刷新加载条 */}
        {refreshing && (
          <div className="tech-loading-bar" style={{ flexShrink: 0 }} />
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {/* 系统状态概览 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <div className="glass-effect hover-glow" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(16,185,129,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Monitor style={{ width: 18, height: 18, color: '#10b981' }} />
              </div>
              <div>
                <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>系统状态</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: systemInfo?.status === 'running' ? '#10b981' : '#f59e0b', margin: 0 }}>{systemInfo?.status === 'running' ? '运行中' : systemInfo?.status === 'error' ? '异常' : systemInfo?.status ? systemInfo.status : '启动中'}</p>
              </div>
            </div>
            <div className="glass-effect hover-glow" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(6,182,212,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Clock style={{ width: 18, height: 18, color: '#06b6d4' }} />
              </div>
              <div>
                <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>运行时长</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>
                  {systemInfo?.uptime ? (systemInfo.uptime > 3600 ? `${Math.floor(systemInfo.uptime / 3600)}h ${Math.floor((systemInfo.uptime % 3600) / 60)}m` : systemInfo.uptime > 60 ? `${Math.floor(systemInfo.uptime / 60)}m` : `${systemInfo.uptime}s`) : '—'}
                </p>
              </div>
            </div>
            <div className="glass-effect hover-glow" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(139,92,246,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Database style={{ width: 18, height: 18, color: '#8b5cf6' }} />
              </div>
              <div>
                <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>当前模型</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{systemInfo?.model || '—'}</p>
              </div>
            </div>
            <div className="glass-effect hover-glow" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(245,158,11,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <MessageSquare style={{ width: 18, height: 18, color: '#f59e0b' }} />
              </div>
              <div>
                <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>总交互次数</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>{isRealData(metrics) ? (metrics.totalInteractions ?? 0) : '—'}</p>
              </div>
            </div>
          </div>

          {/* 真实系统统计 */}
          {dashboardData?.systemStats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
              <div className="glass-effect" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(6,182,212,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MessageSquare style={{ width: 18, height: 18, color: '#06b6d4' }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>对话数 / 消息数</p>
                  <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>{dashboardData.systemStats.totalConversations} / {dashboardData.systemStats.totalMessages}</p>
                </div>
              </div>
              <div className="glass-effect" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(16,185,129,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Zap style={{ width: 18, height: 18, color: '#10b981' }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>工具调用</p>
                  <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>
                    {dashboardData.systemStats.totalToolCalls}
                    {dashboardData.systemStats.totalToolCalls > 0 && (
                      <span style={{ fontSize: 11, color: '#10b981', marginLeft: 4 }}>
                        ({dashboardData.systemStats.toolCallSuccess}成功 / {dashboardData.systemStats.toolCallFail}失败)
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="glass-effect" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(139,92,246,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Target style={{ width: 18, height: 18, color: '#8b5cf6' }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>技能 / 学习记录</p>
                  <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>{dashboardData.systemStats.totalSkills} / {dashboardData.systemStats.totalLearningRecords}</p>
                </div>
              </div>
              <div className="glass-effect" style={{ padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(245,158,11,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Cpu style={{ width: 18, height: 18, color: '#f59e0b' }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>内存 / 提供商</p>
                  <p style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>{dashboardData.systemStats.memoryUsage}MB / {dashboardData.systemStats.configuredProviders}个</p>
                </div>
              </div>
            </div>
          )}

          {/* 能力评估概览 */}
          {dashboardData?.capability && dashboardData.capability.success !== false && (
            <div className="glass-effect" style={{ borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <BrainCircuit style={{ width: 16, height: 16, color: '#06b6d4' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>能力评估概览</span>
                </div>
                <span style={{ fontSize: 20, fontWeight: 700, color: '#06b6d4' }}>
                  {typeof dashboardData.capability.overallScore === 'number' ? dashboardData.capability.overallScore.toFixed(1) : '—'}
                  <span style={{ fontSize: 11, color: '#475569', marginLeft: 2 }}>/ 100</span>
                </span>
              </div>
              {Array.isArray(dashboardData.capability.dimensions) && dashboardData.capability.dimensions.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(dashboardData.capability.dimensions.length, 5)}, 1fr)`, gap: 8 }}>
                  {dashboardData.capability.dimensions.slice(0, 5).map((d) => (
                    <div key={d.dimension} style={{ padding: '6px 8px', borderRadius: 8, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.04)' }}>
                      <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>{d.name || d.dimension}</p>
                      <p style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>{typeof d.score === 'number' ? d.score.toFixed(1) : '—'}</p>
                    </div>
                  ))}
                </div>
              )}
              {Array.isArray(dashboardData.capability.skipped) && dashboardData.capability.skipped.length > 0 && (
                <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0' }}>{dashboardData.capability.skipped.length} 个指标因依赖未配置而跳过</p>
              )}
            </div>
          )}

          {/* 工具使用排行 */}
          {dashboardData?.systemStats?.recentToolUsage && Object.keys(dashboardData.systemStats.recentToolUsage).length > 0 && (
            <div className="glass-effect" style={{ borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Zap style={{ width: 16, height: 16, color: '#06b6d4' }} />
                <h3 className="title-decorate" style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>工具使用排行</h3>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {Object.entries(dashboardData.systemStats.recentToolUsage)
                  .sort(([, a], [, b]) => (b as number) - (a as number))
                  .slice(0, 8)
                  .map(([name, count]) => {
                    const maxCount = Math.max(...Object.values(dashboardData.systemStats!.recentToolUsage) as number[]);
                    const pct = maxCount > 0 ? ((count as number) / maxCount) * 100 : 0;
                    return (
                      <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
                        <span style={{ fontSize: 12, color: '#94a3b8', width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,.04)' }}>
                          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: 'linear-gradient(90deg, #06b6d4, #8b5cf6)' }} />
                        </div>
                        <span style={{ fontSize: 11, color: '#64748b', width: 24, textAlign: 'right' }}>{count as number}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* 每日活动 */}
          {dashboardData?.systemStats?.dailyActivity && dashboardData.systemStats!.dailyActivity.length > 0 && (
            <div className="glass-effect" style={{ borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Activity style={{ width: 16, height: 16, color: '#10b981' }} />
                <h3 className="title-decorate" style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>每日活动</h3>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
                {dashboardData.systemStats.dailyActivity.map(({ date, count }: { date: string; count: number }) => {
                  const maxCount = Math.max(...dashboardData.systemStats!.dailyActivity.map((d) => d.count));
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  return (
                    <div key={date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 9, color: '#64748b' }}>{count}</span>
                      <div style={{ width: '100%', height: `${Math.max(pct, 4)}%`, borderRadius: 3, background: 'linear-gradient(180deg, #06b6d4, rgba(6,182,212,.2))', transition: 'height .3s' }} />
                      <span style={{ fontSize: 8, color: '#475569' }}>{date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* SLA 达标追踪 */}
          {isRealData(sla) && sla.overall && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Target style={{ width: 15, height: 15, color: '#f59e0b' }} />
                <h2 className="title-decorate" style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>量化目标追踪</h2>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#64748b' }}>综合进度 {sla.overall.progress}%</span>
                <div style={{ width: 120, height: 4, borderRadius: 2, background: 'rgba(148,163,184,.1)' }}>
                  <div style={{ width: `${sla.overall.progress}%`, height: '100%', borderRadius: 2, background: sla.overall.progress >= 80 ? '#10b981' : sla.overall.progress >= 50 ? '#f59e0b' : '#ef4444', transition: 'width .5s', boxShadow: `0 0 8px ${sla.overall.progress >= 80 ? 'rgba(16,185,129,.4)' : 'rgba(245,158,11,.4)'}` }} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {([
                  { key: 'taskCompletionRate' as const, label: '任务完成率', targetPct: '+20%', unit: '%', fmt: (v: number) => `${((v ?? 0) * 100).toFixed(1)}` },
                  { key: 'userSatisfaction' as const, label: '用户满意度', targetPct: '+15%', unit: '%', fmt: (v: number) => `${((v ?? 0) * 100).toFixed(1)}` },
                  { key: 'avgResponseTime' as const, label: '响应时间', targetPct: '-30%', unit: 'ms', fmt: (v: number) => `${(v ?? 0).toFixed(0)}` },
                ]).map(({ key, label, targetPct, unit, fmt }) => {
                  const d = sla[key] || { current: 0, baseline: 0, target: 0, improvement: 0, met: false };
                  const impPct = ((d?.improvement ?? 0) * 100).toFixed(1);
                  const impColor = (d?.improvement ?? 0) >= 0 ? '#10b981' : '#ef4444';
                  return (
                    <div key={key} className="glass-effect" style={{ padding: 14, borderRadius: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, background: 'rgba(245,158,11,.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.15)' }}>目标 {targetPct}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Donut value={d.current ?? 0} max={key === 'avgResponseTime' ? (d.baseline ?? 0) * 2 : 1} color={d.met ? '#10b981' : '#f59e0b'} size={70} label={label} sublabel={`${fmt(d.current ?? 0)}${unit}`} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, marginBottom: 3 }}>
                            <span style={{ color: '#64748b' }}>基线 </span>
                            <span style={{ color: '#94a3b8' }}>{fmt(d.baseline ?? 0)}{unit}</span>
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 3 }}>
                            当前 {fmt(d.current ?? 0)}{unit}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: impColor }}>{(d.improvement ?? 0) >= 0 ? '+' : ''}{impPct}%</span>
                            {d.met ? <CheckCircle style={{ width: 12, height: 12, color: '#10b981' }} /> : <AlertTriangle style={{ width: 12, height: 12, color: '#f59e0b' }} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Performance metric cards - 玻璃态 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {isRealData(metrics) && [
              { label: '工具调用成功率', key: 'toolCallSuccessRate', value: metrics.toolCallSuccessRate ?? 0, target: 0.85, unit: '%', format: (v: number) => `${(v * 100).toFixed(1)}`, detail: `总交互次数: ${metrics.totalInteractions ?? 0} · 目标: ≥85%` },
              { label: '上下文连贯性', key: 'contextCoherence', value: metrics.contextCoherence ?? 0, target: 0.75, unit: '%', format: (v: number) => `${(v * 100).toFixed(1)}`, detail: `意图准确率: ${((metrics.intentAccuracy ?? 0) * 100).toFixed(1)}% · 用户满意度: ${((metrics.userSatisfaction ?? 0) * 100).toFixed(1)}%` },
              { label: '自我修正率', key: 'selfCorrectionRate', value: metrics.selfCorrectionRate ?? 0, target: 0.3, unit: '%', format: (v: number) => `${(v * 100).toFixed(1)}`, detail: `平均响应时间: ${(metrics.avgResponseTime ?? 0).toFixed(0)}ms · 目标: ≥30%` },
            ].map(card => {
              const pct = Math.min(100, Math.max(0, (card.value / card.target) * 100));
              const met = card.value >= card.target;
              const isExpanded = expandedCard === card.key;
              // 从 snapshots 提取该指标对应维度的历史值用于 sparkline
              const dimKey = METRIC_SPARK_DIM[card.key];
              const sparkValues = dimKey
                ? snapshots.map(s => s.dimensions[dimKey]).filter((v): v is number => typeof v === 'number' && isFinite(v))
                : [];
              const hasSpark = sparkValues.length >= 2;
              return (
                <div key={card.label} className="glass-effect" style={{ padding: 16, borderRadius: 12, cursor: 'pointer', transition: 'all .15s' }}
                  onClick={() => setExpandedCard(isExpanded ? null : card.key)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: '#64748b' }}>{card.label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {met ? <CheckCircle style={{ width: 13, height: 13, color: '#10b981' }} /> : <AlertTriangle style={{ width: 13, height: 13, color: '#f59e0b' }} />}
                      {isExpanded ? <ChevronUp style={{ width: 12, height: 12, color: '#475569' }} /> : <ChevronDown style={{ width: 12, height: 12, color: '#475569' }} />}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: met ? '#10b981' : '#f59e0b' }}>
                      {card.format(card.value)}<span style={{ fontSize: 11, fontWeight: 400, color: '#475569', marginLeft: 2 }}>{card.unit}</span>
                    </div>
                    {hasSpark && <Sparkline values={sparkValues} color="#06b6d4" width={60} height={16} />}
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(148,163,184,.1)' }}>
                    <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 2, background: met ? '#10b981' : '#f59e0b', transition: 'width .5s', boxShadow: `0 0 6px ${met ? 'rgba(16,185,129,.4)' : 'rgba(245,158,11,.4)'}` }} />
                  </div>
                  {isExpanded && (
                    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(148,163,184,.04)', border: '1px solid rgba(148,163,184,.08)', fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                      {card.detail}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Learning evaluation & trend chart - 玻璃态 */}
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, marginBottom: 16 }}>
            <div className="glass-effect" style={{ padding: 18, borderRadius: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <Cpu style={{ width: 15, height: 15, color: '#8b5cf6' }} />
                <h2 className="title-decorate" style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>学习评估</h2>
                {isRealData(report) && (
                  <span style={{ fontSize: 10, marginLeft: 'auto', padding: '2px 8px', borderRadius: 8, background: report.trend === 'improving' ? 'rgba(16,185,129,.12)' : report.trend === 'declining' ? 'rgba(239,68,68,.12)' : 'rgba(148,163,184,.12)', color: report.trend === 'improving' ? '#10b981' : report.trend === 'declining' ? '#ef4444' : '#94a3b8' }}>
                    {report.trend === 'improving' ? '↑ 提升中' : report.trend === 'declining' ? '↓ 下降中' : '→ 稳定'}
                  </span>
                )}
              </div>
              {isRealData(report) && (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginBottom: 5 }}>
                      <span>综合评分</span>
                      <span style={{ color: (report.overallScore ?? 0) >= 0.7 ? '#10b981' : '#f59e0b', fontWeight: 600 }}>{((report.overallScore ?? 0) * 100).toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 2, background: 'rgba(148,163,184,.1)' }}>
                      <div style={{ width: `${Math.min(100, (report.overallScore ?? 0) * 100)}%`, height: '100%', borderRadius: 2, background: (report.overallScore ?? 0) >= 0.7 ? '#10b981' : (report.overallScore ?? 0) >= 0.5 ? '#f59e0b' : '#ef4444', transition: 'width .5s', boxShadow: `0 0 6px ${(report.overallScore ?? 0) >= 0.7 ? 'rgba(16,185,129,.4)' : 'rgba(245,158,11,.4)'}` }} />
                    </div>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginBottom: 5 }}>
                      <span>准确率目标</span>
                      <span style={{ color: report.accuracyMet ? '#10b981' : '#f59e0b', fontWeight: 600 }}>
                        {((report.accuracy ?? 0) * 100).toFixed(1)}% / {((report.accuracyTarget ?? 1) * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div style={{ height: 5, borderRadius: 2, background: 'rgba(148,163,184,.1)' }}>
                      <div style={{ width: `${Math.min(100, ((report.accuracy ?? 0) / (report.accuracyTarget || 1)) * 100)}%`, height: '100%', borderRadius: 2, background: report.accuracyMet ? '#10b981' : '#f59e0b', transition: 'width .5s' }} />
                    </div>
                  </div>
                  {(Object.entries(report.dimensionScores ?? {}) as [string, number][]).map(([key, val]) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 3 }}>
                      <span style={{ color: DIM_COLORS[key] || '#64748b' }}>{DIM_LABELS[key] || key}</span>
                      <span>{(val * 100).toFixed(0)}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'rgba(148,163,184,.08)' }}>
                      <div style={{ width: `${val * 100}%`, height: '100%', borderRadius: 2, background: DIM_COLORS[key] || '#64748b', transition: 'width .5s' }} />
                    </div>
                  </div>
              ))}
                </>
              )}
            </div>
            <div className="glass-effect" style={{ padding: 18, borderRadius: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <TrendingUp style={{ width: 15, height: 15, color: '#06b6d4' }} />
                <h2 className="title-decorate" style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>评估趋势</h2>
                <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>{snapshots.length} 个采样点</span>
              </div>
              <EvalTrendChart snapshots={snapshots} />
              <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                {Object.entries(DIM_COLORS).map(([key, color]) => (
                  <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#64748b' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}80` }} />
                    {DIM_LABELS[key] || key}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom row: A/B tests + warnings + profile - 玻璃态 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="glass-effect" style={{ padding: 18, borderRadius: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Zap style={{ width: 15, height: 15, color: '#f59e0b' }} />
                <h2 className="title-decorate" style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>A/B 测试</h2>
                <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>{report?.abTests?.length || 0} 个</span>
              </div>
              {report?.abTests?.length ? report.abTests.slice(0, 8).map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(245,158,11,.04)', marginBottom: 5, fontSize: 11, border: '1px solid rgba(245,158,11,.08)' }}>
                  <Circle style={{ width: 6, height: 6, fill: t.completedAt ? '#10b981' : '#f59e0b', color: t.completedAt ? '#10b981' : '#f59e0b' }} />
                  <span style={{ color: '#94a3b8', minWidth: 60 }}>{t.id}</span>
                  <span style={{ color: '#64748b' }}>{t.dimension}</span>
                  {t.winner && <span style={{ marginLeft: 'auto', color: '#10b981' }}>胜出: {t.winner}</span>}
                  {!t.completedAt && <span style={{ marginLeft: 'auto', color: '#f59e0b', fontSize: 10 }}>进行中</span>}
                </div>
              )) : <p style={{ fontSize: 11, color: '#475569' }}>暂无 A/B 测试</p>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {report?.warnings?.length ? (
                <div className="glass-effect" style={{ padding: 14, borderRadius: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <AlertTriangle style={{ width: 15, height: 15, color: '#ef4444' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>警告</span>
                  </div>
                  {report.warnings.map((w, i) => (
                    <p key={i} style={{ fontSize: 11, color: '#fca5a5', margin: '3px 0', paddingLeft: 12 }}>• {w}</p>
                  ))}
                </div>
              ) : null}
              {isRealData(predAcc) && (
                <div className="glass-effect" style={{ padding: 14, borderRadius: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <BrainCircuit style={{ width: 15, height: 15, color: '#8b5cf6' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>意图预测准确率</span>
                    <span style={{ fontSize: 10, marginLeft: 'auto', padding: '2px 8px', borderRadius: 6, background: predAcc.accuracyMet ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.12)', color: predAcc.accuracyMet ? '#10b981' : '#f59e0b' }}>
                      {predAcc.accuracyMet ? '✓ 达标' : `${(((predAcc.accuracyTarget ?? 1) * 100)).toFixed(0)}%目标`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: predAcc.accuracyMet ? '#10b981' : '#f59e0b' }}>
                      {((predAcc.globalAccuracy ?? 0) * 100).toFixed(1)}%
                    </span>
                    <div style={{ flex: 1, height: 5, borderRadius: 2, background: 'rgba(148,163,184,.1)' }}>
                      <div style={{ width: `${Math.min(100, ((predAcc.globalAccuracy ?? 0) / (predAcc.accuracyTarget || 1)) * 100)}%`, height: '100%', borderRadius: 2, background: predAcc.accuracyMet ? '#10b981' : '#f59e0b', transition: 'width .5s', boxShadow: `0 0 6px ${predAcc.accuracyMet ? 'rgba(16,185,129,.4)' : 'rgba(245,158,11,.4)'}` }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>
                    <span>{predAcc.correctPredictions ?? 0}/{predAcc.totalPredictions ?? 0} 次正确预测</span>
                    {predAcc.userReports?.length ? (
                      <span style={{ marginLeft: 8 }}>· {predAcc.userReports.length} 个用户</span>
                    ) : null}
                  </div>
                </div>
              )}
              {recStats && recStats.totalFeedback > 0 && Array.isArray(recStats.serviceStats) && (
                <div className="glass-effect" style={{ padding: 14, borderRadius: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <BarChart3 style={{ width: 15, height: 15, color: '#f59e0b' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>推荐服务评分</span>
                    <span style={{ fontSize: 10, marginLeft: 'auto', color: '#64748b' }}>平均 {(recStats.avgRating ?? 0).toFixed(1)}/5</span>
                  </div>
                  {recStats.serviceStats.slice(0, 5).map(s => (
                    <div key={s.serviceName} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, marginBottom: 3, fontSize: 11 }}>
                      <span style={{ color: '#94a3b8', minWidth: 70, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.serviceName}</span>
                      <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(148,163,184,.08)' }}>
                        <div style={{ width: `${(s.avgRating / 5) * 100}%`, height: '100%', borderRadius: 2, background: s.avgRating >= 3 ? '#10b981' : s.avgRating >= 2 ? '#f59e0b' : '#ef4444' }} />
                      </div>
                      <span style={{ color: (s.avgRating ?? 0) >= 3 ? '#10b981' : '#f59e0b', minWidth: 32, textAlign: 'right' }}>{(s.avgRating ?? 0).toFixed(1)}</span>
                      <span style={{ color: '#475569', fontSize: 9 }}>({s.feedbackCount})</span>
                    </div>
                  ))}
                </div>
              )}
              {isRealData(profile) && (
                <div className="glass-effect" style={{ padding: 14, borderRadius: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <User style={{ width: 15, height: 15, color: '#06b6d4' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>用户画像</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    <p style={{ margin: '3px 0' }}>交互次数: {profile.totalInteractions || 0}</p>
                    <p style={{ margin: '3px 0' }}>成功率: {profile.successRate ? `${(profile.successRate * 100).toFixed(1)}%` : 'N/A'}</p>
                    <p style={{ margin: '3px 0' }}>兴趣领域: {profile.interests?.slice(0, 4).join(', ') || '无'}</p>
                    <p style={{ margin: '3px 0' }}>语言偏好: {profile.preferredLanguages?.join(', ') || '中文'}</p>
                    {profile.predictions?.nextIntents?.length ? (
                      <p style={{ margin: '3px 0' }}>预测意图: {profile.predictions.nextIntents.slice(0, 3).join(' → ')}</p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
