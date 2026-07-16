/**
 * v20.0 §3.4 自主工程任务 — AutonomousEngineer
 *
 * 对标 Devin：接收高层需求 → 自主完成"设计 + 编码 + 测试 + 部署"全链路。
 *
 * 核心能力：
 * 1. 需求分解：高层需求 → 5 个标准工程阶段
 * 2. 阶段流水线：需求分析 → 架构设计 → 编码实现 → 测试验证 → 部署上线
 * 3. 子代理派发：每阶段调用对应专用子代理（architect/test-engineer 等）
 * 4. 失败重试：阶段失败自动重试（最大 3 次），重试次数耗尽则中止
 * 5. 产出物追踪：每阶段产出 artifacts（文档/代码/测试报告）
 * 6. 持久化：工程任务状态持久化到 ~/.duan/engineering/<task-id>.json
 * 7. 中断恢复：启动时加载未完成任务，可继续执行
 * 8. 部署目标：local / docker / vercel / netlify
 * 9. 端到端验证：部署后自动跑验证测试
 *
 * 与现有系统的关系：
 *   - 复用 SubAgentPresetRegistry 的预设（architect/test-engineer 等）
 *   - 复用 atomic-write 的原子写入
 *   - 与 GoalTracker 互补：GoalTracker 追踪长期目标，AutonomousEngineer 执行具体工程任务
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJson } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 工程阶段名称 */
export type EngineeringPhase =
  | 'requirements'
  | 'design'
  | 'implementation'
  | 'testing'
  | 'deployment';

/** 阶段状态 */
export type PhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

/** 工程任务整体状态 */
export type EngineeringTaskStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'abandoned';

/** 部署目标 */
export type DeploymentTarget =
  | 'local'
  | 'docker'
  | 'vercel'
  | 'netlify'
  | 'k8s'
  | 'none';

/** 阶段产出物 */
export interface Artifact {
  /** 产出物类型（document / code / test_report / config / deployment_log） */
  type: string;
  /** 标题 */
  title: string;
  /** 内容（文本）或文件路径 */
  content?: string;
  filePath?: string;
  /** 生成时间 */
  generatedAt: number;
}

/** 阶段执行记录 */
export interface PhaseRecord {
  /** 阶段名 */
  phase: EngineeringPhase;
  /** 状态 */
  status: PhaseStatus;
  /** 关联子代理预设（如 architect / test-engineer） */
  subagentPreset?: string;
  /** 开始时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 执行日志 */
  logs: string[];
  /** 产出物 */
  artifacts: Artifact[];
  /** 错误信息 */
  error?: string;
  /** 输入（前序阶段的产出摘要） */
  input?: string;
  /** 输出（本阶段的产出摘要，传给下一阶段） */
  output?: string;
}

/** 工程任务 */
export interface EngineeringTask {
  /** 任务 ID */
  id: string;
  /** 高层需求（用户原始输入） */
  requirement: string;
  /** 任务标题（从需求提炼） */
  title: string;
  /** 状态 */
  status: EngineeringTaskStatus;
  /** 部署目标 */
  deploymentTarget: DeploymentTarget;
  /** 阶段记录（按执行顺序） */
  phases: PhaseRecord[];
  /** 当前阶段索引 */
  currentPhaseIndex: number;
  /** 项目根目录（沙箱） */
  projectRoot?: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 标签 */
  tags?: string[];
  /** 上下文（关联目标 ID 等） */
  context?: Record<string, unknown>;
}

/** 工程任务摘要 */
export interface EngineeringTaskSummary {
  id: string;
  title: string;
  status: EngineeringTaskStatus;
  deploymentTarget: DeploymentTarget;
  currentPhase: EngineeringPhase | null;
  completedPhases: number;
  totalPhases: number;
  progress: number; // 0-100
  createdAt: number;
  updatedAt: number;
}

/** 阶段执行结果 */
export interface PhaseExecutionResult {
  success: boolean;
  output?: string;
  artifacts?: Artifact[];
  error?: string;
  logs?: string[];
}

