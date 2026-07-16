import { useState, useRef, useCallback, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { File, Folder, FolderOpen, ChevronRight, ChevronDown, Save, FilePlus, FolderPlus, RefreshCw, AlertTriangle, RotateCw } from 'lucide-react';

// ===== 类型 =====
interface FileNode {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  path: string;
}

// ===== Electron 环境检测 =====
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ===== 示例文件树 =====
const DEMO_FILE_TREE: FileNode[] = [
  {
    name: 'src', type: 'folder', path: 'src',
    children: [
      {
        name: 'components', type: 'folder', path: 'src/components',
        children: [
          { name: 'App.tsx', type: 'file', path: 'src/components/App.tsx' },
          { name: 'ChatArea.tsx', type: 'file', path: 'src/components/ChatArea.tsx' },
          { name: 'Sidebar.tsx', type: 'file', path: 'src/components/Sidebar.tsx' },
        ],
      },
      { name: 'main.tsx', type: 'file', path: 'src/main.tsx' },
      { name: 'index.css', type: 'file', path: 'src/index.css' },
    ],
  },
  { name: 'package.json', type: 'file', path: 'package.json' },
  { name: 'tsconfig.json', type: 'file', path: 'tsconfig.json' },
  { name: 'README.md', type: 'file', path: 'README.md' },
];

const DEMO_FILE_CONTENTS: Record<string, string> = {
  'src/components/App.tsx': `import { useState } from 'react';\n\nexport function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <div>\n      <h1>Hello World</h1>\n      <button onClick={() => setCount(c => c + 1)}>\n        Count: {count}\n      </button>\n    </div>\n  );\n}`,
  'src/main.tsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './components/App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);`,
  'package.json': `{\n  "name": "my-app",\n  "version": "1.0.0",\n  "dependencies": {\n    "react": "^19.1.0"\n  }\n}`,
};

// ===== 语法高亮规则 =====
interface HighlightRule {
  regex: RegExp;
  color: string;
}

const HIGHLIGHT_RULES: HighlightRule[] = [
  // 关键字
  { regex: /\b(import|export|from|default|const|let|var|function|return|if|else|for|while|class|extends|new|this|typeof|instanceof|async|await|try|catch|throw|interface|type|enum)\b/g, color: '#c084fc' },
  // 字符串
  { regex: /(["'`])(?:(?!\1|\\).|\\.)*\1/g, color: '#4ade80' },
  // 注释
  { regex: /\/\/.*$/gm, color: '#64748b' },
  { regex: /\/\*[\s\S]*?\*\//g, color: '#64748b' },
  // 数字
  { regex: /\b\d+\.?\d*\b/g, color: '#f59e0b' },
  // JSX 标签
  { regex: /<\/?[A-Z][a-zA-Z]*/g, color: '#06b6d4' },
  // HTML 标签
  { regex: /<\/?[a-z][a-zA-Z]*/g, color: '#06b6d4' },
  // 函数调用
  { regex: /\b[a-zA-Z_]\w*(?=\s*\()/g, color: '#22d3ee' },
  // 布尔值 / null / undefined
  { regex: /\b(true|false|null|undefined)\b/g, color: '#f59e0b' },
];

// ===== 文件大小限制 =====
const MAX_DISPLAY_SIZE = 100 * 1024; // 100KB
const BINARY_CHECK_SIZE = 8192; // 检测前 8KB

/** 检测是否为二进制文件（包含 null bytes） */
function isBinaryContent(content: string): boolean {
  const checkLen = Math.min(content.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLen; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

function highlightCode(code: string): React.ReactNode[] {
  try {
    // 简单实现：逐行处理，按规则替换
    const lines = code.split('\n');
    // 限制行数防止大文件卡顿
    const maxLines = 5000;
    const truncated = lines.length > maxLines;
    const displayLines = truncated ? lines.slice(0, maxLines) : lines;

    const result = displayLines.map((line, lineIdx) => {
      const elements: React.ReactNode[] = [];
      let remaining = line;
      let keyIdx = 0;

      while (remaining.length > 0) {
        let earliestMatch: { index: number; length: number; color: string; text: string } | null = null;

        for (const rule of HIGHLIGHT_RULES) {
          try {
            rule.regex.lastIndex = 0;
            const match = rule.regex.exec(remaining);
            if (match && match.index >= 0 && (earliestMatch === null || match.index < earliestMatch.index)) {
              earliestMatch = { index: match.index, length: match[0].length, color: rule.color, text: match[0] };
            }
          } catch {
            // 正则执行失败，跳过此规则
            continue;
          }
        }

        if (earliestMatch && earliestMatch.index >= 0) {
          // 前面的普通文本
          if (earliestMatch.index > 0) {
            elements.push(<span key={`${lineIdx}-${keyIdx++}`}>{remaining.slice(0, earliestMatch.index)}</span>);
          }
          // 高亮文本
          elements.push(
            <span key={`${lineIdx}-${keyIdx++}`} style={{ color: earliestMatch.color }}>{earliestMatch.text}</span>
          );
          remaining = remaining.slice(earliestMatch.index + earliestMatch.length);
        } else {
          elements.push(<span key={`${lineIdx}-${keyIdx++}`}>{remaining}</span>);
          break;
        }
      }

      return <div key={lineIdx}>{elements}</div>;
    });

    if (truncated) {
      result.push(
        <div key="truncated" style={{ color: '#f59e0b', padding: '8px 0', fontStyle: 'italic' }}>
          ... 文件过大，仅显示前 {maxLines} 行 ...
        </div>
      );
    }

    return result;
  } catch (err) {
    // 高亮失败时返回纯文本
    console.error('[EditorPanel] Highlight failed, falling back to plain text:', err);
    return code.split('\n').map((line, i) => <div key={i}>{line}</div>);
  }
}

// ===== 文件树节点组件 =====
function FileTreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
  expandedFolders,
  toggleFolder,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
}) {
  const isFolder = node.type === 'folder';
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <div
        onClick={() => isFolder ? toggleFolder(node.path) : onSelect(node)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 8px', paddingLeft: 8 + depth * 16,
          cursor: 'pointer', fontSize: 13,
          background: isSelected ? 'rgba(139,92,246,.1)' : 'transparent',
          borderLeft: isSelected ? '2px solid #8b5cf6' : '2px solid transparent',
          color: isSelected ? '#e2e8f0' : '#94a3b8',
          transition: 'background .1s, color .1s',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
        onMouseEnter={(e) => { if (!isSelected) { e.currentTarget.style.background = 'rgba(139,92,246,.05)'; e.currentTarget.style.color = '#cbd5e1'; } }}
        onMouseLeave={(e) => { if (!isSelected) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
      >
        {isFolder ? (
          isExpanded
            ? <ChevronDown style={{ width: 12, height: 12, flexShrink: 0, color: '#64748b' }} />
            : <ChevronRight style={{ width: 12, height: 12, flexShrink: 0, color: '#64748b' }} />
        ) : <span style={{ width: 12, flexShrink: 0 }} />}
        {isFolder ? (
          isExpanded
            ? <FolderOpen style={{ width: 14, height: 14, flexShrink: 0, color: '#f59e0b' }} />
            : <Folder style={{ width: 14, height: 14, flexShrink: 0, color: '#f59e0b' }} />
        ) : (
          <File style={{ width: 14, height: 14, flexShrink: 0, color: '#64748b' }} />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
      </div>
      {isFolder && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ===== 主组件 =====
interface EditorPanelProps {
  initialFile?: { path: string; content: string } | null;
}

export function EditorPanel({ initialFile }: EditorPanelProps) {
  const [fileTree, setFileTree] = useState<FileNode[]>(DEMO_FILE_TREE);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>(DEMO_FILE_CONTENTS);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['src', 'src/components']));
  const [modified, setModified] = useState<Set<string>>(new Set());
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [isBinary, setIsBinary] = useState(false);
  const [isOversized, setIsOversized] = useState(false);
  // Agent 流式写入状态（让用户看到代码编写进程）
  const [isWriting, setIsWriting] = useState(false);
  const [writingProgress, setWritingProgress] = useState(0); // 0..1
  const [writingTotal, setWritingTotal] = useState(0);
  const writeBufferRef = useRef<{ path: string; chunk: string; lineNo: number; totalLines: number }[]>([]);
  const writingPathRef = useRef<string>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  const currentContent = selectedFile ? (fileContents[selectedFile] ?? '') : '';

  // 当 Agent 通过 file_write 打开文件时，自动选中并加载内容
  useEffect(() => {
    if (initialFile?.path) {
      setSelectedFile(initialFile.path);
      setFileContents(prev => ({ ...prev, [initialFile.path]: initialFile.content }));
      setModified(prev => new Set(prev).add(initialFile.path));
    }
  }, [initialFile?.path, initialFile?.content]);

  // 直接监听 editor:open-file 事件（更可靠地实时显示 agent 写入的代码）
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI;
    if (!api?.tool?.onEditorOpenFile) return;
    const unsub = api.tool.onEditorOpenFile((data: { path: string; content: string }) => {
      if (data?.path) {
        setSelectedFile(data.path);
        setFileContents(prev => ({ ...prev, [data.path]: data.content }));
        setModified(prev => new Set(prev).add(data.path));
      }
    });
    return () => { unsub?.(); };
  }, []);

  // 流式写入：订阅 editor:write-start/chunk/done，打字机动画 + 进度条
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI;
    if (!api?.tool) return;
    const offStart = api.tool.onEditorWriteStart?.((data: { path: string; totalLines: number }) => {
      if (!data?.path) return;
      writingPathRef.current = data.path;
      writeBufferRef.current = [];
      setIsWriting(true);
      setWritingTotal(data.totalLines || 0);
      setWritingProgress(0);
      setSelectedFile(data.path);
      setFileContents(prev => ({ ...prev, [data.path]: '' }));
      setModified(prev => new Set(prev).add(data.path));
    });
    const offChunk = api.tool.onEditorWriteChunk?.((data: { path: string; chunk: string; lineNo: number; totalLines: number }) => {
      if (!data?.path) return;
      writeBufferRef.current.push(data);
    });
    const offDone = api.tool.onEditorWriteDone?.((data: { path: string; content: string }) => {
      if (!data?.path) return;
      writeBufferRef.current = [];
      setFileContents(prev => ({ ...prev, [data.path]: data.content }));
      setIsWriting(false);
      setWritingProgress(1);
      writingPathRef.current = '';
    });
    return () => { offStart?.(); offChunk?.(); offDone?.(); };
  }, []);

  // 打字机定时器：每 ~30ms 从缓冲取一块追加显示，营造逐行写入的视觉效果
  useEffect(() => {
    if (!isElectron) return;
    const timer = setInterval(() => {
      if (writeBufferRef.current.length === 0) return;
      const item = writeBufferRef.current.shift();
      if (!item) return;
      const p = writingPathRef.current;
      if (!p) return;
      setFileContents(prev => ({ ...prev, [p]: (prev[p] || '') + item.chunk }));
      setWritingTotal(item.totalLines);
      setWritingProgress(item.totalLines > 0 ? item.lineNo / item.totalLines : 0);
    }, 30);
    return () => clearInterval(timer);
  }, []);

  // P0 工具融合：订阅 editor:goto 事件，Agent 调 editor_operate goto 时跳转到指定行
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI;
    if (!api?.editor?.onGoto) return;
    const unsub = api.editor.onGoto((data: { filePath?: string; line?: number; column?: number }) => {
      const targetLine = Number(data?.line) || 1;
      // 如果指定了 path 且与当前文件不同，先切换（内容已由 open 注入，这里只跳转）
      const ta = textareaRef.current;
      if (!ta) return;
      const content = ta.value || '';
      // 计算目标行的字符偏移
      const lines = content.split('\n');
      let offset = 0;
      for (let i = 0; i < Math.min(targetLine - 1, lines.length); i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      try {
        ta.focus();
        ta.setSelectionRange(offset, offset);
        // 滚动到目标行（估算行高 18px）
        ta.scrollTop = Math.max(0, (targetLine - 3) * 18);
        setCursorLine(targetLine);
        setCursorCol(1);
      } catch {
        // 选区设置失败时忽略
      }
    });
    return () => { unsub?.(); };
  }, []);

  // 同步滚动
  useEffect(() => {
    const ta = textareaRef.current;
    const pre = highlightRef.current;
    if (!ta || !pre) return;

    const syncScroll = () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener('scroll', syncScroll);
    return () => ta.removeEventListener('scroll', syncScroll);
  }, [selectedFile]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((node: FileNode) => {
    if (node.type === 'file') {
      try {
        setSelectedFile(node.path);
        setIsBinary(false);
        setIsOversized(false);
        // 如果没有内容，尝试加载
        if (!fileContents[node.path]) {
          if (isElectron) {
            const electronAPI = window.electronAPI;
            if (electronAPI?.editor?.readFile) {
              electronAPI.editor.readFile(node.path).then((result) => {
                try {
                  // 验证 IPC 返回结构，防止异常数据导致渲染崩溃
                  if (!result || typeof result !== 'object') {
                    setFileContents(prev => ({ ...prev, [node.path]: '' }));
                    return;
                  }
                  const content = result?.success ? String(result.content ?? '') : '';
                  // 二进制文件检测
                  if (isBinaryContent(content)) {
                    setIsBinary(true);
                    setFileContents(prev => ({ ...prev, [node.path]: '' }));
                    return;
                  }
                  // 大文件截断
                  if (content.length > MAX_DISPLAY_SIZE) {
                    setIsOversized(true);
                    setFileContents(prev => ({ ...prev, [node.path]: content.slice(0, MAX_DISPLAY_SIZE) }));
                  } else {
                    setFileContents(prev => ({ ...prev, [node.path]: content }));
                  }
                } catch (err) {
                  console.error('[EditorPanel] 处理文件内容失败:', err);
                  setFileContents(prev => ({ ...prev, [node.path]: '' }));
                }
              }).catch((err: unknown) => {
                console.error('[EditorPanel] 读取文件失败:', err);
                setFileContents(prev => ({ ...prev, [node.path]: '' }));
              });
            } else {
              setFileContents(prev => ({ ...prev, [node.path]: '' }));
            }
          } else {
            // 非 Electron：通过 API 加载
            fetch(`/api/file?path=${encodeURIComponent(node.path)}`)
              .then(r => r.ok ? r.json() : { content: '' })
              .then(data => {
                try {
                  const content = data?.success ? String(data.content ?? '') : (data?.content ? String(data.content) : '');
                  // 二进制文件检测
                  if (isBinaryContent(content)) {
                    setIsBinary(true);
                    setFileContents(prev => ({ ...prev, [node.path]: '' }));
                    return;
                  }
                  // 大文件截断
                  if (content.length > MAX_DISPLAY_SIZE) {
                    setIsOversized(true);
                    setFileContents(prev => ({ ...prev, [node.path]: content.slice(0, MAX_DISPLAY_SIZE) }));
                  } else {
                    setFileContents(prev => ({ ...prev, [node.path]: content }));
                  }
                } catch (err) {
                  console.error('[EditorPanel] 处理 API 文件内容失败:', err);
                  setFileContents(prev => ({ ...prev, [node.path]: '' }));
                }
              })
              .catch((err) => { console.error('[EditorPanel] fetch 文件失败:', err); setFileContents(prev => ({ ...prev, [node.path]: '' })); });
          }
        } else {
          // 已有缓存内容，也需要检测二进制
          const content = fileContents[node.path];
          if (isBinaryContent(content)) {
            setIsBinary(true);
          } else if (content.length > MAX_DISPLAY_SIZE) {
            setIsOversized(true);
          }
        }
      } catch (err) {
        // 同步代码异常兜底，防止点击文件导致整个面板崩溃黑屏
        console.error('[EditorPanel] handleSelectFile 同步异常:', err);
        setSelectedFile(null);
      }
    }
  }, [fileContents]);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!selectedFile) return;
    const value = e.target.value;
    setFileContents(prev => ({ ...prev, [selectedFile]: value }));
    setModified(prev => new Set(prev).add(selectedFile));
  }, [selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !modified.has(selectedFile)) return;

    const content = fileContents[selectedFile];
    try {
      if (isElectron) {
        const electronAPI = window.electronAPI;
        if (electronAPI?.editor?.saveFile) {
          await electronAPI.editor.saveFile(selectedFile, content);
        }
      } else {
        const resp = await fetch('/api/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: selectedFile, content }),
        });
        if (!resp.ok) {
          throw new Error(`保存失败: HTTP ${resp.status}`);
        }
      }
      setModified(prev => { const next = new Set(prev); next.delete(selectedFile); return next; });
    } catch (err) {
      console.error('保存失败:', err);
    }
  }, [selectedFile, modified, fileContents]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab 缩进
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const value = ta.value;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      setFileContents(prev => ({ ...prev, [selectedFile!]: newValue }));
      setModified(prev => new Set(prev).add(selectedFile!));
      // 恢复光标位置
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    // Ctrl+S 保存
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  }, [selectedFile, handleSave]);

  const handleCursorChange = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const text = ta.value.substring(0, ta.selectionStart);
    const lines = text.split('\n');
    setCursorLine(lines.length);
    setCursorCol(lines[lines.length - 1].length + 1);
  }, []);

  const refreshTree = useCallback(async () => {
    if (isElectron) {
      const electronAPI = window.electronAPI;
      if (electronAPI?.editor?.readDir) {
        try {
          const tree = await electronAPI.editor.readDir('.');
          // 验证返回的文件树结构，防止异常数据导致渲染崩溃
          if (Array.isArray(tree) && tree.every((n) => n && typeof n.name === 'string' && typeof n.path === 'string')) {
            setFileTree(tree);
          }
        } catch (err) {
          console.error('[EditorPanel] 刷新文件树失败:', err);
          /* 保持现有树 */
        }
      }
    }
  }, []);

  // 行号
  const lineCount = currentContent ? currentContent.split('\n').length : 1;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);

  return (
    <div style={{ height: '100%', display: 'flex', background: '#08061a' }}>
      {/* 文件树侧栏 - 玻璃态 */}
      <div style={{
        width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderRight: '1px solid rgba(139,92,246,.1)',
      }}>
        {/* 侧栏标题 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: '1px solid rgba(139,92,246,.1)',
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1.5 }}>
            资源管理器
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            <button onClick={refreshTree} style={iconBtnStyle} title="刷新">
              <RefreshCw style={{ width: 13, height: 13 }} />
            </button>
            <button style={iconBtnStyle} title="新建文件">
              <FilePlus style={{ width: 13, height: 13 }} />
            </button>
            <button style={iconBtnStyle} title="新建文件夹">
              <FolderPlus style={{ width: 13, height: 13 }} />
            </button>
          </div>
        </div>

        {/* 文件树 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {fileTree.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedFile}
              onSelect={handleSelectFile}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
            />
          ))}
        </div>
      </div>

      {/* 编辑区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 标签栏 - 玻璃态 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          background: 'rgba(10, 14, 26, 0.85)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderBottom: '1px solid rgba(139,92,246,.1)',
          flexShrink: 0, overflowX: 'auto',
        }}>
          {selectedFile ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', fontSize: 13,
              background: '#08061a', color: '#e2e8f0',
              borderRight: '1px solid rgba(139,92,246,.1)',
              whiteSpace: 'nowrap',
              borderBottom: '2px solid #8b5cf6',
            }}>
              <File style={{ width: 13, height: 13, color: '#8b5cf6' }} />
              {selectedFile.split('/').pop()}
              {modified.has(selectedFile) && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', boxShadow: '0 0 4px rgba(245,158,11,.5)' }} />
              )}
              <button onClick={handleSave} style={{ ...iconBtnStyle, marginLeft: 4 }} title="保存 (Ctrl+S)">
                <Save style={{ width: 12, height: 12 }} />
              </button>
            </div>
          ) : (
            <div style={{ padding: '8px 14px', fontSize: 13, color: '#64748b' }}>
              选择文件开始编辑
            </div>
          )}
        </div>

        {/* 编辑器主体 */}
        {selectedFile ? (
          isBinary ? (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#64748b', fontSize: 14,
            }}>
              <div style={{ textAlign: 'center' }}>
                <AlertTriangle style={{ width: 40, height: 40, color: '#f59e0b', margin: '0 auto 14px' }} />
                <div style={{ fontSize: 15, color: '#94a3b8', marginBottom: 6 }}>二进制文件，无法显示</div>
                <div style={{ fontSize: 12, color: '#475569' }}>{selectedFile}</div>
              </div>
            </div>
          ) : (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
            {/* 大文件提示 */}
            {isOversized && (
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
                padding: '6px 14px', fontSize: 12, color: '#f59e0b',
                background: 'rgba(245,158,11,.08)', borderBottom: '1px solid rgba(245,158,11,.15)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <AlertTriangle style={{ width: 12, height: 12 }} />
                文件过大，仅显示前 100KB 内容
              </div>
            )}
            {/* 行号 */}
            <div style={{
              width: 52, flexShrink: 0, overflow: 'hidden',
              background: 'rgba(10, 14, 26, 0.6)',
              borderRight: '1px solid rgba(139,92,246,.08)',
              padding: '10px 0',
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
              fontSize: 13, lineHeight: 1.6, textAlign: 'right',
              color: '#475569', userSelect: 'none',
            }}>
              {lineNumbers.map(n => (
                <div key={n} style={{ paddingRight: 14, height: 20.8 }}>{n}</div>
              ))}
            </div>

            {/* 代码区域：textarea + 高亮覆盖层 */}
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
              {/* 语法高亮层 */}
              <pre
                ref={highlightRef}
                aria-hidden="true"
                style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  margin: 0, padding: '10px 12px',
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
                  fontSize: 13, lineHeight: 1.6,
                  color: '#e2e8f0', whiteSpace: 'pre', overflow: 'auto',
                  pointerEvents: 'none', background: 'transparent',
                }}
              >
                {highlightCode(currentContent)}
              </pre>

              {/* 实际输入 textarea */}
              <textarea
                ref={textareaRef}
                value={currentContent}
                onChange={handleContentChange}
                onKeyDown={handleKeyDown}
                onSelect={handleCursorChange}
                spellCheck={false}
                style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  width: '100%', height: '100%',
                  margin: 0, padding: '10px 12px',
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
                  fontSize: 13, lineHeight: 1.6,
                  color: 'transparent', caretColor: '#8b5cf6',
                  background: 'transparent',
                  border: 'none', outline: 'none', resize: 'none',
                  whiteSpace: 'pre', overflow: 'auto',
                  WebkitTextFillColor: 'transparent',
                }}
              />
            </div>
          </div>
          )
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#475569', fontSize: 14,
          }}>
            <div style={{ textAlign: 'center' }}>
              <File style={{ width: 40, height: 40, color: '#334155', margin: '0 auto 14px' }} />
              <div style={{ fontSize: 15, color: '#64748b', marginBottom: 6 }}>选择左侧文件开始编辑</div>
              <div style={{ fontSize: 12, color: '#475569' }}>
                <kbd style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(139,92,246,.1)', border: '1px solid rgba(139,92,246,.2)', fontSize: 11 }}>Ctrl+S</kbd> 保存文件
              </div>
            </div>
          </div>
        )}

        {/* 状态栏 - 玻璃态 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '4px 14px', height: 26,
          background: 'rgba(10, 14, 26, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderTop: '1px solid rgba(139,92,246,.1)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            行 {cursorLine}, 列 {cursorCol}
          </span>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            UTF-8
          </span>
          {selectedFile && (
            <span style={{ fontSize: 11, color: '#8b5cf6' }}>
              {selectedFile.endsWith('.tsx') ? 'TypeScript React'
                : selectedFile.endsWith('.ts') ? 'TypeScript'
                : selectedFile.endsWith('.jsx') || selectedFile.endsWith('.js') ? 'JavaScript'
                : selectedFile.endsWith('.css') ? 'CSS'
                : selectedFile.endsWith('.json') ? 'JSON'
                : selectedFile.endsWith('.md') ? 'Markdown'
                : 'Plain Text'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {isWriting && (
            <span style={{ fontSize: 11, color: '#22d3ee', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 4px rgba(34,211,238,.6)', animation: 'status-pulse 1s infinite' }} />
              Agent 正在写入
              <span style={{ width: 70, height: 4, borderRadius: 2, background: 'rgba(34,211,238,.15)', overflow: 'hidden', display: 'inline-block' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.round(writingProgress * 100)}%`, background: '#22d3ee', transition: 'width .12s' }} />
              </span>
              {writingTotal > 0 ? `${Math.round(writingProgress * writingTotal)}/${writingTotal} 行` : ''}
            </span>
          )}
          {selectedFile && modified.has(selectedFile) && (
            <span style={{ fontSize: 11, color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', boxShadow: '0 0 4px rgba(245,158,11,.5)' }} />
              已修改
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== 图标按钮样式 =====
const iconBtnStyle: React.CSSProperties = {
  padding: 4, borderRadius: 6, border: 'none',
  background: 'transparent', cursor: 'pointer', color: '#64748b',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  transition: 'color .12s, background .12s',
};

// ===== Error Boundary =====
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class EditorErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[EditorPanel] Render error:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', padding: 40,
          background: '#08061a', color: '#e2e8f0',
        }}>
          <AlertTriangle style={{ width: 40, height: 40, color: '#f59e0b', marginBottom: 16 }} />
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>编辑器渲染出错</h3>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 4px', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 20px' }}>
            文件可能包含无法渲染的内容
          </p>
          <button
            onClick={this.handleReset}
            style={{
              padding: '8px 20px', borderRadius: 8, border: 'none',
              background: 'rgba(139,92,246,.15)', color: '#8b5cf6',
              cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <RotateCw style={{ width: 14, height: 14 }} />
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ===== 带 Error Boundary 的导出组件 =====
interface EditorPanelSafeProps {
  initialFile?: { path: string; content: string } | null;
}

export function EditorPanelSafe({ initialFile }: EditorPanelSafeProps) {
  return (
    <EditorErrorBoundary>
      <EditorPanel initialFile={initialFile} />
    </EditorErrorBoundary>
  );
}
