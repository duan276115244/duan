/**
 * 压缩任务路由器 — CompressionRouter
 *
 * 优化计划模块2：小模型路由上下文压缩
 * 核心思路：不用昂贵模型（Claude 3.5 Sonnet / GPT-4o）做压缩/摘要，
 * 而是路由到快速、廉价的小模型（GPT-4o-mini / Claude Haiku / DeepSeek Chat）。
 *
 * 能力：
 * 1. 按任务类型自动选择合适的小模型
 * 2. 支持模型覆盖（手动指定）
 * 3. 无可用LLM时退化为规则方法
 * 4. 成本节省追踪
 */

// ============ 类型定义 ============

import { callLLMWithRecovery } from './query-engine-singleton.js';

/** 压缩任务类型 */
export type CompressionTask =
  | 'summarize'        // 摘要
  | 'extract_facts'    // 提取事实
  | 'classify_intent'  // 意图分类
  | 'extract_json'     // 提取JSON
  | 'skill_summary';   // 技能摘要

/** 模型层级 */
export enum ModelTier {
  fast = 'fast',         // 最便宜
  balanced = 'balanced', // 中等
  powerful = 'powerful', // 最强
}

/** 任务→层级映射 */
const TASK_TIER_MAP: Record<CompressionTask, ModelTier> = {
  summarize: ModelTier.fast,
  extract_facts: ModelTier.fast,
  classify_intent: ModelTier.fast,
  extract_json: ModelTier.balanced,
  skill_summary: ModelTier.balanced,
};

/** 模型候选（按优先级排列） */
const TIER_CANDIDATES: Record<ModelTier, Array<{ provider: string; model: string }>> = {
  [ModelTier.fast]: [
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'anthropic', model: 'claude-3-haiku-20240307' },
  ],
  [ModelTier.balanced]: [
    { provider: 'anthropic', model: 'claude-3-haiku-20240307' },
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ],
  [ModelTier.powerful]: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ],
};

/** 成本参数（USD / 1K tokens） */
const MAIN_MODEL_COST_PER_1K = 0.01;
const SMALL_MODEL_COST_PER_1K = 0.0002;

// ============ CompressionRouter ============

