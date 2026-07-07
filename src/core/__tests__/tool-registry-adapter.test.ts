import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistryAdapter } from '../tool-registry-adapter.js';
import { ScalableToolRegistry } from '../scalable-tool-registry.js';
import type { ToolDef } from '../agent-loop-types.js';

describe('ToolRegistryAdapter', () => {
  let scalable: ScalableToolRegistry;
  let adapter: ToolRegistryAdapter;

  beforeEach(() => {
    scalable = new ScalableToolRegistry();
    adapter = new ToolRegistryAdapter(scalable);
  });

  const readTool: ToolDef = {
    name: 'file_read',
    description: '读取文件',
    parameters: { path: { type: 'string', description: '路径', required: true } },
    execute: async () => 'content',
    readOnly: true,
  };

  const writeTool: ToolDef = {
    name: 'file_write',
    description: '写入文件',
    parameters: { path: { type: 'string', description: '路径', required: true }, content: { type: 'string', description: '内容' } },
    execute: async () => 'ok',
  };

  const shellTool: ToolDef = {
    name: 'shell_execute',
    description: '执行命令',
    parameters: { command: { type: 'string', description: '命令', required: true } },
    execute: async () => 'done',
  };

  describe('register / get', () => {
    it('registers and retrieves a single tool', () => {
      adapter.register(readTool, 'safe', 'parallel');
      const entry = adapter.get('file_read');
      expect(entry).toBeDefined();
      expect(entry!.definition.name).toBe('file_read');
      expect(entry!.riskLevel).toBe('safe');
      expect(entry!.executionPolicy).toBe('parallel');
    });

    it('returns undefined for unknown tool', () => {
      expect(adapter.get('nonexistent')).toBeUndefined();
    });

    it('uses default risk/policy when not specified', () => {
      adapter.register(writeTool);
      const entry = adapter.get('file_write');
      expect(entry!.riskLevel).toBe('moderate');
      expect(entry!.executionPolicy).toBe('serial');
    });

    it('readOnly tool defaults to parallel execution', () => {
      adapter.register(readTool);
      const entry = adapter.get('file_read');
      expect(entry!.executionPolicy).toBe('parallel');
    });
  });

  describe('registerAll', () => {
    it('registers multiple tools with automatic risk levels', () => {
      adapter.registerAll([readTool, writeTool, shellTool]);

      const read = adapter.get('file_read');
      expect(read!.riskLevel).toBe('safe');
      expect(read!.executionPolicy).toBe('parallel');

      const write = adapter.get('file_write');
      expect(write!.riskLevel).toBe('dangerous');
      expect(write!.executionPolicy).toBe('serial');

      const shell = adapter.get('shell_execute');
      expect(shell!.riskLevel).toBe('dangerous');
      expect(shell!.executionPolicy).toBe('serial');
    });

    it('registers all tools in ScalableToolRegistry as well', () => {
      adapter.registerAll([readTool, writeTool]);
      expect(scalable['tools'].has('file_read')).toBe(true);
      expect(scalable['tools'].has('file_write')).toBe(true);
    });
  });

  describe('getRiskLevel / getExecutionPolicy', () => {
    it('returns risk level from meta map', () => {
      adapter.register(writeTool, 'dangerous');
      expect(adapter.getRiskLevel('file_write')).toBe('dangerous');
    });

    it('falls back to ScalableToolDef riskLevel for tools registered directly', () => {
      scalable.register({
        id: 'custom_tool', name: 'custom_tool', description: '',
        parameters: {}, category: 'other', priority: 50, enabled: true,
        execute: async () => '', riskLevel: 'dangerous',
      });
      expect(adapter.getRiskLevel('custom_tool')).toBe('dangerous');
    });

    it('falls back to moderate when no meta or tool found', () => {
      expect(adapter.getRiskLevel('unknown')).toBe('moderate');
    });

    it('execution policy falls back to serial for non-readOnly', () => {
      scalable.register({
        id: 'custom_tool', name: 'custom_tool', description: '',
        parameters: {}, category: 'other', priority: 50, enabled: true,
        execute: async () => '',
      });
      expect(adapter.getExecutionPolicy('custom_tool')).toBe('serial');
    });
  });

  describe('getAllDefinitions', () => {
    it('returns all registered tool definitions', () => {
      adapter.registerAll([readTool, writeTool]);
      const defs = adapter.getAllDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.name)).toEqual(['file_read', 'file_write']);
    });
  });

  describe('getOpenAITools', () => {
    it('returns OpenAI-compatible tool format', () => {
      adapter.register(readTool);
      const tools = adapter.getOpenAITools();
      expect(tools).toHaveLength(1);
      expect(tools[0].type).toBe('function');
      expect(tools[0].function.name).toBe('file_read');
    });
  });

  describe('re-registration updates metadata', () => {
    it('last registration risk level wins', () => {
      adapter.register(readTool, 'safe');
      adapter.register(readTool, 'dangerous');
      const entry = adapter.get('file_read');
      expect(entry!.riskLevel).toBe('dangerous');
    });

    it('does not create duplicate scalable entries', () => {
      adapter.register(readTool, 'safe');
      adapter.register(readTool, 'dangerous');
      const allTools = scalable['tools'];
      expect(allTools.size).toBe(1);
    });
  });
});
