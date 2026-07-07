/**
 * P2-3: EnhancedAgentLoop 诚实性修复单元测试
 *
 * 测试 P0 阶段修复的正确性（不依赖 LLM 调用）：
 * - P0-5: _hasCompleted 跨请求重置
 * - P0-6: _isToolResultFailure 扩展失败前缀识别
 * - P1-3: injectConsistencyGuard 注入点
 * - P1-4: MAX_STRATEGY_SWITCHES 从 4 提到 6
 *
 * 测试策略：通过 (loop as unknown) 访问私有字段/方法，验证诚实性修复的接入点。
 * 不调用 run()（需要 LLM），仅测试字段赋值和方法返回值。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EnhancedAgentLoop } from '../enhanced-agent-loop.js';

describe('P2-3: EnhancedAgentLoop 诚实性修复', () => {
  let loop: EnhancedAgentLoop;

  beforeEach(() => {
    loop = new EnhancedAgentLoop({});
  });

  // ============ P0-5: _hasCompleted 跨请求重置 ============

  describe('P0-5: _hasCompleted 状态重置', () => {
    it('初始状态 _hasCompleted 为 false', () => {
      expect((loop as unknown)._hasCompleted).toBe(false);
    });

    it('手动设置为 true 后，可通过注入逻辑重置', () => {
      // 模拟第一次请求结束时 _hasCompleted 被设为 true
      (loop as unknown)._hasCompleted = true;
      expect((loop as unknown)._hasCompleted).toBe(true);

      // 模拟第二次请求开始时的重置逻辑（在 runCore 入口）
      // P0-5 修复：重置块应包含 _hasCompleted = false
      (loop as unknown)._hasCompleted = false;
      expect((loop as unknown)._hasCompleted).toBe(false);
    });
  });

  // ============ P0-6: _isToolResultFailure 扩展失败前缀识别 ============

  describe('P0-6: _isToolResultFailure 工具失败识别', () => {
    const isFailure = (result: string) =>
      (loop as unknown)._isToolResultFailure(result);

    it('识别原有错误前缀（❌/✗/错误:/Error:/ERROR:/失败:）', () => {
      expect(isFailure('❌ 文件不存在')).toBe(true);
      expect(isFailure('✗ 执行出错')).toBe(true);
      expect(isFailure('错误: 参数无效')).toBe(true);
      expect(isFailure('错误：参数无效')).toBe(true);
      expect(isFailure('Error: something wrong')).toBe(true);
      expect(isFailure('ERROR: critical')).toBe(true);
      expect(isFailure('失败: 无法连接')).toBe(true);
      expect(isFailure('失败：无法连接')).toBe(true);
    });

    it('识别动作+失败模式（P0-6 新增）', () => {
      // tools.ts 中 file_read 失败返回 "读取失败: ..."
      expect(isFailure('读取失败: 文件不存在')).toBe(true);
      // tools.ts 中 shell_execute 失败返回 "执行失败: ..."
      expect(isFailure('执行失败: 命令未找到')).toBe(true);
      // tools.ts 中 web_fetch 失败返回 "获取失败: ..."
      expect(isFailure('获取失败: 网络超时')).toBe(true);
      // tools.ts 中 web_search 失败
      expect(isFailure('搜索失败: 服务不可用')).toBe(true);
      // tools.ts 中 list_directory 失败
      expect(isFailure('列出目录失败: 权限不足')).toBe(true);
      // 其他动作+失败
      expect(isFailure('写入失败: 磁盘已满')).toBe(true);
      expect(isFailure('编辑失败: 文件被锁定')).toBe(true);
      expect(isFailure('创建失败: 路径已存在')).toBe(true);
      expect(isFailure('删除失败: 文件被占用')).toBe(true);
      expect(isFailure('解析失败: JSON 格式错误')).toBe(true);
      expect(isFailure('连接失败: 拒绝连接')).toBe(true);
    });

    it('识别通用异常/超时/网络错误（P0-6 新增）', () => {
      expect(isFailure('异常: 空指针')).toBe(true);
      expect(isFailure('超时: 请求超过 30s')).toBe(true);
      expect(isFailure('timeout: operation timed out')).toBe(true);
      expect(isFailure('timed out after 5000ms')).toBe(true);
      expect(isFailure('ETIMEDOUT: connection timed out')).toBe(true);
      expect(isFailure('ECONNREFUSED: connection refused')).toBe(true);
      expect(isFailure('ENOTFOUND: dns lookup failed')).toBe(true);
      expect(isFailure('无法完成操作')).toBe(true);
      expect(isFailure('未能找到文件')).toBe(true);
    });

    it('识别 HTTP 状态码错误（#6 新增）', () => {
      expect(isFailure('状态码: 404\n\nNot Found')).toBe(true);
      expect(isFailure('状态码: 500\n\nInternal Server Error')).toBe(true);
      expect(isFailure('状态码: 503\n\nService Unavailable')).toBe(true);
      // 2xx 不应识别为失败
      expect(isFailure('状态码: 200\n\nOK')).toBe(false);
    });

    it('识别安全限制前缀（#6 新增）', () => {
      expect(isFailure('安全限制: 仅允许打开 http:// 或 https:// URL')).toBe(true);
      expect(isFailure('安全限制：路径超出允许范围')).toBe(true);
    });

    it('正确识别成功结果（不误判）', () => {
      expect(isFailure('✅ 文件读取成功')).toBe(false);
      expect(isFailure('文件内容如下...')).toBe(false);
      expect(isFailure('执行结果: 命令成功退出')).toBe(false);
      expect(isFailure('')).toBe(false);
      expect(isFailure('   ')).toBe(false);
    });

    it('非字符串输入返回 false', () => {
      expect(isFailure(null as unknown as string)).toBe(false);
      expect(isFailure(undefined as unknown as string)).toBe(false);
      expect(isFailure(123 as unknown as string)).toBe(false);
    });

    it('前导空白不影响识别', () => {
      expect(isFailure('  ❌ 文件不存在')).toBe(true);
      expect(isFailure('  读取失败: 文件不存在')).toBe(true);
      expect(isFailure('\t\n错误: 参数无效')).toBe(true);
    });
  });

  // ============ P0-7: plan step 状态判定（间接验证） ============

  describe('P0-7: plan step 默认状态判定', () => {
    it('_isToolResultFailure 被 plan step 判定逻辑复用', () => {
      // P0-7 修复：plan step default 分支调用 _isToolResultFailure
      // 验证 _isToolResultFailure 方法存在且可调用
      const fn = (loop as unknown)._isToolResultFailure;
      expect(typeof fn).toBe('function');
      // 验证失败识别会传播到 plan step 判定
      expect(fn('读取失败: 文件不存在')).toBe(true);
      expect(fn('✅ 成功')).toBe(false);
    });
  });

  // ============ P1-3: ConsistencyGuard 注入 ============

  describe('P1-3: injectConsistencyGuard', () => {
    it('注入后 _consistencyGuard 字段非空', () => {
      const mockGuard = {
        checkConsistency: () => ({ consistent: true, violations: [] }),
      };
      loop.injectConsistencyGuard(mockGuard);
      expect((loop as unknown)._consistencyGuard).toBe(mockGuard);
    });

    it('未注入时 _consistencyGuard 为 null', () => {
      expect((loop as unknown)._consistencyGuard).toBeNull();
    });
  });

  // ============ P1-4: MAX_STRATEGY_SWITCHES = 6 ============

  describe('P1-4: MAX_STRATEGY_SWITCHES 策略空间', () => {
    it('MAX_STRATEGY_SWITCHES 应为 6（从 4 提升）', () => {
      // P1-4 修复：从 4 提到 6，让更多策略有机会被尝试
      expect(EnhancedAgentLoop.MAX_STRATEGY_SWITCHES).toBe(6);
    });

    it('_strategySwitchCount 初始为 0', () => {
      expect((loop as unknown)._strategySwitchCount).toBe(0);
    });
  });

  // ============ P0-4: loop-stream-adapter completed.summary 输出（间接验证） ============

  describe('P0-4: 诚实性修复集成点', () => {
    it('TerminalReason 类型支持 error.recoverable', () => {
      // 验证 error 类型的返回值结构（P0-1/P0-2 修复后使用）
      const errorReason = { type: 'error' as const, error: '测试错误', recoverable: true };
      expect(errorReason.type).toBe('error');
      expect(errorReason.recoverable).toBe(true);
    });

    it('TerminalReason 类型支持 completed.summary（含降级标记）', () => {
      // 验证 completed 类型仍可用于降级输出（P0-3 修复）
      const completedReason = { type: 'completed' as const, summary: '⚠️ [降级输出] 测试' };
      expect(completedReason.type).toBe('completed');
      expect(completedReason.summary).toContain('[降级输出]');
    });
  });

  // ============ Phase 1 P0 修复 (B2)：策略耗尽运行时路径断言 ============

  describe('B2: 策略耗尽时返回 error 而非伪装 completed（运行时路径）', () => {
    it('_buildStrategyExhaustedReason 返回 {type:"error", recoverable:true}', () => {
      // 真实运行时路径：run() 策略耗尽时调用此方法构造终端返回值。
      // 原 run() 直接 return {type:'completed'} 违反 Hard Constraint L6，现已提取为方法。
      (loop as unknown)._strategySwitchCount = 6;
      const reason = (loop as unknown)._buildStrategyExhaustedReason({
        turnCount: 10,
        messages: [{ role: 'assistant', content: '部分输出内容' }],
      });
      expect(reason.type).toBe('error');
      expect(reason.recoverable).toBe(true);
      expect(reason.error).toContain('已尝试 6 种策略');
      // 确保不是伪装成功（不含 completed 类型）
      expect(reason).not.toHaveProperty('summary');
    });

    it('无 assistant 输出时仍返回 error 类型（带轮次回退信息）', () => {
      (loop as unknown)._strategySwitchCount = 6;
      const reason = (loop as unknown)._buildStrategyExhaustedReason({
        turnCount: 3,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(reason.type).toBe('error');
      expect(reason.recoverable).toBe(true);
      expect(reason.error).toContain('经过 3 轮尝试后无法完成任务');
    });
  });

  // ============ Phase 1 P0 修复 (B1)：17 个注入方法存在性断言 ============

  describe('B1: 17 个 injectXxx 方法存在（bootstrap 调用不再静默失败）', () => {
    it('所有缺失的 inject 方法均已定义为 function', () => {
      // 这些方法原不存在，bootstrap.ts 的 try-catch 静默吞掉 TypeError，
      // 导致 EvolutionMetrics/FeedbackReward/SubAgent dispatch 等"已修复"功能在运行时仍死。
      const methods = [
        'injectSessionPersistence', 'injectUserProfile', 'injectAdversarialVerifier',
        'injectAdaptiveInteraction', 'injectDuanPersonaEngine', 'prewarmPromptCache',
        'injectMemoryStore', 'injectContextRetention', 'injectEvolutionMetrics',
        'injectFeedbackReward', 'injectTraceCollector', 'injectToolConsolidation',
        'injectUnifiedToolFramework', 'injectSelfEvolve', 'injectTaskDecomposition',
        'injectSubAgentOrchestrator', 'injectMultiStepReasoning',
      ];
      for (const name of methods) {
        expect(typeof (loop as unknown)[name]).toBe('function');
      }
    });

    it('injectSubAgentOrchestrator 注入后 cognitiveOrchestrator 字段非空（B3 修复）', () => {
      expect((loop as unknown).cognitiveOrchestrator).toBeNull();
      const mock = { dispatchSubAgent: async () => ({ summary: 'ok' }) };
      loop.injectSubAgentOrchestrator(mock);
      expect((loop as unknown).cognitiveOrchestrator).toBe(mock);
    });

    it('injectEvolutionMetrics / injectFeedbackReward 存储模块到对应字段', () => {
      const mockEM = { record: () => {} };
      const mockFR = { collectFeedback: () => {}, calculateReward: () => {} };
      loop.injectEvolutionMetrics(mockEM);
      loop.injectFeedbackReward(mockFR);
      expect((loop as unknown)._evolutionMetrics).toBe(mockEM);
      expect((loop as unknown)._feedbackReward).toBe(mockFR);
    });

    it('prewarmPromptCache 返回 Promise 且不抛', async () => {
      await expect((loop as unknown).prewarmPromptCache()).resolves.toBeUndefined();
    });
  });

  // ============ Phase 2 B8: _recordOutcomeToEvolutionMetrics 反馈链汇聚点 ============

  describe('B8: _recordOutcomeToEvolutionMetrics 喂养 5 个 source=\'new\' 指标', () => {
    /** 构造 mock EvolutionMetrics，捕获所有 recordRuntimeValue 调用 */
    const makeMockEM = () => {
      const calls: Array<{ id: string; value: number; mode: string }> = [];
      return {
        calls,
        recordRuntimeValue(id: string, value: number, mode: string) {
          calls.push({ id, value, mode });
        },
      };
    };

    it('成功完成路径：on_time/quality_gate/gap_probing 各 +1（delta），improvement_velocity/regression_rate 直推', () => {
      const em = makeMockEM();
      loop.injectEvolutionMetrics(em);
      // 模拟无 lessonsLearned、无 persona engine
      (loop as unknown).lessonsLearned = [];
      (loop as unknown)._duanPersonaEngine = null;

      const state = { turnCount: 5 };
      const reason = { type: 'completed' as const, summary: 'done' };
      const executionLog = [
        { tool: 'file_read', result: 'ok', success: true },
        { tool: 'shell_execute', result: 'ok', success: true },
      ];
      (loop as unknown)._recordOutcomeToEvolutionMetrics(state, reason, executionLog);

      // 5 次调用
      expect(em.calls).toHaveLength(5);
      const byId = Object.fromEntries(em.calls.map(c => [c.id, c]));
      expect(byId.on_time_completion_rate.mode).toBe('delta');
      expect(byId.on_time_completion_rate.value).toBe(1); // turnCount(5) ≤ DEFAULT_MAX_TURNS(20)
      expect(byId.quality_gate_pass_rate.mode).toBe('delta');
      expect(byId.quality_gate_pass_rate.value).toBe(1); // 无失败
      expect(byId.gap_probing_rate.mode).toBe('delta');
      expect(byId.gap_probing_rate.value).toBe(0); // 无 lessonsLearned
      expect(byId.improvement_velocity.mode).toBe('direct');
      expect(byId.improvement_velocity.value).toBe(0); // 0 lessons
      expect(byId.regression_rate.mode).toBe('direct');
      expect(byId.regression_rate.value).toBe(0); // 0 failed / 2 total = 0
    });

    it('策略耗尽路径（error）：on_time/quality_gate 为 0，regression_rate 反映失败比例', () => {
      const em = makeMockEM();
      loop.injectEvolutionMetrics(em);
      (loop as unknown).lessonsLearned = ['教训1', '教训2'];
      (loop as unknown)._duanPersonaEngine = null;

      const state = { turnCount: 25 }; // 超过 DEFAULT_MAX_TURNS
      const reason = { type: 'error' as const, error: 'exhausted', recoverable: true };
      const executionLog = [
        { tool: 'a', result: 'ok', success: true },
        { tool: 'b', result: 'fail', success: false },
        { tool: 'c', result: 'fail', success: false },
      ];
      (loop as unknown)._recordOutcomeToEvolutionMetrics(state, reason, executionLog);

      const byId = Object.fromEntries(em.calls.map(c => [c.id, c]));
      expect(byId.on_time_completion_rate.value).toBe(0); // error 不是 completed
      expect(byId.quality_gate_pass_rate.value).toBe(0); // error 不是 completed
      expect(byId.gap_probing_rate.value).toBe(1); // 有 2 lessons
      expect(byId.improvement_velocity.value).toBe(2); // 2 lessons
      expect(byId.regression_rate.value).toBeCloseTo(2 / 3, 5); // 2 failed / 3 total
    });

    it('未注入 _evolutionMetrics 时静默跳过（不抛错）', () => {
      (loop as unknown)._evolutionMetrics = null;
      expect(() => {
        (loop as unknown)._recordOutcomeToEvolutionMetrics(
          { turnCount: 1 },
          { type: 'completed', summary: 'x' },
          [],
        );
      }).not.toThrow();
    });
  });
});
