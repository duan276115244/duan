/** 5 阶段上下文压缩管道 */
import type OpenAI from 'openai';
import { callLLMWithRecovery } from './query-engine-singleton.js';

export type PipelineStage = 'budget' | 'snip' | 'micro' | 'collapse' | 'auto';

export interface PipelineResult {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  stats: {
    beforeCount: number;
    afterCount: number;
    beforeTokens: number;
    afterTokens: number;
    stagesApplied: PipelineStage[];
  };
}

export class CompressionPipeline {
  private llmClient: { client: OpenAI; model: string } | null = null;

  setLLMClient(client: { client: OpenAI; model: string } | null): void {
    this.llmClient = client;
  }

  async compress(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    budget: number,
    compactCount: number,
  ): Promise<PipelineResult> {
    const beforeCount = messages.length;

    // 按消息缓存 token 数，避免每个阶段后全量重算 O(总字符数)
    const tokenCache = new WeakMap<object, number>();
    const tokensOf = (msg: OpenAI.Chat.ChatCompletionMessageParam): number => {
      const key = msg as unknown as object;
      let t = tokenCache.get(key);
      if (t === undefined) {
        t = this.estimateTokens([msg]);
        tokenCache.set(key, t);
      }
      return t;
    };
    const sumTokens = (msgs: OpenAI.Chat.ChatCompletionMessageParam[]): number => {
      let total = 0;
      for (const m of msgs) total += tokensOf(m);
      return total;
    };

    const beforeTokens = sumTokens(messages);
    const stagesApplied: PipelineStage[] = [];

    let current = [...messages];
    let tokens = beforeTokens;

    // Stage 1: Budget — 判断是否需要压缩 (lowered threshold from 0.8 to 0.5 for earlier compression)
    if (tokens <= budget * 0.5) {
      return {
        messages: current,
        stats: { beforeCount, afterCount: beforeCount, beforeTokens, afterTokens: tokens, stagesApplied },
      };
    }
    stagesApplied.push('budget');

    // Stage 2: Snip — 移除低价值消息
    const afterSnip = this.stageSnip(current);
    if (afterSnip.length < current.length) {
      stagesApplied.push('snip');
      current = afterSnip;
      tokens = sumTokens(current);
    }

    // Stage 3: Micro — 截断长消息
    const afterMicro = this.stageMicroCompact(current);
    if (afterMicro !== current) {
      stagesApplied.push('micro');
      current = afterMicro;
      tokens = sumTokens(current);
    }

    // Stage 4: Collapse — 合并连续同类消息 (lowered threshold from 0.8 to 0.5)
    if (tokens > budget * 0.5) {
      const afterCollapse = this.stageCollapse(current);
      if (afterCollapse.length < current.length) {
        stagesApplied.push('collapse');
        current = afterCollapse;
        tokens = sumTokens(current);
      }
    }

    // Stage 5: Auto — 摘要压缩 (lowered threshold from 0.8 to 0.5)
    if (tokens > budget * 0.5) {
      stagesApplied.push('auto');
      const summaryMsg = await this.createSummaryMessage(current, compactCount);
      current = [summaryMsg, ...current.slice(-4)];
      tokens = sumTokens(current);
    }

    const afterCount = current.length;
    return {
      messages: current,
      stats: { beforeCount, afterCount, beforeTokens, afterTokens: tokens, stagesApplied },
    };
  }

  private stageSnip(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    let lastRole = '';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = typeof msg.content === 'string' ? msg.content : '';

      // 移除空消息
      if (!content && !('tool_calls' in msg)) continue;

      // 移除工具调用的空结果
      if (msg.role === 'tool' && (!content || content.length < 5)) continue;

      if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
        const isEmptyCall = (msg.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>).every(
          (tc) => !tc.function?.name && !tc.function?.arguments,
        );
        if (isEmptyCall) continue;
      }

      // 移除连续的重复角色（保留第一个）
      if (msg.role === 'system' && lastRole === 'system') continue;

