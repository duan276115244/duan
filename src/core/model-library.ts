/**
 * 统一模型库 - ModelLibrary
 *
 * 核心能力：
 * 1. 动态配置API Key（运行时增删改查，持久化到config.json）
 * 2. Auto模式：根据用户提问自动匹配最佳模型
 * 3. 模型能力画像：每个模型有明确的能力标签
 * 4. 智能路由：基于任务类型、模型能力、历史表现自动选择
 * 5. 降级回退：主模型失败自动切换备用模型
 * 6. 性能追踪：记录每个模型的响应时间、成功率、质量评分
 */

import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedConfigManager } from './unified-config.js';
import { EventBus } from './event-bus.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 模型能力标签 */
export type ModelCapability =
  | 'coding'        // 代码生成/调试
  | 'reasoning'     // 深度推理/逻辑分析
  | 'creative'      // 创意写作/发散思维
  | 'analysis'      // 数据分析/结构化思考
  | 'conversation'  // 对话/问答
  | 'translation'   // 翻译
  | 'math'          // 数学计算
  | 'vision'        // 图像理解
  | 'tool_use'      // 工具调用/函数调用
  | 'long_context'  // 长上下文处理
  | 'fast';         // 快速响应

/** 模型配置 */
export interface ModelEntry {
  id: string;                    // 唯一标识，如 'deepseek-chat'
  name: string;                  // 显示名称
  provider: 'openai_compatible' | 'anthropic' | 'ollama';
  model: string;                 // 模型ID
  apiKey?: string;               // API Key（可动态配置）
  baseURL?: string;              // API Base URL
  maxTokens: number;
  temperature?: number;
  enabled: boolean;
  capabilities: ModelCapability[];
  costPer1kTokens?: number;      // 每千token成本（美元）
  avgLatency?: number;           // 平均延迟（ms）
  priority: number;              // 优先级 1-10，越高越优先
}

/** 模型性能记录 */
interface ModelPerformance {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalLatency: number;
  totalTokens: number;
  qualityScores: number[];       // 最近N次的质量评分
  lastUsed: number;
  lastError?: string;
}

/** 任务分析结果 */
export interface TaskAnalysis {
  taskType: ModelCapability[];
  complexity: 'simple' | 'medium' | 'complex';
  requiresToolUse: boolean;
  requiresLongContext: boolean;
  estimatedTokens: number;
  keywords: string[];
}

/** 模型选择结果 */
export interface ModelSelection {
  model: ModelEntry;
  reason: string;
  alternatives: ModelEntry[];
}

/** 统一调用结果 */
export interface UnifiedModelResponse {
  content: string;
  modelId: string;
  provider: string;
  tokens: number;
  latency: number;
  quality: number;               // 自动评估的质量分数 0-1
  toolCalls?: unknown[];         // 模型返回的工具调用（可选）
}

// ============ 内置模型库 ============

