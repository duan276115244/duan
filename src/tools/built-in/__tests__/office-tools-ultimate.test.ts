/**
 * office-tools-ultimate 单元测试
 *
 * 测试策略：
 * 1. 结构验证：12 个工具、正确名称、参数定义、readOnly 标记
 * 2. 参数校验：传入非法 action 或缺失必需参数，应在触碰文件系统前同步返回错误
 * 3. 纯逻辑验证：system_info 的 overview/cpu/memory 视图只读 os 模块，无 fs/PowerShell 副作用
 * 4. 智能选择器注册：12 个工具元信息全部注册到 SmartToolSelector
 *
 * 设计原则：不依赖 fs/PowerShell 真实调用，所有用例均可在任意平台运行（macOS/Linux 上
 * window_layout 与 process_manage 的 list 分支会触发平台判断，故只测 action 校验路径）。
 */

import { describe, it, expect } from 'vitest';
import { officeToolsUltimate } from '../office-tools-ultimate.js';
import { SmartToolSelector } from '../../../core/smart-tool-selector.js';

// ============ 期望的工具清单 ============

const EXPECTED_TOOL_NAMES = [
  // A. 电脑操作类（6 个）
  'system_info',
  'process_manage',
  'window_layout',
  'clipboard_history',
  'quick_launch',
  'system_settings',
  // B. 办公能力类（6 个）
  'calendar_manage',
  'email_batch',
  'pdf_advanced',
  'note_manage',
  'kanban_board',
  'automation_workflow',
] as const;

// 每个 action 的合法取值（用于测试非法 action 时被拒绝）
const ACTION_VALUES: Record<string, string[]> = {
  system_info: [], // system_info 用 type 而非 action
  process_manage: ['list', 'find', 'kill', 'priority', 'top'],
  window_layout: ['list', 'tile', 'cascade', 'minimize_all', 'restore', 'snap', 'switch_desktop'],
  clipboard_history: ['start', 'stop', 'list', 'search', 'get', 'clear', 'stats'],
  quick_launch: ['add', 'list', 'run', 'remove', 'edit', 'import'],
  system_settings: ['wallpaper', 'power_mode', 'default_app', 'dnd', 'sleep', 'screensaver', 'empty_recycle', 'disk_cleanup'],
  calendar_manage: ['create', 'list', 'today', 'week', 'upcoming', 'remove', 'conflict'],
  email_batch: ['draft_batch', 'classify', 'template_apply', 'merge_mail'],
  pdf_advanced: ['merge', 'encrypt', 'decrypt', 'rotate', 'extract_pages', 'metadata', 'add_text'],
  note_manage: ['create', 'list', 'read', 'search', 'tag', 'link', 'recent', 'delete'],
  kanban_board: ['create_board', 'list_boards', 'view', 'add_column', 'add_card', 'move_card', 'archive_card', 'delete_board'],
  automation_workflow: ['create', 'list', 'view', 'run', 'enable', 'disable', 'delete', 'history'],
};

// ============ 测试 ============

