/**
 * IPC 安全工具：safeHandle / safeJsonRead / safeJsonWrite
 * 从 desktop/main.js 抽出 — 直接 import electron/fs，无跨模块依赖
 */

const { ipcMain } = require('electron');
const fs = require('fs');

/**
 * 安全的 IPC handler 包装器：自动 try-catch，统一错误返回格式
 * 防止未捕获异常导致 IPC 通道 reject 和错误信息泄露
 * @param {string} channel IPC 频道名
 * @param {Function} handler 异步处理函数
 */
function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[IPC] ${channel} 失败:`, msg);
      return { success: false, error: msg };
    }
  });
}

/**
 * 安全读取并解析 JSON 文件，失败时返回默认值
 * 防止损坏的配置文件导致 SyntaxError 崩溃
 * @param {string} filePath 文件路径
 * @param {*} defaultValue 解析失败时的默认值
 * @returns {*} 解析后的对象或默认值
 */
function safeJsonRead(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[safeJsonRead] 读取失败 ${filePath}:`, err.message);
    return defaultValue;
  }
}

/**
 * 安全写入 JSON 文件，带原子写入保护
 * @param {string} filePath 文件路径
 * @param {*} data 要序列化的对象
 * @returns {boolean} 是否成功
 */
function safeJsonWrite(filePath, data) {
  try {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[safeJsonWrite] 写入失败 ${filePath}:`, err.message);
    // 清理临时文件
    try { fs.unlinkSync(filePath + '.tmp'); } catch { /* ignore */ }
    return false;
  }
}

module.exports = {
  safeHandle,
  safeJsonRead,
  safeJsonWrite,
};
