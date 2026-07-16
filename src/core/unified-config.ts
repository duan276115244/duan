/**
 * 统一配置管理器 — UnifiedConfigManager
 *
 * 三端（CLI / Web / Desktop）配置互通的核心：
 * - 使用 ~/.duan/config.json 作为唯一配置源（v2.0 格式）
 * - AES-256-GCM 加密存储 API Key
 * - fs.watch 监听文件变化，实时同步到所有端
 * - 通过 EventBus 广播配置变更事件
 * - 冲突解决策略：最后修改时间优先（lastModified wins）
 * - 向后兼容：自动迁移 v1.x 旧版配置格式
 * - 配置文件权限 600（POSIX）
 *
 * 配置文件结构（v2.0）：
 * {
 *   "version": "2.0",
 *   "profiles": { "default": { provider, apiKey(加密), model, baseUrl } },
 *   "activeProfile": "default",
 *   "preferences": { theme, language, autoApprove },
 *   "sync": { lastModified, deviceId }
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 单个 Provider 配置（v2.0） */
export interface UnifiedProfile {
  provider: string;
  /** 加密后的 API Key（enc: 前缀标识） */
  apiKey: string;
  model: string;
  baseUrl: string;
  label?: string;
}

/** 用户偏好设置 */
export interface UnifiedPreferences {
  theme?: 'dark' | 'light';
  language?: 'zh-CN' | 'en-US';
  autoApprove?: string[];
}

/** 同步元信息 */
export interface UnifiedSyncMeta {
  lastModified: number;
  deviceId: string;
}

/** v2.0 统一配置结构 */
export interface UnifiedConfig {
  version: string;
  profiles: Record<string, UnifiedProfile>;
  activeProfile: string;
  preferences: UnifiedPreferences;
  sync: UnifiedSyncMeta;
  /** 向后兼容：移动通道配置（v1.x 遗留字段） */
  mobileChannels?: Array<{ type: string; config: Record<string, string> }>;
  /** 通道配置（v2.0 新格式，对标 OpenClaw）：feishu/telegram/discord/... */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channels?: Record<string, any>;
  /** 向后兼容：Web 端口 */
  webPort?: string;
  /** 向后兼容：工作区路径 */
  workspace?: string;
}

/** 同步状态信息 */
export interface SyncStatus {
  lastModified: number;
  deviceId: string;
  watching: boolean;
  configPath: string;
  profileCount: number;
  activeProfile: string;
}

// ============ 常量 ============

const DUAN_DIR = duanPath();
const CONFIG_PATH = path.join(DUAN_DIR, 'config.json');
const CONFIG_VERSION = '2.0';
const ENCRYPTED_PREFIX = 'enc:';
const WATCH_DEBOUNCE_MS = 200;

/** 生成设备 ID：基于 hostname + username 的稳定哈希 */
function generateDeviceId(): string {
  const host = os.hostname() || 'unknown-host';
  const user = os.userInfo().username || 'unknown-user';
  return crypto.createHash('sha256').update(`${host}:${user}`).digest('hex').substring(0, 16);
}

/** 生成加密主密钥：基于机器特征派生（同一台机器三端可解密） */
function deriveMasterKey(): Buffer {
  const host = os.hostname() || 'unknown-host';
  const user = os.userInfo().username || 'unknown-user';
  // 机器特征 + 固定盐，确保同一台机器三端密钥一致
  const seed = `duan-unified-config:${host}:${user}`;
  return crypto.scryptSync(seed, 'duan-aes-256-salt', 32);
}

// ============ 加密工具 ============

class ConfigEncryptor {
  private algorithm = 'aes-256-gcm';
  private masterKey: Buffer;

  constructor() {
    this.masterKey = deriveMasterKey();
  }

