/**
 * ToolConsolidation — 工具精简与质量评估系统（增强版）
 *
 * 审计所有已注册工具的：使用频率、成功率、平均耗时、重叠度。
 * 推荐合并/废弃/保留决策，实现 47+ → ~20 的优化目标。
 * 基于任务动态选择最合适的工具子集。
 *
 * 增强项：
 * 1. 多维度语义重叠（描述 + 参数 + 行为）三维加权
 * 2. 合并前冲突检测（参数名冲突、类型不兼容、返回格式不一致）
 * 3. 多样化合并策略（alias/wrapper/proxy/federate/deprecate）+ 实际执行
 * 4. 内部埋点 recordUsage() + 时间衰减评分
 * 5. 基于 usage 历史自动聚类生成 Profile
 */

import { logger } from './structured-logger.js';
import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedToolDef } from './unified-tool-def.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface ToolAuditRecord {
  name: string;
  usageCount: number;
  successRate: number;
  avgDurationMs: number;
  category: string;
  overlappingTools: string[];
  /** 综合重叠度（三维加权） */
  overlapScore: number;
  /** 描述重叠度 */
  descriptionOverlap: number;
  /** 参数重叠度 */
  parameterOverlap: number;
  /** 行为重叠度 */
  behavioralOverlap: number;
  qualityScore: number;
  /** 时间衰减后的质量评分 */
  decayedQualityScore: number;
  recommendation: 'keep' | 'merge' | 'deprecate' | 'remove';
  recommendationReason: string;
  lastUsed: number | null;
  frequencyRank: number;
}

/** 合并策略类型 */
export type MergeStrategy = 'alias' | 'wrapper' | 'proxy' | 'federate' | 'deprecate';

/** 合并冲突信息 */
export interface MergeConflict {
  type: 'param_name' | 'param_type' | 'return_format' | 'category_mismatch';
  description: string;
  severity: 'warning' | 'error';
}

export interface MergeSuggestion {
  tools: string[];
  targetTool: string;
  reason: string;
  impact: 'low' | 'medium' | 'high';
  /** 合并策略 */
  strategy: MergeStrategy;
  /** 冲突检测结果 */
  conflicts: MergeConflict[];
  /** 是否可安全执行（无 error 级冲突） */
  safe: boolean;
}

export interface ToolSelectionProfile {
  taskType: string;
  enabledTools: string[];
  priorityTools: string[];
}

/** 工具使用埋点记录 */
interface UsageRecord {
  toolName: string;
  timestamp: number;
  success: boolean;
  durationMs: number;
  taskType?: string;
}

/** 合并执行结果 */
export interface MergeExecutionResult {
  success: boolean;
  targetTool: string;
  mergedTools: string[];
  strategy: MergeStrategy;
  appliedAt: number;
  error?: string;
}

export class ToolConsolidation {
  private auditRecords: Map<string, ToolAuditRecord> = new Map();
  private mergeSuggestions: MergeSuggestion[] = [];
  private profiles: ToolSelectionProfile[] = [];
  /** 内部埋点：工具使用历史 */
  private usageHistory: UsageRecord[] = [];
  /** 埋点历史最大保留数 */
  private readonly MAX_USAGE_HISTORY = 10_000;
  /** 已执行的合并记录 */
  private executedMerges: MergeExecutionResult[] = [];
  /** 别名映射：被合并工具 → 目标工具 */
  private aliasMap: Map<string, string> = new Map();
  private persistPath: string;
  private log = logger.child({ module: 'ToolConsolidation' });
  /** 时间衰减半周期（毫秒），默认 30 天 */
  private readonly DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(persistDir?: string) {
    this.persistPath = path.join(persistDir || duanPath(), 'tool-consolidation.json');
    this.initDefaultProfiles();
    this.load();
  }

