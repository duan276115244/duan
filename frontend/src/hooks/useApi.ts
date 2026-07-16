import { useState, useCallback, useEffect, useRef } from 'react';
import type { SystemStatus, ModelInfo, AgentInfo, ToolInfo, BackendConfig, ChatEvent } from '@/types';

// ============ Electron 环境检测 ============

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

// ============ 全局请求配置（Web 模式） ============

const REQUEST_TIMEOUT = 120000; // 120秒超时

/** 带超时和全局错误处理的 fetch 封装（仅 Web 模式使用） */
async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    });

    if (response.status === 401) {
      window.location.href = '/config';
      throw new Error('未授权，请配置 API Key');
    }

    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============ API Hooks ============

/** 系统状态 */
export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      if (isElectron()) {
        const data = await window.electronAPI!.system.status();
        // 将 Electron 系统状态映射为前端 SystemStatus 格式
        setStatus({
          version: data.version || data.appVersion || '加载中',
          mode: data.mode || 'desktop',
          skills: data.skills ?? 0,
          activeModels: data.model || 'unknown',
          uptime: data.uptime || 0,
          conversations: data.conversations ?? 0,
          toolsAvailable: data.toolsAvailable ?? 0,
          features: {
            smartDetection: data.features?.smartDetection ?? false,
            multiAgent: data.features?.multiAgent ?? false,
            streaming: data.features?.streaming ?? false,
            toolCalling: data.features?.toolCalling ?? false,
            conversationManagement: data.features?.conversationManagement ?? false,
            consciousness: data.features?.consciousness ?? false,
            goalSystem: data.features?.goalSystem ?? false,
            heartbeat: data.features?.heartbeat ?? false,
            subAgents: data.features?.subAgents ?? false,
          },
          consciousness: {
            mood: data.consciousness?.mood || 'neutral',
            consciousness: data.consciousness?.consciousness ?? 0,
            focus: data.consciousness?.focus ?? 0,
            energy: data.consciousness?.energy ?? 0,
            curiosity: data.consciousness?.curiosity ?? 0,
            moodDescription: data.consciousness?.moodDescription || '加载中',
          },
          selfAwareness: {
            evolutionLevel: data.selfAwareness?.evolutionLevel || 'desktop',
            capabilities: data.selfAwareness?.capabilities || [],
            totalTasks: data.selfAwareness?.totalTasks ?? 0,
          },
          goals: { total: data.goals?.total ?? 0, active: data.goals?.active ?? 0 },
          heartbeat: { running: data.heartbeat?.running || data.agentRunning || false, beatCount: data.heartbeat?.beatCount ?? 0 },
        });
      } else {
        const response = await apiFetch('/api/status');
        if (response.ok) {
          const data = await response.json();
          setStatus(data);
        }
      }
    } catch (error) {
      console.warn('获取系统状态失败:', error);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return status;
}

