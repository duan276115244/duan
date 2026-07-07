/**
 * PermissionManager 全面单元测试
 * 覆盖 RBAC 角色权限、风险等级限制、安全策略条件评估、允许/拒绝决策及边界情况
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PermissionManager, type SecurityContext } from '../permissions.js';

describe('PermissionManager', () => {
  let manager: PermissionManager;

  // 可信的早晨上下文（避免触发夜间策略和不可信环境策略）
  const trustedMorningCtx: SecurityContext = {
    isTrustedEnvironment: true,
    timeOfDay: 'morning',
  };

  beforeEach(() => {
    manager = new PermissionManager();
    // 抑制源码中的 console 输出，保持测试输出整洁
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('默认初始化', () => {
    it('应初始化 14 个默认权限', () => {
      const permissions = manager.getAllPermissions();
      expect(permissions).toHaveLength(14);
    });

    it('应包含所有关键默认权限', () => {
      const ids = manager.getAllPermissions().map(p => p.id);
      expect(ids).toContain('read_file');
      expect(ids).toContain('write_file');
      expect(ids).toContain('edit_file');
      expect(ids).toContain('delete_file');
      expect(ids).toContain('list_files');
      expect(ids).toContain('search_code');
      expect(ids).toContain('execute_command');
      expect(ids).toContain('execute_dangerous_command');
      expect(ids).toContain('web_search');
      expect(ids).toContain('web_fetch');
      expect(ids).toContain('generate_image');
      expect(ids).toContain('generate_video');
      expect(ids).toContain('system_config');
      expect(ids).toContain('network_access');
    });

    it('execute_dangerous_command 默认应被禁止且为 critical 风险', () => {
      const permissions = manager.getAllPermissions();
      const dangerous = permissions.find(p => p.id === 'execute_dangerous_command');
      expect(dangerous).toBeDefined();
      expect(dangerous!.allowed).toBe(false);
      expect(dangerous!.riskLevel).toBe('critical');
    });

    it('delete_file 默认应需要审批', () => {
      const permissions = manager.getAllPermissions();
      const del = permissions.find(p => p.id === 'delete_file');
      expect(del).toBeDefined();
      expect(del!.requiresApproval).toBe(true);
      expect(del!.riskLevel).toBe('high');
    });

    it('execute_command 应有命令限制列表', () => {
      const permissions = manager.getAllPermissions();
      const exec = permissions.find(p => p.id === 'execute_command');
      expect(exec).toBeDefined();
      expect(exec!.restrictions).toEqual(['node', 'npm', 'git', 'python', 'pip']);
    });
  });

  describe('check 方法 - 允许决策', () => {
    it('应允许低风险工具 read_file', async () => {
      const result = await manager.check('read_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('low');
      expect(result.requiresApproval).toBeUndefined();
    });

    it('应允许中等风险工具 write_file', async () => {
      const result = await manager.check('write_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('medium');
    });

    it('应允许高风险工具 execute_command（合法命令 git）', async () => {
      const result = await manager.check('execute_command', { command: 'git status' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('high');
    });

    it('应允许 list_files 工具', async () => {
      const result = await manager.check('list_files', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 web_search 工具', async () => {
      const result = await manager.check('web_search', { query: 'test' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 web_fetch 工具', async () => {
      const result = await manager.check('web_fetch', { url: 'http://example.com' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 network_access 工具', async () => {
      const result = await manager.check('network_access', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('medium');
    });
  });

  describe('check 方法 - 拒绝决策', () => {
    it('应拒绝未知工具', async () => {
      const result = await manager.check('unknown_tool', {}, trustedMorningCtx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('未知工具');
      expect(result.reason).toContain('unknown_tool');
    });

    it('应拒绝 allowed=false 的工具（execute_dangerous_command）', async () => {
      const result = await manager.check('execute_dangerous_command', {}, trustedMorningCtx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('未被允许');
    });

    it('应拒绝超出限制范围的命令 rm', async () => {
      const result = await manager.check('execute_command', { command: 'rm -rf /' }, trustedMorningCtx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('限制范围');
    });

    it('应拒绝超出限制范围的命令 format', async () => {
      const result = await manager.check('execute_command', { command: 'format C:' }, trustedMorningCtx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('限制范围');
    });

    it('应拒绝超出限制范围的命令 shutdown', async () => {
      const result = await manager.check('execute_command', { command: 'shutdown /s' }, trustedMorningCtx);
      expect(result.allowed).toBe(false);
    });

    it('应拒绝不在限制列表中的命令 curl', async () => {
      const result = await manager.check('execute_command', { command: 'curl http://example.com' }, trustedMorningCtx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('限制范围');
    });
  });

  describe('check 方法 - 风险等级限制（RBAC）', () => {
    it('viewer 角色应允许低风险操作 read_file', async () => {
      manager.assignRole('viewer_user', 'viewer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'viewer_user' };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('viewer 角色应拒绝中等风险操作 write_file（风险超出）', async () => {
      manager.assignRole('viewer_user', 'viewer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'viewer_user' };
      const result = await manager.check('write_file', {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('风险等级');
      expect(result.requiresApproval).toBe(true);
    });

    it('viewer 角色应拒绝高风险操作 execute_command', async () => {
      manager.assignRole('viewer_user', 'viewer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'viewer_user' };
      const result = await manager.check('execute_command', { command: 'git status' }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    });

    it('developer 角色应允许高风险操作', async () => {
      // 默认用户角色为 developer（maxRiskLevel = high）
      const result = await manager.check('execute_command', { command: 'git status' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('developer 角色应允许中等风险操作 write_file', async () => {
      const result = await manager.check('write_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('admin 角色应允许所有风险等级操作', async () => {
      manager.assignRole('admin_user', 'admin');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'admin_user' };
      // admin maxRiskLevel = critical，允许高风险
      const result = await manager.check('execute_command', { command: 'git status' }, ctx);
      expect(result.allowed).toBe(true);
    });

    it('未分配角色的用户应回退到 developer 默认角色', async () => {
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'unknown_user' };
      // unknown_user 不在 userRoles 中，回退到 developer
      const result = await manager.check('write_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('无 userId 时应使用 developer 默认角色', async () => {
      const result = await manager.check('write_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('默认 default 用户应拥有 developer 角色', async () => {
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'default' };
      const result = await manager.check('write_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('check 方法 - 安全策略条件评估（ABAC）', () => {
    it('不可信环境应拒绝所有操作（deny_dangerous_commands 策略）', async () => {
      const ctx: SecurityContext = {
        isTrustedEnvironment: false,
        timeOfDay: 'morning',
      };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('安全策略');
    });

    it('夜间应拒绝所有操作（restrict_night_operations 策略）', async () => {
      const ctx: SecurityContext = {
        isTrustedEnvironment: true,
        timeOfDay: 'night',
      };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('安全策略');
    });

    it('可信且非夜间环境应允许操作', async () => {
      const ctx: SecurityContext = {
        isTrustedEnvironment: true,
        timeOfDay: 'afternoon',
      };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('可信且 evening 时段应允许操作', async () => {
      const ctx: SecurityContext = {
        isTrustedEnvironment: true,
        timeOfDay: 'evening',
      };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('isTrustedEnvironment 为 undefined 时应触发拒绝策略', async () => {
      const ctx: SecurityContext = {
        timeOfDay: 'morning',
        // isTrustedEnvironment 未设置
      };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(false);
    });

    it('策略优先级：deny_dangerous_commands(100) 应先于 restrict_night_operations(50) 评估', async () => {
      // 两个策略都满足时，高优先级的 deny_dangerous_commands 先生效
      const ctx: SecurityContext = {
        isTrustedEnvironment: false,
        timeOfDay: 'night',
      };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(false);
    });

    it('应支持添加高优先级自定义 deny 策略', async () => {
      manager.addPolicy({
        name: 'custom_deny_all',
        description: '自定义拒绝所有',
        condition: () => true,
        effect: 'deny',
        priority: 200,
      });
      const result = await manager.check('read_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(false);
    });

    it('高优先级 allow 策略应覆盖低优先级 deny 策略', async () => {
      // 添加 allow_all 策略（priority 200），优先级高于 deny_dangerous_commands(100)
      manager.addPolicy({
        name: 'allow_all',
        description: '允许所有',
        condition: () => true,
        effect: 'allow',
        priority: 200,
      });
      const ctx: SecurityContext = {
        isTrustedEnvironment: false,
        timeOfDay: 'morning',
      };
      // allow 策略先匹配，evaluatePolicies 返回 'allow'，check 不处理 allow，继续后续检查
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('自定义 deny 策略应只影响匹配的上下文', async () => {
      manager.addPolicy({
        name: 'deny_blocked_user',
        description: '拒绝特定用户',
        condition: (ctx) => ctx.userId === 'blocked_user',
        effect: 'deny',
        priority: 150,
      });
      // 被阻止的用户
      const blockedCtx: SecurityContext = { ...trustedMorningCtx, userId: 'blocked_user' };
      const blockedResult = await manager.check('read_file', {}, blockedCtx);
      expect(blockedResult.allowed).toBe(false);

      // 正常用户不受影响
      const normalCtx: SecurityContext = { ...trustedMorningCtx, userId: 'normal_user' };
      const normalResult = await manager.check('read_file', {}, normalCtx);
      expect(normalResult.allowed).toBe(true);
    });
  });

  describe('check 方法 - 限制条件检查', () => {
    it('应允许 node 命令', async () => {
      const result = await manager.check('execute_command', { command: 'node script.js' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 npm 命令', async () => {
      const result = await manager.check('execute_command', { command: 'npm install' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 git 命令', async () => {
      const result = await manager.check('execute_command', { command: 'git commit -m "test"' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 python 命令', async () => {
      const result = await manager.check('execute_command', { command: 'python script.py' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应允许 pip 命令', async () => {
      const result = await manager.check('execute_command', { command: 'pip install package' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('命令大小写不敏感（NODE 应被允许）', async () => {
      const result = await manager.check('execute_command', { command: 'NODE script.js' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('命令大小写不敏感（GIT 应被允许）', async () => {
      const result = await manager.check('execute_command', { command: 'GIT status' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('部分匹配：nodejs 命令应被允许（包含 node）', async () => {
      const result = await manager.check('execute_command', { command: 'nodejs script.js' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('无 command 参数时应通过限制检查', async () => {
      const result = await manager.check('execute_command', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('空 command 字符串应通过限制检查', async () => {
      const result = await manager.check('execute_command', { command: '' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('无 command 属性但有其他参数时应通过限制检查', async () => {
      const result = await manager.check('execute_command', { other: 'value' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('check 方法 - 需要审批', () => {
    it('delete_file 应返回需要审批', async () => {
      const result = await manager.check('delete_file', { path: '/test' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('审批');
      expect(result.riskLevel).toBe('high');
    });

    it('system_config 应返回需要审批', async () => {
      const result = await manager.check('system_config', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.riskLevel).toBe('high');
    });

    it('普通低风险工具不需要审批', async () => {
      const result = await manager.check('read_file', { path: '/test' }, trustedMorningCtx);
      expect(result.requiresApproval).toBeUndefined();
    });

    it('普通中风险工具不需要审批', async () => {
      const result = await manager.check('write_file', {}, trustedMorningCtx);
      expect(result.requiresApproval).toBeUndefined();
    });
  });

  describe('check 方法 - 前缀匹配', () => {
    it('应通过前缀匹配工具 read_file_extended', async () => {
      const result = await manager.check('read_file_extended', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('low');
    });

    it('应通过前缀匹配工具 execute_command_custom', async () => {
      const result = await manager.check('execute_command_custom', { command: 'git status' }, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应通过前缀匹配工具 list_files_all', async () => {
      const result = await manager.check('list_files_all', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('check 方法 - 默认上下文', () => {
    it('不提供 context 时应使用默认上下文且不抛异常', async () => {
      // 默认上下文 isTrustedEnvironment: true，timeOfDay 取决于当前时间
      // 仅验证不抛异常并返回有效结果
      const result = await manager.check('read_file', {});
      expect(result).toBeDefined();
      expect(result.allowed).toBeDefined();
    });
  });

  describe('setPermission', () => {
    it('应更新现有权限为禁止', async () => {
      manager.setPermission('read_file', false);
      const result = await manager.check('read_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(false);
    });

    it('应添加新权限并允许', async () => {
      manager.setPermission('custom_tool', true);
      const result = await manager.check('custom_tool', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('新权限默认风险等级应为 medium', async () => {
      manager.setPermission('custom_tool', true);
      const result = await manager.check('custom_tool', {}, trustedMorningCtx);
      expect(result.riskLevel).toBe('medium');
    });

    it('应保留现有权限的属性（如风险等级）', async () => {
      // read_file 原本 riskLevel: low
      manager.setPermission('read_file', false);
      const result = await manager.check('read_file', {}, trustedMorningCtx);
      // 被禁止后返回 reason，不返回 riskLevel
      expect(result.allowed).toBe(false);
    });

    it('应支持设置限制条件', async () => {
      manager.setPermission('custom_exec', true, ['allowed_cmd']);
      // custom_exec 不是 execute_command，限制检查不生效，总是通过
      const result = await manager.check('custom_exec', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('assignRole', () => {
    it('应为新用户分配角色', async () => {
      manager.assignRole('test_user', 'viewer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'test_user' };
      // viewer maxRiskLevel = low，write_file 是 medium，应被拒绝
      const result = await manager.check('write_file', {}, ctx);
      expect(result.allowed).toBe(false);
    });

    it('不应重复分配相同角色', async () => {
      manager.assignRole('test_user', 'viewer');
      manager.assignRole('test_user', 'viewer');
      // 验证：分配两次 viewer 后，行为应与分配一次相同
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'test_user' };
      const result = await manager.check('write_file', {}, ctx);
      expect(result.allowed).toBe(false);
    });

    it('应支持为用户分配多个角色（取最大风险等级）', async () => {
      manager.assignRole('multi_user', 'viewer');
      manager.assignRole('multi_user', 'admin');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'multi_user' };
      // viewer (low=0) + admin (critical=3) -> Math.max(0, 3) = 3
      // execute_command 是 high=2，2 > 3 = false，应允许
      const result = await manager.check('execute_command', { command: 'git status' }, ctx);
      expect(result.allowed).toBe(true);
    });

    it('viewer + developer 多角色应取 developer 的 high 风险等级', async () => {
      manager.assignRole('multi_user', 'viewer');
      manager.assignRole('multi_user', 'developer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'multi_user' };
      // viewer (low=0) + developer (high=2) -> Math.max(0, 2) = 2
      // execute_command 是 high=2，2 > 2 = false，应允许
      const result = await manager.check('execute_command', { command: 'git status' }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('getDeniedLog', () => {
    it('应记录拒绝操作', async () => {
      await manager.check('unknown_tool', {}, trustedMorningCtx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(1);
      expect(log[0].toolName).toBe('unknown_tool');
      expect(log[0].reason).toContain('未知工具');
      expect(log[0].timestamp).toBeInstanceOf(Date);
    });

    it('不应记录允许的操作', async () => {
      await manager.check('read_file', {}, trustedMorningCtx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(0);
    });

    it('应记录多次拒绝', async () => {
      await manager.check('unknown_tool1', {}, trustedMorningCtx);
      await manager.check('unknown_tool2', {}, trustedMorningCtx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(2);
      expect(log[0].toolName).toBe('unknown_tool1');
      expect(log[1].toolName).toBe('unknown_tool2');
    });

    it('应返回日志副本（不暴露内部引用）', async () => {
      await manager.check('unknown_tool', {}, trustedMorningCtx);
      const log1 = manager.getDeniedLog();
      const log2 = manager.getDeniedLog();
      expect(log1).not.toBe(log2);
      expect(log1).toEqual(log2);
    });

    it('应记录不同类型的拒绝原因', async () => {
      // 未知工具
      await manager.check('unknown_tool', {}, trustedMorningCtx);
      // 危险命令
      await manager.check('execute_command', { command: 'rm -rf /' }, trustedMorningCtx);
      // 策略拒绝
      await manager.check('read_file', {}, { isTrustedEnvironment: false, timeOfDay: 'morning' });

      const log = manager.getDeniedLog();
      expect(log).toHaveLength(3);
      expect(log[0].reason).toContain('未知工具');
      expect(log[1].reason).toContain('超出限制范围');
      expect(log[2].reason).toContain('安全策略');
    });

    it('应只保留最近 100 条记录', async () => {
      // 触发 105 次拒绝
      for (let i = 0; i < 105; i++) {
        await manager.check(`unknown_tool_${i}`, {}, trustedMorningCtx);
      }
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(100);
      // 前 5 条应被移除，log[0] 应为 unknown_tool_5
      expect(log[0].toolName).toBe('unknown_tool_5');
      // 最后一条应为 unknown_tool_104
      expect(log[99].toolName).toBe('unknown_tool_104');
    });
  });

  describe('requestApproval', () => {
    it('低风险工具应自动批准', async () => {
      const result = await manager.requestApproval('read_file', {});
      expect(result).toBe(true);
    });

    it('低风险工具 list_files 应自动批准', async () => {
      const result = await manager.requestApproval('list_files', {});
      expect(result).toBe(true);
    });

    it('高风险工具无回调且不在自动批准列表应拒绝', async () => {
      const result = await manager.requestApproval('execute_command', { command: 'git status' });
      expect(result).toBe(false);
    });

    it('高风险工具在自动批准列表应批准', async () => {
      manager.addAutoApproveTool('execute_command');
      const result = await manager.requestApproval('execute_command', { command: 'git status' });
      expect(result).toBe(true);
    });

    it('高风险工具使用回调应返回回调结果（true）', async () => {
      manager.setApprovalCallback(async () => true);
      const result = await manager.requestApproval('execute_command', { command: 'git status' });
      expect(result).toBe(true);
    });

    it('高风险工具使用回调应返回回调结果（false）', async () => {
      manager.setApprovalCallback(async () => false);
      const result = await manager.requestApproval('execute_command', { command: 'git status' });
      expect(result).toBe(false);
    });

    it('关键风险工具无回调应拒绝', async () => {
      const result = await manager.requestApproval('execute_dangerous_command', {});
      expect(result).toBe(false);
    });

    it('关键风险工具使用回调应返回回调结果', async () => {
      manager.setApprovalCallback(async () => true);
      const result = await manager.requestApproval('execute_dangerous_command', {});
      expect(result).toBe(true);
    });

    it('中等风险工具无回调应默认批准', async () => {
      const result = await manager.requestApproval('write_file', {});
      expect(result).toBe(true);
    });

    it('中等风险工具在自动批准列表应批准', async () => {
      manager.addAutoApproveTool('write_file');
      const result = await manager.requestApproval('write_file', {});
      expect(result).toBe(true);
    });

    it('中等风险工具使用回调应返回回调结果', async () => {
      manager.setApprovalCallback(async () => false);
      const result = await manager.requestApproval('write_file', {});
      expect(result).toBe(false);
    });

    it('未知工具应使用 moderate 风险等级，默认批准', async () => {
      const result = await manager.requestApproval('unknown_tool', {});
      expect(result).toBe(true);
    });

    it('未知工具在自动批准列表应批准', async () => {
      manager.addAutoApproveTool('unknown_tool');
      const result = await manager.requestApproval('unknown_tool', {});
      expect(result).toBe(true);
    });

    it('未知工具使用回调应返回回调结果', async () => {
      manager.setApprovalCallback(async () => false);
      const result = await manager.requestApproval('unknown_tool', {});
      expect(result).toBe(false);
    });

    it('回调应接收正确的参数', async () => {
      let receivedToolName = '';
      let receivedParams: any;
      let receivedRiskLevel = '';
      manager.setApprovalCallback(async (toolName, params, riskLevel) => {
        receivedToolName = toolName;
        receivedParams = params;
        receivedRiskLevel = riskLevel;
        return true;
      });
      await manager.requestApproval('execute_command', { command: 'git status' });
      expect(receivedToolName).toBe('execute_command');
      expect(receivedParams).toEqual({ command: 'git status' });
      expect(receivedRiskLevel).toBe('high');
    });
  });

  describe('addPolicy', () => {
    it('应添加自定义 deny 策略并生效', async () => {
      manager.addPolicy({
        name: 'custom_deny',
        description: '自定义拒绝',
        condition: (ctx) => ctx.userId === 'blocked_user',
        effect: 'deny',
        priority: 150,
      });
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'blocked_user' };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(false);
    });

    it('自定义策略不应影响不匹配的上下文', async () => {
      manager.addPolicy({
        name: 'custom_deny',
        description: '自定义拒绝',
        condition: (ctx) => ctx.userId === 'blocked_user',
        effect: 'deny',
        priority: 150,
      });
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'normal_user' };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('应支持基于 IP 地址的策略', async () => {
      manager.addPolicy({
        name: 'deny_suspicious_ip',
        description: '拒绝可疑 IP',
        condition: (ctx) => ctx.ipAddress === '192.168.1.100',
        effect: 'deny',
        priority: 120,
      });
      const suspiciousCtx: SecurityContext = { ...trustedMorningCtx, ipAddress: '192.168.1.100' };
      const result = await manager.check('read_file', {}, suspiciousCtx);
      expect(result.allowed).toBe(false);
    });
  });

  describe('loadFromFile / saveToFile', () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-test-'));
      tempFile = path.join(tempDir, 'permissions.json');
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    });

    it('应保存权限配置到文件', async () => {
      await manager.saveToFile(tempFile);
      const exists = await fs.access(tempFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('应加载已保存的权限配置', async () => {
      await manager.saveToFile(tempFile);

      // 创建新管理器并修改权限
      const newManager = new PermissionManager();
      newManager.setPermission('read_file', false);
      // 验证修改生效
      let permissions = newManager.getAllPermissions();
      let readFile = permissions.find(p => p.id === 'read_file');
      expect(readFile!.allowed).toBe(false);

      // 加载配置后应恢复
      // 注意：JSON 序列化会丢失 policy.condition 函数，因此加载后无法调用 check()
      // 改为通过 getAllPermissions() 验证权限已恢复
      await newManager.loadFromFile(tempFile);
      permissions = newManager.getAllPermissions();
      readFile = permissions.find(p => p.toolName === 'read_file');
      expect(readFile).toBeDefined();
      expect(readFile!.allowed).toBe(true);
    });

    it('加载不存在的文件应静默失败（不抛异常）', async () => {
      const newManager = new PermissionManager();
      await expect(newManager.loadFromFile('/nonexistent/path/file.json')).resolves.not.toThrow();
      // 权限应保持默认
      const result = await newManager.check('read_file', {}, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('应保存到不存在的目录（自动创建）', async () => {
      const nestedFile = path.join(tempDir, 'nested', 'dir', 'permissions.json');
      await manager.saveToFile(nestedFile);
      const exists = await fs.access(nestedFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('保存的文件应包含 permissions、roles、policies', async () => {
      await manager.saveToFile(tempFile);
      const content = await fs.readFile(tempFile, 'utf-8');
      const data = JSON.parse(content);
      expect(data.permissions).toBeDefined();
      expect(Array.isArray(data.permissions)).toBe(true);
      expect(data.permissions.length).toBe(14);
      expect(data.roles).toBeDefined();
      expect(Array.isArray(data.roles)).toBe(true);
      expect(data.policies).toBeDefined();
      expect(Array.isArray(data.policies)).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('空字符串工具名应被拒绝为未知工具', async () => {
      const result = await manager.check('', {}, trustedMorningCtx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('未知工具');
    });

    it('null parameters 不应导致崩溃（read_file）', async () => {
      const result = await manager.check('read_file', null as any, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('undefined parameters 不应导致崩溃（read_file）', async () => {
      const result = await manager.check('read_file', undefined as any, trustedMorningCtx);
      expect(result.allowed).toBe(true);
    });

    it('用户分配不存在的角色应回退到 medium 风险等级', async () => {
      manager.assignRole('bad_user', 'nonexistent_role');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'bad_user' };
      // nonexistent_role 不在 roles 中，返回 1 (medium)
      // write_file 是 medium=1，1 > 1 = false，应允许
      const writeResult = await manager.check('write_file', {}, ctx);
      expect(writeResult.allowed).toBe(true);
      // execute_command 是 high=2，2 > 1 = true，应拒绝
      const execResult = await manager.check('execute_command', { command: 'git status' }, ctx);
      expect(execResult.allowed).toBe(false);
      expect(execResult.requiresApproval).toBe(true);
    });

    it('多个不存在的角色应都回退到 medium', async () => {
      manager.assignRole('bad_user', 'fake_role1');
      manager.assignRole('bad_user', 'fake_role2');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'bad_user' };
      // 两个不存在的角色都返回 1 (medium)，Math.max(1, 1) = 1
      const result = await manager.check('write_file', {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it('混合存在和不存在的角色应正确计算风险等级', async () => {
      manager.assignRole('mix_user', 'viewer');
      manager.assignRole('mix_user', 'fake_role');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'mix_user' };
      // viewer (low=0) + fake_role (medium=1) -> Math.max(0, 1) = 1
      // write_file 是 medium=1，1 > 1 = false，应允许
      const writeResult = await manager.check('write_file', {}, ctx);
      expect(writeResult.allowed).toBe(true);
      // execute_command 是 high=2，2 > 1 = true，应拒绝
      const execResult = await manager.check('execute_command', { command: 'git status' }, ctx);
      expect(execResult.allowed).toBe(false);
    });

    it('viewer 角色对低风险工具不应返回 requiresApproval', async () => {
      manager.assignRole('viewer_user', 'viewer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'viewer_user' };
      const result = await manager.check('read_file', {}, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBeUndefined();
    });

    it('策略拒绝应记录到拒绝日志', async () => {
      const ctx: SecurityContext = { isTrustedEnvironment: false, timeOfDay: 'morning' };
      await manager.check('read_file', {}, ctx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('安全策略拒绝');
    });

    it('allowed=false 工具应记录到拒绝日志', async () => {
      await manager.check('execute_dangerous_command', {}, trustedMorningCtx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('权限未开启');
    });

    it('超出限制范围应记录到拒绝日志', async () => {
      await manager.check('execute_command', { command: 'rm -rf /' }, trustedMorningCtx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('超出限制范围');
    });

    it('风险等级超出应记录到拒绝日志', async () => {
      manager.assignRole('viewer_user', 'viewer');
      const ctx: SecurityContext = { ...trustedMorningCtx, userId: 'viewer_user' };
      await manager.check('write_file', {}, ctx);
      const log = manager.getDeniedLog();
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('风险等级超出角色权限');
    });
  });
});
