/**
 * 真实视频生成模块 — VideoGenerationReal
 *
 * 通过 Pika、Runway、Kling、CogVideoX、MiniMax、Luma Dream Machine 等
 * 视频生成 API 实现文本/图片到视频的生成能力。
 *
 * 核心特性：
 * 1. 多供应商支持 — 自动检测可用 API Key 并选择供应商
 * 2. 异步生成 — 提交 → 轮询 → 下载的完整流程
 * 3. 图生视频 — 支持图片 + 文本提示词生成视频
 * 4. 视频延长 — 从已有视频末帧继续生成
 * 5. 视频插值 — 多段视频之间的平滑过渡
 * 6. 事件广播 — 通过 EventBus 广播生成状态变更
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { IncomingMessage } from 'http';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 视频生成选项 */
export interface VideoGenOptions {
  provider?: 'pika' | 'runway' | 'kling' | 'cogvideo' | 'minimax' | 'luma';
  duration?: number;        // 秒（默认 4）
  resolution?: '480p' | '720p' | '1080p';
  aspectRatio?: '16:9' | '9:16' | '1:1';
  fps?: number;             // 默认 24
  style?: string;           // cinematic, anime, realistic 等
  negativePrompt?: string;
  seed?: number;
  outputPath?: string;
}

/** 视频生成结果 */
export interface VideoGenResult {
  taskId: string;
  provider: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  localPath?: string;
  duration: number;
  resolution: string;
  estimatedTime?: number;   // 预计完成剩余秒数
}

/** 视频供应商信息 */
export interface VideoProvider {
  name: string;
  id: string;
  available: boolean;
  capabilities: {
    maxDuration: number;
    resolutions: string[];
    aspectRatios: string[];
    imageToVideo: boolean;
    videoExtend: boolean;
  };
  apiKeyEnv: string;        // API Key 对应的环境变量名
}

/** HTTP 请求选项 */
interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

/** HTTP 响应 */
interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 生成统计 */
interface GenerationStats {
  totalGenerated: number;
  totalFailed: number;
  byProvider: Record<string, { count: number; failed: number }>;
  avgGenerationTime: number;
  totalDuration: number;
}

// ============ 供应商配置 ============

const PROVIDER_CONFIGS: Array<Omit<VideoProvider, 'available'>> = [
  {
    name: 'Pika',
    id: 'pika',
    capabilities: {
      maxDuration: 10,
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      imageToVideo: true,
      videoExtend: true,
    },
    apiKeyEnv: 'PIKA_API_KEY',
  },
  {
    name: 'Runway Gen-2',
    id: 'runway',
    capabilities: {
      maxDuration: 16,
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      imageToVideo: true,
      videoExtend: true,
    },
    apiKeyEnv: 'RUNWAY_API_KEY',
  },
  {
    name: 'Kling (快手)',
    id: 'kling',
    capabilities: {
      maxDuration: 10,
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      imageToVideo: true,
      videoExtend: true,
    },
    apiKeyEnv: 'KLING_API_KEY',
  },
  {
    name: 'CogVideoX (智谱)',
    id: 'cogvideo',
    capabilities: {
      maxDuration: 6,
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      imageToVideo: false,
      videoExtend: false,
    },
    apiKeyEnv: 'ZHIPUAI_API_KEY',
  },
  {
    name: 'MiniMax',
    id: 'minimax',
    capabilities: {
      maxDuration: 6,
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      imageToVideo: true,
      videoExtend: false,
    },
    apiKeyEnv: 'MINIMAX_API_KEY',
  },
  {
    name: 'Luma Dream Machine',
    id: 'luma',
    capabilities: {
      maxDuration: 5,
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      imageToVideo: true,
      videoExtend: true,
    },
    apiKeyEnv: 'LUMA_API_KEY',
  },
];

// ============ 主类 ============

export class VideoGenerationReal {
  private log = logger.child({ module: 'VideoGenerationReal' });
  private providers: VideoProvider[] = [];
  private pendingTasks = new Map<string, VideoGenResult>();
  private videoDir: string;
  private stats: GenerationStats = {
    totalGenerated: 0,
    totalFailed: 0,
    byProvider: {},
    avgGenerationTime: 0,
    totalDuration: 0,
  };
  private generationTimes: number[] = [];

  constructor() {
    // 初始化视频输出目录
    this.videoDir = duanPath('videos');
    fs.mkdirSync(this.videoDir, { recursive: true });

    // 检测可用供应商
    this.providers = PROVIDER_CONFIGS.map(config => ({
      ...config,
      available: !!process.env[config.apiKeyEnv],
    }));

    const availableCount = this.providers.filter(p => p.available).length;
    this.log.info('视频生成模块初始化', {
      availableProviders: availableCount,
      totalProviders: this.providers.length,
      videoDir: this.videoDir,
    });

    // 广播初始化事件
    EventBus.getInstance().emitSync('video_generation.initialized', {
      availableProviders: availableCount,
      providers: this.providers.map(p => ({ id: p.id, name: p.name, available: p.available })),
    }, { source: 'VideoGenerationReal' });
  }

  // ========== 公开方法 ==========

  /**
   * 从文本提示词生成视频
   */
  async generateVideo(prompt: string, options?: VideoGenOptions): Promise<VideoGenResult> {
    const startTime = Date.now();

    // 选择供应商
    const provider = this.selectProvider(options?.provider);
    if (!provider) {
      this.log.error('无可用的视频生成供应商', { prompt: prompt.substring(0, 50) });
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: options?.resolution || '720p',
      };
    }

    const duration = Math.min(options?.duration || 4, provider.capabilities.maxDuration);
    const resolution = options?.resolution || '720p';
    const aspectRatio = options?.aspectRatio || '16:9';

