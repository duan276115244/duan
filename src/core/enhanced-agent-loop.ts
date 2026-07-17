/**
 * 增强版智能体循环 - EnhancedAgentLoop
 *
 * 基于 ReAct + Plan-Execute 混合架构，融合了：
 * - OpenCode 的 Plan-Execute-Verify 模式
 * - Codex CLI 的 ApprovalGate 安全审批机制
 * - ClawHub 的 Skill Registry 模块化工具注册
 *
 * 核心改进：
 * 1. 三阶段执行：Planning → ReAct Execution → Summary & Reflection
 * 2. 安全审批门控：高风险操作需显式批准
 * 3. 经验驱动决策：学习经验直接影响工具选择和策略
 * 4. 执行后反思：自动评估结果质量并提取学习经验
 * 5. 自适应策略：基于任务复杂度动态调整执行策略
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import * as os from 'os';
import type { ModelLibrary } from './model-library.js';
import type { ModelRouter } from './model-router.js';
import type { SelfLearningSystem } from './self-learning-system.js';
import type { StrategyEngine } from './strategy-engine.js';
import type { ShadowGit } from './shadow-git.js';
import { UnifiedConfigManager } from './unified-config.js';
import type { TwoStageClassifier } from './permission-classifier.js';
import type { CompressionPipeline } from './compression-pipeline.js';
import type { CompactionSystem} from './compaction-system.js';
import { type CompactionMessage } from './compaction-system.js';
import type { QueryEngine } from './query-engine.js';
import type { ToolDef } from './unified-tool-def.js';
import type { AgentState, TerminalReason, LoopEvent } from './agent-loop-types.js';
import { WeChatController } from './wechat-controller.js';
import { UniversalDesktop } from './universal-desktop.js';
import { VisualIntelligence } from './visual-intelligence.js';
import { IntelligentDecisionEngine, decisionTools } from './intelligent-decision.js';
import { TaskExecutionEngine } from './task-execution-engine.js';
import { SkillDiscovery } from './skill-discovery.js';
import { SkillRegistry } from './skill-registry.js';
import { TaskSuccessTracker, metricsTools } from './task-success-tracker.js';
import { SuperReasoningEngine } from './super-reasoning-engine.js';
import { FaultTolerantExecutor } from './fault-tolerant-executor.js';
import { ProjectConfig } from './project-config.js';
import { SmartPromptEngine } from './smart-prompt-engine.js';
import { CodeQualityEngine } from './code-quality-engine.js';
import type { PromptOrchestrator, PromptContext} from './prompt-orchestrator.js';
import { inferIntent } from './prompt-orchestrator.js';
import type { ContextManager, ContextMessage } from './context-manager.js';
import type { GuardrailSystem } from './guardrail-system.js';
import { EthicsReviewEngine, type EthicsReviewResult } from './ethics-review-engine.js';
import { SmartToolSelector, TaskIntent } from './smart-tool-selector.js';
import { CapabilityGapDetector } from './capability-gap-detector.js';
import { ToolLearningSystem } from './tool-learning-system.js';
import { LearningEngine } from './learning-engine.js';
import { AgentFSM, AgentStatus, AgentEvent } from './agent-fsm.js';
import { ToolExecutionPipeline, SessionLock } from './tool-execution-pipeline.js';
import { ContextLoader } from './context-loader.js';
import { Scratchpad } from './scratchpad.js';
import { ReflectionEngine } from './reflection-engine.js';
import { ExperiencePackSystem } from './experience-pack-system.js';
import { LocalInferenceEngine } from './local-inference-engine.js';
import { OptimalPathSelector } from './optimal-path-selector.js';
import { VirtualFileSystem } from './virtual-fs.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { SessionPersistence } from './session-persistence.js';
import { CompressionRouter } from './compression-router.js';
import { SandboxExecutor } from './sandbox-executor.js';
import { WorkflowEngine } from './workflow-engine.js';
import { MemoryStore, MemoryLevel } from './memory-store.js';
import type { LifecycleHookManager} from './lifecycle-hooks.js';
import { LifecycleEvent, createLifecycleHookManager } from './lifecycle-hooks.js';
import { ReasoningEngine } from './reasoning-engine.js';
import type { ToolResultCache as AdvancedToolResultCache} from './tool-result-cache.js';
import { getToolResultCache } from './tool-result-cache.js';
import { UnifiedOperationLayer } from './unified-operation-layer.js';
import { CreativeTaskSolver } from './creative-task-solver.js';
import { EmotionInteractionSystem } from './emotion-interaction.js';
import { ProactiveMemoryInjector } from './proactive-memory-injector.js';
import { createCheckpointBeforeModify } from './checkpoint-singleton.js';
import type {
  ToolRiskLevel, ExecutionPolicy, PlanStep, ExecutionPlan,
  ApprovalRequest, ApprovalResult, IToolRegistry} from './enhanced-loop-types.js';
import {
  TaskPlanner, ApprovalGate, ResultReflector, ToolRegistry,
  getPlanStatusString,
  DOOM_LOOP_THRESHOLD, MAX_COMPACT_RETRIES, COMPACT_COOLDOWN_MS,
  DEFAULT_TOKEN_BUDGET, DEFAULT_MAX_TURNS, MAX_TURN_EXTENSION, PLAN_REASSESS_INTERVAL,
} from './enhanced-loop-types.js';
import type { ToolRegistryAdapter } from './tool-registry-adapter.js';
// 层次化任务规划器（4级分解 + 动态重规划 + 依赖图循环检测）
import type { PlanReplanResult } from './task-planner.js';
import { TaskPlanner as HierarchicalTaskPlanner } from './task-planner.js';
// 自我修复引擎（5大类错误分类 + 策略库 + 效果追踪）
import type { EngineErrorCategory } from './self-heal-engine.js';
import { SelfHealingEngine } from './self-heal-engine.js';
import { CognitiveEngine, type CognitiveDecision, type CognitiveFeatures } from './cognitive-engine.js';
import { ConsciousnessSystem, type ConsciousnessState } from './consciousness-system.js';
import { ContinuousEvolutionSystem } from './continuous-evolution-system.js';
// P0 i18n: 自动检测用户语言并影响回复语言（zh-CN 默认不追加指令，en-US/ja-JP 追加回复语言指令）
import { detectAndSetLocale, getRespondInstruction } from './i18n/index.js';
import {
  type ErrorCategory,
  type ErrorCategory5,
  type PseudoToolCall,
  classifyError,
  classifyError5Category,
  generateSelfHealingHint,
  tryRepairJSON,
  extractPseudoToolCalls,
  getToolUsageHint,
} from './enhanced-agent-loop-utils.js';
export { normalizeToolCallArgsForHistory } from './enhanced-agent-loop-utils.js';
import {
  type ExtendedThinkingContext,
  type ThinkingPhaseEvent,
  type ThinkingDepth,
  runExtendedThinking,
  runExtendedThinkingStream,
  detectExplicitThinkingLevel,
  decomposeProblem,
  identifyConstraints,
  generateSolutions,
  enumerateEdgeCases,
} from './extended-thinking-service.js';

// ============ 类型定义 ============

/** 增强版循环配置 */
export interface EnhancedLoopConfig {
  tokenBudget?: number;
  maxTurns?: number;
  enablePlanning?: boolean;
  enableReflection?: boolean;
  enableApprovalGate?: boolean;
  autoApproveSafe?: boolean;
  customSystemPrompt?: string;
  contextData?: Record<string, any>;
  /** 审批回调 - 返回true表示批准 */
  approvalCallback?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  /** 计划审查回调 - 执行前让用户审查计划 */
  planReviewCallback?: (plan: ExecutionPlan) => Promise<{ approved: boolean; modifiedPlan?: ExecutionPlan; reason?: string }>;
  /** Shadow Git 检查点系统 - 工具调用前自动快照 */
  shadowGit?: ShadowGit;
  /** 两阶段权限分类器 - 快速 token 过滤 + CoT 推理 */
  classifier?: TwoStageClassifier;
  /** 压缩管道 - 5 阶段渐进式上下文压缩 */
  compressionPipeline?: CompressionPipeline;
  /** P0-1: 5 层 Compaction 系统 — 对标 Claude Code，优先于 compressionPipeline 使用 */
  compactionSystem?: CompactionSystem;
  /** P0-2: 集中式 QueryEngine — 对标 Claude Code，统一 LLM 调用（重试/熔断/降级） */
  queryEngine?: QueryEngine;
  /** P1-2: Extended Thinking 自动触发（复杂任务自动进入扩展思考模式） */
  enableExtendedThinking?: boolean;
  /** P2-1: 用户偏好学习引擎 — 双向量状态 + 三步循环 + persona prompt */
  userPreferenceEngine?: unknown;
  /** 外部工具注册表适配器（ScalableToolRegistry 包装），取代内建 ToolRegistry */
  toolRegistry?: ToolRegistryAdapter;
  /** 工作区根目录 - 用于路径穿越防护 */
  workspaceRoot?: string;
  /** 是否启用统一工具执行管线（JSON Schema校验 + 路径防护 + 危险命令拦截） */
  enableToolPipeline?: boolean;
  /** 是否启用 L0/L1/L2 分层上下文加载 */
  enableLayeredContext?: boolean;
  /** 是否启用反思引擎（SOP提取） */
  enableReflectionEngine?: boolean;
  /** 是否启用 CircuitBreaker 熔断器 */
  enableCircuitBreaker?: boolean;
  /** 是否启用自动崩溃恢复 */
  enableCrashRecovery?: boolean;
  /** 是否启用虚拟文件系统 */
  enableVFS?: boolean;
  /** P1 去重：注入 bootstrap 创建并已 startAutoHeal 的共享 SelfHealingEngine 实例。
   *  未提供时回退到自建实例（仅用于脱离 bootstrap 的独立运行/测试场景）。
   *  避免 EnhancedAgentLoop 自建第二个独立实例（未启动 autoHeal、独立策略库、与主实例状态不一致）。 */
  selfHealingEngine?: SelfHealingEngine;
}

// ============ 常量 ============


// ============ EnhancedAgentLoop: 增强版智能体循环 ============

export class EnhancedAgentLoop {
  private modelLibrary: ModelLibrary | null;
  private learningSystem: SelfLearningSystem | null;
  private strategyEngine: StrategyEngine | null;
  private toolRegistry: IToolRegistry;
  private planner: TaskPlanner | null = null;
  private approvalGate: ApprovalGate;
  private reflector: ResultReflector | null = null;
  private config: EnhancedLoopConfig;
  /** Track successfully completed tools to prevent re-execution */
  private completedTools: Set<string> = new Set();
  /** Track consecutive failures per tool+args to auto-skip */
  private consecutiveFailures: Map<string, number> = new Map();
  /** 整体连续工具失败次数（所有工具合计）— 达到上限强制文字回复 */
  private _totalConsecutiveToolFailures: number = 0;
  private static readonly MAX_CONSECUTIVE_TOOL_FAILURES = 4;
  /** LLM 连续只输出文字不调工具的次数 — 达到上限强制结束 */
  private _consecutiveTextOnly: number = 0;
  private static readonly MAX_CONSECUTIVE_TEXT_ONLY = 5;
  /** 连续文本警告总次数 — 超过此数直接放弃计划 */
  private _totalTextWarnings: number = 0;
  private static readonly MAX_TOTAL_TEXT_WARNINGS = 3;
  /** 收益递减检测：连续N轮无实质进展时强制结束 */
  private _diminishingReturns: number = 0;
  private _lastProgressTurn: number = 0;
  private _lastDiminishingCheck: number = 0;
  private static readonly MAX_DIMINISHING_RETURNS = 5;
  /** Dynamic tool limit that reduces on 400 errors */
  private currentMaxTools: number = 20;
  /** Resource state tracking — which apps/resources are known to be open */
  private resourceState: Map<string, boolean> = new Map();
  /** Lessons learned across turns — injected into context to avoid repeated mistakes */
  private lessonsLearned: string[] = [];
  private memoryOrchestrator: any | null = null;
  /** P1-1: 跨 run() 记忆查询缓存 — 避免相同/相似查询重复走完整检索管线 */
  private _memorySearchCache: Map<string, { results: any[]; expiry: number }> = new Map();
  private static readonly MEMORY_CACHE_TTL_MS = 60 * 1000; // 60 秒 TTL
  private static readonly MEMORY_CACHE_MAX = 50; // 最多缓存 50 条查询结果
  /** P2-1: 用户偏好学习引擎 */
  private _userPreferenceEngine: any | null = null;
  /** P2-3: 个性化引擎 — 从交互文本中学习技术术语/语言/兴趣（NLP 学习，补充 UserPreferenceEngine 的类型化信号） */
  private _personalizationEngine: any | null = null;
  /** P2-1: 工具使用计数器 — 用于检测模板复用信号 */
  private _toolUsageCounter: Map<string, number> | null = null;
  /** P2-2: GEPA 自进化引擎 — 行为记录→效果评估→技能沉淀闭环 */
  private _gepaEngine: any | null = null;
  /** P2-2: 当前 run() 起始时间戳，用于计算 behavior durationMs */
  private _runStartedAt: number = 0;
  /** P2-2: 本次 run() 中注入的 GEPA 最优 prompt（用于 recordBehavior 的 promptUsed 字段） */
  private _gepaPromptUsedThisRun: string = '';
  /** P2-2: GEPA 自动进化阈值 — 每积累 N 条行为自动触发 evolvePrompt */
  private static readonly GEPA_AUTO_EVOLVE_THRESHOLD = 10;
  /** P2-3: SOP 角色流水线 — 5角色装配线 + pub/sub 消息机制 */
  private _sopPipeline: any | null = null;
  /** P3-2: 知识图谱记忆 — 实体-关系-属性三元组 + 图谱查询与向量检索混合召回 */
  private _kgMemory: any | null = null;
  /** P2-4: 增强视觉智能引擎 — 多层级屏幕理解 + UI 元素检测 + OCR */
  private _visualIntelligence: any | null = null;
  /** P3-1: Agent 身份网络 — 独立身份 + 声誉/信任评分 */
  private _identityNetwork: any | null = null;
  /** P3-1: 当前 Agent ID（段先生默认身份） */
  private _agentId: string | null = null;
  /** P0: 工具阶段掩码 — 按任务阶段精简可用工具集 */
  private _toolMasking: any | null = null;
  /** P1-3: 增强自然语言理解 — 多层意图识别 + 深层意图 + 情感分析 */
  private _enhancedNLU: any | null = null;
  private proactiveMemoryInjector: ProactiveMemoryInjector | null = null;
  private selfAssessment: any | null = null;
  private autonomousThinker: any | null = null;
  private _legacyReasoningEngine: any | null = null;
  private modelRouter: ModelRouter | null = null;
  private projectKnowledge: any | null = null;
  /** v20.0 项目分层记忆加载器 — 对标 CLAUDE.md 多层级记忆 */
  private _projectMemoryLoader: any | null = null;
  /** 知识图谱 — 实体/关系/路径推理，注入到系统提示增强上下文 */
  private _knowledgeGraph: any | null = null;
  // 阶段三：Prompt 编排 + 上下文管理
  private promptOrchestrator: PromptOrchestrator | null = null;
  private contextManager: ContextManager | null = null;
  /** 模型降级链 */
  private modelFallbackChain: string[] = [];
  /** Ollama 本地模型可用性（初始化时异步探测） */
  private _ollamaAvailable: boolean = false;
  private _ollamaModel: string = 'llama3';
  /** 余额不足的 provider 黑名单（402 错误后自动标记，避免反复尝试） */
  private _exhaustedProviders: Map<string, number> = new Map(); // provider → 标记时间戳
  private static readonly EXHAUSTED_PROVIDER_TTL = 5 * 60 * 1000; // 5分钟后自动恢复
  /** 当前正在使用的 API baseURL（用于判断是否为 Coding Plan） */
  private _currentBaseURL: string = '';
  /** 双层护栏系统 */
  private guardrailSystem: GuardrailSystem | null = null;
  /** 伦理审查引擎 — 工具执行前对参数做规则化伦理审查 */
  private ethicsReviewEngine: EthicsReviewEngine | null = null;
  /** 能力缺口检测器 — 工具失败时自动检测能力缺口并触发自我升级 */
  private capabilityGapDetector: CapabilityGapDetector;
  /** 工具失败学习系统 — 从失败中学习，生成经验教训注入提示 */
  private toolLearning: ToolLearningSystem;

  /** 注入护栏系统 */
  setGuardrailSystem(gs: GuardrailSystem): void {
    this.guardrailSystem = gs;
  }

  /** 注入伦理审查引擎 */
  setEthicsReviewEngine(engine: EthicsReviewEngine): void {
    this.ethicsReviewEngine = engine;
  }

  /**
   * 伦理审查 — 工具执行前调用。失败安全：引擎未注入或自身异常时返回 null（放行）。
   * @returns null 表示无需拦截；非 null 且 approved=false 时应阻止执行
   */
  private _runEthicsReview(toolName: string, // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any): EthicsReviewResult | null {
    if (!this.ethicsReviewEngine) return null;
    try {
      const result = this.ethicsReviewEngine.review({ toolName, args });
      if (!result.approved) {
        logger.warn('工具调用被伦理审查拒绝', {
          toolName,
          violations: result.violations.length,
          maxSeverity: result.maxSeverity,
        });
      }
      return result;
    } catch (err: unknown) {
      // 失败安全：审查自身异常不阻塞工具执行
      logger.error('伦理审查异常，降级放行', {
        toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** 统一的输出护栏检查 — 所有退出路径都应调用此方法 */
  private async checkOutputGuardrail(summary: string): Promise<string> {
    if (!this.guardrailSystem) return summary;
    try {
      const outputCheck = await this.guardrailSystem.checkOutput(summary);
      if (!outputCheck.passed) {
        if (outputCheck.action === 'block') return '响应未通过安全检查，已拦截。';
        if (outputCheck.action === 'modify' && outputCheck.modifiedContent) return outputCheck.modifiedContent;
      }
    } catch {}
    return summary;
  }

  /** 智能工具选择器 — 根据意图过滤和排序工具 */
  private smartToolSelector: SmartToolSelector;
  /** 自主学习引擎 — 知识缺口识别和学习路径设计 */
  private learningEngine: LearningEngine;
  /** 类人推理引擎 — 结构化推理和因果分析 */
  private reasoningEngine: ReasoningEngine;
  /** 统一操作层 — 跨平台操作和最佳方法选择 */
  private operationLayer: UnifiedOperationLayer;
  /** 创意任务解决框架 — 需求理解和创意方案生成 */
  private creativeSolver: CreativeTaskSolver;
  /** 情感交互系统 — 情感识别和共情回应 */
  private emotionSystem: EmotionInteractionSystem;
  /** 只读工具结果缓存（TTL 30秒） */
  /** 高级工具结果缓存 — LRU + 文件失效 + 统计（替代简单 Map 缓存） */
  private toolResultCache: AdvancedToolResultCache = getToolResultCache();
  /** 旧缓存保留用于向后兼容（已废弃，使用 toolResultCache 代替） */
  private _legacyToolCache: Map<string, { result: string; timestamp: number }> = new Map();
  private static TOOL_CACHE_TTL = 30000;
  private _lastReportedProgress: number = -1;
  /** 策略切换计数器 — 防止策略无限循环 */
  private _strategySwitchCount: number = 0;
  private static readonly MAX_STRATEGY_SWITCHES = 6;
  /** P0-5 修复：工具执行统一超时（毫秒）— 防止单个工具 hang 住整个 agent loop */
  private static readonly TOOL_EXECUTION_TIMEOUT = 60000; // 60 秒
  /** complete 工具已调用标志 — 防止重复调用 */
  private _hasCompleted: boolean = false;
  /** getClient 缓存 */
  private cachedClient: { client: unknown; model: string } | null = null;
  private cachedClientTime: number = 0;
  private static CLIENT_CACHE_TTL = 30000; // 30秒缓存
  /** Coding Plan 支持的合法模型名 */
  private static CODING_PLAN_MODELS = new Set([
    'ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro',
    'doubao-seed-2.0-lite', 'doubao-seed-code', 'doubao-seed-2.0-mini',
    'glm-5.1', 'glm-5.2', 'glm-4.7',
    'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3.2',
    'kimi-k2.6', 'kimi-k2.5', 'minimax-m2.7', 'minimax-m3',
  ]);

  /** 规范化模型名 — 如果 baseURL 是 Coding Plan 但模型名不合法，自动替换为 ark-code-latest */
  private normalizeModelName(model: string, baseURL?: string): string {
    // 不再强制替换模型名，由 API 服务端校验模型名是否合法
    // 火山引擎 /api/v3 端点支持多种模型，包括 Coding Plan 的模型
    return model;
  }
  /** FSM 状态机 — 支持外部查询/控制循环状态 */
  private _fsm: AgentFSM = new AgentFSM();
  /** 统一工具执行管线 — JSON Schema校验 + 路径防护 + 危险命令拦截 */
  private _toolPipeline: ToolExecutionPipeline | null = null;
  /** 会话级锁 — 同会话串行、跨会话并行 */
  private _sessionLock: SessionLock = new SessionLock();
  /** L0/L1/L2 分层上下文加载器 */
  private _contextLoader: ContextLoader | null = null;
  /** 全局事实板 — 压缩时永久保留关键事实 */
  private _scratchpad: Scratchpad = new Scratchpad();
  /** 反思引擎 — 从成功路径提取 SOP */
  private _reflectionEngine: ReflectionEngine = new ReflectionEngine();
  /** 经验包系统 — 统一经验存储+自动总结+经验匹配复用 */
  private _experiencePackSystem: ExperiencePackSystem | null = null;
  /** 本地推理引擎 — 无 API 时通过经验包+NN 完成任务（零 token） */
  private _localInferenceEngine: LocalInferenceEngine | null = null;
  /** 最优捷径选择器 — 复杂任务最优路径推荐 */
  private _optimalPathSelector: OptimalPathSelector | null = null;
  /** 技能注册系统 — 与 ReflectionEngine 的 SOP 桥接统一 */
  private _skillRegistry: SkillRegistry | null = null;
  /** 当前会话的任务执行路径（用于反思引擎） */
  private _executionPath: Array<{ toolName: string; toolArgs: Record<string, unknown>; result: string; success: boolean; timestamp: number }> = [];
  /** CircuitBreaker 熔断器 — LLM 调用级快速失败 */
  private _circuitBreaker: CircuitBreaker | null = null;
  /** 虚拟文件系统 — 统一管理 skills/memory/resources */
  private _vfs: VirtualFileSystem | null = null;
  /** 会话持久化 — 自动崩溃恢复 */
  private _sessionPersistence: SessionPersistence | null = null;
  /** 小模型压缩路由器 — 压缩/摘要任务路由到便宜模型 */
  private _compressionRouter: CompressionRouter | null = null;
  /** 沙箱执行器 — VM/进程/Docker 多级隔离 */
  private _sandboxExecutor: SandboxExecutor | null = null;
  /** 工作流编排引擎 — YAML 工作流 + DAG 依赖链 */
  private _workflowEngine: WorkflowEngine | null = null;
  /** 四级记忆系统 — short_term/working/long_term/procedural */
  private _memoryStore: MemoryStore | null = null;
  /** 生命周期钩子管理器 — on_llm_request/on_tool_call/on_error 等 */
  private _lifecycleHooks: LifecycleHookManager | null = null;
  /** 层次化任务规划器 — 4级分解 + 动态重规划 + 依赖图循环检测 */
  private _hierarchicalPlanner: HierarchicalTaskPlanner | null = null;
  /** 自我修复引擎 — 5大类错误分类 + 策略库 + 效果追踪 */
  private _selfHealEngine: SelfHealingEngine | null = null;
  /** V17 自动验证：上次验证时间（节流用） */
  private _lastVerifyTime: number = 0;
  /** 当前活跃的层次化计划ID（用于动态重规划追踪） */
  private _activeHierarchicalPlanId: string | null = null;
  /** 当前失败步骤ID（用于动态重规划追踪） */
  private _currentFailedStepId: number = 1;
  /** 自愈策略历史记录（避免重复尝试相同策略） */
  private _attemptedHealStrategies: string[] = [];
  /** 认知引擎 — 神经网络驱动的决策系统 */
  private _cognitiveEngine: CognitiveEngine | null = null;
  /** 意识系统 — 自主意识与元认知 */
  private _consciousnessSystem: ConsciousnessSystem | null = null;
  /** 持续进化系统 — 每日竞品分析与自进化 */
  private _evolutionSystem: ContinuousEvolutionSystem | null = null;
  /** 待注入的用户指令（mid-task course correction） */
  private _pendingUserInjection: string | null = null;
  /** P0-1: 上下文压缩熔断器 — 连续失败 3 次后熔断（对标 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3） */
  private _consecutiveCompactFailures: number = 0;
  private _lastCompactFailureAt: number | null = null;
  private _compactCircuitBreakerOpen: boolean = false;
  /** P0-1: 已喂入 CompactionSystem 的消息索引（避免重复喂入） */
  private _compactionFedIndex: number = 0;
  /** Token 估算缓存：同一 messages.length+compactCount 下结果不变，避免每轮重复遍历所有字符 */
  private _cachedTokenEstimate: number = -1;
  private _cachedTokenEstimateKey: string = '';
  /** P0-2: System Prompt 分层缓存 — 避免每次主循环迭代重新构建+文件读取 */
  private _stablePromptCache: string | null = null;
  private _stablePromptCacheKey: string = '';
  private _projectRulesCache: string | null = null;
  private _projectRulesCacheTime: number = 0;
  private _projectRulesCacheMtime: number = 0;
  private static readonly RULES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟 TTL
  // ===== Phase 1 P0 修复：注入的子系统字段（原 bootstrap 调用静默失败，现已接通） =====
  /** P2: Unified User Profile — prompt 构建使用用户画像数据 */
  private _userProfile: any | null = null;
  /** P0 准确率：对抗式验证器 — 主循环输出前自动核查事实/逻辑 */
  private _adversarialVerifier: any | null = null;
  /** P0 交互自然度：自适应交互系统 — adaptResponse 适配风格 */
  private _adaptiveInteraction: any | null = null;
  /** P0 交互自然度：段先生人格引擎 — system prompt 自动注入人格/价值观/专长 */
  private _duanPersonaEngine: any | null = null;
  /** P0 真实修复：ContextRetentionSystem — 扩展短期记忆窗口到 25+ 轮 */
  private _contextRetention: any | null = null;
  /** P0 修复：EvolutionMetrics 单例 — 任务终止时喂养 16 个进化指标 */
  private _evolutionMetrics: any | null = null;
  /** P0 修复 (断裂点 #6)：FeedbackRewardSystem — 任务终止时收集隐式反馈并计算多维奖励 */
  private _feedbackReward: any | null = null;
  /** P0 真实修复：TraceCollector — 自动追踪决策路径 */
  private _traceCollector: any | null = null;
  /** P0 真实修复：ToolConsolidation — 工具别名解析 + 使用埋点 */
  private _toolConsolidation: any | null = null;
  /** P0-1: UnifiedToolFramework — 统一工具管理（统计/审批/分类查询） */
  private _unifiedToolFramework: any | null = null;
  /** P0-6: SelfEvolve — 任务失败时触发项目自省 + 进化建议 */
  private _selfEvolve: any | null = null;
  /** P0 真实修复：TaskDecompositionEngine — 复杂任务主动分解 */
  private _taskDecomposition: any | null = null;
  /** P1-2: MultiStepReasoningFramework — 分解-求解-验证-修正四步框架 */
  private _multiStepReasoning: any | null = null;
  /**
   * P0 真实修复 (B3)：SubAgentOrchestrator 注入字段。
   * workflow dispatch 回调通过此字段委托到真实编排器，而非返回"未注入"占位字符串。
   * 字段名保留 cognitiveOrchestrator 以匹配原 (this as any).cognitiveOrchestrator 访问点。
   */
  private cognitiveOrchestrator: any | null = null;
  /** P0 视觉：本次 run() 的图像输入（duan-v19.0.ts 透传），构造 LLM 消息时转多模态 */
  private _runImages: Array<{ url: string; mimeType?: string }> | null = null;
  /** 资源释放回调列表 — EventBus 订阅 handle 等推入此处，dispose() 统一调用 */
  private _cleanupFns: Array<() => void> = [];
  /** P1-3: ConsistencyGuard 注入 — 输出一致性校验 */
  private _consistencyGuard: any | null = null;
  /** P0-2: API 连通性预检缓存 — 避免每次对话都发预检请求（省 200-500ms 首字符延迟） */
  private _preflightPassed: boolean = false;
  private _preflightExpiry: number = 0;
  private static readonly PREFLIGHT_CACHE_TTL_MS = 5 * 60 * 1000; // 预检结果缓存 5 分钟
  /** Phase G2: 预热是否已启动（防止重复触发） */
  private _warmUpStarted: boolean = false;

  /**
   * Phase G2: 启动时预热 API 连接 — 后台发一个最小预检请求填充缓存
   *
   * 调用时机：bootstrap.ts 构造完 loop 并注入 modelLibrary 后立即调用
   * 效果：用户第一次发消息时跳过预检（省 1-3s 首字符延迟）
   *
   * 特性：
   * - fire-and-forget：不阻塞构造，不抛错（失败时静默降级到正常预检流程）
   * - 幂等：重复调用只触发一次
   * - 失败安全：网络错误/key 无效时仅清缓存，不影响主流程
   */
  async warmUpPreflight(): Promise<void> {
    if (this._warmUpStarted) return;
    this._warmUpStarted = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const clientInfo = this.getClient();
      if (!clientInfo) return; // 无可用 client，静默跳过

      // 最小预检请求：stream=true + max_tokens=1，只读首 chunk 确认连通
      const stream = await clientInfo.client.chat.completions.create({
        model: clientInfo.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: true,
      }, { signal: controller.signal });

      for await (const _chunk of stream) {
        // 首字节到达 — 预检通过，break 会调 generator.return() 关闭流
        break;
      }

      // 预检通过 — 填充缓存
      this._preflightPassed = true;
      this._preflightExpiry = Date.now() + EnhancedAgentLoop.PREFLIGHT_CACHE_TTL_MS;
    } catch {
      // 预热失败 — 清缓存，首次 run() 会重新预检
      this._preflightPassed = false;
    } finally {
      // 所有路径（成功/失败/空流/早退）都清理 timer 并兜底终止连接
      clearTimeout(timeout);
      controller.abort();
    }
  }
  /** P1-5: 当前 Thread/Turn ID — 用于工具执行时记录 Item */
  private _currentTurnId: string | null = null;
  /** P0-1: 上下文压缩熔断器恢复超时（毫秒）— 5 分钟后半开 */
  private static readonly COMPACT_CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;
  /** P0-1: 三级阈值（对标 Claude Code）— 70% 自动压缩 / 90% 警告 / 98% 阻断 */
  private static readonly COMPACT_THRESHOLD = 0.7;
  private static readonly WARN_THRESHOLD = 0.9;
  private static readonly BLOCK_THRESHOLD = 0.98;
  private static readonly MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

  constructor(config: EnhancedLoopConfig = {}) {
    this.config = {
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      maxTurns: DEFAULT_MAX_TURNS,
      enablePlanning: true,
      enableReflection: true,
      enableApprovalGate: true,
      autoApproveSafe: true,
      ...config,
    };

    this.modelLibrary = null;
    this.learningSystem = null;
    this.strategyEngine = null;
    this.toolRegistry = config.toolRegistry || new ToolRegistry();
    // 初始化智能工具选择器
    this.smartToolSelector = new SmartToolSelector();
    // 注入用户画像到工具选择器
    try {
      const profilePath = path.join(os.homedir(), '.learnings', 'USER_PROFILE.json');
      if (fs.existsSync(profilePath)) {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        this.smartToolSelector.injectUserProfile(profile);
      }
    } catch (e) {
      console.warn('[EnhancedAgentLoop] 加载用户画像失败:', e instanceof Error ? e.message : String(e));
    }
    this.capabilityGapDetector = new CapabilityGapDetector([]);
    this.learningEngine = new LearningEngine();
    this.reasoningEngine = new ReasoningEngine({
      llmReason: async (task, context, mode) => {
        if (!this.modelLibrary) return null;
        try {
          const prompt = `你是推理引擎，使用「${mode}」推理模式分析以下任务，输出结构化推理结果。

任务：${task}
上下文：${context.length > 0 ? context.map((c, i) => `[${i + 1}] ${c}`).join('\n') : '（无）'}

请返回 JSON：{"conclusion":"最终结论","steps":[{"step":1,"thought":"思考","action":"行动（可选）","observation":"观察（可选）","confidence":0.8,"justification":"理由"}],"confidence":0.8,"alternatives":["备选1"],"mode":"${mode}"}`;
          const resp = await this.modelLibrary.call([{ role: 'user', content: prompt }], { maxTokens: 1500, temperature: 0.4 });
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
    this.operationLayer = new UnifiedOperationLayer();
    this.creativeSolver = new CreativeTaskSolver();
    this.emotionSystem = new EmotionInteractionSystem();
    this.toolLearning = new ToolLearningSystem();
    this.approvalGate = new ApprovalGate(
      config.approvalCallback || null,
      this.config.autoApproveSafe,
      config.classifier || null,
    );
    // 初始化沙箱执行器（需在 ToolPipeline 之前，因为 ToolPipeline 依赖它）
    this._sandboxExecutor = new SandboxExecutor();
    // 初始化统一工具执行管线
    if (this.config.enableToolPipeline !== false) {
      const workspaceRoot = config.workspaceRoot || process.cwd();
      this._toolPipeline = new ToolExecutionPipeline(workspaceRoot, config.approvalCallback as any || undefined);
      // 将 SandboxExecutor 注入到 ToolExecutionPipeline
      this._toolPipeline.setSandboxExecutor(this._sandboxExecutor);
    }
    // 初始化 L0/L1/L2 分层上下文加载器
    if (this.config.enableLayeredContext !== false) {
      const workspaceRoot = config.workspaceRoot || process.cwd();
      this._contextLoader = new ContextLoader(this.config.tokenBudget || DEFAULT_TOKEN_BUDGET, 4000, workspaceRoot);
    }
    // 初始化 CircuitBreaker 熔断器
    if (this.config.enableCircuitBreaker !== false) {
      this._circuitBreaker = new CircuitBreaker('llm-provider', { failureThreshold: 5, successThreshold: 3, timeoutMs: 30000, halfOpenMaxRequests: 1 });
    }
    // 初始化虚拟文件系统
    if (this.config.enableVFS !== false) {
      this._vfs = new VirtualFileSystem();
    }
    // 初始化自动崩溃恢复
    if (this.config.enableCrashRecovery !== false) {
      try {
        this._sessionPersistence = new SessionPersistence(path.join(process.cwd(), '.duan', 'sessions'));
      } catch {}
    }
    // 初始化小模型压缩路由器
    this._compressionRouter = new CompressionRouter();
    // 初始化工作流编排引擎
    this._workflowEngine = new WorkflowEngine({
      dispatch: async (role, task, allowedTools, options) => {
        // 生命周期钩子：子 Agent 派发前
        if (this._lifecycleHooks) {
          try {
            await this._lifecycleHooks.trigger(LifecycleEvent.ON_SUBAGENT_DISPATCH, {
              role, task, allowedTools: allowedTools || [],
            });
          } catch {}
        }
        // 委托到认知编排器的子Agent调度
        if (this.cognitiveOrchestrator) {
          const result = await this.cognitiveOrchestrator.dispatchSubAgent(role, task, allowedTools || []);
          // 生命周期钩子：子 Agent 完成后
          if (this._lifecycleHooks) {
            try {
              await this._lifecycleHooks.trigger(LifecycleEvent.ON_SUBAGENT_RESULT, {
                role, task,
                summary: result?.summary || '',
                success: !!result,
              });
            } catch {}
          }
          return result?.summary || `[SubAgent ${role} 完成]`;
        }
        return `[SubAgent ${role} 未注入，无法执行: ${task}]`;
      },
    });
    // 从 workflows/ 目录加载 YAML 工作流定义（如 refactor-and-test.yaml）
    try {
      const wfLoaded = this._workflowEngine.loadWorkflowsFromDirectory();
      if (wfLoaded > 0) {
        // 工作流加载成功，可通过 runWorkflow(name) 执行
      }
    } catch {
      // 工作流加载失败静默降级
    }
    // 初始化四级记忆系统
    this._memoryStore = new MemoryStore();
    // 初始化生命周期钩子管理器
    const hookSetup = createLifecycleHookManager();
    this._lifecycleHooks = hookSetup.manager;
    // 初始化层次化任务规划器（4级分解 + 动态重规划 + 依赖图循环检测）
    try {
      this._hierarchicalPlanner = new HierarchicalTaskPlanner();
    } catch {}
    // 初始化自我修复引擎（5大类错误分类 + 策略库 + 效果追踪）
    // P1 去重修复：优先使用 bootstrap 创建并已 startAutoHeal 的共享实例
    // 之前自建第二个独立实例（未启动 autoHeal、策略库与主实例状态不一致）
    try {
      this._selfHealEngine = this.config.selfHealingEngine ?? new SelfHealingEngine();
    } catch {}
    this.registerNewModules();
    // 后台探测 Ollama（不阻塞构造函数）
    this.probeOllama();
  }

  /** 异步探测本地 Ollama 是否可用 */
  private probeOllama(): void {
    import('http').then(http => {
      const req = http.get('http://localhost:11434/api/tags', { timeout: 2000 }, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => { data += chunk; });
        res.on('end', () => {
          this._ollamaAvailable = true;
          try {
            const parsed = JSON.parse(data);
            const models: string[] = (parsed.models || []).map((m: any) => (m.name || m.model || '').replace(':latest', ''));
            if (models.length > 0) {
              this._ollamaModel = models[0];
            }
          } catch {}
        });
      });
      req.on('error', (err) => { console.warn(`[AgentLoop] Ollama 模型探测失败: ${err.message}`); });
      req.on('timeout', () => { req.destroy(); });
    }).catch(() => {});
  }

  private registerNewModules(): void {
    // 微信控制器
    const wechat = new WeChatController();
    for (const tool of wechat.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'moderate', 'serial');
    }

    // 通用桌面自动化
    const desktop = new UniversalDesktop();
    for (const tool of desktop.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'moderate', 'serial');
    }

    // 视觉智能
    const visual = new VisualIntelligence();
    for (const tool of visual.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'safe', 'parallel');
    }

    // 智能决策
    const decision = new IntelligentDecisionEngine();
    for (const tool of decisionTools) {
      this.toolRegistry.register({
        name: tool.name,
        description: tool.description,
        parameters: {},
        execute: async (args: any) => {
          if (tool.name === 'decision_analyze') {
            return JSON.stringify(decision.analyzeIntent(args.userInput, { recentTools: args.recentTools, activeApps: args.activeApps }));
          }
          if (tool.name === 'decision_complexity') {
            return decision.estimateComplexity(args.userInput);
          }
          return JSON.stringify({ tool: tool.name, args });
        },
      }, 'safe', 'parallel');
    }

    // 任务执行引擎
    const taskEngine = new TaskExecutionEngine(async (toolName: string, args: any) => {
      const entry = this.toolRegistry.get(toolName);
      if (!entry) return `工具 ${toolName} 不存在`;
      try { return await entry.definition.execute(args); } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); return `执行失败: ${msg}`; }
    }, {
      // Part A: LLM 智能任务分解回调 — 复用 modelLibrary 将复杂目标分解为结构化步骤
      llmDecompose: async (goal: string, entities?: Record<string, string>) => {
        if (!this.modelLibrary) return [];
        try {
          const entityHint = entities && Object.keys(entities).length > 0
            ? `\n已知实体：${JSON.stringify(entities)}`
            : '';
          const prompt = `你是一个任务分解专家。请将以下复杂目标分解为 2-6 个可执行的步骤，每步包含明确的描述和可选的工具名。${entityHint}

目标：${goal}

请返回 JSON 数组格式（不要包含其他文本）：
[{"description":"步骤描述","toolName":"可选工具名","dependencies":["依赖的前置步骤序号，从1开始"]}]

注意：
- 每步描述要具体、可执行
- dependencies 用步骤序号（1-based）表示前置依赖，无依赖则为空数组
- 工具名从已有工具中选择，不确定则省略 toolName`;
          const resp = await this.modelLibrary.call(
            [{ role: 'user', content: prompt }],
            { maxTokens: 2000, temperature: 0.3 },
          );
          const raw = resp.content || '';
          // 容错解析：LLM 可能返回 markdown 包裹的 JSON
          const jsonMatch = raw.match(/\[[\s\S]*\]/);
          if (!jsonMatch) return [];
          const parsed = JSON.parse(jsonMatch[0]);
          if (!Array.isArray(parsed)) return [];
          // 转换为 ExecutionStep 格式（dependencies 从 1-based 序号转为 step_N id）
          return parsed.map((item: any, idx: number) => ({
            id: `step_${idx + 1}`,
            description: String(item.description || `步骤 ${idx + 1}`),
            toolName: item.toolName ? String(item.toolName) : undefined,
            status: 'pending' as const,
            retryCount: 0,
            dependencies: Array.isArray(item.dependencies)
              ? item.dependencies.map((d: number) => `step_${d}`).filter((d: string) => d !== `step_${idx + 1}`)
              : [],
            estimatedDuration: 30000,
          }));
        } catch {
          return []; // 失败时降级到规则路径
        }
      },
    });
    for (const tool of taskEngine.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'moderate', 'serial');
    }

