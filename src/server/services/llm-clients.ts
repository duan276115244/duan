import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type Provider = 'anthropic' | 'openai' | 'deepseek' | 'groq' | 'gemini' | 'openrouter' | 'qwen' | 'zhipu' | 'doubao' | 'coding_plan' | 'ernie' | 'mistral' | 'siliconflow' | 'together' | 'fireworks' | 'perplexity' | 'xai' | 'moonshot' | 'minimax' | 'cohere' | 'agnes' | 'ollama' | 'custom';

interface ApiKeys {
  anthropic?: string; openai?: string; google?: string; deepseek?: string;
  qwen?: string; zhipu?: string; doubao?: string; coding_plan?: string; ernie?: string;
  groq?: string; gemini?: string; openrouter?: string; mistral?: string;
  cohere?: string; siliconflow?: string; together?: string; fireworks?: string;
  perplexity?: string; xai?: string; minimax?: string; moonshot?: string; ollama?: string;
  agnes?: string; custom?: string;
}

export interface AppConfig {
  apiKeys: ApiKeys;
  defaultModel: string;
  defaultProvider: string;
  settings: { autoSaveMemory: boolean; multiAgentMode: boolean; smartDetection: boolean; };
}

/** Provider registry: single source of truth for all providers */
export interface ProviderDef {
  id: Provider;
  label: string;
  envKey: string;
  baseURL: string;
  defaultModel: string;
  category: '国际' | '聚合' | '国内' | '本地' | '自定义';
  color: string;
  placeholder: string;
}

