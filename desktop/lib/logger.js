/**
 * 日志文件化子系统
 * 从 desktop/main.js 抽出 — 内部状态 logStream，无跨模块依赖
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.duan', 'logs');
const MAX_LOG_FILES = 7; // 保留最近 7 天的日志
let logStream = null;

/**
 * 获取当前日期字符串（YYYY-MM-DD）
 */
function getDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 清理过期日志文件
 */
function cleanOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const files = fs.readdirSync(LOG_DIR).filter(f => /^desktop-main-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    if (files.length <= MAX_LOG_FILES) return;
    // 按文件名排序（日期），删除最旧的
    files.sort();
    const toDelete = files.slice(0, files.length - MAX_LOG_FILES);
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* ignore */ }
    }
  } catch (err) {
    // 清理失败不影响主流程
  }
}

/**
 * 写入日志行到文件
 * @param {string} level - 日志级别
 * @param {Array<any>} args - 原始参数
 */
function writeLogFile(level, args) {
  if (!logStream) return;
  try {
    const timestamp = new Date().toISOString();
    const msg = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');

    // P0 日志降噪：过滤/降级良性 webview 错误
    // GUEST_VIEW_MANAGER_CALL + ERR_ABORTED(-3) 是 webview 导航被后续导航取消的正常现象，非真实错误
    // electron: Failed to load URL ... ERR_CONNECTION_RESET/TIMED_OUT 是网络问题，前端 did-fail-load 已处理并展示
    if (/\bGUEST_VIEW_MANAGER_CALL\b.*ERR_ABORTED/.test(msg)) return; // 完全静默
    if (/electron: Failed to load URL.*ERR_CONNECTION_(RESET|TIMED_OUT)/.test(msg)) {
      if (level === 'ERROR') level = 'WARN'; // 降级为警告
    }
    // ERR_ABORTED(-3) 单独出现也降级（常见于 about:blank 被后续 loadURL 取消）
    if (level === 'ERROR' && /ERR_ABORTED \(-3\)/.test(msg)) level = 'WARN';

    logStream.write(`[${timestamp}] [${level}] ${msg}\n`);
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * 设置日志文件化
 * 劫持 console.log/warn/error/info，同时输出到控制台和文件
 */
function setupFileLogging() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `desktop-main-${getDateString()}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf-8' });
    logStream.on('error', (err) => {
      // 日志流错误只打印到 stderr，避免无限递归
      process.stderr.write(`[LogStream] 错误: ${err.message}\n`);
    });

    // 清理过期日志
    cleanOldLogs();

    // 劫持 console 方法（保留原方法引用）
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    const origInfo = console.info.bind(console);

    console.log = (...args) => { origLog(...args); writeLogFile('INFO', args); };
    console.warn = (...args) => { origWarn(...args); writeLogFile('WARN', args); };
    console.error = (...args) => { origError(...args); writeLogFile('ERROR', args); };
    console.info = (...args) => { origInfo(...args); writeLogFile('INFO', args); };

    // 捕获未处理异常和 Promise 拒绝
    process.on('uncaughtException', (err) => {
      writeLogFile('FATAL', ['Uncaught Exception:', err.stack || err.message]);
      origError('[FATAL] Uncaught Exception:', err);
    });
    process.on('unhandledRejection', (reason) => {
      writeLogFile('FATAL', ['Unhandled Rejection:', reason]);
      origError('[FATAL] Unhandled Rejection:', reason);
    });

    origLog(`[主进程] 日志文件化已启用: ${logFile}`);
  } catch (err) {
    // 日志设置失败不影响启动，但需要打印到 stderr
    process.stderr.write(`[FileLogging] 启用失败: ${err.message}\n`);
  }
}

/**
 * 关闭日志文件流
 */
function closeFileLogging() {
  if (logStream) {
    try {
      logStream.end();
      logStream = null;
    } catch { /* ignore */ }
  }
}

module.exports = {
  getDateString,
  cleanOldLogs,
  writeLogFile,
  setupFileLogging,
  closeFileLogging,
};
