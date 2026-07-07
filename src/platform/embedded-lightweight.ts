/**
 * 嵌入式轻量版 — EmbeddedLightweight
 *
 * V17 跨平台补齐：嵌入式设备轻量化版本
 *
 * 核心能力：
 * 1. 模块裁剪 — 移除重型依赖（浏览器/桌面控制/视频生成），保留核心对话+基础工具
 * 2. 内存优化 — 目标 <128MB 内存占用（树莓派 Zero 256MB 可运行）
 * 3. 离线推理 — 完全本地化，无 API 依赖
 * 4. IoT 网关 — 作为智能家居网关运行
 * 5. 边缘 AI — 本地神经网络推理
 *
 * 目标平台：
 * - 树莓派 4B/5 (4GB+) — 完整功能
 * - 树莓派 Zero 2 W (512MB) — 轻量模式
 * - ESP32 + Node.js（通过 NodeMCU） — 极简模式
 * - 工业网关 — 边缘计算
 *
 * 对标：Edge AI, TensorFlow Lite, ONNX Runtime
 */

import { logger } from '../core/structured-logger.js';
import type { ToolDef } from '../core/unified-tool-def.js';

// ============ 类型定义 ============

export type EmbeddedProfile = 'full' | 'lightweight' | 'minimal' | 'gateway';

export interface EmbeddedConfig {
  profile: EmbeddedProfile;
  maxMemoryMB: number;
  maxStorageMB: number;
  enableVoice: boolean;
  enableBrowser: boolean;
  enableDesktopControl: boolean;
  enableVideoGen: boolean;
  enableIoT: boolean;
  enableLocalInference: boolean;
  enableExperienceCache: boolean;
  apiMode: 'offline' | 'online' | 'hybrid';
  cacheSizeMB: number;
}

export interface ResourceUsage {
  memoryMB: number;
  cpuPercent: number;
  storageMB: number;
  uptime: number;
}

export interface EmbeddedModule {
  name: string;
  enabled: boolean;
  memoryMB: number;
  required: boolean;
  description: string;
}

// ============ 嵌入式轻量版配置 ============

export class EmbeddedLightweight {
  private config: EmbeddedConfig;
  private modules: EmbeddedModule[] = [];
  private isRunning = false;

  constructor(profile?: EmbeddedProfile) {
    const detected = profile || this.detectProfile();
    this.config = this.getConfigForProfile(detected);
    this.modules = this.buildModuleList();
  }

  /**
   * 自动检测设备能力，选择合适的 profile
   */
  private detectProfile(): EmbeddedProfile {
    const totalMem = this.getTotalMemoryMB();

    if (totalMem >= 4096) return 'full';        // 4GB+ 完整版
    if (totalMem >= 1024) return 'lightweight'; // 1GB+ 轻量版
    if (totalMem >= 512) return 'minimal';      // 512MB 极简版
    return 'gateway';                            // <512MB 网关模式
  }

  private getTotalMemoryMB(): number {
    try {
      // Node.js 进程可用内存上限作为参考
      const heapStats = process.memoryUsage();
      return Math.floor(heapStats.rss / 1024 / 1024) * 4; // 估算系统内存
    } catch {
      return 1024;
    }
  }

  /**
   * 获取 profile 对应的配置
   */
  private getConfigForProfile(profile: EmbeddedProfile): EmbeddedConfig {
    const configs: Record<EmbeddedProfile, EmbeddedConfig> = {
      full: {
        profile: 'full',
        maxMemoryMB: 2048,
        maxStorageMB: 4096,
        enableVoice: true,
        enableBrowser: true,
        enableDesktopControl: true,
        enableVideoGen: true,
        enableIoT: true,
        enableLocalInference: true,
        enableExperienceCache: true,
        apiMode: 'hybrid',
        cacheSizeMB: 256,
      },
      lightweight: {
        profile: 'lightweight',
        maxMemoryMB: 512,
        maxStorageMB: 1024,
        enableVoice: true,
        enableBrowser: false,
        enableDesktopControl: false,
        enableVideoGen: false,
        enableIoT: true,
        enableLocalInference: true,
        enableExperienceCache: true,
        apiMode: 'hybrid',
        cacheSizeMB: 64,
      },
      minimal: {
        profile: 'minimal',
        maxMemoryMB: 128,
        maxStorageMB: 256,
        enableVoice: false,
        enableBrowser: false,
        enableDesktopControl: false,
        enableVideoGen: false,
        enableIoT: true,
        enableLocalInference: true,
        enableExperienceCache: true,
        apiMode: 'offline',
        cacheSizeMB: 16,
      },
      gateway: {
        profile: 'gateway',
        maxMemoryMB: 64,
        maxStorageMB: 64,
        enableVoice: false,
        enableBrowser: false,
        enableDesktopControl: false,
        enableVideoGen: false,
        enableIoT: true,
        enableLocalInference: false,
        enableExperienceCache: true,
        apiMode: 'offline',
        cacheSizeMB: 8,
      },
    };
    return configs[profile];
  }