  /** 审计所有工具 */
  audit(tools: UnifiedToolDef[]): ToolAuditRecord[] {
    const categoryGroups = this.groupByCategory(tools);
    this.auditRecords.clear();
    this.mergeSuggestions = [];

    // 为每个工具生成审计记录
    for (const tool of tools) {
      const sameCategory = categoryGroups.get(tool.category || 'general') || [];
      const overlapping: Array<{ tool: UnifiedToolDef; overlap: number; desc: number; param: number; beh: number }> = [];
      for (const t of sameCategory) {
        if (t.name === tool.name) continue;
        const desc = this.descriptionOverlap(tool, t);
        const param = this.parameterOverlap(tool, t);
        const beh = this.behavioralOverlap(tool, t);
        const combined = desc * 0.3 + param * 0.4 + beh * 0.3;
        if (combined > 0.3) {
          overlapping.push({ tool: t, overlap: combined, desc, param, beh });
        }
      }
      const overlapScore = overlapping.length > 0
        ? overlapping.reduce((s, o) => s + o.overlap, 0) / overlapping.length
        : 0;
      const avgDesc = overlapping.length > 0 ? overlapping.reduce((s, o) => s + o.desc, 0) / overlapping.length : 0;
      const avgParam = overlapping.length > 0 ? overlapping.reduce((s, o) => s + o.param, 0) / overlapping.length : 0;
      const avgBeh = overlapping.length > 0 ? overlapping.reduce((s, o) => s + o.beh, 0) / overlapping.length : 0;

      const usageCount = (tool as { usageCount?: number }).usageCount || 0;
      const successRate = (tool as { successRate?: number }).successRate || 1;
      const qualityScore = this.calculateQualityScore(tool, usageCount, successRate);
      const decayedQualityScore = this.applyTimeDecay(qualityScore, (tool as { lastUsed?: number | null }).lastUsed || null);

      const record: ToolAuditRecord = {
        name: tool.name,
        usageCount,
        successRate,
        avgDurationMs: (tool as { avgDurationMs?: number }).avgDurationMs || 0,
        category: tool.category || 'general',
        overlappingTools: overlapping.map(o => o.tool.name),
        overlapScore,
        descriptionOverlap: avgDesc,
        parameterOverlap: avgParam,
        behavioralOverlap: avgBeh,
        qualityScore,
        decayedQualityScore,
        recommendation: this.generateRecommendation(decayedQualityScore, overlapScore, usageCount),
        recommendationReason: this.generateReason(decayedQualityScore, overlapScore, usageCount),
        lastUsed: (tool as { lastUsed?: number | null }).lastUsed || null,
        frequencyRank: 0,
      };

      this.auditRecords.set(tool.name, record);
    }

    // 计算频率排名
    const sorted = [...this.auditRecords.values()].sort((a, b) => b.usageCount - a.usageCount);
    sorted.forEach((r, i) => {
      const record = this.auditRecords.get(r.name);
      if (record) record.frequencyRank = i + 1;
    });

    // 生成合并建议
    this.generateMergeSuggestions(tools);

    this.save();
    return [...this.auditRecords.values()].sort((a, b) => a.decayedQualityScore - b.decayedQualityScore);
  }

  /** 获取审计摘要 */
  getSummary(): { total: number; toKeep: number; toMerge: number; toDeprecate: number; toRemove: number; suggestions: MergeSuggestion[] } {
    const records = [...this.auditRecords.values()];
    return {
      total: records.length,
      toKeep: records.filter(r => r.recommendation === 'keep').length,
      toMerge: records.filter(r => r.recommendation === 'merge').length,
      toDeprecate: records.filter(r => r.recommendation === 'deprecate').length,
      toRemove: records.filter(r => r.recommendation === 'remove').length,
      suggestions: this.mergeSuggestions,
    };
  }

  /** 获取特定工具的审计 */
  getToolAudit(name: string): ToolAuditRecord | undefined {
    return this.auditRecords.get(name);
  }

