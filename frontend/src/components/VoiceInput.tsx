import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  /** ASR 失败回调（用于错误恢复，如自动回到监听状态） */
  onError?: (error: string) => void;
  disabled?: boolean;
  language?: string;
  /** 是否自动开始监听（用于连续对话模式） */
  autoStart?: boolean;
}

export interface VoiceInputHandle {
  /** 程序化启动监听（用于连续对话模式自动启动） */
  startListening: () => void;
  /** 程序化停止监听 */
  stopListening: () => void;
}

interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultLike[];
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

/**
 * 语音输入组件
 *
 * 三种识别方案（按优先级）：
 * 1. Electron + Python PyAudio 直录（最可靠）：通过 IPC voice:transcribe record 模式，
 *    后端直接用 PyAudio 录音 + Google Web Speech API 转写，无需格式转换
 * 2. MediaRecorder + 后端 ASR：浏览器录音后上传，需要 ffmpeg 转换格式
 * 3. 浏览器 Web Speech API：webkitSpeechRecognition，依赖 Google 在线服务
 *
 * 支持通过 ref 程序化控制 startListening/stopListening，用于贾维斯连续对话模式
 */
export const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput(
  { onTranscript, onError, disabled = false, language = 'zh-CN', autoStart = false },
  ref
) {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const electronRecordingRef = useRef(false);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 保存最新的回调到 ref，避免闭包过期
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // 方案 1（Electron 优先）：直接调用 IPC record 模式（PyAudio 直录，最可靠）
  const startElectronRecord = useCallback(async () => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (!isE) return false;

    const api = window.electronAPI;
    if (!api?.voice?.transcribe) return false;

    try {
      electronRecordingRef.current = true;
      setIsListening(true);
      setRecordingTime(0);
      setInterimText('正在聆听... 点击麦克风可提前停止');

      // 启动录音计时器
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

      // 调用后端 record 模式：PyAudio 录音 + Google 转写
      // 录音会在检测到 0.8 秒静音后自动停止，或达到 maxDuration
      const result = await api.voice.transcribe({
        record: true,
        maxDuration: 30,
        silenceTimeout: 0.8,
      });

      // 停止计时器
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      electronRecordingRef.current = false;
      setIsListening(false);
      setRecordingTime(0);
      setInterimText('');

      if (result?.success && result.text) {
        onTranscriptRef.current(result.text);
      } else if (result && !result.success) {
        // 识别失败，通知父组件（用于错误恢复）
        onErrorRef.current?.(result.error || '识别失败');
        setInterimText(result.error || '识别失败');
        setTimeout(() => setInterimText(''), 3000);
      }
      return true;
    } catch {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      electronRecordingRef.current = false;
      setIsListening(false);
      setRecordingTime(0);
      setInterimText('');
      return false;
    }
  }, []);

  // 方案 2：MediaRecorder + 后端 ASR（Web 模式或 Electron 回退）
  const startBackendASR = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && chunksRef.current) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;

        const audioBlob = new Blob(chunksRef.current || [], { type: mimeType });
        if (audioBlob.size === 0) { setIsProcessing(false); return; }
        setIsProcessing(true);

        try {
          // Web 模式：直接上传到 Agent 服务器
          const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
          const res = await fetch(`/api/voice/transcribe?format=${ext}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: audioBlob,
          });
          const data = await res.json();

          if (data?.success && data.text) {
            onTranscriptRef.current(data.text);
          } else if (data && !data.success) {
            throw new Error(data.error || data.message || '识别失败');
          }
        } catch {
          setInterimText('语音识别失败，尝试浏览器识别...');
          setTimeout(() => {
            setInterimText('');
            startBrowserASR();
          }, 1000);
        } finally {
          setIsProcessing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
    } catch {
      startBrowserASR();
    }
  }, []);

  // 方案 3：浏览器 Web Speech API（作为最后回退）
  const startBrowserASR = useCallback(() => {
    const win = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setInterimText('浏览器不支持语音识别');
      setTimeout(() => setInterimText(''), 2000);
      return;
    }

    try {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch { /* ignore */ }
      }

      const recognition = new SpeechRecognition();
      recognition.lang = language;
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) final += transcript;
          else interim += transcript;
        }
        if (final) {
          onTranscriptRef.current(final);
          setInterimText('');
        } else {
          setInterimText(interim);
        }
      };

      recognition.onerror = (event: { error: string }) => {
        setIsListening(false);
        setInterimText('');
        if (event.error === 'network' || event.error === 'service-not-allowed' || event.error === 'not-allowed') {
          const errMsg = '浏览器语音识别不可用，请检查网络或麦克风权限';
          onErrorRef.current?.(errMsg);
          setInterimText(errMsg);
          setTimeout(() => setInterimText(''), 3000);
        } else {
          onErrorRef.current?.('语音识别出错: ' + (event.error || '未知错误'));
        }
      };
      recognition.onend = () => {
        setIsListening(false);
        setInterimText('');
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
    } catch {
      setInterimText('无法启动语音识别');
      setTimeout(() => setInterimText(''), 2000);
    }
  }, [language]);

  const startListening = useCallback(async () => {
    if (disabled || isProcessing) return;

    const isE = typeof window !== 'undefined' && !!window.electronAPI;

    // 优先级 1：Electron 模式使用 PyAudio 直录（最可靠，无需格式转换）
    if (isE) {
      const ok = await startElectronRecord();
      if (ok) return;
    }

    // 优先级 2：MediaRecorder + 后端 ASR
    if (typeof MediaRecorder !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      startBackendASR();
    } else {
      // 优先级 3：浏览器 Web Speech API
      startBrowserASR();
    }
  }, [disabled, isProcessing, startElectronRecord, startBackendASR, startBrowserASR]);

  const stopListening = useCallback(() => {
    // Electron record 模式：通过 IPC 发送停止信号（优雅停止，能转写已录内容）
    if (electronRecordingRef.current) {
      const api = window.electronAPI;
      if (api?.voice?.stopRecording) {
        setInterimText('正在停止录音并识别...');
        api.voice.stopRecording().catch(() => { /* ignore */ });
      }
      return;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsListening(false);
    } else if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      setIsListening(false);
      setInterimText('');
    }
  }, []);

  useImperativeHandle(ref, () => ({
    startListening,
    stopListening,
  }), [startListening, stopListening]);

  // 自动开始监听（连续对话模式）
  useEffect(() => {
    if (autoStart && !disabled && !isListening && !isProcessing) {
      const timer = setTimeout(() => startListening(), 300);
      return () => clearTimeout(timer);
    }
  }, [autoStart, disabled, isListening, isProcessing, startListening]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={isListening ? stopListening : startListening}
        disabled={disabled || isProcessing}
        title={isProcessing ? '识别中...' : isListening ? `录音中 ${recordingTime}s — 点击停止` : '语音输入'}
        style={{
          width: 32, height: 32, borderRadius: '50%',
          border: isListening ? '1px solid rgba(239,68,68,.4)' : '1px solid rgba(6,182,212,.2)',
          cursor: (disabled || isProcessing) ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isListening ? 'rgba(239,68,68,.12)' : 'rgba(6,182,212,.06)',
          color: isListening ? '#ef4444' : '#06b6d4',
          transition: 'all .2s',
          boxShadow: isListening ? '0 0 12px rgba(239,68,68,.3)' : 'none',
          animation: isListening ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }}
        onMouseEnter={(e) => {
          if (!disabled && !isProcessing && !isListening) {
            e.currentTarget.style.background = 'rgba(6,182,212,.15)';
            e.currentTarget.style.boxShadow = '0 0 14px rgba(6,182,212,.3)';
            e.currentTarget.style.borderColor = 'rgba(6,182,212,.4)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isListening) {
            e.currentTarget.style.background = 'rgba(6,182,212,.06)';
            e.currentTarget.style.boxShadow = 'none';
            e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)';
          }
        }}
      >
        {isProcessing
          ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
          : isListening
            ? <MicOff style={{ width: 14, height: 14 }} />
            : <Mic style={{ width: 14, height: 14 }} />}
      </button>
      {(interimText || isProcessing || (isListening && recordingTime > 0)) && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 8, padding: '6px 12px', borderRadius: 8,
          background: isListening ? 'rgba(239,68,68,.1)' : 'rgba(6,182,212,.1)',
          border: isListening ? '1px solid rgba(239,68,68,.2)' : '1px solid rgba(6,182,212,.2)',
          color: isListening ? '#fca5a5' : '#67e8f9', fontSize: 12, whiteSpace: 'nowrap', maxWidth: 300,
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {isProcessing ? '识别中...' : isListening && recordingTime > 0 ? (
            <>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#ef4444',
                animation: 'pulse 1s ease-in-out infinite',
              }} />
              {interimText || `录音中 ${recordingTime}s`}
            </>
          ) : interimText}
        </div>
      )}
    </div>
  );
});
