/**
 * 自主思考引擎 - AutonomousThinker
 *
 * 真正的Agent不只是回答问题，而是：
 * 1. 自我思考：收到任务后先思考再行动
 * 2. 自我检查：执行后验证结果是否正确
 * 3. 自我修正：发现错误自动修正
 * 4. 自我反思：完成后总结经验教训
 *
 * 思考循环：理解 → 规划 → 执行 → 验证 → 修正 → 反思
 */

import type { ModelLibrary } from './model-library.js';
import type { UnifiedToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 思考阶段 */
export type ThinkPhase =
  | 'understand'    // 理解任务
  | 'plan'          // 规划方案
  | 'execute'       // 执行操作
  | 'verify'        // 验证结果
  | 'correct'       // 修正错误
  | 'reflect';      // 反思总结

/** 思考步骤 */
export interface ThinkStep {
  phase: ThinkPhase;
  content: string;
  confidence: number;
  timestamp: number;
  duration: number;
}

/** 思考结果 */
export interface ThinkResult {
  understanding: TaskUnderstanding;
  plan: ExecutionPlan;
  steps: ThinkStep[];
  verification: VerificationResult;
  reflection: ReflectionResult;
  totalIterations: number;
  totalDuration: number;
  success: boolean;
}

/** 任务理解 */
export interface TaskUnderstanding {
  originalInput: string;
  surfaceIntent: string;       // 表面意图
  deepIntent: string;          // 深层意图
  implicitNeeds: string[];     // 隐含需求
  constraints: string[];       // 约束条件
  successCriteria: string[];   // 成功标准
  ambiguity: string[];         // 不明确之处
  confidence: number;
}

/** 执行计划 */
export interface ExecutionPlan {
  steps: PlanStep[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  requiresTools: string[];
  risks: string[];
  fallbackStrategy: string;
}

/** 计划步骤 */
export interface PlanStep {
  id: number;
  description: string;
  tool?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;  // 工具参数
  expectedOutcome: string;
  rollbackAction?: string;
}

/** 验证结果 */
export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  issues: string[];
  suggestions: string[];
  overallQuality: number;      // 0-1
}

/** 单项验证 */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

/** 反思结果 */
export interface ReflectionResult {
  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  improvements: string[];
  similarTasks: string[];      // 类似任务的模式
}

/** 思考事件 */
export interface ThinkEvent {
  type: 'think' | 'plan' | 'verify' | 'correct' | 'reflect' | 'progress';
  phase: ThinkPhase;
  content: string;
  confidence?: number;
}

// ============ 主类 ============

export class AutonomousThinker {
  private modelLibrary: ModelLibrary;
  private tools?: UnifiedToolDef[];
  private maxIterations: number;
  private minConfidence: number;
  private thinkHistory: ThinkResult[] = [];
  private learnedPatterns: Map<string, string> = new Map();
  /** 单次思考超时（毫秒） */
  private readonly THINK_TIMEOUT = 120000; // 2分钟

  constructor(modelLibrary: ModelLibrary, options?: {
    maxIterations?: number;
    minConfidence?: number;
    tools?: UnifiedToolDef[];
  }) {
    this.modelLibrary = modelLibrary;
    this.tools = options?.tools;
    this.maxIterations = options?.maxIterations || 5;
    this.minConfidence = options?.minConfidence || 0.7;
  }

  /**
   * 带超时的异步包装器
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    });
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer!);
      return result;
    } catch {
      clearTimeout(timer!);
      return fallback;
    }
  }

  /**
   * 自主思考 - 完整的思考循环
   * 这是Agent的核心：不是直接回答，而是思考→验证→修正→反思
   */
  async think(
    input: string,
    context?: string[],
    onEvent?: (event: ThinkEvent) => void,
  ): Promise<ThinkResult> {
    const startTime = Date.now();
    const steps: ThinkStep[] = [];
    let iterations = 0;

    // ===== 阶段1: 理解任务 =====
    const understandStart = Date.now();
    onEvent?.({ type: 'think', phase: 'understand', content: '正在理解任务...' });

    const understanding = await this.understandTask(input, context);
    steps.push({
      phase: 'understand',
      content: `深层意图: ${understanding.deepIntent}`,
      confidence: understanding.confidence,
      timestamp: understandStart,
      duration: Date.now() - understandStart,
    });

    onEvent?.({
      type: 'think',
      phase: 'understand',
      content: `理解完成: ${understanding.deepIntent} (置信度${(understanding.confidence * 100).toFixed(0)}%)`,
      confidence: understanding.confidence,
    });

    // ===== 阶段2: 规划方案 =====
    const planStart = Date.now();
    onEvent?.({ type: 'plan', phase: 'plan', content: '正在规划执行方案...' });

    const plan = await this.createPlan(understanding);
    steps.push({
      phase: 'plan',
      content: `规划${plan.steps.length}个步骤`,
      confidence: 0.8,
      timestamp: planStart,
      duration: Date.now() - planStart,
    });

    onEvent?.({
      type: 'plan',
      phase: 'plan',
      content: `规划完成: ${plan.steps.length}个步骤, 复杂度${plan.estimatedComplexity}`,
    });

    // ===== 阶段3-5: 执行→验证→修正循环 =====
    let verification: VerificationResult = {
      passed: false,
      checks: [],
      issues: [],
      suggestions: [],
      overallQuality: 0,
    };

    let executionResult = '';
    let lastCorrection = '';
    const loopTimeout = this.THINK_TIMEOUT;
    const loopStart = Date.now();

    while (iterations < this.maxIterations) {
      // 检查循环超时
      if (Date.now() - loopStart > loopTimeout) {
        onEvent?.({ type: 'progress', phase: 'execute', content: '⚠️ 思考循环超时，返回当前结果' });
        if (!executionResult) {
          executionResult = '思考超时，请简化问题后重试';
        }
        verification = {
          passed: true,
          checks: [{ name: 'timeout', passed: true, detail: '超时保护触发', severity: 'warning' }],
          issues: ['思考超时'],
          suggestions: ['请简化问题'],
          overallQuality: 0.5,
        };
        break;
      }

      iterations++;

      // 执行
      const execStart = Date.now();
      onEvent?.({
        type: 'progress',
        phase: 'execute',
        content: `第${iterations}轮执行...`,
      });

      executionResult = await this.executeWithPlan(understanding, plan, lastCorrection, context);
      steps.push({
        phase: 'execute',
        content: `执行完成，结果长度${executionResult.length}`,
        confidence: 0.7,
        timestamp: execStart,
        duration: Date.now() - execStart,
      });

      // 验证
      const verifyStart = Date.now();
      onEvent?.({ type: 'verify', phase: 'verify', content: '正在验证结果...' });

      verification = await this.verifyResult(input, executionResult, understanding);
      steps.push({
        phase: 'verify',
        content: `验证${verification.passed ? '通过' : '未通过'}, 质量${(verification.overallQuality * 100).toFixed(0)}%`,
        confidence: verification.overallQuality,
        timestamp: verifyStart,
        duration: Date.now() - verifyStart,
      });

      onEvent?.({
        type: 'verify',
        phase: 'verify',
        content: `验证${verification.passed ? '✅通过' : '❌未通过'} - 质量${(verification.overallQuality * 100).toFixed(0)}%`,
        confidence: verification.overallQuality,
      });

      // 如果验证通过或质量足够高，退出循环
      if (verification.passed || verification.overallQuality >= this.minConfidence) {
        break;
      }

      // 修正
      if (iterations < this.maxIterations && verification.issues.length > 0) {
        const correctStart = Date.now();
        onEvent?.({
          type: 'correct',
          phase: 'correct',
          content: `发现${verification.issues.length}个问题，正在修正...`,
        });

        lastCorrection = await this.correctResult(
          input, executionResult, verification, understanding
        );
        steps.push({
          phase: 'correct',
          content: `修正方案: ${lastCorrection.substring(0, 100)}`,
          confidence: 0.6,
          timestamp: correctStart,
          duration: Date.now() - correctStart,
        });
      } else {
        break;
      }
    }

    // ===== 阶段6: 反思 =====
    const reflectStart = Date.now();
    onEvent?.({ type: 'reflect', phase: 'reflect', content: '正在反思...' });

    const reflection = await this.reflectOnResult(
      input, executionResult, verification, understanding
    );
    steps.push({
      phase: 'reflect',
      content: `反思完成: ${reflection.lessonsLearned.length}条经验`,
      confidence: 0.8,
      timestamp: reflectStart,
      duration: Date.now() - reflectStart,
    });

    // 保存学习到的模式
    for (const lesson of reflection.lessonsLearned) {
      this.learnedPatterns.set(understanding.deepIntent, lesson);
    }

    const result: ThinkResult = {
      understanding,
      plan,
      steps,
      verification,
      reflection,
      totalIterations: iterations,
      totalDuration: Date.now() - startTime,
      success: verification.passed || verification.overallQuality >= this.minConfidence,
    };

    this.thinkHistory.push(result);
    return result;
  }

  /**
   * 快速思考 - 简化版，用于简单任务
   */
  async quickThink(input: string): Promise<string> {
    // 检查是否有已学习的模式
    const cached = this.findLearnedPattern(input);
    if (cached) return cached;

    // 简单理解
    const _understanding = await this.understandTask(input);

    // 直接生成回答
    const response = await this.modelLibrary.call([
      { role: 'system', content: this.buildThinkSystemPrompt() },
      { role: 'user', content: input },
    ]);

    return response.content;
  }

  /**
   * 自我检查 - 对已有结果进行验证
   */
  async selfCheck(input: string, result: string): Promise<VerificationResult> {
    const understanding = await this.understandTask(input);
    return this.verifyResult(input, result, understanding);
  }

  // ========== 核心方法 ==========

  /**
   * 理解任务 - 深度分析用户意图
   */
  private async understandTask(
    input: string,
    context?: string[]
  ): Promise<TaskUnderstanding> {
    const prompt = `深度分析以下用户输入，提取深层意图和隐含需求。

用户输入: ${input}
${context ? `上下文: ${context.slice(-3).join('\n')}` : ''}

请用JSON格式返回：
{
  "surfaceIntent": "表面意图（一句话）",
  "deepIntent": "深层意图（用户真正想要什么）",
  "implicitNeeds": ["隐含需求1", "隐含需求2"],
  "constraints": ["约束条件1"],
  "successCriteria": ["成功标准1"],
  "ambiguity": ["不明确之处1"],
  "confidence": 0.85
}`;

    try {
      const response = await this.modelLibrary.call([
        { role: 'system', content: '你是一个任务分析专家，擅长理解用户深层意图。' },
        { role: 'user', content: prompt },
      ]);

      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          originalInput: input,
          surfaceIntent: parsed.surfaceIntent || '未知',
          deepIntent: parsed.deepIntent || parsed.surfaceIntent || '未知',
          implicitNeeds: parsed.implicitNeeds || [],
          constraints: parsed.constraints || [],
          successCriteria: parsed.successCriteria || [],
          ambiguity: parsed.ambiguity || [],
          confidence: parsed.confidence || 0.5,
        };
      }
    } catch {
      // 降级到本地分析
    }

    // 本地降级分析
    return this.localUnderstand(input);
  }

  /**
   * 本地降级分析（不依赖LLM）
   */
  private localUnderstand(input: string): TaskUnderstanding {
    let surfaceIntent = 'general_query';
    let deepIntent = input;
    const implicitNeeds: string[] = [];
    const constraints: string[] = [];
    const successCriteria: string[] = [];
    const ambiguity: string[] = [];

    if (/代码|编程|函数|bug/i.test(input)) {
      surfaceIntent = 'coding';
      deepIntent = '用户需要代码解决方案';
      implicitNeeds.push('代码可运行', '有错误处理');
      successCriteria.push('代码能正常运行', '有注释说明');
    } else if (/分析|评估|比较/i.test(input)) {
      surfaceIntent = 'analysis';
      deepIntent = '用户需要深度分析';
      implicitNeeds.push('数据支撑', '多角度分析');
      successCriteria.push('有数据支撑', '有明确结论');
    } else if (/写|创作|设计/i.test(input)) {
      surfaceIntent = 'creative';
      deepIntent = '用户需要创意内容';
      implicitNeeds.push('原创性', '结构清晰');
      successCriteria.push('内容完整', '有创意');
    } else if (/怎么|如何|步骤/i.test(input)) {
      surfaceIntent = 'how_to';
      deepIntent = '用户需要操作指导';
      implicitNeeds.push('步骤清晰', '可操作');
      successCriteria.push('步骤完整', '可执行');
    }

    if (input.length < 10) ambiguity.push('输入过短，意图不明确');

    return {
      originalInput: input,
      surfaceIntent,
      deepIntent,
      implicitNeeds,
      constraints,
      successCriteria,
      ambiguity,
      confidence: ambiguity.length > 0 ? 0.4 : 0.6,
    };
  }

  /**
   * 创建执行计划
   */
  private async createPlan(understanding: TaskUnderstanding): Promise<ExecutionPlan> {
    // 构建可用工具列表描述
    const availableTools = this.tools && this.tools.length > 0
      ? this.tools.map(t => {
          const params = Object.entries(t.parameters)
            .map(([key, val]) => `    - ${key}${val.required ? '(必填)' : '(可选)'}: ${val.description}`)
            .join('\n');
          return `- ${t.name}: ${t.description}\n${params || '    (无参数)'}`;
        }).join('\n')
      : '无可用工具';

    const prompt = `基于以下任务理解，创建执行计划：

深层意图: ${understanding.deepIntent}
隐含需求: ${understanding.implicitNeeds.join(', ')}
约束条件: ${understanding.constraints.join(', ')}
成功标准: ${understanding.successCriteria.join(', ')}

可用工具列表:
${availableTools}

请用JSON格式返回：
{
  "steps": [
    {"id": 1, "description": "步骤描述", "tool": "工具名称（如需使用工具，从可用工具列表中选择；如不需要工具则设为null）", "params": {"参数名": "参数值"}, "expectedOutcome": "预期结果", "rollbackAction": "回滚操作"}
  ],
  "estimatedComplexity": "low|medium|high",
  "requiresTools": ["tool1"],
  "risks": ["风险1"],
  "fallbackStrategy": "降级策略"
}

注意：tool字段仅在确实需要调用工具时填写工具名称，否则设为null或不填。params字段为工具的参数对象，仅当tool不为null时需要提供。`;

    try {
      const response = await this.modelLibrary.call([
        { role: 'system', content: '你是一个任务规划专家，擅长根据可用工具制定最优执行计划。' },
        { role: 'user', content: prompt },
      ]);

      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          steps: (parsed.steps || [{ id: 1, description: '直接处理', expectedOutcome: '完成任务' }]).map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (s: any) => ({
              id: s.id,
              description: s.description,
              ...(s.tool && s.tool !== 'null' ? { tool: s.tool } : {}),
              ...(s.params && s.tool && s.tool !== 'null' ? { params: s.params } : {}),
              expectedOutcome: s.expectedOutcome,
              ...(s.rollbackAction ? { rollbackAction: s.rollbackAction } : {}),
            })
          ),
          estimatedComplexity: parsed.estimatedComplexity || 'medium',
          requiresTools: parsed.requiresTools || [],
          risks: parsed.risks || [],
          fallbackStrategy: parsed.fallbackStrategy || '简化处理',

        };
      }
    } catch {
      // 降级
    }

    // 本地降级计划
    return {
      steps: [{ id: 1, description: '直接处理用户请求', expectedOutcome: '获得回答' }],
      estimatedComplexity: 'low',
      requiresTools: [],
      risks: [],
      fallbackStrategy: '简化回答',
    };
  }

  /**
   * 按计划执行
   */
  private async executeWithPlan(
    understanding: TaskUnderstanding,
    plan: ExecutionPlan,
    correction?: string,
    context?: string[],
  ): Promise<string> {
    const systemPrompt = this.buildThinkSystemPrompt();
    const correctionNote = correction
      ? `\n\n⚠️ 自我修正提示: ${correction}`
      : '';

    const contextNote = context && context.length > 0
      ? `\n\n对话上下文:\n${context.slice(-5).join('\n')}`
      : '';

    // 逐步执行计划，支持工具调用
    const stepResults: Array<{ step: string; result: string; usedTool: string }> = [];

    for (const step of plan.steps) {
      // 尝试使用工具执行
      if (step.tool && this.tools) {
        const tool = this.tools.find(t => t.name === step.tool);
        if (tool) {
          try {
            const toolResult = await tool.execute(step.params || {});
            stepResults.push({ step: step.description, result: toolResult, usedTool: step.tool });
            continue;
          } catch {
            // 工具执行失败，降级为LLM
          }
        }
      }

      // 降级：调用LLM
      const llmResult = await this.callLLM(step, understanding, stepResults, correctionNote, contextNote, systemPrompt);
      stepResults.push({ step: step.description, result: llmResult, usedTool: 'llm' });
    }

    // 汇总所有步骤结果，生成最终回答
    const stepsSummary = stepResults
      .map((r, i) => `步骤${i + 1} [${r.usedTool}]: ${r.step}\n结果: ${r.result}`)
      .join('\n\n');

    const finalPrompt = `${understanding.originalInput}

任务理解:
- 深层意图: ${understanding.deepIntent}
- 隐含需求: ${understanding.implicitNeeds.join(', ')}
- 成功标准: ${understanding.successCriteria.join(', ')}

执行步骤结果:
${stepsSummary}
${correctionNote}${contextNote}

请基于以上执行结果，综合给出高质量的最终回答。`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: finalPrompt },
    ]);

    return response.content;
  }

  /**
   * 调用LLM执行单个步骤
   */
  private async callLLM(
    step: PlanStep,
    understanding: TaskUnderstanding,
    previousResults: Array<{ step: string; result: string; usedTool: string }>,
    correctionNote: string,
    contextNote: string,
    systemPrompt: string,
  ): Promise<string> {
    const previousContext = previousResults.length > 0
      ? `\n\n前序步骤结果:\n${previousResults.map((r, i) => `步骤${i + 1}: ${r.step}\n结果: ${r.result}`).join('\n')}`
      : '';

    const prompt = `执行以下步骤：

任务: ${understanding.originalInput}
当前步骤: ${step.description}
预期结果: ${step.expectedOutcome}
${previousContext}${correctionNote}${contextNote}

请执行该步骤并给出结果：`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ]);

    return response.content;
  }

  /**
   * 验证结果 - 自我检查
   */
  private async verifyResult(
    input: string,
    result: string,
    understanding: TaskUnderstanding,
  ): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const issues: string[] = [];
    const suggestions: string[] = [];

    // 1. 基础检查（本地，不依赖LLM）
    const basicChecks = this.basicVerify(input, result, understanding);
    checks.push(...basicChecks.checks);
    issues.push(...basicChecks.issues);

    // 2. 深度检查（使用LLM）
    if (result.length > 50) {
      try {
        const deepChecks = await this.deepVerify(input, result, understanding);
        checks.push(...deepChecks.checks);
        issues.push(...deepChecks.issues);
        suggestions.push(...deepChecks.suggestions);
      } catch {
        // 深度检查失败不影响结果
      }
    }

    const overallQuality = this.calculateOverallQuality(checks);
    const passed = overallQuality >= this.minConfidence &&
      !checks.some(c => c.severity === 'critical' && !c.passed);

    return { passed, checks, issues, suggestions, overallQuality };
  }

  /**
   * 基础验证（本地快速检查）
   */
  private basicVerify(
    input: string,
    result: string,
    understanding: TaskUnderstanding,
  ): { checks: VerificationCheck[]; issues: string[] } {
    const checks: VerificationCheck[] = [];
    const issues: string[] = [];

    // 空响应检查
    checks.push({
      name: '响应非空',
      passed: result.length > 0,
      detail: result.length === 0 ? '响应为空' : `响应长度${result.length}字符`,
      severity: 'critical',
    });
    if (result.length === 0) issues.push('响应为空');

    // 最小长度检查
    checks.push({
      name: '响应充分',
      passed: result.length > 20,
      detail: result.length < 20 ? '响应过短，可能不完整' : '响应长度合理',
      severity: 'warning',
    });
    if (result.length < 20) issues.push('响应过短');

    // 相关性检查（简单关键词匹配）
    const inputWords = new Set(input.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const resultLower = result.toLowerCase();
    const matchedWords = [...inputWords].filter(w => resultLower.includes(w));
    const relevanceRatio = inputWords.size > 0 ? matchedWords.length / inputWords.size : 0.5;

    checks.push({
      name: '内容相关性',
      passed: relevanceRatio > 0.2,
      detail: `关键词匹配率${(relevanceRatio * 100).toFixed(0)}%`,
      severity: relevanceRatio < 0.1 ? 'error' : 'warning',
    });
    if (relevanceRatio < 0.1) issues.push('响应可能与问题不相关');

    // 成功标准检查
    for (const criteria of understanding.successCriteria) {
      const criteriaKeywords = criteria.split(/[，,、]/).map(s => s.trim()).filter(s => s.length > 1);
      const met = criteriaKeywords.some(kw => result.includes(kw));
      checks.push({
        name: `标准: ${criteria.substring(0, 20)}`,
        passed: met,
        detail: met ? '已满足' : '未满足',
        severity: 'warning',
      });
    }

    // 错误标记检查
    const errorPatterns = [/错误|失败|无法|sorry|error|failed|cannot/i];
    const hasError = errorPatterns.some(p => p.test(result));
    checks.push({
      name: '无错误标记',
      passed: !hasError,
      detail: hasError ? '响应中包含错误标记' : '无错误标记',
      severity: hasError ? 'warning' : 'info',
    });

    return { checks, issues };
  }

  /**
   * 深度验证（使用LLM）
   */
  private async deepVerify(
    input: string,
    result: string,
    understanding: TaskUnderstanding,
  ): Promise<{ checks: VerificationCheck[]; issues: string[]; suggestions: string[] }> {
    const prompt = `验证以下回答的质量。

问题: ${input}
回答: ${result.substring(0, 2000)}

深层意图: ${understanding.deepIntent}
成功标准: ${understanding.successCriteria.join(', ')}

请用JSON格式返回：
{
  "checks": [
    {"name": "检查名称", "passed": true, "detail": "详情", "severity": "info|warning|error|critical"}
  ],
  "issues": ["问题1"],
  "suggestions": ["建议1"],
  "qualityScore": 0.85
}`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: '你是一个质量验证专家，严格检查回答的准确性、完整性和相关性。' },
      { role: 'user', content: prompt },
    ]);

    try {
      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          checks: parsed.checks || [],
          issues: parsed.issues || [],
          suggestions: parsed.suggestions || [],
        };
      }
    } catch {
      // 解析失败
    }

    return { checks: [], issues: [], suggestions: [] };
  }

  /**
   * 修正结果
   */
  private async correctResult(
    input: string,
    result: string,
    verification: VerificationResult,
    _understanding: TaskUnderstanding,
  ): Promise<string> {
    const prompt = `以下回答存在问题，请提供修正方案。

问题: ${input}
当前回答: ${result.substring(0, 2000)}
发现的问题: ${verification.issues.join('; ')}
改进建议: ${verification.suggestions.join('; ')}

请给出修正方案（描述如何改进，不要直接给出新回答）：`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: '你是一个质量改进专家。' },
      { role: 'user', content: prompt },
    ]);

    return response.content;
  }

  /**
   * 反思总结
   */
  private async reflectOnResult(
    input: string,
    result: string,
    verification: VerificationResult,
    understanding: TaskUnderstanding,
  ): Promise<ReflectionResult> {
    const prompt = `对以下任务执行过程进行反思。

任务: ${input}
结果质量: ${(verification.overallQuality * 100).toFixed(0)}%
通过验证: ${verification.passed}
问题: ${verification.issues.join('; ')}

请用JSON格式返回：
{
  "whatWorked": ["有效的做法1"],
  "whatDidntWork": ["无效的做法1"],
  "lessonsLearned": ["经验教训1"],
  "improvements": ["改进建议1"],
  "similarTasks": ["类似任务模式1"]
}`;

    try {
      const response = await this.modelLibrary.call([
        { role: 'system', content: '你是一个自我反思专家，擅长从经验中学习。' },
        { role: 'user', content: prompt },
      ]);

      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          whatWorked: parsed.whatWorked || [],
          whatDidntWork: parsed.whatDidntWork || [],
          lessonsLearned: parsed.lessonsLearned || [],
          improvements: parsed.improvements || [],
          similarTasks: parsed.similarTasks || [],
        };
      }
    } catch {
      // 降级
    }

    // 本地降级反思
    return {
      whatWorked: verification.passed ? ['结果通过验证'] : [],
      whatDidntWork: verification.issues,
      lessonsLearned: verification.issues.map(i => `避免: ${i}`),
      improvements: verification.suggestions,
      similarTasks: [understanding.surfaceIntent],
    };
  }

  // ========== 辅助方法 ==========

  private calculateOverallQuality(checks: VerificationCheck[]): number {
    if (checks.length === 0) return 0.5;

    let score = 1.0;
    for (const check of checks) {
      if (!check.passed) {
        switch (check.severity) {
          case 'critical': score -= 0.3; break;
          case 'error': score -= 0.2; break;
          case 'warning': score -= 0.1; break;
          case 'info': score -= 0.02; break;
        }
      }
    }
    return Math.max(0, Math.min(1, score));
  }

  private buildThinkSystemPrompt(): string {
    return `你是段先生 - 一个真正能自主思考的智能体。

你的思考方式：
1. 先理解用户真正想要什么（深层意图）
2. 规划最佳方案
3. 执行并给出高质量回答
4. 自我验证回答质量
5. 发现问题自动修正
6. 从每次交互中学习

回答原则：
- 直接回答核心问题
- 提供具体可操作的建议
- 代码要完整可运行
- 分析要有数据支撑
- 用中文回答`;
  }

  private findLearnedPattern(input: string): string | null {
    for (const [intent, pattern] of this.learnedPatterns) {
      if (input.includes(intent) || intent.includes(input.substring(0, 10))) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * 获取思考历史
   */
  getThinkHistory(): ThinkResult[] {
    return [...this.thinkHistory];
  }

  /**
   * 获取学习到的模式
   */
  getLearnedPatterns(): Map<string, string> {
    return new Map(this.learnedPatterns);
  }
}
