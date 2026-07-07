import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { brain, type IntelligentBrain } from './intelligent-brain.js';
import { executeTool, getToolDefinitionsForAPI, getOpenAITools } from './tools.js';
import { getAnthropicClient, getClientForProvider, type Provider } from './llm-clients.js';
import { executeAutonomousTask, streamText } from './autonomous-executor.js';
import { KnowledgeBase, type KnowledgeEntry } from './knowledge-base.js';
import { errMsg } from './app-context.js';
import { parseToolCallArgsResilient } from '../../core/structured-output-enforcer.js';

const VERSION = 'v19.0';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

type StreamEvent = { type: 'chunk' | 'think' | 'tool_call' | 'tool_result'; content: string; toolName?: string; toolArgs?: Record<string, unknown> };

async function* streamLLMResponse(
  messages: Message[],
  model: string,
  provider: Provider,
  customSystemPrompt?: string,
): AsyncGenerator<StreamEvent> {
  const analysis = brain.analyzeIntent(messages[messages.length - 1]?.content || '');
  yield {
    type: 'think',
    content: `🧠 思考: ${analysis.understanding}\n意图: ${analysis.intentions.join(', ')}\n置信度: ${(analysis.confidence * 100).toFixed(0)}%\n方案: ${analysis.approaches.join(' | ')}`,
  };

  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));

  try {
    if (provider === 'anthropic') {
      const client = getAnthropicClient();
      if (!client) {
        yield* streamLocalFallback(messages, analysis);
        return;
      }

      const anthropicMessages: Anthropic.MessageParam[] = apiMessages.filter(m => m.role !== 'system') as Anthropic.MessageParam[];
      const anthropicTools = getToolDefinitionsForAPI().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })) as Anthropic.Tool[];

      const maxToolRounds = 10;
      for (let round = 0; round < maxToolRounds; round++) {
        const stream = client.messages.stream({
          model: model || 'claude-3-5-sonnet-20241022',
          max_tokens: 4096,
          system: customSystemPrompt,
          messages: anthropicMessages,
          tools: anthropicTools,
        });

        let fullContent = '';
        let stopReason: string | null = null;
        const toolResults: Array<{ name: string; id: string; input: string }> = [];

        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const block = (event as Anthropic.ContentBlockStartEvent).content_block;
            if (block?.type === 'tool_use') {
              toolResults.push({ name: block.name, id: block.id, input: '' });
            }
          } else if (event.type === 'content_block_delta') {
            const delta = (event as Anthropic.ContentBlockDeltaEvent).delta;
            if (delta?.type === 'text_delta') {
              fullContent += delta.text;
              yield { type: 'chunk', content: delta.text };
            } else if (delta?.type === 'input_json_delta') {
              if (toolResults.length > 0) {
                toolResults[toolResults.length - 1].input += delta.partial_json as string;
              }
            }
          } else if (event.type === 'message_delta') {
            const msgDelta = (event as Anthropic.MessageDeltaEvent).delta;
            if (msgDelta?.stop_reason) {
              stopReason = msgDelta.stop_reason;
            }
          }
        }

        if (stopReason === 'tool_use' && toolResults.length > 0) {
          const toolUseBlocks = toolResults.map(tr => ({
            type: 'tool_use' as const,
            id: tr.id,
            name: tr.name,
            input: parseToolCallArgsResilient(tr.input || '{}'),
          }));

          const assistantContent: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [{ type: 'text' as const, text: fullContent || '继续...' }, ...toolUseBlocks];
          anthropicMessages.push({ role: 'assistant', content: assistantContent } as Anthropic.MessageParam);

          const allToolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tr of toolResults) {
            let toolArgs: Record<string, unknown> = {};
            toolArgs = parseToolCallArgsResilient(tr.input || '{}', tr.name);
            yield { type: 'tool_call', content: `调用工具: ${tr.name}`, toolName: tr.name, toolArgs };
            const result = await executeTool(tr.name, toolArgs);
            yield { type: 'tool_result', content: result, toolName: tr.name };
            allToolResults.push({ type: 'tool_result' as const, tool_use_id: tr.id, content: result });
          }
          anthropicMessages.push({ role: 'user', content: allToolResults } as Anthropic.MessageParam);
        } else {
          break;
        }
      }
    } else {
      let client: OpenAI | null = null;
      const apiModel = model;

      client = getClientForProvider(provider) as OpenAI | null;

      if (!client) {
        console.info('[streamLLMResponse] 无可用的OpenAI兼容客户端，切换到本地引擎');
        yield* streamLocalFallback(messages, analysis);
        return;
      }

      // I-2：改用 getOpenAITools() — 注入 registry 时委托 registry（含全部已注册工具）
      const openaiTools = getOpenAITools();

      const reactMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string }> = [
        ...(customSystemPrompt ? [{ role: 'system' as const, content: customSystemPrompt }] : []),
        ...apiMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ];

      const maxToolRounds = 10;
      for (let round = 0; round < maxToolRounds; round++) {
        const stream = await client.chat.completions.create({
          model: apiModel,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: reactMessages as any,
          tools: openaiTools,
          tool_choice: 'auto',
          stream: true,
          max_tokens: 4096,
          temperature: 0.7,
        });

        let fullContent = '';
        const accumulatedToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const finishReason = chunk.choices[0]?.finish_reason;

          if (delta?.content) {
            fullContent += delta.content;
            yield { type: 'chunk', content: delta.content };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index;
              if (!accumulatedToolCalls.has(index)) {
                accumulatedToolCalls.set(index, { id: tc.id || '', name: tc.function?.name || '', args: '' });
              }
              const entry = accumulatedToolCalls.get(index)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }

          if (finishReason === 'tool_calls') {
            break;
          }
        }

        if (accumulatedToolCalls.size > 0) {
          const toolCalls = Array.from(accumulatedToolCalls.values()).map(tc => ({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args },
          }));

          reactMessages.push({
            role: 'assistant',
            content: fullContent || null,
            tool_calls: toolCalls,
          });

          for (const tc of toolCalls) {
            let toolArgs: Record<string, unknown> = {};
            toolArgs = parseToolCallArgsResilient(tc.function.arguments || '{}', tc.function.name);
            yield { type: 'tool_call', content: `调用工具: ${tc.function.name}`, toolName: tc.function.name, toolArgs };
            const result = await executeTool(tc.function.name, toolArgs);
            yield { type: 'tool_result', content: result, toolName: tc.function.name };
            reactMessages.push({ role: 'tool', content: result, tool_call_id: tc.id });
          }
        } else {
          if (!fullContent && round === 0) {
            yield* streamLocalFallback(messages, analysis);
          }
          return;
        }
      }
    }
  } catch (err) {
    const errorMsg = errMsg(err);
    console.error('❌ streamLLMResponse 错误:', errorMsg);
    console.error('❌ 错误堆栈:', err);
    yield { type: 'chunk', content: `\n\n⚠️ API调用出错: ${errorMsg}\n\n正在切换到本地引擎...` };
    yield* streamLocalFallback(messages, analysis);
  }
}

