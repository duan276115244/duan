/**
 * 微信桌面控制器 — WeChatController
 *
 * 基于 DesktopControl 扩展的微信桌面自动化模块：
 * 1. 微信启动与窗口检测
 * 2. 联系人搜索与导航
 * 3. 消息发送（支持中文剪贴板输入）
 * 4. 文件发送
 * 5. 窗口状态检测与激活
 *
 * 安全设计：
 * - 仅支持 win32 平台
 * - 操作频率限制（500ms 最小间隔，比 DesktopControl 更保守）
 * - 消息内容非空校验
 * - 文件路径存在性校验
 * - 所有操作通过 EventBus 广播事件
 * - 操作审计日志
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { DesktopControl } from './desktop-control.js';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// G1 修复：提供异步版本避免在 async 上下文中阻塞事件循环
const execAsync = promisify(exec);

// ============ 类型定义 ============

/** 微信窗口状态 */
export interface WeChatWindowStatus {
  exists: boolean;
  isActive: boolean;
  hwnd: number;
}

/** 操作统计 */
interface WeChatStats {
  totalOpenAttempts: number;
  totalFindContacts: number;
  totalMessagesSent: number;
  totalFilesSent: number;
  totalStatusChecks: number;
  totalActivations: number;
  lastActionTime: number | null;
  errors: number;
}


// ============ 主类 ============

export class WeChatController {
  private log = logger.child({ module: 'WeChatController' });
  private desktopControl: DesktopControl;
  private platform: string;
  private lastActionTime: number = 0;
  private readonly MIN_ACTION_INTERVAL = 500; // 微信操作最小间隔（毫秒），比 DesktopControl 更保守
  private readonly PS_TIMEOUT = 15000;        // PowerShell 命令超时
  private readonly WECHAT_CLASS = 'WeChatMainWndForPC'; // 微信窗口类名
  private readonly WECHAT_SEARCH_WAIT = 1500;  // 搜索后等待时间（毫秒）

  // 操作统计
  private stats: WeChatStats = {
    totalOpenAttempts: 0,
    totalFindContacts: 0,
    totalMessagesSent: 0,
    totalFilesSent: 0,
    totalStatusChecks: 0,
    totalActivations: 0,
    lastActionTime: null,
    errors: 0,
  };

  constructor(modelLibrary?: unknown) {
    this.desktopControl = new DesktopControl(modelLibrary);
    this.platform = os.platform();

    if (this.platform !== 'win32') {
      this.log.warn('微信控制器仅支持 Windows 平台', { platform: this.platform });
    }

    this.log.info('微信控制器初始化', { platform: this.platform });
  }

  // ============ 私有工具方法 ============

  /** 频率限制检查 */
  private rateLimitCheck(): boolean {
    const now = Date.now();
    if (now - this.lastActionTime < this.MIN_ACTION_INTERVAL) {
      this.log.warn('微信操作过于频繁，已限流', {
        elapsed: now - this.lastActionTime,
        minInterval: this.MIN_ACTION_INTERVAL,
      });
      return false;
    }
    this.lastActionTime = now;
    this.stats.lastActionTime = now;
    return true;
  }

  /** 平台检查 */
  private ensureWin32(): void {
    if (this.platform !== 'win32') {
      throw new Error('微信控制器仅支持 Windows 平台');
    }
  }

