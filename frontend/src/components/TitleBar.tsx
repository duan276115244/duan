import { useState, useEffect, useCallback } from 'react';
import { Minus, Square, Maximize2, X, Cpu, Zap, ChevronDown } from 'lucide-react';
import { useConfig } from '@/hooks/useApi';

interface TitleBarProps {
  currentTab?: string;
  taskStatus?: string;
}

/** 供应商 profile 精简结构（仅取展示与切换所需字段，apiKey 在 unified.load 中已脱敏） */
interface ProfileLite {
  id: string;
  provider: string;
  label: string;
  model: string;
}

/** 将 unified.load 返回的 v1.x(数组)/v2.0(对象) profiles 归一化为数组 */
function normalizeProfiles(unified: { profiles?: unknown; activeProfile?: string; defaultProfileId?: string } | undefined): { profiles: ProfileLite[]; activeId: string } {
  const raw = unified?.profiles;
  let list: ProfileLite[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((p: { id?: string; provider?: string; label?: string; model?: string }) => ({
      id: p.id || p.provider || '',
      provider: p.provider || '',
      label: p.label || p.provider || p.id || '',
      model: p.model || '',
    }));
  } else if (raw && typeof raw === 'object') {
    list = Object.entries(raw).map(([id, p]: [string, { provider?: string; label?: string; model?: string }]) => ({
      id,
      provider: p.provider || '',
      label: p.label || p.provider || id,
      model: p.model || '',
    }));
  }
  const activeId = unified?.activeProfile || unified?.defaultProfileId || list[0]?.id || '';
  return { profiles: list, activeId };
}