/** 模型列表 */
export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true);
      if (isElectron()) {
        const data = await window.electronAPI!.model.list();
        const modelList = Array.isArray(data) ? data : (data.models || []);
        setModels(modelList.map((m: { id: string; name: string; provider: string }) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          status: 'available',
        })));
      } else {
        const response = await apiFetch('/api/models');
        if (response.ok) {
          const data = await response.json();
          setModels(Array.isArray(data) ? data : (data.models || []));
        }
      }
    } catch (error) {
      console.warn('获取模型列表失败:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchModels(); }, [fetchModels]);
  return { models, loading, refresh: fetchModels };
}

/** Agent列表 */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const fetchAgents = useCallback(async () => {
    try {
      if (isElectron()) {
        // Electron 模式下通过 IPC 获取多Agent列表
        const result = await window.electronAPI!.agent.list();
        if (result.success && Array.isArray(result.agents)) {
          setAgents(result.agents);
        } else {
          setAgents([{
            id: 'default',
            name: '段先生',
            description: '桌面模式智能助手',
            expertise: ['通用对话', '代码辅助', '文件操作'],
            status: 'active',
          }]);
        }
      } else {
        const response = await apiFetch('/api/agents');
        if (response.ok) {
          const data = await response.json();
          setAgents(Array.isArray(data) ? data : (data.agents || []));
        }
      }
    } catch (error) {
      console.warn('获取Agent列表失败:', error);
      setAgents([{
        id: 'default',
        name: '段先生',
        description: '桌面模式智能助手',
        expertise: ['通用对话', '代码辅助', '文件操作'],
        status: 'active',
      }]);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);
  return { agents, refresh: fetchAgents };
}

/** 工具列表 */
export function useTools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);

  const fetchTools = useCallback(async () => {
    try {
      if (isElectron()) {
        // Electron 模式下返回基础工具列表
        setTools([
          { name: 'terminal', description: '执行终端命令', parameters: { command: { type: 'string', description: '要执行的命令', required: true } } },
          { name: 'browser', description: '浏览器操作', parameters: { url: { type: 'string', description: 'URL地址', required: true } } },
        ]);
      } else {
        const response = await apiFetch('/api/tools');
        if (response.ok) {
          const data = await response.json();
          setTools(Array.isArray(data) ? data : (data.tools || []));
        }
      }
    } catch (error) {
      console.warn('获取工具列表失败:', error);
    }
  }, []);

  useEffect(() => { fetchTools(); }, [fetchTools]);
  return { tools, refresh: fetchTools };
}

/** 配置管理 */
export function useConfig() {
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      if (isElectron()) {
        const data = await window.electronAPI!.config.load();
        // 将 Electron 配置映射为前端 BackendConfig 格式
        setConfig({
          apiKeys: data.apiKeys || {},
          defaultModel: data.model || data.defaultModel || 'deepseek-chat',
          defaultProvider: data.apiProvider || data.defaultProvider || 'deepseek',
          providerModels: data.providerModels || {},
          settings: {
            smartDetection: data.settings?.smartDetection ?? true,
            multiAgent: data.settings?.multiAgent ?? false,
            autoSaveMemory: data.settings?.autoSaveMemory ?? true,
          },
        });
      } else {
        const response = await apiFetch('/api/config');
        if (response.ok) {
          const data = await response.json();
          setConfig(data);
        }
      }
    } catch (error) {
      console.warn('获取配置失败:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const saveConfig = useCallback(async (newConfig: { apiKeys: Record<string, string>; defaultModel?: string; defaultProvider?: string; providerModels?: Record<string, string>; settings?: Record<string, unknown>; customBaseURL?: string; customModel?: string }) => {
    try {
      if (isElectron()) {
        await window.electronAPI!.config.save(newConfig);
        await fetchConfig();
        return true;
      } else {
        const response = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newConfig),
        });
        if (response.ok) {
          await fetchConfig();
          return true;
        }
        return false;
      }
    } catch (error) {
      console.error('保存配置失败:', error);
      return false;
    }
  }, [fetchConfig]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // B3 修复：订阅 model:changed 事件，供应商切换时自动刷新配置（TitleBar/ChatArea 实时更新）
  useEffect(() => {
    if (!isElectron()) return;
    const cleanup = window.electronAPI?.model?.onChanged?.(() => {
      fetchConfig();
    });
    return () => cleanup?.();
  }, [fetchConfig]);

  return { config, loading, saveConfig, refresh: fetchConfig };
}

