/**
 * v20.0 §3.7 长期目标追踪 — GoalTracker
 *
 * 对标 AutoGPT：支持长期目标分解 + 进度追踪 + 自主迭代 + 中断恢复。
 *
 * 核心能力：
 * 1. 目标树：长期目标 → 里程碑 → 子任务（三层结构）
 * 2. 进度持久化：`~/.duan/goals/<goal-id>.json` 每个目标独立文件
 * 3. 自主迭代：检测到空闲时，自动推进下一个待办子任务
 * 4. 中断恢复：启动时加载未完成目标，询问是否继续
 * 5. 目标模板：重构项目 / 学习新技术 / 完成产品迭代
 *
 * 与现有 GoalSystem（自主意识系统）的关系：
 *   - GoalSystem 是"短期任务目标"（单次会话内的目标）
 *   - GoalTracker 是"跨会话长期目标"（可跨越数天/数月）
 *   - 两者互补：GoalSystem 负责即时执行，GoalTracker 负责长期追踪
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync, atomicWriteJson } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 目标优先级 */
export type GoalPriority = 'low' | 'medium' | 'high' | 'critical';

/** 目标状态 */
export type GoalStatus = 'planning' | 'active' | 'paused' | 'completed' | 'abandoned';

/** 里程碑/子任务状态 */
export type ItemStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'blocked';

/** 子任务（最细粒度） */
export interface SubTask {
  /** 子任务 ID（如 `subtask-001`） */
  id: string;
  /** 标题 */
  title: string;
  /** 描述（可选） */
  description?: string;
  /** 状态 */
  status: ItemStatus;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 预计耗时（分钟） */
  estimatedMinutes?: number;
  /** 实际耗时（分钟） */
  actualMinutes?: number;
  /** 关联文件/资源 */
  resources?: string[];
  /** 备注 */
  notes?: string;
}

/** 里程碑（中间层） */
export interface Milestone {
  /** 里程碑 ID（如 `milestone-001`） */
  id: string;
  /** 标题 */
  title: string;
  /** 描述 */
  description?: string;
  /** 状态 */
  status: ItemStatus;
  /** 子任务列表 */
  subtasks: SubTask[];
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 目标完成日期 */
  dueDate?: string;
}

/** 长期目标（顶层） */
export interface Goal {
  /** 目标 ID（唯一标识，如 `goal-20260716-abc123`） */
  id: string;
  /** 目标标题 */
  title: string;
  /** 目标描述 */
  description: string;
  /** 优先级 */
  priority: GoalPriority;
  /** 状态 */
  status: GoalStatus;
  /** 里程碑列表 */
  milestones: Milestone[];
  /** 标签 */
  tags?: string[];
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 目标完成日期 */
  dueDate?: string;
  /** 来源模板（如果是基于模板创建的） */
  fromTemplate?: string;
  /** 上下文（关联项目、用户偏好等） */
  context?: Record<string, unknown>;
}

/** 目标模板 */
export interface GoalTemplate {
  /** 模板名称 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 描述 */
  description: string;
  /** 默认优先级 */
  defaultPriority: GoalPriority;
  /** 模板标题（创建目标时填充） */
  titleTemplate: string;
  /** 模板描述（创建目标时填充） */
  descriptionTemplate: string;
  /** 预置里程碑（标题列表，创建时自动生成空子任务占位） */
  milestoneTemplates: Array<{
    title: string;
    description?: string;
    subtaskTitles: string[];
  }>;
  /** 图标 */
  icon: string;
}

/** 目标摘要（用于列表展示） */
export interface GoalSummary {
  id: string;
  title: string;
  status: GoalStatus;
  priority: GoalPriority;
  progress: number; // 0-100
  totalMilestones: number;
  completedMilestones: number;
  totalSubtasks: number;
  completedSubtasks: number;
  dueDate?: string;
  updatedAt: number;
}

/** 操作结果 */
export interface OperationResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

// ============ 内置目标模板 ============

