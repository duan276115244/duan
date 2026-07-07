/**
 * 本地推理引擎 — LocalInferenceEngine
 *
 * 无 API 时通过经验包 + 本地神经网络直接完成任务，不消耗 token
 *
 * 核心能力：
 * 1. 经验驱动推理 — 匹配历史经验包，直接复用执行路径
 * 2. 本地神经网络 — NN 分类任务类型，预测最优策略
 * 3. 模板生成 — 基于经验模板生成响应（无需 LLM）
 * 4. 离线降级 — API 不可用时自动切换到本地推理
 * 5. 混合模式 — 简单任务本地处理，复杂任务才调 API
 *
 * 工作流程：
 * 新任务 → ① 经验包匹配（score>0.75 直接复用）
 *         → ② NN 分类（是否需要 LLM）
 *         → ③ 模板生成（简单任务）
 *         → ④ 降级到 API（复杂任务）
 *
 * 复用：
 * - experience-pack-system.ts（经验包）
 * - neural-network.ts（本地 NN）
 * - cognitive-engine.ts（认知决策）
 */

import { logger } from './structured-logger.js';
import { NeuralNetwork, type ActivationType } from './neural-network.js';
import type { ExperiencePackSystem, ExperiencePack, ExperienceMatchResult } from './experience-pack-system.js';

// ============ 类型定义 ============

export type InferenceMode = 'experience_reuse' | 'local_nn' | 'template' | 'api_fallback' | 'hybrid';

export type TaskComplexityLevel = 'trivial' | 'simple' | 'medium' | 'complex' | 'unknown';

export interface LocalInferenceResult {
  /** 推理模式 */
  mode: InferenceMode;
  /** 生成的响应 */
  response: string;
  /** 是否成功 */
  success: boolean;
  /** 置信度（0-1） */
  confidence: number;
  /** 匹配的经验包（如果有） */
  matchedExperience?: ExperiencePack;
  /** 匹配分数 */
  matchScore?: number;
  /** 是否消耗了 token */
  tokenConsumed: number;
  /** 耗时（ms） */
  durationMs: number;
  /** 推理过程说明 */
  reasoning: string;
  /** 建议的执行步骤（如果有） */
  suggestedSteps?: Array<{ description: string; tool?: string }>;
}

export interface ApiAvailability {
  available: boolean;
  reason?: string; // 'rate_limit' | 'network_error' | 'no_key' | 'disabled'
  retryAfterMs?: number;
}

// ============ 本地推理引擎 ============

export class LocalInferenceEngine {
  private experienceSystem: ExperiencePackSystem;
  private taskClassifier: NeuralNetwork;
  private apiAvailable: ApiAvailability = { available: true };
  private modelPath: string;
  private stats: {
    totalInferences: number;
    byMode: Record<InferenceMode, number>;
    tokenSaved: number;
    avgConfidence: number;
  };

  /** 任务类型分类 */
  private readonly taskTypes = [
    'code_generation',    // 代码生成
    'code_explanation',   // 代码解释
    'bug_fixing',         // Bug 修复
    'question_answering', // 问答
    'file_operation',     // 文件操作
    'search',             // 搜索
    'analysis',           // 分析
    'translation',        // 翻译
    'summarization',      // 总结
    'other',              // 其他
  ];

  /** 模板响应库 */
  private readonly responseTemplates: Map<string, (params: Record<string, string>) => string> = new Map();

  constructor(experienceSystem: ExperiencePackSystem, modelPath?: string) {
    this.experienceSystem = experienceSystem;
    this.modelPath = modelPath || './data/local-inference-net.json';
    this.stats = {
      totalInferences: 0,
      byMode: { experience_reuse: 0, local_nn: 0, template: 0, api_fallback: 0, hybrid: 0 },
      tokenSaved: 0,
      avgConfidence: 0,
    };

    // 初始化任务分类神经网络
    // 输入特征：10 维（任务长度、是否含代码、是否含问号、是否含"修复"、是否含"创建"...）
    // 输出：10 种任务类型
    this.taskClassifier = new NeuralNetwork({
      inputSize: 10,
      layers: [
        { size: 16, activation: 'relu' as ActivationType },
        { size: 12, activation: 'relu' as ActivationType },
        { size: 10, activation: 'softmax' as ActivationType },
      ],
      learningRate: 0.01,
      modelPath: this.modelPath,
    });

    this.initTemplates();
    this.loadModel();
  }

