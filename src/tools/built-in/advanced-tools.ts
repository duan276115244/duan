/**
 * 高级功能工具集 — advanced-tools.ts
 *
 * 将 P0-P3 阶段创建但尚未集成的孤立模块通过工具系统暴露给 Agent，
 * 使 Agent 能够通过工具调用方式使用这些高级功能。
 *
 * 集成的模块：
 * - P0: QueryEngine、CompactionSystem
 * - P2: UserPreferenceEngine、GEPAEvolutionEngine、SOPPipeline
 * - P3: AgentIdentityNetwork、KnowledgeGraphMemory、DistributedAgentCluster
 */

import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { QueryEngine } from '../../core/query-engine.js';
import { CompactionSystem } from '../../core/compaction-system.js';
import { UserPreferenceEngine } from '../../core/user-preference-engine.js';
import { GEPAEvolutionEngine } from '../../core/gepa-evolution.js';
import { SOPPipeline } from '../../core/sop-pipeline.js';
import { AgentIdentityNetwork } from '../../core/agent-identity.js';
import { KnowledgeGraphMemory } from '../../core/knowledge-graph-memory.js';
import { AgentClusterNode } from '../../core/distributed-agent-cluster.js';
import { MemoryOrchestrator } from '../../core/memory-orchestrator.js';
import { SessionPersistence } from '../../core/session-persistence.js';
import { VisualIntelligence } from '../../core/visual-intelligence.js';
import { VoiceSystem } from '../../core/voice-system.js';
import { CrossPlatformSandbox } from '../../core/cross-platform-sandbox.js';
import { VirtualMemoryWorkflow } from '../../core/virtual-memory-workflow.js';
import { ThreeAgentOrchestrator } from '../../core/three-agent-orchestrator.js';
import { DuanPersonaEngine } from '../../core/duan-persona-engine.js';
import { PerformanceMonitoringSystem } from '../../core/performance-monitoring-system.js';
import { ConsciousnessSystem } from '../../core/consciousness-system.js';
import { ReinforcementLearningSystem } from '../../core/reinforcement-learning.js';
import { MetaLearningSystem } from '../../core/meta-learning.js';
import { SelfRepairSystem } from '../../core/self-repair.js';
import { WorldModel } from '../../core/world-model.js';
import { VulnerabilityDetectionSystem } from '../../core/vulnerability-scanner.js';
import { CodeQualityAnalyzer } from '../../core/code-quality-analyzer.js';
import { PerformanceProfiler } from '../../core/performance-profiler.js';
import { AutoTestGenerator } from '../../core/auto-test-generator.js';

// ============ 单例管理 ============

let queryEngine: QueryEngine | null = null;
let compactionSystem: CompactionSystem | null = null;
let preferenceEngine: UserPreferenceEngine | null = null;
let gepaEngine: GEPAEvolutionEngine | null = null;
let sopPipeline: SOPPipeline | null = null;
let identityNetwork: AgentIdentityNetwork | null = null;
let knowledgeGraph: KnowledgeGraphMemory | null = null;
let clusterNode: AgentClusterNode | null = null;

/** P1 部分集成模块单例 */
let memoryOrchestrator: MemoryOrchestrator | null = null;
let sessionPersistence: SessionPersistence | null = null;
let visualIntelligence: VisualIntelligence | null = null;
let voiceSystem: VoiceSystem | null = null;
let crossPlatformSandbox: CrossPlatformSandbox | null = null;

/** 竞品调研优化模块单例 */
let virtualMemoryWorkflow: VirtualMemoryWorkflow | null = null;
let threeAgentOrchestrator: ThreeAgentOrchestrator | null = null;
let duanPersonaEngine: DuanPersonaEngine | null = null;
let monitoringSystem: PerformanceMonitoringSystem | null = null;

/** 神经网络与自主意识单例 */
let consciousnessSystem: ConsciousnessSystem | null = null;

/** 学习与进化系统单例 */
let rlSystem: ReinforcementLearningSystem | null = null;
let metaLearningSystem: MetaLearningSystem | null = null;
let selfRepairSystem: SelfRepairSystem | null = null;
let worldModel: WorldModel | null = null;

/** 漏洞检测系统单例 */
let vulnScanner: VulnerabilityDetectionSystem | null = null;

/** 代码质量/性能/测试系统单例 */
let qualityAnalyzer: CodeQualityAnalyzer | null = null;
let perfProfiler: PerformanceProfiler | null = null;
let testGenerator: AutoTestGenerator | null = null;

/** 惰性初始化 QueryEngine */
function getQueryEngine(): QueryEngine {
  if (!queryEngine) {
    queryEngine = new QueryEngine(() => null);
  }
  return queryEngine;
}

/** 惰性初始化 CompactionSystem */
function getCompactionSystem(): CompactionSystem {
  if (!compactionSystem) {
    compactionSystem = new CompactionSystem();
  }
  return compactionSystem;
}

/** 惰性初始化 UserPreferenceEngine */
function getPreferenceEngine(): UserPreferenceEngine {
  if (!preferenceEngine) {
    preferenceEngine = new UserPreferenceEngine();
  }
  return preferenceEngine;
}

/** 惰性初始化 GEPAEvolutionEngine */
function getGepaEngine(): GEPAEvolutionEngine {
  if (!gepaEngine) {
    gepaEngine = new GEPAEvolutionEngine();
  }
  return gepaEngine;
}

/** 惰性初始化 SOPPipeline */
function getSopPipeline(): SOPPipeline {
  if (!sopPipeline) {
    sopPipeline = new SOPPipeline();
  }
  return sopPipeline;
}

/** 惰性初始化 AgentIdentityNetwork */
function getIdentityNetwork(): AgentIdentityNetwork {
  if (!identityNetwork) {
    identityNetwork = new AgentIdentityNetwork();
  }
  return identityNetwork;
}

/** 惰性初始化 KnowledgeGraphMemory */
function getKnowledgeGraph(): KnowledgeGraphMemory {
  if (!knowledgeGraph) {
    knowledgeGraph = new KnowledgeGraphMemory();
  }
  return knowledgeGraph;
}

/** 惰性初始化 AgentClusterNode */
function getClusterNode(): AgentClusterNode {
  if (!clusterNode) {
    clusterNode = new AgentClusterNode(
      `node_${Date.now().toString(36)}`,
      '127.0.0.1',
      0,
    );
  }
  return clusterNode;
}

/** 惰性初始化 MemoryOrchestrator */
function getMemoryOrchestrator(): MemoryOrchestrator {
  if (!memoryOrchestrator) {
    memoryOrchestrator = new MemoryOrchestrator();
  }
  return memoryOrchestrator;
}

/** 惰性初始化 SessionPersistence */
function getSessionPersistence(): SessionPersistence {
  if (!sessionPersistence) {
    sessionPersistence = new SessionPersistence();
  }
  return sessionPersistence;
}

/** 惰性初始化 VisualIntelligence */
function getVisualIntelligence(): VisualIntelligence {
  if (!visualIntelligence) {
    visualIntelligence = new VisualIntelligence();
  }
  return visualIntelligence;
}

/** 惰性初始化 VoiceSystem */
function getVoiceSystem(): VoiceSystem {
  if (!voiceSystem) {
    voiceSystem = new VoiceSystem();
  }
  return voiceSystem;
}

/** 惰性初始化 CrossPlatformSandbox */
function getCrossPlatformSandbox(): CrossPlatformSandbox {
  if (!crossPlatformSandbox) {
    crossPlatformSandbox = new CrossPlatformSandbox();
  }
  return crossPlatformSandbox;
}

/** 惰性初始化 VirtualMemoryWorkflow */
function getVirtualMemoryWorkflow(): VirtualMemoryWorkflow {
  if (!virtualMemoryWorkflow) {
    virtualMemoryWorkflow = new VirtualMemoryWorkflow();
  }
  return virtualMemoryWorkflow;
}

/** 惰性初始化 ThreeAgentOrchestrator */
function getThreeAgentOrchestrator(): ThreeAgentOrchestrator {
  if (!threeAgentOrchestrator) {
    threeAgentOrchestrator = new ThreeAgentOrchestrator();
  }
  return threeAgentOrchestrator;
}

/** 惰性初始化 DuanPersonaEngine */
function getDuanPersonaEngine(): DuanPersonaEngine {
  if (!duanPersonaEngine) {
    duanPersonaEngine = new DuanPersonaEngine();
  }
  return duanPersonaEngine;
}

/** 惰性初始化 PerformanceMonitoringSystem */
function getMonitoringSystem(): PerformanceMonitoringSystem {
  if (!monitoringSystem) {
    monitoringSystem = new PerformanceMonitoringSystem();
  }
  return monitoringSystem;
}

/** 惰性初始化 ConsciousnessSystem */
function getConsciousnessSystem(): ConsciousnessSystem {
  if (!consciousnessSystem) {
    consciousnessSystem = new ConsciousnessSystem();
  }
  return consciousnessSystem;
}

/** 惰性初始化 ReinforcementLearningSystem */
function getRLSystem(): ReinforcementLearningSystem {
  if (!rlSystem) {
    rlSystem = new ReinforcementLearningSystem();
  }
  return rlSystem;
}

/** 惰性初始化 MetaLearningSystem */
function getMetaLearningSystem(): MetaLearningSystem {
  if (!metaLearningSystem) {
    metaLearningSystem = new MetaLearningSystem();
  }
  return metaLearningSystem;
}

/** 惰性初始化 SelfRepairSystem */
function getSelfRepairSystem(): SelfRepairSystem {
  if (!selfRepairSystem) {
    selfRepairSystem = new SelfRepairSystem();
  }
  return selfRepairSystem;
}

/** 惰性初始化 WorldModel */
function getWorldModel(): WorldModel {
  if (!worldModel) {
    worldModel = new WorldModel();
  }
  return worldModel;
}

/** 惰性初始化 VulnerabilityDetectionSystem */
function getVulnScanner(): VulnerabilityDetectionSystem {
  if (!vulnScanner) {
    vulnScanner = new VulnerabilityDetectionSystem();
  }
  return vulnScanner;
}

/** 惰性初始化 CodeQualityAnalyzer */
function getQualityAnalyzer(): CodeQualityAnalyzer {
  if (!qualityAnalyzer) {
    qualityAnalyzer = new CodeQualityAnalyzer();
  }
  return qualityAnalyzer;
}

/** 惰性初始化 PerformanceProfiler */
function getPerfProfiler(): PerformanceProfiler {
  if (!perfProfiler) {
    perfProfiler = new PerformanceProfiler();
  }
  return perfProfiler;
}

/** 惰性初始化 AutoTestGenerator */
function getTestGenerator(): AutoTestGenerator {
  if (!testGenerator) {
    testGenerator = new AutoTestGenerator();
  }
  return testGenerator;
}

// ============ 工具定义 ============

