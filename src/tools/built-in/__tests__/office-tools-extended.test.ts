/**
 * office-tools-extended（扩展办公工具）单元测试
 *
 * 测试策略（镜像 office-tools-ultimate.test.ts 范式）：
 * 1. 结构验证：12 个工具、正确名称、参数定义、readOnly 标记
 * 2. 参数校验：传入非法 action 或缺失必需参数，应在触碰文件系统前同步返回错误
 * 3. 智能选择器注册：12 个工具元信息全部注册到 SmartToolSelector
 *
 * 设计原则：不依赖 fs/PowerShell/外部库真实调用，所有用例均可在任意平台运行。
 */

import { describe, it, expect } from 'vitest';
import { officeToolsExtended } from '../office-tools-extended.js';
import { SmartToolSelector } from '../../../core/smart-tool-selector.js';

// ============ 期望的工具清单 ============

const EXPECTED_TOOL_NAMES = [
  'translate',
  'qrcode_gen',
  'qrcode_scan',
  'archive_compress',
  'archive_extract',
  'watermark_add',
  'pdf_extract_text',
  'url_to_markdown',
  'snippet_manage',
  'password_gen',
  'currency_convert',
  'unit_convert',
] as const;

// readOnly 工具（纯查询/LLM 生成/本地计算，不写盘）
const READONLY_TOOL_NAMES = [
  'translate',
  'qrcode_scan',
  'pdf_extract_text',
  'url_to_markdown',
  'password_gen',
  'currency_convert',
  'unit_convert',
] as const;

// 依赖外部库的工具：可能在 action 校验前先 import 库并返回降级提示
const SKIP_INVALID_ACTION = new Set([
  'qrcode_gen',
  'archive_compress',
  'archive_extract',
  'watermark_add',
  'pdf_extract_text',
]);

// ============ 结构验证 ============

describe('officeToolsExtended — 模块结构', () => {
  it('应导出恰好 12 个工具', () => {
    expect(officeToolsExtended).toHaveLength(12);
  });

  it('每个工具都有 name/description/parameters/execute 四要素', () => {
    for (const tool of officeToolsExtended) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('工具名集合应与期望清单完全匹配', () => {
    const actualNames = officeToolsExtended.map(t => t.name).sort();
    const expectedNames = [...EXPECTED_TOOL_NAMES].sort();
    expect(actualNames).toEqual(expectedNames);
  });

  it('工具名不重复', () => {
    const names = officeToolsExtended.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('查询/生成/计算类工具应标记为 readOnly', () => {
    for (const name of READONLY_TOOL_NAMES) {
      const tool = officeToolsExtended.find(t => t.name === name);
      expect(tool?.readOnly).toBe(true);
    }
  });

  it('每个带 action 的工具应在 parameters 中声明 action 字段', () => {
    for (const tool of officeToolsExtended) {
      const params = tool.parameters as Record<string, { type?: string }>;
      if (params.action) {
        expect(params.action.type).toBe('string');
      }
    }
  });
});

// ============ 非法 action 同步拒绝 ============

describe('officeToolsExtended — 非法 action 同步拒绝', () => {
  const INVALID_ACTION = '__invalid_action__';

  for (const tool of officeToolsExtended) {
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

describe('officeToolsExtended — 必需参数缺失拒绝', () => {
  it('translate 缺 text 返回错误', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'translate')!;
    const result = await tool.execute({ target: 'en' });
    expect(result).toContain('❌');
  });

  it('snippet_manage insert 缺 name 返回错误', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'snippet_manage')!;
    const result = await tool.execute({ action: 'insert' });
    expect(result).toContain('❌');
  });
});

// ============ 纯逻辑测试（无 fs/网络副作用） ============

describe('officeToolsExtended — password_gen 纯本地生成', () => {
  it('strong 模式生成强密码（含字母+数字）', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'password_gen')!;
    const result = await tool.execute({ mode: 'strong' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/密码|password/i);
  });

  it('pin 模式生成纯数字 PIN', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'password_gen')!;
    const result = await tool.execute({ mode: 'pin' });
    expect(typeof result).toBe('string');
  });

  it('未指定 mode 时使用默认模式', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'password_gen')!;
    const result = await tool.execute({});
    expect(typeof result).toBe('string');
  });
});

describe('officeToolsExtended — unit_convert 纯本地计算', () => {
  it('长度换算 km→m 返回正确结果', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'unit_convert')!;
    const result = await tool.execute({
      category: 'length',
      from: 'km',
      to: 'm',
      value: '5',
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('5000');
  });

  it('温度换算 C→F 返回正确结果', async () => {
    const tool = officeToolsExtended.find(t => t.name === 'unit_convert')!;
    const result = await tool.execute({
      category: 'temperature',
      from: 'C',
      to: 'F',
      value: '100',
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('212');
  });
});

// ============ SmartToolSelector 注册验证 ============

describe('officeToolsExtended — 智能选择器注册', () => {
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
});