export const PROVIDER_REGISTRY: ProviderDef[] = [
  // 国际主流
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', category: '国际', color: '#10b981', placeholder: 'sk-...' },
  { id: 'anthropic', label: 'Anthropic Claude', envKey: 'ANTHROPIC_API_KEY', baseURL: '', defaultModel: 'claude-3-5-haiku-20241022', category: '国际', color: '#f59e0b', placeholder: 'sk-ant-...' },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', category: '国际', color: '#06b6d4', placeholder: 'sk-...' },
  { id: 'gemini', label: 'Google Gemini', envKey: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash', category: '国际', color: '#3b82f6', placeholder: 'AIza...' },
  { id: 'mistral', label: 'Mistral AI', envKey: 'MISTRAL_API_KEY', baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', category: '国际', color: '#f97316', placeholder: '...' },
  { id: 'xai', label: 'xAI (Grok)', envKey: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-2', category: '国际', color: '#8b5cf6', placeholder: 'xai-...' },
  { id: 'cohere', label: 'Cohere', envKey: 'COHERE_API_KEY', baseURL: 'https://api.cohere.ai/v2', defaultModel: 'command-r-plus', category: '国际', color: '#ec4899', placeholder: '...' },
  { id: 'perplexity', label: 'Perplexity', envKey: 'PERPLEXITY_API_KEY', baseURL: 'https://api.perplexity.ai', defaultModel: 'sonar-pro', category: '国际', color: '#14b8a6', placeholder: 'pplx-...' },
  // 聚合平台
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.3-70b-instruct:free', category: '聚合', color: '#a78bfa', placeholder: 'sk-or-...' },
  { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', category: '聚合', color: '#f55036', placeholder: 'gsk_...' },
  { id: 'together', label: 'Together AI', envKey: 'TOGETHER_API_KEY', baseURL: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', category: '聚合', color: '#3b82f6', placeholder: '...' },
  { id: 'fireworks', label: 'Fireworks AI', envKey: 'FIREWORKS_API_KEY', baseURL: 'https://api.fireworks.ai/inference/v1', defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct', category: '聚合', color: '#8b5cf6', placeholder: '...' },
  { id: 'siliconflow', label: 'SiliconFlow', envKey: 'SILICONFLOW_API_KEY', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'deepseek-ai/DeepSeek-V3', category: '聚合', color: '#06b6d4', placeholder: 'sk-...' },
  // 国内
  { id: 'qwen', label: '阿里通义千问', envKey: 'ALIYUN_API_KEY', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', category: '国内', color: '#6366f1', placeholder: 'sk-...' },
  { id: 'zhipu', label: '智谱 GLM', envKey: 'ZHIPU_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', category: '国内', color: '#06b6d4', placeholder: '...' },
  { id: 'doubao', label: '字节豆包 (火山引擎)', envKey: 'DOUBAO_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'ep-please-config', category: '国内', color: '#ec4899', placeholder: 'ark-... 接入密钥' },
  { id: 'coding_plan', label: '火山引擎 Coding Plan', envKey: 'DOUBAO_CODING_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultModel: 'ark-code-latest', category: '国内', color: '#f97316', placeholder: 'ark-... 接入密钥' },
  { id: 'ernie', label: '百度文心', envKey: 'ERNIE_API_KEY', baseURL: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', defaultModel: 'ernie-4.0-8k-latest', category: '国内', color: '#3b82f6', placeholder: '...' },
  { id: 'moonshot', label: '月之暗面 Kimi', envKey: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', category: '国内', color: '#8b5cf6', placeholder: 'sk-...' },
  { id: 'minimax', label: 'MiniMax 海螺AI', envKey: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.chat/v1', defaultModel: 'MiniMax-Text-01', category: '国内', color: '#f59e0b', placeholder: '...' },
  { id: 'agnes', label: 'Agnes AI', envKey: 'AGNES_API_KEY', baseURL: 'https://apihub.agnes-ai.com/v1', defaultModel: 'agnes-2.0-flash', category: '国内', color: '#a78bfa', placeholder: '...' },
  // 本地
  { id: 'ollama', label: 'Ollama 本地', envKey: 'OLLAMA_API_KEY', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3', category: '本地', color: '#64748b', placeholder: 'http://localhost:11434' },
  // 自定义 OpenAI 兼容
  { id: 'custom', label: '自定义 API (OpenAI 兼容)', envKey: 'CUSTOM_API_KEY', baseURL: '', defaultModel: '', category: '自定义', color: '#f59e0b', placeholder: 'API Key' },
];

let appConfig: AppConfig;

export function setAppConfig(config: AppConfig): void {
  appConfig = config;
}

export function hasValidKey(key: string | undefined): boolean {
  return !!key && !key.startsWith('your_') && key.length > 3;
}

export function getAnthropicClient(): Anthropic | null {
  const key = appConfig?.apiKeys?.anthropic || process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new Anthropic({ apiKey: key });
}

export function getOpenAIClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.openai || process.env.OPENAI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key });
}

export function getDeepSeekClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.deepseek || process.env.DEEPSEEK_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com/v1' });
}

export function getGroqClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.groq || process.env.GROQ_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' });
}

export function getGeminiClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.gemini || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' });
}

export function getOpenRouterClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.openrouter || process.env.OPENROUTER_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' });
}

export function getMistralClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.mistral || process.env.MISTRAL_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.mistral.ai/v1' });
}

export function getSiliconFlowClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.siliconflow || process.env.SILICONFLOW_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.siliconflow.cn/v1' });
}

export function getTogetherClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.together || process.env.TOGETHER_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.together.xyz/v1' });
}

export function getFireworksClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.fireworks || process.env.FIREWORKS_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.fireworks.ai/inference/v1' });
}

export function getPerplexityClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.perplexity || process.env.PERPLEXITY_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.perplexity.ai' });
}

export function getXAIClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.xai || process.env.XAI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1' });
}

export function getMoonshotClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.moonshot || process.env.MOONSHOT_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.moonshot.cn/v1' });
}

export function getZhipuClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.zhipu || process.env.ZHIPU_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://open.bigmodel.cn/api/paas/v4' });
}

export function getQwenClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.qwen || process.env.QWEN_API_KEY || process.env.ALIYUN_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
}

/**
 * 火山引擎豆包: API Key = 接入密钥(ark-xxxx), Model = 接入点ID(ep-xxxx)
 * 用户需在火山引擎方舟控制台创建接入点后填入接入点ID
 */
export function getDoubaoClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.doubao || process.env.DOUBAO_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  const baseURL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
  return new OpenAI({ apiKey: key, baseURL });
}

/**
 * 火山引擎 Coding Plan: 订阅套餐模式，使用 /api/coding/v3 端点
 * 支持的模型: ark-code-latest, doubao-seed-2.0-code, doubao-seed-2.0-pro,
 *            doubao-seed-2.0-lite, doubao-seed-code, doubao-seed-2.0-mini,
 *            glm-5.1, deepseek-v4-flash, deepseek-v4-pro,
 *            kimi-k2.6, minimax-m2.7, minimax-m3
 */
export function getCodingPlanClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.coding_plan || appConfig?.apiKeys?.custom || process.env.DOUBAO_CODING_API_KEY || process.env.CUSTOM_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  const baseURL = process.env.CODING_PLAN_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3';
  return new OpenAI({ apiKey: key, baseURL });
}

