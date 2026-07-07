import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * 流式 ASR Hook — 基于 Web Speech API 的连续实时语音识别
 *
 * 对标 OpenAI Realtime / Deepgram 流式 ASR 的用户体验：
 * - 边说边转写（interimResults=true）：用户说话过程中实时显示部分识别结果
 * - 连续识别（continuous=true）：识别到一句话后不停止，继续监听下一句
 * - 自动重启：浏览器 Web Speech API 会在静音后自动停止，onend 时自动重启
 * - 多语言支持：默认 zh-CN，可切换
 *
 * 与原 VoiceInput 的 IPC record 模式对比：
 * - IPC record 模式：PyAudio 录音 → 整段上传 → Google API 一次性转写（延迟高，无 interim）
 * - 流式模式：浏览器原生 SpeechRecognition → 实时 interim 回调（延迟低，体验好）
 *
 * 降级策略：
 * - 浏览器不支持 webkitSpeechRecognition → 返回 supported=false，调用方应 fallback 到 IPC record
 * - 网络异常或识别失败 → onError 回调，调用方可 fallback
 */
export interface StreamingASROptions {
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
  maxAlternatives?: number;
  /** 是否在 onend 时自动重启（默认 true，连续对话场景需要） */
  autoRestart?: boolean;
  /** 唤醒词列表 — 当 interim/final 文本包含任一唤醒词时触发 onWake 回调 */
  wakeWords?: string[];
}

export interface StreamingASRState {
  supported: boolean;
  isListening: boolean;
  /** 当前 interim 文本（未最终确认的部分） */
  interimText: string;
  /** 已最终确认的文本（累加） */
  finalText: string;
  error?: string;
}

export interface StreamingASRHandlers {
  onFinal?: (text: string, allText: string) => void;
  onInterim?: (interim: string, allText: string) => void;
  onError?: (error: string) => void;
  onStateChange?: (listening: boolean) => void;
  /** 唤醒词检测回调 — 当识别到唤醒词时触发（对标 Alexa/Google Assistant 唤醒） */
  onWake?: (wakeWord: string, fullText: string) => void;
}

/**
 * 检测浏览器是否支持 Web Speech API
 */
function detectSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false;
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/**
 * 流式 ASR Hook
 *
 * 使用示例：
 * ```tsx
 * const asr = useStreamingASR({
 *   onFinal: (text) => sendMessage(text),
 *   onInterim: (interim) => setDisplayText(interim),
 * });
 *
 * <button onClick={() => asr.start()}>开始</button>
 * <button onClick={() => asr.stop()}>停止</button>
 * <p>{asr.interimText}</p>
 * ```
 */
export function useStreamingASR(
  options: StreamingASROptions = {},
  handlers: StreamingASRHandlers = {},
) {
  const {
    language = 'zh-CN',
    continuous = true,
    interimResults = true,
    maxAlternatives = 1,
    autoRestart = true,
    wakeWords,
  } = options;

  const [supported] = useState<boolean>(detectSpeechRecognition);
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const recognitionRef = useRef<any>(null);
  const shouldRestartRef = useRef(false);
  const finalTextRef = useRef('');

  // 保持 handlers 最新（避免闭包过期）
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; }, [handlers]);
  const optionsRef = useRef({ language, continuous, interimResults, maxAlternatives, autoRestart, wakeWords });
  useEffect(() => {
    optionsRef.current = { language, continuous, interimResults, maxAlternatives, autoRestart, wakeWords };
  }, [language, continuous, interimResults, maxAlternatives, autoRestart, wakeWords]);

  const start = useCallback(() => {
    if (!supported) {
      const msg = '浏览器不支持 Web Speech API，请使用 Chrome/Edge 或降级到录音模式';
      setError(msg);
      handlersRef.current.onError?.(msg);
      return;
    }
    if (recognitionRef.current) {
      // 已在监听，先停止再重启（避免重复实例）
      try { recognitionRef.current.stop(); } catch {}
    }

    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = optionsRef.current.language;
    recognition.continuous = optionsRef.current.continuous;
    recognition.interimResults = optionsRef.current.interimResults;
    recognition.maxAlternatives = optionsRef.current.maxAlternatives;

    recognition.onstart = () => {
      setIsListening(true);
      setError(undefined);
      shouldRestartRef.current = optionsRef.current.autoRestart;
      handlersRef.current.onStateChange?.(true);
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';
      // 遍历所有结果，区分 final 和 interim
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || '';
        if (result.isFinal) {
          finalChunk += transcript;
        } else {
          interim += transcript;
        }
      }

      if (finalChunk) {
        finalTextRef.current += finalChunk;
        setFinalText(finalTextRef.current);
        setInterimText('');
        handlersRef.current.onFinal?.(finalChunk, finalTextRef.current);
      }
      if (interim) {
        setInterimText(interim);
        handlersRef.current.onInterim?.(interim, finalTextRef.current);
      }

      // 唤醒词检测 — 检查 interim 和 final 文本是否包含任一唤醒词
      const wakeWordList = optionsRef.current.wakeWords;
      if (wakeWordList && wakeWordList.length > 0 && handlersRef.current.onWake) {
        const fullText = finalTextRef.current + interim;
        const lowerFull = fullText.toLowerCase();
        for (const word of wakeWordList) {
          const lowerWord = word.toLowerCase();
          if (lowerFull.includes(lowerWord)) {
            handlersRef.current.onWake(word, fullText);
            break; // 只触发一次
          }
        }
      }
    };

    recognition.onerror = (event: any) => {
      const errType = event?.error || 'unknown';
      // no-speech 和 aborted 是正常情况，不视为错误
      if (errType === 'no-speech' || errType === 'aborted') {
        return;
      }
      // not-allowed / service-not-allowed 是权限问题，停止重启
      if (errType === 'not-allowed' || errType === 'service-not-allowed') {
        shouldRestartRef.current = false;
        const msg = '麦克风权限被拒绝，请在浏览器设置中允许';
        setError(msg);
        handlersRef.current.onError?.(msg);
        return;
      }
      // network 错误：保持重启标志，让 onend 尝试恢复
      if (errType === 'network') {
        const msg = '网络错误，正在尝试重连...';
        setError(msg);
        handlersRef.current.onError?.(msg);
        return;
      }
      const msg = `识别错误: ${errType}`;
      setError(msg);
      handlersRef.current.onError?.(msg);
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimText('');
      handlersRef.current.onStateChange?.(false);
      // 自动重启（连续对话场景）
      if (shouldRestartRef.current && optionsRef.current.autoRestart) {
        try {
          recognition.start();
          setIsListening(true);
        } catch {
          // 重启失败（可能是频繁重启），稍后重试
          setTimeout(() => {
            if (shouldRestartRef.current) {
              try {
                recognition.start();
                setIsListening(true);
              } catch {}
            }
          }, 300);
        }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (e) {
      const msg = `启动识别失败: ${(e as Error).message}`;
      setError(msg);
      handlersRef.current.onError?.(msg);
    }
  }, [supported]);

  const stop = useCallback(() => {
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
    setIsListening(false);
    setInterimText('');
  }, []);

  const reset = useCallback(() => {
    finalTextRef.current = '';
    setFinalText('');
    setInterimText('');
    setError(undefined);
  }, []);

  // 卸载时清理
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
      }
    };
  }, []);

  return {
    supported,
    isListening,
    interimText,
    finalText,
    error,
    start,
    stop,
    reset,
  };
}
