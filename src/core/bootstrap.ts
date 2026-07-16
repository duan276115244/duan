/**
 * 模块引导 — bootstrap.ts
 *
 * v17.0 模块化引导：
 * 1. createCoreModules()   — 创建所有核心模块实例
 * 2. createToolRegistry()  — 创建 ScalableToolRegistry 并注册所有工具
 * 3. createAgentLoop()     — 创建 EnhancedAgentLoop 并注入所有依赖
 * 4. setupAgentLoop()      — 便捷函数，依次执行上述三步
 */

import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';

/**
 * P0-3 辅助：token 哈希函数 — 用于语义嵌入的 simhash 投影
 * @param token 待哈希的 token
 * @param seed 种子（不同种子产生不同哈希，增加散列度）
 * @returns 32 位无符号哈希值
 */
function hashToken(token: string, seed: number): number {
  // FNV-1a 变种：seed 作为初始偏移
  let hash = 2166136261 ^ (seed * 16777619);
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // 转为无符号 32 位
  return hash >>> 0;
}

// ===== v16.0 核心系统 =====
import { ModelLibrary } from './model-library.js';
import { AutonomousThinker } from './autonomous-thinker.js';
import {
  CompositeEmbeddingProvider,
  OpenAIEmbeddingProvider,
  TfidfEmbeddingProvider,
  type EmbeddingProvider,
} from './embedding-provider.js';
import { SelfUpgradeSystem } from './self-upgrade-system.js';
import { SelfLearningSystem } from './self-learning-system.js';

// ===== v17.0 核心模块 =====
import { AutonomousEvolutionEngine } from './autonomous-evolution.js';
import { AdaptiveLearningSystem } from './adaptive-learning.js';
import { ModuleRegistry } from './module-registry.js';
import { EvolutionTrace } from './evolution-trace.js';
import { SystemDiagnostics } from './system-diagnostics.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { PromptOptimizer } from './prompt-optimizer.js';
import { AutonomousCapabilities } from './autonomous-capabilities.js';
import { CapabilityManager } from './capability-manager.js';
import { CollaborativeWorkspace } from './collaborative-workspace.js';
import { VideoGenerationEngine } from './video-generation.js';
import { AutonomousThinkingEngine } from './autonomous-thinking.js';
import { NLUEngine } from './nlu-engine.js';
import { ReasoningEngine } from './reasoning-engine.js';
import { PerformanceMetricsSystem } from './performance-metrics.js';
import { SelfEvolutionEngine } from './self-evolution-engine.js';
import { FeedbackSystem } from './feedback-system.js';
import { Benchmark } from './benchmark.js';
import { PersonalizationEngine } from './personalization-engine.js';

// ===== 自主意识系统 =====
import { CognitiveState } from './cognitive-state.js';
import { SelfAwareness } from './self-awareness.js';
import { ValueSystem } from './value-system.js';
import { GoalSystem } from './goal-system.js';
import { Heartbeat } from './heartbeat.js';
import {
  SubAgentOrchestrator,
  getSubAgentToolDefinitions,
  createSubAgentToolHandler,
} from './sub-agent-orchestrator.js';
import {
  AgentTeamOrchestrator,
  getAgentTeamToolDefinitions,
  createAgentTeamToolHandler,
} from './agent-team-orchestrator.js';
import { BackgroundAgentManager } from './background-agent-manager.js';
import { SelfEvolve } from './self-evolve.js';
import { StrategyEngine } from './strategy-engine.js';
import { SkillExtractor } from './skill-extractor.js';
import { OmniAssistant } from './omni-assistant.js';
import { SelfAssessment } from './self-assessment.js';
import { TaskPlanner } from './task-planner.js';
import { FunctionalTestSuite } from './functional-test-suite.js';
import { ContextCompressor } from './context-compressor.js';
import { SelfHealingEngine } from './self-heal-engine.js';
import { checkOnStartup as runCorruptionGuard } from './corruption-guard.js';
import { UnifiedToolFramework } from './unified-tool-framework.js';
import { EvolutionMetrics } from './evolution-metrics.js';
import { LongTermPlanner } from './long-term-planner.js';
// V19 P0：持续进化系统 — 定时爬取全球智能体并学习注入
import { ContinuousEvolutionSystem } from './continuous-evolution-system.js';

// ===== 事件驱动 & 新核心模块 =====
import { EventBus } from './event-bus.js';
import { SkillPackageSystem } from './skill-package-system.js';
import { SkillDiscovery } from './skill-discovery.js';
import { SkillRegistry } from './skill-registry.js';
import { MCPManager } from './mcp-integration.js';
import { MCPMarketplace } from './mcp-marketplace.js';
import { NotificationService } from './notification-service.js';
import { WebhookService } from './webhook-service.js';
import { ToolConsolidation } from './tool-consolidation.js';
import { CloudDeployment } from './cloud-deployment.js';

// ===== Agent Loop =====
import { EnhancedAgentLoop } from './enhanced-agent-loop.js';
import { type ToolDef, type LoopEvent, type TerminalReason } from './agent-loop-types.js';

// ===== Tool definition factories =====
import {
  createVideoToolDefs,
  createTestToolDefs,
  createDocToolDefs,
  createImageToolDefs,
} from './bootstrap-tool-defs.js';

// ===== Unified built-in tools =====
import { allBuiltInTools, toolContext } from '../tools/built-in/index.js';
import { TOOL_RISK_MAP, inferCategory } from './unified-tool-def.js';
import { setAgentRunner as setToolAgentRunner } from '../tool-agent.js';
import { TwoStageClassifier } from './permission-classifier.js';
import { CompressionPipeline } from './compression-pipeline.js';
import { ShadowGit } from './shadow-git.js';
import { getChannelManager } from './channel-manager.js';
// P0-1/P0-2: 5 层 Compaction + 集中式 QueryEngine — 修复死代码集成
import { CompactionSystem } from './compaction-system.js';
import { QueryEngine, type LLMClient } from './query-engine.js';
import { registerQueryEngine } from './query-engine-singleton.js';

// ===== 记忆系统 =====
import { VectorStore } from '../memory/vector-store.js';
import { UnifiedMemoryManager as EnhancedMemory, MemoryManager } from '../memory/manager.js';
import { UnifiedMemory } from './unified-memory.js';
import { MemoryOrchestrator } from './memory-orchestrator.js';
import { MemoryStore } from './memory-store.js';

// ===== 服务集成 =====
import { ServiceIntegrations } from '../integrations/services.js';
import { injectLLMCallerLibrary } from '../tools/llm-caller.js';

// ===== Phase 2: Codex核心能力 =====
import { TreeSitterAST } from './tree-sitter-ast.js';
import { GitWorktreeManager } from './git-worktree.js';
import { AdversarialVerifier } from './adversarial-verifier.js';

// ===== P0 Phase: 下一代智能 =====
import { DreamingEngine } from './dreaming-engine.js';
import { ProactiveEngine } from './proactive-engine.js';
import { DreamingBridge } from './dreaming-bridge.js';
import { ToolMaskingEngine } from './tool-masking.js';
// P1-4: 多工具协同工作流引擎
import { ToolOrchestrationEngine } from './tool-orchestration-engine.js';
// P1-2: 多步推理框架
import { MultiStepReasoningFramework } from './multi-step-reasoning.js';
import { IntelligentErrorRecovery } from './intelligent-error-recovery.js';
import { SessionMemoryReplay } from './session-memory-replay.js';

// ===== Phase 3: 全能多模态 =====
import { VoiceSystem } from './voice-system.js';
import { VideoGenerationReal } from './video-generation-real.js';
import { DesktopControl } from './desktop-control.js';
// V19 P0：接入 UniversalDesktop — 应用 Profile + 工作流能力
import { UniversalDesktop } from './universal-desktop.js';
// V19 P0：接入 AccessibilityController — 无障碍 API 语义元素操作（UIAutomation/System Events/AT-SPI）
import { AccessibilityController } from './accessibility-controller.js';

// ===== Phase 4: 自主学习与进化升级 =====
import { ContinuousLearningFramework } from './continuous-learning.js';
import { FeedbackRewardSystem } from './feedback-reward.js';
import { EvolutionAssessmentSystem } from './evolution-assessment.js';
import { SessionPersistence } from './session-persistence.js';
import { LSPIntegration } from './lsp-integration.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { SmartCache } from './smart-cache.js';

// ===== Phase 5: 系统性优化升级 =====
import { EnhancedNLU } from './enhanced-nlu.js';
import { CodeReasoningEngine } from './code-reasoning.js';
import { ContextRetentionSystem } from './context-retention.js';
import { TaskDecompositionEngine } from './task-decomposition.js';
import { ToolIntegrationOptimizer } from './tool-integration-optimizer.js';
import { AdaptiveInteractionSystem } from './adaptive-interaction.js';
import { DuanPersonaEngine } from './duan-persona-engine.js';

// ===== Phase 6: 基准测试与优化路线图 =====
import { BenchmarkFramework } from './benchmark-framework.js';
import { OptimizationRoadmap } from './optimization-roadmap.js';

// ===== Phase 7: 路线图P0/P1实现 =====
import { HandoffSystem } from './handoff-system.js';
import { DiffEditor } from './diff-editor.js';
import { GuardrailSystem } from './guardrail-system.js';
import { TraceCollector } from './trace-collector.js';
import { VirtualMemoryWorkflow } from './virtual-memory-workflow.js';
import { Brain } from './brain.js';
import { ProjectConfig } from './project-config.js';
import { ProjectContext } from './project-context.js';
import { ProjectMemoryLoader } from './project-memory-loader.js';
import { CodebaseIndexer } from './codebase-indexer.js';
import { NativeDepsResolver } from './native-deps.js';
import { SubAgentPresetRegistry } from './subagent-presets.js';
import { SlashCommandRegistry } from './slash-commands.js';
import { ContextDiscoverer } from './context-discoverer.js';
import { MultiFileEditor } from './multi-file-editor.js';
import { ToolPermissionRegistry } from './tool-permissions.js';
import { PersonaSystem } from './persona-system.js';
import { GoalTracker } from './goal-tracker.js';
import { AutonomousEngineer } from './autonomous-engineer.js';
import { DocumentParser } from './document-parser.js';
import { ProactiveQuestionEngine } from './proactive-question-engine.js';
import { SkillMarket } from './skill-market.js';
import { OfflineCoordinator } from './offline-coordinator.js';
import { LearningProgressVisualizer } from './learning-progress-visualizer.js';
import { ModelFineTuner } from './model-fine-tuner.js';
import { CollaborationEngine } from './collaboration-engine.js';
import { ModelRouter } from './model-router.js';
import { StructuredOutputParser } from './structured-output-parser.js';

// ===== v21.0 主流 Agent 对标升级（4 项 P0） =====
// §1 Hooks 生命周期系统增强（对标 Claude Code）— 6 新内置钩子 + 5 新事件 + update 动作
import {
  createEnhancedLifecycleHookManager,
  getHooksToolDefinitions,
  createHooksToolHandler,
} from './lifecycle-hooks-v21.js';
import type { LifecycleHookManager } from './lifecycle-hooks.js';
// §2 AGENTS.md 三层记忆体系（对标 Codex CLI）— 全局/项目/子目录 override
import {
  AgentsMdLoader,
  AgentsMdInitializer,
  getAgentsMdToolDefinitions,
  createAgentsMdToolHandler,
} from './agents-md-loader.js';
// §3 文件即接口上下文工程（对标 Cursor）— 工具结果 >4KB 文件化 + 摘要 + 历史引用
import {
  FileContextEngine,
  getFileContextToolDefinitions,
  createFileContextToolHandler,
} from './file-context-engine.js';
// §4 异步任务托管模式（对标 Devin）— 任务队列 + 进度追踪 + 结果通知 + 中断恢复
import {
  AsyncTaskManager,
  getAsyncTaskToolDefinitions,
  createAsyncTaskToolHandler,
} from './async-task-manager.js';

// ===== v21.1 主流 Agent 差异化能力补全（4 项 P0） =====
// §B Spec-Driven Development（对标 GitHub Spec Kit）— spec/plan/tasks/checklist 四阶段工件流程
import {
  SpecDrivenDev,
  getSpecDrivenToolDefinitions,
  createSpecDrivenToolHandler,
} from './spec-driven-dev.js';
// §C Repo Map 重要性排序（对标 Aider RepoMap）— tree-sitter 符号评分 + 压缩上下文
import {
  RepoMap,
  getRepoMapToolDefinitions,
  createRepoMapToolHandler,
} from './repo-map.js';
// §D Plan Mode 可编辑计划（对标 Cursor Plan Mode）— 状态机 + 步骤追踪 + Markdown
import {
  PlanMode,
  getPlanModeToolDefinitions,
  createPlanModeToolHandler,
} from './plan-mode.js';

// ===== Phase 8: 路线图P0/P1/P2深度实现 =====
import { ApprovalGate } from './approval-gate.js';
import { EthicsReviewEngine } from './ethics-review-engine.js';
import { CodeKnowledgeGraph } from './code-knowledge-graph.js';
import { SotaBenchmarkScheduler } from './sota-benchmark-scheduler.js';
import { SelfHealingPipeline } from './self-healing-pipeline.js';
import { ConsistencyGuard } from './consistency-guard.js';
import { AgentConfig } from './agent-config.js';
import { ContextSelector } from './context-selector.js';

// ===== 三大核心功能模块 =====
import { LearningEvalSystem } from './learning-eval-system.js';
import { SkillGenerator } from './skill-generator.js';
import { UnifiedUserProfileCenter } from './unified-user-profile.js';

// ===== Phase 9: 下一代能力 =====
// (已移除：PluginSystem, HybridRetrieval, SandboxExecutor, StreamingResponse,
//  WorkflowRegistry, SwarmOrchestrator — 仅被 duan-v19.0.ts 引用)

// ===== Phase 10: 深度智能 =====
// (已移除：SpeculativeExecution, KnowledgeDistillation, AgentProtocol,
//  ProgressiveEnhancement, CodeIntelligence — 仅被 duan-v19.0.ts 引用)

// ===== Phase 11: 架构深度集成 =====
// (已移除：MiddlewareChain, EventSourcing, ABTesting, ErrorOrchestrator,
//  RealtimeServer, DIContainer — 仅被 duan-v19.0.ts 引用)

// ===== Phase 12: AI进化学习 =====
// (已移除：ConstitutionalAI, ExtendedThinking, CodeInterpreter, CustomGPTs,
//  GeminiGrounding, CrossModelAdapter — 仅被 duan-v19.0.ts 引用)

// ===== Phase 13: 生产级能力 =====
// (已移除：SecurityEngine, ObservabilityDashboard, RAGEnhancer, PromptChain,
//  GracefulLifecycle — 仅被 duan-v19.0.ts 引用)

// ===== Phase 14: 分布式智能与生态 =====
// (已移除：TokenBudgetManager, AutoTestPipeline,
//  AgentFederation, PluginMarketplace — 仅被 duan-v19.0.ts 引用)

// P2-1: 用户偏好学习引擎
import { UserPreferenceEngine } from './user-preference-engine.js';

// P2-2: GEPA 自进化引擎 — 行为记录→效果评估→技能沉淀闭环
import { GEPAEvolutionEngine } from './gepa-evolution.js';

// P2-3: SOP 角色流水线 — 5角色装配线 + pub/sub 消息机制
import { SOPPipeline } from './sop-pipeline.js';

// P3-2: 知识图谱记忆 — 实体-关系-属性三元组 + 图谱查询与向量检索混合召回
import { KnowledgeGraphMemory } from './knowledge-graph-memory.js';

// P2-4: 增强视觉智能引擎 — 多层级屏幕理解 + UI 元素检测 + OCR
import { VisualIntelligence } from './visual-intelligence.js';

// P3-1: Agent 身份网络 — 独立身份 + 声誉/信任评分 + 跨渠道同步
import { AgentIdentityNetwork } from './agent-identity.js';
import {
  WeChatChannelAdapter,
  WebhookChannelAdapter,
  FeishuChannelAdapter,
} from './channel-adapters.js';
import { WeChatController } from './wechat-controller.js';

// V17 能力评分矩阵 — 8 维度 × 10 子项追踪 10/10 目标
import { CapabilityScoreMatrix } from './capability-score-matrix.js';
// V17 IoT 协议适配器 — HomeAssistant/MiHome/HomeKit/MQTT 真实适配器
import { IoTAdapterFactory } from './iot-protocol-adapters.js';
import { UnifiedDeviceControl } from './unified-device-control.js';
import { NLDeviceCommandParser } from './nl-device-command-parser.js';
// P3-3: 嵌入式轻量版 — 设备 profile 检测 + 模块裁剪 + 树莓派部署
import { EmbeddedLightweight } from '../platform/embedded-lightweight.js';

// ===== 工具层 =====
import { LibTVWorkFlow } from '../tools/libtv-workflow.js';
import { VideoPromptEngineer } from '../tools/video-prompt-engineer.js';
import { TestGenerator } from '../tools/test-generator.js';
import { DocGenerator } from '../tools/doc-generator.js';
import { ImageGenerator } from '../tools/image-generator.js';

// ===== ScalableToolRegistry =====
import { ScalableToolRegistry } from './scalable-tool-registry.js';
import { ToolRegistryAdapter } from './tool-registry-adapter.js';

// ===== 阶段三：Prompt 编排 + 上下文管理 =====
import { PromptOrchestrator } from './prompt-orchestrator.js';
import { ContextManager } from './context-manager.js';
import { ProjectKnowledge } from './project-knowledge.js';

// ============ 核心模块集合 ============

export interface CoreModules {
  // v16.0 核心系统
  modelLibrary: ModelLibrary;
  selfLearningSystem: SelfLearningSystem;
  autonomousThinker: AutonomousThinker;
  selfUpgradeSystem: SelfUpgradeSystem;