  // ========== 核心推理接口 ==========

  /**
   * 本地推理主入口
   * 优先级：经验复用 > 本地 NN > 模板生成 > API 降级
   */
  infer(task: string, context?: {
    conversationHistory?: Array<{ role: string; content: string }>;
    availableTools?: string[];
    forceLocal?: boolean; // 强制本地推理（不调 API）
  }): Promise<LocalInferenceResult> {
    const _startTime = Date.now();
    this.stats.totalInferences++;

    // ① 经验包匹配（最高优先级，零 token 消耗）
    const experienceMatch = this.experienceSystem.match(task, 3);
    if (experienceMatch.length > 0 && experienceMatch[0].canReuseDirectly) {
      const result = this.reuseExperience(experienceMatch[0], task);
      this.updateStats(result);
      logger.info('本地推理：经验复用', {
        module: 'LocalInferenceEngine',
        experienceId: result.matchedExperience?.id,
        score: result.matchScore,
        tokenSaved: result.tokenConsumed === 0,
      });
      return Promise.resolve(result);
    }

    // ② 任务分类（NN）
    const taskType = this.classifyTask(task);
    const complexity = this.assessComplexity(task, context);

    // ③ 简单任务：模板生成（零 token 消耗）
    if (complexity === 'trivial' || complexity === 'simple') {
      const templateResult = this.generateFromTemplate(task, taskType, experienceMatch);
      if (templateResult.success) {
        this.updateStats(templateResult);
        logger.info('本地推理：模板生成', {
          module: 'LocalInferenceEngine',
          taskType,
          complexity,
        });
        return Promise.resolve(templateResult);
      }
    }

    // ④ 中等任务：经验辅助 + 本地推理（混合模式）
    if (complexity === 'medium' && experienceMatch.length > 0) {
      const hybridResult = this.hybridInference(task, taskType, experienceMatch, context);
      this.updateStats(hybridResult);
      logger.info('本地推理：混合模式', {
        module: 'LocalInferenceEngine',
        taskType,
        experienceMatches: experienceMatch.length,
      });
      return Promise.resolve(hybridResult);
    }

    // ⑤ 复杂任务或本地推理失败：降级到 API
    if (context?.forceLocal) {
      // 强制本地模式，返回最佳努力结果
      const fallbackResult = this.localFallback(task, taskType, experienceMatch);
      this.updateStats(fallbackResult);
      return Promise.resolve(fallbackResult);
    }

    const apiResult = this.apiFallback(task, taskType, complexity, experienceMatch);
    this.updateStats(apiResult);
    return Promise.resolve(apiResult);
  }

  /**
   * 设置 API 可用性（API 不可用时自动切换到本地推理）
   */
  setApiAvailability(availability: ApiAvailability): void {
    this.apiAvailable = availability;
    logger.info('API 可用性变更', {
      module: 'LocalInferenceEngine',
      available: availability.available,
      reason: availability.reason,
    });
  }

  /**
   * 检查是否应该使用本地推理
   */
  shouldUseLocalInference(task: string): { useLocal: boolean; reason: string } {
    // API 不可用
    if (!this.apiAvailable.available) {
      return { useLocal: true, reason: `API 不可用: ${this.apiAvailable.reason}` };
    }

    // 检查是否有高匹配经验
    const matches = this.experienceSystem.match(task, 1);
    if (matches.length > 0 && matches[0].canReuseDirectly) {
      return { useLocal: true, reason: `命中高匹配经验（score=${matches[0].score.toFixed(2)}）` };
    }

    // 简单任务用本地
    const complexity = this.assessComplexity(task);
    if (complexity === 'trivial' || complexity === 'simple') {
      return { useLocal: true, reason: `简单任务（${complexity}），本地处理` };
    }

    return { useLocal: false, reason: '需要 LLM 推理' };
  }