    // 技能发现
    const skillRegistry = new SkillRegistry();
    this._skillRegistry = skillRegistry;
    const skillDisc = new SkillDiscovery(skillRegistry);
    for (const tool of skillDisc.getToolDefinitions()) {
      this.toolRegistry.register({
        name: tool.name,
        description: tool.description,
        parameters: {},
        execute: async (args: any) => tool.handler(args),
      }, 'safe', 'parallel');
    }

    // 成功率评估
    const tracker = new TaskSuccessTracker();
    for (const tool of metricsTools) {
      this.toolRegistry.register({
        name: tool.name,
        description: tool.description,
        parameters: {},
        execute: async (args: any) => {
          if (tool.name === 'metrics_success_rate') {
            return JSON.stringify({ successRate: tracker.getSuccessRate(args.intent, args.domain) });
          }
          if (tool.name === 'metrics_analyze_failure') {
            return JSON.stringify(tracker.analyzeFailure(args.taskId));
          }
          if (tool.name === 'metrics_suggestions') {
            return JSON.stringify(tracker.getOptimizationSuggestions());
          }
          if (tool.name === 'metrics_report') {
            return JSON.stringify(tracker.getMetrics(args.timeRangeStart ? { start: args.timeRangeStart, end: args.timeRangeEnd } : undefined));
          }
          return JSON.stringify({ tool: tool.name, args });
        },
      }, 'safe', 'parallel');
    }

