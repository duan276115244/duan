/**
 * 统一任务分解引擎 — TaskDecompositionEngine
 *
 * 合并自三个实现：
 * 1. 原 task-decomposition.ts — 核心架构（MECE分解、拓扑排序、关键路径、并行组）
 * 2. 原 problem-decomposer.ts — MECE检查逻辑、LLM集成
 * 3. 原 super-reasoning-engine.ts 的 decomposeTask — 15种预定义分解模式
 *
 * 核心能力：
 * 1. 复杂任务层次化分解：将大任务拆解为可执行的子任务树
 * 2. 多模式分解：auto / pattern / llm / rule 四种模式
 * 3. 15种预定义分解模式：微信操作、PS编辑、PPT制作等快速路径
 * 4. MECE检查：验证分解的相互独立性和完全穷尽性
 * 5. 执行计划生成：基于依赖关系和并行性分析，生成最优执行顺序
 * 6. 进度评估：实时追踪计划执行进度，识别阻塞点
 * 7. 计划自适应：根据新信息动态调整执行计划
 * 8. 方案验证：检验解决方案的完整性和逻辑一致性
 * 9. 分解质量验证：validateDecomposition() 检查MECE、完整性、可执行性
 * 10. 动态计划调整：adaptPlan() 根据执行结果调整计划
 *
 * 设计原则（借鉴 Google DeepMind + OpenAI o1）：
 * - MECE 分解：相互独立、完全穷尽
 * - 关键路径分析：识别影响总工期的瓶颈任务
 * - 并行化挖掘：最大化任务并行度
 * - 渐进式细化：支持多层级深度分解
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 任务节点 */
export interface TaskNode {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';
  priority: 'critical' | 'high' | 'medium' | 'low';
  dependencies: string[];        // 依赖的任务ID
  subtasks: TaskNode[];
  estimatedComplexity: number;   // 1-10
  complexityLevel: 'simple' | 'medium' | 'complex'; // 复杂度等级
  estimatedTime: number;         // 预估耗时（毫秒）
  requiredTools: string[];
  acceptanceCriteria: string[];
  result?: string;
}

/** 任务树 */
export interface TaskTree {
  root: TaskNode;
  totalTasks: number;
  maxDepth: number;
  parallelizableGroups: string[][];  // 可并行执行的任务ID分组
  criticalPath: string[];            // 关键路径上的任务ID
}

/** 执行步骤 */
export interface ExecutionStep {
  taskId: string;
  order: number;
  phase: 'preparation' | 'execution' | 'verification' | 'cleanup';
  estimatedTime: number;           // 预估耗时（毫秒）
  requiredTools: string[];
  dependencies: string[];
  parallelGroup?: number;          // 同组步骤可并行执行
}

/** 执行计划 */
export interface ExecutionPlan {
  id: string;
  taskTree: TaskTree;
  steps: ExecutionStep[];
  estimatedTotalTime: number;
  criticalPathLength: number;
  createdAt: number;
}

/** 进度报告 */
export interface ProgressReport {
  planId: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  blockedSteps: number;
  completionPercentage: number;
  blockers: string[];
  estimatedTimeRemaining: number;
  nextSteps: string[];
}

/** 验证结果 */
export interface ValidationResult {
  complete: boolean;
  completenessScore: number;     // 0-1
  missingElements: string[];
  logicalGaps: string[];
  suggestions: string[];
}

/** MECE检查结果（来自 problem-decomposer.ts） */
export interface MECECheck {
  isMECE: boolean;
  mutualExclusivity: number;     // 0-1
  collectiveExhaustiveness: number; // 0-1
  overlaps: string[];
  gaps: string[];
}

/** 分解质量验证结果 */
export interface DecompositionValidation {
  isValid: boolean;
  meceCheck: MECECheck;
  completenessScore: number;     // 0-1
  executabilityScore: number;    // 0-1
  issues: string[];
  suggestions: string[];
}

/** 分解模式（来自 super-reasoning-engine.ts） */
export type DecompositionMode = 'auto' | 'pattern' | 'llm' | 'rule';

// ============ 4级任务分解类型定义 ============

/** 4级分解的层次等级 */
export type TaskLevel = 1 | 2 | 3 | 4;

/** 带层次等级的任务节点（扩展 TaskNode） */
export interface LeveledTaskNode extends TaskNode {
  /** 任务层次等级 L1-L4 */
  level: TaskLevel;
  /** 原子操作的工具调用签名（仅 L4 层级有值，如 "browser_operate(action=goto,url=xxx)"） */
  atomicOperation?: string;
  /** 是否可跳过（阻塞时是否允许跳过推进到下一步） */
  skippable: boolean;
  /** 重试次数 */
  retryCount: number;
}

/** 4级层次化任务树 */
export interface LeveledTaskTree extends TaskTree {
  /** 各层级任务节点统计 */
  levelDistribution: Record<TaskLevel, number>;
  /** 是否达到4级分解深度 */
  reachedLevel4: boolean;
}



// ============ 常量 ============

/** 默认分解深度 */
const DEFAULT_DECOMPOSITION_DEPTH = 3;

/** 最大分解深度（防止无限递归） */
const MAX_DECOMPOSITION_DEPTH = 6;

/** 单个任务最大子任务数 */
const MAX_SUBTASKS_PER_NODE = 10;

/** 复杂度到预估耗时的映射基数（毫秒） */
const COMPLEXITY_TIME_BASE = 5000;

// ============ 4级任务分解常量 ============

/**
 * 4级任务分解层次定义（借鉴 Devin Planner-Critic 双模型架构）
 * - L1: 总体目标（如"生成80年代怀旧视频"）
 * - L2: 主要阶段（如"搜索资料→准备提示词→调用工具→验证结果"）
 * - L3: 具体步骤（如"打开豆包网站→输入提示词→点击生成"）
 * - L4: 原子操作（如"browser_operate(action=goto,url=xxx)"）
 */
export const TASK_LEVEL_4 = 4;

/** 优先级权重（用于排序） */
const PRIORITY_WEIGHT: Record<TaskNode['priority'], number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/** 执行阶段默认耗时比例 */
const PHASE_TIME_RATIO: Record<ExecutionStep['phase'], number> = {
  preparation: 0.15,
  execution: 0.60,
  verification: 0.20,
  cleanup: 0.05,
};

// ============ 分解模式定义（来自 super-reasoning-engine.ts） ============

interface DecompositionPattern {
  keywords: RegExp;
  domain: string;
  subtasks: Array<{
    description: string;
    tool?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolArgs?: Record<string, any>;
    priority: number;
    estimatedDifficulty: number;
  }>;
}

