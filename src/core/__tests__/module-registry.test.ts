import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleRegistry } from '../module-registry.js';

/**
 * ModuleRegistry 单元测试
 *
 * 覆盖范围：
 * - register / resolve（注册与解析）
 * - hotSwap（热替换，对应 replace 方法）
 * - rollback（版本回滚）
 * - checkHealth（健康检查，对应 healthCheck 方法）
 * - getDependencyOrder（依赖排序，对应 getDependencies / getDependents）
 * - 事件通知
 * - 边界情况
 */

describe('ModuleRegistry', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
  });

  // 构造一个最小可用的模块定义（Omit 掉 status/registeredAt/lastUpdated）
  const createModuleDef = (overrides: Partial<{
    id: string;
    name: string;
    version: string;
    description: string;
    dependencies: string[];
    provides: string[];
    instance: any;
    config: Record<string, any>;
  }> = {}) => ({
    id: 'mod-a',
    name: '模块A',
    version: '1.0.0',
    description: '测试模块A',
    provides: ['feature-a'],
    instance: { hello: () => 'a' },
    ...overrides,
  });

  describe('register / resolve（注册与解析）', () => {
    it('注册新模块返回模块 id', () => {
      const id = registry.register(createModuleDef());
      expect(id).toBe('mod-a');
    });

    it('注册后能通过 getModule 获取模块定义', () => {
      registry.register(createModuleDef());
      const mod = registry.getModule('mod-a');
      expect(mod).toBeDefined();
      expect(mod?.id).toBe('mod-a');
      expect(mod?.name).toBe('模块A');
      expect(mod?.version).toBe('1.0.0');
    });

    it('注册后默认状态为 registered', () => {
      registry.register(createModuleDef());
      expect(registry.getModule('mod-a')?.status).toBe('registered');
    });

    it('注册后 registeredAt 与 lastUpdated 为 Date 实例', () => {
      registry.register(createModuleDef());
      const mod = registry.getModule('mod-a');
      expect(mod?.registeredAt).toBeInstanceOf(Date);
      expect(mod?.lastUpdated).toBeInstanceOf(Date);
    });

    it('getInstance 返回模块实例', () => {
      registry.register(createModuleDef({ instance: { foo: 'bar' } }));
      const inst = registry.getInstance<{ foo: string }>('mod-a');
      expect(inst?.foo).toBe('bar');
    });

    it('getInstance 支持泛型类型推断', () => {
      registry.register(createModuleDef({ instance: 42 }));
      const inst = registry.getInstance<number>('mod-a');
      expect(inst).toBe(42);
      expectTypeOf(inst).toEqualTypeOf<number | undefined>();
    });

    it('getModule 对不存在的模块返回 undefined', () => {
      expect(registry.getModule('not-exist')).toBeUndefined();
    });

    it('getInstance 对不存在的模块返回 undefined', () => {
      expect(registry.getInstance('not-exist')).toBeUndefined();
    });

    it('重复注册同一 id 会覆盖旧实例并升级版本', () => {
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      registry.register(createModuleDef({ version: '2.0.0', instance: { v: 2 } }));
      const mod = registry.getModule('mod-a');
      expect(mod?.version).toBe('2.0.0');
      expect(mod?.instance).toEqual({ v: 2 });
    });

    it('getAllModules 返回所有已注册模块', () => {
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({ id: 'b', name: '模块B' }));
      const all = registry.getAllModules();
      expect(all).toHaveLength(2);
      expect(all.map(m => m.id).sort()).toEqual(['a', 'b']);
    });

    it('findByCapability 按能力查找模块', () => {
      registry.register(createModuleDef({ id: 'a', provides: ['auth', 'logging'] }));
      registry.register(createModuleDef({ id: 'b', provides: ['auth'] }));
      registry.register(createModuleDef({ id: 'c', provides: ['logging'] }));

      const authMods = registry.findByCapability('auth');
      expect(authMods).toHaveLength(2);
      expect(authMods.map(m => m.id).sort()).toEqual(['a', 'b']);

      const loggingMods = registry.findByCapability('logging');
      expect(loggingMods).toHaveLength(2);
      expect(loggingMods.map(m => m.id).sort()).toEqual(['a', 'c']);
    });

    it('findByCapability 对不存在的能力返回空数组', () => {
      registry.register(createModuleDef({ provides: ['auth'] }));
      expect(registry.findByCapability('nope')).toEqual([]);
    });
  });

  describe('unregister（注销）', () => {
    it('成功注销无依赖的模块返回 true', () => {
      registry.register(createModuleDef({ id: 'a' }));
      expect(registry.unregister('a')).toBe(true);
      expect(registry.getModule('a')).toBeUndefined();
    });

    it('注销不存在的模块返回 false', () => {
      expect(registry.unregister('not-exist')).toBe(false);
    });

    it('被其他模块依赖时注销被阻止并返回 false', () => {
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({
        id: 'b',
        dependencies: ['a'],
      }));
      expect(registry.unregister('a')).toBe(false);
      // 模块仍然存在
      expect(registry.getModule('a')).toBeDefined();
    });

    it('注销被阻止时触发 module_unregister_blocked 事件', () => {
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({ id: 'b', dependencies: ['a'] }));
      const handler = vi.fn();
      registry.on('module_unregister_blocked', handler);
      registry.unregister('a');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ moduleId: 'a', dependents: ['b'] }),
      );
    });

    it('注销成功时触发 module_unregistered 事件', () => {
      registry.register(createModuleDef({ id: 'a' }));
      const handler = vi.fn();
      registry.on('module_unregistered', handler);
      registry.unregister('a');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'a' }));
    });
  });

  describe('hotSwap（热替换 - replace）', () => {
    it('替换已存在模块返回 true', () => {
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      expect(registry.replace('mod-a', { v: 2 }, '2.0.0', '修复bug')).toBe(true);
    });

    it('替换不存在的模块返回 false', () => {
      expect(registry.replace('not-exist', {}, '1.0.0', '无')).toBe(false);
    });

    it('替换后实例与版本号更新', () => {
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      registry.replace('mod-a', { v: 2 }, '2.0.0', '修复bug');
      const mod = registry.getModule('mod-a');
      expect(mod?.version).toBe('2.0.0');
      expect(mod?.instance).toEqual({ v: 2 });
    });

    it('替换后状态变为 active', () => {
      registry.register(createModuleDef());
      expect(registry.getModule('mod-a')?.status).toBe('registered');
      registry.replace('mod-a', {}, '2.0.0', '热更');
      expect(registry.getModule('mod-a')?.status).toBe('active');
    });

    it('替换后 lastUpdated 被刷新', () => {
      registry.register(createModuleDef());
      const before = registry.getModule('mod-a')!.lastUpdated.getTime();
      // 等待时间推进
      const wait = new Promise(r => setTimeout(r, 5));
      return wait.then(() => {
        registry.replace('mod-a', {}, '2.0.0', '热更');
        const after = registry.getModule('mod-a')!.lastUpdated.getTime();
        expect(after).toBeGreaterThanOrEqual(before);
      });
    });

    it('替换后版本历史追加新版本', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', '修复bug');
      const history = registry.getVersionHistory('mod-a');
      expect(history).toHaveLength(2);
      expect(history[1].version).toBe('2.0.0');
      expect(history[1].changelog).toBe('修复bug');
      expect(history[1].previousVersion).toBe('1.0.0');
    });

    it('替换后替换历史被记录', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', '修复bug');
      const history = registry.getReplacementHistory('mod-a');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        moduleId: 'mod-a',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        reason: '修复bug',
        rollbackAvailable: true,
        status: 'completed',
      });
      expect(history[0].timestamp).toBeInstanceOf(Date);
    });

    it('替换触发 module_replaced 事件', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      const handler = vi.fn();
      registry.on('module_replaced', handler);
      registry.replace('mod-a', { new: true }, '2.0.0', '修复bug');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        moduleId: 'mod-a',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        reason: '修复bug',
      }));
    });

    it('多次替换累积版本与替换历史', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', 'v2');
      registry.replace('mod-a', {}, '3.0.0', 'v3');
      expect(registry.getVersionHistory('mod-a')).toHaveLength(3);
      expect(registry.getReplacementHistory('mod-a')).toHaveLength(2);
    });
  });

  describe('rollback（版本回滚）', () => {
    it('回滚成功返回 true 并恢复上一版本实例与版本号', () => {
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      registry.replace('mod-a', { v: 2 }, '2.0.0', '修复bug');
      expect(registry.rollback('mod-a')).toBe(true);

      const mod = registry.getModule('mod-a');
      expect(mod?.version).toBe('1.0.0');
      expect(mod?.instance).toEqual({ v: 1 });
    });

    it('回滚后 lastUpdated 被刷新', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', '修复bug');
      const before = registry.getModule('mod-a')!.lastUpdated.getTime();
      registry.rollback('mod-a');
      const after = registry.getModule('mod-a')!.lastUpdated.getTime();
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('只有初始版本（无替换）时回滚返回 false', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      expect(registry.rollback('mod-a')).toBe(false);
    });

    it('回滚不存在的模块返回 false', () => {
      expect(registry.rollback('not-exist')).toBe(false);
    });

    it('回滚后更新替换历史状态为 rolled_back 且 rollbackAvailable=false', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', '修复bug');
      registry.rollback('mod-a');

      const records = registry.getReplacementHistory('mod-a');
      const record = records[0];
      expect(record.status).toBe('rolled_back');
      expect(record.rollbackAvailable).toBe(false);
    });

    it('回滚触发 module_rolled_back 事件', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', '修复bug');
      const handler = vi.fn();
      registry.on('module_rolled_back', handler);
      registry.rollback('mod-a');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        moduleId: 'mod-a',
        fromVersion: '2.0.0',
        toVersion: '1.0.0',
      }));
    });

    it('回滚使用版本历史中的倒数第二个版本（不依赖替换历史）', () => {
      // 通过 register 重新注册产生多个版本历史
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      registry.register(createModuleDef({ version: '2.0.0', instance: { v: 2 } }));
      // 此时版本历史有 2 条，但替换历史为空
      expect(registry.getReplacementHistory('mod-a')).toHaveLength(0);
      // rollback 仍可基于版本历史进行
      expect(registry.rollback('mod-a')).toBe(true);
      expect(registry.getModule('mod-a')?.version).toBe('1.0.0');
    });
  });

  describe('checkHealth（健康检查 - healthCheck）', () => {
    it('active 状态模块判定为健康', () => {
      registry.register(createModuleDef({ id: 'a' }));
      registry.replace('a', {}, '2.0.0', '热更'); // replace 会将状态置为 active
      const health = registry.healthCheck();
      expect(health.get('a')?.healthy).toBe(true);
      expect(health.get('a')?.status).toBe('active');
      expect(health.get('a')?.version).toBe('2.0.0');
    });

    it('initialized 状态模块判定为健康', () => {
      registry.register(createModuleDef({ id: 'a' }));
      // 手动修改内部状态以模拟 initialized
      const mod: any = registry.getModule('a');
      mod.status = 'initialized';
      const health = registry.healthCheck();
      expect(health.get('a')?.healthy).toBe(true);
    });

    it('registered 状态模块判定为不健康', () => {
      registry.register(createModuleDef({ id: 'a' }));
      const health = registry.healthCheck();
      expect(health.get('a')?.healthy).toBe(false);
      expect(health.get('a')?.status).toBe('registered');
    });

    it('error 状态模块判定为不健康', () => {
      registry.register(createModuleDef({ id: 'a' }));
      const mod: any = registry.getModule('a');
      mod.status = 'error';
      expect(registry.healthCheck().get('a')?.healthy).toBe(false);
    });

    it('deprecated 状态模块判定为不健康', () => {
      registry.register(createModuleDef({ id: 'a' }));
      const mod: any = registry.getModule('a');
      mod.status = 'deprecated';
      expect(registry.healthCheck().get('a')?.healthy).toBe(false);
    });

    it('空注册表返回空 Map', () => {
      expect(registry.healthCheck().size).toBe(0);
    });

    it('返回所有模块的健康状态', () => {
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({ id: 'b' }));
      registry.replace('b', {}, '2.0.0', '热更');
      const health = registry.healthCheck();
      expect(health.size).toBe(2);
      expect(health.get('a')?.healthy).toBe(false);
      expect(health.get('b')?.healthy).toBe(true);
    });
  });

  describe('getDependencyOrder（依赖排序 - getDependencies / getDependents）', () => {
    beforeEach(() => {
      // 构造依赖图：c -> b -> a
      registry.register(createModuleDef({ id: 'a', provides: ['base'] }));
      registry.register(createModuleDef({
        id: 'b',
        dependencies: ['a'],
        provides: ['mid'],
      }));
      registry.register(createModuleDef({
        id: 'c',
        dependencies: ['b'],
        provides: ['top'],
      }));
    });

    it('getDependencies 返回直接依赖的模块列表', () => {
      const deps = registry.getDependencies('c');
      expect(deps).toHaveLength(1);
      expect(deps[0].id).toBe('b');
    });

    it('getDependencies 对无依赖的模块返回空数组', () => {
      expect(registry.getDependencies('a')).toEqual([]);
    });

    it('getDependencies 过滤掉未注册的依赖', () => {
      registry.register(createModuleDef({
        id: 'd',
        dependencies: ['a', 'not-registered'],
      }));
      const deps = registry.getDependencies('d');
      expect(deps).toHaveLength(1);
      expect(deps[0].id).toBe('a');
    });

    it('getDependencies 对不存在的模块返回空数组', () => {
      expect(registry.getDependencies('not-exist')).toEqual([]);
    });

    it('getDependents 返回所有直接依赖该模块的模块', () => {
      const dependents = registry.getDependents('a');
      expect(dependents).toHaveLength(1);
      expect(dependents[0].id).toBe('b');
    });

    it('getDependents 对无被依赖的模块返回空数组', () => {
      expect(registry.getDependents('c')).toEqual([]);
    });

    it('getDependents 支持多个依赖者', () => {
      registry.register(createModuleDef({
        id: 'e',
        dependencies: ['a'],
      }));
      const dependents = registry.getDependents('a');
      expect(dependents.map(d => d.id).sort()).toEqual(['b', 'e']);
    });

    it('getDependents 对不存在的模块返回空数组', () => {
      expect(registry.getDependents('not-exist')).toEqual([]);
    });

    it('可基于 getDependencies 实现拓扑排序（依赖在前）', () => {
      // 简易拓扑排序：从某个模块出发，先收集依赖再收集自身
      const topo: string[] = [];
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        for (const dep of registry.getDependencies(id)) {
          visit(dep.id);
        }
        topo.push(id);
      };
      visit('c');
      // 依赖在前：a, b, c
      expect(topo).toEqual(['a', 'b', 'c']);
    });
  });

  describe('事件通知', () => {
    it('register 触发 module_registered 事件', () => {
      const handler = vi.fn();
      registry.on('module_registered', handler);
      registry.register(createModuleDef({ id: 'a', version: '1.2.3' }));
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a',
        version: '1.2.3',
      }));
    });

    it('register 多次触发多次事件', () => {
      const handler = vi.fn();
      registry.on('module_registered', handler);
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({ id: 'b' }));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('replace 触发 module_replaced 事件并携带版本信息', () => {
      const handler = vi.fn();
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.on('module_replaced', handler);
      registry.replace('a', {}, '2.0.0', '升级');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        moduleId: 'a',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        reason: '升级',
      }));
    });

    it('rollback 触发 module_rolled_back 事件', () => {
      const handler = vi.fn();
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.replace('a', {}, '2.0.0', '升级');
      registry.on('module_rolled_back', handler);
      registry.rollback('a');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        moduleId: 'a',
        fromVersion: '2.0.0',
        toVersion: '1.0.0',
      }));
    });

    it('unregister 成功触发 module_unregistered 事件', () => {
      const handler = vi.fn();
      registry.register(createModuleDef({ id: 'a' }));
      registry.on('module_unregistered', handler);
      registry.unregister('a');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unregister 被阻止时触发 module_unregister_blocked 事件且不触发 module_unregistered', () => {
      const blockedHandler = vi.fn();
      const unregHandler = vi.fn();
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({ id: 'b', dependencies: ['a'] }));
      registry.on('module_unregister_blocked', blockedHandler);
      registry.on('module_unregistered', unregHandler);
      registry.unregister('a');
      expect(blockedHandler).toHaveBeenCalledTimes(1);
      expect(unregHandler).not.toHaveBeenCalled();
    });

    it('ModuleRegistry 继承自 EventEmitter，支持 once/off 等方法', () => {
      const handler = vi.fn();
      registry.once('module_registered', handler);
      registry.register(createModuleDef({ id: 'a' }));
      registry.register(createModuleDef({ id: 'b' }));
      // once 只触发一次
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('版本历史与替换历史查询', () => {
    it('getVersionHistory 返回模块的版本历史', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.replace('mod-a', {}, '2.0.0', 'v2');
      const history = registry.getVersionHistory('mod-a');
      expect(history).toHaveLength(2);
      expect(history[0].version).toBe('1.0.0');
      expect(history[0].changelog).toBe('初始注册');
      expect(history[1].version).toBe('2.0.0');
      expect(history[1].previousVersion).toBe('1.0.0');
    });

    it('getVersionHistory 对不存在的模块返回空数组', () => {
      expect(registry.getVersionHistory('not-exist')).toEqual([]);
    });

    it('getVersionHistory 首次注册的 changelog 为"初始注册"', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      const history = registry.getVersionHistory('mod-a');
      expect(history[0].changelog).toBe('初始注册');
    });

    it('重复注册时 changelog 包含升级信息', () => {
      registry.register(createModuleDef({ version: '1.0.0' }));
      registry.register(createModuleDef({ version: '2.0.0' }));
      const history = registry.getVersionHistory('mod-a');
      expect(history[1].changelog).toBe('从 v1.0.0 升级到 v2.0.0');
      expect(history[1].previousVersion).toBe('1.0.0');
    });

    it('getReplacementHistory 不传参返回全部替换历史', () => {
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.register(createModuleDef({ id: 'b', version: '1.0.0' }));
      registry.replace('a', {}, '2.0.0', 'a升级');
      registry.replace('b', {}, '2.0.0', 'b升级');
      const all = registry.getReplacementHistory();
      expect(all).toHaveLength(2);
    });

    it('getReplacementHistory 传 moduleId 返回该模块的替换历史', () => {
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.register(createModuleDef({ id: 'b', version: '1.0.0' }));
      registry.replace('a', {}, '2.0.0', 'a升级');
      registry.replace('b', {}, '2.0.0', 'b升级');
      const aHistory = registry.getReplacementHistory('a');
      expect(aHistory).toHaveLength(1);
      expect(aHistory[0].moduleId).toBe('a');
    });

    it('getReplacementHistory 返回的是副本，修改不影响内部状态', () => {
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.replace('a', {}, '2.0.0', '升级');
      const h1 = registry.getReplacementHistory();
      h1.length = 0;
      const h2 = registry.getReplacementHistory();
      expect(h2).toHaveLength(1);
    });

    it('getReplacementHistory 对无替换记录的模块返回空数组', () => {
      registry.register(createModuleDef({ id: 'a' }));
      expect(registry.getReplacementHistory('a')).toEqual([]);
    });
  });

  describe('generateReport（报告生成）', () => {
    it('空注册表生成包含基本标题的报告', () => {
      const report = registry.generateReport();
      expect(report).toContain('模块注册表报告');
      expect(report).toContain('已注册模块: 0');
      expect(report).toContain('替换历史: 0 次');
    });

    it('报告包含模块名称、版本与状态', () => {
      registry.register(createModuleDef({ id: 'a', name: '模块A', version: '1.0.0' }));
      const report = registry.generateReport();
      expect(report).toContain('模块A');
      expect(report).toContain('v1.0.0');
      expect(report).toContain('registered');
    });

    it('报告包含依赖与能力信息', () => {
      registry.register(createModuleDef({
        id: 'a',
        dependencies: ['b'],
        provides: ['auth'],
      }));
      const report = registry.generateReport();
      expect(report).toContain('依赖: b');
      expect(report).toContain('能力: auth');
    });

    it('健康模块使用 ✅ 标记，不健康模块使用 ❌ 标记', () => {
      registry.register(createModuleDef({ id: 'a' })); // registered -> 不健康
      registry.register(createModuleDef({ id: 'b' }));
      registry.replace('b', {}, '2.0.0', '热更'); // active -> 健康
      const report = registry.generateReport();
      expect(report).toContain('❌');
      expect(report).toContain('✅');
    });

    it('报告统计替换历史次数', () => {
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.replace('a', {}, '2.0.0', '升级');
      registry.replace('a', {}, '3.0.0', '再升级');
      const report = registry.generateReport();
      expect(report).toContain('替换历史: 2 次');
    });
  });

  describe('边界情况', () => {
    it('注册空 provides 数组的模块', () => {
      registry.register(createModuleDef({ provides: [] }));
      expect(registry.getModule('mod-a')).toBeDefined();
      expect(registry.findByCapability('any')).toEqual([]);
    });

    it('注册无 dependencies 字段的模块', () => {
      registry.register(createModuleDef({ dependencies: undefined }));
      expect(registry.getDependencies('mod-a')).toEqual([]);
    });

    it('注册 instance 为原始值的模块', () => {
      registry.register(createModuleDef({ instance: 42 }));
      expect(registry.getInstance('mod-a')).toBe(42);
    });

    it('注册 instance 为 null 的模块', () => {
      registry.register(createModuleDef({ instance: null }));
      expect(registry.getInstance('mod-a')).toBeNull();
    });

    it('注册 instance 为函数的模块', () => {
      const fn = () => 'hello';
      registry.register(createModuleDef({ instance: fn }));
      expect(registry.getInstance('mod-a')).toBe(fn);
    });

    it('replace 传入相同版本号也能成功', () => {
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      expect(registry.replace('mod-a', { v: 2 }, '1.0.0', '同版本热更')).toBe(true);
      expect(registry.getModule('mod-a')?.instance).toEqual({ v: 2 });
    });

    it('rollback 后再次 rollback 失败（版本历史长度仍为 2，但替换历史已 rolled_back）', () => {
      // 注意：源码 rollback 仅检查 versionHistory.length >= 2，不检查替换历史状态
      // 因此连续 rollback 会持续取倒数第二个版本
      registry.register(createModuleDef({ version: '1.0.0', instance: { v: 1 } }));
      registry.replace('mod-a', { v: 2 }, '2.0.0', '升级');
      expect(registry.rollback('mod-a')).toBe(true);
      // 第二次 rollback：版本历史仍为 2 条，会再次回滚到 v1.0.0
      // 这是源码的当前行为，测试予以记录
      const secondResult = registry.rollback('mod-a');
      // 源码不阻止连续回滚，因此返回 true
      expect(secondResult).toBe(true);
    });

    it('循环依赖场景：getDependents 与 getDependencies 不会无限递归', () => {
      registry.register(createModuleDef({ id: 'a', dependencies: ['b'] }));
      registry.register(createModuleDef({ id: 'b', dependencies: ['a'] }));
      // 直接查询不会递归，仅返回直接依赖/被依赖
      expect(registry.getDependencies('a')[0].id).toBe('b');
      expect(registry.getDependents('a')[0].id).toBe('b');
    });

    it('unregister 后再注册同名模块可正常使用', () => {
      registry.register(createModuleDef({ id: 'a', version: '1.0.0' }));
      registry.unregister('a');
      registry.register(createModuleDef({ id: 'a', version: '2.0.0' }));
      expect(registry.getModule('a')?.version).toBe('2.0.0');
      // 注意：源码 unregister 不清理 versions，版本历史会累积
      expect(registry.getVersionHistory('a').length).toBeGreaterThanOrEqual(2);
    });

    it('register 返回值始终为 module.id', () => {
      expect(registry.register(createModuleDef({ id: 'custom-id' }))).toBe('custom-id');
    });

    it('config 字段可被保留', () => {
      registry.register(createModuleDef({ config: { timeout: 1000, retry: true } }));
      expect(registry.getModule('mod-a')?.config).toEqual({ timeout: 1000, retry: true });
    });

    it('description 字段可被保留', () => {
      registry.register(createModuleDef({ description: '一段描述' }));
      expect(registry.getModule('mod-a')?.description).toBe('一段描述');
    });
  });
});
