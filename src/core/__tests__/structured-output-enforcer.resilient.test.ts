/**
 * 维度 9 P1：parseToolCallArgsResilient 单元测试
 *
 * 验证：
 * 1. 未启用 enforcer 时行为与原 JSON.parse 兼容（默认路径）
 * 2. 启用 enforcer 后多策略降级生效（strict→lenient→regex→repair→default）
 * 3. USE_STRUCTURED_OUTPUT_ENFORCER 环境变量灰度开关正确解析
 *
 * 见 v19 方案 §3.9.1 "structured-output-enforcer 在所有 LLM 调用路径生效"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseToolCallArgsResilient,
  getStructuredOutputEnforcer,
  resetStructuredOutputEnforcer,
} from '../structured-output-enforcer.js';

describe('parseToolCallArgsResilient', () => {
  describe('未启用 enforcer 时（默认）', () => {
    it('标准 JSON 字符串解析正确', () => {
      const r = parseToolCallArgsResilient('{"name":"test","value":42}');
      expect(r).toEqual({ name: 'test', value: 42 });
    });

    it('空字符串返回 {}', () => {
      const r = parseToolCallArgsResilient('');
      expect(r).toEqual({});
    });

    it('"{}" 字符串返回 {}', () => {
      const r = parseToolCallArgsResilient('{}');
      expect(r).toEqual({});
    });

    it('非法 JSON 返回 {}', () => {
      const r = parseToolCallArgsResilient('not a json');
      expect(r).toEqual({});
    });

    it('截断 JSON 返回 {}（默认路径不修复）', () => {
      const r = parseToolCallArgsResilient('{"name":"test","value":');
      expect(r).toEqual({});
    });

    it('单引号 JSON 返回 {}（默认路径不宽松解析）', () => {
      const r = parseToolCallArgsResilient("{'name':'test'}");
      expect(r).toEqual({});
    });

    it('含尾逗号 JSON 返回 {}（默认路径不容忍）', () => {
      const r = parseToolCallArgsResilient('{"a":1,}');
      expect(r).toEqual({});
    });

    it('toolName 参数不影响默认路径行为', () => {
      const r1 = parseToolCallArgsResilient('{"a":1}');
      const r2 = parseToolCallArgsResilient('{"a":1}', 'some_tool');
      expect(r1).toEqual(r2);
    });

    it('嵌套对象解析正确', () => {
      const r = parseToolCallArgsResilient('{"outer":{"inner":"value"},"arr":[1,2,3]}');
      expect(r).toEqual({ outer: { inner: 'value' }, arr: [1, 2, 3] });
    });

    it('null/undefined/number 参数被当作字符串处理', () => {
      // null/undefined 会被 `rawArgs || '{}'` 处理为 '{}'
      expect(parseToolCallArgsResilient(null as unknown as string)).toEqual({});
      expect(parseToolCallArgsResilient(undefined as unknown as string)).toEqual({});
    });
  });

  describe('启用 enforcer（USE_STRUCTURED_OUTPUT_ENFORCER=true）', () => {
    beforeEach(() => {
      process.env.USE_STRUCTURED_OUTPUT_ENFORCER = 'true';
      resetStructuredOutputEnforcer();
    });

    afterEach(() => {
      delete process.env.USE_STRUCTURED_OUTPUT_ENFORCER;
    });

    it('标准 JSON 字符串走 strict 策略解析正确', () => {
      const r = parseToolCallArgsResilient('{"name":"test","value":42}');
      expect(r).toEqual({ name: 'test', value: 42 });
      // 验证 enforcer 统计
      const stats = getStructuredOutputEnforcer().getStats();
      expect(stats.total).toBeGreaterThanOrEqual(1);
      expect(stats.byStrategy.strict).toBeGreaterThanOrEqual(1);
    });

    it('空字符串返回 {}（走 default 策略）', () => {
      const r = parseToolCallArgsResilient('');
      expect(r).toEqual({});
    });

    it('非法 JSON 走 default 策略返回 {}', () => {
      const r = parseToolCallArgsResilient('not a json at all');
      expect(r).toEqual({});
      const stats = getStructuredOutputEnforcer().getStats();
      expect(stats.failure).toBeGreaterThanOrEqual(1);
    });

    it('键名缺引号 JSON 走 lenient 策略成功解析', () => {
      // enforcer lenient 策略支持键名补全引号：{name:"test"} → {"name":"test"}
      const r = parseToolCallArgsResilient('{name:"test"}');
      expect(r).toEqual({ name: 'test' });
    });

    it('含尾逗号 JSON 走 lenient 策略成功解析', () => {
      const r = parseToolCallArgsResilient('{"a":1,}');
      // enforcer lenient 策略容忍尾逗号
      expect(r).toEqual({ a: 1 });
    });

    it('含 JSON 代码块的文本走 regex 策略提取', () => {
      const rawArgs = '这里有一些文本\n```json\n{"key":"value"}\n```\n更多文本';
      const r = parseToolCallArgsResilient(rawArgs);
      // regex 策略应提取出 JSON 块
      expect(r).toEqual({ key: 'value' });
    });

    it('截断 JSON 走 repair 策略修复', () => {
      // 截断的 JSON：缺少闭合括号
      const r = parseToolCallArgsResilient('{"name":"test","value":42');
      // repair 策略应能修复为完整 JSON
      expect(r).toHaveProperty('name', 'test');
      expect(r).toHaveProperty('value', 42);
    });

    it('完全无法解析的输入返回 default {}', () => {
      const r = parseToolCallArgsResilient('   ');
      expect(r).toEqual({});
    });

    it('嵌套对象解析正确', () => {
      const r = parseToolCallArgsResilient('{"outer":{"inner":"value"},"arr":[1,2,3]}');
      expect(r).toEqual({ outer: { inner: 'value' }, arr: [1, 2, 3] });
    });

    it('toolName 参数被接受但不影响解析（无 schema lookup）', () => {
      const r1 = parseToolCallArgsResilient('{"a":1}', 'tool_a');
      const r2 = parseToolCallArgsResilient('{"a":1}', 'tool_b');
      expect(r1).toEqual(r2);
      expect(r1).toEqual({ a: 1 });
    });

    it('统计累计正确（多次调用后 stats 增长）', () => {
      resetStructuredOutputEnforcer();
      parseToolCallArgsResilient('{"a":1}');
      parseToolCallArgsResilient("{'b':2}");
      parseToolCallArgsResilient('invalid');
      const stats = getStructuredOutputEnforcer().getStats();
      expect(stats.total).toBeGreaterThanOrEqual(3);
      expect(stats.success).toBeGreaterThanOrEqual(2); // 前 2 个成功
      expect(stats.failure).toBeGreaterThanOrEqual(1); // 第 3 个失败
    });
  });

  describe('灰度开关（USE_STRUCTURED_OUTPUT_ENFORCER 环境变量）', () => {
    const ENV_KEY = 'USE_STRUCTURED_OUTPUT_ENFORCER';
    let originalValue: string | undefined;

    beforeEach(() => {
      originalValue = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (originalValue === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalValue;
    });

    it('USE_STRUCTURED_OUTPUT_ENFORCER=true 启用 enforcer', () => {
      process.env[ENV_KEY] = 'true';
      resetStructuredOutputEnforcer();
      // 单引号 JSON 在 enforcer 启用时可解析
      const r = parseToolCallArgsResilient("{'x':1}");
      expect(r).toEqual({ x: 1 });
    });

    it('USE_STRUCTURED_OUTPUT_ENFORCER 未设时关闭 enforcer（走 JSON.parse）', () => {
      delete process.env[ENV_KEY];
      // 单引号 JSON 在 enforcer 关闭时无法解析（标准 JSON.parse 失败）
      const r = parseToolCallArgsResilient("{'x':1}");
      expect(r).toEqual({});
    });

    it('USE_STRUCTURED_OUTPUT_ENFORCER=false 关闭 enforcer', () => {
      process.env[ENV_KEY] = 'false';
      // 单引号 JSON 在 enforcer 关闭时无法解析
      const r = parseToolCallArgsResilient("{'x':1}");
      expect(r).toEqual({});
    });

    it('标准 JSON 在两种模式下结果一致', () => {
      const input = '{"name":"test","value":42}';
      delete process.env[ENV_KEY];
      const r1 = parseToolCallArgsResilient(input);
      process.env[ENV_KEY] = 'true';
      resetStructuredOutputEnforcer();
      const r2 = parseToolCallArgsResilient(input);
      expect(r1).toEqual(r2);
      expect(r1).toEqual({ name: 'test', value: 42 });
    });
  });

  describe('接入点行为兼容性（与原 JSON.parse 行为一致）', () => {
    // 这些用例模拟 enhanced-agent-loop.ts / llm-streaming.ts 中的调用场景

    it('模拟 OpenAI tool_calls.arguments 解析（标准 JSON）', () => {
      const args = '{"command":"ls -la","timeout":30000}';
      const r = parseToolCallArgsResilient(args, 'shell_execute');
      expect(r).toEqual({ command: 'ls -la', timeout: 30000 });
    });

    it('模拟 Anthropic toolUse input 解析（空字符串）', () => {
      const r = parseToolCallArgsResilient('', 'file_read');
      expect(r).toEqual({});
    });

    it('模拟 LLM 返回截断的 arguments', () => {
      const truncatedArgs = '{"path":"/tmp/test.txt","content":"hello world';
      // 默认路径返回 {}，调用方应通过 tryRepairJSON 兜底
      const r = parseToolCallArgsResilient(truncatedArgs, 'file_write');
      expect(r).toEqual({});
    });

    it('模拟 LLM 返回带 markdown 代码块的 arguments', () => {
      const rawWithMarkdown = '```json\n{"path":"/tmp/test.txt"}\n```';
      // 默认路径返回 {}（JSON.parse 无法处理 markdown）
      const r1 = parseToolCallArgsResilient(rawWithMarkdown, 'file_read');
      expect(r1).toEqual({});
      // 启用 enforcer 后可提取
      process.env.USE_STRUCTURED_OUTPUT_ENFORCER = 'true';
      resetStructuredOutputEnforcer();
      const r2 = parseToolCallArgsResilient(rawWithMarkdown, 'file_read');
      expect(r2).toEqual({ path: '/tmp/test.txt' });
      delete process.env.USE_STRUCTURED_OUTPUT_ENFORCER;
    });
  });
});
