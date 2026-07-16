import { useState, useRef, useCallback, useEffect } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';

// ===== 类型 =====
interface OutputLine {
  id: string;
  text: string;
  type: 'input' | 'output' | 'error' | 'system';
}

// ===== Electron 环境检测 =====
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ===== ANSI 颜色码渲染 =====
const ANSI_COLORS: Record<number, string> = {
  30: '#475569', 31: '#ef4444', 32: '#22c55e', 33: '#eab308',
  34: '#3b82f6', 35: '#a855f7', 36: '#06b6d4', 37: '#e2e8f0',
  90: '#64748b', 91: '#f87171', 92: '#4ade80', 93: '#facc15',
  94: '#60a5fa', 95: '#c084fc', 96: '#22d3ee', 97: '#f1f5f9',
};

function renderAnsiText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // eslint-disable-next-line no-control-regex -- ANSI 转义序列正则，控制字符是必须的
  const regex = /\x1b\[(\d+)m/g;
  let lastIndex = 0;
  let currentColor: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index);
      parts.push(
        currentColor
          ? <span key={parts.length} style={{ color: currentColor }}>{segment}</span>
          : segment
      );
    }
    const code = parseInt(match[1]);
    if (code === 0) {
      currentColor = null;
    } else if (ANSI_COLORS[code]) {
      currentColor = ANSI_COLORS[code];
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    const segment = text.slice(lastIndex);
    parts.push(
      currentColor
        ? <span key={parts.length} style={{ color: currentColor }}>{segment}</span>
        : segment
    );
  }

  return parts.length > 0 ? parts : [text];
}

