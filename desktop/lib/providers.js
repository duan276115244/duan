/**
 * Provider 映射常量（供 llm-config-resolver 和 config-manager 共用）
 * 从 desktop/main.js 抽出 — 纯常量 + 纯函数
 */

// Provider 别名映射（全局，供 resolveLLMConfig 和 saveApiKeysToProfiles 共用）
const PROVIDER_ALIASES = {
  'coding_plan': 'doubao-coding',
  'doubao-coding': 'coding_plan',
  'google': 'gemini',
  'gemini': 'google',
};

// Provider 到环境变量和 baseURL 的映射（根据各供应商官方文档配置）
const PROVIDER_MAP = {
  deepseek: { envKey: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  openai: { envKey: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  anthropic: { envKey: 'ANTHROPIC_API_KEY', baseURL: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-haiku-20241022' },
  openrouter: { envKey: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  google: { envKey: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' },
  zhipu: { envKey: 'ZHIPU_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash' },
  qwen: { envKey: 'ALIYUN_API_KEY', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-turbo' },
  // 火山引擎 豆包（标准API，按量计费，支持直接使用模型名）
  doubao: { envKey: 'DOUBAO_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-0-lite-260215' },
  // 火山引擎 Coding Plan（订阅制，使用 /api/coding/v3 端点，需先订阅套餐）
  'doubao-coding': { envKey: 'DOUBAO_CODING_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultModel: 'ark-code-latest' },
  'coding_plan': { envKey: 'DOUBAO_CODING_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultModel: 'ark-code-latest' },
  moonshot: { envKey: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  minimax: { envKey: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.chat/v1', defaultModel: 'MiniMax-Text-01' },
  siliconflow: { envKey: 'SILICONFLOW_API_KEY', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'deepseek-ai/DeepSeek-V3' },
  groq: { envKey: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  mistral: { envKey: 'MISTRAL_API_KEY', baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest' },
  xai: { envKey: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-2' },
  gemini: { envKey: 'GEMINI_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' },
  ollama: { envKey: 'OLLAMA_API_KEY', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3' },
  agnes: { envKey: 'AGNES_API_KEY', baseURL: 'https://apihub.agnes-ai.com/v1', defaultModel: 'agnes-2.0-flash' },
  // 补充供应商（确保ConfigPage中所有供应商都有baseURL）
  cohere: { envKey: 'COHERE_API_KEY', baseURL: 'https://api.cohere.ai/compatibility/v1', defaultModel: 'command-r-plus' },
  perplexity: { envKey: 'PERPLEXITY_API_KEY', baseURL: 'https://api.perplexity.ai', defaultModel: 'llama-3.1-sonar-large-128k-online' },
  together: { envKey: 'TOGETHER_API_KEY', baseURL: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3-70b-chat-hf' },
  fireworks: { envKey: 'FIREWORKS_API_KEY', baseURL: 'https://api.fireworks.ai/inference/v1', defaultModel: 'accounts/fireworks/models/llama-v3-70b-instruct' },
  ernie: { envKey: 'ERNIE_API_KEY', baseURL: 'https://qianfan.baidubce.com/v2', defaultModel: 'ernie-4.0-8k' },
  stepfun: { envKey: 'STEPFUN_API_KEY', baseURL: 'https://api.stepfun.com/v1', defaultModel: 'step-1-8k' },
  baichuan: { envKey: 'BAICHUAN_API_KEY', baseURL: 'https://api.baichuan-ai.com/v1', defaultModel: 'Baichuan4' },
  yi: { envKey: 'YI_API_KEY', baseURL: 'https://api.lingyiwanwu.com/v1', defaultModel: 'yi-large' },
  sensenova: { envKey: 'SENSENOVA_API_KEY', baseURL: 'https://api.sensenova.cn/compatible-mode/v1', defaultModel: 'SenseChat-5' },
  'doubao-agent': { envKey: 'DOUBAO_AGENT_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-1-5-pro-32k' },
  custom: { envKey: 'CUSTOM_API_KEY', baseURL: '', defaultModel: '' },
};

/** 根据模型名推断 provider（简化版，用于 saveApiKeysToProfiles） */
function inferProviderForModel(modelName) {
  if (!modelName) return null;
  if (modelName.startsWith('gpt') || modelName.startsWith('o1') || modelName.startsWith('o3')) return 'openai';
  if (modelName.startsWith('claude')) return 'anthropic';
  if (modelName.startsWith('deepseek-chat') || modelName.startsWith('deepseek-reasoner')) return 'deepseek';
  if (modelName.startsWith('deepseek-v')) return 'doubao-coding';
  if (modelName.startsWith('deepseek')) return 'deepseek';
  if (modelName.startsWith('qwen') || modelName.startsWith('qwq')) return 'qwen';
  if (modelName.startsWith('moonshot')) return 'moonshot';
  if (modelName.startsWith('gemini')) return 'gemini';
  if (modelName.startsWith('glm-5.1')) return 'doubao-coding';
  if (modelName.startsWith('glm')) return 'zhipu';
  if (modelName.startsWith('doubao-seed-2-0') || modelName.startsWith('doubao-seed-1')) return 'doubao'; // 标准API模型
  if (modelName.startsWith('doubao-seed')) return 'doubao-coding'; // Coding Plan 模型
  if (modelName.startsWith('doubao') || modelName.startsWith('ep-')) return 'doubao';
  if (modelName === 'ark-code-latest') return 'doubao-coding';
  if (modelName.startsWith('kimi')) return 'doubao-coding';
  if (modelName.startsWith('minimax-m') || modelName.startsWith('MiniMax-M')) return 'doubao-coding';
  if (modelName.startsWith('minimax') || modelName.startsWith('MiniMax')) return 'minimax';
  if (modelName.startsWith('llama') || modelName.startsWith('mixtral')) return 'groq';
  const CODING_PLAN = ['ark-code-latest', 'doubao-seed-code-preview-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite', 'doubao-seed-code', 'doubao-seed-2.0-mini', 'glm-5.1', 'deepseek-v4-flash', 'deepseek-v4-pro', 'kimi-k2.6', 'minimax-m2.7', 'minimax-m3'];
  if (CODING_PLAN.includes(modelName)) return 'doubao-coding';
  return null;
}

module.exports = {
  PROVIDER_ALIASES,
  PROVIDER_MAP,
  inferProviderForModel,
};
