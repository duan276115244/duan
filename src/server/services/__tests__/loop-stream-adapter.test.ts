/**
 * 消灭孤岛 I-1：LoopStreamAdapter 验证测试
 *
 * 验证 runViaUnifiedLoop 将 EnhancedAgentLoop.run() 的 LoopEvent 流
 * 正确适配为 Web 期望的 StreamEvent 流。
 *
 * 不依赖真实 EnhancedAgentLoop 实例 — 使用最小 mock 实现 loop.run() 返回受控事件流。
 * 详见 v19 方案 §4.1 I-1。
 */
import { describe, it, expect } from 'vitest';
import { runViaUnifiedLoop, type StreamEvent } from '../loop-stream-adapter.js';
import type { LoopEvent, TerminalReason, AgentState } from '../../../core/agent-loop-types.js';
import type { EnhancedAgentLoop } from '../../../core/enhanced-agent-loop.js';

/** 测试用最小 AgentState（state 事件仅用于验证 adapter 会跳过它们，字段值无关紧要） */
const mockState = { messages: [], toolCallHistory: [], tokenBudget: 0, tokensUsed: 0, totalCost: 0, turnCount: 0, startTime: 0, compactCount: 0, lastCompactTime: 0, errorCount: 0, learningContext: {} } as unknown as AgentState;

type LoopGenerator = AsyncGenerator<LoopEvent, TerminalReason, void>;

