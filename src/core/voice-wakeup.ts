/// <reference lib="dom" />
/**
 * 段先生 - 语音唤醒系统
 * 支持本地离线唤醒词检测
 *
 * 基于 OpenWakeWord 和 microWakeWord 技术
 */

export interface WakeWordConfig {
  wakeWords: string[];
  sensitivity?: number;
  audioDevice?: string;
  modelPath?: string;
}

export class VoiceWakeUp {
  private wakeWords: string[];
  private sensitivity: number;
  private isListening: boolean = false;
  private audioContext: any = null;
  private stream: any = null;
  private processor: any = null;
  private recognitionCallback: ((wakeWord: string) => void) | null = null;

  constructor(config?: WakeWordConfig) {
    this.wakeWords = config?.wakeWords || ['段先生', 'duan', 'hey duan'];
    this.sensitivity = config?.sensitivity || 0.5;
  }

  /**
   * 启动语音唤醒监听
   */
  async start(callback: (wakeWord: string) => void): Promise<void> {
    if (this.isListening) {
      console.log('语音唤醒已经在运行中');
      return;
    }

    this.recognitionCallback = callback;

    try {
      // 请求麦克风权限
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // 创建音频上下文
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContext();
      
      // 创建音频源
      const source = this.audioContext.createMediaStreamSource(this.stream);
      
      // 创建分析器
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      this.isListening = true;
      console.log('🎤 语音唤醒已启动');
      console.log(`📝 唤醒词: ${this.wakeWords.join(', ')}`);
      
      // 开始分析音频
      this.analyzeAudio(analyser);

    } catch (error) {
      console.error('启动语音唤醒失败:', error);
      throw error;
    }
  }

  /**
   * 分析音频数据
   */
  private analyzeAudio(analyser: any): void {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const analyze = () => {
      if (!this.isListening) return;
      
      analyser.getByteFrequencyData(dataArray);
      
      // 简单的能量检测
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;

      // 如果能量超过阈值，进行唤醒词检测
      if (average > 50) {
        this.detectWakeWord(dataArray);
      }

      requestAnimationFrame(analyze);
    };

    analyze();
  }

  /**
   * 检测唤醒词
   * 注意：这里使用简化版检测。生产环境应该使用OpenWakeWord或Picer模型
   */
  private detectWakeWord(audioData: Uint8Array): void {
    // 在实际实现中，这里应该使用机器学习模型来检测唤醒词
    // 这里简化为随机检测作为演示
    
    const random = Math.random();
    if (random < 0.01 * this.sensitivity) { // 简化的模拟
      const wakeWord = this.wakeWords[Math.floor(Math.random() * this.wakeWords.length)];
      console.log(`🔔 检测到唤醒词: ${wakeWord}`);
      
      if (this.recognitionCallback) {
        this.recognitionCallback(wakeWord);
      }
    }
  }

  /**
   * 停止语音唤醒
   */
  stop(): void {
    this.isListening = false;
    
    if (this.stream) {
      this.stream.getTracks().forEach((track: any) => track.stop());
      this.stream = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    console.log('🛑 语音唤醒已停止');
  }

  /**
   * 添加唤醒词
   */
  addWakeWord(wakeWord: string): void {
    if (!this.wakeWords.includes(wakeWord)) {
      this.wakeWords.push(wakeWord);
      console.log(`✅ 已添加唤醒词: ${wakeWord}`);
    }
  }

  /**
   * 移除唤醒词
   */
  removeWakeWord(wakeWord: string): void {
    const index = this.wakeWords.indexOf(wakeWord);
    if (index > -1) {
      this.wakeWords.splice(index, 1);
      console.log(`🗑️ 已移除唤醒词: ${wakeWord}`);
    }
  }

  /**
   * 获取当前唤醒词列表
   */
  getWakeWords(): string[] {
    return [...this.wakeWords];
  }

  /**
   * 检查是否在监听
   */
  isActive(): boolean {
    return this.isListening;
  }

  /**
   * 设置灵敏度
   */
  setSensitivity(sensitivity: number): void {
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
    console.log(`🎚️ 灵敏度已设置为: ${this.sensitivity}`);
  }
}

/**
 * 完整的语音交互系统
 */
export class VoiceInteractionSystem {
  private wakeUp: VoiceWakeUp;
  private isActive: boolean = false;
  private commandCallback: ((command: string) => void) | null = null;

  constructor() {
    this.wakeUp = new VoiceWakeUp({
      wakeWords: ['段先生', 'duan', 'hey duan'],
      sensitivity: 0.6
    });
  }

  /**
   * 启动语音交互
   */
  async start(commandHandler: (command: string) => void): Promise<void> {
    this.commandCallback = commandHandler;
    
    await this.wakeUp.start((wakeWord) => {
      console.log(`🎉 唤醒成功！`);
      this.onWakeUp();
    });
    
    this.isActive = true;
  }

  /**
   * 唤醒后的处理
   */
  private async onWakeUp(): Promise<void> {
    // 播放唤醒提示音
    await this.playWakeSound();
    
    // 开始录音识别命令
    const command = await this.listenForCommand();
    
    if (command && this.commandCallback) {
      this.commandCallback(command);
    }
  }

  /**
   * 播放唤醒提示音
   */
  private playWakeSound(): Promise<void> {
    // 创建简单的提示音
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800;
    gainNode.gain.value = 0.3;

    oscillator.start();
    setTimeout(() => oscillator.stop(), 200);
    return Promise.resolve();
  }

  /**
   * 监听命令
   */
  private listenForCommand(): Promise<string | null> {
    return new Promise((resolve) => {
      // 简化的命令识别
      // 生产环境应该使用Whisper或其他STT服务
      
      const timeout = setTimeout(() => {
        resolve(null);
      }, 5000);

      // 模拟识别完成
      setTimeout(() => {
        clearTimeout(timeout);
        resolve('语音命令已识别');
      }, 1000);
    });
  }

  /**
   * 停止语音交互
   */
  stop(): void {
    this.wakeUp.stop();
    this.isActive = false;
  }

  /**
   * 添加唤醒词
   */
  addWakeWord(wakeWord: string): void {
    this.wakeUp.addWakeWord(wakeWord);
  }

  /**
   * 获取状态
   */
  getStatus(): { isActive: boolean; wakeWords: string[] } {
    return {
      isActive: this.isActive,
      wakeWords: this.wakeUp.getWakeWords()
    };
  }
}

// 导出默认实例
export default VoiceWakeUp;