/**
 * 增强自然语言理解模块 — EnhancedNLU
 *
 * 面向"段先生"自主AI智能体系统，增强NLU能力，目标提升25%+任务理解成功率。
 * 核心能力：
 * 1. 多层意图识别：关键词快速分类 → 正则模式匹配 → LLM深层理解
 * 2. 上下文消歧：利用对话上下文解决歧义引用
 * 3. 命名实体提取：文件路径、代码符号、URL、命令、技术术语、项目名
 * 4. 领域检测：coding / debugging / deployment / documentation / testing 等
 * 5. 代码查询理解：解析代码相关查询，提取目标文件、符号、动作类型
 * 6. 统计与反馈：NLU调用统计与性能追踪
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** 意图分析结果 */
export interface IntentAnalysis {
  primaryIntent: string;
  secondaryIntents: string[];
  confidence: number;
  domain: string;
  entities: Entity[];
  actionType: 'query' | 'create' | 'modify' | 'delete' | 'debug' | 'explain' | 'deploy' | 'test' | 'search' | 'general';
  complexity: 'simple' | 'moderate' | 'complex';
  requiresToolUse: boolean;
  suggestedTools: string[];
  disambiguationNeeded: boolean;
  rawInput: string;
}

/** P1-8: 深层意图理解结果 */
export interface DeepIntentResult {
  /** 表层意图：用户字面要求 */
  surface: string;
  /** 深层意图：用户真实目标 */
  deep: string;
  /** 隐含意图：未说出口的关联需求 */
  implicit: string[];
  /** 情感倾向 */
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent';
  /** 综合置信度 */
  confidence: number;
}

/** 命名实体 */
export interface Entity {
  type: 'file_path' | 'symbol' | 'url' | 'command' | 'tech_term' | 'project' | 'language' | 'framework' | 'person';
  value: string;
  position: [number, number];
  confidence: number;
}

/** 代码查询理解结果 */
export interface CodeQueryUnderstanding {
  action: string;
  targetFile?: string;
  targetSymbol?: string;
  language?: string;
  constraints: string[];
  relatedFiles: string[];
  expectedOutput: string;
}

/** 领域检测结果 */
export interface DomainResult {
  domain: string;
  confidence: number;
  alternatives: Array<{ domain: string; confidence: number }>;
}

/** 消歧结果 */
export interface DisambiguationResult {
  resolvedIntent: string;
  reasoning: string;
  confidence: number;
  candidates: string[];
}

/** NLU统计信息 */
export interface NLUStats {
  totalAnalyses: number;
  layer1Hits: number;
  layer2Hits: number;
  layer3Hits: number;
  avgConfidence: number;
  domainDistribution: Record<string, number>;
  actionTypeDistribution: Record<string, number>;
  disambiguationRate: number;
  avgProcessingTime: number;
}

// ============ 内部类型 ============

/** 关键词意图映射条目 */
interface KeywordIntentEntry {
  keywords: string[];
  intent: string;
  actionType: IntentAnalysis['actionType'];
  domain: string;
  confidence: number;
}

/** 正则模式匹配条目 */
interface PatternIntentEntry {
  pattern: RegExp;
  intent: string;
  actionType: IntentAnalysis['actionType'];
  domain: string;
  confidence: number;
  extractEntities?: (match: RegExpMatchArray) => Partial<Entity>[];
}

/** 领域关键词映射 */
interface DomainKeywordEntry {
  domain: string;
  keywords: string[];
  weight: number;
}

// ============ 关键词意图库（Layer 1：零延迟快速分类） ============

const KEYWORD_INTENT_MAP: KeywordIntentEntry[] = [
  // 编码类
  { keywords: ['写', '创建', '生成', '实现', '开发', '编写'], intent: 'code_generation', actionType: 'create', domain: 'coding', confidence: 0.7 },
  { keywords: ['修改', '更新', '编辑', '改', '变更'], intent: 'code_modification', actionType: 'modify', domain: 'coding', confidence: 0.7 },
  { keywords: ['删除', '移除', '清除', '清理'], intent: 'code_deletion', actionType: 'delete', domain: 'coding', confidence: 0.7 },
  { keywords: ['解释', '说明', '讲解', '什么意思'], intent: 'code_explanation', actionType: 'explain', domain: 'coding', confidence: 0.65 },
  // 调试类
  { keywords: ['调试', 'debug', '修bug', '排查', '报错', '错误', '异常', '崩溃'], intent: 'debugging', actionType: 'debug', domain: 'debugging', confidence: 0.75 },
  { keywords: ['修复', 'fix', '解决', '补丁'], intent: 'bug_fix', actionType: 'debug', domain: 'debugging', confidence: 0.7 },
  // 部署类
  { keywords: ['部署', 'deploy', '发布', '上线', '打包'], intent: 'deployment', actionType: 'deploy', domain: 'deployment', confidence: 0.75 },
  { keywords: ['Docker', 'K8s', '容器', '镜像'], intent: 'containerization', actionType: 'deploy', domain: 'devops', confidence: 0.7 },
  // 文档类
  { keywords: ['文档', 'README', '注释', '说明文档'], intent: 'documentation', actionType: 'create', domain: 'documentation', confidence: 0.7 },
  // 测试类
  { keywords: ['测试', 'test', '单元测试', '集成测试', '覆盖率'], intent: 'testing', actionType: 'test', domain: 'testing', confidence: 0.75 },
  // 架构类
  { keywords: ['架构', '设计模式', '系统设计', '重构'], intent: 'architecture', actionType: 'modify', domain: 'architecture', confidence: 0.65 },
  // DevOps类
  { keywords: ['CI/CD', '流水线', '自动化', '监控', '告警'], intent: 'devops', actionType: 'deploy', domain: 'devops', confidence: 0.7 },
  // 数据类
  { keywords: ['数据', '分析', '统计', '报表', '图表'], intent: 'data_analysis', actionType: 'query', domain: 'data', confidence: 0.65 },
  // 设计类
  { keywords: ['设计', 'UI', 'UX', '界面', '原型'], intent: 'design', actionType: 'create', domain: 'design', confidence: 0.6 },
  // 搜索类
  { keywords: ['搜索', '查找', '搜', '找', '查'], intent: 'search', actionType: 'search', domain: 'general', confidence: 0.6 },
  // 查询类
  { keywords: ['怎么', '如何', '为什么', '什么'], intent: 'query', actionType: 'query', domain: 'general', confidence: 0.5 },
];

// ============ 正则模式库（Layer 2：模式匹配） ============

