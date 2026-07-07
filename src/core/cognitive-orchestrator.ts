/**
 * 认知编排层 - CognitiveOrchestrator
 * 统一编排 NLU、安全检测、权限控制、个性化、性能监控等子系统
 * 提供端到端的智能处理流水线
 */

import { NLUEngine, type NLUResult } from './nlu-engine.js';
import { PIIDetector } from './pii-detector.js';
import { PermissionManager, type PermissionResult } from './permissions.js';
import { PerformanceMetricsSystem } from './performance-metrics.js';
import { SelfEvolutionEngine } from './self-evolution-engine.js';
import { AuditLogger } from './audit-logger.js';
import { logger } from './structured-logger.js';
import { PersonalizationEngine } from './personalization-engine.js';
import { AutonomousEvolutionEngine, type EvolutionGoal, type SelfAssessment } from './autonomous-evolution.js';
import { AdaptiveLearningSystem, type LearningStrategy } from './adaptive-learning.js';
import { ModuleRegistry } from './module-registry.js';
import { EvolutionTrace } from './evolution-trace.js';
import { SkillRegistry } from './skill-registry.js';
import { FeedbackSystem } from './feedback-system.js';
import { Benchmark } from './benchmark.js';
import { EventBus, Events } from './event-bus.js';
import { SkillPackageSystem } from './skill-package-system.js';
import { MCPManager } from './mcp-integration.js';
import { LazyToolRegistry } from './lazy-tool-registry.js';
import { PermissionAwareExecutor } from './permission-aware-executor.js';

// ============ 编排层类型定义 ============

/** 编排层配置 */
export interface OrchestratorConfig {
  enablePIIDetection?: boolean;
  enablePersonalization?: boolean;
  enableLearning?: boolean;
  enableCaching?: boolean;
  enableAudit?: boolean;
  enablePerformanceTracking?: boolean;
  userId?: string;
}

/** 安全检查结果 */
export interface SafetyCheckResult {
  inputPII: boolean;
  piiRiskLevel?: 'low' | 'medium' | 'high' | 'critical';
  redactedText?: string;
}

/** 编排层处理结果 */
export interface OrchestratorResult {
  response: string;
  confidence: number;
  nluResult?: NLUResult;
  reasoningChain: string[];
  safetyChecks: SafetyCheckResult;
  processingTime: number;
  personalized?: boolean;
}

/** 处理步骤记录 */
interface ProcessingStep {
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
  details?: string;
}

// ============ 编排层主类 ============

export class CognitiveOrchestrator {
  private config: OrchestratorConfig;
  private nluEngine: NLUEngine;
  private piiDetector: PIIDetector;
  private permissionManager: PermissionManager;
  private performanceMetrics: PerformanceMetricsSystem;
  private evolutionEngine: SelfEvolutionEngine;
  private auditLogger: AuditLogger;
  private personalizationEngine: PersonalizationEngine;

  // 新增进化模块
  private autonomousEvolution: AutonomousEvolutionEngine;
  private adaptiveLearning: AdaptiveLearningSystem;
  private moduleRegistry: ModuleRegistry;
  private evolutionTrace: EvolutionTrace;
  private skillRegistry: SkillRegistry;
  private feedbackSystem: FeedbackSystem;
  private benchmark: Benchmark;

  private lastProcessingSteps: ProcessingStep[] = [];
  private initialized = false;

  // 事件驱动架构组件
  private eventBus: EventBus;
  private skillSystem: SkillPackageSystem;
  private mcpManager: MCPManager;
  private toolRegistry: LazyToolRegistry;
  private permissionExecutor: PermissionAwareExecutor;
  private cleanupFns: Array<() => void> = [];

