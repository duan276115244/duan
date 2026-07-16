import { useState, useEffect, useMemo } from 'react';
import { MessageCircle, Settings, Trash2, X, Search, Sparkles, PanelLeftClose, PanelLeftOpen, BarChart3, Layers, Info, Radio, Users, Server, Gauge, Workflow } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';

interface SidebarProps {
  onToggle: () => void;
  isVisible: boolean;
  onOpenConfig?: () => void;
  onOpenSkills?: () => void;
  onOpenDashboard?: () => void;
  onOpenAbout?: () => void;
  onOpenChannels?: () => void;
  onOpenSubAgent?: () => void;
  onOpenWorkflow?: () => void;
  onOpenMcp?: () => void;
  onOpenCapability?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  activeNav?: string;
  onNavChange?: (nav: string) => void;
}

// 导航菜单项
const NAV_ITEMS = [
  { id: 'chat', label: '对话', icon: MessageCircle },
  { id: 'dashboard', label: '仪表盘', icon: BarChart3 },
  { id: 'capability', label: '能力评估', icon: Gauge },
  { id: 'subagent', label: '多 Agent 编排', icon: Users },
  { id: 'workflow', label: '工作流', icon: Workflow },
  { id: 'mcp', label: 'MCP 管理', icon: Server },
  { id: 'skills', label: '技能管理', icon: Layers },
  { id: 'channels', label: '消息通道', icon: Radio },
  { id: 'config', label: '配置', icon: Settings },
  { id: 'about', label: '关于', icon: Info },
];