const PATTERN_INTENT_MAP: PatternIntentEntry[] = [
  // 代码生成模式
  {
    pattern: /(?:用|使用|基于)\s*(?<language>\w+)\s*(?:写|生成|创建|开发|实现|编写)\s*(?<target>.+)/i,
    intent: 'code_generation',
    actionType: 'create',
    domain: 'coding',
    confidence: 0.85,
    extractEntities: (match) => {
      const entities: Partial<Entity>[] = [];
      const baseIdx = match.index ?? 0;
      if (match.groups?.language) {
        const idx = baseIdx + (match[0].indexOf(match.groups.language));
        entities.push({ type: 'language', value: match.groups.language, position: [idx, idx + match.groups.language.length], confidence: 0.9 });
      }
      if (match.groups?.target) {
        const idx = baseIdx + (match[0].indexOf(match.groups.target));
        entities.push({ type: 'symbol', value: match.groups.target.trim(), position: [idx, idx + match.groups.target.length], confidence: 0.75 });
      }
      return entities;
    },
  },
  // 修复bug模式
  {
    pattern: /(?:修复|fix|解决)\s*(?<target>.+?)(?:中的|里的|的)?(?:bug|错误|异常|问题)/i,
    intent: 'bug_fix',
    actionType: 'debug',
    domain: 'debugging',
    confidence: 0.9,
    extractEntities: (match) => {
      const entities: Partial<Entity>[] = [];
      const baseIdx = match.index ?? 0;
      if (match.groups?.target) {
        const idx = baseIdx + (match[0].indexOf(match.groups.target));
        entities.push({ type: 'symbol', value: match.groups.target.trim(), position: [idx, idx + match.groups.target.length], confidence: 0.8 });
      }
      return entities;
    },
  },
  // 文件操作模式
  {
    pattern: /(?<action>修复|修改|优化|重构|添加|删除)\s*(?<file>[\w\-/\\]+\.\w+)\s*(?:中的|里的)?(?<symbol>.+?)?$/i,
    intent: 'code_modification',
    actionType: 'modify',
    domain: 'coding',
    confidence: 0.88,
    extractEntities: (match) => {
      const entities: Partial<Entity>[] = [];
      const baseIdx = match.index ?? 0;
      if (match.groups?.file) {
        const idx = baseIdx + (match[0].indexOf(match.groups.file));
        entities.push({ type: 'file_path', value: match.groups.file, position: [idx, idx + match.groups.file.length], confidence: 0.9 });
      }
      if (match.groups?.symbol) {
        const idx = baseIdx + (match[0].indexOf(match.groups.symbol));
        entities.push({ type: 'symbol', value: match.groups.symbol.trim(), position: [idx, idx + match.groups.symbol.length], confidence: 0.8 });
      }
      return entities;
    },
  },
  // 部署模式
  {
    pattern: /(?:部署|deploy|发布|上线)\s*(?<target>.+?)(?:到|至)\s*(?<env>\w+)/i,
    intent: 'deployment',
    actionType: 'deploy',
    domain: 'deployment',
    confidence: 0.9,
  },
  // 测试模式
  {
    pattern: /(?:为|给|对)\s*(?<target>.+?)(?:写|编写|生成|添加|创建)\s*(?:单元|集成|端到端)?\s*测试/i,
    intent: 'testing',
    actionType: 'test',
    domain: 'testing',
    confidence: 0.88,
    extractEntities: (match) => {
      const entities: Partial<Entity>[] = [];
      const baseIdx = match.index ?? 0;
      if (match.groups?.target) {
        const idx = baseIdx + (match[0].indexOf(match.groups.target));
        entities.push({ type: 'symbol', value: match.groups.target.trim(), position: [idx, idx + match.groups.target.length], confidence: 0.8 });
      }
      return entities;
    },
  },
  // 解释代码模式
  {
    pattern: /(?:解释|说明|讲解|explain)\s*(?<target>.+?)(?:的)?(?:代码|逻辑|实现|原理|工作原理)/i,
    intent: 'code_explanation',
    actionType: 'explain',
    domain: 'coding',
    confidence: 0.85,
  },
  // 搜索模式
  {
    pattern: /(?:搜索|查找|搜|查|找)\s*(?<target>.+)/i,
    intent: 'search',
    actionType: 'search',
    domain: 'general',
    confidence: 0.8,
  },
  // 架构分析模式
  {
    pattern: /(?:分析|设计|画出|描述)\s*(?<target>.+?)(?:的)?(?:架构|结构|设计|UML|类图)/i,
    intent: 'architecture',
    actionType: 'query',
    domain: 'architecture',
    confidence: 0.85,
  },
];

// ============ 领域关键词库 ============

const DOMAIN_KEYWORD_MAP: DomainKeywordEntry[] = [
  { domain: 'coding', keywords: ['代码', '编程', '函数', '类', '方法', '变量', '模块', '接口', 'code', 'function', 'class', 'method', 'variable', 'module', 'interface', '编程', '开发', '实现', '编写'], weight: 1.0 },
  { domain: 'debugging', keywords: ['bug', '调试', 'debug', '报错', '错误', '异常', '崩溃', '排查', '修bug', 'trace', 'stack', '断点', 'crash', 'error', 'exception'], weight: 1.0 },
  { domain: 'deployment', keywords: ['部署', 'deploy', '发布', '上线', '打包', 'build', 'release', 'production', 'staging', '环境', '服务器', 'server'], weight: 1.0 },
  { domain: 'documentation', keywords: ['文档', 'README', '注释', '说明', 'API文档', '使用手册', 'doc', 'documentation', 'comment', 'guide'], weight: 0.9 },
  { domain: 'testing', keywords: ['测试', 'test', '单元测试', '集成测试', '覆盖率', 'coverage', 'mock', '断言', 'assert', 'spec'], weight: 1.0 },
  { domain: 'architecture', keywords: ['架构', '设计模式', '系统设计', '重构', 'refactor', '架构图', 'UML', '微服务', '分层', 'DDD'], weight: 0.9 },
  { domain: 'devops', keywords: ['CI/CD', '流水线', '自动化', '监控', '告警', 'Docker', 'K8s', '容器', 'pipeline', 'Jenkins', 'GitHub Actions'], weight: 1.0 },
  { domain: 'data', keywords: ['数据', '分析', '统计', '报表', '图表', 'SQL', '数据库', '查询', 'ETL', '数据仓库', 'data', 'analytics'], weight: 0.9 },
  { domain: 'design', keywords: ['设计', 'UI', 'UX', '界面', '原型', '交互', '视觉', 'Figma', 'Sketch', '设计稿'], weight: 0.8 },
  { domain: 'general', keywords: ['帮我', '请问', '你好', '谢谢', '聊天', '闲聊'], weight: 0.3 },
];

// ============ 实体提取正则 ============