describe('officeToolsUltimate — 模块结构', () => {
  it('应导出恰好 12 个工具', () => {
    expect(officeToolsUltimate).toHaveLength(12);
  });

  it('每个工具都有 name/description/parameters/execute 四要素', () => {
    for (const tool of officeToolsUltimate) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('工具名集合应与期望清单完全匹配', () => {
    const actualNames = officeToolsUltimate.map(t => t.name).sort();
    const expectedNames = [...EXPECTED_TOOL_NAMES].sort();
    expect(actualNames).toEqual(expectedNames);
  });

  it('工具名不重复', () => {
    const names = officeToolsUltimate.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('system_info 应标记为 readOnly（查询类不写盘）', () => {
    const sysInfo = officeToolsUltimate.find(t => t.name === 'system_info');
    expect(sysInfo?.readOnly).toBe(true);
  });

  it('每个带 action 的工具应在 parameters 中声明 action 字段', () => {
    for (const tool of officeToolsUltimate) {
      if (tool.name === 'system_info') continue; // 用 type 而非 action
      const params = tool.parameters as Record<string, { required?: boolean; type?: string }>;
      expect(params.action).toBeDefined();
      expect(params.action?.type).toBe('string');
    }
  });
});

// ============ 参数校验测试 ============
//
// 思路：传入 action: '__invalid__'，应在所有 if (action === '...') 分支后命中
// 末尾的 `return '❌ action 必须是 ...'`，不会触碰 fs/PowerShell。
// system_info 没有 action，改测 type='__invalid__' 的回退路径。

describe('officeToolsUltimate — 非法 action 同步拒绝', () => {
  const INVALID_ACTION = '__invalid_action__';

  // pdf_advanced 在 execute 入口处即 `await import('pdf-lib')`，pdf-lib 未安装时会先返回
  // 安装提示，无法到达 action 校验。这里单独跳过，由专门用例验证其降级路径。
  const SKIP_INVALID_ACTION = new Set(['system_info', 'pdf_advanced']);

  for (const toolName of EXPECTED_TOOL_NAMES) {
    if (SKIP_INVALID_ACTION.has(toolName)) continue;

    it(`${toolName} 拒绝非法 action 并列出合法值`, async () => {
      const tool = officeToolsUltimate.find(t => t.name === toolName)!;
      const result = await tool.execute({ action: INVALID_ACTION });
      expect(typeof result).toBe('string');
      expect(result).toContain('❌');
      // 错误信息应至少包含一个合法 action 名作为提示
      const validActions = ACTION_VALUES[toolName];
      const mentionsSomeValid = validActions.some(a => result.includes(a));
      expect(mentionsSomeValid).toBe(true);
    });
  }

  it('pdf_advanced 在 pdf-lib 未安装时优雅降级（返回安装提示而非崩溃）', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'pdf_advanced')!;
    const result = await tool.execute({ action: 'merge', input: '[]' });
    expect(typeof result).toBe('string');
    // 应当给出 pdf-lib 安装提示或参数错误，而不是抛出异常
    expect(result).toMatch(/pdf-lib|❌|⚠️/);
  });
});

// ============ 关键参数校验测试 ============

describe('officeToolsUltimate — 必需参数缺失拒绝', () => {
  it('calendar_manage create 缺 title/start/end 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'calendar_manage')!;
    const result = await tool.execute({ action: 'create' });
    expect(result).toContain('❌');
    expect(result).toContain('title');
    expect(result).toContain('start');
    expect(result).toContain('end');
  });

  it('calendar_manage create 时间格式非法返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'calendar_manage')!;
    const result = await tool.execute({
      action: 'create',
      title: '测试会议',
      start: 'not-a-date',
      end: 'also-not-a-date',
    });
    expect(result).toContain('❌');
    expect(result).toMatch(/时间格式|YYYY-MM-DD/);
  });

  it('calendar_manage create 结束早于开始返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'calendar_manage')!;
    const result = await tool.execute({
      action: 'create',
      title: '测试会议',
      start: '2099-12-31 20:00',
      end: '2099-12-31 10:00',
    });
    expect(result).toContain('❌');
    expect(result).toMatch(/结束时间|晚于/);
  });

  it('quick_launch add 缺 alias/target 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'quick_launch')!;
    const result = await tool.execute({ action: 'add' });
    expect(result).toContain('❌');
    expect(result).toContain('alias');
    expect(result).toContain('target');
  });

  it('quick_launch run 缺 alias 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'quick_launch')!;
    const result = await tool.execute({ action: 'run' });
    expect(result).toContain('❌');
    expect(result).toContain('alias');
  });

  it('note_manage create 缺 title 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'note_manage')!;
    const result = await tool.execute({ action: 'create' });
    expect(result).toContain('❌');
    expect(result).toContain('title');
  });

  it('note_manage search 缺 keyword 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'note_manage')!;
    const result = await tool.execute({ action: 'search' });
    expect(result).toContain('❌');
    expect(result).toContain('keyword');
  });

  it('kanban_board create_board 缺 title 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'kanban_board')!;
    const result = await tool.execute({ action: 'create_board' });
    expect(result).toContain('❌');
    expect(result).toContain('title');
  });

  it('kanban_board add_column 缺 boardId/name 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'kanban_board')!;
    const result = await tool.execute({ action: 'add_column' });
    expect(result).toContain('❌');
    expect(result).toContain('boardId');
  });

  it('kanban_board add_card 缺 boardId/columnId/title 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'kanban_board')!;
    const result = await tool.execute({ action: 'add_card' });
    expect(result).toContain('❌');
    expect(result).toContain('boardId');
    expect(result).toContain('columnId');
    expect(result).toContain('title');
  });

  it('automation_workflow create 缺 name/trigger/actions 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'automation_workflow')!;
    const result = await tool.execute({ action: 'create' });
    expect(result).toContain('❌');
    expect(result).toContain('name');
    expect(result).toContain('trigger');
    expect(result).toContain('actions');
  });

  it('automation_workflow run 缺 id 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'automation_workflow')!;
    const result = await tool.execute({ action: 'run' });
    expect(result).toContain('❌');
    expect(result).toContain('id');
  });

  it('clipboard_history search 缺 keyword 返回错误', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'clipboard_history')!;
    const result = await tool.execute({ action: 'search' });
    expect(result).toContain('❌');
    expect(result).toContain('keyword');
  });

  it('pdf_advanced 在 pdf-lib 未安装时调用 add_text 也优雅降级', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'pdf_advanced')!;
    const result = await tool.execute({ action: 'add_text' });
    expect(typeof result).toBe('string');
    // 未安装 pdf-lib 时应给出安装提示，而非抛出异常
    expect(result).toMatch(/pdf-lib|❌|⚠️/);
  });
});