  /**
   * 记录工具使用情况（内部埋点）
   * @param toolName 工具名
   * @param success 是否成功
   * @param durationMs 耗时（毫秒）
   * @param taskType 任务类型（用于自适应 Profile 聚类）
   */
  recordUsage(toolName: string, success: boolean, durationMs: number, taskType?: string): void {
    this.usageHistory.push({
      toolName,
      timestamp: Date.now(),
      success,
      durationMs,
      taskType,
    });
    // 超过上限时丢弃最旧记录
    if (this.usageHistory.length > this.MAX_USAGE_HISTORY) {
      this.usageHistory.shift();
    }
  }

  /**
   * 执行合并建议
   * @param suggestion 合并建议
   * @param tools 当前工具列表（用于实际操作）
   * @returns 执行结果
   */
  executeMerge(suggestion: MergeSuggestion, tools: UnifiedToolDef[]): MergeExecutionResult {
    const result: MergeExecutionResult = {
      success: false,
      targetTool: suggestion.targetTool,
      mergedTools: suggestion.tools.filter(t => t !== suggestion.targetTool),
      strategy: suggestion.strategy,
      appliedAt: Date.now(),
    };

    // 检查是否有 error 级冲突
    if (!suggestion.safe) {
      const errConflict = suggestion.conflicts.find(c => c.severity === 'error');
      result.error = `存在严重冲突无法合并: ${errConflict?.description}`;
      return result;
    }

    // 验证工具存在
    const toolMap = new Map(tools.map(t => [t.name, t]));
    if (!toolMap.has(suggestion.targetTool)) {
      result.error = `目标工具 ${suggestion.targetTool} 不存在`;
      return result;
    }

    // 根据策略执行
    switch (suggestion.strategy) {
      case 'alias':
        // 别名：被合并工具的调用转发到目标工具
        for (const t of result.mergedTools) {
          this.aliasMap.set(t, suggestion.targetTool);
        }
        result.success = true;
        break;
      case 'deprecate':
        // 标记废弃：仅记录，不实际删除
        for (const t of result.mergedTools) {
          const rec = this.auditRecords.get(t);
          if (rec) rec.recommendation = 'deprecate';
        }
        result.success = true;
        break;
      case 'wrapper':
      case 'proxy':
      case 'federate':
        // wrapper/proxy/federate：建立别名映射，实际执行由调用方处理
        for (const t of result.mergedTools) {
          this.aliasMap.set(t, suggestion.targetTool);
        }
        result.success = true;
        break;
    }

    if (result.success) {
      this.executedMerges.push(result);
      this.save();
    }
    return result;
  }

  /** 解析工具别名：返回实际应调用的工具名 */
  resolveAlias(toolName: string): string {
    return this.aliasMap.get(toolName) || toolName;
  }

  /** 获取已执行的合并记录 */
  getExecutedMerges(): MergeExecutionResult[] {
    return [...this.executedMerges];
  }