export class CompressionRouter {
  /** 可选的模型库引用 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelLibrary: any;
  /** 手动覆盖映射 */
  private overrides: Map<CompressionTask, { provider: string; model: string }> = new Map();
  /** 已路由的总 token 数（估算） */
  private totalTokensRouted = 0;
  /** LLM 调用失败次数（可观测指标，由 callLLM catch 块累加，getLLMFailureCount 读取） */
  private llmFailureCount = 0;
  /** 可用模型缓存（provider→model→是否可用） */
  private availableModels: Map<string, Set<string>> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary;
    this.refreshAvailableModels();
  }

  /** 刷新可用模型列表 */
  private refreshAvailableModels(): void {
    this.availableModels.clear();
    if (!this.modelLibrary) return;

    // 尝试从模型库获取已配置的模型
    try {
      const models = this.modelLibrary.getModels?.() ?? this.modelLibrary.models ?? [];
      for (const m of models) {
        const provider = m.provider ?? '';
        const model = m.model ?? m.id ?? '';
        if (!provider || !model) continue;
        if (!this.availableModels.has(provider)) {
          this.availableModels.set(provider, new Set());
        }
        this.availableModels.get(provider)!.add(model);
      }
    } catch (err) {
      // 模型库不可用，保持空列表，但记录日志便于排查
      console.warn('[SmallModelRouter] 初始化模型列表失败，使用空列表', err);
    }
  }

  /**
   * 执行压缩任务 — 路由到合适的小模型
   * 统一异步流程：优先调用 LLM，失败时记录日志/指标并退化到规则方法
   */
  async compress(
    task: CompressionTask,
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const { provider, model } = this.selectModelForTask(task);
    const maxTokens = options?.maxTokens ?? 512;
    const temperature = options?.temperature ?? 0.3;

    // 估算 token 数（粗略：4字符≈1token）
    const estimatedTokens = Math.ceil(prompt.length / 4) + maxTokens;
    this.totalTokensRouted += estimatedTokens;

    // 如果有模型库且模型可用，走LLM
    if (this.modelLibrary && this.isModelAvailable(provider, model)) {
      try {
        return await this.callLLM(provider, model, prompt, maxTokens, temperature);
      } catch (err) {
        // LLM 调用失败：记录日志/可观测指标，避免静默降级难以排查
        this.llmFailureCount += 1;
        console.warn(
          `[SmallModelRouter] LLM 调用失败 (task=${task}, provider=${provider}, model=${model})，退化到规则方法`,
          err,
        );
      }
    }

    // 退化到规则方法（统一异步返回）
    return this.ruleBasedFallback(task, prompt);
  }

  /**
   * 为任务选择最佳可用模型
   */
  selectModelForTask(task: CompressionTask): { provider: string; model: string } {
    // 优先使用手动覆盖
    const override = this.overrides.get(task);
    if (override) return override;

    const tier = TASK_TIER_MAP[task];
    const candidates = TIER_CANDIDATES[tier];

    // 按优先级查找第一个可用的
    for (const c of candidates) {
      if (this.isModelAvailable(c.provider, c.model)) {
        return c;
      }
    }

    // 无可用模型，返回第一个候选（后续会走规则退化）
    return candidates[0];
  }

  /**
   * 设置任务模型覆盖
   */
  setModelOverride(task: CompressionTask, provider: string, model: string): void {
    this.overrides.set(task, { provider, model });
  }

  /**
   * 获取成本节省统计
   */
  getCostSavings(): { estimatedTokensSaved: number; estimatedCostSaved: number } {
    const mainCost = (this.totalTokensRouted / 1000) * MAIN_MODEL_COST_PER_1K;
    const smallCost = (this.totalTokensRouted / 1000) * SMALL_MODEL_COST_PER_1K;
    return {
      estimatedTokensSaved: this.totalTokensRouted,
      estimatedCostSaved: Math.max(0, mainCost - smallCost),
    };
  }

  /**
   * 获取 LLM 失败次数（可观测指标）
   */
  getLLMFailureCount(): number {
    return this.llmFailureCount;
  }

  // ---- 内部方法 ----

  /** 检查模型是否可用 */
  private isModelAvailable(provider: string, model: string): boolean {
    const models = this.availableModels.get(provider);
    return models != null && models.has(model);
  }

  /** 调用LLM（失败或无可用调用方式时抛出异常，由调用方记录日志并退化） */
  private async callLLM(
    provider: string,
    model: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    // 尝试通过模型库调用
    if (this.modelLibrary?.callModel) {
      const result = await this.modelLibrary.callModel({
        provider,
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      });
      return typeof result === 'string' ? result : result?.content ?? result?.text ?? '';
    }

    // 尝试通过模型库获取客户端直接调用
    if (this.modelLibrary?.getClient) {
      const client = this.modelLibrary.getClient(provider);
      if (client) {
        const resp = await callLLMWithRecovery(
          client,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature,
          },
          {},
          model,
        );
        return resp.choices?.[0]?.message?.content ?? '';
      }
    }

    // 无可用的 LLM 调用方式，抛出错误由调用方处理退化（保持可排查）
    throw new Error(
      `[SmallModelRouter] 无可用的 LLM 调用方式 (provider=${provider}, model=${model})`,
    );
  }

  // ---- 规则退化方法 ----

  /** 规则退化入口 */
  private ruleBasedFallback(task: CompressionTask, text: string): string {
    switch (task) {
      case 'summarize':
        return this.ruleSummarize(text);
      case 'extract_facts':
        return this.ruleExtractFacts(text);
      case 'classify_intent':
        return this.ruleClassifyIntent(text);
      case 'extract_json':
        return this.ruleExtractJson(text);
      case 'skill_summary':
        return this.ruleSkillSummary(text);
      default:
        return text.slice(0, 200);
    }
  }

  /** 摘要：取每段首尾句 */
  private ruleSummarize(text: string): string {
    const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
    const summaries = paragraphs.map(p => {
      const sentences = p.split(/(?<=[。！？.!?])\s*/).filter(s => s.trim());
      if (sentences.length <= 2) return sentences.join(' ');
      return sentences[0] + ' ' + sentences[sentences.length - 1];
    });
    return summaries.join('\n');

  }

  /** 提取事实：正则匹配数字、姓名、日期、决策 */
  private ruleExtractFacts(text: string): string {
    const facts: string[] = [];
    // 数字相关
    const numbers = text.match(/\d+[\d,.]*\s*[%美元元万千百十亿]|[\d,.]+/g);
    if (numbers) facts.push(...numbers.slice(0, 10));
    // 日期
    const dates = text.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/g);
    if (dates) facts.push(...dates);
    // 决策关键词
    const decisions = text.match(/(?:决定|确认|同意|批准|拒绝|取消|采用|选择)[^。！？.!?]*[。！？.!?]/g);
    if (decisions) facts.push(...decisions.slice(0, 5));
    // 人名（简单中文姓名模式）
    const names = text.match(/[\u4e00-\u9fa5]{2,4}(?:说|表示|认为|指出|建议|要求)/g);
    if (names) facts.push(...names.slice(0, 5));

    return facts.length > 0 ? facts.join('\n') : text.slice(0, 300);
  }

  /** 意图分类：关键词匹配 */
  private ruleClassifyIntent(text: string): string {
    const lower = text.toLowerCase();
    const rules: Array<{ keywords: string[]; intent: string }> = [
      { keywords: ['代码', '编程', '函数', 'bug', 'code', 'debug', '实现'], intent: 'coding' },
      { keywords: ['解释', '什么是', '为什么', 'explain', 'what', 'why'], intent: 'explanation' },
      { keywords: ['写', '生成', '创建', 'write', 'generate', 'create'], intent: 'generation' },
      { keywords: ['翻译', 'translate'], intent: 'translation' },
      { keywords: ['总结', '摘要', 'summarize', 'summary'], intent: 'summarization' },
      { keywords: ['分析', '评估', '比较', 'analyze', 'evaluate', 'compare'], intent: 'analysis' },
      { keywords: ['修改', '重构', '优化', 'refactor', 'optimize', 'fix'], intent: 'modification' },
    ];

    for (const rule of rules) {
      if (rule.keywords.some(kw => lower.includes(kw))) {
        return rule.intent;
      }
    }
    return 'general';
  }

  /** 提取JSON：正则从文本中提取 */
  private ruleExtractJson(text: string): string {
    // 尝试匹配完整的JSON对象或数组
    const jsonMatch = text.match(/\{[\s\S]*?\}|\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        // 验证是否为合法JSON
        JSON.parse(jsonMatch[0]);
        return jsonMatch[0];
      } catch {
        // 不是合法JSON，尝试修复
      }
    }
    // 尝试匹配代码块中的JSON
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        JSON.parse(codeBlockMatch[1]);
        return codeBlockMatch[1];
      } catch {
        // 忽略
      }
    }
    return '{}';
  }

  /** 技能摘要：取前200字符 */
  private ruleSkillSummary(text: string): string {
    return text.slice(0, 200).replace(/\n/g, ' ').trim();
  }
}
