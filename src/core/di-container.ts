/**
 * 依赖注入容器 — DIContainer
 *
 * 解决当前架构的核心问题：
 * - brain.ts 直接实例化10+模块
 * - cognitive-orchestrator.ts 硬编码12个子系统
 * - duan-v19.0.ts 手动创建30+实例并逐一注入
 *
 * DI容器提供：
 * 1. 统一的服务注册与解析 — register / resolve
 * 2. 生命周期管理 — singleton（单例）/ transient（瞬态）
 * 3. 循环依赖检测 — 解析时自动检测并抛出错误
 * 4. 测试覆盖 — override 方法支持运行时替换依赖
 * 5. 服务间解耦 — 通过 token 而非具体实现依赖
 * 6. 预注册核心服务 — logger / eventBus / modelLibrary / config
 *
 * 设计原则：
 * - 结构化日志：logger.child({ module: 'DIContainer' })
 * - 事件驱动：EventBus.getInstance().emitSync() 广播关键事件
 * - 统一工具格式：ToolDef 兼容 agent-loop.ts 的工具注册体系
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 服务生命周期 */
export type Lifecycle = 'singleton' | 'transient';

/**
 * 带类型的注入令牌
 * 通过泛型参数 T 携带服务类型信息，使 resolve<T>() 能在编译期
 * 校验返回类型与 token 的一致性，避免裸 string 带来的拼写错误与类型不安全。
 */
export class InjectionToken<T> {
  /** 仅用于在编译期保留类型信息，运行时不使用 */
  declare readonly __type?: T;
  constructor(public readonly description: string) {}
  toString(): string {
    return this.description;
  }
}

/** 兼容裸 string 与带类型 InjectionToken 的令牌类型 */
export type Token<T = unknown> = string | InjectionToken<T>;

/** 从令牌中推导服务类型 */
export type TokenType<K> = K extends InjectionToken<infer T> ? T : unknown;

/** 服务工厂函数 */
export type Factory<T = unknown> = (container: DIContainer) => T;

/** 服务注册信息 */
export interface Registration<T = unknown> {
  token: Token<T>;
  lifecycle: Lifecycle;
  factory: Factory<T>;
  instance?: T;
  dependencies: Token[];
  createdAt: number;
}

/** 容器统计信息 */
export interface DIStats {
  totalRegistrations: number;
  singletons: number;
  transients: number;
  resolvedCount: number;
  resolutionTimes: Record<string, number>;
}


/** 默认配置对象 */
const DEFAULT_CONFIG = {
  agentName: '段先生',
  version: '19.0.0',
  maxRetries: 3,
  timeout: 30000,

  logLevel: 'info',
  enableEvolution: true,
  enableSelfLearning: true,
  enableAutoHealing: true,
  defaultModel: 'deepseek-chat',
  maxContextTokens: 8192,
  heartbeatInterval: 30000,
};

// ============ DI 容器主类 ============

export class DIContainer {
  private log = logger.child({ module: 'DIContainer' });
  private eventBus = EventBus.getInstance();

  /** 服务注册表 */
  private registrations: Map<string, Registration> = new Map();

  /** 正在解析中的 token 集合（循环依赖检测） */
  private resolving: Set<string> = new Set();

  /** 解析计数 */
  private resolvedCount = 0;

  /** 每个服务的解析次数 */
  private resolutionTimes: Record<string, number> = {};

  /** override 备份（用于恢复） */
  private overrideBackups: Map<string, Registration> = new Map();

  constructor() {
    // 预注册核心服务
    this.registerCoreServices();
  }

  // ========== 核心方法 ==========

  /**
   * 注册一个依赖
   * @param token 服务标识
   * @param factory 工厂函数
   * @param lifecycle 生命周期，默认 singleton
   * @returns 注册状态描述
   */
  register<T>(token: string, factory: Factory<T>, lifecycle: Lifecycle = 'singleton'): string {
    if (this.registrations.has(token)) {
      this.log.warn('服务已存在，将被覆盖', { token, lifecycle });
    }

    const registration: Registration = {
      token,
      lifecycle,
      factory: factory as Factory,
      dependencies: this.extractDependencies(factory),
      createdAt: Date.now(),
    };

    this.registrations.set(token, registration);

    this.log.debug('服务已注册', { token, lifecycle });
    this.eventBus.emitSync('di.registered', { token, lifecycle }, { source: 'DIContainer' });

    return `✅ 服务 "${token}" 已注册 (${lifecycle})`;
  }

