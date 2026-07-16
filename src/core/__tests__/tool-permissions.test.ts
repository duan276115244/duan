/**
 * v20.0 §2.5 分级许可清单测试
 *
 * 测试 ToolPermissionRegistry 的核心功能：
 * - 四级许可来源（session/cli/project/global）
 * - 模式匹配（Edit / Bash(git:*) / Read(*) / *）
 * - 决策优先级（deny > allow > ask，session > cli > project > global）
 * - 加载/保存 settings.json
 * - 会话级 grant/revoke
 * - 工具定义与执行
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 在 import 之前设置 DUAN_DATA_DIR，避免模块级缓存
const TEST_DATA_DIR = path.join(os.tmpdir(), `duan-perms-test-${Date.now()}-${process.pid}`);
process.env.DUAN_DATA_DIR = TEST_DATA_DIR;

import {
  ToolPermissionRegistry,
  getToolPermissionRegistry,
} from '../tool-permissions.js';

// ============ 工具：创建临时项目 ============

function createTempProject(): string {
  const dir = path.join(os.tmpdir(), `perms-project-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(dir, '.duan'), { recursive: true });
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

function writeSettings(dir: string, settings: Record<string, unknown>): void {
  writeFile(dir, '.duan/settings.json', JSON.stringify(settings, null, 2));
}

// ============ 测试 ============

describe('v20.0 §2.5: ToolPermissionRegistry', () => {
  let registry: ToolPermissionRegistry;
  let tmpProject: string;

  beforeEach(() => {
    // 为每个测试创建全新的 registry 实例（不走单例）
    registry = new ToolPermissionRegistry();
    tmpProject = createTempProject();
  });

  afterEach(() => {
    // 清理临时项目
    try {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    } catch {
      // 忽略
    }
    // 清理全局 settings.json（避免测试间干扰）
    try {
      const globalPath = path.join(TEST_DATA_DIR, 'settings.json');
      if (fs.existsSync(globalPath)) fs.unlinkSync(globalPath);
    } catch {
      // 忽略
    }
  });

  describe('加载', () => {
    it('无 settings.json 时不报错，规则为空', () => {
      registry.load(tmpProject);
      expect(registry.getRulesBySource('global').length).toBe(0);
      expect(registry.getRulesBySource('project').length).toBe(0);
    });

    it('加载项目级 settings.json', () => {
      writeSettings(tmpProject, {
        permissions: {
          allow: ['Edit', 'Read'],
          deny: ['Bash(rm:*)'],
          ask: ['Bash(*)'],
        },
      });
      registry.load(tmpProject);
      const projectRules = registry.getRulesBySource('project');
      expect(projectRules.length).toBe(4);
      expect(projectRules.some(r => r.pattern === 'Edit' && r.decision === 'allow')).toBe(true);
      expect(projectRules.some(r => r.pattern === 'Bash(rm:*)' && r.decision === 'deny')).toBe(true);
      expect(projectRules.some(r => r.pattern === 'Bash(*)' && r.decision === 'ask')).toBe(true);
    });

    it('加载全局级 settings.json', () => {
      // 先用 saveGlobalSettings 写入全局规则
      registry.load(tmpProject);
      registry.saveGlobalSettings({ allow: ['GlobalTool'] });

      // 新实例加载时应读到全局规则
      const freshRegistry = new ToolPermissionRegistry();
      freshRegistry.load(tmpProject);
      const globalRules = freshRegistry.getRulesBySource('global');
      expect(globalRules.length).toBe(1);
      expect(globalRules[0].pattern).toBe('GlobalTool');
    });

    it('损坏的 settings.json 不报错，规则为空', () => {
      writeFile(tmpProject, '.duan/settings.json', '{ invalid json');
      registry.load(tmpProject);
      expect(registry.getRulesBySource('project').length).toBe(0);
    });

    it('settings.json 无 permissions 字段时规则为空', () => {
      writeSettings(tmpProject, { model: 'gpt-4' });
      registry.load(tmpProject);
      expect(registry.getRulesBySource('project').length).toBe(0);
    });
  });

  describe('CLI 注入', () => {
    it('loadFromCli 注入 allow 规则', () => {
      registry.loadFromCli(['Edit', 'Read'], []);
      const cliRules = registry.getRulesBySource('cli');
      expect(cliRules.length).toBe(2);
      expect(cliRules.every(r => r.decision === 'allow')).toBe(true);
    });

    it('loadFromCli 注入 deny 规则', () => {
      registry.loadFromCli([], ['Bash(rm:*)']);
      const cliRules = registry.getRulesBySource('cli');
      expect(cliRules.length).toBe(1);
      expect(cliRules[0].decision).toBe('deny');
    });

    it('loadFromCli 空数组不注入规则', () => {
      registry.loadFromCli();
      expect(registry.getRulesBySource('cli').length).toBe(0);
    });

    it('多次 loadFromCli 覆盖之前的规则', () => {
      registry.loadFromCli(['Edit'], []);
      expect(registry.getRulesBySource('cli').length).toBe(1);
      registry.loadFromCli(['Read', 'Write'], ['Bash(*)']);
      const cliRules = registry.getRulesBySource('cli');
      expect(cliRules.length).toBe(3);
      expect(cliRules.some(r => r.pattern === 'Edit')).toBe(false);
    });
  });

  describe('会话级 grant/revoke', () => {
    it('grant 添加会话级规则', () => {
      registry.grant('Edit', 'allow', '用户授权');
      const sessionRules = registry.getRulesBySource('session');
      expect(sessionRules.length).toBe(1);
      expect(sessionRules[0].pattern).toBe('Edit');
      expect(sessionRules[0].decision).toBe('allow');
      expect(sessionRules[0].note).toBe('用户授权');
    });

    it('grant 默认决策为 allow', () => {
      registry.grant('Read');
      const sessionRules = registry.getRulesBySource('session');
      expect(sessionRules[0].decision).toBe('allow');
    });

    it('grant 同模式不重复', () => {
      registry.grant('Edit', 'allow');
      registry.grant('Edit', 'deny'); // 覆盖
      const sessionRules = registry.getRulesBySource('session');
      expect(sessionRules.length).toBe(1);
      expect(sessionRules[0].decision).toBe('deny');
    });

    it('revoke 撤销指定模式', () => {
      registry.grant('Edit');
      registry.grant('Read');
      expect(registry.getRulesBySource('session').length).toBe(2);
      registry.revoke('Edit');
      const sessionRules = registry.getRulesBySource('session');
      expect(sessionRules.length).toBe(1);
      expect(sessionRules[0].pattern).toBe('Read');
    });

    it('revoke 不存在的模式无副作用', () => {
      registry.grant('Edit');
      registry.revoke('NonExistent');
      expect(registry.getRulesBySource('session').length).toBe(1);
    });

    it('clearSession 清空所有会话级规则', () => {
      registry.grant('Edit');
      registry.grant('Read');
      registry.clearSession();
      expect(registry.getRulesBySource('session').length).toBe(0);
    });
  });

  describe('模式匹配', () => {
    it('通配符 * 匹配所有工具', () => {
      registry.grant('*', 'allow');
      expect(registry.check('Edit').decision).toBe('allow');
      expect(registry.check('Bash').decision).toBe('allow');
      expect(registry.check('AnyTool').decision).toBe('allow');
    });

    it('精确工具名匹配', () => {
      registry.grant('Edit', 'allow');
      expect(registry.check('Edit').decision).toBe('allow');
      expect(registry.check('Read').decision).toBe('ask'); // 默认
    });

    it('ToolName(*) 匹配任意参数', () => {
      registry.grant('Bash(*)', 'allow');
      expect(registry.check('Bash', { command: 'ls -la' }).decision).toBe('allow');
      expect(registry.check('Bash', { command: 'rm -rf /' }).decision).toBe('allow');
      expect(registry.check('Edit').decision).toBe('ask'); // 默认
    });

    it('Bash(git:*) 匹配 git 命令', () => {
      registry.grant('Bash(git:*)', 'allow');
      expect(registry.check('Bash', { command: 'git push' }).decision).toBe('allow');
      expect(registry.check('Bash', { command: 'git commit -m "x"' }).decision).toBe('allow');
      expect(registry.check('Bash', { command: 'rm -rf /' }).decision).toBe('ask'); // 非 git
    });

    it('Bash(rm:*) 匹配 rm 命令', () => {
      registry.grant('Bash(rm:*)', 'deny');
      expect(registry.check('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
      expect(registry.check('Bash', { command: 'git push' }).decision).toBe('ask');
    });

    it('参数为字符串时直接匹配', () => {
      registry.grant('Bash(git:*)', 'allow');
      expect(registry.check('Bash', 'git status').decision).toBe('allow');
      expect(registry.check('Bash', 'ls').decision).toBe('ask');
    });

    it('参数为 undefined 时视为空字符串', () => {
      registry.grant('Bash(git:*)', 'allow');
      expect(registry.check('Bash').decision).toBe('ask'); // 空 string 不匹配 git:*
    });

    it('参数对象有 cmd 字段也匹配', () => {
      registry.grant('Bash(git:*)', 'allow');
      expect(registry.check('Bash', { cmd: 'git pull' }).decision).toBe('allow');
    });
  });

  describe('决策优先级', () => {
    it('deny 优先于 allow（安全优先）', () => {
      registry.grant('Bash(*)', 'allow');      // session allow
      registry.loadFromCli([], ['Bash(*)']);    // cli deny
      // deny 应优先
      expect(registry.check('Bash').decision).toBe('deny');
    });

    it('deny 优先于 ask', () => {
      registry.grant('Bash(*)', 'ask');
      registry.loadFromCli([], ['Bash(*)']);
      expect(registry.check('Bash').decision).toBe('deny');
    });

    it('allow 优先于 ask', () => {
      registry.grant('Bash(*)', 'ask');
      registry.loadFromCli(['Bash(*)'], []);
      // allow (cli) vs ask (session) → allow 优先
      expect(registry.check('Bash').decision).toBe('allow');
    });

    it('同决策时 session 优先于 cli', () => {
      registry.grant('Edit', 'allow');          // session
      registry.loadFromCli(['Edit'], []);        // cli
      const result = registry.check('Edit');
      expect(result.decision).toBe('allow');
      expect(result.matchedRule!.source).toBe('session');
    });

    it('同决策时 cli 优先于 project', () => {
      registry.loadFromCli(['Edit'], []);        // cli
      writeSettings(tmpProject, { permissions: { allow: ['Edit'] } });
      registry.load(tmpProject);
      // 重新注入 cli（load 会重置 project 但不重置 cli）
      registry.loadFromCli(['Edit'], []);
      const result = registry.check('Edit');
      expect(result.decision).toBe('allow');
      expect(result.matchedRule!.source).toBe('cli');
    });

    it('无规则命中时走默认决策', () => {
      const result = registry.check('UnknownTool');
      expect(result.decision).toBe('ask'); // 默认 ask
      expect(result.matchedRule).toBeNull();
      expect(result.reason).toContain('默认策略');
    });

    it('setDefaultDecision 修改默认决策', () => {
      registry.setDefaultDecision('allow');
      expect(registry.check('UnknownTool').decision).toBe('allow');
      registry.setDefaultDecision('deny');
      expect(registry.check('UnknownTool').decision).toBe('deny');
    });

    it('matchedRules 按优先级排序', () => {
      registry.grant('Bash(*)', 'allow');       // session allow
      registry.loadFromCli([], ['Bash(*)']);     // cli deny
      const result = registry.check('Bash');
      expect(result.matchedRules.length).toBe(2);
      expect(result.matchedRules[0].decision).toBe('deny'); // deny 在前
      expect(result.matchedRules[1].decision).toBe('allow');
    });
  });

  describe('快捷方法', () => {
    it('isAutoAllowed', () => {
      registry.grant('Edit', 'allow');
      expect(registry.isAutoAllowed('Edit')).toBe(true);
      expect(registry.isAutoAllowed('Bash')).toBe(false);
    });

    it('isAutoDenied', () => {
      registry.grant('Bash(rm:*)', 'deny');
      expect(registry.isAutoDenied('Bash', { command: 'rm -rf /' })).toBe(true);
      expect(registry.isAutoDenied('Bash', { command: 'git push' })).toBe(false);
    });
  });

  describe('持久化', () => {
    it('saveProjectSettings 写入 .duan/settings.json', () => {
      registry.load(tmpProject);
      registry.saveProjectSettings({
        allow: ['Edit'],
        deny: ['Bash(rm:*)'],
      });
      const content = fs.readFileSync(path.join(tmpProject, '.duan', 'settings.json'), 'utf-8');
      const settings = JSON.parse(content);
      expect(settings.permissions.allow).toContain('Edit');
      expect(settings.permissions.deny).toContain('Bash(rm:*)');
    });

    it('saveProjectSettings 保留其他字段', () => {
      writeSettings(tmpProject, { model: 'gpt-4', theme: 'dark' });
      registry.load(tmpProject);
      registry.saveProjectSettings({ allow: ['Edit'] });
      const content = fs.readFileSync(path.join(tmpProject, '.duan', 'settings.json'), 'utf-8');
      const settings = JSON.parse(content);
      expect(settings.model).toBe('gpt-4');
      expect(settings.theme).toBe('dark');
      expect(settings.permissions.allow).toContain('Edit');
    });

    it('saveProjectSettings 后重新加载规则', () => {
      registry.load(tmpProject);
      registry.saveProjectSettings({ allow: ['NewTool'] });
      const projectRules = registry.getRulesBySource('project');
      expect(projectRules.some(r => r.pattern === 'NewTool')).toBe(true);
    });

    it('saveGlobalSettings 写入全局 settings.json', () => {
      registry.load(tmpProject);
      registry.saveGlobalSettings({ allow: ['GlobalEdit'] });
      const globalPath = registry.getGlobalSettingsPath();
      const content = fs.readFileSync(globalPath, 'utf-8');
      const settings = JSON.parse(content);
      expect(settings.permissions.allow).toContain('GlobalEdit');
    });

    it('saveProjectSettings 未 load 时抛错', () => {
      const freshRegistry = new ToolPermissionRegistry();
      expect(() => freshRegistry.saveProjectSettings({ allow: ['X'] })).toThrow();
    });
  });

  describe('查询', () => {
    it('getAllRules 返回四级副本', () => {
      registry.grant('Edit', 'allow');
      registry.loadFromCli(['Read'], []);
      const all = registry.getAllRules();
      expect(all.session.length).toBe(1);
      expect(all.cli.length).toBe(1);
      expect(all.project.length).toBe(0);
      expect(all.global.length).toBe(0);
    });

    it('getAllRules 修改返回值不影响内部状态', () => {
      registry.grant('Edit', 'allow');
      const all = registry.getAllRules();
      all.session.push({ pattern: 'X', decision: 'allow', source: 'session', createdAt: 0 });
      expect(registry.getRulesBySource('session').length).toBe(1);
    });

    it('getRulesBySource 返回副本', () => {
      registry.grant('Edit', 'allow');
      const rules = registry.getRulesBySource('session');
      rules.pop();
      expect(registry.getRulesBySource('session').length).toBe(1);
    });

    it('getDefaultDecision 返回默认决策', () => {
      expect(registry.getDefaultDecision()).toBe('ask');
    });

    it('getProjectSettingsPath 返回项目路径', () => {
      registry.load(tmpProject);
      expect(registry.getProjectSettingsPath()).toBe(path.join(tmpProject, '.duan', 'settings.json'));
    });

    it('load 后 getProjectSettingsPath 不为 null', () => {
      expect(registry.getProjectSettingsPath()).toBeNull();
      registry.load(tmpProject);
      expect(registry.getProjectSettingsPath()).not.toBeNull();
    });
  });

  describe('概览', () => {
    it('getOverview 包含标题', () => {
      const overview = registry.getOverview();
      expect(overview).toContain('分级许可清单');
    });

    it('getOverview 包含四级来源', () => {
      const overview = registry.getOverview();
      expect(overview).toContain('会话级');
      expect(overview).toContain('CLI');
      expect(overview).toContain('项目级');
      expect(overview).toContain('全局级');
    });

    it('getOverview 包含规则', () => {
      registry.grant('Edit', 'allow', '用户授权');
      const overview = registry.getOverview();
      expect(overview).toContain('Edit');
      expect(overview).toContain('allow');
      expect(overview).toContain('用户授权');
    });

    it('getOverview 包含默认决策', () => {
      const overview = registry.getOverview();
      expect(overview).toContain('默认决策');
      expect(overview).toContain('ask');
    });

    it('getOverview 包含用法说明', () => {
      const overview = registry.getOverview();
      expect(overview).toContain('用法');
      expect(overview).toContain('permission_grant');
      expect(overview).toContain('Bash(git:*)');
    });
  });

  describe('LLM 工具', () => {
    it('返回 3 个工具定义', () => {
      const tools = registry.getToolDefinitions();
      expect(tools.length).toBe(3);
      const names = tools.map(t => t.name);
      expect(names).toContain('permission_list');
      expect(names).toContain('permission_grant');
      expect(names).toContain('permission_revoke');
    });

    it('每个工具有 execute 函数', () => {
      const tools = registry.getToolDefinitions();
      tools.forEach(t => {
        expect(typeof t.execute).toBe('function');
      });
    });

    it('permission_list 返回概览', async () => {
      const tools = registry.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'permission_list');
      const result = await listTool!.execute({});
      expect(result).toContain('分级许可清单');
    });

    it('permission_grant 有效参数返回成功', async () => {
      const tools = registry.getToolDefinitions();
      const grantTool = tools.find(t => t.name === 'permission_grant');
      const result = await grantTool!.execute({ pattern: 'Edit', decision: 'allow' });
      expect(result).toContain('✅');
      expect(result).toContain('Edit');
      expect(result).toContain('allow');
      // 验证规则确实添加了
      expect(registry.getRulesBySource('session').length).toBe(1);
    });

    it('permission_grant 默认 decision 为 allow', async () => {
      const tools = registry.getToolDefinitions();
      const grantTool = tools.find(t => t.name === 'permission_grant');
      await grantTool!.execute({ pattern: 'Read' });
      expect(registry.getRulesBySource('session')[0].decision).toBe('allow');
    });

    it('permission_grant 无效 decision 返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const grantTool = tools.find(t => t.name === 'permission_grant');
      const result = await grantTool!.execute({ pattern: 'Edit', decision: 'invalid' });
      expect(result).toContain('❌');
      expect(result).toContain('无效');
    });

    it('permission_grant 缺少 pattern 返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const grantTool = tools.find(t => t.name === 'permission_grant');
      const result = await grantTool!.execute({});
      expect(result).toContain('❌');
      expect(result).toContain('pattern');
    });

    it('permission_grant 支持 deny 决策', async () => {
      const tools = registry.getToolDefinitions();
      const grantTool = tools.find(t => t.name === 'permission_grant');
      await grantTool!.execute({ pattern: 'Bash(rm:*)', decision: 'deny' });
      expect(registry.check('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
    });

    it('permission_revoke 撤销规则', async () => {
      const tools = registry.getToolDefinitions();
      const grantTool = tools.find(t => t.name === 'permission_grant');
      const revokeTool = tools.find(t => t.name === 'permission_revoke');
      await grantTool!.execute({ pattern: 'Edit' });
      expect(registry.getRulesBySource('session').length).toBe(1);
      const result = await revokeTool!.execute({ pattern: 'Edit' });
      expect(result).toContain('✅');
      expect(registry.getRulesBySource('session').length).toBe(0);
    });

    it('permission_revoke 缺少 pattern 返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const revokeTool = tools.find(t => t.name === 'permission_revoke');
      const result = await revokeTool!.execute({});
      expect(result).toContain('❌');
    });
  });

  describe('单例', () => {
    it('getToolPermissionRegistry 返回同一实例', () => {
      const a = getToolPermissionRegistry();
      const b = getToolPermissionRegistry();
      expect(a).toBe(b);
    });

    it('getToolPermissionRegistry 返回有效实例', () => {
      const reg = getToolPermissionRegistry();
      expect(reg).toBeInstanceOf(ToolPermissionRegistry);
      expect(typeof reg.check).toBe('function');
    });
  });

  describe('端到端场景', () => {
    it('场景：项目级 allow + 全局级 deny → deny 优先', () => {
      // 全局 deny
      registry.saveGlobalSettings({ deny: ['Bash(rm:*)'] });
      // 项目 allow
      writeSettings(tmpProject, { permissions: { allow: ['Bash(*)'] } });
      registry.load(tmpProject);
      const result = registry.check('Bash', { command: 'rm -rf /' });
      expect(result.decision).toBe('deny');
    });

    it('场景：会话级覆盖项目级', () => {
      writeSettings(tmpProject, { permissions: { deny: ['Edit'] } });
      registry.load(tmpProject);
      expect(registry.check('Edit').decision).toBe('deny');
      // 用户会话级 grant
      registry.grant('Edit', 'allow', '用户临时授权');
      // deny 仍优先（安全第一）
      const result = registry.check('Edit');
      expect(result.decision).toBe('deny');
    });

    it('场景：CLI 启动授权 + 会话级细化', () => {
      registry.loadFromCli(['Edit', 'Read', 'Bash(git:*)'], ['Bash(rm:*)']);
      // git 操作自动放行
      expect(registry.check('Bash', { command: 'git push' }).decision).toBe('allow');
      // rm 自动拒绝
      expect(registry.check('Bash', { command: 'rm -rf /' }).decision).toBe('deny');
      // 其他 Bash 走默认 ask
      expect(registry.check('Bash', { command: 'ls' }).decision).toBe('ask');
    });

    it('场景：模式优先级 — 精确 > 通配', () => {
      registry.grant('Bash(*)', 'allow');       // 通配 allow
      registry.grant('Bash(rm:*)', 'deny');      // 精确 deny
      // 两条都命中，deny 优先
      const result = registry.check('Bash', { command: 'rm -rf /' });
      expect(result.decision).toBe('deny');
      // 非 rm 的 Bash 仍 allow
      expect(registry.check('Bash', { command: 'git push' }).decision).toBe('allow');
    });
  });
});