/** 测试API Key */
export function useTestKey() {
  const [testing, setTesting] = useState(false);

  const testKey = useCallback(async (provider: string, apiKey: string, extra?: Record<string, string>): Promise<{ valid: boolean; message: string }> => {
    setTesting(true);
    try {
      if (isElectron()) {
        // Electron 模式：通过 IPC 调用 main.js 中的 test:api_key 进行真实验证
        if (!apiKey || apiKey.trim().length < 10) {
          return { valid: false, message: 'API Key 格式无效，长度不足' };
        }
        const baseURL = extra?.baseURL;
        const result = await window.electronAPI!.testApiKey(provider, apiKey, baseURL);
        return { valid: result.valid, message: result.message };
      } else {
        const response = await apiFetch('/api/test-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey, ...extra }),
        });
        const data = await response.json();
        return { valid: data.valid || data.success || false, message: data.message || data.error || '' };
      }
    } catch {
      return { valid: false, message: '测试请求失败' };
    } finally {
      setTesting(false);
    }
  }, []);

  return { testKey, testing };
}

/** 聊天流 - Electron 模式下通过 IPC 实现流式对话 */
export function useChatStream() {
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamUnsubscribeRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback(async (
    message: string,
    history: Array<{ role: string; content: string }>,
    onEvent: (event: ChatEvent) => void,
    onDone: () => void,
    model?: string,
    attachments?: Array<{ name: string; path: string; isImage: boolean; base64: string; mimeType: string; ext: string }>,
  ) => {
    // ===== Electron 模式：通过 IPC 实现流式对话 =====
    if (isElectron()) {
      let doneCalled = false;

      // 清理之前的流监听
      if (streamUnsubscribeRef.current) {
        streamUnsubscribeRef.current();
        streamUnsubscribeRef.current = null;
      }

      // 设置超时
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (streamUnsubscribeRef.current) {
          streamUnsubscribeRef.current();
          streamUnsubscribeRef.current = null;
        }
        onEvent({ type: 'error', content: '请求超时（120秒），请检查网络或API配置' });
        if (!doneCalled) { doneCalled = true; onDone(); } // P0 修复：设置 doneCalled 防止重复调用
      }, REQUEST_TIMEOUT);

      // 监听 Agent 流式输出
      streamUnsubscribeRef.current = window.electronAPI!.agent.onStream((data) => {
        // 收到流数据后清除超时
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }

        if (data.type === 'stdout') {
          // Agent 进程的 stdout 输出
          const text = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
          // 尝试解析为 SSE 格式的 JSON 事件
          const lines = text.split('\n').filter((l: string) => l.trim());
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') {
                onEvent({ type: 'done' });
                if (!doneCalled) { doneCalled = true; onDone(); }
                if (streamUnsubscribeRef.current) {
                  streamUnsubscribeRef.current();
                  streamUnsubscribeRef.current = null;
                }
                return;
              }
              try {
                const event = JSON.parse(payload);
                onEvent(event);
              } catch {
                onEvent({ type: 'text', content: payload });
              }
            } else {
              // 非 SSE 格式，直接作为文本输出
              try {
                const event = JSON.parse(line);
                onEvent(event);
              } catch {
                onEvent({ type: 'text', content: line });
              }
            }
          }
        } else if (data.type === 'stderr') {
          // stderr 输出，忽略或作为调试信息
          const text = typeof data.data === 'string' ? data.data : '';
          if (text.trim()) {
            console.debug('[Agent stderr]', text);
          }
        } else if (data.type === 'done') {
          onEvent({ type: 'done' });
          if (!doneCalled) { doneCalled = true; onDone(); }
          if (streamUnsubscribeRef.current) {
            streamUnsubscribeRef.current();
            streamUnsubscribeRef.current = null;
          }
        } else if (data.type === 'error') {
          onEvent({ type: 'error', content: data.content || data.data || data.message || 'Agent 错误' });
          if (!doneCalled) { doneCalled = true; onDone(); } // P0 修复：检查 doneCalled 防止重复调用
          if (streamUnsubscribeRef.current) {
            streamUnsubscribeRef.current();
            streamUnsubscribeRef.current = null;
          }
        } else {
          // 其他类型直接作为事件传递
          onEvent(data);
        }
      });

      // 发送消息给 Agent
      try {
        const result = await window.electronAPI!.agent.chat(message, history, model, attachments);

        if (!result?.success) {
          // P0 修复：检查 doneCalled 防止重复调用 onDone
          if (!doneCalled) {
            onEvent({ type: 'error', content: result?.error || '发送消息失败' });
            doneCalled = true;
            onDone();
          }
          if (streamUnsubscribeRef.current) {
            streamUnsubscribeRef.current();
            streamUnsubscribeRef.current = null;
          }
        }
      } catch (error: unknown) {
        if (!doneCalled) {
          onEvent({ type: 'error', content: `发送失败: ${error instanceof Error ? error.message : String(error)}` });
          doneCalled = true;
          onDone();
        }
        if (streamUnsubscribeRef.current) {
          streamUnsubscribeRef.current();
          streamUnsubscribeRef.current = null;
        }
      }

      return;
    }

    // ===== Web 模式：原有 HTTP fetch 流式对话逻辑 =====
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    // 设置超时（P2 修复：修正注释和错误消息，与实际 REQUEST_TIMEOUT 一致）
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    let webDoneCalled = false;
    timeoutRef.current = setTimeout(() => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      onEvent({ type: 'error', content: '请求超时（120秒），请稍后重试' });
      if (!webDoneCalled) { webDoneCalled = true; onDone(); } // P0 修复：防止重复调用
    }, REQUEST_TIMEOUT);

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, model }),
        signal: abortRef.current.signal,
      });

      if (response.status === 401) {
        window.location.href = '/config';
        onEvent({ type: 'error', content: '未授权，请配置 API Key' });
        if (!webDoneCalled) { webDoneCalled = true; onDone(); }
        return;
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        onEvent({ type: 'error', content: `请求失败: ${response.status} ${errData.error || ''}` });
        if (!webDoneCalled) { webDoneCalled = true; onDone(); }
        return;
      }

      // 收到响应后清除超时（流式响应可能持续较长时间）
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onEvent({ type: 'error', content: '无法读取响应流' });
        if (!webDoneCalled) { webDoneCalled = true; onDone(); }
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              onEvent({ type: 'done' });
              if (!webDoneCalled) { webDoneCalled = true; onDone(); }
              return;
            }
            try {
              const event = JSON.parse(data);
              onEvent(event);
            } catch {
              if (data) onEvent({ type: 'text', content: data });
            }
          }
        }
      }
      if (!webDoneCalled) { webDoneCalled = true; onDone(); }
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        onEvent({ type: 'error', content: `连接错误: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (!webDoneCalled) { webDoneCalled = true; onDone(); }
    } finally {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  }, []);

  const abort = useCallback(() => {
    // Web 模式：中止 fetch
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    // Electron 模式：停止 Agent
    if (isElectron() && window.electronAPI) {
      window.electronAPI.agent.onStop().catch(() => {});
    }
    // 清理流监听
    if (streamUnsubscribeRef.current) {
      streamUnsubscribeRef.current();
      streamUnsubscribeRef.current = null;
    }
    // 清理超时
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  // P0-1 修复：组件卸载时清理所有进行中的请求，防止内存泄漏
  useEffect(() => {
    return () => {
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      if (streamUnsubscribeRef.current) {
        streamUnsubscribeRef.current();
        streamUnsubscribeRef.current = null;
      }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
  }, []);

  return { sendMessage, abort };
}

/** 对话管理 */
export function useConversations() {
  const [conversations, setConversations] = useState<unknown[]>([]);

  const fetchConversations = useCallback(async () => {
    try {
      if (isElectron()) {
        // Electron 模式下对话存储在 localStorage（由 zustand 管理），不从后端获取
        setConversations([]);
      } else {
        const response = await apiFetch('/api/conversations');
        if (response.ok) {
          const data = await response.json();
          setConversations(Array.isArray(data) ? data : (data.conversations || []));
        }
      }
    } catch (error) {
      console.warn('获取对话列表失败:', error);
    }
  }, []);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);
  return { conversations, refresh: fetchConversations };
}