  // v17.0 核心模块
  nluEngine: NLUEngine;
  reasoningEngine: ReasoningEngine;
  performanceMetrics: PerformanceMetricsSystem;
  selfEvolutionEngine: SelfEvolutionEngine;
  feedbackSystem: FeedbackSystem;
  benchmark: Benchmark;
  evolutionEngine: AutonomousEvolutionEngine;
  adaptiveLearning: AdaptiveLearningSystem;
  moduleRegistry: ModuleRegistry;
  evolutionTrace: EvolutionTrace;
  diagnostics: SystemDiagnostics;
  knowledgeGraph: KnowledgeGraph;
  promptOptimizer: PromptOptimizer;
  autonomousCapabilities: AutonomousCapabilities;
  capabilityManager: CapabilityManager;
  workspace: CollaborativeWorkspace;
  videoEngine: VideoGenerationEngine;
  thinkingEngine: AutonomousThinkingEngine;
  personalization: PersonalizationEngine;

  // 自主意识系统
  cognitiveState: CognitiveState;
  selfAwareness: SelfAwareness;
  valueSystem: ValueSystem;
  goalSystem: GoalSystem;
  heartbeat: Heartbeat;
  subAgentOrchestrator: SubAgentOrchestrator;
  agentTeamOrchestrator: AgentTeamOrchestrator;
  backgroundAgentManager: BackgroundAgentManager;
  mcpMarketplace: MCPMarketplace;
  projectContext: ProjectContext;
  notificationService: NotificationService;
  webhookService: WebhookService;
  toolConsolidation: ToolConsolidation;
  cloudDeployment: CloudDeployment;
  /** P2-1/P2-2: 统一设备控制（IoT 适配器 + NL 命令解析） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unifiedDeviceControl: any;
  /** P3-3: 嵌入式轻量版（设备 profile + 模块裁剪 + 部署脚本） */
  embeddedLightweight: EmbeddedLightweight;
  selfEvolve: SelfEvolve;
  strategyEngine: StrategyEngine;
  skillExtractor: SkillExtractor;
  omniAssistant: OmniAssistant;
  selfAssessment: SelfAssessment;
  taskPlanner: TaskPlanner;
  functionalTestSuite: FunctionalTestSuite;
  contextCompressor: ContextCompressor;
  selfHealingEngine: SelfHealingEngine;
  unifiedToolFramework: UnifiedToolFramework;
  evolutionMetrics: EvolutionMetrics;
  longTermPlanner: LongTermPlanner;

  // 事件驱动 & 新核心模块
  eventBus: EventBus;
  skillSystem: SkillPackageSystem;
  mcpManager: MCPManager;

  // 增强版Agent Loop依赖
  shadowGit: ShadowGit;
  classifier: TwoStageClassifier;
  compressionPipeline: CompressionPipeline;

  // 记忆系统
  vectorStore: VectorStore;
  enhancedMemory: EnhancedMemory;
  memoryManager: InstanceType<typeof MemoryManager>;
  unifiedMemory: UnifiedMemory;

  // 服务集成
  serviceIntegrations: ServiceIntegrations;

  // Phase 2
  treeSitterAST: TreeSitterAST;
  gitWorktree: GitWorktreeManager;
  adversarialVerifier: AdversarialVerifier;

  // P0 Phase: 下一代智能
  dreamingEngine: DreamingEngine;
  proactiveEngine: ProactiveEngine;
  dreamingBridge: DreamingBridge;
  /** 四级记忆存储 — DreamingBridge 和 loop 共享的同一实例 */
  memoryStore: MemoryStore;
  toolMasking: ToolMaskingEngine;
  sessionReplay: SessionMemoryReplay;

  // Phase 3
  voiceSystem: VoiceSystem;
  videoGenReal: VideoGenerationReal;
  desktopControl: DesktopControl;
  /** V19 P0：应用 Profile + 工作流能力（应用孤岛串联） */
  universalDesktop: UniversalDesktop | null;
  /** V19 P0：无障碍 API 语义元素操作（UI 自动化，比视觉坐标更精确） */
  accessibilityController: AccessibilityController;

  // Phase 4
  continuousLearning: ContinuousLearningFramework;
  feedbackReward: FeedbackRewardSystem;
  evolutionAssessment: EvolutionAssessmentSystem;
  sessionPersistence: SessionPersistence;
  lspIntegration: LSPIntegration;
  performanceMonitor: PerformanceMonitor;
  smartCache: SmartCache;

  // Phase 5
  enhancedNLU: EnhancedNLU;
  codeReasoning: CodeReasoningEngine;
  contextRetention: ContextRetentionSystem;
  taskDecomposition: TaskDecompositionEngine;
  toolOptimizer: ToolIntegrationOptimizer;
  adaptiveInteraction: AdaptiveInteractionSystem;

  // Phase 6
  benchmarkFramework: BenchmarkFramework;
  optimizationRoadmap: OptimizationRoadmap;

  // Phase 7
  handoffSystem: HandoffSystem;
  diffEditor: DiffEditor;
  guardrailSystem: GuardrailSystem;
  traceCollector: TraceCollector;
  projectConfig: ProjectConfig;
  /** v20.0 项目分层记忆加载器 */
  projectMemoryLoader: ProjectMemoryLoader;
  /** v20.0 代码库语义索引器 */
  codebaseIndexer: CodebaseIndexer;
  /** v20.0 国产系统原生依赖适配器 */
  nativeDepsResolver: NativeDepsResolver;
  /** v20.0 专用子代理预设注册表 */
  subAgentPresetRegistry: SubAgentPresetRegistry;
  /** v20.0 斜杠命令系统（~/.duan/commands + .duan/commands） */
  slashCommandRegistry: SlashCommandRegistry;
  /** v20.0 动态上下文发现（对标 Cursor dynamic discovery） */
  contextDiscoverer: ContextDiscoverer;
  /** v20.0 多文件协同编辑（原子性多文件修改 + 失败回滚） */
  multiFileEditor: MultiFileEditor;
  /** v20.0 分级许可清单（对标 Claude Code permissions：会话/CLI/项目/全局四级） */
  toolPermissionRegistry: ToolPermissionRegistry;
  /** v20.0 角色人格系统（对标 MetaGPT：7 预设角色 + 自定义 + 角色间通信） */
  personaSystem: PersonaSystem;
  /** v20.0 长期目标追踪（对标 AutoGPT：目标树 + 进度持久化 + 自主迭代 + 中断恢复） */
  goalTracker: GoalTracker;
  /** v20.0 自主工程任务（对标 Devin：5 阶段流水线 + 失败重试 + 中断恢复 + 多部署目标） */
  autonomousEngineer: AutonomousEngineer;
  /** v20.0 多模态文档解析（PDF/Word/Excel/PPT/文本，动态加载外部库，缺失时优雅降级） */
  documentParser: DocumentParser;
  /** v20.0 §5.4 主动提问引擎（检测知识盲区/错误模式/兴趣信号时主动向用户提问） */
  proactiveQuestionEngine: ProactiveQuestionEngine;
  /** v20.0 §5.4 技能市场（统一门户，聚合管理各类技能资产的发布/浏览/下载/评分/推荐/举报） */
  skillMarket: SkillMarket;
  /** v20.0 §5.2 离线协调器（网络状态检测/本地模型检测/离线模式切换/离线知识库） */
  offlineCoordinator: OfflineCoordinator;
  /** v20.0 §5.4 学习进度可视化（学习曲线/能力雷达图/进度报告/趋势分析） */
  learningProgressVisualizer: LearningProgressVisualizer;
  /** v20.0 §3.5 模型微调能力（数据收集/格式化/训练调度/模型注册） */
  modelFineTuner: ModelFineTuner;
  /** v20.0 §5.3 协作能力（团队管理/共享会话/任务派发/团队知识库） */
  collaborationEngine: CollaborationEngine;
  /** v21.0 §1 增强版生命周期钩子管理器（6 新内置钩子 + 5 新事件 + update 动作） */
  enhancedLifecycleHookManager: LifecycleHookManager | null;
  /** v21.0 §2 AGENTS.md 三层记忆加载器（全局/项目/子目录 override，向上递归查找） */
  agentsMdLoader: AgentsMdLoader;
  /** v21.0 §2 AGENTS.md 初始化器（扫描项目结构生成 starter AGENTS.md） */
  agentsMdInitializer: AgentsMdInitializer;
  /** v21.0 §3 文件即接口上下文引擎（工具结果 >4KB 文件化 + 摘要 + 历史引用） */
  fileContextEngine: FileContextEngine;
  /** v21.0 §4 异步任务托管管理器（任务队列 + 进度追踪 + 结果通知 + 中断恢复 + 并行任务） */
  asyncTaskManager: AsyncTaskManager;
  /** v21.1 §B Spec-Driven Development 工件流程（spec/plan/tasks/checklist 四阶段） */
  specDrivenDev: SpecDrivenDev;
  /** v21.1 §C Repo Map 重要性排序（tree-sitter 符号评分 + 压缩上下文） */
  repoMap: RepoMap;
  /** v21.1 §D Plan Mode 可编辑计划（状态机 + 步骤追踪 + Markdown） */
  planMode: PlanMode;
  modelRouter: ModelRouter;
  outputParser: StructuredOutputParser;
  /** P0 真实修复：虚拟内存工作流 — todo.md + 长文外接存储 */
  virtualMemoryWorkflow: VirtualMemoryWorkflow;
  /** P0 真实修复：Brain 系统 — 深度理解 + 洞察发现 + 自我进化（之前是死代码） */
  brain: Brain;

  // Phase 8
  approvalGate: ApprovalGate;
  ethicsReviewEngine: EthicsReviewEngine;
  codeKnowledgeGraph: CodeKnowledgeGraph;
  sotaBenchmarkScheduler: SotaBenchmarkScheduler;
  selfHealing: SelfHealingPipeline;
  consistencyGuard: ConsistencyGuard;
  agentConfig: AgentConfig;
  contextSelector: ContextSelector;

  // 三大核心功能模块
  learningEval: LearningEvalSystem;
  skillGen: SkillGenerator;
  userProfile: UnifiedUserProfileCenter;
  /** P2-1: 用户偏好学习引擎 */
  userPreferenceEngine: UserPreferenceEngine;
  /** P2-2: GEPA 自进化引擎 */
  gepaEngine: GEPAEvolutionEngine;
  /** P2-3: SOP 角色流水线 */
  sopPipeline: SOPPipeline;
  /** P3-2: 知识图谱记忆 */
  kgMemory: KnowledgeGraphMemory;
  /** P1-3/P3-2: 共享嵌入提供者（OpenAI/TF-IDF/Composite），供 kgMemory、ContextManager、SmartToolSelector 共用 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  embeddingProvider: any;
  /** P2-4: 增强视觉智能引擎 */
  visualIntelligence: VisualIntelligence;
  /** P3-1: Agent 身份网络 */
  identityNetwork: AgentIdentityNetwork;
  /** P0 修复: 微信控制器 — 需注册给 LLM 工具表，否则 Agent 看不到 wechat_* 工具只能用 app_operate 硬操作 */
  wechatController: WeChatController | null;

  /** V17: 能力评分矩阵 — 8 维度 × 10 子项追踪 10/10 目标 */
  capabilityScoreMatrix: CapabilityScoreMatrix;

  // 工具层
  libtvWorkflow: LibTVWorkFlow;
  promptEngineer: VideoPromptEngineer;
  testGenerator: TestGenerator;
  docGenerator: DocGenerator;
  imageGenerator: ImageGenerator;

  /** 资源清理 — 清理定时器、事件监听器和模块内部状态 */
  dispose?: () => void;
  /** 异步释放 — 等待持久化完成后再清理（用于优雅关闭场景） */
  disposeAsync?: () => Promise<void>;
}

// ============ 创建核心模块 ============

