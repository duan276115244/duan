/**
 * v20.0 §4.2 国产系统原生依赖适配器 — NativeDepsResolver
 *
 * 替代 puppeteer 自带的 Chromium 下载（不支持 LoongArch）和 ffmpeg-static 静态二进制，
 * 改用系统已安装的 Chromium / ffmpeg，通过包管理器安装。
 *
 * 核心能力：
 * 1. 系统 Chromium/Chrome 路径检测（CHROMIUM_PATH 环境变量 → 标准路径 → which）
 * 2. 系统 ffmpeg 路径检测（FFMPEG_PATH 环境变量 → which ffmpeg）
 * 3. 依赖缺失时提供安装提示（根据包管理器）
 * 4. Puppeteer launch 选项生成
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { logger } from './structured-logger.js';
import { getNativePlatform, type PlatformInfo } from './native-platform.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

export interface ChromiumResolution {
  /** 可执行的 Chromium/Chrome 路径，null 表示未找到 */
  path: string | null;
  /** 来源：env / standard / which / bundled */
  source: 'env' | 'standard' | 'which' | 'bundled' | 'none';
  /** 是否为系统安装（非 puppeteer 自带） */
  isSystem: boolean;
  /** 如果未找到，给出安装提示 */
  installHint?: string;
}

export interface FfmpegResolution {
  /** 可执行的 ffmpeg 路径，null 表示未找到 */
  path: string | null;
  /** 来源：env / which / static / none */
  source: 'env' | 'which' | 'static' | 'none';
  /** 安装提示 */
  installHint?: string;
}

// ============ 常量 ============

/**
 * Chromium/Chrome 在各平台的标准安装路径
 *
 * UOS/麒麟通常预装 chromium 或 chromium-browser，
 * 也可能有供应商定制版本（如 UOS 浏览器）。
 */
