/**
 * useSubAgentStream — SubAgent 多 Agent 实时事件流 hook
 *
 * Web 模式：new EventSource('/api/subagent/stream') 直连后端 SSE
 * Electron 模式：通过 IPC 桥接（main 进程管理 SSE 长连接，转发到 renderer）
 *
 * 管理 3 类状态：
 * - events: 最近 100 条原始事件（日志流）
 * - activeAgents: 活跃 Agent 映射（taskId → 状态信息）
 * - boardEntries: 共享上下文板条目
 */
import { useState, useEffect, useRef, useCallback } from 'react';

// ============ 类型定义 ============

export type SubAgentStatus = 'idle' | 'running' | 'waiting_human' | 'completed' | 'error';

export interface SubAgentEvent {
  type: string;
  taskId?: string;
  agentName?: string;
  taskPrompt?: string;
  turn?: number;
  toolName?: string;
  allowed?: boolean;
  result?: string;
  status?: SubAgentStatus;
  tokenUsage?: number;
  executionId?: string;
  teamName?: string;
  memberCount?: number;
  success?: boolean;
  duration?: number;
  entry?: { agentName: string; role: string; type: string; content: string; timestamp: number };
  timestamp: number;
}

export interface ActiveAgent {
  taskId: string;
  agentName: string;
  status: SubAgentStatus;
  turn?: number;
  tokenUsage?: number;
  lastUpdate: number;
  logs: Array<{ type: string; text: string; timestamp: number }>;
}

export interface BoardEntry {
  agentName: string;
  role: string;
  type: string;
  content: string;
  timestamp: number;
}

// ============ Hook ============

const MAX_EVENTS = 100;
const MAX_LOGS_PER_AGENT = 50;

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

