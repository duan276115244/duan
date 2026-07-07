/**
 * SubAgent 事件类型定义 — sub-agent-events.ts
 *
 * C1 修复：多 Agent 后端事件发射
 * 定义 SubAgentEvent 联合类型，用于 SSE 端点转发到前端。
 * 独立于 LoopEvent，含 subagent.* 和 team.* 命名空间。
 */

// SubAgent 运行状态（与 sub-agent-orchestrator.ts SubAgentState.status 一致）
export type SubAgentStatus = 'idle' | 'running' | 'waiting_human' | 'completed' | 'error';

// TeamRole（与 agent-team-orchestrator.ts TeamRole 一致）
export type TeamRole = 'planner' | 'implementer' | 'reviewer' | 'researcher' | 'debugger' | 'architect' | 'tester' | 'writer';

// 共享上下文条目类型（与 agent-team-orchestrator.ts SharedContextEntry.type 一致）
export type SharedContextType = 'finding' | 'question' | 'decision' | 'warning' | 'status';

/** 共享上下文条目（简化版，避免循环依赖） */
export interface SubAgentSharedContextEntry {
  agentName: string;
  role: TeamRole;
  type: SharedContextType;
  content: string;
  timestamp: number;
}

/** SubAgent 事件联合类型 */
export type SubAgentEvent =
  | { type: 'subagent.dispatch'; taskId: string; agentName: string; taskPrompt: string; timestamp: number }
  | { type: 'subagent.turn'; taskId: string; turn: number; timestamp: number }
  | { type: 'subagent.tool_call'; taskId: string; toolName: string; allowed: boolean; timestamp: number }
  | { type: 'subagent.tool_result'; taskId: string; toolName: string; result: string; timestamp: number }
  | { type: 'subagent.status'; taskId: string; status: SubAgentStatus; timestamp: number }
  | { type: 'subagent.completed'; taskId: string; result?: string; tokenUsage: number; timestamp: number }
  | { type: 'team.execution.started'; executionId: string; teamName: string; memberCount: number; timestamp: number }
  | { type: 'team.board'; executionId: string; entry: SubAgentSharedContextEntry; timestamp: number }
  | { type: 'team.execution.completed'; executionId: string; teamName: string; success: boolean; duration: number; timestamp: number };

/** 将 SubAgentEvent 序列化为 SSE 数据行 */
export function serializeSubAgentEvent(event: SubAgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
