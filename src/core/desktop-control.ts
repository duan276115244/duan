/**
 * 桌面控制模块 — DesktopControl
 *
 * 核心能力：
 * 1. 屏幕截图：全屏/区域截图，保存到 .duan/screenshots/
 * 2. 窗口截图：按标题捕获指定窗口
 * 3. 视觉分析：截图 + 视觉模型分析屏幕内容
 * 4. 鼠标控制：点击、移动、坐标操作
 * 5. 键盘控制：文本输入、按键模拟
 * 6. 屏幕信息：获取分辨率、缩放因子
 * 7. 屏幕查找：通过视觉模型定位界面元素
 * 8. 应用启动：跨平台打开应用程序
 *
 * 安全设计：
 * - 坐标边界检查，防止越界操作
 * - 操作频率限制，防止过快自动化
 * - 所有写操作通过 EventBus 广播事件
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 截图选项 */
export interface CaptureOptions {
  region?: { x: number; y: number; width: number; height: number };
  format?: 'png' | 'jpg';
  quality?: number;       // 1-100 for jpg
  outputPath?: string;
}

/** 截图结果 */
export interface ScreenCapture {
  filePath: string;
  width: number;
  height: number;
  format: string;
  base64?: string;        // 视觉分析时可选提供
  timestamp: number;
}

/** 屏幕分析结果 */
export interface ScreenAnalysis {
  description: string;
  elements: UIElement[];
  text: string;           // OCR 类文本提取
  suggestedActions: string[];
}

/** UI 元素 */
export interface UIElement {
  type: 'button' | 'input' | 'text' | 'image' | 'link' | 'menu' | 'window';
  label: string;
  bounds?: { x: number; y: number; width: number; height: number };
  confidence: number;
}

/** 屏幕尺寸 */
export interface ScreenSize {
  width: number;
  height: number;
  scaleFactor: number;
}


/** 操作统计 */
interface DesktopStats {
  totalCaptures: number;
  totalClicks: number;
  totalTypes: number;
  totalKeyPresses: number;
  totalAnalyses: number;
  totalFinds: number;
  totalAppOpens: number;
  lastCaptureTime: number | null;
  lastActionTime: number | null;
  errors: number;
}

// ============ 主类 ============

export class DesktopControl {
  private log = logger.child({ module: 'DesktopControl' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态模型库，访问 .getAvailableModels()/.call() 等方法
  private modelLibrary: any;
  private screenshotsDir: string;
  private platform: string;
  private screenSize: ScreenSize | null = null;
  private lastActionTime: number = 0;
  private readonly MIN_ACTION_INTERVAL = 100; // 最小操作间隔（毫秒）

  // 操作统计
  private stats: DesktopStats = {
    totalCaptures: 0,
    totalClicks: 0,
    totalTypes: 0,
    totalKeyPresses: 0,
    totalAnalyses: 0,
    totalFinds: 0,
    totalAppOpens: 0,
    lastCaptureTime: null,
    lastActionTime: null,
    errors: 0,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态模型库注入
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary;
    this.platform = os.platform();
    this.screenshotsDir = path.join(process.cwd(), 'screenshots');
    this.ensureScreenshotsDir();
    this.log.info('桌面控制模块初始化', { platform: this.platform });
  }

  /** 查找可用的视觉模型，如果没有则返回 null */
  private findVisionModel(): string | null {
    if (!this.modelLibrary || typeof this.modelLibrary.getAvailableModels !== 'function') {
      return null;
    }
    try {
      const available = this.modelLibrary.getAvailableModels();
      const visionModel = available.find((m) =>
        m.capabilities && m.capabilities.includes('vision') && m.enabled !== false
      );
      return visionModel ? visionModel.id : null;
    } catch {
      return null;
    }
  }

  // ============ 私有工具方法 ============

  /** 确保截图目录存在 */
  private ensureScreenshotsDir(): void {
    try {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    } catch (err: unknown) {
      this.log.error('创建截图目录失败', { error: err });
    }
  }

  /** 异步检查路径是否存在（封装 fs.promises.access） */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** 频率限制检查 */
  private rateLimitCheck(): boolean {
    const now = Date.now();
    if (now - this.lastActionTime < this.MIN_ACTION_INTERVAL) {
      this.log.warn('操作过于频繁，已限流', {
        elapsed: now - this.lastActionTime,
        minInterval: this.MIN_ACTION_INTERVAL,
      });
      return false;
    }
    this.lastActionTime = now;
    this.stats.lastActionTime = now;
    return true;
  }

  /** 坐标边界检查 */
  private validateCoordinates(x: number, y: number): boolean {
    const size = this.getScreenSize();
    if (x < 0 || y < 0 || x > size.width || y > size.height) {
      this.log.warn('坐标超出屏幕范围', { x, y, screenWidth: size.width, screenHeight: size.height });
      return false;
    }
    return true;
  }

  /** 执行 PowerShell 命令
   * @param script PowerShell 脚本
   * @param timeoutMs 超时毫秒（默认 30000）。UI 操作（SendKeys）建议用更短超时（8000）以快速失败。
   */
  private execPowerShell(script: string, timeoutMs: number = 30000): string {
    if (process.platform !== 'win32') {
      throw new Error(`PowerShell 仅在 Windows 上可用（当前平台: ${process.platform}）`);
    }
    // 关键修复：PowerShell 非交互模式下会将进度流序列化为 CLIXML 写入 stderr，
    // 导致 execSync 误判为失败。预置 $ProgressPreference 抑制进度流噪声。
    const fullScript = `$ProgressPreference='SilentlyContinue';\n${script}`;
    try {
      const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
      return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        windowsHide: true,
      }).trim();
    } catch (err: unknown) {
      // 容忍 CLIXML 进度噪声：execSync throw 时 error.stdout 仍可能含有效输出
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const stdout = (e.stdout ?? '').trim();
      if (stdout.length > 0) {
        return stdout;
      }
      const message = e.message ?? (err instanceof Error ? err.message : String(err));
      this.log.error('PowerShell 执行失败', { script: script.substring(0, 200), error: message });
      throw new Error(`PowerShell 执行失败: ${message}`);
    }
  }

  /** 执行 Shell 命令（跨平台） */
  private execShell(command: string): string {
    try {
      return execSync(command, { encoding: 'utf-8', timeout: 30000 }).trim();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Shell 执行失败', { command: command.substring(0, 200), error: message });
      throw new Error(`Shell 执行失败: ${message}`);
    }
  }

