/**
 * 增强版智能体循环 — 共享类型与内部组件
 *
 * 从 enhanced-agent-loop.ts 拆分出的类型定义和内部类：
 * - 类型：ToolRiskLevel, ExecutionPolicy, PlanStep, ExecutionPlan,
 *         ApprovalRequest, ApprovalResult, ReflectionResult, ToolRegistryEntry
 * - 类：TaskPlanner, ApprovalGate, ResultReflector, ToolRegistry
 */

import type OpenAI from 'openai';
import type { ToolDef } from './agent-loop-types.js';
import { TOOL_RISK_MAP } from './unified-tool-def.js';
import type { SelfLearningSystem } from './self-learning-system.js';
import type { TwoStageClassifier } from './permission-classifier.js';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 工具风险等级 */
export type ToolRiskLevel = 'safe' | 'moderate' | 'dangerous';

/** 工具执行策略 */
export type ExecutionPolicy = 'parallel' | 'serial' | 'approval_required';

/** 执行计划步骤 */
export interface PlanStep {
  id: string;
  description: string;
  toolHint?: string;
  dependencies?: string[];
  estimatedRisk: ToolRiskLevel;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: string;
}

/** 执行计划 */
export interface ExecutionPlan {
  id: string;
  goal: string;
  complexity: 'simple' | 'moderate' | 'complex';
  steps: PlanStep[];
  strategy: string;
  estimatedTurns: number;
  createdAt: number;
  alternativeApproaches?: string[];
}

/** 审批请求 */
export interface ApprovalRequest {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  reason: string;
  timestamp: number;
}

/** 审批结果 */
export interface ApprovalResult {
  approved: boolean;
  modified?: boolean;
  modifiedArgs?: Record<string, unknown>;
  reason?: string;
}

/** 反思结果 */
export interface ReflectionResult {
  taskCompleted: boolean;
  qualityScore: number;       // 0-1
  lessonsLearned: string[];
  strategyEffective: boolean;
  improvements: string[];
  experienceCategory: string;
}

/** 工具注册条目 */
export interface ToolRegistryEntry {
  definition: ToolDef;
  riskLevel: ToolRiskLevel;
  executionPolicy: ExecutionPolicy;
  sandboxEnabled: boolean;
  approvalMessage: string;
}

/** 工具注册表通用接口 — ToolRegistry 与 ToolRegistryAdapter 共用 */
export interface IToolRegistry {
  register(def: ToolDef, riskLevel?: ToolRiskLevel, executionPolicy?: ExecutionPolicy, sandboxEnabled?: boolean, approvalMessage?: string): void;
  registerAll(toolDefs: ToolDef[]): void;
  get(name: string): ToolRegistryEntry | undefined;
  getRiskLevel(name: string): ToolRiskLevel;
  getExecutionPolicy(name: string): ExecutionPolicy;
  getAllDefinitions(): ToolDef[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOpenAITools(userMessage?: string, maxTools?: number): any[];
}

// ============ 常量 ============

// P1 优化: 下调宽松阈值，减少绕圈子与 token 浪费
// 原 DEFAULT_MAX_TURNS=40 + MAX_TURN_EXTENSION=50 最坏 60 轮，DOOM_LOOP_THRESHOLD=5 太晚识别死循环
export const DOOM_LOOP_THRESHOLD = 3;
export const MAX_COMPACT_RETRIES = 3;
export const COMPACT_COOLDOWN_MS = 30000;
export const DEFAULT_TOKEN_BUDGET = 100000;
export const DEFAULT_MAX_TURNS = 20;
export const MAX_TURN_EXTENSION = 15;
export const PLAN_REASSESS_INTERVAL = 15;

/**
 * 生成计划状态文本（用于注入到 system prompt）
 */
export function getPlanStatusString(plan: ExecutionPlan | null): string {
  if (!plan || plan.steps.length === 0) return '';
  const lines = plan.steps.map((s, i) => {
    let statusIcon: string;
    if (s.status === 'completed') {
      statusIcon = '✅';
    } else if (s.status === 'in_progress') {
      statusIcon = '🔄';
    } else if (s.status === 'failed') {
      statusIcon = '❌';
    } else if (s.status === 'skipped') {
      statusIcon = '⏭️';
    } else {
      statusIcon = '⬜';
    }
    const depInfo = s.dependencies && s.dependencies.length > 0
      ? ` (依赖步骤: ${s.dependencies.join(', ')})`
      : '';
    return `${statusIcon} 步骤 ${i + 1}: ${s.description}${depInfo}`;
  });
  let result = `\n## 当前执行计划\n${lines.join('\n')}\n策略: ${plan.strategy}\n`;
  if (plan.alternativeApproaches && plan.alternativeApproaches.length > 0) {
    result += `\n备用方案:\n${plan.alternativeApproaches.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n`;
  }
  return result;
}

// ============ TaskPlanner: 任务规划器 ============

export class TaskPlanner {
  private client: { client: OpenAI; model: string };
  private learningSystem: SelfLearningSystem | null;

