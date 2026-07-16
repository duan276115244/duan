/**
 * v20.0 §2.4 斜杠命令系统测试
 *
 * 测试 SlashCommandRegistry 的核心功能：
 * - 内置命令定义完整性
 * - 命令检测与参数提取
 * - 模板渲染与占位符替换
 * - 自定义命令加载（global/project）
 * - 工具定义与执行
 * - 缓存机制
 * - 单例
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 关键：在导入 slash-commands（会传递性导入 duan-paths）前设置 DUAN_DATA_DIR，
// 隔离测试环境，避免写入真实 ~/.duan/commands。
// vitest 默认 isolate 模式下每个测试文件有独立模块图，cachedDataDir 会重新初始化。
const TEST_DATA_DIR = path.join(os.tmpdir(), 'duan-slash-cmd-test');
process.env.DUAN_DATA_DIR = TEST_DATA_DIR;

import {
  SlashCommandRegistry,
  getSlashCommandRegistry,
  type SlashCommand,
} from '../slash-commands.js';

// ============ 工具：创建临时目录 ============

function createTempDir(prefix = 'slash-cmd-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCommandFile(dir: string, name: string, content: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ============ 测试 ============

describe('v20.0 §2.4: SlashCommandRegistry', () => {
  let registry: SlashCommandRegistry;
  let tmpCwd: string;

  beforeEach(() => {
    registry = new SlashCommandRegistry();
    tmpCwd = createTempDir();
    // 清理全局数据目录，确保每个测试用例独立
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('内置命令', () => {
    it('包含 6 个内置命令', () => {
      const commands = registry.loadAll(tmpCwd, true);
      expect(commands.get('init')).toBeDefined();
      expect(commands.get('review')).toBeDefined();
      expect(commands.get('test')).toBeDefined();
      expect(commands.get('deploy')).toBeDefined();
      expect(commands.get('subagent')).toBeDefined();
      expect(commands.get('help')).toBeDefined();
    });

    it('内置命令 source 为 builtin', () => {
      const commands = registry.loadAll(tmpCwd, true);
      for (const cmd of commands.values()) {
        if (['init', 'review', 'test', 'deploy', 'subagent', 'help'].includes(cmd.name)) {
          expect(cmd.source).toBe('builtin');
        }
      }
    });

    it('内置命令有非空 template', () => {
      const commands = registry.loadAll(tmpCwd, true);
      const init = commands.get('init');
      expect(init).toBeDefined();
      expect(init!.template.length).toBeGreaterThan(0);
    });

    it('内置命令包含 $ARGUMENTS 占位符（help 除外）', () => {
      const commands = registry.loadAll(tmpCwd, true);
      for (const name of ['init', 'review', 'test', 'deploy', 'subagent']) {
        const cmd = commands.get(name);
        expect(cmd).toBeDefined();
        expect(cmd!.template).toContain('$ARGUMENTS');
      }
    });
  });

  describe('detectCommand', () => {
    it('识别 /review', () => {
      expect(registry.detectCommand('/review')).toBe('review');
    });

    it('识别 /test src/api.ts', () => {
      expect(registry.detectCommand('/test src/api.ts')).toBe('test');
    });

    it('识别 /init-project（含连字符）', () => {
      expect(registry.detectCommand('/init-project')).toBe('init-project');
    });

    it('识别 /my_command（含下划线）', () => {
      expect(registry.detectCommand('/my_command arg')).toBe('my_command');
    });

    it('非斜杠输入返回 null', () => {
      expect(registry.detectCommand('review')).toBeNull();
      expect(registry.detectCommand('请审查代码')).toBeNull();
    });

    it('仅有 / 返回 null', () => {
      expect(registry.detectCommand('/')).toBeNull();
    });

    it('特殊字符命令名返回 null', () => {
      expect(registry.detectCommand('/123中文')).toBe('123');
      // 数字开头也可以识别（不过实践中不推荐）
    });

    it('空白输入返回 null', () => {
      expect(registry.detectCommand('')).toBeNull();
      expect(registry.detectCommand('   ')).toBeNull();
    });
  });

  describe('extractArguments', () => {
    it('无参数返回空串', () => {
      expect(registry.extractArguments('/review')).toBe('');
    });

    it('单参数', () => {
      expect(registry.extractArguments('/review src/api.ts')).toBe('src/api.ts');
    });

    it('多参数', () => {
      expect(registry.extractArguments('/review src/api.ts src/utils.ts')).toBe('src/api.ts src/utils.ts');
    });

    it('参数含空格保留', () => {
      expect(registry.extractArguments('/test 这是一个 测试')).toBe('这是一个 测试');
    });
  });

  describe('render 占位符替换', () => {
    it('替换 $ARGUMENTS', () => {
      const cmd = registry.getCommand('review', tmpCwd)!;
      const result = registry.render(cmd, { arguments: 'src/api.ts', cwd: tmpCwd });
      expect(result.text).toContain('src/api.ts');
      expect(result.replacedPlaceholders).toContain('$ARGUMENTS');
      expect(result.unresolvedPlaceholders).not.toContain('$ARGUMENTS');
    });

    it('$ARGUMENTS 未提供时标记为 unresolved', () => {
      const cmd = registry.getCommand('review', tmpCwd)!;
      const result = registry.render(cmd, { cwd: tmpCwd });
      expect(result.unresolvedPlaceholders).toContain('$ARGUMENTS');
    });

    it('替换 $DATE', () => {
      const cmd: SlashCommand = {
        name: 'date-test',
        description: '',
        template: '今天是 $DATE',
        source: 'builtin',
      };
      const result = registry.render(cmd, {});
      const today = new Date().toISOString().split('T')[0];
      expect(result.text).toContain(today);
      expect(result.replacedPlaceholders).toContain('$DATE');
    });

    it('替换 $TIME', () => {
      const cmd: SlashCommand = {
        name: 'time-test',
        description: '',
        template: '时间 $TIME',
        source: 'builtin',
      };
      const result = registry.render(cmd, {});
      // ISO 格式时间
      expect(result.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.replacedPlaceholders).toContain('$TIME');
    });

    it('替换 $CWD', () => {
      const cmd: SlashCommand = {
        name: 'cwd-test',
        description: '',
        template: '目录 $CWD',
        source: 'builtin',
      };
      const result = registry.render(cmd, { cwd: '/custom/path' });
      expect(result.text).toContain('/custom/path');
      expect(result.replacedPlaceholders).toContain('$CWD');
    });

    it('替换 $CLIPBOARD（提供值）', () => {
      const cmd: SlashCommand = {
        name: 'clip-test',
        description: '',
        template: '剪贴板: $CLIPBOARD',
        source: 'builtin',
      };
      const result = registry.render(cmd, { clipboard: '剪贴内容' });
      expect(result.text).toContain('剪贴内容');
      expect(result.replacedPlaceholders).toContain('$CLIPBOARD');
    });

    it('$CLIPBOARD 未提供时标记 unresolved', () => {
      const cmd: SlashCommand = {
        name: 'clip-test',
        description: '',
        template: '剪贴板: $CLIPBOARD',
        source: 'builtin',
      };
      const result = registry.render(cmd, {});
      expect(result.unresolvedPlaceholders).toContain('$CLIPBOARD');
    });

    it('替换 $SELECTION（提供值）', () => {
      const cmd: SlashCommand = {
        name: 'sel-test',
        description: '',
        template: '选中文本: $SELECTION',
        source: 'builtin',
      };
      const result = registry.render(cmd, { selection: 'function foo() {}' });
      expect(result.text).toContain('function foo() {}');
    });

    it('替换 $FILE:path（绝对路径）', () => {
      const tmpFile = path.join(tmpCwd, 'sample.txt');
      fs.writeFileSync(tmpFile, 'Hello World', 'utf-8');

      const cmd: SlashCommand = {
        name: 'file-test',
        description: '',
        template: `内容: $FILE:${tmpFile}`,
        source: 'builtin',
      };
      const result = registry.render(cmd, { cwd: tmpCwd });
      expect(result.text).toContain('Hello World');
      expect(result.replacedPlaceholders.some(p => p.startsWith('$FILE:'))).toBe(true);
    });

    it('替换 $FILE:path（相对路径，相对 cwd）', () => {
      const tmpFile = path.join(tmpCwd, 'relative.txt');
      fs.writeFileSync(tmpFile, '相对路径内容', 'utf-8');

      const cmd: SlashCommand = {
        name: 'file-test',
        description: '',
        template: '内容: $FILE:relative.txt',
        source: 'builtin',
      };
      const result = registry.render(cmd, { cwd: tmpCwd });
      expect(result.text).toContain('相对路径内容');
    });

    it('$FILE:path 文件不存在时标记 unresolved', () => {
      const cmd: SlashCommand = {
        name: 'file-test',
        description: '',
        template: '内容: $FILE:nonexistent.txt',
        source: 'builtin',
      };
      const result = registry.render(cmd, { cwd: tmpCwd });
      expect(result.unresolvedPlaceholders.some(p => p.startsWith('$FILE:'))).toBe(true);
      expect(result.text).toContain('文件不存在');
    });

    it('多占位符同时替换', () => {
      const tmpFile = path.join(tmpCwd, 'multi.txt');
      fs.writeFileSync(tmpFile, '文件内容', 'utf-8');

      const cmd: SlashCommand = {
        name: 'multi-test',
        description: '',
        template: 'args=$ARGUMENTS date=$DATE cwd=$CWD file=$FILE:multi.txt',
        source: 'builtin',
      };
      const result = registry.render(cmd, { arguments: 'hello', cwd: tmpCwd });
      expect(result.text).toContain('args=hello');
      expect(result.text).toContain('date=');
      expect(result.text).toContain(`cwd=${tmpCwd}`);
      expect(result.text).toContain('file=文件内容');
      expect(result.replacedPlaceholders.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('processInput 端到端', () => {
    it('处理 /review src/api.ts', () => {
      const result = registry.processInput('/review src/api.ts', { cwd: tmpCwd });
      expect(result).not.toBeNull();
      expect(result!.command.name).toBe('review');
      expect(result!.text).toContain('src/api.ts');
      expect(result!.text).toContain('代码审查');
    });

    it('处理 /help', () => {
      const result = registry.processInput('/help', { cwd: tmpCwd });
      expect(result).not.toBeNull();
      expect(result!.text).toContain('可用斜杠命令');
      expect(result!.text).toContain('/review');
    });

    it('处理未知命令返回 null', () => {
      const result = registry.processInput('/nonexistent', { cwd: tmpCwd });
      expect(result).toBeNull();
    });

    it('非命令输入返回 null', () => {
      const result = registry.processInput('请帮我审查代码', { cwd: tmpCwd });
      expect(result).toBeNull();
    });

    it('处理 /init 无参数', () => {
      const result = registry.processInput('/init', { cwd: tmpCwd });
      expect(result).not.toBeNull();
      expect(result!.command.name).toBe('init');
      expect(result!.text).toContain('初始化项目记忆');
    });
  });

  describe('自定义命令加载', () => {
    it('加载项目级命令', () => {
      const projectCmdDir = path.join(tmpCwd, '.duan', 'commands');
      writeCommandFile(projectCmdDir, 'fix-issue', `修复 issue: $ARGUMENTS\n步骤:\n1. 复现\n2. 定位\n3. 修复`);

      const commands = registry.loadAll(tmpCwd, true);
      const cmd = commands.get('fix-issue');
      expect(cmd).toBeDefined();
      expect(cmd!.source).toBe('project');
      expect(cmd!.template).toContain('修复 issue');
      expect(cmd!.filePath).toBeTruthy();
    });

    it('项目级命令覆盖内置命令（同名）', () => {
      const projectCmdDir = path.join(tmpCwd, '.duan', 'commands');
      writeCommandFile(projectCmdDir, 'review', `自定义 review: $ARGUMENTS`);

      const commands = registry.loadAll(tmpCwd, true);
      const cmd = commands.get('review');
      expect(cmd).toBeDefined();
      expect(cmd!.source).toBe('project');
      expect(cmd!.template).toContain('自定义 review');
    });

    it('全局命令目录不存在时不报错', () => {
      expect(() => registry.loadAll(tmpCwd, true)).not.toThrow();
    });

    it('忽略非 .md 文件', () => {
      const projectCmdDir = path.join(tmpCwd, '.duan', 'commands');
      if (!fs.existsSync(projectCmdDir)) fs.mkdirSync(projectCmdDir, { recursive: true });
      fs.writeFileSync(path.join(projectCmdDir, 'note.txt'), 'not a command');
      fs.writeFileSync(path.join(projectCmdDir, 'valid.md'), 'valid $ARGUMENTS');

      const commands = registry.loadAll(tmpCwd, true);
      expect(commands.has('note')).toBe(false);
      expect(commands.has('valid')).toBe(true);
    });

    it('从 frontmatter 提取描述', () => {
      const projectCmdDir = path.join(tmpCwd, '.duan', 'commands');
      writeCommandFile(projectCmdDir, 'deploy-prod', `---
description: 部署到生产环境
---
部署流程: $ARGUMENTS`);

      const commands = registry.loadAll(tmpCwd, true);
      const cmd = commands.get('deploy-prod');
      expect(cmd).toBeDefined();
      expect(cmd!.description).toBe('部署到生产环境');
    });

    it('无 frontmatter 时从首行提取描述', () => {
      const projectCmdDir = path.join(tmpCwd, '.duan', 'commands');
      writeCommandFile(projectCmdDir, 'simple', `这是第一行描述\n$ARGUMENTS`);

      const commands = registry.loadAll(tmpCwd, true);
      const cmd = commands.get('simple');
      expect(cmd).toBeDefined();
      expect(cmd!.description).toBe('这是第一行描述');
    });
  });

  describe('getHelpText', () => {
    it('包含命令分组标题', () => {
      const help = registry.getHelpText(tmpCwd);
      expect(help).toContain('内置命令');
    });

    it('包含命令名', () => {
      const help = registry.getHelpText(tmpCwd);
      expect(help).toContain('/review');
      expect(help).toContain('/test');
      expect(help).toContain('/init');
    });

    it('包含用法说明', () => {
      const help = registry.getHelpText(tmpCwd);
      expect(help).toContain('用法');
      expect(help).toContain('占位符');
    });

    it('有自定义命令时显示对应分组', () => {
      const projectCmdDir = path.join(tmpCwd, '.duan', 'commands');
      writeCommandFile(projectCmdDir, 'custom-cmd', '自定义: $ARGUMENTS');

      const help = registry.getHelpText(tmpCwd);
      expect(help).toContain('项目命令');
    });
  });

  describe('writeCommand', () => {
    it('写入项目级命令', () => {
      const filePath = registry.writeCommand('my-cmd', '模板 $ARGUMENTS', 'project', tmpCwd);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(filePath).toContain('my-cmd.md');

      const commands = registry.loadAll(tmpCwd, true);
      expect(commands.has('my-cmd')).toBe(true);
    });

    it('写入全局级命令', () => {
      const filePath = registry.writeCommand('global-cmd', '全局 $ARGUMENTS', 'global', tmpCwd);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('命令名包含非法字符时被清理', () => {
      const filePath = registry.writeCommand('my-cmd@#$%', '模板', 'project', tmpCwd);
      expect(filePath).toContain('my-cmd.md');
    });

    it('空命令名抛出错误', () => {
      expect(() => registry.writeCommand('@#$', '模板', 'project', tmpCwd)).toThrow();
    });

    it('写入后失效缓存', () => {
      const commands1 = registry.loadAll(tmpCwd, true);
      expect(commands1.has('fresh-cmd')).toBe(false);

      registry.writeCommand('fresh-cmd', 'fresh', 'project', tmpCwd);

      const commands2 = registry.loadAll(tmpCwd, true);
      expect(commands2.has('fresh-cmd')).toBe(true);
    });
  });

  describe('缓存机制', () => {
    it('30 秒内复用缓存', () => {
      const commands1 = registry.loadAll(tmpCwd, true);
      const commands2 = registry.loadAll(tmpCwd); // 不强制刷新
      expect(commands1).toBe(commands2); // 同一对象引用
    });

    it('forceRefresh 重新加载', () => {
      const commands1 = registry.loadAll(tmpCwd, true);
      const commands2 = registry.loadAll(tmpCwd, true);
      expect(commands1).not.toBe(commands2); // 不同对象引用
    });

    it('invalidateCache 清除缓存', () => {
      const commands1 = registry.loadAll(tmpCwd, true);
      registry.invalidateCache();
      const commands2 = registry.loadAll(tmpCwd);
      expect(commands1).not.toBe(commands2);
    });
  });

  describe('getToolDefinitions', () => {
    it('返回 2 个工具', () => {
      const tools = registry.getToolDefinitions();
      expect(tools.length).toBe(2);
      const names = tools.map(t => t.name);
      expect(names).toContain('slash_command_list');
      expect(names).toContain('slash_command_execute');
    });

    it('slash_command_list 返回帮助文本', async () => {
      const tools = registry.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'slash_command_list')!;
      expect(listTool).toBeDefined();

      const result = await listTool.execute({});
      expect(typeof result).toBe('string');
      expect(result as string).toContain('可用斜杠命令');
    });

    it('slash_command_list readOnly 为 true', () => {
      const tools = registry.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'slash_command_list')!;
      expect(listTool.readOnly).toBe(true);
    });

    it('slash_command_execute 执行 review 命令', async () => {
      const tools = registry.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'slash_command_execute')!;
      expect(execTool).toBeDefined();

      const result = await execTool.execute({ command: 'review', arguments: 'src/api.ts' });
      expect(result as string).toContain('src/api.ts');
      expect(result as string).toContain('代码审查');
    });

    it('slash_command_execute 执行 help 命令', async () => {
      const tools = registry.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'slash_command_execute')!;
      const result = await execTool.execute({ command: 'help' });
      expect(result as string).toContain('可用斜杠命令');
    });

    it('slash_command_execute 缺少 command 参数返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'slash_command_execute')!;
      const result = await execTool.execute({});
      expect(result as string).toContain('缺少 command 参数');
    });

    it('slash_command_execute 未知命令返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'slash_command_execute')!;
      const result = await execTool.execute({ command: 'nonexistent' });
      expect(result as string).toContain('未知命令');
    });

    it('slash_command_execute 无 arguments 参数时正常执行', async () => {
      const tools = registry.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'slash_command_execute')!;
      const result = await execTool.execute({ command: 'init' });
      expect(result as string).toContain('初始化项目记忆');
    });

    it('工具参数定义完整', () => {
      const tools = registry.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'slash_command_execute')!;
      expect(execTool.parameters).toBeDefined();
      expect(execTool.parameters.command).toBeDefined();
      expect(execTool.parameters.command.required).toBe(true);
      expect(execTool.parameters.arguments).toBeDefined();
      expect(execTool.parameters.arguments.required).toBe(false);
    });
  });

  describe('listCommands', () => {
    it('返回排序后的命令名列表', () => {
      const list = registry.listCommands(tmpCwd);
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(6);
      // 检查排序
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].localeCompare(list[i])).toBeLessThanOrEqual(0);
      }
    });

    it('包含所有内置命令', () => {
      const list = registry.listCommands(tmpCwd);
      expect(list).toContain('init');
      expect(list).toContain('review');
      expect(list).toContain('test');
      expect(list).toContain('deploy');
      expect(list).toContain('subagent');
      expect(list).toContain('help');
    });
  });

  describe('getCommand', () => {
    it('获取存在的命令', () => {
      const cmd = registry.getCommand('review', tmpCwd);
      expect(cmd).not.toBeNull();
      expect(cmd!.name).toBe('review');
    });

    it('获取不存在的命令返回 null', () => {
      const cmd = registry.getCommand('nonexistent', tmpCwd);
      expect(cmd).toBeNull();
    });
  });

  describe('单例', () => {
    it('getSlashCommandRegistry 返回同一实例', () => {
      const a = getSlashCommandRegistry();
      const b = getSlashCommandRegistry();
      expect(a).toBe(b);
    });

    it('单例是 SlashCommandRegistry 实例', () => {
      const a = getSlashCommandRegistry();
      expect(a).toBeInstanceOf(SlashCommandRegistry);
    });
  });
});