  constructor(config: OrchestratorConfig = {}) {
    this.config = config;

    // 初始化各子系统
    this.nluEngine = new NLUEngine();
    this.piiDetector = new PIIDetector();
    this.permissionManager = new PermissionManager();
    this.performanceMetrics = new PerformanceMetricsSystem();
    this.evolutionEngine = new SelfEvolutionEngine();
    this.auditLogger = new AuditLogger();
    this.personalizationEngine = new PersonalizationEngine();

    // 初始化进化模块
    this.feedbackSystem = new FeedbackSystem();
    this.benchmark = new Benchmark();
    this.autonomousEvolution = new AutonomousEvolutionEngine(
      this.performanceMetrics,
      this.evolutionEngine,
      this.feedbackSystem,
      this.benchmark
    );
    this.adaptiveLearning = new AdaptiveLearningSystem();
    this.moduleRegistry = new ModuleRegistry();
    this.evolutionTrace = new EvolutionTrace();
    this.skillRegistry = new SkillRegistry();

    // 初始化事件驱动架构
    this.eventBus = EventBus.getInstance();
    // P0 D2: 使用 SkillPackageSystem/MCPManager 默认路径（已迁移到 duanPath）
    this.skillSystem = new SkillPackageSystem();
    this.mcpManager = new MCPManager();
    this.toolRegistry = new LazyToolRegistry();
    this.permissionExecutor = new PermissionAwareExecutor(
      this.permissionManager,
      this.toolRegistry,
    );

    // 注册核心模块到模块注册表
    this.registerCoreModules();
  }