/**
 * 百度文心一言: 使用千帆 OpenAI 兼容端点
 * API Key 格式: 需通过百度千帆控制台获取，使用 OAuth access token 或 API Key
 */
export function getErnieClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.ernie || process.env.ERNIE_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  const baseURL = process.env.ERNIE_BASE_URL || 'https://qianfan.baidubce.com/v2';
  return new OpenAI({ apiKey: key, baseURL });
}

export function getAgnesClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.agnes || process.env.AGNES_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://apihub.agnes-ai.com/v1' });
}

export function getMinimaxClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.minimax || process.env.MINIMAX_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.minimax.chat/v1' });
}

export function getCohereClient(): OpenAI | null {
  const key = appConfig?.apiKeys?.cohere || process.env.COHERE_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 8) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.cohere.ai/v2' });
}

/**
 * 通用 OpenAI 兼容客户端: 支持任何 baseURL/apiKey/model
 */
export function getOllamaClient(): OpenAI | null {
  const host = appConfig?.apiKeys?.ollama || process.env.OLLAMA_API_KEY || process.env.OLLAMA_HOST;
  // P1 修复：未显式配置 Ollama 时返回 null，避免 fallback 链总是停在 Ollama
  if (!host) return null;
  const baseURL = host.endsWith('/v1') ? host : `${host.replace(/\/+$/, '')}/v1`;
  return new OpenAI({ apiKey: 'ollama', baseURL });
}

export function getCustomClient(overrides?: { baseURL?: string; apiKey?: string }): OpenAI | null {
  const key = overrides?.apiKey || appConfig?.apiKeys?.custom || process.env.CUSTOM_API_KEY;
  const baseURL = overrides?.baseURL || process.env.CUSTOM_BASE_URL;
  if (!key || key.startsWith('your_') || key.length < 3) return null;
  if (!baseURL) return null;
  return new OpenAI({ apiKey: key, baseURL });
}

