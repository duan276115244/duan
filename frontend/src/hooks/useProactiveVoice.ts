import { useEffect, useRef } from 'react';

/**
 * 主动发声钩子（4.2 从 desktop/index.html 迁移而来）
 *
 * 背景：main.js:2125 在收到 Agent 的 `proactive_announcement` 事件时，会通过
 * `mainWindow.webContents.send('voice:proactive-announce', ...)` 推送给渲染进程。
 * 原监听逻辑写在 desktop/index.html，但该文件从不被 Electron 加载（main 进程
 * 加载的是 frontend/dist/index.html），导致主动发声功能完全失效。
 *
 * 本 hook 在 React 应用内订阅该 IPC 事件，并用 Web Speech API 进行 TTS 播报，
 * 同时尊重用户在语音设置中的 enabled 开关。
 *
 * severity 语义：info 正常语速；warn/error 略慢以引起注意。
 */
export function useProactiveVoice(): void {
  // 缓存语音配置，避免每次播报都重新加载
  const enabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.voice?.onProactiveAnnounce) return;

    // 首次订阅时拉取一次语音开关（避免每次播报都 IPC 往返）
    api.voice.load?.().then((cfg: { enabled?: boolean } | undefined) => {
      enabledRef.current = cfg?.enabled ?? false;
    }).catch(() => {
      enabledRef.current = false;
    });

    const unsubscribe = api.voice.onProactiveAnnounce((data) => {
      try {
        if (!data || !data.text) return;
        // 用户未启用语音输出则跳过
        if (enabledRef.current === false) return;
        if (!('speechSynthesis' in window)) return;

        const utterance = new SpeechSynthesisUtterance(data.text);
        utterance.lang = 'zh-CN';
        // warn/error 略慢以引起注意
        if (data.severity === 'warn' || data.severity === 'error') {
          utterance.rate = 0.9;
        }
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch {
        // TTS 失败不应影响主流程，静默吞错
      }
    });

    return () => { unsubscribe?.(); };
  }, []);
}
