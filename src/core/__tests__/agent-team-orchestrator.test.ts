/**
 * AgentTeamOrchestrator 单元测试
 *
 * 验证多 Agent 团队编排系统：
 * 1. 模板列表 / 模板信息
 * 2. runTemplate（mock SubAgent）
 * 3. 执行历史
 * 4. 共享上下文板
 * 5. getToolDefinitions / 工具处理器
 *
 * 依赖全部 mock，不接触真实 SubAgent / GitWorktree。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgentTeamOrchestrator,
  getAgentTeamToolDefinitions,
  createAgentTeamToolHandler,
} from '../agent-team-orchestrator.js';
import type { SubAgentOrchestrator, SubAgentResult } from '../sub-agent-orchestrator.js';
import type { GitWorktreeManager, WorktreeResult } from '../git-worktree.js';

// ============ mock 工厂 ============

/** 构造 mock SubAgentOrchestrator */
function createMockSubAgentOrchestrator(resultOverrides?: Partial<SubAgentResult>[]): SubAgentOrchestrator {
  const defaultResult: SubAgentResult = {
    id: 'agent-mock-id',
    name: 'mock-agent',
    success: true,
    summary: 'mock 执行完成',
    events: [],
    terminal: null,
    duration: 10,
  };
  const results = resultOverrides
    ? resultOverrides.map(o => ({ ...defaultResult, ...o }))
    : [defaultResult];
  let callIndex = 0;
  return {
    setMaxConcurrent: vi.fn(),
    spawnAgent: vi.fn().mockImplementation((config: { id: string }) => {
      return Promise.resolve(config.id || `agent-${callIndex++}`);
    }),
    waitForId: vi.fn().mockImplementation(() => {
      const r = results[callIndex % results.length] ?? defaultResult;
      callIndex++;
      return Promise.resolve(r);
    }),
  } as unknown as SubAgentOrchestrator;
}

/** 构造 mock GitWorktreeManager */
function createMockGitWorktreeManager(opts?: {
  createSuccess?: boolean;
  mergeSuccess?: boolean;
}): GitWorktreeManager {
  const createSuccess = opts?.createSuccess ?? true;
  const mergeSuccess = opts?.mergeSuccess ?? true;
  const worktreeResult: WorktreeResult = {
    success: createSuccess,
    worktree: {
      name: 'wt-mock',
      path: '/tmp/mock-worktree',
      branch: 'mock-branch',
      baseBranch: 'main',
      status: 'active',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      taskDescription: 'mock',
    },
  };
  return {
    init: vi.fn().mockReturnValue(true),
    createWorktree: vi.fn().mockReturnValue(worktreeResult),
    mergeWorktree: vi.fn().mockReturnValue({
      success: mergeSuccess,
      output: 'mock merge ok',
    } as WorktreeResult),
    removeWorktree: vi.fn().mockReturnValue({ success: true } as WorktreeResult),
  } as unknown as GitWorktreeManager;
}

// ============ 测试套件 ============

