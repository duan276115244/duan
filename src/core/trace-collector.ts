/**
 * 全链路追踪收集器 — TraceCollector
 *
 * 参考 OpenAI Agents SDK Tracing 模式：
 * - Trace: 一次完整的 Agent 交互（从用户输入到最终输出）
 * - Span: Trace 内的子操作（LLM调用、工具执行、Handoff、护栏检查等）
 * - 支持嵌套 Span（parentId 构建调用树）
 * - 持久化到 .duan/traces/ 目录
 * - 查询与导出（JSON / Markdown）
 * - LLM 增强：通过 ModelLibrary 实现智能追踪摘要
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ModelLibrary } from './model-library.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** Span 数据 */
export interface SpanData {
  id: string;
  name: string;
  type: 'llm_call' | 'tool_execution' | 'handoff' | 'guardrail' | 'thinking' | 'compression' | 'custom';
  startTime: number;
  endTime?: number;
  duration?: number;
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed';
  error?: string;
  parentId?: string;
}

/** 完整 Trace */
export interface Trace {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'running' | 'completed' | 'failed';
  spans: SpanData[];
  metadata: Record<string, unknown>;
  tokenUsage: number;
  toolCallCount: number;
  errorCount: number;
}

/** Trace 摘要 */
export interface TraceSummary {
  id: string;
  name: string;
  duration: number;
  spanCount: number;
  status: string;
  tokenUsage: number;
}

/** Trace 查询过滤器 */
export interface TraceFilter {
  name?: string;
  startTime?: number;
  endTime?: number;
  minDuration?: number;
  status?: string;
  limit?: number;
}

/** 追踪统计 */
export interface TraceCollectorStats {
  totalTraces: number;
  activeTraces: number;
  completedTraces: number;
  failedTraces: number;
  totalSpans: number;
  avgTraceDuration: number;
  totalTokenUsage: number;
  totalToolCalls: number;
  tracesByType: Record<string, number>;
}

// ============ 主类 ============

export class TraceCollector {
  private traces = new Map<string, Trace>();
  private traceOrder: string[] = [];  // 保持插入顺序
  private log = logger.child({ module: 'TraceCollector' });
  private modelLibrary: ModelLibrary | null = null;
  private tracesDir: string;
  private maxInMemory = 200;
  private persistEnabled = true;

  // 统计
  private totalSpans = 0;
  private totalTokenUsage = 0;
  private totalToolCalls = 0;

  constructor() {
    this.tracesDir = duanPath('traces');
    this.ensureTracesDir();
    this.log.info('追踪收集器初始化完成', { tracesDir: this.tracesDir });
  }

  // ========== 目录管理 ==========

  private ensureTracesDir(): void {
    try {
      fs.mkdirSync(this.tracesDir, { recursive: true });
    } catch (err: unknown) {
      this.log.warn('创建追踪目录失败', { tracesDir: this.tracesDir, error: err });
      this.persistEnabled = false;
    }
  }

  /** 设置 ModelLibrary 用于 LLM 增强追踪摘要 */
  setModelLibrary(ml: ModelLibrary): void {
    this.modelLibrary = ml;
    this.log.info('已绑定 ModelLibrary，LLM 增强追踪摘要已启用');
  }

  /** 设置最大内存中保留的 Trace 数量 */
  setMaxInMemory(max: number): void {
    this.maxInMemory = max;
  }

  /** 设置持久化目录 */
  setTracesDir(dir: string): void {
    this.tracesDir = dir;
    this.ensureTracesDir();
  }

  // ========== Trace 生命周期 ==========