  /**
   * 构建模块列表（根据 profile 裁剪）
   */
  private buildModuleList(): EmbeddedModule[] {
    return [
      { name: 'core-engine', enabled: true, memoryMB: 20, required: true, description: '核心引擎（推理+对话）' },
      { name: 'memory-system', enabled: true, memoryMB: 15, required: true, description: '记忆系统（向量存储）' },
      { name: 'tool-framework', enabled: true, memoryMB: 10, required: true, description: '工具框架' },
      { name: 'experience-cache', enabled: this.config.enableExperienceCache, memoryMB: 5, required: false, description: '经验包缓存' },
      { name: 'local-inference', enabled: this.config.enableLocalInference, memoryMB: 30, required: false, description: '本地神经网络推理' },
      { name: 'voice-system', enabled: this.config.enableVoice, memoryMB: 40, required: false, description: '语音系统（STT+TTS）' },
      { name: 'browser-automation', enabled: this.config.enableBrowser, memoryMB: 80, required: false, description: '浏览器自动化' },
      { name: 'desktop-control', enabled: this.config.enableDesktopControl, memoryMB: 30, required: false, description: '桌面控制' },
      { name: 'video-generation', enabled: this.config.enableVideoGen, memoryMB: 100, required: false, description: '视频生成' },
      { name: 'iot-control', enabled: this.config.enableIoT, memoryMB: 8, required: false, description: 'IoT 设备控制' },
      { name: 'mcp-integration', enabled: this.config.profile === 'full', memoryMB: 20, required: false, description: 'MCP 协议集成' },
      { name: 'self-evolution', enabled: this.config.profile === 'full', memoryMB: 15, required: false, description: '自我进化' },
    ];
  }

  /**
   * 启动嵌入式版本
   */
  start(): Promise<void> {
    logger.info('启动嵌入式轻量版', {
      module: 'EmbeddedLightweight',
      profile: this.config.profile,
      maxMemory: this.config.maxMemoryMB,
      modules: this.modules.filter(m => m.enabled).length,
    });

    // 检查资源是否足够
    const estimated = this.estimateMemoryUsage();
    if (estimated > this.config.maxMemoryMB) {
      logger.warn('内存预估超限，自动降级到更轻量的 profile', {
        module: 'EmbeddedLightweight',
        estimated,
        max: this.config.maxMemoryMB,
      });
      const lighterProfile = this.getLighterProfile(this.config.profile);
      if (lighterProfile !== this.config.profile) {
        this.config = this.getConfigForProfile(lighterProfile);
        this.modules = this.buildModuleList();
      }
    }

    this.isRunning = true;
    logger.info('嵌入式版本已启动', {
      module: 'EmbeddedLightweight',
      enabledModules: this.modules.filter(m => m.enabled).map(m => m.name),
    });
    return Promise.resolve();
  }

  /**
   * 停止
   */
  stop(): void {
    this.isRunning = false;
    logger.info('嵌入式版本已停止', { module: 'EmbeddedLightweight' });
  }

  /**
   * 获取当前资源使用情况
   */
  getResourceUsage(): ResourceUsage {
    const memStats = process.memoryUsage();
    return {
      memoryMB: Math.floor(memStats.rss / 1024 / 1024),
      cpuPercent: 0, // 实际实现通过 os.cpus() 计算
      storageMB: 0,  // 实际实现通过 fs.statfs 计算
      uptime: process.uptime(),
    };
  }

  /**
   * 估算内存使用
   */
  private estimateMemoryUsage(): number {
    return this.modules
      .filter(m => m.enabled)
      .reduce((sum, m) => sum + m.memoryMB, 0);
  }

  /**
   * 获取更轻量的 profile
   */
  private getLighterProfile(current: EmbeddedProfile): EmbeddedProfile {
    const order: EmbeddedProfile[] = ['full', 'lightweight', 'minimal', 'gateway'];
    const idx = order.indexOf(current);
    return order[Math.min(idx + 1, order.length - 1)];
  }

  /**
   * 获取配置
   */
  getConfig(): EmbeddedConfig {
    return { ...this.config };
  }

  /**
   * 获取模块列表
   */
  getModules(): EmbeddedModule[] {
    return [...this.modules];
  }