const BUILTIN_MODELS: ModelEntry[] = [
  // ===== DeepSeek =====
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'openai_compatible',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'math', 'fast'],
    costPer1kTokens: 0.0014,
    priority: 8,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    provider: 'openai_compatible',
    model: 'deepseek-reasoner',
    baseURL: 'https://api.deepseek.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['reasoning', 'math', 'analysis', 'coding'],
    costPer1kTokens: 0.004,
    priority: 7,
  },
  // ===== OpenRouter =====
  {
    id: 'openrouter-gpt4o-mini',
    name: 'GPT-4o Mini (OpenRouter)',
    provider: 'openai_compatible',
    model: 'openai/gpt-4o-mini',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use', 'fast', 'vision'],
    costPer1kTokens: 0.00015,
    priority: 6,
  },
  {
    id: 'openrouter-claude-sonnet',
    name: 'Claude Sonnet (OpenRouter)',
    provider: 'openai_compatible',
    model: 'anthropic/claude-3.5-sonnet',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'creative', 'analysis', 'tool_use', 'long_context', 'vision'],
    costPer1kTokens: 0.003,
    priority: 5,
  },
  // ===== Anthropic Direct =====
  {
    id: 'anthropic-claude',
    name: 'Claude Sonnet (Direct)',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    // P2-4: 补标 vision — Claude 3.5 Sonnet 实际支持视觉输入，
    // 之前漏标导致 Auto 模式不会选它处理图片任务。
    capabilities: ['coding', 'reasoning', 'creative', 'analysis', 'tool_use', 'long_context', 'vision'],
    costPer1kTokens: 0.003,
    priority: 9,
  },
  // ===== OpenAI Direct =====
  {
    id: 'openai-gpt4o',
    name: 'GPT-4o',
    provider: 'openai_compatible',
    model: 'gpt-4o',
    baseURL: 'https://api.openai.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'creative', 'analysis', 'conversation', 'tool_use', 'vision', 'long_context'],
    costPer1kTokens: 0.01,
    priority: 9,
  },
  {
    id: 'openai-gpt4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai_compatible',
    model: 'gpt-4o-mini',
    baseURL: 'https://api.openai.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use', 'fast', 'vision'],
    costPer1kTokens: 0.00015,
    priority: 7,
  },
  // ===== Google Gemini (via OpenAI-compatible proxy) =====
  {
    id: 'google-gemini-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'openai_compatible',
    model: 'gemini-2.0-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'fast', 'vision', 'long_context'],
    costPer1kTokens: 0.0001,
    priority: 7,
  },
  {
    id: 'google-gemini-pro',
    name: 'Gemini 2.0 Pro',
    provider: 'openai_compatible',
    model: 'gemini-2.0-pro',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'creative', 'long_context', 'tool_use', 'vision'],
    costPer1kTokens: 0.0005,
    priority: 6,
  },
  // ===== Moonshot (月之暗面) =====
  {
    id: 'moonshot-v1',
    name: 'Moonshot v1 (月之暗面)',
    provider: 'openai_compatible',
    model: 'moonshot-v1-8k',
    baseURL: 'https://api.moonshot.cn/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'long_context'],
    costPer1kTokens: 0.0012,
    priority: 5,
  },
  // ===== Zhipu (智谱) =====
  {
    id: 'zhipu-glm4',
    name: 'GLM-4-Plus (智谱)',
    provider: 'openai_compatible',
    model: 'glm-4-plus',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use'],
    costPer1kTokens: 0.001,
    priority: 5,
  },
  // ===== Aliyun (阿里通义千问) =====
  {
    id: 'aliyun-qwen',
    name: 'Qwen Max (阿里通义千问)',
    provider: 'openai_compatible',
    model: 'qwen-max',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'creative', 'conversation', 'tool_use', 'long_context'],
    costPer1kTokens: 0.0008,
    priority: 5,
  },
  // ===== ByteDance (字节豆包) =====
  {
    id: 'bytedance-doubao',
    name: '豆包 Seed (火山引擎标准API)',
    provider: 'openai_compatible',
    model: 'doubao-seed-2.0-lite',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  // ===== ByteDance Coding Plan (火山引擎 Coding Plan 订阅制) =====
  {
    id: 'bytedance-doubao-coding',
    name: '豆包 Coding Plan (火山引擎订阅)',
    provider: 'openai_compatible',
    model: 'ark-code-latest',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'fast', 'tool_use'],
    costPer1kTokens: 0,
    priority: 5,
  },
  // ===== SiliconFlow =====
  {
    id: 'siliconflow-deepseek',
    name: 'DeepSeek V3 (SiliconFlow)',
    provider: 'openai_compatible',
    model: 'deepseek-ai/DeepSeek-V3',
    baseURL: 'https://api.siliconflow.cn/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'long_context'],
    costPer1kTokens: 0.0005,
    priority: 6,
  },
  // ===== MiniMax =====
  {
    id: 'minimax-text',
    name: 'MiniMax Text-01',
    provider: 'openai_compatible',
    model: 'minimax-text-01',
    baseURL: 'https://api.minimax.chat/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'long_context'],
    costPer1kTokens: 0.0005,
    priority: 4,
  },
  // ===== Groq =====
  {
    id: 'groq-llama',
    name: 'Llama 3.3 70B (Groq)',
    provider: 'openai_compatible',
    model: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'fast', 'tool_use'],
    costPer1kTokens: 0.0001,
    priority: 7,
  },
  // ===== Together AI =====
  {
    id: 'together-llama',
    name: 'Llama 3.3 70B (Together)',
    provider: 'openai_compatible',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    baseURL: 'https://api.together.xyz/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'long_context'],
    costPer1kTokens: 0.0009,
    priority: 5,
  },
  // ===== Fireworks =====
  {
    id: 'fireworks-llama',
    name: 'Llama 3.1 70B (Fireworks)',
    provider: 'openai_compatible',
    model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'fast'],
    costPer1kTokens: 0.0009,
    priority: 5,
  },
  // ===== Perplexity =====
  {
    id: 'perplexity-sonar',
    name: 'Sonar Pro (Perplexity)',
    provider: 'openai_compatible',
    model: 'sonar-pro',
    baseURL: 'https://api.perplexity.ai/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'long_context'],
    costPer1kTokens: 0.003,
    priority: 5,
  },
  // ===== xAI (Grok) =====
  {
    id: 'xai-grok',
    name: 'Grok 2 (xAI)',
    provider: 'openai_compatible',
    model: 'grok-2',
    baseURL: 'https://api.x.ai/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'long_context'],
    costPer1kTokens: 0.002,
    priority: 6,
  },
  // ===== Ollama (Local) =====
  {
    id: 'ollama-llama3',
    name: 'Llama 3 (Ollama 本地)',
    provider: 'ollama',
    model: 'llama3',
    baseURL: 'http://localhost:11434',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 3,
  },
  // ===== 免费模型（无需付费，有免费额度或完全免费） =====
  // ===== 阶跃星辰 (StepFun) =====
  {
    id: 'stepfun-step1-8k',
    name: 'Step-1 8K (阶跃星辰)',
    provider: 'openai_compatible',
    model: 'step-1-8k',
    baseURL: 'https://api.stepfun.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis'],
    costPer1kTokens: 0.002,
    priority: 5,
  },
  // ===== 百川智能 (Baichuan) =====
  {
    id: 'baichuan-baichuan4',
    name: 'Baichuan4 (百川智能)',
    provider: 'openai_compatible',
    model: 'Baichuan4',
    baseURL: 'https://api.baichuan-ai.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'tool_use'],
    costPer1kTokens: 0.002,
    priority: 5,
  },
  // ===== 零一万物 (Yi) =====
  {
    id: 'yi-lightning',
    name: 'Yi Lightning (零一万物)',
    provider: 'openai_compatible',
    model: 'yi-lightning',
    baseURL: 'https://api.lingyiwanwu.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'fast'],
    costPer1kTokens: 0.0005,
    priority: 6,
  },
  // ===== 商汤日日新 (SenseNova) =====
  {
    id: 'sensenova-sensenova5',
    name: 'SenseNova-5 (商汤日日新)',
    provider: 'openai_compatible',
    model: 'SenseNova-5',
    baseURL: 'https://api.sensenova.cn/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis'],
    costPer1kTokens: 0.002,
    priority: 5,
  },
  // ===== 百度文心 (Ernie) =====
  {
    id: 'ernie-4.0-8k',
    name: '文心一言 4.0 (百度)',
    provider: 'openai_compatible',
    model: 'ernie-4.0-8k',
    baseURL: 'https://qianfan.baidubce.com/v2',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'tool_use'],
    costPer1kTokens: 0.003,
    priority: 5,
  },
  {
    id: 'ernie-3.5-8k',
    name: '文心一言 3.5 (百度)',
    provider: 'openai_compatible',
    model: 'ernie-3.5-8k',
    baseURL: 'https://qianfan.baidubce.com/v2',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0.001,
    priority: 4,
  },
  // ===== 火山引擎 Agent Plan (订阅制) =====
  {
    id: 'bytedance-doubao-agent',
    name: '豆包 Agent Plan (火山引擎订阅)',
    provider: 'openai_compatible',
    model: 'doubao-agent-latest',
    baseURL: 'https://ark.cn-beijing.volces.com/api/agent/v3',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'tool_use'],
    costPer1kTokens: 0,
    priority: 5,
  },
  // ===== Mistral AI =====
  {
    id: 'mistral-small',
    name: 'Mistral Small (Mistral AI)',
    provider: 'openai_compatible',
    model: 'mistral-small-latest',
    baseURL: 'https://api.mistral.ai/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'fast', 'tool_use'],
    costPer1kTokens: 0.0002,
    priority: 6,
  },
  // ===== Cohere =====
  {
    id: 'cohere-command-r-plus',
    name: 'Command R+ (Cohere)',
    provider: 'openai_compatible',
    model: 'command-r-plus',
    baseURL: 'https://api.cohere.com/compatibility/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use', 'long_context'],
    costPer1kTokens: 0.003,
    priority: 5,
  },
  // ===== 免费模型（无需付费，有免费额度或完全免费） =====
  {
    id: 'openrouter-deepseek-free',
    name: 'DeepSeek Chat (OpenRouter 免费)',
    provider: 'openai_compatible',
    model: 'deepseek/deepseek-chat:free',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'math', 'fast'],
    costPer1kTokens: 0,
    priority: 9, // 免费且能力强，高优先级
  },
  {
    id: 'openrouter-deepseek-r1-free',
    name: 'DeepSeek R1 (OpenRouter 免费)',
    provider: 'openai_compatible',
    model: 'deepseek/deepseek-r1:free',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['reasoning', 'math', 'analysis', 'coding'],
    costPer1kTokens: 0,
    priority: 8,
  },
  {
    id: 'openrouter-llama-free',
    name: 'Llama 3.3 70B (OpenRouter 免费)',
    provider: 'openai_compatible',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use', 'fast'],
    costPer1kTokens: 0,
    priority: 7,
  },
  {
    id: 'openrouter-qwen-free',
    name: 'Qwen 2 7B (OpenRouter 免费)',
    provider: 'openai_compatible',
    model: 'qwen/qwen-2-7b-instruct:free',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  {
    id: 'openrouter-phi4-free',
    name: 'Phi-4 (OpenRouter 免费)',
    provider: 'openai_compatible',
    model: 'microsoft/phi-4:free',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  {
    id: 'siliconflow-deepseek-free',
    name: 'DeepSeek V3 (SiliconFlow 免费)',
    provider: 'openai_compatible',
    model: 'deepseek-ai/DeepSeek-V3',
    baseURL: 'https://api.siliconflow.cn/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'math', 'fast'],
    costPer1kTokens: 0,
    priority: 8,
  },
  {
    id: 'siliconflow-qwen-free',
    name: 'Qwen 2.5 7B (SiliconFlow 免费)',
    provider: 'openai_compatible',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    baseURL: 'https://api.siliconflow.cn/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  {
    id: 'groq-llama-free',
    name: 'Llama 3.3 70B (Groq 免费)',
    provider: 'openai_compatible',
    model: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use', 'fast'],
    costPer1kTokens: 0,
    priority: 7,
  },
  {
    id: 'google-gemini-flash-free',
    name: 'Gemini 2.0 Flash (Google 免费)',
    provider: 'openai_compatible',
    model: 'gemini-2.0-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'fast'],
    costPer1kTokens: 0,
    priority: 7,
  },
  // ===== Agnes AI =====
  {
    id: 'agnes-flash',
    name: 'Agnes 2.0 Flash',
    provider: 'openai_compatible',
    model: 'agnes-2.0-flash',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'fast'],
    costPer1kTokens: 0,
    priority: 8,
  },
  // ===== 国内免费/低价模型补充 =====
  {
    id: 'aliyun-qwen-turbo',
    name: 'Qwen Turbo (通义千问免费)',
    provider: 'openai_compatible',
    model: 'qwen-turbo',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 7,
  },
  {
    id: 'aliyun-qwen-plus',
    name: 'Qwen Plus (通义千问)',
    provider: 'openai_compatible',
    model: 'qwen-plus',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use'],
    costPer1kTokens: 0.0004,
    priority: 6,
  },
  {
    id: 'aliyun-qwen-long',
    name: 'Qwen Long (通义千问长文本)',
    provider: 'openai_compatible',
    model: 'qwen-long',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    maxTokens: 32768,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'long_context', 'analysis'],
    costPer1kTokens: 0.0002,
    priority: 5,
  },
  {
    id: 'aliyun-qwq',
    name: 'QwQ 32B (通义推理模型)',
    provider: 'openai_compatible',
    model: 'qwq-32b',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['reasoning', 'math', 'analysis', 'coding'],
    costPer1kTokens: 0.0006,
    priority: 6,
  },
  {
    id: 'zhipu-glm4-flash',
    name: 'GLM-4 Flash (智谱免费)',
    provider: 'openai_compatible',
    model: 'glm-4-flash',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 7,
  },
  {
    id: 'zhipu-glm4-air',
    name: 'GLM-4 Air (智谱)',
    provider: 'openai_compatible',
    model: 'glm-4-air',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use'],
    costPer1kTokens: 0.0005,
    priority: 5,
  },
  {
    id: 'zhipu-glm4-plus',
    name: 'GLM-4-Plus (智谱)',
    provider: 'openai_compatible',
    model: 'glm-4-plus',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 128000,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use', 'math'],
    costPer1kTokens: 0.002,
    priority: 8,
  },
  {
    id: 'zhipu-glm4-flash',
    name: 'GLM-4-Flash (智谱免费)',
    provider: 'openai_compatible',
    model: 'glm-4-flash',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 128000,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'tool_use'],
    costPer1kTokens: 0,
    priority: 9,
  },
  {
    id: 'zhipu-glm4v-flash',
    name: 'GLM-4V Flash (智谱视觉免费)',
    provider: 'openai_compatible',
    model: 'glm-4v-flash',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'vision', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  {
    id: 'moonshot-v1-32k',
    name: 'Moonshot v1 32K (月之暗面)',
    provider: 'openai_compatible',
    model: 'moonshot-v1-32k',
    baseURL: 'https://api.moonshot.cn/v1',
    maxTokens: 32768,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'long_context', 'analysis'],
    costPer1kTokens: 0.0012,
    priority: 5,
  },
  {
    id: 'moonshot-v1-128k',
    name: 'Moonshot v1 128K (月之暗面)',
    provider: 'openai_compatible',
    model: 'moonshot-v1-128k',
    baseURL: 'https://api.moonshot.cn/v1',
    maxTokens: 131072,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'long_context', 'analysis'],
    costPer1kTokens: 0.0024,
    priority: 5,
  },
  {
    id: 'siliconflow-deepseek-r1-free',
    name: 'DeepSeek R1 (SiliconFlow 免费)',
    provider: 'openai_compatible',
    model: 'deepseek-ai/DeepSeek-R1',
    baseURL: 'https://api.siliconflow.cn/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['reasoning', 'math', 'analysis', 'coding'],
    costPer1kTokens: 0,
    priority: 8,
  },
  {
    id: 'siliconflow-qwen-72b',
    name: 'Qwen 2.5 72B (SiliconFlow)',
    provider: 'openai_compatible',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    baseURL: 'https://api.siliconflow.cn/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'analysis', 'conversation', 'tool_use'],
    costPer1kTokens: 0.001,
    priority: 6,
  },
  {
    id: 'siliconflow-glm4-free',
    name: 'GLM-4 9B (SiliconFlow 免费)',
    provider: 'openai_compatible',
    model: 'THUDM/glm-4-9b-chat',
    baseURL: 'https://api.siliconflow.cn/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  {
    id: 'groq-mixtral-free',
    name: 'Mixtral 8x7B (Groq 免费)',
    provider: 'openai_compatible',
    model: 'mixtral-8x7b-32768',
    baseURL: 'https://api.groq.com/openai/v1',
    maxTokens: 32768,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'reasoning', 'conversation', 'long_context', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
  {
    id: 'groq-gemma-free',
    name: 'Gemma 2 9B (Groq 免费)',
    provider: 'openai_compatible',
    model: 'gemma2-9b-it',
    baseURL: 'https://api.groq.com/openai/v1',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 5,
  },
  {
    id: 'openrouter-gemma-free',
    name: 'Gemma 2 9B (OpenRouter 免费)',
    provider: 'openai_compatible',
    model: 'google/gemma-2-9b-it:free',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 5,
  },
  {
    id: 'google-gemini-flash-lite-free',
    name: 'Gemini 2.0 Flash Lite (Google 免费)',
    provider: 'openai_compatible',
    model: 'gemini-2.0-flash-lite',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    maxTokens: 8192,
    temperature: 0.7,
    enabled: true,
    capabilities: ['coding', 'conversation', 'fast'],
    costPer1kTokens: 0,
    priority: 6,
  },
];

// ============ 主类 ============

export class ModelLibrary {
  private models: Map<string, ModelEntry> = new Map();
  private performance: Map<string, ModelPerformance> = new Map();
  private clients: Map<string, OpenAI | Anthropic> = new Map();
  /**
   * P0 真实修复：客户端最后使用时间戳（用于 LRU 淘汰）
   *
   * 原先 clients Map 无大小限制，长时间运行可能积累过多客户端实例，
   * 每个客户端持有 HTTP 连接池和底层 socket，存在内存泄漏和文件描述符耗尽风险。
   * 现在限制最大客户端数，超限时淘汰最久未使用的客户端。
   */
  private clientLastUsed: Map<string, number> = new Map();
  private readonly MAX_CLIENTS = 20;
  private configPath: string;

