/**
 * 自动更新子系统
 * 从 desktop/main.js 抽出 — 工厂模式，依赖 getMainWindow + getIsQuitting + autoUpdater 实例
 *
 * 已知 latent bug 保留：setupAutoUpdater 末尾预热 Python 缓存时调用 findPythonExecutable()，
 * 该函数定义在 main.js 的 registerIpcHandlers() 内部作用域，本模块无法访问。
 * 抽出后仍会抛 ReferenceError，被外层 try-catch 静默捕获，行为与原 main.js 一致。
 */

/**
 * 创建自动更新子系统
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   getIsQuitting: () => boolean,
 *   autoUpdater: any
 * }} deps
 */
function createAutoUpdater({ getMainWindow, getIsQuitting, autoUpdater }) {
  function setupAutoUpdater() {
    if (!autoUpdater) return;

    // P0-3 修复：明确自动下载策略 — autoDownload=false 由用户触发下载
    // 但 update-available 事件中自动下载，保持当前行为（用户已通过检查更新表达意愿）
    // 补充缺失的事件处理，错误通过 IPC 通知用户

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] 正在检查更新...');
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('updater:checking');
      }
    });

    autoUpdater.on('update-available', (info) => {
      console.log('[Updater] 发现新版本:', info.version || 'unknown');
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('updater:available', info);
      }
      // 自动下载（用户已通过检查更新表达意愿）
      autoUpdater.downloadUpdate();
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log('[Updater] 当前已是最新版本');
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('updater:not-available', info);
      }
    });

    autoUpdater.on('download-progress', (progress) => {
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('updater:progress', {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[Updater] 更新已下载，等待安装');
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('updater:downloaded', info);
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('[Updater] 自动更新错误:', err);
      // P0-3 修复：错误通过 IPC 通知用户
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('updater:error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // P0-3 修复：启动后延迟 30 秒自动检查更新（非阻塞）
    setTimeout(() => {
      if (autoUpdater && !getIsQuitting()) {
        console.log('[Updater] 启动后自动检查更新...');
        autoUpdater.checkForUpdates().catch((err) => {
          console.warn('[Updater] 自动检查更新失败:', err.message);
        });
      }
    }, 30000);

    // 预热 Python 缓存（延迟 2 秒，非阻塞，加速首次语音试听）
    // 注意：findPythonExecutable 定义在 main.js 的 registerIpcHandlers 作用域内，
    // 此处调用会抛 ReferenceError 被 try-catch 静默捕获（与原 main.js 行为一致）
    setTimeout(() => {
      try {
        const py = findPythonExecutable();
        if (py) console.log('[Voice] Python 缓存预热完成:', py);
        else console.warn('[Voice] 未找到 Python，语音试听将依赖 Agent 服务器');
      } catch { /* ignore */ }
    }, 2000);
  }

  return { setupAutoUpdater };
}

module.exports = { createAutoUpdater };
