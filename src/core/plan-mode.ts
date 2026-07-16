/**
 * Plan Mode — 可编辑计划流程
 *
 * 对标 Cursor Plan Mode 实现可编辑计划流程：
 * 1. 计划生成：分析用户需求 → 生成结构化 Markdown 计划
 * 2. 计划状态机：draft → reviewing → approved → executing → completed / rejected → draft
 * 3. 计划执行追踪：每个步骤标记 pending/in_progress/completed/skipped
 * 4. 计划持久化：存储到 .duan/plans/<plan-id>.json
 *
 * 持久化：每个计划以独立 JSON 文件保存（<dataDir>/<plan-id>.json），
 * 写入使用 atomicWriteJsonSync（temp + rename 原子操作），防止半写文件。
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 计划状态 */
export type PlanStatus =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'cancelled';

/** 步骤状态 */
export type StepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'failed';

/** 计划步骤 */
export interface PlanStep {
  /** 步骤 ID，如 "step-1" */
  id: string;
  /** 步骤标题 */
  title: string;
  /** 步骤描述 */
  description: string;
  /** 步骤状态 */
  status: StepStatus;
  /** 前置步骤 ID 列表 */
  dependencies: string[];
  /** 执行结果 */
  result?: string;
  /** 开始时间戳 */
  startedAt?: number;
  /** 完成时间戳 */
  completedAt?: number;
}

/** 计划 */
export interface Plan {
  /** 计划 ID，如 "plan-001" */
  id: string;
  /** 计划标题 */
  title: string;
  /** 计划目标 */
  goal: string;
  /** 计划状态 */
  status: PlanStatus;
  /** 步骤列表 */
  steps: PlanStep[];
  /** 涉及文件 */
  files: string[];
  /** 风险 */
  risks: string[];
  /** 验收标准 */
  acceptanceCriteria: string[];
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
  /** 批准时间戳 */
  approvedAt?: number;
  /** 完成时间戳 */
  completedAt?: number;
  /** 进度（0-100 完成百分比） */
  progress: number;
}

/** 计划更新内容 */
export interface PlanUpdate {
  title?: string;
  goal?: string;
  status?: PlanStatus;
  steps?: PlanStep[];
  files?: string[];
  risks?: string[];
  acceptanceCriteria?: string[];
}

// ============ 状态机定义 ============

/**
 * 合法状态流转表
 *
 * draft → reviewing      (用户提交审核)
 * reviewing → approved   (用户确认)
 * reviewing → rejected   (用户拒绝)
 * rejected → draft       (重新编辑)
 * approved → executing   (开始执行)
 * executing → completed  (所有步骤完成)
 * executing → cancelled  (用户取消)
 * draft → cancelled      (草稿也可取消)
 */
const VALID_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ['reviewing', 'cancelled'],
  reviewing: ['approved', 'rejected'],
  rejected: ['draft'],
  approved: ['executing'],
  executing: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** 全部合法状态值，用于解析 Markdown 时校验 */
const ALL_PLAN_STATUSES: PlanStatus[] = [
  'draft',
  'reviewing',
  'approved',
  'executing',
  'completed',
  'rejected',
  'cancelled',
];

/** 全部合法步骤状态值 */
const ALL_STEP_STATUSES: StepStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'skipped',
  'failed',
];

/**
 * 校验状态流转是否合法
 * @param from 当前状态
 * @param to   目标状态
 * @throws 非法流转时抛出错误
 */
function assertTransition(from: PlanStatus, to: PlanStatus): void {
  if (from === to) return; // 同状态视为无操作
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`非法状态流转: ${from} → ${to}`);
  }
}

// ============ PlanMode 类 ============

export class PlanMode {
  /** 计划存储根目录（默认 .duan/plans） */
  private dataDir: string;
  /** 内存中的计划索引（id → Plan） */
  private plans: Map<string, Plan> = new Map();

  constructor(options?: { dataDir?: string }) {
    this.dataDir = options?.dataDir ?? duanPath('plans');
    this.ensureDir(this.dataDir);
    this.load();
  }

  // ============ 公开 API ============

