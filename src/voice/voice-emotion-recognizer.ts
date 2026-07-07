/**
 * 语音情感识别器 — VoiceEmotionRecognizer
 *
 * V17 语音交互补齐：语音情感特征提取与识别
 *
 * 核心能力：
 * 1. 声学特征提取 — 基频(F0)、能量、梅尔频率、语速、停顿
 * 2. 情感分类 — 7 类基本情感（喜/怒/哀/惧/惊/厌/中性）
 * 3. 情感强度 — 0-1 连续值
 * 4. 实时流式识别 — 边说话边分析情感
 * 5. 多模态融合 — 语音 + 文本语义联合情感分析
 *
 * 对标：Hume AI, Microsoft Emotion API, Google Cloud Emotion
 */

import { logger } from '../core/structured-logger.js';

// ============ 类型定义 ============

export type EmotionType = 'joy' | 'anger' | 'sadness' | 'fear' | 'surprise' | 'disgust' | 'neutral';

export interface EmotionResult {
  primary: EmotionType;
  confidence: number;            // 0-1
  intensity: number;             // 0-1
  distribution: Record<EmotionType, number>; // 7 类情感概率分布
  valence: number;               // -1（消极）到 1（积极）
  arousal: number;               // 0（平静）到 1（激动）
  features: AcousticFeatures;
  processingTimeMs: number;
}

export interface AcousticFeatures {
  f0: { mean: number; std: number; range: number; contour: number[] }; // 基频
  energy: { mean: number; std: number; range: number };                // 能量
  duration: number;                                                     // 总时长（秒）
  speakingRate: number;                                                 // 语速（字/秒）
  pauseCount: number;                                                   // 停顿次数
  pauseDuration: number;                                                // 停顿总时长
  jitter: number;                                                       // 频率抖动
  shimmer: number;                                                      // 振幅抖动
  mfcc: number[];                                                       // 梅尔频率系数（13维）
  spectralCentroid: number;                                             // 频谱质心
  spectralFlux: number;                                                 // 频谱通量
}

export interface StreamingEmotionChunk {
  emotion: EmotionType;
  intensity: number;
  timestamp: number;
}

// ============ 情感模型参数 ============

const EMOTION_PROTOTYPES: Record<EmotionType, {
  f0Mean: number; f0Std: number; energy: number; rate: number; valence: number; arousal: number;
}> = {
  joy:       { f0Mean: 220, f0Std: 60,  energy: 0.7, rate: 5.5, valence:  0.8, arousal: 0.7 },
  anger:     { f0Mean: 180, f0Std: 80,  energy: 0.9, rate: 6.0, valence: -0.7, arousal: 0.9 },
  sadness:   { f0Mean: 140, f0Std: 20,  energy: 0.3, rate: 2.5, valence: -0.7, arousal: 0.2 },
  fear:      { f0Mean: 260, f0Std: 100, energy: 0.5, rate: 4.0, valence: -0.6, arousal: 0.8 },
  surprise:  { f0Mean: 280, f0Std: 90,  energy: 0.8, rate: 5.0, valence:  0.5, arousal: 0.9 },
  disgust:   { f0Mean: 160, f0Std: 40,  energy: 0.4, rate: 3.5, valence: -0.6, arousal: 0.4 },
  neutral:   { f0Mean: 180, f0Std: 30,  energy: 0.5, rate: 4.0, valence:  0.0, arousal: 0.5 },
};

// ============ 语音情感识别器 ============

export class VoiceEmotionRecognizer {
  private isStreaming = false;
  private emotionHistory: EmotionResult[] = [];
  private readonly maxHistory = 100;

  /**
   * 从音频缓冲区识别情感
   */
  recognize(audioBuffer: Buffer, sampleRate = 16000): Promise<EmotionResult> {
    const startTime = Date.now();

    // 1. 提取声学特征
    const features = this.extractFeatures(audioBuffer, sampleRate);

    // 2. 基于特征匹配情感原型
    const distribution = this.classifyEmotion(features);
    const primary = this.getTopEmotion(distribution);
    const confidence = distribution[primary];
    const intensity = this.computeIntensity(features);

    // 3. 计算 V-A 空间坐标
    const prototype = EMOTION_PROTOTYPES[primary];
    const valence = prototype.valence;
    const arousal = prototype.arousal;

    const result: EmotionResult = {
      primary,
      confidence,
      intensity,
      distribution,
      valence,
      arousal,
      features,
      processingTimeMs: Date.now() - startTime,
    };

    this.emotionHistory.push(result);
    if (this.emotionHistory.length > this.maxHistory) {
      this.emotionHistory.shift();
    }

    logger.info('语音情感识别完成', {
      module: 'VoiceEmotionRecognizer',
      emotion: primary,
      confidence: confidence.toFixed(2),
      intensity: intensity.toFixed(2),
      valence: valence.toFixed(2),
      arousal: arousal.toFixed(2),
      duration: result.processingTimeMs,
    });

    return Promise.resolve(result);
  }