  // ========== 推理策略实现 ==========

  /** 策略①：经验复用 */
  private reuseExperience(match: ExperienceMatchResult, _task: string): LocalInferenceResult {
    const exp = match.experience;
    const startTime = Date.now();

    // 基于经验包生成响应
    const stepsText = exp.steps.map(s =>
      `${s.order}. ${s.description}${s.tool ? ` [工具: ${s.tool}]` : ''} → ${s.expectedOutcome}`,
    ).join('\n');


    const lessonsText = exp.lessons
      .filter(l => l.type === 'success_factor' || l.type === 'precondition')
      .map(l => `• ${l.content}`)
      .join('\n');

    const response = [
      `根据历史经验完成此任务（经验包: ${exp.name}）`,
      '',
      '执行步骤:',
      stepsText,
      '',
      lessonsText ? `注意事项:\n${lessonsText}` : '',
      '',
      `预期结果: ${exp.expectedOutcome}`,
    ].filter(Boolean).join('\n');

    return {
      mode: 'experience_reuse',
      response,
      success: true,
      confidence: match.score,
      matchedExperience: exp,
      matchScore: match.score,
      tokenConsumed: 0, // 零 token
      durationMs: Date.now() - startTime,
      reasoning: `匹配到历史经验包 "${exp.name}"（相似度=${(match.score * 100).toFixed(0)}%），直接复用执行路径`,
      suggestedSteps: exp.steps.map(s => ({ description: s.description, tool: s.tool })),
    };
  }

  /** 策略③：模板生成 */
  private generateFromTemplate(
    task: string,
    taskType: string,
    experienceMatches: ExperienceMatchResult[],
  ): LocalInferenceResult {
    const startTime = Date.now();
    const templateFn = this.responseTemplates.get(taskType);

    if (!templateFn) {
      return {
        mode: 'template',
        response: '',
        success: false,
        confidence: 0,
        tokenConsumed: 0,
        durationMs: Date.now() - startTime,
        reasoning: `无 "${taskType}" 类型的模板`,
      };
    }

    // 提取参数
    const params = this.extractTemplateParams(task);

    // 如果有经验匹配，注入经验教训
    if (experienceMatches.length > 0) {
      const exp = experienceMatches[0].experience;
      params.experience_lessons = exp.lessons
        .filter(l => l.type === 'success_factor')
        .map(l => l.content)
        .join('; ');
    }

    const response = templateFn(params);

    return {
      mode: 'template',
      response,
      success: true,
      confidence: 0.7,
      tokenConsumed: 0,
      durationMs: Date.now() - startTime,
      reasoning: `使用 "${taskType}" 模板生成响应`,
    };
  }

  /** 策略④：混合推理（经验辅助 + 本地推理） */
  private hybridInference(
    task: string,
    taskType: string,
    experienceMatches: ExperienceMatchResult[],
    _context?: { conversationHistory?: Array<{ role: string; content: string }> },
  ): LocalInferenceResult {
    const startTime = Date.now();

    // 获取最佳经验
    const bestExp = experienceMatches[0]?.experience;

    // 基于经验构建增强响应
    const parts: string[] = [];

    parts.push(`基于历史经验的推理（任务类型: ${taskType}）`);
    parts.push('');

    if (bestExp) {
      parts.push('相关经验参考:');
      parts.push(`  经验: ${bestExp.name}（相似度=${(experienceMatches[0].score * 100).toFixed(0)}%）`);
      parts.push(`  成功路径:`);
      for (const step of bestExp.steps.slice(0, 5)) {
        parts.push(`    ${step.order}. ${step.description}${step.tool ? ` [${step.tool}]` : ''}`);
      }
      parts.push('');

      // 注入经验教训
      const lessons = bestExp.lessons.filter(l => l.confidence > 0.5);
      if (lessons.length > 0) {
        parts.push('经验教训:');
        for (const lesson of lessons.slice(0, 3)) {
          parts.push(`  • ${lesson.content}`);
        }
        parts.push('');
      }
    }

    // 基于任务类型生成建议
    parts.push('建议执行方案:');
    const suggestions = this.generateSuggestions(task, taskType, bestExp);
    for (const s of suggestions) {
      parts.push(`  ${s.order}. ${s.description}${s.tool ? ` [工具: ${s.tool}]` : ''}`);
    }

    return {
      mode: 'hybrid',
      response: parts.join('\n'),
      success: true,
      confidence: bestExp ? 0.65 + experienceMatches[0].score * 0.2 : 0.5,
      matchedExperience: bestExp,
      matchScore: experienceMatches[0]?.score,
      tokenConsumed: 0,
      durationMs: Date.now() - startTime,
      reasoning: `混合推理：结合经验包 "${bestExp?.name || '无'}" 和本地推理`,
      suggestedSteps: suggestions,
    };
  }