const CHROMIUM_STANDARD_PATHS: Record<string, string[]> = {
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/lib/chromium/chromium',
    // UOS/Deepin 可能的路径
    '/usr/bin/browser',
    '/opt/apps/com.uniontech.browser/files/bin/browser',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** 各平台需要安装的系统依赖包名 */
const SYSTEM_DEP_PACKAGES: Record<string, Record<string, string[]>> = {
  chromium: {
    apt: ['chromium', 'chromium-browser'],
    'apt-get': ['chromium', 'chromium-browser'],
    dnf: ['chromium'],
    yum: ['chromium'],
    pacman: ['chromium'],
    zypper: ['chromium'],
  },
  ffmpeg: {
    apt: ['ffmpeg'],
    'apt-get': ['ffmpeg'],
    dnf: ['ffmpeg'],
    yum: ['ffmpeg'],
    pacman: ['ffmpeg'],
    zypper: ['ffmpeg'],
  },
};

// ============ 主类 ============

export class NativeDepsResolver {
  private log = logger.child({ module: 'NativeDepsResolver' });
  private _chromiumCache: ChromiumResolution | null = null;
  private _ffmpegCache: FfmpegResolution | null = null;

  /**
   * 解析系统 Chromium/Chrome 路径
   *
   * 优先级：
   * 1. CHROMIUM_PATH 环境变量（用户显式指定）
   * 2. PUPPETEER_EXECUTABLE_PATH 环境变量（puppeteer 标准约定）
   * 3. 标准安装路径扫描
   * 4. which/where 命令查找
   * 5. 回退到 puppeteer 自带（非国产系统）
   */
  resolveChromium(): ChromiumResolution {
    if (this._chromiumCache) return this._chromiumCache;

    const platform = getNativePlatform();
    const info = platform.getInfo();

    // 1. 环境变量
    const envPath = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) {
      this.log.info('Chromium 路径来自环境变量', { path: envPath });
      this._chromiumCache = { path: envPath, source: 'env', isSystem: true };
      return this._chromiumCache;
    }

    // 2. 标准路径扫描
    const standardPaths = CHROMIUM_STANDARD_PATHS[info.os] || [];
    for (const p of standardPaths) {
      if (fs.existsSync(p)) {
        this.log.info('Chromium 路径来自标准位置', { path: p });
        this._chromiumCache = { path: p, source: 'standard', isSystem: true };
        return this._chromiumCache;
      }
    }

    // 3. which/where 查找
    const cmd = info.os === 'win32' ? 'where' : 'which';
    const candidates = info.os === 'win32'
      ? ['chrome', 'msedge']
      : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
    for (const candidate of candidates) {
      const found = this.findExecutable(cmd, candidate);
      if (found) {
        this.log.info('Chromium 路径来自 which/where', { path: found });
        this._chromiumCache = { path: found, source: 'which', isSystem: true };
        return this._chromiumCache;
      }
    }

    // 4. 国产系统未找到 → 给出安装提示
    if (info.isDomestic || info.os === 'linux') {
      const hint = this.buildInstallHint('chromium', info);
      this.log.warn('未找到系统 Chromium，请安装', { hint });
      this._chromiumCache = { path: null, source: 'none', isSystem: false, installHint: hint };
      return this._chromiumCache;
    }

    // 5. 非 Linux 回退到 puppeteer 自带
    this.log.info('回退到 puppeteer 自带 Chromium');
    this._chromiumCache = { path: null, source: 'bundled', isSystem: false };
    return this._chromiumCache;
  }

  /**
   * 解析系统 ffmpeg 路径
   *
   * 优先级：
   * 1. FFMPEG_PATH 环境变量
   * 2. which/where ffmpeg
   * 3. ffmpeg-static npm 包（回退，非国产系统）
   */
  resolveFfmpeg(): FfmpegResolution {
    if (this._ffmpegCache) return this._ffmpegCache;

    const platform = getNativePlatform();
    const info = platform.getInfo();

    // 1. 环境变量
    const envPath = process.env.FFMPEG_PATH;
    if (envPath && fs.existsSync(envPath)) {
      this.log.info('ffmpeg 路径来自环境变量', { path: envPath });
      this._ffmpegCache = { path: envPath, source: 'env' };
      return this._ffmpegCache;
    }

    // 2. which/where
    const cmd = info.os === 'win32' ? 'where' : 'which';
    const found = this.findExecutable(cmd, 'ffmpeg');
    if (found) {
      this.log.info('ffmpeg 路径来自 which/where', { path: found });
      this._ffmpegCache = { path: found, source: 'which' };
      return this._ffmpegCache;
    }

    // 3. 国产系统未找到 → 给出安装提示
    if (info.isDomestic || info.os === 'linux') {
      const hint = this.buildInstallHint('ffmpeg', info);
      this.log.warn('未找到系统 ffmpeg，请安装', { hint });
      this._ffmpegCache = { path: null, source: 'none', installHint: hint };
      return this._ffmpegCache;
    }

    // 4. 非 Linux 尝试 ffmpeg-static
    try {
      const staticPath = require.resolve('ffmpeg-static');
      this.log.info('ffmpeg 路径来自 ffmpeg-static 包', { path: staticPath });
      this._ffmpegCache = { path: staticPath, source: 'static' };
      return this._ffmpegCache;
    } catch {
      // ffmpeg-static 不可用
    }

    this._ffmpegCache = { path: null, source: 'none', installHint: '请安装 ffmpeg 或 npm install ffmpeg-static' };
    return this._ffmpegCache;
  }

  /**
   * 生成 puppeteer.launch 选项
   *
   * 在国产系统上使用系统 Chromium，避免下载不支持 LoongArch 的 Chromium 二进制。
   */
  getPuppeteerLaunchOptions(baseOptions?: Record<string, unknown>): Record<string, unknown> {
    const resolution = this.resolveChromium();
    const options: Record<string, unknown> = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
      ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
      ...baseOptions,
    };

    if (resolution.isSystem && resolution.path) {
      options.executablePath = resolution.path;
      this.log.info('puppeteer 使用系统 Chromium', { path: resolution.path });
    }

    return options;
  }

  /** 获取系统依赖安装状态概览 */
  getStatusOverview(): string {
    const platform = getNativePlatform();
    const info = platform.getInfo();
    const chromium = this.resolveChromium();
    const ffmpeg = this.resolveFfmpeg();

    const lines: string[] = [
      '📦 原生依赖状态',
      `  平台: ${platform.getSummary()}`,
      '',
      '  Chromium:',
      chromium.path
        ? `    ✓ 已找到 (${chromium.source}): ${chromium.path}`
        : `    ✗ 未找到${chromium.installHint ? `\n    ${chromium.installHint}` : ''}`,
      '',
      '  ffmpeg:',
      ffmpeg.path
        ? `    ✓ 已找到 (${ffmpeg.source}): ${ffmpeg.path}`
        : `    ✗ 未找到${ffmpeg.installHint ? `\n    ${ffmpeg.installHint}` : ''}`,
    ];

    if (info.isDomestic) {
      lines.push('', '  ℹ️ 检测到国产系统，已启用系统依赖模式');
    }

    return lines.join('\n');
  }

  /** 清除缓存（用于测试） */
  invalidateCache(): void {
    this._chromiumCache = null;
    this._ffmpegCache = null;
  }

  /**
   * v20.0 §4.2：暴露 native_status 工具给 LLM
   *
   * 让 agent 能查询当前平台信息和原生依赖状态，
   * 在国产系统上自动检测 Chromium/ffmpeg 可用性并给出安装建议。
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'native_status',
        description: '查询当前平台信息和原生依赖状态（CPU架构、OS发行版、Chromium/ffmpeg路径）。在国产系统（UOS/麒麟）上用于诊断依赖缺失并提供安装建议。',
        parameters: {
          detail: {
            type: 'string',
            description: '查询范围："platform"（仅平台信息）、"deps"（仅依赖状态）、"all"（全部，默认）',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args: { detail?: string }) => {
          const detail = (args?.detail as string) || 'all';
          const platform = getNativePlatform();

          if (detail === 'platform') {
            return platform.getSummary();
          }

          if (detail === 'deps') {
            return this.getStatusOverview();
          }

          // all
          const lines: string[] = [
            '🖥️ 平台信息',
            `  ${platform.getSummary()}`,
            '',
            this.getStatusOverview(),
          ];
          return lines.join('\n');
        },
      },
    ];
  }

  // ============ 内部方法 ============

  /** 执行 which/where 查找可执行文件 */
  private findExecutable(cmd: string, name: string): string | null {
    try {
      const output = execSync(`${cmd} ${name} 2>/dev/null`, {
        stdio: 'pipe',
        timeout: 3000,
        encoding: 'utf-8',
      }).trim();
      // which 可能返回多行，取第一个
      const first = output.split('\n')[0].trim();
      if (first && fs.existsSync(first)) {
        return first;
      }
    } catch {
      // 命令不存在或执行失败
    }
    return null;
  }

  /** 构建安装提示 */
  private buildInstallHint(dep: 'chromium' | 'ffmpeg', info: PlatformInfo): string {
    const packages = SYSTEM_DEP_PACKAGES[dep]?.[info.packageManager];
    if (!packages || packages.length === 0) {
      return `    请通过系统包管理器安装 ${dep}`;
    }
    const installCmd = getNativePlatform().getInstallCommand(packages);
    return `    安装命令: ${installCmd}`;
  }
}

// ============ 单例 ============

let _instance: NativeDepsResolver | null = null;

/** 获取 NativeDepsResolver 单例 */
export function getNativeDepsResolver(): NativeDepsResolver {
  if (!_instance) {
    _instance = new NativeDepsResolver();
  }
  return _instance;
}

/**
 * 便捷函数：解析系统 Chromium 路径
 */
export function resolveSystemChromium(): ChromiumResolution {
  return getNativeDepsResolver().resolveChromium();
}

/**
 * 便捷函数：解析系统 ffmpeg 路径
 */
export function resolveSystemFfmpeg(): FfmpegResolution {
  return getNativeDepsResolver().resolveFfmpeg();
}
