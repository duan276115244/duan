import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Save, CheckCircle, XCircle, Loader2, Bot, Globe, Cpu, Zap, Wifi, WifiOff, Trash2, Sparkles, History, RotateCcw, Mic, ChevronRight } from 'lucide-react';
import { useConfig, useModels, useTestKey } from '@/hooks/useApi';
import type { ModelInfo } from '@/types';

const PROVIDERS = [
  // ===== 国际主流 =====
  { key: 'openai', label: 'OpenAI', color: '#10b981', placeholder: 'sk-...', category: '国际' },
  { key: 'anthropic', label: 'Anthropic', color: '#f59e0b', placeholder: 'sk-ant-...', category: '国际' },
  { key: 'deepseek', label: 'DeepSeek', color: '#06b6d4', placeholder: 'sk-...', category: '国际' },
  { key: 'gemini', label: 'Google Gemini', color: '#3b82f6', placeholder: 'AIza...', category: '国际' },
  { key: 'mistral', label: 'Mistral AI', color: '#f97316', placeholder: '...', category: '国际' },
  { key: 'xai', label: 'xAI (Grok)', color: '#8b5cf6', placeholder: 'xai-...', category: '国际' },
  { key: 'cohere', label: 'Cohere', color: '#ec4899', placeholder: '...', category: '国际' },
  { key: 'perplexity', label: 'Perplexity', color: '#14b8a6', placeholder: 'pplx-...', category: '国际' },
  // ===== 聚合平台 =====
  { key: 'openrouter', label: 'OpenRouter', color: '#a78bfa', placeholder: 'sk-or-...', category: '聚合' },
  { key: 'groq', label: 'Groq', color: '#f55036', placeholder: 'gsk_...', category: '聚合' },
  { key: 'together', label: 'Together AI', color: '#3b82f6', placeholder: '...', category: '聚合' },
  { key: 'fireworks', label: 'Fireworks AI', color: '#8b5cf6', placeholder: '...', category: '聚合' },
  { key: 'siliconflow', label: 'SiliconFlow', color: '#06b6d4', placeholder: 'sk-...', category: '聚合' },
  // ===== 国内主流 =====
  { key: 'qwen', label: '阿里通义千问', color: '#6366f1', placeholder: 'sk-...', category: '国内' },
  { key: 'zhipu', label: '智谱 GLM', color: '#06b6d4', placeholder: '...', category: '国内' },
  { key: 'doubao', label: '字节豆包 (火山引擎)', color: '#ec4899', placeholder: 'ark-... 接入密钥', category: '国内' },
  { key: 'doubao-coding', label: '火山引擎 Coding Plan', color: '#f97316', placeholder: 'ark-... 接入密钥', category: '国内' },
  { key: 'doubao-agent', label: '火山 Agent', color: '#ef4444', placeholder: 'ark-... 接入密钥', category: '国内' },
  { key: 'ernie', label: '百度文心', color: '#3b82f6', placeholder: '...', category: '国内' },
  { key: 'moonshot', label: '月之暗面 Kimi', color: '#8b5cf6', placeholder: 'sk-...', category: '国内' },
  { key: 'minimax', label: 'MiniMax 海螺AI', color: '#f59e0b', placeholder: '...', category: '国内' },
  { key: 'stepfun', label: '阶跃星辰', color: '#06b6d4', placeholder: 'sk-...', category: '国内' },
  { key: 'baichuan', label: '百川智能', color: '#10b981', placeholder: 'sk-...', category: '国内' },
  { key: 'yi', label: '零一万物', color: '#3b82f6', placeholder: 'sk-...', category: '国内' },
  { key: 'sensenova', label: '商汤日日新', color: '#8b5cf6', placeholder: '...', category: '国内' },
  { key: 'agnes', label: 'Agnes AI', color: '#a78bfa', placeholder: 'agnes-...', category: '国内' },
  // ===== 自定义 API =====
  { key: 'custom', label: '自定义 API (OpenAI 兼容)', color: '#f59e0b', placeholder: 'API Key', category: '自定义' },
  // ===== 本地部署 =====
  { key: 'ollama', label: 'Ollama 本地', color: '#64748b', placeholder: 'http://localhost:11434', category: '本地' },
];

const CATEGORIES = ['国际', '聚合', '国内', '自定义', '本地'];

/**
 * P1-2 修复：输入校验工具函数
 * 防止注入攻击、空格污染、超长输入、非法 URL
 */
const MAX_KEY_LEN = 1024;
const MAX_URL_LEN = 512;
const MAX_MODEL_LEN = 128;

function sanitizeKey(key: string): { ok: boolean; error?: string; value?: string } {
  if (!key) return { ok: false, error: '密钥不能为空' };
  const trimmed = key.trim();
  if (trimmed.length < 3) return { ok: false, error: '密钥长度过短（至少 3 个字符）' };
  if (trimmed.length > MAX_KEY_LEN) return { ok: false, error: `密钥长度超限（最多 ${MAX_KEY_LEN} 个字符）` };
  // 禁止空格、换行、控制字符
  if (/\s/.test(trimmed)) return { ok: false, error: '密钥不能包含空格或换行' };
  // eslint-disable-next-line no-control-regex -- 控制字符校验是必须的
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, error: '密钥不能包含控制字符' };
  // 禁止明显的脚本注入
  if (/<script|javascript:|on\w+\s*=/i.test(trimmed)) return { ok: false, error: '密钥包含非法字符' };
  return { ok: true, value: trimmed };
}

function sanitizeUrl(url: string): { ok: boolean; error?: string; value?: string } {
  if (!url) return { ok: false, error: 'URL 不能为空' };
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LEN) return { ok: false, error: `URL 长度超限（最多 ${MAX_URL_LEN} 个字符）` };
  if (/\s/.test(trimmed)) return { ok: false, error: 'URL 不能包含空格' };
  // 必须是 http/https/file URL
  if (!/^https?:\/\/|^file:\/\//i.test(trimmed)) {
    return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  }
  // 简单的 URL 格式校验
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    return { ok: false, error: 'URL 格式不合法' };
  }
  return { ok: true, value: trimmed };
}

function sanitizeModelName(name: string): { ok: boolean; error?: string; value?: string } {
  if (!name) return { ok: false, error: '模型名称不能为空' };
  const trimmed = name.trim();
  if (trimmed.length < 1) return { ok: false, error: '模型名称不能为空' };
  if (trimmed.length > MAX_MODEL_LEN) return { ok: false, error: `模型名称超限（最多 ${MAX_MODEL_LEN} 个字符）` };
  // 允许字母、数字、点、横线、下划线、斜线、冒号
  if (!/^[a-zA-Z0-9._\-/:]+$/.test(trimmed)) {
    return { ok: false, error: '模型名称只能包含字母、数字、._-/: 字符' };
  }
  return { ok: true, value: trimmed };
}

