/**
 * 窗口管理子系统
 * 从 desktop/main.js 抽出 — 工厂模式
 *
 * 依赖：loadWindowState / saveWindowState（来自 window-state.js）/
 *       setMainWindow / setBrowserWindow / setSettingsWindow（写回 main.js 模块级变量）/
 *       getMainWindow（读取 main.js 模块级变量，用于 setWindowOpenHandler 重定向）/
 *       FRONTEND_DIST / IS_DEV / getIsQuitting
 */

const { BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * @param {{
 *   loadWindowState: () => any,
 *   saveWindowState: (w: import('electron').BrowserWindow) => void,
 *   setMainWindow: (w: import('electron').BrowserWindow | null) => void,
 *   setBrowserWindow: (w: import('electron').BrowserWindow | null) => void,
 *   setSettingsWindow: (w: import('electron').BrowserWindow | null) => void,
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   FRONTEND_DIST: string,
 *   IS_DEV: boolean,
 *   getIsQuitting: () => boolean,
 * }} deps
 */
function createWindowManager(deps) {
  const {
    loadWindowState,
    saveWindowState,
    setMainWindow,
    setBrowserWindow,
    setSettingsWindow,
    getMainWindow,
    FRONTEND_DIST,
    IS_DEV,
    getIsQuitting,
  } = deps;

  function getFrontendUrl() {
    if (IS_DEV) {
      return 'http://localhost:5173';
    }
    // Windows file:// 路径需要正斜杠
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    return `file:///${indexPath.replace(/\\/g, '/')}`;
  }

  function getPreloadPath() {
    return path.join(__dirname, 'preload.js');
  }

  // ===== 窗口创建 =====

  function createMainWindow() {
    // P2-2 修复：加载上次窗口状态
    const windowState = loadWindowState();
    const mw = new BrowserWindow({
      width: windowState.width,
      height: windowState.height,
      x: windowState.x,
      y: windowState.y,
      minWidth: 1024,
      minHeight: 700,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#060b18',
      show: false,
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: getPreloadPath(),
        sandbox: false,
        webSecurity: true,
        webviewTag: true,
      },
    });
    setMainWindow(mw);

    // P2-2 修复：如果上次是最大化状态，启动后恢复最大化
    if (windowState.isMaximized) {
      mw.maximize();
    }

    const url = getFrontendUrl();
    console.log(`[主进程] 加载前端: ${url}`);
    console.log(`[主进程] 前端dist目录: ${FRONTEND_DIST}`);
    console.log(`[主进程] index.html存在: ${fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))}`);

    mw.loadURL(url);

    // 修复浏览器面板加载失败：校验 webview 创建参数，防止不安全的 webPreferences
    mw.webContents.on('will-attach-webview', (_event, webPreferences, _params) => {
      // 确保 webview 安全配置
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = false;  // 需要关闭 sandbox 以支持 partition 和 webviewTag
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
    });

    // 修复浏览器面板加载失败：为 persist:browser 分区会话配置权限和证书验证
    try {
      const browserSession = session.fromPartition('persist:browser');

      // 允许常见的权限请求（webview 默认会自动拒绝所有权限请求）
      browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowedPermissions = [
          'media',              // 摄像头/麦克风
          'geolocation',        // 地理位置
          'notifications',      // 通知
          'midiSysex',          // MIDI
          'pointerLock',        // 鼠标锁定
          'fullscreen',         // 全屏
          'openExternal',       // 打开外部链接
          'clipboard-read',     // 剪贴板读取
          'clipboard-write',    // 剪贴板写入
        ];
        if (allowedPermissions.includes(permission)) {
          callback(true);
        } else {
          // 未知权限默认拒绝，但记录日志以便排查
          console.log(`[BrowserSession] 拒绝权限请求: ${permission}`);
          callback(false);
        }
      });

      // 证书验证：对大部分证书错误采用宽松策略，避免因自签名证书导致页面加载失败
      browserSession.setCertificateVerifyProc((request, callback) => {
        const { verificationResult, errorCode } = request;
        // verificationResult 为空字符串表示证书验证通过
        // Electron 有效证书返回 verificationResult='net::OK'（truthy）+ errorCode=0
        // 之前仅匹配空字符串，导致 'net::OK' 被误判为错误 → 每会话 20 次证书验证失败
        // 用 == 宽松比较防止 errorCode 类型差异（string '0' vs number 0）
        if (!verificationResult || String(verificationResult).trim() === 'net::OK' || errorCode == 0) {
          callback(0); // 信任该证书
          return;
        }
        // 常见可忽略的证书错误（自签名、过期等），允许加载但记录日志
        const ignorableErrors = [
          -200,  // CERT_DATE_INVALID
          -201,  // CERT_AUTHORITY_INVALID
          -202,  // CERT_COMMON_NAME_INVALID
          -203,  // CERT_WEAK_SIGNATURE_ALGORITHM
          -204,  // CERT_NAME_CONSTRAINT_VIOLATION
          -205,  // CERT_WEAK_KEY
          -207,  // CERT_INVALID
          -208,  // CERT_REVOKED
        ];
        if (ignorableErrors.includes(errorCode)) {
          console.warn(`[BrowserSession] 忽略证书错误: code=${errorCode} result=${verificationResult}`);
          callback(0); // 允许继续加载
          return;
        }
        // 其他未知证书错误，按默认处理（拒绝）
        console.error(`[BrowserSession] 证书验证失败: code=${errorCode} result=${verificationResult}`);
        callback(-3); // 拒绝
      });

      console.log('[主进程] persist:browser 分区会话配置完成');
    } catch (err) {
      console.error('[主进程] persist:browser 分区会话配置失败:', err);
    }

    // P1-6 修复：拦截所有新窗口请求（target="_blank"、window.open），
    // 重定向到主窗口内置 BrowserPanel，不再弹出独立浏览器窗口
    mw.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (openUrl && /^https?:\/\//i.test(openUrl)) {
        mw.webContents.send('tool:activate', 'browser');
        mw.webContents.send('browser:navigate-panel', openUrl);
      }
      return { action: 'deny' };
    });

    mw.once('ready-to-show', () => {
      console.log('[主进程] 窗口ready-to-show');
      mw.show();
    });

    // 加载失败时打开 DevTools 调试（P2-14 修复：仅开发模式）
    mw.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
      // -3 ERR_ABORTED 是导航被后续导航取消的正常现象（如 about:blank 被真实 URL 取代），非真实错误
      if (errorCode === -3) return;
      console.error(`[主进程] 页面加载失败: ${errorCode} ${errorDesc} URL: ${validatedURL}`);
      if (IS_DEV) {
        mw.webContents.openDevTools({ mode: 'detach' });
      }
    });

    // 加载成功日志
    mw.webContents.on('did-finish-load', () => {
      console.log('[主进程] 页面加载成功');
    });

    mw.on('maximize', () => {
      mw.webContents.send('window:maximized-change', true);
      saveWindowState(mw); // P2-2 修复：保存最大化状态
    });

    mw.on('unmaximize', () => {
      mw.webContents.send('window:maximized-change', false);
      saveWindowState(mw); // P2-2 修复：保存非最大化状态
    });

    // P2-2 修复：窗口移动和缩放时保存状态（防抖）
    mw.on('resize', () => saveWindowState(mw));
    mw.on('move', () => saveWindowState(mw));

    mw.on('close', (e) => {
      // P2-2 修复：关闭前保存一次窗口状态（确保最新状态落盘）
      saveWindowState(mw);
      if (!getIsQuitting()) {
        e.preventDefault();
        mw.hide();
      }
    });

    mw.on('closed', () => {
      setMainWindow(null);
    });

    if (IS_DEV) {
      mw.webContents.openDevTools({ mode: 'detach' });
    }
  }

  // P1-6 修复：浏览器窗口改为隐藏模式，仅用于 Agent 内容提取。
  // 用户看到的浏览器界面是主窗口内的 BrowserPanel（webview），不再弹出独立窗口。
  function createBrowserWindow(url = 'about:blank', options = {}) {
    const { show = false } = options;

    // 通过 setBrowserWindow(null) 之前创建的窗口需要先检查
    // 这里复用 main.js 的 browserWindow 变量（通过 setBrowserWindow 控制）
    // 但本模块不持有 browserWindow 引用，需要调用方判断
    // 为保持行为一致，这里通过闭包模拟原逻辑：用一个局部变量跟踪
    // 实际上 main.js 的 browserWindow 变量需要可读可写，我们通过外部传入的 getBrowserWindow/setBrowserWindow
    // 但本工厂未提供 getBrowserWindow，因此改用如下方案：使用模块内私有变量
    return _createBrowserWindowImpl(url, show);
  }

  // 模块内私有变量：跟踪 browserWindow（与 main.js 的 browserWindow 变量同步）
  let _browserWindowRef = null;
  function _setBrowserWindowRef(w) {
    _browserWindowRef = w;
    setBrowserWindow(w); // 同步到 main.js 模块级变量
  }

  function _createBrowserWindowImpl(url, show) {
    if (_browserWindowRef && !_browserWindowRef.isDestroyed()) {
      _browserWindowRef.loadURL(url).catch((err) => {
        console.warn(`[BrowserWindow] loadURL 失败: ${url}`, err?.message || err);
      });
      if (show) { _browserWindowRef.show(); _browserWindowRef.focus(); }
      return;
    }

    const bw = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 500,
      show,
      // 隐藏窗口仍需渲染，以便 Agent 提取页面内容和截图
      paintWhenInitiallyHidden: true,
      backgroundColor: '#060b18',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: getPreloadPath(),
        sandbox: false,
        webSecurity: true,
        webviewTag: true,
      },
    });
    _setBrowserWindowRef(bw);

    bw.loadURL(url).catch((err) => {
      console.warn(`[BrowserWindow] 初始 loadURL 失败: ${url}`, err?.message || err);
    });

    // V17 安全修复：限制页面内导航仅允许 http/https/about:blank，防止 file:// 和 javascript: 协议
    // P1 修复：about:blank 是 BrowserWindow 默认初始页，必须放行，否则触发 ERR_ABORTED
    bw.webContents.on('will-navigate', (event, navigationUrl) => {
      if (navigationUrl === 'about:blank') return; // 允许 about:blank 初始化导航
      if (!/^https?:\/\//i.test(navigationUrl)) {
        event.preventDefault();
        console.warn(`[BrowserWindow] 已拦截非 http(s) 导航: ${navigationUrl}`);
      }
    });
    // 拦截新窗口请求（与主窗口一致，重定向到内置浏览器面板）
    bw.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (openUrl && /^https?:\/\//i.test(openUrl)) {
        const mw = getMainWindow();
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('browser:navigate-panel', openUrl);
        }
      }
      return { action: 'deny' };
    });

    // P1 修复：捕获 URL 加载失败（如 ERR_CONNECTION_RESET/TIMED_OUT），防止未处理错误
    bw.webContents.on('did-fail-load', (_event, errorCode, errorDesc, failedUrl) => {
      console.warn(`[BrowserWindow] 页面加载失败: ${errorDesc} (${errorCode}) URL: ${failedUrl}`);
      // 降级到空白页，避免窗口停留在错误状态
      if (failedUrl && failedUrl !== 'about:blank') {
        _browserWindowRef?.loadURL('about:blank').catch(() => {});
      }
    });

    bw.on('closed', () => {
      _setBrowserWindowRef(null);
    });
  }

  function createSettingsWindow() {
    // 复用 main.js 的 settingsWindow 变量（通过 setSettingsWindow 控制）
    return _createSettingsWindowImpl();
  }

  let _settingsWindowRef = null;
  function _setSettingsWindowRef(w) {
    _settingsWindowRef = w;
    setSettingsWindow(w);
  }

  function _createSettingsWindowImpl() {
    if (_settingsWindowRef && !_settingsWindowRef.isDestroyed()) {
      _settingsWindowRef.show();
      _settingsWindowRef.focus();
      return;
    }

    const sw = new BrowserWindow({
      width: 640,
      height: 520,
      minWidth: 480,
      minHeight: 400,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#060b18',
      parent: getMainWindow(),
      modal: true,
      resizable: true,
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: getPreloadPath(),
        sandbox: false,
        webSecurity: true,
        webviewTag: true,
      },
    });
    _setSettingsWindowRef(sw);

    const settingsUrl = IS_DEV
      ? 'http://localhost:5173/#/config'
      : `file:///${path.join(FRONTEND_DIST, 'index.html').replace(/\\/g, '/')}#/config`;

    sw.loadURL(settingsUrl);

    sw.on('closed', () => {
      _setSettingsWindowRef(null);
    });
  }

  return {
    createMainWindow,
    createBrowserWindow,
    createSettingsWindow,
    getFrontendUrl,
    getPreloadPath,
  };
}

module.exports = { createWindowManager };
