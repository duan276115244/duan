/**
 * 工具集成效率优化器 — ToolIntegrationOptimizer
 *
 * 优化 API 集成架构，降低外部工具调用延迟，改善工具交互错误处理
 * 目标：工具调用延迟降低 30%+，缓存命中率 > 40%，错误恢复成功率 > 85%
 *
 * 核心能力：
 * 1. 调用优化 — 缓存命中检测、相似调用批处理、参数预校验
 * 2. 结果记录 — 追踪延迟、成功率、错误模式，构建工具性能画像
 * 3. 性能画像 — 平均延迟、P95/P99、成功率、错误类型分布、使用频率
 * 4. 优化建议 — 识别慢工具、推荐缓存策略、并行执行机会、替代工具
 * 5. 故障诊断 — 错误分类、重试策略、降级工具推荐
 * 6. Agent Loop 工具 — 通过 getToolDefinitions() 注册为可用工具
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './agent-loop-types.js';

// ============ 类型定义 ============

/** 工具性能画像 */
export interface ToolProfile {
  name: string;
  callCount: number;
  successRate: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  errorTypes: Record<string, number>;
  lastUsed: number;
  cacheHitRate: number;
  parallelizable: boolean;
}

/** 工具调用计划 */
export interface ToolCallPlan {
  toolName: string;
  args: Record<string, unknown>;
  cacheHit: boolean;
  batchGroup?: number;
  estimatedLatency: number;
  preValidated: boolean;
  warnings: string[];
}

/** 故障诊断结果 */
export interface FailureDiagnosis {
  errorType: 'timeout' | 'auth' | 'rate_limit' | 'invalid_input' | 'internal' | 'network' | 'unknown';
  severity: 'transient' | 'permanent' | 'degraded';
  retryStrategy: {
    shouldRetry: boolean;
    maxRetries: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
  fallbackTool?: string;
  rootCause: string;
  suggestedFix: string;
}

/** 优化建议 */
export interface ToolOptimizationSuggestion {
  toolName: string;
  type: 'cache' | 'parallel' | 'batch' | 'fallback' | 'prevalidate' | 'alternative';
  description: string;
  expectedImprovement: string;
  priority: 'high' | 'medium' | 'low';
}

// ============ 内部辅助类型 ============

/** 单次调用记录 */
interface _CallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  duration: number;
  success: boolean;
  timestamp: number;
}

/** 工具内部画像数据 */
interface InternalToolProfile {
  name: string;
  callCount: number;
  successCount: number;
  latencies: number[];          // 保留最近 N 条延迟记录
  errorTypes: Record<string, number>;
  lastUsed: number;
  cacheHits: number;
  cacheMisses: number;
  parallelizable: boolean;
  argSignatures: Set<string>;  // 已见过的参数签名，用于缓存判断
}

/** 缓存条目 */
interface CacheEntry {
  key: string;
  result: string;
  timestamp: number;
  hitCount: number;
}

// ============ 常量 ============

const MAX_LATENCY_RECORDS = 200;       // 每个工具最多保留的延迟记录数
const CACHE_TTL_MS = 5 * 60 * 1000;   // 缓存默认 TTL：5 分钟
const MAX_CACHE_ENTRIES = 500;         // 最大缓存条目数
const SLOW_TOOL_THRESHOLD_MS = 3000;   // 慢工具阈值：3 秒
const LOW_SUCCESS_RATE_THRESHOLD = 0.8; // 低成功率阈值：80%

// ============ 工具集成效率优化器 ============

export class ToolIntegrationOptimizer {
  private readonly log = logger.child({ module: 'ToolIntegrationOptimizer' });

  /** 工具内部画像映射 */
  private profiles = new Map<string, InternalToolProfile>();

  /** 调用结果缓存 */
  private cache = new Map<string, CacheEntry>();

  /** 批处理分组计数器 */
  private batchCounter = 0;

  /** 当前批处理分组映射（工具名 → 批组号） */
  private pendingBatches = new Map<string, number>();