  /**
   * 流式情感识别 — 边说话边分析
   */
  startStreaming(): void {
    this.isStreaming = true;
    logger.info('流式情感识别已启动', { module: 'VoiceEmotionRecognizer' });
  }

  async *processChunk(audioChunk: Buffer, sampleRate = 16000): AsyncGenerator<StreamingEmotionChunk> {
    if (!this.isStreaming) return;

    const features = this.extractFeatures(audioChunk, sampleRate);
    const distribution = this.classifyEmotion(features);
    const primary = this.getTopEmotion(distribution);
    const intensity = this.computeIntensity(features);

    yield {
      emotion: primary,
      intensity,
      timestamp: Date.now(),
    };
  }

  stopStreaming(): void {
    this.isStreaming = false;
    logger.info('流式情感识别已停止', { module: 'VoiceEmotionRecognizer' });
  }

  /**
   * 多模态情感融合 — 语音 + 文本语义
   */
  fuseWithText(
    voiceEmotion: EmotionResult,
    textSentiment: { emotion: EmotionType; confidence: number },
  ): Promise<EmotionResult> {
    // 加权融合：语音 60% + 文本 40%
    const voiceWeight = 0.6;
    const textWeight = 0.4;

    const fusedDistribution = { ...voiceEmotion.distribution };
    for (const emo of Object.keys(fusedDistribution) as EmotionType[]) {
      const voiceScore = voiceEmotion.distribution[emo];
      const textScore = emo === textSentiment.emotion ? textSentiment.confidence : 0.1;
      fusedDistribution[emo] = voiceScore * voiceWeight + textScore * textWeight;
    }

    // 归一化
    const total = Object.values(fusedDistribution).reduce((s, v) => s + v, 0);
    for (const emo of Object.keys(fusedDistribution) as EmotionType[]) {
      fusedDistribution[emo] /= total;
    }

    const primary = this.getTopEmotion(fusedDistribution);

    return Promise.resolve({
      ...voiceEmotion,
      primary,
      confidence: fusedDistribution[primary],
      distribution: fusedDistribution,
    });
  }

  // ============ 特征提取 ============

  /**
   * 提取声学特征
   * 实际实现会使用 FFT、自相关等算法
   */
  private extractFeatures(audioBuffer: Buffer, sampleRate: number): AcousticFeatures {
    const samples = this.bufferToSamples(audioBuffer);
    const duration = samples.length / sampleRate;

    // 基频提取（自相关法）
    const f0 = this.extractF0(samples, sampleRate);

    // 能量
    const energy = this.extractEnergy(samples);

    // 语速和停顿（基于能量阈值）
    const { speakingRate, pauseCount, pauseDuration } = this.analyzeProsody(samples, sampleRate, energy.mean);

    // 频率抖动和振幅抖动
    const jitter = this.computeJitter(f0.contour);
    const shimmer = this.computeShimmer(samples);

    // MFCC（简化版：实际应使用 FFT + 梅尔滤波器组）
    const mfcc = this.extractMFCC(samples, sampleRate);

    // 频谱特征
    const spectralCentroid = this.computeSpectralCentroid(samples);
    const spectralFlux = this.computeSpectralFlux(samples);

    return {
      f0,
      energy,
      duration,
      speakingRate,
      pauseCount,
      pauseDuration,
      jitter,
      shimmer,
      mfcc,
      spectralCentroid,
      spectralFlux,
    };
  }

