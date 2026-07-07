/**
 * 窗口状态持久化
 * 从 desktop/main.js 抽出 — 内部状态 windowStateSaveTimer，无跨模块依赖
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// P2-2 修复：窗口状态持久化路径（存放在用户目录下的 .duan/ 中，与 isWithinWorkspace 允许的路径一致）
const WINDOW_STATE_PATH = path.join(os.homedir(), '.duan', 'window-state.json');

/**
 * 加载窗口状态
 * P2-2 修复：启动时恢复上次窗口位置、大小、最大化状态
 * @returns {{x?: number, y?: number, width: number, height: number, isMaximized?: boolean}}
 */
function loadWindowState() {
  const defaultState = { width: 1440, height: 960 };
  try {
    if (!fs.existsSync(WINDOW_STATE_PATH)) return defaultState;
    const raw = fs.readFileSync(WINDOW_STATE_PATH, 'utf-8');
    const state = JSON.parse(raw);
    // 基本合法性校验
    if (typeof state !== 'object' || state === null) return defaultState;
    if (!Number.isFinite(state.width) || state.width < 1024) state.width = 1440;
    if (!Number.isFinite(state.height) || state.height < 700) state.height = 960;
    if (state.x !== undefined && (!Number.isFinite(state.x) || Math.abs(state.x) > 100000)) {
      delete state.x;
    }
    if (state.y !== undefined && (!Number.isFinite(state.y) || Math.abs(state.y) > 100000)) {
      delete state.y;
    }
    return state;
  } catch (err) {
    console.warn('[WindowState] 读取失败，使用默认值:', err.message);
    return defaultState;
  }
}

/**
 * 保存窗口状态（防抖）
 * P2-2 修复：窗口移动/缩放/最大化时持久化状态
 */
let windowStateSaveTimer = null;
function saveWindowState(window) {
  if (!window || window.isDestroyed()) return;
  // 防抖：避免频繁写入
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    try {
      const isMaximized = window.isMaximized();
      const bounds = window.getNormalBounds(); // 最大化时返回非最大化状态的 bounds
      const state = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized,
      };
      // 确保目录存在
      const dir = path.dirname(WINDOW_STATE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 原子写入
      const tmpPath = WINDOW_STATE_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmpPath, WINDOW_STATE_PATH);
    } catch (err) {
      console.warn('[WindowState] 保存失败:', err.message);
      try { fs.unlinkSync(WINDOW_STATE_PATH + '.tmp'); } catch { /* ignore */ }
    }
  }, 300);
}

module.exports = {
  WINDOW_STATE_PATH,
  loadWindowState,
  saveWindowState,
};