  /**
   * 启动一个新的 Trace
   */
  startTrace(name: string, metadata?: Record<string, unknown>): string {
    const id = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const trace: Trace = {
      id,
      name,
      startTime: now,
      status: 'running',
      spans: [],
      metadata: metadata || {},
      tokenUsage: 0,
      toolCallCount: 0,
      errorCount: 0,
    };

    this.traces.set(id, trace);
    this.traceOrder.push(id);

    // 内存限制：淘汰最旧的已完成 Trace
    this.evictIfNeeded();

    EventBus.getInstance().emitSync('trace.started', {
      traceId: id,
      name,
      metadata,
    });

    this.log.info('Trace 启动', { traceId: id, name });

    return id;
  }

  /**
   * 向 Trace 添加一个 Span
   */
  addSpan(traceId: string, span: Omit<SpanData, 'id' | 'duration'>): string | null {
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.log.warn('添加 Span 失败：Trace 不存在', { traceId });
      return null;
    }

    const spanId = `span_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const fullSpan: SpanData = {
      ...span,
      id: spanId,
      duration: span.endTime ? span.endTime - span.startTime : undefined,
    };

    trace.spans.push(fullSpan);
    this.totalSpans++;

    // 更新 Trace 统计
    if (span.type === 'tool_execution') {
      trace.toolCallCount++;
      this.totalToolCalls++;
    }
    if (span.status === 'failed') {
      trace.errorCount++;
    }

    // 从 metadata 中提取 tokenUsage
    if (span.metadata?.tokenUsage && typeof span.metadata.tokenUsage === 'number') {
      trace.tokenUsage += span.metadata.tokenUsage;
      this.totalTokenUsage += span.metadata.tokenUsage as number;
    }

    EventBus.getInstance().emitSync('trace.span.added', {
      traceId,
      spanId,
      spanName: span.name,
      spanType: span.type,
      status: span.status,
    });

    this.log.debug('Span 添加', {
      traceId,
      spanId,
      spanName: span.name,
      spanType: span.type,
    });

    return spanId;
  }

  /**
   * 结束一个 Span（更新 endTime 和 status）
   */
  endSpan(traceId: string, spanId: string, status: 'completed' | 'failed' = 'completed', error?: string): boolean {
    const trace = this.traces.get(traceId);
    if (!trace) return false;

    const span = trace.spans.find(s => s.id === spanId);
    if (!span) return false;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = status;
    if (error) span.error = error;

    if (status === 'failed') {
      trace.errorCount++;
    }

    return true;
  }

  /**
   * 结束一个 Trace
   */
  endTrace(traceId: string): TraceSummary | null {
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.log.warn('结束 Trace 失败：不存在', { traceId });
      return null;
    }

    const now = Date.now();
    trace.endTime = now;
    trace.duration = now - trace.startTime;

    // 结束所有未完成的 Span
    for (const span of trace.spans) {
      if (span.status === 'running') {
        span.endTime = now;
        span.duration = now - span.startTime;
        span.status = 'completed';
      }
    }

    // 确定最终状态
    trace.status = trace.errorCount > 0 ? 'failed' : 'completed';

    // 持久化
    if (this.persistEnabled) {
      this.persistTrace(trace);
    }

    EventBus.getInstance().emitSync('trace.completed', {
      traceId,
      name: trace.name,
      duration: trace.duration,
      spanCount: trace.spans.length,
      status: trace.status,
    });

    this.log.info('Trace 结束', {
      traceId,
      name: trace.name,
      duration: trace.duration,
      spanCount: trace.spans.length,
      status: trace.status,
    });

    return this.traceToSummary(trace);
  }

  // ========== Trace 查询 ==========

  /**
   * 获取完整 Trace 详情
   */
  getTrace(traceId: string): Trace | null {
    // 先从内存查找
    const trace = this.traces.get(traceId);
    if (trace) return trace;

    // 尝试从磁盘加载
    if (this.persistEnabled) {
      return this.loadTraceFromDisk(traceId);
    }

    return null;
  }

  /**
   * 查询 Traces
   */
  queryTraces(filter: TraceFilter): TraceSummary[] {
    let results: Trace[] = [];

    // 从内存中筛选
    for (const trace of this.traces.values()) {
      if (this.matchesFilter(trace, filter)) {
        results.push(trace);
      }
    }

    // 如果内存中结果不足，尝试从磁盘加载
    if (results.length < (filter.limit || 20) && this.persistEnabled) {
      const diskTraces = this.loadTracesFromDisk(filter);
      for (const dt of diskTraces) {
        if (!results.find(r => r.id === dt.id)) {
          results.push(dt);
        }
      }
    }

    // 按开始时间倒序
    results.sort((a, b) => b.startTime - a.startTime);

    // 限制数量
    const limit = filter.limit || 20;
    results = results.slice(0, limit);

    return results.map(t => this.traceToSummary(t));
  }

  /**
   * 导出 Trace
   */
  exportTrace(traceId: string, format: 'json' | 'markdown' = 'json'): string | null {
    const trace = this.getTrace(traceId);
    if (!trace) return null;

    if (format === 'json') {
      return JSON.stringify(trace, null, 2);
    }

    // Markdown 格式
    return this.traceToMarkdown(trace);
  }

  // ========== LLM 增强 ==========

  /**
   * 使用 LLM 生成追踪摘要
   */
  async generateTraceSummary(traceId: string): Promise<string> {
    const trace = this.getTrace(traceId);
    if (!trace) return 'Trace 不存在';

    if (!this.modelLibrary) {
      return this.generateBasicSummary(trace);
    }

    try {
      const traceData = this.traceToMarkdown(trace);
      const response = await this.modelLibrary.call([
        {
          role: 'system',
          content: '你是一个系统分析专家。请根据追踪数据，用简洁的中文总结这次Agent交互的关键信息：执行了什么操作、耗时多久、是否有错误、性能瓶颈在哪里。',
        },
        {
          role: 'user',
          content: `请总结以下追踪数据:\n\n${traceData.substring(0, 3000)}`,
        },
      ], { maxTokens: 500, autoFallback: true });

      return response.content;
    } catch (err: unknown) {
      this.log.warn('LLM 追踪摘要生成失败', { error: err });
      return this.generateBasicSummary(trace);
    }
  }

  // ========== 统计 ==========

  getStats(): TraceCollectorStats {
    let completedTraces = 0;
    let failedTraces = 0;
    let activeTraces = 0;
    let totalDuration = 0;
    const tracesByType: Record<string, number> = {};

    for (const trace of this.traces.values()) {
      if (trace.status === 'completed') {
        completedTraces++;
        totalDuration += trace.duration || 0;
      } else if (trace.status === 'failed') {
        failedTraces++;
        totalDuration += trace.duration || 0;
      } else {
        activeTraces++;
      }

      // 按 Span 类型统计
      for (const span of trace.spans) {
        tracesByType[span.type] = (tracesByType[span.type] || 0) + 1;
      }
    }

    const finishedTraces = completedTraces + failedTraces;

    return {
      totalTraces: this.traces.size,
      activeTraces,
      completedTraces,
      failedTraces,
      totalSpans: this.totalSpans,
      avgTraceDuration: finishedTraces > 0 ? Math.round(totalDuration / finishedTraces) : 0,
      totalTokenUsage: this.totalTokenUsage,
      totalToolCalls: this.totalToolCalls,
      tracesByType,
    };
  }

  // ========== 私有方法 ==========

  private traceToSummary(trace: Trace): TraceSummary {
    return {
      id: trace.id,
      name: trace.name,
      duration: trace.duration || 0,
      spanCount: trace.spans.length,
      status: trace.status,
      tokenUsage: trace.tokenUsage,
    };
  }

  private matchesFilter(trace: Trace, filter: TraceFilter): boolean {
    if (filter.name && !trace.name.includes(filter.name)) return false;
    if (filter.startTime && trace.startTime < filter.startTime) return false;
    if (filter.endTime && (trace.endTime || Date.now()) > filter.endTime) return false;
    if (filter.minDuration && (trace.duration || 0) < filter.minDuration) return false;
    if (filter.status && trace.status !== filter.status) return false;
    return true;
  }

  private traceToMarkdown(trace: Trace): string {
    const lines: string[] = [
      `# Trace: ${trace.name}`,
      ``,
      `- **ID**: ${trace.id}`,
      `- **状态**: ${trace.status}`,
      `- **开始**: ${new Date(trace.startTime).toISOString()}`,
      `- **结束**: ${trace.endTime ? new Date(trace.endTime).toISOString() : '进行中'}`,
      `- **耗时**: ${trace.duration ? `${trace.duration}ms` : '进行中'}`,
      `- **Token 使用**: ${trace.tokenUsage}`,
      `- **工具调用**: ${trace.toolCallCount}`,
      `- **错误数**: ${trace.errorCount}`,
      ``,
      `## Spans (${trace.spans.length})`,
      ``,
    ];

    // 构建 Span 树
    const rootSpans = trace.spans.filter(s => !s.parentId);
    const childSpans = trace.spans.filter(s => s.parentId);

    const renderSpan = (span: SpanData, indent: number): void => {
      const prefix = '  '.repeat(indent) + (indent > 0 ? '└─ ' : '');
      let statusIcon: string;
      if (span.status === 'completed') statusIcon = '✅';
      else if (span.status === 'failed') statusIcon = '❌';
      else statusIcon = '⏳';
      const duration = span.duration ? `${span.duration}ms` : '进行中';

      lines.push(`${prefix}${statusIcon} [${span.type}] ${span.name} (${duration})`);

      if (span.error) {
        lines.push(`${prefix}   错误: ${span.error}`);
      }

      // 渲染子 Span
      const children = childSpans.filter(s => s.parentId === span.id);
      for (const child of children) {
        renderSpan(child, indent + 1);
      }
    };

    for (const root of rootSpans) {
      renderSpan(root, 0);
    }

    // 如果有未挂载的子 Span
    const mountedIds = new Set(trace.spans.map(s => s.id));
    const orphanSpans = childSpans.filter(s => !mountedIds.has(s.parentId!));
    if (orphanSpans.length > 0) {
      lines.push('', '### 未挂载的 Span', '');
      for (const span of orphanSpans) {
        renderSpan(span, 0);
      }
    }

    // 元数据
    if (Object.keys(trace.metadata).length > 0) {
      lines.push('', '## 元数据', '');
      for (const [key, value] of Object.entries(trace.metadata)) {
        lines.push(`- **${key}**: ${JSON.stringify(value)}`);
      }
    }

    return lines.join('\n');
  }

  private generateBasicSummary(trace: Trace): string {
    const duration = trace.duration ? `${trace.duration}ms` : '进行中';
    const spanTypes: Record<string, number> = {};
    for (const span of trace.spans) {
      spanTypes[span.type] = (spanTypes[span.type] || 0) + 1;
    }

    const typeSummary = Object.entries(spanTypes)
      .map(([type, count]) => `${type}(${count})`)
      .join(', ');

    return [
      `追踪摘要: ${trace.name}`,
      `状态: ${trace.status} | 耗时: ${duration} | Span数: ${trace.spans.length}`,
      `类型分布: ${typeSummary}`,
      `Token: ${trace.tokenUsage} | 工具调用: ${trace.toolCallCount} | 错误: ${trace.errorCount}`,
    ].join('\n');
  }

  private evictIfNeeded(): void {
    while (this.traces.size > this.maxInMemory) {
      // 淘汰最旧的已完成 Trace
      const oldestCompletedId = this.traceOrder.find(id => {
        const t = this.traces.get(id);
        return t && t.status !== 'running';
      });

      if (oldestCompletedId) {
        // 先持久化再淘汰
        const trace = this.traces.get(oldestCompletedId);
        if (trace && this.persistEnabled) {
          this.persistTrace(trace);
        }
        this.traces.delete(oldestCompletedId);
        this.traceOrder = this.traceOrder.filter(id => id !== oldestCompletedId);
      } else {
        break; // 所有 Trace 都在运行中，不再淘汰
      }
    }
  }

  // ========== 持久化 ==========

  private persistTrace(trace: Trace): void {
    try {
      const filename = `${trace.id}.json`;
      const filepath = path.join(this.tracesDir, filename);
      atomicWriteJsonSync(filepath, trace);
    } catch (err: unknown) {
      this.log.warn('持久化 Trace 失败', { traceId: trace.id, error: err });
    }
  }

  private loadTraceFromDisk(traceId: string): Trace | null {
    try {
      const filepath = path.join(this.tracesDir, `${traceId}.json`);
      if (!fs.existsSync(filepath)) return null;
      const data = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(data) as Trace;
    } catch (err: unknown) {
      this.log.warn('从磁盘加载 Trace 失败', { traceId, error: err });
      return null;
    }
  }

  private loadTracesFromDisk(filter: TraceFilter): Trace[] {
    const results: Trace[] = [];
    try {
      if (!fs.existsSync(this.tracesDir)) return results;

      const files = fs.readdirSync(this.tracesDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();  // 最新的在前

      for (const file of files) {
        if (results.length >= (filter.limit || 20)) break;
        try {
          const data = fs.readFileSync(path.join(this.tracesDir, file), 'utf-8');
          const trace = JSON.parse(data) as Trace;
          if (this.matchesFilter(trace, filter)) {
            results.push(trace);
          }
        } catch {
          // 跳过损坏的文件
        }
      }
    } catch (err: unknown) {
      this.log.warn('从磁盘加载 Traces 失败', { error: err });
    }
    return results;
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tc = this;

    return [
      {
        name: 'trace_start',
        description: '启动一个新的追踪(Trace)。用于记录一次完整的Agent交互过程，包括LLM调用、工具执行、Handoff等子操作。',
        parameters: {
          name: { type: 'string', description: '追踪名称，如 "user_query_code_generation"', required: true },
          metadata: { type: 'string', description: '额外元数据（JSON格式），如 {"userId": "user123", "sessionId": "sess_456"}', required: false },
        },
        execute: (args) => {
          try {
            const name = args.name as string;
            let metadata: Record<string, unknown> | undefined;
            if (args.metadata) {
              try {
                metadata = JSON.parse(args.metadata as string);
              } catch { /* 非JSON忽略 */ }
            }
            const traceId = tc.startTrace(name, metadata);
            return Promise.resolve(`追踪已启动: ${traceId}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`启动追踪失败: ${msg}`);
          }
        },
      },
      {
        name: 'trace_span',
        description: '向追踪中添加一个Span（子操作）。Span代表追踪内的一个步骤，如LLM调用、工具执行、护栏检查等。',
        parameters: {
          traceId: { type: 'string', description: '追踪ID（由trace_start返回）', required: true },
          name: { type: 'string', description: 'Span名称，如 "llm_call_deepseek" 或 "tool_read_file"', required: true },
          type: { type: 'string', description: 'Span类型: llm_call / tool_execution / handoff / guardrail / thinking / compression / custom', required: true },
          input: { type: 'string', description: 'Span输入内容（可选）', required: false },
          output: { type: 'string', description: 'Span输出内容（可选）', required: false },
          status: { type: 'string', description: '状态: running / completed / failed，默认completed', required: false },
          error: { type: 'string', description: '错误信息（status为failed时填写）', required: false },
          parentId: { type: 'string', description: '父Span ID（用于嵌套Span）', required: false },
          metadata: { type: 'string', description: '额外元数据（JSON格式），如 {"tokenUsage": 1500}', required: false },
        },
        execute: (args) => {
          try {
            const traceId = args.traceId as string;
            const startTime = Date.now();

            let metadata: Record<string, unknown> | undefined;
            if (args.metadata) {
              try {
                metadata = JSON.parse(args.metadata as string);
              } catch { /* 非JSON忽略 */ }
            }

            const spanId = tc.addSpan(traceId, {
              name: args.name as string,
              type: (args.type as SpanData['type']) || 'custom',
              startTime,
              endTime: Date.now(),
              input: args.input as string | undefined,
              output: args.output as string | undefined,
              status: (args.status as SpanData['status']) || 'completed',
              error: args.error as string | undefined,
              parentId: args.parentId as string | undefined,
              metadata,
            });

            if (!spanId) {
              return Promise.resolve(`添加Span失败: Trace ${traceId} 不存在`);
            }
            return Promise.resolve(`Span已添加: ${spanId}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`添加Span失败: ${msg}`);
          }
        },
      },
      {
        name: 'trace_end',
        description: '结束一个追踪(Trace)。计算总耗时和统计数据，并持久化到磁盘。',
        parameters: {
          traceId: { type: 'string', description: '需要结束的追踪ID', required: true },
        },
        execute: (args) => {
          try {
            const traceId = args.traceId as string;
            const summary = tc.endTrace(traceId);
            if (!summary) {
              return Promise.resolve(`结束追踪失败: Trace ${traceId} 不存在`);
            }
            return Promise.resolve(`追踪已结束: ${JSON.stringify(summary, null, 2)}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`结束追踪失败: ${msg}`);
          }
        },
      },
      {
        name: 'trace_view',
        description: '查看追踪详情。可查看完整Trace信息或导出为JSON/Markdown格式。此操作只读。',
        parameters: {
          traceId: { type: 'string', description: '追踪ID', required: true },
          format: { type: 'string', description: '输出格式: json / markdown / summary，默认summary', required: false },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const traceId = args.traceId as string;
            const format = (args.format as string) || 'summary';

            if (format === 'summary') {
              const trace = tc.getTrace(traceId);
              if (!trace) return Promise.resolve(`Trace ${traceId} 不存在`);
              return Promise.resolve(tc['generateBasicSummary'](trace));
            }

            const exported = tc.exportTrace(traceId, format as 'json' | 'markdown');
            if (!exported) return Promise.resolve(`Trace ${traceId} 不存在`);
            return Promise.resolve(exported);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`查看追踪失败: ${msg}`);
          }
        },
      },
      {
        name: 'trace_query',
        description: '查询追踪列表。支持按名称、时间范围、耗时、状态等条件过滤。此操作只读。',
        parameters: {
          name: { type: 'string', description: '按名称过滤（模糊匹配）', required: false },
          status: { type: 'string', description: '按状态过滤: running / completed / failed', required: false },
          minDuration: { type: 'string', description: '最小耗时（毫秒）', required: false },
          limit: { type: 'string', description: '返回数量限制，默认20', required: false },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const filter: TraceFilter = {};
            if (args.name) filter.name = args.name as string;
            if (args.status) filter.status = args.status as string;
            if (args.minDuration) filter.minDuration = parseInt(args.minDuration as string);
            if (args.limit) filter.limit = parseInt(args.limit as string);

            const results = tc.queryTraces(filter);

            if (results.length === 0) {
              return Promise.resolve('没有匹配的追踪记录');
            }

            const lines = results.map((t, i) => {
              let statusIcon: string;
              if (t.status === 'completed') statusIcon = '✅';
              else if (t.status === 'failed') statusIcon = '❌';
              else statusIcon = '⏳';
              return `${i + 1}. ${statusIcon} ${t.name} (${t.id}) | ${t.duration}ms | ${t.spanCount}spans | token:${t.tokenUsage}`;
            });

            return Promise.resolve(`找到 ${results.length} 条追踪:\n${lines.join('\n')}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`查询追踪失败: ${msg}`);
          }
        },
      },
    ];
  }
}