  private bufferToSamples(buffer: Buffer): number[] {
    const samples: number[] = [];
    // 16-bit PCM 转浮点
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768.0;
      samples.push(sample);
    }
    return samples;
  }

  private extractF0(samples: number[], sampleRate: number): { mean: number; std: number; range: number; contour: number[] } {
    // 简化的基频提取：自相关法
    const frameSize = Math.floor(sampleRate * 0.03); // 30ms 帧
    const contour: number[] = [];

    for (let i = 0; i < samples.length - frameSize; i += frameSize) {
      const frame = samples.slice(i, i + frameSize);
      const f0 = this.autocorrelationF0(frame, sampleRate);
      if (f0 > 50 && f0 < 500) contour.push(f0);
    }

    if (contour.length === 0) {
      return { mean: 180, std: 30, range: 100, contour: [180] };
    }

    const mean = contour.reduce((s, v) => s + v, 0) / contour.length;
    const variance = contour.reduce((s, v) => s + (v - mean) ** 2, 0) / contour.length;
    const std = Math.sqrt(variance);
    const range = Math.max(...contour) - Math.min(...contour);

    return { mean, std, range, contour };
  }

  private autocorrelationF0(frame: number[], sampleRate: number): number {
    // 简化自相关基频检测
    const minLag = Math.floor(sampleRate / 500); // 最高 500Hz
    const maxLag = Math.floor(sampleRate / 50);  // 最低 50Hz
    let bestLag = 0;
    let bestCorr = 0;

    for (let lag = minLag; lag < maxLag && lag < frame.length; lag++) {
      let corr = 0;
      for (let i = 0; i < frame.length - lag; i++) {
        corr += frame[i] * frame[i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    return bestLag > 0 ? sampleRate / bestLag : 0;
  }

  private extractEnergy(samples: number[]): { mean: number; std: number; range: number } {
    if (samples.length === 0) return { mean: 0, std: 0, range: 0 };
    const energies = samples.map(s => s * s);
    const mean = energies.reduce((s, e) => s + e, 0) / energies.length;
    const variance = energies.reduce((s, e) => s + (e - mean) ** 2, 0) / energies.length;
    const std = Math.sqrt(variance);
    const range = Math.max(...energies) - Math.min(...energies);
    return { mean, std, range };
  }

  private analyzeProsody(samples: number[], sampleRate: number, energyThreshold: number): {
    speakingRate: number; pauseCount: number; pauseDuration: number;
  } {
    const frameSize = Math.floor(sampleRate * 0.1); // 100ms 帧
    let pauseCount = 0;
    let pauseDuration = 0;
    let activeFrames = 0;

    for (let i = 0; i < samples.length - frameSize; i += frameSize) {
      const frame = samples.slice(i, i + frameSize);
      const energy = frame.reduce((s, v) => s + v * v, 0) / frame.length;
      if (energy < energyThreshold * 0.1) {
        pauseCount++;
        pauseDuration += 0.1;
      } else {
        activeFrames++;
      }
    }

    const duration = samples.length / sampleRate;
    const activeDuration = duration - pauseDuration;
    const speakingRate = activeDuration > 0 ? activeFrames / activeDuration : 0;

    return { speakingRate, pauseCount, pauseDuration };
  }

  private computeJitter(f0Contour: number[]): number {
    if (f0Contour.length < 2) return 0;
    let sumDiff = 0;
    for (let i = 1; i < f0Contour.length; i++) {
      sumDiff += Math.abs(f0Contour[i] - f0Contour[i - 1]);
    }
    const meanF0 = f0Contour.reduce((s, v) => s + v, 0) / f0Contour.length;
    return (sumDiff / (f0Contour.length - 1)) / meanF0;
  }

  private computeShimmer(samples: number[]): number {
    // 振幅抖动：相邻帧能量差异
    const frameSize = Math.floor(samples.length / 10);
    if (frameSize === 0) return 0;
    const energies: number[] = [];
    for (let i = 0; i < samples.length; i += frameSize) {
      const frame = samples.slice(i, i + frameSize);
      const energy = frame.reduce((s, v) => s + v * v, 0) / frame.length;
      energies.push(energy);
    }
    let sumDiff = 0;
    for (let i = 1; i < energies.length; i++) {
      sumDiff += Math.abs(energies[i] - energies[i - 1]);
    }
    const meanEnergy = energies.reduce((s, v) => s + v, 0) / energies.length;
    return meanEnergy > 0 ? (sumDiff / (energies.length - 1)) / meanEnergy : 0;
  }

  private extractMFCC(samples: number[], sampleRate: number): number[] {
    // 简化 MFCC：实际应使用 FFT + 梅尔滤波器组 + DCT
    // 这里返回 13 维特征向量
    const mfcc: number[] = [];
    const frameSize = Math.floor(sampleRate * 0.025); // 25ms

    for (let c = 0; c < 13; c++) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < samples.length - frameSize; i += frameSize) {
        const frame = samples.slice(i, i + frameSize);
        // 简化：使用帧能量的余弦变换
        const energy = frame.reduce((s, v) => s + v * v, 0);
        sum += energy * Math.cos((c * Math.PI * i) / samples.length);
        count++;
      }
      mfcc.push(count > 0 ? sum / count : 0);
    }

    return mfcc;
  }

  private computeSpectralCentroid(samples: number[]): number {
    // 频谱质心：声音"亮度"的度量
    if (samples.length === 0) return 0;
    let weightedSum = 0;
    let magnitudeSum = 0;
    for (let i = 0; i < samples.length; i++) {
      const magnitude = Math.abs(samples[i]);
      weightedSum += i * magnitude;
      magnitudeSum += magnitude;
    }
    return magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
  }

  private computeSpectralFlux(samples: number[]): number {
    // 频谱通量：相邻帧频谱变化
    const frameSize = Math.floor(samples.length / 2);
    if (frameSize === 0) return 0;
    const frame1 = samples.slice(0, frameSize);
    const frame2 = samples.slice(frameSize);
    let flux = 0;
    for (let i = 0; i < Math.min(frame1.length, frame2.length); i++) {
      flux += (frame2[i] - frame1[i]) ** 2;
    }
    return flux / frameSize;
  }

  // ============ 情感分类 ============

  /**
   * 基于声学特征分类情感
   * 使用原型匹配 + 加权距离
   */
  private classifyEmotion(features: AcousticFeatures): Record<EmotionType, number> {
    const distribution: Record<EmotionType, number> = {
      joy: 0, anger: 0, sadness: 0, fear: 0,
      surprise: 0, disgust: 0, neutral: 0,
    };

    for (const emo of Object.keys(EMOTION_PROTOTYPES) as EmotionType[]) {
      const proto = EMOTION_PROTOTYPES[emo];
      // 计算特征与原型的匹配度（高斯距离）
      const f0Score = this.gaussianSimilarity(features.f0.mean, proto.f0Mean, proto.f0Std * 2);
      const energyScore = this.gaussianSimilarity(features.energy.mean, proto.energy, 0.3);
      const rateScore = this.gaussianSimilarity(features.speakingRate, proto.rate, 2.0);

      // 加权综合
      distribution[emo] = f0Score * 0.4 + energyScore * 0.3 + rateScore * 0.3;
    }

    // 归一化为概率分布
    const total = Object.values(distribution).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const emo of Object.keys(distribution) as EmotionType[]) {
        distribution[emo] /= total;
      }
    }

    return distribution;
  }

  private gaussianSimilarity(value: number, mean: number, std: number): number {
    const diff = value - mean;
    return Math.exp(-(diff * diff) / (2 * std * std));
  }

  private getTopEmotion(distribution: Record<EmotionType, number>): EmotionType {
    let max = 0;
    let top: EmotionType = 'neutral';
    for (const emo of Object.keys(distribution) as EmotionType[]) {
      if (distribution[emo] > max) {
        max = distribution[emo];
        top = emo;
      }
    }
    return top;
  }

  private computeIntensity(features: AcousticFeatures): number {
    // 情感强度：基于能量、语速、F0 变化
    const energyIntensity = Math.min(features.energy.mean * 10, 1);
    const rateIntensity = Math.min(features.speakingRate / 8, 1);
    const f0Variation = Math.min(features.f0.std / 100, 1);
    return (energyIntensity + rateIntensity + f0Variation) / 3;
  }

  /**
   * 获取情感历史
   */
  getHistory(): EmotionResult[] {
    return [...this.emotionHistory];
  }

  /**
   * 获取情感趋势
   */
  getEmotionTrend(): { emotion: EmotionType; frequency: number }[] {
    const counts: Record<string, number> = {};
    for (const r of this.emotionHistory) {
      counts[r.primary] = (counts[r.primary] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([emotion, frequency]) => ({ emotion: emotion as EmotionType, frequency }))
      .sort((a, b) => b.frequency - a.frequency);
  }
}