  /**
   * 创建新计划
   *
   * @param title    计划标题
   * @param goal     计划目标
   * @param steps    步骤列表（id 自动生成为 step-1, step-2, ...，依赖引用自动重映射）
   * @param options  额外选项：涉及文件 / 风险 / 验收标准
   * @returns 创建的 Plan（初始状态为 draft）
   */
  createPlan(
    title: string,
    goal: string,
    steps: PlanStep[],
    options?: {
      files?: string[];
      risks?: string[];
      acceptanceCriteria?: string[];
    },
  ): Plan {
    const id = this.generatePlanId();
    const now = Date.now();

    // 生成步骤 ID（step-1, step-2, ...）并建立 旧ID → 新ID 映射
    const idMap = new Map<string, string>();
    const normalizedSteps: PlanStep[] = steps.map((step, i) => {
      const newId = `step-${i + 1}`;
      if (step.id) idMap.set(step.id, newId);
      return {
        id: newId,
        title: step.title,
        description: step.description ?? '',
        status: step.status ?? 'pending',
        dependencies: [...(step.dependencies ?? [])],
        result: step.result,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      };
    });
    // 重映射依赖引用（旧 ID → 新 ID）
    for (const step of normalizedSteps) {
      step.dependencies = step.dependencies.map((dep) => idMap.get(dep) ?? dep);
    }

    const plan: Plan = {
      id,
      title,
      goal,
      status: 'draft',
      steps: normalizedSteps,
      files: [...(options?.files ?? [])],
      risks: [...(options?.risks ?? [])],
      acceptanceCriteria: [...(options?.acceptanceCriteria ?? [])],
      createdAt: now,
      updatedAt: now,
      progress: 0,
    };
    this.recomputeProgress(plan);

    this.plans.set(id, plan);
    this.persistPlan(plan);
    return plan;
  }

  /**
   * 更新计划内容/状态
   *
   * @param planId  计划 ID
   * @param updates 更新内容
   * @returns 更新后的 Plan，计划不存在时返回 null
   * @throws 非法状态流转时抛出错误
   */
  updatePlan(planId: string, updates: PlanUpdate): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    // 状态流转校验
    if (updates.status && updates.status !== plan.status) {
      assertTransition(plan.status, updates.status);
      if (updates.status === 'approved') {
        plan.approvedAt = Date.now();
      }
      if (updates.status === 'completed') {
        plan.completedAt = Date.now();
      }
      plan.status = updates.status;
    }

    if (updates.title !== undefined) plan.title = updates.title;
    if (updates.goal !== undefined) plan.goal = updates.goal;
    if (updates.steps !== undefined) {
      plan.steps = updates.steps.map((s) => ({ ...s }));
    }
    if (updates.files !== undefined) plan.files = [...updates.files];
    if (updates.risks !== undefined) plan.risks = [...updates.risks];
    if (updates.acceptanceCriteria !== undefined) {
      plan.acceptanceCriteria = [...updates.acceptanceCriteria];
    }

