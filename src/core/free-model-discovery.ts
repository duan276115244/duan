/**
 * 免费模型自动发现模块
 * 让 Agent 开箱即用 —— 自动检测和配置免费可用的 LLM
 *
 * 探测策略：
 * 1. 本地 Ollama（localhost:11434）—— 完全免费，无限制
 * 2. OpenRouter 免费模型 —— 需要 API Key，但有免费额度
 * 3. SiliconFlow 免费模型 —— 需要 API Key，新用户有免费额度
 * 4. Groq 免费模型 —— 需要 API Key，每天 14,400 次免费请求
 * 5. Google Gemini —— 需要 API Key，每天 1,500 次免费请求
 */

import * as http from 'http';
import * as https from 'https';
import { UnifiedConfigManager } from './unified-config.js';

/** 免费模型探测结果 */
export interface FreeModelDiscoveryResult {
  /** 发现的可用免费模型列表 */
  discovered: FreeModelEndpoint[];
  /** 自动配置的模型（已写入 config） */
  configured: string[];
  /** 推荐的默认模型 ID */
  recommendedDefault: string | null;
  /** Ollama 是否可用 */
  ollamaAvailable: boolean;
  /** Ollama 已安装的模型列表 */
  ollamaModels: string[];
}

/** 免费模型端点 */
export interface FreeModelEndpoint {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseURL: string;
  needsKey: boolean;
  /** 如果需要 Key，给出获取链接 */
  keyUrl?: string;
  priority: number;
  costPer1kTokens: number;
}

/** 免费模型端点定义 */
const FREE_ENDPOINTS: FreeModelEndpoint[] = [
  // ── 完全免费（无需 Key） ──
  {
    id: 'ollama-local',
    name: 'Ollama 本地模型',
    provider: 'ollama',
    model: 'llama3',
    baseURL: 'http://localhost:11434/v1',
    needsKey: false,
    priority: 10,
    costPer1kTokens: 0,
  },
  // ── 需要 Key 但有免费额度 ──
  {
    id: 'openrouter-deepseek-free',
    name: 'DeepSeek Chat (OpenRouter 免费)',
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat:free',
    baseURL: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    priority: 9,
    costPer1kTokens: 0,
  },
  {
    id: 'openrouter-deepseek-r1-free',
    name: 'DeepSeek R1 (OpenRouter 免费)',
    provider: 'openrouter',
    model: 'deepseek/deepseek-r1:free',
    baseURL: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    priority: 8,
    costPer1kTokens: 0,
  },
  {
    id: 'openrouter-llama-free',
    name: 'Llama 3.3 70B (OpenRouter 免费)',
    provider: 'openrouter',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    baseURL: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    priority: 7,
    costPer1kTokens: 0,
  },
  {
    id: 'siliconflow-deepseek-free',
    name: 'DeepSeek V3 (SiliconFlow 免费)',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    baseURL: 'https://api.siliconflow.cn/v1',
    needsKey: true,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    priority: 8,
    costPer1kTokens: 0,
  },
  {
    id: 'groq-llama-free',
    name: 'Llama 3.3 70B (Groq 免费)',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    priority: 7,
    costPer1kTokens: 0,
  },
  {
    id: 'google-gemini-flash-free',
    name: 'Gemini 2.0 Flash (Google 免费)',
    provider: 'google',
    model: 'gemini-2.0-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    priority: 7,
    costPer1kTokens: 0,
  },
];

/** HTTP 请求超时（毫秒） */
const PROBE_TIMEOUT = 3000;

/**
 * 发起 HTTP GET 请求探测端点是否可达
 */