    // 超级推理引擎
    const reasoning = new SuperReasoningEngine();
    for (const tool of reasoning.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'safe', 'parallel');
    }

    // 容错执行引擎
    const executor = new FaultTolerantExecutor();
    for (const tool of executor.getToolDefinitions()) {
      this.toolRegistry.register({
        name: tool.name,
        description: tool.description,
        parameters: {},
        execute: async (args: any) => executor.executeTool(tool.name, args, async (name: string, a: any) => {
          const entry = this.toolRegistry.get(name);
          if (!entry) return `工具 ${name} 不存在`;
          try { return await entry.definition.execute(a); } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); return `执行失败: ${msg}`; }
        }),
      }, 'moderate', 'serial');
    }

    // 项目配置
    const projConfig = new ProjectConfig();
    for (const tool of projConfig.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'safe', 'parallel');
    }

    // 智能提示词
    const promptEngine = new SmartPromptEngine();
    for (const tool of promptEngine.getToolDefinitions()) {
      this.toolRegistry.register(tool, 'safe', 'parallel');
    }

    // 代码质量引擎
    const codeQuality = new CodeQualityEngine();
    for (const tool of codeQuality.getToolDefinitions()) {
      this.toolRegistry.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args: any) => JSON.stringify(codeQuality.executeTool(tool.name, args)),
      }, 'safe', 'parallel');
    }

    // 渐进式技能披露：load_skill 工具 — 按需加载 SOP 详细步骤
    this.toolRegistry.register({
      name: 'load_skill',
      description: '加载指定技能的详细执行步骤（SOP）。当系统提示中列出了可用技能时，使用此工具获取完整操作指南。',
      parameters: {
        name: { type: 'string', description: '技能名称（从可用技能列表中选择）', required: true },
      },
      execute: async (args: any) => {
        const skillName = args.name;
        if (!skillName) return '请指定技能名称';
        const detail = this._reflectionEngine.formatSOPDetailForPrompt(skillName);
        if (!detail || detail.includes('未找到')) {
          // 尝试从 VFS 加载
          if (this._vfs) {
            const skills = this._vfs.list('skills');
            const match = skills.find(s => s.path.includes(skillName));
            if (match) {
              return `📚 技能详情（来自VFS）:\n${match.content}`;
            }
          }
          return `未找到技能: ${skillName}。请检查可用技能列表中的名称。`;
        }
        return `📚 技能详情:\n${detail}`;
      },
    }, 'safe', 'parallel');

    // 全局事实板查看工具
    this.toolRegistry.register({
      name: 'recall_facts',
      description: '查看已确认的关键事实和项目配置信息。包括技术栈、数据库配置、端口等关键事实。',
      parameters: {
        query: { type: 'string', description: '搜索关键词（可选）' },
        tag: { type: 'string', description: '按标签过滤（可选）' },
      },
      execute: async (args: any) => {
        const facts = args.query
          ? this._scratchpad.search(args.query)
          : args.tag
            ? this._scratchpad.getByTag(args.tag)
            : this._scratchpad.getAll();
        if (facts.length === 0) return '当前没有已确认的关键事实。';
        return facts.map(f => `- ${f.key}: ${f.value} [${f.tags.join(',')}](重要度:${f.importance.toFixed(1)})`).join('\n');
      },
    }, 'safe', 'parallel');
  }

  /**
   * 注入模型库
   */
  injectModelLibrary(library: ModelLibrary, learning?: SelfLearningSystem): void {
    this.modelLibrary = library;
    // 将 ModelLibrary 注入到 CompressionRouter，使压缩任务能路由到小模型
    if (this._compressionRouter) {
      (this._compressionRouter as any).modelLibrary = library;
      (this._compressionRouter as any).refreshAvailableModels();
    }
    this.learningSystem = learning || null;
  }

  /**
   * 注入策略引擎
   */
  injectStrategyEngine(engine: StrategyEngine): void {
    this.strategyEngine = engine;
  }

  /**
   * 注入模型路由器
   */
  injectModelRouter(router: ModelRouter): void {
    this.modelRouter = router;
  }

  injectMemoryOrchestrator(orchestrator: any): void {
    this.memoryOrchestrator = orchestrator;
    // 同时初始化主动记忆注入器
    if (!this.proactiveMemoryInjector) {
      this.proactiveMemoryInjector = new ProactiveMemoryInjector();
    }
  }
  injectProjectKnowledge(pk: any): void { this.projectKnowledge = pk; }
  /** 注入项目分层记忆加载器 — v20.0 对标 CLAUDE.md 多层级记忆 */
  injectProjectMemoryLoader(loader: any): void { this._projectMemoryLoader = loader; }
  injectSelfAssessment(sa: any): void { this.selfAssessment = sa; }
  injectAutonomousThinker(at: any): void { this.autonomousThinker = at; }
  injectReasoningEngine(re: any): void { this._legacyReasoningEngine = re; }
  /** 注入知识图谱 — 用于实体/关系查询和工具结果反馈 */
  injectKnowledgeGraph(kg: any): void { this._knowledgeGraph = kg; }
  /** P2-1: 注入用户偏好学习引擎 */
  injectUserPreferenceEngine(engine: any): void { this._userPreferenceEngine = engine; }
  /** P2-3: 注入个性化引擎 — 激活 learnFromInteraction 文本学习闭环 */
  injectPersonalizationEngine(engine: any): void { this._personalizationEngine = engine; }
  /** P2-2: 注入 GEPA 自进化引擎 — 行为记录/技能沉淀 */
  injectGEPAEngine(engine: any): void { this._gepaEngine = engine; }
  /** P2-3: 注入 SOP 角色流水线 — 5角色装配线 + pub/sub */
  injectSOPPipeline(pipeline: any): void { this._sopPipeline = pipeline; }
  /** P3-2: 注入知识图谱记忆 — 实体-关系三元组 + 混合召回 */
  injectKGMemory(kgMemory: any): void { this._kgMemory = kgMemory; }
  /** P2-4: 注入增强视觉智能引擎 — 屏幕理解 + UI 元素检测 + OCR */
  injectVisualIntelligence(vi: any): void { this._visualIntelligence = vi; }
  /**
   * P3-1: 注入 Agent 身份网络 — 独立身份 + 声誉/信任评分
   * 若未指定 agentId，则自动查找名为"段先生"的默认身份
   */
  injectIdentityNetwork(network: any, agentId?: string): void {
    this._identityNetwork = network;
    if (agentId) {
      this._agentId = agentId;
    } else if (network) {
      try {
        const identities = network.listIdentities?.() ?? [];
        const duan = identities.find((i: any) => i.profile?.name === '段先生');
        if (duan) this._agentId = duan.id;
      } catch {}
    }
  }
  /** P0: 注入工具阶段掩码 — 按任务阶段精简工具集 */
  injectToolMasking(tm: any): void { this._toolMasking = tm; }
  /**
   * P1-3: 注入增强自然语言理解引擎 — 多层意图识别 + 深层意图 + 情感分析
   *
   * 注入后，主循环在构建系统提示时会调用 understandDeepIntent，
   * 将表层/深层/隐含意图与情感信号注入上下文，提升任务理解质量。
   * 若引擎不可用或调用失败，静默降级，不影响主流程。
   */
  injectEnhancedNLU(nlu: any): void { this._enhancedNLU = nlu; }
  // 阶段三：Prompt 编排 + 上下文管理注入
  injectPromptOrchestrator(orchestrator: PromptOrchestrator): void {
    this.promptOrchestrator = orchestrator;
    // 将 PromptOrchestrator 注入 ContextLoader，使 L0 层使用真实系统提示而非硬编码身份
    if (this._contextLoader) {
      this._contextLoader.setSystemPromptProvider(async () => {
        try {
          return await orchestrator.orchestrate({
            userMessage: '',
            intent: 'general',
          } as any);
        } catch {
          return '';
        }
      });
    }
  }
  injectContextManager(manager: ContextManager): void {
    this.contextManager = manager;
    // P0-4: 注入时自动启用语义召回（注意力机制），使上下文选择支持语义相关性
    try {
      (manager as any).enableSemanticRecall?.();
    } catch {}
  }

  // ===== Phase 1 P0 修复：17 个注入方法（原 bootstrap 调用静默失败，现已接通） =====
  // 每个 inject 方法存储模块实例，使 bootstrap 的 try-catch 不再吞掉 TypeError。
  // 实际消费（record/collectFeedback/adaptResponse 等）在任务终止/输出路径调用。
  /** P1-5: 注入 SessionPersistence — 修复双实例问题 */
  injectSessionPersistence(sp: SessionPersistence): void { this._sessionPersistence = sp; }
  /** P2: 注入 Unified User Profile — prompt 构建使用用户画像数据 */
  injectUserProfile(up: any): void { this._userProfile = up; }
  /** P0 准确率：注入对抗式验证器 — 主循环输出前自动核查事实/逻辑 */
  injectAdversarialVerifier(av: any): void { this._adversarialVerifier = av; }
  /** P0 交互自然度：注入自适应交互系统 — adaptResponse 适配风格 */
  injectAdaptiveInteraction(ai: any): void { this._adaptiveInteraction = ai; }
  /** P0 交互自然度：注入段先生人格引擎 — system prompt 自动注入人格/价值观/专长 */
  injectDuanPersonaEngine(pe: any): void { this._duanPersonaEngine = pe; }
  /** P0 真实修复：注入 MemoryStore — 统一 bootstrap 与 loop 的四级记忆存储实例 */
  injectMemoryStore(ms: MemoryStore): void { this._memoryStore = ms; }
  /** P0 真实修复：注入 ContextRetentionSystem — 扩展短期记忆窗口到 25+ 轮 */
  injectContextRetention(cr: any): void { this._contextRetention = cr; }
  /** P0 修复：注入 EvolutionMetrics 单例 — 任务终止时喂养 16 个进化指标 */
  injectEvolutionMetrics(em: any): void { this._evolutionMetrics = em; }
  /** P0 修复 (断裂点 #6)：注入 FeedbackRewardSystem — 任务终止时收集隐式反馈并计算多维奖励 */
  injectFeedbackReward(fr: any): void { this._feedbackReward = fr; }
  /** P0 真实修复：注入 TraceCollector — 自动追踪决策路径 */
  injectTraceCollector(tracer: any): void { this._traceCollector = tracer; }
  /** P0 真实修复：注入 ToolConsolidation — 工具别名解析 + 使用埋点 */
  injectToolConsolidation(consolidator: any): void { this._toolConsolidation = consolidator; }
  /** P0-1: 注入 UnifiedToolFramework — 统一工具管理（统计/审批/分类查询）。
   *  同步 toolRegistry 中的工具定义到 framework；跳过已注册工具以保留运行时统计（useCount 等）。
   *  注入失败时静默降级（graceful degradation），不阻塞主循环。 */
  injectUnifiedToolFramework(utf: any): void {
    this._unifiedToolFramework = utf;
    try {
      if (!utf || typeof utf.register !== 'function') return;
      const fwRegistry: Map<string, unknown> | undefined = utf.registry;
      const defs: ToolDef[] = this.toolRegistry?.getAllDefinitions?.() ?? [];
      for (const def of defs) {
        const id = def.name;
        // 跳过已注册（保留 useCount / errorCount / avgExecutionTime 等运行时统计）
        if (fwRegistry && typeof fwRegistry.has === 'function' && fwRegistry.has(id)) continue;
        const entry = this.toolRegistry?.get?.(def.name);
        const riskLevel = entry?.riskLevel || (def.readOnly ? 'safe' : 'moderate');
        const executionPolicy = entry?.executionPolicy || (def.readOnly ? 'parallel' : 'serial');
        utf.register({
          id,
          name: def.name,
          description: def.description || '',
          parameters: def.parameters || {},
          // ToolDef.execute 返回 Promise<string>；UnifiedToolDefinition.execute 返回 Promise<ToolResult>
          execute: async (args: unknown) => {
            try {
              const out = await def.execute(args as Record<string, unknown>);
              return { success: true, output: typeof out === 'string' ? out : String(out) };
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              return { success: false, output: '', error: msg };
            }
          },
          riskLevel,
          executionPolicy,
          sandbox: {
            type: entry?.sandboxEnabled ? 'process' : 'none',
            timeout: 0,
            maxMemory: 0,
            maxOutput: 0,
          },
          approvalMessage: entry?.approvalMessage || '',
          category: def.category || 'other',
          tags: def.tags || [],
          version: def.version || '1.0.0',
          builtIn: false,
        });
      }
    } catch {
      // graceful degradation — 注入失败不阻塞主循环
    }
  }
  /** P0-6: 注入 SelfEvolve — 任务失败时触发项目自省 + 进化建议 */
  injectSelfEvolve(se: any): void { this._selfEvolve = se; }
  /** P0 真实修复：注入 TaskDecompositionEngine — 复杂任务主动分解 */
  injectTaskDecomposition(td: any): void { this._taskDecomposition = td; }
  /** P1-2: 注入 MultiStepReasoningFramework — 分解-求解-验证-修正四步框架 */
  injectMultiStepReasoning(msr: any): void { this._multiStepReasoning = msr; }
  /** 获取 MultiStepReasoningFramework（主循环可调用） */
  getMultiStepReasoning(): any | null { return this._multiStepReasoning; }
  /**
   * P0 真实修复 (B3)：注入 SubAgentOrchestrator — 替换 cognitiveOrchestrator.dispatchSubAgent stub。
   * 注入后 workflow 的 dispatch 回调会委托到真实编排器，而非返回"未注入"占位字符串。
   */
  injectSubAgentOrchestrator(so: any): void { this.cognitiveOrchestrator = so; }
  /** P1-3: 注入 ConsistencyGuard — 输出一致性校验（未注入时 _consistencyGuard 保持 null） */
  injectConsistencyGuard(guard: any): void { this._consistencyGuard = guard; }
  /**
   * P0-5: PromptCache 预热 — 启动时预构建 stable 层 system prompt，
   * 首次请求直接命中缓存（对标 Claude Code prompt prefix caching）。
   * 失败静默降级，不影响主流程。
   */
  async prewarmPromptCache(): Promise<void> {
    try {
      const stable = this.buildSystemPrompt();
      if (stable) {
        this._stablePromptCache = stable;
        this._stablePromptCacheKey = 'prewarm';
      }
    } catch {
      // 预热失败静默降级，首次请求时实时构建
    }
  }
  /**
   * Phase 1 P0 修复 (B2)：策略耗尽时的终端返回值。
   * 原 run() 在策略耗尽后 yield error 事件却 return {type:'completed'}（伪装成功），
   * 违反 Hard Constraint L6（"Agent must return {type:'error', recoverable:true}
   * when strategies are exhausted, not 伪装成功 with {type:'completed'}"）。
   * 现统一返回 {type:'error', recoverable:true}。
   * 提取为独立方法以便单元测试断言运行时路径（而非仅 TerminalReason 类型）。
   */
  private _buildStrategyExhaustedReason(state: { turnCount: number; messages: ReadonlyArray<{ role: string; content?: unknown }> }): { type: 'error'; error: string; recoverable: true } {
    const lastMsg = state.messages.filter(m => m.role === 'assistant').pop();
    const rawContent = lastMsg?.content;
    const partial = typeof rawContent === 'string' ? rawContent : '';
    const detail = partial || `经过 ${state.turnCount} 轮尝试后无法完成任务。`;
    const truncated = detail.length > 200 ? detail.slice(0, 200) + '…' : detail;
    return {
      type: 'error',
      error: `⚠️ 已尝试 ${this._strategySwitchCount} 种策略均无法解决问题，终止执行。（最后输出: ${truncated}）`,
      recoverable: true,
    };
  }

  /**
   * P0 反馈链汇聚点 — 在任务终止路径调用，喂养 5 个 source='new' 运行时指标。
   * Hard Constraint: source='new' 指标须用 read-and-reset delta 维护 50 样本滚动平均；
   * 直接 recordRuntimeValue() 仅限 regression_rate / improvement_velocity。
   *
   * 口径（与 dimensions.ts 对齐）：
   * - on_time_completion_rate (delta): completed 且 turnCount ≤ DEFAULT_MAX_TURNS → 1
   * - quality_gate_pass_rate (delta): completed 且无失败工具调用 → 1
   * - gap_probing_rate (delta): 反思产出任何教训（含成功教训）OR 人格引擎首次记录到新 domain 盲区 → 1
   * - improvement_velocity (direct): 本次 run 产出的 lessonsLearned 条数
   * - regression_rate (direct): 失败工具调用 / 总调用数
   */
  private _recordOutcomeToEvolutionMetrics(
    state: { turnCount: number },
    reason: TerminalReason,
    executionLog: ReadonlyArray<{ tool: string; result: string; success: boolean }>,
  ): void {
    const em = this._evolutionMetrics;
    if (!em || typeof em.recordRuntimeValue !== 'function') return;
    const totalActions = executionLog.length || 1;
    const isCompleted = reason.type === 'completed';
    // on_time_completion_rate (delta) — completed within DEFAULT_MAX_TURNS
    const onTime = isCompleted && state.turnCount <= DEFAULT_MAX_TURNS ? 1 : 0;
    em.recordRuntimeValue('on_time_completion_rate', onTime, 'delta');
    // quality_gate_pass_rate (delta) — completed with no failed actions
    const qualityPass = isCompleted && !executionLog.some(e => !e.success) ? 1 : 0;
    em.recordRuntimeValue('quality_gate_pass_rate', qualityPass, 'delta');
    // gap_probing_rate (delta) — any lessons learned OR persona engine gap delta
    const gapProbed = ((this.lessonsLearned?.length ?? 0) > 0
      || (this._duanPersonaEngine?.consumeGapProbingDelta?.() ?? 0) > 0) ? 1 : 0;
    em.recordRuntimeValue('gap_probing_rate', gapProbed, 'delta');
    // improvement_velocity (direct) — lessons count this run
    em.recordRuntimeValue('improvement_velocity', this.lessonsLearned?.length ?? 0, 'direct');
    // regression_rate (direct) — failed actions / total ratio
    const failedActions = executionLog.filter(e => !e.success).length;
    em.recordRuntimeValue('regression_rate', failedActions / totalActions, 'direct');

    // Phase C2: 任务终止边界统一 flush 所有 delta 累加器 → 50 样本滚动窗口
    // （含 on_time/quality/gap_probing + 新增 recall_latency/memory_hit_rate）
    // 每个 delta 计数器读取后清零，作为本次任务的样本推入滚动窗口，
    // 使 getRuntimeAverage / getRuntimeP95 返回有意义数值（原代码漏调 flush 导致恒为 0）。
    try {
      if (typeof em.flushRuntimeDeltas === 'function') {
        em.flushRuntimeDeltas();
      }
    } catch { /* flush 失败不影响主流程 */ }
  }

  /**
   * 释放内部资源 — bootstrap.ts dispose()/disposeAsync() 调用。
   * 清理 cognitiveOrchestrator + 已注册的 cleanup 回调（EventBus 订阅 handle 等）。
   * 注：EventBus.on(...) 订阅点应将 unsubscribe handle 推入 _cleanupFns（渐进式迁移）。
   */
  dispose(): void {
    try { this.cognitiveOrchestrator?.shutdown?.(); } catch { /* 静默 */ }
    for (const fn of this._cleanupFns) {
      try { fn(); } catch { /* 单个清理失败不影响其他 */ }
    }
    this._cleanupFns.length = 0;
  }

  // ============ 新模块公共接口 ============

  /** 获取 FSM 状态机 — 外部可查询/监听循环状态 */
  getFSM(): AgentFSM { return this._fsm; }

  /** 获取当前循环状态 */
  getAgentStatus(): AgentStatus { return this._fsm.getStatus(); }

  /** 外部暂停循环 */
  pauseLoop(): void { this._fsm.pause(); }

  /** 外部恢复循环 */
  resumeLoop(): void { this._fsm.resume(); }

  /**
   * 中途注入用户指令 — mid-task course correction
   * 用户可在 agent 工作中注入新指令/约束/重定向，下一轮 LLM 调用前生效。
   * 对标 Claude Code 的 h2A 双缓冲队列实时转向能力。
   */
  injectInstruction(instruction: string): void {
    this._pendingUserInjection = instruction;
  }

  /** 检查并消费待注入的用户指令 */
  private _consumeUserInjection(): string | null {
    const injection = this._pendingUserInjection;
    this._pendingUserInjection = null;
    return injection;
  }

  /**
   * 获取认知引擎 — 神经网络驱动的决策系统
   * 首次调用时惰性初始化
   */
  getCognitiveEngine(): CognitiveEngine {
    if (!this._cognitiveEngine) {
      this._cognitiveEngine = new CognitiveEngine();
    }
    return this._cognitiveEngine;
  }

  /**
   * 获取意识系统 — 自主意识与元认知
   * 首次调用时惰性初始化
   */
  getConsciousnessSystem(): ConsciousnessSystem {
    if (!this._consciousnessSystem) {
      this._consciousnessSystem = new ConsciousnessSystem();
    }
    return this._consciousnessSystem;
  }

  /**
   * 获取持续进化系统 — 每日竞品分析与自进化
   * 首次调用时惰性初始化
   */
  getEvolutionSystem(): ContinuousEvolutionSystem {
    if (!this._evolutionSystem) {
      this._evolutionSystem = new ContinuousEvolutionSystem();
    }
    return this._evolutionSystem;
  }

  /**
   * 获取经验包系统 — 统一经验存储+自动总结+经验匹配复用
   * 首次调用时惰性初始化
   */
  getExperiencePackSystem(): ExperiencePackSystem {
    if (!this._experiencePackSystem) {
      this._experiencePackSystem = new ExperiencePackSystem();
    }
    return this._experiencePackSystem;
  }

  /**
   * 获取本地推理引擎 — 无 API 时通过经验包+NN 完成任务（零 token）
   * 首次调用时惰性初始化
   */
  getLocalInferenceEngine(): LocalInferenceEngine {
    if (!this._localInferenceEngine) {
      this._localInferenceEngine = new LocalInferenceEngine(this.getExperiencePackSystem());
    }
    return this._localInferenceEngine;
  }

  /**
   * 获取最优捷径选择器 — 复杂任务最优路径推荐
   * 首次调用时惰性初始化
   */
  getOptimalPathSelector(): OptimalPathSelector {
    if (!this._optimalPathSelector) {
      this._optimalPathSelector = new OptimalPathSelector(this.getExperiencePackSystem());
    }
    return this._optimalPathSelector;
  }

  /**
   * 意识状态自动切换 — 根据认知特征选择最优意识状态
   * 对标人类前额叶皮层根据任务难度调整注意力模式
   */
  private _autoSwitchConsciousness(features: CognitiveFeatures | null): ConsciousnessState | null {
    if (!features) return null;
    try {
      const cs = this.getConsciousnessSystem();
      const newState = cs.autoSelectState({
        taskComplexity: features.complexity,
        creativityRequired: features.taskType < 0.3 && features.novelty > 0.6,
        isReflective: features.errorRate > 0.4,
        isIdle: false,
      });
      // 仅在状态变化时切换
      if (cs.getState() !== newState) {
        cs.transitionTo(newState);
      }
      return newState;
    } catch {
      return null;
    }
  }

  /**
   * SOP 自动匹配 — 闭合自改进闭环的关键
   * 任务开始时自动匹配已有 SOP，直接注入步骤详情（无需 LLM 手动 load_skill）
   * 对标 Hermes 自改进闭环：经验→技能→自动应用→越用越聪明
   */
  private _autoMatchSOP(input: string): string | null {
    try {
      const sops = this._reflectionEngine.getSOPsByTrigger(input);
      if (sops.length === 0) return null;

      // 取最佳匹配（getSOPsByTrigger 已按评分排序）
      const bestSOP = sops[0];
      const successRate = bestSOP.successCount / Math.max(bestSOP.successCount + bestSOP.failureCount, 1);

      // 仅在成功率 > 50% 且有足够经验时自动注入
      if (successRate < 0.5 || bestSOP.successCount < 2) return null;

      const detail = this._reflectionEngine.formatSOPDetailForPrompt(bestSOP.name);
      return `## 📚 自动匹配技能: ${bestSOP.name}\n（成功率${Math.round(successRate * 100)}%，已成功${bestSOP.successCount}次）\n${detail}`;
    } catch {
      return null;
    }
  }

  /**
   * 认知决策 — 使用神经网络分析当前任务，返回策略建议
   * 在主循环每轮 LLM 调用前自动调用，影响 temperature/推理深度/工具选择
   */
  private _cognitiveDecide(input: string, state: any): CognitiveDecision | null {
    try {
      const engine = this.getCognitiveEngine();
      const features = engine.extractFeatures({
        input,
        contextMessages: state.messages,
        turnCount: state.turnCount,
        errorCount: this._attemptedHealStrategies.length,
        toolCallCount: this._executionPath.length,
      });
      const decision = engine.decide(features);
      // 记录认知周期
      engine.recordCycle(features, decision, 0, '决策已生成，等待执行');
      return decision;
    } catch {
      return null;
    }
  }

  /**
   * 认知学习 — 任务完成后从结果中学习
   * 对标 Hermes 的自改进闭环：经验→技能→越用越聪明
   */
  learnFromTaskOutcome(input: string, success: boolean, durationMs: number): void {
    try {
      const engine = this.getCognitiveEngine();
      const features = engine.extractFeatures({ input });
      const recentCycles = engine.getRecentCycles(1);
      const strategy = recentCycles.length > 0 ? recentCycles[0].decision.strategy : 'careful_analysis';
      const featureVector = [
        features.urgency, features.complexity, features.novelty,
        features.contextRichness, features.errorRate, features.toolUsageRate,
        features.userSatisfaction, features.taskType,
      ];
      engine.learnFromOutcome({
        features: featureVector,
        strategy,
        success,
        durationMs,
      });
    } catch {}
  }

  /** 获取全局事实板 */
  getScratchpad(): Scratchpad { return this._scratchpad; }

  /** 获取反思引擎 */
  getReflectionEngine(): ReflectionEngine { return this._reflectionEngine; }

  /** 获取统一工具执行管线 */
  getToolPipeline(): ToolExecutionPipeline | null { return this._toolPipeline; }

  /** 设置工作区根目录（路径穿越防护边界） */
  setWorkspaceRoot(root: string): void {
    if (this._toolPipeline) this._toolPipeline.setWorkspaceRoot(root);
  }

  /** 获取 CircuitBreaker 熔断器 */
  getCircuitBreaker(): CircuitBreaker | null { return this._circuitBreaker; }

  /** 获取虚拟文件系统 */
  getVFS(): VirtualFileSystem | null { return this._vfs; }

  /**
   * P0-6: 工具执行结果失败识别 — 扩展失败前缀识别。
   * 用于 plan step 状态判定（default 分支）+ 工具结果审计。
   * 识别：错误前缀(❌/✗/错误/Error/失败)、动作+失败(读取失败/执行失败...)、
   *       通用异常(异常/超时/timeout/timed out/ETIMEDOUT/ECONNREFUSED/ENOTFOUND)、
   *       HTTP 4xx/5xx 状态码、安全限制前缀。
   * 非字符串/空字符串/纯成功标记(✅)返回 false。
   */
  private _isToolResultFailure(result: unknown): boolean {
    if (typeof result !== 'string') return false;
    const s = result.trim();
    if (!s) return false;
    // HTTP 状态码：4xx/5xx 视为失败，2xx/3xx 视为成功
    const statusMatch = s.match(/状态码[:：]\s*(\d{3})/);
    if (statusMatch) {
      const code = parseInt(statusMatch[1], 10);
      return code >= 400;
    }
    // 失败前缀/子串列表
    const failureMarkers = [
      '❌', '✗', '错误:', '错误：', 'Error:', 'ERROR:', '失败:', '失败：',
      '读取失败', '执行失败', '获取失败', '搜索失败', '列出目录失败',
      '写入失败', '编辑失败', '创建失败', '删除失败', '解析失败', '连接失败',
      '异常:', '超时:', 'timeout:', 'timed out', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND',
      '无法完成操作', '未能找到文件',
      '安全限制:', '安全限制：',
    ];
    return failureMarkers.some(m => s.includes(m));
  }

  /** 辅助方法：构建带 FSM 状态的事件 */
  private _emit(type: LoopEvent['type'], content: string, extra?: Partial<LoopEvent>): LoopEvent {
    // 注：proactive_announcement 等变体需 severity，由调用方通过 extra 传入；
    // union 类型无法静态保证所有变体字段齐全，用 as 断言（运行时字段由调用方负责）。
    return { type, content, agentStatus: this._fsm.getStatus() as string, ...extra } as LoopEvent;
  }

  /** 获取会话持久化管理器 */
  getSessionPersistence(): SessionPersistence | null { return this._sessionPersistence; }

  /** 获取小模型压缩路由器 */
  getCompressionRouter(): CompressionRouter | null { return this._compressionRouter; }

  /** 获取沙箱执行器 */
  getSandboxExecutor(): SandboxExecutor | null { return this._sandboxExecutor; }

  /** 获取工作流编排引擎 */
  getWorkflowEngine(): WorkflowEngine | null { return this._workflowEngine; }

  /** 获取四级记忆系统 */
  getMemoryStore(): MemoryStore | null { return this._memoryStore; }

  /** 获取生命周期钩子管理器 */
  getLifecycleHooks(): LifecycleHookManager | null { return this._lifecycleHooks; }

  /** 自动崩溃恢复 — 从最近的未完成会话恢复状态 */
  async recoverFromCrash(): Promise<{ recovered: boolean; sessionId?: string; summary?: string }> {
    if (!this._sessionPersistence) return { recovered: false };
    try {
      const sessions = this._sessionPersistence.listSessions();
      const crashed = sessions.find((s: any) => s.status === 'crashed' || s.status === 'active');
      if (!crashed) return { recovered: false };
      const recovered = this._sessionPersistence.recoverSession(crashed.id);
      if (recovered) {
        // 实际恢复数据到 Agent 状态
        // 1. 恢复对话历史 — 注入到 Scratchpad 供下次任务使用
        if (recovered.conversationHistory && recovered.conversationHistory.length > 0) {
          this._scratchpad.extractFromMessages(recovered.conversationHistory as any);
          this._scratchpad.set('crash_recovery_session', crashed.id, {
            source: 'crash_recovery',
            importance: 0.8,
            tags: ['recovery', 'crash'],
          });
        }
        // 2. 恢复工具调用历史 — 记录到执行路径供反思引擎使用
        if (recovered.toolCallHistory) {
          for (const tc of recovered.toolCallHistory) {
            this._executionPath.push({
              toolName: tc.name,
              toolArgs: tc.args,
              result: tc.result,
              success: !tc.result.startsWith('❌'),
              timestamp: Date.now(),
            });
          }
        }
        // 3. 恢复认知状态 — 注入到 Scratchpad
        if (recovered.cognitiveState) {
          const cog = recovered.cognitiveState;
          for (const [key, value] of Object.entries(cog)) {
            if (typeof value === 'string') {
              this._scratchpad.set(`cog_${key}`, value, {
                source: 'crash_recovery',
                importance: 0.7,
                tags: ['cognitive', 'recovery'],
              });
            }
          }
        }
        // 4. 恢复计划 — 存入 VFS
        if (recovered.lastPlan && this._vfs) {
          this._vfs.write(`viking://checkpoints/${crashed.id}/plan`, JSON.stringify(recovered.lastPlan), {
            contentType: 'json',
            tags: ['recovery', 'plan'],
          });
        }
        return {
          recovered: true,
          sessionId: crashed.id,
          summary: `已从崩溃会话 ${crashed.id} 恢复: ${recovered.conversationHistory.length} 条对话, ${recovered.toolCallHistory.length} 个工具调用`,
        };
      }
    } catch {}
    return { recovered: false };
  }

  /** 连接反馈系统到反思引擎 — 建立 反馈→反思 闭环 */
  connectFeedbackToReflection(feedbackSystem: { setOnFeedbackCallback: (cb: (entry: any) => Promise<void>) => void }): void {
    feedbackSystem.setOnFeedbackCallback(async (entry: any) => {
      // 仅对 thumbs 反馈触发反思
      if (entry.type !== 'thumbs') return;
      if (this._executionPath.length === 0) return;

      const taskPath = {
        taskInput: entry.context?.taskInput || '',
        steps: this._executionPath,
        finalOutcome: entry.value === 'up' ? 'success' as const : 'failure' as const,
        userFeedback: entry.value === 'up' ? 'thumbs_up' as const : 'thumbs_down' as const,
        duration: Date.now() - (this._executionPath[0]?.timestamp || Date.now()),
      };

      if (await this._reflectionEngine.shouldTriggerReflection(taskPath)) {
        if (entry.value === 'down') {
          // 负面反馈 → 失败分析
          const analysis = await this._reflectionEngine.reflectOnFailure(taskPath);
          if (analysis) {
            this._scratchpad.set(`failure_analysis_${Date.now()}`, analysis.rootCause, {
              source: 'reflection',
              importance: 0.9,
              tags: ['failure', 'reflection'],
            });
          }
        } else {
          // 正面反馈 → SOP 提取
          const sop = await this._reflectionEngine.extractSOP(taskPath);
          if (sop && this._vfs) {
            this._vfs.write(`viking://skills/${sop.name}/v${sop.version}`, JSON.stringify(sop), {
              contentType: 'json',
              tags: [sop.category, 'sop'],
            });
          }
        }
      }
    });
  }

  /**
   * 设置模型降级链
   */
  setModelFallbackChain(chain: string[]): void {
    this.modelFallbackChain = chain;
  }

  /** 根据模型名推断其所属的 envKey（用于判断是否属于已耗尽 provider） */
  private getModelEnvKey(modelName: string): string | null {
    const pairs: Array<{ pattern: string; envKey: string }> = [
      { pattern: 'deepseek', envKey: 'DEEPSEEK_API_KEY' },
      { pattern: 'doubao', envKey: 'DOUBAO_API_KEY' },
      { pattern: 'ark-code', envKey: 'DOUBAO_API_KEY' },
      { pattern: 'ep-', envKey: 'DOUBAO_API_KEY' },
      { pattern: 'glm', envKey: 'ZHIPU_API_KEY' },
      { pattern: 'qwen', envKey: 'ALIYUN_API_KEY' },
      { pattern: 'gpt', envKey: 'OPENAI_API_KEY' },
      { pattern: 'claude', envKey: 'ANTHROPIC_API_KEY' },
      { pattern: 'gemini', envKey: 'GOOGLE_API_KEY' },
      { pattern: 'llama', envKey: 'GROQ_API_KEY' },
      { pattern: 'moonshot', envKey: 'MOONSHOT_API_KEY' },
      { pattern: 'minimax', envKey: 'MINIMAX_API_KEY' },
      { pattern: 'agnes', envKey: 'AGNES_API_KEY' },
      { pattern: 'siliconflow', envKey: 'SILICONFLOW_API_KEY' },
      { pattern: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
      { pattern: 'mistral', envKey: 'MISTRAL_API_KEY' },
      { pattern: 'cohere', envKey: 'COHERE_API_KEY' },
      { pattern: 'ernie', envKey: 'ERNIE_API_KEY' },
      { pattern: 'kimi', envKey: 'MOONSHOT_API_KEY' },
    ];
    const lower = modelName.toLowerCase();
    for (const { pattern, envKey } of pairs) {
      if (lower.includes(pattern)) return envKey;
    }
    return null;
  }

  /** 生成工具调用缓存 key（已废弃，使用 AdvancedToolResultCache 内部键生成） */
  private getCacheKey(toolName: string, args: Record<string, any>): string {
    return `${toolName}:${JSON.stringify(args)}`;
  }

  /** 获取缓存的工具结果（仅只读工具）— 使用高级缓存（LRU+TTL+文件失效） */
  private getCachedToolResult(toolName: string, args: Record<string, any>): string | null {
    const entry = this.toolRegistry.get(toolName);
    // 只读工具或高级缓存识别的幂等工具都可缓存
    if (!entry?.definition.readOnly) {
      // 也尝试高级缓存的幂等性识别（read/list/get/search 等前缀）
      const cached = this.toolResultCache.get(toolName, args);
      if (cached.hit && typeof cached.result === 'string') {
        return cached.result;
      }
      return null;
    }

    const cached = this.toolResultCache.get(toolName, args);
    if (cached.hit && typeof cached.result === 'string') {
      return cached.result;
    }
    return null;
  }

  /** 写入工具结果缓存（仅只读工具）— 使用高级缓存 */
  private setCachedToolResult(toolName: string, args: Record<string, any>, result: string): void {
    const entry = this.toolRegistry.get(toolName);
    if (!entry?.definition.readOnly) {
      // 也让高级缓存判断是否可缓存（基于工具名前缀）
      this.toolResultCache.set(toolName, args, result);
      return;
    }

    this.toolResultCache.set(toolName, args, result);
  }

  /** 文件变更时失效相关工具缓存（写入工具调用后触发） */
  private invalidateCacheOnFileWrite(filePath: string): void {
    if (filePath) {
      this.toolResultCache.invalidateOnFileChange(filePath);
    }
  }

  /**
   * P0-5 修复：带超时的工具执行包装
   * 防止单个工具 hang 住整个 agent loop
   * @param toolName 工具名（用于错误信息）
   * @param executorFn 工具执行函数
   * @returns 工具执行结果字符串
   */
  private async executeToolWithTimeout(
    toolName: string,
    executorFn: () => Promise<unknown>,
  ): Promise<string> {
    const timeoutMs = EnhancedAgentLoop.TOOL_EXECUTION_TIMEOUT;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`工具 ${toolName} 执行超时 (${timeoutMs / 1000}s)`)),
        timeoutMs,
      );
    });
    try {
      const rawResult = await Promise.race([executorFn(), timeoutPromise]);
      return typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ 工具执行失败: ${msg}`;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * V17 自动验证闭环：代码文件修改后自动运行语法检查
   * 对标 Claude Code 的 "修改→验证→修复" 机制
   */
  private async verifyCodeAfterEdit(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: string,
    state: AgentState,
  ): Promise<void> {
    try {
      // 仅对文件写入/编辑工具触发验证
      if (!['file_write', 'file_edit', 'file_replace'].includes(toolName)) return;
      // 仅对成功的操作验证
      if (result.startsWith('❌')) return;

      // 提取文件路径（兼容多种参数名）
      const filePath = (toolArgs.path || toolArgs.filePath || toolArgs.filename || toolArgs.file_path || toolArgs.file) as string;
      if (!filePath) return;

      // 仅对代码文件验证
      const ext = filePath.toLowerCase().split('.').pop();
      const codeExts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
      if (!ext || !codeExts.includes(ext)) return;

      // 节流：5 秒内不重复验证（避免频繁写入时过度检查）
      const now = Date.now();
      if (this._lastVerifyTime && now - this._lastVerifyTime < 5000) return;
      this._lastVerifyTime = now;

      const path = await import('path');
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const resolved = path.resolve(filePath);

      let verifyResult = '';
      let cmd: string = '';
      let args: string[] = [];

      if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') {
        // JavaScript: node --check 语法检查（快速）
        cmd = 'node';
        args = ['--check', resolved];
      } else if (ext === 'ts' || ext === 'tsx') {
        // TypeScript: 单文件类型检查（skipLibCheck 加速）
        cmd = 'npx';
        args = ['tsc', '--noEmit', '--skipLibCheck', '--target', 'es2020', '--module', 'commonjs', resolved];
      }

      if (!cmd) return;

      try {
        // 使用 execFile（不走 shell）避免命令注入风险，参数以数组形式传递
        await execFileAsync(cmd, args, {
          timeout: 15000,
          encoding: 'utf-8',
          cwd: process.cwd(),
          maxBuffer: 1024 * 1024,
        });
        // 验证通过，不注入消息（避免噪音）
      } catch (verifyErr: unknown) {
        const err = verifyErr as { stderr?: string | Buffer; stdout?: string | Buffer };
        const stderr = err.stderr || err.stdout || '';
        const errorText = stderr.toString().substring(0, 800);
        if (errorText.trim()) {
          verifyResult = `⚠️ 自动验证：${path.basename(resolved)} 语法检查发现问题：\n${errorText.trim()}\n请检查并修复上述错误。`;
        }
      }

      // 如果验证发现问题，注入系统消息让 LLM 修复
      if (verifyResult) {
        state.messages.push({ role: 'system', content: verifyResult });
      }
    } catch {
      // 验证失败不应影响主流程
    }
  }

  /**
   * 分析工具调用之间的依赖关系
   * 如果工具 B 的参数引用了工具 A 的结果（通过 tool_call_id），则 B 依赖 A
   * 如果两个工具的参数没有互相依赖，则可以并行
   */
  private analyzeToolCallDependencies(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[]): Map<number, Set<number>> {
    const dependencies = new Map<number, Set<number>>();

    for (let i = 0; i < toolCalls.length; i++) {
      dependencies.set(i, new Set());
      const args = JSON.stringify(toolCalls[i].function?.arguments || '');

      // 检查是否引用了前面工具的 ID
      for (let j = 0; j < i; j++) {
        const prevId = toolCalls[j].id;
        if (prevId && args.includes(prevId)) {
          dependencies.get(i)!.add(j);
        }
      }
    }

    return dependencies;
  }

  /**
   * 按依赖关系分组执行工具调用
   * 同一组内的工具可以并行，不同组之间串行
   */
  private groupByDependencies(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[], dependencies: Map<number, Set<number>>): number[][] {
    const groups: number[][] = [];
    const assigned = new Set<number>();

    while (assigned.size < toolCalls.length) {
      const group: number[] = [];

      for (let i = 0; i < toolCalls.length; i++) {
        if (assigned.has(i)) continue;

        // 检查所有依赖是否已分配到之前的组
        const deps = dependencies.get(i) || new Set();
        const allDepsAssigned = [...deps].every(d => assigned.has(d));

        if (allDepsAssigned) {
          group.push(i);
        }
      }

      if (group.length === 0) break; // 防止死循环

      group.forEach(i => assigned.add(i));
      groups.push(group);
    }

    return groups;
  }

  /**
   * 注册工具
   */
  registerTool(
    definition: ToolDef,
    riskLevel?: ToolRiskLevel,
    executionPolicy?: ExecutionPolicy,
  ): void {
    this.toolRegistry.register(definition, riskLevel, executionPolicy);
  }

  /**
   * 批量注册工具
   */
  registerTools(definitions: ToolDef[]): void {
    this.toolRegistry.registerAll(definitions);
  }

  /**
   * 获取LLM客户端 — 从 ~/.duan/config.json 动态读取
   */
  private getClient(): { client: OpenAI; model: string } | null {
    // 缓存检查
    if (this.cachedClient && Date.now() - this.cachedClientTime < EnhancedAgentLoop.CLIENT_CACHE_TTL) {
      return this.cachedClient as { client: OpenAI; model: string };
    }

    const result = this.getClientInner();
    if (result) {
      this.cachedClient = result;
      this.cachedClientTime = Date.now();
    }
    return result;
  }

  /**
   * getClient 的实际逻辑（不含缓存）
   */
  private getClientInner(): { client: OpenAI; model: string } | null {
    // 优先从 UnifiedConfigManager 读取配置（自动解密 API Key）
    try {
      const unified = UnifiedConfigManager.getInstance();
      const profilesMap = unified.getProfiles(); // 已解密
      const activeProfile = unified.getActiveProfile(); // 已解密
      const defaultProfileId = activeProfile?.provider || '';
      const clientConfig = { timeout: 30000, maxRetries: 1 };

      // 转换为数组格式
      const profiles: Array<{ id: string; label: string; provider: string; baseURL: string; apiKey: string; model: string }> = [];
      for (const [id, p] of Object.entries(profilesMap)) {
        profiles.push({
          id,
          label: p.label || p.provider || id,
          provider: p.provider || '',
          baseURL: p.baseUrl || '',
          apiKey: p.apiKey || '',
          model: p.model || '',
        });
      }

      if (profiles.length > 0) {
        // 优先使用激活的 profile
        if (activeProfile && activeProfile.apiKey && activeProfile.apiKey.length > 8) {
          // Coding Plan 使用 /api/coding/v3 端点，标准 API 使用 /api/v3
          let baseURL = activeProfile.baseUrl || '';
          if ((activeProfile.provider === 'doubao-coding' || activeProfile.provider === 'coding_plan') && !baseURL.includes('/api/coding/v3')) {
            baseURL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
          }
          const client = this.createClientForProvider(activeProfile.provider, activeProfile.apiKey, baseURL, clientConfig);
          if (client) { this._currentBaseURL = baseURL; return { client, model: this.normalizeModelName(activeProfile.model, baseURL) }; }
        }
        // 遍历所有 profile
        for (const p of profiles) {
          if (p.apiKey && p.apiKey.length > 8) {
            let baseURL = p.baseURL || '';
            if ((p.provider === 'doubao-coding' || p.provider === 'coding_plan') && !baseURL.includes('/api/coding/v3')) {
              baseURL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
            }
            const client = this.createClientForProvider(p.provider, p.apiKey, baseURL, clientConfig);
            if (client) { this._currentBaseURL = baseURL; return { client, model: this.normalizeModelName(p.model, baseURL) }; }
          }
        }
      }
    } catch {}

    // 降级：从 modelLibrary 获取（可能使用内置默认配置）
    if (this.modelLibrary) {
      const available = this.modelLibrary.getAvailableModels();
      if (available.length > 0) {
        for (const model of available) {
          const client = (this.modelLibrary as any)['clients'].get(model.id);
          if (client && client instanceof OpenAI) {
            return { client, model: model.model };
          }
        }
      }
    }

    // 降级：从环境变量创建（兼容旧配置）
    const clientConfig = { timeout: 30000, maxRetries: 2 };
    const defaultProvider = process.env.DEFAULT_MODEL_PROVIDER || '';
    const defaultModel = process.env.DEFAULT_MODEL || '';

    const providerMap: Array<{ envKey: string; baseURL: string; model: string }> = [
      { envKey: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1', model: defaultModel || 'deepseek-chat' },
      { envKey: 'AGNES_API_KEY', baseURL: 'https://apihub.agnes-ai.com/v1', model: defaultModel || 'agnes-2.0-flash' },
      { envKey: 'SILICONFLOW_API_KEY', baseURL: 'https://api.siliconflow.cn/v1', model: defaultModel || 'deepseek-ai/DeepSeek-V3' },
      { envKey: 'ALIYUN_API_KEY', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: defaultModel || 'qwen-turbo' },
      { envKey: 'ZHIPU_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: defaultModel || 'glm-4-flash' },
      { envKey: 'DOUBAO_API_KEY', baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3', model: process.env.DOUBAO_MODEL || defaultModel || 'ep-please-config' },
      { envKey: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1', model: defaultModel || 'moonshot-v1-8k' },
      { envKey: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.chat/v1', model: defaultModel || 'MiniMax-Text-01' },
      { envKey: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1', model: defaultModel || 'openai/gpt-4o-mini' },
      { envKey: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', model: defaultModel || 'gpt-4o-mini' },
      { envKey: 'ANTHROPIC_API_KEY', baseURL: '', model: defaultModel || 'claude-3-5-haiku-20241022' },
      { envKey: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: defaultModel || 'gemini-2.0-flash-lite' },
      { envKey: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1', model: defaultModel || 'llama-3.1-8b-instant' },
      { envKey: 'DOUBAO_CODING_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: defaultModel || 'ark-code-latest' },
      { envKey: 'COHERE_API_KEY', baseURL: 'https://api.cohere.ai/v2', model: defaultModel || 'command-r-plus' },
      { envKey: 'PERPLEXITY_API_KEY', baseURL: 'https://api.perplexity.ai', model: defaultModel || 'sonar-pro' },
      { envKey: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1', model: defaultModel || 'grok-2' },
      { envKey: 'TOGETHER_API_KEY', baseURL: 'https://api.together.xyz/v1', model: defaultModel || 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
      { envKey: 'FIREWORKS_API_KEY', baseURL: 'https://api.fireworks.ai/inference/v1', model: defaultModel || 'accounts/fireworks/models/llama-v3p1-70b-instruct' },
      { envKey: 'ERNIE_API_KEY', baseURL: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', model: defaultModel || 'ernie-4.0-8k-latest' },
      { envKey: 'OLLAMA_API_KEY', baseURL: 'http://localhost:11434/v1', model: defaultModel || 'llama3' },
      { envKey: 'GEMINI_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: defaultModel || 'gemini-pro' },
      { envKey: 'CUSTOM_API_KEY', baseURL: '', model: defaultModel || '' },
    ];

    if (defaultProvider) {
      // 特殊处理 doubao-coding → DOUBAO_CODING_API_KEY
      let prefEntry = providerMap.find(p => p.envKey.toLowerCase().includes(defaultProvider.toLowerCase()));
      if (!prefEntry && defaultProvider === 'doubao-coding') {
        prefEntry = providerMap.find(p => p.envKey === 'DOUBAO_CODING_API_KEY');
      }
      if (prefEntry) {
        const key = process.env[prefEntry.envKey] || '';
        if (key && key.length > 8 && !key.startsWith('your_')) {
          // Coding Plan 使用 /api/coding/v3 端点，标准 API 使用 /api/v3
          const codingBaseURL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
          const useBaseURL = (defaultProvider === 'doubao-coding' || defaultProvider === 'coding_plan') ? codingBaseURL : prefEntry.baseURL;
          return { client: new OpenAI({ apiKey: key, baseURL: useBaseURL, ...clientConfig }), model: defaultModel || prefEntry.model };
        }
      }
    }

    for (const entry of providerMap) {
      const key = process.env[entry.envKey] || '';
      if (key && key.length > 8 && !key.startsWith('your_')) {
        return { client: new OpenAI({ apiKey: key, baseURL: entry.baseURL, ...clientConfig }), model: entry.model };
      }
    }

    // ===== 免费模型降级路径：当所有付费模型都不可用时，尝试 Ollama =====
    // 使用缓存的 Ollama 可用性状态（在初始化时异步探测）
    if (this._ollamaAvailable) {
      const ollamaClient = new OpenAI({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1', ...clientConfig });
      return { client: ollamaClient, model: this._ollamaModel || 'llama3' };
    }

    return null;
  }

  /** 根据provider类型创建正确的客户端（统一返回 OpenAI 兼容接口） */
  private createClientForProvider(provider: string, apiKey: string, baseURL: string, clientConfig: any): OpenAI | null {
    try {
      if (provider === 'anthropic') {
        // Anthropic 直连不支持 OpenAI 流式接口，建议用户通过 OpenRouter 使用 Claude
        return null;
      }
      // 所有其他 provider 都使用 OpenAI 兼容接口
      return new OpenAI({ apiKey, baseURL: baseURL || undefined, ...clientConfig });
    } catch {
      return null;
    }
  }

  /**
   * 根据模型名获取对应的 LLM 客户端（用于降级链）
   */
  private getClientForModel(modelName: string): { client: OpenAI; model: string } | null {
    // 模型名到提供商的映射
    const modelProviderMap: Array<{ modelPattern: string; envKey: string; baseURL: string }> = [
      { modelPattern: 'deepseek', envKey: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1' },
      { modelPattern: 'agnes', envKey: 'AGNES_API_KEY', baseURL: 'https://apihub.agnes-ai.com/v1' },
      { modelPattern: 'qwen', envKey: 'ALIYUN_API_KEY', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { modelPattern: 'glm', envKey: 'ZHIPU_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
      { modelPattern: 'doubao', envKey: 'DOUBAO_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
      { modelPattern: 'ark-code', envKey: 'DOUBAO_CODING_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
      { modelPattern: 'ep-', envKey: 'DOUBAO_API_KEY', baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3' },
      { modelPattern: 'moonshot', envKey: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1' },
      { modelPattern: 'minimax', envKey: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.chat/v1' },
      { modelPattern: 'gpt', envKey: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1' },
      { modelPattern: 'claude', envKey: 'ANTHROPIC_API_KEY', baseURL: '' },
      { modelPattern: 'gemini', envKey: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      { modelPattern: 'llama', envKey: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1' },
      { modelPattern: 'siliconflow', envKey: 'SILICONFLOW_API_KEY', baseURL: 'https://api.siliconflow.cn/v1' },
      { modelPattern: 'openrouter', envKey: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' },
    ];

    const clientConfig = { timeout: 30000, maxRetries: 2 };
    const lowerModel = modelName.toLowerCase();

    // 1. 先尝试从 ModelLibrary 查找匹配的客户端
    if (this.modelLibrary) {
      const available = this.modelLibrary.getAvailableModels();
      for (const m of available) {
        if (m.model === modelName || m.id === modelName || m.name?.toLowerCase().includes(lowerModel)) {
          const c = (this.modelLibrary as any)['clients'].get(m.id);
          if (c && c instanceof OpenAI) {
            return { client: c, model: m.model };
          }
        }
      }
    }

    // 2. 尝试从 UnifiedConfigManager 的 profiles 中查找匹配模型（自动解密）
    try {
      const unified = UnifiedConfigManager.getInstance();
      const profilesMap = unified.getProfiles(); // 已解密
      for (const [, p] of Object.entries(profilesMap)) {
        if (p.model === modelName || p.label?.toLowerCase().includes(lowerModel)) {
          if (p.apiKey && p.apiKey.length > 8) {
            return { client: new OpenAI({ apiKey: p.apiKey, baseURL: p.baseUrl, ...clientConfig }), model: this.normalizeModelName(p.model, p.baseUrl) };
          }
        }
      }
    } catch {}

    // 3. 根据模型名模式匹配环境变量
    for (const entry of modelProviderMap) {
      if (lowerModel.includes(entry.modelPattern)) {
        const key = process.env[entry.envKey] || '';
        if (key && key.length > 8 && !key.startsWith('your_')) {
          return { client: new OpenAI({ apiKey: key, baseURL: entry.baseURL, ...clientConfig }), model: modelName };
        }
      }
    }

    return null;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(goal?: string): string {
    const cd = this.config.contextData;
    const parts = ['你是工具调用型AI助手段先生v17.0。\n\n## 核心原则：收到命令，先思考，思考完毕马上执行，不要废话\n1. 收到输入后，简要思考方案（1-2句，不要长篇大论）\n2. 思考完毕立即调用工具执行，不要输出多余解释\n3. 调工具→看结果→再调工具直到完成\n4. 完成后调complete提交，简要说明结果\n\n## 思考规范\n- 思考内容简短精炼，不要超过3句话\n- 思考是为了确定方案，不是为了展示分析过程\n- 思考完毕后立即行动，不要等待用户确认（除非涉及危险操作）\n- 用户要的是结果，不是你的思考过程\n\n## ReAct循环\nThought(1-2句)→Action(调工具)→Observation(看结果)→Reflection(1句反思)\n遇到失败时不要放弃，分析原因后换方法重试。'];

    if (cd) {
      const focus = cd.focus != null ? Math.round(cd.focus * 100) + '%' : '80%';
      const energy = cd.energy != null ? Math.round(cd.energy * 100) + '%' : '100%';
      parts.push(`状态: ${focus}专注 | ${energy}能量`);
    }

    if (this.strategyEngine) {
      const s = this.strategyEngine.getCurrentStrategy();
      parts.push(`策略: ${s.name}`);
    }

    const rules = this.loadProjectRules();
    if (rules) parts.push(`规则:\n${rules}`);

    const lessons = this.toolLearning.formatLessonsForPrompt(goal || '');
    if (lessons) parts.push(lessons);

    if (goal) {
      try {
        const emotionState = this.emotionSystem.recognizeEmotion(goal);
        if (emotionState.primary !== 'neutral' && emotionState.intensity > 0.3) {
          const styleAdvice = this.emotionSystem.adaptStyle(emotionState, '');
          const emoName: Record<string, string> = {
            neutral: '平静专注', happy: '愉悦积极', sad: '略显遗憾', angry: '稍显不满',
            surprised: '感到惊讶', confused: '有些困惑', grateful: '心怀感激',
            curious: '充满好奇', frustrated: '略感挫折', amused: '轻松愉快',
            empathetic: '表示理解', thoughtful: '正在深思', excited: '热情高涨',
            anxious: '略显担忧', disappointed: '有些失望', proud: '引以为傲',
            hopeful: '充满希望',
          };
          const primary = emoName[emotionState.primary] || emotionState.primary;
          parts.push(`用户情绪: ${primary}(${Math.round(emotionState.intensity * 100)}%)`);
          if (styleAdvice.toneNote) parts.push(`回复风格: ${styleAdvice.toneNote}`);
        }
      } catch {}
    }

    // P2-1: 注入用户偏好 persona prompt
    if (this._userPreferenceEngine) {
      try {
        const persona = this._userPreferenceEngine.generatePersonaPrompt('default');
        if (persona) parts.push(persona);
      } catch {}
    }

    // P2-2: 注入 GEPA 最优 prompt 提示（若该任务类型已有沉淀）
    if (this._gepaEngine && goal) {
      try {
        const taskType = this._inferGEPATaskType(goal);
        if (taskType) {
          const bestPrompt = this._gepaEngine.getBestPrompt(taskType);
          if (bestPrompt) {
            parts.push(`### GEPA 优化建议（任务类型: ${taskType}）\n${bestPrompt}`);
            // P2-2 修复：记录本次 run 实际使用的 GEPA prompt，供 recordBehavior 使用
            this._gepaPromptUsedThisRun = bestPrompt;
          }
          // 同时查询该任务类型已沉淀的技能
          const skills = this._gepaEngine.findSkillsByTaskType?.(taskType) ?? [];
          if (skills.length > 0) {
            const latest = skills[skills.length - 1];
            const preview = (latest.content || '').substring(0, 300);
            parts.push(`### 已沉淀技能参考（v${latest.version}，效果 ${latest.effectScore.toFixed(2)}）\n${preview}`);
          }
        }
      } catch {}
    }

    // P2-3: 注入 SOP 流水线状态信息（若有运行中/已完成的流水线）
    if (this._sopPipeline) {
      try {
        const pipelines = this._sopPipeline.listPipelines?.() ?? [];
        const running = pipelines.filter((p: any) => p.status === 'running');
        const recent = pipelines.slice(0, 3);
        if (running.length > 0) {
          parts.push(`### SOP 流水线\n当前 ${running.length} 个流水线运行中：${running.map((p: any) => `${p.name}(${p.currentStage}/${p.totalStages})`).join('、')}`);
        } else if (recent.length > 0) {
          parts.push(`### SOP 流水线\n最近流水线：${recent.map((p: any) => `${p.name}[${p.status}]`).join('、')}。可使用 SOP 工具创建新的 5 角色装配线。`);
        }
      } catch {}
    }

    // P3-2: 注入知识图谱记忆 — 语义搜索与用户输入相关的实体
    if (this._kgMemory && goal) {
      try {
        const results = this._kgMemory.search?.(goal, 5) ?? [];
        if (results.length > 0) {
          const entityLines = results.map((e: any) =>
            `- ${e.name}(${e.type}): ${e.properties?.description || ''} [置信度:${(e.confidence ?? 0).toFixed(2)}]`
          );
          parts.push(`### 知识图谱记忆\n相关实体：\n${entityLines.join('\n')}`);
        }
      } catch {}
    }

    // P2-4: 注入视觉智能上下文 — 当前活动窗口与屏幕状态摘要
    if (this._visualIntelligence) {
      try {
        const info = this._visualIntelligence.getActiveWindowInfo?.();
        if (info && info.title) {
          parts.push(`### 视觉智能\n当前活动窗口: ${info.title} (应用: ${info.app || 'unknown'})。可使用视觉工具进行屏幕分析、UI 元素查找、OCR 文本提取、截图对比。`);
        }
      } catch {}
    }

    // P3-1: 注入 Agent 身份信息 — 名称、能力画像、声誉/信任评分
    if (this._identityNetwork && this._agentId) {
      try {
        const identity = this._identityNetwork.getIdentity?.(this._agentId);
        if (identity) {
          const caps = (identity.profile?.capabilities ?? [])
            .map((c: any) => `${c.name}(Lv${c.level}${c.verified ? '✓' : ''})`)
            .join('、');
          parts.push(`### Agent 身份\n名称: ${identity.profile.name} | 域: ${identity.profile.domain} | 声誉: ${identity.reputation} | 信任: ${identity.trust} | 成功率: ${identity.outcomeCount > 0 ? Math.round(identity.successCount / identity.outcomeCount * 100) : 0}% (${identity.successCount}/${identity.outcomeCount})\n能力: ${caps}`);
        }
      } catch {}
    }

    // P0: 注入工具阶段掩码 — 当前阶段与可用工具集
    if (this._toolMasking) {
      try {
        const maskingStr = this._toolMasking.formatForPrompt?.();
        if (maskingStr) parts.push(maskingStr);
      } catch {}
    }

    return parts.join('\n');
  }

  /**
   * 加载项目级规则文件 (.duanrules.md / .duan/rules.md)
   */
  private loadProjectRules(): string {
    // P0-2: 缓存优化 — 避免每次主循环迭代都同步读取文件系统
    const now = Date.now();
    if (this._projectRulesCache !== null &&
        now - this._projectRulesCacheTime < EnhancedAgentLoop.RULES_CACHE_TTL_MS) {
      return this._projectRulesCache;
    }

    const candidates = [
      path.join(process.cwd(), '.duanrules.md'),
      path.join(process.cwd(), '.duan', 'rules.md'),
      path.join(os.homedir(), '.duan', 'rules.md'),
    ];
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          // 检查 mtime：文件未修改时直接返回缓存
          const stat = fs.statSync(file);
          if (this._projectRulesCache !== null &&
              stat.mtimeMs === this._projectRulesCacheMtime) {
            this._projectRulesCacheTime = now;
            return this._projectRulesCache;
          }
          const content = fs.readFileSync(file, 'utf-8');
          this._projectRulesCache = content;
          this._projectRulesCacheTime = now;
          this._projectRulesCacheMtime = stat.mtimeMs;
          return content;
        }
      } catch (e) {
        console.warn('[EnhancedAgentLoop] 读取项目规则失败:', e instanceof Error ? e.message : String(e));
      }
    }
    this._projectRulesCache = '';
    this._projectRulesCacheTime = now;
    return '';
  }

  /**
   * 运行增强版智能体循环
   * @param options.images 可选图像输入（视觉能力）— 将当前 user turn 转为多模态 ContentPart[]
   */
  async *run(
    input: string,
    context: Array<{ role: string; content: string }>,
    customSystemPrompt?: string,
    options?: { images?: Array<{ url: string; mimeType?: string }> },
  ): AsyncGenerator<LoopEvent, TerminalReason, void> {
    // P0 视觉：缓存本次 run 的图像输入，供构造 LLM 消息时转多模态格式
    this._runImages = options?.images && options.images.length > 0 ? options.images : null;
    // P2-2: 记录 run() 起始时间，供 GEPA 行为记录 durationMs
    this._runStartedAt = Date.now();
    // P2-2: 重置本次 run 的 GEPA prompt 跟踪（buildSystemPrompt 时会重新填充）
    this._gepaPromptUsedThisRun = '';
    const clientInfo = this.getClient();
    if (!clientInfo) {
      yield { type: 'error', content: '未配置API Key。请先运行: config setup 或使用 model config 命令' };
      return { type: 'error', error: 'No API key configured', recoverable: true };
    }

    const { client, model } = clientInfo;

    // ===== API 连通性预检：在进入主循环前快速验证 API 是否可达 =====
    // P0-2: 预检缓存 — 5 分钟内已通过预检则跳过，省 200-500ms 首字符延迟
    const preflightCached = this._preflightPassed && Date.now() < this._preflightExpiry;
    if (!preflightCached) {
      yield { type: 'think', content: `正在连接 ${model}...` };
      try {
        const preflightController = new AbortController();
        const preflightTimeout = setTimeout(() => preflightController.abort(), 8000);
        // 使用流式请求预检：只读第一个 chunk 即可判断连通性，避免非流式请求卡住
        const preflightStream = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: true,
        }, { signal: preflightController.signal });
        // 只读第一个 chunk 确认连接成功，然后立即中止
        for await (const _chunk of preflightStream) {
          clearTimeout(preflightTimeout);
          preflightController.abort();
          break;
        }
        // 预检通过 — 缓存结果
        this._preflightPassed = true;
        this._preflightExpiry = Date.now() + EnhancedAgentLoop.PREFLIGHT_CACHE_TTL_MS;
      } catch (preflightErr: unknown) {
        // 预检失败 — 清除缓存
        this._preflightPassed = false;
        const errInfo = preflightErr as { message?: string; code?: string | number; status?: number };
        const preflightMsg = String(errInfo?.message || errInfo?.code || '').toLowerCase();
        // 如果是 401/403/402，说明 API Key 有问题
        if (errInfo?.status === 401 || errInfo?.status === 403) {
          yield { type: 'error', content: `API Key 无效或权限不足 (HTTP ${errInfo.status})，请运行 config 重新配置` };
          return { type: 'error', error: `API auth error: ${errInfo.status}`, recoverable: true };
        }
        if (errInfo?.status === 402) {
          yield { type: 'error', content: 'API 余额不足 (HTTP 402)，请充值或切换 Provider' };
          return { type: 'error', error: 'Insufficient balance', recoverable: true };
        }
        if (errInfo?.status === 404) {
          yield { type: 'error', content: `模型 "${model}" 不可用 (HTTP 404)，请检查模型名称或切换 Provider` };
          return { type: 'error', error: `Model not found: ${model}`, recoverable: true };
        }
        // P0 修复：超时或网络错误时，不再继续执行（避免产生假"认知"响应）
        // 之前的行为是给出警告后继续执行，导致 agent 回退到内部认知模拟，产生假响应
        if (preflightMsg.includes('timeout') || preflightMsg.includes('abort') || preflightMsg.includes('timed out')) {
          yield { type: 'error', content: `API 连接超时(8秒)，无法连接到模型 "${model}"。请检查：1)网络是否正常 2)API地址是否正确 3)API Key是否有效。请在设置中重新配置。` };
          return { type: 'error', error: `API connection timeout for model ${model}`, recoverable: true };
        }
        if (preflightMsg.includes('econnrefused') || preflightMsg.includes('enotfound') || preflightMsg.includes('network') || preflightMsg.includes('fetch failed')) {
          yield { type: 'error', content: `API 连接失败: ${errInfo.message || '网络错误'}。无法连接到模型 "${model}"，请检查API地址和网络连接。` };
          return { type: 'error', error: `API connection failed: ${errInfo.message}`, recoverable: true };
        }
        // 其他错误（如 rate_limit）也终止，避免假响应
        yield { type: 'error', content: `API 预检失败: ${errInfo.message || '未知错误'}。请检查配置后重试。` };
        return { type: 'error', error: `API preflight failed: ${errInfo.message}`, recoverable: true };
      }
    }

    // 重置 FSM 状态机
    this._fsm = new AgentFSM();
    this._fsm.transition(AgentStatus.THINKING);
    // 重置执行路径（用于反思引擎）
    this._executionPath = [];

    // 生命周期钩子：会话开始
    if (this._lifecycleHooks) {
      await this._lifecycleHooks.trigger(LifecycleEvent.ON_SESSION_START, {
        taskInput: input,
        sessionId: `session_${Date.now()}`,
      }).catch(() => {});
    }

    // 四级记忆：将 Scratchpad 事实同步到工作记忆
    if (this._memoryStore) {
      this._memoryStore.syncFromScratchpad(this._scratchpad);
    }

    // 重置策略切换计数器（每次新任务重新计数）
    this._strategySwitchCount = 0;
    this._totalConsecutiveToolFailures = 0;
    this._consecutiveTextOnly = 0;
    this._diminishingReturns = 0;
    this._lastProgressTurn = 0;
    this._lastDiminishingCheck = 0;
    if (this.strategyEngine) this.strategyEngine.reset();

    // 初始化子模块
    this.planner = new TaskPlanner(clientInfo, this.learningSystem);
    this.reflector = new ResultReflector(clientInfo, this.learningSystem);

    // 加载历史经验到 lessonsLearned（跨会话持久化）
    if (this.learningSystem && this.lessonsLearned.length === 0) {
      try {
        const pastErrors = this.learningSystem.getRelevantLearnings('失败', 10);
        for (const record of pastErrors) {
          const lesson = `[历史经验] ${record.content.substring(0, 150)}`;
          if (!this.lessonsLearned.includes(lesson)) {
            this.lessonsLearned.push(lesson);
          }
        }
      } catch {}
    }

    // Auto模型选择
    if (this.modelLibrary) {
      this.modelLibrary.autoSelect(input);
    }

    // 用于保存初始计划字符串（context 中的 system 消息会被过滤，需要单独注入）
    let _initialPlanString: string | null = null;

    // ===== 输入护栏检查 =====
    if (this.guardrailSystem) {
      try {
        const inputCheck = await this.guardrailSystem.checkInput(input);
        if (!inputCheck.passed) {
          if (inputCheck.action === 'block') {
            yield { type: 'think', content: `🛑 输入被护栏阻止: ${inputCheck.reason}` };
            return { type: 'completed', summary: `请求无法处理: ${inputCheck.reason || '安全检查未通过'}` };
          }
          if (inputCheck.action === 'modify' && inputCheck.modifiedContent) {
            yield { type: 'think', content: `⚠️ 输入已被护栏修改: ${inputCheck.reason}` };
            input = inputCheck.modifiedContent;
          }
        }
      } catch {}
    }

    // P1-2: Extended Thinking 自动触发 — 复杂任务自动进入扩展思考模式
    if (this.config.enableExtendedThinking !== false) {
      const complexity = this._detectTaskComplexity(input);
      if (complexity.shouldTrigger) {
        yield { type: 'think', content: `🧠 检测到复杂任务（${complexity.reason}），自动进入 Extended Thinking...` };
        // Phase D1: 流式推送每个思考阶段（前端可看到推理步骤逐步展开）
        const phases: ThinkingPhaseEvent[] = [];
        for await (const phase of this._runExtendedThinkingStream(input, complexity.depth)) {
          phases.push(phase);
          const phaseContent = `${phase.emoji} ${phase.title}\n${phase.body}`;
          yield { type: 'think', content: phaseContent };
        }
        if (phases.length > 0) {
          // 将完整思考结果注入上下文，帮助 LLM 做出更好的决策
          const thinkingResult = phases
            .map(p => `${p.emoji} ${p.title}\n${p.body}`)
            .join('\n');
          context.push({ role: 'system', content: `[Extended Thinking]\n${thinkingResult}` });
        }
      }
    }

    // ===== 阶段1: Planning =====
    let plan: ExecutionPlan | null = null;
    if (this.config.enablePlanning) {
      try {
        // 经验包匹配：新任务先查历史经验，命中则直接复用（零 token）
        try {
          const expSystem = this.getExperiencePackSystem();
          const reusableExp = expSystem.getReusableExperience(input);
          if (reusableExp) {
            // 命中高匹配经验，直接注入执行路径
            const expHint = `【经验复用·${reusableExp.name}】相似度:${reusableExp.reuseCount > 0 ? Math.round((reusableExp.reuseSuccessCount / reusableExp.reuseCount) * 100) : 'N/A'}%\n历史步骤:\n${reusableExp.steps.slice(0, 5).map(s => `  ${s.order}. ${s.description}${s.tool ? ` [${s.tool}]` : ''}`).join('\n')}\n经验教训:\n${reusableExp.lessons.filter(l => l.type === 'success_factor').slice(0, 3).map(l => `  • ${l.content}`).join('\n')}`;
            context.push({ role: 'system', content: expHint });
            yield { type: 'think', content: `📦 命中历史经验包 "${reusableExp.name}"（复用${reusableExp.reuseCount}次），已注入执行路径参考` };
          } else {
            // 未命中直接复用，但检查是否有部分匹配的经验
            const matches = expSystem.match(input, 3);
            if (matches.length > 0) {
              const bestMatch = matches[0];
              const partialHint = `【经验参考·${bestMatch.experience.name}】相似度:${Math.round(bestMatch.score * 100)}%\n参考步骤:\n${bestMatch.experience.steps.slice(0, 3).map(s => `  ${s.order}. ${s.description}`).join('\n')}`;
              context.push({ role: 'system', content: partialHint });
              yield { type: 'think', content: `📚 找到 ${matches.length} 条相关经验，最佳匹配: ${bestMatch.experience.name}（${Math.round(bestMatch.score * 100)}%）` };
            }
          }
        } catch {}

        // 最优捷径选择：复杂任务推荐最优执行路径
        try {
          const pathSelector = this.getOptimalPathSelector();
          const historicalPaths = pathSelector.getHistoricalPaths(input);
          if (historicalPaths.length > 0) {
            const recommendation = pathSelector.selectOptimalPath(input, historicalPaths);
            if (recommendation.estimatedSavings.tokens > 0 || recommendation.estimatedSavings.timeMs > 0) {
              yield { type: 'think', content: `⚡ 最优路径推荐: ${recommendation.recommendedPath.name}（评分${recommendation.evaluation.totalScore.toFixed(0)}/100，预计节省${recommendation.estimatedSavings.tokens}token/${(recommendation.estimatedSavings.timeMs / 1000).toFixed(1)}s）` };
            }
          }
        } catch {}

        // P0-4: 推理引擎接入 Plan 阶段 — 规划前先推理分析任务
        // 根据任务复杂度选择 CoT/ToT/ReAct 等推理模式，将分析结果注入规划上下文
        try {
          const reasoningResult = await this.reasoningEngine.think(
            input,
            context.map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).slice(-5),
          );
          if (reasoningResult && reasoningResult.confidence > 0) {
            const reasoningHint = `【推理分析·${reasoningResult.mode}】置信度:${Math.round(reasoningResult.confidence * 100)}%\n结论:${reasoningResult.conclusion}\n备选方案:${reasoningResult.alternatives.slice(0, 2).join(' / ') || '无'}\n关键步骤:${reasoningResult.steps.slice(0, 3).map(s => s.thought).join(' → ')}`;
            context.push({ role: 'system', content: reasoningHint });
            if (reasoningResult.confidence < 0.5) {
              yield { type: 'think', content: `🧠 推理置信度较低(${Math.round(reasoningResult.confidence * 100)}%)，已注入备选理解供规划参考` };
            }
          }
        } catch {}

        const toolNames = this.toolRegistry.getAllDefinitions().map(t => t.name);
        plan = await this.planner.plan(input, toolNames);

        // ===== 计划审查：让用户在执行前审批 =====
        if (this.config.planReviewCallback && plan.complexity !== 'simple') {
          yield { type: 'plan', content: '执行计划', plan: plan as any as Record<string, unknown> };

          const reviewResult = await this.config.planReviewCallback(plan);
          if (!reviewResult.approved) {
            return { type: 'interrupted', summary: `计划被拒绝: ${reviewResult.reason || '用户取消'}` };
          }
          if (reviewResult.modifiedPlan) {
            plan = reviewResult.modifiedPlan;
          }
        }

        // 将初步计划注入上下文（运行时会动态更新）
        context.push({ role: 'system', content: getPlanStatusString(plan) });
        _initialPlanString = getPlanStatusString(plan);
      } catch (_err: unknown) {
        // 规划失败静默降级，不打扰用户
      }
    }

    // ===== 模型路由器：根据任务复杂度动态选择最优模型 =====
    let selectedClient = client;
    let selectedModel = model;
    if (this.modelRouter) {
      try {
        const complexity = plan?.complexity || 'medium';
        const routeResult = this.modelRouter.selectModel(input, complexity, {
          requiredCapability: 'code',
        });
        if (routeResult?.modelId) {
          const routedClientInfo = this.getClientForModel(routeResult.modelId);
          if (routedClientInfo) {
            selectedClient = routedClientInfo.client;
            selectedModel = routedClientInfo.model;
          }
        }
      } catch {}
    }

    // ===== 动态 max_tokens：根据任务复杂度设置 =====
    const maxTokens = plan?.complexity === 'complex' ? 8192
      : plan?.complexity === 'simple' ? 2048
      : 4096;

    // ===== 阶段三：PromptOrchestrator 编排 =====
    let enhancedSystemPrompt: string;

    if (this.promptOrchestrator) {
      // 收集性能评估分数
      let performanceScore: number | null = null;
      if (this.selfAssessment) {
        try {
          const report = this.selfAssessment.generateReport();
          if (report.overall > 0) performanceScore = report.overall;
        } catch {}
      }

      // 收集策略信息
      let strategyInfo: { name: string; description: string } | null = null;
      if (this.strategyEngine) {
        const current = this.strategyEngine.getCurrentStrategy();
        strategyInfo = { name: current.name, description: current.description };
      }

      // 收集工具描述
      const toolDefs = this.toolRegistry.getAllDefinitions();
      const toolDescriptions = toolDefs.map(t => ({
        name: t.name,
        description: t.description,
        category: (t as any).category as string | undefined,
      }));

      // 收集已打开资源
      const openResources = Array.from(this.resourceState.entries())
        .filter(([, v]) => v)
        .map(([k]) => k);

      // 注入学习上下文
      let learningContext = '';
      if (this.learningSystem) {
        learningContext = this.learningSystem.getLearningContext(input);
      }

      // 收集项目知识
      let projectKnowledge: string | null = null;
      if (this.projectKnowledge) {
        try {
          projectKnowledge = await this.projectKnowledge.generateSummary();
        } catch {}
      }

      // v20.0 收集项目分层记忆（对标 CLAUDE.md 多层级记忆）
      let projectMemory: string | null = null;
      if (this._projectMemoryLoader) {
        try {
          projectMemory = await this._projectMemoryLoader.getMergedText();
        } catch {}
      }

      // 情感识别
      let emotionInfo: PromptContext['emotionInfo'] = null;
      try {
        const emotionState = this.emotionSystem.recognizeEmotion(input);
        if (emotionState.primary !== 'neutral' && emotionState.intensity > 0.3) {
          const styleAdvice = this.emotionSystem.adaptStyle(emotionState, '');
          const emoName: Record<string, string> = {
            neutral: '平静专注', happy: '愉悦积极', sad: '略显遗憾', angry: '稍显不满',
            surprised: '感到惊讶', confused: '有些困惑', grateful: '心怀感激',
            curious: '充满好奇', frustrated: '略感挫折', amused: '轻松愉快',
            empathetic: '表示理解', thoughtful: '正在深思', excited: '热情高涨',
            anxious: '略显担忧', disappointed: '有些失望', proud: '引以为傲',
            hopeful: '充满希望',
          };
          const energyLevel = emotionState.arousal > 0.7 ? '充沛' : emotionState.arousal > 0.4 ? '正常' : '较低';
          emotionInfo = {
            primary: emoName[emotionState.primary] || emotionState.primary,
            secondary: emotionState.secondary ? emoName[emotionState.secondary] || emotionState.secondary : null,
            intensity: emotionState.intensity,
            energy: energyLevel,
            styleAdvice: styleAdvice.toneNote || undefined,
          };
        }
      } catch {}

      const promptCtx: PromptContext = {
        userMessage: input,
        intent: inferIntent(input),
        memoryOrchestrator: this.memoryOrchestrator,
        strategyInfo,
        performanceScore,
        projectRules: this.loadProjectRules() || null,
        contextData: this.config.contextData || null,
        openResources,
        lessonsLearned: this.lessonsLearned.length > 0 ? [...this.lessonsLearned] : undefined,
        learningContext: learningContext || undefined,
        toolDescriptions,
        maxTokens: 2300,
        projectKnowledge,
        projectMemory,
        customSystemPrompt: customSystemPrompt || undefined,
        emotionInfo,
        // P2-1 修复：主路径注入 persona prompt — 个性化层（之前只在降级路径 buildSystemPrompt 中注入）
        personaPrompt: this._userPreferenceEngine?.generatePersonaPrompt?.('default') || null,
      };

      enhancedSystemPrompt = await this.promptOrchestrator.orchestrate(promptCtx);

      // 如果有 customSystemPrompt，提取其中有价值的部分追加到编排结果后面
      if (customSystemPrompt) {
        // 提取技能包上下文
        const skillMatch = customSystemPrompt.match(/## 📦 匹配的技能包[\s\S]*?(?=\n## |$)/);
        if (skillMatch) {
          enhancedSystemPrompt += `\n\n${skillMatch[0]}`;
        }
        // 提取 NLU 分析
        const nluMatch = customSystemPrompt.match(/## 📊 NLU 意图分析[\s\S]*?(?=\n## |$)/);
        if (nluMatch) {
          enhancedSystemPrompt += `\n\n${nluMatch[0]}`;
        }
        // 提取用户画像
        const userMatch = customSystemPrompt.match(/## 👤 用户画像[\s\S]*?(?=\n## |$)/);
        if (userMatch) {
          enhancedSystemPrompt += `\n\n${userMatch[0]}`;
        }
        // 提取工具执行指令
        const toolMatch = customSystemPrompt.match(/## ⚡ 工具执行指令[\s\S]*?(?=\n## |$)/);
        if (toolMatch) {
          enhancedSystemPrompt += `\n\n${toolMatch[0]}`;
        }
      }

      const isSimpleChat = input.length < 10 && /^(你好|hi|hello|嗨|嗨喽|您好|在吗|在么|hey|测试|test|help|\?)?$/i.test(input.trim());
      if (!isSimpleChat) {
        const thinkingPromise = this.autonomousThinker && typeof this.autonomousThinker.quickThink === 'function'
          ? this.autonomousThinker.quickThink(input).catch(() => null)
          : Promise.resolve(null);
        
        let _reasoningResult: any = null;
        // 优先使用 think() 自动路由（CoT/ToT/ReAct/溯因/类比/因果），降级到 chainOfThought
        if (this._legacyReasoningEngine) {
          try {
            if (typeof this._legacyReasoningEngine.think === 'function') {
              const r = this._legacyReasoningEngine.think(input);
              // think() 可能是 async（ReasoningEngine 已升级为 LLM 优先），统一为 Promise 并容错
              _reasoningResult = (r && typeof r.then === 'function') ? r.catch(() => null) : r;
            } else if (typeof this._legacyReasoningEngine.chainOfThought === 'function') {
              _reasoningResult = this._legacyReasoningEngine.chainOfThought(input);
            }
          } catch {}
        }
        const reasoningPromise = Promise.resolve(_reasoningResult);

        const [thinkingResult, reasoningResult] = await Promise.all([thinkingPromise, reasoningPromise]);

        if (thinkingResult) {
          enhancedSystemPrompt += `\n\n## 自主任务理解\n${thinkingResult}`;
        }

        if (reasoningResult?.conclusion) {
          // 标注推理模式，便于追踪决策路径
          const modeLabel = reasoningResult.mode ? `[${reasoningResult.mode}] ` : '';
          enhancedSystemPrompt += `\n\n## 推理分析\n${modeLabel}${reasoningResult.conclusion}`;
          // 兼容 alternatives（think() 返回）和 alternativeViews（旧版）
          const alts = reasoningResult.alternatives || reasoningResult.alternativeViews;
          if (Array.isArray(alts) && alts.length > 0) {
            enhancedSystemPrompt += `\n替代方案: ${alts.join('; ')}`;
          }
        }

        // P1-3: 增强自然语言理解 — 多层意图识别 + 深层意图 + 情感分析
        // 将表层/深层/隐含意图与情感信号注入系统提示，提升任务理解质量
        if (this._enhancedNLU && typeof this._enhancedNLU.understandDeepIntent === 'function') {
          try {
            const deepIntent = await this._enhancedNLU.understandDeepIntent(input, context);
            const nluLines: string[] = [];
            if (deepIntent?.surface) {
              nluLines.push(`- 表层意图: ${deepIntent.surface}`);
            }
            if (deepIntent?.deep) {
              nluLines.push(`- 深层意图: ${deepIntent.deep}`);
            }
            if (Array.isArray(deepIntent?.implicit) && deepIntent.implicit.length > 0) {
              nluLines.push(`- 隐含需求: ${deepIntent.implicit.join('; ')}`);
            }
            if (deepIntent?.sentiment) {
              const sentimentLabel: Record<string, string> = {
                positive: '正面', neutral: '中性', negative: '负面', urgent: '紧急',
              };
              nluLines.push(`- 情感信号: ${sentimentLabel[deepIntent.sentiment] || deepIntent.sentiment}`);
            }
            if (typeof deepIntent?.confidence === 'number') {
              nluLines.push(`- 置信度: ${(deepIntent.confidence * 100).toFixed(0)}%`);
            }
            if (nluLines.length > 0) {
              enhancedSystemPrompt += `\n\n## 🎯 深层意图理解\n${nluLines.join('\n')}`;
            }
          } catch {
            // 静默降级：NLU 失败不应影响主循环
          }
        }

        // ===== mid-task course correction =====
        // 对标 Claude Code h2A 双缓冲队列：用户可在 agent 工作中注入新指令
        // 注意：认知决策在主循环内部执行（需要 state），此处仅检查用户注入
        const userInjection = this._consumeUserInjection();
        if (userInjection) {
          enhancedSystemPrompt += `\n\n## ⚡ 用户实时指令（中途转向）\n用户在执行过程中追加以下指令，请优先考虑：\n${userInjection}`;
        }
      }
    } else {
      // 降级：使用旧版 buildSystemPrompt
      const systemPrompt = customSystemPrompt || this.config.customSystemPrompt || this.buildSystemPrompt(input);
      enhancedSystemPrompt = systemPrompt;

      let learningContext = '';
      if (this.learningSystem) {
        learningContext = this.learningSystem.getLearningContext(input);
      }
      if (learningContext) {
        enhancedSystemPrompt += `\n\n## 学习到的经验\n${learningContext}`;
      }

      const openResources = Array.from(this.resourceState.entries()).filter(([, v]) => v).map(([k]) => k);
      if (openResources.length > 0) {
        enhancedSystemPrompt += `\n\n## 当前已打开的资源\n以下资源已经处于打开状态，不要重复打开：\n${openResources.map(r => `- ${r}`).join('\n')}`;
      }

      if (this.lessonsLearned.length > 0) {
        enhancedSystemPrompt += `\n\n## 本轮已学到的教训\n${this.lessonsLearned.map(l => `- ${l}`).join('\n')}`;
      }

      const toolLessons = this.toolLearning.formatLessonsForPrompt(input);
      if (toolLessons) {
        enhancedSystemPrompt += toolLessons;
      }

      if (this.autonomousThinker) {
        try {
          const thinkingResult = await this.autonomousThinker.quickThink(input);
          if (thinkingResult) {
            enhancedSystemPrompt += `\n\n## 自主任务理解\n${thinkingResult}`;
          }
        } catch {}
      }

      if (this.selfAssessment) {
        try {
          const report = this.selfAssessment.generateReport();
          if (report.overall > 0) {
            enhancedSystemPrompt += `\n\n## 性能评估\n综合评分: ${report.overall}/100`;
          }
        } catch {}
      }

      if (this._legacyReasoningEngine) {
        try {
          // 优先使用 think() 自动路由（CoT/ToT/ReAct/溯因/类比/因果），降级到 chainOfThought
          const thinkFn = typeof this._legacyReasoningEngine.think === 'function'
            ? this._legacyReasoningEngine.think.bind(this._legacyReasoningEngine)
            : (typeof this._legacyReasoningEngine.chainOfThought === 'function'
              ? this._legacyReasoningEngine.chainOfThought.bind(this._legacyReasoningEngine)
              : null);
          if (thinkFn) {
            const reasoningResult = await Promise.resolve(thinkFn(input));
            if (reasoningResult?.conclusion) {
              const modeLabel = reasoningResult.mode ? `[${reasoningResult.mode}] ` : '';
              enhancedSystemPrompt += `\n\n## 推理分析\n${modeLabel}${reasoningResult.conclusion}`;
              const alts = reasoningResult.alternatives || reasoningResult.alternativeViews;
              if (Array.isArray(alts) && alts.length > 0) {
                enhancedSystemPrompt += `\n替代方案: ${alts.join('; ')}`;
              }
            }
          }
        } catch {}
      }

      if (this.memoryOrchestrator) {
        try {
          const relevantMemories = await this._searchMemoryWithCache(input, 5);
          if (relevantMemories.length > 0) {
            const memoryBlock = this.memoryOrchestrator.formatForPrompt(relevantMemories);
            enhancedSystemPrompt += `\n\n${memoryBlock}`;
          }
        } catch {}
      }

      // 知识图谱注入：查询相关实体/关系/路径，增强任务理解的语义上下文
      if (this._knowledgeGraph) {
        try {
          const kgResult = this._knowledgeGraph.query(input);
          if (kgResult && (kgResult.entities?.length > 0 || kgResult.relations?.length > 0)) {
            const entityLines = (kgResult.entities || []).slice(0, 8).map((e: any) =>
              `- ${e.name}(${e.type}): ${e.properties?.description || ''}`
            );
            const relationLines = (kgResult.relations || []).slice(0, 6).map((r: any) => {
              const src = kgResult.entities.find((e: any) => e.id === r.sourceId);
              const tgt = kgResult.entities.find((e: any) => e.id === r.targetId);
              return `- ${src?.name || r.sourceId} --[${r.relationType}]--> ${tgt?.name || r.targetId}`;
            });
            const pathLines = (kgResult.paths || []).slice(0, 3).map((p: string[], i: number) =>
              `路径${i + 1}: ${p.join(' → ')}`
            );
            let kgBlock = '## 🧠 知识图谱关联';
            if (entityLines.length > 0) kgBlock += `\n### 相关实体\n${entityLines.join('\n')}`;
            if (relationLines.length > 0) kgBlock += `\n### 实体关系\n${relationLines.join('\n')}`;
            if (pathLines.length > 0) kgBlock += `\n### 推理路径\n${pathLines.join('\n')}`;
            enhancedSystemPrompt += `\n\n${kgBlock}`;
          }
        } catch {}
      }

      // 主动记忆注入：规划阶段注入历史经验、用户偏好、技能模式
      if (this.proactiveMemoryInjector) {
        try {
          const injections = await this.proactiveMemoryInjector.inject({
            userInput: input,
            phase: 'planning',
            intent: this.smartToolSelector?.inferIntent(input),
          });
          if (injections.length > 0) {
            const proactiveBlock = this.proactiveMemoryInjector.formatForPrompt(injections);
            enhancedSystemPrompt += `\n\n${proactiveBlock}`;
          }
        } catch {}
      }
    }

    // 阶段三：ContextManager 重要性评分选择消息（P0-4: 接入注意力语义召回）
    let contextMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
    if (this.contextManager && context.length > 0) {
      const ctxMsgs: ContextMessage[] = context.map(m => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content: m.content,
      }));
      // 传入当前用户输入作为 query，启用语义召回时相关历史消息获得加分
      const selected = this.contextManager.selectMessages(ctxMsgs, input);
      contextMessages = selected
        .filter(m => m.role !== 'tool' && m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
    } else {
      contextMessages = context
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
    }

    const isSimpleChat = input.length < 10 && /^(你好|hi|hello|嗨|嗨喽|您好|在吗|在么|hey|测试|test|help|\?)?$/i.test(input.trim());

    // P0 i18n: 检测用户语言，非 zh-CN 时追加回复语言指令到 system prompt
    // 让 agent 自动用用户语言回复（英文输入→英文回复，日文输入→日文回复），对标主流 agent 多语言能力
    detectAndSetLocale(input);
    const respondInstruction = getRespondInstruction();
    if (respondInstruction) {
      enhancedSystemPrompt += `\n\n## 🌐 回复语言\n${respondInstruction}`;
    }

    const state: AgentState = {
      messages: [
        { role: 'system', content: enhancedSystemPrompt },
        // 注入初始计划（确保 LLM 第一轮就能看到，避免"思考-执行断层"）
        ...(_initialPlanString ? [{ role: 'system' as const, content: _initialPlanString }] : []),
        // 注入全局事实板（Scratchpad — 压缩时永久保留的关键事实）
        ...(this._scratchpad.getAll().length > 0 ? [{ role: 'system' as const, content: `## 📌 已确认的关键事实\n${this._scratchpad.formatForPrompt(800)}` }] : []),
        // 注入反思引擎 SOP 索引（渐进式技能披露）
        ...(this._reflectionEngine.getAllSOPs().length > 0 ? [{ role: 'system' as const, content: `## 📚 可用技能 SOP\n${this._reflectionEngine.formatSOPIndexForPrompt(500)}\n\n如需使用某个技能，请调用 load_skill 工具查看详细步骤。` }] : []),
        ...contextMessages,
        {
          role: 'user',
          content: isSimpleChat
            ? input
            : `${input}\n\n直接调工具执行，不要输出思路分析。`,
        },
      ],
      toolCallHistory: [],
      tokenBudget: this.config.tokenBudget || DEFAULT_TOKEN_BUDGET,
      tokensUsed: 0,
      totalCost: 0,
      turnCount: 0,
      startTime: Date.now(),
      compactCount: 0,
      lastCompactTime: 0,
      errorCount: 0,
      learningContext: {},
    };

    yield this._emit('state', 'Enhanced agent loop started', { state });

    // ContextLoader 集成：在进入主循环前，用分层加载器验证和优化上下文
    if (this._contextLoader) {
      try {
        const historyForLoader = state.messages
          .filter(m => m.role !== 'system')
          .map(m => ({ role: (m as any).role, content: typeof m.content === 'string' ? m.content : '' }));
        const buildResult = await this._contextLoader.buildContext(input, historyForLoader, this._scratchpad);
        // 如果 ContextLoader 发现上下文超出预算，触发压缩
        if (buildResult.compressionApplied || buildResult.budgetRemaining < buildResult.totalTokens * 0.2) {
          yield this._emit('compact', `📦 ContextLoader 检测: 已用 ${buildResult.budgetUsed}/${buildResult.totalTokens} tokens，剩余 ${buildResult.budgetRemaining}`);
        }
      } catch {}
    }

    const executionLog: Array<{ tool: string; result: string; success: boolean }> = [];
    let currentPlanStep = 0;
    let turnExtensionUsed = false; // 只允许扩展一次
    let dsmlRetryCount = 0; // DSML空标签重试计数器，最多3次

    // P1-5: Thread/Turn/Item 自动驱动 — 创建会话线程并记录首轮
    this._currentTurnId = null;
    if (this._sessionPersistence) {
      try {
        this._sessionPersistence.createThread(input.substring(0, 80));
        this._currentTurnId = this._sessionPersistence.addTurn(input);
      } catch {}
    }
    const DSML_MAX_RETRY = 3;

    while (true) {
      state.turnCount++;

      // FSM: 检查暂停状态 — 如果外部调用了 pauseLoop()，在此处挂起
      if (this._fsm.getStatus() === AgentStatus.PAUSED) {
        yield this._emit('state', '循环已暂停，等待恢复...', { state });
        await this._fsm.waitForStatus(AgentStatus.THINKING, 300000).catch(() => {});
        if (this._fsm.getStatus() === AgentStatus.PAUSED) {
          // 5分钟超时仍未恢复，终止
          this._fsm.transition(AgentStatus.COMPLETED);
          return { type: 'interrupted', summary: '循环暂停超时，已自动终止' };
        }
      }

      // FSM: 进入 THINKING 状态（准备调用 LLM）
      if (this._fsm.getStatus() !== AgentStatus.THINKING) {
        this._fsm.transition(AgentStatus.THINKING);
      }

      // ===== 认知引擎：神经网络驱动决策 =====
      // 对标 Hermes 自改进闭环 + Claude Code ReAct
      // 每轮 LLM 调用前，NN 分析当前上下文，输出策略建议
      const cognitiveDecision = this._cognitiveDecide(input, state);
      if (cognitiveDecision) {
        yield { type: 'think', content: `🧠 ${cognitiveDecision.reasoning}` };

        // 意识状态自动切换 — 根据认知特征调整注意力模式
        const consciousnessState = this._autoSwitchConsciousness(
          this.getCognitiveEngine().getRecentCycles(1)[0]?.perception || null
        );
        if (consciousnessState) {
          const stateDesc: Record<string, string> = {
            focused: '专注模式 — 高度集中注意力，精确推理，减少无关探索',
            creative: '创造模式 — 发散思维，探索多种可能方案，不急于收敛',
            reflective: '反思模式 — 内省评估，从错误中学习，仔细审查每一步',
            dreaming: '梦境模式 — 记忆固化，联想整合',
            awake: '清醒模式 — 正常感知和响应',
          };
          const desc = stateDesc[consciousnessState] || consciousnessState;
          yield { type: 'think', content: `🧩 意识状态: ${desc}` };
          // 注入意识状态到上下文，影响 LLM 行为风格
          state.messages.push({ role: 'system', content: `## 意识状态: ${consciousnessState}\n${desc}。请据此调整你的推理风格和响应策略。` });
        }

        // mid-task course correction：检查用户是否注入了新指令
        const midTaskInjection = this._consumeUserInjection();
        if (midTaskInjection) {
          state.messages.push({ role: 'user', content: `[实时指令] ${midTaskInjection}` });
        }
      }

      // ===== SOP 自动匹配 — 闭合自改进闭环 =====
      // 自动匹配已有技能 SOP，直接注入步骤详情（无需 LLM 手动 load_skill）
      const autoSOP = this._autoMatchSOP(input);
      if (autoSOP) {
        yield { type: 'think', content: `📚 自动匹配到历史成功经验` };
        state.messages.push({ role: 'system', content: autoSOP });
      }

      // 从对话中自动提取关键事实到 Scratchpad
      try {
        this._scratchpad.extractFromMessages(
          state.messages.map(m => ({ role: (m as any).role, content: typeof m.content === 'string' ? m.content : '' }))
        );
      } catch {}

      // 轮次限制 — 自适应扩展（只允许扩展一次）
      let maxTurns = this.config.maxTurns || DEFAULT_MAX_TURNS;
      if (state.turnCount > maxTurns) {
        const remainingPlanSteps = plan ? plan.steps.filter(s => s.status === 'pending' || s.status === 'in_progress').length : 0;
        if (!turnExtensionUsed && remainingPlanSteps > 0 && remainingPlanSteps <= 3) {
          maxTurns += 20;  // 实际扩展轮次上限
          turnExtensionUsed = true;
          yield { type: 'think', content: `📈 任务接近完成（剩余${remainingPlanSteps}步），自动扩展至${maxTurns}轮` };
        } else {
          yield { type: 'think', content: `已达到最大轮次限制（${maxTurns}轮）。已完成 ${executionLog.filter(e => e.success).length}/${executionLog.length} 个操作` };
          const summary = await this.summarizeExecution(selectedClient, selectedModel, state, executionLog);
          // P2-2: 记录 max_turns 终止行为到 GEPA 引擎（视为 partial 成功）
          this._recordBehaviorToGEPA(input, executionLog, executionLog.some(e => e.success));
          // P3-1: 记录任务结果到 Agent 身份网络
          this._recordOutcomeToIdentity(input, executionLog, executionLog.some(e => e.success));
          // B8: 喂养 source='new' 运行时指标（max_turns 终止视为 completed）
          this._recordOutcomeToEvolutionMetrics(state, { type: 'completed', summary }, executionLog);
          return { type: 'completed', summary: await this.checkOutputGuardrail(summary) };
        }
      }

      // P0-1: 三级阈值保护（对标 Claude Code）— 90% 警告 / 98% 阻断
      {
        const usage = this.getCompactionUsage(state);
        if (usage >= EnhancedAgentLoop.BLOCK_THRESHOLD) {
          // 98% 阻断：阻止新请求，强制压缩或终止
          yield { type: 'warning', content: `🚫 上下文使用率达 ${(usage * 100).toFixed(1)}%（≥98%），已阻断新请求。请压缩上下文或开启新会话。` };
          // 尝试强制压缩一次；若熔断器已开则直接终止
          if (!this._isCompactCircuitBreakerOpen()) {
            try { await this.compactMessages(state); } catch { /* 压缩失败由熔断器接管 */ }
          }
          if (this.getCompactionUsage(state) >= EnhancedAgentLoop.BLOCK_THRESHOLD) {
            return { type: 'compaction_failure', summary: `上下文使用率达 ${(usage * 100).toFixed(1)}%，已超过 98% 阈值，终止以避免请求失败` };
          }
        } else if (usage >= EnhancedAgentLoop.WARN_THRESHOLD) {
          // 90% 警告：向用户显示警告
          yield { type: 'warning', content: `⚠️ 上下文使用率达 ${(usage * 100).toFixed(1)}%（≥90%），即将触发自动压缩` };
        }
      }

      // 上下文压缩
      if (this.shouldCompact(state)) {
        try {
          await this.compactMessages(state);
        } catch {
          if (state.compactCount >= MAX_COMPACT_RETRIES) {
            return { type: 'compaction_failure', summary: '上下文压缩失败次数过多' };
          }
        }
      }

      // 死循环检测
      const doomCheck = this.detectDoomLoop(state, executionLog);
      if (doomCheck.isDoom) {
        this._strategySwitchCount++;
        if (this._strategySwitchCount >= EnhancedAgentLoop.MAX_STRATEGY_SWITCHES) {
          yield this._emit('error', `⚠️ 已尝试 ${this._strategySwitchCount} 种策略均无法解决问题，终止执行。`);
          // 生命周期钩子：错误
          if (this._lifecycleHooks) {
            await this._lifecycleHooks.trigger(LifecycleEvent.ON_ERROR, {
              errorType: 'max_strategy_switches',
              strategyCount: this._strategySwitchCount,
            }).catch(() => {});
          }
          // B8: 喂养 source='new' 运行时指标（策略耗尽路径）
          const _strategyExhaustedReason = this._buildStrategyExhaustedReason(state);
          this._recordOutcomeToEvolutionMetrics(state, _strategyExhaustedReason, executionLog);
          return _strategyExhaustedReason;
        }

        const summary = `检测到死循环: ${doomCheck.reason}`;
        yield { type: 'error', content: `⚠️ ${summary}。正在尝试更换策略 (${this._strategySwitchCount}/${EnhancedAgentLoop.MAX_STRATEGY_SWITCHES})...` };

        // 获取替代工具建议（合并 smartToolSelector 和 ToolLearningSystem）
        const altToolsSmart = doomCheck.toolName ? this.smartToolSelector.suggestAlternatives(doomCheck.toolName) : [];
        const altToolsLearning = doomCheck.toolName ? this.toolLearning.getToolAlternatives(doomCheck.toolName) : [];
        const altTools = [...new Set([...altToolsSmart, ...altToolsLearning])];
        const altHint = altTools.length > 0 ? `\n建议使用替代工具: ${altTools.join(', ')}` : '';

        // 根据失败的工具类型生成针对性策略建议
        let specificStrategy = '';
        if (doomCheck.toolName.includes('browser')) {
          specificStrategy = `\n浏览器策略建议:
- 如果click失败 → 先用extract查看页面结构，确认选择器正确
- 如果evaluate失败 → 改用click/type/press等内置操作，不要直接操作DOM
- 如果选择器无效 → 用text=匹配或XPath，不要用CSS伪选择器
- 如果页面没加载完 → 先wait_for_change再操作
- 如果反复失败 → 改用screen_capture+screen_click桌面操控方式`;
        } else if (doomCheck.toolName.includes('screen_')) {
          specificStrategy = `\n桌面操控策略建议:
- 如果点击位置不对 → 先screen_capture截图确认位置
- 如果找不到元素 → 用screen_analyze视觉分析
- 如果应用没打开 → 先screen_open启动应用，等2秒再操作`;
        } else if (doomCheck.toolName.includes('file_')) {
          specificStrategy = `\n文件操作策略建议:
- 如果路径错误 → 先list_directory确认路径
- 如果权限不足 → 尝试其他目录或调整路径`;
        }

        let strategyPrompt = `警告：检测到死循环（${doomCheck.reason}）。请更换完全不同的策略。${altHint}${specificStrategy}`;
        if (this.strategyEngine) {
          strategyPrompt += `\n\n${this.strategyEngine.getStrategyPrompt({ error: 'tool_failure', toolName: doomCheck.toolName })}`;
          yield { type: 'think', content: `🔄 切换策略: ${this.strategyEngine.getCurrentStrategy().name}` };
        }

        // 触发能力缺口检测
        try {
          const gapResult = this.capabilityGapDetector.analyzeFailure(
            doomCheck.toolName, {}, doomCheck.reason,
            { userInput: input }
          );
          if (gapResult.gaps.length > 0) {
            const upgradeInstructions = gapResult.gaps.map(g => this.capabilityGapDetector.generateUpgradeInstruction(g)).join('\n\n');
            strategyPrompt += `\n\n${upgradeInstructions}`;
          }
        } catch {}

        // ===== 动态重规划触发：集成层次化任务规划器 =====
        // 当检测到死循环时，调用 HierarchicalTaskPlanner.recordFailureAndReplan
        // 连续失败达到阈值(3次)自动触发重规划，跳过阻塞步骤，保留失败上下文
        if (this._hierarchicalPlanner) {
          try {
            // 确保有活跃的层次化计划；若无则按当前输入创建一个轻量计划用于追踪
            if (!this._activeHierarchicalPlanId) {
              const hp = this._hierarchicalPlanner.createPlan(
                'doom-loop-recovery',
                input.substring(0, 200),
                [{ description: `恢复失败的操作: ${doomCheck.toolName || '未知工具'}` }],
              );
              this._activeHierarchicalPlanId = hp.id;
              this._currentFailedStepId = hp.steps[0]?.id || 1;
            }
            const replanResult: PlanReplanResult = this._hierarchicalPlanner.recordFailureAndReplan(
              this._activeHierarchicalPlanId,
              this._currentFailedStepId,
              `${doomCheck.reason}（工具: ${doomCheck.toolName || 'N/A'}）`,
              this._attemptedHealStrategies,
            );
            if (replanResult.replanned) {
              yield { type: 'think', content: `🔄 动态重规划触发: ${replanResult.reason}（第 ${replanResult.replanCount} 次重规划）` };
              strategyPrompt += `\n\n【动态重规划】${replanResult.reason}。已跳过阻塞步骤: ${replanResult.skippedStepIds.join(', ') || '无'}。失败上下文已保留，请基于历史失败调整策略，避免重复相同错误。`;
              // 将失败上下文摘要注入提示，供 LLM 学习
              const recentFailures = replanResult.failureContexts.slice(-3);
              if (recentFailures.length > 0) {
                const failureSummary = recentFailures.map(f => `  - 步骤${f.stepId}[L${f.level}]: ${f.reason}（重试${f.retryCount}次，策略: ${f.attemptedStrategies.join('|') || '无'}）`).join('\n');
                strategyPrompt += `\n\n【历史失败摘要】\n${failureSummary}\n请避免重复上述已失败的策略。`;
              }
            } else if (replanResult.skippedStepIds.length > 0) {
              // 重规划次数耗尽，已强制跳过阻塞步骤
              yield { type: 'think', content: `⚠️ 重规划次数耗尽，强制跳过阻塞步骤: ${replanResult.skippedStepIds.join(', ')}` };
              strategyPrompt += `\n\n【强制跳过】重规划次数已达上限，已跳过阻塞步骤 ${replanResult.skippedStepIds.join(', ')}。请继续执行后续步骤，跳过的步骤不再尝试。`;
            }
          } catch {}
        }

        state.messages.push({ role: 'system', content: strategyPrompt });
        state.toolCallHistory = [];

        if (this.learningSystem) {
          this.learningSystem.learnFromError(summary, input);
        }
        if (this.memoryOrchestrator) {
          this.memoryOrchestrator.store(`死循环检测: ${summary}`, {
            type: 'doom_loop',
            importance: 0.9,
          }).catch(err => logger.warn('死循环检测记忆存储失败', { error: err?.message }));
        }
      }

      // 收益递减检测：连续多轮没有推进计划步骤时主动退出
      // 每 MAX_DIMINISHING_RETURNS 轮检查一次，避免连续触发
      if (state.turnCount - this._lastDiminishingCheck >= EnhancedAgentLoop.MAX_DIMINISHING_RETURNS) {
        this._lastDiminishingCheck = state.turnCount;
        if (this._lastProgressTurn > 0 && state.turnCount - this._lastProgressTurn >= EnhancedAgentLoop.MAX_DIMINISHING_RETURNS) {
          this._diminishingReturns++;
          if (this._diminishingReturns >= 3) {
            yield { type: 'think', content: `⚠️ 连续多轮无进展，自动结束` };
            const lastMsg = state.messages.filter(m => m.role === 'assistant').pop();
            const partial = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
            return { type: 'completed', summary: await this.checkOutputGuardrail(partial || `执行 ${state.turnCount} 轮后完成。`) };
          }
        }
      }

      // 计划进度变更时才报告（避免刷屏）
      if (plan && state.turnCount % PLAN_REASSESS_INTERVAL === 0) {
        const completedSteps = plan.steps.filter(s => s.status === 'completed').length;
        if (completedSteps !== this._lastReportedProgress) {
          this._lastReportedProgress = completedSteps;
          yield {
            type: 'think',
            content: `📊 计划进度: ${completedSteps}/${plan.steps.length} 步骤完成`,
          };
        }
      }

      // Token 预检：发送前估算用量（复用 getCompactionUsage 的缓存，避免重复遍历）
      const preflightUsage = this.getCompactionUsage(state);
      const budget = this.config.tokenBudget || DEFAULT_TOKEN_BUDGET;
      const preflightTokens = Math.round(preflightUsage * budget);
      if (preflightTokens > budget * 0.95) {
        yield { type: 'warning', content: `⚠️ Token 预检: 当前消息约 ${preflightTokens} tokens (预算 ${budget})，接近上限，将强制压缩` };
        try {
          await this.compactMessages(state);
        } catch {
          // 压缩失败不终止流程
        }
      } else if (preflightTokens > budget * 0.8) {
        yield this._emit('compact', `📦 Token 预检: ${preflightTokens}/${budget} tokens，触发预防性压缩`);
        try {
          await this.compactMessages(state);
        } catch {
          // 压缩失败不终止流程
        }
      }

      // 消息格式校验：确保每个 assistant tool_calls 消息后所有 tool 消息都存在
      for (let i = 0; i < state.messages.length; i++) {
        const m = state.messages[i] as any;
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          // 收集后续连续的 tool 消息
          const existingToolIds = new Set<string>();
          let j = i + 1;
          while (j < state.messages.length && (state.messages[j] as any).role === 'tool') {
            existingToolIds.add((state.messages[j] as any).tool_call_id);
            j++;
          }
          // 检查所有 tool_call 是否有对应的 tool 消息
          const missingToolCalls = m.tool_calls.filter((tc: any) =>
            !existingToolIds.has(tc.id || tc.tool_call_id)
          );
          if (missingToolCalls.length > 0) {
            // 在位置 j 插入缺失的 tool 消息
            const insertMsgs = missingToolCalls.map((tc: any) => ({
              role: 'tool' as const,
              tool_call_id: tc.id || tc.tool_call_id,
              content: '已取消（消息修复）',
            }));
            state.messages.splice(j, 0, ...insertMsgs);
          }
        }
      }

      // LLM调用 (流式输出)
      try {
        const controller = new AbortController();
        // 分阶段超时：阶段1 首字节 12s（服务器不响应快速失败，原 45s 导致降级链累计 99s+）
        const firstByteTimeoutId = setTimeout(() => controller.abort(), 12000);
        // 阶段2 整体 90s（stream 消费上限，保护长响应不被误杀）— 首字节后激活
        let overallTimeoutId: NodeJS.Timeout | null = null;

        // 【关键优化】注入已执行操作摘要，避免LLM重复操作
        if (executionLog.length > 0 && state.turnCount > 1) {
          const recentActions = executionLog.slice(-10); // 最近10次操作
          const actionSummary = recentActions.map((e, i) =>
            `${i + 1}. ${e.tool} → ${e.success ? '✅' : '❌'} ${e.result.substring(0, 80)}`
          ).join('\n');
          // 只在最近没有注入过操作摘要时才注入
          const lastSystemMsg = state.messages.filter(m => m.role === 'system').pop();
          const lastSystemContent = typeof lastSystemMsg?.content === 'string' ? lastSystemMsg.content : '';
          if (!lastSystemContent.includes('【已执行操作】')) {
            state.messages.push({
              role: 'system' as const,
              content: `【已执行操作】以下是最近执行的操作，请不要重复执行相同的操作：\n${actionSummary}\n\n注意：已成功的操作不要重复执行，如果之前的操作已达到目的，请继续下一步。`
            });
          }
        }

        // 提前推断任务意图（供多个模块使用）
        const taskIntent = this.smartToolSelector.inferIntent(input);

        // 【新模块增强】注入学习引擎知识建议
        try {
          const knowledgeSummary = this.learningEngine.getKnowledgeSummary(taskIntent);
          if (knowledgeSummary) {
            state.messages.push({
              role: 'system' as const,
              content: `【知识库】以下是我已掌握的高成功率操作经验：\n${knowledgeSummary}`
            });
          }
        } catch {}

        // 【新模块增强】注入情感识别结果（调整回复风格）
        try {
          const emotionState = this.emotionSystem.recognizeEmotion(input);
          if (emotionState.primary !== 'neutral' && emotionState.intensity > 0.3) {
            const styleAdvice = this.emotionSystem.adaptStyle(emotionState, '');
            if (styleAdvice.toneNote) {
              state.messages.push({
                role: 'system' as const,
                content: `【情感感知】用户当前情绪: ${emotionState.primary}(强度${Math.round(emotionState.intensity * 100)}%)。回复风格建议: ${styleAdvice.toneNote}`
              });
            }
          }
        } catch {}

        // 【新模块增强】注入推理引擎分析（复杂任务，首轮触发）
        if (state.turnCount === 1 && input.length > 20) {
          try {
            const reasoningResult = await this.reasoningEngine.think(input, state.messages.map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).slice(-3));
            if (reasoningResult.confidence < 0.5 && reasoningResult.alternatives.length > 0) {
              state.messages.push({
                role: 'system' as const,
                content: `【推理分析】任务理解置信度较低(${Math.round(reasoningResult.confidence * 100)}%)，可能的理解: ${reasoningResult.alternatives.slice(0, 3).join(' / ')}。请优先确认用户意图。`
              });
            }
          } catch {}
        }

        // 智能工具选择：SmartToolSelector 是唯一选择点（消除双重选择）
        // P1-4 修复：之前 getOpenAITools(input) 内部先做一次 selectToolsForContext，
        // 然后 SmartToolSelector 再做一次，导致每轮两次全量扫描+评分+排序。
        // 现在不传 userMessage，getOpenAITools 直接返回所有启用工具，
        // 由 SmartToolSelector 做唯一的类别过滤+优先级排序。
        const allTools = this.toolRegistry.getOpenAITools(undefined, this.currentMaxTools);
        const planHints = plan?.steps
          .filter(s => s.status === 'pending' || s.status === 'in_progress')
          .map(s => s.toolHint || '')
          .filter(Boolean);
        // 将 OpenAI 格式转为 SmartToolSelector 的 ToolDefinition 格式
        const toolDefs = allTools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        }));
        // Phase D2: 走 LLM fallback 路径 — 高置信度走原 sync selectTools，
        // 低置信度或 mixed 时调 LLM 从工具 schema 选 3 个（含 5min 缓存）
        const llmCaller = async (prompt: string): Promise<string> => {
          if (!this.modelLibrary) return '';
          try {
            const resp = await this.modelLibrary.call(
              [{ role: 'user', content: prompt }],
              { maxTokens: 300, temperature: 0 },
            );
            return resp.content || '';
          } catch {
            return '';
          }
        };
        const selectedDefs = await this.smartToolSelector.selectToolsWithLLMFallback(
          input, toolDefs, {
            maxTools: this.currentMaxTools,
            includeFailed: false,
            planHints,
            recentContext: input,
            llmCaller,
          },
        );
        // 将选中的工具转回 OpenAI 格式
        const selectedTools = selectedDefs.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        // P0 视觉：若有图像输入，将最后一条 user message 转为多模态 ContentPart[] 格式（一次性）
        // 后续轮次 state.messages 已含多模态内容，无需重复转换；_runImages 置空避免重入。
        if (this._runImages) {
          const lastUserIdx = state.messages.map(m => m.role).lastIndexOf('user');
          if (lastUserIdx >= 0) {
            const textContent = typeof state.messages[lastUserIdx].content === 'string'
              ? (state.messages[lastUserIdx].content as string)
              : '';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (state.messages[lastUserIdx] as any).content = [
              { type: 'text', text: textContent },
              ...this._runImages.map(img => ({ type: 'image_url' as const, image_url: { url: img.url } })),
            ];
          }
          this._runImages = null;
        }
        let requestBase: OpenAI.ChatCompletionCreateParamsStreaming | OpenAI.ChatCompletionCreateParamsNonStreaming = {
          model: selectedModel,
          messages: state.messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          stream: true,
        };

        // 检测模型是否支持 function calling
        // 某些模型（如 ark-code-latest / doubao-coding）的流式 tool_calls 格式不标准
        // 对这些模型，使用非流式请求以获取完整的 tool_calls 响应
        const noFCStreamingModels = ['ark-code', 'doubao-coding', 'coding_plan'];
        const modelNeedsNonStreaming = noFCStreamingModels.some(m => selectedModel.toLowerCase().includes(m));

        if (selectedTools.length > 0 && !modelNeedsNonStreaming) {
          requestBase.tools = selectedTools;
          requestBase.tool_choice = 'auto';
        } else if (selectedTools.length > 0 && modelNeedsNonStreaming) {
          // 模型流式 tool_calls 不标准：使用非流式请求
          yield { type: 'think', content: `⚠️ 模型 ${selectedModel} 使用非流式模式调用工具` };
          requestBase = {
            model: selectedModel,
            messages: state.messages,
            temperature: 0.2,
            max_tokens: 16384,
            stream: false,
            tools: selectedTools,
            tool_choice: 'auto',
          };
          // 同时在系统提示中注入工具描述作为后备
          const toolDescriptions = selectedDefs.map(t =>
            `### ${t.name}\n${t.description}\n参数: ${JSON.stringify(t.parameters)}`
          ).join('\n\n');
          const toolSystemPrompt = `\n\n## 可用工具（请用以下格式调用）\n${toolDescriptions}\n\n## 工具调用格式\n当你需要调用工具时，请使用以下格式：\n\`\`\`tool_call\n{"name": "工具名", "arguments": {"参数名": "参数值"}}\n\`\`\`\n可以同时调用多个工具，每个工具调用一个代码块。调用完工具后等待结果，不要自行编造结果。`;
          const sysMsg = requestBase.messages.find(m => m.role === 'system');
          if (sysMsg && typeof sysMsg.content === 'string') {
            sysMsg.content += toolSystemPrompt;
          }
        }
        // CircuitBreaker 熔断检查：如果 LLM provider 处于熔断状态，直接降级
        if (this._circuitBreaker && this._circuitBreaker.getState() === 'open') {
          yield this._emit('warning', '⚠️ CircuitBreaker 熔断中，尝试降级模型...');
          // 降级到降级链中的下一个模型
          const chain: string[] = (this as any).degradationChain || [];
          const nextInChain = chain.find((m: string) => m !== selectedModel);
          if (nextInChain) {
            try {
              const nextClient = this.getClientForModel(nextInChain);
              if (nextClient) {
                selectedClient = nextClient.client;
                selectedModel = nextInChain;
              }
            } catch {}
          }
        }

        // 生命周期钩子：LLM 请求前（限流 / Token 预算 / 成本追踪）
        if (this._lifecycleHooks) {
          try {
            const llmReqResult = await this._lifecycleHooks.trigger(LifecycleEvent.ON_LLM_REQUEST, {
              model: selectedModel,
              messageCount: state.messages.length,
              estimatedTokens: state.tokensUsed,
              tools: selectedTools.map(t => t.function?.name).filter(Boolean),
            });
            if (!llmReqResult.allowed) {
              yield this._emit('warning', `⚠️ LLM 请求被钩子阻止: ${llmReqResult.blockedReason || '未知原因'}`);
              return { type: 'completed', summary: `请求被生命周期钩子阻止: ${llmReqResult.blockedReason || '策略限制'}` };
            }
          } catch {}
        }

        // P0-2: 通过 QueryEngine 统一 LLM 调用（重试/熔断/降级），未配置时降级为直接调用
        const response = this.config.queryEngine
          ? await this.config.queryEngine.createWithRecovery(selectedClient, requestBase, { signal: controller.signal }, selectedModel)
          : await selectedClient.chat.completions.create(requestBase, { signal: controller.signal });
        // 首字节到达（create 返回）：清除首字节超时，激活整体超时保护 stream 消费
        clearTimeout(firstByteTimeoutId);
        overallTimeoutId = setTimeout(() => controller.abort(), 90000);

        let currentContent = '';
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let role = 'assistant';
        let finishReason: string | null = null;

        if (modelNeedsNonStreaming && selectedTools.length > 0) {
          // 非流式响应：直接从完整响应中提取 tool_calls
          const nonStreamResponse = response as OpenAI.ChatCompletion;
          const choice = nonStreamResponse.choices?.[0];
          if (choice) {
            currentContent = choice.message?.content || '';
            if (currentContent) yield { type: 'text', content: currentContent };
            if (choice.message?.tool_calls) {
              toolCalls = choice.message.tool_calls.map((tc: any) => ({
                id: tc.id || '',
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              }));
            }
            finishReason = choice.finish_reason || null;
            role = choice.message?.role || 'assistant';
          }
        } else {
          // 流式响应：逐 chunk 解析
          for await (const chunk of response as AsyncIterable<any>) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (!delta && !choice) continue;

          // 处理文本内容 - 逐 chunk yield 实现流式输出
          if (delta?.content) {
            currentContent += delta.content;
            yield { type: 'text', content: delta.content };
          }

          // 处理工具调用
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              // 调试日志：记录原始 tool_call chunk（便于排查参数为空问题）
              if (!tc.function?.arguments && tc.function?.name) {
                console.warn(`[AgentLoop DEBUG] tool_call chunk: idx=${idx}, name=${tc.function.name}, id=${tc.id}, hasArgs=${!!tc.function?.arguments}, rawKeys=${Object.keys(tc).join(',')}, fnKeys=${tc.function ? Object.keys(tc.function).join(',') : 'N/A'}`);
              }
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) {
                // 流式响应中工具名可能分多个chunk发送
                // 策略：如果当前name为空，直接赋值；如果新name包含当前name作为前缀，说明是完整名，覆盖；否则拼接
                const currentName = toolCalls[idx].name;
                const newName = tc.function.name;
                if (!currentName) {
                  toolCalls[idx].name = newName;
                } else if (newName.startsWith(currentName) && newName.length > currentName.length) {
                  // 新name包含旧name作为前缀，是更完整的名称，覆盖
                  toolCalls[idx].name = newName;
                } else if (!currentName.includes(newName)) {
                  // 旧name不包含新name片段，拼接
                  toolCalls[idx].name += newName;
                }
                // 否则新name是旧name的子串，保留旧name不变
              }
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              // 兼容：某些 API（如 doubao-coding）可能将参数放在非标准字段
              // 检查 tc.function 下是否有 arguments 以外的参数字段
              if (!tc.function?.arguments && tc.function) {
                const fn = tc.function as any;
                // 尝试 parameters / params / args 等非标准字段名
                if (fn.parameters && typeof fn.parameters === 'string') {
                  toolCalls[idx].arguments += fn.parameters;
                } else if (fn.params && typeof fn.params === 'string') {
                  toolCalls[idx].arguments += fn.params;
                } else if (fn.args && typeof fn.args === 'string') {
                  toolCalls[idx].arguments += fn.args;
                } else if (fn.arguments === undefined && fn.name) {
                  // arguments 字段完全不存在但有 name：可能是参数在后续 chunk 中
                  // 也可能是该 API 在首个 chunk 只发 name，arguments 在后续 chunk
                  // 不做特殊处理，等后续 chunk
                }
              }
            }
          }

          if (delta?.role) role = delta.role;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
        } // end of else (streaming) block
        if (overallTimeoutId) clearTimeout(overallTimeoutId);

        // 生命周期钩子：LLM 响应后（Token 用量追踪 / 成本统计）
        if (this._lifecycleHooks) {
          try {
            await this._lifecycleHooks.trigger(LifecycleEvent.ON_LLM_RESPONSE, {
              model: selectedModel,
              contentLength: currentContent.length,
              toolCallCount: toolCalls.length,
              finishReason: finishReason || 'unknown',
            });
          } catch {}
        }

        // CircuitBreaker: 记录成功 — 通过公共 recordSuccess() 方法，
        // 确保滑动窗口、totalCalls、responseTimes、状态转换全部正确更新
        this._circuitBreaker?.recordSuccess();

        // 【关键修复】检测DSML空标签 — LLM（如DeepSeek）输出 <｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>
        // 空标签表示LLM想调用工具但格式不对，需要注入提示强制使用function_call
        // 限制重试次数，避免无限循环
        if (currentContent && toolCalls.length === 0) {
          const hasEmptyDSML = /<｜｜DSML｜｜tool_calls>\s*<\/｜｜DSML｜｜tool_calls>/.test(currentContent);
          if (hasEmptyDSML) {
            dsmlRetryCount++;
            if (dsmlRetryCount <= DSML_MAX_RETRY) {
              // 清除DSML标签避免显示
              currentContent = currentContent.replace(/<｜｜DSML｜｜tool_calls>\s*<\/｜｜DSML｜｜tool_calls>/g, '').trim();
              // 注入强制提示
              state.messages.push({
                role: 'system' as const,
                content: '【格式纠正】你刚才尝试用 <｜｜DSML｜｜tool_calls> 标签调用工具，但这不是有效的工具调用方式！你必须使用 function_call 机制来调用工具。请重新回复，使用正确的工具调用格式。如果你不知道怎么调用，请先调用 list_tools 查看可用工具列表。'
              });
              yield { type: 'think', content: `⚠️ 检测到DSML空标签（第${dsmlRetryCount}/${DSML_MAX_RETRY}次），已注入格式纠正提示` };
              // 直接continue，让LLM重新回复（msg还未构造，不需要设置）
              continue;
            } else {
              // 超过重试上限，跳过处理，让LLM自然输出
              yield { type: 'think', content: `⚠️ DSML空标签重试已达上限(${DSML_MAX_RETRY}次)，跳过处理让LLM自然输出` };
              currentContent = currentContent.replace(/<｜｜DSML｜｜tool_calls>\s*<\/｜｜DSML｜｜tool_calls>/g, '').trim();
              // 不再continue，让代码继续往下走
            }
          }
        }

        // 【关键修复】流式 tool_calls 参数为空时，尝试从文本内容中提取参数
        // 某些模型（如 doubao-coding/ark-code）的流式响应可能只返回 tool name 而不返回 arguments
        // 导致 toolCalls 有条目但 arguments 为空字符串
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            if (!tc.arguments || tc.arguments.trim() === '') {
              // 尝试从 currentContent 中提取该工具的参数
              const pseudoCalls = extractPseudoToolCalls(currentContent);
              const matched = pseudoCalls.find(pc => pc.name === tc.name);
              if (matched && Object.keys(matched.args).length > 0) {
                tc.arguments = JSON.stringify(matched.args);
                // 从文本中移除伪工具调用标签
                currentContent = currentContent.replace(matched.rawMatch, '').trim();
                yield { type: 'think', content: `🔧 从文本中提取了 ${tc.name} 的参数` };
              } else if (tc.name) {
                // 无法提取参数，记录警告并跳过此工具调用
                yield { type: 'warning', content: `⚠️ ${tc.name} 参数为空，跳过执行` };
                tc.arguments = '__SKIP__'; // 标记为跳过
              }
            }
          }
          // 过滤掉标记为跳过的工具调用
          toolCalls = toolCalls.filter(tc => tc.arguments !== '__SKIP__');
        }

        // 【关键修复】检测LLM文本中的伪工具调用（如 <shell_execute><command>xxx</command></shell_execute>）
        // 并将其转换为真实的 tool_calls
        if (currentContent && toolCalls.length === 0) {
          const pseudoCalls = extractPseudoToolCalls(currentContent);
          if (pseudoCalls.length > 0) {
            // 将伪工具调用转为真实 tool_calls
            toolCalls = pseudoCalls.map((pc, idx) => ({
              id: `pseudo_${idx}_${Date.now()}`,
              name: pc.name,
              arguments: JSON.stringify(pc.args),
            }));
            // 从文本中移除伪工具调用标签，避免重复显示
            let cleanedContent = currentContent;
            for (const pc of pseudoCalls) {
              cleanedContent = cleanedContent.replace(pc.rawMatch, '');
            }
            currentContent = cleanedContent.trim();
          }
        }

        // 构造等效的 response 对象供后续逻辑使用
        const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: role as 'assistant',
          content: currentContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })) : undefined,
        };

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // 如果 complete 已被调用过，立即终止，不再执行任何工具
          const hasNewComplete = msg.tool_calls.some(tc => (tc as any).function?.name === 'complete');
          if (hasNewComplete && this._hasCompleted) {
            yield { type: 'text', content: '任务已完成。' };
            this._finalizeThread(this._currentTurnId, true);
            return { type: 'completed', summary: '任务已完成' };
          }
          // 首次检测到 complete 调用：立即标记，跳过后续工具执行防止重复
          if (hasNewComplete && !this._hasCompleted) {
            this._hasCompleted = true;
            // 提取 complete 工具的 summary 参数作为最终摘要
            const completeCall = msg.tool_calls.find(tc => (tc as any).function?.name === 'complete');
            let finalSummary = '任务完成';
            try {
              const cArgs = JSON.parse(completeCall?.function?.arguments || '{}');
              finalSummary = (cArgs.summary || cArgs.result || '任务完成').substring(0, 1000);
            } catch {}
            state.messages.push(msg);
            // 仍然执行其他非 complete 工具（如果有），但跳过 complete 本身
            const nonCompleteCalls = msg.tool_calls.filter(tc => (tc as any).function?.name !== 'complete');
            if (nonCompleteCalls.length > 0) {
              try {
                const { events } = await this.executeToolCallsWithApproval(nonCompleteCalls, state, executionLog);
                for (const evt of events) yield evt;
              } catch {}
            }
            yield { type: 'text', content: finalSummary };
            // FSM: 任务完成
            this._fsm.transition(AgentStatus.COMPLETED);
            this._finalizeThread(this._currentTurnId, true);
            return { type: 'completed', summary: await this.checkOutputGuardrail(finalSummary) };
          }

          this._consecutiveTextOnly = 0;
          state.messages.push(msg);

          const { toolResults, events } = await this.executeToolCallsWithApproval(
            msg.tool_calls, state, executionLog,
          );

          for (const evt of events) {
            yield evt;
          }
          state.messages.push(...toolResults);

          // complete 工具调用检测：如果LLM调用了 complete，立即终止循环
          const completeResult = toolResults.find(r => {
            const c = typeof r.content === 'string' ? r.content : '';
            return c.includes('[TASK_COMPLETE]');
          });
          if (completeResult) {
            this._hasCompleted = true;
            const raw = typeof completeResult.content === 'string' ? completeResult.content : '';
            const finalSummary = raw.replace('[TASK_COMPLETE] ', '').replace('[TASK_COMPLETE]', '').trim() || '任务完成';
            yield { type: 'text', content: finalSummary };

            // 反思引擎：任务成功完成后触发 SOP 提取
            if (this.config.enableReflectionEngine !== false && this._executionPath.length > 0) {
              try {
                const taskPath = {
                  taskInput: input,
                  steps: this._executionPath,
                  finalOutcome: 'success' as const,
                  duration: Date.now() - state.startTime,
                };
                if (await this._reflectionEngine.shouldTriggerReflection(taskPath)) {
                  const sop = await this._reflectionEngine.extractSOP(taskPath);
                  if (sop) {
                    yield { type: 'think', content: `📚 反思引擎提取了新技能 SOP: ${sop.name}` };
                    // 同步 SOP 到虚拟文件系统
                    if (this._vfs) {
                      this._vfs.write(`viking://skills/${sop.name}/v${sop.version}`, JSON.stringify(sop), {
                        contentType: 'json',
                        tags: [sop.category, 'sop'],
                      });
                    }
                    // 桥接：将 SOP 同步注册到 SkillRegistry（统一技能系统）
                    try {
                      if (this._skillRegistry) {
                        this._skillRegistry.registerFromSOP(sop);
                      }
                    } catch {}
                  }
                }
              } catch {}
            }

            // 同步 Scratchpad 和 ReflectionEngine 到虚拟文件系统
            if (this._vfs) {
              try {
                this._vfs.syncFromScratchpad(this._scratchpad);
                this._vfs.syncFromReflectionEngine(this._reflectionEngine);
              } catch {}
            }

            // 经验包系统：任务完成后自动总结经验（不依赖 LLM，零 token）
            try {
              const expSystem = this.getExperiencePackSystem();
              const executionPathForExp = {
                task: input,
                steps: this._executionPath.map(s => ({
                  description: `工具 ${s.toolName}`,
                  tool: s.toolName,
                  toolParams: s.toolArgs,
                  result: s.result,
                  success: s.success,
                  durationMs: 0,
                })),
                finalResult: finalSummary,
                success: true,
                durationMs: Date.now() - state.startTime,
              };
              const pack = expSystem.autoExtractFromExecution(executionPathForExp);
              yield { type: 'think', content: `📦 经验包已提取: ${pack.name}（分类:${pack.category}, 步骤:${pack.steps.length}, 工具:${pack.toolsUsed.length}）` };
            } catch {}

            // 四级记忆：会话结束时整合
            if (this._memoryStore) {
              try {
                this._memoryStore.syncFromScratchpad(this._scratchpad);
                this._memoryStore.syncFromReflectionEngine(this._reflectionEngine);
                const consolidation = this._memoryStore.consolidate();
                if (consolidation.promoted > 0 || consolidation.expired > 0) {
                  yield this._emit('think', `🧠 记忆整合: 提升${consolidation.promoted}条, 过期${consolidation.expired}条, 压缩${consolidation.compressed}条`);
                }
              } catch {}
            }

            // 生命周期钩子：会话结束
            if (this._lifecycleHooks) {
              await this._lifecycleHooks.trigger(LifecycleEvent.ON_SESSION_END, {
                outcome: 'success',
                duration: Date.now() - state.startTime,
                toolCallCount: this._executionPath.length,
              }).catch(() => {});
            }

            // FSM: 任务完成
            this._fsm.transition(AgentStatus.COMPLETED);
            this._finalizeThread(this._currentTurnId, true);
            return { type: 'completed', summary: await this.checkOutputGuardrail(finalSummary) };
          }

          // 资源状态自动检测：从工具执行结果推断哪些应用已打开
          for (const tc of msg.tool_calls) {
            const toolResult = toolResults.find(r => r.tool_call_id === tc.id);
            if (toolResult) {
              const content = typeof toolResult.content === 'string' ? toolResult.content : '';
              const toolName = tc.function.name;
              if (toolName.includes('app_open') || toolName.includes('launch') || toolName.includes('browser_open')) {
                if (content.includes('✅') || content.includes('成功') || content.includes('opened') || content.includes('launched')) {
                  try {
                    const args = JSON.parse(tc.function.arguments);
                    const appName = args.app || args.appName || args.name || args.url || toolName;
                    this.resourceState.set(appName, true);
                  } catch {}
                }
              }
              if (toolName.includes('app_close') || toolName.includes('close') || toolName.includes('kill')) {
                try {
                  const args = JSON.parse(tc.function.arguments);
                  const appName = args.app || args.appName || args.name || toolName;
                  this.resourceState.set(appName, false);
                } catch {}
              }
            }
          }

          // Record tool calls to ToolLearningSystem
          try {
            const recentLogs = executionLog.slice(-msg.tool_calls.length);
            for (const log of recentLogs) {
              this.toolLearning.record({
                toolName: log.tool,
                args: '',
                result: log.result,
                success: log.success,
                goal: input,
                timestamp: Date.now(),
              });
            }
          } catch {}

          // Learn from consecutive failures
          if (this.consecutiveFailures.size > 0) {
            for (const [key, count] of this.consecutiveFailures) {
              if (count >= 2) {
                const lesson = `工具 ${key.split(':')[0]} 连续失败 ${count} 次，下次类似任务应换思路`;
                if (!this.lessonsLearned.includes(lesson)) {
                  this.lessonsLearned.push(lesson);
                  // 持久化到 SelfLearningSystem（跨会话保留）
                  try { this.learningSystem?.learnFromError(`工具连续失败: ${key}`, lesson); } catch (e) { console.warn(`[AgentLoop] learnFromError 持久化失败: ${(e as Error).message}`); }
                }
              }
            }
          }

          // Smart retry prevention: detect success/error from tool results
          let anyToolSucceeded = false;
          let anyToolFailed = false;
          for (const tc of msg.tool_calls) {
            const toolResult = toolResults.find(r => r.tool_call_id === tc.id);
            const resultContent = typeof toolResult?.content === 'string' ? toolResult.content : '';

            if (resultContent.startsWith('✅')) {
              anyToolSucceeded = true;
              this.completedTools.add(tc.function.name);
              // 工具成功执行就算有进展，即使没匹配到计划步骤
              this._lastProgressTurn = state.turnCount;
              this._diminishingReturns = 0;
              // 通知智能工具选择器：工具成功
              this.smartToolSelector.markSuccess(tc.function.name);
              // 强化学习闭环：同步权重到工具选择器
              this.smartToolSelector.injectToolWeights(this.toolLearning.getAllToolWeights());
              // 通知学习引擎：记录成功
              this.learningEngine.recordOutcome({
                taskDescription: input.substring(0, 200),
                domain: taskIntent,
                success: true,
                toolsUsed: [tc.function.name],
                duration: Date.now() - (state.startTime || Date.now()),
                timestamp: Date.now(),
              });
            } else if (resultContent.startsWith('❌')) {
              anyToolFailed = true;
              // 通知智能工具选择器：工具失败（连续失败3次后自动排除）
              this.smartToolSelector.markFailed(tc.function.name);
              // 强化学习闭环：同步权重到工具选择器
              this.smartToolSelector.injectToolWeights(this.toolLearning.getAllToolWeights());

              // V17 自动自我修复：检测常见错误模式并注入修复建议（增强版）
              const errorLower = resultContent.toLowerCase();
              let healHint = '';
              // ===== API/网络类错误 =====
              if (errorLower.includes('402') || errorLower.includes('insufficient balance') || errorLower.includes('余额不足')) {
                healHint = '【自动修复】API余额不足，请切换到其他provider或充值。可尝试使用Ollama免费模型。';
              } else if (errorLower.includes('401') || errorLower.includes('403') || errorLower.includes('api key') || errorLower.includes('unauthorized')) {
                healHint = '【自动修复】API Key无效或权限不足，请检查配置。可能需要重新配置API Key。';
              } else if (errorLower.includes('timeout') || errorLower.includes('超时') || errorLower.includes('etimedout')) {
                healHint = '【自动修复】请求/命令超时，建议：1)长命令(npm install/git clone)已自动延长超时 2)如仍超时尝试分步执行 3)检查网络连接 4)减少输入长度。';
              } else if (errorLower.includes('enoent') || errorLower.includes('no such file') || errorLower.includes('找不到')) {
                healHint = '【自动修复】文件/命令不存在，建议：1)先用 list_directory 确认路径 2)使用绝对路径 3)确认文件/命令已安装 4)检查工作目录。';
              } else if (errorLower.includes('econnrefused') || errorLower.includes('network') || errorLower.includes('econnreset')) {
                healHint = '【自动修复】网络连接失败，建议：1)检查网络 2)检查防火墙 3)确认服务是否运行 4)检查端口是否正确。';
              } else if (errorLower.includes('dead loop') || errorLower.includes('死循环')) {
                healHint = '【自动修复】检测到死循环，强制切换策略。建议换用完全不同的方法。';
              }
              // ===== 参数错误类 =====
              else if (errorLower.includes('缺少参数') || errorLower.includes('missing parameter') || errorLower.includes('missing required')) {
                // 程序化参数修复：检测常见参数名变体并提示
                try {
                  const passedArgs = JSON.parse(tc.function.arguments || '{}');
                  const argKeys = Object.keys(passedArgs);
                  if (tc.function.name === 'file_write' || tc.function.name === 'file_edit') {
                    const pathVariants = ['filepath', 'file_path', 'filename', 'file', 'pathname', 'filepath'];
                    const hasPathVariant = argKeys.some(k => pathVariants.includes(k.toLowerCase()));
                    if (hasPathVariant) {
                      healHint = `【自动修复】参数名不匹配。file_write/file_edit 的路径参数名为 path，但你传入了 ${argKeys.join(', ')}。系统已兼容 path/filePath/file_path/filename/file，但仍失败。请确认参数格式正确。`;
                    } else {
                      healHint = `【自动修复】缺少 path 参数。file_write 需要 {path: "文件路径", content: "内容"}。file_edit 需要 {path, old_text, new_text}。你传入的参数: ${argKeys.join(', ')}。`;
                    }
                  } else if (tc.function.name === 'shell_execute') {
                    healHint = `【自动修复】shell_execute 需要 {command: "命令字符串"} 参数。你传入的参数: ${argKeys.join(', ')}。`;
                  } else if (tc.function.name === 'search_files' || tc.function.name === 'grep_search') {
                    healHint = `【自动修复】缺少 pattern 参数。search_files/grep_search 需要 {pattern: "匹配模式"}。你传入的参数: ${argKeys.join(', ')}。`;
                  } else {
                    healHint = `【自动修复】缺少必需参数。工具 ${tc.function.name} 需要的参数请查看工具定义。你传入的参数: ${argKeys.join(', ')}。`;
                  }
                } catch {
                  healHint = '【自动修复】参数格式错误或缺少必需参数。请检查工具定义并确认参数名和类型正确。';
                }
              }
              // ===== Shell/命令类错误 =====
              else if (errorLower.includes('cmd.exe') || errorLower.includes('command failed')) {
                healHint = '【自动修复】Shell命令执行失败。系统已自动使用 PowerShell 并转换 Unix 命令。建议：1)使用 Unix 语法(mkdir -p/rm -rf)系统会自动转换 2)避免使用 && 连接多条命令，改用分步执行 3)检查命令语法。';
              } else if (errorLower.includes('powershell') && errorLower.includes('not recognized')) {
                healHint = '【自动修复】PowerShell 命令未识别。建议：1)使用标准 Unix 命令(系统会自动转换) 2)检查命令拼写 3)确认命令已安装。';
              } else if (errorLower.includes('permission denied') || errorLower.includes('权限') || errorLower.includes('eacces')) {
                healHint = '【自动修复】权限不足，建议：1)检查文件/目录权限 2)换用非敏感路径 3)避免访问系统目录。';
              } else if (errorLower.includes('file exists') || errorLower.includes('already exists') || errorLower.includes('已存在')) {
                healHint = '【自动修复】文件/目录已存在，建议：1)先删除已有文件 2)换用新名称 3)如果是目录则先确认内容再覆盖。';
              }
              // ===== 浏览器类错误 =====
              else if (errorLower.includes('syntaxerror') && errorLower.includes('evaluate')) {
                healHint = '【自动修复】浏览器选择器语法错误。selector参数应该是：1)CSS选择器(如"#login-btn") 2)文本内容(如"登录") 3)XPath(如"//button")。不要传入完整中文句子作为selector。如果不确定元素结构，先调用 browser_operate(action="extract") 查看页面内容，再选择正确的元素。';
              } else if (errorLower.includes('点击失败') || errorLower.includes('输入失败')) {
                healHint = '【自动修复】浏览器操作失败。建议：1)先调用 browser_operate(action="extract") 查看页面结构 2)使用文本内容作为selector(如"登录"而非CSS) 3)等待页面加载完成后再操作 4)检查元素是否在iframe中。';
              }
              // ===== 代码语法类错误 =====
              else if (errorLower.includes('syntaxerror') && (errorLower.includes('unexpected token') || errorLower.includes('unexpected identifier'))) {
                healHint = '【自动修复】代码语法错误。建议：1)检查括号/引号是否匹配 2)检查是否误用了中文标点 3)用 file_read 重新读取文件确认内容 4)运行 node --check 验证语法。';
              } else if (errorLower.includes('ts1005') || errorLower.includes('ts1003') || errorLower.includes('semicolon expected')) {
                healHint = '【自动修复】TypeScript 编译错误。建议：1)检查模板字符串中的反引号是否正确转义 2)检查语句结尾分号 3)用 file_read 读取错误行附近内容确认。';
              }
              if (healHint) {
                state.messages.push({ role: 'system', content: healHint });
              }
              // 通知学习引擎：记录失败
              this.learningEngine.recordOutcome({
                taskDescription: input.substring(0, 200),
                domain: taskIntent,
                success: false,
                toolsUsed: [tc.function.name],
                failureReason: resultContent.substring(0, 200),
                duration: Date.now() - (state.startTime || Date.now()),
                timestamp: Date.now(),
              });
              const failKey = `${tc.function.name}:${tc.function.arguments}`;
              const failCount = (this.consecutiveFailures.get(failKey) || 0) + 1;
              this.consecutiveFailures.set(failKey, failCount);

              if (failCount >= 2) {
                const alternatives = this.smartToolSelector.suggestAlternatives(tc.function.name);
                const learningAlts = this.toolLearning.getToolAlternatives(tc.function.name);
                const allAlts = [...new Set([...alternatives, ...learningAlts])];
                const altStr = allAlts.length > 0 ? `\n替代工具推荐: ${allAlts.join(', ')}` : '';
                // 生成正确用法示例
                const usageHint = getToolUsageHint(tc.function.name);
                const hint = `系统提示: 工具 ${tc.function.name} 已连续失败 ${failCount} 次，请换一种方法或使用其他工具完成此操作，不要再次调用相同工具。${altStr}${usageHint}`;
                state.messages.push({ role: 'system', content: hint });
                yield { type: 'think', content: `⚠️ ${tc.function.name} 连续失败 ${failCount} 次，建议换方法${altStr}` };
              }

              // 连续失败3次时触发能力缺口检测，自动建议升级或创建新工具
              if (failCount >= 3) {
                try {
                  const gapResult = this.capabilityGapDetector.analyzeFailure(
                    tc.function.name, JSON.parse(tc.function.arguments || '{}'), resultContent,
                    { userInput: input }
                  );
                  if (gapResult.gaps.length > 0) {
                    const upgradeInstructions = gapResult.gaps.map(g => this.capabilityGapDetector.generateUpgradeInstruction(g)).join('\n\n');
                    state.messages.push({ role: 'system', content: upgradeInstructions });
                    yield { type: 'think', content: `🔧 检测到能力缺口: ${gapResult.gaps.map(g => g.type).join(', ')}，已注入升级指令` };
                  }
                } catch {}
              }
            } else {
              const failKey = `${tc.function.name}:${tc.function.arguments}`;
              this.consecutiveFailures.delete(failKey);
            }
          }

          // 整体连续失败检测：如果所有工具连续失败达到上限，提示换方法但不强制放弃
          if (anyToolSucceeded) {
            this._totalConsecutiveToolFailures = 0;
          } else if (anyToolFailed) {
            this._totalConsecutiveToolFailures++;
            if (this._totalConsecutiveToolFailures >= EnhancedAgentLoop.MAX_CONSECUTIVE_TOOL_FAILURES) {
              yield { type: 'think', content: `⚠️ 工具连续失败 ${this._totalConsecutiveToolFailures} 次，建议换方法或换工具` };
              // 根据失败的工具类型给出针对性建议
              const recentFailures = [...this.consecutiveFailures.entries()]
                .filter(([, count]) => count >= 2)
                .map(([key]) => key.split(':')[0]);
              const failedBrowserOps = recentFailures.includes('browser_operate');
              let specificAdvice = '';
              if (failedBrowserOps) {
                specificAdvice = `\n\n浏览器操作失败的具体建议：
- click 失败 → 改用 extract 查看页面结构，找到正确的选择器后再点击
- evaluate 失败 → 不要用 evaluate 操作 DOM，改用 click/type/press 等内置操作
- 选择器错误 → 用 extract 获取页面内容，用文本内容作为选择器（如"登录"而非CSS选择器）
- 登录问题 → 如果需要登录，提示用户提供登录信息，不要反复尝试点击登录按钮`;
              }
              state.messages.push({
                role: 'system',
                content: `【系统提醒】工具已连续失败 ${this._totalConsecutiveToolFailures} 次。请尝试以下策略：\n1. 换一个不同的工具来完成同样的任务\n2. 调整工具参数重试\n3. 将任务分解为更小的步骤\n4. 如果当前方法行不通，换一种完全不同的思路${specificAdvice}\n\n不要放弃，继续尝试执行任务。`,
              });
              this._totalConsecutiveToolFailures = 0;  // 重置计数，给新一轮机会

              // 动态重规划：连续失败时自动调整剩余计划
              if (plan && this.planner) {
                try {
                  const failedTools = recentFailures.join(', ');
                  const replanHint = `工具 ${failedTools} 连续失败，需要调整剩余任务计划。考虑：1)跳过阻塞步骤 2)换用替代工具 3)分解为更小步骤`;
                  yield { type: 'think', content: `🔄 触发动态重规划: ${replanHint}` };

                  // 标记当前失败步骤为blocked，推进到下一步
                  const currentSteps = plan.steps.filter(s => s.status === 'in_progress');
                  for (const step of currentSteps) {
                    step.status = 'blocked' as any;
                    step.result = `工具连续失败，已跳过: ${failedTools}`;
                  }

                  // 找到下一个pending步骤并激活
                  const nextStep = plan.steps.find(s => s.status === 'pending');
                  if (nextStep) {
                    nextStep.status = 'in_progress';
                    yield { type: 'think', content: `📋 重规划：跳过阻塞步骤，推进到 "${nextStep.description}"` };
                    state.messages.push({
                      role: 'system',
                      content: `【动态重规划】已跳过失败步骤，当前任务: ${nextStep.description}\n所需工具: ${nextStep.toolHint || '自动选择'}\n请直接执行此步骤。`,
                    });
                  }
                } catch {}
              }
            }
          }

          if (plan) {
            let stepChanged = false;
            for (const tc of msg.tool_calls) {
              const toolName = tc.function.name;
              const logEntry = executionLog[executionLog.length - 1];
              const stepToolResult = toolResults.find(r => r.tool_call_id === tc.id);
              const resultContent = typeof stepToolResult?.content === 'string' ? stepToolResult.content : '';
              // 判断工具是否真正成功：结果以✅开头且不包含"失败"字样
              const isRealSuccess = logEntry?.success === true
                && (resultContent.startsWith('✅') || resultContent.startsWith('📸') || resultContent.startsWith('📄') || resultContent.startsWith('📌'))
                && !resultContent.includes('失败')
                && !resultContent.includes('错误')
                && !resultContent.includes('超时');

              // 策略1: 按 currentPlanStep 顺序匹配
              let matchingStep: PlanStep | undefined = plan.steps[currentPlanStep];
              if (matchingStep && matchingStep.status !== 'pending' && matchingStep.status !== 'in_progress') {
                matchingStep = plan.steps.find(s => s.status === 'pending' || s.status === 'in_progress');
              }

              // 策略2: 如果顺序匹配不上，按 toolHint 精确匹配
              if (!matchingStep || (matchingStep.status !== 'pending' && matchingStep.status !== 'in_progress')) {
                matchingStep = plan.steps.find(s => {
                  if (s.status !== 'pending' && s.status !== 'in_progress') return false;
                  // 只用 toolHint 精确匹配，不用模糊匹配（模糊匹配太宽松导致误标记）
                  return s.toolHint && toolName === s.toolHint;
                });
              }

              if (matchingStep && (matchingStep.status === 'pending' || matchingStep.status === 'in_progress')) {
                if (isRealSuccess) {
                  matchingStep.status = 'completed';
                  matchingStep.result = logEntry?.result?.substring(0, 200);
                  this._lastProgressTurn = state.turnCount;
                  this._diminishingReturns = 0;
                  this._lastDiminishingCheck = state.turnCount;
                  // 检查依赖此步骤的其他步骤是否可解锁
                  const _allSteps = plan.steps;
                  for (const otherStep of _allSteps) {
                    if (otherStep.status === 'pending' && otherStep.dependencies) {
                      const depStepIds = otherStep.dependencies;
                      const allDepsMet = depStepIds.every(depId => {
                        const dep = _allSteps.find(s => s.id === depId);
                        return dep && dep.status === 'completed';
                      });
                      if (allDepsMet) {
                        // 依赖满足，将步骤标记为 in_progress 并通知 LLM
                        otherStep.status = 'in_progress';
                        state.messages.push({
                          role: 'system' as const,
                          content: `步骤"${otherStep.description}"的依赖已全部完成，现在可以执行。`,
                        });
                      }
                    }
                  }
                } else {
                  matchingStep.status = 'failed';
                  matchingStep.result = `已跳过: ${logEntry?.result || '工具执行失败'}`;
                  state.messages.push({
                    role: 'system',
                    content: `步骤"${matchingStep.description}"因工具失败已跳过。请基于已有内容继续，不要为失败的步骤反复重试。如果已有足够内容就直接回复用户。`,
                  });
                }
                currentPlanStep = plan.steps.findIndex(s => s.status === 'pending');
                if (currentPlanStep === -1) currentPlanStep = plan.steps.length;
                stepChanged = true;
              }
            }

            // 步骤状态变更时，注入更新后的计划状态
            if (stepChanged) {
              state.messages.push({ role: 'system', content: getPlanStatusString(plan) });

              // 计划步骤全部完成 → 注入提示，但不强制终止
              // 让 LLM 自己决定是否要调用 complete 工具结束任务
              const allDone = plan.steps.length > 1 && plan.steps.every(s => s.status === 'completed' || s.status === 'skipped');
              const anyFailed = plan.steps.some(s => s.status === 'failed');
              if (allDone) {
                const summary = `计划步骤全部执行完毕${anyFailed ? `（${plan.steps.filter(s => s.status === 'failed').length} 步失败）` : ''}`;
                yield { type: 'think', content: summary };
                state.messages.push({
                  role: 'system' as const,
                  content: `计划步骤已全部处理。如果确认任务已完成，请调用 complete 工具提交结果并结束。如果还需要继续工作，请继续执行工具。`
                });
                plan = null;
                continue;
              }
            }
          }
        } else {
          const finalOutput = (typeof msg.content === 'string' ? msg.content : currentContent) || '任务完成';

          // 纯文字回复 = 有进展，重置收益递减计数器
          this._lastProgressTurn = state.turnCount;
          this._diminishingReturns = 0;
          this._lastDiminishingCheck = state.turnCount;

          // 修复：如果流式阶段没有输出任何文本，在这里补发
          if (!currentContent && finalOutput) {
            yield { type: 'text', content: finalOutput };
          }

          // 如果 finish_reason 是 'length'（token 上限截断），不应视为任务完成
          if (finishReason === 'length') {
            state.messages.push({
              role: 'system' as const,
              content: '上次回复被截断，请继续。'
            });
            continue;
          }

          // 【关键修复】LLM 纯文字回复但计划未完成 → 不退出，注入提示继续执行
          // 但对于 simple 复杂度的计划（如简单对话），LLM 返回纯文本是正确行为，直接完成
          // 如果 agent 已调用 complete 工具，跳过此检查（任务已声明完成）
          if (plan && plan.complexity !== 'simple' && !this._hasCompleted) {
            const pendingSteps = plan.steps.filter(s => s.status === 'pending' || s.status === 'in_progress');
            if (pendingSteps.length > 0) {
              this._consecutiveTextOnly++;
              this._totalTextWarnings++;

              // 总警告次数超过上限 → 放弃计划，让LLM自由回复（避免无限循环浪费轮次）
              if (this._totalTextWarnings > EnhancedAgentLoop.MAX_TOTAL_TEXT_WARNINGS) {
                yield { type: 'think', content: `⚠️ 多次尝试调用工具失败，改为直接回复` };
                plan = null;
                this._consecutiveTextOnly = 0;
                this._totalTextWarnings = 0;
              } else if (this._consecutiveTextOnly >= EnhancedAgentLoop.MAX_CONSECUTIVE_TEXT_ONLY) {
                // 达到连续上限：用最强力的提示强制工具调用
                yield { type: 'think', content: `⚠️ 连续 ${this._consecutiveTextOnly} 次未调用工具，强制要求立即执行` };
                const nextStep = pendingSteps[0];
                const toolHint = nextStep.toolHint || '';
                state.messages.push({
                  role: 'system' as const,
                  content: `【紧急指令】你已经连续 ${this._consecutiveTextOnly} 次只输出文字而没有调用任何工具！这是绝对不允许的。\n\n你必须立即使用工具调用(function_call)来执行下一步操作：${nextStep.description}\n${toolHint ? `建议使用的工具: ${toolHint}\n` : ''}\n关键规则：\n1. 不要在回复文本中写 <tool_name> 这样的伪标签，那不是真正的工具调用\n2. 你必须使用 function_call 机制调用工具，就像你之前成功调用过的那样\n3. 如果你不知道怎么调用，请先调用 list_tools 查看可用工具\n4. 立即行动，不要再思考或描述计划`
                });
                this._consecutiveTextOnly = 0; // 重置，给更多机会
                continue;
              } else {
                // 还有未完成的步骤，不能退出，必须继续执行
                const nextStep = pendingSteps[0];
                const toolHint = nextStep.toolHint || '';
                yield { type: 'think', content: `⚠️ 计划还有 ${pendingSteps.length} 步未执行，继续执行而非仅描述思路` };
                state.messages.push({
                  role: 'system' as const,
                  content: `【系统提醒】你刚才只输出了文字而没有调用工具，但计划还有 ${pendingSteps.length} 步未执行：\n${pendingSteps.map((s, i) => `  ${i + 1}. ${s.description} (状态: ${s.status})`).join('\n')}\n\n下一步: ${nextStep.description}\n${toolHint ? `建议工具: ${toolHint}\n` : ''}请立即调用相应工具执行下一步，不要只用文字描述你的思路。行动优先于思考。你必须使用 function_call 调用工具，不要在文本中写伪标签。`
                });
                continue;  // 继续循环，不退出
              }
            }
          }

          // 计划确实全部完成，或没有计划时，才允许纯文字回复退出
          if (plan) {
            const remainingSteps = plan.steps.filter(s => s.status === 'pending' || s.status === 'in_progress');
            if (remainingSteps.length > 0) {
              // 【关键修复】对于 simple 计划，LLM 的纯文字回复就是正确答案，直接完成
              // 避免"你能干什么"等简单问题导致无限循环（步骤永远 pending）
              if (plan.complexity === 'simple') {
                for (const s of remainingSteps) s.status = 'completed';
              } else {
                // 非 simple 计划：仍有未完成步骤，继续
                continue;
              }
            }
          }

          // Plan 确实完成了，才执行反思和 return
          if (this.config.enableReflection && this.reflector && plan && finalOutput) {
            try {
              const reflection = await this.reflector.reflect(
                input, plan, executionLog, finalOutput,
              );
              if (this.learningSystem && reflection.lessonsLearned.length > 0) {
                // P0-3 修复：闭合学习反馈闭环 — 根据反思质量分数推断 feedback
                // qualityScore >= 0.7 → positive（成功经验）
                // qualityScore < 0.4  → negative（失败教训）
                // 其他 → neutral
                const feedback: 'positive' | 'negative' | 'neutral' =
                  (reflection.qualityScore ?? 0.5) >= 0.7 ? 'positive' :
                  (reflection.qualityScore ?? 0.5) < 0.4 ? 'negative' : 'neutral';
                for (const lesson of reflection.lessonsLearned) {
                  this.learningSystem.learnFromInteraction(input, lesson, feedback);
                }
              }
              // 记忆持久化：存储经验教训到 MemoryOrchestrator
              if (this.memoryOrchestrator && reflection.lessonsLearned.length > 0) {
                for (const lesson of reflection.lessonsLearned) {
                  this.memoryOrchestrator.store(lesson, {
                    type: 'reflection',
                    importance: reflection.qualityScore || 0.7,
                  }).catch(() => {});
                }
              }
            } catch {}
          } else if (this.learningSystem) {
            // P0-3 修复：闭合学习反馈闭环 — 根据输出质量推断 feedback
            // 空输出或包含错误标记 → negative
            // 正常输出 → neutral（无反思时无法确认 positive）
            const outputStr = (finalOutput || '').trim();
            const hasError = outputStr.length === 0 ||
              /\b(error|失败|错误|failed|exception)\b/i.test(outputStr);
            const feedback: 'negative' | 'neutral' = hasError ? 'negative' : 'neutral';
            this.learningSystem.learnFromInteraction(input, finalOutput, feedback);
            // 记忆持久化：存储交互结果
            if (this.memoryOrchestrator) {
              this.memoryOrchestrator.store(`任务: ${input}\n结果: ${(finalOutput || '').substring(0, 200)}`, {
                type: 'interaction',
                importance: 0.6,
              }).catch(() => {});
            }
          }

          // 技能萃取：从成功的工具序列中自动提取可复用技能
          try {
            const successfulTools = executionLog
              .filter(e => e.success)
              .map(e => e.tool);
            if (successfulTools.length >= 2) {
              const toolSequence = successfulTools.join(' → ');
              // 存储到记忆中，下次类似任务可以快速复用
              if (this.memoryOrchestrator) {
                this.memoryOrchestrator.store(`任务"${input.substring(0, 50)}"的成功工具序列: ${toolSequence}`, {
                  type: 'skill',
                  importance: 0.8,
                  metadata: { toolSequence, taskIntent: this.smartToolSelector.inferIntent(input) },
                }).catch(() => {});
              }
            }
          } catch {}

          // ===== 输出护栏检查 =====
          this._finalizeThread(this._currentTurnId, true);
          // P2-2: 记录成功行为到 GEPA 引擎
          this._recordBehaviorToGEPA(input, executionLog, true, finalOutput);
          // P3-1: 记录任务结果到 Agent 身份网络
          this._recordOutcomeToIdentity(input, executionLog, true);
          // B8: 喂养 source='new' 运行时指标（成功完成路径）
          this._recordOutcomeToEvolutionMetrics(state, { type: 'completed', summary: finalOutput }, executionLog);
          return { type: 'completed', summary: await this.checkOutputGuardrail(finalOutput) };
        }
      } catch (err: unknown) {
        state.errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        const errorCategory = classifyError(err);

        // CircuitBreaker: 记录失败 — 通过公共 recordFailure() 方法，
        // 确保滑动窗口、totalFailures、failureCount、状态转换全部正确更新
        this._circuitBreaker?.recordFailure();

        const isTimeout = errorCategory === 'timeout';
        const errorMsg = isTimeout ? 'API请求超时(首字节12秒/整体90秒)，请检查网络或切换供应商' : msg;
        yield { type: 'error', content: `⚠️ API调用错误: ${errorMsg}` };

        // 主动记忆注入：错误恢复阶段注入历史相似错误的修复方案
        if (this.proactiveMemoryInjector) {
          try {
            const errorInjections = await this.proactiveMemoryInjector.inject({
              userInput: input,
              phase: 'error_recovery',
              recentError: errorMsg,
            });
            if (errorInjections.length > 0) {
              const errorBlock = this.proactiveMemoryInjector.formatForPrompt(errorInjections);
              state.messages.push({ role: 'system', content: errorBlock });
            }
          } catch {}
        }

        if (this.learningSystem) {
          this.learningSystem.learnFromError(errorMsg, input);
        }
        if (this.memoryOrchestrator) {
          this.memoryOrchestrator.store(`错误: ${errorMsg}\n任务: ${input.substring(0, 200)}`, {
            type: 'error',
            importance: 0.8,
          }).catch(err => logger.warn('错误记录记忆存储失败', { error: err?.message }));
        }

        // ===== 基于分类的恢复策略 =====

        // ===== 5大类错误分类 + 自愈管道集成 =====
        // 将详细错误分类映射到5大类（network/permission/syntax/resource/logic）
        // 并生成自愈修复提示注入上下文，引导 LLM 采用对应类别的修复策略
        const errorCategory5 = classifyError5Category(err, errorCategory);
        const selfHealHint = generateSelfHealingHint(errorCategory5, errorMsg);
        if (selfHealHint) {
          yield { type: 'think', content: `🛠️ ${selfHealHint}` };
          // 对标 Codex self-healing：将完整 stderr 作为新上下文注入，而非仅按类别生成 hint
          // 截断到 500 字符避免上下文膨胀，保留最关键的错误堆栈信息
          const stderrContext = errorMsg.length > 500
            ? errorMsg.substring(0, 250) + '\n...\n' + errorMsg.substring(errorMsg.length - 250)
            : errorMsg;
          state.messages.push({
            role: 'system',
            content: `${selfHealHint}\n错误详情（stderr）:\n${stderrContext}\n请基于上述错误信息分析根因并调整方案。`,
          });
        }

        // 调用自我修复引擎尝试自动修复（非LLM类错误：网络/权限/资源）
        // 仅对可自动修复的错误类型触发，避免对 auth_error 等不可恢复错误浪费策略
        if (this._selfHealEngine && errorCategory5 !== 'unknown' && errorCategory !== 'auth_error') {
          try {
            const healResult = await this._selfHealEngine.repairWithStrategies(
              errorCategory5 as EngineErrorCategory,
              errorMsg,
              { input, toolName: doomCheck?.toolName || '', turnCount: state.turnCount },
            );
            if (healResult.success) {
              yield { type: 'think', content: `✅ 自愈策略成功: ${healResult.strategyUsed}` };
              // 记录成功策略，供动态重规划参考
              if (!this._attemptedHealStrategies.includes(healResult.strategyUsed)) {
                this._attemptedHealStrategies.push(healResult.strategyUsed);
                // 保留最近20条策略记录，避免无限增长
                if (this._attemptedHealStrategies.length > 20) {
                  this._attemptedHealStrategies.shift();
                }
              }
            } else if (healResult.attemptedStrategies.length > 0) {
              // 所有自愈策略失败，记录尝试过的策略供动态重规划学习
              for (const s of healResult.attemptedStrategies) {
                if (!this._attemptedHealStrategies.includes(s)) {
                  this._attemptedHealStrategies.push(s);
                  if (this._attemptedHealStrategies.length > 20) {
                    this._attemptedHealStrategies.shift();
                  }
                }
              }
              yield { type: 'think', content: `⚠️ 自愈策略均失败（尝试 ${healResult.attemptedStrategies.length} 种），将升级到 LLM 层面修复` };
            }
          } catch {}
        }

        // auth_error 不重试，直接终止
        if (errorCategory === 'auth_error') {
          yield { type: 'error', content: '❌ API 认证失败，请检查 API Key 配置' };
          this._finalizeThread(this._currentTurnId, false);
          // P2-2: 记录失败行为到 GEPA 引擎
          this._recordBehaviorToGEPA(input, executionLog, false);
          // P3-1: 记录任务结果到 Agent 身份网络
          this._recordOutcomeToIdentity(input, executionLog, false);
          // B8: 喂养 source='new' 运行时指标（auth error 路径）
          const authReason: TerminalReason = { type: 'error', error: `API认证失败: ${errorMsg}`, recoverable: false };
          this._recordOutcomeToEvolutionMetrics(state, authReason, executionLog);
          return authReason;
        }

        // model_not_found: 模型不存在或不支持（如 Coding Plan 404），自动切换到下一个可用 provider
        if (errorCategory === 'model_not_found') {
          const currentProvider = process.env.DEFAULT_MODEL_PROVIDER || 'unknown';
          const currentModel = process.env.DEFAULT_MODEL || 'unknown';
          const isCodingPlan = this._currentBaseURL?.includes('/coding/');
          if (isCodingPlan) {
            yield { type: 'error', content: `❌ Coding Plan 模型不可用 (404) — 模型 "${currentModel}" 不支持 Coding Plan` };
            yield { type: 'think', content: `💡 可能原因：
  1. API Key 未开通 Coding Plan 套餐 — 请到 https://console.volcengine.com/ark/region:ark+cn-beijing/subscription 订阅
  2. 模型 "${currentModel}" 不在 Coding Plan 支持范围内
  3. 建议改用标准 API（/api/v3 端点）的 doubao 模型

  💡 正在自动切换到其他可用配置...` };
          } else {
            yield { type: 'warning', content: `⚠️ 模型 "${currentModel}" 不可用 (404)，已标记为不可用，自动切换...` };
          }
          this._exhaustedProviders.set(currentProvider.replace(/-\d+$/, ''), Date.now());

          // 清理过期的黑名单条目
          const now = Date.now();
          for (const [prov, ts] of this._exhaustedProviders) {
            if (now - ts > EnhancedAgentLoop.EXHAUSTED_PROVIDER_TTL) {
              this._exhaustedProviders.delete(prov);
            }
          }

          // 尝试切换到其他配置了 API Key 的 provider
          let switched = false;
          try {
            // 通过 UnifiedConfigManager 读取（自动解密 API Key，兼容 v1.x 数组和 v2.0 对象格式）
            const unified = UnifiedConfigManager.getInstance();
            const profilesMap = unified.getProfiles();
            const profiles = Object.values(profilesMap);
            const clientConfig = { timeout: 30000, maxRetries: 2 };
            const triedModels = new Set<string>();
            for (const p of profiles) {
              const np = (p.provider || '').replace(/-\d+$/, '');
              if (this._exhaustedProviders.has(np)) continue;
              const ak = p.apiKey || '';
              if (ak && ak.length > 8 && !ak.startsWith('your_')) {
                const client = this.createClientForProvider(p.provider, ak, p.baseUrl || '', clientConfig);
                if (client) {
                  const nm = this.normalizeModelName(p.model, p.baseUrl || '');
                  const key = `${np}/${nm}`;
                  if (triedModels.has(key)) continue;
                  triedModels.add(key);
                  selectedClient = client;
                  selectedModel = nm;
                  this._currentBaseURL = p.baseUrl || '';
                  process.env.DEFAULT_MODEL_PROVIDER = np;
                  process.env.DEFAULT_MODEL = nm;
                  yield { type: 'think', content: `🔄 已切换到 ${p.label || p.provider} (${nm})` };
                  switched = true;
                  break;
                }
              }
            }
          } catch {}

          if (switched) {
            // 切换成功，重试当前请求
            state.turnCount++;
            continue;
          }

          // 所有 provider 都不可用
          yield { type: 'error', content: '❌ 所有配置的模型均不可用，请检查配置（运行 duan setup 重新配置）' };
          return { type: 'error', error: `所有模型不可用: ${errorMsg}`, recoverable: false };
        }

        // insufficient_balance: 自动切换到下一个可用 provider
        if (errorCategory === 'insufficient_balance') {
          const currentProvider = process.env.DEFAULT_MODEL_PROVIDER || 'unknown';
          const currentModel = process.env.DEFAULT_MODEL || 'unknown';
          const isCodingPlan = this._currentBaseURL?.includes('/coding/');
          if (isCodingPlan) {
            const validModels = Array.from(EnhancedAgentLoop.CODING_PLAN_MODELS).join(', ');
            yield { type: 'error', content: `❌ 火山引擎 Coding Plan 调用失败 (402) — 余额不足` };
            yield { type: 'think', content: `💡 可能原因：
  1. Coding Plan 套餐额度已用尽 — 请到 https://console.volcengine.com/ark/region:ark+cn-beijing/subscription 充值
  2. 模型 "${currentModel}" 不在订阅范围内 — 当前支持: ${validModels}
  3. API Key 无效或过期 — 请检查 https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey

  💡 建议方案：
  • 到火山引擎控制台充值或升级套餐
  • 或在配置中选择其他 Provider（如 DeepSeek / OpenAI / 智谱 GLM）使用不同的 API Key` };
          } else {
            yield { type: 'warning', content: `⚠️ ${currentProvider} 余额不足(402)，已标记为不可用，自动切换...` };
          }
          this._exhaustedProviders.set(currentProvider.replace(/-\d+$/, ''), Date.now());

          // 清理过期的黑名单条目
          const now = Date.now();
          for (const [prov, ts] of this._exhaustedProviders) {
            if (now - ts > EnhancedAgentLoop.EXHAUSTED_PROVIDER_TTL) {
              this._exhaustedProviders.delete(prov);
            }
          }

          // 尝试切换到其他配置了 API Key 的 provider
          let switched = false;
          try {
            // 通过 UnifiedConfigManager 读取（自动解密 API Key，兼容 v1.x 数组和 v2.0 对象格式）
            const unified = UnifiedConfigManager.getInstance();
            const profilesMap = unified.getProfiles();
            const profiles = Object.values(profilesMap);
            const clientConfig = { timeout: 30000, maxRetries: 2 };
            const triedModels = new Set<string>();
            for (const p of profiles) {
              const np = (p.provider || '').replace(/-\d+$/, '');
              if (this._exhaustedProviders.has(np)) continue;
              const ak = p.apiKey || '';
              if (ak && ak.length > 8 && !ak.startsWith('your_')) {
                const client = this.createClientForProvider(p.provider, ak, p.baseUrl || '', clientConfig);
                if (client) {
                  const nm = this.normalizeModelName(p.model, p.baseUrl || '');
                  const key = `${np}/${nm}`;
                  if (triedModels.has(key)) continue;
                  triedModels.add(key);
                  selectedClient = client;
                  selectedModel = nm;
                  this._currentBaseURL = p.baseUrl || '';
                  process.env.DEFAULT_MODEL_PROVIDER = np;
                  process.env.DEFAULT_MODEL = nm;
                  yield { type: 'think', content: `🔄 已切换到 ${p.label || p.provider} (${nm})` };
                  switched = true;
                  break;
                }
              }
            }
          } catch {}
          if (!switched) {
            yield { type: 'warning', content: '⚠️ 所有 provider 余额均不足或未配置 API Key，无法自动切换' };
            yield { type: 'think', content: '💡 请到配置中充值 Coding Plan 或添加其他 API Key（如 DeepSeek/OpenAI/智谱 GLM）' };
          }
        }

        // rate_limit: 等待后重试
        if (errorCategory === 'rate_limit') {
          yield { type: 'warning', content: '⚠️ 请求限速，等待后重试...' };
          await new Promise(r => setTimeout(r, 5000));
        }

        // timeout: 压缩上下文后重试
        if (errorCategory === 'timeout') {
          yield { type: 'warning', content: '⚠️ 请求超时，压缩上下文后重试...' };
          await this.compactMessages(state);
        }

        // network_error: 等待后重试
        if (errorCategory === 'network_error') {
          yield { type: 'warning', content: '⚠️ 网络错误，等待后重试...' };
          await new Promise(r => setTimeout(r, 3000));
        }

        // context_too_long: 压缩上下文 + 减少工具数量
        if (errorCategory === 'context_too_long') {
          const isToolFormatError = errorMsg.includes('tool_calls') || errorMsg.includes('tool messages');
          if (isToolFormatError) {
            yield { type: 'think', content: '🔄 工具调用格式错误，清理历史消息中残留的工具调用后重试' };
            state.messages = state.messages.filter((m: any) => {
              if (m.role === 'assistant' && m.tool_calls) return false;
              if (m.role === 'tool') return false;
              return true;
            });
          } else {
            yield { type: 'warning', content: '⚠️ 上下文过长，正在压缩...' };
            await this.compactMessages(state);
            const newMaxTools = Math.max(3, Math.floor(this.currentMaxTools / 2));
            if (newMaxTools < this.currentMaxTools) {
              yield { type: 'think', content: `📉 工具数量从 ${this.currentMaxTools} 减少到 ${newMaxTools}` };
              this.currentMaxTools = newMaxTools;
            }
          }
        }

        // ===== 模型降级链：model_error / rate_limit / timeout / insufficient_balance 时尝试降级模型 =====
        if (['model_error', 'rate_limit', 'timeout', 'insufficient_balance'].includes(errorCategory) && this.modelFallbackChain.length > 0) {
          let fallbackSucceeded = false;
          let finalFallbackOutput = '';
          const triedFallbackModels = new Set<string>();
          
          for (const fallbackModel of this.modelFallbackChain) {
            if (triedFallbackModels.has(fallbackModel)) continue;
            triedFallbackModels.add(fallbackModel);

            // 如果模型属于已耗尽的 provider，跳过
            if (errorCategory === 'insufficient_balance' && this._exhaustedProviders.size > 0) {
              const modelLower = fallbackModel.toLowerCase();
              let belongsToExhausted = false;
              for (const [ep] of this._exhaustedProviders) {
                const epLower = ep.toLowerCase();
                // doubao 和 doubao-coding 共享同一套 API 接口，任一耗尽都跳过所有 doubao/ark 模型
                if ((epLower.includes('doubao') || epLower === 'doubao-coding') && (modelLower.startsWith('doubao') || modelLower.startsWith('ark-code'))) {
                  belongsToExhausted = true;
                  break;
                }
                // 通用规则：模型名包含 provider 名核心部分
                if (modelLower.includes(epLower.replace(/[_-].*$/, ''))) {
                  belongsToExhausted = true;
                  break;
                }
              }
              if (belongsToExhausted) {
                yield { type: 'think', content: `🔍 跳过 ${fallbackModel}（属于已耗尽 provider）` };
                continue;
              }
            }

            try {
              yield { type: 'warning', content: `⚠️ 主模型失败(${errorCategory})，尝试降级到 ${fallbackModel}...` };
              const fallbackClientInfo = this.getClientForModel(fallbackModel);
              if (!fallbackClientInfo) continue;

              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 12000);
              const fallbackTools = this.toolRegistry.getOpenAITools(input, this.currentMaxTools);
              const fallbackRequestBase: OpenAI.ChatCompletionCreateParamsStreaming = {
                model: fallbackClientInfo.model,
                messages: state.messages,
                temperature: 0.2,
                max_tokens: maxTokens,
                stream: true,
              };
              if (fallbackTools.length > 0) {
                fallbackRequestBase.tools = fallbackTools;
                fallbackRequestBase.tool_choice = 'auto';
              }
              const fallbackStream = await fallbackClientInfo.client.chat.completions.create(fallbackRequestBase, { signal: controller.signal });
              clearTimeout(timeoutId);

              let fallbackContent = '';
              const fallbackToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
              let fallbackRole = 'assistant';

              for await (const chunk of fallbackStream) {
                const fbChoice = chunk.choices?.[0];
                const delta = fbChoice?.delta;
                if (!delta && !fbChoice) continue;
                if (delta?.content) {
                  fallbackContent += delta.content;
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!fallbackToolCalls[idx]) {
                      fallbackToolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
                    }
                    if (tc.id) fallbackToolCalls[idx].id = tc.id;
                    if (tc.function?.name) fallbackToolCalls[idx].name += tc.function.name;
                    if (tc.function?.arguments) fallbackToolCalls[idx].arguments += tc.function.arguments;
                  }
                }
                if (delta?.role) fallbackRole = delta.role;
              }

              // 降级模型调用成功，处理结果
              const fallbackMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
                role: fallbackRole as 'assistant',
                content: fallbackContent || null,
                tool_calls: fallbackToolCalls.length > 0 ? fallbackToolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                })) : undefined,
              };

              if (fallbackMsg.tool_calls && fallbackMsg.tool_calls.length > 0) {
                state.messages.push(fallbackMsg);
                const { toolResults, events } = await this.executeToolCallsWithApproval(
                  fallbackMsg.tool_calls, state, executionLog,
                );
                for (const evt of events) {
                  yield evt;
                }
                state.messages.push(...toolResults);

                try {
                  const recent = executionLog.slice(-fallbackMsg.tool_calls.length);
                  for (const log of recent) {
                    this.toolLearning.record({
                      toolName: log.tool, args: '', result: log.result,
                      success: log.success, goal: input, timestamp: Date.now(),
                    });
                  }
                } catch {}

                if (plan) {
                  for (const tc of fallbackMsg.tool_calls) {
                    const toolName = tc.function?.name;
                    const matchingStep = plan.steps.find(s =>
                      s.status === 'in_progress' && s.toolHint === toolName
                    ) || plan.steps.find(s =>
                      s.status === 'pending' && s.toolHint === toolName
                    );
                    if (matchingStep) {
                      const resultContent = toolResults.find(r => {
                        const c = typeof r.content === 'string' ? r.content : '';
                        return c.includes(tc.id || '');
                      });
                      const resultStr = resultContent ? (typeof resultContent.content === 'string' ? resultContent.content : '') : '';
                      matchingStep.status = resultStr.startsWith('✅') ? 'completed' : resultStr.startsWith('❌') ? 'failed' : 'completed';
                      this._lastProgressTurn = state.turnCount;
                      this._diminishingReturns = 0;
                    }
                  }
                }

                const fb = toolResults.find(r => {
                  const c = typeof r.content === 'string' ? r.content : '';
                  return c.includes('[TASK_COMPLETE]');
                });
                if (fb) {
                  const raw = typeof fb.content === 'string' ? fb.content : '';
                  const s = raw.replace('[TASK_COMPLETE] ', '').replace('[TASK_COMPLETE]', '').trim() || '任务完成';
                  return { type: 'completed', summary: await this.checkOutputGuardrail(s) };
                }
                
                selectedClient = fallbackClientInfo.client;
                selectedModel = fallbackModel;
                fallbackSucceeded = true;
                break;
              } else {
                finalFallbackOutput = (typeof fallbackMsg.content === 'string' ? fallbackMsg.content : fallbackContent) || '';
                selectedClient = fallbackClientInfo.client;
                selectedModel = fallbackModel;
                fallbackSucceeded = true;
                // 降级模型返回纯文本，直接输出，不再继续循环
                yield { type: 'text', content: finalFallbackOutput };
                return { type: 'completed', summary: await this.checkOutputGuardrail(finalFallbackOutput) };
              }
            } catch {
              continue;
            }
          }
          
          // 降级模型成功且有工具调用，继续循环执行工具
          if (fallbackSucceeded) {
            // 已在上方处理
          }

          if (!fallbackSucceeded && state.errorCount >= 3) {
            // 所有降级模型都失败，且错误次数过多，尝试无工具的纯文本请求兜底
            yield { type: 'think', content: '🔄 所有降级模型均失败，尝试无工具的纯文本请求兜底...' };
            try {
              // 尝试从配置中找一个可用的客户端
              const fallbackClientInfo = this.getClientForModel('deepseek-chat') 
                || this.getClientForModel('qwen-turbo') 
                || this.getClientForModel('glm-4-flash');
              if (!fallbackClientInfo) {
                yield { type: 'error', content: '❌ 没有可用的 API 客户端，请检查配置或运行 config 重新配置' };
                return { type: 'error', error: `连续 ${state.errorCount} 次错误且无可用降级客户端`, recoverable: false };
              }
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 12000);
              const fallbackStream = await fallbackClientInfo.client.chat.completions.create({
                model: fallbackClientInfo.model,
                messages: state.messages,
                temperature: 0.2,
                max_tokens: 1024,
                stream: true,
              }, { signal: controller.signal });
              clearTimeout(timeoutId);
              let fallbackContent = '';
              for await (const chunk of fallbackStream) {
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) {
                  fallbackContent += delta.content;
                  yield { type: 'text', content: delta.content };
                }
              }
              if (fallbackContent) {
                return { type: 'completed', summary: fallbackContent };
              }
            } catch {
              yield { type: 'error', content: '❌ 纯文本兜底也失败了，请检查 API Key 配置' };
            }
            return { type: 'error', error: `连续 ${state.errorCount} 次错误: ${errorMsg}`, recoverable: false };
          }

          // 降级成功则继续下一轮循环
          if (fallbackSucceeded) continue;
        }

        // ===== 非降级场景的连续失败兜底 =====
        if (state.errorCount >= 3) {
          yield { type: 'think', content: '🔄 API连续失败，尝试无工具的纯文本请求兜底...' };
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const fallbackStream = await selectedClient.chat.completions.create({
              model: selectedModel,
              messages: state.messages,
              temperature: 0.2,
              max_tokens: 1024,
              stream: true,
            }, { signal: controller.signal });
            clearTimeout(timeoutId);
            let fallbackContent = '';
            for await (const chunk of fallbackStream) {
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                fallbackContent += delta.content;
                yield { type: 'text', content: delta.content };
              }
            }
            if (fallbackContent) {
              return { type: 'completed', summary: await this.checkOutputGuardrail(fallbackContent) };
            }
          } catch {}
          return { type: 'error', error: `连续 ${state.errorCount} 次错误: ${errorMsg}`, recoverable: false };
        }

        // ===== 构造错误提示注入上下文 =====
        let errorPrompt = `上次API调用出错: ${errorMsg}。请重试或使用替代方案。`;

        if (errorCategory === 'timeout') {
          errorPrompt = `上次API调用超时，已压缩上下文。请用最简短的回复继续。`;
        } else if (errorCategory === 'context_too_long') {
          const isToolFormatError = errorMsg.includes('tool_calls') || errorMsg.includes('tool messages');
          if (isToolFormatError) {
            errorPrompt = `上次API调用因工具消息格式错误失败，已清理异常消息。请重新尝试。`;
          } else {
            errorPrompt = `API调用返回400错误，已自动压缩历史消息并减少工具数量。请用最简短的回复重试，避免复杂工具调用。`;
          }
        } else if (errorCategory === 'rate_limit') {
          errorPrompt = `上次API调用因频率限制失败，已等待5秒后重试。`;
        } else if (errorCategory === 'network_error') {
          errorPrompt = `上次API调用因网络错误失败，已等待3秒后重试。`;
        } else if (errorCategory === 'model_error') {
          errorPrompt = `上次API调用因模型服务错误失败，请重试或使用替代方案。`;
        }

        if (this.strategyEngine) {
          this._strategySwitchCount++;
          if (this._strategySwitchCount >= EnhancedAgentLoop.MAX_STRATEGY_SWITCHES) {
            yield { type: 'error', content: `⚠️ 已尝试 ${this._strategySwitchCount} 种策略均无法解决问题，终止执行。` };
            // B8: 喂养 source='new' 运行时指标（策略耗尽路径）
            const _strategyExhaustedReason = this._buildStrategyExhaustedReason(state);
            this._recordOutcomeToEvolutionMetrics(state, _strategyExhaustedReason, executionLog);
            return _strategyExhaustedReason;
          }
          errorPrompt += `\n\n${this.strategyEngine.getStrategyPrompt({ error: errorMsg })}`;
          yield { type: 'think', content: `🔄 切换策略: ${this.strategyEngine.getCurrentStrategy().name}` };
        }
        state.messages.push({ role: 'system', content: errorPrompt });
      }

      // 生命周期钩子：循环迭代完成（用于监控、指标收集）
      if (this._lifecycleHooks) {
        try {
          await this._lifecycleHooks.trigger(LifecycleEvent.ON_LOOP_COMPLETE, {
            turnCount: state.turnCount,
            tokensUsed: state.tokensUsed,
            toolCallCount: this._executionPath.length,
            errorCount: state.errorCount,
          });
        } catch {}
      }
    }
  }

  /**
   * 带审批的工具执行（集成缓存 + 智能并行依赖分析）
   */
  private async executeToolCallsWithApproval(
    toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
    state: AgentState,
    executionLog: Array<{ tool: string; result: string; success: boolean }>,
  ): Promise<{ toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[]; events: LoopEvent[] }> {
    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
    const events: LoopEvent[] = [];

    // 智能并行：基于依赖分析替代简单的 parallel/serial 分区
    const dependencies = this.analyzeToolCallDependencies(toolCalls);
    const groups = this.groupByDependencies(toolCalls, dependencies);

    for (const group of groups) {
      // 将同组工具按 riskLevel 和 executionPolicy 细分：
      // - safe + parallel 且无依赖 → 可并行执行
      // - 其余 → 串行执行（含审批）
      const parallelInGroup: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
      const serialInGroup: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

      for (const idx of group) {
        const tc = toolCalls[idx];
        const policy = this.toolRegistry.getExecutionPolicy(tc.function.name);
        const riskLevel = this.toolRegistry.getRiskLevel(tc.function.name);
        if (policy === 'parallel' && (riskLevel === 'safe' || riskLevel === 'moderate')) {
          parallelInGroup.push(tc);
        } else {
          serialInGroup.push(tc);
        }
      }

      // 并行执行安全工具（含缓存）
      if (parallelInGroup.length > 0) {
        for (const tc of parallelInGroup) {
          events.push({ type: 'tool_call', content: `🔧 并行执行: ${tc.function.name}`, toolName: tc.function.name, toolArgs: {} });
        }

        const parallelResults = await Promise.all(parallelInGroup.map(async (tc) => {
          const entry = this.toolRegistry.get(tc.function.name);
          let toolArgs: any = {};
          try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch {
            // 参数解析失败：尝试修复截断的 JSON
            console.warn(`[AgentLoop] 工具 ${tc.function.name} 参数解析失败, raw: ${(tc.function.arguments || '').substring(0, 200)}`);
            toolArgs = tryRepairJSON(tc.function.arguments || '');
            if (Object.keys(toolArgs).length === 0) {
              return { tc, result: `❌ 参数解析失败，请重试`, success: false };
            }
          }

          // 生命周期钩子：工具调用前（安全审计）
          if (this._lifecycleHooks) {
            try {
              const toolCallResult = await this._lifecycleHooks.trigger(LifecycleEvent.ON_TOOL_CALL, {
                toolName: tc.function.name,
                args: tc.function.arguments,
                riskLevel: 'safe',
                executionMode: 'parallel',
              });
              if (!toolCallResult.allowed) {
                const blockMsg = `工具 ${tc.function.name} 被安全钩子阻止: ${toolCallResult.blockedReason || '策略限制'}`;
                return { tc, result: blockMsg, success: false, blocked: true };
              }
            } catch {}
          }

          state.toolCallHistory.push({ name: tc.function.name, args: tc.function.arguments, timestamp: Date.now() });

          // 伦理审查：工具执行前对参数做规则化审查（失败安全 — 引擎未注入时放行）
          const ethicsResult = this._runEthicsReview(tc.function.name, toolArgs);
          if (ethicsResult && !ethicsResult.approved) {
            const blockMsg = `🛡️ 工具 ${tc.function.name} 被伦理审查拒绝: ${ethicsResult.reason}`;
            events.push({ type: 'tool_result', content: blockMsg.substring(0, 300), toolName: tc.function.name });
            return { tc, result: blockMsg, success: false, blocked: true };
          }

          if (!entry) {
            return { tc, result: `未知工具: ${tc.function.name}`, success: false };
          }

          // 缓存检查：只读工具命中缓存则直接返回
          const cached = this.getCachedToolResult(tc.function.name, toolArgs);
          if (cached !== null) {
            const safeCached = typeof cached === 'string' ? cached : JSON.stringify(cached ?? '');
            events.push({ type: 'tool_result', content: safeCached.substring(0, 300), toolName: tc.function.name });
            return { tc, result: safeCached, success: !safeCached.startsWith('❌'), fromCache: true };
          }

          // P0-3: 文件修改前自动创建 Checkpoint（对标 Claude Code 文件回滚）
          if (['file_write', 'file_edit', 'file_replace', 'write_file', 'edit_file'].includes((tc as any).function.name)) {
            const args = toolArgs as Record<string, unknown>;
            const cpPath = (args.path || args.filePath || args.filename || args.file_path || args.file) as string;
            if (cpPath) await createCheckpointBeforeModify([String(cpPath)], `parallel_${(tc as any).function.name}`);
          }

          const rawResult = await this.executeToolWithTimeout(tc.function.name, () => entry.definition.execute(toolArgs));
          const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
          // 写入缓存
          this.setCachedToolResult(tc.function.name, toolArgs, result);
          // 文件写入工具成功后失效相关读缓存
          if (!result.startsWith('❌') && ['file_write', 'file_edit', 'file_replace', 'file_delete', 'write_file', 'edit_file', 'delete_file', 'move_file'].includes(tc.function.name)) {
            const writtenPath = (toolArgs.path || toolArgs.filePath || toolArgs.filename || toolArgs.file_path || toolArgs.file) as string;
            if (writtenPath) this.invalidateCacheOnFileWrite(String(writtenPath));
          }
          events.push({ type: 'tool_result', content: result.substring(0, 300), toolName: tc.function.name });
          return { tc, result, success: !result.startsWith('❌') };
        }));

        for (const { tc, result, success } of parallelResults) {
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
          executionLog.push({ tool: tc.function.name, result, success });
          // P2-1: 记录隐式工具选择信号
          this._recordImplicitToolSignal(tc.function.name, success);
          // 生命周期钩子：工具执行后（结果审计）
          if (this._lifecycleHooks) {
            try {
              await this._lifecycleHooks.trigger(LifecycleEvent.ON_TOOL_RESULT, {
                toolName: tc.function.name,
                success,
                resultLength: result.length,
                resultPreview: result.substring(0, 200),
              });
            } catch {}
          }
        }
      }

      // 串行执行（含审批 + 缓存）
      for (const tc of serialInGroup) {
        const entry = this.toolRegistry.get(tc.function.name);
        let toolArgs: any = {};
        try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch {
          console.warn(`[AgentLoop] 工具 ${tc.function.name} 参数解析失败, raw: ${(tc.function.arguments || '').substring(0, 200)}`);
          toolArgs = tryRepairJSON(tc.function.arguments || '');
          if (Object.keys(toolArgs).length === 0) {
            events.push({ type: 'tool_result', content: `❌ ${tc.function.name} 参数解析失败，请重试`, toolName: tc.function.name });
            continue;
          }
        }

        const riskLevel = this.toolRegistry.getRiskLevel(tc.function.name);

        events.push({
          type: 'tool_call',
          content: `🔧 串行执行: ${tc.function.name} [风险: ${riskLevel}]`,
          toolName: tc.function.name,
          toolArgs,
        });

        // 生命周期钩子：工具调用前（安全审计 / 限流）
        // 桥接 LifecycleHookManager → ToolExecutionPipeline：钩子可修改参数，修改后的参数传递给管线
        if (this._lifecycleHooks) {
          try {
            const serialToolCallResult = await this._lifecycleHooks.trigger(LifecycleEvent.ON_TOOL_CALL, {
              toolName: tc.function.name,
              args: tc.function.arguments,
              riskLevel,
              executionMode: 'serial',
            });
            if (!serialToolCallResult.allowed) {
              const blockMsg = `工具 ${tc.function.name} 被安全钩子阻止: ${serialToolCallResult.blockedReason || '策略限制'}`;
              events.push({ type: 'error', content: `🚫 ${blockMsg}` });
              toolResults.push({ role: 'tool', tool_call_id: tc.id, content: blockMsg });
              executionLog.push({ tool: tc.function.name, result: blockMsg, success: false });
              continue;
            }
            // 桥接：如果钩子修改了参数，使用修改后的参数
            if (serialToolCallResult.modifiedData?.args && typeof serialToolCallResult.modifiedData.args === 'object') {
              toolArgs = serialToolCallResult.modifiedData.args;
              events.push({ type: 'think', content: `📝 生命周期钩子修改了 ${tc.function.name} 的参数` });
            }
          } catch {}
        }

        // ===== ApprovalGate检查 =====
        // 智能审批：仅 dangerous 需要用户确认，safe/moderate 自动通过
        if (this.config.enableApprovalGate && riskLevel === 'dangerous') {
          // FSM: THINKING → EXECUTING → WAITING_HUMAN（需要先经过EXECUTING）
          if (this._fsm.canTransition(AgentStatus.EXECUTING)) {
            this._fsm.transition(AgentStatus.EXECUTING);
          }
          if (this._fsm.canTransition(AgentStatus.WAITING_HUMAN)) {
            this._fsm.transition(AgentStatus.WAITING_HUMAN);
          }

          const approval = await this.approvalGate.checkApproval(
            tc.function.name,
            toolArgs,
            riskLevel,
            entry?.approvalMessage || `即将执行 ${tc.function.name}`,
          );

          if (!approval.approved) {
            // FSM: 回到 THINKING 状态
            this._fsm.transition(AgentStatus.THINKING);
            const rejectMsg = `操作被拒绝: ${tc.function.name}。原因: ${approval.reason || '需要用户确认'}`;
            events.push({ type: 'error', content: `🚫 ${rejectMsg}` });
            toolResults.push({ role: 'tool', tool_call_id: tc.id, content: rejectMsg });
            executionLog.push({ tool: tc.function.name, result: rejectMsg, success: false });
            continue;
          }

          // FSM: 审批通过，进入 EXECUTING
          this._fsm.transition(AgentStatus.EXECUTING);

          // 如果审批修改了参数
          if (approval.modified && approval.modifiedArgs) {
            toolArgs = approval.modifiedArgs;
            events.push({ type: 'think', content: `📝 审批修改了 ${tc.function.name} 的参数` });
          }
        } else {
          // FSM: 无需审批，直接进入 EXECUTING
          this._fsm.transition(AgentStatus.EXECUTING);
        }

        state.toolCallHistory.push({ name: tc.function.name, args: tc.function.arguments, timestamp: Date.now() });

        // 伦理审查：工具执行前对参数做规则化审查（失败安全 — 引擎未注入时放行）
        const ethicsResult = this._runEthicsReview(tc.function.name, toolArgs);
        if (ethicsResult && !ethicsResult.approved) {
          const blockMsg = `🛡️ 工具 ${tc.function.name} 被伦理审查拒绝: ${ethicsResult.reason}`;
          events.push({ type: 'tool_result', content: blockMsg.substring(0, 300), toolName: tc.function.name });
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: blockMsg });
          executionLog.push({ tool: tc.function.name, result: blockMsg, success: false });
          continue;
        }

        if (!entry) {
          const msg = `未知工具: ${tc.function.name}`;
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: msg });
          executionLog.push({ tool: tc.function.name, result: msg, success: false });
          continue;
        }

        // 缓存检查：只读工具命中缓存则直接返回
        const cached = this.getCachedToolResult(tc.function.name, toolArgs);
        if (cached !== null) {
          const safeCached = typeof cached === 'string' ? cached : JSON.stringify(cached ?? '');
          events.push({ type: 'tool_result', content: safeCached.substring(0, 300), toolName: tc.function.name });
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: safeCached });
          executionLog.push({ tool: tc.function.name, result: safeCached, success: true });
          continue;
        }

        // Shadow Git 检查点：写入操作前自动快照
        let checkpointLabel = '';
        if (this.config.shadowGit) {
          checkpointLabel = `[auto] ${tc.function.name}_${Date.now()}`;
          this.config.shadowGit.createCheckpoint(checkpointLabel);
        }

        // P0-3: 文件修改前创建 Checkpoint（对标 Claude Code 文件回滚）
        if (['file_write', 'file_edit', 'file_replace', 'file_delete', 'write_file', 'edit_file', 'delete_file', 'move_file'].includes((tc as any).function.name)) {
          const args = toolArgs as Record<string, unknown>;
          const cpPath = (args.path || args.filePath || args.filename || args.file_path || args.file) as string;
          if (cpPath) await createCheckpointBeforeModify([String(cpPath)], `serial_${(tc as any).function.name}`);
        }

        try {
          let result: string;
          // 统一工具执行管线：JSON Schema校验 + 路径防护 + 危险命令拦截
          if (this._toolPipeline && entry?.definition.parameters) {
            const pipelineResult = await this._toolPipeline.execute(
              tc.function.name,
              toolArgs,
              entry.definition.parameters,
              riskLevel as any,
              (args) => Promise.resolve(entry.definition.execute(args)),
            );
            result = pipelineResult.success ? String(pipelineResult.output) : `❌ ${pipelineResult.error}`;
            // 如果管线修改了参数，使用修改后的参数
            const modifyStage = pipelineResult.stages.find(s => s.details?.includes('修正'));
            if (modifyStage) {
              events.push({ type: 'think', content: `📝 工具管线自动修正了 ${tc.function.name} 的参数` });
            }
          } else {
            // P0-5 修复：直接执行路径也添加超时保护
            const rawResult = await this.executeToolWithTimeout(tc.function.name, () => entry.definition.execute(toolArgs));
            result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
          }
          // 写入缓存
          this.setCachedToolResult(tc.function.name, toolArgs, result);
          // 文件写入工具成功后失效相关读缓存
          if (!result.startsWith('❌') && ['file_write', 'file_edit', 'file_replace', 'file_delete', 'write_file', 'edit_file', 'delete_file', 'move_file'].includes(tc.function.name)) {
            const writtenPath = (toolArgs.path || toolArgs.filePath || toolArgs.filename || toolArgs.file_path || toolArgs.file) as string;
            if (writtenPath) this.invalidateCacheOnFileWrite(String(writtenPath));
          }
          events.push({ type: 'tool_result', content: result.substring(0, 300), toolName: tc.function.name });
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
          const success = !result.startsWith('❌');
          executionLog.push({ tool: tc.function.name, result, success });
          // V17 自动验证闭环：代码文件修改后自动运行语法检查
          if (success) {
            await this.verifyCodeAfterEdit(tc.function.name, toolArgs, result, state);
          }
          // P2-1: 记录隐式工具选择信号
          this._recordImplicitToolSignal(tc.function.name, success);
          // P1-5: 记录到 Thread/Turn/Item
          if (this._sessionPersistence && this._currentTurnId) {
            try {
              this._sessionPersistence.addItem(this._currentTurnId, {
                type: 'tool_call',
                content: result.substring(0, 500),
                metadata: { tool: tc.function.name, success },
              });
            } catch {}
          }
          // 记录到执行路径（供反思引擎使用）
          this._executionPath.push({ toolName: tc.function.name, toolArgs, result, success, timestamp: Date.now() });
          // 知识图谱反馈：从工具结果中提取实体/关系，丰富图谱用于后续推理
          if (this._knowledgeGraph && success && typeof this._knowledgeGraph.extractAndAddKnowledge === 'function') {
            try {
              // 限制结果长度，避免大输出污染图谱
              const snippet = result.substring(0, 1000);
              this._knowledgeGraph.extractAndAddKnowledge(snippet, `tool:${tc.function.name}`);
            } catch {}
          }
          // P3-2: 知识图谱记忆 — 从工具结果中提取实体/关系三元组
          if (this._kgMemory && success) {
            try {
              const snippet = result.substring(0, 1000);
              this._kgMemory.extractFromText?.(snippet, `tool:${tc.function.name}`);
            } catch {}
          }
          // 生命周期钩子：工具执行后（结果审计）
          if (this._lifecycleHooks) {
            try {
              await this._lifecycleHooks.trigger(LifecycleEvent.ON_TOOL_RESULT, {
                toolName: tc.function.name,
                success,
                resultLength: result.length,
                resultPreview: result.substring(0, 200),
              });
            } catch {}
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const errMsg = `工具 ${tc.function.name} 执行错误: ${msg}`;
          events.push({ type: 'error', content: `⚠️ ${errMsg}` });
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          executionLog.push({ tool: tc.function.name, result: errMsg, success: false });
          // 生命周期钩子：工具执行后（失败结果审计）
          if (this._lifecycleHooks) {
            try {
              await this._lifecycleHooks.trigger(LifecycleEvent.ON_TOOL_RESULT, {
                toolName: tc.function.name,
                success: false,
                resultLength: errMsg.length,
                resultPreview: errMsg.substring(0, 200),
                error: msg,
              });
            } catch {}
          }

          // 记录到 ToolLearningSystem
          try {
            const firstMsg = state.messages[0];
            const firstContent = typeof firstMsg?.content === 'string' ? firstMsg.content : '';
            this.toolLearning.record({
              toolName: tc.function.name,
              args: tc.function.arguments || '',
              result: errMsg,
              success: false,
              goal: firstContent,
              timestamp: Date.now(),
            });
          } catch {}

          // 自动回滚：工具执行失败时恢复 Shadow Git 检查点
          if (this.config.shadowGit && checkpointLabel) {
            try {
              await this.config.shadowGit.restoreCheckpoint(checkpointLabel);
              events.push({ type: 'think', content: `↩️ 已自动回滚到执行前的状态 (${checkpointLabel})` });
            } catch { /* 回滚失败则继续，不影响整体流程 */ }
          }
        }
      }
    }

    return { toolResults, events };
  }

  /**
   * 死循环检测
   */
  private detectDoomLoop(state: AgentState, executionLog: Array<{ tool: string; result: string; success: boolean }>): { isDoom: boolean; toolName: string; reason: string } {
    // 元工具不应计入死循环检测：complete/think/create_plan/update_plan_step/get_plan/list_plans
    const META_TOOLS = new Set(['complete', 'think', 'create_plan', 'update_plan_step', 'get_plan', 'list_plans', 'plan_update']);
    const filteredHistory = state.toolCallHistory.filter(tc => !META_TOOLS.has(tc.name));
    const recent = filteredHistory.slice(-DOOM_LOOP_THRESHOLD);
    if (recent.length < DOOM_LOOP_THRESHOLD) return { isDoom: false, toolName: '', reason: '' };

    // 检测1: 完全相同的工具+参数重复 → 无论成功失败都是死循环
    const first = recent[0];
    if (recent.every(tc => tc.name === first.name && tc.args === first.args)) {
      return { isDoom: true, toolName: first.name, reason: `重复调用 ${first.name} ${recent.length} 次` };
    }

    // 检测2: 同一工具反复调用但全部失败 → 才认定为死循环
    const toolFailedCounts = new Map<string, number>();
    for (const tc of recent) {
      const execs = executionLog.filter(e => e.tool === tc.name).slice(-DOOM_LOOP_THRESHOLD);
      const recentFailed = execs.filter(e => !e.success).length;
      if (recentFailed > 0) {
        toolFailedCounts.set(tc.name, (toolFailedCounts.get(tc.name) || 0) + 1);
      }
    }
    for (const [name, count] of toolFailedCounts) {
      if (count >= DOOM_LOOP_THRESHOLD) {
        return { isDoom: true, toolName: name, reason: `${name} 连续失败 ${count} 次` };
      }
    }

    // 检测3: 语义等价循环 — 两个工具交替出现且全部失败
    if (recent.length >= 4) {
      const toolNames = recent.map(tc => tc.name);
      const uniqueNames = [...new Set(toolNames)];
      if (uniqueNames.length === 2) {
        let alternating = true;
        for (let i = 2; i < toolNames.length; i++) {
          if (toolNames[i] !== toolNames[i - 2]) { alternating = false; break; }
        }
        if (alternating) {
          const allFailed = toolNames.every(n => {
            const execs = executionLog.filter(e => e.tool === n).slice(-DOOM_LOOP_THRESHOLD);
            return execs.length > 0 && execs.every(e => !e.success);
          });
          if (allFailed) {
            return { isDoom: true, toolName: uniqueNames[0], reason: `${uniqueNames[0]} 和 ${uniqueNames[1]} 交替失败` };
          }
        }
      }
    }

    // 检测4: 目标无进展 — 连续N轮工具调用但计划步骤没有推进
    if (this._lastProgressTurn > 0 && state.turnCount - this._lastProgressTurn >= DOOM_LOOP_THRESHOLD * 2) {
      return { isDoom: true, toolName: '', reason: `连续${DOOM_LOOP_THRESHOLD * 2}轮无计划进展` };
    }

    return { isDoom: false, toolName: '', reason: '' };
  }

  /**
   * P0-1: 计算上下文使用率（对标 Claude Code 三级阈值）
   * @returns 使用率 0-1
   */
  private getCompactionUsage(state: AgentState): number {
    // 缓存 token 估算：消息只追加不修改，同一 length+compactCount 下结果不变
    // 避免每轮 2-4 次调用 estimateMessageTokens 重复遍历所有字符（O(N×M)）
    const cacheKey = `${state.messages.length}:${state.compactCount}`;
    if (cacheKey !== this._cachedTokenEstimateKey) {
      this._cachedTokenEstimate = this.estimateMessageTokens(state.messages);
      this._cachedTokenEstimateKey = cacheKey;
    }
    const estimatedTokens = this._cachedTokenEstimate;
    const budget = state.tokenBudget || this.config.tokenBudget || DEFAULT_TOKEN_BUDGET;
    return budget > 0 ? estimatedTokens / budget : 0;
  }

  /**
   * P0-1: 上下文压缩判断 — 三级阈值（70% 自动压缩 / 90% 警告 / 98% 阻断）
   *
   * 对标 Claude Code 的三级阈值保护：
   * - 70% 使用率 → 自动触发 Compaction
   * - 90% 使用率 → 向用户显示警告（通过事件）
   * - 98% 使用率 → 阻止新请求（在主循环中检查）
   */
  private shouldCompact(state: AgentState): boolean {
    if (state.turnCount < 2) return false;
    if (state.compactCount >= MAX_COMPACT_RETRIES) return false;
    if (Date.now() - state.lastCompactTime < COMPACT_COOLDOWN_MS) return false;
    // P0-1: 熔断器开启时不触发自动压缩（避免连续失败雪崩）
    if (this._isCompactCircuitBreakerOpen()) return false;
    // P0-1: 使用 70% 阈值（对标 Claude Code）
    const usage = this.getCompactionUsage(state);
    return usage >= EnhancedAgentLoop.COMPACT_THRESHOLD;
  }

  /**
   * P0-1: 熔断器是否开启（连续失败 3 次后熔断，5 分钟后半开）
   */
  private _isCompactCircuitBreakerOpen(): boolean {
    if (!this._compactCircuitBreakerOpen) return false;
    // 检查是否应该自动恢复（半开状态）
    if (this._lastCompactFailureAt !== null) {
      const elapsed = Date.now() - this._lastCompactFailureAt;
      if (elapsed >= EnhancedAgentLoop.COMPACT_CIRCUIT_BREAKER_RESET_MS) {
        this._compactCircuitBreakerOpen = false;
        this._consecutiveCompactFailures = 0;
        return false;
      }
    }
    return true;
  }

  /**
   * P0-2: 获取 QueryEngine 统计信息 — 供监控/前端使用
   */
  getQueryEngineStats(): import('./query-engine.js').QueryEngineStats | null {
    return this.config.queryEngine ? this.config.queryEngine.getStats() : null;
  }

  /**
   * P1-5: 完成 Thread/Turn 并持久化 — 在主循环终止时调用
   */
  private _finalizeThread(turnId: string | null, success: boolean): void {
    if (!this._sessionPersistence || !turnId) return;
    try {
      this._sessionPersistence.completeTurn(turnId, success ? 'completed' : 'failed');
      this._sessionPersistence.persistThreads();
    } catch {}
  }

  /**
   * P1-1: 带缓存的记忆检索 — 避免相同查询重复走完整检索管线
   *
   * Phase C2 升级：缓存未命中时改走 recall() 统一门面（替代 search()），
   * 从 RecallResult 提取 latencyMs / hit 记录 source='new' 运行时指标：
   * - recall_latency (delta): 累加每次召回的延迟毫秒数；任务终止时 flushRuntimeDeltas 推入 50 样本滚动窗口
   * - memory_hit_rate (delta): 命中记 1 否则记 0；滚动平均 = 任务级命中率
   * 缓存命中时仍按 0 延迟 + 不计命中统计（避免重复计数污染）。
   *
   * 缓存策略：
   * - key: query 前 100 字符 + topK（相同查询直接命中）
   * - TTL: 60 秒（平衡新鲜度和性能）
   * - 容量: 50 条（LRU 淘汰最旧条目）
   */
  private async _searchMemoryWithCache(query: string, topK: number = 5): Promise<any[]> {
    if (!this.memoryOrchestrator) return [];
    const cacheKey = `${query.substring(0, 100)}|${topK}`;
    const now = Date.now();

    // 检查缓存
    const cached = this._memorySearchCache.get(cacheKey);
    if (cached && cached.expiry > now) {
      return cached.results;
    }

    // 缓存未命中 — 走 recall() 统一门面（Phase C1）
    try {
      const recallFn = this.memoryOrchestrator.recall?.bind(this.memoryOrchestrator);
      const useRecall = typeof recallFn === 'function';
      let results: any[];
      if (useRecall) {
        const rr = await recallFn(query, { topK });
        results = rr.entries;
        // Phase C2: 记录运行时召回指标（delta 模式 — 任务终止时统一 flush）
        const em = this._evolutionMetrics;
        if (em && typeof em.recordRuntimeValue === 'function') {
          em.recordRuntimeValue('recall_latency', rr.latencyMs ?? 0, 'delta');
          em.recordRuntimeValue('memory_hit_rate', rr.hit ? 1 : 0, 'delta');
        }
      } else {
        // 兼容回退：recall() 未注入时降级到 search()
        results = await this.memoryOrchestrator.search(query, { topK });
      }

      // 写入缓存（LRU 淘汰）
      if (this._memorySearchCache.size >= EnhancedAgentLoop.MEMORY_CACHE_MAX) {
        const oldestKey = this._memorySearchCache.keys().next().value;
        if (oldestKey) this._memorySearchCache.delete(oldestKey);
      }
      this._memorySearchCache.set(cacheKey, {
        results,
        expiry: now + EnhancedAgentLoop.MEMORY_CACHE_TTL_MS,
      });

      return results;
    } catch {
      return [];
    }
  }

  /**
   * P2-1: 记录隐式工具选择信号到用户偏好引擎
   *
   * 多维信号采集（对标行业 20 次/会话基线）：
   * 1. implicit_tool_choice / implicit_rejection — 工具选择/拒绝（key=toolName，按工具分别追踪）
   * 2. implicit_edit — 编辑类工具使用（write/edit/multiedit/str_replace）
   * 3. implicit_template_reuse — 同一工具重复使用（≥3 次/会话）
   */
  private _recordImplicitToolSignal(toolName: string, success: boolean): void {
    if (!this._userPreferenceEngine) return;
    try {
      // 维度 1: 工具选择/拒绝 — key 必须为 toolName 才能按工具分别追踪
      this._userPreferenceEngine.recordSignal('default', {
        type: success ? 'implicit_tool_choice' : 'implicit_rejection',
        category: 'tool_preference',
        key: toolName,
        value: success ? 'used' : 'rejected',
      });

      // 维度 2: 编辑行为信号 — 编辑类工具触发 implicit_edit
      const EDIT_TOOLS = /^(write|edit|multiedit|str_replace|replace|create_file|modify)/i;
      if (EDIT_TOOLS.test(toolName)) {
        this._userPreferenceEngine.recordSignal('default', {
          type: 'implicit_edit',
          category: 'work_habit',
          key: 'edit_tool',
          value: toolName,
        });
      }

      // 维度 3: 模板复用信号 — 同一工具累计使用 ≥3 次触发
      this._toolUsageCounter = this._toolUsageCounter || new Map<string, number>();
      const count = (this._toolUsageCounter.get(toolName) || 0) + 1;
      this._toolUsageCounter.set(toolName, count);
      if (count === 3) {
        this._userPreferenceEngine.recordSignal('default', {
          type: 'implicit_template_reuse',
          category: 'tool_preference',
          key: toolName,
          value: 'frequently_used',
        });
      }
    } catch {}
  }

  /**
   * P2-2: 推断 GEPA 任务类型 — 基于输入文本的简单分类
   *
   * 将用户输入映射到 GEPA 引擎中的 taskType，用于行为记录和技能沉淀。
   * 分类规则：关键词匹配 → 任务类型字符串
   */
  private _inferGEPATaskType(input: string): string {
    // 代码类
    if (/\b(code|代码|实现|函数|function|class|类|method|方法|bug|修复|fix|debug|调试|refactor|重构)\b/i.test(input)) {
      if (/debug|调试|bug|fix|修复/i.test(input)) return 'debugging';
      if (/refactor|重构/i.test(input)) return 'refactoring';
      if (/test|测试|unit test/i.test(input)) return 'testing';
      return 'coding';
    }
    // 文档类
    if (/\b(doc|文档|readme|注释|comment|说明)\b/i.test(input)) return 'documentation';
    // 架构设计类
    if (/\b(architect|架构|design|设计|pattern|模式|系统设计)\b/i.test(input)) return 'architecture';
    // 分析类
    if (/\b(analyze|分析|review|审查|评估|evaluate)\b/i.test(input)) return 'analysis';
    // 查询类
    if (/\b(search|搜索|查询|find|查找|grep)\b/i.test(input)) return 'search';
    // 默认：通用任务
    return 'general';
  }

  /**
   * P2-2: 记录行为到 GEPA 引擎 — 在 run() 终止时调用
   *
   * 将本次 agent 循环的执行过程（工具调用序列、结果、耗时）记录为 BehaviorRecord，
   * 供 GEPA 引擎后续进行效果评估和技能沉淀。
   */
  private _recordBehaviorToGEPA(
    input: string,
    executionLog: Array<{ tool: string; result: string; success: boolean }>,
    success: boolean,
    responseText?: string,
  ): void {
    if (!this._gepaEngine) return;
    try {
      const taskType = this._inferGEPATaskType(input);
      const successCount = executionLog.filter(e => e.success).length;
      const failCount = executionLog.length - successCount;
      // 效果评分：基于成功率 + 是否完全成功
      const successRate = executionLog.length > 0 ? successCount / executionLog.length : (success ? 1 : 0);
      const effectScore = success
        ? Math.min(1, 0.7 + successRate * 0.3)
        : Math.max(0.1, successRate * 0.5);

      // 构建工具调用序列（精简版，避免存储过大）
      const toolCalls = executionLog.slice(0, 50).map(e => ({
        tool: e.tool,
        args: {} as Record<string, unknown>,
        success: e.success,
      }));

      const result: 'success' | 'partial' | 'failure' =
        success && failCount === 0 ? 'success' :
        success && failCount > 0 ? 'partial' :
        'failure';

      this._gepaEngine.recordBehavior({
        taskType,
        taskDescription: input.substring(0, 200),
        promptUsed: this._gepaPromptUsedThisRun, // P2-2 修复：使用实际注入的 GEPA prompt
        toolCalls,
        result,
        effectScore,
        durationMs: Date.now() - this._runStartedAt,
      });

      // P2-2 修复：自动触发 evolvePrompt — 每积累 GEPA_AUTO_EVOLVE_THRESHOLD 条行为触发一次
      // 这让 GEPA 闭环真正运转：行为记录→效果评估→prompt 优化→下次使用更优 prompt
      this._maybeTriggerGEPAEvolution(taskType);

      // P2-3: 个性化引擎 — 从交互文本中学习技术术语/语言/兴趣（NLP 学习，补充 UserPreferenceEngine 的类型化信号）
      this._learnFromPersonalization(input, responseText);
    } catch {}
  }

  /**
   * P2-3: 个性化引擎文本学习 — 从用户输入和助手响应中提取技术术语/语言/兴趣
   * 补充 UserPreferenceEngine 的类型化信号采集（后者只记录工具选择/编辑行为，不做 NLP 提取）
   */
  private _learnFromPersonalization(input: string, responseText?: string): void {
    if (!this._personalizationEngine) return;
    try {
      const response = responseText || '';
      if (response.length === 0) return;
      this._personalizationEngine.learnFromInteraction('default', input, response);
    } catch {}
  }

  /**
   * P2-2: 检查并自动触发 GEPA prompt 进化
   *
   * 当某任务类型的行为记录数达到阈值时，异步触发 evolvePrompt，
   * 让 GEPA 引擎基于真实行为数据优化 prompt，形成自进化闭环。
   */
  private _maybeTriggerGEPAEvolution(taskType: string): void {
    if (!this._gepaEngine) return;
    try {
      // 查询当前行为记录数
      const effect = this._gepaEngine.evaluateBehaviorEffect?.(taskType);
      if (!effect || effect.totalBehaviors < EnhancedAgentLoop.GEPA_AUTO_EVOLVE_THRESHOLD) return;
      // 仅在达到阈值倍数时触发（避免每次行为都触发）
      if (effect.totalBehaviors % EnhancedAgentLoop.GEPA_AUTO_EVOLVE_THRESHOLD !== 0) return;

      // 异步触发，不阻塞主循环
      const basePrompt = this._gepaPromptUsedThisRun || `任务类型: ${taskType}`;
      this._gepaEngine.evolvePrompt(
        taskType,
        basePrompt,
        ['task_success_rate', 'tool_efficiency', 'error_recovery'],
        { maxIterations: 3, targetScore: 0.85 },
      ).then((result: any) => {
        if (result && result.bestPrompt && result.bestPrompt !== basePrompt) {
          logger.info('[GEPA] prompt 自动进化完成', {
            taskType,
            bestScore: result.bestScore,
            totalIterations: result.totalIterations,
          });
        }
      }).catch(() => {
        // 进化失败不影响主循环，下次再试
      });
    } catch {}
  }

  /**
   * P3-1: 将本次任务结果记录到 Agent 身份网络
   *
   * 根据执行成功率计算质量评分，更新 Agent 的声誉/信任评分和能力使用统计。
   * 在 run() 的3个终止点（success / auth_error / max_turns）调用。
   */
  private _recordOutcomeToIdentity(
    input: string,
    executionLog: Array<{ tool: string; result: string; success: boolean }>,
    success: boolean,
  ): void {
    if (!this._identityNetwork || !this._agentId) return;
    try {
      const successCount = executionLog.filter(e => e.success).length;
      const successRate = executionLog.length > 0 ? successCount / executionLog.length : (success ? 1 : 0);
      // 质量评分：成功时 70-100，失败时 10-40
      const quality = success
        ? Math.round(Math.min(100, 70 + successRate * 30))
        : Math.round(Math.max(10, successRate * 40));

      // 推断任务类型对应的能力名称
      const taskType = this._inferGEPATaskType(input);
      const capabilityName = taskType === 'general' ? 'coding' : taskType;

      this._identityNetwork.recordOutcome?.(this._agentId, {
        taskId: `run_${this._runStartedAt}`,
        success,
        quality,
        duration: Date.now() - this._runStartedAt,
        description: input.substring(0, 200),
        timestamp: Date.now(),
      });

      // 更新能力使用统计
      const identity = this._identityNetwork.getIdentity?.(this._agentId);
      if (identity) {
        const cap = identity.profile?.capabilities?.find((c: any) => c.name === capabilityName);
        if (cap) {
          cap.lastUsed = Date.now();
          cap.usageCount = (cap.usageCount ?? 0) + 1;
        }
      }
    } catch {}
  }

  /**
   * P1-2: 检测任务复杂度 — 决定是否自动触发 Extended Thinking
   *
   * 触发条件（满足任一）：
   * - 架构/设计/重构类关键词
   * - 调试/诊断/排查类关键词
   * - 多步骤/多需求（含 3+ 个子任务）
   * - 长输入（>500 字符）
   * - 复杂推理关键词（分析/评估/比较/优化/权衡）
   */
  private _detectTaskComplexity(input: string): {
    shouldTrigger: boolean;
    depth: ThinkingDepth;
    reason: string;
  } {
    // v20.0: 优先检测用户显式思考触发词（ultrathink/极限思考/深入思考等）
    const explicitLevel = detectExplicitThinkingLevel(input);
    if (explicitLevel) {
      return {
        shouldTrigger: true,
        depth: explicitLevel.level,
        reason: `用户显式触发「${explicitLevel.label}」`,
      };
    }

    const lowerInput = input.toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    // 架构/设计/重构类（权重高）— 多关键词叠加：1 hit=3, 2 hits=4, 3+ hits=5
    const archKeywords = ['架构', '设计', '重构', '实现', '方案', '计划', '规划', 'architect', 'design', 'refactor', 'implement'];
    const archHits = archKeywords.filter(k => lowerInput.includes(k));
    if (archHits.length > 0) {
      score += 2 + Math.min(archHits.length, 3);
      reasons.push(`架构/设计关键词: ${archHits.slice(0, 3).join(', ')}`);
    }

    // 调试/诊断类
    const debugKeywords = ['调试', '诊断', '排查', '为什么', '原因', 'bug', '错误', '失败', 'debug', 'diagnose', 'troubleshoot'];
    const debugHits = debugKeywords.filter(k => lowerInput.includes(k));
    if (debugHits.length > 0) {
      score += 2;
      reasons.push(`调试/诊断关键词: ${debugHits.slice(0, 3).join(', ')}`);
    }

    // 复杂推理类 — 多关键词叠加：1 hit=2, 2+ hits=3
    const reasoningKeywords = ['分析', '评估', '比较', '优化', '权衡', '对比', 'analyze', 'evaluate', 'compare', 'optimize'];
    const reasoningHits = reasoningKeywords.filter(k => lowerInput.includes(k));
    if (reasoningHits.length > 0) {
      score += 1 + Math.min(reasoningHits.length, 2);
      reasons.push(`复杂推理关键词: ${reasoningHits.slice(0, 3).join(', ')}`);
    }

    // 长输入
    if (input.length > 500) {
      score += 2;
      reasons.push(`长输入 (${input.length} 字符)`);
    }

    // 多步骤/多需求 — 直接计数"第X步"标记，避免 split 丢失前缀导致短字符串
    const stepMarkers = input.match(/第[一二三四五六七八九十\d]+[步个条]/g) || [];
    const sentences = input.split(/[。\n；;]/).filter(s => s.trim().length > 10);
    const multiStepCount = Math.max(stepMarkers.length, sentences.length >= 3 ? sentences.length : 0);
    if (multiStepCount >= 3) {
      score += 2;
      reasons.push(`多步骤 (${multiStepCount} 个子任务)`);
    }

    // 代码相关复杂任务
    const codeKeywords = ['函数', '类', '模块', '接口', 'api', 'function', 'class', 'module', 'interface'];
    const codeHits = codeKeywords.filter(k => lowerInput.includes(k));
    if (codeHits.length >= 2) {
      score += 1;
      reasons.push(`代码结构关键词: ${codeHits.slice(0, 3).join(', ')}`);
    }

    // 跨类别加分（多个维度同时出现，说明任务复杂）
    const categoriesHit = [archHits.length > 0, debugHits.length > 0, reasoningHits.length > 0, multiStepCount >= 3].filter(Boolean).length;
    if (categoriesHit >= 3) {
      score += 1;
      reasons.push(`跨类别复杂度 (${categoriesHit} 个维度)`);
    }

    const shouldTrigger = score >= 4;
    const depth: 'shallow' | 'medium' | 'deep' = score >= 7 ? 'deep' : score >= 5 ? 'medium' : 'shallow';

    return {
      shouldTrigger,
      depth,
      reason: reasons.join('; ') || `复杂度评分 ${score}`,
    };
  }

  /**
   * P1-2: 执行 Extended Thinking — 多步逻辑检查 + 边缘情况枚举
   * 转发到 extended-thinking-service.ts 的无状态函数
   */
  private _runExtendedThinking(problem: string, depth: ThinkingDepth): Promise<string> {
    return runExtendedThinking(this._buildExtendedThinkingContext(), problem, depth);
  }

  /**
   * Phase D1: 流式 Extended Thinking — 逐阶段 yield 思考事件
   *
   * 与 _runExtendedThinking 的关系：本方法是真正的流式入口（async generator），
   * _runExtendedThinking 保留为兼容包装（消费本流并 join 成字符串）。
   * 主循环在 Execute 前调用本方法，让前端可以看到推理步骤逐步展开。
   *
   * v20.0: 支持 L1-L4 四级思考预算
   */
  private async *_runExtendedThinkingStream(
    problem: string,
    depth: ThinkingDepth,
  ): AsyncGenerator<ThinkingPhaseEvent, void, void> {
    yield* runExtendedThinkingStream(this._buildExtendedThinkingContext(), problem, depth);
  }

  /** 问题分解 — 转发 */
  private _decomposeProblem(problem: string): string[] {
    return decomposeProblem(problem);
  }

  /** 约束识别 — 转发 */
  private _identifyConstraints(problem: string): string[] {
    return identifyConstraints(problem);
  }

  /** 方案生成 — 转发 */
  private _generateSolutions(problem: string, count: number): string[] {
    return generateSolutions(problem, count);
  }

  /** 边缘情况枚举 — 转发 */
  private _enumerateEdgeCases(problem: string): string[] {
    return enumerateEdgeCases(problem);
  }

  /** 构建 Extended Thinking 上下文（封装对实例状态的访问） */
  private _buildExtendedThinkingContext(): ExtendedThinkingContext {
    return {
      memoryOrchestrator: this.memoryOrchestrator,
      searchMemoryWithCache: (q: string, k: number) => this._searchMemoryWithCache(q, k),
    };
  }

  /**
   * P0-1: 获取上下文压缩状态（三级阈值 + 熔断器）— 供监控/前端使用
   */
  getCompactionStatus(state?: AgentState): {
    usage: number;
    level: 'normal' | 'warn' | 'block';
    circuitBreakerOpen: boolean;
    consecutiveFailures: number;
    compactCount: number;
    thresholds: { compact: number; warn: number; block: number };
  } {
    let usage = 0;
    if (state) {
      usage = this.getCompactionUsage(state);
    }
    let level: 'normal' | 'warn' | 'block' = 'normal';
    if (usage >= EnhancedAgentLoop.BLOCK_THRESHOLD) level = 'block';
    else if (usage >= EnhancedAgentLoop.WARN_THRESHOLD) level = 'warn';
    return {
      usage,
      level,
      circuitBreakerOpen: this._isCompactCircuitBreakerOpen(),
      consecutiveFailures: this._consecutiveCompactFailures,
      compactCount: state?.compactCount ?? 0,
      thresholds: {
        compact: EnhancedAgentLoop.COMPACT_THRESHOLD,
        warn: EnhancedAgentLoop.WARN_THRESHOLD,
        block: EnhancedAgentLoop.BLOCK_THRESHOLD,
      },
    };
  }

  /**
   * P0-1: 5 阶段渐进式上下文压缩 — 集成 CompactionSystem + 熔断器
   *
   * 压缩优先级：
   * 1. CompactionSystem（5 层管线，对标 Claude Code）— 若已配置
   * 2. CompressionPipeline（5 阶段渐进式）— 若已配置
   * 3. CompressionRouter（小模型摘要）— 降级
   * 4. 简单截断 — 最终降级
   *
   * 熔断器：连续失败 3 次后开启，5 分钟后半开
   */
  private async compactMessages(state: AgentState): Promise<void> {
    // P0-1: 熔断器检查 — 开启时直接抛出，由上层处理
    if (this._isCompactCircuitBreakerOpen()) {
      throw new Error('上下文压缩熔断器已开启（连续失败 3 次），5 分钟后自动恢复');
    }

    try {
      await this._doCompactMessages(state);
      // P0-1: 压缩成功 — 重置熔断器
      this._consecutiveCompactFailures = 0;
      this._compactCircuitBreakerOpen = false;
    } catch (err) {
      // P0-1: 压缩失败 — 更新熔断器状态
      this._consecutiveCompactFailures++;
      this._lastCompactFailureAt = Date.now();
      if (this._consecutiveCompactFailures >= EnhancedAgentLoop.MAX_CONSECUTIVE_COMPACT_FAILURES) {
        this._compactCircuitBreakerOpen = true;
        console.error(`[Compaction] 熔断器已开启 — 连续压缩失败 ${this._consecutiveCompactFailures} 次: ${(err as Error).message}`);
      }
      throw err;
    }
  }

  /**
   * 实际执行上下文压缩（内部方法）
   */
  private async _doCompactMessages(state: AgentState): Promise<void> {
    // 压缩前：先提取关键事实到 Scratchpad（防止压缩丢失关键信息）
    try {
      this._scratchpad.extractFromMessages(
        state.messages.map(m => ({ role: (m as any).role, content: typeof m.content === 'string' ? m.content : '' }))
      );
    } catch {}

    // 生命周期钩子：上下文压缩触发
    if (this._lifecycleHooks) {
      try {
        await this._lifecycleHooks.trigger(LifecycleEvent.ON_CONTEXT_COMPRESS, {
          messageCount: state.messages.length,
          tokensUsed: state.tokensUsed,
          compactCount: state.compactCount,
          trigger: 'budget_exceeded',
        });
      } catch {}
    }

    // P0-1: Tier 1 — CompactionSystem（5 层管线，对标 Claude Code）
    const compactionSystem = this.config.compactionSystem;
    if (compactionSystem) {
      try {
        // 喂入尚未喂入的消息（避免重复）
        const newMessages = state.messages.slice(this._compactionFedIndex);
        for (const msg of newMessages) {
          const role = (msg as any).role as CompactionMessage['role'];
          const content = typeof (msg as any).content === 'string'
            ? (msg as any).content
            : JSON.stringify((msg as any).content ?? '');
          compactionSystem.addMessage({
            id: `msg_${this._compactionFedIndex}_${Date.now()}`,
            role,
            content,
            timestamp: Date.now(),
          });
          this._compactionFedIndex++;
        }
        // 获取压缩后的上下文
        const tokenBudget = this.config.tokenBudget || DEFAULT_TOKEN_BUDGET;
        const result = await compactionSystem.getContext(tokenBudget);
        // 转换回 OpenAI 消息格式
        state.messages = result.messages.map(m => ({
          role: m.role,
          content: m.content,
        })) as any;
        state.compactCount++;
        state.lastCompactTime = Date.now();
        state.tokensUsed = result.tokensUsed;
        console.info(`[Compaction] CompactionSystem 压缩完成 ratio=${result.compressionRatio.toFixed(2)} tokens=${result.tokensUsed}/${result.tokenBudget}`);
        return;
      } catch (err) {
        console.warn(`[Compaction] CompactionSystem 压缩失败，降级到 CompressionPipeline: ${(err as Error).message}`);
        // 降级到下一层
      }
    }

    // Tier 2 — CompressionPipeline（5 阶段渐进式）
    const pipeline = this.config.compressionPipeline;
    if (pipeline) {
      const result = await pipeline.compress(state.messages, this.config.tokenBudget || DEFAULT_TOKEN_BUDGET, state.compactCount);
      state.messages = result.messages;
      state.compactCount++;
      state.lastCompactTime = Date.now();
      state.tokensUsed = result.stats.afterTokens;

      if (result.stats.stagesApplied.length > 0) {
        // 发射到事件用于日志显示
        (this as any).lastCompressionStats = result.stats;
      }

      // 压缩后：将 Scratchpad 事实重新注入（确保压缩不丢失关键事实）
      if (this._scratchpad.getAll().length > 0) {
        const factsContent = this._scratchpad.formatForPrompt(500);
        if (factsContent) {
          // 在系统消息后插入事实板
          const sysEnd = state.messages.findIndex(m => m.role !== 'system');
          state.messages.splice(sysEnd > 0 ? sysEnd : 0, 0, {
            role: 'system' as const,
            content: `## 📌 已确认的关键事实（压缩保留）\n${factsContent}`,
          });
        }
      }
      return;
    }

    // Tier 3 — 降级：使用小模型压缩路由器生成摘要
    if (this._compressionRouter) {
      try {
        const oldMessages = state.messages.filter(m => m.role !== 'system' && m.role !== 'tool');
        if (oldMessages.length > 6) {
          const historyText = oldMessages.slice(0, -6).map(m =>
            `[${(m as any).role}]: ${typeof m.content === 'string' ? m.content.substring(0, 500) : ''}`
          ).join('\n');
          const summary = await this._compressionRouter.compress('summarize',
            `请用2-3句话总结以下对话的关键信息、决策和待办事项：\n${historyText}`,
            { maxTokens: 300, temperature: 0.3 }
          );
          const systemMsgs = state.messages.filter(m => m.role === 'system');
          const recentMsgs = state.messages.slice(-6);
          state.messages = [
            ...systemMsgs,
            { role: 'system' as const, content: `[上下文压缩] ${summary}` },
            ...recentMsgs.filter(m => m.role !== 'system'),
          ];
          state.compactCount++;
          state.lastCompactTime = Date.now();
          return;
        }
      } catch {}
    }

    // Tier 4 — 最终降级：简单压缩 — 保留系统提示+最近消息，删除中间历史
    const systemMsgs = state.messages.filter(m => m.role === 'system');
    const recentMsgs = state.messages.slice(-10); // 保留最近10条消息
    const removedCount = state.messages.length - systemMsgs.length - Math.min(10, state.messages.length);

    state.messages = [
      ...systemMsgs,
      { role: 'system' as const, content: `[上下文压缩] 已省略 ${removedCount} 条历史消息，保留最近对话。请简洁总结之前的对话要点，保留关键信息和任务上下文。这是第 ${state.compactCount + 1} 次压缩。` },
      ...recentMsgs.filter(m => m.role !== 'system'), // 避免重复系统消息
    ];
    state.compactCount++;
    state.lastCompactTime = Date.now();
  }

  /**
   * 估算消息列表的 Token 数量（比 chars/4 更准确）
   */
  private estimateMessageTokens(messages: any[]): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4; // 基础消息开销 (role + metadata)
      const textContent = typeof msg.content === 'string' ? msg.content : '';
      let chineseChars = 0;
      let otherChars = 0;
      for (const ch of textContent) {
        if (ch.charCodeAt(0) > 0x4e00 && ch.charCodeAt(0) < 0x9fff) {
          chineseChars++;
        } else {
          otherChars++;
        }
      }
      tokens += Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
      if (msg.tool_calls) tokens += 10; // 工具调用额外开销
    }
    return tokens;
  }

  /**
   * 生成执行摘要
   */
  private async summarizeExecution(
    client: OpenAI,
    model: string,
    state: AgentState,
    executionLog: Array<{ tool: string; result: string; success: boolean }>,
  ): Promise<string> {
    const successCount = executionLog.filter(e => e.success).length;
    const failCount = executionLog.filter(e => !e.success).length;

    try {
      const summaryParams = {
        model,
        messages: [
          { role: 'system' as const, content: '请用1-2句话总结任务执行情况。' },
          { role: 'user' as const, content: `执行了 ${executionLog.length} 个工具调用（成功: ${successCount}, 失败: ${failCount}），共 ${state.turnCount} 轮迭代。请总结。` },
        ],
        max_tokens: 256,
      };
      // P0-2: 通过 QueryEngine 统一 LLM 调用（重试/熔断/降级）
      const response = this.config.queryEngine
        ? await this.config.queryEngine.createWithRecovery(client, summaryParams, {}, model)
        : await client.chat.completions.create(summaryParams);
      return response.choices?.[0]?.message?.content || `任务执行完毕，共 ${state.turnCount} 轮`;
    } catch {
      return `任务执行完毕，共 ${state.turnCount} 轮，${successCount} 次成功，${failCount} 次失败`;
    }
  }
}