    plan.updatedAt = Date.now();
    this.recomputeProgress(plan);
    this.persistPlan(plan);
    return plan;
  }

  /**
   * 确认计划开始执行（reviewing → approved → executing）
   *
   * @param planId 计划 ID
   * @returns 更新后的 Plan，计划不存在时返回 null
   * @throws 当前状态不是 reviewing 时抛出错误
   */
  confirmPlan(planId: string): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    if (plan.status !== 'reviewing') {
      throw new Error(
        `只有 reviewing 状态的计划可以确认，当前状态: ${plan.status}`,
      );
    }

    // reviewing → approved（记录批准时间）→ executing
    const now = Date.now();
    plan.approvedAt = now;
    plan.status = 'executing';
    plan.updatedAt = now;
    this.recomputeProgress(plan);
    this.persistPlan(plan);
    return plan;
  }

  /**
   * 取消计划（draft/executing → cancelled）
   *
   * @param planId 计划 ID
   * @returns 更新后的 Plan，计划不存在时返回 null
   * @throws 当前状态不允许取消时抛出错误
   */
  cancelPlan(planId: string): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    assertTransition(plan.status, 'cancelled');
    plan.status = 'cancelled';
    plan.updatedAt = Date.now();
    this.persistPlan(plan);
    return plan;
  }

  /**
   * 获取计划
   * @param planId 计划 ID
   * @returns Plan 或 null
   */
  getPlan(planId: string): Plan | null {
    return this.plans.get(planId) ?? null;
  }

  /**
   * 列出所有计划
   * @param filter 过滤条件（按状态）
   * @returns Plan 数组（按创建时间升序）
   */
  listPlans(filter?: { status?: PlanStatus }): Plan[] {
    let list = Array.from(this.plans.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    if (filter?.status) {
      list = list.filter((p) => p.status === filter.status);
    }
    return list;
  }

  /**
   * 更新步骤状态
   *
   * @param planId 计划 ID
   * @param stepId 步骤 ID
   * @param status 新状态
   * @param result 执行结果（可选）
   * @returns 更新后的 Plan，计划或步骤不存在时返回 null
   */
  updateStep(
    planId: string,
    stepId: string,
    status: StepStatus,
    result?: string,
  ): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return null;

    const now = Date.now();
    step.status = status;
    if (result !== undefined) step.result = result;
    if (status === 'in_progress' && !step.startedAt) {
      step.startedAt = now;
    }
    if (status === 'completed' && !step.completedAt) {
      step.completedAt = now;
    }

    plan.updatedAt = now;
    this.recomputeProgress(plan);

    // 执行中且所有步骤完成（completed/skipped）→ 自动完成计划
    if (plan.status === 'executing') {
      const allDone =
        plan.steps.length > 0 &&
        plan.steps.every(
          (s) => s.status === 'completed' || s.status === 'skipped',
        );
      if (allDone) {
        plan.status = 'completed';
        plan.completedAt = now;
      }
    }

    this.persistPlan(plan);
    return plan;
  }

  /**
   * 获取下一个待执行步骤
   *
   * 优先返回 in_progress 步骤；否则返回第一个依赖已完成的 pending 步骤。
   * @param planId 计划 ID
   * @returns PlanStep 或 null
   */
  getNextStep(planId: string): PlanStep | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    // 优先返回进行中的步骤
    const inProgress = plan.steps.find((s) => s.status === 'in_progress');
    if (inProgress) return inProgress;

    // 查找依赖已完成的 pending 步骤
    for (const step of plan.steps) {
      if (step.status !== 'pending') continue;
      const depsOk = step.dependencies.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep && dep.status === 'completed';
      });
      if (depsOk) return step;
    }
    return null;
  }

  /**
   * 生成计划 Markdown
   * @param planId 计划 ID
   * @returns Markdown 字符串，计划不存在时返回空字符串
   */
  generateMarkdown(planId: string): string {
    const plan = this.plans.get(planId);
    if (!plan) return '';

    const lines: string[] = [];
    lines.push(`# 计划：${plan.title}`);
    lines.push('');
    lines.push('## 目标');
    lines.push(plan.goal);
    lines.push('');
    lines.push('## 状态');
    lines.push(`${plan.status} (进度: ${plan.progress}%)`);
    lines.push('');
    lines.push('## 步骤');
    plan.steps.forEach((step, i) => {
      lines.push(`${i + 1}. [${step.status}] ${step.title}`);
    });
    lines.push('');
    lines.push('## 涉及文件');
    if (plan.files.length > 0) {
      for (const f of plan.files) lines.push(`- ${f}`);
    } else {
      lines.push('<!-- 无 -->');
    }
    lines.push('');
    lines.push('## 风险');
    if (plan.risks.length > 0) {
      for (const r of plan.risks) lines.push(`- ${r}`);
    } else {
      lines.push('<!-- 无 -->');
    }
    lines.push('');
    lines.push('## 验收标准');
    if (plan.acceptanceCriteria.length > 0) {
      for (const c of plan.acceptanceCriteria) lines.push(`- [ ] ${c}`);
    } else {
      lines.push('<!-- 无 -->');
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 从 Markdown 导入计划
   * @param markdown Markdown 字符串
   * @returns 导入的 Plan（状态从 Markdown 解析，步骤 ID 重新生成）
   */
  importFromMarkdown(markdown: string): Plan {
    const parsed = this.parseMarkdown(markdown);
    const id = this.generatePlanId();
    const now = Date.now();
    const plan: Plan = {
      id,
      title: parsed.title,
      goal: parsed.goal,
      status: parsed.status,
      steps: parsed.steps.map((s, i) => ({
        id: `step-${i + 1}`,
        title: s.title,
        description: '',
        status: s.status,
        dependencies: [],
      })),
      files: parsed.files,
      risks: parsed.risks,
      acceptanceCriteria: parsed.acceptanceCriteria,
      createdAt: now,
      updatedAt: now,
      progress: 0,
    };
    this.recomputeProgress(plan);
    this.plans.set(id, plan);
    this.persistPlan(plan);
    return plan;
  }

  /**
   * 加载持久化数据（从 dataDir 读取所有计划文件到内存）
   */
  load(): void {
    this.plans.clear();
    try {
      if (!fs.existsSync(this.dataDir)) return;
      const entries = fs.readdirSync(this.dataDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const fullPath = path.join(this.dataDir, entry);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const plan = JSON.parse(content) as Plan;
          if (plan && plan.id) {
            this.plans.set(plan.id, plan);
          }
        } catch {
          // 单个文件损坏跳过
        }
      }
    } catch {
      // 读取目录失败忽略
    }
  }

  /**
   * 保存持久化数据（将所有计划写入 dataDir）
   */
  save(): void {
    this.ensureDir(this.dataDir);
    // 使用 forEach 避免 for...of 迭代 MapIterator 触发 downlevelIteration 限制
    this.plans.forEach((plan) => this.persistPlan(plan));
  }

  // ============ 内部实现 ============

  /** 确保目录存在 */
  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 生成计划 ID：plan-<timestamp36>-<random> */
  private generatePlanId(): string {
    const randomId = Math.random().toString(36).slice(2, 8);
    return `plan-${Date.now().toString(36)}-${randomId}`;
  }

  /** 重新计算进度（completed 步骤数 / 总步骤数 * 100） */
  private recomputeProgress(plan: Plan): void {
    if (plan.steps.length === 0) {
      plan.progress = 0;
      return;
    }
    const completed = plan.steps.filter((s) => s.status === 'completed').length;
    plan.progress = Math.round((completed / plan.steps.length) * 100);
  }

  /** 持久化单个计划到 <dataDir>/<plan-id>.json */
  private persistPlan(plan: Plan): void {
    try {
      const filePath = path.join(this.dataDir, `${plan.id}.json`);
      atomicWriteJsonSync(filePath, plan);
    } catch {
      // 持久化失败忽略（不阻断主流程）
    }
  }

  /** 解析 Markdown 为计划字段 */
  private parseMarkdown(markdown: string): {
    title: string;
    goal: string;
    status: PlanStatus;
    steps: { title: string; status: StepStatus }[];
    files: string[];
    risks: string[];
    acceptanceCriteria: string[];
  } {
    const lines = markdown.split('\n');
    let title = '未命名计划';
    let goal = '';
    let status: PlanStatus = 'draft';
    const steps: { title: string; status: StepStatus }[] = [];
    const files: string[] = [];
    const risks: string[] = [];
    const acceptanceCriteria: string[] = [];

    let section = '';
    const goalLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      // 标题行 "# 计划：<title>"
      if (line.startsWith('# 计划：')) {
        title = line.slice('# 计划：'.length).trim() || title;
        section = '';
        continue;
      }

      // 二级标题切换 section
      if (line.startsWith('## ')) {
        const newSection = line.slice(3).trim();
        // 离开「目标」section 时提交 goal
        if (section === '目标' && goalLines.length > 0 && !goal) {
          goal = goalLines.join('\n').trim();
        }
        section = newSection;
        continue;
      }

      switch (section) {
        case '目标':
          if (trimmed) goalLines.push(trimmed);
          break;
        case '状态': {
          if (!trimmed) break;
          // 形如 "executing (进度: 60%)" 或 "executing"
          const statusMatch = trimmed.match(/^([a-zA-Z_]+)/);
          if (statusMatch) {
            const s = statusMatch[1];
            if (ALL_PLAN_STATUSES.includes(s as PlanStatus)) {
              status = s as PlanStatus;
            }
          }
          break;
        }
        case '步骤': {
          // 形如 "1. [completed] 创建 User 模型"
          const stepMatch = trimmed.match(/^\d+\.\s*\[([a-zA-Z_]+)\]\s*(.+)$/);
          if (stepMatch) {
            const s = stepMatch[1];
            const stepStatus = (
              ALL_STEP_STATUSES.includes(s as StepStatus) ? s : 'pending'
            ) as StepStatus;
            steps.push({ title: stepMatch[2].trim(), status: stepStatus });
          }
          break;
        }
        case '涉及文件':
          // "- <file>"，排除 "- [ ]" 形式
          if (trimmed.startsWith('- ') && !trimmed.startsWith('- [')) {
            files.push(trimmed.slice(2).trim());
          }
          break;
        case '风险':
          if (trimmed.startsWith('- ')) {
            risks.push(trimmed.slice(2).trim());
          }
          break;
        case '验收标准':
          if (trimmed.startsWith('- [ ]')) {
            acceptanceCriteria.push(trimmed.slice(5).trim());
          } else if (
            trimmed.startsWith('- [x]') ||
            trimmed.startsWith('- [X]')
          ) {
            acceptanceCriteria.push(trimmed.slice(5).trim());
          }
          break;
      }
    }

    // 收尾：若 goal 仍在 goalLines 中（目标为最后一个 section）
    if (!goal && goalLines.length > 0) {
      goal = goalLines.join('\n').trim();
    }

    return { title, goal, status, steps, files, risks, acceptanceCriteria };
  }
}