  /** 加密明文 API Key，返回带 enc: 前缀的密文 */
  encrypt(plain: string): string {
    if (!plain || plain.startsWith(ENCRYPTED_PREFIX)) return plain;
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.masterKey, iv) as crypto.CipherGCM;
      let encrypted = cipher.update(plain, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();
      return ENCRYPTED_PREFIX + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
    } catch (err) {
      // 加密失败：返回带标记的明文前缀，绝不裸露存储 API Key
      // 使用 base64 编码避免明文直接写入配置文件
      logger.error('[ConfigEncryptor] 加密失败，使用 base64 降级存储', { error: err instanceof Error ? err.message : String(err) });
      return ENCRYPTED_PREFIX + 'base64:' + Buffer.from(plain, 'utf8').toString('base64');
    }
  }

  /** 解密 API Key，非加密格式直接返回原文 */
  decrypt(stored: string): string {
    if (!stored || !stored.startsWith(ENCRYPTED_PREFIX)) return stored;
    try {
      const payload = stored.substring(ENCRYPTED_PREFIX.length);
      // 降级模式：base64 编码
      if (payload.startsWith('base64:')) {
        return Buffer.from(payload.substring(7), 'base64').toString('utf8');
      }
      const parts = payload.split(':');
      if (parts.length !== 3) return stored;
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];
      const decipher = crypto.createDecipheriv(this.algorithm, this.masterKey, iv) as crypto.DecipherGCM;
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      // 解密失败：返回空字符串而非密文，避免用密文当 API Key 调用
      logger.error('[ConfigEncryptor] 解密失败，返回空字符串');
      return '';
    }
  }
}

// ============ 主类 ============

export class UnifiedConfigManager {
  private static instance: UnifiedConfigManager;
  private config: UnifiedConfig;
  private encryptor: ConfigEncryptor;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceId: string;
  private log = logger.child({ module: 'UnifiedConfig' });
  /** 是否在当前进程内写入（用于跳过自身触发的 watch 事件） */
  private selfWrite = false;

  private constructor() {
    this.encryptor = new ConfigEncryptor();
    this.deviceId = generateDeviceId();
    this.ensureDir();
    this.config = this.loadAndMigrate();
  }

  static getInstance(): UnifiedConfigManager {
    if (!UnifiedConfigManager.instance) {
      UnifiedConfigManager.instance = new UnifiedConfigManager();
    }
    return UnifiedConfigManager.instance;
  }

  // ========== 路径与状态 ==========

  static getConfigPath(): string { return CONFIG_PATH; }
  static getDuanDir(): string { return DUAN_DIR; }

  /** 获取同步状态 */
  getSyncStatus(): SyncStatus {
    return {
      lastModified: this.config.sync.lastModified,
      deviceId: this.config.sync.deviceId,
      watching: this.watcher !== null,
      configPath: CONFIG_PATH,
      profileCount: Object.keys(this.config.profiles).length,
      activeProfile: this.config.activeProfile,
    };
  }

  // ========== 读取 API ==========

  /** 获取完整配置（API Key 已解密） */
  getConfig(): UnifiedConfig {
    return this.decryptConfig(this.config);
  }

  /** 获取脱敏配置（用于日志/API 返回，apiKey 显示为 ****） */
  getMaskedConfig(): UnifiedConfig {
    const decrypted = this.decryptConfig(this.config);
    const masked: UnifiedConfig = structuredClone(decrypted);
    for (const key of Object.keys(masked.profiles)) {
      const p = masked.profiles[key];
      if (p.apiKey) {
        p.apiKey = p.apiKey.length > 8
          ? p.apiKey.substring(0, 4) + '****' + p.apiKey.substring(p.apiKey.length - 4)
          : '****';
      }
    }
    return masked;
  }

  /** 获取所有 profile（已解密） */
  getProfiles(): Record<string, UnifiedProfile> {
    return this.decryptConfig(this.config).profiles;
  }

  /** 获取指定 profile（已解密） */
  getProfile(id: string): UnifiedProfile | undefined {
    const p = this.config.profiles[id];
    if (!p) return undefined;
    return { ...p, apiKey: this.encryptor.decrypt(p.apiKey) };
  }

  /** 解密单个 API Key（自动处理 enc: 前缀，失败时返回原文） */
  decryptApiKey(stored: string): string {
    return this.encryptor.decrypt(stored);
  }

  /** 加密单个 API Key（自动添加 enc: 前缀，失败时返回原文） */
  encryptApiKey(plain: string): string {
    return this.encryptor.encrypt(plain);
  }

  /** 获取当前激活的 profile（已解密） */
  getActiveProfile(): UnifiedProfile | undefined {
    return this.getProfile(this.config.activeProfile);
  }

  /** 获取偏好设置 */
  getPreferences(): UnifiedPreferences {
    return { ...this.config.preferences };
  }