describe('AgentTeamOrchestrator', () => {
  let orchestrator: AgentTeamOrchestrator;

  beforeEach(() => {
    orchestrator = new AgentTeamOrchestrator();
  });

  // ========== 1. 模板列表 ==========
  describe('模板列表', () => {
    it('getTemplates 应返回所有预定义模板名', () => {
      const templates = orchestrator.getTemplates();
      expect(templates).toContain('code-dev');
      expect(templates).toContain('research');
      expect(templates).toContain('bug-fix');
    });

    it('getTemplates 应返回 3 个模板', () => {
      expect(orchestrator.getTemplates()).toHaveLength(3);
    });

    it('工具处理器 team_list_templates 应返回模板数组', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_list_templates', {});
      expect(Array.isArray(result)).toBe(true);
      expect((result as string[]).length).toBe(3);
    });
  });

  // ========== 2. 模板信息 ==========
  describe('模板信息', () => {
    it('getTemplateInfo 应返回 code-dev 模板详情', () => {
      const info = orchestrator.getTemplateInfo('code-dev');
      expect(info).not.toBeNull();
      expect(info!.name).toBe('代码开发团队');
      expect(info!.members.length).toBeGreaterThan(0);
    });

    it('getTemplateInfo 应返回 research 模板详情', () => {
      const info = orchestrator.getTemplateInfo('research');
      expect(info).not.toBeNull();
      expect(info!.name).toBe('调研分析团队');
    });

    it('getTemplateInfo 应返回 bug-fix 模板详情', () => {
      const info = orchestrator.getTemplateInfo('bug-fix');
      expect(info).not.toBeNull();
      expect(info!.name).toBe('Bug修复团队');
    });

    it('getTemplateInfo 不存在的模板应返回 null', () => {
      expect(orchestrator.getTemplateInfo('non-existent')).toBeNull();
    });

    it('getTemplateInfo 返回的成员 goal 应为空字符串（运行时填充）', () => {
      const info = orchestrator.getTemplateInfo('code-dev');
      expect(info!.members.every(m => m.goal === '')).toBe(true);
    });

    it('工具处理器 team_get_template_info 应返回模板详情', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_get_template_info', { name: 'code-dev' }) as { name: string };
      expect(result.name).toBe('代码开发团队');
    });

    it('工具处理器 team_get_template_info 未知模板应返回 error', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_get_template_info', { name: 'unknown' }) as { error: string };
      expect(result.error).toContain('未知模板');
    });
  });

  // ========== 3. runTemplate（mock SubAgent） ==========
  describe('runTemplate', () => {
    it('未知模板应 reject', async () => {
      await expect(
        orchestrator.runTemplate('non-existent', '测试目标'),
      ).rejects.toThrow(/未知团队模板/);
    });

    it('未注入 SubAgent 时应正常完成（无成员执行）', async () => {
      const result = await orchestrator.runTemplate('research', '调研目标');
      expect(result.success).toBe(true);
      expect(result.teamName).toBe('调研分析团队');
      expect(result.memberResults).toHaveLength(0);
    });

    it('注入 SubAgent 后应成功执行 code-dev 模板', async () => {
      const mockSub = createMockSubAgentOrchestrator();
      orchestrator.setSubAgentOrchestrator(mockSub);
      const result = await orchestrator.runTemplate('code-dev', '实现功能 X');
      expect(result.teamName).toBe('代码开发团队');
      expect(result.memberResults.length).toBeGreaterThan(0);
      expect(mockSub.setMaxConcurrent).toHaveBeenCalledWith(8);
    });

    it('注入 SubAgent 后应成功执行 research 模板', async () => {
      const mockSub = createMockSubAgentOrchestrator();
      orchestrator.setSubAgentOrchestrator(mockSub);
      const result = await orchestrator.runTemplate('research', '调研主题');
      expect(result.teamName).toBe('调研分析团队');
      // research 模板无 planner，所有成员为非 planner
      expect(result.memberResults.length).toBeGreaterThan(0);
    });

    it('注入 SubAgent 后应成功执行 bug-fix 模板', async () => {
      const mockSub = createMockSubAgentOrchestrator();
      orchestrator.setSubAgentOrchestrator(mockSub);
      const result = await orchestrator.runTemplate('bug-fix', '修复 bug #123');
      expect(result.teamName).toBe('Bug修复团队');
      expect(result.memberResults.length).toBeGreaterThan(0);
    });

    it('启用 worktree 隔离时应创建 worktree', async () => {
      const mockSub = createMockSubAgentOrchestrator();
      const mockWt = createMockGitWorktreeManager();
      orchestrator.setSubAgentOrchestrator(mockSub);
      orchestrator.setGitWorktreeManager(mockWt);
      const result = await orchestrator.runTemplate('code-dev', '实现功能');
      expect(result.worktreesCreated).toBeGreaterThan(0);
      expect(mockWt.init).toHaveBeenCalled();
      expect(mockWt.createWorktree).toHaveBeenCalled();
    });

    it('worktree 合并失败时应记录到 errors', async () => {
      const mockSub = createMockSubAgentOrchestrator();
      const mockWt = createMockGitWorktreeManager({ mergeSuccess: false });
      orchestrator.setSubAgentOrchestrator(mockSub);
      orchestrator.setGitWorktreeManager(mockWt);
      const result = await orchestrator.runTemplate('code-dev', '实现功能');
      expect(result.mergeSuccess).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('runTemplate 应投递启动消息到共享板', async () => {
      await orchestrator.runTemplate('research', '调研任务');
      const board = orchestrator.getBoard();
      expect(board.entries.length).toBeGreaterThan(0);
      const statusEntry = board.entries.find(e => e.type === 'status');
      expect(statusEntry).toBeDefined();
      expect(statusEntry!.content).toContain('调研任务');
    });

    it('工具处理器 team_run_template 应调用 runTemplate', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_run_template', {
        templateName: 'research',
        taskGoal: '工具触发调研',
      }) as { teamName: string };
      expect(result.teamName).toBe('调研分析团队');
    });

    it('工具处理器 team_run_template 应传递 extraContext', async () => {
      const mockSub = createMockSubAgentOrchestrator();
      orchestrator.setSubAgentOrchestrator(mockSub);
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_run_template', {
        templateName: 'code-dev',
        taskGoal: '目标',
        extraContext: '额外背景信息',
      }) as { success: boolean };
      expect(result.success).toBe(true);
      // spawnAgent 调用时 context 数组应包含额外上下文
      const spawnCalls = (mockSub.spawnAgent as ReturnType<typeof vi.fn>).mock.calls;
      expect(spawnCalls.length).toBeGreaterThan(0);
      const firstCallContext = spawnCalls[0][0].context as string[];
      expect(firstCallContext.some((c: string) => c.includes('额外背景信息'))).toBe(true);
    });
  });

  // ========== 4. 执行历史 ==========
  describe('执行历史', () => {
    it('getExecutionsSummary 初始应为空数组', () => {
      expect(orchestrator.getExecutionsSummary()).toEqual([]);
    });

    it('执行后应包含记录', async () => {
      await orchestrator.runTemplate('research', '任务');
      const summary = orchestrator.getExecutionsSummary();
      expect(summary.length).toBe(1);
      expect(summary[0].teamName).toBe('调研分析团队');
    });

    it('getExecutionsSummary 应返回摘要字段', async () => {
      await orchestrator.runTemplate('research', '任务');
      const summary = orchestrator.getExecutionsSummary();
      expect(summary[0]).toHaveProperty('id');
      expect(summary[0]).toHaveProperty('teamName');
      expect(summary[0]).toHaveProperty('success');
      expect(summary[0]).toHaveProperty('duration');
      expect(summary[0]).toHaveProperty('memberCount');
    });

    it('getExecution 应返回完整执行结果', async () => {
      await orchestrator.runTemplate('research', '任务');
      const summary = orchestrator.getExecutionsSummary();
      const exec = orchestrator.getExecution(summary[0].id);
      expect(exec).toBeDefined();
      expect(exec!.teamName).toBe('调研分析团队');
      expect(exec!.summary).toContain('团队执行报告');
    });

    it('getExecution 不存在的 ID 应返回 undefined', () => {
      expect(orchestrator.getExecution('non-existent-id')).toBeUndefined();
    });

    it('工具处理器 team_get_executions 应返回执行摘要', async () => {
      await orchestrator.runTemplate('research', '任务');
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_get_executions', {}) as Array<{ id: string }>;
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
    });

    it('工具处理器 team_get_execution 应返回执行详情', async () => {
      await orchestrator.runTemplate('research', '任务');
      const summary = orchestrator.getExecutionsSummary();
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_get_execution', { id: summary[0].id }) as { teamName: string };
      expect(result.teamName).toBe('调研分析团队');
    });

    it('工具处理器 team_get_execution 不存在应返回 error', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_get_execution', { id: 'no-such-id' }) as { error: string };
      expect(result.error).toContain('执行不存在');
    });
  });

  // ========== 5. 共享上下文板 ==========
  describe('共享上下文板', () => {
    it('getBoard 初始应为空', () => {
      const board = orchestrator.getBoard();
      expect(board.entries).toEqual([]);
    });

    it('postToBoard 应添加条目', () => {
      orchestrator.postToBoard('agent-1', 'planner', 'decision', '决定使用方案 A');
      const board = orchestrator.getBoard();
      expect(board.entries).toHaveLength(1);
      expect(board.entries[0].agentName).toBe('agent-1');
      expect(board.entries[0].content).toBe('决定使用方案 A');
    });

    it('getBoard 应返回副本（修改不影响内部状态）', () => {
      orchestrator.postToBoard('agent-1', 'planner', 'decision', '决定');
      const board1 = orchestrator.getBoard();
      board1.entries.push({
        agentName: 'hack',
        role: 'planner',
        type: 'warning',
        content: '篡改',
        timestamp: Date.now(),
      });
      const board2 = orchestrator.getBoard();
      expect(board2.entries).toHaveLength(1);
    });

    it('clearBoard 应清空所有条目', () => {
      orchestrator.postToBoard('a', 'planner', 'decision', 'd1');
      orchestrator.postToBoard('b', 'researcher', 'finding', 'f1');
      expect(orchestrator.getBoard().entries).toHaveLength(2);
      orchestrator.clearBoard();
      expect(orchestrator.getBoard().entries).toEqual([]);
    });

    it('postToBoard 超过 200 条应淘汰旧条目', () => {
      for (let i = 0; i < 210; i++) {
        orchestrator.postToBoard('agent', 'planner', 'status', `条目 ${i}`);
      }
      const board = orchestrator.getBoard();
      expect(board.entries.length).toBeLessThanOrEqual(200);
      expect(board.entries.length).toBe(200);
    });

    it('工具处理器 team_get_board 应返回板内容', async () => {
      orchestrator.postToBoard('agent', 'planner', 'decision', '决定');
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_get_board', {}) as { entries: unknown[] };
      expect(result.entries).toHaveLength(1);
    });

    it('工具处理器 team_clear_board 应清空板', async () => {
      orchestrator.postToBoard('agent', 'planner', 'decision', '决定');
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('team_clear_board', {}) as { cleared: boolean };
      expect(result.cleared).toBe(true);
      expect(orchestrator.getBoard().entries).toEqual([]);
    });
  });

  // ========== 6. getToolDefinitions ==========
  describe('getToolDefinitions', () => {
    it('实例方法应返回工具定义数组', () => {
      const defs = orchestrator.getToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
    });

    it('应返回 7 个工具', () => {
      const defs = getAgentTeamToolDefinitions();
      expect(defs).toHaveLength(7);
    });

    it('应包含所有预期的工具名', () => {
      const defs = getAgentTeamToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('team_run_template');
      expect(names).toContain('team_list_templates');
      expect(names).toContain('team_get_template_info');
      expect(names).toContain('team_get_executions');
      expect(names).toContain('team_get_execution');
      expect(names).toContain('team_get_board');
      expect(names).toContain('team_clear_board');
    });

    it('team_run_template 应有 inputSchema 和 required 字段', () => {
      const defs = getAgentTeamToolDefinitions();
      const runDef = defs.find(d => d.name === 'team_run_template')!;
      expect(runDef.inputSchema.required).toEqual(['templateName', 'taskGoal']);
      expect(runDef.inputSchema.properties.templateName).toBeDefined();
      expect(runDef.inputSchema.properties.taskGoal).toBeDefined();
      expect(runDef.inputSchema.properties.extraContext).toBeDefined();
    });

    it('每个工具都应有 name 和 description', () => {
      const defs = getAgentTeamToolDefinitions();
      for (const d of defs) {
        expect(d.name).toBeTruthy();
        expect(d.description).toBeTruthy();
        expect(d.inputSchema).toBeDefined();
      }
    });
  });

  // ========== 7. 工具处理器 ==========
  describe('工具处理器 createAgentTeamToolHandler', () => {
    it('未知工具应返回 error', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      const result = await handler('unknown_tool', {}) as { error: string };
      expect(result.error).toContain('未知工具');
    });

    it('应能处理所有 7 个工具名', async () => {
      const handler = createAgentTeamToolHandler(orchestrator);
      // 先跑一次模板让执行历史和板有内容
      await handler('team_run_template', { templateName: 'research', taskGoal: '目标' });
      const toolNames = [
        'team_list_templates',
        'team_get_template_info',
        'team_get_executions',
        'team_get_execution',
        'team_get_board',
        'team_clear_board',
      ];
      for (const name of toolNames) {
        const args = name === 'team_get_template_info' ? { name: 'code-dev' }
          : name === 'team_get_execution' ? { id: 'no-such' }
          : {};
        const result = await handler(name, args);
        expect(result).toBeDefined();
      }
    });
  });

  // ========== 8. 依赖注入 ==========
  describe('依赖注入', () => {
    it('setSubAgentOrchestrator 应能注入依赖', () => {
      const mockSub = createMockSubAgentOrchestrator();
      expect(() => orchestrator.setSubAgentOrchestrator(mockSub)).not.toThrow();
    });

    it('setGitWorktreeManager 应能注入依赖', () => {
      const mockWt = createMockGitWorktreeManager();
      expect(() => orchestrator.setGitWorktreeManager(mockWt)).not.toThrow();
    });
  });
});