/** 操作结果 */
export interface OperationResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

// ============ 阶段配置 ============

/** 阶段定义 */
interface PhaseConfig {
  /** 阶段名 */
  phase: EngineeringPhase;
  /** 显示名称 */
  displayName: string;
  /** 图标 */
  icon: string;
  /** 关联子代理预设名 */
  subagentPreset: string;
  /** 阶段描述模板（{requirement} 会被替换） */
  promptTemplate: string;
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
}

/** 5 个标准工程阶段配置 */
export const ENGINEERING_PHASES: PhaseConfig[] = [
  {
    phase: 'requirements',
    displayName: '需求分析',
    icon: '📋',
    subagentPreset: 'architect',
    promptTemplate: `你是需求分析师。请分析以下需求，输出：
1. 功能需求清单（必须实现的功能）
2. 非功能需求（性能/安全/兼容性）
3. 验收标准（可测试的）
4. 风险点

需求：{requirement}`,
    defaultMaxRetries: 2,
  },
  {
    phase: 'design',
    displayName: '架构设计',
    icon: '🏗️',
    subagentPreset: 'architect',
    promptTemplate: `你是架构师。基于以下需求和需求分析结果，设计技术方案：
1. 技术选型（框架/库/数据库）
2. 模块划分（组件图）
3. 接口契约（API 定义）
4. 数据模型
5. 部署架构

需求：{requirement}
前序阶段产出：
{previous_output}`,
    defaultMaxRetries: 2,
  },
  {
    phase: 'implementation',
    displayName: '编码实现',
    icon: '💻',
    subagentPreset: 'test-engineer',
    promptTemplate: `你是全栈工程师。基于以下架构设计，实现代码：
1. 按模块划分实现
2. 遵循设计契约
3. 编写单元测试
4. 提交可运行代码

需求：{requirement}
架构设计：
{previous_output}`,
    defaultMaxRetries: 3,
  },
  {
    phase: 'testing',
    displayName: '测试验证',
    icon: '🧪',
    subagentPreset: 'test-engineer',
    promptTemplate: `你是测试工程师。对以下实现进行测试：
1. 运行单元测试，报告覆盖率
2. 运行集成测试
3. 执行端到端测试
4. 输出测试报告（通过/失败/覆盖率）

需求：{requirement}
实现产出：
{previous_output}`,
    defaultMaxRetries: 3,
  },
  {
    phase: 'deployment',
    displayName: '部署上线',
    icon: '🚀',
    subagentPreset: 'researcher',
    promptTemplate: `你是 DevOps 工程师。将以下项目部署到 {deployment_target}：
1. 生成部署配置（Dockerfile / vercel.json / k8s manifests）
2. 执行部署（或提供部署命令）
3. 验证部署是否成功
4. 输出部署日志和访问地址

项目产出：
{previous_output}`,
    defaultMaxRetries: 2,
  },
];

// ============ 主类 ============

export class AutonomousEngineer {
  private log = logger.child({ module: 'AutonomousEngineer' });

  /** 内存中的任务缓存（id → EngineeringTask） */
  private tasks: Map<string, EngineeringTask> = new Map();

  /** 工程任务目录 */
  private tasksDir: string;

  /** 是否已初始化 */
  private initialized = false;

  /**
   * 阶段执行器（可注入，默认为模拟执行）
   *
   * 实际生产中由 EnhancedAgentLoop 注入：调用 SubAgentOrchestrator 派发预设子代理。
   * 测试时注入 mock 执行器以隔离。
   */
  private phaseExecutor: ((task: EngineeringTask, phase: PhaseRecord, prompt: string) => Promise<PhaseExecutionResult>) | null = null;

  /**
   * 构造函数
   *
   * @param dataDir 可选数据目录（用于测试隔离）
   */
  constructor(dataDir?: string) {
    this.tasksDir = dataDir
      ? path.join(dataDir, 'engineering')
      : duanPath('engineering');
  }

