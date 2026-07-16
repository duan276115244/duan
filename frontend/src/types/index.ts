// ===== 消息与对话 =====
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  thinking?: string;
  toolCalls?: Array<{ name: string; args?: unknown; result?: string; duration?: number; status?: 'running' | 'success' | 'error' }>;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

// ===== 系统状态（匹配后端 /api/status） =====
export interface SystemStatus {
  version: string;
  mode: string;
  skills: number;
  activeModels: string;
  uptime: number;
  conversations: number;
  toolsAvailable: number;
  features: {
    smartDetection: boolean;
    multiAgent: boolean;
    streaming: boolean;
    toolCalling: boolean;
    conversationManagement: boolean;
    consciousness: boolean;
    goalSystem: boolean;
    heartbeat: boolean;
    subAgents: boolean;
  };
  consciousness: {
    mood: string;
    consciousness: number;
    focus: number;
    energy: number;
    curiosity: number;
    moodDescription: string;
  };
  selfAwareness: {
    evolutionLevel: string;
    capabilities: Array<{ name: string; level: number }>;
    totalTasks: number;
  };
  goals: {
    total: number;
    active: number;
  };
  heartbeat: {
    running: boolean;
    beatCount: number;
  };
}

// ===== 模型与Agent =====
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  status: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  expertise: string[];
  status: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

// ===== 配置（匹配后端 /api/config） =====
export interface BackendConfig {
  apiKeys: Record<string, string>;
  defaultModel: string;
  defaultProvider: string;
  providerModels?: Record<string, string>;
  settings: {
    smartDetection: boolean;
    multiAgent: boolean;
    autoSaveMemory: boolean;
  };
  customBaseURL?: string;
  customModel?: string;
}

// ===== 聊天事件 =====
export interface ChatEvent {
  type: 'text' | 'think' | 'tool_call' | 'tool_result' | 'agent_switch' | 'done' | 'error' | 'warning' | 'compact' | 'plan';
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  agentId?: string;
  /** plan 事件携带的结构化计划对象（仅 type='plan' 时有值） */
  plan?: Record<string, unknown>;
}

// ===== 主题 =====
export interface Theme {
  id: 'dark' | 'light' | 'emerald';
  name: string;
  icon: string;
}
