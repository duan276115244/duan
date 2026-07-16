import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Volume2, VolumeX, Loader2 } from 'lucide-react';

interface VoiceOutputProps {
  text: string;
  autoPlay?: boolean;
  rate?: number;
  voice?: string;
  /** 播报结束回调 */
  onEnded?: () => void;
}

export interface VoiceOutputHandle {
  /** 停止播报 */
  stop: () => void;
}

/** 语音配置（从 ~/.duan/voice-config.json 加载） */
interface VoiceConfig {
  enabled: boolean;
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  autoPlay: boolean;
}

/** 全局语音配置缓存（避免每次播放都重新加载） */
let cachedVoiceConfig: VoiceConfig | null = null;
let voiceConfigLoading: Promise<VoiceConfig> | null = null;

async function loadVoiceConfig(): Promise<VoiceConfig> {
  if (cachedVoiceConfig) return cachedVoiceConfig;
  if (voiceConfigLoading) return voiceConfigLoading;
  voiceConfigLoading = (async () => {
    const isE = typeof window !== 'undefined' && !!window.electronAPI;
    if (isE) {
      const api = window.electronAPI;
      if (api?.voice?.load) {
        try {
          const cfg = await api.voice.load();
          cachedVoiceConfig = {
            enabled: cfg?.enabled ?? false,
            voice: cfg?.voice || 'zh-CN-XiaoxiaoNeural',
            rate: cfg?.rate ?? 1.0,
            pitch: cfg?.pitch ?? 0,
            volume: cfg?.volume ?? 1.0,
            autoPlay: cfg?.autoPlay ?? false,
          };
          return cachedVoiceConfig;
        } catch { /* ignore */ }
      }
    }
    cachedVoiceConfig = { enabled: false, voice: 'zh-CN-XiaoxiaoNeural', rate: 1.0, pitch: 0, volume: 1.0, autoPlay: false };
    return cachedVoiceConfig;
  })();
  return voiceConfigLoading;
}

/** 清除缓存（语音设置保存后调用） */
export function clearVoiceConfigCache() {
  cachedVoiceConfig = null;
  voiceConfigLoading = null;
}

/**
 * 语音输出组件
 * 优先调用后端 TTS（Edge-TTS/Azure/OpenAI，自然流畅），返回音频二进制后播放
 * 使用用户在设置中选择的音色、语速、音调，模拟真人发音
 * 后端不可用时回退到浏览器 SpeechSynthesis API
 */
