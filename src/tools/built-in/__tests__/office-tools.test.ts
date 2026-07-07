/**
 * office-tools（基础办公工具）单元测试
 *
 * 测试策略（镜像 office-tools-ultimate.test.ts 范式）：
 * 1. 结构验证：10 个工具、正确名称、参数定义、readOnly 标记
 * 2. 参数校验：传入非法 action 或缺失必需参数，应在触碰文件系统前同步返回错误
 * 3. 智能选择器注册：10 个工具元信息全部注册到 SmartToolSelector
 *
 * 设计原则：不依赖 fs/PowerShell/LLM 真实调用，所有用例均可在任意平台运行。
 */

import { describe, it, expect } from 'vitest';
import { officeTools } from '../office-tools.js';
import { SmartToolSelector } from '../../../core/smart-tool-selector.js';

// ============ 期望的工具清单 ============

const EXPECTED_TOOL_NAMES = [
  'email_compose',
  'email_template',
  'excel_analyze',
  'excel_formula',
  'meeting_minutes',
  'file_convert',
  'ocr_recognize',
  'task_manage',
  'schedule_plan',
  'quick_note',
] as const;

// readOnly 工具（纯查询/LLM 生成，不写盘）
const READONLY_TOOL_NAMES = [
  'email_compose',
  'excel_analyze',
  'excel_formula',
  'meeting_minutes',
  'ocr_recognize',
  'schedule_plan',
] as const;

// batch_files 在 action 校验前先校验 directory，无法隔离测 invalid action
// file_convert / ocr_recognize 可能触发外部依赖导入
const SKIP_INVALID_ACTION = new Set(['file_convert', 'ocr_recognize']);

// ============ 结构验证 ============

describe('officeTools — 模块结构', () => {
  it('应导出恰好 10 个工具', () => {
    expect(officeTools).toHaveLength(10);
  });

  it('每个工具都有 name/description/parameters/execute 四要素', () => {
    for (const tool of officeTools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('工具名集合应与期望清单完全匹配', () => {
    const actualNames = officeTools.map(t => t.name).sort();
    const expectedNames = [...EXPECTED_TOOL_NAMES].sort();
    expect(actualNames).toEqual(expectedNames);
  });

  it('工具名不重复', () => {
    const names = officeTools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('查询/生成类工具应标记为 readOnly', () => {
    for (const name of READONLY_TOOL_NAMES) {
      const tool = officeTools.find(t => t.name === name);
      expect(tool?.readOnly).toBe(true);
    }
  });

  it('每个带 action 的工具应在 parameters 中声明 action 字段', () => {
    for (const tool of officeTools) {
      const params = tool.parameters as Record<string, { type?: string }>;
      if (params.action) {
        expect(params.action.type).toBe('string');
      }
    }
  });
});

// ============ 非法 action 同步拒绝 ============

describe('officeTools — 非法 action 同步拒绝', () => {
  const INVALID_ACTION = '__invalid_action__';

  for (const tool of officeTools) {
    const params = tool.parameters as Record<string, unknown>;
    if (!('action' in params)) continue;
    if (SKIP_INVALID_ACTION.has(tool.name)) continue;

    it(`${tool.name} 拒绝非法 action 并列出合法值`, async () => {
      const result = await tool.execute({ action: INVALID_ACTION });
      expect(typeof result).toBe('string');
      expect(result).toContain('❌');
      expect(result).toContain('action');
    });
  }
});

// ============ 必需参数缺失拒绝 ============

describe('officeTools — 必需参数缺失拒绝', () => {
  it('email_compose 缺 keyPoints 返回错误', async () => {
    const tool = officeTools.find(t => t.name === 'email_compose')!;
    const result = await tool.execute({ subject: '测试', recipient: '张总' });
    expect(result).toContain('❌');
    expect(result).toContain('keyPoints');
  });

  it('task_manage add 缺 title 返回错误', async () => {
    const tool = officeTools.find(t => t.name === 'task_manage')!;
    const result = await tool.execute({ action: 'add' });
    expect(result).toContain('❌');
  });

  it('quick_note add 缺 content 返回错误', async () => {
    const tool = officeTools.find(t => t.name === 'quick_note')!;
    const result = await tool.execute({ action: 'add' });
    expect(result).toContain('❌');
  });

  it('email_template apply 缺 templateName 返回错误', async () => {
    const tool = officeTools.find(t => t.name === 'email_template')!;
    const result = await tool.execute({ action: 'apply' });
    expect(result).toContain('❌');
  });
});

// ============ SmartToolSelector 注册验证 ============

describe('officeTools — 智能选择器注册', () => {
  it('10 个工具全部注册到 SmartToolSelector', () => {
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
});