export function TitleBar({ currentTab, taskStatus }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const { config } = useConfig();
  // 4.4 供应商切换：profiles 列表 + 当前激活 profile + 切换中状态
  const [profiles, setProfiles] = useState<ProfileLite[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const cleanup = window.electronAPI?.window.onMaximizedChange((data) => {
      setIsMaximized(!!data);
    });
    return () => cleanup?.();
  }, []);

  // 加载供应商 profile 列表（仅 Electron 模式有 config.unified）
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.config?.unified?.load) return;
    api.config.unified.load().then((unified: unknown) => {
      const { profiles: list, activeId } = normalizeProfiles(unified as { profiles?: unknown; activeProfile?: string; defaultProfileId?: string } | undefined);
      setProfiles(list);
      setActiveProfileId(activeId);
    }).catch(() => { /* 静默：加载失败退化为只读展示 */ });
  }, []);

  const handleMinimize = () => window.electronAPI?.window.minimize();
  const handleMaximize = () => window.electronAPI?.window.maximize();
  const handleClose = () => window.electronAPI?.window.close();

  // 4.4 供应商切换：setActive 写入配置 + model.switch 更新 Agent 环境变量并广播 model:changed
  // model:changed 事件会被 useConfig 的 B3 订阅捕获，自动刷新模型显示
  const handleProviderSwitch = useCallback(async (profileId: string) => {
    const api = window.electronAPI;
    if (!api || switching || profileId === activeProfileId) return;
    const target = profiles.find(p => p.id === profileId);
    if (!target?.model) return;
    setSwitching(true);
    try {
      // 1. 设置激活 profile（写入 ~/.duan/config.json）
      await api.config?.unified?.setActive?.(profileId);
      // 2. 切换模型（更新 process.env.DEFAULT_MODEL/PROVIDER，广播 model:changed → useConfig 自动刷新）
      await api.model?.switch?.(target.model);
      setActiveProfileId(profileId);
    } catch {
      /* 切换失败静默处理，模型显示由 useConfig refresh 兜底纠正 */
    } finally {
      setSwitching(false);
    }
  }, [profiles, activeProfileId, switching]);

  // 当前模型信息（不硬编码回退值，未配置时显示"未配置"）
  const currentModel = config?.defaultModel || '未配置';
  const currentProvider = config?.defaultProvider || '';

  return (
    <div className="titlebar" style={{
      height: 36,
      backgroundColor: 'rgba(10, 14, 26, 0.85)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      userSelect: 'none',
      flexShrink: 0,
      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
      position: 'relative',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
    } as React.CSSProperties}>
      {/* 左侧：Logo + 应用名 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        height: '100%',
      }}>
        <div style={{
          width: 18, height: 18, borderRadius: 5, overflow: 'hidden', flexShrink: 0,
          boxShadow: '0 0 8px rgba(6,182,212,.3)',
          border: '1px solid rgba(6,182,212,.2)',
        }}>
          <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#94a3b8',
          letterSpacing: 0.5,
        }}>
          段先生
        </span>
        <span style={{
          fontSize: 9,
          color: '#475569',
          padding: '1px 6px',
          borderRadius: 4,
          background: 'rgba(6,182,212,.06)',
          border: '1px solid rgba(6,182,212,.1)',
          letterSpacing: 0.5,
        }}>
          v19.0
        </span>
      </div>

      {/* 中间：当前标签页名称 + 任务状态 */}
      <div style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        {currentTab && (
          <span style={{
            fontSize: 12,
            color: '#94a3b8',
            fontWeight: 500,
          }}>
            {currentTab}
          </span>
        )}
        {taskStatus && (
          <span style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            color: '#06b6d4',
            padding: '1px 8px',
            borderRadius: 8,
            background: 'rgba(6,182,212,.08)',
            border: '1px solid rgba(6,182,212,.15)',
          }}>
            <span style={{
              width: 4, height: 4, borderRadius: '50%',
              background: '#06b6d4',
              boxShadow: '0 0 4px rgba(6,182,212,.6)',
              animation: 'status-pulse-cyan 2s infinite',
            }} />
            {taskStatus}
          </span>
        )}
      </div>

      {/* 右侧：模型信息 + Token使用量 + 窗口控制按钮 */}
      <div className="titlebar-buttons" style={{
        display: 'flex',
        alignItems: 'center',
        height: '100%',
        gap: 4,
        paddingRight: 8,
      }}>
        {/* 模型信息 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 8px',
          marginRight: 4,
          borderRadius: 6,
          background: 'rgba(139, 92, 246, 0.06)',
          border: '1px solid rgba(139, 92, 246, 0.12)',
        }}>
          <Cpu style={{ width: 11, height: 11, color: '#a78bfa' }} />
          <span style={{ fontSize: 10, color: '#94a3b8', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentModel}
          </span>
        </div>

        {/* 4.4 供应商切换：有 profiles 时显示下拉，否则退化为只读展示 */}
        {profiles.length > 0 ? (
          <div style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            marginRight: 4,
            borderRadius: 6,
            background: switching ? 'rgba(245, 158, 11, 0.1)' : 'rgba(6, 182, 212, 0.06)',
            border: '1px solid rgba(6, 182, 212, 0.12)',
            overflow: 'hidden',
          }}>
            <Zap style={{ width: 10, height: 10, color: '#06b6d4', marginLeft: 8, flexShrink: 0, pointerEvents: 'none' }} />
            <select
              value={activeProfileId}
              onChange={(e) => handleProviderSwitch(e.target.value)}
              disabled={switching}
              title="切换 API 供应商"
              style={{
                appearance: 'none',
                WebkitAppearance: 'none',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: switching ? '#f59e0b' : '#94a3b8',
                fontSize: 10,
                padding: '2px 22px 2px 6px',
                margin: 0,
                cursor: switching ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                maxWidth: 140,
              }}
            >
              {profiles.map(p => (
                <option key={p.id} value={p.id} style={{ color: '#e2e8f0', background: '#0f172a' }}>
                  {p.label}{p.model ? ` · ${p.model}` : ''}
                </option>
              ))}
            </select>
            <ChevronDown style={{ width: 10, height: 10, color: '#475569', position: 'absolute', right: 6, pointerEvents: 'none' }} />
          </div>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            marginRight: 4,
            borderRadius: 6,
            background: 'rgba(6, 182, 212, 0.06)',
            border: '1px solid rgba(6, 182, 212, 0.12)',
          }}>
            <Zap style={{ width: 10, height: 10, color: '#06b6d4' }} />
            <span style={{ fontSize: 10, color: '#64748b' }}>
              {currentProvider}
            </span>
          </div>
        )}

        {/* 窗口控制按钮 */}
        <button
          className="titlebar-button"
          onClick={handleMinimize}
          title="最小化"
          style={{
            width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            cursor: 'pointer', color: '#64748b',
            transition: 'background .12s, color .12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
        >
          <Minus style={{ width: 14, height: 14 }} />
        </button>
        <button
          className="titlebar-button"
          onClick={handleMaximize}
          title={isMaximized ? '还原' : '最大化'}
          style={{
            width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            cursor: 'pointer', color: '#64748b',
            transition: 'background .12s, color .12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
        >
          {isMaximized
            ? <Maximize2 style={{ width: 13, height: 13 }} />
            : <Square style={{ width: 13, height: 13 }} />
          }
        </button>
        <button
          className="titlebar-button titlebar-close-button"
          onClick={handleClose}
          title="关闭"
          style={{
            width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            cursor: 'pointer', color: '#64748b',
            transition: 'background .12s, color .12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#e81123'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>
    </div>
  );
}