  // ============ 初始化与持久化 ============

  /**
   * 初始化：创建目录 + 加载所有未完成任务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      if (!fs.existsSync(this.tasksDir)) {
        fs.mkdirSync(this.tasksDir, { recursive: true });
        this.log.info('工程任务目录已创建', { dir: this.tasksDir });
      }
      await this.loadAllTasks();
      this.initialized = true;
      this.log.info('AutonomousEngineer 初始化完成', { loadedTasks: this.tasks.size });
    } catch (e) {
      this.log.error('AutonomousEngineer 初始化失败', { error: (e as Error).message });
      this.initialized = true;
    }
  }

  /**
   * 加载所有任务文件
   */
  private async loadAllTasks(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.tasksDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.tasksDir, file);
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const task = JSON.parse(content) as EngineeringTask;
          if (task && task.id && task.title && task.requirement) {
            this.tasks.set(task.id, task);
          }
        } catch (e) {
          this.log.warn('加载工程任务文件失败，跳过', { file, error: (e as Error).message });
        }
      }
    } catch (e) {
      this.log.warn('读取工程任务目录失败', { error: (e as Error).message });
    }
  }

  /**
   * 持久化单个任务
   */
  private async persistTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const filePath = path.join(this.tasksDir, `${taskId}.json`);
    try {
      await atomicWriteJson(filePath, task);
    } catch (e) {
      this.log.error('工程任务持久化失败', { taskId, error: (e as Error).message });
      throw e;
    }
  }

  /**
   * 删除任务文件
   */
  private async deleteTaskFile(taskId: string): Promise<void> {
    const filePath = path.join(this.tasksDir, `${taskId}.json`);
    try {
      await fs.promises.unlink(filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn('删除任务文件失败', { taskId, error: (e as Error).message });
      }
    }
  }

  // ============ 阶段执行器注入 ============

  /**
   * 注入阶段执行器
   *
   * 由 EnhancedAgentLoop 在启动时注入，将阶段执行委托给 SubAgentOrchestrator。
   * 未注入时使用默认模拟执行器（仅记录日志，返回成功）。
   */
  setPhaseExecutor(
    executor: (task: EngineeringTask, phase: PhaseRecord, prompt: string) => Promise<PhaseExecutionResult>,
  ): void {
    this.phaseExecutor = executor;
    this.log.info('阶段执行器已注入');
  }

  /**
   * 默认模拟执行器（用于无 SubAgentOrchestrator 的场景，如测试）
   */
  private defaultExecutor = async (
    _task: EngineeringTask,
    phase: PhaseRecord,
    prompt: string,
  ): Promise<PhaseExecutionResult> => {
    this.log.info('模拟执行阶段（未注入实际执行器）', { phase: phase.phase });
    return {
      success: true,
      output: `【模拟执行】${phase.phase} 阶段已完成。Prompt 长度: ${prompt.length}`,
      artifacts: [
        {
          type: 'document',
          title: `${phase.phase}-mock-output`,
          content: `模拟产出物（phase=${phase.phase}）`,
          generatedAt: Date.now(),
        },
      ],
      logs: [`[mock] 执行阶段 ${phase.phase}`],
    };
  };

  // ============ 任务 CRUD ============

  /**
   * 创建新工程任务
   */
  async createTask(
    requirement: string,
    options?: {
      title?: string;
      deploymentTarget?: DeploymentTarget;
      projectRoot?: string;
      tags?: string[];
      context?: Record<string, unknown>;
    },
  ): Promise<OperationResult<EngineeringTask>> {
    if (!requirement || requirement.trim().length === 0) {
      return { success: false, error: '需求不能为空' };
    }

    const now = Date.now();
    const taskId = this.generateTaskId();
    const title = options?.title || this.deriveTitle(requirement);
    const deploymentTarget = options?.deploymentTarget || 'local';

    // 初始化 5 个阶段记录
    const phases: PhaseRecord[] = ENGINEERING_PHASES.map(config => ({
      phase: config.phase,
      status: 'pending' as PhaseStatus,
      subagentPreset: config.subagentPreset,
      retryCount: 0,
      maxRetries: config.defaultMaxRetries,
      logs: [],
      artifacts: [],
    }));

    const task: EngineeringTask = {
      id: taskId,
      requirement: requirement.trim(),
      title,
      status: 'created',
      deploymentTarget,
      phases,
      currentPhaseIndex: 0,
      projectRoot: options?.projectRoot,
      createdAt: now,
      updatedAt: now,
      tags: options?.tags || [],
      context: options?.context,
    };

    this.tasks.set(taskId, task);
    try {
      await this.persistTask(taskId);
      this.log.info('工程任务已创建', { taskId, title, deploymentTarget });
      return { success: true, data: task };
    } catch (e) {
      this.tasks.delete(taskId);
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): EngineeringTask | null {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 列出所有任务（摘要）
   */
  listTasks(filter?: {
    status?: EngineeringTaskStatus;
    deploymentTarget?: DeploymentTarget;
    tag?: string;
  }): EngineeringTaskSummary[] {
    const summaries: EngineeringTaskSummary[] = [];
    for (const task of this.tasks.values()) {
      if (filter?.status && task.status !== filter.status) continue;
      if (filter?.deploymentTarget && task.deploymentTarget !== filter.deploymentTarget) continue;
      if (filter?.tag && !(task.tags || []).includes(filter.tag)) continue;

      summaries.push(this.toSummary(task));
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId: string, status: EngineeringTaskStatus): Promise<OperationResult<EngineeringTask>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }
    task.status = status;
    task.updatedAt = Date.now();
    if (status === 'completed' || status === 'failed' || status === 'abandoned') {
      task.completedAt = Date.now();
    }
    try {
      await this.persistTask(taskId);
      return { success: true, data: task };
    } catch (e) {
      return { success: false, error: `持久化失败: ${(e as Error).message}` };
    }
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<OperationResult> {
    if (!this.tasks.has(taskId)) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }
    this.tasks.delete(taskId);
    await this.deleteTaskFile(taskId);
    this.log.info('工程任务已删除', { taskId });
    return { success: true };
  }

  // ============ 阶段执行流水线 ============

  /**
   * 启动/继续执行任务
   *
   * 从 currentPhaseIndex 开始执行，直到所有阶段完成或某阶段失败（重试耗尽）。
   */
  async runTask(taskId: string): Promise<OperationResult<EngineeringTask>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }
    if (task.status === 'completed') {
      return { success: false, error: '任务已完成，无需再次执行' };
    }
    if (task.status === 'running') {
      return { success: false, error: '任务正在执行中' };
    }

    task.status = 'running';
    task.updatedAt = Date.now();
    await this.persistTask(taskId);

    const executor = this.phaseExecutor || this.defaultExecutor;

    try {
      while (task.currentPhaseIndex < task.phases.length) {
        const phase = task.phases[task.currentPhaseIndex];
        const config = ENGINEERING_PHASES.find(c => c.phase === phase.phase)!;

        // 跳过已完成的阶段（如中断恢复时）
        if (phase.status === 'completed') {
          task.currentPhaseIndex++;
          continue;
        }

        // 构造 prompt
        const prompt = this.buildPhasePrompt(task, config);

        // 执行阶段（带重试）
        phase.status = 'in_progress';
        phase.startedAt = Date.now();
        phase.logs.push(`[${new Date().toISOString()}] 开始执行阶段 ${config.displayName}`);
        task.updatedAt = Date.now();
        await this.persistTask(taskId);

        let phaseResult: PhaseExecutionResult | null = null;
        let attempt = 0;
        const maxAttempts = phase.maxRetries + 1;

        while (attempt < maxAttempts) {
          attempt++;
          phase.logs.push(`[${new Date().toISOString()}] 第 ${attempt}/${maxAttempts} 次尝试`);

          try {
            phaseResult = await executor(task, phase, prompt);
            if (phaseResult.success) {
              break;
            }
          } catch (e) {
            phaseResult = {
              success: false,
              error: (e as Error).message,
              logs: [`[exception] ${(e as Error).message}`],
            };
          }

          phase.logs.push(`[${new Date().toISOString()}] 尝试失败: ${phaseResult.error || '未知错误'}`);

          if (attempt < maxAttempts) {
            phase.retryCount++;
            phase.logs.push(`[${new Date().toISOString()}] 准备重试...`);
          }
        }

        // 处理阶段结果
        if (phaseResult && phaseResult.success) {
          phase.status = 'completed';
          phase.completedAt = Date.now();
          phase.output = phaseResult.output || '';
          phase.artifacts = phaseResult.artifacts || [];
          if (phaseResult.logs) {
            phase.logs.push(...phaseResult.logs);
          }
          phase.logs.push(`[${new Date().toISOString()}] 阶段完成`);
          // 下一阶段的 input 使用本阶段的 output
          if (task.currentPhaseIndex + 1 < task.phases.length) {
            task.phases[task.currentPhaseIndex + 1].input = phase.output;
          }
          task.currentPhaseIndex++;
          this.log.info('阶段完成', { taskId, phase: phase.phase });
        } else {
          phase.status = 'failed';
          phase.error = phaseResult?.error || '所有重试均失败';
          phase.logs.push(`[${new Date().toISOString()}] 阶段失败: ${phase.error}`);
          task.status = 'failed';
          task.completedAt = Date.now();
          task.updatedAt = Date.now();
          await this.persistTask(taskId);
          this.log.error('工程任务阶段失败，中止', { taskId, phase: phase.phase, error: phase.error });
          return { success: false, error: `阶段 ${phase.phase} 失败: ${phase.error}`, data: task };
        }

        task.updatedAt = Date.now();
        await this.persistTask(taskId);
      }

      // 所有阶段完成
      task.status = 'completed';
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      await this.persistTask(taskId);
      this.log.info('工程任务全部完成', { taskId, title: task.title });
      return { success: true, data: task };
    } catch (e) {
      task.status = 'failed';
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      await this.persistTask(taskId);
      const errMsg = (e as Error).message;
      this.log.error('工程任务执行异常', { taskId, error: errMsg });
      return { success: false, error: errMsg, data: task };
    }
  }

  /**
   * 构造阶段 prompt
   */
  private buildPhasePrompt(task: EngineeringTask, config: PhaseConfig): string {
    let prompt = config.promptTemplate;
    prompt = prompt.split('{requirement}').join(task.requirement);
    prompt = prompt.split('{deployment_target}').join(task.deploymentTarget);

    const prevPhaseIndex = task.phases.findIndex(p => p.phase === config.phase) - 1;
    const prevOutput = prevPhaseIndex >= 0 ? (task.phases[prevPhaseIndex].output || '（无前序产出）') : '（首个阶段，无前序产出）';
    prompt = prompt.split('{previous_output}').join(prevOutput);

    return prompt;
  }

  // ============ 中断恢复 ============

  /**
   * 获取可恢复的任务（running/paused/created 状态）
   */
  getResumableTasks(): EngineeringTaskSummary[] {
    const resumable: EngineeringTaskSummary[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'created' || task.status === 'running' || task.status === 'paused') {
        resumable.push(this.toSummary(task));
      }
    }
    resumable.sort((a, b) => b.updatedAt - a.updatedAt);
    return resumable;
  }

  /**
   * 暂停任务
   */
  async pauseTask(taskId: string): Promise<OperationResult<EngineeringTask>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }
    if (task.status !== 'running') {
      return { success: false, error: `任务状态 ${task.status} 不可暂停（仅 running 可暂停）` };
    }
    return this.updateTaskStatus(taskId, 'paused');
  }

  /**
   * 恢复任务（将 paused 改为 created，调用 runTask 继续执行）
   */
  async resumeTask(taskId: string): Promise<OperationResult<EngineeringTask>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }
    if (task.status !== 'paused' && task.status !== 'failed' && task.status !== 'created') {
      return { success: false, error: `任务状态 ${task.status} 不可恢复` };
    }
    // 恢复时重置当前阶段状态（如果该阶段未完成）
    if (task.currentPhaseIndex < task.phases.length) {
      const currentPhase = task.phases[task.currentPhaseIndex];
      if (currentPhase.status === 'in_progress' || currentPhase.status === 'failed') {
        currentPhase.status = 'pending';
        currentPhase.startedAt = undefined;
        currentPhase.error = undefined;
      }
    }
    return this.updateTaskStatus(taskId, 'created');
  }

  // ============ 进度计算 ============

  /**
   * 计算任务进度（0-100）
   */
  calculateProgress(taskId: string): number {
    const task = this.tasks.get(taskId);
    if (!task) return 0;
    if (task.status === 'completed') return 100;
    const completed = task.phases.filter(p => p.status === 'completed').length;
    return Math.round((completed / task.phases.length) * 100);
  }

  /**
   * 生成任务摘要
   */
  private toSummary(task: EngineeringTask): EngineeringTaskSummary {
    const completedPhases = task.phases.filter(p => p.status === 'completed').length;
    const currentPhase = task.currentPhaseIndex < task.phases.length
      ? task.phases[task.currentPhaseIndex].phase
      : null;

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      deploymentTarget: task.deploymentTarget,
      currentPhase,
      completedPhases,
      totalPhases: task.phases.length,
      progress: task.status === 'completed' ? 100 : Math.round((completedPhases / task.phases.length) * 100),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  // ============ 工具方法 ============

  /**
   * 生成任务 ID
   */
  private generateTaskId(): string {
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const random = Math.random().toString(36).substring(2, 8);
    return `eng-${dateStr}-${random}`;
  }

  /**
   * 从需求提炼标题（取前 30 字符）
   */
  private deriveTitle(requirement: string): string {
    const trimmed = requirement.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= 30) return trimmed;
    return trimmed.substring(0, 30) + '...';
  }

  /**
   * 获取任务详细报告
   */
  getTaskReport(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) return `❌ 工程任务不存在: ${taskId}`;

    const lines: string[] = [];
    const progress = this.calculateProgress(taskId);
    const statusIcon = {
      created: '📝',
      running: '🔄',
      paused: '⏸️',
      completed: '✅',
      failed: '❌',
      abandoned: '🚫',
    }[task.status];

    lines.push(`${statusIcon} ${task.title}`);
    lines.push(`   ID: ${task.id}`);
    lines.push(`   状态: ${task.status} | 部署目标: ${task.deploymentTarget} | 进度: ${progress}%`);
    lines.push(`   需求: ${task.requirement}`);
    lines.push('');

    for (let i = 0; i < task.phases.length; i++) {
      const phase = task.phases[i];
      const config = ENGINEERING_PHASES.find(c => c.phase === phase.phase)!;
      const phaseIcon = {
        pending: '⬜',
        in_progress: '🔄',
        completed: '✅',
        failed: '❌',
        skipped: '⏭️',
      }[phase.status];
      const isCurrent = i === task.currentPhaseIndex;

      lines.push(`  ${phaseIcon} ${isCurrent ? '👉 ' : ''}${config.icon} ${config.displayName} (重试: ${phase.retryCount}/${phase.maxRetries})`);
      if (phase.error) lines.push(`     错误: ${phase.error}`);
      if (phase.output) {
        const outputPreview = phase.output.length > 100
          ? phase.output.substring(0, 100) + '...'
          : phase.output;
        lines.push(`     产出: ${outputPreview}`);
      }
      if (phase.artifacts.length > 0) {
        lines.push(`     产出物: ${phase.artifacts.map(a => `[${a.type}] ${a.title}`).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取所有任务摘要（用于 LLM 工具展示）
   */
  getOverview(): string {
    const summaries = this.listTasks();
    if (summaries.length === 0) {
      return '📋 暂无工程任务。使用 engineering_create 创建新任务。';
    }

    const lines: string[] = [`📋 工程任务（共 ${summaries.length} 个）`, ''];
    for (const s of summaries) {
      const statusIcon = {
        created: '📝',
        running: '🔄',
        paused: '⏸️',
        completed: '✅',
        failed: '❌',
        abandoned: '🚫',
      }[s.status];
      lines.push(`${statusIcon} ${s.title} [${s.progress}%]`);
      lines.push(`   ID: ${s.id}`);
      lines.push(`   状态: ${s.status} | 部署: ${s.deploymentTarget} | 阶段: ${s.completedPhases}/${s.totalPhases}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 列出可用部署目标
   */
  listDeploymentTargets(): Array<{ target: DeploymentTarget; displayName: string; description: string }> {
    return [
      { target: 'local', displayName: '本地', description: '本地运行，不部署到远程' },
      { target: 'docker', displayName: 'Docker', description: '构建 Docker 镜像并运行容器' },
      { target: 'vercel', displayName: 'Vercel', description: '部署到 Vercel 平台（适合前端/Serverless）' },
      { target: 'netlify', displayName: 'Netlify', description: '部署到 Netlify 平台（适合静态站点/JAMstack）' },
      { target: 'k8s', displayName: 'Kubernetes', description: '部署到 Kubernetes 集群' },
      { target: 'none', displayName: '不部署', description: '仅完成开发，跳过部署阶段' },
    ];
  }

  /**
   * v20.0 §3.4：暴露 engineering 工具给 LLM
   *
   * 工具清单：
   * - engineering_create      创建工程任务
   * - engineering_list        列出所有任务
   * - engineering_info        查看任务详情
   * - engineering_run         启动/继续执行任务
   * - engineering_pause       暂停任务
   * - engineering_resume      恢复任务
   * - engineering_delete      删除任务
   * - engineering_targets     列出部署目标
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'engineering_create',
        description: '创建自主工程任务。接收高层需求（如"实现一个用户登录功能"），自动分解为 5 个阶段：需求分析 → 架构设计 → 编码实现 → 测试验证 → 部署上线。每阶段调用专用子代理执行，失败自动重试。',
        parameters: {
          requirement: { type: 'string', description: '高层需求描述（如"实现一个用户登录功能"）', required: true },
          title: { type: 'string', description: '任务标题（不填则从需求提炼）', required: false },
          deploymentTarget: { type: 'string', description: '部署目标: local/docker/vercel/netlify/k8s/none（默认 local）', required: false },
          projectRoot: { type: 'string', description: '项目根目录（沙箱路径）', required: false },
          tags: { type: 'array', description: '标签列表', required: false },
        },
        execute: async (args: { requirement?: string; title?: string; deploymentTarget?: string; projectRoot?: string; tags?: string[] }) => {
          if (!args?.requirement) return '❌ 缺少 requirement 参数';
          const validTargets: DeploymentTarget[] = ['local', 'docker', 'vercel', 'netlify', 'k8s', 'none'];
          const target = (args.deploymentTarget as DeploymentTarget) || 'local';
          if (args.deploymentTarget && !validTargets.includes(target)) {
            return `❌ 无效部署目标: ${args.deploymentTarget}（应为 ${validTargets.join('/')}）`;
          }
          const result = await this.createTask(args.requirement, {
            title: args.title,
            deploymentTarget: target,
            projectRoot: args.projectRoot,
            tags: args.tags,
          });
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 工程任务已创建: ${result.data!.title} (${result.data!.id})\n   部署目标: ${result.data!.deploymentTarget}\n   阶段数: ${result.data!.phases.length}\n   使用 engineering_run 启动执行。`;
        },
      },
      {
        name: 'engineering_list',
        description: '列出所有工程任务及其进度摘要。',
        parameters: {
          status: { type: 'string', description: '按状态过滤: created/running/paused/completed/failed/abandoned', required: false },
        },
        execute: async (args: { status?: string }) => {
          const filter = args?.status ? { status: args.status as EngineeringTaskStatus } : undefined;
          const summaries = this.listTasks(filter);
          if (summaries.length === 0) return '📋 暂无工程任务。';
          const lines = [`📋 工程任务列表（${summaries.length} 个）`, ''];
          for (const s of summaries) {
            lines.push(`• [${s.progress}%] ${s.title} (${s.id})`);
            lines.push(`  状态: ${s.status} | 部署: ${s.deploymentTarget} | 阶段: ${s.completedPhases}/${s.totalPhases}`);
          }
          return lines.join('\n');
        },
      },
      {
        name: 'engineering_info',
        description: '查看工程任务详细信息，包括各阶段状态、产出物和错误信息。',
        parameters: {
          taskId: { type: 'string', description: '任务 ID', required: true },
        },
        execute: async (args: { taskId?: string }) => {
          if (!args?.taskId) return '❌ 缺少 taskId 参数';
          return this.getTaskReport(args.taskId);
        },
      },
      {
        name: 'engineering_run',
        description: '启动或继续执行工程任务。从当前未完成的阶段开始，自动执行后续所有阶段。每阶段失败会自动重试（最多 3 次），重试耗尽则中止任务。',
        parameters: {
          taskId: { type: 'string', description: '任务 ID', required: true },
        },
        execute: async (args: { taskId?: string }) => {
          if (!args?.taskId) return '❌ 缺少 taskId 参数';
          const result = await this.runTask(args.taskId);
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 工程任务全部完成: ${result.data!.title}\n   总阶段: ${result.data!.phases.length}\n   产出物: ${result.data!.phases.reduce((sum, p) => sum + p.artifacts.length, 0)} 个`;
        },
      },
      {
        name: 'engineering_pause',
        description: '暂停正在执行的工程任务。可在之后用 engineering_resume 恢复。',
        parameters: {
          taskId: { type: 'string', description: '任务 ID', required: true },
        },
        execute: async (args: { taskId?: string }) => {
          if (!args?.taskId) return '❌ 缺少 taskId 参数';
          const result = await this.pauseTask(args.taskId);
          if (!result.success) return `❌ ${result.error}`;
          return `⏸️ 任务已暂停: ${result.data!.title}`;
        },
      },
      {
        name: 'engineering_resume',
        description: '恢复暂停或失败的任务。会将任务状态重置为 created，可再次执行。',
        parameters: {
          taskId: { type: 'string', description: '任务 ID', required: true },
        },
        execute: async (args: { taskId?: string }) => {
          if (!args?.taskId) return '❌ 缺少 taskId 参数';
          const result = await this.resumeTask(args.taskId);
          if (!result.success) return `❌ ${result.error}`;
          return `▶️ 任务已恢复: ${result.data!.title}（使用 engineering_run 继续执行）`;
        },
      },
      {
        name: 'engineering_delete',
        description: '删除工程任务（不可恢复）。',
        parameters: {
          taskId: { type: 'string', description: '任务 ID', required: true },
        },
        execute: async (args: { taskId?: string }) => {
          if (!args?.taskId) return '❌ 缺少 taskId 参数';
          const result = await this.deleteTask(args.taskId);
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 工程任务已删除: ${args.taskId}`;
        },
      },
      {
        name: 'engineering_targets',
        description: '列出可用的部署目标。',
        parameters: {},
        execute: async () => {
          const targets = this.listDeploymentTargets();
          const lines = [`📋 可用部署目标（${targets.length} 个）`, ''];
          for (const t of targets) {
            lines.push(`• ${t.target} — ${t.displayName}: ${t.description}`);
          }
          return lines.join('\n');
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: AutonomousEngineer | null = null;

export function getAutonomousEngineer(): AutonomousEngineer {
  if (!_instance) {
    _instance = new AutonomousEngineer();
  }
  return _instance;
}