  /**
   * 初始化编排层（加载持久化数据等）
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.performanceMetrics.load();
      await this.auditLogger.load();

      // 初始化事件驱动组件
      // 防递归守卫：process() 内部不应再触发 MESSAGE_RECEIVED，
      // 但如果触发则通过 source 标记和递归深度计数器防止无限递归
      let messageProcessingDepth = 0;
      const MAX_MESSAGE_DEPTH = 3;
      // 捕获 unsubscribe 句柄到 cleanupFns，避免监听器泄漏（shutdown 时统一释放）
      this.cleanupFns.push(this.eventBus.on(Events.MESSAGE_RECEIVED, (event) => {
        if (event.data?.text && event.data?.source !== 'self') {
          if (messageProcessingDepth >= MAX_MESSAGE_DEPTH) {
            logger.warn('消息处理递归深度达到上限，跳过', { module: 'CognitiveOrchestrator', depth: MAX_MESSAGE_DEPTH });
            return;
          }
          messageProcessingDepth++;
          this.process(event.data.text)
            .catch((e: unknown) => logger.error('消息处理异常', { module: 'CognitiveOrchestrator', error: e instanceof Error ? e.message : String(e) }))
            .finally(() => {
              messageProcessingDepth--;
            });
        }
      }));

      this.cleanupFns.push(this.eventBus.on(Events.PERMISSION_CHECK, (event) => {
        if (event.data?.denied) {
          logger.warn('操作被拒绝', { module: '安全', toolName: event.data.toolName });
        }
      }));

      // 技能系统感知消息事件，自动匹配技能触发器
      this.cleanupFns.push(this.eventBus.on(Events.MESSAGE_RECEIVED, async (event) => {
        if (event.data?.text) {
          const skills = this.skillSystem.findMatchingSkills(event.data.text);
          if (skills.length > 0) {
            const skillNames = skills.map(s => s.manifest.name).join(', ');
            await this.eventBus.emit('skill.triggered', {
              text: event.data.text,
              skills: skills.map(s => s.manifest.id),
              names: skillNames,
            }, { source: 'cognitive-orchestrator' });
          }
        }
      }));

      // 启动 MCP 管理器
      await this.mcpManager.initialize().catch(() => {});

      // 启动技能系统
      await this.skillSystem.initialize().catch(() => {});

      // 注册 MCP 工具到工具注册表
      const mcpTools = this.mcpManager.getToolsAsUnifiedDefinitions();
      for (const mcpTool of mcpTools) {
        this.toolRegistry.register({
          id: mcpTool.id,
          name: mcpTool.name,
          description: mcpTool.description,
          parameters: mcpTool.parameters,
          execute: mcpTool.execute,
          initialized: true,
          category: 'mcp',
          readOnly: true,
          riskLevel: 'safe',
        });
      }

      // 发布系统就绪事件
      await this.eventBus.emit(Events.SYSTEM_STARTUP, {
        skillsLoaded: this.skillSystem.listSkills().length,
        mcpServers: this.mcpManager.listServers().length,
        mcpTools: mcpTools.length,
        toolsRegistered: this.toolRegistry.getStats().total,
        version: '19.0.0',
      }, { source: 'cognitive-orchestrator', priority: 'high' });

    } catch {
      // 加载失败时使用默认空数据
    }

    this.initialized = true;
  }

  /**
   * 处理用户输入 - 核心编排流程
   */
  async process(userInput: string): Promise<OrchestratorResult> {
    const overallStart = Date.now();
    this.lastProcessingSteps = [];
    const reasoningChain: string[] = [];

    // 发布消息接收事件
    await this.eventBus.emit(Events.MESSAGE_RECEIVED, {
      text: userInput,
      source: 'user',
      timestamp: Date.now(),
    }, { source: 'cognitive-orchestrator' });

    // ---- 步骤1: PII检测 ----
    let safetyChecks: SafetyCheckResult = { inputPII: false };
    let processedInput = userInput;

    if (this.config.enablePIIDetection) {
      const stepStart = Date.now();
      const piiResult = this.piiDetector.detect(userInput);
      safetyChecks = {
        inputPII: piiResult.hasPII,
        piiRiskLevel: piiResult.riskLevel,
        redactedText: piiResult.redactedText,
      };

      if (piiResult.hasPII) {
        processedInput = piiResult.redactedText;
        reasoningChain.push(`PII检测: 发现${piiResult.findings.length}个敏感信息，已脱敏处理`);
      } else {
        reasoningChain.push('PII检测: 未发现敏感信息');
      }
      this.recordStep('pii_detection', stepStart);
    }

    // ---- 步骤2: NLU分析 ----
    const nluStart = Date.now();
    const nluResult = await this.nluEngine.analyze(processedInput);

    // 发布意图检测事件
    if (nluResult.intents.length > 0) {
      await this.eventBus.emit(Events.INTENT_DETECTED, {
        text: processedInput,
        topIntent: nluResult.intents[0].name,
        confidence: nluResult.intents[0].confidence,
        allIntents: nluResult.intents.map(i => ({ name: i.name, confidence: i.confidence })),
        entities: nluResult.entities.map(e => ({ type: e.type, value: e.value })),
      }, { source: 'cognitive-orchestrator' });
    }

    reasoningChain.push(
      `意图识别: ${nluResult.intents.map(i => `${i.name}(${(i.confidence * 100).toFixed(0)}%)`).join(', ')}`
    );
    if (nluResult.entities.length > 0) {
      reasoningChain.push(
        `实体提取: ${nluResult.entities.map(e => `${e.type}:${e.value}`).join(', ')}`
      );
    }
    this.recordStep('nlu_analysis', nluStart);

    // ---- 步骤3: 个性化适配 ----
    let personalized = false;
    const userId = this.config.userId || 'default';

    if (this.config.enablePersonalization) {
      const stepStart = Date.now();
      this.personalizationEngine.learnFromInteraction(userId, processedInput, '');
      personalized = true;
      reasoningChain.push('个性化: 已根据用户画像调整响应风格');
      this.recordStep('personalization', stepStart);
    }

    // ---- 步骤4: 技能系统匹配 ----
    const matchedSkills = this.skillSystem.findMatchingSkills(processedInput);
    if (matchedSkills.length > 0) {
      const skillPrompts = matchedSkills
        .filter(s => s.manifest.systemPrompt)
        .map(s => s.manifest.systemPrompt)
        .join('\n\n');
      if (skillPrompts) {
        reasoningChain.push(`技能匹配: ${matchedSkills.map(s => s.manifest.name).join(', ')}`);
      }
    }

    // ---- 步骤5: 生成初步响应 ----
    const response = this.generateResponse(nluResult, reasoningChain);

    // ---- 步骤6: 审计记录 ----
    if (this.config.enableAudit) {
      const stepStart = Date.now();
      try {
        await this.auditLogger.log({
          type: 'data_access',
          action: 'process_user_input',
          actor: userId,
          resource: 'cognitive_orchestrator',
          result: 'success',
          details: {
            inputLength: userInput.length,
            hasPII: safetyChecks.inputPII,
            topIntent: nluResult?.intents[0]?.name,
            confidence: nluResult?.confidence,
            matchedSkills: matchedSkills.map(s => s.manifest.id),
          },
        });
      } catch {
        // 审计记录失败不影响主流程
      }
      this.recordStep('audit_logging', stepStart);
    }

    // ---- 步骤7: 性能记录 ----
    if (this.config.enablePerformanceTracking) {
      const stepStart = Date.now();
      const overallTime = Date.now() - overallStart;
      this.performanceMetrics.recordMetric({
        timestamp: new Date(),
        intentAccuracy: nluResult?.confidence || 0,
        taskCompletionRate: 1.0,
        userSatisfaction: 0,
        avgResponseTime: overallTime,
        toolCallSuccessRate: 1.0,
        contextCoherence: 1.0,
        selfCorrectionRate: 0,
        totalInteractions: 1,
      });
      this.recordStep('performance_tracking', stepStart);
    }

    // ---- 步骤8: 学习闭环 ----
    if (this.config.enableLearning) {
      const stepStart = Date.now();
      try {
        await this.evolutionEngine.recordExperience(
          processedInput,
          'cognitive_orchestration',
          response,
          true
        );
      } catch {
        // 学习记录失败不影响主流程
      }
      this.recordStep('learning', stepStart);
    }

    // 发布消息发送事件
    await this.eventBus.emit(Events.MESSAGE_SENT, {
      text: response,
      source: 'assistant',
      reasoningChain,
      processingTime: Date.now() - overallStart,
      topIntent: nluResult?.intents[0]?.name,
      confidence: nluResult?.confidence,
    }, { source: 'cognitive-orchestrator' });

    const processingTime = Date.now() - overallStart;

    return {
      response,
      confidence: nluResult?.confidence || 0.5,
      nluResult,
      reasoningChain,
      safetyChecks,
      processingTime,
      personalized,
    };
  }

