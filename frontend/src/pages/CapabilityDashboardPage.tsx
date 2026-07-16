/**
 * 能力评估仪表盘页面
 *
 * 数据来源（双模式）：
 * - Electron 模式：window.electronAPI.capability.* IPC（main 进程转发后端 API）
 * - Web 模式：fetch /api/capability/* REST API
 *
 * 页面结构：
 * 1. 顶部操作栏：返回 / 触发评估 / 保存 baseline / 刷新
 * 2. 总分卡片 + 10 维度雷达图（左右布局）
 * 3. Baseline 对比：topImprovements / topRegressions
 * 4. 维度卡片网格（每个维度可展开查看指标详情）
 * 5. 跳过的指标列表 + 建议列表
 *
 * 图表方案：纯 SVG（项目无图表库），与 DashboardPage.tsx 风格一致
 */

import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Gauge, RefreshCw, Save, Play, TrendingUp, TrendingDown, AlertCircle, ChevronDown, ChevronUp, Lightbulb } from 'lucide-react';

// ============ 类型定义（与后端 types.ts 同构） ============

type CapabilityDimensionId =
  | 'thinking' | 'execution' | 'computer_ops' | 'code' | 'learning'
  | 'memory' | 'self_iteration' | 'self_repair' | 'inference' | 'cross_platform';

interface CapabilityMetricSpec {
  id: string;
  dimension: CapabilityDimensionId;
  name: string;
  description: string;
  unit: string;
  target: number;
  weight: number;
  lowerIsBetter: boolean;
  source: string;
  adapterKey?: string;
}

interface CapabilityMetricResult {
  spec: CapabilityMetricSpec;
  value: number;
  score: number;
  source: string;
  measuredAt: number;
  error?: string;
}

interface CapabilityDimensionResult {
  dimension: CapabilityDimensionId;
  name: string;
  score: number;
  weight: number;
  metrics: CapabilityMetricResult[];
}

interface CapabilityReport {
  timestamp: number;
  label: 'baseline' | 'current' | 'manual';
  overallScore: number;
  dimensions: CapabilityDimensionResult[];
  baseline?: CapabilityReport | null;
  topImprovements: Array<{ metricId: string; metricName: string; delta: number }>;
  topRegressions: Array<{ metricId: string; metricName: string; delta: number }>;
  recommendations: string[];
  skipped: Array<{ metricId: string; reason: string }>;
  // API 评估失败时返回的带错误对象（与成功 report 共用同一类型）
  error?: string;
}

interface CapabilityMetricSnapshot {
  timestamp: number;
  label: 'baseline' | 'current' | 'manual';
  overallScore: number;
  dimensionScores: Partial<Record<CapabilityDimensionId, number>>;
  metricValues: Record<string, number>;
}

// ============ 维度配色 ============

const DIM_COLORS: Record<CapabilityDimensionId, string> = {
  thinking: '#06b6d4',
  execution: '#3b82f6',
  computer_ops: '#8b5cf6',
  code: '#ec4899',
  learning: '#f59e0b',
  memory: '#10b981',
  self_iteration: '#14b8a6',
  self_repair: '#ef4444',
  inference: '#a855f7',
  cross_platform: '#6366f1',
};

// ============ 雷达图（纯 SVG） ============

