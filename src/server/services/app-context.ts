import type { KnowledgeBase } from './knowledge-base.js';
import type { CoreModules } from '../../core/bootstrap.js';
import type { ContextMemorySystem } from '../../core/context-memory.js';
import type { SmartPromptEngine } from '../../core/smart-prompt-engine.js';
import type { CodeQualityEngine } from '../../core/code-quality-engine.js';
import type { SuperReasoningEngine } from '../../core/super-reasoning-engine.js';
import type { FaultTolerantExecutor } from '../../core/fault-tolerant-executor.js';
import type { LRUCache } from '../../core/cache.js';
import type { DynamicWorkflowEngine } from '../../core/dynamic-workflow.js';
import type { VoiceSystem } from '../../core/voice-system.js';
import type { EnhancedAgentLoop } from '../../core/enhanced-agent-loop.js';
import type { CapabilityAssessor } from '../../core/capability-assessment/assessor.js';

export interface ReActStep {
  phase: 'think' | 'act' | 'observe';
  content: string;
  timestamp: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  expertise: string[];
  status: 'online' | 'offline';
}

export interface AppConfig {
  apiKeys: {
    anthropic?: string; openai?: string; deepseek?: string;
    gemini?: string; mistral?: string; xai?: string; cohere?: string;
    perplexity?: string; openrouter?: string; groq?: string;
    together?: string; fireworks?: string; siliconflow?: string;
    qwen?: string; zhipu?: string; doubao?: string; 'doubao-coding'?: string; ernie?: string;
    moonshot?: string; minimax?: string; agnes?: string;
    ollama?: string; custom?: string;
  };
  defaultModel: string;
  defaultProvider: string;
  settings: { autoSaveMemory: boolean; multiAgentMode: boolean; smartDetection: boolean; };
}

export { errMsg } from '../../core/utils.js';

export interface ServerContext {
  VERSION: string;
  appConfig: AppConfig;
  modelLibrary: CoreModules['modelLibrary'];
  conversations: Map<string, Conversation>;
  MAX_CONTEXT_MESSAGES: number;
  agents: AgentInfo[];
  taskPatterns: Record<string, RegExp[]>;
  taskToAgent: Record<string, string>;
  systemPrompt: string;
  CONFIG_PATH: string;
  ENV_PATH: string;
  DUAN_CONFIG_PATH: string;
  KNOWLEDGE_PATH: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseCache: LRUCache<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCachedResponse: (key: string) => any | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setCachedResponse: (key: string, data: any) => void;
  getOrCreateConversation: (id: string) => Conversation;
  detectTaskType: (message: string) => { taskType: string; agent: string };
  saveConfig: (config: AppConfig) => void;
  syncConfigToModelLibrary: (modelLib: CoreModules['modelLibrary'], config: AppConfig) => void;
  nluEngine: CoreModules['nluEngine'];
  promptOptimizer: CoreModules['promptOptimizer'];
  continuousLearning: CoreModules['continuousLearning'];
  performanceMetrics: CoreModules['performanceMetrics'];
  knowledgeGraph: CoreModules['knowledgeGraph'];
  systemDiagnostics: CoreModules['diagnostics'];
  autonomousCapabilities: CoreModules['autonomousCapabilities'];
  capabilityManager: CoreModules['capabilityManager'];
  collaborativeWorkspace: CoreModules['workspace'];
  videoEngine: CoreModules['videoEngine'];
  autonomousThinking: CoreModules['thinkingEngine'];
  cognitiveState: CoreModules['cognitiveState'];
  selfAwareness: CoreModules['selfAwareness'];
  valueSystem: CoreModules['valueSystem'];
  goalSystem: CoreModules['goalSystem'];
  subAgentOrchestrator: CoreModules['subAgentOrchestrator'];
  /** C1-POST: AgentTeamOrchestrator — 多 Agent 团队编排，供 SubAgent POST 端点使用 */
  agentTeamOrchestrator: CoreModules['agentTeamOrchestrator'];
  heartbeat: CoreModules['heartbeat'];
  selfEvolve: CoreModules['selfEvolve'];
  /** P0 自我改进真实化：SelfEvolutionEngine 实例，供 /api/evolution/trigger 手动触发 evolve() */
  selfEvolutionEngine: CoreModules['selfEvolutionEngine'];
  strategyEngine: CoreModules['strategyEngine'];
  skillExtractor: CoreModules['skillExtractor'];
  selfAssessment: CoreModules['selfAssessment'];
  taskPlanner: CoreModules['taskPlanner'];
  projectConfig: CoreModules['projectConfig'];
  selfLearningSystem: CoreModules['selfLearningSystem'];
  contextMemory: InstanceType<typeof ContextMemorySystem>;
  smartPrompt: SmartPromptEngine;
  codeQuality: CodeQualityEngine;
  superReasoning: SuperReasoningEngine;
  faultTolerant: FaultTolerantExecutor;
  dynamicWorkflowEngine: DynamicWorkflowEngine;
  learningEval: CoreModules['learningEval'];
  skillGen: CoreModules['skillGen'];
  userProfile: CoreModules['userProfile'];
  voiceSystem: VoiceSystem;
  lastSelfEvolveTime: number;
  kb: KnowledgeBase;
  /** I-1：setupAgentLoop() 返回的统一主循环实例 — USE_UNIFIED_LOOP=true 时由 chat-routes 消费 */
  loop?: EnhancedAgentLoop;
  /**
   * 统一能力评估器（10 维度 / 31 指标）。
   * 由 web-server.ts 构造单例并注入，与 CLI `npx tsx cli.ts assess` 共享同一份持久化文件。
   * 通过 capability-routes.ts 暴露 HTTP API，供前端 CapabilityDashboard 消费。
   */
  capabilityAssessor?: CapabilityAssessor;
}
