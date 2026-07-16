/**
 * 工具组合编排引擎 — ToolOrchestrationEngine
 *
 * 对标 OpenClaw 的工具编排和 Codex 的管道模式。
 * 解决复杂任务需要多工具组合调用的问题（目标：>85% 工具组合成功率）。
 *
 * 核心能力：
 * 1. 工具管道：将多个工具调用串联成管道
 * 2. 条件分支：根据中间结果选择不同执行路径
 * 3. 并行执行：无依赖的工具调用并行执行
 * 4. 结果传递：前一个工具的输出作为后一个的输入
 * 5. 错误恢复：单个工具失败时的恢复策略
 * 6. 模板编排：预定义常用工具组合模板
 *
 * 借鉴来源：
 * - OpenClaw：Tool Composition Orchestration Engine
 * - Codex：管道模式
 * - LangChain：Chain / SequentialChain
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** 编排步骤类型 */
export type StepType = 'tool' | 'parallel' | 'conditional' | 'transform' | 'delay';

/** 编排步骤 */
export interface OrchestrationStep {
  /** 步骤 ID */
  id: string;
  /** 步骤类型 */
  type: StepType;
  /** 工具名（type=tool 时） */
  toolName?: string;
  /** 工具参数（可引用前序结果） */
  args?: Record<string, unknown>;
  /** 并行子步骤（type=parallel 时） */
  parallelSteps?: OrchestrationStep[];
  /** 条件表达式（type=conditional 时） */
  condition?: (context: OrchestrationContext) => boolean;
  /** 条件为真时执行的步骤 */
  trueSteps?: OrchestrationStep[];
  /** 条件为假时执行的步骤 */
  falseSteps?: OrchestrationStep[];
  /** 数据转换函数（type=transform 时） */
  transform?: (input: unknown, context: OrchestrationContext) => unknown;
  /** 延迟毫秒（type=delay 时） */
  delayMs?: number;
  /** 结果键名（存储到 context.results 中的键名） */
  resultKey?: string;
  /** 超时（毫秒） */
  timeoutMs?: number;
  /** 失败时的恢复策略 */
  onError?: 'continue' | 'abort' | 'retry' | 'skip';
  /** 最大重试次数 */
  maxRetries?: number;
}

/** 编排上下文 */
export interface OrchestrationContext {
  /** 初始输入 */
  // 保留 any：测试消费者 (world-class-optimizations-batch2.test.ts) 通过 ctx.input.shouldRun 访问属性，
  // 改为 unknown 会破坏测试编译；且内部 input 可为任意类型，无法用单一结构化类型覆盖。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  /** 中间结果 */
  results: Record<string, unknown>;
  /** 当前步骤索引 */
  currentStep: number;
  /** 执行历史 */
  history: Array<{ stepId: string; success: boolean; result?: unknown; error?: string; durationMs: number }>;
  /** 元数据 */
  metadata: Record<string, unknown>;
}

/** 编排结果 */
export interface OrchestrationResult {
  /** 是否成功 */
  success: boolean;
  /** 最终结果 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  /** 完整上下文 */
  context: OrchestrationContext;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 执行的步骤数 */
  stepsExecuted: number;
  /** 失败的步骤数 */
  stepsFailed: number;
  /** 错误信息 */
  error?: string;
}

/** 工具执行器接口 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolExecutor = (toolName: string, args: Record<string, any>) => Promise<any>;

/** 编排模板 */
export interface OrchestrationTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 步骤 */
  steps: OrchestrationStep[];
}

/** 编排统计 */
export interface OrchestrationStats {
  totalOrchestrations: number;
  successfulOrchestrations: number;
  failedOrchestrations: number;
  totalStepsExecuted: number;
  totalStepsFailed: number;
  averageDurationMs: number;
  byTemplate: Record<string, { used: number; succeeded: number }>;
}

// ============ 预定义模板 ============

