import { useState, useCallback, useRef, useEffect } from 'react';
import { Volume2, VolumeX, Sparkles, X, Square, Mic } from 'lucide-react';
import { VoiceInput, type VoiceInputHandle } from './VoiceInput';
import { VoiceOutput, type VoiceOutputHandle } from './VoiceOutput';
import { useWakeWord } from '../hooks/useWakeWord';
import { useStreamingASR } from '../hooks/useStreamingASR';
import { useVoiceEmotion, EMOTION_EMOJI, EMOTION_LABELS } from '../hooks/useVoiceEmotion';

interface JarvisModeProps {
  /** 最后一条助手消息（用于非流式播报兜底） */
  lastAssistantMessage: string;
  /** 发送消息回调 */
  onSend: (text: string) => void;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 流式输出的实时文本（用于流式分句 TTS） */
  streamingText?: string;
}

/** 句子分隔符正则：中文句号、问号、感叹号、英文对应符号、换行 */
const SENTENCE_END = /[。！？!?\n]/;

/**
 * 将文本按句子分割，返回完整句子数组
 * 仅返回以分隔符结尾的"完整句子"，最后一段不完整的文本不返回（等后续补全）
 */
function extractCompleteSentences(text: string, alreadySpoken: number): { sentences: string[]; newOffset: number } {
  const sentences: string[] = [];
  let pos = alreadySpoken;
  while (pos < text.length) {
    const remaining = text.substring(pos);
    const match = remaining.match(SENTENCE_END);
    if (match && match.index !== undefined) {
      const endIdx = match.index + match[0].length;
      const sentence = remaining.substring(0, endIdx).trim();
      if (sentence) sentences.push(sentence);
      pos += endIdx;
    } else {
      break; // 没有找到句子分隔符，等待更多文本
    }
  }
  return { sentences, newOffset: pos };
}

/**
 * 贾维斯模式 — 多模态交互面板
 *
 * 整合语音输入（ASR）和语音输出（TTS），实现接近"现实版贾维斯"的交互体验：
 * - 语音优先：点击麦克风按钮开始语音输入
 * - 流式播报：AI 回复时边生成边播报（分句 TTS），大幅减少等待时间
 * - 连续对话：播报结束后自动进入监听状态，实现免手连续对话
 * - 打断机制：播报过程中用户可以点击麦克风打断并开始新的对话
 * - 错误恢复：ASR/TTS 失败后自动回到监听状态，不会卡死
 *
 * 对话循环：listen → transcribe → send → stream response → TTS speak (streaming) → re-listen
 */