  /** 获取移动通道配置（向后兼容） */
  getMobileChannels(): Array<{ type: string; config: Record<string, string> }> {
    return this.config.mobileChannels || [];
  }

  /** 设置移动通道配置（向后兼容） */
  setMobileChannels(channels: Array<{ type: string; config: Record<string, string> }>): void {
    this.config.mobileChannels = channels;
    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.mobilechannels.updated');
  }

  /** 获取 channels.* 配置（v2.0 新格式，对标 OpenClaw） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChannels(): Record<string, any> {
    return this.config.channels || {};
  }

  /** 设置 channels.* 配置 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setChannels(channels: Record<string, any>): void {
    this.config.channels = channels;
    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.channels.updated');
  }

  /** 获取单个通道配置 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChannel(id: string): any {
    const channels = this.getChannels();
    return channels[id] || null;
  }

  /** 更新单个通道配置 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setChannel(id: string, config: any): void {
    const channels = this.getChannels();
    channels[id] = { ...(channels[id] || {}), ...config };
    this.setChannels(channels);
  }

  /** 获取 Web 端口（向后兼容） */
  getWebPort(): string {
    return this.config.webPort || '';
  }

  /** 设置 Web 端口（向后兼容） */
  setWebPort(port: string): void {
    this.config.webPort = port;
    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.webport.updated');
  }

  /** 获取工作区路径（向后兼容） */
  getWorkspace(): string {
    return this.config.workspace || path.join(DUAN_DIR, 'workspace');
  }

  /** 设置工作区路径（向后兼容） */
  setWorkspace(dir: string): void {
    this.config.workspace = dir;
    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.workspace.updated');
  }

  // ========== 写入 API ==========

  /**
   * 全量更新配置（PUT 语义）
   * 会自动加密 apiKey、更新 sync 元信息、触发事件
   */
  updateConfig(partial: Partial<UnifiedConfig>): UnifiedConfig {
    // 冲突检测：如果传入的 sync.lastModified 比当前旧，拒绝更新
    if (partial.sync?.lastModified && partial.sync.lastModified < this.config.sync.lastModified) {
      this.log.warn('配置更新被拒绝：传入数据比当前版本旧', {
        incoming: partial.sync.lastModified,
        current: this.config.sync.lastModified,
      });
      return this.decryptConfig(this.config);
    }

    if (partial.profiles) {
      // 加密所有 apiKey
      const encryptedProfiles: Record<string, UnifiedProfile> = {};
      for (const [id, p] of Object.entries(partial.profiles)) {
        encryptedProfiles[id] = {
          ...p,
          apiKey: this.encryptor.encrypt(p.apiKey),
        };
      }
      this.config.profiles = encryptedProfiles;
    }
    if (partial.activeProfile !== undefined) {
      this.config.activeProfile = partial.activeProfile;
    }
    if (partial.preferences) {
      this.config.preferences = { ...this.config.preferences, ...partial.preferences };
    }

    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.updated');
    return this.decryptConfig(this.config);
  }

  /**
   * 新增/更新单个 profile（POST 语义）
   * 如果 profileId 已存在则更新，否则新增
   */
  upsertProfile(profileId: string, profile: UnifiedProfile): UnifiedConfig {
    const encrypted: UnifiedProfile = {
      ...profile,
      apiKey: this.encryptor.encrypt(profile.apiKey),
    };
    const isNew = !this.config.profiles[profileId];
    this.config.profiles[profileId] = encrypted;

    // 如果是第一个 profile，自动设为激活
    if (!this.config.activeProfile || Object.keys(this.config.profiles).length === 1) {
      this.config.activeProfile = profileId;
    }

    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange(isNew ? 'config.profile.added' : 'config.profile.updated', { profileId });
    return this.decryptConfig(this.config);
  }

  /**
   * 删除指定 profile（DELETE 语义）
   */
  removeProfile(profileId: string): boolean {
    if (!this.config.profiles[profileId]) return false;
    delete this.config.profiles[profileId];

    // 如果删除的是激活 profile，自动切换到第一个
    if (this.config.activeProfile === profileId) {
      const remaining = Object.keys(this.config.profiles);
      this.config.activeProfile = remaining[0] || '';
    }

    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.profile.removed', { profileId });
    return true;
  }

