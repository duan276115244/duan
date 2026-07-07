import type { LoopEvent, TerminalReason } from './core/agent-loop-types.js';

/** Agent Runner 函数签名 */
export type AgentRunner = (
  input: string,
  context: Array<{ role: string; content: string }>,
  options?: { tokenBudget?: number; customSystemPrompt?: string },
) => AsyncGenerator<LoopEvent, TerminalReason, void>;

let _agentRunner: AgentRunner | null = null;

/** 注入 Agent Runner */
export function setAgentRunner(runner: AgentRunner): void {
  _agentRunner = runner;
}

export async function runAgent(
  input: string,
  context: Array<{ role: string; content: string }>,
  options?: { showThinking?: boolean; tokenBudget?: number }
): Promise<string> {
  const runner = _agentRunner;
  if (!runner) {
    return '[Agent Runner 未配置]';
  }

  let fullResponse = '';

  const generator = runner(input, context, {
    tokenBudget: options?.tokenBudget,
  });

  for await (const event of generator) {
    if (options?.showThinking) {
      switch (event.type) {
        case 'think':
          process.stdout.write(`\n  💭 ${event.content}\n`);
          break;
        case 'text':
          process.stdout.write(`  ${event.content}\n`);
          break;
        case 'tool_call':
          process.stdout.write(`  🛠️  ${event.content}\n`);
          break;
        case 'tool_result':
          break;
        case 'error':
          process.stdout.write(`  ⚠️  ${event.content}\n`);
          break;
        case 'compact':
          process.stdout.write(`  📦 ${event.content}\n`);
          break;
      }
    }

    if (event.type === 'text') {
      fullResponse += event.content;
    }

    if (event.type === 'done' && event.terminal) {
      const reason = event.terminal as TerminalReason;
      if (typeof reason === 'object' && 'type' in reason) {
        if (reason.type === 'error' || reason.type === 'doom_loop') {
          if (fullResponse.length === 0) {
            fullResponse = '[工具调用完成]';
          }
        }
      }
    }
  }

  return fullResponse || '任务已完成';
}