export function JarvisMode({ lastAssistantMessage, onSend, isStreaming, streamingText }: JarvisModeProps) {
  const [isActive, setIsActive] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [continuousMode, setContinuousMode] = useState(true);
  const [textInput, setTextInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const voiceInputRef = useRef<VoiceInputHandle>(null);
  const voiceOutputRef = useRef<VoiceOutputHandle>(null);
  const lastSpokenRef = useRef<string>('');

  // 流式 TTS 状态
  const spokenOffsetRef = useRef(0);        // 已发送到 TTS 的文本偏移量
  const sentenceQueueRef = useRef<string[]>([]); // 待播报的句子队列
  const isSpeakingSentenceRef = useRef(false);   // 当前是否有句子正在播报
  const streamingTextRef = useRef('');      // 最新的流式文本
  const statusRef = useRef(status);
  const autoSpeakRef = useRef(autoSpeak);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { autoSpeakRef.current = autoSpeak; }, [autoSpeak]);

  // V19 贾维斯增强：状态持久化 — 刷新页面后保留 isActive/continuousMode/autoSpeak
  const JARVIS_STORAGE_KEY = 'duan-jarvis-state';
  // 启动时恢复状态（仅执行一次）
  useEffect(() => {
    try {
      const saved = localStorage.getItem(JARVIS_STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved) as { isActive?: boolean; continuousMode?: boolean; autoSpeak?: boolean };
        if (state.continuousMode !== undefined) setContinuousMode(state.continuousMode);
        if (state.autoSpeak !== undefined) setAutoSpeak(state.autoSpeak);
        // 恢复激活态时同步进入监听，与 handleActivate 行为一致
        if (state.isActive) {
          setIsActive(true);
          setStatus('listening');
        }
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 状态变化时保存
  useEffect(() => {
    try {
      localStorage.setItem(JARVIS_STORAGE_KEY, JSON.stringify({ isActive, continuousMode, autoSpeak }));
    } catch { /* ignore */ }
  }, [isActive, continuousMode, autoSpeak]);

  // V19 贾维斯增强：唤醒词检测 — 语音说"段先生"/"贾维斯"即可激活，无需手动点击
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const { listening: wakeListening, error: wakeError } = useWakeWord({
    enabled: wakeWordEnabled,
    onWake: () => {
      try {
        if (!isActive) {
          setIsActive(true);
          setStatus('listening');
        }
      } catch { /* ignore */ }
    },
  });

  // V19 流式 ASR 增强：浏览器原生 Web Speech API 边说边转写
  // 对标 Deepgram/OpenAI Realtime 的实时 interim 体验，无需等待静音才停止
  // supported=false 时降级到原 VoiceInput 的 IPC record 模式
  // 注意：onFinal 通过 ref 调用 handleTranscript，避免 hook 顺序依赖
  const handleTranscriptRef = useRef<(text: string) => void>(() => {});
  const streamingASR = useStreamingASR(
    { language: 'zh-CN', continuous: false, interimResults: true, autoRestart: false },
    {
      onFinal: (text) => {
        if (text.trim()) handleTranscriptRef.current(text.trim());
      },
      onInterim: () => {
        // interimText 由 hook 内部 state 驱动渲染，无需在此处理
      },
      onError: (err) => {
        // 流式 ASR 失败时回退到 VoiceInput
        console.warn('[JarvisMode] 流式 ASR 失败，回退到 VoiceInput:', err);
      },
    },
  );

  // V19 语音情感识别：与流式 ASR 并行运行，实时分析麦克风音频的情感特征
  // 对标 Hume AI — 在聆听阶段采集声学特征（音量/频率中心），映射到 7 类情感
  // enabled 仅在 listening 状态触发，避免 thinking/speaking 阶段误分析 TTS 输出
  const voiceEmotion = useVoiceEmotion({
    enabled: isActive && status === 'listening',
  });

  // 当流式 ASR 可用且状态为 listening 时，启动流式识别（替代 VoiceInput）
  useEffect(() => {
    if (!streamingASR.supported) return; // 不支持则保持原 VoiceInput 逻辑
    if (status === 'listening' && isActive && !isStreaming) {
      streamingASR.reset();
      const timer = setTimeout(() => streamingASR.start(), 100);
      return () => clearTimeout(timer);
    } else if (status !== 'listening') {
      streamingASR.stop();
    }
  }, [status, isActive, isStreaming, streamingASR.supported]);

  // 流式分句 TTS：监控 streamingText 变化，提取新完成的句子加入队列
  useEffect(() => {
    if (!isActive || !autoSpeak || !streamingText) return;
    streamingTextRef.current = streamingText;

    // 提取新的完整句子
    const { sentences, newOffset } = extractCompleteSentences(streamingText, spokenOffsetRef.current);
    if (sentences.length > 0) {
      spokenOffsetRef.current = newOffset;
      sentenceQueueRef.current.push(...sentences);
      // 如果当前没在播报，开始播报队列中的第一句
      if (!isSpeakingSentenceRef.current && statusRef.current !== 'idle') {
        playNextSentence();
      }
    }
  }, [streamingText, isActive, autoSpeak]);

  // 播报队列中的下一句
  const playNextSentence = useCallback(() => {
    if (sentenceQueueRef.current.length === 0) {
      isSpeakingSentenceRef.current = false;
      // 队列为空，检查是否流式已结束
      if (!isStreaming && statusRef.current === 'speaking') {
        // 流式已结束且队列空，播报完成
        if (continuousMode && isActive) {
          setStatus('listening');
        } else {
          setStatus('idle');
        }
      }
      return;
    }
    const sentence = sentenceQueueRef.current.shift()!;
    isSpeakingSentenceRef.current = true;
    setStatus('speaking');
    // 通过 VoiceOutput 播报这一句
    // 使用一个临时的 VoiceOutput 实例，通过 key 强制重新挂载
    setCurrentSentence(sentence);
  }, [isStreaming, continuousMode, isActive]);

  const [currentSentence, setCurrentSentence] = useState('');

  // 单句播报结束回调
  const handleSentenceEnded = useCallback(() => {
    isSpeakingSentenceRef.current = false;
    // 播报下一句
    playNextSentence();
  }, [playNextSentence]);

  // 流式输出结束后，处理剩余文本（最后可能有一句不完整的）
  useEffect(() => {
    if (!isStreaming && status === 'thinking' && isActive && autoSpeak) {
      // 流式结束，把剩余未播报的文本加入队列
      const fullText = streamingTextRef.current || lastAssistantMessage;
      if (fullText && spokenOffsetRef.current < fullText.length) {
        const remaining = fullText.substring(spokenOffsetRef.current).trim();
        if (remaining) {
          sentenceQueueRef.current.push(remaining);
          spokenOffsetRef.current = fullText.length;
        }
      }
      // 如果队列有内容，开始播报；否则直接进入下一轮监听
      if (sentenceQueueRef.current.length > 0) {
        playNextSentence();
      } else if (!isSpeakingSentenceRef.current) {
        // 没有内容需要播报，直接回到监听
        if (continuousMode && isActive) {
          setStatus('listening');
        } else {
          setStatus('idle');
        }
      }
    }
  }, [isStreaming, status, isActive, autoSpeak, lastAssistantMessage, playNextSentence]);

  // 非流式模式兜底：如果有 lastAssistantMessage 但没有 streamingText
  useEffect(() => {
    if (!isActive || !autoSpeak || !lastAssistantMessage || isStreaming) return;
    if (streamingText) return; // 流式模式已处理
    if (lastSpokenRef.current === lastAssistantMessage) return;
    lastSpokenRef.current = lastAssistantMessage;
    // 直接播报完整消息
    sentenceQueueRef.current.push(lastAssistantMessage);
    setStatus('speaking');
    playNextSentence();
  }, [isActive, autoSpeak, lastAssistantMessage, isStreaming, streamingText, playNextSentence]);

  // 语音输入回调
  const handleTranscript = useCallback((text: string) => {
    if (!text.trim()) return;
    // 如果正在播报，先停止 TTS 并清空队列
    if (voiceOutputRef.current) {
      voiceOutputRef.current.stop();
    }
    sentenceQueueRef.current = [];
    isSpeakingSentenceRef.current = false;
    spokenOffsetRef.current = 0;
    lastSpokenRef.current = '';
    setStatus('thinking');
    onSend(text);
  }, [onSend]);

  // 同步 handleTranscript 到 ref，供流式 ASR 的 onFinal 回调使用
  useEffect(() => {
    handleTranscriptRef.current = handleTranscript;
  }, [handleTranscript]);

  // ASR 错误回调：自动回到监听状态（连续模式）或待命
  const handleASRError = useCallback((_error: string) => {
    // 如果正在思考或播报，不打断
    if (statusRef.current === 'thinking' || statusRef.current === 'speaking') return;
    // 连续模式下自动回到监听，给用户重试的机会
    if (continuousMode && isActive) {
      setTimeout(() => {
        setStatus('listening');
      }, 800);  // 从 1.5s 降到 0.8s，减少重试延迟
    } else {
      setStatus('idle');
    }
  }, [continuousMode, isActive]);

  // 当状态变为 listening 时，通过 ref 启动 VoiceInput 监听
  // 注意：流式 ASR 可用时由上面的 useEffect 启动，此处跳过避免双重监听
  useEffect(() => {
    if (streamingASR.supported) return; // 流式 ASR 已接管监听
    if (status === 'listening' && isActive && !isStreaming && voiceInputRef.current) {
      const timer = setTimeout(() => {
        voiceInputRef.current?.startListening();
      }, 100);  // 从 200ms 降到 100ms，加快监听启动
      return () => clearTimeout(timer);
    }
  }, [status, isActive, isStreaming, streamingASR.supported]);

  // 激活贾维斯模式
  const handleActivate = useCallback(() => {
    setIsActive(true);
    setStatus('listening');
  }, []);

  // 关闭贾维斯模式
  const handleDeactivate = useCallback(() => {
    voiceInputRef.current?.stopListening();
    streamingASR.stop();
    if (voiceOutputRef.current) {
      voiceOutputRef.current.stop();
    }
    sentenceQueueRef.current = [];
    isSpeakingSentenceRef.current = false;
    spokenOffsetRef.current = 0;
    lastSpokenRef.current = '';
    setIsActive(false);
    setStatus('idle');
  }, [streamingASR]);

  // 手动停止播报
  const handleStopSpeaking = useCallback(() => {
    if (voiceOutputRef.current) {
      voiceOutputRef.current.stop();
    }
    sentenceQueueRef.current = [];
    isSpeakingSentenceRef.current = false;
    if (continuousMode && isActive) {
      setStatus('listening');
    } else {
      setStatus('idle');
    }
  }, [continuousMode, isActive]);

  // 开始说话时打断 TTS（barge-in）
  const handleStartListening = useCallback(() => {
    if (statusRef.current === 'speaking' && voiceOutputRef.current) {
      voiceOutputRef.current.stop();
      sentenceQueueRef.current = [];
      isSpeakingSentenceRef.current = false;
    }
  }, []);

  if (!isActive) {
    return (
      <button
        onClick={handleActivate}
        title="贾维斯语音对话模式"
        style={{
          width: 32, height: 32, borderRadius: '50%', border: '1px solid rgba(139,92,246,.25)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(139,92,246,.08)',
          color: '#a78bfa', transition: 'all .2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(139,92,246,.18)'; e.currentTarget.style.boxShadow = '0 0 14px rgba(139,92,246,.35)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,.5)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(139,92,246,.08)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = 'rgba(139,92,246,.25)'; }}
      >
        <Sparkles size={14} />
      </button>
    );
  }

  const statusText = {
    idle: '待命中',
    listening: '正在聆听...',
    thinking: '思考中...',
    speaking: '回答中...',
  }[status];

  const statusColor = {
    idle: '#64748b',
    listening: '#10b981',
    thinking: '#f59e0b',
    speaking: '#8b5cf6',
  }[status];

  return (
    <div style={{
      position: 'fixed', bottom: 80, right: 24, zIndex: 1000,
      background: 'rgba(15,23,42,.95)', backdropFilter: 'blur(12px)',
      border: '1px solid rgba(139,92,246,.2)', borderRadius: 16,
      padding: 16, minWidth: 320, maxWidth: 400,
      boxShadow: '0 8px 32px rgba(0,0,0,.4)',
    }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: statusColor, boxShadow: `0 0 8px ${statusColor}`,
            animation: status !== 'idle' ? 'pulse 1.5s infinite' : 'none',
          }} />
          <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500 }}>J.A.R.V.I.S.</span>
          <span style={{ color: statusColor, fontSize: 11 }}>{statusText}</span>
          {voiceEmotion.emotion && voiceEmotion.emotion.emotion !== 'neutral' && (
            <span
              title={`情感强度 ${Math.round(voiceEmotion.emotion.intensity * 100)}% / 音量 ${Math.round(voiceEmotion.emotion.volume * 100)}%`}
              style={{ color: '#a78bfa', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}
            >
              {EMOTION_EMOJI[voiceEmotion.emotion.emotion]} {EMOTION_LABELS[voiceEmotion.emotion.emotion]}
            </span>
          )}
        </div>
        <button
          onClick={handleDeactivate}
          style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 4 }}
        >
          <X size={14} />
        </button>
      </div>

      {/* 语音交互区 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        {/* 麦克风按钮：在 speaking 状态下也可用（barge-in 打断） */}
        <div onClick={handleStartListening}>
          {streamingASR.supported ? (
            // 流式 ASR 模式：显示实时状态按钮（边说边转写）
            <button
              type="button"
              title={streamingASR.isListening ? '正在聆听（流式实时转写）' : '点击开始说话'}
              style={{
                width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: streamingASR.isListening ? 'rgba(16,185,129,.2)' : 'rgba(139,92,246,.15)',
                color: streamingASR.isListening ? '#10b981' : '#a78bfa',
                transition: 'all .2s',
                boxShadow: streamingASR.isListening ? '0 0 12px rgba(16,185,129,.4)' : 'none',
              }}
            >
              <Mic size={18} />
            </button>
          ) : (
            // 降级模式：使用原 VoiceInput（IPC record + PyAudio）
            <VoiceInput
              ref={voiceInputRef}
              onTranscript={handleTranscript}
              onError={handleASRError}
              disabled={isStreaming || status === 'thinking'}
              autoStart={status === 'listening' && continuousMode}
            />
          )}
        </div>

        {/* 停止播报按钮（仅 speaking 状态显示） */}
        {status === 'speaking' && (
          <button
            onClick={handleStopSpeaking}
            title="停止播报并开始聆听"
            style={{
              width: 36, height: 36, borderRadius: '50%', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(239,68,68,.15)', color: '#ef4444', transition: 'all .2s',
            }}
          >
            <Square size={14} />
          </button>
        )}

        {/* 自动播报开关 */}
        <button
          onClick={() => setAutoSpeak(!autoSpeak)}
          title={autoSpeak ? '关闭自动播报' : '开启自动播报'}
          style={{
            width: 36, height: 36, borderRadius: '50%', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: autoSpeak ? 'rgba(139,92,246,.2)' : 'rgba(255,255,255,.05)',
            color: autoSpeak ? '#a78bfa' : '#475569', transition: 'all .2s',
          }}
        >
          {autoSpeak ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>

        {/* 连续对话开关 */}
        <button
          onClick={() => setContinuousMode(!continuousMode)}
          title={continuousMode ? '关闭连续对话' : '开启连续对话'}
          style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 500,
            background: continuousMode ? 'rgba(16,185,129,.15)' : 'rgba(255,255,255,.05)',
            color: continuousMode ? '#10b981' : '#475569', transition: 'all .2s',
          }}
        >
          连续对话
        </button>

        {/* V19 贾维斯增强：唤醒词检测开关（默认关闭，开启后说"段先生"/"贾维斯"即可激活） */}
        <button
          onClick={() => setWakeWordEnabled(!wakeWordEnabled)}
          title={wakeWordEnabled ? '关闭唤醒词检测' : '开启唤醒词检测（说"段先生"激活）'}
          style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 500, transition: 'all .2s',
            background: wakeWordEnabled ? 'rgba(245,158,11,.15)' : 'rgba(255,255,255,.05)',
            color: wakeWordEnabled ? '#f59e0b' : '#475569',
          }}
        >
          唤醒词
        </button>
      </div>

      {/* V19 流式 ASR 实时识别文本显示 */}
      {streamingASR.supported && (streamingASR.isListening || streamingASR.interimText) && (
        <div style={{
          marginBottom: 8, padding: '8px 10px', borderRadius: 8,
          background: 'rgba(16,185,129,.06)', border: '1px solid rgba(16,185,129,.15)',
          fontSize: 12, color: '#e2e8f0', minHeight: 32,
        }}>
          {streamingASR.interimText ? (
            <span>
              <span style={{ color: '#94a3b8' }}>{streamingASR.finalText}</span>
              <span style={{ color: '#10b981', fontStyle: 'italic' }}>{streamingASR.interimText}</span>
            </span>
          ) : (
            <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#10b981',
                animation: 'pulse 1.2s infinite',
              }} />
              正在聆听...（边说边转写）
            </span>
          )}
        </div>
      )}

      {/* V19 贾维斯增强：唤醒词检测状态指示 */}
      {(wakeWordEnabled || wakeError) && (
        <div style={{ marginBottom: 8, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {wakeWordEnabled && wakeListening && (
            <span style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#f59e0b',
                animation: 'pulse 1.5s infinite',
              }} />
              正在监听"段先生"...
            </span>
          )}
          {wakeError && <span style={{ color: '#ef4444' }}>{wakeError}</span>}
        </div>
      )}

      {/* 文本输入兜底 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && textInput.trim() && !isStreaming) {
              handleTranscript(textInput.trim());
              setTextInput('');
            }
          }}
          placeholder="或输入文字..."
          disabled={isStreaming}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 8,
            border: '1px solid rgba(255,255,255,.1)', background: 'rgba(255,255,255,.05)',
            color: '#e2e8f0', fontSize: 13, outline: 'none',
          }}
        />
        <button
          onClick={() => {
            if (textInput.trim() && !isStreaming) {
              handleTranscript(textInput.trim());
              setTextInput('');
            }
          }}
          disabled={!textInput.trim() || isStreaming}
          style={{
            padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: textInput.trim() && !isStreaming ? 'rgba(139,92,246,.3)' : 'rgba(255,255,255,.05)',
            color: textInput.trim() && !isStreaming ? '#a78bfa' : '#475569',
            fontSize: 12, fontWeight: 500, transition: 'all .2s',
          }}
        >
          发送
        </button>
      </div>

      {/* 流式分句 TTS 播报（隐藏组件） */}
      {status === 'speaking' && currentSentence && (
        <div style={{ position: 'absolute', left: -9999 }}>
          <VoiceOutput
            ref={voiceOutputRef}
            key={currentSentence}
            text={currentSentence}
            autoPlay={true}
            onEnded={handleSentenceEnded}
          />
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