// ============ LLM 工具定义 ============

/**
 * Plan Mode LLM 工具定义
 *
 * 返回 5 个工具：
 * - plan_create:  创建新计划
 * - plan_update:  更新计划内容/状态
 * - plan_confirm: 确认计划开始执行
 * - plan_cancel:  取消计划
 * - plan_list:    列出计划
 */
export function getPlanModeToolDefinitions() {
  return [
    {
      name: 'plan_create',
      description: '创建新的可编辑计划（Plan Mode）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: '计划标题' },
          goal: { type: 'string', description: '计划目标' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '步骤标题' },
                description: { type: 'string', description: '步骤描述' },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '前置步骤 ID 列表（如 step-1）',
                },
              },
              required: ['title'],
            },
            description: '步骤列表',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '涉及文件列表',
          },
          risks: {
            type: 'array',
            items: { type: 'string' },
            description: '风险列表',
          },
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string' },
            description: '验收标准列表',
          },
        },
        required: ['title', 'goal', 'steps'],
      },
    },
    {
      name: 'plan_update',
      description: '更新计划内容或状态（非法状态流转会报错）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          planId: { type: 'string', description: '计划 ID' },
          title: { type: 'string', description: '新标题' },
          goal: { type: 'string', description: '新目标' },
          status: {
            type: 'string',
            description:
              '新状态: draft/reviewing/approved/executing/completed/rejected/cancelled',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '涉及文件列表',
          },
          risks: {
            type: 'array',
            items: { type: 'string' },
            description: '风险列表',
          },
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string' },
            description: '验收标准列表',
          },
        },
        required: ['planId'],
      },
    },
    {
      name: 'plan_confirm',
      description: '确认计划开始执行（reviewing → executing）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          planId: { type: 'string', description: '计划 ID' },
        },
        required: ['planId'],
      },
    },
    {
      name: 'plan_cancel',
      description: '取消计划（draft/executing → cancelled）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          planId: { type: 'string', description: '计划 ID' },
        },
        required: ['planId'],
      },
    },
    {
      name: 'plan_list',
      description: '列出计划',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            description:
              '按状态过滤: draft/reviewing/approved/executing/completed/rejected/cancelled',
          },
        },
      },
    },
  ];
}

