/**
 * 模块化架构 - ModuleRegistry
 *
 * 支持功能组件的动态注册、加载、替换和版本管理：
 * 1. 模块注册 - 动态注册功能模块
 * 2. 版本管理 - 模块版本追踪和回滚
 * 3. 热替换 - 运行时替换模块实现
 * 4. 依赖管理 - 模块间依赖关系解析
 * 5. 健康检查 - 模块运行状态监控
 */

import { EventEmitter } from 'events';

/** 模块定义 */
export interface ModuleDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  dependencies?: string[];                // 依赖的模块ID
  provides: string[];                     // 提供的能力
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态模块实例,保持 any 以支持任意类型注入
  instance: any;                          // 模块实例
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 模块配置为动态 JSON
  config?: Record<string, any>;
  status: 'registered' | 'initialized' | 'active' | 'error' | 'deprecated';
  registeredAt: Date;
  lastUpdated: Date;
}

/** 模块版本 */
interface ModuleVersion {
  version: string;
  instance: unknown;
  registeredAt: Date;
  changelog: string;
  previousVersion?: string;
}

/** 模块替换记录 */
interface ModuleReplacementRecord {
  moduleId: string;
  fromVersion: string;
  toVersion: string;
  timestamp: Date;
  reason: string;
  rollbackAvailable: boolean;
  status: 'completed' | 'rolled_back';
}

export class ModuleRegistry extends EventEmitter {
  private modules: Map<string, ModuleDefinition> = new Map();
  private versions: Map<string, ModuleVersion[]> = new Map();
  private replacementHistory: ModuleReplacementRecord[] = [];

  /**
   * 注册模块
   */
  register(module: Omit<ModuleDefinition, 'status' | 'registeredAt' | 'lastUpdated'>): string {
    const existing = this.modules.get(module.id);

    const definition: ModuleDefinition = {
      ...module,
      status: 'registered',
      registeredAt: new Date(),
      lastUpdated: new Date(),
    };

    this.modules.set(module.id, definition);

    // 记录版本
    if (!this.versions.has(module.id)) {
      this.versions.set(module.id, []);
    }
    this.versions.get(module.id)!.push({
      version: module.version,
      instance: module.instance,
      registeredAt: new Date(),
      changelog: existing ? `从 v${existing.version} 升级到 v${module.version}` : '初始注册',
      previousVersion: existing?.version,
    });

    this.emit('module_registered', { id: module.id, version: module.version });

    return module.id;
  }

  /**
   * 注销模块
   */
  unregister(moduleId: string): boolean {
    const module = this.modules.get(moduleId);
    if (!module) return false;

    // 检查是否有其他模块依赖它
    const dependents = this.getDependents(moduleId);
    if (dependents.length > 0) {
      this.emit('module_unregister_blocked', { moduleId, dependents: dependents.map(d => d.id) });
      return false;
    }

    this.modules.delete(moduleId);
    this.emit('module_unregistered', { moduleId });
    return true;
  }

  /**
   * 获取模块
   */
  getModule(moduleId: string): ModuleDefinition | undefined {
    return this.modules.get(moduleId);
  }

  /**
   * 获取模块实例
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 泛型默认值保持 any 以兼容现有调用
  getInstance<T = any>(moduleId: string): T | undefined {
    return this.modules.get(moduleId)?.instance as T | undefined;
  }

  /**
   * 热替换模块
   */
  replace(moduleId: string, newInstance: unknown, newVersion: string, reason: string): boolean {
    const existing = this.modules.get(moduleId);
    if (!existing) return false;

    const fromVersion = existing.version;

    // 执行替换
    existing.instance = newInstance;
    existing.version = newVersion;
    existing.lastUpdated = new Date();
    existing.status = 'active';

    // 记录版本
    this.versions.get(moduleId)?.push({
      version: newVersion,
      instance: newInstance,
      registeredAt: new Date(),
      changelog: reason,
      previousVersion: fromVersion,
    });

    // 记录替换历史
    this.replacementHistory.push({
      moduleId,
      fromVersion,
      toVersion: newVersion,
      timestamp: new Date(),
      reason,
      rollbackAvailable: true,
      status: 'completed',
    });

    this.emit('module_replaced', { moduleId, fromVersion, toVersion: newVersion, reason });

    return true;
  }