  constructor(client: { client: OpenAI; model: string }, learningSystem: SelfLearningSystem | null) {
    this.client = client;
    this.learningSystem = learningSystem;
  }

  /**
   * 分析任务复杂度并生成执行计划
   */
  async plan(input: string, availableTools: string[]): Promise<ExecutionPlan> {
    const complexity = this.assessComplexity(input);

    if (complexity === 'simple') {
      // 社交问候/极短输入/能力询问 → 1步完成，不强行拆分为多步骤
      const isSocial = /^(你好|hi|hello|嗨|您好|在吗|hey|thanks|谢谢|bye|再见|good\s*bye|\?|test|测试|help|帮助)$/i.test(input.trim());
      // 能力询问类问题（如"你能干什么""你会什么""介绍下你自己"）也视为社交对话，直接回复
      const isConversational = /^(你能干什么|你会什么|你能做什么|你会做什么|介绍下你自己|介绍一下你自己|你是谁|你叫什么|你是什么|who are you|what can you do|introduce yourself)/i.test(input.trim());
      return {
        id: `plan-${Date.now()}`,
        goal: input,
        complexity,
        steps: [
          {
            id: 'step-1',
            description: (isSocial || isConversational) ? `回复用户: ${input.substring(0, 100)}` : `理解并完成任务: ${input.substring(0, 100)}`,
            estimatedRisk: 'safe',
            status: 'pending',
          },
        ],
        strategy: 'direct',
        estimatedTurns: (isSocial || isConversational) ? 1 : 2,
        createdAt: Date.now(),
      };
    }

    // 获取相关学习经验
    let experienceContext = '';
    if (this.learningSystem) {
      experienceContext = this.learningSystem.getLearningContext(input);
    }

    const isCreative = /设计|创建|生成|编写|构建|写|创作|开发|发明|构思/.test(input);
    const isAnalysis = /分析|比较|评估|研究|调查|理解|解释|总结/.test(input);

    const planPrompt = `你是一个任务规划器。分析用户请求，制定执行计划。

用户请求: ${input}
复杂度: ${complexity}
任务类型: ${(() => { if (isCreative) return '创造性'; if (isAnalysis) return '分析型'; return '执行型'; })()}

可用工具: ${availableTools.join(', ')}

${experienceContext ? `相关经验:\n${experienceContext}` : ''}

请输出JSON格式的执行计划（不要输出其他内容）:
{
  "steps": [
    {"description": "步骤描述", "toolHint": "建议使用的工具", "estimatedRisk": "safe/moderate/dangerous", "dependencies": [前置步骤的索引(从0开始)]}
  ],
  "strategy": "策略名称和理由",
  "estimatedTurns": 预计轮次数,
  "alternativeApproaches": ["如果主要方法失败，可以尝试的其他方法"]
}

规则:
- 每个步骤应该是原子操作
- 没有依赖的步骤可以并行
- 危险操作（文件写入、命令执行）标记为 dangerous
- 只读操作标记为 safe
- 网络操作标记为 moderate
- 如果步骤B依赖步骤A的结果，在B的dependencies中填入A的索引
${isCreative ? `- 创造性任务: 先搜索参考/获取灵感，再执行，最后验证\n- 包含"验证"步骤确保质量` : ''}
${isAnalysis ? `- 分析型任务: 先收集数据，再分析处理，最后总结结论` : ''}
- 总步数控制在3-8步
- 最后一步应该是验证或总结`;

    try {
      const response = await this.client.client.chat.completions.create({
        model: this.client.model,
        messages: [
          { role: 'system', content: '你是任务规划器，只输出JSON格式的执行计划。' },
          { role: 'user', content: planPrompt },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.fallbackPlan(input, complexity);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        id: `plan-${Date.now()}`,
        goal: input,
        complexity,
        steps: (parsed.steps || []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any, i: number) => ({
            id: `step-${i + 1}`,
            description: s.description || `步骤 ${i + 1}`,
            toolHint: s.toolHint,
            estimatedRisk: s.estimatedRisk || 'moderate',
            dependencies: Array.isArray(s.dependencies) ? s.dependencies.map((d: number) => `step-${d + 1}`) : undefined,
            status: 'pending' as const,
          })),
        strategy: parsed.strategy || 'sequential',
        estimatedTurns: parsed.estimatedTurns || 5,
        alternativeApproaches: Array.isArray(parsed.alternativeApproaches) ? parsed.alternativeApproaches : undefined,
        createdAt: Date.now(),
      };
    } catch {
      return this.fallbackPlan(input, complexity);
    }
  }

  /**
   * 评估任务复杂度
   * P2/#1 修复：原正则仅覆盖中文，英文查询（如 "search stock price"）不命中任何指标
   * → 误判 simple → 1步计划 → LLM 文字回复绕过工具调用。
   * 现补充英文关键词和通用动作词（查询/search/lookup/check 等）。
   */
  private assessComplexity(input: string): 'simple' | 'moderate' | 'complex' {
    const indicators = {
      multiStep: /然后|接着|之后|并且|同时|以及|还有|另外|then|after that|and also|as well as|additionally/.test(input),
      codeRelated: /代码|函数|文件|项目|修改|重构|实现|开发|code|function|file|project|modify|refactor|implement|develop/.test(input),
      analysis: /分析|比较|评估|研究|调查|analyz|compar|evaluat|research|investigat/.test(input),
      creative: /设计|创建|生成|编写|构建|design|create|generat|write|build/.test(input),
      errorHandling: /错误|问题|修复|调试|排查|error|bug|fix|debug|troubleshoot/.test(input),
      // P2/#1 新增：通用动作词，覆盖查询/搜索类指令（英文 "search stock price" 之前误判 simple）
      actionOriented: /查询|搜索|查找|获取|打开|运行|检查|search|lookup|find|fetch|open|run|check|look up/.test(input),
    };

    const score = Object.values(indicators).filter(Boolean).length;
    if (score <= 0) return 'simple';
    if (score <= 3) return 'moderate';
    return 'complex';
  }

  private fallbackPlan(input: string, complexity: 'simple' | 'moderate' | 'complex'): ExecutionPlan {
    return {
      id: `plan-${Date.now()}`,
      goal: input,
      complexity,
      steps: [{
        id: 'step-1',
        description: `执行任务: ${input.substring(0, 100)}`,
        estimatedRisk: 'moderate',
        status: 'pending',
      }],
      strategy: 'react',
      estimatedTurns: complexity === 'complex' ? 10 : 5,
      createdAt: Date.now(),
    };
  }
}

// ============ ApprovalGate: 安全审批门控 ============

export class ApprovalGate {
  private callback: ((request: ApprovalRequest) => Promise<ApprovalResult>) | null;
  private autoApproveSafe: boolean;
  private pendingApprovals: Map<string, ApprovalResult> = new Map();
  private classifier: TwoStageClassifier | null;