function RadarChart({ dimensions }: { dimensions: CapabilityDimensionResult[] }) {
  if (dimensions.length < 3) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#475569', fontSize: 13 }}>维度数据不足，无法绘制雷达图</div>;
  }
  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const r = 110;
  const n = dimensions.length;
  // 评分 0-100 → 半径 0-r
  const radius = (score: number) => (Math.max(0, Math.min(100, score)) / 100) * r;
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, score: number) => {
    const rad = angle(i);
    const rr = radius(score);
    return [cx + Math.cos(rad) * rr, cy + Math.sin(rad) * rr];
  };
  const axisEnd = (i: number) => {
    const rad = angle(i);
    return [cx + Math.cos(rad) * r, cy + Math.sin(rad) * r];
  };

  // 多边形数据点
  const dataPoints = dimensions.map((d, i) => point(i, d.score));
  const dataPath = `M ${dataPoints.map(p => p.join(',')).join(' L ')} Z`;

  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: size, display: 'block', margin: '0 auto' }}>
      {/* 同心网格（5 层，20% 一圈） */}
      {[0.2, 0.4, 0.6, 0.8, 1].map((ratio, idx) => (
        <polygon
          key={idx}
          points={dimensions.map((_, i) => {
            const rad = angle(i);
            return [cx + Math.cos(rad) * r * ratio, cy + Math.sin(rad) * r * ratio].join(',');
          }).join(' ')}
          fill="none"
          stroke="rgba(148,163,184,.08)"
          strokeWidth={1}
        />
      ))}
      {/* 轴线 */}
      {dimensions.map((d, i) => {
        const [ex, ey] = axisEnd(i);
        return <line key={d.dimension} x1={cx} y1={cy} x2={ex} y2={ey} stroke="rgba(148,163,184,.08)" strokeWidth={1} />;
      })}
      {/* 数据多边形 */}
      <path d={dataPath} fill="rgba(6,182,212,.15)" stroke="#06b6d4" strokeWidth={2} strokeLinejoin="round" />
      {/* 数据点 */}
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={DIM_COLORS[dimensions[i].dimension] || '#06b6d4'} />
      ))}
      {/* 维度标签 */}
      {dimensions.map((d, i) => {
        const [_ex, _ey] = axisEnd(i); // 轴端点坐标（标签定位用独立的 lx/ly，此处保留 axisEnd 调用以备调试）
        const labelR = r + 18;
        const rad = angle(i);
        const lx = cx + Math.cos(rad) * labelR;
        const ly = cy + Math.sin(rad) * labelR;
        const anchor = Math.abs(Math.cos(rad)) < 0.3 ? 'middle' : Math.cos(rad) > 0 ? 'start' : 'end';
        return (
          <g key={d.dimension}>
            <text x={lx} y={ly} textAnchor={anchor} dominantBaseline="central" fontSize={10} fill="#94a3b8" fontWeight={500}>
              {d.name}
            </text>
            <text x={lx} y={ly + 12} textAnchor={anchor} dominantBaseline="central" fontSize={9} fill={DIM_COLORS[d.dimension] || '#06b6d4'} fontWeight={600}>
              {d.score.toFixed(1)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ============ 评分等级映射 ============

function scoreLevel(score: number): { label: string; color: string } {
  if (score >= 85) return { label: 'A', color: '#10b981' };
  if (score >= 75) return { label: 'B', color: '#06b6d4' };
  if (score >= 60) return { label: 'C', color: '#f59e0b' };
  if (score >= 40) return { label: 'D', color: '#ef4444' };
  return { label: 'F', color: '#64748b' };
}

// ============ 主页面 ============

export function CapabilityDashboardPage({ onBack }: { onBack?: () => void }) {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [snapshots, setSnapshots] = useState<CapabilityMetricSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [assessing, setAssessing] = useState(false);
  const [savingBaseline, setSavingBaseline] = useState(false);
  const [expandedDim, setExpandedDim] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 数据获取：优先 Electron IPC，回退 fetch
  const fetchData = useCallback(async () => {
    setError(null);
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    const api = isE ? window.electronAPI?.capability : null;

    try {
      if (api?.report) {
        const r = await api.report();
        if (r && !r.error) setReport(r);
      } else {
        const resp = await fetch('/api/capability/report');
        if (resp.ok) {
          const r = await resp.json();
          setReport(r);
        }
      }

      if (api?.snapshots) {
        const s = await api.snapshots();
        if (s?.snapshots) setSnapshots(s.snapshots);
      } else {
        const resp = await fetch('/api/capability/snapshots');
        if (resp.ok) {
          const s = await resp.json();
          setSnapshots(s.snapshots || []);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // 触发新评估
  const handleAssess = useCallback(async () => {
    setAssessing(true);
    setError(null);
    try {
      const isE = typeof window !== 'undefined' && !!window.electronAPI;
      const api = isE ? window.electronAPI?.capability : null;
      let r: CapabilityReport | null = null;
      if (api?.assess) {
        r = await api.assess({ label: 'current' });
      } else {
        const resp = await fetch('/api/capability/assess', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'current' }),
        });
        if (resp.ok) {
          r = await resp.json();
        } else {
          // HTTP 错误（如 503 capabilityAssessor 未注入、500 评估异常）
          try { const e = await resp.json(); setError(e?.error || `评估请求失败 (HTTP ${resp.status})`); }
          catch { setError(`评估请求失败 (HTTP ${resp.status})`); }
          return;
        }
      }
      if (r && !r.error) {
        setReport(r);
        // 评估后刷新快照
        void fetchData();
      } else if (r?.error) {
        setError(r.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 浏览器 fetch 网络错误（如生产 Electron file:// origin 无法访问 /api，或后端未启动）
      if (/Failed to fetch|NetworkError|fetch/i.test(msg)) {
        setError('无法连接评估服务：请确认 Agent 后端服务已启动。桌面应用模式下若持续出现此错误，请重启应用。');
      } else {
        setError(msg);
      }
    } finally {
      setAssessing(false);
    }
  }, [fetchData]);

  // 保存 baseline
  const handleSaveBaseline = useCallback(async () => {
    setSavingBaseline(true);
    setError(null);
    try {
      const isE = typeof window !== 'undefined' && !!window.electronAPI;
      const api = isE ? window.electronAPI?.capability : null;
      let r: CapabilityReport | null = null;
      if (api?.saveBaseline) {
        r = await api.saveBaseline();
      } else {
        const resp = await fetch('/api/capability/baseline', { method: 'POST' });
        if (resp.ok) r = await resp.json();
      }
      if (r && !r.error) {
        setReport(r);
      } else if (r?.error) {
        setError(r.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBaseline(false);
    }
  }, []);

  const handleBack = useCallback(() => {
    if (onBack) onBack();
  }, [onBack]);

  // 加载中
  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', gap: 10 }}>
        <RefreshCw style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 14 }}>加载能力评估数据...</span>
      </div>
    );
  }

  const overall = report?.overallScore ?? 0;
  const overallLevel = scoreLevel(overall);
  const hasBaseline = !!report?.baseline;
  const baselineDelta = hasBaseline ? overall - (report!.baseline!.overallScore ?? 0) : 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', color: '#e2e8f0' }}>
      {/* 顶部操作栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,.06)',
        background: 'rgba(0,0,0,.2)', flexShrink: 0,
      }}>
        <button
          onClick={handleBack}
          style={{
            padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.06)', cursor: 'pointer', color: '#94a3b8',
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontFamily: 'inherit',
          }}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} /> 返回
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <Gauge style={{ width: 18, height: 18, color: '#06b6d4' }} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>能力评估仪表盘</span>
          {report && (
            <span style={{ fontSize: 11, color: '#475569' }}>
              · 更新于 {new Date(report.timestamp).toLocaleString()}
            </span>
          )}
        </div>
        <button
          onClick={handleAssess}
          disabled={assessing}
          style={{
            padding: '6px 12px', borderRadius: 8, cursor: assessing ? 'not-allowed' : 'pointer',
            background: assessing ? 'rgba(100,116,139,.1)' : 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.1))',
            border: `1px solid ${assessing ? 'rgba(100,116,139,.2)' : 'rgba(6,182,212,.25)'}`,
            color: assessing ? '#64748b' : '#06b6d4', fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {assessing ? <RefreshCw style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} /> : <Play style={{ width: 13, height: 13 }} />}
          {assessing ? '评估中...' : '触发评估'}
        </button>
        <button
          onClick={handleSaveBaseline}
          disabled={savingBaseline}
          style={{
            padding: '6px 12px', borderRadius: 8, cursor: savingBaseline ? 'not-allowed' : 'pointer',
            background: savingBaseline ? 'rgba(100,116,139,.1)' : 'rgba(245,158,11,.1)',
            border: `1px solid ${savingBaseline ? 'rgba(100,116,139,.2)' : 'rgba(245,158,11,.25)'}`,
            color: savingBaseline ? '#64748b' : '#f59e0b', fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {savingBaseline ? <RefreshCw style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} /> : <Save style={{ width: 13, height: 13 }} />}
          {savingBaseline ? '保存中...' : '存为 Baseline'}
        </button>
        <button
          onClick={() => { setLoading(true); void fetchData(); }}
          style={{
            padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.06)', cursor: 'pointer', color: '#94a3b8',
            display: 'flex', alignItems: 'center', fontSize: 13, fontFamily: 'inherit',
          }}
          title="刷新"
        >
          <RefreshCw style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div style={{
          margin: '12px 20px 0', padding: '10px 14px', borderRadius: 8,
          background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.25)',
          color: '#ef4444', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />
          {error}
        </div>
      )}

      {/* 无报告提示 */}
      {!report && !error && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          color: '#475569', gap: 12,
        }}>
          <Gauge style={{ width: 48, height: 48, opacity: 0.3 }} />
          <div style={{ fontSize: 14 }}>尚无评估报告</div>
          <div style={{ fontSize: 12, color: '#64748b' }}>点击右上角"触发评估"开始首次评估</div>
        </div>
      )}

      {/* 主体内容 */}
      {report && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {/* 顶部：总分 + 雷达图 */}
          <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, marginBottom: 20 }}>
            {/* 总分卡片 */}
            <div className="glass-effect" style={{
              padding: 20, borderRadius: 12,
              background: 'rgba(6,9,18,.6)', border: '1px solid rgba(255,255,255,.06)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>总体能力评分</div>
              <div style={{
                fontSize: 48, fontWeight: 700, lineHeight: 1,
                color: overallLevel.color,
                textShadow: `0 0 24px ${overallLevel.color}40`,
              }}>
                {overall.toFixed(1)}
              </div>
              <div style={{
                marginTop: 8, padding: '2px 10px', borderRadius: 12,
                background: `${overallLevel.color}20`, color: overallLevel.color,
                fontSize: 11, fontWeight: 600,
              }}>
                等级 {overallLevel.label}
              </div>
              {hasBaseline && (
                <div style={{
                  marginTop: 12, fontSize: 11, color: baselineDelta >= 0 ? '#10b981' : '#ef4444',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  {baselineDelta >= 0 ? <TrendingUp style={{ width: 12, height: 12 }} /> : <TrendingDown style={{ width: 12, height: 12 }} />}
                  较 Baseline {baselineDelta >= 0 ? '+' : ''}{baselineDelta.toFixed(1)}
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: 10, color: '#475569' }}>
                {report.skipped.length > 0 ? `${report.skipped.length} 个指标跳过` : '所有指标均已评估'}
              </div>
            </div>

            {/* 雷达图 */}
            <div className="glass-effect" style={{
              padding: 16, borderRadius: 12,
              background: 'rgba(6,9,18,.6)', border: '1px solid rgba(255,255,255,.06)',
            }}>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8, fontWeight: 500 }}>10 维度能力雷达</div>
              <RadarChart dimensions={report.dimensions} />
            </div>
          </div>

          {/* Baseline 对比 */}
          {(report.topImprovements.length > 0 || report.topRegressions.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <div className="glass-effect" style={{
                padding: 14, borderRadius: 10,
                background: 'rgba(16,185,129,.06)', border: '1px solid rgba(16,185,129,.15)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: '#10b981', fontSize: 12, fontWeight: 600 }}>
                  <TrendingUp style={{ width: 14, height: 14 }} /> Top 改进
                </div>
                {report.topImprovements.map((imp, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: '#94a3b8' }}>
                    <span>{imp.metricName}</span>
                    <span style={{ color: '#10b981', fontWeight: 600 }}>+{imp.delta.toFixed(1)}</span>
                  </div>
                ))}
              </div>
              <div className="glass-effect" style={{
                padding: 14, borderRadius: 10,
                background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.15)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: '#ef4444', fontSize: 12, fontWeight: 600 }}>
                  <TrendingDown style={{ width: 14, height: 14 }} /> Top 回归
                </div>
                {report.topRegressions.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#64748b' }}>无回归</div>
                ) : report.topRegressions.map((reg, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: '#94a3b8' }}>
                    <span>{reg.metricName}</span>
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>{reg.delta.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 建议 */}
          {report.recommendations.length > 0 && (
            <div className="glass-effect" style={{
              padding: 14, borderRadius: 10, marginBottom: 20,
              background: 'rgba(245,158,11,.05)', border: '1px solid rgba(245,158,11,.15)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: '#f59e0b', fontSize: 12, fontWeight: 600 }}>
                <Lightbulb style={{ width: 14, height: 14 }} /> 优化建议
              </div>
              {report.recommendations.map((rec, i) => (
                <div key={i} style={{ padding: '3px 0', fontSize: 12, color: '#94a3b8', paddingLeft: 14, position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 0, color: '#f59e0b' }}>•</span>
                  {rec}
                </div>
              ))}
            </div>
          )}

          {/* 维度卡片网格 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, marginBottom: 20 }}>
            {report.dimensions.map((dim) => {
              const dimColor = DIM_COLORS[dim.dimension] || '#06b6d4';
              const level = scoreLevel(dim.score);
              const isExpanded = expandedDim === dim.dimension;
              const hasError = dim.metrics.some(m => m.error);
              return (
                <div key={dim.dimension} className="glass-effect" style={{
                  borderRadius: 10, overflow: 'hidden',
                  background: 'rgba(6,9,18,.6)', border: `1px solid ${isExpanded ? `${dimColor}40` : 'rgba(255,255,255,.06)'}`,
                  transition: 'border-color .15s',
                }}>
                  {/* 卡片头 */}
                  <div
                    onClick={() => setExpandedDim(isExpanded ? null : dim.dimension)}
                    style={{
                      padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 8,
                      background: `${dimColor}15`, border: `1px solid ${dimColor}30`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 700, color: dimColor, flexShrink: 0,
                    }}>
                      {level.label}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>{dim.name}</div>
                      <div style={{ fontSize: 10, color: '#64748b' }}>
                        {dim.metrics.length} 个指标 · 权重 {(dim.weight * 100).toFixed(0)}%
                        {hasError && <span style={{ color: '#f59e0b', marginLeft: 6 }}>⚠ 部分跳过</span>}
                      </div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: dimColor }}>{dim.score.toFixed(1)}</div>
                    {isExpanded ? <ChevronUp style={{ width: 14, height: 14, color: '#64748b' }} /> : <ChevronDown style={{ width: 14, height: 14, color: '#64748b' }} />}
                  </div>
                  {/* 卡片详情 */}
                  {isExpanded && (
                    <div style={{ padding: '0 14px 12px', borderTop: '1px solid rgba(255,255,255,.04)' }}>
                      {dim.metrics.length === 0 ? (
                        <div style={{ padding: 10, fontSize: 11, color: '#64748b' }}>该维度所有指标被跳过</div>
                      ) : dim.metrics.map((m, i) => {
                        const mColor = m.score >= 75 ? '#10b981' : m.score >= 60 ? '#f59e0b' : '#ef4444';
                        return (
                          <div key={i} style={{ padding: '8px 0', borderBottom: i < dim.metrics.length - 1 ? '1px solid rgba(255,255,255,.03)' : 'none' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                              <span style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 500 }}>{m.spec.name}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: mColor }}>{m.score.toFixed(1)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b' }}>
                              <span>值: {m.value.toFixed(3)} {m.spec.unit} · 目标: {m.spec.target}{m.spec.unit}</span>
                              <span>{m.spec.lowerIsBetter ? '↓越低越好' : '↑越高越好'}</span>
                            </div>
                            <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                              来源: {m.source} · 权重: {(m.spec.weight * 100).toFixed(0)}%
                            </div>
                            {/* 进度条 */}
                            <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.04)', overflow: 'hidden' }}>
                              <div style={{
                                width: `${Math.min(100, m.score)}%`, height: '100%',
                                background: mColor, transition: 'width .3s',
                              }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 跳过的指标 */}
          {report.skipped.length > 0 && (
            <div className="glass-effect" style={{
              padding: 14, borderRadius: 10,
              background: 'rgba(245,158,11,.04)', border: '1px solid rgba(245,158,11,.12)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: '#f59e0b', fontSize: 12, fontWeight: 600 }}>
                <AlertCircle style={{ width: 14, height: 14 }} /> 跳过的指标（{report.skipped.length}）
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }}>
                {report.skipped.map((s, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#94a3b8', padding: '4px 8px', background: 'rgba(255,255,255,.02)', borderRadius: 4 }}>
                    <span style={{ color: '#f59e0b' }}>{s.metricId}</span>
                    <span style={{ color: '#64748b', marginLeft: 6 }}>— {s.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 趋势快照 */}
          {snapshots.length > 1 && (
            <div className="glass-effect" style={{
              padding: 14, borderRadius: 10, marginTop: 20,
              background: 'rgba(6,9,18,.6)', border: '1px solid rgba(255,255,255,.06)',
            }}>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10, fontWeight: 500 }}>
                评估历史（{snapshots.length} 次评估）
              </div>
              <SnapshotTrendChart snapshots={snapshots} />
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ============ 快照趋势图（总分随时间） ============

function SnapshotTrendChart({ snapshots }: { snapshots: CapabilityMetricSnapshot[] }) {
  if (snapshots.length < 2) {
    return <div style={{ fontSize: 12, color: '#475569', padding: 12, textAlign: 'center' }}>至少需要 2 欼评估才能绘制趋势</div>;
  }
  const w = 700;
  const h = 140;
  const pad = { top: 12, right: 16, bottom: 24, left: 36 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const yMin = 0;
  const yMax = 100;
  const xScale = (i: number) => pad.left + (i / Math.max(snapshots.length - 1, 1)) * cw;
  const yScale = (v: number) => pad.top + ch - ((v - yMin) / (yMax - yMin)) * ch;
  const points = snapshots.map((s, i) => `${xScale(i)},${yScale(s.overallScore)}`).join(' ');

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', maxWidth: w }}>
      {[0, 25, 50, 75, 100].map(v => (
        <g key={v}>
          <line x1={pad.left} y1={yScale(v)} x2={w - pad.right} y2={yScale(v)} stroke="rgba(148,163,184,.08)" strokeWidth={1} />
          <text x={pad.left - 6} y={yScale(v) + 3} textAnchor="end" fontSize={9} fill="#475569">{v}</text>
        </g>
      ))}
      <polyline points={points} fill="none" stroke="#06b6d4" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {snapshots.map((s, i) => (
        <circle key={i} cx={xScale(i)} cy={yScale(s.overallScore)} r={3} fill="#06b6d4">
          <title>{`${new Date(s.timestamp).toLocaleString()}: ${s.overallScore.toFixed(1)}`}</title>
        </circle>
      ))}
      <text x={pad.left} y={h - 4} fontSize={9} fill="#475569">{new Date(snapshots[0].timestamp).toLocaleDateString()}</text>
      <text x={w - pad.right} y={h - 4} textAnchor="end" fontSize={9} fill="#475569">{new Date(snapshots[snapshots.length - 1].timestamp).toLocaleDateString()}</text>
    </svg>
  );
}
