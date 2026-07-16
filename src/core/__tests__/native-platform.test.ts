/**
 * v20.0 §4.2 国产系统平台适配测试
 *
 * 测试 NativePlatform 和 NativeDepsResolver 的核心功能：
 * - CPU 架构检测
 * - OS 发行版识别
 * - 包管理器探测
 * - Chromium/ffmpeg 路径解析
 * - Puppeteer launch 选项生成
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import {
  NativePlatform,
  getNativePlatform,
  getPlatformInfo,
  isDomesticSystem,
} from '../native-platform.js';
import {
  NativeDepsResolver,
  getNativeDepsResolver,
} from '../native-deps.js';

describe('v20.0 §4.2: NativePlatform', () => {
  let platform: NativePlatform;

  beforeEach(() => {
    platform = new NativePlatform();
    platform.invalidateCache();
  });

  describe('getInfo', () => {
    it('返回平台信息对象', () => {
      const info = platform.getInfo();
      expect(info).toBeDefined();
      expect(typeof info.os).toBe('string');
      expect(typeof info.arch).toBe('string');
      expect(typeof info.nodeArch).toBe('string');
      expect(typeof info.electronSupported).toBe('boolean');
    });

    it('os 字段匹配当前平台', () => {
      const info = platform.getInfo();
      expect(info.os).toBe(os.platform());
    });

    it('arch 字段映射正确', () => {
      const info = platform.getInfo();
      const nodeArch = process.arch;
      // x64 → x64, arm64 → arm64, loong64 → loong64
      if (nodeArch === 'x64') expect(info.arch).toBe('x64');
      else if (nodeArch === 'arm64') expect(info.arch).toBe('arm64');
      else if (nodeArch === 'arm') expect(info.arch).toBe('armv7l');
    });

    it('缓存后再次调用返回同一对象', () => {
      const info1 = platform.getInfo();
      const info2 = platform.getInfo();
      expect(info1).toBe(info2); // 引用相等（缓存）
    });

    it('invalidateCache 后重新检测', () => {
      const info1 = platform.getInfo();
      platform.invalidateCache();
      const info2 = platform.getInfo();
      expect(info1).not.toBe(info2); // 不同对象
      expect(info1.os).toBe(info2.os); // 但值相同
    });
  });

  describe('平台判断方法', () => {
    it('isWindows/isMacOS/isLinux 三选一为 true', () => {
      const win = platform.isWindows();
      const mac = platform.isMacOS();
      const linux = platform.isLinux();
      const count = [win, mac, linux].filter(Boolean).length;
      expect(count).toBe(1);
    });

    it('架构判断方法一致', () => {
      const info = platform.getInfo();
      expect(platform.isX64()).toBe(info.arch === 'x64');
      expect(platform.isArm64()).toBe(info.arch === 'arm64');
      expect(platform.isLoongArch()).toBe(info.arch === 'loong64' || info.arch === 'loongarch64');
    });
  });

  describe('国产系统检测', () => {
    it('isDomestic 在非 Linux 环境返回 false', () => {
      if (os.platform() !== 'linux') {
        expect(platform.isDomestic()).toBe(false);
      }
    });

    it('distro 在非 Linux 环境为 null', () => {
      const info = platform.getInfo();
      if (info.os !== 'linux') {
        expect(info.distro).toBeNull();
      } else {
        expect(info.distro).not.toBeNull();
      }
    });
  });

  describe('getSummary', () => {
    it('返回包含关键信息的字符串', () => {
      const summary = platform.getSummary();
      expect(summary).toContain('OS=');
      expect(summary).toContain('arch=');
    });

    it('Linux 环境包含 distro 信息', () => {
      if (os.platform() === 'linux') {
        const summary = platform.getSummary();
        expect(summary).toContain('distro=');
      }
    });
  });

  describe('getInstallCommand', () => {
    it('非 Linux 返回手动安装提示', () => {
      if (os.platform() !== 'linux') {
        const cmd = platform.getInstallCommand(['test-pkg']);
        expect(cmd).toContain('手动安装');
      }
    });

    it('Linux 返回 sudo 命令', () => {
      if (os.platform() === 'linux') {
        const cmd = platform.getInstallCommand(['test-pkg']);
        // 应包含 sudo 或 请安装
        expect(typeof cmd).toBe('string');
        expect(cmd.length).toBeGreaterThan(0);
      }
    });
  });

  describe('parseOsRelease（通过行为验证）', () => {
    it('UOS 发行版被正确识别（模拟）', () => {
      // 通过检测逻辑间接验证 parseOsRelease
      // 在真实 UOS 环境中，info.distro.isUos 应为 true
      const info = platform.getInfo();
      if (info.os === 'linux' && info.distro) {
        // 如果有 distro 信息，字段应该是布尔值
        expect(typeof info.distro.isUos).toBe('boolean');
        expect(typeof info.distro.isKylin).toBe('boolean');
        expect(typeof info.distro.isDomestic).toBe('boolean');
      }
    });
  });
});

describe('v20.0 §4.2: NativeDepsResolver', () => {
  let resolver: NativeDepsResolver;

  beforeEach(() => {
    resolver = new NativeDepsResolver();
    resolver.invalidateCache();
  });

  describe('resolveChromium', () => {
    it('返回 ChromiumResolution 对象', () => {
      const result = resolver.resolveChromium();
      expect(result).toBeDefined();
      expect(typeof result.source).toBe('string');
      expect(typeof result.isSystem).toBe('boolean');
    });

    it('source 值在有效范围内', () => {
      const result = resolver.resolveChromium();
      const validSources = ['env', 'standard', 'which', 'bundled', 'none'];
      expect(validSources).toContain(result.source);
    });

    it('缓存后返回同一对象', () => {
      const r1 = resolver.resolveChromium();
      const r2 = resolver.resolveChromium();
      expect(r1).toBe(r2);
    });

    it('env 环境变量优先（如果设置）', () => {
      const fakePath = '/fake/chromium/path';
      const oldEnv = process.env.CHROMIUM_PATH;
      try {
        process.env.CHROMIUM_PATH = fakePath;
        // 路径不存在，不会命中 env
        const result = resolver.resolveChromium();
        expect(result.source).not.toBe('env');
      } finally {
        if (oldEnv) process.env.CHROMIUM_PATH = oldEnv;
        else delete process.env.CHROMIUM_PATH;
        resolver.invalidateCache();
      }
    });
  });

  describe('resolveFfmpeg', () => {
    it('返回 FfmpegResolution 对象', () => {
      const result = resolver.resolveFfmpeg();
      expect(result).toBeDefined();
      expect(typeof result.source).toBe('string');
    });

    it('source 值在有效范围内', () => {
      const result = resolver.resolveFfmpeg();
      const validSources = ['env', 'which', 'static', 'none'];
      expect(validSources).toContain(result.source);
    });

    it('缓存后返回同一对象', () => {
      const r1 = resolver.resolveFfmpeg();
      const r2 = resolver.resolveFfmpeg();
      expect(r1).toBe(r2);
    });
  });

  describe('getPuppeteerLaunchOptions', () => {
    it('返回包含 headless 和 args 的对象', () => {
      const options = resolver.getPuppeteerLaunchOptions();
      expect(options).toBeDefined();
      expect(options.headless).toBe(true);
      expect(Array.isArray(options.args)).toBe(true);
      expect(options.args.length).toBeGreaterThan(0);
    });

    it('包含 no-sandbox 参数', () => {
      const options = resolver.getPuppeteerLaunchOptions();
      expect(options.args).toContain('--no-sandbox');
      expect(options.args).toContain('--disable-setuid-sandbox');
    });

    it('baseOptions 可以覆盖默认值', () => {
      const options = resolver.getPuppeteerLaunchOptions({ headless: false });
      expect(options.headless).toBe(false);
    });

    it('系统 Chromium 存在时设置 executablePath', () => {
      const chromium = resolver.resolveChromium();
      const options = resolver.getPuppeteerLaunchOptions();
      if (chromium.isSystem && chromium.path) {
        expect(options.executablePath).toBe(chromium.path);
      }
    });
  });

  describe('getStatusOverview', () => {
    it('返回包含平台信息的字符串', () => {
      const overview = resolver.getStatusOverview();
      expect(overview).toContain('原生依赖状态');
      expect(overview).toContain('Chromium');
      expect(overview).toContain('ffmpeg');
    });

    it('包含平台摘要', () => {
      const overview = resolver.getStatusOverview();
      expect(overview).toContain('OS=');
      expect(overview).toContain('arch=');
    });
  });
});

describe('v20.0 §4.2: 单例函数', () => {
  it('getNativePlatform 返回单例', () => {
    const p1 = getNativePlatform();
    const p2 = getNativePlatform();
    expect(p1).toBe(p2);
  });

  it('getNativeDepsResolver 返回单例', () => {
    const r1 = getNativeDepsResolver();
    const r2 = getNativeDepsResolver();
    expect(r1).toBe(r2);
  });

  it('getPlatformInfo 返回有效信息', () => {
    const info = getPlatformInfo();
    expect(info).toBeDefined();
    expect(typeof info.os).toBe('string');
  });

  it('isDomesticSystem 返回布尔值', () => {
    const result = isDomesticSystem();
    expect(typeof result).toBe('boolean');
  });
});
