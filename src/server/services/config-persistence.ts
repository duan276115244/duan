import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { AppConfig } from './app-context.js';
import { UnifiedConfigManager } from '../../core/unified-config.js';
import { duanPath } from '../../core/duan-paths.js';
import { atomicWriteJsonSync } from '../../core/atomic-write.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// After tsc compilation __dirname is dist/server/services/, so we need three
// levels up to reach the project root (where config.json / .env live).
// In dev (tsx) __dirname is src/server/services/, same three levels up.
export const CONFIG_PATH = path.join(__dirname, '../../../config.json');
export const ENV_PATH = path.join(__dirname, '../../../.env');
export const DUAN_CONFIG_PATH = duanPath('config.json');

// 统一配置管理器单例
const unifiedConfig = UnifiedConfigManager.getInstance();

/**
 * 加载配置：从统一配置源（~/.duan/config.json v2.0）读取
 * 转换为 AppConfig 结构供 Web Server 使用
 */
export function loadConfig(_configPath?: string, _envPath?: string): AppConfig {
  // 优先从统一配置读取（已解密）
  const unified = unifiedConfig.getConfig();
  const apiKeys: Record<string, string> = {};

  // 将 v2.0 profiles 转换为扁平的 apiKeys 映射
  for (const [, p] of Object.entries(unified.profiles)) {
    if (p.apiKey && p.apiKey.length > 8) {
      // 统一 provider 名称映射（与 llm-clients 用的名称对齐）
      const providerMap: Record<string, string> = {
        deepseek: 'deepseek', openai: 'openai', anthropic: 'anthropic',
        openrouter: 'openrouter', google: 'gemini', gemini: 'gemini',
        agnes: 'agnes', aliyun: 'qwen', qwen: 'qwen', zhipu: 'zhipu',
        siliconflow: 'siliconflow', doubao: 'doubao', bytedance: 'doubao',
        'doubao-coding': 'doubao-coding', 'coding_plan': 'doubao-coding',
        ernie: 'ernie', baidu: 'ernie', moonshot: 'moonshot', minimax: 'minimax',
        groq: 'groq', together: 'together', fireworks: 'fireworks',
        perplexity: 'perplexity', xai: 'xai', mistral: 'mistral',
        cohere: 'cohere', ollama: 'ollama', custom: 'custom',
      };
      const rawProvider = p.provider.replace(/-\d+$/, '');
      const mappedProvider = providerMap[rawProvider] || rawProvider;
      apiKeys[mappedProvider] = p.apiKey;

      // 设置环境变量
      if (p.baseUrl) {
        process.env[`${mappedProvider.toUpperCase()}_BASE_URL`] = p.baseUrl;
        if (mappedProvider === 'custom' && p.baseUrl.includes('coding')) {
          process.env.CODING_PLAN_BASE_URL = p.baseUrl;
          apiKeys['coding_plan'] = p.apiKey;
        }
      }
      const envKeyMap: Record<string, string> = {
        deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
        google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', agnes: 'AGNES_API_KEY',
        aliyun: 'ALIYUN_API_KEY', qwen: 'QWEN_API_KEY', zhipu: 'ZHIPU_API_KEY',
        siliconflow: 'SILICONFLOW_API_KEY', doubao: 'DOUBAO_API_KEY',
        bytedance: 'DOUBAO_API_KEY', 'doubao-coding': 'DOUBAO_CODING_API_KEY',
        ernie: 'ERNIE_API_KEY', baidu: 'ERNIE_API_KEY', moonshot: 'MOONSHOT_API_KEY',
        minimax: 'MINIMAX_API_KEY', groq: 'GROQ_API_KEY', together: 'TOGETHER_API_KEY',
        fireworks: 'FIREWORKS_API_KEY', perplexity: 'PERPLEXITY_API_KEY',
        xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY', cohere: 'COHERE_API_KEY',
        ollama: 'OLLAMA_API_KEY', custom: 'CUSTOM_API_KEY',
      };
      const envKey = envKeyMap[rawProvider] || `${rawProvider.toUpperCase()}_API_KEY`;
      if (!process.env[envKey]) {
        process.env[envKey] = p.apiKey;
      }
    }
  }

  // 从激活的 profile 获取默认模型
  const active = unifiedConfig.getActiveProfile();
  const defaultProvider = active?.provider || process.env.DEFAULT_MODEL_PROVIDER || 'groq';
  const defaultModel = active?.model || process.env.DEFAULT_MODEL || 'llama-3.3-70b-versatile';

  if (active) {
    process.env.DEFAULT_MODEL_PROVIDER = defaultProvider;
    process.env.DEFAULT_MODEL = defaultModel;
  }

  // 从环境变量补充未在 profiles 中配置的 API Key
  const envFallback: Record<string, string> = {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    mistral: process.env.MISTRAL_API_KEY || '',
    xai: process.env.XAI_API_KEY || '',
    cohere: process.env.COHERE_API_KEY || '',
    perplexity: process.env.PERPLEXITY_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    groq: process.env.GROQ_API_KEY || '',
    together: process.env.TOGETHER_API_KEY || '',
    fireworks: process.env.FIREWORKS_API_KEY || '',
    siliconflow: process.env.SILICONFLOW_API_KEY || '',
    qwen: process.env.QWEN_API_KEY || process.env.ALIYUN_API_KEY || '',
    zhipu: process.env.ZHIPU_API_KEY || '',
    doubao: process.env.DOUBAO_API_KEY || '',
    'doubao-coding': process.env.DOUBAO_CODING_API_KEY || '',
    ernie: process.env.ERNIE_API_KEY || '',
    moonshot: process.env.MOONSHOT_API_KEY || '',
    minimax: process.env.MINIMAX_API_KEY || '',
    agnes: process.env.AGNES_API_KEY || '',
    ollama: process.env.OLLAMA_API_KEY || process.env.OLLAMA_HOST || '',
    custom: process.env.CUSTOM_API_KEY || '',
  };
  for (const [k, v] of Object.entries(envFallback)) {
    if (v && !apiKeys[k]) apiKeys[k] = v;
  }

  return {
    apiKeys: apiKeys as AppConfig['apiKeys'],
    defaultModel,
    defaultProvider,
    settings: {
      autoSaveMemory: true,
      multiAgentMode: true,
      smartDetection: true,
    },
  };
}

