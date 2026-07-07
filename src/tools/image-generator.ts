/**
 * J.A.R.V.I.S. 图像生成工具
 * 
 * 三层生成策略：
 * 1. DALL-E 3（需 OPENAI_API_KEY）— 高质量，OpenAI 官方
 * 2. Stable Diffusion（需自部署 API）— 可定制，私有化
 * 3. Trae 内置 API（零配置）— 内置兜底，无需任何外部密钥
 */

import OpenAI from 'openai';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ImageGenerationConfig, ImageResult } from '../core/enhanced-types.js';

/** Trae 内置图片生成 API 的尺寸映射 */
const TRAE_SIZE_MAP: Record<string, string> = {
  '1024x1024': 'square_hd',
  '1024x1792': 'portrait_16_9',
  '1792x1024': 'landscape_16_9',
  '768x1024': 'portrait_4_3',
  '1024x768': 'landscape_4_3',
  '512x512': 'square',
};

export class ImageGenerator {
  private config: { openai: string | undefined; stableDiffusion: { url: string | undefined; apiKey: string | undefined } };
  
  constructor() {
    this.config = {
      openai: process.env.OPENAI_API_KEY,
      stableDiffusion: {
        url: process.env.STABLE_DIFFUSION_API_URL,
        apiKey: process.env.STABLE_DIFFUSION_API_KEY
      }
    };
  }

  /**
   * 使用 DALL-E 生成图像
   */
  async generateWithDALL3(config: ImageGenerationConfig): Promise<ImageResult> {
    try {
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      
      const response = await openai.images.generate({
        model: config.model || 'dall-e-3',
        prompt: config.prompt,
        n: config.numImages || 1,
        size: this.getSizeString(config.width, config.height) as '1024x1024' | '1792x1024' | '1024x1792',
        quality: 'standard',
        style: config.style === 'vivid' ? 'vivid' : 'natural'
      });

      const images = (response.data || []).map((item: { url?: string }) => item.url).filter(Boolean);
      
      await this.saveImages(images);
      
      return {
        success: true,
        images
      };
    } catch (error: unknown) {
      return {
        success: false,
        images: [],
        error: (error instanceof Error ? error.message : String(error))
      };
    }
  }

  /**
   * 使用稳定扩散生成图像
   */
  async generateWithStableDiffusion(config: ImageGenerationConfig): Promise<ImageResult> {
    try {
      const baseUrl = this.config.stableDiffusion.url;
      if (!baseUrl) {
        throw new Error('Stable Diffusion API URL 未配置');
      }
      
      const payload = {
        prompt: config.prompt,
        negative_prompt: config.negativePrompt || '',
        width: config.width || 1024,
        height: config.height || 1024,
        batch_size: config.numImages || 1,
        steps: 30,
        cfg_scale: 7
      };
      
      const response = await axios.post(
        `${baseUrl}/sdapi/v1/txt2img`,
        payload,
        {
          headers: this.config.stableDiffusion.apiKey ? {
            'Authorization': `Bearer ${this.config.stableDiffusion.apiKey}`
          } : {}
        }
      );
      
      const images = response.data.images;
      await this.saveImages(images);
      
      return {
        success: true,
        images
      };
    } catch (error: unknown) {
      return {
        success: false,
        images: [],
        error: (error instanceof Error ? error.message : String(error))
      };
    }
  }

  /**
   * 使用 Trae 内置 API 生成图像（零配置兜底）
   * 不需要任何外部 API Key，直接通过内置端点生成
   */
  async generateWithTrae(config: ImageGenerationConfig): Promise<ImageResult> {
    try {
      const sizeStr = this.getSizeString(config.width, config.height);
      const traeSize = TRAE_SIZE_MAP[sizeStr] || 'square_hd';
      const encodedPrompt = encodeURIComponent(config.prompt);
      const url = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodedPrompt}&image_size=${traeSize}`;
      
      // 下载图片到本地
      const outputDir = path.join(process.cwd(), 'output', 'images');
      await fs.mkdir(outputDir, { recursive: true });
      
      const response = await axios.get(url, { 
        responseType: 'arraybuffer',
        timeout: 60000,
      });
      
      const filePath = path.join(outputDir, `image_${Date.now()}_trae.png`);
      await fs.writeFile(filePath, response.data);
      
      return {
        success: true,
        images: [filePath],
      };
    } catch (error: unknown) {
      return {
        success: false,
        images: [],
        error: `Trae 内置生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 通用图像生成入口（自动降级策略）
   * 
   * 策略：
   * 1. 若指定 provider 且有对应 key → 使用指定 provider
   * 2. 若未指定 provider → 按 DALL-E → SD → Trae 自动降级
   * 3. 无任何外部 key 时 → 直接使用 Trae 内置 API（零配置）
   */
  generate(config: ImageGenerationConfig, provider?: 'dall-e' | 'stable-diffusion' | 'trae'): Promise<ImageResult> {
    // 显式指定 trae 时直接用
    if (provider === 'trae') {
      return this.generateWithTrae(config);
    }
    
    // 指定 dall-e 且有 key
    if (provider === 'dall-e' && this.config.openai) {
      return this.generateWithDALL3(config);
    }
    
    // 指定 stable-diffusion 且有 URL
    if (provider === 'stable-diffusion' && this.config.stableDiffusion.url) {
      return this.generateWithStableDiffusion(config);
    }
    
    // 未指定 provider → 自动降级：DALL-E → SD → Trae
    if (this.config.openai) {
      return this.generateWithDALL3(config);
    }
    if (this.config.stableDiffusion.url) {
      return this.generateWithStableDiffusion(config);
    }
    
    // 零 key 兜底：使用 Trae 内置 API
    return this.generateWithTrae(config);
  }

  /**
   * 获取尺寸字符串
   */
  private getSizeString(width?: number, height?: number): string {
    const w = width || 1024;
    const h = height || 1024;
    
    const sizes = {
      '1024x1024': '1024x1024',
      '1024x1792': '1024x1792',
      '1792x1024': '1792x1024'
    };
    
    const key = `${w}x${h}`;
    return sizes[key as keyof typeof sizes] || '1024x1024';
  }

  /**
   * 保存图像到本地
   */
  private async saveImages(imageUrls: string[]): Promise<void> {
    const outputDir = path.join(process.cwd(), 'output', 'images');
    await fs.mkdir(outputDir, { recursive: true });
    
    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const url = imageUrls[i];
        if (url.startsWith('http')) {
          const response = await axios.get(url, { responseType: 'arraybuffer' });
          const filePath = path.join(outputDir, `image_${Date.now()}_${i}.png`);
          await fs.writeFile(filePath, response.data);
        }
      } catch (error: unknown) {
        console.error('保存图像失败:', error);
      }
    }
  }
}
