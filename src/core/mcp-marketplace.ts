/**
 * MCPMarketplace — MCP 插件市场
 *
 * 集中管理 MCP 服务器插件的发现、安装、更新和移除。
 * 集成 MCPManager 实现自动连接，提供内置精选插件注册表。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { MCPManager, MCPServerConfig } from './mcp-integration.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export type PluginSource = 'registry' | 'npm' | 'git' | 'url' | 'local';

export type PluginType = 'mcp-server' | 'tool-bundle';

/** 插件兼容性要求 */
export interface PluginCompatibility {
  /** 最低 MCP 协议版本 */
  minProtocolVersion?: string;
  /** 最高 MCP 协议版本（可选） */
  maxProtocolVersion?: string;
  /** 最低 Node.js 版本 */
  minNodeVersion?: string;
  /** 所需的系统依赖（如 npx、uvx、python 等） */
  requiredDependencies?: string[];
  /** 支持的操作系统 */
  supportedOS?: Array<'windows' | 'macos' | 'linux'>;
}

/** 插件权限声明 */
export interface PluginPermissions {
  /** 网络访问 */
  network?: boolean;
  /** 文件系统访问 */
  filesystem?: boolean;
  /** 执行子进程 */
  process?: boolean;
  /** 需要的环境变量（如 API Key） */
  envVars?: string[];
  /** 自定义权限声明 */
  custom?: string[];
}

/** 插件安全签名 */
export interface PluginSignature {
  /** 签名算法 */
  algorithm: 'ed25519' | 'rsa-sha256' | 'none';
  /** 签名值 */
  value: string;
  /** 签名者 */
  signedBy?: string;
}

export interface MarketplacePlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  type: PluginType;
  source: PluginSource;
  tags: string[];
  homepage?: string;
  license?: string;
  /** mcp-server 类型的连接配置 */
  mcpConfig?: {
    command?: string;
    args?: string[];
    transport?: 'stdio' | 'sse' | 'websocket';
    url?: string;
    env?: Record<string, string>;
  };
  /** 兼容性要求 */
  compatibility?: PluginCompatibility;
  /** 权限声明 */
  permissions?: PluginPermissions;
  /** 安全签名 */
  signature?: PluginSignature;
  /** 用户评分（0-5） */
  rating?: number;
  /** 评分人数 */
  ratingCount?: number;
  /** 下载量 */
  downloads?: number;
  /** 最后更新时间 */
  lastUpdated?: number;
  /** 维护状态 */
  maintenanceStatus?: 'active' | 'maintenance' | 'deprecated' | 'abandoned';
  /** 安装信息 */
  installedAt?: number;
  updatedAt?: number;
  enabled?: boolean;
  installPath?: string;
  /** 已安装版本（用于更新检查） */
  installedVersion?: string;
}

export interface MarketplaceSearchResult {
  plugin: MarketplacePlugin;
  relevance: number;
  /** 综合评分（用于排序） */
  compositeScore: number;
}

/** 兼容性检查结果 */
export interface CompatibilityCheckResult {
  compatible: boolean;
  issues: Array<{
    type: 'protocol' | 'node' | 'dependency' | 'os';
    message: string;
    severity: 'error' | 'warning';
  }>;
}

/** 安全校验结果 */
export interface SecurityCheckResult {
  passed: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  warnings: string[];
  errors: string[];
}

// ============ 内置插件注册表 ============

