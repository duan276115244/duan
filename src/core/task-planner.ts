import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked';

export interface PlanStep {
  id: number;
  description: string;
  status: StepStatus;
  dependencies: number[];
  assignedAgent?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface Plan {
  id: string;
  name: string;
  goal: string;
  steps: PlanStep[];
  status: 'active' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

// ============ 层次化计划类型定义（4级分解支持） ============

/** 计划步骤的层级（L1-L4） */
export type PlanStepLevel = 1 | 2 | 3 | 4;

/** 层次化计划步骤（扩展 PlanStep，向后兼容） */
export interface HierarchicalPlanStep extends PlanStep {
  /** 步骤层级 L1-L4 */
  level: PlanStepLevel;
  /** 父步骤ID（L2/L3/L4 步骤的上级） */
  parentId?: number;
  /** 子步骤ID列表 */
  childIds: number[];
  /** 原子操作签名（仅 L4 层级，如 "browser_operate(action=goto,url=xxx)"） */
  atomicOperation?: string;
  /** 是否可跳过（阻塞时是否允许跳过推进） */
  skippable: boolean;
  /** 重试次数 */
  retryCount: number;
  /** 已尝试的修复策略 */
  attemptedStrategies: string[];
}

/** 失败上下文记录（用于动态重规划和后续学习） */
export interface PlanFailureContext {
  /** 失败的步骤ID */
  stepId: number;
  /** 失败的步骤描述 */
  stepDescription: string;
  /** 失败原因 */
  reason: string;
  /** 错误消息 */
  errorMessage: string;
  /** 重试次数 */
  retryCount: number;
  /** 失败时间戳 */
  timestamp: number;
  /** 已尝试的修复策略 */
  attemptedStrategies: string[];
  /** 步骤层级 */
  level: PlanStepLevel;
}

/** 动态重规划结果 */
export interface PlanReplanResult {
  /** 是否触发了重规划 */
  replanned: boolean;
  /** 重规划原因 */
  reason: string;
  /** 重规划次数 */
  replanCount: number;
  /** 跳过的阻塞步骤ID列表 */
  skippedStepIds: number[];
  /** 保留的失败上下文 */
  failureContexts: PlanFailureContext[];
}

// ============ 常量 ============

/** 触发动态重规划的连续失败阈值 */
const REPLAN_FAILURE_THRESHOLD = 3;

/** 动态重规划最大次数 */
const MAX_REPLAN_ATTEMPTS = 3;

/** 失败上下文最大保留条数 */
const MAX_FAILURE_CONTEXT = 50;

export class TaskPlanner {
  private plans: Map<string, Plan> = new Map();
  private dbPath: string;
  private nextStepId: number = 1;

  // ============ 动态重规划与失败追踪 ============

  /** 各步骤的连续失败次数（stepId → 失败次数） */
  private stepFailureCounts: Map<number, number> = new Map();
  /** 保留的失败上下文 */
  private failureContexts: PlanFailureContext[] = [];
  /** 各计划的重规划次数（planId → 次数） */
  private planReplanCounts: Map<string, number> = new Map();
  /** 已跳过的步骤ID集合 */
  private skippedStepIds: Set<number> = new Set();
  /** 步骤层级映射（stepId → 层级） */
  private stepLevels: Map<number, PlanStepLevel> = new Map();

  constructor() {
    this.dbPath = path.join(process.cwd(), '.awareness', 'plans.json');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const p of data) {
          this.plans.set(p.id, p);
          for (const s of p.steps) {
            if (s.id >= this.nextStepId) this.nextStepId = s.id + 1;
          }
        }
      }
    } catch {}
  }

  private save(): void {
    atomicWriteJsonSync(this.dbPath, Array.from(this.plans.values()));
  }

  createPlan(name: string, goal: string, steps: { description: string; dependencies?: number[] }[]): Plan {
    const plan: Plan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      name,
      goal,
      steps: steps.map((s, _i) => ({
        id: this.nextStepId++,
        description: s.description,
        status: 'pending',
        dependencies: s.dependencies || [],
      })),
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.plans.set(plan.id, plan);
    this.save();
    return plan;
  }

  getPlan(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  getActivePlans(): Plan[] {
    return Array.from(this.plans.values()).filter(p => p.status === 'active');
  }

  getAllPlans(): Plan[] {
    return Array.from(this.plans.values());
  }

  updateStep(planId: string, stepId: number, updates: Partial<PlanStep>): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    const step = plan.steps.find(s => s.id === stepId);
    if (!step) return null;
    Object.assign(step, updates, updates.status === 'in_progress' ? { startedAt: Date.now() } : {});
    if (updates.status === 'completed') step.completedAt = Date.now();
    if (updates.status === 'failed') step.completedAt = Date.now();
    plan.updatedAt = Date.now();

    const allDone = plan.steps.every(s => s.status === 'completed' || s.status === 'skipped');
    const anyFailed = plan.steps.some(s => s.status === 'failed');
    if (allDone) { plan.status = 'completed'; plan.completedAt = Date.now(); }
    else if (anyFailed) { plan.status = 'failed'; plan.completedAt = Date.now(); }

    this.save();
    return plan;
  }

  getNextSteps(planId: string): PlanStep[] {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'active') return [];
    return plan.steps.filter(s => {
      if (s.status !== 'pending') return false;
      return s.dependencies.every(depId => {
        const dep = plan.steps.find(d => d.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'skipped');
      });
    });
  }

  getProgress(planId: string): string {
    const plan = this.plans.get(planId);
    if (!plan) return '计划不存在';
    const total = plan.steps.length;
    const done = plan.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    const failed = plan.steps.filter(s => s.status === 'failed').length;
    const inProgress = plan.steps.filter(s => s.status === 'in_progress').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

    let output = `📋 计划: ${plan.name}\n`;
    output += `  目标: ${plan.goal.substring(0, 100)}\n`;
    output += `  进度: ${bar} ${pct}% (${done}/${total})\n`;
    output += `  状态: ${(() => {
      if (plan.status === 'active') return '🔄 执行中';
      if (plan.status === 'completed') return '✅ 已完成';
      return '❌ 已失败';
    })()}`;
    if (inProgress > 0) output += ` | ${inProgress}个进行中`;
    if (failed > 0) output += ` | ${failed}个失败`;
    output += '\n\n';

    for (const s of plan.steps) {
      let icon: string;
      if (s.status === 'completed') icon = '✅';
      else if (s.status === 'in_progress') icon = '🔄';
      else if (s.status === 'failed') icon = '❌';
      else if (s.status === 'skipped') icon = '⏭';
      else if (s.status === 'blocked') icon = '🚫';
      else icon = '⏳';
      const depInfo = s.dependencies.length > 0 ? ` [依赖步骤: ${s.dependencies.join(',')}]` : '';
      output += `  ${icon} 步骤${s.id}: ${s.description}${depInfo}\n`;
      if (s.result && s.status === 'completed') output += `     📄 ${s.result.substring(0, 100)}\n`;
      if (s.error && s.status === 'failed') output += `     ⚠️ ${s.error.substring(0, 100)}\n`;
    }
    return output;
  }

  deletePlan(id: string): boolean {
    const deleted = this.plans.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  // ============ 层次化计划方法（4级分解支持） ============

  /**
   * 创建4级层次化计划
   *
   * 层次结构：
   * - L1 总体目标：计划本身
   * - L2 主要阶段：顶层步骤
   * - L3 具体步骤：L2 的子步骤
   * - L4 原子操作：L3 的子步骤（带 atomicOperation 签名）
   *
   * @param name 计划名称
   * @param goal L1 总体目标
   * @param hierarchicalSteps 层次化步骤定义
   * @returns 创建的计划
   */
  createHierarchicalPlan(
    name: string,
    goal: string,
    hierarchicalSteps: Array<{
      description: string;
      level: PlanStepLevel;
      parentId?: number;
      atomicOperation?: string;
      skippable?: boolean;
      dependencies?: number[];
    }>,
  ): Plan {
    // 先检测循环依赖
    const depCycle = this.detectDependencyCycle(hierarchicalSteps);
    if (depCycle) {
      throw new Error(`检测到循环依赖: ${depCycle.join(' → ')}`);
    }

    const plan: Plan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      name,
      goal,
      steps: [],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 第一遍：创建所有步骤并分配ID
    const stepIdMap = new Map<number, number>(); // 临时索引 → 实际ID
    for (let i = 0; i < hierarchicalSteps.length; i++) {
      const s = hierarchicalSteps[i];
      const stepId = this.nextStepId++;
      stepIdMap.set(i, stepId);

      const step: PlanStep = {
        id: stepId,
        description: s.description,
        status: 'pending',
        dependencies: [],
      };
      plan.steps.push(step);

      // 记录层级
      this.stepLevels.set(stepId, s.level);
    }

    // 第二遍：设置依赖关系（将临时ID映射为实际ID）
    for (let i = 0; i < hierarchicalSteps.length; i++) {
      const s = hierarchicalSteps[i];
      const stepId = stepIdMap.get(i)!;
      const step = plan.steps.find(st => st.id === stepId)!;
      if (s.dependencies) {
        step.dependencies = s.dependencies
          .map(depIdx => stepIdMap.get(depIdx))
          .filter((x): x is number => x !== undefined);
      }
    }

    this.plans.set(plan.id, plan);
    this.save();
    return plan;
  }

  /**
   * 检测依赖关系中的循环依赖
   * @returns 循环路径数组，无循环时返回 null
   */
  private detectDependencyCycle(
    steps: Array<{ dependencies?: number[] }>,
  ): number[] | null {
    // 构建邻接表（使用数组索引）
    const graph = new Map<number, number[]>();
    for (let i = 0; i < steps.length; i++) {
      graph.set(i, steps[i].dependencies || []);
    }

    // DFS 检测环（三色标记法）
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Array(steps.length).fill(WHITE);
    const parent = new Array(steps.length).fill(-1);

    const dfs = (node: number): number[] | null => {
      color[node] = GRAY;
      const deps = graph.get(node) || [];
      for (const dep of deps) {
        if (dep < 0 || dep >= steps.length) continue;
        if (color[dep] === GRAY) {
          // 发现环，回溯路径
          const cycle = [dep, node];
          let cur = node;
          while (parent[cur] !== -1 && parent[cur] !== dep) {
            cur = parent[cur];
            cycle.push(cur);
          }
          cycle.push(dep);
          return cycle.reverse();
        }
        if (color[dep] === WHITE) {
          parent[dep] = node;
          const result = dfs(dep);
          if (result) return result;
        }
      }
      color[node] = BLACK;
      return null;
    };

    for (let i = 0; i < steps.length; i++) {
      if (color[i] === WHITE) {
        const cycle = dfs(i);
        if (cycle) return cycle;
      }
    }
    return null;
  }

  /**
   * 检测计划中步骤的循环依赖（运行时检查）
   * @param planId 计划ID
   * @returns 循环路径，无循环时返回 null
   */
  detectPlanCycle(planId: string): number[] | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const steps = plan.steps.map(s => ({ dependencies: s.dependencies }));
    return this.detectDependencyCycle(steps);
  }

  /**
   * 获取可并行执行的步骤组（无依赖关系的步骤可并行）
   * @param planId 计划ID
   * @returns 并行步骤组列表
   */
  getParallelSteps(planId: string): number[][] {
    const plan = this.plans.get(planId);
    if (!plan) return [];

    // 按依赖层级分组
    const levels = new Map<number, number[]>();
    const nodeLevels = new Map<number, number>();
    const stepMap = new Map(plan.steps.map(s => [s.id, s]));

    const computeLevel = (stepId: number, visited: Set<number> = new Set()): number => {
      if (nodeLevels.has(stepId)) return nodeLevels.get(stepId)!;
      if (visited.has(stepId)) return 0; // 循环依赖保护
      visited.add(stepId);

      const step = stepMap.get(stepId);
      if (!step || step.dependencies.length === 0) {
        nodeLevels.set(stepId, 0);
        return 0;
      }

      const maxDepLevel = Math.max(
        ...step.dependencies
          .filter(depId => stepMap.has(depId))
          .map(depId => computeLevel(depId, visited))
      );

      const level = maxDepLevel + 1;
      nodeLevels.set(stepId, level);
      return level;
    };

    for (const step of plan.steps) {
      computeLevel(step.id);
    }

    for (const [stepId, level] of nodeLevels) {
      const group = levels.get(level) || [];
      group.push(stepId);
      levels.set(level, group);
    }

    // 只返回有多个步骤的层级（可并行）
    const result: number[][] = [];
    for (const group of levels.values()) {
      if (group.length > 1) {
        result.push(group);
      }
    }
    return result;
  }

  // ============ 动态重规划方法 ============

  /**
   * 记录步骤失败并检测是否需要触发动态重规划
   *
   * 触发条件：
   * 1. 单个步骤连续失败达到 REPLAN_FAILURE_THRESHOLD 次
   * 2. 计划整体重规划次数未超过 MAX_REPLAN_ATTEMPTS
   *
   * 动态重规划动作：
   * - 跳过阻塞步骤（L3/L4 层级的非关键步骤），推进到下一步
   * - 保留失败上下文用于后续学习
   *
   * @param planId 计划ID
   * @param stepId 失败的步骤ID
   * @param errorMessage 错误消息
   * @param attemptedStrategies 已尝试的修复策略
   * @returns 重规划结果
   */
  recordFailureAndReplan(
    planId: string,
    stepId: number,
    errorMessage: string,
    attemptedStrategies: string[] = [],
  ): PlanReplanResult {
    const plan = this.plans.get(planId);
    if (!plan) {
      return {
        replanned: false,
        reason: `计划 ${planId} 不存在`,
        replanCount: 0,
        skippedStepIds: [],
        failureContexts: this.failureContexts.slice(-10),
      };
    }

    const failedStep = plan.steps.find(s => s.id === stepId);
    const failCount = (this.stepFailureCounts.get(stepId) || 0) + 1;
    this.stepFailureCounts.set(stepId, failCount);

    // 记录失败上下文
    const level = this.stepLevels.get(stepId) || 3;
    const failureCtx: PlanFailureContext = {
      stepId,
      stepDescription: failedStep?.description || '',
      reason: this.summarizeFailureReason(errorMessage),
      errorMessage: errorMessage.substring(0, 500),
      retryCount: failCount,
      timestamp: Date.now(),
      attemptedStrategies: [...attemptedStrategies],
      level,
    };
    this.failureContexts.push(failureCtx);
    if (this.failureContexts.length > MAX_FAILURE_CONTEXT) {
      this.failureContexts.shift();
    }

    // 未达到重规划阈值
    if (failCount < REPLAN_FAILURE_THRESHOLD) {
      return {
        replanned: false,
        reason: `失败次数 ${failCount}/${REPLAN_FAILURE_THRESHOLD}，未触发重规划`,
        replanCount: this.planReplanCounts.get(planId) || 0,
        skippedStepIds: [],
        failureContexts: this.failureContexts.slice(-10),
      };
    }

    // 检查重规划次数上限
    const currentReplanCount = this.planReplanCounts.get(planId) || 0;
    if (currentReplanCount >= MAX_REPLAN_ATTEMPTS) {
      // 重规划次数耗尽，强制跳过阻塞步骤
      return this.forceSkipBlockingStep(planId, stepId, failureCtx);
    }

    // 触发动态重规划
    return this.triggerReplan(planId, stepId, failureCtx);
  }

  /** 概括失败原因 */
  private summarizeFailureReason(errorMessage: string): string {
    const msg = errorMessage.toLowerCase();
    if (msg.includes('timeout') || msg.includes('超时')) return '操作超时';
    if (msg.includes('enoent') || msg.includes('not found') || msg.includes('不存在')) return '资源不存在';
    if (msg.includes('econnrefused') || msg.includes('network')) return '网络连接失败';
    if (msg.includes('permission') || msg.includes('eacces') || msg.includes('权限')) return '权限不足';
    if (msg.includes('syntax') || msg.includes('语法')) return '语法错误';
    if (msg.includes('oom') || msg.includes('out of memory') || msg.includes('内存不足')) return '内存不足';
    if (msg.includes('enospc') || msg.includes('disk full') || msg.includes('磁盘满')) return '磁盘空间不足';
    return errorMessage.substring(0, 100);
  }

  /**
   * 触发动态重规划：跳过阻塞步骤，推进到下一步
   */
  private triggerReplan(planId: string, stepId: number, failureCtx: PlanFailureContext): PlanReplanResult {
    const plan = this.plans.get(planId);
    if (!plan) {
      return {
        replanned: false,
        reason: `计划 ${planId} 不存在`,
        replanCount: 0,
        skippedStepIds: [],
        failureContexts: this.failureContexts.slice(-10),
      };
    }

    const replanCount = (this.planReplanCounts.get(planId) || 0) + 1;
    this.planReplanCounts.set(planId, replanCount);

    const skippedStepIds: number[] = [];
    const level = this.stepLevels.get(stepId) || 3;

    // L3/L4 层级的非关键步骤可跳过
    if (level >= 3) {
      const step = plan.steps.find(s => s.id === stepId);
      if (step) {
        step.status = 'skipped';
        step.error = `跳过：${failureCtx.reason}（连续失败 ${failureCtx.retryCount} 次）`;
        step.completedAt = Date.now();
        this.skippedStepIds.add(stepId);
        skippedStepIds.push(stepId);
      }
    } else {
      // L1/L2 关键步骤不可跳过，标记为 blocked
      const step = plan.steps.find(s => s.id === stepId);
      if (step) {
        step.status = 'blocked';
        step.error = `阻塞：${failureCtx.reason}（连续失败 ${failureCtx.retryCount} 次）`;
      }
    }

    plan.updatedAt = Date.now();
    this.save();

    return {
      replanned: true,
      reason: `步骤 "${failureCtx.stepDescription.substring(0, 50)}" 连续失败 ${failureCtx.retryCount} 次，已触发重规划（第 ${replanCount} 次）`,
      replanCount,
      skippedStepIds,
      failureContexts: this.failureContexts.slice(-10),
    };
  }

  /**
   * 强制跳过阻塞步骤（重规划次数耗尽时的降级策略）
   */
  private forceSkipBlockingStep(planId: string, stepId: number, failureCtx: PlanFailureContext): PlanReplanResult {
    const plan = this.plans.get(planId);
    const skippedStepIds: number[] = [];
    const level = this.stepLevels.get(stepId) || 3;

    if (plan && level >= 3) {
      const step = plan.steps.find(s => s.id === stepId);
      if (step) {
        step.status = 'skipped';
        step.error = `强制跳过：${failureCtx.reason}（重规划次数耗尽）`;
        step.completedAt = Date.now();
        this.skippedStepIds.add(stepId);
        skippedStepIds.push(stepId);
      }
      plan.updatedAt = Date.now();
      this.save();
    }

    return {
      replanned: false,
      reason: `重规划次数已达上限，强制跳过阻塞步骤 "${failureCtx.stepDescription.substring(0, 50)}"`,
      replanCount: MAX_REPLAN_ATTEMPTS,
      skippedStepIds,
      failureContexts: this.failureContexts.slice(-10),
    };
  }

  /**
   * 清除步骤的失败计数（步骤成功后调用）
   */
  clearStepFailureCount(stepId: number): void {
    this.stepFailureCounts.delete(stepId);
  }

  /**
   * 获取保留的失败上下文（用于后续学习和策略优化）
   */
  getFailureContexts(limit: number = 20): PlanFailureContext[] {
    return this.failureContexts.slice(-limit);
  }

  /**
   * 获取已跳过的步骤ID列表
   */
  getSkippedStepIds(): number[] {
    return Array.from(this.skippedStepIds);
  }

  /**
   * 获取步骤层级
   */
  getStepLevel(stepId: number): PlanStepLevel | undefined {
    return this.stepLevels.get(stepId);
  }

  /**
   * 获取计划的重规划统计
   */
  getReplanStats(planId: string): { replanCount: number; skippedCount: number; failureCount: number } {
    const plan = this.plans.get(planId);
    const skipped = plan ? plan.steps.filter(s => s.status === 'skipped').length : 0;
    return {
      replanCount: this.planReplanCounts.get(planId) || 0,
      skippedCount: skipped,
      failureCount: this.failureContexts.filter(c => plan?.steps.some(s => s.id === c.stepId)).length,
    };
  }
}
