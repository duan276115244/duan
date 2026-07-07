// ============================================================
// Voice Routes — 暴露 VoiceSystem 的 ASR/TTS 能力给 Web 前端
// 端点：
//   POST /api/voice/speak       文字转语音 (TTS)，返回音频文件
//   POST /api/voice/transcribe  语音转文字 (ASR)，接收音频二进制
//   GET  /api/voice/voices      列出可用语音
//   GET  /api/voice/status      语音系统状态
// ============================================================

import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { errMsg, type ServerContext } from '../services/app-context.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export function registerVoiceRoutes(app: express.Application, ctx: ServerContext): void {
  const { voiceSystem } = ctx;

  // GET /api/voice/status - 语音系统状态
  app.get('/api/voice/status', (_req: express.Request, res: express.Response) => {
    try {
      res.json({
        success: true,
        available: !!voiceSystem,
        sttProvider: voiceSystem?.getSTTProvider?.() ?? 'unavailable',
        ttsProvider: voiceSystem?.getTTSProvider?.() ?? 'unavailable',
        voices: voiceSystem?.listVoices?.().length ?? 0,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: errMsg(error) });
    }
  });

  // GET /api/voice/voices - 列出可用 TTS 语音
  app.get('/api/voice/voices', (req: express.Request, res: express.Response) => {
    try {
      const language = (req.query.language as string) || undefined;
      const voices = voiceSystem?.listVoices(language) ?? [];
      res.json({ success: true, data: voices });
    } catch (error) {
      res.status(500).json({ success: false, message: errMsg(error) });
    }
  });

  // POST /api/voice/speak - 文字转语音 (TTS)
  // body: { text, voice?, speed?, format? }
  // 返回：音频文件 (audio/mpeg)
  app.post('/api/voice/speak', (req: express.Request, res: express.Response) => {
    void (async () => {
    try {
      const { text, voice, speed, format } = req.body || {};
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ success: false, message: '缺少 text 参数' });
      }
      if (text.length > 3000) {
        return res.status(400).json({ success: false, message: '文本过长（上限 3000 字符）' });
      }

      // 生成临时音频文件
      const tmpDir = path.join(os.tmpdir(), 'duan-voice');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const outputFile = path.join(tmpDir, `tts_${Date.now()}.${format || 'mp3'}`);

      await voiceSystem.speak(text, {
        voice,
        speed: typeof speed === 'number' ? speed : 1.0,
        format: (() => {
          if (format === 'wav') return 'wav';
          if (format === 'ogg') return 'ogg';
          return 'mp3';
        })(),
        outputPath: outputFile,
        stream: false,
      });

      if (!(await pathExists(outputFile))) {
        return res.status(500).json({ success: false, message: '语音合成失败：未生成音频文件' });
      }

      const audioBuffer = await fs.promises.readFile(outputFile);
      // 清理临时文件
      try { await fs.promises.unlink(outputFile); } catch { /* ignore */ }

      if (audioBuffer.length === 0) {
        return res.status(500).json({ success: false, message: '语音合成失败：生成的音频文件为空' });
      }

      let mime: string;
      if (format === 'wav') mime = 'audio/wav';
      else if (format === 'ogg') mime = 'audio/ogg';
      else mime = 'audio/mpeg';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', audioBuffer.length.toString());
      res.send(audioBuffer);
    } catch (error) {
      res.status(500).json({ success: false, message: '语音合成失败: ' + errMsg(error) });
    }
    })();
  });

  // POST /api/voice/transcribe - 语音转文字 (ASR)
  // 接收原始音频二进制 (Content-Type: audio/wav 等)，或 base64 JSON
  // 返回: { success, text, confidence, language, duration }
  app.post('/api/voice/transcribe', express.raw({ type: '*/*', limit: '25mb' }), (req: express.Request, res: express.Response) => {
    void (async () => {
    try {
      if (!req.body || req.body.length === 0) {
        return res.status(400).json({ success: false, message: '未收到音频数据' });
      }

      // 保存音频到临时文件
      const tmpDir = path.join(os.tmpdir(), 'duan-voice');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const ext = (req.query.format as string) || 'wav';
      const audioFile = path.join(tmpDir, `asr_${Date.now()}.${ext}`);
      await fs.promises.writeFile(audioFile, req.body);

      const result = await voiceSystem.transcribeFile(audioFile);

      // 清理临时文件
      try { await fs.promises.unlink(audioFile); } catch { /* ignore */ }

      res.json({
        success: true,
        text: result.text,
        confidence: result.confidence,
        language: result.language,
        duration: result.duration,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '语音识别失败: ' + errMsg(error) });
    }
    })();
  });
}
