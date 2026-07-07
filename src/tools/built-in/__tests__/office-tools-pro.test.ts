/**
 * office-tools-pro（进阶办公工具）单元测试
 *
 * 测试策略（镜像 office-tools-ultimate.test.ts 范式）：
 * 1. 结构验证：10 个工具、正确名称、参数定义、readOnly 标记
 * 2. 参数校验：传入非法 action 或缺失必需参数，应在触碰文件系统前同步返回错误
 * 3. 智能选择器注册：10 个工具元信息全部注册到 SmartToolSelector
 *
 * 设计原则：不依赖 fs/PowerShell/外部库真实调用，所有用例均可在任意平台运行。
 */

import { describe, it, expect } from 'vitest';
import { officeToolsPro } from '../office-tools-pro.js';
import { SmartToolSelector } from '../../../core/smart-tool-selector.js';

// ============ 期望的工具清单 ============

const EXPECTED_TOOL_NAMES = [
  'batch_files',
  'contact_manage',
  'resume_generate',
  'contract_analyze',
  'finance_calc',
  'pdf_split',
  'speech_draft',
  'doc_diff',
  'data_clean',
  'project_track',
] as const;

// readOnly 工具（纯查询/LLM 生成/本地计算，不写盘）
const READONLY_TOOL_NAMES = [
  'resume_generate',
  'contract_analyze',
  'finance_calc',
  'speech_draft',
  'doc_diff',
] as const;

// batch_files 在 action 校验前先校验 directory，无法隔离测 invalid action
// data_clean / project_track 在 action 校验前先校验 file/project 存在性
// pdf_split 依赖 pdf-lib，可能先返回降级提示
const SKIP_INVALID_ACTION = new Set(['batch_files', 'pdf_split', 'data_clean', 'project_track']);

// ============ 结构验证 ============

describe('officeToolsPro — 模块结构', () => {
  it('应导出恰好 10 个工具', () => {
    expect(officeToolsPro).toHaveLength(10);
  });

  it('每个工具都有 name/description/parameters/execute 四要素', () => {
    for (const tool of officeToolsPro) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('工具名集合应与期望清单完全匹配', () => {
    const actualNames = officeToolsPro.map(t => t.name).sort();
    const expectedNames = [...EXPECTED_TOOL_NAMES].sort();
    expect(actualNames).toEqual(expectedNames);
  });

  it('工具名不重复', () => {
    const names = officeToolsPro.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('查询/生成/计算类工具应标记为 readOnly', () => {
    for (const name of READONLY_TOOL_NAMES) {
      const tool = officeToolsPro.find(t => t.name === name);
      expect(tool?.readOnly).toBe(true);
    }
  });

  it('每个带 action 的工具应在 parameters 中声明 action 字段', () => {
    for (const tool of officeToolsPro) {
      const params = tool.parameters as Record<string, { type?: string }>;
      if (params.action) {
        expect(params.action.type).toBe('string');
      }
    }
  });
});

// ============ 非法 action 同步拒绝 ============

describe('officeToolsPro — 非法 action 同步拒绝', () => {
  const INVALID_ACTION = '__invalid_action__';

  for (const tool of officeToolsPro) {
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

describe('officeToolsPro — 必需参数缺失拒绝', () => {
  it('contact_manage add 缺 name 返回错误', async () => {
    const tool = officeToolsPro.find(t => t.name === 'contact_manage')!;
    const result = await tool.execute({ action: 'add' });
    expect(result).toContain('❌');
  });

  it('project_track create 缺 name 返回错误', async () => {
    const tool = officeToolsPro.find(t => t.name === 'project_track')!;
    const result = await tool.execute({ action: 'create' });
    expect(result).toContain('❌');
  });

  it('data_clean 缺 input 返回错误', async () => {
    const tool = officeToolsPro.find(t => t.name === 'data_clean')!;
    const result = await tool.execute({ action: 'dedupe' });
    expect(result).toContain('❌');
  });

  it('doc_diff 缺 text1/text2 返回错误', async () => {
    const tool = officeToolsPro.find(t => t.name === 'doc_diff')!;
    const result = await tool.execute({});
    expect(result).toContain('❌');
  });
});

// ============ 纯逻辑测试（无 fs/网络副作用） ============

describe('officeToolsPro — finance_calc 纯本地计算', () => {
  it('loan 贷款月供计算返回结果', async () => {
    const tool = officeToolsPro.find(t => t.name === 'finance_calc')!;
    const result = await tool.execute({
      type: 'loan',
      principal: '1000000',
      rate: '0.05',
      years: '30',
    });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/月供|月|payment/i);
  });

  it('compound 复利终值计算返回结果', async () => {
    const tool = officeToolsPro.find(t => t.name === 'finance_calc')!;
    const result = await tool.execute({
      type: 'compound',
      principal: '10000',
      rate: '0.08',
      years: '10',
    });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/终值|复利|总额/i);
  });

  it('缺 type 返回错误', async () => {
    const tool = officeToolsPro.find(t => t.name === 'finance_calc')!;
    const result = await tool.execute({});
    expect(result).toContain('❌');
  });
});

// ============ SmartToolSelector 注册验证 ============

describe('officeToolsPro — 智能选择器注册', () => {
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
