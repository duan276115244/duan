/**
 * 终极办公工具集 — OfficeToolsUltimate
 *
 * 第四批办公场景工具，围绕"电脑操作 + 办公能力"全方位提升：
 *
 * A. 电脑操作类（6个）—— 让 Agent 能像人一样操控电脑：
 * 1. system_info     - 系统信息查询（CPU/内存/磁盘/网络/电池/系统版本/启动时间）
 * 2. process_manage  - 进程管理（列出/查找/结束/优先级调整）
 * 3. window_layout   - 窗口布局管理（分屏/层叠/最小化全部/虚拟桌面切换）
 * 4. clipboard_history - 剪贴板历史（监听/查看/搜索/清空，持久化存储）
 * 5. quick_launch    - 快速启动器（应用/网址/文件别名管理，支持快捷打开）
 * 6. system_settings - 系统设置（壁纸/电源模式/默认应用/通知免打扰/休眠）
 *
 * B. 办公能力类（6个）—— 深度办公场景：
 * 7. calendar_manage   - 日历管理（创建/查看/提醒/冲突检测）
 * 8. email_batch       - 邮件批处理（批量草稿/群发单显/分类规则）
 * 9. pdf_advanced      - PDF 高级操作（合并/加密/旋转/提取页面/元信息）
 * 10. note_manage      - 笔记/知识管理（Markdown 笔记 + 标签 + 双链 + 全文搜索）
 * 11. kanban_board     - 看板管理（Kanban 列/卡片/泳道/拖拽状态）
 * 12. automation_workflow - 工作流自动化（定时任务/触发器/动作链编排）
 *
 * 设计原则：
 * - 跨平台优先：Windows 用 PowerShell，macOS/Linux 用对应命令，纯 Node API 兜底
 * - 数据持久化到 ~/.duan/ 下相应子目录
 * - 所有文件操作走 fs.promises 异步；子进程用 promisify(exec)
 * - 敏感路径防护 + 输入校验
 * - 外部库（pdf-lib）动态加载，缺失时给出降级提示
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { matchSensitivePath } from '../../core/security-config.js';
import { toolContext } from './tool-context.js';
import { atomicWriteJson } from '../../core/atomic-write.js';

const execAsync = promisify(exec);
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PLATFORM_NAME = ({ win32: 'Windows', darwin: 'macOS' } as Record<string, string>)[process.platform] || 'Linux';

// ============ 辅助函数 ============

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

function guardSensitivePath(p: string): string | null {
  if (matchSensitivePath(p)) return `❌ 拒绝访问敏感路径: ${p}`;
  return null;
}

/** 获取 ~/.duan 下的子目录路径，不存在则创建 */
async function ensureDataDir(sub: string): Promise<string> {
  const dir = path.join(os.homedir(), '.duan', sub);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/** 读取 JSON 文件，不存在或损坏返回 fallback */
async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写入 JSON 文件（格式化） */
async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, data);
}

async function callLLM(prompt: string, systemPrompt?: string): Promise<string> {
  const ml = toolContext.modelLibrary;
  if (!ml || typeof ml.call !== 'function') throw new Error('ModelLibrary 未初始化');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  const resp = await ml.call(messages);
  return resp.content || '';
}

/** Windows 下执行 PowerShell（用 -EncodedCommand 避免 CLIXML/变量被 cmd.exe 破坏） */
async function execPowerShell(script: string, timeoutMs = 15000): Promise<string> {
  if (!IS_WIN) throw new Error('PowerShell 仅在 Windows 可用');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

/** 字节大小人类可读化 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 秒数人类可读化 */
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  parts.push(`${m}分钟`);
  return parts.join(' ');
}

// ============ 工具定义 ============

