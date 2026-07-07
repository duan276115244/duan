/**
 * 工具调用参数修复测试 — normalizeToolCallArgsForHistory
 *
 * 验证 LLM 截断的 tool_call arguments 能被正确修复，
 * 避免残缺 args 进入对话历史导致下轮 API 400 BadRequestError。
 */
import { describe, it, expect } from 'vitest';
import { normalizeToolCallArgsForHistory } from '../enhanced-agent-loop.js';

describe('normalizeToolCallArgsForHistory', () => {
  it('完整合法 JSON arguments 不修改', () => {
    const toolCalls = [
      { id: '1', name: 'file_write', arguments: '{"path":"x.txt","content":"hello"}' },
    ];
    const stats = normalizeToolCallArgsForHistory(toolCalls);
    expect(stats.repairedCount).toBe(0);
    expect(stats.failedCount).toBe(0);
    expect(toolCalls[0].arguments).toBe('{"path":"x.txt","content":"hello"}');
  });

  it('截断 arguments（缺闭合括号）修复为合法 JSON', () => {
    // 模拟日志中的真实 case：LLM 输出被截断为 {"path": "douyin.html"
    const toolCalls = [
      { id: '1', name: 'file_write', arguments: '{"path": "douyin.html"' },
    ];
    const stats = normalizeToolCallArgsForHistory(toolCalls);
    expect(stats.repairedCount).toBe(1);
    // 修复后应能被 JSON.parse 解析
    const parsed = JSON.parse(toolCalls[0].arguments);
    expect(parsed.path).toBe('douyin.html');
  });

  it('完全乱码回退为空对象 {}', () => {
    const toolCalls = [
      { id: '1', name: 'shell_execute', arguments: '@@@not json at all###' },
    ];
    const stats = normalizeToolCallArgsForHistory(toolCalls);
    expect(stats.failedCount).toBe(1);
    expect(toolCalls[0].arguments).toBe('{}');
  });

  it('空字符串设为 {}', () => {
    const toolCalls = [
      { id: '1', name: 'complete', arguments: '' },
    ];
    normalizeToolCallArgsForHistory(toolCalls);
    expect(toolCalls[0].arguments).toBe('{}');
  });

  it('语义残缺但语法合法的 arguments 不修改（语义修复超出范围）', () => {
    // {"path":"x"} 缺 content 参数，但语法合法，不修改
    const toolCalls = [
      { id: '1', name: 'file_write', arguments: '{"path":"x"}' },
    ];
    const stats = normalizeToolCallArgsForHistory(toolCalls);
    expect(stats.repairedCount).toBe(0);
    expect(stats.failedCount).toBe(0);
    expect(toolCalls[0].arguments).toBe('{"path":"x"}');
  });

  it('多个 tool_calls 混合（一个合法一个截断）只修复截断的', () => {
    const toolCalls = [
      { id: '1', name: 'file_read', arguments: '{"path":"a.txt"}' },
      { id: '2', name: 'file_write', arguments: '{"path":"b.txt","content":"test"' },
    ];
    const stats = normalizeToolCallArgsForHistory(toolCalls);
    expect(stats.repairedCount).toBe(1);
    expect(stats.failedCount).toBe(0);
    // 第一个不变
    expect(JSON.parse(toolCalls[0].arguments).path).toBe('a.txt');
    // 第二个被修复
    const repaired = JSON.parse(toolCalls[1].arguments);
    expect(repaired.path).toBe('b.txt');
    expect(repaired.content).toBe('test');
  });

  it('undefined arguments 设为 {}', () => {
    const toolCalls = [
      { id: '1', name: 'think', arguments: undefined as unknown as string },
    ];
    normalizeToolCallArgsForHistory(toolCalls);
    expect(toolCalls[0].arguments).toBe('{}');
  });
});
