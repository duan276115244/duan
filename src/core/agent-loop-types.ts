import type OpenAI from 'openai';

export type LLMProvider = 'deepseek' | 'openrouter' | 'openai' | 'anthropic' | 'groq';

export type { ToolDef } from './unified-tool-def.js';

export interface AgentState {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  toolCallHistory: Array<{ name: string; args: string; timestamp: number }>;
  tokenBudget: number;
  tokensUsed: number;
  totalCost: number;
  turnCount: number;
  startTime: number;
  compactCount: number;
  lastCompactTime: number;
  errorCount: number;
  learningContext: Record<string, unknown>;
}

export type TerminalReason =
  | { type: 'completed'; summary: string }
  | { type: 'max_tokens'; summary: string }
  | { type: 'error'; error: string; recoverable: boolean }
  | { type: 'interrupted'; summary: string }
  | { type: 'doom_loop'; toolName: string; summary: string }
  | { type: 'compaction_failure'; summary: string };

/** LoopEvent 的公共字段 — 所有事件类型共享 */
export interface LoopEventBase {
  content: string;
  /** FSM 状态 — 标识当前循环处于哪个阶段 */
  agentStatus?: string;
}

/**
 * 基于 type 的可辨识联合类型。
 * 每个事件携带的字段成为对应事件的必填字段，其余事件无法访问。
 */
export type LoopEvent =
  | (LoopEventBase & { type: 'text' })
  | (LoopEventBase & {
      type: 'tool_call';
      toolName: string;
      toolArgs: Record<string, unknown>;
    })
  | (LoopEventBase & {
      type: 'tool_result';
      toolName: string;
    })
  | (LoopEventBase & { type: 'think' })
  | (LoopEventBase & { type: 'error' })
  | (LoopEventBase & { type: 'warning' })
  | (LoopEventBase & { type: 'compact' })
  | (LoopEventBase & {
      type: 'done';
      terminal: TerminalReason;
      state?: AgentState;
    })
  | (LoopEventBase & {
      type: 'state';
      state: AgentState;
    })
  | (LoopEventBase & {
      type: 'plan';
      plan: Record<string, unknown>;
    })
  | (LoopEventBase & {
      type: 'proactive_announcement';
      /** V19 贾维斯增强：主动发声事件的严重级别 */
      severity: 'info' | 'warn' | 'error';
    });

/** LoopEvent 的所有可能 type 值 */
export type LoopEventType = LoopEvent['type'];
