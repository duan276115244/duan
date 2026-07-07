/**
 * 语音交互系统 - VoiceInteraction
 * 实现语音识别(STT)和语音合成(TTS)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface VoiceConfig {
  sttProvider: 'openai' | 'azure' | 'google' | 'local';
  ttsProvider: 'openai' | 'azure' | 'elevenlabs' | 'local';
  language: string;
  voice?: string;
  speed?: number;
}

export interface SpeechResult {
  text: string;
  confidence: number;
  duration: number;
}

export class VoiceInteraction {
  private config: VoiceConfig;
  private isListening: boolean = false;
  private audioBuffer: Buffer[] = [];
  // 缓存 OpenAI 客户端及其初始化 Promise，避免每次调用都重新 import 和实例化
  private openaiClient: any = null;
  private openaiClientPromise: Promise<any> | null = null;

  constructor(config?: Partial<VoiceConfig>) {
    this.config = {
      sttProvider: config?.sttProvider || 'openai',
      ttsProvider: config?.ttsProvider || 'openai',
      language: config?.language || 'zh-CN',
      voice: config?.voice,
      speed: config?.speed || 1.0
    };
  }

  /**
   * 获取（并缓存）OpenAI 客户端，避免重复动态导入和实例化
   */
  private getOpenAIClient(): Promise<any> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('请配置 OPENAI_API_KEY');
    }

    if (this.openaiClient) {
      return Promise.resolve(this.openaiClient);
    }

    if (!this.openaiClientPromise) {
      this.openaiClientPromise = import('openai')
        .then(OpenAI => {
          this.openaiClient = new OpenAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          return this.openaiClient;
        })
        .catch(err => {
          // 失败时重置，允许后续重试
          this.openaiClientPromise = null;
          throw err;
        });
    }

    return this.openaiClientPromise;
  }

  /**
   * 语音识别 (STT) - 语音转文字
   */
  async speechToText(audioPath: string): Promise<SpeechResult> {
    const startTime = Date.now();

    switch (this.config.sttProvider) {
      case 'openai':
        return await this.openaiSTT(audioPath, startTime);
      case 'azure':
        return await this.azureSTT(audioPath, startTime);
      case 'google':
        return await this.googleSTT(audioPath, startTime);
      default:
        return await this.localSTT(audioPath, startTime);
    }
  }

  /**
   * OpenAI Whisper STT
   */
  private async openaiSTT(audioPath: string, startTime: number): Promise<SpeechResult> {
    const openai = await this.getOpenAIClient();

    const audioFile = await fs.readFile(audioPath);
    
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile as any,
      model: 'whisper-1',
      language: this.config.language.split('-')[0]
    });

    return {
      text: transcription.text,
      confidence: 0.95,
      duration: Date.now() - startTime
    };
  }

  /**
   * Azure STT
   */
  private azureSTT(audioPath: string, startTime: number): Promise<SpeechResult> {
    // Azure Speech SDK 集成
    // 需要安装: npm install microsoft-cognitiveservices-speech-sdk
    return Promise.reject(new Error('Azure STT 需要安装 microsoft-cognitiveservices-speech-sdk'));
  }

  /**
   * Google STT
   */
  private googleSTT(audioPath: string, startTime: number): Promise<SpeechResult> {
    // Google Cloud Speech-to-Text 集成
    return Promise.reject(new Error('Google STT 需要安装 @google-cloud/speech'));
  }

  /**
   * 本地 STT (使用浏览器或其他本地模型)
   */
  private localSTT(audioPath: string, startTime: number): Promise<SpeechResult> {
    // 可以集成 whisper.cpp 或其他本地模型
    return Promise.reject(new Error('本地STT需要安装 whisper.cpp 或其他本地模型'));
  }

  /**
   * 语音合成 (TTS) - 文字转语音
   */
  async textToSpeech(text: string, outputPath?: string): Promise<Buffer | string> {
    switch (this.config.ttsProvider) {
      case 'openai':
        return await this.openaiTTS(text, outputPath);
      case 'azure':
        return await this.azureTTS(text, outputPath);
      case 'elevenlabs':
        return await this.elevenLabsTTS(text, outputPath);
      default:
        return await this.localTTS(text, outputPath);
    }
  }

  /**
   * OpenAI TTS
   */
  private async openaiTTS(text: string, outputPath?: string): Promise<Buffer | string> {
    const openai = await this.getOpenAIClient();

    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: this.config.voice || 'alloy',
      input: text,
      speed: this.config.speed
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    if (outputPath) {
      await fs.writeFile(outputPath, buffer);
      return outputPath;
    }

    return buffer;
  }

  /**
   * Azure TTS
   */
  private azureTTS(text: string, outputPath?: string): Promise<Buffer | string> {
    return Promise.reject(new Error('Azure TTS 需要安装 microsoft-cognitiveservices-speech-sdk'));
  }

  /**
   * ElevenLabs TTS (高质量语音合成)
   */
  private async elevenLabsTTS(text: string, outputPath?: string): Promise<Buffer | string> {
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error('请配置 ELEVENLABS_API_KEY');
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDh8ikVgQ';
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS 失败: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (outputPath) {
      await fs.writeFile(outputPath, buffer);
      return outputPath;
    }

    return buffer;
  }

  /**
   * 本地 TTS
   */
  private async localTTS(text: string, outputPath?: string): Promise<Buffer | string> {
    // 使用系统自带的 TTS
    const platform = os.platform();
    
    if (platform === 'darwin') {
      // macOS - 使用 say 命令
      const outputFile = outputPath || path.join(os.tmpdir(), `tts-${Date.now()}.aiff`);
      const { execSync } = await import('child_process');
      execSync(`say -o "${outputFile}" "${text}"`);
      return outputFile;
    } else if (platform === 'win32') {
      // Windows - 使用 PowerShell
      throw new Error('Windows 本地TTS需要使用 SAPI');
    }
    
    throw new Error('本地TTS不支持当前平台');
  }

  /**
   * 实时语音识别
   */
  startRealtimeSTT(onResult: (text: string) => void): Promise<void> {
    this.isListening = true;
    console.log('🎤 开始实时语音识别...');

    // 这里可以集成 WebSocket 实时语音流
    // 例如 OpenAI Realtime API 或 Azure Continuous Recognition
    return Promise.resolve();
  }

  /**
   * 停止实时语音识别
   */
  stopRealtimeSTT(): void {
    this.isListening = false;
    console.log('🛑 停止实时语音识别');
  }

  /**
   * 语音对话 - 完整的语音交互流程
   */
  async voiceConversation(
    audioInput: string,
    processText: (text: string) => Promise<string>,
    audioOutput?: string
  ): Promise<{ input: SpeechResult; response: string; audio: Buffer | string }> {
    // 1. 语音转文字
    const sttResult = await this.speechToText(audioInput);
    console.log(`📝 识别结果: ${sttResult.text}`);

    // 2. 处理文字
    const response = await processText(sttResult.text);
    console.log(`🤖 回复: ${response}`);

    // 3. 文字转语音
    const ttsResult = await this.textToSpeech(response, audioOutput);
    console.log(`🔊 语音已生成`);

    return {
      input: sttResult,
      response,
      audio: ttsResult
    };
  }

  /**
   * 获取可用语音列表
   */
  getAvailableVoices(): Promise<string[]> {
    switch (this.config.ttsProvider) {
      case 'openai':
        return Promise.resolve(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
      case 'elevenlabs':
        // 从 ElevenLabs API 获取
        return Promise.resolve(['Rachel', 'Drew', 'Clyde', 'Sarah', 'Adam', 'Bella']);
      default:
        return Promise.resolve(['default']);
    }
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<VoiceConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * 获取当前配置
   */
  getConfig(): VoiceConfig {
    return { ...this.config };
  }
}