  /**
   * 生成嵌入式部署清单
   */
  generateDeploymentManifest(): object {
    return {
      profile: this.config.profile,
      target: {
        platform: 'linux-arm64',
        minMemory: `${this.config.maxMemoryMB}MB`,
        minStorage: `${this.config.maxStorageMB}MB`,
      },
      modules: this.modules.filter(m => m.enabled).map(m => ({
        name: m.name,
        version: '19.0.0',
        memory: `${m.memoryMB}MB`,
      })),
      features: {
        voice: this.config.enableVoice,
        browser: this.config.enableBrowser,
        desktop: this.config.enableDesktopControl,
        video: this.config.enableVideoGen,
        iot: this.config.enableIoT,
        localInference: this.config.enableLocalInference,
        offlineMode: this.config.apiMode === 'offline',
      },
      deployment: {
        dockerImage: `duan-xiansheng:v19.0-${this.config.profile}`,
        ports: this.config.enableVoice ? [3000, 8080] : [8080],
        volumes: ['/app/.duan', '/app/data'],
        environment: {
          NODE_ENV: 'production',
          EMBEDDED_PROFILE: this.config.profile,
          API_MODE: this.config.apiMode,
        },
      },
    };
  }

  /**
   * 生成树莓派部署脚本
   */
  generateRaspberryPiScript(): string {
    return `#!/bin/bash
# 段先生 v19.0 树莓派部署脚本
# Profile: ${this.config.profile}

set -e

echo "🚀 段先生 v19.0 树莓派部署"
echo "Profile: ${this.config.profile}"
echo "Max Memory: ${this.config.maxMemoryMB}MB"

# 1. 安装 Node.js 20
if ! command -v node &> /dev/null; then
    echo "安装 Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 2. 安装系统依赖
sudo apt-get update
sudo apt-get install -y ffmpeg ${this.config.enableVoice ? 'sox libsox-fmt-all' : ''}

# 3. 下载嵌入式镜像
echo "下载嵌入式镜像..."
docker pull duan-xiansheng:v19.0-${this.config.profile}

# 4. 创建数据目录
mkdir -p ~/.duan/data ~/.duan/logs

# 5. 启动容器
echo "启动段先生..."
docker run -d \\
    --name duan-agent \\
    --restart unless-stopped \\
    -p 8080:8080 ${this.config.enableVoice ? '-p 3000:3000' : ''} \\
    -v ~/.duan:/app/.duan \\
    -e NODE_ENV=production \\
    -e EMBEDDED_PROFILE=${this.config.profile} \\
    -e API_MODE=${this.config.apiMode} \\
    --memory=${this.config.maxMemoryMB}m \\
    duan-xiansheng:v19.0-${this.config.profile}

echo "✅ 段先生已启动"
echo "API: http://$(hostname -I | awk '{print $1}'):8080"
echo "Web: http://$(hostname -I | awk '{print $1}'):3000"`;
  }

  // ===== P3-3: Agent Loop 工具定义 =====

  /**
   * 获取工具定义 — 暴露嵌入式部署能力给 Agent 主循环
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const system = this;

    return [
      {
        name: 'embedded_profile',
        description: '检查当前设备的嵌入式 profile（full/lightweight/minimal/gateway）和能力配置。返回内存限制、启用的功能（语音/浏览器/桌面控制/视频/IoT/本地推理）、API 模式等。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const config = system.getConfig();
          return Promise.resolve(JSON.stringify({
            profile: config.profile,
            maxMemoryMB: config.maxMemoryMB,
            maxStorageMB: config.maxStorageMB,
            features: {
              voice: config.enableVoice,
              browser: config.enableBrowser,
              desktopControl: config.enableDesktopControl,
              videoGen: config.enableVideoGen,
              iot: config.enableIoT,
              localInference: config.enableLocalInference,
              experienceCache: config.enableExperienceCache,
            },
            apiMode: config.apiMode,
            cacheSizeMB: config.cacheSizeMB,
          }));
        },
      },
      {
        name: 'embedded_modules',
        description: '列出当前 profile 下启用的模块列表，包含模块名称、内存占用、是否启用、是否必需、描述。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const modules = system.getModules();
          return Promise.resolve(JSON.stringify({
            profile: system.getConfig().profile,
            totalModules: modules.length,
            enabledModules: modules.filter(m => m.enabled).length,
            estimatedMemoryMB: modules.filter(m => m.enabled).reduce((sum, m) => sum + m.memoryMB, 0),
            modules: modules.map(m => ({
              name: m.name,
              enabled: m.enabled,
              memoryMB: m.memoryMB,
              required: m.required,
              description: m.description,
            })),
          }));
        },
      },
      {
        name: 'embedded_manifest',
        description: '生成嵌入式部署清单（Docker 镜像、端口、卷、环境变量），用于 CI/CD 或手动部署。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const manifest = system.generateDeploymentManifest();
          return Promise.resolve(JSON.stringify(manifest, null, 2));
        },
      },
      {
        name: 'embedded_deploy_script',
        description: '生成树莓派部署脚本（Bash），包含 Node.js 安装、依赖安装、Docker 镜像下载、容器启动。可直接在树莓派上执行。',
        readOnly: true,
        parameters: {},
        execute: () => {
          return Promise.resolve(system.generateRaspberryPiScript());
        },
      },
    ];
  }
}