export const officeToolsUltimate: UnifiedToolDef[] = [

  // ============================================================
  // A1. 系统信息查询
  // ============================================================
  {
    name: 'system_info',
    description: '查询系统信息。包括操作系统/CPU/内存/磁盘/网络/电池/启动时间。支持 overview/cpu/memory/disk/network/battery/all 七种视图。',
    readOnly: true,
    parameters: {
      type: { type: 'string', description: '查询类型: overview/cpu/memory/disk/network/battery/all，默认 overview', required: false },
    },
    execute: async (args) => {
      const type = (args.type as string) || 'overview';
      try {
        if (type === 'overview' || type === 'all') {
          const cpus = os.cpus();
          const totalMem = os.totalmem();
          const freeMem = os.freemem();
          const usedMem = totalMem - freeMem;
          const memUsage = ((usedMem / totalMem) * 100).toFixed(1);
          let report = `🖥️ **系统概览**\n${'─'.repeat(50)}\n`;
          report += `   主机名: ${os.hostname()}\n`;
          report += `   平台: ${os.platform()} ${os.arch()} (release ${os.release()})\n`;
          report += `   系统: ${PLATFORM_NAME}\n`;
          report += `   CPU: ${cpus.length} 核 | ${cpus[0]?.model || '未知'}\n`;
          report += `   内存: ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (${memUsage}%)\n`;
          report += `   运行时长: ${fmtUptime(os.uptime())}\n`;
          report += `   Node: ${process.version} | 用户: ${os.userInfo().username}\n`;
          if (type === 'overview') return report;
          // all 模式继续追加
        }

        if (type === 'cpu' || type === 'all') {
          const cpus = os.cpus();
          const avgLoad = os.loadavg();
          let report = type === 'cpu' ? `🧠 **CPU 信息**\n${'─'.repeat(50)}\n` : '\n🧠 **CPU**\n';
          report += `   型号: ${cpus[0]?.model || '未知'}\n`;
          report += `   核心数: ${cpus.length}\n`;
          report += `   速度: ${cpus[0]?.speed || 'N/A'} MHz\n`;
          if (cpus[0]?.times) {
            const t = cpus[0].times;
            const total = t.user + t.nice + t.sys + t.idle + t.irq;
            const idlePct = ((t.idle / total) * 100).toFixed(1);
            report += `   空闲率: ${idlePct}%\n`;
          }
          if (!IS_WIN) report += `   负载(1/5/15min): ${avgLoad.map(l => l.toFixed(2)).join(' / ')}\n`;
          if (type === 'cpu') return report;
        }

        if (type === 'memory' || type === 'all') {
          const totalMem = os.totalmem();
          const freeMem = os.freemem();
          const usedMem = totalMem - freeMem;
          let report = type === 'memory' ? `💾 **内存信息**\n${'─'.repeat(50)}\n` : '\n💾 **内存**\n';
          report += `   总内存: ${fmtBytes(totalMem)}\n`;
          report += `   已用: ${fmtBytes(usedMem)} (${((usedMem / totalMem) * 100).toFixed(1)}%)\n`;
          report += `   可用: ${fmtBytes(freeMem)} (${((freeMem / totalMem) * 100).toFixed(1)}%)\n`;
          if (type === 'memory') return report;
        }

        if (type === 'disk' || type === 'all') {
          let report = type === 'disk' ? `💿 **磁盘信息**\n${'─'.repeat(50)}\n` : '\n💿 **磁盘**\n';
          try {
            if (IS_WIN) {
              const ps = `Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{N='Used(GB)';E={[math]::Round($_.Used/1GB,2)}},@{N='Free(GB)';E={[math]::Round($_.Free/1GB,2)}} | ConvertTo-Csv -NoTypeInformation`;
              const out = await execPowerShell(ps, 10000);
              report += out.split('\n').filter(l => l.trim() && !l.startsWith('"Name"')).map(l => {
                const parts = l.split(',').map(s => s.replace(/"/g, ''));
                if (parts.length >= 3) return `   ${parts[0]}: 已用 ${parts[1]}GB | 可用 ${parts[2]}GB`;
                return `   ${l}`;
              }).join('\n');
            } else {
              const { stdout } = await execAsync('df -h 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
              const lines = stdout.split('\n').slice(0, 10).filter(Boolean);
              report += lines.map(l => '   ' + l).join('\n');
            }
          } catch (err) {
            report += `   ⚠️ 磁盘信息获取失败: ${errMsg(err)}`;
          }
          if (type === 'disk') return report;
        }

        if (type === 'network' || type === 'all') {
          let report = type === 'network' ? `🌐 **网络信息**\n${'─'.repeat(50)}\n` : '\n🌐 **网络**\n';
          const nets = os.networkInterfaces();
          for (const [name, addrs] of Object.entries(nets)) {
            if (!addrs) continue;
            const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
            if (ipv4) report += `   ${name}: ${ipv4.address}\n`;
          }
          try {
            const { stdout } = await execAsync(
              IS_WIN ? 'ipconfig /all' : 'ifconfig 2>/dev/null || ip addr 2>/dev/null',
              { encoding: 'utf-8', timeout: 5000 }
            );
            const lines = stdout.split('\n').slice(0, 5).filter(Boolean);
            if (lines.length) report += `   网关/DNS: ${lines.join(' | ')}\n`;
          } catch { /* 静默 */ }
          if (type === 'network') return report;
        }

        if (type === 'battery' || type === 'all') {
          let report = type === 'battery' ? `🔋 **电池信息**\n${'─'.repeat(50)}\n` : '\n🔋 **电池**\n';
          try {
            if (IS_WIN) {
              const ps = `Get-WmiObject Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Csv -NoTypeInformation`;
              const out = await execPowerShell(ps, 8000);
              const line = out.split('\n').find(l => l.trim() && !l.startsWith('"Est'));
              if (line) {
                const parts = line.split(',').map(s => s.replace(/"/g, ''));
                const pct = parts[0] || '?';
                const batteryStatusMap: Record<string, string> = { '2': '充电中', '3': '已充满' };
                const status = batteryStatusMap[parts[1]] || '使用中';
                report += `   电量: ${pct}% | 状态: ${status}`;
              } else {
                report += '   ⚠️ 未检测到电池（可能是台式机）';
              }
            } else if (IS_MAC) {
              const { stdout } = await execAsync('pmset -g batt 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
              report += '   ' + stdout.split('\n').filter(Boolean).slice(0, 2).join(' | ');
            } else {
              const { stdout } = await execAsync('upower -i /org/freedesktop/UPower/devices/BAT0 2>/dev/null | grep -E "percentage|state"', { encoding: 'utf-8', timeout: 5000 });
              report += '   ' + stdout.split('\n').filter(Boolean).join(' | ');
            }
          } catch {
            report += '   ⚠️ 电池信息获取失败（可能无电池）';
          }
          if (type === 'battery') return report;
        }

        return '用法: type=overview|cpu|memory|disk|network|battery|all';
      } catch (err: unknown) {
        return `❌ 系统信息查询失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // A2. 进程管理
  // ============================================================
  {
    name: 'process_manage',
    description: '进程管理。列出/查找/结束进程，调整进程优先级。action: list(列出)/find(查找)/kill(结束)/priority(优先级)/top(资源占用TOP)。',
    parameters: {
      action: { type: 'string', description: '操作: list/find/kill/priority/top', required: true },
      name: { type: 'string', description: 'find: 进程名过滤；kill: 进程名或PID', required: false },
      pid: { type: 'string', description: 'kill/priority: 进程PID', required: false },
      priority: { type: 'string', description: 'priority: low/normal/high/realtime', required: false },
      limit: { type: 'string', description: 'top: 返回条数(默认15)', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      try {
        if (action === 'list' || action === 'top') {
          const limit = parseInt((args.limit as string) || '15', 10);
          let processes: Array<{ pid: number; name: string; cpu: number; mem: number }> = [];
          if (IS_WIN) {
            const ps = `Get-Process | Sort-Object ${action === 'top' ? 'CPU' : 'WorkingSet'} -Descending | Select-Object -First ${limit} Id,@{N='Name';E={$_.ProcessName}},@{N='CPU';E={[math]::Round($_.CPU||0,1)}},@{N='MemMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Csv -NoTypeInformation`;
            const out = await execPowerShell(ps, 12000);
            processes = out.split('\n').slice(1).filter(l => l.trim()).map(l => {
              const parts = l.split(',').map(s => s.replace(/"/g, ''));
              return { pid: parseInt(parts[0] || '0', 10), name: parts[1] || '', cpu: parseFloat(parts[2] || '0'), mem: parseFloat(parts[3] || '0') };
            });
          } else {
            const cmd = action === 'top'
              ? `ps aux | sort -nrk 3 | head -${limit}`
              : `ps aux | sort -nrk 4 | head -${limit}`;
            const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout: 5000 });
            processes = stdout.split('\n').slice(1).filter(Boolean).map(l => {
              const parts = l.trim().split(/\s+/);
              return { pid: parseInt(parts[1] || '0', 10), name: parts[10] || parts[0] || '', cpu: parseFloat(parts[2] || '0'), mem: parseFloat(parts[3] || '0') };
            });
          }
          if (processes.length === 0) return '⚠️ 未获取到进程列表';
          let report = `📊 **进程${action === 'top' ? '资源占用 TOP' : '列表'}** (前 ${processes.length} 个)\n${'─'.repeat(50)}\n`;
          report += processes.map(p => `   ${String(p.pid).padEnd(8)} ${p.name.substring(0, 25).padEnd(26)} CPU:${String(p.cpu).padEnd(6)} Mem:${p.mem}${IS_WIN ? 'MB' : '%'}`).join('\n');
          return report;
        }

        if (action === 'find') {
          const name = (args.name as string || '').toLowerCase();
          if (!name) return '❌ find 需要 name 参数';
          let matches: Array<{ pid: number; name: string; mem: number }> = [];
          if (IS_WIN) {
            const ps = `Get-Process | Where-Object { $_.ProcessName -like '*${name.replace(/'/g, "''")}*' } | Select-Object Id,ProcessName,@{N='MemMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Csv -NoTypeInformation`;
            const out = await execPowerShell(ps, 10000);
            matches = out.split('\n').slice(1).filter(l => l.trim()).map(l => {
              const parts = l.split(',').map(s => s.replace(/"/g, ''));
              return { pid: parseInt(parts[0] || '0', 10), name: parts[1] || '', mem: parseFloat(parts[2] || '0') };
            });
          } else {
            const { stdout } = await execAsync(`ps aux | grep -i "${name.replace(/"/g, '\\"')}" | grep -v grep`, { encoding: 'utf-8', timeout: 5000 });
            matches = stdout.split('\n').filter(Boolean).map(l => {
              const parts = l.trim().split(/\s+/);
              return { pid: parseInt(parts[1] || '0', 10), name: parts[10] || '', mem: parseFloat(parts[3] || '0') };
            });
          }
          if (matches.length === 0) return `🔍 未找到匹配 "${name}" 的进程`;
          let report = `🔍 **查找进程** "${args.name}" (共 ${matches.length} 个)\n${'─'.repeat(50)}\n`;
          report += matches.slice(0, 30).map(p => `   PID:${String(p.pid).padEnd(8)} ${p.name.substring(0, 30)} Mem:${p.mem}${IS_WIN ? 'MB' : '%'}`).join('\n');
          if (matches.length > 30) report += `\n   ...(共 ${matches.length} 个，已截断)`;
          return report;
        }

        if (action === 'kill') {
          const pidRaw = (args.pid as string) || '';
          const nameRaw = (args.name as string) || '';
          if (!pidRaw && !nameRaw) return '❌ kill 需要 pid 或 name 参数';
          if (IS_WIN) {
            const ps = pidRaw
              ? `Stop-Process -Id ${parseInt(pidRaw, 10)} -Force -ErrorAction SilentlyContinue; if ($?) { 'OK' } else { 'FAIL' }`
              : `Get-Process | Where-Object { $_.ProcessName -like '*${nameRaw.replace(/'/g, "''")}*' } | Stop-Process -Force -ErrorAction SilentlyContinue; if ($?) { 'OK' } else { 'FAIL' }`;
            const out = (await execPowerShell(ps, 10000)).trim();
            return out === 'OK' ? `✅ 已结束进程: ${pidRaw || nameRaw}` : `❌ 结束失败: 进程不存在或无权限 (${pidRaw || nameRaw})`;
          }
          const target = pidRaw || nameRaw;
          await execAsync(`kill -9 ${pidRaw || `"${nameRaw}"`}`.replace(/"/g, '\\"'), { encoding: 'utf-8', timeout: 5000 });
          return `✅ 已结束进程: ${target}`;
        }

        if (action === 'priority') {
          const pid = parseInt((args.pid as string) || '0', 10);
          if (!pid) return '❌ priority 需要 pid 参数';
          const priority = (args.priority as string) || 'normal';
          if (!['low', 'normal', 'high', 'realtime'].includes(priority)) return '❌ priority 必须是 low/normal/high/realtime';
          if (IS_WIN) {
            const ps = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = ${priority.charAt(0).toUpperCase() + priority.slice(1)}; 'OK' } else { 'NOT_FOUND' }`;
            const out = (await execPowerShell(ps, 8000)).trim();
            return out === 'OK' ? `✅ 已设置 PID ${pid} 优先级为 ${priority}` : `❌ 进程 ${pid} 不存在`;
          }
          const niceMap: Record<string, number> = { low: 10, normal: 0, high: -5, realtime: -10 };
          await execAsync(`renice ${niceMap[priority]} ${pid}`, { encoding: 'utf-8', timeout: 5000 });
          return `✅ 已设置 PID ${pid} nice 值为 ${niceMap[priority]}`;
        }

        return '❌ action 必须是 list/find/kill/priority/top';
      } catch (err: unknown) {
        return `❌ 进程管理失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // A3. 窗口布局管理
  // ============================================================
  {
    name: 'window_layout',
    description: '窗口布局管理。action: list(列出可见窗口)/tile(分屏排列)/cascade(层叠)/minimize_all(最小化全部)/restore(还原)/snap(窗口靠边吸靠)/switch_desktop(切换虚拟桌面)。',
    parameters: {
      action: { type: 'string', description: '操作: list/tile/cascade/minimize_all/restore/snap/switch_desktop', required: true },
      layout: { type: 'string', description: 'tile: horizontal/vertical/grid，默认 grid', required: false },
      target: { type: 'string', description: 'snap: left/right/top；switch_desktop: 桌面序号', required: false },
      title: { type: 'string', description: 'list: 标题过滤；操作目标窗口标题包含此串', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      try {
        if (!IS_WIN && !IS_MAC) return '⚠️ 窗口布局管理目前仅支持 Windows / macOS';

        if (action === 'list') {
          const titleFilter = (args.title as string) || '';
          if (IS_WIN) {
            // 用 Get-Process 的 MainWindowTitle 获取可见窗口（比内联 C# EnumWindows 更可靠）
            const ps = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id,@{N='Name';E={$_.ProcessName}},@{N='Title';E={$_.MainWindowTitle}} | ConvertTo-Csv -NoTypeInformation`;
            try {
              const out = await execPowerShell(ps, 10000);
              const lines = out.split('\n').slice(1).filter(l => l.trim()).map(l => {
                const parts = l.split(',').map(s => s.replace(/"/g, ''));
                return `PID:${parts[0]} | ${parts[2] || parts[1] || ''}`;
              }).filter(l => !titleFilter || l.toLowerCase().includes(titleFilter.toLowerCase()));
              if (lines.length === 0) return '🔍 未找到可见窗口';
              let report = `🪟 **可见窗口** (${lines.length} 个)\n${'─'.repeat(50)}\n`;
              report += lines.slice(0, 30).map(l => '   ' + l).join('\n');
              if (lines.length > 30) report += `\n   ...(共 ${lines.length} 个)`;
              return report;
            } catch {
              // 回退：用 tasklist
              const { stdout } = await execAsync('tasklist /V /FI "STATUS eq RUNNING" 2>nul', { encoding: 'utf-8', timeout: 8000 });
              const lines = stdout.split('\n').slice(3).filter(l => l.trim() && (!titleFilter || l.toLowerCase().includes(titleFilter.toLowerCase())));
              let report = `🪟 **可见窗口** (tasklist)\n${'─'.repeat(50)}\n`;
              report += lines.slice(0, 20).map(l => '   ' + l.substring(0, 100)).join('\n');
              return report;
            }
          }
          // macOS
          const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get name of every window of every process whose visible is true'`, { encoding: 'utf-8', timeout: 5000 });
          let report = `🪟 **可见窗口** (macOS)\n${'─'.repeat(50)}\n`;
          report += stdout.split(',').filter(Boolean).slice(0, 30).map(s => '   ' + s.trim()).join('\n');
          return report;
        }

        if (action === 'minimize_all') {
          if (IS_WIN) {
            await execPowerShell(`
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()`, 8000);
            return '✅ 已最小化所有窗口';
          }
          await execAsync(`osascript -e 'tell application "System Events" to set miniaturized of every window of every process to true'`, { encoding: 'utf-8', timeout: 5000 });
          return '✅ 已最小化所有窗口';
        }

        if (action === 'restore') {
          if (IS_WIN) {
            await execPowerShell(`
$shell = New-Object -ComObject Shell.Application
$shell.UndoMinimizeALL()`, 8000);
            return '✅ 已还原所有窗口';
          }
          return '⚠️ macOS 还原全部窗口请手动操作';
        }

        if (action === 'tile' || action === 'cascade') {
          const layout = (args.layout as string) || 'grid';
          if (IS_WIN) {
            // 用 Shell.Application 的 TileWindows / CascadeWindows
            const tileMap: Record<string, string> = { horizontal: 'Horizontally', vertical: 'Vertically' };
            const cmd = action === 'cascade'
              ? `$shell = New-Object -ComObject Shell.Application; $shell.CascadeWindows()`
              : `$shell = New-Object -ComObject Shell.Application; $shell.Tile${tileMap[layout] || 'Vertically'}()`;
            await execPowerShell(cmd, 8000);
            return `✅ 已${action === 'cascade' ? '层叠' : '平铺'}所有窗口 (${layout})`;
          }
          return `⚠️ macOS 不支持系统级 ${action}，建议手动拖拽或用 Magnet/Rectangle 等工具`;
        }

        if (action === 'snap') {
          const target = (args.target as string) || 'left';
          if (!['left', 'right', 'top'].includes(target)) return '❌ snap target 必须是 left/right/top';
          if (IS_WIN) {
            // Win+方向键
            const keyMap: Record<string, string> = { left: 'Left', right: 'Right', top: 'Up' };
            await execPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('#{${keyMap[target]}}')`, 8000);
            return `✅ 已将活动窗口吸靠到 ${target}`;
          }
          return '⚠️ macOS 吸靠请用 Rectangle 等工具';
        }

        if (action === 'switch_desktop') {
          const num = parseInt((args.target as string) || '1', 10);
          if (IS_WIN) {
            // Win+Ctrl+D 新建, Win+Ctrl+Left/Right 切换
            const dir = num > 0 ? 'Right' : 'Left';
            const times = Math.abs(num) || 1;
            const ps = `Add-Type -AssemblyName System.Windows.Forms
1..${times} | ForEach-Object { [System.Windows.Forms.SendKeys]::SendWait('^#{${dir}}'); Start-Sleep -Milliseconds 200 }`;
            await execPowerShell(ps, 10000);
            return `✅ 已向${num > 0 ? '右' : '左'}切换 ${times} 个虚拟桌面`;
          }
          // macOS: Ctrl+Left/Right
          const dir = num > 0 ? 'Right' : 'Left';
          await execAsync(`osascript -e 'tell application "System Events" to key code ${num > 0 ? '124' : '123'} using control down'`, { encoding: 'utf-8', timeout: 5000 });
          return `✅ 已切换虚拟桌面 (${dir})`;
        }

        return '❌ action 必须是 list/tile/cascade/minimize_all/restore/snap/switch_desktop';
      } catch (err: unknown) {
        return `❌ 窗口布局失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // A4. 剪贴板历史
  // ============================================================
  {
    name: 'clipboard_history',
    description: '剪贴板历史管理。自动监听剪贴板变化并持久化存储。action: start(开始监听)/stop(停止)/list(查看历史)/search(搜索)/get(取第N条)/clear(清空)/stats(统计)。',
    parameters: {
      action: { type: 'string', description: '操作: start/stop/list/search/get/clear/stats', required: true },
      keyword: { type: 'string', description: 'search: 搜索关键词', required: false },
      index: { type: 'string', description: 'get: 第几条(从1开始，默认1)', required: false },
      limit: { type: 'string', description: 'list: 返回条数(默认20)', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const histFile = path.join(os.homedir(), '.duan', 'clipboard-history.json');
      const stateFile = path.join(os.homedir(), '.duan', 'clipboard-monitor.state');

      type ClipItem = { id: string; text: string; timestamp: number; type: string };
      const readHistory = (): Promise<ClipItem[]> => readJson<ClipItem[]>(histFile, []);

      try {
        if (action === 'start') {
          // 通过标记文件表示监听中（实际监听由 desktop-control 的轮询或独立进程完成）
          await writeJson(stateFile, { monitoring: true, startedAt: Date.now() });
          return `✅ 剪贴板监听已启用\n   💡 实际监听由系统后台轮询完成，每次剪贴板变化会自动追加到历史\n   📂 历史文件: ${histFile}\n   ⚠️ 如需停止，使用 action=stop`;
        }

        if (action === 'stop') {
          await writeJson(stateFile, { monitoring: false, startedAt: 0 });
          return '✅ 剪贴板监听已停止';
        }

        if (action === 'list') {
          const history = await readHistory();
          if (history.length === 0) return '📭 剪贴板历史为空（请先 action=start 启用监听）';
          const limit = parseInt((args.limit as string) || '20', 10);
          const items = history.slice(-limit).reverse();
          let report = `📋 **剪贴板历史** (最近 ${items.length} 条，共 ${history.length} 条)\n${'─'.repeat(50)}\n`;
          report += items.map((it, i) => {
            const preview = it.text.substring(0, 60).replace(/\n/g, ' ');
            const more = it.text.length > 60 ? '...' : '';
            return `   [${history.length - i}] ${new Date(it.timestamp).toLocaleTimeString('zh-CN')} (${it.type}) ${preview}${more}`;
          }).join('\n');
          return report;
        }

        if (action === 'search') {
          const keyword = (args.keyword as string) || '';
          if (!keyword) return '❌ search 需要 keyword 参数';
          const history = await readHistory();
          const matches = history.filter(it => it.text.includes(keyword));
          if (matches.length === 0) return `🔍 未找到包含 "${keyword}" 的剪贴板记录`;
          let report = `🔍 **搜索结果** "${keyword}" (${matches.length} 条)\n${'─'.repeat(50)}\n`;
          report += matches.slice(-20).reverse().map((it, i) => {
            const preview = it.text.substring(0, 80).replace(/\n/g, ' ');
            return `   [${i + 1}] ${new Date(it.timestamp).toLocaleString('zh-CN')}\n       ${preview}${it.text.length > 80 ? '...' : ''}`;
          }).join('\n');
          return report;
        }

        if (action === 'get') {
          const idx = parseInt((args.index as string) || '1', 10);
          const history = await readHistory();
          if (idx < 1 || idx > history.length) return `❌ 索引超出范围 (1-${history.length})`;
          const item = history[history.length - idx];
          let report = `📋 **剪贴板历史 #${idx}**\n${'─'.repeat(50)}\n`;
          report += `   时间: ${new Date(item.timestamp).toLocaleString('zh-CN')}\n`;
          report += `   类型: ${item.type} | 长度: ${item.text.length} 字符\n`;
          report += `   内容:\n${item.text}`;
          return report;
        }

        if (action === 'clear') {
          await writeJson(histFile, []);
          return '✅ 剪贴板历史已清空';
        }

        if (action === 'stats') {
          const history = await readHistory();
          if (history.length === 0) return '📭 剪贴板历史为空';
          const types = history.reduce<Record<string, number>>((acc, it) => {
            acc[it.type] = (acc[it.type] || 0) + 1; return acc;
          }, {});
          const oldest = history[0];
          const newest = history[history.length - 1];
          let report = `📊 **剪贴板历史统计**\n${'─'.repeat(50)}\n`;
          report += `   总条数: ${history.length}\n`;
          report += `   类型分布: ${Object.entries(types).map(([k, v]) => `${k}=${v}`).join(' | ')}\n`;
          report += `   最早: ${new Date(oldest.timestamp).toLocaleString('zh-CN')}\n`;
          report += `   最新: ${new Date(newest.timestamp).toLocaleString('zh-CN')}\n`;
          report += `   平均长度: ${Math.round(history.reduce((s, it) => s + it.text.length, 0) / history.length)} 字符`;
          return report;
        }

        return '❌ action 必须是 start/stop/list/search/get/clear/stats';
      } catch (err: unknown) {
        return `❌ 剪贴板历史操作失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // A5. 快速启动器
  // ============================================================
  {
    name: 'quick_launch',
    description: '快速启动器。管理应用/网址/文件/命令的别名，支持一键打开。action: add(添加别名)/list(列出)/run(运行)/remove(删除)/edit(编辑)/import(批量导入)。',
    parameters: {
      action: { type: 'string', description: '操作: add/list/run/remove/edit/import', required: true },
      alias: { type: 'string', description: '别名(如 chrome/code/工作邮箱)', required: false },
      target: { type: 'string', description: 'add: 目标(app路径/url/filePath/shell命令)', required: false },
      type: { type: 'string', description: 'add: 类型 app/url/file/cmd，默认自动识别', required: false },
      icon: { type: 'string', description: 'add: 图标 emoji', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const launchFile = path.join(os.homedir(), '.duan', 'quicklaunch.json');

      type LaunchItem = { alias: string; target: string; type: string; icon: string; createdAt: number; lastUsed: number; usedCount: number };
      const readList = (): Promise<LaunchItem[]> => readJson<LaunchItem[]>(launchFile, []);
      const writeList = (l: LaunchItem[]) => writeJson(launchFile, l);

      try {
        if (action === 'add') {
          const alias = (args.alias as string) || '';
          const target = (args.target as string) || '';
          if (!alias || !target) return '❌ add 需要 alias 和 target';
          const list = await readList();
          if (list.find(it => it.alias === alias)) return `❌ 别名 "${alias}" 已存在，请用 edit 修改`;

          // 自动识别类型
          let type = (args.type as string) || '';
          if (!type) {
            if (/^https?:\/\//i.test(target)) type = 'url';
            else if (IS_WIN && /\.exe$/i.test(target)) type = 'app';
            else if (IS_MAC && /\.app$/i.test(target)) type = 'app';
            else if (/\.(md|txt|docx?|xlsx?|pptx?|pdf|json|ts|js|py)$/i.test(target)) type = 'file';
            else type = 'cmd';
          }
          const launchIconMap: Record<string, string> = { url: '🌐', app: '📦', file: '📄', cmd: '⌨️' };
          const icon = (args.icon as string) || launchIconMap[type] || '⌨️';
          const item: LaunchItem = { alias, target, type, icon, createdAt: Date.now(), lastUsed: 0, usedCount: 0 };
          list.push(item);
          await writeList(list);
          return `✅ 已添加快捷方式: ${icon} ${alias} → ${target}\n   类型: ${type}`;
        }

        if (action === 'list') {
          const list = await readList();
          if (list.length === 0) return '📭 快速启动列表为空（请用 action=add 添加）';
          let report = `🚀 **快速启动列表** (${list.length} 个)\n${'─'.repeat(50)}\n`;
          report += list.sort((a, b) => b.usedCount - a.usedCount).map(it =>
            `   ${it.icon} ${it.alias.padEnd(15)} [${it.type}] → ${it.target.substring(0, 50)}${it.target.length > 50 ? '...' : ''} (用过 ${it.usedCount} 次)`
          ).join('\n');
          return report;
        }

        if (action === 'run') {
          const alias = (args.alias as string) || '';
          if (!alias) return '❌ run 需要 alias 参数';
          const list = await readList();
          const item = list.find(it => it.alias === alias);
          if (!item) return `❌ 未找到别名 "${alias}"（用 action=list 查看）`;

          try {
            if (item.type === 'url') {
              const openUrlCmdMap: Record<string, string> = { win32: `start ""`, darwin: 'open' };
              const openCmd = openUrlCmdMap[process.platform] || 'xdg-open';
              await execAsync(`${openCmd} "${item.target}"`, { encoding: 'utf-8', timeout: 5000 });
            } else if (item.type === 'app') {
              if (IS_WIN) await execAsync(`start "" "${item.target}"`, { encoding: 'utf-8', timeout: 8000 });
              else if (IS_MAC) await execAsync(`open -a "${item.target}"`, { encoding: 'utf-8', timeout: 8000 });
              else await execAsync(`xdg-open "${item.target}"`, { encoding: 'utf-8', timeout: 8000 });
            } else if (item.type === 'file') {
              const guard = guardSensitivePath(item.target);
              if (guard) return guard;
              if (IS_WIN) await execAsync(`start "" "${item.target}"`, { encoding: 'utf-8', timeout: 8000 });
              else await execAsync(`open "${item.target}"`, { encoding: 'utf-8', timeout: 8000 });
            } else {
              // cmd
              await execAsync(item.target, { encoding: 'utf-8', timeout: 30000, cwd: process.cwd() });
            }
            item.usedCount++;
            item.lastUsed = Date.now();
            await writeList(list);
            return `✅ 已启动: ${item.icon} ${item.alias} (第 ${item.usedCount} 次使用)`;
          } catch (err) {
            return `❌ 启动失败: ${errMsg(err)}`;
          }
        }

        if (action === 'remove') {
          const alias = (args.alias as string) || '';
          const list = await readList();
          const idx = list.findIndex(it => it.alias === alias);
          if (idx < 0) return `❌ 未找到别名 "${alias}"`;
          const removed = list.splice(idx, 1)[0];
          await writeList(list);
          return `✅ 已删除: ${removed.icon} ${removed.alias}`;
        }

        if (action === 'edit') {
          const alias = (args.alias as string) || '';
          const list = await readList();
          const item = list.find(it => it.alias === alias);
          if (!item) return `❌ 未找到别名 "${alias}"`;
          if (args.target) item.target = args.target as string;
          if (args.type) item.type = args.type as string;
          if (args.icon) item.icon = args.icon as string;
          await writeList(list);
          return `✅ 已更新: ${item.icon} ${item.alias} → ${item.target}`;
        }

        if (action === 'import') {
          const target = (args.target as string) || '';
          if (!target) return '❌ import 需要 target 参数(JSON 数组)';
          let items: Array<{ alias: string; target: string; type?: string; icon?: string }>;
          try { items = JSON.parse(target); } catch { return '❌ target 不是合法 JSON 数组'; }
          if (!Array.isArray(items)) return '❌ target 必须是数组';
          const list = await readList();
          let added = 0;
          for (const it of items) {
            if (!it.alias || !it.target) continue;
            if (list.find(x => x.alias === it.alias)) continue;
            list.push({
              alias: it.alias, target: it.target,
              type: it.type || 'cmd', icon: it.icon || '⚡',
              createdAt: Date.now(), lastUsed: 0, usedCount: 0,
            });
            added++;
          }
          await writeList(list);
          return `✅ 已导入 ${added} 个快捷方式（共 ${list.length} 个）`;
        }

        return '❌ action 必须是 add/list/run/remove/edit/import';
      } catch (err: unknown) {
        return `❌ 快速启动操作失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // A6. 系统设置
  // ============================================================
  {
    name: 'system_settings',
    description: '系统设置操作。action: wallpaper(设置壁纸)/power_mode(电源模式)/default_app(默认应用)/dnd(免打扰)/sleep(休眠)/screensaver(屏保)/empty_recycle(清空回收站)/disk_cleanup(磁盘清理)。',
    parameters: {
      action: { type: 'string', description: '操作: wallpaper/power_mode/default_app/dnd/sleep/screensaver/empty_recycle/disk_cleanup', required: true },
      value: { type: 'string', description: 'wallpaper: 图片路径；power_mode: balanced/high/power_saver；default_app: 扩展名；dnd: on/off', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      try {
        if (!IS_WIN && !IS_MAC) return '⚠️ 系统设置目前仅支持 Windows / macOS';

        if (action === 'wallpaper') {
          const imgPath = (args.value as string) || '';
          if (!imgPath) return '❌ wallpaper 需要 value 参数(图片路径)';
          const guard = guardSensitivePath(imgPath);
          if (guard) return guard;
          if (!(await pathExists(imgPath))) return `❌ 图片不存在: ${imgPath}`;
          if (IS_WIN) {
            const ps = `Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class WP { [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni); }
"@
[WP]::SystemParametersInfo(20, 0, "${imgPath.replace(/"/g, '""')}", 3)`;
            await execPowerShell(ps, 8000);
            return `✅ 已设置壁纸: ${imgPath}`;
          }
          await execAsync(`osascript -e 'tell application "System Events" to set picture of every desktop to "${imgPath.replace(/"/g, '\\"')}"'`, { encoding: 'utf-8', timeout: 5000 });
          return `✅ 已设置壁纸: ${imgPath}`;
        }

        if (action === 'power_mode') {
          const mode = (args.value as string) || 'balanced';
          if (!['balanced', 'high', 'power_saver'].includes(mode)) return '❌ power_mode value 必须是 balanced/high/power_saver';
          if (IS_WIN) {
            const guidMap: Record<string, string> = { balanced: '381b4222-f694-41f0-9685-ff5bb260df2e', high: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', power_saver: 'a1841308-3541-4fab-bc81-f71556f20b4a' };
            const ps = `powercfg /setactive ${guidMap[mode]}`;
            await execPowerShell(ps, 8000);
            return `✅ 已切换电源模式: ${mode}`;
          }
          return `⚠️ macOS 电源模式请到系统设置调整（当前: ${mode}）`;
        }

        if (action === 'dnd') {
          const value = (args.value as string) || 'on';
          if (!['on', 'off'].includes(value)) return '❌ dnd value 必须是 on/off';
          if (IS_WIN) {
            // Windows 专注助手
            const ps = value === 'on'
              ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{F11}')`  // 部分 Windows 版本
              : `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{F11}')`;
            try {
              await execPowerShell(ps, 8000);
              return `✅ 已${value === 'on' ? '开启' : '关闭'}免打扰（焦点辅助）\n⚠️ 不同 Windows 版本快捷键可能不同，如未生效请手动操作`;
            } catch {
              return `⚠️ 免打扰切换失败，请到"设置 → 系统 → 通知"手动${value === 'on' ? '开启' : '关闭'}`;
            }
          }
          // macOS:defaults write com.apple.controlcenter "NSStatusItem Visible FocusModes" -bool true
          await execAsync(`defaults -currentHost write com.apple.controlcenter "NSStatusItem Visible FocusModes" -bool ${value === 'on' ? 'true' : 'false'}`, { encoding: 'utf-8', timeout: 5000 });
          return `✅ 已${value === 'on' ? '开启' : '关闭'}免打扰`;
        }

        if (action === 'sleep') {
          if (IS_WIN) {
            await execPowerShell(`Add-Type -Namespace Win32 -Name Pwr -MemberDefinition '[DllImport("powrprof.dll")] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);'; [Win32.Pwr]::SetSuspendState($false, $false, $false)`, 8000);
            return '💤 已进入睡眠模式';
          }
          await execAsync('pmset sleepnow', { encoding: 'utf-8', timeout: 5000 });
          return '💤 已进入睡眠模式';
        }

        if (action === 'screensaver') {
          if (IS_WIN) {
            await execPowerShell(`Start-Process -FilePath "scrnsave.scr"`, 5000);
            return '🖥️ 已启动屏幕保护程序';
          }
          await execAsync('open -a ScreenSaverEngine', { encoding: 'utf-8', timeout: 5000 });
          return '🖥️ 已启动屏幕保护程序';
        }

        if (action === 'empty_recycle') {
          if (IS_WIN) {
            const ps = `Clear-RecycleBin -Force -ErrorAction SilentlyContinue; if ($?) { 'OK' } else { 'FAIL' }`;
            const out = (await execPowerShell(ps, 30000)).trim();
            return out === 'OK' ? '✅ 已清空回收站' : '⚠️ 清空回收站失败或回收站已空';
          }
          await execAsync('rm -rf ~/.Trash/*', { encoding: 'utf-8', timeout: 10000 });
          return '✅ 已清空废纸篓';
        }

        if (action === 'disk_cleanup') {
          if (IS_WIN) {
            // 启动磁盘清理（cleanmgr /verylowdisk 极速模式）
            const ps = `Start-Process -FilePath "cleanmgr.exe" -ArgumentList "/verylowdisk" -Wait -PassThru | Out-Null; 'OK'`;
            try {
              await execPowerShell(ps, 60000);
              return '✅ 磁盘清理已完成';
            } catch {
              return '⚠️ 磁盘清理超时，请手动运行 cleanmgr';
            }
          }
          // Linux/macOS: 清理常见缓存
          const cmds = ['rm -rf ~/.cache/* 2>/dev/null', 'rm -rf /tmp/* 2>/dev/null', 'rm -rf ~/Library/Caches/* 2>/dev/null'];
          for (const c of cmds) {
            try { await execAsync(c, { encoding: 'utf-8', timeout: 10000 }); } catch { /* 忽略 */ }
          }
          return '✅ 已清理缓存目录';
        }

        if (action === 'default_app') {
          const ext = (args.value as string) || '';
          if (!ext) return '❌ default_app 需要 value 参数(扩展名，如 .pdf .html)';
          if (IS_WIN) {
            const ps = `$ext = "${ext.replace(/"/g, '')}"; $prog = (Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext\\UserChoice" -ErrorAction SilentlyContinue).ProgId; if ($prog) { "默认程序: $prog" } else { "未设置默认程序" }`;
            const out = (await execPowerShell(ps, 8000)).trim();
            return `📄 扩展名 ${ext} 的${out}`;
          }
          return '⚠️ macOS/Linux 默认应用查询请用 xdg-mime / duti 等工具';
        }

        return '❌ action 必须是 wallpaper/power_mode/default_app/dnd/sleep/screensaver/empty_recycle/disk_cleanup';
      } catch (err: unknown) {
        return `❌ 系统设置失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // B7. 日历管理
  // ============================================================
  {
    name: 'calendar_manage',
    description: '日历管理。创建/查看/删除事件，支持冲突检测和提醒。action: create(创建事件)/list(列出)/today(今日)/week(本周)/upcoming(即将到来)/remove(删除)/conflict(冲突检测)。',
    parameters: {
      action: { type: 'string', description: '操作: create/list/today/week/upcoming/remove/conflict', required: true },
      title: { type: 'string', description: 'create: 事件标题', required: false },
      start: { type: 'string', description: 'create: 开始时间(YYYY-MM-DD HH:mm)', required: false },
      end: { type: 'string', description: 'create: 结束时间(YYYY-MM-DD HH:mm)', required: false },
      location: { type: 'string', description: 'create: 地点', required: false },
      attendees: { type: 'string', description: 'create: 参会者(逗号分隔)', required: false },
      reminder: { type: 'string', description: 'create: 提前提醒分钟数(默认15)', required: false },
      id: { type: 'string', description: 'remove: 事件ID', required: false },
      days: { type: 'string', description: 'upcoming: 未来N天(默认7)', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const calFile = path.join(os.homedir(), '.duan', 'calendar.json');

      type Event = { id: string; title: string; start: string; end: string; location?: string; attendees?: string[]; reminder: number; createdAt: number };
      const readCal = (): Promise<Event[]> => readJson<Event[]>(calFile, []);
      const writeCal = (e: Event[]) => writeJson(calFile, e);

      const parseDate = (s: string): number => {
        // 兼容 "YYYY-MM-DD HH:mm" 和 ISO
        const d = new Date(s.replace(' ', 'T'));
        return isNaN(d.getTime()) ? 0 : d.getTime();
      };
      const fmtDate = (ms: number): string => new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

      try {
        if (action === 'create') {
          const title = (args.title as string) || '';
          const start = (args.start as string) || '';
          const end = (args.end as string) || '';
          if (!title || !start || !end) return '❌ create 需要 title/start/end';
          const startMs = parseDate(start);
          const endMs = parseDate(end);
          if (!startMs || !endMs) return '❌ 时间格式应为 YYYY-MM-DD HH:mm';
          if (endMs <= startMs) return '❌ 结束时间必须晚于开始时间';

          // 冲突检测
          const events = await readCal();
          const conflicts = events.filter(e => {
            const es = parseDate(e.start); const ee = parseDate(e.end);
            return startMs < ee && endMs > es;
          });

          const attendees = (args.attendees as string) ? (args.attendees as string).split(',').map(s => s.trim()).filter(Boolean) : [];
          const ev: Event = {
            id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            title, start, end,
            location: args.location as string,
            attendees,
            reminder: parseInt((args.reminder as string) || '15', 10),
            createdAt: Date.now(),
          };
          events.push(ev);
          await writeCal(events);
          let report = `✅ 事件已创建: ${ev.id}\n   📅 ${title}\n   ⏰ ${fmtDate(startMs)} → ${fmtDate(endMs)}`;
          if (ev.location) report += `\n   📍 ${ev.location}`;
          if (attendees.length) report += `\n   👥 ${attendees.join(', ')}`;
          report += `\n   ⏲️ 提前 ${ev.reminder} 分钟提醒`;
          if (conflicts.length > 0) {
            report += `\n\n⚠️ **检测到 ${conflicts.length} 个时间冲突**:`;
            report += conflicts.map(c => `\n   • ${c.title} (${fmtDate(parseDate(c.start))} - ${fmtDate(parseDate(c.end))})`).join('');
          }
          return report;
        }

        if (action === 'list' || action === 'today' || action === 'week' || action === 'upcoming') {
          const events = await readCal();
          if (events.length === 0) return '📅 日历为空（请用 action=create 添加事件）';

          const now = Date.now();
          let filtered: Event[];
          let label: string;
          if (action === 'today') {
            const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(); dayEnd.setHours(23, 59, 59, 999);
            filtered = events.filter(e => {
              const s = parseDate(e.start);
              return s >= dayStart.getTime() && s <= dayEnd.getTime();
            });
            label = '今日';
          } else if (action === 'week') {
            const weekEnd = now + 7 * 86400000;
            filtered = events.filter(e => {
              const s = parseDate(e.start);
              return s >= now - 86400000 && s <= weekEnd;
            }).sort((a, b) => parseDate(a.start) - parseDate(b.start));
            label = '本周';
          } else if (action === 'upcoming') {
            const days = parseInt((args.days as string) || '7', 10);
            const range = days * 86400000;
            filtered = events.filter(e => {
              const s = parseDate(e.start);
              return s >= now && s <= now + range;
            }).sort((a, b) => parseDate(a.start) - parseDate(b.start));
            label = `未来 ${days} 天`;
          } else {
            filtered = events.sort((a, b) => parseDate(b.start) - parseDate(a.start));
            label = '全部';
          }

          if (filtered.length === 0) return `📅 ${label}无事件`;
          let report = `📅 **${label}事件** (${filtered.length} 个)\n${'─'.repeat(50)}\n`;
          report += filtered.map((e, i) => {
            const s = parseDate(e.start); const ee = parseDate(e.end);
            const isPast = ee < now;
            const icon = isPast ? '✓' : '⏰';
            let line = `${icon} [${i + 1}] ${e.title}\n   ${fmtDate(s)} → ${fmtDate(ee)}`;
            if (e.location) line += `\n   📍 ${e.location}`;
            if (e.attendees && e.attendees.length) line += `\n   👥 ${e.attendees.join(', ')}`;
            return '   ' + line;
          }).join('\n');
          return report;
        }

        if (action === 'remove') {
          const id = (args.id as string) || '';
          if (!id) return '❌ remove 需要 id 参数';
          const events = await readCal();
          const idx = events.findIndex(e => e.id === id);
          if (idx < 0) return `❌ 未找到事件 ${id}`;
          const removed = events.splice(idx, 1)[0];
          await writeCal(events);
          return `✅ 已删除事件: ${removed.title}`;
        }

        if (action === 'conflict') {
          const events = await readCal();
          if (events.length < 2) return '📅 事件不足2个，无法检测冲突';
          const sorted = events.slice().sort((a, b) => parseDate(a.start) - parseDate(b.start));
          const conflicts: Array<[Event, Event]> = [];
          for (let i = 0; i < sorted.length - 1; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
              const a = sorted[i]; const b = sorted[j];
              const as = parseDate(a.start); const ae = parseDate(a.end);
              const bs = parseDate(b.start); const be = parseDate(b.end);
              if (as < be && bs < ae) {
                conflicts.push([a, b]);
              }
            }
          }
          if (conflicts.length === 0) return '✅ 未检测到时间冲突';
          let report = `⚠️ **检测到 ${conflicts.length} 组时间冲突**\n${'─'.repeat(50)}\n`;
          report += conflicts.map(([a, b], i) =>
            `   [${i + 1}] "${a.title}" (${fmtDate(parseDate(a.start))}-${fmtDate(parseDate(a.end))})\n       ⚔️ "${b.title}" (${fmtDate(parseDate(b.start))}-${fmtDate(parseDate(b.end))})`
          ).join('\n');
          return report;
        }

        return '❌ action 必须是 create/list/today/week/upcoming/remove/conflict';
      } catch (err: unknown) {
        return `❌ 日历操作失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // B8. 邮件批处理
  // ============================================================
  {
    name: 'email_batch',
    description: '邮件批处理。批量生成草稿、群发单显、分类规则、模板应用。action: draft_batch(批量草稿)/classify(分类规则)/template_apply(模板应用)/merge_mail(邮件合并)。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: '操作: draft_batch/classify/template_apply/merge_mail', required: true },
      recipients: { type: 'string', description: 'draft_batch/merge_mail: 收件人JSON数组(姓名+邮箱)', required: false },
      subject: { type: 'string', description: 'draft_batch/merge_mail: 邮件主题(可用{占位符})', required: false },
      body: { type: 'string', description: 'draft_batch/merge_mail: 邮件正文(可用{占位符})', required: false },
      template: { type: 'string', description: 'template_apply: 模板内容', required: false },
      data: { type: 'string', description: 'merge_mail: 数据JSON数组(用于占位符替换)', required: false },
      rules: { type: 'string', description: 'classify: 分类规则JSON(关键词→分类)', required: false },
      emails: { type: 'string', description: 'classify: 待分类邮件JSON数组', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const draftDir = path.join(os.homedir(), '.duan', 'email-drafts');

      try {
        if (action === 'draft_batch') {
          const recipientsRaw = (args.recipients as string) || '';
          const subject = (args.subject as string) || '(无主题)';
          const body = (args.body as string) || '';
          if (!recipientsRaw) return '❌ draft_batch 需要 recipients 参数';
          let recipients: Array<{ name?: string; email: string }>;
          try { recipients = JSON.parse(recipientsRaw); } catch { return '❌ recipients 不是合法 JSON 数组'; }
          if (!Array.isArray(recipients) || recipients.length === 0) return '❌ recipients 必须是非空数组';

          await fs.promises.mkdir(draftDir, { recursive: true });
          let report = `✉️ **批量草稿生成** (${recipients.length} 封)\n${'─'.repeat(50)}\n`;
          let success = 0;
          for (let i = 0; i < recipients.length; i++) {
            const r = recipients[i];
            const name = r.name || r.email.split('@')[0];
            const personalizedSubject = subject.replace(/\{name\}/g, name).replace(/\{email\}/g, r.email);
            const personalizedBody = body.replace(/\{name\}/g, name).replace(/\{email\}/g, r.email);
            const draftFile = path.join(draftDir, `draft_${Date.now()}_${i}.json`);
            const draft = {
              id: `draft_${Date.now()}_${i}`,
              to: r.email, toName: name,
              subject: personalizedSubject, body: personalizedBody,
              createdAt: Date.now(), status: 'draft',
            };
            try {
              await writeJson(draftFile, draft);
              report += `   ✅ [${i + 1}] ${name} <${r.email}> → ${personalizedSubject}\n`;
              success++;
            } catch (err) {
              report += `   ❌ [${i + 1}] ${r.email} 失败: ${errMsg(err)}\n`;
            }
          }
          report += `\n📂 草稿目录: ${draftDir}\n✅ 成功: ${success}/${recipients.length}`;
          return report;
        }

        if (action === 'merge_mail') {
          // 邮件合并：模板 + 数据数组 → 个性化邮件
          const template = (args.template as string) || (args.body as string) || '';
          const dataRaw = (args.data as string) || '';
          const subject = (args.subject as string) || '(无主题)';
          if (!template) return '❌ merge_mail 需要 template 或 body 参数';
          if (!dataRaw) return '❌ merge_mail 需要 data 参数(JSON数组)';
          let data: Array<Record<string, unknown>>;
          try { data = JSON.parse(dataRaw); } catch { return '❌ data 不是合法 JSON 数组'; }
          if (!Array.isArray(data)) return '❌ data 必须是数组';

          await fs.promises.mkdir(draftDir, { recursive: true });
          let report = `📧 **邮件合并** (${data.length} 封)\n${'─'.repeat(50)}\n`;
          let success = 0;
          for (let i = 0; i < data.length; i++) {
            const row = data[i];
            // 替换所有 {key} 占位符
            const replace = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => String(row[k] ?? `{${k}}`));
            const personalizedSubject = replace(subject);
            const personalizedBody = replace(template);
            const to = String(row.email || row.mailto || '');
            const name = String(row.name || row.姓名 || to.split('@')[0] || `收件人${i + 1}`);
            if (!to) {
              report += `   ⚠️ [${i + 1}] ${name} 无邮箱，跳过\n`;
              continue;
            }
            const draftFile = path.join(draftDir, `merge_${Date.now()}_${i}.json`);
            const draft = { id: `merge_${Date.now()}_${i}`, to, toName: name, subject: personalizedSubject, body: personalizedBody, createdAt: Date.now(), status: 'merged' };
            try {
              await writeJson(draftFile, draft);
              report += `   ✅ [${i + 1}] ${name} <${to}> → ${personalizedSubject}\n`;
              success++;
            } catch (err) {
              report += `   ❌ [${i + 1}] ${to} 失败: ${errMsg(err)}\n`;
            }
          }
          report += `\n📂 草稿目录: ${draftDir}\n✅ 成功: ${success}/${data.length}`;
          return report;
        }

        if (action === 'classify') {
          const rulesRaw = (args.rules as string) || '';
          const emailsRaw = (args.emails as string) || '';
          if (!rulesRaw || !emailsRaw) return '❌ classify 需要 rules 和 emails 参数';
          let rules: Array<{ keywords: string[]; category: string }>;
          let emails: Array<{ subject: string; body?: string; from?: string }>;
          try { rules = JSON.parse(rulesRaw); emails = JSON.parse(emailsRaw); } catch { return '❌ rules/emails 不是合法 JSON'; }
          if (!Array.isArray(rules) || !Array.isArray(emails)) return '❌ rules 和 emails 必须是数组';

          const classify = (email: { subject: string; body?: string; from?: string }): string => {
            const text = `${email.subject || ''} ${email.body || ''} ${email.from || ''}`.toLowerCase();
            for (const rule of rules) {
              if (rule.keywords && rule.keywords.some(k => text.includes(k.toLowerCase()))) return rule.category;
            }
            return '其他';
          };

          const result = emails.map(e => ({ ...e, category: classify(e) }));
          const stats = result.reduce<Record<string, number>>((acc, e) => {
            const cat = (e as { category: string }).category;
            acc[cat] = (acc[cat] || 0) + 1; return acc;
          }, {});
          let report = `🗂️ **邮件分类结果** (${emails.length} 封)\n${'─'.repeat(50)}\n`;
          report += `   分布: ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' | ')}\n\n`;
          report += result.slice(0, 30).map((e, i) => `   [${i + 1}] [${(e as { category: string }).category}] ${e.subject}`).join('\n');
          return report;
        }

        if (action === 'template_apply') {
          // 用 LLM 把模板应用到一批场景
          const template = (args.template as string) || '';
          const dataRaw = (args.data as string) || '';
          if (!template || !dataRaw) return '❌ template_apply 需要 template 和 data 参数';
          let data: Array<Record<string, unknown>>;
          try { data = JSON.parse(dataRaw); } catch { return '❌ data 不是合法 JSON'; }

          const prompt = `你是一个邮件生成助手。请根据模板和数据，生成个性化邮件正文。

模板:
${template}

数据(JSON数组):
${JSON.stringify(data.slice(0, 10), null, 2)}

要求:
1. 用数据中的字段替换模板里的 {占位符}
2. 如果数据字段不足，用合理的默认值
3. 保持模板的语气和结构
4. 输出 JSON 数组，每项包含 to/subject/body 三个字段

输出:`;
          try {
            const result = await callLLM(prompt, '你是专业的邮件营销助手，擅长批量生成个性化邮件。');
            return `✉️ **模板应用完成**\n${'─'.repeat(50)}\n${result}`;
          } catch (err) {
            return `❌ LLM 调用失败: ${errMsg(err)}`;
          }
        }

        return '❌ action 必须是 draft_batch/classify/template_apply/merge_mail';
      } catch (err: unknown) {
        return `❌ 邮件批处理失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // B9. PDF 高级操作
  // ============================================================
  {
    name: 'pdf_advanced',
    description: 'PDF 高级操作。action: merge(合并)/encrypt(加密)/decrypt(解密)/rotate(旋转)/extract_pages(提取页面)/metadata(元信息)/add_text(添加文字)。',
    parameters: {
      action: { type: 'string', description: '操作: merge/encrypt/decrypt/rotate/extract_pages/metadata/add_text', required: true },
      input: { type: 'string', description: 'merge: JSON数组路径；其他: 单个PDF路径', required: false },
      output: { type: 'string', description: '输出PDF路径', required: false },
      password: { type: 'string', description: 'encrypt/decrypt: 密码', required: false },
      angle: { type: 'string', description: 'rotate: 90/180/270', required: false },
      pages: { type: 'string', description: 'extract_pages: 页码范围如 1-3,5,7-9', required: false },
      text: { type: 'string', description: 'add_text: 要添加的文字', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      try {
        // @ts-expect-error - pdf-lib 可能未安装
        const { PDFDocument, degrees, rgb, StandardFonts } = await import('pdf-lib');

        if (action === 'merge') {
          const inputRaw = (args.input as string) || '';
          if (!inputRaw) return '❌ merge 需要 input 参数(JSON数组)';
          let inputs: string[];
          try { inputs = JSON.parse(inputRaw); } catch { return '❌ input 不是合法 JSON 数组'; }
          if (!Array.isArray(inputs) || inputs.length < 2) return '❌ 至少需要2个PDF路径';
          for (const p of inputs) {
            const guard = guardSensitivePath(p);
            if (guard) return guard;
            if (!(await pathExists(p))) return `❌ 文件不存在: ${p}`;
          }
          const output = (args.output as string) || path.join(path.dirname(inputs[0]), `merged_${Date.now()}.pdf`);
          const outGuard = guardSensitivePath(output);
          if (outGuard) return outGuard;

          const merged = await PDFDocument.create();
          for (const p of inputs) {
            const bytes = await fs.promises.readFile(p);
            const doc = await PDFDocument.load(bytes);
            const pages = await merged.copyPages(doc, doc.getPageIndices());
            pages.forEach(pg => merged.addPage(pg));
          }
          const out = await merged.save();
          await fs.promises.writeFile(output, out);
          return `✅ 已合并 ${inputs.length} 个 PDF → ${output}`;
        }

        if (action === 'encrypt') {
          const input = (args.input as string) || '';
          const password = (args.password as string) || '';
          if (!input || !password) return '❌ encrypt 需要 input 和 password';
          const guard = guardSensitivePath(input);
          if (guard) return guard;
          if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
          const output = (args.output as string) || input.replace(/\.pdf$/i, '_encrypted.pdf');
          const outGuard = guardSensitivePath(output);
          if (outGuard) return outGuard;
          // pdf-lib 不直接支持加密，提示用外部工具
          return `⚠️ pdf-lib 不直接支持加密。请用以下方式之一:\n   1. PowerShell: 不直接支持，需安装 iText 或用 qpdf\n   2. qpdf: qpdf --encrypt "${password}" "${password}" 256 -- "${input}" "${output}"\n   3. 安装 qpdf 后重试\n   💡 输入: ${input}\n   输出: ${output}`;
        }

        if (action === 'decrypt') {
          return '⚠️ PDF 解密请用 qpdf --decrypt input.pdf output.pdf';
        }

        if (action === 'rotate') {
          const input = (args.input as string) || '';
          const angle = parseInt((args.angle as string) || '90', 10);
          if (!input) return '❌ rotate 需要 input';
          if (![90, 180, 270].includes(angle)) return '❌ angle 必须是 90/180/270';
          const guard = guardSensitivePath(input);
          if (guard) return guard;
          if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
          const output = (args.output as string) || input.replace(/\.pdf$/i, `_rotated${angle}.pdf`);
          const outGuard = guardSensitivePath(output);
          if (outGuard) return outGuard;

          const bytes = await fs.promises.readFile(input);
          const doc = await PDFDocument.load(bytes);
          const pages = doc.getPages();
          pages.forEach(pg => {
            const current = pg.getRotation().angle || 0;
            pg.setRotation(degrees((current + angle) % 360));
          });
          const out = await doc.save();
          await fs.promises.writeFile(output, out);
          return `✅ 已旋转所有页面 ${angle}° → ${output}`;
        }

        if (action === 'extract_pages') {
          const input = (args.input as string) || '';
          const pagesRaw = (args.pages as string) || '';
          if (!input || !pagesRaw) return '❌ extract_pages 需要 input 和 pages';
          const guard = guardSensitivePath(input);
          if (guard) return guard;
          if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
          const output = (args.output as string) || input.replace(/\.pdf$/i, '_extracted.pdf');
          const outGuard = guardSensitivePath(output);
          if (outGuard) return outGuard;

          // 解析页码范围 "1-3,5,7-9" → [0,1,2,4,6,7,8]
          const pageIndices: number[] = [];
          for (const part of pagesRaw.split(',')) {
            const trimmed = part.trim();
            if (trimmed.includes('-')) {
              const [s, e] = trimmed.split('-').map(n => parseInt(n.trim(), 10));
              for (let i = s; i <= e; i++) pageIndices.push(i - 1);
            } else {
              pageIndices.push(parseInt(trimmed, 10) - 1);
            }
          }

          const bytes = await fs.promises.readFile(input);
          const doc = await PDFDocument.load(bytes);
          const newDoc = await PDFDocument.create();
          const copied = await newDoc.copyPages(doc, pageIndices);
          copied.forEach(pg => newDoc.addPage(pg));
          const out = await newDoc.save();
          await fs.promises.writeFile(output, out);
          return `✅ 已提取 ${pageIndices.length} 页 → ${output}`;
        }

        if (action === 'metadata') {
          const input = (args.input as string) || '';
          if (!input) return '❌ metadata 需要 input';
          const guard = guardSensitivePath(input);
          if (guard) return guard;
          if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
          const bytes = await fs.promises.readFile(input);
          const doc = await PDFDocument.load(bytes);
          const meta = doc.getTitle() ? {
            title: doc.getTitle(), author: doc.getAuthor(), subject: doc.getSubject(),
            creator: doc.getCreator(), producer: doc.getProducer(),
            creationDate: doc.getCreationDate(), modDate: doc.getModificationDate(),
            pageCount: doc.getPageCount(),
          } : { pageCount: doc.getPageCount() };
          let report = `📄 **PDF 元信息** | ${path.basename(input)}\n${'─'.repeat(50)}\n`;
          report += `   页数: ${meta.pageCount}\n`;
          if (doc.getTitle()) report += `   标题: ${doc.getTitle()}\n`;
          if (doc.getAuthor()) report += `   作者: ${doc.getAuthor()}\n`;
          if (doc.getSubject()) report += `   主题: ${doc.getSubject()}\n`;
          if (doc.getCreator()) report += `   创建者: ${doc.getCreator()}\n`;
          if (doc.getProducer()) report += `   生成器: ${doc.getProducer()}\n`;
          if (doc.getCreationDate()) report += `   创建时间: ${doc.getCreationDate().toLocaleString('zh-CN')}\n`;
          if (doc.getModificationDate()) report += `   修改时间: ${doc.getModificationDate().toLocaleString('zh-CN')}\n`;
          const stat = await fs.promises.stat(input);
          report += `   文件大小: ${fmtBytes(stat.size)}`;
          return report;
        }

        if (action === 'add_text') {
          const input = (args.input as string) || '';
          const text = (args.text as string) || '';
          if (!input || !text) return '❌ add_text 需要 input 和 text';
          const guard = guardSensitivePath(input);
          if (guard) return guard;
          if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
          const output = (args.output as string) || input.replace(/\.pdf$/i, '_text.pdf');
          const outGuard = guardSensitivePath(output);
          if (outGuard) return outGuard;

          const bytes = await fs.promises.readFile(input);
          const doc = await PDFDocument.load(bytes);
          const font = await doc.embedFont(StandardFonts.HelveticaBold);
          const pages = doc.getPages();
          pages.forEach(pg => {
            const { width, height } = pg.getSize();
            const fontSize = 24;
            const textWidth = font.widthOfTextAtSize(text, fontSize);
            pg.drawText(text, {
              x: (width - textWidth) / 2,
              y: height - 50,
              size: fontSize,
              font,
              color: rgb(0.8, 0.2, 0.2),
              opacity: 0.6,
            });
          });
          const out = await doc.save();
          await fs.promises.writeFile(output, out);
          return `✅ 已在 ${pages.length} 页添加文字 "${text}" → ${output}`;
        }

        return '❌ action 必须是 merge/encrypt/decrypt/rotate/extract_pages/metadata/add_text';
      } catch (err) {
        if (String(err).includes('Cannot find module') || String(err).includes('pdf-lib')) {
          return `⚠️ 需要安装 pdf-lib: npm install pdf-lib\n失败: ${errMsg(err)}`;
        }
        return `❌ PDF 操作失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // B10. 笔记/知识管理
  // ============================================================
  {
    name: 'note_manage',
    description: '笔记与知识管理。支持 Markdown 笔记、标签、双链、全文搜索。action: create(创建)/list(列表)/read(读取)/search(搜索)/tag(按标签)/link(双链)/recent(最近)/delete(删除)。',
    parameters: {
      action: { type: 'string', description: '操作: create/list/read/search/tag/link/recent/delete', required: true },
      title: { type: 'string', description: 'create: 标题', required: false },
      content: { type: 'string', description: 'create: 正文(Markdown)', required: false },
      tags: { type: 'string', description: 'create: 标签(逗号分隔)', required: false },
      id: { type: 'string', description: 'read/delete: 笔记ID', required: false },
      keyword: { type: 'string', description: 'search: 搜索关键词', required: false },
      tag: { type: 'string', description: 'tag: 标签名', required: false },
      limit: { type: 'string', description: 'list/recent: 返回条数(默认20)', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const notesDir = await ensureDataDir('notes');
      const indexFile = path.join(notesDir, '_index.json');

      type Note = { id: string; title: string; tags: string[]; file: string; createdAt: number; updatedAt: number; links: string[] };
      const readIndex = (): Promise<Note[]> => readJson<Note[]>(indexFile, []);
      const writeIndex = (n: Note[]) => writeJson(indexFile, n);

      try {
        if (action === 'create') {
          const title = (args.title as string) || '';
          const content = (args.content as string) || '';
          if (!title) return '❌ create 需要 title';
          const tags = (args.tags as string) ? (args.tags as string).split(',').map(s => s.trim()).filter(Boolean) : [];
          const id = `note_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const file = path.join(notesDir, `${id}.md`);
          const now = Date.now();
          // 提取双链 [[xxx]]
          const links = (content.match(/\[\[([^\]]+)\]\]/g) || []).map(m => m.slice(2, -2));
          const md = `# ${title}\n\n${content}\n\n---\n创建: ${new Date(now).toLocaleString('zh-CN')}\n标签: ${tags.join(', ') || '无'}\n`;
          await fs.promises.writeFile(file, md, 'utf-8');
          const note: Note = { id, title, tags, file, createdAt: now, updatedAt: now, links };
          const idx = await readIndex();
          idx.push(note);
          await writeIndex(idx);
          return `✅ 笔记已创建: ${id}\n   📝 ${title}\n   🏷️ ${tags.join(', ') || '无标签'}\n   🔗 双链: ${links.length} 个\n   📂 ${file}`;
        }

        if (action === 'list' || action === 'recent') {
          const idx = await readIndex();
          if (idx.length === 0) return '📭 笔记库为空（请用 action=create 创建）';
          const limit = parseInt((args.limit as string) || '20', 10);
          const sorted = idx.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
          let report = `📝 **${action === 'recent' ? '最近笔记' : '笔记列表'}** (${sorted.length}/${idx.length})\n${'─'.repeat(50)}\n`;
          report += sorted.map((n, i) => {
            const date = new Date(n.updatedAt).toLocaleDateString('zh-CN');
            return `   [${i + 1}] ${n.title}\n       🏷️ ${n.tags.join('/') || '无'} | 🔗 ${n.links.length} | ${date} | ${n.id}`;
          }).join('\n');
          return report;
        }

        if (action === 'read') {
          const id = (args.id as string) || '';
          if (!id) return '❌ read 需要 id 参数';
          const idx = await readIndex();
          const note = idx.find(n => n.id === id);
          if (!note) return `❌ 未找到笔记 ${id}`;
          try {
            const content = await fs.promises.readFile(note.file, 'utf-8');
            return `📄 **${note.title}** | ${note.id}\n${'─'.repeat(50)}\n${content}`;
          } catch {
            return `❌ 笔记文件丢失: ${note.file}`;
          }
        }

        if (action === 'search') {
          const keyword = (args.keyword as string) || '';
          if (!keyword) return '❌ search 需要 keyword 参数';
          const idx = await readIndex();
          const matches: Array<{ note: Note; preview: string }> = [];
          for (const note of idx) {
            try {
              const content = await fs.promises.readFile(note.file, 'utf-8');
              const lower = content.toLowerCase();
              const kw = keyword.toLowerCase();
              if (lower.includes(kw) || note.title.toLowerCase().includes(kw)) {
                const pos = lower.indexOf(kw);
                const start = Math.max(0, pos - 30);
                const preview = content.substring(start, pos + keyword.length + 50).replace(/\n/g, ' ');
                matches.push({ note, preview: `...${preview}...` });
              }
            } catch { /* 忽略丢失文件 */ }
          }
          if (matches.length === 0) return `🔍 未找到包含 "${keyword}" 的笔记`;
          let report = `🔍 **搜索结果** "${keyword}" (${matches.length} 条)\n${'─'.repeat(50)}\n`;
          report += matches.slice(0, 20).map((m, i) =>
            `   [${i + 1}] ${m.note.title}\n       ${m.preview}\n       🏷️ ${m.note.tags.join('/') || '无'} | ${m.note.id}`
          ).join('\n');
          return report;
        }

        if (action === 'tag') {
          const tag = (args.tag as string) || '';
          if (!tag) return '❌ tag 需要 tag 参数';
          const idx = await readIndex();
          const matches = idx.filter(n => n.tags.includes(tag));
          if (matches.length === 0) return `🏷️ 没有标签为 "${tag}" 的笔记`;
          let report = `🏷️ **标签 "${tag}"** (${matches.length} 条)\n${'─'.repeat(50)}\n`;
          report += matches.map((n, i) => `   [${i + 1}] ${n.title} | ${new Date(n.updatedAt).toLocaleDateString('zh-CN')} | ${n.id}`).join('\n');
          return report;
        }

        if (action === 'link') {
          // 查看双链关系图
          const idx = await readIndex();
          if (idx.length === 0) return '📭 笔记库为空';
          let report = `🔗 **双链关系图**\n${'─'.repeat(50)}\n`;
          let hasLinks = false;
          for (const note of idx) {
            if (note.links.length === 0) continue;
            hasLinks = true;
            // 找到被引用的笔记
            const targets = note.links.map(l => {
              const found = idx.find(n => n.title === l || n.id === l);
              return found ? `✅ ${l}` : `❓ ${l}(未找到)`;
            });
            report += `   📝 ${note.title}\n       → ${targets.join('\n       → ')}\n`;
          }
          if (!hasLinks) report += '   暂无双链。在笔记中用 [[标题]] 创建双链。';
          return report;
        }

        if (action === 'delete') {
          const id = (args.id as string) || '';
          if (!id) return '❌ delete 需要 id 参数';
          const idx = await readIndex();
          const i = idx.findIndex(n => n.id === id);
          if (i < 0) return `❌ 未找到笔记 ${id}`;
          const note = idx[i];
          try { await fs.promises.unlink(note.file); } catch { /* 忽略 */ }
          idx.splice(i, 1);
          await writeIndex(idx);
          return `✅ 已删除笔记: ${note.title}`;
        }

        return '❌ action 必须是 create/list/read/search/tag/link/recent/delete';
      } catch (err: unknown) {
        return `❌ 笔记操作失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // B11. 看板管理
  // ============================================================
  {
    name: 'kanban_board',
    description: '看板(Kanban)管理。支持多看板、列、卡片、泳道、状态流转。action: create_board/list_boards/view/add_column/add_card/move_card/archive_card/delete_board。',
    parameters: {
      action: { type: 'string', description: '操作: create_board/list_boards/view/add_column/add_card/move_card/archive_card/delete_board', required: true },
      boardId: { type: 'string', description: '看板ID(view/add_column/add_card/move_card)', required: false },
      title: { type: 'string', description: 'create_board: 看板名；add_column: 列名；add_card: 卡片标题', required: false },
      columnId: { type: 'string', description: 'add_card/move_card: 列ID', required: false },
      cardId: { type: 'string', description: 'move_card/archive_card: 卡片ID', required: false },
      description: { type: 'string', description: 'add_card: 卡片描述', required: false },
      assignee: { type: 'string', description: 'add_card: 负责人', required: false },
      priority: { type: 'string', description: 'add_card: low/medium/high/urgent', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const kanbanFile = path.join(os.homedir(), '.duan', 'kanban.json');

      type Card = { id: string; title: string; description?: string; assignee?: string; priority: string; createdAt: number; order: number };
      type Column = { id: string; name: string; cards: Card[] };
      type Board = { id: string; name: string; columns: Column[]; createdAt: number; archived: Card[] };
      const readBoards = (): Promise<Board[]> => readJson<Board[]>(kanbanFile, []);
      const writeBoards = (b: Board[]) => writeJson(kanbanFile, b);

      const priorityIconMap: Record<string, string> = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };

      try {
        if (action === 'create_board') {
          const name = (args.title as string) || '';
          if (!name) return '❌ create_board 需要 title(看板名)';
          const boards = await readBoards();
          const board: Board = {
            id: `board_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name, columns: [], createdAt: Date.now(), archived: [],
          };
          boards.push(board);
          await writeBoards(boards);
          return `✅ 看板已创建: ${board.id}\n   📋 ${name}\n   💡 用 action=add_column 添加列`;
        }

        if (action === 'list_boards') {
          const boards = await readBoards();
          if (boards.length === 0) return '📭 暂无看板（请用 action=create_board 创建）';
          let report = `📋 **看板列表** (${boards.length} 个)\n${'─'.repeat(50)}\n`;
          report += boards.map((b, i) => {
            const totalCards = b.columns.reduce((s, c) => s + c.cards.length, 0);
            return `   [${i + 1}] ${b.name}\n       列: ${b.columns.length} | 卡片: ${totalCards} | 归档: ${b.archived.length} | ${b.id}`;
          }).join('\n');
          return report;
        }

        if (action === 'view') {
          const boardId = (args.boardId as string) || '';
          if (!boardId) return '❌ view 需要 boardId';
          const boards = await readBoards();
          const board = boards.find(b => b.id === boardId);
          if (!board) return `❌ 未找到看板 ${boardId}`;
          let report = `📋 **${board.name}** | ${board.id}\n${'─'.repeat(50)}\n`;
          if (board.columns.length === 0) {
            report += '📭 暂无列，请用 action=add_column 添加';
            return report;
          }
          for (const col of board.columns) {
            report += `\n📌 ${col.name} (${col.cards.length})\n`;
            if (col.cards.length === 0) {
              report += '   (空)\n';
              continue;
            }
            report += col.cards.sort((a, b) => a.order - b.order).map(c => {
              const icon = priorityIconMap[c.priority] || '⚪';
              const assignee = c.assignee ? ` @${c.assignee}` : '';
              return `   ${icon} ${c.title}${assignee} [${c.id.substring(0, 12)}]`;
            }).join('\n');
          }
          return report;
        }

        if (action === 'add_column') {
          const boardId = (args.boardId as string) || '';
          const name = (args.title as string) || '';
          if (!boardId || !name) return '❌ add_column 需要 boardId 和 title';
          const boards = await readBoards();
          const board = boards.find(b => b.id === boardId);
          if (!board) return `❌ 未找到看板 ${boardId}`;
          const col: Column = { id: `col_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, name, cards: [] };
          board.columns.push(col);
          await writeBoards(boards);
          return `✅ 列已添加: ${col.id}\n   📌 ${name} → 看板 ${board.name}`;
        }

        if (action === 'add_card') {
          const boardId = (args.boardId as string) || '';
          const columnId = (args.columnId as string) || '';
          const title = (args.title as string) || '';
          if (!boardId || !columnId || !title) return '❌ add_card 需要 boardId/columnId/title';
          const boards = await readBoards();
          const board = boards.find(b => b.id === boardId);
          if (!board) return `❌ 未找到看板 ${boardId}`;
          const col = board.columns.find(c => c.id === columnId);
          if (!col) return `❌ 未找到列 ${columnId}`;
          const priority = (args.priority as string) || 'medium';
          if (!['low', 'medium', 'high', 'urgent'].includes(priority)) return '❌ priority 必须是 low/medium/high/urgent';
          const card: Card = {
            id: `card_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            title,
            description: args.description as string,
            assignee: args.assignee as string,
            priority,
            createdAt: Date.now(),
            order: col.cards.length,
          };
          col.cards.push(card);
          await writeBoards(boards);
          return `✅ 卡片已添加: ${card.id}\n   ${priorityIconMap[priority]} ${title}\n   📌 ${col.name} → ${board.name}`;
        }

        if (action === 'move_card') {
          const boardId = (args.boardId as string) || '';
          const cardId = (args.cardId as string) || '';
          const targetColId = (args.columnId as string) || '';
          if (!boardId || !cardId || !targetColId) return '❌ move_card 需要 boardId/cardId/columnId(目标列)';
          const boards = await readBoards();
          const board = boards.find(b => b.id === boardId);
          if (!board) return `❌ 未找到看板 ${boardId}`;
          const targetCol = board.columns.find(c => c.id === targetColId);
          if (!targetCol) return `❌ 未找到目标列 ${targetColId}`;
          let moved: Card | null = null;
          for (const col of board.columns) {
            const i = col.cards.findIndex(c => c.id === cardId);
            if (i >= 0) {
              moved = col.cards.splice(i, 1)[0];
              break;
            }
          }
          if (!moved) return `❌ 未找到卡片 ${cardId}`;
          moved.order = targetCol.cards.length;
          targetCol.cards.push(moved);
          await writeBoards(boards);
          return `✅ 卡片已移动: ${moved.title}\n   → ${targetCol.name}`;
        }

        if (action === 'archive_card') {
          const boardId = (args.boardId as string) || '';
          const cardId = (args.cardId as string) || '';
          if (!boardId || !cardId) return '❌ archive_card 需要 boardId/cardId';
          const boards = await readBoards();
          const board = boards.find(b => b.id === boardId);
          if (!board) return `❌ 未找到看板 ${boardId}`;
          let archived: Card | null = null;
          for (const col of board.columns) {
            const i = col.cards.findIndex(c => c.id === cardId);
            if (i >= 0) {
              archived = col.cards.splice(i, 1)[0];
              break;
            }
          }
          if (!archived) return `❌ 未找到卡片 ${cardId}`;
          board.archived.push(archived);
          await writeBoards(boards);
          return `✅ 卡片已归档: ${archived.title}`;
        }

        if (action === 'delete_board') {
          const boardId = (args.boardId as string) || '';
          if (!boardId) return '❌ delete_board 需要 boardId';
          const boards = await readBoards();
          const i = boards.findIndex(b => b.id === boardId);
          if (i < 0) return `❌ 未找到看板 ${boardId}`;
          const removed = boards.splice(i, 1)[0];
          await writeBoards(boards);
          return `✅ 看板已删除: ${removed.name}`;
        }

        return '❌ action 必须是 create_board/list_boards/view/add_column/add_card/move_card/archive_card/delete_board';
      } catch (err: unknown) {
        return `❌ 看板操作失败: ${errMsg(err)}`;
      }
    },
  },

  // ============================================================
  // B12. 工作流自动化
  // ============================================================
  {
    name: 'automation_workflow',
    description: '工作流自动化。编排定时任务、触发器和动作链。action: create(创建工作流)/list(列表)/view(查看)/run(手动运行)/enable(启用)/disable(禁用)/delete(删除)/history(历史)。',
    parameters: {
      action: { type: 'string', description: '操作: create/list/view/run/enable/disable/delete/history', required: true },
      name: { type: 'string', description: 'create: 工作流名称', required: false },
      trigger: { type: 'string', description: 'create: 触发器 JSON(schedule/time/event)，如 {"type":"schedule","cron":"0 9 * * *"}', required: false },
      actions: { type: 'string', description: 'create: 动作链 JSON 数组(按顺序执行)', required: false },
      id: { type: 'string', description: 'view/run/enable/disable/delete/history: 工作流ID', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const wfFile = path.join(os.homedir(), '.duan', 'workflows.json');
      const histDir = await ensureDataDir('workflow-history');

      type WfAction = { tool: string; params: Record<string, unknown>; description?: string };
      type Workflow = {
        id: string; name: string; trigger: { type: string; cron?: string; event?: string };
        actions: WfAction[]; enabled: boolean; createdAt: number; lastRun: number; runCount: number;
      };
      const readWfs = (): Promise<Workflow[]> => readJson<Workflow[]>(wfFile, []);
      const writeWfs = (w: Workflow[]) => writeJson(wfFile, w);

      try {
        if (action === 'create') {
          const name = (args.name as string) || '';
          const triggerRaw = (args.trigger as string) || '';
          const actionsRaw = (args.actions as string) || '';
          if (!name || !triggerRaw || !actionsRaw) return '❌ create 需要 name/trigger/actions';
          let trigger: Workflow['trigger'];
          let actions: WfAction[];
          try { trigger = JSON.parse(triggerRaw); actions = JSON.parse(actionsRaw); } catch { return '❌ trigger/actions 不是合法 JSON'; }
          if (!Array.isArray(actions) || actions.length === 0) return '❌ actions 必须是非空数组';

          const wfs = await readWfs();
          const wf: Workflow = {
            id: `wf_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name, trigger, actions, enabled: true,
            createdAt: Date.now(), lastRun: 0, runCount: 0,
          };
          wfs.push(wf);
          await writeWfs(wfs);
          let report = `✅ 工作流已创建: ${wf.id}\n   🔄 ${name}\n   📌 触发器: ${trigger.type}${trigger.cron ? ` (${trigger.cron})` : ''}${trigger.event ? ` (${trigger.event})` : ''}\n   🎬 动作链 (${actions.length} 步):`;
          report += actions.map((a, i) => `\n      ${i + 1}. ${a.tool}${a.description ? ` - ${a.description}` : ''}`).join('');
          report += `\n\n   ⚠️ 说明: 定时触发需外部调度器(cron/node-schedule)读取此配置执行。手动运行用 action=run。`;
          return report;
        }

        if (action === 'list') {
          const wfs = await readWfs();
          if (wfs.length === 0) return '📭 暂无工作流（请用 action=create 创建）';
          let report = `🔄 **工作流列表** (${wfs.length} 个)\n${'─'.repeat(50)}\n`;
          report += wfs.map((w, i) => {
            const status = w.enabled ? '✅启用' : '⏸️禁用';
            const last = w.lastRun ? new Date(w.lastRun).toLocaleString('zh-CN') : '从未运行';
            return `   [${i + 1}] ${status} ${w.name}\n       触发: ${w.trigger.type}${w.trigger.cron || ''} | 动作: ${w.actions.length}步 | 运行: ${w.runCount}次 | 最后: ${last}\n       ${w.id}`;
          }).join('\n');
          return report;
        }

        if (action === 'view') {
          const id = (args.id as string) || '';
          if (!id) return '❌ view 需要 id';
          const wfs = await readWfs();
          const wf = wfs.find(w => w.id === id);
          if (!wf) return `❌ 未找到工作流 ${id}`;
          let report = `🔄 **${wf.name}** | ${wf.id}\n${'─'.repeat(50)}\n`;
          report += `   状态: ${wf.enabled ? '✅启用' : '⏸️禁用'}\n`;
          report += `   触发器: ${wf.trigger.type}${wf.trigger.cron ? ` (cron: ${wf.trigger.cron})` : ''}${wf.trigger.event ? ` (event: ${wf.trigger.event})` : ''}\n`;
          report += `   创建: ${new Date(wf.createdAt).toLocaleString('zh-CN')}\n`;
          report += `   运行次数: ${wf.runCount} | 最后运行: ${wf.lastRun ? new Date(wf.lastRun).toLocaleString('zh-CN') : '从未'}\n\n`;
          report += `🎬 **动作链** (${wf.actions.length} 步):`;
          report += wf.actions.map((a, i) => `\n   ${i + 1}. 🔧 ${a.tool}\n      ${a.description || ''}\n      参数: ${JSON.stringify(a.params).substring(0, 100)}`).join('');
          return report;
        }

        if (action === 'run') {
          const id = (args.id as string) || '';
          if (!id) return '❌ run 需要 id';
          const wfs = await readWfs();
          const wf = wfs.find(w => w.id === id);
          if (!wf) return `❌ 未找到工作流 ${id}`;
          // 记录本次运行的每步结果
          const results: Array<{ step: number; tool: string; status: string; output?: string }> = [];
          let allOk = true;
          for (let i = 0; i < wf.actions.length; i++) {
            const a = wf.actions[i];
            try {
              // 尝试通过 toolContext 找到工具并执行
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const registry = (toolContext as any).toolRegistry || (toolContext as any).orchestrator;
              let output = '(工具未注册，仅记录)';
              if (registry && typeof registry.executeTool === 'function') {
                const res = await registry.executeTool(a.tool, a.params);
                output = typeof res === 'string' ? res : JSON.stringify(res);
              } else {
                // 回退：尝试动态导入工具模块
                try {
                  const mod = await import('./index.js');
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const tool = (mod as any).allBuiltInTools.find((t: { name: string }) => t.name === a.tool);
                  if (tool && tool.execute) {
                    output = await tool.execute(a.params);
                  }
                } catch { /* 保持默认 output */ }
              }
              results.push({ step: i + 1, tool: a.tool, status: '✅', output: typeof output === 'string' ? output.substring(0, 200) : String(output) });
            } catch (err) {
              allOk = false;
              results.push({ step: i + 1, tool: a.tool, status: '❌', output: errMsg(err) });
              break; // 失败则停止后续步骤
            }
          }
          wf.runCount++;
          wf.lastRun = Date.now();
          await writeWfs(wfs);
          // 记录历史
          const histFile = path.join(histDir, `${wf.id}_${Date.now()}.json`);
          await writeJson(histFile, { workflowId: wf.id, name: wf.name, runAt: Date.now(), success: allOk, results });

          let report = `${allOk ? '✅' : '⚠️'} **工作流执行${allOk ? '完成' : '部分失败'}**: ${wf.name}\n${'─'.repeat(50)}\n`;
          report += results.map(r => `   ${r.status} 步骤${r.step}: ${r.tool}${r.output ? '\n      → ' + r.output.substring(0, 150) : ''}`).join('\n');
          report += `\n\n   运行次数: ${wf.runCount} | 历史: ${histFile}`;
          return report;
        }

        if (action === 'enable' || action === 'disable') {
          const id = (args.id as string) || '';
          if (!id) return `❌ ${action} 需要 id`;
          const wfs = await readWfs();
          const wf = wfs.find(w => w.id === id);
          if (!wf) return `❌ 未找到工作流 ${id}`;
          wf.enabled = action === 'enable';
          await writeWfs(wfs);
          return `✅ 工作流已${action === 'enable' ? '启用' : '禁用'}: ${wf.name}`;
        }

        if (action === 'delete') {
          const id = (args.id as string) || '';
          if (!id) return '❌ delete 需要 id';
          const wfs = await readWfs();
          const i = wfs.findIndex(w => w.id === id);
          if (i < 0) return `❌ 未找到工作流 ${id}`;
          const removed = wfs.splice(i, 1)[0];
          await writeWfs(wfs);
          return `✅ 工作流已删除: ${removed.name}`;
        }

        if (action === 'history') {
          const id = (args.id as string) || '';
          if (!id) return '❌ history 需要 id';
          const files = await fs.promises.readdir(histDir);
          const histFiles = files.filter(f => f.startsWith(id)).sort().reverse().slice(0, 10);
          if (histFiles.length === 0) return `📭 工作流 ${id} 无运行历史`;
          let report = `📜 **运行历史** (最近 ${histFiles.length} 次)\n${'─'.repeat(50)}\n`;
          for (const f of histFiles) {
            const data = await readJson<{ name: string; runAt: number; success: boolean; results: Array<{ step: number; tool: string; status: string }> }>(path.join(histDir, f), { name: '', runAt: 0, success: false, results: [] });
            const status = data.success ? '✅' : '⚠️';
            report += `   ${status} ${new Date(data.runAt).toLocaleString('zh-CN')} | ${data.results.length}步\n`;
          }
          return report;
        }

        return '❌ action 必须是 create/list/view/run/enable/disable/delete/history';
      } catch (err: unknown) {
        return `❌ 工作流操作失败: ${errMsg(err)}`;
      }
    },
  },
];
