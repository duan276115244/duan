import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export interface Strategy {
  id: string;
  name: string;
  description: string;
  promptInjection: string;
  applicability: string[];
  successRate: number;
  useCount: number;
}

// ============ 错误类型策略映射类型 ============

/** 错误大类（与 self-healing-pipeline 保持一致） */
export type StrategyErrorCategory = 'network' | 'permission' | 'syntax' | 'resource' | 'logic' | 'unknown';

/** 错误类型到策略的映射 */
export interface ErrorStrategyMapping {
  /** 错误大类 */
  category: StrategyErrorCategory;
  /** 错误子类型（如 timeout、dns_error） */
  subType: string;
  /** 推荐策略ID列表（按优先级排序） */
  recommendedStrategyIds: string[];
  /** 策略升级链（失败后依次尝试） */
  escalationChain: string[];
}

/** 策略历史效果记录 */
export interface StrategyHistoryRecord {
  /** 策略ID */
  strategyId: string;
  /** 错误类型 */
  errorCategory: StrategyErrorCategory;
  /** 是否成功 */
  success: boolean;
  /** 使用时间戳 */
  timestamp: number;
  /** 耗时（毫秒） */
  duration: number;
}

export class StrategyEngine {
  private strategies: Strategy[];
  private currentIndex: number = 0;
  private failedStrategies: Set<string> = new Set();
  private dbPath: string;

  // ============ 错误类型策略映射 ============

  /** 错误子类型 → 策略映射 */
  private errorStrategyMappings: Map<string, ErrorStrategyMapping> = new Map();
  /** 策略历史效果记录（用于历史数据驱动选择） */
  private strategyHistory: StrategyHistoryRecord[] = [];
  /** 历史记录最大数量 */
  private static readonly MAX_HISTORY = 200;

  constructor() {
    this.dbPath = path.join(process.cwd(), '.awareness', 'strategy-stats.json');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.strategies = this.loadStrategies();
    this.loadStats();
    this.initializeErrorStrategyMappings();
  }

  /**
   * 初始化错误类型到策略的映射
   * 每种错误类型对应3-5种策略，按优先级排序，并定义升级链
   */
  private initializeErrorStrategyMappings(): void {
    // 网络错误类（5种策略）
    this.errorStrategyMappings.set('network:timeout', {
      category: 'network',
      subType: 'timeout',
      recommendedStrategyIds: ['incremental', 'try_alternatives', 'decompose', 'reflect_and_retry', 'search_first'],
      escalationChain: ['incremental', 'try_alternatives', 'decompose', 'reflect_and_retry', 'search_first'],
    });
    this.errorStrategyMappings.set('network:network_error', {
      category: 'network',
      subType: 'network_error',
      recommendedStrategyIds: ['try_alternatives', 'search_first', 'reflect_and_retry', 'incremental'],
      escalationChain: ['try_alternatives', 'search_first', 'reflect_and_retry', 'incremental'],
    });
    this.errorStrategyMappings.set('network:dns_error', {
      category: 'network',
      subType: 'dns_error',
      recommendedStrategyIds: ['try_alternatives', 'search_first', 'reflect_and_retry'],
      escalationChain: ['try_alternatives', 'search_first', 'reflect_and_retry'],
    });
    this.errorStrategyMappings.set('network:rate_limit', {
      category: 'network',
      subType: 'rate_limit',
      recommendedStrategyIds: ['incremental', 'try_alternatives', 'reflect_and_retry'],
      escalationChain: ['incremental', 'try_alternatives', 'reflect_and_retry'],
    });

    // 权限错误类（3种策略）
    this.errorStrategyMappings.set('permission:permission_denied', {
      category: 'permission',
      subType: 'permission_denied',
      recommendedStrategyIds: ['try_alternatives', 'search_first', 'reflect_and_retry'],
      escalationChain: ['try_alternatives', 'search_first', 'reflect_and_retry'],
    });
    this.errorStrategyMappings.set('permission:file_not_found', {
      category: 'permission',
      subType: 'file_not_found',
      recommendedStrategyIds: ['search_first', 'try_alternatives', 'reflect_and_retry'],
      escalationChain: ['search_first', 'try_alternatives', 'reflect_and_retry'],
    });

    // 语法错误类（3种策略）
    this.errorStrategyMappings.set('syntax:syntax_error', {
      category: 'syntax',
      subType: 'syntax_error',
      recommendedStrategyIds: ['reflect_and_retry', 'search_first', 'try_alternatives'],
      escalationChain: ['reflect_and_retry', 'search_first', 'try_alternatives'],
    });
    this.errorStrategyMappings.set('syntax:type_error', {
      category: 'syntax',
      subType: 'type_error',
      recommendedStrategyIds: ['reflect_and_retry', 'decompose', 'search_first'],
      escalationChain: ['reflect_and_retry', 'decompose', 'search_first'],
    });

    // 资源错误类（4种策略）
    this.errorStrategyMappings.set('resource:oom_error', {
      category: 'resource',
      subType: 'oom_error',
      recommendedStrategyIds: ['incremental', 'decompose', 'try_alternatives', 'reflect_and_retry'],
      escalationChain: ['incremental', 'decompose', 'try_alternatives', 'reflect_and_retry'],
    });
    this.errorStrategyMappings.set('resource:disk_full_error', {
      category: 'resource',
      subType: 'disk_full_error',
      recommendedStrategyIds: ['try_alternatives', 'search_first', 'reflect_and_retry', 'incremental'],
      escalationChain: ['try_alternatives', 'search_first', 'reflect_and_retry', 'incremental'],
    });

    // 逻辑错误类（3种策略）
    this.errorStrategyMappings.set('logic:assertion_error', {
      category: 'logic',
      subType: 'assertion_error',
      recommendedStrategyIds: ['reflect_and_retry', 'decompose', 'search_first'],
      escalationChain: ['reflect_and_retry', 'decompose', 'search_first'],
    });
  }