async function* streamLocalFallback(
  messages: Message[],
  analysis: ReturnType<IntelligentBrain['analyzeIntent']>,
  kb?: KnowledgeBase,
): AsyncGenerator<StreamEvent> {
  console.info('🔄 切换到本地引擎模式');
  const lastMsg = messages[messages.length - 1]?.content || '';
  const lowerMsg = lastMsg.toLowerCase();

  if (/^(你好|您好|hi|hello|hey|嗨)/i.test(lastMsg)) {
    yield { type: 'think', content: `🧠 识别: 问候 | 意图: ${analysis.intentions.join('、')}` };
    const greeting = `您好！我是段先生 ${VERSION}，您的超级智能助手！🧠

**我能真正执行的任务：**

| 能力 | 示例 |
|------|------|
| 💻 写代码并运行 | "写一个JavaScript计算器" |
| 🔍 真实网络搜索 | "搜索AI最新发展" |
| 📂 文件操作 | "读取package.json" |
| 📁 目录浏览 | "列出项目文件" |
| 🔢 数学计算 | "计算斐波那契数列" |
| 📝 创建文件 | "创建一个README.md" |
| 🌐 网页抓取 | "抓取百度首页" |
| ⚡ 执行命令 | "查看git status" |

🎯 给我一个指令，我会**自动规划、执行并展示结果**！`;
    yield* streamText(greeting);
    return;
  }

  if (/记得|回忆|之前|上次|过去|历史/.test(lowerMsg)) {
    if (kb) {
      const knowledge = kb.search(lastMsg);
      if (knowledge.length > 0) {
        yield { type: 'think', content: `🧠 知识库检索: 找到${knowledge.length}条相关记录` };
        const result = knowledge.map((k: KnowledgeEntry) => `📚 ${k.topic}\n${k.content.substring(0, 300)}`).join('\n\n');
        yield* streamText(`📚 **知识库记录：**\n\n${result}`);
      } else {
        yield* streamText('📚 知识库中暂无相关记录。继续使用，我会积累更多知识！');
      }
    } else {
      yield* streamText('📚 知识库未初始化');
    }
    return;
  }

  if (kb) {
    yield* executeAutonomousTask(lastMsg, analysis, kb);
  } else {
    yield* executeAutonomousTask(lastMsg, analysis, new KnowledgeBase(''));
  }
}

export { streamLLMResponse };
