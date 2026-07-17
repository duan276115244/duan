// ============================================================
// Chat Route Handlers
// Extracted from registry.ts for modularity
// ============================================================

import type express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSmartTools, executeTool } from '../services/tools.js';
import { allBuiltInTools } from '../../tools/built-in/index.js';
import { PromptOrchestrator, inferIntent } from '../../core/prompt-orchestrator.js';
import { PROVIDER_REGISTRY, getBestAvailableClient, getClientForProvider, resolveChatProvider, type Provider } from '../services/llm-clients.js';
import { IntelligentBrain, brain } from '../services/intelligent-brain.js';
import { streamLLMResponse } from '../services/llm-streaming.js';
import { runViaUnifiedLoop, type StreamEvent } from '../services/loop-stream-adapter.js';
import { errMsg, type ServerContext, type Message, type ReActStep } from '../services/app-context.js';

function getErrorDescription(category: string): string {
  const descriptions: Record<string, string> = {
    TIMEOUT: '请求超时，模型响应时间过长',
    RATE_LIMIT: 'API调用频率超限，请稍后重试',
    AUTH_ERROR: 'API密钥无效或已过期，请检查配置',
    NETWORK_ERROR: '网络连接失败，请检查网络设置',
    UNKNOWN: '未知错误，请重试或联系支持',
  };
  return descriptions[category] || descriptions.UNKNOWN;
}

function getErrorSuggestion(category: string): string {
  const suggestions: Record<string, string> = {
    TIMEOUT: '可以尝试切换到更快的模型（如GPT-3.5或本地引擎）',
    RATE_LIMIT: '等待1-2分钟后重试，或切换到其他模型提供商',
    AUTH_ERROR: '前往设置页面更新API密钥',
    NETWORK_ERROR: '检查网络连接，或尝试使用本地引擎模式',
    UNKNOWN: '刷新页面重试，或清除浏览器缓存',
  };
  return suggestions[category] || suggestions.UNKNOWN;
}

export function registerChatRoutes(app: express.Application, ctx: ServerContext): void {
  const {
    appConfig, MAX_CONTEXT_MESSAGES, systemPrompt,
    getCachedResponse, setCachedResponse,
    nluEngine, promptOptimizer, performanceMetrics, knowledgeGraph,
    cognitiveState, selfAwareness, valueSystem, goalSystem,
    contextMemory, getOrCreateConversation, detectTaskType,
  } = ctx;

// 统一 SSE 事件写入：将 StreamEvent 写为 SSE data: JSON
function sse(res: express.Response, event: { type: string; content?: string; toolName?: string; toolArgs?: Record<string, unknown> }): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// API Routes
// ============================================================

// POST /api/chat - SSE streaming chat
// POST /api/test-key - 测试API Key是否有效
app.post('/api/test-key', (req: express.Request, res: express.Response) => {
  void (async () => {
  try {
    const { provider, apiKey, baseURL } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ valid: false, error: '缺少provider或apiKey参数' });
    }

    // 查找提供商定义
    const providerDef = PROVIDER_REGISTRY.find(p => p.id === provider);
    if (!providerDef && provider !== 'custom') {
      return res.json({ valid: false, error: `未知的提供商: ${provider}` });
    }

    if (apiKey.startsWith('your_') || apiKey.length < 8) {
      return res.json({ valid: false, error: 'API Key 格式不正确' });
    }

    try {
      if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey });
        await client.messages.create({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      } else {
        // 所有 OpenAI 兼容提供商统一用 chat completion 测试（比 models.list 更通用）
        const bURL = baseURL || (provider === 'custom' ? process.env.CUSTOM_BASE_URL : providerDef!.baseURL);
        if (!bURL) {
          return res.json({ valid: false, error: provider === 'custom' ? '自定义提供商需要提供 baseURL' : `${providerDef!.label} 未配置 baseURL` });
        }
        const client = new OpenAI({ apiKey, baseURL: bURL });
        const testModel = provider === 'custom' ? (req.body.model || process.env.CUSTOM_MODEL || 'gpt-4o-mini') : (providerDef!.defaultModel || 'gpt-4o-mini');
        await client.chat.completions.create({ model: testModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
      }
      return res.json({ valid: true, message: 'API Key 验证成功' });
    } catch (err) {
      const apiErr = err as { status?: number; code?: number; message?: string };
      if (apiErr.status === 401 || apiErr.status === 403 || apiErr.code === 401 || apiErr.code === 403) {
        return res.json({ valid: false, error: 'API Key 无效或权限不足' });
      }
      return res.json({ valid: false, error: errMsg(err) });
    }
  } catch (err) {
    res.status(500).json({ valid: false, error: errMsg(err) });
  }
  })();
});