  /** 总体统计 */
  private totalCalls = 0;
  private totalCacheHits = 0;
  private totalErrors = 0;

  /** 已知工具的替代方案映射 */
  private fallbackMap: Record<string, string[]> = {
    'web_search': ['web_fetch', 'knowledge_query'],
    'web_fetch': ['web_search', 'cache_lookup'],
    'file_read': ['cache_lookup'],
    'code_search': ['file_read', 'grep_search'],
    'grep_search': ['code_search'],
    'sql_query': ['cache_lookup'],
  };

  /** 已知可并行执行的工具列表 */
  private parallelizableTools = new Set([
    'web_search', 'file_read', 'code_search', 'grep_search',
    'cache_lookup', 'knowledge_query',
  ]);

  constructor() {
    this.log.info('工具集成效率优化器已初始化');
  }

  // ============ 核心方法 ============

  /**
   * 优化工具调用 — 在执行前生成优化计划
   * - 检查缓存命中
   * - 批处理相似调用
   * - 预校验参数
   * - 估算延迟
   */
  optimizeToolCall(toolName: string, args: Record<string, unknown>): ToolCallPlan {
    const startTime = Date.now();
    this.log.debug(`优化工具调用: ${toolName}`);

    const warnings: string[] = [];
    let cacheHit = false;
    let batchGroup: number | undefined;
    let estimatedLatency = 0;
    let preValidated = false;

    // 1. 检查缓存
    const cacheKey = this.buildCacheKey(toolName, args);
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      cacheHit = true;
      cached.hitCount++;
      this.totalCacheHits++;
      this.log.debug(`缓存命中: ${toolName}`);
    } else if (cached) {
      // 缓存过期，移除
      this.cache.delete(cacheKey);
    }

    // 2. 批处理分组 — 相同工具的连续调用归入同一批次
    if (!cacheHit && this.pendingBatches.has(toolName)) {
      batchGroup = this.pendingBatches.get(toolName);
    } else if (!cacheHit) {
      this.batchCounter++;
      batchGroup = this.batchCounter;
      this.pendingBatches.set(toolName, batchGroup);
      // 5 秒后自动清除批组
      setTimeout(() => this.pendingBatches.delete(toolName), 5000);
    }

    // 3. 参数预校验
    preValidated = this.preValidateArgs(toolName, args, warnings);

    // 4. 估算延迟
    const profile = this.profiles.get(toolName);
    if (profile && profile.latencies.length > 0) {
      estimatedLatency = this.percentile(profile.latencies, 50);
    } else {
      estimatedLatency = 1000; // 默认估算 1 秒
    }
    if (cacheHit) {
      estimatedLatency = Math.min(estimatedLatency, 5); // 缓存命中几乎零延迟
    }

    // 5. 延迟警告
    if (estimatedLatency > SLOW_TOOL_THRESHOLD_MS) {
      warnings.push(`工具 ${toolName} 预估延迟 ${estimatedLatency.toFixed(0)}ms 超过阈值 ${SLOW_TOOL_THRESHOLD_MS}ms`);
    }

    const plan: ToolCallPlan = {
      toolName,
      args,
      cacheHit,
      batchGroup,
      estimatedLatency,
      preValidated,
      warnings,
    };

    // 广播优化事件
    EventBus.getInstance().emitSync('tool.call_optimized', {
      toolName,
      cacheHit,
      batchGroup,
      estimatedLatency,
      preValidated,
      warnings: warnings.length,
    });

    const duration = Date.now() - startTime;
    this.log.debug(`工具调用优化完成: ${toolName}, 耗时 ${duration}ms, 缓存命中=${cacheHit}`);

