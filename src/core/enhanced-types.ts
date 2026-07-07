/**
 * J.A.R.V.I.S. 增强版类型定义
 */

export type ModelProvider = 
  | 'claude' 
  | 'openai' 
  | 'ollama'
  | 'gemini'
  | 'mistral'
  | 'anthropic'
  | 'groq'
  | 'cohere';

export type ModelType = 
  | 'claude-3-opus' 
  | 'claude-3-sonnet' 
  | 'claude-3-haiku'
  | 'claude-3-5-sonnet'
  | 'gpt-4' 
  | 'gpt-4-turbo' 
  | 'gpt-3.5-turbo'
  | 'gemini-pro' 
  | 'gemini-ultra'
  | 'llama3' 
  | 'llama2' 
  | 'mistral'
  | string;

export interface ModelConfig {
  provider: ModelProvider;
  model: ModelType;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
}

/**
 * ModelConfig 采样参数的取值范围约束
 */
export const MODEL_CONFIG_CONSTRAINTS = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxTokens: { min: 1 },
} as const;

/**
 * 校验 ModelConfig 的采样参数是否在合法范围内
 * @param config 待校验的模型配置
 * @returns 错误信息数组（为空表示校验通过）
 */
export function validateModelConfig(config: ModelConfig): string[] {
  const errors: string[] = [];

  if (config.temperature !== undefined) {
    const { min, max } = MODEL_CONFIG_CONSTRAINTS.temperature;
    if (
      typeof config.temperature !== 'number' ||
      Number.isNaN(config.temperature) ||
      config.temperature < min ||
      config.temperature > max
    ) {
      errors.push(
        `temperature 必须为 ${min}-${max} 之间的数字，当前值: ${config.temperature}`
      );
    }
  }

  if (config.topP !== undefined) {
    const { min, max } = MODEL_CONFIG_CONSTRAINTS.topP;
    if (
      typeof config.topP !== 'number' ||
      Number.isNaN(config.topP) ||
      config.topP < min ||
      config.topP > max
    ) {
      errors.push(
        `topP 必须为 ${min}-${max} 之间的数字，当前值: ${config.topP}`
      );
    }
  }

  if (config.maxTokens !== undefined) {
    const { min } = MODEL_CONFIG_CONSTRAINTS.maxTokens;
    if (
      typeof config.maxTokens !== 'number' ||
      Number.isNaN(config.maxTokens) ||
      !Number.isInteger(config.maxTokens) ||
      config.maxTokens < min
    ) {
      errors.push(
        `maxTokens 必须为不小于 ${min} 的整数，当前值: ${config.maxTokens}`
      );
    }
  }

  return errors;
}

/**
 * 断言 ModelConfig 合法，若存在非法采样参数则抛出错误。
 * 可在构造层（如创建模型客户端前）调用，避免传入非法参数。
 * @param config 待校验的模型配置
 * @returns 校验通过的原始配置
 */
export function assertValidModelConfig(config: ModelConfig): ModelConfig {
  const errors = validateModelConfig(config);
  if (errors.length > 0) {
    throw new Error(`无效的 ModelConfig 采样参数:\n- ${errors.join('\n- ')}`);
  }
  return config;
}

// 图像生成配置
export interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  numImages?: number;
  model?: string;
  style?: string;
}

export interface ImageResult {
  success: boolean;
  images: string[];
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
}

// 视频生成配置
export interface VideoGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  duration?: number; // 秒
  fps?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3';
  model?: string;
  style?: string;
  referenceImage?: string;
  referenceVideo?: string;
}

export interface VideoResult {
  success: boolean;
  videoUrl?: string;
  videoPath?: string;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
}

// 工具扩展
export interface EnhancedTool {
  name: string;
  description: string;
  category: 'file' | 'command' | 'web' | 'image' | 'video' | 'ai' | 'system';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: any) => Promise<any>;
}

// Agent 配置
export interface AgentConfig {
  name: string;
  role: string;
  expertise: string[];
  model?: ModelConfig;
  systemPrompt?: string;
  tools?: string[];
}

// 多Agent 任务
export interface MultiAgentTask {
  id: string;
  description: string;
  agents: AgentConfig[];
  taskType: 'sequential' | 'parallel' | 'hierarchical';
  outputFormat?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: any;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolResults?: any;
  timestamp?: Date;
}