  /**
   * 对错误进行分类（5大类）
   * @param errorMessage 错误消息
   * @returns 错误大类
   */
  classifyError(errorMessage: string): StrategyErrorCategory {
    const msg = errorMessage.toLowerCase();

    // 网络错误类
    if (msg.includes('timeout') || msg.includes('超时') ||
        msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound') ||
        msg.includes('network') || msg.includes('dns') || msg.includes('429') || msg.includes('rate limit')) {
      return 'network';
    }

    // 权限错误类
    if (msg.includes('eacces') || msg.includes('permission denied') || msg.includes('forbidden') ||
        msg.includes('enoent') || msg.includes('not found') || msg.includes('权限')) {
      return 'permission';
    }

    // 语法错误类
    if (msg.includes('syntaxerror') || msg.includes('typeerror') || msg.includes('unexpected token') ||
        msg.includes('is not a function') || msg.includes('语法错误')) {
      return 'syntax';
    }

    // 资源错误类
    if (msg.includes('out of memory') || msg.includes('oom') || msg.includes('heap') ||
        msg.includes('enospc') || msg.includes('disk full') || msg.includes('内存不足') || msg.includes('磁盘')) {
      return 'resource';
    }

    // 逻辑错误类
    if (msg.includes('assertion') || msg.includes('assert') || msg.includes('validation failed') ||
        msg.includes('断言') || msg.includes('业务规则')) {
      return 'logic';
    }

    return 'unknown';
  }

  /**
   * 检测错误子类型
   */
  private detectErrorSubType(errorMessage: string): string {
    const msg = errorMessage.toLowerCase();

    // 网络类子类型
    if (msg.includes('timeout') || msg.includes('超时')) return 'timeout';
    if (msg.includes('enotfound') || msg.includes('dns')) return 'dns_error';
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('network')) return 'network_error';
    if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';

    // 权限类子类型
    if (msg.includes('eacces') || msg.includes('permission denied')) return 'permission_denied';
    if (msg.includes('enoent') || msg.includes('not found')) return 'file_not_found';

    // 语法类子类型
    if (msg.includes('syntaxerror') || msg.includes('unexpected token')) return 'syntax_error';
    if (msg.includes('typeerror') || msg.includes('is not a function')) return 'type_error';

    // 资源类子类型
    if (msg.includes('out of memory') || msg.includes('oom')) return 'oom_error';
    if (msg.includes('enospc') || msg.includes('disk full')) return 'disk_full_error';

    // 逻辑类子类型
    if (msg.includes('assertion') || msg.includes('validation failed')) return 'assertion_error';

