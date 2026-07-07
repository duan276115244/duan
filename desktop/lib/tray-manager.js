/**
 * 系统托盘子系统
 * 从 desktop/main.js 抽出 — 工厂模式
 *
 * 依赖：getMainWindow / getAgentProcess / getIsQuitting / setIsQuitting /
 *       createMainWindow / createSettingsWindow / autoUpdater / getTray / setTray
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   getAgentProcess: () => any,
 *   getIsQuitting: () => boolean,
 *   setIsQuitting: (v: boolean) => void,
 *   createMainWindow: () => void,
 *   createSettingsWindow: () => void,
 *   autoUpdater: any,
 *   getTray: () => import('electron').Tray | null,
 *   setTray: (t: import('electron').Tray | null) => void,
 * }} deps
 */
function createTrayManager(deps) {
  const {
    getMainWindow,
    getAgentProcess,
    setIsQuitting,
    createMainWindow,
    createSettingsWindow,
    autoUpdater,
    getTray,
    setTray,
  } = deps;

  function updateTrayStatus(state, detail) {
    const tray = getTray();
    if (!tray) return;
    const baseName = '段先生 - 您的私人智能助手';
    const stateMap = {
      running: '● 运行中',
      starting: '◐ 启动中...',
      restarting: '↻ 重启中...',
      stopped: '○ 已停止',
      crashed: '✖ 已崩溃',
    };
    const stateLabel = stateMap[state] || state;
    const tip = detail ? `${baseName}\n${stateLabel}\n${detail}` : `${baseName}\n${stateLabel}`;
    try {
      tray.setToolTip(tip);
    } catch (err) {
      console.warn('[Tray] 更新 tooltip 失败:', err.message);
    }
  }

  function createTray() {
    let trayIcon;
    const iconPath = path.join(__dirname, '..', 'icon.png');
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
      // 创建一个 16x16 的简单占位图标（1x1像素蓝色点）
      trayIcon = nativeImage.createFromBuffer(
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVQ4y2Nk+M9Qz0BqIAAAf4MAOiDNAAAAAElFTkSuQmCC', 'base64')
      );
    }

    if (trayIcon.isEmpty()) {
      console.log('[主进程] 托盘图标为空，跳过托盘创建');
      return;
    }

    const tray = new Tray(trayIcon);
    setTray(tray);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          const mw = getMainWindow();
          if (mw) {
            mw.show();
            mw.focus();
          }
        },
      },
      {
        // P1-2 修复：新增"新建对话"菜单项
        label: '新建对话',
        click: () => {
          const mw = getMainWindow();
          if (mw) {
            mw.show();
            mw.focus();
            mw.webContents.send('agent:new-conversation');
          }
        },
      },
      { type: 'separator' },
      {
        label: '打开浏览器',
        click: () => {
          // P1-6 修复：使用主窗口内置 BrowserPanel，不再弹出独立窗口
          const mw = getMainWindow();
          if (mw && !mw.isDestroyed()) {
            mw.show();
            mw.focus();
            mw.webContents.send('tool:activate', 'browser');
          }
        },
      },
      {
        label: '设置',
        click: () => createSettingsWindow(),
      },
      { type: 'separator' },
      {
        // P1-2 修复：新增"检查更新"菜单项
        label: '检查更新',
        click: () => {
          if (autoUpdater) {
            const mw = getMainWindow();
            if (mw && !mw.isDestroyed()) {
              mw.show();
              mw.webContents.send('updater:checking');
            }
            autoUpdater.checkForUpdates().catch((err) => {
              console.warn('[Tray] 检查更新失败:', err.message);
              const mw2 = getMainWindow();
              if (mw2 && !mw2.isDestroyed()) {
                mw2.webContents.send('updater:error', { message: err.message });
              }
            });
          } else {
            const mw = getMainWindow();
            if (mw && !mw.isDestroyed()) {
              mw.show();
              mw.webContents.send('updater:not-available', { version: app.getVersion() });
            }
          }
        },
      },
      {
        // P1-2 修复：新增"打开日志目录"菜单项
        label: '打开日志目录',
        click: () => {
          const logDir = path.join(os.homedir(), '.duan', 'logs');
          try {
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const { shell } = require('electron');
            shell.openPath(logDir);
          } catch (err) {
            console.error('[Tray] 打开日志目录失败:', err.message);
          }
        },
      },
      { type: 'separator' },
      {
        // P1-2 修复：新增"关于"菜单项
        label: '关于',
        click: () => {
          const { dialog } = require('electron');
          dialog.showMessageBox({
            type: 'info',
            title: '关于 段先生',
            message: '段先生 - AI 智能助手',
            detail: `版本: ${app.getVersion()}\nElectron: ${process.versions.electron}\nNode.js: ${process.versions.node}\n\n您的私人智能助手，具备思考、学习、代码执行、视频生成等能力。`,
            buttons: ['确定'],
          });
        },
      },
      {
        label: '退出',
        click: () => {
          setIsQuitting(true);
          app.quit();
        },
      },
    ]);

    // P1-3 修复：初始 tooltip 反映当前状态
    const initialTip = getAgentProcess()
      ? '段先生 - 您的私人智能助手\n● 运行中'
      : '段先生 - 您的私人智能助手\n○ 已停止';
    tray.setToolTip(initialTip);
    tray.setContextMenu(contextMenu);

    // P1-3 修复：单击切换窗口可见性（与双击行为一致，符合 Windows 习惯）
    tray.on('click', () => {
      const mw = getMainWindow();
      if (mw) {
        if (mw.isVisible() && !mw.isMinimized()) {
          // 已显示则隐藏，避免遮挡
          mw.hide();
        } else {
          mw.show();
          mw.focus();
        }
      }
    });

    tray.on('double-click', () => {
      const mw = getMainWindow();
      if (mw) {
        mw.show();
        mw.focus();
      }
    });
  }

  function destroyTray() {
    const tray = getTray();
    if (tray) {
      try {
        tray.destroy();
        setTray(null);
      } catch (err) {
        console.warn('[Tray] 销毁失败:', err.message);
      }
    }
  }

  return { createTray, updateTrayStatus, destroyTray };
}

module.exports = { createTrayManager };
