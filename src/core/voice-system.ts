/**
 * 语音系统 — VoiceSystem
 *
 * 为"段先生"自主AI代理提供实时语音捕获（语音转文字）和流式文字转语音能力。
 *
 * 核心能力：
 * 1. captureVoice — 麦克风录音并转写为文字（Whisper API / Azure Speech / sox+ffmpeg）
 * 2. speak — 流式文字转语音（Edge-TTS / Azure TTS / OpenAI TTS）
 * 3. transcribeFile — 转写音频文件（WAV/MP3/M4A/OGG/FLAC）
 * 4. listVoices — 列出可用TTS语音
 *
 * 设计原则：
 * - 优雅降级：优先使用免费/已配置的服务，逐级回退
 * - 流式播放：TTS边生成边播放，不等待完整生成
 * - 外部依赖容错：sox/ffmpeg/Whisper不可用时返回有意义的错误消息
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec, execFile, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { VoiceWakeUp } from './voice-wakeup.js';
import { VoiceEmotionRecognizer, type EmotionResult, type EmotionType } from '../voice/voice-emotion-recognizer.js';
import { FullDuplexDialogue, type DialogueState, type TTSProvider } from '../voice/full-duplex-dialogue.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============ 类型定义 ============

/** 语音合成选项 */
export interface SpeakOptions {
  voice?: string;        // 语音名称或语言代码
  speed?: number;        // 0.5 - 2.0，默认 1.0
  pitch?: number;        // -10 到 10
  format?: 'mp3' | 'wav' | 'ogg';
  outputPath?: string;   // 保存到文件
  stream?: boolean;      // 流式播放（默认 true）
}

/** 转写结果 */
export interface TranscriptionResult {
  text: string;
  language: string;
  confidence: number;
  duration: number;
  segments?: TranscriptionSegment[];
}

/** 转写片段 */
export interface TranscriptionSegment {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

/** 语音信息 */
export interface VoiceInfo {
  name: string;
  language: string;
  gender: 'male' | 'female';
  provider: string;
}

// ============ 语音数据（已拆分至独立数据模块） ============
//
// 大型静态语音列表已迁移到 ./voices 数据模块，避免与主类逻辑混杂。
// 注意：以下 import 语句在实际文件中应与其他 import 一并置于文件顶部。
import {
  EDGE_TTS_VOICES,
  VALID_EDGE_TTS_VOICE_NAMES,
  OPENAI_TTS_VOICES,
} from './voices.js';

// ============ Provider 选择策略接口 ============
//
// 将 TTS 提供方的选择（Edge / Azure / OpenAI 回退链）抽象为策略接口，
// 便于扩展、替换与单元测试具体的合成实现。

/** TTS 合成请求参数 */
export interface SynthesisRequest {
  text: string;
  voice?: string;
  language?: string;
  rate?: string;
  pitch?: string;
}

/** TTS 合成结果 */
export interface SynthesisResult {
  audio: Buffer;
  provider: string;
  voice: string;
}

/**
 * TTS Provider 策略接口
 *
 * 每个具体 Provider（Edge / Azure / OpenAI）实现此接口，
 * 由 ProviderSelector 按回退链顺序选择可用实现。
 */
export interface TtsProviderStrategy {
  /** 提供方名称，如 'edge-tts' / 'azure' / 'openai' */
  readonly name: string;
  /** 该 Provider 当前是否可用（凭证 / 网络等） */
  isAvailable(): Promise<boolean>;
  /** 返回该 Provider 支持的语音列表 */
  listVoices(): VoiceInfo[];
  /** 执行语音合成 */
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
}

/**
 * Provider 选择器：按回退链（Edge → Azure → OpenAI）选择首个可用 Provider。
 */
export interface ProviderSelector {
  /** 选择首个可用的 Provider，全部不可用时返回 null */
  select(): Promise<TtsProviderStrategy | null>;
}

// re-export 内置语音列表，保持对外 API 兼容
export { EDGE_TTS_VOICES, VALID_EDGE_TTS_VOICE_NAMES, OPENAI_TTS_VOICES };

// ============ 主类 ============

export class VoiceSystem {
  private log = logger.child({ module: 'VoiceSystem' });
  private voiceDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelLibrary: any;
  /** 当前 TTS 播放进程（用于全双工打断） */
  private currentPlaybackProcess: ReturnType<typeof spawn> | null = null;

  /** 语音唤醒词检测器（懒初始化，集成 VoiceWakeUp） */
  private wakeWordDetector: VoiceWakeUp | null = null;
  /** 语音情感识别器（懒初始化，集成 VoiceEmotionRecognizer） */
  private emotionRecognizer: VoiceEmotionRecognizer | null = null;
  /** 全双工语音对话管理器（懒初始化，集成 FullDuplexDialogue） */
  private fullDuplexDialogue: FullDuplexDialogue | null = null;

  // 统计
  private totalCaptures = 0;
  private totalSpeaks = 0;
  private totalTranscriptions = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary;
    this.voiceDir = duanPath('voice');
    this.ensureVoiceDir();
    this.log.info('语音系统初始化完成', {
      sttProvider: this.getSTTProvider(),
      ttsProvider: this.getTTSProvider(),
    });
  }