  /**
   * 回滚模块到上一版本
   */
  rollback(moduleId: string): boolean {
    const versionHistory = this.versions.get(moduleId);
    if (!versionHistory || versionHistory.length < 2) return false;

    const currentVersion = versionHistory[versionHistory.length - 1];
    const previousVersion = versionHistory[versionHistory.length - 2];

    const module = this.modules.get(moduleId);
    if (!module) return false;

    // 回滚
    module.instance = previousVersion.instance;
    module.version = previousVersion.version;
    module.lastUpdated = new Date();

    // 更新替换记录
    const lastReplacement = this.replacementHistory.find(
      r => r.moduleId === moduleId && r.rollbackAvailable && r.status === 'completed'
    );
    if (lastReplacement) {
      lastReplacement.status = 'rolled_back';
      lastReplacement.rollbackAvailable = false;
    }

    this.emit('module_rolled_back', { moduleId, fromVersion: currentVersion.version, toVersion: previousVersion.version });

    return true;
  }

  /**
   * 获取依赖模块
   */
  getDependencies(moduleId: string): ModuleDefinition[] {
    const module = this.modules.get(moduleId);
    if (!module?.dependencies) return [];

    return module.dependencies
      .map(depId => this.modules.get(depId))
      .filter((m): m is ModuleDefinition => !!m);
  }

  /**
   * 获取被依赖的模块
   */
  getDependents(moduleId: string): ModuleDefinition[] {
    const dependents: ModuleDefinition[] = [];
    this.modules.forEach((module) => {
      if (module.dependencies?.includes(moduleId)) {
        dependents.push(module);
      }
    });
    return dependents;
  }

  /**
   * 健康检查
   */
  healthCheck(): Map<string, { healthy: boolean; status: string; version: string }> {
    const results = new Map<string, { healthy: boolean; status: string; version: string }>();

    this.modules.forEach((module, id) => {
      const healthy = module.status === 'active' || module.status === 'initialized';
      results.set(id, {
        healthy,
        status: module.status,
        version: module.version,
      });
    });

    return results;
  }

  /**
   * 获取所有模块
   */
  getAllModules(): ModuleDefinition[] {
    return Array.from(this.modules.values());
  }

  /**
   * 获取模块版本历史
   */
  getVersionHistory(moduleId: string): ModuleVersion[] {
    return this.versions.get(moduleId) || [];
  }

  /**
   * 获取替换历史
   */
  getReplacementHistory(moduleId?: string): ModuleReplacementRecord[] {
    if (moduleId) {
      return this.replacementHistory.filter(r => r.moduleId === moduleId);
    }
    return [...this.replacementHistory];
  }

  /**
   * 按能力查找模块
   */
  findByCapability(capability: string): ModuleDefinition[] {
    return Array.from(this.modules.values())
      .filter(m => m.provides.includes(capability));
  }

  /**
   * 生成模块报告
   */
  generateReport(): string {
    const lines: string[] = [];
    const health = this.healthCheck();

    lines.push('🔧 模块注册表报告');
    lines.push('');
    lines.push(`已注册模块: ${this.modules.size}`);
    lines.push(`替换历史: ${this.replacementHistory.length} 次`);
    lines.push('');

    lines.push('━━━ 模块列表 ━━━');
    this.modules.forEach((module, id) => {
      const healthInfo = health.get(id);
      const icon = healthInfo?.healthy ? '✅' : '❌';
      lines.push(`${icon} ${module.name} (v${module.version}) - ${module.status}`);
      if (module.dependencies?.length) {
        lines.push(`   依赖: ${module.dependencies.join(', ')}`);
      }
      if (module.provides.length) {
        lines.push(`   能力: ${module.provides.join(', ')}`);
      }
    });

    return lines.join('\n');
  }
}