const DECOMPOSITION_PATTERNS: DecompositionPattern[] = [
  // 1. 微信操作
  {
    keywords: /微信|wechat|发消息|发微信|微信发/i,
    domain: 'desktop',
    subtasks: [
      { description: '检查微信状态', tool: 'wechat_status', priority: 1, estimatedDifficulty: 1 },
      { description: '查找联系人', tool: 'wechat_find_contact', toolArgs: { name: '$contact' }, priority: 2, estimatedDifficulty: 2 },
      { description: '发送消息', tool: 'wechat_send_message', toolArgs: { message: '$message' }, priority: 3, estimatedDifficulty: 2 },
    ],
  },
  // 2. PS编辑
  {
    keywords: /PS|Photoshop|ps编辑|图片编辑|加边框|滤镜|修图/i,
    domain: 'desktop',
    subtasks: [
      { description: '启动Photoshop', tool: 'app_launch', toolArgs: { app: 'photoshop' }, priority: 1, estimatedDifficulty: 1 },
      { description: '打开图片文件', tool: 'app_shortcut', toolArgs: { shortcut: 'Ctrl+O' }, priority: 2, estimatedDifficulty: 1 },
      { description: '执行编辑操作', tool: 'app_workflow', toolArgs: { action: '$action' }, priority: 3, estimatedDifficulty: 3 },
      { description: '导出结果', tool: 'app_export', priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 3. PPT制作
  {
    keywords: /PPT|PowerPoint|演示文稿|幻灯片|做PPT/i,
    domain: 'desktop',
    subtasks: [
      { description: '启动PowerPoint', tool: 'app_launch', toolArgs: { app: 'powerpoint' }, priority: 1, estimatedDifficulty: 1 },
      { description: '创建新演示文稿', tool: 'ppt_create', priority: 2, estimatedDifficulty: 1 },
      { description: '添加内容', tool: 'ppt_add_content', toolArgs: { content: '$content' }, priority: 3, estimatedDifficulty: 3 },
      { description: '导出/保存', tool: 'app_export', priority: 4, estimatedDifficulty: 1 },
    ],
  },
  // 4. 代码编写
  {
    keywords: /写代码|编写|实现|开发|coding|代码|函数|模块/i,
    domain: 'code',
    subtasks: [
      { description: '规划代码结构', tool: 'code_plan', priority: 1, estimatedDifficulty: 2 },
      { description: '编写代码', tool: 'code_write', toolArgs: { code: '$code' }, priority: 2, estimatedDifficulty: 3 },
      { description: '执行测试', tool: 'code_execute', toolArgs: { action: 'test' }, priority: 3, estimatedDifficulty: 2 },
      { description: '验证结果', tool: 'code_verify', priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 5. Bug修复
  {
    keywords: /bug|修复|fix|报错|错误|异常|崩溃/i,
    domain: 'debug',
    subtasks: [
      { description: '理解问题', tool: 'debug_understand', priority: 1, estimatedDifficulty: 2 },
      { description: '定位Bug', tool: 'debug_locate', priority: 2, estimatedDifficulty: 4 },
      { description: '修复代码', tool: 'debug_fix', priority: 3, estimatedDifficulty: 3 },
      { description: '测试验证', tool: 'code_execute', toolArgs: { action: 'test' }, priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 6. 搜索总结
  {
    keywords: /搜索|查找|search|调研|对比|总结|归纳/i,
    domain: 'general',
    subtasks: [
      { description: '搜索信息', tool: 'web_search', toolArgs: { query: '$query' }, priority: 1, estimatedDifficulty: 1 },
      { description: '提取关键信息', tool: 'extract_info', priority: 2, estimatedDifficulty: 2 },
      { description: '总结归纳', tool: 'summarize', priority: 3, estimatedDifficulty: 2 },
    ],
  },
  // 7. 文件操作
  {
    keywords: /文件|读取|写入|处理文件|转换|file|read|write/i,
    domain: 'general',
    subtasks: [
      { description: '读取文件', tool: 'file_read', toolArgs: { path: '$path' }, priority: 1, estimatedDifficulty: 1 },
      { description: '处理数据', tool: 'data_process', priority: 2, estimatedDifficulty: 3 },
      { description: '写入结果', tool: 'file_write', toolArgs: { path: '$output' }, priority: 3, estimatedDifficulty: 1 },
    ],
  },
  // 8. 项目创建
  {
    keywords: /创建项目|新建项目|初始化|scaffold|脚手架/i,
    domain: 'code',
    subtasks: [
      { description: '搭建项目骨架', tool: 'project_scaffold', priority: 1, estimatedDifficulty: 2 },
      { description: '配置项目', tool: 'project_configure', priority: 2, estimatedDifficulty: 2 },
      { description: '实现核心功能', tool: 'code_write', priority: 3, estimatedDifficulty: 4 },
      { description: '运行测试', tool: 'code_execute', toolArgs: { action: 'test' }, priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 9. 代码审查
  {
    keywords: /审查|review|代码审查|code review|检查代码/i,
    domain: 'code',
    subtasks: [
      { description: '分析代码结构', tool: 'code_analyze', priority: 1, estimatedDifficulty: 2 },
      { description: '审查质量与规范', tool: 'code_review', priority: 2, estimatedDifficulty: 3 },
      { description: '提出改进建议', tool: 'code_suggest', priority: 3, estimatedDifficulty: 2 },
      { description: '修复问题', tool: 'code_fix', priority: 4, estimatedDifficulty: 3 },
    ],
  },
  // 10. 部署
  {
    keywords: /部署|deploy|发布|上线|release/i,
    domain: 'code',
    subtasks: [
      { description: '构建项目', tool: 'build', priority: 1, estimatedDifficulty: 2 },
      { description: '运行测试', tool: 'code_execute', toolArgs: { action: 'test' }, priority: 2, estimatedDifficulty: 2 },
      { description: '部署到目标环境', tool: 'deploy', priority: 3, estimatedDifficulty: 3 },
      { description: '验证部署结果', tool: 'deploy_verify', priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 11. 数据分析
  {
    keywords: /数据分析|统计|可视化|data analysis|图表|报表/i,
    domain: 'general',
    subtasks: [
      { description: '收集数据', tool: 'data_collect', priority: 1, estimatedDifficulty: 2 },
      { description: '清洗数据', tool: 'data_clean', priority: 2, estimatedDifficulty: 2 },
      { description: '分析数据', tool: 'data_analyze', priority: 3, estimatedDifficulty: 4 },
      { description: '可视化展示', tool: 'data_visualize', priority: 4, estimatedDifficulty: 3 },
    ],
  },
  // 12. 翻译
  {
    keywords: /翻译|translate|英译中|中译英/i,
    domain: 'general',
    subtasks: [
      { description: '检测语言', tool: 'language_detect', priority: 1, estimatedDifficulty: 1 },
      { description: '执行翻译', tool: 'translate', toolArgs: { text: '$text' }, priority: 2, estimatedDifficulty: 2 },
      { description: '校验翻译质量', tool: 'translate_verify', priority: 3, estimatedDifficulty: 2 },
    ],
  },
  // 13. 设计
  {
    keywords: /设计|架构|方案设计|UI设计|交互设计|design/i,
    domain: 'creative',
    subtasks: [
      { description: '收集需求', tool: 'design_requirements', priority: 1, estimatedDifficulty: 2 },
      { description: '草拟方案', tool: 'design_draft', priority: 2, estimatedDifficulty: 3 },
      { description: '迭代优化', tool: 'design_iterate', priority: 3, estimatedDifficulty: 3 },
      { description: '定稿输出', tool: 'design_finalize', priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 14. 学习
  {
    keywords: /学习|教程|learn|study|入门|了解/i,
    domain: 'general',
    subtasks: [
      { description: '搜索学习资料', tool: 'web_search', toolArgs: { query: '$topic' }, priority: 1, estimatedDifficulty: 1 },
      { description: '理解核心概念', tool: 'learn_understand', priority: 2, estimatedDifficulty: 3 },
      { description: '实践练习', tool: 'learn_practice', priority: 3, estimatedDifficulty: 3 },
      { description: '评估掌握程度', tool: 'learn_assess', priority: 4, estimatedDifficulty: 2 },
    ],
  },
  // 15. 自动化
  {
    keywords: /自动化|automate|批量|脚本|定时|监控/i,
    domain: 'general',
    subtasks: [
      { description: '观察现有流程', tool: 'automate_observe', priority: 1, estimatedDifficulty: 2 },
      { description: '规划自动化方案', tool: 'automate_plan', priority: 2, estimatedDifficulty: 3 },
      { description: '实现自动化', tool: 'automate_implement', priority: 3, estimatedDifficulty: 4 },
      { description: '验证自动化效果', tool: 'automate_verify', priority: 4, estimatedDifficulty: 2 },
    ],
  },
];

// ============ 主类 ============

export class TaskDecompositionEngine {
  private log = logger.child({ module: 'TaskDecomposition' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelLibrary: any;
  private plans: Map<string, ExecutionPlan> = new Map();
  private taskStatusMap: Map<string, TaskNode['status']> = new Map();

  // 统计信息
  private stats = {
    totalDecompositions: 0,
    totalPlansCreated: 0,
    totalValidations: 0,
    totalAdaptations: 0,
    patternMatches: 0,
    llmDecompositions: 0,
    ruleDecompositions: 0,
    avgDecompositionTime: 0,
    avgPlanCreationTime: 0,
    decompositionTimeSamples: [] as number[],
    planCreationTimeSamples: [] as number[],
  };

  // ============ 4级任务分解状态 ============

  /** 任务层级映射（taskId → 层级），用于4级分解 */
  private taskLevels: Map<string, TaskLevel> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary || null;
  }

  // ========== 核心方法 ==========

  /**
   * 分解复杂任务为子任务树
   * @param task 任务描述
   * @param depth 分解深度，默认3
   * @param mode 分解模式：'auto' | 'pattern' | 'llm' | 'rule'
   * @returns 任务树
   */
  async decomposeTask(task: string, depth: number = DEFAULT_DECOMPOSITION_DEPTH, mode: DecompositionMode = 'auto'): Promise<TaskTree> {
    const startTime = Date.now();
    this.log.info('开始任务分解', { task: task.substring(0, 100), depth, mode });

    const clampedDepth = Math.max(1, Math.min(depth, MAX_DECOMPOSITION_DEPTH));

    let root: TaskNode;
    let usedMode = mode;

    switch (mode) {
      case 'pattern': {
        const patternRoot = this.patternDecompose(task, clampedDepth);
        if (patternRoot) {
          root = patternRoot;
          this.stats.patternMatches++;
        } else {
          this.log.warn('pattern模式无匹配，降级为规则分解');
          root = this.ruleBasedDecompose(task, clampedDepth);
          usedMode = 'rule';
          this.stats.ruleDecompositions++;
        }
        break;
      }
      case 'llm': {
        try {
          root = await this.llmDecompose(task, clampedDepth);
          this.stats.llmDecompositions++;
        } catch {
          this.log.warn('LLM分解失败，降级为规则分解');
          root = this.ruleBasedDecompose(task, clampedDepth);
          usedMode = 'rule';
          this.stats.ruleDecompositions++;
        }
        break;
      }
      case 'rule': {
        root = this.ruleBasedDecompose(task, clampedDepth);
        this.stats.ruleDecompositions++;
        break;
      }
      case 'auto':
      default: {
        // auto: 先尝试pattern匹配，无匹配则用LLM分解，LLM失败则用规则分解
        const patternRoot = this.patternDecompose(task, clampedDepth);
        if (patternRoot) {
          root = patternRoot;
          usedMode = 'pattern';
          this.stats.patternMatches++;
        } else {
          try {
            root = await this.llmDecompose(task, clampedDepth);
            usedMode = 'llm';
            this.stats.llmDecompositions++;
          } catch {
            this.log.warn('LLM分解失败，降级为规则分解');
            root = this.ruleBasedDecompose(task, clampedDepth);
            usedMode = 'rule';
            this.stats.ruleDecompositions++;
          }
        }
        break;
      }
    }

    // 构建任务树
    const tree = this.buildTaskTree(root);

    // 记录统计
    const elapsed = Date.now() - startTime;
    this.stats.totalDecompositions++;
    this.stats.decompositionTimeSamples.push(elapsed);
    if (this.stats.decompositionTimeSamples.length > 50) {
      this.stats.decompositionTimeSamples.shift();
    }
    this.stats.avgDecompositionTime =
      this.stats.decompositionTimeSamples.reduce((a, b) => a + b, 0) /
      this.stats.decompositionTimeSamples.length;

    // 广播事件
    EventBus.getInstance().emitSync('task.decomposed', {
      task: task.substring(0, 100),
      totalTasks: tree.totalTasks,
      maxDepth: tree.maxDepth,
      mode: usedMode,
      elapsed,
    });

    this.log.info('任务分解完成', {
      totalTasks: tree.totalTasks,
      maxDepth: tree.maxDepth,
      parallelizableGroups: tree.parallelizableGroups.length,
      mode: usedMode,
      elapsed,
    });

    return tree;
  }

  // ========== 4级任务分解方法 ==========

  /**
   * 4级层次化任务分解（借鉴 Devin Planner-Critic 架构）
   *
   * 分解层次：
   * - L1 总体目标：用户原始指令（如"生成80年代怀旧视频"）
   * - L2 主要阶段：高阶流程节点（如"搜索资料→准备提示词→调用工具→验证结果"）
   * - L3 具体步骤：可执行的操作序列（如"打开豆包网站→输入提示词→点击生成"）
   * - L4 原子操作：单个工具调用签名（如"browser_operate(action=goto,url=xxx)"）
   *
   * @param task L1 总体目标
   * @param mode 分解模式，默认 auto
   * @returns 4级层次化任务树
   */
  async decomposeTask4Level(task: string, mode: DecompositionMode = 'auto'): Promise<LeveledTaskTree> {
    const startTime = Date.now();
    this.log.info('开始4级任务分解', { task: task.substring(0, 100), mode });

    // 先用现有分解逻辑生成基础任务树（深度=4）
    const baseTree = await this.decomposeTask(task, TASK_LEVEL_4, mode);

    // 为每个节点标注层级，并补充 L4 原子操作签名
    const leveledRoot = this.annotateTaskLevels(baseTree.root, 1 as TaskLevel);
    this.recordTaskLevels(leveledRoot);

    // 构建层次化任务树统计
    const levelDistribution = this.calculateLevelDistribution(leveledRoot);
    const reachedLevel4 = levelDistribution[4] > 0;

    const leveledTree: LeveledTaskTree = {
      ...baseTree,
      root: leveledRoot,
      levelDistribution,
      reachedLevel4,
    };

    const elapsed = Date.now() - startTime;
    this.log.info('4级任务分解完成', {
      totalTasks: leveledTree.totalTasks,
      reachedLevel4,
      levelDistribution,
      elapsed,
    });

    EventBus.getInstance().emitSync('task.decomposed_4level', {
      task: task.substring(0, 100),
      reachedLevel4,
      levelDistribution,
      elapsed,
    });

    return leveledTree;
  }

  /**
   * 为任务节点递归标注层级，并在叶子节点生成 L4 原子操作签名
   */
  private annotateTaskLevels(node: TaskNode, level: TaskLevel): LeveledTaskNode {
    const childLevel = (Math.min(level + 1, 4) as TaskLevel);
    const isLeaf = node.subtasks.length === 0;

    // 叶子节点且层级不足4时，尝试生成 L4 原子操作签名
    let atomicOperation: string | undefined;
    if (isLeaf) {
      atomicOperation = this.generateAtomicOperation(node);
    }

    const leveledNode: LeveledTaskNode = {
      ...node,
      level,
      atomicOperation,
      skippable: this.isTaskSkippable(node, level),
      retryCount: 0,
      subtasks: node.subtasks.map(st => this.annotateTaskLevels(st, childLevel)),
    };

    return leveledNode;
  }

  /**
   * 为叶子任务生成 L4 原子操作签名
   * 根据任务描述和所需工具推断具体的工具调用格式
   */
  private generateAtomicOperation(node: TaskNode): string | undefined {
    const desc = node.description;
    const tools = node.requiredTools;

    // 浏览器操作类
    if (/打开|跳转|goto|navigate|访问/i.test(desc) && /browser|http|web/i.test(tools.join(' '))) {
      const urlMatch = desc.match(/(?:url|地址|链接|网站)[:：]?\s*(https?:\/\/[^\s，,。]+)/i);
      const url = urlMatch ? urlMatch[1] : '$target_url';
      return `browser_operate(action=goto, url=${url})`;
    }
    if (/点击|click|按下/i.test(desc)) {
      const selMatch = desc.match(/(?:selector|选择器|元素)[:：]?\s*["']?([^"'\s，,。]+)["']?/i);
      const selector = selMatch ? selMatch[1] : '$selector';
      return `browser_operate(action=click, selector="${selector}")`;
    }
    if (/输入|type|填写/i.test(desc)) {
      const textMatch = desc.match(/(?:text|内容|文本)[:：]?\s*["']?([^"'\n]+)["']?/i);
      const text = textMatch ? textMatch[1] : '$text';
      return `browser_operate(action=type, selector="$selector", text="${text}")`;
    }

    // 文件操作类
    if (/读取|read/i.test(desc) && tools.includes('file_ops')) {
      const pathMatch = desc.match(/(?:path|路径|文件)[:：]?\s*["']?([^"'\s，,。]+)["']?/i);
      const filePath = pathMatch ? pathMatch[1] : '$path';
      return `file_read(path="${filePath}")`;
    }
    if (/写入|write|保存/i.test(desc) && tools.includes('file_ops')) {
      const pathMatch = desc.match(/(?:path|路径|文件)[:：]?\s*["']?([^"'\s，,。]+)["']?/i);
      const filePath = pathMatch ? pathMatch[1] : '$path';
      return `file_write(path="${filePath}", content=$content)`;
    }

    // 搜索类
    if (/搜索|search|查找/i.test(desc) && tools.includes('search')) {
      const queryMatch = desc.match(/(?:query|关键词|搜索)[:：]?\s*["']?([^"'\n]+)["']?/i);
      const query = queryMatch ? queryMatch[1] : '$query';
      return `web_search(query="${query}")`;
    }

    // 代码执行类
    if (/执行|run|execute/i.test(desc) && tools.includes('code_editor')) {
      return `code_execute(action=run, file=$file)`;
    }

    // 测试类
    if (/测试|test|验证/i.test(desc) && tools.includes('test_runner')) {
      return `code_execute(action=test)`;
    }

    // 部署类
    if (/部署|deploy/i.test(desc) && tools.includes('deploy')) {
      return `deploy(target=$target)`;
    }

    // 无法推断具体操作时返回 undefined
    return undefined;
  }

  /**
   * 判断任务是否可跳过（L3/L4 层级的非关键任务在阻塞时可跳过）
   */
  private isTaskSkippable(node: TaskNode, level: TaskLevel): boolean {
    // L1/L2 层级不可跳过（关键阶段）
    if (level <= 2) return false;
    // critical 优先级不可跳过
    if (node.priority === 'critical') return false;
    // 验证/清理类任务可跳过
    if (/验证|检查|清理|cleanup|verify|optional/i.test(node.description)) return true;
    // L4 原子操作默认可跳过
    return level === 4;
  }

  /** 记录任务层级到映射表 */
  private recordTaskLevels(node: LeveledTaskNode): void {
    this.taskLevels.set(node.id, node.level);
    for (const sub of node.subtasks) {
      // annotateTaskLevels 已确保所有子节点为 LeveledTaskNode，此处安全断言
      this.recordTaskLevels(sub as LeveledTaskNode);
    }
  }

  /** 计算各层级任务节点数量分布 */
  private calculateLevelDistribution(node: LeveledTaskNode): Record<TaskLevel, number> {
    const dist: Record<TaskLevel, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const traverse = (n: LeveledTaskNode) => {
      dist[n.level] = (dist[n.level] || 0) + 1;
      for (const sub of n.subtasks) {
        // annotateTaskLevels 已确保所有子节点为 LeveledTaskNode，此处安全断言
        traverse(sub as LeveledTaskNode);
      }
    };
    traverse(node);
    return dist;
  }

  /**
   * 从任务树创建执行计划
   * @param taskTree 任务树
   * @returns 执行计划
   */
  createExecutionPlan(taskTree: TaskTree): ExecutionPlan {
    const startTime = Date.now();
    this.log.info('创建执行计划', { totalTasks: taskTree.totalTasks });

    // 收集所有扁平化的任务节点
    const allNodes = this.flattenTaskNodes(taskTree.root);

    // 拓扑排序确定执行顺序
    const sortedIds = this.topologicalSort(allNodes);

    // 为每个任务生成执行步骤
    const steps: ExecutionStep[] = [];
    let order = 0;
    let parallelGroupCounter = 0;
    const assignedGroups = new Map<string, number>();

    // 识别可并行的任务组
    for (const group of taskTree.parallelizableGroups) {
      const groupIndex = parallelGroupCounter++;
      for (const taskId of group) {
        assignedGroups.set(taskId, groupIndex);
      }
    }

    // 按拓扑顺序生成步骤
    for (const taskId of sortedIds) {
      const node = allNodes.get(taskId);
      if (!node) continue;

      // 每个任务拆分为4个阶段步骤
      const phases: ExecutionStep['phase'][] = ['preparation', 'execution', 'verification', 'cleanup'];

      for (const phase of phases) {
        const phaseTime = Math.round(
          node.estimatedComplexity * COMPLEXITY_TIME_BASE * PHASE_TIME_RATIO[phase]
        );

        steps.push({
          taskId,
          order: order++,
          phase,
          estimatedTime: phaseTime,
          requiredTools: node.requiredTools,
          dependencies: phase === 'preparation' ? node.dependencies : [taskId],  // 非准备阶段依赖同任务的准备阶段(taskId本身)
          parallelGroup: phase === 'execution' ? assignedGroups.get(taskId) : undefined,
        });
      }

      // 初始化状态追踪
      this.taskStatusMap.set(taskId, node.status);
    }

    // 计算总预估耗时
    const estimatedTotalTime = this.calculateEstimatedTotalTime(steps, taskTree.criticalPath, allNodes);

    // 计算关键路径长度
    const criticalPathLength = taskTree.criticalPath.reduce((sum, id) => {
      const node = allNodes.get(id);
      return sum + (node ? node.estimatedComplexity * COMPLEXITY_TIME_BASE : 0);
    }, 0);

    const plan: ExecutionPlan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskTree,
      steps,
      estimatedTotalTime,
      criticalPathLength,
      createdAt: Date.now(),
    };

    // 存储计划
    this.plans.set(plan.id, plan);

    // 记录统计
    const elapsed = Date.now() - startTime;
    this.stats.totalPlansCreated++;
    this.stats.planCreationTimeSamples.push(elapsed);
    if (this.stats.planCreationTimeSamples.length > 50) {
      this.stats.planCreationTimeSamples.shift();
    }
    this.stats.avgPlanCreationTime =
      this.stats.planCreationTimeSamples.reduce((a, b) => a + b, 0) /
      this.stats.planCreationTimeSamples.length;

    // 广播事件
    EventBus.getInstance().emitSync('task.plan_created', {
      planId: plan.id,
      totalSteps: steps.length,
      estimatedTotalTime,
      criticalPathLength,
    });

    this.log.info('执行计划创建完成', {
      planId: plan.id,
      totalSteps: steps.length,
      estimatedTotalTime,
      elapsed,
    });

    return plan;
  }

  /**
   * 评估执行计划进度
   * @param planId 计划ID
   * @returns 进度报告
   */
  evaluateProgress(planId: string): ProgressReport {
    const plan = this.plans.get(planId);
    if (!plan) {
      this.log.warn('计划不存在', { planId });
      return {
        planId,
        totalSteps: 0,
        completedSteps: 0,
        failedSteps: 0,
        blockedSteps: 0,
        completionPercentage: 0,
        blockers: ['计划不存在'],
        estimatedTimeRemaining: 0,
        nextSteps: [],
      };
    }

    const allNodes = this.flattenTaskNodes(plan.taskTree.root);
    let completedSteps = 0;
    let failedSteps = 0;
    let blockedSteps = 0;
    const blockers: string[] = [];
    const nextSteps: string[] = [];
    let remainingTime = 0;

    for (const [id, node] of allNodes) {
      const currentStatus = this.taskStatusMap.get(id) || node.status;

      switch (currentStatus) {
        case 'completed':
          completedSteps++;
          break;
        case 'failed':
          failedSteps++;
          break;
        case 'blocked': {
          blockedSteps++;
          // 识别阻塞原因
          const unmetDeps = node.dependencies.filter(depId => {
            const depStatus = this.taskStatusMap.get(depId);
            return depStatus !== 'completed';
          });
          if (unmetDeps.length > 0) {
            blockers.push(`任务 "${node.description.substring(0, 50)}" 被阻塞，未完成依赖: ${unmetDeps.join(', ')}`);
          }
          break;
        }
        case 'pending': {
          // 检查是否为可执行的下一步
          const depsMet = node.dependencies.every(depId => {
            const depStatus = this.taskStatusMap.get(depId);
            return depStatus === 'completed';
          });
          if (depsMet) {
            nextSteps.push(id);
          }
          remainingTime += node.estimatedTime || node.estimatedComplexity * COMPLEXITY_TIME_BASE;
          break;
        }
        case 'in_progress':
          remainingTime += Math.round((node.estimatedTime || node.estimatedComplexity * COMPLEXITY_TIME_BASE) * 0.5);
          break;
      }
    }

    const totalSteps = allNodes.size;
    const completionPercentage = totalSteps > 0
      ? Math.round((completedSteps / totalSteps) * 100)
      : 0;

    const report: ProgressReport = {
      planId,
      totalSteps,
      completedSteps,
      failedSteps,
      blockedSteps,
      completionPercentage,
      blockers,
      estimatedTimeRemaining: remainingTime,
      nextSteps,
    };

    // 广播进度事件
    EventBus.getInstance().emitSync('task.progress_evaluated', {
      planId,
      completionPercentage,
      blockedSteps,
      failedSteps,
    });

    return report;
  }

  /**
   * 根据新信息自适应调整计划
   * @param planId 计划ID
   * @param newInformation 新信息描述
   * @returns 调整后的执行计划
   */
  async adaptPlan(planId: string, newInformation: string): Promise<ExecutionPlan> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`计划 ${planId} 不存在`);
    }

    this.log.info('自适应调整计划', { planId, newInformation: newInformation.substring(0, 100) });
    this.stats.totalAdaptations++;

    // 备份已完成任务的状态（防止createExecutionPlan重置）
    const completedStatusBackup = new Map<string, TaskNode['status']>();
    for (const [taskId, status] of this.taskStatusMap) {
      if (status === 'completed' || status === 'in_progress') {
        completedStatusBackup.set(taskId, status);
      }
    }

    // 收集当前任务状态
    const allNodes = this.flattenTaskNodes(plan.taskTree.root);
    const pendingNodes: TaskNode[] = [];

    for (const [, node] of allNodes) {
      const status = this.taskStatusMap.get(node.id) || node.status;
      if (status === 'pending' || status === 'blocked') {
        pendingNodes.push({ ...node, status });
      }
    }

    // 尝试使用 LLM 分析新信息对计划的影响
    let adaptedNodes: TaskNode[] | null = null;
    try {
      adaptedNodes = await this.llmAdaptPlan(pendingNodes, newInformation);
    } catch {
      this.log.warn('LLM 计划调整失败，使用规则调整');
    }

    if (adaptedNodes) {
      // 更新受影响节点的状态和依赖
      for (const adapted of adaptedNodes) {
        this.taskStatusMap.set(adapted.id, adapted.status);
        // 更新节点依赖
        const original = allNodes.get(adapted.id);
        if (original) {
          original.dependencies = adapted.dependencies;
          original.priority = adapted.priority;
        }
      }
    } else {
      // 规则调整：解除因新信息不再存在的阻塞
      for (const node of pendingNodes) {
        if (node.status === 'blocked') {
          // 检查依赖是否仍然有效
          const validDeps = node.dependencies.filter(depId => {
            const depStatus = this.taskStatusMap.get(depId);
            return depStatus !== 'completed';
          });
          if (validDeps.length === 0) {
            this.taskStatusMap.set(node.id, 'pending');
          }
        }
      }
    }

    // 重新构建任务树和执行计划
    const updatedTree = this.buildTaskTree(plan.taskTree.root);
    const updatedPlan = this.createExecutionPlan(updatedTree);
    updatedPlan.id = planId; // 保持原计划ID

    // 恢复已完成任务的状态（createExecutionPlan会用node.status覆盖taskStatusMap）
    for (const [taskId, status] of completedStatusBackup) {
      this.taskStatusMap.set(taskId, status as TaskNode['status']);
    }

    this.plans.set(planId, updatedPlan);

    // 广播事件
    EventBus.getInstance().emitSync('task.plan_adapted', {
      planId,
      newInformation: newInformation.substring(0, 100),
      pendingCount: pendingNodes.length,
    });

    this.log.info('计划调整完成', { planId });

    return updatedPlan;
  }

  /**
   * 验证解决方案的完整性
   * @param task 原始任务描述
   * @param solution 解决方案描述
   * @returns 验证结果
   */
  async validateSolution(task: string, solution: string): Promise<ValidationResult> {
    this.log.info('验证解决方案完整性', { task: task.substring(0, 80) });
    this.stats.totalValidations++;

    // 尝试 LLM 增强验证
    try {
      const llmResult = await this.llmValidateSolution(task, solution);
      if (llmResult) {
        EventBus.getInstance().emitSync('task.solution_validated', {
          task: task.substring(0, 80),
          complete: llmResult.complete,
          completenessScore: llmResult.completenessScore,
        });
        return llmResult;
      }
    } catch {
      this.log.warn('LLM 验证失败，降级为规则验证');
    }

    // 规则验证
    return this.ruleBasedValidate(task, solution);
  }

  /**
   * MECE检查（来自 problem-decomposer.ts）
   * 检查子任务是否满足MECE原则（相互独立、完全穷尽）
   * @param subtasks 子任务列表
   * @returns MECE检查结果
   */
  async checkMECE(subtasks: Array<{ id: string; description: string }>): Promise<MECECheck> {
    this.log.info('执行MECE检查', { subtaskCount: subtasks.length });

    // 尝试 LLM 增强 MECE 检查
    if (this.modelLibrary) {
      try {
        const prompt = `请检查以下子任务是否满足MECE原则（相互独立、完全穷尽）：

子任务：
${subtasks.map((sp, i) => `${i + 1}. ${sp.description}`).join('\n')}

请用JSON格式返回：
{
  "isMECE": true/false,
  "mutualExclusivity": 0.0-1.0,
  "collectiveExhaustiveness": 0.0-1.0,
  "overlaps": ["重叠的子问题对"],
  "gaps": ["遗漏的方面"]
}`;

        const response = await this.modelLibrary.call([
          { role: 'system', content: '你是一个任务分解专家，擅长检查分解结果的MECE属性。' },
          { role: 'user', content: prompt },
        ]);

        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            isMECE: parsed.isMECE ?? false,
            mutualExclusivity: parsed.mutualExclusivity ?? 0.5,
            collectiveExhaustiveness: parsed.collectiveExhaustiveness ?? 0.5,
            overlaps: parsed.overlaps || [],
            gaps: parsed.gaps || [],
          };
        }
      } catch {
        this.log.warn('LLM MECE检查失败，降级为规则检查');
      }
    }

    // 规则 MECE 检查
    return this.ruleBasedMECECheck(subtasks);
  }

  /**
   * 验证分解质量（新增方法）
   * 检查分解结果的MECE、完整性、可执行性
   * @param tree 任务树
   * @returns 分解质量验证结果
   */
  async validateDecomposition(tree: TaskTree): Promise<DecompositionValidation> {
    this.log.info('验证分解质量', { totalTasks: tree.totalTasks });

    const allNodes = this.flattenTaskNodes(tree.root);
    const leafNodes = Array.from(allNodes.values()).filter(n => n.subtasks.length === 0);

    // 1. MECE 检查
    const meceCheck = await this.checkMECE(leafNodes.map(n => ({ id: n.id, description: n.description })));

    // 2. 完整性检查
    const completenessIssues: string[] = [];
    let completenessScore = 1.0;

    // 检查是否有空描述的子任务
    const emptyDescNodes = leafNodes.filter(n => !n.description || n.description.trim().length === 0);
    if (emptyDescNodes.length > 0) {
      completenessIssues.push(`${emptyDescNodes.length}个子任务缺少描述`);
      completenessScore -= 0.2;
    }

    // 检查是否有循环依赖
    const cycleDetected = this.detectCyclicDependencies(allNodes);
    if (cycleDetected) {
      completenessIssues.push('存在循环依赖');
      completenessScore -= 0.3;
    }

    // 检查是否有孤立节点（无依赖且不被依赖的叶子节点，排除根节点）
    const rootId = tree.root.id;
    const orphanNodes = leafNodes.filter(n =>
      n.id !== rootId &&
      n.dependencies.length === 0 &&
      !Array.from(allNodes.values()).some(other => other.dependencies.includes(n.id))
    );
    if (orphanNodes.length > 0 && leafNodes.length > 1) {
      completenessIssues.push(`${orphanNodes.length}个孤立子任务（无依赖关系）`);
      completenessScore -= 0.1;
    }

    // 3. 可执行性检查
    const executabilityIssues: string[] = [];
    let executabilityScore = 1.0;

    // 检查验收标准
    const noCriteriaNodes = leafNodes.filter(n => n.acceptanceCriteria.length === 0);
    if (noCriteriaNodes.length > 0) {
      executabilityIssues.push(`${noCriteriaNodes.length}个子任务缺少验收标准`);
      executabilityScore -= 0.15;
    }

    // 检查复杂度估算
    const noComplexityNodes = leafNodes.filter(n => n.estimatedComplexity <= 0);
    if (noComplexityNodes.length > 0) {
      executabilityIssues.push(`${noComplexityNodes.length}个子任务缺少复杂度估算`);
      executabilityScore -= 0.1;
    }

    // 检查依赖引用的节点是否存在
    const nodeIds = new Set(allNodes.keys());
    const invalidDeps: string[] = [];
    for (const node of allNodes.values()) {
      for (const depId of node.dependencies) {
        if (!nodeIds.has(depId)) {
          invalidDeps.push(`${node.id} → ${depId}`);
        }
      }
    }
    if (invalidDeps.length > 0) {
      executabilityIssues.push(`${invalidDeps.length}个无效依赖引用`);
      executabilityScore -= 0.2;
    }

    // 汇总
    const issues = [...completenessIssues, ...executabilityIssues];
    if (!meceCheck.isMECE) {
      issues.push(`MECE检查未通过: 互斥性${(meceCheck.mutualExclusivity * 100).toFixed(0)}%, 穷尽性${(meceCheck.collectiveExhaustiveness * 100).toFixed(0)}%`);
    }

    const suggestions: string[] = [];
    if (meceCheck.overlaps.length > 0) {
      suggestions.push(`合并重叠的子任务: ${meceCheck.overlaps.join(', ')}`);
    }
    if (meceCheck.gaps.length > 0) {
      suggestions.push(`补充遗漏的方面: ${meceCheck.gaps.join(', ')}`);
    }
    if (noCriteriaNodes.length > 0) {
      suggestions.push('为缺少验收标准的子任务补充验收标准');
    }
    if (orphanNodes.length > 0 && leafNodes.length > 1) {
      suggestions.push('检查孤立子任务是否需要添加依赖关系');
    }

    completenessScore = Math.max(0, Math.min(1, completenessScore));
    executabilityScore = Math.max(0, Math.min(1, executabilityScore));

    const isValid = meceCheck.isMECE && completenessScore >= 0.7 && executabilityScore >= 0.7;

    return {
      isValid,
      meceCheck,
      completenessScore,
      executabilityScore,
      issues,
      suggestions,
    };
  }

  /**
   * 获取统计信息
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStats(): Record<string, any> {
    return {
      totalDecompositions: this.stats.totalDecompositions,
      totalPlansCreated: this.stats.totalPlansCreated,
      totalValidations: this.stats.totalValidations,
      totalAdaptations: this.stats.totalAdaptations,
      patternMatches: this.stats.patternMatches,
      llmDecompositions: this.stats.llmDecompositions,
      ruleDecompositions: this.stats.ruleDecompositions,
      avgDecompositionTime: Math.round(this.stats.avgDecompositionTime),
      avgPlanCreationTime: Math.round(this.stats.avgPlanCreationTime),
      activePlans: this.plans.size,
    };
  }

  // ========== 工具定义 ==========

  /**
   * 返回 Agent Loop 可用的工具定义
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;

    return [
      {
        name: 'task_decompose',
        description: '将复杂任务分解为层次化的子任务树。支持4种分解模式：auto(自动选择)、pattern(预定义模式匹配)、llm(LLM辅助)、rule(规则分解)。分析任务复杂度和依赖关系，识别可并行执行的子任务组，计算关键路径。内置15种预定义分解模式（微信操作、PS编辑、PPT制作、代码编写等）。',
        parameters: {
          task: {
            type: 'string',
            description: '需要分解的复杂任务描述',
            required: true,
          },
          depth: {
            type: 'number',
            description: '分解深度（1-6），默认3。深度越大子任务越细粒度。',
            required: false,
          },
          mode: {
            type: 'string',
            description: '分解模式: auto(自动选择最优)|pattern(预定义模式)|llm(LLM辅助)|rule(规则分解)，默认auto',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const task = args.task as string;
            const depth = args.depth ? Number(args.depth) : DEFAULT_DECOMPOSITION_DEPTH;
            const mode = (args.mode as DecompositionMode) || 'auto';
            const tree = await engine.decomposeTask(task, depth, mode);
            return JSON.stringify({
              root: engine.serializeTaskNode(tree.root),
              totalTasks: tree.totalTasks,
              maxDepth: tree.maxDepth,
              parallelizableGroups: tree.parallelizableGroups,
              criticalPath: tree.criticalPath,
            }, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 任务分解失败: ${msg}`;
          }
        },
      },
      {
        name: 'task_plan',
        description: '根据任务树创建执行计划。确定最优执行顺序，识别关键路径，估算时间和资源需求，分配并行执行组。',
        parameters: {
          task: {
            type: 'string',
            description: '需要制定执行计划的任务描述',
            required: true,
          },
          depth: {
            type: 'number',
            description: '任务分解深度（1-6），默认3',
            required: false,
          },
          mode: {
            type: 'string',
            description: '分解模式: auto|pattern|llm|rule，默认auto',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const task = args.task as string;
            const depth = args.depth ? Number(args.depth) : DEFAULT_DECOMPOSITION_DEPTH;
            const mode = (args.mode as DecompositionMode) || 'auto';
            const tree = await engine.decomposeTask(task, depth, mode);
            const plan = engine.createExecutionPlan(tree);
            return JSON.stringify({
              planId: plan.id,
              totalSteps: plan.steps.length,
              estimatedTotalTime: plan.estimatedTotalTime,
              criticalPathLength: plan.criticalPathLength,
              steps: plan.steps.map(s => ({
                taskId: s.taskId,
                order: s.order,
                phase: s.phase,
                estimatedTime: s.estimatedTime,
                parallelGroup: s.parallelGroup,
              })),
            }, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 执行计划创建失败: ${msg}`;
          }
        },
      },
      {
        name: 'task_progress',
        description: '评估执行计划的当前进度。检查已完成、待执行和阻塞的步骤，计算完成百分比，识别阻塞原因和建议的下一步操作。',
        parameters: {
          planId: {
            type: 'string',
            description: '执行计划ID',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const planId = args.planId as string;
            const report = engine.evaluateProgress(planId);
            return Promise.resolve(JSON.stringify(report, null, 2));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 进度评估失败: ${msg}`);
          }
        },
      },
      {
        name: 'task_validate',
        description: '验证解决方案的完整性和逻辑一致性。检查是否覆盖所有需求，识别遗漏要素和逻辑漏洞，提供改进建议。',
        parameters: {
          task: {
            type: 'string',
            description: '原始任务描述',
            required: true,
          },
          solution: {
            type: 'string',
            description: '待验证的解决方案描述',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const task = args.task as string;
            const solution = args.solution as string;
            const result = await engine.validateSolution(task, solution);
            return JSON.stringify(result, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 方案验证失败: ${msg}`;
          }
        },
      },
      {
        name: 'task_adapt',
        description: '根据新信息自适应调整执行计划。重新评估剩余步骤，调整依赖关系和优先级，生成更新后的执行计划。',
        parameters: {
          planId: {
            type: 'string',
            description: '需要调整的执行计划ID',
            required: true,
          },
          newInformation: {
            type: 'string',
            description: '新信息描述，如需求变更、环境变化、中间结果等',
            required: true,
          },
        },
        execute: async (args) => {
          try {
            const planId = args.planId as string;
            const newInfo = args.newInformation as string;
            const adaptedPlan = await engine.adaptPlan(planId, newInfo);
            const progress = engine.evaluateProgress(planId);
            return JSON.stringify({
              planId: adaptedPlan.id,
              totalSteps: adaptedPlan.steps.length,
              estimatedTotalTime: adaptedPlan.estimatedTotalTime,
              progress,
            }, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 计划调整失败: ${msg}`;
          }
        },
      },
      {
        name: 'task_validate_decomposition',
        description: '验证任务分解的质量。检查MECE属性（相互独立、完全穷尽）、完整性（描述、依赖）和可执行性（验收标准、复杂度估算）。',
        parameters: {
          task: {
            type: 'string',
            description: '需要验证分解质量的任务描述',
            required: true,
          },
          depth: {
            type: 'number',
            description: '分解深度（1-6），默认3',
            required: false,
          },
          mode: {
            type: 'string',
            description: '分解模式: auto|pattern|llm|rule，默认auto',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const task = args.task as string;
            const depth = args.depth ? Number(args.depth) : DEFAULT_DECOMPOSITION_DEPTH;
            const mode = (args.mode as DecompositionMode) || 'auto';
            const tree = await engine.decomposeTask(task, depth, mode);
            const validation = await engine.validateDecomposition(tree);
            return JSON.stringify(validation, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 分解质量验证失败: ${msg}`;
          }
        },
      },
    ];
  }

  // ========== 私有方法：模式分解（来自 super-reasoning-engine.ts） ==========

  /**
   * 使用预定义模式分解任务
   * @returns TaskNode 或 null（无匹配模式时）
   */
  private patternDecompose(task: string, _depth: number): TaskNode | null {
    const matchedPattern = this.matchDecompositionPattern(task);
    if (!matchedPattern) return null;

    const rootId = `task_${Date.now()}_0`;
    const root: TaskNode = {
      id: rootId,
      description: task,
      status: 'pending',
      priority: 'high',
      dependencies: [],
      subtasks: [],
      estimatedComplexity: this.estimateComplexity(task),
      complexityLevel: this.complexityToLevel(this.estimateComplexity(task)),
      estimatedTime: this.estimateComplexity(task) * COMPLEXITY_TIME_BASE,
      requiredTools: this.inferRequiredTools(task),
      acceptanceCriteria: [`${task} 的所有要求均已满足`],
    };

    // 从模式生成子任务
    for (let i = 0; i < matchedPattern.subtasks.length; i++) {
      const st = matchedPattern.subtasks[i];
      const subtaskId = `${rootId}_${i + 1}`;
      const subtaskComplexity = st.estimatedDifficulty * 2; // 映射到1-10范围
      const subtask: TaskNode = {
        id: subtaskId,
        description: this.interpolateArgs(st.description, task),
        status: 'pending',
        priority: this.priorityFromNumber(st.priority),
        dependencies: i > 0 ? [`${rootId}_${i}`] : [],
        subtasks: [],
        estimatedComplexity: subtaskComplexity,
        complexityLevel: this.complexityToLevel(subtaskComplexity),
        estimatedTime: subtaskComplexity * COMPLEXITY_TIME_BASE,
        requiredTools: st.tool ? [st.tool] : [],
        acceptanceCriteria: [`${st.description} 已完成`],
      };

      root.subtasks.push(subtask);
    }

    return root;
  }

  /**
   * 匹配分解模式
   */
  private matchDecompositionPattern(goal: string): DecompositionPattern | null {
    for (const pattern of DECOMPOSITION_PATTERNS) {
      if (pattern.keywords.test(goal)) {
        return pattern;
      }
    }
    return null;
  }

  /** 插值参数到描述中 */
  private interpolateArgs(template: string, goal: string): string {
    return template.replace(/\$(\w+)/g, (match, key) => {
      const patterns: Record<string, RegExp> = {
        contact: /给(.+?)(?:发|发送)/,
        message: /发送?(?:消息|信息)?[:：]?\s*(.+)/,
        action: /(?:加|添加|执行)(.+)/,
        code: /(?:写|编写|实现)(.+)/,
        query: /(?:搜索|查找)(.+)/,
        path: /(?:文件|路径)[:：]?\s*(.+)/,
        output: /(?:输出|保存到|导出到)[:：]?\s*(.+)/,
        content: /(?:内容|文本)[:：]?\s*(.+)/,
        topic: /(?:关于|有关)(.+)/,
        text: /(?:翻译)(.+)/,
      };

      const pattern = patterns[key];
      if (pattern) {
        const match = goal.match(pattern);
        if (match) return match[1].trim();
      }

      return match;
    });
  }

  // ========== 私有方法：LLM 增强分解 ==========

  /**
   * 使用 LLM 进行任务分解（含 few-shot 示例）
   */
  private async llmDecompose(task: string, depth: number): Promise<TaskNode> {
    if (!this.modelLibrary) {
      throw new Error('ModelLibrary 未初始化');
    }

    const prompt = `你是一个任务分解专家。请将以下复杂任务分解为层次化的子任务树。

任务：${task}
分解深度：${depth}

要求：
1. 遵循 MECE 原则（相互独立、完全穷尽）
2. 每个任务节点包含：描述、优先级、复杂度(1-10)、复杂度等级(simple/medium/complex)、预估耗时(毫秒)、依赖关系、验收标准
3. 识别哪些子任务可以并行执行
4. 标注关键路径上的任务

## 示例

任务："开发一个用户登录功能"
返回：
{
  "id": "task_1",
  "description": "开发一个用户登录功能",
  "priority": "high",
  "estimatedComplexity": 7,
  "complexityLevel": "complex",
  "estimatedTime": 35000,
  "dependencies": [],
  "requiredTools": ["code_editor", "test_runner"],
  "acceptanceCriteria": ["用户可以通过邮箱/手机号登录", "支持密码和验证码两种方式", "登录失败有明确提示"],
  "subtasks": [
    {
      "id": "task_1_1",
      "description": "设计登录接口与数据模型",
      "priority": "critical",
      "estimatedComplexity": 3,
      "complexityLevel": "medium",
      "estimatedTime": 15000,
      "dependencies": [],
      "requiredTools": ["code_editor"],
      "acceptanceCriteria": ["接口文档完成", "数据模型定义完成"],
      "subtasks": []
    },
    {
      "id": "task_1_2",
      "description": "实现登录核心逻辑",
      "priority": "high",
      "estimatedComplexity": 5,
      "complexityLevel": "medium",
      "estimatedTime": 25000,
      "dependencies": ["task_1_1"],
      "requiredTools": ["code_editor"],
      "acceptanceCriteria": ["密码验证逻辑正确", "Token生成与验证正常"],
      "subtasks": []
    },
    {
      "id": "task_1_3",
      "description": "编写登录功能测试",
      "priority": "high",
      "estimatedComplexity": 3,
      "complexityLevel": "simple",
      "estimatedTime": 15000,
      "dependencies": ["task_1_2"],
      "requiredTools": ["test_runner"],
      "acceptanceCriteria": ["单元测试覆盖率>80%", "集成测试通过"],
      "subtasks": []
    }
  ]
}

## 请分解以下任务

请用 JSON 格式返回，结构与示例一致：`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: '你是段先生AI的任务分解专家，擅长将复杂任务拆解为可执行的层次化子任务。始终遵循MECE原则，确保子任务相互独立且完全穷尽。' },
      { role: 'user', content: prompt },
    ]);

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 返回格式无法解析');
    }

    return this.parseTaskNodeFromJson(JSON.parse(jsonMatch[0]));
  }

  /**
   * 解析 LLM 返回的 JSON 为 TaskNode
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseTaskNodeFromJson(json: any): TaskNode {
    const complexity = this.clampComplexity(json.estimatedComplexity);
    return {
      id: json.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: json.description || '',
      status: 'pending',
      priority: this.normalizePriority(json.priority),
      dependencies: Array.isArray(json.dependencies) ? json.dependencies : [],
      subtasks: Array.isArray(json.subtasks)
        ? json.subtasks.slice(0, MAX_SUBTASKS_PER_NODE).map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (st: any) => this.parseTaskNodeFromJson(st),
          )
        : [],
      estimatedComplexity: complexity,
      complexityLevel: json.complexityLevel || this.complexityToLevel(complexity),
      estimatedTime: json.estimatedTime || complexity * COMPLEXITY_TIME_BASE,
      requiredTools: Array.isArray(json.requiredTools) ? json.requiredTools : [],
      acceptanceCriteria: Array.isArray(json.acceptanceCriteria) ? json.acceptanceCriteria : [],
    };
  }

  // ========== 私有方法：规则分解 ==========

  /**
   * 基于规则的任务分解（降级方案）
   */
  private ruleBasedDecompose(task: string, depth: number): TaskNode {
    const rootId = `task_${Date.now()}_0`;
    const rootComplexity = this.estimateComplexity(task);
    const root: TaskNode = {
      id: rootId,
      description: task,
      status: 'pending',
      priority: 'high',
      dependencies: [],
      subtasks: [],
      estimatedComplexity: rootComplexity,
      complexityLevel: this.complexityToLevel(rootComplexity),
      estimatedTime: rootComplexity * COMPLEXITY_TIME_BASE,
      requiredTools: this.inferRequiredTools(task),
      acceptanceCriteria: [`${task} 的所有要求均已满足`],
    };

    // 按常见模式分解
    if (depth >= 1) {
      const phases = this.identifyPhases(task);
      for (let i = 0; i < phases.length; i++) {
        const subtaskId = `${rootId}_${i + 1}`;
        const subtaskComplexity = this.estimateComplexity(phases[i].description);
        const subtask: TaskNode = {
          id: subtaskId,
          description: phases[i].description,
          status: 'pending',
          priority: phases[i].priority,
          dependencies: i > 0 ? [`${rootId}_${i}`] : [],
          subtasks: [],
          estimatedComplexity: subtaskComplexity,
          complexityLevel: this.complexityToLevel(subtaskComplexity),
          estimatedTime: subtaskComplexity * COMPLEXITY_TIME_BASE,
          requiredTools: this.inferRequiredTools(phases[i].description),
          acceptanceCriteria: [`${phases[i].description} 已完成`],
        };

        // 深度递归分解
        if (depth >= 2 && subtask.estimatedComplexity >= 5) {
          const subPhases = this.identifyPhases(phases[i].description);
          for (let j = 0; j < subPhases.length && j < MAX_SUBTASKS_PER_NODE; j++) {
            const subSubComplexity = this.estimateComplexity(subPhases[j].description);
            subtask.subtasks.push({
              id: `${subtaskId}_${j + 1}`,
              description: subPhases[j].description,
              status: 'pending',
              priority: subPhases[j].priority,
              dependencies: j > 0 ? [`${subtaskId}_${j}`] : [],
              subtasks: [],
              estimatedComplexity: subSubComplexity,
              complexityLevel: this.complexityToLevel(subSubComplexity),
              estimatedTime: subSubComplexity * COMPLEXITY_TIME_BASE,
              requiredTools: this.inferRequiredTools(subPhases[j].description),
              acceptanceCriteria: [`${subPhases[j].description} 已完成`],
            });
          }
        }

        root.subtasks.push(subtask);
      }
    }

    return root;
  }

  /**
   * 识别任务阶段（基于关键词启发式）
   */
  private identifyPhases(task: string): Array<{ description: string; priority: TaskNode['priority'] }> {
    const phases: Array<{ description: string; priority: TaskNode['priority'] }> = [];

    // 分析类任务
    if (/分析|调研|评估|研究|investigate|analyze|research/i.test(task)) {
      phases.push({ description: `需求分析与信息收集: ${task}`, priority: 'critical' });
      phases.push({ description: '方案设计与可行性评估', priority: 'high' });
      phases.push({ description: '执行方案并验证结果', priority: 'high' });
      phases.push({ description: '总结与文档化', priority: 'medium' });
    }
    // 开发类任务
    else if (/开发|实现|编写|创建|构建|develop|implement|build|create/i.test(task)) {
      phases.push({ description: '需求确认与架构设计', priority: 'critical' });
      phases.push({ description: '核心功能实现', priority: 'high' });
      phases.push({ description: '测试与质量验证', priority: 'high' });
      phases.push({ description: '优化与部署', priority: 'medium' });
    }
    // 修复类任务
    else if (/修复|解决|调试|fix|debug|resolve|troubleshoot/i.test(task)) {
      phases.push({ description: '问题定位与根因分析', priority: 'critical' });
      phases.push({ description: '修复方案实施', priority: 'high' });
      phases.push({ description: '回归测试验证', priority: 'high' });
    }
    // 通用任务
    else {
      phases.push({ description: `理解与准备: ${task}`, priority: 'high' });
      phases.push({ description: '执行主要工作', priority: 'high' });
      phases.push({ description: '验证与完善', priority: 'medium' });
    }

    return phases;
  }

  /**
   * 估算任务复杂度（1-10）
   */
  private estimateComplexity(task: string): number {
    let complexity = 3;

    // 长度因素
    if (task.length > 200) complexity += 2;
    else if (task.length > 100) complexity += 1;

    // 关键词因素
    if (/复杂|高级|全面|系统|complex|comprehensive|systematic/i.test(task)) complexity += 2;
    if (/集成|协调|多步|多阶段|integrate|coordinate|multi-step/i.test(task)) complexity += 2;
    if (/优化|重构|迁移|optimize|refactor|migrate/i.test(task)) complexity += 1;
    if (/简单|快速|单一|simple|quick|single/i.test(task)) complexity -= 2;

    return Math.max(1, Math.min(10, complexity));
  }

  /**
   * 推断所需工具（基于关键词）
   */
  private inferRequiredTools(task: string): string[] {
    const tools: string[] = [];

    if (/文件|目录|读写|file|directory|read|write/i.test(task)) tools.push('file_ops');
    if (/搜索|查询|search|query|find/i.test(task)) tools.push('search');
    if (/代码|编程|code|program|implement/i.test(task)) tools.push('code_editor');
    if (/测试|验证|test|verify|validate/i.test(task)) tools.push('test_runner');
    if (/部署|发布|deploy|release|publish/i.test(task)) tools.push('deploy');
    if (/分析|统计|analyze|statistics/i.test(task)) tools.push('analyzer');
    if (/网络|API|请求|http|request/i.test(task)) tools.push('http_client');
    if (/数据库|database|sql|db/i.test(task)) tools.push('database');

    return tools;
  }

  // ========== 私有方法：任务树构建 ==========

  /**
   * 从根节点构建完整任务树
   */
  private buildTaskTree(root: TaskNode): TaskTree {
    const allNodes = this.flattenTaskNodes(root);
    const totalTasks = allNodes.size;
    const maxDepth = this.calculateMaxDepth(root);
    const criticalPath = this.findCriticalPath(root, allNodes);
    const parallelizableGroups = this.findParallelizableGroups(allNodes);

    return {
      root,
      totalTasks,
      maxDepth,
      parallelizableGroups,
      criticalPath,
    };
  }

  /**
   * 扁平化任务节点为 Map
   */
  private flattenTaskNodes(node: TaskNode): Map<string, TaskNode> {
    const result = new Map<string, TaskNode>();

    const traverse = (n: TaskNode) => {
      result.set(n.id, n);
      for (const sub of n.subtasks) {
        traverse(sub);
      }
    };

    traverse(node);
    return result;
  }

  /**
   * 计算最大深度
   */
  private calculateMaxDepth(node: TaskNode): number {
    if (node.subtasks.length === 0) return 1;
    return 1 + Math.max(...node.subtasks.map(st => this.calculateMaxDepth(st)));
  }

  /**
   * 查找关键路径（基于最长依赖链）
   */
  private findCriticalPath(root: TaskNode, allNodes: Map<string, TaskNode>): string[] {
    const memo = new Map<string, { path: string[]; cost: number }>();

    const dfs = (nodeId: string): { path: string[]; cost: number } => {
      if (memo.has(nodeId)) return memo.get(nodeId)!;

      const node = allNodes.get(nodeId);
      if (!node) return { path: [], cost: 0 };

      // 查找子节点
      const children = Array.from(allNodes.values()).filter(n =>
        n.dependencies.includes(nodeId)
      );

      if (children.length === 0) {
        const result = { path: [nodeId], cost: node.estimatedComplexity };
        memo.set(nodeId, result);
        return result;
      }

      let bestChild = { path: [] as string[], cost: 0 };
      for (const child of children) {
        const childResult = dfs(child.id);
        if (childResult.cost > bestChild.cost) {
          bestChild = childResult;
        }
      }

      const result = {
        path: [nodeId, ...bestChild.path],
        cost: node.estimatedComplexity + bestChild.cost,
      };
      memo.set(nodeId, result);
      return result;
    };

    return dfs(root.id).path;
  }

  /**
   * 查找可并行执行的任务组
   */
  private findParallelizableGroups(allNodes: Map<string, TaskNode>): string[][] {
    const groups: string[][] = [];
    const assigned = new Set<string>();

    // 按依赖层级分组
    const levels = this.computeDependencyLevels(allNodes);

    for (const [, levelNodes] of levels) {
      const parallelGroup: string[] = [];
      for (const nodeId of levelNodes) {
        if (!assigned.has(nodeId)) {
          parallelGroup.push(nodeId);
          assigned.add(nodeId);
        }
      }
      if (parallelGroup.length > 1) {
        groups.push(parallelGroup);
      }
    }

    return groups;
  }

  /**
   * 计算依赖层级
   */
  private computeDependencyLevels(allNodes: Map<string, TaskNode>): Map<number, string[]> {
    const levels = new Map<number, string[]>();
    const nodeLevels = new Map<string, number>();

    // 计算每个节点的层级
    const computeLevel = (nodeId: string, visited: Set<string> = new Set()): number => {
      if (nodeLevels.has(nodeId)) return nodeLevels.get(nodeId)!;
      if (visited.has(nodeId)) return 0; // 循环依赖保护
      visited.add(nodeId);

      const node = allNodes.get(nodeId);
      if (!node || node.dependencies.length === 0) {
        nodeLevels.set(nodeId, 0);
        return 0;
      }

      const depLevels = node.dependencies
        .filter(depId => allNodes.has(depId))
        .map(depId => computeLevel(depId, visited));
      // Guard against empty spread: Math.max(...[]) returns -Infinity,
      // which would corrupt the topological level computation.
      const maxDepLevel = depLevels.length > 0 ? Math.max(...depLevels) : 0;

      const level = maxDepLevel + 1;
      nodeLevels.set(nodeId, level);
      return level;
    };

    for (const nodeId of allNodes.keys()) {
      computeLevel(nodeId);
    }

    // 按层级分组
    for (const [nodeId, level] of nodeLevels) {
      const group = levels.get(level) || [];
      group.push(nodeId);
      levels.set(level, group);
    }

    return levels;
  }

  // ========== 私有方法：拓扑排序 ==========

  /**
   * 拓扑排序
   */
  private topologicalSort(allNodes: Map<string, TaskNode>): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      if (inStack.has(nodeId)) return; // 循环依赖保护

      inStack.add(nodeId);
      const node = allNodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (allNodes.has(depId)) {
            visit(depId);
          }
        }
      }
      inStack.delete(nodeId);
      visited.add(nodeId);
      result.push(nodeId);
    };

    // 按优先级排序后遍历，确保高优先级任务优先出现
    const sortedIds = Array.from(allNodes.entries())
      .sort(([, a], [, b]) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
      .map(([id]) => id);

    for (const nodeId of sortedIds) {
      visit(nodeId);
    }

    return result;
  }

  // ========== 私有方法：耗时计算 ==========

  /**
   * 计算预估总耗时
   */
  private calculateEstimatedTotalTime(
    steps: ExecutionStep[],
    criticalPath: string[],
    allNodes: Map<string, TaskNode>
  ): number {
    // 关键路径上的总耗时
    let criticalPathTime = 0;
    for (const taskId of criticalPath) {
      const node = allNodes.get(taskId);
      if (node) {
        criticalPathTime += node.estimatedTime || node.estimatedComplexity * COMPLEXITY_TIME_BASE;
      }
    }

    // 非关键路径任务可以与关键路径并行
    // 总耗时约等于关键路径耗时
    return criticalPathTime;
  }

  // ========== 私有方法：LLM 计划调整 ==========

  /**
   * 使用 LLM 调整计划
   */
  private async llmAdaptPlan(pendingNodes: TaskNode[], newInformation: string): Promise<TaskNode[] | null> {
    if (!this.modelLibrary || pendingNodes.length === 0) return null;

    const prompt = `基于新信息，请调整以下待执行任务的优先级、依赖关系和状态。

待执行任务：
${pendingNodes.map(n => `- ID: ${n.id}, 描述: ${n.description}, 优先级: ${n.priority}, 依赖: [${n.dependencies.join(', ')}], 状态: ${n.status}`).join('\n')}

新信息：${newInformation}

请返回 JSON 数组，仅包含需要调整的任务：
[
  {
    "id": "task_id",
    "priority": "critical|high|medium|low",
    "dependencies": ["dep_id"],
    "status": "pending|blocked"
  }
]`;

    try {
      const response = await this.modelLibrary.call([
        { role: 'system', content: '你是段先生AI的计划调整专家，擅长根据新信息动态优化执行计划。' },
        { role: 'user', content: prompt },
      ]);

      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return null;

      const adjustments = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(adjustments)) return null;

      return adjustments.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adj: any) => ({
          id: adj.id,
          description: pendingNodes.find(n => n.id === adj.id)?.description || '',
          status: adj.status || 'pending',
          priority: this.normalizePriority(adj.priority),
          dependencies: Array.isArray(adj.dependencies) ? adj.dependencies : [],
          subtasks: [],
          estimatedComplexity: pendingNodes.find(n => n.id === adj.id)?.estimatedComplexity || 5,
          complexityLevel: pendingNodes.find(n => n.id === adj.id)?.complexityLevel || 'medium',
          estimatedTime: pendingNodes.find(n => n.id === adj.id)?.estimatedTime || 25000,
          requiredTools: pendingNodes.find(n => n.id === adj.id)?.requiredTools || [],
          acceptanceCriteria: pendingNodes.find(n => n.id === adj.id)?.acceptanceCriteria || [],
        }),
      );
    } catch {
      return null;
    }
  }

  // ========== 私有方法：LLM 验证 ==========

  /**
   * 使用 LLM 验证解决方案
   */
  private async llmValidateSolution(task: string, solution: string): Promise<ValidationResult | null> {
    if (!this.modelLibrary) return null;

    const prompt = `请验证以下解决方案是否完整地解决了原始任务。

原始任务：${task}

解决方案：${solution}

请评估：
1. 解决方案是否覆盖了任务的所有要求？
2. 逻辑是否连贯一致？
3. 是否有遗漏的要素？
4. 是否有逻辑漏洞？

请用 JSON 格式返回：
{
  "complete": true/false,
  "completenessScore": 0.0-1.0,
  "missingElements": ["遗漏1"],
  "logicalGaps": ["漏洞1"],
  "suggestions": ["建议1"]
}`;

    try {
      const response = await this.modelLibrary.call([
        { role: 'system', content: '你是段先生AI的方案验证专家，擅长评估解决方案的完整性和逻辑一致性。' },
        { role: 'user', content: prompt },
      ]);

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        complete: !!parsed.complete,
        completenessScore: Math.max(0, Math.min(1, Number(parsed.completenessScore) || 0)),
        missingElements: Array.isArray(parsed.missingElements) ? parsed.missingElements : [],
        logicalGaps: Array.isArray(parsed.logicalGaps) ? parsed.logicalGaps : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * 基于规则的解决方案验证（降级方案）
   */
  private ruleBasedValidate(task: string, solution: string): ValidationResult {
    const missingElements: string[] = [];
    const logicalGaps: string[] = [];
    const suggestions: string[] = [];

    // 检查解决方案长度
    if (solution.length < 50) {
      missingElements.push('解决方案过于简短，可能缺少详细说明');
    }

    // 检查任务关键词是否在解决方案中被提及
    const taskKeywords = this.extractKeywords(task);
    const solutionLower = solution.toLowerCase();
    const unmentionedKeywords = taskKeywords.filter(kw => !solutionLower.includes(kw.toLowerCase()));

    if (unmentionedKeywords.length > 0 && taskKeywords.length > 2) {
      missingElements.push(`以下任务关键词未在解决方案中体现: ${unmentionedKeywords.join(', ')}`);
    }

    // 检查是否有验证/测试步骤
    if (/测试|验证|检查|确认|test|verify|check|validate/i.test(task) &&
        !/测试|验证|检查|确认|test|verify|check|validate/i.test(solution)) {
      logicalGaps.push('任务要求验证但解决方案中缺少验证步骤');
    }

    // 检查是否有错误处理
    if (/健壮|稳定|容错|robust|stable|error/i.test(task) &&
        !/错误|异常|失败|容错|error|exception|fallback/i.test(solution)) {
      logicalGaps.push('任务要求健壮性但解决方案中缺少错误处理');
    }

    // 计算完整性评分
    let score = 0.7; // 基础分
    score -= missingElements.length * 0.15;
    score -= logicalGaps.length * 0.1;
    if (solution.length > 200) score += 0.1;
    if (solution.length > 500) score += 0.05;

    // 生成建议
    if (missingElements.length > 0) {
      suggestions.push('补充解决方案中遗漏的要素');
    }
    if (logicalGaps.length > 0) {
      suggestions.push('填补逻辑漏洞，确保方案连贯性');
    }
    if (score < 0.5) {
      suggestions.push('建议重新审视解决方案，确保全面覆盖任务要求');
    }

    return {
      complete: missingElements.length === 0 && logicalGaps.length === 0,
      completenessScore: Math.max(0, Math.min(1, score)),
      missingElements,
      logicalGaps,
      suggestions,
    };
  }

  // ========== 私有方法：MECE 检查（来自 problem-decomposer.ts） ==========

  /**
   * 基于规则的 MECE 检查（降级方案）
   */
  private ruleBasedMECECheck(subtasks: Array<{ id: string; description: string }>): MECECheck {
    const overlaps: string[] = [];
    const gaps: string[] = [];

    // 检查描述相似度（简单关键词重叠检测）
    for (let i = 0; i < subtasks.length; i++) {
      for (let j = i + 1; j < subtasks.length; j++) {
        const keywordsI = this.extractKeywords(subtasks[i].description);
        const keywordsJ = this.extractKeywords(subtasks[j].description);
        const overlap = keywordsI.filter(kw => keywordsJ.includes(kw));
        if (overlap.length > 1) {
          overlaps.push(`"${subtasks[i].description.substring(0, 30)}" 与 "${subtasks[j].description.substring(0, 30)}" 存在重叠`);
        }
      }
    }

    // 检查穷尽性（基于子任务数量和描述覆盖度）
    if (subtasks.length < 2) {
      gaps.push('子任务数量过少，可能遗漏了某些方面');
    }

    // 检查是否有明确的动作描述
    const vagueDescs = subtasks.filter(st =>
      !/实现|完成|创建|开发|编写|测试|验证|分析|设计|修复|部署|执行|检查/i.test(st.description)
    );
    if (vagueDescs.length > 0) {
      gaps.push(`${vagueDescs.length}个子任务描述不够具体，可能遗漏了执行细节`);
    }

    const mutualExclusivity = overlaps.length === 0 ? 1.0 : Math.max(0, 1.0 - overlaps.length * 0.2);
    const collectiveExhaustiveness = gaps.length === 0 ? 1.0 : Math.max(0, 1.0 - gaps.length * 0.15);

    return {
      isMECE: overlaps.length === 0 && gaps.length === 0,
      mutualExclusivity,
      collectiveExhaustiveness,
      overlaps,
      gaps,
    };
  }

  // ========== 私有方法：辅助工具 ==========

  /**
   * 提取关键词
   */
  private extractKeywords(text: string): string[] {
    // 移除常见停用词
    const stopWords = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
      '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
      '自己', '这', '他', '她', '它', '们', '那', '些', '什么', '怎么', '如何',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
      'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while', 'for',
      'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as',
    ]);

    return text
      .split(/[\s,，。.！!？?；;：:、\n\r\t]+/)
      .filter(word => word.length > 1 && !stopWords.has(word.toLowerCase()));
  }

  /**
   * 规范化优先级
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizePriority(priority: any): TaskNode['priority'] {
    const valid: TaskNode['priority'][] = ['critical', 'high', 'medium', 'low'];
    if (typeof priority === 'string' && valid.includes(priority as TaskNode['priority'])) {
      return priority as TaskNode['priority'];
    }
    return 'medium';
  }

  /**
   * 限制复杂度范围
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clampComplexity(complexity: any): number {
    const num = Number(complexity);
    if (isNaN(num)) return 5;
    return Math.max(1, Math.min(10, Math.round(num)));
  }

  /**
   * 复杂度数值转等级
   */
  private complexityToLevel(complexity: number): 'simple' | 'medium' | 'complex' {
    if (complexity <= 3) return 'simple';
    if (complexity <= 6) return 'medium';
    return 'complex';
  }

  /**
   * 数字优先级转文字优先级
   */
  private priorityFromNumber(priority: number): TaskNode['priority'] {
    if (priority <= 1) return 'critical';
    if (priority <= 2) return 'high';
    if (priority <= 3) return 'medium';
    return 'low';
  }

  /**
   * 检测循环依赖
   */
  private detectCyclicDependencies(allNodes: Map<string, TaskNode>): boolean {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of allNodes.keys()) {
      color.set(id, WHITE);
    }

    const dfs = (nodeId: string): boolean => {
      color.set(nodeId, GRAY);
      const node = allNodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!color.has(depId)) continue;
          const depColor = color.get(depId);
          if (depColor === GRAY) return true; // 发现环
          if (depColor === WHITE && dfs(depId)) return true;
        }
      }
      color.set(nodeId, BLACK);
      return false;
    };

    for (const id of allNodes.keys()) {
      if (color.get(id) === WHITE) {
        if (dfs(id)) return true;
      }
    }

    return false;
  }

  /**
   * 序列化 TaskNode 为可 JSON 化的对象
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeTaskNode(node: TaskNode): any {
    return {
      id: node.id,
      description: node.description,
      status: node.status,
      priority: node.priority,
      dependencies: node.dependencies,
      subtasks: node.subtasks.map(st => this.serializeTaskNode(st)),
      estimatedComplexity: node.estimatedComplexity,
      complexityLevel: node.complexityLevel,
      estimatedTime: node.estimatedTime,
      requiredTools: node.requiredTools,
      acceptanceCriteria: node.acceptanceCriteria,
      result: node.result,
    };
  }
}