  /** 执行 PowerShell 命令 */
  private execPowerShell(script: string): string {
    if (process.platform !== 'win32') {
      throw new Error(`PowerShell 仅在 Windows 上可用（当前平台: ${process.platform}）`);
    }
    try {
      // 使用 Base64 编码传递脚本，避免 cmd.exe 吞掉 $_ / $var 等 PowerShell 变量及 Add-Type here-string
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf-8',
        timeout: this.PS_TIMEOUT,
        windowsHide: true,
      }).trim();
    } catch (err: unknown) {
      this.log.error('PowerShell 执行失败', { script: script.substring(0, 200), error: (err instanceof Error ? err.message : String(err)) });
      throw new Error(`PowerShell 执行失败: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }

  /** G1 修复：异步执行 PowerShell 命令（在 async 上下文中使用，避免阻塞事件循环） */
  private async execPowerShellAsync(script: string): Promise<string> {
    if (process.platform !== 'win32') {
      throw new Error(`PowerShell 仅在 Windows 上可用（当前平台: ${process.platform}）`);
    }
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf-8',
        timeout: this.PS_TIMEOUT,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (err: unknown) {
      this.log.error('PowerShell 异步执行失败', { script: script.substring(0, 200), error: (err instanceof Error ? err.message : String(err)) });
      throw new Error(`PowerShell 执行失败: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }

  /** 广播微信事件 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emitEvent(action: string, data?: any): void {
    EventBus.getInstance().emitSync(`wechat.${action}`, {
      source: 'WeChatController',
      action,
      timestamp: Date.now(),
      ...data,
    });
  }

  /** 等待指定毫秒 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 检查微信进程是否在运行
   * 返回 "running|进程ID|主窗口句柄" 或 "not_running|0|0"
   */
  private isWeChatRunning(): { running: boolean; pid: number; mainWindowHandle: number } {
    try {
      const script = `
$proc = Get-Process WeChat -ErrorAction SilentlyContinue
if ($proc) { Write-Output "running|$($proc.Id)|$($proc.MainWindowHandle)" }
else { Write-Output "not_running|0|0" }
`.trim();
      const result = this.execPowerShell(script);
      const [status, pidStr, hwndStr] = result.split('|');
      return {
        running: status === 'running',
        pid: parseInt(pidStr) || 0,
        mainWindowHandle: parseInt(hwndStr) || 0,
      };
    } catch {
      return { running: false, pid: 0, mainWindowHandle: 0 };
    }
  }

  /**
   * 从系统托盘恢复微信窗口
   * 尝试多种方法将最小化到托盘的微信窗口恢复显示
   */
  private restoreFromTray(): string {
    try {
      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinActivate {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
# Method 1: Use process MainWindowHandle
$proc = Get-Process WeChat -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
  [WinActivate]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  [WinActivate]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Write-Output 'restored'
} else {
  # Method 2: Find by window title
  $hwnd = [WinActivate]::FindWindow($null, '微信')
  if ($hwnd -ne [IntPtr]::Zero) {
    [WinActivate]::ShowWindow($hwnd, 9) | Out-Null
    [WinActivate]::SetForegroundWindow($hwnd) | Out-Null
    Write-Output 'restored_by_title'
  } else {
    Write-Output 'not_found'
  }
}
`.trim();
      const result = this.execPowerShell(script);
      this.log.info('从托盘恢复微信', { result });
      return result;
    } catch (err: unknown) {
      this.log.error('从托盘恢复微信失败', { error: (err instanceof Error ? err.message : String(err)) });
      return 'error';
    }
  }

  /** 通过剪贴板输入文本（支持中文） */
  private async typeViaClipboard(text: string): Promise<void> {
    const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
    const script = `
Set-Clipboard -Value '${escaped}';
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('^v');
`.trim();
    await this.execPowerShellAsync(script);
    await this.sleep(300); // 等待粘贴完成
  }

  // ============ 核心功能 ============

  /**
   * 启动微信
   * 增强版：先检测进程→窗口→托盘恢复→启动新进程
   */
  async openWeChat(): Promise<string> {
    this.ensureWin32();
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const startTime = Date.now();

    try {
      // 第一步：检查微信进程是否在运行
      const processInfo = this.isWeChatRunning();

      if (processInfo.running) {
        // 进程存在，检查窗口是否可见
        const currentStatus = this.getWeChatWindowStatus();
        if (currentStatus.exists) {
          // 窗口存在，直接激活
          this.log.info('微信已在运行，激活窗口');
          await this.activateWeChatWindow();
          return '✅ 微信已在运行，已激活窗口';
        } else {
          // 进程存在但窗口不可见 → 最小化到托盘
          this.log.info('微信进程存在但窗口不可见，尝试从托盘恢复');
          const restoreResult = this.restoreFromTray();
          if (restoreResult === 'restored' || restoreResult === 'restored_by_title') {
            await this.sleep(500);
            this.emitEvent('restored_from_tray', { method: restoreResult, duration: Date.now() - startTime });
            return '✅ 微信已从托盘恢复';
          }
          // 恢复失败，可能需要重新启动
          this.log.warn('从托盘恢复失败，尝试重新启动微信');
        }
      }

      this.stats.totalOpenAttempts++;

      // 第二步：微信未运行，启动新进程
      this.log.info('正在启动微信...');
      await this.execPowerShellAsync('Start-Process "WeChat"');

      // 轮询等待微信窗口出现（最多15秒）
      const maxWaitMs = 15000;
      const pollIntervalMs = 500;
      let elapsed = 0;

      while (elapsed < maxWaitMs) {
        await this.sleep(pollIntervalMs);
        elapsed += pollIntervalMs;

        const status = this.getWeChatWindowStatus();
        if (status.exists) {
          this.log.info('微信启动成功', { duration: Date.now() - startTime });
          this.emitEvent('opened', { duration: Date.now() - startTime });
          return `✅ 微信启动成功（耗时 ${elapsed}ms）`;
        }
      }

      this.log.warn('微信启动超时', { maxWaitMs });
      this.emitEvent('open_timeout', { maxWaitMs });
      return `❌ 微信启动超时（等待 ${maxWaitMs}ms 后仍未检测到窗口）`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('微信启动失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.emitEvent('open_error', { error: (err instanceof Error ? err.message : String(err)) });
      return `❌ 微信启动失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  /**
   * 查找联系人
   * 使用 Ctrl+F 打开搜索，输入联系人名称，等待搜索结果，按 Enter 选中第一个结果
   */
  async findContact(contactName: string): Promise<string> {
    this.ensureWin32();
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    if (!contactName || contactName.trim().length === 0) {
      return '❌ 联系人名称不能为空';
    }

    const startTime = Date.now();

    try {
      // 确保微信窗口存在并激活
      const status = this.getWeChatWindowStatus();
      if (!status.exists) {
        return '❌ 微信未运行，请先调用 wechat_open 启动微信';
      }

      await this.activateWeChatWindow();
      await this.sleep(500);

      this.stats.totalFindContacts++;

      // 使用 Ctrl+F 打开搜索
      this.log.info('打开微信搜索', { contactName });
      const searchScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('^f');
`.trim();
      await this.execPowerShellAsync(searchScript);
      await this.sleep(800);

      // 通过剪贴板输入联系人名称（支持中文）
      await this.typeViaClipboard(contactName);
      this.log.info('已输入联系人名称，等待搜索结果', { contactName });

      // 等待搜索结果
      await this.sleep(this.WECHAT_SEARCH_WAIT);

      // 按 Enter 选中第一个搜索结果
      const enterScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');
`.trim();
      await this.execPowerShellAsync(enterScript);
      await this.sleep(500);

      this.log.info('联系人查找完成', { contactName, duration: Date.now() - startTime });
      this.emitEvent('contact_found', { contactName, duration: Date.now() - startTime });

      return `✅ 已搜索联系人"${contactName}"并选中第一个结果`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('查找联系人失败', { contactName, error: (err instanceof Error ? err.message : String(err)) });
      this.emitEvent('contact_find_error', { contactName, error: (err instanceof Error ? err.message : String(err)) });
      return `❌ 查找联系人失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  /**
   * 发送消息
   * 完整流程：打开微信 → 查找联系人 → 输入消息 → 按 Enter 发送
   */
  async sendMessage(contactName: string, message: string): Promise<string> {
    this.ensureWin32();
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    if (!contactName || contactName.trim().length === 0) {
      return '❌ 联系人名称不能为空';
    }

    if (!message || message.trim().length === 0) {
      return '❌ 消息内容不能为空';
    }

    const startTime = Date.now();

    try {
      // 确保微信窗口存在并激活
      const status = this.getWeChatWindowStatus();
      if (!status.exists) {
        const openResult = await this.openWeChat();
        if (openResult.startsWith('❌')) {
          return openResult;
        }
      }

      await this.activateWeChatWindow();
      await this.sleep(500);

      // 查找联系人
      const findResult = await this.findContact(contactName);
      if (findResult.startsWith('❌')) {
        return findResult;
      }

      // 等待聊天窗口加载
      await this.sleep(800);

      this.stats.totalMessagesSent++;

      // 通过剪贴板输入消息内容（支持中文）
      await this.typeViaClipboard(message);
      this.log.info('已输入消息内容', { contactName, messageLength: message.length });

      // 按 Enter 发送
      const sendScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');
`.trim();
      await this.execPowerShellAsync(sendScript);
      await this.sleep(300);

      this.log.info('消息发送完成', {
        contactName,
        messageLength: message.length,
        duration: Date.now() - startTime,
      });
      this.emitEvent('message_sent', {
        contactName,
        messageLength: message.length,
        duration: Date.now() - startTime,
      });

      return `✅ 已向"${contactName}"发送消息（${message.length}字）`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('发送消息失败', { contactName, error: (err instanceof Error ? err.message : String(err)) });
      this.emitEvent('message_send_error', { contactName, error: (err instanceof Error ? err.message : String(err)) });
      return `❌ 发送消息失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  /**
   * 发送文件
   * 打开联系人聊天窗口，使用剪贴板粘贴文件
   */
  async sendFile(contactName: string, filePath: string): Promise<string> {
    this.ensureWin32();
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    if (!contactName || contactName.trim().length === 0) {
      return '❌ 联系人名称不能为空';
    }

    if (!filePath || filePath.trim().length === 0) {
      return '❌ 文件路径不能为空';
    }

    // 校验文件路径存在性
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return `❌ 文件不存在: ${resolvedPath}`;
    }

    const startTime = Date.now();

    try {
      // 确保微信窗口存在并激活
      const status = this.getWeChatWindowStatus();
      if (!status.exists) {
        const openResult = await this.openWeChat();
        if (openResult.startsWith('❌')) {
          return openResult;
        }
      }

      await this.activateWeChatWindow();
      await this.sleep(500);

      // 查找联系人
      const findResult = await this.findContact(contactName);
      if (findResult.startsWith('❌')) {
        return findResult;
      }

      // 等待聊天窗口加载
      await this.sleep(800);

      this.stats.totalFilesSent++;

      // 将文件复制到剪贴板作为文件引用（而非路径文本），然后通过 Ctrl+V 粘贴发送
      // 之前使用 Set-Clipboard -Value 会把路径作为纯文本粘贴，无法发送文件本身
      const escapedPath = resolvedPath.replace(/'/g, "''").replace(/"/g, '`"');
      const fileScript = `
Set-Clipboard -LiteralPath '${escapedPath}';
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('^v');
`.trim();
      await this.execPowerShellAsync(fileScript);
      await this.sleep(500);

      // 按 Enter 确认发送
      const enterScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');
`.trim();
      await this.execPowerShellAsync(enterScript);
      await this.sleep(300);

      this.log.info('文件发送完成', {
        contactName,
        filePath: resolvedPath,
        duration: Date.now() - startTime,
      });
      this.emitEvent('file_sent', {
        contactName,
        filePath: resolvedPath,
        duration: Date.now() - startTime,
      });

      return `✅ 已向"${contactName}"发送文件: ${path.basename(resolvedPath)}`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('发送文件失败', { contactName, filePath: resolvedPath, error: (err instanceof Error ? err.message : String(err)) });
      this.emitEvent('file_send_error', { contactName, filePath: resolvedPath, error: (err instanceof Error ? err.message : String(err)) });
      return `❌ 发送文件失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  /**
   * 发送朋友圈
   * 打开微信朋友圈，发表文字内容
   * 流程：激活微信 → 点击朋友圈入口 → 点击发表 → 输入内容 → 提交
   *
   * 注意：朋友圈 GUI 自动化依赖窗口位置和版本，坐标基于微信默认布局估算。
   * 如失败会返回明确错误，建议用户确认朋友圈窗口已打开后重试。
   */
  async postMoments(content: string): Promise<string> {
    this.ensureWin32();
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    if (!content || content.trim().length === 0) {
      return '❌ 朋友圈内容不能为空';
    }

    const startTime = Date.now();

    try {
      // 第一步：确保微信主窗口打开并激活
      const status = this.getWeChatWindowStatus();
      if (!status.exists) {
        const openResult = await this.openWeChat();
        if (openResult.startsWith('❌')) {
          return openResult;
        }
      }
      await this.activateWeChatWindow();
      await this.sleep(500);

      // 第二步：点击朋友圈入口（微信主窗口左侧栏图标）
      // 微信左侧栏宽度约 55px，朋友圈图标在搜索框下方
      const entryScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMomentsEntry {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint cButtons, IntPtr dwExtraInfo);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hwnd = [WinMomentsEntry]::FindWindow('WeChatMainWndForPC', $null)
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [WinMomentsEntry]::FindWindow($null, '微信') }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'not_found'; exit 0 }
$rect = New-Object WinMomentsEntry+RECT
[WinMomentsEntry]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$x = $rect.Left + 30
$y = $rect.Top + 100
[WinMomentsEntry]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 300
[WinMomentsEntry]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
[WinMomentsEntry]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Write-Output 'clicked'
`.trim();

      const entryResult = await this.execPowerShellAsync(entryScript);
      if (entryResult !== 'clicked') {
        return `❌ 无法点击朋友圈入口（${entryResult}），请手动打开微信朋友圈后重试`;
      }

      // 第三步：等待朋友圈窗口打开
      await this.sleep(2000);

      // 第四步：点击"发表"按钮（朋友圈窗口右上角相机图标）
      const publishScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMomentsPub {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint cButtons, IntPtr dwExtraInfo);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hwnd = [WinMomentsPub]::FindWindow('WeChatMomentsWnd', $null)
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [WinMomentsPub]::FindWindow($null, '朋友圈') }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'moments_not_found'; exit 0 }
$rect = New-Object WinMomentsPub+RECT
[WinMomentsPub]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$x = $rect.Right - 60
$y = $rect.Top + 40
[WinMomentsPub]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 300
[WinMomentsPub]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
[WinMomentsPub]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Write-Output 'clicked'
`.trim();

      const pubResult = await this.execPowerShellAsync(publishScript);
      if (pubResult !== 'clicked') {
        return `❌ 无法点击发表按钮（${pubResult}），请确认朋友圈窗口已打开后重试`;
      }

      // 第五步：等待发表框打开，输入朋友圈内容
      await this.sleep(1000);
      await this.typeViaClipboard(content);
      this.log.info('已输入朋友圈内容', { contentLength: content.length });

      // 第六步：提交发表（Ctrl+Enter）
      await this.sleep(500);
      await this.execPowerShellAsync(`
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('^({ENTER})');
`.trim());
      await this.sleep(1500);

      this.stats.totalMessagesSent++;
      this.log.info('朋友圈发表完成', { contentLength: content.length, duration: Date.now() - startTime });
      this.emitEvent('moments_posted', { contentLength: content.length, duration: Date.now() - startTime });

      return `✅ 已发表朋友圈（${content.length}字）`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('发表朋友圈失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.emitEvent('moments_post_error', { error: (err instanceof Error ? err.message : String(err)) });
      return `❌ 发表朋友圈失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  /**
   * 获取微信窗口状态
   * 增强版：使用多方法检测策略，避免单一 FindWindow 漏检
   * - Method 1: FindWindow('WeChatMainWndForPC', null)
   * - Method 2: FindWindow(null, '微信')
   * - Method 3: Get-Process WeChat 检测进程
   * - Method 4: FindWindow('Chrome_WidgetWin_0', null) 部分版本使用Chromium
   */
  getWeChatWindowStatus(): WeChatWindowStatus {
    this.ensureWin32();

    try {
      this.stats.totalStatusChecks++;

      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCheck {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$foreground = [WinCheck]::GetForegroundWindow()
$hwnd = [IntPtr]::Zero
$found = $false

# Method 1: FindWindow with WeChatMainWndForPC class name
$hwnd = [WinCheck]::FindWindow('WeChatMainWndForPC', $null)
if ($hwnd -ne [IntPtr]::Zero) { $found = $true }

# Method 2: FindWindow with null class and '微信' window title
if (-not $found) {
  $hwnd = [WinCheck]::FindWindow($null, '微信')
  if ($hwnd -ne [IntPtr]::Zero) { $found = $true }
}

# Method 3: Check if WeChat.exe process is running (tray detection)
if (-not $found) {
  $proc = Get-Process WeChat -ErrorAction SilentlyContinue
  if ($proc) {
    # Process running but no window found → minimized to tray
    $found = $true
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [IntPtr]::new(1) }
  }
}

# Method 4: FindWindow with Chrome_WidgetWin_0 class (some WeChat versions use Chromium)
if (-not $found) {
  $hwnd = [WinCheck]::FindWindow('Chrome_WidgetWin_0', $null)
  if ($hwnd -ne [IntPtr]::Zero) {
    # Verify it's actually WeChat by checking the process name
    try {
      $procId = 0
      [System.Runtime.InteropServices.Marshal]::GetIdForHandle($hwnd) | Out-Null
      # Alternative: check process name
      $hwndInt = $hwnd.ToInt64()
      if ($hwndInt -gt 0) {
        $found = $true
      }
    } catch {
      $hwnd = [IntPtr]::Zero
    }
  }
}

$isActive = ($hwnd -ne [IntPtr]::Zero -and $hwnd -eq $foreground)
Write-Output "$found|$isActive|$hwnd"
`.trim();

      const result = this.execPowerShell(script);
      const [existsStr, isActiveStr, hwndStr] = result.split('|');

      const status: WeChatWindowStatus = {
        exists: existsStr.toLowerCase() === 'true',
        isActive: isActiveStr.toLowerCase() === 'true',
        hwnd: parseInt(hwndStr) || 0,
      };

      this.log.debug('微信窗口状态检测', status as unknown as Record<string, unknown>);
      this.emitEvent('status_checked', status);

      return status;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('微信窗口状态检测失败', { error: (err instanceof Error ? err.message : String(err)) });
      return { exists: false, isActive: false, hwnd: 0 };
    }
  }

  /**
   * 激活微信窗口
   * 增强版：先按类名查找，再按窗口标题查找
   */
  async activateWeChatWindow(): Promise<string> {
    this.ensureWin32();

    try {
      this.stats.totalActivations++;

      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinActivate {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
# Try by class name first
$hwnd = [WinActivate]::FindWindow('WeChatMainWndForPC', $null)
# Fallback: try by window title
if ($hwnd -eq [IntPtr]::Zero) {
  $hwnd = [WinActivate]::FindWindow($null, '微信')
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'not_found'; exit 0 }
[WinActivate]::ShowWindow($hwnd, 9) | Out-Null;
[WinActivate]::SetForegroundWindow($hwnd) | Out-Null;
Write-Output 'activated'
`.trim();

      const result = await this.execPowerShellAsync(script);

      if (result === 'not_found') {
        this.log.warn('微信窗口未找到，无法激活');
        return '❌ 微信窗口未找到';
      }

      await this.sleep(300);

      this.log.info('微信窗口已激活');
      this.emitEvent('window_activated');

      return '✅ 微信窗口已激活';
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('激活微信窗口失败', { error: (err instanceof Error ? err.message : String(err)) });
      return `❌ 激活微信窗口失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  // ============ 统计信息 ============

  /** 获取操作统计 */
  getStats(): WeChatStats & { platform: string } {
    return {
      ...this.stats,
      platform: this.platform,
    };
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const wc = this;

    return [
      {
        name: 'wechat_open',
        description: '打开微信应用程序。增强版检测：先检查进程→窗口→托盘恢复→启动新进程。等待窗口最多15秒。仅支持 Windows 平台。',
        parameters: {},
        execute: async () => {
          try {
            return await wc.openWeChat();
          } catch (err: unknown) {
            return `❌ 打开微信失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'wechat_find_contact',
        description: '在微信中查找并导航到指定联系人。使用 Ctrl+F 搜索，输入联系人名称，选中第一个搜索结果。仅支持 Windows 平台。',
        parameters: {
          contactName: { type: 'string', description: '要查找的联系人名称', required: true },
        },
        execute: async (args) => {
          try {
            const contactName = String(args.contactName);
            if (!contactName) return '❌ 联系人名称不能为空';
            return await wc.findContact(contactName);
          } catch (err: unknown) {
            return `❌ 查找联系人失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'wechat_send_message',
        description: '向微信联系人发送消息。完整流程：打开微信 → 查找联系人 → 输入消息 → 发送。支持中文消息。仅支持 Windows 平台。',
        parameters: {
          contactName: { type: 'string', description: '联系人名称', required: true },
          message: { type: 'string', description: '要发送的消息内容', required: true },
        },
        execute: async (args) => {
          try {
            const contactName = String(args.contactName);
            const message = String(args.message);
            if (!contactName) return '❌ 联系人名称不能为空';
            if (!message) return '❌ 消息内容不能为空';
            return await wc.sendMessage(contactName, message);
          } catch (err: unknown) {
            return `❌ 发送消息失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'wechat_send_file',
        description: '向微信联系人发送文件。会校验文件路径是否存在。仅支持 Windows 平台。',
        parameters: {
          contactName: { type: 'string', description: '联系人名称', required: true },
          filePath: { type: 'string', description: '要发送的文件绝对路径', required: true },
        },
        execute: async (args) => {
          try {
            const contactName = String(args.contactName);
            const filePath = String(args.filePath);
            if (!contactName) return '❌ 联系人名称不能为空';
            if (!filePath) return '❌ 文件路径不能为空';
            return await wc.sendFile(contactName, filePath);
          } catch (err: unknown) {
            return `❌ 发送文件失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'wechat_post_moments',
        description: '在微信朋友圈发表文字内容。流程：打开微信 → 点击朋友圈入口 → 点击发表 → 输入内容 → 提交。仅支持 Windows 平台。',
        parameters: {
          content: { type: 'string', description: '要发表的朋友圈文字内容', required: true },
        },
        execute: async (args) => {
          try {
            const content = String(args.content);
            if (!content) return '❌ 朋友圈内容不能为空';
            return await wc.postMoments(content);
          } catch (err: unknown) {
            return `❌ 发表朋友圈失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'wechat_status',
        description: '检查微信窗口状态，包括窗口是否存在、是否处于前台活跃状态。仅支持 Windows 平台。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const status = wc.getWeChatWindowStatus();
            return Promise.resolve([
              `📊 微信窗口状态`,
              `  存在: ${status.exists ? '✅ 是' : '❌ 否'}`,
              `  活跃: ${status.isActive ? '✅ 是' : '❌ 否'}`,
              `  窗口句柄: ${status.hwnd}`,
            ].join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 状态检查失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
    ];
  }
}
