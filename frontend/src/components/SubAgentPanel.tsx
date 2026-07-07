/**
 * SubAgentPanel — 多 Agent 编排可视化面板
 *
 * 三 Tab 布局：
 *   1. 活跃 Agent — 实时显示运行中的 SubAgent 卡片（状态/turns/tokens + 可展开日志）
 *   2. 团队执行 — 选择团队模板 → DAG 可视化 → 启动按钮 → 实时执行进度
 *   3. 共享板 — 跨 Agent 共享上下文条目流（pub/sub board）
 *
 * 依赖：
 *   - useSubAgentStream hook（实时事件流 + 状态管理）
 *   - SubAgentDAG 组件（SVG DAG 可视化）
 *
 * 设计：glass-effect 卡片 + lucide-react 图标 + 现有设计 token
 */
import { useState, useMemo } from 'react';
import {
  ArrowLeft, Users, Activity, Share2, Play, Loader2, CircleDot,
  CheckCircle2, AlertCircle, Clock, RefreshCw, ChevronDown, ChevronRight, Zap,
} from 'lucide-react';
import { useSubAgentStream, type ActiveAgent, type SubAgentStatus, type SubAgentEvent } from '../hooks/useSubAgentStream';
import { SubAgentDAG, buildDAGFromMembers, type DAGNode, type DAGEdge } from './SubAgentDAG';

interface SubAgentPanelProps {
  onBack?: () => void;
}

type Tab = 'agents' | 'team' | 'board';

// 团队模板（与后端 subagent-routes.ts 保持一致）
interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  members?: Array<{ role: string; name: string }>;
}

// 内置模板定义（与后端 routes 的 templates 列表对齐，附带 DAG 节点信息）
const BUILTIN_TEMPLATES: TeamTemplate[] = [
  {
    id: 'code-dev',
    name: '代码开发团队',
    description: '完整的代码开发流程：规划 → 实现 → 审查 → 测试',
    members: [
      { role: 'planner', name: 'planner-01' },
      { role: 'implementer', name: 'implementer-01' },
      { role: 'reviewer', name: 'reviewer-01' },
      { role: 'tester', name: 'tester-01' },
    ],
  },
  {
    id: 'research',
    name: '调研分析团队',
    description: '多角度调研分析：资料收集 → 分析 → 总结',
    members: [
      { role: 'researcher', name: 'researcher-01' },
      { role: 'researcher', name: 'researcher-02' },
      { role: 'writer', name: 'writer-01' },
    ],
  },
];

const STATUS_META: Record<SubAgentStatus, { label: string; color: string; icon: typeof CircleDot }> = {
  idle: { label: '空闲', color: '#64748b', icon: CircleDot },
  running: { label: '运行中', color: '#06b6d4', icon: Activity },
  waiting_human: { label: '等待人工', color: '#f59e0b', icon: Clock },
  completed: { label: '已完成', color: '#10b981', icon: CheckCircle2 },
  error: { label: '出错', color: '#ef4444', icon: AlertCircle },
};

// ============ 主组件 ============
export function SubAgentPanel({ onBack }: SubAgentPanelProps) {
  const [tab, setTab] = useState<Tab>('agents');
  const { events, activeAgents, boardEntries, connected, clearCompleted, startTeam } = useSubAgentStream();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#0a0e1a', color: '#e2e8f0' }}>
      {/* 顶部栏 */}
      <header style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, background: 'rgba(6,9,18,.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
        {onBack && (
          <button
            onClick={onBack}
            title="返回"
            style={{
              padding: 6, borderRadius: 8, background: 'transparent', border: 'none',
              color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center',
              transition: 'all .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.background = 'rgba(255,255,255,.04)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.background = 'transparent'; }}
          >
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
        )}
        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #06b6d4, #8b5cf6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 12px rgba(6,182,212,.25)' }}>
          <Users style={{ width: 16, height: 16 }} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 17, fontWeight: 600, margin: 0, color: '#e2e8f0' }}>多 Agent 编排</h1>
          <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>SubAgent 实时编排 · 团队 DAG 可视化 · 共享上下文</p>
        </div>
        {/* 连接状态指示 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 12, background: connected ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)', border: `1px solid ${connected ? 'rgba(16,185,129,.15)' : 'rgba(239,68,68,.15)'}` }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#10b981' : '#ef4444', boxShadow: connected ? '0 0 6px rgba(16,185,129,.6)' : '0 0 6px rgba(239,68,68,.6)', animation: 'status-pulse 2s infinite' }} />
          <span style={{ fontSize: 11, color: connected ? '#10b981' : '#ef4444' }}>{connected ? '已连接' : '未连接'}</span>
        </div>
      </header>

      {/* Tab 栏 */}
      <div style={{ display: 'flex', gap: 4, padding: '10px 20px 0', borderBottom: '1px solid rgba(255,255,255,.04)', flexShrink: 0 }}>
        <TabButton active={tab === 'agents'} onClick={() => setTab('agents')} icon={Activity} label="活跃 Agent" count={activeAgents.size} />
        <TabButton active={tab === 'team'} onClick={() => setTab('team')} icon={Users} label="团队执行" />
        <TabButton active={tab === 'board'} onClick={() => setTab('board')} icon={Share2} label="共享板" count={boardEntries.length} />
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px 24px' }}>
        {tab === 'agents' && <AgentsTab activeAgents={activeAgents} events={events} onClearCompleted={clearCompleted} />}
        {tab === 'team' && <TeamTab startTeam={startTeam} activeAgents={activeAgents} />}
        {tab === 'board' && <BoardTab entries={boardEntries} />}
      </div>
    </div>
  );
}