    return 'unknown';
  }

  /**
   * 基于错误类型选择最优策略（历史数据驱动）
   *
   * 选择逻辑：
   * 1. 根据错误分类查找推荐策略列表
   * 2. 过滤掉已失败的策略
   * 3. 按历史成功率排序（成功率高的优先）
   * 4. 若无匹配，降级到通用策略选择
   *
   * @param errorMessage 错误消息
   * @returns 选中的策略，或 null（所有策略耗尽）
   */
  selectStrategyForError(errorMessage: string): Strategy | null {
    const category = this.classifyError(errorMessage);
    const subType = this.detectErrorSubType(errorMessage);
    const mappingKey = `${category}:${subType}`;

    const mapping = this.errorStrategyMappings.get(mappingKey);

    if (mapping) {
      // 按推荐顺序查找第一个未失败的策略
      for (const strategyId of mapping.recommendedStrategyIds) {
        if (this.failedStrategies.has(strategyId)) continue;

        // 基于历史数据调整优先级
        const strategy = this.strategies.find(s => s.id === strategyId);
        if (strategy) {
          // 查找该错误类型下该策略的历史成功率
          const historicalSuccessRate = this.getHistoricalSuccessRate(strategyId, category);
          // 如果历史成功率太低（<30%），跳过
          if (historicalSuccessRate !== null && historicalSuccessRate < 0.3) {
            continue;
          }
          return strategy;
        }
      }
    }

    // 降级到通用策略选择
    return this.switchStrategy({ error: errorMessage });
  }

  /**
   * 获取策略在特定错误类型下的历史成功率
   */
  private getHistoricalSuccessRate(strategyId: string, category: StrategyErrorCategory): number | null {
    const relevantRecords = this.strategyHistory.filter(
      r => r.strategyId === strategyId && r.errorCategory === category
    );

    if (relevantRecords.length < 3) {
      return null; // 样本不足，不作为决策依据
    }

    const successCount = relevantRecords.filter(r => r.success).length;
    return successCount / relevantRecords.length;
  }

  /**
   * 记录策略使用结果（用于历史数据驱动选择）
   */
  recordStrategyResult(
    strategyId: string,
    errorCategory: StrategyErrorCategory,
    success: boolean,
    duration: number,
  ): void {
    this.strategyHistory.push({
      strategyId,
      errorCategory,
      success,
      timestamp: Date.now(),
      duration,
    });

    // 限制历史记录数量
    if (this.strategyHistory.length > StrategyEngine.MAX_HISTORY) {
      this.strategyHistory = this.strategyHistory.slice(-StrategyEngine.MAX_HISTORY);
    }
  }

  /**
   * 获取错误类型策略映射
   */
  getErrorStrategyMapping(category: StrategyErrorCategory, subType: string): ErrorStrategyMapping | undefined {
    return this.errorStrategyMappings.get(`${category}:${subType}`);
  }

  /**
   * 获取策略历史统计
   */
  getStrategyHistoryStats(): Record<string, { total: number; success: number; successRate: number }> {
    const stats: Record<string, { total: number; success: number; successRate: number }> = {};

    for (const record of this.strategyHistory) {
      const key = `${record.errorCategory}:${record.strategyId}`;
      if (!stats[key]) {
        stats[key] = { total: 0, success: 0, successRate: 0 };
      }
      stats[key].total++;
      if (record.success) stats[key].success++;
    }

    for (const key of Object.keys(stats)) {
      stats[key].successRate = stats[key].total > 0 ? stats[key].success / stats[key].total : 0;
    }

    return stats;
  }

  private loadStrategies(): Strategy[] {
    return [
      {
        id: 'decompose',
        name: '分解法',
        description: '将复杂问题分解为多个简单的子问题，逐个解决',
        applicability: ['complex', 'large_scope', 'vague'],
        successRate: 0.8, useCount: 0,
        promptInjection: '当前策略：分解法。请将问题分解为多个独立的子问题，按优先级逐个解决。每个子问题完成后汇报进展。',
      },
      {
        id: 'search_first',
        name: '搜索法',
        description: '先搜索网络寻找现成解决方案或最佳实践',
        applicability: ['unknown', 'technical', 'error'],
        successRate: 0.75, useCount: 0,
        promptInjection: '当前策略：搜索法。先使用 web_search 搜索相关信息和最佳实践，基于搜索到的信息制定方案再执行。',
      },
      {
        id: 'try_alternatives',
        name: '工具替代法',
        description: '当前工具无法完成时，尝试不同的工具组合或方法',
        applicability: ['tool_failure', 'permission_denied', 'timeout'],
        successRate: 0.7, useCount: 0,
        promptInjection: '当前策略：工具替代法。之前的工具调用失败或不适用，请尝试完全不同的工具或方法来完成目标。例如用 file_write 代替直接修改，用 web_search 代替 API 调用。',
      },
      {
        id: 'incremental',
        name: '增量法',
        description: '先做一个最小可行版本，再逐步迭代改进',
        applicability: ['large_scope', 'complex', 'uncertain'],
        successRate: 0.85, useCount: 0,
        promptInjection: '当前策略：增量法。先实现最简单的可用版本，验证通过后再逐步添加功能和改进。每一步都要验证结果。',
      },
      {
        id: 'reverse',
        name: '逆向法',
        description: '从最终目标出发逆向推导需要的步骤',
        applicability: ['complex', 'planning', 'architecture'],
        successRate: 0.7, useCount: 0,
        promptInjection: '当前策略：逆向法。先明确最终结果应该是什么样，然后逆向推导需要哪些前置条件，一步步往回推直到当前状态。',
      },
      {
        id: 'analogy',
        name: '类比法',
        description: '寻找类似问题的解决方案，迁移应用到当前问题',
        applicability: ['novel', 'unique', 'creative'],
        successRate: 0.65, useCount: 0,
        promptInjection: '当前策略：类比法。思考是否有解决过的类似问题或已知的模式可以借鉴。搜索类似案例，将已有方案适配到当前场景。',
      },
      {
        id: 'divide_and_conquer',
        name: '分治法',
        description: '将大问题分割为独立的小问题，并行或串行解决',
        applicability: ['large_scope', 'modular', 'multi_step'],
        successRate: 0.8, useCount: 0,
        promptInjection: '当前策略：分治法。将大任务切分为多个独立的小任务，明确每个小任务的输入输出，按依赖关系依次执行。',
      },
      {
        id: 'reflect_and_retry',
        name: '反思重试法',
        description: '分析之前失败的原因，总结教训后重新尝试',
        applicability: ['error', 'failure', 'regression'],
        successRate: 0.6, useCount: 0,
        promptInjection: '当前策略：反思重试法。分析之前的失败原因：是工具用错了？参数不对？方法不对？总结教训后基于新的理解重新尝试。',
      },
    ];
  }

  private loadStats(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
      for (const s of this.strategies) {
        const saved = data[s.id];
        if (saved) { s.successRate = saved.successRate; s.useCount = saved.useCount; }
      }
    } catch {}
  }

  private saveStats(): void {
    const data: Record<string, { successRate: number; useCount: number }> = {};
    for (const s of this.strategies) data[s.id] = { successRate: s.successRate, useCount: s.useCount };
    atomicWriteJsonSync(this.dbPath, data);
  }

  getCurrentStrategy(): Strategy {
    return this.strategies[this.currentIndex];
  }

  getAvailableStrategies(): Strategy[] {
    return this.strategies.filter(s => !this.failedStrategies.has(s.id));
  }

  /** 最大循环检测：当所有策略都用完一遍后返回 null */
  private allStrategiesExhausted(): boolean {
    return this.failedStrategies.size >= this.strategies.length;
  }

  switchStrategy(context?: { error?: string; toolName?: string }): Strategy | null {
    if (this.allStrategiesExhausted()) {
      return null;
    }
    const available = this.getAvailableStrategies();
    if (available.length === 0) {
      return null;
    }

    const candidates = available.length > 0 ? available : this.strategies;
    let best = candidates[0];
    let bestScore = -1;

    for (const s of candidates) {
      if (this.failedStrategies.has(s.id)) continue;
      if (context?.error && !s.applicability.some(a => context.error?.toLowerCase().includes(a))) continue;
      if (context?.toolName && s.applicability.includes('tool_failure')) { best = s; break; }
      const score = s.successRate * (1 - s.useCount * 0.05);
      if (score > bestScore) { bestScore = score; best = s; }
    }

    this.currentIndex = this.strategies.indexOf(best);
    return best;
  }

  /** 所有策略是否已经用完 */
  isExhausted(): boolean {
    return this.allStrategiesExhausted();
  }

  getStrategyPrompt(context?: { error?: string; toolName?: string }): string {
    const strategy = this.switchStrategy(context);
    if (!strategy) return '【所有策略已用尽】请直接基于已有知识完成回答，不要再尝试新的工具调用。如果无法完成，请直接告诉用户。';
    this.failedStrategies.add(strategy.id);
    strategy.useCount++;
    this.saveStats();
    return strategy.promptInjection;
  }

  reportResult(success: boolean): void {
    const s = this.strategies[this.currentIndex];
    if (success) s.successRate = Math.min(1, s.successRate + 0.05);
    else s.successRate = Math.max(0.1, s.successRate - 0.05);
    this.saveStats();
  }

  reset(): void {
    this.currentIndex = 0;
    this.failedStrategies.clear();
  }

  getStats(): string {
    return this.strategies
      .sort((a, b) => b.successRate - a.successRate)
      .map(s => `  ${s.successRate > 0.7 ? '✅' : '⚠️'} ${s.name}: 成功率${(s.successRate * 100).toFixed(0)}% (已用${s.useCount}次)`)
      .join('\n');
  }
}