/** 创建最小可用的 mock loop — 仅实现 run() 返回受控事件流 */
function createMockLoop(
  events: LoopEvent[],
  terminal: TerminalReason = { type: 'completed', summary: 'ok' },
  options: { throwOnRun?: Error } = {},
): EnhancedAgentLoop {
  const runImpl = async function* (): LoopGenerator {
    if (options.throwOnRun) throw options.throwOnRun;
    for (const ev of events) yield ev;
    return terminal;
  };
  return { run: runImpl } as unknown as EnhancedAgentLoop;
}

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('I-1 LoopStreamAdapter', () => {
  describe('LoopEvent → StreamEvent 类型映射', () => {
    it('text → chunk（写入主响应）', async () => {
      // summary 与 text 内容相同 → guardrail 未修改 → 不输出额外 chunk（验证去重路径）
      const loop = createMockLoop(
        [{ type: 'text', content: 'hello' }],
        { type: 'completed', summary: 'hello' },
      );
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toBe('hello');
    });

    it('tool_call → tool_call（保留 toolName/toolArgs）', async () => {
      const loop = createMockLoop([{
        type: 'tool_call',
        content: '调用工具: web_search',
        toolName: 'web_search',
        toolArgs: { query: 'test' },
      }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: '搜索 test' }]));
      expect(events[0]).toMatchObject({
        type: 'tool_call',
        content: '调用工具: web_search',
        toolName: 'web_search',
        toolArgs: { query: 'test' },
      });
    });

    it('tool_result → tool_result', async () => {
      const loop = createMockLoop([{
        type: 'tool_result',
        content: '结果',
        toolName: 'web_search',
      }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('tool_result');
      expect(events[0].content).toBe('结果');
      expect(events[0].toolName).toBe('web_search');
    });

    it('think → think', async () => {
      const loop = createMockLoop([{ type: 'think', content: '正在思考...' }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('think');
      expect(events[0].content).toBe('正在思考...');
    });

    it('plan → plan（保留语义类型与结构化 plan 字段）', async () => {
      const loop = createMockLoop([{ type: 'plan', content: '执行计划', plan: { steps: ['a', 'b'] } }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('plan');
      expect(events[0].content).toBe('执行计划');
      expect(events[0].plan).toEqual({ steps: ['a', 'b'] });
    });

    it('plan 空 content 时使用默认文案', async () => {
      const loop = createMockLoop([{ type: 'plan', content: '', plan: {} }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('plan');
      expect(events[0].content).toBe('执行计划已生成');
    });

    it('warning → warning（保留语义类型，前端渲染为 amber 横幅）', async () => {
      const loop = createMockLoop([{ type: 'warning', content: '上下文即将压缩' }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('warning');
      expect(events[0].content).toBe('上下文即将压缩');
    });

    it('compact → compact（保留语义类型，前端渲染为 📦 压缩卡片）', async () => {
      const loop = createMockLoop([{ type: 'compact', content: '已压缩 3 条消息' }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('compact');
      expect(events[0].content).toBe('已压缩 3 条消息');
    });

    it('error → chunk（错误信息写入主响应）', async () => {
      const loop = createMockLoop([{ type: 'error', content: 'API Key 无效' }]);
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toBe('API Key 无效');
    });

    it('state/done 被跳过（不输出给用户）', async () => {
      // summary 与最后 text 内容相同 → guardrail 未修改 → 不输出额外 chunk
      const loop = createMockLoop([
        { type: 'state', content: 'internal', state: mockState },
        { type: 'done', content: 'internal', terminal: { type: 'completed', summary: '' } },
        { type: 'text', content: '可见文本' },
      ], { type: 'completed', summary: '可见文本' });
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toBe('可见文本');
    });
  });

  describe('消息处理', () => {
    it('空消息数组立即返回警告 chunk', async () => {
      const loop = createMockLoop([{ type: 'text', content: '不应该到达这里' }]);
      const events = await collect(runViaUnifiedLoop(loop, []));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toMatch(/空消息/);
    });

    it('最后一条消息作为 input，之前的历史作为 context', async () => {
      let capturedInput = '';
      let capturedContext: Array<{ role: string; content: string }> = [];
      const runImpl = async function* (): LoopGenerator {
        // 模拟 loop.run 内部读取 input/context — 通过闭包捕获
        yield { type: 'text', content: `input=${capturedInput}, ctxLen=${capturedContext.length}` };
        return { type: 'completed', summary: 'ok' };
      };
      const loop = {
        run: (input: string, context: Array<{ role: string; content: string }>) => {
          capturedInput = input;
          capturedContext = context;
          return runImpl();
        },
      } as unknown as EnhancedAgentLoop;

      const messages = [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ];
      const events = await collect(runViaUnifiedLoop(loop, messages));
      expect(capturedInput).toBe('第二问');
      expect(capturedContext).toHaveLength(2);
      expect(capturedContext[0]).toMatchObject({ role: 'user', content: '第一问' });
      expect(capturedContext[1]).toMatchObject({ role: 'assistant', content: '第一答' });
      expect(events[0].content).toContain('input=第二问');
      expect(events[0].content).toContain('ctxLen=2');
    });
  });

  describe('错误处理', () => {
    it('loop.run() 抛异常时输出错误 chunk', async () => {
      // 使用 timeout 关键词 — errMsg 会将其映射为"操作超时，请稍后重试"
      const loop = createMockLoop([], { type: 'completed', summary: 'never' } as TerminalReason, {
        throwOnRun: new Error('loop timeout'),
      });
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toMatch(/统一主循环出错/);
      expect(events[0].content).toContain('操作超时');
    });

    it('TerminalReason 为 error 时输出错误 chunk', async () => {
      const loop = createMockLoop(
        [{ type: 'text', content: '部分响应' }],
        { type: 'error', error: 'API 调用失败', recoverable: true },
      );
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toBe('部分响应');
      expect(events[1].type).toBe('chunk');
      expect(events[1].content).toContain('API 调用失败');
    });

    it('TerminalReason 为 completed 且 summary 与已输出文本相同时不输出额外 chunk', async () => {
      // summary === lastTextContent → guardrail 未修改 → 不输出额外 chunk（去重路径）
      const loop = createMockLoop(
        [{ type: 'text', content: '完成' }],
        { type: 'completed', summary: '完成' },
      );
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('完成');
    });
  });

  describe('端到端流式行为', () => {
    it('混合事件序列按顺序输出', async () => {
      const loop = createMockLoop([
        { type: 'think', content: '思考1' },
        { type: 'plan', content: '计划', plan: {} },
        { type: 'tool_call', content: '调用 X', toolName: 'X', toolArgs: {} },
        { type: 'tool_result', content: 'X 结果', toolName: 'X' },
        { type: 'text', content: '回答1' },
        { type: 'text', content: '回答2' },
        { type: 'state', content: 'internal', state: mockState },
      ], { type: 'completed', summary: '回答2' });

      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events.map(e => e.type)).toEqual([
        'think', 'plan', 'tool_call', 'tool_result', 'chunk', 'chunk',
      ]);
      expect(events.map(e => e.content)).toEqual([
        '思考1', '计划', '调用 X', 'X 结果', '回答1', '回答2',
      ]);
    });
  });

  describe('guardrail 增量输出（P0-4/#5）', () => {
    it('summary 在已输出文本后追加内容时，仅输出增量部分', async () => {
      // guardrail 在原文本后追加了安全警告 → 仅输出追加的增量，避免重复原文本
      const loop = createMockLoop(
        [{ type: 'text', content: '回答' }],
        { type: 'completed', summary: '回答\n\n⚠️ 安全提示：已隐藏敏感信息' },
      );
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toBe('回答');
      // 第二个 chunk 仅包含增量（不含原文本，避免重复）
      expect(events[1].type).toBe('chunk');
      expect(events[1].content).toBe('\n\n⚠️ 安全提示：已隐藏敏感信息');
    });

    it('summary 与已输出文本完全不同时，输出完整 summary（带前缀）', async () => {
      // guardrail 完全替换了内容（如 critical 安全修改）→ 输出完整 summary
      const loop = createMockLoop(
        [{ type: 'text', content: '原始回答' }],
        { type: 'completed', summary: '已修复的合规内容' },
      );
      const events = await collect(runViaUnifiedLoop(loop, [{ role: 'user', content: 'hi' }]));
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('chunk');
      expect(events[0].content).toBe('原始回答');
      // 第二个 chunk 输出完整 summary（带换行前缀，标识为 guardrail 替换结果）
      expect(events[1].type).toBe('chunk');
      expect(events[1].content).toBe('\n\n已修复的合规内容');
    });
  });
});
