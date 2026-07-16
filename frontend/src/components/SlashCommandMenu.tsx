/**
 * Slash 命令自动完成菜单（对标 Claude Code / Devin CLI）
 *
 * 在输入框键入 / 时弹出，展示过滤后的命令列表。
 * 键盘导航逻辑（↑↓/Enter/Esc）由 ChatArea 的 handleKeyDown 处理，
 * 本组件只负责渲染。
 */
import React from 'react';
import type { SlashCommand } from '@/commands/slashCommands';

interface SlashCommandMenuProps {
  /** 过滤后的命令列表 */
  commands: SlashCommand[];
  /** 当前高亮项索引 */
  selectedIndex: number;
  /** 点击命令时的回调 */
  onSelect: (cmd: SlashCommand) => void;
  /** 鼠标 hover 时的回调（同步 selectedIndex） */
  onHover: (index: number) => void;
  /** 是否可见 */
  visible: boolean;
}

// 模块级样式常量，避免每次渲染重建对象
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

const CMD_ROW_BASE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: 'inherit',
  transition: 'background .12s',
};

const CMD_NAME: React.CSSProperties = {
  color: '#67e8f9',
  fontWeight: 600,
  flexShrink: 0,
  minWidth: 72,
};

const CMD_DESC: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const CMD_ALIAS: React.CSSProperties = {
  color: '#64748b',
  fontSize: 10,
  flexShrink: 0,
  padding: '1px 6px',
  background: 'rgba(100, 116, 139, 0.1)',
  borderRadius: 4,
};

export const SlashCommandMenu = React.memo(function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onHover,
  visible,
}: SlashCommandMenuProps) {
  if (!visible || commands.length === 0) return null;
  return (
    <div style={MENU_WRAPPER} role="listbox" aria-label="Slash 命令">
      {commands.map((cmd, i) => {
        const isSel = i === selectedIndex;
        return (
          <div
            key={cmd.name}
            role="option"
            aria-selected={isSel}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => onHover(i)}
            style={{
              ...CMD_ROW_BASE,
              background: isSel ? 'rgba(6, 182, 212, 0.1)' : 'transparent',
            }}
          >
            <span style={CMD_NAME}>/{cmd.name}</span>
            <span style={CMD_DESC}>{cmd.description}</span>
            {cmd.aliases && cmd.aliases.length > 0 && (
              <span style={CMD_ALIAS}>/{cmd.aliases[0]}</span>
            )}
          </div>
        );
      })}
    </div>
  );
});