  // ============ 公共方法 ============

  /**
   * 捕获麦克风语音并转写为文字
   * @param duration 录音时长（秒），默认5秒
   */
  async captureVoice(duration: number = 5): Promise<string> {
    const startTime = Date.now();
    this.log.info('开始捕获语音', { duration });

    try {
      // 1. 录音
      const audioPath = await this.recordAudio(duration);
      this.log.info('录音完成', { audioPath });

      // 2. 转写
      const result = await this.transcribeAudio(audioPath);
      this.totalCaptures++;

      EventBus.getInstance().emitSync('voice.captured', {
        text: result.text,
        duration: Date.now() - startTime,
        provider: this.getSTTProvider(),
      });

      this.log.info('语音转写完成', {
        text: result.text.substring(0, 50),
        confidence: result.confidence,
        durationMs: Date.now() - startTime,
      });

      return result.text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('语音捕获失败', { error: msg });
      return `语音捕获失败: ${msg}`;
    }
  }

  /**
   * 文字转语音，支持流式播放
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<string> {
    const startTime = Date.now();
    const {
      voice,
      speed = 1.0,
      pitch = 0,
      format = 'mp3',
      outputPath,
      stream = true,
    } = options;

    this.log.info('开始语音合成', {
      textLength: text.length,
      voice: voice || 'default',
      speed,
      format,
      stream,
    });

    try {
      const outputFileName = outputPath || path.join(
        this.voiceDir,
        `tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${format}`
      );

      let usedProvider: string;

      // 优先使用 Edge-TTS（免费，无需API Key）
      if (this.isEdgeTTSAvailable()) {
        await this.edgeTTS(text, outputFileName, { voice, speed, pitch, format });
        usedProvider = 'edge-tts';
      } else if (this.isAzureTTSAvailable()) {
        await this.azureTTS(text, outputFileName, { voice, speed, pitch, format });
        usedProvider = 'azure';
      } else if (this.isOpenAITTSAvailable()) {
        await this.openaiTTS(text, outputFileName, { voice, speed, format });
        usedProvider = 'openai';
      } else {
        return '语音合成失败: 没有可用的TTS服务。请配置 Edge-TTS（免费）、Azure Speech Key 或 OpenAI API Key。';
      }

      this.totalSpeaks++;

      // 流式播放
      if (stream) {
        this.streamPlayback(outputFileName);
      }

      EventBus.getInstance().emitSync('voice.spoken', {
        textLength: text.length,
        provider: usedProvider,
        outputPath: outputFileName,
        duration: Date.now() - startTime,
      });

      this.log.info('语音合成完成', {
        provider: usedProvider,
        outputPath: outputFileName,
        durationMs: Date.now() - startTime,
      });

      return `语音已生成 (${usedProvider}): ${outputFileName}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('语音合成失败', { error: msg });
      return `语音合成失败: ${msg}`;
    }
  }

  /**
   * 转写音频文件
   */
  async transcribeFile(filePath: string): Promise<TranscriptionResult> {
    const startTime = Date.now();
    this.log.info('开始转写音频文件', { filePath });

    // 检查文件格式
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const supportedFormats = ['wav', 'mp3', 'm4a', 'ogg', 'flac'];
    if (!supportedFormats.includes(ext)) {
      return {
        text: '',
        language: '',
        confidence: 0,
        duration: 0,
      };
    }

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      this.log.error('音频文件不存在', { filePath });
      return {
        text: '',
        language: '',
        confidence: 0,
        duration: 0,
      };
    }