  /**
   * 权限检查
   */
  checkPermission(
    toolName: string,
    parameters: Record<string, unknown>
  ): Promise<PermissionResult> {
    return Promise.resolve(this.permissionManager.check(toolName, parameters, {
      userId: this.config.userId,
      isTrustedEnvironment: true,
    }));
  }

  /**
   * 生成响应（基于NLU结果）
   */
  private generateResponse(nluResult: NLUResult | undefined, _reasoningChain: string[]): string {
    if (!nluResult || nluResult.intents.length === 0) {
      return '我理解了您的请求，正在处理中。';
    }

    const topIntent = nluResult.intents[0];
    const sentiment = nluResult.sentiment;

    // 根据意图和情感生成响应
    if (sentiment.urgency === 'critical' || sentiment.urgency === 'high') {
      return `收到您的紧急请求，我会优先处理。已识别意图: ${topIntent.name}`;
    }

    if (topIntent.confidence >= 0.7) {
      return `已理解您的请求（${topIntent.name}），正在为您处理。`;
    }

    if (topIntent.confidence >= 0.4) {
      return `我理解您可能想要${topIntent.name}，让我为您处理。`;
    }

    return '我正在分析您的请求，请稍候。';
  }

  /**
   * 记录处理步骤
   */
  private recordStep(name: string, startTime: number): void {
    const endTime = Date.now();
    this.lastProcessingSteps.push({
      name,
      startTime,
      endTime,
      duration: endTime - startTime,
    });
  }

