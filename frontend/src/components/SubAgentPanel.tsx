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
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ArrowLeft, Users, Activity, Share2, Play, Loader2, CircleDot,
  CheckCircle2, AlertCircle, Clock, RefreshCw, ChevronDown, ChevronRight, Zap,
  Plus, History, Trash2, UserPlus, Save, XCircle,
} from 'lucide-react';
import { useSubAgentStream, type ActiveAgent, type SubAgentStatus, type SubAgentEvent } from '../hooks/useSubAgentStream';
import { SubAgentDAG, buildDAGFromMembers, type DAGNode, type DAGEdge } from './SubAgentDAG';

interface SubAgentPanelProps {
  onBack?: () => void;
}

type Tab = 'agents' | 'team' | 'board' | 'custom' | 'history';

// 团队模板（与后端 subagent-routes.ts GET /team-templates 返回结构一致）
interface TeamMember {
  role: string;
  name: string;
  goal?: string;
  priority?: number;
  tokenBudget?: number;
  allowedTools?: string[];
}

interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  members?: TeamMember[];
  custom?: boolean;
  maxConcurrent?: number;
  useWorktreeIsolation?: boolean;
}

/** 执行详情中的成员状态 */
interface ExecutionMember {
  name?: string;
  role?: string;
  status?: string;
  tokenUsage?: number;
}

/** 执行详情（getExecution 返回） */
interface ExecutionDetail {
  id?: string;
  teamName?: string;
  members?: ExecutionMember[];
  success?: boolean;
  duration?: number;
  [key: string]: unknown;
}

// 内置模板 fallback（后端不可用时使用；后端有 3 个：code-dev/research/bug-fix）
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
  {
    id: 'bug-fix',
    name: 'Bug 修复团队',
    description: '系统化 Bug 修复：复现 → 定位 → 修复 → 验证',
    members: [
      { role: 'analyst', name: 'analyst-01' },
      { role: 'implementer', name: 'implementer-01' },
      { role: 'tester', name: 'tester-01' },
    ],
  },
];