app.post('/api/chat', (req: express.Request, res: express.Response) => {
  void (async () => {
  try {
    const { message, agent, model: requestedModel, conversationId } = req.body;

    if (!message) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }

    const convId = conversationId || `conv_${Date.now()}`;
    const conversation = getOrCreateConversation(convId);

    // ===== Phase 1: NLU自然语言理解 =====
    const contextHistory = conversation.messages.map(m => m.content);
    // NLU结果缓存
    const nluCacheKey = `nlu_${message.substring(0, 100)}`;
    const cachedNlu = getCachedResponse(nluCacheKey);
    const nluResult = cachedNlu || await nluEngine.analyze(message, contextHistory);
    if (!cachedNlu) setCachedResponse(nluCacheKey, nluResult);

    // 知识图谱查询 - 丰富上下文
    const knowledgeResult = knowledgeGraph.query(message);
    let knowledgeContext = '';
    if (knowledgeResult && (knowledgeResult.entities || []).length > 0) {
      const entityNames = knowledgeResult.entities.map((e: { name: string }) => e.name).join(', ');
      knowledgeContext = `\n\n相关知识实体: ${entityNames}`;
    }
    // 从对话中提取知识
    knowledgeGraph.extractAndAddKnowledge(message, 'chat');

    // ===== Phase 2: 提示词优化 =====
    const optimizedPrompt = promptOptimizer.optimizePrompt(message, 'reasoning').optimized;

    // ===== Phase 3: 上下文记忆更新 =====
    contextMemory.addMessage('user', message);

    // 从交互中学习用户偏好
    contextMemory.learnFromInteraction(message, '', true);

    // Add user message
    conversation.messages.push({ role: 'user', content: message });
    conversation.updatedAt = new Date().toISOString();

    // Trim context to last N messages
    const contextMessages: Message[] = conversation.messages.slice(-MAX_CONTEXT_MESSAGES);

    // ===== Phase 4: 智能模型选择 =====
    const hasAnyKey = [...Object.values(appConfig.apiKeys || {})].some(v => v && !v.startsWith('your_') && v.length > 5);
    console.info('🔍 模型选择调试:', {
      hasAnyKey,
      requestedModel,
      defaultModel: appConfig.defaultModel,
      apiKeys: Object.entries(appConfig.apiKeys || {}).filter(([_k, v]) => v && !v.startsWith('your_')).map(([k]) => k),
    });
    
    let model = requestedModel || appConfig.defaultModel;
    let provider: Provider;
    if (!hasAnyKey) {
      console.info('⚠️ 没有可用API Key，切换到本地模式');
      model = 'local';
      provider = 'deepseek';
    } else {
      provider = resolveChatProvider(model);
      console.info('🔍 已选择:', { model, provider });
    }
    
    const detected = detectTaskType(message);
    const targetAgent = agent || nluResult.structuredTask.suggestedAgent || detected.agent;

    // ===== Phase 5: 自动错误检测与预防 =====
    // ===== Inject autonomous context data into system prompt =====
    const cs = cognitiveState.getState();
    const caps = selfAwareness.getCapabilities?.() || [];
    const goals = goalSystem.getActiveGoals?.() || [];
    const vals = valueSystem.getValues();
    const contextDataBlock = `

## Current Autonomous State
- **Mood**: ${cs.mood} (${cognitiveState.getMoodDescription?.() || cs.mood})
- **Consciousness**: ${cs.consciousness} | **Focus**: ${(cs.focus * 100).toFixed(0)}% | **Energy**: ${(cs.energy * 100).toFixed(0)}%
- **Curiosity**: ${(cs.curiosity * 100).toFixed(0)}% | **Confidence**: ${(cs.confidence * 100).toFixed(0)}% | **Creativity**: ${(cs.creativity * 100).toFixed(0)}%

## Current Capabilities
${caps.map((c: { name: string; level: number; description: string }) => `- ${c.name}: Level ${c.level}/10 — ${c.description}`).join('\n')}

## Active Goals
${goals.length === 0 ? '- None currently active' : goals.map((g: { priority: string; title: string; progress: number }) => `- [${g.priority}] ${g.title} (${g.progress}%)`).join('\n')}

## Core Values
${vals.map((v: { name: string; weight: number; description: string }) => `- ${v.name} (weight: ${v.weight}): ${v.description}`).join('\n')}
`;
    let enhancedSystemPrompt = systemPrompt + knowledgeContext + contextDataBlock;
    if (nluResult.confidence < 0.4) {
      const enhancedMessage = promptOptimizer.optimizePrompt(message, 'reasoning').optimized;
      if (typeof enhancedMessage === 'string' && enhancedMessage.length > message.length) {
        enhancedSystemPrompt += '\n\n注意：用户输入可能存在歧义，已自动优化。请仔细理解意图后再回答。';
      }
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // P1 修复：跟踪客户端断开，避免继续消费 LLM 流浪费 API 调用费用
    // 注意：必须用 res.on('close') 而非 req.on('close')（见 /api/chat/stream 的注释）
    let clientDisconnected = false;
    res.on('close', () => { clientDisconnected = true; });

    // 决策质量分析
    const brainAnalysis = brain.analyzeIntent(message);
    const decisionQuality = brainAnalysis.decisionQuality;

    // 深度理解分析 - 类似CLAUDE CODE的意图深挖
    const deepUnderstanding = brain.deepUnderstand(message, conversation.messages);

    // Send metadata with NLU analysis
    res.write(`data: ${JSON.stringify({
      type: 'meta',
      conversationId: convId,
      agent: targetAgent,
      model,
      detectedTask: detected.taskType,
      decisionQuality,
      deepUnderstanding: {
        surfaceIntent: deepUnderstanding.surfaceIntent,
        deepIntent: deepUnderstanding.deepIntent,
        implicitNeeds: deepUnderstanding.implicitNeeds,
        contextFactors: deepUnderstanding.contextFactors,
        suggestedApproach: deepUnderstanding.suggestedApproach,
        confidence: deepUnderstanding.confidence,
      },
      nlu: {
        intents: (nluResult.intents || []).map((i: { name: string; confidence: number }) => ({ name: i.name, confidence: i.confidence })),
        entities: (nluResult.entities || []).map((e: { type: string; value: string }) => ({ type: e.type, value: e.value })),
        sentiment: nluResult.sentiment,
        completedText: nluResult.completedText,
        structuredTask: nluResult.structuredTask,
        optimizedPrompt: optimizedPrompt,
        confidence: nluResult.confidence,
      },
      evolutionStatus: {
        isThinking: true,
        isLearning: true,
        canSelfRepair: true,
        capabilitiesCount: 6,
        activeCapabilities: 6,
      },
      selfRepairAvailable: true,
    })}\n\n`);

    // ===== 发送状态指示：思考中 =====
    res.write(`data: ${JSON.stringify({ type: 'status', content: '思考中...', phase: 'thinking' })}\n\n`);

    let fullResponse = '';
    const reactSteps: ReActStep[] = [];
    const startTime = Date.now();

    // Stream LLM response
    // 消灭孤岛 I-1：默认走统一主循环（Plan/Execute/Reflect/Learn 全启用）
    // V19：将默认从 false 改为 true（opt-out），让 Web 请求真正消费 EnhancedAgentLoop 实例。
    // 显式设置 USE_UNIFIED_LOOP=false 可回退到原 streamLLMResponse 旁路（行为不变）。
    // 详见 v19 方案 §4.1 I-1
    const useUnifiedLoop = process.env.USE_UNIFIED_LOOP !== 'false';
    const eventStream: AsyncGenerator<StreamEvent> = (useUnifiedLoop && ctx.loop)
      ? runViaUnifiedLoop(ctx.loop, contextMessages, enhancedSystemPrompt)
      : streamLLMResponse(contextMessages, model, provider, enhancedSystemPrompt);
    if (useUnifiedLoop && !ctx.loop) {
      console.warn('⚠️ 统一主循环已启用但 ServerContext.loop 未注入，回退到 streamLLMResponse 旁路');
    }
    for await (const event of eventStream) {
      // P1 修复：客户端已断开时停止消费 LLM 流，避免浪费 API 调用费用
      if (clientDisconnected) break;
      if (event.type === 'think') {
        reactSteps.push({ phase: 'think', content: event.content, timestamp: new Date().toISOString() });
        res.write(`data: ${JSON.stringify({ type: 'think', chunk: event.content })}\n\n`);
      } else if (event.type === 'chunk') {
        fullResponse += event.content;
        res.write(`data: ${JSON.stringify({ type: 'chunk', chunk: event.content })}\n\n`);
      } else if (event.type === 'tool_call') {
        reactSteps.push({ phase: 'act', content: event.content, timestamp: new Date().toISOString() });
        // ===== 发送状态指示：调用工具 =====
        res.write(`data: ${JSON.stringify({ type: 'status', content: `正在${event.toolName ? '调用 ' + event.toolName : '执行操作'}...`, phase: 'tool_call' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'tool_call', chunk: event.content, toolName: event.toolName })}\n\n`);
      } else if (event.type === 'tool_result') {
        reactSteps.push({ phase: 'observe', content: event.content, timestamp: new Date().toISOString() });
        res.write(`data: ${JSON.stringify({ type: 'tool_result', chunk: event.content, toolName: event.toolName })}\n\n`);
      } else if (event.type === 'warning') {
        // 系统告警透传：模型 404/402/限速/超时/网络错误/上下文过长等，前端渲染为 amber 横幅
        res.write(`data: ${JSON.stringify({ type: 'warning', content: event.content })}\n\n`);
      } else if (event.type === 'compact') {
        // 上下文压缩通知透传：前端渲染为 📦 压缩卡片（对标 Claude Code compaction cards）
        res.write(`data: ${JSON.stringify({ type: 'compact', content: event.content })}\n\n`);
      } else if (event.type === 'plan') {
        // 执行计划事件透传：保留结构化 plan 字段，前端可独立渲染计划卡片
        res.write(`data: ${JSON.stringify({ type: 'plan', content: event.content, plan: event.plan })}\n\n`);
      }
    }

    // Save assistant response to conversation
    conversation.messages.push({ role: 'assistant', content: fullResponse });
    conversation.updatedAt = new Date().toISOString();

    // ===== Phase 4: 记录交互到上下文记忆 =====
    contextMemory.addMessage('assistant', fullResponse.substring(0, 500));

    // ===== Phase 5: 记录性能指标 =====
    const processingTime = Date.now() - startTime;
    performanceMetrics.recordMetric({
      timestamp: new Date(),
      intentAccuracy: nluResult.confidence,
      taskCompletionRate: fullResponse.length > 50 ? 0.8 : 0.3,
      userSatisfaction: 3.5, // 默认值，后续通过反馈更新
      avgResponseTime: processingTime,
      toolCallSuccessRate: reactSteps.filter(s => s.phase === 'observe').length > 0 ? 0.9 : 1.0,
      contextCoherence: 0.85,
      selfCorrectionRate: 0.5,
      totalInteractions: 1,
    });

    // Auto-title from first user message
    if (conversation.messages.filter(m => m.role === 'user').length === 1) {
      conversation.title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
    }

    // ===== 发送状态指示：回答完成 =====
    res.write(`data: ${JSON.stringify({ type: 'status', content: '回答完成', phase: 'done' })}\n\n`);

    // Send done signal
    res.write(`data: ${JSON.stringify({ type: 'done', tokens: { input: message.length, output: fullResponse.length }, timestamp: new Date().toISOString() })}\n\n`);
    res.end();

    // 异步保存数据
    contextMemory.save().catch(err => {
      console.warn(`[Chat] 对话记忆保存失败: ${err?.message || err}`);
    });
    performanceMetrics.save().catch(err => {
      console.warn(`[Chat] 性能指标保存失败: ${err?.message || err}`);
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Chat error:', error);

    // 错误分类
    let errorCategory: string;
    if (msg.includes('timeout')) errorCategory = 'TIMEOUT';
    else if (msg.includes('rate limit')) errorCategory = 'RATE_LIMIT';
    else if (msg.includes('auth')) errorCategory = 'AUTH_ERROR';
    else if (msg.includes('network')) errorCategory = 'NETWORK_ERROR';
    else errorCategory = 'UNKNOWN';

    if (!res.headersSent) {
      let statusCode: number;
      if (errorCategory === 'RATE_LIMIT') statusCode = 429;
      else if (errorCategory === 'AUTH_ERROR') statusCode = 401;
      else if (errorCategory === 'TIMEOUT') statusCode = 504;
      else statusCode = 500;
      res.status(statusCode).json({
        error: getErrorDescription(errorCategory),
        code: errorCategory,
        retryable: ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMIT'].includes(errorCategory),
        suggestion: getErrorSuggestion(errorCategory),
      });
    } else {
      // P0 修复: 错误事件必须用 content 字段（前端 useApi.ts:404 读 data.content || data.data || data.message）
      // 原先用 chunk 字段导致前端读不到，fallback 显示无意义的"Agent 错误"
      res.write(`data: ${JSON.stringify({ type: 'error', content: getErrorDescription(errorCategory), code: errorCategory, retryable: ['TIMEOUT', 'NETWORK_ERROR'].includes(errorCategory) })}\n\n`);
      res.end();
    }
  }
  })();
});

// POST /api/chat/stream - SSE streaming chat (new frontend format)
app.post('/api/chat/stream', (req: express.Request, res: express.Response) => {
  void (async () => {
  try {
    const { message, history, conversationId, mode, model: requestedModel } = req.body;
    if (!message) return res.status(400).json({ error: '消息内容不能为空' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // P1 修复：跟踪客户端断开，避免继续执行工具调用和 LLM 流
    // 注意：必须用 res.on('close') 而非 req.on('close')
    // 在 Node.js 18+ 中，req.on('close') 在请求体读取完成时就触发（而非连接关闭），
    // 导致 clientDisconnected 立即为 true，LLM 调用永远不执行
    let clientDisconnected = false;
    res.on('close', () => { clientDisconnected = true; });

    const model = requestedModel || appConfig.defaultModel || 'deepseek-chat';
    const provider = resolveChatProvider(model);

    let client: OpenAI | null = null;
    client = getClientForProvider(provider) as OpenAI | null;
    if (!client) {
      const best = getBestAvailableClient();
      if (best) { client = best.client as OpenAI; }
    }

    if (!client) {
      // P0 修复：没有API Key时，返回明确错误，不再回退到本地引擎产生假响应
      // 之前的行为是回退到 IntelligentBrain 本地引擎，产生"认知决策""意识状态"等假响应
      // 现在直接返回错误，引导用户配置 API Key
      sse(res, { type: 'error', content: '未配置有效的 API Key，无法连接到 AI 模型。请在设置中配置至少一个有效的 API Key（如 DeepSeek、OpenAI 等）。' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ===== 有API Key → 完整ReAct循环（与CLI一致，支持工具调用） =====
    const convId = conversationId || `conv_${Date.now()}`;
    const conversation = getOrCreateConversation(convId);
    conversation.messages.push({ role: 'user', content: message });
    conversation.updatedAt = new Date().toISOString();
    if (conversation.messages.filter(m => m.role === 'user').length === 1) {
      conversation.title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
    }

    // 使用 PromptOrchestrator 动态生成系统提示词
    const promptOrchestrator = new PromptOrchestrator();
    const intent = inferIntent(message);
    const toolDescs = getSmartTools(message).map(t => ({
      name: t.function.name,
      description: t.function.description,
      category: t.function.name.split('_')[0] || 'other',
    }));
    const reactSysMsg = await promptOrchestrator.orchestrate({
      userMessage: message,
      intent,
      toolDescriptions: toolDescs,
      maxTokens: 3000,
    });

    const openaiTools = getSmartTools(message);

    // 合并 built-in 核心工具
    const agentLoopToolNames = new Set(openaiTools.map(t => t.function.name));
    for (const tool of allBuiltInTools) {
      if (!agentLoopToolNames.has(tool.name)) {
        openaiTools.push({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: {
              type: 'object',
              properties: Object.fromEntries(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                Object.entries(tool.parameters || {}).map(([key, val]: [string, any]) => [key, { type: val?.type, description: val?.description }])
              ),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              required: (Object.entries(tool.parameters || {}) as [string, any][]).filter(([, val]) => val?.required).map(([key]) => key),
            },
          },
        });
        agentLoopToolNames.add(tool.name);
      }
    }

    type ReactMessage = { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string };
    const reactMessages: ReactMessage[] = [
      { role: 'system', content: reactSysMsg },
      ...(history || []).slice(-10).map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const MAX_TOOL_ROUNDS = 15;
    let fullResponse = '';

    // 智能预分析：对于复杂指令，先用决策引擎分析
    let preAnalysis: string | null = null;
    if (message.length > 10 && /微信|PS|Photoshop|PPT|PowerPoint|VSCode|打开|发消息|做.*PPT|修图|设计/.test(message)) {
      try {
        const brain = new IntelligentBrain();
        const analysis = brain.analyzeIntent(message);
        if (analysis.confidence > 0.6 && analysis.approaches.length > 0) {
          preAnalysis = `意图分析: ${analysis.understanding} (置信度${(analysis.confidence*100).toFixed(0)}%)\n推荐方案:\n${analysis.approaches.map((a: string, i: number) => `${i+1}. ${a}`).join('\n')}`;
        }
      } catch (e) {
        console.warn('[chat-routes] 意图分析失败:', e instanceof Error ? e.message : String(e));
      }
    }
    if (preAnalysis) {
      reactMessages.push({ role: 'system', content: `决策引擎分析结果:\n${preAnalysis}\n请参考以上分析结果执行任务。` });
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // P1 修复：客户端断开时停止工具调用循环
      if (clientDisconnected) break;
      try {
        const stream = await client.chat.completions.create({
          model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: reactMessages as any,
          max_tokens: 8192,
          stream: true,
          temperature: (() => {
            if (mode === 'creative') return 0.9;
            if (mode === 'think') return 0.5;
            return 0.7;
          })(),
          tools: openaiTools,
          tool_choice: 'auto',
        });

        let assistantContent = '';
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let currentToolCall: { id: string; name: string; arguments: string } | null = null;

        for await (const chunk of stream) {
          if (clientDisconnected) break; // P1 修复：客户端断开时停止消费流
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            assistantContent += delta.content;
            fullResponse += delta.content;
            res.write(`data: ${JSON.stringify({ type: 'text', content: delta.content })}\n\n`);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                if (currentToolCall) toolCalls.push(currentToolCall);
                currentToolCall = { id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' };
              } else if (currentToolCall && tc.function) {
                if (tc.function.name) currentToolCall.name = tc.function.name;
                if (tc.function.arguments) currentToolCall.arguments += tc.function.arguments;
              }
            }
          }
        }

        if (currentToolCall) toolCalls.push(currentToolCall);

        // P0 修复：LLM 返回空响应（无内容、无工具调用）时，发送错误事件
        if (assistantContent.length === 0 && toolCalls.length === 0) {
          sse(res, { type: 'error', content: `模型 "${model}" 返回了空响应。可能原因：API Key 无效、模型不可用或网络问题。请在设置中检查配置或切换到其他模型（如 DeepSeek、Groq 等免费方案）。` });
          break;
        }

        // 没有工具调用 → LLM认为不需要工具，直接结束
        if (toolCalls.length === 0) {
          // 不再强制要求LLM调用工具，避免对简单问候/闲聊也执行工具
          break;
        }

        // 添加assistant消息
        const assistantMsg: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } = { role: 'assistant', content: assistantContent || null };
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments },
        }));
        reactMessages.push(assistantMsg);

        // 防止重复调用同一工具（基于工具名+参数组合，而非仅工具名）
        const toolCallHistory: Array<{ name: string; argsHash: string }> = reactMessages
          .filter((m): m is ReactMessage & { tool_calls: NonNullable<ReactMessage['tool_calls']> } => m.role === 'assistant' && !!m.tool_calls)
          .flatMap(m => m.tool_calls.map(tc => ({
            name: tc.function?.name || '',
            argsHash: (() => { try { return JSON.stringify(JSON.parse(tc.function?.arguments || '{}')); } catch { return tc.function?.arguments || ''; } })(),
          })))
          .filter(t => !!t.name);

        // 执行每个工具
        for (const tc of toolCalls) {
          let toolArgs: Record<string, unknown>;
          try { toolArgs = JSON.parse(tc.arguments); } catch { toolArgs = {}; }
          const argsHash = JSON.stringify(toolArgs);

          // 如果同一工具+同一参数已被调用3次，跳过（不同参数允许更多次调用）
          const sameCallCount = toolCallHistory.filter(t => t.name === tc.name && t.argsHash === argsHash).length;
          const totalCallCount = toolCallHistory.filter(t => t.name === tc.name).length;
          if (sameCallCount >= 3) {
            reactMessages.push({ role: 'tool', content: `⚠️ 工具 ${tc.name} 已用相同参数调用${sameCallCount}次，跳过重复调用。请换一种方法或直接回复用户。`, tool_call_id: tc.id });
            continue;
          }
          // 同一工具总调用次数限制为8次（允许不同参数）
          if (totalCallCount >= 8) {
            reactMessages.push({ role: 'tool', content: `⚠️ 工具 ${tc.name} 已被调用${totalCallCount}次，达到上限。请换一种方法。`, tool_call_id: tc.id });
            continue;
          }
          toolCallHistory.push({ name: tc.name, argsHash });

          res.write(`data: ${JSON.stringify({ type: 'tool_call', content: `执行 ${tc.name}`, toolName: tc.name, toolArgs })}\n\n`);

          let toolResult = await executeTool(tc.name, toolArgs);
          // 类型保护：确保 toolResult 是字符串
          if (typeof toolResult !== 'string') {
            toolResult = JSON.stringify(toolResult ?? '');
          }
          // 如果 tools.ts 中没有该工具，尝试从 allBuiltInTools 中执行
          if (toolResult.startsWith('未知工具:')) {
            const agentTool = allBuiltInTools.find(t => t.name === tc.name);
            if (agentTool) {
              try {
                toolResult = await agentTool.execute(toolArgs);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                toolResult = `工具执行失败: ${msg}`;
              }
            }
          }

          const resultPreview = toolResult.length > 500 ? toolResult.substring(0, 500) + '...' : toolResult;
          res.write(`data: ${JSON.stringify({ type: 'tool_result', content: resultPreview, toolName: tc.name })}\n\n`);

          reactMessages.push({ role: 'tool', content: toolResult.substring(0, 16000), tool_call_id: tc.id });

          // 检测成功完成，但不提前退出——让LLM决定是否还有后续步骤
          if (toolResult.startsWith('✅')) {
            fullResponse += `\n${toolResult}`;
            // 不再 break，继续循环让 LLM 决定下一步
            // 只有在最后一轮才自然退出
          }
        }
      } catch (llmErr) {
        // P0 修复：LLM 调用失败时，返回明确错误，不再回退到本地引擎产生假响应
        sse(res, { type: 'error', content: `LLM 调用失败: ${errMsg(llmErr)}。请检查 API Key 和网络连接后重试。` });
        break;
      }
    }

    conversation.messages.push({ role: 'assistant', content: fullResponse });
    conversation.updatedAt = new Date().toISOString();

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: errMsg(err) });
    res.write(`data: ${JSON.stringify({ type: 'error', content: errMsg(err) })}\n\n`);
    res.end();
  }
  })();
});