  /** 策略⑤a：本地降级（强制本地模式） */
  private localFallback(
    task: string,
    taskType: string,
    experienceMatches: ExperienceMatchResult[],
  ): LocalInferenceResult {
    const startTime = Date.now();

    // 尽最大努力用本地资源回答
    const bestExp = experienceMatches[0]?.experience;
    const parts: string[] = [];

    parts.push('[离线模式] API 不可用，使用本地推理');
    parts.push('');

    if (bestExp) {
      parts.push('找到相关历史经验，建议参考执行:');
      parts.push(`经验: ${bestExp.name}`);
      for (const step of bestExp.steps) {
        parts.push(`  ${step.order}. ${step.description}`);
      }
    } else {
      parts.push('未找到匹配经验，建议:');
      parts.push(`  1. 任务类型: ${taskType}`);
      parts.push('  2. 请稍后重试或简化任务描述');
    }

    return {
      mode: 'local_nn',
      response: parts.join('\n'),
      success: bestExp ? true : false,
      confidence: bestExp ? 0.5 : 0.2,
      matchedExperience: bestExp,
      matchScore: experienceMatches[0]?.score,
      tokenConsumed: 0,
      durationMs: Date.now() - startTime,
      reasoning: 'API 不可用，降级到本地推理',
      suggestedSteps: bestExp?.steps.map(s => ({ description: s.description, tool: s.tool })),
    };
  }

  /** 策略⑤b：API 降级 */
  private apiFallback(
    task: string,
    taskType: string,
    complexity: TaskComplexityLevel,
    experienceMatches: ExperienceMatchResult[],
  ): LocalInferenceResult {
    const startTime = Date.now();

    // 构建给 API 的增强提示（注入经验上下文）
    let _enhancedPrompt = task;
    if (experienceMatches.length > 0) {
      const exp = experienceMatches[0].experience;
      _enhancedPrompt += `\n\n[历史经验参考]\n${exp.lessons.filter(l => l.type === 'success_factor').map(l => l.content).join('\n')}`;
    }

    return {
      mode: 'api_fallback',
      response: '', // 实际响应由 API 生成
      success: true,
      confidence: 0.9,
      matchedExperience: experienceMatches[0]?.experience,
      matchScore: experienceMatches[0]?.score,
      tokenConsumed: 0, // 由调用方填充实际 token
      durationMs: Date.now() - startTime,
      reasoning: `复杂任务（${complexity}），降级到 API 推理${experienceMatches.length > 0 ? '（已注入经验上下文）' : ''}`,
      suggestedSteps: experienceMatches[0]?.experience.steps.map(s => ({ description: s.description, tool: s.tool })),
    };
  }

  // ========== 神经网络任务分类 ==========