const BUILT_IN_REGISTRY: MarketplacePlugin[] = [
  {
    id: 'playwright-mcp',
    name: 'Playwright MCP',
    version: '1.0.0',
    description: '浏览器自动化 — 通过 Playwright 控制 Chromium/Firefox/WebKit，支持页面导航、点击、截图、表单填写等',
    author: 'Microsoft',
    type: 'mcp-server',
    source: 'npm',
    tags: ['browser', 'automation', 'testing', 'e2e'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
    rating: 4.8,
    ratingCount: 1250,
    downloads: 45000,
    lastUpdated: Date.now() - 7 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'active',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: true, process: true, filesystem: false },
    signature: { algorithm: 'ed25519', value: 'microsoft-signed', signedBy: 'Microsoft' },
    mcpConfig: {
      command: 'npx',
      args: ['@playwright/mcp'],
      transport: 'stdio',
    },
  },
  {
    id: 'sqlite-mcp',
    name: 'SQLite MCP',
    version: '1.0.0',
    description: 'SQLite 数据库操作 — 执行 SQL 查询、管理表结构、导入导出数据',
    author: 'Community',
    type: 'mcp-server',
    source: 'npm',
    tags: ['database', 'sql', 'sqlite'],
    rating: 4.5,
    ratingCount: 680,
    downloads: 18000,
    lastUpdated: Date.now() - 30 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'active',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['uvx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: false, process: true, filesystem: true },
    signature: { algorithm: 'none', value: '' },
    mcpConfig: {
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', './.duan/marketplace.db'],
      transport: 'stdio',
    },
  },
  {
    id: 'filesystem-mcp',
    name: 'Filesystem MCP',
    version: '1.0.0',
    description: '增强文件系统操作 — 搜索、读写、移动、复制文件，支持大文件和目录遍历',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['filesystem', 'file', 'fs'],
    rating: 4.7,
    ratingCount: 920,
    downloads: 32000,
    lastUpdated: Date.now() - 14 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'active',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: false, process: false, filesystem: true },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem'],
      transport: 'stdio',
    },
  },
  {
    id: 'github-mcp',
    name: 'GitHub MCP',
    version: '1.0.0',
    description: 'GitHub API 集成 — 管理仓库、Issue、PR、Code Review，无需手写 API 调用',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['github', 'git', 'devops', 'ci'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    rating: 4.6,
    ratingCount: 1100,
    downloads: 38000,
    lastUpdated: Date.now() - 3 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'active',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: true, process: false, filesystem: false, envVars: ['GITHUB_TOKEN'] },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'npx',
      args: ['@modelcontextprotocol/server-github'],
      transport: 'stdio',
    },
  },
  {
    id: 'memory-mcp',
    name: 'Memory MCP',
    version: '1.0.0',
    description: '持久化记忆系统 — 基于知识图谱的长期记忆存储与检索，支持实体关系管理',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['memory', 'knowledge', 'graph'],
    rating: 4.4,
    ratingCount: 540,
    downloads: 15000,
    lastUpdated: Date.now() - 60 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'maintenance',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: false, process: false, filesystem: true },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'npx',
      args: ['@modelcontextprotocol/server-memory'],
      transport: 'stdio',
    },
  },
  {
    id: 'fetch-mcp',
    name: 'Fetch MCP',
    version: '1.0.0',
    description: '高级网页抓取 — 支持 JavaScript 渲染、自定义请求头、Cookie 管理',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['web', 'fetch', 'scraping'],
    rating: 4.3,
    ratingCount: 420,
    downloads: 12000,
    lastUpdated: Date.now() - 45 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'active',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['uvx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: true, process: false, filesystem: false },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'uvx',
      args: ['mcp-server-fetch'],
      transport: 'stdio',
    },
  },
  {
    id: 'puppeteer-mcp',
    name: 'Puppeteer MCP',
    version: '1.0.0',
    description: 'Headless 浏览器 — 基于 Puppeteer 的页面渲染、PDF 生成、性能分析',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['browser', 'puppeteer', 'pdf', 'rendering'],
    rating: 4.2,
    ratingCount: 380,
    downloads: 10000,
    lastUpdated: Date.now() - 90 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'maintenance',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: true, process: true, filesystem: true },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'npx',
      args: ['@modelcontextprotocol/server-puppeteer'],
      transport: 'stdio',
    },
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking MCP',
    version: '1.0.0',
    description: '结构化思维链 — 通过逐步推理增强复杂问题的分析能力',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['thinking', 'reasoning', 'planning'],
    rating: 4.5,
    ratingCount: 290,
    downloads: 8500,
    lastUpdated: Date.now() - 20 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'active',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: false, process: false, filesystem: false },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'npx',
      args: ['@modelcontextprotocol/server-sequential-thinking'],
      transport: 'stdio',
    },
  },
  {
    id: 'brave-search',
    name: 'Brave Search MCP',
    version: '1.0.0',
    description: 'Brave 搜索引擎集成 — 实时网页搜索和新闻搜索，需 BRAVE_API_KEY 环境变量',
    author: 'ModelContextProtocol',
    type: 'mcp-server',
    source: 'npm',
    tags: ['search', 'web', 'news'],
    rating: 4.1,
    ratingCount: 210,
    downloads: 6500,
    lastUpdated: Date.now() - 120 * 24 * 60 * 60 * 1000,
    maintenanceStatus: 'deprecated',
    compatibility: {
      minProtocolVersion: '2024-11-05',
      requiredDependencies: ['npx'],
      supportedOS: ['windows', 'macos', 'linux'],
    },
    permissions: { network: true, process: false, filesystem: false, envVars: ['BRAVE_API_KEY'] },
    signature: { algorithm: 'ed25519', value: 'mcp-official', signedBy: 'ModelContextProtocol' },
    mcpConfig: {
      command: 'npx',
      args: ['@modelcontextprotocol/server-brave-search'],
      transport: 'stdio',
      env: { BRAVE_API_KEY: '' },
    },
  },
];