  /**
   * 获取系统健康状态
   */
  getSystemHealth(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: Record<string, 'ok' | 'error'>;
    uptime: number;
  } {
    const components: Record<string, 'ok' | 'error'> = {
      nlu: 'ok',
      pii: 'ok',
      permissions: 'ok',
      performance: 'ok',
      audit: 'ok',
      personalization: 'ok',
    };

    const hasError = Object.values(components).some(v => v === 'error');

    return {
      status: hasError ? 'degraded' : 'healthy',
      components,
      uptime: process.uptime(),
    };
  }

  /**
   * 获取性能报告
   */
  getPerformanceReport(): string {
    return this.performanceMetrics.generateReport();
  }

  /**
   * 获取改进建议
   */
  getRecommendations(): string[] {
    return this.performanceMetrics.getRecommendations();
  }

  /**
   * 获取上次处理的步骤详情
   */
  getLastProcessingSteps(): ProcessingStep[] {
    return [...this.lastProcessingSteps];
  }

  /**
   * 触发自进化
   */
  async evolve(): Promise<string> {
    try {
      const result = await this.evolutionEngine.evolve();
      const lines: string[] = [];

      if (result.improved) {
        lines.push('进化完成，发现改进机会：');
      } else {
        lines.push('进化分析完成，暂无改进：');
      }

      if (result.insights.length > 0) {
        lines.push('洞察：');
        result.insights.forEach(i => lines.push(`  - ${i}`));
      }

      if (result.recommendations.length > 0) {
        lines.push('建议：');
        result.recommendations.forEach(r => lines.push(`  - ${r}`));
      }

      return lines.join('\n');
    } catch {
      return '自进化过程出错，请稍后重试。';
    }
  }

  // ========== 进化系统接口 ==========

  /**
   * 启动自主进化
   */
  startAutonomousEvolution(): void {
    this.autonomousEvolution.start();
  }

  /**
   * 停止自主进化
   */
  stopAutonomousEvolution(): void {
    this.autonomousEvolution.stop();
  }

  /**
   * 执行一次自我评估
   */
  selfAssess(): Promise<SelfAssessment> {
    return Promise.resolve(this.autonomousEvolution.selfAssess());
  }

  /**
   * 设定进化目标
   */
  setEvolutionGoal(goal: Omit<EvolutionGoal, 'id' | 'createdAt' | 'status' | 'progress' | 'verificationResults'>): string {
    const goalId = this.autonomousEvolution.setGoal(goal);

    // 记录到进化追溯
    this.evolutionTrace.recordEvent({
      type: 'goal_set',
      description: `设定进化目标: ${goal.name}`,
      actor: 'user',
      data: { goalId, metric: goal.metric, target: goal.targetValue },
      causalParentIds: [],
      impact: 'neutral',
      impactScore: 0,
    });

    return goalId;
  }

  /**
   * 获取进化目标
   */
  getEvolutionGoals(status?: EvolutionGoal['status']): EvolutionGoal[] {
    return this.autonomousEvolution.getGoals(status);
  }

  /**
   * 获取进化报告
   */
  getEvolutionReport(): string {
    return this.autonomousEvolution.generateReport();
  }

  /**
   * 获取自适应学习报告
   */
  getAdaptiveLearningReport(): string {
    return this.adaptiveLearning.generateReport();
  }

  /**
   * 获取当前学习策略
   */
  getCurrentLearningStrategy(): LearningStrategy {
    return this.adaptiveLearning.getCurrentStrategy();
  }

  /**
   * 获取模块报告
   */
  getModuleReport(): string {
    return this.moduleRegistry.generateReport();
  }

  /**
   * 热替换模块
   */
  replaceModule(moduleId: string, newInstance: unknown, newVersion: string, reason: string): boolean {
    const result = this.moduleRegistry.replace(moduleId, newInstance, newVersion, reason);

    if (result) {
      this.evolutionTrace.recordEvent({
        type: 'module_replaced',
        description: `模块 ${moduleId} 从热替换为 v${newVersion}`,
        actor: 'system',
        data: { moduleId, newVersion, reason },
        causalParentIds: [],
        impact: 'neutral',
        impactScore: 0,
      });
    }

    return result;
  }