    this.log.info('开始生成视频', {
      provider: provider.id,
      prompt: prompt.substring(0, 80),
      duration,
      resolution,
      aspectRatio,
    });

    // 广播生成开始事件
    EventBus.getInstance().emitSync('video_generation.started', {
      provider: provider.id,
      prompt: prompt.substring(0, 100),
      duration,
      resolution,
    }, { source: 'VideoGenerationReal' });

    try {
      const result = await this.submitToProvider(provider, prompt, {
        ...options,
        duration,
        resolution,
        aspectRatio,
      });

      // 记录待处理任务
      this.pendingTasks.set(result.taskId, result);

      // 轮询等待完成
      const finalResult = await this.pollUntilComplete(result.taskId, provider);

      // 更新统计
      const elapsed = Date.now() - startTime;
      this.updateStats(provider.id, finalResult.status === 'completed', elapsed, duration);

      // 下载视频
      if (finalResult.status === 'completed' && finalResult.videoUrl) {
        const localPath = await this.downloadVideo(finalResult.videoUrl, options?.outputPath);
        finalResult.localPath = localPath;
      }

      // 广播完成事件
      EventBus.getInstance().emitSync('video_generation.completed', {
        taskId: finalResult.taskId,
        provider: provider.id,
        status: finalResult.status,
        localPath: finalResult.localPath,
      }, { source: 'VideoGenerationReal' });

      return finalResult;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('视频生成失败', { provider: provider.id, error: errorMsg });

      this.updateStats(provider.id, false, Date.now() - startTime, duration);

      EventBus.getInstance().emitSync('video_generation.failed', {
        provider: provider.id,
        error: errorMsg,
      }, { source: 'VideoGenerationReal' });

      return {
        taskId: '',
        provider: provider.id,
        status: 'failed',
        duration,
        resolution,
      };
    }
  }

  /**
   * 从图片生成视频（图生视频）
   */
  async generateVideoFromImage(imagePath: string, prompt: string, options?: VideoGenOptions): Promise<VideoGenResult> {
    // 验证图片文件存在
    if (!fs.existsSync(imagePath)) {
      this.log.error('图片文件不存在', { imagePath });
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: options?.resolution || '720p',
      };
    }

    // 选择支持图生视频的供应商
    const provider = this.selectProvider(options?.provider, true);
    if (!provider) {
      this.log.error('无支持图生视频的可用供应商');
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: options?.resolution || '720p',
      };
    }

    const duration = Math.min(options?.duration || 4, provider.capabilities.maxDuration);
    const resolution = options?.resolution || '720p';
    const aspectRatio = options?.aspectRatio || '16:9';

    this.log.info('开始图生视频', {
      provider: provider.id,
      imagePath,
      prompt: prompt.substring(0, 80),
      duration,
    });

    EventBus.getInstance().emitSync('video_generation.image_to_video_started', {
      provider: provider.id,
      imagePath,
      prompt: prompt.substring(0, 100),
    }, { source: 'VideoGenerationReal' });

    try {
      // 读取图片并转为 base64
      const imageBuffer = fs.readFileSync(imagePath);
      const imageBase64 = imageBuffer.toString('base64');
      const imageExt = path.extname(imagePath).slice(1).toLowerCase();
      const mimeType = imageExt === 'png' ? 'image/png' : 'image/jpeg';

      const result = await this.submitImageToProvider(provider, prompt, imageBase64, mimeType, {
        ...options,
        duration,
        resolution,
        aspectRatio,
      });

      this.pendingTasks.set(result.taskId, result);

      const finalResult = await this.pollUntilComplete(result.taskId, provider);

      if (finalResult.status === 'completed' && finalResult.videoUrl) {
        const localPath = await this.downloadVideo(finalResult.videoUrl, options?.outputPath);
        finalResult.localPath = localPath;
      }

      EventBus.getInstance().emitSync('video_generation.image_to_video_completed', {
        taskId: finalResult.taskId,
        provider: provider.id,
        status: finalResult.status,
      }, { source: 'VideoGenerationReal' });

      return finalResult;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('图生视频失败', { provider: provider.id, error: errorMsg });

      return {
        taskId: '',
        provider: provider.id,
        status: 'failed',
        duration,
        resolution,
      };
    }
  }

  /**
   * 查询视频生成任务状态
   */
  async getTaskStatus(taskId: string): Promise<VideoGenResult> {
    // 先从本地缓存查找
    const cached = this.pendingTasks.get(taskId);
    if (!cached) {
      this.log.warn('未找到任务', { taskId });
      return {
        taskId,
        provider: 'unknown',
        status: 'failed',
        duration: 0,
        resolution: 'unknown',
      };
    }

    // 如果已完成或失败，直接返回缓存
    if (cached.status === 'completed' || cached.status === 'failed') {
      return cached;
    }

    // 向供应商查询最新状态
    const provider = this.providers.find(p => p.id === cached.provider);
    if (!provider) {
      return cached;
    }

    try {
      const status = await this.pollProvider(taskId, provider);
      cached.status = status.status;
      if (status.videoUrl) cached.videoUrl = status.videoUrl;
      if (status.estimatedTime !== undefined) cached.estimatedTime = status.estimatedTime;
      this.pendingTasks.set(taskId, cached);
      return cached;
    } catch (err: unknown) {
      this.log.error('查询任务状态失败', { taskId, error: err instanceof Error ? err.message : String(err) });
      return cached;
    }
  }

  /**
   * 列出可用供应商
   */
  listProviders(): VideoProvider[] {
    return this.providers;
  }

  /**
   * 延长已有视频
   */
  async extendVideo(videoPath: string, prompt: string): Promise<VideoGenResult> {
    if (!fs.existsSync(videoPath)) {
      this.log.error('视频文件不存在', { videoPath });
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: '720p',
      };
    }

    // 选择支持视频延长的供应商
    const provider = this.selectProvider(undefined, false, true);
    if (!provider) {
      this.log.error('无支持视频延长的可用供应商');
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: '720p',
      };
    }

    this.log.info('开始延长视频', { provider: provider.id, videoPath, prompt: prompt.substring(0, 80) });

    EventBus.getInstance().emitSync('video_generation.extend_started', {
      provider: provider.id,
      videoPath,
    }, { source: 'VideoGenerationReal' });

    try {
      const videoBuffer = fs.readFileSync(videoPath);
      const videoBase64 = videoBuffer.toString('base64');

      const result = await this.submitExtendToProvider(provider, prompt, videoBase64, videoPath);
      this.pendingTasks.set(result.taskId, result);

      const finalResult = await this.pollUntilComplete(result.taskId, provider);

      if (finalResult.status === 'completed' && finalResult.videoUrl) {
        const outputPath = videoPath.replace(/(\.\w+)$/, '_extended$1');
        const localPath = await this.downloadVideo(finalResult.videoUrl, outputPath);
        finalResult.localPath = localPath;
      }

      return finalResult;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('视频延长失败', { provider: provider.id, error: errorMsg });
      return {
        taskId: '',
        provider: provider.id,
        status: 'failed',
        duration: 0,
        resolution: '720p',
      };
    }
  }

  /**
   * 多段视频插值过渡
   */
  async interpolateVideos(videoPaths: string[]): Promise<VideoGenResult> {
    if (videoPaths.length < 2) {
      this.log.error('插值至少需要两段视频');
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: '720p',
      };
    }

    // 验证所有视频文件存在
    for (const vp of videoPaths) {
      if (!fs.existsSync(vp)) {
        this.log.error('视频文件不存在', { videoPath: vp });
        return {
          taskId: '',
          provider: 'none',
          status: 'failed',
          duration: 0,
          resolution: '720p',
        };
      }
    }

    // 选择支持视频延长的供应商（插值功能依赖类似 API）
    const provider = this.selectProvider(undefined, false, true);
    if (!provider) {
      this.log.error('无支持视频插值的可用供应商');
      return {
        taskId: '',
        provider: 'none',
        status: 'failed',
        duration: 0,
        resolution: '720p',
      };
    }

    this.log.info('开始视频插值', { provider: provider.id, videoCount: videoPaths.length });

    EventBus.getInstance().emitSync('video_generation.interpolate_started', {
      provider: provider.id,
      videoCount: videoPaths.length,
    }, { source: 'VideoGenerationReal' });

    try {
      const result = await this.submitInterpolateToProvider(provider, videoPaths);
      this.pendingTasks.set(result.taskId, result);

      const finalResult = await this.pollUntilComplete(result.taskId, provider);

      if (finalResult.status === 'completed' && finalResult.videoUrl) {
        const outputPath = path.join(this.videoDir, `interpolated_${Date.now()}.mp4`);
        const localPath = await this.downloadVideo(finalResult.videoUrl, outputPath);
        finalResult.localPath = localPath;
      }

      return finalResult;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('视频插值失败', { provider: provider.id, error: errorMsg });
      return {
        taskId: '',
        provider: provider.id,
        status: 'failed',
        duration: 0,
        resolution: '720p',
      };
    }
  }

  /**
   * 获取生成统计
   */
  getStats(): GenerationStats {
    return { ...this.stats };
  }

  /**
   * 获取工具定义（供 Agent Loop 注册）
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
    const vgr = this;

    return [
      {
        name: 'video_gen_real',
        description: '通过真实视频生成 API 从文本提示词生成视频。支持 Pika、Runway、Kling、CogVideoX、MiniMax、Luma 等供应商。自动选择可用供应商。',
        parameters: {
          prompt: { type: 'string', description: '视频内容描述（文本提示词）', required: true },
          provider: { type: 'string', description: '供应商: pika / runway / kling / cogvideo / minimax / luma（可选，默认自动选择）', required: false },
          duration: { type: 'string', description: '视频时长（秒），默认 4', required: false },
          resolution: { type: 'string', description: '分辨率: 480p / 720p / 1080p，默认 720p', required: false },
          aspect_ratio: { type: 'string', description: '宽高比: 16:9 / 9:16 / 1:1，默认 16:9', required: false },
          fps: { type: 'string', description: '帧率，默认 24', required: false },
          style: { type: 'string', description: '风格: cinematic / anime / realistic 等', required: false },
          negative_prompt: { type: 'string', description: '反向提示词（排除的内容）', required: false },
          seed: { type: 'string', description: '随机种子（固定种子可复现结果）', required: false },
        },
        execute: async (args) => {
          try {
            const options: VideoGenOptions = {
              provider: args.provider as VideoGenOptions['provider'],
              duration: args.duration ? parseInt(args.duration as string, 10) : undefined,
              resolution: args.resolution as VideoGenOptions['resolution'],
              aspectRatio: args.aspect_ratio as VideoGenOptions['aspectRatio'],
              fps: args.fps ? parseInt(args.fps as string, 10) : undefined,
              style: args.style as string,
              negativePrompt: args.negative_prompt as string,
              seed: args.seed ? parseInt(args.seed as string, 10) : undefined,
            };
            const result = await vgr.generateVideo(args.prompt as string, options);
            if (result.status === 'failed') {
              return `❌ 视频生成失败 (供应商: ${result.provider})`;
            }
            return `🎬 视频生成${result.status === 'completed' ? '完成' : '进行中'}\n` +
              `  任务ID: ${result.taskId}\n` +
              `  供应商: ${result.provider}\n` +
              `  状态: ${result.status}\n` +
              `  时长: ${result.duration}s | 分辨率: ${result.resolution}\n` +
              (result.videoUrl ? `  视频URL: ${result.videoUrl}\n` : '') +
              (result.localPath ? `  本地路径: ${result.localPath}` : '') +
              (result.estimatedTime ? `\n  预计剩余: ${result.estimatedTime}s` : '');
          } catch (err: unknown) {
            return `❌ 视频生成错误: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'video_gen_from_image',
        description: '从图片和文本提示词生成视频（图生视频）。上传参考图片，结合提示词生成视频。',
        parameters: {
          image_path: { type: 'string', description: '参考图片的本地文件路径', required: true },
          prompt: { type: 'string', description: '视频内容描述（文本提示词）', required: true },
          provider: { type: 'string', description: '供应商: pika / runway / kling / minimax / luma（可选，默认自动选择）', required: false },
          duration: { type: 'string', description: '视频时长（秒），默认 4', required: false },
          resolution: { type: 'string', description: '分辨率: 480p / 720p / 1080p，默认 720p', required: false },
          aspect_ratio: { type: 'string', description: '宽高比: 16:9 / 9:16 / 1:1，默认 16:9', required: false },
        },
        execute: async (args) => {
          try {
            const options: VideoGenOptions = {
              provider: args.provider as VideoGenOptions['provider'],
              duration: args.duration ? parseInt(args.duration as string, 10) : undefined,
              resolution: args.resolution as VideoGenOptions['resolution'],
              aspectRatio: args.aspect_ratio as VideoGenOptions['aspectRatio'],
            };
            const result = await vgr.generateVideoFromImage(
              args.image_path as string,
              args.prompt as string,
              options,
            );
            if (result.status === 'failed') {
              return `❌ 图生视频失败 (供应商: ${result.provider})`;
            }
            return `🎬 图生视频${result.status === 'completed' ? '完成' : '进行中'}\n` +
              `  任务ID: ${result.taskId}\n` +
              `  供应商: ${result.provider}\n` +
              `  状态: ${result.status}\n` +
              (result.localPath ? `  本地路径: ${result.localPath}` : '') +
              (result.estimatedTime ? `\n  预计剩余: ${result.estimatedTime}s` : '');
          } catch (err: unknown) {
            return `❌ 图生视频错误: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'video_gen_status',
        description: '查询视频生成任务的状态。返回任务是否完成、视频 URL、本地路径等信息。',
        parameters: {
          task_id: { type: 'string', description: '视频生成任务 ID', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await vgr.getTaskStatus(args.task_id as string);
            return `📋 任务状态\n` +
              `  任务ID: ${result.taskId}\n` +
              `  供应商: ${result.provider}\n` +
              `  状态: ${result.status}\n` +
              `  时长: ${result.duration}s | 分辨率: ${result.resolution}\n` +
              (result.videoUrl ? `  视频URL: ${result.videoUrl}\n` : '') +
              (result.localPath ? `  本地路径: ${result.localPath}\n` : '') +
              (result.estimatedTime ? `  预计剩余: ${result.estimatedTime}s` : '');
          } catch (err: unknown) {
            return `❌ 查询失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'video_gen_providers',
        description: '列出所有可用的视频生成供应商，显示哪些已配置 API Key 以及各供应商的能力（最大时长、分辨率、是否支持图生视频等）。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const providers = vgr.listProviders();
          const lines = providers.map(p =>
            `${p.available ? '✅' : '❌'} ${p.name} (${p.id})\n` +
            `   最大时长: ${p.capabilities.maxDuration}s | 分辨率: ${p.capabilities.resolutions.join(', ')}\n` +
            `   宽高比: ${p.capabilities.aspectRatios.join(', ')}\n` +
            `   图生视频: ${p.capabilities.imageToVideo ? '✓' : '✗'} | 视频延长: ${p.capabilities.videoExtend ? '✓' : '✗'}\n` +
            `   API Key 环境变量: ${p.apiKeyEnv}`
          );
          return Promise.resolve(`🎬 视频生成供应商列表\n\n${lines.join('\n\n')}`);
        },
      },
      {
        name: 'video_gen_extend',
        description: '延长已有视频。从视频末帧继续生成，使视频更长。',
        parameters: {
          video_path: { type: 'string', description: '要延长的视频文件本地路径', required: true },
          prompt: { type: 'string', description: '延续内容的文本描述', required: true },
        },
        execute: async (args) => {
          try {
            const result = await vgr.extendVideo(args.video_path as string, args.prompt as string);
            if (result.status === 'failed') {
              return `❌ 视频延长失败 (供应商: ${result.provider})`;
            }
            return `🎬 视频延长${result.status === 'completed' ? '完成' : '进行中'}\n` +
              `  任务ID: ${result.taskId}\n` +
              `  供应商: ${result.provider}\n` +
              `  状态: ${result.status}\n` +
              (result.localPath ? `  本地路径: ${result.localPath}` : '');
          } catch (err: unknown) {
            return `❌ 视频延长错误: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'video_gen_interpolate',
        description: '在多段视频之间创建平滑过渡（插值/变形）。至少需要两段视频。',
        parameters: {
          video_paths: { type: 'string', description: '视频文件路径列表，逗号分隔（至少两个）', required: true },
        },
        execute: async (args) => {
          try {
            const paths = (args.video_paths as string)
              .split(',')
              .map(p => p.trim())
              .filter(p => p.length > 0);
            if (paths.length < 2) {
              return '❌ 插值至少需要两段视频路径，用逗号分隔';
            }
            const result = await vgr.interpolateVideos(paths);
            if (result.status === 'failed') {
              return `❌ 视频插值失败 (供应商: ${result.provider})`;
            }
            return `🎬 视频插值${result.status === 'completed' ? '完成' : '进行中'}\n` +
              `  任务ID: ${result.taskId}\n` +
              `  供应商: ${result.provider}\n` +
              `  状态: ${result.status}\n` +
              (result.localPath ? `  本地路径: ${result.localPath}` : '');
          } catch (err: unknown) {
            return `❌ 视频插值错误: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /**
   * 选择供应商
   * @param preferredProvider 指定供应商
   * @param requireImageToVideo 是否需要支持图生视频
   * @param requireVideoExtend 是否需要支持视频延长
   */
  private selectProvider(
    preferredProvider?: string,
    requireImageToVideo?: boolean,
    requireVideoExtend?: boolean,
  ): VideoProvider | null {
    // 如果指定了供应商，优先使用
    if (preferredProvider) {
      const provider = this.providers.find(p => p.id === preferredProvider && p.available);
      if (provider) {
        if (requireImageToVideo && !provider.capabilities.imageToVideo) {
          this.log.warn('指定供应商不支持图生视频', { provider: provider.id });
          return null;
        }
        if (requireVideoExtend && !provider.capabilities.videoExtend) {
          this.log.warn('指定供应商不支持视频延长', { provider: provider.id });
          return null;
        }
        return provider;
      }
      this.log.warn('指定的供应商不可用', { provider: preferredProvider });
    }

    // 自动选择第一个满足条件的可用供应商
    const candidates = this.providers.filter(p => {
      if (!p.available) return false;
      if (requireImageToVideo && !p.capabilities.imageToVideo) return false;
      if (requireVideoExtend && !p.capabilities.videoExtend) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // 优先选择能力最强的供应商（分辨率高、时长长的优先）
    candidates.sort((a, b) => {
      const aScore = a.capabilities.maxDuration + a.capabilities.resolutions.length;
      const bScore = b.capabilities.maxDuration + b.capabilities.resolutions.length;
      return bScore - aScore;
    });

    return candidates[0];
  }

  /**
   * 向供应商提交文本生成视频任务
   */
  private submitToProvider(
    provider: VideoProvider,
    prompt: string,
    options: VideoGenOptions,
  ): Promise<VideoGenResult> {
    const taskId = `vg_${provider.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    switch (provider.id) {
      case 'pika':
        return this.submitToPika(prompt, options, taskId);
      case 'runway':
        return this.submitToRunway(prompt, options, taskId);
      case 'kling':
        return this.submitToKling(prompt, options, taskId);
      case 'cogvideo':
        return this.submitToCogVideo(prompt, options, taskId);
      case 'minimax':
        return this.submitToMiniMax(prompt, options, taskId);
      case 'luma':
        return this.submitToLuma(prompt, options, taskId);
      default:
        throw new Error(`不支持的供应商: ${provider.id}`);
    }
  }

  /**
   * 向供应商提交图生视频任务
   */
  private submitImageToProvider(
    provider: VideoProvider,
    prompt: string,
    imageBase64: string,
    mimeType: string,
    options: VideoGenOptions,
  ): Promise<VideoGenResult> {
    const taskId = `vg_${provider.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    switch (provider.id) {
      case 'pika':
        return this.submitImageToPika(prompt, imageBase64, mimeType, options, taskId);
      case 'runway':
        return this.submitImageToRunway(prompt, imageBase64, mimeType, options, taskId);
      case 'kling':
        return this.submitImageToKling(prompt, imageBase64, mimeType, options, taskId);
      case 'minimax':
        return this.submitImageToMiniMax(prompt, imageBase64, mimeType, options, taskId);
      case 'luma':
        return this.submitImageToLuma(prompt, imageBase64, mimeType, options, taskId);
      default:
        throw new Error(`供应商 ${provider.id} 不支持图生视频`);
    }
  }

  /**
   * 向供应商提交视频延长任务
   */
  private async submitExtendToProvider(
    provider: VideoProvider,
    prompt: string,
    videoBase64: string,
    _videoPath: string,
  ): Promise<VideoGenResult> {
    const taskId = `vg_ext_${provider.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    switch (provider.id) {
      case 'pika': {
        const apiKey = process.env.PIKA_API_KEY || '';
        const body = JSON.stringify({
          prompt,
          video: videoBase64,
          duration: 4,
          mode: 'extend',
        });
        const response = await this.httpRequest('https://api.pika.art/v1/generate', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const data = JSON.parse(response.body);
        return {
          taskId: data.id || taskId,
          provider: provider.id,
          status: 'pending',
          duration: 4,
          resolution: '720p',
          estimatedTime: 60,
        };
      }
      case 'runway': {
        const apiKey = process.env.RUNWAY_API_KEY || '';
        const body = JSON.stringify({
          promptText: prompt,
          promptImage: `data:video/mp4;base64,${videoBase64}`,
          duration: 4,
          mode: 'extend',
        });
        const response = await this.httpRequest('https://api.dev.runwayml.com/v1/image_to_video', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const data = JSON.parse(response.body);
        return {
          taskId: data.id || taskId,
          provider: provider.id,
          status: 'pending',
          duration: 4,
          resolution: '720p',
          estimatedTime: 60,
        };
      }
      case 'luma': {
        const apiKey = process.env.LUMA_API_KEY || '';
        const body = JSON.stringify({
          prompt,
          keyframes: { video0: { type: 'video', video: videoBase64 } },
        });
        const response = await this.httpRequest('https://api.lumalabs.ai/dream-machine/v1/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const data = JSON.parse(response.body);
        return {
          taskId: data.id || taskId,
          provider: provider.id,
          status: 'pending',
          duration: 5,
          resolution: '720p',
          estimatedTime: 60,
        };
      }
      default:
        throw new Error(`供应商 ${provider.id} 不支持视频延长`);
    }
  }

  /**
   * 向供应商提交视频插值任务
   */
  private async submitInterpolateToProvider(
    provider: VideoProvider,
    videoPaths: string[],
  ): Promise<VideoGenResult> {
    const taskId = `vg_interp_${provider.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 读取所有视频为 base64
    const videos = videoPaths.map(vp => {
      const buffer = fs.readFileSync(vp);
      return buffer.toString('base64');
    });

    switch (provider.id) {
      case 'pika': {
        const apiKey = process.env.PIKA_API_KEY || '';
        const body = JSON.stringify({
          prompt: 'smooth transition interpolation',
          videos,
          mode: 'interpolate',
          duration: 4,
        });
        const response = await this.httpRequest('https://api.pika.art/v1/generate', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const data = JSON.parse(response.body);
        return {
          taskId: data.id || taskId,
          provider: provider.id,
          status: 'pending',
          duration: 4,
          resolution: '720p',
          estimatedTime: 90,
        };
      }
      case 'luma': {
        const apiKey = process.env.LUMA_API_KEY || '';
        const keyframes: Record<string, { type: string; video: string }> = {};
        videos.forEach((v, i) => {
          keyframes[`video${i}`] = { type: 'video', video: v };
        });
        const body = JSON.stringify({
          prompt: 'smooth transition between clips',
          keyframes,
        });
        const response = await this.httpRequest('https://api.lumalabs.ai/dream-machine/v1/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const data = JSON.parse(response.body);
        return {
          taskId: data.id || taskId,
          provider: provider.id,
          status: 'pending',
          duration: 5,
          resolution: '720p',
          estimatedTime: 90,
        };
      }
      default:
        throw new Error(`供应商 ${provider.id} 不支持视频插值`);
    }
  }

  // ========== 供应商提交实现 ==========

  /**
   * Pika — 文本生成视频
   */
  private async submitToPika(prompt: string, options: VideoGenOptions, taskId: string): Promise<VideoGenResult> {
    const apiKey = process.env.PIKA_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      aspect_ratio: options.aspectRatio || '16:9',
      fps: options.fps || 24,
      style: options.style,
      negative_prompt: options.negativePrompt,
      seed: options.seed,
    });

    const response = await this.httpRequest('https://api.pika.art/v1/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.id || taskId,
      provider: 'pika',
      status: 'pending',
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      estimatedTime: 60,
    };
  }

  /**
   * Pika — 图生视频
   */
  private async submitImageToPika(
    prompt: string,
    imageBase64: string,
    mimeType: string,
    options: VideoGenOptions,
    taskId: string,
  ): Promise<VideoGenResult> {
    const apiKey = process.env.PIKA_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      image: `data:${mimeType};base64,${imageBase64}`,
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      aspect_ratio: options.aspectRatio || '16:9',
    });

    const response = await this.httpRequest('https://api.pika.art/v1/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.id || taskId,
      provider: 'pika',
      status: 'pending',
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      estimatedTime: 60,
    };
  }

  /**
   * Runway — 文本生成视频
   */
  private async submitToRunway(prompt: string, options: VideoGenOptions, taskId: string): Promise<VideoGenResult> {
    const apiKey = process.env.RUNWAY_API_KEY || '';
    const body = JSON.stringify({
      promptText: prompt,
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
    });

    const response = await this.httpRequest('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.id || taskId,
      provider: 'runway',
      status: 'pending',
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      estimatedTime: 90,
    };
  }

  /**
   * Runway — 图生视频
   */
  private async submitImageToRunway(
    prompt: string,
    imageBase64: string,
    mimeType: string,
    options: VideoGenOptions,
    taskId: string,
  ): Promise<VideoGenResult> {
    const apiKey = process.env.RUNWAY_API_KEY || '';
    const body = JSON.stringify({
      promptImage: `data:${mimeType};base64,${imageBase64}`,
      promptText: prompt,
      duration: options.duration || 4,
    });

    const response = await this.httpRequest('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.id || taskId,
      provider: 'runway',
      status: 'pending',
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      estimatedTime: 90,
    };
  }

  /**
   * Kling — 文本生成视频
   */
  private async submitToKling(prompt: string, options: VideoGenOptions, taskId: string): Promise<VideoGenResult> {
    const apiKey = process.env.KLING_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      aspect_ratio: options.aspectRatio || '16:9',
      style: options.style,
      negative_prompt: options.negativePrompt,
      seed: options.seed,
    });

    const response = await this.httpRequest('https://api.klingai.com/v1/videos/image2video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.data?.task_id || data.id || taskId,
      provider: 'kling',
      status: 'pending',
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      estimatedTime: 60,
    };
  }

  /**
   * Kling — 图生视频
   */
  private async submitImageToKling(
    prompt: string,
    imageBase64: string,
    mimeType: string,
    options: VideoGenOptions,
    taskId: string,
  ): Promise<VideoGenResult> {
    const apiKey = process.env.KLING_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      image: `data:${mimeType};base64,${imageBase64}`,
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      aspect_ratio: options.aspectRatio || '16:9',
    });

    const response = await this.httpRequest('https://api.klingai.com/v1/videos/image2video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.data?.task_id || data.id || taskId,
      provider: 'kling',
      status: 'pending',
      duration: options.duration || 4,
      resolution: options.resolution || '720p',
      estimatedTime: 60,
    };
  }

  /**
   * CogVideoX (智谱) — 文本生成视频
   */
  private async submitToCogVideo(prompt: string, options: VideoGenOptions, taskId: string): Promise<VideoGenResult> {
    const apiKey = process.env.ZHIPUAI_API_KEY || '';
    const body = JSON.stringify({
      model: 'cogvideox-2',
      prompt,
      duration: options.duration || 6,
      resolution: options.resolution || '720p',
      fps: options.fps || 24,
      style: options.style,
    });

    const response = await this.httpRequest('https://open.bigmodel.cn/api/paas/v4/videos/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.data?.task_id || data.id || taskId,
      provider: 'cogvideo',
      status: 'pending',
      duration: options.duration || 6,
      resolution: options.resolution || '720p',
      estimatedTime: 120,
    };
  }

  /**
   * MiniMax — 文本生成视频
   */
  private async submitToMiniMax(prompt: string, options: VideoGenOptions, taskId: string): Promise<VideoGenResult> {
    const apiKey = process.env.MINIMAX_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      duration: options.duration || 6,
      resolution: options.resolution || '720p',
      aspect_ratio: options.aspectRatio || '16:9',
      style: options.style,
      negative_prompt: options.negativePrompt,
      seed: options.seed,
    });

    const response = await this.httpRequest('https://api.minimaxi.com/v1/video_generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.data?.task_id || data.id || taskId,
      provider: 'minimax',
      status: 'pending',
      duration: options.duration || 6,
      resolution: options.resolution || '720p',
      estimatedTime: 90,
    };
  }

  /**
   * MiniMax — 图生视频
   */
  private async submitImageToMiniMax(
    prompt: string,
    imageBase64: string,
    mimeType: string,
    options: VideoGenOptions,
    taskId: string,
  ): Promise<VideoGenResult> {
    const apiKey = process.env.MINIMAX_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      image: `data:${mimeType};base64,${imageBase64}`,
      duration: options.duration || 6,
      resolution: options.resolution || '720p',
      aspect_ratio: options.aspectRatio || '16:9',
    });

    const response = await this.httpRequest('https://api.minimaxi.com/v1/video_generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.data?.task_id || data.id || taskId,
      provider: 'minimax',
      status: 'pending',
      duration: options.duration || 6,
      resolution: options.resolution || '720p',
      estimatedTime: 90,
    };
  }

  /**
   * Luma Dream Machine — 文本生成视频
   */
  private async submitToLuma(prompt: string, options: VideoGenOptions, taskId: string): Promise<VideoGenResult> {
    const apiKey = process.env.LUMA_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      aspect_ratio: options.aspectRatio || '16:9',
    });

    const response = await this.httpRequest('https://api.lumalabs.ai/dream-machine/v1/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.id || taskId,
      provider: 'luma',
      status: 'pending',
      duration: options.duration || 5,
      resolution: options.resolution || '720p',
      estimatedTime: 60,
    };
  }

  /**
   * Luma Dream Machine — 图生视频
   */
  private async submitImageToLuma(
    prompt: string,
    imageBase64: string,
    mimeType: string,
    options: VideoGenOptions,
    taskId: string,
  ): Promise<VideoGenResult> {
    const apiKey = process.env.LUMA_API_KEY || '';
    const body = JSON.stringify({
      prompt,
      keyframes: { frame0: { type: 'image', url: `data:${mimeType};base64,${imageBase64}` } },
      aspect_ratio: options.aspectRatio || '16:9',
    });

    const response = await this.httpRequest('https://api.lumalabs.ai/dream-machine/v1/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const data = JSON.parse(response.body);
    return {
      taskId: data.id || taskId,
      provider: 'luma',
      status: 'pending',
      duration: options.duration || 5,
      resolution: options.resolution || '720p',
      estimatedTime: 60,
    };
  }

  // ========== 轮询与下载 ==========

  /**
   * 轮询供应商获取任务状态
   */
  private async pollProvider(taskId: string, provider: VideoProvider): Promise<VideoGenResult> {
    switch (provider.id) {
      case 'pika': {
        const apiKey = process.env.PIKA_API_KEY || '';
        const response = await this.httpRequest(`https://api.pika.art/v1/tasks/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = JSON.parse(response.body);
        return {
          taskId,
          provider: 'pika',
          status: this.mapPikaStatus(data.status),
          videoUrl: data.video_url,
          duration: data.duration || 4,
          resolution: data.resolution || '720p',
          estimatedTime: data.estimated_time,
        };
      }
      case 'runway': {
        const apiKey = process.env.RUNWAY_API_KEY || '';
        const response = await this.httpRequest(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = JSON.parse(response.body);
        return {
          taskId,
          provider: 'runway',
          status: this.mapRunwayStatus(data.status),
          videoUrl: data.output?.[0],
          duration: data.duration || 4,
          resolution: data.resolution || '720p',
          estimatedTime: data.estimated_time,
        };
      }
      case 'kling': {
        const apiKey = process.env.KLING_API_KEY || '';
        const response = await this.httpRequest(`https://api.klingai.com/v1/videos/image2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = JSON.parse(response.body);
        return {
          taskId,
          provider: 'kling',
          status: this.mapKlingStatus(data.data?.task_status),
          videoUrl: data.data?.video_url,
          duration: data.data?.duration || 4,
          resolution: data.data?.resolution || '720p',
        };
      }
      case 'cogvideo': {
        const apiKey = process.env.ZHIPUAI_API_KEY || '';
        const response = await this.httpRequest(`https://open.bigmodel.cn/api/paas/v4/videos/generations/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = JSON.parse(response.body);
        return {
          taskId,
          provider: 'cogvideo',
          status: this.mapCogVideoStatus(data.data?.task_status),
          videoUrl: data.data?.video_url,
          duration: data.data?.duration || 6,
          resolution: data.data?.resolution || '720p',
        };
      }
      case 'minimax': {
        const apiKey = process.env.MINIMAX_API_KEY || '';
        const response = await this.httpRequest(`https://api.minimaxi.com/v1/video_generation/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = JSON.parse(response.body);
        return {
          taskId,
          provider: 'minimax',
          status: this.mapMiniMaxStatus(data.data?.status),
          videoUrl: data.data?.video_url,
          duration: data.data?.duration || 6,
          resolution: data.data?.resolution || '720p',
        };
      }
      case 'luma': {
        const apiKey = process.env.LUMA_API_KEY || '';
        const response = await this.httpRequest(`https://api.lumalabs.ai/dream-machine/v1/generations/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = JSON.parse(response.body);
        return {
          taskId,
          provider: 'luma',
          status: this.mapLumaStatus(data.state),
          videoUrl: data.assets?.video,
          duration: 5,
          resolution: '720p',
        };
      }
      default:
        return {
          taskId,
          provider: provider.id,
          status: 'failed',
          duration: 0,
          resolution: 'unknown',
        };
    }
  }

  /**
   * 轮询直到任务完成
   */
  private async pollUntilComplete(taskId: string, provider: VideoProvider): Promise<VideoGenResult> {
    const maxPolls = 120; // 最多轮询 120 次
    const pollInterval = 5000; // 每 5 秒轮询一次

    for (let i = 0; i < maxPolls; i++) {
      await this.sleep(pollInterval);

      const result = await this.pollProvider(taskId, provider);

      // 更新缓存
      this.pendingTasks.set(taskId, result);

      if (result.status === 'completed' || result.status === 'failed') {
        return result;
      }

      this.log.debug('轮询视频生成状态', {
        taskId,
        provider: provider.id,
        status: result.status,
        poll: i + 1,
      });
    }

    // 超时
    this.log.warn('视频生成轮询超时', { taskId, provider: provider.id });
    return {
      taskId,
      provider: provider.id,
      status: 'failed',
      duration: 0,
      resolution: '720p',
    };
  }

  /**
   * 下载视频到本地
   */
  private async downloadVideo(videoUrl: string, outputPath?: string): Promise<string> {
    const localPath = outputPath || path.join(this.videoDir, `video_${Date.now()}.mp4`);

    // 确保目录存在
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      const response = await this.httpRequest(videoUrl, { method: 'GET', timeout: 120000 });
      fs.writeFileSync(localPath, response.body);
      this.log.info('视频下载完成', { localPath, size: response.body.length });
      return localPath;
    } catch (err: unknown) {
      this.log.error('视频下载失败', { videoUrl, error: err instanceof Error ? err.message : String(err) });
      // 返回 URL 作为备选
      return videoUrl;
    }
  }

  // ========== 状态映射 ==========

  private mapPikaStatus(status: string): VideoGenResult['status'] {
    switch (status) {
      case 'completed': case 'success': case 'done': return 'completed';
      case 'failed': case 'error': return 'failed';
      case 'processing': case 'running': return 'processing';
      default: return 'pending';
    }
  }

  private mapRunwayStatus(status: string): VideoGenResult['status'] {
    switch (status) {
      case 'SUCCEEDED': case 'COMPLETE': return 'completed';
      case 'FAILED': case 'ERROR': return 'failed';
      case 'RUNNING': case 'PROCESSING': return 'processing';
      default: return 'pending';
    }
  }

  private mapKlingStatus(status: string): VideoGenResult['status'] {
    switch (status) {
      case 'succeed': case 'complete': return 'completed';
      case 'failed': case 'error': return 'failed';
      case 'processing': case 'running': return 'processing';
      default: return 'pending';
    }
  }

  private mapCogVideoStatus(status: string): VideoGenResult['status'] {
    switch (status) {
      case 'SUCCESS': case 'SUCCESSFUL': return 'completed';
      case 'FAIL': case 'FAILED': return 'failed';
      case 'PROCESSING': case 'RUNNING': return 'processing';
      default: return 'pending';
    }
  }

  private mapMiniMaxStatus(status: string): VideoGenResult['status'] {
    switch (status) {
      case 'success': case 'completed': case 'done': return 'completed';
      case 'failed': case 'error': return 'failed';
      case 'processing': case 'running': return 'processing';
      default: return 'pending';
    }
  }

  private mapLumaStatus(status: string): VideoGenResult['status'] {
    switch (status) {
      case 'completed': case 'done': return 'completed';
      case 'failed': case 'error': return 'failed';
      case 'processing': case 'generating': case 'dreaming': return 'processing';
      default: return 'pending';
    }
  }

  // ========== 工具方法 ==========

  /**
   * 更新生成统计
   */
  private updateStats(providerId: string, success: boolean, elapsedMs: number, duration: number): void {
    if (success) {
      this.stats.totalGenerated++;
      this.stats.totalDuration += duration;
    } else {
      this.stats.totalFailed++;
    }

    if (!this.stats.byProvider[providerId]) {
      this.stats.byProvider[providerId] = { count: 0, failed: 0 };
    }
    this.stats.byProvider[providerId].count++;
    if (!success) {
      this.stats.byProvider[providerId].failed++;
    }

    this.generationTimes.push(elapsedMs);
    if (this.generationTimes.length > 100) this.generationTimes.shift();
    this.stats.avgGenerationTime = this.generationTimes.reduce((a, b) => a + b, 0) / this.generationTimes.length;
  }

  /**
   * 通用 HTTP 请求（使用 Node.js 内置 https 模块）
   */
  private httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';

      const requestOptions: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 30000,
      };

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const lib = isHttps ? https : require('http');

      const req = lib.request(requestOptions, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [key, value] of Object.entries(res.headers as Record<string, string | string[] | undefined>)) {
            headers[key] = value;
          }
          resolve({
            statusCode: res.statusCode || 0,
            headers,
            body,
          });
        });
      });

      req.on('error', (err: Error) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP 请求超时: ${url}`));
      });

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }

  /**
   * 延时辅助
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
