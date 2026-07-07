import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { ContextMemorySystem } from './core/context-memory.js';
import { DynamicWorkflowEngine } from './core/dynamic-workflow.js';
import { SuperReasoningEngine } from './core/super-reasoning-engine.js';
import { FaultTolerantExecutor } from './core/fault-tolerant-executor.js';
import { SmartPromptEngine } from './core/smart-prompt-engine.js';
import { CodeQualityEngine } from './core/code-quality-engine.js';
import { setupAgentLoop } from './core/bootstrap.js';
import { CapabilityAssessor } from './core/capability-assessment/assessor.js';
import { buildSuites } from './core/capability-assessment/build-suites.js';
import { loadRuntimeValues } from './core/capability-assessment/runtime-values.js';
import { duanPath } from './core/duan-paths.js';
import { tools, executeTool, setToolRegistry } from './server/services/tools.js';
import { setAppConfig } from './server/services/llm-clients.js';
import { KnowledgeBase } from './server/services/knowledge-base.js';
import { responseCache, getCachedResponse, setCachedResponse } from './server/services/response-cache.js';
import { CONFIG_PATH, ENV_PATH, DUAN_CONFIG_PATH, loadConfig, saveConfig, syncConfigToModelLibrary } from './server/services/config-persistence.js';
import { agents, taskPatterns, taskToAgent, detectTaskType } from './server/services/agent-config.js';
import { buildSystemPrompt } from './server/services/system-prompt.js';
import type { ServerContext, Conversation } from './server/services/app-context.js';
import { registerRoutes } from './server/routes/registry.js';
import { startServer } from './server/start-server.js';
import { setupMiddleware, setupErrorHandlers } from './server/middleware.js';
import { setupRemoteBridge } from './server/services/remote-bridge.js';
import { PairingManager } from './core/pairing-manager.js';
import { getMCPSecurityGuard } from './core/mcp-security.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const VERSION = 'v19.0';

setupMiddleware(app);

const appConfig = loadConfig();
setAppConfig(appConfig);

// ============================================================
// Conversation store (in-memory with optional persistence)
// ============================================================

const conversations = new Map<string, Conversation>();
const MAX_CONTEXT_MESSAGES = 50;