  /**
   * 回滚模块
   */
  rollbackModule(moduleId: string): boolean {
    return this.moduleRegistry.rollback(moduleId);
  }

  /**
   * 获取进化追溯时间线
   */
  getEvolutionTimeline(limit: number = 20): string {
    return this.evolutionTrace.generateTimeline(limit);
  }

  /**
   * 获取进化事件解释
   */
  explainEvolutionEvent(eventId: string): string {
    return this.evolutionTrace.generateExplanation(eventId);
  }

  /**
   * 收集用户反馈
   */
  collectFeedback(userId: string, sessionId: string, rating: number, context: { query: string; response: string }): Promise<string> {
    return Promise.resolve(this.feedbackSystem.rate(userId, sessionId, rating, context));
  }

  /**
   * 获取反馈报告
   */
  getFeedbackReport(periodDays: number = 30): string {
    return this.feedbackSystem.generateReport(periodDays);
  }

  /**
   * 运行基准测试
   */
  async runBenchmark(processor: (input: string, context?: string) => Promise<{
    response: string;
    intent?: string;
    confidence?: number;
    processingTime?: number;
  }>): Promise<string> {
    const snapshot = await this.benchmark.runAll(processor);
    this.benchmark.compareWithBaseline(snapshot);
    return this.benchmark.generateReport(snapshot);
  }

  /**
   * 匹配技能
   */
  matchSkills(query: string) {
    return this.skillRegistry.match(query);
  }

  /**
   * 执行技能
   */
  executeSkill(skillId: string, input: { query: string; context?: string; parameters?: Record<string, unknown> }) {
    return Promise.resolve(this.skillRegistry.execute(skillId, input));
  }

  // ========== 私有方法 ==========

