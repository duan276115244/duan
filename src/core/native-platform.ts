/**
 * v20.0 §4.2 国产系统统一平台抽象层 — NativePlatform
 *
 * 集中管理 CPU 架构检测、OS 发行版识别、包管理器探测，
 * 替代分散在 25+ 文件中的 `process.platform` / `os.arch()` 硬编码。
 *
 * 支持的国产系统：
 *   - 统信 UOS V20/V25（x86_64 / ARM64 / LoongArch64）
 *   - 银河麒麟 V10（x86_64 / ARM64 飞腾鲲鹏 / LoongArch64 龙芯）
 *   - 麒麟桌面版 V10
 *
 * 核心能力：
 * 1. CPU 架构检测（x64 / arm64 / loong64 / mips64el）
 * 2. OS 发行版识别（UOS / Kylin / Deepin / Ubuntu / CentOS / ...）
 * 3. 包管理器探测（apt / yum / dnf / pacman / zypper）
 * 4. 原生依赖路径解析委托（通过 NativeDepsResolver）
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

export type CpuArch = 'x64' | 'arm64' | 'armv7l' | 'loong64' | 'loongarch64' | 'mips64el' | 'unknown';

export type OsKind = 'win32' | 'darwin' | 'linux' | 'unknown';

export interface LinuxDistroInfo {
  /** 发行版 ID（如 uos, kylin, ubuntu, centos, debian） */
  id: string;
  /** 发行版名称（如 "UnionTech OS Desktop", "Kylin V10"） */
  name: string;
  /** 版本号（如 "V20", "V10 SP3"） */
  version: string;
  /** 是否为国产系统 */
  isDomestic: boolean;
  /** 是否为 UOS */
  isUos: boolean;
  /** 是否为麒麟 */
  isKylin: boolean;
}

export type PackageManager = 'apt' | 'apt-get' | 'yum' | 'dnf' | 'pacman' | 'zypper' | 'unknown';

export interface PlatformInfo {
  /** OS 类型 */
  os: OsKind;
  /** CPU 架构 */
  arch: CpuArch;
  /** Node.js 进程架构（可能与 OS 架构不同，如 x64 Node 跑在 arm64 Windows 上） */
  nodeArch: string;
  /** Linux 发行版信息（仅 linux） */
  distro: LinuxDistroInfo | null;
  /** 可用的包管理器 */
  packageManager: PackageManager;
  /** 是否为国产系统（UOS/Kylin） */
  isDomestic: boolean;
  /** 是否支持 Electron 桌面端 */
  electronSupported: boolean;
}

// ============ 常量 ============

/** 国产系统发行版 ID 集合 */
const DOMESTIC_DISTRO_IDS = new Set([
  'uos',           // 统信 UOS
  'kylin',         // 银河麒麟
  'kylinos',       // 麒麟操作系统
  'deepin',        // 深度（UOS 上游）
  'uniontech',     // 统信
  'isoft',         // 中标麒麟（旧）
]);

/** 架构映射：Node.js process.arch → CpuArch */
const ARCH_MAP: Record<string, CpuArch> = {
  'x64': 'x64',
  'arm64': 'arm64',
  'arm': 'armv7l',
  'loong64': 'loong64',
  'loongarch64': 'loongarch64',
  'mips64el': 'mips64el',
};

// ============ 主类 ============

export class NativePlatform {
  private log = logger.child({ module: 'NativePlatform' });
  private _cachedInfo: PlatformInfo | null = null;

  /** 获取平台信息（带缓存） */
  getInfo(): PlatformInfo {
    if (this._cachedInfo) return this._cachedInfo;

    const nodeOs = os.platform() as OsKind;
    const nodeArch = process.arch;
    const arch = ARCH_MAP[nodeArch] || 'unknown';

    const distro = nodeOs === 'linux' ? this.detectLinuxDistro() : null;
    const isDomestic = distro?.isDomestic ?? false;
    const packageManager = nodeOs === 'linux' ? this.detectPackageManager() : 'unknown';

    // Electron 官方支持 x64 和 arm64（Linux），LoongArch 需龙芯社区版
    const electronSupported = nodeOs === 'win32' || nodeOs === 'darwin' ||
      (nodeOs === 'linux' && (arch === 'x64' || arch === 'arm64'));

    const info: PlatformInfo = {
      os: nodeOs,
      arch,
      nodeArch,
      distro,
      packageManager,
      isDomestic,
      electronSupported,
    };

    this._cachedInfo = info;
    this.log.info('平台信息已检测', {
      os: info.os,
      arch: info.arch,
      distro: info.distro?.id ?? 'n/a',
      isDomestic: info.isDomestic,
      electronSupported: info.electronSupported,
    });

    return info;
  }

  /** 是否为 Windows */
  isWindows(): boolean {
    return this.getInfo().os === 'win32';
  }

  /** 是否为 macOS */
  isMacOS(): boolean {
    return this.getInfo().os === 'darwin';
  }

  /** 是否为 Linux */
  isLinux(): boolean {
    return this.getInfo().os === 'linux';
  }

  /** 是否为国产系统 */
  isDomestic(): boolean {
    return this.getInfo().isDomestic;
  }

  /** 是否为 UOS */
  isUos(): boolean {
    return this.getInfo().distro?.isUos ?? false;
  }

  /** 是否为麒麟 */
  isKylin(): boolean {
    return this.getInfo().distro?.isKylin ?? false;
  }

  /** 是否为 ARM64 架构 */
  isArm64(): boolean {
    return this.getInfo().arch === 'arm64';
  }

