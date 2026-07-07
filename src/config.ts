/**
 * 配置管理器 — ConfigManager（向后兼容门面）
 *
 * 本文件是 v1.x API 的兼容门面，内部委托给 UnifiedConfigManager（v2.0）。
 * 三端（CLI/Web/Desktop）现在共享 ~/.duan/config.json 作为唯一配置源，
 * API Key 使用 AES-256-GCM 加密存储，文件变更通过 EventBus 实时广播。
 *
 * 旧代码可继续使用 ConfigManager / ProviderProfile / DuanConfig，
 * 新代码建议直接使用 UnifiedConfigManager。
 */

import * as path from 'path';
import { UnifiedConfigManager } from './core/unified-config.js';
import { duanPath } from './core/duan-paths.js';

// 路径常量（保持导出兼容）
const DUAN_DIR = duanPath();
const CONFIG_PATH = path.join(DUAN_DIR, 'config.json');

export interface ProviderProfile {
  id: string;
  label: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface MobileChannel {
  type: string;
  config: Record<string, string>;
}

export interface DuanConfig {
  configured: boolean;
  defaultProfileId: string;
  profiles: ProviderProfile[];
  workspace: string;
  setupVersion: number;
  lastRun: number;
  mobileChannels?: MobileChannel[];
  webPort?: string;
}

function _defaultConfig(): DuanConfig {
  return {
    configured: false,
    defaultProfileId: '',
    profiles: [],
    workspace: path.join(DUAN_DIR, 'workspace'),
    setupVersion: 0,
    lastRun: 0,
    mobileChannels: [],
  };
}

export class ConfigManager {
  /** 内部委托给统一配置管理器（单例） */
  private unified: UnifiedConfigManager;

  constructor() {
    this.unified = UnifiedConfigManager.getInstance();
  }

  isConfigured(): boolean {
    return Object.keys(this.unified.getProfiles()).length > 0;
  }

  /**
   * 返回 v1.x 兼容的 DuanConfig 结构
   * 将 v2.0 的 profiles 对象映射转换为数组
   */
  getConfig(): DuanConfig {
    const unified = this.unified.getConfig();
    const profiles: ProviderProfile[] = Object.entries(unified.profiles).map(([id, p]) => ({
      id,
      label: p.label || p.provider,
      provider: p.provider,
      baseURL: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
    }));
    return {
      configured: profiles.length > 0,
      defaultProfileId: unified.activeProfile,
      profiles,
      workspace: unified.workspace || path.join(DUAN_DIR, 'workspace'),
      setupVersion: 1,
      lastRun: unified.sync.lastModified,
      mobileChannels: unified.mobileChannels || [],
      webPort: unified.webPort || '',
    };
  }

  getProfiles(): ProviderProfile[] {
    return this.getConfig().profiles;
  }

  getDefaultProfile(): ProviderProfile | undefined {
    const cfg = this.getConfig();
    if (!cfg.defaultProfileId) return cfg.profiles[0];
    return cfg.profiles.find(p => p.id === cfg.defaultProfileId);
  }

  addProfile(profile: ProviderProfile): void {
    // 委托给统一配置管理器（会自动加密 apiKey）
    this.unified.upsertProfile(profile.id, {
      provider: profile.provider,
      apiKey: profile.apiKey,
      model: profile.model,
      baseUrl: profile.baseURL,
      label: profile.label,
    });
  }

  removeProfile(profileId: string): void {
    this.unified.removeProfile(profileId);
  }

  setDefaultProfile(profileId: string): void {
    this.unified.setActiveProfile(profileId);
  }

  cleanupDupes(): number {
    // v2.0 使用对象映射，天然无重复，此方法保留为空操作以兼容旧 API
    return 0;
  }

  setMobileChannels(channels: Record<string, string>): void {
    // 将扁平的 channels 映射转换为 MobileChannel[] 格式
    const mapped: MobileChannel[] = [];
    const channelMap: Record<string, string> = {
      WECOM_KEY: 'wecom', WECHAT_BOT_URL: 'wechat', TELEGRAM_BOT_TOKEN: 'telegram',
      DISCORD_BOT_TOKEN: 'discord', SLACK_BOT_TOKEN: 'slack', DINGTALK_WEBHOOK: 'dingtalk',
      FEISHU_WEBHOOK: 'feishu', WEBHOOK_URL: 'webhook',
      SMTP_HOST: 'email', SMTP_PORT: 'email', SMTP_USER: 'email', SMTP_PASS: 'email',
    };
    for (const [k, v] of Object.entries(channels)) {
      const type = channelMap[k] || 'custom';
      let existing = mapped.find(m => m.type === type);
      if (!existing) {
        existing = { type, config: {} };
        mapped.push(existing);
      }
      existing.config[k] = v;
    }
    this.unified.setMobileChannels(mapped);
  }

  getMobileChannels(): MobileChannel[] {
    return this.unified.getMobileChannels();
  }

  /** 获取 channels.* 新格式配置（对标 OpenClaw） */
  getChannelsConfig(): Record<string, unknown> {
    return this.unified.getChannels();
  }

  /** 设置 channels.* 新格式配置 */
  setChannelsConfig(channels: Record<string, unknown>): void {
    this.unified.setChannels(channels);
  }

  /** 获取单个通道新格式配置 */
  getChannelConfig(id: string): unknown {
    return this.unified.getChannel(id);
  }

  /** 设置单个通道新格式配置 */
  setChannelConfig(id: string, config: unknown): void {
    this.unified.setChannel(id, config);
  }

  setWebPort(port: string): void {
    this.unified.setWebPort(port);
  }

  getWebPort(): string {
    return this.unified.getWebPort();
  }

  setWorkspace(dir: string): void {
    this.unified.setWorkspace(dir);
  }

  applyEnv(): void {
    this.unified.applyToEnv();
  }

  private providerToEnvKey(provider: string): string {
    const map: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
      google: 'GOOGLE_API_KEY', zhipu: 'ZHIPU_API_KEY',
      aliyun: 'ALIYUN_API_KEY', siliconflow: 'SILICONFLOW_API_KEY',
      groq: 'GROQ_API_KEY', together: 'TOGETHER_API_KEY',
      fireworks: 'FIREWORKS_API_KEY', perplexity: 'PERPLEXITY_API_KEY',
      xai: 'XAI_API_KEY', moonshot: 'MOONSHOT_API_KEY',
      doubao: 'DOUBAO_API_KEY', 'doubao-coding': 'DOUBAO_CODING_API_KEY', 'coding_plan': 'DOUBAO_CODING_API_KEY', minimax: 'MINIMAX_API_KEY',
      agnes: 'AGNES_API_KEY', ollama: 'OLLAMA_API_KEY',
    };
    return map[provider] || `${provider.toUpperCase()}_API_KEY`;
  }

  getSummary(): string {
    return this.unified.getSummary();
  }

  /** 保存配置（v1.x 兼容，v2.0 自动持久化，此方法为空操作） */
  save(): void {
    // v2.0 中所有写操作已自动持久化，此方法保留为空操作以兼容旧 API
  }

  static getDuanDir(): string { return DUAN_DIR; }
  static getConfigPath(): string { return CONFIG_PATH; }
}
