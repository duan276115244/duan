/**
 * 任务成功率评估系统 — TaskSuccessTracker
 *
 * 核心能力：
 * 1. 任务记录 — 记录任务执行过程、步骤、结果
 * 2. 失败分析 — 自动分析失败根因，匹配已知失败模式
 * 3. 优化建议 — 基于失败模式生成工具/流程优化建议
 * 4. 指标统计 — 按领域/意图/工具/复杂度聚合成功率
 * 5. 趋势追踪 — 按日聚合成功率趋势数据
 * 6. 持久化 — 任务记录与失败模式落盘，支持重启恢复
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export type ErrorCategory =
  | 'tool_not_found'
  | 'tool_timeout'
  | 'tool_error'
  | 'invalid_args'
  | 'permission_denied'
  | 'network_error'
  | 'resource_not_found'
  | 'unknown';

export interface StepRecord {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  success: boolean;
  duration: number;
  error?: string;
  errorCategory?: ErrorCategory;
}

export interface TaskRecord {
  id: string;
  goal: string;
  intent: string;
  domain: string;
  steps: StepRecord[];
  overallSuccess: boolean;
  successScore: number;
  startTime: number;
  endTime: number;
  duration: number;
  toolsUsed: string[];
  errorTypes: string[];
  userFeedback?: 'positive' | 'negative' | 'neutral';
  retryCount: number;
  complexity: 'simple' | 'moderate' | 'complex';
}

export interface FixSuggestion {
  description: string;
  action: 'retry' | 'adjust_args' | 'use_alternative_tool' | 'ask_user' | 'skip_step';
  details: string;
  priority: 'high' | 'medium' | 'low';
}

export interface FailurePattern {
  name: string;
  description: string;
  occurrenceCount: number;
  lastSeen: number;
  commonFixes: string[];
}

export interface FailureAnalysis {
  taskId: string;
  rootCause: string;
  errorCategory: ErrorCategory;
  affectedSteps: number[];
  suggestedFixes: FixSuggestion[];
  patternMatch?: FailurePattern;
  confidence: number;
}

export interface SuccessMetrics {
  totalTasks: number;
  successRate: number;
  averageDuration: number;
  averageScore: number;
  byDomain: Record<string, { total: number; successRate: number; avgDuration: number }>;
  byIntent: Record<string, { total: number; successRate: number }>;
  byTool: Record<string, { total: number; successRate: number; avgDuration: number }>;
  byComplexity: Record<string, { total: number; successRate: number }>;
  topFailurePatterns: FailurePattern[];
  trendData: Array<{ date: string; successRate: number; taskCount: number }>;
}

// ============ 错误分类规则 ============

interface ErrorRule {
  category: ErrorCategory;
  patterns: string[];
}

const ERROR_RULES: ErrorRule[] = [
  { category: 'tool_not_found', patterns: ['not found', '未找到', '不存在'] },
  { category: 'tool_timeout', patterns: ['timeout', '超时', 'ETIMEDOUT'] },
  { category: 'invalid_args', patterns: ['invalid', '参数错误', '缺少参数'] },
  { category: 'permission_denied', patterns: ['permission', '权限', 'EACCES', 'denied'] },
  { category: 'network_error', patterns: ['network', '网络', 'ECONNREFUSED', 'ENOTFOUND'] },
  { category: 'resource_not_found', patterns: ['ENOENT', '文件不存在', 'not exist'] },
];

// ============ 修复建议模板 ============

const FIX_TEMPLATES: Record<ErrorCategory, Omit<FixSuggestion, 'priority'>[]> = {
  tool_not_found: [
    { action: 'use_alternative_tool', description: '使用替代工具', details: '当前工具未找到，建议使用功能相近的替代工具执行相同操作' },
    { action: 'ask_user', description: '确认工具可用性', details: '目标工具可能未安装或未注册，请用户确认工具是否可用' },
  ],
  tool_timeout: [
    { action: 'retry', description: '增加超时时间重试', details: '操作超时，建议延长超时阈值后重试' },
    { action: 'adjust_args', description: '缩小操作范围', details: '超时可能因操作范围过大，建议缩小参数范围分批执行' },
  ],
  tool_error: [
    { action: 'retry', description: '重试执行', details: '工具执行出错，建议重试一次' },
    { action: 'adjust_args', description: '调整参数', details: '工具内部错误，建议检查并调整输入参数' },
  ],
  invalid_args: [
    { action: 'adjust_args', description: '修正参数', details: '参数校验失败，请检查参数格式和取值范围' },
    { action: 'ask_user', description: '确认参数要求', details: '无法自动推断正确参数，建议询问用户提供有效参数' },
  ],
  permission_denied: [
    { action: 'ask_user', description: '请求权限', details: '当前操作需要更高权限，建议请求用户授权' },
    { action: 'skip_step', description: '跳过步骤', details: '权限不足且无法获取授权，建议跳过此步骤并告知用户' },
  ],
  network_error: [
    { action: 'retry', description: '网络重试', details: '网络连接失败，建议稍后重试' },
    { action: 'skip_step', description: '使用离线模式', details: '网络不可用，建议切换到离线模式或缓存数据' },
  ],
  resource_not_found: [
    { action: 'use_alternative_tool', description: '先创建资源', details: '目标资源不存在，建议先使用创建工具生成所需资源' },
    { action: 'ask_user', description: '确认资源路径', details: '资源未找到，建议用户确认路径或提供正确的资源位置' },
  ],
  unknown: [
    { action: 'retry', description: '重试操作', details: '未知错误，建议重试一次' },
    { action: 'ask_user', description: '人工介入', details: '无法自动处理此错误，建议请求用户协助' },
  ],
};

// ============ 主类 ============

export class TaskSuccessTracker {
  private tasks: Map<string, TaskRecord> = new Map();
  private activeTasks: Map<string, Partial<TaskRecord> & { id: string; startTime: number; steps: StepRecord[]; retryCount: number }> = new Map();
  private failurePatterns: Map<string, FailurePattern> = new Map();
  private maxRecords: number;
  private dataDir: string;
  private log = logger.child({ module: 'TaskSuccessTracker' });
  private eventBus = EventBus.getInstance();

  constructor(options?: { maxRecords?: number; dataDir?: string }) {
    this.maxRecords = options?.maxRecords ?? 1000;
    this.dataDir = options?.dataDir || duanPath('metrics');
    this.loadSync();
  }

  // ========== 任务记录 ==========

  recordTaskStart(goal: string, intent: string, domain: string, complexity: string): string {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const validComplexity = ['simple', 'moderate', 'complex'].includes(complexity)
      ? complexity as TaskRecord['complexity']
      : 'moderate';

    this.activeTasks.set(id, {
      id,
      goal,
      intent,
      domain,
      startTime: Date.now(),
      steps: [],
      retryCount: 0,
      complexity: validComplexity,
    });

    this.log.info('任务开始记录', { taskId: id, goal, intent, domain, complexity: validComplexity });
    this.eventBus.emitSync('task.started', { taskId: id, goal, intent, domain });
    return id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recordStep(taskId: string, toolName: string, args: any, success: boolean, duration: number, error?: string): void {
    const active = this.activeTasks.get(taskId);
    if (!active) {
      this.log.warn('未找到活跃任务，无法记录步骤', { taskId });
      return;
    }

    const step: StepRecord = {
      toolName,
      args: typeof args === 'object' && args !== null ? { ...args } : { value: args },
      success,
      duration,
      error,
      errorCategory: error ? this.categorizeError(error) : undefined,
    };

    active.steps.push(step);

    if (!success) {
      this.log.warn('步骤执行失败', { taskId, toolName, error, category: step.errorCategory });
    }
  }

  recordTaskEnd(taskId: string, success: boolean, score: number): void {
    const active = this.activeTasks.get(taskId);
    if (!active) {
      this.log.warn('未找到活跃任务，无法结束记录', { taskId });
      return;
    }

    const clampedScore = Math.max(0, Math.min(1, score));
    const endTime = Date.now();
    const toolsUsed = [...new Set(active.steps.map(s => s.toolName))];
    const errorTypes = [...new Set(
      active.steps.filter(s => s.errorCategory).map(s => s.errorCategory!),
    )];

    const record: TaskRecord = {
      id: active.id,
      goal: active.goal!,
      intent: active.intent!,
      domain: active.domain!,
      steps: active.steps,
      overallSuccess: success,
      successScore: clampedScore,
      startTime: active.startTime,
      endTime,
      duration: endTime - active.startTime,
      toolsUsed,
      errorTypes,
      retryCount: active.retryCount,
      complexity: active.complexity!,
    };

    this.tasks.set(taskId, record);
    this.activeTasks.delete(taskId);

    // 失败时自动分析并更新失败模式
    if (!success) {
      this.updateFailurePatterns(record);
    }

    // 超出上限时移除最旧记录
    if (this.tasks.size > this.maxRecords) {
      const sorted = [...this.tasks.entries()].sort((a, b) => a[1].startTime - b[1].startTime);
      const removeCount = this.tasks.size - this.maxRecords;
      for (let i = 0; i < removeCount; i++) {
        this.tasks.delete(sorted[i][0]);
      }
    }

    this.log.info('任务结束记录', {
      taskId,
      success,
      score: clampedScore,
      duration: record.duration,
      steps: record.steps.length,
      errorTypes,
    });

    this.eventBus.emitSync(success ? 'task.completed' : 'task.failed', {
      taskId,
      score: clampedScore,
      duration: record.duration,
      errorTypes,
    });

    this.saveDebounced();
  }

  recordUserFeedback(taskId: string, feedback: 'positive' | 'negative' | 'neutral'): void {
    const record = this.tasks.get(taskId);
    if (!record) {
      this.log.warn('未找到任务记录，无法记录反馈', { taskId });
      return;
    }
    record.userFeedback = feedback;
    this.log.info('用户反馈已记录', { taskId, feedback });
    this.saveDebounced();
  }

  // ========== 失败分析 ==========

  analyzeFailure(taskId: string): FailureAnalysis | null {
    const record = this.tasks.get(taskId);
    if (!record) {
      this.log.warn('未找到任务记录，无法分析失败', { taskId });
      return null;
    }

    // 找到第一个失败步骤作为主要失败点
    const failedStepIndices = record.steps
      .map((s, i) => (!s.success ? i : -1))
      .filter(i => i >= 0);

    if (failedStepIndices.length === 0) {
      return {
        taskId,
        rootCause: '任务标记为失败但所有步骤均成功，可能是业务逻辑判定失败',
        errorCategory: 'unknown',
        affectedSteps: [],
        suggestedFixes: FIX_TEMPLATES.unknown.map(f => ({ ...f, priority: 'medium' as const })),
        confidence: 0.3,
      };
    }

    const primaryStep = record.steps[failedStepIndices[0]];
    const errorCategory = primaryStep.errorCategory || this.categorizeError(primaryStep.error || '');
    const suggestedFixes = this.buildFixSuggestions(errorCategory, primaryStep);

    // 匹配已知失败模式
    const patternMatch = this.matchFailurePattern(errorCategory, primaryStep.toolName);

    // 计算置信度：有模式匹配时更高，有明确错误分类时更高
    let confidence = 0.5;
    if (errorCategory !== 'unknown') confidence += 0.2;
    if (patternMatch) confidence += 0.2;
    if (failedStepIndices.length === 1) confidence += 0.1;
    confidence = Math.min(confidence, 1.0);

    const rootCause = this.describeRootCause(errorCategory, primaryStep);

    return {
      taskId,
      rootCause,
      errorCategory,
      affectedSteps: failedStepIndices,
      suggestedFixes,
      patternMatch: patternMatch || undefined,
      confidence,
    };
  }

  // ========== 指标查询 ==========

  getMetrics(timeRange?: { start: number; end: number }): SuccessMetrics {
    let records = [...this.tasks.values()];

    if (timeRange) {
      records = records.filter(r => r.startTime >= timeRange.start && r.startTime <= timeRange.end);
    }

    const totalTasks = records.length;
    const successCount = records.filter(r => r.overallSuccess).length;
    const successRate = totalTasks > 0 ? successCount / totalTasks : 0;
    const averageDuration = totalTasks > 0
      ? records.reduce((sum, r) => sum + r.duration, 0) / totalTasks
      : 0;
    const averageScore = totalTasks > 0
      ? records.reduce((sum, r) => sum + r.successScore, 0) / totalTasks
      : 0;

    // 按领域聚合
    const byDomain: SuccessMetrics['byDomain'] = {};
    for (const r of records) {
      if (!byDomain[r.domain]) byDomain[r.domain] = { total: 0, successRate: 0, avgDuration: 0 };
      byDomain[r.domain].total++;
    }
    for (const r of records) {
      const d = byDomain[r.domain]!;
      if (r.overallSuccess) d.successRate++;
      d.avgDuration += r.duration;
    }
    for (const d of Object.values(byDomain)) {
      d.successRate = d.total > 0 ? d.successRate / d.total : 0;
      d.avgDuration = d.total > 0 ? d.avgDuration / d.total : 0;
    }

    // 按意图聚合
    const byIntent: SuccessMetrics['byIntent'] = {};
    for (const r of records) {
      if (!byIntent[r.intent]) byIntent[r.intent] = { total: 0, successRate: 0 };
      byIntent[r.intent].total++;
    }
    for (const r of records) {
      if (r.overallSuccess) byIntent[r.intent]!.successRate++;
    }
    for (const v of Object.values(byIntent)) {
      v.successRate = v.total > 0 ? v.successRate / v.total : 0;
    }

    // 按工具聚合
    const byTool: SuccessMetrics['byTool'] = {};
    for (const r of records) {
      for (const step of r.steps) {
        if (!byTool[step.toolName]) byTool[step.toolName] = { total: 0, successRate: 0, avgDuration: 0 };
        byTool[step.toolName].total++;
      }
    }
    for (const r of records) {
      for (const step of r.steps) {
        const t = byTool[step.toolName]!;
        if (step.success) t.successRate++;
        t.avgDuration += step.duration;
      }
    }
    for (const t of Object.values(byTool)) {
      t.successRate = t.total > 0 ? t.successRate / t.total : 0;
      t.avgDuration = t.total > 0 ? t.avgDuration / t.total : 0;
    }

    // 按复杂度聚合
    const byComplexity: SuccessMetrics['byComplexity'] = {};
    for (const r of records) {
      if (!byComplexity[r.complexity]) byComplexity[r.complexity] = { total: 0, successRate: 0 };
      byComplexity[r.complexity].total++;
    }
    for (const r of records) {
      if (r.overallSuccess) byComplexity[r.complexity]!.successRate++;
    }
    for (const v of Object.values(byComplexity)) {
      v.successRate = v.total > 0 ? v.successRate / v.total : 0;
    }

    // 趋势数据：按日聚合
    const trendData = this.aggregateTrendData(records);

    return {
      totalTasks,
      successRate,
      averageDuration,
      averageScore,
      byDomain,
      byIntent,
      byTool,
      byComplexity,
      topFailurePatterns: this.getFailurePatterns(),
      trendData,
    };
  }

  getFailurePatterns(): FailurePattern[] {
    return [...this.failurePatterns.values()]
      .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
      .slice(0, 10);
  }

  getOptimizationSuggestions(): string[] {
    const suggestions: string[] = [];
    const metrics = this.getMetrics();

    // 工具成功率 < 50%
    for (const [tool, data] of Object.entries(metrics.byTool)) {
      if (data.total >= 3 && data.successRate < 0.5) {
        suggestions.push(`工具 "${tool}" 成功率仅 ${(data.successRate * 100).toFixed(1)}%，建议审查其实现逻辑和参数校验`);
      }
    }

    // 领域成功率 < 70%
    for (const [domain, data] of Object.entries(metrics.byDomain)) {
      if (data.total >= 3 && data.successRate < 0.7) {
        suggestions.push(`领域 "${domain}" 成功率仅 ${(data.successRate * 100).toFixed(1)}%，建议增加领域专用工具或优化流程`);
      }
    }

    // 超时错误频繁
    const timeoutPattern = this.failurePatterns.get('tool_timeout');
    if (timeoutPattern && timeoutPattern.occurrenceCount >= 3) {
      suggestions.push(`超时错误已出现 ${timeoutPattern.occurrenceCount} 次，建议增加默认超时时间或添加重试逻辑`);
    }

    // 权限错误频繁
    const permPattern = this.failurePatterns.get('permission_denied');
    if (permPattern && permPattern.occurrenceCount >= 3) {
      suggestions.push(`权限错误已出现 ${permPattern.occurrenceCount} 次，建议调整权限策略或提前检查权限`);
    }

    // 特定意图总是失败
    for (const [intent, data] of Object.entries(metrics.byIntent)) {
      if (data.total >= 3 && data.successRate === 0) {
        suggestions.push(`意图 "${intent}" 从未成功过（${data.total} 次尝试），建议添加专用处理器`);
      }
    }

    if (suggestions.length === 0) {
      suggestions.push('当前各项指标表现良好，暂无紧急优化建议');
    }

    return suggestions;
  }

  categorizeError(error: string): ErrorCategory {
    if (!error) return 'unknown';
    const lower = error.toLowerCase();
    for (const rule of ERROR_RULES) {
      if (rule.patterns.some(p => lower.includes(p.toLowerCase()))) {
        return rule.category;
      }
    }
    return 'tool_error';
  }

  getSuccessRate(intent?: string, domain?: string): number {
    let records = [...this.tasks.values()];
    if (intent) records = records.filter(r => r.intent === intent);
    if (domain) records = records.filter(r => r.domain === domain);
    if (records.length === 0) return 0;
    return records.filter(r => r.overallSuccess).length / records.length;
  }

  // ========== 持久化 ==========

  private saveDebounced(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveSync();
    }, 2000);
  }
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  private saveSync(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });

      const recordsPath = path.join(this.dataDir, 'task-records.json');
      const records = [...this.tasks.values()].sort((a, b) => a.startTime - b.startTime);
      atomicWriteJsonSync(recordsPath, records);

      const patternsPath = path.join(this.dataDir, 'failure-patterns.json');
      const patterns = [...this.failurePatterns.values()];
      atomicWriteJsonSync(patternsPath, patterns);
    } catch (err: unknown) {
      this.log.error('保存指标数据失败', { error: err });
    }
  }

  private loadSync(): void {
    try {
      const recordsPath = path.join(this.dataDir, 'task-records.json');
      if (fs.existsSync(recordsPath)) {
        const raw = fs.readFileSync(recordsPath, 'utf-8');
        const records: TaskRecord[] = JSON.parse(raw);
        for (const r of records) {
          this.tasks.set(r.id, r);
        }
        this.log.info('已加载任务记录', { count: records.length });
      }

      const patternsPath = path.join(this.dataDir, 'failure-patterns.json');
      if (fs.existsSync(patternsPath)) {
        const raw = fs.readFileSync(patternsPath, 'utf-8');
        const patterns: FailurePattern[] = JSON.parse(raw);
        for (const p of patterns) {
          this.failurePatterns.set(p.name, p);
        }
        this.log.info('已加载失败模式', { count: patterns.length });
      }
    } catch (err: unknown) {
      this.log.warn('加载指标数据失败，使用空数据', { error: err });
    }
  }

  // ========== 私有方法 ==========

  private updateFailurePatterns(record: TaskRecord): void {
    for (const step of record.steps) {
      if (step.success || !step.errorCategory) continue;

      const patternKey = `${step.errorCategory}:${step.toolName}`;
      const existing = this.failurePatterns.get(patternKey);

      if (existing) {
        existing.occurrenceCount++;
        existing.lastSeen = record.endTime;
      } else {
        this.failurePatterns.set(patternKey, {
          name: patternKey,
          description: `工具 ${step.toolName} 出现 ${step.errorCategory} 错误`,
          occurrenceCount: 1,
          lastSeen: record.endTime,
          commonFixes: FIX_TEMPLATES[step.errorCategory].map(f => f.description),
        });
      }
    }
  }

  private matchFailurePattern(category: ErrorCategory, toolName: string): FailurePattern | null {
    const key = `${category}:${toolName}`;
    return this.failurePatterns.get(key) || null;
  }

  private buildFixSuggestions(category: ErrorCategory, _step: StepRecord): FixSuggestion[] {
    const templates = FIX_TEMPLATES[category] || FIX_TEMPLATES.unknown;
    return templates.map((t, i) => ({
      ...t,
      priority: (() => {
        if (i === 0) return 'high';
        if (i === 1) return 'medium';
        return 'low';
      })() as FixSuggestion['priority'],
    }));
  }

  private describeRootCause(category: ErrorCategory, step: StepRecord): string {
    const descriptions: Record<ErrorCategory, string> = {
      tool_not_found: `工具 "${step.toolName}" 未找到，可能未注册或未安装`,
      tool_timeout: `工具 "${step.toolName}" 执行超时（耗时 ${step.duration}ms）`,
      tool_error: `工具 "${step.toolName}" 执行出错：${step.error || '未知内部错误'}`,
      invalid_args: `工具 "${step.toolName}" 参数无效：${step.error || '参数校验失败'}`,
      permission_denied: `工具 "${step.toolName}" 权限不足：${step.error || '访问被拒绝'}`,
      network_error: `工具 "${step.toolName}" 网络错误：${step.error || '连接失败'}`,
      resource_not_found: `工具 "${step.toolName}" 目标资源不存在：${step.error || '资源未找到'}`,
      unknown: `工具 "${step.toolName}" 未知错误：${step.error || '无错误信息'}`,
    };
    return descriptions[category];
  }

  private aggregateTrendData(records: TaskRecord[]): Array<{ date: string; successRate: number; taskCount: number }> {
    const byDate = new Map<string, { total: number; success: number }>();

    for (const r of records) {
      const date = new Date(r.startTime).toISOString().split('T')[0];
      const entry = byDate.get(date) || { total: 0, success: 0 };
      entry.total++;
      if (r.overallSuccess) entry.success++;
      byDate.set(date, entry);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        successRate: data.total > 0 ? data.success / data.total : 0,
        taskCount: data.total,
      }));
  }
}

// ============ Agent Loop 工具定义 ============

export const metricsTools = [
  {
    name: 'metrics_success_rate',
    description: '获取任务成功率，可按意图和领域筛选',
    parameters: {
      type: 'object' as const,
      properties: {
        intent: { type: 'string', description: '按意图筛选（可选）' },
        domain: { type: 'string', description: '按领域筛选（可选）' },
      },
    },
  },
  {
    name: 'metrics_analyze_failure',
    description: '分析失败任务的根因和修复建议',
    parameters: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: '要分析的任务ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'metrics_suggestions',
    description: '获取基于失败模式的优化建议',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'metrics_report',
    description: '获取综合指标报告，包含成功率、趋势和失败模式',
    parameters: {
      type: 'object' as const,
      properties: {
        timeRangeStart: { type: 'number', description: '起始时间戳（可选）' },
        timeRangeEnd: { type: 'number', description: '结束时间戳（可选）' },
      },
    },
  },
];