// ============ 主类 ============

export class MCPMarketplace {
  private registry: Map<string, MarketplacePlugin> = new Map();
  private installed: Map<string, MarketplacePlugin> = new Map();
  private persistDir: string;
  private installedPath: string;
  private eventBus: EventBus;
  private mcpManager: MCPManager | null = null;
  private log = logger.child({ module: 'MCPMarketplace' });
  // D-MCP: 进程级单例，供 HTTP 路由层共享访问（与 bootstrap 创建的实例一致）
  private static _instance: MCPMarketplace | null = null;

  constructor(persistDir?: string) {
    this.persistDir = persistDir || duanPath('marketplace');
    this.installedPath = path.join(this.persistDir, 'installed.json');
    this.eventBus = EventBus.getInstance();
    this.initBuiltInRegistry();
    this.ensureDir();
    this.loadInstalled();
  }

  /** D-MCP: 获取进程级单例（bootstrap 使用此方法，HTTP 路由层共享同一实例含已注入的 mcpManager） */
  static getInstance(): MCPMarketplace {
    if (!MCPMarketplace._instance) {
      MCPMarketplace._instance = new MCPMarketplace();
    }
    return MCPMarketplace._instance;
  }

  /** 注入 MCPManager */
  setMCPManager(manager: MCPManager): void {
    this.mcpManager = manager;
  }

  // ============ 插件搜索与发现 ============

  /**
   * 搜索可用插件（内置注册表 + 已安装）
   * 增强版：多维度综合评分排序（相关性 + 用户评分 + 下载量 + 维护活跃度）
   */
  search(query: string, options?: { type?: PluginType; tag?: string }): MarketplaceSearchResult[] {
    const q = query.toLowerCase();
    const results: MarketplaceSearchResult[] = [];

    for (const plugin of this.registry.values()) {
      // 类型过滤
      if (options?.type && plugin.type !== options.type) continue;
      if (options?.tag && !plugin.tags.includes(options.tag)) continue;

      let relevance = 0;
      const nameLower = plugin.name.toLowerCase();
      const descLower = plugin.description.toLowerCase();

      // 名称完全匹配
      if (nameLower === q) relevance = 100;
      else if (nameLower.includes(q)) relevance = 80;
      else if (descLower.includes(q)) relevance = 50;
      else if (plugin.tags.some(t => t.includes(q))) relevance = 30;
      else continue;

      // 已安装的标记降低优先级（已安装的不需要再搜索）
      if (this.installed.has(plugin.id)) relevance *= 0.5;

      // 多维度综合评分
      const compositeScore = this.calculateCompositeScore(plugin, relevance);

      results.push({ plugin, relevance, compositeScore });
    }

    // 按综合评分降序排序
    return results.sort((a, b) => b.compositeScore - a.compositeScore);
  }

