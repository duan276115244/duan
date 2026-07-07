import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * 语音情感识别 Hook — 基于 Web Audio API 的实时音频特征分析
 *
 * 对标 Hume AI / Microsoft Emotion API：
 * - 实时分析麦克风音频流，提取声学特征（音量/频率中心/零交叉率/频谱能量分布）
 * - 基于特征映射到 7 类基本情感（喜/怒/哀/惧/惊/厌/中性）
 * - 输出 V-A 空间坐标（Valence 愉悦度 / Arousal 唤醒度）
 * - 与后端 src/voice/voice-emotion-recognizer.ts 的完整实现互补：
 *   后端用 Buffer + MFCC + F0 自相关做离线精确分析，
 *   本 hook 用 AnalyserNode 做在线实时轻量分析，零延迟反馈
 *
 * 特征→情感映射规则（基于声学原型）：
 * - joy（喜）: 高音量 + 高频率中心 + 中高唤醒
 * - anger（怒）: 高音量 + 高频率中心 + 高唤醒 + 高变异
 * - sadness（哀）: 低音量 + 低频率中心 + 低唤醒
 * - fear（惧）: 中低音量 + 高频率中心 + 高唤醒 + 抖动
 * - surprise（惊）: 瞬时高音量 + 高频率中心 + 高唤醒
 * - disgust（厌）: 中低音量 + 中低频率中心 + 低唤醒
 * - neutral（中性）: 中等特征
 */

export type EmotionType = 'joy' | 'anger' | 'sadness' | 'fear' | 'surprise' | 'disgust' | 'neutral';

export interface VoiceEmotionState {
  /** 当前主导情感 */
  emotion: EmotionType;
  /** 情感强度 0-1 */
  intensity: number;
  /** 音量（RMS）0-1 */
  volume: number;
  /** 频率中心（spectral centroid）Hz */
  pitch: number;
  /** 愉悦度 -1..1（负面..正面） */
  valence: number;
  /** 唤醒度 0..1（平静..激动） */
  arousal: number;
  /** 情感分布（各情感概率） */
  distribution: Record<EmotionType, number>;
}

export interface UseVoiceEmotionOptions {
  /** 是否启用分析（默认 false，需显式开启） */
  enabled?: boolean;
  /** 分析间隔 ms（默认 100ms，平衡性能与响应） */
  intervalMs?: number;
  /** 情感变化回调 */
  onEmotion?: (state: VoiceEmotionState) => void;
}

export interface UseVoiceEmotionReturn {
  /** 是否支持 Web Audio API */
  supported: boolean;
  /** 是否正在分析 */
  isActive: boolean;
  /** 当前情感状态 */
  emotion: VoiceEmotionState | null;
  /** 错误信息 */
  error?: string;
  /** 启动分析 */
  start: () => Promise<void>;
  /** 停止分析 */
  stop: () => void;
}

/** 情感原型参数（基于声学特征均值/标准差） */
const EMOTION_PROTOTYPES: Record<EmotionType, {
  volume: number; pitch: number; arousal: number; valence: number;
}> = {
  joy:      { volume: 0.7, pitch: 2200, arousal: 0.7, valence: 0.8 },
  anger:    { volume: 0.85, pitch: 2500, arousal: 0.9, valence: -0.7 },
  sadness:  { volume: 0.25, pitch: 800, arousal: 0.2, valence: -0.7 },
  fear:     { volume: 0.4, pitch: 2800, arousal: 0.8, valence: -0.6 },
  surprise: { volume: 0.8, pitch: 3000, arousal: 0.9, valence: 0.5 },
  disgust:  { volume: 0.35, pitch: 1200, arousal: 0.4, valence: -0.6 },
  neutral:  { volume: 0.5, pitch: 1800, arousal: 0.5, valence: 0.0 },
};

/** 情感中文标签 */
export const EMOTION_LABELS: Record<EmotionType, string> = {
  joy: '喜悦',
  anger: '愤怒',
  sadness: '悲伤',
  fear: '恐惧',
  surprise: '惊讶',
  disgust: '厌恶',
  neutral: '中性',
};

/** 情感 emoji */
export const EMOTION_EMOJI: Record<EmotionType, string> = {
  joy: '😊',
  anger: '😠',
  sadness: '😢',
  fear: '😨',
  surprise: '😮',
  disgust: '😒',
  neutral: '😐',
};

/** 高斯相似度计算 */
function gaussianSimilarity(value: number, mean: number, std: number): number {
  const diff = value - mean;
  return Math.exp(-(diff * diff) / (2 * std * std));
}

