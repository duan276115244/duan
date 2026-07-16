/**
 * @file 引用自动完成菜单组件（对标 Cursor @mention）
 *
 * 在输入框键入 @ 时弹出，展示过滤后的项目文件列表。
 * 选择文件后，文件内容将作为上下文注入到 LLM 请求中。
 * 键盘导航逻辑（↑↓/Enter/Esc）由 ChatArea 的 handleKeyDown 处理，
 * 本组件只负责渲染。
 *
 * 工具函数/类型/常量定义在 fileReferenceUtils.ts 中（遵循 react-refresh 分离模式）。
 */
import React from 'react';
import { FileText, FileCode, FileCog, FileImage } from 'lucide-react';
import type { FileEntry } from './fileReferenceUtils';

interface FileReferenceMenuProps {
  files: FileEntry[];
  selectedIndex: number;
  onSelect: (file: FileEntry) => void;
  onHover: (index: number) => void;
  visible: boolean;
  loading?: boolean;
}

/** 按扩展名选择文件图标与颜色 */
function getFileIcon(ext: string): { Icon: typeof FileText; color: string } {
  const codeExts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'rb', 'php', 'swift', 'kt', 'vue', 'svelte'];
  const configExts = ['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'config'];
  const imgExts = ['svg'];
  if (codeExts.includes(ext)) return { Icon: FileCode, color: '#10b981' };
  if (configExts.includes(ext)) return { Icon: FileCog, color: '#f59e0b' };
  if (imgExts.includes(ext)) return { Icon: FileImage, color: '#06b6d4' };
  return { Icon: FileText, color: '#94a3b8' };
}

// 模块级样式常量，避免每次渲染重建对象（与 SlashCommandMenu 风格一致）
const MENU_WRAPPER: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  marginBottom: 6,
  maxHeight: 280,
  overflowY: 'auto',
  background: 'rgba(6, 9, 18, 0.95)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  border: '1px solid rgba(6, 182, 212, 0.15)',
  borderRadius: 10,
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 16px rgba(6, 182, 212, 0.08)',
  zIndex: 50,
  padding: '4px 0',
};

const FILE_ROW_BASE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 12px',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
  transition: 'background .12s',
};

const FILE_NAME: React.CSSProperties = {
  color: '#e2e8f0',
  fontWeight: 500,
  flexShrink: 0,
  maxWidth: 200,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const FILE_PATH: React.CSSProperties = {
  color: '#64748b',
  fontSize: 10,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginLeft: 'auto',
};

const LOADING_TEXT: React.CSSProperties = {
  padding: '12px',
  textAlign: 'center',
  color: '#64748b',
  fontSize: 11,
};

const EMPTY_TEXT: React.CSSProperties = {
  padding: '12px',
  textAlign: 'center',
  color: '#64748b',
  fontSize: 11,
};

export const FileReferenceMenu = React.memo(function FileReferenceMenu({
  files,
  selectedIndex,
  onSelect,
  onHover,
  visible,
  loading,
}: FileReferenceMenuProps) {
  if (!visible) return null;
  if (loading) {
    return (
      <div style={MENU_WRAPPER} role="listbox" aria-label="文件引用">
        <div style={LOADING_TEXT}>加载文件列表...</div>
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div style={MENU_WRAPPER} role="listbox" aria-label="文件引用">
        <div style={EMPTY_TEXT}>无匹配文件</div>
      </div>
    );
  }
  return (
    <div style={MENU_WRAPPER} role="listbox" aria-label="文件引用">
      {files.map((file, i) => {
        const isSel = i === selectedIndex;
        const { Icon, color } = getFileIcon(file.ext);
        return (
          <div
            key={file.path}
            role="option"
            aria-selected={isSel}
            onClick={() => onSelect(file)}
            onMouseEnter={() => onHover(i)}
            style={{
              ...FILE_ROW_BASE,
              background: isSel ? 'rgba(6, 182, 212, 0.1)' : 'transparent',
            }}
          >
            <Icon style={{ width: 13, height: 13, color, flexShrink: 0 }} />
            <span style={FILE_NAME}>{file.name}</span>
            <span style={FILE_PATH}>{file.relativePath}</span>
          </div>
        );
      })}
    </div>
  );
});
