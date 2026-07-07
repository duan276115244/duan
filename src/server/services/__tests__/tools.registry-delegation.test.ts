/**
 * 消灭孤岛 I-3 + I-2 验证测试：tools.ts 委托 ScalableToolRegistry
 *
 * I-3：executeTool 委托 registry（执行路径）
 * I-2：getToolDefinitionsForAPI / getOpenAITools / getSmartTools 委托 registry（查询路径）
 *
 * 验证：
 * 1. 未注入 registry 时行为不变（回退到本地 tools[]）
 * 2. 注入后命中已注册工具时走 registry（获得熔断/监控 + 全部已注册工具）
 * 3. 注入后未命中工具时回退到本地 tools[]（保持兼容）
 * 4. setToolRegistry/getToolRegistry 正确读写
 *
 * 见 v19 方案 §4.1 I-2 + §4.2 I-3。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  executeTool,
  setToolRegistry,
  getToolRegistry,
  getToolDefinitionsForAPI,
  getOpenAITools,
  getSmartTools,
  tools,
} from '../tools.js';
import { ScalableToolRegistry } from '../../../core/scalable-tool-registry.js';

describe('tools.ts — I-3 registry 委托', () => {
  let originalRegistry: ReturnType<typeof getToolRegistry>;

  beforeEach(() => {
    originalRegistry = getToolRegistry();
  });

  afterEach(() => {
    // 恢复原始 registry 状态，避免污染其他测试
    setToolRegistry(originalRegistry);
  });

  describe('setToolRegistry / getToolRegistry', () => {
    it('默认值为 null（未注入）', () => {
      setToolRegistry(null);
      expect(getToolRegistry()).toBeNull();
    });

    it('注入后可读取', () => {
      const registry = new ScalableToolRegistry();
      setToolRegistry(registry);
      expect(getToolRegistry()).toBe(registry);
    });

    it('可重置为 null', () => {
      const registry = new ScalableToolRegistry();
      setToolRegistry(registry);
      setToolRegistry(null);
      expect(getToolRegistry()).toBeNull();
    });
  });

  describe('executeTool 未注入 registry（fallback 路径不变）', () => {
    beforeEach(() => {
      setToolRegistry(null);
    });

    it('本地 tools[] 中的工具正常执行', async () => {
      const result = await executeTool('current_time', {});
      // current_time 返回日期字符串
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('未知工具返回错误信息', async () => {
      const result = await executeTool('nonexistent_tool_xyz', {});
      expect(result).toContain('未知工具');
    });

    it('code_execute 走本地沙箱实现', async () => {
      // 注意：code_execute 把代码包成 (async () => { CODE })()，需 return
      const result = await executeTool('code_execute', { code: 'return 1 + 2' });
      // JSON.stringify(3) === '3'
      expect(result).toBe('3');
    });
  });

  describe('executeTool 注入 registry 后委托路径', () => {
    let registry: ScalableToolRegistry;

    beforeEach(() => {
      registry = new ScalableToolRegistry();
      // 注册一个同名工具到 registry，execute 返回特征字符串
      registry.register({
        id: 'current_time',
        name: 'current_time',
        description: 'test override',
        parameters: {},
        execute: async () => 'REGISTRY_DELEGATED_RESULT',
        category: 'system' as any,
        priority: 50,
        enabled: true,
        readOnly: true,
        riskLevel: 'safe',
      });
      setToolRegistry(registry);
    });

    it('命中已注册工具时走 registry.executeTool', async () => {
      const result = await executeTool('current_time', {});
      expect(result).toBe('REGISTRY_DELEGATED_RESULT');
    });

    it('registry 未注册的工具回退到本地 tools[]', async () => {
      // code_execute 不在 registry 中（只注册了 current_time）
      const result = await executeTool('code_execute', { code: 'return 40 + 2' });
      // 应回退到本地实现，JSON.stringify(42) === '42'
      expect(result).toBe('42');
    });

    it('registry 中不存在的工具名 + 本地 tools[] 也没有时返回未知', async () => {
      const result = await executeTool('totally_unknown_tool', {});
      expect(result).toContain('未知工具');
    });
  });

  describe('tools 数组保持可用（不破坏 web-server 的 tools 导出）', () => {
    it('tools 数组非空', () => {
      expect(tools.length).toBeGreaterThan(0);
    });

    it('tools 数组包含 core 工具', () => {
      const names = tools.map(t => t.name);
      expect(names).toContain('file_read');
      expect(names).toContain('file_write');
      expect(names).toContain('shell_execute');
    });
  });

  // ============================================================
  // I-2: getToolDefinitionsForAPI / getOpenAITools / getSmartTools 委托
  // ============================================================

  describe('I-2 getToolDefinitionsForAPI 未注入 registry（fallback 不变）', () => {
    beforeEach(() => {
      setToolRegistry(null);
    });

    it('返回本地 tools[] 的 Anthropic 格式定义', () => {
      const defs = getToolDefinitionsForAPI();
      expect(defs.length).toBe(tools.length);
      // 每个 def 应有 name/description/input_schema
      for (const d of defs) {
        expect(d).toHaveProperty('name');
        expect(d).toHaveProperty('description');
        expect(d).toHaveProperty('input_schema');
        expect(d.input_schema).toHaveProperty('type', 'object');
      }
    });

    it('包含本地 tools[] 的核心工具', () => {
      const names = getToolDefinitionsForAPI().map(d => d.name);
      expect(names).toContain('file_read');
      expect(names).toContain('code_execute');
    });
  });

  describe('I-2 getToolDefinitionsForAPI 注入 registry 后委托', () => {
    let registry: ScalableToolRegistry;

    beforeEach(() => {
      registry = new ScalableToolRegistry();
      // 注册两个特征工具到 registry（本地 tools[] 没有）
      registry.register({
        id: 'i2_custom_tool_a',
        name: 'i2_custom_tool_a',
        description: 'I-2 测试工具 A',
        parameters: { query: { type: 'string', description: '查询参数', required: true } },
        execute: async () => 'A',
        category: 'other' as any,
        priority: 50,
        enabled: true,
        readOnly: true,
        riskLevel: 'safe',
      });
      registry.register({
        id: 'i2_custom_tool_b',
        name: 'i2_custom_tool_b',
        description: 'I-2 测试工具 B',
        parameters: {},
        execute: async () => 'B',
        category: 'other' as any,
        priority: 50,
        enabled: true,
        readOnly: true,
        riskLevel: 'safe',
      });
      setToolRegistry(registry);
    });

    it('从 registry 查询（含自定义工具）', () => {
      const defs = getToolDefinitionsForAPI();
      const names = defs.map(d => d.name);
      expect(names).toContain('i2_custom_tool_a');
      expect(names).toContain('i2_custom_tool_b');
    });

    it('不再返回本地 tools[] 独有的工具（registry 是唯一来源）', () => {
      const defs = getToolDefinitionsForAPI();
      const names = defs.map(d => d.name);
      // registry 只注册了 2 个工具，本地 file_read 不应在结果中
      expect(names).not.toContain('file_read');
      expect(defs).toHaveLength(2);
    });

    it('input_schema 格式正确', () => {
      const defs = getToolDefinitionsForAPI();
      const toolA = defs.find(d => d.name === 'i2_custom_tool_a');
      expect(toolA).toBeDefined();
      expect(toolA!.input_schema).toHaveProperty('type', 'object');
      expect(toolA!.input_schema).toHaveProperty('properties.query');
      expect(toolA!.input_schema).toHaveProperty('required');
      expect((toolA!.input_schema as { required: string[] }).required).toContain('query');
    });
  });

  describe('I-2 getOpenAITools 未注入 registry（fallback 不变）', () => {
    beforeEach(() => {
      setToolRegistry(null);
    });

    it('返回本地 tools[] 的 OpenAI 格式定义', () => {
      const defs = getOpenAITools();
      expect(defs.length).toBe(tools.length);
      for (const d of defs) {
        expect(d).toHaveProperty('type', 'function');
        expect(d).toHaveProperty('function.name');
        expect(d).toHaveProperty('function.description');
        expect(d).toHaveProperty('function.parameters.type', 'object');
      }
    });
  });

  describe('I-2 getOpenAITools 注入 registry 后委托', () => {
    let registry: ScalableToolRegistry;

    beforeEach(() => {
      registry = new ScalableToolRegistry();
      registry.register({
        id: 'i2_oai_tool',
        name: 'i2_oai_tool',
        description: 'I-2 OpenAI 格式测试工具',
        parameters: { x: { type: 'string', description: '参数 x', required: true } },
        execute: async () => 'ok',
        category: 'other' as any,
        priority: 50,
        enabled: true,
        readOnly: true,
        riskLevel: 'safe',
      });
      setToolRegistry(registry);
    });

    it('从 registry 查询 OpenAI 格式定义', () => {
      const defs = getOpenAITools();
      const names = defs.map(d => d.function.name);
      expect(names).toContain('i2_oai_tool');
      expect(defs).toHaveLength(1);
    });

    it('OpenAI 格式正确（type=function, parameters 含 required）', () => {
      const defs = getOpenAITools();
      const tool = defs[0];
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBe('i2_oai_tool');
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.required).toContain('x');
    });
  });

  describe('I-2 getSmartTools 未注入 registry（fallback 不变）', () => {
    beforeEach(() => {
      setToolRegistry(null);
    });

    it('返回本地 tools[] 的工具定义', () => {
      const defs = getSmartTools('测试消息');
      expect(defs.length).toBe(tools.length);
      for (const d of defs) {
        expect(d).toHaveProperty('type', 'function');
      }
    });

    it('不传 userMessage 时正常工作', () => {
      const defs = getSmartTools();
      expect(defs.length).toBeGreaterThan(0);
    });
  });

  describe('I-2 getSmartTools 注入 registry 后委托', () => {
    let registry: ScalableToolRegistry;

    beforeEach(() => {
      registry = new ScalableToolRegistry();
      registry.register({
        id: 'i2_smart_tool',
        name: 'i2_smart_tool',
        description: 'I-2 smart 测试工具',
        parameters: {},
        execute: async () => 'ok',
        category: 'other' as any,
        priority: 50,
        enabled: true,
        readOnly: true,
        riskLevel: 'safe',
      });
      setToolRegistry(registry);
    });

    it('从 registry 查询（含 userMessage 智能筛选）', () => {
      const defs = getSmartTools('搜索相关内容');
      const names = defs.map(d => d.function.name);
      expect(names).toContain('i2_smart_tool');
    });

    it('不传 userMessage 时也走 registry', () => {
      const defs = getSmartTools();
      const names = defs.map(d => d.function.name);
      expect(names).toContain('i2_smart_tool');
      expect(defs).toHaveLength(1);
    });
  });

  describe('I-2 空 registry 行为', () => {
    beforeEach(() => {
      setToolRegistry(new ScalableToolRegistry());
    });

    it('getToolDefinitionsForAPI 返回空数组', () => {
      expect(getToolDefinitionsForAPI()).toEqual([]);
    });

    it('getOpenAITools 返回空数组', () => {
      expect(getOpenAITools()).toEqual([]);
    });

    it('getSmartTools 返回空数组', () => {
      expect(getSmartTools('anything')).toEqual([]);
    });
  });
});
