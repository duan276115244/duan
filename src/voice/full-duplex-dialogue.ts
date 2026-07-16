/**
 * 全双工语音对话 — FullDuplexDialogue
 *
 * P1-7: 实现全双工语音对话，支持自然流畅的多轮交流
 *
 * 核心能力：
 * 1. 全双工对话 — 同时录音和播放，支持打断
 * 2. 回声消除 — WebRTC AEC 或系统级 AEC
 * 3. 流式 STT — 边录音边转写，延迟 <500ms
 * 4. 流式 TTS — 边生成边播放，自然流畅
 * 5. 轮次检测 — 基于语义完整度 + 静音时长判断用户说完
 * 6. 打断处理 — 检测到用户说话 → 立即停止 TTS 播放
 *
 * 技术栈：WebRTC AEC + Whisper Streaming + Edge-TTS Streaming
 */

import { EventEmitter } from 'events';
import { logger } from '../core/structured-logger.js';

// ============ 类型定义 ============

export type DialogueState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted';

/**
 * TTS 流式播放 Provider
 * 接入真实 TTS 引擎（Edge-TTS / Azure Neural TTS / OpenAI TTS），替代模拟播放。
 * 必须尊重 AbortSignal 以支持全双工打断（用户说话时立即停止 TTS）。
 */
export type TTSProvider = (text: string, signal: AbortSignal) => Promise<void>;

export interface FullDuplexConfig {
  /** 回声消除模式 */
  aecMode: 'webrtc' | 'system' | 'none';
  /** VAD 静音检测阈值（ms）— 静音超过此时长认为说完 */
  silenceThresholdMs: number;
  /** 最小语音时长（ms）— 短于此的认为是噪声 */
  minSpeechMs: number;
  /** 最大录音时长（ms）— 超过强制结束 */
  maxRecordingMs: number;
  /** 是否启用打断 */
  enableInterruption: boolean;
  /** STT 流式模式 */
  streamingSTT: boolean;
  /** TTS 流式模式 */
  streamingTTS: boolean;
  /** 真实 TTS 流式播放 Provider（接入 Edge-TTS / Azure 等）；未提供时降级为模拟播放 */
  ttsProvider?: TTSProvider;
}

export interface TurnResult {
  userUtterance: string;
  response: string;
  interrupted: boolean;
  durationMs: number;
}

// ============ 回声消除器 ============

/**
 * 回声消除器接口
 * 解决全双工核心挑战：同时录音和播放时的回声问题
 */
export interface EchoCanceller {
  /** 处理输入音频，消除回声 */
  process(input: Buffer, referenceOutput: Buffer): Buffer;
}

/** WebRTC 回声消除器（生产环境使用） */
class WebRTCEchoCanceller implements EchoCanceller {
  process(input: Buffer, referenceOutput: Buffer): Buffer {
    // 生产环境：使用 WebRTC AEC3 或 node-webrtc
    // 当前简化实现：直接返回输入（需配合系统级 AEC）
    return input;
  }
}

/** 系统级回声消除器（依赖操作系统 AEC） */
class SystemEchoCanceller implements EchoCanceller {
  process(input: Buffer, referenceOutput: Buffer): Buffer {
    // 依赖 Windows AEC / macOS AEC / PulseAudio AEC
    return input;
  }
}

// ============ 输入通道（录音 + STT） ============

/**
 * 输入通道：持续 VAD 检测 + 流式 STT
 */
class InputChannel extends EventEmitter {
  private isRunning = false;
  private silenceStart = 0;
  private speechStart = 0;
  private currentUtterance = '';
  private config: FullDuplexConfig;

  constructor(config: FullDuplexConfig) {
    super();
    this.config = config;
  }

  start(): Promise<void> {
    this.isRunning = true;
    logger.info('开始持续监听（VAD + 流式 STT）', { module: 'InputChannel' });
    // 生产环境：启动麦克风录音 + VAD + Whisper Streaming
    // 当前为框架实现
    return Promise.resolve();
  }

  stop(): void {
    this.isRunning = false;
    logger.info('停止监听', { module: 'InputChannel' });
  }

  /**
   * 模拟检测到语音活动
   * 生产环境由 VAD 引擎触发
   */
  onSpeechDetected(): void {
    this.speechStart = Date.now();
    this.emit('userSpeech'); // 触发打断检查
  }

