/**
 * 段先生 - 自然语言理解引擎 (NLU Engine) v3.0
 * 支持多意图识别、语义消歧、指令补全、专业术语识别、情感分析、实体提取、结构化任务输出
 * v3.0：LLM优先+规则降级架构，LLM分析为主，规则引擎作为降级和补充方案
 */

import { ModelLibrary } from './model-library.js';

// ============ 深层意图分析器接口 ============

/**
 * LLM辅助的深层意图分析接口
 * 当基于规则的NLU置信度不足时，可注入外部分析器（如 AutonomousThinker）进行深层理解
 */
export interface DeepIntentAnalyzer {
  analyze(text: string, context?: string[]): Promise<{
    deepIntent: string;
    implicitNeeds: string[];
    confidence: number;
    suggestions: string[];
  }>;
}

// ============ LLM 分析结果接口 ============

/** LLM 意图识别结果 */
interface LLMIntentResult {
  primaryIntent: string;
  secondaryIntents: string[];
  entities: Array<{ type: string; value: string; confidence: number }>;
  sentiment: 'positive' | 'negative' | 'neutral';
  complexity: 'simple' | 'medium' | 'complex';
  confidence: number;
}

/** LLM 实体提取结果 */
interface LLMEntityResult {
  type: string;
  value: string;
  confidence: number;
}

/** LLM 情感分析结果 */
interface LLMSentimentResult {
  polarity: 'positive' | 'negative' | 'neutral';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  emotion: string;
  fineGrainedEmotion: Sentiment['fineGrainedEmotion'];
  nuance?: string; // 细微差别描述：讽刺、犹豫等
  confidence: number;
}

// ============ 接口定义 ============

export interface NLUResult {
  originalText: string;
  intents: Intent[];
  entities: Entity[];
  sentiment: Sentiment;
  ambiguity: Ambiguity[];
  completedText: string;
  structuredTask: StructuredTask;
  confidence: number;
  processingTime: number;
}

export interface Intent {
  name: string;
  confidence: number;
  slots: Record<string, string>;
}

export interface Entity {
  type: string;
  value: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Sentiment {
  polarity: 'positive' | 'negative' | 'neutral';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  emotion: string;
  /** 细粒度情感类别：期待、困惑、好奇、无聊、惊讶等 */
  fineGrainedEmotion?: 'anticipation' | 'confusion' | 'curiosity' | 'boredom' | 'surprise' | 'trust' | 'disgust' | 'pride' | 'shame' | 'none';
}

export interface Ambiguity {
  text: string;
  possibleMeanings: string[];
  resolvedMeaning?: string;
  context?: string;
}

export interface StructuredTask {
  action: string;
  target: string;
  constraints: string[];
  parameters: Record<string, string>;
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  requiredTools: string[];
  suggestedAgent: string;
}

// ============ 内部类型定义 ============

/** 意图规则定义 */
interface IntentRule {
  name: string;
  keywords: string[];
  patterns: RegExp[];
  slots: string[];
  confidence: number;
}

/** 实体规则定义 */
interface EntityRule {
  type: string;
  patterns: RegExp[];
  dictionary?: string[];
  confidence: number;
}

/** 歧义词定义 */
interface AmbiguityWord {
  word: string;
  meanings: string[];
  contextKeywords: Record<string, string>; // 上下文关键词 -> 对应含义
}

/** 指令补全模式 */
interface CompletionPattern {
  pattern: RegExp;
  completion: (match: RegExpMatchArray) => string;
  description: string;
}

/** 专业术语词典条目 */
interface TermEntry {
  term: string;
  domain: string;
  aliases: string[];
  description: string;
}

/** 情感词典条目 */
interface SentimentWord {
  word: string;
  polarity: number;   // -1 到 1
  urgency: number;    // 0 到 1
  emotion: string;
}

// ============ NLU 引擎主类 ============

export class NLUEngine {
  /** 意图识别规则库 */
  private intentRules: IntentRule[] = [];

  /** 实体提取规则库 */
  private entityRules: EntityRule[] = [];

  /** 歧义词库 */
  private ambiguityWords: AmbiguityWord[] = [];

  /** 指令补全模式库 */
  private completionPatterns: CompletionPattern[] = [];

  /** 专业术语词典 */
  private terminologyDict: TermEntry[] = [];

  /** 情感词典 */
  private sentimentDict: SentimentWord[] = [];

  /** 上下文窗口大小 */
  private readonly CONTEXT_WINDOW_SIZE = 5;

  /** 同义词扩展映射表 */
  private synonymMap: Map<string, string[]> = new Map();

  /** 模糊匹配最小相似度阈值 */
  private readonly FUZZY_MATCH_THRESHOLD = 0.7;

  /** 上下文意图历史（用于意图消歧） */
  private intentHistory: string[] = [];

  /** LLM辅助深层意图分析器（可选注入） */
  private deepAnalyzer: DeepIntentAnalyzer | null = null;

  /** 低置信度时自动触发深层分析的阈值 */
  private readonly DEEP_ANALYZE_THRESHOLD = 0.45;

  /** ModelLibrary 实例（LLM调用） */
  private modelLibrary: ModelLibrary | null = null;

  /** ModelLibrary 是否已尝试懒加载 */
  private modelLibraryLazyLoaded = false;

  /** LLM 调用超时时间（毫秒） */
  private readonly LLM_TIMEOUT_MS = 5000;

  constructor(modelLibrary?: ModelLibrary) {
    this.modelLibrary = modelLibrary || null;
    this.initializeIntentRules();
    this.initializeEntityRules();
    this.initializeAmbiguityWords();
    this.initializeCompletionPatterns();
    this.initializeTerminologyDict();
    this.initializeSentimentDict();
    this.initializeSynonymMap();
  }

  /** 注入LLM辅助的深层意图分析器 */
  setDeepAnalyzer(analyzer: DeepIntentAnalyzer): void {
    this.deepAnalyzer = analyzer;
  }

  /** 注入 ModelLibrary 实例 */
  setModelLibrary(lib: ModelLibrary): void {
    this.modelLibrary = lib;
    this.modelLibraryLazyLoaded = true;
  }

  /** 获取 ModelLibrary 实例（懒加载） */
  private getModelLibrary(): ModelLibrary | null {
    if (this.modelLibrary) return this.modelLibrary;
    if (this.modelLibraryLazyLoaded) return null; // 已尝试过懒加载但失败
    this.modelLibraryLazyLoaded = true;
    try {
      // 复用进程级单例，避免独立 clients Map / LRU 缓存造成连接池翻倍
      this.modelLibrary = ModelLibrary.getInstance();
      return this.modelLibrary;
    } catch {
      return null;
    }
  }

  /** 检查 ModelLibrary 是否可用 */
  hasModelLibrary(): boolean {
    return this.getModelLibrary() !== null;
  }

  /** 初始化同义词扩展映射 */
  private initializeSynonymMap(): void {
    this.synonymMap = new Map([
      // 编程相关同义词
      ['写', ['编写', '编码', '实现', '开发', '创建', '生成', '编写代码']],
      ['调试', ['debug', '排查', '修bug', '排错', '定位问题']],
      ['优化', ['改进', '提升', '改善', '加速', '重构', '性能调优']],
      ['部署', ['发布', '上线', 'deploy', '打包上线']],
      ['测试', ['test', '验证', '检验', '跑测试', '单元测试']],
      ['重构', ['refactor', '重写', '改造', '整理代码', '代码优化']],
      ['审查', ['review', '检查', '代码审查', '代码检查', '审阅']],
      // 通用同义词
      ['搜索', ['查找', '搜', '查', '找', '百度', 'google', '检索']],
      ['翻译', ['translate', '译', '转译', '翻成']],
      ['总结', ['摘要', '概括', '归纳', '提炼', '简述']],
      ['分析', ['解析', '研究', '剖析', '评估']],
      ['解释', ['说明', '讲解', '阐述', '什么意思']],
      ['对比', ['比较', '区别', '差异', 'vs', '哪个好']],
      ['学习', ['教程', '入门', '怎么学', '从零开始', '教学']],
      ['配置', ['设置', 'config', '安装', '初始化', 'setup']],
      ['监控', ['告警', '日志', '指标', '仪表盘']],
      ['自动化', ['脚本', '批处理', '定时任务', 'CI/CD', '工作流']],
    ]);
  }

  /**
   * 分析自然语言文本，返回结构化NLU结果
   * v3.0：LLM优先+规则降级架构
   * - 先尝试 LLM 分析（异步，5秒超时）
   * - LLM 失败或超时时降级到规则引擎
   * - 合并两者结果：LLM 结果为主，规则引擎补充
   * @param text 输入文本
   * @param context 上下文消息列表（最近几条对话）
   */
  async analyze(text: string, context?: string[]): Promise<NLUResult> {
    const startTime = Date.now();

    // ---- 规则引擎分析（始终执行，作为降级和补充） ----
    const ruleIntents = this.identifyIntents(text);
    const ruleDisambiguatedIntents = this.disambiguateIntents(ruleIntents, context);
    const ruleEntities = this.extractEntitiesWithFuzzyMatch(text);
    const ruleSentiment = this.analyzeSentiment(text);

    // ---- LLM 分析（异步，5秒超时） ----
    let llmIntentResult: LLMIntentResult | null = null;
    let llmEntities: LLMEntityResult[] | null = null;
    let llmSentiment: LLMSentimentResult | null = null;

    const lib = this.getModelLibrary();
    if (lib) {
      try {
        // 并行发起 LLM 意图识别、实体提取、情感分析
        const [intentRes, entityRes, sentimentRes] = await Promise.all([
          this.withTimeout(this.llmAnalyzeIntent(text, context), this.LLM_TIMEOUT_MS),
          this.withTimeout(this.llmExtractEntities(text), this.LLM_TIMEOUT_MS),
          this.withTimeout(this.llmAnalyzeSentiment(text), this.LLM_TIMEOUT_MS),
        ]);
        llmIntentResult = intentRes;
        llmEntities = entityRes;
        llmSentiment = sentimentRes;
      } catch {
        // LLM 超时或失败，降级到规则引擎
      }
    }

    // ---- 合并结果：LLM 为主，规则引擎补充 ----
    const intents = this.mergeIntents(llmIntentResult, ruleDisambiguatedIntents);
    const entities = this.mergeEntities(llmEntities, ruleEntities, text);
    const sentiment = this.mergeSentiment(llmSentiment, ruleSentiment);

    // 语义消歧
    const ambiguity = this.detectAmbiguity(text, context);

    // 指令补全
    const completedText = this.completeInstruction(text, context);

    // 计算总体置信度
    const confidence = this.calculateOverallConfidence(intents, entities, sentiment);

    // 低置信度时触发LLM辅助深层理解（异步非阻塞）
    if (confidence < this.DEEP_ANALYZE_THRESHOLD && this.deepAnalyzer) {
      this.triggerDeepAnalysis(text, context)
        .then(deepResult => {
          if (deepResult && deepResult.confidence > confidence) {
            this.intentHistory.push(deepResult.deepIntent);
          }
        })
        .catch(() => {});
    }

    // 结构化任务
    const structuredTask = this.structureTask(intents, entities);

    // 记录意图历史
    if (intents.length > 0) {
      this.intentHistory.push(intents[0].name);
      if (this.intentHistory.length > 20) {
        this.intentHistory = this.intentHistory.slice(-20);
      }
    }

    const processingTime = Date.now() - startTime;

    return {
      originalText: text,
      intents,
      entities,
      sentiment,
      ambiguity,
      completedText,
      structuredTask,
      confidence,
      processingTime,
    };
  }

  /**
   * 同步分析接口（兼容旧版，降级到纯规则引擎）
   * @deprecated 推荐使用异步 analyze() 方法以获得 LLM 增强效果
   */
  analyzeSync(text: string, context?: string[]): NLUResult {
    const startTime = Date.now();

    const intents = this.identifyIntents(text);
    const disambiguatedIntents = this.disambiguateIntents(intents, context);
    const entities = this.extractEntitiesWithFuzzyMatch(text);
    const sentiment = this.analyzeSentiment(text);
    const ambiguity = this.detectAmbiguity(text, context);
    const completedText = this.completeInstruction(text, context);
    const confidence = this.calculateOverallConfidence(disambiguatedIntents, entities, sentiment);

    if (confidence < this.DEEP_ANALYZE_THRESHOLD && this.deepAnalyzer) {
      this.triggerDeepAnalysis(text, context)
        .then(deepResult => {
          if (deepResult && deepResult.confidence > confidence) {
            this.intentHistory.push(deepResult.deepIntent);
          }
        })
        .catch(() => {});
    }

    const structuredTask = this.structureTask(disambiguatedIntents, entities);

    if (disambiguatedIntents.length > 0) {
      this.intentHistory.push(disambiguatedIntents[0].name);
      if (this.intentHistory.length > 20) {
        this.intentHistory = this.intentHistory.slice(-20);
      }
    }

    const processingTime = Date.now() - startTime;

    return {
      originalText: text,
      intents: disambiguatedIntents,
      entities,
      sentiment,
      ambiguity,
      completedText,
      structuredTask,
      confidence,
      processingTime,
    };
  }

  // ============ LLM 分析方法 ============