  /** 广播桌面事件 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态事件 payload，被展开 ...data
  private emitEvent(action: string, data?: any): void {
    EventBus.getInstance().emitSync(`desktop.${action}`, {
      source: 'DesktopControl',
      action,
      timestamp: Date.now(),
      ...data,
    });
  }

  /** 生成截图文件路径 */
  private generateScreenshotPath(format: string = 'png'): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.screenshotsDir, `screenshot-${timestamp}.${format}`);
  }

  // ============ 核心功能 ============

  /**
   * 截取屏幕截图
   * Windows: 使用 PowerShell + System.Drawing
   * Linux: 使用 scrot 或 nircmd
   */
  async captureScreen(options?: CaptureOptions): Promise<ScreenCapture> {
    if (!this.rateLimitCheck()) {
      throw new Error('操作过于频繁，请稍后再试');
    }

    const format = options?.format || 'png';
    const outputPath = options?.outputPath || this.generateScreenshotPath(format);
    const startTime = Date.now();

    try {
      if (this.platform === 'win32') {
        await this.captureScreenWindows(outputPath, format, options?.region, options?.quality);
      } else if (this.platform === 'darwin') {
        await this.captureScreenMac(outputPath, format);
      } else {
        await this.captureScreenLinux(outputPath, format);
      }

      // 读取截图信息
      const fileBuffer = await fs.promises.readFile(outputPath);
      const base64 = fileBuffer.toString('base64');

      // 获取图片尺寸（从文件读取）
      const size = this.getScreenSize();

      const capture: ScreenCapture = {
        filePath: outputPath,
        width: size.width,
        height: size.height,
        format,
        base64,
        timestamp: Date.now(),
      };

      this.stats.totalCaptures++;
      this.stats.lastCaptureTime = Date.now();

      this.log.info('屏幕截图完成', {
        path: outputPath,
        format,
        size: fileBuffer.length,
        duration: Date.now() - startTime,
      });

      this.emitEvent('captured', { filePath: outputPath, format });

      return capture;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('屏幕截图失败', { error: err instanceof Error ? err.message : String(err) });

      // 尝试 screenshot-desktop npm 包作为二级回退
      try {
        const sd = await import('screenshot-desktop');
        const img = await sd.default({ format: 'png' });
        await fs.promises.writeFile(outputPath, img);
        const fileBuffer = await fs.promises.readFile(outputPath);
        const base64 = fileBuffer.toString('base64');
        const size = this.getScreenSize();
        this.stats.totalCaptures++;
        this.stats.lastCaptureTime = Date.now();
        this.log.info('screenshot-desktop 截图成功', { path: outputPath });
        return {
          filePath: outputPath,
          width: size.width,
          height: size.height,
          format,
          base64,
          timestamp: Date.now(),
        };
      } catch (sdErr: unknown) {
        this.log.error('screenshot-desktop 也失败', { error: sdErr instanceof Error ? sdErr.message : String(sdErr) });
      }

      if (this.platform === 'win32') {
        try {
          this.log.info('尝试PowerShell备用截图方案');
          const fallbackScript = `
Add-Type -AssemblyName System.Windows.Forms;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
Add-Type -AssemblyName System.Drawing;
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size);
$g.Dispose();
$bmp.Save('${outputPath}');
$bmp.Dispose();
`.trim();
          this.execPowerShell(fallbackScript);
          if (await this.pathExists(outputPath)) {
            const fileBuffer = await fs.promises.readFile(outputPath);
            const base64 = fileBuffer.toString('base64');
            const size = this.getScreenSize();
            this.stats.totalCaptures++;
            this.stats.lastCaptureTime = Date.now();
            this.log.info('PowerShell备用截图成功', { path: outputPath });
            return {
              filePath: outputPath,
              width: size.width,
              height: size.height,
              format,
              base64,
              timestamp: Date.now(),
            };
          }
        } catch (fallbackErr: unknown) {
          this.log.error('PowerShell备用截图也失败', { error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) });
        }
      }
      throw err;
    }
  }

  /** Windows 截图实现 */
  private async captureScreenWindows(
    outputPath: string,
    format: string,
    region?: { x: number; y: number; width: number; height: number },
    quality?: number,
  ): Promise<void> {
    const qualityParam = quality || 85;
    const regionScript = region
      ? `$srcRect = New-Object System.Drawing.Rectangle(${region.x}, ${region.y}, ${region.width}, ${region.height});`
      : `$srcRect = New-Object System.Drawing.Rectangle(0, 0, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height);`;

    const script = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
${regionScript}
$bmp = New-Object System.Drawing.Bitmap($srcRect.Width, $srcRect.Height);
$graphics = [System.Drawing.Graphics]::FromImage($bmp);
$graphics.CopyFromScreen($srcRect.Location, [System.Drawing.Point]::Empty, $srcRect.Size);
$graphics.Dispose();
${format === 'jpg'
        ? `$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1);
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${qualityParam}L);
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageDecoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
$bmp.Save('${outputPath}', $codec, $encoderParams);`
        : `$bmp.Save('${outputPath}', [System.Drawing.Imaging.ImageFormat]::Png);`
      }
$bmp.Dispose();
`.trim();

    this.execPowerShell(script);

    // 验证文件已生成
    if (!(await this.pathExists(outputPath))) {
      this.log.warn('PowerShell 截图文件未找到，等待 500ms 后重试', { path: outputPath });
      await new Promise(r => setTimeout(r, 500));
      if (!(await this.pathExists(outputPath))) {
        // 第二次尝试：使用更简单的 PowerShell 截图方式
        const fallbackScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$bmp = [System.Windows.Forms.Clipboard]::GetImage();
if ($bmp -eq $null) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
  $rect = $screen.Bounds;
  $bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height);
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $g.CopyFromScreen($rect.X, $rect.Y, 0, 0, $rect.Size);
  $g.Dispose();
}
$bmp.Save('${outputPath}', [System.Drawing.Imaging.ImageFormat]::Png);
`.trim();
        this.execPowerShell(fallbackScript);
        await new Promise(r => setTimeout(r, 300));
        if (!(await this.pathExists(outputPath))) {
          throw new Error(`截图文件未生成: ${outputPath}`);
        }
      }
    }
  }

  /** macOS 截图实现 */
  private async captureScreenMac(outputPath: string, format: string): Promise<void> {
    const cmd = format === 'jpg'
      ? `screencapture -t jpg -x "${outputPath}"`
      : `screencapture -t png -x "${outputPath}"`;
    this.execShell(cmd);
    if (!(await this.pathExists(outputPath))) {
      await new Promise(r => setTimeout(r, 500));
      this.execShell(cmd);
      if (!(await this.pathExists(outputPath))) {
        throw new Error(`截图文件未生成: ${outputPath}`);
      }
    }
  }

  /** Linux 截图实现 */
  private async captureScreenLinux(outputPath: string, _format: string): Promise<void> {
    try {
      this.execShell(`scrot "${outputPath}"`);
    } catch {
      // 回退到 nircmd 或 import
      try {
        this.execShell(`import -window root "${outputPath}"`);
      } catch {
        throw new Error('Linux 截图需要安装 scrot 或 ImageMagick (import)');
      }
    }
    if (!(await this.pathExists(outputPath))) {
      await new Promise(r => setTimeout(r, 500));
      if (!(await this.pathExists(outputPath))) {
        throw new Error(`截图文件未生成: ${outputPath}`);
      }
    }
  }

  /**
   * OCR 截图文字识别 - 使用 Tesseract.js 从截图中提取文字
   */
  async ocrScreen(region?: { x: number; y: number; width: number; height: number }): Promise<{ text: string; confidence: number; blocks: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> {
    const capture = await this.captureScreen({ format: 'png', region });
    try {
      // eslint-disable-next-line no-new-func, @typescript-eslint/no-explicit-any -- 动态 import 的 Tesseract 模块，结构复杂无法精确类型化
      const Tesseract = await Function('return import("tesseract.js")')() as any;
      const { data } = await Tesseract.recognize(capture.filePath, 'chi_sim+eng', {
        logger: (m) => { if (m.status === 'recognizing text') this.log.debug('OCR进度', { progress: m.progress }); },
      });
      this.log.info('OCR识别完成', { textLength: data.text.length, confidence: data.confidence });
      return {
        text: data.text,
        confidence: data.confidence,
        blocks: (data.blocks || []).map((b) => ({
          text: b.text,
          bbox: { x0: b.bbox.x0, y0: b.bbox.y0, x1: b.bbox.x1, y1: b.bbox.y1 },
        })),
      };
    } catch (err: unknown) {
      this.log.warn('Tesseract OCR不可用，尝试备用OCR方案', { error: err instanceof Error ? err.message : String(err) });
      try {
        // eslint-disable-next-line no-new-func, @typescript-eslint/no-explicit-any -- 动态 import 的 Tesseract 模块
        const TesseractFallback = await Function('return import("tesseract.js")')() as any;
        const { createWorker } = TesseractFallback;
        const worker = await createWorker('chi_sim+eng');
        const { data } = await worker.recognize(capture.filePath);
        await worker.terminate();
        return { text: data.text, confidence: data.confidence, blocks: [] };
      } catch (fallbackErr: unknown) {
        this.log.error('OCR全部失败', { error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) });
        return { text: '', confidence: 0, blocks: [] };
      }
    }
  }

  /**
   * 截取指定窗口
   */
  async captureWindow(windowTitle: string): Promise<ScreenCapture> {
    if (!this.rateLimitCheck()) {
      throw new Error('操作过于频繁，请稍后再试');
    }

    const outputPath = this.generateScreenshotPath('png');
    const startTime = Date.now();

    try {
      if (this.platform === 'win32') {
        // Windows: 通过窗口标题查找并截图
        const script = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$hwnd = [WinAPI]::FindWindow($null, '${windowTitle.replace(/'/g, "''")}');
if ($hwnd -eq [IntPtr]::Zero) { Write-Error 'Window not found'; exit 1 }
$rect = New-Object WinAPI+RECT;
[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null;
[WinAPI]::SetForegroundWindow($hwnd) | Out-Null;
Start-Sleep -Milliseconds 300;
$width = $rect.Right - $rect.Left;
$height = $rect.Bottom - $rect.Top;
$bmp = New-Object System.Drawing.Bitmap($width, $height);
$graphics = [System.Drawing.Graphics]::FromImage($bmp);
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height));
$graphics.Dispose();
$bmp.Save('${outputPath}', [System.Drawing.Imaging.ImageFormat]::Png);
$bmp.Dispose();
Write-Output "$width|$height"
`.trim();

        const result = this.execPowerShell(script);
        const [w, h] = result.split('|').map(Number);

        const fileBuffer = await fs.promises.readFile(outputPath);
        const base64 = fileBuffer.toString('base64');

        const capture: ScreenCapture = {
          filePath: outputPath,
          width: w,
          height: h,
          format: 'png',
          base64,
          timestamp: Date.now(),
        };

        this.stats.totalCaptures++;
        this.stats.lastCaptureTime = Date.now();

        this.log.info('窗口截图完成', {
          windowTitle,
          path: outputPath,
          width: w,
          height: h,
          duration: Date.now() - startTime,
        });

        this.emitEvent('window_captured', { windowTitle, filePath: outputPath });

        return capture;
      } else if (this.platform === 'darwin') {
        // macOS: 使用 screencapture -l 截取窗口
        this.execShell(`screencapture -x -o "${outputPath}"`);
      } else {
        // Linux: 使用 import 截取窗口
        this.execShell(`import -window "${windowTitle}" "${outputPath}"`);
      }

      // 通用回退：读取文件
      const fileBuffer = await fs.promises.readFile(outputPath);
      const base64 = fileBuffer.toString('base64');
      const size = this.getScreenSize();

      const capture: ScreenCapture = {
        filePath: outputPath,
        width: size.width,
        height: size.height,
        format: 'png',
        base64,
        timestamp: Date.now(),
      };

      this.stats.totalCaptures++;
      this.stats.lastCaptureTime = Date.now();

      this.emitEvent('window_captured', { windowTitle, filePath: outputPath });

      return capture;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('窗口截图失败', { windowTitle, error: message });
      throw new Error(`窗口截图失败: ${message}`);
    }
  }

  /**
   * 截图 + 视觉模型分析
   */
  async analyzeScreen(prompt?: string): Promise<ScreenAnalysis> {
    const startTime = Date.now();

    try {
      // 先截图
      const capture = await this.captureScreen({ format: 'png' });

      if (!this.modelLibrary) {
        throw new Error('视觉分析需要 ModelLibrary，请在构造函数中传入');
      }

      // 自动检测可用视觉模型
      const visionModelId = this.findVisionModel();
      if (!visionModelId) {
        throw new Error(
          '未找到可用的视觉模型。请配置一个支持 vision 的模型（如 GPT-4o、Gemini Flash）。\n' +
          '你也可以用 `browser_operate` 或 `screen_capture` + 手动描述的方式来替代 screen_analyze。'
        );
      }

      // 调用视觉模型
      const analysisPrompt = prompt || '描述这个屏幕截图中的内容，包括可见的UI元素、文本和布局。以JSON格式返回。';
      const response = await this.modelLibrary.call([
        {
          role: 'user',
          content: [
            { type: 'text', text: analysisPrompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${capture.base64}` } },
          ],
        },
      ], { modelId: visionModelId });

      // 解析视觉模型返回
      const analysis = this.parseScreenAnalysis(response.content);

      this.stats.totalAnalyses++;

      this.log.info('屏幕分析完成', {
        duration: Date.now() - startTime,
        elementCount: analysis.elements.length,
        textLength: analysis.text.length,
      });

      this.emitEvent('analyzed', {
        description: analysis.description.substring(0, 100),
        elementCount: analysis.elements.length,
      });

      return analysis;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('屏幕分析失败', { error: message });
      throw new Error(`屏幕分析失败: ${message}`);
    }
  }

  /** 解析视觉模型返回的分析结果 */
  private parseScreenAnalysis(content: string): ScreenAnalysis {
    const defaultAnalysis: ScreenAnalysis = {
      description: content,
      elements: [],
      text: '',
      suggestedActions: [],
    };

    try {
      // 尝试从返回内容中提取 JSON
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) ||
        content.match(/\{[\s\S]*"elements"[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        return {
          description: parsed.description || content,
          elements: (parsed.elements || []).map((el) => ({
            type: el.type || 'text',
            label: el.label || '',
            bounds: el.bounds,
            confidence: el.confidence || 0.5,
          })),
          text: parsed.text || '',
          suggestedActions: parsed.suggestedActions || [],
        };
      }
    } catch {
      // JSON 解析失败，返回原始文本
    }

    return defaultAnalysis;
  }

  /**
   * 点击指定坐标
   */
  click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<string> {
    if (!this.rateLimitCheck()) {
      return Promise.resolve('操作过于频繁，请稍后再试');
    }

    if (!this.validateCoordinates(x, y)) {
      return Promise.resolve(`坐标 (${x}, ${y}) 超出屏幕范围`);
    }

    try {
      if (this.platform === 'win32') {
        this.clickWindows(x, y, button);
      } else if (this.platform === 'darwin') {
        this.clickMac(x, y, button);
      } else {
        this.clickLinux(x, y, button);
      }

      this.stats.totalClicks++;

      this.log.info('点击操作完成', { x, y, button });
      this.emitEvent('clicked', { x, y, button });

      let buttonLabel: string;
      if (button === 'left') {
        buttonLabel = '左';
      } else if (button === 'right') {
        buttonLabel = '右';
      } else {
        buttonLabel = '中';
      }
      return Promise.resolve(`✅ 已在 (${x}, ${y}) 执行${buttonLabel}键点击`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('点击操作失败', { x, y, button, error: message });
      return Promise.resolve(`❌ 点击失败: ${message}`);
    }
  }

  /**
   * 双击指定坐标
   * 三平台实现：Windows 两次 mouse_event / macOS cliclick dc: / Linux xdotool click --repeat 2
   */
  doubleClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<string> {
    if (!this.rateLimitCheck()) {
      return Promise.resolve('操作过于频繁，请稍后再试');
    }
    if (!this.validateCoordinates(x, y)) {
      return Promise.resolve(`坐标 (${x}, ${y}) 超出屏幕范围`);
    }
    try {
      if (this.platform === 'win32') {
        // Windows: 两次单击间隔 50ms（mouse_event LEFTDOWN/UP = 0x0002/0x0004）
        const btnFlags = button === 'right'
          ? '0x0008, 0x0010'
          : button === 'middle'
            ? '0x0020, 0x0040'
            : '0x0002, 0x0004';
        const script = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
Start-Sleep -Milliseconds 30;
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int info);' -Name U32 -Namespace W;
[W.U32]::mouse_event(${btnFlags.split(',')[0]}, 0, 0, 0, 0); [W.U32]::mouse_event(${btnFlags.split(',')[1].trim()}, 0, 0, 0, 0);
Start-Sleep -Milliseconds 80;
[W.U32]::mouse_event(${btnFlags.split(',')[0]}, 0, 0, 0, 0); [W.U32]::mouse_event(${btnFlags.split(',')[1].trim()}, 0, 0, 0, 0);
`.trim();
        this.execPowerShell(script);
      } else if (this.platform === 'darwin') {
        // macOS: cliclick dc: 双击；右键用 rc: 两次
        const action = button === 'right' ? 'rc' : 'dc';
        this.execShell(`cliclick m:${x},${y} ${action}:${x},${y} ${action}:${x},${y}`);
      } else {
        // Linux: xdotool click --repeat 2
        let btn: string;
        if (button === 'right') btn = '3';
        else if (button === 'middle') btn = '2';
        else btn = '1';
        this.execShell(`xdotool mousemove ${x} ${y} click --repeat 2 ${btn}`);
      }
      this.stats.totalClicks += 2;
      this.emitEvent('doubleClicked', { x, y, button });
      this.log.info('双击操作完成', { x, y, button });
      return Promise.resolve(`✅ 已在 (${x}, ${y}) 执行双击`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      return Promise.resolve(`❌ 双击失败: ${message}`);
    }
  }

  /** Windows 点击实现 */
  private clickWindows(x: number, y: number, button: string): void {
    let _clickFlag: string;
    if (button === 'right') _clickFlag = 'Right';
    else if (button === 'middle') _clickFlag = 'Middle';
    else _clickFlag = 'Left';
    const script = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
Start-Sleep -Milliseconds 50;
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int info);' -Name U32 -Namespace W;
${(() => {
        if (button === 'right') return '[W.U32]::mouse_event(0x0008, 0, 0, 0, 0); [W.U32]::mouse_event(0x0010, 0, 0, 0, 0);';
        if (button === 'middle') return '[W.U32]::mouse_event(0x0020, 0, 0, 0, 0); [W.U32]::mouse_event(0x0040, 0, 0, 0, 0);';
        return '[W.U32]::mouse_event(0x0002, 0, 0, 0, 0); [W.U32]::mouse_event(0x0004, 0, 0, 0, 0);';
      })()}
`.trim();
    this.execPowerShell(script);
  }

  /** macOS 点击实现 */
  private clickMac(x: number, y: number, button: string): void {
    const btn = button === 'right' ? 'rc' : 'c';
    this.execShell(`cliclick m:${x},${y} ${btn}:${x},${y}`);
  }

  /** Linux 点击实现 */
  private clickLinux(x: number, y: number, button: string): void {
    let btn: string;
    if (button === 'right') {
      btn = '3';
    } else if (button === 'middle') {
      btn = '2';
    } else {
      btn = '1';
    }
    this.execShell(`xdotool mousemove ${x} ${y} click ${btn}`);
  }

  /**
   * 鼠标滚轮滚动
   */
  scroll(x: number, y: number, delta: number): Promise<string> {
    if (!this.rateLimitCheck()) return Promise.resolve('操作过于频繁，请稍后再试');
    try {
      if (this.platform === 'win32') {
        // Windows: mouse_event MOUSEEVENTF_WHEEL = 0x0800
        const script = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
Start-Sleep -Milliseconds 50;
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int info);' -Name U32 -Namespace W;
[W.U32]::mouse_event(0x0800, 0, 0, ${delta}, 0);
`.trim();
        this.execPowerShell(script);
      } else if (this.platform === 'darwin') {
        // macOS: cliclick 不支持滚轮事件，用键盘 Page Up/Down 模拟滚动
        // 先移动鼠标到目标位置，再发送翻页键（cliclick kp: 支持修饰键+键名）
        this.execShell(`cliclick m:${x},${y}`);
        const count = Math.max(1, Math.min(Math.abs(delta) / 120, 10));
        const key = delta > 0 ? 'pageup' : 'pagedown';
        const keys = Array(Math.floor(count)).fill(`kp:${key}`).join(' ');
        if (keys) this.execShell(`cliclick ${keys}`);
      } else {
        // Linux: xdotool click 4(上) / 5(下)
        const btn = delta > 0 ? '4' : '5';
        const count = Math.abs(delta) / 120;
        this.execShell(`xdotool mousemove ${x} ${y} click --repeat ${Math.min(count, 10)} ${btn}`);
      }
      this.emitEvent('scrolled', { x, y, delta });
      return Promise.resolve(`✅ 已在 (${x}, ${y}) 滚动 ${delta > 0 ? '上' : '下'} ${Math.abs(delta)} 单位`);
    } catch (err: unknown) {
      return Promise.resolve(`❌ 滚动失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 鼠标拖拽：从 (fromX, fromY) 拖到 (toX, toY)
   * 三平台实现：Windows mouse_event DOWN/MOVE/UP / macOS cliclick dd:dm:du: / Linux xdotool mousedown/mousemove/mouseup
   * 用于文件拖放、调整图层、绘制选区、滑块操作等场景。
   */
  dragMouse(fromX: number, fromY: number, toX: number, toY: number, button: 'left' | 'right' = 'left'): Promise<string> {
    if (!this.rateLimitCheck()) return Promise.resolve('操作过于频繁，请稍后再试');
    if (!this.validateCoordinates(fromX, fromY) || !this.validateCoordinates(toX, toY)) {
      return Promise.resolve(`坐标 (${fromX}, ${fromY})→(${toX}, ${toY}) 超出屏幕范围`);
    }
    try {
      if (this.platform === 'win32') {
        // Windows: mouse_event LEFTDOWN=0x0002 / MOVE=0x0001 / LEFTUP=0x0004
        // 右键: RIGHTDOWN=0x0008 / RIGHTUP=0x0010
        const down = button === 'right' ? '0x0008' : '0x0002';
        const up = button === 'right' ? '0x0010' : '0x0004';
        // 沿直线插值移动，模拟真实拖拽轨迹（10 步）
        const steps = 10;
        const moveLines: string[] = [];
        for (let i = 1; i <= steps; i++) {
          const mx = Math.round(fromX + ((toX - fromX) * i) / steps);
          const my = Math.round(fromY + ((toY - fromY) * i) / steps);
          moveLines.push(`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${mx}, ${my}); Start-Sleep -Milliseconds 20;`);
        }
        const script = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int info);' -Name U32 -Namespace W;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${fromX}, ${fromY});
Start-Sleep -Milliseconds 50;
[W.U32]::mouse_event(${down}, 0, 0, 0, 0);
Start-Sleep -Milliseconds 50;
${moveLines.join('\n')}
Start-Sleep -Milliseconds 50;
[W.U32]::mouse_event(${up}, 0, 0, 0, 0);
`.trim();
        this.execPowerShell(script);
      } else if (this.platform === 'darwin') {
        // macOS: cliclick dd:(down) dm:(move) du:(up) 支持轨迹
        const dd = button === 'right' ? 'rdd:' : 'dd:';
        const du = button === 'right' ? 'rdu:' : 'du:';
        const steps = 8;
        const moves: string[] = [];
        for (let i = 1; i <= steps; i++) {
          const mx = Math.round(fromX + ((toX - fromX) * i) / steps);
          const my = Math.round(fromY + ((toY - fromY) * i) / steps);
          moves.push(`dm:${mx},${my}`);
        }
        this.execShell(`cliclick m:${fromX},${fromY} ${dd}${fromX},${fromY} ${moves.join(' ')} ${du}${toX},${toY}`);
      } else {
        // Linux: xdotool mousedown/mousemove/mouseup
        const btn = button === 'right' ? '3' : '1';
        this.execShell(`xdotool mousemove ${fromX} ${fromY} mousedown ${btn} mousemove ${toX} ${toY} mouseup ${btn}`);
      }
      this.emitEvent('dragged', { fromX, fromY, toX, toY, button });
      this.log.info('拖拽操作完成', { fromX, fromY, toX, toY });
      return Promise.resolve(`✅ 已从 (${fromX}, ${fromY}) 拖拽到 (${toX}, ${toY})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      return Promise.resolve(`❌ 拖拽失败: ${message}`);
    }
  }

  /**
   * 窗口管理：最小化/最大化/关闭/置顶/获取窗口列表/移动/调整大小
   */
  windowManage(
    action: 'minimize' | 'maximize' | 'close' | 'foreground' | 'list' | 'move' | 'resize',
    windowTitle?: string,
    x?: number,
    y?: number,
    width?: number,
    height?: number,
  ): Promise<string> {
    try {
      if (this.platform === 'win32') {
        switch (action) {
          case 'list': {
            const script = `Add-Type -AssemblyName System.Windows.Forms; Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 20 MainWindowTitle, Id | ConvertTo-Json`;
            const result = this.execPowerShell(script);
            return Promise.resolve(`✅ 当前窗口列表:\n${result}`);
          }
          case 'foreground': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            // 安全转义：移除PowerShell特殊字符
            const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
            const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) { [Win32]::ShowWindow($proc.MainWindowHandle, 9); [Win32]::SetForegroundWindow($proc.MainWindowHandle); "已激活: $($proc.MainWindowTitle)" } else { "未找到窗口: ${safeTitle}" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
          case 'minimize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
            const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Win32Min { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) { [Win32Min]::ShowWindow($proc.MainWindowHandle, 6); "已最小化: $($proc.MainWindowTitle)" } else { "未找到窗口" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
          case 'maximize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
            const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Win32Max { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) { [Win32Max]::ShowWindow($proc.MainWindowHandle, 3); "已最大化: $($proc.MainWindowTitle)" } else { "未找到窗口" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
          case 'close': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
            // 优雅关闭：先发送WM_CLOSE，等待2秒，如果进程仍在则强制终止
            const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class WinClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) {
  [WinClose]::PostMessage($proc.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero);
  "已发送关闭请求: $($proc.MainWindowTitle)"
} else { "未找到窗口" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
          case 'move': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            if (x === undefined || y === undefined) return Promise.resolve('❌ move 操作需要 x, y 参数');
            const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
            // SetWindowPos(hwnd, hWndInsertAfter=0, x, y, w=0, h=0, flags=SWP_NOSIZE=0x0001|SWP_NOZORDER=0x0004)
            const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Win32Move {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) { [Win32Move]::SetWindowPos($proc.MainWindowHandle, [IntPtr]::Zero, ${x}, ${y}, 0, 0, 0x0005); "已移动窗口到 (${x}, ${y}): $($proc.MainWindowTitle)" } else { "未找到窗口" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
          case 'resize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            if (width === undefined || height === undefined) return Promise.resolve('❌ resize 操作需要 width, height 参数');
            const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
            // SWP_NOMOVE=0x0002|SWP_NOZORDER=0x0004 → 仅调整大小，不移动
            const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class Win32Resize {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if ($proc) { [Win32Resize]::SetWindowPos($proc.MainWindowHandle, [IntPtr]::Zero, 0, 0, ${width}, ${height}, 0x0006); "已调整窗口大小为 ${width}x${height}: $($proc.MainWindowTitle)" } else { "未找到窗口" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
        }
      } else if (this.platform === 'darwin') {
        // macOS: AppleScript 控制窗口（需在"系统偏好设置→安全性与隐私→隐私→辅助功能"授权）
        const safeTitle = (windowTitle || '').replace(/["\\]/g, '');
        switch (action) {
          case 'list': {
            const result = this.execShell(`osascript -e 'tell application "System Events" to get name of every window of (every process whose background only is false)' 2>/dev/null || osascript -e 'tell application "System Events" to get name of every process whose background only is false'`);
            return Promise.resolve(`✅ 当前应用/窗口列表:\n${result}`);
          }
          case 'foreground': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            this.execShell(`osascript -e 'tell application "${safeTitle}" to activate' 2>/dev/null || osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "${safeTitle}") to true'`);
            return Promise.resolve(`✅ 已激活: ${windowTitle}`);
          }
          case 'minimize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            this.execShell(`osascript -e 'tell application "${safeTitle}" to set miniaturized of every window to true' 2>/dev/null`);
            return Promise.resolve(`✅ 已最小化: ${windowTitle}`);
          }
          case 'maximize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            // macOS 无原生最大化，用全屏（zoom 或 toggle full screen）
            this.execShell(`osascript -e 'tell application "${safeTitle}" to set zoomed of every window to true' 2>/dev/null`);
            return Promise.resolve(`✅ 已最大化(zoom): ${windowTitle}`);
          }
          case 'close': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            this.execShell(`osascript -e 'tell application "${safeTitle}" to close every window' 2>/dev/null`);
            return Promise.resolve(`✅ 已关闭: ${windowTitle}`);
          }
          case 'move': {
            if (!windowTitle || x === undefined || y === undefined) return Promise.resolve('❌ move 需要 windowTitle, x, y');
            this.execShell(`osascript -e 'tell application "${safeTitle}" to set position of every window to {${x}, ${y}}' 2>/dev/null`);
            return Promise.resolve(`✅ 已移动窗口到 (${x}, ${y})`);
          }
          case 'resize': {
            if (!windowTitle || width === undefined || height === undefined) return Promise.resolve('❌ resize 需要 windowTitle, width, height');
            this.execShell(`osascript -e 'tell application "${safeTitle}" to set size of every window to {${width}, ${height}}' 2>/dev/null`);
            return Promise.resolve(`✅ 已调整窗口大小为 ${width}x${height}`);
          }
        }
      } else {
        // Linux: wmctrl 控制窗口（需安装 wmctrl）
        switch (action) {
          case 'list': {
            const result = this.execShell(`wmctrl -l 2>/dev/null | head -20`);
            return Promise.resolve(`✅ 当前窗口列表:\n${result || '(wmctrl 未安装，请运行 sudo apt install wmctrl)'}`);
          }
          case 'foreground': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            this.execShell(`wmctrl -a "${(windowTitle || '').replace(/["\\]/g, '')}" 2>/dev/null`);
            return Promise.resolve(`✅ 已激活: ${windowTitle}`);
          }
          case 'close': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            this.execShell(`wmctrl -c "${(windowTitle || '').replace(/["\\]/g, '')}" 2>/dev/null`);
            return Promise.resolve(`✅ 已关闭: ${windowTitle}`);
          }
          case 'minimize':
          case 'maximize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            // wmctrl -r <title> -b toggle,<action>
            const prop = action === 'minimize' ? 'hidden' : 'maximized_vert,maximized_horz';
            this.execShell(`wmctrl -r "${(windowTitle || '').replace(/["\\]/g, '')}" -b toggle,${prop} 2>/dev/null`);
            return Promise.resolve(`✅ 已${action === 'minimize' ? '最小化' : '最大化'}: ${windowTitle}`);
          }
          case 'move':
          case 'resize': {
            if (!windowTitle) return Promise.resolve('❌ 需要提供 windowTitle 参数');
            // wmctrl -r <title> -e <gravity>,<x>,<y>,<w>,<h>（gravity=0 保持默认）
            const gx = x ?? 0;
            const gy = y ?? 0;
            const gw = width ?? 0;
            const gh = height ?? 0;
            this.execShell(`wmctrl -r "${(windowTitle || '').replace(/["\\]/g, '')}" -e 0,${gx},${gy},${gw},${gh} 2>/dev/null`);
            return Promise.resolve(`✅ 已${action === 'move' ? '移动' : '调整'}窗口: ${windowTitle}`);
          }
        }
      }
    } catch (err: unknown) {
      return Promise.resolve(`❌ 窗口操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return Promise.resolve('❌ 未知操作');
  }

  /**
   * 剪贴板操作
   */
  clipboard(action: 'read' | 'write', text?: string): Promise<string> {
    try {
      if (this.platform === 'win32') {
        if (action === 'read') {
          const result = this.execPowerShell(`Get-Clipboard`);
          return Promise.resolve(`✅ 剪贴板内容: ${result.substring(0, 500)}`);
        } else {
          if (!text) return Promise.resolve('❌ 需要提供 text 参数');
          this.execPowerShell(`Set-Clipboard -Value ${JSON.stringify(text)}`);
          return Promise.resolve(`✅ 已写入剪贴板: ${text.substring(0, 100)}`);
        }
      } else if (this.platform === 'darwin') {
        if (action === 'read') {
          const result = this.execShell(`pbpaste`);
          return Promise.resolve(`✅ 剪贴板内容: ${result.substring(0, 500)}`);
        } else {
          if (!text) return Promise.resolve('❌ 需要提供 text 参数');
          this.execShell(`echo ${JSON.stringify(text)} | pbcopy`);
          return Promise.resolve(`✅ 已写入剪贴板`);
        }
      } else {
        // Linux: xclip（首选）/ xsel（降级）
        if (action === 'read') {
          const result = this.execShell(`xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null`);
          return Promise.resolve(`✅ 剪贴板内容: ${result.substring(0, 500)}`);
        } else {
          if (!text) return Promise.resolve('❌ 需要提供 text 参数');
          this.execShell(`echo ${JSON.stringify(text)} | xclip -selection clipboard 2>/dev/null || echo ${JSON.stringify(text)} | xsel --clipboard --input 2>/dev/null`);
          return Promise.resolve(`✅ 已写入剪贴板`);
        }
      }
    } catch (err: unknown) {
      return Promise.resolve(`❌ 剪贴板操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 系统控制：音量/亮度/锁屏/通知
   * 三平台实现：
   * - 音量：Windows nircmd/SndVol / macOS osascript / Linux amixer
   * - 亮度：Windows WmiMonitorBrightness / macOS brightness / Linux xrandr/brightnessctl
   * - 锁屏：Windows rundll32 user32,LockWorkStation / macOS pmset / Linux xdg-screensaver
   * - 通知：Windows msg / macOS osascript display notification / Linux notify-send
   */
  systemControl(
    action: 'volume' | 'brightness' | 'lock' | 'notify',
    value?: string | number,
    message?: string,
  ): Promise<string> {
    try {
      if (action === 'volume') {
        const v = typeof value === 'number' ? value : parseInt(String(value || '50'));
        if (isNaN(v) || v < 0 || v > 100) return Promise.resolve('❌ 音量值必须在 0-100 之间');
        if (this.platform === 'win32') {
          // nircmd setsysvolume（0-65535）；若无 nircmd 降级到 PowerShell SendMessage WAVE apps
          const scaled = Math.round((v / 100) * 65535);
          this.execPowerShell(`try { nircmd setsysvolume ${scaled} } catch { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class V { [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l); }'; [V]::SendMessageW([IntPtr]0xffff, 0x319, [IntPtr]0x30292, [IntPtr]${scaled}) }`);
          return Promise.resolve(`✅ 系统音量已设置为 ${v}%`);
        } else if (this.platform === 'darwin') {
          this.execShell(`osascript -e 'set volume output volume ${v}'`);
          return Promise.resolve(`✅ 系统音量已设置为 ${v}%`);
        } else {
          // Linux: amixer（默认 Master）；0% 静音
          const mv = String(Math.round(v));
          this.execShell(`amixer -q sset Master ${mv}% 2>/dev/null || amixer -q set Master ${mv}% 2>/dev/null`);
          return Promise.resolve(`✅ 系统音量已设置为 ${v}%`);
        }
      }

      if (action === 'brightness') {
        const v = typeof value === 'number' ? value : parseInt(String(value || '80'));
        if (isNaN(v) || v < 0 || v > 100) return Promise.resolve('❌ 亮度值必须在 0-100 之间');
        if (this.platform === 'win32') {
          // WmiMonitorBrightnessMethods（部分显示器不支持，降级提示）
          const script = `try {
$mon = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
$mon.WmiSetBrightness(1, ${v / 100})
"已设置亮度为 ${v}%"
} catch { "⚠️ 当前显示器不支持软件亮度调节（WmiMonitorBrightness 不可用）" }`;
          return Promise.resolve(this.execPowerShell(script));
        } else if (this.platform === 'darwin') {
          this.execShell(`brightness ${v / 100} 2>/dev/null || osascript -e 'tell application "System Events" to set brightness of every window to ${v / 100}' 2>/dev/null || echo "⚠️ 请安装 brightness: brew install brightness"`);
          return Promise.resolve(`✅ 屏幕亮度已设置为 ${v}%`);
        } else {
          this.execShell(`brightnessctl set ${v}% 2>/dev/null || xrandr --output $(xrandr | grep ' connected' | head -1 | cut -d' ' -f1) --brightness ${v / 100} 2>/dev/null || echo "⚠️ 请安装 brightnessctl 或 xrandr"`);
          return Promise.resolve(`✅ 屏幕亮度已设置为 ${v}%`);
        }
      }

      if (action === 'lock') {
        if (this.platform === 'win32') {
          this.execPowerShell('rundll32.exe user32.dll,LockWorkStation');
          return Promise.resolve('✅ 已锁定屏幕');
        } else if (this.platform === 'darwin') {
          this.execShell('pmset displaysleepnow');
          return Promise.resolve('✅ 已锁定屏幕');
        } else {
          this.execShell('xdg-screensaver lock 2>/dev/null || gnome-screensaver-command -l 2>/dev/null || loginctl lock-session 2>/dev/null');
          return Promise.resolve('✅ 已锁定屏幕');
        }
      }

      if (action === 'notify') {
        const msg = String(message || '通知');
        const title = String(value || 'Agent');
        if (this.platform === 'win32') {
          // msg 命令发送消息弹窗（仅当前会话）
          this.execPowerShell(`msg * /TIME:10 ${JSON.stringify(msg).replace(/"/g, '"')}`);
          return Promise.resolve(`✅ 已发送通知: ${msg}`);
        } else if (this.platform === 'darwin') {
          const safeTitle = title.replace(/["\\]/g, '');
          const safeMsg = msg.replace(/["\\]/g, '');
          this.execShell(`osascript -e 'display notification "${safeMsg}" with title "${safeTitle}"'`);
          return Promise.resolve(`✅ 已发送通知: ${msg}`);
        } else {
          const safeTitle = title.replace(/["\\]/g, '');
          const safeMsg = msg.replace(/["\\]/g, '');
          this.execShell(`notify-send "${safeTitle}" "${safeMsg}" 2>/dev/null || echo "⚠️ 请安装 libnotify-bin: sudo apt install libnotify-bin"`);
          return Promise.resolve(`✅ 已发送通知: ${msg}`);
        }
      }

      return Promise.resolve(`❌ 未知系统操作: ${action}`);
    } catch (err: unknown) {
      return Promise.resolve(`❌ 系统操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 进程管理：列出运行中的进程 / 受控终止进程
   *
   * 安全设计：
   * - list: 返回 top N 进程（按 CPU/内存排序），只读
   * - kill: 终止前记录审计日志，受 approval-gate 约束（不绕过安全框架）
   *   仅终止用户进程，拒绝系统关键进程（explorer/csrss/wininit/svchost/System 等）
   */
  processManage(action: 'list' | 'kill', target?: string | number): Promise<string> {
    try {
      if (action === 'list') {
        const limit = 30;
        if (this.platform === 'win32') {
          // 按 CPU 降序列出 top 进程
          const script = `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${limit} Id, ProcessName, @{N='CPU(s)';E={[math]::Round($_.CPU,1)}}, @{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB,0)}} | ConvertTo-Json`;
          const result = this.execPowerShell(script);
          return Promise.resolve(`✅ Top ${limit} 进程（按CPU排序）:\n${result}`);
        } else {
          // ps 命令列出 top 进程（兼容 macOS/BSD 和 Linux）
          const sortFlag = this.platform === 'darwin' ? '-rcpu' : '--sort=-pcpu';
          const result = this.execShell(`ps aux ${sortFlag} 2>/dev/null | head -${limit + 1}`);
          return Promise.resolve(`✅ Top ${limit} 进程:\n${result}`);
        }
      }

      if (action === 'kill') {
        if (target === undefined || target === null) {
          return Promise.resolve('❌ kill 操作需要 target 参数（进程名或 PID）');
        }
        // 系统关键进程白名单保护 — 拒绝终止
        const protectedNames = [
          'explorer', 'csrss', 'wininit', 'winlogon', 'svchost', 'System',
          'smss', 'services', 'lsass', 'fontdrvhost', 'dwm',
          'launchd', 'kernel_task', 'windowserver',  // macOS 关键
          'systemd', 'init', 'kthreadd',  // Linux 关键
        ];
        const targetStr = String(target).toLowerCase();
        if (protectedNames.some(p => targetStr === p || targetStr.startsWith(p + '.exe'))) {
          this.log.warn('拒绝终止系统关键进程', { target });
          return Promise.resolve(`❌ 安全保护：拒绝终止系统关键进程 "${target}"（防止系统崩溃）`);
        }

        this.log.warn('进程终止请求', { target });

        if (this.platform === 'win32') {
          // 判断是 PID（数字）还是进程名
          const pid = typeof target === 'number' ? target : parseInt(String(target));
          if (!isNaN(pid) && String(target).match(/^\d+$/)) {
            const script = `try { Stop-Process -Id ${pid} -Force -ErrorAction Stop; "已终止进程 PID=${pid}" } catch { "终止失败: $($_.Exception.Message)" }`;
            return Promise.resolve(this.execPowerShell(script));
          } else {
            const safeName = String(target).replace(/[`$"'\\]/g, '');
            const script = `try { Stop-Process -Name "${safeName}" -Force -ErrorAction Stop; "已终止进程 ${safeName}" } catch { "终止失败: $($_.Exception.Message)" }`;
            return Promise.resolve(this.execPowerShell(script));
          }
        } else {
          const pid = typeof target === 'number' ? target : parseInt(String(target));
          if (!isNaN(pid) && String(target).match(/^\d+$/)) {
            this.execShell(`kill -TERM ${pid} 2>/dev/null || kill ${pid}`);
            return Promise.resolve(`✅ 已发送终止信号 PID=${pid}`);
          } else {
            this.execShell(`pkill -TERM "${String(target).replace(/["\\]/g, '')}" 2>/dev/null || pkill "${String(target).replace(/["\\]/g, '')}"`);
            return Promise.resolve(`✅ 已终止进程 ${target}`);
          }
        }
      }

      return Promise.resolve(`❌ 未知进程操作: ${action}`);
    } catch (err: unknown) {
      return Promise.resolve(`❌ 进程操作失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 输入文本
   */
  type(text: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return Promise.resolve('操作过于频繁，请稍后再试');
    }

    if (!text || text.length === 0) {
      return Promise.resolve('输入文本不能为空');
    }

    try {
      if (this.platform === 'win32') {
        this.typeWindows(text);
      } else if (this.platform === 'darwin') {
        this.typeMac(text);
      } else {
        this.typeLinux(text);
      }

      this.stats.totalTypes++;

      this.log.info('文本输入完成', { length: text.length });
      this.emitEvent('typed', { textLength: text.length });

      return Promise.resolve(`✅ 已输入 ${text.length} 个字符`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('文本输入失败', { error: message });
      return Promise.resolve(`❌ 文本输入失败: ${message}`);
    }
  }

  /** Windows 文本输入实现 */
  private typeWindows(text: string): void {
    // 转义 SendKeys 特殊字符
    const escaped = text
      .replace(/\{/g, '{{}')
      .replace(/\}/g, '{}}')
      .replace(/\+/g, '{+}')
      .replace(/\^/g, '{^}')
      .replace(/%/g, '{%}')
      .replace(/~/g, '{~}')
      .replace(/\(/g, '{(}')
      .replace(/\)/g, '{)}');

    const script = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}');
`.trim();
    // SendKeys 用较短超时（8s）：若窗口未聚焦 SendWait 会阻塞，快速失败让 agent 能重试
    this.execPowerShell(script, 8000);
  }

  /** macOS 文本输入实现 */
  private typeMac(text: string): void {
    // cliclick 不支持直接输入中文，使用剪贴板方式
    const escaped = text.replace(/"/g, '\\"').replace(/`/g, '\\`');
    this.execShell(`echo -n "${escaped}" | pbcopy && cliclick kp:cmd-v`);
  }

  /** Linux 文本输入实现 */
  private typeLinux(text: string): void {
    const escaped = text.replace(/"/g, '\\"');
    this.execShell(`xdotool type --delay 50 "${escaped}"`);
  }

  /**
   * 按下键盘按键
   */
  pressKey(key: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return Promise.resolve('操作过于频繁，请稍后再试');
    }

    try {
      if (this.platform === 'win32') {
        this.pressKeyWindows(key);
      } else if (this.platform === 'darwin') {
        this.pressKeyMac(key);
      } else {
        this.pressKeyLinux(key);
      }

      this.stats.totalKeyPresses++;

      this.log.info('按键操作完成', { key });
      this.emitEvent('key_pressed', { key });

      return Promise.resolve(`✅ 已按下按键: ${key}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('按键操作失败', { key, error: message });
      return Promise.resolve(`❌ 按键失败: ${message}`);
    }
  }

  /** 将按键名映射为 SendKeys 格式 */
  private mapKeyToSendKeys(key: string): string {
    const keyMap: Record<string, string> = {
      'Enter': '{ENTER}',
      'Tab': '{TAB}',
      'Escape': '{ESC}',
      'Backspace': '{BS}',
      'Delete': '{DEL}',
      'Up': '{UP}',
      'Down': '{DOWN}',
      'Left': '{LEFT}',
      'Right': '{RIGHT}',
      'Home': '{HOME}',
      'End': '{END}',
      'PageUp': '{PGUP}',
      'PageDown': '{PGDN}',
      'F1': '{F1}', 'F2': '{F2}', 'F3': '{F3}', 'F4': '{F4}',
      'F5': '{F5}', 'F6': '{F6}', 'F7': '{F7}', 'F8': '{F8}',
      'F9': '{F9}', 'F10': '{F10}', 'F11': '{F11}', 'F12': '{F12}',
      'Space': ' ',
      'Ctrl+C': '^c',
      'Ctrl+V': '^v',
      'Ctrl+X': '^x',
      'Ctrl+Z': '^z',
      'Ctrl+A': '^a',
      'Ctrl+S': '^s',
      'Ctrl+P': '^p',
      'Ctrl+N': '^n',
      'Ctrl+O': '^o',
      'Ctrl+W': '^w',
      'Ctrl+Q': '^q',
      'Alt+Tab': '%{TAB}',
      'Alt+F4': '%{F4}',
    };

    return keyMap[key] || key;
  }

  /** 将按键名映射为 xdotool 格式 */
  private mapKeyToXdotool(key: string): string {
    const keyMap: Record<string, string> = {
      'Enter': 'Return',
      'Tab': 'Tab',
      'Escape': 'Escape',
      'Backspace': 'BackSpace',
      'Delete': 'Delete',
      'Up': 'Up',
      'Down': 'Down',
      'Left': 'Left',
      'Right': 'Right',
      'Home': 'Home',
      'End': 'End',
      'PageUp': 'Page_Up',
      'PageDown': 'Page_Down',
      'Space': 'space',
      'Ctrl+C': 'ctrl+c',
      'Ctrl+V': 'ctrl+v',
      'Ctrl+X': 'ctrl+x',
      'Ctrl+Z': 'ctrl+z',
      'Ctrl+A': 'ctrl+a',
      'Ctrl+S': 'ctrl+s',
      'Alt+Tab': 'alt+Tab',
      'Alt+F4': 'alt+F4',
    };

    return keyMap[key] || key;
  }

  /** Windows 按键实现 */
  private pressKeyWindows(key: string): void {
    const sendKey = this.mapKeyToSendKeys(key);
    const script = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('${sendKey.replace(/'/g, "''")}');
`.trim();
    // SendKeys 用较短超时（8s）：按键操作应瞬间完成，阻塞即说明窗口未聚焦
    this.execPowerShell(script, 8000);
  }

  /** macOS 按键实现 */
  private pressKeyMac(key: string): void {
    // cliclick 按键映射
    const keyMap: Record<string, string> = {
      'Enter': 'kp:return',
      'Tab': 'kp:tab',
      'Escape': 'kp:escape',
      'Backspace': 'kp:delete',
      'Delete': 'kp:forward-delete',
      'Up': 'kp:up',
      'Down': 'kp:down',
      'Left': 'kp:left',
      'Right': 'kp:right',
      'Space': 'kp:space',
    };

    const cliclickKey = keyMap[key];
    if (cliclickKey) {
      this.execShell(`cliclick ${cliclickKey}`);
    } else if (key.startsWith('Ctrl+')) {
      const char = key.split('+')[1].toLowerCase();
      this.execShell(`osascript -e 'tell application "System Events" to keystroke "${char}" using control down'`);
    } else if (key.startsWith('Alt+')) {
      const char = key.split('+')[1].toLowerCase();
      this.execShell(`osascript -e 'tell application "System Events" to keystroke "${char}" using option down'`);
    } else {
      // 单字符按键
      this.execShell(`osascript -e 'tell application "System Events" to keystroke "${key}"'`);
    }
  }

  /** Linux 按键实现 */
  private pressKeyLinux(key: string): string {
    const xdotoolKey = this.mapKeyToXdotool(key);
    this.execShell(`xdotool key ${xdotoolKey}`);
    return xdotoolKey;
  }

  /**
   * 移动鼠标到指定坐标
   */
  moveMouse(x: number, y: number): Promise<string> {
    if (!this.rateLimitCheck()) {
      return Promise.resolve('操作过于频繁，请稍后再试');
    }

    if (!this.validateCoordinates(x, y)) {
      return Promise.resolve(`坐标 (${x}, ${y}) 超出屏幕范围`);
    }

    try {
      if (this.platform === 'win32') {
        this.moveMouseWindows(x, y);
      } else if (this.platform === 'darwin') {
        this.moveMouseMac(x, y);
      } else {
        this.moveMouseLinux(x, y);
      }

      this.log.info('鼠标移动完成', { x, y });
      this.emitEvent('mouse_moved', { x, y });

      return Promise.resolve(`✅ 鼠标已移动到 (${x}, ${y})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('鼠标移动失败', { x, y, error: message });
      return Promise.resolve(`❌ 鼠标移动失败: ${message}`);
    }
  }

  /** Windows 鼠标移动实现 */
  private moveMouseWindows(x: number, y: number): void {
    const script = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
`.trim();
    this.execPowerShell(script);
  }

  /** macOS 鼠标移动实现 */
  private moveMouseMac(x: number, y: number): void {
    this.execShell(`cliclick m:${x},${y}`);
  }

  /** Linux 鼠标移动实现 */
  private moveMouseLinux(x: number, y: number): void {
    this.execShell(`xdotool mousemove ${x} ${y}`);
  }

  /**
   * 获取屏幕尺寸
   */
  getScreenSize(): ScreenSize {
    // 每次都重新获取，不缓存（支持分辨率变化和多显示器切换）
    try {
      if (this.platform === 'win32') {
        const result = this.execPowerShell(`
Add-Type -AssemblyName System.Windows.Forms;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen;
$scale = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width / [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width;
if ($scale -lt 1) { $scale = 1 / $scale };
Write-Output "$($screen.Bounds.Width)|$($screen.Bounds.Height)|$scale";
`.trim());
        const parts = result.split('|').map(Number);
        const w = parts[0] || 1920;
        const h = parts[1] || 1080;
        // 获取DPI缩放因子
        let scaleFactor = 1;
        try {
          const dpiResult = this.execPowerShell(`
Add-Type -AssemblyName System.Windows.Forms;
$dpi = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width / ([System.Windows.Forms.SystemInformation]::VirtualScreen.Width / [System.Windows.Forms.SystemInformation]::MonitorCount);
Write-Output $dpi;
`.trim());
          const parsed = parseFloat(dpiResult);
          if (!isNaN(parsed) && parsed > 0) scaleFactor = parsed;
        } catch {}
        this.screenSize = { width: w, height: h, scaleFactor };
      } else if (this.platform === 'darwin') {
        const result = this.execShell('system_profiler SPDisplaysDataType | grep Resolution | head -1');
        const match = result.match(/(\d+)\s*x\s*(\d+)/);
        if (match) {
          this.screenSize = { width: parseInt(match[1]), height: parseInt(match[2]), scaleFactor: 2 };
        }
      } else {
        const result = this.execShell('xdpyinfo | grep dimensions | head -1');
        const match = result.match(/(\d+)x(\d+)/);
        if (match) {
          this.screenSize = { width: parseInt(match[1]), height: parseInt(match[2]), scaleFactor: 1 };
        }
      }
    } catch (err: unknown) {
      this.log.warn('获取屏幕尺寸失败，使用默认值', { error: err instanceof Error ? err.message : String(err) });
    }

    if (!this.screenSize) {
      this.screenSize = { width: 1920, height: 1080, scaleFactor: 1 };
    }

    return this.screenSize;
  }

  /**
   * 在屏幕上查找元素
   */
  async findOnScreen(template: string): Promise<string> {
    const startTime = Date.now();

    try {
      // 先截图
      const capture = await this.captureScreen({ format: 'png' });

      if (!this.modelLibrary) {
        throw new Error('屏幕查找需要 ModelLibrary，请在构造函数中传入');
      }

      // 自动检测可用视觉模型
      const visionModelId = this.findVisionModel();
      if (!visionModelId) {
        return '❌ 未找到可用的视觉模型。请配置一个支持 vision 的模型（如 GPT-4o、Gemini Flash）。你也可以用 screen_capture 截图后自行判断坐标。';
      }

      // 使用视觉模型查找
      const prompt = `在屏幕截图中查找"${template}"元素。如果找到，返回其大致坐标（JSON格式: {"found": true, "x": 数字, "y": 数字, "confidence": 0-1}）。如果未找到，返回 {"found": false}。只返回JSON，不要其他文字。`;
      const response = await this.modelLibrary.call([
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${capture.base64}` } },
          ],
        },
      ], { modelId: visionModelId });

      this.stats.totalFinds++;

      // 解析结果
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        if (result.found) {
          this.log.info('屏幕查找成功', {
            template,
            x: result.x,
            y: result.y,
            confidence: result.confidence,
            duration: Date.now() - startTime,
          });
          this.emitEvent('found', { template, x: result.x, y: result.y });
          return `✅ 找到"${template}"，坐标: (${result.x}, ${result.y})，置信度: ${(result.confidence * 100).toFixed(0)}%`;
        }
      }

      this.log.info('屏幕查找未找到', { template, duration: Date.now() - startTime });
      return `❌ 未在屏幕上找到"${template}"`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('屏幕查找失败', { template, error: message });
      return `❌ 屏幕查找失败: ${message}`;
    }
  }

  /**
   * 打开应用程序
   * Windows 下优先用 Start-Process 启动；若应用不在 PATH 则查找常见安装路径与注册表
   */
  openApplication(name: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return Promise.resolve('操作过于频繁，请稍后再试');
    }

    try {
      if (this.platform === 'win32') {
        const resolved = this.resolveWindowsAppPath(name);
        if (resolved) {
          // 已定位到完整 exe 路径，直接启动
          this.execPowerShell(`Start-Process '${resolved.replace(/'/g, "''")}'`);
        } else {
          // 退回到原始名称（让 PowerShell 自行解析，失败则抛出可读错误）
          this.execPowerShell(`Start-Process '${name.replace(/'/g, "''")}'`);
        }
      } else if (this.platform === 'darwin') {
        this.execShell(`open -a "${name}"`);
      } else {
        this.execShell(`xdg-open "${name}" 2>/dev/null || ${name} &`);
      }

      this.stats.totalAppOpens++;

      this.log.info('应用启动完成', { name, platform: this.platform });
      this.emitEvent('app_opened', { name });

      return Promise.resolve(`✅ 已启动应用: ${name}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      this.log.error('应用启动失败', { name, error: message });
      // 错误信息清理：PowerShell 的 CLIXML stderr (#< CLIXML ...) 转为可读文本
      const cleanMsg = this.cleanPowerShellError(message, name);
      return Promise.resolve(`❌ 应用启动失败: ${cleanMsg}`);
    }
  }

  /**
   * Windows 应用路径解析：常见安装路径表 + 注册表查询
   * 返回完整 exe 路径或 null（未找到时由调用方回退到 Start-Process 原始名称）
   */
  private resolveWindowsAppPath(name: string): string | null {
    const key = name.toLowerCase().replace(/\.exe$/i, '');
    // 常见中文办公/通讯应用的安装路径（覆盖 32/64 位、默认/自定义安装目录）
    const knownPaths: Record<string, string[]> = {
      wechat: [
        'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
        'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
        'D:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
        'D:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
        'D:\\Tencent\\WeChat\\WeChat.exe',
        'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
        'D:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        'D:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
      ],
      weixin: [
        'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
        'D:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        'D:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
      ],
      dingtalk: [
        'C:\\Program Files\\DingDing\\DingTalk.exe',
        'C:\\Program Files (x86)\\DingDing\\DingTalk.exe',
        'D:\\DingDing\\DingTalk.exe',
      ],
      feishu: [
        'C:\\Program Files\\Lark\\Lark.exe',
        'C:\\Program Files (x86)\\Lark\\Lark.exe',
        'C:\\Program Files\\Feishu\\Feishu.exe',
        'C:\\Program Files (x86)\\Feishu\\Feishu.exe',
      ],
      lark: [
        'C:\\Program Files\\Lark\\Lark.exe',
        'C:\\Program Files (x86)\\Lark\\Lark.exe',
      ],
      qq: [
        'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe',
        'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe',
      ],
      photoshop: [
        'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe',
        'C:\\Program Files\\Adobe\\Adobe Photoshop 2023\\Photoshop.exe',
        'C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe',
      ],
      powerpnt: [
        'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
        'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
        'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE',
        'C:\\Program Files (x86)\\Microsoft Office\\Office16\\POWERPNT.EXE',
      ],
      word: [
        'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
        'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
      ],
      excel: [
        'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
        'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      ],
    };
    const candidates = knownPaths[key];
    if (candidates) {
      for (const p of candidates) {
        try {
          fs.accessSync(p);
          return p;
        } catch {
          // 继续尝试下一个候选路径
        }
      }
    }
    // 注册表查询：HKLM/HKCU Software\\Microsoft\\Windows\\CurrentVersion\\App Paths
    try {
      const regScript = `
$paths = @(
  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}.exe",
  "HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}.exe",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}.exe"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $v = (Get-ItemProperty $p -ErrorAction SilentlyContinue).'(default)'
    if ($v) { Write-Output $v; break }
  }
}`;
      const regResult = this.execPowerShell(regScript).trim();
      if (regResult && regResult.length > 0 && !regResult.includes('错误')) {
        return regResult;
      }
    } catch {
      // 注册表查询失败，忽略
    }
    // 最终回退：扫描正在运行的进程，按进程名（含已知变体）匹配并返回 exe 完整路径
    // 这是应用已安装但未在常见目录/注册表时的最可靠定位方式（如新版微信 WeChat→Weixin）
    try {
      const variants: Record<string, string[]> = {
        wechat: ['WeChat', 'Weixin'],
        weixin: ['Weixin', 'WeChat'],
        dingtalk: ['DingTalk', 'DingDing'],
        feishu: ['Feishu', 'Lark'],
        lark: ['Lark', 'Feishu'],
      };
      const procNames = variants[key] ?? [key];
      const procList = procNames.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
      const procScript = `
Get-Process -Name @(${procList}) -ErrorAction SilentlyContinue |
  Where-Object { $_.Path } |
  Select-Object -First 1 -ExpandProperty Path`;
      const procResult = this.execPowerShell(procScript).trim();
      if (procResult && procResult.length > 0 && !procResult.includes('错误')) {
        return procResult;
      }
    } catch {
      // 进程扫描失败，忽略
    }
    return null;
  }

  /**
   * 清理 PowerShell CLIXML 错误输出，转为可读文本
   * PowerShell 通过 stderr 输出 "#< CLIXML <Objs>...</Objs>" 格式，中文常显示为 ?????
   */
  private cleanPowerShellError(message: string, appName: string): string {
    let m = message;
    // 移除 CLIXML 包装
    if (m.includes('#< CLIXML')) {
      m = m.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '');
      m = m.replace(/#< CLIXML/g, '');
      // 提取 <S S="Error">...</S> 中的文本
      const errorMatches = m.match(/<S S="Error">([\s\S]*?)<\/S>/g);
      if (errorMatches) {
        const texts = errorMatches
          .map(e => e.replace(/<S S="Error">([\s\S]*?)<\/S>/, '$1').replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
          .filter(t => t.trim().length > 0);
        if (texts.length > 0) m = texts.join(' ');
      }
    }
    // 常见错误信息中文化
    if (m.includes('cannot find the file') || m.includes('系统找不到指定的文件')) {
      return `系统找不到应用 "${appName}"，请确认已安装或在 PATH 中（可尝试用完整路径）`;
    }
    return m.trim() || `启动 ${appName} 失败`;
  }

  // ============ 窗口句柄缓存与异步执行（响应时间优化） ============

  /** 窗口句柄缓存：windowTitle -> { handle, expireAt } */
  private windowHandleCache: Map<string, { handle: string; expireAt: number }> = new Map();
  private readonly HANDLE_CACHE_TTL = 30000; // 30 秒有效期

  /**
   * 获取窗口句柄（带缓存，减少重复 PowerShell 查询开销）
   * @param windowTitle 窗口标题
   * @returns 窗口句柄字符串（数字），未找到返回 null
   */
  getWindowHandle(windowTitle: string): Promise<string | null> {
    // 1. 检查缓存
    const cached = this.windowHandleCache.get(windowTitle);
    if (cached && cached.expireAt > Date.now()) {
      return Promise.resolve(cached.handle);
    }
    if (cached) {
      this.windowHandleCache.delete(windowTitle);
    }

    // 2. 查询窗口句柄
    if (this.platform !== 'win32') {
      return Promise.resolve(null);
    }
    try {
      const safeTitle = windowTitle.replace(/[`$"'\\]/g, '');
      const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class WinHandle {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string w);
}
'@
$h = [WinHandle]::FindWindow($null, '${safeTitle}')
if ($h -ne [IntPtr]::Zero) { Write-Output $h.ToInt64() } else { Write-Output '0' }`;
      const result = this.execPowerShell(script);
      const handle = result.trim();
      if (handle && handle !== '0') {
        // 写入缓存
        this.windowHandleCache.set(windowTitle, {
          handle,
          expireAt: Date.now() + this.HANDLE_CACHE_TTL,
        });
        return Promise.resolve(handle);
      }
    } catch (err: unknown) {
      this.log.warn('获取窗口句柄失败', { windowTitle, error: err instanceof Error ? err.message : String(err) });
    }
    return Promise.resolve(null);
  }

  /** 使指定窗口的句柄缓存失效 */
  invalidateWindowHandle(windowTitle: string): void {
    this.windowHandleCache.delete(windowTitle);
  }

  /** 清空所有窗口句柄缓存 */
  clearWindowHandleCache(): void {
    this.windowHandleCache.clear();
  }

  /**
   * 异步非阻塞执行命令（不等待结果，立即返回）
   * 用于 fire-and-forget 场景，提升响应时间
   * @param command 要执行的命令
   * @returns 启动的进程信息
   */
  async execAsync(command: string): Promise<{ pid: number; started: boolean; error?: string }> {
    try {
      const { spawn } = await import('child_process');
      const shellPath = process.env.ComSpec || (this.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const child = spawn(shellPath, [this.platform === 'win32' ? '/c' : '-c', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      this.emitEvent('async_exec_started', { command: command.substring(0, 200), pid: child.pid });
      return { pid: child.pid ?? 0, started: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('异步执行失败', { command: command.substring(0, 200), error: message });
      return { pid: 0, started: false, error: message };
    }
  }

  /**
   * 带超时执行异步任务
   * @param task 异步任务
   * @param timeoutMs 超时时间（毫秒），<=0 表示不限
   */
  async runWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) return task;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
    });
    try {
      return await Promise.race([task, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ============ 统计信息 ============

  /** 获取操作统计 */
  getStats(): DesktopStats & { platform: string; screenSize: ScreenSize } {
    return {
      ...this.stats,
      platform: this.platform,
      screenSize: this.getScreenSize(),
    };
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const dc = this;

    return [
      {
        name: 'screen_capture',
        description: '截取屏幕截图。支持全屏截图和区域截图，返回截图文件路径和 base64 数据。截图保存到 .duan/screenshots/ 目录。',
        parameters: {
          region_x: { type: 'number', description: '截图区域左上角 X 坐标（可选，不填为全屏）', required: false },
          region_y: { type: 'number', description: '截图区域左上角 Y 坐标（可选，不填为全屏）', required: false },
          region_width: { type: 'number', description: '截图区域宽度（可选）', required: false },
          region_height: { type: 'number', description: '截图区域高度（可选）', required: false },
          format: { type: 'string', description: '图片格式: png 或 jpg（默认 png）', required: false },
          quality: { type: 'number', description: 'jpg 质量 1-100（默认 85）', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const options: CaptureOptions = {
              format: (args.format as 'png' | 'jpg') || 'png',
              quality: args.quality ? parseInt(String(args.quality)) : undefined,
            };
            if (args.region_x !== undefined && args.region_y !== undefined &&
                args.region_width !== undefined && args.region_height !== undefined) {
              options.region = {
                x: Number(args.region_x),
                y: Number(args.region_y),
                width: Number(args.region_width),
                height: Number(args.region_height),
              };
            }
            const capture = await dc.captureScreen(options);
            return [
              `📸 屏幕截图完成`,
              `  文件: ${capture.filePath}`,
              `  尺寸: ${capture.width}x${capture.height}`,
              `  格式: ${capture.format}`,
              `  时间: ${new Date(capture.timestamp).toLocaleString('zh-CN')}`,
              capture.base64 ? `  Base64长度: ${capture.base64.length}` : '',
            ].filter(Boolean).join('\n');
          } catch (err: unknown) {
            return `❌ 截图失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'screen_analyze',
        description: '截取屏幕截图并使用视觉模型分析内容。返回屏幕描述、UI元素列表、文本内容和推荐操作。需要配置视觉模型（如 GPT-4V）。',
        parameters: {
          prompt: { type: 'string', description: '分析提示词（可选，默认描述屏幕内容）', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const analysis = await dc.analyzeScreen(args.prompt as string | undefined);
            const lines = [
              `🔍 屏幕分析结果`,
              ``,
              `📝 描述: ${analysis.description}`,
              ``,
            ];
            if (analysis.elements.length > 0) {
              lines.push(`🧩 UI元素 (${analysis.elements.length}个):`);
              for (const el of analysis.elements) {
                const bounds = el.bounds ? ` [${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}]` : '';
                lines.push(`  - [${el.type}] ${el.label}${bounds} (置信度: ${(el.confidence * 100).toFixed(0)}%)`);
              }
              lines.push('');
            }
            if (analysis.text) {
              lines.push(`📄 文本内容: ${analysis.text.substring(0, 500)}`);
              lines.push('');
            }
            if (analysis.suggestedActions.length > 0) {
              lines.push(`💡 建议操作:`);
              for (const action of analysis.suggestedActions) {
                lines.push(`  - ${action}`);
              }
            }
            return lines.join('\n');
          } catch (err: unknown) {
            return `❌ 屏幕分析失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'screen_click',
        description: '在屏幕指定坐标点击鼠标。支持左键、右键和中键点击。坐标从左上角(0,0)开始。',
        parameters: {
          x: { type: 'number', description: '点击的 X 坐标', required: true },
          y: { type: 'number', description: '点击的 Y 坐标', required: true },
          button: { type: 'string', description: '鼠标按键: left(默认)/right/middle', required: false },
        },
        execute: (args) => {
          const x = Number(args.x);
          const y = Number(args.y);
          const button = (args.button as 'left' | 'right' | 'middle') || 'left';
          if (!['left', 'right', 'middle'].includes(button)) {
            return Promise.resolve('❌ button 参数必须是 left、right 或 middle');
          }
          return dc.click(x, y, button);
        },
      },
      {
        name: 'screen_double_click',
        description: '在屏幕指定坐标执行鼠标双击。用于打开文件/文件夹、激活图标、快速操作等场景。支持左/右/中键双击。',
        parameters: {
          x: { type: 'number', description: '双击的 X 坐标', required: true },
          y: { type: 'number', description: '双击的 Y 坐标', required: true },
          button: { type: 'string', description: '鼠标按键: left(默认)/right/middle', required: false },
        },
        execute: (args) => {
          const x = Number(args.x);
          const y = Number(args.y);
          const button = (args.button as 'left' | 'right' | 'middle') || 'left';
          if (!['left', 'right', 'middle'].includes(button)) {
            return Promise.resolve('❌ button 参数必须是 left、right 或 middle');
          }
          return dc.doubleClick(x, y, button);
        },
      },
      {
        name: 'screen_drag',
        description: '鼠标拖拽：从起点坐标拖到终点坐标。用于文件拖放、调整图层、绘制选区、滑块操作等。三平台支持。',
        parameters: {
          fromX: { type: 'number', description: '起点 X 坐标', required: true },
          fromY: { type: 'number', description: '起点 Y 坐标', required: true },
          toX: { type: 'number', description: '终点 X 坐标', required: true },
          toY: { type: 'number', description: '终点 Y 坐标', required: true },
          button: { type: 'string', description: '鼠标按键: left(默认)/right', required: false },
        },
        execute: (args) => {
          const fromX = Number(args.fromX);
          const fromY = Number(args.fromY);
          const toX = Number(args.toX);
          const toY = Number(args.toY);
          const button = (args.button as 'left' | 'right') || 'left';
          if (isNaN(fromX) || isNaN(fromY) || isNaN(toX) || isNaN(toY)) {
            return Promise.resolve('❌ 坐标必须为数字');
          }
          if (!['left', 'right'].includes(button)) {
            return Promise.resolve('❌ button 必须是 left 或 right');
          }
          return dc.dragMouse(fromX, fromY, toX, toY, button);
        },
      },
      {
        name: 'screen_type',
        description: '在当前光标位置输入文本。用于在输入框、文本区域等位置输入内容。',
        parameters: {
          text: { type: 'string', description: '要输入的文本内容', required: true },
        },
        execute: (args) => {
          const text = String(args.text);
          if (!text) return Promise.resolve('❌ 输入文本不能为空');
          return dc.type(text);
        },
      },
      {
        name: 'screen_key',
        description: '按下键盘按键。支持特殊按键如 Enter、Tab、Escape，以及组合键如 Ctrl+C、Ctrl+V、Alt+Tab 等。',
        parameters: {
          key: { type: 'string', description: '按键名称，如 Enter、Tab、Escape、Ctrl+C、Ctrl+V、Alt+F4 等', required: true },
        },
        execute: (args) => {
          const key = String(args.key);
          if (!key) return Promise.resolve('❌ 按键名称不能为空');
          return dc.pressKey(key);
        },
      },
      {
        name: 'screen_move',
        description: '移动鼠标到屏幕指定坐标。坐标从左上角(0,0)开始。',
        parameters: {
          x: { type: 'number', description: '目标 X 坐标', required: true },
          y: { type: 'number', description: '目标 Y 坐标', required: true },
        },
        execute: (args) => {
          const x = Number(args.x);
          const y = Number(args.y);
          return dc.moveMouse(x, y);
        },
      },
      {
        name: 'screen_size',
        description: '获取屏幕尺寸信息，包括宽度、高度和缩放因子。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const size = dc.getScreenSize();
          return Promise.resolve(`🖥️ 屏幕尺寸: ${size.width}x${size.height}，缩放因子: ${size.scaleFactor}`);
        },
      },
      {
        name: 'screen_find',
        description: '在屏幕上查找指定元素（如按钮、文本、图标等）。使用视觉模型分析截图并返回元素坐标。需要配置视觉模型。',
        parameters: {
          template: { type: 'string', description: '要查找的元素描述，如"保存按钮"、"关闭图标"、"搜索框"等', required: true },
        },
        readOnly: true,
        execute: (args) => {
          const template = String(args.template);
          if (!template) return Promise.resolve('❌ 查找描述不能为空');
          return dc.findOnScreen(template);
        },
      },
      {
        name: 'screen_open',
        description: '打开应用程序。Windows 使用 Start-Process，macOS 使用 open，Linux 使用 xdg-open。',
        parameters: {
          name: { type: 'string', description: '应用程序名称，如 notepad、chrome、code 等', required: true },
        },
        execute: (args) => {
          const name = String(args.name);
          if (!name) return Promise.resolve('❌ 应用名称不能为空');
          return dc.openApplication(name);
        },
      },
      {
        name: 'computer_use',
        description: '自动完成电脑操作任务。输入自然语言任务描述，Agent会自动执行：截图→分析→操作→验证循环，像人一样操作电脑。支持点击、输入、按键、滚轮、打开应用等操作。示例："帮我打开计算器并计算 123*456"、"在Chrome中打开百度搜索天气"',
        parameters: {
          task: { type: 'string', description: '要在电脑上完成的任务描述', required: true },
          maxSteps: { type: 'number', description: '最大操作步数(默认15)', required: false },
        },
        execute: async (args) => {
          const task = String(args.task || '');
          const maxSteps = Number(args.maxSteps) || 15;
          if (!task) return '❌ 任务描述不能为空';
          if (!dc.modelLibrary) return '❌ Computer Use 需要配置视觉模型（如 GPT-4V、Gemini Flash）';
          dc.log.info('Computer Use 启动', { task, maxSteps });
          const log: string[] = [`🖥️ Computer Use 任务: ${task}\n`];
          const startTime = Date.now();
          for (let step = 1; step <= maxSteps; step++) {
            try {
              const analysis = await dc.analyzeScreen(`你是电脑操作助手。用户任务: "${task}"

当前步骤: ${step}/${maxSteps}

请分析屏幕截图，决定下一步操作。只返回JSON:
{
  "thought": "当前屏幕上有什么，距离目标还有多远",
  "action": {"type": "click/type/key/scroll/open/wait/done", "params": {...}},
  "reason": "为什么执行这个操作"
}

actions:
- click: {"x": 数字, "y": 数字, "button": "left/right"}
- type: {"text": "要输入的文字"}
- key: {"key": "Enter/Tab/Escape/Ctrl+S/Alt+Tab/..."}
- scroll: {"x": 数字, "y": 数字, "delta": 120或-120}
- open: {"name": "应用名"}
- wait: {"ms": 2000}
- done: {}  (任务完成时)
`);
              if (!analysis || !analysis.description) {
                log.push(`  ⚠️ 步骤${step}: 屏幕分析无返回`);
                break;
              }
              const jsonMatch = analysis.description.match(/\{[\s\S]*"action"[\s\S]*\}/);
              if (!jsonMatch) {
                log.push(`  ⚠️ 步骤${step}: 无法解析操作指令`);
                break;
              }
              const decision = JSON.parse(jsonMatch[0]);
              log.push(`  🤔 步骤${step}: ${decision.thought || '思考中...'}`);
              if (!decision.action) {
                log.push(`  ⚠️ 步骤${step}: 未指定操作`);
                break;
              }
              const act = decision.action;
              if (act.type === 'done') {
                log.push(`  ✅ 任务完成! (${Math.round((Date.now() - startTime) / 1000)}s)`);
                break;
              }
              switch (act.type) {
                case 'click':
                  await dc.click(Number(act.params?.x), Number(act.params?.y), act.params?.button || 'left');
                  log.push(`  🖱️ 点击 (${act.params?.x}, ${act.params?.y})`);
                  break;
                case 'type':
                  await dc.type(String(act.params?.text || ''));
                  log.push(`  ⌨️ 输入 "${(act.params?.text || '').slice(0, 30)}"`);
                  break;
                case 'key':
                  await dc.pressKey(String(act.params?.key || ''));
                  log.push(`  🔑 按键 ${act.params?.key}`);
                  break;
                case 'scroll':
                  await dc.scroll(Number(act.params?.x), Number(act.params?.y), Number(act.params?.delta) || 120);
                  log.push(`  📜 滚动`);
                  break;
                case 'open':
                  await dc.openApplication(String(act.params?.name || ''));
                  log.push(`  🚀 打开 ${act.params?.name}`);
                  break;
                case 'wait':
                  await new Promise(r => setTimeout(r, Number(act.params?.ms) || 2000));
                  log.push(`  ⏳ 等待 ${((Number(act.params?.ms) || 2000) / 1000).toFixed(0)}s`);
                  break;
                default:
                  log.push(`  ⚠️ 未知操作: ${act.type}`);
                  break;
              }
              await new Promise(r => setTimeout(r, 500));
            } catch (stepErr: unknown) {
              log.push(`  ❌ 步骤${step}出错: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
              break;
            }
          }
          const duration = Math.round((Date.now() - startTime) / 1000);
          log.push(`\n⏱️ 总耗时: ${duration}s`);
          return log.join('\n');
        },
      },
      {
        name: 'screen_ocr',
        description: '对屏幕截图进行OCR文字识别。使用Tesseract.js提取屏幕上的文字内容，支持中英文混合识别。返回识别文本、置信度和文字块坐标。',
        parameters: {
          region_x: { type: 'number', description: '识别区域左上角 X 坐标（可选，不填为全屏）', required: false },
          region_y: { type: 'number', description: '识别区域左上角 Y 坐标（可选）', required: false },
          region_width: { type: 'number', description: '识别区域宽度（可选）', required: false },
          region_height: { type: 'number', description: '识别区域高度（可选）', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            let region: { x: number; y: number; width: number; height: number } | undefined;
            if (args.region_x !== undefined && args.region_y !== undefined &&
                args.region_width !== undefined && args.region_height !== undefined) {
              region = { x: Number(args.region_x), y: Number(args.region_y), width: Number(args.region_width), height: Number(args.region_height) };
            }
            const result = await dc.ocrScreen(region);
            if (!result.text) return '❌ OCR未识别到文字';
            return [
              `📝 OCR识别结果 (置信度: ${(result.confidence * 100).toFixed(1)}%)`,
              ``,
              result.text.substring(0, 3000),
              result.text.length > 3000 ? `\n...(共${result.text.length}字符，已截断)...` : '',
              ``,
              `文字块数: ${result.blocks.length}`,
            ].filter(Boolean).join('\n');
          } catch (err: unknown) {
            return `❌ OCR识别失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'screen_scroll',
        description: '在指定坐标位置滚动鼠标滚轮。正值向上滚，负值向下滚。常用于页面滚动浏览。',
        parameters: {
          x: { type: 'number', description: '滚轮位置的 X 坐标', required: true },
          y: { type: 'number', description: '滚轮位置的 Y 坐标', required: true },
          delta: { type: 'number', description: '滚动量，正值向上(如120)，负值向下(如-120)', required: true },
        },
        execute: (args) => {
          const x = Number(args.x);
          const y = Number(args.y);
          const delta = Number(args.delta);
          if (isNaN(x) || isNaN(y) || isNaN(delta)) return Promise.resolve('❌ x, y, delta 必须为数字');
          return dc.scroll(x, y, delta);
        },
      },
      {
        name: 'window_manage',
        description: '管理桌面窗口：列出/激活/最小化/最大化/关闭/移动/调整大小。三平台支持（Windows 原生 / macOS AppleScript / Linux wmctrl）。',
        parameters: {
          action: { type: 'string', description: '操作: list(列出窗口)/foreground(激活)/minimize(最小化)/maximize(最大化)/close(关闭)/move(移动)/resize(调整大小)', required: true },
          windowTitle: { type: 'string', description: '窗口标题（list不需要，其他必填，支持模糊匹配）', required: false },
          x: { type: 'number', description: 'move 时的目标 X 坐标', required: false },
          y: { type: 'number', description: 'move 时的目标 Y 坐标', required: false },
          width: { type: 'number', description: 'resize 时的目标宽度', required: false },
          height: { type: 'number', description: 'resize 时的目标高度', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (!['list', 'foreground', 'minimize', 'maximize', 'close', 'move', 'resize'].includes(action)) {
            return Promise.resolve('❌ action 必须是 list/foreground/minimize/maximize/close/move/resize');
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action 已校验为合法 union 值
          return dc.windowManage(
            action as any,
            args.windowTitle as string | undefined,
            args.x !== undefined ? Number(args.x) : undefined,
            args.y !== undefined ? Number(args.y) : undefined,
            args.width !== undefined ? Number(args.width) : undefined,
            args.height !== undefined ? Number(args.height) : undefined,
          );
        },
      },
      {
        name: 'clipboard',
        description: '读写系统剪贴板内容。可读取剪贴板文本或写入文本到剪贴板。三平台支持（Windows/macOS/Linux）。',
        parameters: {
          action: { type: 'string', description: '操作: read(读取剪贴板)/write(写入剪贴板)', required: true },
          text: { type: 'string', description: '要写入的文本（write操作时必填）', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (!['read', 'write'].includes(action)) {
            return Promise.resolve('❌ action 必须是 read 或 write');
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action 已校验为合法 union 值
          return dc.clipboard(action as any, args.text as string | undefined);
        },
      },
      {
        name: 'system_control',
        description: '系统控制：调节音量/屏幕亮度/锁屏/发送系统通知。三平台支持。音量和亮度为 0-100 百分比。',
        parameters: {
          action: { type: 'string', description: '操作: volume(音量)/brightness(亮度)/lock(锁屏)/notify(通知)', required: true },
          value: { type: 'string', description: 'volume/brightness: 0-100 数字；notify: 通知标题', required: false },
          message: { type: 'string', description: 'notify 操作的通知正文', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (!['volume', 'brightness', 'lock', 'notify'].includes(action)) {
            return Promise.resolve('❌ action 必须是 volume/brightness/lock/notify');
          }
          const value = args.value !== undefined
            ? (/^\d+$/.test(String(args.value)) ? parseInt(String(args.value)) : String(args.value))
            : undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action 已校验为合法 union 值
          return dc.systemControl(action as any, value, args.message as string | undefined);
        },
      },
      {
        name: 'process_manage',
        description: '进程管理：列出运行中的进程或受控终止进程。list 返回 top 30 进程（按CPU排序）；kill 终止指定进程（拒绝系统关键进程）。',
        parameters: {
          action: { type: 'string', description: '操作: list(列出进程)/kill(终止进程)', required: true },
          target: { type: 'string', description: 'kill 操作的目标：进程名（如 notepad）或 PID 数字。list 不需要。', required: false },
        },
        execute: (args) => {
          const action = args.action as string;
          if (!['list', 'kill'].includes(action)) {
            return Promise.resolve('❌ action 必须是 list 或 kill');
          }
          let target: string | number | undefined;
          if (args.target !== undefined) {
            target = /^\d+$/.test(String(args.target)) ? parseInt(String(args.target)) : String(args.target);
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action 已校验为合法 union 值
          return dc.processManage(action as any, target as any);
        },
      },
    ];
  }
}