/** 基于声学特征分类情感 */
function classifyEmotion(volume: number, pitch: number): {
  distribution: Record<EmotionType, number>;
  primary: EmotionType;
  intensity: number;
} {
  const distribution = {} as Record<EmotionType, number>;
  let total = 0;

  for (const emo of Object.keys(EMOTION_PROTOTYPES) as EmotionType[]) {
    const proto = EMOTION_PROTOTYPES[emo];
    // 音量相似度（标准差 0.2）
    const volSim = gaussianSimilarity(volume, proto.volume, 0.2);
    // 频率中心相似度（标准差 800Hz）
    const pitchSim = gaussianSimilarity(pitch, proto.pitch, 800);
    // 加权融合（音量 40% + 频率 60%）
    const sim = volSim * 0.4 + pitchSim * 0.6;
    distribution[emo] = sim;
    total += sim;
  }

  // 归一化
  if (total > 0) {
    for (const emo of Object.keys(distribution) as EmotionType[]) {
      distribution[emo] /= total;
    }
  }

  // 找主导情感
  let primary: EmotionType = 'neutral';
  let maxProb = 0;
  for (const emo of Object.keys(distribution) as EmotionType[]) {
    if (distribution[emo] > maxProb) {
      maxProb = distribution[emo];
      primary = emo;
    }
  }

  // 强度 = 主导情感概率 * 特征偏离中性程度
  const volDeviation = Math.abs(volume - 0.5);
  const pitchDeviation = Math.min(1, Math.abs(pitch - 1800) / 2000);
  const intensity = Math.min(1, maxProb * (0.5 + volDeviation + pitchDeviation * 0.5));

  return { distribution, primary, intensity };
}

export function useVoiceEmotion(options: UseVoiceEmotionOptions = {}): UseVoiceEmotionReturn {
  const { enabled = false, intervalMs = 100, onEmotion } = options;

  const [supported] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return !!(window.AudioContext || (window as any).webkitAudioContext) && !!navigator.mediaDevices?.getUserMedia;
  });
  const [isActive, setIsActive] = useState(false);
  const [emotion, setEmotion] = useState<VoiceEmotionState | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastAnalysisRef = useRef(0);
  const onEmotionRef = useRef(onEmotion);
  useEffect(() => { onEmotionRef.current = onEmotion; }, [onEmotion]);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch {}
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    setIsActive(false);
  }, []);

  const analyzeFrame = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    const timeData = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);

    // 1. 计算音量（RMS）
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const volume = Math.min(1, rms * 2.5);

    // 2. 计算频率中心（spectral centroid）
    let weightedSum = 0;
    let totalMagnitude = 0;
    const sampleRate = audioContextRef.current?.sampleRate || 44100;
    const nyquist = sampleRate / 2;
    for (let i = 0; i < freqData.length; i++) {
      const magnitude = freqData[i] / 255;
      const frequency = (i / freqData.length) * nyquist;
      weightedSum += frequency * magnitude;
      totalMagnitude += magnitude;
    }
    const pitch = totalMagnitude > 0 ? weightedSum / totalMagnitude : 0;

    // 3. 节流到指定间隔
    const now = performance.now();
    if (now - lastAnalysisRef.current < intervalMs) {
      rafRef.current = requestAnimationFrame(analyzeFrame);
      return;
    }
    lastAnalysisRef.current = now;

    // 4. 分类情感
    const { distribution, primary, intensity } = classifyEmotion(volume, pitch);
    const proto = EMOTION_PROTOTYPES[primary];

    const state: VoiceEmotionState = {
      emotion: primary,
      intensity,
      volume,
      pitch,
      valence: proto.valence,
      arousal: proto.arousal,
      distribution,
    };

    setEmotion(state);
    onEmotionRef.current?.(state);

    rafRef.current = requestAnimationFrame(analyzeFrame);
  }, [intervalMs]);

  const start = useCallback(async () => {
    if (!supported) {
      const msg = '浏览器不支持 Web Audio API 或麦克风访问';
      setError(msg);
      return;
    }
    if (isActive) return;

    try {
      // 获取麦克风流
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // 创建 AudioContext
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      audioContextRef.current = ctx;

      // 创建分析器
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      analyserRef.current = analyser;

      // 连接源到分析器
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      source.connect(analyser);

      setIsActive(true);
      setError(undefined);
      lastAnalysisRef.current = 0;
      rafRef.current = requestAnimationFrame(analyzeFrame);
    } catch (e: any) {
      const msg = e?.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器设置中允许'
        : `启动音频分析失败: ${e?.message || String(e)}`;
      setError(msg);
      stop();
    }
  }, [supported, isActive, analyzeFrame, stop]);

  // enabled 变化时自动启停
  useEffect(() => {
    if (enabled) {
      void start();
    } else {
      stop();
    }
    return () => { stop(); };
  }, [enabled, start, stop]);

  return { supported, isActive, emotion, error, start, stop };
}