export function getBestAvailableClient(): { client: OpenAI | Anthropic; provider: Provider; model: string } | null {
  const chain: Array<{ fn: () => OpenAI | Anthropic | null; provider: Provider; model: string }> = [
    { fn: getDeepSeekClient, provider: 'deepseek', model: appConfig?.defaultModel || 'deepseek-chat' },
    { fn: getOpenRouterClient, provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { fn: getOpenAIClient, provider: 'openai', model: 'gpt-4o-mini' },
    { fn: getAnthropicClient, provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
    { fn: getGroqClient, provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { fn: getQwenClient, provider: 'qwen', model: 'qwen-plus' },
    { fn: getZhipuClient, provider: 'zhipu', model: 'glm-4-flash' },
    { fn: getSiliconFlowClient, provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V3' },
    { fn: getMoonshotClient, provider: 'moonshot', model: 'moonshot-v1-8k' },
    { fn: getGeminiClient, provider: 'gemini', model: 'gemini-2.0-flash' },
    { fn: getMistralClient, provider: 'mistral', model: 'mistral-small-latest' },
    { fn: getDoubaoClient, provider: 'doubao', model: process.env.DOUBAO_MODEL || 'ep-please-config' },
    { fn: getCodingPlanClient, provider: 'coding_plan', model: process.env.CODING_PLAN_MODEL || 'ark-code-latest' },
    { fn: getErnieClient, provider: 'ernie', model: 'ernie-4.0-8k-latest' },
    { fn: getAgnesClient, provider: 'agnes', model: 'agnes-2.0-flash' },
    { fn: getMinimaxClient, provider: 'minimax', model: 'MiniMax-Text-01' },
    { fn: getTogetherClient, provider: 'together', model: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
    { fn: getFireworksClient, provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p1-70b-instruct' },
    { fn: getPerplexityClient, provider: 'perplexity', model: 'sonar-pro' },
    { fn: getXAIClient, provider: 'xai', model: 'grok-2' },
    { fn: getCohereClient, provider: 'cohere', model: 'command-r-plus' },
    { fn: getOllamaClient, provider: 'ollama', model: 'llama3' },
    { fn: getCustomClient, provider: 'custom', model: process.env.CUSTOM_MODEL || 'default' },
  ];
  for (const { fn, provider, model } of chain) {
    const client = fn();
    if (client) return { client, provider, model: model || appConfig?.defaultModel || 'deepseek-chat' };
  }
  return null;
}

export function resolveProvider(model: string): Provider {
  if (!model || model === 'local') return 'deepseek';

  // ===== 先处理 provider-qualified 模型名（含 / 的） =====
  if (model.includes('/')) {
    const prefix = model.split('/')[0].toLowerCase();
    // OpenRouter: 任何 provider/name 格式最可能来自 OpenRouter
    if (hasValidKey(appConfig?.apiKeys?.openrouter)) return 'openrouter';
    // SiliconFlow: deepseek-ai/Qwen/THUDM 开头
    if (['deepseek-ai', 'qwen', 'thudm'].includes(prefix)) {
      if (hasValidKey(appConfig?.apiKeys?.siliconflow)) return 'siliconflow';
    }
    // Fireworks: accounts/fireworks/...
    if (prefix === 'accounts') {
      if (hasValidKey(appConfig?.apiKeys?.fireworks)) return 'fireworks';
    }
    // Together: meta-llama、mistralai 等
    if (['meta-llama', 'mistralai', 'codellama', 'together'].includes(prefix)) {
      if (hasValidKey(appConfig?.apiKeys?.together)) return 'together';
    }
    // 如果没人认领，回退到聚合平台
    if (hasValidKey(appConfig?.apiKeys?.siliconflow)) return 'siliconflow';
    if (hasValidKey(appConfig?.apiKeys?.together)) return 'together';
    if (hasValidKey(appConfig?.apiKeys?.fireworks)) return 'fireworks';
  }

  // ===== 纯模型名（不含 /），前缀匹配 =====
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('chatgpt')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('mistral') || model.startsWith('codestral') || model.startsWith('pixtral')) return 'mistral';
  if (model.startsWith('minimax')) return 'minimax';
  if (model.startsWith('moonshot') || model.startsWith('kimi')) return 'moonshot';
  if (model.startsWith('glm') || model.startsWith('chatglm')) return 'zhipu';
  if (model.startsWith('qwen') || model.startsWith('qwq')) return 'qwen';
  // ===== Coding Plan 模型识别（必须在 doubao 前缀匹配之前） =====
  // Coding Plan 使用 /api/coding/v3 端点（官方文档）
  const CODING_PLAN_MODELS = new Set([
    'ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro',
    'doubao-seed-2.0-lite', 'doubao-seed-code', 'doubao-seed-2.0-mini',
    'glm-5.1', 'deepseek-v4-flash', 'deepseek-v4-pro',
    'kimi-k2.6', 'minimax-m2.7', 'minimax-m3',
  ]);
  if (CODING_PLAN_MODELS.has(model)) {
    if (hasValidKey(appConfig?.apiKeys?.coding_plan) || hasValidKey(appConfig?.apiKeys?.custom)) return 'coding_plan';
  }

  if (model.startsWith('doubao') || model.startsWith('ep-')) return 'doubao';
  if (model.startsWith('ernie') || model.startsWith('wenxin')) return 'ernie';
  if (model.startsWith('cohere') || model.startsWith('command') || model.startsWith('rerank')) return 'cohere';
  if (model.startsWith('pplx') || model.startsWith('sonar')) return 'perplexity';
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('siliconflow') || model.startsWith('SF/')) return 'siliconflow';
  if (model.startsWith('agnes')) return 'agnes';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('llama') || model.startsWith('mixtral') || model.startsWith('gemma')) {
    if (hasValidKey(appConfig?.apiKeys?.groq)) return 'groq';
    if (hasValidKey(appConfig?.apiKeys?.openrouter)) return 'openrouter';
    if (hasValidKey(appConfig?.apiKeys?.ollama)) return 'ollama';
    if (hasValidKey(appConfig?.apiKeys?.together)) return 'together';
    return 'deepseek';
  }

  // ===== 兜底：找任意已配置的提供商 =====
  if (hasValidKey(appConfig?.apiKeys?.deepseek)) return 'deepseek';
  if (hasValidKey(appConfig?.apiKeys?.openrouter)) return 'openrouter';
  if (hasValidKey(appConfig?.apiKeys?.groq)) return 'groq';
  if (hasValidKey(appConfig?.apiKeys?.openai)) return 'openai';
  if (hasValidKey(appConfig?.apiKeys?.anthropic)) return 'anthropic';
  if (hasValidKey(appConfig?.apiKeys?.siliconflow)) return 'siliconflow';
  if (hasValidKey(appConfig?.apiKeys?.together)) return 'together';
  if (hasValidKey(appConfig?.apiKeys?.fireworks)) return 'fireworks';
  if (hasValidKey(appConfig?.apiKeys?.qwen)) return 'qwen';
  if (hasValidKey(appConfig?.apiKeys?.zhipu)) return 'zhipu';
  if (hasValidKey(appConfig?.apiKeys?.moonshot)) return 'moonshot';
  if (hasValidKey(appConfig?.apiKeys?.doubao)) return 'doubao';
  if (hasValidKey(appConfig?.apiKeys?.coding_plan)) return 'coding_plan';
  if (hasValidKey(appConfig?.apiKeys?.gemini)) return 'gemini';
  if (hasValidKey(appConfig?.apiKeys?.mistral)) return 'mistral';
  if (hasValidKey(appConfig?.apiKeys?.xai)) return 'xai';
  if (hasValidKey(appConfig?.apiKeys?.cohere)) return 'cohere';
  if (hasValidKey(appConfig?.apiKeys?.perplexity)) return 'perplexity';
  if (hasValidKey(appConfig?.apiKeys?.minimax)) return 'minimax';
  if (hasValidKey(appConfig?.apiKeys?.agnes)) return 'agnes';
  return 'deepseek';
}

export function getClientForProvider(provider: Provider, overrides?: { baseURL?: string; apiKey?: string }): OpenAI | Anthropic | null {
  switch (provider) {
    case 'deepseek': return getDeepSeekClient();
    case 'openrouter': return getOpenRouterClient();
    case 'groq': return getGroqClient();
    case 'openai': return getOpenAIClient();
    case 'anthropic': return getAnthropicClient();
    case 'mistral': return getMistralClient();
    case 'siliconflow': return getSiliconFlowClient();
    case 'together': return getTogetherClient();
    case 'fireworks': return getFireworksClient();
    case 'perplexity': return getPerplexityClient();
    case 'xai': return getXAIClient();
    case 'moonshot': return getMoonshotClient();
    case 'zhipu': return getZhipuClient();
    case 'qwen': return getQwenClient();
    case 'doubao': return getDoubaoClient();
    case 'coding_plan': return getCodingPlanClient();
    case 'ernie': return getErnieClient();
    case 'minimax': return getMinimaxClient();
    case 'cohere': return getCohereClient();
    case 'gemini': return getGeminiClient();
    case 'agnes': return getAgnesClient();
    case 'custom': return getCustomClient(overrides);
    case 'ollama': return getOllamaClient();
    default: return null;
  }
}

/**
 * 智能解析聊天请求的 provider：先按模型名前缀匹配，再按 defaultProvider 兜底。
 * Coding Plan 模型优先路由到 coding_plan provider（使用 /api/v3 端点）。
 * custom 提供商无条件优先（模型名无前缀可匹配），确保 Coding Plan 等自定义 API 正常工作。
 */
export function resolveChatProvider(model: string): Provider {
  const resolved = resolveProvider(model);
  const defProv = appConfig?.defaultProvider;

  // Coding Plan 优先：如果模型属于 Coding Plan 且有对应 key，直接用 coding_plan
  const CODING_PLAN_MODELS = new Set([
    'ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro',
    'doubao-seed-2.0-lite', 'doubao-seed-code', 'doubao-seed-2.0-mini',
    'glm-5.1', 'deepseek-v4-flash', 'deepseek-v4-pro',
    'kimi-k2.6', 'minimax-m2.7', 'minimax-m3',
  ]);
  if (CODING_PLAN_MODELS.has(model) && (hasValidKey(appConfig?.apiKeys?.coding_plan) || hasValidKey(appConfig?.apiKeys?.custom))) {
    return 'coding_plan';
  }

  // custom 优先：只要用户配置了 custom provider，且模型名无特定匹配，就用 custom
  if (defProv === 'custom' && hasValidKey(appConfig?.apiKeys?.custom) && process.env.CUSTOM_BASE_URL) {
    // 但如果 CUSTOM_BASE_URL 包含 /coding/，说明是 Coding Plan，应路由到 coding_plan
    if (process.env.CUSTOM_BASE_URL.includes('/coding/')) {
      return 'coding_plan';
    }
    return 'custom';
  }

  // 如果 resolved provider 有有效 key，直接用它
  if (hasValidKey((appConfig?.apiKeys as Record<string, string>)?.[resolved])) {
    return resolved;
  }

  // 兜底：如果 defaultProvider 有 key 且不等于 resolved，用 defaultProvider
  if (defProv && defProv !== resolved && hasValidKey((appConfig?.apiKeys as Record<string, string>)?.[defProv])) {
    return defProv as Provider;
  }

  return resolved;
}