  /**
   * P0-4: 自动合并触发 — 当使用历史达到阈值时，自动审计工具 + 执行 safe 合并建议
   *
   * 之前 ToolConsolidation 仅埋点不执行 executeMerge，5 种合并策略沦为死代码。
   * 现在在主循环工具调用后定期触发此方法，达到阈值时：
   * 1. 调用 audit(tools) 重新计算重叠度和合并建议
   * 2. 遍历 mergeSuggestions，对 safe=true 的建议执行 executeMerge
   * 3. 记录执行结果
   *
   * @param tools 当前工具列表（用于审计和执行合并）
   * @returns 本次执行的合并数量
   */
  tryAutoConsolidate(tools: UnifiedToolDef[]): number {
    // 阈值检查：使用历史每累积 50 条新记录才触发一次（避免频繁审计）
    const CONSOLIDATE_THRESHOLD = 50;
    if (this.usageHistory.length < CONSOLIDATE_THRESHOLD) return 0;
    // 上次审计时的历史长度，用于判断是否有足够新记录
    const lastAuditLength = (this as { _lastAuditLength?: number })._lastAuditLength || 0;
    const newRecords = this.usageHistory.length - lastAuditLength;
    if (newRecords < CONSOLIDATE_THRESHOLD) return 0;

    // 1. 审计工具 — 重新计算重叠度 + 生成合并建议
    this.audit(tools);
    (this as { _lastAuditLength?: number })._lastAuditLength = this.usageHistory.length;

    // 2. 执行 safe 合并建议
    let executedCount = 0;
    for (const suggestion of this.mergeSuggestions) {
      if (!suggestion.safe) continue;
      // 跳过已执行的合并（避免重复）
      const alreadyExecuted = this.executedMerges.some(
        m => m.targetTool === suggestion.targetTool &&
             m.mergedTools.some(t => suggestion.tools.includes(t))
      );
      if (alreadyExecuted) continue;

      try {
        const result = this.executeMerge(suggestion, tools);
        if (result.success) {
          executedCount++;
          console.info(`[ToolConsolidation] 自动合并: ${result.mergedTools.join(', ')} → ${result.targetTool} (策略: ${result.strategy})`);
        }
      } catch {
        // 合并失败不阻塞，继续尝试下一个建议
      }
    }

    return executedCount;
  }

  /**
   * 基于 usage 历史自动聚类生成 Profile
   * 分析最近 N 条记录，按 taskType 分组，统计每个 taskType 下使用最多的工具
   */
  autoGenerateProfiles(topN: number = 8): ToolSelectionProfile[] {
    const recentUsage = this.usageHistory.slice(-1000);
    const byTaskType = new Map<string, Map<string, number>>();

    for (const rec of recentUsage) {
      const tt = rec.taskType || 'general';
      if (!byTaskType.has(tt)) byTaskType.set(tt, new Map());
      const toolCounts = byTaskType.get(tt)!;
      toolCounts.set(rec.toolName, (toolCounts.get(rec.toolName) || 0) + 1);
    }

    const newProfiles: ToolSelectionProfile[] = [];
    for (const [taskType, toolCounts] of byTaskType) {
      const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length === 0) continue;
      const enabledTools = sorted.slice(0, topN).map(([name]) => name);
      const priorityTools = sorted.slice(0, 2).map(([name]) => name);
      newProfiles.push({ taskType, enabledTools, priorityTools });
    }

