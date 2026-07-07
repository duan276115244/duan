import { useState, useEffect, useCallback } from 'react';
import { Activity, Cpu, Zap, Brain, Heart, Database, GitBranch, Users, Target, Sparkles, RefreshCw } from 'lucide-react';

export function SystemStatus() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 后端 status 是动态聚合对象
  const [status, setStatus] = useState<any>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  // P0 自我改进接通：进化历史 + 立即进化按钮状态
  const [evolution, setEvolution] = useState<{
    history?: Array<{ id: string; timestamp: number; summary: string; successCount: number; failCount: number; durationMs: number }>;
    stats?: string;
  } | null>(null);
  const [evolving, setEvolving] = useState(false);
  const [evolveMessage, setEvolveMessage] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const api = window.electronAPI;
      if (api) {
        const data = await api.system.status();
        setStatus(data);
      } else {
        const response = await fetch('/api/status');
        if (response.ok) {
          const data = await response.json();
          setStatus(data);
        }
      }
    } catch (error) {
      console.warn('获取系统状态失败:', error);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchStatus();
    setRefreshing(false);
  };

  // P0 自我改进接通：拉取 SelfEvolutionEngine 进化历史
  const fetchEvolution = useCallback(async () => {
    try {
      const api = window.electronAPI;
      if (api?.selfImprove?.evolutionHistory) {
        const data = await api.selfImprove.evolutionHistory();
        if (data?.success) {
          setEvolution({ history: data.history, stats: data.stats });
        }
      } else {
        const response = await fetch('/api/self-evolve/history');
        if (response.ok) {
          const data = await response.json();
          setEvolution({ history: data.history, stats: data.stats });
        }
      }
    } catch {
      /* 静默 — 后端可能未启动 */
    }
  }, []);

  useEffect(() => {
    fetchEvolution();
    const interval = setInterval(fetchEvolution, 60000); // 1 分钟刷新
    return () => clearInterval(interval);
  }, [fetchEvolution]);

  // P0 自我改进接通：立即执行一轮 evolve cycle
  const handleEvolveNow = async () => {
    if (evolving) return;
    setEvolving(true);
    setEvolveMessage(null);
    try {
      const api = window.electronAPI;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      if (api) {
        result = await api.selfImprove.run();
      } else {
        const response = await fetch('/api/self-evolve/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        result = await response.json();
      }
      // 兼容多种包装：{success, result} | EvolutionCycle | {error}
      if (result?.success === false) {
        setEvolveMessage(`❌ ${result.error || '进化失败'}`);
      } else {
        const c = result?.result || result?.cycle || result;
        const sc = c?.successCount ?? 0;
        const fc = c?.failCount ?? c?.failureCount ?? 0;
        const summary = c?.summary ? String(c.summary).substring(0, 60) : '';
        setEvolveMessage(`✅ 进化完成: 成功 ${sc} 项 / 失败 ${fc} 项${summary ? ' · ' + summary : ''}`);
        // 刷新历史 + 系统状态
        fetchEvolution();
        fetchStatus();
      }
    } catch (e: unknown) {
      setEvolveMessage(`❌ 异常: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEvolving(false);
      // 8 秒后自动清除消息
      setTimeout(() => setEvolveMessage(null), 8000);
    }
  };

  const formatTime = (date: Date) =>
    date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const getEnergyColor = (val: number) => {
    if (val > 70) return '#06b6d4';
    if (val > 40) return '#f59e0b';
    return '#ef4444';
  };

  const energyRaw = status?.consciousness?.energy;
  const energy = energyRaw != null ? Math.round(energyRaw * 100) : null;
  const energyColor = energy != null ? getEnergyColor(energy) : '#475569';
  const beatCount = status?.heartbeat?.beatCount ?? 0;
  const activeGoals = status?.goals?.active ?? 0;
  const totalGoals = status?.goals?.total ?? 0;

  // P0 自我改进接通：自进化真实数据（最近一次 evolve 时间 + 成功/失败数）
  const lastCycle = evolution?.history?.[0];
  const evolutionDetail = lastCycle
    ? `最近进化: ${new Date(lastCycle.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · 成功 ${lastCycle.successCount} / 失败 ${lastCycle.failCount} 项 · ${(lastCycle.summary || '').substring(0, 40)}`
    : (evolution?.stats || '尚未执行进化周期，点击右侧"立即进化"启动');
  const evolutionActive = !!(evolution?.history?.length);

  const gridItems = [
    { icon: Cpu, color: '#06b6d4', label: '版本', value: status?.version || '加载中', tooltip: '当前系统版本号' },
    { icon: Zap, color: '#10b981', label: '模式', value: status?.mode || '加载中', tooltip: '运行模式：desktop 为桌面端，production 为生产环境' },
    { icon: Database, color: '#8b5cf6', label: '工具', value: status?.toolsAvailable != null ? `${status.toolsAvailable}` : '加载中', tooltip: '当前可用的工具数量' },
    { icon: Brain, color: '#f59e0b', label: '技能', value: status?.skills != null ? `${status.skills}` : '加载中', tooltip: '已加载的技能数量' },
  ];

  const moduleItems = [
    { icon: Brain, color: '#06b6d4', label: '自我认知', key: 'selfAwareness', active: !!status?.selfAwareness, tooltip: 'Agent 的自我认知与进化能力', detail: `进化等级: ${status?.selfAwareness?.evolutionLevel || 'N/A'} · 已完成任务: ${status?.selfAwareness?.totalTasks ?? 0}` },
    { icon: Database, color: '#8b5cf6', label: '统一记忆', key: 'conversationManagement', active: !!status?.features?.conversationManagement, tooltip: '对话记忆管理与上下文保持', detail: '管理所有对话的上下文和记忆，支持跨会话记忆检索' },
    { icon: Users, color: '#10b981', label: '多Agent', key: 'subAgents', active: !!status?.features?.subAgents, tooltip: '子 Agent 协作与任务分发', detail: '支持创建子 Agent 协作完成复杂任务' },
    { icon: GitBranch, color: '#f59e0b', label: '工作流', key: 'multiAgent', active: !!status?.features?.multiAgent, tooltip: '多 Agent 工作流编排', detail: '编排多个 Agent 按流程协作执行' },
    { icon: Target, color: '#ef4444', label: '目标系统', key: 'goalSystem', active: !!status?.features?.goalSystem, tooltip: '目标设定、追踪与达成', detail: `活跃目标: ${activeGoals} / 总目标: ${totalGoals}` },
    { icon: Sparkles, color: '#a78bfa', label: '自进化', key: 'evolution', active: evolutionActive || !!status?.features?.heartbeat, tooltip: '自我进化机制（SelfEvolutionEngine）— 点击"立即进化"触发', detail: evolutionDetail },
  ];

  const handleMouseEnter = (text: string, e: React.MouseEvent) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setTooltip({ text, x: rect.left + rect.width / 2, y: rect.top - 4 });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <div style={{
      borderRadius: 14,
      background: 'rgba(6,182,212,.04)',
      border: '1px solid rgba(6,182,212,.1)',
      padding: 16,
      position: 'relative',
    }}>
      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: tooltip.x,
          top: tooltip.y,
          transform: 'translate(-50%, -100%)',
          background: 'rgba(15,20,35,.95)',
          border: '1px solid rgba(6,182,212,.2)',
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 11,
          color: '#94a3b8',
          zIndex: 1000,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,.3)',
        }}>
          {tooltip.text}
        </div>
      )}

      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity style={{ width: 14, height: 14, color: '#06b6d4' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>系统状态</span>
          <span style={{
            fontSize: 10, padding: '1px 8px', borderRadius: 10, fontWeight: 500,
            background: status?.mode === 'production' ? 'rgba(16,185,129,.12)' : 'rgba(6,182,212,.1)',
            color: status?.mode === 'production' ? '#10b981' : '#06b6d4',
            border: `1px solid ${status?.mode === 'production' ? 'rgba(16,185,129,.2)' : 'rgba(6,182,212,.2)'}`,
          }}>
            {status?.mode === 'production' ? 'PROD' : 'LOCAL'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#475569' }}>
            {formatTime(currentTime)}
          </span>
          <button
            onClick={handleRefresh}
            style={{
              padding: 4, borderRadius: 6,
              background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
              cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.1)'; e.currentTarget.style.color = '#06b6d4'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.04)'; e.currentTarget.style.color = '#94a3b8'; }}
          >
            <RefreshCw style={{ width: 12, height: 12, animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      {/* 状态网格 2x2 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {gridItems.map((item) => (
          <div key={item.label} style={{
            background: 'rgba(6,182,212,.04)', borderRadius: 10, padding: 10,
            display: 'flex', flexDirection: 'column', gap: 4,
            border: '1px solid rgba(6,182,212,.06)',
            cursor: 'default',
          }}
            onMouseEnter={(e) => handleMouseEnter(item.tooltip, e)}
            onMouseLeave={handleMouseLeave}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <item.icon style={{ width: 12, height: 12, color: item.color }} />
              <span style={{ fontSize: 11, color: '#475569' }}>{item.label}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* 核心模块状态 */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: '#475569', marginBottom: 6 }}>核心模块</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
          {moduleItems.map((item) => (
            <div key={item.label} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 6px', borderRadius: 6,
              background: expandedModule === item.key ? 'rgba(6,182,212,.08)' : item.active ? 'rgba(6,182,212,.04)' : 'rgba(255,255,255,.02)',
              cursor: 'pointer',
              transition: 'background .15s',
              border: expandedModule === item.key ? '1px solid rgba(6,182,212,.2)' : '1px solid transparent',
            }}
              onClick={() => setExpandedModule(expandedModule === item.key ? null : item.key)}
              onMouseEnter={(e) => handleMouseEnter(item.tooltip, e)}
              onMouseLeave={handleMouseLeave}
            >
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: item.active ? item.color : '#475569',
                boxShadow: item.active ? `0 0 4px ${item.color}60` : 'none',
              }} />
              <span style={{ fontSize: 10, color: item.active ? '#94a3b8' : '#475569' }}>{item.label}</span>
            </div>
          ))}
        </div>
        {/* 模块详情展开区 */}
        {expandedModule && (() => {
          const mod = moduleItems.find(m => m.key === expandedModule);
          if (!mod) return null;
          return (
            <div style={{
              marginTop: 6, padding: '8px 10px', borderRadius: 8,
              background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)',
              fontSize: 11, color: '#94a3b8', lineHeight: 1.5,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: mod.active ? mod.color : '#475569',
                  boxShadow: mod.active ? `0 0 4px ${mod.color}60` : 'none',
                }} />
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{mod.label}</span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: mod.active ? 'rgba(16,185,129,.12)' : 'rgba(100,116,139,.12)',
                  color: mod.active ? '#10b981' : '#64748b',
                }}>
                  {mod.active ? '已启用' : '未启用'}
                </span>
              </div>
              <div>{mod.detail}</div>
            </div>
          );
        })()}
      </div>

      {/* P0 自我改进接通：自进化操作行 + 立即进化按钮 */}
      <div style={{
        marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '6px 10px', borderRadius: 8,
        background: 'rgba(167,139,250,.06)', border: '1px solid rgba(167,139,250,.14)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <Sparkles style={{ width: 12, height: 12, color: '#a78bfa', flexShrink: 0 }} />
          <span style={{
            fontSize: 10, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
            onMouseEnter={(e) => handleMouseEnter(evolutionDetail, e)}
            onMouseLeave={handleMouseLeave}
          >
            {evolution?.stats || (evolutionActive ? '自进化已就绪' : '自进化未运行')}
          </span>
        </div>
        <button
          onClick={handleEvolveNow}
          disabled={evolving}
          style={{
            padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
            background: evolving ? 'rgba(100,116,139,.12)' : 'rgba(167,139,250,.14)',
            color: evolving ? '#64748b' : '#a78bfa',
            border: `1px solid ${evolving ? 'rgba(100,116,139,.2)' : 'rgba(167,139,250,.28)'}`,
            cursor: evolving ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
            transition: 'all .15s',
          }}
          onMouseEnter={(e) => { if (!evolving) { e.currentTarget.style.background = 'rgba(167,139,250,.22)'; } }}
          onMouseLeave={(e) => { if (!evolving) { e.currentTarget.style.background = 'rgba(167,139,250,.14)'; } }}
        >
          {evolving
            ? <><RefreshCw style={{ width: 10, height: 10, animation: 'spin 1s linear infinite' }} /> 进化中…</>
            : <><Sparkles style={{ width: 10, height: 10 }} /> 立即进化</>}
        </button>
      </div>
      {evolveMessage && (
        <div style={{
          marginTop: 4, padding: '5px 10px', borderRadius: 6, fontSize: 10,
          background: evolveMessage.startsWith('❌') ? 'rgba(239,68,68,.08)' : 'rgba(16,185,129,.08)',
          color: evolveMessage.startsWith('❌') ? '#ef4444' : '#10b981',
          border: `1px solid ${evolveMessage.startsWith('❌') ? 'rgba(239,68,68,.2)' : 'rgba(16,185,129,.2)'}`,
          lineHeight: 1.4,
        }}>
          {evolveMessage}
        </div>
      )}

      {/* 意识状态行 */}
      <div style={{
        marginTop: 10, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onMouseEnter={(e) => handleMouseEnter(`当前能量: ${energy != null ? energy + '%' : '加载中'}`, e)}
          onMouseLeave={handleMouseLeave}
        >
          <Heart style={{ width: 12, height: 12, color: energyColor }} />
          <span style={{ fontSize: 11, color: '#475569' }}>能量</span>
          <div style={{
            width: 50, height: 4, backgroundColor: 'rgba(6,182,212,.1)',
            borderRadius: 2, overflow: 'hidden',
          }}>
            <div style={{
              width: `${energy ?? 0}%`, height: '100%',
              backgroundColor: energyColor,
              borderRadius: 2, transition: 'width .5s',
            }} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, color: energyColor }}>{energy != null ? `${energy}%` : '加载中'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          onMouseEnter={(e) => handleMouseEnter(`目标进度: ${activeGoals} 个活跃 / ${totalGoals} 个总计`, e)}
          onMouseLeave={handleMouseLeave}
        >
          <Target style={{ width: 10, height: 10, color: '#a78bfa' }} />
          <span style={{ fontSize: 10, color: '#64748b' }}>{activeGoals}/{totalGoals}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          onMouseEnter={(e) => handleMouseEnter(`心跳计数: 第 ${beatCount} 次`, e)}
          onMouseLeave={handleMouseLeave}
        >
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            backgroundColor: '#06b6d4',
            boxShadow: '0 0 6px rgba(6,182,212,.5)',
          }} />
          <span style={{ fontSize: 10, color: '#475569' }}>#{beatCount}</span>
        </div>
      </div>
    </div>
  );
}