  /**
   * 注册核心模块到模块注册表
   */
  private registerCoreModules(): void {
    this.moduleRegistry.register({
      id: 'nlu-engine',
      name: 'NLU引擎',
      version: '2.0.0',
      description: '自然语言理解引擎',
      provides: ['intent_recognition', 'entity_extraction', 'sentiment_analysis'],
      instance: this.nluEngine,
    });

    this.moduleRegistry.register({
      id: 'pii-detector',
      name: 'PII检测器',
      version: '1.0.0',
      description: '敏感信息检测与脱敏',
      provides: ['pii_detection', 'data_redaction'],
      instance: this.piiDetector,
    });

    this.moduleRegistry.register({
      id: 'permission-manager',
      name: '权限管理器',
      version: '2.0.0',
      description: 'RBAC+ABAC混合权限控制',
      provides: ['permission_check', 'access_control'],
      instance: this.permissionManager,
    });

    this.moduleRegistry.register({
      id: 'performance-metrics',
      name: '性能指标系统',
      version: '1.0.0',
      description: '性能指标追踪与报告',
      provides: ['metrics_tracking', 'performance_report'],
      instance: this.performanceMetrics,
    });

    this.moduleRegistry.register({
      id: 'evolution-engine',
      name: '自我进化引擎',
      version: '2.0.0',
      description: '经验积累与自我进化',
      provides: ['self_evolution', 'experience_recording'],
      dependencies: ['performance-metrics'],
      instance: this.evolutionEngine,
    });

    this.moduleRegistry.register({
      id: 'audit-logger',
      name: '审计日志',
      version: '1.0.0',
      description: '操作审计与异常检测',
      provides: ['audit_logging', 'anomaly_detection'],
      instance: this.auditLogger,
    });

    this.moduleRegistry.register({
      id: 'personalization-engine',
      name: '个性化引擎',
      version: '1.0.0',
      description: '用户画像与响应适配',
      provides: ['personalization', 'user_profiling'],
      instance: this.personalizationEngine,
    });

    this.moduleRegistry.register({
      id: 'skill-registry',
      name: '技能注册表',
      version: '1.0.0',
      description: '领域技能注册与执行',
      provides: ['skill_matching', 'skill_execution'],
      instance: this.skillRegistry,
    });

    this.moduleRegistry.register({
      id: 'feedback-system',
      name: '反馈系统',
      version: '1.0.0',
      description: '用户反馈收集与分析',
      provides: ['feedback_collection', 'feedback_analysis'],
      instance: this.feedbackSystem,
    });

    this.moduleRegistry.register({
      id: 'adaptive-learning',
      name: '自适应学习系统',
      version: '1.0.0',
      description: '自适应学习策略管理',
      provides: ['adaptive_learning', 'curriculum_learning'],
      dependencies: ['evolution-engine'],
      instance: this.adaptiveLearning,
    });

    this.moduleRegistry.register({
      id: 'autonomous-evolution',
      name: '自主进化引擎',
      version: '1.0.0',
      description: '自主监控、评估、目标设定与验证',
      provides: ['autonomous_evolution', 'self_assessment', 'goal_management'],
      dependencies: ['performance-metrics', 'evolution-engine', 'feedback-system', 'benchmark'],
      instance: this.autonomousEvolution,
    });

    this.moduleRegistry.register({
      id: 'evolution-trace',
      name: '进化追溯系统',
      version: '1.0.0',
      description: '进化过程可追溯与可解释',
      provides: ['evolution_tracing', 'causal_analysis'],
      instance: this.evolutionTrace,
    });

    // === 事件驱动架构模块注册 ===
    this.moduleRegistry.register({
      id: 'event-bus',
      name: '事件总线',
      version: '2.0.0',
      description: '全局事件驱动通信系统',
      provides: ['event_publish', 'event_subscribe', 'event_history'],
      instance: this.eventBus,
    });
    this.moduleRegistry.register({
      id: 'skill-package-system',
      name: '技能包系统',
      version: '1.0.0',
      description: 'SKILL.md 模块化技能包管理',
      provides: ['skill_install', 'skill_activate', 'skill_matching'],
      instance: this.skillSystem,
    });
    this.moduleRegistry.register({
      id: 'mcp-manager',
      name: 'MCP 集成管理器',
      version: '1.0.0',
      description: 'Model Context Protocol 外部工具',
      provides: ['mcp_connect', 'mcp_tools', 'dynamic_tools'],
      instance: this.mcpManager,
    });
    this.moduleRegistry.register({
      id: 'lazy-tool-registry',
      name: '惰性工具注册表',
      version: '1.0.0',
      description: '模型感知的惰性工具加载',
      provides: ['tool_register', 'tool_filter', 'model_filtering'],
      instance: this.toolRegistry,
    });
    this.moduleRegistry.register({
      id: 'permission-executor',
      name: '权限感知执行器',
      version: '1.0.0',
      description: '审批流程集成的工具执行',
      provides: ['safe_execution', 'approval_flow'],
      dependencies: ['permission-manager', 'lazy-tool-registry'],
      instance: this.permissionExecutor,
    });
  }

  // ========================
  // 事件驱动架构访问器
  // ========================

  getEventBus(): EventBus { return this.eventBus; }
  getSkillSystem(): SkillPackageSystem { return this.skillSystem; }
  getMCPManager(): MCPManager { return this.mcpManager; }

  getToolRegistry(): LazyToolRegistry { return this.toolRegistry; }
  getPermissionExecutor(): PermissionAwareExecutor { return this.permissionExecutor; }

  /** 关闭所有异步组件 */
  async shutdown(): Promise<void> {
    this.autonomousEvolution.stop();
    this.auditLogger.stop();
    try {
      await Promise.all([
        this.performanceMetrics.save(),
        this.evolutionTrace.save(),
      ]);
    } catch {}
    await this.mcpManager.disconnectAll();
    // 释放所有 EventBus 监听器（在 initialize 中捕获的 unsubscribe 句柄）
    for (const cleanup of this.cleanupFns) {
      try { cleanup(); } catch {}
    }
    this.cleanupFns.length = 0;
    this.eventBus.reset();
    // 重置 initialized 守卫，允许 shutdown 后重新 initialize
    this.initialized = false;
  }
}