  /**
   * LLM 辅助意图识别
   * 使用 ModelLibrary 调用 LLM，输出结构化 JSON
   */
  private async llmAnalyzeIntent(text: string, context?: string[]): Promise<LLMIntentResult | null> {
    const lib = this.getModelLibrary();
    if (!lib) return null;

    const contextStr = context && context.length > 0
      ? `\n\n对话上下文:\n${context.slice(-3).map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    const systemPrompt = `你是一个自然语言理解专家。分析用户输入，返回JSON格式的意图分析结果。
必须返回以下JSON结构（不要包含其他内容）：
{
  "primaryIntent": "主要意图名称（如code_generation, code_debug, search, query, deploy, execute, chat等）",
  "secondaryIntents": ["次要意图1", "次要意图2"],
  "entities": [{"type": "实体类型（person/location/time/number/filename/language/framework等）", "value": "实体值", "confidence": 0.9}],
  "sentiment": "positive/negative/neutral",
  "complexity": "simple/medium/complex",
  "confidence": 0.9
}`;

    try {
      const response = await lib.call(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `分析以下文本的意图：\n${text}${contextStr}` },
        ],
        { maxTokens: 1024, temperature: 0.2 },
      );

      const parsed = this.parseLLMJSON<LLMIntentResult>(response.content);
      if (parsed && parsed.primaryIntent) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * LLM 实体提取
   * 使用 LLM 提取实体（人名、地名、时间、数量、文件名等）
   */
  private async llmExtractEntities(text: string): Promise<LLMEntityResult[] | null> {
    const lib = this.getModelLibrary();
    if (!lib) return null;

    const systemPrompt = `你是一个命名实体识别专家。从用户输入中提取所有命名实体。
必须返回JSON数组格式（不要包含其他内容）：
[{"type": "实体类型（person/location/time/number/filename/language/framework/url/email/error/command等）", "value": "实体值", "confidence": 0.9}]`;

    try {
      const response = await lib.call(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `提取以下文本中的实体：\n${text}` },
        ],
        { maxTokens: 1024, temperature: 0.1 },
      );

      const parsed = this.parseLLMJSON<LLMEntityResult[]>(response.content);
      if (parsed && Array.isArray(parsed)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * LLM 情感分析
   * 使用 LLM 分析情感（含细微差别：讽刺、犹豫等）
   */
  private async llmAnalyzeSentiment(text: string): Promise<LLMSentimentResult | null> {
    const lib = this.getModelLibrary();
    if (!lib) return null;

    const systemPrompt = `你是一个情感分析专家。分析用户输入的情感，注意识别细微差别（如讽刺、犹豫、委婉等）。
必须返回以下JSON格式（不要包含其他内容）：
{
  "polarity": "positive/negative/neutral",
  "urgency": "low/medium/high/critical",
  "emotion": "主要情绪（如happy/sad/angry/anxious/neutral等）",
  "fineGrainedEmotion": "anticipation/confusion/curiosity/boredom/surprise/trust/disgust/pride/shame/none",
  "nuance": "细微差别描述（如讽刺、犹豫、委婉等，无则为空字符串）",
  "confidence": 0.9
}`;

    try {
      const response = await lib.call(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `分析以下文本的情感：\n${text}` },
        ],
        { maxTokens: 512, temperature: 0.1 },
      );

      const parsed = this.parseLLMJSON<LLMSentimentResult>(response.content);
      if (parsed && parsed.polarity) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ============ 结果合并方法 ============

  /** 合并意图：LLM 为主，规则引擎补充 */
  private mergeIntents(llmResult: LLMIntentResult | null, ruleIntents: Intent[]): Intent[] {
    if (!llmResult) return ruleIntents;

    const merged: Intent[] = [];

    // LLM 主意图
    merged.push({
      name: llmResult.primaryIntent,
      confidence: llmResult.confidence,
      slots: {},
    });

    // LLM 次要意图
    for (const secIntent of llmResult.secondaryIntents || []) {
      if (!merged.some(i => i.name === secIntent)) {
        merged.push({
          name: secIntent,
          confidence: llmResult.confidence * 0.7,
          slots: {},
        });
      }
    }

    // 规则引擎补充：如果规则识别出 LLM 未覆盖的意图，追加
    for (const ruleIntent of ruleIntents) {
      if (!merged.some(i => i.name === ruleIntent.name)) {
        // 降低规则引擎补充意图的置信度
        merged.push({
          ...ruleIntent,
          confidence: ruleIntent.confidence * 0.6,
        });
      } else {
        // 如果 LLM 和规则都识别到同一意图，取较高置信度，并补充规则引擎的槽位
        const existing = merged.find(i => i.name === ruleIntent.name)!;
        existing.confidence = Math.max(existing.confidence, ruleIntent.confidence * 0.8);
        if (Object.keys(ruleIntent.slots).length > 0) {
          Object.assign(existing.slots, ruleIntent.slots);
        }
      }
    }

    // 按置信度降序排列
    merged.sort((a, b) => b.confidence - a.confidence);
    return merged;
  }

  /** 合并实体：LLM 为主，规则引擎补充 */
  private mergeEntities(llmEntities: LLMEntityResult[] | null, ruleEntities: Entity[], text: string): Entity[] {
    if (!llmEntities) return ruleEntities;

    const merged: Entity[] = [];

    // LLM 实体（需要计算 start/end 位置）
    for (const ent of llmEntities) {
      const idx = text.indexOf(ent.value);
      merged.push({
        type: ent.type,
        value: ent.value,
        start: idx >= 0 ? idx : 0,
        end: idx >= 0 ? idx + ent.value.length : ent.value.length,
        confidence: ent.confidence,
      });
    }

    // 规则引擎补充：如果规则识别出 LLM 未覆盖的实体，追加
    const llmValues = new Set(llmEntities.map(e => e.value.toLowerCase()));
    for (const ruleEnt of ruleEntities) {
      if (!llmValues.has(ruleEnt.value.toLowerCase())) {
        merged.push({
          ...ruleEnt,
          confidence: ruleEnt.confidence * 0.7, // 补充实体置信度略低
        });
      }
    }

    // 按起始位置排序并去重
    merged.sort((a, b) => a.start - b.start);
    return this.deduplicateEntities(merged);
  }

  /** 合并情感：LLM 为主，规则引擎补充 */
  private mergeSentiment(llmSentiment: LLMSentimentResult | null, ruleSentiment: Sentiment): Sentiment {
    if (!llmSentiment) return ruleSentiment;

    return {
      polarity: llmSentiment.polarity,
      urgency: llmSentiment.urgency,
      emotion: llmSentiment.emotion,
      fineGrainedEmotion: llmSentiment.fineGrainedEmotion || ruleSentiment.fineGrainedEmotion,
    };
  }

  // ============ LLM 工具方法 ============

  /** 带超时的 Promise 包装 */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`LLM 调用超时 (${ms}ms)`)), ms);
      promise
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  /** 解析 LLM 返回的 JSON（支持 markdown 代码块包裹） */
  private parseLLMJSON<T>(content: string): T | null {
    try {
      // 尝试从 markdown 代码块中提取
      const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (codeBlockMatch) {
        return JSON.parse(codeBlockMatch[1].trim()) as T;
      }
      // 尝试直接解析
      const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1].trim()) as T;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 触发LLM辅助深层理解（异步） */
  private async triggerDeepAnalysis(
    text: string,
    context?: string[]
  ): Promise<{ deepIntent: string; implicitNeeds: string[]; confidence: number } | null> {
    if (!this.deepAnalyzer) return null;
    try {
      const result = await this.deepAnalyzer.analyze(text, context);
      return {
        deepIntent: result.deepIntent,
        implicitNeeds: result.implicitNeeds,
        confidence: result.confidence,
      };
    } catch {
      return null;
    }
  }

  /** 获取深层意图分析器就绪状态 */
  hasDeepAnalyzer(): boolean {
    return this.deepAnalyzer !== null;
  }

  /** 同义词扩展：将文本中的关键词替换为包含同义词的扩展文本 */
  private expandSynonyms(text: string): string {
    let expanded = text;
    for (const [keyword, synonyms] of this.synonymMap) {
      // 如果文本中包含某个同义词，将主关键词也追加到扩展文本中
      for (const syn of synonyms) {
        if (text.toLowerCase().includes(syn.toLowerCase()) && !text.includes(keyword)) {
          expanded += ' ' + keyword;
          break;
        }
      }
    }
    return expanded;
  }

  /** 意图消歧：当多个意图置信度接近时，根据上下文历史选择最相关的 */
  private disambiguateIntents(intents: Intent[], context?: string[]): Intent[] {
    if (intents.length <= 1) return intents;

    // 找出置信度接近的意图组（差距小于0.15）
    const sorted = [...intents].sort((a, b) => b.confidence - a.confidence);
    const topConfidence = sorted[0].confidence;
    const closeIntents = sorted.filter(i => topConfidence - i.confidence < 0.15);

    if (closeIntents.length <= 1) return intents;

    // 对置信度接近的意图进行消歧
    if (this.intentHistory.length > 0 || (context && context.length > 0)) {
      const recentIntents = this.intentHistory.slice(-5);
      const contextText = (context || []).slice(-3).join(' ').toLowerCase();

      // 通用意图列表（当存在更具体的意图时应被惩罚）
      const genericIntents = ['search', 'query', 'chat', 'execute', 'express'];

      for (const intent of closeIntents) {
        // 奖励：该意图在最近历史中出现过
        if (recentIntents.includes(intent.name)) {
          intent.confidence += 0.08;
        }
        // 奖励：上下文中包含该意图相关的关键词
        const relatedKeywords = this.getIntentRelatedKeywords(intent.name);
        if (relatedKeywords.some(kw => contextText.includes(kw))) {
          intent.confidence += 0.05;
        }
      }

      // 惩罚：当存在更具体的意图时，降低通用意图置信度
      const hasSpecificIntent = closeIntents.some(i => !genericIntents.includes(i.name));
      if (hasSpecificIntent) {
        for (const intent of closeIntents) {
          if (genericIntents.includes(intent.name)) {
            intent.confidence -= 0.08;
          }
        }
      }
    }

    // 重新排序
    sorted.sort((a, b) => b.confidence - a.confidence);
    return sorted;
  }

  /** 获取意图相关的关键词（用于消歧） */
  private getIntentRelatedKeywords(intentName: string): string[] {
    const keywordMap: Record<string, string[]> = {
      'code_generation': ['代码', '写', '开发', '实现', '编程'],
      'code_review': ['审查', '检查', 'review', '质量'],
      'code_debug': ['bug', '错误', '报错', '调试', 'debug'],
      'code_refactor': ['重构', '优化', '改进', '整理'],
      'code_explain': ['解释', '说明', '理解', '什么意思'],
      'code_test': ['测试', 'test', '单元测试'],
      'search': ['搜索', '查找', '搜', '找'],
      'query': ['怎么', '如何', '为什么', '什么'],
      'deploy': ['部署', '发布', '上线'],
      'execute': ['运行', '执行', '启动'],
      'self_evolution': ['进化', '自进化', '自我改进', 'evolve'],
      'self_learning': ['学习', '技能', '知识', '学习记录'],
      'sub_agent': ['子Agent', '并行', '多Agent', 'spawn'],
      'system_diagnose': ['诊断', '性能', 'benchmark', '系统状态'],
      'task_planning': ['规划', '计划', '步骤', '工作流'],
      'self_heal': ['修复', '自愈', '恢复', '健康'],
      'personalization': ['个性化', '偏好', '配置', '设置'],
      'memory_query': ['记忆', '历史', '之前', '还记得'],
      'model_management': ['模型', 'API', 'Key', '切换'],
      'consciousness': ['意识', '情绪', '心跳', '认知'],
      'goal_management': ['目标', '进度', '里程碑'],
      'creativity_tools': ['流程图', '视频', '分镜', '创意'],
    };
    return keywordMap[intentName] || [];
  }

  /** 实体提取（带模糊匹配容错） */
  private extractEntitiesWithFuzzyMatch(text: string): Entity[] {
    // 先用标准方法提取
    const entities = this.extractEntities(text);

    // 对未匹配到的高价值实体类型，尝试模糊匹配
    const fuzzyEntities = this.fuzzyMatchEntities(text, entities);
    const allEntities = [...entities, ...fuzzyEntities];

    // 去重
    return this.deduplicateEntities(allEntities);
  }

  /** 模糊匹配实体：允许部分匹配和编辑距离容错 */
  private fuzzyMatchEntities(text: string, existingEntities: Entity[]): Entity[] {
    const fuzzyResults: Entity[] = [];
    const existingValues = new Set(existingEntities.map(e => e.value.toLowerCase()));

    // 对词典类型的实体规则进行模糊匹配
    for (const rule of this.entityRules) {
      if (!rule.dictionary || rule.dictionary.length === 0) continue;

      for (const entry of rule.dictionary) {
        // 跳过已精确匹配的
        if (existingValues.has(entry.toLowerCase())) continue;

        // 模糊匹配：检查文本中是否有与词典条目相似的子串
        const similarity = this.computeFuzzySimilarity(text, entry);
        if (similarity >= this.FUZZY_MATCH_THRESHOLD) {
          // 找到文本中最可能对应的位置
          const matchPos = this.findBestMatchPosition(text, entry);
          if (matchPos >= 0) {
            fuzzyResults.push({
              type: rule.type,
              value: entry,
              start: matchPos,
              end: matchPos + entry.length,
              confidence: rule.confidence * similarity * 0.85, // 模糊匹配置信度略低
            });
          }
        }
      }
    }

    return fuzzyResults;
  }

  /** 计算模糊相似度（基于编辑距离） */
  private computeFuzzySimilarity(text: string, target: string): number {
    const textLower = text.toLowerCase();
    const targetLower = target.toLowerCase();

    // 如果完全包含，相似度为1
    if (textLower.includes(targetLower)) return 1.0;

    // 检查目标是否为文本中某个子串的模糊匹配
    const targetLen = targetLower.length;
    const maxLen = Math.max(textLower.length - targetLen + 1, 0);

    let bestSimilarity = 0;
    for (let i = 0; i <= maxLen; i++) {
      const substring = textLower.substring(i, i + targetLen);
      const sim = this.levenshteinSimilarity(substring, targetLower);
      bestSimilarity = Math.max(bestSimilarity, sim);
      // 提前退出：已找到足够好的匹配
      if (bestSimilarity >= 0.9) break;
    }

    return bestSimilarity;
  }

  /** Levenshtein相似度 */
  private levenshteinSimilarity(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const maxLen = Math.max(len1, len2);
    if (maxLen === 0) return 1.0;

    const dist = this.levenshteinDistance(s1, s2);
    return 1 - dist / maxLen;
  }

  /** Levenshtein编辑距离 */
  private levenshteinDistance(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const dp: number[][] = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));

    for (let i = 0; i <= len1; i++) dp[i][0] = i;
    for (let j = 0; j <= len2; j++) dp[0][j] = j;

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // 删除
          dp[i][j - 1] + 1,      // 插入
          dp[i - 1][j - 1] + cost // 替换
        );
      }
    }

    return dp[len1][len2];
  }

  /** 在文本中找到与目标最匹配的位置 */
  private findBestMatchPosition(text: string, target: string): number {
    const textLower = text.toLowerCase();
    const targetLower = target.toLowerCase();
    const targetLen = target.length;

    let bestPos = -1;
    let bestSim = 0;

    for (let i = 0; i <= textLower.length - targetLen; i++) {
      const substring = textLower.substring(i, i + targetLen);
      const sim = this.levenshteinSimilarity(substring, targetLower);
      if (sim > bestSim) {
        bestSim = sim;
        bestPos = i;
      }
    }

    return bestSim >= this.FUZZY_MATCH_THRESHOLD ? bestPos : -1;
  }

  // ============ 意图识别 ============

  /**
   * 识别文本中的意图（支持多意图）
   * 使用关键词匹配 + 正则模式匹配 + 启发式规则
   * 重要：同义词展开文本仅用于关键词评分，不用于模式匹配
   */
  private identifyIntents(text: string): Intent[] {
    const intents: Intent[] = [];
    const normalizedText = text.toLowerCase().trim();
    const expandedText = this.expandSynonyms(text).toLowerCase().trim();

    for (const rule of this.intentRules) {
      const result = this.matchIntentRule(normalizedText, expandedText, rule);
      if (result) {
        intents.push(result);
      }
    }

    // 如果没有匹配到任何意图，尝试用启发式规则推断
    if (intents.length === 0) {
      const fallbackIntent = this.inferFallbackIntent(normalizedText);
      if (fallbackIntent) {
        intents.push(fallbackIntent);
      }
    }

    // 按置信度降序排列
    intents.sort((a, b) => b.confidence - a.confidence);

    return intents;
  }

  /** 匹配单条意图规则 */
  private matchIntentRule(origText: string, expandedText: string, rule: IntentRule): Intent | null {
    let keywordScore = 0;
    let patternMatched = false;
    const slots: Record<string, string> = {};

    // 关键词匹配评分（使用同义词展开文本，提高召回率）
    for (const keyword of rule.keywords) {
      if (expandedText.includes(keyword.toLowerCase())) {
        keywordScore++;
      }
    }

    // 正则模式匹配（使用原始文本，避免同义词展开引入的假阳性）
    for (const pattern of rule.patterns) {
      const match = origText.match(pattern);
      if (match) {
        patternMatched = true;
        // 提取槽位值
        if (match.groups) {
          for (const [key, value] of Object.entries(match.groups)) {
            if (value) {
              slots[key] = value;
            }
          }
        }
      }
    }

    // 计算置信度：关键词命中率和模式匹配的综合
    const keywordRatio = rule.keywords.length > 0 ? keywordScore / rule.keywords.length : 0;
    let confidence = 0;

    if (patternMatched) {
      // 模式匹配命中，置信度较高
      confidence = Math.min(rule.confidence + keywordRatio * 0.1, 1.0);
    } else if (keywordScore > 0) {
      // 仅关键词命中，置信度取决于关键词覆盖率
      confidence = rule.confidence * keywordRatio * 0.8;
    }

    // 置信度过低则忽略
    if (confidence < 0.2) {
      return null;
    }

    // 补充槽位：从文本中提取与槽位名相关的值
    for (const slotName of rule.slots) {
      if (!slots[slotName]) {
        const slotValue = this.extractSlotFromText(expandedText, slotName);
        if (slotValue) {
          slots[slotName] = slotValue;
        }
      }
    }

    return {
      name: rule.name,
      confidence: Math.round(confidence * 100) / 100,
      slots,
    };
  }

  /** 从文本中启发式提取槽位值 */
  private extractSlotFromText(text: string, slotName: string): string | undefined {
    const slotPatterns: Record<string, RegExp[]> = {
      language: [
        /(?:用|使用|基于)\s*(?<value>python|java|javascript|typescript|c\+\+|c#|go|rust|ruby|php|swift|kotlin|scala|r|matlab|html|css|sql)/,
        /(?<value>python|java|javascript|typescript|c\+\+|c#|go|rust|ruby|php|swift|kotlin)\s*(?:代码|程序|项目|开发)/,
      ],
      filename: [
        /(?:文件|文件名|叫|保存为|命名为)\s*(?<value>[\w\-.]+\.\w+)/,
        /(?<value>[\w-]+\.(?:ts|js|py|java|go|rs|cpp|c|h|rb|php|html|css|json|xml|yaml|yml|md|txt|csv|sql))/,
      ],
      target: [
        /(?:给|为|帮)\s*(?<value>.+?)(?:写|做|创建|生成|开发)/,
        /(?:写|创建|生成|开发)\s*(?:一个|一款)?(?<value>.+?)(?:的|应用|程序|系统|工具|$)/,
      ],
      count: [
        /(?<value>\d+)\s*(?:个|条|项|次|份|篇|行)/,
      ],
      time: [
        /(?<value>今天|明天|后天|昨天|前天|现在|马上|立刻|尽快|等下|稍后)/,
      ],
      path: [
        /(?:路径|目录|文件夹|位置)\s*(?:是|为|在)?\s*(?<value>[\w\\/.\-:]+)/,
        /(?<value>(?:[a-zA-Z]:)?[\\/][\w\\/.-]*)/,
      ],
      action: [
        /(?<value>进化|学习|诊断|规划|修复|配置|查询|升级|分析|优化|调试|部署|测试|重构)/,
      ],
      priority: [
        /(?<value>高|中|低|紧急|普通)/,
      ],
      module: [
        /(?:模块|组件|系统)\s*(?<value>\w+)/,
      ],
    };

    const patterns = slotPatterns[slotName];
    if (!patterns) return undefined;

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.groups?.value) {
        return match.groups.value;
      }
    }

    return undefined;
  }

  /** 启发式推断兜底意图 */
  private inferFallbackIntent(text: string): Intent | null {
    // 疑问句 -> 查询意图
    if (/[？?]/.test(text) || /^(怎么|如何|为什么|什么|哪|是否|能不能|可以)/.test(text)) {
      return { name: 'query', confidence: 0.5, slots: {} };
    }
    // 感叹句 -> 表达意图
    if (/[！!]$/.test(text)) {
      return { name: 'express', confidence: 0.4, slots: {} };
    }
    // 包含动词 -> 执行意图
    if (/(写|做|创建|删除|修改|运行|启动|停止|查看|打开|关闭|发送|下载|上传|安装|部署)/.test(text)) {
      return { name: 'execute', confidence: 0.45, slots: {} };
    }
    // 默认：对话意图
    return { name: 'chat', confidence: 0.3, slots: {} };
  }

  // ============ 实体提取 ============

  /**
   * 从文本中提取命名实体
   * 使用正则表达式 + 词典匹配
   */
  private extractEntities(text: string): Entity[] {
    const entities: Entity[] = [];

    for (const rule of this.entityRules) {
      // 正则模式提取
      for (const pattern of rule.patterns) {
        let match: RegExpExecArray | null;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(text)) !== null) {
          const value = match[1] || match[0];
          entities.push({
            type: rule.type,
            value,
            start: match.index,
            end: match.index + value.length,
            confidence: rule.confidence,
          });
        }
      }

      // 词典匹配提取
      if (rule.dictionary) {
        for (const entry of rule.dictionary) {
          let searchIndex = 0;
          while (true) {
            const idx = text.indexOf(entry, searchIndex);
            if (idx === -1) break;
            // 避免重复添加（检查是否已被正则匹配覆盖）
            const isDuplicate = entities.some(
              e => e.start <= idx && e.end >= idx + entry.length && e.type === rule.type
            );
            if (!isDuplicate) {
              entities.push({
                type: rule.type,
                value: entry,
                start: idx,
                end: idx + entry.length,
                confidence: rule.confidence * 0.9, // 词典匹配置信度略低
              });
            }
            searchIndex = idx + 1;
          }
        }
      }
    }

    // 专业术语提取
    const termEntities = this.extractTerminology(text);
    entities.push(...termEntities);

    // 按起始位置排序
    entities.sort((a, b) => a.start - b.start);

    // 去除重叠实体（保留置信度更高的）
    return this.deduplicateEntities(entities);
  }

  /** 去除重叠实体 */
  private deduplicateEntities(entities: Entity[]): Entity[] {
    if (entities.length <= 1) return entities;

    const result: Entity[] = [entities[0]];
    for (let i = 1; i < entities.length; i++) {
      const prev = result[result.length - 1];
      const curr = entities[i];

      // 检查是否重叠
      if (curr.start < prev.end) {
        // 重叠时保留置信度更高的
        if (curr.confidence > prev.confidence) {
          result[result.length - 1] = curr;
        }
      } else {
        result.push(curr);
      }
    }

    return result;
  }

  // ============ 情感分析 ============

  /**
   * 分析文本的情感极性、紧迫度和情绪
   * 基于情感词典 + 启发式规则
   */
  private analyzeSentiment(text: string): Sentiment {
    let polarityScore = 0;
    let urgencyScore = 0;
    const emotionCounts: Record<string, number> = {};

    // 基于情感词典计算
    for (const entry of this.sentimentDict) {
      if (text.includes(entry.word)) {
        polarityScore += entry.polarity;
        urgencyScore = Math.max(urgencyScore, entry.urgency);
        emotionCounts[entry.emotion] = (emotionCounts[entry.emotion] || 0) + 1;
      }
    }

    // 启发式规则补充
    // 感叹号增强情感强度
    const exclamationCount = (text.match(/[！!]/g) || []).length;
    if (exclamationCount > 0) {
      polarityScore *= 1 + exclamationCount * 0.2;
      urgencyScore = Math.min(1, urgencyScore + exclamationCount * 0.1);
    }

    // 紧迫性关键词
    const urgencyKeywords = ['紧急', '马上', '立刻', '赶紧', '赶快', '尽快', '急', 'ASAP', '马上就要', '来不及', '救命'];
    for (const kw of urgencyKeywords) {
      if (text.includes(kw)) {
        urgencyScore = Math.min(1, urgencyScore + 0.4);
        emotionCounts['anxious'] = (emotionCounts['anxious'] || 0) + 1;
      }
    }

    // 大写字母过多表示激动/愤怒（英文场景）
    const upperRatio = (text.replace(/[^a-zA-Z]/g, '').match(/[A-Z]/g) || []).length /
      Math.max(text.replace(/[^a-zA-Z]/g, '').length, 1);
    if (upperRatio > 0.6 && text.length > 5) {
      polarityScore -= 0.3;
      urgencyScore = Math.min(1, urgencyScore + 0.2);
      emotionCounts['angry'] = (emotionCounts['angry'] || 0) + 1;
    }

    // 重复字符表示强调（如"好好好"、"快快快"）
    const repeatMatch = text.match(/(.)\1{2,}/g);
    if (repeatMatch) {
      urgencyScore = Math.min(1, urgencyScore + 0.15 * repeatMatch.length);
    }

    // 确定极性
    let polarity: 'positive' | 'negative' | 'neutral';
    if (polarityScore > 0.3) {
      polarity = 'positive';
    } else if (polarityScore < -0.3) {
      polarity = 'negative';
    } else {
      polarity = 'neutral';
    }

    // 确定紧迫度
    let urgency: 'low' | 'medium' | 'high' | 'critical';
    if (urgencyScore >= 0.8) {
      urgency = 'critical';
    } else if (urgencyScore >= 0.5) {
      urgency = 'high';
    } else if (urgencyScore >= 0.25) {
      urgency = 'medium';
    } else {
      urgency = 'low';
    }

    // 确定主要情绪
    const emotion = this.determineDominantEmotion(emotionCounts, polarity, urgency);

    // 细粒度情感分类
    const fineGrainedEmotion = this.classifyFineGrainedEmotion(text, polarity, urgency, emotion);

    return { polarity, urgency, emotion, fineGrainedEmotion };
  }

  /** 细粒度情感分类：识别期待、困惑、好奇、无聊、惊讶等 */
  private classifyFineGrainedEmotion(
    text: string,
    _polarity: string,
    _urgency: string,
    _emotion: string
  ): 'anticipation' | 'confusion' | 'curiosity' | 'boredom' | 'surprise' | 'trust' | 'disgust' | 'pride' | 'shame' | 'none' {
    const textLower = text.toLowerCase();

    // 期待：包含"期待"、"希望"、"盼"等
    const anticipationKeywords = ['期待', '希望', '盼', '等着', '盼望', '期望', '想看', '想要', '期待着', '憧憬'];
    if (anticipationKeywords.some(kw => textLower.includes(kw))) return 'anticipation';

    // 困惑：包含"不明白"、"搞不懂"、"什么意思"、"困惑"等
    const confusionKeywords = ['不明白', '搞不懂', '什么意思', '困惑', '不理解', '搞不清', '一头雾水', '迷糊', '懵', '晕', '不懂', 'confused', 'confusing'];
    if (confusionKeywords.some(kw => textLower.includes(kw))) return 'confusion';

    // 好奇：包含"好奇"、"想知道"、"有趣"等
    const curiosityKeywords = ['好奇', '想知道', '有趣', '试试', '探索', '研究一下', '看看', '了解一下', '怎么做到', '好奇地'];
    if (curiosityKeywords.some(kw => textLower.includes(kw))) return 'curiosity';

    // 无聊：包含"无聊"、"没意思"、"枯燥"等
    const boredomKeywords = ['无聊', '没意思', '枯燥', '乏味', '单调', 'boring', 'bored'];
    if (boredomKeywords.some(kw => textLower.includes(kw))) return 'boredom';

    // 惊讶：包含"惊讶"、"没想到"、"竟然"等
    const surpriseKeywords = ['惊讶', '没想到', '竟然', '居然', '出乎意料', '意外', '天哪', '不会吧', 'surprised', 'wow', 'omg'];
    if (surpriseKeywords.some(kw => textLower.includes(kw))) return 'surprise';

    // 信任：包含"相信"、"信任"、"靠谱"等
    const trustKeywords = ['相信', '信任', '靠谱', '可靠', '放心', '信赖', '肯定'];
    if (trustKeywords.some(kw => textLower.includes(kw))) return 'trust';

    // 厌恶：包含"恶心"、"讨厌"、"反感"等
    const disgustKeywords = ['恶心', '反感', '厌恶', '鄙视', '嫌弃', '受不了', '看不惯'];
    if (disgustKeywords.some(kw => textLower.includes(kw))) return 'disgust';

    // 自豪：包含"骄傲"、"自豪"、"厉害"等
    const prideKeywords = ['骄傲', '自豪', '成就', '成功了', '做到了', '厉害吧'];
    if (prideKeywords.some(kw => textLower.includes(kw))) return 'pride';

    // 羞耻：包含"丢人"、"尴尬"、"不好意思"等
    const shameKeywords = ['丢人', '尴尬', '不好意思', '羞愧', '惭愧', '丢脸', '难堪'];
    if (shameKeywords.some(kw => textLower.includes(kw))) return 'shame';

    return 'none';
  }

  /** 确定主要情绪 */
  private determineDominantEmotion(
    counts: Record<string, number>,
    polarity: string,
    urgency: string
  ): string {
    const entries = Object.entries(counts);
    if (entries.length > 0) {
      // 返回计数最多的情绪
      entries.sort((a, b) => b[1] - a[1]);
      return entries[0][0];
    }

    // 没有匹配到情绪词时，根据极性和紧迫度推断
    if (urgency === 'critical' || urgency === 'high') {
      return polarity === 'negative' ? 'anxious' : 'excited';
    }
    if (polarity === 'positive') return 'satisfied';
    if (polarity === 'negative') return 'frustrated';
    return 'neutral';
  }

  // ============ 语义消歧 ============

  /**
   * 检测文本中的歧义词并根据上下文消歧
   * 使用上下文窗口（最近5条消息）
   */
  private detectAmbiguity(text: string, context?: string[]): Ambiguity[] {
    const ambiguities: Ambiguity[] = [];

    for (const ambWord of this.ambiguityWords) {
      const idx = text.indexOf(ambWord.word);
      if (idx === -1) continue;

      const ambiguity: Ambiguity = {
        text: ambWord.word,
        possibleMeanings: ambWord.meanings,
      };

      // 尝试根据上下文消歧
      const resolved = this.resolveAmbiguity(ambWord, text, context);
      if (resolved) {
        ambiguity.resolvedMeaning = resolved.meaning;
        ambiguity.context = resolved.context;
      }

      ambiguities.push(ambiguity);
    }

    return ambiguities;
  }

  /** 根据上下文消解歧义 */
  private resolveAmbiguity(
    ambWord: AmbiguityWord,
    text: string,
    context?: string[]
  ): { meaning: string; context: string } | null {
    // 合并当前文本和上下文
    const allTexts = [...(context || []), text];

    // 检查上下文关键词
    for (const [contextKeyword, meaning] of Object.entries(ambWord.contextKeywords)) {
      for (const t of allTexts) {
        if (t.includes(contextKeyword)) {
          return { meaning, context: `上下文中出现"${contextKeyword}"` };
        }
      }
    }

    return null;
  }

  // ============ 指令补全 ============

  /**
   * 补全不完整的指令
   * 基于常见模式和上下文推断用户省略的内容
   */
  private completeInstruction(text: string, context?: string[]): string {
    let completed = text;

    // 1. 基于补全模式匹配
    for (const pattern of this.completionPatterns) {
      const match = completed.match(pattern.pattern);
      if (match) {
        completed = pattern.completion(match);
        break; // 只应用第一个匹配的补全模式
      }
    }

    // 2. 基于上下文补全
    if (context && context.length > 0) {
      completed = this.completeFromContext(completed, context);
    }

    // 3. 通用补全规则
    completed = this.applyGeneralCompletion(completed);

    return completed;
  }

  /** 基于上下文补全指令 */
  private completeFromContext(text: string, context: string[]): string {
    const recentContext = context.slice(-this.CONTEXT_WINDOW_SIZE);

    // 如果当前文本以代词开头，尝试从上下文替换
    const pronounMap: Record<string, string[]> = {
      '它': ['项目', '文件', '代码', '程序', '系统'],
      '这个': ['项目', '文件', '功能', '问题', '任务'],
      '那个': ['项目', '文件', '功能', '问题', '任务'],
      '他': ['人', '用户', '开发者'],
    };

    for (const [pronoun, candidates] of Object.entries(pronounMap)) {
      if (text.startsWith(pronoun) || text.includes(pronoun)) {
        // 从上下文中寻找最可能的指代对象
        for (const ctx of [...recentContext].reverse()) {
          for (const candidate of candidates) {
            if (ctx.includes(candidate)) {
              return text.replace(pronoun, candidate);
            }
          }
        }
      }
    }

    return text;
  }

  /** 通用补全规则 */
  private applyGeneralCompletion(text: string): string {
    // "写个X" → "用JavaScript写一个X应用"
    if (/^写个?(.+)$/.test(text) && !text.includes('用') && !text.includes('语言')) {
      return text.replace(/^写个?(.+)$/, '用JavaScript写一个$1应用');
    }

    // "帮我X" → 如果没有明确对象，补充"相关内容"
    if (/^帮我(.+)$/.test(text) && text.length < 10) {
      return text + '的相关内容';
    }

    // "运行" → "运行当前项目"
    if (/^(运行|启动|执行)$/.test(text.trim())) {
      return text.trim() + '当前项目';
    }

    // "测试" → "运行项目测试"
    if (/^(测试|跑测试)$/.test(text.trim())) {
      return '运行项目测试';
    }

    // "部署" → "部署到生产环境"
    if (/^(部署|发布)$/.test(text.trim())) {
      return text.trim() + '到生产环境';
    }

    return text;
  }

  // ============ 结构化任务 ============

  /**
   * 将意图和实体转化为结构化任务描述
   */
  private structureTask(intents: Intent[], entities: Entity[]): StructuredTask {
    const primaryIntent = intents[0];

    // 确定核心动作
    const action = this.mapIntentToAction(primaryIntent?.name || 'chat');

    // 确定操作对象
    const target = this.extractTargetFromEntities(entities) ||
      primaryIntent?.slots?.target || '';

    // 提取约束条件
    const constraints = this.extractConstraints(intents, entities);

    // 提取参数
    const parameters = this.extractParameters(intents, entities);

    // 确定优先级
    const priority = this.determinePriority(intents, entities);

    // 评估复杂度
    const estimatedComplexity = this.estimateComplexity(intents, entities);

    // 确定所需工具
    const requiredTools = this.determineRequiredTools(intents, entities);

    // 建议Agent
    const suggestedAgent = this.suggestAgent(intents, entities);

    return {
      action,
      target,
      constraints,
      parameters,
      priority,
      estimatedComplexity,
      requiredTools,
      suggestedAgent,
    };
  }

  /** 意图到动作的映射 */
  private mapIntentToAction(intentName: string): string {
    const actionMap: Record<string, string> = {
      'code_generation': '生成代码',
      'code_review': '审查代码',
      'code_debug': '调试代码',
      'code_refactor': '重构代码',
      'code_explain': '解释代码',
      'code_test': '编写测试',
      'file_operation': '操作文件',
      'search': '搜索信息',
      'query': '查询信息',
      'translate': '翻译文本',
      'summarize': '总结内容',
      'deploy': '部署项目',
      'execute': '执行操作',
      'schedule': '安排日程',
      'data_analysis': '分析数据',
      'write_document': '撰写文档',
      'git_operation': 'Git操作',
      'system_config': '配置系统',
      'express': '表达想法',
      'chat': '对话交流',
      'architecture_analysis': '分析架构',
      'performance_optimization': '优化性能',
      'security_audit': '安全审计',
      'api_design': '设计API',
      'database_design': '设计数据库',
      'learning_help': '学习指导',
      'comparison': '对比分析',
      'automation': '自动化配置',
      'monitoring': '配置监控',
      'containerization': '容器化部署',
      'self_evolution': '自我进化',
      'self_learning': '自我学习',
      'sub_agent': '子Agent管理',
      'system_diagnose': '系统诊断',
      'task_planning': '任务规划',
      'self_heal': '自我修复',
      'personalization': '个性化配置',
      'memory_query': '记忆查询',
      'model_management': '模型管理',
      'consciousness': '意识状态',
      'goal_management': '目标管理',
      'creativity_tools': '创意工具',
    };
    return actionMap[intentName] || intentName;
  }

  /** 从实体中提取操作对象 */
  private extractTargetFromEntities(entities: Entity[]): string {
    // 优先使用文件名、代码语言等实体
    const priorityTypes = ['filename', 'language', 'path', 'project', 'person', 'location'];
    for (const type of priorityTypes) {
      const entity = entities.find(e => e.type === type);
      if (entity) return entity.value;
    }
    // 使用第一个实体
    return entities[0]?.value || '';
  }

  /** 提取约束条件 */
  private extractConstraints(intents: Intent[], entities: Entity[]): string[] {
    const constraints: string[] = [];

    for (const intent of intents) {
      // 从槽位中提取约束
      if (intent.slots.language) {
        constraints.push(`使用${intent.slots.language}语言`);
      }
      if (intent.slots.count) {
        constraints.push(`数量为${intent.slots.count}`);
      }
      if (intent.slots.time) {
        constraints.push(`时间要求：${intent.slots.time}`);
      }
      if (intent.slots.path) {
        constraints.push(`路径：${intent.slots.path}`);
      }
    }

    // 从实体中提取约束
    for (const entity of entities) {
      if (entity.type === 'language' && !constraints.some(c => c.includes(entity.value))) {
        constraints.push(`使用${entity.value}语言`);
      }
    }

    return constraints;
  }

  /** 提取参数 */
  private extractParameters(intents: Intent[], entities: Entity[]): Record<string, string> {
    const params: Record<string, string> = {};

    // 合并所有意图的槽位
    for (const intent of intents) {
      Object.assign(params, intent.slots);
    }

    // 补充实体的信息
    for (const entity of entities) {
      if (!params[entity.type]) {
        params[entity.type] = entity.value;
      }
    }

    return params;
  }

  /** 确定任务优先级 */
  private determinePriority(intents: Intent[], entities: Entity[]): 'low' | 'medium' | 'high' | 'critical' {
    // 包含紧急意图则高优先级
    const highPriorityIntents = ['code_debug', 'deploy', 'system_config', 'self_heal', 'self_evolution'];
    if (intents.some(i => highPriorityIntents.includes(i.name) && i.confidence > 0.5)) {
      return 'high';
    }

    // 包含关键实体则高优先级
    const criticalEntities = entities.filter(e =>
      e.type === 'error' || e.type === 'bug' || e.value.includes('紧急')
    );
    if (criticalEntities.length > 0) {
      return 'critical';
    }

    // 代码生成和审查为中优先级
    const mediumPriorityIntents = ['code_generation', 'code_review', 'code_refactor', 'data_analysis'];
    if (intents.some(i => mediumPriorityIntents.includes(i.name))) {
      return 'medium';
    }

    return 'low';
  }

  /** 评估任务复杂度 */
  private estimateComplexity(intents: Intent[], entities: Entity[]): 'simple' | 'moderate' | 'complex' {
    let score = 0;

    // 多意图增加复杂度
    score += intents.length * 2;

    // 特定意图的复杂度权重
    const complexityWeights: Record<string, number> = {
      'code_generation': 3,
      'code_debug': 4,
      'code_refactor': 3,
      'data_analysis': 3,
      'deploy': 4,
      'code_review': 2,
      'code_test': 2,
      'file_operation': 1,
      'search': 1,
      'query': 1,
      'translate': 1,
      'summarize': 1,
      'architecture_analysis': 4,
      'performance_optimization': 4,
      'security_audit': 3,
      'api_design': 3,
      'database_design': 3,
      'learning_help': 2,
      'comparison': 2,
      'automation': 3,
      'monitoring': 2,
      'containerization': 3,
      'self_evolution': 4,
      'self_learning': 2,
      'sub_agent': 4,
      'system_diagnose': 2,
      'task_planning': 3,
      'self_heal': 4,
      'personalization': 1,
      'memory_query': 1,
      'model_management': 1,
      'consciousness': 1,
      'goal_management': 2,
      'creativity_tools': 3,
    };

    for (const intent of intents) {
      score += complexityWeights[intent.name] || 1;
    }

    // 多实体增加复杂度
    score += Math.floor(entities.length / 2);

    if (score >= 8) return 'complex';
    if (score >= 4) return 'moderate';
    return 'simple';
  }

  /** 确定所需工具 */
  private determineRequiredTools(intents: Intent[], entities: Entity[]): string[] {
    const tools = new Set<string>();

    const intentToolMap: Record<string, string[]> = {
      'code_generation': ['code-editor', 'compiler'],
      'code_review': ['code-analyzer', 'git'],
      'code_debug': ['debugger', 'logger'],
      'code_refactor': ['code-editor', 'code-analyzer'],
      'code_test': ['test-runner', 'coverage'],
      'file_operation': ['file-system'],
      'search': ['web-search', 'browser'],
      'deploy': ['terminal', 'docker', 'ci-cd'],
      'data_analysis': ['spreadsheet', 'chart'],
      'git_operation': ['git'],
      'execute': ['terminal'],
      'architecture_analysis': ['code-analyzer', 'diagram'],
      'performance_optimization': ['profiler', 'benchmark'],
      'security_audit': ['security-scanner', 'code-analyzer'],
      'api_design': ['code-editor', 'swagger'],
      'database_design': ['database', 'migration'],
      'learning_help': ['web-search', 'browser'],
      'comparison': ['web-search', 'browser'],
      'automation': ['terminal', 'code-editor'],
      'monitoring': ['terminal', 'config-editor'],
      'containerization': ['docker', 'terminal'],
      'self_evolution': ['self-analyzer', 'code-editor'],
      'self_learning': ['self-learner', 'knowledge-base'],
      'sub_agent': ['agent-orchestrator', 'task-manager'],
      'system_diagnose': ['diagnostic', 'benchmark'],
      'task_planning': ['planner', 'task-manager'],
      'self_heal': ['healer', 'diagnostic'],
      'personalization': ['config-editor'],
      'memory_query': ['memory-store'],
      'model_management': ['config-editor'],
      'consciousness': ['cognitive-monitor'],
      'goal_management': ['goal-tracker'],
      'creativity_tools': ['creative-engine'],
    };

    for (const intent of intents) {
      const intentTools = intentToolMap[intent.name] || [];
      intentTools.forEach(t => tools.add(t));
    }

    // 根据实体补充工具
    for (const entity of entities) {
      if (entity.type === 'language') {
        tools.add('compiler');
      }
      if (entity.type === 'url') {
        tools.add('browser');
      }
      if (entity.type === 'path' || entity.type === 'filename') {
        tools.add('file-system');
      }
    }

    return Array.from(tools);
  }

  /** 建议Agent */
  private suggestAgent(intents: Intent[], _entities: Entity[]): string {
    const primaryIntent = intents[0]?.name || 'chat';

    const agentMap: Record<string, string> = {
      'code_generation': 'coder',
      'code_review': 'reviewer',
      'code_debug': 'debugger',
      'code_refactor': 'refactorer',
      'code_explain': 'explainer',
      'code_test': 'tester',
      'file_operation': 'file-agent',
      'search': 'researcher',
      'query': 'assistant',
      'translate': 'translator',
      'summarize': 'summarizer',
      'deploy': 'devops',
      'execute': 'executor',
      'data_analysis': 'analyst',
      'write_document': 'writer',
      'git_operation': 'git-agent',
      'system_config': 'admin',
      'chat': 'assistant',
      'express': 'assistant',
      'architecture_analysis': 'architect',
      'performance_optimization': 'optimizer',
      'security_audit': 'security-auditor',
      'api_design': 'api-designer',
      'database_design': 'db-architect',
      'learning_help': 'tutor',
      'comparison': 'analyst',
      'automation': 'automation-engineer',
      'monitoring': 'devops',
      'containerization': 'devops',
      'self_evolution': 'self-evolver',
      'self_learning': 'self-learner',
      'sub_agent': 'orchestrator',
      'system_diagnose': 'diagnostician',
      'task_planning': 'planner',
      'self_heal': 'healer',
      'personalization': 'configurator',
      'memory_query': 'historian',
      'model_management': 'model-manager',
      'consciousness': 'introspector',
      'goal_management': 'goal-tracker',
      'creativity_tools': 'creator',
    };

    return agentMap[primaryIntent] || 'assistant';
  }

  // ============ 专业术语识别 ============

  /** 从文本中提取专业术语 */
  private extractTerminology(text: string): Entity[] {
    const entities: Entity[] = [];

    for (const entry of this.terminologyDict) {
      // 检查术语本身
      const idx = text.indexOf(entry.term);
      if (idx !== -1) {
        entities.push({
          type: `terminology_${entry.domain}`,
          value: entry.term,
          start: idx,
          end: idx + entry.term.length,
          confidence: 0.9,
        });
        continue;
      }

      // 检查别名
      for (const alias of entry.aliases) {
        const aliasIdx = text.indexOf(alias);
        if (aliasIdx !== -1) {
          entities.push({
            type: `terminology_${entry.domain}`,
            value: alias,
            start: aliasIdx,
            end: aliasIdx + alias.length,
            confidence: 0.85,
          });
          break;
        }
      }
    }

    return entities;
  }

  // ============ 置信度计算 ============

  /** 计算总体置信度 */
  private calculateOverallConfidence(
    intents: Intent[],
    entities: Entity[],
    _sentiment: Sentiment
  ): number {
    if (intents.length === 0) return 0.1;

    // 意图置信度加权平均
    const intentConf = intents.reduce((sum, i) => sum + i.confidence, 0) / intents.length;

    // 实体置信度加权平均
    const entityConf = entities.length > 0
      ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
      : 0.5; // 没有实体时给中等置信度

    // 综合置信度：意图权重0.6，实体权重0.3，情感0.1
    const overall = intentConf * 0.6 + entityConf * 0.3 + 0.5 * 0.1;

    return Math.round(Math.min(overall, 1.0) * 100) / 100;
  }

  // ============ 初始化方法 ============

  /** 初始化意图识别规则 */
  private initializeIntentRules(): void {
    this.intentRules = [
      // ---- 编程相关意图 ----
      {
        name: 'code_generation',
        keywords: ['写', '生成', '创建', '开发', '实现', '编写', '编码', '写代码', '写个', '写一个'],
        patterns: [
          /(?:用|使用|基于)\s*(?<language>\w+)\s*(?:写|生成|创建|开发|实现|编写)\s*(?<target>.+)/,
          /(?:写|生成|创建|开发|实现|编写)\s*(?:一个|一款)?\s*(?<target>.+?)(?:的)?(?:代码|程序|应用|项目|脚本|函数|类|模块)/,
        ],
        slots: ['language', 'target', 'filename'],
        confidence: 0.85,
      },
      {
        name: 'code_review',
        keywords: ['审查', 'review', '检查代码', '代码审查', '代码检查', '看看代码', '代码质量'],
        patterns: [
          /(?:审查|review|检查|看看)\s*(?<target>.+?)(?:的)?(?:代码|实现)/,
          /(?:代码|实现)(?:的)?(?:审查|review|检查|质量)/,
        ],
        slots: ['target', 'path'],
        confidence: 0.85,
      },
      {
        name: 'code_debug',
        keywords: ['调试', 'debug', '修复', 'bug', '报错', '错误', '异常', '崩溃', '修bug', '排查'],
        patterns: [
          /(?:调试|debug|修复|排查)\s*(?<target>.+)/,
          /(?<target>.+?)(?:报错|出错|异常|崩溃|bug)/,
          /(?:报错|出错|异常|崩溃|bug)\s*(?<target>.*)/,
        ],
        slots: ['target', 'error'],
        confidence: 0.9,
      },
      {
        name: 'code_refactor',
        keywords: ['重构', '优化', '改进', 'refactor', '重写', '整理代码', '代码优化'],
        patterns: [
          /(?:重构|优化|改进|refactor|重写|整理)\s*(?<target>.+?)(?:的)?(?:代码|实现|逻辑|结构)/,
          /(?:重构|优化|改进|refactor)\s*(?<target>.+)/,
        ],
        slots: ['target', 'path'],
        confidence: 0.85,
      },
      {
        name: 'code_explain',
        keywords: ['解释', '说明', '什么意思', '讲解', 'explain', '理解', '看懂'],
        patterns: [
          /(?:解释|说明|讲解|explain)\s*(?<target>.+)/,
          /(?<target>.+?)(?:是什么意思|是什么|怎么理解|怎么看)/,
        ],
        slots: ['target'],
        confidence: 0.8,
      },
      {
        name: 'code_test',
        keywords: ['测试', 'test', '单元测试', '测试用例', '写测试', '跑测试'],
        patterns: [
          /(?:写|生成|创建|添加|运行|跑)\s*(?:单元|集成|端到端)?\s*测试/,
          /(?:测试|test)\s*(?<target>.+)/,
        ],
        slots: ['target', 'path'],
        confidence: 0.85,
      },

      // ---- 文件操作意图 ----
      {
        name: 'file_operation',
        keywords: ['文件', '读取', '写入', '创建文件', '删除文件', '移动文件', '复制文件', '重命名'],
        patterns: [
          /(?:读取|写入|创建|删除|移动|复制|重命名|打开|编辑|查看)\s*(?<target>.+?)(?:文件|目录|文件夹)/,
          /(?:文件|目录|文件夹)\s*(?<target>.+)/,
        ],
        slots: ['target', 'path', 'filename'],
        confidence: 0.85,
      },

      // ---- 搜索查询意图 ----
      {
        name: 'search',
        keywords: ['搜索', '查找', '搜索一下', '查一下', '查', '找', '百度', 'google', '搜'],
        patterns: [
          /(?:搜索|查找|查一下|找|搜)\s*(?<target>.+)/,
          /(?:帮我|请)?(?:搜索|查找|查一下|google|百度)\s*(?<target>.+)/,
          /(?:^|(?<=[\s]))查(?!看|询)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      {
        name: 'query',
        keywords: ['怎么', '如何', '为什么', '什么', '哪个', '是否', '能不能', '可以', '多少'],
        patterns: [
          /(?<target>.+?)(?:怎么|如何)(?:做|实现|写|解决|处理)/,
          /(?:为什么|what|why|how)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.75,
      },

      // ---- 翻译意图 ----
      {
        name: 'translate',
        keywords: ['翻译', 'translate', '译', '翻成', '转成'],
        patterns: [
          /(?:翻译|translate)\s*(?<target>.+?)(?:为|到|成|into|to)\s*(?<language>\w+)/,
          /(?:把|将)?(?<target>.+?)(?:翻译|译)(?:为|到|成)\s*(?<language>\w+)/,
        ],
        slots: ['target', 'language'],
        confidence: 0.9,
      },

      // ---- 总结意图 ----
      {
        name: 'summarize',
        keywords: ['总结', '摘要', '概括', '归纳', 'summarize', '提炼', '简述'],
        patterns: [
          /(?:总结|摘要|概括|归纳|summarize|提炼|简述)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },

      // ---- 部署意图 ----
      {
        name: 'deploy',
        keywords: ['部署', 'deploy', '发布', '上线', '发布版本', '打包'],
        patterns: [
          /(?:部署|deploy|发布|上线|打包)\s*(?<target>.+?)(?:到|至)\s*(?<environment>\w+)/,
          /(?:部署|deploy|发布|上线|打包)\s*(?<target>.+)/,
        ],
        slots: ['target', 'environment'],
        confidence: 0.9,
      },

      // ---- 执行意图 ----
      {
        name: 'execute',
        keywords: ['运行', '执行', '启动', '跑', 'run', 'start', 'launch'],
        patterns: [
          /(?:运行|执行|启动|跑|run|start|launch)\s*(?<target>.+)/,
        ],
        slots: ['target', 'path'],
        confidence: 0.85,
      },

      // ---- 数据分析意图 ----
      {
        name: 'data_analysis',
        keywords: ['分析', '统计', '数据', '报表', '图表', '趋势', '分析数据'],
        patterns: [
          /(?:分析|统计)\s*(?<target>.+?)(?:的)?(?:数据|趋势|报表|图表)/,
          /(?:数据|报表|图表)(?<target>.+?)(?:分析|统计)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },

      // ---- 文档撰写意图 ----
      {
        name: 'write_document',
        keywords: ['文档', '写文档', 'README', '说明文档', 'API文档', '使用手册'],
        patterns: [
          /(?:写|生成|创建|编写)\s*(?<target>.+?)(?:文档|README|手册|说明)/,
          /(?<target>.+?)(?:文档|README|手册|说明)/,
        ],
        slots: ['target', 'path'],
        confidence: 0.85,
      },

      // ---- Git操作意图 ----
      {
        name: 'git_operation',
        keywords: ['git', '提交', 'commit', 'push', 'pull', '分支', 'merge', 'checkout', 'clone'],
        patterns: [
          /(?:git\s*)?(?<action>commit|push|pull|merge|checkout|clone|add|reset|rebase|stash|branch)\s*(?<target>.*)/,
          /(?:提交|推送|拉取|合并|切换|克隆)\s*(?<target>.+?)(?:分支|代码|仓库)/,
        ],
        slots: ['action', 'target'],
        confidence: 0.9,
      },

      // ---- 系统配置意图 ----
      {
        name: 'system_config',
        keywords: ['配置', '设置', 'config', '安装', '环境', '初始化', 'setup'],
        patterns: [
          /(?:配置|设置|config|安装|初始化|setup)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },

      // ---- 日程安排意图 ----
      {
        name: 'schedule',
        keywords: ['日程', '安排', '提醒', '会议', '计划', '日历', '待办', 'todo'],
        patterns: [
          /(?:安排|设置|添加|创建)\s*(?<target>.+?)(?:日程|提醒|会议|待办|计划)/,
          /(?:日程|提醒|会议|待办|计划|todo)\s*(?<target>.+)/,
        ],
        slots: ['target', 'time'],
        confidence: 0.85,
      },

      // ---- 架构分析意图 ----
      {
        name: 'architecture_analysis',
        keywords: ['架构', '设计模式', '系统设计', 'UML', '类图', '时序图', '架构图', '模块划分'],
        patterns: [
          /(?:分析|画出|设计|描述)\s*(?<target>.+?)(?:的)?(?:架构|结构|UML|类图|时序图)/,
          /(?:架构|系统设计|模块划分)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      // ---- 性能优化意图 ----
      {
        name: 'performance_optimization',
        keywords: ['性能优化', '加速', '慢', '卡顿', '延迟', '响应时间', '内存泄漏', 'CPU占用', '优化速度'],
        patterns: [
          /(?:优化|提升|改善|加速)\s*(?<target>.+?)(?:的)?(?:性能|速度|响应)/,
          /(?<target>.+?)(?:太慢|卡顿|延迟高|响应慢|内存泄漏|CPU高)/,
          /(?:性能|速度|响应)\s*(?<target>.+?)(?:优化|提升|改善)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      // ---- 安全审计意图 ----
      {
        name: 'security_audit',
        keywords: ['安全', '漏洞', 'XSS', 'SQL注入', 'CSRF', '加密', '认证', '授权', '渗透测试'],
        patterns: [
          /(?:安全|漏洞|渗透)\s*(?:审计|检查|测试|扫描|分析)\s*(?<target>.*)/,
          /(?:检查|扫描|检测)\s*(?<target>.+?)(?:的)?(?:安全|漏洞)/,
        ],
        slots: ['target'],
        confidence: 0.9,
      },
      // ---- API设计意图 ----
      {
        name: 'api_design',
        keywords: ['API', '接口设计', 'REST', 'GraphQL', '端点', '路由', 'Swagger', 'OpenAPI'],
        patterns: [
          /(?:设计|创建|定义|开发)\s*(?<target>.+?)(?:的)?(?:API|接口|端点|路由)/,
          /(?:API|接口|REST|GraphQL)\s*(?:设计|开发|定义)\s*(?<target>.*)/,
        ],
        slots: ['target'],
        confidence: 0.9,
      },
      // ---- 数据库设计意图 ----
      {
        name: 'database_design',
        keywords: ['数据库', '表设计', 'SQL', '索引', 'ER图', '数据模型', '迁移', 'Schema'],
        patterns: [
          /(?:设计|创建|建)\s*(?<target>.+?)(?:的)?(?:数据库|表|Schema|数据模型)/,
          /(?:数据库|表|Schema)\s*(?:设计|创建|迁移)\s*(?<target>.*)/,
        ],
        slots: ['target'],
        confidence: 0.9,
      },
      // ---- 学习求助意图 ----
      {
        name: 'learning_help',
        keywords: ['学习', '教程', '入门', '怎么学', '从零开始', '新手', '教学', '课程', '指南'],
        patterns: [
          /(?:怎么学|如何学|学习|入门)\s*(?<target>.+)/,
          /(?<target>.+?)(?:教程|入门|指南|课程|教学)/,
        ],
        slots: ['target'],
        confidence: 0.8,
      },
      // ---- 对比分析意图 ----
      {
        name: 'comparison',
        keywords: ['对比', '比较', '区别', '差异', 'vs', '哪个好', '优缺点', '选择'],
        patterns: [
          /(?<target1>.+?)\s*(?:vs|对比|比较|和|与|还是)\s*(?<target2>.+?)(?:的区别|的差异|哪个好|$)/,
          /(?:对比|比较|分析)\s*(?<target1>.+?)\s*(?:和|与|vs)\s*(?<target2>.+)/,
        ],
        slots: ['target1', 'target2'],
        confidence: 0.85,
      },
      // ---- 自动化意图 ----
      {
        name: 'automation',
        keywords: ['自动化', '脚本', '批处理', '定时任务', 'CI/CD', '流水线', '工作流', 'cron'],
        patterns: [
          /(?:自动化|编写脚本|创建脚本|设置定时|配置)\s*(?<target>.+)/,
          /(?<target>.+?)(?:自动化|脚本|定时任务|流水线|工作流)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      // ---- 监控告警意图 ----
      {
        name: 'monitoring',
        keywords: ['监控', '告警', '日志', '指标', '仪表盘', 'APM', 'Prometheus', 'Grafana'],
        patterns: [
          /(?:设置|配置|搭建|创建)\s*(?<target>.+?)(?:的)?(?:监控|告警|仪表盘)/,
          /(?:监控|告警|日志|指标)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      // ---- 容器化意图 ----
      {
        name: 'containerization',
        keywords: ['Docker', '容器', 'K8s', 'Kubernetes', '镜像', '编排', 'Helm', 'Compose'],
        patterns: [
          /(?:容器化|Docker化|打包成镜像|部署到)\s*(?<target>.+)/,
          /(?:Docker|K8s|Kubernetes|容器)\s*(?:配置|部署|编排)\s*(?<target>.*)/,
        ],
        slots: ['target'],
        confidence: 0.9,
      },

      // ---- 金融领域意图 ----
      {
        name: 'finance_query',
        keywords: ['股票', '基金', '理财', '投资', '汇率', '期货', '债券', '收益', '利率'],
        patterns: [
          /(?:股票|基金|理财|投资|汇率|期货|债券|收益|利率)\s*(?<target>.*)/,
          /(?:查询|了解|分析)\s*(?<target>.*)(?:股票|基金|理财|投资|汇率|期货|债券|收益|利率)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      {
        name: 'finance_loan',
        keywords: ['贷款', '信用', '抵押', '还款', '负债', '资产'],
        patterns: [
          /(?:贷款|信用|抵押|还款|负债|资产)\s*(?<target>.*)/,
          /(?:申请|办理|咨询)\s*(?<target>.*)(?:贷款|信用|抵押|还款)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },

      // ---- 医疗健康意图 ----
      {
        name: 'medical_query',
        keywords: ['症状', '疾病', '药物', '治疗', '诊断', '医院', '挂号', '体检'],
        patterns: [
          /(?:症状|疾病|药物|治疗|诊断|医院|挂号|体检)\s*(?<target>.*)/,
          /(?:查询|了解|咨询)\s*(?<target>.*)(?:症状|疾病|药物|治疗|诊断)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      {
        name: 'health_advice',
        keywords: ['饮食', '营养', '运动', '睡眠', '心理健康', '压力'],
        patterns: [
          /(?:饮食|营养|运动|睡眠|心理健康|压力)\s*(?<target>.*)/,
          /(?:建议|指导|如何改善)\s*(?<target>.*)(?:饮食|营养|运动|睡眠|心理健康)/,
        ],
        slots: ['target'],
        confidence: 0.82,
      },

      // ---- 法律意图 ----
      {
        name: 'legal_query',
        keywords: ['合同', '法律', '维权', '诉讼', '仲裁', '法规', '条款'],
        patterns: [
          /(?:合同|法律|维权|诉讼|仲裁|法规|条款)\s*(?<target>.*)/,
          /(?:咨询|了解|查询)\s*(?<target>.*)(?:合同|法律|维权|诉讼|仲裁|法规)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },

      // ---- 教育意图 ----
      {
        name: 'education_query',
        keywords: ['考试', '课程', '学习', '培训', '学历', '证书', '教学'],
        patterns: [
          /(?:考试|课程|学习|培训|学历|证书|教学)\s*(?<target>.*)/,
          /(?:报名|参加|了解)\s*(?<target>.*)(?:考试|课程|培训|学历|证书)/,
        ],
        slots: ['target'],
        confidence: 0.82,
      },

      // ---- 旅行意图 ----
      {
        name: 'travel_query',
        keywords: ['旅游', '机票', '酒店', '签证', '行程', '景点', '攻略'],
        patterns: [
          /(?:旅游|机票|酒店|签证|行程|景点|攻略)\s*(?<target>.*)/,
          /(?:预订|查询|规划)\s*(?<target>.*)(?:旅游|机票|酒店|签证|行程|景点)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },

      // ---- 段先生项目特定意图 ----
      {
        name: 'self_evolution',
        keywords: ['进化', '自进化', '自我改进', 'self-evolve', 'evolve', '升级自己', '提升自己', '自我升级'],
        patterns: [
          /(?:触发|运行|执行|启动)\s*(?:自进化|自我进化|进化)/,
          /(?:self.?evolve|进化)\s*(?:周期|流程|分析)/,
          /(?:分析|检查)\s*(?:代码|项目)(?:改进|优化|提升)空间/,
        ],
        slots: ['target'],
        confidence: 0.88,
      },
      {
        name: 'self_learning',
        keywords: ['学习', 'self-learning', 'learn', '技能', '知识', '经验', '记录学习', '学习报告', '学习记录'],
        patterns: [
          /(?:查看|显示|查询|展示)\s*(?:(?:学习|技能|知识)\s*)?(?:报告|统计|状态|记录)/,
          /(?:学习|技能|知识)(?:报告|统计|状态)/,
          /(?:记录|保存|存储)\s*(?:学习|经验|知识)/,
          /(?:学习|知识|技能)\s*(?:查询|搜索|查找)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      {
        name: 'sub_agent',
        keywords: ['子Agent', '子智能体', 'spawn', '多Agent', '并行任务', '派生子任务'],
        patterns: [
          /(?:创建|派发|启动|生成)\s*(?:子Agent|子智能体|子任务)/,
          /(?:并行|同时|并发)\s*(?:执行|处理|运行)\s*(?<target>.+)/,
          /(?:子Agent|多Agent)\s*(?:状态|结果|列表)/,
        ],
        slots: ['target'],
        confidence: 0.88,
      },
      {
        name: 'system_diagnose',
        keywords: ['诊断', 'diagnose', '系统状态', '健康检查', '性能', 'benchmark', '基准测试', '系统诊断', '诊断系统', '系统检测', '性能诊断'],
        patterns: [
          /(?:运行|执行|进行)\s*(?:诊断|基准测试|性能测试)/,
          /(?:查看|显示|查询)\s*(?:系统|性能|运行)(?:状态|指标|报告)/,
          /(?:系统|模块|组件)\s*(?:诊断|检测|检查)/,
          /(?:诊断|检测|检查)\s*(?:系统|模块|组件)/,
          /(?:诊断|检测|检查|benchmark)\s*(?:一下|下|一)?\s*(?:系统|模块|组件|性能|网络)\s*(?:的|之)?\s*(?:状态|问题|指标|报告|性能)?/,
          /(?:系统|模块|组件|性能|网络)\s*(?:的|之)?\s*(?:诊断|检测|检查|benchmark)/,
          /(?:诊断|检测|检查)\s*(?:一下|下)?\s*(?:这个|一个|那个)?\s*(?:系统|模块|组件|性能|网络)/,
        ],
        slots: ['target'],
        confidence: 0.88,
      },
      {
        name: 'task_planning',
        keywords: ['规划', '计划', '任务规划', '多步骤', 'create_plan', 'workflow', '工作流', '步骤计划'],
        patterns: [
          /(?:创建|制定|规划)\s*(?:任务|工作)?(?:计划|规划|流程)/,
          /(?:多步骤|分步|逐步)\s*(?:执行|实现|完成)\s*(?<target>.+)/,
          /(?:创建|制定)\s*(?<target>.+?)(?:计划|规划|步骤)/,
          /(?:计划|工作流)\s*(?:进度|状态|列表)/,
        ],
        slots: ['target'],
        confidence: 0.87,
      },
      {
        name: 'self_heal',
        keywords: ['自愈', '自修复', '修复', 'repair', 'self-heal', 'heal', '恢复', '修复系统'],
        patterns: [
          /(?:触发|运行|执行)\s*(?:自愈|自修复|自我修复)/,
          /(?:修复|恢复)\s*(?:系统|模块|数据)/,
          /(?:健康|异常)\s*(?:检测|检查|诊断)/,
        ],
        slots: ['target'],
        confidence: 0.88,
      },
      {
        name: 'personalization',
        keywords: ['个性化', '偏好', '设置', '配置', '用户画像', 'personalization', '偏好设置'],
        patterns: [
          /(?:查看|设置|修改)\s*(?:个性化|偏好|个人设置)/,
          /(?:用户|我的)\s*(?:画像|偏好|喜好|习惯)/,
        ],
        slots: ['target'],
        confidence: 0.82,
      },
      {
        name: 'memory_query',
        keywords: ['记忆', 'memory', '回忆', '记住', '之前', '历史', '说过', '提过', '聊过', '对话历史', '聊天记录', '历史记录', '之前说过'],
        patterns: [
          /(?:查询|搜索|查找|查看?)\s*(?:之前|历史)?\s*(?:记忆|历史记录|聊天记录|对话历史)/,
          /我(?:之前|以前|刚才)\s*(?:说|提|问|让|叫|聊|讨论)(?:过|的)?\s*(?<target>.+)/,
          /(?:之前|以前|刚才)\s*(?:我|我们)?\s*(?:说|提|问|聊|讨论)(?:过|的)?\s*(?:的)?\s*(?<target>.+)/,
          /(?:记得|记住|回忆|想起来)\s*(?:我|我们)?\s*(?:之前|以前)?\s*(?:说过|聊过|讨论过)?\s*(?<target>.+)/,
          /(?:查|搜索|找)\s*(?:一下|一?)\s*(?:我(?:的|之前)?)?\s*(?:记忆|历史|记录|聊天)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      {
        name: 'model_management',
        keywords: ['模型', 'model', 'API', 'Key', 'API Key', '切换模型', '模型列表', 'DeepSeek', 'Claude', 'OpenAI'],
        patterns: [
          /(?:查看|显示|列出)\s*(?:模型|API)(?:列表|状态|配置)/,
          /(?:切换|选择|设置)\s*(?:模型|AI模型)/,
          /(?:配置|设置)\s*(?:API Key|密钥|key)/,
        ],
        slots: ['target'],
        confidence: 0.9,
      },
      {
        name: 'consciousness',
        keywords: ['意识', '认知', 'consciousness', '情绪', 'mood', '心情', '心跳', 'heartbeat'],
        patterns: [
          /(?:查看|显示)\s*(?:意识|认知|情绪|心情)(?:状态|报告|详情)/,
          /(?:设置|切换)\s*(?:情绪|心情|模式)/,
          /(?:心跳|heartbeat)\s*(?:状态|启动|停止)/,
        ],
        slots: ['target'],
        confidence: 0.85,
      },
      {
        name: 'goal_management',
        keywords: ['目标', 'goal', '里程碑', '任务追踪', 'progress', '进度', '目标进度', '任务进度'],
        patterns: [
          /(?:创建|添加|设定)\s*(?:目标|里程碑)/,
          /(?:查看|显示|查询)\s*(?:目标|任务)(?:列表|进度|状态)/,
          /(?:目标|任务)\s*(?:完成|达成|进度|追踪)/,
          /(?:我(?:的|的)?|当前)?(?:目标|任务)(?:进度|列表|状态)/,
        ],
        slots: ['target'],
        confidence: 0.87,
      },
      {
        name: 'creativity_tools',
        keywords: ['流程图', '分镜', '视频', '生成视频', '创意', 'storyboard', 'flowchart'],
        patterns: [
          /(?:生成|创建|画)\s*(?:流程图|分镜|视频)/,
          /(?:flowchart|storyboard|video)\s*(?<target>.+)/,
        ],
        slots: ['target'],
        confidence: 0.88,
      },

      // ---- 情感支持意图 ----
      {
        name: 'emotional_support',
        keywords: ['焦虑', '抑郁', '孤独', '难过', '伤心', '不开心', '压力', '烦躁'],
        patterns: [
          /(?:焦虑|抑郁|孤独|难过|伤心|不开心|压力|烦躁)\s*(?<target>.*)/,
          /(?:我|很|非常|特别)\s*(?<target>.*)(?:焦虑|抑郁|孤独|难过|伤心|不开心|烦躁)/,
        ],
        slots: ['target'],
        confidence: 0.80,
      },
      {
        name: 'emotional_positive',
        keywords: ['开心', '高兴', '快乐', '兴奋', '感恩', '幸福'],
        patterns: [
          /(?:开心|高兴|快乐|兴奋|感恩|幸福)\s*(?<target>.*)/,
          /(?:我|很|非常|特别)\s*(?<target>.*)(?:开心|高兴|快乐|兴奋|幸福)/,
        ],
        slots: ['target'],
        confidence: 0.80,
      },
    ];
  }

  /** 初始化实体提取规则 */
  private initializeEntityRules(): void {
    this.entityRules = [
      // ---- 编程语言 ----
      {
        type: 'language',
        patterns: [
          /(?<!\w)(python|java|javascript|typescript|c\+\+|c#|go|golang|rust|ruby|php|swift|kotlin|scala|r|matlab|html|css|sql|shell|bash|powershell|dart|lua|perl|haskell|elixir|clojure|julia|objc|objectivec)(?!\w)/gi,
        ],
        dictionary: [
          'Python', 'Java', 'JavaScript', 'TypeScript', 'C++', 'C#', 'Go', 'Rust',
          'Ruby', 'PHP', 'Swift', 'Kotlin', 'Scala', 'R', 'MATLAB', 'HTML', 'CSS',
          'SQL', 'Shell', 'Bash', 'PowerShell', 'Dart', 'Lua', 'Perl', 'Haskell',
        ],
        confidence: 0.9,
      },

      // ---- 文件名 ----
      {
        type: 'filename',
        patterns: [
          /(?<!\w)([\w\-.]+\.(?:ts|js|py|java|go|rs|cpp|c|h|rb|php|html|css|json|xml|yaml|yml|md|txt|csv|sql|sh|bat|ps1|tsx|jsx|vue|svelte|dart|lua|pl|hs|ex|clj|jl|m|mm|swift|kt|scala|r))(?!\w)/gi,
        ],
        confidence: 0.85,
      },

      // ---- 文件路径 ----
      {
        type: 'path',
        patterns: [
          /(?<!\w)((?:[a-zA-Z]:)?[\\/][\w\\/.-]*|~?\/[\w/.-]*|\.\/[\w/.-]*|\.\.\/[\w/.-]*)/g,
        ],
        confidence: 0.8,
      },

      // ---- URL ----
      {
        type: 'url',
        patterns: [
          /(?<!\w)(https?:\/\/[\w\-.]+(?:\.[\w]{2,})+(?:\/[\w\-./?=&#%]*)?)(?!\w)/gi,
        ],
        confidence: 0.95,
      },

      // ---- 邮箱 ----
      {
        type: 'email',
        patterns: [
          /(?<!\w)([\w.-]+@[\w.-]+\.\w{2,})(?!\w)/gi,
        ],
        confidence: 0.95,
      },

      // ---- IP地址 ----
      {
        type: 'ip',
        patterns: [
          /(?<!\w)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\w)/g,
        ],
        confidence: 0.85,
      },

      // ---- 时间表达式 ----
      {
        type: 'time',
        patterns: [
          /(?<!\w)(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?)/g,
          /(?<!\w)(\d{1,2}[-/月]\d{1,2}[日号]?)/g,
          /(?<!\w)(今天|明天|后天|昨天|前天|现在|目前|当前|刚刚|刚才|稍后|等下|下周|上周|本月|上月|下月|今年|去年|明年)(?!\w)/g,
          /(?<!\w)(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[上下]午)?)/g,
          /(?<!\w)(上午|下午|晚上|早上|中午|凌晨|傍晚)\s*\d{1,2}点?(?!\w)/g,
        ],
        dictionary: [
          '今天', '明天', '后天', '昨天', '前天', '现在', '目前', '当前',
          '刚刚', '刚才', '稍后', '等下', '下周', '上周', '本月', '上月',
        ],
        confidence: 0.85,
      },

      // ---- 人名 ----
      {
        type: 'person',
        patterns: [
          /(?<!\w)(张三|李四|王五|赵六|小明|小红|小华|小刚|小美|老王|老李|老张|小王|小李|小张)(?!\w)/g,
        ],
        confidence: 0.7,
      },

      // ---- 地名 ----
      {
        type: 'location',
        patterns: [
          /(?<!\w)(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|重庆|苏州|天津|长沙|郑州|东莞|青岛|沈阳|宁波|昆明|厦门|福州|无锡|合肥|大连|哈尔滨|济南|温州|佛山|贵阳|南宁|珠海|东京|纽约|伦敦|巴黎|柏林|悉尼|新加坡|首尔|旧金山|洛杉矶|芝加哥|多伦多)(?!\w)/g,
        ],
        confidence: 0.8,
      },

      // ---- 数字 ----
      {
        type: 'number',
        patterns: [
          /(?<!\w)(\d+(?:\.\d+)?(?:%|百分之|个|条|项|次|份|篇|行|页|MB|GB|KB|TB|KB|k|m|万|亿|千|百)?)(?!\w)/g,
        ],
        confidence: 0.9,
      },

      // ---- 版本号 ----
      {
        type: 'version',
        patterns: [
          /(?<!\w)(v?\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc|stable|latest|next|canary)\.\d+)?)(?!\w)/gi,
        ],
        confidence: 0.9,
      },

      // ---- 错误信息 ----
      {
        type: 'error',
        patterns: [
          /(?<!\w)(Error:\s*.+|TypeError:.+|ReferenceError:.+|SyntaxError:.+|RuntimeError:.+|ImportError:.+|ModuleNotFoundError:.+|KeyError:.+|ValueError:.+|IndexError:.+|AttributeError:.+|NullPointerException:.+|FileNotFoundException:.+|StackOverflowError:.+|OutOfMemoryError:.+)(?!\w)/g,
          /(?<!\w)(ERR_\w+|E\d{3,5}|0x[0-9a-fA-F]{4,8})(?!\w)/g,
        ],
        confidence: 0.85,
      },

      // ---- 框架/库 ----
      {
        type: 'framework',
        patterns: [],
        dictionary: [
          'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Nuxt.js', 'Express',
          'Koa', 'Fastify', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Spring',
          'SpringBoot', 'Rails', 'Laravel', 'Symfony', 'Gin', 'Echo', 'Fiber',
          'Actix', 'Rocket', 'Axum', 'Flutter', 'React Native', 'Electron',
          'Tauri', 'Qt', '.NET', 'Unity', 'Unreal', 'Tailwind', 'Bootstrap',
          'Webpack', 'Vite', 'Rollup', 'esbuild', 'Turbopack',
        ],
        confidence: 0.85,
      },

      // ---- 数据库 ----
      {
        type: 'database',
        patterns: [],
        dictionary: [
          'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'SQLite', 'Oracle',
          'SQL Server', 'Cassandra', 'CouchDB', 'DynamoDB', 'Elasticsearch',
          'MariaDB', 'CockroachDB', 'TiDB', 'ClickHouse', 'Neo4j',
        ],
        confidence: 0.85,
      },

      // ---- 操作系统 ----
      {
        type: 'os',
        patterns: [],
        dictionary: [
          'Windows', 'macOS', 'Linux', 'Ubuntu', 'CentOS', 'Debian', 'Fedora',
          'Arch', 'Android', 'iOS', 'HarmonyOS',
        ],
        confidence: 0.85,
      },

      // ---- 项目名（常见缩写） ----
      {
        type: 'project',
        patterns: [
          /(?<!\w)([\w-]+(?:项目|工程|仓库|repo|repository|project))(?!\w)/gi,
        ],
        confidence: 0.7,
      },

      // ---- 命令/工具 ----
      {
        type: 'command',
        patterns: [
          /(?<!\w)(npm|yarn|pnpm|pip|cargo|go|brew|apt|yum|choco|scoop)\s+(?<value>[\w\-@./]+)/gi,
        ],
        dictionary: [
          'npm', 'yarn', 'pnpm', 'pip', 'cargo', 'brew', 'apt', 'yum',
          'docker', 'kubectl', 'git', 'ssh', 'scp', 'curl', 'wget',
        ],
        confidence: 0.85,
      },
      // ---- 环境变量 ----
      {
        type: 'env_var',
        patterns: [
          /(?<!\w)([A-Z][A-Z0-9_]{2,})(?!\w)/g,
        ],
        dictionary: [
          'NODE_ENV', 'API_KEY', 'DATABASE_URL', 'PORT', 'HOST',
          'SECRET_KEY', 'ACCESS_TOKEN', 'REFRESH_TOKEN',
        ],
        confidence: 0.75,
      },
      // ---- 代码关键字 ----
      {
        type: 'code_keyword',
        patterns: [],
        dictionary: [
          'function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var',
          'import', 'export', 'default', 'async', 'await', 'return', 'throw',
          'try', 'catch', 'finally', 'if', 'else', 'for', 'while', 'switch',
          'def', 'self', 'lambda', 'yield', 'with', 'from', 'as',
          'public', 'private', 'protected', 'static', 'abstract', 'extends', 'implements',
        ],
        confidence: 0.7,
      },

      // ---- 百分比 ----
      {
        type: 'percentage',
        patterns: [
          /([\d.]+%)/g,
        ],
        confidence: 0.9,
      },

      // ---- 货币金额 ----
      {
        type: 'currency',
        patterns: [
          /([\d.]+(?:万|亿|千|百)+(?:元|块|美元|欧元|日元|英镑))/g,
        ],
        confidence: 0.9,
      },

      // ---- 相对日期 ----
      {
        type: 'relative_date',
        patterns: [
          /(今天|明天|后天|昨天|前天|大后天|上周|下周|这周|本月|下月|今年|明年)/g,
        ],
        confidence: 0.9,
      },

      // ---- 时间段 ----
      {
        type: 'time_period',
        patterns: [
          /((?:上午|下午|晚上|凌晨|中午|傍晚)(?:\d{1,2}点(?:\d{1,2}分)?)?)/g,
        ],
        confidence: 0.85,
      },

      // ---- 地址 ----
      {
        type: 'address',
        patterns: [
          /([\u4e00-\u9fa5]{2,4}(?:省|市|区|县|镇|乡|路|街|道|号))/g,
        ],
        confidence: 0.8,
      },
    ];
  }

  /** 初始化歧义词库 */
  private initializeAmbiguityWords(): void {
    this.ambiguityWords = [
      {
        word: '苹果',
        meanings: ['水果', '科技公司'],
        contextKeywords: { '手机': '科技公司', '电脑': '科技公司', 'iPhone': '科技公司', 'Mac': '科技公司', 'iOS': '科技公司', '吃': '水果', '买水果': '水果', '价格': '科技公司', '股票': '科技公司', 'AAPL': '科技公司' },
      },
      {
        word: 'Java',
        meanings: ['编程语言', '印尼岛屿', '咖啡'],
        contextKeywords: { '代码': '编程语言', '开发': '编程语言', '编程': '编程语言', 'Spring': '编程语言', 'JVM': '编程语言', '旅游': '印尼岛屿', '岛': '印尼岛屿', '咖啡': '咖啡' },
      },
      {
        word: '终端',
        meanings: ['命令行终端', '终端设备', '公交/地铁终点站'],
        contextKeywords: { '命令': '命令行终端', 'shell': '命令行终端', 'bash': '命令行终端', '代码': '命令行终端', '开发': '命令行终端', '设备': '终端设备', '手机': '终端设备', 'POS': '终端设备', '地铁': '公交/地铁终点站', '公交': '公交/地铁终点站' },
      },
      {
        word: '部署',
        meanings: ['软件部署', '军事部署', '人员部署'],
        contextKeywords: { '服务器': '软件部署', '代码': '软件部署', '项目': '软件部署', '上线': '软件部署', 'docker': '软件部署', 'k8s': '软件部署', '军队': '军事部署', '防御': '军事部署', '人员': '人员部署', '安排': '人员部署' },
      },
      {
        word: '接口',
        meanings: ['API接口', '硬件接口', '人际接口/对接人'],
        contextKeywords: { 'API': 'API接口', 'REST': 'API接口', 'HTTP': 'API接口', '调用': 'API接口', '代码': 'API接口', 'USB': '硬件接口', 'HDMI': '硬件接口', '硬件': '硬件接口', '对接': '人际接口/对接人', '联系': '人际接口/对接人' },
      },
      {
        word: '容器',
        meanings: ['Docker容器', '物理容器/包装', '数据结构容器'],
        contextKeywords: { 'Docker': 'Docker容器', 'K8s': 'Docker容器', '镜像': 'Docker容器', '部署': 'Docker容器', '数组': '数据结构容器', '列表': '数据结构容器', 'Map': '数据结构容器', 'Set': '数据结构容器', '包装': '物理容器/包装', '瓶子': '物理容器/包装' },
      },
      {
        word: '脚本',
        meanings: ['计算机脚本', '影视剧本'],
        contextKeywords: { '代码': '计算机脚本', 'Python': '计算机脚本', 'Shell': '计算机脚本', '自动化': '计算机脚本', '运行': '计算机脚本', '电影': '影视剧本', '拍摄': '影视剧本', '演员': '影视剧本', '导演': '影视剧本' },
      },
      {
        word: '运行',
        meanings: ['程序运行', '体育运动', '机器运转'],
        contextKeywords: { '代码': '程序运行', '程序': '程序运行', '项目': '程序运行', '命令': '程序运行', '跑步': '体育运动', '马拉松': '体育运动', '锻炼': '体育运动', '发动机': '机器运转', '电机': '机器运转' },
      },
      {
        word: '缓存',
        meanings: ['计算机缓存', '缓存数据/暂存'],
        contextKeywords: { 'Redis': '计算机缓存', '内存': '计算机缓存', 'CPU': '计算机缓存', '浏览器': '计算机缓存', 'CDN': '计算机缓存', '清除': '计算机缓存', '暂存': '缓存数据/暂存', '临时': '缓存数据/暂存' },
      },
      {
        word: '表',
        meanings: ['数据库表', '手表', '表格/Excel', '表面/外表'],
        contextKeywords: { '数据库': '数据库表', 'SQL': '数据库表', '字段': '数据库表', '查询': '数据库表', 'Excel': '表格/Excel', '电子表格': '表格/Excel', '统计': '表格/Excel', '手表': '手表', '时间': '手表', '品牌': '手表' },
      },
      {
        word: '服务',
        meanings: ['微服务/后端服务', '客户服务', 'Windows服务'],
        contextKeywords: { 'API': '微服务/后端服务', '部署': '微服务/后端服务', 'Docker': '微服务/后端服务', '微服务': '微服务/后端服务', '后端': '微服务/后端服务', '客户': '客户服务', '投诉': '客户服务', '售后': '客户服务', 'Windows': 'Windows服务', '系统服务': 'Windows服务', '守护进程': 'Windows服务' },
      },
      {
        word: '模型',
        meanings: ['AI/ML模型', '数据模型', '3D模型'],
        contextKeywords: { '训练': 'AI/ML模型', '推理': 'AI/ML模型', 'GPT': 'AI/ML模型', '神经网络': 'AI/ML模型', '机器学习': 'AI/ML模型', '数据库': '数据模型', 'ER图': '数据模型', 'Schema': '数据模型', '表结构': '数据模型', '3D': '3D模型', '渲染': '3D模型', 'Blender': '3D模型' },
      },
      {
        word: '测试',
        meanings: ['软件测试', '考试测试', '实验测试'],
        contextKeywords: { '单元': '软件测试', '集成': '软件测试', '代码': '软件测试', '自动化': '软件测试', '覆盖率': '软件测试', '考试': '考试测试', '题目': '考试测试', '分数': '考试测试', '实验': '实验测试', '样本': '实验测试', 'A/B': '实验测试' },
      },
      {
        word: '配置',
        meanings: ['系统配置', '项目配置', '硬件配置'],
        contextKeywords: { '环境变量': '系统配置', '服务器': '系统配置', 'nginx': '系统配置', '系统': '系统配置', 'webpack': '项目配置', 'tsconfig': '项目配置', 'eslint': '项目配置', '项目': '项目配置', 'CPU': '硬件配置', '内存': '硬件配置', '显卡': '硬件配置', '电脑': '硬件配置' },
      },
      {
        word: '进程',
        meanings: ['计算机进程', '业务流程', '法律程序'],
        contextKeywords: { 'PID': '计算机进程', '内存': '计算机进程', 'CPU': '计算机进程', '杀进程': '计算机进程', '守护': '计算机进程', '审批': '业务流程', '工作流': '业务流程', '流程': '业务流程', '诉讼': '法律程序', '司法': '法律程序' },
      },
    ];
  }

  /** 初始化指令补全模式 */
  private initializeCompletionPatterns(): void {
    this.completionPatterns = [
      // "写个计算器" → "用JavaScript写一个计算器应用"
      {
        pattern: /^写个?(.+)$/,
        completion: (match) => `用JavaScript写一个${match[1]}应用`,
        description: '补全"写个X"为完整指令',
      },
      // "帮我写X" → "帮我用TypeScript写X"
      {
        pattern: /^帮我写(.+)$/,
        completion: (match) => `帮我用TypeScript写${match[1]}`,
        description: '补全"帮我写X"为带语言指定指令',
      },
      // "创建X" → "创建一个X项目"
      {
        pattern: /^创建(.+)$/,
        completion: (match) => `创建一个${match[1]}项目`,
        description: '补全"创建X"为完整指令',
      },
      // "优化X" → "优化X的代码实现"
      {
        pattern: /^优化(.+)$/,
        completion: (match) => `优化${match[1]}的代码实现`,
        description: '补全"优化X"为完整指令',
      },
      // "修复X" → "修复X中的bug"
      {
        pattern: /^(修复|修)(.+)$/,
        completion: (match) => `修复${match[2]}中的bug`,
        description: '补全"修复X"为完整指令',
      },
      // "测试X" → "为X编写单元测试"
      {
        pattern: /^测试(.+)$/,
        completion: (match) => `为${match[1]}编写单元测试`,
        description: '补全"测试X"为完整指令',
      },
      // "部署X" → "将X部署到生产环境"
      {
        pattern: /^部署(.+)$/,
        completion: (match) => `将${match[1]}部署到生产环境`,
        description: '补全"部署X"为完整指令',
      },
      // "分析X" → "分析X的数据和趋势"
      {
        pattern: /^分析(.+)$/,
        completion: (match) => `分析${match[1]}的数据和趋势`,
        description: '补全"分析X"为完整指令',
      },
      // "解释X" → "解释X的代码逻辑"
      {
        pattern: /^解释(.+)$/,
        completion: (match) => `解释${match[1]}的代码逻辑`,
        description: '补全"解释X"为完整指令',
      },
      // "翻译X" → "将X翻译成英文"
      {
        pattern: /^翻译(.+)$/,
        completion: (match) => `将${match[1]}翻译成英文`,
        description: '补全"翻译X"为完整指令',
      },
      // "重构X" → "重构X的代码结构"
      {
        pattern: /^重构(.+)$/,
        completion: (match) => `重构${match[1]}的代码结构`,
        description: '补全"重构X"为完整指令',
      },
      // "文档X" → "为X编写API文档"
      {
        pattern: /^(?:写|生成|编写)(.+?)(?:的)?文档$/,
        completion: (match) => `为${match[1]}编写API文档`,
        description: '补全文档编写指令',
      },
      // "对比X和Y" → "对比分析X和Y的优缺点和适用场景"
      {
        pattern: /^(?:对比|比较)\s*(.+?)\s*(?:和|与|vs)\s*(.+)$/,
        completion: (match) => `对比分析${match[1]}和${match[2]}的优缺点和适用场景`,
        description: '补全对比分析指令',
      },
      // "优化X" → "分析X的性能瓶颈并给出优化方案"
      {
        pattern: /^优化(.+?)的性能$/,
        completion: (match) => `分析${match[1]}的性能瓶颈并给出优化方案`,
        description: '补全性能优化指令',
      },
      // "学习X" → "从零开始学习X，提供学习路线和资源推荐"
      {
        pattern: /^(?:怎么学|如何学|学习)\s*(.+)$/,
        completion: (match) => `从零开始学习${match[1]}，提供学习路线和资源推荐`,
        description: '补全学习求助指令',
      },
      // "设计X的API" → "设计X的RESTful API，包括端点定义、请求响应格式和错误处理"
      {
        pattern: /^设计\s*(.+?)\s*(?:的)?API$/,
        completion: (match) => `设计${match[1]}的RESTful API，包括端点定义、请求响应格式和错误处理`,
        description: '补全API设计指令',
      },
      // "容器化X" → "为X编写Dockerfile和docker-compose配置"
      {
        pattern: /^(?:容器化|Docker化)\s*(.+)$/,
        completion: (match) => `为${match[1]}编写Dockerfile和docker-compose配置`,
        description: '补全容器化指令',
      },
    ];
  }

  /** 初始化专业术语词典 */
  private initializeTerminologyDict(): void {
    this.terminologyDict = [
      // ---- 编程术语 ----
      { term: 'API', domain: 'programming', aliases: ['接口', '应用程序接口'], description: 'Application Programming Interface' },
      { term: 'REST', domain: 'programming', aliases: ['RESTful', 'REST API'], description: 'Representational State Transfer' },
      { term: 'GraphQL', domain: 'programming', aliases: ['GQL'], description: '图查询语言' },
      { term: 'CI/CD', domain: 'programming', aliases: ['持续集成', '持续部署', 'CI', 'CD'], description: '持续集成/持续部署' },
      { term: 'DevOps', domain: 'programming', aliases: ['开发运维'], description: '开发与运维一体化' },
      { term: '微服务', domain: 'programming', aliases: ['Microservice', '微服务架构'], description: 'Microservice Architecture' },
      { term: '容器化', domain: 'programming', aliases: ['Containerization', 'Docker化'], description: '应用容器化部署' },
      { term: 'Kubernetes', domain: 'programming', aliases: ['K8s', 'k8s'], description: '容器编排平台' },
      { term: 'Docker', domain: 'programming', aliases: ['docker', '容器引擎'], description: '容器化平台' },
      { term: 'ORM', domain: 'programming', aliases: ['对象关系映射'], description: 'Object-Relational Mapping' },
      { term: 'MVC', domain: 'programming', aliases: ['Model-View-Controller'], description: '模型-视图-控制器架构' },
      { term: 'MVVM', domain: 'programming', aliases: ['Model-View-ViewModel'], description: '模型-视图-视图模型架构' },
      { term: 'SOLID', domain: 'programming', aliases: ['面向对象设计原则'], description: '面向对象设计五大原则' },
      { term: '设计模式', domain: 'programming', aliases: ['Design Pattern'], description: '软件设计中的通用解决方案' },
      { term: '递归', domain: 'programming', aliases: ['Recursion', '递归算法'], description: '函数调用自身的算法' },
      { term: '回调', domain: 'programming', aliases: ['Callback', '回调函数'], description: '作为参数传递的函数' },
      { term: 'Promise', domain: 'programming', aliases: ['异步Promise', '期约'], description: '异步编程模型' },
      { term: 'async/await', domain: 'programming', aliases: ['异步等待'], description: '异步编程语法糖' },
      { term: '闭包', domain: 'programming', aliases: ['Closure'], description: '函数与其词法环境的组合' },
      { term: '原型链', domain: 'programming', aliases: ['Prototype Chain'], description: 'JavaScript继承机制' },
      { term: 'SSR', domain: 'programming', aliases: ['服务端渲染', 'Server-Side Rendering'], description: '服务端渲染页面' },
      { term: 'SSG', domain: 'programming', aliases: ['静态站点生成', 'Static Site Generation'], description: '静态站点生成' },
      { term: 'WebSocket', domain: 'programming', aliases: ['ws', '长连接'], description: '全双工通信协议' },
      { term: 'OAuth', domain: 'programming', aliases: ['OAuth2', '授权认证'], description: '开放授权协议' },
      { term: 'JWT', domain: 'programming', aliases: ['JSON Web Token', '令牌'], description: 'JSON网络令牌' },
      { term: 'TypeScript', domain: 'programming', aliases: ['TS', 'ts'], description: 'JavaScript的类型超集' },
      { term: 'Webpack', domain: 'programming', aliases: ['webpack'], description: 'JavaScript模块打包器' },
      { term: 'Vite', domain: 'programming', aliases: ['vite'], description: '下一代前端构建工具' },
      { term: 'ESLint', domain: 'programming', aliases: ['eslint'], description: 'JavaScript代码检查工具' },
      { term: 'Prettier', domain: 'programming', aliases: ['prettier'], description: '代码格式化工具' },

      // ---- 金融术语 ----
      { term: 'IPO', domain: 'finance', aliases: ['首次公开募股', '上市'], description: 'Initial Public Offering' },
      { term: 'PE', domain: 'finance', aliases: ['市盈率', 'Price-Earnings Ratio'], description: '市盈率' },
      { term: 'PB', domain: 'finance', aliases: ['市净率'], description: '市净率' },
      { term: 'ROE', domain: 'finance', aliases: ['净资产收益率'], description: 'Return on Equity' },
      { term: 'ETF', domain: 'finance', aliases: ['交易型开放式指数基金'], description: 'Exchange-Traded Fund' },
      { term: 'GDP', domain: 'finance', aliases: ['国内生产总值'], description: 'Gross Domestic Product' },
      { term: 'CPI', domain: 'finance', aliases: ['消费者物价指数'], description: 'Consumer Price Index' },
      { term: 'LPR', domain: 'finance', aliases: ['贷款市场报价利率'], description: 'Loan Prime Rate' },
      { term: '牛市', domain: 'finance', aliases: ['Bull Market'], description: '上涨行情' },
      { term: '熊市', domain: 'finance', aliases: ['Bear Market'], description: '下跌行情' },

      // ---- 医疗术语 ----
      { term: 'CT', domain: 'medical', aliases: ['计算机断层扫描'], description: 'Computed Tomography' },
      { term: 'MRI', domain: 'medical', aliases: ['核磁共振'], description: 'Magnetic Resonance Imaging' },
      { term: 'ECG', domain: 'medical', aliases: ['心电图', 'EKG'], description: 'Electrocardiogram' },
      { term: 'B超', domain: 'medical', aliases: ['超声波检查', '超声'], description: 'B型超声波检查' },
      { term: 'ICU', domain: 'medical', aliases: ['重症监护室'], description: 'Intensive Care Unit' },
      { term: 'OTC', domain: 'medical', aliases: ['非处方药'], description: 'Over The Counter' },
      { term: 'DNA', domain: 'medical', aliases: ['脱氧核糖核酸'], description: 'Deoxyribonucleic Acid' },
      { term: 'RNA', domain: 'medical', aliases: ['核糖核酸'], description: 'Ribonucleic Acid' },
      { term: 'PCR', domain: 'medical', aliases: ['聚合酶链式反应'], description: 'Polymerase Chain Reaction' },
      { term: '血压', domain: 'medical', aliases: ['BP', 'Blood Pressure'], description: '血液对血管壁的压力' },

      // ---- AI/ML 术语 ----
      { term: 'LLM', domain: 'ai', aliases: ['大语言模型', '大模型', 'Large Language Model'], description: '大型语言模型' },
      { term: 'RAG', domain: 'ai', aliases: ['检索增强生成', 'Retrieval Augmented Generation'], description: '检索增强生成技术' },
      { term: 'Fine-tuning', domain: 'ai', aliases: ['微调', '精调', 'fine tune'], description: '模型微调技术' },
      { term: 'Prompt Engineering', domain: 'ai', aliases: ['提示工程', 'Prompt优化', '提示词工程'], description: '提示词优化技术' },
      { term: 'Embedding', domain: 'ai', aliases: ['嵌入', '向量表示', '向量化'], description: '文本向量化表示' },
      { term: 'Token', domain: 'ai', aliases: ['令牌', '词元'], description: 'LLM处理的最小文本单元' },
      { term: 'Agent', domain: 'ai', aliases: ['智能体', 'AI代理', '自主代理'], description: '自主行动的AI系统' },
      { term: 'CoT', domain: 'ai', aliases: ['思维链', 'Chain of Thought'], description: '链式思维推理' },
      { term: 'RLHF', domain: 'ai', aliases: ['人类反馈强化学习', 'Reinforcement Learning from Human Feedback'], description: '基于人类反馈的强化学习' },
      { term: 'LoRA', domain: 'ai', aliases: ['Low-Rank Adaptation', '低秩适配'], description: '参数高效微调方法' },

      // ---- 云原生术语 ----
      { term: 'Service Mesh', domain: 'cloud', aliases: ['服务网格'], description: '微服务通信基础设施层' },
      { term: 'Istio', domain: 'cloud', aliases: ['istio'], description: '开源服务网格平台' },
      { term: 'Serverless', domain: 'cloud', aliases: ['无服务器', 'FaaS'], description: '无服务器计算架构' },
      { term: 'IaC', domain: 'cloud', aliases: ['基础设施即代码', 'Infrastructure as Code'], description: '基础设施代码化管理' },
      { term: 'Terraform', domain: 'cloud', aliases: ['terraform', 'tf'], description: '基础设施即代码工具' },

      // ---- 前端术语 ----
      { term: 'SSR', domain: 'frontend', aliases: ['服务端渲染', 'Server-Side Rendering'], description: '服务端渲染技术' },
      { term: 'ISR', domain: 'frontend', aliases: ['增量静态再生', 'Incremental Static Regeneration'], description: '增量静态页面生成' },
      { term: 'Virtual DOM', domain: 'frontend', aliases: ['虚拟DOM', '虚拟文档对象模型'], description: '虚拟DOM diff算法' },
      { term: 'HMR', domain: 'frontend', aliases: ['热更新', 'Hot Module Replacement'], description: '模块热替换技术' },
      { term: 'Tree Shaking', domain: 'frontend', aliases: ['摇树优化', '死代码消除'], description: '消除未使用代码的优化技术' },
    ];
  }

  /** 初始化情感词典 */
  private initializeSentimentDict(): void {
    this.sentimentDict = [
      // ---- 积极情感 ----
      { word: '好', polarity: 0.5, urgency: 0, emotion: 'satisfied' },
      { word: '很好', polarity: 0.7, urgency: 0, emotion: 'satisfied' },
      { word: '太好了', polarity: 0.9, urgency: 0.1, emotion: 'excited' },
      { word: '棒', polarity: 0.8, urgency: 0, emotion: 'excited' },
      { word: '优秀', polarity: 0.8, urgency: 0, emotion: 'satisfied' },
      { word: '完美', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: '喜欢', polarity: 0.6, urgency: 0, emotion: 'happy' },
      { word: '感谢', polarity: 0.7, urgency: 0, emotion: 'grateful' },
      { word: '谢谢', polarity: 0.6, urgency: 0, emotion: 'grateful' },
      { word: '开心', polarity: 0.7, urgency: 0, emotion: 'happy' },
      { word: '高兴', polarity: 0.7, urgency: 0, emotion: 'happy' },
      { word: '满意', polarity: 0.6, urgency: 0, emotion: 'satisfied' },
      { word: '赞', polarity: 0.7, urgency: 0, emotion: 'excited' },
      { word: '不错', polarity: 0.5, urgency: 0, emotion: 'satisfied' },
      { word: '厉害', polarity: 0.8, urgency: 0, emotion: 'impressed' },
      { word: '牛逼', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: 'awesome', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: 'great', polarity: 0.7, urgency: 0, emotion: 'satisfied' },
      { word: 'nice', polarity: 0.6, urgency: 0, emotion: 'satisfied' },
      { word: 'love', polarity: 0.8, urgency: 0, emotion: 'happy' },

      // ---- 消极情感 ----
      { word: '差', polarity: -0.5, urgency: 0.2, emotion: 'dissatisfied' },
      { word: '很差', polarity: -0.7, urgency: 0.3, emotion: 'angry' },
      { word: '糟糕', polarity: -0.7, urgency: 0.3, emotion: 'frustrated' },
      { word: '烂', polarity: -0.8, urgency: 0.3, emotion: 'angry' },
      { word: '讨厌', polarity: -0.6, urgency: 0.2, emotion: 'disgusted' },
      { word: '烦', polarity: -0.5, urgency: 0.3, emotion: 'frustrated' },
      { word: '生气', polarity: -0.7, urgency: 0.4, emotion: 'angry' },
      { word: '失望', polarity: -0.6, urgency: 0.2, emotion: 'disappointed' },
      { word: '难过', polarity: -0.6, urgency: 0.1, emotion: 'sad' },
      { word: '伤心', polarity: -0.7, urgency: 0.1, emotion: 'sad' },
      { word: '害怕', polarity: -0.6, urgency: 0.4, emotion: 'fearful' },
      { word: '担心', polarity: -0.4, urgency: 0.3, emotion: 'anxious' },
      { word: '焦虑', polarity: -0.5, urgency: 0.5, emotion: 'anxious' },
      { word: '崩溃', polarity: -0.8, urgency: 0.6, emotion: 'desperate' },
      { word: '无语', polarity: -0.5, urgency: 0.2, emotion: 'frustrated' },
      { word: '不行', polarity: -0.5, urgency: 0.3, emotion: 'dissatisfied' },
      { word: '错误', polarity: -0.4, urgency: 0.3, emotion: 'frustrated' },
      { word: '失败', polarity: -0.6, urgency: 0.3, emotion: 'disappointed' },
      { word: 'bug', polarity: -0.3, urgency: 0.4, emotion: 'frustrated' },
      { word: '报错', polarity: -0.4, urgency: 0.5, emotion: 'frustrated' },
      { word: 'bad', polarity: -0.5, urgency: 0.2, emotion: 'dissatisfied' },
      { word: 'terrible', polarity: -0.8, urgency: 0.3, emotion: 'angry' },
      { word: 'awful', polarity: -0.7, urgency: 0.3, emotion: 'angry' },
      { word: 'hate', polarity: -0.7, urgency: 0.3, emotion: 'angry' },
      { word: 'wrong', polarity: -0.4, urgency: 0.3, emotion: 'frustrated' },
      { word: 'error', polarity: -0.3, urgency: 0.4, emotion: 'frustrated' },
      { word: 'fail', polarity: -0.5, urgency: 0.3, emotion: 'disappointed' },

      // ---- 紧迫性词汇 ----
      { word: '紧急', polarity: -0.2, urgency: 0.8, emotion: 'anxious' },
      { word: '马上', polarity: 0, urgency: 0.7, emotion: 'urgent' },
      { word: '立刻', polarity: 0, urgency: 0.8, emotion: 'urgent' },
      { word: '赶紧', polarity: 0, urgency: 0.7, emotion: 'urgent' },
      { word: '尽快', polarity: 0, urgency: 0.6, emotion: 'urgent' },
      { word: '急', polarity: -0.2, urgency: 0.7, emotion: 'anxious' },
      { word: '救命', polarity: -0.5, urgency: 0.9, emotion: 'desperate' },
      { word: '来不及', polarity: -0.4, urgency: 0.8, emotion: 'anxious' },
      { word: 'ASAP', polarity: 0, urgency: 0.8, emotion: 'urgent' },
      { word: 'urgent', polarity: -0.2, urgency: 0.8, emotion: 'urgent' },
      { word: 'now', polarity: 0, urgency: 0.6, emotion: 'urgent' },

      // ---- 更多积极情感 ----
      { word: '酷', polarity: 0.7, urgency: 0, emotion: 'excited' },
      { word: '牛', polarity: 0.8, urgency: 0, emotion: 'impressed' },
      { word: '强', polarity: 0.6, urgency: 0, emotion: 'impressed' },
      { word: '绝了', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: '优雅', polarity: 0.7, urgency: 0, emotion: 'satisfied' },
      { word: '专业', polarity: 0.6, urgency: 0, emotion: 'satisfied' },
      { word: '高效', polarity: 0.6, urgency: 0, emotion: 'satisfied' },
      { word: '简洁', polarity: 0.5, urgency: 0, emotion: 'satisfied' },
      { word: 'amazing', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: 'perfect', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: 'excellent', polarity: 0.8, urgency: 0, emotion: 'satisfied' },

      // ---- 更多消极情感 ----
      { word: '坑', polarity: -0.6, urgency: 0.2, emotion: 'frustrated' },
      { word: '离谱', polarity: -0.6, urgency: 0.2, emotion: 'angry' },
      { word: '扯淡', polarity: -0.7, urgency: 0.2, emotion: 'angry' },
      { word: '无语了', polarity: -0.6, urgency: 0.2, emotion: 'frustrated' },
      { word: '卡', polarity: -0.4, urgency: 0.4, emotion: 'frustrated' },
      { word: '慢', polarity: -0.3, urgency: 0.3, emotion: 'dissatisfied' },
      { word: '死机', polarity: -0.7, urgency: 0.6, emotion: 'angry' },
      { word: '崩溃', polarity: -0.8, urgency: 0.7, emotion: 'desperate' },
      { word: 'horrible', polarity: -0.8, urgency: 0.3, emotion: 'angry' },
      { word: 'broken', polarity: -0.6, urgency: 0.5, emotion: 'frustrated' },
      { word: 'stuck', polarity: -0.5, urgency: 0.5, emotion: 'frustrated' },
      { word: 'crash', polarity: -0.7, urgency: 0.6, emotion: 'angry' },

      // ---- 扩展正面情感 ----
      { word: '惊喜', polarity: 0.9, urgency: 0.1, emotion: 'excited' },
      { word: '感动', polarity: 0.85, urgency: 0, emotion: 'happy' },
      { word: '自豪', polarity: 0.85, urgency: 0, emotion: 'proud' },
      { word: '满足', polarity: 0.8, urgency: 0, emotion: 'satisfied' },
      { word: '期待', polarity: 0.75, urgency: 0.1, emotion: 'excited' },
      { word: '信任', polarity: 0.7, urgency: 0, emotion: 'satisfied' },
      { word: '安心', polarity: 0.75, urgency: 0, emotion: 'satisfied' },
      { word: '感激', polarity: 0.85, urgency: 0, emotion: 'grateful' },
      { word: '敬佩', polarity: 0.8, urgency: 0, emotion: 'impressed' },
      { word: '欣慰', polarity: 0.75, urgency: 0, emotion: 'satisfied' },
      { word: '优秀', polarity: 0.85, urgency: 0, emotion: 'satisfied' },
      { word: '完美', polarity: 0.9, urgency: 0, emotion: 'excited' },
      { word: '专业', polarity: 0.7, urgency: 0, emotion: 'satisfied' },
      { word: '高效', polarity: 0.75, urgency: 0, emotion: 'satisfied' },
      { word: '精准', polarity: 0.8, urgency: 0, emotion: 'satisfied' },
      { word: '靠谱', polarity: 0.75, urgency: 0, emotion: 'satisfied' },
      { word: '出色', polarity: 0.85, urgency: 0, emotion: 'excited' },

      // ---- 扩展负面情感 ----
      { word: '失望', polarity: -0.7, urgency: 0.2, emotion: 'disappointed' },
      { word: '愤怒', polarity: -0.9, urgency: 0.5, emotion: 'angry' },
      { word: '恐惧', polarity: -0.85, urgency: 0.6, emotion: 'fearful' },
      { word: '厌恶', polarity: -0.8, urgency: 0.3, emotion: 'disgusted' },
      { word: '羞耻', polarity: -0.7, urgency: 0.2, emotion: 'shameful' },
      { word: '后悔', polarity: -0.65, urgency: 0.2, emotion: 'regretful' },
      { word: '困惑', polarity: -0.5, urgency: 0.2, emotion: 'confused' },
      { word: '无聊', polarity: -0.4, urgency: 0, emotion: 'bored' },
      { word: '疲惫', polarity: -0.55, urgency: 0.2, emotion: 'tired' },
      { word: '烂', polarity: -0.85, urgency: 0.3, emotion: 'angry' },
      { word: '慢', polarity: -0.5, urgency: 0.3, emotion: 'dissatisfied' },
      { word: '错', polarity: -0.6, urgency: 0.3, emotion: 'frustrated' },
      { word: '假', polarity: -0.7, urgency: 0.2, emotion: 'angry' },
      { word: '坑', polarity: -0.75, urgency: 0.3, emotion: 'frustrated' },
      { word: '垃圾', polarity: -0.9, urgency: 0.4, emotion: 'angry' },
      { word: '离谱', polarity: -0.7, urgency: 0.2, emotion: 'angry' },
      { word: '糟糕', polarity: -0.8, urgency: 0.3, emotion: 'frustrated' },
    ];
  }

  /** 意图层级分类 - 将识别到的意图归类到更高层级的意图族 */
  classifyIntentHierarchy(intent: string): { primary: string; secondary: string; domain: string } {
    const hierarchyMap: Record<string, { primary: string; secondary: string; domain: string }> = {
      // 信息获取类
      'finance_query': { primary: 'information', secondary: 'query', domain: 'finance' },
      'medical_query': { primary: 'information', secondary: 'query', domain: 'medical' },
      'legal_query': { primary: 'information', secondary: 'query', domain: 'legal' },
      'education_query': { primary: 'information', secondary: 'query', domain: 'education' },
      'travel_query': { primary: 'information', secondary: 'query', domain: 'travel' },
      // 情感类
      'emotional_support': { primary: 'emotional', secondary: 'support', domain: 'emotional' },
      'emotional_positive': { primary: 'emotional', secondary: 'positive', domain: 'emotional' },
      // 操作类
      'code_generation': { primary: 'action', secondary: 'create', domain: 'coding' },
      'code_review': { primary: 'action', secondary: 'review', domain: 'coding' },
      'data_analysis': { primary: 'action', secondary: 'analyze', domain: 'data' },
      // 建议类
      'health_advice': { primary: 'advisory', secondary: 'health', domain: 'medical' },
      'finance_loan': { primary: 'advisory', secondary: 'finance', domain: 'finance' },
      // 段先生项目特定
      'self_evolution': { primary: 'action', secondary: 'evolve', domain: 'system' },
      'self_learning': { primary: 'action', secondary: 'learn', domain: 'system' },
      'sub_agent': { primary: 'action', secondary: 'delegate', domain: 'system' },
      'system_diagnose': { primary: 'action', secondary: 'diagnose', domain: 'system' },
      'task_planning': { primary: 'action', secondary: 'plan', domain: 'system' },
      'self_heal': { primary: 'action', secondary: 'repair', domain: 'system' },
      'personalization': { primary: 'action', secondary: 'configure', domain: 'system' },
      'memory_query': { primary: 'information', secondary: 'recall', domain: 'system' },
      'model_management': { primary: 'action', secondary: 'configure', domain: 'system' },
      'consciousness': { primary: 'information', secondary: 'status', domain: 'system' },
      'goal_management': { primary: 'action', secondary: 'track', domain: 'system' },
      'creativity_tools': { primary: 'action', secondary: 'create', domain: 'creative' },
    };

    return hierarchyMap[intent] || { primary: 'general', secondary: 'unknown', domain: 'general' };
  }

  /** 多意图检测 - 识别用户输入中包含的多个意图 */
  detectMultipleIntents(input: string): { intents: string[]; primaryIntent: string; isCompound: boolean } {
    const detectedIntents: { intent: string; confidence: number }[] = [];

    for (const rule of this.intentRules) {
      // 检查关键词匹配
      const keywordMatch = rule.keywords.some(kw => input.toLowerCase().includes(kw.toLowerCase()));
      // 检查正则模式匹配
      const patternMatch = rule.patterns.some(p => p.test(input));

      if (keywordMatch || patternMatch) {
        detectedIntents.push({ intent: rule.name, confidence: rule.confidence });
      }
    }

    // 去重并排序
    const uniqueIntents = [...new Set(detectedIntents.map(i => i.intent))];
    const sorted = uniqueIntents.sort((a, b) => {
      const confA = detectedIntents.find(i => i.intent === a)!.confidence;
      const confB = detectedIntents.find(i => i.intent === b)!.confidence;
      return confB - confA;
    });

    return {
      intents: sorted,
      primaryIntent: sorted[0] || 'general',
      isCompound: sorted.length > 1,
    };
  }
}
