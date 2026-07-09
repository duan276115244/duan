/**
 * P0 多 Agent 接通：子 Agent 实时状态卡
 *
 * 订阅 electronAPI.subAgent.onStream（main.js 桥接后端 EventBus SSE），
 * 显示运行中的子 Agent 列表（名称 / 轮次 / 任务摘要），
 * 让用户看到"任务被分解到多个子 Agent 协作执行"，而非单 agent 黑盒。
 *
 * 事件类型（来自 SubAgentOrchestrator.emitSubAgentEvent）：
 *   subagent.dispatch   { taskId, agentName, taskPrompt }
 *   subagent.status     { taskId, status }
 *   subagent.turn       { taskId, turn }
 *   subagent.tool_call  { taskId, toolName, allowed }
 *   subagent.completed  { taskId, result, tokenUsage }
 */
import { useEffect, useState, useRef } from 'react';
import { Users, Loader2, CheckCircle2, XCircle } from 'lucide-react';

interface SubAgentInfo {
  taskId: string;
  agentName: string;
  status: 'running' | 'completed' | 'error';
  turn?: number;
  result?: string;
  taskPrompt?: string;
  finishedAt?: number;
}

// 完成的子 agent 卡片保留展示时长（ms），过后自动清除
const RETAIN_COMPLETED_MS = 12000;

export function SubAgentStatusCard() {
  const [agents, setAgents] = useState<SubAgentInfo[]>([]);
  const connectedRef = useRef(false);

  useEffect(() => {
    const api = window.electronAPI;

    // B5: 提取事件处理器 — Electron 路径与 Web SSE 路径共用。
    // 兼容两种格式：{ type, data } 或扁平 event（SSE 直接传 { type, ...data }）
    const handleEvent = (event: Record<string, unknown> | undefined) => {
      const type = (event?.type || event?.event) as string | undefined;
      const data = (event?.data || event) as Record<string, unknown> | undefined;
      if (!data) return; // 类型守卫：收窄 data 为非 undefined（taskId 依赖它）
      const taskId = data.taskId as string | undefined;
      if (!taskId || !type) return;

      setAgents(prev => {
        const idx = prev.findIndex(a => a.taskId === taskId);
        const cur = idx >= 0 ? prev[idx] : null;
        const agentName = (data.agentName as string) || cur?.agentName || 'sub-agent';

        let updated: SubAgentInfo;
        if (type === 'subagent.dispatch') {
          updated = { taskId, agentName, status: 'running', taskPrompt: data.taskPrompt as string };
        } else if (type === 'subagent.status') {
          updated = { ...(cur || { taskId, agentName, status: 'running' }), status: data.status as SubAgentInfo['status'] };
          if (data.status === 'completed' || data.status === 'error') {
            updated.finishedAt = Date.now();
          }
        } else if (type === 'subagent.turn') {
          updated = { ...(cur || { taskId, agentName, status: 'running' }), turn: data.turn as number };
        } else if (type === 'subagent.completed') {
          updated = { ...(cur || { taskId, agentName, status: 'running' }), status: 'completed', result: data.result as string, finishedAt: Date.now() };
        } else {
          return prev; // 其他事件不更新状态
        }

        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        return [...prev, updated];
      });
    };

    // Electron 路径：通过 main.js 桥接的 SSE 长连接
    if (api?.subAgent?.onStream) {
      if (!connectedRef.current) {
        connectedRef.current = true;
        api.subAgent.connectStream?.().catch(() => { /* 静默 */ });
      }
      const unsub = api.subAgent.onStream(handleEvent);
      return () => { unsub?.(); };
    }

    // B5: Web fallback — 无 Electron 时直接订阅后端 SSE 端点
    // （Web 模式下 window.electronAPI 不存在，原 if(!api) return 会静默禁用整个卡片）
    const es = new EventSource('/api/subagent/stream');
    es.onmessage = (e) => {
      try {
        handleEvent(JSON.parse(e.data));
      } catch {
        // 跳过格式错误的事件（如 heartbeat 注释行不会触发 onmessage）
      }
    };
    es.onerror = () => { /* EventSource 自动重连，无需手动处理 */ };
    return () => { es.close(); };
  }, []);

  // 定期清理已完成的卡片（超过 RETAIN_COMPLETED_MS）
  useEffect(() => {
    const timer = setInterval(() => {
      setAgents(prev => {
        const now = Date.now();
        const filtered = prev.filter(a => {
          if (a.status === 'running') return true;
          return !a.finishedAt || (now - a.finishedAt) < RETAIN_COMPLETED_MS;
        });
        return filtered.length !== prev.length ? filtered : prev;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  if (agents.length === 0) return null;

  const runningCount = agents.filter(a => a.status === 'running').length;

  return (
    <div style={{
      margin: '8px 12px', padding: '8px 12px', borderRadius: 10,
      background: 'rgba(139,92,246,.06)', border: '1px solid rgba(139,92,246,.2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Users style={{ width: 12, height: 12, color: '#a78bfa' }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: '#c4b5fd' }}>
          {runningCount > 0 ? `子 Agent 协作中 · ${runningCount} 个运行中` : '子 Agent 任务已完成'}
        </span>
      </div>
      {agents.map(a => {
        const isRunning = a.status === 'running';
        const isOk = a.status === 'completed';
        return (
          <div key={a.taskId} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '3px 0', fontSize: 11,
          }}>
            {isRunning
              ? <Loader2 style={{ width: 10, height: 10, color: '#a78bfa', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
              : isOk
                ? <CheckCircle2 style={{ width: 10, height: 10, color: '#10b981', flexShrink: 0 }} />
                : <XCircle style={{ width: 10, height: 10, color: '#ef4444', flexShrink: 0 }} />}
            <span style={{ fontWeight: 600, color: isRunning ? '#c4b5fd' : isOk ? '#10b981' : '#ef4444', flexShrink: 0 }}>
              {a.agentName}
            </span>
            {a.turn != null && isRunning && (
              <span style={{ color: '#64748b' }}>· 第 {a.turn} 轮</span>
            )}
            <span style={{
              color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            }}>
              {a.status === 'running'
                ? (a.taskPrompt || '').substring(0, 60)
                : a.result ? `✓ ${(a.result || '').substring(0, 60)}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
