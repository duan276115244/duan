import { useEffect, useRef, useState, useCallback } from 'react';

// V19 贾维斯增强：轻量级唤醒词检测
// 基于 webkitSpeechRecognition 持续监听，检测到唤醒词时触发回调
// 真正的离线唤醒词需要 snowboy/Porcupine，这里用浏览器 ASR 做轻量版

const WAKE_WORDS = ['段先生', '贾维斯', 'mr duan', 'jarvis'];

interface UseWakeWordOptions {
  enabled: boolean;          // 是否启用唤醒词检测
  onWake: () => void;        // 唤醒回调
  language?: string;         // 识别语言，默认 zh-CN
}

interface UseWakeWordReturn {
  listening: boolean;        // 是否正在监听
  error: string | null;      // 错误信息
  start: () => void;         // 开始监听
  stop: () => void;          // 停止监听
}

/**
 * V19 贾维斯增强：唤醒词检测 Hook
 *
 * 使用浏览器 SpeechRecognition 持续监听，识别到唤醒词（"段先生"/"贾维斯"/"Mr. Duan"/"Jarvis"）
 * 时调用 onWake 回调。识别结束后自动重启，保持持续监听。
 *
 * 注意：浏览器 SpeechRecognition 依赖在线服务（Google），并非离线唤醒词方案。
 * 真正的离线唤醒词检测建议后续接入 Porcupine/Vosk。
 */
export function useWakeWord({ enabled, onWake, language = 'zh-CN' }: UseWakeWordOptions): UseWakeWordReturn {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const onWakeRef = useRef(onWake);
  const enabledRef = useRef(enabled);

  // 保持回调最新，避免闭包过期
  useEffect(() => { onWakeRef.current = onWake; }, [onWake]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const start = useCallback(() => {
    if (!enabledRef.current) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError('浏览器不支持 SpeechRecognition，无法使用唤醒词');
      return;
    }
    if (recognitionRef.current) return; // 已在监听

    try {
      const recognition = new SR();
      recognition.lang = language;
      recognition.continuous = true;     // 持续监听
      recognition.interimResults = true; // 实时结果
      recognition.maxAlternatives = 3;

      recognition.onresult = (event: any) => {
        // 检查最近的识别结果是否包含唤醒词
        try {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
              const transcript = result[0].transcript.toLowerCase().trim();
              for (const wakeWord of WAKE_WORDS) {
                if (transcript.includes(wakeWord.toLowerCase())) {
                  onWakeRef.current();
                  break;
                }
              }
            }
          }
        } catch {}
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return; // 忽略正常事件
        setError(`唤醒词识别错误: ${event.error}`);
      };

      recognition.onend = () => {
        // 自动重启（如果仍启用）
        if (enabledRef.current) {
          try {
            recognition.start();
            setListening(true);
          } catch {
            // 重启失败，可能是因为立即重启冲突，延迟后重试
            setTimeout(() => {
              if (enabledRef.current && recognitionRef.current === recognition) {
                try { recognition.start(); setListening(true); } catch {}
              }
            }, 300);
          }
        } else {
          setListening(false);
        }
      };

      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
      setError(null);
    } catch (e: any) {
      setError(`启动唤醒词检测失败: ${e?.message || String(e)}`);
    }
  }, [language]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.onend = null; // 防止自动重启
        recognition.stop();
      } catch {}
      recognitionRef.current = null;
    }
    setListening(false);
  }, []);

  // enabled 变化时启停
  useEffect(() => {
    if (enabled) {
      start();
    } else {
      stop();
    }
    return () => { stop(); };
  }, [enabled, start, stop]);

  return { listening, error, start, stop };
}