export function createCoreModules(): CoreModules {
  // 定时器清理暂存区：在 cleanupFns 声明前创建的 setInterval/setTimeout 先存这里，
  // cleanupFns 声明后会统一 flush 进去（dispose 时统一清理）
  const pendingCleanupTimers: Array<() => void> = [];

  // P1-1: 生产环境默认启用 structured-output-enforcer 多策略降级
  // 避免 LLM 返回截断/单引号/尾逗号 JSON 时裸 JSON.parse 失败导致工具调用必然返回 {}
  // 仅在未显式配置时设置，尊重操作员显式 false 和测试环境默认关闭
  if (process.env.USE_STRUCTURED_OUTPUT_ENFORCER === undefined) {
    process.env.USE_STRUCTURED_OUTPUT_ENFORCER = 'true';
  }

  // ===== v16.0 核心系统（优先初始化） =====
  // 单例：所有下游消费者共享同一实例（LRU 缓存、客户端池、淘汰日志不重复）
  const modelLibrary = ModelLibrary.getInstance();
  const selfLearningSystem = new SelfLearningSystem(modelLibrary);
  const autonomousThinker = new AutonomousThinker(modelLibrary);
  const selfUpgradeSystem = new SelfUpgradeSystem(modelLibrary);

  // 注入到 toolContext（P0-4: agent-loop.ts 模块级全局已废弃，仅注入 toolContext）
  toolContext.modelLibrary = modelLibrary;
  toolContext.selfLearningSystem = selfLearningSystem;
  toolContext.selfUpgradeSystem = selfUpgradeSystem;

  // ===== 增强版Agent Loop依赖 =====
  const shadowGit = new ShadowGit();
  const classifier = new TwoStageClassifier();
  const compressionPipeline = new CompressionPipeline();
  // P0-2: 修复 CompressionPipeline 死代码 — setLLMClient 从未被调用，LLM 摘要永远降级为规则摘要
  // 从 modelLibrary 获取首个可用客户端注入，使 LLM 摘要真正生效（经 QueryEngine 重试/熔断保护）
  try {
    const availableModels = modelLibrary.getAvailableModels();
    if (availableModels.length > 0) {
      const firstModel = availableModels[0];
      const client = modelLibrary.getChatClient(firstModel.id);
      if (client) {
        compressionPipeline.setLLMClient({ client, model: firstModel.model });
      }
    }
  } catch { /* modelLibrary 未就绪时降级为规则摘要 */ }

  // ===== v17.0 原有模块 =====
  const nluEngine = new NLUEngine();
  // 注入深层意图分析器：当NLU规则匹配置信度低时，使用AutonomousThinker进行LLM辅助理解
  nluEngine.setDeepAnalyzer({
    analyze: async (text: string, context?: string[]) => {
      const ctxStr = context ? context.slice(-2).join('\n') : '';
      const result = await autonomousThinker.quickThink(
        `分析以下用户输入的真实意图和隐式需求。
用户输入: "${text}"
${ctxStr ? `对话上下文: "${ctxStr}"` : ''}
请返回JSON格式（不要有其他文字）:
{
  "deepIntent": "用户真正想做什么（一句话）",
  "implicitNeeds": ["隐式需求1", "隐式需求2"],
  "confidence": 0.0-1.0,
  "suggestions": ["处理建议1", "处理建议2"]
}`
      );
      if (!result) return { deepIntent: text, implicitNeeds: [], confidence: 0.3, suggestions: [] };
      try {
        const parsed = JSON.parse(result);
        return {
          deepIntent: parsed.deepIntent || text,
          implicitNeeds: parsed.implicitNeeds || [],
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
          suggestions: parsed.suggestions || [],
        };
      } catch {
        return { deepIntent: text, implicitNeeds: [], confidence: 0.4, suggestions: [] };
      }
    },
  });

  const reasoningEngine = new ReasoningEngine({
    llmReason: async (task, context, mode) => {
      if (!modelLibrary) return null;
      try {
        const prompt = `你是推理引擎，使用「${mode}」推理模式分析以下任务，输出结构化推理结果。

任务：${task}
上下文：${context.length > 0 ? context.map((c, i) => `[${i + 1}] ${c}`).join('\n') : '（无）'}

请返回 JSON：{"conclusion":"最终结论","steps":[{"step":1,"thought":"思考","action":"行动（可选）","observation":"观察（可选）","confidence":0.8,"justification":"理由"}],"confidence":0.8,"alternatives":["备选1"],"mode":"${mode}"}`;
        const resp = await modelLibrary.call([{ role: 'user', content: prompt }], { maxTokens: 1500, temperature: 0.4 });
        const raw = resp.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          conclusion: String(parsed.conclusion || ''),
          steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: any, i: number) => ({
            step: i + 1, thought: String(s.thought || ''),
            action: s.action ? String(s.action) : undefined,
            observation: s.observation ? String(s.observation) : undefined,
            confidence: typeof s.confidence === 'number' ? s.confidence : 0.7,
            justification: String(s.justification || ''),
          })) : [],
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
          alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String) : [],
          mode,
        };
      } catch { return null; }
    },
  });
  const performanceMetrics = new PerformanceMetricsSystem();
  // P0 修复 (Bug 3): 提前创建 EvolutionMetrics 单例并注入 SelfEvolutionEngine，
  // 避免 self-evolution-engine 内部 new 独立实例导致双实例隔离（19.9/100 根因之一）
  const evolutionMetrics = new EvolutionMetrics();
  const selfEvolutionEngine = new SelfEvolutionEngine(evolutionMetrics);
  const feedbackSystem = new FeedbackSystem();
  const benchmark = new Benchmark();

  const evolutionEngine = new AutonomousEvolutionEngine(
    performanceMetrics,
    selfEvolutionEngine,
    feedbackSystem,
    benchmark
  );

  const adaptiveLearning = new AdaptiveLearningSystem();
  const moduleRegistry = new ModuleRegistry();
  const evolutionTrace = new EvolutionTrace();
  const diagnostics = new SystemDiagnostics();
  const knowledgeGraph = new KnowledgeGraph();
  const promptOptimizer = new PromptOptimizer();
  const autonomousCapabilities = new AutonomousCapabilities();
  const capabilityManager = new CapabilityManager();
  const workspace = new CollaborativeWorkspace();
  const videoEngine = new VideoGenerationEngine();
  const thinkingEngine = new AutonomousThinkingEngine();
  const personalization = new PersonalizationEngine();

  // 注册核心模块到 ModuleRegistry
  const coreModuleEntries = [
    { id: 'evolution', name: '进化引擎', version: '19.0.0', provides: ['evolution', 'self_assessment'], instance: evolutionEngine },
    { id: 'learning', name: '学习系统', version: '19.0.0', provides: ['adaptive_learning'], instance: adaptiveLearning },
    { id: 'diagnostics', name: '诊断引擎', version: '19.0.0', provides: ['diagnostics', 'benchmark'], instance: diagnostics },
    { id: 'knowledge', name: '知识图谱', version: '19.0.0', provides: ['knowledge_query', 'knowledge_extract'], instance: knowledgeGraph },
    { id: 'prompt', name: '提示词优化', version: '19.0.0', provides: ['prompt_optimize', 'prompt_assess'], instance: promptOptimizer },
    { id: 'thinking', name: '自主思考', version: '19.0.0', provides: ['think', 'decide', 'plan'], instance: thinkingEngine },
    { id: 'workspace', name: '协同工作', version: '19.0.0', provides: ['workflow', 'task', 'agent'], instance: workspace },
    { id: 'video', name: '视频生成', version: '19.0.0', provides: ['flowchart', 'storyboard', 'video_gen'], instance: videoEngine },
    { id: 'capabilities', name: '自主能力', version: '19.0.0', provides: ['self_repair', 'self_learn', 'self_upgrade'], instance: autonomousCapabilities },
    { id: 'permissions', name: '权限管理', version: '19.0.0', provides: ['file_access', 'web_access', 'tool_permission'], instance: capabilityManager },
    { id: 'trace', name: '进化追溯', version: '19.0.0', provides: ['trace', 'explain'], instance: evolutionTrace },
  ];

  for (const mod of coreModuleEntries) {
    moduleRegistry.register({
      id: mod.id,
      name: mod.name,
      version: mod.version,
      description: mod.name,
      provides: mod.provides,
      instance: mod.instance,
    });
  }

  // ===== 自主意识系统 =====
  const cognitiveState = new CognitiveState();
  const selfAwareness = new SelfAwareness();
  const valueSystem = new ValueSystem();
  const goalSystem = new GoalSystem();

  const subAgentOrchestrator = new SubAgentOrchestrator(selfAwareness, cognitiveState);
  // 从 agents/*.md 加载 SubAgent 配置（code-analyzer, code-implementer, refactor-architect, test-engineer）
  try {
    const loaded = subAgentOrchestrator.loadAgentsFromDirectory();
    if (loaded > 0) {
      selfAwareness.addInsight({
        content: `从 agents/ 目录加载了 ${loaded} 个 SubAgent 配置`,
        category: 'self_discovery',
        significance: 0.5,
      });
    }
  } catch {
    // 加载失败静默降级，使用内置 BUILTIN_SUB_AGENTS
  }
  toolContext.subAgentOrchestrator = subAgentOrchestrator;

  const agentTeamOrchestrator = new AgentTeamOrchestrator();
  toolContext.agentTeamOrchestrator = agentTeamOrchestrator;

  const backgroundAgentManager = new BackgroundAgentManager();
  toolContext.backgroundAgentManager = backgroundAgentManager;

  const heartbeat = new Heartbeat(cognitiveState, selfAwareness, goalSystem, valueSystem, selfLearningSystem);

  const selfEvolve = new SelfEvolve();
  toolContext.selfEvolve = selfEvolve;

  const strategyEngine = new StrategyEngine();

  const skillExtractor = new SkillExtractor();
  const selfAssessment = new SelfAssessment();

  const taskPlanner = new TaskPlanner();
  toolContext.taskPlanner = taskPlanner;

  const functionalTestSuite = new FunctionalTestSuite();
  toolContext.functionalTestSuite = functionalTestSuite;

  const contextCompressor = new ContextCompressor();
  toolContext.contextCompressor = contextCompressor;

  const selfHealingEngine = new SelfHealingEngine();
  toolContext.selfHealingEngine = selfHealingEngine;
  // P0 D3.3 修复：实际启动自愈引擎的定期巡检 — 之前仅 new 不 startAutoHeal，自愈能力为死代码
  // 间隔 120s（保守值，避免在生产环境过度占用 CPU）
  selfHealingEngine.startAutoHeal(120000);

  // D8 自我修复：启动时损坏守卫 — 扫描 ~/.duan/ 和 .awareness/ 下 JSON，损坏则备份+重建
  try {
    const guardResult = runCorruptionGuard();
    if (guardResult.corrupted > 0) {
      logger.warn('CorruptionGuard 启动检查：检测到损坏文件', {
        module: 'Bootstrap',
        scanned: guardResult.scanned,
        corrupted: guardResult.corrupted,
        repaired: guardResult.repaired,
        failed: guardResult.failed,
        backupFailed: guardResult.backupFailed,
      });
      if (guardResult.backupFailed > 0) {
        logger.error('CorruptionGuard：有文件备份失败，原内容永久丢失，需人工核查', {
          module: 'Bootstrap',
          backupFailedCount: guardResult.backupFailed,
          files: guardResult.details
            .filter(d => d.backupFailed)
            .map(d => d.file),
        });
      }
    }
  } catch (e: unknown) {
    logger.warn('CorruptionGuard 启动检查失败（不阻断启动）', {
      module: 'Bootstrap',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // P0 自我改进接通：定期触发 SelfEvolutionEngine.evolve() — 之前引擎真实存在但 evolve() 从不被调用
  // 间隔 6 小时（21600000ms），fire-and-forget + catch，失败不阻塞主循环
  try {
    const selfEvolutionIntervalId = setInterval(() => {
      void selfEvolutionEngine.evolve().catch((e: unknown) => {
        logger.warn('SelfEvolutionEngine.evolve() 定期触发失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
      });
    }, 6 * 60 * 60 * 1000);
    // 注册到 cleanupFns（在下方声明后立即注册，dispose 时清理避免定时器泄漏）
    pendingCleanupTimers.push(() => clearInterval(selfEvolutionIntervalId));
    logger.info('SelfEvolutionEngine 已接通：每 6 小时自动执行一轮进化', { module: 'Bootstrap' });
  } catch (e: unknown) {
    logger.warn('SelfEvolutionEngine 定期触发注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  const unifiedToolFramework = new UnifiedToolFramework({ autoApproveSafe: true });
  toolContext.unifiedToolFramework = unifiedToolFramework;

  // P0 修复 (Bug 3): 复用上方已创建并注入 SelfEvolutionEngine 的 evolutionMetrics 单例
  // 原代码 `new EvolutionMetrics()` 创建第二个独立实例，导致 self_metrics 工具读不到 self-evolution-engine 的写入
  toolContext.evolutionMetrics = evolutionMetrics;

  const longTermPlanner = new LongTermPlanner();
  toolContext.longTermPlanner = longTermPlanner;

  toolContext.skillExtractor = skillExtractor;

  const omniAssistant = new OmniAssistant();
  toolContext.omniAssistant = omniAssistant;

  // ===== 事件驱动 & 新核心模块 =====
  const eventBus = EventBus.getInstance();
  // P0 D2: 使用 SkillPackageSystem/MCPManager 默认路径（已迁移到 duanPath），
  // 不再硬编码 '.duan/...' 相对路径，避免 CWD 不同时丢失配置
  const skillSystem = new SkillPackageSystem();
  const mcpManager = new MCPManager();
  const mcpMarketplace = MCPMarketplace.getInstance();
  toolContext.mcpMarketplace = mcpMarketplace;

  // 异步初始化（不阻塞启动）
  skillSystem.initialize().catch(err => {
    logger.warn('技能系统初始化失败 — 技能包功能将不可用', { error: err?.message });
  });
  // P0 资源消耗：移除死代码 — MCP 工具注册到 LazyToolRegistry 无消费者（LazyToolRegistry 已删除）。
  // MCP 工具的真实注册在 createAgentLoop() 中通过 loop.registerTools() 完成。
  // 此处仅保留 initialize() 调用预热，避免重复注册浪费内存。
  mcpManager.initialize().catch(err => {
    logger.warn('MCP 管理器初始化失败 — MCP 工具将不可用', { error: err?.message });
  });

  // 注入 LLM Caller 库到工具层
  injectLLMCallerLibrary(modelLibrary);

  // ===== 记忆系统 =====
  // P0 跨平台修复：使用统一的 duanPath 解析（默认 ~/.duan，可用 DUAN_DATA_DIR 覆盖）
  const vectorStore = new VectorStore(duanPath('vectors.json'));
  const enhancedMemory = new EnhancedMemory(duanPath());
  const memoryManager = new MemoryManager(duanPath());
  const unifiedMemory = new UnifiedMemory({
    vectorStore,
    enhancedMemory,
    memoryManager,
    memoryDir: duanPath('memories'),
  });

  // ===== 服务集成 =====
  const serviceIntegrations = new ServiceIntegrations();

  // ===== Phase 2: Codex核心能力 =====
  const treeSitterAST = new TreeSitterAST();
  const gitWorktree = new GitWorktreeManager();
  const adversarialVerifier = new AdversarialVerifier(modelLibrary);

  // ===== P0 Phase: 下一代智能 =====
  const dreamingEngine = new DreamingEngine();
  dreamingEngine.setExtractResolver(async (content: string) => {
    try {
      const available = modelLibrary.getAvailableModels();
      const first = modelLibrary.getFirstChatClient();
      if (!first) return '{}';
      const modelId = first.modelId;
      const client = first.client;
      const entry = available.find(m => m.id === modelId);
      const resp = await client.chat.completions.create({
        model: entry?.model || modelId,
        messages: [{ role: 'user', content }],
        max_tokens: 2000,
        temperature: 0.1,
      });
      return resp.choices?.[0]?.message?.content || '{}';
    } catch { return '{}'; }
  });

  const proactiveEngine = new ProactiveEngine();

  /** 资源清理函数集合 — 在 dispose() 时统一调用（提前声明以便后续模块注册） */
  const cleanupFns: Array<() => void> = [];
  // flush 暂存的定时器清理函数（在 cleanupFns 声明前创建的 setInterval 等）
  cleanupFns.push(...pendingCleanupTimers);

  // ===== DreamingBridge: 双向同步 DreamingEngine ↔ MemoryStore =====
  const memoryStore = new MemoryStore();
  const dreamingBridge = new DreamingBridge(memoryStore, dreamingEngine);
  dreamingBridge.start(120000);
  cleanupFns.push(() => { try { dreamingBridge.stop(); } catch {} });

  // V19 P0：接入 ContinuousEvolutionSystem — 定时进化（每日爬取全球智能体→分析→对比→学习注入）
  // 之前类已声明调度周期但无 cron/heartbeat 触发，能力空转；此处用 setInterval 接入
  // 不调用 start()：其内置 24h 间隔且无首次早触发，首轮仍会空转 24h，与"不再空转"目标冲突
  let continuousEvolution: ContinuousEvolutionSystem | null = null;
  let evolutionKickoffTimer: NodeJS.Timeout | null = null;
  let evolutionTimer: NodeJS.Timeout | null = null;
  try {
    continuousEvolution = new ContinuousEvolutionSystem('./data/evolution');
    // V19：用 setInterval 模拟每日触发（实际每 24 小时，这里用 6 小时避免首轮等待太久）
    // 首次启动延迟 5 分钟，避免启动期资源争抢
    evolutionKickoffTimer = setTimeout(() => {
      try {
        continuousEvolution?.runDailyCycle?.().catch((e: unknown) => {
          logger.warn('ContinuousEvolution runDailyCycle 失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
        });
      } catch {}
      // 之后每 6 小时触发一次
      evolutionTimer = setInterval(() => {
        try {
          continuousEvolution?.runDailyCycle?.().catch((e: unknown) => {
            logger.warn('ContinuousEvolution runDailyCycle 失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
          });
        } catch {}
      }, 6 * 60 * 60 * 1000);
    }, 5 * 60 * 1000);
    logger.info('ContinuousEvolutionSystem 已调度（首次 5 分钟后，之后每 6 小时）', { module: 'Bootstrap' });
  } catch (e) {
    logger.warn('ContinuousEvolutionSystem 初始化失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }
  // 定时器清理 — 注册到统一 cleanupFns，dispose()/disposeAsync() 均会触发
  cleanupFns.push(() => {
    try {
      if (evolutionKickoffTimer) {
        clearTimeout(evolutionKickoffTimer);
        evolutionKickoffTimer = null;
      }
      if (evolutionTimer) {
        clearInterval(evolutionTimer);
        evolutionTimer = null;
      }
      continuousEvolution?.stop?.();
      continuousEvolution = null;
    } catch {}
  });

  // ===== ToolMaskingEngine: 状态机工具精简 =====
  const toolMasking = new ToolMaskingEngine();

  // ===== SessionMemoryReplay: 跨会话记忆回放 =====
  const sessionReplay = new SessionMemoryReplay();

  // 连接 ProactiveEngine → BackgroundAgentManager
  proactiveEngine.setBackgroundSpawner((goal: string, context?: string) => {
    return backgroundAgentManager.spawn({
      name: `auto_trigger_${Date.now()}`,
      goal,
      context,
      priority: 'normal',
      tokenBudget: 20000,
      maxTurns: 30,
      createdBy: 'ProactiveEngine',
    });
  });

  // ===== Phase 3: 全能多模态 =====
  const voiceSystem = new VoiceSystem(modelLibrary);
  const videoGenReal = new VideoGenerationReal();
  const desktopControl = new DesktopControl(modelLibrary);

  // V19 P0：接入 UniversalDesktop — 应用 Profile + 工作流能力
  let universalDesktop: UniversalDesktop | null = null;
  try {
    universalDesktop = new UniversalDesktop(modelLibrary);
    logger.info('UniversalDesktop 初始化完成', { module: 'Bootstrap' });
  } catch (e) {
    logger.warn('UniversalDesktop 初始化失败，主循环继续', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // V19 P0：接入 AccessibilityController — 无障碍 API 语义元素操作
  const accessibilityController = new AccessibilityController();

  // ===== Phase 4: 自主学习与进化升级 =====
  const continuousLearning = new ContinuousLearningFramework(modelLibrary);
  const feedbackReward = new FeedbackRewardSystem(modelLibrary);
  const evolutionAssessment = new EvolutionAssessmentSystem(modelLibrary);
  const sessionPersistence = new SessionPersistence();
  toolContext.sessionPersistence = sessionPersistence;
  const lspIntegration = new LSPIntegration();
  const performanceMonitor = new PerformanceMonitor();
  const smartCache = new SmartCache();

  // ===== Phase 5: 系统性优化升级 =====
  const enhancedNLU = new EnhancedNLU(modelLibrary);
  const codeReasoning = new CodeReasoningEngine(modelLibrary);
  const contextRetention = new ContextRetentionSystem();
  const taskDecomposition = new TaskDecompositionEngine(modelLibrary);
  const toolOptimizer = new ToolIntegrationOptimizer();
  const adaptiveInteraction = new AdaptiveInteractionSystem();

  // ===== Phase 6: 基准测试与优化路线图 =====
  const benchmarkFramework = new BenchmarkFramework(modelLibrary);
  const optimizationRoadmap = new OptimizationRoadmap();

  // ===== Phase 7: 路线图P0/P1实现 =====
  const handoffSystem = new HandoffSystem(modelLibrary);
  const diffEditor = new DiffEditor();
  const guardrailSystem = new GuardrailSystem();
  const traceCollector = new TraceCollector();
  // P0 真实修复：实例化 VirtualMemoryWorkflow（之前从未实例化，类完整但悬空）
  const virtualMemoryWorkflow = new VirtualMemoryWorkflow();
  // P0 真实修复：实例化 Brain（之前是死代码，bootstrap 不导入，全局无 new Brain()）
  const brain = new Brain();
  // 异步初始化 Brain（加载持久化数据、连接 AI API）
  brain.init().catch(err => logger.warn('Brain 初始化失败', { error: err?.message }));
  const projectConfig = new ProjectConfig();
  const projectContext = new ProjectContext();
  // v20.0 项目分层记忆加载器（对标 CLAUDE.md 多层级记忆）
  const projectMemoryLoader = new ProjectMemoryLoader();
  // v20.0 代码库语义索引器（对标 Cursor codebase indexing）
  const codebaseIndexer = new CodebaseIndexer();
  // v20.0 国产系统原生依赖适配器（UOS/麒麟/LoongArch 适配）
  const nativeDepsResolver = new NativeDepsResolver();
  // v20.0 专用子代理预设注册表（8 类预设 + 意图识别派发）
  const subAgentPresetRegistry = new SubAgentPresetRegistry();
  // v20.0 斜杠命令系统（对标 Claude Code .claude/commands，支持 $ARGUMENTS 等占位符）
  const slashCommandRegistry = new SlashCommandRegistry();
  // v20.0 动态上下文发现（对标 Cursor dynamic discovery，三来源综合 + token 预算裁剪）
  const contextDiscoverer = new ContextDiscoverer();
  contextDiscoverer.setCodebaseIndexer(codebaseIndexer);
  // v20.0 多文件协同编辑（原子性多文件修改 + 失败回滚）
  const multiFileEditor = new MultiFileEditor();
  // v20.0 分级许可清单（对标 Claude Code permissions：会话/CLI/项目/全局四级）
  const toolPermissionRegistry = new ToolPermissionRegistry();
  try {
    toolPermissionRegistry.load();
  } catch (err: unknown) {
    logger.warn('ToolPermissionRegistry 加载失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 角色人格系统（对标 MetaGPT：7 预设角色 + 自定义 + 角色间通信）
  const personaSystem = new PersonaSystem();
  try {
    personaSystem.loadCustom();
  } catch (err: unknown) {
    logger.warn('PersonaSystem 加载自定义角色失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 长期目标追踪（对标 AutoGPT：目标树 + 进度持久化 + 自主迭代 + 中断恢复）
  const goalTracker = new GoalTracker();
  try {
    void goalTracker.initialize();
  } catch (err: unknown) {
    logger.warn('GoalTracker 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 自主工程任务（对标 Devin：5 阶段流水线 + 失败重试 + 中断恢复 + 多部署目标）
  const autonomousEngineer = new AutonomousEngineer();
  try {
    void autonomousEngineer.initialize();
  } catch (err: unknown) {
    logger.warn('AutonomousEngineer 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 多模态文档解析（PDF/Word/Excel/PPT/文本，动态加载外部库，缺失时优雅降级）
  const documentParser = new DocumentParser();
  // v20.0 §5.4 主动提问引擎（检测知识盲区/错误模式/兴趣信号时主动向用户提问）
  const proactiveQuestionEngine = new ProactiveQuestionEngine();
  try {
    void proactiveQuestionEngine.initialize();
  } catch (err: unknown) {
    logger.warn('ProactiveQuestionEngine 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 §5.4 技能市场（统一门户，聚合管理各类技能资产）
  const skillMarket = SkillMarket.getInstance();
  try {
    skillMarket.initialize();
  } catch (err: unknown) {
    logger.warn('SkillMarket 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 §5.2 离线协调器（网络检测/本地模型/离线模式/知识库）
  const offlineCoordinator = OfflineCoordinator.getInstance();
  try {
    offlineCoordinator.initialize();
  } catch (err: unknown) {
    logger.warn('OfflineCoordinator 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 §5.4 学习进度可视化（学习曲线/能力雷达图/进度报告）
  const learningProgressVisualizer = LearningProgressVisualizer.getInstance();
  try {
    learningProgressVisualizer.initialize();
  } catch (err: unknown) {
    logger.warn('LearningProgressVisualizer 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 §3.5 模型微调能力（数据收集/格式化/训练调度/模型注册）
  const modelFineTuner = ModelFineTuner.getInstance();
  try {
    modelFineTuner.initialize();
  } catch (err: unknown) {
    logger.warn('ModelFineTuner 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }
  // v20.0 §5.3 协作能力（团队管理/共享会话/任务派发/团队知识库）
  const collaborationEngine = CollaborationEngine.getInstance();
  try {
    collaborationEngine.initialize();
  } catch (err: unknown) {
    logger.warn('CollaborationEngine 初始化失败（非致命）', { error: err instanceof Error ? err.message : String(err) });
  }

  // ===== v21.0 主流 Agent 对标升级（4 项 P0） =====

  // §1 Hooks 生命周期系统增强（对标 Claude Code）
  // 6 新内置钩子 + 5 新事件 + update 动作
  // 默认开启全部 6 个新钩子，可通过 options 关闭单项
  let enhancedLifecycleHookManager: LifecycleHookManager | null = null;
  try {
    const enhancedHooks = createEnhancedLifecycleHookManager({
      cwd: process.cwd(),
      enableProjectContext: true,
      enableStopNotification: true,
      enablePreCompactGit: true,
      enableAutoFormat: true,
      enableDangerousCommandBlock: true,
      enablePromptSafety: true,
    });
    enhancedLifecycleHookManager = enhancedHooks.manager;
    logger.info('v21.0 §1: 增强版生命周期钩子管理器已创建（6 新内置钩子 + 5 新事件 + update 动作）', {
      module: 'Bootstrap',
      hooksCount: enhancedHooks.manager.getHooks().length,
    });
  } catch (err: unknown) {
    logger.warn('v21.0 §1: 增强版生命周期钩子管理器创建失败（非致命）', {
      module: 'Bootstrap',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // §2 AGENTS.md 三层记忆体系（对标 Codex CLI）
  // 全局/项目/子目录 override，向上递归查找，冲突时深层覆盖浅层
  const agentsMdLoader = new AgentsMdLoader();
  const agentsMdInitializer = new AgentsMdInitializer();
  logger.info('v21.0 §2: AGENTS.md 三层记忆加载器已创建', { module: 'Bootstrap' });

  // §3 文件即接口上下文工程（对标 Cursor）
  // 工具结果 >4KB 文件化 + 摘要（前 500 + tail 200）+ 历史引用
  // 节省 40%+ Token，超长上下文不再撑爆 LLM 上下文窗口
  let fileContextEngine: FileContextEngine;
  try {
    fileContextEngine = new FileContextEngine({
      threshold: 4096, // 4KB
      summaryHead: 500,
      summaryTail: 200,
      maxFiles: 100,
    });
    logger.info('v21.0 §3: 文件即接口上下文引擎已创建（阈值 4KB，最大 100 文件）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    // 降级：使用默认配置
    fileContextEngine = new FileContextEngine();
    logger.warn('v21.0 §3: 文件即接口上下文引擎使用默认配置', {
      module: 'Bootstrap',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // §4 异步任务托管模式（对标 Devin）
  // 任务队列 + 进度追踪 + 结果通知 + 中断恢复 + 并行任务 + 任务模板
  // 用户可"分配任务后去做别的"，适合长耗时任务（代码审查/批量测试/文档生成/大规模重构）
  const asyncTaskManager = new AsyncTaskManager({
    maxConcurrent: 3,
  });
  logger.info('v21.0 §4: 异步任务托管管理器已创建（maxConcurrent=3）', { module: 'Bootstrap' });

  // ===== v21.1 主流 Agent 差异化能力补全（4 项 P0） =====

  // §B Spec-Driven Development（对标 GitHub Spec Kit）
  // spec/plan/tasks/checklist 四阶段工件流程，解决"氛围编程目标漂移"问题
  let specDrivenDev: SpecDrivenDev;
  try {
    specDrivenDev = new SpecDrivenDev({ cwd: process.cwd() });
    logger.info('v21.1 §B: Spec-Driven Development 模块已创建', { module: 'Bootstrap' });
  } catch (err) {
    specDrivenDev = new SpecDrivenDev();
    logger.warn('v21.1 §B: Spec-Driven Development 使用默认配置', {
      module: 'Bootstrap',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // §C Repo Map 重要性排序（对标 Aider RepoMap）
  // 基于 tree-sitter 符号评分 + 压缩上下文，比暴力塞全文省 token 且更准
  const repoMap = new RepoMap({
    cwd: process.cwd(),
    tokenBudget: 4096,
    cacheTtlMs: 60000,
    treeSitterAST: treeSitterAST ?? null,
  });
  logger.info('v21.1 §C: Repo Map 重要性排序模块已创建（tokenBudget=4096）', { module: 'Bootstrap' });

  // §D Plan Mode 可编辑计划（对标 Cursor Plan Mode）
  // 状态机 + 步骤追踪 + Markdown，先生成可编辑计划再执行
  const planMode = new PlanMode();
  try {
    planMode.load();
    logger.info('v21.1 §D: Plan Mode 可编辑计划模块已创建（已加载持久化数据）', { module: 'Bootstrap' });
  } catch (err) {
    logger.warn('v21.1 §D: Plan Mode 加载持久化数据失败（非致命）', {
      module: 'Bootstrap',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  toolContext.projectContext = projectContext;

  const notificationService = new NotificationService();
  toolContext.notificationService = notificationService;

  const webhookService = new WebhookService();
  toolContext.webhookService = webhookService;

  // 初始化统一通道管理器（读取 channels.* 配置）
  try {
    const channelManager = getChannelManager();
    const channelConfigs = channelManager.loadConfig();
    for (const cfg of channelConfigs) {
      const id = cfg.label || cfg.type;
      channelManager.registerChannel(id, cfg);
    }
  } catch { /* 通道管理器加载失败不影响主流程 */ }

  const toolConsolidation = new ToolConsolidation();
  toolContext.toolConsolidation = toolConsolidation;

  const cloudDeployment = new CloudDeployment();
  toolContext.cloudDeployment = cloudDeployment;
  const modelRouter = new ModelRouter();
  const outputParser = new StructuredOutputParser();

  // ===== Phase 8: 路线图P0/P1/P2深度实现 =====
  const approvalGate = new ApprovalGate();
  const ethicsReviewEngine = new EthicsReviewEngine();
  // #2 代码知识图谱：基于 TreeSitterAST 解析源码，sink 进 KnowledgeGraph
  const codeKnowledgeGraph = new CodeKnowledgeGraph(knowledgeGraph, treeSitterAST);
  // #3 SOTA 基准挑战：月度跑 benchmark + 比对 SOTA + 自动注入 roadmap
  const sotaBenchmarkScheduler = new SotaBenchmarkScheduler(benchmarkFramework, optimizationRoadmap);
  const selfHealing = new SelfHealingPipeline();
  const consistencyGuard = new ConsistencyGuard();
  const agentConfig = new AgentConfig();
  const contextSelector = new ContextSelector();

  // ===== 三大核心功能模块 =====
  const learningEval = new LearningEvalSystem();
  const skillGen = new SkillGenerator();
  const userProfile = new UnifiedUserProfileCenter();

  // P2-1: 用户偏好学习引擎 — 双向量状态 + 三步循环 + persona prompt
  const userPreferenceEngine = new UserPreferenceEngine(userProfile);
  userPreferenceEngine.startSession('default', `session_${Date.now()}`);

  // P2-2: GEPA 自进化引擎 — 行为记录→效果评估→技能沉淀闭环
  const gepaEngine = new GEPAEvolutionEngine(modelLibrary, process.cwd());

  // P2-3: SOP 角色流水线 — 5角色装配线 + pub/sub 消息机制
  const sopPipeline = new SOPPipeline();
  // P2-3: 注入 LLM 调用器 — 修复 5 角色 execute 全为 stub 的问题
  // 修复前：execute: async (input) => input — 流水线必然在 qualityChecks 失败
  // 修复后：每个角色调用 LLM 生成 PRD/方案/代码/验证/交付，LLM 不可用时降级为规则模板
  sopPipeline.setLLMCaller(async (prompt: string): Promise<string | null> => {
    try {
      const available = modelLibrary.getAvailableModels();
      const first = modelLibrary.getFirstChatClient();
      if (!first) return null;
      const modelId = first.modelId;
      const client = first.client;
      const entry = available.find(m => m.id === modelId);
      const resp = await client.chat.completions.create({
        model: entry?.model || modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.3,
      });
      return resp.choices?.[0]?.message?.content || null;
    } catch (e: unknown) {
      logger.warn('P2-3 SOP Pipeline LLM 调用失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  });

  // P3-2: 知识图谱记忆 — 实体-关系-属性三元组 + 混合召回
  const kgMemory = new KnowledgeGraphMemory(process.cwd());

  // P2-4: 增强视觉智能引擎 — 多层级屏幕理解 + UI 元素检测 + OCR
  // 提前创建以支持在下方注入 EmbeddingProvider（crossModalSearch 升级为真实向量检索）
  const visualIntelligence = new VisualIntelligence(modelLibrary);
  // V19 P0：注入 AccessibilityController — 启用 hybridClick 融合点击（Accessibility 优先，视觉降级）
  visualIntelligence.setAccessibilityController(accessibilityController);

  // P1-3/P3-2: 注入真实语义向量嵌入提供者 — 替换 128 维词袋哈希
  // 优先 OpenAI embeddings API（真实 1536 维神经网络语义向量）
  // 降级 TF-IDF（真实 512 维统计向量，带词汇学习 + IDF 加权）
  // P1-3: 同一 provider 实例还注入到 ContextManager 和 SmartToolSelector（共享语义嵌入源）
  let sharedEmbeddingProvider: EmbeddingProvider | null = null;
  try {
    const tfidfProvider = new TfidfEmbeddingProvider(512, 5000);
    let primaryProvider: EmbeddingProvider = tfidfProvider;

    // 尝试使用 OpenAI 兼容客户端作为主嵌入提供者
    const available = modelLibrary.getAvailableModels();
    const allClients = modelLibrary.getAllClients();
    if (allClients.length > 0) {
      // 找到第一个 OpenAI 兼容的客户端（支持 embeddings.create）
      for (const { modelId, client } of allClients) {
        const entry = available.find(m => m.id === modelId);
        if (!entry) continue;
        // OpenAI / OpenAI 兼容 / Ollama 客户端都支持 embeddings.create
        // 用 'chat' in client 类型守卫将 client 收窄为 OpenAI，避免 as any
        if ('chat' in client && (entry.provider === 'openai_compatible' || entry.provider === 'ollama')) {
          try {
            const openaiProvider = new OpenAIEmbeddingProvider(client, 'text-embedding-3-small');
            primaryProvider = new CompositeEmbeddingProvider(openaiProvider, tfidfProvider);
            logger.info('P3-2 嵌入提供者：OpenAI 主提供者已配置（支持降级到 TF-IDF）', {
              modelId,
              provider: entry.provider,
            });
            break;
          } catch (e: unknown) {
            logger.warn('P3-2 OpenAI 嵌入提供者创建失败，仅使用 TF-IDF', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    } else {
      logger.info('P3-2 嵌入提供者：无可用 OpenAI 客户端，使用 TF-IDF 统计嵌入');
    }

    kgMemory.setEmbeddingProvider(primaryProvider);
    sharedEmbeddingProvider = primaryProvider;

    // P0 真实修复：将 CompositeEmbeddingProvider 注入到 VectorStore
    // 之前 VectorStore 直接硬编码 `import { OpenAI }` + `text-embedding-3-small`，
    // 无法享受 TF-IDF 自动降级，且与项目其他模块的嵌入来源割裂。
    // 注入后 VectorStore 的 add/addBatch/search 全部走 CompositeEmbeddingProvider，
    // API 不可用时自动降级到 TF-IDF，避免完全丢失向量检索能力。
    try {
      vectorStore.setEmbeddingProvider(primaryProvider);
      logger.info('P0: VectorStore 已注入 CompositeEmbeddingProvider（替换硬编码 OpenAI 调用）', {
        provider: primaryProvider.name,
        dimension: primaryProvider.dimension,
      });
    } catch (err: unknown) {
      logger.warn('P0: VectorStore 注入 EmbeddingProvider 失败，将回退到硬编码 OpenAI', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // P0 真实修复：将 CompositeEmbeddingProvider 注入到 VisualIntelligence
    // 之前 crossModalSearch 是关键词子串匹配 + 硬编码 score 0.7。
    // 注入后使用真实语义向量 + 余弦相似度排序。
    try {
      visualIntelligence.setEmbeddingProvider(primaryProvider);
      logger.info('P0: VisualIntelligence 已注入 CompositeEmbeddingProvider（crossModalSearch 升级为真实向量检索）', {
        provider: primaryProvider.name,
      });
    } catch (err: unknown) {
      logger.warn('P0: VisualIntelligence 注入 EmbeddingProvider 失败', { error: err instanceof Error ? err.message : String(err) });
    }
  } catch (err: unknown) {
    logger.warn('P3-2 嵌入提供者初始化失败，kgMemory 将降级为词袋哈希', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // P2-4: 增强视觉智能引擎 — 已在上文提前创建并注入 EmbeddingProvider

  // P3-1: Agent 身份网络 — 独立身份 + 声誉/信任评分 + 跨渠道同步
  const identityNetwork = new AgentIdentityNetwork();

  // P0 修复: 声明为函数级变量，以便注册给 LLM 工具表（原为 try 块内局部变量，工具无法注册给 LLM）
  let wechatController: WeChatController | null = null;

  // P4: 注册真实渠道适配器 — 启用跨渠道真实消息投递
  // 从环境变量读取渠道配置，配置了哪个就注册哪个适配器
  try {
    // 微信适配器（仅 Windows 平台 + WeChatController 可用时启用）
    if (process.platform === 'win32') {
      try {
        wechatController = new WeChatController(modelLibrary);
        const wechatAdapter = new WeChatChannelAdapter(wechatController);
        if (wechatAdapter.isReady()) {
          identityNetwork.registerChannelAdapter(wechatAdapter);
        } else {
          logger.info('P4 WeChat 适配器不可用（控制器未就绪），跳过注册');
        }
      } catch (err: unknown) {
        logger.warn('P4 WeChat 适配器初始化失败', { error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      logger.info('P4 WeChat 适配器：非 Windows 平台，跳过注册', { platform: process.platform });
    }

    // 飞书适配器（通过飞书自定义机器人 webhook）
    const feishuWebhookUrl = process.env.FEISHU_WEBHOOK_URL;
    const feishuSecret = process.env.FEISHU_WEBHOOK_SECRET;
    if (feishuWebhookUrl) {
      try {
        const feishuAdapter = new FeishuChannelAdapter({
          webhookUrl: feishuWebhookUrl,
          secret: feishuSecret,
        });
        if (feishuAdapter.isReady()) {
          identityNetwork.registerChannelAdapter(feishuAdapter);
          logger.info('P4 飞书适配器已注册', { webhookUrl: feishuWebhookUrl });
        }
      } catch (err: unknown) {
        logger.warn('P4 飞书适配器初始化失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Web / API 适配器（通过通用 webhook）
    const webWebhookUrl = process.env.WEB_WEBHOOK_URL;
    if (webWebhookUrl) {
      try {
        const webAdapter = new WebhookChannelAdapter({
          channel: 'web',
          webhookUrl: webWebhookUrl,
        });
        if (webAdapter.isReady()) {
          identityNetwork.registerChannelAdapter(webAdapter);
          logger.info('P4 Web 适配器已注册', { webhookUrl: webWebhookUrl });
        }
      } catch (err: unknown) {
        logger.warn('P4 Web 适配器初始化失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const apiWebhookUrl = process.env.API_WEBHOOK_URL;
    if (apiWebhookUrl) {
      try {
        const apiAdapter = new WebhookChannelAdapter({
          channel: 'api',
          webhookUrl: apiWebhookUrl,
        });
        if (apiAdapter.isReady()) {
          identityNetwork.registerChannelAdapter(apiAdapter);
          logger.info('P4 API 适配器已注册', { webhookUrl: apiWebhookUrl });
        }
      } catch (err: unknown) {
        logger.warn('P4 API 适配器初始化失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const emailWebhookUrl = process.env.EMAIL_WEBHOOK_URL;
    if (emailWebhookUrl) {
      try {
        const emailAdapter = new WebhookChannelAdapter({
          channel: 'email',
          webhookUrl: emailWebhookUrl,
        });
        if (emailAdapter.isReady()) {
          identityNetwork.registerChannelAdapter(emailAdapter);
          logger.info('P4 Email 适配器已注册', { webhookUrl: emailWebhookUrl });
        }
      } catch (err: unknown) {
        logger.warn('P4 Email 适配器初始化失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const registered = identityNetwork.getRegisteredChannelAdapters();
    logger.info('P4 渠道适配器注册完成', {
      registered: registered.length,
      channels: registered,
    });
  } catch (err: unknown) {
    logger.warn('P4 渠道适配器注册失败，跨渠道同步将降级为缓冲模式', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 为段先生创建/加载默认身份（injectIdentityNetwork 会自动按名称查找此身份）
  const hasDuanIdentity = identityNetwork.listIdentities().some(i => i.profile.name === '段先生');
  if (!hasDuanIdentity) {
    identityNetwork.createIdentity({
      name: '段先生',
      description: 'AI 助手段先生 v19.0 — 超级智能体（经验学习+本地推理+最优路径）',
      capabilities: [
        { name: 'coding', level: 85, verified: true, lastUsed: Date.now(), usageCount: 0 },
        { name: 'debugging', level: 80, verified: true, lastUsed: Date.now(), usageCount: 0 },
        { name: 'architecture', level: 75, verified: false, lastUsed: Date.now(), usageCount: 0 },
        { name: 'documentation', level: 70, verified: false, lastUsed: Date.now(), usageCount: 0 },
      ],
      domain: 'software_engineering',
    });
  }

  // P3-1/P3-2: 持久化断裂修复 — 启动时从磁盘加载已保存的身份数据与知识图谱
  // 修复前：persist()/load() 方法存在但 bootstrap.ts 从不调用，导致重启后身份/图谱数据全部丢失
  // 修复后：异步 load() 不阻塞主流程，加载完成后日志记录；失败时降级为空数据集
  const persistenceLoadPromise = Promise.allSettled([
    identityNetwork.load(),
    kgMemory.load(),
  ]).then((results) => {
    const labels = ['identityNetwork', 'kgMemory'] as const;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        logger.info(`P3 ${labels[i]} 持久化数据已加载`, { module: 'Bootstrap' });
      } else {
        logger.warn(`P3 ${labels[i]} 持久化数据加载失败（降级为空数据集）`, {
          module: 'Bootstrap',
          error: r.reason?.message || String(r.reason),
        });
      }
    });
  });
  cleanupFns.push(() => { try { persistenceLoadPromise.catch(() => {}); } catch {} });

  // ===== V17: 能力评分矩阵 — 8 维度 × 10 子项追踪 10/10 目标 =====
  const capabilityScoreMatrix = new CapabilityScoreMatrix();
  const overallScore = capabilityScoreMatrix.getOverallScore();
  logger.info('V19 能力评分矩阵已初始化', {
    module: 'Bootstrap',
    overallScore: overallScore.toFixed(1),
    targetScore: 10,
    dimensions: capabilityScoreMatrix.getAllScores().length,
  });

  // ===== V17: IoT 协议适配器自动注册（HomeAssistant/MiHome/HomeKit/MQTT） =====
  // P2-1/P2-2: 创建 UnifiedDeviceControl，注册 IoT 适配器，注入 NL 解析器
  let unifiedDeviceControl: UnifiedDeviceControl | null = null;
  try {
    unifiedDeviceControl = new UnifiedDeviceControl();
    const iotAdapters = IoTAdapterFactory.createAll();
    for (const adapter of iotAdapters) {
      unifiedDeviceControl.registerAdapter(adapter);
    }
    // P2-2: 注入自然语言命令解析器
    const nlParser = new NLDeviceCommandParser();
    unifiedDeviceControl.setNLParser(nlParser);
    logger.info('V17 IoT 协议适配器已注册到 UnifiedDeviceControl', {
      module: 'Bootstrap',
      adapterCount: iotAdapters.length,
      platforms: iotAdapters.map(a => a.platform),
      nlParserEnabled: true,
    });
  } catch (e: unknown) {
    logger.warn('IoT 适配器初始化失败（不影响主流程）', { error: e instanceof Error ? e.message : String(e) });
  }

  // ===== P3-3: 嵌入式轻量版 — 自动检测设备 profile 并配置模块裁剪 =====
  const embeddedLightweight = new EmbeddedLightweight();
  logger.info('P3-3: 嵌入式轻量版已初始化', {
    module: 'Bootstrap',
    profile: embeddedLightweight.getConfig().profile,
    maxMemoryMB: embeddedLightweight.getConfig().maxMemoryMB,
    enabledModules: embeddedLightweight.getModules().filter(m => m.enabled).length,
  });

  // ===== 自动化数据同步：连接新模块与现有数据源 =====

  // 1. LearningEvalSystem ← ContinuousLearning 事件监听
  cleanupFns.push(eventBus.on('learning.recorded', (data: unknown) => {
    const d = data as { retentionScore?: number; action?: string };
    const score = typeof d.retentionScore === 'number' ? d.retentionScore : 0.5;
    learningEval.recordSnapshot({
      accuracy: score,
      coverage: d.action === 'created' ? 0.7 : 0.9,
      retention: score,
    }, 'ContinuousLearning', 1);
  }));

  // 2. LearningEvalSystem ← FeedbackReward 事件监听
  cleanupFns.push(eventBus.on('feedback.collected', (data: unknown) => {
    const d = data as { outcome?: string; context?: { executionTime?: number }; value?: number };
    let outcomeScore: number;
    if (d.outcome === 'success') {
      outcomeScore = 0.9;
    } else if (d.outcome === 'partial') {
      outcomeScore = 0.6;
    } else {
      outcomeScore = 0.3;
    }
    learningEval.recordSnapshot({
      accuracy: outcomeScore,
      efficiency: d.context?.executionTime ? Math.max(0, 1 - d.context.executionTime / 30000) : 0.5,
      adaptation: d.value !== undefined ? (d.value + 1) / 2 : 0.5,
    }, 'FeedbackReward', 1);
  }));

  // 3. UnifiedUserProfileCenter ← PersonalizationEngine + SelfLearningSystem 周期性同步
  const SYNC_INTERVAL = 60000;
  const syncIntervalId = setInterval(() => {
    try {
      const pe = personalization.getProfile('default');
      if (pe) {
        userProfile.syncFromSource('default', {
          type: 'personalization',
          data: {
            communicationStyle: pe.communicationStyle,
            expertiseLevel: pe.expertiseLevel,
            preferredLanguages: pe.preferredLanguages,
            interests: pe.interests,
            detailLevel: pe.interactionPatterns.preferredDetailLevel,
            prefersCode: pe.interactionPatterns.prefersCodeExamples,
          },
        });
      }
    } catch (e: unknown) { logger.warn('用户画像同步(personalization)失败', { error: e instanceof Error ? e.message : String(e) }); }
    try {
      const report = selfLearningSystem.generateReport();
      if (report && report.totalRecords > 0) {
        userProfile.syncFromSource('default', {
          type: 'learning',
          data: {
            totalInteractions: report.totalRecords,
            successRate: report.retentionRate || 0.5,
            interests: report.topSkills.map(s => s.name).concat(report.knowledgeGaps).slice(0, 10),
            preferredLanguages: ['中文', 'English'],
          },
        });
      }
    } catch (e: unknown) { logger.warn('用户画像同步(SelfLearning)失败', { error: e instanceof Error ? e.message : String(e) }); }
    try {
      const pm = performanceMetrics.getCurrentMetrics();
      userProfile.syncFromSource('default', {
        type: 'task_tracker',
        data: {
          successRate: pm.taskCompletionRate || 0,
          avgResponseTime: pm.avgResponseTime || 0,
          satisfactionScore: pm.userSatisfaction || 0,
          totalInteractions: pm.totalInteractions || 0,
        },
      });
    } catch (e: unknown) { logger.warn('用户画像同步(Performance)失败', { error: e instanceof Error ? e.message : String(e) }); }
  }, SYNC_INTERVAL);
  cleanupFns.push(() => clearInterval(syncIntervalId));

  // 4. LearningEvalSystem 定期从 PerformanceMetrics 采集
  const evalIntervalId = setInterval(() => {
    try {
      const pm = performanceMetrics.getCurrentMetrics();
      learningEval.recordSnapshot({
        accuracy: pm.intentAccuracy || 0,
        efficiency: pm.avgResponseTime ? Math.max(0, 1 - pm.avgResponseTime / 10000) : 0.5,
        adaptation: pm.toolCallSuccessRate || 0.5,
      }, 'PerformanceMetrics', 100);
    } catch (e: unknown) { logger.warn('学习评估指标采集失败', { error: e instanceof Error ? e.message : String(e) }); }
  }, 120000);
  cleanupFns.push(() => clearInterval(evalIntervalId));

  // ===== 工具层 =====
  const libtvWorkflow = new LibTVWorkFlow();
  const promptEngineer = new VideoPromptEngineer();
  const testGenerator = new TestGenerator();
  const docGenerator = new DocGenerator();
  const imageGenerator = new ImageGenerator();

  return {
    // v16.0 核心系统
    modelLibrary, selfLearningSystem, autonomousThinker, selfUpgradeSystem,
    // v17.0 核心模块
    nluEngine, reasoningEngine, performanceMetrics, selfEvolutionEngine,
    feedbackSystem, benchmark, evolutionEngine, adaptiveLearning, moduleRegistry,
    evolutionTrace, diagnostics, knowledgeGraph, promptOptimizer,
    autonomousCapabilities, capabilityManager, workspace, videoEngine,
    thinkingEngine, personalization,
    // 自主意识系统
    cognitiveState, selfAwareness, valueSystem, goalSystem, heartbeat,
    subAgentOrchestrator, agentTeamOrchestrator, backgroundAgentManager, mcpMarketplace, projectContext, notificationService, webhookService, toolConsolidation, cloudDeployment, selfEvolve, strategyEngine, skillExtractor,
    omniAssistant, selfAssessment, taskPlanner, functionalTestSuite,
    contextCompressor, selfHealingEngine, unifiedToolFramework,
    evolutionMetrics, longTermPlanner,
    // 事件驱动 & 新核心模块
    eventBus, skillSystem, mcpManager,
    // 增强版Agent Loop依赖
    shadowGit, classifier, compressionPipeline,
    // 记忆系统
    vectorStore, enhancedMemory, memoryManager, unifiedMemory,
    // 服务集成
    serviceIntegrations,
    // Phase 2
    treeSitterAST, gitWorktree, adversarialVerifier,
    // P0 Phase: 下一代智能
    dreamingEngine, proactiveEngine, dreamingBridge, memoryStore, toolMasking, sessionReplay,
    // Phase 3
    voiceSystem, videoGenReal, desktopControl,
    // V19 P0：应用 Profile + 工作流能力
    universalDesktop,
    // V19 P0：无障碍 API 语义元素操作
    accessibilityController,
    // Phase 4
    continuousLearning, feedbackReward, evolutionAssessment,
    sessionPersistence, lspIntegration, performanceMonitor, smartCache,
    // Phase 5
    enhancedNLU, codeReasoning, contextRetention, taskDecomposition,
    toolOptimizer, adaptiveInteraction,
    // Phase 6
    benchmarkFramework, optimizationRoadmap,
    // Phase 7
    handoffSystem, diffEditor, guardrailSystem, traceCollector,
    virtualMemoryWorkflow,
    brain,
    projectConfig, projectMemoryLoader, codebaseIndexer, nativeDepsResolver, subAgentPresetRegistry, slashCommandRegistry, contextDiscoverer, multiFileEditor, toolPermissionRegistry, personaSystem, goalTracker, autonomousEngineer, documentParser, proactiveQuestionEngine, skillMarket, offlineCoordinator, learningProgressVisualizer, modelFineTuner, collaborationEngine,
    // v21.0 4 项 P0 升级模块
    enhancedLifecycleHookManager, agentsMdLoader, agentsMdInitializer, fileContextEngine, asyncTaskManager,
    // v21.1 新增模块
    specDrivenDev, repoMap, planMode,
    modelRouter, outputParser,
    // Phase 8
    approvalGate, ethicsReviewEngine, codeKnowledgeGraph, sotaBenchmarkScheduler, selfHealing, consistencyGuard, agentConfig, contextSelector,
    // 三大核心功能模块
    learningEval, skillGen, userProfile, userPreferenceEngine,
    gepaEngine,
    sopPipeline,
    kgMemory,
    embeddingProvider: sharedEmbeddingProvider,
    visualIntelligence,
    identityNetwork,
    // P0 修复: 暴露 wechatController 给 modules，以便注册工具给 LLM
    wechatController,
    // 工具层
    libtvWorkflow, promptEngineer, testGenerator, docGenerator, imageGenerator,

    /** P2-1/P2-2: 统一设备控制 */
    unifiedDeviceControl,

    /** P3-3: 嵌入式轻量版 */
    embeddedLightweight,

    /** V17: 能力评分矩阵 */
    capabilityScoreMatrix,

    /** 释放所有定时器、事件监听器和模块内部资源 */
    dispose: () => {
      // P3-1/P3-2: 持久化断裂修复 — 释放前持久化身份数据和知识图谱
      // 同步 dispose() 启动异步 persist()，依赖 Node.js 事件循环 drain 完成
      // 如需确保持久化完成，请调用 await modules.disposeAsync()
      void Promise.allSettled([
        identityNetwork.persist().catch(() => {}),
        kgMemory.persist().catch(() => {}),
      ]);

      // 清理定时器和事件监听器
      for (const fn of cleanupFns) {
        try { fn(); } catch {}
      }
      // 清理有 dispose 方法的模块
      const disposable = [
        gepaEngine, sopPipeline, kgMemory, visualIntelligence, identityNetwork,
        // P0-1 修复：contextRetention 含 saveTimer，不 dispose 会泄漏定时器并丢失 pending 数据
        contextRetention,
        // P0 D3.4 修复：performanceMonitor 含 monitorTimer，不 dispose 会泄漏定时器
        performanceMonitor,
        // P0 D3.4 修复：skillSystem 含技能 cleanupFns，不 dispose 会泄漏技能内部资源（文件句柄/子进程/定时器）
        skillSystem,
        // 资源生命周期补齐：backgroundAgentManager 含 persistTimer，不 dispose 会泄漏定时器并丢失 pending 状态
        backgroundAgentManager,
        // 资源生命周期补齐：lspIntegration 持有 spawn 的 LSP 子进程，不 dispose 会遗留孤儿进程
        lspIntegration,
      ];
      for (const m of disposable) {
        try { (m as { dispose?: () => void })?.dispose?.(); } catch {}
      }
      // P0 D3.4 修复：SmartCache 含 L1 内存 + L2 磁盘索引，不 dispose 会内存泄漏 + 索引丢失
      try { smartCache?.dispose?.()?.catch(() => {}); } catch {}
      // P0 D3.3 修复：停止自愈引擎的定期巡检定时器，避免进程退出后定时器仍触发
      try { selfHealingEngine?.stopAutoHeal?.(); } catch {}
      logger.info('核心模块已释放');
    },

    /** 异步释放 — 确保持久化完成后再清理（用于优雅关闭场景） */
    disposeAsync: async () => {
      // P3-1/P3-2: 先持久化（dispose 后将无法访问内部数据）
      await Promise.allSettled([
        identityNetwork.persist().catch(() => {}),
        kgMemory.persist().catch(() => {}),
      ]);
      // 等待持久化完成后再清理同步资源
      for (const fn of cleanupFns) {
        try { fn(); } catch {}
      }
      const disposable = [
        gepaEngine, sopPipeline, kgMemory, visualIntelligence, identityNetwork,
        // P0-1 修复：contextRetention 含 saveTimer，不 dispose 会泄漏定时器并丢失 pending 数据
        contextRetention,
        // P0 D3.4 修复：performanceMonitor 含 monitorTimer，不 dispose 会泄漏定时器
        performanceMonitor,
        // P0 D3.4 修复：skillSystem 含技能 cleanupFns，不 dispose 会泄漏技能内部资源（文件句柄/子进程/定时器）
        skillSystem,
        // 资源生命周期补齐：backgroundAgentManager 含 persistTimer，不 dispose 会泄漏定时器并丢失 pending 状态
        backgroundAgentManager,
        // 资源生命周期补齐：lspIntegration 持有 spawn 的 LSP 子进程，不 dispose 会遗留孤儿进程
        lspIntegration,
      ];
      for (const m of disposable) {
        try { (m as { dispose?: () => void })?.dispose?.(); } catch {}
      }
      // P0 D3.4 修复：SmartCache 含 L1 内存 + L2 磁盘索引，不 dispose 会内存泄漏 + 索引丢失
      try { await smartCache?.dispose?.(); } catch {}
      // P0 D3.3 修复：停止自愈引擎的定期巡检定时器，避免进程退出后定时器仍触发
      try { selfHealingEngine?.stopAutoHeal?.(); } catch {}
      logger.info('核心模块已异步释放（持久化已完成）');
    },
  };
}

// ============ 创建工具注册表 ============

export function createToolRegistry(_modules: CoreModules): ScalableToolRegistry {
  const registry = new ScalableToolRegistry();

  // 使用统一来源的 TOOL_RISK_MAP（禁止本地定义重复 riskMap）
  for (const tool of allBuiltInTools) {
    registry.register({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
      category: inferCategory(tool.name),
      priority: 50,
      enabled: true,
      readOnly: tool.readOnly,
      riskLevel: TOOL_RISK_MAP[tool.name] || (tool.readOnly ? 'safe' : 'moderate'),
    });
  }

  return registry;
}

// ============ 创建增强版Agent Loop ============

export interface AgentLoopCallbacks {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  planReviewCallback?: (plan: any) => Promise<{ approved: boolean; modifiedPlan?: any; reason?: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvalCallback?: (request: any) => Promise<{ approved: boolean; modified?: boolean; modifiedArgs?: any; reason?: string }>;
}

export function createAgentLoop(
  modules: CoreModules,
  registry: ScalableToolRegistry,
  callbacks?: AgentLoopCallbacks,
): EnhancedAgentLoop {
  const adapter = new ToolRegistryAdapter(registry);

  // P0-2: 创建 QueryEngine — 集中式 LLM 调用（重试/熔断/降级）
  // clientGetter 基于 modelLibrary 获取客户端，用于 query() 方法和降级链
  const modelLibrary = modules.modelLibrary;
  const getClientForQueryEngine = (model: string): LLMClient | null => {
    if (!modelLibrary) return null;
    try {
      const available = modelLibrary.getAvailableModels();
      for (const m of available) {
        if (m.model === model || m.id === model || m.name?.toLowerCase().includes(model.toLowerCase())) {
          const c = modelLibrary.getChatClient(m.id);
          if (c && typeof c.chat?.completions?.create === 'function') {
            return {
              id: m.id,
              models: [m.model],
              create: (params, options?) => c.chat.completions.create(params, options),
            };
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  };
  const queryEngine = new QueryEngine(getClientForQueryEngine, {
    maxRetries: 3,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerResetTimeoutMs: 30000,
    degradationChain: {
      models: ['deepseek-chat', 'qwen-turbo', 'glm-4-flash'],
      getClient: getClientForQueryEngine,
    },
  });
  // P0-2: 注册全局单例 — 让所有模块共享同一个 QueryEngine（熔断器状态全局共享）
  registerQueryEngine(queryEngine);

  // P0-2 深度优化: 实际接入 Token 预算 — 跨请求累计 token，超预算时通知上层触发压缩
  // 对标 Claude Code 的 context window management：128K 上下文窗口，预留 20% 给响应
  queryEngine.setTokenBudget(102400); // 100K tokens 预算（128K 窗口 - 20% 预留）

  // P0-2 真实接入 ModelRouter 类的 5 步算法 — 之前是内联简单路由（msgLength/toolCount）
  // 现在委托给 ModelRouter.selectModel（5 步：能力分析→候选过滤→权重调整→综合评分→选最优）
  // 对标 Claude Code model selection + Hermes 模型路由
  queryEngine.setModelRouter((request) => {
    try {
      const msgLength = request.messages.reduce((s, m) => s + (m.content?.length || 0), 0);
      const toolCount = request.tools?.length || 0;

      // 复杂度评估（三档策略，与 ModelRouter.adjustWeightsByComplexity 对齐）
      let complexity = 'medium';
      if (msgLength < 500 && toolCount === 0) complexity = 'simple';
      else if (msgLength > 5000 || toolCount > 10) complexity = 'complex';

      // 任务类型推断（取最后一条用户消息作为任务描述）
      const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user');
      const task = (typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '').slice(0, 200) || 'general';

      // 委托给 ModelRouter 的 5 步算法
      const selection = modules.modelRouter.selectModel(task, complexity);
      if (selection.modelId) {
        // 兼容性检查：确认选中的模型在 modelLibrary 中可用
        const available = modelLibrary.getAvailableModels();
        const isAvailable = available.some(m => m.model === selection.modelId || m.id === selection.modelId);
        if (isAvailable) {
          logger.debug('[Bootstrap] ModelRouter 选中模型', {
            from: request.model, to: selection.modelId,
            complexity, compositeScore: selection.compositeScore,
          });
          return selection.modelId;
        }
        // 选中模型不可用，按复杂度 fallback 到常见可用模型
        let fallbackCandidates: string[];
        if (complexity === 'simple') {
          fallbackCandidates = ['qwen-turbo', 'glm-4-flash', 'deepseek-chat'];
        } else if (complexity === 'complex') {
          fallbackCandidates = ['deepseek-chat', 'qwen-turbo', 'glm-4-flash'];
        } else {
          fallbackCandidates = [];
        }
        for (const fm of fallbackCandidates) {
          if (available.some(m => m.model === fm || m.id === fm)) return fm;
        }
      }
      // 默认：使用请求指定的模型
      return request.model;
    } catch {
      return request.model;
    }
  });
  logger.info('P0-2: QueryEngine Token预算(100K) + ModelRouter 5步算法已接入', { module: 'Bootstrap' });

  // P0-1: 创建 CompactionSystem — 5 层上下文压缩（对标 Claude Code）
  const compactionSystem = new CompactionSystem();

  // P0-1 深度优化: 实际接入 LLM 摘要器 — 使 Layer 2 语义压缩真正生效
  // 不接入时 compactToLayer2() 降级为规则截断（200字符），接入后使用 LLM 生成语义摘要
  try {
    const availableModels = modelLibrary.getAvailableModels();
    if (availableModels.length > 0) {
      const firstModel = availableModels[0];
      const client = modelLibrary.getChatClient(firstModel.id);
      if (client && typeof client.chat?.completions?.create === 'function') {
        compactionSystem.setLLMSummarizer(async (messages) => {
          try {
            const conversationText = messages
              .map(m => `[${m.role}] ${m.content.substring(0, 500)}`)
              .join('\n');
            const resp = await client.chat.completions.create({
              model: firstModel.model,
              messages: [
                {
                  role: 'system',
                  content: '你是对话摘要专家。将以下对话压缩为简洁的语义摘要，保留关键决策、事实和行动项。不超过200字。',
                },
                { role: 'user', content: conversationText },
              ],
              max_tokens: 300,
              temperature: 0.3,
            });
            const summary = resp.choices?.[0]?.message?.content;
            if (summary && summary.length > 10) {
              return `[LLM摘要] ${summary}`;
            }
            // 降级：LLM 返回空或过短
            return messages.map(m => `[${m.role}] ${m.content.substring(0, 100)}`).join('\n');
          } catch {
            // 降级：LLM 调用失败时使用规则摘要
            return messages.map(m => `[${m.role}] ${m.content.substring(0, 100)}`).join('\n');
          }
        });
        logger.info('P0-1: CompactionSystem LLM 摘要器已接入 — 语义压缩已启用', { module: 'Bootstrap' });
      }
    }

    // P0-3: 注入增强语义嵌入 — 替换默认的 simpleVectorize（字符 n-gram 哈希）
    // 使用词级 TF-IDF + 语义哈希，比字符 n-gram 显著提升语义召回质量
    // 对标 Claude Code 的 semantic index（真实嵌入需异步 API，此处用增强本地算法避免阻塞）
    try {
      compactionSystem.setEmbeddingProvider((text: string): number[] => {
        const dim = 64;
        const vector = new Array(dim).fill(0);
        // 1. 中文分词：按字 + 按词（空格/标点分割）
        const tokens: string[] = [];
        // 中文按字分（2-gram）
        const cjkChars = text.replace(/[^\u4e00-\u9fa5]/g, '');
        for (let i = 0; i < cjkChars.length - 1; i++) {
          tokens.push(cjkChars.slice(i, i + 2));
        }
        // 英文/数字按词分
        const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
        tokens.push(...words);
        if (tokens.length === 0) return vector;
        // 2. TF-IDF 简化：词频加权（长词权重更高）
        const tokenFreq = new Map<string, number>();
        for (const t of tokens) {
          tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
        }
        // 3. 语义哈希：每个 token 哈希到 64 维的多个位置（simhash 思路）
        for (const [token, freq] of tokenFreq.entries()) {
          const weight = 1 + Math.log(freq); // TF 加权
          const tokenLen = token.length;
          // 每个 token 影响 4 个维度（增加散列度）
          for (let k = 0; k < 4; k++) {
            const hash = hashToken(token, k);
            const idx = hash % dim;
            const sign = (hash % 2 === 0) ? 1 : -1;
            vector[idx] += sign * weight * (1 + tokenLen * 0.1);
          }
        }
        // 4. L2 归一化
        const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
        if (norm > 0) {
          for (let i = 0; i < dim; i++) vector[i] /= norm;
        }
        return vector;
      });
      logger.info('P0-3: CompactionSystem 增强语义嵌入已注入 — 词级 TF-IDF + 语义哈希', { module: 'Bootstrap' });
    } catch (e: unknown) {
      logger.warn('P0-3: CompactionSystem 嵌入注入失败，降级为 simpleVectorize', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
    }
  } catch (e: unknown) {
    logger.warn('P0-1: CompactionSystem LLM 摘要器接入失败，降级为规则摘要', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  const loop = new EnhancedAgentLoop({
    enablePlanning: true,
    enableReflection: true,
    enableApprovalGate: true,
    autoApproveSafe: true,
    shadowGit: modules.shadowGit,
    classifier: modules.classifier,
    compressionPipeline: modules.compressionPipeline,
    // P0-1/P0-2: 注入修复死代码 — 之前未注入导致条件分支永远跳过
    compactionSystem,
    queryEngine,
    planReviewCallback: callbacks?.planReviewCallback,
    approvalCallback: callbacks?.approvalCallback,
    toolRegistry: adapter,
    // P1 去重：注入 bootstrap L639 创建并已 startAutoHeal 的共享实例
    // 避免 EnhancedAgentLoop 构造器自建第二个独立 SelfHealingEngine（未启动 autoHeal、状态不一致）
    selfHealingEngine: modules.selfHealingEngine,
  });

  // 注入模型库与学习系统
  loop.injectModelLibrary(modules.modelLibrary, modules.selfLearningSystem);
  // 注入策略引擎
  loop.injectStrategyEngine(modules.strategyEngine);
  // P1-5: 注入 bootstrap 创建的 SessionPersistence — 修复双实例问题
  loop.injectSessionPersistence(modules.sessionPersistence);
  // P2: 注入 Unified User Profile — 让 prompt 构建能使用用户画像数据
  loop.injectUserProfile(modules.userProfile);
  // 注入模型路由器
  loop.injectModelRouter(modules.modelRouter);
  // P0 准确率：注入对抗式验证器 — 主循环输出前自动核查事实/逻辑
  loop.injectAdversarialVerifier(modules.adversarialVerifier);
  // P0 交互自然度：注入自适应交互系统 — 主循环输出路径调用 adaptResponse 适配风格
  // 之前 AdaptiveInteractionSystem 主 API 全部为死代码，仅作为工具暴露
  loop.injectAdaptiveInteraction(modules.adaptiveInteraction);
  // P0 交互自然度：注入段先生人格引擎 — system prompt 中自动注入人格/价值观/专长
  // 之前 DuanPersonaEngine 仅作为工具暴露，人格不自动塑造响应
  try {
    const personaEngine = new DuanPersonaEngine();
    loop.injectDuanPersonaEngine(personaEngine);
  } catch (e: unknown) {
    logger.warn('P0: DuanPersonaEngine 注入失败 — 人格塑造功能已禁用', {
      module: 'Bootstrap', error: e instanceof Error ? e.message : String(e),
    });
  }

  // 注入自主思考、自我评估（推理引擎已由 EnhancedAgentLoop 构造函数内部创建，无需注入）
  loop.injectAutonomousThinker(modules.autonomousThinker);
  loop.injectSelfAssessment(modules.selfAssessment);
  // 注入知识图谱 — 用于实体/关系查询和工具结果反馈
  loop.injectKnowledgeGraph(modules.knowledgeGraph);

  // 注入 PromptOrchestrator 和 ContextManager
  const promptOrchestrator = new PromptOrchestrator();
  const contextManager = new ContextManager({ maxContextTokens: 8000, minRecentMessages: 4 });
  // P1-3: 注入真实语义嵌入提供者到 ContextManager 的 SemanticRecaller
  // 启用语义召回后，selectMessages 的 query 路径会使用真实语义嵌入（OpenAI/TF-IDF）
  try {
    if (modules.embeddingProvider) {
      contextManager.setEmbeddingProvider(modules.embeddingProvider);
      logger.info('P1-3: ContextManager 语义召回已启用真实嵌入提供者', {
        module: 'Bootstrap',
        provider: modules.embeddingProvider.name,
        dimension: modules.embeddingProvider.dimension,
      });
    }
  } catch (e: unknown) {
    logger.warn('P1-3: ContextManager 嵌入提供者注入失败，降级为哈希嵌入', {
      module: 'Bootstrap',
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // P1-5: 注入真实语义嵌入提供者到 AdaptiveLearningSystem 的知识召回
  // 启用后 recallKnowledgeAsync 使用真实向量相似度（余弦相似度）召回
  try {
    if (modules.embeddingProvider && modules.adaptiveLearning) {
      modules.adaptiveLearning.setEmbeddingProvider(modules.embeddingProvider);
      logger.info('P1-5: AdaptiveLearning 知识召回已启用真实嵌入提供者', {
        module: 'Bootstrap',
        provider: modules.embeddingProvider.name,
      });
    }
  } catch (e: unknown) {
    logger.warn('P1-5: AdaptiveLearning 嵌入提供者注入失败，降级为关键词匹配', {
      module: 'Bootstrap',
      error: e instanceof Error ? e.message : String(e),
    });
  }
  loop.injectPromptOrchestrator(promptOrchestrator);
  loop.injectContextManager(contextManager);

  // P0-5 深度优化: PromptCache 预热 — 通过 loop 的公开方法预构建 stable 层
  // 对标 Claude Code prompt prefix caching：启动时预构建核心身份 prompt，首次请求直接命中缓存
  // 注意：必须使用与 buildSystemPromptCached 相同的构建逻辑，否则缓存内容不匹配
  try {
    if (typeof loop.prewarmPromptCache === 'function') {
      loop.prewarmPromptCache().catch((e: unknown) => {
        logger.warn('P0-5: PromptCache 预热失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
      });
      logger.info('P0-5: PromptCache 预热已启动 — stable 层将在后台预构建', { module: 'Bootstrap' });
    }
  } catch (e: unknown) {
    logger.warn('P0-5: PromptCache 预热初始化失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // 模型降级链：主模型失败时自动降级到备选模型
  // Coding Plan 模型优先降级到其他 Coding Plan 模型，避免走按量付费通道
  const defaultProvider = process.env.DEFAULT_MODEL_PROVIDER || '';
  const isCodingPlan = defaultProvider === 'doubao-coding';
  if (isCodingPlan) {
    loop.setModelFallbackChain(['doubao-seed-2.0-lite', 'doubao-seed-code', 'deepseek-chat', 'qwen-turbo', 'glm-4-flash']);
  } else {
    loop.setModelFallbackChain(['deepseek-chat', 'qwen-turbo', 'glm-4-flash']);
  }

  // 注入项目知识索引
  const projectKnowledge = new ProjectKnowledge();
  loop.injectProjectKnowledge(projectKnowledge);
  // v20.0 注入项目分层记忆加载器
  loop.injectProjectMemoryLoader(modules.projectMemoryLoader);

  // P1-1: 注入三级记忆架构（L0 会话 / L1 持久 / L2 技能）— 修复死代码
  // 复用 bootstrap 已创建的 vectorStore 和 memoryManager，避免双实例导致内存浪费与写入冲突
  const memoryOrchestrator = new MemoryOrchestrator(process.cwd(), modules.vectorStore, modules.memoryManager);
  loop.injectMemoryOrchestrator(memoryOrchestrator);
  // P0 真实修复：注入 MemoryStore — 统一 bootstrap 与 loop 的四级记忆存储实例
  // 之前 bootstrap 给 DreamingBridge 创建一个 MemoryStore，loop 内部自建另一个，两者状态割裂
  loop.injectMemoryStore(modules.memoryStore);
  // P0 真实修复：注入 ContextRetentionSystem — 扩展短期记忆窗口到 25+ 轮
  // 之前仅作为工具暴露，压缩路径 slice(-10) 硬截断丢失关键决策/承诺。
  loop.injectContextRetention(modules.contextRetention);
  // P1-1: 同步注入 PromptOrchestrator — 使记忆搜索结果进入 prompt 上下文
  promptOrchestrator.setMemoryOrchestrator(memoryOrchestrator);

  // P2-1: 注入用户偏好学习引擎 — persona prompt + 隐式信号采集
  loop.injectUserPreferenceEngine(modules.userPreferenceEngine);
  // P2-3: 注入个性化引擎 — 激活 learnFromInteraction 文本学习闭环（NLP 提取技术术语/语言/兴趣）
  loop.injectPersonalizationEngine(modules.personalization);
  // P2-1: 冷启动种子偏好 — 避免新用户偏好引擎空转，提供合理默认值
  // 这些是低强度种子（0.6），会被后续真实信号快速覆盖
  try {
    modules.userPreferenceEngine.bootstrapPreferences('default', [
      { category: 'communication_style', key: 'language', value: 'zh-CN', strength: 0.6 },
      { category: 'detail_level', key: 'response', value: 'concise', strength: 0.5 },
      { category: 'work_habit', key: 'verification', value: 'auto_verify_after_edit', strength: 0.6 },
      { category: 'tool_preference', key: 'edit_tool', value: 'str_replace', strength: 0.5 },
    ]);
  } catch {}

  // P2-2: 注入 GEPA 自进化引擎 — 行为记录/技能沉淀/prompt 优化提示
  loop.injectGEPAEngine(modules.gepaEngine);

  // P0 修复: 注入 EvolutionMetrics 单例 — 任务终止时喂养 16 个进化指标
  // 原 enhanced-agent-loop 从不调用 record()，导致综合进化评分永远 19.9/100
  // 必须注入与 self-evolution-engine 共享的同一实例（避免双实例隔离）
  loop.injectEvolutionMetrics(modules.evolutionMetrics);

  // P0 修复 (断裂点 #5): 注入 SelfAssessment — 任务终止时更新 6 个指标
  // 原 SelfAssessment 的 recordToolSuccess/recordTaskCompletion/recordError 主循环全不调用
  // 导致 evolution-assessment 报告读假数据，自优化触发器永不触发
  loop.injectSelfAssessment(modules.selfAssessment);

  // P0 修复 (断裂点 #6): 注入 FeedbackRewardSystem — 任务终止时收集隐式反馈并计算多维奖励
  // 原 FeedbackRewardSystem.collectFeedback/calculateReward/updatePolicy 主循环全不调用，
  // 导致反馈数据零覆盖、策略偏好永不更新、强化学习奖励信号断裂。
  loop.injectFeedbackReward(modules.feedbackReward);

  // P2-3: 注入 SOP 角色流水线 — 流水线状态提示
  loop.injectSOPPipeline(modules.sopPipeline);

  // P3-2: 注入知识图谱记忆 — 实体-关系三元组 + 混合召回
  loop.injectKGMemory(modules.kgMemory);

  // P2-4: 注入增强视觉智能引擎 — 屏幕理解 + UI 元素检测
  loop.injectVisualIntelligence(modules.visualIntelligence);

  // P0 真实修复：注入 TraceCollector — 自动追踪决策路径
  // 之前 TraceCollector 仅作为工具暴露，主循环不自动追踪决策路径。
  // 注入后通过生命周期钩子自动记录每次 LLM 调用、工具调用的 span。
  try {
    loop.injectTraceCollector(modules.traceCollector);
    logger.info('P0: TraceCollector 已注入并启用自动追踪（替换仅工具暴露的旧模式）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P0: TraceCollector 注入失败', { error: err instanceof Error ? err.message : String(err) });
  }


  // P0 真实修复：注入 ToolConsolidation — 启用工具别名解析 + 使用埋点
  // 之前 ToolConsolidation 仅在 bootstrap 实例化并塞入 toolContext，主循环从未消费。
  // 注入后工具执行前会调用 resolveAlias，执行后会调用 recordUsage。
  try {
    loop.injectToolConsolidation(modules.toolConsolidation);
    logger.info('P0: ToolConsolidation 已注入（启用工具别名解析 + 使用埋点）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P0: ToolConsolidation 注入失败', { error: err instanceof Error ? err.message : String(err) });
  }
  // P0-1: 注入 UnifiedToolFramework — 启用统一工具管理（统计/审批/分类查询）
  // 之前 UnifiedToolFramework 仅在 bootstrap 实例化并塞入 toolContext，主循环从未引用，
  // 是 6 套工具系统中唯一的孤岛。注入后工具执行统计同步到 UnifiedToolFramework，
  // run() 结束时输出工具使用摘要 think 事件（分类/风险等级分布）。
  try {
    loop.injectUnifiedToolFramework(modules.unifiedToolFramework);
    logger.info('P0-1: UnifiedToolFramework 已注入（启用统一工具管理 + 统计同步）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P0-1: UnifiedToolFramework 注入失败', { error: err instanceof Error ? err.message : String(err) });
  }
  // P0-6: 注入 SelfEvolve — 任务失败时触发项目自省 + 进化建议
  try {
    loop.injectSelfEvolve(modules.selfEvolve);
    logger.info('P0-6: SelfEvolve 已注入（任务失败时触发 analyzeProject）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P0-6: SelfEvolve 注入失败', { error: err instanceof Error ? err.message : String(err) });
  }

  // P0 真实修复：注入 TaskDecompositionEngine — 启用复杂任务主动分解
  // 之前仅作为工具暴露，主流程不主动调用 decomposeTask4Level。
  // 注入后主循环会评估任务复杂度，对复杂任务主动分解并注入子任务到上下文。
  try {
    loop.injectTaskDecomposition(modules.taskDecomposition);
    logger.info('P0: TaskDecompositionEngine 已注入（启用复杂任务主动分解）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P0: TaskDecompositionEngine 注入失败', { error: err instanceof Error ? err.message : String(err) });
  }

  // P3-1: 注入 Agent 身份网络 — 身份上下文 + 任务结果记录
  // injectIdentityNetwork 内部会自动查找"段先生"默认身份
  loop.injectIdentityNetwork(modules.identityNetwork);

  // P0: 注入工具阶段掩码 — 按任务阶段精简工具集提示
  loop.injectToolMasking(modules.toolMasking);

  // ===== 注册所有工具到 EnhancedAgentLoop =====

  // agent-loop 内置工具已在 createToolRegistry() 中注册到 ScalableToolRegistry
  // 通过 ToolRegistryAdapter 自动同步到 EnhancedAgentLoop

  // P1-4: 统一批量工具注册 — 替代 60+ 个独立 registerTools 调用
  // 每个模块暴露 getToolDefinitions()，统一遍历注册，减少代码冗余
  const standardToolModules: Array<[string, () => ToolDef[]]> = [
    ['serviceIntegrations', () => modules.serviceIntegrations.getToolDefinitions()],
    ['unifiedMemory',       () => modules.unifiedMemory.getToolDefinitions()],
    ['treeSitterAST',       () => modules.treeSitterAST.getToolDefinitions()],
    ['gitWorktree',         () => modules.gitWorktree.getToolDefinitions()],
    ['adversarialVerifier', () => modules.adversarialVerifier.getToolDefinitions()],
    ['voiceSystem',         () => modules.voiceSystem.getToolDefinitions()],
    ['videoGenReal',        () => modules.videoGenReal.getToolDefinitions()],
    ['desktopControl',      () => modules.desktopControl.getToolDefinitions()],
    ['accessibilityController', () => modules.accessibilityController.getToolDefinitions()],
    ['visualIntelligence',  () => modules.visualIntelligence.getToolDefinitions()],
    ['sopPipeline',          () => modules.sopPipeline.getToolDefinitions()],
    ['kgMemory',             () => modules.kgMemory.getToolDefinitions()],
    ['identityNetwork',      () => modules.identityNetwork.getToolDefinitions()],
    // P0 修复: 注册微信工具给 LLM（wechat_open/send_message/post_moments 等），否则 Agent 看不到只能用 app_operate 硬操作
    ['wechatController',     () => modules.wechatController?.getToolDefinitions() ?? []],
    ['continuousLearning',  () => modules.continuousLearning.getToolDefinitions()],
    ['feedbackReward',      () => modules.feedbackReward.getToolDefinitions()],
    ['evolutionAssessment', () => modules.evolutionAssessment.getToolDefinitions()],
    ['sessionPersistence',  () => modules.sessionPersistence.getToolDefinitions()],
    ['lspIntegration',      () => modules.lspIntegration.getToolDefinitions()],
    ['performanceMonitor',  () => modules.performanceMonitor.getToolDefinitions()],
    ['smartCache',          () => modules.smartCache.getToolDefinitions()],
    ['enhancedNLU',         () => modules.enhancedNLU.getToolDefinitions()],
    ['codeReasoning',       () => modules.codeReasoning.getToolDefinitions()],
    ['contextRetention',    () => modules.contextRetention.getToolDefinitions()],
    ['taskDecomposition',   () => modules.taskDecomposition.getToolDefinitions()],
    ['toolOptimizer',       () => modules.toolOptimizer.getToolDefinitions()],
    ['adaptiveInteraction', () => modules.adaptiveInteraction.getToolDefinitions()],
    ['benchmarkFramework',  () => modules.benchmarkFramework.getToolDefinitions()],
    ['optimizationRoadmap', () => modules.optimizationRoadmap.getToolDefinitions()],
    ['handoffSystem',       () => modules.handoffSystem.getToolDefinitions()],
    ['diffEditor',          () => modules.diffEditor.getToolDefinitions()],
    ['guardrailSystem',     () => modules.guardrailSystem.getToolDefinitions()],
    ['traceCollector',      () => modules.traceCollector.getToolDefinitions()],
    // P0 真实修复：将 PerformanceMetricsSystem 注册到主循环工具集
    // 之前该类不暴露 getToolDefinitions()，导致主循环无法主动查询性能指标。
    ['performanceMetrics',  () => modules.performanceMetrics.getToolDefinitions()],
    // P0 真实修复：将 VirtualMemoryWorkflow 注册到主循环工具集
    // 之前该类从未被实例化，类完整但悬空。
    ['virtualMemoryWorkflow', () => modules.virtualMemoryWorkflow.getToolDefinitions()],
    // P0 真实修复：将 Brain 注册到主循环工具集
    // 之前 Brain 是死代码（bootstrap 不导入，全局无 new Brain()）。
    ['brain',              () => modules.brain.getToolDefinitions()],
    ['projectConfig',       () => modules.projectConfig.getToolDefinitions()],
    // v20.0 项目分层记忆工具（project_memory_list/write/append/delete）
    ['projectMemoryLoader', () => modules.projectMemoryLoader.getToolDefinitions()],
    // v20.0 代码库语义索引工具（codebase_search/find_references/call_graph/overview）
    ['codebaseIndexer',     () => modules.codebaseIndexer.getToolDefinitions()],
    // v20.0 国产系统平台与依赖查询工具（native_status）
    ['nativeDepsResolver',  () => modules.nativeDepsResolver.getToolDefinitions()],
    // v20.0 专用子代理预设工具（subagent_list/subagent_dispatch）
    ['subAgentPresets',     () => modules.subAgentPresetRegistry.getToolDefinitions()],
    // v20.0 斜杠命令工具（slash_command_list/slash_command_execute）
    ['slashCommands',       () => modules.slashCommandRegistry.getToolDefinitions()],
    // v20.0 动态上下文发现工具（context_discover）
    ['contextDiscoverer',   () => modules.contextDiscoverer.getToolDefinitions()],
    // v20.0 多文件协同编辑工具（multi_file_edit）
    ['multiFileEditor',     () => modules.multiFileEditor.getToolDefinitions()],
    // v20.0 分级许可清单工具（permission_list/grant/revoke）
    ['toolPermissionRegistry', () => modules.toolPermissionRegistry.getToolDefinitions()],
    // v20.0 角色人格系统工具（persona_list/info/create/delete/send_message）
    ['personaSystem',       () => modules.personaSystem.getToolDefinitions()],
    // v20.0 长期目标追踪工具（goal_create/list/info/progress/advance/update_status/add_subtask/complete_subtask/delete/template_list）
    ['goalTracker',         () => modules.goalTracker.getToolDefinitions()],
    // v20.0 自主工程任务工具（engineering_create/list/info/run/pause/resume/delete/targets）
    ['autonomousEngineer',  () => modules.autonomousEngineer.getToolDefinitions()],
    // v20.0 多模态文档解析工具（document_parse/document_parse_dir/document_types）
    ['documentParser',      () => modules.documentParser.getToolDefinitions()],
    // v20.0 §5.4 主动提问工具（proactive_question_check/feedback/stats/policy）
    ['proactiveQuestionEngine', () => modules.proactiveQuestionEngine.getToolDefinitions()],
    // v20.0 §5.4 技能市场工具（skill_market_search/list/info/publish/install/rate/report/stats）
    ['skillMarket',         () => modules.skillMarket.getToolDefinitions()],
    // v20.0 §5.2 离线协调器工具（offline_status/probe/mode_toggle/models_detect/models_list/knowledge_query/knowledge_add/knowledge_list）
    ['offlineCoordinator',  () => modules.offlineCoordinator.getToolDefinitions()],
    // v20.0 §5.4 学习进度可视化工具（progress_overview/learning_curve/radar_chart/skill_tree/knowledge_gaps/trends/snapshot/report）
    ['learningProgressVisualizer', () => modules.learningProgressVisualizer.getToolDefinitions()],
    // v20.0 §3.5 模型微调工具（finetune_collect_data/list_examples/create_dataset/list_datasets/create_job/start_job/job_status/list_models）
    ['modelFineTuner',     () => modules.modelFineTuner.getToolDefinitions()],
    // v20.0 §5.3 协作工具（collab_team_register/list/session_create/list/message/task_assign/list/knowledge_share）
    ['collaborationEngine', () => modules.collaborationEngine.getToolDefinitions()],
    ['modelRouter',         () => modules.modelRouter.getToolDefinitions()],
    ['outputParser',        () => modules.outputParser.getToolDefinitions()],
    ['approvalGate',        () => modules.approvalGate.getToolDefinitions()],
    ['ethicsReview',        () => modules.ethicsReviewEngine.getToolDefinitions()],
    ['codeKnowledgeGraph',  () => modules.codeKnowledgeGraph.getToolDefinitions()],
    ['sotaBenchmark',       () => modules.sotaBenchmarkScheduler.getToolDefinitions()],
    ['shadowGit',           () => modules.shadowGit.getToolDefinitions()],
    ['selfHealing',         () => modules.selfHealing.getToolDefinitions()],
    ['promptOptimizer',     () => modules.promptOptimizer.getToolDefinitions()],
    ['consistencyGuard',    () => modules.consistencyGuard.getToolDefinitions()],
    ['agentConfig',         () => modules.agentConfig.getToolDefinitions()],
    ['contextSelector',     () => modules.contextSelector.getToolDefinitions()],
    ['dreamingEngine',      () => modules.dreamingEngine.getToolDefinitions()],
    ['proactiveEngine',     () => modules.proactiveEngine.getToolDefinitions()],
    ['sessionReplay',       () => modules.sessionReplay.getToolDefinitions()],
    ['learningEval',        () => modules.learningEval.getToolDefinitions()],
    ['userProfile',         () => modules.userProfile.getToolDefinitions()],
  ];

  let registeredCount = 0;
  let failedCount = 0;
  for (const [name, getDefs] of standardToolModules) {
    try {
      const defs = getDefs();
      if (defs && defs.length > 0) {
        loop.registerTools(defs);
        registeredCount += defs.length;
      }
    } catch (e: unknown) {
      failedCount++;
      logger.warn(`工具注册失败: ${name}`, { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // V19 P0：注册 UniversalDesktop 工具到 loop
  if (modules.universalDesktop) {
    try {
      const udTools = modules.universalDesktop.getToolDefinitions();
      if (udTools && udTools.length > 0) {
        loop.registerTools(udTools);
        logger.info('UniversalDesktop 工具已注册', { module: 'Bootstrap', count: udTools.length });
      }
    } catch (e) {
      logger.warn('UniversalDesktop 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // P2-1/P2-2: IoT 设备控制 + 自然语言命令工具（可选模块，需存在性检查）
  const optionalToolModules: Array<[string, () => ToolDef[]]> = [
    ['unifiedDeviceControl', () => modules.unifiedDeviceControl.getToolDefinitions()],
    ['cloudDeployment',      () => modules.cloudDeployment.getToolDefinitions()],
    ['embeddedLightweight',  () => modules.embeddedLightweight.getToolDefinitions()],
  ];
  for (const [name, getDefs] of optionalToolModules) {
    try {
      const mod = (modules as unknown as Record<string, { getToolDefinitions?: () => ToolDef[] }>)[name];
      if (mod?.getToolDefinitions) {
        const defs = getDefs();
        if (defs && defs.length > 0) {
          loop.registerTools(defs);
          registeredCount += defs.length;
          logger.info(`${name} 工具已注册`, { module: 'Bootstrap' });
        }
      }
    } catch (e: unknown) {
      failedCount++;
      logger.warn(`${name} 工具注册失败`, { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 特殊工具：需要额外参数的模块
  const skillGenLlmCall = async (prompt: string): Promise<string | null> => {
    try {
      const available = modules.modelLibrary.getAvailableModels();
      const first = modules.modelLibrary.getFirstChatClient();
      if (!first) return null;
      const modelId = first.modelId;
      const client = first.client;
      const entry = available.find(m => m.id === modelId);
      const resp = await client.chat.completions.create({
        model: entry?.model || modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      });
      return resp.choices?.[0]?.message?.content || null;
    } catch { return null; }
  };
  try {
    const skillDefs = modules.skillGen.getToolDefinitions(skillGenLlmCall);
    loop.registerTools(skillDefs);
    registeredCount += skillDefs.length;
  } catch (e: unknown) {
    logger.warn('skillGen 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // P0 修复：注册 skill_discover 工具给 LLM（三步注册第 2 步 — 之前缺此步导致 LLM 看不到 skill_discover）
  // SkillDiscovery.getToolDefinitions() 返回 SkillDiscoveryTool（handler 字段），需转换为 ToolDef（execute 字段）
  try {
    const skillDiscovery = new SkillDiscovery(new SkillRegistry(modules.modelLibrary));
    const rawDefs = skillDiscovery.getToolDefinitions();
    const discoveryToolDefs: ToolDef[] = rawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
      execute: async (args: Record<string, unknown>) => {
        const result = await d.handler(args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: true,
    }));
    loop.registerTools(discoveryToolDefs);
    registeredCount += discoveryToolDefs.length;
  } catch (e: unknown) {
    logger.warn('skillDiscovery 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // ===== v21.0 注册 4 项 P0 升级模块的 LLM 工具 =====
  // 这些模块的工具定义使用 inputSchema（JSON Schema）且 handler 独立，
  // 需要绑定 execute 函数后才能注册到 EnhancedAgentLoop

  // §1 Hooks 生命周期工具（hooks_list/register/unregister/config_get/config_set）
  if (modules.enhancedLifecycleHookManager) {
    try {
      const hooksHandler = createHooksToolHandler(modules.enhancedLifecycleHookManager);
      const hooksRawDefs = getHooksToolDefinitions();
      const hooksToolDefs: ToolDef[] = hooksRawDefs.map(d => ({
        name: d.name,
        description: d.description,
        parameters: {},
        execute: async (args: Record<string, unknown>) => {
          const result = await hooksHandler(d.name, args);
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        readOnly: false,
      }));
      loop.registerTools(hooksToolDefs);
      registeredCount += hooksToolDefs.length;
      logger.info('v21.0 §1: Hooks 生命周期工具已注册', { module: 'Bootstrap', count: hooksToolDefs.length });
    } catch (e: unknown) {
      logger.warn('v21.0 §1: Hooks 生命周期工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // §2 AGENTS.md 工具（agents_md_load/agents_md_init/agents_md_list）
  try {
    const agentsMdHandler = createAgentsMdToolHandler();
    const agentsMdRawDefs = getAgentsMdToolDefinitions();
    const agentsMdToolDefs: ToolDef[] = agentsMdRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await agentsMdHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(agentsMdToolDefs);
    registeredCount += agentsMdToolDefs.length;
    logger.info('v21.0 §2: AGENTS.md 工具已注册', { module: 'Bootstrap', count: agentsMdToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.0 §2: AGENTS.md 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // §3 文件即接口上下文工具（file_context_stats/search/history_list/cleanup）
  try {
    const fileCtxHandler = createFileContextToolHandler(modules.fileContextEngine);
    const fileCtxRawDefs = getFileContextToolDefinitions();
    const fileCtxToolDefs: ToolDef[] = fileCtxRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await fileCtxHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(fileCtxToolDefs);
    registeredCount += fileCtxToolDefs.length;
    logger.info('v21.0 §3: 文件即接口上下文工具已注册', { module: 'Bootstrap', count: fileCtxToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.0 §3: 文件即接口上下文工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // §4 异步任务托管工具（async_task_submit/status/list/cancel/logs/templates/stats）
  try {
    const asyncTaskHandler = createAsyncTaskToolHandler(modules.asyncTaskManager);
    const asyncTaskRawDefs = getAsyncTaskToolDefinitions();
    const asyncTaskToolDefs: ToolDef[] = asyncTaskRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await asyncTaskHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(asyncTaskToolDefs);
    registeredCount += asyncTaskToolDefs.length;
    logger.info('v21.0 §4: 异步任务托管工具已注册', { module: 'Bootstrap', count: asyncTaskToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.0 §4: 异步任务托管工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // ===== v21.1 注册 3 项 P0 新模块的 LLM 工具 =====

  // §B Spec-Driven Development 工具（spec_create/plan/tasks/implement/check/list/get）
  try {
    const specHandler = createSpecDrivenToolHandler(modules.specDrivenDev);
    const specRawDefs = getSpecDrivenToolDefinitions();
    const specToolDefs: ToolDef[] = specRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await specHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(specToolDefs);
    registeredCount += specToolDefs.length;
    logger.info('v21.1 §B: Spec-Driven Development 工具已注册', { module: 'Bootstrap', count: specToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.1 §B: Spec-Driven Development 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // §C Repo Map 工具（repo_map_generate/query/symbols）
  try {
    const repoMapHandler = createRepoMapToolHandler(modules.repoMap);
    const repoMapRawDefs = getRepoMapToolDefinitions();
    const repoMapToolDefs: ToolDef[] = repoMapRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await repoMapHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(repoMapToolDefs);
    registeredCount += repoMapToolDefs.length;
    logger.info('v21.1 §C: Repo Map 工具已注册', { module: 'Bootstrap', count: repoMapToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.1 §C: Repo Map 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // §D Plan Mode 工具（plan_create/update/confirm/cancel/list）
  try {
    const planModeHandler = createPlanModeToolHandler(modules.planMode);
    const planModeRawDefs = getPlanModeToolDefinitions();
    const planModeToolDefs: ToolDef[] = planModeRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await planModeHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(planModeToolDefs);
    registeredCount += planModeToolDefs.length;
    logger.info('v21.1 §D: Plan Mode 工具已注册', { module: 'Bootstrap', count: planModeToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.1 §D: Plan Mode 工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // §E Agent 团队编排工具（team_run_template/list_templates/get_template_info/get_executions/get_execution/get_board/clear_board）
  try {
    const agentTeamHandler = createAgentTeamToolHandler(modules.agentTeamOrchestrator);
    const agentTeamRawDefs = getAgentTeamToolDefinitions();
    const agentTeamToolDefs: ToolDef[] = agentTeamRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await agentTeamHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(agentTeamToolDefs);
    registeredCount += agentTeamToolDefs.length;
    logger.info('v21.1 §E: Agent 团队编排工具已注册', { module: 'Bootstrap', count: agentTeamToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.1 §E: Agent 团队编排工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // §F SubAgent 编排工具（subagent_dispatch / dispatch_background / get_result / wait_for / list_background / cancel / list_agents / status）
  // 对标 Claude Code run_in_background：后台派生子 Agent，立即返回 taskId，主 Agent 不阻塞
  try {
    const subAgentHandler = createSubAgentToolHandler(modules.subAgentOrchestrator);
    const subAgentRawDefs = getSubAgentToolDefinitions();
    const subAgentToolDefs: ToolDef[] = subAgentRawDefs.map(d => ({
      name: d.name,
      description: d.description,
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        const result = await subAgentHandler(d.name, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
      readOnly: false,
    }));
    loop.registerTools(subAgentToolDefs);
    registeredCount += subAgentToolDefs.length;
    logger.info('v21.1 §F: SubAgent 编排工具已注册（含 run_in_background 后台模式）', { module: 'Bootstrap', count: subAgentToolDefs.length });
  } catch (e: unknown) {
    logger.warn('v21.1 §F: SubAgent 编排工具注册失败', { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
  }

  // 工作流工具：视频/测试/文档/图像生成
  const workflowToolCreators: Array<[string, () => ToolDef[]]> = [
    ['video', () => createVideoToolDefs(modules)],
    ['test',  () => createTestToolDefs(modules)],
    ['doc',   () => createDocToolDefs(modules)],
    ['image', () => createImageToolDefs(modules)],
  ];
  for (const [name, createDefs] of workflowToolCreators) {
    try {
      const defs = createDefs();
      loop.registerTools(defs);
      registeredCount += defs.length;
    } catch (e: unknown) {
      logger.warn(`${name} 工具注册失败`, { module: 'Bootstrap', error: e instanceof Error ? e.message : String(e) });
    }
  }

  logger.info(`P1-4: 统一批量工具注册完成 — ${registeredCount} 个工具已注册${failedCount > 0 ? `，${failedCount} 个模块失败` : ''}`, { module: 'Bootstrap' });

  // P1-4: MCP 工具桥接 — initialize() 幂等，此处复用首次初始化的 promise，
  // 在初始化完成后将 MCP 工具同步注册到 EnhancedAgentLoop
  modules.mcpManager.initialize().then(() => {
    try {
      const mcpTools = modules.mcpManager.getToolsAsUnifiedDefinitions();
      if (mcpTools && mcpTools.length > 0) {
        const mcpToolDefs: ToolDef[] = mcpTools.map(mt => ({
          name: mt.name,
          description: mt.description,
          parameters: mt.parameters,
          execute: mt.execute,
          readOnly: true,
        }));
        loop.registerTools(mcpToolDefs);
        logger.info('MCP 工具同步完成', { module: 'Bootstrap', toolCount: mcpToolDefs.length });
      }
    } catch (e) {
      logger.warn('MCP 工具同步失败', { module: 'Bootstrap', error: (e as Error).message });
    }
  }).catch(() => {});

  // D-FIX: 订阅 tool-bundle 注册事件 — mcp-marketplace 发射 marketplace.toolbundle.registered
  // 但原 bootstrap 无监听，导致安装的 tool-bundle 工具不会注册到 Agent Loop（真实 bug）
  try {
    EventBus.getInstance().on('marketplace.toolbundle.registered', (event) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = event.data || {};
        const toolDef: ToolDef = {
          name: data.toolName || 'unknown',
          description: data.toolDescription || `来自插件 ${data.pluginName || 'unknown'} 的工具`,
          parameters: {},
          execute: () => Promise.resolve(`工具 "${data.toolName}" 来自插件 "${data.pluginName}" — handler 待插件格式演进后补全`),
          readOnly: false,
        };
        loop.registerTools([toolDef]);
        logger.info('D-FIX: tool-bundle 工具已注册到 Agent Loop', {
          module: 'Bootstrap', tool: data.toolName, plugin: data.pluginName,
        });
      } catch (e) {
        logger.warn('D-FIX: tool-bundle 工具注册失败', {
          module: 'Bootstrap', tool: event.data?.toolName, error: (e as Error).message,
        });
      }
    });
    logger.info('D-FIX: marketplace.toolbundle.registered 订阅已建立', { module: 'Bootstrap' });
  } catch (e) {
    logger.warn('D-FIX: tool-bundle 事件订阅建立失败', { module: 'Bootstrap', error: (e as Error).message });
  }

  // 启动性能监控
  modules.performanceMonitor.startMonitoring();

  // ==== 注入 GuardrailSystem 到 EnhancedAgentLoop ====
  loop.setGuardrailSystem(modules.guardrailSystem);

  // ==== 注入 EthicsReviewEngine 到 EnhancedAgentLoop（工具执行前伦理审查）====
  loop.setEthicsReviewEngine(modules.ethicsReviewEngine);

  // ==== P1-2: 连接反馈系统到反思引擎 — 建立 错误→反馈→反思→学习 闭环 ====
  try {
    loop.connectFeedbackToReflection(modules.feedbackSystem);
    logger.info('P1-2: 反馈系统已连接到反思引擎（错误修正闭环已建立）', { module: 'Bootstrap' });
  } catch (e) {
    logger.warn('P1-2: 反馈系统连接失败', { module: 'Bootstrap', error: (e as Error).message });
  }

  // ==== P1-3: 注入 EnhancedNLU 到主循环 — 多层意图识别 + 深层意图 + 情感分析 ====
  try {
    loop.injectEnhancedNLU(modules.enhancedNLU);
    logger.info('P1-3: EnhancedNLU 已注入主循环（深层意图理解已启用）', { module: 'Bootstrap' });
  } catch (e) {
    logger.warn('P1-3: EnhancedNLU 注入失败', { module: 'Bootstrap', error: (e as Error).message });
  }

  // ==== 注入 EnhancedAgentLoop runner 到子系统中 ====
  const agentRunner = loop.run.bind(loop) as (
    input: string,
    context: Array<{ role: string; content: string }>,
    options?: { tokenBudget?: number; customSystemPrompt?: string },
  ) => AsyncGenerator<LoopEvent, TerminalReason, void>;

  // 注入 SubAgentOrchestrator
  modules.subAgentOrchestrator.setAgentRunner(agentRunner);
  // P0 真实修复：将 SubAgentOrchestrator 注入到 EnhancedAgentLoop
  // 原先主循环调用不存在的 cognitiveOrchestrator.dispatchSubAgent（stub），现在真实注入
  try {
    loop.injectSubAgentOrchestrator(modules.subAgentOrchestrator);
    logger.info('P0: SubAgentOrchestrator 已注入 EnhancedAgentLoop（替换 dispatchSubAgent stub）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P0: SubAgentOrchestrator 注入 EnhancedAgentLoop 失败', { error: err instanceof Error ? err.message : String(err) });
  }

  // 注入 AgentTeamOrchestrator
  modules.agentTeamOrchestrator.setSubAgentOrchestrator(modules.subAgentOrchestrator);
  modules.agentTeamOrchestrator.setGitWorktreeManager(modules.gitWorktree);

  // 注入 BackgroundAgentManager
  modules.backgroundAgentManager.setAgentRunner(agentRunner);

  // 注入 MCPMarketplace
  modules.mcpMarketplace.setMCPManager(modules.mcpManager);

  // 注入 tool-agent
  setToolAgentRunner(agentRunner);

  // ==== P1-4: ToolOrchestrationEngine（多工具协同工作流）====
  // P0 真实修复：从 (loop as unknown).orchestrationEngine 死代码注入升级为标准工具模块注册
  // 之前通过 as unknown 注入但 loop 从未引用 orchestrationEngine 字段（死代码）。
  // 现在通过 getToolDefinitions 暴露为标准工具，LLM 可主动调用管道/模板/扇出/扇入工作流。
  const orchestrationEngine = new ToolOrchestrationEngine();
  logger.info('P1-4: ToolOrchestrationEngine 已创建（将通过 standardToolModules 注册为工具）', { module: 'Bootstrap' });
  // P0 真实修复：注册为标准工具模块 — LLM 可主动调用管道/模板/扇出/扇入工作流
  try {
    const orchDefs = orchestrationEngine.getToolDefinitions();
    if (orchDefs && orchDefs.length > 0) {
      loop.registerTools(orchDefs);
      logger.info('P1-4: ToolOrchestrationEngine 工具已注册', { count: orchDefs.length, module: 'Bootstrap' });
    }
  } catch (err: unknown) {
    logger.warn('P1-4: ToolOrchestrationEngine 工具注册失败', { error: err instanceof Error ? err.message : String(err), module: 'Bootstrap' });
  }

  // ==== P1-2: 注入 MultiStepReasoningFramework（多步推理框架） ====
  // Part F: 构造带 LLM 诊断的 IntelligentErrorRecovery，注入多步推理框架
  const intelligentErrorRecovery = new IntelligentErrorRecovery({
    llmDiagnose: async (error) => {
      if (!modelLibrary) return null;
      try {
        const prompt = `你是错误恢复诊断专家。分析以下错误，给出根因和恢复建议。

错误类型：${error.type}
错误消息：${error.message}
错误来源：${error.source}
上下文：${JSON.stringify(error.context || {}).substring(0, 500)}

返回 JSON：{"rootCause":"根因分析","suggestedStrategy":"retry_with_backoff|degrade|alternative|rollback|skip|escalate","suggestedFix":"具体修复建议（可选）"}`;
        const resp = await modelLibrary.call([{ role: 'user', content: prompt }], { maxTokens: 800, temperature: 0.3 });
        const raw = resp.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const validStrategies = ['retry', 'retry_with_backoff', 'degrade', 'alternative', 'rollback', 'skip', 'escalate', 'compensate', 'cache_fallback', 'split', 'reconfigure', 'bulkhead', 'isolate'];
        return {
          rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : undefined,
          suggestedStrategy: validStrategies.includes(parsed.suggestedStrategy) ? parsed.suggestedStrategy : undefined,
          suggestedFix: typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix : undefined,
        };
      } catch { return null; }
    },
  });
  const multiStepReasoning = new MultiStepReasoningFramework(
    modules.reasoningEngine,
    undefined, // ReasoningChainVerifier 使用默认
    intelligentErrorRecovery, // Part F: 注入带 LLM 诊断的恢复器
  );
  try {
    // P1-2 真实修复：原先通过 (loop as unknown).multiStepReasoning = ... 注入到无处（死代码）
    // 现在使用类型安全的 injectMultiStepReasoning 方法，主循环可通过 getMultiStepReasoning() 获取
    loop.injectMultiStepReasoning(multiStepReasoning);
    logger.info('P1-2: MultiStepReasoningFramework 已注入（分解-求解-验证-修正四步框架）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('P1-2: MultiStepReasoningFramework 注入失败 — 多步推理框架功能已禁用', { error: err instanceof Error ? err.message : String(err) });
  }

  // ==== 经验学习系统：经验包+本地推理+最优路径（越用越聪明） ====
  // 经验包系统、本地推理引擎、最优捷径选择器已通过 EnhancedAgentLoop 的惰性初始化自动可用
  // （getExperiencePackSystem / getLocalInferenceEngine / getOptimalPathSelector）
  // 此处仅做预热初始化，确保首次任务即可使用
  try {
    const expSystem = loop.getExperiencePackSystem();
    const stats = expSystem.getStats();
    logger.info('经验包系统已初始化', { module: 'Bootstrap', totalExperiences: stats.total, avgQuality: stats.avgQuality.toFixed(1) });
  } catch (err: unknown) {
    logger.warn('经验包系统初始化失败 — 经验积累功能已禁用', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    loop.getLocalInferenceEngine();
    logger.info('本地推理引擎已初始化（无 API 时零 token 完成已知任务）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('本地推理引擎初始化失败 — 离线推理功能已禁用', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    loop.getOptimalPathSelector();
    logger.info('最优捷径选择器已初始化（复杂任务最优路径推荐）', { module: 'Bootstrap' });
  } catch (err: unknown) {
    logger.warn('最优捷径选择器初始化失败 — 路径推荐功能已禁用', { error: err instanceof Error ? err.message : String(err) });
  }

  // Phase G2: 启动时预热 API 连接（fire-and-forget，不阻塞启动）
  // 目的：用户首次发消息时跳过预检，省 1-3s 首字符延迟
  // 失败时静默降级到 run() 内的正常预检流程，不影响主流程
  loop.warmUpPreflight().catch(() => { /* 预热失败静默降级 */ });

  return loop;
}

// ============ 工具定义工厂函数已迁移到 bootstrap-tool-defs.ts ============

// ============ 便捷初始化函数 ============

export interface SetupResult {
  modules: CoreModules;
  registry: ScalableToolRegistry;
  loop: EnhancedAgentLoop;
  /** 释放所有资源 — 定时器、事件监听器、模块内部状态 */
  dispose: () => void;
  /** 异步释放 — 等待持久化完成后再清理（用于优雅关闭场景） */
  disposeAsync: () => Promise<void>;
}

export function setupAgentLoop(callbacks?: AgentLoopCallbacks): SetupResult {
  const modules = createCoreModules();
  const registry = createToolRegistry(modules);
  const loop = createAgentLoop(modules, registry, callbacks);

  // P0 个性化：定期同步 EmotionTracker 的累积情绪画像到 UnifiedUserProfileCenter
  // 之前 syncFromSource('emotion') 从未被调用，emotional 字段永远为空。
  // 现在从 loop.getEmotionTracker() 获取跨会话累积的情绪数据，同步到用户画像。
  const emotionSyncId = setInterval(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tracker = (loop as any).getEmotionTracker?.();
      if (!tracker) return;
      const moodProfile = tracker.getUserMoodProfile?.();
      if (!moodProfile || moodProfile.interactionCount === 0) return;
      modules.userProfile.syncFromSource('default', {
        type: 'emotion',
        data: {
          valenceAvg: moodProfile.valenceAvg,
          arousalAvg: moodProfile.arousalAvg,
          dominantEmotion: moodProfile.dominantEmotion,
          frustrationLevel: moodProfile.frustrationLevel,
          interactionCount: moodProfile.interactionCount,
        },
      });
    } catch (err: unknown) {
      // 记录同步失败，避免静默吞错
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Bootstrap] 情绪画像同步失败:', msg);
    }
  }, 60000);
  // 防止定时器阻止进程优雅退出
  if (typeof emotionSyncId.unref === 'function') emotionSyncId.unref();

  return {
    modules, registry, loop,
    /** 释放所有资源 — 模块定时器/监听器 + loop 内部资源 */
    dispose: () => {
      clearInterval(emotionSyncId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (loop as any).getEmotionTracker?.()?.flushSave?.(); } catch {}
      try { modules.dispose?.(); } catch {}
      try { loop.dispose?.(); } catch {}
    },
    /** 异步释放 — 确保持久化完成后再清理 */
    disposeAsync: async () => {
      clearInterval(emotionSyncId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (loop as any).getEmotionTracker?.()?.flushSave?.(); } catch {}
      try { await modules.disposeAsync?.(); } catch {}
      try { loop.dispose?.(); } catch {}
    },
  };
}