export const BUILTIN_GOAL_TEMPLATES: GoalTemplate[] = [
  {
    name: 'refactor-project',
    displayName: '重构项目',
    description: '系统性重构现有项目，提升代码质量、可维护性和性能',
    icon: '🔧',
    defaultPriority: 'high',
    titleTemplate: '重构 {projectName} 项目',
    descriptionTemplate: '系统性重构 {projectName} 项目，目标：提升可维护性、消除技术债、补齐测试覆盖',
    milestoneTemplates: [
      {
        title: '代码评估与计划',
        description: '分析现状，识别问题，制定重构计划',
        subtaskTitles: ['代码质量评估', '技术债识别', '重构范围确定', '重构计划文档'],
      },
      {
        title: '核心模块重构',
        description: '按优先级重构核心模块',
        subtaskTitles: ['模块拆分设计', '核心模块实现', '依赖关系调整'],
      },
      {
        title: '测试补齐',
        description: '为重构后代码补齐单元测试和集成测试',
        subtaskTitles: ['单元测试编写', '集成测试编写', '覆盖率验证'],
      },
      {
        title: '验证与上线',
        description: '回归测试 + 灰度上线',
        subtaskTitles: ['全量回归测试', '性能基准测试', '灰度上线', '上线后监控'],
      },
    ],
  },
  {
    name: 'learn-new-tech',
    displayName: '学习新技术',
    description: '系统学习一项新技术，从入门到实战',
    icon: '📚',
    defaultPriority: 'medium',
    titleTemplate: '学习 {techName}',
    descriptionTemplate: '系统学习 {techName}，从基础概念到项目实战',
    milestoneTemplates: [
      {
        title: '基础概念',
        description: '掌握核心概念和术语',
        subtaskTitles: ['阅读官方文档', '理解核心概念', '搭建开发环境', 'Hello World 示例'],
      },
      {
        title: '深入实践',
        description: '通过小项目巩固知识',
        subtaskTitles: ['小型练习项目', '常见模式学习', '调试技巧掌握'],
      },
      {
        title: '项目实战',
        description: '在真实项目中应用',
        subtaskTitles: ['实战项目设计', '核心功能实现', '最佳实践总结'],
      },
      {
        title: '知识沉淀',
        description: '总结输出，形成知识体系',
        subtaskTitles: ['技术博客撰写', '知识图谱整理', '团队分享'],
      },
    ],
  },
  {
    name: 'product-iteration',
    displayName: '完成产品迭代',
    description: '从需求到上线的完整产品迭代',
    icon: '🚀',
    defaultPriority: 'high',
    titleTemplate: '{featureName} 产品迭代',
    descriptionTemplate: '完成 {featureName} 功能的产品迭代，从需求分析到上线发布',
    milestoneTemplates: [
      {
        title: '需求阶段',
        description: '需求收集、分析、评审',
        subtaskTitles: ['需求收集', '需求文档', '需求评审', '设计稿确认'],
      },
      {
        title: '开发阶段',
        description: '前后端开发与联调',
        subtaskTitles: ['技术方案设计', '后端 API 开发', '前端开发', '前后端联调'],
      },
      {
        title: '测试阶段',
        description: '功能测试、性能测试、用户测试',
        subtaskTitles: ['功能测试', '性能测试', 'Bug 修复', 'UAT 用户验收'],
      },
      {
        title: '发布阶段',
        description: '灰度发布、全量发布、监控',
        subtaskTitles: ['发布准备', '灰度发布', '全量发布', '线上监控'],
      },
    ],
  },
];

// ============ 主类 ============

export class GoalTracker {
  private log = logger.child({ module: 'GoalTracker' });

  /** 内存中的目标缓存（id → Goal） */
  private goals: Map<string, Goal> = new Map();

  /** 目标目录路径 */
  private goalsDir: string;

  /** 是否已初始化 */
  private initialized = false;

  /**
   * 构造函数
   *
   * @param dataDir 可选数据目录（用于测试隔离）；不传则使用 duanPath('goals')
   */
  constructor(dataDir?: string) {
    this.goalsDir = dataDir
      ? path.join(dataDir, 'goals')
      : duanPath('goals');
  }

  // ============ 初始化与持久化 ============