function sanitizeEndpointId(id: string): { ok: boolean; error?: string; value?: string } {
  if (!id) return { ok: false, error: '接入点 ID 不能为空' };
  const trimmed = id.trim();
  if (trimmed.length < 3) return { ok: false, error: '接入点 ID 长度过短' };
  if (trimmed.length > MAX_MODEL_LEN) return { ok: false, error: '接入点 ID 长度超限' };
  if (/\s/.test(trimmed)) return { ok: false, error: '接入点 ID 不能包含空格' };
  // 允许字母、数字、横线、下划线、点、斜线
  if (!/^[a-zA-Z0-9._\-/]+$/.test(trimmed)) {
    return { ok: false, error: '接入点 ID 包含非法字符' };
  }
  return { ok: true, value: trimmed };
}

// 自我改进备份条目（与 electron.d.ts selfImprove.listBackups 返回结构一致）
interface SelfImproveBackup {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

// MCP 市场插件条目
interface McpPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  type?: string;
  enabled?: boolean;
}

// MCP 市场统计信息
interface McpStatsInfo {
  total: number;
  mcpServers: number;
  toolBundles: number;
  enabled: number;
}

// MCP 插件操作（安装/卸载/启停）返回结果
interface McpActionResult {
  success?: boolean;
  message?: string;
  error?: string;
}