// ===== 组件 =====
export function TerminalPanel() {
  const [lines, setLines] = useState<OutputLine[]>([
    { id: 'init', text: '段先生终端 v19.0 — 输入命令开始', type: 'system' },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isRunning, setIsRunning] = useState(false);
  const [cwd, setCwd] = useState<string>('');
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 标记当前命令是否已通过流式事件显示输出（避免与最终结果重复）
  const streamedRef = useRef(false);

  // 自动滚动到底部
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const addLine = useCallback((text: string, type: OutputLine['type']) => {
    setLines(prev => [...prev, { id: `l_${Date.now()}_${Math.random()}`, text, type }]);
  }, []);

  // mount：订阅流式输出 + 终端注入（terminal_operate 工具）+ 获取真实提示符
  useEffect(() => {
    if (!isElectron) return;
    const electronAPI = window.electronAPI;
    // 获取 cwd 并显示真实提示符（4.3 修复：不再静默吞错，失败时给出可见提示）
    electronAPI?.terminal?.hello?.().then((res) => {
      if (res?.cwd) {
        setCwd(res.cwd);
        addLine(res.prompt || `${res.cwd}>`, 'system');
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      addLine(`⚠ 终端初始化失败: ${msg || '未知错误'}。请检查后端服务是否运行。`, 'error');
    });
    // 订阅流式输出（修复：之前从不订阅，导致 main.js 已发出的 terminal:output 被丢弃）
    const offOutput = electronAPI?.terminal?.onOutput?.((data) => {
      streamedRef.current = true;
      addLine(data.data, data.type === 'stderr' ? 'error' : 'output');
    });
    // 订阅 terminal_operate 工具注入（命令/输出/清屏）
    const offInject = electronAPI?.terminal?.onInject?.((data) => {
      if (data?.clear) { setLines([]); return; }
      if (data?.command) { addLine(`$ ${data.command}`, 'input'); }
      if (data?.output) { addLine(data.output, data?.type === 'stderr' ? 'error' : 'output'); }
    });
    return () => { offOutput?.(); offInject?.(); };
  }, [addLine]);

  // 点击面板聚焦输入框
  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // 执行命令
  const executeCommand = useCallback(async (cmd: string) => {
    addLine(`$ ${cmd}`, 'input');
    setIsRunning(true);

    try {
      if (isElectron) {
        // Electron 环境：通过 IPC 执行（带 cwd 连续性 + 流式输出已订阅）
        const electronAPI = window.electronAPI;
        if (electronAPI?.terminal?.execute) {
          streamedRef.current = false;
          const result = await electronAPI.terminal.execute(cmd, cwd || undefined);
          // 维护 cwd 连续性（cd 命令后更新）
          if (result?.cwd) setCwd(result.cwd);
          // 流式已显示则跳过最终结果，避免重复；仅兜底显示未流式内容
          if (!streamedRef.current) {
            if (result.stdout) addLine(result.stdout, 'output');
            if (result.stderr) addLine(result.stderr, 'error');
            if (!result.stdout && !result.stderr && !result.error) addLine('(命令执行完成，无输出)', 'system');
          }
          if (result.error) addLine(`错误: ${result.error}`, 'error');
        } else {
          addLine('错误: electronAPI.terminal.execute 不可用', 'error');
        }
      } else {
        // 非 Electron：通过后端 API 执行
        try {
          const response = await fetch('/api/terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd }),
          });
          if (response.ok) {
            const data = await response.json();
            if (data.stdout) addLine(data.stdout, 'output');
            if (data.stderr) addLine(data.stderr, 'error');
            if (!data.stdout && !data.stderr) addLine('(命令执行完成，无输出)', 'system');
          } else {
            addLine(`错误: HTTP ${response.status}`, 'error');
          }
        } catch {
          addLine('错误: 无法连接到终端服务', 'error');
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLine(`错误: ${msg || '执行失败'}`, 'error');
    } finally {
      setIsRunning(false);
    }
  }, [addLine, cwd]);

  const handleSubmit = useCallback(() => {
    const cmd = inputValue.trim();
    if (!cmd || isRunning) return;

    setHistory(prev => [...prev, cmd]);
    setHistoryIndex(-1);
    setInputValue('');
    executeCommand(cmd);
  }, [inputValue, isRunning, executeCommand]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length > 0) {
        const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInputValue(history[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= history.length) {
          setHistoryIndex(-1);
          setInputValue('');
        } else {
          setHistoryIndex(newIndex);
          setInputValue(history[newIndex]);
        }
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (isRunning) {
        addLine('^C', 'system');
        setIsRunning(false);
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  }, [handleSubmit, history, historyIndex, isRunning, addLine]);

  const getLineColor = (type: OutputLine['type']) => {
    switch (type) {
      case 'input': return '#06b6d4';
      case 'output': return '#e2e8f0';
      case 'error': return '#ef4444';
      case 'system': return '#64748b';
    }
  };

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0b0d06', cursor: 'text' }}
      onClick={focusInput}
    >
      {/* 标题栏 - 玻璃态设计 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px',
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(245,158,11,.1)',
        flexShrink: 0,
      }}>
        <TerminalIcon style={{ width: 14, height: 14, color: '#f59e0b' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>终端</span>
        <span style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 8,
          background: isRunning ? 'rgba(245,158,11,.12)' : 'rgba(16,185,129,.1)',
          color: isRunning ? '#f59e0b' : '#10b981',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: isRunning ? '#f59e0b' : '#10b981',
            boxShadow: isRunning ? '0 0 4px rgba(245,158,11,.6)' : '0 0 4px rgba(16,185,129,.6)',
            animation: isRunning ? 'status-pulse 2s infinite' : 'none',
          }} />
          {isRunning ? '运行中' : '就绪'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#475569' }}>
          {isElectron ? 'Electron' : 'Web API'}
        </span>
      </div>

      {/* 输出区域 */}
      <div
        ref={outputRef}
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 16px',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: 13, lineHeight: 1.6,
        }}
      >
        {lines.map((line) => (
          <div key={line.id} style={{ color: getLineColor(line.type), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {renderAnsiText(line.text)}
          </div>
        ))}
      </div>

      {/* 输入区域 - 玻璃态 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '10px 16px',
        borderTop: '1px solid rgba(245,158,11,.1)',
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        flexShrink: 0,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      }}>
        <span style={{ color: '#f59e0b', fontSize: 13, marginRight: 8, userSelect: 'none', textShadow: '0 0 6px rgba(245,158,11,.4)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cwd || undefined}>{cwd ? `${cwd.split(/[\\/]/).pop()}>` : '$'}</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
          placeholder={isRunning ? '命令执行中...' : '输入命令... (↑↓ 浏览历史 · Ctrl+L 清屏)'}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: '#e2e8f0', fontSize: 13,
            fontFamily: 'inherit', caretColor: '#f59e0b',
          }}
          autoFocus
        />
      </div>
    </div>
  );
}