    // 合并到现有 profiles（不覆盖手动注册的）
    for (const np of newProfiles) {
      const existing = this.profiles.find(p => p.taskType === np.taskType);
      if (!existing) {
        this.profiles.push(np);
      }
    }
    this.save();
    return newProfiles;
  }

  /** 根据任务类型选择工具 */
  selectTools(taskType: string, allTools: UnifiedToolDef[]): UnifiedToolDef[] {
    const profile = this.profiles.find(p => p.taskType === taskType);
    if (!profile) return allTools;

    // 优先工具排前面，禁用工具过滤掉
    const prioritySet = new Set(profile.priorityTools);
    const enabledSet = new Set(profile.enabledTools);

    if (enabledSet.size > 0) {
      const filtered = allTools.filter(t => enabledSet.has(t.name));
      filtered.sort((a, b) => {
        const aP = prioritySet.has(a.name) ? 0 : 1;
        const bP = prioritySet.has(b.name) ? 0 : 1;
        return aP - bP;
      });
      return filtered;
    }

    // 无白名单时按质量评分排序
    const withScore = allTools.map(t => ({
      tool: t,
      score: this.auditRecords.get(t.name)?.decayedQualityScore || 0.5,
      isPriority: prioritySet.has(t.name),
    }));
    withScore.sort((a, b) => {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      return b.score - a.score;
    });
    return withScore.map(w => w.tool);
  }

  /** 获取低质量工具列表（待优化） */
  getLowQualityTools(threshold: number = 0.5): ToolAuditRecord[] {
    return [...this.auditRecords.values()].filter(r => r.decayedQualityScore < threshold);
  }

  /** 注册任务类型配置 */
  registerProfile(profile: ToolSelectionProfile): void {
    const existing = this.profiles.findIndex(p => p.taskType === profile.taskType);
    if (existing >= 0) this.profiles[existing] = profile;
    else this.profiles.push(profile);
    this.save();
  }

  // ============ 内部方法：多维度重叠计算 ============

  private groupByCategory(tools: UnifiedToolDef[]): Map<string, UnifiedToolDef[]> {
    const groups = new Map<string, UnifiedToolDef[]>();
    for (const t of tools) {
      const cat = t.category || 'general';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(t);
    }
    return groups;
  }

  /** 描述重叠度（基于词集 Jaccard 系数） */
  private descriptionOverlap(a: UnifiedToolDef, b: UnifiedToolDef): number {
    if (!a.description || !b.description) return 0;
    const aWords = new Set(this.tokenize(a.description));
    const bWords = new Set(this.tokenize(b.description));
    const intersection = new Set([...aWords].filter(w => bWords.has(w)));
    const union = new Set([...aWords, ...bWords]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /** 参数重叠度（参数名 Jaccard + 类型匹配加权） */
  private parameterOverlap(a: UnifiedToolDef, b: UnifiedToolDef): number {
    const aParams = a.parameters || {};
    const bParams = b.parameters || {};
    const aKeys = Object.keys(aParams);
    const bKeys = Object.keys(bParams);
    if (aKeys.length === 0 && bKeys.length === 0) return 0.5; // 都无参数视为部分相似
    if (aKeys.length === 0 || bKeys.length === 0) return 0;

    const bSet = new Set(bKeys);
    const common = aKeys.filter(k => bSet.has(k));
    const union = new Set([...aKeys, ...bKeys]);
    const nameJaccard = union.size > 0 ? common.length / union.size : 0;

    // 类型匹配加权
    let typeMatchRatio = 0;
    for (const k of common) {
      if (aParams[k].type === bParams[k].type) typeMatchRatio += 1;
    }
    typeMatchRatio = common.length > 0 ? typeMatchRatio / common.length : 0;

    return nameJaccard * 0.6 + typeMatchRatio * 0.4;
  }

  /** 行为重叠度（基于名称动词+类别匹配） */
  private behavioralOverlap(a: UnifiedToolDef, b: UnifiedToolDef): number {
    let score = 0;
    // 类别相同
    if ((a.category || 'general') === (b.category || 'general')) score += 0.4;
    // 名称动词相同
    const aVerb = this.extractVerb(a.name);
    const bVerb = this.extractVerb(b.name);
    if (aVerb && bVerb && aVerb === bVerb) score += 0.4;
    // 只读性相同
    if (a.readOnly === b.readOnly) score += 0.2;
    return Math.min(1, score);
  }

  /** 简单分词（中英文混合） */
  private tokenize(text: string): string[] {
    return text.toLowerCase()
      .split(/[\s,，。；;:：、!?！？()（）[\]{}]+/)
      .filter(t => t.length > 0);
  }

  /** 提取工具名中的动词前缀（如 file_read → read, web_search → search） */
  private extractVerb(name: string): string {
    const parts = name.split(/[_\-./]/);
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  // ============ 内部方法：冲突检测 ============

  /** 检测两个工具合并时的冲突 */
  private detectConflicts(a: UnifiedToolDef, b: UnifiedToolDef): MergeConflict[] {
    const conflicts: MergeConflict[] = [];
    const aParams = a.parameters || {};
    const bParams = b.parameters || {};

    // 参数名冲突：同名参数但类型不同
    for (const k of Object.keys(aParams)) {
      if (k in bParams && aParams[k].type !== bParams[k].type) {
        conflicts.push({
          type: 'param_type',
          description: `参数 "${k}" 类型不兼容: ${aParams[k].type} vs ${bParams[k].type}`,
          severity: 'error',
        });
      }
    }

    // 必填参数冲突：a 的必填参数在 b 中不存在
    for (const k of Object.keys(aParams)) {
      if (aParams[k].required && !(k in bParams)) {
        conflicts.push({
          type: 'param_name',
          description: `工具 ${a.name} 必填参数 "${k}" 在 ${b.name} 中不存在`,
          severity: 'warning',
        });
      }
    }
    for (const k of Object.keys(bParams)) {
      if (bParams[k].required && !(k in aParams)) {
        conflicts.push({
          type: 'param_name',
          description: `工具 ${b.name} 必填参数 "${k}" 在 ${a.name} 中不存在`,
          severity: 'warning',
        });
      }
    }

    // 类别不匹配
    if ((a.category || 'general') !== (b.category || 'general')) {
      conflicts.push({
        type: 'category_mismatch',
        description: `工具类别不匹配: ${a.category} vs ${b.category}`,
        severity: 'warning',
      });
    }

    return conflicts;
  }

  // ============ 内部方法：质量评分与时间衰减 ============

  private calculateQualityScore(tool: UnifiedToolDef, usageCount: number, successRate: number): number {
    let score = 0.5;
    if (usageCount > 100) score += 0.2;
    else if (usageCount > 20) score += 0.1;
    if (successRate > 0.95) score += 0.2;
    else if (successRate > 0.8) score += 0.1;
    else score -= 0.1;
    if (tool.parameters && Object.keys(tool.parameters).length > 0) score += 0.1;
    if (tool.description && tool.description.length > 50) score += 0.1;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 时间衰减：基于 lastUsed 时间，使用指数衰减
   * 衰减公式：score * 0.5^(elapsed / halfLife)
   * 长期未使用的工具质量评分降低，避免历史高分工具永久占据优先级
   */
  private applyTimeDecay(qualityScore: number, lastUsed: number | null): number {
    if (!lastUsed) return qualityScore * 0.5; // 从未使用，减半
    const elapsed = Date.now() - lastUsed;
    if (elapsed <= 0) return qualityScore;
    const decayFactor = Math.pow(0.5, elapsed / this.DECAY_HALF_LIFE_MS);
    return qualityScore * decayFactor;
  }

  private generateRecommendation(qualityScore: number, overlapScore: number, usageCount: number): ToolAuditRecord['recommendation'] {
    if (qualityScore < 0.3 && usageCount < 5) return 'remove';
    if (qualityScore < 0.4 && overlapScore > 0.5) return 'merge';
    if (qualityScore < 0.4) return 'deprecate';
    if (qualityScore > 0.7) return 'keep';
    if (overlapScore > 0.6) return 'merge';
    return 'keep';
  }

  private generateReason(qualityScore: number, overlapScore: number, usageCount: number): string {
    const reasons: string[] = [];
    if (qualityScore < 0.3) reasons.push(`质量评分低 (${(qualityScore * 100).toFixed(0)}/100)`);
    if (qualityScore > 0.7) reasons.push(`质量评分高 (${(qualityScore * 100).toFixed(0)}/100)`);
    if (overlapScore > 0.5) reasons.push(`与其他工具重叠度高 (${(overlapScore * 100).toFixed(0)}%)`);
    if (usageCount < 5) reasons.push(`使用频率极低 (${usageCount}次)`);
    if (usageCount > 50) reasons.push(`高频使用 (${usageCount}次)`);
    return reasons.join('; ') || '正常';
  }

  /** 生成合并建议（含冲突检测和策略选择） */
  private generateMergeSuggestions(tools: UnifiedToolDef[]): void {
    const records = [...this.auditRecords.values()];
    const toolMap = new Map(tools.map(t => [t.name, t]));
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const a = records[i];
        const b = records[j];
        if (a.overlappingTools.includes(b.name) && b.overlappingTools.includes(a.name)) {
          const combinedScore = Math.min(a.decayedQualityScore, b.decayedQualityScore);
          const target = a.decayedQualityScore >= b.decayedQualityScore ? a : b;
          const mergeInto = target.name;
          if (combinedScore < 0.6) {
            const toolA = toolMap.get(a.name);
            const toolB = toolMap.get(b.name);
            const conflicts: MergeConflict[] = [];
            if (toolA && toolB) {
              conflicts.push(...this.detectConflicts(toolA, toolB));
            }
            const strategy = this.selectMergeStrategy(a, b, conflicts);
            this.mergeSuggestions.push({
              tools: [a.name, b.name],
              targetTool: mergeInto,
              reason: `重叠度 ${(a.overlapScore * 100).toFixed(0)}%（描述${(a.descriptionOverlap * 100).toFixed(0)}%/参数${(a.parameterOverlap * 100).toFixed(0)}%/行为${(a.behavioralOverlap * 100).toFixed(0)}%），建议合并到 "${mergeInto}"`,
              impact: (() => {
                if (a.overlapScore > 0.7) return 'high';
                if (a.overlapScore > 0.5) return 'medium';
                return 'low';
              })(),
              strategy,
              conflicts,
              safe: !conflicts.some(c => c.severity === 'error'),
            });
          }
        }
      }
    }
  }

  /** 根据工具特征选择最合适的合并策略 */
  private selectMergeStrategy(a: ToolAuditRecord, b: ToolAuditRecord, conflicts: MergeConflict[]): MergeStrategy {
    // 有类型冲突 → 只能 deprecate
    if (conflicts.some(c => c.type === 'param_type')) return 'deprecate';
    // 高重叠（参数+行为都接近）→ alias
    if (a.parameterOverlap > 0.7 && a.behavioralOverlap > 0.7) return 'alias';
    // 中等重叠，参数有差异 → wrapper
    if (a.parameterOverlap > 0.4) return 'wrapper';
    // 行为相似但参数差异大 → proxy
    if (a.behavioralOverlap > 0.5) return 'proxy';
    // 类别相同但其他差异大 → federate
    if (a.behavioralOverlap > 0.3) return 'federate';
    return 'deprecate';
  }

  private initDefaultProfiles(): void {
    this.profiles = [
      {
        taskType: 'code',
        enabledTools: ['code_execute', 'file_read', 'file_write', 'shell_execute', 'list_directory', 'search_files', 'self_fix', 'self_git'],
        priorityTools: ['code_execute', 'file_write'],
      },
      {
        taskType: 'research',
        enabledTools: ['web_search', 'web_fetch', 'file_read', 'self_memory', 'self_think'],
        priorityTools: ['web_search', 'web_fetch'],
      },
      {
        taskType: 'debug',
        enabledTools: ['code_execute', 'file_read', 'search_files', 'shell_execute', 'self_fix', 'list_directory'],
        priorityTools: ['code_execute', 'search_files'],
      },
    ];
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.mergeSuggestions) this.mergeSuggestions = data.mergeSuggestions;
        if (data.profiles) this.profiles = data.profiles;
        if (data.auditRecords) {
          for (const r of data.auditRecords) {
            this.auditRecords.set(r.name, r);
          }
        }
        if (data.executedMerges) this.executedMerges = data.executedMerges;
        if (data.aliasMap) {
          for (const [k, v] of Object.entries(data.aliasMap)) {
            this.aliasMap.set(k, v as string);
          }
        }
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const aliasObj: Record<string, string> = {};
      for (const [k, v] of this.aliasMap) aliasObj[k] = v;
      atomicWriteJsonSync(this.persistPath, {
        auditRecords: [...this.auditRecords.values()],
        mergeSuggestions: this.mergeSuggestions,
        profiles: this.profiles,
        executedMerges: this.executedMerges,
        aliasMap: aliasObj,
      });
    } catch { /* ignore */ }
  }
}