  /** 提取任务特征向量 */
  private extractTaskFeatures(task: string): number[] {
    const features: number[] = [];

    // 1. 任务长度（归一化）
    features.push(Math.min(task.length / 200, 1));

    // 2. 是否包含代码
    features.push(/```|function|class|def |const |var |import /.test(task) ? 1 : 0);

    // 3. 是否包含问号（问答类）
    features.push(task.includes('?') || task.includes('？') ? 1 : 0);

    // 4. 是否包含"修复"/"fix"（Bug 修复类）
    features.push(/修复|fix|bug|错误|error/i.test(task) ? 1 : 0);

    // 5. 是否包含"创建"/"生成"（生成类）
    features.push(/创建|生成|写|create|generate|write/i.test(task) ? 1 : 0);

    // 6. 是否包含"搜索"/"查找"（搜索类）
    features.push(/搜索|查找|find|search/i.test(task) ? 1 : 0);

    // 7. 是否包含"分析"（分析类）
    features.push(/分析|统计|analyze|statistics/i.test(task) ? 1 : 0);

    // 8. 是否包含"翻译"（翻译类）
    features.push(/翻译|translate/i.test(task) ? 1 : 0);

    // 9. 是否包含"总结"/"摘要"（总结类）
    features.push(/总结|摘要|summarize|summary/i.test(task) ? 1 : 0);

    // 10. 是否包含文件操作
    features.push(/文件|file|读取|写入|read|write/i.test(task) ? 1 : 0);

    return features;
  }

  /** 分类任务类型 */
  private classifyTask(task: string): string {
    const features = this.extractTaskFeatures(task);
    const result = this.taskClassifier.predict(features);
    const output = result.output;

    // 找到概率最高的类别
    let maxIdx = 0;
    let maxVal = 0;
    for (let i = 0; i < output.length; i++) {
      if (output[i] > maxVal) {
        maxVal = output[i];
        maxIdx = i;
      }
    }

    return this.taskTypes[maxIdx] || 'other';
  }

  /** 评估任务复杂度 */
  private assessComplexity(task: string, context?: {
    conversationHistory?: Array<{ role: string; content: string }>;
    availableTools?: string[];
  }): TaskComplexityLevel {
    // 简单启发式
    if (task.length < 20) return 'trivial';
    if (task.length < 50 && !task.includes('```') && !task.includes('步骤')) return 'simple';

    // 多步骤任务
    if (/步骤|分步|先.*再|首先.*然后|step/i.test(task)) return 'complex';

    // 需要多工具
    if (context?.availableTools && context.availableTools.length > 3) return 'medium';

    // 包含代码
    if (task.includes('```') || /function|class/.test(task)) return 'medium';

    if (task.length > 200) return 'complex';

    return 'medium';
  }

  // ========== 模板响应库 ==========

  private initTemplates(): void {
    // 代码解释模板
    this.responseTemplates.set('code_explanation', (p) =>
      `代码分析:\n${p.code || p.task || ''}\n\n这段代码的主要功能是${p.function_purpose || '执行特定操作'}。\n关键点:\n• 输入: ${p.input || '未知'}\n• 输出: ${p.output || '未知'}\n• 复杂度: ${p.complexity || 'O(n)'}`);

    // 问答模板
    this.responseTemplates.set('question_answering', (p) =>
      `关于"${p.task || p.question || ''}"的回答:\n${p.experience_lessons ? `根据历史经验: ${p.experience_lessons}\n\n` : ''}这是一个${p.topic || '通用'}问题，建议参考相关文档或经验。`);

    // 文件操作模板
    this.responseTemplates.set('file_operation', (p) =>
      `文件操作建议:\n• 目标: ${p.task || ''}\n• 操作: ${p.operation || '读写'}\n${p.experience_lessons ? `• 经验: ${p.experience_lessons}\n` : ''}请确认文件路径和权限。`);

    // 总结模板
    this.responseTemplates.set('summarization', (p) =>
      `内容摘要:\n${p.task || ''}\n\n核心要点:\n• 主要内容已识别\n${p.experience_lessons ? `• 历史经验: ${p.experience_lessons}\n` : ''}建议进一步确认细节。`);

    // 翻译模板
    this.responseTemplates.set('translation', (p) =>
      `翻译建议:\n原文: ${p.task || ''}\n\n请指定目标语言。${p.experience_lessons ? `\n经验参考: ${p.experience_lessons}` : ''}`);
  }

  /** 提取模板参数 */
  private extractTemplateParams(task: string): Record<string, string> {
    return {
      task,
      question: task,
      code: task.match(/```[\s\S]*?```/)?.[0] || '',
      topic: task.split(/\s+/)[0],
    };
  }

  /** 生成执行建议 */
  private generateSuggestions(
    task: string,
    taskType: string,
    exp?: ExperiencePack,
  ): Array<{ order: number; description: string; tool?: string }> {
    // 如果有经验，基于经验步骤生成
    if (exp && exp.steps.length > 0) {
      return exp.steps.slice(0, 5).map((s, i) => ({
        order: i + 1,
        description: s.description,
        tool: s.tool,
      }));
    }

    // 基于任务类型生成默认建议
    const suggestionsByType: Record<string, Array<{ description: string; tool?: string }>> = {
      code_generation: [
        { description: '分析需求', tool: 'analyze' },
        { description: '生成代码', tool: 'file_write' },
        { description: '验证语法', tool: 'run_command' },
      ],
      bug_fixing: [
        { description: '定位问题', tool: 'search' },
        { description: '分析根因', tool: 'analyze' },
        { description: '修复代码', tool: 'file_edit' },
        { description: '验证修复', tool: 'run_command' },
      ],
      search: [
        { description: '执行搜索', tool: 'web_search' },
        { description: '整理结果', tool: 'analyze' },
      ],
      analysis: [
        { description: '收集数据', tool: 'file_read' },
        { description: '分析数据', tool: 'analyze' },
        { description: '生成报告', tool: 'file_write' },
      ],
    };

    const suggestions = suggestionsByType[taskType] || [
      { description: '分析任务' },
      { description: '执行任务' },
      { description: '验证结果' },
    ];

    return suggestions.map((s, i) => ({ order: i + 1, ...s }));
  }

  // ========== 模型持久化 ==========

  private loadModel(): void {
    try {
      this.taskClassifier.loadModel();
      logger.info('本地推理模型已加载', { module: 'LocalInferenceEngine', path: this.modelPath });
    } catch {
      logger.info('本地推理模型未找到，使用初始权重', { module: 'LocalInferenceEngine' });
    }
  }

  /**
   * 保存模型
   */
  saveModel(): void {
    try {
      this.taskClassifier.saveModel();
      logger.info('本地推理模型已保存', { module: 'LocalInferenceEngine' });
    } catch (err) {
      logger.error('模型保存失败', { module: 'LocalInferenceEngine', error: String(err) });
    }
  }

  /**
   * 在线学习（从任务结果学习）
   */
  learnFromOutcome(task: string, taskType: string, success: boolean): void {
    const features = this.extractTaskFeatures(task);
    const targetIdx = this.taskTypes.indexOf(taskType);
    if (targetIdx < 0) return;

    const target = new Array(this.taskTypes.length).fill(0);
    target[targetIdx] = success ? 1 : 0.1; // 成功强化，失败弱化

    this.taskClassifier.learnOnline(features, target, taskType);
    logger.debug('本地推理模型在线学习', {
      module: 'LocalInferenceEngine',
      taskType,
      success,
    });
  }

  // ========== 统计 ==========

  private updateStats(result: LocalInferenceResult): void {
    this.stats.byMode[result.mode]++;
    if (result.tokenConsumed === 0) {
      this.stats.tokenSaved += 100; // 估算每次节省 100 token
    }
    // 更新平均置信度
    const total = this.stats.totalInferences;
    this.stats.avgConfidence = (this.stats.avgConfidence * (total - 1) + result.confidence) / total;
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * 生成推理报告
   */
  generateReport(): string {
    const lines: string[] = [];
    lines.push('🧠 本地推理引擎报告');
    lines.push('');
    lines.push('━━━ 推理统计 ━━━');
    lines.push(`总推理次数: ${this.stats.totalInferences}`);
    lines.push(`节省 Token: ${this.stats.tokenSaved}`);
    lines.push(`平均置信度: ${(this.stats.avgConfidence * 100).toFixed(0)}%`);
    lines.push('');
    lines.push('━━━ 推理模式分布 ━━━');
    for (const [mode, count] of Object.entries(this.stats.byMode)) {
      const pct = this.stats.totalInferences > 0 ? (count / this.stats.totalInferences * 100).toFixed(0) : 0;
      lines.push(`${mode}: ${count} (${pct}%)`);
    }
    return lines.join('\n');
  }
}