  /** 是否为 LoongArch 架构 */
  isLoongArch(): boolean {
    const arch = this.getInfo().arch;
    return arch === 'loong64' || arch === 'loongarch64';
  }

  /** 是否为 x86_64 架构 */
  isX64(): boolean {
    return this.getInfo().arch === 'x64';
  }

  // ============ Linux 发行版检测 ============

  /**
   * 检测 Linux 发行版
   *
   * 优先读取 /etc/os-release（systemd 标准），回退到 /etc/lsb-release。
   * 参考：https://www.freedesktop.org/software/systemd/man/os-release.html
   */
  private detectLinuxDistro(): LinuxDistroInfo {
    const fallback: LinuxDistroInfo = {
      id: 'unknown', name: 'Unknown Linux', version: '',
      isDomestic: false, isUos: false, isKylin: false,
    };

    let releaseData: Record<string, string> = {};

    // 优先 /etc/os-release
    const osReleasePath = '/etc/os-release';
    if (fs.existsSync(osReleasePath)) {
      try {
        const content = fs.readFileSync(osReleasePath, 'utf-8');
        releaseData = this.parseOsRelease(content);
      } catch {
        this.log.warn('读取 /etc/os-release 失败');
      }
    }

    // 回退 /etc/lsb-release
    if (Object.keys(releaseData).length === 0) {
      const lsbPath = '/etc/lsb-release';
      if (fs.existsSync(lsbPath)) {
        try {
          const content = fs.readFileSync(lsbPath, 'utf-8');
          releaseData = this.parseOsRelease(content);
        } catch {
          this.log.warn('读取 /etc/lsb-release 失败');
        }
      }
    }

    if (Object.keys(releaseData).length === 0) {
      return fallback;
    }

    const id = (releaseData['ID'] || '').toLowerCase();
    const name = releaseData['NAME'] || 'Unknown Linux';
    const version = releaseData['VERSION_ID'] || releaseData['VERSION'] || '';

    // 检查 ID_LIKE 字段（如 kylin 的 ID_LIKE 可能包含 ubuntu）
    const idLike = (releaseData['ID_LIKE'] || '').toLowerCase();

    const isUos = id === 'uos' || id === 'uniontech' || id === 'deepin' || idLike.includes('deepin');
    const isKylin = id === 'kylin' || id === 'kylinos' || id === 'isoft' || idLike.includes('kylin');
    const isDomestic = DOMESTIC_DISTRO_IDS.has(id) || isUos || isKylin;

    return {
      id,
      name,
      version,
      isDomestic,
      isUos,
      isKylin,
    };
  }

  /** 解析 os-release / lsb-release 文件 */
  private parseOsRelease(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      // 去除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  }

  // ============ 包管理器检测 ============

  /** 检测系统包管理器 */
  private detectPackageManager(): PackageManager {
    // 按优先级检测：dnf > yum（CentOS/RHEL 系），apt > apt-get（Debian 系）
    const commands: PackageManager[] = ['dnf', 'yum', 'apt', 'apt-get', 'pacman', 'zypper'];
    for (const cmd of commands) {
      if (this.commandExists(cmd)) {
        return cmd;
      }
    }
    return 'unknown';
  }

  /** 检测命令是否存在 */
  commandExists(cmd: string): boolean {
    try {
      // which 在 Linux/macOS，where 在 Windows
      const checkCmd = this.isWindows() ? 'where' : 'which';
      execSync(`${checkCmd} ${cmd} 2>/dev/null`, { stdio: 'pipe', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取系统包安装命令（用于提示用户安装依赖）
   */
  getInstallCommand(packages: string[]): string {
    const info = this.getInfo();
    if (info.os !== 'linux') {
      // Windows/macOS 无包管理器，返回提示
      return `请手动安装：${packages.join(', ')}`;
    }
    const pm = info.packageManager;
    switch (pm) {
      case 'apt':
      case 'apt-get':
        return `sudo ${pm} install -y ${packages.join(' ')}`;
      case 'dnf':
      case 'yum':
        return `sudo ${pm} install -y ${packages.join(' ')}`;
      case 'pacman':
        return `sudo pacman -S --noconfirm ${packages.join(' ')}`;
      case 'zypper':
        return `sudo zypper install -y ${packages.join(' ')}`;
      default:
        return `请安装：${packages.join(', ')}`;
    }
  }

  /**
   * 获取平台摘要字符串（用于日志/诊断）
   */
  getSummary(): string {
    const info = this.getInfo();
    const parts: string[] = [`OS=${info.os}`, `arch=${info.arch}`];
    if (info.distro) {
      parts.push(`distro=${info.distro.id}@${info.distro.version}`);
      if (info.distro.isDomestic) parts.push('domestic=true');
    }
    if (info.packageManager !== 'unknown') parts.push(`pkgMgr=${info.packageManager}`);
    parts.push(`electron=${info.electronSupported ? 'yes' : 'no'}`);
    return parts.join(', ');
  }

  /** 清除缓存（用于测试） */
  invalidateCache(): void {
    this._cachedInfo = null;
  }
}

// ============ 单例 ============

let _instance: NativePlatform | null = null;

/** 获取 NativePlatform 单例 */
export function getNativePlatform(): NativePlatform {
  if (!_instance) {
    _instance = new NativePlatform();
  }
  return _instance;
}

/**
 * 便捷函数：获取平台信息
 */
export function getPlatformInfo(): PlatformInfo {
  return getNativePlatform().getInfo();
}

/**
 * 便捷函数：是否为国产系统
 */
export function isDomesticSystem(): boolean {
  return getNativePlatform().isDomestic();
}