      // 保留最新 N 条工具结果
      result.push(msg);
      if (msg.role !== 'system') lastRole = msg.role;
    }

    return result;
  }

  private stageMicroCompact(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content) return msg;

      // 截断极大工具结果
      if (msg.role === 'tool' && content.length > 1500) {
        const lines = content.split('\n');
        const head = lines.slice(0, 10).join('\n');
        const tail = lines.slice(-5).join('\n');
        return { ...msg, content: `${head}\n\n... (中间 ${lines.length - 15} 行已省略) ...\n\n${tail}` };
      }

      // 截断过长助手消息
      if (msg.role === 'assistant' && content.length > 4000 && !msg.tool_calls) {
        return { ...msg, content: content.substring(0, 2000) + '\n\n...(截断)...' };
      }

      return msg;
    });
  }


  private stageCollapse(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    const toolBuffer: string[] = [];
    let toolCallId = '';

    const flushTools = () => {
      if (toolBuffer.length === 0) return;
      if (toolBuffer.length === 1) {
        result.push({ role: 'tool', tool_call_id: toolCallId, content: toolBuffer[0] });
      } else {
        result.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: `📋 合并 ${toolBuffer.length} 个工具结果:\n${toolBuffer.join('\n---\n').substring(0, 2000)}`,
        });
      }
      toolBuffer.length = 0;
    };

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';

      if (msg.role === 'tool') {
        toolBuffer.push(content.substring(0, 800));
        toolCallId = msg.tool_call_id || toolCallId;
        continue;
      }

      flushTools();
      result.push(msg);
    }
    flushTools();

    return result;
  }

  private async createSummaryMessage(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    compactCount: number,
  ): Promise<OpenAI.Chat.ChatCompletionSystemMessageParam> {
    const oldMessages = messages.slice(0, -4);

    // 尝试使用 LLM 生成结构化摘要
    if (this.llmClient) {
      try {
        const conversationText = this.formatMessagesForSummary(oldMessages);
        const summary = await this.generateLLMSummary(conversationText);
        return {
          role: 'system',
          content: `📋 以下为第 ${compactCount + 1} 次压缩后的历史摘要（保留最近的完整对话）：\n\n${summary}`,
        };
      } catch {
        // LLM 调用失败，降级到规则摘要
      }
    }

    // 改进版规则摘要（无 LLM 时）
    const summary = this.generateRuleBasedSummary(oldMessages);
    return {
      role: 'system',
      content: `📋 以下为第 ${compactCount + 1} 次压缩后的历史摘要（保留最近的完整对话）：\n\n${summary}`,
    };
  }

  /** 将消息格式化为供 LLM 摘要使用的文本 */
  private formatMessagesForSummary(messages: OpenAI.Chat.ChatCompletionMessageParam[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content) continue;

      if (msg.role === 'user') {
        lines.push(`【用户】${content.substring(0, 500)}`);
      } else if (msg.role === 'assistant') {
        if ('tool_calls' in msg && msg.tool_calls) {
          const calls = (msg.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>)
            .map((tc) => `${tc.function?.name}(${(tc.function?.arguments || '').substring(0, 200)})`)
            .join(', ');
          lines.push(`【助手-工具调用】${calls}`);
        } else {
          lines.push(`【助手】${content.substring(0, 500)}`);
        }
      } else if (msg.role === 'tool') {
        lines.push(`【工具结果】${content.substring(0, 300)}`);
      } else if (msg.role === 'system') {
        lines.push(`【系统】${content.substring(0, 200)}`);
      }
    }
    return lines.join('\n');
  }

  /** 使用 LLM 生成结构化摘要 */
  private async generateLLMSummary(conversationText: string): Promise<string> {
    if (!this.llmClient) throw new Error('No LLM client');

    const prompt = `请对以下对话历史生成简洁的结构化摘要，保留关键信息：

1. 任务目标：用户想要完成什么
2. 已完成步骤：已经做了哪些操作
3. 关键决策：做出了哪些重要选择
4. 待处理事项：还有什么需要做的
5. 重要上下文：文件路径、变量名、配置等关键信息

对话历史：
${conversationText}

请用简洁的中文输出摘要，不超过 200 字。`;

    const response = await callLLMWithRecovery(
      this.llmClient.client,
      {
        model: this.llmClient.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.3,
      },
      {},
      this.llmClient.model,
    );

    return response.choices[0]?.message?.content?.trim() || '';
  }

  /** 改进版规则摘要（无 LLM 时的降级方案） */
  private generateRuleBasedSummary(messages: OpenAI.Chat.ChatCompletionMessageParam[]): string {
    const userIntents: string[] = [];
    const toolResults: string[] = [];
    const assistantConclusions: string[] = [];

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content) continue;

      if (msg.role === 'user') {
        // 提取用户关键意图，去掉寒暄和重复
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        const intentLine = lines.find(l => !/^(你好|谢谢|好的|嗯|ok|hi|hello)[\s!！。.]*$/i.test(l.trim()));
        if (intentLine) {
          const intent = intentLine.trim().substring(0, 120);
          if (!userIntents.some(existing => existing === intent)) {
            userIntents.push(intent);
          }
        }
      } else if (msg.role === 'assistant' && !('tool_calls' in msg)) {
        // 提取助手回复的关键结论（取首行和末行）
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > 0) {
          const conclusion = lines[0].trim().substring(0, 100);
          if (conclusion && !assistantConclusions.includes(conclusion)) {
            assistantConclusions.push(conclusion);
          }
        }
      } else if (msg.role === 'tool') {
        // 提取工具调用的关键结果（成功/失败 + 核心输出）
        const firstLine = content.split('\n')[0].substring(0, 80);
        const isSuccess = !/error|fail|错误|失败/i.test(firstLine);
        const status = isSuccess ? '✓' : '✗';
        const result = `${status} ${firstLine}`;
        if (!toolResults.some(existing => existing === result)) {
          toolResults.push(result);
        }
      }
    }

    const sections: string[] = [];
    if (userIntents.length > 0) {
      sections.push(`【用户意图】\n${userIntents.slice(-10).join('\n')}`);
    }
    if (assistantConclusions.length > 0) {
      sections.push(`【助手结论】\n${assistantConclusions.slice(-10).join('\n')}`);
    }
    if (toolResults.length > 0) {
      sections.push(`【工具结果】\n${toolResults.slice(-10).join('\n')}`);
    }

    return sections.join('\n\n') || '（无关键信息）';
  }

  estimateTokens(messages: OpenAI.Chat.ChatCompletionMessageParam[]): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4;
      const textContent = typeof msg.content === 'string' ? msg.content : '';
      let chineseChars = 0;
      let otherChars = 0;
      for (const ch of textContent) {
        if (ch.charCodeAt(0) > 0x4e00 && ch.charCodeAt(0) < 0x9fff) {
          chineseChars++;
        } else {
          otherChars++;
        }
      }
      tokens += Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
      if ('tool_calls' in msg && msg.tool_calls) tokens += 10;
    }
    return tokens;
  }
}