export const VoiceOutput = forwardRef<VoiceOutputHandle, VoiceOutputProps>(function VoiceOutput(
  { text, autoPlay = false, rate, voice, onEnded },
  ref
) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const onEndedRef = useRef(onEnded);
  // P1 修复：取消标志，防止流式输出时异步 speak 竞态导致音频重叠播放
  const speakCancelledRef = useRef(false);
  useEffect(() => { onEndedRef.current = onEnded; }, [onEnded]);

  const stop = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  useImperativeHandle(ref, () => ({ stop }), [stop]);

  const speak = useCallback(async (content: string) => {
    if (!content) return;
    stop();
    speakCancelledRef.current = false; // P1 修复：重置取消标志

    // 加载用户语音配置
    const voiceConfig = await loadVoiceConfig();
    if (speakCancelledRef.current) return; // P1 修复：await 后检查取消
    const useVoice = voice || voiceConfig.voice;
    const useRate = rate ?? voiceConfig.rate;
    const usePitch = voiceConfig.pitch;

    // 方案 A：后端 TTS（更自然的语音，支持音色/语速/音调）
    setIsLoading(true);
    try {
      const isE = typeof window !== 'undefined' && !!window.electronAPI;
      let res: Response | null = null;

      if (isE) {
        // Electron 模式：通过 IPC 转发到 Agent 服务器 TTS
        const api = window.electronAPI;
        if (api?.voice?.testVoice) {
          const result = await api.voice.testVoice({ voice: useVoice, rate: useRate, pitch: usePitch, text: content });
          if (speakCancelledRef.current) return; // P1 修复：IPC 返回后检查取消
          if (result?.success && result.audio) {
            // 将 base64 转为 blob 播放
            const byteChars = atob(result.audio);
            const byteArrays: BlobPart[] = [];
            for (let i = 0; i < byteChars.length; i += 8192) {
              const slice = byteChars.slice(i, i + 8192);
              const byteNumbers = new Array(slice.length);
              for (let j = 0; j < slice.length; j++) byteNumbers[j] = slice.charCodeAt(j);
              byteArrays.push(new Uint8Array(byteNumbers));
            }
            const blob = new Blob(byteArrays, { type: result.mime || 'audio/mpeg' });
            if (blob.size === 0) {
              throw new Error('TTS 返回了空音频数据');
            }
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = voiceConfig.volume;
            audio.onended = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEndedRef.current?.(); };
            audio.onerror = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEndedRef.current?.(); };
            audioRef.current = audio;
            await audio.play();
            setIsSpeaking(true);
            setIsLoading(false);
            return;
          }
          throw new Error(result?.error || '后端 TTS 不可用');
        }
      }

      // Web 模式：直接调用 /api/voice/speak
      res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content, voice: useVoice, speed: useRate, format: 'mp3' }),
      });
      if (speakCancelledRef.current) return; // P1 修复：fetch 返回后检查取消

      if (res && res.ok) {
        const blob = await res.blob();
        if (blob.size === 0) {
          throw new Error('TTS 返回了空音频数据');
        }
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = voiceConfig.volume;
        audio.onended = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEndedRef.current?.(); };
        audio.onerror = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEndedRef.current?.(); };
        audioRef.current = audio;
        await audio.play();
        setIsSpeaking(true);
        setIsLoading(false);
        return;
      }
      throw new Error('后端 TTS 不可用');
    } catch {
      setIsLoading(false);
      // 方案 B：回退到浏览器 SpeechSynthesis（使用用户选择的语音参数）
      if (window.speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(content);
        utterance.lang = 'zh-CN';
        utterance.rate = rate ?? 1.0;
        utterance.pitch = 1 + (usePitch || 0) / 10; // pitch: -10~10 → 0~2
        utterance.volume = voiceConfig.volume;
        // 尝试匹配用户选择的语音
        const voices = window.speechSynthesis.getVoices();
        const matched = voices.find(v => v.name.includes(useVoice) || v.voiceURI.includes(useVoice));
        if (matched) utterance.voice = matched;
        utterance.onend = () => { setIsSpeaking(false); onEndedRef.current?.(); };
        utterance.onerror = () => { setIsSpeaking(false); onEndedRef.current?.(); };
        utteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
        setIsSpeaking(true);
      }
    }
  }, [rate, voice, stop]);

  useEffect(() => {
    if (autoPlay && text) { speak(text); }
    return () => {
      speakCancelledRef.current = true; // P1 修复：设置取消标志，终止进行中的异步操作
      if (audioRef.current) { audioRef.current.pause(); }
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, [autoPlay, text, speak]);

  if (!text) return null;

  return (
    <button
      onClick={() => isSpeaking ? stop() : speak(text)}
      disabled={isLoading}
      title={isLoading ? '生成中...' : isSpeaking ? '停止朗读' : '朗读回复'}
      style={{
        padding: '2px 4px', borderRadius: 4, border: 'none',
        background: 'transparent', cursor: isLoading ? 'wait' : 'pointer',
        color: isSpeaking ? '#06b6d4' : '#64748b',
        display: 'flex', alignItems: 'center', gap: 2,
        fontSize: 10, fontFamily: 'inherit', transition: 'all .15s',
      }}
    >
      {isLoading
        ? <Loader2 style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} />
        : isSpeaking
          ? <VolumeX style={{ width: 11, height: 11 }} />
          : <Volume2 style={{ width: 11, height: 11 }} />}
    </button>
  );
});
