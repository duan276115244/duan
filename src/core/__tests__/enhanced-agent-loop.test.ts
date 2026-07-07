/**
 * P0-5: EnhancedAgentLoop 主循环单元测试
 *
 * 测试 P0-1/P0-2/P0-3/P0-4/P0-6 的接入点（不依赖 LLM 调用）：
 * - injectUnifiedToolFramework：注入后工具定义同步到 UnifiedToolFramework
 * - UnifiedToolFramework.recordExternalExecution：记录外部执行统计
 * - injectToolConsolidation / injectSelfEvolve：注入后字段非空
 * - ToolConsolidation.tryAutoConsolidate：阈值检查 + 自动合并
 * - UnifiedToolFramework.getStats：统计输出
 *
 * 测试策略：用 ToolRegistry（内置轻量版）创建 EnhancedAgentLoop 实例，
 * 通过 inject* 方法注入 mock 依赖，验证字段赋值和统计同步逻辑。
 * 不调用 run()（需要 LLM），仅测试接入点的副作用。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EnhancedAgentLoop } from '../enhanced-agent-loop.js';
import { UnifiedToolFramework } from '../unified-tool-framework.js';
import { ToolConsolidation } from '../tool-consolidation.js';
import type { ToolDef } from '../unified-tool-def.js';

describe('P0-5: EnhancedAgentLoop 主循环接入点', () => {
  let loop: EnhancedAgentLoop;

  beforeEach(() => {
    // 用默认配置创建实例（内部用 ToolRegistry，无 LLM 依赖）
    loop = new EnhancedAgentLoop({});
  });

  // ============ P0-1: UnifiedToolFramework 接入 ============

  describe('P0-1: injectUnifiedToolFramework', () => {
    it('注入后 _unifiedToolFramework 字段非空', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      loop.injectUnifiedToolFramework(fw);
      expect((loop as unknown)._unifiedToolFramework).toBe(fw);
    });

    it('注入后同步 toolRegistry 中的工具定义到 UnifiedToolFramework', () => {
      // 先在 toolRegistry 中注册几个工具
      const readTool: ToolDef = {
        name: 'file_read',
        description: '读取文件',
        parameters: { path: { type: 'string', description: '路径', required: true } },
        execute: async () => 'content',
        readOnly: true,
        category: 'file',
      };
      const writeTool: ToolDef = {
        name: 'file_write',
        description: '写入文件',
        parameters: { path: { type: 'string', description: '路径', required: true } },
        execute: async () => 'ok',
        category: 'file',
      };
      (loop as unknown).toolRegistry.registerAll([readTool, writeTool]);

      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      loop.injectUnifiedToolFramework(fw);

      // 验证工具已同步到 UnifiedToolFramework
      const activeTools = fw.getActiveTools();
      expect(activeTools.length).toBeGreaterThanOrEqual(2);
      const names = activeTools.map(t => t.name);
      expect(names).toContain('file_read');
      expect(names).toContain('file_write');
    });

    it('重复注入不覆盖已注册工具的统计（跳过已注册）', () => {
      const readTool: ToolDef = {
        name: 'file_read',
        description: '读取文件',
        parameters: {},
        execute: async () => 'content',
        readOnly: true,
        category: 'file',
      };
      (loop as unknown).toolRegistry.registerAll([readTool]);

      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      loop.injectUnifiedToolFramework(fw);

      // 模拟一次外部执行，累加 useCount
      fw.recordExternalExecution('file_read', true, 50);
      const regBefore = (fw as unknown).registry.get('file_read');
      expect(regBefore.useCount).toBe(1);

      // 再次注入 — 不应覆盖已有注册（useCount 应保持 1）
      loop.injectUnifiedToolFramework(fw);
      const regAfter = (fw as unknown).registry.get('file_read');
      expect(regAfter.useCount).toBe(1);
    });

    it('注入失败时吞错不抛出（graceful degradation）', () => {
      // 传入一个不符合接口的对象，应吞错不抛
      expect(() => loop.injectUnifiedToolFramework({})).not.toThrow();
    });
  });

  describe('P0-1: UnifiedToolFramework.recordExternalExecution', () => {
    it('记录成功执行：useCount++，errorCount 不变', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      // 先注册一个工具
      fw.register({
        id: 'test_tool',
        name: 'test_tool',
        description: '测试工具',
        parameters: {},
        execute: async () => ({ success: true, output: 'ok' }),
        riskLevel: 'safe',
        executionPolicy: 'parallel',
        sandbox: { type: 'none', timeout: 0, maxMemory: 0, maxOutput: 0 },
        approvalMessage: '',
        category: 'test',
        tags: [],
        version: '1.0.0',
        builtIn: false,
      });

      fw.recordExternalExecution('test_tool', true, 100);
      const reg = (fw as unknown).registry.get('test_tool');
      expect(reg.useCount).toBe(1);
      expect(reg.errorCount).toBe(0);
      expect(reg.avgExecutionTime).toBe(100);
      expect(reg.lastUsed).toBeGreaterThan(0);
    });

    it('记录失败执行：useCount++，errorCount++', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      fw.register({
        id: 'fail_tool', name: 'fail_tool', description: '失败工具',
        parameters: {}, execute: async () => ({ success: false, output: '' }),
        riskLevel: 'moderate', executionPolicy: 'serial',
        sandbox: { type: 'none', timeout: 0, maxMemory: 0, maxOutput: 0 },
        approvalMessage: '', category: 'test', tags: [], version: '1.0.0', builtIn: false,
      });

      fw.recordExternalExecution('fail_tool', false, 200);
      const reg = (fw as unknown).registry.get('fail_tool');
      expect(reg.useCount).toBe(1);
      expect(reg.errorCount).toBe(1);
    });

    it('未注册工具不记录（避免污染统计）', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      fw.recordExternalExecution('nonexistent', true, 50);
      expect(fw.getStats().totalExecutions).toBe(0);
    });

    it('多次记录后 avgExecutionTime 是滚动平均', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      fw.register({
        id: 'avg_tool', name: 'avg_tool', description: '平均工具',
        parameters: {}, execute: async () => ({ success: true, output: '' }),
        riskLevel: 'safe', executionPolicy: 'parallel',
        sandbox: { type: 'none', timeout: 0, maxMemory: 0, maxOutput: 0 },
        approvalMessage: '', category: 'test', tags: [], version: '1.0.0', builtIn: false,
      });

      fw.recordExternalExecution('avg_tool', true, 100);
      fw.recordExternalExecution('avg_tool', true, 200);
      fw.recordExternalExecution('avg_tool', true, 300);

      const reg = (fw as unknown).registry.get('avg_tool');
      expect(reg.useCount).toBe(3);
      // (100 + 200 + 300) / 3 = 200
      expect(reg.avgExecutionTime).toBe(200);
    });

    it('executionLog 超过 5000 条时自动截断', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      fw.register({
        id: 'bulk_tool', name: 'bulk_tool', description: '批量工具',
        parameters: {}, execute: async () => ({ success: true, output: '' }),
        riskLevel: 'safe', executionPolicy: 'parallel',
        sandbox: { type: 'none', timeout: 0, maxMemory: 0, maxOutput: 0 },
        approvalMessage: '', category: 'test', tags: [], version: '1.0.0', builtIn: false,
      });

      // 写入 5005 条
      for (let i = 0; i < 5005; i++) {
        fw.recordExternalExecution('bulk_tool', true, 10);
      }
      expect((fw as unknown).executionLog.length).toBe(5000);
    });
  });

  describe('P0-1: UnifiedToolFramework.getStats', () => {
    it('空 registry 返回零统计', () => {
      const stats = new UnifiedToolFramework({ autoApproveSafe: true }).getStats();
      expect(stats.totalTools).toBe(0);
      expect(stats.activeTools).toBe(0);
      expect(stats.totalExecutions).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it('按分类和风险等级聚合统计', () => {
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      fw.register({
        id: 'safe_file', name: 'safe_file', description: '安全文件工具',
        parameters: {}, execute: async () => ({ success: true, output: '' }),
        riskLevel: 'safe', executionPolicy: 'parallel',
        sandbox: { type: 'none', timeout: 0, maxMemory: 0, maxOutput: 0 },
        approvalMessage: '', category: 'file', tags: [], version: '1.0.0', builtIn: false,
      });
      fw.register({
        id: 'danger_shell', name: 'danger_shell', description: '危险 shell 工具',
        parameters: {}, execute: async () => ({ success: true, output: '' }),
        riskLevel: 'dangerous', executionPolicy: 'approval_required',
        sandbox: { type: 'none', timeout: 0, maxMemory: 0, maxOutput: 0 },
        approvalMessage: '即将执行 shell', category: 'system', tags: [], version: '1.0.0', builtIn: false,
      });

      fw.recordExternalExecution('safe_file', true, 50);
      fw.recordExternalExecution('danger_shell', false, 500);

      const stats = fw.getStats();
      expect(stats.totalTools).toBe(2);
      expect(stats.activeTools).toBe(2);
      expect(stats.totalExecutions).toBe(2);
      expect(stats.successRate).toBe(0.5);
      expect(stats.byCategory.file).toBe(1);
      expect(stats.byCategory.system).toBe(1);
      expect(stats.byRiskLevel.safe).toBe(1);
      expect(stats.byRiskLevel.dangerous).toBe(1);
    });
  });

  // ============ P0-4: ToolConsolidation 接入 ============

  describe('P0-4: injectToolConsolidation', () => {
    it('注入后 _toolConsolidation 字段非空', () => {
      const tc = new ToolConsolidation();
      loop.injectToolConsolidation(tc);
      expect((loop as unknown)._toolConsolidation).toBe(tc);
    });
  });

  describe('P0-4: ToolConsolidation.tryAutoConsolidate', () => {
    it('使用历史不足阈值时返回 0（不触发审计）', () => {
      const tc = new ToolConsolidation();
      // 只记录 10 条（阈值 50）
      for (let i = 0; i < 10; i++) {
        tc.recordUsage('file_read', true, 50, 'general');
      }
      const result = tc.tryAutoConsolidate([]);
      expect(result).toBe(0);
    });

    it('使用历史达到阈值时触发审计（返回 0 表示无 safe 合并建议）', () => {
      const tc = new ToolConsolidation();
      // 记录 60 条
      for (let i = 0; i < 60; i++) {
        tc.recordUsage('file_read', true, 50, 'general');
      }
      // 无工具定义 → audit 返回空，无 safe 建议
      const result = tc.tryAutoConsolidate([]);
      expect(result).toBe(0);
    });

    it('记录使用历史不丢失（MAX_USAGE_HISTORY = 10000）', () => {
      const tc = new ToolConsolidation();
      for (let i = 0; i < 100; i++) {
        tc.recordUsage('file_read', true, 50, 'general');
      }
      expect((tc as unknown).usageHistory.length).toBe(100);
    });

    it('使用历史超过上限时丢弃最旧记录', () => {
      const tc = new ToolConsolidation();
      const MAX = (tc as unknown).MAX_USAGE_HISTORY;
      for (let i = 0; i < MAX + 100; i++) {
        tc.recordUsage('file_read', true, 50, 'general');
      }
      expect((tc as unknown).usageHistory.length).toBe(MAX);
    });
  });

  // ============ P0-6: SelfEvolve 接入 ============

  describe('P0-6: injectSelfEvolve', () => {
    it('注入后 _selfEvolve 字段非空', () => {
      const mockSelfEvolve = { analyzeProject: () => [] };
      loop.injectSelfEvolve(mockSelfEvolve);
      expect((loop as unknown)._selfEvolve).toBe(mockSelfEvolve);
    });

    it('未注入时 _selfEvolve 为 null（不影响主流程）', () => {
      expect((loop as unknown)._selfEvolve).toBeNull();
    });
  });

  // ============ 多个 inject 共存 ============

  describe('P0 综合接入：多个 inject 共存', () => {
    it('同时注入 ToolConsolidation + UnifiedToolFramework + SelfEvolve', () => {
      const tc = new ToolConsolidation();
      const fw = new UnifiedToolFramework({ autoApproveSafe: true });
      const se = { analyzeProject: () => [] };

      loop.injectToolConsolidation(tc);
      loop.injectUnifiedToolFramework(fw);
      loop.injectSelfEvolve(se);

      expect((loop as unknown)._toolConsolidation).toBe(tc);
      expect((loop as unknown)._unifiedToolFramework).toBe(fw);
      expect((loop as unknown)._selfEvolve).toBe(se);
    });
  });
});