export function Sidebar({
  onToggle,
  isVisible,
  onOpenConfig,
  onOpenSkills,
  onOpenDashboard,
  onOpenAbout,
  onOpenChannels,
  onOpenSubAgent,
  onOpenWorkflow,
  onOpenMcp,
  onOpenCapability,
  collapsed = false,
  onToggleCollapse,
  activeNav = 'chat',
  onNavChange,
}: SidebarProps) {
  const { conversations: allConversations, currentConversationId, setCurrentConversation, createConversation, deleteConversation, setSearchQuery, searchQuery } = useChatStore(useShallow(s => ({
    conversations: s.conversations,
    currentConversationId: s.currentConversationId,
    setCurrentConversation: s.setCurrentConversation,
    createConversation: s.createConversation,
    deleteConversation: s.deleteConversation,
    setSearchQuery: s.setSearchQuery,
    searchQuery: s.searchQuery,
  })));
  const [hoveredConv, setHoveredConv] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [hoveredNav, setHoveredNav] = useState<string | null>(null);
  const [sysStatus, setSysStatus] = useState<{ status: string; model: string; uptime: number; version: string } | null>(null);

  // 实时获取系统状态（每 10s 刷新）
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const isE = typeof window !== 'undefined' && !!window.electronAPI;
        if (isE) {
          const api = window.electronAPI;
          if (api?.system?.status) {
            const data = await api.system.status();
            setSysStatus({
              status: data.status || (data.agentRunning ? 'running' : 'stopped'),
              model: data.model || data.activeModels || 'AUTO',
              uptime: data.uptime || 0,
              version: data.version || data.appVersion || 'v19.0',
            });
          }
        } else {
          const resp = await fetch('/api/status');
          if (resp.ok) {
            const data = await resp.json();
            setSysStatus({
              status: data.status || (data.heartbeat?.running ? 'running' : 'stopped'),
              model: data.activeModels || 'AUTO',
              uptime: data.uptime || 0,
              version: data.version || 'v19.0',
            });
          }
        }
      } catch { /* ignore */ }
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 10000);
    return () => clearInterval(timer);
  }, []);

  const formatUptime = (s: number) => {
    if (!s) return '—';
    if (s > 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    if (s > 60) return `${Math.floor(s / 60)}m`;
    return `${s}s`;
  };

  // P2 优化：使用 useMemo 缓存过滤结果，避免每次渲染都重新计算
  const conversations = useMemo(() => {
    if (!searchQuery) return allConversations;
    const query = searchQuery.toLowerCase();
    return allConversations.filter(
      (conv) =>
        conv.title.toLowerCase().includes(query) ||
        conv.messages.some((msg) => msg.content.toLowerCase().includes(query))
    );
  }, [allConversations, searchQuery]);

  const handleSelect = (id: string) => {
    setCurrentConversation(id);
    if (window.innerWidth < 1024) onToggle();
  };

  const handleNavClick = (navId: string) => {
    onNavChange?.(navId);
    switch (navId) {
      case 'config': onOpenConfig?.(); break;
      case 'skills': onOpenSkills?.(); break;
      case 'dashboard': onOpenDashboard?.(); break;
      case 'channels': onOpenChannels?.(); break;
      case 'about': onOpenAbout?.(); break;
      case 'subagent': onOpenSubAgent?.(); break;
      case 'workflow': onOpenWorkflow?.(); break;
      case 'mcp': onOpenMcp?.(); break;
      case 'capability': onOpenCapability?.(); break;
      case 'chat':
      default:
        // 切换到对话视图
        break;
    }
  };

  // 折叠状态下的侧边栏（仅图标）
  if (collapsed) {
    return (
      <aside style={{
        width: 64,
        height: '100%',
        flexShrink: 0,
        background: 'rgba(6, 9, 18, 0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRight: '1px solid rgba(255, 255, 255, 0.06)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '12px 0',
        gap: 4,
      }}>
        {/* Logo */}
        <div style={{
          width: 36, height: 36, borderRadius: 10, overflow: 'hidden',
          boxShadow: '0 0 12px rgba(6,182,212,.2), 0 0 24px rgba(139,92,246,.08)',
          border: '1px solid rgba(6,182,212,.15)',
          marginBottom: 8,
        }}>
          <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        {/* 新对话按钮 */}
        <button
          onClick={createConversation}
          title="新对话"
          style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.1))',
            border: '1px solid rgba(6,182,212,.2)',
            cursor: 'pointer', color: '#06b6d4',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all .15s',
            boxShadow: '0 0 8px rgba(6,182,212,.1)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(6,182,212,.25), rgba(139,92,246,.15))'; e.currentTarget.style.boxShadow = '0 0 16px rgba(6,182,212,.2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.1))'; e.currentTarget.style.boxShadow = '0 0 8px rgba(6,182,212,.1)'; }}
        >
          <Sparkles style={{ width: 18, height: 18 }} />
        </button>

        {/* 分隔线 */}
        <div style={{ width: 24, height: 1, background: 'rgba(255,255,255,.06)', margin: '8px 0' }} />

        {/* 导航图标 */}
        {NAV_ITEMS.map((item) => {
          const isActive = activeNav === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              title={item.label}
              onMouseEnter={() => setHoveredNav(item.id)}
              onMouseLeave={() => setHoveredNav(null)}
              style={{
                width: 40, height: 40, borderRadius: 10, border: 'none',
                background: isActive
                  ? 'rgba(6,182,212,.12)'
                  : hoveredNav === item.id ? 'rgba(255,255,255,.04)' : 'transparent',
                cursor: 'pointer',
                color: isActive ? '#06b6d4' : hoveredNav === item.id ? '#e2e8f0' : '#64748b',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all .15s',
                position: 'relative',
              }}
            >
              <item.icon style={{ width: 18, height: 18 }} />
              {isActive && (
                <div style={{
                  position: 'absolute', left: -8, top: '50%', transform: 'translateY(-50%)',
                  width: 3, height: 20, borderRadius: 2,
                  background: 'linear-gradient(180deg, #06b6d4, #3b82f6)',
                  boxShadow: '0 0 8px rgba(6,182,212,.5)',
                }} />
              )}
            </button>
          );
        })}

        <div style={{ flex: 1 }} />

        {/* 展开按钮 */}
        <button
          onClick={onToggleCollapse}
          title="展开侧边栏"
          style={{
            width: 40, height: 40, borderRadius: 10, border: 'none',
            background: 'transparent', cursor: 'pointer', color: '#64748b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.04)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
        >
          <PanelLeftOpen style={{ width: 18, height: 18 }} />
        </button>
      </aside>
    );
  }

  // 展开状态的侧边栏
  const sidebarInner = (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(6, 9, 18, 0.95)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderRight: '1px solid rgba(255, 255, 255, 0.06)',
    }}>
      {/* 头部 */}
      <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10, overflow: 'hidden', flexShrink: 0,
            boxShadow: '0 0 12px rgba(6,182,212,.2), 0 0 24px rgba(139,92,246,.08)',
            border: '1px solid rgba(6,182,212,.15)',
          }}>
            <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="shimmer-text" style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>段先生</div>
            <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.3, letterSpacing: 1 }}>MR.DUAN v19.0</div>
          </div>
        </div>
        <button
          onClick={onToggleCollapse}
          title="折叠侧边栏"
          style={{
            padding: 6, borderRadius: 8, background: 'transparent',
            border: 'none', cursor: 'pointer', color: '#475569',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'color .15s, background .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.background = 'rgba(6,182,212,.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#475569'; e.currentTarget.style.background = 'transparent'; }}
        >
          <PanelLeftClose style={{ width: 16, height: 16 }} />
        </button>
        <button
          id="sidebar-close-btn"
          onClick={onToggle}
          style={{
            padding: 6, borderRadius: 8, background: 'transparent',
            border: 'none', cursor: 'pointer', color: '#475569',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'color .15s, background .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.background = 'rgba(6,182,212,.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#475569'; e.currentTarget.style.background = 'transparent'; }}
        >
          <X style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* 导航菜单 */}
      <div style={{ padding: '4px 10px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV_ITEMS.map((item) => {
          const isActive = activeNav === item.id;
          const isHovered = hoveredNav === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              onMouseEnter={() => setHoveredNav(item.id)}
              onMouseLeave={() => setHoveredNav(null)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                background: isActive
                  ? 'rgba(6,182,212,.1)'
                  : isHovered ? 'rgba(255,255,255,.04)' : 'transparent',
                border: 'none',
                color: isActive ? '#06b6d4' : isHovered ? '#e2e8f0' : '#94a3b8',
                fontSize: 13, fontWeight: isActive ? 500 : 400, fontFamily: 'inherit',
                transition: 'background .12s, color .12s',
                position: 'relative',
              }}
            >
              <item.icon style={{ width: 16, height: 16 }} />
              {item.label}
              {isActive && (
                <div style={{
                  position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                  width: 3, height: 18, borderRadius: 2,
                  background: 'linear-gradient(180deg, #06b6d4, #3b82f6)',
                  boxShadow: '0 0 8px rgba(6,182,212,.5)',
                }} />
              )}
            </button>
          );
        })}
      </div>

      {/* 分隔线 */}
      <div style={{ height: 1, background: 'rgba(255,255,255,.04)', margin: '4px 14px' }} />

      {/* 新对话按钮 */}
      <div style={{ padding: '4px 12px 8px' }}>
        <button
          onClick={createConversation}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(6,182,212,.15)', cursor: 'pointer',
            background: 'linear-gradient(135deg, rgba(6,182,212,.08), rgba(139,92,246,.05))',
            color: '#e2e8f0', fontSize: 14, fontWeight: 500,
            transition: 'background .15s, border-color .15s, box-shadow .15s',
            boxShadow: '0 0 8px rgba(6,182,212,.05)',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(6,182,212,.12), rgba(139,92,246,.08))'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.3)'; e.currentTarget.style.boxShadow = '0 0 16px rgba(6,182,212,.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(6,182,212,.08), rgba(139,92,246,.05))'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.15)'; e.currentTarget.style.boxShadow = '0 0 8px rgba(6,182,212,.05)'; }}
        >
          <Sparkles style={{ width: 16, height: 16, color: '#06b6d4' }} />
          新对话
        </button>
      </div>

      {/* 搜索框 */}
      <div style={{ padding: '0 12px 8px' }}>
        <div style={{ position: 'relative' }}>
          <Search style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            width: 13, height: 13, color: searchFocused ? '#06b6d4' : '#475569',
            transition: 'color .2s',
          }} />
          <input
            type="text"
            placeholder="搜索对话..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            style={{
              width: '100%', paddingLeft: 32, paddingRight: 10,
              paddingTop: 8, paddingBottom: 8, fontSize: 13,
              background: searchFocused ? 'rgba(6,182,212,.08)' : 'rgba(255,255,255,.03)',
              borderRadius: 8,
              border: searchFocused ? '1px solid rgba(6,182,212,.25)' : '1px solid rgba(255,255,255,.06)',
              outline: 'none', color: '#e2e8f0',
              transition: 'border-color .2s, background .2s',
              boxShadow: searchFocused ? '0 0 8px rgba(6,182,212,.06)' : 'none',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {/* 对话列表 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
        {conversations.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '50%', color: '#475569', padding: 32,
          }}>
            <MessageCircle style={{ width: 28, height: 28, marginBottom: 10, opacity: 0.3 }} />
            <div style={{ fontSize: 13 }}>暂无对话</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {conversations.map((conv) => {
              const isActive = currentConversationId === conv.id;
              const isHovered = hoveredConv === conv.id;
              return (
                <div
                  key={conv.id}
                  onClick={() => handleSelect(conv.id)}
                  onMouseEnter={() => setHoveredConv(conv.id)}
                  onMouseLeave={() => setHoveredConv(null)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 10px', borderRadius: 8, cursor: 'pointer',
                    background: isActive
                      ? 'rgba(6,182,212,.1)'
                      : isHovered ? 'rgba(255,255,255,.04)' : 'transparent',
                    borderLeft: isActive ? '2px solid #06b6d4' : '2px solid transparent',
                    transition: 'background .12s',
                    boxShadow: isActive ? 'inset 0 0 12px rgba(6,182,212,.03)' : 'none',
                  }}
                >
                  <MessageCircle style={{
                    width: 14, height: 14, flexShrink: 0,
                    color: isActive ? '#06b6d4' : '#475569',
                    transition: 'color .12s',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: isActive ? 500 : 400,
                      color: isActive ? '#e2e8f0' : '#94a3b8',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {conv.title}
                    </div>
                  </div>
                  {(isHovered || isActive) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // P2 修复：删除对话前确认，防止误删
                        if (window.confirm(`确定删除对话「${conv.title}」吗？此操作不可撤销。`)) {
                          deleteConversation(conv.id);
                        }
                      }}
                      style={{
                        padding: 4, borderRadius: 6, background: 'transparent',
                        border: 'none', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background .12s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,.1)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <Trash2 style={{ width: 13, height: 13, color: '#64748b' }} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部用户信息 + API状态指示器 */}
      <div style={{
        padding: '10px 12px',
        borderTop: '1px solid rgba(255,255,255,.06)',
        background: 'rgba(0,0,0,.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: 'linear-gradient(135deg, #06b6d4, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 8px rgba(6,182,212,.2)',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>U</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sysStatus?.model || 'AUTO'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: sysStatus?.status === 'running' ? '#10b981' : sysStatus?.status === 'error' ? '#ef4444' : '#f59e0b',
                boxShadow: sysStatus?.status === 'running' ? '0 0 4px rgba(16,185,129,.5)' : '0 0 4px rgba(245,158,11,.5)',
                animation: 'status-pulse 2s infinite',
              }} />
              <span style={{ fontSize: 10, color: '#64748b' }}>
                {sysStatus?.status === 'running' ? `运行中 · ${formatUptime(sysStatus.uptime)}` : sysStatus?.status === 'error' ? '异常' : sysStatus?.status ? sysStatus.status : '启动中'}
              </span>
            </div>
          </div>
        </div>
        {/* 版本信息条 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 9, color: '#475569', paddingTop: 6, borderTop: '1px solid rgba(255,255,255,.04)' }}>
          <span style={{ fontFamily: 'monospace' }}>{sysStatus?.version || 'v19.0'}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#06b6d4', boxShadow: '0 0 4px rgba(6,182,212,.6)' }} />
            DESKTOP MODE
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside id="sidebar-desktop" style={{ width: 240, height: '100%', flexShrink: 0 }}>
        {sidebarInner}
      </aside>

      <div
        id="sidebar-overlay"
        onClick={onToggle}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,.6)', zIndex: 40,
          opacity: isVisible ? 1 : 0,
          pointerEvents: isVisible ? 'auto' : 'none',
          transition: 'opacity .25s',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      <aside
        id="sidebar-mobile"
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0, width: 240, zIndex: 50,
          transform: isVisible ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform .25s ease-out',
          boxShadow: isVisible ? '4px 0 24px rgba(0,0,0,.4)' : 'none',
        }}
      >
        {sidebarInner}
      </aside>

      <style>{`
        @media (min-width: 1024px) {
          #sidebar-desktop { display: block !important; }
          #sidebar-overlay { display: none !important; }
          #sidebar-mobile { display: none !important; }
          #sidebar-close-btn { display: none !important; }
        }
        @media (max-width: 1023px) {
          #sidebar-desktop { display: none !important; }
          #sidebar-overlay { display: block !important; }
          #sidebar-mobile { display: block !important; }
          #sidebar-close-btn { display: flex !important; }
        }
      `}</style>
    </>
  );
}