  /**
   * 进程级单例实例。
   *
   * 背景：原先 ModelLibrary 在 DI 容器中注册为 `transient`，且 context-compressor /
   * super-reasoning-engine / llm-caller / self-evolution-engine / nlu-engine /
   * skill-registry 等多个模块直接 `new ModelLibrary()`，导致运行期存在多个独立实例。
   * 即便已修懒初始化，多实例仍会各自维护独立的 clients Map 与 LRU 状态，无法共享
   * 客户端缓存，造成连接池/内存翻倍并使淘汰日志跨实例重复。
   *
   * 约定：生产代码统一通过 `ModelLibrary.getInstance()` 获取共享实例；测试与
   * functional-test-suite 等需要隔离的场景仍可使用 `new ModelLibrary()` 显式构造。
   */
  private static instance: ModelLibrary | null = null;

  /**
   * 获取进程级单例。
   * @param configPath 仅在首次构造时生效，后续调用忽略此参数。
   */
  static getInstance(configPath?: string): ModelLibrary {
    if (!ModelLibrary.instance) {
      ModelLibrary.instance = new ModelLibrary(configPath);
    }
    return ModelLibrary.instance;
  }

  /** 仅供测试/隔离场景使用：重置单例（生产代码勿调用） */
  static __resetInstanceForTests(): void {
    ModelLibrary.instance = null;
  }

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(process.cwd(), 'config.json');
    this.loadFromEnv();
    this.loadFromUnifiedConfig();
    this.loadFromConfig();
    // 客户端改为按需懒初始化（见 callModel / streamChatWithTools / streamCall），
    // 不再在构造时为所有模型预创建客户端，避免启动时触发 LRU 淘汰级联。

