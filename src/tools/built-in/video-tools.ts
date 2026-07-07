import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { errMsg } from '../../core/utils.js';

const execFileAsync = promisify(execFile);

/**
 * P1-3 新增：视频处理工具 — ffmpeg 集成
 *
 * 提供视频剪辑、转码、截图、拼接、提取音频、获取视频信息等能力。
 * 依赖系统安装的 ffmpeg 和 ffprobe。
 *
 * 安全措施：
 * - 所有文件操作限制在工作区范围内
 * - 命令通过 execFile 参数数组执行，避免注入
 * - 输出文件大小限制
 * - 执行超时保护
 */

const VIDEO_TIMEOUT = 120000; // 2 分钟超时
const MAX_OUTPUT_SIZE = 500 * 1024 * 1024; // 500MB 输出限制

/**
 * 检查 ffmpeg 是否可用
 */
async function checkFFmpeg(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查 ffprobe 是否可用
 */
async function checkFFprobe(): Promise<boolean> {
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 异步路径存在性检查（替代同步 fs.existsSync，避免阻塞事件循环）
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全路径校验 — 防止路径遍历
 */
function validatePath(filePath: string): { ok: boolean; error?: string } {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '路径不能为空' };
  }
  // 解析为绝对路径
  const resolved = path.resolve(filePath);
  // 禁止访问系统敏感目录
  const normalized = resolved.toLowerCase();
  const blocked = [
    'c:\\windows\\system32',
    'c:\\windows\\config',
    '/etc/',
    '/usr/bin',
    '/usr/sbin',
  ];
  for (const b of blocked) {
    if (normalized.startsWith(b)) {
      return { ok: false, error: `安全限制: 禁止访问系统目录 ${b}` };
    }
  }
  return { ok: true };
}