// ============ 纯逻辑测试（无 fs/PowerShell 副作用） ============

describe('officeToolsUltimate — system_info 纯查询视图', () => {
  it('overview 视图返回系统概览（包含主机名/CPU/内存）', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'system_info')!;
    const result = await tool.execute({ type: 'overview' });
    expect(typeof result).toBe('string');
    expect(result).toContain('系统概览');
    expect(result).toContain('主机名');
    expect(result).toContain('CPU');
    expect(result).toContain('内存');
  });

  it('cpu 视图返回 CPU 信息（包含核数/型号）', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'system_info')!;
    const result = await tool.execute({ type: 'cpu' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/CPU|处理器/);
  });

  it('memory 视图返回内存信息（包含已用/总量/使用率）', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'system_info')!;
    const result = await tool.execute({ type: 'memory' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/内存|Memory/);
  });

  it('未指定 type 时默认走 overview 视图', async () => {
    const tool = officeToolsUltimate.find(t => t.name === 'system_info')!;
    const result = await tool.execute({});
    expect(result).toContain('系统概览');
  });
});

// ============ SmartToolSelector 注册验证 ============

describe('officeToolsUltimate — 智能选择器注册', () => {
  it('12 个工具全部注册到 SmartToolSelector', () => {
    const selector = new SmartToolSelector();
    const registeredNames = selector.getRegisteredToolNames();
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(registeredNames).toContain(name);
    }
  });

  it('每个工具的元信息（category/risk/keywords）齐全', () => {
    const selector = new SmartToolSelector();
    for (const name of EXPECTED_TOOL_NAMES) {
      const meta = selector.getToolMeta(name);
      expect(meta).toBeDefined();
      expect(meta!.category).toBeDefined();
      expect(meta!.risk).toBeDefined();
      expect(Array.isArray(meta!.keywords)).toBe(true);
      expect(meta!.keywords.length).toBeGreaterThan(0);
    }
  });

  it('电脑操作类工具的 category 应为 desktop 或 execute', () => {
    const selector = new SmartToolSelector();
    const desktopTools = ['system_info', 'process_manage', 'window_layout', 'clipboard_history', 'quick_launch', 'system_settings'];
    for (const name of desktopTools) {
      const meta = selector.getToolMeta(name);
      expect(['desktop', 'execute', 'read']).toContain(meta!.category);
    }
  });

  it('办公能力类工具的 category 应为 plan/write/execute/memory', () => {
    const selector = new SmartToolSelector();
    const officeTools = ['calendar_manage', 'email_batch', 'pdf_advanced', 'note_manage', 'kanban_board', 'automation_workflow'];
    const expectedCategories = ['plan', 'write', 'execute', 'memory'];
    for (const name of officeTools) {
      const meta = selector.getToolMeta(name);
      expect(expectedCategories).toContain(meta!.category);
    }
  });

  it('process_manage 标记为 dangerous（kill 进程属高风险操作）', () => {
    const selector = new SmartToolSelector();
    const meta = selector.getToolMeta('process_manage');
    expect(meta!.risk).toBe('dangerous');
  });

  it('clipboard_history 与 calendar_manage 标记为 safe（只读类操作）', () => {
    const selector = new SmartToolSelector();
    expect(selector.getToolMeta('clipboard_history')!.risk).toBe('safe');
    expect(selector.getToolMeta('calendar_manage')!.risk).toBe('safe');
    expect(selector.getToolMeta('kanban_board')!.risk).toBe('safe');
  });
});
