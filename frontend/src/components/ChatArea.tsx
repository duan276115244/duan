import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Search, Code2, FolderOpen, Terminal, User, Wrench, ArrowUp, ChevronDown, ChevronRight, Sparkles, Square, Copy, Check, Loader2, AlertCircle, CheckCircle2, Globe, Zap, Radio, RefreshCw, RotateCcw, X, Plus, Image, Paperclip, Wand2, BarChart3, AtSign } from 'lucide-react';
import { useChatStream, useConfig } from '@/hooks/useApi';
import { useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import type { Message } from '@/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { VoiceInput } from './VoiceInput';
import { VoiceOutput } from './VoiceOutput';
import { JarvisMode } from './JarvisMode';
import { SubAgentStatusCard } from './SubAgentStatusCard';
import { ThinkingTrace } from './ThinkingTrace';
import { SlashCommandMenu } from './SlashCommandMenu';
import { FileReferenceMenu } from './FileReferenceMenu';
import { CodeBlock } from './CodeBlock';
import { flattenFileTree, filterFiles, getLanguageFromExt, MAX_FILE_REFS, MAX_FILE_CONTENT_LENGTH, type FileEntry, type FileRef } from './fileReferenceUtils';
import { filterSlashCommands, findSlashCommand, type SlashCommand, type SlashCommandContext } from '@/commands/slashCommands';

// 模块级空数组常量，避免 selector 每次返回新数组引用导致无意义重渲染
const EMPTY_MESSAGES: Message[] = [];

// Token 估算（混合 CJK/ASCII）：CJK 字符约 1.5 token/字，ASCII 约 0.25 token/字符
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||  // CJK 统一表意文字
      (code >= 0x3040 && code <= 0x30ff) ||  // 日文假名
      (code >= 0xac00 && code <= 0xd7af)     // 韩文
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.5 + other * 0.25);
}

// 默认上下文窗口大小（token 数），多数模型 128K
const DEFAULT_CONTEXT_LIMIT = 128000;

// ReactMarkdown 组件覆盖配置（模块级常量，避免每次渲染重建对象）
// pre → CodeBlock：代码块增强（复制按钮 + 语言标签 + 超长折叠）
// code → 内联代码样式（块级代码由 pre → CodeBlock 处理，不会走到这里）
// a → 链接外部打开（Electron 中优先用 shell.openExternal）
// table 系列 → 暗色主题表格样式（配合 remark-gfm）
const INLINE_CODE_STYLE: React.CSSProperties = {
  padding: '1px 5px',
  borderRadius: 4,
  background: 'rgba(6,182,212,.08)',
  border: '1px solid rgba(6,182,212,.12)',
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  fontSize: '0.9em',
  color: '#67e8f9',
};

const LINK_STYLE: React.CSSProperties = {
  color: '#06b6d4',
  textDecoration: 'none',
  borderBottom: '1px solid rgba(6,182,212,.3)',
  transition: 'color .15s',
};

const TABLE_WRAPPER: React.CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  margin: '8px 0',
  fontSize: 12,
  borderRadius: 6,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,.08)',
};

const TH_STYLE: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left' as const,
  borderBottom: '1px solid rgba(255,255,255,.08)',
  background: 'rgba(255,255,255,.04)',
  fontWeight: 600,
  color: '#94a3b8',
  fontSize: 11,
};

const TD_STYLE: React.CSSProperties = {
  padding: '5px 10px',
  borderBottom: '1px solid rgba(255,255,255,.04)',
  color: '#e2e8f0',
};

const MARKDOWN_COMPONENTS = {
  pre({ children }: { children?: React.ReactNode }) {
    const childArray = React.Children.toArray(children);
    const child = childArray[0] as React.ReactElement<Record<string, unknown>> | undefined;
    if (!child || !child.props) return <pre>{children}</pre>;
    const className = (child.props.className as string) || '';
    const match = /language-(\w+)/.exec(className);
    const lang = match?.[1] || '';
    const content = String(child.props.children ?? '');
    return <CodeBlock language={lang} content={content} />;
  },
  // 内联代码样式（块级代码由 pre 渲染器拦截，不会走到这里）
  code({ children }: { children?: React.ReactNode }) {
    return <code style={INLINE_CODE_STYLE}>{children}</code>;
  },
  // 链接：Electron 中用外部浏览器打开，Web 中新标签页
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    const handleLinkClick = (e: React.MouseEvent) => {
      if (window.electronAPI?.browser?.open && href) {
        e.preventDefault();
        void window.electronAPI.browser.open(href);
      }
    };
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleLinkClick}
        style={LINK_STYLE}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#67e8f9'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = '#06b6d4'; }}
      >
        {children}
      </a>
    );
  },
  // 表格样式（配合 remark-gfm 的表格语法）
  table({ children }: { children?: React.ReactNode }) {
    return <div style={{ overflowX: 'auto' }}><table style={TABLE_WRAPPER}>{children}</table></div>;
  },
  th({ children }: { children?: React.ReactNode }) {
    return <th style={TH_STYLE}>{children}</th>;
  },
  td({ children }: { children?: React.ReactNode }) {
    return <td style={TD_STYLE}>{children}</td>;
  },
};

const quickActions = [
  { id: 'search', icon: Search, label: '搜索资讯', prompt: '搜索今日热点新闻', color: '#06b6d4' },
  { id: 'code', icon: Code2, label: '代码开发', prompt: '帮我编写一段代码', color: '#10b981' },
  { id: 'file', icon: FolderOpen, label: '文件操作', prompt: '帮我查看当前目录文件', color: '#f59e0b' },
  { id: 'system', icon: Terminal, label: '系统管理', prompt: '查看系统运行状态', color: '#a78bfa' },
];

// 工具状态图标（纯函数组件，无状态依赖）
const ToolStatusIcon = React.memo(({ status }: { status?: 'running' | 'success' | 'error' }) => {
  switch (status) {
    case 'running':
      return <Loader2 style={{ width: 12, height: 12, color: '#f59e0b', animation: 'spin 1s linear infinite' }} />;
    case 'success':
      return <CheckCircle2 style={{ width: 12, height: 12, color: '#10b981' }} />;
    case 'error':
      return <AlertCircle style={{ width: 12, height: 12, color: '#ef4444' }} />;
    default:
      return <Loader2 style={{ width: 12, height: 12, color: '#f59e0b', animation: 'spin 1s linear infinite' }} />;
  }
});

// 可用模型列表
const AVAILABLE_MODELS = [
  { id: 'auto', label: 'AUTO (智能路由)', provider: 'auto', description: '根据任务类型自动选择最优模型' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek', description: '通用对话' },
  { id: 'deepseek-reasoner', label: 'DeepSeek R1', provider: 'deepseek', description: '深度推理' },
  { id: 'glm-4-flash', label: 'GLM-4 Flash', provider: 'zhipu', description: '快速响应' },
  { id: 'glm-4-plus', label: 'GLM-4 Plus', provider: 'zhipu', description: '增强对话' },
  { id: 'qwen-turbo', label: 'Qwen Turbo', provider: 'qwen', description: '快速对话' },
  { id: 'qwen-plus', label: 'Qwen Plus', provider: 'qwen', description: '增强对话' },
  { id: 'ark-code-latest', label: 'Ark Code (火山)', provider: 'doubao-coding', description: '代码生成' },
  { id: 'doubao-seed-2.0-pro', label: '豆包 2.0 Pro', provider: 'doubao-coding', description: '通用对话' },
  { id: 'glm-5.2', label: 'GLM-5.2 (火山)', provider: 'doubao-coding', description: '代码生成' },
  { id: 'deepseek-v4-flash', label: 'DS-V4 Flash (火山)', provider: 'doubao-coding', description: '快速代码' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai', description: '快速任务' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', description: '高级对话' },
  { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku', provider: 'anthropic', description: '快速对话' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'gemini', description: '快速对话' },
];

// AUTO 智能路由规则说明（与后端 taskRules 保持一致）
const AUTO_ROUTING_RULES = [
  { type: '代码任务', models: 'Ark Code / DeepSeek Chat / GPT-4o', icon: '💻' },
  { type: '推理任务', models: 'DeepSeek R1 / o3-mini / GLM-4 Plus', icon: '🧠' },
  { type: '写作任务', models: 'GPT-4o / DeepSeek Chat / Qwen Plus', icon: '✍️' },
  { type: '快速任务', models: 'GPT-4o Mini / GLM-4 Flash / Qwen Turbo', icon: '⚡' },
  { type: '搜索任务', models: 'DeepSeek Chat / GPT-4o Mini / Qwen Turbo', icon: '🔍' },
];

// provider 分组标签
const PROVIDER_GROUPS: Record<string, string> = {
  'deepseek': 'DeepSeek',
  'zhipu': '智谱 GLM',
  'qwen': '通义千问',
  'doubao-coding': '火山引擎 Coding',
  'openai': 'OpenAI',
  'anthropic': 'Anthropic',
  'gemini': 'Google',
};

// ===== 工具调用卡片静态样式常量（避免每次渲染/map 迭代重建对象） =====
const TOOL_CARD_WRAPPER: React.CSSProperties = { display: 'flex', gap: 0 };
const TIMELINE_COLUMN: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 18, flexShrink: 0 };
const TIMELINE_LINE: React.CSSProperties = { width: 1, flex: 1, background: 'rgba(6,182,212,.12)', minHeight: 16 };
const TOOL_CARD_HEADER_BTN: React.CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0,
  padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
};
const TOOL_NAME_SPAN: React.CSSProperties = { color: '#67e8f9', fontWeight: 600, fontSize: 11 };
const TOOL_ARGS_PREVIEW: React.CSSProperties = { fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 };
const TOOL_ARGS_DETAIL: React.CSSProperties = { fontSize: 10, color: '#94a3b8', padding: '2px 5px', background: 'rgba(100,116,139,.06)', borderRadius: 3, marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 };
const TOOL_EXPAND_BTN: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', color: '#06b6d4', fontSize: 10, padding: '2px 0', fontFamily: 'inherit' };
const TOOLS_TOGGLE_BTN: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6,
  background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)',
  cursor: 'pointer', color: '#67e8f9', fontSize: 11, fontWeight: 500,
  fontFamily: 'inherit', transition: 'background .15s', width: '100%',
};