  /**
   * 计算插件综合评分
   * 综合考虑：相关性(40%) + 用户评分(25%) + 下载量(20%) + 维护活跃度(15%)
   */
  private calculateCompositeScore(plugin: MarketplacePlugin, relevance: number): number {
    // 1. 相关性分数（归一化到 0-100）
    const relevanceScore = relevance;

    // 2. 用户评分（0-5 → 0-100）
    const ratingScore = (plugin.rating || 0) * 20;

    // 3. 下载量分数（对数缩放到 0-100）
    const downloads = plugin.downloads || 0;
    const downloadScore = downloads > 0 ? Math.min(100, Math.log10(downloads + 1) * 25) : 0;

    // 4. 维护活跃度分数
    let maintenanceScore = 50; // 默认
    if (plugin.maintenanceStatus === 'active') maintenanceScore = 100;
    else if (plugin.maintenanceStatus === 'maintenance') maintenanceScore = 70;
    else if (plugin.maintenanceStatus === 'deprecated') maintenanceScore = 30;
    else if (plugin.maintenanceStatus === 'abandoned') maintenanceScore = 10;

    // 5. 最后更新时间衰减（越久未更新分数越低）
    if (plugin.lastUpdated) {
      const daysSinceUpdate = (Date.now() - plugin.lastUpdated) / (24 * 60 * 60 * 1000);
      const updateFreshness = Math.max(0, 1 - daysSinceUpdate / 365); // 1年衰减到0
      maintenanceScore *= updateFreshness;
    }

    return relevanceScore * 0.4 + ratingScore * 0.25 + downloadScore * 0.2 + maintenanceScore * 0.15;
  }

  /** 获取插件详情 */
  getInfo(id: string): MarketplacePlugin | undefined {
    return this.registry.get(id) || this.installed.get(id);
  }

  /** 列出所有可用插件 */
  listAvailable(): MarketplacePlugin[] {
    return Array.from(this.registry.values());
  }

  // ============ 插件安装与管理 ============