// ============ Tab 按钮 ============
function TabButton({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: typeof Activity; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
        background: active ? 'rgba(6,182,212,.08)' : 'transparent',
        border: 'none', borderBottom: active ? '2px solid #06b6d4' : '2px solid transparent',
        color: active ? '#06b6d4' : '#64748b', fontSize: 13, fontWeight: active ? 500 : 400,
        display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
        transition: 'all .15s', marginBottom: -1,
      }}
    >
      <Icon style={{ width: 14, height: 14 }} />
      {label}
      {count !== undefined && count > 0 && (
        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(6,182,212,.15)', color: '#06b6d4', border: '1px solid rgba(6,182,212,.2)' }}>{count}</span>
      )}
    </button>
  );
}

// ============ Tab 1: 活跃 Agent ============
function AgentsTab({ activeAgents, events, onClearCompleted }: { activeAgents: Map<string, ActiveAgent>; events: SubAgentEvent[]; onClearCompleted: () => void }) {
  const agents = Array.from(activeAgents.values()).sort((a, b) => b.lastUpdate - a.lastUpdate);

  if (agents.length === 0) {
    return (
      <div className="glass-effect" style={{ borderRadius: 16, padding: 40, textAlign: 'center' }}>
        <Activity style={{ width: 32, height: 32, color: '#475569', margin: '0 auto 12px' }} />
        <p style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 4px' }}>暂无活跃 Agent</p>
        <p style={{ fontSize: 11, color: '#475569', margin: 0 }}>通过 Agent 工具 spawn_agent / spawn_and_wait 创建子 Agent，或前往「团队执行」启动团队</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>{agents.length} 个 Agent · 按最近更新排序</p>
        <button
          onClick={onClearCompleted}
          style={{ padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', color: '#94a3b8', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit', transition: 'all .15s' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.color = '#94a3b8'; }}
        >
          <RefreshCw style={{ width: 11, height: 11 }} /> 清除已完成
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {agents.map(agent => <AgentCard key={agent.taskId} agent={agent} />)}
      </div>

      {/* 最近事件流 */}
      {events.length > 0 && (
        <div className="glass-effect" style={{ borderRadius: 12, padding: 14, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Zap style={{ width: 12, height: 12, color: '#06b6d4' }} />
            <span style={{ fontSize: 12, fontWeight: 500, color: '#94a3b8' }}>最近事件流（最近 {events.length} 条）</span>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 10, color: '#64748b', lineHeight: 1.6 }}>
            {events.slice().reverse().map((ev, i) => (
              <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>
                <span style={{ color: '#475569' }}>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                {' '}
                <span style={{ color: '#06b6d4' }}>{ev.type}</span>
                {ev.agentName && <span style={{ color: '#94a3b8' }}> · {ev.agentName}</span>}
                {ev.turn !== undefined && <span> · turn={ev.turn}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ Agent 卡片 ============
function AgentCard({ agent }: { agent: ActiveAgent }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[agent.status] || STATUS_META.idle;
  const Icon = meta.icon;
  const duration = Math.max(0, Math.floor((Date.now() - agent.lastUpdate) / 1000));

  return (
    <div className="glass-effect" style={{ borderRadius: 12, padding: 14, border: `1px solid ${meta.color}22` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: `${meta.color}1a`, color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: agent.status === 'running' ? `0 0 12px ${meta.color}40` : 'none' }}>
          <Icon style={{ width: 16, height: 16 }} className={agent.status === 'running' ? 'spin' : ''} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.agentName}</span>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, background: `${meta.color}15`, color: meta.color, border: `1px solid ${meta.color}25` }}>{meta.label}</span>
          </div>
          <div style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {agent.taskId}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          {agent.turn !== undefined && <span style={{ fontSize: 10, color: '#64748b' }}>turn <span style={{ color: '#94a3b8', fontWeight: 500 }}>{agent.turn}</span></span>}
          {agent.tokenUsage !== undefined && agent.tokenUsage > 0 && (
            <span style={{ fontSize: 10, color: '#64748b' }}>tokens <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{agent.tokenUsage.toLocaleString()}</span></span>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ padding: 4, borderRadius: 6, background: 'transparent', border: 'none', color: '#475569', cursor: 'pointer', display: 'flex' }}
        >
          {expanded ? <ChevronDown style={{ width: 14, height: 14 }} /> : <ChevronRight style={{ width: 14, height: 14 }} />}
        </button>
      </div>

      <div style={{ fontSize: 10, color: '#475569', marginTop: 8 }}>最近更新 {duration}s 前</div>

      {expanded && agent.logs.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.04)' }}>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {agent.logs.map((log, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 11, fontFamily: 'monospace' }}>
                <span style={{ color: '#475569', flexShrink: 0 }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span style={{ color: log.type === 'completed' ? '#10b981' : log.type === 'dispatch' ? '#06b6d4' : '#94a3b8', flexShrink: 0, minWidth: 70 }}>
                  [{log.type}]
                </span>
                <span style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis' }}>{log.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ Tab 2: 团队执行 ============
function TeamTab({ startTeam, activeAgents }: { startTeam: (templateName: string, taskGoal: string, extraContext?: string) => Promise<{ success?: boolean; error?: string; message?: string }>; activeAgents: Map<string, ActiveAgent> }) {
  const [selectedTemplate, setSelectedTemplate] = useState<string>('code-dev');
  const [taskGoal, setTaskGoal] = useState('');
  const [extraContext, setExtraContext] = useState('');
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const template = BUILTIN_TEMPLATES.find(t => t.id === selectedTemplate) || BUILTIN_TEMPLATES[0];

  // 构建 DAG 节点和边
  const { nodes, edges } = useMemo(() => {
    if (!template?.members) return { nodes: [] as DAGNode[], edges: [] as DAGEdge[] };
    // 将 activeAgents 状态映射到 DAG 节点（基于 agentName）
    const statusMap = new Map<string, SubAgentStatus>();
    for (const member of template.members) {
      for (const agent of activeAgents.values()) {
        if (agent.agentName === member.name) {
          statusMap.set(`${member.role}_${template.members!.indexOf(member)}`, agent.status);
        }
      }
    }
    return buildDAGFromMembers(template.members, statusMap);
  }, [template, activeAgents]);

  const handleLaunch = async () => {
    if (!taskGoal.trim()) {
      setMessage({ type: 'error', text: '请输入任务目标' });
      return;
    }
    setLaunching(true);
    setMessage(null);
    try {
      const result = await startTeam(template.name, taskGoal.trim(), extraContext.trim() || undefined);
      if (result?.success) {
        setMessage({ type: 'success', text: `团队「${template.name}」已启动，请前往「活跃 Agent」查看进度` });
        setTaskGoal('');
        setExtraContext('');
      } else {
        setMessage({ type: 'error', text: result?.error || '启动失败' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage({ type: 'error', text: msg || '启动失败' });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 模板选择 */}
      <div className="glass-effect" style={{ borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <Users style={{ width: 14, height: 14, color: '#06b6d4' }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>选择团队模板</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {BUILTIN_TEMPLATES.map(t => {
            const selected = t.id === selectedTemplate;
            return (
              <button
                key={t.id}
                onClick={() => setSelectedTemplate(t.id)}
                style={{
                  padding: 12, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                  background: selected ? 'rgba(6,182,212,.06)' : 'rgba(255,255,255,.02)',
                  border: selected ? '1px solid rgba(6,182,212,.3)' : '1px solid rgba(255,255,255,.06)',
                  color: '#e2e8f0', fontFamily: 'inherit', transition: 'all .15s',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>{t.description}</div>
                {t.members && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {t.members.map((m, i) => (
                      <span key={i} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(139,92,246,.1)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.15)' }}>{m.role}</span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* DAG 可视化 */}
      {template?.members && (
        <div className="glass-effect" style={{ borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Share2 style={{ width: 14, height: 14, color: '#8b5cf6' }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>执行 DAG</span>
            <span style={{ fontSize: 10, color: '#475569', marginLeft: 6 }}>{template.members.length} 个成员</span>
          </div>
          <div style={{ background: 'rgba(0,0,0,.2)', borderRadius: 8, padding: 8 }}>
            <SubAgentDAG nodes={nodes} edges={edges} width={560} height={260} />
          </div>
          {/* 图例 */}
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: '#64748b' }}>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: v.color }} />
                {v.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 任务输入 */}
      <div className="glass-effect" style={{ borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Zap style={{ width: 14, height: 14, color: '#f59e0b' }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>任务目标</span>
        </div>
        <textarea
          value={taskGoal}
          onChange={(e) => setTaskGoal(e.target.value)}
          placeholder="例如：为 src/server/routes/mcp-marketplace-routes.ts 补充完整的 vitest 测试，覆盖 install/uninstall/enable 三个端点..."
          rows={3}
          style={{
            width: '100%', padding: 10, borderRadius: 8, fontSize: 12, fontFamily: 'inherit',
            background: 'rgba(0,0,0,.2)', border: '1px solid rgba(255,255,255,.08)',
            color: '#e2e8f0', outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            transition: 'border-color .15s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(6,182,212,.3)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
        />
        <div style={{ marginTop: 8 }}>
          <textarea
            value={extraContext}
            onChange={(e) => setExtraContext(e.target.value)}
            placeholder="额外上下文（可选）：相关文件路径、约束、参考资料..."
            rows={2}
            style={{
              width: '100%', padding: 10, borderRadius: 8, fontSize: 11, fontFamily: 'inherit',
              background: 'rgba(0,0,0,.15)', border: '1px solid rgba(255,255,255,.06)',
              color: '#94a3b8', outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* 启动按钮 */}
      <button
        onClick={handleLaunch}
        disabled={launching || !taskGoal.trim()}
        style={{
          padding: '12px 20px', borderRadius: 10, cursor: launching || !taskGoal.trim() ? 'not-allowed' : 'pointer',
          background: launching || !taskGoal.trim() ? 'rgba(100,116,139,.2)' : 'linear-gradient(135deg, #06b6d4, #8b5cf6)',
          border: 'none', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          boxShadow: launching || !taskGoal.trim() ? 'none' : '0 4px 20px rgba(6,182,212,.25)',
          transition: 'all .2s', opacity: launching || !taskGoal.trim() ? 0.6 : 1,
        }}
      >
        {launching ? <Loader2 style={{ width: 16, height: 16 }} className="spin" /> : <Play style={{ width: 16, height: 16 }} />}
        {launching ? '启动中...' : `启动「${template?.name || '团队'}」`}
      </button>

      {/* 消息提示 */}
      {message && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, fontSize: 12,
          background: message.type === 'success' ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)',
          border: `1px solid ${message.type === 'success' ? 'rgba(16,185,129,.2)' : 'rgba(239,68,68,.2)'}`,
          color: message.type === 'success' ? '#10b981' : '#ef4444',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {message.type === 'success' ? <CheckCircle2 style={{ width: 14, height: 14, flexShrink: 0 }} /> : <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />}
          {message.text}
        </div>
      )}
    </div>
  );
}

// ============ Tab 3: 共享板 ============
function BoardTab({ entries }: { entries: Array<{ agentName: string; role: string; type: string; content: string; timestamp: number }> }) {
  if (entries.length === 0) {
    return (
      <div className="glass-effect" style={{ borderRadius: 16, padding: 40, textAlign: 'center' }}>
        <Share2 style={{ width: 32, height: 32, color: '#475569', margin: '0 auto 12px' }} />
        <p style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 4px' }}>共享板为空</p>
        <p style={{ fontSize: 11, color: '#475569', margin: 0 }}>Agent 执行过程中产生的共享上下文条目会在此实时展示</p>
      </div>
    );
  }

  const TYPE_COLORS: Record<string, string> = {
    note: '#06b6d4',
    result: '#10b981',
    question: '#f59e0b',
    decision: '#8b5cf6',
    artifact: '#ec4899',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px' }}>{entries.length} 条共享上下文</p>
      {entries.slice().reverse().map((entry, i) => {
        const color = TYPE_COLORS[entry.type] || '#64748b';
        return (
          <div key={i} className="glass-effect" style={{ borderRadius: 10, padding: 12, borderLeft: `3px solid ${color}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{entry.agentName}</span>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: `${color}15`, color, border: `1px solid ${color}25` }}>{entry.type}</span>
              <span style={{ fontSize: 9, color: '#475569' }}>{entry.role}</span>
              <span style={{ fontSize: 9, color: '#475569', marginLeft: 'auto' }}>{new Date(entry.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {entry.content.length > 500 ? entry.content.substring(0, 500) + '...' : entry.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}