const ENTITY_PATTERNS: Array<{
  type: Entity['type'];
  pattern: RegExp;
  confidence: number;
}> = [
  { type: 'file_path', pattern: /(?<!\w)([\w\-/\\]+\.(?:ts|js|py|java|go|rs|cpp|c|h|rb|php|html|css|json|xml|yaml|yml|md|txt|sql|sh|bat|tsx|jsx|vue|svelte))(?!\w)/gi, confidence: 0.9 },
  { type: 'url', pattern: /(https?:\/\/[\w\-.]+(?:\.[\w]{2,})+(?:\/[\w\-./?=&#%]*)?)/gi, confidence: 0.95 },
  { type: 'command', pattern: /(?<!\w)(npm|yarn|pnpm|pip|cargo|go|brew|apt|yum|docker|kubectl|git)\s+([\w\-@./]+)/gi, confidence: 0.85 },
  { type: 'language', pattern: /(?<!\w)(python|java|javascript|typescript|c\+\+|c#|go|golang|rust|ruby|php|swift|kotlin|scala|r|matlab|dart|lua|perl|haskell)(?!\w)/gi, confidence: 0.9 },
  { type: 'framework', pattern: /(?<!\w)(React|Vue|Angular|Svelte|Next\.js|Nuxt\.js|Express|Koa|NestJS|Django|Flask|FastAPI|Spring|Gin|Flutter|Electron|Tailwind)(?!\w)/gi, confidence: 0.85 },
  { type: 'tech_term', pattern: /(?<!\w)(API|REST|GraphQL|OAuth|JWT|WebSocket|SSR|SSG|ORM|MVC|MVVM|CI\/CD|DevOps|LLM|RAG|Agent)(?!\w)/gi, confidence: 0.8 },
  { type: 'symbol', pattern: /(?<!\w)([A-Z][a-zA-Z0-9]*(?:Manager|Handler|Service|Controller|Factory|Builder|Provider|Adapter|Strategy|Observer|Singleton|Repository|Helper|Util|Utils|Config|Module|Component|Page|View|Model|Store|Hook|Middleware))(?!\w)/g, confidence: 0.7 },
  { type: 'project', pattern: /(?<!\w)([\w-]+(?:项目|工程|仓库|repo|repository|project|app|application))(?!\w)/gi, confidence: 0.65 },
];

// ============ 代码查询动作映射 ============

const CODE_ACTION_MAP: Record<string, string> = {
  '修复': 'fix',
  '修': 'fix',
  'fix': 'fix',
  '解决': 'resolve',
  '修改': 'modify',
  '改': 'modify',
  '更新': 'update',
  '优化': 'optimize',
  '重构': 'refactor',
  '添加': 'add',
  '增加': 'add',
  '新增': 'add',
  '删除': 'remove',
  '移除': 'remove',
  '写': 'create',
  '创建': 'create',
  '生成': 'generate',
  '实现': 'implement',
  '解释': 'explain',
  '说明': 'explain',
  '测试': 'test',
  '部署': 'deploy',
  '搜索': 'search',
  '查找': 'search',
  '分析': 'analyze',
  '审查': 'review',
  '检查': 'inspect',
};

// ============ 主类 ============

export class EnhancedNLU {
  private log = logger.child({ module: 'EnhancedNLU' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelLibrary: any;
  private eventBus = EventBus.getInstance();

  // 统计计数器
  private stats = {
    totalAnalyses: 0,
    layer1Hits: 0,
    layer2Hits: 0,
    layer3Hits: 0,
    confidenceSum: 0,
    domainCounts: {} as Record<string, number>,
    actionTypeCounts: {} as Record<string, number>,
    disambiguationCount: 0,
    processingTimes: [] as number[],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary || null;
    this.log.info('EnhancedNLU 模块初始化完成', {
      layer1Rules: KEYWORD_INTENT_MAP.length,
      layer2Patterns: PATTERN_INTENT_MAP.length,
      domainCount: DOMAIN_KEYWORD_MAP.length,
      entityPatterns: ENTITY_PATTERNS.length,
    });
  }

  // ============ 核心方法：多层意图分析 ============

  /**
   * 多层意图分析
   * Layer 1: 关键词快速分类（零延迟）
   * Layer 2: 正则模式匹配（带实体提取）
   * Layer 3: LLM深层理解（当1-2层置信度不足时触发）
   */
  async analyzeIntent(input: string, context?: string[]): Promise<IntentAnalysis> {
    const startTime = Date.now();
    this.stats.totalAnalyses++;

    this.log.debug('开始意图分析', { input: input.substring(0, 100), contextLength: context?.length || 0 });

    // Layer 1: 关键词快速分类
    const layer1Result = this.classifyByKeywords(input);
    if (layer1Result.confidence >= 0.85) {
      this.stats.layer1Hits++;
      const result = this.buildIntentAnalysis(input, layer1Result, context);
      this.recordStats(result, Date.now() - startTime);
      this.emitAnalysisEvent(result);
      return result;
    }

    // Layer 2: 正则模式匹配
    const layer2Result = this.classifyByPatterns(input);
    if (layer2Result.confidence >= 0.8) {
      this.stats.layer2Hits++;
      // 合并Layer 1和Layer 2的结果
      const merged = this.mergeLayerResults(layer1Result, layer2Result);
      const result = this.buildIntentAnalysis(input, merged, context);
      this.recordStats(result, Date.now() - startTime);
      this.emitAnalysisEvent(result);
      return result;
    }

    // Layer 3: LLM深层理解
    this.stats.layer3Hits++;
    const layer3Result = await this.classifyByLLM(input, context);
    const merged = this.mergeLayerResults(
      this.mergeLayerResults(layer1Result, layer2Result),
      layer3Result
    );
    const result = this.buildIntentAnalysis(input, merged, context);
    this.recordStats(result, Date.now() - startTime);
    this.emitAnalysisEvent(result);
    return result;
  }

  /**
   * P1-8: 深层意图理解 — 多层意图识别
   *
   * 1. 表层意图：用户字面要求
   * 2. 深层意图：用户真实目标（如"今天天气"→ 想知道是否带伞）
   * 3. 隐含意图：未说出口的关联需求
   * 4. 情感识别：文本情感分析
   */
  async understandDeepIntent(input: string, context?: string[]): Promise<DeepIntentResult> {
    // 先做基础意图分析
    const baseAnalysis = await this.analyzeIntent(input, context);

    // 推断深层意图：基于表层意图 + 实体 + 上下文
    const deep = this.inferDeepIntent(baseAnalysis, context);

    // 识别隐含需求：完成任务必需但未说出的步骤
    const implicit = this.identifyImplicitNeeds(baseAnalysis, deep);

    // 情感分析
    const sentiment = this.analyzeSentiment(input);

    return {
      surface: baseAnalysis.primaryIntent,
      deep,
      implicit,
      sentiment,
      confidence: baseAnalysis.confidence,
    };
  }

  /** 推断深层意图：从表层意图推导用户真实目标 */
  private inferDeepIntent(analysis: IntentAnalysis, _context?: string[]): string {
    const surfaceToDeep: Record<string, string> = {
      'search': '获取信息以做决策',
      'code_generation': '解决具体业务问题',
      'bug_fix': '恢复系统正常运行',
      'code_review': '确保代码质量与可维护性',
      'explanation': '理解技术原理以自主决策',
      'deployment': '让功能上线供用户使用',
      'testing': '验证功能正确性以降低风险',
      'refactoring': '提升开发效率与代码可维护性',
    };
    return surfaceToDeep[analysis.primaryIntent] || analysis.primaryIntent;
  }

  /** 识别隐含需求：完成任务必需但未说出的步骤 */
  private identifyImplicitNeeds(analysis: IntentAnalysis, _deepIntent: string): string[] {
    const needs: string[] = [];
    // 根据 actionType 推断隐含需求
    switch (analysis.actionType) {
      case 'create':
        needs.push('选择技术栈', '设计结构', '编写代码', '测试验证');
        break;
      case 'modify':
        needs.push('理解现有代码', '定位修改点', '验证修改不影响其他功能');
        break;
      case 'debug':
        needs.push('复现问题', '定位根因', '修复并验证');
        break;
      case 'deploy':
        needs.push('构建产物', '配置环境', '验证部署成功');
        break;
      case 'test':
        needs.push('设计测试用例', '执行测试', '分析结果');
        break;
    }
    // 复杂任务需要规划
    if (analysis.complexity === 'complex') {
      needs.unshift('任务分解与规划');
    }
    return needs;
  }

  /**
   * 增强情感分析（多维度）
   *
   * 分析维度：
   * 1. 情感词词典匹配（带权重，扩展词库）
   * 2. 否定词处理（"不好"→负向，"不错"→正向）
   * 3. 程度副词修饰（"非常"/"有点" 调整强度）
   * 4. 标点符号分析（！/？/。。。 表达情绪强度）
   * 5. 表情符号识别（😊👍😡 等）
   * 6. 紧急度检测（时间压力词）
   */
  private analyzeSentiment(input: string): 'positive' | 'neutral' | 'negative' | 'urgent' {
    const lower = input.toLowerCase();

    // === 1. 紧急度检测（优先级最高，时间压力词触发） ===
    const urgentWords = [
      '紧急', '马上', '立刻', '快', '尽快', '赶紧', '急', '速',
      'urgent', 'asap', 'immediately', 'quickly', 'now', 'critical',
    ];
    let urgentScore = 0;
    for (const w of urgentWords) {
      if (lower.includes(w)) urgentScore += 2;
    }
    // 标点增强紧急度：多个感叹号
    const exclamationCount = (input.match(/!/g) || []).length;
    if (exclamationCount >= 2) urgentScore += 1;
    // 全大写单词（英文强调）
    const upperWords = input.match(/\b[A-Z]{3,}\b/g);
    if (upperWords && upperWords.length > 0) urgentScore += 1;

    if (urgentScore >= 3) return 'urgent';

    // === 2. 情感词评分（带权重的扩展词库） ===
    const positiveWords: Array<[string, number]> = [
      ['好的', 1], ['不错', 1.5], ['好', 0.5], ['成功', 2], ['完美', 2.5],
      ['很好', 2], ['太棒了', 3], ['感谢', 1.5], ['谢谢', 1.5], ['赞', 1.5],
      ['对了', 1], ['解决了', 2], ['可以', 0.5], ['好的呀', 1.5], ['棒', 2],
      ['优秀', 2.5], ['满意', 2], ['喜欢', 1.5], ['厉害', 2],
      ['great', 2], ['good', 1], ['nice', 1.5], ['perfect', 2.5], ['awesome', 2.5],
      ['excellent', 2.5], ['thanks', 1.5], ['solved', 2], ['works', 1.5],
      ['love', 2], ['like', 1], ['correct', 1.5], ['right', 1],
    ];
    const negativeWords: Array<[string, number]> = [
      ['错误', 2], ['失败', 2], ['问题', 1.5], ['bug', 2], ['崩溃', 3],
      ['不行', 1.5], ['不好', 1.5], ['坏了', 2], ['卡', 1], ['慢', 1],
      ['烦', 1.5], ['讨厌', 2], ['失望', 2.5], ['糟糕', 2.5], ['错了', 2],
      ['不行了', 2], ['没法', 1.5], ['不能', 1], ['不可以', 1.5], ['无效', 1.5],
      ['异常', 2], ['报错', 2.5], ['卡死', 3], ['死机', 3], ['闪退', 3],
      ['error', 2], ['fail', 2], ['failed', 2], ['broken', 2.5], ['wrong', 1.5],
      ['bad', 1.5], ['terrible', 2.5], ['hate', 2], ['stupid', 2], ['crash', 2.5],
      ['invalid', 1.5], ['unable', 1.5], ['cannot', 1.5], ["can't", 1.5],
    ];

    // === 3. 否定词处理 ===
    // 否定词 + 正向词 = 负向；否定词 + 负向词 = 双重否定（弱正向）
    const negationWords = ['不', '没', '无', '非', '别', '勿', '未', 'not', 'no', "n't", 'without'];
    // 程度副词（修饰后续情感词强度）
    const intensifiers: Array<[string, number]> = [
      ['非常', 1.8], ['特别', 1.8], ['极其', 2.0], ['太', 1.5], ['十分', 1.8],
      ['相当', 1.5], ['格外', 1.6], ['尤其', 1.5], ['有点', 0.6], ['稍微', 0.5],
      ['略微', 0.5], ['颇', 1.3],
      ['very', 1.8], ['extremely', 2.0], ['really', 1.5], ['quite', 1.3],
      ['slightly', 0.5], ['a bit', 0.6], ['somewhat', 0.7],
    ];

    let positiveScore = 0;
    let negativeScore = 0;

    // 检测正向词（考虑前置否定和程度副词）
    for (const [word, weight] of positiveWords) {
      let idx = lower.indexOf(word);
      while (idx !== -1) {
        // 检查前 6 个字符是否有否定词或程度副词
        const prefix = lower.substring(Math.max(0, idx - 6), idx);
        const hasNegation = negationWords.some(n => prefix.includes(n));
        const intensifierMultiplier = intensifiers
          .filter(([iw]) => prefix.includes(iw))
          .reduce((max, [, m]) => Math.max(max, m), 1);

        if (hasNegation) {
          // 否定正向词 → 负向（强度减半，因双重否定可能存在）
          negativeScore += weight * 0.8 * intensifierMultiplier;
        } else {
          positiveScore += weight * intensifierMultiplier;
        }
        idx = lower.indexOf(word, idx + word.length);
      }
    }

    // 检测负向词（考虑前置否定和程度副词）
    for (const [word, weight] of negativeWords) {
      let idx = lower.indexOf(word);
      while (idx !== -1) {
        const prefix = lower.substring(Math.max(0, idx - 6), idx);
        const hasNegation = negationWords.some(n => prefix.includes(n));
        const intensifierMultiplier = intensifiers
          .filter(([iw]) => prefix.includes(iw))
          .reduce((max, [, m]) => Math.max(max, m), 1);

        if (hasNegation) {
          // 否定负向词 → 弱正向（"不错"="好"但强度较低）
          positiveScore += weight * 0.6 * intensifierMultiplier;
        } else {
          negativeScore += weight * intensifierMultiplier;
        }
        idx = lower.indexOf(word, idx + word.length);
      }
    }

    // === 4. 表情符号情感识别 ===
    const positiveEmojis = ['😊', '😄', '😃', '👍', '🙌', '💪', '✨', '🎉', '❤️', '😍', '🤝', '😎', '🙂'];
    const negativeEmojis = ['😡', '😠', '😞', '😢', '😭', '👎', '💔', '😤', '😩', '🤦', '😒', '😣'];
    for (const e of positiveEmojis) {
      if (input.includes(e)) positiveScore += 2;
    }
    for (const e of negativeEmojis) {
      if (input.includes(e)) negativeScore += 2;
    }

    // === 5. 标点符号情绪强度 ===
    // 连续问号表示困惑/不满
    const questionMarks = (input.match(/\?{2,}/g) || (input.match(/？{2,}/g) || []));
    if (questionMarks.length > 0) negativeScore += questionMarks.length * 0.5;
    // 省略号表示无奈/犹豫
    if (input.includes('...') || input.includes('。。。')) negativeScore += 0.5;

    // === 6. 综合判定 ===
    const totalScore = positiveScore + negativeScore;
    if (totalScore === 0) {
      // 无情感词，但若有紧急词则仍判为 urgent
      if (urgentScore > 0) return 'urgent';
      return 'neutral';
    }

    // 紧急度高且负向 → urgent
    if (urgentScore >= 2 && negativeScore > positiveScore) return 'urgent';

    const sentimentValue = positiveScore - negativeScore;
    // 阈值：差异需达到一定幅度才判定为非中性
    const threshold = Math.max(1, totalScore * 0.2);

    if (sentimentValue > threshold) return 'positive';
    if (sentimentValue < -threshold) return 'negative';

    // 分数接近，判定为中性（混合情感）
    return 'neutral';
  }

  // ============ Layer 1: 关键词快速分类 ============

  private classifyByKeywords(input: string): {
    intent: string;
    confidence: number;
    actionType: IntentAnalysis['actionType'];
    domain: string;
    entities: Entity[];
  } {
    const normalizedInput = input.toLowerCase();
    let bestMatch: { intent: string; confidence: number; actionType: IntentAnalysis['actionType']; domain: string } | null = null;
    let bestScore = 0;

    for (const entry of KEYWORD_INTENT_MAP) {
      let matchCount = 0;
      for (const keyword of entry.keywords) {
        if (normalizedInput.includes(keyword.toLowerCase())) {
          matchCount++;
        }
      }
      if (matchCount === 0) continue;

      // 匹配关键词数量越多，置信度越高
      const matchRatio = matchCount / entry.keywords.length;
      const score = entry.confidence * (0.5 + 0.5 * matchRatio);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          intent: entry.intent,
          confidence: Math.min(score, 0.95),
          actionType: entry.actionType,
          domain: entry.domain,
        };
      }
    }

    return {
      intent: bestMatch?.intent || 'general',
      confidence: bestMatch?.confidence || 0.2,
      actionType: bestMatch?.actionType || 'general',
      domain: bestMatch?.domain || 'general',
      entities: [],
    };
  }

  // ============ Layer 2: 正则模式匹配 ============

  private classifyByPatterns(input: string): {
    intent: string;
    confidence: number;
    actionType: IntentAnalysis['actionType'];
    domain: string;
    entities: Entity[];
  } {
    let bestMatch: {
      intent: string;
      confidence: number;
      actionType: IntentAnalysis['actionType'];
      domain: string;
      entities: Entity[];
    } | null = null;

    for (const entry of PATTERN_INTENT_MAP) {
      const match = input.match(entry.pattern);
      if (!match) continue;

      // 从匹配中提取实体
      const extractedEntities: Entity[] = [];
      if (entry.extractEntities && match.index !== undefined) {
        const partialEntities = entry.extractEntities(match);
        for (const pe of partialEntities) {
          if (pe.value && pe.position) {
            extractedEntities.push({
              type: pe.type!,
              value: pe.value,
              position: pe.position,
              confidence: pe.confidence ?? 0.8,
            });
          }
        }
      }

      if (!bestMatch || entry.confidence > bestMatch.confidence) {
        bestMatch = {
          intent: entry.intent,
          confidence: entry.confidence,
          actionType: entry.actionType,
          domain: entry.domain,
          entities: extractedEntities,
        };
      }
    }

    return {
      intent: bestMatch?.intent || 'general',
      confidence: bestMatch?.confidence || 0.1,
      actionType: bestMatch?.actionType || 'general',
      domain: bestMatch?.domain || 'general',
      entities: bestMatch?.entities || [],
    };
  }

  // ============ Layer 3: LLM深层理解 ============

  private async classifyByLLM(input: string, context?: string[]): Promise<{
    intent: string;
    confidence: number;
    actionType: IntentAnalysis['actionType'];
    domain: string;
    entities: Entity[];
  }> {
    // 如果没有ModelLibrary，返回低置信度默认结果
    if (!this.modelLibrary || typeof this.modelLibrary.call !== 'function') {
      this.log.warn('ModelLibrary不可用，Layer 3 LLM分析跳过');
      return {
        intent: 'general',
        confidence: 0.3,
        actionType: 'general',
        domain: 'general',
        entities: [],
      };
    }

    try {
      const contextStr = context && context.length > 0
        ? `\n\n对话上下文:\n${context.slice(-3).map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        : '';

      const systemPrompt = `你是一个自然语言理解专家。分析用户输入，返回JSON格式的意图分析结果。
必须返回以下JSON结构（不要包含其他内容）：
{
  "primaryIntent": "意图名称（如code_generation, bug_fix, deployment, testing, search, query, general等）",
  "confidence": 0.0到1.0的置信度,
  "actionType": "query/create/modify/delete/debug/explain/deploy/test/search/general之一",
  "domain": "coding/debugging/deployment/documentation/testing/architecture/devops/data/design/general之一",
  "entities": [{"type":"file_path/symbol/url/command/tech_term/project/language/framework","value":"实体值","confidence":0.0到1.0}],
  "secondaryIntents": ["次要意图1", "次要意图2"],
  "complexity": "simple/moderate/complex",
  "requiresToolUse": true或false,
  "suggestedTools": ["工具1", "工具2"]
}`;

      const response = await this.modelLibrary.call([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `分析以下用户输入：\n${input}${contextStr}` },
      ], { maxTokens: 1024, temperature: 0.1 });

      const content = response.content || '';
      // 提取JSON部分
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.log.warn('LLM返回非JSON格式，Layer 3分析失败', { content: content.substring(0, 200) });
        return { intent: 'general', confidence: 0.3, actionType: 'general', domain: 'general', entities: [] };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const entities: Entity[] = (parsed.entities || []).map((e: { type?: string; value?: unknown; confidence?: unknown }) => ({
        type: e.type as Entity['type'],
        value: String(e.value),
        position: this.findEntityPosition(input, String(e.value)),
        confidence: Number(e.confidence) || 0.7,
      }));

      return {
        intent: parsed.primaryIntent || 'general',
        confidence: Math.min(Number(parsed.confidence) || 0.5, 0.95),
        actionType: parsed.actionType || 'general',
        domain: parsed.domain || 'general',
        entities,
      };
    } catch (err: unknown) {
      this.log.error('Layer 3 LLM分析失败', { error: (err instanceof Error ? err.message : String(err)) });
      return { intent: 'general', confidence: 0.25, actionType: 'general', domain: 'general', entities: [] };
    }
  }

  // ============ 上下文消歧 ============

  /**
   * 上下文消歧：利用对话上下文解决歧义引用
   * 当多个候选意图存在时，使用LLM进行深层消歧
   */
  async disambiguate(input: string, candidates: string[]): Promise<DisambiguationResult> {
    this.log.debug('执行消歧', { input: input.substring(0, 80), candidates });

    // 如果只有一个候选，直接返回
    if (candidates.length <= 1) {
      return {
        resolvedIntent: candidates[0] || 'general',
        reasoning: '仅有一个候选意图，无需消歧',
        confidence: 0.9,
        candidates,
      };
    }

    // 基于规则的快速消歧
    const ruleBasedResult = this.ruleBasedDisambiguate(input, candidates);
    if (ruleBasedResult.confidence >= 0.8) {
      this.stats.disambiguationCount++;
      return ruleBasedResult;
    }

    // LLM辅助消歧
    if (this.modelLibrary && typeof this.modelLibrary.call === 'function') {
      try {
        const response = await this.modelLibrary.call([
          {
            role: 'system',
            content: '你是一个语义消歧专家。根据用户输入，从候选意图中选择最匹配的意图，并给出推理过程。返回JSON：{"resolvedIntent":"选中的意图","reasoning":"推理过程","confidence":0.0到1.0}',
          },
          {
            role: 'user',
            content: `用户输入: ${input}\n候选意图: ${candidates.join(', ')}\n请选择最匹配的意图。`,
          },
        ], { maxTokens: 512, temperature: 0.1 });

        const content = response.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          this.stats.disambiguationCount++;
          return {
            resolvedIntent: parsed.resolvedIntent || candidates[0],
            reasoning: parsed.reasoning || 'LLM消歧',
            confidence: Math.min(Number(parsed.confidence) || 0.7, 0.95),
            candidates,
          };
        }
      } catch (err: unknown) {
        this.log.error('LLM消歧失败，回退到规则消歧', { error: (err instanceof Error ? err.message : String(err)) });
      }
    }

    // 回退：返回第一个候选
    this.stats.disambiguationCount++;
    return {
      resolvedIntent: candidates[0],
      reasoning: '无法确定最佳候选，回退到默认选择',
      confidence: 0.4,
      candidates,
    };
  }

  /** 基于规则的快速消歧 */
  private ruleBasedDisambiguate(input: string, candidates: string[]): DisambiguationResult {
    const normalizedInput = input.toLowerCase();

    // 为每个候选计算匹配分数
    const scored = candidates.map(candidate => {
      let score = 0;
      // 在关键词库中查找匹配
      for (const entry of KEYWORD_INTENT_MAP) {
        if (entry.intent === candidate) {
          for (const keyword of entry.keywords) {
            if (normalizedInput.includes(keyword.toLowerCase())) {
              score += 0.2;
            }
          }
        }
      }
      // 在模式库中查找匹配
      for (const entry of PATTERN_INTENT_MAP) {
        if (entry.intent === candidate && entry.pattern.test(input)) {
          score += 0.4;
        }
      }
      return { candidate, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const secondBest = scored.length > 1 ? scored[1] : null;

    // 如果最佳候选明显领先
    const gap = secondBest ? best.score - secondBest.score : best.score;
    if (gap > 0.15 && best.score > 0) {
      return {
        resolvedIntent: best.candidate,
        reasoning: `基于关键词和模式匹配，"${best.candidate}"得分最高(${best.score.toFixed(2)})`,
        confidence: Math.min(0.5 + best.score, 0.95),
        candidates,
      };
    }

    return {
      resolvedIntent: best.candidate,
      reasoning: '候选意图得分接近，消歧置信度较低',
      confidence: 0.5,
      candidates,
    };
  }

  // ============ 命名实体提取 ============

  /**
   * 从输入中提取命名实体
   * 支持类型：file_path, symbol, url, command, tech_term, project, language, framework, person
   */
  extractEntities(input: string): Entity[] {
    const entities: Entity[] = [];

    for (const { type, pattern, confidence } of ENTITY_PATTERNS) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(input)) !== null) {
        const value = match[1] || match[0];
        // 去重检查
        const isDuplicate = entities.some(
          e => e.value === value && e.type === type
        );
        if (!isDuplicate) {
          entities.push({
            type,
            value,
            position: [match.index, match.index + value.length],
            confidence,
          });
        }
      }
    }

    // 按位置排序
    entities.sort((a, b) => a.position[0] - b.position[0]);

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
      if (curr.position[0] < prev.position[1]) {
        if (curr.confidence > prev.confidence) {
          result[result.length - 1] = curr;
        }
      } else {
        result.push(curr);
      }
    }
    return result;
  }

  // ============ 领域检测 ============

  /**
   * 检测输入所属领域
   * 支持：coding, debugging, deployment, documentation, testing, architecture, devops, data, design, general
   */
  detectDomain(input: string): DomainResult {
    const normalizedInput = input.toLowerCase();
    const domainScores: Array<{ domain: string; confidence: number }> = [];

    for (const entry of DOMAIN_KEYWORD_MAP) {
      let score = 0;
      for (const keyword of entry.keywords) {
        if (normalizedInput.includes(keyword.toLowerCase())) {
          score += entry.weight;
        }
      }
      if (score > 0) {
        // 归一化：最多匹配的关键词数量
        const maxPossible = entry.keywords.length * entry.weight;
        const normalized = Math.min(score / maxPossible, 1.0);
        domainScores.push({ domain: entry.domain, confidence: 0.4 + normalized * 0.55 });
      }
    }

    // 排序
    domainScores.sort((a, b) => b.confidence - a.confidence);

    if (domainScores.length === 0) {
      return {
        domain: 'general',
        confidence: 0.5,
        alternatives: [],
      };
    }

    return {
      domain: domainScores[0].domain,
      confidence: domainScores[0].confidence,
      alternatives: domainScores.slice(1, 4),
    };
  }

  // ============ 代码查询理解 ============

  /**
   * 专门解析代码相关查询
   * 例如："fix the bug in auth.ts", "add error handling to the login function"
   */
  understandCodeQuery(input: string): CodeQueryUnderstanding {
    const normalizedInput = input.toLowerCase();

    // 提取动作类型
    let action = 'analyze';
    for (const [keyword, act] of Object.entries(CODE_ACTION_MAP)) {
      if (normalizedInput.includes(keyword.toLowerCase())) {
        action = act;
        break;
      }
    }

    // 提取目标文件
    let targetFile: string | undefined;
    const fileMatch = input.match(/([\w\-/\\]+\.(?:ts|js|py|java|go|rs|cpp|c|h|rb|php|html|css|json|yaml|yml|md|sql|sh|tsx|jsx|vue|svelte))/i);
    if (fileMatch) {
      targetFile = fileMatch[1];
    }

    // 提取目标符号（函数名、类名等）
    let targetSymbol: string | undefined;
    const symbolPatterns = [
      /(?:函数|function|方法|method)\s+(?:名为|叫)?\s*(\w+)/i,
      /(?:类|class)\s+(?:名为|叫)?\s*(\w+)/i,
      /(?:变量|variable)\s+(?:名为|叫)?\s*(\w+)/i,
      /(?:模块|module)\s+(?:名为|叫)?\s*(\w+)/i,
      /(?:the\s+)?(\w+)\s*(?:function|method|class|module|variable)/i,
      /(?:in|在|里的?)\s*(?:the\s+)?(\w+)\s*(?:function|method|class)/i,
    ];
    for (const pattern of symbolPatterns) {
      const match = input.match(pattern);
      if (match) {
        targetSymbol = match[1];
        break;
      }
    }

    // 提取编程语言
    let language: string | undefined;
    const langMatch = input.match(/(python|java|javascript|typescript|c\+\+|c#|go|golang|rust|ruby|php|swift|kotlin|scala|r|dart)/i);
    if (langMatch) {
      language = langMatch[1];
    }

    // 提取约束条件
    const constraints: string[] = [];
    const constraintPatterns = [
      { pattern: /(?:使用|using|用)\s*(\w+)/i, prefix: '使用' },
      { pattern: /(?:不包含|exclude|without)\s*(\w+)/i, prefix: '不包含' },
      { pattern: /(?:必须|must|should)\s*(?:包含|include|have)\s*(\w+)/i, prefix: '必须包含' },
      { pattern: /(?:遵循|follow|按照)\s*([\w-]+)/i, prefix: '遵循' },
      { pattern: /(?:兼容|compatible)\s*([\w.-]+)/i, prefix: '兼容' },
    ];
    for (const { pattern, prefix } of constraintPatterns) {
      const match = input.match(pattern);
      if (match) {
        constraints.push(`${prefix}${match[1]}`);
      }
    }

    // 提取相关文件
    const relatedFiles: string[] = [];
    const filePattern = /([\w\-/\\]+\.(?:ts|js|py|java|go|rs|cpp|c|h|rb|php|html|css|json|yaml|yml|sql|tsx|jsx|vue|svelte))/gi;
    let fileMatchIter: RegExpExecArray | null;
    while ((fileMatchIter = filePattern.exec(input)) !== null) {
      const file = fileMatchIter[1];
      if (file !== targetFile && !relatedFiles.includes(file)) {
        relatedFiles.push(file);
      }
    }

    // 推断预期输出
    const expectedOutput = this.inferExpectedOutput(action, targetFile, targetSymbol);

    return {
      action,
      targetFile,
      targetSymbol,
      language,
      constraints,
      relatedFiles,
      expectedOutput,
    };
  }

  /** 推断代码查询的预期输出 */
  private inferExpectedOutput(action: string, targetFile?: string, targetSymbol?: string): string {
    const target = targetSymbol || targetFile || '代码';
    const outputMap: Record<string, string> = {
      fix: `修复${target}中的问题，确保功能正常运行`,
      resolve: `解决${target}中的问题，提供修复方案`,
      modify: `修改${target}的实现，满足需求变更`,
      update: `更新${target}，保持功能一致性`,
      optimize: `优化${target}的性能或结构`,
      refactor: `重构${target}，提升代码质量`,
      add: `为${target}添加新功能或特性`,
      remove: `从${target}中移除指定内容`,
      create: `创建${target}，实现所需功能`,
      generate: `生成${target}的代码实现`,
      implement: `实现${target}的功能逻辑`,
      explain: `提供${target}的详细解释说明`,
      test: `为${target}编写测试用例`,
      deploy: `部署${target}到目标环境`,
      search: `搜索与${target}相关的信息`,
      analyze: `分析${target}的结构和逻辑`,
      review: `审查${target}的代码质量`,
      inspect: `检查${target}的详细情况`,
    };
    return outputMap[action] || `处理${target}相关任务`;
  }

  // ============ 统计信息 ============

  /** 获取NLU统计信息 */
  getStats(): NLUStats {
    const total = this.stats.totalAnalyses || 1;
    const avgConfidence = this.stats.confidenceSum / total;
    const processingTimes = this.stats.processingTimes;
    const avgProcessingTime = processingTimes.length > 0
      ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
      : 0;

    return {
      totalAnalyses: this.stats.totalAnalyses,
      layer1Hits: this.stats.layer1Hits,
      layer2Hits: this.stats.layer2Hits,
      layer3Hits: this.stats.layer3Hits,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      domainDistribution: { ...this.stats.domainCounts },
      actionTypeDistribution: { ...this.stats.actionTypeCounts },
      disambiguationRate: this.stats.disambiguationCount / total,
      avgProcessingTime: Math.round(avgProcessingTime),
    };
  }

  // ============ 辅助方法 ============

  /** 合并多层分析结果 */
  private mergeLayerResults(
    a: { intent: string; confidence: number; actionType: IntentAnalysis['actionType']; domain: string; entities: Entity[] },
    b: { intent: string; confidence: number; actionType: IntentAnalysis['actionType']; domain: string; entities: Entity[] }
  ): { intent: string; confidence: number; actionType: IntentAnalysis['actionType']; domain: string; entities: Entity[] } {
    // 取置信度更高的结果
    if (b.confidence > a.confidence) {
      return {
        intent: b.intent,
        confidence: b.confidence,
        actionType: b.actionType,
        domain: b.domain,
        entities: this.mergeEntities(a.entities, b.entities),
      };
    }
    return {
      intent: a.intent,
      confidence: a.confidence,
      actionType: a.actionType,
      domain: a.domain,
      entities: this.mergeEntities(a.entities, b.entities),
    };
  }

  /** 合并实体列表（去重） */
  private mergeEntities(a: Entity[], b: Entity[]): Entity[] {
    const seen = new Set<string>();
    const result: Entity[] = [];
    for (const e of [...a, ...b]) {
      const key = `${e.type}:${e.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(e);
      }
    }
    return result;
  }

  /** 构建最终的IntentAnalysis结果 */
  private buildIntentAnalysis(
    input: string,
    layerResult: { intent: string; confidence: number; actionType: IntentAnalysis['actionType']; domain: string; entities: Entity[] },
    _context?: string[]
  ): IntentAnalysis {
    // 提取实体（如果Layer结果中没有，则独立提取）
    const entities = layerResult.entities.length > 0
      ? layerResult.entities
      : this.extractEntities(input);

    // 领域检测
    const domainResult = this.detectDomain(input);
    const domain = layerResult.domain !== 'general' ? layerResult.domain : domainResult.domain;

    // 确定次要意图
    const secondaryIntents = this.findSecondaryIntents(input, layerResult.intent);

    // 确定复杂度
    const complexity = this.assessComplexity(input, entities, secondaryIntents);

    // 确定是否需要工具
    const requiresToolUse = this.assessToolRequirement(layerResult.intent, entities);

    // 推荐工具
    const suggestedTools = this.suggestTools(layerResult.intent, entities);

    // 是否需要消歧
    const disambiguationNeeded = layerResult.confidence < 0.6 && secondaryIntents.length > 0;

    return {
      primaryIntent: layerResult.intent,
      secondaryIntents,
      confidence: layerResult.confidence,
      domain,
      entities,
      actionType: layerResult.actionType,
      complexity,
      requiresToolUse,
      suggestedTools,
      disambiguationNeeded,
      rawInput: input,
    };
  }

  /** 查找次要意图 */
  private findSecondaryIntents(input: string, primaryIntent: string): string[] {
    const secondary: string[] = [];
    const normalizedInput = input.toLowerCase();

    for (const entry of KEYWORD_INTENT_MAP) {
      if (entry.intent === primaryIntent) continue;
      for (const keyword of entry.keywords) {
        if (normalizedInput.includes(keyword.toLowerCase())) {
          if (!secondary.includes(entry.intent)) {
            secondary.push(entry.intent);
          }
          break;
        }
      }
    }

    return secondary.slice(0, 3);
  }

  /** 评估复杂度 */
  private assessComplexity(input: string, entities: Entity[], secondaryIntents: string[]): 'simple' | 'moderate' | 'complex' {
    let score = 0;

    // 输入长度
    if (input.length > 200) score += 2;
    else if (input.length > 50) score += 1;

    // 实体数量
    if (entities.length > 5) score += 2;
    else if (entities.length > 2) score += 1;

    // 次要意图
    score += secondaryIntents.length;

    // 多文件引用
    const fileEntities = entities.filter(e => e.type === 'file_path');
    if (fileEntities.length > 2) score += 2;
    else if (fileEntities.length > 1) score += 1;

    if (score >= 5) return 'complex';
    if (score >= 2) return 'moderate';
    return 'simple';
  }

  /** 评估是否需要工具 */
  private assessToolRequirement(intent: string, entities: Entity[]): boolean {
    const toolRequiredIntents = [
      'code_generation', 'code_modification', 'bug_fix', 'deployment',
      'testing', 'debugging', 'search', 'containerization',
    ];
    if (toolRequiredIntents.includes(intent)) return true;

    // 有文件路径或命令实体时通常需要工具
    if (entities.some(e => e.type === 'file_path' || e.type === 'command')) return true;

    return false;
  }

  /** 推荐工具 */
  private suggestTools(intent: string, entities: Entity[]): string[] {
    const toolMap: Record<string, string[]> = {
      code_generation: ['code-editor', 'compiler'],
      code_modification: ['code-editor', 'code-analyzer'],
      bug_fix: ['debugger', 'code-analyzer'],
      debugging: ['debugger', 'logger', 'code-analyzer'],
      deployment: ['terminal', 'docker'],
      testing: ['test-runner', 'coverage'],
      documentation: ['doc-generator'],
      architecture: ['code-analyzer', 'diagram'],
      devops: ['terminal', 'docker', 'ci-cd'],
      data_analysis: ['data-analyzer', 'chart'],
      search: ['web-search', 'browser'],
      containerization: ['docker', 'terminal'],
    };

    const tools = [...(toolMap[intent] || [])];

    // 根据实体补充工具
    for (const entity of entities) {
      if (entity.type === 'url') tools.push('browser');
      if (entity.type === 'file_path') tools.push('file-system');
      if (entity.type === 'command') tools.push('terminal');
    }

    // 去重
    return [...new Set(tools)];
  }

  /** 在输入文本中查找实体位置 */
  private findEntityPosition(input: string, value: string): [number, number] {
    const idx = input.indexOf(value);
    if (idx >= 0) return [idx, idx + value.length];
    return [0, value.length];
  }

  /** 记录统计信息 */
  private recordStats(result: IntentAnalysis, processingTime: number): void {
    this.stats.confidenceSum += result.confidence;
    this.stats.domainCounts[result.domain] = (this.stats.domainCounts[result.domain] || 0) + 1;
    this.stats.actionTypeCounts[result.actionType] = (this.stats.actionTypeCounts[result.actionType] || 0) + 1;
    this.stats.processingTimes.push(processingTime);
    // 只保留最近1000条处理时间
    if (this.stats.processingTimes.length > 1000) {
      this.stats.processingTimes = this.stats.processingTimes.slice(-1000);
    }
  }

  /** 发送分析事件 */
  private emitAnalysisEvent(result: IntentAnalysis): void {
    this.eventBus.emitSync('nlu.analysis.complete', {
      intent: result.primaryIntent,
      confidence: result.confidence,
      domain: result.domain,
      actionType: result.actionType,
      complexity: result.complexity,
    }, { source: 'EnhancedNLU' });
  }

  // ============ Agent Loop 工具定义 ============

  /** 返回ToolDef兼容的工具定义列表 */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    execute: (args: Record<string, unknown>) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const nlu = this;

    return [
      {
        name: 'nlu_analyze',
        description: '分析用户输入的意图。使用多层识别（关键词→模式匹配→LLM深层理解），返回主意图、次要意图、置信度、领域、实体、动作类型、复杂度等信息。',
        parameters: {
          input: {
            type: 'string',
            description: '需要分析的用户输入文本',
            required: true,
          },
          context: {
            type: 'string',
            description: '对话上下文，JSON数组字符串，如 \'["之前的消息1","之前的消息2"]\'',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const input = args.input as string;
            let context: string[] | undefined;
            if (args.context) {
              try {
                context = JSON.parse(args.context as string);
              } catch {
                context = [args.context as string];
              }
            }
            const result = await nlu.analyzeIntent(input, context);
            return JSON.stringify(result, null, 2);
          } catch (err: unknown) {
            return `❌ 意图分析失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'nlu_disambiguate',
        description: '对歧义输入进行消歧。当用户输入可能对应多种意图时，利用上下文和LLM判断最可能的意图。',
        parameters: {
          input: {
            type: 'string',
            description: '需要消歧的用户输入文本',
            required: true,
          },
          candidates: {
            type: 'string',
            description: '候选意图列表，JSON数组字符串，如 \'["code_generation","search"]\'',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const input = args.input as string;
            let candidates: string[];
            try {
              candidates = JSON.parse(args.candidates as string);
            } catch {
              candidates = [args.candidates as string];
            }
            const result = await nlu.disambiguate(input, candidates);
            return JSON.stringify(result, null, 2);
          } catch (err: unknown) {
            return `❌ 消歧失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'nlu_entities',
        description: '从用户输入中提取命名实体。支持提取文件路径、代码符号、URL、命令、技术术语、项目名、编程语言、框架等。',
        parameters: {
          input: {
            type: 'string',
            description: '需要提取实体的用户输入文本',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const input = args.input as string;
            const entities = nlu.extractEntities(input);
            return Promise.resolve(JSON.stringify(entities, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 实体提取失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'nlu_domain',
        description: '检测用户输入所属的领域。支持：coding、debugging、deployment、documentation、testing、architecture、devops、data、design、general。',
        parameters: {
          input: {
            type: 'string',
            description: '需要检测领域的用户输入文本',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const input = args.input as string;
            const result = nlu.detectDomain(input);
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 领域检测失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
    ];
  }
}