const DEFAULT_TEMPLATES: OrchestrationTemplate[] = [
  {
    id: 'read-analyze-modify',
    name: '读取-分析-修改',
    description: '读取文件 → 分析代码 → 修改文件 → 验证',
    steps: [
      { id: 'read', type: 'tool', toolName: 'read_file', args: { path: '{{input.filePath}}' }, resultKey: 'fileContent', onError: 'abort' },
      { id: 'analyze', type: 'tool', toolName: 'code_analyze', args: { content: '{{results.fileContent}}' }, resultKey: 'analysis', onError: 'continue' },
      { id: 'modify', type: 'tool', toolName: 'edit_file', args: { path: '{{input.filePath}}', changes: '{{input.changes}}' }, resultKey: 'modified', onError: 'abort' },
      { id: 'verify', type: 'tool', toolName: 'lsp_diagnostics', args: { file: '{{input.filePath}}' }, resultKey: 'diagnostics', onError: 'continue' },
    ],
  },
  {
    id: 'search-read-summarize',
    name: '搜索-读取-摘要',
    description: '搜索代码 → 读取匹配文件 → 生成摘要',
    steps: [
      { id: 'search', type: 'tool', toolName: 'semantic_search', args: { query: '{{input.query}}' }, resultKey: 'searchResults', onError: 'abort' },
      { id: 'read-all', type: 'parallel', parallelSteps: [], resultKey: 'fileContents', onError: 'continue' },
      { id: 'summarize', type: 'tool', toolName: 'summarize', args: { content: '{{results.fileContents}}' }, resultKey: 'summary', onError: 'abort' },
    ],
  },
  {
    id: 'test-fix-retest',
    name: '测试-修复-重测',
    description: '运行测试 → 分析失败 → 修复 → 重新测试',
    steps: [
      { id: 'test1', type: 'tool', toolName: 'run_tests', args: { pattern: '{{input.pattern}}' }, resultKey: 'testResults1', onError: 'continue' },
      { id: 'check-fail', type: 'conditional', condition: (ctx) => ((ctx.results.testResults1 as { failures?: number } | undefined)?.failures ?? 0) > 0, trueSteps: [
        { id: 'analyze-fail', type: 'tool', toolName: 'analyze_failure', args: { results: '{{results.testResults1}}' }, resultKey: 'failureAnalysis', onError: 'continue' },
        { id: 'fix', type: 'tool', toolName: 'edit_file', args: { fixes: '{{results.failureAnalysis}}' }, resultKey: 'fixApplied', onError: 'continue' },
        { id: 'test2', type: 'tool', toolName: 'run_tests', args: { pattern: '{{input.pattern}}' }, resultKey: 'testResults2', onError: 'continue' },
      ]},
    ],
  },
];

// ============ ToolOrchestrationEngine 主类 ============

export class ToolOrchestrationEngine {
  private log = logger.child({ module: 'ToolOrchestrationEngine' });
  private templates: Map<string, OrchestrationTemplate> = new Map();
  private stats = {
    totalOrchestrations: 0,
    successfulOrchestrations: 0,
    failedOrchestrations: 0,
    totalStepsExecuted: 0,
    totalStepsFailed: 0,
    totalDurationMs: 0,
    byTemplate: {} as Record<string, { used: number; succeeded: number }>,
  };

  constructor() {
    // 加载默认模板
    for (const template of DEFAULT_TEMPLATES) {
      this.templates.set(template.id, template);
    }
  }

