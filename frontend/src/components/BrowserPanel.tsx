import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Star, StarOff, Plus, X, Globe } from 'lucide-react';

// ===== 类型 =====
interface Bookmark {
  id: string;
  title: string;
  url: string;
}

interface WebviewElement extends HTMLElement {
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  loadURL: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
}

interface PerformanceWithMemory {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

// ===== Electron 环境检测 =====
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ===== 默认书签 =====
const DEFAULT_BOOKMARKS: Bookmark[] = [
  { id: 'b1', title: 'GitHub', url: 'https://github.com' },
  { id: 'b2', title: 'MDN', url: 'https://developer.mozilla.org' },
  { id: 'b3', title: 'Stack Overflow', url: 'https://stackoverflow.com' },
];

// ===== 组件 =====
interface BrowserPanelProps {
  navigateUrl?: string;
}


export function BrowserPanel({ navigateUrl }: BrowserPanelProps) {
  const [url, setUrl] = useState('about:blank');
  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const domReadyRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  // 记录当前 webview 正在加载的 URL，避免 src 属性与 loadURL() 双重导航冲突
  const currentNavUrlRef = useRef<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    try {
      const saved = localStorage.getItem('browser_bookmarks');
      return saved ? JSON.parse(saved) : DEFAULT_BOOKMARKS;
    } catch {
      return DEFAULT_BOOKMARKS;
    }
  });
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const webviewRef = useRef<WebviewElement | null>(null);

  // 持久化书签
  useEffect(() => {
    localStorage.setItem('browser_bookmarks', JSON.stringify(bookmarks));
  }, [bookmarks]);

  // webview 事件绑定
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !isElectron) return;

    const logSystemState = (event: string) => {
      // 捕获异常发生前的系统状态，用于排查黑屏问题
      const mem = (performance as PerformanceWithMemory).memory;
      const memInfo = mem ? {
        usedJS: Math.round(mem.usedJSHeapSize / 1024 / 1024) + 'MB',
        totalJS: Math.round(mem.totalJSHeapSize / 1024 / 1024) + 'MB',
      } : 'N/A';
      console.warn(`[BrowserPanel] ${event} | URL: ${wv.getURL?.() || 'unknown'} | Mem: ${JSON.stringify(memInfo)} | Time: ${new Date().toISOString()}`);
    };

    const onLoadStart = () => {
      setLoading(true);
      setProgress(10);
      setLoadError(null);
      // 记录正在加载的 URL，用于 onNavigate 和 onLoadFail 判断
      try {
        const loadingUrl = wv.getURL();
        if (loadingUrl && loadingUrl !== 'about:blank') {
          currentNavUrlRef.current = loadingUrl;
        }
      } catch { /* ignore */ }
    };
    const onLoadProgress = (e: unknown) => { const ev = e as { progress?: number }; setProgress(Math.min(ev.progress ?? 0, 100)); };
    const onLoadStop = () => { setLoading(false); setProgress(100); setTimeout(() => setProgress(0), 500); };
    const onTitleUpdate = (e: unknown) => { setPageTitle((e as { title?: string }).title || ''); };
    const onNavigate = () => {
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
        const currentUrl = wv.getURL();
        if (currentUrl) {
          setUrl(currentUrl);
          setInputUrl(currentUrl);
          // 导航成功后清除导航目标引用，避免后续 onNavigate 误判
          currentNavUrlRef.current = currentUrl;
        }
        // 导航成功，清除错误状态
        setLoadError(null);
      } catch (err) {
        console.error('[BrowserPanel] 导航状态获取失败:', err);
      }
    };
    // 拦截新窗口请求，在当前 webview 中打开
    const onNewWindow = (e: unknown) => {
      const ev = e as { preventDefault: () => void; url?: string };
      ev.preventDefault();
      const newUrl = ev.url;
      if (newUrl) {
        setUrl(newUrl);
        setInputUrl(newUrl);
        if (domReadyRef.current && wv) {
          try { wv.loadURL(newUrl); } catch (err) { console.error('[BrowserPanel] 新窗口loadURL失败:', err); }
        } else {
          pendingUrlRef.current = newUrl;
        }
      }
    };
    // 加载失败处理
    const onLoadFail = (_e: unknown, errorCode: number = -1, errorDesc: string = '', validatedURL: string = '') => {
      console.error(`[BrowserPanel] Load failed: errorCode=${errorCode} desc=${errorDesc} URL=${validatedURL}`);
      // 修复双重导航：如果失败 URL 与当前导航目标一致，说明是真正的加载失败；
      // 如果不一致，可能是被后续导航取消的旧请求，忽略此错误
      if (validatedURL && currentNavUrlRef.current && validatedURL !== currentNavUrlRef.current) {
        console.log(`[BrowserPanel] 忽略旧导航的失败事件: ${validatedURL} (当前目标: ${currentNavUrlRef.current})`);
        return;
      }
      setLoading(false);
      setProgress(0);
      const code = errorCode != null ? errorCode : -1;
      // 提供更具体的错误描述
      let desc: string;
      switch (code) {
        case -1: desc = '连接被中止或请求被取消'; break;
        case -2: desc = '连接失败（网络不可达或服务器无响应）'; break;
        case -3: desc = 'URL 被拦截或 CSP 限制'; break;
        case -100: desc = '连接被拒绝'; break;
        case -101: desc = '连接被重置（服务器或网络中断）'; break;
        case -105: desc = 'DNS 解析失败（域名无法解析）'; break;
        case -118: desc = '连接超时（服务器未响应）'; break;
        case -106: desc = '网络连接已断开'; break;
        case -109: desc = '服务器地址不可达'; break;
        case -200: desc = '证书日期无效'; break;
        case -201: desc = '证书颁发机构不受信任'; break;
        case -202: desc = '证书域名不匹配'; break;
        case -301: desc = '重定向过多'; break;
        case -302: desc = '重定向地址无效'; break;
        case -310: desc = '重定向到不安全的 HTTP'; break;
        case -501: desc = '页面内容编码错误'; break;
        default: desc = errorDesc || '未知错误'; break;
      }
      const urlStr = validatedURL || url || '当前页面';
      // -3 通常是 CSP 或 X-Frame-Options 拦截
      if (code === -3) {
        setLoadError(`页面 ${urlStr} 拒绝在内嵌框架中显示（可能设置了 X-Frame-Options 或 CSP 限制）。可尝试在外部浏览器中打开。`);
      } else {
        setLoadError(`加载失败: ${desc} (代码 ${code})`);
      }
    };
    // webview 崩溃处理 - 记录详细系统状态
    const onCrashed = () => {
      logSystemState('Webview crashed (GPU/render process)');
      setLoadError('页面渲染进程崩溃，请刷新重试');
    };
    // 页面无响应处理 - 可能是黑屏前兆
    const onUnresponsive = () => {
      logSystemState('Webview unresponsive');
      console.warn('[BrowserPanel] 页面无响应，可能即将黑屏。建议刷新页面。');
    };
    const onResponsive = () => {
      console.log('[BrowserPanel] 页面已恢复响应');
    };
    // GPU 进程崩溃
    const onGpuCrashed = () => {
      logSystemState('GPU process crashed');
      setLoadError('GPU 进程崩溃，请刷新页面');
    };
    // DOM ready 事件 - webview 已准备好可以调用 loadURL
    const onDomReady = () => {
      domReadyRef.current = true;
      // 如果有等待加载的 URL，现在加载
      const pending = pendingUrlRef.current;
      if (pending && wv) {
        try { wv.loadURL(pending); } catch (e) { console.error('[BrowserPanel] 延迟加载URL失败:', e); }
        pendingUrlRef.current = null;
      }
    };

    wv.addEventListener('did-start-loading', onLoadStart);
    wv.addEventListener('did-frame-navigate', onNavigate);
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('load-progress', onLoadProgress);
    wv.addEventListener('did-stop-loading', onLoadStop);
    wv.addEventListener('page-title-updated', onTitleUpdate);
    wv.addEventListener('new-window', onNewWindow);
    wv.addEventListener('did-fail-load', onLoadFail);
    wv.addEventListener('crashed', onCrashed);
    wv.addEventListener('unresponsive', onUnresponsive);
    wv.addEventListener('responsive', onResponsive);
    wv.addEventListener('gpu-crashed', onGpuCrashed);
    wv.addEventListener('dom-ready', onDomReady);

    return () => {
      // 卸载时停止加载并清理所有事件监听，防止资源泄漏导致黑屏
      try {
        wv.stop();
        wv.removeEventListener('did-start-loading', onLoadStart);
        wv.removeEventListener('did-frame-navigate', onNavigate);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
        wv.removeEventListener('load-progress', onLoadProgress);
        wv.removeEventListener('did-stop-loading', onLoadStop);
        wv.removeEventListener('page-title-updated', onTitleUpdate);
        wv.removeEventListener('new-window', onNewWindow);
        wv.removeEventListener('did-fail-load', onLoadFail);
        wv.removeEventListener('crashed', onCrashed);
        wv.removeEventListener('unresponsive', onUnresponsive);
        wv.removeEventListener('responsive', onResponsive);
        wv.removeEventListener('gpu-crashed', onGpuCrashed);
        wv.removeEventListener('dom-ready', onDomReady);
      } catch (err) {
        console.error('[BrowserPanel] 清理 webview 事件失败:', err);
      }
    };
  }, []);

  const navigate = useCallback((targetUrl?: string) => {
    let target = (targetUrl || inputUrl).trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) {
      if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(target)) {
        target = 'https://' + target;
      } else {
        target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      }
    }
    // 修复双重导航：仅更新显示状态，不修改 webview src 属性
    // 导航完全通过 loadURL() 控制，避免 src 变更与 loadURL() 同时触发导致 did-fail-load
    setInputUrl(target);
    setLoadError(null);
    currentNavUrlRef.current = target;
    if (isElectron && webviewRef.current) {
      if (!domReadyRef.current) {
        // webview 还没准备好，将 URL 缓存，等 dom-ready 后自动加载
        pendingUrlRef.current = target;
      } else {
        try {
          webviewRef.current.loadURL(target);
        } catch (err) {
          console.error('[BrowserPanel] loadURL 调用失败:', err);
          pendingUrlRef.current = target;
        }
      }
    }
  }, [inputUrl]);

  // 监听外部导航请求（来自 Agent）
  useEffect(() => {
    if (navigateUrl) {
      navigate(navigateUrl);
    }
  }, [navigateUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBack = useCallback(() => {
    if (isElectron && webviewRef.current && webviewRef.current.canGoBack()) {
      webviewRef.current.goBack();
    }
  }, []);

  const handleForward = useCallback(() => {
    if (isElectron && webviewRef.current && webviewRef.current.canGoForward()) {
      webviewRef.current.goForward();
    }
  }, []);

  const handleReload = useCallback(() => {
    if (isElectron && webviewRef.current) {
      webviewRef.current.reload();
    }
  }, []);

  const toggleBookmark = useCallback(() => {
    const exists = bookmarks.find(b => b.url === url);
    if (exists) {
      setBookmarks(prev => prev.filter(b => b.url !== url));
    } else {
      setBookmarks(prev => [...prev, { id: `b_${Date.now()}`, title: pageTitle || url, url }]);
    }
  }, [bookmarks, url, pageTitle]);

  const isBookmarked = bookmarks.some(b => b.url === url);

  // ===== 非 Electron 环境 =====
  if (!isElectron) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, background: '#060d14' }}>
        <div style={{
          width: 72, height: 72, borderRadius: 18,
          background: 'rgba(16,185,129,.06)', border: '1px solid rgba(16,185,129,.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
          boxShadow: '0 0 24px rgba(16,185,129,.1)',
        }}>
          <Globe style={{ width: 32, height: 32, color: '#10b981' }} />
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 600, color: '#e2e8f0', margin: '0 0 8px' }}>浏览器功能</h3>
        <p style={{ fontSize: 14, color: '#64748b', margin: 0, textAlign: 'center', lineHeight: 1.6 }}>
          请在桌面应用中使用浏览器功能<br />
          <span style={{ fontSize: 12, color: '#475569' }}>需要 Electron 环境支持 webview 标签</span>
        </p>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#060d14' }}>
      {/* 顶部工具栏 - 玻璃态设计 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px',
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(16,185,129,.1)',
        flexShrink: 0,
      }}>
        {/* 导航按钮 */}
        <button onClick={handleBack} disabled={!canGoBack} style={{ ...navBtnStyle, opacity: canGoBack ? 1 : 0.3 }} title="后退">
          <ArrowLeft style={{ width: 15, height: 15 }} />
        </button>
        <button onClick={handleForward} disabled={!canGoForward} style={{ ...navBtnStyle, opacity: canGoForward ? 1 : 0.3 }} title="前进">
          <ArrowRight style={{ width: 15, height: 15 }} />
        </button>
        <button onClick={handleReload} style={navBtnStyle} title="刷新">
          <RotateCw style={{ width: 14, height: 14 }} />
        </button>

        {/* 地址栏 - 玻璃态 */}
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate(); }}
            placeholder="输入网址或搜索..."
            style={{
              width: '100%', padding: '7px 14px', fontSize: 13,
              background: 'rgba(16,185,129,.06)', border: '1px solid rgba(16,185,129,.12)',
              borderRadius: 10, outline: 'none', color: '#e2e8f0',
              fontFamily: 'inherit', boxSizing: 'border-box',
              transition: 'border-color .15s, box-shadow .15s',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.35)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(16,185,129,.08)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(16,185,129,.12)'; e.currentTarget.style.boxShadow = 'none'; }}
          />
          {loading && (
            <div style={{
              position: 'absolute', bottom: -1, left: 0, height: 2,
              width: `${progress}%`, background: 'linear-gradient(90deg, #10b981, #06b6d4)', borderRadius: 1,
              transition: 'width .2s',
            }} />
          )}
        </div>

        {/* 书签按钮 */}
        <button onClick={toggleBookmark} style={navBtnStyle} title={isBookmarked ? '移除书签' : '添加书签'}>
          {isBookmarked ? <Star style={{ width: 15, height: 15, color: '#f59e0b' }} /> : <StarOff style={{ width: 15, height: 15 }} />}
        </button>
        <button onClick={() => setShowBookmarks(!showBookmarks)} style={navBtnStyle} title="书签列表">
          <Plus style={{ width: 15, height: 15 }} />
        </button>
      </div>

      {/* 书签栏 - 玻璃态 */}
      {showBookmarks && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6,
          padding: '8px 12px',
          background: 'rgba(10, 14, 26, 0.75)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(16,185,129,.1)',
          flexShrink: 0,
        }}>
          {bookmarks.map((bm) => (
            <button
              key={bm.id}
              onClick={() => { setInputUrl(bm.url); navigate(bm.url); setShowBookmarks(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(16,185,129,.1)',
                background: 'rgba(16,185,129,.06)', cursor: 'pointer',
                fontSize: 12, color: '#94a3b8', fontFamily: 'inherit',
                transition: 'background .12s, color .12s, border-color .12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(16,185,129,.14)'; e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.borderColor = 'rgba(16,185,129,.25)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(16,185,129,.06)'; e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = 'rgba(16,185,129,.1)'; }}
            >
              <Star style={{ width: 10, height: 10, color: '#f59e0b' }} />
              {bm.title}
              <span
                onClick={(e) => { e.stopPropagation(); setBookmarks(prev => prev.filter(b => b.id !== bm.id)); }}
                style={{ display: 'inline-flex', cursor: 'pointer', marginLeft: 2 }}
              >
                <X style={{ width: 10, height: 10, color: '#64748b' }} />
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 主体 webview */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <webview
          ref={webviewRef}
          src="about:blank"
          style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#0a0e1a' }}
          allowpopups={true}
          partition="persist:browser"
          useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        />
        {/* 加载失败提示 */}
        {loadError && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(6,13,20,.95)', zIndex: 10,
          }}>
            <Globe style={{ width: 40, height: 40, color: '#ef4444', marginBottom: 16 }} />
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#e2e8f0', margin: '0 0 8px' }}>页面加载失败</h3>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 4px', maxWidth: 400, textAlign: 'center' }}>
              {loadError}
            </p>
            <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>
              {url !== 'about:blank' ? url : ''}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setLoadError(null); handleReload(); }}
                style={{
                  padding: '8px 20px', borderRadius: 8, border: 'none',
                  background: 'rgba(16,185,129,.15)', color: '#10b981',
                  cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <RotateCw style={{ width: 14, height: 14 }} />
                重试
              </button>
              {url !== 'about:blank' && isElectron && window.electronAPI?.shell?.openExternal && (
                <button
                  onClick={() => { try { void window.electronAPI?.shell?.openExternal?.(url); } catch { /* ignore */ } }}
                  style={{
                    padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(16,185,129,.2)',
                    background: 'transparent', color: '#94a3b8',
                    cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <Globe style={{ width: 14, height: 14 }} />
                  外部浏览器打开
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部状态栏 - 玻璃态 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px', height: 28,
        background: 'rgba(10, 14, 26, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(16,185,129,.1)',
        flexShrink: 0,
      }}>
        {loading && (
          <div style={{
            flex: 1, height: 2, borderRadius: 1,
            background: 'rgba(16,185,129,.1)', overflow: 'hidden',
          }}>
            <div style={{
              width: `${progress}%`, height: '100%',
              background: 'linear-gradient(90deg, #10b981, #06b6d4)',
              borderRadius: 1, transition: 'width .3s',
              boxShadow: '0 0 8px rgba(16,185,129,.4)',
            }} />
          </div>
        )}
        {!loading && (
          <>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: '#10b981',
              boxShadow: '0 0 6px rgba(16,185,129,.6)',
              animation: 'status-pulse 2s infinite',
            }} />
            <span style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pageTitle || url}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ===== 导航按钮样式 =====
const navBtnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, border: 'none',
  background: 'transparent', cursor: 'pointer', color: '#94a3b8',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, transition: 'background .15s, color .15s',
};