/**
 * 保存配置：写入统一配置源（~/.duan/config.json v2.0）
 * 同时同步到本地 config.json 和 .env（向后兼容）
 */
export function saveConfig(config: AppConfig, configPath?: string, envPath?: string): void {
  const cfgPath = configPath || CONFIG_PATH;
  const env = envPath || ENV_PATH;

  try {
    // 1. 写入统一配置源（~/.duan/config.json v2.0）
    // 将 AppConfig.apiKeys 转换为 profiles 格式并更新
    const existingProfiles = unifiedConfig.getProfiles();
    const newProfiles: Record<string, { provider: string; apiKey: string; model: string; baseUrl: string; label?: string }> = {};

    for (const [provider, apiKey] of Object.entries(config.apiKeys)) {
      if (!apiKey || apiKey.length < 8) continue;
      // 查找已存在的同 provider profile，保留其 model 和 baseUrl
      const existingEntry = Object.entries(existingProfiles).find(([, p]) => p.provider === provider);
      const existingId = existingEntry?.[0];
      const existingP = existingEntry?.[1];
      newProfiles[existingId || `profile-${provider}-${Date.now()}`] = {
        provider,
        apiKey,
        model: existingP?.model || '',
        baseUrl: existingP?.baseUrl || '',
        label: existingP?.label || provider,
      };
    }

    // 如果有默认 provider，确保其 model 正确
    if (config.defaultProvider && config.defaultModel) {
      const defEntry = Object.entries(newProfiles).find(([, p]) => p.provider === config.defaultProvider);
      if (defEntry) {
        defEntry[1].model = config.defaultModel;
      }
    }

    // 使用 updateConfig 全量更新 profiles
    // 确定激活的 profile：优先匹配 defaultProvider，其次保留现有激活，最后用第一个
    const activeEntry = Object.entries(newProfiles).find(([, p]) => p.provider === config.defaultProvider);
    let activeProfileId = '';
    if (activeEntry) {
      activeProfileId = activeEntry[0];
    } else if (unifiedConfig.getActiveProfile()) {
      activeProfileId = unifiedConfig.getSyncStatus().activeProfile;
    } else {
      activeProfileId = Object.keys(newProfiles)[0] || '';
    }
    unifiedConfig.updateConfig({
      profiles: newProfiles,
      activeProfile: activeProfileId,
    });

    console.info('✅ 配置已保存到统一配置源:', DUAN_CONFIG_PATH);

    // 2. 向后兼容：同步写入本地 config.json
    try {
      const configDir = path.dirname(cfgPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      atomicWriteJsonSync(cfgPath, config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Config] 同步到本地 config.json 失败:', msg);
    }

    // 3. 向后兼容：写入 .env 文件
    try {
      const ALL_ENV_KEYS = [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY',
        'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'COHERE_API_KEY',
        'PERPLEXITY_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
        'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'SILICONFLOW_API_KEY',
        'QWEN_API_KEY', 'ZHIPU_API_KEY', 'DOUBAO_API_KEY', 'DOUBAO_CODING_API_KEY', 'ERNIE_API_KEY',
        'MOONSHOT_API_KEY', 'MINIMAX_API_KEY', 'AGNES_API_KEY',
        'OLLAMA_API_KEY', 'CUSTOM_API_KEY',
        'CUSTOM_BASE_URL', 'CUSTOM_MODEL',
        'DEFAULT_MODEL', 'DEFAULT_MODEL_PROVIDER',
      ];
      const apiKeyToEnv: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY', gemini: 'GEMINI_API_KEY',
        mistral: 'MISTRAL_API_KEY', xai: 'XAI_API_KEY', cohere: 'COHERE_API_KEY',
        perplexity: 'PERPLEXITY_API_KEY', openrouter: 'OPENROUTER_API_KEY',
        groq: 'GROQ_API_KEY', together: 'TOGETHER_API_KEY',
        fireworks: 'FIREWORKS_API_KEY', siliconflow: 'SILICONFLOW_API_KEY',
        qwen: 'QWEN_API_KEY', zhipu: 'ZHIPU_API_KEY', doubao: 'DOUBAO_API_KEY',
        'doubao-coding': 'DOUBAO_CODING_API_KEY',
        ernie: 'ERNIE_API_KEY', moonshot: 'MOONSHOT_API_KEY',
        minimax: 'MINIMAX_API_KEY', agnes: 'AGNES_API_KEY',
        ollama: 'OLLAMA_API_KEY', custom: 'CUSTOM_API_KEY',
      };
      const envLines: string[] = [];
      for (const [key, envVar] of Object.entries(apiKeyToEnv)) {
        const val = (config.apiKeys as Record<string, string>)[key];
        if (val) envLines.push(`${envVar}=${val}`);
      }
      envLines.push(`DEFAULT_MODEL=${config.defaultModel}`);
      envLines.push(`DEFAULT_MODEL_PROVIDER=${config.defaultProvider}`);
      if (process.env.CUSTOM_BASE_URL) envLines.push(`CUSTOM_BASE_URL=${process.env.CUSTOM_BASE_URL}`);
      if (process.env.CUSTOM_MODEL) envLines.push(`CUSTOM_MODEL=${process.env.CUSTOM_MODEL}`);

      const existingEnv = fs.existsSync(env) ? fs.readFileSync(env, 'utf-8') : '';
      const existingLines = existingEnv.split('\n').filter(l => {
        const lineKey = l.split('=')[0];
        return lineKey && !ALL_ENV_KEYS.includes(lineKey.trim());
      });
      fs.writeFileSync(env, [...existingLines, ...envLines].join('\n'), 'utf-8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Config] 写入 .env 失败:', msg);
    }
  } catch (e) {
    console.error('❌ 保存配置失败:', e);
    throw e;
  }
}

export function syncConfigToModelLibrary(
  modelLibrary: { updateApiKey: (provider: string, key: string) => void } | null,
  appConfig: AppConfig,
): void {
  if (!modelLibrary) return;
  for (const [provider, key] of Object.entries(appConfig.apiKeys)) {
    if (key) {
      modelLibrary.updateApiKey(provider, key);
    }
  }
  console.info('🔮 模型库配置已同步');
}