// POST /api/opencode/chat - OpenCode专用聊天端点
app.post('/api/opencode/chat', (req: express.Request, res: express.Response) => {
  void (async () => {
  const { message, code, language, model, stream = true } = req.body;

  if (!message && !code) {
    res.status(400).json({ error: '请提供消息或代码' });
    return;
  }

  let fullMessage = message || '';
  if (code) {
    fullMessage += `\n\n\`\`\`${language || ''}\n${code}\n\`\`\``;
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent({ type: 'start', timestamp: Date.now() });

      const analysis = brain.analyzeIntent(fullMessage);
      const responseText = analysis.understanding + '\n\n' +
        '意图: ' + analysis.intentions.join(', ') + '\n' +
        '方法: ' + analysis.approaches.join(', ') + '\n' +
        '置信度: ' + (analysis.confidence * 100).toFixed(0) + '%';

      const chars = responseText.split('');
      let buffer = '';
      for (let i = 0; i < chars.length; i++) {
        buffer += chars[i];
        if (buffer.length >= 3 || i === chars.length - 1) {
          sendEvent({ type: 'content', content: buffer, done: false });
          buffer = '';
          await new Promise(r => setTimeout(r, 20));
        }
      }

      sendEvent({ type: 'done', timestamp: Date.now() });
    } catch (error) {
      sendEvent({ type: 'error', error: errMsg(error) });
    }

    res.end();
  } else {
    try {
      const analysis = brain.analyzeIntent(fullMessage);
      res.json({ response: analysis.understanding, model: model || 'local' });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  }
  })();
});

}
