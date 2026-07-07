import { describe, it, expect } from 'vitest';
import {
  ApprovalGate, ToolRegistry,
  getPlanStatusString, DOOM_LOOP_THRESHOLD,
} from '../enhanced-loop-types.js';

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test_tool',
      description: 'A test tool',
      parameters: { input: { type: 'string', description: 'test input', required: true } },
      execute: async () => 'ok',
      readOnly: true,
    }, 'safe', 'parallel');

    const entry = registry.get('test_tool');
    expect(entry).toBeDefined();
    expect(entry!.definition.name).toBe('test_tool');
    expect(entry!.riskLevel).toBe('safe');
  });

  it('returns all definitions', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'tool_a', description: '', parameters: {}, execute: async () => '', readOnly: true,
    });
    registry.register({
      name: 'tool_b', description: '', parameters: {}, execute: async () => '',
    });

    const all = registry.getAllDefinitions();
    expect(all.length).toBe(2);
  });

  it('auto-assigns risk level on batch register', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      { name: 'file_read', description: '', parameters: {}, execute: async () => '', readOnly: true },
      { name: 'file_write', description: '', parameters: {}, execute: async () => '' },
    ]);

    expect(registry.getRiskLevel('file_read')).toBe('safe');
    expect(registry.getRiskLevel('file_write')).toBe('dangerous');
  });
});

describe('ApprovalGate', () => {
  it('auto-approves safe tools', async () => {
    const gate = new ApprovalGate(null, true);
    const result = await gate.checkApproval('file_read', {}, 'safe', 'read file');
    expect(result.approved).toBe(true);
  });

  it('auto-approves safe with null callback', async () => {
    const gate = new ApprovalGate(null, true);
    const result = await gate.checkApproval('shell_execute', {}, 'dangerous', 'run command');
    expect(result.approved).toBe(false);
  });
});

describe('getPlanStatusString', () => {
  it('returns empty for null/empty plan', () => {
    expect(getPlanStatusString(null)).toBe('');
  });

  it('formats plan steps with status icons', () => {
    const plan = {
      id: 'test-plan',
      goal: 'Test goal',
      complexity: 'simple' as const,
      steps: [
        { id: 's1', description: 'Step 1', estimatedRisk: 'safe' as const, status: 'completed' as const },
        { id: 's2', description: 'Step 2', estimatedRisk: 'safe' as const, status: 'pending' as const, dependencies: ['s1'] },
      ],
      strategy: 'sequential',
      estimatedTurns: 3,
      createdAt: Date.now(),
    };
    const result = getPlanStatusString(plan);
    expect(result).toContain('✅');
    expect(result).toContain('⬜');
    expect(result).toContain('Step 1');
    expect(result).toContain('Step 2');
  });
});

describe('Constants', () => {
  it('DOOM_LOOP_THRESHOLD is 3', () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(3);
  });
});
