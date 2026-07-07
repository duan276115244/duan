/**
 * 超级推理引擎 — SuperReasoningEngine
 *
 * 统一推理引擎，整合并增强现有推理能力：
 * - reasoning-engine.ts（多策略推理）
 * - autonomous-thinker.ts（6阶段自主思考）
 * - extended-thinking.ts（深度思维与制品）
 * - code-reasoning.ts（代码推理与验证）
 *
 * 核心能力：
 * 1. 统一推理入口：根据领域和深度自动选择最优策略
 * 2. 任务分解：将复杂目标拆解为可执行的子任务图
 * 3. 执行验证：验证执行结果是否真正达成目标
 * 4. 替代方案生成：失败时自动生成替代策略
 * 5. 经验学习：从推理结果中学习，持续优化
 * 6. 持久化：推理历史保存到 .duan/reasoning/history.json
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { ModelLibrary } from './model-library.js';
import { TaskDecompositionEngine } from './task-decomposition.js';
import { duanPath } from './duan-paths.js';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface ReasoningRequest {
  problem: string;
  context?: string;
  domain?: 'code' | 'general' | 'math' | 'creative' | 'desktop' | 'debug';
  depth?: 'shallow' | 'medium' | 'deep' | 'extended';
  maxSteps?: number;
  requireVerification?: boolean;
}

export interface ReasoningStep {
  id: string;
  type: 'understand' | 'decompose' | 'plan' | 'execute' | 'verify' | 'reflect' | 'adjust';
  content: string;
  confidence: number;
  duration: number;
  artifacts?: string[];
}

export interface ReasoningResult {
  answer: string;
  steps: ReasoningStep[];
  confidence: number;
  strategy: string;
  depth: string;
  duration: number;
  verified: boolean;
  alternatives?: string[];
  decomposition?: TaskDecomposition;
}

export interface TaskDecomposition {
  goal: string;
  subtasks: SubTask[];
  dependencies: Array<{ from: string; to: string }>;
  criticalPath: string[];
  estimatedComplexity: number;
}

export interface SubTask {
  id: string;
  description: string;
  tool?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolArgs?: Record<string, any>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  priority: number;
  estimatedDifficulty: number;
}

/** 推理历史记录 */
interface ReasoningHistoryEntry {
  timestamp: number;
  problem: string;
  domain: string;
  depth: string;
  strategy: string;
  confidence: number;
  verified: boolean;
  duration: number;
  stepCount: number;
  userFeedback?: 'positive' | 'negative';
}

/** 学习记录 */
interface LearningRecord {
  pattern: string;
  domain: string;
  strategy: string;
  successRate: number;
  sampleSize: number;
  lastUpdated: number;
}

/** 工具定义兼容类型 */
export interface ReasoningToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  readOnly?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: Record<string, any>) => Promise<string>;
}

// ============ 分解模式定义 ============

