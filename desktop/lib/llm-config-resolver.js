/**
 * LLM 配置解析器
 * 从 desktop/main.js 抽出 — 纯函数，依赖 providers.js 的常量
 */

const { PROVIDER_ALIASES, PROVIDER_MAP } = require('./providers');

function resolveLLMConfig(duanConfig, desktopConfig, requestedModel) {
  let profiles = duanConfig?.profiles || [];
  // 兼容 v2.0 对象格式：将 key 作为 id
  if (!Array.isArray(profiles)) {
    profiles = Object.entries(profiles).map(([id, p]) => ({
      id: id,
      provider: p.provider || '',
      apiKey: p.apiKey || '',
      model: p.model || '',
      baseURL: p.baseUrl || p.baseURL || '',
      label: p.label || '',
    }));
  }

  // Provider 别名映射（使用全局 PROVIDER_ALIASES）
  const providerAliases = PROVIDER_ALIASES;

  // Coding Plan 官方支持的模型列表
  const CODING_PLAN_MODELS = new Set([
    'ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro',
    'doubao-seed-2.0-lite', 'doubao-seed-code', 'doubao-seed-2.0-mini',
    'glm-5.1', 'deepseek-v4-flash', 'deepseek-v4-pro',
    'kimi-k2.6', 'minimax-m2.7', 'minimax-m3',
  ]);

  // 辅助函数：根据模型名推断 provider
  function inferProvider(modelName) {
    if (!modelName) return null;
    if (modelName.startsWith('gpt') || modelName.startsWith('o1') || modelName.startsWith('o3')) return 'openai';
    if (modelName.startsWith('claude')) return 'anthropic';
    if (modelName.startsWith('deepseek-chat') || modelName.startsWith('deepseek-reasoner')) return 'deepseek';
    if (modelName.startsWith('deepseek-v')) return 'doubao-coding'; // deepseek-v4-flash, deepseek-v4-pro 等 Coding Plan 模型
    if (modelName.startsWith('deepseek')) return 'deepseek';
    if (modelName.startsWith('glm')) {
      // glm-5.1 是 Coding Plan 模型，其他 glm 走智谱
      if (CODING_PLAN_MODELS.has(modelName)) return 'doubao-coding';
      return 'zhipu';
    }
    if (modelName.startsWith('qwen') || modelName.startsWith('qwq')) return 'qwen';
    if (modelName.startsWith('moonshot')) return 'moonshot';
    if (modelName.startsWith('kimi')) return 'doubao-coding'; // kimi-k2.6 是 Coding Plan 模型
    if (modelName.startsWith('gemini')) return 'gemini';
    if (modelName.startsWith('ernie')) return 'ernie';
    if (modelName.startsWith('MiniMax') || modelName.startsWith('minimax')) return 'minimax';
    if (modelName.startsWith('llama') || modelName.startsWith('mixtral') || modelName.startsWith('gemma')) {
      const hasGroq = profiles.some(p => p.provider === 'groq' && p.apiKey && p.apiKey.length > 8);
      if (hasGroq) return 'groq';
      const hasOpenrouter = profiles.some(p => p.provider === 'openrouter' && p.apiKey && p.apiKey.length > 8);
      if (hasOpenrouter) return 'openrouter';
      return 'groq';
    }
    if (modelName === 'ark-code-latest') return 'doubao-coding';
    if (modelName.startsWith('doubao-seed-2-0') || modelName.startsWith('doubao-seed-1')) return 'doubao'; // 标准API模型
    if (modelName.startsWith('doubao-seed')) return 'doubao-coding'; // Coding Plan 模型
    if (modelName.startsWith('doubao') || modelName.startsWith('ep-')) return 'doubao';
    // 兜底：检查是否在 Coding Plan 列表中
    if (CODING_PLAN_MODELS.has(modelName)) return 'doubao-coding';
    return null;
  }

  // 辅助函数：检查模型是否与 provider 兼容
  function isModelCompatibleWithProvider(modelName, providerName) {
    if (!modelName || !providerName) return false;
    const inferred = inferProvider(modelName);
    if (inferred) {
      // 推断结果与目标 provider 匹配（含别名）
      if (inferred === providerName) return true;
      if (providerAliases[inferred] === providerName) return true;
      if (providerAliases[providerName] === inferred) return true;
    }
    // 如果推断不出 provider（未知模型），允许任何有 key 的 provider
    if (!inferred) return true;
    return false;
  }

  // 1. 如果指定了模型，先尝试匹配 profile 的 model
  if (requestedModel) {
    for (const p of profiles) {
      if (p.model === requestedModel) {
        if (p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your_')) {
          if (p.model === 'ep-please-config') {
            return { apiKey: p.apiKey, baseURL: p.baseURL, actualModel: 'ep-please-config', provider: p.provider, error: '火山引擎接入点ID未配置，请在设置中填入 ep-xxx 格式的接入点ID' };
          }
          return { apiKey: p.apiKey, baseURL: p.baseURL, actualModel: p.model, provider: p.provider };
        }
      }
    }
  }

  // 2. 根据模型名推断 provider，然后查找该 provider 的 profile（含别名）
  const inferredProvider = requestedModel ? inferProvider(requestedModel) : null;
  if (inferredProvider) {
    let p = profiles.find(prof => prof.provider === inferredProvider);
    if (!p && providerAliases[inferredProvider]) {
      p = profiles.find(prof => prof.provider === providerAliases[inferredProvider]);
    }
    if (p && p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your_')) {
      const mapping = PROVIDER_MAP[inferredProvider] || PROVIDER_MAP[p.provider];
      const resolvedBaseURL = p.baseURL || (mapping ? mapping.baseURL : '');
      const resolvedModel = requestedModel || p.model || (mapping ? mapping.defaultModel : '');
      if (resolvedModel === 'ep-please-config') {
        return { apiKey: p.apiKey, baseURL: resolvedBaseURL, actualModel: 'ep-please-config', provider: inferredProvider, error: '火山引擎接入点ID未配置，请在设置中填入 ep-xxx 格式的接入点ID' };
      }
      return { apiKey: p.apiKey, baseURL: resolvedBaseURL, actualModel: resolvedModel, provider: inferredProvider };
    }
  }

  // 3. 使用 defaultProfileId 查找默认 profile
  //    如果请求的模型与 provider 不兼容，使用该 provider 的默认模型而非跳过
  let defaultProfile = null;
  if (duanConfig?.activeProfile) {
    defaultProfile = profiles.find(p => p.id === duanConfig.activeProfile || p.provider === duanConfig.activeProfile);
  }
  if (!defaultProfile && duanConfig?.defaultProfileId) {
    defaultProfile = profiles.find(p => p.id === duanConfig.defaultProfileId || p.provider === duanConfig.defaultProfileId);
  }
  if (!defaultProfile) {
    defaultProfile = profiles.find(p => p.isDefault) || profiles[0];
  }
  if (defaultProfile?.apiKey && defaultProfile.apiKey.length > 8 && !defaultProfile.apiKey.startsWith('your_')) {
    const provider = defaultProfile.provider;
    const mapping = PROVIDER_MAP[provider];
    const resolvedBaseURL = defaultProfile.baseURL || (mapping ? mapping.baseURL : '');
    // 关键修复：如果请求的模型与 provider 不兼容，使用该 provider 的默认模型
    let resolvedModel;
    if (requestedModel && isModelCompatibleWithProvider(requestedModel, provider)) {
      resolvedModel = requestedModel;
    } else {
      // 模型不兼容或未指定，使用 profile 自身的模型或 provider 默认模型
      resolvedModel = defaultProfile.model || (mapping ? mapping.defaultModel : '');
      if (requestedModel && requestedModel !== resolvedModel) {
        console.log(`[Config] 模型 ${requestedModel} 与 provider ${provider} 不兼容，回退到 ${resolvedModel}`);
      }
    }
    if (resolvedModel === 'ep-please-config') {
      return { apiKey: defaultProfile.apiKey, baseURL: resolvedBaseURL, actualModel: 'ep-please-config', provider, error: '火山引擎接入点ID未配置，请在设置中填入 ep-xxx 格式的接入点ID' };
    }
    return { apiKey: defaultProfile.apiKey, baseURL: resolvedBaseURL, actualModel: resolvedModel, provider };
  }

  // 4. 从桌面配置中查找（处理环境变量形式的 key）
  const apiKeys = desktopConfig?.apiKeys || {};
  for (const [provider, key] of Object.entries(apiKeys)) {
    if (key && typeof key === 'string' && key.length > 8 && !key.startsWith('your_') && key !== '已配置') {
      const mapping = PROVIDER_MAP[provider];
      if (mapping) {
        // 如果模型不兼容，使用 provider 默认模型
        let model;
        if (requestedModel && isModelCompatibleWithProvider(requestedModel, provider)) {
          model = requestedModel;
        } else {
          model = mapping.defaultModel;
          if (requestedModel && requestedModel !== model) {
            console.log(`[Config] 模型 ${requestedModel} 与 provider ${provider} 不兼容，回退到 ${model}`);
          }
        }
        if (model === 'ep-please-config') {
          return { apiKey: key, baseURL: mapping.baseURL, actualModel: model, provider, error: '火山引擎接入点ID未配置，请在设置中填入 ep-xxx 格式的接入点ID' };
        }
        return { apiKey: key, baseURL: mapping.baseURL, actualModel: model, provider };
      }
    }
  }

  // 5. 从环境变量中查找
  for (const [provider, mapping] of Object.entries(PROVIDER_MAP)) {
    const envKey = process.env[mapping.envKey];
    if (envKey && envKey.length > 8) {
      let model;
      if (requestedModel && isModelCompatibleWithProvider(requestedModel, provider)) {
        model = requestedModel;
      } else {
        model = mapping.defaultModel;
      }
      if (model === 'ep-please-config') {
        return { apiKey: envKey, baseURL: mapping.baseURL, actualModel: model, provider, error: '火山引擎接入点ID未配置，请在设置中填入 ep-xxx 格式的接入点ID' };
      }
      return { apiKey: envKey, baseURL: mapping.baseURL, actualModel: model, provider };
    }
  }

  // 6. 最后尝试：查找任意有有效 key 的 profile，不兼容时回退到 provider 默认模型
  for (const p of profiles) {
    if (p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your_')) {
      const mapping = PROVIDER_MAP[p.provider];
      const resolvedBaseURL = p.baseURL || (mapping ? mapping.baseURL : '');
      let resolvedModel;
      if (requestedModel && isModelCompatibleWithProvider(requestedModel, p.provider)) {
        resolvedModel = requestedModel;
      } else {
        resolvedModel = p.model || (mapping ? mapping.defaultModel : '');
      }
      if (resolvedModel === 'ep-please-config') {
        return { apiKey: p.apiKey, baseURL: resolvedBaseURL, actualModel: 'ep-please-config', provider: p.provider, error: '火山引擎接入点ID未配置，请在设置中填入 ep-xxx 格式的接入点ID' };
      }
      return { apiKey: p.apiKey, baseURL: resolvedBaseURL, actualModel: resolvedModel, provider: p.provider };
    }
  }

  return { apiKey: null, baseURL: null, actualModel: requestedModel || 'unknown', error: '未配置 API Key，请先在设置中配置' };
}

module.exports = {
  resolveLLMConfig,
};