export function ConfigPage({ onBack }: { onBack?: () => void }) {
  const { config, loading: configLoading, saveConfig, refresh: refreshConfig } = useConfig();
  const { models, loading: modelsLoading } = useModels();
  const { testKey, testing } = useTestKey();

  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [newApiKeys, setNewApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string>>({});
  const [customBaseURL, setCustomBaseURL] = useState<string>('');
  const [customModel, setCustomModel] = useState<string>('');
  const [keyStatus, setKeyStatus] = useState<Record<string, 'idle' | 'testing' | 'valid' | 'invalid'>>({});
  const [connectionStatus, setConnectionStatus] = useState<Record<string, 'connected' | 'connecting' | 'disconnected'>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('国际');
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // ===== 自我改进状态 =====
  const [selfImproveEnabled, setSelfImproveEnabled] = useState(false);
  const [selfImproveHistory, setSelfImproveHistory] = useState<unknown[]>([]);
  const [selfImproveBackups, setSelfImproveBackups] = useState<SelfImproveBackup[]>([]);
  const [selfImproveLoading, setSelfImproveLoading] = useState(false);
  // ===== i18n 语种状态 =====
  const [locale, setLocaleState] = useState<string>('zh-CN');
  // F2: 立即执行 evolve cycle 状态
  const [evolveRunning, setEvolveRunning] = useState(false);
  const [evolveResult, setEvolveResult] = useState<{ type: 'success' | 'error'; text: string; details?: string } | null>(null);
  // D-MCP: MCP 插件市场状态
  const [mcpPlugins, setMcpPlugins] = useState<McpPlugin[]>([]);
  const [mcpInstalled, setMcpInstalled] = useState<Set<string>>(new Set());
  const [mcpStats, setMcpStats] = useState<McpStatsInfo | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpSearch, setMcpSearch] = useState('');
  const [mcpAction, setMcpAction] = useState<string | null>(null);

  // P2 修复：跟踪所有 setTimeout 定时器，组件卸载时清理避免内存泄漏
  const messageTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearMessageLater = (ms: number) => {
    const t = setTimeout(() => setMessage(''), ms);
    messageTimers.current.push(t);
  };
  useEffect(() => () => { messageTimers.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    if (config) {
      setSelectedModel(config.defaultModel || '');
      setSelectedProvider(config.defaultProvider || '');
      if (config.providerModels) {
        setProviderModels(config.providerModels);
      }
      if (config.customBaseURL) {
        setCustomBaseURL(config.customBaseURL);
      }
      if (config.customModel) {
        setCustomModel(config.customModel);
      }
    }
  }, [config]);

  // 选择 doubao-coding 时自动填充 baseURL
  useEffect(() => {
    if (selectedProvider === 'doubao-coding' && !customBaseURL) {
      setCustomBaseURL('https://ark.cn-beijing.volces.com/api/coding/v3');
    }
  }, [selectedProvider, customBaseURL]);

  // ===== 加载自我改进状态 =====
  const loadSelfImproveStatus = async () => {
    const api = window.electronAPI;
    if (!api?.selfImprove) return;
    try {
      setSelfImproveLoading(true);
      const [statusRes, historyRes, backupsRes] = await Promise.all([
        api.selfImprove.getStatus(),
        api.selfImprove.getHistory(20),
        api.selfImprove.listBackups(),
      ]);
      if (statusRes?.success) setSelfImproveEnabled(!!statusRes.enabled);
      if (historyRes?.success) setSelfImproveHistory(historyRes.history || []);
      if (backupsRes?.success) setSelfImproveBackups(backupsRes.backups || []);
    } catch {
      // 忽略
    } finally {
      setSelfImproveLoading(false);
    }
  };

  useEffect(() => {
    loadSelfImproveStatus();
    // 加载当前语种偏好
    const api0 = window.electronAPI;
    if (api0?.i18n?.getLocale) {
      api0.i18n.getLocale().then((r: { success?: boolean; locale?: string }) => {
        if (r?.success && r.locale) setLocaleState(r.locale);
      }).catch(() => {});
    }
  }, []);

  const handleToggleSelfImprove = async () => {
    const api = window.electronAPI;
    if (!api?.selfImprove) {
      setMessage('当前环境不支持自我改进（需 Electron 桌面端）');
      clearMessageLater(4000);
      return;
    }
    const next = !selfImproveEnabled;
    const res = await api.selfImprove.setEnabled(next);
    if (res?.success) {
      setSelfImproveEnabled(next);
      setMessage(next ? '自我改进已启用 — Agent 可搜索网络并提议代码修改（每次修改需你批准）' : '自我改进已禁用');
      clearMessageLater(4000);
    } else {
      setMessage(res?.error || '自我改进开关设置失败，请检查配置文件权限');
      clearMessageLater(4000);
    }
  };

  const handleRollback = async (backupPath: string) => {
    const api = window.electronAPI;
    if (!api?.selfImprove) return;
    const res = await api.selfImprove.rollback(backupPath);
    if (res?.success) {
      setMessage(`已回滚: ${res.restoredFile}`);
      loadSelfImproveStatus();
    } else {
      setMessage(res?.error || '回滚失败');
    }
    clearMessageLater(4000);
  };

  // F2: 立即执行一次 evolve cycle（含 tsc + vitest 护栏，失败自动回滚）
  const handleRunEvolve = async () => {
    const api = window.electronAPI;
    if (!api?.selfImprove?.run) {
      setEvolveResult({ type: 'error', text: '当前环境不支持自我改进执行（需 Electron 桌面端）' });
      return;
    }
    if (!selfImproveEnabled) {
      setEvolveResult({ type: 'error', text: '请先启用自我改进开关' });
      return;
    }
    const focus = window.prompt('可选：本次自我改进的关注点（留空则全面优化）', '');
    if (focus === null) return; // 用户取消
    setEvolveRunning(true);
    setEvolveResult(null);
    try {
      const res = await api.selfImprove.run(focus.trim() || undefined);
      if (res?.success) {
        setEvolveResult({
          type: 'success',
          text: '自我改进执行成功',
          details: typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2)?.substring(0, 500),
        });
        // 刷新历史和备份列表
        loadSelfImproveStatus();
      } else {
        setEvolveResult({ type: 'error', text: res?.error || '执行失败', details: typeof res?.result === 'string' ? res.result : undefined });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setEvolveResult({ type: 'error', text: msg || '执行异常' });
    } finally {
      setEvolveRunning(false);
    }
  };

  // D-MCP: 加载 MCP 市场数据
  const loadMcpMarketplace = async () => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    setMcpLoading(true);
    try {
      if (isE) {
        const api = window.electronAPI;
        if (api?.mcp) {
          const [listRes, installedRes, statsRes] = await Promise.all([
            api.mcp.listMarketplace(),
            api.mcp.listInstalled(),
            api.mcp.getStats(),
          ]);
          if (listRes?.success) setMcpPlugins(listRes.plugins || []);
          if (installedRes?.success) {
            const installedSet = new Set<string>();
            for (const p of (installedRes.plugins || [])) installedSet.add(p.id);
            setMcpInstalled(installedSet);
          }
          if (statsRes?.success) {
            const { success, ...rest } = statsRes;
            setMcpStats(rest as McpStatsInfo);
          }
        }
      } else {
        const [listRes, installedRes, statsRes] = await Promise.all([
          fetch('/api/mcp/marketplace/list').then(r => r.json()),
          fetch('/api/mcp/marketplace/installed').then(r => r.json()),
          fetch('/api/mcp/marketplace/stats').then(r => r.json()),
        ]);
        if (listRes?.success) setMcpPlugins(listRes.plugins || []);
        if (installedRes?.success) {
          const installedSet = new Set<string>();
          for (const p of (installedRes.plugins || [])) installedSet.add(p.id);
          setMcpInstalled(installedSet);
        }
        if (statsRes?.success) {
          const { success, ...rest } = statsRes;
          setMcpStats(rest as McpStatsInfo);
        }
      }
    } catch {
      // 忽略
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    loadMcpMarketplace();
  }, []);

  // D-MCP: 安装/卸载/启停 插件
  const handleMcpAction = async (action: 'install' | 'uninstall' | 'enable' | 'disable', pluginId: string) => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    setMcpAction(`${action}:${pluginId}`);
    try {
      let res: McpActionResult;
      if (isE) {
        const api = window.electronAPI;
        if (!api?.mcp) return;
        if (action === 'install') res = await api.mcp.installPlugin(pluginId);
        else if (action === 'uninstall') res = await api.mcp.uninstallPlugin(pluginId);
        else res = await api.mcp.enablePlugin(pluginId, action === 'enable');
      } else {
        const url = action === 'install' ? `/api/mcp/marketplace/install/${pluginId}`
          : action === 'uninstall' ? `/api/mcp/marketplace/uninstall/${pluginId}`
          : `/api/mcp/marketplace/enable/${pluginId}`;
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: action === 'enable' || action === 'disable' ? JSON.stringify({ enabled: action === 'enable' }) : '{}',
        }).then(r => r.json());
      }
      if (res?.success) {
        setMessage(res.message || `操作成功: ${action} ${pluginId}`);
        clearMessageLater(3000);
        await loadMcpMarketplace(); // 刷新列表
      } else {
        setMessage(res?.error || `操作失败: ${action} ${pluginId}`);
        clearMessageLater(4000);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage(msg);
      clearMessageLater(4000);
    } finally {
      setMcpAction(null);
    }
  };

  const groupedModels = models.reduce<Record<string, ModelInfo[]>>((acc, model) => {
    const provider = model.provider || 'other';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {});

  const configuredProviders = config?.apiKeys
    ? Object.entries(config.apiKeys)
        .filter(([k, v]) => v === '已配置' || (typeof v === 'string' && v.length > 8) || (newApiKeys[k] && newApiKeys[k].length > 3))
        .map(([k]) => k)
    : [];

  const handleTestKey = async (provider: string) => {
    const key = newApiKeys[provider];
    if (!key) return;
    // P1-2 修复：测试前校验密钥
    const keyCheck = sanitizeKey(key);
    if (!keyCheck.ok) {
      setKeyStatus(prev => ({ ...prev, [provider]: 'invalid' }));
      setConnectionStatus(prev => ({ ...prev, [provider]: 'disconnected' }));
      setMessage(`密钥校验失败：${keyCheck.error}`);
      clearMessageLater(5000);
      return;
    }
    // P1-2 修复：custom 提供商校验 baseURL
    if (provider === 'custom') {
      const urlCheck = sanitizeUrl(customBaseURL);
      if (!urlCheck.ok) {
        setKeyStatus(prev => ({ ...prev, [provider]: 'invalid' }));
        setConnectionStatus(prev => ({ ...prev, [provider]: 'disconnected' }));
        setMessage(`Base URL 校验失败：${urlCheck.error}`);
        clearMessageLater(5000);
        return;
      }
    }
    setKeyStatus(prev => ({ ...prev, [provider]: 'testing' }));
    setConnectionStatus(prev => ({ ...prev, [provider]: 'connecting' }));
    const extra = provider === 'custom' ? { baseURL: customBaseURL } : undefined;
    const result = await testKey(provider, key, extra);
    setKeyStatus(prev => ({ ...prev, [provider]: result.valid ? 'valid' : 'invalid' }));
    setConnectionStatus(prev => ({ ...prev, [provider]: result.valid ? 'connected' : 'disconnected' }));
  };

  // 删除已配置的供应商（清除过期/失效的 API Key）
  const handleDeleteProvider = async (provider: string) => {
    setDeletingProvider(provider);
    try {
      const api = window.electronAPI;
      if (api?.config?.unified?.removeProfile) {
        // 调用后端删除 profile
        const result = await api.config.unified.removeProfile(provider);
        // 处理别名：doubao-coding 与 coding_plan 互通，需同时清理
        if (provider === 'doubao-coding' || provider === 'coding_plan') {
          const alias = provider === 'doubao-coding' ? 'coding_plan' : 'doubao-coding';
          await api.config.unified.removeProfile(alias).catch(() => {});
        }
        if (result?.success) {
          // 如果删除的是当前选中的 provider，清除选择
          if (selectedProvider === provider) {
            setSelectedProvider('');
          }
          // 清除该 provider 的本地状态
          setNewApiKeys(prev => { const n = { ...prev }; delete n[provider]; return n; });
          setKeyStatus(prev => { const n = { ...prev }; delete n[provider]; return n; });
          setConnectionStatus(prev => { const n = { ...prev }; delete n[provider]; return n; });
          setProviderModels(prev => { const n = { ...prev }; delete n[provider]; return n; });
          setMessage(`已删除供应商 ${provider} 的配置`);
          // 刷新配置
          await refreshConfig();
        } else {
          setMessage(`删除失败：${result?.message || '未知错误'}`);
        }
      } else {
        setMessage('当前环境不支持删除配置');
      }
    } catch (err: unknown) {
      setMessage(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingProvider(null);
      setConfirmDelete(null);
      clearMessageLater(5000);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    // P1-2 修复：保存前对所有输入进行校验
    const apiKeysToSend: Record<string, string> = {};
    for (const [provider, key] of Object.entries(newApiKeys)) {
      if (key && key.trim() && key !== '已配置' && key !== '未配置') {
        const keyCheck = sanitizeKey(key);
        if (!keyCheck.ok) {
          setMessage(`提供商 ${provider} 密钥校验失败：${keyCheck.error}`);
          setSaving(false);
          clearMessageLater(5000);
          return;
        }
        apiKeysToSend[provider] = keyCheck.value!;
      }
    }

    // P1-2 修复：custom 提供商校验 baseURL 和模型名
    if (apiKeysToSend.custom || selectedProvider === 'custom') {
      if (customBaseURL) {
        const urlCheck = sanitizeUrl(customBaseURL);
        if (!urlCheck.ok) {
          setMessage(`Base URL 校验失败：${urlCheck.error}`);
          setSaving(false);
          clearMessageLater(5000);
          return;
        }
      }
      if (customModel) {
        const modelCheck = sanitizeModelName(customModel);
        if (!modelCheck.ok) {
          setMessage(`自定义模型名校验失败：${modelCheck.error}`);
          setSaving(false);
          clearMessageLater(5000);
          return;
        }
      }
    }

    // P1-2 修复：doubao/doubao-coding 接入点 ID 校验
    for (const epProvider of ['doubao', 'doubao-coding'] as const) {
      const epId = providerModels[epProvider];
      if (epId) {
        const epCheck = sanitizeEndpointId(epId);
        if (!epCheck.ok) {
          setMessage(`${epProvider} 接入点 ID 校验失败：${epCheck.error}`);
          setSaving(false);
          clearMessageLater(5000);
          return;
        }
      }
    }

    // P1-2 修复：默认模型名校验（如果选择了）
    if (selectedModel) {
      const modelCheck = sanitizeModelName(selectedModel);
      if (!modelCheck.ok) {
        setMessage(`默认模型名校验失败：${modelCheck.error}`);
        setSaving(false);
        clearMessageLater(5000);
        return;
      }
    }

    const success = await saveConfig({
      apiKeys: apiKeysToSend,
      defaultModel: selectedModel,
      defaultProvider: selectedProvider,
      providerModels: providerModels,
      customBaseURL: customBaseURL || undefined,
      customModel: customModel || undefined,
    });
    setSaving(false);
    if (success) {
      setMessage('配置保存成功！Agent 已激活。');
      setNewApiKeys({});
      setKeyStatus({});
    } else {
      setMessage('保存失败，请重试。');
    }
    clearMessageLater(5000);
  };

  if (configLoading || modelsLoading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <Loader2 style={{ width: 32, height: 32, color: '#06b6d4', margin: '0 auto 16px', animation: 'spin 1s linear infinite' }} />
          <p style={{ color: '#64748b', fontSize: 14 }}>加载配置中...</p>
        </div>
      </div>
    );
  }

  const filteredProviders = PROVIDERS.filter(p => p.category === activeCategory);

  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: '#0a0e1a' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: 28 }}>
        {/* Header - 玻璃态 */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {onBack && (
              <button onClick={onBack} style={{
                padding: 8, borderRadius: 10,
                background: 'rgba(255,255,255,.03)',
                border: '1px solid rgba(255,255,255,.08)',
                cursor: 'pointer', color: '#94a3b8',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(12px)',
                transition: 'all .15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
              >
                <ArrowLeft style={{ width: 16, height: 16 }} />
              </button>
            )}
            <div>
              <h1 className="gradient-text" style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>系统配置</h1>
              <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>选择模型 → 配置密钥 → 激活 Agent</p>
            </div>
          </div>
          <button onClick={handleSave} disabled={saving} className="btn-primary" style={{ padding: '10px 22px' }}>
            <Save style={{ width: 14, height: 14 }} />
            {saving ? '保存中...' : '保存并激活'}
          </button>
        </header>

        {message && (
          <div style={{
            marginBottom: 20, padding: 14, borderRadius: 12,
            background: message.includes('成功') ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)',
            border: `1px solid ${message.includes('成功') ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`,
            textAlign: 'center', fontSize: 14, color: '#e2e8f0',
            backdropFilter: 'blur(12px)',
          }}>
            {message}
          </div>
        )}

        {/* Step 1: 选择提供商并配置Key - 玻璃态卡片 */}
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700,
              boxShadow: '0 0 12px rgba(6,182,212,.3)',
            }}>1</div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>选择提供商并配置密钥</h2>
            <span style={{ fontSize: 11, color: '#475569', marginLeft: 8 }}>共 {PROVIDERS.length} 个提供商</span>
          </div>
          <p style={{ fontSize: 12, color: '#64748b', marginLeft: 38, marginBottom: 16 }}>选择AI提供商，输入API Key后点击测试验证</p>

          {/* 分类标签 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, marginLeft: 2, flexWrap: 'wrap' }}>
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                style={{
                  padding: '6px 14px', borderRadius: 18, fontSize: 12, fontWeight: 500,
                  border: activeCategory === cat ? '1px solid rgba(6,182,212,.35)' : '1px solid rgba(255,255,255,.06)',
                  background: activeCategory === cat ? 'rgba(6,182,212,.12)' : 'transparent',
                  color: activeCategory === cat ? '#67e8f9' : '#64748b',
                  cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'all .15s',
                }}
              >
                {cat === '国际' && <Globe style={{ width: 11, height: 11, display: 'inline', marginRight: 4, verticalAlign: -1 }} />}
                {cat === '聚合' && <Zap style={{ width: 11, height: 11, display: 'inline', marginRight: 4, verticalAlign: -1 }} />}
                {cat === '国内' && <Cpu style={{ width: 11, height: 11, display: 'inline', marginRight: 4, verticalAlign: -1 }} />}
                {cat === '本地' && <Bot style={{ width: 11, height: 11, display: 'inline', marginRight: 4, verticalAlign: -1 }} />}
                {cat}
              </button>
            ))}
          </div>

          {/* 提供商网格 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {filteredProviders.map((provider) => {
              const isConfigured = configuredProviders.includes(provider.key);
              const isSelected = selectedProvider === provider.key;
              const keyStatusVal = keyStatus[provider.key];
              const connStatus = connectionStatus[provider.key];
              // 连接状态颜色编码：绿色-已连接，黄色-连接中/待验证，红色-验证失败/未连接
              // 优先使用 keyStatus 判断：valid→绿，testing→黄，invalid→红
              // 已配置且未测试过的key默认显示已连接（保存即视为有效）
              const effectiveStatus: 'connected' | 'connecting' | 'disconnected' =
                keyStatusVal === 'valid' || connStatus === 'connected' ? 'connected' :
                keyStatusVal === 'testing' || connStatus === 'connecting' ? 'connecting' :
                keyStatusVal === 'invalid' ? 'disconnected' :
                isConfigured ? 'connected' : 'disconnected';
              const statusDotColor = effectiveStatus === 'connected' ? '#10b981' : effectiveStatus === 'connecting' ? '#f59e0b' : '#ef4444';
              const statusGlow = effectiveStatus === 'connected' ? '0 0 8px rgba(16,185,129,.5)' : effectiveStatus === 'connecting' ? '0 0 8px rgba(245,158,11,.5)' : '0 0 8px rgba(239,68,68,.3)';
              const statusLabel = effectiveStatus === 'connected' ? '已连接' : effectiveStatus === 'connecting' ? (isConfigured ? '待验证' : '连接中') : (keyStatusVal === 'invalid' ? '失败' : '未连接');
              return (
                <div key={provider.key} style={{
                  padding: 14, borderRadius: 12,
                  border: isSelected ? `1px solid ${provider.color}` : '1px solid rgba(255,255,255,.06)',
                  background: isSelected ? `${provider.color}0a` : 'rgba(255,255,255,.02)',
                  cursor: 'pointer', transition: 'all .15s',
                  overflow: 'hidden', wordBreak: 'break-all',
                }} onClick={() => {
                  // 点击卡片时取消其他卡片的删除确认状态
                  if (confirmDelete && confirmDelete !== provider.key) setConfirmDelete(null);
                  setSelectedProvider(provider.key);
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusDotColor, boxShadow: statusGlow, transition: 'all .3s', animation: effectiveStatus === 'connecting' ? 'status-pulse 2s infinite' : 'none' }} />
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>{provider.label}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {/* 状态文字标签 */}
                      <span style={{ fontSize: 9, color: statusDotColor, fontWeight: 500 }}>{statusLabel}</span>
                      {effectiveStatus === 'connected' && <Wifi style={{ width: 12, height: 12, color: '#10b981' }} />}
                      {effectiveStatus === 'connecting' && <Loader2 style={{ width: 12, height: 12, color: '#f59e0b', animation: 'spin 1s linear infinite' }} />}
                      {effectiveStatus === 'disconnected' && keyStatusVal === 'invalid' && <XCircle style={{ width: 12, height: 12, color: '#ef4444' }} />}
                      {isConfigured && effectiveStatus !== 'connected' && effectiveStatus !== 'disconnected' && <CheckCircle style={{ width: 14, height: 14, color: '#10b981' }} />}
                      {/* 删除按钮 — 仅已配置的供应商显示 */}
                      {isConfigured && (
                        confirmDelete === provider.key ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteProvider(provider.key); }}
                            disabled={deletingProvider === provider.key}
                            title="确认删除"
                            style={{
                              padding: '2px 6px', borderRadius: 5, border: '1px solid rgba(239,68,68,.4)',
                              background: 'rgba(239,68,68,.15)', cursor: 'pointer', fontFamily: 'inherit',
                              color: '#f87171', fontSize: 9, fontWeight: 600, display: 'flex',
                              alignItems: 'center', gap: 3, lineHeight: 1,
                            }}
                          >
                            {deletingProvider === provider.key
                              ? <Loader2 style={{ width: 10, height: 10, animation: 'spin 1s linear infinite' }} />
                              : <Trash2 style={{ width: 10, height: 10 }} />}
                            {deletingProvider === provider.key ? '删除中' : '确认删除'}
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(provider.key); }}
                            title="删除此供应商配置"
                            style={{
                              padding: 2, borderRadius: 5, border: 'none',
                              background: 'transparent', cursor: 'pointer', color: '#64748b',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              transition: 'all .15s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,.12)'; e.currentTarget.style.color = '#ef4444'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
                          >
                            <Trash2 style={{ width: 12, height: 12 }} />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                  {isSelected && (
                    <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="password"
                          value={newApiKeys[provider.key] || ''}
                          onChange={(e) => setNewApiKeys(prev => ({ ...prev, [provider.key]: e.target.value }))}
                          placeholder={isConfigured ? '已配置，输入新Key可替换' : provider.placeholder}
                          style={{
                            flex: 1, minWidth: 0, fontSize: 12, padding: '7px 10px',
                            background: 'rgba(255,255,255,.04)', borderRadius: 8,
                            border: '1px solid rgba(255,255,255,.08)', outline: 'none',
                            color: '#e2e8f0', fontFamily: 'inherit',
                            transition: 'border-color .15s',
                          }}
                          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(6,182,212,.3)'; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
                        />
                        <button
                          onClick={() => handleTestKey(provider.key)}
                          disabled={!newApiKeys[provider.key] && !isConfigured || testing}
                          style={{
                            padding: '5px 10px', borderRadius: 8,
                            background: 'rgba(6,182,212,.08)',
                            border: '1px solid rgba(6,182,212,.15)',
                            color: '#94a3b8', cursor: 'pointer', fontSize: 11,
                            whiteSpace: 'nowrap', fontFamily: 'inherit',
                            flexShrink: 0,
                            transition: 'all .15s',
                          }}
                        >
                          {keyStatusVal === 'testing' || testing ? <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} /> :
                           keyStatusVal === 'valid' ? <CheckCircle style={{ width: 12, height: 12, color: '#10b981' }} /> :
                           keyStatusVal === 'invalid' ? <XCircle style={{ width: 12, height: 12, color: '#ef4444' }} /> :
                           '测试连接'}
                        </button>
                      </div>
                      {/* 火山引擎需要额外输入接入点ID */}
                      {provider.key === 'doubao' && (
                        <div style={{ marginTop: 8 }}>
                          <input
                            type="text"
                            value={providerModels[provider.key] || ''}
                            onChange={(e) => setProviderModels(prev => ({ ...prev, [provider.key]: e.target.value }))}
                            placeholder="接入点ID (ep-xxxxxxxxxxxx)"
                            style={{
                              width: '100%', fontSize: 12, padding: '7px 10px',
                              background: 'rgba(236,72,153,.06)', borderRadius: 8,
                              border: '1px solid rgba(236,72,153,.15)', outline: 'none',
                              color: '#e2e8f0', fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                          <p style={{ fontSize: 10, color: '#64748b', margin: '4px 0 0' }}>
                            在火山引擎方舟控制台创建接入点后，复制接入点ID填入此处
                          </p>
                        </div>
                      )}
                      {/* 火山引擎 Coding Plan 需要接入点ID和baseURL */}
                      {provider.key === 'doubao-coding' && (
                        <div style={{ marginTop: 8 }}>
                          <input
                            type="text"
                            value={providerModels[provider.key] || ''}
                            onChange={(e) => setProviderModels(prev => ({ ...prev, [provider.key]: e.target.value }))}
                            placeholder="接入点ID (ep-xxxxxxxxxxxx) 或模型名"
                            style={{
                              width: '100%', fontSize: 12, padding: '7px 10px', marginBottom: 6,
                              background: 'rgba(249,115,22,.06)', borderRadius: 8,
                              border: '1px solid rgba(249,115,22,.15)', outline: 'none',
                              color: '#e2e8f0', fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                          <input
                            type="text"
                            value={customBaseURL || 'https://ark.cn-beijing.volces.com/api/coding/v3'}
                            onChange={(e) => setCustomBaseURL(e.target.value)}
                            placeholder="Base URL"
                            style={{
                              width: '100%', fontSize: 12, padding: '7px 10px',
                              background: 'rgba(249,115,22,.06)', borderRadius: 8,
                              border: '1px solid rgba(249,115,22,.15)', outline: 'none',
                              color: '#e2e8f0', fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                          <p style={{ fontSize: 10, color: '#64748b', margin: '4px 0 0' }}>
                            Coding Plan 支持模型: doubao-seed-2.0-code, doubao-seed-2.0-pro, GLM-5.2, DeepSeek-V4-Flash, Kimi-K2.6 等
                          </p>
                        </div>
                      )}
                      {/* 自定义API需要额外输入baseURL和模型 */}
                      {provider.key === 'custom' && (
                        <div style={{ marginTop: 8 }}>
                          <input
                            type="text"
                            value={customBaseURL}
                            onChange={(e) => setCustomBaseURL(e.target.value)}
                            placeholder="Base URL (如 https://api.example.com/v1)"
                            style={{
                              width: '100%', fontSize: 12, padding: '7px 10px', marginBottom: 6,
                              background: 'rgba(245,158,11,.06)', borderRadius: 8,
                              border: '1px solid rgba(245,158,11,.15)', outline: 'none',
                              color: '#e2e8f0', fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                          <input
                            type="text"
                            value={customModel}
                            onChange={(e) => setCustomModel(e.target.value)}
                            placeholder="模型名称 (如 gpt-4o-mini)"
                            style={{
                              width: '100%', fontSize: 12, padding: '7px 10px',
                              background: 'rgba(245,158,11,.06)', borderRadius: 8,
                              border: '1px solid rgba(245,158,11,.15)', outline: 'none',
                              color: '#e2e8f0', fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                          <p style={{ fontSize: 10, color: '#64748b', margin: '4px 0 0' }}>
                            火山引擎 Coding Plan: baseURL=<strong style={{color:'#f59e0b'}}>https://ark.cn-beijing.volces.com/api/coding/v3</strong>, 模型用 ark-code-latest
                          </p>
                        </div>
                      )}
                      {keyStatusVal === 'valid' && <p style={{ fontSize: 10, color: '#10b981', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 3 }}><Wifi style={{ width: 10, height: 10 }} /> 已连接 · 密钥有效</p>}
                      {keyStatusVal === 'invalid' && <p style={{ fontSize: 10, color: '#ef4444', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 3 }}><WifiOff style={{ width: 10, height: 10 }} /> 连接失败 · 密钥无效</p>}
                    </div>
                  )}
                  {!isSelected && (
                    <span style={{ fontSize: 11, color: isConfigured ? '#10b981' : '#475569' }}>
                      {isConfigured ? '已激活' : '未配置'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Step 2: 选择默认模型 - 玻璃态卡片 */}
        {models.length > 0 && (
          <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: 'linear-gradient(135deg, #8b5cf6, #06b6d4)',
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700,
                boxShadow: '0 0 12px rgba(139,92,246,.3)',
              }}>2</div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>选择默认模型</h2>
              <span style={{ fontSize: 11, color: '#475569', marginLeft: 8 }}>共 {models.length} 个模型 · 提供商: <strong style={{ color: '#67e8f9' }}>{selectedProvider || '未选'}</strong></span>
            </div>
            <p style={{ fontSize: 12, color: '#64748b', marginLeft: 38, marginBottom: 16 }}>
              当前: <strong style={{ color: '#67e8f9' }}>{selectedModel || '未选择'}</strong>
              {config?.defaultProvider && (
                <span style={{ marginLeft: 12, fontSize: 11, color: '#475569' }}>
                  (已保存: {config.defaultProvider}/{config.defaultModel})
                </span>
              )}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
              {Object.entries(groupedModels).map(([provider, providerModels]) => (
                <div key={provider} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, paddingLeft: 2, letterSpacing: 1.2, textTransform: 'uppercase' }}>{provider}</div>
                  {providerModels.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => { setSelectedModel(model.id); setSelectedProvider(provider); }}
                      style={{
                        width: '100%', padding: '9px 12px', borderRadius: 10, textAlign: 'left',
                        border: selectedModel === model.id ? '1px solid #8b5cf6' : '1px solid rgba(255,255,255,.06)',
                        background: selectedModel === model.id ? 'rgba(139,92,246,.1)' : 'rgba(255,255,255,.02)',
                        cursor: 'pointer', transition: 'all .15s', fontFamily: 'inherit',
                        marginBottom: 4,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0' }}>{model.name}</span>
                        {selectedModel === model.id && <CheckCircle style={{ width: 11, height: 11, color: '#8b5cf6' }} />}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 11, color: '#64748b', textAlign: 'center' }}>
              选择模型后点击「保存并激活」使其生效
            </div>
          </section>
        )}

        {/* 语种设置 - 玻璃态卡片 */}
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Globe style={{ width: 14, height: 14 }} />
            </div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>语种设置</h2>
            <span style={{ fontSize: 11, color: '#475569', marginLeft: 8 }}>Agent 回复语言偏好</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { key: 'zh-CN', label: '中文' },
              { key: 'en-US', label: 'English' },
              { key: 'ja-JP', label: '日本語' },
            ].map(l => (
              <button
                key={l.key}
                onClick={async () => {
                  const api = window.electronAPI;
                  if (!api?.i18n?.setLocale) return;
                  const r = await api.i18n.setLocale(l.key);
                  if (r?.success) {
                    setLocaleState(l.key);
                    setMessage(`语种已切换为 ${l.label}`);
                    clearMessageLater(3000);
                  }
                }}
                style={{
                  padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                  background: locale === l.key ? 'linear-gradient(135deg, #06b6d4, #3b82f6)' : 'rgba(255,255,255,.04)',
                  color: locale === l.key ? '#fff' : '#94a3b8',
                  border: locale === l.key ? 'none' : '1px solid rgba(255,255,255,.08)',
                  fontWeight: locale === l.key ? 600 : 400,
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#64748b', margin: '10px 0 0' }}>
            注意：Agent 也会根据你的输入语言自动检测。此设置为偏好提示。
          </p>
        </section>

        {/* 自我改进 - 玻璃态卡片 */}
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'linear-gradient(135deg, #f59e0b, #ec4899)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 12px rgba(245,158,11,.3)',
            }}>
              <Sparkles style={{ width: 14, height: 14 }} />
            </div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>自我改进</h2>
            <span style={{ fontSize: 11, color: '#475569', marginLeft: 8 }}>Agent 自主搜索网络、修复和完善自身代码（可控）</span>
          </div>

          {/* 开关 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 10, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)' }}>
            <div>
              <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: '0 0 2px' }}>启用自我改进</p>
              <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>启用后 Agent 可搜索全网获取优秀技能和最新 agent 能力，提出自身代码修改。<strong style={{ color: '#f59e0b' }}>每次代码修改都会弹出对话框让你批准</strong>，修改前自动备份。</p>
            </div>
            <button
              onClick={handleToggleSelfImprove}
              disabled={selfImproveLoading}
              style={{
                flexShrink: 0, width: 46, height: 26, borderRadius: 13,
                background: selfImproveEnabled ? 'linear-gradient(135deg, #f59e0b, #ec4899)' : 'rgba(100,116,139,.3)',
                border: 'none', cursor: 'pointer', position: 'relative', transition: 'all .2s',
                boxShadow: selfImproveEnabled ? '0 0 10px rgba(245,158,11,.4)' : 'none',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: selfImproveEnabled ? 23 : 3,
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                transition: 'all .2s', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
              }} />
            </button>
          </div>

          {/* 状态信息 */}
          {selfImproveEnabled && (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245,158,11,.04)', border: '1px solid rgba(245,158,11,.1)' }}>
                <p style={{ fontSize: 10, color: '#475569', margin: '0 0 2px' }}>修改历史</p>
                <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{selfImproveHistory.length} 条</p>
              </div>
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245,158,11,.04)', border: '1px solid rgba(245,158,11,.1)' }}>
                <p style={{ fontSize: 10, color: '#475569', margin: '0 0 2px' }}>备份文件</p>
                <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{selfImproveBackups.length} 个</p>
              </div>
            </div>
          )}

          {/* 备份回滚列表 */}
          {selfImproveEnabled && selfImproveBackups.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <History style={{ width: 12, height: 12, color: '#64748b' }} />
                <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>备份文件（可回滚）</p>
              </div>
              <div style={{ maxHeight: 140, overflowY: 'auto' }}>
                {selfImproveBackups.slice(0, 10).map((b) => (
                  <div key={b.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,.02)', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>{b.name}</span>
                    <button
                      onClick={() => handleRollback(b.path)}
                      style={{ padding: '3px 8px', fontSize: 10, borderRadius: 5, border: '1px solid rgba(239,68,68,.2)', background: 'rgba(239,68,68,.06)', color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
                    >
                      <RotateCcw style={{ width: 10, height: 10 }} /> 回滚
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, fontSize: 11, color: '#475569', textAlign: 'center' }}>
            可修改文件白名单: desktop/main.js, desktop/tool-executor.js, desktop/preload.js 等 · 所有修改需用户批准
          </div>

          {/* F2: 立即执行按钮 */}
          {selfImproveEnabled && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', margin: '0 0 2px' }}>立即执行自我改进</p>
                  <p style={{ fontSize: 10, color: '#64748b', margin: 0 }}>触发一次完整的 evolve cycle：搜索网络 → 提议修改 → tsc + vitest 护栏验证 → 失败自动回滚</p>
                </div>
                <button
                  onClick={handleRunEvolve}
                  disabled={evolveRunning}
                  style={{
                    flexShrink: 0, padding: '8px 16px', borderRadius: 8, cursor: evolveRunning ? 'not-allowed' : 'pointer',
                    background: evolveRunning ? 'rgba(100,116,139,.2)' : 'linear-gradient(135deg, #f59e0b, #ec4899)',
                    border: 'none', color: '#fff', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 6, opacity: evolveRunning ? 0.6 : 1,
                    boxShadow: evolveRunning ? 'none' : '0 0 12px rgba(245,158,11,.25)',
                    transition: 'all .2s',
                  }}
                >
                  {evolveRunning ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Zap style={{ width: 13, height: 13 }} />}
                  {evolveRunning ? '执行中...' : '立即执行'}
                </button>
              </div>

              {/* 执行结果显示 */}
              {evolveResult && (
                <div style={{
                  marginTop: 10, padding: 12, borderRadius: 8, fontSize: 11,
                  background: evolveResult.type === 'success' ? 'rgba(16,185,129,.06)' : 'rgba(239,68,68,.06)',
                  border: `1px solid ${evolveResult.type === 'success' ? 'rgba(16,185,129,.2)' : 'rgba(239,68,68,.2)'}`,
                  color: evolveResult.type === 'success' ? '#10b981' : '#ef4444',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                    {evolveResult.type === 'success' ? <CheckCircle style={{ width: 13, height: 13 }} /> : <XCircle style={{ width: 13, height: 13 }} />}
                    {evolveResult.text}
                  </div>
                  {evolveResult.details && (
                    <pre style={{
                      marginTop: 8, padding: 8, borderRadius: 6, fontSize: 10, fontFamily: 'monospace',
                      background: 'rgba(0,0,0,.2)', color: '#94a3b8', maxHeight: 160, overflow: 'auto',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0',
                    }}>
                      {evolveResult.details}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* D-MCP: MCP 插件市场 - 玻璃态卡片 */}
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 12px rgba(6,182,212,.3)',
            }}>
              <Sparkles style={{ width: 14, height: 14 }} />
            </div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>MCP 插件市场</h2>
            <span style={{ fontSize: 11, color: '#475569', marginLeft: 8 }}>Model Context Protocol 插件浏览 · 安装 · 管理</span>
            <button
              onClick={loadMcpMarketplace}
              disabled={mcpLoading}
              style={{
                marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit',
              }}
            >
              {mcpLoading ? <Loader2 style={{ width: 11, height: 11 }} className="spin" /> : <RotateCcw style={{ width: 11, height: 11 }} />}
              刷新
            </button>
          </div>

          {/* 统计信息 */}
          {mcpStats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)' }}>
                <p style={{ fontSize: 10, color: '#475569', margin: '0 0 2px' }}>已安装</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#06b6d4', margin: 0 }}>{mcpStats.total}</p>
              </div>
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(139,92,246,.04)', border: '1px solid rgba(139,92,246,.1)' }}>
                <p style={{ fontSize: 10, color: '#475569', margin: '0 0 2px' }}>MCP 服务</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa', margin: 0 }}>{mcpStats.mcpServers}</p>
              </div>
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245,158,11,.04)', border: '1px solid rgba(245,158,11,.1)' }}>
                <p style={{ fontSize: 10, color: '#475569', margin: '0 0 2px' }}>工具包</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b', margin: 0 }}>{mcpStats.toolBundles}</p>
              </div>
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(16,185,129,.04)', border: '1px solid rgba(16,185,129,.1)' }}>
                <p style={{ fontSize: 10, color: '#475569', margin: '0 0 2px' }}>已启用</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#10b981', margin: 0 }}>{mcpStats.enabled}</p>
              </div>
            </div>
          )}

          {/* 搜索框 */}
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <input
              type="text"
              value={mcpSearch}
              onChange={(e) => setMcpSearch(e.target.value)}
              placeholder="搜索插件名称或描述..."
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 12, fontFamily: 'inherit',
                background: 'rgba(0,0,0,.2)', border: '1px solid rgba(255,255,255,.08)',
                color: '#e2e8f0', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* 插件列表 */}
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {mcpLoading && mcpPlugins.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#475569' }}>
                <Loader2 style={{ width: 20, height: 20, margin: '0 auto 8px', display: 'block' }} className="spin" />
                加载中...
              </div>
            ) : mcpPlugins.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: 12 }}>
                暂无可用插件
              </div>
            ) : (
              mcpPlugins
                .filter(p => !mcpSearch || (p.name?.toLowerCase().includes(mcpSearch.toLowerCase()) || p.description?.toLowerCase().includes(mcpSearch.toLowerCase())))
                .slice(0, 50)
                .map(plugin => {
                  const isInstalled = mcpInstalled.has(plugin.id);
                  const actionKey = `${isInstalled ? 'uninstall' : 'install'}:${plugin.id}`;
                  const isEnabled = plugin.enabled !== false;
                  return (
                    <div key={plugin.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
                      background: isInstalled ? 'rgba(6,182,212,.04)' : 'rgba(255,255,255,.02)',
                      border: `1px solid ${isInstalled ? 'rgba(6,182,212,.15)' : 'rgba(255,255,255,.06)'}`,
                      marginBottom: 6,
                    }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: plugin.type === 'mcp-server' ? '#a78bfa' : '#f59e0b',
                        boxShadow: `0 0 8px ${plugin.type === 'mcp-server' ? 'rgba(167,139,250,.5)' : 'rgba(245,158,11,.5)'}`,
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0' }}>{plugin.name}</span>
                          <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,.04)', color: '#64748b', border: '1px solid rgba(255,255,255,.06)' }}>v{plugin.version}</span>
                          {plugin.type && (
                            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: plugin.type === 'mcp-server' ? 'rgba(139,92,246,.1)' : 'rgba(245,158,11,.1)', color: plugin.type === 'mcp-server' ? '#a78bfa' : '#f59e0b', border: `1px solid ${plugin.type === 'mcp-server' ? 'rgba(139,92,246,.15)' : 'rgba(245,158,11,.15)'}` }}>{plugin.type === 'mcp-server' ? 'MCP' : '工具包'}</span>
                          )}
                        </div>
                        <p style={{ fontSize: 10, color: '#64748b', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {plugin.description || '无描述'}
                        </p>
                      </div>
                      {/* 操作按钮 */}
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        {!isInstalled ? (
                          <button
                            onClick={() => handleMcpAction('install', plugin.id)}
                            disabled={mcpAction === actionKey}
                            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 5, border: '1px solid rgba(6,182,212,.2)', background: 'rgba(6,182,212,.08)', color: '#06b6d4', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3 }}
                          >
                            {mcpAction === actionKey ? <Loader2 style={{ width: 10, height: 10 }} className="spin" /> : null}
                            安装
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => handleMcpAction(isEnabled ? 'disable' : 'enable', plugin.id)}
                              disabled={mcpAction === `enable:${plugin.id}` || mcpAction === `disable:${plugin.id}`}
                              style={{ padding: '4px 10px', fontSize: 10, borderRadius: 5, border: `1px solid ${isEnabled ? 'rgba(245,158,11,.2)' : 'rgba(16,185,129,.2)'}`, background: isEnabled ? 'rgba(245,158,11,.06)' : 'rgba(16,185,129,.06)', color: isEnabled ? '#f59e0b' : '#10b981', cursor: 'pointer', fontFamily: 'inherit' }}
                            >
                              {isEnabled ? '禁用' : '启用'}
                            </button>
                            <button
                              onClick={() => { if (confirm(`确定卸载插件 ${plugin.name} 吗？`)) handleMcpAction('uninstall', plugin.id); }}
                              disabled={mcpAction === actionKey}
                              style={{ padding: '4px 10px', fontSize: 10, borderRadius: 5, border: '1px solid rgba(239,68,68,.2)', background: 'rgba(239,68,68,.06)', color: '#ef4444', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3 }}
                            >
                              {mcpAction === actionKey ? <Loader2 style={{ width: 10, height: 10 }} className="spin" /> : null}
                              卸载
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
            )}
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: '#475569', textAlign: 'center' }}>
            MCP 协议插件扩展 Agent 工具能力 · mcp-server 类型自动连接 · tool-bundle 类型注入工具定义
          </div>
        </section>

        {/* 语音设置入口 - 跳转到独立页面 */}
        <section className="glass-effect hover-glow" style={{ borderRadius: 16, padding: 20, marginBottom: 16, cursor: 'pointer', transition: 'all .2s' }}
          onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'voice' }))}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 12px rgba(236,72,153,.3)',
            }}>
              <Mic style={{ width: 16, height: 16 }} />
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>语音对话设置</h2>
              <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0 0' }}>音色选择 · 语速 · 音调 · 音量 · 模拟真人发音</p>
            </div>
            <ChevronRight style={{ width: 16, height: 16, color: '#475569' }} />
          </div>
        </section>

        {/* 当前状态 - 玻璃态卡片 */}
        <section className="glass-effect" style={{ borderRadius: 16, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Bot style={{ width: 18, height: 18, color: '#06b6d4' }} />
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>当前配置</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <div style={{ padding: 14, borderRadius: 10, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)' }}>
              <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>默认模型</p>
              <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{selectedModel || '未选择'}</p>
            </div>
            <div style={{ padding: 14, borderRadius: 10, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)' }}>
              <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>已激活密钥</p>
              <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{configuredProviders.length} 个</p>
            </div>
            <div style={{ padding: 14, borderRadius: 10, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)' }}>
              <p style={{ fontSize: 10, color: '#475569', margin: '0 0 4px' }}>可用模型</p>
              <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', margin: 0 }}>{models.length} 个</p>
            </div>
          </div>
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>段先生 v19.0 · Mr.Duan 自主进化智能体</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: configuredProviders.length > 0 ? '#06b6d4' : '#ef4444',
                boxShadow: configuredProviders.length > 0 ? '0 0 8px rgba(6,182,212,.5)' : 'none',
                animation: configuredProviders.length > 0 ? 'status-pulse-cyan 2s infinite' : 'none',
              }} />
              <span style={{ fontSize: 12, color: configuredProviders.length > 0 ? '#06b6d4' : '#ef4444' }}>
                {configuredProviders.length > 0 ? 'Agent 已激活' : 'Agent 未激活'}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