function probeURL(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: PROBE_TIMEOUT }, res => {
      res.resume(); // 消费响应体，释放连接
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 检测本地 Ollama 是否运行，并获取已安装的模型列表
 */
async function probeOllama(): Promise<{ available: boolean; models: string[] }> {
  try {
    const available = await probeURL('http://localhost:11434/api/tags');
    if (!available) return { available: false, models: [] };

    // 尝试获取已安装的模型列表
    const models = await new Promise<string[]>(resolve => {
      http.get('http://localhost:11434/api/tags', { timeout: PROBE_TIMEOUT }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const names: string[] = (parsed.models || []).map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (m: any) => m.name || m.model || '');
            resolve(names.filter((n: string) => n.length > 0));
          } catch { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });

    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

/**
 * 从 UnifiedConfigManager 读取已有配置（自动解密 API Key，兼容 v1.x/v2.0 格式）
 */
function readExistingConfig(): { profiles: unknown[]; defaultProfileId: string } {
  try {
    const unified = UnifiedConfigManager.getInstance();
    const profilesMap = unified.getProfiles();
    const profiles = Object.entries(profilesMap).map(([id, p]) => ({
      id,
      provider: p.provider,
      apiKey: p.apiKey,
      model: p.model,
      baseURL: p.baseUrl,
      label: p.label,
    }));
    return { profiles, defaultProfileId: unified.getConfig().activeProfile || '' };
  } catch {}
  return { profiles: [], defaultProfileId: '' };
}

/**
 * 将免费模型写入统一配置（通过 UnifiedConfigManager，自动加密 API Key）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeFreeModelConfig(profiles: any[], defaultId: string): void {
  try {
    const unified = UnifiedConfigManager.getInstance();
    // 通过 upsertProfile 写入，自动加密 API Key 并触发文件监听
    for (const p of profiles) {
      const profileId = p.id || `${p.provider}:${Date.now()}`;
      unified.upsertProfile(profileId, {
        provider: p.provider,
        apiKey: p.apiKey || '',
        model: p.model,
        baseUrl: p.baseURL || '',
        label: p.label,
      });
    }
    // 设置默认 profile
    if (defaultId) {
      unified.setActiveProfile(defaultId);
    }
  } catch {}
}

/**
 * 设置环境变量（让当前进程立即可用）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFreeModelEnv(profiles: any[], defaultId: string): void {
  const envKeyMap: Record<string, string> = {
    ollama: 'OLLAMA_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    siliconflow: 'SILICONFLOW_API_KEY',
    groq: 'GROQ_API_KEY',
    google: 'GOOGLE_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    agnes: 'AGNES_API_KEY',
  };

  for (const p of profiles) {
    const envKey = envKeyMap[p.provider] || `${p.provider.toUpperCase()}_API_KEY`;
    if (p.apiKey && !process.env[envKey]) {
      process.env[envKey] = p.apiKey;
    }
    if (p.baseURL) {
      process.env[`${envKey}_BASE_URL`] = p.baseURL;
    }
  }

  const def = profiles.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => p.id === defaultId);
  if (def) {
    process.env.DEFAULT_MODEL_PROVIDER = def.provider;
    process.env.DEFAULT_MODEL = def.model;
  }
}

/**
 * 自动发现并配置免费模型
 *
 * @param existingKeys 已有的 API Key（从环境变量或 config 中读取）
 * @param autoWrite 是否自动写入配置文件
 * @returns 发现结果
 */
export async function discoverFreeModels(
  existingKeys?: Record<string, string>,
  autoWrite: boolean = true,
): Promise<FreeModelDiscoveryResult> {
  const result: FreeModelDiscoveryResult = {
    discovered: [],
    configured: [],
    recommendedDefault: null,
    ollamaAvailable: false,
    ollamaModels: [],
  };

  // 1. 探测 Ollama
  const ollama = await probeOllama();
  result.ollamaAvailable = ollama.available;
  result.ollamaModels = ollama.models;

  if (ollama.available) {
    const ollamaEndpoint = FREE_ENDPOINTS.find(e => e.id === 'ollama-local')!;
    result.discovered.push(ollamaEndpoint);

    // 如果有已安装的模型，用第一个作为默认
    if (ollama.models.length > 0) {
      ollamaEndpoint.model = ollama.models[0].replace(':latest', '');
    }
  }

  // 2. 检查已有的 API Key，匹配免费端点
  const keys = existingKeys || collectExistingKeys();

  for (const endpoint of FREE_ENDPOINTS) {
    if (endpoint.id === 'ollama-local') continue; // 已处理

    // 检查是否有对应的 Key
    const key = keys[endpoint.provider];
    if (key && key.length > 8 && !key.startsWith('your_')) {
      result.discovered.push(endpoint);
    }
  }

  // 3. 自动配置发现的免费模型
  if (result.discovered.length > 0 && autoWrite) {
    const { profiles: _existingProfiles, defaultProfileId } = readExistingConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newProfiles: any[] = [];

    for (const endpoint of result.discovered) {
      const profileId = `${endpoint.provider}:${Date.now()}_${endpoint.id}`;

      const profile = {
        id: profileId,
        label: endpoint.name,
        provider: endpoint.provider,
        baseURL: endpoint.baseURL,
        apiKey: endpoint.needsKey ? (keys[endpoint.provider] || '') : 'ollama-local',
        model: endpoint.model,
      };

      newProfiles.push(profile);
      result.configured.push(endpoint.id);
    }

    // 选择推荐默认模型（优先级最高的）
    const sorted = [...result.discovered].sort((a, b) => b.priority - a.priority);
    const recommended = sorted[0];
    const recommendedProfile = newProfiles.find(p => p.label === recommended.name);
    const recommendedId = recommendedProfile?.id || newProfiles[0]?.id || '';

    // 只有在没有默认 profile 时才设置
    const finalDefaultId = defaultProfileId || recommendedId;
    result.recommendedDefault = recommended?.id || null;

    writeFreeModelConfig(newProfiles, finalDefaultId);
    applyFreeModelEnv(newProfiles, finalDefaultId);
  }

  return result;
}

/**
 * 收集当前环境中已有的 API Key
 */
function collectExistingKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  const envMappings: Array<{ envKey: string; provider: string }> = [
    { envKey: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
    { envKey: 'OPENROUTER_API_KEY', provider: 'openrouter' },
    { envKey: 'SILICONFLOW_API_KEY', provider: 'siliconflow' },
    { envKey: 'GROQ_API_KEY', provider: 'groq' },
    { envKey: 'GOOGLE_API_KEY', provider: 'google' },
    { envKey: 'AGNES_API_KEY', provider: 'agnes' },
    { envKey: 'ALIYUN_API_KEY', provider: 'aliyun' },
    { envKey: 'ZHIPU_API_KEY', provider: 'zhipu' },
    { envKey: 'DOUBAO_API_KEY', provider: 'doubao' },
    { envKey: 'MOONSHOT_API_KEY', provider: 'moonshot' },
    { envKey: 'MINIMAX_API_KEY', provider: 'minimax' },
  ];

  for (const { envKey, provider } of envMappings) {
    const val = process.env[envKey];
    if (val && val.length > 8 && !val.startsWith('your_')) {
      keys[provider] = val;
    }
  }

  // 也从 UnifiedConfigManager 读取（自动解密 API Key，兼容 v1.x/v2.0 格式）
  try {
    const unified = UnifiedConfigManager.getInstance();
    const profilesMap = unified.getProfiles();
    for (const [, p] of Object.entries(profilesMap)) {
      const ak = p.apiKey || '';
      if (ak && ak.length > 8 && !ak.startsWith('your_')) {
        keys[p.provider] = ak;
      }
    }
  } catch {}

  return keys;
}
