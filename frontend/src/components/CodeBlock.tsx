/**
 * 代码块增强组件（对标 Claude Code / Cursor / ChatGPT 代码块体验）
 *
 * 功能：
 * 1. 顶部工具栏：语言标签（左）+ 复制按钮（右）
 * 2. 超长代码块（>20 行）默认折叠，点击展开/收起
 * 3. 复制成功反馈（✓ 已复制 → 2s 后恢复）
 *
 * 由 ChatArea 的 ReactMarkdown components.pre 渲染器调用，
 * 从 <pre><code class="language-xxx"> 中提取语言和内容。
 */
import React, { useState, useCallback } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

interface CodeBlockProps {
  /** 语言标识（从 className 的 language-xxx 提取），空串表示无语言标注 */
  language: string;
  /** 代码内容 */
  content: string;
}

/** 超过此行数则默认折叠 */
const FOLD_THRESHOLD = 20;
/** 折叠时展示的行数 */
const FOLD_PREVIEW_LINES = 18;

// 模块级样式常量，避免每次渲染重建对象
const WRAPPER: React.CSSProperties = {
  margin: '8px 0',
  borderRadius: 8,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,.08)',
  background: 'rgba(0,0,0,.35)',
};

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  background: 'rgba(255,255,255,.03)',
  borderBottom: '1px solid rgba(255,255,255,.06)',
  fontSize: 11,
  fontFamily: 'inherit',
};

const LANG_LABEL: React.CSSProperties = {
  color: '#64748b',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const COPY_BTN: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: '2px 8px',
  borderRadius: 5,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: '#64748b',
  fontSize: 10,
  fontFamily: 'inherit',
  transition: 'all .15s',
};

const CODE_PRE: React.CSSProperties = {
  margin: 0,
  padding: '10px 14px',
  overflowX: 'auto',
  fontSize: 12.5,
  lineHeight: 1.5,
  fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
  color: '#c8d3e0',
};

const EXPAND_BTN: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  width: '100%',
  padding: '5px',
  border: 'none',
  borderTop: '1px solid rgba(255,255,255,.06)',
  background: 'rgba(255,255,255,.02)',
  cursor: 'pointer',
  color: '#64748b',
  fontSize: 10,
  fontFamily: 'inherit',
  transition: 'background .15s',
};

const FADE_GRADIENT: React.CSSProperties = {
  position: 'absolute',
  bottom: 36,
  left: 0,
  right: 0,
  height: 40,
  background: 'linear-gradient(to bottom, transparent, rgba(0,0,0,.35))',
  pointerEvents: 'none',
};

export const CodeBlock = React.memo(function CodeBlock({ language, content }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lineCount = content.split('\n').length;
  const shouldFold = lineCount > FOLD_THRESHOLD;
  const isFolded = shouldFold && !expanded;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard 不可用时静默 */ }
  }, [content]);

  // 折叠时截取前 N 行
  const displayContent = isFolded
    ? content.split('\n').slice(0, FOLD_PREVIEW_LINES).join('\n')
    : content;

  return (
    <div style={WRAPPER}>
      {/* 顶部工具栏：语言标签 + 复制按钮 */}
      <div style={HEADER}>
        {language ? <span style={LANG_LABEL}>{language}</span> : <span style={{ ...LANG_LABEL, opacity: 0.5 }}>text</span>}
        <button
          onClick={handleCopy}
          style={{
            ...COPY_BTN,
            color: copied ? '#10b981' : '#64748b',
          }}
          onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = '#94a3b8'; }}
          onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = '#64748b'; }}
          title="复制代码"
        >
          {copied ? <Check style={{ width: 11, height: 11 }} /> : <Copy style={{ width: 11, height: 11 }} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* 代码内容 */}
      <div style={{ position: 'relative' }}>
        <pre style={CODE_PRE}>
          <code>{displayContent}</code>
        </pre>
        {isFolded && <div style={FADE_GRADIENT} />}
      </div>
      {/* 展开/收起按钮（仅超长代码块显示） */}
      {shouldFold && (
        <button
          onClick={() => setExpanded(prev => !prev)}
          style={EXPAND_BTN}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.05)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.02)'; }}
        >
          {expanded
            ? <><ChevronDown style={{ width: 11, height: 11 }} /> 收起</>
            : <><ChevronRight style={{ width: 11, height: 11 }} /> 展开全部（共 {lineCount} 行）</>}
        </button>
      )}
    </div>
  );
});