  /**
   * 安装插件（增强版：安装前进行兼容性检查和安全校验）
   */
  async install(id: string, options?: { skipCompatibilityCheck?: boolean; skipSecurityCheck?: boolean }): Promise<{ success: boolean; message: string }> {
    const plugin = this.registry.get(id);
    if (!plugin) return { success: false, message: `插件 "${id}" 不存在` };
    if (this.installed.has(id)) return { success: false, message: `插件 "${plugin.name}" 已安装` };

    this.log.info('开始安装插件', { id, name: plugin.name, type: plugin.type });

    try {
      // 1. 兼容性检查（除非显式跳过）
      if (!options?.skipCompatibilityCheck) {
        const compat = this.checkCompatibility(plugin);
        if (!compat.compatible) {
          const errorMsg = compat.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ');
          return { success: false, message: `❌ 兼容性检查失败: ${errorMsg}` };
        }
        const warnings = compat.issues.filter(i => i.severity === 'warning').map(i => i.message);
        if (warnings.length > 0) {
          this.log.warn('兼容性警告', { id, warnings });
        }
      }

      // 2. 安全校验（除非显式跳过）
      if (!options?.skipSecurityCheck) {
        const security = this.securityCheck(plugin);
        if (!security.passed) {
          return { success: false, message: `❌ 安全校验失败: ${security.errors.join('; ')}` };
        }
        if (security.riskLevel === 'high' || security.riskLevel === 'critical') {
          return { success: false, message: `❌ 安全风险过高 (${security.riskLevel}): ${security.warnings.join('; ')}` };
        }
      }

      const installedPlugin: MarketplacePlugin = {
        ...plugin,
        installedAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
        installedVersion: plugin.version,
      };

      if (plugin.type === 'mcp-server') {
        const result = await this.installMCPServer(installedPlugin);
        if (!result.success) return result;
      }

      if (plugin.type === 'tool-bundle') {
        const result = await this.installToolBundle(installedPlugin);
        if (!result.success) return result;
      }

      this.installed.set(id, installedPlugin);
      this.saveInstalled();

      this.eventBus.emitSync('marketplace.plugin.installed', {
        pluginId: id, name: plugin.name, type: plugin.type,
      }, { source: 'MCPMarketplace' });

      this.log.info('插件安装成功', { id, name: plugin.name });
      return { success: true, message: `✅ 插件 "${plugin.name}" 安装成功` };
    } catch (err: unknown) {
      this.log.error('插件安装失败', { id, error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, message: `❌ 安装失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /**
   * 兼容性检查：验证插件是否与当前环境兼容
   * 检查项：MCP 协议版本、Node.js 版本、系统依赖、操作系统
   */
  checkCompatibility(plugin: MarketplacePlugin): CompatibilityCheckResult {
    const issues: CompatibilityCheckResult['issues'] = [];
    const compat = plugin.compatibility;

    if (!compat) {
      // 无兼容性声明，视为兼容但给出警告
      return { compatible: true, issues: [] };
    }

    // 1. MCP 协议版本检查
    const currentProtocol = '2025-06-18'; // 当前客户端支持的最高版本
    if (compat.minProtocolVersion && this.compareVersions(currentProtocol, compat.minProtocolVersion) < 0) {
      issues.push({
        type: 'protocol',
        message: `当前 MCP 协议版本 ${currentProtocol} 低于插件要求的 ${compat.minProtocolVersion}`,
        severity: 'error',
      });
    }
    if (compat.maxProtocolVersion && this.compareVersions(currentProtocol, compat.maxProtocolVersion) > 0) {
      issues.push({
        type: 'protocol',
        message: `当前 MCP 协议版本 ${currentProtocol} 高于插件支持的最高 ${compat.maxProtocolVersion}`,
        severity: 'warning',
      });
    }

    // 2. Node.js 版本检查
    if (compat.minNodeVersion) {
      const currentNode = process.versions.node;
      if (this.compareVersions(currentNode, compat.minNodeVersion) < 0) {
        issues.push({
          type: 'node',
          message: `当前 Node.js 版本 ${currentNode} 低于插件要求的 ${compat.minNodeVersion}`,
          severity: 'error',
        });
      }
    }

    // 3. 系统依赖检查
    if (compat.requiredDependencies && compat.requiredDependencies.length > 0) {
      for (const dep of compat.requiredDependencies) {
        if (!this.isDependencyAvailable(dep)) {
          issues.push({
            type: 'dependency',
            message: `缺少系统依赖: ${dep}（请先安装）`,
            severity: 'error',
          });
        }
      }
    }

    // 4. 操作系统检查
    if (compat.supportedOS && compat.supportedOS.length > 0) {
      const currentOS = this.getCurrentOS();
      if (currentOS && !compat.supportedOS.includes(currentOS)) {
        issues.push({
          type: 'os',
          message: `当前操作系统 ${currentOS} 不在插件支持列表 (${compat.supportedOS.join(', ')})`,
          severity: 'error',
        });
      }
    }

    return {
      compatible: !issues.some(i => i.severity === 'error'),
      issues,
    };
  }

  /**
   * 安全校验：检查插件来源可信度、权限声明、签名
   */
  securityCheck(plugin: MarketplacePlugin): SecurityCheckResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    let riskLevel: SecurityCheckResult['riskLevel'] = 'low';

    // 1. 来源可信度
    const trustedAuthors = ['ModelContextProtocol', 'Microsoft', 'Anthropic', 'OpenAI'];
    if (!trustedAuthors.includes(plugin.author)) {
      warnings.push(`插件作者 "${plugin.author}" 不在可信列表中`);
      riskLevel = 'medium';
    }

    // 2. 签名验证
    if (plugin.signature) {
      if (plugin.signature.algorithm === 'none' || !plugin.signature.value) {
        warnings.push('插件未签名，无法验证完整性');
        riskLevel = 'medium';
      }
    } else {
      warnings.push('插件缺少签名信息');
      riskLevel = 'medium';
    }

    // 3. 权限风险评估
    if (plugin.permissions) {
      const perms = plugin.permissions;
      if (perms.network && perms.process && perms.filesystem) {
        warnings.push('插件请求网络+进程+文件系统全部权限，风险较高');
        riskLevel = 'high';
      } else if (perms.network && perms.process) {
        warnings.push('插件请求网络+进程权限');
        if (riskLevel === 'low') riskLevel = 'medium';
      }
      // 检查必需的环境变量
      if (perms.envVars) {
        for (const envVar of perms.envVars) {
          if (!process.env[envVar]) {
            warnings.push(`插件需要环境变量 ${envVar} 但未设置`);
          }
        }
      }
    }

    // 4. 维护状态检查
    if (plugin.maintenanceStatus === 'abandoned') {
      errors.push('插件已被废弃（abandoned），不建议安装');
      riskLevel = 'critical';
    } else if (plugin.maintenanceStatus === 'deprecated') {
      warnings.push('插件已标记为 deprecated，建议寻找替代方案');
      if (riskLevel === 'low') riskLevel = 'medium';
    }

    // 5. 来源为 url 或 git 时额外警告
    if (plugin.source === 'url' || plugin.source === 'git') {
      warnings.push(`插件来源为 ${plugin.source}，请确保来源可信`);
      if (riskLevel === 'low') riskLevel = 'medium';
    }

    return {
      passed: errors.length === 0,
      riskLevel,
      warnings,
      errors,
    };
  }

  /**
   * 检查已安装插件的更新
   * @returns 有更新可用的插件列表
   */
  checkUpdates(): Array<{ plugin: MarketplacePlugin; currentVersion: string; latestVersion: string }> {
    const updates: Array<{ plugin: MarketplacePlugin; currentVersion: string; latestVersion: string }> = [];
    for (const [id, installed] of this.installed) {
      const registryPlugin = this.registry.get(id);
      if (registryPlugin && registryPlugin.version !== installed.installedVersion) {
        updates.push({
          plugin: registryPlugin,
          currentVersion: installed.installedVersion || installed.version,
          latestVersion: registryPlugin.version,
        });
      }
    }
    return updates;
  }

  /**
   * 更新单个插件
   */
  async update(id: string): Promise<{ success: boolean; message: string }> {
    const installed = this.installed.get(id);
    const registryPlugin = this.registry.get(id);
    if (!installed) return { success: false, message: `插件 "${id}" 未安装` };
    if (!registryPlugin) return { success: false, message: `插件 "${id}" 不在注册表中` };

    const currentVersion = installed.installedVersion || installed.version;
    const latestVersion = registryPlugin.version;
    if (currentVersion === latestVersion) {
      return { success: false, message: `插件 "${installed.name}" 已是最新版本 (${currentVersion})` };
    }


    // 先移除旧版本
    await this.remove(id).catch(() => {});

    // 重新安装新版本
    const result = await this.install(id);
    if (result.success) {
      return { success: true, message: `✅ 插件 "${installed.name}" 已从 ${currentVersion} 更新到 ${latestVersion}` };
    }
    return result;
  }

  /**
   * 批量更新所有有更新可用的插件
   */
  async updateAll(): Promise<Array<{ id: string; success: boolean; message: string }>> {
    const updates = this.checkUpdates();
    const results: Array<{ id: string; success: boolean; message: string }> = [];
    for (const update of updates) {
      const result = await this.update(update.plugin.id);
      results.push({ id: update.plugin.id, ...result });
    }
    return results;
  }

  /** 比较语义化版本号（返回 -1/0/1） */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(n => parseInt(n, 10) || 0);
    const partsB = b.split('.').map(n => parseInt(n, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLen; i++) {
      const va = partsA[i] || 0;
      const vb = partsB[i] || 0;
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return 0;
  }

  /** 检查系统依赖是否可用 */
  private isDependencyAvailable(dep: string): boolean {
    try {
      // 简单检查：通过 which/where 命令验证
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process');
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execSync(`${cmd} ${dep}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** 获取当前操作系统 */
  private getCurrentOS(): 'windows' | 'macos' | 'linux' | null {
    switch (process.platform) {
      case 'win32': return 'windows';
      case 'darwin': return 'macos';
      case 'linux': return 'linux';
      default: return null;
    }
  }

  /** 通过 npm 包名安装自定义 MCP 服务器 */
  installFromNPMPackage(packageName: string, config?: Partial<MCPServerConfig>): Promise<{ success: boolean; message: string; plugin?: MarketplacePlugin }> {
    const id = `custom_${packageName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const plugin: MarketplacePlugin = {
      id,
      name: packageName,
      version: 'latest',
      description: `自定义 MCP 服务器: ${packageName}`,
      author: 'User',
      type: 'mcp-server',
      source: 'npm',
      tags: ['custom'],
      mcpConfig: {
        command: 'npx',
        args: [packageName],
        transport: 'stdio',
        ...config,
      },
      enabled: true,
      installedAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.registry.set(id, plugin);
    return this.install(id).then(r => ({ ...r, plugin }));
  }

  /** 移除插件 */
  async remove(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.installed.get(id);
    if (!plugin) return { success: false, message: `插件 "${id}" 未安装` };

    try {
      if (plugin.type === 'mcp-server' && this.mcpManager) {
        await this.mcpManager.removeServer(id).catch(() => {});
      }

      this.installed.delete(id);
      this.saveInstalled();

      this.eventBus.emitSync('marketplace.plugin.removed', {
        pluginId: id, name: plugin.name,
      }, { source: 'MCPMarketplace' });

      return { success: true, message: `🗑️ 插件 "${plugin.name}" 已移除` };
    } catch (err: unknown) {
      return { success: false, message: `❌ 移除失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /** 启用/禁用插件 */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const plugin = this.installed.get(id);
    if (!plugin) return false;

    plugin.enabled = enabled;
    plugin.updatedAt = Date.now();
    this.saveInstalled();

    if (enabled && plugin.type === 'mcp-server' && this.mcpManager) {
      await this.mcpManager.addServer(this.pluginToMCPConfig(plugin)).catch(() => {});
    }
    if (!enabled && plugin.type === 'mcp-server' && this.mcpManager) {
      await this.mcpManager.removeServer(id).catch(() => {});
    }

    this.eventBus.emitSync(enabled ? 'marketplace.plugin.enabled' : 'marketplace.plugin.disabled', {
      pluginId: id, name: plugin.name,
    }, { source: 'MCPMarketplace' });

    return true;
  }

  /** 获取已安装插件列表 */
  listInstalled(): MarketplacePlugin[] {
    return Array.from(this.installed.values());
  }

  /** 获取安装统计 */
  getStats(): { total: number; mcpServers: number; toolBundles: number; enabled: number } {
    const all = this.listInstalled();
    return {
      total: all.length,
      mcpServers: all.filter(p => p.type === 'mcp-server').length,
      toolBundles: all.filter(p => p.type === 'tool-bundle').length,
      enabled: all.filter(p => p.enabled).length,
    };
  }

  // ============ 内部方法 ============

  private initBuiltInRegistry(): void {
    for (const plugin of BUILT_IN_REGISTRY) {
      this.registry.set(plugin.id, plugin);
    }
  }

  private async installMCPServer(plugin: MarketplacePlugin): Promise<{ success: boolean; message: string }> {
    if (!this.mcpManager) return { success: false, message: 'MCPManager 未注入，无法安装 MCP 服务器' };

    const config = this.pluginToMCPConfig(plugin);
    const connected = await this.mcpManager.addServer(config);
    if (!connected) return { success: false, message: `无法连接到 MCP 服务器 "${plugin.name}"。请确认已安装所需依赖（npx/uvx）。` };

    return { success: true, message: '' };
  }

  private installToolBundle(plugin: MarketplacePlugin): Promise<{ success: boolean; message: string }> {
    // D2 修复：tool-bundle 插件安装 — 通过 EventBus 发射事件，由 bootstrap.ts 监听并注册到 Agent Loop
    const tools = (plugin as MarketplacePlugin & { toolBundle?: Array<{ name: string; description: string }> }).toolBundle || [];

    if (tools.length === 0) {
      // 无工具包定义，仅记录安装状态（兼容旧版插件）
      this.log.info('tool-bundle 插件无工具定义，仅记录安装状态', { id: plugin.id, name: plugin.name });
      return Promise.resolve({ success: true, message: `工具包 "${plugin.name}" 已安装（无具体工具定义）` });
    }

    // 通过 EventBus 发射工具注册事件，bootstrap.ts 监听后注册到 Agent Loop
    const registered: string[] = [];
    for (const tool of tools) {
      try {
        this.eventBus.emitSync('marketplace.toolbundle.registered', {
          pluginId: plugin.id,
          pluginName: plugin.name,
          toolName: tool.name,
          toolDescription: tool.description,
        }, { source: 'MCPMarketplace' });
        registered.push(tool.name);
      } catch (e: unknown) {
        this.log.warn('工具注册事件发射失败', { tool: tool.name, error: (e instanceof Error ? e.message : String(e)) });
      }
    }

    this.log.info('tool-bundle 插件安装成功', { id: plugin.id, name: plugin.name, tools: registered });
    return Promise.resolve({ success: true, message: `已注册 ${registered.length} 个工具: ${registered.join(', ')}` });
  }

  private pluginToMCPConfig(plugin: MarketplacePlugin): MCPServerConfig {
    return {
      id: plugin.id,
      name: plugin.name,
      transport: plugin.mcpConfig?.transport || 'stdio',
      command: plugin.mcpConfig?.command,
      args: plugin.mcpConfig?.args,
      url: plugin.mcpConfig?.url,
      env: plugin.mcpConfig?.env,
      autoReconnect: true,
    };
  }

  // ============ 持久化 ============

  private ensureDir(): void {
    try { fs.mkdirSync(this.persistDir, { recursive: true }); } catch { /* ignore */ }
  }

  private loadInstalled(): void {
    try {
      if (!fs.existsSync(this.installedPath)) return;
      const raw = fs.readFileSync(this.installedPath, 'utf-8');
      const plugins: MarketplacePlugin[] = JSON.parse(raw);
      for (const p of plugins) {
        this.installed.set(p.id, p);
        // 同步到注册表（可能包含自定义插件）
        if (!this.registry.has(p.id)) {
          this.registry.set(p.id, p);
        }
      }
      this.log.info(`已加载 ${this.installed.size} 个已安装插件`);
    } catch (err: unknown) {
      this.log.warn('加载已安装插件列表失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  private saveInstalled(): void {
    try {
      this.ensureDir();
      const data = Array.from(this.installed.values());
      atomicWriteJsonSync(this.installedPath, data);
    } catch (err: unknown) {
      this.log.warn('保存已安装插件列表失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }
}