export function useSubAgentStream() {
  const [events, setEvents] = useState<SubAgentEvent[]>([]);
  const [activeAgents, setActiveAgents] = useState<Map<string, ActiveAgent>>(new Map());
  const [boardEntries, setBoardEntries] = useState<BoardEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // 处理收到的事件
  const handleEvent = useCallback((event: SubAgentEvent) => {
    // 追加到事件日志（保留最近 100 条）
    setEvents(prev => [...prev.slice(-(MAX_EVENTS - 1)), event]);

    // 按 type 分类更新状态
    const { type, taskId } = event;
    if (!taskId && !event.executionId) return;

    if (type === 'subagent.dispatch' && taskId) {
      setActiveAgents(prev => {
        const next = new Map(prev);
        next.set(taskId, {
          taskId,
          agentName: event.agentName || 'unknown',
          status: 'running',
          turn: 0,
          tokenUsage: 0,
          lastUpdate: Date.now(),
          logs: [{ type: 'dispatch', text: event.taskPrompt || '', timestamp: event.timestamp }],
        });
        return next;
      });
    } else if (type === 'subagent.turn' && taskId) {
      setActiveAgents(prev => {
        const next = new Map(prev);
        const agent = next.get(taskId);
        if (agent) {
          agent.turn = event.turn;
          agent.lastUpdate = Date.now();
          agent.logs.push({ type: 'turn', text: `Turn ${event.turn}`, timestamp: event.timestamp });
          if (agent.logs.length > MAX_LOGS_PER_AGENT) agent.logs = agent.logs.slice(-MAX_LOGS_PER_AGENT);
          next.set(taskId, { ...agent });
        }
        return next;
      });
    } else if (type === 'subagent.tool_call' && taskId) {
      setActiveAgents(prev => {
        const next = new Map(prev);
        const agent = next.get(taskId);
        if (agent) {
          agent.logs.push({
            type: 'tool_call',
            text: `${event.toolName} ${event.allowed ? '✓' : '✗'}`,
            timestamp: event.timestamp,
          });
          if (agent.logs.length > MAX_LOGS_PER_AGENT) agent.logs = agent.logs.slice(-MAX_LOGS_PER_AGENT);
          next.set(taskId, { ...agent });
        }
        return next;
      });
    } else if (type === 'subagent.tool_result' && taskId) {
      setActiveAgents(prev => {
        const next = new Map(prev);
        const agent = next.get(taskId);
        if (agent) {
          const resultText = event.result ? event.result.substring(0, 200) : '';
          agent.logs.push({ type: 'tool_result', text: `${event.toolName}: ${resultText}`, timestamp: event.timestamp });
          if (agent.logs.length > MAX_LOGS_PER_AGENT) agent.logs = agent.logs.slice(-MAX_LOGS_PER_AGENT);
          next.set(taskId, { ...agent });
        }
        return next;
      });
    } else if (type === 'subagent.status' && taskId) {
      setActiveAgents(prev => {
        const next = new Map(prev);
        const agent = next.get(taskId);
        if (agent) {
          agent.status = event.status || 'idle';
          agent.lastUpdate = Date.now();
          next.set(taskId, { ...agent });
        }
        return next;
      });
    } else if (type === 'subagent.completed' && taskId) {
      setActiveAgents(prev => {
        const next = new Map(prev);
        const agent = next.get(taskId);
        if (agent) {
          agent.status = 'completed';
          agent.tokenUsage = event.tokenUsage || agent.tokenUsage;
          agent.lastUpdate = Date.now();
          agent.logs.push({ type: 'completed', text: event.result || '完成', timestamp: event.timestamp });
          if (agent.logs.length > MAX_LOGS_PER_AGENT) agent.logs = agent.logs.slice(-MAX_LOGS_PER_AGENT);
          next.set(taskId, { ...agent });
        }
        return next;
      });
    } else if (type === 'team.board' && event.entry) {
      setBoardEntries(prev => [...prev.slice(-199), event.entry!]);
    }
  }, []);

  // 建立连接
  useEffect(() => {
    if (isElectron()) {
      // Electron 模式：通过 IPC 桥接
      const api = window.electronAPI;
      if (!api?.subAgent) return;

      const cleanup = api.subAgent.onStream((event: SubAgentEvent) => {
        handleEvent(event);
      });
      api.subAgent.connectStream().then(() => setConnected(true)).catch(() => {});

      cleanupRef.current = () => {
        cleanup?.();
        api.subAgent.disconnectStream?.();
      };
    } else {
      // Web 模式：EventSource 直连
      try {
        const es = new EventSource('/api/subagent/stream');
        es.onmessage = (e) => {
          try {
            const event = JSON.parse(e.data);
            handleEvent(event);
          } catch { /* 忽略非 JSON */ }
        };
        es.onopen = () => setConnected(true);
        es.onerror = () => setConnected(false);
        cleanupRef.current = () => es.close();
      } catch {
        setConnected(false);
      }
    }

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [handleEvent]);

  // 清除已完成的 Agent
  const clearCompleted = useCallback(() => {
    setActiveAgents(prev => {
      const next = new Map(prev);
      for (const [id, agent] of next) {
        if (agent.status === 'completed' || agent.status === 'error') {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  // 启动团队
  const startTeam = useCallback(async (templateName: string, taskGoal: string, extraContext?: string) => {
    if (isElectron()) {
      return window.electronAPI?.subAgent?.startTeam(templateName, taskGoal, extraContext);
    }
    try {
      const res = await fetch('/api/subagent/team/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateName, taskGoal, extraContext }),
      });
      if (!res.ok) {
        console.warn(`启动团队失败: HTTP ${res.status}`);
        return null;
      }
      return res.json();
    } catch (error) {
      console.warn('启动团队网络错误:', error);
      return null;
    }
  }, []);

  // 列出可用 Agent
  const listAgents = useCallback(async () => {
    if (isElectron()) {
      return window.electronAPI?.subAgent?.listAgents();
    }
    try {
      const res = await fetch('/api/subagent/agents');
      if (!res.ok) {
        console.warn(`获取 Agent 列表失败: HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();
      return Array.isArray(data) ? data : (data?.agents || []);
    } catch (error) {
      console.warn('获取 Agent 列表网络错误:', error);
      return [];
    }
  }, []);

  // 列出团队模板
  const listTemplates = useCallback(async () => {
    if (isElectron()) {
      return window.electronAPI?.subAgent?.listTemplates();
    }
    try {
      const res = await fetch('/api/subagent/team-templates');
      if (!res.ok) {
        console.warn(`获取团队模板失败: HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();
      return Array.isArray(data) ? data : (data?.templates || []);
    } catch (error) {
      console.warn('获取团队模板网络错误:', error);
      return [];
    }
  }, []);

  return {
    events,
    activeAgents,
    boardEntries,
    connected,
    clearCompleted,
    startTeam,
    listAgents,
    listTemplates,
  };
}