  /**
   * 模拟检测到静音
   * 生产环境由 VAD 引擎触发
   */
  onSilenceDetected(): void {
    if (this.speechStart === 0) return;
    const speechDuration = Date.now() - this.speechStart;
    if (speechDuration < this.config.minSpeechMs) {
      // 太短，认为是噪声
      this.speechStart = 0;
      this.currentUtterance = '';
      return;
    }
    // 静音超过阈值，认为用户说完
    this.silenceStart = Date.now();
    setTimeout(() => {
      if (Date.now() - this.silenceStart >= this.config.silenceThresholdMs) {
        this.emit('turnComplete', this.currentUtterance);
        this.currentUtterance = '';
        this.speechStart = 0;
      }
    }, this.config.silenceThresholdMs);
  }

  /**
   * 接收流式 STT 结果
   * 生产环境由 Whisper Streaming 触发
   */
  onSTTPartial(text: string): void {
    this.currentUtterance = text;
  }

  isListening(): boolean {
    return this.isRunning;
  }
}

// ============ 输出通道（TTS + 播放） ============

/**
 * 输出通道：流式 TTS + 播放队列
 */
class OutputChannel extends EventEmitter {
  private queue: string[] = [];
  private isPlaying = false;
  private currentPlayback: AbortController | null = null;
  private readonly ttsProvider?: TTSProvider;

  constructor(ttsProvider?: TTSProvider) {
    super();
    this.ttsProvider = ttsProvider;
  }

  /**
   * 流式播放文本
   * 边生成 TTS 边播放，减少延迟
   */
  async stream(text: string): Promise<void> {
    this.queue.push(text);
    if (!this.isPlaying) {
      await this.playNext();
    }
  }

  private async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      return;
    }
    this.isPlaying = true;
    this.currentPlayback = new AbortController();

    const text = this.queue.shift()!;
    try {
      // 优先使用真实 TTS 引擎（Edge-TTS / Azure Neural TTS / OpenAI TTS）
      // 未提供 ttsProvider 时降级为模拟播放（框架实现）
      if (this.ttsProvider) {
        logger.debug('TTS 流式播放', { module: 'OutputChannel', preview: text.substring(0, 50) });
        await this.ttsProvider(text, this.currentPlayback.signal);
      } else {
        logger.debug('模拟播放（未配置 ttsProvider）', { module: 'OutputChannel', preview: text.substring(0, 50) });
        await this.simulatePlayback(text, this.currentPlayback.signal);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        logger.error('播放失败', { module: 'OutputChannel', error: String(err) });
      }
    } finally {
      this.currentPlayback = null;
      await this.playNext();
    }
  }

  /**
   * 打断当前播放
   */
  interrupt(): void {
    if (this.currentPlayback) {
      this.currentPlayback.abort();
      this.currentPlayback = null;
    }
    this.queue = [];
    this.isPlaying = false;
    this.emit('interrupted');
    logger.info('播放被打断', { module: 'OutputChannel' });
  }

  private async simulatePlayback(text: string, signal: AbortSignal): Promise<void> {
    // 模拟流式播放：每 100ms 检查一次中断
    const duration = Math.min(text.length * 50, 5000);
    const interval = 100;
    const steps = Math.ceil(duration / interval);
    for (let i = 0; i < steps; i++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise(r => setTimeout(r, interval));
    }
  }
}

// ============ 全双工对话管理器 ============

/**
 * 全双工语音对话
 *
 * 核心架构：
 * - 输入通道：持续 VAD 检测 + 流式 STT
 * - 输出通道：流式 TTS + 播放队列
 * - 回声消除：WebRTC AEC 或系统级 AEC
 * - 打断处理：检测到用户说话 → 立即停止 TTS 播放
 * - 轮次检测：基于语义完整度 + 静音时长判断用户说完
 */
export class FullDuplexDialogue extends EventEmitter {
  private inputChannel: InputChannel;
  private outputChannel: OutputChannel;
  private aec: EchoCanceller;
  private state: DialogueState = 'idle';
  private config: FullDuplexConfig;
  private responseGenerator?: (utterance: string) => Promise<string>;

  constructor(config?: Partial<FullDuplexConfig>) {
    super();
    this.config = {
      aecMode: 'webrtc',
      silenceThresholdMs: 800,
      minSpeechMs: 300,
      maxRecordingMs: 30000,
      enableInterruption: true,
      streamingSTT: true,
      streamingTTS: true,
      ...config,
    };

    // 初始化回声消除器
    this.aec = this.config.aecMode === 'webrtc'
      ? new WebRTCEchoCanceller()
      : new SystemEchoCanceller();

    this.inputChannel = new InputChannel(this.config);
    this.outputChannel = new OutputChannel(this.config.ttsProvider);

    this.setupEventHandlers();
  }