  /**
   * 解析一个依赖
   * @param token 服务标识
   * @returns 服务实例
   */
  resolve<T>(token: string): T {
    const registration = this.registrations.get(token);

    if (!registration) {
      const errorMsg = `服务 "${token}" 未注册`;
      this.log.error(errorMsg, { token });
      this.eventBus.emitSync('di.resolve.failed', { token, reason: 'not_registered' }, { source: 'DIContainer' });
      throw new Error(errorMsg);
    }

    // 单例且已实例化：直接返回缓存
    if (registration.lifecycle === 'singleton' && registration.instance !== undefined) {
      this.resolutionTimes[token] = (this.resolutionTimes[token] || 0) + 1;
      this.resolvedCount++;
      return registration.instance as T;
    }

    // 循环依赖检测
    if (this.resolving.has(token)) {
      const chain = Array.from(this.resolving).join(' → ');
      const errorMsg = `检测到循环依赖: ${chain} → ${token}`;
      this.log.error(errorMsg, { token, chain });
      this.eventBus.emitSync('di.circular', { token, chain }, { source: 'DIContainer' });
      throw new Error(errorMsg);
    }

    this.resolving.add(token);

    try {
      // 通过工厂函数创建实例
      const instance = registration.factory(this) as T;

      // 单例：缓存实例
      if (registration.lifecycle === 'singleton') {
        registration.instance = instance;
      }

      // 更新统计
      this.resolutionTimes[token] = (this.resolutionTimes[token] || 0) + 1;
      this.resolvedCount++;

      this.log.debug('服务已解析', { token, lifecycle: registration.lifecycle });
      this.eventBus.emitSync('di.resolved', { token, lifecycle: registration.lifecycle }, { source: 'DIContainer' });

      return instance;
    } catch (err: unknown) {
      this.log.error('服务解析失败', { token, error: (err instanceof Error ? err.message : String(err)) });
      throw err;
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * 覆盖一个依赖（用于测试）
   * @param token 服务标识
   * @param factory 新的工厂函数
   * @returns 操作结果
   */
  override(token: string, factory: Factory): string {
    const existing = this.registrations.get(token);

    if (!existing) {
      // 如果不存在，直接注册
      this.register(token, factory, 'singleton');
      return `✅ 服务 "${token}" 不存在，已新建注册`;
    }

    // 备份原始注册信息（用于恢复）
    this.overrideBackups.set(token, { ...existing });

    // 覆盖工厂函数，清除缓存的实例
    existing.factory = factory;
    existing.instance = undefined;
    existing.createdAt = Date.now();

    this.log.info('服务已覆盖', { token });
    this.eventBus.emitSync('di.overridden', { token }, { source: 'DIContainer' });

    return `✅ 服务 "${token}" 已覆盖（原始注册已备份，可通过 restore 恢复）`;
  }

  /**
   * 恢复被覆盖的依赖
   * @param token 服务标识
   * @returns 操作结果
   */
  restore(token: string): string {
    const backup = this.overrideBackups.get(token);
    if (!backup) {
      return `⚠️ 服务 "${token}" 没有覆盖备份`;
    }

    this.registrations.set(token, backup);
    this.overrideBackups.delete(token);

    this.log.info('服务已恢复', { token });
    this.eventBus.emitSync('di.restored', { token }, { source: 'DIContainer' });

    return `✅ 服务 "${token}" 已恢复到覆盖前的状态`;
  }

  /**
   * 列出所有已注册的依赖
   */
  listRegistrations(): Registration[] {
    return Array.from(this.registrations.values()).map(reg => ({
      ...reg,
      // 不暴露工厂函数的源码
      factory: reg.factory as Factory,
    }));
  }

  /**
   * 获取容器统计信息
   */
  getStats(): DIStats {
    let singletons = 0;
    let transients = 0;

    for (const reg of this.registrations.values()) {
      if (reg.lifecycle === 'singleton') singletons++;
      else transients++;
    }

    return {
      totalRegistrations: this.registrations.size,
      singletons,
      transients,
      resolvedCount: this.resolvedCount,
      resolutionTimes: { ...this.resolutionTimes },
    };
  }

  // ========== 向后兼容方法（旧 API 别名） ==========

  /**
   * 注册单例服务（向后兼容）
   */
  registerSingleton<T>(id: string, factory: Factory<T>, dependencies: string[] = []): void {
    const reg: Registration = {
      token: id,
      lifecycle: 'singleton',
      factory: factory as Factory,
      instance: undefined,
      dependencies,
      createdAt: Date.now(),
    };
    this.registrations.set(id, reg);
    this.eventBus.emitSync('di.registered', { token: id, lifecycle: 'singleton' }, { source: 'DIContainer' });
  }

  /**
   * 注册瞬态服务（向后兼容）
   */
  registerTransient<T>(id: string, factory: Factory<T>, dependencies: string[] = []): void {
    const reg: Registration = {
      token: id,
      lifecycle: 'transient',
      factory: factory as Factory,
      instance: undefined,
      dependencies,
      createdAt: Date.now(),
    };
    this.registrations.set(id, reg);
    this.eventBus.emitSync('di.registered', { token: id, lifecycle: 'transient' }, { source: 'DIContainer' });
  }

  /**
   * 注册已有实例（向后兼容）
   */
  registerInstance<T>(id: string, instance: T): void {
    const reg: Registration = {
      token: id,
      lifecycle: 'singleton',
      factory: () => instance,
      instance,
      dependencies: [],
      createdAt: Date.now(),
    };
    this.registrations.set(id, reg);
    this.eventBus.emitSync('di.registered', { token: id, lifecycle: 'singleton' }, { source: 'DIContainer' });
  }

  /**
   * 获取服务（向后兼容，未找到时返回 null）
   */
  resolveOrNull<T>(id: string): T | null {
    try {
      return this.resolve<T>(id);
    } catch {
      return null;
    }
  }

  /**
   * 获取服务（严格模式，未找到时抛出异常）
   */
  resolveRequired<T>(id: string): T {
    return this.resolve<T>(id);
  }

  /**
   * 获取所有已注册的服务 ID（向后兼容）
   */
  getRegisteredServices(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * 获取容器状态摘要（向后兼容）
   */
  getSummary(): {
    totalServices: number;
    initializedServices: number;
    singletons: number;
    transients: number;
  } {
    let initialized = 0;
    let singletons = 0;
    let transients = 0;

    for (const reg of this.registrations.values()) {
      if (reg.instance !== undefined) initialized++;
      if (reg.lifecycle === 'singleton') singletons++;
      else transients++;
    }

    return {
      totalServices: this.registrations.size,
      initializedServices: initialized,
      singletons,
      transients,
    };
  }

  // ========== 辅助方法 ==========

  /**
   * 检查服务是否已注册
   */
  isRegistered(token: string): boolean {
    return this.registrations.has(token);
  }

  /**
   * 获取服务依赖图
   */
  getDependencyGraph(): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    for (const [token, reg] of this.registrations) {
      // Token 可能是 InjectionToken（非 string），统一 stringify 以匹配 Record<string, string[]>
      graph[token] = reg.dependencies.map(d => String(d));
    }
    return graph;
  }

  /**
   * 验证所有依赖是否可解析
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 检查缺失依赖
    for (const [token, reg] of this.registrations) {
      for (const depToken of reg.dependencies) {
        const depKey = String(depToken);
        if (!this.registrations.has(depKey)) {
          errors.push(`服务 "${token}" 依赖未注册的服务 "${depToken}"`);
        }
      }
    }

    // 检测循环依赖
    const visited = new Set<string>();
    const stack = new Set<string>();

    const detectCycle = (token: string): boolean => {
      if (stack.has(token)) {
        errors.push(`检测到循环依赖: ${Array.from(stack).join(' → ')} → ${token}`);
        return true;
      }
      if (visited.has(token)) return false;

      visited.add(token);
      stack.add(token);

      const reg = this.registrations.get(token);
      if (reg) {
        for (const depToken of reg.dependencies) {
          if (detectCycle(String(depToken))) return true;
        }
      }

      stack.delete(token);
      return false;
    };

    for (const token of this.registrations.keys()) {
      detectCycle(token);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 初始化所有单例服务
   */
  initializeAll(): Promise<void> {
    const singletons = Array.from(this.registrations.entries())
      .filter(([, reg]) => reg.lifecycle === 'singleton' && reg.instance === undefined);

    for (const [token] of singletons) {
      try {
        this.resolve(token);
      } catch (err: unknown) {
        this.log.warn('初始化服务失败', { token, error: (err instanceof Error ? err.message : String(err)) });
      }
    }

    this.eventBus.emitSync('di.initialized', { count: singletons.length }, { source: 'DIContainer' });
    return Promise.resolve();
  }

  /**
   * 重置容器（清除所有注册和缓存）
   */
  reset(): void {
    this.registrations.clear();
    this.resolving.clear();
    this.overrideBackups.clear();
    this.resolutionTimes = {};
    this.resolvedCount = 0;

    // 重新注册核心服务
    this.registerCoreServices();

    this.log.info('容器已重置');
    this.eventBus.emitSync('di.reset', {}, { source: 'DIContainer' });
  }

  // ========== 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'di_list',
        description: '列出所有已注册的依赖注入服务，显示每个服务的 token、生命周期（singleton/transient）、创建时间和依赖列表。',
        readOnly: true,
        parameters: {
          filter: {
            type: 'string',
            description: '可选过滤关键词，只显示 token 包含该关键词的服务',
            required: false,
          },
        },
        execute: (args) => {
          const filter = (args.filter as string) || '';
          const registrations = this.listRegistrations();

          const filtered = filter
            ? registrations.filter(r => String(r.token).includes(filter))
            : registrations;

          if (filtered.length === 0) {
            return Promise.resolve(`📦 没有已注册的服务${filter ? ` (过滤: "${filter}")` : ''}`);
          }

          let output = `📦 依赖注入容器 — 已注册服务 (${filtered.length}/${registrations.length})\n`;
          output += '═'.repeat(60) + '\n\n';

          for (const reg of filtered) {
            const lifecycleIcon = reg.lifecycle === 'singleton' ? '🔵' : '🟢';
            const hasInstance = reg.instance !== undefined ? '✅' : '⬜';
            const age = Math.floor((Date.now() - reg.createdAt) / 1000);

            output += `${lifecycleIcon} ${reg.token}\n`;
            output += `   生命周期: ${reg.lifecycle} | 已实例化: ${hasInstance} | 注册于: ${age}s前\n`;
            if (reg.dependencies.length > 0) {
              output += `   依赖: [${reg.dependencies.join(', ')}]\n`;
            }
            output += '\n';
          }

          const stats = this.getStats();
          output += '─'.repeat(60) + '\n';
          output += `统计: ${stats.totalRegistrations} 注册 | ${stats.singletons} 单例 | ${stats.transients} 瞬态 | ${stats.resolvedCount} 次解析`;

          return Promise.resolve(output);
        },
      },
      {
        name: 'di_resolve',
        description: '解析指定 token 的依赖注入服务，返回服务实例的类型信息和状态。注意：此工具仅用于调试和检查，不会执行服务的业务逻辑。',
        readOnly: true,
        parameters: {
          token: {
            type: 'string',
            description: '要解析的服务 token 名称',
            required: true,
          },
        },
        execute: (args) => {
          const token = args.token as string;

          if (!this.isRegistered(token)) {
            // 列出相似的服务名
            const allTokens = Array.from(this.registrations.keys());
            const similar = allTokens.filter(t =>
              t.includes(token) || token.includes(t)
            );

            let output = `❌ 服务 "${token}" 未注册\n`;
            if (similar.length > 0) {
              output += `\n💡 你是否想要:\n`;
              for (const s of similar.slice(0, 5)) {
                output += `  - ${s}\n`;
              }
            }
            output += `\n使用 di_list 查看所有已注册服务`;
            return Promise.resolve(output);
          }

          try {
            const instance = this.resolve(token);
            const reg = this.registrations.get(token)!;

            let output = `🔍 服务解析结果\n`;
            output += '═'.repeat(50) + '\n\n';
            output += `Token: ${token}\n`;
            output += `生命周期: ${reg.lifecycle}\n`;
            output += `实例类型: ${instance?.constructor?.name || typeof instance}\n`;
            output += `解析次数: ${this.resolutionTimes[token] || 0}\n`;

            if (reg.dependencies.length > 0) {
              output += `依赖: [${reg.dependencies.join(', ')}]\n`;
            }

            // 如果实例有 getStatus 或 getStats 方法，调用它
            const serviceInstance = instance as { getStatus?: () => unknown; getStats?: () => unknown } | undefined;
            if (serviceInstance && typeof serviceInstance.getStatus === 'function') {
              try {
                output += `\n📊 服务状态:\n${serviceInstance.getStatus()}`;
              } catch { /* 忽略 */ }
            } else if (serviceInstance && typeof serviceInstance.getStats === 'function') {
              try {
                const stats = serviceInstance.getStats();
                output += `\n📊 服务统计:\n${JSON.stringify(stats, null, 2)}`;
              } catch { /* 忽略 */ }
            }

            return Promise.resolve(output);
          } catch (err: unknown) {
            return Promise.resolve(`❌ 解析服务 "${token}" 失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'di_stats',
        description: '获取依赖注入容器的统计信息，包括注册总数、单例/瞬态数量、解析次数、每个服务的解析频率等。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const stats = this.getStats();
          const validation = this.validate();

          let output = `📊 依赖注入容器统计\n`;
          output += '═'.repeat(50) + '\n\n';

          output += `📦 注册服务:\n`;
          output += `  总计: ${stats.totalRegistrations}\n`;
          output += `  单例: ${stats.singletons}\n`;
          output += `  瞬态: ${stats.transients}\n\n`;

          output += `🔄 解析统计:\n`;
          output += `  总解析次数: ${stats.resolvedCount}\n\n`;

          // 解析频率排行
          const sortedResolutions = Object.entries(stats.resolutionTimes)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);

          if (sortedResolutions.length > 0) {
            output += `📈 解析频率 Top ${sortedResolutions.length}:\n`;
            for (const [token, count] of sortedResolutions) {
              const bar = '█'.repeat(Math.min(Math.floor(count / 2), 30));
              output += `  ${token.padEnd(30)} ${count}次 ${bar}\n`;
            }
            output += '\n';
          }

          // 验证结果
          output += `✅ 依赖验证: ${validation.valid ? '通过' : '发现问题'}\n`;
          if (!validation.valid) {
            for (const error of validation.errors) {
              output += `  ⚠️ ${error}\n`;
            }
          }

          return Promise.resolve(output);
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /**
   * 预注册核心服务
   */
  private registerCoreServices(): void {
    // logger — 单例
    this.register('logger', () => logger, 'singleton');

    // eventBus — 单例
    this.register('eventBus', () => EventBus.getInstance(), 'singleton');

    // modelLibrary — 单例（进程级共享，所有消费者复用同一 LRU 缓存与客户端池）
    this.register('modelLibrary', (container) => {
      // 动态导入避免循环依赖
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ModelLibrary } = require('./model-library.js');
        return ModelLibrary.getInstance();
      } catch {
        container.log.warn('ModelLibrary 加载失败，返回 null');
        return null;
      }
    }, 'singleton');

    // config — 单例
    this.register('config', () => {
      // 尝试从环境变量覆盖
      return {
        ...DEFAULT_CONFIG,
        logLevel: process.env.LOG_LEVEL || DEFAULT_CONFIG.logLevel,
        defaultModel: process.env.DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel,
        maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '', 10) || DEFAULT_CONFIG.maxContextTokens,
        heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '', 10) || DEFAULT_CONFIG.heartbeatInterval,
      };
    }, 'singleton');

    this.log.debug('核心服务已预注册', {
      services: ['logger', 'eventBus', 'modelLibrary', 'config'],
    });
  }

  /**
   * 从工厂函数中提取依赖（简单启发式分析）
   * 通过检查工厂函数源码中的 container.resolve() 调用来推断依赖
   */
  private extractDependencies(factory: Factory): string[] {
    const deps: string[] = [];
    try {
      const source = factory.toString();
      // 匹配 container.resolve('token') 或 container.resolve("token")
      const matches = source.matchAll(/container\.resolve\(['"]([^'"]+)['"]\)/g);
      for (const match of matches) {
        if (match[1] && !deps.includes(match[1])) {
          deps.push(match[1]);
        }
      }
    } catch {
      // 无法提取依赖，忽略
    }
    return deps;
  }
}