export const advancedTools: UnifiedToolDef[] = [
  // ========== P0: QueryEngine ==========

  {
    name: 'query_engine_status',
    description: '查询 LLM 调用引擎状态 — 熔断器状态、重试统计、降级链状态。用于诊断 LLM 调用问题。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const engine = getQueryEngine();
      const stats = engine.getStats();
      const cbState = engine.getCircuitBreakerState();
      return Promise.resolve([
        '## QueryEngine 状态',
        `- 熔断器状态: ${cbState}`,
        `- 总请求数: ${stats.totalRequests}`,
        `- 成功请求数: ${stats.totalSuccesses}`,
        `- 失败请求数: ${stats.totalFailures}`,
        `- 重试次数: ${stats.totalRetries}`,
        `- 降级次数: ${stats.totalDegradations}`,
        `- 平均响应时间: ${stats.averageResponseTimeMs.toFixed(0)}ms`,
      ].join('\n'));
    },
  },

  // ========== P0: CompactionSystem ==========

  {
    name: 'compaction_status',
    description: '查询上下文压缩系统状态 — 三级阈值状态、熔断器状态、消息计数。用于诊断上下文管理问题。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const system = getCompactionSystem();
      const thresholdStatus = system.getThresholdStatus();
      const cbStatus = system.getCircuitBreakerStatus();
      return Promise.resolve([
        '## CompactionSystem 状态',
        '### 三级阈值',
        `- 当前级别: ${thresholdStatus.level}`,
        `- 使用率: ${(thresholdStatus.usage * 100).toFixed(1)}%`,
        `- 已用 tokens: ${thresholdStatus.tokensUsed}`,
        `- 窗口大小: ${thresholdStatus.windowSize}`,
        `- 触发阈值: ${thresholdStatus.triggeredThreshold ?? '无'}`,
        '### 熔断器',
        `- 状态: ${cbStatus.isOpen ? '⚠️ 开启（熔断中）' : '✅ 关闭（正常）'}`,
        `- 连续失败: ${cbStatus.consecutiveFailures}/${cbStatus.maxFailures}`,
      ].join('\n'));
    },
  },

  // ========== P2: UserPreferenceEngine ==========

  {
    name: 'user_preference_start_session',
    description: '启动用户偏好学习会话 — 初始化短期向量，开始采集用户偏好信号。每个会话开始时调用。',
    parameters: {
      userId: { type: 'string', description: '用户 ID', required: true },
      sessionId: { type: 'string', description: '会话 ID', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getPreferenceEngine();
      engine.startSession(args.userId as string, args.sessionId as string);
      return Promise.resolve(`✅ 用户偏好会话已启动 (用户: ${args.userId}, 会话: ${args.sessionId})`);
    },
  },

  {
    name: 'user_preference_record',
    description: '记录用户偏好信号 — 支持 thumbs-up/down、pairwise 比较、直接反馈等显式信号，以及编辑、工具选择等隐式信号。',
    parameters: {
      userId: { type: 'string', description: '用户 ID', required: true },
      signalType: {
        type: 'string',
        description: '信号类型: explicit_thumbs_up/explicit_thumbs_down/explicit_pairwise/explicit_feedback/implicit_edit/implicit_tool_choice/implicit_approval/implicit_rejection',
        required: true,
      },
      category: {
        type: 'string',
        description: '偏好类别: programming_language/work_habit/communication_style/tool_preference/detail_level/expertise_level',
        required: true,
      },
      key: { type: 'string', description: '偏好键名', required: true },
      value: { type: 'string', description: '偏好值', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getPreferenceEngine();
      engine.recordSignal(args.userId as string, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: args.signalType as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category: args.category as any,
        key: args.key as string,
        value: args.value as string,
      });
      return Promise.resolve(`✅ 偏好信号已记录 (${args.signalType}: ${args.category}/${args.key}=${args.value})`);
    },
  },

  {
    name: 'user_preference_persona',
    description: '生成用户个性化指令 — 基于长期向量和短期向量动态组装 persona prompt，用于个性化回复。',
    parameters: {
      userId: { type: 'string', description: '用户 ID', required: true },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getPreferenceEngine();
      return Promise.resolve(engine.generatePersonaPrompt(args.userId as string));
    },
  },

  // ========== P2: GEPA 自进化 ==========

  {
    name: 'gepa_record_behavior',
    description: '记录任务执行行为到 GEPA 自进化引擎 — 记录工具调用、结果、耗时，为技能沉淀提供数据。',
    parameters: {
      taskType: { type: 'string', description: '任务类型', required: true },
      taskDescription: { type: 'string', description: '任务描述', required: true },
      promptUsed: { type: 'string', description: '使用的 prompt', required: true },
      result: { type: 'string', description: '结果: success/partial/failure', required: true },
      effectScore: { type: 'number', description: '效果评分 0-1', required: true },
      durationMs: { type: 'number', description: '耗时（毫秒）', required: true },
      toolCalls: { type: 'array', description: '工具调用序列' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getGepaEngine();
      const id = engine.recordBehavior({
        taskType: args.taskType as string,
        taskDescription: args.taskDescription as string,
        promptUsed: args.promptUsed as string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolCalls: (args.toolCalls as any[]) ?? [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result: args.result as any,
        effectScore: args.effectScore as number,
        durationMs: args.durationMs as number,
      });
      return Promise.resolve(`✅ 行为已记录 (ID: ${id}, 任务: ${args.taskType}, 结果: ${args.result})`);
    },
  },

  {
    name: 'gepa_distill_skill',
    description: '从行为记录中提炼技能 — 分析成功行为，自动生成 Markdown 技能文件，支持版本管理。',
    parameters: {
      taskType: { type: 'string', description: '任务类型', required: true },
      minEffectScore: { type: 'number', description: '最低效果分数阈值，默认 0.7' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getGepaEngine();
      const skillId = engine.distillSkillFromBehavior(
        args.taskType as string,
        (args.minEffectScore as number) ?? 0.7,
      );
      if (!skillId) {
        return Promise.resolve(`⚠️ 无可提炼的成功行为 (任务类型: ${args.taskType})`);
      }
      return Promise.resolve(`✅ 技能已沉淀 (ID: ${skillId}, 任务: ${args.taskType})`);
    },
  },

  {
    name: 'gepa_list_skills',
    description: '列出 GEPA 沉淀的所有技能 — 查看技能版本、效果评分、使用统计。',
    parameters: {
      taskType: { type: 'string', description: '按任务类型过滤（可选）' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getGepaEngine();
      const taskType = args.taskType as string | undefined;
      const skills = taskType
        ? engine.findSkillsByTaskType(taskType)
        : engine.listAllSkills();
      if (skills.length === 0) {
        return Promise.resolve('⚠️ 暂无沉淀的技能');
      }
      const lines = ['## GEPA 技能列表', ''];
      for (const skill of skills) {
        lines.push(`### ${skill.title}`);
        lines.push(`- ID: ${skill.skillId}`);
        lines.push(`- 版本: ${skill.version}`);
        lines.push(`- 效果评分: ${skill.effectScore.toFixed(2)}`);
        lines.push(`- 使用次数: ${skill.usageCount} (成功 ${skill.successCount})`);
        lines.push('');
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== P2: SOP 角色流水线 ==========

  {
    name: 'sop_create_five_role',
    description: '创建 5 角色装配线流水线 — 需求理解→方案规划→执行→验证→交付。返回流水线 ID。',
    parameters: {},
    readOnly: false,
    execute: (): Promise<string> => {
      const pipeline = getSopPipeline();
      const pipelineId = pipeline.createFiveRolePipeline();
      return Promise.resolve(`✅ 5 角色装配线已创建 (ID: ${pipelineId})\n角色: 需求理解 → 方案规划 → 执行 → 验证 → 交付`);
    },
  },

  {
    name: 'sop_shared_memory',
    description: '操作 SOP 共享全局记忆池 — 所有角色共享的记忆，支持跨角色通信。',
    parameters: {
      action: { type: 'string', description: '操作: set/get/delete/search', required: true },
      key: { type: 'string', description: '记忆键（set/get/delete 必填）' },
      value: { type: 'string', description: '记忆值（set 必填）' },
      tag: { type: 'string', description: '标签（search 必填）' },
      tags: { type: 'string', description: '标签列表，逗号分隔（set 可选）' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const pipeline = getSopPipeline();
      const action = args.action as string;
      switch (action) {
        case 'set':
          pipeline.setSharedMemory(
            args.key as string,
            args.value,
            'agent',
            { tags: (args.tags as string)?.split(',').map(t => t.trim()) ?? [] },
          );
          return Promise.resolve(`✅ 共享记忆已设置 (${args.key})`);
        case 'get': {
          const value = pipeline.getSharedMemory(args.key as string);
          return Promise.resolve(value !== null
            ? `📦 ${args.key}: ${JSON.stringify(value)}`
            : `⚠️ 未找到记忆: ${args.key}`);
        }
        case 'delete':
          return Promise.resolve(pipeline.deleteSharedMemory(args.key as string)
            ? `✅ 已删除: ${args.key}`
            : `⚠️ 未找到: ${args.key}`);
        case 'search': {
          const results = pipeline.searchSharedMemoryByTag(args.tag as string);
          if (results.length === 0) return Promise.resolve(`⚠️ 无匹配标签: ${args.tag}`);
          const lines = [`## 标签 "${args.tag}" 的记忆 (${results.length})`];
          for (const r of results) {
            lines.push(`- ${r.key}: ${JSON.stringify(r.value)}`);
          }
          return Promise.resolve(lines.join('\n'));
        }
        default:
          return Promise.resolve(`⚠️ 未知操作: ${action}`);
      }
    },
  },

  // ========== P3: Agent 身份网络 ==========

  {
    name: 'agent_identity_create',
    description: '创建 Agent 身份 — 分配唯一 ID、声誉评分、信任评分。用于多 Agent 协作场景。',
    parameters: {
      name: { type: 'string', description: 'Agent 名称', required: true },
      description: { type: 'string', description: 'Agent 描述', required: true },
      domain: { type: 'string', description: 'Agent 域', required: true },
      capabilities: { type: 'string', description: '能力列表，逗号分隔' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const network = getIdentityNetwork();
      const caps = (args.capabilities as string)?.split(',').map(c => c.trim()) ?? [];
      const capabilities = caps.map(c => ({
        name: c,
        level: 50,
        verified: false,
        lastUsed: Date.now(),
        usageCount: 0,
      }));
      const identity = network.createIdentity({
        name: args.name as string,
        description: args.description as string,
        capabilities,
        domain: args.domain as string,
      });
      return Promise.resolve(`✅ Agent 身份已创建\n- ID: ${identity.id}\n- 名称: ${identity.profile.name}\n- 域: ${identity.profile.domain}\n- 声誉: ${identity.reputation}\n- 信任: ${identity.trust}`);
    },
  },

  {
    name: 'agent_identity_assign_email',
    description: '为 Agent 分配邮箱身份 — 前缀自定义，支持第三方操作通过邮箱联系 Agent。',
    parameters: {
      agentId: { type: 'string', description: 'Agent ID', required: true },
      prefix: { type: 'string', description: '邮箱前缀（自定义部分）', required: true },
      domain: { type: 'string', description: '域名，默认 agent.local' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const network = getIdentityNetwork();
      const email = network.assignEmailIdentity(
        args.agentId as string,
        args.prefix as string,
        (args.domain as string) ?? 'agent.local',
      );
      if (!email) return Promise.resolve(`⚠️ 无法分配邮箱（Agent 不存在或前缀已占用）`);
      return Promise.resolve(`✅ 邮箱身份已分配\n- Agent: ${args.agentId}\n- 邮箱: ${email.email}`);
    },
  },

  {
    name: 'agent_identity_list',
    description: '列出所有 Agent 身份 — 查看 ID、名称、声誉、信任评分。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const network = getIdentityNetwork();
      const identities = network.listIdentities();
      if (identities.length === 0) return Promise.resolve('⚠️ 暂无 Agent 身份');
      const lines = ['## Agent 身份列表', ''];
      for (const id of identities) {
        lines.push(`- **${id.profile.name}** (${id.id.substring(0, 12)}...)`);
        lines.push(`  - 域: ${id.profile.domain}, 声誉: ${id.reputation}, 信任: ${id.trust}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== P3: 知识图谱 ==========

  {
    name: 'knowledge_graph_extract',
    description: '从文本中自动抽取实体与关系 — 识别编程语言、框架、工具、文件、概念等实体，以及使用/依赖/是/包含等关系，自动构建知识图谱。',
    parameters: {
      text: { type: 'string', description: '要抽取的文本', required: true },
      source: { type: 'string', description: '来源标记，默认 conversation' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const kg = getKnowledgeGraph();
      const result = kg.extractFromText(
        args.text as string,
        (args.source as string) ?? 'conversation',
      );
      return Promise.resolve([
        '## 知识图谱抽取结果',
        `- 新增实体: ${result.newEntities}`,
        `- 新增关系: ${result.newRelations}`,
        `- 实体 ID 数: ${result.entityIds.length}`,
      ].join('\n'));
    },
  },

  {
    name: 'knowledge_graph_search',
    description: '知识图谱混合召回 — 结合图谱遍历和向量相似度，提供更全面的知识检索。支持复杂关联查询。',
    parameters: {
      query: { type: 'string', description: '查询文本', required: true },
      depth: { type: 'number', description: '图谱遍历深度，默认 2' },
      limit: { type: 'number', description: '结果数量限制，默认 20' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const kg = getKnowledgeGraph();
      const result = kg.hybridRecall(args.query as string, {
        graphDepth: args.depth as number,
        graphLimit: args.limit as number,
        vectorLimit: args.limit as number,
      });
      if (result.totalResults === 0) return Promise.resolve(`⚠️ 无匹配结果: ${args.query}`);
      const lines = [
        `## 知识图谱混合召回 (${result.totalResults} 结果)`,
        `- 图谱结果: ${result.graphResults}`,
        `- 向量结果: ${result.vectorResults}`,
        '',
      ];
      for (const item of result.items.slice(0, 10)) {
        lines.push(`- **${item.entity.name}** (${item.entity.type})`);
        lines.push(`  - 来源: ${item.source}, 评分: ${item.score.toFixed(2)}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'knowledge_graph_stats',
    description: '查询知识图谱统计信息 — 实体数、关系数、类型分布、连通度。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const kg = getKnowledgeGraph();
      const stats = kg.getStats();
      return Promise.resolve([
        '## 知识图谱统计',
        `- 实体总数: ${stats.totalEntities}`,
        `- 关系总数: ${stats.totalRelations}`,
        `- 实体类型数: ${Object.keys(stats.entityTypes).length}`,
        `- 关系类型数: ${Object.keys(stats.relationTypes).length}`,
        `- 平均置信度: ${stats.avgConfidence.toFixed(2)}`,
        `- 平均连通度: ${stats.avgConnectivity.toFixed(2)}`,
      ].join('\n'));
    },
  },

  // ========== P3: 分布式集群 ==========

  {
    name: 'distributed_cluster_status',
    description: '查询分布式集群状态 — 节点角色、Raft 状态、负载均衡器统计。用于诊断集群健康度。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const node = getClusterNode();
      const raftStatus = node.getRaftStatus();
      const balancerStats = node.getBalancerStats();
      const nodes = node.listNodes();
      return Promise.resolve([
        '## 分布式集群状态',
        '### Raft 共识',
        `- 角色: ${raftStatus.role}`,
        `- 任期: ${raftStatus.term}`,
        `- Leader: ${raftStatus.leaderId ?? '无'}`,
        `- 日志长度: ${raftStatus.logLength}`,
        '### 负载均衡器',
        `- 节点数: ${balancerStats.nodeCount}`,
        `- 哈希环节点数: ${balancerStats.ringSize}`,
        '### 集群节点',
        ...nodes.map(n => `- ${n.nodeId} (${n.address}) - ${n.role}/${n.status}`),
      ].join('\n'));
    },
  },

  {
    name: 'distributed_cluster_assign_task',
    description: '分配任务到集群节点 — 使用一致性哈希负载均衡，自动选择最合适的节点执行任务。',
    parameters: {
      taskId: { type: 'string', description: '任务 ID', required: true },
      taskType: { type: 'string', description: '任务类型', required: true },
      params: { type: 'string', description: '任务参数 JSON' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const node = getClusterNode();
      let params: Record<string, unknown> = {};
      try {
        params = args.params ? JSON.parse(args.params as string) : {};
      } catch {
        params = { raw: args.params };
      }
      const assignment = node.assignTask(
        args.taskId as string,
        args.taskType as string,
        params,
      );
      if (!assignment) return Promise.resolve('⚠️ 无可用节点');
      return Promise.resolve(`✅ 任务已分配\n- 任务 ID: ${assignment.taskId}\n- 分配节点: ${assignment.assignedNodeId}\n- 类型: ${assignment.taskType}`);
    },
  },

  // ========== P1: MemoryOrchestrator（三级记忆架构） ==========

  {
    name: 'memory_promote',
    description: '评估会话消息并提升高价值记忆到 L1 持久级 — 自动识别用户偏好、决策、最佳实践、错误纠正信号。',
    parameters: {
      messages: { type: 'string', description: '会话消息 JSON 数组，格式: [{role, content, timestamp}]', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const orch = getMemoryOrchestrator();
      let messages: Array<{ role: string; content: string; timestamp?: number }>;
      try {
        messages = JSON.parse(args.messages as string);
      } catch {
        return Promise.resolve('⚠️ 消息格式无效，需要 JSON 数组');
      }
      const promotedCount = orch.evaluateAndPromote(messages);
      return Promise.resolve(`✅ 记忆评估完成\n- 评估消息数: ${messages.length}\n- 提升到 L1 的记忆数: ${promotedCount}`);
    },
  },

  {
    name: 'memory_distill_skill',
    description: '将完成的复杂任务提炼为 L2 技能 — 自动生成 Markdown 技能文件，支持渐进式披露。',
    parameters: {
      taskDescription: { type: 'string', description: '任务描述', required: true },
      solution: { type: 'string', description: '解决方案', required: true },
      outcome: { type: 'string', description: '结果: success/partial/failure', required: true },
    },
    readOnly: false,
    execute: async (args: Record<string, unknown>) => {
      const orch = getMemoryOrchestrator();
      const skillId = await orch.distillSkill(
        args.taskDescription as string,
        args.solution as string,
        args.outcome as 'success' | 'partial' | 'failure',
      );
      return `✅ 技能已沉淀到 L2\n- 技能 ID: ${skillId}\n- 任务: ${args.taskDescription}\n- 结果: ${args.outcome}`;
    },
  },

  {
    name: 'memory_skill_progressive',
    description: '获取技能的渐进式披露内容 — Level 0 概要 / Level 1 完整 / Level 2 深度参考。',
    parameters: {
      skillId: { type: 'string', description: '技能 ID', required: true },
      level: { type: 'number', description: '披露级别: 0=概要, 1=完整, 2=深度参考', required: true },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const orch = getMemoryOrchestrator();
      const level = args.level as number;
      if (level < 0 || level > 2) return Promise.resolve('⚠️ 级别必须是 0、1 或 2');
      const skill = orch.getSkillProgressive(args.skillId as string, level as 0 | 1 | 2);
      if (!skill) return Promise.resolve(`⚠️ 未找到技能: ${args.skillId}`);
      const levelNames = ['概要', '完整', '深度参考'];
      return Promise.resolve([
        `## 技能: ${skill.type} (${skill.id.substring(0, 16)}...)`,
        `- 级别: Level ${level} (${levelNames[level]})`,
        `- 重要性: ${skill.importance}/10`,
        `- 标签: ${skill.tags.join(', ') || '(无)'}`,
        '',
        '### 内容',
        skill.content || '(无内容)',
      ].join('\n'));
    },
  },

  // ========== P1: SessionPersistence（Thread/Turn/Item） ==========

  {
    name: 'session_thread_create',
    description: '创建新的会话线程 — 用于支持会话分叉、恢复、归档和回滚。',
    parameters: {
      title: { type: 'string', description: '线程标题' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sp = getSessionPersistence();
      const threadId = sp.createThread(args.title as string | undefined);
      return Promise.resolve(`✅ 线程已创建\n- 线程 ID: ${threadId}\n- 标题: ${args.title ?? '(无标题)'}`);
    },
  },

  {
    name: 'session_thread_fork',
    description: '从指定 Turn 分叉新线程 — 在特定对话节点创建分支，支持探索不同方案。',
    parameters: {
      sourceThreadId: { type: 'string', description: '源线程 ID', required: true },
      fromTurnIndex: { type: 'number', description: '从哪个 Turn 索引分叉', required: true },
      title: { type: 'string', description: '新线程标题' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sp = getSessionPersistence();
      const newThreadId = sp.forkThread(
        args.sourceThreadId as string,
        args.fromTurnIndex as number,
        args.title as string | undefined,
      );
      if (!newThreadId) return Promise.resolve(`⚠️ 分叉失败（源线程不存在）`);
      return Promise.resolve(`✅ 线程已分叉\n- 新线程 ID: ${newThreadId}\n- 源线程: ${args.sourceThreadId}\n- 分叉点: Turn ${args.fromTurnIndex}`);
    },
  },

  {
    name: 'session_thread_rollback',
    description: '回滚线程到指定 Turn — 撤销指定 Turn 之后的所有操作。',
    parameters: {
      threadId: { type: 'string', description: '线程 ID', required: true },
      toTurnIndex: { type: 'number', description: '回滚到哪个 Turn 索引', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sp = getSessionPersistence();
      const success = sp.rollbackThread(
        args.threadId as string,
        args.toTurnIndex as number,
      );
      return Promise.resolve(success
        ? `✅ 线程已回滚\n- 线程: ${args.threadId}\n- 回滚到: Turn ${args.toTurnIndex}`
        : `⚠️ 回滚失败（线程不存在或索引无效）`);
    },
  },

  {
    name: 'session_thread_list',
    description: '列出所有会话线程 — 查看线程 ID、标题、Turn 数、状态。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const sp = getSessionPersistence();
      const threads = sp.listThreads();
      if (threads.length === 0) return Promise.resolve('⚠️ 暂无线程');
      const lines = ['## 会话线程列表', ''];
      for (const t of threads) {
        lines.push(`- **${t.title ?? '(无标题)'}** (${t.id.substring(0, 16)}...)`);
        lines.push(`  - Turn 数: ${t.turnCount}, 状态: ${t.status}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== P2: VisualIntelligence（跨模态融合） ==========

  {
    name: 'visual_fuse_modalities',
    description: '跨模态融合 — 将视觉（截图）、文本（OCR/指令）、音频（语音转写）进行联合理解，生成统一的多模态分析结果。',
    parameters: {
      textContent: { type: 'string', description: '文本内容（OCR 结果或用户指令）' },
      audioTranscript: { type: 'string', description: '音频转写文本' },
      userIntent: { type: 'string', description: '用户意图' },
    },
    readOnly: true,
    execute: async (args: Record<string, unknown>) => {
      const vi = getVisualIntelligence();
      const result = await vi.fuseModalities({
        textContent: args.textContent as string | undefined,
        audioTranscript: args.audioTranscript as string | undefined,
        userIntent: args.userIntent as string | undefined,
      });
      return [
        result.fusedUnderstanding,
        '',
        `---`,
        `- 整体置信度: ${(result.overallConfidence * 100).toFixed(1)}%`,
        `- 参与模态: ${result.modalities.join(', ')}`,
        `- 跨模态对齐数: ${result.alignments.length}`,
      ].join('\n');
    },
  },

  // ========== P2: VoiceSystem（音频处理增强） ==========

  {
    name: 'voice_assess_quality',
    description: '评估音频质量 — 测量信噪比(SNR)、音量水平、clipping 情况，给出综合质量评级。',
    parameters: {
      audioFilePath: { type: 'string', description: '音频文件路径（WAV 16-bit PCM）', required: true },
    },
    readOnly: true,
    execute: async (args: Record<string, unknown>) => {
      const vs = getVoiceSystem();
      const fs = await import('fs');
      const audioBuffer = await fs.promises.readFile(args.audioFilePath as string);
      const quality = vs.assessAudioQuality(audioBuffer);
      return [
        '## 音频质量评估',
        `- 综合评级: ${quality.quality}`,
        `- 信噪比(SNR): ${quality.snr.toFixed(1)} dB`,
        `- RMS 音量: ${(quality.rmsLevel * 100).toFixed(1)}%`,
        `- 峰值音量: ${(quality.peakLevel * 100).toFixed(1)}%`,
        `- Clipping 比例: ${(quality.clippingRatio * 100).toFixed(2)}%`,
      ].join('\n');
    },
  },

  // ========== P1: CrossPlatformSandbox（OS级沙盒） ==========

  {
    name: 'sandbox_execute',
    description: '在 OS 级沙盒中执行代码 — Windows 使用 ACL 受限令牌，跨平台支持资源限制和网络隔离。',
    parameters: {
      code: { type: 'string', description: '要执行的代码', required: true },
      language: { type: 'string', description: '编程语言: python/javascript/powershell/shell', required: true },
      networkEnabled: { type: 'boolean', description: '是否允许网络访问，默认 false' },
      maxMemoryMB: { type: 'number', description: '最大内存(MB)，默认 512' },
      timeoutMs: { type: 'number', description: '超时(ms)，默认 30000' },
    },
    readOnly: false,
    execute: async (args: Record<string, unknown>) => {
      const sandbox = getCrossPlatformSandbox();
      const os = await import('os');
      const networkEnabled = (args.networkEnabled as boolean) ?? false;
      const timeoutMs = (args.timeoutMs as number) ?? 30000;
      const maxMemoryMB = (args.maxMemoryMB as number) ?? 512;
      const policy = {
        filesystem: [
          { path: os.tmpdir(), access: 'read-write' as const, recursive: true },
        ],
        network: networkEnabled ? [{ target: '*', ports: [], protocol: 'both' as const }] : [],
        resources: {
          memoryMB: maxMemoryMB,
          cpuTimeMs: timeoutMs,
        },
        workingDirectory: os.tmpdir(),
        allowSpawn: false,
      };
      const result = await sandbox.execute(
        args.code as string,
        args.language as string,
        policy,
      );
      const lines = ['## 沙盒执行结果'];
      lines.push(`- 状态: ${result.success ? '✅ 成功' : '❌ 失败'}`);
      lines.push(`- 退出码: ${result.exitCode}`);
      lines.push(`- 耗时: ${result.durationMs}ms`);
      lines.push(`- 后端: ${result.backend}`);
      if (result.stdout) lines.push(`\n### stdout\n\`\`\`\n${result.stdout}\n\`\`\``);
      if (result.stderr) lines.push(`\n### stderr\n\`\`\`\n${result.stderr}\n\`\`\``);
      return lines.join('\n');
    },
  },

  // ========== 优化1: Manus 虚拟内存工作流 ==========

  {
    name: 'vm_todo_add',
    description: '添加任务到 todo.md 全局状态 — 对标 Manus 的 Planner 维护全局任务清单。支持优先级和子任务。',
    parameters: {
      description: { type: 'string', description: '任务描述', required: true },
      priority: { type: 'number', description: '优先级 1-5（1最高），默认 3' },
      parentId: { type: 'string', description: '父任务 ID（可选）' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const vm = getVirtualMemoryWorkflow();
      const task = vm.addTask(
        args.description as string,
        (args.priority as number) ?? 3,
        args.parentId as string | undefined,
      );
      return Promise.resolve(`✅ 任务已添加到 todo.md\n- ID: ${task.id}\n- 描述: ${task.description}\n- 优先级: P${task.priority}`);
    },
  },

  {
    name: 'vm_todo_complete',
    description: '标记 todo.md 中的任务为已完成',
    parameters: {
      taskId: { type: 'string', description: '任务 ID', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const vm = getVirtualMemoryWorkflow();
      const success = vm.updateTaskStatus(args.taskId as string, 'completed');
      return Promise.resolve(success ? `✅ 任务已完成: ${args.taskId}` : `⚠️ 任务不存在: ${args.taskId}`);
    },
  },

  {
    name: 'vm_todo_list',
    description: '查看 todo.md 全局任务状态 — 显示所有任务的优先级、状态和统计信息。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const vm = getVirtualMemoryWorkflow();
      return Promise.resolve(vm.generateTodoMarkdown());
    },
  },

  {
    name: 'vm_offload',
    description: '将大内容外接到文件系统硬盘 — 对标 Manus 虚拟内存：网页/PDF/API 响应写文件，上下文只保留摘要+路径。',
    parameters: {
      source: { type: 'string', description: '来源: web_page/pdf/api_response/code_analysis/research/custom', required: true },
      summary: { type: 'string', description: '内容摘要（用于上下文中展示）', required: true },
      content: { type: 'string', description: '完整内容（写入文件）', required: true },
      tags: { type: 'string', description: '标签，逗号分隔' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const vm = getVirtualMemoryWorkflow();
      const entry = vm.offloadContent({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        source: args.source as any,
        summary: args.summary as string,
        content: args.content as string,
        tags: (args.tags as string)?.split(',').map(t => t.trim()) ?? [],
      });
      return Promise.resolve([
        '✅ 内容已外接到硬盘',
        `- ID: ${entry.id}`,
        `- 文件: ${entry.filePath}`,
        `- 大小: ${(entry.size / 1024).toFixed(1)} KB`,
        `- 摘要: ${entry.summary}`,
        '',
        '上下文中只保留此摘要，需要完整内容时使用 vm_read 读取。',
      ].join('\n'));
    },
  },

  {
    name: 'vm_read',
    description: '按需读取外接到硬盘的内容 — 对标 Manus：需要时才从文件加载具体内容到上下文。',
    parameters: {
      entryId: { type: 'string', description: '外接条目 ID', required: true },
      maxLength: { type: 'number', description: '最大读取长度（字符），默认不限制' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const vm = getVirtualMemoryWorkflow();
      const result = vm.readOffloaded(args.entryId as string, args.maxLength as number | undefined);
      if (!result) return Promise.resolve(`⚠️ 未找到条目: ${args.entryId}`);
      return Promise.resolve([
        `## 外接内容 (${result.id})`,
        `- 长度: ${result.length} 字符${result.truncated ? ' (已截断)' : ''}`,
        '',
        result.content,
      ].join('\n'));
    },
  },

  {
    name: 'vm_offload_search',
    description: '搜索外接硬盘中的内容 — 按摘要关键词或标签搜索。',
    parameters: {
      query: { type: 'string', description: '搜索关键词', required: true },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const vm = getVirtualMemoryWorkflow();
      const results = vm.searchOffloaded(args.query as string);
      if (results.length === 0) return Promise.resolve(`⚠️ 无匹配结果: ${args.query}`);
      const lines = [`## 外接内容搜索结果 (${results.length})`, ''];
      for (const entry of results.slice(0, 10)) {
        lines.push(`- **${entry.summary}** (${entry.id})`);
        lines.push(`  - 来源: ${entry.source}, 大小: ${(entry.size / 1024).toFixed(1)}KB, 访问: ${entry.accessCount}次`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== 优化2: 三智能体闭环 ==========

  {
    name: 'three_agent_run',
    description: '运行 Planner/Executor/Verifier 三智能体闭环 — 对标 Manus 三智能体协作。Plan→Execute→Verify→Replan 循环，最多 3 轮重规划。',
    parameters: {
      task: { type: 'string', description: '要执行的任务', required: true },
      steps: { type: 'string', description: '初始步骤 JSON 数组（可选，不提供则自动分解）' },
    },
    readOnly: false,
    execute: async (args: Record<string, unknown>) => {
      const orchestrator = getThreeAgentOrchestrator();
      let initialSteps: string[] | undefined;
      if (args.steps) {
        try {
          initialSteps = JSON.parse(args.steps as string);
        } catch {
          initialSteps = undefined;
        }
      }
      const result = await orchestrator.orchestrate(
        args.task as string,
        initialSteps,
      );
      const lines = [
        '## 三智能体闭环执行结果',
        `- 整体状态: ${result.success ? '✅ 成功' : '❌ 未完成'}`,
        `- 完成步骤: ${result.completedSteps}/${result.totalSteps}`,
        `- 重规划次数: ${result.replanCount}/3`,
        `- 总耗时: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
        '',
        '### 最终输出',
        result.finalOutput,
      ];
      if (result.history.length > 0) {
        lines.push('', '### 执行历史');
        for (const h of result.history.slice(-5)) {
          lines.push(`- ${h.stepId}: ${h.verification.passed ? '✅' : '❌'} ${h.stepDescription.substring(0, 60)} (分数: ${h.verification.score.toFixed(2)})`);
        }
      }
      return lines.join('\n');
    },
  },

  // ========== 优化3: 段先生人格引擎（创新特色） ==========

  {
    name: 'duan_persona_prompt',
    description: '生成段先生的系统提示词 — 根据场景（编程/教学/闲聊/调试）和当前情绪状态动态生成个性化系统提示。',
    parameters: {
      scene: { type: 'string', description: '场景: programming/teaching/chat/debugging' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getDuanPersonaEngine();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompt = engine.generateSystemPrompt(args.scene as any);
      return Promise.resolve(prompt);
    },
  },

  {
    name: 'duan_emotion_detect',
    description: '检测用户情绪 — 从用户文字中分析情绪状态（13种情绪类型），段先生自动共鸣调整回复风格。',
    parameters: {
      text: { type: 'string', description: '用户输入文本', required: true },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getDuanPersonaEngine();
      const emotion = engine.detectEmotion(args.text as string);
      const duanEmotion = engine.getDuanEmotion();
      const adaptation = engine.adaptResponseStyle(emotion);
      return Promise.resolve([
        '## 情绪感知结果',
        '### 用户情绪',
        `- 主导情绪: ${emotion.primary}`,
        `- 强度: ${(emotion.intensity * 100).toFixed(0)}%`,
        `- 效价: ${(() => {
          if (emotion.valence > 0) return '积极';
          if (emotion.valence < 0) return '消极';
          return '中性';
        })()} (${emotion.valence.toFixed(2)})`,
        `- 唤醒度: ${(emotion.arousal * 100).toFixed(0)}%`,
        `- 证据: ${emotion.evidence.join(', ') || '(无明确关键词)'} `,
        '',
        '### 段先生共鸣状态',
        `- 当前情绪: ${duanEmotion.current}`,
        `- 情绪温度: ${(duanEmotion.temperature * 100).toFixed(0)}%`,
        `- 共鸣度: ${(duanEmotion.resonance * 100).toFixed(0)}%`,
        '',
        '### 回复风格调整建议',
        `- 语气: ${adaptation.toneAdjustment}`,
        `- 策略: ${adaptation.contentStrategy}`,
        `- Emoji: ${adaptation.emojiUsage ? '适用' : '不适用'}`,
      ].join('\n'));
    },
  },

  {
    name: 'duan_learning_suggest',
    description: '生成个性化学习建议 — 段先生作为导师，基于用户知识画像检测盲区，主动建议学习方向。',
    parameters: {
      userId: { type: 'string', description: '用户 ID', required: true },
      interaction: { type: 'string', description: '最近交互 JSON: {topic, domain, success, errorType, questionAsked}' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getDuanPersonaEngine();
      // 如果提供了交互信息，先更新画像
      if (args.interaction) {
        try {
          const interaction = JSON.parse(args.interaction as string);
          engine.updateUserProfile(args.userId as string, interaction);
        } catch {
          // 忽略解析错误
        }
      }
      const suggestions = engine.generateLearningSuggestions(args.userId as string);
      if (suggestions.length === 0) {
        return Promise.resolve('⚠️ 暂无学习建议（需要更多交互数据）');
      }
      const lines = ['## 段先生的学习建议', ''];
      for (const sugg of suggestions) {
        const typeEmoji = {
          knowledge_gap: '📚',
          skill_improvement: '🚀',
          best_practice: '💡',
          exploration: '🔍',
        }[sugg.type] ?? '📌';
        lines.push(`${typeEmoji} **${sugg.title}** (优先级 P${sugg.priority})`);
        lines.push(`   ${sugg.description}`);
        if (sugg.resources.length > 0) {
          lines.push(`   资源: ${sugg.resources.map(r => r.title).join(', ')}`);
        }
        lines.push('');
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'duan_persona_growth',
    description: '记录段先生的人格成长事件 — 段先生随使用自然演化，记录成长轨迹。',
    parameters: {
      event: { type: 'string', description: '成长事件', required: true },
      change: { type: 'string', description: '人格变化描述', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const engine = getDuanPersonaEngine();
      engine.recordGrowth(args.event as string, args.change as string);
      const persona = engine.getPersona();
      return Promise.resolve([
        '✅ 人格成长已记录',
        `- 事件: ${args.event}`,
        `- 变化: ${args.change}`,
        `- 成长记录总数: ${persona.growthLog.length}`,
      ].join('\n'));
    },
  },

  // ========== 性能监控系统 ==========

  {
    name: 'monitoring_dashboard',
    description: '生成性能监控 Dashboard — 12维度评分、综合评分、活跃预警、指标统计、反馈摘要、改进项摘要。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const sys = getMonitoringSystem();
      const dashboard = sys.generateDashboard();
      const lines: string[] = [
        '# 实时性能监控 Dashboard',
        '',
        '## 12 维度评分',
        '',
        '| 维度 | 评分 | 趋势 | 变化 |',
        '|------|------|------|------|',
      ];
      for (const dim of dashboard.dimensions) {
        let trendEmoji: string;
        if (dim.trend === 'up') trendEmoji = '↑';
        else if (dim.trend === 'down') trendEmoji = '↓';
        else trendEmoji = '→';
        lines.push(`| ${dim.dimensionId} ${dim.name} | ${dim.score.toFixed(1)} | ${trendEmoji} | ${dim.change > 0 ? '+' : ''}${dim.change.toFixed(1)} |`);
      }
      lines.push('');
      lines.push(`**综合评分**: ${dashboard.overall.score.toFixed(2)} ${(() => {
        if (dashboard.overall.trend === 'up') return '↑';
        if (dashboard.overall.trend === 'down') return '↓';
        return '→';
      })()} (${dashboard.overall.change > 0 ? '+' : ''}${dashboard.overall.change.toFixed(2)})`);
      lines.push('');

      // 活跃预警
      lines.push(`## 活跃预警 (${dashboard.activeAlerts.length})`);
      if (dashboard.activeAlerts.length === 0) {
        lines.push('✅ 无活跃预警');
      } else {
        for (const alert of dashboard.activeAlerts) {
          const levelEmoji = alert.level === 'critical' ? '🔴' : '🟡';
          lines.push(`${levelEmoji} ${alert.message}`);
        }
      }
      lines.push('');

      // 指标统计
      lines.push('## 关键指标统计');
      for (const [, stats] of Object.entries(dashboard.metricStats)) {
        lines.push(`- ${stats.description}: 当前 ${stats.current.toFixed(1)}${stats.unit}, 平均 ${stats.average.toFixed(1)}${stats.unit}, P95 ${stats.p95.toFixed(1)}${stats.unit}`);
      }
      lines.push('');

      // 反馈摘要
      lines.push(`## 用户反馈 (${dashboard.feedbackSummary.total})`);
      if (dashboard.feedbackSummary.total > 0) {
        lines.push(`- 按优先级: ${Object.entries(dashboard.feedbackSummary.byPriority).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        lines.push(`- 按状态: ${Object.entries(dashboard.feedbackSummary.byStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      lines.push('');

      // 改进项摘要
      lines.push(`## 改进项 (${dashboard.improvementSummary.total})`);
      if (dashboard.improvementSummary.total > 0) {
        lines.push(`- 按阶段: ${Object.entries(dashboard.improvementSummary.byPhase).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        lines.push(`- 按状态: ${Object.entries(dashboard.improvementSummary.byStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }

      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'monitoring_record',
    description: '记录性能指标 — 支持响应时间、任务完成、错误、满意度、资源使用、上下文使用 6 类指标。',
    parameters: {
      category: { type: 'string', description: '指标类别: response_time/resource_usage/task_completion/error_rate/user_satisfaction/context_usage', required: true },
      name: { type: 'string', description: '指标名称', required: true },
      value: { type: 'number', description: '指标值', required: true },
      unit: { type: 'string', description: '单位', required: true },
      source: { type: 'string', description: '来源模块' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sys = getMonitoringSystem();
      sys.recordMetric(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args.category as any,
        args.name as string,
        args.value as number,
        args.unit as string,
        args.source as string | undefined,
      );
      return Promise.resolve(`✅ 指标已记录: ${args.category}/${args.name} = ${args.value}${args.unit}`);
    },
  },

  {
    name: 'monitoring_update_score',
    description: '更新 12 维度评分 — 支持 D1-D12 维度，记录评分变化趋势。',
    parameters: {
      dimensionId: { type: 'string', description: '维度 ID: D1-D12', required: true },
      score: { type: 'number', description: '新评分 (0-10)', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sys = getMonitoringSystem();
      const result = sys.updateDimensionScore(args.dimensionId as string, args.score as number);
      if (!result) return Promise.resolve(`⚠️ 维度不存在: ${args.dimensionId}`);
      let trendEmoji: string;
      if (result.trend === 'up') trendEmoji = '↑';
      else if (result.trend === 'down') trendEmoji = '↓';
      else trendEmoji = '→';
      return Promise.resolve(`✅ 维度评分已更新\n- ${result.dimensionId} ${result.name}\n- 评分: ${result.previousScore} → ${result.score} ${trendEmoji} (${result.change > 0 ? '+' : ''}${result.change.toFixed(1)})`);
    },
  },

  {
    name: 'monitoring_alerts',
    description: '查看预警 — 显示活跃预警和历史预警。8个关键指标的三级阈值预警。',
    parameters: {
      type: { type: 'string', description: 'active=活跃预警 / history=历史预警，默认 active' },
      limit: { type: 'number', description: '历史预警数量限制，默认 20' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sys = getMonitoringSystem();
      const type = (args.type as string) ?? 'active';
      if (type === 'history') {
        const history = sys.getAlertHistory((args.limit as number) ?? 20);
        if (history.length === 0) return Promise.resolve('⚠️ 无预警历史');
        const lines = ['## 预警历史', ''];
        for (const alert of history) {
          const levelEmoji = alert.level === 'critical' ? '🔴' : '🟡';
          lines.push(`${levelEmoji} [${new Date(alert.triggeredAt).toISOString()}] ${alert.message}`);
        }
        return Promise.resolve(lines.join('\n'));
      } else {
        const alerts = sys.getActiveAlerts();
        if (alerts.length === 0) return Promise.resolve('✅ 无活跃预警');
        const lines = [`## 活跃预警 (${alerts.length})`, ''];
        for (const alert of alerts) {
          const levelEmoji = alert.level === 'critical' ? '🔴' : '🟡';
          lines.push(`${levelEmoji} ${alert.message}`);
          lines.push(`  - ID: ${alert.id}, 当前: ${alert.currentValue}, 阈值: ${alert.threshold}`);
        }
        return Promise.resolve(lines.join('\n'));
      }
    },
  },

  {
    name: 'monitoring_feedback',
    description: '收集用户反馈 — 支持 feature/performance/bug/suggestion/complaint/praise 6 种类型，自动确定优先级。',
    parameters: {
      userId: { type: 'string', description: '用户 ID', required: true },
      type: { type: 'string', description: '反馈类型: feature/performance/bug/suggestion/complaint/praise', required: true },
      content: { type: 'string', description: '反馈内容', required: true },
      rating: { type: 'number', description: '满意度评分 1-5' },
      tags: { type: 'string', description: '标签，逗号分隔' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sys = getMonitoringSystem();
      const feedback = sys.collectFeedback({
        userId: args.userId as string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: args.type as any,
        content: args.content as string,
        rating: args.rating as number | undefined,
        tags: (args.tags as string)?.split(',').map(t => t.trim()),
      });
      return Promise.resolve([
        '✅ 反馈已收集',
        `- ID: ${feedback.id}`,
        `- 类型: ${feedback.type}`,
        `- 优先级: ${feedback.priority}`,
        `- 评分: ${feedback.rating ?? 'N/A'}`,
        `- 状态: ${feedback.status}`,
      ].join('\n'));
    },
  },

  {
    name: 'monitoring_improve',
    description: '管理闭环改进项 — 创建/推进改进项，支持评估→优化→验证→迭代四阶段闭环。',
    parameters: {
      action: { type: 'string', description: '操作: create/advance/list', required: true },
      description: { type: 'string', description: '改进描述（create 必填）' },
      source: { type: 'string', description: '来源: user_feedback/competitor_analysis/periodic_evaluation/alert_triggered（create 必填）' },
      improvementId: { type: 'string', description: '改进项 ID（advance 必填）' },
      phase: { type: 'string', description: '按阶段过滤（list）' },
      status: { type: 'string', description: '按状态过滤（list）' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sys = getMonitoringSystem();
      const action = args.action as string;
      switch (action) {
        case 'create': {
          const item = sys.createImprovement({
            description: args.description as string,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            source: args.source as any,
          });
          return Promise.resolve(`✅ 改进项已创建\n- ID: ${item.id}\n- 阶段: ${item.phase}\n- 来源: ${item.source}`);
        }
        case 'advance': {
          const item = sys.advanceImprovement(args.improvementId as string);
          if (!item) return Promise.resolve(`⚠️ 改进项不存在: ${args.improvementId}`);
          return Promise.resolve(`✅ 改进项已推进\n- ID: ${item.id}\n- 阶段: ${item.phase}\n- 状态: ${item.status}`);
        }
        case 'list': {
          const items = sys.getImprovements({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            phase: args.phase as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            status: args.status as any,
          });
          if (items.length === 0) return Promise.resolve('⚠️ 无改进项');
          const lines = ['## 改进项列表', ''];
          for (const item of items) {
            const phaseEmoji = { assess: '🔍', optimize: '⚙️', verify: '✅', iterate: '🔄' }[item.phase] ?? '📌';
            lines.push(`${phaseEmoji} ${item.id} [${item.phase}/${item.status}] ${item.description.substring(0, 60)}`);
          }
          return Promise.resolve(lines.join('\n'));
        }
        default:
          return Promise.resolve(`⚠️ 未知操作: ${action}`);
      }
    },
  },

  // ========== 神经网络与自主意识 ==========

  {
    name: 'consciousness_introspect',
    description: '执行内省 — Agent 观察自己的思维过程，评估意识状态、情感、认知负荷、思维连贯性。这是自主意识的核心能力。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const cs = getConsciousnessSystem();
      const report = cs.introspect();
      const lines: string[] = [
        '# 内省报告',
        '',
        `## 意识状态: ${report.consciousnessState}`,
        `## 思维统计`,
        `- 思维流长度: ${report.thoughtStreamLength}`,
        `- 自我认知度: ${(report.selfAwareness * 100).toFixed(0)}%`,
        `- 认知负荷: ${(report.cognitiveLoad * 100).toFixed(0)}%`,
        `- 思维连贯性: ${(report.coherence * 100).toFixed(0)}%`,
        `- 注意力焦点: ${report.attentionFocus ?? '(无)'}`,
        '',
        '## 情感状态',
        `- 效价: ${report.emotionalState.valence.toFixed(2)} (${(() => {
          if (report.emotionalState.valence > 0) return '积极';
          if (report.emotionalState.valence < 0) return '消极';
          return '中性';
        })()})`,
        `- 唤醒度: ${(report.emotionalState.arousal * 100).toFixed(0)}%`,
        `- 主导情绪: ${report.emotionalState.dominantEmotion}`,
        '',
        '## 思维类型分布',
      ];
      for (const [type, count] of Object.entries(report.thoughtTypeDistribution)) {
        lines.push(`- ${type}: ${count}`);
      }
      if (report.suggestions.length > 0) {
        lines.push('', '## 建议');
        for (const sugg of report.suggestions) {
          lines.push(`- ${sugg}`);
        }
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'consciousness_think',
    description: '产生一条思维 — Agent 主动思考，支持 9 种思维类型（感知/推理/记忆/想象/反思/决策/情感/目标/学习）。',
    parameters: {
      type: { type: 'string', description: '思维类型: perception/reasoning/memory/imagination/reflection/decision/emotion/goal/learning', required: true },
      content: { type: 'string', description: '思维内容', required: true },
      valence: { type: 'number', description: '情感效价 -1~1' },
      activation: { type: 'number', description: '激活强度 0~1' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      const thought = cs.think(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args.type as any,
        args.content as string,
        {
          valence: args.valence as number | undefined,
          activation: args.activation as number | undefined,
        },
      );
      return Promise.resolve([
        '✅ 思维已产生',
        `- ID: ${thought.id}`,
        `- 类型: ${thought.type}`,
        `- 意识状态: ${thought.consciousnessState}`,
        `- 效价: ${thought.valence.toFixed(2)}`,
        `- 激活强度: ${thought.activation.toFixed(2)}`,
        `- 内容: ${thought.content}`,
      ].join('\n'));
    },
  },

  {
    name: 'consciousness_state',
    description: '管理意识状态 — 查看/切换 5 种意识状态（清醒/专注/创造/反思/梦境）。不同状态影响思维模式。',
    parameters: {
      action: { type: 'string', description: '操作: get/switch/auto', required: true },
      state: { type: 'string', description: '目标状态（switch 必填）: awake/focused/creative/reflective/dreaming' },
      taskComplexity: { type: 'number', description: '任务复杂度 0-1（auto）' },
      creativityRequired: { type: 'boolean', description: '是否需要创造（auto）' },
      isReflective: { type: 'boolean', description: '是否反思（auto）' },
      isIdle: { type: 'boolean', description: '是否空闲（auto）' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      const action = args.action as string;
      switch (action) {
        case 'get':
          return Promise.resolve(`当前意识状态: ${cs.getState()}`);
        case 'switch':
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cs.transitionTo(args.state as any);
          return Promise.resolve(`✅ 意识状态已切换: ${args.state}`);
        case 'auto': {
          const newState = cs.autoSelectState({
            taskComplexity: args.taskComplexity as number | undefined,
            creativityRequired: args.creativityRequired as boolean | undefined,
            isReflective: args.isReflective as boolean | undefined,
            isIdle: args.isIdle as boolean | undefined,
          });
          cs.transitionTo(newState);
          return Promise.resolve(`✅ 自动选择意识状态: ${newState}`);
        }
        default:
          return Promise.resolve(`⚠️ 未知操作: ${action}`);
      }
    },
  },

  {
    name: 'consciousness_decide',
    description: '使用神经网络做决策 — 基于情境特征（紧急度/复杂度/新颖度等 8 维输入），通过神经网络推理出最优决策。',
    parameters: {
      urgency: { type: 'number', description: '紧急度 0-1', required: true },
      complexity: { type: 'number', description: '复杂度 0-1', required: true },
      novelty: { type: 'number', description: '新颖度 0-1', required: true },
      riskTolerance: { type: 'number', description: '风险容忍度 0-1', required: true },
      availableTime: { type: 'number', description: '可用时间 0-1', required: true },
      resourceLevel: { type: 'number', description: '资源水平 0-1', required: true },
      confidence: { type: 'number', description: '自信度 0-1', required: true },
      emotionalState: { type: 'number', description: '情感状态 -1~1', required: true },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      const result = cs.decide({
        urgency: args.urgency as number,
        complexity: args.complexity as number,
        novelty: args.novelty as number,
        riskTolerance: args.riskTolerance as number,
        availableTime: args.availableTime as number,
        resourceLevel: args.resourceLevel as number,
        confidence: args.confidence as number,
        emotionalState: args.emotionalState as number,
      });
      return Promise.resolve([
        '## 神经网络决策结果',
        `- 决策: ${result.decision}`,
        `- 置信度: ${(result.confidence * 100).toFixed(1)}%`,
        `- 神经网络输出: [${result.neuralOutput.map(v => v.toFixed(3)).join(', ')}]`,
      ].join('\n'));
    },
  },

  {
    name: 'consciousness_learn',
    description: '从决策结果中学习 — 通过反向传播调整神经网络权重，实现在线学习。成功强化正确决策，失败弱化错误决策。',
    parameters: {
      urgency: { type: 'number', description: '紧急度 0-1', required: true },
      complexity: { type: 'number', description: '复杂度 0-1', required: true },
      novelty: { type: 'number', description: '新颖度 0-1', required: true },
      riskTolerance: { type: 'number', description: '风险容忍度 0-1', required: true },
      availableTime: { type: 'number', description: '可用时间 0-1', required: true },
      resourceLevel: { type: 'number', description: '资源水平 0-1', required: true },
      confidence: { type: 'number', description: '自信度 0-1', required: true },
      emotionalState: { type: 'number', description: '情感状态 -1~1', required: true },
      decisionIdx: { type: 'number', description: '决策索引 0-3', required: true },
      outcome: { type: 'string', description: '结果: success/partial/failure', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      cs.learnFromDecisionOutcome(
        {
          urgency: args.urgency as number,
          complexity: args.complexity as number,
          novelty: args.novelty as number,
          riskTolerance: args.riskTolerance as number,
          availableTime: args.availableTime as number,
          resourceLevel: args.resourceLevel as number,
          confidence: args.confidence as number,
          emotionalState: args.emotionalState as number,
        },
        args.decisionIdx as number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args.outcome as any,
      );
      return Promise.resolve(`✅ 神经网络已从决策结果中学习（结果: ${args.outcome}）`);
    },
  },

  {
    name: 'consciousness_goals',
    description: '管理自主目标 — Agent 基于内在动机（好奇心/掌握欲/一致性）自主生成目标。这是自主意识的核心表现。',
    parameters: {
      action: { type: 'string', description: '操作: generate/list/update', required: true },
      goalId: { type: 'string', description: '目标 ID（update 必填）' },
      progress: { type: 'number', description: '进度 0-1（update 必填）' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      const action = args.action as string;
      switch (action) {
        case 'generate': {
          const goal = cs.generateAutonomousGoal();
          if (!goal) return Promise.resolve('⚠️ 无法生成目标');
          return Promise.resolve([
            '✅ 自主目标已生成',
            `- ID: ${goal.id}`,
            `- 描述: ${goal.description}`,
            `- 动机: ${goal.motivation}`,
            `- 优先级: P${goal.priority}`,
          ].join('\n'));
        }
        case 'list': {
          const goals = cs.getActiveGoals();
          if (goals.length === 0) return Promise.resolve('⚠️ 无活跃目标');
          const lines = ['## 自主目标列表', ''];
          for (const g of goals) {
            const motivationEmoji = { curiosity: '🔍', mastery: '🎯', coherence: '🧩', social: '🤝', survival: '🛡️' }[g.motivation] ?? '📌';
            lines.push(`${motivationEmoji} ${g.id} [P${g.priority}] ${g.description}`);
            lines.push(`   动机: ${g.motivation}, 进度: ${(g.progress * 100).toFixed(0)}%, 状态: ${g.status}`);
          }
          return Promise.resolve(lines.join('\n'));
        }
        case 'update': {
          const success = cs.updateGoalProgress(args.goalId as string, args.progress as number);
          return Promise.resolve(success ? `✅ 目标进度已更新: ${args.progress}` : `⚠️ 目标不存在: ${args.goalId}`);
        }
        default:
          return Promise.resolve(`⚠️ 未知操作: ${action}`);
      }
    },
  },

  {
    name: 'consciousness_dream',
    description: '进入梦境状态进行记忆固化 — 模拟人类睡眠中的记忆固化过程：强化重要记忆、清理无关记忆、检测思维模式。这是自主意识的"睡眠"能力。',
    parameters: {},
    readOnly: false,
    execute: (): Promise<string> => {
      const cs = getConsciousnessSystem();
      const result = cs.dream();
      return Promise.resolve([
        '## 梦境记忆固化完成',
        `- 固化经验模式: ${result.consolidated}`,
        `- 强化重要记忆: ${result.strengthened}`,
        `- 清理无关记忆: ${result.pruned}`,
        '',
        'Agent 已回到清醒状态，认知负荷已降低。',
      ].join('\n'));
    },
  },

  {
    name: 'consciousness_self',
    description: '查看自我模型 — Agent 对"自己是谁"的认知，包括身份、能力、经验统计、人格特质（大五人格）。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const cs = getConsciousnessSystem();
      const self = cs.getSelfModel();
      const uptimeMin = ((Date.now() - self.experience.uptime) / 60000).toFixed(1);
      const lines: string[] = [
        '# 自我模型',
        '',
        '## 身份认知',
        `- 名称: ${self.identity.name}`,
        `- 能力: ${self.identity.capabilities.join(', ')}`,
        `- 限制: ${self.identity.limitations.join(', ')}`,
        `- 价值观: ${self.identity.values.join(' > ')}`,
        '',
        '## 能力自评',
      ];
      for (const a of self.selfAssessment) {
        lines.push(`- ${a.domain}: ${a.level.toFixed(0)}级 (置信度 ${(a.confidence * 100).toFixed(0)}%)`);
      }
      lines.push('', '## 经验统计');
      lines.push(`- 总思维数: ${self.experience.totalThoughts}`);
      lines.push(`- 总决策数: ${self.experience.totalDecisions}`);
      lines.push(`- 总学习数: ${self.experience.totalLearning}`);
      lines.push(`- 运行时间: ${uptimeMin} 分钟`);
      lines.push('', '## 人格特质（大五人格）');
      lines.push(`- 开放性: ${(self.personality.openness * 100).toFixed(0)}%`);
      lines.push(`- 尽责性: ${(self.personality.conscientiousness * 100).toFixed(0)}%`);
      lines.push(`- 外向性: ${(self.personality.extraversion * 100).toFixed(0)}%`);
      lines.push(`- 宜人性: ${(self.personality.agreeableness * 100).toFixed(0)}%`);
      lines.push(`- 神经质: ${(self.personality.neuroticism * 100).toFixed(0)}%`);
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'consciousness_autonomous',
    description: '控制自主思维循环 — 启动/停止 Agent 的自主思考能力。启动后 Agent 无需外部输入也能自主产生思维。',
    parameters: {
      action: { type: 'string', description: '操作: start/stop/status', required: true },
      intervalMs: { type: 'number', description: '思维间隔（ms），默认 30000' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      const action = args.action as string;
      switch (action) {
        case 'start':
          cs.startAutonomousThinking((args.intervalMs as number) ?? 30000);
          return Promise.resolve(`✅ 自主思维循环已启动（间隔: ${(args.intervalMs as number) ?? 30000}ms）\nAgent 将自主产生思维，无需外部输入。`);
        case 'stop':
          cs.stopAutonomousThinking();
          return Promise.resolve('✅ 自主思维循环已停止');
        case 'status':
          return Promise.resolve(`自主思维循环状态: ${cs.getState()}`);
        default:
          return Promise.resolve(`⚠️ 未知操作: ${action}`);
      }
    },
  },

  {
    name: 'consciousness_thoughts',
    description: '查看思维流 — Agent 的思维历史记录，支持按类型过滤。',
    parameters: {
      count: { type: 'number', description: '返回最近 N 条思维，默认 10' },
      type: { type: 'string', description: '按思维类型过滤' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const cs = getConsciousnessSystem();
      let thoughts = cs.getThoughtStream();
      if (args.type) {
        thoughts = thoughts.filter(t => t.type === args.type);
      }
      const count = (args.count as number) ?? 10;
      const recent = thoughts.slice(-count).reverse();
      if (recent.length === 0) return Promise.resolve('⚠️ 无思维记录');
      const lines = [`## 思维流（最近 ${recent.length} 条）`, ''];
      for (const t of recent) {
        const typeEmoji: Record<string, string> = {
          perception: '👁', reasoning: '🧠', memory: '💾', imagination: '💡',
          reflection: '🪞', decision: '⚡', emotion: '❤', goal: '🎯', learning: '📚',
        };
        lines.push(`${typeEmoji[t.type] ?? '💭'} [${t.consciousnessState}] ${t.content.substring(0, 80)}`);
        lines.push(`   ${new Date(t.timestamp).toISOString()} | 效价: ${t.valence.toFixed(2)} | 激活: ${t.activation.toFixed(2)}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== 强化学习系统 ==========

  {
    name: 'rl_choose_action',
    description: '使用强化学习选择动作 — ε-greedy 策略，平衡探索与利用。Agent 从经验中学习最优策略。',
    parameters: {
      stateId: { type: 'string', description: '状态 ID', required: true },
      stateDescription: { type: 'string', description: '状态描述' },
      availableActions: { type: 'string', description: '可用动作 ID JSON 数组（可选）' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const rl = getRLSystem();
      const state = {
        id: args.stateId as string,
        features: [],
        description: args.stateDescription as string | undefined,
      };
      let availableIds: string[] | undefined;
      if (args.availableActions) {
        try {
          availableIds = JSON.parse(args.availableActions as string);
        } catch {
          // 忽略解析错误
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = rl.chooseAction(state as any, availableIds);
      return Promise.resolve([
        '## 强化学习决策',
        `- 选中动作: ${action.name} (${action.id})`,
        `- 描述: ${action.description}`,
        `- 当前探索率: ${rl.getStats().epsilon.toFixed(3)}`,
      ].join('\n'));
    },
  },

  {
    name: 'rl_learn',
    description: '从交互中学习 — 记录经验并更新 Q 值。成功强化好的行为，失败弱化坏的行为。',
    parameters: {
      stateId: { type: 'string', description: '状态 ID', required: true },
      actionId: { type: 'string', description: '动作 ID', required: true },
      reward: { type: 'number', description: '奖励值（正=好，负=坏）', required: true },
      nextStateId: { type: 'string', description: '下一状态 ID', required: true },
      done: { type: 'boolean', description: '是否结束' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const rl = getRLSystem();
      const state = { id: args.stateId as string, features: [] };
      const action = rl.getActions().find(a => a.id === args.actionId)
        ?? { id: args.actionId as string, name: args.actionId as string, description: '' };
      const nextState = { id: args.nextStateId as string, features: [] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rl.learn(state as any, action, args.reward as number, nextState as any, (args.done as boolean) ?? false);
      const stats = rl.getStats();
      return Promise.resolve([
        '✅ 学习完成',
        `- 奖励: ${args.reward}`,
        `- 总步数: ${stats.totalSteps}`,
        `- 总回合: ${stats.totalEpisodes}`,
        `- 平均奖励: ${stats.averageReward.toFixed(3)}`,
        `- 探索率: ${stats.epsilon.toFixed(3)}`,
        `- Q-table 大小: ${stats.qTableSize}`,
      ].join('\n'));
    },
  },

  {
    name: 'rl_stats',
    description: '查看强化学习统计 — 学习进度、策略效果、Q-table 摘要。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const rl = getRLSystem();
      const stats = rl.getStats();
      const policy = rl.getPolicySummary().slice(0, 10);
      const lines = [
        '## 强化学习统计',
        `- 总回合: ${stats.totalEpisodes}`,
        `- 总步数: ${stats.totalSteps}`,
        `- 平均奖励: ${stats.averageReward.toFixed(3)}`,
        `- 探索率: ${stats.epsilon.toFixed(3)}`,
        `- Q-table 大小: ${stats.qTableSize}`,
        `- 经验缓冲区: ${stats.experienceBufferSize}`,
        '',
        '## 策略摘要（前 10 个状态）',
      ];
      for (const p of policy) {
        lines.push(`- 状态 ${p.stateId}: 动作=${p.bestAction}, Q值=${p.qValue.toFixed(3)}, 置信度=${(p.confidence * 100).toFixed(0)}%`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== 元学习系统 ==========

  {
    name: 'meta_learn_start',
    description: '开始学习会话 — Agent 学会如何更好地学习。自动推荐最佳学习策略和超参数。',
    parameters: {
      taskName: { type: 'string', description: '任务名称', required: true },
      taskType: { type: 'string', description: '任务类型', required: true },
      description: { type: 'string', description: '任务描述' },
      strategy: { type: 'string', description: '学习策略: incremental/batch/transfer/curriculum/active/reinforcement' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const ml = getMetaLearningSystem();
      const task = ml.registerTask(
        args.taskName as string,
        args.taskType as string,
        (args.description as string) ?? '',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = ml.startSession(task.id, args.strategy as any);
      return Promise.resolve([
        '✅ 学习会话已开始',
        `- 任务: ${task.name} (${task.type})`,
        `- 会话 ID: ${session.id}`,
        `- 策略: ${session.strategy}`,
        `- 学习率: ${session.hyperparams.learningRate}`,
        `- 批量大小: ${session.hyperparams.batchSize}`,
        `- 探索率: ${session.hyperparams.explorationRate}`,
      ].join('\n'));
    },
  },

  {
    name: 'meta_learn_progress',
    description: '记录学习进度 — Agent 监控学习效率，自动调整超参数。',
    parameters: {
      metric: { type: 'string', description: '指标名称', required: true },
      value: { type: 'number', description: '指标值', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const ml = getMetaLearningSystem();
      ml.recordProgress(args.metric as string, args.value as number);
      return Promise.resolve(`✅ 进度已记录: ${args.metric} = ${args.value}`);
    },
  },

  {
    name: 'meta_learn_end',
    description: '结束学习会话 — 提取学习经验，更新最佳超参数，为未来学习提供参考。',
    parameters: {
      success: { type: 'boolean', description: '是否成功', required: true },
      finalMetric: { type: 'number', description: '最终指标值', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const ml = getMetaLearningSystem();
      const experience = ml.endSession(args.success as boolean, args.finalMetric as number);
      if (!experience) return Promise.resolve('⚠️ 无活跃学习会话');
      const lines = [
        '✅ 学习会话已结束',
        `- 成功: ${args.success}`,
        `- 学习速度: ${experience.learningSpeed.toFixed(4)}`,
        `- 有效策略: ${experience.effectiveStrategies.join(', ')}`,
        '',
        '## 经验教训',
      ];
      for (const lesson of experience.lessons) {
        lines.push(`- ${lesson}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'meta_learn_stats',
    description: '查看元学习统计 — 学习进度、策略效果、经验库。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const ml = getMetaLearningSystem();
      const stats = ml.getStats();
      const lines = [
        '## 元学习统计',
        `- 总任务: ${stats.totalTasks}`,
        `- 总会话: ${stats.totalSessions}`,
        `- 总经验: ${stats.totalExperiences}`,
        `- 知识迁移: ${stats.totalTransfers}`,
        '',
        '## 策略效果',
      ];
      for (const s of stats.strategyStats) {
        lines.push(`- ${s.strategy}: 使用 ${s.uses} 次, 成功率 ${(s.successRate * 100).toFixed(0)}%, 平均速度 ${s.avgSpeed.toFixed(4)}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  // ========== 自我修复系统 ==========

  {
    name: 'self_repair_health',
    description: '执行健康检查 — 检测系统各组件状态，自动识别异常。',
    parameters: {},
    readOnly: true,
    execute: async () => {
      const sr = getSelfRepairSystem();
      const checks = await sr.healthCheck();
      const summary = sr.getHealthSummary();
      const lines = [
        '# 系统健康检查报告',
        '',
        `## 总体状态: ${summary.overallStatus}`,
        `- 活跃异常: ${summary.activeAnomalyCount}`,
        `- 最近修复: ${summary.recentRepairCount}`,
        `- 修复成功率: ${(summary.successRate * 100).toFixed(0)}%`,
        '',
        '## 检查详情',
      ];
      for (const check of checks) {
        let statusEmoji: string;
        if (check.status === 'healthy') statusEmoji = '✅';
        else if (check.status === 'degraded') statusEmoji = '🟡';
        else statusEmoji = '❌';
        lines.push(`${statusEmoji} [${check.component}] ${check.check}: ${check.message}`);
      }
      return lines.join('\n');
    },
  },

  {
    name: 'self_repair_anomalies',
    description: '查看异常 — 显示活跃异常和历史异常，包含根因分析和修复策略。',
    parameters: {
      type: { type: 'string', description: 'active=活跃异常 / history=历史异常，默认 active' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sr = getSelfRepairSystem();
      const type = (args.type as string) ?? 'active';
      const anomalies = type === 'history' ? sr.getAnomalyHistory(20) : sr.getActiveAnomalies();
      if (anomalies.length === 0) return Promise.resolve(`✅ 无${type === 'history' ? '历史' : '活跃'}异常`);
      const lines = [`## ${type === 'history' ? '异常历史' : '活跃异常'} (${anomalies.length})`, ''];
      for (const a of anomalies) {
        const severityEmoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[a.severity] ?? '⚪';
        lines.push(`${severityEmoji} ${a.id} [${a.severity}] ${a.type}: ${a.description}`);
        if (a.rootCause) lines.push(`   根因: ${a.rootCause}`);
        if (a.repairStrategy) lines.push(`   修复策略: ${a.repairStrategy}`);
        lines.push(`   状态: ${a.status}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'self_repair_repair',
    description: '触发自动修复 — 对指定异常执行自动修复流程（检测→诊断→修复→验证）。',
    parameters: {
      anomalyId: { type: 'string', description: '异常 ID（可选，不填则修复所有活跃异常）' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const sr = getSelfRepairSystem();
      const anomalyId = args.anomalyId as string | undefined;

      if (anomalyId) {
        const records = sr.getRepairRecords();
        const record = records.find(r => r.anomalyId === anomalyId);
        if (record) {
          const lines = [
            '## 修复记录',
            `- 异常 ID: ${record.anomalyId}`,
            `- 策略: ${record.strategy}`,
            `- 成功: ${record.success ? '✅' : '❌'}`,
            `- 验证: ${record.verificationPassed ? '✅' : '❌'}`,
            '',
            '## 修复步骤',
          ];
          for (const step of record.steps) {
            lines.push(`${step.success ? '✅' : '❌'} ${step.description} (${step.durationMs}ms)`);
            if (step.output) lines.push(`   ${step.output}`);
          }
          return Promise.resolve(lines.join('\n'));
        }
        return Promise.resolve(`⚠️ 未找到异常 ${anomalyId} 的修复记录`);
      }

      // 修复所有活跃异常
      const active = sr.getActiveAnomalies();
      if (active.length === 0) return Promise.resolve('✅ 无活跃异常需要修复');
      return Promise.resolve(`检测到 ${active.length} 个活跃异常，自动修复已触发。使用 self_repair_anomalies 查看状态。`);
    },
  },

  // ========== 世界模型 ==========

  {
    name: 'world_model_record',
    description: '记录状态转移 — Agent 观察行动与结果的关系，构建世界模型。',
    parameters: {
      stateFeatures: { type: 'string', description: '状态特征 JSON', required: true },
      actionId: { type: 'string', description: '动作 ID', required: true },
      actionName: { type: 'string', description: '动作名称' },
      nextStateFeatures: { type: 'string', description: '下一状态特征 JSON', required: true },
      reward: { type: 'number', description: '奖励值', required: true },
      done: { type: 'boolean', description: '是否终止' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const wm = getWorldModel();
      const stateFeatures = JSON.parse(args.stateFeatures as string);
      const nextStateFeatures = JSON.parse(args.nextStateFeatures as string);
      const fromState = wm.encodeState(stateFeatures, '起始状态');
      const action = {
        id: args.actionId as string,
        name: (args.actionName as string) ?? (args.actionId as string),
      };
      const toState = wm.encodeState(nextStateFeatures, '结果状态');
      wm.recordTransition(fromState, action, toState, args.reward as number, (args.done as boolean) ?? false);
      return Promise.resolve(`✅ 状态转移已记录\n- 动作: ${action.name}\n- 奖励: ${args.reward}`);
    },
  },

  {
    name: 'world_model_predict',
    description: '预测行动后果 — 基于世界模型预测行动后的状态和奖励。',
    parameters: {
      stateFeatures: { type: 'string', description: '当前状态特征 JSON', required: true },
      actionId: { type: 'string', description: '动作 ID', required: true },
      actionName: { type: 'string', description: '动作名称' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const wm = getWorldModel();
      const stateFeatures = JSON.parse(args.stateFeatures as string);
      const state = wm.encodeState(stateFeatures, '当前状态');
      const action = {
        id: args.actionId as string,
        name: (args.actionName as string) ?? (args.actionId as string),
      };
      const prediction = wm.predict(state, action);
      const lines = [
        '## 世界模型预测',
        `- 预测奖励: ${prediction.predictedReward.toFixed(3)}`,
        `- 置信度: ${(prediction.confidence * 100).toFixed(0)}%`,
        '',
        '## 特征变化预测',
      ];
      for (const [key, change] of Object.entries(prediction.featureChanges)) {
        lines.push(`- ${key}: ${change.from.toFixed(2)} → ${change.to.toFixed(2)} (${change.change > 0 ? '+' : ''}${change.change.toFixed(2)})`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'world_model_plan',
    description: '规划最优行动序列 — 通过蒙特卡洛模拟多个未来，选择期望奖励最高的行动序列。',
    parameters: {
      stateFeatures: { type: 'string', description: '当前状态特征 JSON', required: true },
      actions: { type: 'string', description: '可用动作 JSON 数组: [{id, name}, ...]', required: true },
      depth: { type: 'number', description: '规划深度（步数），默认 5' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const wm = getWorldModel();
      const stateFeatures = JSON.parse(args.stateFeatures as string);
      const state = wm.encodeState(stateFeatures, '规划起点');
      const actions = JSON.parse(args.actions as string);
      const plan = wm.plan(state, actions, (args.depth as number) ?? 5);
      const lines = [
        '## 世界模型规划结果',
        `- 预期总奖励: ${plan.expectedTotalReward.toFixed(3)}`,
        `- 风险等级: ${plan.risk}`,
        `- 规划深度: ${plan.depth}`,
        '',
        '## 推荐行动序列',
      ];
      for (let i = 0; i < plan.actions.length; i++) {
        lines.push(`${i + 1}. ${plan.actions[i].name} → 预期状态: ${JSON.stringify(plan.predictedStates[i]?.features ?? {}).substring(0, 80)}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'world_model_counterfactual',
    description: '反事实推理 — "如果采取不同行动会怎样？" 对比实际行动与假设行动的结果差异。',
    parameters: {
      stateFeatures: { type: 'string', description: '起始状态特征 JSON', required: true },
      actualActionId: { type: 'string', description: '实际行动 ID', required: true },
      actualActionName: { type: 'string', description: '实际行动名称' },
      actualNextStateFeatures: { type: 'string', description: '实际结果状态 JSON', required: true },
      actualReward: { type: 'number', description: '实际奖励', required: true },
      hypotheticalActionId: { type: 'string', description: '假设行动 ID', required: true },
      hypotheticalActionName: { type: 'string', description: '假设行动名称' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const wm = getWorldModel();
      const stateFeatures = JSON.parse(args.stateFeatures as string);
      const actualNextFeatures = JSON.parse(args.actualNextStateFeatures as string);
      const state = wm.encodeState(stateFeatures, '起始状态');
      const actualAction = { id: args.actualActionId as string, name: (args.actualActionName as string) ?? (args.actualActionId as string) };
      const actualNextState = wm.encodeState(actualNextFeatures, '实际结果');
      const hypoAction = { id: args.hypotheticalActionId as string, name: (args.hypotheticalActionName as string) ?? (args.hypotheticalActionId as string) };
      const result = wm.counterfactual(state, actualAction, actualNextState, args.actualReward as number, hypoAction);
      const lines = [
        '## 反事实推理结果',
        '',
        '### 实际结果',
        `- 奖励: ${result.actual.reward}`,
        '',
        '### 假设结果',
        `- 预测奖励: ${result.hypothetical.reward.toFixed(3)}`,
        '',
        '### 差异分析',
        `- 奖励差异: ${result.difference.rewardDelta > 0 ? '+' : ''}${result.difference.rewardDelta.toFixed(3)}`,
        '',
        '### 因果推断',
        result.causalInference,
      ];
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'world_model_stats',
    description: '查看世界模型统计 — 转移记录数、状态空间大小、模型置信度。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const wm = getWorldModel();
      const stats = wm.getStats();
      return Promise.resolve([
        '## 世界模型统计',
        `- 总转移记录: ${stats.totalTransitions}`,
        `- 唯一状态: ${stats.uniqueStates}`,
        `- 唯一动作: ${stats.uniqueActions}`,
        `- 转移模型大小: ${stats.transitionModelSize}`,
        `- 奖励模型大小: ${stats.rewardModelSize}`,
        `- 平均置信度: ${(stats.avgConfidence * 100).toFixed(1)}%`,
      ].join('\n'));
    },
  },

  // ========== 漏洞检测与修复 ==========

  {
    name: 'vuln_scan_file',
    description: '扫描单个文件的安全漏洞 — 检测 SQL注入/XSS/命令注入/路径遍历/硬编码密钥等 14 类漏洞。',
    parameters: {
      filePath: { type: 'string', description: '文件路径', required: true },
    },
    readOnly: true,
    execute: async (args: Record<string, unknown>) => {
      const scanner = getVulnScanner();
      const vulns = await scanner.scanFile(args.filePath as string);
      if (vulns.length === 0) return `✅ 文件 ${args.filePath} 未发现漏洞`;
      const lines = [`## 发现 ${vulns.length} 个漏洞`, ''];
      for (const v of vulns) {
        const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', info: 'ℹ️' }[v.severity];
        lines.push(`${severityEmoji} ${v.title} (${v.severity})`);
        lines.push(`   文件: ${v.filePath}:${v.line ?? '?'}`);
        if (v.codeSnippet) lines.push(`   代码: ${v.codeSnippet.substring(0, 80)}`);
        lines.push(`   修复: ${v.fixSuggestion}`);
        lines.push(`   自动修复: ${v.autoFixable ? '✅' : '❌'}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  },

  {
    name: 'vuln_scan_directory',
    description: '扫描整个目录的安全漏洞 — 递归扫描所有代码文件，生成完整漏洞报告和安全评分。',
    parameters: {
      dirPath: { type: 'string', description: '目录路径', required: true },
      extensions: { type: 'string', description: '文件扩展名逗号分隔，默认 .ts,.js,.tsx,.jsx,.json' },
      exclude: { type: 'string', description: '排除目录逗号分隔，默认 node_modules,.git,dist,build' },
    },
    readOnly: true,
    execute: async (args: Record<string, unknown>) => {
      const scanner = getVulnScanner();
      const result = await scanner.scanDirectory(args.dirPath as string, {
        extensions: (args.extensions as string)?.split(','),
        exclude: (args.exclude as string)?.split(','),
      });
      const lines = [
        '# 目录安全扫描报告',
        '',
        `## 扫描概览`,
        `- 扫描文件: ${result.filesScanned}`,
        `- 扫描行数: ${result.linesScanned}`,
        `- 耗时: ${result.durationMs}ms`,
        `- 发现漏洞: ${result.vulnerabilities.length}`,
        `- 安全评分: ${result.securityScore}/100`,
        '',
        '## 漏洞严重程度分布',
        `- 🔴 严重: ${result.severityStats.critical}`,
        `- 🟠 高危: ${result.severityStats.high}`,
        `- 🟡 中危: ${result.severityStats.medium}`,
        `- 🟢 低危: ${result.severityStats.low}`,
        `- ℹ️ 信息: ${result.severityStats.info}`,
        '',
        '## 漏洞类型分布',
      ];
      for (const [type, count] of Object.entries(result.typeStats)) {
        lines.push(`- ${type}: ${count}`);
      }
      if (result.vulnerabilities.length > 0) {
        lines.push('', '## 前 10 个漏洞');
        for (const v of result.vulnerabilities.slice(0, 10)) {
          const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', info: 'ℹ️' }[v.severity];
          lines.push(`${severityEmoji} ${v.title} — ${v.filePath}:${v.line ?? '?'}`);
        }
      }
      return lines.join('\n');
    },
  },

  {
    name: 'vuln_scan_dependencies',
    description: '扫描依赖漏洞 — 检测 package.json 中的已知漏洞依赖（CVE）。',
    parameters: {
      packageJsonPath: { type: 'string', description: 'package.json 路径（可选，默认当前目录）' },
    },
    readOnly: true,
    execute: async (args: Record<string, unknown>) => {
      const scanner = getVulnScanner();
      const vulns = await scanner.scanDependencies(args.packageJsonPath as string | undefined);
      if (vulns.length === 0) return '✅ 未发现依赖漏洞';
      const lines = [`## 发现 ${vulns.length} 个依赖漏洞`, ''];
      for (const v of vulns) {
        const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', info: 'ℹ️' }[v.severity];
        lines.push(`${severityEmoji} ${v.title}`);
        lines.push(`   ${v.description}`);
        lines.push(`   修复: ${v.fixSuggestion}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  },

  {
    name: 'vuln_scan_config',
    description: '扫描配置文件漏洞 — 检测 .env/config 文件中的明文密码、调试模式等安全问题。',
    parameters: {},
    readOnly: true,
    execute: async () => {
      const scanner = getVulnScanner();
      const vulns = await scanner.scanConfig();
      if (vulns.length === 0) return '✅ 未发现配置漏洞';
      const lines = [`## 发现 ${vulns.length} 个配置漏洞`, ''];
      for (const v of vulns) {
        const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', info: 'ℹ️' }[v.severity];
        lines.push(`${severityEmoji} ${v.title} — ${v.filePath}`);
        lines.push(`   ${v.description}`);
        lines.push(`   修复: ${v.fixSuggestion}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  },

  {
    name: 'vuln_fix',
    description: '修复漏洞 — 对指定漏洞执行自动修复。支持 XSS/硬编码密钥/信息泄露等可自动修复的漏洞。',
    parameters: {
      vulnerabilityId: { type: 'string', description: '漏洞 ID', required: true },
    },
    readOnly: false,
    execute: async (args: Record<string, unknown>) => {
      const scanner = getVulnScanner();
      const record = await scanner.fixVulnerability(args.vulnerabilityId as string);
      if (!record) return `⚠️ 无法修复漏洞 ${args.vulnerabilityId}（可能不可自动修复）`;
      return [
        '## 修复结果',
        `- 成功: ${record.success ? '✅' : '❌'}`,
        `- 验证: ${record.verificationPassed ? '✅' : '❌'}`,
        `- 描述: ${record.description}`,
        `- 修复前: ${record.beforeCode.substring(0, 80)}`,
        `- 修复后: ${record.afterCode.substring(0, 80)}`,
      ].join('\n');
    },
  },

  {
    name: 'vuln_fix_all',
    description: '批量修复所有可自动修复的漏洞 — 一次性修复所有 autoFixable=true 的漏洞。',
    parameters: {},
    readOnly: false,
    execute: async () => {
      const scanner = getVulnScanner();
      const result = await scanner.fixAll(true);
      return [
        '## 批量修复结果',
        `- 待修复: ${result.total}`,
        `- 已修复: ${result.fixed}`,
        `- 失败: ${result.failed}`,
      ].join('\n');
    },
  },

  {
    name: 'vuln_list',
    description: '查看漏洞列表 — 按严重程度排序，支持按状态/类型/严重程度过滤。',
    parameters: {
      status: { type: 'string', description: '状态过滤: open/fixing/fixed/ignored' },
      severity: { type: 'string', description: '严重程度过滤: critical/high/medium/low/info' },
      type: { type: 'string', description: '类型过滤' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const scanner = getVulnScanner();
      const vulns = scanner.getVulnerabilities({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: args.status as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        severity: args.severity as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: args.type as any,
      });
      if (vulns.length === 0) return Promise.resolve('✅ 无漏洞记录');
      const lines = [`## 漏洞列表 (${vulns.length})`, ''];
      for (const v of vulns.slice(0, 30)) {
        const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', info: 'ℹ️' }[v.severity];
        const statusEmoji = { open: '⚠️', fixing: '🔄', fixed: '✅', ignored: '🚫' }[v.status];
        lines.push(`${severityEmoji} ${statusEmoji} ${v.id} — ${v.title}`);
        lines.push(`   ${v.filePath}:${v.line ?? '?'} | ${v.type} | ${v.severity}`);
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'vuln_audit_report',
    description: '生成安全审计报告 — 完整的安全审计 Markdown 报告，包含漏洞概览、详情、修复建议。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const scanner = getVulnScanner();
      return Promise.resolve(scanner.generateAuditReport());
    },
  },

  // ========== 代码质量分析 ==========

  {
    name: 'quality_analyze_file',
    description: '分析单个文件的代码质量 — 圈复杂度/认知复杂度/维护性指数/代码异味/质量评分。',
    parameters: {
      filePath: { type: 'string', description: '文件路径', required: true },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const analyzer = getQualityAnalyzer();
      const report = analyzer.analyzeFile(args.filePath as string);
      const lines = [
        '## 代码质量分析报告',
        '',
        `**文件**: ${args.filePath}`,
        '',
        `| 指标 | 值 |`,
        `|------|-----|`,
        `| 代码行数 | ${report.linesOfCode} |`,
        `| 圈复杂度 | ${report.cyclomaticComplexity} |`,
        `| 认知复杂度 | ${report.cognitiveComplexity} |`,
        `| 维护性指数 | ${report.maintainabilityIndex.toFixed(1)}/100 |`,
        `| 质量评分 | ${report.qualityScore.toFixed(1)}/100 |`,
        `| 代码异味 | ${report.codeSmells.length} |`,
        `| 函数数 | ${report.functions.length} |`,
        '',
      ];
      if (report.codeSmells.length > 0) {
        lines.push('## 代码异味', '');
        for (const smell of report.codeSmells.slice(0, 15)) {
          const emoji = { critical: '🔴', major: '🟠', minor: '🟡', info: 'ℹ️' }[smell.severity];
          lines.push(`${emoji} ${smell.type}: ${smell.description} (行 ${smell.line})`);
          lines.push(`   建议: ${smell.suggestion}`);
        }
      }
      if (report.functions.length > 0) {
        lines.push('', '## 函数复杂度', '');
        lines.push(`| 函数 | 圈复杂度 | 认知复杂度 | 行数 | 参数数 | 嵌套 |`);
        lines.push(`|------|---------|---------|------|--------|------|`);
        for (const func of report.functions.slice(0, 10)) {
          lines.push(`| ${func.name} | ${func.cyclomaticComplexity} | ${func.cognitiveComplexity} | ${func.linesOfCode} | ${func.parameterCount} | ${func.nestingDepth} |`);
        }
      }
      return Promise.resolve(lines.join('\n'));
    },
  },

  {
    name: 'quality_analyze_directory',
    description: '分析整个目录的代码质量 — 递归扫描，生成完整质量报告（复杂度/重复代码/代码异味/质量评分）。',
    parameters: {
      dirPath: { type: 'string', description: '目录路径', required: true },
      extensions: { type: 'string', description: '文件扩展名逗号分隔' },
      exclude: { type: 'string', description: '排除目录逗号分隔' },
    },
    readOnly: true,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const analyzer = getQualityAnalyzer();
      const report = analyzer.analyzeDirectory(args.dirPath as string, {
        extensions: (args.extensions as string)?.split(','),
        exclude: (args.exclude as string)?.split(','),
      });
      return Promise.resolve(analyzer.generateQualityReport(report));
    },
  },

  // ========== 性能分析 ==========

  {
    name: 'perf_measure',
    description: '测量函数性能 — 自动测量执行时间、内存变化、CPU 时间。',
    parameters: {
      name: { type: 'string', description: '测量名称', required: true },
      code: { type: 'string', description: '要执行的代码（eval）', required: true },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const profiler = getPerfProfiler();
      const name = args.name as string;
      const code = args.code as string;
      const result = profiler.measureSync(name, () => {
        try {
          // eslint-disable-next-line no-eval
          return eval(code);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error: ${msg}`;
        }
      });
      return Promise.resolve([
        '## 性能测量结果',
        `- 名称: ${name}`,
        `- 执行时间: ${result.measurement.durationMs.toFixed(2)}ms`,
        `- 内存变化: ${(result.measurement.memoryDelta / 1024).toFixed(2)}KB`,
        `- CPU 时间: ${result.measurement.cpuTimeMs.toFixed(2)}ms`,
        `- 是否瓶颈: ${result.measurement.isBottleneck ? '⚠️ 是' : '✅ 否'}`,
      ].join('\n'));
    },
  },

  {
    name: 'perf_report',
    description: '生成性能分析报告 — 性能瓶颈/最慢函数/内存趋势/性能基准。',
    parameters: {},
    readOnly: true,
    execute: (): Promise<string> => {
      const profiler = getPerfProfiler();
      return Promise.resolve(profiler.generateReportMarkdown());
    },
  },

  {
    name: 'perf_memory_monitor',
    description: '控制内存监控 — 启动/停止内存监控，定期采集内存快照用于泄漏检测。',
    parameters: {
      action: { type: 'string', description: '操作: start/stop/snapshot', required: true },
      intervalMs: { type: 'number', description: '监控间隔（ms），默认 5000' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const profiler = getPerfProfiler();
      const action = args.action as string;
      switch (action) {
        case 'start':
          profiler.startMemoryMonitoring((args.intervalMs as number) ?? 5000);
          return Promise.resolve(`✅ 内存监控已启动（间隔: ${(args.intervalMs as number) ?? 5000}ms）`);
        case 'stop':
          profiler.stopMemoryMonitoring();
          return Promise.resolve('✅ 内存监控已停止');
        case 'snapshot': {
          const snapshot = profiler.takeMemorySnapshot();
          return Promise.resolve([
            '## 内存快照',
            `- RSS: ${(snapshot.rss / 1024 / 1024).toFixed(1)}MB`,
            `- 堆总量: ${(snapshot.heapTotal / 1024 / 1024).toFixed(1)}MB`,
            `- 堆使用: ${(snapshot.heapUsed / 1024 / 1024).toFixed(1)}MB`,
            `- 外部内存: ${(snapshot.external / 1024 / 1024).toFixed(1)}MB`,
          ].join('\n'));
        }
        default:
          return Promise.resolve(`⚠️ 未知操作: ${action}`);
      }
    },
  },

  // ========== 自动测试生成 ==========

  {
    name: 'test_generate_file',
    description: '为单个文件自动生成单元测试 — 基于函数分析生成边界值/正常/异常/极端值测试用例。',
    parameters: {
      filePath: { type: 'string', description: '源文件路径', required: true },
      outputDir: { type: 'string', description: '输出目录（默认 __tests__）' },
      onlyExported: { type: 'boolean', description: '仅为导出函数生成测试，默认 true' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const gen = getTestGenerator();
      const result = gen.generateTestFile(args.filePath as string, {
        outputDir: args.outputDir as string | undefined,
        onlyExported: (args.onlyExported as boolean) ?? true,
      });
      return Promise.resolve([
        '✅ 测试文件已生成',
        `- 测试文件: ${result.testFilePath}`,
        `- 测试框架: ${result.framework}`,
        `- 测试用例数: ${result.testCaseCount}`,
        `- 覆盖函数: ${result.coveredFunctions.join(', ')}`,
        `- 需要 Mock: ${result.mocks.length > 0 ? result.mocks.join(', ') : '无'}`,
      ].join('\n'));
    },
  },

  {
    name: 'test_generate_directory',
    description: '为整个目录自动生成单元测试 — 批量扫描源文件，生成测试文件和覆盖率报告。',
    parameters: {
      dirPath: { type: 'string', description: '源代码目录', required: true },
      outputDir: { type: 'string', description: '输出目录' },
      exclude: { type: 'string', description: '排除目录逗号分隔' },
    },
    readOnly: false,
    execute: (args: Record<string, unknown>): Promise<string> => {
      const gen = getTestGenerator();
      const report = gen.generateTestsForDirectory(args.dirPath as string, {
        outputDir: args.outputDir as string | undefined,
        exclude: (args.exclude as string)?.split(','),
      });
      return Promise.resolve(gen.generateReportMarkdown(report));
    },
  },
];
