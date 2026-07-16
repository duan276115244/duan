import { useState, useEffect } from 'react';
import { ArrowLeft, Layers, CheckCircle, BarChart3, RotateCcw, Loader2, Zap, AlertTriangle, Search, Trash2, Sparkles, X, Send, GitBranch } from 'lucide-react';

interface SkillMeta {
  id: string; name: string; version: string; description: string;
  category: string; tags: string[]; successRate: number; usageCount: number;
  createdAt: number; updatedAt: number;
  lastUsed?: number; source?: 'builtin' | 'learned' | 'extracted' | 'generated';
}

interface SkillQualityReport {
  skillId: string; overallScore: number;
  dimensions: { correctness: number; completeness: number; usability: number; performance: number };
  executionSuccessRate: number; sampleSize: number; recommendations: string[];
}

interface SkillVersion {
  version: string; createdAt: number; message: string;
}

interface SkillDetailResult {
  success: boolean;
  quality?: SkillQualityReport;
  versions?: SkillVersion[];
  content?: string;
  error?: string;
}

interface RollbackResponse {
  success?: boolean;
  message?: string;
  error?: string;
}

interface MarketSkill {
  id: string;
  name: string;
  version?: string;
  description?: string;
  tags?: string[];
  author?: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  development: '#8b5cf6', research: '#06b6d4', writing: '#10b981',
  data: '#f59e0b', design: '#ec4899', communication: '#3b82f6',
  automation: '#f97316',
};