/**
 * Plan Mode 工具处理器
 *
 * @param planMode PlanMode 实例
 * @returns 异步工具处理函数
 */
export function createPlanModeToolHandler(planMode: PlanMode) {
  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    switch (toolName) {
      case 'plan_create': {
        const {
          title,
          goal,
          steps,
          files,
          risks,
          acceptanceCriteria,
        } = args as {
          title: string;
          goal: string;
          steps: Array<{
            title: string;
            description?: string;
            dependencies?: string[];
          }>;
          files?: string[];
          risks?: string[];
          acceptanceCriteria?: string[];
        };
        const plan = planMode.createPlan(
          title,
          goal,
          steps.map((s) => ({
            id: '',
            title: s.title,
            description: s.description ?? '',
            status: 'pending' as StepStatus,
            dependencies: s.dependencies ?? [],
          })),
          { files, risks, acceptanceCriteria },
        );
        return {
          planId: plan.id,
          title: plan.title,
          status: plan.status,
          stepCount: plan.steps.length,
        };
      }
      case 'plan_update': {
        const { planId, ...rest } = args as unknown as { planId: string } & PlanUpdate;
        try {
          const plan = planMode.updatePlan(planId, rest);
          if (!plan) return { error: `计划不存在: ${planId}` };
          return {
            planId: plan.id,
            title: plan.title,
            status: plan.status,
            progress: plan.progress,
          };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      case 'plan_confirm': {
        const { planId } = args as { planId: string };
        try {
          const plan = planMode.confirmPlan(planId);
          if (!plan) return { error: `计划不存在: ${planId}` };
          return { planId: plan.id, status: plan.status };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      case 'plan_cancel': {
        const { planId } = args as { planId: string };
        try {
          const plan = planMode.cancelPlan(planId);
          if (!plan) return { error: `计划不存在: ${planId}` };
          return { planId: plan.id, status: plan.status };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      case 'plan_list': {
        const { status } = args as { status?: PlanStatus };
        const list = planMode.listPlans(status ? { status } : undefined);
        return list.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          progress: p.progress,
          stepCount: p.steps.length,
        }));
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