    // P0 供应商热切换：监听 UnifiedConfigManager 的外部配置变更事件，
    // config.json 被 main.js（config:unified:active:set / model:switch）写入后，
    // 自动重新加载 apiKey 到内存并清理已缓存的客户端（下次 call 时按需重建）。
    try {
      EventBus.getInstance().on('config.external.changed', () => {
        this.reloadFromUnifiedConfig();
      });
    } catch {
      // EventBus 不可用时静默降级（不影响核心功能）
    }
  }

  /**
   * 从统一配置重新加载 apiKey（供应商热切换时调用）。
   * 清理已缓存的客户端，下次 callModel 时会用新 apiKey 懒初始化。
   */
  reloadFromUnifiedConfig(): void {
    this.loadFromUnifiedConfig();
    // 清理已缓存的客户端（旧 apiKey 失效），下次调用时按需重建
    const cleared = this.clients.size;
    this.clients.clear();
    if (cleared > 0) {
      // 使用 console.info 而非 logger，避免循环依赖（logger 可能依赖 ModelLibrary）
      console.info(`[ModelLibrary] 供应商切换：已清理 ${cleared} 个缓存客户端，下次调用将用新 apiKey 重建`);
    }
  }

  // ========== 客户端访问（类型安全，替代外部 `as any` 取 clients 私有字段） ==========

  /**
   * 按 modelId 获取已初始化的客户端（不触发懒初始化）。
   * 外部模块应使用此方法，而非 `(modelLibrary as any)['clients'].get(id)`。
   */
  getClient(modelId: string): OpenAI | Anthropic | undefined {
    return this.clients.get(modelId);
  }

  /**
   * 返回所有已初始化客户端的快照数组（按插入顺序）。
   * 用于"取任意可用客户端"或遍历寻找兼容客户端的场景，替代对私有 clients Map 的直接访问。
   */
  getAllClients(): Array<{ modelId: string; client: OpenAI | Anthropic }> {
    const out: Array<{ modelId: string; client: OpenAI | Anthropic }> = [];
    for (const [modelId, client] of this.clients) {
      out.push({ modelId, client });
    }
    return out;
  }

  /**
   * 按 modelId 获取 OpenAI 兼容客户端（具备 .chat.completions.create）。
   * Anthropic 客户端无 .chat 属性，会被过滤。替代外部 `as any` 后再访问 .chat 的写法。
   */
  getChatClient(modelId?: string): OpenAI | undefined {
    const isOpenAI = (c: OpenAI | Anthropic): c is OpenAI => 'chat' in c;
    if (modelId) {
      const c = this.clients.get(modelId);
      return c && isOpenAI(c) ? c : undefined;
    }
    for (const c of this.clients.values()) {
      if (isOpenAI(c)) return c;
    }
    return undefined;
  }

  /**
   * 返回第一个 OpenAI 兼容客户端及其 modelId（用于"取任意可用聊天客户端"场景）。
   * 替代 `(modelLibrary as any)['clients'].entries().next()` 的私有访问写法。
   */
  getFirstChatClient(): { modelId: string; client: OpenAI } | null {
    const isOpenAI = (c: OpenAI | Anthropic): c is OpenAI => 'chat' in c;
    for (const [modelId, c] of this.clients) {
      if (isOpenAI(c)) return { modelId, client: c };
    }
    return null;
  }

  // ========== Key 管理 ==========

  /**
   * 配置API Key - 运行时动态添加或更新
   */
  configureKey(modelId: string, apiKey: string): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;

    model.apiKey = apiKey;
    model.enabled = true;

    // 重新初始化客户端
    this.initClient(modelId);
    this.saveToConfig();

    return true;
  }

  /**
   * 批量配置Key
   */
  configureKeys(keys: Record<string, string>): number {
    let count = 0;
    for (const [modelId, apiKey] of Object.entries(keys)) {
      if (this.configureKey(modelId, apiKey)) count++;
    }
    return count;
  }

  /**
   * 按提供商配置Key - 自动匹配该提供商下所有模型
   */
  configureProviderKey(provider: string, apiKey: string): number {
    let count = 0;
    this.models.forEach((model, id) => {
      const bURL = model.baseURL || '';
      let matched = false;
      if (provider === 'deepseek' && bURL.includes('deepseek')) matched = true;
      else if (provider === 'openrouter' && bURL.includes('openrouter')) matched = true;
      else if (provider === 'anthropic' && model.provider === 'anthropic') matched = true;
      else if (provider === 'openai' && bURL.includes('openai.com')) matched = true;
      else if (provider === 'google' && bURL.includes('googleapis')) matched = true;
      else if (provider === 'moonshot' && bURL.includes('moonshot')) matched = true;
      else if (provider === 'zhipu' && bURL.includes('bigmodel')) matched = true;
      else if (provider === 'aliyun' && bURL.includes('dashscope')) matched = true;
      else if (provider === 'bytedance' && bURL.includes('volces')) matched = true;
      else if (provider === 'doubao' && bURL.includes('volces')) matched = true;
      else if (provider === 'siliconflow' && bURL.includes('siliconflow')) matched = true;
      else if (provider === 'minimax' && bURL.includes('minimax')) matched = true;
      else if (provider === 'groq' && bURL.includes('groq')) matched = true;
      else if (provider === 'agnes' && bURL.includes('agnes-ai')) matched = true;
      else if (provider === 'together' && bURL.includes('together')) matched = true;
      else if (provider === 'fireworks' && bURL.includes('fireworks')) matched = true;
      else if (provider === 'perplexity' && bURL.includes('perplexity')) matched = true;
      else if (provider === 'xai' && bURL.includes('x.ai')) matched = true;
      else if (provider === 'mistral' && bURL.includes('mistral')) matched = true;
      else if (provider === 'cohere' && bURL.includes('cohere')) matched = true;
      else if (provider === 'ernie' && (bURL.includes('baidubce') || bURL.includes('wenxin'))) matched = true;
      else if (provider === 'stepfun' && bURL.includes('stepfun')) matched = true;
      else if (provider === 'baichuan' && bURL.includes('baichuan-ai')) matched = true;
      else if (provider === 'yi' && bURL.includes('lingyiwanwu')) matched = true;
      else if (provider === 'sensenova' && bURL.includes('sensenova')) matched = true;
      else if (provider === 'doubao-agent' && bURL.includes('volces') && bURL.includes('/api/agent')) matched = true;
      else if (provider === 'gemini' && bURL.includes('googleapis')) matched = true;
      else if (provider === 'qwen' && bURL.includes('dashscope')) matched = true;
      if (matched) {
        model.apiKey = apiKey;
        model.enabled = true;
        this.initClient(id);
        count++;
      }
    });
    if (count > 0) this.saveToConfig();
    return count;
  }

  /**
   * 移除Key
   */
  removeKey(modelId: string): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;
    model.apiKey = undefined;
    model.enabled = false;
    this.clients.delete(modelId);
    this.saveToConfig();
    return true;
  }

  /**
   * 动态更新API Key（供网页版配置保存后调用）
   * 支持provider级别和model级别
   */
  updateApiKey(providerOrModelId: string, apiKey: string): void {
    // 先尝试作为modelId处理
    const model = this.models.get(providerOrModelId);
    if (model) {
      model.apiKey = apiKey;
      model.enabled = true;
      this.initClient(providerOrModelId);
      this.saveToConfig();
      return;
    }

    // 作为provider处理
    this.models.forEach((m, id) => {
      const bURL = m.baseURL || '';
      if (providerOrModelId === 'deepseek' && bURL.includes('deepseek')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'openrouter' && bURL.includes('openrouter')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'anthropic' && m.provider === 'anthropic') {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'openai' && bURL.includes('openai.com')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'google' && bURL.includes('googleapis')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'moonshot' && bURL.includes('moonshot')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'zhipu' && bURL.includes('bigmodel')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'aliyun' && bURL.includes('dashscope')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'bytedance' && bURL.includes('volces')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'doubao' && bURL.includes('volces')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'siliconflow' && bURL.includes('siliconflow')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'minimax' && bURL.includes('minimax')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'groq' && bURL.includes('groq')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'agnes' && bURL.includes('agnes-ai')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'together' && bURL.includes('together')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'fireworks' && bURL.includes('fireworks')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'perplexity' && bURL.includes('perplexity')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'xai' && bURL.includes('x.ai')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'mistral' && bURL.includes('mistral')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'cohere' && bURL.includes('cohere')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'ernie' && (bURL.includes('baidubce') || bURL.includes('wenxin'))) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'stepfun' && bURL.includes('stepfun')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'baichuan' && bURL.includes('baichuan-ai')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'yi' && bURL.includes('lingyiwanwu')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'sensenova' && bURL.includes('sensenova')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'doubao-agent' && bURL.includes('volces') && bURL.includes('/api/agent')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'gemini' && bURL.includes('googleapis')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      } else if (providerOrModelId === 'qwen' && bURL.includes('dashscope')) {
        m.apiKey = apiKey; m.enabled = true; this.initClient(id);
      }
    });
    this.saveToConfig();
  }

  /**
   * 获取所有Key状态（脱敏显示）
   */
  getKeyStatus(): Array<{ modelId: string; name: string; hasKey: boolean; keyPreview: string; enabled: boolean }> {
    return Array.from(this.models.values()).map(m => ({
      modelId: m.id,
      name: m.name,
      hasKey: !!m.apiKey,
      keyPreview: m.apiKey ? `${m.apiKey.substring(0, 6)}...${m.apiKey.substring(m.apiKey.length - 4)}` : '',
      enabled: m.enabled,
    }));
  }

  // ========== Auto 模型匹配 ==========

  /**
   * 分析用户任务，确定需要的模型能力
   */
  analyzeTask(input: string): TaskAnalysis {
    const _lower = input.toLowerCase();
    const capabilities: ModelCapability[] = [];
    const keywords: string[] = [];
    let complexity: 'simple' | 'medium' | 'complex' = 'simple';
    let requiresToolUse = false;
    let requiresLongContext = false;
    let estimatedTokens = 500;

    // 代码相关
    if (/代码|编程|函数|bug|调试|开发|实现|写一个|创建.*程序|code|program|function|debug|implement/i.test(input)) {
      capabilities.push('coding');
      keywords.push('coding');
      complexity = 'complex';
      estimatedTokens = 2000;
    }

    // 推理相关
    if (/分析|推理|为什么|原因|逻辑|证明|推导|analyze|reason|why|logic|prove/i.test(input)) {
      capabilities.push('reasoning');
      keywords.push('reasoning');
      complexity = 'complex';
      estimatedTokens = 1500;
    }

    // 创意相关
    if (/写|创作|故事|诗歌|创意|设计|brainstorm|write|create|story|poem|creative/i.test(input)) {
      capabilities.push('creative');
      keywords.push('creative');
      estimatedTokens = 1500;
    }

    // 数据分析
    if (/数据|统计|报表|图表|分析报告|data|statistic|chart|report/i.test(input)) {
      capabilities.push('analysis');
      keywords.push('analysis');
      complexity = 'medium';
      estimatedTokens = 1500;
    }

    // 数学
    if (/计算|数学|方程|公式|calculation|math|equation|formula/i.test(input)) {
      capabilities.push('math');
      keywords.push('math');
      estimatedTokens = 800;
    }

    // 工具调用
    if (/搜索|查询|执行|运行|文件|目录|search|execute|run|file|directory/i.test(input)) {
      capabilities.push('tool_use');
      requiresToolUse = true;
      keywords.push('tool_use');
      estimatedTokens = 1000;
    }

    // 长上下文
    if (input.length > 2000 || /总结|摘要|全文|详细|summarize|full.*text|detailed/i.test(input)) {
      capabilities.push('long_context');
      requiresLongContext = true;
      estimatedTokens = 3000;
    }

    // 翻译
    if (/翻译|translate|英译|中译/i.test(input)) {
      capabilities.push('translation');
      keywords.push('translation');
    }

    // 默认：对话
    if (capabilities.length === 0) {
      capabilities.push('conversation', 'fast');
      keywords.push('general');
    }

    // 复杂度升级
    if (input.length > 500) complexity = 'medium';
    if (input.length > 1500 || capabilities.length >= 3) complexity = 'complex';

    return {
      taskType: capabilities,
      complexity,
      requiresToolUse,
      requiresLongContext,
      estimatedTokens,
      keywords,
    };
  }

  /**
   * Auto模式 - 自动匹配最佳模型
   */
  autoSelect(input: string): ModelSelection {
    const analysis = this.analyzeTask(input);
    const available = this.getAvailableModels();

    if (available.length === 0) {
      throw new Error('没有可用的模型。请先配置API Key: configureKey("deepseek-chat", "sk-xxx")');
    }

    // 为每个可用模型计算匹配分数
    const scored = available.map(model => {
      let score = 0;

      // 1. 能力匹配（最重要）
      const capabilityMatch = analysis.taskType.filter(t =>
        model.capabilities.includes(t)
      ).length;
      score += capabilityMatch * 30;

      // 2. 优先级
      score += model.priority * 5;

      // 3. 历史性能
      const perf = this.performance.get(model.id);
      if (perf && perf.totalCalls > 0) {
        const successRate = perf.successCalls / perf.totalCalls;
        score += successRate * 20;

        // 质量评分
        if (perf.qualityScores.length > 0) {
          const avgQuality = perf.qualityScores.reduce((a, b) => a + b, 0) / perf.qualityScores.length;
          score += avgQuality * 15;
        }

        // 延迟惩罚
        const avgLatency = perf.totalLatency / perf.totalCalls;
        if (avgLatency > 10000) score -= 10;
        else if (avgLatency > 5000) score -= 5;
      } else {
        // 新模型给基础分
        score += 10;
      }

      // 4. 成本考虑（简单任务优先用便宜模型）
      if (analysis.complexity === 'simple' && model.costPer1kTokens !== undefined) {
        if (model.costPer1kTokens < 0.002) score += 10;
        else if (model.costPer1kTokens > 0.005) score -= 5;
      }

      // 5. 工具调用需求
      if (analysis.requiresToolUse && model.capabilities.includes('tool_use')) {
        score += 15;
      }

      // 6. 长上下文需求
      if (analysis.requiresLongContext && model.capabilities.includes('long_context')) {
        score += 15;
      }

      // 7. 快速响应需求
      if (analysis.complexity === 'simple' && model.capabilities.includes('fast')) {
        score += 8;
      }

      return { model, score, reason: this.buildSelectionReason(model, analysis, score) };
    });

    // 排序
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const alternatives = scored.slice(1, 3).map(s => s.model);

    return {
      model: best.model,
      reason: best.reason,
      alternatives,
    };
  }

  /**
   * 构建选择原因
   */
  private buildSelectionReason(model: ModelEntry, analysis: TaskAnalysis, score: number): string {
    const matchedCaps = analysis.taskType.filter(t => model.capabilities.includes(t));
    const parts: string[] = [];

    if (matchedCaps.length > 0) {
      parts.push(`能力匹配[${matchedCaps.join(',')}]`);
    }
    parts.push(`优先级${model.priority}`);
    parts.push(`评分${score.toFixed(0)}`);

    return `${model.name}: ${parts.join(' | ')}`;
  }

  // ========== 统一调用接口 ==========

  /**
   * 统一调用 - Auto模式自动选择模型
   *
   * 支持两种消息格式：
   * 1. 文本消息：{ role: 'user', content: '你好' }
   * 2. 多模态消息（用于视觉理解）：
   *    { role: 'user', content: [
   *        { type: 'text', text: '描述这张图片' },
   *        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
   *    ]}
   */
  async call(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content:
        | string
        | Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string; detail?: string } }
          >;
    }>,
    options?: {
      modelId?: string;           // 指定模型，不指定则Auto
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools?: any[];              // 工具定义
      maxTokens?: number;
      temperature?: number;
      autoFallback?: boolean;     // 失败自动降级，默认true
    }
  ): Promise<UnifiedModelResponse> {
    const autoFallback = options?.autoFallback !== false;

    // 确定使用的模型
    let selectedModel: ModelEntry;
    let _selectionReason: string;

    if (options?.modelId) {
      const model = this.models.get(options.modelId);
      if (!model || !model.enabled) {
        throw new Error(`模型 ${options.modelId} 不可用`);
      }
      selectedModel = model;
      _selectionReason = '手动指定';
    } else {
      // Auto模式：从最后一条用户消息推断任务
      const lastUserMsgRaw = messages.filter(m => m.role === 'user').pop()?.content || '';
      // 多模态消息可能是数组，提取所有 text 部分
      const lastUserMsg = typeof lastUserMsgRaw === 'string'
        ? lastUserMsgRaw
        : lastUserMsgRaw
            .filter(part => part && part.type === 'text')
            .map(part => (part as { text: string }).text)
            .join('\n') || '';
      const selection = this.autoSelect(lastUserMsg);
      selectedModel = selection.model;
      _selectionReason = selection.reason;
    }

    // 尝试调用
    const modelsToTry = [selectedModel];
    if (autoFallback) {
      // 添加备选模型
      const lastUserMsgRaw = messages.filter(m => m.role === 'user').pop()?.content || '';
      const lastUserMsg = typeof lastUserMsgRaw === 'string'
        ? lastUserMsgRaw
        : lastUserMsgRaw
            .filter(part => part && part.type === 'text')
            .map(part => (part as { text: string }).text)
            .join('\n') || '';
      const selection = this.autoSelect(lastUserMsg);
      for (const alt of selection.alternatives) {
        if (!modelsToTry.find(m => m.id === alt.id)) {
          modelsToTry.push(alt);
        }
      }
    }

    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      const startTime = Date.now();
      try {
        const result = await this.callModel(model, messages, options);
        const latency = Date.now() - startTime;

        // 记录性能
        this.recordSuccess(model.id, latency, result.tokens || 0);

        return {
          content: result.content,
          modelId: model.id,
          provider: model.provider,
          tokens: result.tokens || 0,
          latency,
          quality: this.estimateQuality(result.content),
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(model.id, this.analyzeAndFormatError(err, model));
        // 继续尝试下一个模型
      }
    }

    throw new Error(`所有模型调用失败。最后错误: ${lastError ? this.analyzeAndFormatError(lastError, modelsToTry[modelsToTry.length - 1]) : '未知错误'}`);
  }

  /**
   * 带工具调用的chat（OpenAI function calling格式）
   */
  async chatWithTools(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: any }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools?: any[],
    options?: {
      modelId?: string;
      maxTokens?: number;
    }
  ): Promise<{
    content: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool_calls?: any[];
    modelId: string;
    latency: number;
  }> {
    // Auto选择模型（含自动降级）
    const modelsToTry: ModelEntry[] = [];
    if (options?.modelId) {
      const model = this.models.get(options.modelId);
      if (model && model.enabled) modelsToTry.push(model);
    } else {
      const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
      const selection = this.autoSelect(lastUserMsg);
      modelsToTry.push(selection.model);
      for (const alt of selection.alternatives) {
        if (!modelsToTry.find(m => m.id === alt.id)) {
          modelsToTry.push(alt);
        }
      }
    }

    if (modelsToTry.length === 0) throw new Error('没有可用的模型');

    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      const startTime = Date.now();

      try {
        const client = this.clients.get(model.id) as OpenAI;
        if (!client) {
          lastError = new Error(`模型 ${model.id} 客户端未初始化`);
          continue;
        }

        const openaiMsgs = messages.map(m => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role: m.role as any,
          content: m.content,
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        }));

        const response = await client.chat.completions.create({
          model: model.model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: openaiMsgs as any,
          ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
          max_tokens: options?.maxTokens || model.maxTokens,
          temperature: model.temperature,
        });

        const choice = response.choices?.[0];
        if (!choice || !choice.message) {
          throw new Error('API 返回了无效的响应结构（缺少 choices 或 message）');
        }
        const latency = Date.now() - startTime;

        this.recordSuccess(model.id, latency, response.usage?.total_tokens || 0);

        return {
          content: choice.message.content,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tool_calls: choice.message.tool_calls as any,
          modelId: model.id,
          latency,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const friendlyMsg = this.analyzeAndFormatError(err, model);
        this.recordFailure(model.id, friendlyMsg);
        console.warn(`[ModelLibrary] ${model.name} 调用失败，尝试备用模型: ${friendlyMsg}`);
      }
    }

    throw new Error(`所有模型调用失败。最后错误: ${lastError ? this.analyzeAndFormatError(lastError, modelsToTry[modelsToTry.length - 1]) : '未知错误'}`);
  }

  // ========== 流式+工具调用接口 ==========

  /**
   * 流式+工具调用的组合场景
   * 返回 AsyncGenerator，yield 类型包括 chunk/tool_call/done/error
   *
   * 对于 OpenAI 兼容模型，使用 stream + tools 参数
   * 对于 Anthropic 模型，使用 stream + tools 参数
   */
  async *streamChatWithTools(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: any }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools?: any[],
    options?: {
      modelId?: string;
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): AsyncGenerator<
    | { type: 'chunk'; content: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { type: 'tool_call'; tool_call: any }
    | { type: 'done'; modelId: string; latency: number }
    | { type: 'error'; error: string }
  > {
    const startTime = Date.now();

    // 1. 确定使用的模型
    let selectedModel: ModelEntry;

    if (options?.modelId) {
      const model = this.models.get(options.modelId);
      if (!model || !model.enabled) {
        yield { type: 'error', error: `指定的模型 ${options.modelId} 不可用，请先配置API Key` };
        return;
      }
      selectedModel = model;
    } else {
      const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
      const selection = this.autoSelect(lastUserMsg);
      selectedModel = selection.model;
    }

    console.info(`[ModelLibrary.streamChatWithTools] 使用模型: ${selectedModel.name} (${selectedModel.id})`);

    // 2. 获取客户端
    let client = this.clients.get(selectedModel.id);
    // 懒初始化：构造时不再预创建客户端（含 ollama），首次调用时按需创建
    if (!client) {
      this.initClient(selectedModel.id);
      client = this.clients.get(selectedModel.id);
    }

    if (!client) {
      yield { type: 'error', error: `无法获取 ${selectedModel.provider} 客户端，请先配置API Key` };
      return;
    }

    try {
      if (selectedModel.provider === 'anthropic' && client instanceof Anthropic) {
        // ===== Anthropic 流式+工具调用 =====
        const anthropicClient = client as Anthropic;

        // 分离 system 消息
        const systemContent = options?.systemPrompt ||
          messages.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
        const chatMessages = messages.filter(m => m.role !== 'system');

        // 转换消息格式
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | any[] }> = [];
        for (const msg of chatMessages) {
          if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            // assistant 消息带 tool_calls
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contentBlocks: any[] = [];
            if (msg.content) {
              contentBlocks.push({ type: 'text', text: msg.content });
            }
            for (const tc of msg.tool_calls) {
              contentBlocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name || tc.name,
                input: typeof tc.function?.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function?.arguments || tc.input || {}),
              });
            }
            anthropicMessages.push({ role: 'assistant', content: contentBlocks });
          } else if (msg.role === 'tool') {
            // tool 结果消息
            anthropicMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content,
              }],
            });
          } else {
            anthropicMessages.push({
              role: msg.role as 'user' | 'assistant',
              content: msg.content,
            });
          }
        }

        // 转换工具定义为 Anthropic 格式
        const anthropicTools = tools?.map(t => ({
          name: t.function?.name || t.name,
          description: t.function?.description || t.description || '',
          input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
        }));

        const stream = await anthropicClient.messages.stream({
          model: selectedModel.model,
          max_tokens: options?.maxTokens || selectedModel.maxTokens,
          system: systemContent,
          messages: anthropicMessages,
          ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        });

        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              yield {
                type: 'tool_call',
                tool_call: {
                  id: event.content_block.id,
                  type: 'function',
                  function: {
                    name: event.content_block.name,
                    arguments: '',
                  },
                },
              };
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'chunk', content: delta.text };
            } else if (delta.type === 'input_json_delta') {
              // 工具调用的参数增量 - 作为 chunk 的一部分传递
              yield { type: 'chunk', content: delta.partial_json };
            }
          } else if (event.type === 'message_stop') {
            break;
          }
        }

        const latency = Date.now() - startTime;
        this.recordSuccess(selectedModel.id, latency, 0);
        yield { type: 'done', modelId: selectedModel.id, latency };

      } else if (client instanceof OpenAI) {
        // ===== OpenAI 兼容模型 流式+工具调用 =====
        const openaiClient = client as OpenAI;

        const openaiMsgs = messages.map(m => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role: m.role as any,
          content: m.content,
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        }));

        const stream = await openaiClient.chat.completions.create({
          model: selectedModel.model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: openaiMsgs as any,
          stream: true,
          ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
          max_tokens: options?.maxTokens || selectedModel.maxTokens,
          temperature: options?.temperature ?? selectedModel.temperature ?? 0.7,
        });

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;

          // 文本内容
          if (delta?.content) {
            yield { type: 'chunk', content: delta.content };
          }

          // 工具调用
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: 'tool_call',
                tool_call: tc,
              };
            }
          }

          // 检查停止原因
          if (choice.finish_reason) {
            break;
          }
        }

        const latency = Date.now() - startTime;
        this.recordSuccess(selectedModel.id, latency, 0);
        yield { type: 'done', modelId: selectedModel.id, latency };

      } else {
        yield { type: 'error', error: `不支持的提供商类型: ${selectedModel.provider}` };
      }
    } catch (error: unknown) {
      console.error(`[ModelLibrary.streamChatWithTools] 错误:`, error);
      this.recordFailure(selectedModel.id, (error instanceof Error ? error.message : String(error)));
      const errorMsg = this.analyzeAndFormatError(error, selectedModel);
      yield { type: 'error', error: errorMsg };
    }
  }

  // ========== 模型管理 ==========

  /**
   * 添加自定义模型
   */
  addModel(entry: ModelEntry): void {
    this.models.set(entry.id, entry);
    this.initClient(entry.id);
    this.saveToConfig();
  }

  /**
   * 移除模型
   */
  removeModel(modelId: string): boolean {
    const removed = this.models.delete(modelId);
    this.clients.delete(modelId);
    this.performance.delete(modelId);
    if (removed) this.saveToConfig();
    return removed;
  }

  /**
   * 启用/禁用模型
   */
  toggleModel(modelId: string, enabled?: boolean): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;
    model.enabled = enabled !== undefined ? enabled : !model.enabled;
    this.saveToConfig();
    return true;
  }

  /**
   * 获取所有可用模型
   */
  getAvailableModels(): ModelEntry[] {
    return Array.from(this.models.values()).filter(m => {
      if (!m.enabled) return false;
      if (m.provider === 'ollama') return true; // 本地模型不需要Key
      if (m.costPer1kTokens === 0 && m.apiKey) return true; // 免费模型有Key即可用
      return !!m.apiKey;
    });
  }

  /**
   * 获取所有已注册的模型（包括未配置Key的）
   */
  getAllRegisteredModels(): ModelEntry[] {
    return Array.from(this.models.values()).filter(m => m.enabled);
  }

  /**
   * 获取所有模型信息
   */
  getAllModels(): Array<ModelEntry & { performance?: ModelPerformance }> {
    return Array.from(this.models.values()).map(m => ({
      ...m,
      performance: this.performance.get(m.id),
    }));
  }

  /**
   * 获取模型性能报告
   */
  getPerformanceReport(): string {
    const lines: string[] = ['📊 模型性能报告\n'];

    this.performance.forEach((perf, id) => {
      const model = this.models.get(id);
      if (!model || perf.totalCalls === 0) return;

      const successRate = (perf.successCalls / perf.totalCalls * 100).toFixed(1);
      const avgLatency = (perf.totalLatency / perf.totalCalls).toFixed(0);
      const avgQuality = perf.qualityScores.length > 0
        ? (perf.qualityScores.reduce((a, b) => a + b, 0) / perf.qualityScores.length * 100).toFixed(0)
        : 'N/A';

      lines.push(`  ${model.name}:`);
      lines.push(`    成功率: ${successRate}% | 延迟: ${avgLatency}ms | 质量: ${avgQuality}%`);
      lines.push(`    调用: ${perf.totalCalls}次 | Token: ${perf.totalTokens}`);
      if (perf.lastError) {
        lines.push(`    最近错误: ${perf.lastError.substring(0, 80)}`);
      }
    });

    return lines.join('\n');
  }

  /**
   * 获取模型库状态摘要
   */
  getStatus(): string {
    const available = this.getAvailableModels();
    const total = this.models.size;
    const enabled = Array.from(this.models.values()).filter(m => m.enabled).length;

    return `📚 模型库: ${available.length}可用 / ${enabled}启用 / ${total}总计\n` +
      available.map(m => `  ✅ ${m.name} (${m.capabilities.join(',')})`).join('\n');
  }

  // ========== 私有方法 ==========

  /**
   * 将通用消息格式转换为 Anthropic SDK 接受的内容块数组。
   *
   * - OpenAI 风格图像：{ type: 'image_url', image_url: { url } }
   *   → Anthropic 风格：{ type: 'image', source: { type: 'base64', media_type, data } }
   * - OpenAI 风格文本：{ type: 'text', text: string }
   *   → Anthropic 风格：{ type: 'text', text: string }（保持不变）
   *
   * 返回类型统一为 Anthropic SDK 接受的 TextBlockParam | ImageBlockParam 数组。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizeContentForAnthropic(content: any): any {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      // OpenAI 风格图像：{ type: 'image_url', image_url: { url } }
      if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
        const url: string = part.image_url.url;
        if (url.startsWith('data:')) {
          const headerEnd = url.indexOf(',');
          const header = headerEnd === -1 ? '' : url.substring(5, headerEnd); // image/png;base64
          const data = headerEnd === -1 ? '' : url.substring(headerEnd + 1);
          const semiIdx = header.indexOf(';');
          const mediaType = semiIdx === -1 ? header : header.substring(0, semiIdx);
          result.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType || 'image/png',
              data,
            },
          });
        } else {
          // 远程 URL：Anthropic Claude 不直接支持 URL 图像，降级为文本描述
          result.push({ type: 'text', text: `[图像 URL: ${url}]` });
        }
        continue;
      }
      // 其它（包括 { type: 'text', text: string }）：原样保留
      result.push(part);
    }
    return result;
  }

  private async callModel(
    model: ModelEntry,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { tools?: any[]; maxTokens?: number; temperature?: number }
  ): Promise<{ content: string; tokens: number }> {
    let client = this.clients.get(model.id);
    // 懒初始化：构造时不再预创建客户端，首次调用时按需创建（与 streamChatWithTools 一致）
    if (!client) {
      this.initClient(model.id);
      client = this.clients.get(model.id);
    }
    if (!client) throw new Error(`模型 ${model.id} 客户端未初始化`);

    // P0 真实修复：更新客户端最后使用时间（用于 LRU 淘汰）
    this.clientLastUsed.set(model.id, Date.now());

    try {
      if (model.provider === 'anthropic' && client instanceof Anthropic) {
        const systemMsg = messages.find(m => m.role === 'system')?.content;
        const userMsgs = messages.filter(m => m.role !== 'system');

        // 归一化 system & user 内容，支持 image_url 多模态
        const normalizedSystem = systemMsg !== undefined
          ? (typeof systemMsg === 'string' ? systemMsg : this.normalizeContentForAnthropic(systemMsg))
          : '';

        const anthropicMsgs = userMsgs.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: this.normalizeContentForAnthropic(m.content),
        }));

        const msg = await client.messages.create({
          model: model.model,
          max_tokens: options?.maxTokens || model.maxTokens,
          messages: anthropicMsgs,
          // Anthropic 的 system 接受: string | (TextBlockParam | ImageBlockParam)[]
          // 这里 cast 到 any 绕过精确类型匹配
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          system: normalizedSystem as any,
        });

        const content = msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        return {
          content,
          tokens: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0),
        };
      }

      // OpenAI兼容（包括 DeepSeek、OpenRouter、Ollama、Gemini OpenAI proxy）
      // OpenAI SDK 本身支持 content 为字符串或 ContentPart[] 数组，直接透传
      if (client instanceof OpenAI) {
        const completion = await client.chat.completions.create({
          model: model.model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: messages as any,
          max_tokens: options?.maxTokens || model.maxTokens,
          temperature: options?.temperature ?? model.temperature,
        });

        const content = completion.choices?.[0]?.message?.content || '';
        if (!content && !completion.choices?.[0]?.message?.tool_calls) {
          console.warn(`[ModelLibrary] ${model.name} 返回了空响应`);
        }
        return {
          content,
          tokens: completion.usage?.total_tokens || 0,
        };
      }

      throw new Error(`不支持的提供商: ${model.provider}`);
    } catch (err: unknown) {
      // 分析错误并给出更友好的错误消息
      const friendlyError = this.analyzeAndFormatError(err, model);
      throw new Error(friendlyError);
    }
  }

  /**
   * 分析错误并给出友好的错误消息
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private analyzeAndFormatError(err: any, model: ModelEntry): string {
    const message = err.message || String(err);

    // 检测 OpenAI SDK 内部解析错误（response 结构不完整时 SDK 内部崩溃）
    if (message.includes('Cannot read properties of undefined') ||
        message.includes('Cannot read properties of null') ||
        message.includes('is not a function')) {
      return `${model.name}: API 响应解析失败，服务器可能返回了非预期格式。请检查 API Key 是否正确、网络是否正常，或尝试其他模型。`;
    }

    // 检测HTML响应（网络错误时服务器可能返回HTML错误页面）
    const responseData = err.response?.data;
    const isHtmlResponse = typeof responseData === 'string' &&
      (responseData.startsWith('<!DOCTYPE') || responseData.startsWith('<html'));
    if (message.includes('Unexpected token') ||
        message.includes('is not valid JSON') ||
        isHtmlResponse) {
      return `${model.name}: 网络请求失败，服务器返回了非JSON响应。请检查网络连接或尝试其他模型。`;
    }

    // 检测认证错误
    if (message.includes('401') || message.includes('Unauthorized') || 
        message.includes('invalid_api_key') || message.includes('API key')) {
      return `${model.name}: API Key无效或未配置。请使用 "model config ${model.id} <your-key>" 配置正确的API Key。`;
    }

    // 检测网络错误
    if (message.includes('ETIMEDOUT') || message.includes('ENETUNREACH') || 
        message.includes('ECONNREFUSED') || message.includes('NetworkError')) {
      return `${model.name}: 网络连接超时或失败。请检查网络连接或尝试其他模型。`;
    }

    // 检测服务不可用
    if (message.includes('503') || message.includes('Service Unavailable')) {
      return `${model.name}: 服务暂时不可用，请稍后重试或尝试其他模型。`;
    }

    // 检测模型不存在
    if (message.includes('model_not_found') || message.includes('Model not found')) {
      return `${model.name}: 指定的模型不存在，请检查模型配置。`;
    }

    // 检测token超限
    if (message.includes('tokens') && (message.includes('limit') || message.includes('exceeded'))) {
      return `${model.name}: 超出token限制，请缩短输入内容。`;
    }

    // 默认错误消息
    return `${model.name}: 请求失败 - ${message.substring(0, 100)}`;
  }

  private initClient(modelId: string): void {
    const model = this.models.get(modelId);
    if (!model || !model.enabled) return;

    // P0 真实修复：客户端 LRU 淘汰 — 超过 MAX_CLIENTS 时淘汰最久未使用的
    // 防止长时间运行积累过多客户端实例导致 FD 耗尽
    // 仅当本次确实要新建客户端时才淘汰，避免无 key 的模型触发空淘汰导致缓存缩水
    const willCreateClient = !this.clients.has(modelId) && (
      (model.provider === 'anthropic' && !!model.apiKey) ||
      (model.provider === 'openai_compatible' && !!model.apiKey) ||
      model.provider === 'ollama'
    );
    if (willCreateClient && this.clients.size >= this.MAX_CLIENTS) {
      this.evictLRUClient();
    }

    try {
      if (model.provider === 'anthropic' && model.apiKey) {
        this.clients.set(modelId, new Anthropic({ apiKey: model.apiKey }));
      } else if (model.provider === 'openai_compatible' && model.apiKey) {
        this.clients.set(modelId, new OpenAI({
          apiKey: model.apiKey,
          baseURL: model.baseURL,
        }));
      } else if (model.provider === 'ollama') {
        this.clients.set(modelId, new OpenAI({
          apiKey: 'ollama',
          baseURL: model.baseURL || 'http://localhost:11434/v1',
        }));
      }
      // P0: 记录初始化时间作为初始 lastUsed
      if (this.clients.has(modelId)) {
        this.clientLastUsed.set(modelId, Date.now());
      }
    } catch (err: unknown) {
      console.error(`初始化模型 ${modelId} 客户端失败:`, err);
    }
  }

  /**
   * P0 真实修复：淘汰最久未使用的客户端
   *
   * 基于 clientLastUsed 时间戳找到最久未使用的客户端，
   * 从 clients 和 clientLastUsed 中移除，并尝试释放其底层连接。
   */
  private evictLRUClient(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, time] of this.clientLastUsed) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const client = this.clients.get(oldestKey);
      // 尝试主动释放底层 HTTP 连接池，避免等 GC 才回收 socket（长时间运行 + 频繁切换 20+ 模型时可能耗尽 FD）
      // OpenAI/Anthropic SDK 无统一的 public close API，用渐进式探测：优先调 close/destroy/dispose，再尝试 httpAgent.destroy
      this.tryReleaseClientResources(client, oldestKey);
      this.clients.delete(oldestKey);
      this.clientLastUsed.delete(oldestKey);
      console.warn(`[ModelLibrary] P0 LRU 淘汰: 客户端 ${oldestKey} 已淘汰（最久未使用，${new Date(oldestTime).toISOString()}）`);
    }
  }

  /**
   * P0 真实修复：释放所有客户端资源
   *
   * 长时间运行的进程在退出前应调用此方法，
   * 清理所有客户端实例及其底层 HTTP 连接池，防止 FD 泄漏。
   */
  dispose(): void {
    const count = this.clients.size;
    for (const [key, client] of this.clients) {
      this.tryReleaseClientResources(client, key);
    }
    this.clients.clear();
    this.clientLastUsed.clear();
    if (count > 0) {
      console.warn(`[ModelLibrary] P0 dispose: 已释放 ${count} 个客户端实例`);
    }
  }

  /**
   * 渐进式探测并释放 SDK 客户端底层 HTTP 连接池资源。
   * OpenAI/Anthropic SDK 无统一 public close API，按以下顺序尝试：
   * 1. close() — 部分版本提供
   * 2. destroy() — undici Agent/Pool 模式
   * 3. dispose() — 通用协议
   * 4. httpAgent.destroy() — Node.js http.Agent 模式
   * 5. _client?.destroy?.() / _options?.httpAgent?.destroy?.() — SDK 内部字段探测
   * 任何一步失败都不影响后续步骤，最终降级为仅从 Map 移除（由 GC 回收）。
   */
  private tryReleaseClientResources(client: OpenAI | Anthropic | undefined, key: string): void {
    if (!client) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    const tried: string[] = [];
    const attempt = (label: string, fn: () => unknown) => {
      try {
        const ret = fn();
        if (ret !== undefined) {
          tried.push(label);
          return true;
        }
      } catch {
        // 该方法不存在或失败，继续尝试下一个
      }
      return false;
    };
    attempt('close', () => c.close?.());
    attempt('destroy', () => c.destroy?.());
    attempt('dispose', () => c.dispose?.());
    attempt('httpAgent.destroy', () => c.httpAgent?.destroy?.());
    attempt('_client.destroy', () => c._client?.destroy?.());
    attempt('_options.httpAgent.destroy', () => c._options?.httpAgent?.destroy?.());
    if (tried.length > 0) {
      console.warn(`[ModelLibrary] 客户端 ${key} 资源释放方式: ${tried.join(', ')}`);
    }
  }

  private loadFromEnv(): void {
    // 从环境变量加载Key
    for (const model of BUILTIN_MODELS) {
      this.models.set(model.id, { ...model });
      this.performance.set(model.id, {
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        totalLatency: 0,
        totalTokens: 0,
        qualityScores: [],
        lastUsed: 0,
      });
    }

    // 匹配环境变量
    const envMappings: Record<string, { envKey: string; modelIds: string[] }> = {
      deepseek: { envKey: 'DEEPSEEK_API_KEY', modelIds: ['deepseek-chat', 'deepseek-reasoner'] },
      openrouter: { envKey: 'OPENROUTER_API_KEY', modelIds: ['openrouter-gpt4o-mini', 'openrouter-claude-sonnet', 'openrouter-deepseek-free', 'openrouter-deepseek-r1-free', 'openrouter-llama-free', 'openrouter-qwen-free', 'openrouter-phi4-free', 'openrouter-gemma-free'] },
      anthropic: { envKey: 'ANTHROPIC_API_KEY', modelIds: ['anthropic-claude'] },
      openai: { envKey: 'OPENAI_API_KEY', modelIds: ['openai-gpt4o', 'openai-gpt4o-mini'] },
      google: { envKey: 'GOOGLE_API_KEY', modelIds: ['google-gemini-flash', 'google-gemini-pro', 'google-gemini-flash-free', 'google-gemini-flash-lite-free'] },
      gemini: { envKey: 'GEMINI_API_KEY', modelIds: ['google-gemini-flash', 'google-gemini-pro', 'google-gemini-flash-free', 'google-gemini-flash-lite-free'] },
      moonshot: { envKey: 'MOONSHOT_API_KEY', modelIds: ['moonshot-v1', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
      zhipu: { envKey: 'ZHIPU_API_KEY', modelIds: ['zhipu-glm52', 'zhipu-glm51', 'zhipu-glm4', 'zhipu-glm4-flash', 'zhipu-glm4-air', 'zhipu-glm4v-flash'] },
      aliyun: { envKey: 'ALIYUN_API_KEY', modelIds: ['aliyun-qwen', 'aliyun-qwen-turbo', 'aliyun-qwen-plus', 'aliyun-qwen-long', 'aliyun-qwq'] },
      qwen: { envKey: 'ALIYUN_API_KEY', modelIds: ['aliyun-qwen', 'aliyun-qwen-turbo', 'aliyun-qwen-plus', 'aliyun-qwen-long', 'aliyun-qwq'] },
      bytedance: { envKey: 'DOUBAO_API_KEY', modelIds: ['bytedance-doubao'] },
      doubao: { envKey: 'DOUBAO_API_KEY', modelIds: ['bytedance-doubao'] },
      'doubao-coding': { envKey: 'DOUBAO_CODING_API_KEY', modelIds: ['bytedance-doubao-coding'] },
      coding_plan: { envKey: 'DOUBAO_CODING_API_KEY', modelIds: ['bytedance-doubao-coding'] },
      'doubao-agent': { envKey: 'DOUBAO_AGENT_API_KEY', modelIds: ['bytedance-doubao-agent'] },
      siliconflow: { envKey: 'SILICONFLOW_API_KEY', modelIds: ['siliconflow-deepseek', 'siliconflow-deepseek-free', 'siliconflow-qwen-free', 'siliconflow-deepseek-r1-free', 'siliconflow-qwen-72b', 'siliconflow-glm4-free'] },
      minimax: { envKey: 'MINIMAX_API_KEY', modelIds: ['minimax-text'] },
      groq: { envKey: 'GROQ_API_KEY', modelIds: ['groq-llama', 'groq-llama-free', 'groq-mixtral-free', 'groq-gemma-free'] },
      together: { envKey: 'TOGETHER_API_KEY', modelIds: ['together-llama'] },
      fireworks: { envKey: 'FIREWORKS_API_KEY', modelIds: ['fireworks-llama'] },
      perplexity: { envKey: 'PERPLEXITY_API_KEY', modelIds: ['perplexity-sonar'] },
      xai: { envKey: 'XAI_API_KEY', modelIds: ['xai-grok'] },
      agnes: { envKey: 'AGNES_API_KEY', modelIds: ['agnes-flash'] },
      stepfun: { envKey: 'STEPFUN_API_KEY', modelIds: ['stepfun-step1-8k'] },
      baichuan: { envKey: 'BAICHUAN_API_KEY', modelIds: ['baichuan-baichuan4'] },
      yi: { envKey: 'YI_API_KEY', modelIds: ['yi-lightning'] },
      sensenova: { envKey: 'SENSENOVA_API_KEY', modelIds: ['sensenova-sensenova5'] },
      ernie: { envKey: 'ERNIE_API_KEY', modelIds: ['ernie-4.0-8k', 'ernie-3.5-8k'] },
      mistral: { envKey: 'MISTRAL_API_KEY', modelIds: ['mistral-small'] },
      cohere: { envKey: 'COHERE_API_KEY', modelIds: ['cohere-command-r-plus'] },
    };

    for (const [, mapping] of Object.entries(envMappings)) {
      const key = process.env[mapping.envKey];
      if (key && !key.startsWith('your_') && key.length > 10) {
        for (const modelId of mapping.modelIds) {
          const model = this.models.get(modelId);
          if (model) {
            model.apiKey = key;
            model.enabled = true;
          }
        }
      }
    }
  }

  /**
   * 从统一配置管理器（~/.duan/config.json）加载 API Key
   * 这是三端（CLI/Web/Desktop）共享的唯一配置源
   */
  private loadFromUnifiedConfig(): void {
    try {
      const unified = UnifiedConfigManager.getInstance();
      const profiles = unified.getProfiles(); // 已解密
      const activeProfile = unified.getActiveProfile();

      for (const [id, p] of Object.entries(profiles)) {
        if (!p.apiKey || p.apiKey.length < 8 || p.apiKey.startsWith('your_')) continue;

        // 根据 provider 匹配内置模型并注入 Key
        const provider = p.provider || '';
        const baseUrl = p.baseUrl || '';
        const model = p.model || '';

        // 1. 按 baseURL 匹配内置模型
        let matched = false;
        this.models.forEach((m, _mid) => {
          const mURL = m.baseURL || '';
          if (this.isProviderMatch(provider, mURL, baseUrl)) {
            m.apiKey = p.apiKey;
            m.enabled = true;
            // 如果 profile 指定了 model 且与内置不同，更新 model 名
            if (model && m.model !== model) {
              m.model = model;
            }
            // 如果 profile 指定了 baseUrl，覆盖内置的
            if (baseUrl) {
              m.baseURL = baseUrl;
            }
            matched = true;
          }
        });

        // 2. 如果没有匹配到内置模型，创建一个自定义模型条目
        if (!matched && model && baseUrl) {
          const customId = `custom-${id}-${Date.now()}`;
          const inferredProvider = this.inferProviderType(provider, baseUrl);
          this.models.set(customId, {
            id: customId,
            name: `${provider} (${model})`,
            provider: inferredProvider,
            model: model,
            apiKey: p.apiKey,
            baseURL: baseUrl,
            maxTokens: 8192,
            temperature: 0.7,
            enabled: true,
            capabilities: ['coding', 'reasoning', 'conversation', 'analysis', 'tool_use'],
            costPer1kTokens: 0,
            priority: 8,
          });
          this.performance.set(customId, {
            totalCalls: 0, successCalls: 0, failedCalls: 0,
            totalLatency: 0, totalTokens: 0, qualityScores: [], lastUsed: 0,
          });
        }
      }

      // 标记激活的 profile 对应的模型为高优先级
      if (activeProfile && activeProfile.apiKey) {
        const activeBaseUrl = activeProfile.baseUrl || '';
        const activeModel = activeProfile.model || '';
        this.models.forEach(m => {
          if (m.apiKey === activeProfile.apiKey &&
              (m.model === activeModel || m.baseURL === activeBaseUrl)) {
            m.priority = Math.max(m.priority, 10); // 提升优先级
          }
        });
      }
    } catch (err: unknown) {
      console.warn('[ModelLibrary] 从统一配置加载失败:', (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 判断 provider/baseURL 是否匹配 */
  private isProviderMatch(provider: string, modelBaseUrl: string, profileBaseUrl: string): boolean {
    if (profileBaseUrl && modelBaseUrl === profileBaseUrl) return true;
    const p = provider.toLowerCase();
    const url = (modelBaseUrl + ' ' + profileBaseUrl).toLowerCase();
    if (p === 'deepseek' && url.includes('deepseek')) return true;
    if (p === 'openrouter' && url.includes('openrouter')) return true;
    if (p === 'openai' && url.includes('openai.com')) return true;
    if (p === 'anthropic' && url.includes('anthropic')) return true;
    if (p === 'google' && url.includes('googleapis')) return true;
    if (p === 'moonshot' && url.includes('moonshot')) return true;
    if (p === 'zhipu' && url.includes('bigmodel')) return true;
    if ((p === 'aliyun' || p === 'qwen') && url.includes('dashscope')) return true;
    if (p === 'doubao' && url.includes('volces') && url.includes('/api/v3')) return true;
    if ((p === 'doubao-coding' || p === 'coding_plan') && url.includes('volces') && url.includes('/api/coding/v3')) return true;
    if (p === 'siliconflow' && url.includes('siliconflow')) return true;
    if (p === 'groq' && url.includes('groq')) return true;
    if (p === 'minimax' && url.includes('minimax')) return true;
    if (p === 'together' && url.includes('together')) return true;
    if (p === 'fireworks' && url.includes('fireworks')) return true;
    if (p === 'perplexity' && url.includes('perplexity')) return true;
    if (p === 'xai' && url.includes('x.ai')) return true;
    if (p === 'mistral' && url.includes('mistral')) return true;
    if (p === 'stepfun' && url.includes('stepfun')) return true;
    if (p === 'baichuan' && url.includes('baichuan-ai')) return true;
    if (p === 'yi' && url.includes('lingyiwanwu')) return true;
    if (p === 'sensenova' && url.includes('sensenova')) return true;
    if (p === 'ernie' && (url.includes('baidubce') || url.includes('wenxin'))) return true;
    if (p === 'doubao-agent' && url.includes('volces') && url.includes('/api/agent')) return true;
    if (p === 'gemini' && url.includes('googleapis')) return true;
    if (p === 'cohere' && url.includes('cohere')) return true;
    if (p === 'agnes' && url.includes('agnes-ai')) return true;
    return false;
  }

  /** 根据 provider 和 baseURL 推断 provider 类型 */
  private inferProviderType(provider: string, baseUrl: string): 'openai_compatible' | 'anthropic' | 'ollama' {
    const p = provider.toLowerCase();
    if (p === 'anthropic') return 'anthropic';
    if (p === 'ollama' || baseUrl.includes('localhost:11434')) return 'ollama';
    return 'openai_compatible';
  }

  private loadFromConfig(): void {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));

      // 加载API Keys
      if (data.apiKeys) {
        const keyMappings: Record<string, string[]> = {
          deepseek: ['deepseek-chat', 'deepseek-reasoner'],
          openrouter: ['openrouter-gpt4o-mini', 'openrouter-claude-sonnet'],
          anthropic: ['anthropic-claude'],
          openai: ['openai-gpt4o', 'openai-gpt4o-mini'],
          google: ['google-gemini-flash', 'google-gemini-pro'],
          gemini: ['google-gemini-flash', 'google-gemini-pro'],
          moonshot: ['moonshot-v1'],
          zhipu: ['zhipu-glm4'],
          aliyun: ['aliyun-qwen'],
          qwen: ['aliyun-qwen'],
          bytedance: ['bytedance-doubao'],
          doubao: ['bytedance-doubao'],
          'doubao-coding': ['bytedance-doubao-coding'],
          coding_plan: ['bytedance-doubao-coding'],
          'doubao-agent': ['bytedance-doubao-agent'],
          siliconflow: ['siliconflow-deepseek'],
          minimax: ['minimax-text'],
          groq: ['groq-llama'],
          together: ['together-llama'],
          fireworks: ['fireworks-llama'],
          perplexity: ['perplexity-sonar'],
          xai: ['xai-grok'],
          stepfun: ['stepfun-step1-8k'],
          baichuan: ['baichuan-baichuan4'],
          yi: ['yi-lightning'],
          sensenova: ['sensenova-sensenova5'],
          ernie: ['ernie-4.0-8k', 'ernie-3.5-8k'],
          mistral: ['mistral-small'],
          cohere: ['cohere-command-r-plus'],
          agnes: ['agnes-flash'],
        };

        // 使用 UnifiedConfigManager 的加密器（解密失败返回原文而非抛异常，避免警告刷屏）
        const unifiedConfig = UnifiedConfigManager.getInstance();

        for (const [provider, key] of Object.entries(data.apiKeys)) {
          if (key && typeof key === 'string' && key.length > 10 && !key.startsWith('your_')) {
            // 使用统一配置管理器解密（自动处理 enc: 前缀，失败时返回原文）
            const decryptedKey = unifiedConfig.decryptApiKey(key);
            const modelIds = keyMappings[provider] || [];
            for (const modelId of modelIds) {
              const model = this.models.get(modelId);
              if (model) {
                model.apiKey = decryptedKey;
                model.enabled = true;
              }
            }
          }
        }
      }

      // 加载自定义模型
      if (data.customModels && Array.isArray(data.customModels)) {
        for (const model of data.customModels) {
          this.models.set(model.id, model);
          this.performance.set(model.id, {
            totalCalls: 0, successCalls: 0, failedCalls: 0,
            totalLatency: 0, totalTokens: 0, qualityScores: [], lastUsed: 0,
          });
        }
      }
    } catch {
      // 配置加载失败，使用默认值
    }
  }

  private saveToConfig(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let config: any = {};
      if (fs.existsSync(this.configPath)) {
        config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }

      // 保存API Keys（按提供商分组，加密存储）
      // 使用 UnifiedConfigManager 的加密器（与配置系统一致，三端互通）
      const unifiedConfig = UnifiedConfigManager.getInstance();
      const apiKeys: Record<string, string> = {};
      this.models.forEach(model => {
        if (model.apiKey) {
          const bURL = model.baseURL || '';
          let provider = '';
          if (bURL.includes('deepseek')) provider = 'deepseek';
          else if (bURL.includes('openrouter')) provider = 'openrouter';
          else if (bURL.includes('openai.com')) provider = 'openai';
          else if (bURL.includes('googleapis')) provider = 'google';
          else if (bURL.includes('moonshot')) provider = 'moonshot';
          else if (bURL.includes('bigmodel')) provider = 'zhipu';
          else if (bURL.includes('dashscope')) provider = 'aliyun';
          else if (bURL.includes('volces') && bURL.includes('/api/coding/v3')) provider = 'doubao-coding';
          else if (bURL.includes('volces') && bURL.includes('/api/agent')) provider = 'doubao-agent';
          else if (bURL.includes('volces')) provider = 'doubao';
          else if (bURL.includes('siliconflow')) provider = 'siliconflow';
          else if (bURL.includes('minimax')) provider = 'minimax';
          else if (bURL.includes('groq')) provider = 'groq';
          else if (bURL.includes('together')) provider = 'together';
          else if (bURL.includes('fireworks')) provider = 'fireworks';
          else if (bURL.includes('perplexity')) provider = 'perplexity';
          else if (bURL.includes('x.ai')) provider = 'xai';
          else if (bURL.includes('stepfun')) provider = 'stepfun';
          else if (bURL.includes('baichuan-ai')) provider = 'baichuan';
          else if (bURL.includes('lingyiwanwu')) provider = 'yi';
          else if (bURL.includes('sensenova')) provider = 'sensenova';
          else if (bURL.includes('baidubce') || bURL.includes('wenxin')) provider = 'ernie';
          else if (bURL.includes('mistral')) provider = 'mistral';
          else if (bURL.includes('cohere')) provider = 'cohere';
          else if (bURL.includes('agnes-ai')) provider = 'agnes';
          else if (model.provider === 'anthropic') provider = 'anthropic';

          if (provider) {
            // 使用统一加密器（自动添加 enc: 前缀，失败时返回原文）
            apiKeys[provider] = unifiedConfig.encryptApiKey(model.apiKey);
          }
        }
      });
      config.apiKeys = apiKeys;

      // 保存自定义模型
      const customModels = Array.from(this.models.values()).filter(
        m => !BUILTIN_MODELS.find(b => b.id === m.id)
      );
      if (customModels.length > 0) {
        config.customModels = customModels;
      }

      atomicWriteJsonSync(this.configPath, config);
    } catch (err: unknown) {
      console.error('保存配置失败:', err);
    }
  }

  private recordSuccess(modelId: string, latency: number, tokens: number): void {
    const perf = this.performance.get(modelId);
    if (!perf) return;
    perf.totalCalls++;
    perf.successCalls++;
    perf.totalLatency += latency;
    perf.totalTokens += tokens;
    perf.lastUsed = Date.now();
  }

  private recordFailure(modelId: string, error: string): void {
    const perf = this.performance.get(modelId);
    if (!perf) return;
    perf.totalCalls++;
    perf.failedCalls++;
    perf.lastUsed = Date.now();
    perf.lastError = error;
  }

  /**
   * 简单的质量评估：基于响应长度、结构化程度等
   */
  private estimateQuality(content: string): number {
    if (!content || content.length < 10) return 0.2;
    let score = 0.5;

    // 有结构化内容加分
    if (content.includes('```')) score += 0.1;
    if (/^\d+\./m.test(content)) score += 0.05;
    if (content.includes('##')) score += 0.05;

    // 长度适中
    if (content.length > 100 && content.length < 5000) score += 0.1;

    // 有具体建议
    if (/建议|推荐|注意|重要/i.test(content)) score += 0.05;

    // 有错误标记
    if (/错误|失败|无法/i.test(content)) score -= 0.1;

    return Math.max(0.1, Math.min(1.0, score));
  }

  /**
   * 记录用户反馈的质量评分
   */
  recordQualityFeedback(modelId: string, score: number): void {
    const perf = this.performance.get(modelId);
    if (!perf) return;
    perf.qualityScores.push(Math.max(0, Math.min(1, score)));
    // 只保留最近20次
    if (perf.qualityScores.length > 20) {
      perf.qualityScores = perf.qualityScores.slice(-20);
    }
  }

  // ========== 流式调用接口 ==========

  /**
   * 流式调用 - 支持SSE流式输出
   * 返回AsyncGenerator，每次yield一个chunk
   */
  async *streamCall(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      modelId?: string;           // 指定模型，不指定则Auto
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools?: any[];               // 工具定义
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;       // 系统提示词
    }
  ): AsyncGenerator<{ type: 'chunk' | 'done' | 'error'; content?: string; modelId?: string; error?: string }> {
    const startTime = Date.now();
    
    // 1. 确定使用的模型（使用已有逻辑）
    let selectedModel: ModelEntry;
    let selectionReason: string;
    
    if (options?.modelId) {
      // 直接从models中查找指定的模型
      const model = this.models.get(options.modelId);
      if (!model || !model.enabled) {
        yield { type: 'error', error: `指定的模型 ${options.modelId} 不可用，请先配置API Key` };
        return;
      }
      selectedModel = model;
      selectionReason = `用户指定: ${model.name}`;
    } else {
      // Auto模式：使用autoSelect选择最佳模型
      const lastMsg = messages[messages.length - 1]?.content || '';
      const selection = this.autoSelect(lastMsg);
      selectedModel = selection.model;
      selectionReason = selection.reason;
    }
    
    console.info(`[ModelLibrary.streamCall] 使用模型: ${selectedModel.name} (${selectedModel.id}), 原因: ${selectionReason}`);
    
    // 2. 获取客户端
    let client = this.clients.get(selectedModel.id);
    
    // 懒初始化：构造时不再预创建客户端（含 ollama），首次调用时按需创建
    if (!client) {
      this.initClient(selectedModel.id);
      client = this.clients.get(selectedModel.id);
    }
    
    if (!client) {
      yield { type: 'error', error: `无法获取 ${selectedModel.provider} 客户端，请先配置API Key` };
      return;
    }
    
    try {
      // 处理system message
      const systemMessages: { role: 'system'; content: string }[] = [];
      const chatMessages: { role: 'user' | 'assistant'; content: string }[] = [];
      
      for (const msg of messages) {
        if (msg.role === 'system') {
          systemMessages.push({ role: 'system', content: msg.content });
        } else {
          chatMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
        }
      }
      
      // 合并system message
      const combinedSystem = options?.systemPrompt || 
        systemMessages.map(m => m.content).join('\n') || 
        '';
      
      // 根据provider类型选择API调用方式
      if (selectedModel.provider === 'anthropic') {
        // Anthropic API
        const anthropicClient = client as Anthropic;
        
        // 转换消息格式
        const anthropicMessages = chatMessages.map(m => ({
          role: m.role,
          content: m.content,
        }));
        
        const stream = await anthropicClient.messages.stream({
          model: selectedModel.model,
          max_tokens: options?.maxTokens || 4096,
          system: combinedSystem,
          messages: anthropicMessages,
          ...(options?.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        });
        
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'chunk', content: delta.text };
            }
          }
          if (event.type === 'message_stop') {
            break;
          }
        }
      } else {
        // OpenAI兼容API（包括DeepSeek、OpenRouter、Groq等）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const openaiClient = client as any;
        
        const stream = await openaiClient.chat.completions.create({
          model: selectedModel.model,
          messages: [
            ...(combinedSystem ? [{ role: 'system' as const, content: combinedSystem }] : []),
            ...chatMessages,
          ],
          stream: true,
          max_tokens: options?.maxTokens || 4096,
          temperature: options?.temperature ?? 0.7,
          ...(options?.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        });
        
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta?.content;
          if (delta) {
            yield { type: 'chunk', content: delta };
          }
          // 检查停止原因
          if (choice.finish_reason) {
            break;
          }
        }
      }
      
      // 记录成功性能
      const latency = Date.now() - startTime;
      this.recordSuccess(selectedModel.id, latency, 0); // 流式调用不计算token
      
      yield { type: 'done', modelId: selectedModel.id };
      
    } catch (error: unknown) {
      console.error(`[ModelLibrary.streamCall] 错误:`, error);
      
      // 记录失败性能
      this.recordFailure(selectedModel.id, (error instanceof Error ? error.message : String(error)));
      
      // 返回友好错误消息
      const errorMsg = this.analyzeAndFormatError(error, selectedModel);
      yield { type: 'error', error: errorMsg };
    }
  }
}