function SkillCard({ skill, onSelect, onDelete }: { skill: SkillMeta; onSelect: (id: string) => void; onDelete: (id: string) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="card-hover"
      style={{
        padding: 16, borderRadius: 12, cursor: 'pointer',
        border: hovered ? '1px solid rgba(6,182,212,.3)' : '1px solid rgba(255,255,255,.06)',
        background: hovered ? 'rgba(6,182,212,.06)' : 'rgba(255,255,255,.02)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        transition: 'all .2s ease',
        boxShadow: hovered ? '0 4px 20px rgba(6,182,212,.12)' : 'none',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => onSelect(skill.id)}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: CATEGORY_COLORS[skill.category] || '#64748b', boxShadow: `0 0 10px ${CATEGORY_COLORS[skill.category] || '#64748b'}60` }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{skill.name}</span>
          <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(139,92,246,.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.15)' }}>v{skill.version}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: (skill.successRate ?? 0) >= 0.85 ? '#10b981' : (skill.successRate ?? 0) >= 0.5 ? '#f59e0b' : '#ef4444' }}>
            {(skill.successRate ?? 0) >= 0.85 ? <CheckCircle style={{ width: 12, height: 12, display: 'inline', marginRight: 2, verticalAlign: -1 }} /> :
             (skill.successRate ?? 0) > 0 ? <AlertTriangle style={{ width: 12, height: 12, display: 'inline', marginRight: 2, verticalAlign: -1 }} /> :
             <Zap style={{ width: 12, height: 12, display: 'inline', marginRight: 2, verticalAlign: -1 }} />}
            {((skill.successRate ?? 0) * 100).toFixed(0)}%
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(skill.id); }}
            style={{
              padding: 3, borderRadius: 5,
              background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.1)',
              cursor: 'pointer', color: '#64748b',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all .15s', opacity: hovered ? 1 : 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,.12)'; e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.borderColor = 'rgba(239,68,68,.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,.06)'; e.currentTarget.style.color = '#64748b'; e.currentTarget.style.borderColor = 'rgba(239,68,68,.1)'; }}
          >
            <Trash2 style={{ width: 11, height: 11 }} />
          </button>
        </div>
      </div>
      <p onClick={() => onSelect(skill.id)} style={{ fontSize: 12, color: '#64748b', margin: '6px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.description}</p>
      <div onClick={() => onSelect(skill.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: '#475569' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {skill.source === 'learned' && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(16,185,129,.1)', color: '#10b981', border: '1px solid rgba(16,185,129,.15)' }}>学习</span>}
          {skill.source === 'builtin' && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(6,182,212,.1)', color: '#06b6d4', border: '1px solid rgba(6,182,212,.15)' }}>内置</span>}
          {skill.source === 'generated' && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(245,158,11,.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.15)' }}>AI生成</span>}
          {(!skill.source || skill.source === 'extracted') && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(139,92,246,.1)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.15)' }}>提取</span>}
          {skill.category} · {skill.usageCount}次使用
        </span>
        <span>{skill.lastUsed ? new Date(skill.lastUsed).toLocaleDateString() : new Date(skill.updatedAt).toLocaleDateString()}</span>
      </div>
      <div onClick={() => onSelect(skill.id)} style={{ display: 'flex', gap: 4, marginTop: 8 }}>
        {skill.tags.slice(0, 4).map(tag => (
          <span key={tag} style={{ fontSize: 9, padding: '2px 7px', borderRadius: 8, background: 'rgba(6,182,212,.08)', color: '#67e8f9', border: '1px solid rgba(6,182,212,.1)' }}>{tag}</span>
        ))}
      </div>
    </div>
  );
}

// ===== 从 SKILL.md 内容正则提取 tools 字段 =====
// 支持格式：tools: [a, b, c]（内联数组）或 YAML 多行列表（tools: \n  - a \n  - b）
function extractToolsFromContent(content: string): string[] {
  if (!content) return [];
  // 格式 1：tools: [a, b, c]（内联数组）
  const inlineMatch = content.match(/^tools:\s*\[([^\]]+)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map(t => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // 格式 2：YAML 多行列表（tools: 后跟若干 `  - item` 行）
  const multiLineMatch = content.match(/^tools:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (multiLineMatch) {
    return multiLineMatch[1]
      .split('\n')
      .map(line => line.match(/^\s+-\s+(.+)/)?.[1].trim().replace(/^["']|["']$/g, ''))
      .filter((t): t is string => !!t);
  }
  return [];
}

// ===== 技能依赖 SVG mini-graph（纯 SVG 二部图）=====
function SkillDependencyGraph({ tools, skillName }: { tools: string[]; skillName: string }) {
  const svgWidth = 300;
  const rowHeight = 80;
  const svgHeight = Math.max(rowHeight * tools.length, 60);
  const skillNodeX = 60;
  const skillNodeY = svgHeight / 2;
  const skillNodeW = 80;
  const skillNodeH = 28;
  const toolNodeX = 220;
  const toolNodeR = 5;

  return (
    <svg width={svgWidth} height={svgHeight} style={{ display: 'block', maxWidth: '100%' }}>
      <defs>
        <marker id="dep-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#475569" />
        </marker>
      </defs>
      {/* 技能节点（左侧 rect + text） */}
      <rect
        x={skillNodeX - skillNodeW / 2}
        y={skillNodeY - skillNodeH / 2}
        width={skillNodeW}
        height={skillNodeH}
        rx="6"
        fill="rgba(6,182,212,.1)"
        stroke="#06b6d4"
        strokeWidth="1"
      />
      <text
        x={skillNodeX}
        y={skillNodeY + 4}
        fill="#e2e8f0"
        fontSize="11"
        fontWeight="500"
        textAnchor="middle"
        fontFamily="inherit"
      >
        {skillName.length > 8 ? skillName.substring(0, 7) + '…' : skillName}
      </text>
      {/* 工具节点（右侧 circle + text）+ 贝塞尔连线 */}
      {tools.map((tool, i) => {
        const y = (i + 0.5) * (svgHeight / tools.length);
        const startX = skillNodeX + skillNodeW / 2;
        const startY = skillNodeY;
        const endX = toolNodeX - toolNodeR;
        const endY = y;
        const midX = (startX + endX) / 2;
        return (
          <g key={`dep-${i}`}>
            <path
              d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
              fill="none"
              stroke="#475569"
              strokeWidth="1"
              strokeDasharray="3 2"
              markerEnd="url(#dep-arrow)"
              opacity="0.6"
            />
            <circle cx={toolNodeX} cy={y} r={toolNodeR} fill="#8b5cf6" />
            <text
              x={toolNodeX + toolNodeR + 6}
              y={y + 3}
              fill="#94a3b8"
              fontSize="10"
              fontFamily="inherit"
            >
              {tool.length > 14 ? tool.substring(0, 13) + '…' : tool}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function SkillDetail({ skillId, onBack }: { skillId: string; onBack: () => void }) {
  const [meta, setMeta] = useState<SkillMeta | null>(null);
  const [content, setContent] = useState<string>('');
  const [quality, setQuality] = useState<SkillQualityReport | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollbackMsg, setRollbackMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (isE) {
      // Electron 模式：通过 IPC 从 main.js 读取真实技能数据
      const api = window.electronAPI;
      if (api?.skill?.list) {
        api.skill.list().then((result) => {
          if (cancelled) return;
          if (result.success && result.skills && result.skills.length > 0) {
            const skill = result.skills.find((s) => s.id === skillId);
            if (skill) {
              setMeta(skill);
            }
          }
          setLoading(false);
        }).catch(() => {
          if (cancelled) return;
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
      // 通过 IPC 读取质量评估、版本历史和技能内容
      if (api?.skill?.detail) {
        api.skill.detail(skillId).then((result: SkillDetailResult) => {
          if (cancelled || !result.success) return;
          if (result.quality) setQuality(result.quality);
          if (result.versions && result.versions.length > 0) setVersions(result.versions);
          // 修复：使用从 main.js 返回的 SKILL.md 内容
          if (result.content) setContent(result.content);
        }).catch(() => {});
      }
      return;
    }
    const safeJson = async (resp: Response) => {
      if (!resp.ok) return null;
      try { return await resp.json(); } catch { return null; }
    };
    Promise.all([
      fetch(`/api/skills/${skillId}`).then(safeJson),
      fetch(`/api/skills/${skillId}/quality`).then(safeJson),
      fetch(`/api/skills/${skillId}/versions`).then(safeJson),
    ]).then(([skillData, qualityData, versionsData]) => {
      if (cancelled) return;
      setMeta(skillData?.meta ?? null);
      setContent(skillData?.content || '');
      setQuality(qualityData ?? null);
      setVersions(Array.isArray(versionsData) ? versionsData : []);
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skillId]);

  const handleRollback = async (version: string) => {
    // P0 修复：支持 Electron 模式（通过 IPC 转发到 Agent 服务器）
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    let data: RollbackResponse;
    if (isE) {
      // Electron 模式：通过 HTTP 调用 Agent 服务器（preload 已配置 baseURL）
      try {
        const resp = await fetch(`/api/skills/${skillId}/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version }),
        });
        data = await resp.json();
      } catch (e: unknown) {
        setRollbackMsg(`回滚失败: ${e instanceof Error ? e.message : String(e)}`);
        setTimeout(() => setRollbackMsg(''), 3000);
        return;
      }
    } else {
      // Web 模式：直接 fetch
      const resp = await fetch(`/api/skills/${skillId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      data = await resp.json();
    }
    setRollbackMsg(data.message || data.error || '');
    if (data.success) setTimeout(() => onBack(), 1500);
    setTimeout(() => setRollbackMsg(''), 3000);
  };

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 style={{ width: 24, height: 24, color: '#06b6d4', animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (!meta) {
    return (
      <div style={{ padding: 28, textAlign: 'center' }}>
        <button onClick={onBack} style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', cursor: 'pointer', color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 24, fontFamily: 'inherit', backdropFilter: 'blur(12px)', transition: 'all .15s' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} /> 返回列表
        </button>
        <div style={{ padding: 32, color: '#64748b' }}>
          <AlertTriangle style={{ width: 36, height: 36, margin: '0 auto 12px', opacity: 0.4 }} />
          <p style={{ fontSize: 15, color: '#94a3b8', margin: '0 0 6px' }}>技能不存在或已被删除</p>
          <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>该技能可能只有工具调用记录，没有完整的技能定义文件</p>
        </div>
      </div>
    );
  }

  // ===== 计算学习熟练度 =====
  const proficiency = (meta.successRate ?? 0) * Math.min((meta.usageCount ?? 0) / 10, 1);
  const proficiencyTier: 'novice' | 'proficient' | 'expert' =
    proficiency < 0.3 ? 'novice' : proficiency <= 0.7 ? 'proficient' : 'expert';
  const proficiencyColor = proficiencyTier === 'novice' ? '#64748b' : proficiencyTier === 'proficient' ? '#3b82f6' : '#06b6d4';
  const proficiencyLabel = proficiencyTier === 'novice' ? '新手' : proficiencyTier === 'proficient' ? '熟练' : '专家';

  // ===== 从 SKILL.md 内容提取工具依赖 =====
  const tools = extractToolsFromContent(content);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 28 }}>
      <button onClick={onBack} style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 18, fontFamily: 'inherit', backdropFilter: 'blur(12px)', transition: 'all .15s' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
      >
        <ArrowLeft style={{ width: 14, height: 14 }} /> 返回列表
      </button>

      {rollbackMsg && (
        <div style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: rollbackMsg.includes('成功') ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)', border: `1px solid ${rollbackMsg.includes('成功') ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`, fontSize: 13, color: '#e2e8f0', textAlign: 'center', backdropFilter: 'blur(12px)' }}>{rollbackMsg}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: CATEGORY_COLORS[meta.category] || '#64748b', boxShadow: `0 0 14px ${CATEGORY_COLORS[meta.category] || '#64748b'}60` }} />
        <h2 className="gradient-text" style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{meta.name}</h2>
        <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, background: 'rgba(139,92,246,.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.2)' }}>v{meta.version}</span>
      </div>

      <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 22 }}>{meta.description}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 22 }}>
        <div className="glass-effect" style={{ padding: 14, borderRadius: 10 }}>
          <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>分类</p>
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{meta.category}</p>
        </div>
        <div className="glass-effect" style={{ padding: 14, borderRadius: 10 }}>
          <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>使用次数</p>
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{meta.usageCount}</p>
        </div>
        <div className="glass-effect" style={{ padding: 14, borderRadius: 10 }}>
          <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>成功率</p>
          <p style={{ fontSize: 13, fontWeight: 500, color: (meta.successRate ?? 0) >= 0.85 ? '#10b981' : '#f59e0b', margin: 0 }}>{((meta.successRate ?? 0) * 100).toFixed(1)}%</p>
        </div>
        <div className="glass-effect" style={{ padding: 14, borderRadius: 10 }}>
          <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>标签</p>
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{meta.tags.join(', ') || '无'}</p>
        </div>
      </div>

      {/* 学习熟练度条 - CSS div 进度条 */}
      <div className="glass-effect" style={{ padding: 14, borderRadius: 10, marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>学习熟练度</p>
          <span style={{ fontSize: 11, fontWeight: 500, color: proficiencyColor }}>{proficiencyLabel} · {(proficiency * 100).toFixed(0)}%</span>
        </div>
        <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'rgba(255,255,255,.06)' }}>
          <div style={{ width: `${proficiency * 100}%`, height: '100%', borderRadius: 3, background: proficiencyColor, transition: 'width .5s', boxShadow: `0 0 6px ${proficiencyColor}60` }} />
        </div>
      </div>

      {/* 质量报告 - 玻璃态 */}
      {quality && (
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <BarChart3 style={{ width: 16, height: 16, color: '#8b5cf6' }} />
            <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>质量评估</h3>
            <span style={{ fontSize: 12, marginLeft: 'auto', padding: '3px 10px', borderRadius: 12, background: quality.overallScore >= 0.7 ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.12)', color: quality.overallScore >= 0.7 ? '#10b981' : '#f59e0b', border: `1px solid ${quality.overallScore >= 0.7 ? 'rgba(16,185,129,.2)' : 'rgba(245,158,11,.2)'}` }}>
              综合 {((quality.overallScore ?? 0) * 100).toFixed(0)}分
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            {Object.entries(quality.dimensions ?? {}).map(([key, val]) => (
              <div key={key} style={{ textAlign: 'center', padding: 12, borderRadius: 10, background: 'rgba(139,92,246,.04)', border: '1px solid rgba(139,92,246,.08)' }}>
                <p style={{ fontSize: 10, color: '#64748b', margin: '0 0 6px', textTransform: 'capitalize' }}>{key}</p>
                <div style={{ width: '100%', height: 4, borderRadius: 2, background: 'rgba(139,92,246,.1)', marginBottom: 6 }}>
                  <div style={{ width: `${(val ?? 0) * 100}%`, height: '100%', borderRadius: 2, background: (val ?? 0) >= 0.7 ? '#8b5cf6' : (val ?? 0) >= 0.4 ? '#f59e0b' : '#ef4444', transition: 'width .5s', boxShadow: `0 0 6px ${(val ?? 0) >= 0.7 ? 'rgba(139,92,246,.4)' : 'rgba(245,158,11,.4)'}` }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{((val ?? 0) * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
          {Array.isArray(quality.recommendations) && quality.recommendations.length > 0 && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              <p style={{ margin: '0 0 6px', fontWeight: 500, color: '#e2e8f0' }}>建议:</p>
              {quality.recommendations.map((r, i) => (
                <p key={i} style={{ margin: '3px 0', paddingLeft: 12 }}>• {r}</p>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 版本历史 - 玻璃态 */}
      <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <Layers style={{ width: 16, height: 16, color: '#06b6d4' }} />
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>版本历史</h3>
        </div>
        {versions.length === 0 ? (
          <p style={{ fontSize: 12, color: '#475569' }}>暂无版本记录</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {versions.slice().reverse().map((v) => {
              const isCurrent = v.version === meta.version;
              return (
                <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, background: isCurrent ? 'rgba(6,182,212,.06)' : 'rgba(255,255,255,.02)', border: isCurrent ? '1px solid rgba(6,182,212,.2)' : '1px solid rgba(255,255,255,.04)' }}>
                  <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: isCurrent ? 'rgba(6,182,212,.12)' : 'rgba(255,255,255,.04)', color: isCurrent ? '#67e8f9' : '#64748b', fontWeight: 600, border: `1px solid ${isCurrent ? 'rgba(6,182,212,.2)' : 'rgba(255,255,255,.06)'}` }}>v{v.version}</span>
                  <span style={{ flex: 1, fontSize: 12, color: '#94a3b8' }}>{v.message}</span>
                  <span style={{ fontSize: 10, color: '#475569' }}>{new Date(v.createdAt).toLocaleString()}</span>
                  {isCurrent ? (
                    <span style={{ fontSize: 10, color: '#10b981', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 4px rgba(16,185,129,.5)' }} />
                      当前
                    </span>
                  ) : (
                    <button
                      onClick={() => handleRollback(v.version)}
                      style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.15)', cursor: 'pointer', color: '#f59e0b', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit', transition: 'all .15s' }}
                    >
                      <RotateCcw style={{ width: 10, height: 10 }} /> 回滚
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 技能依赖 - 纯 SVG mini-graph 二部图 */}
      <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <GitBranch style={{ width: 16, height: 16, color: '#06b6d4' }} />
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>技能依赖</h3>
        </div>
        {tools.length === 0 ? (
          <p style={{ fontSize: 12, color: '#475569' }}>无依赖信息</p>
        ) : (
          <SkillDependencyGraph tools={tools} skillName={meta.name} />
        )}
      </section>

      {/* 技能内容 - 玻璃态 */}
      {content && (
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: '0 0 12px' }}>SKILL.md</h3>
          <pre style={{ fontSize: 12, color: '#94a3b8', background: 'rgba(2,6,12,.6)', padding: 16, borderRadius: 10, overflowX: 'auto', lineHeight: 1.6, maxHeight: 400, overflowY: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid rgba(255,255,255,.04)' }}>{content}</pre>
        </section>
      )}
    </div>
  );
}

export function SkillManagePage({ onBack }: { onBack?: () => void }) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteMsg, setDeleteMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showGenModal, setShowGenModal] = useState(false);
  const [genDesc, setGenDesc] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 打包技能状态
  const [showPkgModal, setShowPkgModal] = useState(false);
  const [pkgForm, setPkgForm] = useState({ name: '', description: '', intent: '', tools: '', steps: '', keywords: '' });
  const [packaging, setPackaging] = useState(false);
  const [pkgResult, setPkgResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // E3: 技能市场 Tab 状态
  const [tab, setTab] = useState<'my' | 'market'>('my');
  const [marketSkills, setMarketSkills] = useState<MarketSkill[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketAction, setMarketAction] = useState<string | null>(null);
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(new Set());

  const fetchSkills = async () => {
    setLoading(true);
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (isE) {
      // Electron 模式：优先从 Web 服务器获取真实技能数据
      const api = window.electronAPI;
      // 优先从 Web 服务器 API 获取（真实数据，与 Agent 同步）
      if (api?.skill?.remote) {
        try {
          const result = await api.skill.remote();
          if (result?.skills && Array.isArray(result.skills)) {
            setSkills(result.skills);
            setLoading(false);
            return;
          }
        } catch { /* 回退到本地 IPC */ }
      }
      // 回退到本地 IPC 数据
      if (api?.skill?.refresh) {
        try { await api.skill.refresh(); } catch { /* ignore */ }
      }
      if (api?.skill?.list) {
        try {
          const result = await api.skill.list();
          if (result.success && result.skills) {
            setSkills(result.skills);
          } else {
            setSkills([]);
          }
        } catch {
          setSkills([]);
        } finally {
          setLoading(false);
        }
      } else {
        setSkills([]);
        setLoading(false);
      }
      return;
    }
    fetch('/api/skills').then(async (r) => {
      if (!r.ok) return [];
      try { return await r.json(); } catch { return []; }
    }).then(data => {
      const list = Array.isArray(data) ? data : [];
      setSkills(list);
    }).catch(() => { setSkills([]); }).finally(() => setLoading(false));
  };

  const handleDeleteSkill = async (id: string) => {
    if (!confirm(`确定删除技能 ${id} 吗？此操作不可撤销。`)) return;
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (isE) {
      const api = window.electronAPI;
      if (api?.skill?.delete) {
        try {
          const result = await api.skill.delete(id);
          if (result?.success) {
            setDeleteMsg({ type: 'success', text: `技能 ${id} 已删除` });
            fetchSkills();
          } else {
            setDeleteMsg({ type: 'error', text: result?.message || '删除失败' });
          }
        } catch (err: unknown) {
          setDeleteMsg({ type: 'error', text: (err instanceof Error ? err.message : String(err)) || '删除失败' });
        }
      }
      return;
    }
    try {
      const resp = await fetch(`/api/skills/${id}`, { method: 'DELETE' });
      const data = await resp.json();
      if (data.success) {
        setDeleteMsg({ type: 'success', text: `技能 ${id} 已删除` });
        fetchSkills();
      } else {
        setDeleteMsg({ type: 'error', text: data.message || '删除失败' });
      }
    } catch (err: unknown) {
      setDeleteMsg({ type: 'error', text: (err instanceof Error ? err.message : String(err)) || '删除失败' });
    }
  };

  useEffect(() => { fetchSkills(); }, []);

  // E3: 加载技能市场数据
  const fetchMarketSkills = async () => {
    setMarketLoading(true);
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    // 同步已安装技能 ID 集合（用于市场列表显示"已安装"标记）
    setInstalledSkillIds(new Set(skills.map(s => s.id)));
    try {
      if (isE) {
        const api = window.electronAPI;
        if (api?.skill?.marketList) {
          const result = await api.skill.marketList();
          if (result?.success && Array.isArray(result.skills)) {
            setMarketSkills(result.skills);
          } else {
            setMarketSkills([]);
          }
        } else {
          setMarketSkills([]);
        }
      } else {
        // Web 模式：尝试从 /api/skills/marketplace 获取（若后端支持）
        try {
          const resp = await fetch('/api/skills/marketplace');
          if (resp.ok) {
            const data = await resp.json();
            setMarketSkills(Array.isArray(data) ? data : (data.skills || []));
          } else {
            setMarketSkills([]);
          }
        } catch {
          setMarketSkills([]);
        }
      }
    } catch {
      setMarketSkills([]);
    } finally {
      setMarketLoading(false);
    }
  };

  // E3: 安装/卸载市场技能
  const handleMarketAction = async (action: 'install' | 'uninstall', skillId: string) => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    setMarketAction(`${action}:${skillId}`);
    try {
      if (isE) {
        const api = window.electronAPI;
        if (!api?.skill) return;
        const result = action === 'install'
          ? await api.skill.marketInstall(skillId)
          : await api.skill.marketUninstall(skillId);
        if (result?.success) {
          setDeleteMsg({ type: 'success', text: `${action === 'install' ? '安装' : '卸载'}成功: ${skillId}` });
          // 刷新市场 + 本地技能列表
          fetchMarketSkills();
          fetchSkills();
        } else {
          setDeleteMsg({ type: 'error', text: result?.error || `${action}失败` });
        }
      } else {
        const url = `/api/skills/marketplace/${action === 'install' ? 'install' : 'uninstall'}/${encodeURIComponent(skillId)}`;
        const resp = await fetch(url, { method: 'POST' });
        const data = await resp.json();
        if (data?.success) {
          setDeleteMsg({ type: 'success', text: `${action === 'install' ? '安装' : '卸载'}成功: ${skillId}` });
          fetchMarketSkills();
          fetchSkills();
        } else {
          setDeleteMsg({ type: 'error', text: data?.error || `${action}失败` });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeleteMsg({ type: 'error', text: msg });
    } finally {
      setMarketAction(null);
    }
  };

  useEffect(() => { if (tab === 'market') fetchMarketSkills(); /* eslint-disable-next-line */ }, [tab]);

  // 学习新技能：通过 Agent 服务器让 AI 真正生成并保存技能
  const handleGenerateSkill = async () => {
    if (!genDesc.trim()) {
      setGenResult({ type: 'error', text: '请输入技能描述' });
      return;
    }
    setGenerating(true);
    setGenResult(null);
    try {
      const isE = typeof window !== 'undefined' && !!window.electronAPI;
      if (isE) {
        const api = window.electronAPI;
        if (api?.skill?.generate) {
          const result = await api.skill.generate(genDesc.trim());
          if (result?.success) {
            const skillName = result.skill?.name || genDesc.trim();
            setGenResult({ type: 'success', text: `技能 "${skillName}" 已成功生成并保存！正在刷新列表...` });
            setGenDesc('');
            // 等待 1 秒后刷新技能列表
            setTimeout(() => { fetchSkills(); }, 1000);
          } else {
            setGenResult({ type: 'error', text: result?.error || '生成失败，请检查 API Key 是否配置正确' });
          }
        } else {
          setGenResult({ type: 'error', text: '当前环境不支持技能生成' });
        }
      } else {
        // Web 模式：直接调用 /api/skills/generate
        const resp = await fetch('/api/skills/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: genDesc.trim() }),
        });
        const data = await resp.json();
        if (data?.success) {
          const skillName = data.skill?.name || genDesc.trim();
          setGenResult({ type: 'success', text: `技能 "${skillName}" 已成功生成并保存！正在刷新列表...` });
          setGenDesc('');
          setTimeout(() => { fetchSkills(); }, 1000);
        } else {
          setGenResult({ type: 'error', text: data?.error || '生成失败，请稍后重试' });
        }
      }
    } catch (err: unknown) {
      setGenResult({ type: 'error', text: (err instanceof Error ? err.message : String(err)) || '生成失败' });
    } finally {
      setGenerating(false);
    }
  };

  // 打包技能：从成功案例创建真实的 SKILL.md 定义文件
  // 区别于"学习新技能"（仅生成名字），打包技能会写入完整的 SKILL.md（YAML frontmatter + 步骤 + 工具 + 案例）
  const handlePackageSkill = async () => {
    if (!pkgForm.name.trim() || !pkgForm.description.trim()) {
      setPkgResult({ type: 'error', text: '技能名称和描述不能为空' });
      return;
    }
    setPackaging(true);
    setPkgResult(null);
    try {
      const isE = typeof window !== 'undefined' && !!window.electronAPI;
      // 将表单字符串转为数组（按换行/逗号/分号分隔）
      const splitList = (s: string): string[] =>
        s.split(/[\n,;，；]+/).map(x => x.trim()).filter(Boolean);
      const payload = {
        name: pkgForm.name.trim(),
        description: pkgForm.description.trim(),
        intent: pkgForm.intent.trim(),
        toolsUsed: splitList(pkgForm.tools),
        steps: splitList(pkgForm.steps),
        keywords: splitList(pkgForm.keywords),
        examples: pkgForm.intent.trim() ? [pkgForm.intent.trim()] : [],
      };
      if (isE) {
        const api = window.electronAPI;
        if (api?.skill?.package) {
          const result = await api.skill.package(payload);
          if (result?.success) {
            setPkgResult({ type: 'success', text: `技能 "${payload.name}" 已成功打包为真实 SKILL.md！正在刷新列表...` });
            setPkgForm({ name: '', description: '', intent: '', tools: '', steps: '', keywords: '' });
            setTimeout(() => { fetchSkills(); }, 800);
          } else {
            setPkgResult({ type: 'error', text: result?.error || '打包失败' });
          }
        } else {
          setPkgResult({ type: 'error', text: '当前环境不支持技能打包' });
        }
      } else {
        // Web 模式：通过 Agent 服务器 API 打包（若服务器支持）
        const resp = await fetch('/api/skills/package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json().catch(() => ({}));
        if (data?.success) {
          setPkgResult({ type: 'success', text: `技能 "${payload.name}" 已成功打包！正在刷新列表...` });
          setPkgForm({ name: '', description: '', intent: '', tools: '', steps: '', keywords: '' });
          setTimeout(() => { fetchSkills(); }, 800);
        } else {
          setPkgResult({ type: 'error', text: data?.error || '打包失败，请稍后重试' });
        }
      }
    } catch (err: unknown) {
      setPkgResult({ type: 'error', text: (err instanceof Error ? err.message : String(err)) || '打包失败' });
    } finally {
      setPackaging(false);
    }
  };

  // 实时同步：监听技能数据变化，自动刷新
  useEffect(() => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (!isE) return;
    const api = window.electronAPI;
    if (!api?.skill?.onUpdated) return;
    // 订阅主进程的技能更新通知
    const unsubscribe = api.skill.onUpdated((data) => {
      if (data?.skills && Array.isArray(data.skills)) {
        setSkills(data.skills);
      } else {
        // 收到通知但无数据，主动拉取
        fetchSkills();
      }
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  useEffect(() => {
    if (deleteMsg) {
      const timer = setTimeout(() => setDeleteMsg(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [deleteMsg]);

  // 搜索过滤
  const filteredSkills = skills.filter(skill => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return skill.name.toLowerCase().includes(q) ||
           skill.id.toLowerCase().includes(q) ||
           skill.description.toLowerCase().includes(q) ||
           skill.tags.some(tag => tag.toLowerCase().includes(q)) ||
           skill.category.toLowerCase().includes(q);
  });

  if (selectedSkill) {
    return (
      <div style={{ height: '100%', overflowY: 'auto', backgroundColor: '#0a0e1a' }}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          <SkillDetail skillId={selectedSkill} onBack={() => setSelectedSkill(null)} />
        </div>
      </div>
    );
  }

  const totalScore = skills.length > 0
    ? skills.reduce((s, sk) => s + (sk.successRate ?? 0), 0) / skills.length
    : 0;
  const totalUsage = skills.reduce((s, sk) => s + (sk.usageCount || 0), 0);
  const usedSkills = skills.filter(s => (s.usageCount || 0) > 0).length;

  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: '#0a0e1a' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: 28 }}>
        {/* Header - 玻璃态 */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {onBack && (
              <button onClick={onBack} style={{
                padding: 8, borderRadius: 10,
                background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                cursor: 'pointer', color: '#94a3b8',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(12px)',
                transition: 'all .15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
              >
                <ArrowLeft style={{ width: 16, height: 16 }} />
              </button>
            )}
            <div>
              <h1 className="gradient-text" style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>技能管理</h1>
              <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>查看和管理 AI 自动生成的技能</p>
            </div>
            <span className="live-indicator" style={{ marginLeft: 8 }}>LIVE</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setShowGenModal(true); setGenResult(null); setGenDesc(''); }} style={{
              padding: '9px 18px', borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.15))',
              border: '1px solid rgba(6,182,212,.25)',
              cursor: 'pointer', color: '#06b6d4', fontSize: 12, fontFamily: 'inherit',
              backdropFilter: 'blur(12px)',
              transition: 'all .15s',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              boxShadow: '0 0 12px rgba(6,182,212,.1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(6,182,212,.25), rgba(139,92,246,.25))'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.4)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.15))'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.25)'; }}
            >
              <Sparkles style={{ width: 12, height: 12 }} />
              学习新技能
            </button>
            <button onClick={() => { setShowPkgModal(true); setPkgResult(null); }} style={{
              padding: '9px 18px', borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(16,185,129,.15), rgba(6,182,212,.15))',
              border: '1px solid rgba(16,185,129,.3)',
              cursor: 'pointer', color: '#10b981', fontSize: 12, fontFamily: 'inherit',
              backdropFilter: 'blur(12px)',
              transition: 'all .15s',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              boxShadow: '0 0 12px rgba(16,185,129,.1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(16,185,129,.25), rgba(6,182,212,.25))'; e.currentTarget.style.borderColor = 'rgba(16,185,129,.5)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(16,185,129,.15), rgba(6,182,212,.15))'; e.currentTarget.style.borderColor = 'rgba(16,185,129,.3)'; }}
            >
              <Layers style={{ width: 12, height: 12 }} />
              打包技能
            </button>
            <button onClick={fetchSkills} style={{
              padding: '9px 18px', borderRadius: 10,
              background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
              cursor: 'pointer', color: '#94a3b8', fontSize: 12, fontFamily: 'inherit',
              backdropFilter: 'blur(12px)',
              transition: 'all .15s',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; e.currentTarget.style.color = '#e2e8f0'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; e.currentTarget.style.color = '#94a3b8'; }}
            >
              <RotateCcw style={{ width: 12, height: 12 }} />
              刷新
            </button>
          </div>
        </header>

        {/* E3: Tab 切换 — 我的技能 / 技能市场 */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid rgba(255,255,255,.06)' }}>
          <button
            onClick={() => setTab('my')}
            style={{
              padding: '8px 16px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
              background: tab === 'my' ? 'rgba(6,182,212,.08)' : 'transparent',
              border: 'none', borderBottom: tab === 'my' ? '2px solid #06b6d4' : '2px solid transparent',
              color: tab === 'my' ? '#06b6d4' : '#64748b', fontSize: 13, fontWeight: tab === 'my' ? 500 : 400,
              display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', transition: 'all .15s', marginBottom: -1,
            }}
          >
            <Layers style={{ width: 14, height: 14 }} />
            我的技能
            {skills.length > 0 && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(6,182,212,.15)', color: '#06b6d4', border: '1px solid rgba(6,182,212,.2)' }}>{skills.length}</span>}
          </button>
          <button
            onClick={() => setTab('market')}
            style={{
              padding: '8px 16px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
              background: tab === 'market' ? 'rgba(139,92,246,.08)' : 'transparent',
              border: 'none', borderBottom: tab === 'market' ? '2px solid #8b5cf6' : '2px solid transparent',
              color: tab === 'market' ? '#8b5cf6' : '#64748b', fontSize: 13, fontWeight: tab === 'market' ? 500 : 400,
              display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', transition: 'all .15s', marginBottom: -1,
            }}
          >
            <Sparkles style={{ width: 14, height: 14 }} />
            技能市场
          </button>
        </div>

        {/* 删除消息提示 */}
        {deleteMsg && (
          <div style={{ marginBottom: 16, padding: '10px 16px', borderRadius: 10, background: deleteMsg.type === 'success' ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)', border: `1px solid ${deleteMsg.type === 'success' ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`, color: deleteMsg.type === 'success' ? '#10b981' : '#ef4444', fontSize: 13 }}>
            {deleteMsg.text}
          </div>
        )}

        {/* ===== 我的技能 Tab ===== */}
        {tab === 'my' && (
        <>
        {/* 搜索框 */}
        <div style={{ marginBottom: 18, position: 'relative' }}>
          <Search style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: '#475569' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索技能名称、描述、标签..."
            style={{
              width: '100%', padding: '10px 14px 10px 36px', fontSize: 13,
              background: 'rgba(255,255,255,.03)', borderRadius: 10,
              border: '1px solid rgba(255,255,255,.08)', outline: 'none',
              color: '#e2e8f0', boxSizing: 'border-box', fontFamily: 'inherit',
              transition: 'border-color .15s',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(6,182,212,.3)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
          />
          {searchQuery && (
            <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#475569' }}>
              {filteredSkills.length}/{skills.length}
            </span>
          )}
        </div>

        {/* 概览统计 - 玻璃态卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          <div className="glass-effect" style={{ padding: 16, borderRadius: 12 }}>
            <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>技能总数</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>{skills.length}</p>
          </div>
          <div className="glass-effect" style={{ padding: 16, borderRadius: 12 }}>
            <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>平均成功率</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: totalScore >= 0.85 ? '#10b981' : '#f59e0b', margin: 0 }}>{((totalScore ?? 0) * 100).toFixed(1)}%</p>
          </div>
          <div className="glass-effect" style={{ padding: 16, borderRadius: 12 }}>
            <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>总使用次数</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: '#06b6d4', margin: 0 }}>{totalUsage}</p>
          </div>
          <div className="glass-effect" style={{ padding: 16, borderRadius: 12 }}>
            <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>已使用 / 达标</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>{usedSkills} <span style={{ fontSize: 14, color: '#475569' }}>/ {skills.filter(s => (s.successRate ?? 0) >= 0.85).length}</span></p>
          </div>
        </div>

        {/* 技能列表 */}
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
            <Loader2 style={{ width: 28, height: 28, color: '#06b6d4', animation: 'spin 1s linear infinite' }} />
          </div>
        ) : filteredSkills.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#475569' }}>
            <Layers style={{ width: 40, height: 40, margin: '0 auto 14px', opacity: 0.3 }} />
            <p style={{ fontSize: 14, color: '#64748b' }}>{searchQuery ? '没有找到匹配的技能' : '暂无自动生成的技能'}</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>{searchQuery ? '尝试其他关键词搜索' : '在对话中使用 skill_generate 工具可以创建新技能'}</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
            {filteredSkills.map(skill => (
              <SkillCard key={skill.id} skill={skill} onSelect={setSelectedSkill} onDelete={handleDeleteSkill} />
            ))}
          </div>
        )}
        </>
        )}

        {/* ===== 技能市场 Tab ===== */}
        {tab === 'market' && (
          <div>
            {/* 市场说明栏 */}
            <div className="glass-effect" style={{ borderRadius: 12, padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #8b5cf6, #06b6d4)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Sparkles style={{ width: 16, height: 16 }} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>技能市场</p>
                <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>浏览和安装社区共享的技能包，扩展 Agent 能力</p>
              </div>
              <button
                onClick={fetchMarketSkills}
                disabled={marketLoading}
                style={{ padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', color: '#94a3b8', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}
              >
                {marketLoading ? <Loader2 style={{ width: 11, height: 11 }} className="spin" /> : <RotateCcw style={{ width: 11, height: 11 }} />}
                刷新
              </button>
            </div>

            {/* 市场技能列表 */}
            {marketLoading && marketSkills.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
                <Loader2 style={{ width: 28, height: 28, color: '#8b5cf6', animation: 'spin 1s linear infinite' }} />
              </div>
            ) : marketSkills.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 48, color: '#475569' }}>
                <Sparkles style={{ width: 40, height: 40, margin: '0 auto 14px', opacity: 0.3 }} />
                <p style={{ fontSize: 14, color: '#64748b' }}>市场暂无可用技能</p>
                <p style={{ fontSize: 12, marginTop: 4 }}>可通过「打包技能」将本地技能发布到市场</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
                {marketSkills.map((skill) => {
                  const isInstalled = installedSkillIds.has(skill.id);
                  const actionKey = `${isInstalled ? 'uninstall' : 'install'}:${skill.id}`;
                  return (
                    <div key={skill.id} className="glass-effect" style={{
                      padding: 16, borderRadius: 12,
                      border: isInstalled ? '1px solid rgba(16,185,129,.2)' : '1px solid rgba(139,92,246,.15)',
                      background: isInstalled ? 'rgba(16,185,129,.03)' : 'rgba(139,92,246,.02)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,.5)' }} />
                          <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{skill.name}</span>
                          {skill.version && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(139,92,246,.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.15)' }}>v{skill.version}</span>}
                          {isInstalled && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(16,185,129,.1)', color: '#10b981', border: '1px solid rgba(16,185,129,.15)' }}>已安装</span>}
                        </div>
                      </div>
                      <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.description || '无描述'}</p>
                      {skill.tags && skill.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '8px 0' }}>
                          {skill.tags.slice(0, 4).map((tag: string, i: number) => (
                            <span key={i} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,.04)', color: '#64748b', border: '1px solid rgba(255,255,255,.06)' }}>{tag}</span>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.04)' }}>
                        <span style={{ fontSize: 10, color: '#475569' }}>{skill.author || '未知'}</span>
                        <button
                          onClick={() => handleMarketAction(isInstalled ? 'uninstall' : 'install', skill.id)}
                          disabled={marketAction === actionKey}
                          style={{
                            padding: '4px 12px', fontSize: 11, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                            border: isInstalled ? '1px solid rgba(239,68,68,.2)' : '1px solid rgba(139,92,246,.25)',
                            background: isInstalled ? 'rgba(239,68,68,.06)' : 'rgba(139,92,246,.08)',
                            color: isInstalled ? '#ef4444' : '#a78bfa',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          {marketAction === actionKey ? <Loader2 style={{ width: 10, height: 10 }} className="spin" /> : null}
                          {isInstalled ? '卸载' : '安装'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 学习新技能模态框 */}
      {showGenModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, animation: 'fade-in 0.2s ease-out',
        }} onClick={() => !generating && setShowGenModal(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '90%', maxWidth: 520,
            background: 'rgba(15, 22, 38, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(6,182,212,.2)',
            borderRadius: 16, padding: 24,
            boxShadow: '0 20px 60px rgba(0,0,0,.5), 0 0 40px rgba(6,182,212,.1)',
            animation: 'slide-up 0.3s ease-out',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, rgba(6,182,212,.2), rgba(139,92,246,.2))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles style={{ width: 18, height: 18, color: '#06b6d4' }} />
                </div>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>学习新技能</h3>
                  <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>描述你需要的技能，AI 将自动生成</p>
                </div>
              </div>
              <button onClick={() => !generating && setShowGenModal(false)} style={{
                width: 28, height: 28, borderRadius: 8, border: 'none',
                background: 'rgba(255,255,255,.05)', cursor: generating ? 'not-allowed' : 'pointer',
                color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>

            {/* 快捷模板 */}
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 11, color: '#475569', marginBottom: 8 }}>快捷模板：</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[
                  '网页数据抓取技能',
                  '邮件自动回复技能',
                  '代码审查技能',
                  '文档摘要生成技能',
                  '数据分析报表技能',
                ].map(tpl => (
                  <button key={tpl} onClick={() => setGenDesc(tpl)} disabled={generating} style={{
                    padding: '5px 12px', borderRadius: 8, fontSize: 11,
                    background: 'rgba(6,182,212,.08)', border: '1px solid rgba(6,182,212,.15)',
                    color: '#06b6d4', cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'all .15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.15)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; }}
                  >{tpl}</button>
                ))}
              </div>
            </div>

            {/* 输入框 */}
            <textarea
              value={genDesc}
              onChange={(e) => setGenDesc(e.target.value)}
              disabled={generating}
              placeholder="例如：帮我生成一个能够自动抓取网页表格数据并保存为 Excel 的技能..."
              style={{
                width: '100%', minHeight: 100, padding: 12, borderRadius: 10,
                background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                color: '#e2e8f0', fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                outline: 'none', transition: 'border-color .15s',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(6,182,212,.3)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
            />

            {/* 结果提示 */}
            {genResult && (
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 10, fontSize: 12,
                background: genResult.type === 'success' ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
                border: `1px solid ${genResult.type === 'success' ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`,
                color: genResult.type === 'success' ? '#10b981' : '#ef4444',
              }}>
                {genResult.text}
              </div>
            )}

            {/* 按钮 */}
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowGenModal(false)} disabled={generating} style={{
                padding: '9px 18px', borderRadius: 10, fontSize: 12, fontFamily: 'inherit',
                background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                color: '#94a3b8', cursor: 'pointer', transition: 'all .15s',
              }}>取消</button>
              <button onClick={handleGenerateSkill} disabled={generating || !genDesc.trim()} style={{
                padding: '9px 20px', borderRadius: 10, fontSize: 12, fontFamily: 'inherit',
                background: generating ? 'rgba(6,182,212,.3)' : 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                border: 'none', color: '#fff', cursor: generating ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                boxShadow: '0 4px 12px rgba(6,182,212,.2)',
                transition: 'all .15s',
              }}>
                {generating ? (
                  <><Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} /> AI 生成中...</>
                ) : (
                  <><Send style={{ width: 12, height: 12 }} /> 开始学习</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 打包技能模态框：从成功案例创建真实 SKILL.md */}
      {showPkgModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, animation: 'fade-in 0.2s ease-out',
        }} onClick={() => !packaging && setShowPkgModal(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '90%', maxWidth: 580,
            background: 'rgba(15, 22, 38, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(16,185,129,.25)',
            borderRadius: 16, padding: 24,
            boxShadow: '0 20px 60px rgba(0,0,0,.5), 0 0 40px rgba(16,185,129,.1)',
            animation: 'slide-up 0.3s ease-out',
            maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, rgba(16,185,129,.2), rgba(6,182,212,.2))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Layers style={{ width: 18, height: 18, color: '#10b981' }} />
                </div>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>打包技能</h3>
                  <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>从成功案例创建完整的 SKILL.md 定义文件（含步骤、工具、关键词）</p>
                </div>
              </div>
              <button onClick={() => !packaging && setShowPkgModal(false)} style={{
                width: 28, height: 28, borderRadius: 8, border: 'none',
                background: 'rgba(255,255,255,.05)', cursor: packaging ? 'not-allowed' : 'pointer',
                color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>

            {/* 提示信息 */}
            <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(16,185,129,.06)', border: '1px solid rgba(16,185,129,.15)', fontSize: 11, color: '#10b981', lineHeight: 1.6 }}>
              <strong>真实技能 vs 假技能：</strong>仅调用工具不等于技能。打包技能会生成完整的 SKILL.md 文件（YAML frontmatter + 执行步骤 + 工具清单 + 成功案例），可被 Agent 复用。
            </div>

            {/* 表单字段 */}
            <div style={{ display: 'grid', gap: 12 }}>
              {/* 技能名称 */}
              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, display: 'block' }}>技能名称 *</label>
                <input
                  type="text"
                  value={pkgForm.name}
                  onChange={(e) => setPkgForm({ ...pkgForm, name: e.target.value })}
                  disabled={packaging}
                  placeholder="例如：web-scraper-excel"
                  style={{
                    width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 8,
                    background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                    color: '#e2e8f0', fontFamily: 'inherit', outline: 'none',
                    boxSizing: 'border-box', transition: 'border-color .15s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                />
                <p style={{ fontSize: 10, color: '#475569', margin: '4px 0 0' }}>仅允许小写字母、数字、下划线、连字符</p>
              </div>

              {/* 技能描述 */}
              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, display: 'block' }}>技能描述 *</label>
                <textarea
                  value={pkgForm.description}
                  onChange={(e) => setPkgForm({ ...pkgForm, description: e.target.value })}
                  disabled={packaging}
                  placeholder="详细描述这个技能能做什么、解决什么问题..."
                  style={{
                    width: '100%', minHeight: 70, padding: 10, fontSize: 13, borderRadius: 8,
                    background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                    color: '#e2e8f0', fontFamily: 'inherit', outline: 'none', resize: 'vertical',
                    boxSizing: 'border-box', transition: 'border-color .15s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                />
              </div>

              {/* 意图 */}
              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, display: 'block' }}>触发意图</label>
                <input
                  type="text"
                  value={pkgForm.intent}
                  onChange={(e) => setPkgForm({ ...pkgForm, intent: e.target.value })}
                  disabled={packaging}
                  placeholder="例如：用户想要抓取网页表格数据并保存为 Excel"
                  style={{
                    width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 8,
                    background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                    color: '#e2e8f0', fontFamily: 'inherit', outline: 'none',
                    boxSizing: 'border-box', transition: 'border-color .15s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                />
              </div>

              {/* 使用的工具 */}
              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, display: 'block' }}>使用的工具（换行/逗号分隔）</label>
                <textarea
                  value={pkgForm.tools}
                  onChange={(e) => setPkgForm({ ...pkgForm, tools: e.target.value })}
                  disabled={packaging}
                  placeholder={"例如：\nweb_fetch\nfile_write\nexcel_export"}
                  style={{
                    width: '100%', minHeight: 60, padding: 10, fontSize: 13, borderRadius: 8,
                    background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                    color: '#e2e8f0', fontFamily: 'inherit', outline: 'none', resize: 'vertical',
                    boxSizing: 'border-box', transition: 'border-color .15s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                />
              </div>

              {/* 执行步骤 */}
              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, display: 'block' }}>执行步骤（换行/逗号分隔）</label>
                <textarea
                  value={pkgForm.steps}
                  onChange={(e) => setPkgForm({ ...pkgForm, steps: e.target.value })}
                  disabled={packaging}
                  placeholder={"例如：\n1. 获取目标网页 URL\n2. 抓取页面 HTML\n3. 解析表格数据\n4. 写入 Excel 文件"}
                  style={{
                    width: '100%', minHeight: 80, padding: 10, fontSize: 13, borderRadius: 8,
                    background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                    color: '#e2e8f0', fontFamily: 'inherit', outline: 'none', resize: 'vertical',
                    boxSizing: 'border-box', transition: 'border-color .15s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                />
              </div>

              {/* 关键词 */}
              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, display: 'block' }}>关键词（换行/逗号分隔）</label>
                <input
                  type="text"
                  value={pkgForm.keywords}
                  onChange={(e) => setPkgForm({ ...pkgForm, keywords: e.target.value })}
                  disabled={packaging}
                  placeholder="例如：抓取, 网页, 表格, Excel, 导出"
                  style={{
                    width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 8,
                    background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
                    color: '#e2e8f0', fontFamily: 'inherit', outline: 'none',
                    boxSizing: 'border-box', transition: 'border-color .15s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                />
              </div>
            </div>

            {/* 结果提示 */}
            {pkgResult && (
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 10, fontSize: 12,
                background: pkgResult.type === 'success' ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
                border: `1px solid ${pkgResult.type === 'success' ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`,
                color: pkgResult.type === 'success' ? '#10b981' : '#ef4444',
              }}>
                {pkgResult.text}
              </div>
            )}

            {/* 按钮 */}
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowPkgModal(false)} disabled={packaging} style={{
                padding: '9px 18px', borderRadius: 10, fontSize: 12, fontFamily: 'inherit',
                background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                color: '#94a3b8', cursor: 'pointer', transition: 'all .15s',
              }}>取消</button>
              <button onClick={handlePackageSkill} disabled={packaging || !pkgForm.name.trim() || !pkgForm.description.trim()} style={{
                padding: '9px 20px', borderRadius: 10, fontSize: 12, fontFamily: 'inherit',
                background: packaging ? 'rgba(16,185,129,.3)' : 'linear-gradient(135deg, #10b981, #06b6d4)',
                border: 'none', color: '#fff', cursor: packaging ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                boxShadow: '0 4px 12px rgba(16,185,129,.2)',
                transition: 'all .15s',
              }}>
                {packaging ? (
                  <><Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} /> 打包中...</>
                ) : (
                  <><Layers style={{ width: 12, height: 12 }} /> 打包为真实技能</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