  /** 设置激活的 profile */
  setActiveProfile(profileId: string): boolean {
    if (!this.config.profiles[profileId]) return false;
    this.config.activeProfile = profileId;
    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.profile.activated', { profileId });
    // P0 供应商热切换：同时 emit config.external.changed，
    // 让 ModelLibrary 监听器自动 reloadFromUnifiedConfig() 重载 apiKey 并清理客户端缓存。
    // 之前只 emit config.profile.activated，但 ModelLibrary 监听的是 config.external.changed，
    // 事件名不匹配导致运行时切换不生效（需重启进程才生效）。
    this.broadcastChange('config.external.changed');
    return true;
  }

  /** 更新偏好设置 */
  updatePreferences(prefs: Partial<UnifiedPreferences>): UnifiedPreferences {
    this.config.preferences = { ...this.config.preferences, ...prefs };
    this.config.sync.lastModified = Date.now();
    this.config.sync.deviceId = this.deviceId;
    this.persist();
    this.broadcastChange('config.preferences.updated');
    return { ...this.config.preferences };
  }

  // ========== 文件监听 ==========

  /**
   * 启动文件监听（fs.watch）
   * 配置文件变化时自动重新加载并广播事件
   */
  startWatch(): boolean {
    if (this.watcher) return true;
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        this.log.warn('配置文件不存在，无法启动监听', { path: CONFIG_PATH });
        return false;
      }
      this.watcher = fs.watch(CONFIG_PATH, { persistent: false }, (eventType) => {
        // 防抖：合并短时间内的多次事件
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.handleFileChange(eventType);
          this.debounceTimer = null;
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', (err) => {
        this.log.error('配置文件监听错误', { error: err.message });
        this.watcher = null;
        // 5 秒后自动重试
        setTimeout(() => this.startWatch(), 5000);
      });
      this.log.info('配置文件监听已启动', { path: CONFIG_PATH });
      return true;
    } catch (err: unknown) {
      this.log.error('启动配置文件监听失败', { error: (err instanceof Error ? err.message : String(err)) });
      return false;
    }
  }

  /** 停止文件监听 */
  stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.log.info('配置文件监听已停止');
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 文件变化处理：重新加载并广播 */
  private handleFileChange(_eventType: string): void {
    // 跳过自身写入触发的事件
    if (this.selfWrite) {
      this.selfWrite = false;
      return;
    }
    try {
      const newConfig = this.loadAndMigrate();
      // 冲突解决：比较 lastModified，最新的胜出
      if (newConfig.sync.lastModified > this.config.sync.lastModified) {
        this.config = newConfig;
        this.log.info('检测到外部配置变更，已重新加载', {
          lastModified: newConfig.sync.lastModified,
          deviceId: newConfig.sync.deviceId,
        });
        this.broadcastChange('config.external.changed');
      }
    } catch (err: unknown) {
      this.log.error('重新加载配置失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  // ========== 持久化 ==========

  /** 写入配置文件（原子写入 + 权限设置） */
  private persist(): void {
    try {
      this.ensureDir();
      this.selfWrite = true;
      const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf-8');
      // POSIX 系统设置 600 权限
      if (process.platform !== 'win32') {
        try { fs.chmodSync(tmp, 0o600); } catch {}
      }
      fs.renameSync(tmp, CONFIG_PATH);
      // selfWrite 在 handleFileChange 中立即清除（见 handleFileChange），此处不延迟
    } catch (err: unknown) {
      this.selfWrite = false;
      this.log.error('配置写入失败', { error: (err instanceof Error ? err.message : String(err)) });
      throw err;
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(DUAN_DIR)) {
      fs.mkdirSync(DUAN_DIR, { recursive: true });
    }
  }

  // ========== 加载与迁移 ==========

  /** 加载配置文件，自动从 v1.x 迁移到 v2.0 */
  private loadAndMigrate(): UnifiedConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        // 已经是 v2.0 格式
        if (raw.version === CONFIG_VERSION) {
          return this.normalizeConfig(raw);
        }
        // v1.x 格式：profiles 是数组，需要迁移
        return this.migrateFromV1(raw);
      }
    } catch (err: unknown) {
      this.log.error('加载配置文件失败，使用默认配置', { error: (err instanceof Error ? err.message : String(err)) });
    }
    return this.defaultConfig();
  }

  /** 从 v1.x 格式迁移到 v2.0
   *  v1.x: { profiles: [{id, provider, apiKey, model, baseURL, label}], defaultProfileId, ... }
   *  v2.0: { version, profiles: {id: {provider, apiKey, model, baseUrl, label}}, activeProfile, ... }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private migrateFromV1(old: any): UnifiedConfig {
    const profiles: Record<string, UnifiedProfile> = {};
    let activeProfile = '';

    if (Array.isArray(old.profiles)) {
      for (const p of old.profiles) {
        const id = p.id || p.provider || `profile-${Date.now()}`;
        profiles[id] = {
          provider: p.provider || '',
          apiKey: p.apiKey || '',
          model: p.model || '',
          baseUrl: p.baseURL || p.base_url || '',
          label: p.label || p.provider || id,
        };
      }
    }

    activeProfile = old.defaultProfileId || Object.keys(profiles)[0] || '';

    const migrated: UnifiedConfig = {
      version: CONFIG_VERSION,
      profiles,
      activeProfile,
      preferences: {
        theme: old.theme === 'light' ? 'light' : 'dark',
        language: old.language || 'zh-CN',
        autoApprove: Array.isArray(old.autoApprove) ? old.autoApprove : ['safe', 'moderate'],
      },
      sync: {
        lastModified: old.lastRun || Date.now(),
        deviceId: this.deviceId,
      },
      // 保留 v1.x 遗留字段
      mobileChannels: old.mobileChannels,
      channels: old.channels || {},
      webPort: old.webPort,
      workspace: old.workspace,
    };

    this.log.info('配置已从 v1.x 迁移到 v2.0', {
      profileCount: Object.keys(profiles).length,
      activeProfile,
    });

    // 立即持久化迁移后的配置
    this.config = migrated;
    try {
      this.ensureDir();
      this.selfWrite = true;
      const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(migrated, null, 2), 'utf-8');
      if (process.platform !== 'win32') {
        try { fs.chmodSync(tmp, 0o600); } catch {}
      }
      fs.renameSync(tmp, CONFIG_PATH);
      setTimeout(() => { this.selfWrite = false; }, 300);
    } catch (err: unknown) {
      this.selfWrite = false;
      this.log.error('迁移后写入配置失败', { error: (err instanceof Error ? err.message : String(err)) });
    }

    return migrated;
  }

  /** 规范化配置结构，补全缺失字段 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizeConfig(raw: any): UnifiedConfig {
    // 处理 profiles 可能是数组（v1.x 兼容）或对象（v2.0）的情况
    let profiles: Record<string, UnifiedProfile> = {};
    if (Array.isArray(raw.profiles)) {
      // v1.x 数组格式：转换为 v2.0 对象格式
      for (const p of raw.profiles) {
        const id = p.id || p.provider || `profile-${Date.now()}`;
        profiles[id] = {
          provider: p.provider || '',
          apiKey: p.apiKey || '',
          model: p.model || '',
          baseUrl: p.baseURL || p.baseUrl || p.base_url || '',
          label: p.label || p.provider || id,
        };
      }
    } else if (raw.profiles && typeof raw.profiles === 'object') {
      profiles = raw.profiles;
    }

    // 确定 activeProfile：优先使用配置中的值，如果不存在则使用第一个 profile
    let activeProfile = raw.activeProfile || raw.defaultProfileId || '';
    if (!activeProfile || !profiles[activeProfile]) {
      activeProfile = Object.keys(profiles)[0] || '';
    }

    return {
      version: CONFIG_VERSION,
      profiles,
      activeProfile,
      preferences: {
        theme: raw.preferences?.theme || 'dark',
        language: raw.preferences?.language || 'zh-CN',
        autoApprove: raw.preferences?.autoApprove || ['safe', 'moderate'],
      },
      sync: {
        lastModified: raw.sync?.lastModified || Date.now(),
        deviceId: raw.sync?.deviceId || this.deviceId,
      },
      // 保留向后兼容字段
      mobileChannels: raw.mobileChannels,
      channels: raw.channels || {},
      webPort: raw.webPort,
      workspace: raw.workspace,
    };
  }

  private defaultConfig(): UnifiedConfig {
    return {
      version: CONFIG_VERSION,
      profiles: {},
      activeProfile: '',
      preferences: {
        theme: 'dark',
        language: 'zh-CN',
        autoApprove: ['safe', 'moderate'],
      },
      sync: {
        lastModified: Date.now(),
        deviceId: this.deviceId,
      },
      channels: {},
    };
  }

  // ========== 工具方法 ==========

  /** 解密整个配置的 apiKey 字段（返回副本） */
  private decryptConfig(config: UnifiedConfig): UnifiedConfig {
    const result: UnifiedConfig = structuredClone(config);
    for (const key of Object.keys(result.profiles)) {
      result.profiles[key].apiKey = this.encryptor.decrypt(result.profiles[key].apiKey);
    }
    return result;
  }

  /** 通过 EventBus 广播配置变更事件 */
  private broadcastChange(eventType: string, extra?: Record<string, unknown>): void {
    try {
      EventBus.getInstance().emitSync(eventType, {
        ...extra,
        lastModified: this.config.sync.lastModified,
        deviceId: this.config.sync.deviceId,
        activeProfile: this.config.activeProfile,
        profileCount: Object.keys(this.config.profiles).length,
      }, { source: 'UnifiedConfig' });
    } catch (err: unknown) {
      this.log.error('广播配置变更事件失败', { eventType, error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  // ========== 环境变量同步 ==========

  /** 将配置同步到环境变量（供 CLI/Server 进程使用） */
  applyToEnv(): void {
    const active = this.getActiveProfile();
    if (active) {
      process.env.DEFAULT_MODEL_PROVIDER = active.provider;
      process.env.DEFAULT_MODEL = active.model;
      // 设置 provider 对应的标准环境变量
      const envKey = this.providerToEnvKey(active.provider);
      if (active.apiKey && !process.env[envKey]) {
        process.env[envKey] = active.apiKey;
      }
      if (active.baseUrl) {
        process.env[`${active.provider.toUpperCase()}_BASE_URL`] = active.baseUrl;
      }
    }
    // 所有 profile 的 apiKey 都注入环境变量
    for (const [_id, p] of Object.entries(this.getProfiles())) {
      if (p.apiKey && p.provider) {
        const envKey = this.providerToEnvKey(p.provider);
        if (!process.env[envKey]) {
          process.env[envKey] = p.apiKey;
        }
        if (p.baseUrl) {
          process.env[`${p.provider.toUpperCase()}_BASE_URL`] = p.baseUrl;
        }
      }
    }
  }

  private providerToEnvKey(provider: string): string {
    const map: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
      google: 'GOOGLE_API_KEY', gemini: 'GEMINI_API_KEY',
      zhipu: 'ZHIPU_API_KEY', aliyun: 'ALIYUN_API_KEY', qwen: 'QWEN_API_KEY',
      siliconflow: 'SILICONFLOW_API_KEY', groq: 'GROQ_API_KEY',
      together: 'TOGETHER_API_KEY', fireworks: 'FIREWORKS_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY', xai: 'XAI_API_KEY',
      moonshot: 'MOONSHOT_API_KEY', doubao: 'DOUBAO_API_KEY',
      'doubao-coding': 'DOUBAO_CODING_API_KEY', minimax: 'MINIMAX_API_KEY',
      agnes: 'AGNES_API_KEY', ollama: 'OLLAMA_API_KEY',
      ernie: 'ERNIE_API_KEY', mistral: 'MISTRAL_API_KEY',
      cohere: 'COHERE_API_KEY', custom: 'CUSTOM_API_KEY',
    };
    return map[provider] || `${provider.toUpperCase()}_API_KEY`;
  }

  /** 获取配置摘要（用于日志展示） */
  getSummary(): string {
    const profiles = Object.keys(this.config.profiles);
    const active = this.getActiveProfile();
    return `配置状态: ${profiles.length > 0 ? '✅ 已配置' : '❌ 未配置'}
  配置文件: ${CONFIG_PATH}
  配置版本: ${this.config.version}
  默认模型: ${active ? `${active.label || active.provider} (${active.model})` : '未设置'}
  配置数: ${profiles.length}个
  偏好: 主题=${this.config.preferences.theme}, 语言=${this.config.preferences.language}
  同步: 最后修改=${new Date(this.config.sync.lastModified).toISOString()}, 设备=${this.config.sync.deviceId}`;
  }
}