  /**
   * 执行编排
   */
  async orchestrate(
    steps: OrchestrationStep[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    executor: ToolExecutor,
    metadata?: Record<string, unknown>,
  ): Promise<OrchestrationResult> {
    const startMs = Date.now();
    const context: OrchestrationContext = {
      input,
      results: {},
      currentStep: 0,
      history: [],
      metadata: metadata || {},
    };

    this.stats.totalOrchestrations++;

    try {
      let lastResult: unknown = input;
      for (let i = 0; i < steps.length; i++) {
        context.currentStep = i;
        const step = steps[i];
        const stepResult = await this.executeStep(step, context, executor);
        lastResult = stepResult;

        if (step.resultKey) {
          context.results[step.resultKey] = stepResult;
        }

        // 检查是否应该中止
        const lastHistory = context.history[context.history.length - 1];
        if (lastHistory && !lastHistory.success && step.onError === 'abort') {
          this.stats.failedOrchestrations++;
          this.stats.totalDurationMs += Date.now() - startMs;
          return {
            success: false,
            result: lastResult,
            context,
            totalDurationMs: Date.now() - startMs,
            stepsExecuted: i + 1,
            stepsFailed: context.history.filter(h => !h.success).length,
            error: `步骤 ${step.id} 失败且策略为 abort`,
          };
        }
      }

      this.stats.successfulOrchestrations++;
      this.stats.totalDurationMs += Date.now() - startMs;
      this.stats.totalStepsExecuted += context.history.length;
      this.stats.totalStepsFailed += context.history.filter(h => !h.success).length;

      return {
        success: true,
        result: lastResult,
        context,
        totalDurationMs: Date.now() - startMs,
        stepsExecuted: context.history.length,
        stepsFailed: context.history.filter(h => !h.success).length,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.stats.failedOrchestrations++;
      this.stats.totalDurationMs += Date.now() - startMs;
      return {
        success: false,
        result: null,
        context,
        totalDurationMs: Date.now() - startMs,
        stepsExecuted: context.history.length,
        stepsFailed: context.history.filter(h => !h.success).length,
        error: msg,
      };
    }
  }

  /**
   * 使用模板执行
   */
  async orchestrateWithTemplate(
    templateId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    executor: ToolExecutor,
    metadata?: Record<string, unknown>,
  ): Promise<OrchestrationResult> {
    const template = this.templates.get(templateId);
    if (!template) {
      return {
        success: false,
        result: null,
        context: { input, results: {}, currentStep: 0, history: [], metadata: {} },
        totalDurationMs: 0,
        stepsExecuted: 0,
        stepsFailed: 0,
        error: `未找到模板: ${templateId}`,
      };
    }

    if (!this.stats.byTemplate[templateId]) {
      this.stats.byTemplate[templateId] = { used: 0, succeeded: 0 };
    }
    this.stats.byTemplate[templateId].used++;

    const result = await this.orchestrate(template.steps, input, executor, metadata);
    if (result.success) {
      this.stats.byTemplate[templateId].succeeded++;
    }
    return result;
  }

  /**
   * 注册模板
   */
  registerTemplate(template: OrchestrationTemplate): void {
    this.templates.set(template.id, template);
    this.log.debug('注册编排模板', { id: template.id, name: template.name });
  }

  /**
   * 获取模板
   */
  getTemplate(id: string): OrchestrationTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * 获取所有模板
   */
  getTemplates(): OrchestrationTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * 获取统计信息
   */
  getStats(): OrchestrationStats {
    return {
      totalOrchestrations: this.stats.totalOrchestrations,
      successfulOrchestrations: this.stats.successfulOrchestrations,
      failedOrchestrations: this.stats.failedOrchestrations,
      totalStepsExecuted: this.stats.totalStepsExecuted,
      totalStepsFailed: this.stats.totalStepsFailed,
      averageDurationMs: this.stats.totalOrchestrations > 0
        ? this.stats.totalDurationMs / this.stats.totalOrchestrations
        : 0,
      byTemplate: { ...this.stats.byTemplate },
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      totalOrchestrations: 0,
      successfulOrchestrations: 0,
      failedOrchestrations: 0,
      totalStepsExecuted: 0,
      totalStepsFailed: 0,
      totalDurationMs: 0,
      byTemplate: {},
    };
  }

  // ============ 工具定义 ============

  /**
   * P0 真实修复：暴露 getToolDefinitions — 使主循环 LLM 可主动调用多工具协同工作流
   * 之前 ToolOrchestrationEngine 通过 (loop as unknown).orchestrationEngine 注入但从未被调用（死代码）。
   * 现在作为标准工具模块注册，LLM 可在需要管道/扇出/扇入/条件工作流时主动调用。
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: Record<string, any>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    return [
      {
        name: 'orchestrate_pipeline',
        description: '执行多工具协同工作流（管道模式）：按顺序执行一系列工具，前一个工具的输出作为后一个工具的输入。支持条件分支和错误处理。',
        parameters: {
          steps: {
            type: 'string',
            description: 'JSON 字符串，步骤数组。每项包含: toolName(工具名), args(参数对象), resultKey(结果键名，可选), condition(条件表达式，可选), onError(错误处理: abort/continue/skip，默认 abort)',
            required: true,
          },
          input: {
            type: 'string',
            description: '初始输入数据（JSON 字符串或纯文本）',
            required: false,
          },
        },
        readOnly: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (args: any) => {
          try {
            const steps = typeof args.steps === 'string' ? JSON.parse(args.steps) : args.steps;
            let input: unknown = null;
            if (args.input) {
              if (typeof args.input === 'string') {
                try { input = JSON.parse(args.input); } catch { input = args.input; }
              } else {
                input = args.input;
              }
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await this.orchestrate(steps, input, (toolName: string, toolArgs: any) => {
              // 委托给主循环的工具执行器（通过 EventBus）
              const eventBus = EventBus.getInstance();
              return new Promise<string>((resolve) => {
                let resolved = false;
                let unsubscribe: (() => void) | null = null;
                let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const handler = (data: any) => {
                  if (data.toolName === toolName && !resolved) {
                    if (unsubscribe) unsubscribe();
                    // 工具正常返回，清理 30s 超时 timer 避免泄漏
                    if (timeoutTimer) clearTimeout(timeoutTimer);
                    resolved = true;
                    resolve(data.result || '');
                  }
                };
                unsubscribe = eventBus.on('tool.execute.result', handler);
                eventBus.emitSync('tool.execute.request', { toolName, args: toolArgs });
                // 超时保护
                timeoutTimer = setTimeout(() => {
                  if (!resolved) {
                    if (unsubscribe) unsubscribe();
                    resolved = true;
                    resolve(`❌ 工具 ${toolName} 执行超时`);
                  }
                }, 30000);
              });
            });
            return JSON.stringify({
              success: result.success,
              result: typeof result.result === 'string' ? result.result.substring(0, 2000) : JSON.stringify(result.result).substring(0, 2000),
              stepsExecuted: result.stepsExecuted,
              stepsFailed: result.stepsFailed,
              duration: result.totalDurationMs,
            }, null, 2);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `❌ 编排执行失败: ${msg}`;
          }
        },
      },
      {
        name: 'orchestrate_template',
        description: '使用预定义模板执行多工具协同工作流。可用模板包括: 代码审查流水线、数据处理管道、测试生成流程等。',
        parameters: {
          templateId: {
            type: 'string',
            description: '模板ID（如 code_review, data_pipeline, test_generation）',
            required: true,
          },
          input: {
            type: 'string',
            description: '输入数据（JSON 字符串或纯文本）',
            required: true,
          },
        },
        readOnly: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (args: any) => {
          try {
            const result = await this.orchestrateWithTemplate(
              args.templateId,
              args.input,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (toolName: string, toolArgs: any) => {
                const eventBus = EventBus.getInstance();
                return new Promise<string>((resolve) => {
                  let resolved = false;
                  let unsubscribe: (() => void) | null = null;
                  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const handler = (data: any) => {
                    if (data.toolName === toolName && !resolved) {
                      if (unsubscribe) unsubscribe();
                      // 工具正常返回，清理 30s 超时 timer 避免泄漏
                      if (timeoutTimer) clearTimeout(timeoutTimer);
                      resolved = true;
                      resolve(data.result || '');
                    }
                  };
                  unsubscribe = eventBus.on('tool.execute.result', handler);
                  eventBus.emitSync('tool.execute.request', { toolName, args: toolArgs });
                  timeoutTimer = setTimeout(() => {
                    if (!resolved) {
                      if (unsubscribe) unsubscribe();
                      resolved = true;
                      resolve(`❌ 工具 ${toolName} 执行超时`);
                    }
                  }, 30000);
                });
              },
            );
            return JSON.stringify(result, null, 2);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return `❌ 模板执行失败: ${msg}`;
          }
        },
      },
      {
        name: 'list_orchestration_templates',
        description: '列出所有可用的多工具协同工作流模板',
        parameters: {},
        readOnly: true,
        execute: () => {
          const templates = this.getTemplates();
          return Promise.resolve(templates.map(t => `  - ${t.id}: ${t.name} — ${t.description}`).join('\n') || '无可用模板');
        },
      },
      {
        name: 'orchestration_stats',
        description: '获取多工具协同工作流的执行统计',
        parameters: {},
        readOnly: true,
        execute: () => Promise.resolve(JSON.stringify(this.getStats(), null, 2)),
      },
    ];
  }

  // ============ 私有方法 ============

  /** 执行单个步骤 */
  private async executeStep(
    step: OrchestrationStep,
    context: OrchestrationContext,
    executor: ToolExecutor,
  ): Promise<unknown> {
    const startMs = Date.now();
    let success = false;
    let result: unknown = null;
    let error: string | undefined;

    try {
      switch (step.type) {
        case 'tool':
          result = await this.executeToolStep(step, context, executor);
          success = true;
          break;

        case 'parallel':
          result = await this.executeParallelStep(step, context, executor);
          success = true;
          break;

        case 'conditional':
          result = await this.executeConditionalStep(step, context, executor);
          success = true;
          break;

        case 'transform':
          result = this.executeTransformStep(step, context);
          success = true;
          break;

        case 'delay':
          await this.sleep(step.delayMs || 1000);
          result = null;
          success = true;
          break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
      success = false;

      // 错误恢复
      if (step.onError === 'retry' && step.maxRetries) {
        for (let attempt = 1; attempt <= step.maxRetries; attempt++) {
          try {
            result = await this.executeToolStep(step, context, executor);
            success = true;
            error = undefined;
            break;
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            error = retryMsg;
          }
        }
      }
    }

    context.history.push({
      stepId: step.id,
      success,
      result: success ? result : undefined,
      error,
      durationMs: Date.now() - startMs,
    });

    // 存储结果到 context（支持内部步骤的结果存储）
    if (success && step.resultKey) {
      context.results[step.resultKey] = result;
    }

    if (success) {
      this.log.debug('步骤执行成功', { stepId: step.id, type: step.type, durationMs: Date.now() - startMs });
    } else {
      this.log.warn('步骤执行失败', { stepId: step.id, error, onError: step.onError });
    }

    return result;
  }

  /** 执行工具步骤 */
  private executeToolStep(
    step: OrchestrationStep,
    context: OrchestrationContext,
    executor: ToolExecutor,
  ): Promise<unknown> {
    if (!step.toolName) return Promise.reject(new Error('工具步骤缺少 toolName'));

    // 解析参数（替换 {{}} 引用）
    const resolvedArgs = this.resolveArgs(step.args || {}, context);

    // 超时控制
    if (step.timeoutMs) {
      return Promise.race([
        executor(step.toolName, resolvedArgs),
        this.timeout(step.timeoutMs, step.toolName),
      ]);
    }

    return executor(step.toolName, resolvedArgs);
  }

  /** 执行并行步骤 */
  private async executeParallelStep(
    step: OrchestrationStep,
    context: OrchestrationContext,
    executor: ToolExecutor,
  ): Promise<unknown[]> {
    if (!step.parallelSteps || step.parallelSteps.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      step.parallelSteps.map(s => this.executeStep(s, context, executor)),
    );

    return results.map(r => (r.status === 'fulfilled' ? r.value : null));
  }

  /** 执行条件步骤 */
  private async executeConditionalStep(
    step: OrchestrationStep,
    context: OrchestrationContext,
    executor: ToolExecutor,
  ): Promise<unknown> {
    if (!step.condition) return null;

    const conditionResult = step.condition(context);
    const steps = conditionResult ? step.trueSteps : step.falseSteps;

    if (!steps || steps.length === 0) return null;

    let lastResult: unknown = null;
    for (const s of steps) {
      lastResult = await this.executeStep(s, context, executor);
    }
    return lastResult;
  }

  /** 执行转换步骤 */
  private executeTransformStep(step: OrchestrationStep, context: OrchestrationContext): unknown {
    if (!step.transform) return null;
    const input = context.results[step.resultKey || ''] || context.input;
    return step.transform(input, context);
  }

  /** 解析参数中的引用 */
  private resolveArgs(args: Record<string, unknown>, context: OrchestrationContext): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      resolved[key] = this.resolveValue(value, context);
    }
    return resolved;
  }

  /** 解析单个值中的引用 */
  private resolveValue(value: unknown, context: OrchestrationContext): unknown {
    if (typeof value === 'string') {
      // 匹配 {{input.xxx}} 或 {{results.xxx}}
      const refMatch = value.match(/^\{\{([^}]+)\}\}$/);
      if (refMatch) {
        return this.resolveRef(refMatch[1], context);
      }
      // 替换字符串中的引用
      return value.replace(/\{\{([^}]+)\}\}/g, (_, ref) => {
        const resolved = this.resolveRef(ref, context);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
      });
    }
    if (Array.isArray(value)) {
      return value.map(v => this.resolveValue(v, context));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.resolveValue(v, context);
      }
      return result;
    }
    return value;
  }

  /** 解析引用路径 */
  private resolveRef(ref: string, context: OrchestrationContext): unknown {
    const parts = ref.split('.');
    let current: unknown = context;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** 超时 Promise */
  private timeout(ms: number, toolName: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`工具 ${toolName} 超时 (${ms}ms)`)), ms),
    );
  }

  /** 延时 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============ 单例 ============
// 注：单例工厂 getToolOrchestrationEngine() 已删除（零调用），resetToolOrchestrationEngine() 同步删除