// 自定义团队成员角色选项
const TEAM_ROLES = ['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'writer', 'analyst', 'coordinator'];

// 自定义团队可选工具列表
const AVAILABLE_TOOLS = ['file_read', 'file_write', 'shell_execute', 'search_files', 'list_directory', 'web_search', 'web_fetch'];

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
  const {
    events, activeAgents, boardEntries, connected, clearCompleted, startTeam,
    listTemplates, startCustomTeam, listHistory, getExecution,
    listCustomTemplates, saveCustomTemplate, deleteCustomTemplate,
  } = useSubAgentStream();

  // 动态拉取团队模板（后端不可用时回退 BUILTIN_TEMPLATES）
  const [templates, setTemplates] = useState<TeamTemplate[]>(BUILTIN_TEMPLATES);
  useEffect(() => {
    let cancelled = false;
    listTemplates().then((t: TeamTemplate[]) => {
      if (cancelled) return;
      if (Array.isArray(t) && t.length > 0) {
        setTemplates(t.map((item: TeamTemplate) => ({
          id: item.id || item.name,
          name: item.name || item.id,
          description: item.description || '',
          members: Array.isArray(item.members) ? item.members : undefined,
          custom: item.custom,
          maxConcurrent: item.maxConcurrent,
          useWorktreeIsolation: item.useWorktreeIsolation,
        })));
      }
    }).catch(() => { /* 回退到 BUILTIN_TEMPLATES */ });
    return () => { cancelled = true; };
  }, [listTemplates]);

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
        <TabButton active={tab === 'custom'} onClick={() => setTab('custom')} icon={Plus} label="自定义团队" />
        <TabButton active={tab === 'history'} onClick={() => setTab('history')} icon={History} label="执行历史" />
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px 24px' }}>
        {tab === 'agents' && <AgentsTab activeAgents={activeAgents} events={events} onClearCompleted={clearCompleted} />}
        {tab === 'team' && <TeamTab templates={templates} startTeam={startTeam} activeAgents={activeAgents} />}
        {tab === 'board' && <BoardTab entries={boardEntries} />}
        {tab === 'custom' && (
          <CustomTeamTab
            startCustomTeam={startCustomTeam}
            listCustomTemplates={listCustomTemplates as () => Promise<TeamTemplate[]>}
            saveCustomTemplate={saveCustomTemplate as (template: unknown) => Promise<{ success?: boolean; template?: TeamTemplate; message?: string; error?: string } | null>}
            deleteCustomTemplate={deleteCustomTemplate}
          />
        )}
        {tab === 'history' && (
          <ExecutionHistoryTab listHistory={listHistory} getExecution={getExecution as (id: string) => Promise<ExecutionDetail | null>} />
        )}
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
function TeamTab({ templates, startTeam, activeAgents }: { templates: TeamTemplate[]; startTeam: (templateName: string, taskGoal: string, extraContext?: string) => Promise<{ success?: boolean; error?: string; message?: string }>; activeAgents: Map<string, ActiveAgent> }) {
  const [selectedTemplate, setSelectedTemplate] = useState<string>('code-dev');
  const [taskGoal, setTaskGoal] = useState('');
  const [extraContext, setExtraContext] = useState('');
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const template = templates.find(t => t.id === selectedTemplate) || templates[0];

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
          {templates.map(t => {
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

// ============ Tab 4: 自定义团队 ============
interface CustomTeamTabProps {
  startCustomTeam: (config: unknown) => Promise<{ success?: boolean; message?: string; error?: string } | null>;
  listCustomTemplates: () => Promise<TeamTemplate[]>;
  saveCustomTemplate: (template: unknown) => Promise<{ success?: boolean; template?: TeamTemplate; message?: string; error?: string } | null>;
  deleteCustomTemplate: (id: string) => Promise<{ success?: boolean; message?: string } | null>;
}

function CustomTeamTab({ startCustomTeam, listCustomTemplates, saveCustomTemplate, deleteCustomTemplate }: CustomTeamTabProps) {
  const [teamName, setTeamName] = useState('');
  const [teamDesc, setTeamDesc] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [members, setMembers] = useState<TeamMember[]>([
    { role: 'planner', name: 'planner-01', goal: '', priority: 5, tokenBudget: 8000, allowedTools: ['file_read', 'search_files'] },
  ]);
  const [savedTemplates, setSavedTemplates] = useState<TeamTemplate[]>([]);
  const [launching, setLaunching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 加载已保存的自定义模板
  useEffect(() => {
    listCustomTemplates().then(t => { if (Array.isArray(t)) setSavedTemplates(t); }).catch(() => {});
  }, [listCustomTemplates]);

  const addMember = useCallback(() => {
    setMembers(prev => [...prev, { role: 'implementer', name: `member-${String(prev.length + 1).padStart(2, '0')}`, goal: '', priority: 5, tokenBudget: 8000, allowedTools: [] }]);
  }, []);

  const removeMember = useCallback((idx: number) => {
    setMembers(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const updateMember = useCallback((idx: number, field: keyof TeamMember, value: unknown) => {
    setMembers(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  }, []);

  const toggleTool = useCallback((idx: number, tool: string) => {
    setMembers(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const tools = m.allowedTools || [];
      return { ...m, allowedTools: tools.includes(tool) ? tools.filter(t => t !== tool) : [...tools, tool] };
    }));
  }, []);

  const buildConfig = useCallback(() => ({
    name: teamName.trim() || `custom-team-${Date.now().toString(36)}`,
    description: teamDesc.trim(),
    members: members.map(m => ({
      role: m.role,
      name: m.name,
      goal: m.goal || undefined,
      priority: m.priority,
      tokenBudget: m.tokenBudget,
      allowedTools: m.allowedTools && m.allowedTools.length > 0 ? m.allowedTools : undefined,
    })),
    maxConcurrent,
  }), [teamName, teamDesc, members, maxConcurrent]);

  const handleLaunch = async () => {
    if (members.length === 0) {
      setMessage({ type: 'error', text: '至少需要 1 个成员' });
      return;
    }
    setLaunching(true);
    setMessage(null);
    try {
      const result = await startCustomTeam(buildConfig());
      if (result?.success) {
        setMessage({ type: 'success', text: `自定义团队「${buildConfig().name}」已启动，请前往「活跃 Agent」查看进度` });
      } else {
        setMessage({ type: 'error', text: result?.error || '启动失败' });
      }
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLaunching(false);
    }
  };

  const handleSave = async () => {
    if (members.length === 0) {
      setMessage({ type: 'error', text: '至少需要 1 个成员才能保存' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveCustomTemplate(buildConfig());
      if (result?.success) {
        setMessage({ type: 'success', text: result.message || '模板已保存' });
        // 刷新列表
        const t = await listCustomTemplates();
        if (Array.isArray(t)) setSavedTemplates(t);
      } else {
        setMessage({ type: 'error', text: result?.error || '保存失败' });
      }
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const result = await deleteCustomTemplate(id);
    if (result?.success) {
      setSavedTemplates(prev => prev.filter(t => t.id !== id));
    }
  };

  const handleLoad = (tpl: TeamTemplate) => {
    setTeamName(tpl.name || '');
    setTeamDesc(tpl.description || '');
    setMaxConcurrent(tpl.maxConcurrent || 3);
    if (Array.isArray(tpl.members)) {
      setMembers(tpl.members.map((m: TeamMember) => ({
        role: m.role || 'implementer',
        name: m.name || 'member-01',
        goal: m.goal || '',
        priority: m.priority ?? 5,
        tokenBudget: m.tokenBudget ?? 8000,
        allowedTools: Array.isArray(m.allowedTools) ? m.allowedTools : [],
      })));
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: '6px 8px', borderRadius: 6, fontSize: 11, fontFamily: 'inherit',
    background: 'rgba(0,0,0,.2)', border: '1px solid rgba(255,255,255,.08)',
    color: '#e2e8f0', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 团队基本信息 */}
      <div className="glass-effect" style={{ borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <Plus style={{ width: 14, height: 14, color: '#06b6d4' }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>团队信息</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 4 }}>团队名称</label>
            <input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="例如：文档生成团队" style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 4 }}>最大并发数</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={1} max={10} value={maxConcurrent} onChange={e => setMaxConcurrent(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 20 }}>{maxConcurrent}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 4 }}>团队描述</label>
          <input value={teamDesc} onChange={e => setTeamDesc(e.target.value)} placeholder="团队职责描述..." style={{ ...inputStyle, width: '100%' }} />
        </div>
      </div>

      {/* 成员列表 */}
      <div className="glass-effect" style={{ borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Users style={{ width: 14, height: 14, color: '#8b5cf6' }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>成员（{members.length}）</span>
          </div>
          <button onClick={addMember} style={{ padding: '5px 10px', borderRadius: 6, background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.2)', color: '#06b6d4', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
            <UserPlus style={{ width: 12, height: 12 }} /> 添加成员
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {members.map((m, idx) => (
            <div key={idx} style={{ padding: 12, borderRadius: 8, background: 'rgba(0,0,0,.15)', border: '1px solid rgba(255,255,255,.04)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 2 }}>角色</label>
                  <select value={m.role} onChange={e => updateMember(idx, 'role', e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                    {TEAM_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 2 }}>名称</label>
                  <input value={m.name} onChange={e => updateMember(idx, 'name', e.target.value)} style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 2 }}>优先级 (1-10)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="range" min={1} max={10} value={m.priority ?? 5} onChange={e => updateMember(idx, 'priority', Number(e.target.value))} style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{m.priority ?? 5}</span>
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 2 }}>目标</label>
                  <input value={m.goal || ''} onChange={e => updateMember(idx, 'goal', e.target.value)} placeholder="成员目标..." style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 2 }}>Token 预算</label>
                  <input type="number" value={m.tokenBudget ?? 8000} onChange={e => updateMember(idx, 'tokenBudget', Number(e.target.value))} style={{ ...inputStyle, width: '100%' }} />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 9, color: '#475569', display: 'block', marginBottom: 4 }}>允许工具</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {AVAILABLE_TOOLS.map(tool => {
                    const active = (m.allowedTools || []).includes(tool);
                    return (
                      <button
                        key={tool}
                        onClick={() => toggleTool(idx, tool)}
                        style={{
                          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'monospace', cursor: 'pointer',
                          background: active ? 'rgba(6,182,212,.15)' : 'rgba(255,255,255,.02)',
                          border: active ? '1px solid rgba(6,182,212,.3)' : '1px solid rgba(255,255,255,.06)',
                          color: active ? '#06b6d4' : '#475569', transition: 'all .15s',
                        }}
                      >
                        {tool}
                      </button>
                    );
                  })}
                </div>
              </div>
              {members.length > 1 && (
                <button
                  onClick={() => removeMember(idx)}
                  style={{ marginTop: 8, padding: '3px 8px', borderRadius: 4, background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.1)', color: '#ef4444', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}
                >
                  <Trash2 style={{ width: 10, height: 10 }} /> 移除
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleLaunch}
          disabled={launching || members.length === 0}
          style={{
            flex: 1, padding: '12px 20px', borderRadius: 10, cursor: launching || members.length === 0 ? 'not-allowed' : 'pointer',
            background: launching || members.length === 0 ? 'rgba(100,116,139,.2)' : 'linear-gradient(135deg, #06b6d4, #8b5cf6)',
            border: 'none', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all .2s', opacity: launching ? 0.6 : 1,
          }}
        >
          {launching ? <Loader2 style={{ width: 16, height: 16 }} className="spin" /> : <Play style={{ width: 16, height: 16 }} />}
          {launching ? '启动中...' : '启动团队'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || members.length === 0}
          style={{
            padding: '12px 20px', borderRadius: 10, cursor: saving || members.length === 0 ? 'not-allowed' : 'pointer',
            background: saving || members.length === 0 ? 'rgba(100,116,139,.1)' : 'rgba(245,158,11,.1)',
            border: `1px solid ${saving || members.length === 0 ? 'rgba(100,116,139,.2)' : 'rgba(245,158,11,.25)'}`,
            color: saving || members.length === 0 ? '#64748b' : '#f59e0b', fontSize: 14, fontWeight: 500, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 8, transition: 'all .2s',
          }}
        >
          {saving ? <Loader2 style={{ width: 16, height: 16 }} className="spin" /> : <Save style={{ width: 16, height: 16 }} />}
          {saving ? '保存中...' : '保存为模板'}
        </button>
      </div>

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

      {/* 已保存的自定义模板 */}
      {savedTemplates.length > 0 && (
        <div className="glass-effect" style={{ borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Save style={{ width: 14, height: 14, color: '#f59e0b' }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>已保存模板（{savedTemplates.length}）</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {savedTemplates.map((tpl: TeamTemplate) => (
              <div key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.04)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0' }}>{tpl.name}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>{tpl.members?.length || 0} 成员 · {tpl.description || '无描述'}</div>
                </div>
                <button onClick={() => handleLoad(tpl)} style={{ padding: '3px 8px', borderRadius: 4, background: 'rgba(6,182,212,.08)', border: '1px solid rgba(6,182,212,.15)', color: '#06b6d4', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>加载</button>
                <button onClick={() => handleDelete(tpl.id)} style={{ padding: '3px', borderRadius: 4, background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.1)', color: '#ef4444', cursor: 'pointer', display: 'flex' }}>
                  <Trash2 style={{ width: 11, height: 11 }} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ Tab 5: 执行历史 ============
interface ExecutionHistoryTabProps {
  listHistory: () => Promise<Array<{ id: string; teamName: string; success: boolean; duration: number; memberCount: number }>>;
  getExecution: (id: string) => Promise<ExecutionDetail | null>;
}

function ExecutionHistoryTab({ listHistory, getExecution }: ExecutionHistoryTabProps) {
  const [history, setHistory] = useState<Array<{ id: string; teamName: string; success: boolean; duration: number; memberCount: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const h = await listHistory();
      setHistory(Array.isArray(h) ? h : []);
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [listHistory]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const d = await getExecution(id);
      setDetail(d);
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  if (loading) {
    return (
      <div className="glass-effect" style={{ borderRadius: 16, padding: 40, textAlign: 'center' }}>
        <Loader2 style={{ width: 28, height: 28, color: '#06b6d4', margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>加载执行历史...</p>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="glass-effect" style={{ borderRadius: 16, padding: 40, textAlign: 'center' }}>
        <History style={{ width: 32, height: 32, color: '#475569', margin: '0 auto 12px' }} />
        <p style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 4px' }}>暂无执行历史</p>
        <p style={{ fontSize: 11, color: '#475569', margin: 0 }}>启动团队后，执行记录将在此展示</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>{history.length} 条执行记录</p>
        <button onClick={fetchHistory} style={{ padding: '4px 8px', borderRadius: 6, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', color: '#94a3b8', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
          <RefreshCw style={{ width: 11, height: 11 }} /> 刷新
        </button>
      </div>
      {history.map((h) => {
        const expanded = expandedId === h.id;
        return (
          <div key={h.id} className="glass-effect" style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${expanded ? 'rgba(6,182,212,.2)' : 'rgba(255,255,255,.06)'}` }}>
            <div
              onClick={() => handleExpand(h.id)}
              style={{ padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
            >
              {h.success ? (
                <CheckCircle2 style={{ width: 16, height: 16, color: '#10b981', flexShrink: 0 }} />
              ) : (
                <XCircle style={{ width: 16, height: 16, color: '#ef4444', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>{h.teamName}</div>
                <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                  {h.memberCount} 成员 · {formatDuration(h.duration)}
                </div>
              </div>
              {expanded ? <ChevronDown style={{ width: 14, height: 14, color: '#64748b' }} /> : <ChevronRight style={{ width: 14, height: 14, color: '#64748b' }} />}
            </div>
            {expanded && (
              <div style={{ padding: '0 14px 12px', borderTop: '1px solid rgba(255,255,255,.04)' }}>
                {loadingDetail ? (
                  <div style={{ padding: 12, textAlign: 'center' }}>
                    <Loader2 style={{ width: 16, height: 16, color: '#06b6d4', animation: 'spin 1s linear infinite' }} />
                  </div>
                ) : detail ? (
                  <div style={{ paddingTop: 10 }}>
                    <div style={{ fontSize: 10, color: '#475569', marginBottom: 6 }}>执行 ID: <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>{h.id}</span></div>
                    {detail.members && Array.isArray(detail.members) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {detail.members.map((m: ExecutionMember, i: number) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '4px 6px', borderRadius: 4, background: 'rgba(255,255,255,.02)' }}>
                            {m.status === 'completed' ? <CheckCircle2 style={{ width: 11, height: 11, color: '#10b981' }} /> : m.status === 'failed' ? <XCircle style={{ width: 11, height: 11, color: '#ef4444' }} /> : <CircleDot style={{ width: 11, height: 11, color: '#64748b' }} />}
                            <span style={{ color: '#94a3b8' }}>{m.name || m.role}</span>
                            <span style={{ color: '#475569', fontSize: 9 }}>· {m.role}</span>
                            {m.tokenUsage && <span style={{ color: '#475569', fontSize: 9, marginLeft: 'auto' }}>{m.tokenUsage.toLocaleString()} tokens</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {!!detail.result && (
                      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(0,0,0,.2)', fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto' }}>
                        {typeof detail.result === 'string' ? detail.result.substring(0, 500) : JSON.stringify(detail.result, null, 2).substring(0, 500)}
                      </div>
                    )}
                  </div>
                ) : (
                  <p style={{ fontSize: 11, color: '#475569', padding: 12 }}>无法加载详情</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
