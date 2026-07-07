/**
 * 配置管理子系统
 * 从 desktop/main.js 抽出 — 工厂模式
 *
 * 依赖：getMainWindow / getSettingsWindow / rootDir
 * 内部 require：crypto.js / providers.js
 * 内部状态：_loadConfigCache / _loadDuanConfigCache / configWatcher / configWatchDebounce / configSelfWrite
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { decryptApiKey, decryptProfiles, encryptApiKey } = require('./crypto');
const { PROVIDER_ALIASES, PROVIDER_MAP, inferProviderForModel } = require('./providers');

/** 默认配置（降级时使用） */
const DEFAULT_CONFIG = {
  model: 'deepseek-chat',
  apiProvider: 'deepseek',
  language: 'zh-CN',
  theme: 'dark',
  agentPort: 3001,
};

/**
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   getSettingsWindow: () => import('electron').BrowserWindow | null,
 *   rootDir: string,
 * }} deps
 */
function createConfigManager({ getMainWindow, getSettingsWindow, rootDir }) {
  const ROOT_DIR = rootDir;
  const CONFIG_PATH = path.join(ROOT_DIR, 'duan-config.json');

  // P1-5 修复：配置缓存（基于 mtime 失效，避免高频轮询重复读取文件）
  let _loadConfigCache = { mtime: 0, config: null };
  let _loadDuanConfigCache = { mtime: 0, config: null };

  // 配置文件监听状态
  let configWatcher = null;
  let configWatchDebounce = null;
  let configSelfWrite = false;

  /** 获取配置文件的 mtime（用于缓存失效判断） */
  function getConfigMtime() {
    try {
      const duanConfigPath = path.join(os.homedir(), '.duan', 'config.json');
      if (fs.existsSync(duanConfigPath)) {
        return fs.statSync(duanConfigPath).mtimeMs;
      }
    } catch { /* ignore */ }
    return 0;
  }

  /** 失效所有配置缓存（供 saveConfig 和 configWatcher 调用） */
  function invalidateConfigCache() {
    _loadConfigCache = { mtime: 0, config: null };
    _loadDuanConfigCache = { mtime: 0, config: null };
  }

  function loadConfig() {
    try {
      const duanConfigPath = path.join(os.homedir(), '.duan', 'config.json');
      // P1-5 修复：检查缓存是否有效
      const currentMtime = getConfigMtime();
      if (_loadConfigCache.config && _loadConfigCache.mtime === currentMtime && currentMtime > 0) {
        return _loadConfigCache.config;
      }

      if (fs.existsSync(duanConfigPath)) {
        const raw = JSON.parse(fs.readFileSync(duanConfigPath, 'utf-8'));
        // 兼容 v1.x（数组）和 v2.0（对象）格式
        let profiles = raw.profiles;
        if (!profiles) profiles = [];
        else if (!Array.isArray(profiles)) {
          // v2.0 对象格式：将 key 作为 id（解密 apiKey）
          profiles = Object.entries(profiles).map(([id, p]) => ({
            id: id,
            provider: p.provider || '',
            apiKey: decryptApiKey(p.apiKey || ''),
            model: p.model || '',
            baseURL: p.baseUrl || p.baseURL || '',
            label: p.label || '',
          }));
        } else {
          // v1.x 数组格式：解密 apiKey
          profiles = profiles.map(p => ({ ...p, apiKey: decryptApiKey(p.apiKey || '') }));
        }
        // 优先从活跃 profile 获取 model
        const activeProfileId = raw.activeProfile || raw.defaultProfileId;
        const defaultProfile = profiles.find(p => p.id === activeProfileId || p.provider === activeProfileId) || profiles[0];
        // model 优先级：活跃profile的model > defaultModel > 第一个profile的model > 回退值
        const model = defaultProfile?.model || raw.defaultModel || (profiles.length > 0 && profiles[0]?.model) || '';
        const provider = defaultProfile?.provider || raw.defaultProvider || (profiles.length > 0 && profiles[0]?.provider) || '';
        const result = {
          model: model,
          apiProvider: provider || 'deepseek',
          language: 'zh-CN',
          theme: 'dark',
          agentPort: parseInt(raw.webPort, 10) || 3001,
          apiKey: defaultProfile?.apiKey || '',
          baseURL: defaultProfile?.baseURL || defaultProfile?.baseUrl || '',
          defaultModel: raw.defaultModel || model,
          defaultProvider: raw.defaultProvider || provider,
          configured: raw.configured || false,
        };
        // 写入缓存
        _loadConfigCache = { mtime: currentMtime, config: result };
        return result;
      }
    } catch (err) { console.warn('[配置] loadConfig 失败:', err.message); }
    // 降级：尝试旧的 duan-config.json
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
      }
    } catch { /* ignore */ }
    return { ...DEFAULT_CONFIG };
  }

  function saveConfig(config) {
    // 保存到 ~/.duan/config.json（与 CLI 共用）
    const duanDir = path.join(os.homedir(), '.duan');
    const duanConfigPath = path.join(duanDir, 'config.json');
    try {
      if (!fs.existsSync(duanDir)) {
        fs.mkdirSync(duanDir, { recursive: true });
      }
      // 读取现有配置，合并更新
      let existing = {};
      if (fs.existsSync(duanConfigPath)) {
        existing = JSON.parse(fs.readFileSync(duanConfigPath, 'utf-8'));
      }
      // 更新扁平字段
      if (config.model) existing.defaultModel = config.model;
      if (config.apiProvider) existing.defaultProvider = config.apiProvider;
      if (config.language) existing.language = config.language;
      if (config.theme) existing.theme = config.theme;
      if (config.agentPort) existing.webPort = String(config.agentPort);
      existing.configured = true;
      existing.lastRun = Date.now();
      // 标记自身写入，跳过 watch 事件
      markConfigSelfWrite();
      fs.writeFileSync(duanConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Config] 保存 ~/.duan/config.json 失败:', err.message);
      throw err;
    }
    // 同时保存到旧路径（兼容）
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch { /* ignore */ }
    // P1-5 修复：保存后失效缓存
    invalidateConfigCache();
  }

  function loadDuanConfig() {
    const duanConfigPath = path.join(os.homedir(), '.duan', 'config.json');
    // P1-5 修复：检查缓存
    const currentMtime = getConfigMtime();
    if (_loadDuanConfigCache.config && _loadDuanConfigCache.mtime === currentMtime && currentMtime > 0) {
      return _loadDuanConfigCache.config;
    }

    try {
      if (fs.existsSync(duanConfigPath)) {
        const raw = JSON.parse(fs.readFileSync(duanConfigPath, 'utf-8'));
        // 解密 profiles 中的 apiKey
        if (raw.profiles) {
          raw.profiles = decryptProfiles(raw.profiles);
        }
        _loadDuanConfigCache = { mtime: currentMtime, config: raw };
        return raw;
      }
    } catch (err) { console.warn('[配置] loadDuanConfig 失败:', err.message); }
    // 降级：尝试旧的 duan-config.json
    try {
      const oldConfigPath = path.join(ROOT_DIR, 'duan-config.json');
      if (fs.existsSync(oldConfigPath)) {
        return JSON.parse(fs.readFileSync(oldConfigPath, 'utf-8'));
      }
    } catch { /* ignore */ }
    return {};
  }

  // ===== 统一配置文件监听（三端实时同步）=====
  // 监听 ~/.duan/config.json 变化，配置变更时通过 IPC 通知渲染进程

  function startConfigWatcher() {
    if (configWatcher) return;
    const duanConfigPath = path.join(os.homedir(), '.duan', 'config.json');
    try {
      if (!fs.existsSync(duanConfigPath)) {
        console.log('[Config] 配置文件不存在，跳过监听');
        return;
      }
      configWatcher = fs.watch(duanConfigPath, { persistent: false }, (eventType) => {
        // 防抖：合并短时间内的多次事件
        if (configWatchDebounce) clearTimeout(configWatchDebounce);
        configWatchDebounce = setTimeout(() => {
          handleConfigFileChange(eventType);
          configWatchDebounce = null;
        }, 200);
      });
      configWatcher.on('error', (err) => {
        console.error('[Config] 配置文件监听错误:', err.message);
        configWatcher = null;
        // 5 秒后自动重试
        setTimeout(() => startConfigWatcher(), 5000);
      });
      console.log('[Config] 配置文件监听已启动:', duanConfigPath);
    } catch (err) {
      console.error('[Config] 启动配置文件监听失败:', err.message);
    }
  }

  function stopConfigWatcher() {
    if (configWatcher) {
      configWatcher.close();
      configWatcher = null;
      console.log('[Config] 配置文件监听已停止');
    }
    if (configWatchDebounce) {
      clearTimeout(configWatchDebounce);
      configWatchDebounce = null;
    }
  }

  /** 检查配置文件监听是否活跃（供 IPC handler 查询状态） */
  function isConfigWatching() {
    return configWatcher !== null;
  }

  /** 配置文件变化处理：通过 IPC 通知所有渲染进程 */
  function handleConfigFileChange(eventType) {
    // 跳过自身写入触发的事件
    if (configSelfWrite) {
      configSelfWrite = false;
      return;
    }
    // P1-5 修复：外部配置变更时失效缓存
    invalidateConfigCache();
    try {
      const duanConfig = loadDuanConfig();
      const lastModified = duanConfig.sync?.lastModified || Date.now();
      console.log(`[Config] 检测到外部配置变更 (${eventType})，lastModified=${lastModified}`);

      // 通知主窗口
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('config:changed', {
          type: 'external',
          lastModified,
          activeProfile: duanConfig.activeProfile || duanConfig.defaultProfileId || '',
          profileCount: duanConfig.profiles ? (Array.isArray(duanConfig.profiles) ? duanConfig.profiles.length : Object.keys(duanConfig.profiles).length) : 0,
        });
      }
      // 通知设置窗口
      const sw = getSettingsWindow();
      if (sw && !sw.isDestroyed()) {
        sw.webContents.send('config:changed', {
          type: 'external',
          lastModified,
          activeProfile: duanConfig.activeProfile || duanConfig.defaultProfileId || '',
        });
      }
    } catch (err) {
      console.error('[Config] 处理配置变更失败:', err.message);
    }
  }

  /** 标记自身写入（用于跳过 watch 事件） */
  function markConfigSelfWrite() {
    configSelfWrite = true;
    // selfWrite 在 handleConfigFileChange 中立即清除，此处仅作为兜底超时
    setTimeout(() => { configSelfWrite = false; }, 2000);
  }

  function saveApiKeysToProfiles(apiKeys, defaultModel, defaultProvider, providerModels) {
    // ===== 1. 保存到 ~/.duan/config.json（与 CLI 共用，使用 v2.0 对象格式）=====
    const duanDir = path.join(os.homedir(), '.duan');
    const duanConfigPath = path.join(duanDir, 'config.json');
    let duanConfig = {};
    try {
      if (!fs.existsSync(duanDir)) {
        fs.mkdirSync(duanDir, { recursive: true });
      }
      if (fs.existsSync(duanConfigPath)) {
        duanConfig = JSON.parse(fs.readFileSync(duanConfigPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    // 统一转换为 v2.0 对象格式（与 UnifiedConfigManager 一致）
    let profiles = {};
    if (duanConfig.profiles) {
      if (Array.isArray(duanConfig.profiles)) {
        // v1.x 数组格式 → v2.0 对象格式（加密明文 apiKey）
        for (const p of duanConfig.profiles) {
          const id = p.id || p.provider || `profile-${Date.now()}`;
          profiles[id] = {
            provider: p.provider || '',
            apiKey: encryptApiKey(p.apiKey || ''), // 加密（encryptApiKey 会跳过已加密的）
            model: p.model || '',
            baseUrl: p.baseURL || p.baseUrl || '',
            label: p.label || p.provider || id,
          };
        }
      } else {
        profiles = { ...duanConfig.profiles };
      }
    }

    for (const [provider, apiKey] of Object.entries(apiKeys)) {
      if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.startsWith('your_')) continue;

      const mapping = PROVIDER_MAP[provider];
      if (!mapping) continue;

      // 设置环境变量（当前进程）
      process.env[mapping.envKey] = apiKey;
      if (provider === 'doubao') {
        process.env.DOUBAO_BASE_URL = mapping.baseURL;
      }
      if (provider === 'doubao-coding' || provider === 'coding_plan') {
        process.env.DOUBAO_CODING_API_KEY = apiKey;
        process.env.CODING_PLAN_BASE_URL = mapping.baseURL;
      }

      // 每个provider使用自己的模型，优先使用前端传入的providerModels，再使用该provider的默认模型
      let providerModel = providerModels?.[provider] || mapping.defaultModel;

      // 关键修复：确保模型与 provider 兼容
      if (providerModel && providerModel !== mapping.defaultModel) {
        const inferredProv = inferProviderForModel(providerModel);
        if (inferredProv && inferredProv !== provider && PROVIDER_ALIASES[inferredProv] !== provider && PROVIDER_ALIASES[provider] !== inferredProv) {
          console.log(`[Config] 模型 ${providerModel} 与 provider ${provider} 不兼容，使用默认模型 ${mapping.defaultModel}`);
          providerModel = mapping.defaultModel;
        }
      }

      // 使用 provider 作为 profile 的 key（v2.0 格式）
      const profileId = provider;
      profiles[profileId] = {
        provider: provider,
        apiKey: encryptApiKey(apiKey), // 加密存储
        model: providerModel,
        baseUrl: mapping.baseURL,
        label: mapping.label || provider.charAt(0).toUpperCase() + provider.slice(1),
      };
    }

    // 确定 activeProfile
    let activeProfile = duanConfig.activeProfile || duanConfig.defaultProfileId || '';
    if (defaultProvider && profiles[defaultProvider]) {
      activeProfile = defaultProvider;
    } else if (!activeProfile || !profiles[activeProfile]) {
      activeProfile = Object.keys(profiles)[0] || '';
    }

    // 构建完整的 v2.0 配置
    const v2Config = {
      version: '2.0',
      profiles: profiles,
      activeProfile: activeProfile,
      preferences: duanConfig.preferences || { theme: 'dark', language: 'zh-CN', autoApprove: ['safe', 'moderate'] },
      sync: {
        lastModified: Date.now(),
        deviceId: duanConfig.sync?.deviceId || 'desktop',
      },
      mobileChannels: duanConfig.mobileChannels || [],
      webPort: duanConfig.webPort || '3001',
      workspace: duanConfig.workspace || path.join(os.homedir(), '.duan', 'workspace'),
      configured: true,
      lastRun: Date.now(),
    };

    // 保留向后兼容字段
    if (defaultProvider && defaultModel) {
      v2Config.defaultModel = defaultModel;
      v2Config.defaultProvider = defaultProvider;
      process.env.DEFAULT_MODEL = defaultModel;
      process.env.DEFAULT_MODEL_PROVIDER = defaultProvider;
    }

    try {
      markConfigSelfWrite();
      fs.writeFileSync(duanConfigPath, JSON.stringify(v2Config, null, 2), 'utf-8');
      console.log('[Config] 已保存到 ~/.duan/config.json (v2.0 对象格式)');
    } catch (err) {
      console.error('[Config] 保存 ~/.duan/config.json 失败:', err.message);
    }

    // ===== 2. 兼容：也保存到旧路径 =====
    try {
      const oldConfigPath = path.join(ROOT_DIR, 'duan-config.json');
      fs.writeFileSync(oldConfigPath, JSON.stringify(v2Config, null, 2), 'utf-8');
    } catch { /* ignore */ }

    return v2Config;
  }

  return {
    loadConfig,
    saveConfig,
    loadDuanConfig,
    getConfigMtime,
    invalidateConfigCache,
    startConfigWatcher,
    stopConfigWatcher,
    isConfigWatching,
    handleConfigFileChange,
    markConfigSelfWrite,
    saveApiKeysToProfiles,
    DEFAULT_CONFIG,
  };
}

module.exports = { createConfigManager };