  constructor(
    callback: ((request: ApprovalRequest) => Promise<ApprovalResult>) | null,
    autoApproveSafe: boolean = true,
    classifier: TwoStageClassifier | null = null,
  ) {
    this.callback = callback;
    this.autoApproveSafe = autoApproveSafe;
    this.classifier = classifier;
  }

  /**
   * 两阶段权限检查
   */
  async checkApproval(
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: ToolRiskLevel,
    reason: string,
  ): Promise<ApprovalResult> {
    // ===== Stage 1: 自动放行安全工具 =====
    if (this.autoApproveSafe && riskLevel === 'safe') {
      return { approved: true };
    }

    // ===== Stage 2: 两阶段分类器 =====
    if (this.classifier) {
      const classification = await this.classifier.classify(toolName, toolArgs);
      if (classification === 'approved') {
        return { approved: true, reason: '[Stage1 快速过滤] 自动批准' };
      }
      if (classification === 'denied') {
        return { approved: false, reason: '[Stage1 快速过滤] 自动拒绝: 已知危险模式' };
      }
      // needs_review: 继续到现有审批流程
    }

    // ===== 降级: 无回调时默认行为 =====
    if (!this.callback) {
      if (riskLevel === 'dangerous') {
        return { approved: false, reason: '高风险操作需要审批回调才能执行' };
      }
      return { approved: true };
    }

    const request: ApprovalRequest = {
      id: `approval-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      toolName,
      toolArgs,
      riskLevel,
      reason,
      timestamp: Date.now(),
    };

    try {
      const result = await this.callback(request);
      this.pendingApprovals.set(request.id, result);
      return result;
    } catch {
      return { approved: false, reason: '审批回调执行失败' };
    }
  }
}

// ============ ResultReflector: 执行结果反思器 ============

export class ResultReflector {
  private client: { client: OpenAI; model: string };
  private learningSystem: SelfLearningSystem | null;

  constructor(client: { client: OpenAI; model: string }, learningSystem: SelfLearningSystem | null) {
    this.client = client;
    this.learningSystem = learningSystem;
  }

  /**
   * 对执行结果进行反思评估
   */
  async reflect(
    input: string,
    plan: ExecutionPlan,
    executionLog: Array<{ tool: string; result: string; success: boolean }>,
    finalOutput: string,
  ): Promise<ReflectionResult> {
    const completedSteps = plan.steps.filter(s => s.status === 'completed').length;
    const failedSteps = plan.steps.filter(s => s.status === 'failed').length;
    const totalSteps = plan.steps.length;

    // 快速评估：不需要LLM
    if (plan.complexity === 'simple' && completedSteps === totalSteps) {
      const result: ReflectionResult = {
        taskCompleted: true,
        qualityScore: 0.9,
        lessonsLearned: [],
        strategyEffective: true,
        improvements: [],
        experienceCategory: 'simple_completion',
      };

      if (this.learningSystem) {
        this.learningSystem.learnFromInteraction(input, finalOutput);
      }
      return result;
    }

    // 复杂任务：使用LLM进行深度反思
    try {
      const reflectPrompt = `评估以下任务执行结果:

原始请求: ${input}
执行策略: ${plan.strategy}
步骤完成: ${completedSteps}/${totalSteps} (失败: ${failedSteps})
执行日志:
${executionLog.map((e, i) => `  ${i + 1}. ${e.tool}: ${e.success ? '成功' : '失败'} - ${e.result.substring(0, 100)}`).join('\n')}

最终输出: ${finalOutput.substring(0, 500)}

请输出JSON格式的反思结果（不要输出其他内容）:
{
  "taskCompleted": true/false,
  "qualityScore": 0.0-1.0,
  "lessonsLearned": ["经验1", "经验2"],
  "strategyEffective": true/false,
  "improvements": ["改进建议1"],
  "experienceCategory": "分类"
}`;

      const response = await this.client.client.chat.completions.create({
        model: this.client.model,
        messages: [
          { role: 'system', content: '你是执行结果评估器，只输出JSON格式的评估结果。' },
          { role: 'user', content: reflectPrompt },
        ],
        max_tokens: 512,
        temperature: 0.2,
      });

      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.defaultReflection(completedSteps, totalSteps, failedSteps);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const result: ReflectionResult = {
        taskCompleted: parsed.taskCompleted ?? completedSteps === totalSteps,
        qualityScore: parsed.qualityScore ?? completedSteps / totalSteps,
        lessonsLearned: parsed.lessonsLearned || [],
        strategyEffective: parsed.strategyEffective ?? true,
        improvements: parsed.improvements || [],
        experienceCategory: parsed.experienceCategory || 'general',
      };

      // 将学习经验注入学习系统
      if (this.learningSystem && result.lessonsLearned.length > 0) {
        for (const lesson of result.lessonsLearned) {
          this.learningSystem.learnFromInteraction(input, lesson);
        }
      }

      return result;
    } catch {
      return this.defaultReflection(completedSteps, totalSteps, failedSteps);
    }
  }

  private defaultReflection(completed: number, total: number, failed: number): ReflectionResult {
    return {
      taskCompleted: completed === total && failed === 0,
      qualityScore: total > 0 ? completed / total : 0,
      lessonsLearned: [],
      strategyEffective: failed < completed,
      improvements: failed > 0 ? ['部分步骤失败，考虑调整策略'] : [],
      experienceCategory: 'default',
    };
  }
}

// ============ ToolRegistry: 工具注册表 ============

export class ToolRegistry implements IToolRegistry {
  private entries: Map<string, ToolRegistryEntry> = new Map();

  /**
   * 注册工具
   */
  register(
    definition: ToolDef,
    riskLevel: ToolRiskLevel = 'moderate',
    executionPolicy: ExecutionPolicy = definition.readOnly ? 'parallel' : 'serial',
    sandboxEnabled: boolean = false,
    approvalMessage: string = '',
  ): void {
    this.entries.set(definition.name, {
      definition,
      riskLevel,
      executionPolicy,
      sandboxEnabled,
      approvalMessage: approvalMessage || `即将执行 ${definition.name}，此操作可能产生副作用。`,
    });
  }

  /**
   * 批量注册工具
   */
  registerAll(toolDefs: ToolDef[]): void {
    for (const def of toolDefs) {
      const risk = TOOL_RISK_MAP[def.name] || (def.readOnly ? 'safe' : 'moderate');
      const policy: ExecutionPolicy = def.readOnly ? 'parallel' : 'serial';
      this.register(def, risk, policy);
    }
  }

  get(name: string): ToolRegistryEntry | undefined {
    return this.entries.get(name);
  }

  getRiskLevel(name: string): ToolRiskLevel {
    return this.entries.get(name)?.riskLevel || 'moderate';
  }

  getExecutionPolicy(name: string): ExecutionPolicy {
    return this.entries.get(name)?.executionPolicy || 'serial';
  }

  getAllDefinitions(): ToolDef[] {
    return Array.from(this.entries.values()).map(e => e.definition);
  }

  getOpenAITools(userMessage?: string, maxTools: number = 30) {
    const allDefs = this.getAllDefinitions();

    // If we have fewer tools than maxTools, just return all of them
    if (allDefs.length <= maxTools) {
      return allDefs.map(t => this._formatTool(t));
    }

    // Smart selection: categorize tools by relevance to the user message
    const msg = (userMessage || '').toLowerCase();

    // Always-include core tools (essential for any operation)
    const alwaysInclude = new Set([
      'file_read', 'file_write', 'shell_execute', 'web_search', 'code_execute',
      'list_tools', 'create_plan', 'update_plan_step', 'create_tool', 'spawn_agent',
      'spawn_and_wait', 'complete',
      'http_request',
    ]);

    // Domain detection from user message
    const domains: string[] = [];
    if (/微信|wechat|发消息|联系人/.test(msg)) domains.push('wechat');
    if (/截图|屏幕|桌面|点击|鼠标|键盘|应用|打开.*程序/.test(msg)) domains.push('desktop');
    if (/ps|photoshop|修图|图片编辑|加文字|调色|边框/.test(msg)) domains.push('photoshop');
    if (/ppt|powerpoint|幻灯片|演示/.test(msg)) domains.push('ppt');
    if (/vscode|代码|编程|写.*函数|开发|项目/.test(msg)) domains.push('code');
    if (/浏览器|网页|搜索|网址|chrome|edge/.test(msg)) domains.push('browser');
    if (/图片|生成.*图|画|设计|海报/.test(msg)) domains.push('image');
    if (/视频|录制|剪辑/.test(msg)) domains.push('video');
    if (/搜索|查|找资料/.test(msg)) domains.push('search');
    if (/文件|目录|路径|读取|写入/.test(msg)) domains.push('file');
    if (/git|提交|分支|仓库/.test(msg)) domains.push('git');
    if (/记忆|记住|回忆/.test(msg)) domains.push('memory');
    if (/任务|计划|规划/.test(msg)) domains.push('task');
    if (/技能|学习|安装/.test(msg)) domains.push('skill');

    // Tool domain mapping
    const toolDomainMap: Record<string, string[]> = {
      wechat: ['wechat_', 'app_'],
      desktop: ['screen_', 'desktop_', 'app_', 'visual_'],
      photoshop: ['app_', 'visual_'],
      ppt: ['app_', 'visual_'],
      code: ['code_', 'shell_', 'file_', 'git_', 'generate_', 'create_', 'analyze_', 'optimize_'],
      browser: ['app_', 'web_', 'visual_'],
      image: ['image_', 'app_', 'visual_', 'generate_', 'optimize_'],
      video: ['video_', 'app_', 'generate_', 'create_', 'analyze_', 'optimize_'],
      search: ['web_', 'search_', 'analyze_'],
      file: ['file_', 'shell_'],
      git: ['git_', 'shell_'],
      memory: ['memory_', 'context_', 'knowledge_'],
      task: ['task_', 'plan_', 'schedule_'],
      skill: ['skill_', 'learn_'],
    };

    // Domain mutual exclusion: if browser is detected, exclude PS/desktop-specific tools
    const excludedPrefixes = new Set<string>();
    if (domains.includes('browser') && !domains.includes('photoshop') && !domains.includes('desktop')) {
      excludedPrefixes.add('screen_');
      excludedPrefixes.add('desktop_');
    }
    if (domains.includes('photoshop') && !domains.includes('browser')) {
      excludedPrefixes.add('web_');
    }

    // Score each tool
    const scored = allDefs.map(tool => {
      let score = 0;

      // Exclude conflicting domain tools
      if (excludedPrefixes.size > 0 && excludedPrefixes.has(tool.name.split('_')[0] + '_')) {
        return { tool, score: -10 };
      }

      // Always-include tools get highest score
      if (alwaysInclude.has(tool.name)) { score = 100; }
      else {
        // Base score for core prefixes
        const corePrefixes = ['file_', 'shell_', 'code_', 'web_', 'search_', 'self_', 'list_', 'generate_', 'create_', 'analyze_', 'optimize_'];
        if (corePrefixes.some(p => tool.name.startsWith(p))) score = 30;

        // Boost score for domain-relevant tools
        for (const domain of domains) {
          const relevantPrefixes = toolDomainMap[domain] || [];
          if (relevantPrefixes.some(p => tool.name.startsWith(p))) {
            score = Math.max(score, 80);
          }
        }

        // If no specific domain detected, include common tools
        if (domains.length === 0) {
          const commonPrefixes = ['file_', 'shell_', 'web_', 'code_', 'search_', 'screen_', 'app_', 'self_', 'memory_', 'context_', 'generate_', 'create_', 'analyze_', 'optimize_'];
          if (commonPrefixes.some(p => tool.name.startsWith(p))) score = Math.max(score, 60);
        }
      }

      return { tool, score };
    });

    // Sort by score descending, then take top N tools
    scored.sort((a, b) => b.score - a.score);

    // Take all tools with score > 0, up to maxTools
    const selected = scored.filter(s => s.score > 0).slice(0, maxTools).map(s => s.tool);

    // If we have fewer than half of maxTools selected, add more from unselected
    const minTools = Math.floor(maxTools / 2);
    if (selected.length < minTools) {
      const selectedNames = new Set(selected.map(t => t.name));
      const remaining = allDefs.filter(t => !selectedNames.has(t.name));
      selected.push(...remaining.slice(0, minTools - selected.length));
    }

    if (allDefs.length > maxTools) {
      logger.info('智能选择工具', { module: 'ToolRegistry', selected: selected.length, total: allDefs.length, domains: domains.join(',') || '通用' });
    }

    return selected.map(t => this._formatTool(t));
  }

  private _formatTool(t: ToolDef) {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    for (const [key, param] of Object.entries(t.parameters || {})) {
      properties[key] = { type: param.type, description: param.description };
      if (param.required) required.push(key);
    }
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description || '',
        parameters: {
          type: 'object',
          properties,
          required,
        },
      },
    };
  }
}