interface DecompositionPattern {
  keywords: RegExp;
  domain: string;
  subtasks: Array<{
    description: string;
    tool?: string;
    toolArgs?: Record<string, unknown>;
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
    keywords: /学习|教程|教程|learn|study|入门|了解/i,
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

export class SuperReasoningEngine {
  private log = logger.child({ module: 'SuperReasoningEngine' });
  private history: ReasoningHistoryEntry[] = [];
  private learningRecords: Map<string, LearningRecord> = new Map();
  private historyFilePath: string;
  private maxHistorySize = 500;
  private modelLibrary: ModelLibrary;
  private decompositionEngine: TaskDecompositionEngine;

  constructor(baseDir?: string) {
    // P0 D2: 优先使用显式 baseDir（保持向后兼容），否则用全局 duanPath
    this.historyFilePath = baseDir
      ? path.join(baseDir, '.duan', 'reasoning', 'history.json')
      : duanPath('reasoning', 'history.json');
    // 复用进程级单例，避免独立 clients Map / LRU 缓存造成连接池翻倍
    this.modelLibrary = ModelLibrary.getInstance();
    this.decompositionEngine = new TaskDecompositionEngine(this.modelLibrary);
    this.loadHistory();
    this.log.info('超级推理引擎初始化完成', {
      historySize: this.history.length,
      learningPatterns: this.learningRecords.size,
    });
  }

  // ========== 核心方法 ==========

  /**
   * 统一推理入口 — 根据领域和深度自动选择最优策略
   *
   * 策略选择逻辑：
   * - shallow: 直接回答（1步）
   * - medium: 理解 → 规划 → 执行（3步）
   * - deep: 完整6阶段循环（理解→分解→规划→执行→验证→反思）
   * - extended: deep + 验证 + 替代方案生成 + 自我修正
   */
  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    const startTime = Date.now();
    const domain = request.domain || 'general';
    const depth = request.depth || 'medium';
    const maxSteps = request.maxSteps || this.getDefaultMaxSteps(depth);
    const steps: ReasoningStep[] = [];

    this.log.info('开始推理', {
      problem: request.problem.substring(0, 100),
      domain,
      depth,
      maxSteps,
    });

    this.emitEvent('reasoning.start', {
      problem: request.problem.substring(0, 80),
      domain,
      depth,
    });

    let result: ReasoningResult;

    try {
      switch (depth) {
        case 'shallow':
          result = await this.reasonShallow(request, steps);
          break;
        case 'medium':
          result = await this.reasonMedium(request, steps);
          break;
        case 'deep':
          result = await this.reasonDeep(request, steps);
          break;
        case 'extended':
          result = await this.reasonExtended(request, steps);
          break;
        default:
          result = await this.reasonMedium(request, steps);
      }

      result.duration = Date.now() - startTime;
      result.steps = steps;

      // 持久化
      this.recordHistory(request, result);

      this.log.info('推理完成', {
        strategy: result.strategy,
        confidence: result.confidence,
        verified: result.verified,
        duration: result.duration,
        stepCount: steps.length,
      });

      this.emitEvent('reasoning.complete', {
        strategy: result.strategy,
        confidence: result.confidence,
        verified: result.verified,
        duration: result.duration,
        stepCount: steps.length,
      });

      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error('推理失败', { error: msg, domain, depth });

      const fallbackResult: ReasoningResult = {
        answer: `推理过程出错: ${msg}`,
        steps,
        confidence: 0,
        strategy: 'fallback',
        depth,
        duration: Date.now() - startTime,
        verified: false,
      };

      this.recordHistory(request, fallbackResult);
      return fallbackResult;
    }
  }

  /**
   * 任务分解 — 委托 TaskDecompositionEngine 执行
   */
  async decomposeTask(goal: string, context?: string): Promise<TaskDecomposition> {
    this.log.info('开始任务分解（委托 TaskDecompositionEngine）', { goal: goal.substring(0, 100) });

    try {
      const taskTree = await this.decompositionEngine.decomposeTask(goal);

      // 将 TaskDecompositionEngine 的 TaskTree 转换为当前接口的 TaskDecomposition
      const _allNodes = this.flattenTaskTreeNodes(taskTree.root);
      const subtasks: SubTask[] = [];
      let idx = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collectSubtasks = (node: any) => {
        subtasks.push({
          id: node.id || `subtask_${++idx}`,
          description: node.description,
          tool: node.requiredTools?.[0],
          toolArgs: undefined,
          status: (() => {
            if (node.status === 'pending') return 'pending';
            if (node.status === 'in_progress') return 'in_progress';
            if (node.status === 'completed') return 'completed';
            return 'failed';
          })(),
          priority: (() => {
            if (node.priority === 'critical') return 1;
            if (node.priority === 'high') return 2;
            if (node.priority === 'medium') return 3;
            return 4;
          })(),
          estimatedDifficulty: node.estimatedComplexity,
        });
        for (const sub of node.subtasks || []) {
          collectSubtasks(sub);
        }
      };
      collectSubtasks(taskTree.root);

      const dependencies = this.buildDependencyGraph(subtasks);
      const criticalPath = taskTree.criticalPath;
      const estimatedComplexity = taskTree.root.estimatedComplexity || this.estimateComplexity(subtasks);

      const decomposition: TaskDecomposition = {
        goal,
        subtasks,
        dependencies,
        criticalPath,
        estimatedComplexity,
      };

      this.log.info('任务分解完成（TaskDecompositionEngine）', {
        subtaskCount: subtasks.length,
        criticalPathLength: criticalPath.length,
        estimatedComplexity,
      });

      this.emitEvent('reasoning.decomposed', {
        goal: goal.substring(0, 80),
        subtaskCount: subtasks.length,
        estimatedComplexity,
      });

      return decomposition;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn('TaskDecompositionEngine 分解失败，降级为规则分解', { error: msg });

      // 降级：使用原有规则分解
      const matchedPattern = this.matchDecompositionPattern(goal);
      let subtasks: SubTask[];
      let _domain: string;

      if (matchedPattern) {
        _domain = matchedPattern.domain;
        subtasks = matchedPattern.subtasks.map((st, idx) => ({
          id: `subtask_${idx + 1}`,
          description: this.interpolateArgs(st.description, goal),
          tool: st.tool,
          toolArgs: this.interpolateToolArgs(st.toolArgs, goal, context),
          status: 'pending' as const,
          priority: st.priority,
          estimatedDifficulty: st.estimatedDifficulty,
        }));
      } else {
        _domain = this.inferDomain(goal);
        subtasks = this.genericDecompose(goal, context);
      }

      const dependencies = this.buildDependencyGraph(subtasks);
      const criticalPath = this.calculateCriticalPath(subtasks, dependencies);
      const estimatedComplexity = this.estimateComplexity(subtasks);

      const decomposition: TaskDecomposition = {
        goal,
        subtasks,
        dependencies,
        criticalPath,
        estimatedComplexity,
      };

      this.emitEvent('reasoning.decomposed', {
        goal: goal.substring(0, 80),
        subtaskCount: subtasks.length,
        estimatedComplexity,
      });

      return decomposition;
    }
  }

  /** 扁平化 TaskTree 节点 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private flattenTaskTreeNodes(node: any): Map<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traverse = (n: any) => {
      result.set(n.id, n);
      for (const sub of n.subtasks || []) {
        traverse(sub);
      }
    };
    traverse(node);
    return result;
  }

  /**
   * 执行验证 — 验证执行结果是否真正达成目标，关键词验证不确定时增加 LLM 辅助验证
   */
  async verifyExecution(
    goal: string,
    steps: ReasoningStep[],
    result: string,
  ): Promise<{ verified: boolean; issues: string[] }> {
    const issues: string[] = [];

    // 1. 检查结果是否回应了原始问题
    if (!result || result.trim().length === 0) {
      issues.push('执行结果为空');
    }

    // 2. 检查常见失败模式
    const failurePatterns = [
      { pattern: /error|错误|失败|failed|exception|异常/i, message: '结果中包含错误标记' },
      { pattern: /无法|不能|不可以|cannot|unable/i, message: '结果中包含能力限制标记' },
      { pattern: /超时|timeout|timed?\s*out/i, message: '执行超时' },
      { pattern: /权限|permission|denied|forbidden/i, message: '权限不足' },
    ];

    for (const { pattern, message } of failurePatterns) {
      if (pattern.test(result)) {
        issues.push(message);
      }
    }

    // 3. 检查步骤一致性 — 是否存在矛盾步骤
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const curr = steps[i];
      // 检查置信度骤降
      if (prev.confidence > 0.7 && curr.confidence < 0.3) {
        issues.push(`步骤${i}置信度骤降（从${(prev.confidence * 100).toFixed(0)}%降至${(curr.confidence * 100).toFixed(0)}%），可能存在推理跳跃`);
      }
    }

    // 4. 检查目标关键词覆盖率
    const goalKeywords = this.extractKeywords(goal);
    let coverage = 0;
    if (goalKeywords.length > 0) {
      const coveredCount = goalKeywords.filter(kw => result.toLowerCase().includes(kw.toLowerCase())).length;
      coverage = coveredCount / goalKeywords.length;
      if (coverage < 0.3) {
        issues.push(`目标关键词覆盖率仅${(coverage * 100).toFixed(0)}%，结果可能未充分回应目标`);
      }
    }

    // 5. 检查是否有执行步骤失败
    const failedSteps = steps.filter(s => s.type === 'execute' && s.confidence < 0.3);
    if (failedSteps.length > 0) {
      issues.push(`${failedSteps.length}个执行步骤置信度过低`);
    }

    // 6. 当关键词验证不确定时（覆盖率在 0.3-0.7 之间），使用 LLM 辅助验证
    if (coverage >= 0.3 && coverage < 0.7 && result.length > 0) {
      try {
        const llmVerification = await this.callLLM(
          '你是一个执行结果验证专家。请判断执行结果是否真正达成了原始目标。请用 JSON 格式返回：{"verified": true/false, "issues": ["问题1"]}',
          `原始目标：${goal}\n执行结果：${result.substring(0, 500)}`,
        );

        if (llmVerification) {
          const jsonMatch = llmVerification.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.verified === false && Array.isArray(parsed.issues)) {
              issues.push(...parsed.issues.filter((i: unknown) => typeof i === 'string'));
            }
          }
        }
      } catch {
        this.log.warn('LLM 辅助验证失败，仅使用规则验证结果');
      }
    }

    const verified = issues.length === 0;

    this.log.info('执行验证完成', { verified, issueCount: issues.length });

    return { verified, issues };
  }

  /**
   * 生成替代方案 — 当一种方法失败时，通过 LLM 动态生成替代策略
   */
  async generateAlternatives(problem: string, failedApproach: string): Promise<string[]> {
    // 尝试 LLM 动态生成
    try {
      const llmResult = await this.callLLM(
        '你是一个策略替代方案生成专家。当一种方法失败时，请生成3-5个可行的替代策略。请用 JSON 数组格式返回：["替代方案1", "替代方案2", "替代方案3"]',
        `问题：${problem}\n失败的方法：${failedApproach}`,
      );

      if (llmResult) {
        const jsonMatch = llmResult.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
            const unique = [...new Set(parsed as string[])];
            this.log.info('生成替代方案（LLM）', {
              problem: problem.substring(0, 60),
              failedApproach: failedApproach.substring(0, 60),
              alternativeCount: unique.length,
            });
            return unique;
          }
        }
      }
    } catch {
      this.log.warn('LLM 替代方案生成失败，降级为规则生成');
    }

    // 降级：基于失败方法推断替代方向
    const alternatives: string[] = [];
    const alternativeStrategies: Record<string, string[]> = {
      '直接推理': ['分步推理', '逆向推理', '类比推理'],
      '分步推理': ['整体直觉推理', '类比推理', '实验验证'],
      '代码实现': ['伪代码先行', '测试驱动开发', '参考现有实现'],
      '搜索方案': ['换用不同关键词', '搜索英文资料', '查阅官方文档'],
      '工具调用': ['使用替代工具', '手动执行', '组合多个工具'],
      '自动操作': ['手动操作指导', '半自动方案', '分步手动确认'],
    };

    for (const [key, alts] of Object.entries(alternativeStrategies)) {
      if (failedApproach.includes(key) || problem.includes(key)) {
        alternatives.push(...alts);
      }
    }

    if (alternatives.length === 0) {
      alternatives.push(
        '换一种思路重新分析问题',
        '将问题拆解为更小的子问题',
        '寻求外部信息或参考',
        '简化问题约束条件',
      );
    }

    const unique = [...new Set(alternatives)];

    this.log.info('生成替代方案（规则降级）', {
      problem: problem.substring(0, 60),
      failedApproach: failedApproach.substring(0, 60),
      alternativeCount: unique.length,
    });

    return unique;
  }

  /**
   * 从推理结果中学习
   */
  learnFromResult(
    request: ReasoningRequest,
    result: ReasoningResult,
    userFeedback?: 'positive' | 'negative',
  ): void {
    const domain = request.domain || 'general';
    const depth = request.depth || 'medium';
    const patternKey = `${domain}:${depth}:${result.strategy}`;

    const existing = this.learningRecords.get(patternKey);

    if (existing) {
      // 更新现有记录
      const totalSamples = existing.sampleSize + 1;
      const isSuccess = userFeedback === 'positive' || (result.verified && result.confidence >= 0.7);
      const successDelta = isSuccess ? 1 : 0;
      existing.sampleSize = totalSamples;
      existing.successRate = (existing.successRate * (totalSamples - 1) + successDelta) / totalSamples;
      existing.lastUpdated = Date.now();
    } else {
      // 创建新记录
      const isSuccess = userFeedback === 'positive' || (result.verified && result.confidence >= 0.7);
      this.learningRecords.set(patternKey, {
        pattern: patternKey,
        domain,
        strategy: result.strategy,
        successRate: isSuccess ? 1 : 0,
        sampleSize: 1,
        lastUpdated: Date.now(),
      });
    }

    this.log.info('学习记录已更新', {
      pattern: patternKey,
      feedback: userFeedback,
      confidence: result.confidence,
    });
  }

  /**
   * 获取推理统计信息
   */
  getReasoningStats(): {
    totalReasoning: number;
    averageConfidence: number;
    averageDuration: number;
    verificationRate: number;
    byDomain: Record<string, { count: number; avgConfidence: number }>;
    byStrategy: Record<string, { count: number; avgConfidence: number }>;
    learningPatterns: number;
    topPatterns: Array<{ pattern: string; successRate: number; sampleSize: number }>;
  } {
    const total = this.history.length;
    if (total === 0) {
      return {
        totalReasoning: 0,
        averageConfidence: 0,
        averageDuration: 0,
        verificationRate: 0,
        byDomain: {},
        byStrategy: {},
        learningPatterns: this.learningRecords.size,
        topPatterns: [],
      };
    }

    const avgConf = this.history.reduce((s, h) => s + h.confidence, 0) / total;
    const avgDur = this.history.reduce((s, h) => s + h.duration, 0) / total;
    const verifiedCount = this.history.filter(h => h.verified).length;

    const byDomain: Record<string, { count: number; avgConfidence: number; totalConf: number }> = {};
    const byStrategy: Record<string, { count: number; avgConfidence: number; totalConf: number }> = {};

    for (const h of this.history) {
      if (!byDomain[h.domain]) byDomain[h.domain] = { count: 0, avgConfidence: 0, totalConf: 0 };
      byDomain[h.domain].count++;
      byDomain[h.domain].totalConf += h.confidence;

      if (!byStrategy[h.strategy]) byStrategy[h.strategy] = { count: 0, avgConfidence: 0, totalConf: 0 };
      byStrategy[h.strategy].count++;
      byStrategy[h.strategy].totalConf += h.confidence;
    }

    for (const d of Object.values(byDomain)) {
      d.avgConfidence = d.count > 0 ? d.totalConf / d.count : 0;
    }
    for (const s of Object.values(byStrategy)) {
      s.avgConfidence = s.count > 0 ? s.totalConf / s.count : 0;
    }

    const topPatterns = Array.from(this.learningRecords.values())
      .sort((a, b) => b.sampleSize - a.sampleSize)
      .slice(0, 10)
      .map(r => ({ pattern: r.pattern, successRate: r.successRate, sampleSize: r.sampleSize }));

    return {
      totalReasoning: total,
      averageConfidence: Math.round(avgConf * 100) / 100,
      averageDuration: Math.round(avgDur),
      verificationRate: verifiedCount / total,
      byDomain: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, { count: v.count, avgConfidence: Math.round(v.avgConfidence * 100) / 100 }])),
      byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([k, v]) => [k, { count: v.count, avgConfidence: Math.round(v.avgConfidence * 100) / 100 }])),
      learningPatterns: this.learningRecords.size,
      topPatterns,
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ReasoningToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;

    return [
      {
        name: 'reason_think',
        description: '对问题进行深度推理分析。根据领域和深度自动选择最优推理策略，返回推理步骤、结论和置信度。支持4种深度：shallow(快速1步)、medium(3步)、deep(6阶段完整循环)、extended(深度+验证+替代方案+自修正)。领域包括：code(代码)、general(通用)、math(数学)、creative(创意)、desktop(桌面操作)、debug(调试)。此操作只读。',
        parameters: {
          problem: { type: 'string', description: '需要推理的问题', required: true },
          depth: { type: 'string', description: '推理深度: shallow/medium/deep/extended，默认medium', required: false },
          domain: { type: 'string', description: '问题领域: code/general/math/creative/desktop/debug，默认general', required: false },
          context: { type: 'string', description: '额外上下文信息', required: false },
          max_steps: { type: 'number', description: '最大推理步骤数', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await engine.reason({
              problem: args.problem,
              depth: args.depth as ReasoningRequest['depth'],
              domain: args.domain as ReasoningRequest['domain'],
              context: args.context,
              maxSteps: args.max_steps,
            });
            return JSON.stringify(result, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `推理失败: ${msg}`;
          }
        },
      },
      {
        name: 'reason_decompose',
        description: '将复杂任务分解为可执行的子任务图。自动识别任务类型，匹配最佳分解模式，构建依赖关系和关键路径。支持15+种预设分解模式（微信操作、PS编辑、PPT制作、代码编写、Bug修复等）。此操作只读。',
        parameters: {
          goal: { type: 'string', description: '需要分解的复杂目标', required: true },
          context: { type: 'string', description: '额外上下文信息', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const decomposition = await engine.decomposeTask(args.goal, args.context);
            return JSON.stringify(decomposition, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `任务分解失败: ${msg}`;
          }
        },
      },
      {
        name: 'reason_verify',
        description: '验证执行结果是否真正达成了原始目标。检查结果相关性、失败模式、步骤一致性和关键词覆盖率。此操作只读。',
        parameters: {
          goal: { type: 'string', description: '原始目标', required: true },
          result: { type: 'string', description: '执行结果', required: true },
          steps: { type: 'string', description: '推理步骤（JSON数组格式，可选）', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            let steps: ReasoningStep[] = [];
            if (args.steps) {
              try {
                steps = JSON.parse(args.steps);
              } catch { /* 忽略解析失败 */ }
            }
            const verification = await engine.verifyExecution(args.goal, steps, args.result);
            return JSON.stringify(verification, null, 2);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `验证失败: ${msg}`;
          }
        },
      },
    ];
  }

  // ========== 深度推理策略 ==========

  /** shallow: 直接回答（1步） */
  private async reasonShallow(request: ReasoningRequest, steps: ReasoningStep[]): Promise<ReasoningResult> {
    const start = Date.now();

    const answer = await this.callLLM(
      '你是一个快速回答助手。请针对用户的问题给出简洁、直接的回答。',
      `${request.context ? `背景信息：${request.context}\n\n` : ''}问题：${request.problem}`,
    ) || `针对"${request.problem.substring(0, 50)}"的快速回答`;

    steps.push({
      id: 'step_1',
      type: 'execute',
      content: `直接回答: ${answer.substring(0, 100)}`,
      confidence: 0.6,
      duration: Date.now() - start,
    });

    return {
      answer,
      steps,
      confidence: 0.6,
      strategy: this.selectStrategy(request),
      depth: 'shallow',
      duration: 0,
      verified: false,
    };
  }

  /** medium: 理解 → 规划 → 执行（3步） */
  private async reasonMedium(request: ReasoningRequest, steps: ReasoningStep[]): Promise<ReasoningResult> {
    // 步骤1: 理解
    const understandStart = Date.now();
    const understanding = await this.analyzeProblem(request.problem, request.context);
    steps.push({
      id: 'step_1',
      type: 'understand',
      content: `理解问题: ${understanding.coreQuestion}`,
      confidence: understanding.confidence,
      duration: Date.now() - understandStart,
    });

    // 步骤2: 规划
    const planStart = Date.now();
    const plan = await this.createExecutionPlan(understanding, request);
    steps.push({
      id: 'step_2',
      type: 'plan',
      content: `规划方案: ${plan.approach}`,
      confidence: 0.75,
      duration: Date.now() - planStart,
    });

    // 步骤3: 执行
    const execStart = Date.now();
    const answer = await this.synthesizeAnswer(understanding, plan);
    steps.push({
      id: 'step_3',
      type: 'execute',
      content: `执行完成: ${answer.substring(0, 100)}`,
      confidence: 0.7,
      duration: Date.now() - execStart,
    });

    const overallConfidence = steps.reduce((s, st) => s + st.confidence, 0) / steps.length;

    return {
      answer,
      steps,
      confidence: Math.round(overallConfidence * 100) / 100,
      strategy: this.selectStrategy(request),
      depth: 'medium',
      duration: 0,
      verified: false,
    };
  }

  /** deep: 完整6阶段循环（理解→分解→规划→执行→验证→反思） */
  private async reasonDeep(request: ReasoningRequest, steps: ReasoningStep[]): Promise<ReasoningResult> {
    // 阶段1: 理解
    const understandStart = Date.now();
    const understanding = await this.analyzeProblem(request.problem, request.context);
    steps.push({
      id: 'step_1',
      type: 'understand',
      content: `深层理解: ${understanding.coreQuestion} | 隐含需求: ${understanding.implicitNeeds.join(', ')}`,
      confidence: understanding.confidence,
      duration: Date.now() - understandStart,
    });

    // 阶段2: 分解
    const decomposeStart = Date.now();
    const decomposition = await this.decomposeTask(request.problem, request.context);
    steps.push({
      id: 'step_2',
      type: 'decompose',
      content: `任务分解: ${decomposition.subtasks.length}个子任务, 复杂度${decomposition.estimatedComplexity}/10`,
      confidence: 0.75,
      duration: Date.now() - decomposeStart,
      artifacts: decomposition.criticalPath,
    });

    // 阶段3: 规划
    const planStart = Date.now();
    const plan = await this.createExecutionPlan(understanding, request, decomposition);
    steps.push({
      id: 'step_3',
      type: 'plan',
      content: `执行规划: ${plan.approach}, 关键路径: ${decomposition.criticalPath.join('→')}`,
      confidence: 0.7,
      duration: Date.now() - planStart,
    });

    // 阶段4: 执行
    const execStart = Date.now();
    const answer = await this.synthesizeAnswer(understanding, plan, decomposition);
    steps.push({
      id: 'step_4',
      type: 'execute',
      content: `执行完成: ${answer.substring(0, 100)}`,
      confidence: 0.7,
      duration: Date.now() - execStart,
    });

    // 阶段5: 验证
    const verifyStart = Date.now();
    const verification = await this.verifyExecution(request.problem, steps, answer);
    steps.push({
      id: 'step_5',
      type: 'verify',
      content: `验证${verification.verified ? '通过' : '未通过'}${verification.issues.length > 0 ? ': ' + verification.issues.join('; ') : ''}`,
      confidence: verification.verified ? 0.85 : 0.4,
      duration: Date.now() - verifyStart,
    });

    // 阶段6: 反思
    const reflectStart = Date.now();
    const reflection = this.reflectOnReasoning(request, steps, answer, verification);
    steps.push({
      id: 'step_6',
      type: 'reflect',
      content: `反思: ${reflection.summary}`,
      confidence: 0.8,
      duration: Date.now() - reflectStart,
    });

    const overallConfidence = steps.reduce((s, st) => s + st.confidence, 0) / steps.length;

    return {
      answer,
      steps,
      confidence: Math.round(overallConfidence * 100) / 100,
      strategy: this.selectStrategy(request),
      depth: 'deep',
      duration: 0,
      verified: verification.verified,
      decomposition,
    };
  }

  /** extended: deep + 验证 + 替代方案生成 + 自我修正 */
  private async reasonExtended(request: ReasoningRequest, steps: ReasoningStep[]): Promise<ReasoningResult> {
    // 先执行deep推理
    const deepResult = await this.reasonDeep(request, steps);

    // 追加阶段: 替代方案生成
    const altStart = Date.now();
    const alternatives = await this.generateAlternatives(request.problem, deepResult.strategy);
    steps.push({
      id: `step_${steps.length + 1}`,
      type: 'adjust',
      content: `替代方案: ${alternatives.join('; ')}`,
      confidence: 0.65,
      duration: Date.now() - altStart,
    });

    // 追加阶段: 自我修正（如果验证未通过）
    if (!deepResult.verified) {
      const adjustStart = Date.now();
      const correctedAnswer = await this.selfCorrect(request, deepResult, alternatives);
      steps.push({
        id: `step_${steps.length + 1}`,
        type: 'adjust',
        content: `自我修正: ${correctedAnswer.substring(0, 100)}`,
        confidence: 0.6,
        duration: Date.now() - adjustStart,
      });

      // 重新验证
      const reVerification = await this.verifyExecution(request.problem, steps, correctedAnswer);
      deepResult.answer = correctedAnswer;
      deepResult.verified = reVerification.verified;
      deepResult.confidence = reVerification.verified
        ? Math.min(deepResult.confidence + 0.1, 0.95)
        : deepResult.confidence;
    }

    // 学习
    this.learnFromResult(request, deepResult);

    return {
      ...deepResult,
      alternatives,
      depth: 'extended',
    };
  }

  // ========== 策略选择 ==========

  /** 根据领域和深度选择推理策略 */
  private selectStrategy(request: ReasoningRequest): string {
    const domain = request.domain || 'general';
    const depth = request.depth || 'medium';

    // 查询学习记录，优先使用历史成功率高的策略
    const bestLearned = this.findBestLearnedStrategy(domain, depth);
    if (bestLearned) {
      return bestLearned;
    }

    // 默认策略映射
    const strategyMap: Record<string, Record<string, string>> = {
      code: {
        shallow: 'direct_code',
        medium: 'code_pipeline',
        deep: 'code_reasoning_pipeline',
        extended: 'code_reasoning_pipeline_with_verification',
      },
      debug: {
        shallow: 'direct_debug',
        medium: 'understand_hypothesize_test',
        deep: 'understand_hypothesize_test_verify',
        extended: 'debug_full_cycle_with_correction',
      },
      desktop: {
        shallow: 'direct_action',
        medium: 'decompose_plan_execute',
        deep: 'decompose_plan_execute_verify',
        extended: 'desktop_full_cycle_with_fallback',
      },
      general: {
        shallow: 'direct_response',
        medium: 'understand_plan_execute',
        deep: 'full_six_stage_cycle',
        extended: 'full_cycle_with_alternatives',
      },
      math: {
        shallow: 'direct_calculation',
        medium: 'formulate_solve_verify',
        deep: 'formulate_solve_verify_reflect',
        extended: 'math_exhaustive_with_proof',
      },
      creative: {
        shallow: 'direct_idea',
        medium: 'diverge_evaluate_refine',
        deep: 'diverge_evaluate_refine_iterate',
        extended: 'creative_full_cycle_with_critique',
      },
    };

    return strategyMap[domain]?.[depth] || 'understand_plan_execute';
  }

  /** 查找历史成功率最高的策略 */
  private findBestLearnedStrategy(domain: string, _depth: string): string | null {
    let bestRecord: LearningRecord | null = null;
    let bestScore = 0;

    for (const record of this.learningRecords.values()) {
      if (record.domain === domain && record.sampleSize >= 3) {
        const score = record.successRate * Math.log(record.sampleSize + 1);
        if (score > bestScore) {
          bestScore = score;
          bestRecord = record;
        }
      }
    }

    return bestRecord && bestRecord.successRate > 0.6 ? bestRecord.strategy : null;
  }

  // ========== 问题分析 ==========

  private async analyzeProblem(problem: string, context?: string): Promise<{
    coreQuestion: string;
    implicitNeeds: string[];
    constraints: string[];
    confidence: number;
  }> {
    // 尝试 LLM 分析
    try {
      const llmResult = await this.callLLM(
        '你是一个问题分析专家。请分析用户提出的问题，提取核心问题、隐含需求和约束条件。请用 JSON 格式返回：{"coreQuestion": "核心问题", "implicitNeeds": ["隐含需求1"], "constraints": ["约束条件1"], "confidence": 0.0-1.0}',
        `${context ? `背景信息：${context}\n\n` : ''}问题：${problem}`,
      );

      if (llmResult) {
        const jsonMatch = llmResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            coreQuestion: parsed.coreQuestion || problem,
            implicitNeeds: Array.isArray(parsed.implicitNeeds) ? parsed.implicitNeeds : [],
            constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
            confidence: Math.max(0.3, Math.min(0.95, Number(parsed.confidence) || 0.7)),
          };
        }
      }
    } catch {
      this.log.warn('LLM 问题分析失败，降级为规则分析');
    }

    // 降级：规则分析
    const implicitNeeds: string[] = [];
    const constraints: string[] = [];

    let coreQuestion = problem;
    const questionMatch = problem.match(/(?:如何|怎么|怎样|为什么|什么|哪|是否|能不能|可以吗)[^？?]*[？?]?/);
    if (questionMatch) {
      coreQuestion = questionMatch[0];
    }

    if (/代码|编程|函数/i.test(problem)) {
      implicitNeeds.push('代码可运行', '有错误处理');
    }
    if (/分析|评估|比较/i.test(problem)) {
      implicitNeeds.push('数据支撑', '多角度分析');
    }
    if (/写|创作|设计/i.test(problem)) {
      implicitNeeds.push('原创性', '结构清晰');
    }
    if (/操作|执行|运行/i.test(problem)) {
      implicitNeeds.push('操作步骤明确', '可执行');
    }

    const constraintPatterns = [/必须(.+?)[，,。.]/g, /不能(.+?)[，,。.]/g, /需要(.+?)[，,。.]/g];
    for (const pattern of constraintPatterns) {
      let match;
      while ((match = pattern.exec(problem)) !== null) {
        constraints.push(match[1].trim());
      }
    }

    let confidence = 0.7;
    if (problem.length < 10) confidence -= 0.2;
    if (implicitNeeds.length > 3) confidence -= 0.1;
    if (constraints.length > 2) confidence -= 0.1;

    return {
      coreQuestion,
      implicitNeeds,
      constraints,
      confidence: Math.max(0.3, Math.min(0.95, confidence)),
    };
  }

  // ========== 执行规划 ==========

  private async createExecutionPlan(
    understanding: { coreQuestion: string; implicitNeeds: string[]; constraints: string[] },
    request: ReasoningRequest,
    decomposition?: TaskDecomposition,
  ): Promise<{ approach: string; steps: string[] }> {
    // 构建 LLM 上下文
    const decompositionInfo = decomposition
      ? `\n任务分解（${decomposition.subtasks.length}个子任务）：\n` +
        decomposition.subtasks.map(st => `  - ${st.description}`).join('\n')
      : '';
    const needsInfo = understanding.implicitNeeds.length > 0
      ? `\n隐含需求: ${understanding.implicitNeeds.join('、')}` : '';
    const constraintsInfo = understanding.constraints.length > 0
      ? `\n约束条件: ${understanding.constraints.join('、')}` : '';

    // 尝试 LLM 规划
    try {
      const llmResult = await this.callLLM(
        '你是一个执行规划专家。请根据问题分析和任务分解信息，制定最优执行方案。请用 JSON 格式返回：{"approach": "方案描述", "steps": ["步骤1", "步骤2"]}',
        `核心问题：${understanding.coreQuestion}${decompositionInfo}${needsInfo}${constraintsInfo}`,
      );

      if (llmResult) {
        const jsonMatch = llmResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.approach && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
            return {
              approach: parsed.approach,
              steps: parsed.steps,
            };
          }
        }
      }
    } catch {
      this.log.warn('LLM 执行规划失败，降级为规则规划');
    }

    // 降级：规则规划
    const steps: string[] = [];

    if (decomposition) {
      for (const subtask of decomposition.subtasks) {
        steps.push(subtask.description);
      }
      return {
        approach: `基于任务分解的${decomposition.subtasks.length}步执行方案`,
        steps,
      };
    }

    steps.push('理解问题核心');
    steps.push('分析关键要素');
    steps.push('制定解决方案');
    steps.push('执行并验证');

    if (understanding.implicitNeeds.length > 0) {
      steps.push(`满足隐含需求: ${understanding.implicitNeeds.join(', ')}`);
    }

    return {
      approach: `${steps.length}步通用执行方案`,
      steps,
    };
  }

  // ========== 答案合成 ==========

  private async synthesizeAnswer(
    understanding: { coreQuestion: string; implicitNeeds: string[]; constraints: string[] },
    plan: { approach: string; steps: string[] },
    decomposition?: TaskDecomposition,
  ): Promise<string> {
    // 构建 LLM 上下文
    let decompositionInfo = '';
    if (decomposition) {
      decompositionInfo = `\n任务分解（${decomposition.subtasks.length}个子任务，复杂度${decomposition.estimatedComplexity}/10）：\n` +
        decomposition.subtasks.map(st => `  ${st.priority}. ${st.description}${st.tool ? ` [工具: ${st.tool}]` : ''}`).join('\n');
    }

    const planInfo = `\n执行方案（${plan.steps.length}步）：\n` +
      plan.steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n');

    const needsInfo = understanding.implicitNeeds.length > 0
      ? `\n隐含需求: ${understanding.implicitNeeds.join('、')}` : '';
    const constraintsInfo = understanding.constraints.length > 0
      ? `\n约束条件: ${understanding.constraints.join('、')}` : '';

    // 尝试 LLM 合成
    try {
      const llmAnswer = await this.callLLM(
        '你是一个推理答案合成专家。请根据问题分析、执行方案和任务分解信息，综合生成完整、有条理的回答。',
        `核心问题：${understanding.coreQuestion}${decompositionInfo}${planInfo}${needsInfo}${constraintsInfo}`,
      );
      if (llmAnswer) return llmAnswer;
    } catch {
      this.log.warn('LLM 答案合成失败，降级为规则合成');
    }

    // 降级：规则合成
    const parts: string[] = [];
    parts.push(`针对"${understanding.coreQuestion}"的分析结果：`);

    if (decomposition) {
      parts.push(`\n任务分解（${decomposition.subtasks.length}个子任务，复杂度${decomposition.estimatedComplexity}/10）：`);
      for (const st of decomposition.subtasks) {
        parts.push(`  ${st.priority}. ${st.description}${st.tool ? ` [工具: ${st.tool}]` : ''}`);
      }
    } else {
      parts.push(`\n执行方案（${plan.steps.length}步）：`);
      plan.steps.forEach((step, i) => {
        parts.push(`  ${i + 1}. ${step}`);
      });
    }

    if (understanding.implicitNeeds.length > 0) {
      parts.push(`\n隐含需求: ${understanding.implicitNeeds.join('、')}`);
    }
    if (understanding.constraints.length > 0) {
      parts.push(`约束条件: ${understanding.constraints.join('、')}`);
    }

    return parts.join('\n');
  }

  // ========== 反思 ==========

  private reflectOnReasoning(
    request: ReasoningRequest,
    steps: ReasoningStep[],
    answer: string,
    verification: { verified: boolean; issues: string[] },
  ): { summary: string; improvements: string[] } {
    const improvements: string[] = [];

    if (!verification.verified) {
      improvements.push(...verification.issues.map(i => `解决: ${i}`));
    }

    const lowConfSteps = steps.filter(s => s.confidence < 0.5);
    if (lowConfSteps.length > 0) {
      improvements.push(`${lowConfSteps.length}个步骤置信度偏低，需要加强推理`);
    }

    const summary = verification.verified
      ? `推理过程完整，验证通过。${improvements.length > 0 ? `改进建议: ${improvements.join('; ')}` : ''}`
      : `推理验证未通过，存在${verification.issues.length}个问题。改进方向: ${improvements.join('; ')}`;

    return { summary, improvements };
  }

  // ========== 自我修正 ==========

  private async selfCorrect(
    request: ReasoningRequest,
    result: ReasoningResult,
    alternatives: string[],
  ): Promise<string> {
    // 尝试 LLM 修正
    try {
      const llmResult = await this.callLLM(
        '你是一个推理自我修正专家。原推理方案验证未通过，请基于替代策略修正推理结果，给出更准确的回答。',
        `原始问题：${request.problem}\n原推理结果：${result.answer.substring(0, 300)}\n验证未通过原因：${result.steps.filter(s => s.type === 'verify').map(s => s.content).join('; ')}\n可用替代策略：${alternatives.join('、')}`,
      );
      if (llmResult) return llmResult;
    } catch {
      this.log.warn('LLM 自我修正失败，降级为规则修正');
    }

    // 降级：规则修正
    const parts: string[] = [];
    parts.push(`[修正后] 针对原始问题"${request.problem.substring(0, 50)}"：`);
    parts.push(`\n原方案验证未通过，基于替代策略修正：`);
    if (alternatives.length > 0) {
      parts.push(`尝试替代方案: ${alternatives[0]}`);
    }
    parts.push(`\n修正要点：`);
    parts.push(`- 重新审视问题核心，确保理解正确`);
    parts.push(`- 考虑之前忽略的边界条件`);
    parts.push(`- 采用更稳健的推理路径`);
    return parts.join('\n');
  }

  // ========== 分解辅助方法 ==========

  /** 匹配分解模式 */
  private matchDecompositionPattern(goal: string): DecompositionPattern | null {
    for (const pattern of DECOMPOSITION_PATTERNS) {
      if (pattern.keywords.test(goal)) {
        return pattern;
      }
    }
    return null;
  }

  /** 通用任务分解（无匹配模式时） */
  private genericDecompose(goal: string, _context?: string): SubTask[] {
    const subtasks: SubTask[] = [];

    // 基于目标文本分析生成子任务
    const segments = goal.split(/[，,、；;并且而且此外同时]/).filter(s => s.trim().length > 0);

    if (segments.length > 1) {
      // 多段目标：每段一个子任务
      segments.forEach((seg, idx) => {
        subtasks.push({
          id: `subtask_${idx + 1}`,
          description: seg.trim(),
          status: 'pending',
          priority: idx + 1,
          estimatedDifficulty: this.estimateSegmentDifficulty(seg),
        });
      });
    } else {
      // 单一目标：拆解为标准流程
      subtasks.push(
        { id: 'subtask_1', description: '理解目标需求', status: 'pending', priority: 1, estimatedDifficulty: 2 },
        { id: 'subtask_2', description: '制定执行方案', status: 'pending', priority: 2, estimatedDifficulty: 3 },
        { id: 'subtask_3', description: '执行核心操作', status: 'pending', priority: 3, estimatedDifficulty: 4 },
        { id: 'subtask_4', description: '验证执行结果', status: 'pending', priority: 4, estimatedDifficulty: 2 },
      );
    }

    return subtasks;
  }

  /** 推断领域 */
  private inferDomain(goal: string): string {
    if (/代码|编程|函数|bug|debug|部署/i.test(goal)) return 'code';
    if (/微信|PS|PPT|桌面|操作|应用/i.test(goal)) return 'desktop';
    if (/数学|计算|方程|证明/i.test(goal)) return 'math';
    if (/设计|创意|写作|创作/i.test(goal)) return 'creative';
    return 'general';
  }

  /** 构建依赖图 */
  private buildDependencyGraph(subtasks: SubTask[]): Array<{ from: string; to: string }> {
    const dependencies: Array<{ from: string; to: string }> = [];

    // 默认：按优先级顺序形成线性依赖
    for (let i = 1; i < subtasks.length; i++) {
      dependencies.push({ from: subtasks[i - 1].id, to: subtasks[i].id });
    }

    return dependencies;
  }

  /** 计算关键路径 */
  private calculateCriticalPath(subtasks: SubTask[], dependencies: Array<{ from: string; to: string }>): string[] {
    if (subtasks.length === 0) return [];

    // 简单实现：线性依赖时关键路径就是全部子任务
    // 复杂场景可使用拓扑排序+最长路径算法
    if (dependencies.length === subtasks.length - 1) {
      return subtasks.map(st => st.id);
    }

    // 有并行分支时，选择难度总和最高的路径
    const visited = new Set<string>();
    const path: string[] = [];

    const sortedSubtasks = [...subtasks].sort((a, b) => a.priority - b.priority);
    for (const st of sortedSubtasks) {
      if (!visited.has(st.id)) {
        visited.add(st.id);
        path.push(st.id);
      }
    }

    return path;
  }

  /** 估算复杂度（1-10） */
  private estimateComplexity(subtasks: SubTask[]): number {
    if (subtasks.length === 0) return 1;

    const totalDifficulty = subtasks.reduce((s, st) => s + st.estimatedDifficulty, 0);
    const avgDifficulty = totalDifficulty / subtasks.length;

    // 综合子任务数量和平均难度
    const complexity = Math.ceil(avgDifficulty * 0.6 + subtasks.length * 0.4);
    return Math.max(1, Math.min(10, complexity));
  }

  /** 估算片段难度 */
  private estimateSegmentDifficulty(segment: string): number {
    let difficulty = 2;
    if (/复杂|高级|优化|架构/i.test(segment)) difficulty += 2;
    if (/简单|基础|基本/i.test(segment)) difficulty -= 1;
    if (/自动化|批量|并发/i.test(segment)) difficulty += 1;
    if (/测试|验证|检查/i.test(segment)) difficulty += 0;
    return Math.max(1, Math.min(5, difficulty));
  }

  /** 插值参数到描述中 */
  private interpolateArgs(template: string, goal: string): string {
    return template.replace(/\$(\w+)/g, (match, key) => {
      // 尝试从目标中提取参数
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

  /** 插值工具参数 */
  private interpolateToolArgs(
    args: Record<string, unknown> | undefined,
    goal: string,
    _context?: string,
  ): Record<string, unknown> | undefined {
    if (!args) return undefined;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const paramName = value.substring(1);
        const patterns: Record<string, RegExp> = {
          name: /给(.+?)(?:发|发送)/,
          message: /(?:发|发送)(?:消息|信息)?[:：]?\s*(.+)/,
          query: /(?:搜索|查找|对比)(.+)/,
          app: /(PS|Photoshop|PPT|PowerPoint|Word|Excel)/i,
          action: /(?:加|添加|执行|用)(.+)/,
          code: /(?:写|编写|实现)(.+)/,
          path: /(?:文件|路径)[:：]?\s*(.+)/,
          text: /(?:翻译)(.+)/,
        };

        const pattern = patterns[paramName];
        if (pattern) {
          const match = goal.match(pattern);
          result[key] = match ? match[1].trim() : value;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  // ========== LLM 调用辅助 ==========

  /** 统一 LLM 调用入口 */
  private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      const result = await this.modelLibrary.call([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { autoFallback: true });
      return result.content;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn('LLM 调用失败，返回空字符串', { error: msg });
      return '';
    }
  }

  // ========== 通用辅助方法 ==========

  /** 提取关键词 */
  private extractKeywords(text: string): string[] {
    // 过滤停用词后提取有意义的关键词
    const stopWords = new Set(['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '他', '她', '它', '们', '把', '被', '让', '给', '从', '对', '为', '与', '以', '及', '等', '或', '但', '而', '如果', '那么', '因为', '所以', '可以', '能够', '应该', '需要', '必须', '可能']);

    const words = text
      .replace(/[，,。.！!？?；;：:、\n\r\t]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopWords.has(w));

    return [...new Set(words)];
  }

  /** 获取默认最大步骤数 */
  private getDefaultMaxSteps(depth: string): number {
    const defaults: Record<string, number> = {
      shallow: 1,
      medium: 3,
      deep: 6,
      extended: 10,
    };
    return defaults[depth] || 3;
  }

  // ========== 持久化 ==========

  /** 记录推理历史 */
  private recordHistory(request: ReasoningRequest, result: ReasoningResult): void {
    const entry: ReasoningHistoryEntry = {
      timestamp: Date.now(),
      problem: request.problem.substring(0, 200),
      domain: request.domain || 'general',
      depth: request.depth || 'medium',
      strategy: result.strategy,
      confidence: result.confidence,
      verified: result.verified,
      duration: result.duration,
      stepCount: result.steps.length,
    };

    this.history.push(entry);

    // 限制历史大小
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-Math.floor(this.maxHistorySize / 2));
    }

    // 异步保存
    this.saveHistory().catch(() => {
      // 保存失败不影响主流程
    });
  }

  /** 加载历史记录 */
  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const data = fs.readFileSync(this.historyFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.history)) {
          this.history = parsed.history;
        }
        if (parsed.learning && typeof parsed.learning === 'object') {
          for (const [key, value] of Object.entries(parsed.learning)) {
            this.learningRecords.set(key, value as LearningRecord);
          }
        }
        this.log.info('推理历史已加载', {
          historySize: this.history.length,
          learningPatterns: this.learningRecords.size,
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn('加载推理历史失败', { error: msg });
    }
  }

  /** 保存历史记录 */
  private saveHistory(): Promise<void> {
    try {
      const dir = path.dirname(this.historyFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const learningObj: Record<string, LearningRecord> = {};
      for (const [key, value] of this.learningRecords) {
        learningObj[key] = value;
      }

      const data = {
        history: this.history,
        learning: learningObj,
        lastSaved: Date.now(),
      };

      atomicWriteJsonSync(this.historyFilePath, data);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn('保存推理历史失败', { error: msg });
    }
    return Promise.resolve();
  }

  /** 发射事件 */
  private emitEvent(type: string, data: Record<string, unknown>): void {
    try {
      EventBus.getInstance().emitSync(type, {
        ...data,
        source: 'SuperReasoningEngine',
        timestamp: Date.now(),
      });
    } catch {
      // 事件发射失败不影响主流程
    }
  }
}
