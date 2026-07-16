import { useState, useEffect, useRef, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react';
import {
  Globe, Terminal, Code2,
  ChevronRight, ChevronDown, Cpu, Wrench,
  X, Menu, Maximize2, Minimize2,
  Zap, Sparkles, Radio, Layers, Shield, GitBranch, Heart, Clock, MessageCircle, Bot, Activity,
} from 'lucide-react';
import { ChatArea } from '@/components/ChatArea';
import { SystemStatus } from '@/components/SystemStatus';
import { TitleBar } from '@/components/TitleBar';
import { Sidebar } from '@/components/Sidebar';
import { useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useSystemStatus as useSystemStatusHook } from '@/hooks/useApi';
import { BrowserPanel } from '@/components/BrowserPanel';
import { TerminalPanel } from '@/components/TerminalPanel';
import { EditorPanelSafe } from '@/components/EditorPanel';
import { McpApprovalDialog } from '@/components/McpApprovalDialog';
import { useProactiveVoice } from '@/hooks/useProactiveVoice';

// ===== 路由级代码分割：二级页面按需加载，减小首屏 bundle =====
const ConfigPage = lazy(() => import('@/pages/ConfigPage').then(m => ({ default: m.ConfigPage })));
const ChannelsPage = lazy(() => import('@/pages/ChannelsPage').then(m => ({ default: m.ChannelsPage })));
const SkillManagePage = lazy(() => import('@/pages/SkillManagePage').then(m => ({ default: m.SkillManagePage })));
const McpManagePage = lazy(() => import('@/pages/McpManagePage').then(m => ({ default: m.McpManagePage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const CapabilityDashboardPage = lazy(() => import('@/pages/CapabilityDashboardPage').then(m => ({ default: m.CapabilityDashboardPage })));
const VoiceSettingsPage = lazy(() => import('@/pages/VoiceSettingsPage').then(m => ({ default: m.VoiceSettingsPage })));
const SubAgentPanel = lazy(() => import('@/components/SubAgentPanel').then(m => ({ default: m.SubAgentPanel })));

// 页面加载占位符
function PageLoader() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 14 }}>
      <Activity style={{ width: 20, height: 20, animation: 'spin 1s linear infinite', marginRight: 8 }} />
      加载中...
    </div>
  );
}

// ===== 工具面板类型 =====
type ToolId = 'browser' | 'terminal' | 'editor';

interface ToolDef {
  id: ToolId;
  label: string;
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  color: string;
  bgActive: string;
  contentBg: string;
}

const TOOLS: ToolDef[] = [
  { id: 'browser', label: '浏览器', icon: Globe, color: '#10b981', bgActive: 'rgba(16,185,129,.12)', contentBg: '#060d14' },
  { id: 'terminal', label: '终端', icon: Terminal, color: '#f59e0b', bgActive: 'rgba(245,158,11,.12)', contentBg: '#0b0d06' },
  { id: 'editor', label: '编辑器', icon: Code2, color: '#8b5cf6', bgActive: 'rgba(139,92,246,.12)', contentBg: '#08061a' },
];

// ===== 工具面板（可调整宽度，支持Tab切换） =====
function ToolPanel({
  activeTool,
  navigateUrl,
  editorFile,
  onClose,
  onToolChange,
}: {
  activeTool: ToolId;
  navigateUrl?: string;
  editorFile?: { path: string; content: string } | null;
  onClose: () => void;
  onToolChange: (tool: ToolId) => void;
}) {
  const [panelWidth, setPanelWidth] = useState(760);
  const [resizing, setResizing] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [hoveredTab, setHoveredTab] = useState<ToolId | null>(null);
  // P1 修复：跟踪拖拽事件监听器，组件卸载时清理避免内存泄漏
  const dragHandlersRef = useRef<{ move: ((e: MouseEvent) => void) | null; up: ((e: MouseEvent) => void) | null }>({ move: null, up: null });
  useEffect(() => () => {
    if (dragHandlersRef.current.move) document.removeEventListener('mousemove', dragHandlersRef.current.move);
    if (dragHandlersRef.current.up) document.removeEventListener('mouseup', dragHandlersRef.current.up);
  }, []);

  const renderContent = () => {
    switch (activeTool) {
      case 'browser':
        return <BrowserPanel navigateUrl={navigateUrl} />;
      case 'terminal':
        return <TerminalPanel />;
      case 'editor':
        return <EditorPanelSafe initialFile={editorFile} />;
      default:
        return null;
    }
  };

  // 拖拽调整宽度
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(520, Math.min(1400, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      dragHandlersRef.current = { move: null, up: null }; // P1 修复：清除 ref
    };

    dragHandlersRef.current = { move: handleMouseMove, up: handleMouseUp }; // P1 修复：存储到 ref 供卸载清理
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const activeToolDef = TOOLS.find(t => t.id === activeTool);

  return (
    <div style={{
      width: maximized ? '100%' : panelWidth,
      flexShrink: maximized ? 1 : 0,
      flexGrow: maximized ? 1 : 0,
      height: '100%',
      overflow: 'hidden',
      background: activeToolDef?.contentBg || '#060b18',
      borderLeft: '1px solid rgba(255, 255, 255, 0.06)',
      transition: resizing ? 'none' : 'width .2s ease, opacity .15s ease',
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      willChange: 'transform, width',
    }}>
      {/* 拖拽把手 */}
      {!maximized && (
        <div
          onMouseDown={handleMouseDown}
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
            cursor: 'col-resize', zIndex: 20,
            background: resizing ? 'rgba(6,182,212,.3)' : 'transparent',
            transition: 'background .15s',
          }}
          onMouseEnter={(e) => { if (!resizing) e.currentTarget.style.background = 'rgba(6,182,212,.15)'; }}
          onMouseLeave={(e) => { if (!resizing) e.currentTarget.style.background = 'transparent'; }}
        />
      )}

      {/* 工具面板标题栏 - Tab切换 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px 0 12px',
        height: 38,
        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        flexShrink: 0,
        background: 'rgba(10, 14, 26, 0.6)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        gap: 2,
      }}>
        {/* Tab切换 */}
        <div style={{ display: 'flex', alignItems: 'center', height: '100%', gap: 2 }}>
          {TOOLS.map((tool) => {
            const isActive = activeTool === tool.id;
            const isHovered = hoveredTab === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => onToolChange(tool.id)}
                onMouseEnter={() => setHoveredTab(tool.id)}
                onMouseLeave={() => setHoveredTab(null)}
                className={`tool-tab ${isActive ? 'tool-tab-active' : ''}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', height: '100%',
                  background: 'transparent', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit',
                  color: isActive ? tool.color : isHovered ? '#e2e8f0' : '#64748b',
                  fontSize: 12, fontWeight: isActive ? 600 : 400,
                  transition: 'color .15s',
                }}
              >
                <tool.icon style={{ width: 14, height: 14 }} />
                {tool.label}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        {/* 最小化/最大化按钮 */}
        <button
          onClick={() => setMaximized(!maximized)}
          title={maximized ? '还原' : '最大化'}
          style={{
            width: 26, height: 26, borderRadius: 6, border: 'none',
            background: 'transparent', cursor: 'pointer', color: '#64748b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
        >
          {maximized ? <Minimize2 style={{ width: 13, height: 13 }} /> : <Maximize2 style={{ width: 13, height: 13 }} />}
        </button>

        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          title="关闭面板"
          style={{
            width: 26, height: 26, borderRadius: 6, border: 'none',
            background: 'transparent', cursor: 'pointer', color: '#64748b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,.1)'; e.currentTarget.style.color = '#ef4444'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* 工具内容 */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {renderContent()}
      </div>
    </div>
  );
}

// ===== ChatArea 底部状态栏 =====
function ChatStatusBar() {
  const { isStreaming, tools } = useChatStore(useShallow(s => ({ isStreaming: s.isStreaming, tools: s.tools })));
  const [expanded, setExpanded] = useState(false);
  const [currentModel, setCurrentModel] = useState('AUTO');

  useEffect(() => {
    // 读取当前配置的模型名
    try {
      const api = window.electronAPI;
      if (api?.config?.load) {
        api.config.load().then((config) => {
          if (config?.defaultModel) setCurrentModel(config.defaultModel);
          else if (config?.model) setCurrentModel(config.model);
          else if (config?.defaultProvider) setCurrentModel(config.defaultProvider);
        }).catch(() => {});
      }
    } catch { /* ignore */ }
  }, []);

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid rgba(255, 255, 255, 0.06)',
      background: 'rgba(10, 14, 26, 0.85)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 14px', background: 'transparent', border: 'none',
          cursor: 'pointer', color: '#94a3b8', fontSize: 12, fontFamily: 'inherit',
        }}
      >
        {expanded ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
        <Cpu style={{ width: 12, height: 12, color: '#06b6d4' }} />
        <span>{currentModel}</span>
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 8,
          background: isStreaming ? 'rgba(6,182,212,.12)' : 'rgba(16,185,129,.1)',
          color: isStreaming ? '#06b6d4' : '#10b981',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{
            width: 4, height: 4, borderRadius: '50%',
            background: isStreaming ? '#06b6d4' : '#10b981',
            boxShadow: isStreaming ? '0 0 4px rgba(6,182,212,.6)' : '0 0 4px rgba(16,185,129,.6)',
            animation: isStreaming ? 'status-pulse-cyan 2s infinite' : 'status-pulse 2s infinite',
          }} />
          {isStreaming ? '推理中' : '就绪'}
        </span>
        {tools.length > 0 && (
          <span style={{ fontSize: 10, color: '#8b5cf6', marginLeft: 4 }}>
            <Wrench style={{ width: 10, height: 10, display: 'inline', verticalAlign: 'middle', marginRight: 2 }} />
            {tools.length} 工具调用
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ padding: '0 14px 10px', fontSize: 11, color: '#64748b' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: isStreaming ? '#06b6d4' : '#10b981', boxShadow: isStreaming ? '0 0 6px rgba(6,182,212,.5)' : '0 0 6px rgba(16,185,129,.5)' }} />
            <span>{isStreaming ? '正在生成回复...' : '等待输入'}</span>
          </div>
          {tools.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
              {tools.slice(0, 5).map((tool, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#8b5cf6' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.name}</span>
                </div>
              ))}
              {tools.length > 5 && <span>还有 {tools.length - 5} 个...</span>}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <SystemStatus />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 关于页面（增强版） =====
function AboutPage({ onBack }: { onBack: () => void }) {
  const systemStatus = useSystemStatusHook();
  const { conversations, isStreaming } = useChatStore(useShallow(s => ({ conversations: s.conversations, isStreaming: s.isStreaming })));
  const [statusExpanded, setStatusExpanded] = useState(true);
  const lastActivityRef = useRef<number>(Date.now());

  // agent 运行时自动展开，闲置超过5分钟自动折叠
  useEffect(() => {
    if (isStreaming) {
      setStatusExpanded(true);
      lastActivityRef.current = Date.now();
      return;
    }
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle > 5 * 60 * 1000 && statusExpanded) {
        setStatusExpanded(false);
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [isStreaming, statusExpanded]);

  const handleStatusToggle = () => {
    setStatusExpanded(prev => !prev);
    lastActivityRef.current = Date.now();
  };

  const capabilities = [
    { icon: Wrench, label: '工具调用', desc: '浏览器、终端、编辑器等原生工具', color: '#06b6d4' },
    { icon: Sparkles, label: '技能学习', desc: '自主生成和积累可复用技能', color: '#a78bfa' },
    { icon: Activity, label: '自我进化', desc: '基于经验持续优化自身能力', color: '#10b981' },
    { icon: Layers, label: '多模型支持', desc: 'OpenAI/DeepSeek/Anthropic等', color: '#f59e0b' },
    { icon: Radio, label: '消息通道', desc: '微信/飞书/Discord多通道接入', color: '#ec4899' },
    { icon: Shield, label: '安全沙箱', desc: '隔离执行环境保障系统安全', color: '#3b82f6' },
  ];

  const architectureItems = [
    { label: 'SubAgent 编排', desc: '多智能体协作完成复杂任务' },
    { label: 'L0/L1/L2 上下文', desc: '分层记忆管理实现长程对话' },
    { label: 'Hooks 生命周期', desc: '事件驱动的行为扩展机制' },
    { label: 'AUTO 智能路由', desc: '根据任务类型自动选择最优模型' },
  ];

  const modelProviders = [
    { name: 'OpenAI', color: '#10b981' },
    { name: 'DeepSeek', color: '#06b6d4' },
    { name: 'Anthropic', color: '#f59e0b' },
    { name: 'Google Gemini', color: '#3b82f6' },
    { name: '智谱 GLM', color: '#06b6d4' },
    { name: '通义千问', color: '#6366f1' },
    { name: '火山引擎', color: '#f97316' },
    { name: '更多...', color: '#64748b' },
  ];

  const messageChannels = [
    { name: '微信', icon: '💬' },
    { name: '飞书', icon: '🐦' },
    { name: 'Discord', icon: '🎮' },
    { name: 'Telegram', icon: '✈️' },
    { name: 'HTTP API', icon: '🔗' },
    { name: '桌面端', icon: '🖥️' },
  ];

  const uptime = systemStatus?.uptime || 0;
  const uptimeStr = uptime > 3600 ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m` : uptime > 60 ? `${Math.floor(uptime / 60)}m` : `${uptime}s`;

  return (
    <div style={{ height: '100%', width: '100%', overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div className="tech-bg" />
      <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'auto', padding: '32px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          {/* Hero 区域 */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{
              width: 80, height: 80, borderRadius: '50%', overflow: 'hidden', margin: '0 auto 16px',
              boxShadow: '0 0 20px rgba(6,182,212,.35), 0 0 40px rgba(6,182,212,.15), 0 0 60px rgba(139,92,246,.1)',
              border: '2px solid rgba(6,182,212,.2)',
              animation: 'avatar-glow 3s ease-in-out infinite alternate, float 4s ease-in-out infinite',
            }}>
              <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <h1 className="gradient-text" style={{ fontSize: 28, fontWeight: 700, margin: '0 0 6px' }}>段先生</h1>
            <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 4px' }}>自主进化智能体 · Mr.Duan v19.0</p>
            <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>Autonomous Evolving Agent</p>
          </div>

          {/* 详细介绍（300字以上） */}
          <section style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Bot style={{ width: 14, height: 14, color: '#06b6d4' }} />
              <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>关于段先生</h2>
            </div>
            <div style={{ padding: 18, borderRadius: 12, background: 'rgba(6,182,212,.03)', border: '1px solid rgba(6,182,212,.1)', lineHeight: 1.8, fontSize: 13, color: '#94a3b8' }}>
              <p style={{ margin: '0 0 10px' }}>
                <strong style={{ color: '#e2e8f0' }}>段先生（Mr.Duan）</strong>是一款自主进化的智能体系统，融合了大语言模型推理、工具调用、技能学习与自我进化能力。系统采用分层架构设计，底层支持接入 OpenAI、DeepSeek、Anthropic、Google Gemini、智谱 GLM、通义千问、火山引擎等主流大模型供应商，通过统一的 OpenAI 兼容接口实现"一套代码，多模型驱动"的核心特性，用户可根据任务需求灵活切换或自动路由最优模型。
              </p>
              <p style={{ margin: '0 0 10px' }}>
                <strong style={{ color: '#e2e8f0' }}>功能特性：</strong>内置浏览器、终端、代码编辑器三大原生工具窗口，支持上下文感知的智能展开机制；具备 SubAgent 多智能体编排能力，可将复杂任务拆分给独立上下文的子智能体并行处理；集成 L0/L1/L2 分层记忆系统，实现长程对话的上下文保持与经验积累；支持 Hooks 生命周期钩子与 MCP 协议扩展，可动态加载外部技能插件。
              </p>
              <p style={{ margin: '0 0 10px' }}>
                <strong style={{ color: '#e2e8f0' }}>适用场景：</strong>代码开发与审查、技术文档撰写、数据分析与可视化、桌面自动化操作、跨平台消息通道接入（微信/飞书/钉钉/Telegram/Slack 等）、以及需要多步骤推理与工具协同的复杂任务编排。AUTO 智能路由模式可根据任务类型自动选择代码专长模型、创意写作模型或快速响应模型，有效降低 token 消耗。
              </p>
              <p style={{ margin: 0 }}>
                <strong style={{ color: '#e2e8f0' }}>技术参数：</strong>支持流式响应（SSE）、工具函数调用（Function Calling）、思考过程展示（Reasoning Trace）；配置数据采用 AES-256-GCM 加密存储；桌面端基于 Electron 构建，支持 Windows/macOS/Linux 三端运行；CLI 端命令响应时间 &lt;500ms，工具调用响应时间 &lt;1s，连续运行 72 小时内存泄漏 &lt;5MB/24h。
              </p>
            </div>
          </section>

          {/* 核心能力 */}
          <section style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Zap style={{ width: 14, height: 14, color: '#06b6d4' }} />
              <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>核心能力</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {capabilities.map(cap => (
                <div key={cap.label} style={{
                  padding: 14, borderRadius: 12,
                  background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
                  transition: 'all .15s',
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.04)'; e.currentTarget.style.borderColor = `${cap.color}30`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.02)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.06)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, background: `${cap.color}12`, border: `1px solid ${cap.color}25`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <cap.icon style={{ width: 12, height: 12, color: cap.color }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{cap.label}</span>
                  </div>
                  <p style={{ fontSize: 11, color: '#64748b', margin: 0, lineHeight: 1.4 }}>{cap.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* 技术架构 */}
          <section style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Cpu style={{ width: 14, height: 14, color: '#8b5cf6' }} />
              <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>技术架构</h2>
            </div>
            <div style={{ padding: 16, borderRadius: 12, background: 'rgba(139,92,246,.03)', border: '1px solid rgba(139,92,246,.1)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                {architectureItems.map(item => (
                  <div key={item.label} style={{ display: 'flex', gap: 8 }}>
                    <div style={{ width: 4, borderRadius: 2, background: 'linear-gradient(180deg, #8b5cf6, #06b6d4)', flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', marginBottom: 2 }}>{item.label}</div>
                      <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 支持的模型供应商 */}
          <section style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Bot style={{ width: 14, height: 14, color: '#06b6d4' }} />
              <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>支持的模型供应商</h2>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {modelProviders.map(p => (
                <span key={p.name} style={{
                  padding: '4px 10px', borderRadius: 14, fontSize: 11,
                  background: `${p.color}0a`, border: `1px solid ${p.color}20`,
                  color: '#94a3b8', fontWeight: 500,
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.color, display: 'inline-block', marginRight: 4, verticalAlign: 1 }} />
                  {p.name}
                </span>
              ))}
            </div>
          </section>

          {/* 支持的消息通道 */}
          <section style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Radio style={{ width: 14, height: 14, color: '#ec4899' }} />
              <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>支持的消息通道</h2>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {messageChannels.map(ch => (
                <span key={ch.name} style={{
                  padding: '5px 12px', borderRadius: 14, fontSize: 12,
                  background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                  color: '#94a3b8',
                }}>
                  {ch.icon} {ch.name}
                </span>
              ))}
            </div>
          </section>

          {/* 系统状态（可折叠，5分钟闲置自动折叠，agent运行时自动展开） */}
          <section style={{ marginBottom: 20 }}>
            <button
              onClick={handleStatusToggle}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', padding: 0,
              }}
            >
              {statusExpanded ? <ChevronDown style={{ width: 14, height: 14, color: '#10b981' }} /> : <ChevronRight style={{ width: 14, height: 14, color: '#10b981' }} />}
              <Activity style={{ width: 14, height: 14, color: '#10b981' }} />
              <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>系统状态</h2>
              <span style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 8,
                background: isStreaming ? 'rgba(6,182,212,.12)' : 'rgba(16,185,129,.1)',
                color: isStreaming ? '#06b6d4' : '#10b981',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: isStreaming ? '#06b6d4' : '#10b981',
                  animation: isStreaming ? 'status-pulse-cyan 2s infinite' : 'status-pulse 2s infinite',
                }} />
                {isStreaming ? '运行中' : '就绪'}
              </span>
            </button>
            {statusExpanded && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)', textAlign: 'center' }}>
                  <Clock style={{ width: 14, height: 14, color: '#06b6d4', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>{uptimeStr}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>运行时间</div>
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(139,92,246,.04)', border: '1px solid rgba(139,92,246,.1)', textAlign: 'center' }}>
                  <MessageCircle style={{ width: 14, height: 14, color: '#8b5cf6', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>{conversations.length}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>对话次数</div>
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(16,185,129,.04)', border: '1px solid rgba(16,185,129,.1)', textAlign: 'center' }}>
                  <Sparkles style={{ width: 14, height: 14, color: '#10b981', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>{systemStatus?.skills ?? 0}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>技能数</div>
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(245,158,11,.04)', border: '1px solid rgba(245,158,11,.1)', textAlign: 'center' }}>
                  <Wrench style={{ width: 14, height: 14, color: '#f59e0b', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>{systemStatus?.toolsAvailable ?? 0}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>可用工具</div>
                </div>
                {/* 新增：版本、资源占用、连接状态、当前模型 */}
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)', textAlign: 'center' }}>
                  <Cpu style={{ width: 14, height: 14, color: '#06b6d4', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{systemStatus?.version || 'v19.0'}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>当前版本</div>
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(139,92,246,.04)', border: '1px solid rgba(139,92,246,.1)', textAlign: 'center' }}>
                  <Layers style={{ width: 14, height: 14, color: '#8b5cf6', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{systemStatus?.activeModels || '—'}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>当前模型</div>
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(16,185,129,.04)', border: '1px solid rgba(16,185,129,.1)', textAlign: 'center' }}>
                  <Heart style={{ width: 14, height: 14, color: '#10b981', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{systemStatus?.heartbeat?.running ? '活跃' : '休眠'}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>心跳状态</div>
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(245,158,11,.04)', border: '1px solid rgba(245,158,11,.1)', textAlign: 'center' }}>
                  <Radio style={{ width: 14, height: 14, color: '#f59e0b', margin: '0 auto 4px' }} />
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{systemStatus?.goals?.active ?? 0}</div>
                  <div style={{ fontSize: 10, color: '#475569' }}>活跃目标</div>
                </div>
              </div>
            )}
          </section>

          {/* 开源协议和贡献者 */}
          <section style={{ marginBottom: 24 }}>
            <div style={{ padding: 16, borderRadius: 12, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)', textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
                <GitBranch style={{ width: 12, height: 12, color: '#64748b' }} />
                <span style={{ fontSize: 12, color: '#94a3b8' }}>MIT License</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Heart style={{ width: 12, height: 12, color: '#ef4444' }} />
                <span style={{ fontSize: 12, color: '#64748b' }}>段雯泷+AI制作完成</span>
              </div>
            </div>
          </section>

          {/* 返回按钮 */}
          <div style={{ textAlign: 'center' }}>
            <button onClick={onBack} className="btn-primary" style={{ padding: '10px 28px' }}>
              返回对话
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== 主布局 =====
function MainLayout() {
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showSubAgent, setShowSubAgent] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showCapability, setShowCapability] = useState(false);
  const [browserNavigateUrl, setBrowserNavigateUrl] = useState<string>('');
  const [editorOpenFile, setEditorOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [activeNav, setActiveNav] = useState('chat');

  // 4.2 修复：在 React 应用内订阅主动发声 IPC（原监听在 desktop/index.html，但该文件从不加载）
  useProactiveVoice();

  // Agent 自动激活工具面板
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;
    const api = window.electronAPI;
    const unsub1 = api.tool?.onActivate?.((toolId: string) => {
      setActiveTool(toolId as ToolId);
    });
    const unsub2 = api.tool?.onBrowserNavigate?.((url: string) => {
      setBrowserNavigateUrl(url);
      setActiveTool('browser');
    });
    const unsub3 = api.tool?.onEditorOpenFile?.((data: { path: string; content: string }) => {
      setEditorOpenFile(data);
      setActiveTool('editor');
    });
    return () => { unsub1?.(); unsub2?.(); unsub3?.(); };
  }, []);

  // 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+B 切换侧边栏折叠
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        setSidebarCollapsed(prev => !prev);
      }
      // Ctrl+1/2/3 切换工具面板
      if (e.ctrlKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        const toolMap: Record<string, ToolId> = { '1': 'browser', '2': 'terminal', '3': 'editor' };
        const tool = toolMap[e.key];
        setActiveTool(prev => prev === tool ? null : tool);
      }
      // Esc 关闭工具面板
      if (e.key === 'Escape' && activeTool) {
        setActiveTool(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTool]);

  const handleToolToggle = (tool: ToolId) => {
    setActiveTool(prev => prev === tool ? null : tool);
  };

  const handleNavChange = (nav: string) => {
    setActiveNav(nav);
    // 切换到任何导航时，先重置所有页面状态
    setShowDashboard(false);
    setShowSkills(false);
    setShowChannels(false);
    setShowConfig(false);
    setShowAbout(false);
    setShowVoice(false);
    setShowSubAgent(false);
    setShowWorkflow(false);
    setShowMcp(false);
    setShowCapability(false);
    // 然后根据导航激活对应页面
    switch (nav) {
      case 'dashboard': setShowDashboard(true); break;
      case 'skills': setShowSkills(true); break;
      case 'channels': setShowChannels(true); break;
      case 'config': setShowConfig(true); break;
      case 'about': setShowAbout(true); break;
      case 'subagent': setShowSubAgent(true); break;
      case 'workflow': setShowWorkflow(true); break;
      case 'mcp': setShowMcp(true); break;
      case 'capability': setShowCapability(true); break;
    }
    if (nav !== 'chat') {
      setSidebarVisible(false);
    }
  };

  // 判断当前是否在对话页面
  const isChatPage = !showDashboard && !showSkills && !showChannels && !showConfig && !showAbout && !showVoice && !showSubAgent && !showWorkflow && !showMcp && !showCapability;

  // 监听自定义导航事件（如 ConfigPage 中的语音设置入口）
  useEffect(() => {
    const handleNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === 'voice') {
        setShowDashboard(false); setShowSkills(false); setShowChannels(false);
        setShowConfig(false); setShowAbout(false); setShowMcp(false);
        setShowVoice(true);
        setSidebarVisible(false);
      }
    };
    window.addEventListener('navigate', handleNavigate);
    return () => window.removeEventListener('navigate', handleNavigate);
  }, []);

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      backgroundColor: '#0a0e1a',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
    }}>
      <div className="tech-bg" />
      {/* 顶部渐变装饰线 */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(6,182,212,.3), rgba(139,92,246,.3), transparent)',
        zIndex: 100,
      }} />

      {/* 自定义标题栏 */}
      <TitleBar currentTab={showDashboard ? '仪表盘' : showSkills ? '技能管理' : showChannels ? '消息通道' : showConfig ? '设置' : showVoice ? '语音设置' : showSubAgent ? '多 Agent 编排' : showMcp ? 'MCP 管理' : showCapability ? '能力评估' : showAbout ? '关于' : '对话'} taskStatus={activeTool ? `${TOOLS.find(t => t.id === activeTool)?.label}已打开` : undefined} />

      {/* ===== 对话页面（始终渲染，用 display 控制可见性，避免卸载丢失状态） ===== */}
      <div style={{ display: isChatPage ? 'flex' : 'none', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
        {/* 三栏布局：Sidebar | ChatArea | ToolPanel */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flex: 1, width: '100%', overflow: 'hidden' }}>
          {/* 左侧边栏 - 可折叠 */}
          <Sidebar
            onToggle={() => setSidebarVisible(!sidebarVisible)}
            isVisible={sidebarVisible}
            onOpenConfig={() => setShowConfig(true)}
            onOpenSkills={() => setShowSkills(true)}
            onOpenDashboard={() => setShowDashboard(true)}
            onOpenChannels={() => setShowChannels(true)}
            onOpenAbout={() => setShowAbout(true)}
            onOpenSubAgent={() => setShowSubAgent(true)}
            onOpenMcp={() => setShowMcp(true)}
            onOpenCapability={() => setShowCapability(true)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            activeNav={activeNav}
            onNavChange={handleNavChange}
          />

          {/* 中间主面板：ChatArea */}
          <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            {/* 移动端菜单按钮 */}
            <div style={{
              display: 'none',
              alignItems: 'center',
              padding: '0 12px',
              height: 38,
              flexShrink: 0,
              borderBottom: '1px solid rgba(255,255,255,.06)',
              backgroundColor: 'rgba(10,14,26,.9)',
            }} id="mobile-header-bar">
              <button
                id="mobile-header"
                onClick={() => setSidebarVisible(true)}
                style={{
                  padding: 6, borderRadius: 8,
                  background: 'transparent', border: 'none',
                  cursor: 'pointer', color: '#94a3b8',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Menu style={{ width: 18, height: 18 }} />
              </button>
            </div>

            {/* ChatArea 始终占据主区域 */}
            <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a' }}>
              <ChatArea onOpenConfig={() => setShowConfig(true)} onOpenBrowser={(url) => { setBrowserNavigateUrl(url); setActiveTool('browser'); }} onActivateTool={(toolId) => setActiveTool(toolId)} toolPanelActive={!!activeTool} />
            </div>

            {/* 底部状态栏 */}
            <ChatStatusBar />
          </main>

          {/* 右侧工具面板（可收起，可拖拽调整宽度，支持Tab切换） */}
          {activeTool && (
            <ToolPanel
              activeTool={activeTool}
              navigateUrl={browserNavigateUrl}
              editorFile={editorOpenFile}
              onClose={() => setActiveTool(null)}
              onToolChange={handleToolToggle}
            />
          )}
        </div>
      </div>

      {/* ===== 仪表盘页面 ===== */}
      {showDashboard && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Suspense fallback={<PageLoader />}>
            <DashboardPage onBack={() => { setShowDashboard(false); setActiveNav('chat'); }} />
          </Suspense>
        </div>
      )}

      {/* ===== 技能管理页面 ===== */}
      {showSkills && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <div className="tech-bg" />
          <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<PageLoader />}>
              <SkillManagePage onBack={() => { setShowSkills(false); setActiveNav('chat'); }} />
            </Suspense>
          </div>
        </div>
      )}

      {/* ===== 消息通道页面 ===== */}
      {showChannels && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <div className="tech-bg" />
          <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<PageLoader />}>
              <ChannelsPage onBack={() => { setShowChannels(false); setActiveNav('chat'); }} />
            </Suspense>
          </div>
        </div>
      )}

      {/* ===== 设置页面 ===== */}
      {showConfig && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <div className="tech-bg" />
          <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<PageLoader />}>
              <ConfigPage onBack={() => { setShowConfig(false); setActiveNav('chat'); }} />
            </Suspense>
          </div>
        </div>
      )}

      {/* ===== 语音设置页面 ===== */}
      {showVoice && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <Suspense fallback={<PageLoader />}>
            <VoiceSettingsPage onBack={() => { setShowVoice(false); setActiveNav('chat'); }} />
          </Suspense>
        </div>
      )}

      {/* ===== 关于页面 ===== */}
      <div style={{ display: showAbout ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}>
        <AboutPage onBack={() => { setShowAbout(false); setActiveNav('chat'); }} />
      </div>

      {/* ===== 多 Agent 编排页面 ===== */}
      {showSubAgent && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <div className="tech-bg" />
          <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<PageLoader />}>
              <SubAgentPanel onBack={() => { setShowSubAgent(false); setActiveNav('chat'); }} />
            </Suspense>
          </div>
        </div>
      )}

      {/* ===== MCP 管理页面 ===== */}
      {showMcp && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <div className="tech-bg" />
          <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<PageLoader />}>
              <McpManagePage onBack={() => { setShowMcp(false); setActiveNav('chat'); }} />
            </Suspense>
          </div>
        </div>
      )}

      {/* ===== 能力评估页面 ===== */}
      {showCapability && (
        <div style={{ flex: 1, overflow: 'hidden', backgroundColor: '#0a0e1a', position: 'relative', flexDirection: 'column' }}>
          <div className="tech-bg" />
          <div style={{ position: 'relative', zIndex: 10, flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={<PageLoader />}>
              <CapabilityDashboardPage onBack={() => { setShowCapability(false); setActiveNav('chat'); }} />
            </Suspense>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 1023px) {
          #mobile-header-bar { display: flex !important; }
        }
      `}</style>

      {/* MCP 安全审批对话框 */}
      <McpApprovalDialog />
    </div>
  );
}

// ===== 全局 Error Boundary =====
interface GlobalErrorBoundaryProps {
  children: ReactNode;
}

interface GlobalErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  showStack: boolean;
}

class GlobalErrorBoundary extends Component<GlobalErrorBoundaryProps, GlobalErrorBoundaryState> {
  constructor(props: GlobalErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, showStack: false };
  }

  static getDerivedStateFromError(error: Error): GlobalErrorBoundaryState {
    return { hasError: true, error, showStack: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[App] Uncaught render error:', error, info);
  }

  componentDidUpdate(_prevProps: GlobalErrorBoundaryProps, prevState: GlobalErrorBoundaryState) {
    // 当 error 被清除后，自动确保回到正常状态
    if (prevState.hasError && !this.state.hasError) {
      // 已恢复，无需额外操作
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, showStack: false });
  };

  handleReload = () => {
    window.location.reload();
  };

  toggleStack = () => {
    this.setState(prev => ({ showStack: !prev.showStack }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: '100vh', width: '100vw', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          backgroundColor: '#0a0e1a', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 20,
          }}>
            <X style={{ width: 28, height: 28, color: '#ef4444' }} />
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>应用出现错误</h2>
          <p style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 6px', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error?.message || '未知渲染错误'}
          </p>
          <button
            onClick={this.toggleStack}
            style={{
              fontSize: 12, color: '#64748b', background: 'none', border: 'none',
              cursor: 'pointer', marginBottom: 16, textDecoration: 'underline',
              fontFamily: 'inherit',
            }}
          >
            {this.state.showStack ? '隐藏详情' : '查看详情'}
          </button>
          {this.state.showStack && this.state.error?.stack && (
            <pre style={{
              maxWidth: 600, maxHeight: 200, overflow: 'auto',
              background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)',
              borderRadius: 8, padding: 12, fontSize: 11, color: '#94a3b8',
              marginBottom: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {this.state.error.stack}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={this.handleReset}
              style={{
                padding: '10px 28px', borderRadius: 10, border: 'none',
                background: 'rgba(255,255,255,.06)', color: '#e2e8f0',
                cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', fontWeight: 500,
              }}
            >
              返回主页
            </button>
            <button
              onClick={this.handleReload}
              style={{
                padding: '10px 28px', borderRadius: 10, border: 'none',
                background: 'linear-gradient(135deg, rgba(6,182,212,.2), rgba(139,92,246,.2))',
                color: '#e2e8f0', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ===== App 入口 =====
function App() {
  return (
    <GlobalErrorBoundary>
      <MainLayout />
    </GlobalErrorBoundary>
  );
}

export default App;