  /**
   * 初始化：创建目录 + 加载所有未完成目标
   *
   * 启动时调用，用于"中断恢复"功能。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      if (!fs.existsSync(this.goalsDir)) {
        fs.mkdirSync(this.goalsDir, { recursive: true });
        this.log.info('目标目录已创建', { dir: this.goalsDir });
      }
      await this.loadAllGoals();
      this.initialized = true;
      this.log.info('GoalTracker 初始化完成', { loadedGoals: this.goals.size });
    } catch (e) {
      this.log.error('GoalTracker 初始化失败', { error: (e as Error).message });
      // 初始化失败不阻断，运行时操作会按需处理
      this.initialized = true;
    }
  }

  /**
   * 加载所有目标文件
   */
  private async loadAllGoals(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.goalsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.goalsDir, file);
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const goal = JSON.parse(content) as Goal;
          if (goal && goal.id && goal.title) {
            this.goals.set(goal.id, goal);
          }
        } catch (e) {
          this.log.warn('加载目标文件失败，跳过', { file, error: (e as Error).message });
        }
      }
    } catch (e) {
      this.log.warn('读取目标目录失败', { error: (e as Error).message });
    }
  }

  /**
   * 持久化单个目标到文件
   */
  private async persistGoal(goalId: string): Promise<void> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      this.log.warn('持久化失败：目标不存在', { goalId });
      return;
    }
    const filePath = path.join(this.goalsDir, `${goalId}.json`);
    try {
      await atomicWriteJson(filePath, goal);
    } catch (e) {
      this.log.error('目标持久化失败', { goalId, error: (e as Error).message });
      throw e;
    }
  }

  /**
   * 同步持久化（用于构造/初始化场景）
   */
  private persistGoalSync(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    const filePath = path.join(this.goalsDir, `${goalId}.json`);
    try {
      atomicWriteJsonSync(filePath, goal);
    } catch (e) {
      this.log.error('目标同步持久化失败', { goalId, error: (e as Error).message });
      throw e;
    }
  }

  /**
   * 删除目标文件
   */
  private async deleteGoalFile(goalId: string): Promise<void> {
    const filePath = path.join(this.goalsDir, `${goalId}.json`);
    try {
      await fs.promises.unlink(filePath);
    } catch (e) {
      // 文件不存在视为成功
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn('删除目标文件失败', { goalId, error: (e as Error).message });
      }
    }
  }

  // ============ 目标 CRUD ============

  /**
   * 创建新目标
   *
   * @param title 目标标题
   * @param description 目标描述
   * @param options 选项（优先级、标签、截止日期、上下文）
   * @returns 创建结果
   */
  async createGoal(
    title: string,
    description: string,
    options?: {
      priority?: GoalPriority;
      tags?: string[];
      dueDate?: string;
      context?: Record<string, unknown>;
      fromTemplate?: string;
      milestones?: Array<{
        title: string;
        description?: string;
        dueDate?: string;
        subtasks?: Array<{ title: string; description?: string; estimatedMinutes?: number }>;
      }>;
    },
  ): Promise<OperationResult<Goal>> {
    if (!title || title.trim().length === 0) {
      return { success: false, error: '目标标题不能为空' };
    }
    if (!description || description.trim().length === 0) {
      return { success: false, error: '目标描述不能为空' };
    }

    const now = Date.now();
    const goalId = this.generateGoalId();
    const priority = options?.priority || 'medium';

    const milestones: Milestone[] = (options?.milestones || []).map((m, mi) => ({
      id: `milestone-${String(mi + 1).padStart(3, '0')}`,
      title: m.title,
      description: m.description,
      status: 'pending' as ItemStatus,
      subtasks: (m.subtasks || []).map((s, si) => ({
        id: `subtask-${mi + 1}-${String(si + 1).padStart(3, '0')}`,
        title: s.title,
        description: s.description,
        status: 'pending' as ItemStatus,
        createdAt: now,
        estimatedMinutes: s.estimatedMinutes,
      })),
      createdAt: now,
      dueDate: m.dueDate,
    }));

    const goal: Goal = {
      id: goalId,
      title: title.trim(),
      description: description.trim(),
      priority,
      status: 'planning',
      milestones,
      tags: options?.tags || [],
      createdAt: now,
      updatedAt: now,
      dueDate: options?.dueDate,
      fromTemplate: options?.fromTemplate,
      context: options?.context,
    };

    this.goals.set(goalId, goal);
    try {
      await this.persistGoal(goalId);
      this.log.info('目标已创建', { goalId, title });
      return { success: true, data: goal };
    } catch (e) {
      this.goals.delete(goalId);
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  /**
   * 从模板创建目标
   *
   * @param templateName 模板名称
   * @param variables 模板变量（如 { projectName: 'xxx' }）
   * @param options 额外选项
   */
  async createGoalFromTemplate(
    templateName: string,
    variables: Record<string, string>,
    options?: {
      priority?: GoalPriority;
      tags?: string[];
      dueDate?: string;
      context?: Record<string, unknown>;
    },
  ): Promise<OperationResult<Goal>> {
    const template = BUILTIN_GOAL_TEMPLATES.find(t => t.name === templateName);
    if (!template) {
      return { success: false, error: `未知模板: ${templateName}（可用: ${BUILTIN_GOAL_TEMPLATES.map(t => t.name).join(', ')}）` };
    }

    // 替换模板变量
    let title = template.titleTemplate;
    let description = template.descriptionTemplate;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      title = title.split(placeholder).join(value);
      description = description.split(placeholder).join(value);
    }

    // 检查未替换的占位符
    const unreplacedTitle = title.match(/\{(\w+)\}/);
    if (unreplacedTitle) {
      return { success: false, error: `模板变量 ${unreplacedTitle[1]} 未提供` };
    }

    const milestones = template.milestoneTemplates.map(m => ({
      title: m.title,
      description: m.description,
      subtasks: m.subtaskTitles.map(st => ({ title: st })),
    }));

    return this.createGoal(title, description, {
      priority: options?.priority || template.defaultPriority,
      tags: options?.tags,
      dueDate: options?.dueDate,
      context: options?.context,
      fromTemplate: templateName,
      milestones,
    });
  }

  /**
   * 获取目标
   */
  getGoal(goalId: string): Goal | null {
    return this.goals.get(goalId) || null;
  }

  /**
   * 列出所有目标（返回摘要）
   */
  listGoals(filter?: {
    status?: GoalStatus;
    priority?: GoalPriority;
    tag?: string;
  }): GoalSummary[] {
    const summaries: GoalSummary[] = [];
    for (const goal of this.goals.values()) {
      if (filter?.status && goal.status !== filter.status) continue;
      if (filter?.priority && goal.priority !== filter.priority) continue;
      if (filter?.tag && !(goal.tags || []).includes(filter.tag)) continue;

      summaries.push(this.toSummary(goal));
    }
    // 按更新时间倒序
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /**
   * 更新目标状态
   */
  async updateGoalStatus(goalId: string, status: GoalStatus): Promise<OperationResult<Goal>> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }

    goal.status = status;
    goal.updatedAt = Date.now();
    if (status === 'completed') {
      goal.completedAt = Date.now();
    }

    try {
      await this.persistGoal(goalId);
      this.log.info('目标状态已更新', { goalId, status });
      return { success: true, data: goal };
    } catch (e) {
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  /**
   * 删除目标
   */
  async deleteGoal(goalId: string): Promise<OperationResult> {
    if (!this.goals.has(goalId)) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }
    this.goals.delete(goalId);
    await this.deleteGoalFile(goalId);
    this.log.info('目标已删除', { goalId });
    return { success: true };
  }

  // ============ 里程碑操作 ============

  /**
   * 添加里程碑
   */
  async addMilestone(
    goalId: string,
    title: string,
    description?: string,
    dueDate?: string,
  ): Promise<OperationResult<Milestone>> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }
    if (!title || title.trim().length === 0) {
      return { success: false, error: '里程碑标题不能为空' };
    }

    const now = Date.now();
    const milestone: Milestone = {
      id: `milestone-${String(goal.milestones.length + 1).padStart(3, '0')}`,
      title: title.trim(),
      description,
      status: 'pending',
      subtasks: [],
      createdAt: now,
      dueDate,
    };
    goal.milestones.push(milestone);
    goal.updatedAt = now;

    try {
      await this.persistGoal(goalId);
      return { success: true, data: milestone };
    } catch (e) {
      // 回滚
      goal.milestones.pop();
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  /**
   * 更新里程碑状态
   */
  async updateMilestoneStatus(
    goalId: string,
    milestoneId: string,
    status: ItemStatus,
  ): Promise<OperationResult<Milestone>> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }

    const milestone = goal.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      return { success: false, error: `里程碑不存在: ${milestoneId}` };
    }

    const oldStatus = milestone.status;
    milestone.status = status;
    if (status === 'completed') {
      milestone.completedAt = Date.now();
    } else {
      milestone.completedAt = undefined;
    }
    goal.updatedAt = Date.now();

    try {
      await this.persistGoal(goalId);
      // 里程碑完成后检查目标是否也完成
      if (status === 'completed') {
        await this.checkGoalCompletion(goalId);
      }
      return { success: true, data: milestone };
    } catch (e) {
      // 回滚
      milestone.status = oldStatus;
      milestone.completedAt = status === 'completed' ? Date.now() : undefined;
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  // ============ 子任务操作 ============

  /**
   * 添加子任务到里程碑
   */
  async addSubtask(
    goalId: string,
    milestoneId: string,
    title: string,
    description?: string,
    estimatedMinutes?: number,
  ): Promise<OperationResult<SubTask>> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }

    const milestone = goal.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      return { success: false, error: `里程碑不存在: ${milestoneId}` };
    }
    if (!title || title.trim().length === 0) {
      return { success: false, error: '子任务标题不能为空' };
    }

    const now = Date.now();
    const subtaskNum = milestone.subtasks.length + 1;
    const milestoneNum = parseInt(milestone.id.split('-')[1] || '0', 10);
    const subtask: SubTask = {
      id: `subtask-${milestoneNum}-${String(subtaskNum).padStart(3, '0')}`,
      title: title.trim(),
      description,
      status: 'pending',
      createdAt: now,
      estimatedMinutes,
    };
    milestone.subtasks.push(subtask);
    goal.updatedAt = now;

    try {
      await this.persistGoal(goalId);
      return { success: true, data: subtask };
    } catch (e) {
      milestone.subtasks.pop();
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  /**
   * 更新子任务状态
   */
  async updateSubtaskStatus(
    goalId: string,
    milestoneId: string,
    subtaskId: string,
    status: ItemStatus,
    notes?: string,
  ): Promise<OperationResult<SubTask>> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }

    const milestone = goal.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      return { success: false, error: `里程碑不存在: ${milestoneId}` };
    }

    const subtask = milestone.subtasks.find(s => s.id === subtaskId);
    if (!subtask) {
      return { success: false, error: `子任务不存在: ${subtaskId}` };
    }

    const oldStatus = subtask.status;
    subtask.status = status;
    if (status === 'completed') {
      subtask.completedAt = Date.now();
    } else {
      subtask.completedAt = undefined;
    }
    if (notes !== undefined) {
      subtask.notes = notes;
    }
    goal.updatedAt = Date.now();

    try {
      await this.persistGoal(goalId);
      // 子任务完成或跳过时检查里程碑是否也完成（skipped 视为完成）
      if (status === 'completed' || status === 'skipped') {
        await this.checkMilestoneCompletion(goalId, milestoneId);
      }
      return { success: true, data: subtask };
    } catch (e) {
      subtask.status = oldStatus;
      subtask.completedAt = status === 'completed' ? Date.now() : undefined;
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  // ============ 自主迭代 ============

  /**
   * 获取下一个待推进的子任务
   *
   * 策略：
   * 1. 优先返回 active 状态目标下的 in_progress 子任务
   * 2. 其次返回 active 目标下第一个 pending 子任务
   * 3. 若目标处于 planning 状态且有 pending 子任务，自动激活目标并返回第一个子任务
   *
   * @returns 下一个子任务 + 所属目标/里程碑信息，或 null（无待办）
   */
  getNextSubtask(): {
    goal: Goal;
    milestone: Milestone;
    subtask: SubTask;
  } | null {
    // 1. 优先返回进行中的子任务
    for (const goal of this.goals.values()) {
      if (goal.status !== 'active') continue;
      for (const milestone of goal.milestones) {
        if (milestone.status === 'completed' || milestone.status === 'skipped') continue;
        for (const subtask of milestone.subtasks) {
          if (subtask.status === 'in_progress') {
            return { goal, milestone, subtask };
          }
        }
      }
    }

    // 2. 返回 active 目标下的 pending 子任务
    for (const goal of this.goals.values()) {
      if (goal.status !== 'active') continue;
      for (const milestone of goal.milestones) {
        if (milestone.status === 'completed' || milestone.status === 'skipped') continue;
        for (const subtask of milestone.subtasks) {
          if (subtask.status === 'pending') {
            return { goal, milestone, subtask };
          }
        }
      }
    }

    // 3. planning 状态的目标，自动激活并返回首个 pending 子任务
    for (const goal of this.goals.values()) {
      if (goal.status !== 'planning') continue;
      for (const milestone of goal.milestones) {
        if (milestone.status === 'completed' || milestone.status === 'skipped') continue;
        for (const subtask of milestone.subtasks) {
          if (subtask.status === 'pending') {
            // 提示调用方应激活此目标（这里不自动修改状态，避免隐藏副作用）
            this.log.info('发现 planning 状态目标有待办子任务，建议激活', {
              goalId: goal.id,
              subtaskId: subtask.id,
            });
            return { goal, milestone, subtask };
          }
        }
      }
    }

    return null;
  }

  /**
   * 推进到下一个子任务
   *
   * 把当前 in_progress 子任务标记为 completed，然后返回下一个 pending 子任务。
   *
   * @param currentGoalId 当前目标 ID
   * @param currentMilestoneId 当前里程碑 ID
   * @param currentSubtaskId 当前子任务 ID
   * @param actualMinutes 实际耗时
   * @param notes 完成备注
   * @returns 下一个子任务信息，或 null（无下一个）
   */
  async advanceToNextSubtask(
    currentGoalId: string,
    currentMilestoneId: string,
    currentSubtaskId: string,
    options?: { actualMinutes?: number; notes?: string },
  ): Promise<OperationResult<{ goal: Goal; milestone: Milestone; subtask: SubTask } | null>> {
    // 标记当前子任务完成
    const completeResult = await this.updateSubtaskStatus(
      currentGoalId,
      currentMilestoneId,
      currentSubtaskId,
      'completed',
      options?.notes,
    );
    if (!completeResult.success) {
      return { success: false, error: completeResult.error };
    }

    // 记录实际耗时
    const goal = this.goals.get(currentGoalId);
    if (goal && options?.actualMinutes !== undefined) {
      const milestone = goal.milestones.find(m => m.id === currentMilestoneId);
      const subtask = milestone?.subtasks.find(s => s.id === currentSubtaskId);
      if (subtask) {
        subtask.actualMinutes = options.actualMinutes;
        await this.persistGoal(currentGoalId);
      }
    }

    // 获取下一个
    const next = this.getNextSubtask();
    if (!next) {
      return { success: true, data: null };
    }
    return { success: true, data: next };
  }

  // ============ 中断恢复 ============

  /**
   * 获取需要恢复的目标（未完成的 active/paused 状态目标）
   *
   * 启动时调用，提示用户是否继续。
   */
  getResumableGoals(): GoalSummary[] {
    const resumable: GoalSummary[] = [];
    for (const goal of this.goals.values()) {
      if (goal.status === 'active' || goal.status === 'paused' || goal.status === 'planning') {
        resumable.push(this.toSummary(goal));
      }
    }
    resumable.sort((a, b) => b.updatedAt - a.updatedAt);
    return resumable;
  }

  /**
   * 恢复目标（将 paused 状态改为 active）
   */
  async resumeGoal(goalId: string): Promise<OperationResult<Goal>> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, error: `目标不存在: ${goalId}` };
    }
    if (goal.status !== 'paused' && goal.status !== 'planning') {
      return { success: false, error: `目标状态 ${goal.status} 不可恢复（仅 paused/planning 可恢复）` };
    }
    return this.updateGoalStatus(goalId, 'active');
  }

  // ============ 进度计算 ============

  /**
   * 计算目标进度（0-100）
   */
  calculateProgress(goalId: string): number {
    const goal = this.goals.get(goalId);
    if (!goal) return 0;

    const allSubtasks = goal.milestones.flatMap(m => m.subtasks);
    if (allSubtasks.length === 0) return 0;

    const completed = allSubtasks.filter(s => s.status === 'completed').length;
    return Math.round((completed / allSubtasks.length) * 100);
  }

  /**
   * 生成目标摘要
   */
  private toSummary(goal: Goal): GoalSummary {
    const totalMilestones = goal.milestones.length;
    const completedMilestones = goal.milestones.filter(m => m.status === 'completed').length;
    const allSubtasks = goal.milestones.flatMap(m => m.subtasks);
    const totalSubtasks = allSubtasks.length;
    const completedSubtasks = allSubtasks.filter(s => s.status === 'completed').length;

    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      priority: goal.priority,
      progress: totalSubtasks === 0 ? 0 : Math.round((completedSubtasks / totalSubtasks) * 100),
      totalMilestones,
      completedMilestones,
      totalSubtasks,
      completedSubtasks,
      dueDate: goal.dueDate,
      updatedAt: goal.updatedAt,
    };
  }

  /**
   * 检查里程碑是否完成（所有子任务完成则自动标记里程碑完成）
   */
  private async checkMilestoneCompletion(goalId: string, milestoneId: string): Promise<void> {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    const milestone = goal.milestones.find(m => m.id === milestoneId);
    if (!milestone || milestone.status === 'completed') return;

    const allCompleted = milestone.subtasks.length > 0 &&
      milestone.subtasks.every(s => s.status === 'completed' || s.status === 'skipped');

    if (allCompleted) {
      milestone.status = 'completed';
      milestone.completedAt = Date.now();
      await this.persistGoal(goalId);
      this.log.info('里程碑已自动完成', { goalId, milestoneId: milestone.id, title: milestone.title });

      // 检查目标是否也完成
      await this.checkGoalCompletion(goalId);
    }
  }

  /**
   * 检查目标是否完成（所有里程碑完成则自动标记目标完成）
   */
  private async checkGoalCompletion(goalId: string): Promise<void> {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === 'completed') return;

    const allCompleted = goal.milestones.length > 0 &&
      goal.milestones.every(m => m.status === 'completed' || m.status === 'skipped');

    if (allCompleted) {
      goal.status = 'completed';
      goal.completedAt = Date.now();
      goal.updatedAt = Date.now();
      await this.persistGoal(goalId);
      this.log.info('目标已自动完成', { goalId, title: goal.title });
    }
  }

  // ============ 工具方法 ============

  /**
   * 生成目标 ID
   */
  private generateGoalId(): string {
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const random = Math.random().toString(36).substring(2, 8);
    return `goal-${dateStr}-${random}`;
  }

  /**
   * 获取目标详细报告（用于展示）
   */
  getGoalReport(goalId: string): string {
    const goal = this.goals.get(goalId);
    if (!goal) return `❌ 目标不存在: ${goalId}`;

    const lines: string[] = [];
    const progress = this.calculateProgress(goalId);
    const priorityIcon = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[goal.priority];
    const statusIcon = {
      planning: '📋',
      active: '🚀',
      paused: '⏸️',
      completed: '✅',
      abandoned: '❌',
    }[goal.status];

    lines.push(`${statusIcon} ${goal.title} ${priorityIcon}`);
    lines.push(`   ID: ${goal.id}`);
    lines.push(`   状态: ${goal.status} | 优先级: ${goal.priority} | 进度: ${progress}%`);
    if (goal.dueDate) lines.push(`   截止日期: ${goal.dueDate}`);
    lines.push(`   ${goal.description}`);
    lines.push('');

    for (const milestone of goal.milestones) {
      const mIcon = {
        pending: '⬜',
        in_progress: '🔄',
        completed: '✅',
        skipped: '⏭️',
        blocked: '🚫',
      }[milestone.status];
      const mProgress = milestone.subtasks.length === 0
        ? 0
        : Math.round((milestone.subtasks.filter(s => s.status === 'completed').length / milestone.subtasks.length) * 100);

      lines.push(`  ${mIcon} ${milestone.title} (${mProgress}%)`);
      if (milestone.description) lines.push(`     ${milestone.description}`);

      for (const subtask of milestone.subtasks) {
        const sIcon = {
          pending: '⬜',
          in_progress: '🔄',
          completed: '✅',
          skipped: '⏭️',
          blocked: '🚫',
        }[subtask.status];
        lines.push(`     ${sIcon} ${subtask.title}`);
        if (subtask.notes) lines.push(`        备注: ${subtask.notes}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 列出可用模板
   */
  listTemplates(): GoalTemplate[] {
    return [...BUILTIN_GOAL_TEMPLATES];
  }

  /**
   * 获取所有目标摘要（用于 LLM 工具展示）
   */
  getOverview(): string {
    const summaries = this.listGoals();
    if (summaries.length === 0) {
      return '📋 暂无目标。使用 goal_create 或 goal_create_from_template 创建新目标。';
    }

    const lines: string[] = [`📋 长期目标（共 ${summaries.length} 个）`, ''];
    for (const s of summaries) {
      const statusIcon = {
        planning: '📋',
        active: '🚀',
        paused: '⏸️',
        completed: '✅',
        abandoned: '❌',
      }[s.status];
      const priorityIcon = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[s.priority];
      lines.push(`${statusIcon} ${priorityIcon} ${s.title} [${s.progress}%]`);
      lines.push(`   ID: ${s.id}`);
      lines.push(`   里程碑: ${s.completedMilestones}/${s.totalMilestones} | 子任务: ${s.completedSubtasks}/${s.totalSubtasks}`);
      if (s.dueDate) lines.push(`   截止: ${s.dueDate}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * v20.0 §3.7：暴露 goal 工具给 LLM
   *
   * 工具清单：
   * - goal_create              创建新目标
   * - goal_create_from_template 从模板创建目标
   * - goal_list                列出所有目标
   * - goal_info                查看目标详情
   * - goal_progress            查看下一个待推进子任务
   * - goal_advance             推进子任务（标记完成 + 返回下一个）
   * - goal_update_status       更新目标状态（active/paused/completed/abandoned）
   * - goal_add_subtask         添加子任务
   * - goal_complete_subtask    完成子任务
   * - goal_delete              删除目标
   * - goal_template_list       列出可用模板
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'goal_create',
        description: '创建长期目标。目标可分解为里程碑 → 子任务，跨会话追踪进度。适用于"重构项目""学习新技术"等需要多步骤完成的目标。',
        parameters: {
          title: { type: 'string', description: '目标标题', required: true },
          description: { type: 'string', description: '目标描述', required: true },
          priority: { type: 'string', description: '优先级: low/medium/high/critical（默认 medium）', required: false },
          dueDate: { type: 'string', description: '截止日期（YYYY-MM-DD）', required: false },
          tags: { type: 'array', description: '标签列表', required: false },
        },
        execute: async (args: { title?: string; description?: string; priority?: string; dueDate?: string; tags?: string[] }) => {
          if (!args?.title || !args?.description) {
            return '❌ 缺少必填参数: title, description';
          }
          const validPriorities: GoalPriority[] = ['low', 'medium', 'high', 'critical'];
          const priority = (args.priority as GoalPriority) || 'medium';
          if (args.priority && !validPriorities.includes(priority)) {
            return `❌ 无效优先级: ${args.priority}（应为 low/medium/high/critical）`;
          }
          const result = await this.createGoal(args.title, args.description, {
            priority,
            dueDate: args.dueDate,
            tags: args.tags,
          });
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 目标已创建: ${result.data!.title} (${result.data!.id})`;
        },
      },
      {
        name: 'goal_create_from_template',
        description: '从内置模板创建目标。可用模板：refactor-project（重构项目）、learn-new-tech（学习新技术）、product-iteration（完成产品迭代）。',
        parameters: {
          template: { type: 'string', description: '模板名称: refactor-project/learn-new-tech/product-iteration', required: true },
          variables: { type: 'object', description: '模板变量（如 { projectName: "xxx" } 或 { techName: "React" }）', required: true },
          priority: { type: 'string', description: '优先级（默认使用模板优先级）', required: false },
          dueDate: { type: 'string', description: '截止日期（YYYY-MM-DD）', required: false },
        },
        execute: async (args: { template?: string; variables?: Record<string, string>; priority?: string; dueDate?: string }) => {
          if (!args?.template) return '❌ 缺少 template 参数';
          if (!args?.variables) return '❌ 缺少 variables 参数';
          const result = await this.createGoalFromTemplate(args.template, args.variables, {
            priority: args.priority as GoalPriority | undefined,
            dueDate: args.dueDate,
          });
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 目标已从模板创建: ${result.data!.title} (${result.data!.id})`;
        },
      },
      {
        name: 'goal_list',
        description: '列出所有长期目标及其进度摘要。',
        parameters: {
          status: { type: 'string', description: '按状态过滤: planning/active/paused/completed/abandoned', required: false },
        },
        execute: async (args: { status?: string }) => {
          const filter = args?.status ? { status: args.status as GoalStatus } : undefined;
          const summaries = this.listGoals(filter);
          if (summaries.length === 0) {
            return '📋 暂无目标。';
          }
          const lines = [`📋 目标列表（${summaries.length} 个）`, ''];
          for (const s of summaries) {
            lines.push(`• [${s.progress}%] ${s.title} (${s.id})`);
            lines.push(`  状态: ${s.status} | 优先级: ${s.priority} | 里程碑: ${s.completedMilestones}/${s.totalMilestones} | 子任务: ${s.completedSubtasks}/${s.totalSubtasks}`);
          }
          return lines.join('\n');
        },
      },
      {
        name: 'goal_info',
        description: '查看目标详细信息，包括里程碑和子任务的完整状态树。',
        parameters: {
          goalId: { type: 'string', description: '目标 ID', required: true },
        },
        execute: async (args: { goalId?: string }) => {
          if (!args?.goalId) return '❌ 缺少 goalId 参数';
          return this.getGoalReport(args.goalId);
        },
      },
      {
        name: 'goal_progress',
        description: '获取下一个待推进的子任务。Agent 空闲时可调用此工具自主推进目标。',
        parameters: {},
        execute: async () => {
          const next = this.getNextSubtask();
          if (!next) {
            return '✅ 所有目标均无待推进的子任务。';
          }
          const lines = [
            `🎯 下一个待推进子任务:`,
            `   目标: ${next.goal.title} (${next.goal.id})`,
            `   里程碑: ${next.milestone.title} (${next.milestone.id})`,
            `   子任务: ${next.subtask.title} (${next.subtask.id})`,
            `   状态: ${next.subtask.status}`,
          ];
          if (next.subtask.description) lines.push(`   描述: ${next.subtask.description}`);
          if (next.goal.status === 'planning') {
            lines.push(`   ⚠️ 目标处于 planning 状态，建议先用 goal_update_status 激活为 active`);
          }
          return lines.join('\n');
        },
      },
      {
        name: 'goal_advance',
        description: '推进子任务：标记当前子任务为完成，并返回下一个待办子任务。用于自主迭代。',
        parameters: {
          goalId: { type: 'string', description: '目标 ID', required: true },
          milestoneId: { type: 'string', description: '里程碑 ID', required: true },
          subtaskId: { type: 'string', description: '子任务 ID', required: true },
          actualMinutes: { type: 'number', description: '实际耗时（分钟）', required: false },
          notes: { type: 'string', description: '完成备注', required: false },
        },
        execute: async (args: { goalId?: string; milestoneId?: string; subtaskId?: string; actualMinutes?: number; notes?: string }) => {
          if (!args?.goalId || !args?.milestoneId || !args?.subtaskId) {
            return '❌ 缺少必填参数: goalId, milestoneId, subtaskId';
          }
          const result = await this.advanceToNextSubtask(
            args.goalId,
            args.milestoneId,
            args.subtaskId,
            { actualMinutes: args.actualMinutes, notes: args.notes },
          );
          if (!result.success) return `❌ ${result.error}`;
          if (!result.data) {
            return '🎉 当前目标的最后一个子任务已完成！目标可能已自动标记为 completed。';
          }
          const next = result.data;
          return `✅ 子任务已完成，下一个待推进:\n   目标: ${next.goal.title}\n   里程碑: ${next.milestone.title}\n   子任务: ${next.subtask.title} (${next.subtask.id})`;
        },
      },
      {
        name: 'goal_update_status',
        description: '更新目标状态。可激活/暂停/完成/放弃目标。',
        parameters: {
          goalId: { type: 'string', description: '目标 ID', required: true },
          status: { type: 'string', description: '新状态: planning/active/paused/completed/abandoned', required: true },
        },
        execute: async (args: { goalId?: string; status?: string }) => {
          if (!args?.goalId || !args?.status) return '❌ 缺少必填参数: goalId, status';
          const validStatuses: GoalStatus[] = ['planning', 'active', 'paused', 'completed', 'abandoned'];
          if (!validStatuses.includes(args.status as GoalStatus)) {
            return `❌ 无效状态: ${args.status}（应为 ${validStatuses.join('/')}）`;
          }
          const result = await this.updateGoalStatus(args.goalId, args.status as GoalStatus);
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 目标状态已更新: ${result.data!.title} → ${args.status}`;
        },
      },
      {
        name: 'goal_add_subtask',
        description: '为指定里程碑添加子任务。',
        parameters: {
          goalId: { type: 'string', description: '目标 ID', required: true },
          milestoneId: { type: 'string', description: '里程碑 ID', required: true },
          title: { type: 'string', description: '子任务标题', required: true },
          description: { type: 'string', description: '子任务描述', required: false },
          estimatedMinutes: { type: 'number', description: '预计耗时（分钟）', required: false },
        },
        execute: async (args: { goalId?: string; milestoneId?: string; title?: string; description?: string; estimatedMinutes?: number }) => {
          if (!args?.goalId || !args?.milestoneId || !args?.title) {
            return '❌ 缺少必填参数: goalId, milestoneId, title';
          }
          const result = await this.addSubtask(
            args.goalId,
            args.milestoneId,
            args.title,
            args.description,
            args.estimatedMinutes,
          );
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 子任务已添加: ${result.data!.title} (${result.data!.id})`;
        },
      },
      {
        name: 'goal_complete_subtask',
        description: '直接标记子任务为完成（不使用 advance 自动链接下一个）。会触发里程碑/目标的自动完成检查。',
        parameters: {
          goalId: { type: 'string', description: '目标 ID', required: true },
          milestoneId: { type: 'string', description: '里程碑 ID', required: true },
          subtaskId: { type: 'string', description: '子任务 ID', required: true },
          notes: { type: 'string', description: '完成备注', required: false },
        },
        execute: async (args: { goalId?: string; milestoneId?: string; subtaskId?: string; notes?: string }) => {
          if (!args?.goalId || !args?.milestoneId || !args?.subtaskId) {
            return '❌ 缺少必填参数: goalId, milestoneId, subtaskId';
          }
          const result = await this.updateSubtaskStatus(
            args.goalId,
            args.milestoneId,
            args.subtaskId,
            'completed',
            args.notes,
          );
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 子任务已完成: ${result.data!.title}`;
        },
      },
      {
        name: 'goal_delete',
        description: '删除目标（不可恢复）。',
        parameters: {
          goalId: { type: 'string', description: '目标 ID', required: true },
        },
        execute: async (args: { goalId?: string }) => {
          if (!args?.goalId) return '❌ 缺少 goalId 参数';
          const result = await this.deleteGoal(args.goalId);
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 目标已删除: ${args.goalId}`;
        },
      },
      {
        name: 'goal_template_list',
        description: '列出可用的目标模板（refactor-project / learn-new-tech / product-iteration）。',
        parameters: {},
        execute: async () => {
          const templates = this.listTemplates();
          const lines = [`📋 可用目标模板（${templates.length} 个）`, ''];
          for (const t of templates) {
            lines.push(`${t.icon} ${t.name} — ${t.displayName}`);
            lines.push(`   ${t.description}`);
            lines.push(`   里程碑数: ${t.milestoneTemplates.length}`);
            lines.push('');
          }
          return lines.join('\n');
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: GoalTracker | null = null;

export function getGoalTracker(): GoalTracker {
  if (!_instance) {
    _instance = new GoalTracker();
  }
  return _instance;
}