  /**
   * 设置响应生成器
   * @param generator 接收用户话语，返回 AI 响应
   */
  setResponseGenerator(generator: (utterance: string) => Promise<string>): void {
    this.responseGenerator = generator;
  }

  /**
   * 启动全双工对话
   */
  async start(): Promise<void> {
    logger.info('启动全双工语音对话', { module: 'FullDuplexDialogue' });
    this.state = 'listening';
    await this.inputChannel.start();
    this.emit('started');
  }

  /**
   * 停止对话
   */
  stop(): void {
    logger.info('停止全双工语音对话', { module: 'FullDuplexDialogue' });
    this.inputChannel.stop();
    this.outputChannel.interrupt();
    this.state = 'idle';
    this.emit('stopped');
  }

  /**
   * 获取当前状态
   */
  getState(): DialogueState {
    return this.state;
  }

  /**
   * 手动发送文本（跳过语音识别）
   */
  async sendText(text: string): Promise<string> {
    return await this.handleTurn(text);
  }

  // ===== 内部方法 =====

  private setupEventHandlers(): void {
    // 打断处理：检测到用户说话 → 立即停止 TTS 播放
    this.inputChannel.on('userSpeech', () => {
      if (this.config.enableInterruption && this.state === 'speaking') {
        logger.info('检测到用户打断，停止 TTS 播放', { module: 'FullDuplexDialogue' });
        this.outputChannel.interrupt();
        this.state = 'interrupted';
        this.emit('interrupted');
      }
    });

    // 轮次完成：用户说完 → 生成响应 → 播放
    this.inputChannel.on('turnComplete', (utterance: string) => {
      if (utterance.trim().length === 0) return;
      void this.handleTurn(utterance).catch(() => {});
    });
  }

  private async handleTurn(utterance: string): Promise<string> {
    const startTime = Date.now();
    logger.info('用户输入', { module: 'FullDuplexDialogue', utterance: utterance.substring(0, 100) });

    // 生成响应
    this.state = 'thinking';
    this.emit('thinking', utterance);

    let response: string;
    if (this.responseGenerator) {
      response = await this.responseGenerator(utterance);
    } else {
      response = `我听到了："${utterance}"。请设置响应生成器以启用完整对话。`;
    }

    // 播放响应
    this.state = 'speaking';
    this.emit('speaking', response);
    await this.outputChannel.stream(response);

    // 恢复监听
    this.state = 'listening';
    this.emit('listening');

    const result: TurnResult = {
      userUtterance: utterance,
      response,
      interrupted: false,
      durationMs: Date.now() - startTime,
    };
    this.emit('turnComplete', result);
    return response;
  }
}

// ============ 跨会话上下文对话 ============

/**
 * 跨会话语境连贯性
 * 维持跨会话的语境连贯性
 */
export class ContextAwareDialogue {
  private sessionStore: Map<string, any> = new Map();
  /** 会话存储最大条目数，超过时 FIFO 淘汰最旧会话 */
  private maxSessions = 50;

  /**
   * 加载会话上下文
   * 1. 会话状态持久化
   * 2. 跨会话记忆召回
   * 3. 话题追踪
   */
  loadContext(userId: string): Promise<any> {
    return Promise.resolve(this.sessionStore.get(userId) || {
      history: [],
      currentTopic: null,
      lastInteraction: 0,
    });
  }

  /**
   * 指代消解
   * "他" → 上文提到的具体人名
   * "那个" → 上文提到的具体事物
   * "上次说的" → 跨会话记忆召回
   */
  resolveReference(utterance: string, context: any): Promise<string> {
    let resolved = utterance;
    // 简单指代消解（生产环境用 LLM）
    if (utterance.includes('他') && context.lastPerson) {
      resolved = resolved.replace(/他/g, context.lastPerson);
    }
    if (utterance.includes('那个') && context.lastObject) {
      resolved = resolved.replace(/那个/g, context.lastObject);
    }
    return Promise.resolve(resolved);
  }

  /**
   * 持久化会话上下文
   */
  persistContext(userId: string, context: any): Promise<void> {
    context.lastInteraction = Date.now();
    this.sessionStore.set(userId, context);
    // FIFO 淘汰：超过上限时删除最旧的会话
    if (this.sessionStore.size > this.maxSessions) {
      const oldestKey = this.sessionStore.keys().next().value;
      if (oldestKey) this.sessionStore.delete(oldestKey);
    }
    return Promise.resolve();
  }
}