function getOrCreateConversation(id: string): Conversation {
  if (!conversations.has(id)) {
    conversations.set(id, {
      id,
      title: '新对话',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return conversations.get(id)!;
}

// ============================================================
// System prompt
// ============================================================

const systemPrompt = buildSystemPrompt(VERSION);

const KNOWLEDGE_PATH = path.join(__dirname, '../knowledge.json');

// ============================================================
// 核心智能模块初始化 — 使用 bootstrap.ts 统一初始化
// ============================================================
const { modules, registry, loop } = setupAgentLoop();
// 消灭孤岛 I-3：将 registry 注入 tools.ts，使 executeTool 走统一注册路径
// 详见 v19 方案 §4.2 I-3
setToolRegistry(registry);
// 消灭孤岛 I-1：将 loop 暴露给 ServerContext，使 USE_UNIFIED_LOOP=true 时 chat-routes 可消费统一主循环
// 详见 v19 方案 §4.1 I-1
const unifiedLoop = loop;

// 从 modules 提取常用引用
const {
  nluEngine, promptOptimizer, continuousLearning, performanceMetrics,
  knowledgeGraph, diagnostics: systemDiagnostics, autonomousCapabilities,
  capabilityManager, workspace: collaborativeWorkspace, videoEngine,
  thinkingEngine: autonomousThinking, cognitiveState, selfAwareness,
  valueSystem, goalSystem, subAgentOrchestrator, agentTeamOrchestrator, heartbeat,
  selfEvolve, selfEvolutionEngine, strategyEngine, skillExtractor, selfAssessment,
  taskPlanner, projectConfig, selfLearningSystem,
  learningEval, skillGen, userProfile
} = modules;
const modelLibrary = modules.modelLibrary;
const voiceSystem = modules.voiceSystem;

// bootstrap 未包含的模块，仍需单独初始化
const contextMemory = new ContextMemorySystem(path.join(__dirname, '../data'));
const smartPrompt = new SmartPromptEngine();
const codeQuality = new CodeQualityEngine();
const superReasoning = new SuperReasoningEngine();
const faultTolerant = new FaultTolerantExecutor();
const dynamicWorkflowEngine = new DynamicWorkflowEngine(
  (name: string, args: Record<string, unknown>) => executeTool(name, args),
  (agentName: string, task: string) => subAgentOrchestrator.spawnAgent({
    id: `wf_agent_${Date.now()}`,
    name: agentName,
    goal: task,
    context: [],
    priority: 0.5,
  }),
);

console.info('✅ 自主意识系统加载完成（认知/自我/价值/目标/心跳/子Agent/自进化/策略/技能/评估）');

// 同步模型库配置
syncConfigToModelLibrary(modelLibrary, appConfig);

// 启动心跳
heartbeat.start();

// 心跳报告回调：触发自进化等实际操作
let lastSelfEvolveTime = 0;
heartbeat.onReportCallback((report) => {
  void (() => {
    if (report.suggestions.length > 0 || report.actions.length > 0) {
      console.info(`[心跳 #${heartbeat.getBeatCount()}] ${report.summary}`);
    }
    // 每10分钟最多触发一次自进化
    if (report.type === 'proactive_think' && report.suggestions.length > 0 && Date.now() - lastSelfEvolveTime > 600000) {
      lastSelfEvolveTime = Date.now();
      console.info('[心跳] 触发自进化分析...');
      selfEvolve.runCycle().catch(err => {
        console.warn(`[心跳] 自进化分析失败: ${err?.message || err}`);
      });
    }
  })();
});

// 启动时加载持久化数据
contextMemory.load().catch((err: Error) => {
  console.info('⚠️ 上下文记忆加载失败，使用默认值:', err.message);
});
performanceMetrics.load().catch((err: Error) => {
  console.info('⚠️ 性能指标加载失败，使用默认值:', err.message);
});

// 知识库
const kb = new KnowledgeBase(KNOWLEDGE_PATH);
kb.load();

// ============================================================
// 统一能力评估器（10 维度 / 31 指标）
// 复用 bootstrap 的 evolutionMetrics / learningEval 单例，保证与 SelfEvolutionEngine 写入的数据一致
// 套件注册：7 个已实现（thinking/memory/self_repair/computer_ops/code/inference/cross_platform）
// runtime 埋点值：从 ~/.duan/capability-assessment/runtime-values.json 加载
// 持久化路径：~/.duan/capability-assessment/（与 CLI npx tsx cli.ts assess 共享）
// ============================================================
const capabilityAssessor = new CapabilityAssessor({
  sources: {
    evolutionMetrics: modules.evolutionMetrics,
    learningEval,
  },
  suites: buildSuites(),
  dataPath: duanPath('capability-assessment'),
});
// 注入 runtime 埋点值（source='new' 的指标）
const _runtimeValues = loadRuntimeValues();
for (const [id, val] of Object.entries(_runtimeValues)) {
  capabilityAssessor.recordRuntimeValue(id, val);
}
console.info(`✅ 能力评估器已就绪（${Object.keys(_runtimeValues).length} 个 runtime 埋点值已加载）`);

// Build context and register routes
const serverCtx: ServerContext = {
  VERSION,
  appConfig,
  modelLibrary,
  conversations,
  MAX_CONTEXT_MESSAGES,
  agents,
  taskPatterns,
  taskToAgent,
  systemPrompt,
  CONFIG_PATH,
  ENV_PATH,
  DUAN_CONFIG_PATH,
  KNOWLEDGE_PATH,
  responseCache,
  getCachedResponse,
  setCachedResponse,
  nluEngine,
  promptOptimizer,
  continuousLearning,
  performanceMetrics,
  knowledgeGraph,
  systemDiagnostics,
  autonomousCapabilities,
  capabilityManager,
  collaborativeWorkspace,
  videoEngine,
  autonomousThinking,
  cognitiveState,
  selfAwareness,
  valueSystem,
  goalSystem,
  subAgentOrchestrator,
  agentTeamOrchestrator,
  heartbeat,
  selfEvolve,
  selfEvolutionEngine,
  strategyEngine,
  skillExtractor,
  selfAssessment,
  taskPlanner,
  projectConfig,
  selfLearningSystem,
  contextMemory,
  smartPrompt,
  codeQuality,
  superReasoning,
  faultTolerant,
  dynamicWorkflowEngine,
  learningEval,
  skillGen,
  userProfile,
  voiceSystem,
  lastSelfEvolveTime,
  kb,
  getOrCreateConversation,
  detectTaskType,
  saveConfig,
  syncConfigToModelLibrary,
  loop: unifiedLoop,
  capabilityAssessor,
};
registerRoutes(app, serverCtx);
setupErrorHandlers(app);

// v15.2：启用 MCP 安全审批轮询模式（Web 服务器环境下 API 审批队列可用）
try {
  getMCPSecurityGuard().enablePollingMode();
  console.info('🛡️  MCP 安全审批轮询模式已启用（/api/mcp/security/pending）');
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn('⚠️  MCP 安全审批模式启用失败:', msg);
}

// 初始化远程交互桥接服务（移动端/微信/Telegram等）
let remoteBridgePort = 3001; // 默认端口，startServer 后会更新
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let remoteBridgeService: any = null;
try {
  remoteBridgeService = setupRemoteBridge(app, remoteBridgePort);
  console.info('🌉 远程交互桥接服务已初始化');
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn('⚠️ 远程交互桥接初始化失败:', msg);
}

export function start(initialPort?: number): Promise<void> {
  return startServer(app, { VERSION, agents, tools }, (port: number) => {
    void (async () => {
      remoteBridgePort = port;
      // 关键：同步更新 RemoteBridgeService 的 agentPort，否则端口被占用时所有通道消息处理都会失败
      if (remoteBridgeService && typeof remoteBridgeService.setAgentPort === 'function') {
        remoteBridgeService.setAgentPort(port);
      }
      // 关键修复：启动所有已配置的消息通道（飞书 WebSocket、Telegram 轮询等）
      // 之前只创建了 RemoteBridgeService 实例但从未调用 start()，导致飞书消息通道从未建立
      if (remoteBridgeService && typeof remoteBridgeService.start === 'function') {
        try {
          await remoteBridgeService.start();
          // 启动后显示网关状态和配对码
          displayGatewayStatus(remoteBridgeService);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('⚠️  消息通道启动失败:', msg);
        }
      }
    })();
  }, initialPort);
}

/**
 * 显示网关状态和配对码信息
 * 在消息通道启动后调用，让用户一目了然地看到通道状态和配对码
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function displayGatewayStatus(service: any): void {
  try {
    const statuses = service.getStatus();
    if (statuses.length === 0) return;

    console.info('\n🌉 消息通道网关状态:');
    console.info('─────────────────────────────────────');
    for (const s of statuses) {
      const statusIcon = s.running ? '✅' : '❌';
      const msgCount = s.messageCount > 0 ? ` (${s.messageCount} 条消息)` : '';
      console.info(`  ${statusIcon} ${s.channelId.padEnd(12)} ${msgCount}`);
      if (s.error) {
        console.info(`     错误: ${s.error}`);
      }
    }

    // 检查是否有配对模式的通道，如果有则显示配对码
    const pairing = PairingManager.getInstance();
    const pendingCodes = pairing.listPendingCodes();

    // 检查是否有配对模式的通道
    const hasPairingChannel = statuses.some(s => s.running);
    if (hasPairingChannel) {
      console.info('\n📋 配对信息:');
      if (pendingCodes.length > 0) {
        console.info('  当前可用配对码:');
        for (const c of pendingCodes) {
          const remaining = Math.floor((c.expiresAt - Date.now()) / 1000);
          const min = Math.floor(remaining / 60);
          const sec = remaining % 60;
          console.info(`    ${c.code}  (剩余 ${min}m ${sec}s)  ${c.note || ''}`);
        }
      } else {
        // 自动生成一个配对码
        const code = pairing.generateCode('启动时自动生成');
        console.info(`  已自动生成配对码: ${code} (5分钟内有效)`);
        console.info('  在飞书中发送此配对码即可完成配对');
      }
      console.info('  管理配对码: duan pairing generate / list / codes');
    }
    console.info('─────────────────────────────────────\n');
  } catch {
    // 静默失败，不影响主服务
  }
}

export default app;

if (process.argv[1]?.endsWith('web-server.js') || process.argv[1]?.endsWith('web-server.ts')) {
  start().catch(err => {
    console.error('❌ 服务启动失败:', err);
    process.exit(1);
  });
}
