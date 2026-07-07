/**
 * 消灭孤岛 I-1：Web 主循环收敛 — LoopStreamAdapter
 *
 * 默认情况下，chat-routes 调用 runViaUnifiedLoop 代替 streamLLMResponse，
 * 使 Web 请求实际消费 setupAgentLoop() 返回的 loop 实例（Plan/Execute/Reflect/Learn 全启用）。
 *
 * 职责：将 EnhancedAgentLoop.run() 的 LoopEvent 流适配为 Web 期望的 StreamEvent 流。
 * 显式设置 USE_UNIFIED_LOOP=false 时，chat-routes 回退到原 streamLLMResponse 旁路，行为不变。
 *
 * 详见 v19 方案 §4.1 I-1。
 */
import type { EnhancedAgentLoop } from '../../core/enhanced-agent-loop.js';
import type { LoopEvent, TerminalReason } from '../../core/agent-loop-types.js';
import { errMsg } from './app-context.js';

export type StreamEvent = {
  type: 'chunk' | 'think' | 'tool_call' | 'tool_result';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
};

/**
 * 将 EnhancedAgentLoop.run() 包装为 StreamEvent 生成器。
 *
 * @param loop    EnhancedAgentLoop 实例（来自 setupAgentLoop()）
 * @param messages 完整对话历史（最后一条作为本次 input，其余作为 context）
 * @param customSystemPrompt 可选自定义系统提示
 */
export async function* runViaUnifiedLoop(
  loop: EnhancedAgentLoop,
  messages: Array<{ role: string; content: string }>,
  customSystemPrompt?: string,
): AsyncGenerator<StreamEvent> {
  if (messages.length === 0) {
    yield { type: 'chunk', content: '⚠️ 空消息' };
    return;
  }

  // 最后一条作为本次 input，之前的历史作为 context（与 streamLLMResponse 一致）
  const last = messages[messages.length - 1];
  const input = last.content;
  const context = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

  // P0-4/#5 修复：跟踪已通过 text 事件输出的内容，用于 completed 时计算 guardrail 增量
  // checkOutputGuardrail 会对输出做4阶段处理（安全修改/对抗验证警告/风格适配/个性化建议）
  // 如果 summary 与已输出内容不同，说明 guardrail 追加了警告或修复了内容，需输出差异
  let lastTextContent = '';

  let terminal: TerminalReason | undefined;
  try {
    const gen = loop.run(input, context, customSystemPrompt);
    while (true) {
      const result = await gen.next();
      if (result.done) {
        terminal = result.value as TerminalReason;
        break;
      }
      const ev = result.value as LoopEvent;
      // 记录 text 事件输出的内容，用于后续 completed 差异计算
      if (ev.type === 'text' && typeof ev.content === 'string') {
        lastTextContent = ev.content;
      }
      const mapped = mapLoopEventToStreamEvent(ev);
      if (mapped) yield mapped;
    }
  } catch (err) {
    yield { type: 'chunk', content: `\n\n⚠️ 统一主循环出错: ${errMsg(err)}` };
    return;
  }

  if (terminal?.type === 'error') {
    yield { type: 'chunk', content: `\n\n⚠️ ${terminal.error}` };
  } else if (terminal?.type === 'completed' && terminal.summary) {
    // P0-4/#5 修复：completed 类型也输出 summary，但只输出 guardrail 增量修改部分
    // 避免与已通过 text 事件输出的原始内容重复
    const summary = terminal.summary;
    if (summary.startsWith(lastTextContent) && summary.length > lastTextContent.length) {
      // guardrail 追加了内容（如警告行/后续建议），只输出增量部分
      yield { type: 'chunk', content: summary.slice(lastTextContent.length) };
    } else if (summary !== lastTextContent) {
      // guardrail 完全替换了内容（如安全 modify/critical 修复），输出完整 summary
      yield { type: 'chunk', content: `\n\n${summary}` };
    }
    // 如果 summary === lastTextContent，guardrail 未修改，不输出（避免重复）
  }
}

/**
 * LoopEvent → StreamEvent 映射。
 *
 * 设计原则：
 * - text       → chunk      （主响应文本，写入 fullResponse）
 * - tool_call  → tool_call  （工具调用提示）
 * - tool_result→ tool_result（工具结果）
 * - think      → think      （思考过程）
 * - plan       → think      （执行计划，复用 think 通道展示）
 * - warning    → think      （警告，复用 think 通道展示）
 * - compact    → think      （上下文压缩通知，复用 think 通道展示）
 * - error      → chunk      （错误信息写入主响应，与 streamLLMResponse 错误处理一致）
 * - state/done → 跳过       （内部状态，不输出给用户）
 */
function mapLoopEventToStreamEvent(ev: LoopEvent): StreamEvent | null {
  switch (ev.type) {
    case 'text':
      return { type: 'chunk', content: ev.content };
    case 'tool_call':
      return { type: 'tool_call', content: ev.content, toolName: ev.toolName, toolArgs: ev.toolArgs };
    case 'tool_result':
      return { type: 'tool_result', content: ev.content, toolName: ev.toolName };
    case 'think':
      return { type: 'think', content: ev.content };
    case 'plan':
      return { type: 'think', content: ev.content || '执行计划已生成' };
    case 'warning':
      return { type: 'think', content: ev.content };
    case 'compact':
      return { type: 'think', content: ev.content };
    case 'error':
      return { type: 'chunk', content: ev.content };
    case 'state':
    case 'done':
      return null;
    default:
      return null;
  }
}