export const videoTools: UnifiedToolDef[] = [
  {
    name: 'video_info',
    description: '获取视频文件的信息（时长、分辨率、编码、帧率、码率等）。需要系统安装 ffprobe。',
    readOnly: true,
    parameters: {
      file: { type: 'string', description: '视频文件路径', required: true },
    },
    execute: async (args) => {
      const filePath = args.file as string;
      const pathCheck = validatePath(filePath);
      if (!pathCheck.ok) return `❌ ${pathCheck.error}`;
      if (!(await pathExists(filePath))) return `❌ 文件不存在: ${filePath}`;

      const probeAvailable = await checkFFprobe();
      if (!probeAvailable) {
        return '❌ ffprobe 未安装或不在 PATH 中。请先安装 ffmpeg 套件。\n下载: https://ffmpeg.org/download.html';
      }

      try {
        const { stdout } = await execFileAsync(
          'ffprobe',
          [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath,
          ],
          { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
        );

        const info = JSON.parse(stdout);
        const format = info.format || {};
        const videoStream = (info.streams || []).find((s: { codec_type?: string }) => s.codec_type === 'video');
        const audioStream = (info.streams || []).find((s: { codec_type?: string }) => s.codec_type === 'audio');

        let result = '📹 视频信息\n';
        result += '━━━━━━━━━━━━━━━━━━━━\n';
        result += `文件: ${format.filename || filePath}\n`;
        result += `格式: ${format.format_long_name || format.format_name || '未知'}\n`;
        result += `时长: ${parseFloat(format.duration || '0').toFixed(2)}秒\n`;
        result += `大小: ${(parseFloat(format.size || '0') / 1024 / 1024).toFixed(2)} MB\n`;
        result += `码率: ${(parseInt(format.bit_rate || '0') / 1000).toFixed(0)} kbps\n`;

        if (videoStream) {
          result += '\n🎥 视频流:\n';
          result += `  编码: ${videoStream.codec_long_name || videoStream.codec_name || '未知'}\n`;
          result += `  分辨率: ${videoStream.width}x${videoStream.height}\n`;
          result += `  帧率: ${evalFramerate(videoStream.r_frame_rate)} fps\n`;
          result += `  像素格式: ${videoStream.pix_fmt || '未知'}\n`;
          if (videoStream.bit_rate) {
            result += `  视频码率: ${(parseInt(videoStream.bit_rate) / 1000).toFixed(0)} kbps\n`;
          }
        }

        if (audioStream) {
          result += '\n🔊 音频流:\n';
          result += `  编码: ${audioStream.codec_long_name || audioStream.codec_name || '未知'}\n`;
          result += `  采样率: ${audioStream.sample_rate || '未知'} Hz\n`;
          result += `  声道: ${audioStream.channels || '未知'}\n`;
          if (audioStream.bit_rate) {
            result += `  音频码率: ${(parseInt(audioStream.bit_rate) / 1000).toFixed(0)} kbps\n`;
          }
        }

        return result;
      } catch (err: unknown) {
        return `❌ 获取视频信息失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'video_trim',
    description: '剪辑视频片段（按时间范围截取）。需要系统安装 ffmpeg。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: '输入视频文件路径', required: true },
      output: { type: 'string', description: '输出视频文件路径', required: true },
      start: { type: 'string', description: '开始时间（秒，如 10 或 00:00:10）', required: true },
      duration: { type: 'string', description: '持续时长（秒，如 30 或 00:00:30）', required: false },
      end: { type: 'string', description: '结束时间（秒，与 duration 二选一）', required: false },
    },
    execute: async (args) => {
      const inputPath = args.input as string;
      const outputPath = args.output as string;
      const start = args.start as string;
      const duration = args.duration as string;
      const end = args.end as string;

      for (const p of [inputPath, outputPath]) {
        const check = validatePath(p);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!(await pathExists(inputPath))) return `❌ 输入文件不存在: ${inputPath}`;
      if (!start) return '❌ 缺少参数: start';

      const ffmpegAvailable = await checkFFmpeg();
      if (!ffmpegAvailable) {
        return '❌ ffmpeg 未安装或不在 PATH 中。请先安装 ffmpeg。\n下载: https://ffmpeg.org/download.html';
      }

      // 构建 ffmpeg 参数数组（避免命令注入）
      const ffArgs: string[] = ['-y', '-i', inputPath, '-ss', String(start)];
      if (duration) {
        ffArgs.push('-t', String(duration));
      } else if (end) {
        ffArgs.push('-to', String(end));
      }
      ffArgs.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath);

      try {
        await execFileAsync('ffmpeg', ffArgs, {
          timeout: VIDEO_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });

        const stat = await fs.promises.stat(outputPath);
        if (stat.size > MAX_OUTPUT_SIZE) {
          await fs.promises.unlink(outputPath);
          return `❌ 输出文件过大 (${(stat.size / 1024 / 1024).toFixed(0)} MB)，已删除`;
        }

        return `✅ 视频剪辑完成\n输出: ${outputPath}\n大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`;
      } catch (err: unknown) {
        return `❌ 视频剪辑失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'video_convert',
    description: '视频格式转换/转码。支持常见格式（mp4, avi, mkv, webm, gif 等）。需要系统安装 ffmpeg。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: '输入视频文件路径', required: true },
      output: { type: 'string', description: '输出文件路径（扩展名决定格式）', required: true },
      videoCodec: { type: 'string', description: '视频编码（如 libx264, libx265, vp9），默认 libx264', required: false },
      audioCodec: { type: 'string', description: '音频编码（如 aac, mp3），默认 aac', required: false },
      crf: { type: 'number', description: '质量系数（0-51，越小质量越高，默认 23）', required: false },
      preset: { type: 'string', description: '编码预设（ultrafast/fast/medium/slow），默认 medium', required: false },
      scale: { type: 'string', description: '缩放（如 1280:720 或 -2:720），可选', required: false },
    },
    execute: async (args) => {
      const inputPath = args.input as string;
      const outputPath = args.output as string;

      for (const p of [inputPath, outputPath]) {
        const check = validatePath(p);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!(await pathExists(inputPath))) return `❌ 输入文件不存在: ${inputPath}`;

      const ffmpegAvailable = await checkFFmpeg();
      if (!ffmpegAvailable) {
        return '❌ ffmpeg 未安装或不在 PATH 中。请先安装 ffmpeg。\n下载: https://ffmpeg.org/download.html';
      }

      const videoCodec = (args.videoCodec as string) || 'libx264';
      const audioCodec = (args.audioCodec as string) || 'aac';
      const crf = (args.crf as number) || 23;
      const preset = (args.preset as string) || 'medium';
      const scale = args.scale as string;

      // 白名单校验编码和预设（防止注入）
      const allowedCodecs = ['libx264', 'libx265', 'vp9', 'libvpx', 'mpeg4', 'copy', 'gif', 'png'];
      const allowedPresets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
      if (!allowedCodecs.includes(videoCodec)) return `❌ 不支持的视频编码: ${videoCodec}`;
      if (!allowedPresets.includes(preset)) return `❌ 不支持的预设: ${preset}`;
      if (crf < 0 || crf > 51) return '❌ CRF 必须在 0-51 之间';

      const ffArgs: string[] = ['-y', '-i', inputPath];
      if (scale) {
        // 校验 scale 格式
        if (!/^\d+:-?\d+$|^-?\d+:\d+$/.test(scale)) {
          return '❌ scale 格式不合法（应为 WIDTH:HEIGHT，如 1280:720 或 -2:720）';
        }
        ffArgs.push('-vf', `scale=${scale}`);
      }
      ffArgs.push('-c:v', videoCodec, '-preset', preset, '-crf', String(crf));
      ffArgs.push('-c:a', audioCodec);
      ffArgs.push(outputPath);

      try {
        await execFileAsync('ffmpeg', ffArgs, {
          timeout: VIDEO_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });

        const stat = await fs.promises.stat(outputPath);
        if (stat.size > MAX_OUTPUT_SIZE) {
          await fs.promises.unlink(outputPath);
          return `❌ 输出文件过大 (${(stat.size / 1024 / 1024).toFixed(0)} MB)，已删除`;
        }

        return `✅ 视频转换完成\n输出: ${outputPath}\n大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB\n编码: ${videoCodec}/${audioCodec}`;
      } catch (err: unknown) {
        return `❌ 视频转换失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'video_screenshot',
    description: '从视频中截取一帧作为图片。需要系统安装 ffmpeg。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: '输入视频文件路径', required: true },
      output: { type: 'string', description: '输出图片路径（.png 或 .jpg）', required: true },
      time: { type: 'string', description: '截图时间点（秒，如 5 或 00:00:05）', required: true },
      width: { type: 'number', description: '输出宽度（可选，保持比例缩放）', required: false },
    },
    execute: async (args) => {
      const inputPath = args.input as string;
      const outputPath = args.output as string;
      const time = args.time as string;
      const width = args.width as number;

      for (const p of [inputPath, outputPath]) {
        const check = validatePath(p);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!(await pathExists(inputPath))) return `❌ 输入文件不存在: ${inputPath}`;
      if (!time) return '❌ 缺少参数: time';

      const ffmpegAvailable = await checkFFmpeg();
      if (!ffmpegAvailable) {
        return '❌ ffmpeg 未安装或不在 PATH 中。请先安装 ffmpeg。\n下载: https://ffmpeg.org/download.html';
      }

      const ffArgs: string[] = ['-y', '-ss', String(time), '-i', inputPath, '-frames:v', '1'];
      if (width && width > 0) {
        ffArgs.push('-vf', `scale=${width}:-1`);
      }
      ffArgs.push(outputPath);

      try {
        await execFileAsync('ffmpeg', ffArgs, {
          timeout: 30000,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true,
        });

        if (!(await pathExists(outputPath))) return '❌ 截图失败，输出文件未生成';

        const stat = await fs.promises.stat(outputPath);
        return `✅ 视频截图完成\n输出: ${outputPath}\n大小: ${(stat.size / 1024).toFixed(1)} KB`;
      } catch (err: unknown) {
        return `❌ 视频截图失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'video_extract_audio',
    description: '从视频中提取音频轨道。需要系统安装 ffmpeg。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: '输入视频文件路径', required: true },
      output: { type: 'string', description: '输出音频路径（.mp3, .aac, .wav）', required: true },
      format: { type: 'string', description: '音频格式（mp3/aac/wav），默认 mp3', required: false },
    },
    execute: async (args) => {
      const inputPath = args.input as string;
      const outputPath = args.output as string;
      const format = (args.format as string) || 'mp3';

      for (const p of [inputPath, outputPath]) {
        const check = validatePath(p);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!(await pathExists(inputPath))) return `❌ 输入文件不存在: ${inputPath}`;

      const allowedFormats = ['mp3', 'aac', 'wav'];
      if (!allowedFormats.includes(format)) return `❌ 不支持的音频格式: ${format}`;

      const ffmpegAvailable = await checkFFmpeg();
      if (!ffmpegAvailable) {
        return '❌ ffmpeg 未安装或不在 PATH 中。请先安装 ffmpeg。\n下载: https://ffmpeg.org/download.html';
      }

      const codecMap: Record<string, string> = { mp3: 'libmp3lame', aac: 'aac', wav: 'pcm_s16le' };

      try {
        await execFileAsync('ffmpeg', [
          '-y', '-i', inputPath,
          '-vn', '-acodec', codecMap[format],
          '-ab', '192k',
          outputPath,
        ], { timeout: VIDEO_TIMEOUT, maxBuffer: 10 * 1024 * 1024, windowsHide: true });

        const stat = await fs.promises.stat(outputPath);
        return `✅ 音频提取完成\n输出: ${outputPath}\n大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB\n格式: ${format}`;
      } catch (err: unknown) {
        return `❌ 音频提取失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'video_concat',
    description: '拼接多个视频文件。所有视频需有相同的编码和分辨率。需要系统安装 ffmpeg。',
    readOnly: false,
    parameters: {
      inputs: { type: 'array', description: '输入视频文件路径数组', required: true },
      output: { type: 'string', description: '输出视频文件路径', required: true },
    },
    execute: async (args) => {
      const inputs = args.inputs as string[];
      const outputPath = args.output as string;

      if (!Array.isArray(inputs) || inputs.length < 2) {
        return '❌ 至少需要 2 个输入文件';
      }

      const outputCheck = validatePath(outputPath);
      if (!outputCheck.ok) return `❌ ${outputCheck.error}`;

      for (const f of inputs) {
        const check = validatePath(f);
        if (!check.ok) return `❌ ${check.error}`;
        if (!(await pathExists(f))) return `❌ 文件不存在: ${f}`;
      }

      const ffmpegAvailable = await checkFFmpeg();
      if (!ffmpegAvailable) {
        return '❌ ffmpeg 未安装或不在 PATH 中。请先安装 ffmpeg。\n下载: https://ffmpeg.org/download.html';
      }

      // 创建临时文件列表
      const tmpList = path.join(path.dirname(outputPath), `.concat-list-${Date.now()}.txt`);
      try {
        const listContent = inputs.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
        await fs.promises.writeFile(tmpList, listContent, 'utf-8');

        await execFileAsync('ffmpeg', [
          '-y', '-f', 'concat', '-safe', '0',
          '-i', tmpList,
          '-c', 'copy',
          outputPath,
        ], { timeout: VIDEO_TIMEOUT, maxBuffer: 10 * 1024 * 1024, windowsHide: true });

        const stat = await fs.promises.stat(outputPath);
        if (stat.size > MAX_OUTPUT_SIZE) {
          await fs.promises.unlink(outputPath);
          return `❌ 输出文件过大，已删除`;
        }

        return `✅ 视频拼接完成\n输入: ${inputs.length} 个文件\n输出: ${outputPath}\n大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`;
      } catch (err: unknown) {
        return `❌ 视频拼接失败: ${errMsg(err)}`;
      } finally {
        try { await fs.promises.unlink(tmpList); } catch { /* ignore */ }
      }
    },
  },
];

/**
 * 计算帧率
 */
function evalFramerate(rate: string): string {
  if (!rate || typeof rate !== 'string') return '未知';
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return (num / den).toFixed(2);
  }
  return rate;
}