    return plan;
  }

  /**
   * 记录工具执行结果 — 构建性能画像
   * - 追踪延迟、成功率、错误模式
   * - 更新缓存
   * - 返回洞察信息
   */
  recordToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    duration: number,
    success: boolean,
  ): string {
    this.totalCalls++;

    // 更新内部画像
    let profile = this.profiles.get(toolName);
    if (!profile) {
      profile = {
        name: toolName,
        callCount: 0,
        successCount: 0,
        latencies: [],
        errorTypes: {},
        lastUsed: Date.now(),
        cacheHits: 0,
        cacheMisses: 0,
        parallelizable: this.parallelizableTools.has(toolName),
        argSignatures: new Set(),
      };
      this.profiles.set(toolName, profile);
    }

    profile.callCount++;
    profile.lastUsed = Date.now();

    if (success) {
      profile.successCount++;
    } else {
      this.totalErrors++;
      // 从结果中提取错误类型
      const errorType = this.classifyErrorFromResult(result);
      profile.errorTypes[errorType] = (profile.errorTypes[errorType] || 0) + 1;
    }

    // 记录延迟
    profile.latencies.push(duration);
    if (profile.latencies.length > MAX_LATENCY_RECORDS) {
      profile.latencies.shift();
    }

    // 记录参数签名
    const argSig = this.buildCacheKey(toolName, args);
    profile.argSignatures.add(argSig);

    // 成功结果写入缓存
    if (success && result.length < 10000) {
      this.setCache(argSig, result);
      profile.cacheMisses++; // 这是新写入，算作 cache miss
    }

    // 清理过期的批组
    this.pendingBatches.delete(toolName);

    // 生成洞察
    const insights = this.generateInsights(profile, duration, success);

    // 广播结果记录事件
    EventBus.getInstance().emitSync('tool.result_recorded', {
      toolName,
      success,
      duration,
      callCount: profile.callCount,
      successRate: profile.callCount > 0 ? profile.successCount / profile.callCount : 0,
    });

    this.log.debug(`工具结果已记录: ${toolName}, 成功=${success}, 耗时=${duration}ms`);

    return insights;
  }

  /**
   * 获取工具性能画像
   */
  getToolProfile(toolName: string): ToolProfile | null {
    const internal = this.profiles.get(toolName);
    if (!internal) {
      return null;
    }

    const latencies = internal.latencies;
    const totalCacheOps = internal.cacheHits + internal.cacheMisses;

    return {
      name: internal.name,
      callCount: internal.callCount,
      successRate: internal.callCount > 0 ? internal.successCount / internal.callCount : 0,
      avgLatency: latencies.length > 0 ? this.average(latencies) : 0,
      p95Latency: latencies.length > 0 ? this.percentile(latencies, 95) : 0,
      p99Latency: latencies.length > 0 ? this.percentile(latencies, 99) : 0,
      errorTypes: { ...internal.errorTypes },
      lastUsed: internal.lastUsed,
      cacheHitRate: totalCacheOps > 0 ? internal.cacheHits / totalCacheOps : 0,
      parallelizable: internal.parallelizable,
    };
  }

  /**
   * 建议工具集成优化方案
   */
  suggestOptimizations(): ToolOptimizationSuggestion[] {
    const suggestions: ToolOptimizationSuggestion[] = [];

    for (const [toolName, profile] of this.profiles) {
      // 1. 慢工具 → 缓存建议
      const avgLatency = profile.latencies.length > 0 ? this.average(profile.latencies) : 0;
      if (avgLatency > SLOW_TOOL_THRESHOLD_MS) {
        suggestions.push({
          toolName,
          type: 'cache',
          description: `工具 ${toolName} 平均延迟 ${avgLatency.toFixed(0)}ms，建议启用结果缓存以减少重复调用`,
          expectedImprovement: `预计减少 ${Math.min(40, Math.round(avgLatency / 100))}% 重复调用延迟`,
          priority: 'high',
        });
      }

      // 2. 低成功率 → 降级/替代建议
      const successRate = profile.callCount > 0 ? profile.successCount / profile.callCount : 1;
      if (successRate < LOW_SUCCESS_RATE_THRESHOLD && profile.callCount >= 3) {
        const fallbacks = this.fallbackMap[toolName] || [];
        if (fallbacks.length > 0) {
          suggestions.push({
            toolName,
            type: 'fallback',
            description: `工具 ${toolName} 成功率仅 ${(successRate * 100).toFixed(1)}%，建议配置降级工具: ${fallbacks.join(', ')}`,
            expectedImprovement: `预计提升可用性至 ${Math.min(99, Math.round(successRate * 100 + 15))}%`,
            priority: 'high',
          });
        }
        suggestions.push({
          toolName,
          type: 'prevalidate',
          description: `工具 ${toolName} 成率低，建议增加参数预校验以减少无效调用`,
          expectedImprovement: `预计减少 ${(1 - successRate) * 50 | 0}% 无效调用`,
          priority: 'medium',
        });
      }

      // 3. 高频调用 → 批处理建议
      if (profile.callCount > 10 && !this.pendingBatches.has(toolName)) {
        suggestions.push({
          toolName,
          type: 'batch',
          description: `工具 ${toolName} 已调用 ${profile.callCount} 次，建议启用批处理以合并相似调用`,
          expectedImprovement: '预计减少 20-30% 调用次数',
          priority: 'medium',
        });
      }

      // 4. 可并行工具 → 并行执行建议
      if (profile.parallelizable && profile.callCount > 5) {
        suggestions.push({
          toolName,
          type: 'parallel',
          description: `工具 ${toolName} 支持并行执行，建议在 Agent Loop 中与其他只读工具并行调用`,
          expectedImprovement: '预计减少 40-60% 总等待时间',
          priority: 'medium',
        });
      }

      // 5. 高错误率特定类型 → 替代工具建议
      const topError = this.getTopErrorType(profile.errorTypes);
      if (topError && profile.errorTypes[topError] >= 3) {
        const alternatives = this.fallbackMap[toolName] || [];
        if (alternatives.length > 0) {
          suggestions.push({
            toolName,
            type: 'alternative',
            description: `工具 ${toolName} 频繁出现 ${topError} 错误 (${profile.errorTypes[topError]} 次)，建议使用替代工具: ${alternatives.join(', ')}`,
            expectedImprovement: `预计规避 ${topError} 类错误`,
            priority: 'low',
          });
        }
      }
    }

    // 按优先级排序
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // 广播优化建议事件
    if (suggestions.length > 0) {
      EventBus.getInstance().emitSync('tool.optimization_suggested', {
        count: suggestions.length,
        highPriority: suggestions.filter(s => s.priority === 'high').length,
      });
    }

    this.log.info(`生成 ${suggestions.length} 条优化建议`);
    return suggestions;
  }

  /**
   * 诊断工具故障
   */
  diagnoseFailure(toolName: string, error: string): FailureDiagnosis {
    const errorType = this.classifyError(error);
    const severity = this.classifySeverity(errorType);
    const retryStrategy = this.buildRetryStrategy(errorType);
    const fallbacks = this.fallbackMap[toolName] || [];
    const fallbackTool = fallbacks.length > 0 ? fallbacks[0] : undefined;

    let rootCause: string;
    let suggestedFix: string;

    switch (errorType) {
      case 'timeout':
        rootCause = '工具响应超时，可能是网络延迟或服务端处理缓慢';
        suggestedFix = '增加超时阈值、启用缓存、或使用降级工具';
        break;
      case 'auth':
        rootCause = '认证失败，可能是凭证过期或权限不足';
        suggestedFix = '检查并更新 API 密钥或访问令牌';
        break;
      case 'rate_limit':
        rootCause = '触发速率限制，请求频率超过 API 配额';
        suggestedFix = '降低请求频率、启用请求队列、或使用多个 API Key 轮换';
        break;
      case 'invalid_input':
        rootCause = '输入参数无效，可能是格式错误或缺少必填字段';
        suggestedFix = '检查参数格式和完整性，启用参数预校验';
        break;
      case 'network':
        rootCause = '网络连接异常，可能是 DNS 解析失败或连接被拒绝';
        suggestedFix = '检查网络连接、配置代理、或使用降级工具';
        break;
      case 'internal':
        rootCause = '工具内部错误，可能是服务端 Bug 或资源不足';
        suggestedFix = '稍后重试，如持续失败则使用降级工具';
        break;
      default:
        rootCause = '未知错误类型';
        suggestedFix = '收集更多错误信息，检查工具文档';
    }

    const diagnosis: FailureDiagnosis = {
      errorType,
      severity,
      retryStrategy,
      fallbackTool,
      rootCause,
      suggestedFix,
    };

    // 广播故障诊断事件
    EventBus.getInstance().emitSync('tool.failure_diagnosed', {
      toolName,
      errorType,
      severity,
      shouldRetry: retryStrategy.shouldRetry,
    });

    this.log.info(`故障诊断完成: ${toolName}, 错误类型=${errorType}, 严重程度=${severity}`);

    return diagnosis;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalCalls: number;
    totalCacheHits: number;
    totalErrors: number;
    cacheHitRate: number;
    errorRate: number;
    profiledTools: number;
    cacheSize: number;
    pendingBatches: number;
  } {
    return {
      totalCalls: this.totalCalls,
      totalCacheHits: this.totalCacheHits,
      totalErrors: this.totalErrors,
      cacheHitRate: this.totalCalls > 0 ? this.totalCacheHits / this.totalCalls : 0,
      errorRate: this.totalCalls > 0 ? this.totalErrors / this.totalCalls : 0,
      profiledTools: this.profiles.size,
      cacheSize: this.cache.size,
      pendingBatches: this.pendingBatches.size,
    };
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const optimizer = this;

    return [
      {
        name: 'tool_optimize',
        description: '优化工具调用计划。在执行工具调用前，检查缓存命中、批处理分组、参数预校验，返回优化后的调用计划。可减少重复调用和无效请求。',
        parameters: {
          tool_name: {
            type: 'string',
            description: '要优化的工具名称',
            required: true,
          },
          args: {
            type: 'string',
            description: '工具调用参数，JSON 格式，如 {"query": "hello"}',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const toolName = args.tool_name as string;
            let toolArgs: Record<string, unknown>;
            try {
              toolArgs = JSON.parse(args.args as string);
            } catch {
              return Promise.resolve('❌ 参数 args 不是有效的 JSON 格式');
            }

            const plan = optimizer.optimizeToolCall(toolName, toolArgs);

            const lines: string[] = [];
            lines.push(`📋 工具调用优化计划: ${plan.toolName}`);
            lines.push(`   缓存命中: ${plan.cacheHit ? '✅ 是' : '❌ 否'}`);
            if (plan.batchGroup !== undefined) {
              lines.push(`   批处理分组: #${plan.batchGroup}`);
            }
            lines.push(`   预估延迟: ${plan.estimatedLatency.toFixed(0)}ms`);
            lines.push(`   参数预校验: ${plan.preValidated ? '✅ 通过' : '⚠️ 有问题'}`);
            if (plan.warnings.length > 0) {
              lines.push(`   警告:`);
              for (const w of plan.warnings) {
                lines.push(`     - ${w}`);
              }
            }

            if (plan.cacheHit) {
              const cacheKey = optimizer.buildCacheKey(toolName, toolArgs);
              const cached = optimizer.getCache(cacheKey);
              if (cached) {
                lines.push(`   缓存结果: ${cached.substring(0, 200)}${cached.length > 200 ? '...' : ''}`);
              }
            }

            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 优化工具调用失败: ${msg}`);
          }
        },
      },
      {
        name: 'tool_profile',
        description: '获取工具性能画像。包含调用次数、成功率、平均延迟、P95/P99延迟、错误类型分布、缓存命中率等指标。',
        parameters: {
          tool_name: {
            type: 'string',
            description: '工具名称',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const toolName = args.tool_name as string;
            const profile = optimizer.getToolProfile(toolName);

            if (!profile) {
              return Promise.resolve(`⚠️ 工具 "${toolName}" 暂无性能数据`);
            }

            const lines: string[] = [];
            lines.push(`📊 工具性能画像: ${profile.name}`);
            lines.push(`   调用次数: ${profile.callCount}`);
            lines.push(`   成功率: ${(profile.successRate * 100).toFixed(1)}%`);
            lines.push(`   平均延迟: ${profile.avgLatency.toFixed(0)}ms`);
            lines.push(`   P95 延迟: ${profile.p95Latency.toFixed(0)}ms`);
            lines.push(`   P99 延迟: ${profile.p99Latency.toFixed(0)}ms`);
            lines.push(`   缓存命中率: ${(profile.cacheHitRate * 100).toFixed(1)}%`);
            lines.push(`   可并行: ${profile.parallelizable ? '✅ 是' : '❌ 否'}`);
            lines.push(`   最后使用: ${new Date(profile.lastUsed).toLocaleString('zh-CN')}`);

            const errorTypes = Object.entries(profile.errorTypes);
            if (errorTypes.length > 0) {
              lines.push(`   错误类型分布:`);
              for (const [type, count] of errorTypes) {
                lines.push(`     - ${type}: ${count} 次`);
              }
            }

            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 获取工具画像失败: ${msg}`);
          }
        },
      },
      {
        name: 'tool_diagnose',
        description: '诊断工具调用故障。分类错误类型（超时/认证/限流/输入无效/内部错误），提供重试策略和降级工具建议。',
        parameters: {
          tool_name: {
            type: 'string',
            description: '出故障的工具名称',
            required: true,
          },
          error: {
            type: 'string',
            description: '错误信息',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const toolName = args.tool_name as string;
            const error = args.error as string;

            const diagnosis = optimizer.diagnoseFailure(toolName, error);

            const lines: string[] = [];
            lines.push(`🔍 故障诊断: ${toolName}`);
            lines.push(`   错误类型: ${diagnosis.errorType}`);
            lines.push(`   严重程度: ${diagnosis.severity}`);
            lines.push(`   根因分析: ${diagnosis.rootCause}`);
            lines.push(`   修复建议: ${diagnosis.suggestedFix}`);

            lines.push(`   重试策略:`);
            lines.push(`     是否重试: ${diagnosis.retryStrategy.shouldRetry ? '✅ 是' : '❌ 否'}`);
            if (diagnosis.retryStrategy.shouldRetry) {
              lines.push(`     最大重试: ${diagnosis.retryStrategy.maxRetries} 次`);
              lines.push(`     初始退避: ${diagnosis.retryStrategy.backoffMs}ms`);
              lines.push(`     退避倍数: ${diagnosis.retryStrategy.backoffMultiplier}x`);
            }

            if (diagnosis.fallbackTool) {
              lines.push(`   降级工具: ${diagnosis.fallbackTool}`);
            }

            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 诊断故障失败: ${msg}`);
          }
        },
      },
      {
        name: 'tool_suggest',
        description: '获取工具集成优化建议。识别慢工具、推荐缓存策略、并行执行机会、批处理方案和替代工具。',
        parameters: {
          filter: {
            type: 'string',
            description: '过滤建议类型: cache/parallel/batch/fallback/prevalidate/alternative，留空显示全部',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const filter = args.filter as string | undefined;
            let suggestions = optimizer.suggestOptimizations();

            if (filter) {
              suggestions = suggestions.filter(s => s.type === filter);
            }

            if (suggestions.length === 0) {
              return Promise.resolve(filter
                ? `⚠️ 没有类型为 "${filter}" 的优化建议`
                : '✅ 当前工具集成状态良好，暂无优化建议');
            }

            const lines: string[] = [];
            lines.push(`💡 工具集成优化建议 (${suggestions.length} 条):`);

            const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
            const typeLabel: Record<string, string> = {
              cache: '缓存',
              parallel: '并行',
              batch: '批处理',
              fallback: '降级',
              prevalidate: '预校验',
              alternative: '替代',
            };

            for (const s of suggestions) {
              lines.push('');
              lines.push(`  ${priorityEmoji[s.priority]} [${typeLabel[s.type] || s.type}] ${s.toolName}`);
              lines.push(`     ${s.description}`);
              lines.push(`     预期收益: ${s.expectedImprovement}`);
            }

            // 附加统计
            const stats = optimizer.getStats();
            lines.push('');
            lines.push(`📈 总体统计:`);
            lines.push(`   总调用: ${stats.totalCalls}  缓存命中: ${(stats.cacheHitRate * 100).toFixed(1)}%  错误率: ${(stats.errorRate * 100).toFixed(1)}%`);
            lines.push(`   已画像工具: ${stats.profiledTools}  缓存条目: ${stats.cacheSize}  待处理批次: ${stats.pendingBatches}`);

            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 获取优化建议失败: ${msg}`);
          }
        },
      },
    ];
  }

  // ============ 私有方法 ============

  /** 构建缓存键 */
  private buildCacheKey(toolName: string, args: Record<string, unknown>): string {
    try {
      const sortedArgs = Object.keys(args)
        .sort()
        .map(k => `${k}=${JSON.stringify(args[k])}`)
        .join('&');
      return `${toolName}:${sortedArgs}`;
    } catch {
      return `${toolName}:${JSON.stringify(args)}`;
    }
  }

  /** 设置缓存 */
  private setCache(key: string, result: string): void {
    // 容量控制 — 超限时移除最旧条目
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      key,
      result,
      timestamp: Date.now(),
      hitCount: 0,
    });
  }

  /** 获取缓存 */
  private getCache(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    entry.hitCount++;
    return entry.result;
  }

  /** 参数预校验 */
  private preValidateArgs(
    toolName: string,
    args: Record<string, unknown>,
    warnings: string[],
  ): boolean {
    let valid = true;

    // 检查空参数
    if (!args || Object.keys(args).length === 0) {
      warnings.push(`工具 ${toolName} 调用参数为空`);
      // 不标记为无效，某些工具可能不需要参数
    }

    // 检查参数值是否为 undefined/null
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) {
        warnings.push(`参数 "${key}" 值为 ${value}，可能导致工具执行异常`);
        valid = false;
      }
      // 检查字符串参数是否为空
      if (typeof value === 'string' && value.trim().length === 0) {
        warnings.push(`参数 "${key}" 为空字符串`);
        valid = false;
      }
    }

    // 检查已知工具的特定参数
    if (toolName === 'web_search' || toolName === 'web_fetch') {
      if (!args.query && !args.url && !args.keyword) {
        warnings.push('搜索/抓取工具缺少 query/url/keyword 参数');
        valid = false;
      }
    }

    return valid;
  }

  /** 从错误信息分类错误类型 */
  private classifyError(error: string): FailureDiagnosis['errorType'] {
    const lower = error.toLowerCase();

    if (/timeout|timed?\s*out|deadline\s*exceeded/i.test(lower)) return 'timeout';
    if (/auth|unauthorized|forbidden|invalid\s*(api|key|token|credential)|401|403/i.test(lower)) return 'auth';
    if (/rate\s*limit|too\s*many\s*request|quota|429|throttl/i.test(lower)) return 'rate_limit';
    if (/invalid\s*input|bad\s*request|missing\s*(param|arg|field|required)|400|validation/i.test(lower)) return 'invalid_input';
    if (/network|dns|econnrefused|econnreset|enotfound|socket\s*hang/i.test(lower)) return 'network';
    if (/internal\s*error|server\s*error|500|502|503|504|crash/i.test(lower)) return 'internal';

    return 'unknown';
  }

  /** 从结果中分类错误（用于 recordToolResult） */
  private classifyErrorFromResult(result: string): string {
    const lower = result.toLowerCase();

    if (/timeout|超时/i.test(lower)) return 'timeout';
    if (/auth|认证|权限|unauthorized|forbidden/i.test(lower)) return 'auth';
    if (/rate\s*limit|限流|频率限制/i.test(lower)) return 'rate_limit';
    if (/invalid|无效|参数错误|bad\s*request/i.test(lower)) return 'invalid_input';
    if (/network|网络|连接/i.test(lower)) return 'network';
    if (/internal|内部错误|server\s*error/i.test(lower)) return 'internal';

    return 'unknown';
  }

  /** 分类严重程度 */
  private classifySeverity(errorType: FailureDiagnosis['errorType']): FailureDiagnosis['severity'] {
    switch (errorType) {
      case 'timeout':
      case 'rate_limit':
      case 'network':
        return 'transient'; // 暂时性错误，可恢复
      case 'auth':
      case 'invalid_input':
        return 'permanent'; // 持久性错误，需人工干预
      case 'internal':
        return 'degraded';  // 降级状态，部分可用
      default:
        return 'transient';
    }
  }

  /** 构建重试策略 */
  private buildRetryStrategy(errorType: FailureDiagnosis['errorType']): FailureDiagnosis['retryStrategy'] {
    switch (errorType) {
      case 'timeout':
        return {
          shouldRetry: true,
          maxRetries: 3,
          backoffMs: 1000,
          backoffMultiplier: 2,
        };
      case 'rate_limit':
        return {
          shouldRetry: true,
          maxRetries: 5,
          backoffMs: 2000,
          backoffMultiplier: 2,
        };
      case 'network':
        return {
          shouldRetry: true,
          maxRetries: 3,
          backoffMs: 500,
          backoffMultiplier: 1.5,
        };
      case 'internal':
        return {
          shouldRetry: true,
          maxRetries: 2,
          backoffMs: 3000,
          backoffMultiplier: 2,
        };
      case 'auth':
      case 'invalid_input':
        return {
          shouldRetry: false,
          maxRetries: 0,
          backoffMs: 0,
          backoffMultiplier: 1,
        };
      default:
        return {
          shouldRetry: true,
          maxRetries: 1,
          backoffMs: 1000,
          backoffMultiplier: 2,
        };
    }
  }

  /** 生成洞察信息 */
  private generateInsights(profile: InternalToolProfile, duration: number, success: boolean): string {
    const lines: string[] = [];

    if (!success) {
      lines.push(`⚠️ 工具 ${profile.name} 执行失败 (耗时 ${duration}ms)`);
    } else if (duration > SLOW_TOOL_THRESHOLD_MS) {
      lines.push(`🐌 工具 ${profile.name} 执行缓慢 (${duration}ms > ${SLOW_TOOL_THRESHOLD_MS}ms 阈值)`);
    } else {
      lines.push(`✅ 工具 ${profile.name} 执行完成 (${duration}ms)`);
    }

    const successRate = profile.callCount > 0 ? profile.successCount / profile.callCount : 0;
    if (profile.callCount >= 5 && successRate < LOW_SUCCESS_RATE_THRESHOLD) {
      lines.push(`   📉 成功率偏低: ${(successRate * 100).toFixed(1)}% (共 ${profile.callCount} 次调用)`);
    }

    const avgLatency = profile.latencies.length > 0 ? this.average(profile.latencies) : 0;
    if (avgLatency > SLOW_TOOL_THRESHOLD_MS) {
      lines.push(`   📊 平均延迟偏高: ${avgLatency.toFixed(0)}ms`);
    }

    return lines.join('\n');
  }

  /** 获取最高频错误类型 */
  private getTopErrorType(errorTypes: Record<string, number>): string | null {
    let topType: string | null = null;
    let topCount = 0;
    for (const [type, count] of Object.entries(errorTypes)) {
      if (count > topCount) {
        topCount = count;
        topType = type;
      }
    }
    return topType;
  }

  /** 计算平均值 */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /** 计算百分位数 */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