// P1 优化：以下组件从 ChatArea 内部提取到外部，避免每次渲染重建组件类型
// ===== 工具调用卡片（增强版：可展开、时间线排列） =====
const ToolCallCard = React.memo(({ tc, index, msgId, total, expandedToolResults, setExpandedToolResults }: {
  tc: { name: string; args?: unknown; result?: string; status?: 'running' | 'success' | 'error'; duration?: number };
  index: number;
  msgId: string;
  total?: number;
  expandedToolResults: Record<string, boolean>;
  setExpandedToolResults: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) => {
  const resultKey = `${msgId}-tool-${index}`;
  const isExpanded = expandedToolResults[resultKey] || false;
  const hasResult = tc.result && tc.result.length > 0;
  const safeResult = hasResult ? (tc.result!.length > 500 ? tc.result!.substring(0, 500) + '...' : tc.result!) : tc.result;
  const truncatedResult = hasResult && safeResult!.length > 200 ? safeResult!.substring(0, 200) + '...' : safeResult;

  const statusClass = tc.status === 'running' ? 'running' : tc.status === 'error' ? 'error' : '';
  const isLast = total !== undefined && index === total - 1;

  return (
    <div style={TOOL_CARD_WRAPPER}>
      {/* 时间线 */}
      <div style={TIMELINE_COLUMN}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 6,
          background: tc.status === 'running' ? '#f59e0b' : tc.status === 'error' ? '#ef4444' : '#10b981',
          boxShadow: tc.status === 'running' ? '0 0 6px rgba(245,158,11,.4)' : 'none',
        }} />
        {!isLast && <div style={TIMELINE_LINE} />}
      </div>
      {/* 卡片内容 */}
      <div className={`tool-call-card ${statusClass}`} style={{ flex: 1, marginBottom: isLast ? 0 : 3 }}>
        <button
          onClick={() => setExpandedToolResults(prev => ({ ...prev, [resultKey]: !prev[resultKey] }))}
          style={TOOL_CARD_HEADER_BTN}
        >
          <ToolStatusIcon status={tc.status} />
          <span style={TOOL_NAME_SPAN}>{tc.name}</span>
          {!!tc.args && !isExpanded && (
            <span style={TOOL_ARGS_PREVIEW}>
              {typeof tc.args === 'string' ? tc.args.substring(0, 50) : JSON.stringify(tc.args).substring(0, 50)}
            </span>
          )}
          <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
            {isExpanded ? <ChevronDown style={{ width: 11, height: 11, color: '#475569' }} /> : <ChevronRight style={{ width: 11, height: 11, color: '#475569' }} />}
          </span>
        </button>
        {isExpanded && (
          <div style={{ marginTop: 3 }}>
            {!!tc.args && (
              <div style={TOOL_ARGS_DETAIL}>
                <span style={{ color: '#64748b', fontWeight: 600 }}>参数: </span>
                {typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2)}
              </div>
            )}
            {hasResult && (
              <div
                style={{
                  color: tc.status === 'error' ? '#f87171' : '#34d399',
                  fontSize: 11,
                  maxHeight: isExpanded ? undefined : 60,
                  overflow: 'hidden',
                  padding: '3px 5px',
                  background: tc.status === 'error' ? 'rgba(239,68,68,.06)' : 'rgba(16,185,129,.06)',
                  borderRadius: 3,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: '#64748b', fontWeight: 600, fontSize: 10 }}>结果: </span>
                {(() => {
                  try {
                    const text = isExpanded ? safeResult! : truncatedResult!;
                    return <span>{text}</span>;
                  } catch {
                    return <span style={{ color: '#94a3b8' }}>[渲染结果出错]</span>;
                  }
                })()}
              </div>
            )}
            {safeResult && safeResult.length > 200 && (
              <button
                onClick={() => setExpandedToolResults(prev => ({ ...prev, [resultKey]: !prev[resultKey] }))}
                style={TOOL_EXPAND_BTN}
              >
                {isExpanded ? '收起' : '展开全部'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ===== 思考过程卡片 =====
// Phase D1: ThinkCard 已被 ThinkingTrace 取代（结构化渲染推理阶段 + 运行时事件）
// 历史组件代码已移除，避免 noUnusedLocals 报错；如需复用请从 git 历史恢复。

// ===== 消息操作按钮行 =====
const MessageActions = React.memo(({ msgId, content, copiedId, handleCopy, handleRetry, handleRollback }: {
  msgId: string;
  content: string;
  copiedId: string | null;
  handleCopy: (msgId: string, content: string) => void;
  handleRetry: (msgId: string) => void;
  handleRollback: (msgId: string) => void;
}) => (
  <div className="msg-action-row" style={{ display: 'flex', gap: 2, marginTop: 4 }}>
    <VoiceOutput text={content} />
    <button
      onClick={() => handleCopy(msgId, content)}
      title="复制"
      style={{
        padding: '3px 6px', borderRadius: 5, border: 'none',
        background: 'transparent', cursor: 'pointer',
        color: copiedId === msgId ? '#10b981' : '#64748b',
        display: 'flex', alignItems: 'center', gap: 3,
        fontSize: 10, fontFamily: 'inherit', transition: 'all .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#94a3b8'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = copiedId === msgId ? '#10b981' : '#64748b'; }}
    >
      {copiedId === msgId ? <Check style={{ width: 11, height: 11 }} /> : <Copy style={{ width: 11, height: 11 }} />}
      {copiedId === msgId ? '已复制' : '复制'}
    </button>
    <button
      onClick={() => handleRetry(msgId)}
      title="重试"
      style={{
        padding: '3px 6px', borderRadius: 5, border: 'none',
        background: 'transparent', cursor: 'pointer',
        color: '#64748b', display: 'flex', alignItems: 'center', gap: 3,
        fontSize: 10, fontFamily: 'inherit', transition: 'all .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#94a3b8'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
    >
      <RefreshCw style={{ width: 11, height: 11 }} />
      重试
    </button>
    <button
      onClick={() => handleRollback(msgId)}
      title="回退"
      style={{
        padding: '3px 6px', borderRadius: 5, border: 'none',
        background: 'transparent', cursor: 'pointer',
        color: '#64748b', display: 'flex', alignItems: 'center', gap: 3,
        fontSize: 10, fontFamily: 'inherit', transition: 'all .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#f87171'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
    >
      <RotateCcw style={{ width: 11, height: 11 }} />
      回退
    </button>
  </div>
));

interface ChatAreaProps {
  onOpenConfig?: () => void;
  onOpenBrowser?: (url: string) => void;
  onActivateTool?: (toolId: 'editor' | 'browser' | 'terminal') => void;
  toolPanelActive?: boolean;
}

// ===== 单条消息组件 — React.memo 避免流式输出时重渲染所有历史消息 =====
// 流式输出时 streamingText 每个 chunk 变化都会触发 ChatArea 重渲染，
// 但历史消息的 props 未变，React.memo 跳过重渲染，只更新流式区域。
const MessageItem = React.memo(({
  msg,
  expandedThinking,
  setExpandedThinking,
  expandedTools,
  setExpandedTools,
  expandedToolResults,
  setExpandedToolResults,
  copiedId,
  handleCopy,
  handleRetry,
  handleRollback,
}: {
  msg: Message;
  expandedThinking: Record<string, boolean>;
  setExpandedThinking: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  expandedTools: Record<string, boolean>;
  setExpandedTools: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  expandedToolResults: Record<string, boolean>;
  setExpandedToolResults: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  copiedId: string | null;
  handleCopy: (msgId: string, content: string) => void;
  handleRetry: (msgId: string) => void;
  handleRollback: (msgId: string) => void;
}) => {
  return (
    <div className={msg.role === 'user' ? 'message-appear-user' : 'message-appear-agent'} style={{
      marginBottom: 20, display: 'flex', gap: 10,
      flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
    }}>
      {/* 头像 */}
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        {msg.role === 'assistant' ? (
          <div style={{
            width: 32, height: 32, borderRadius: '50%', overflow: 'hidden',
            boxShadow: '0 0 10px rgba(6,182,212,.35), 0 0 20px rgba(6,182,212,.15), 0 0 40px rgba(139,92,246,.08)',
            border: '1.5px solid rgba(6,182,212,.25)',
          }}>
            <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
        ) : (
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'linear-gradient(135deg, #06b6d4, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 10px rgba(6,182,212,.3), 0 0 20px rgba(139,92,246,.1)',
            border: '1.5px solid rgba(6,182,212,.2)',
          }}>
            <User style={{ width: 14, height: 14, color: '#fff' }} />
          </div>
        )}
      </div>

      {/* 消息内容 */}
      <div className={msg.role === 'assistant' ? 'assistant-msg-wrapper' : undefined} style={{ flex: 1, minWidth: 0, maxWidth: '85%' }}>
        {msg.role === 'user' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="message-bubble-user" style={{
              fontSize: 13, lineHeight: 1.6, color: '#f0f9ff',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {msg.content}
            </div>
          </div>
        )}
        {msg.role === 'assistant' && (
          <>
            {/* 思考过程 — Phase D1: 改用 ThinkingTrace 结构化渲染 */}
            {msg.thinking && (
              <ThinkingTrace thinking={msg.thinking} msgId={msg.id} hasTools={!!(msg.toolCalls && msg.toolCalls.length > 0)} expandedThinking={expandedThinking} setExpandedThinking={setExpandedThinking} />
            )}
            {/* 工具调用 */}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setExpandedTools(prev => ({ ...prev, [`tools-${msg.id}`]: !prev[`tools-${msg.id}`] }))}
                  style={TOOLS_TOGGLE_BTN}
                >
                  {expandedTools[`tools-${msg.id}`] ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
                  <Wrench style={{ width: 11, height: 11, color: '#06b6d4' }} />
                  使用了 {msg.toolCalls.length} 个工具
                </button>
                {expandedTools[`tools-${msg.id}`] && (
                  <div style={{ marginTop: 3 }}>
                    {msg.toolCalls.map((tc, i) => (
                      <ToolCallCard key={i} tc={tc} index={i} msgId={msg.id} expandedToolResults={expandedToolResults} setExpandedToolResults={setExpandedToolResults} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* 消息正文 */}
            <div className="message-bubble-agent" style={{ position: 'relative' }}>
              <div className="markdown-body" style={{ fontSize: 13, lineHeight: 1.6, color: '#e2e8f0' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{msg.content}</ReactMarkdown>
              </div>
            </div>
            {/* 操作按钮 */}
            <MessageActions msgId={msg.id} content={msg.content} copiedId={copiedId} handleCopy={handleCopy} handleRetry={handleRetry} handleRollback={handleRollback} />
          </>
        )}
      </div>
    </div>
  );
});

export function ChatArea({ onOpenConfig, onOpenBrowser, onActivateTool, toolPanelActive }: ChatAreaProps) {
  // useShallow 选择稳定引用（action 函数 + ID），避免 isStreaming/systemStatus/tools 等无关 state 变化触发重渲染
  const {
    currentConversationId,
    addMessage,
    createConversation,
    setIsStreaming: setStoreStreaming,
    updateConversationTitle,
    removeMessagesFrom,
  } = useChatStore(useShallow(s => ({
    currentConversationId: s.currentConversationId,
    addMessage: s.addMessage,
    createConversation: s.createConversation,
    setIsStreaming: s.setIsStreaming,
    updateConversationTitle: s.updateConversationTitle,
    removeMessagesFrom: s.removeMessagesFrom,
  })));
  // 单独订阅当前对话消息：addMessage/removeMessagesFrom 后 messages 数组引用变化 → 触发重渲染
  const messages = useChatStore(useShallow(s =>
    s.conversations.find(c => c.id === s.currentConversationId)?.messages ?? EMPTY_MESSAGES
  ));

  const [inputValue, setInputValue] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamingToolCalls, setStreamingToolCalls] = useState<Array<{ name: string; args?: unknown; result?: string; status?: 'running' | 'success' | 'error'; startTime?: number; duration?: number }>>([]);
  // 系统告警流式状态（warning 事件，amber 横幅展示）— 对标 Claude Code 系统状态可见性
  const [streamingWarnings, setStreamingWarnings] = useState<Array<{ id: string; content: string; ts: number }>>([]);
  // 上下文压缩通知流式状态（compact 事件，📦 卡片展示）— 对标 Claude Code compaction display cards
  const [streamingCompactions, setStreamingCompactions] = useState<Array<{ id: string; content: string; ts: number; expanded: boolean }>>([]);
  // Slash 命令菜单状态（对标 Claude Code / Devin CLI）
  const [slashMenu, setSlashMenu] = useState<{ visible: boolean; commands: SlashCommand[]; selectedIndex: number }>({ visible: false, commands: [], selectedIndex: 0 });
  // 计划模式（/plan 触发，下一条消息前缀"请先制定执行计划再动手"）— 对标 Claude Code Plan Mode
  const [planMode, setPlanMode] = useState(false);
  // @file 引用状态（对标 Cursor @mention）：已选文件列表 + 自动完成菜单
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const [fileMenu, setFileMenu] = useState<{ visible: boolean; files: FileEntry[]; selectedIndex: number; loading: boolean }>({ visible: false, files: [], selectedIndex: 0, loading: false });
  // 拖拽文件高亮状态（对标 Cursor / VS Code 拖拽视觉反馈）
  const [isDragOver, setDragOver] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [expandedToolResults, setExpandedToolResults] = useState<Record<string, boolean>>({});
  const [inputFocused, setInputFocused] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [availablePaiModels, setAvailablePaiModels] = useState<Array<{ provider: string; model: string; perfScore: number; successRate: number; avgDuration: number; totalCalls: number; hasPerformanceData: boolean }>>([]);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizeSuccess, setOptimizeSuccess] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [sidebarUserManual, setSidebarUserManual] = useState(false); // 用户是否手动操作过侧边栏
  const [showDetailLog, setShowDetailLog] = useState(false); // 详细日志弹窗
  const [attachments, setAttachments] = useState<Array<{ name: string; path: string; isImage: boolean; base64: string; mimeType: string; ext: string }>>([]);
  const [remoteMessages, setRemoteMessages] = useState<Array<{ role: string; content: string; channel: string; userId: string; timestamp: string }>>([]);

  // rAF 批处理流式更新：将高频 chunk（每秒 20-50 个）合并到每帧一次 setState（~60fps）
  // 避免每个 chunk 触发 ChatArea 重渲染 + ReactMarkdown 全量重新解析
  const streamingRafRef = useRef<number | null>(null);
  const pendingTextRef = useRef('');
  const pendingThinkRef = useRef('');
  const scheduleStreamingFlush = useCallback(() => {
    if (streamingRafRef.current !== null) return; // 已有 rAF 在等待，跳过
    streamingRafRef.current = requestAnimationFrame(() => {
      streamingRafRef.current = null;
      setStreamingText(pendingTextRef.current);
      setStreamingThinking(pendingThinkRef.current);
    });
  }, []);
  const cancelStreamingRaf = useCallback(() => {
    if (streamingRafRef.current !== null) {
      cancelAnimationFrame(streamingRafRef.current);
      streamingRafRef.current = null;
    }
  }, []);
  const [showRemotePanel, setShowRemotePanel] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 智能滚动：追踪用户是否在底部，避免流式输出打断阅读
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 追踪当前正在流式响应的对话ID，避免切换对话后回调写入错误对话或影响新对话状态
  const streamingConvIdRef = useRef<string | null>(null);
  // Phase G3: 本轮是否已自动折叠流式思考区（防止用户重新展开后又被折叠）
  const autoCollapsedThinkRef = useRef(false);
  // Slash 命令执行上下文 ref：每次渲染更新，避免 handleSend deps 膨胀（slash 命令仅在 / 拦截时读取）
  const slashCtxRef = useRef<SlashCommandContext>(null as unknown as SlashCommandContext);
  // @file 引用：文件树缓存（首次 @ 触发时加载，后续复用避免重复 IPC 调用）
  const fileTreeCacheRef = useRef<FileEntry[] | null>(null);
  // @file 引用：当前 @ 触发在输入框中的起始位置（@ 字符的 index），-1 表示未触发
  const atTriggerPosRef = useRef(-1);
  // 上箭头召回历史消息（对标终端/Claude Code）：-1 表示未在浏览历史模式
  const historyIndexRef = useRef(-1);
  const { sendMessage, abort } = useChatStream();
  const { config } = useConfig();
  const defaultModel = config?.defaultModel || 'auto';

  // 初始化选中模型
  useEffect(() => {
    if (!selectedModel && defaultModel) {
      setSelectedModel(defaultModel);
    }
  }, [defaultModel]);

  // 窗口打开时设置 textarea 初始高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '48px';
    }
  }, []);

  // 监听远程通道消息（飞书/企业微信等），将远程对话同步到聊天列表
  useEffect(() => {
    // 直接提取 remoteConversations 为 const，确保闭包内类型收窄
    const remoteConv = typeof window !== 'undefined' ? window.electronAPI?.remoteConversations : undefined;
    if (!remoteConv) return;

    let cancelled = false;
    let lastMsgCount = 0;

    // 获取远程对话列表并加载消息，同步到 chatStore
    async function loadRemoteMessages() {
      try {
        const result = await remoteConv!.list();
        if (cancelled || !result?.conversations || result.conversations.length === 0) return; // P1 修复：await 后检查 cancelled

        // 为每个远程对话创建/更新 chatStore 中的对话
        for (const conv of result.conversations) {
          if (cancelled) return; // P1 修复：每次迭代前检查
          const convId = `remote_${conv.id}`; // 使用 remote_ 前缀避免与本地对话冲突
          const channelLabel = conv.id.includes('feishu') ? '飞书' : conv.id.includes('wecom') ? '企业微信' : '远程';

          const msgResult = await remoteConv!.messages(conv.id);
          if (cancelled || !msgResult?.messages || !Array.isArray(msgResult.messages)) continue; // P1 修复：await 后检查

          // 检查 chatStore 中是否已有此对话
          const existingConv = useChatStore.getState().conversations.find(c => c.id === convId);
          const newMsgCount = msgResult.messages.length;

          // 如果消息数没变，跳过更新
          if (existingConv && existingConv.messages.length === newMsgCount) continue;

          // 构建消息列表
          const formattedMessages = msgResult.messages.map((m: { role?: string; content?: string }, idx: number) => ({
            id: `${convId}_msg_${idx}`,
            role: (m.role || 'user') as 'user' | 'assistant',
            content: m.content || '',
            timestamp: new Date(conv.updatedAt || Date.now()),
            channel: channelLabel,
          }));

          if (existingConv) {
            // 更新已有对话的消息
            useChatStore.setState((state) => ({
              conversations: state.conversations.map(c =>
                c.id === convId
                  ? { ...c, messages: formattedMessages, updatedAt: new Date() }
                  : c
              ),
            }));
          } else {
            // 创建新的远程对话
            const newConv = {
              id: convId,
              title: `${channelLabel}机器人对话`,
              messages: formattedMessages,
              createdAt: new Date(conv.createdAt || Date.now()),
              updatedAt: new Date(),
            };
            useChatStore.setState((state) => ({
              conversations: [newConv, ...state.conversations],
            }));
          }

          // 更新远程消息状态（用于面板显示）
          if (newMsgCount > lastMsgCount) {
            lastMsgCount = newMsgCount;
            if (cancelled) return; // P1 修复：状态更新前检查
            setRemoteMessages(formattedMessages.map((m: { role: string; content: string; timestamp: Date }) => ({
              role: m.role,
              content: m.content,
              channel: channelLabel,
              userId: conv.id,
              timestamp: m.timestamp.toISOString(),
            })));
            setShowRemotePanel(true);
          }
        }
      } catch { /* ignore */ }
    }

    loadRemoteMessages();

    // 监听远程对话更新事件
    const unsubscribe = remoteConv.onUpdated(() => {
      if (!cancelled) loadRemoteMessages();
    });

    // 定期刷新（每 3 秒，更频繁以实时看到飞书消息）
    const interval = setInterval(loadRemoteMessages, 3000);

    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      clearInterval(interval);
    };
  }, []);

  // 是否正在查看正在进行流式响应的对话（用于隔离切换对话后的流式展示）
  const isViewingStreaming = isStreaming && streamingConvIdRef.current === currentConversationId;

  // ===== 获取已配置的 provider 列表 =====
  const configuredProviders = React.useMemo(() => {
    if (!config?.apiKeys) return [] as string[];
    return Object.entries(config.apiKeys)
      .filter(([, v]) => v && v !== '未配置' && (v === '已配置' || (typeof v === 'string' && v.length > 8)))
      .map(([k]) => k);
  }, [config?.apiKeys]);

  // ===== 过滤后的模型列表（仅显示已配置的 + AUTO，未配置的归入"添加智能体"） =====
  const filteredModels = React.useMemo(() => {
    return AVAILABLE_MODELS.filter(m => m.provider === 'auto' || configuredProviders.includes(m.provider));
  }, [configuredProviders]);

  // ===== 未配置的供应商列表（用于"添加智能体"入口） =====
  const unconfiguredProviders = React.useMemo(() => {
    return Object.entries(PROVIDER_GROUPS)
      .filter(([key]) => !configuredProviders.includes(key))
      .map(([key, label]) => ({ key, label }));
  }, [configuredProviders]);

  // Token/上下文使用量估算（对标 Claude Code 上下文窗口进度条）
  const tokenEstimate = React.useMemo(() => {
    let total = 2000; // 系统提示词开销
    for (const msg of messages) {
      total += estimateTokens(msg.content);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.args) total += estimateTokens(typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args));
          if (tc.result) total += estimateTokens(tc.result);
        }
      }
    }
    if (streamingText) total += estimateTokens(streamingText);
    if (streamingThinking) total += estimateTokens(streamingThinking);
    return total;
  }, [messages, streamingText, streamingThinking]);
  const tokenPct = Math.min(100, (tokenEstimate / DEFAULT_CONTEXT_LIMIT) * 100);

  // 智能自动滚动：仅当用户已在底部时才跟随新内容滚动
  // 用户向上阅读历史时不会被流式输出打断
  useEffect(() => {
    if (isAtBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
    }
  }, [messages, streamingText, isStreaming]);

  // 滚动事件处理：追踪是否在底部 + 显示/隐藏回到底部按钮
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // 40px 容差，避免浮点精度和底部 padding 导致误判
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    isAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  // Phase G3: 实际回答开始流式时，自动折叠流式思考区（让答案立即可见）
  // 仅本轮触发一次；用户此后若重新展开不会被再次折叠
  useEffect(() => {
    if (!streamingText || autoCollapsedThinkRef.current) return;
    autoCollapsedThinkRef.current = true;
    setExpandedThinking(prev => (prev['__streaming__'] ? { ...prev, __streaming__: false } : prev));
  }, [streamingText]);

  // 当模型选择器打开时，加载所有已配置供应商的可用模型及性能数据
  useEffect(() => {
    if (!showModelPicker) return;
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (!isE) return;
    const api = window.electronAPI;
    if (!api?.agent?.listAvailableModels) return;
    api.agent.listAvailableModels(configuredProviders).then((result: { success?: boolean; models?: unknown[] }) => {
      if (result?.success && Array.isArray(result.models)) {
        setAvailablePaiModels(result.models as Array<{ provider: string; model: string; perfScore: number; successRate: number; avgDuration: number; totalCalls: number; hasPerformanceData: boolean }>);
      }
    }).catch(() => {});
  }, [showModelPicker, configuredProviders]);

  // 自动展开/收起侧边栏（不影响用户手动操作）
  useEffect(() => {
    if (isViewingStreaming && (streamingToolCalls.length > 0 || !!streamingThinking)) {
      if (!sidebarUserManual) {
        setSidebarExpanded(true);
      }
    } else if (!isViewingStreaming) {
      if (!sidebarUserManual) {
        const timer = setTimeout(() => setSidebarExpanded(false), 3000);
        return () => clearTimeout(timer);
      }
    }
  }, [isViewingStreaming, streamingToolCalls.length, !!streamingThinking, sidebarUserManual]);

  // 当工具面板打开时，自动折叠 agent 状态侧边栏避免挤压对话区域
  useEffect(() => {
    if (toolPanelActive && sidebarExpanded) {
      setSidebarExpanded(false);
      setSidebarUserManual(false); // 重置手动操作标记，允许后续自动展开
    }
  }, [toolPanelActive, sidebarExpanded]); // P2 修复：添加 sidebarExpanded 依赖避免闭包过期

  // 输入框自动扩展高度：仅在发送消息后校正（onChange 中已实时调整，无需在 effect 中重复）

  const handleCopy = useCallback(async (msgId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(msgId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopiedId(msgId);
      setTimeout(() => setCopiedId(null), 2000);
    }
  }, []);

  const handleSend = useCallback((overrideMessage?: string, isRetry?: boolean) => {
    const rawInput = (overrideMessage || inputValue).trim();
    // 发送时退出历史浏览模式
    historyIndexRef.current = -1;
    // Slash 命令拦截（对标 Claude Code / Devin CLI）：/ 开头且单行 → 查找并执行命令
    if (!isRetry && rawInput.startsWith('/') && !rawInput.includes('\n')) {
      const cmdName = rawInput.slice(1).split(/\s+/)[0];
      const cmd = findSlashCommand(cmdName);
      if (cmd) {
        const result = cmd.execute(slashCtxRef.current);
        setInputValue('');
        setSlashMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        // /help /steps 返回文本 → 作为本地助手消息注入当前对话（不发送给 LLM）
        if (typeof result === 'string' && currentConversationId) {
          addMessage(currentConversationId, {
            id: `msg_${Date.now()}`, role: 'assistant', content: result, timestamp: new Date(),
          });
        }
        return; // 不走正常发送流程
      }
      // 未知命令：仍允许作为普通消息发送（避免阻断用户输入）
    }

    let message = rawInput;
    // 计划模式前缀（/plan 触发，one-shot：发送后自动关闭）
    if (planMode && !isRetry) {
      message = `请先制定执行计划再动手：\n${message}`;
      setPlanMode(false);
    }

    // @file 引用上下文注入（对标 Cursor @file context injection）
    // message（含完整文件内容）发给 LLM；content（仅摘要）存入 store 供展示
    const currentFileRefs = !isRetry ? [...fileRefs] : [];
    if (currentFileRefs.length > 0) {
      const fileContext = currentFileRefs.map(f => {
        const lang = getLanguageFromExt(f.ext);
        // 超长文件截断（避免撑爆上下文窗口）
        const raw = f.content || '(空文件或读取失败)';
        const truncated = raw.length > MAX_FILE_CONTENT_LENGTH
          ? raw.slice(0, MAX_FILE_CONTENT_LENGTH) + '\n... (已截断，完整文件共 ' + raw.length + ' 字符)'
          : raw;
        return `--- ${f.relativePath} ---\n\`\`\`${lang}\n${truncated}\n\`\`\``;
      }).join('\n\n');
      message = `${message}\n\n以下是被 @ 引用的文件内容，供你参考：\n\n${fileContext}`;
    }

    if ((!message && attachments.length === 0) || isStreaming) return;

    let convId = currentConversationId;
    if (!convId) {
      convId = createConversation();
    }
    // 捕获发送时的对话ID，切换对话后回调仍写入正确的对话
    const targetConvId = convId;
    streamingConvIdRef.current = targetConvId;

    if (!isRetry) {
      // 构建包含附件的消息内容（存储到 store 供展示，不含 @file 完整内容，仅摘要）
      let content = rawInput;
      if (planMode) content = `请先制定执行计划再动手：\n${content}`;
      // @file 引用摘要（展示用，完整内容已注入 message 发给 LLM）
      if (currentFileRefs.length > 0) {
        const refSummary = `[引用文件: ${currentFileRefs.map(f => f.relativePath).join(', ')}]`;
        content = content ? `${content}\n${refSummary}` : refSummary;
      }
      const currentAttachments = [...attachments];
      if (currentAttachments.length > 0) {
        const attachmentInfo = currentAttachments.map(a => {
          if (a.isImage) {
            return `[图片: ${a.name}]`;
          }
          return `[文件: ${a.name}]`;
        }).join('\n');
        content = content ? `${content}\n${attachmentInfo}` : attachmentInfo;
      }
      const userMsg = { id: `msg_${Date.now()}`, role: 'user' as const, content, timestamp: new Date(), attachments: currentAttachments.length > 0 ? currentAttachments : undefined };
      addMessage(targetConvId, userMsg);
      // 清空附件和文件引用
      setAttachments([]);
      setFileRefs([]);
    }

    // 更新对话标题（任务6修复）
    const conv = useChatStore.getState().conversations.find(c => c.id === targetConvId);
    if (conv && conv.title === '新的对话') {
      updateConversationTitle(targetConvId, message.substring(0, 20));
    }

    if (!overrideMessage) {
      setInputValue('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }

    setIsStreaming(true);
    setStoreStreaming(true);
    setIsTyping(true);
    cancelStreamingRaf();
    pendingTextRef.current = '';
    pendingThinkRef.current = '';
    setStreamingText('');
    setStreamingThinking('');
    setStreamingToolCalls([]);
    setStreamingWarnings([]);
    setStreamingCompactions([]);
    // Phase G3: 重置自动折叠标记（每轮独立）
    autoCollapsedThinkRef.current = false;

    const currentMsgs = useChatStore.getState().conversations.find(c => c.id === targetConvId)?.messages || [];
    // 非重试时用户消息已在上方 addMessage 加入 store，无需重复追加
    // 重试时用户消息未加入 store，需要手动追加
    const history = isRetry
      ? [...currentMsgs, { id: `msg_${Date.now()}`, role: 'user' as const, content: message, timestamp: new Date() }].map(m => ({ role: m.role, content: m.content }))
      : currentMsgs.map(m => ({ role: m.role, content: m.content }));
    // 收集附件数据（图片的 base64 用于多模态 API）
    const attachmentsForAPI = !isRetry ? [...attachments] : [];
    let accText = '', accThink = '';
    const accTools: Array<{ name: string; args?: unknown; result?: string; status?: 'running' | 'success' | 'error'; startTime?: number; duration?: number }> = [];

    // AUTO 智能路由：如果是 auto 模式，先通过 IPC 获取最优模型
    const effectiveModel = (selectedModel && selectedModel !== 'auto') ? selectedModel : (defaultModel !== 'auto' ? defaultModel : undefined);
    const requestStartTime = Date.now();

    // 如果是 AUTO 模式且有 electronAPI，先进行智能路由
    if (selectedModel === 'auto' && window.electronAPI?.agent?.autoRoute) {
      const electronAPI = window.electronAPI;
      electronAPI.agent.autoRoute(message, configuredProviders).then((routeResult: { success?: boolean; model?: string; taskType?: string }) => {
        const routedModel = routeResult?.success ? routeResult.model : undefined;
        const taskType = routeResult?.taskType || '通用任务';
        const actualModel = routedModel || effectiveModel;
        doSendMessage(message, history, actualModel, attachmentsForAPI, taskType, requestStartTime);
      }).catch(() => {
        doSendMessage(message, history, effectiveModel, attachmentsForAPI);
      });
    } else {
      doSendMessage(message, history, effectiveModel, attachmentsForAPI);
    }

    function doSendMessage(msg: string, hist: Array<{ role: string; content: string }>, model?: string, attchs?: Array<{ name: string; path: string; isImage: boolean; base64: string; mimeType: string; ext: string }>, taskType?: string, startTime?: number) {
      sendMessage(msg, hist, (event) => {
        // 仅当目标对话仍是当前查看的对话时才更新流式展示，避免切换对话后内容串台
        const isCurrent = streamingConvIdRef.current === useChatStore.getState().currentConversationId;
        if (event.type === 'think') {
          accThink += (event.content || '');
          if (isCurrent) { pendingThinkRef.current = accThink; setIsTyping(false); scheduleStreamingFlush(); }
        }
        else if (event.type === 'text') { accText += (event.content || ''); if (isCurrent) { pendingTextRef.current = accText; setIsTyping(false); scheduleStreamingFlush(); } }
        else if (event.type === 'tool_call') {
          accTools.push({ name: event.toolName || 'unknown', args: event.toolArgs, result: undefined, status: 'running', startTime: Date.now() });
          if (isCurrent) { setStreamingToolCalls([...accTools]); setIsTyping(false); }
          // 面板联动：根据工具类型自动激活对应面板
          const toolName = event.toolName || '';
          if (onActivateTool) {
            if (toolName === 'file_write' || toolName === 'file_read') {
              onActivateTool('editor');
            } else if (toolName === 'shell_execute') {
              onActivateTool('terminal');
            } else if (toolName === 'browser_operate' || toolName === 'desktop_open') {
              onActivateTool('browser');
            }
          }
        }
        else if (event.type === 'tool_result') {
          const lt = accTools[accTools.length - 1];
          if (lt) {
            lt.result = event.content;
            // 优先使用后端返回的 success 字段，回退到内容检测
            const backendSuccess = (event as { success?: boolean }).success;
            if (backendSuccess !== undefined) {
              lt.status = backendSuccess ? 'success' : 'error';
            } else {
              // 改进的错误检测：仅检测 ❌ 前缀和明确的错误关键词
              const content = event.content || '';
              lt.status = content.startsWith('❌') || content.includes('工具执行失败') || content.includes('工具执行异常') ? 'error' : 'success';
            }
            // 优先使用后端返回的 duration 字段
            lt.duration = (event as { duration?: number }).duration || (lt.startTime ? Date.now() - lt.startTime : undefined);
          }
          if (isCurrent) setStreamingToolCalls([...accTools]);
        }
        else if (event.type === 'error') { accText += `\n\n错误: ${event.content || '未知错误'}`; if (isCurrent) { pendingTextRef.current = accText; setIsTyping(false); scheduleStreamingFlush(); } }
        // 系统告警事件（warning）— 模型 404/402/限速/超时/网络错误/上下文过长等，渲染为 amber 横幅
        else if (event.type === 'warning') {
          if (isCurrent) {
            setStreamingWarnings(prev => [...prev, { id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, content: event.content || '', ts: Date.now() }]);
            setIsTyping(false);
          }
        }
        // 上下文压缩通知（compact）— 渲染为 📦 压缩卡片（对标 Claude Code compaction cards）
        else if (event.type === 'compact') {
          if (isCurrent) {
            setStreamingCompactions(prev => [...prev, { id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, content: event.content || '', ts: Date.now(), expanded: false }]);
            setIsTyping(false);
          }
        }
        // 执行计划事件（plan）— 仍写入思考流保持推理可见性，类型链路已打通供未来结构化卡片升级
        else if (event.type === 'plan') {
          accThink += (event.content || '');
          if (isCurrent) { pendingThinkRef.current = accThink; setIsTyping(false); scheduleStreamingFlush(); }
        }
      }, () => {
        if (targetConvId) {
          addMessage(targetConvId, { id: `msg_${Date.now()}`, role: 'assistant', content: accText, timestamp: new Date(), thinking: accThink || undefined, toolCalls: accTools.length > 0 ? accTools : undefined });
        }
        streamingConvIdRef.current = null;
        cancelStreamingRaf();
        pendingTextRef.current = '';
        pendingThinkRef.current = '';
        // 只有当目标对话仍是当前对话时才清除流式展示内容，避免影响已切换到的新对话视图
        if (targetConvId === useChatStore.getState().currentConversationId) {
          setIsStreaming(false);
          setStoreStreaming(false);
          setIsTyping(false);
          setStreamingText('');
          setStreamingThinking('');
          setStreamingToolCalls([]);
          setStreamingWarnings([]);
          setStreamingCompactions([]);
        } else {
          // 已切换到其他对话：重置流式进行标志以便新对话可发送，但不触碰展示内容
          setIsStreaming(false);
          setStoreStreaming(false);
        }
        // 记录模型性能数据（用于 AUTO 路由优化）
        if (model && startTime && window.electronAPI?.agent?.recordPerformance) {
          const duration = Date.now() - startTime;
          const success = !accText.includes('错误:') && !accText.includes('❌');
          try {
            window.electronAPI.agent.recordPerformance(model, taskType || '通用任务', success, duration);
          } catch { /* ignore */ }
        }
      }, model, attchs);
    }
  }, [inputValue, isStreaming, currentConversationId, addMessage, createConversation, sendMessage, setStoreStreaming, selectedModel, defaultModel, updateConversationTitle, configuredProviders, onActivateTool, attachments, scheduleStreamingFlush, cancelStreamingRaf, planMode, fileRefs]);

  const handleStop = useCallback(() => {
    abort();
    streamingConvIdRef.current = null;
    cancelStreamingRaf();
    pendingTextRef.current = '';
    pendingThinkRef.current = '';
    setIsStreaming(false);
    setStoreStreaming(false);
    setIsTyping(false);
    setStreamingText('');
    setStreamingThinking('');
    setStreamingToolCalls([]);
    setStreamingWarnings([]);
    setStreamingCompactions([]);
  }, [abort, setStoreStreaming, cancelStreamingRaf]);

  // 组件卸载时清理 rAF，防止内存泄漏
  useEffect(() => {
    return () => {
      if (streamingRafRef.current !== null) {
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
      }
    };
  }, []);

  // ===== 提示词优化 =====
  const handleOptimize = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isOptimizing || isStreaming) return;
    const electronAPI = window.electronAPI;
    if (!electronAPI?.agent?.optimizePrompt) {
      console.warn('[optimizePrompt] electronAPI.agent.optimizePrompt 不可用');
      return;
    }
    setIsOptimizing(true);
    try {
      const result = await electronAPI.agent.optimizePrompt(text);
      if (result.success && result.optimized) {
        setInputValue(result.optimized);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 180) + 'px';
        }
        setOptimizeSuccess(true);
        setTimeout(() => setOptimizeSuccess(false), 1500);
      } else {
        // 优化失败时显示错误提示
        const errMsg = result?.error || '优化失败，请检查API配置';
        console.warn('[optimizePrompt]', errMsg);
        setOptimizeSuccess(false);
        // 用 toast 或 inline 方式提示用户
        setInputValue(prev => prev + '\n// ⚠️ 提示词优化失败: ' + errMsg);
        setTimeout(() => {
          setInputValue(prev => prev.replace(/\n\/\/ ⚠️ 提示词优化失败:.*$/, ''));
        }, 3000);
      }
    } catch (err: unknown) {
      console.error('[optimizePrompt] 异常:', err);
      const errMsg = (err instanceof Error ? err.message : '') || '网络错误';
      setInputValue(prev => prev + '\n// ⚠️ 提示词优化失败: ' + errMsg);
      setTimeout(() => {
        setInputValue(prev => prev.replace(/\n\/\/ ⚠️ 提示词优化失败:.*$/, ''));
      }, 3000);
    } finally {
      setIsOptimizing(false);
    }
  }, [inputValue, isOptimizing, isStreaming]);

  // ===== 重试 =====
  const handleRetry = useCallback((msgId: string) => {
    if (!currentConversationId || isStreaming) return;
    const conv = useChatStore.getState().currentConversation();
    if (!conv) return;
    const msgIndex = conv.messages.findIndex(m => m.id === msgId);
    if (msgIndex < 0) return;
    let userMsg = '';
    for (let i = msgIndex - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        userMsg = conv.messages[i].content;
        break;
      }
    }
    if (!userMsg) return;
    removeMessagesFrom(currentConversationId, msgId);
    handleSend(userMsg, true);
  }, [currentConversationId, isStreaming, removeMessagesFrom, handleSend]);

  // ===== 回退 =====
  const handleRollback = useCallback((msgId: string) => {
    if (!currentConversationId || isStreaming) return;
    removeMessagesFrom(currentConversationId, msgId);
  }, [currentConversationId, isStreaming, removeMessagesFrom]);

  // ===== Slash 命令执行上下文（每次渲染更新 ref，避免 handleSend deps 膨胀） =====
  slashCtxRef.current = {
    clearConversation: () => {
      if (!currentConversationId) return;
      // 清空当前对话所有消息：removeMessagesFrom(convId, firstMsgId) 移除 firstMsgId 及之后所有消息
      const conv = useChatStore.getState().conversations.find(c => c.id === currentConversationId);
      if (conv && conv.messages.length > 0) {
        removeMessagesFrom(currentConversationId, conv.messages[0].id);
      }
    },
    openConfig: () => { onOpenConfig?.(); },
    rollbackLastAssistant: () => {
      if (!currentConversationId || isStreaming) return;
      const conv = useChatStore.getState().conversations.find(c => c.id === currentConversationId);
      if (!conv) return;
      // 从末尾往前找最近一条 assistant 消息
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].role === 'assistant') {
          removeMessagesFrom(currentConversationId, conv.messages[i].id);
          return;
        }
      }
    },
    retryLastAssistant: () => {
      if (!currentConversationId || isStreaming) return;
      const conv = useChatStore.getState().conversations.find(c => c.id === currentConversationId);
      if (!conv) return;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].role === 'assistant') {
          handleRetry(conv.messages[i].id);
          return;
        }
      }
    },
    togglePlanMode: () => { setPlanMode(prev => !prev); },
    compactNow: () => {
      setPlanMode(false);
      handleSend('[系统指令] 请立即压缩当前上下文，保留关键信息摘要');
    },
    stepCount: () => {
      return messages.reduce((sum, m) => sum + (m.toolCalls?.length || 0), 0);
    },
  };

  // 执行 slash 命令（菜单点击或 Enter 时调用）
  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    const result = cmd.execute(slashCtxRef.current);
    setInputValue('');
    setSlashMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (typeof result === 'string' && currentConversationId) {
      addMessage(currentConversationId, {
        id: `msg_${Date.now()}`, role: 'assistant', content: result, timestamp: new Date(),
      });
    }
  }, [currentConversationId, addMessage]);

  // ===== @file 引用系统（对标 Cursor @mention）=====

  // 懒加载项目文件树：首次 @ 触发时调用 editor.readDir('.')，后续从 ref 缓存读取
  const ensureFileTreeLoaded = useCallback(async (): Promise<FileEntry[] | null> => {
    if (!window.electronAPI?.editor?.readDir) return null;
    if (fileTreeCacheRef.current) return fileTreeCacheRef.current;
    setFileMenu(prev => ({ ...prev, loading: true }));
    try {
      const result = await window.electronAPI.editor.readDir('.');
      if (!result?.success || !result.tree) return null;
      const flattened = flattenFileTree(result.tree);
      fileTreeCacheRef.current = flattened;
      return flattened;
    } catch {
      return null;
    } finally {
      setFileMenu(prev => ({ ...prev, loading: false }));
    }
  }, []);

  // 文件选择处理：读取文件内容 → 添加到 fileRefs → 从输入框移除 @query 文本
  const handleFileSelect = useCallback(async (file: FileEntry) => {
    // 达到上限时忽略（对标 Cursor 限制）
    if (fileRefs.length >= MAX_FILE_REFS) return;

    // 读取文件内容
    let content = '';
    if (window.electronAPI?.editor?.readFile) {
      try {
        const result = await window.electronAPI.editor.readFile(file.path);
        if (result?.success && result.content !== undefined) {
          content = result.content;
        }
      } catch { /* 读取失败时 content 保持空串 */ }
    }

    // 添加到 fileRefs（按 path 去重）
    setFileRefs(prev => prev.some(f => f.path === file.path) ? prev : [...prev, { ...file, content }]);

    // 从输入框移除 @query 文本（使用 atTriggerPosRef 记录的位置到光标位置）
    const atIdx = atTriggerPosRef.current;
    atTriggerPosRef.current = -1;
    const textarea = textareaRef.current;
    if (atIdx >= 0 && textarea) {
      const cursorPos = textarea.selectionStart ?? textarea.value.length;
      const newVal = textarea.value.slice(0, atIdx) + textarea.value.slice(cursorPos);
      setInputValue(newVal);
      // 恢复光标到 @ 原位置并重新聚焦
      requestAnimationFrame(() => {
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(atIdx, atIdx);
        }
      });
    }

    setFileMenu({ visible: false, files: [], selectedIndex: 0, loading: false });
  }, [fileRefs.length]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Slash 命令菜单键盘导航（对标 Claude Code / Devin CLI）
    if (slashMenu.visible && slashMenu.commands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashMenu(prev => ({ ...prev, selectedIndex: (prev.selectedIndex + 1) % prev.commands.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashMenu(prev => ({ ...prev, selectedIndex: (prev.selectedIndex - 1 + prev.commands.length) % prev.commands.length }));
        return;
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const cmd = slashMenu.commands[slashMenu.selectedIndex];
        if (cmd) executeSlashCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenu(prev => ({ ...prev, visible: false }));
        return;
      }
      if (e.key === 'Tab') {
        // Tab 自动补全：用当前高亮命令名填充输入框
        e.preventDefault();
        const cmd = slashMenu.commands[slashMenu.selectedIndex];
        if (cmd) setInputValue('/' + cmd.name + ' ');
        return;
      }
    }
    // @file 引用菜单键盘导航（对标 Cursor @mention autocomplete）
    if (fileMenu.visible && !fileMenu.loading && fileMenu.files.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFileMenu(prev => ({ ...prev, selectedIndex: (prev.selectedIndex + 1) % prev.files.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFileMenu(prev => ({ ...prev, selectedIndex: (prev.selectedIndex - 1 + prev.files.length) % prev.files.length }));
        return;
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const file = fileMenu.files[fileMenu.selectedIndex];
        if (file) void handleFileSelect(file);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        atTriggerPosRef.current = -1;
        setFileMenu({ visible: false, files: [], selectedIndex: 0, loading: false });
        return;
      }
      if (e.key === 'Tab') {
        // Tab 自动补全：用当前高亮文件名填充 @query（不选中，仅补全文本）
        e.preventDefault();
        const file = fileMenu.files[fileMenu.selectedIndex];
        if (file) {
          const atIdx = atTriggerPosRef.current;
          const textarea = textareaRef.current;
          if (atIdx >= 0 && textarea) {
            const cursorPos = textarea.selectionStart ?? textarea.value.length;
            const newVal = textarea.value.slice(0, atIdx + 1) + file.relativePath + textarea.value.slice(cursorPos);
            setInputValue(newVal);
            const newCursor = atIdx + 1 + file.relativePath.length;
            requestAnimationFrame(() => {
              textarea.focus();
              textarea.setSelectionRange(newCursor, newCursor);
            });
          }
        }
        return;
      }
    }
    // 上箭头召回历史消息（对标终端 / Claude Code）：
    // 仅当无菜单激活时生效。输入框为空或已在浏览模式时按 ↑ 召回更早的用户消息；
    // 浏览模式中按 ↓ 翻回，超出最新则清空退出浏览。
    if (!slashMenu.visible && !fileMenu.visible && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'ArrowUp') {
        const userMsgs = messages.filter(m => m.role === 'user');
        if (userMsgs.length === 0) return;
        // 仅当输入为空或已在浏览模式时触发（避免干扰多行编辑中的光标移动）
        if (inputValue.trim() === '' || historyIndexRef.current !== -1) {
          e.preventDefault();
          if (historyIndexRef.current === -1) {
            historyIndexRef.current = userMsgs.length - 1;
          } else if (historyIndexRef.current > 0) {
            historyIndexRef.current--;
          }
          const recalled = userMsgs[historyIndexRef.current];
          if (recalled) {
            setInputValue(recalled.content);
            requestAnimationFrame(() => {
              const ta = textareaRef.current;
              if (ta) { ta.focus(); const len = ta.value.length; ta.setSelectionRange(len, len); }
            });
          }
          return;
        }
      }
      if (e.key === 'ArrowDown' && historyIndexRef.current !== -1) {
        e.preventDefault();
        const userMsgs = messages.filter(m => m.role === 'user');
        if (historyIndexRef.current < userMsgs.length - 1) {
          historyIndexRef.current++;
          const recalled = userMsgs[historyIndexRef.current];
          if (recalled) setInputValue(recalled.content);
        } else {
          // 超出最新 → 清空退出浏览
          historyIndexRef.current = -1;
          setInputValue('');
        }
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (ta) { ta.focus(); const len = ta.value.length; ta.setSelectionRange(len, len); }
        });
        return;
      }
    }
    // Ctrl+Enter 或 Cmd+Enter 发送消息（支持多行输入）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSend(); }
  }, [handleSend, slashMenu, executeSlashCommand, fileMenu, handleFileSelect, inputValue, messages]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputValue(val);
    // 用户手动输入 → 退出历史浏览模式（上箭头召回的 setInputValue 不会触发 onChange）
    historyIndexRef.current = -1;
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    // Slash 命令菜单触发：以 / 开头且单行（无换行）
    if (val.startsWith('/') && !val.includes('\n')) {
      const query = val.slice(1);
      const filtered = filterSlashCommands(query);
      setSlashMenu({ visible: filtered.length > 0, commands: filtered, selectedIndex: 0 });
      // slash 激活时关闭 file 菜单（互斥）
      if (fileMenu.visible) setFileMenu({ visible: false, files: [], selectedIndex: 0, loading: false });
    } else {
      if (slashMenu.visible) setSlashMenu(prev => ({ ...prev, visible: false }));
      // @file 引用触发检测（对标 Cursor @mention）：
      // 在光标前查找 @ 字符，要求 @ 位于词边界（行首或前面是空白）
      const cursorPos = textarea.selectionStart ?? val.length;
      const beforeCursor = val.slice(0, cursorPos);
      const atMatch = beforeCursor.match(/(?:^|[\s\n])@([^\s\n]*)$/);
      if (atMatch && window.electronAPI?.editor?.readDir) {
        const query = atMatch[1];
        const atIdx = beforeCursor.lastIndexOf('@');
        atTriggerPosRef.current = atIdx;
        // 文件树已缓存时同步过滤，否则异步加载后过滤
        const cached = fileTreeCacheRef.current;
        if (cached) {
          const filtered = filterFiles(cached, query);
          setFileMenu({ visible: true, files: filtered, selectedIndex: 0, loading: false });
        } else {
          // 首次触发：显示 loading，异步加载后过滤
          setFileMenu({ visible: true, files: [], selectedIndex: 0, loading: true });
          void ensureFileTreeLoaded().then(tree => {
            if (!tree) {
              setFileMenu({ visible: false, files: [], selectedIndex: 0, loading: false });
              return;
            }
            // 仅在 @ 触发仍有效时更新（用户可能已关闭菜单）
            if (atTriggerPosRef.current === atIdx) {
              const filtered = filterFiles(tree, query);
              setFileMenu({ visible: true, files: filtered, selectedIndex: 0, loading: false });
            }
          });
        }
      } else {
        atTriggerPosRef.current = -1;
        if (fileMenu.visible) setFileMenu({ visible: false, files: [], selectedIndex: 0, loading: false });
      }
    }
  }, [slashMenu.visible, fileMenu.visible, ensureFileTreeLoaded]);

  // ===== 拖拽文件 + 粘贴图片支持（对标 Cursor / VS Code 拖拽体验）=====

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

    for (const file of files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      // Electron 的 File 对象额外携带 path 属性（绝对路径）
      const filePath = (file as File & { path?: string }).path || '';

      if (isImage) {
        // 图片 → 读取为 base64 添加为附件
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] || '';
          setAttachments(prev => [...prev, {
            name: file.name,
            path: filePath,
            isImage: true,
            base64,
            mimeType: file.type || `image/${ext}`,
            ext,
          }]);
        };
        reader.readAsDataURL(file);
      } else if (window.electronAPI?.editor?.readFile && filePath) {
        // 文本文件（有 path）→ 读取内容添加为 @file 引用
        if (fileRefs.length >= MAX_FILE_REFS) break;
        void window.electronAPI.editor.readFile(filePath).then(result => {
          if (result?.success && result.content !== undefined) {
            setFileRefs(prev => {
              if (prev.length >= MAX_FILE_REFS || prev.some(f => f.path === filePath)) return prev;
              return [...prev, {
                name: file.name,
                relativePath: file.name,
                path: filePath,
                ext,
                content: result.content || '',
              }];
            });
          }
        });
      }
    }
  }, [fileRefs.length]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setDragOver(true);
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 仅当离开容器（relatedTarget 为 null 或不在容器内）时才取消高亮
    setDragOver(false);
  }, []);

  // 粘贴图片：检测剪贴板中的图片项，转为 base64 附件
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] || '';
          const ext = item.type.split('/')[1]?.split(';')[0] || 'png';
          setAttachments(prev => [...prev, {
            name: `pasted_image_${Date.now()}.${ext}`,
            path: '',
            isImage: true,
            base64,
            mimeType: item.type,
            ext,
          }]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const canSend = (inputValue.trim().length > 0 || attachments.length > 0) && !isStreaming;

  const inputShadowStyle = inputFocused
    ? '0 0 0 2px rgba(6,182,212,.08), 0 0 20px rgba(6,182,212,.06)'
    : '0 2px 8px rgba(0,0,0,0.1)';

  // ===== 模型选择器（渲染函数，非组件） =====
  const renderModelPicker = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
      <button
        onClick={() => setShowModelPicker(!showModelPicker)}
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          padding: '4px 10px', borderRadius: 6,
          background: 'rgba(6,182,212,.06)', border: '1px solid rgba(6,182,212,.12)',
          cursor: 'pointer', color: '#67e8f9', fontSize: 11, fontWeight: 500,
          fontFamily: 'inherit', transition: 'all .15s', lineHeight: 1,
          height: 26,
        }}
      >
        <Zap style={{ width: 12, height: 12 }} />
        {AVAILABLE_MODELS.find(m => m.id === selectedModel)?.label || selectedModel || '选择模型'}
        <ChevronDown style={{ width: 10, height: 10, transform: showModelPicker ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {showModelPicker && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, zIndex: 50,
          minWidth: 280, maxHeight: 440, overflowY: 'auto',
          background: 'rgba(15,20,35,.97)', borderRadius: 10,
          border: '1px solid rgba(255,255,255,.1)', backdropFilter: 'blur(20px)',
          boxShadow: '0 -8px 32px rgba(0,0,0,.5)', padding: 5, marginBottom: 4,
        }}>
          {/* AUTO 选项 */}
          {(() => {
            const autoModel = AVAILABLE_MODELS.find(m => m.id === 'auto');
            if (!autoModel) return null;
            const isSelected = selectedModel === 'auto';
            return (
              <div style={{ marginBottom: 4, paddingBottom: 4, borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                <button onClick={() => { setSelectedModel('auto'); setShowModelPicker(false); }}
                  style={{
                    width: '100%', display: 'flex', flexDirection: 'column', gap: 3,
                    padding: '8px 10px', borderRadius: 6, border: 'none',
                    background: isSelected ? 'rgba(139,92,246,.12)' : 'rgba(139,92,246,.04)',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                    color: isSelected ? '#a78bfa' : '#94a3b8', fontSize: 11,
                    transition: 'all .1s',
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(139,92,246,.08)'; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(139,92,246,.04)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Zap style={{ width: 12, height: 12, color: '#a78bfa' }} />
                    <span style={{ flex: 1, fontWeight: 600 }}>{autoModel.label}</span>
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(139,92,246,.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.2)' }}>推荐</span>
                  </div>
                  <div style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {AUTO_ROUTING_RULES.map(rule => (
                      <span key={rule.type} style={{ fontSize: 9, color: '#64748b' }}>
                        {rule.icon} {rule.type} → {rule.models}
                      </span>
                    ))}
                  </div>
                </button>
              </div>
            );
          })()}
          {Object.entries(PROVIDER_GROUPS).map(([group, groupLabel]) => {
            const groupModels = filteredModels.filter(m => m.provider === group);
            if (groupModels.length === 0) return null;
            return (
              <div key={group} style={{ marginBottom: 3 }}>
                <div style={{ fontSize: 9, color: '#475569', padding: '4px 10px', fontWeight: 600, textTransform: 'uppercase' }}>{groupLabel}</div>
                {groupModels.map(m => (
                  <button key={m.id} onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 10px', borderRadius: 6, border: 'none',
                      background: selectedModel === m.id ? 'rgba(6,182,212,.1)' : 'transparent',
                      cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                      color: selectedModel === m.id ? '#67e8f9' : '#94a3b8', fontSize: 11,
                      transition: 'all .1s',
                    }}
                    onMouseEnter={(e) => { if (selectedModel !== m.id) e.currentTarget.style.background = 'rgba(255,255,255,.04)'; }}
                    onMouseLeave={(e) => { if (selectedModel !== m.id) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {selectedModel === m.id && <CheckCircle2 style={{ width: 11, height: 11, color: '#06b6d4' }} />}
                    <span style={{ flex: 1 }}>{m.label}</span>
                    {m.description && <span style={{ fontSize: 9, color: '#475569' }}>{m.description}</span>}
                  </button>
                ))}
              </div>
            );
          })}
          {/* PAI 供应商模型列表（含性能数据，支持手动选择） */}
          {availablePaiModels.length > 0 && (
            <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,.06)' }}>
              <div style={{ fontSize: 9, color: '#475569', padding: '4px 10px', fontWeight: 600, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                <BarChart3 style={{ width: 10, height: 10 }} />
                所有 PAI 模型（按性能排序）
              </div>
              {availablePaiModels.slice(0, 15).map((m) => {
                const isSelected = selectedModel === m.model;
                const perfLabel = m.hasPerformanceData
                  ? `${(m.successRate * 100).toFixed(0)}% · ${m.avgDuration > 0 ? (m.avgDuration / 1000).toFixed(1) + 's' : '-'} · ${m.totalCalls}次`
                  : '无数据';
                const perfColor = m.perfScore >= 0.7 ? '#10b981' : m.perfScore >= 0.5 ? '#f59e0b' : '#ef4444';
                return (
                  <button key={`${m.provider}-${m.model}`} onClick={() => { setSelectedModel(m.model); setShowModelPicker(false); }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 10px', borderRadius: 6, border: 'none',
                      background: isSelected ? 'rgba(6,182,212,.1)' : 'transparent',
                      cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                      color: isSelected ? '#67e8f9' : '#94a3b8', fontSize: 11,
                      transition: 'all .1s',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,.04)'; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {isSelected && <CheckCircle2 style={{ width: 11, height: 11, color: '#06b6d4' }} />}
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>{m.model}</span>
                        <span style={{ fontSize: 8, padding: '1px 4px', borderRadius: 3, background: 'rgba(255,255,255,.04)', color: '#64748b' }}>{m.provider}</span>
                      </span>
                      <span style={{ fontSize: 8, color: perfColor, display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 4, height: 4, borderRadius: '50%', background: perfColor }} />
                        {perfLabel}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {/* 添加智能体入口（未配置的供应商） */}
          {unconfiguredProviders.length > 0 && (
            <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,.06)' }}>
              <button
                onClick={() => { setShowModelPicker(false); onOpenConfig?.(); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 10px', borderRadius: 6, border: '1px dashed rgba(139,92,246,.25)',
                  background: 'rgba(139,92,246,.04)', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'inherit', color: '#a78bfa', fontSize: 11, fontWeight: 500,
                  transition: 'all .1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(139,92,246,.1)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,.4)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(139,92,246,.04)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,.25)'; }}
              >
                <Plus style={{ width: 12, height: 12 }} />
                <span style={{ flex: 1 }}>添加智能体</span>
                <span style={{ fontSize: 9, color: '#475569' }}>{unconfiguredProviders.length} 个可用</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ===== 输入区域（渲染函数，非组件） =====
  const renderInputArea = () => {
    // 工具栏按钮统一样式
    const toolbarBtnStyle: React.CSSProperties = {
      width: 26, height: 26, borderRadius: 6, border: 'none',
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'transparent', color: '#475569',
      transition: 'all .15s', flexShrink: 0, padding: 0,
    };

    return (
      <div style={{ maxWidth: 768, margin: '0 auto' }}>
        {/* 智能路由栏 — 输入框上方，向上扩展 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 4px 6px', flexWrap: 'nowrap',
        }}>
          {renderModelPicker()}
          {/* 运行状态指示 */}
          {isStreaming && (
            <span style={{ fontSize: 10, color: '#475569', display: 'flex', alignItems: 'center', gap: 3, marginLeft: 'auto' }}>
              <Loader2 style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} />
              {isTyping ? '等待响应...' : streamingToolCalls.some(t => t.status === 'running') ? `执行工具: ${streamingToolCalls.find(t => t.status === 'running')?.name || ''}` : streamingThinking ? '思考中...' : streamingText ? '生成回复...' : '运行中'}
            </span>
          )}
          {/* 工具调用计数 */}
          {streamingToolCalls.length > 0 && isStreaming && (
            <span style={{ fontSize: 10, color: '#8b5cf6', display: 'flex', alignItems: 'center', gap: 3 }}>
              <Wrench style={{ width: 10, height: 10 }} />
              {streamingToolCalls.length} 工具调用
            </span>
          )}
        </div>
        {/* 输入框容器 — Trae Solo 风格：textarea + 发送按钮（支持拖拽文件） */}
        <div
          style={{ position: 'relative' }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {/* Slash 命令自动完成菜单（对标 Claude Code / Devin CLI） */}
          <SlashCommandMenu
            commands={slashMenu.commands}
            selectedIndex={slashMenu.selectedIndex}
            onSelect={executeSlashCommand}
            onHover={(i) => setSlashMenu(prev => ({ ...prev, selectedIndex: i }))}
            visible={slashMenu.visible}
          />
          {/* @file 引用自动完成菜单（对标 Cursor @mention） */}
          <FileReferenceMenu
            files={fileMenu.files}
            selectedIndex={fileMenu.selectedIndex}
            onSelect={(f) => void handleFileSelect(f)}
            onHover={(i) => setFileMenu(prev => ({ ...prev, selectedIndex: i }))}
            visible={fileMenu.visible}
            loading={fileMenu.loading}
          />
          <div style={{
            background: isDragOver ? 'rgba(6,182,212,.04)' : 'rgba(15,20,35,.6)',
            borderRadius: 14,
            border: `1px solid ${isDragOver ? 'rgba(6,182,212,.5)' : inputFocused ? 'rgba(6,182,212,.3)' : 'rgba(255,255,255,.08)'}`,
            boxShadow: isDragOver ? '0 0 0 2px rgba(6,182,212,.12), 0 0 24px rgba(6,182,212,.1)' : inputShadowStyle,
            backdropFilter: 'blur(12px)',
            transition: 'border-color .2s, box-shadow .2s',
            overflow: 'hidden',
          }}>
            {/* 计划模式徽章（/plan 触发，one-shot：发送后自动关闭）— 对标 Claude Code Plan Mode */}
            {planMode && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 12px',
                background: 'rgba(139,92,246,.08)',
                borderBottom: '1px solid rgba(139,92,246,.15)',
                fontSize: 10, color: '#a78bfa',
              }}>
                <Sparkles style={{ width: 10, height: 10 }} />
                <span>计划模式已开启 — 下一条消息将要求先制定执行计划</span>
                <button
                  onClick={() => setPlanMode(false)}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 0, display: 'flex' }}
                  title="退出计划模式"
                >
                  <X style={{ width: 10, height: 10 }} />
                </button>
              </div>
            )}
            {/* 附件预览 */}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0', flexWrap: 'wrap' }}>
              {attachments.map((att, idx) => (
                <div key={idx} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 8,
                  background: att.isImage ? 'rgba(6,182,212,.08)' : 'rgba(139,92,246,.08)',
                  border: `1px solid ${att.isImage ? 'rgba(6,182,212,.2)' : 'rgba(139,92,246,.2)'}`,
                  fontSize: 11, color: '#e2e8f0', maxWidth: 180,
                }}>
                  {att.isImage ? <Image style={{ width: 10, height: 10, color: '#06b6d4', flexShrink: 0 }} /> : <Paperclip style={{ width: 10, height: 10, color: '#8b5cf6', flexShrink: 0 }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                  <button onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))} style={{
                    background: 'none', border: 'none', cursor: 'pointer', color: '#64748b',
                    padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0,
                  }}>
                    <X style={{ width: 10, height: 10 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* @file 引用 chip 预览（对标 Cursor @file chips） */}
          {fileRefs.length > 0 && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0', flexWrap: 'wrap' }}>
              {fileRefs.map((ref, idx) => (
                <div key={ref.path} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 8,
                  background: 'rgba(6,182,212,.08)',
                  border: '1px solid rgba(6,182,212,.2)',
                  fontSize: 11, color: '#e2e8f0', maxWidth: 220,
                }}>
                  <AtSign style={{ width: 10, height: 10, color: '#06b6d4', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ref.relativePath}>{ref.relativePath}</span>
                  <button onClick={() => setFileRefs(prev => prev.filter((_, i) => i !== idx))} style={{
                    background: 'none', border: 'none', cursor: 'pointer', color: '#64748b',
                    padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0,
                  }}>
                    <X style={{ width: 10, height: 10 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 输入区域：textarea + 发送按钮 */}
          <div style={{ display: 'flex', alignItems: 'flex-end', padding: '8px 10px 8px 14px', gap: 6 }}>
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="给段先生发送消息... (输入 @ 引用文件，输入 / 使用命令)"
              disabled={isStreaming}
              rows={1}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              style={{
                flex: 1,
                resize: 'none',
                minHeight: 24,
                maxHeight: 160,
                lineHeight: '20px',
                padding: '4px 0',
                border: 'none',
                backgroundColor: 'transparent',
                color: '#e0f2fe',
                fontSize: 14,
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                overflowY: 'auto',
                width: '100%',
              }}
            />
            {/* 发送/停止按钮 */}
            {isStreaming ? (
              <button
                onClick={handleStop}
                style={{
                  width: 30, height: 30, borderRadius: '50%', border: 'none',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(239,68,68,.8)',
                  color: '#fff',
                  transition: 'all .2s',
                  boxShadow: '0 0 8px rgba(239,68,68,.3)',
                  flexShrink: 0,
                }}
              >
                <Square style={{ width: 12, height: 12 }} />
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!canSend}
                style={{
                  width: 30, height: 30, borderRadius: '50%', border: 'none',
                  cursor: canSend ? 'pointer' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: canSend ? 'linear-gradient(135deg, #06b6d4, #8b5cf6)' : 'rgba(255,255,255,.06)',
                  color: canSend ? '#fff' : '#475569',
                  transition: 'all .2s',
                  boxShadow: canSend ? '0 0 8px rgba(6,182,212,.3)' : 'none',
                  flexShrink: 0,
                }}
              >
                <ArrowUp style={{ width: 15, height: 15 }} />
              </button>
            )}
          </div>
        </div>
        </div>
        {/* 底部工具栏 — 在输入框外部，弹窗不会被裁剪 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 4px 0', flexWrap: 'nowrap' }}>
          {/* 文件上传按钮 */}
          {!isStreaming && (
            <button
              onClick={async () => {
                try {
                  const api = window.electronAPI;
                  if (api?.dialog?.openFile) {
                    const result = await api.dialog.openFile({ title: '选择图片或文件' });
                    if (result.success && result.files.length > 0) {
                      setAttachments(prev => [...prev, ...result.files.map((f: { name: string; path: string; isImage: boolean; base64?: string; mimeType?: string; ext?: string }) => ({
                        name: f.name, path: f.path, isImage: f.isImage,
                        base64: f.base64 || '', mimeType: f.mimeType || '', ext: f.ext || '',
                      }))]);
                    }
                  } else {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.multiple = true;
                    input.accept = 'image/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.js,.ts,.py,.java,.c,.cpp,.go,.rs';
                    input.onchange = async (e: Event) => {
                      const files = Array.from((e.target as HTMLInputElement).files || []) as File[];
                      for (const file of files) {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                          const base64 = (ev.target?.result as string)?.split(',')[1] || '';
                          const isImage = file.type.startsWith('image/');
                          setAttachments(prev => [...prev, {
                            name: file.name, path: file.name, isImage,
                            base64, mimeType: file.type, ext: file.name.split('.').pop() || '',
                          }]);
                        };
                        reader.readAsDataURL(file);
                      }
                    };
                    input.click();
                  }
                } catch (err) {
                  console.error('文件选择失败:', err);
                }
              }}
              title="上传附件"
              style={toolbarBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.12)'; e.currentTarget.style.color = '#06b6d4'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#475569'; }}
            >
              <Paperclip style={{ width: 13, height: 13 }} />
            </button>
          )}
          {/* 语音输入 */}
          {!isStreaming && (
            <VoiceInput
              onTranscript={(text) => setInputValue(prev => prev ? prev + text : text)}
              disabled={isStreaming}
            />
          )}
          {/* 贾维斯语音对话 */}
          <JarvisMode
            lastAssistantMessage={(() => {
              // 从后往前查找最后一条助手消息
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant' && messages[i].content) {
                  return messages[i].content;
                }
              }
              return '';
            })()}
            onSend={(text) => handleSend(text)}
            isStreaming={isStreaming}
          />
          {/* 优化提示词 */}
          {!isStreaming && (
            <button
              onClick={handleOptimize}
              disabled={!inputValue.trim() || isOptimizing}
              title="优化提示词"
              className={optimizeSuccess ? 'optimize-success-flash' : undefined}
              style={{
                ...toolbarBtnStyle,
                color: optimizeSuccess ? '#10b981' : (inputValue.trim() ? '#f59e0b' : '#475569'),
                background: optimizeSuccess ? 'rgba(16,185,129,.12)' : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (inputValue.trim() && !isOptimizing && !optimizeSuccess) {
                  e.currentTarget.style.background = 'rgba(245,158,11,.12)';
                  e.currentTarget.style.color = '#f59e0b';
                }
              }}
              onMouseLeave={(e) => {
                if (!optimizeSuccess) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = inputValue.trim() ? '#f59e0b' : '#475569';
                }
              }}
            >
              {optimizeSuccess ? <Check style={{ width: 13, height: 13 }} /> : isOptimizing ? <Loader2 style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} /> : <Wand2 style={{ width: 13, height: 13 }} />}
            </button>
          )}
          {/* Token/上下文使用量指示器（对标 Claude Code） */}
          <div
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
              padding: '0 6px', cursor: tokenPct >= 50 ? 'pointer' : 'default',
            }}
            onClick={() => { if (tokenPct >= 50) slashCtxRef.current.compactNow(); }}
            title={tokenPct >= 50 ? '上下文使用率较高，点击压缩' : `上下文使用量 ${tokenPct.toFixed(1)}%`}
          >
            <div style={{ width: 60, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
              <div style={{
                width: `${tokenPct}%`, height: '100%', borderRadius: 2,
                background: tokenPct < 50 ? '#10b981' : tokenPct < 80 ? '#f59e0b' : '#ef4444',
                transition: 'width .3s, background .3s',
              }} />
            </div>
            <span style={{
              fontSize: 10,
              fontFamily: "'Cascadia Code', 'Consolas', monospace",
              color: tokenPct < 50 ? '#475569' : tokenPct < 80 ? '#f59e0b' : '#ef4444',
              whiteSpace: 'nowrap',
            }}>
              {(tokenEstimate / 1000).toFixed(1)}K
            </span>
          </div>
        </div>
    </div>
    );
  };

  // ===== 从历史消息提取 Agent 状态（用于非流式时显示） =====
  const historyAgentStatus = React.useMemo(() => {
    if (isViewingStreaming || messages.length === 0) return null;
    // 找到最后一条 assistant 消息
    const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistantMsg) return null;
    return {
      thinking: lastAssistantMsg.thinking || '',
      toolCalls: (lastAssistantMsg.toolCalls || []).map(tc => ({
        ...tc,
        // 改进的错误检测：与流式逻辑保持一致（P0 修复：运算符优先级，添加括号）
        status: (tc.result?.startsWith('❌') || tc.result?.includes('工具执行失败') || tc.result?.includes('工具执行异常') || (tc.result?.includes('错误') && tc.result?.includes('error')) ? 'error' : 'success') as 'success' | 'error' | 'running',
      })),
    };
  }, [messages, isViewingStreaming]);

  // ===== 侧边栏（渲染函数，非组件） =====
  const renderSidebar = () => {
    const hasRunningTools = streamingToolCalls.some(t => t.status === 'running');
    const hasHistoryStatus = !!historyAgentStatus && (historyAgentStatus.thinking || historyAgentStatus.toolCalls.length > 0);
    return (
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0,
        width: sidebarExpanded ? 210 : 0,
        overflow: 'hidden',
        transition: 'width 0.3s ease',
        borderLeft: sidebarExpanded ? '1px solid rgba(6,182,212,.12)' : 'none',
        background: sidebarExpanded ? 'rgba(10,14,26,.92)' : 'transparent',
        backdropFilter: sidebarExpanded ? 'blur(16px)' : 'none',
        boxShadow: sidebarExpanded ? '-4px 0 20px rgba(0,0,0,.25)' : 'none',
        zIndex: 20,
      }}
        className={sidebarExpanded && hasRunningTools ? 'sidebar-border-glow' : undefined}
      >
        <div style={{ width: 210, height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* 头部 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 10px 6px', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Radio style={{ width: 11, height: 11, color: isViewingStreaming ? '#06b6d4' : hasHistoryStatus ? '#10b981' : '#475569', animation: isViewingStreaming ? 'spin 2s linear infinite' : 'none' }} />
              <span style={{ fontSize: 11, color: '#67e8f9', fontWeight: 600 }}>Agent 状态</span>
              {!isViewingStreaming && hasHistoryStatus && (
                <span style={{ fontSize: 9, color: '#475569' }}>历史</span>
              )}
            </div>
            <button
              onClick={() => { setSidebarExpanded(false); setSidebarUserManual(true); }}
              style={{
                width: 20, height: 20, borderRadius: 5, border: 'none',
                background: 'rgba(255,255,255,.04)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#64748b', transition: 'all .15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.08)'; e.currentTarget.style.color = '#94a3b8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.04)'; e.currentTarget.style.color = '#64748b'; }}
            >
              <X style={{ width: 10, height: 10 }} />
            </button>
          </div>

          {/* 内容 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }} className="sidebar-slide-in">
            {isViewingStreaming ? (
              <>
                {/* 状态指示 */}
                {isTyping && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8, padding: '4px 6px', background: 'rgba(6,182,212,.04)', borderRadius: 6 }}>
                    <Loader2 style={{ width: 10, height: 10, color: '#06b6d4', animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: 10, color: '#64748b' }}>等待响应...</span>
                  </div>
                )}

                {/* 系统告警横幅（warning 事件）— 模型 404/402/限速/超时/网络错误等，amber 色 */}
                {streamingWarnings.length > 0 && (
                  <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {streamingWarnings.slice(0, 3).map(w => (
                      <div
                        key={w.id}
                        title={w.content}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '4px 8px', borderRadius: 4,
                          background: 'rgba(245,158,11,.08)',
                          borderLeft: '3px solid #f59e0b',
                          fontSize: 10, color: '#fbbf24', lineHeight: 1.4,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        <AlertCircle style={{ width: 10, height: 10, color: '#f59e0b', flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.content}</span>
                      </div>
                    ))}
                    {streamingWarnings.length > 3 && (
                      <span style={{ fontSize: 9, color: '#64748b', paddingLeft: 14 }}>
                        +{streamingWarnings.length - 3} 更多告警
                      </span>
                    )}
                  </div>
                )}

                {/* 上下文压缩卡片（compact 事件）— 对标 Claude Code compaction display cards */}
                {streamingCompactions.length > 0 && (
                  <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {streamingCompactions.map(c => (
                      <div
                        key={c.id}
                        style={{
                          padding: '4px 8px', borderRadius: 4,
                          background: 'rgba(6,182,212,.06)',
                          border: '1px solid rgba(6,182,212,.12)',
                          fontSize: 10, color: '#67e8f9', lineHeight: 1.4,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ flexShrink: 0 }}>📦</span>
                          <span
                            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                            onClick={() => setStreamingCompactions(prev => prev.map(x => x.id === c.id ? { ...x, expanded: !x.expanded } : x))}
                            title="点击展开/收起"
                          >
                            {c.content}
                          </span>
                        </div>
                        {c.expanded && c.content.length > 50 && (
                          <div style={{ marginTop: 4, paddingLeft: 18, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#94a3b8', fontSize: 9 }}>
                            {c.content}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 思考过程 */}
                {streamingThinking && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <Sparkles style={{ width: 10, height: 10, color: '#a78bfa' }} />
                      <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 500 }}>思考过程</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 80, overflow: 'auto', paddingLeft: 14, borderLeft: '2px solid rgba(167,139,250,.12)' }}>
                      {streamingThinking.length > 300 ? streamingThinking.substring(streamingThinking.length - 300) : streamingThinking}
                    </div>
                  </div>
                )}

                {/* 工具调用 */}
                {streamingToolCalls.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <Wrench style={{ width: 10, height: 10, color: '#06b6d4' }} />
                      <span style={{ fontSize: 10, color: '#67e8f9', fontWeight: 500 }}>工具调用</span>
                      <span style={{ fontSize: 9, color: '#475569' }}>{streamingToolCalls.length} 个</span>
                    </div>
                    {streamingToolCalls.map((tc, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', paddingLeft: 14, background: tc.status === 'error' ? 'rgba(239,68,68,.04)' : 'transparent', borderRadius: 3 }}>
                        <ToolStatusIcon status={tc.status} />
                        <span style={{ fontSize: 10, color: tc.status === 'error' ? '#f87171' : '#67e8f9', fontWeight: 500 }}>{tc.name}</span>
                        {tc.status === 'running' && (
                          <span style={{ fontSize: 9, color: '#f59e0b' }}>执行中...</span>
                        )}
                        {tc.status !== 'running' && tc.duration != null && (
                          <span style={{ fontSize: 9, color: tc.duration > 10000 ? '#f59e0b' : '#475569' }}>{tc.duration >= 1000 ? `${(tc.duration / 1000).toFixed(1)}s` : `${tc.duration}ms`}</span>
                        )}
                        {tc.status === 'error' && (
                          <span style={{ fontSize: 9, color: '#ef4444' }}>失败</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 进度条 */}
                {streamingToolCalls.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ height: 3, borderRadius: 2, background: 'rgba(6,182,212,.08)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        background: 'linear-gradient(90deg, #06b6d4, #8b5cf6)',
                        width: `${(streamingToolCalls.filter(t => t.status !== 'running').length / streamingToolCalls.length) * 100}%`,
                        transition: 'width .3s',
                      }} />
                    </div>
                    <div style={{ fontSize: 9, color: '#475569', marginTop: 2, textAlign: 'right' }}>
                      {streamingToolCalls.filter(t => t.status !== 'running').length}/{streamingToolCalls.length}
                    </div>
                  </div>
                )}
              </>
            ) : hasHistoryStatus && historyAgentStatus ? (
              /* 历史对话 Agent 状态 */
              <>
                {/* 历史思考过程 */}
                {historyAgentStatus.thinking && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <Sparkles style={{ width: 10, height: 10, color: '#a78bfa' }} />
                      <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 500 }}>思考过程</span>
                      <span style={{ fontSize: 9, color: '#475569' }}>已完成</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 80, overflow: 'auto', paddingLeft: 14, borderLeft: '2px solid rgba(167,139,250,.12)' }}>
                      {historyAgentStatus.thinking.length > 300 ? historyAgentStatus.thinking.substring(0, 300) + '...' : historyAgentStatus.thinking}
                    </div>
                  </div>
                )}

                {/* 历史工具调用 */}
                {Array.isArray(historyAgentStatus.toolCalls) && historyAgentStatus.toolCalls.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <Wrench style={{ width: 10, height: 10, color: '#06b6d4' }} />
                      <span style={{ fontSize: 10, color: '#67e8f9', fontWeight: 500 }}>工具调用</span>
                      <span style={{ fontSize: 9, color: '#475569' }}>{historyAgentStatus.toolCalls.length} 个</span>
                    </div>
                    {historyAgentStatus.toolCalls.map((tc, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', paddingLeft: 14, background: tc.status === 'error' ? 'rgba(239,68,68,.04)' : 'transparent', borderRadius: 3 }}>
                        <ToolStatusIcon status={tc.status} />
                        <span style={{ fontSize: 10, color: tc.status === 'error' ? '#f87171' : '#67e8f9', fontWeight: 500 }}>{tc.name}</span>
                        {tc.duration != null && (
                          <span style={{ fontSize: 9, color: tc.duration > 10000 ? '#f59e0b' : '#475569' }}>{tc.duration >= 1000 ? `${(tc.duration / 1000).toFixed(1)}s` : `${tc.duration}ms`}</span>
                        )}
                        {tc.status === 'error' && (
                          <span style={{ fontSize: 9, color: '#ef4444' }}>失败</span>
                        )}
                      </div>
                    ))}
                    {/* 历史进度条（全部完成） */}
                    <div style={{ marginTop: 4 }}>
                      <div style={{ height: 3, borderRadius: 2, background: 'rgba(6,182,212,.08)', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 2,
                          background: 'linear-gradient(90deg, #10b981, #06b6d4)',
                          width: '100%',
                        }} />
                      </div>
                      <div style={{ fontSize: 9, color: '#475569', marginTop: 2, textAlign: 'right' }}>
                        {historyAgentStatus.toolCalls.length}/{historyAgentStatus.toolCalls.length}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* 空闲状态 */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 0', gap: 8 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: 'rgba(6,182,212,.06)', border: '1px solid rgba(6,182,212,.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Radio style={{ width: 12, height: 12, color: '#475569' }} />
                </div>
                <span style={{ fontSize: 10, color: '#475569' }}>Agent 空闲</span>
              </div>
            )}
          </div>

          {/* 底部操作栏 */}
          {(isViewingStreaming || hasHistoryStatus) && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid rgba(255,255,255,.04)' }}>
              <button
                onClick={() => setShowDetailLog(true)}
                style={{
                  width: '100%', padding: '5px 8px', borderRadius: 6,
                  background: 'rgba(6,182,212,.06)', border: '1px solid rgba(6,182,212,.12)',
                  cursor: 'pointer', color: '#67e8f9', fontSize: 10, fontWeight: 500,
                  fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  transition: 'all .15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.1)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.06)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.12)'; }}
              >
                <Wrench style={{ width: 10, height: 10 }} />
                查看详细日志
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ===== 欢迎页 =====
  if (messages.length === 0 && !isStreaming) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
          <div className="anim-fade-in" style={{ maxWidth: 640, width: '100%', textAlign: 'center' }}>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'center' }}>
              <div style={{
                width: 64, height: 64, borderRadius: 18, overflow: 'hidden',
                boxShadow: '0 0 30px rgba(6,182,212,.25), 0 0 60px rgba(139,92,246,.15)',
                border: '2px solid rgba(6,182,212,.2)',
                animation: 'float 4s ease-in-out infinite',
              }}>
                <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            </div>
            <h1 className="gradient-text" style={{
              fontSize: 26, fontWeight: 700, margin: '0 0 6px',
            }}>
              你好，我是段先生
            </h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 32px', fontWeight: 400 }}>
              自主进化智能体 · Mr.Duan v19.0
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, maxWidth: 460, margin: '0 auto' }}>
              {quickActions.map((action, idx) => (
                <button
                  key={action.id}
                  onClick={() => setInputValue(action.prompt)}
                  className="anim-slide-up"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '12px 14px', borderRadius: 12,
                    background: 'rgba(6,182,212,.04)', border: '1px solid rgba(6,182,212,.1)',
                    cursor: 'pointer', transition: 'background .15s, border-color .15s, box-shadow .15s',
                    color: 'inherit', textAlign: 'left', fontFamily: 'inherit',
                    animationDelay: `${idx * 0.05}s`,
                    boxShadow: '0 0 0 rgba(6,182,212,0)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.25)'; e.currentTarget.style.boxShadow = '0 0 16px rgba(6,182,212,.08)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.04)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.1)'; e.currentTarget.style.boxShadow = '0 0 0 rgba(6,182,212,0)'; }}
                >
                  <div style={{
                    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                    background: `${action.color}12`, border: `1px solid ${action.color}25`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <action.icon style={{ width: 14, height: 14, color: action.color }} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#cbd5e1' }}>{action.label}</span>
                </button>
              ))}
            </div>

            {/* 工具快捷入口 */}
            {onOpenBrowser && (
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center', gap: 8 }}>
                <button
                  onClick={() => onOpenBrowser('https://www.google.com')}
                  className="anim-slide-up"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '6px 12px', borderRadius: 8,
                    background: 'rgba(16,185,129,.06)', border: '1px solid rgba(16,185,129,.15)',
                    cursor: 'pointer', fontFamily: 'inherit', color: '#10b981',
                    fontSize: 11, fontWeight: 500,
                    transition: 'all .15s',
                    animationDelay: '0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(16,185,129,.12)'; e.currentTarget.style.borderColor = 'rgba(16,185,129,.3)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(16,185,129,.06)'; e.currentTarget.style.borderColor = 'rgba(16,185,129,.15)'; }}
                >
                  <Globe style={{ width: 12, height: 12 }} />
                  打开浏览器
                </button>
              </div>
            )}

            {/* 快捷键提示 */}
            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center', gap: 14, fontSize: 10, color: '#475569' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <kbd style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', fontSize: 9 }}>Ctrl+B</kbd>
                侧边栏
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <kbd style={{ padding: '1px 4px', borderRadius: 3, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', fontSize: 9 }}>Ctrl+1/2/3</kbd>
                工具面板
              </span>
            </div>
          </div>
        </div>
        <div style={{ flexShrink: 0, padding: '0 24px 16px' }}>
          {renderInputArea()}
          <div style={{ textAlign: 'center', marginTop: 6, fontSize: 11, color: '#475569' }}>
            按 <kbd style={{ padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', fontSize: 10, fontFamily: 'inherit' }}>Ctrl+Enter</kbd> 发送 · 段先生可能会犯错，请核实重要信息。
          </div>
        </div>
      </div>
    );
  }

  // ===== 对话页 =====
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* 消息区域 */}
        <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '20px 0' }}>
          <div style={{ maxWidth: 768, margin: '0 auto', padding: '0 24px' }}>
            {/* 远程通道消息（飞书/企业微信等） */}
            {showRemotePanel && remoteMessages.length > 0 && (
              <div style={{
                marginBottom: 20, padding: '12px 16px',
                background: 'rgba(6, 182, 212, 0.08)',
                border: '1px solid rgba(6, 182, 212, 0.2)',
                borderRadius: 12,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Radio style={{ width: 14, height: 14, color: '#06b6d4' }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#06b6d4' }}>
                      远程通道消息 ({remoteMessages[0]?.channel || '远程'})
                    </span>
                  </div>
                  <button
                    onClick={() => setShowRemotePanel(false)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
                  >
                    <X style={{ width: 14, height: 14, color: '#64748b' }} />
                  </button>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {remoteMessages.map((msg, idx) => (
                    <div key={idx} style={{
                      marginBottom: 8, padding: '8px 12px',
                      background: msg.role === 'user' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(30, 41, 59, 0.4)',
                      borderRadius: 8, fontSize: 13, lineHeight: 1.5,
                      color: msg.role === 'user' ? '#bfdbfe' : '#e2e8f0',
                      overflowWrap: 'break-word', wordBreak: 'break-word',
                    }}>
                      <span style={{ fontSize: 10, color: '#64748b', marginRight: 6 }}>
                        {msg.role === 'user' ? '👤 用户' : '🤖 段先生'}
                      </span>
                      {msg.content}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <SubAgentStatusCard />
            {messages.map((msg) => (
              <MessageItem
                key={msg.id}
                msg={msg}
                expandedThinking={expandedThinking}
                setExpandedThinking={setExpandedThinking}
                expandedTools={expandedTools}
                setExpandedTools={setExpandedTools}
                expandedToolResults={expandedToolResults}
                setExpandedToolResults={setExpandedToolResults}
                copiedId={copiedId}
                handleCopy={handleCopy}
                handleRetry={handleRetry}
                handleRollback={handleRollback}
              />
            ))}

            {/* 流式输出区域 */}
            {isStreaming && streamingConvIdRef.current === currentConversationId && (
              <div className="message-appear-agent" style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', overflow: 'hidden',
                    boxShadow: '0 0 10px rgba(6,182,212,.35), 0 0 20px rgba(6,182,212,.15)',
                    border: '1.5px solid rgba(6,182,212,.25)',
                  }}>
                    <img src="./duanxiansheng.png" alt="段先生" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isTyping && <div className="typing-indicator" style={{ marginBottom: 6 }}><span /><span /><span /></div>}
                  {streamingThinking && (
                    <ThinkingTrace thinking={streamingThinking} msgId="__streaming__" isStreaming={true} hasTools={streamingToolCalls.length > 0} expandedThinking={expandedThinking} setExpandedThinking={setExpandedThinking} />
                  )}
                  {streamingToolCalls.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      {streamingToolCalls.map((tc, i) => (
                        <ToolCallCard key={i} tc={tc} index={i} msgId="__streaming_tool__" total={streamingToolCalls.length} expandedToolResults={expandedToolResults} setExpandedToolResults={setExpandedToolResults} />
                      ))}
                    </div>
                  )}
                  {streamingText && (
                    <div className="message-bubble-agent">
                      <div className="markdown-body" style={{ fontSize: 13, lineHeight: 1.6, color: '#e2e8f0' }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{streamingText}</ReactMarkdown>
                        <span style={{ color: '#06b6d4', animation: 'cursor-blink 1s step-end infinite' }}>▌</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* 回到底部按钮（用户向上滚动时浮现） */}
        {showScrollBtn && (
          <button
            onClick={() => {
              chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
              isAtBottomRef.current = true;
              setShowScrollBtn(false);
            }}
            title="回到底部"
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(15,20,35,.9)',
              border: '1px solid rgba(6,182,212,.3)',
              color: '#06b6d4',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,.3)',
              zIndex: 10,
              backdropFilter: 'blur(8px)',
              transition: 'all .2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.15)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.5)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(15,20,35,.9)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.3)'; }}
          >
            <ChevronDown style={{ width: 18, height: 18 }} />
          </button>
        )}

        {/* 侧边栏切换按钮 + 折叠状态指示器 */}
        <div style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 26, zIndex: 10,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          paddingTop: 10, gap: 6,
          borderLeft: '1px solid rgba(255,255,255,.04)',
          background: 'rgba(10,14,26,.6)',
          backdropFilter: 'blur(8px)',
        }}>
          <button
            onClick={() => { setSidebarExpanded(!sidebarExpanded); setSidebarUserManual(true); }}
            title={sidebarExpanded ? '收起面板' : 'Agent 面板'}
            style={{
              width: 20, height: 20, borderRadius: 5,
              background: sidebarExpanded ? 'rgba(6,182,212,.1)' : 'rgba(255,255,255,.03)',
              border: `1px solid ${sidebarExpanded ? 'rgba(6,182,212,.2)' : 'rgba(255,255,255,.06)'}`,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: sidebarExpanded ? '#06b6d4' : '#475569',
              transition: 'all .2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.12)'; e.currentTarget.style.color = '#06b6d4'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = sidebarExpanded ? 'rgba(6,182,212,.1)' : 'rgba(255,255,255,.03)'; e.currentTarget.style.color = sidebarExpanded ? '#06b6d4' : '#475569'; }}
          >
            <Radio style={{ width: 10, height: 10 }} />
          </button>
          {/* 折叠时显示状态指示器 */}
          {!sidebarExpanded && (
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isViewingStreaming ? '#06b6d4' : (historyAgentStatus && (historyAgentStatus.thinking || historyAgentStatus.toolCalls.length > 0)) ? '#10b981' : '#475569',
              boxShadow: isViewingStreaming ? '0 0 6px rgba(6,182,212,.5)' : 'none',
              animation: isViewingStreaming ? 'status-pulse-cyan 2s infinite' : 'none',
            }} />
          )}
        </div>

        {/* 右侧侧边栏 */}
        {renderSidebar()}
      </div>

      {/* 底部输入区 */}
      <div style={{ flexShrink: 0, padding: '0 24px 16px' }}>
        {renderInputArea()}
        <div style={{ textAlign: 'center', marginTop: 6, fontSize: 11, color: '#475569' }}>
          按 <kbd style={{ padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', fontSize: 10, fontFamily: 'inherit' }}>Ctrl+Enter</kbd> 发送 · 段先生可能会犯错，请核实重要信息。
        </div>
      </div>

      {/* 详细日志弹窗 */}
      {showDetailLog && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setShowDetailLog(false)}>
          <div style={{ width: '100%', maxWidth: 600, maxHeight: '70vh', background: 'rgba(15,20,35,.97)', borderRadius: 14, border: '1px solid rgba(255,255,255,.1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>Agent 执行日志</h3>
              <button onClick={() => setShowDetailLog(false)} style={{ padding: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {/* 思考过程 */}
              {(isViewingStreaming ? streamingThinking : historyAgentStatus?.thinking) && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Sparkles style={{ width: 12, height: 12, color: '#a78bfa' }} />
                    <span style={{ fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>思考过程</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '10px 12px', background: 'rgba(167,139,250,.04)', borderRadius: 8, border: '1px solid rgba(167,139,250,.1)' }}>
                    {isViewingStreaming ? streamingThinking : historyAgentStatus?.thinking}
                  </div>
                </div>
              )}

              {/* 工具调用详情 */}
              {(isViewingStreaming ? streamingToolCalls : historyAgentStatus?.toolCalls || []).map((tc, i) => (
                <div key={i} style={{ marginBottom: 10, padding: '10px 12px', background: tc.status === 'error' ? 'rgba(239,68,68,.04)' : 'rgba(6,182,212,.03)', borderRadius: 8, border: `1px solid ${tc.status === 'error' ? 'rgba(239,68,68,.15)' : 'rgba(6,182,212,.1)'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <ToolStatusIcon status={tc.status} />
                    <span style={{ fontSize: 12, color: tc.status === 'error' ? '#f87171' : '#67e8f9', fontWeight: 600 }}>{tc.name}</span>
                    {tc.duration != null && (
                      <span style={{ fontSize: 10, color: tc.duration > 10000 ? '#f59e0b' : '#475569', marginLeft: 'auto' }}>
                        耗时: {tc.duration >= 1000 ? `${(tc.duration / 1000).toFixed(1)}s` : `${tc.duration}ms`}
                      </span>
                    )}
                    {tc.status === 'error' && <span style={{ fontSize: 10, color: '#ef4444', marginLeft: 'auto' }}>失败</span>}
                  </div>
                  {!!tc.args && (
                    <div style={{ fontSize: 10, color: '#94a3b8', padding: '6px 8px', background: 'rgba(100,116,139,.06)', borderRadius: 4, marginBottom: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 100, overflow: 'auto' }}>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>参数: </span>
                      {typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2)}
                    </div>
                  )}
                  {tc.result && (
                    <div style={{ fontSize: 10, color: tc.status === 'error' ? '#f87171' : '#34d399', padding: '6px 8px', background: tc.status === 'error' ? 'rgba(239,68,68,.06)' : 'rgba(16,185,129,.06)', borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>结果: </span>
                      {tc.result.length > 500 ? tc.result.substring(0, 500) + '...' : tc.result}
                    </div>
                  )}
                </div>
              ))}

              {((isViewingStreaming ? streamingToolCalls : historyAgentStatus?.toolCalls || []).length === 0 && !(isViewingStreaming ? streamingThinking : historyAgentStatus?.thinking)) && (
                <div style={{ textAlign: 'center', padding: 20, color: '#475569', fontSize: 12 }}>暂无执行日志</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
