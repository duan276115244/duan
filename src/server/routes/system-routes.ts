// ============================================================
// System Route Handlers — settings, status, setup, config,
// agents, models, tools, conversations
// ============================================================

import type express from 'express';
import path from 'path';
import { spawnSync } from 'child_process';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { tools } from '../services/tools.js';
import { PROVIDER_REGISTRY, hasValidKey, getAnthropicClient, getOpenAIClient, getDeepSeekClient, resolveProvider } from '../services/llm-clients.js';
import { errMsg, type ServerContext, type Conversation } from '../services/app-context.js';

export function registerSystemRoutes(app: express.Application, ctx: ServerContext): void {
  const {
    VERSION, appConfig, modelLibrary, conversations, MAX_CONTEXT_MESSAGES, agents,
    getCachedResponse, setCachedResponse,
    cognitiveState, selfAwareness, valueSystem: _valueSystem, goalSystem, heartbeat,
    kb, detectTaskType, saveConfig, syncConfigToModelLibrary,
  } = ctx;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
// POST /api/settings - update settings
app.post('/api/settings', (req: express.Request, res: express.Response) => {
  try {
    const { thinkingMode } = req.body;
    if (thinkingMode) {
      appConfig.settings = appConfig.settings || { autoSaveMemory: true, multiAgentMode: true, smartDetection: true };
      res.json({ success: true, thinkingMode });
    } else {
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// GET /api/model/info - model info
app.get('/api/model/info', (req: express.Request, res: express.Response) => {
  try {
    const modelId = req.query.model as string;
    const models = Object.entries(appConfig.apiKeys || {}).filter(([, v]) => v && !v.startsWith('your_'));
    res.json({
      info: modelId ? `已选择 ${modelId}` : '未选择',
      available: models.length,
      currentModel: appConfig.defaultModel,
      currentProvider: appConfig.defaultProvider,
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/config/switch-model - switch model without saving full config
app.post('/api/config/switch-model', (req: express.Request, res: express.Response) => {
  void (() => {
  try {
    const { model, provider } = req.body;
    if (!model) {
      return res.status(400).json({ status: 'error', message: '缺少 model 参数' });
    }
    console.info('🔄 切换模型请求:', { model, provider });
    appConfig.defaultModel = model;
    if (provider) {
      appConfig.defaultProvider = provider;
      process.env.DEFAULT_MODEL_PROVIDER = provider;
    }
    process.env.DEFAULT_MODEL = model;
    saveConfig(appConfig);
    syncConfigToModelLibrary(modelLibrary, appConfig);
    console.info('✅ 模型已切换:', { model, provider });
    res.json({ status: 'success', message: `模型已切换到 ${model}`, model, provider });
  } catch (error) {
    console.error('❌ 切换模型失败:', error);
    res.status(500).json({ status: 'error', message: '切换模型失败: ' + errMsg(error) });
  }
  })();
});

// POST /api/task/detect
app.post('/api/task/detect', (req: express.Request, res: express.Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }
    const detected = detectTaskType(message);
    const agentInfo = agents.find(a => a.id === detected.agent);
    res.json({
      taskType: detected.taskType,
      recommendedAgent: detected.agent,
      agentName: agentInfo?.name || detected.agent,
      agentDescription: agentInfo?.description || '',
      confidence: 0.85,
      suggestions: agentInfo?.expertise || [],
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/status
app.get('/api/status', (_req: express.Request, res: express.Response) => {
  try {
    const cacheKey = `status_${Date.now() / 60000 | 0}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const hasApiKey = [...Object.values(appConfig.apiKeys || {})].some(v => v && !v.startsWith('your_') && v.length > 5);
    const cs = cognitiveState.getState();
    const result = {
      version: `${VERSION}`,
      mode: hasApiKey ? 'production' : 'local',
      skills: agents.length,
      activeModels: hasApiKey ? 'API已配置' : '本地引擎',
      uptime: process.uptime(),
      conversations: conversations.size,
      toolsAvailable: tools.length,
      features: {
        smartDetection: true,
        multiAgent: true,
        streaming: true,
        toolCalling: hasApiKey,
        conversationManagement: true,
        consciousness: true,
        goalSystem: true,
        valueSystem: true,
        heartbeat: heartbeat.isRunning(),
        subAgents: true,
      },
      consciousness: {
        mood: cs.mood,
        consciousness: cs.consciousness,
        focus: cs.focus,
        energy: cs.energy,
        curiosity: cs.curiosity,
        moodDescription: cognitiveState.getMoodDescription(),
      },
      selfAwareness: {
        evolutionLevel: selfAwareness.getEvolutionLevel(),
        capabilities: (selfAwareness.getCapabilities() || []).map((c: { name: string; level: number }) => ({ name: c.name, level: c.level })),
        totalTasks: selfAwareness['model']?.totalTasksCompleted || 0,
      },
      goals: {
        total: (goalSystem.getAllGoals() || []).length,
        active: (goalSystem.getActiveGoals() || []).length,
        stats: goalSystem.getStats(),
      },
      heartbeat: {
        running: heartbeat.isRunning(),
        beatCount: heartbeat.getBeatCount(),
      },
    };
    setCachedResponse(cacheKey, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/setup/status - 检查是否需要配置向导
app.get('/api/setup/status', (_req: express.Request, res: express.Response) => {
  try {
    const hasAnyKey = [...Object.values(appConfig.apiKeys || {})].some(v => v && !v.startsWith('your_') && v.length > 5);
    res.json({
      needsSetup: !hasAnyKey,
      configuredKeys: {
        anthropic: !!appConfig.apiKeys.anthropic,
        openai: !!appConfig.apiKeys.openai,
        deepseek: !!appConfig.apiKeys.deepseek,
        groq: !!appConfig.apiKeys.groq,
        gemini: !!appConfig.apiKeys.gemini,
      },
      defaultModel: appConfig.defaultModel || 'local',
      version: VERSION,
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/setup/complete - 完成配置向导
app.post('/api/setup/complete', (req: express.Request, res: express.Response) => {
  try {
    const { apiKeys, defaultModel, features } = req.body || {};

    if (apiKeys && typeof apiKeys === 'object') {
      Object.entries(apiKeys).forEach(([key, value]) => {
        if (value && typeof value === 'string' && value !== '已配置' && value !== '未配置') {
          (appConfig.apiKeys as Record<string, string>)[key] = value;
        }
      });
    }

    if (defaultModel) appConfig.defaultModel = defaultModel;
    if (features) {
      appConfig.settings = { ...appConfig.settings, ...features };
    }

    saveConfig(appConfig);

    res.json({
      status: 'success',
      message: '配置向导完成',
      redirect: '/index.html',
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/agents
app.get('/api/agents', (_req: express.Request, res: express.Response) => {
  res.json(agents);
});

// GET /api/agents/:id
app.get('/api/agents/:id', (req: express.Request, res: express.Response) => {
  const agent = agents.find(a => a.id === req.params.id);
  if (agent) {
    res.json(agent);
  } else {
    res.status(404).json({ error: 'Agent not found' });
  }
});

// Provider -> model list 映射表
const PROVIDER_MODELS: Record<string, Array<{ id: string; name: string }>> = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }, { id: 'o3-mini', name: 'O3 Mini' },
  ],
  anthropic: [
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
  ],
  openrouter: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (免费)' },
    { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek Chat (免费)' },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (免费)' },
    { id: 'microsoft/phi-4:free', name: 'Phi-4 (免费)' },
    { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash (免费)' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  ],
  qwen: [
    { id: 'qwen-max', name: 'Qwen Max' }, { id: 'qwen-plus', name: 'Qwen Plus' },
    { id: 'qwen-turbo', name: 'Qwen Turbo' }, { id: 'qwq-32b', name: 'QwQ 32B' },
  ],
  zhipu: [
    { id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'glm-5.1', name: 'GLM-5.1' },
    { id: 'glm-4-plus', name: 'GLM-4 Plus' }, { id: 'glm-4-flash', name: 'GLM-4 Flash (免费)' },
    { id: 'glm-4-air', name: 'GLM-4 Air' }, { id: 'glm-4v-flash', name: 'GLM-4V Flash' },
  ],
  doubao: [
    { id: 'ep-doubao-pro', name: '豆包 Pro' }, { id: 'ep-doubao-lite', name: '豆包 Lite' },
  ],
  coding_plan: [
    { id: 'ark-code-latest', name: 'Auto（控制台切换）' },
    { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code' },
    { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro' },
    { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite' },
    { id: 'doubao-seed-code', name: 'Doubao Seed Code' },
    { id: 'doubao-seed-2.0-mini', name: 'Doubao Seed 2.0 Mini' },
    { id: 'glm-5.1', name: 'GLM 5.1' }, { id: 'glm-5.2', name: 'GLM 5.2' },
    { id: 'glm-4.7', name: 'GLM 4.7' },
    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5' }, { id: 'kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'minimax-m2.7', name: 'MiniMax M2.7' }, { id: 'minimax-m3', name: 'MiniMax M3' },
  ],
  ernie: [
    { id: 'ernie-4.0-8k-latest', name: '文心一言 4.0' },
    { id: 'ernie-3.5-8k', name: '文心一言 3.5' },
  ],
  mistral: [
    { id: 'mistral-small-latest', name: 'Mistral Small' },
    { id: 'mistral-large-latest', name: 'Mistral Large' },
  ],
  siliconflow: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B' },
  ],
  together: [
    { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', name: 'Llama 3.1 70B' },
  ],
  perplexity: [
    { id: 'sonar-pro', name: 'Sonar Pro' }, { id: 'sonar', name: 'Sonar' },
  ],
  xai: [
    { id: 'grok-2', name: 'Grok 2' },
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', name: 'Moonshot 8K' },
    { id: 'moonshot-v1-32k', name: 'Moonshot 32K' },
    { id: 'moonshot-v1-128k', name: 'Moonshot 128K' },
  ],
  minimax: [
    { id: 'MiniMax-Text-01', name: 'MiniMax Text' },
  ],
  cohere: [
    { id: 'command-r-plus', name: 'Command R+' },
  ],
  agnes: [
    { id: 'agnes-2.0-flash', name: 'Agnes 2.0 Flash' },
  ],
  ollama: [
    { id: 'llama3', name: 'Llama 3' },
  ],
  custom: [
    { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code' },
    { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro' },
    { id: 'doubao-seed-code', name: 'Doubao Seed Code' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5' },
    { id: 'ark-code-latest', name: 'Coding Plan Auto' },
  ],
};

// GET /api/models - list available models based on configured keys
app.get('/api/models', (_req: express.Request, res: express.Response) => {
  const cacheKey = `models_${Date.now() / 60000 | 0}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) return res.json(cached);

  const available: Array<{ id: string; name: string; provider: string; status: string }> = [];

  for (const def of PROVIDER_REGISTRY) {
    const apiKeyField = def.id === 'gemini' ? 'gemini' : def.id; // gemini key stored under apiKeys.gemini
    const keyValue = appConfig.apiKeys[apiKeyField as keyof typeof appConfig.apiKeys] as string | undefined;
    if (!hasValidKey(keyValue)) continue;

    const models = PROVIDER_MODELS[def.id];
    if (models) {
      for (const m of models) {
        available.push({ id: m.id, name: m.name, provider: def.label, status: 'online' });
      }
    } else {
      // 没有预定义模型列表时，至少返回默认模型
      if (def.defaultModel) {
        available.push({ id: def.defaultModel, name: def.label, provider: def.label, status: 'online' });
      }
    }
  }

  if (available.length === 0) {
    available.push({ id: 'local', name: '本地引擎', provider: '内置', status: 'online' });
  }

  setCachedResponse(cacheKey, available);
  res.json(available);
});

// GET /api/tools
app.get('/api/tools', (_req: express.Request, res: express.Response) => {
  try {
    const cacheKey = `tools_${Date.now() / 60000 | 0}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const result = (tools || []).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    setCachedResponse(cacheKey, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// Conversation management APIs
// ============================================================

// GET /api/conversations - list conversations
app.get('/api/conversations', (_req: express.Request, res: express.Response) => {
  try {
    const list = Array.from(conversations.values()).map(c => ({
      id: c.id,
      title: c.title,
      messageCount: (c.messages || []).length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/conversations - create new conversation
app.post('/api/conversations', (req: express.Request, res: express.Response) => {
  const { title } = req.body || {};
  const id = `conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const conv: Conversation = {
    id,
    title: title || '新对话',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  conversations.set(id, conv);
  res.json(conv);
});

// DELETE /api/conversations/:id
app.delete('/api/conversations/:id', (req: express.Request, res: express.Response) => {
  const id = req.params.id;
  if (conversations.has(id)) {
    conversations.delete(id);
    res.json({ status: 'success', message: '对话已删除' });
  } else {
    res.status(404).json({ error: '对话不存在' });
  }
});

// GET /api/conversations/:id/messages
app.get('/api/conversations/:id/messages', (req: express.Request, res: express.Response) => {
  const conv = conversations.get(req.params.id);
  if (conv) {
    res.json(conv.messages);
  } else {
    res.status(404).json({ error: '对话不存在' });
  }
});

// ============================================================
// Config APIs
// ============================================================

// 旧版 key 名称 → 新版 id 映射（向上兼容）
const LEGACY_KEY_MAP: Record<string, string> = { google: 'gemini' };

// GET /api/config
app.get('/api/config', (_req: express.Request, res: express.Response) => {
  const apiKeys: Record<string, string> = {};
  for (const def of PROVIDER_REGISTRY) {
    let keyValue = (appConfig.apiKeys as Record<string, string>)[def.id];
    // 兼容旧版 key 名称（如 google → gemini）
    const legacyKeys = Object.entries(LEGACY_KEY_MAP).filter(([, v]) => v === def.id).map(([k]) => k);
    for (const legacyKey of legacyKeys) {
      if (!keyValue) {
        keyValue = (appConfig.apiKeys as Record<string, string>)[legacyKey];
        if (keyValue) {
          (appConfig.apiKeys as Record<string, string>)[def.id] = keyValue;
          delete (appConfig.apiKeys as Record<string, string>)[legacyKey];
        }
      }
    }
    apiKeys[def.id] = keyValue ? '已配置' : '未配置';
  }
  res.json({
    apiKeys,
    defaultModel: appConfig.defaultModel,
    defaultProvider: appConfig.defaultProvider,
    settings: appConfig.settings,
    customBaseURL: process.env.CUSTOM_BASE_URL || '',
    customModel: process.env.CUSTOM_MODEL || '',
    providerModels: {
      doubao: process.env.DOUBAO_MODEL || '',
    },
  });
});

// POST /api/config - save config
app.post('/api/config', (req: express.Request, res: express.Response) => {
  try {
    const { apiKeys, defaultModel, defaultProvider, settings, providerModels, customBaseURL, customModel } = req.body;
    
    console.info('📝 收到配置保存请求:', {
      hasApiKeys: !!apiKeys,
      apiKeysPresent: apiKeys ? Object.keys(apiKeys).filter(k => apiKeys[k]) : [],
      defaultModel,
      defaultProvider,
      customBaseURL,
      customModel,
    });

    if (apiKeys) {
      for (const def of PROVIDER_REGISTRY) {
        const val = apiKeys[def.id];
        if (val && val !== '已配置' && val !== '未配置') {
          (appConfig.apiKeys as Record<string, string>)[def.id] = val;
          console.info(`✅ ${def.label} key已更新`);
        }
      }
      // 向后兼容：旧版前端把 customBaseURL/customModel 塞在 apiKeys 里
      if (apiKeys.custom_baseURL) {
        process.env.CUSTOM_BASE_URL = apiKeys.custom_baseURL;
      }
      if (apiKeys.custom_model) {
        process.env.CUSTOM_MODEL = apiKeys.custom_model;
      }
      // 迁移旧版 key 名称（google → gemini）
      if (apiKeys.gemini) {
        delete (appConfig.apiKeys as Record<string, string>)['google'];
      }
    }
    // 新版：customBaseURL/customModel 作为顶级字段
    if (customBaseURL) process.env.CUSTOM_BASE_URL = customBaseURL;
    if (customModel) process.env.CUSTOM_MODEL = customModel;

    if (providerModels) {
      if (providerModels.doubao) {
        process.env.DOUBAO_MODEL = providerModels.doubao;
      }
    }

    if (defaultModel) appConfig.defaultModel = defaultModel;
    if (defaultProvider) {
      const labelMatch = PROVIDER_REGISTRY.find(d => d.label === defaultProvider);
      appConfig.defaultProvider = labelMatch ? labelMatch.id : defaultProvider;
    }
    if (settings) {
      appConfig.settings = { ...appConfig.settings, ...settings };
    }

    console.info('💾 开始保存配置...');
    saveConfig(appConfig);
    console.info('✅ 配置保存完成');
    
    // 同步到全局模型库
    syncConfigToModelLibrary(modelLibrary, appConfig);
    console.info('🔮 已同步到模型库');

    // 同步到环境变量，确保全局生效
    if (defaultModel) process.env.DEFAULT_MODEL = defaultModel;
    if (defaultProvider) process.env.DEFAULT_MODEL_PROVIDER = defaultProvider;
    
    console.info('📊 当前配置状态:', {
      configuredKeys: PROVIDER_REGISTRY.filter(d => hasValidKey((appConfig.apiKeys as Record<string, string>)[d.id])).map(d => d.id),
      defaultModel: appConfig.defaultModel,
    });

    res.json({
      status: 'success',
      message: '配置已保存',
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ 保存配置失败:', errMsg(error));
    res.status(500).json({
      status: 'error',
      message: '保存配置失败: ' + errMsg(error),
    });
  }
});

// ============================================================
// Legacy / compatibility APIs
// ============================================================

// POST /api/codex/generate - code generation (delegates to chat)
app.post('/api/codex/generate', (req: express.Request, res: express.Response) => {
  void (async () => {
  const { description, language = 'javascript' } = req.body;
  if (!description) {
    return res.status(400).json({ error: '描述不能为空' });
  }

  const prompt = `请用${language}语言实现以下功能：${description}\n\n请提供完整的、可运行的代码，包含必要的注释和错误处理。`;

  // Try to use LLM for real code generation
  const provider = resolveProvider(appConfig.defaultModel);
  let code = '';
  let explanation = '';

  try {
    const client = (() => {
      if (provider === 'deepseek') return getDeepSeekClient();
      if (provider === 'openai') return getOpenAIClient();
      return getAnthropicClient();
    })();

    if (client && provider === 'anthropic') {
      const msg = await (client as Anthropic).messages.create({
        model: appConfig.defaultModel,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      const textBlock = (msg.content || []).find(b => b.type === 'text');
      code = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      explanation = `由 ${appConfig.defaultModel} 生成`;
    } else if (client && (provider === 'openai' || provider === 'deepseek')) {
      const msg = await (client as OpenAI).chat.completions.create({
        model: appConfig.defaultModel || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4-turbo'),
        messages: [{ role: 'user', content: prompt }],
      });
      code = msg.choices[0]?.message?.content || '';
      explanation = `由 ${appConfig.defaultModel} 生成`;
    } else {
      throw new Error('No API key');
    }
  } catch {
    // Fallback: return a template
    code = `// ${language} 代码模板\n// 需求: ${description}\n\n// 请配置API Key以获得AI生成的代码\n// 当前为模板模式\n\nfunction solution() {\n  // TODO: 实现 ${description}\n  console.log('待实现');\n}\n`;
    explanation = '模板模式 - 请配置API Key以获得AI生成的代码';
  }

  res.json({ code, language, description, explanation });
  })();
});

// GET /api/memory
app.get('/api/memory', (_req: express.Request, res: express.Response) => {
  try {
    let totalMessages = 0;
    conversations.forEach(c => { totalMessages += (c.messages || []).length; });
    res.json({
      conversations: { count: conversations.size, totalMessages },
      shortTerm: { count: totalMessages, capacity: MAX_CONTEXT_MESSAGES },
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/memory
app.post('/api/memory', (req: express.Request, res: express.Response) => {
  const { _content } = req.body;
  res.json({
    status: 'success',
    message: '记忆已保存',
  });
});

// GET /api/wakeup/words
app.get('/api/wakeup/words', (_req: express.Request, res: express.Response) => {
  res.json({
    words: ['段先生', 'duan', 'hey duan', '你好段先生'],
    sensitivity: 'medium',
    status: 'ready',
  });
});

// POST /api/wakeup/toggle
app.post('/api/wakeup/toggle', (req: express.Request, res: express.Response) => {
  const { enabled } = req.body;
  res.json({
    status: enabled ? 'listening' : 'stopped',
    message: enabled ? '语音唤醒已启动' : '语音唤醒已停止',
  });
});

// Knowledge API
app.get('/api/knowledge', (req: express.Request, res: express.Response) => {
  try {
    const query = (req.query.q as string) || '';
    if (query) {
      const results = (kb.search(query, 10) || []);
      res.json({ results, total: results.length });
    } else {
      const all = kb.getAll() || [];
      const recent = all.slice(-20).reverse();
      res.json({ results: recent, total: all.length });
    }
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

app.post('/api/knowledge', (req: express.Request, res: express.Response) => {
  const { topic, content, tags, source } = req.body;
  if (!topic || !content) {
    res.status(400).json({ error: 'topic和content为必填项' });
    return;
  }
  const entry = kb.add(topic, content, tags || [], source || 'manual');
  res.json({ success: true, entry });
});

app.delete('/api/knowledge/:id', (req: express.Request, res: express.Response) => {
  const deleted = kb.delete(req.params.id);
  if (deleted) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '未找到该知识条目' });
  }
});

// Shell execute API — 含危险命令防护（白名单 + 参数数组执行）
// 安全说明：默认禁用，需通过环境变量 SHELL_API_ENABLED=true 显式开启
app.post('/api/shell', (req: express.Request, res: express.Response) => {
  // 第一道防线：默认禁用此端点
  if (process.env.SHELL_API_ENABLED !== 'true') {
    res.status(403).json({ success: false, error: 'Shell API 已禁用。如需启用请设置 SHELL_API_ENABLED=true 环境变量' });
    return;
  }
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: 'command为必填项且必须为字符串' });
    return;
  }
  // 第二道防线：长度限制
  if (command.length > 500) {
    res.status(400).json({ error: '命令长度超过 500 字符限制' });
    return;
  }
  // 第三道防线：危险命令黑名单（深度防御）
  const dangerousPatterns = [
    /rm\s+-rf\s+[/\\]/i, /del\s+\/[sf]\s+\/[q]\s+[a-z]:/i,
    /format\s+[a-z]:/i, /shutdown/i, /taskkill\s+\/[f]/i,
    /reg\s+delete/i, /net\s+user/i, /cipher\s+\/[w]/i,
    /\bmkfs\b/i, /:\(\)\s*\{\s*:\|:&\s*\};/i, // fork bomb
    /;\s*(rm|del|format|shutdown)/i, /&&\s*(rm|del|format|shutdown)/i,
    /\|\s*(rm|del|format|shutdown)/i, /`[^`]*rm/i,
  ];
  if (dangerousPatterns.some(p => p.test(command))) {
    res.json({ success: false, output: '命令被安全防护拦截：包含危险操作' });
    return;
  }
  // 第四道防线：命令白名单（仅允许明确的安全命令）
  const trimmed = command.trim();
  const whiteListedCommands = [
    'npm ', 'npm.cmd ', 'git ', 'node ', 'dir ', 'ls ', 'pwd ',
    'echo ', 'type ', 'cat ', 'head ', 'tail ', 'wc ',
    'find ', 'where ', 'which ',
  ];
  const isWhitelisted = whiteListedCommands.some(cmd => trimmed.toLowerCase().startsWith(cmd));
  if (!isWhitelisted) {
    res.status(403).json({
      success: false,
      error: `命令不在白名单中。允许的命令前缀: ${whiteListedCommands.map(c => c.trim()).join(', ')}`
    });
    return;
  }
  try {
    // Windows 使用 cmd，其他平台使用 sh
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', trimmed] : ['-c', trimmed];
    const result = spawnSync(shell, shellArgs, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    res.json({
      success: result.status === 0,
      output: output.substring(0, 5000),
      exitCode: result.status,
    });
  } catch (err) {
    const execErr = err as { stderr?: string; message: string };
    res.json({ success: false, output: execErr.stderr || execErr.message });
  }
});

// SPA fallback - 必须放在所有API路由之后
// 注意：保留此处仅为兼容性，真正的fallback在文件末尾

// ============================================================
}