    try {
      // 必要时转换为兼容格式
      const compatiblePath = await this.ensureCompatibleFormat(filePath);

      const result = await this.transcribeAudio(compatiblePath);
      this.totalTranscriptions++;

      EventBus.getInstance().emitSync('voice.transcribed', {
        filePath,
        textLength: result.text.length,
        duration: Date.now() - startTime,
      });

      this.log.info('音频文件转写完成', {
        filePath,
        textLength: result.text.length,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('音频文件转写失败', { error: msg, filePath });
      return {
        text: '',
        language: '',
        confidence: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 列出可用TTS语音
   */
  listVoices(language?: string): VoiceInfo[] {
    const allVoices: VoiceInfo[] = [];

    // Edge-TTS 语音（始终可用）
    allVoices.push(...EDGE_TTS_VOICES);

    // OpenAI TTS 语音
    if (this.isOpenAITTSAvailable()) {
      allVoices.push(...OPENAI_TTS_VOICES);
    }

    // 按语言过滤
    if (language) {
      const langLower = language.toLowerCase();
      return allVoices.filter(v =>
        v.language.toLowerCase().startsWith(langLower) ||
        v.language.toLowerCase() === 'multi'
      );
    }

    return allVoices;
  }

  /**
   * 获取工具定义 — 注册到 Agent Loop
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const vs = this;

    return [
      {
        name: 'voice_capture',
        description: '捕获麦克风语音并转写为文字。使用Whisper API或Azure Speech进行语音识别。需要麦克风设备。',
        parameters: {
          duration: {
            type: 'number',
            description: '录音时长（秒），默认5秒，最长60秒',
            required: false,
          },
        },
        execute: (args) => {
          const duration = Math.min(60, Math.max(1, Number(args.duration) || 5));
          return vs.captureVoice(duration);
        },
      },
      {
        name: 'voice_speak',
        description: '将文字转为语音并播放。支持多种语言和语音选择，默认使用Edge-TTS（免费）。支持流式播放。',
        parameters: {
          text: {
            type: 'string',
            description: '要朗读的文字内容',
            required: true,
          },
          voice: {
            type: 'string',
            description: '语音名称或语言代码（如 zh-CN-XiaoxiaoNeural, en-US-JennyNeural），默认根据系统语言选择',
            required: false,
          },
          speed: {
            type: 'number',
            description: '语速 0.5-2.0，默认1.0',
            required: false,
          },
          format: {
            type: 'string',
            description: '音频格式: mp3 / wav / ogg，默认mp3',
            required: false,
          },
          stream: {
            type: 'boolean',
            description: '是否流式播放，默认true',
            required: false,
          },
        },
        execute: (args) => {
          if (!args.text) return Promise.resolve('错误: 需要提供 text 参数');
          return vs.speak(args.text as string, {
            voice: args.voice as string,
            speed: args.speed ? Number(args.speed) : undefined,
            format: (args.format as 'mp3' | 'wav' | 'ogg') || undefined,
            stream: args.stream !== undefined ? Boolean(args.stream) : true,
          });
        },
      },
      {
        name: 'voice_transcribe',
        description: '转写音频文件为文字。支持 WAV、MP3、M4A、OGG、FLAC 格式。使用Whisper API进行高精度转写。',
        parameters: {
          filePath: {
            type: 'string',
            description: '音频文件的绝对路径',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          if (!args.filePath) return '错误: 需要提供 filePath 参数';
          const result = await vs.transcribeFile(args.filePath as string);
          if (!result.text) return '转写失败: 无法识别音频内容或文件格式不支持';
          let output = `转写结果: ${result.text}\n`;
          output += `语言: ${result.language} | 置信度: ${(result.confidence * 100).toFixed(1)}% | 时长: ${result.duration}ms`;
          if (result.segments && result.segments.length > 0) {
            output += '\n\n时间戳片段:\n';
            for (const seg of result.segments) {
              output += `  [${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s] ${seg.text}\n`;
            }
          }
          return output;
        },
      },
      {
        name: 'voice_list',
        description: '列出可用的TTS语音。可按语言过滤。返回语音名称、语言、性别等信息。',
        parameters: {
          language: {
            type: 'string',
            description: '按语言过滤（如 zh, en, ja），不填则返回所有',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          const voices = vs.listVoices(args.language as string);
          if (voices.length === 0) {
            return Promise.resolve('没有找到匹配的语音');
          }
          const lines = voices.map(v =>
            `  ${v.name} | ${v.language} | ${v.gender === 'male' ? '男' : '女'} | ${v.provider}`
          );
          return Promise.resolve(`可用语音 (${voices.length}):\n${lines.join('\n')}`);
        },
      },
      {
        name: 'voice_emotion_analyze',
        description: '分析音频文件中的语音情感。提取声学特征（基频F0/能量/MFCC/语速/停顿/抖动shimmer），分类到7类基本情感（喜/怒/哀/惧/惊/厌/中性），输出情感强度和V-A空间坐标。对标 Hume AI。',
        parameters: {
          filePath: {
            type: 'string',
            description: '音频文件的绝对路径（WAV/MP3等格式）',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          if (!args.filePath) return '错误: 需要提供 filePath 参数';
          try {
            const audioBuffer = fs.readFileSync(args.filePath as string);
            const result = await vs.recognizeEmotion(audioBuffer);
            let output = '情感分析结果:\n';
            output += `  主导情感: ${result.primary} (置信度: ${(result.confidence * 100).toFixed(1)}%)\n`;
            output += `  情感强度: ${(result.intensity * 100).toFixed(1)}%\n`;
            output += `  愉悦度(V): ${result.valence.toFixed(2)} | 唤醒度(A): ${result.arousal.toFixed(2)}\n`;
            output += `  处理耗时: ${result.processingTimeMs}ms\n`;
            output += '\n情感分布:\n';
            for (const [emo, prob] of Object.entries(result.distribution)) {
              output += `  ${emo}: ${(prob * 100).toFixed(1)}%\n`;
            }
            return output;
          } catch (e: unknown) {
            return `情感分析失败: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      },
      {
        name: 'voice_emotion_trend',
        description: '获取语音情感识别的历史趋势统计。返回各情感出现频率，用于了解用户情绪变化模式。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const trend = vs.getEmotionTrend();
          if (trend.length === 0) return Promise.resolve('暂无情感识别历史数据');
          let output = '情感趋势统计:\n';
          for (const item of trend) {
            output += `  ${item.emotion}: ${item.frequency} 次\n`;
          }
          return Promise.resolve(output);
        },
      },
    ];
  }

  // ============ 私有方法 — 录音 ============

  /**
   * 使用 sox 或 ffmpeg 录音
   */
  private async recordAudio(duration: number): Promise<string> {
    const outputPath = path.join(
      this.voiceDir,
      `capture-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`
    );

    const platform = os.platform();

    // 优先尝试 sox（Linux/Mac）
    if (this.isCommandAvailable('sox')) {
      try {
        await execAsync(`sox -d -r 16000 -c 1 "${outputPath}" trim 0 ${duration}`, {
          timeout: (duration + 5) * 1000,
        });
        return outputPath;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('sox 录音失败，尝试 ffmpeg', { error: msg });
      }
    }

    // 尝试 ffmpeg
    if (this.isCommandAvailable('ffmpeg')) {
      try {
        if (platform === 'win32') {
          // Windows: 使用 dshow 设备
          await execAsync(
            `ffmpeg -y -f dshow -i audio="麦克风" -t ${duration} -ar 16000 -ac 1 "${outputPath}"`,
            { timeout: (duration + 5) * 1000 }
          );
        } else {
          // Linux/Mac: 使用 ALSA 或 AVFoundation
          const inputDevice = platform === 'darwin'
            ? '-f avfoundation -i ":0"'
            : '-f alsa -i default';
          await execAsync(
            `ffmpeg -y ${inputDevice} -t ${duration} -ar 16000 -ac 1 "${outputPath}"`,
            { timeout: (duration + 5) * 1000 }
          );
        }
        return outputPath;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('ffmpeg 录音失败', { error: msg });
      }
    }

    throw new Error(
      '无法录音: 未找到 sox 或 ffmpeg。请安装其中之一:\n' +
      '  - sox: https://sourceforge.net/projects/sox/\n' +
      '  - ffmpeg: https://ffmpeg.org/download.html'
    );
  }

  // ============ 私有方法 — 语音转写 ============

  /**
   * 转写音频文件（自动选择最佳提供商）
   */
  private async transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
    const startTime = Date.now();

    // 优先使用 OpenAI Whisper API
    if (process.env.OPENAI_API_KEY) {
      try {
        return await this.whisperTranscribe(audioPath, startTime);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('Whisper API 转写失败，尝试回退', { error: msg });
      }
    }

    // 回退到 Azure Speech
    if (process.env.AZURE_SPEECH_KEY) {
      try {
        return await this.azureSpeechTranscribe(audioPath, startTime);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('Azure Speech 转写失败', { error: msg });
      }
    }

    throw new Error(
      '无法转写音频: 没有可用的STT服务。请配置 OPENAI_API_KEY 或 AZURE_SPEECH_KEY。'
    );
  }

  /**
   * 使用 OpenAI Whisper API 转写
   */
  private async whisperTranscribe(audioPath: string, startTime: number): Promise<TranscriptionResult> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      language: 'zh',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = transcription as any;
    const segments: TranscriptionSegment[] = (result.segments || []).map((seg) => ({
      text: seg.text,
      start: seg.start,
      end: seg.end,
      confidence: seg.avg_logprob ? Math.max(0, Math.min(1, Math.exp(seg.avg_logprob))) : 0.8,
    }));

    return {
      text: result.text || '',
      language: result.language || 'zh',
      confidence: segments.length > 0
        ? segments.reduce((sum, s) => sum + s.confidence, 0) / segments.length
        : 0.9,
      duration: Date.now() - startTime,
      segments,
    };
  }

  /**
   * 使用 Azure Speech 转写
   */
  private async azureSpeechTranscribe(audioPath: string, startTime: number): Promise<TranscriptionResult> {
    const region = process.env.AZURE_SPEECH_REGION || 'eastasia';
    const key = process.env.AZURE_SPEECH_KEY!;

    // 使用 Azure Speech REST API（无需安装SDK）
    const url = `https://${region}.api.cognitive.microsoft.com/stt/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN`;

    const audioBuffer = fs.readFileSync(audioPath);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Azure Speech API 错误: ${response.status} ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await response.json() as any;

    return {
      text: result.DisplayText || '',
      language: 'zh-CN',
      confidence: result.NBest?.[0]?.Confidence || 0.8,
      duration: Date.now() - startTime,
    };
  }

  // ============ 私有方法 — 语音合成 ============

  /**
   * Edge-TTS — 通过 WebSocket 与 Bing Speech API 通信
   * 免费，无需 API Key
   */
  private async edgeTTS(
    text: string,
    outputPath: string,
    options: { voice?: string; speed?: number; pitch?: number; format?: string }
  ): Promise<void> {
    // 校验语音名称：无效语音（如 Azure 专属语音）会导致 edge-tts 返回 NoAudioReceived
    let voice = options.voice || this.getDefaultVoice();
    if (!VALID_EDGE_TTS_VOICE_NAMES.has(voice)) {
      this.log.warn('语音不在 edge-tts 可用列表中，回退到默认语音', { requested: voice });
      voice = this.getDefaultVoice();
    }
    const rate = options.speed ? `${options.speed >= 1 ? '+' : ''}${Math.round((options.speed - 1) * 100)}%` : '+0%';
    const pitch = options.pitch ? `${options.pitch >= 0 ? '+' : ''}${options.pitch}Hz` : '+0Hz';
    const format = options.format || 'mp3';

    // Edge-TTS WebSocket 端点
    const requestId = crypto.randomUUID();
    const trustedClientToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

    // 构建 SSML
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
      <voice name='${voice}'>
        <prosody pitch='${pitch}' rate='${rate}'>
          ${this.escapeXml(text)}
        </prosody>
      </voice>
    </speak>`;

    // 优先使用 WebSocket 方式（更快，无需启动子进程）
    try {
      await this.edgeTTSViaWebSocket(ssml, outputPath, requestId, trustedClientToken, format);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('WebSocket 方式失败，尝试 edge-tts 命令行', { error: msg });
    }

    // 回退：使用 edge-tts 命令行工具
    if (this.isCommandAvailable('edge-tts')) {
      try {
        const tmpSsmlPath = path.join(this.voiceDir, `ssml-${Date.now()}.xml`);
        fs.writeFileSync(tmpSsmlPath, ssml, 'utf-8');

        // 使用 execFileAsync + shell:false 避免 Windows 路径反斜杠/空格被 shell 二次解析
        let exitCode: number | null = 0;
        let stderrBuf: Buffer | string | undefined;
        try {
          await execFileAsync('edge-tts', [
            '--voice', voice,
            '--rate', rate,
            '--pitch', pitch,
            '-f', tmpSsmlPath,
            '--write-media', outputPath,
          ], { timeout: 30000, shell: false });
        } catch (err: unknown) {
          const execErr = err as { code?: number; stderr?: Buffer | string };
          exitCode = typeof execErr.code === 'number' ? execErr.code : null;
          stderrBuf = execErr.stderr;
        }

        // 清理临时 SSML 文件
        try { fs.unlinkSync(tmpSsmlPath); } catch { /* 忽略 */ }

        if (exitCode !== 0) {
          const errMsg = stderrBuf?.toString().substring(0, 500) || '未知错误';
          throw new Error(`edge-tts 退出码 ${exitCode}: ${errMsg}`);
        }
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('edge-tts 命令行调用也失败', { error: msg });
        throw err;
      }
    }
  }

  /**
   * 通过 WebSocket 与 Edge-TTS 服务通信
   */
  private async edgeTTSViaWebSocket(
    ssml: string,
    outputPath: string,
    requestId: string,
    token: string,
    format: string
  ): Promise<void> {
    const WebSocket = await this.importWebSocket();
    if (!WebSocket) {
      throw new Error('无法加载 WebSocket 模块。请安装 ws: npm install ws');
    }

    const audioFormat = format === 'wav' ? 'riff-16khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3';

    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${token}&ConnectionId=${requestId}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://azure.microsoft.com',
        },
      });

      const audioChunks: Buffer[] = [];
      let resolved = false;
      let writeStream: fs.WriteStream | null = null;

      // 连接超时保护（10 秒未连接则失败）
      const connectTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.close(); } catch { /* ignore */ }
          if (writeStream) { try { writeStream.end(); } catch { /* ignore */ } }
          reject(new Error('Edge-TTS WebSocket 连接超时'));
        }
      }, 10000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        // 发送配置消息
        const configMessage = [
          'X-Timestamp:' + new Date().toISOString(),
          'Content-Type:application/json; charset=utf-8',
          'Path:speech.config',
          '',
          JSON.stringify({
            context: {
              synthesis: {
                audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                  outputFormat: audioFormat },
              },
            },
          }),
        ].join('\r\n');
        ws.send(configMessage);

        // 发送 SSML
        const ssmlMessage = [
          'X-RequestId:' + requestId,
          'Content-Type:application/ssml+xml',
          'X-Timestamp:' + new Date().toISOString() + 'Z',
          'Path:ssml',
          '',
          ssml,
        ].join('\r\n');
        ws.send(ssmlMessage);
      });

      ws.on('message', (data: Buffer) => {
        const message = data.toString();

        // 检查是否为音频数据
        if (message.includes('Path:turn.start')) {
          // 转换开始
        } else if (message.includes('Path:turn.end')) {
          // 转换结束
          if (!resolved) {
            resolved = true;
            ws.close();

            // 关闭写入流并等待完成
            const finishWrite = () => {
              if (audioChunks.length > 0) {
                resolve();
              } else {
                reject(new Error('Edge-TTS 未返回音频数据'));
              }
            };

            if (writeStream) {
              writeStream.end(finishWrite);
            } else if (audioChunks.length > 0) {
              // 回退：如果没有使用流式写入，一次性写入
              fs.writeFileSync(outputPath, Buffer.concat(audioChunks));
              resolve();
            } else {
              reject(new Error('Edge-TTS 未返回音频数据'));
            }
          }
        } else if (message.includes('Path:audio')) {
          // 提取音频数据：二进制数据在头部之后
          const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'));
          if (headerEnd !== -1) {
            const audioData = data.subarray(headerEnd + 4);
            if (audioData.length > 0) {
              audioChunks.push(audioData);
              // 流式写入：首个块时创建文件，后续块追加写入
              if (!writeStream) {
                writeStream = fs.createWriteStream(outputPath);
              }
              writeStream.write(audioData);
            }
          }
        }
      });

      ws.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Edge-TTS WebSocket 错误: ${err.message}`));
        }
      });

      ws.on('close', () => {
        if (!resolved) {
          resolved = true;
          const finishWrite = () => {
            if (audioChunks.length > 0) {
              resolve();
            } else {
              reject(new Error('Edge-TTS 未返回音频数据'));
            }
          };
          if (writeStream) {
            writeStream.end(finishWrite);
          } else if (audioChunks.length > 0) {
            fs.writeFileSync(outputPath, Buffer.concat(audioChunks));
            resolve();
          } else {
            reject(new Error('Edge-TTS 未返回音频数据'));
          }
        }
      });

      // 超时保护
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error('Edge-TTS 请求超时'));
        }
      }, 30000);
    });
  }

  /**
   * OpenAI TTS
   */
  private async openaiTTS(
    text: string,
    outputPath: string,
    options: { voice?: string; speed?: number; format?: string }
  ): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('请配置 OPENAI_API_KEY');
    }

    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const voice = options.voice || 'alloy';
    const speed = options.speed || 1.0;

    const response = await client.audio.speech.create({
      model: 'tts-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      voice: voice as any,
      input: text,
      speed,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
  }

  /**
   * Azure TTS
   */
  private async azureTTS(
    text: string,
    outputPath: string,
    options: { voice?: string; speed?: number; pitch?: number; format?: string }
  ): Promise<void> {
    if (!process.env.AZURE_SPEECH_KEY) {
      throw new Error('请配置 AZURE_SPEECH_KEY');
    }

    const region = process.env.AZURE_SPEECH_REGION || 'eastasia';
    const voice = options.voice || this.getDefaultVoice();
    const rate = options.speed ? `${options.speed >= 1 ? '+' : ''}${Math.round((options.speed - 1) * 100)}%` : '+0%';
    const pitch = options.pitch ? `${options.pitch >= 0 ? '+' : ''}${options.pitch}Hz` : '+0Hz';

    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>
      <voice name='${voice}'>
        <prosody pitch='${pitch}' rate='${rate}'>
          ${this.escapeXml(text)}
        </prosody>
      </voice>
    </speak>`;

    const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': options.format === 'wav'
          ? 'riff-16khz-16bit-mono-pcm'
          : 'audio-16khz-128kbitrate-mono-mp3',
      },
      body: ssml,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Azure TTS API 错误: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
  }

  // ============ 私有方法 — 流式播放 ============

  /**
   * 流式播放音频文件
   */
  private streamPlayback(audioPath: string): void {
    // 异步播放，不阻塞主流程
    const platform = os.platform();

    try {
      let proc: ReturnType<typeof spawn>;
      if (platform === 'win32') {
        // Windows: 使用 PowerShell 播放
        proc = spawn('powershell', [
          '-Command',
          `(New-Object Media.SoundPlayer '${audioPath}').PlaySync()`,
        ], { stdio: 'ignore', detached: true });
      } else if (platform === 'darwin') {
        // macOS: 使用 afplay
        proc = spawn('afplay', [audioPath], { stdio: 'ignore', detached: true });
      } else {
        // Linux: 尝试 aplay 或 mpv
        if (this.isCommandAvailable('mpv')) {
          proc = spawn('mpv', ['--no-video', audioPath], { stdio: 'ignore', detached: true });
        } else if (this.isCommandAvailable('aplay')) {
          proc = spawn('aplay', [audioPath], { stdio: 'ignore', detached: true });
        } else {
          this.log.warn('未找到音频播放器，音频已保存但无法自动播放', { audioPath });
          return;
        }
      }
      // P1-1: 跟踪播放进程，支持全双工打断
      this.currentPlaybackProcess = proc;
      proc.unref();
      proc.on('exit', () => {
        if (this.currentPlaybackProcess === proc) {
          this.currentPlaybackProcess = null;
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('音频播放失败', { error: msg, audioPath });
    }
  }

  // ============ 私有方法 — 工具函数 ============

  /**
   * 确保语音目录存在
   */
  private ensureVoiceDir(): void {
    try {
      fs.mkdirSync(this.voiceDir, { recursive: true });
    } catch { /* 可能已存在 */ }
  }

  /**
   * 获取当前 STT 提供商
   */
  getSTTProvider(): string {
    if (process.env.OPENAI_API_KEY) return 'whisper';
    if (process.env.AZURE_SPEECH_KEY) return 'azure';
    return 'none';
  }

  /**
   * 获取当前 TTS 提供商
   */
  getTTSProvider(): string {
    if (this.isEdgeTTSAvailable()) return 'edge-tts';
    if (this.isAzureTTSAvailable()) return 'azure';
    if (this.isOpenAITTSAvailable()) return 'openai';
    return 'none';
  }

  /**
   * Edge-TTS 是否可用
   */
  private isEdgeTTSAvailable(): boolean {
    // Edge-TTS 通过 WebSocket 直接连接，始终可用（除非网络不通）
    // 也检查命令行工具是否可用
    return true;
  }

  /**
   * Azure TTS 是否可用
   */
  private isAzureTTSAvailable(): boolean {
    return !!process.env.AZURE_SPEECH_KEY;
  }

  /**
   * OpenAI TTS 是否可用
   */
  private isOpenAITTSAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  /**
   * 获取默认语音名称
   */
  private getDefaultVoice(): string {
    const locale = process.env.LANG || process.env.LC_ALL || '';
    if (locale.includes('zh') || locale.includes('CN') || locale.includes('TW')) {
      return 'zh-CN-XiaoxiaoNeural';
    }
    if (locale.includes('ja') || locale.includes('JP')) {
      return 'ja-JP-NanamiNeural';
    }
    if (locale.includes('ko') || locale.includes('KR')) {
      return 'ko-KR-SunHiNeural';
    }
    return 'zh-CN-XiaoxiaoNeural'; // 段先生默认中文
  }

  /**
   * 检查命令是否可用
   */
  private isCommandAvailable(command: string): boolean {
    try {
      const platform = os.platform();
      const checkCmd = platform === 'win32' ? `where ${command}` : `which ${command}`;
      execSync(checkCmd, { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保音频格式兼容 Whisper API
   */
  private async ensureCompatibleFormat(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    // Whisper 支持: mp3, mp4, wav, m4a, webm, ogg, flac
    const whisperSupported = ['.mp3', '.mp4', '.wav', '.m4a', '.webm', '.ogg', '.flac'];
    if (whisperSupported.includes(ext)) {
      return filePath;
    }

    // 需要转换 — 使用 ffmpeg
    if (!this.isCommandAvailable('ffmpeg')) {
      this.log.warn('音频格式不兼容且 ffmpeg 不可用，尝试直接提交', { ext });
      return filePath;
    }

    const outputPath = path.join(
      this.voiceDir,
      `converted-${Date.now()}.wav`
    );

    try {
      await execAsync(`ffmpeg -y -i "${filePath}" -ar 16000 -ac 1 "${outputPath}"`, {
        timeout: 30000,
      });
      return outputPath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('音频格式转换失败', { error: msg });
      return filePath;
    }
  }

  /**
   * 动态导入 WebSocket 模块
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async importWebSocket(): Promise<any> {
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — ws 为可选依赖，可能未安装
      const ws = await import('ws');
      return ws.WebSocket || ws.default || ws;
    } catch {
      // 尝试全局 WebSocket（浏览器环境）
      const globalWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
      if (typeof globalWs !== 'undefined') {
        return globalWs;
      }
      return null;
    }
  }

  /**
   * XML 特殊字符转义
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ========== P2-4: 音频处理增强 ==========

  /**
   * P2-4: 音频质量评估
   *
   * 评估音频的信噪比（SNR）、音量水平和 clipping 情况。
   */
  assessAudioQuality(audioBuffer: Buffer): AudioQualityAssessment {
    let maxSample = 0;
    let sumSquares = 0;
    let sampleCount = 0;
    let clippingCount = 0;

    for (let i = 0; i + 1 < audioBuffer.length; i += 2) {
      const sample = audioBuffer.readInt16LE(i) / 32768;
      const absSample = Math.abs(sample);

      maxSample = Math.max(maxSample, absSample);
      sumSquares += sample * sample;
      sampleCount++;

      // clipping 检测：样本接近最大值
      if (absSample > 0.99) clippingCount++;
    }

    if (sampleCount === 0) {
      return { snr: 0, rmsLevel: 0, peakLevel: 0, clippingRatio: 0, quality: 'poor' };
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    const clippingRatio = clippingCount / sampleCount;

    // 简化 SNR 估算：RMS / (1 - RMS) 的对数比
    const snr = rms > 0 ? 20 * Math.log10(rms / Math.max(1 - rms, 0.001)) : 0;

    let quality: 'excellent' | 'good' | 'fair' | 'poor';
    if (snr > 20 && clippingRatio < 0.001 && rms > 0.05) {
      quality = 'excellent';
    } else if (snr > 15 && clippingRatio < 0.01 && rms > 0.03) {
      quality = 'good';
    } else if (snr > 10 && clippingRatio < 0.05) {
      quality = 'fair';
    } else {
      quality = 'poor';
    }

    return {
      snr,
      rmsLevel: rms,
      peakLevel: maxSample,
      clippingRatio,
      quality,
    };
  }

  // ============ 语音唤醒词检测（集成 VoiceWakeUp） ============

  /**
   * 启动语音唤醒词检测
   * 对标 Alexa/Google Assistant — 持续监听麦克风，检测到唤醒词时触发回调
   * 懒初始化 VoiceWakeUp 实例，首次调用时创建
   */
  async startWakeWordDetection(callback: (wakeWord: string) => void, wakeWords?: string[]): Promise<void> {
    if (!this.wakeWordDetector) {
      this.wakeWordDetector = new VoiceWakeUp(wakeWords ? { wakeWords } : undefined);
    }
    await this.wakeWordDetector.start(callback);
    this.log.info('语音唤醒词检测已启动', { wakeWords: this.wakeWordDetector.getWakeWords() });
  }

  /** 停止语音唤醒词检测 */
  stopWakeWordDetection(): void {
    if (this.wakeWordDetector) {
      this.wakeWordDetector.stop();
      this.log.info('语音唤醒词检测已停止');
    }
  }

  /** 添加唤醒词 */
  addWakeWord(word: string): void {
    if (!this.wakeWordDetector) {
      this.wakeWordDetector = new VoiceWakeUp();
    }
    this.wakeWordDetector.addWakeWord(word);
  }

  /** 移除唤醒词 */
  removeWakeWord(word: string): void {
    this.wakeWordDetector?.removeWakeWord(word);
  }

  /** 获取唤醒词列表 */
  getWakeWords(): string[] {
    return this.wakeWordDetector?.getWakeWords() ?? [];
  }

  /** 唤醒词检测是否活跃 */
  isWakeWordActive(): boolean {
    return this.wakeWordDetector?.isActive() ?? false;
  }

  /** 设置唤醒词检测灵敏度（0-1，值越高越灵敏） */
  setWakeWordSensitivity(sensitivity: number): void {
    if (!this.wakeWordDetector) {
      this.wakeWordDetector = new VoiceWakeUp();
    }
    this.wakeWordDetector.setSensitivity(sensitivity);
  }

  // ============ 语音情感识别（集成 VoiceEmotionRecognizer） ============

  /**
   * 识别语音情感
   * 对标 Hume AI — 从音频缓冲区提取声学特征（F0/能量/MFCC/语速/jitter/shimmer），
   * 分类到 7 类基本情感（喜/怒/哀/惧/惊/厌/中性），输出 V-A 空间坐标
   * 懒初始化 VoiceEmotionRecognizer 实例，首次调用时创建
   */
  recognizeEmotion(audioBuffer: Buffer, sampleRate?: number): Promise<EmotionResult> {
    if (!this.emotionRecognizer) {
      this.emotionRecognizer = new VoiceEmotionRecognizer();
    }
    return this.emotionRecognizer.recognize(audioBuffer, sampleRate);
  }

  /** 获取情感识别历史记录 */
  getEmotionHistory(): EmotionResult[] {
    return this.emotionRecognizer?.getHistory() ?? [];
  }

  /** 获取情感趋势统计（各情感出现频率） */
  getEmotionTrend(): { emotion: EmotionType; frequency: number }[] {
    return this.emotionRecognizer?.getEmotionTrend() ?? [];
  }

  // ============ 全双工语音对话（集成 FullDuplexDialogue） ============

  /**
   * 停止当前 TTS 播放进程（用于全双工打断）
   * 当检测到用户说话时，立即 kill 播放进程，实现自然打断
   */
  stopPlayback(): void {
    if (this.currentPlaybackProcess) {
      try {
        this.currentPlaybackProcess.kill();
      } catch { /* 进程可能已退出 */ }
      this.currentPlaybackProcess = null;
      this.log.debug('TTS 播放已停止（全双工打断）');
    }
  }

  /**
   * 启动全双工语音对话
   * 对标 GPT-4o Realtime — 同时录音和播放，支持自然打断
   * 集成回声消除（WebRTC AEC / 系统 AEC）+ 流式 STT + 流式 TTS + 轮次检测
   * 接入 VoiceSystem.speak 实现真实流式 TTS（Edge-TTS / Azure / OpenAI），替代模拟播放
   * 懒初始化 FullDuplexDialogue 实例
   */
  async startFullDuplexDialogue(
    responseGenerator: (utterance: string) => Promise<string>,
  ): Promise<void> {
    if (!this.fullDuplexDialogue) {
      // 接入 VoiceSystem.speak 实现真实流式 TTS，尊重 AbortSignal 支持全双工打断
      const ttsProvider: TTSProvider = async (text: string, signal: AbortSignal): Promise<void> => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const onAbort = (): void => this.stopPlayback();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          await this.speak(text, { stream: true });
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      this.fullDuplexDialogue = new FullDuplexDialogue({ ttsProvider });
    }
    this.fullDuplexDialogue.setResponseGenerator(responseGenerator);
    await this.fullDuplexDialogue.start();
    this.log.info('全双工语音对话已启动', { tts: 'VoiceSystem.speak (Edge-TTS/Azure/OpenAI)' });
  }

  /** 停止全双工语音对话 */
  stopFullDuplexDialogue(): void {
    if (this.fullDuplexDialogue) {
      this.fullDuplexDialogue.stop();
      this.stopPlayback();
      this.log.info('全双工语音对话已停止');
    }
  }

  /** 获取全双工对话当前状态 */
  getDialogueState(): DialogueState | null {
    return this.fullDuplexDialogue?.getState() ?? null;
  }

  /** 在全双工对话中发送文本（用于测试或文本输入兜底） */
  sendDialogueText(text: string): Promise<string> {
    if (!this.fullDuplexDialogue) {
      return Promise.resolve('错误: 全双工对话未启动');
    }
    return this.fullDuplexDialogue.sendText(text);
  }

}

// ============ P2-4: 音频处理增强类型定义 ============

/** 音频质量评估结果 */
export interface AudioQualityAssessment {
  /** 信噪比（dB） */
  snr: number;
  /** RMS 音量水平（0-1） */
  rmsLevel: number;
  /** 峰值音量（0-1） */
  peakLevel: number;
  /** clipping 比例（0-1） */
  clippingRatio: number;
  /** 综合质量评级 */
  quality: 'excellent' | 'good' | 'fair' | 'poor';
}
