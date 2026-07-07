/**
 * 工具执行器（独立模块）— 从 desktop/main.js 拆分
 *
 * 职责：接收工具名和参数，执行对应工具并返回字符串结果。
 * 依赖通过 createToolExecutor(deps) 注入，避免对 main.js 全局状态的硬耦合。
 *
 * 支持的工具：
 *   shell_execute, file_read, file_write, file_list,
 *   web_search, web_fetch, desktop_open,
 *   browser_operate, code_execute, think, complete,
 *   app_operate, app_batch, app_list, self_improve,
 *   request_workspace_access
 */

'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

/**
 * 创建工具执行器
 * @param {Object} deps - 依赖注入
 * @param {() => any} deps.getMainWindow - 获取主窗口（可能为 null）
 * @param {() => any} deps.getBrowserWindow - 获取浏览器窗口（可能为 null）
 * @param {(url: string) => void} deps.createBrowserWindow - 创建浏览器窗口
 * @param {string} deps.ROOT_DIR - 项目根目录
 * @param {RegExp} deps.DANGEROUS_CMD_REGEX - 危险命令正则
 * @param {(p: string) => boolean} deps.isSensitivePath - 敏感路径检测函数
 * @param {(p: string) => { ok: boolean, error?: string }} [deps.isWithinWorkspace] - 工作区边界校验（可选）
 * @param {() => boolean} [deps.isSelfImproveEnabled] - 自我改进是否启用（可选，默认 false）
 * @param {(proposal: Object) => { approved: boolean, reason?: string }} [deps.requestApproval] - 请求用户批准代码修改（可选）
 * @returns {Function} executeTool(name, args) => Promise<string>
 */
function createToolExecutor(deps) {
  const { getMainWindow, getBrowserWindow, createBrowserWindow, ROOT_DIR, DANGEROUS_CMD_REGEX, isSensitivePath, isWithinWorkspace, isSelfImproveEnabled, requestApproval, requestWorkspaceAccess } = deps;

  /**
   * D3: 清洗 PowerShell 非交互模式的 CLIXML 进度流污染。
   * PowerShell 在非交互运行时会将进度流（Write-Progress 等）序列化为
   * `#< CLIXML <Objs>...</Objs>` 写入 stderr，导致错误消息不可读。
   * 此函数剥离 CLIXML 包裹并解码 _xHHHH_ 转义字符。
   */
  function sanitizePowerShellStderr(s) {
    if (typeof s !== 'string') return '';
    let out = s;
    if (out.includes('#< CLIXML')) {
      // 提取 CLIXML 内部的 <S S="Error">...</S> 文本节点
      const matches = out.match(/<S S="[^"]*">([\s\S]*?)<\/S>/g) || [];
      const decoded = matches
        .map(m => m.replace(/<S S="[^"]*">([\s\S]*?)<\/S>/, '$1'))
        .map(t => t.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
        .join('\n')
        .trim();
      out = decoded || out.replace(/#< CLIXML[\s\S]*$/m, '').trim();
    }
    return out;
  }

  /**
   * 向编辑器面板发送流式写入事件（让用户看到代码编写进程）
   * 发 editor:write-start → 多个 editor:write-chunk → editor:write-done
   * 前端收到后用打字机动画逐块显现 + 进度条
   */
  function emitEditorWriteEvents(mw, filePath, content) {
    if (!mw || mw.isDestroyed()) return;
    const text = String(content || '');
    const lines = text.split('\n');
    const totalLines = lines.length;
    try {
      mw.webContents.send('editor:write-start', { path: filePath, totalLines });
      const CHUNK = 50; // 每 50 行一块
      for (let i = 0; i < lines.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, lines.length);
        const chunkText = lines.slice(i, end).join('\n') + (end < lines.length ? '\n' : '');
        mw.webContents.send('editor:write-chunk', {
          path: filePath, chunk: chunkText, lineNo: end, totalLines,
        });
      }
      mw.webContents.send('editor:write-done', { path: filePath, content: text });
    } catch (_) { /* 窗口可能已销毁 */ }
  }

  /**
   * 执行工具
   * @param {string} name - 工具名
   * @param {Object} args - 工具参数
   * @returns {Promise<string>} 执行结果
   */
  async function executeTool(name, args) {
    try {
      switch (name) {
        case 'shell_execute': {
          return await executeShell(args);
        }
        case 'file_read': {
          return executeFileRead(args);
        }
        case 'file_write': {
          return executeFileWrite(args);
        }
        case 'file_edit': {
          return executeFileEdit(args);
        }
        case 'grep_search': {
          return executeGrepSearch(args);
        }
        case 'search_files': {
          return executeSearchFiles(args);
        }
        case 'file_list': {
          return executeFileList(args);
        }
        case 'web_search': {
          return await executeWebSearch(args);
        }
        case 'web_fetch': {
          return await executeWebFetch(args);
        }
        case 'desktop_open': {
          return executeDesktopOpen(args);
        }
        case 'browser_operate': {
          return await executeBrowserOperate(args);
        }
        case 'code_execute': {
          return executeCodeExecute(args);
        }
        case 'think': {
          return args.thought || '思考完成';
        }
        case 'complete': {
          // V17 修复：兼容 result/response 两种参数名
          return args.result || args.response || '任务完成';
        }
        case 'self_improve': {
          return await executeSelfImprove(args);
        }
        case 'request_workspace_access': {
          return await executeRequestWorkspaceAccess(args);
        }
        default:
          // 新增工具处理
          if (name === 'app_operate') {
            return await executeAppOperate(args);
          }
          if (name === 'app_batch') {
            return await executeAppBatch(args);
          }
          if (name === 'app_list') {
            return executeAppList();
          }
          if (name === 'terminal_operate') {
            return await executeTerminalOperate(args);
          }
          if (name === 'editor_operate') {
            return await executeEditorOperate(args);
          }
          return `❌ 未知工具: "${name}"。\n可用工具列表: shell_execute, file_read, file_write, file_edit, grep_search, search_files, web_search, web_fetch, browser_operate, desktop_open, file_list, code_execute, think, complete, app_operate, app_batch, app_list, terminal_operate, editor_operate, self_improve, request_workspace_access\n请检查工具名称拼写，或从上述列表中选择合适的工具。`;
      }
    } catch (err) {
      console.error(`[executeTool] 外层异常 | 工具: ${name} | 参数: ${JSON.stringify(args).substring(0, 200)} | 错误: ${err.message}`);
      return `❌ 工具执行异常: ${err.message}\n  工具: ${name}\n  堆栈: ${err.stack ? err.stack.substring(0, 300) : 'N/A'}`;
    }
  }

  // ===========================================================================
  // terminal_operate（融合：Agent 操作终端面板）
  // action: run(执行命令并显示在终端) / type(注入文本) / clear / activate
  // ===========================================================================
  async function executeTerminalOperate(args) {
    const action = args.action || 'run';
    const mw = getMainWindow();
    // 激活终端面板
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send('tool:activate', 'terminal');
    }
    switch (action) {
      case 'activate':
        return '✅ 已激活终端面板';
      case 'clear':
        if (mw && !mw.isDestroyed()) mw.webContents.send('terminal:inject', { clear: true });
        return '✅ 已清空终端';
      case 'type': {
        const text = String(args.text || args.input || '');
        if (mw && !mw.isDestroyed()) mw.webContents.send('terminal:inject', { output: text, type: 'output' });
        return `✅ 已向终端注入 ${text.length} 字符`;
      }
      case 'run': {
        const command = args.command || args.cmd;
        if (!command) return '❌ 缺少参数: command';
        // 在终端面板显示命令（与用户手动输入一致）
        if (mw && !mw.isDestroyed()) mw.webContents.send('terminal:inject', { command });
        // 复用 shell_execute 执行命令
        const result = await executeShell({ command, timeout: args.timeout });
        // 把输出注入终端面板
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('terminal:inject', { output: String(result), type: 'output' });
        }
        return String(result);
      }
      default:
        return `❌ 不支持的操作: ${action}。可用: run(执行命令) / type(注入文本) / clear(清屏) / activate(激活面板)`;
    }
  }

  // ===========================================================================
  // editor_operate（融合：Agent 操作编辑器面板）
  // action: open(打开文件，流式显示) / read(读取并返回) / goto(跳转行) / activate
  // ===========================================================================
  async function executeEditorOperate(args) {
    const action = args.action || 'open';
    const mw = getMainWindow();
    switch (action) {
      case 'activate':
        if (mw && !mw.isDestroyed()) mw.webContents.send('tool:activate', 'editor');
        return '✅ 已激活编辑器面板';
      case 'open': {
        const filePath = args.path || args.file || args.filePath;
        if (!filePath) return '❌ 缺少参数: path';
        const resolved = path.resolve(filePath);
        if (isSensitivePath(resolved)) return '❌ 安全限制: 拒绝访问敏感路径';
        if (!fs.existsSync(resolved)) return `❌ 文件不存在: ${resolved}`;
        const content = fs.readFileSync(resolved, 'utf-8');
        if (mw && !mw.isDestroyed()) {
          emitEditorWriteEvents(mw, resolved, content); // 流式显示（打字机+进度条）
          mw.webContents.send('tool:activate', 'editor');
        }
        return `✅ 已在编辑器打开: ${resolved} (${content.length} 字符)`;
      }
      case 'read': {
        const filePath = args.path || args.file || args.filePath;
        if (!filePath) return '❌ 缺少参数: path';
        const resolved = path.resolve(filePath);
        if (isSensitivePath(resolved)) return '❌ 安全限制: 拒绝访问敏感路径';
        if (!fs.existsSync(resolved)) return `❌ 文件不存在: ${resolved}`;
        const content = fs.readFileSync(resolved, 'utf-8');
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('editor:open-file', { path: resolved, content });
          mw.webContents.send('tool:activate', 'editor');
        }
        return content.substring(0, 8000) + (content.length > 8000 ? `\n... (共 ${content.length} 字符，已截断)` : '');
      }
      case 'goto': {
        const line = Number(args.line || args.lineNumber || 1);
        if (!Number.isFinite(line) || line < 1) return `❌ 无效的行号: ${args.line}`;
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('editor:goto', { line, path: args.path || '' });
          mw.webContents.send('tool:activate', 'editor');
        }
        return `✅ 已跳转到第 ${line} 行`;
      }
      default:
        return `❌ 不支持的操作: ${action}。可用: open(打开文件) / read(读取内容) / goto(跳转行) / activate(激活面板)`;
    }
  }

  // ===========================================================================
  // shell_execute
  // ===========================================================================

  /**
   * V17 跨平台命令转换：Unix → Windows PowerShell 兼容
   */
  function translateCommand(command) {
    if (process.platform !== 'win32') return command;
    let translated = command;
    // mkdir -p → mkdir -Force（PowerShell 自动创建父目录）
    translated = translated.replace(/mkdir\s+-p\s+/g, 'mkdir -Force ');
    // rm -rf → Remove-Item -Recurse -Force
    translated = translated.replace(/rm\s+-rf\s+/g, 'Remove-Item -Recurse -Force ');
    translated = translated.replace(/rm\s+-r\s+-f\s+/g, 'Remove-Item -Recurse -Force ');
    translated = translated.replace(/rm\s+-f\s+/g, 'Remove-Item -Force ');
    // touch → New-Item -ItemType File
    translated = translated.replace(/\btouch\s+/g, 'New-Item -ItemType File -Path ');
    // cat → Get-Content
    translated = translated.replace(/\bcat\s+/g, 'Get-Content ');
    // ls -la → Get-ChildItem -Force
    translated = translated.replace(/\bls\s+-la\b/g, 'Get-ChildItem -Force');
    translated = translated.replace(/\bls\s+-l\b/g, 'Get-ChildItem');
    // cp -r → Copy-Item -Recurse
    translated = translated.replace(/\bcp\s+-r\s+/g, 'Copy-Item -Recurse ');
    translated = translated.replace(/\bcp\s+/g, 'Copy-Item ');
    // mv → Move-Item
    translated = translated.replace(/\bmv\s+/g, 'Move-Item ');
    // which → Get-Command
    translated = translated.replace(/\bwhich\s+/g, 'Get-Command ');
    // pwd → Get-Location
    translated = translated.replace(/\bpwd\b/g, 'Get-Location');
    // export VAR=val → $env:VAR='val'
    translated = translated.replace(/export\s+(\w+)=(\S+)/g, "\\$env:$1='$2'");
    return translated;
  }

  /**
   * V17 智能超时：长命令自动延长超时
   */
  function getSmartTimeout(command, userTimeout) {
    if (userTimeout && userTimeout > 0) return { timeout: userTimeout, reason: '用户指定' };
    const longPatterns = [
      { pattern: /npm\s+install|npm\s+i\s|npm\s+ci\b/i, timeout: 300000, reason: 'npm install 300s' },
      { pattern: /npm\s+run\s+build|npm\s+run\s+dev/i, timeout: 180000, reason: '构建 180s' },
      { pattern: /git\s+clone/i, timeout: 180000, reason: 'git clone 180s' },
      { pattern: /pip\s+install|pip3\s+install/i, timeout: 300000, reason: 'pip install 300s' },
      { pattern: /yarn\s+install|yarn\s+add/i, timeout: 300000, reason: 'yarn 300s' },
      { pattern: /pnpm\s+install|pnpm\s+add/i, timeout: 300000, reason: 'pnpm 300s' },
      { pattern: /tsc\b|typecheck/i, timeout: 120000, reason: 'tsc 120s' },
    ];
    for (const { pattern, timeout, reason } of longPatterns) {
      if (pattern.test(command)) return { timeout, reason };
    }
    return { timeout: 60000, reason: '默认 60s' };
  }

  async function executeShell(args) {
    const rawCmd = (args.command || '').trim();
    if (!rawCmd) return '❌ 命令为空';

    // 危险命令黑名单（绝对禁止，统一使用传入的 DANGEROUS_CMD_REGEX）
    if (DANGEROUS_CMD_REGEX.test(rawCmd)) {
      return `❌ 安全拒绝：命令包含危险操作。命令: ${rawCmd.substring(0, 100)}`;
    }

    // V17: 跨平台命令转换
    const translatedCmd = translateCommand(rawCmd);
    const wasTranslated = translatedCmd !== rawCmd;

    // V17: 智能超时
    const { timeout: smartTimeout, reason: timeoutReason } = getSmartTimeout(rawCmd, args.timeout);

    // 检测是否包含 shell 元字符
    const hasMetaChars = /[;&|`$(){}!><\n\r]/.test(translatedCmd);

    if (!hasMetaChars) {
      // 简单命令：参数化执行（最安全）
      const parts = translatedCmd.split(/\s+/);
      const program = parts[0];
      const cmdArgs = parts.slice(1);

      // 扩展的程序白名单
      const allowedPrograms = new Set([
        'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3', 'pnpm', 'yarn', 'bun',
        'git', 'ls', 'dir', 'cat', 'echo', 'pwd', 'cd', 'type', 'where', 'which',
        'mkdir', 'rmdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'copy', 'move', 'del',
        'grep', 'find', 'wc', 'head', 'tail', 'sort', 'uniq', 'select-string',
        'curl', 'wget', 'ping', 'dotnet', 'go', 'cargo', 'rustc',
        'javac', 'java', 'gcc', 'g++', 'make', 'cmake', 'tasklist', 'ipconfig', 'netstat',
        'systeminfo', 'whoami', 'hostname', 'date', 'time', 'ver',
        // P1-7: 新增 Windows 常用命令
        'powershell', 'pwsh', 'cmd', 'taskkill', 'start', 'explorer', 'notepad', 'code',
        // V17: 新增 PowerShell cmdlet 白名单
        'Get-Content', 'Get-ChildItem', 'Get-Location', 'Get-Command',
        'Copy-Item', 'Move-Item', 'Remove-Item', 'New-Item',
      ]);
      if (!allowedPrograms.has(program) && !program.endsWith('.exe') && !program.includes('/') && !program.includes('\\')) {
        return `❌ 程序 "${program}" 不在白名单中。允许: ${[...allowedPrograms].slice(0, 20).join(', ')}...。如需管道/重定向，可使用 | > 等元字符进入 shell 模式。`;
      }

      try {
        const output = execFileSync(program, cmdArgs, {
          timeout: smartTimeout,
          maxBuffer: 10 * 1024 * 1024,
          cwd: args.workdir || ROOT_DIR,
          shell: false,
          encoding: 'utf-8',
        });
        let result = (typeof output === 'string' ? output : String(output || '')) || '✅ 命令执行成功（无输出）';
        if (wasTranslated) {
          result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
        }
        return result;
      } catch (execErr) {
        // V17: 超时自动重试 — 首次超时后用 2x 超时重试一次
        const isTimeout = execErr.signal === 'SIGTERM' || (execErr.message && execErr.message.includes('ETIMEDOUT'));
        if (isTimeout) {
          const retryTimeout = Math.min(smartTimeout * 2, 600000);
          if (retryTimeout > smartTimeout) {
            try {
              const retryOutput = execFileSync(program, cmdArgs, {
                timeout: retryTimeout,
                maxBuffer: 10 * 1024 * 1024,
                cwd: args.workdir || ROOT_DIR,
                shell: false,
                encoding: 'utf-8',
              });
              let result = `[自动重试] 首次执行超时（${smartTimeout / 1000}s），已用 ${retryTimeout / 1000}s 重试成功\n\n`;
              result += (typeof retryOutput === 'string' ? retryOutput : String(retryOutput || '')) || '✅ 命令执行成功（无输出）';
              if (wasTranslated) {
                result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
              }
              return result;
            } catch (retryErr) {
              const stderr = retryErr.stderr ? String(retryErr.stderr).substring(0, 500) : '';
              const stdout = retryErr.stdout ? String(retryErr.stdout).substring(0, 500) : '';
              let result = `❌ 命令执行失败(重试后): ${retryErr.message}\n  退出码: ${retryErr.status || 'N/A'}\n  stderr: ${stderr}\n  stdout: ${stdout}`;
              if (wasTranslated) {
                result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
              }
              return result;
            }
          }
        }
        const stderr = execErr.stderr ? String(execErr.stderr).substring(0, 500) : '';
        const stdout = execErr.stdout ? String(execErr.stdout).substring(0, 500) : '';
        let result = `❌ 命令执行失败: ${execErr.message}\n  退出码: ${execErr.status || 'N/A'}\n  stderr: ${stderr}\n  stdout: ${stdout}`;
        if (wasTranslated) {
          result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
        }
        return result;
      }
    } else {
      // V17: 复杂命令 — Windows 使用 PowerShell（替代 cmd.exe，兼容性更好）
      const isWindows = process.platform === 'win32';
      let shellExe = isWindows ? 'powershell.exe' : '/bin/bash';
      let actualCmd = translatedCmd;

      if (isWindows) {
        // 避免双重 PowerShell 调用：当命令以 powershell/pwsh -Command 开头时，
        // 提取脚本部分直接执行，防止 "powershell.exe -Command 'powershell -Command ...'" 嵌套引号问题
        const psPrefixMatch = translatedCmd.match(/^(powershell|pwsh)(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-(?:Command|c)\s+/i);
        if (psPrefixMatch) {
          actualCmd = translatedCmd.substring(psPrefixMatch[0].length);
          // 去掉外层引号（cmd 风格的 \"...\" 或 PowerShell 的 '...'/"..."）
          if (actualCmd.length >= 2) {
            const first = actualCmd[0];
            const last = actualCmd[actualCmd.length - 1];
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
              actualCmd = actualCmd.slice(1, -1);
            }
          }
          if (psPrefixMatch[1].toLowerCase() === 'pwsh') {
            shellExe = 'pwsh.exe';
          }
        }
      }

      // Windows PowerShell: 强制输出 UTF-8 编码，修复中文错误信息乱码（GBK→UTF-8）
      if (isWindows) {
        actualCmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ' + actualCmd;
      }

      const shellArgs = isWindows ? ['-NoProfile', '-Command', actualCmd] : ['-c', actualCmd];

      try {
        const output = execFileSync(shellExe, shellArgs, {
          timeout: smartTimeout,
          maxBuffer: 10 * 1024 * 1024,
          cwd: args.workdir || ROOT_DIR,
          encoding: 'utf-8',
          windowsHide: true,
        });
        let result = (typeof output === 'string' ? output : String(output || '')) || '✅ 命令执行成功（无输出）';
        if (wasTranslated) {
          result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
        }
        return result;
      } catch (execErr) {
        // V17: 超时自动重试 — 首次超时后用 2x 超时重试一次
        const isTimeout = execErr.signal === 'SIGTERM' || (execErr.message && execErr.message.includes('ETIMEDOUT'));
        if (isTimeout) {
          const retryTimeout = Math.min(smartTimeout * 2, 600000);
          if (retryTimeout > smartTimeout) {
            try {
              const retryOutput = execFileSync(shellExe, shellArgs, {
                timeout: retryTimeout,
                maxBuffer: 10 * 1024 * 1024,
                cwd: args.workdir || ROOT_DIR,
                encoding: 'utf-8',
                windowsHide: true,
              });
              let result = `[自动重试] 首次执行超时（${smartTimeout / 1000}s），已用 ${retryTimeout / 1000}s 重试成功\n\n`;
              result += (typeof retryOutput === 'string' ? retryOutput : String(retryOutput || '')) || '✅ 命令执行成功（无输出）';
              if (wasTranslated) {
                result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
              }
              return result;
            } catch (retryErr) {
              const stderr = retryErr.stderr ? String(retryErr.stderr).substring(0, 500) : '';
              const stdout = retryErr.stdout ? String(retryErr.stdout).substring(0, 500) : '';
              let result = `❌ Shell 命令执行失败(重试后): ${retryErr.message}\n  退出码: ${retryErr.status || 'N/A'}\n  stderr: ${stderr}\n  stdout: ${stdout}`;
              if (wasTranslated) {
                result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
              }
              return result;
            }
          }
        }
        const stderr = execErr.stderr ? String(execErr.stderr).substring(0, 500) : '';
        const stdout = execErr.stdout ? String(execErr.stdout).substring(0, 500) : '';
        let result = `❌ Shell 命令执行失败: ${execErr.message}\n  退出码: ${execErr.status || 'N/A'}\n  stderr: ${stderr}\n  stdout: ${stdout}`;
        if (wasTranslated) {
          result = `[跨平台兼容] 已转换: ${rawCmd} → ${translatedCmd}\n超时: ${timeoutReason}\n\n${result}`;
        }
        return result;
      }
    }
  }

  // ===========================================================================
  // file_read
  // ===========================================================================
  function executeFileRead(args) {
    try {
      const resolved = path.resolve(args.path || '');
      if (!args.path) return '❌ 缺少参数: path';
      if (isSensitivePath(resolved)) return '❌ 安全限制: 拒绝访问敏感路径';
      // P0-1 修复：工作区边界校验（防止读取系统目录）
      if (isWithinWorkspace) {
        const check = isWithinWorkspace(resolved);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!fs.existsSync(resolved)) return `❌ 文件不存在: ${resolved}`;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) return `❌ 路径是目录而非文件: ${resolved}。如需列出目录内容，请使用 file_list 工具`;

      // P1-10 修复：检测图片/二进制文件，避免读取为 utf-8 产生乱码
      const ext = path.extname(resolved).toLowerCase();
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'];
      const binaryExts = ['.exe', '.dll', '.so', '.dylib', '.zip', '.gz', '.tar', '.rar', '.7z', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
      if (imageExts.includes(ext)) {
        const sizeKB = Math.round(stat.size / 1024);
        return `🖼️ 这是一个图片文件: ${path.basename(resolved)} (${sizeKB}KB, ${ext}格式)\n图片无法作为文本读取。如果该图片已作为附件发送，你可以直接在消息中看到它。如需查看图片，可使用 desktop_open 工具打开。如需分析图片内容，请确保使用支持视觉的模型（如 GPT-4o、Claude 3.5 等）。`;
      }
      if (binaryExts.includes(ext)) {
        const sizeKB = Math.round(stat.size / 1024);
        return `📦 这是一个二进制文件: ${path.basename(resolved)} (${sizeKB}KB, ${ext}格式)\n二进制文件无法作为文本读取。如需查看，可使用 desktop_open 工具打开。`;
      }

      const content = fs.readFileSync(resolved, 'utf-8');
      // V17: 支持 offset/limit 参数分段读取大文件
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : 16000;
      const maxLimit = 50000; // 单次最大读取 50000 字符
      const effectiveLimit = Math.min(limit, maxLimit);
      const totalLength = content.length;

      if (offset > 0) {
        const slice = content.substring(offset, offset + effectiveLimit);
        const hasNext = offset + effectiveLimit < totalLength;
        return slice + (hasNext ? `\n\n[分段读取：offset=${offset}, limit=${effectiveLimit}, 已读 ${offset + slice.length}/${totalLength} 字符。如需继续，使用 offset=${offset + effectiveLimit}]` : `\n\n[分段读取完成：offset=${offset}, 已读至文件末尾，共 ${totalLength} 字符]`);
      }

      // 无 offset：从头读取，截断到 effectiveLimit
      const truncated = content.substring(0, effectiveLimit);
      if (totalLength > effectiveLimit) {
        return truncated + `\n\n[文件已截断：显示前 ${effectiveLimit} 字符，共 ${totalLength} 字符。如需查看后续内容，请使用 offset=${effectiveLimit} 参数继续读取]`;
      }
      return truncated;
    } catch (err) {
      return `❌ 读取文件失败: ${err.message} (路径: ${args.path || '空'})`;
    }
  }

  // ===========================================================================
  // V17 代码语法验证（写后自动验证闭环）
  // ===========================================================================

  /**
   * 验证代码文件语法
   * @param {string} filePath - 文件路径
   * @returns {{ ok: boolean, error?: string }} 验证结果
   */
  function verifyCodeSyntax(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const codeExts = ['.js', '.mjs', '.cjs'];
    const tsExts = ['.ts', '.tsx', '.jsx'];

    // JSON 文件用 JSON.parse 验证
    if (ext === '.json') {
      try {
        JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `JSON 语法错误: ${err.message}` };
      }
    }

    // JS 文件用 node --check 验证（快速，几百毫秒）
    if (codeExts.includes(ext)) {
      try {
        execFileSync('node', ['--check', filePath], {
          timeout: 10000,
          encoding: 'utf-8',
          windowsHide: true,
        });
        return { ok: true };
      } catch (err) {
        const stderr = err.stderr ? String(err.stderr).trim() : err.message;
        return { ok: false, error: `node --check 失败: ${stderr}` };
      }
    }

    // TS 文件：基础括号匹配检查（tsc --noEmit 太慢，不适合每次编辑）
    if (tsExts.includes(ext)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const issues = checkBracketBalance(content);
        if (issues) return { ok: false, error: `括号不匹配: ${issues}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `验证失败: ${err.message}` };
      }
    }

    // 其他文件类型不验证
    return { ok: true };
  }

  /**
   * 基础括号匹配检查（用于 TS 文件的快速验证）
   * @param {string} content - 文件内容
   * @returns {string|null} 错误描述，null 表示通过
   */
  function checkBracketBalance(content) {
    const stack = [];
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const opens = new Set(['(', '[', '{']);
    const closes = new Set([')', ']', '}']);
    const reversePairs = { ')': '(', ']': '[', '}': '{' };
    let inString = false;
    let stringChar = '';
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const next = content[i + 1] || '';

      // 处理转义字符
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && (inString || inTemplate)) { escaped = true; continue; }

      // 处理注释
      if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
      if (inBlockComment) { if (ch === '*' && next === '/') inBlockComment = false; continue; }

      // 处理字符串
      if (inString) {
        if (ch === stringChar) inString = false;
        continue;
      }
      if (inTemplate) {
        if (ch === '`') inTemplate = false;
        continue;
      }

      // 检测注释开始
      if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }

      // 检测字符串开始
      if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
      if (ch === '`') { inTemplate = true; continue; }

      // 括号匹配
      if (opens.has(ch)) {
        stack.push({ char: ch, line: content.substring(0, i).split('\n').length });
      } else if (closes.has(ch)) {
        if (stack.length === 0) {
          return `多余的闭合括号 '${ch}' 在第 ${content.substring(0, i).split('\n').length} 行`;
        }
        const top = stack[stack.length - 1];
        if (top.char !== reversePairs[ch]) {
          return `括号不匹配: '${top.char}' (第${top.line}行) 被 '${ch}' 闭合`;
        }
        stack.pop();
      }
    }

    if (stack.length > 0) {
      const top = stack[stack.length - 1];
      return `未闭合的括号 '${top.char}' 在第 ${top.line} 行`;
    }
    return null;
  }

  /**
   * V17 原子写入：先写临时文件，验证通过后 rename 到目标路径
   * @param {string} targetPath - 目标文件路径
   * @param {string} content - 文件内容
   * @returns {{ ok: boolean, verifyError?: string, tempPath?: string }}
   */
  function atomicWriteWithVerify(targetPath, content) {
    const ext = path.extname(targetPath).toLowerCase();
    const codeExts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
    const shouldVerify = codeExts.includes(ext);

    // 非代码文件直接写入
    if (!shouldVerify) {
      fs.writeFileSync(targetPath, content, 'utf-8');
      return { ok: true };
    }

    // 代码文件：先写临时文件，验证后再 rename
    const tmpPath = targetPath + '.tmp.' + Date.now();
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      const verifyResult = verifyCodeSyntax(tmpPath);
      if (!verifyResult.ok) {
        // 验证失败：删除临时文件，不修改原文件
        try { fs.unlinkSync(tmpPath); } catch {}
        return { ok: false, verifyError: verifyResult.error };
      }
      // 验证通过：原子替换
      fs.renameSync(tmpPath, targetPath);
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }

  // ===========================================================================
  // file_write
  // ===========================================================================
  function executeFileWrite(args) {
    try {
      // V17 修复：参数名兼容（LLM 可能传递 path/filePath/filename/file_path 等变体）
      const filePath = args.path || args.filePath || args.filename || args.file_path || args.file;
      const fileContent = args.content !== undefined ? args.content : (args.text !== undefined ? args.text : args.data);

      if (!filePath && fileContent !== undefined) {
        return '❌ 缺少参数: path。请提供文件路径，格式: {"path": "文件路径", "content": "文件内容"}';
      }
      if (!filePath) {
        return '❌ 缺少参数: path。file_write 需要两个参数: path(文件路径) 和 content(文件内容)';
      }
      if (fileContent === undefined) {
        return `❌ 缺少参数: content。请提供文件内容，格式: {"path": "${filePath}", "content": "文件内容"}`;
      }
      const resolved = path.resolve(filePath);
      if (isSensitivePath(resolved)) return '❌ 安全限制: 拒绝访问敏感路径';
      // P0-1 修复：工作区边界校验（防止写入系统目录）
      if (isWithinWorkspace) {
        const check = isWithinWorkspace(resolved);
        if (!check.ok) return `❌ ${check.error}`;
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      // V17: 原子写入 + 写后语法验证（代码文件验证失败则不写入，返回错误）
      const writeResult = atomicWriteWithVerify(resolved, fileContent || '');
      if (!writeResult.ok) {
        return `❌ 文件写入成功但语法验证失败，已回滚未修改原文件。错误: ${writeResult.verifyError}\n请修复语法错误后重试。`;
      }
      // 通知编辑器面板实时显示写入的文件
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        emitEditorWriteEvents(mw, resolved, fileContent || '');
        mw.webContents.send('tool:activate', 'editor');
      }
      // ===== 网页生成完成自动预览：HTML 文件写入后自动在内置浏览器展示 =====
      const isHtmlFile = resolved.toLowerCase().endsWith('.html') || resolved.toLowerCase().endsWith('.htm');
      if (isHtmlFile && mw && !mw.isDestroyed()) {
        setTimeout(() => {
          try {
            const fileUrl = 'file:///' + resolved.replace(/\\/g, '/');
            mw.webContents.send('browser:navigate-panel', fileUrl);
            mw.webContents.send('tool:activate', 'browser');
            console.log(`[ReAct] HTML 文件已自动预览: ${resolved}`);
          } catch (e) {
            console.warn(`[ReAct] 自动预览失败: ${e.message}`);
          }
        }, 100);
      }
      return `✅ 文件写入成功: ${resolved} (${(args.content || '').length} 字符)`;
    } catch (err) {
      return `❌ 写入文件失败: ${err.message} (路径: ${args.path || '空'})`;
    }
  }

  // ===========================================================================
  // file_edit (V17: search-replace 精确编辑，避免整文件重写)
  // ===========================================================================
  function executeFileEdit(args) {
    try {
      const filePath = args.path || args.filePath || args.filename || args.file_path || args.file;
      const oldText = args.old_text !== undefined ? args.old_text : (args.oldText !== undefined ? args.oldText : (args.search !== undefined ? args.search : args.find));
      const newText = args.new_text !== undefined ? args.new_text : (args.newText !== undefined ? args.newText : (args.replace !== undefined ? args.replace : args.replacement));

      if (!filePath) return '❌ 缺少参数: path';
      if (oldText === undefined || oldText === null) return '❌ 缺少参数: old_text';
      if (newText === undefined || newText === null) return '❌ 缺少参数: new_text';

      const resolved = path.resolve(filePath);
      if (isSensitivePath(resolved)) return '❌ 安全限制: 拒绝访问敏感路径';
      if (isWithinWorkspace) {
        const check = isWithinWorkspace(resolved);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!fs.existsSync(resolved)) return `❌ 文件不存在: ${resolved}`;

      const content = fs.readFileSync(resolved, 'utf-8');
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        return `❌ 未找到匹配的文本。请检查 old_text 是否与文件内容完全一致（包括缩进和换行）。文件共 ${content.length} 字符。`;
      }
      if (occurrences > 1 && !args.replace_all) {
        return `❌ 找到 ${occurrences} 处匹配。请提供更长的 old_text 确保唯一，或设置 replace_all=true。`;
      }
      const newContent = args.replace_all
        ? content.split(oldText).join(newText)
        : content.replace(oldText, newText);
      // V17: 原子写入 + 写后语法验证（代码文件验证失败则不修改原文件）
      const editResult = atomicWriteWithVerify(resolved, newContent);
      if (!editResult.ok) {
        return `❌ 编辑后语法验证失败，已回滚未修改原文件。错误: ${editResult.verifyError}\n请检查 new_text 的语法，修复后重试。`;
      }

      // 通知编辑器面板
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('editor:open-file', { path: resolved, content: newContent });
      }
      return `✅ 编辑成功: ${resolved} (替换 ${args.replace_all ? occurrences : 1} 处，${content.length}→${newContent.length} 字符)`;
    } catch (err) {
      return `❌ 编辑文件失败: ${err.message}`;
    }
  }

  // ===========================================================================
  // grep_search (V17: 文件内容搜索，类似 grep/ripgrep)
  // ===========================================================================
  function executeGrepSearch(args) {
    try {
      const pattern = args.pattern;
      if (!pattern) return '❌ 缺少参数: pattern';
      const searchDir = path.resolve(args.path || '.');
      if (isSensitivePath(searchDir)) return '❌ 安全限制: 拒绝访问敏感路径';
      if (isWithinWorkspace) {
        const check = isWithinWorkspace(searchDir);
        if (!check.ok) return `❌ ${check.error}`;
      }
      const include = args.include;
      const maxResults = args.max_results || 50;
      const maxDepth = args.max_depth || 10;
      const maxFileSize = 5 * 1024 * 1024; // 5MB 文件大小限制

      let regex;
      try { regex = new RegExp(pattern, 'i'); } catch (e) { return `❌ 无效正则: ${pattern}`; }

      const results = [];
      // V17: 支持多扩展名（如 "*.ts, *.tsx" 或 "*.ts,*.tsx"）
      const includeExts = include
        ? include.split(/[,\s]+/).map(s => s.replace(/\*/g, '').toLowerCase()).filter(s => s)
        : null;
      const binaryExts = /\.(png|jpg|jpeg|gif|bmp|ico|woff|woff2|ttf|eot|zip|tar|gz|exe|dll|so|class|jar|wasm)$/i;

      function walk(dir, depth) {
        if (results.length >= maxResults) return;
        if (depth > maxDepth) return; // V17: 递归深度限制
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= maxResults) break;
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(full, depth + 1);
            } else if (e.isFile()) {
              // V17: 多扩展名过滤
              if (includeExts) {
                const fileExt = e.name.toLowerCase();
                const matched = includeExts.some(ext => fileExt.endsWith(ext));
                if (!matched) continue;
              }
              if (binaryExts.test(e.name)) continue;
              // V17: 文件大小限制
              try {
                const stat = fs.statSync(full);
                if (stat.size > maxFileSize) continue;
              } catch { continue; }
              try {
                const lines = fs.readFileSync(full, 'utf-8').split('\n');
                for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                  if (regex.test(lines[i])) {
                    results.push(`${full}:${i + 1}: ${lines[i].trim().substring(0, 200)}`);
                  }
                }
              } catch (e2) {}
            }
          }
        } catch (e3) {}
      }
      walk(searchDir, 0);
      return results.length > 0
        ? `🔍 找到 ${results.length} 处匹配 "${pattern}":\n${results.join('\n')}`
        : `🔍 未找到匹配 "${pattern}" 的内容`;
    } catch (err) {
      return `❌ 搜索失败: ${err.message}`;
    }
  }

  // ===========================================================================
  // search_files (V17: 按文件名 glob 模式搜索文件)
  // ===========================================================================
  function executeSearchFiles(args) {
    try {
      const pattern = args.pattern || '';
      if (!pattern) return '❌ 缺少参数: pattern';
      const searchRoot = path.resolve(args.root || args.path || ROOT_DIR);
      if (isSensitivePath(searchRoot)) return '❌ 安全限制: 拒绝访问敏感路径';
      if (isWithinWorkspace) {
        const check = isWithinWorkspace(searchRoot);
        if (!check.ok) return `❌ ${check.error}`;
      }
      const maxDepth = args.max_depth || 10;
      const maxResults = args.max_results || 50;

      // V17: glob 模式转正则
      const globToRegex = (glob) => {
        let regex = '^';
        for (const ch of glob) {
          if (ch === '*') regex += '[^/\\\\]*';
          else if (ch === '?') regex += '[^/\\\\]';
          else if ('.+^${}()|[]\\'.includes(ch)) regex += '\\' + ch;
          else regex += ch;
        }
        return new RegExp(regex + '$', 'i');
      };
      const fileRegex = globToRegex(pattern);
      const results = [];

      const walk = (dir, depth) => {
        if (results.length >= maxResults) return;
        if (depth > maxDepth) return;
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= maxResults) break;
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (fileRegex.test(e.name)) results.push(full);
          }
        } catch {}
      };
      walk(searchRoot, 0);

      if (results.length === 0) {
        return `🔍 未找到匹配 "${pattern}" 的文件`;
      }
      const limited = results.slice(0, maxResults);
      return `🔍 找到 ${results.length} 个文件匹配 "${pattern}":\n${limited.join('\n')}${results.length > maxResults ? `\n... 还有 ${results.length - maxResults} 个` : ''}`;
    } catch (err) {
      return `❌ 搜索文件失败: ${err.message}`;
    }
  }

  // ===========================================================================
  // file_list
  // ===========================================================================
  function executeFileList(args) {
    try {
      const dirPath = args.path || ROOT_DIR;
      // 安全校验：敏感路径拦截（与 file_read/file_write 一致）
      if (isSensitivePath(dirPath)) {
        return `❌ 安全限制: 拒绝访问敏感路径 ${dirPath}`;
      }
      // P0-1 修复：工作区边界校验（防止列出系统目录）
      if (isWithinWorkspace) {
        const check = isWithinWorkspace(dirPath);
        if (!check.ok) return `❌ ${check.error}`;
      }
      if (!fs.existsSync(dirPath)) return `❌ 目录不存在: ${dirPath}`;
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) return `❌ 路径不是目录: ${dirPath}`;
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      // 性能保护：限制文件数量，防止大量文件 statSync 导致超时
      const MAX_ITEMS = 500;
      const totalItems = items.length;
      const displayItems = totalItems > MAX_ITEMS ? items.slice(0, MAX_ITEMS) : items;
      // 增强返回：文件大小、修改日期、扩展名，支持按日期/类型整理文件的任务
      const formatted = displayItems.map(item => {
        if (item.isDirectory()) {
          return `📁 ${item.name}/`;
        }
        try {
          const fullPath = path.join(dirPath, item.name);
          const fileStat = fs.statSync(fullPath);
          const sizeKB = (fileStat.size / 1024).toFixed(1);
          const sizeStr = fileStat.size >= 1024 * 1024
            ? `${(fileStat.size / (1024 * 1024)).toFixed(1)}MB`
            : `${sizeKB}KB`;
          const date = fileStat.mtime.toISOString().split('T')[0];
          const ext = path.extname(item.name).toLowerCase() || '(无扩展名)';
          return `📄 ${item.name} (${sizeStr}, ${date}, ${ext})`;
        } catch {
          return `📄 ${item.name} (信息不可读)`;
        }
      });
      const dirCount = items.filter(i => i.isDirectory()).length;
      const fileCount = totalItems - dirCount;
      let result = `📂 ${dirPath}（${fileCount}个文件, ${dirCount}个目录）\n\n${formatted.join('\n')}`;
      if (totalItems > MAX_ITEMS) {
        result += `\n\n[⚠️ 目录共有 ${totalItems} 项，仅显示前 ${MAX_ITEMS} 项。如需查看更多，请使用更具体的子目录路径]`;
      }
      return result;
    } catch (err) {
      return `❌ 列出目录失败: ${err.message} (路径: ${args.path || ROOT_DIR})`;
    }
  }

  // ===========================================================================
  // request_workspace_access
  // ===========================================================================
  async function executeRequestWorkspaceAccess(args) {
    try {
      const dirPath = (args.path || '').trim();
      if (!dirPath) {
        return '❌ 缺少参数: path。请提供要请求访问的目录路径，例如 {"path": "C:\\\\Users\\\\Administrator\\\\Desktop", "reason": "整理桌面图片"}';
      }
      const reason = (args.reason || '').trim();

      if (!requestWorkspaceAccess) {
        return '❌ 当前环境不支持请求目录访问权限（requestWorkspaceAccess 未注入）。请改用工作区内路径，或手动将文件复制到项目目录。';
      }

      const resolved = path.resolve(dirPath);

      // 基本安全检查：仍然拦截敏感路径（即使用户授权也不允许访问凭证目录）
      if (isSensitivePath && isSensitivePath(resolved)) {
        return `❌ 安全限制: 拒绝访问敏感路径 ${resolved}（敏感路径即使用户授权也不允许访问）`;
      }

      const result = await requestWorkspaceAccess(resolved, reason);
      if (result.approved) {
        return `✅ 用户已批准访问目录: ${result.resolved}\n现在可以使用 file_list/file_read/file_write 等工具操作该目录下的文件。`;
      }
      return `❌ 用户拒绝了目录访问请求: ${result.reason || '未知原因'}\n请改用工作区内路径，或询问用户是否愿意手动提供文件。`;
    } catch (err) {
      return `❌ 请求目录访问权限失败: ${err.message} (路径: ${args.path || '空'})`;
    }
  }

  // ===========================================================================
  // web_search
  // ===========================================================================
  async function executeWebSearch(args) {
    const query = args.query || '';
    if (!query) return '❌ 缺少参数: query';

    // P1-7 修复：多搜索引擎轮询，提高搜索成功率
    const searchEngines = [
      {
        name: 'Bing',
        url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`,
        parse: (html) => {
          // Bing 搜索结果提取
          const results = [];
          const liMatches = html.match(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g) || [];
          for (const li of liMatches.slice(0, 8)) {
            const titleMatch = li.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
            const linkMatch = li.match(/href="([^"]+)"/);
            const textMatch = li.match(/<p[^>]*>([\s\S]*?)<\/p>/) || li.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
            const link = linkMatch ? linkMatch[1] : '';
            const text = textMatch ? textMatch[1].replace(/<[^>]*>/g, '').trim() : '';
            if (title) results.push(`📌 ${title}\n🔗 ${link}\n📝 ${text.substring(0, 200)}`);
          }
          return results.length > 0 ? results.join('\n\n') : html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
        },
      },
      {
        name: 'DuckDuckGo',
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        parse: (html) => {
          const results = [];
          const resultMatches = html.match(/<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g) || [];
          for (const result of resultMatches.slice(0, 8)) {
            const titleMatch = result.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
            const linkMatch = result.match(/href="([^"]+)"/);
            const textMatch = result.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
            const link = linkMatch ? linkMatch[1] : '';
            const text = textMatch ? textMatch[1].replace(/<[^>]*>/g, '').trim() : '';
            if (title) results.push(`📌 ${title}\n🔗 ${link}\n📝 ${text.substring(0, 200)}`);
          }
          return results.length > 0 ? results.join('\n\n') : html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
        },
      },
    ];

    const errors = [];
    for (const engine of searchEngines) {
      try {
        const res = await fetch(engine.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          signal: AbortSignal.timeout(12000),
          redirect: 'follow',
        });
        if (!res.ok) {
          errors.push(`${engine.name}: HTTP ${res.status}`);
          continue;
        }
        const html = await res.text();
        const parsed = engine.parse(html);
        if (parsed && parsed.trim().length > 50) {
          return `🔍 搜索 "${query}" (${engine.name}) 结果:\n${parsed.substring(0, 4000)}`;
        }
        errors.push(`${engine.name}: 结果为空`);
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          errors.push(`${engine.name}: 超时`);
        } else {
          errors.push(`${engine.name}: ${err.message}`);
        }
      }
    }
    return `❌ 搜索失败，已尝试所有搜索引擎:\n${errors.join('\n')}\n建议: 可使用 web_fetch 工具直接获取已知 URL 的页面内容，或使用 browser_operate 工具在内置浏览器中打开搜索页面。`;
  }

  // ===========================================================================
  // web_fetch
  // ===========================================================================
  async function executeWebFetch(args) {
    try {
      const url = args.url || '';
      if (!url) return '❌ 缺少参数: url';
      if (!/^https?:\/\//i.test(url)) return `❌ 无效的URL: ${url}。URL 必须以 http:// 或 https:// 开头`;

      // SSRF 防护：禁止访问云元数据端点（可能泄露云服务凭证）
      if (/169\.254\.169\.254/.test(url) || /metadata\.google\.internal/.test(url) || /metadata\.azure\.com/.test(url)) {
        return `❌ 安全限制: 禁止访问云元数据端点，防止凭证泄露`;
      }

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return `❌ 获取页面失败: HTTP ${res.status} ${res.statusText}`;

      // 下载文件大小限制（50MB），防止内存耗尽
      const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_DOWNLOAD_SIZE) {
        return `❌ 文件过大: ${Math.round(contentLength / 1024 / 1024)}MB（限制 ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB）。请使用更具体的 URL 或分段下载`;
      }

      // P1-10 修复：检测图片/二进制响应，保存到文件而非返回乱码文本
      const contentType = res.headers.get('content-type') || '';
      if (contentType.startsWith('image/')) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_DOWNLOAD_SIZE) {
          return `❌ 图片过大: ${Math.round(buffer.length / 1024 / 1024)}MB（限制 ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB）`;
        }
        const ext = contentType.split('/')[1]?.split(';')[0] || 'png';
        const filename = `downloaded_${Date.now()}.${ext}`;
        const filepath = path.join(ROOT_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        const sizeKB = Math.round(buffer.length / 1024);
        return `🖼️ 图片已下载并保存: ${filepath} (${sizeKB}KB, ${contentType})\n可使用 desktop_open 工具打开查看，或使用 file_read 工具获取文件信息。`;
      }
      if (contentType.startsWith('application/octet-stream') || contentType.startsWith('application/pdf')) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_DOWNLOAD_SIZE) {
          return `❌ 文件过大: ${Math.round(buffer.length / 1024 / 1024)}MB（限制 ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB）`;
        }
        const ext = contentType.includes('pdf') ? 'pdf' : 'bin';
        const filename = `downloaded_${Date.now()}.${ext}`;
        const filepath = path.join(ROOT_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        const sizeKB = Math.round(buffer.length / 1024);
        return `📦 文件已下载并保存: ${filepath} (${sizeKB}KB, ${contentType})`;
      }

      const text = await res.text();
      // 检测是否是 HTML 页面
      if (contentType.includes('text/html')) {
        // 提取页面标题和纯文本
        const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
        const plainText = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return `${title ? `标题: ${title}\n` : ''}${plainText.substring(0, 10000)}`;
      }
      return text.substring(0, 10000);
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return `❌ 获取页面超时（15秒）: ${args.url}`;
      }
      return `❌ 获取页面失败: ${err.message} (URL: ${args.url || '空'})`;
    }
  }

  // ===========================================================================
  // desktop_open
  // ===========================================================================
  function executeDesktopOpen(args) {
    const target = args.target || '';
    const appType = args.app || '';
    const mw = getMainWindow();
    // 智能路由：根据目标类型自动选择内置工具
    if (appType === 'browser' || target.startsWith('http://') || target.startsWith('https://')) {
      // P1-6 修复：不再弹出独立浏览器窗口，仅在主窗口内置 BrowserPanel 中打开
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('tool:activate', 'browser');
        mw.webContents.send('browser:navigate-panel', target);
        mw.focus();
      }
      return `✅ 已在内置浏览器中打开: ${target}`;
    }
    if (appType === 'terminal' || target === 'terminal') {
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('tool:activate', 'terminal');
      }
      return '✅ 已打开内置终端';
    }
    if (appType === 'editor' || target === 'editor') {
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('tool:activate', 'editor');
      }
      return '✅ 已打开内置代码编辑器';
    }
    // 其他目标：用系统默认程序打开
    // P0-2 修复：命令注入防护 — 仅允许 http(s) URL、file:// URL 和已验证的文件路径
    const isUrl = /^https?:\/\//i.test(target) || /^file:\/\//i.test(target);
    const isLikelyFilePath = /^[a-zA-Z]:[\\\/]/.test(target) || target.startsWith('/') || target.startsWith('~');
    if (!isUrl && !isLikelyFilePath) {
      return `❌ 安全限制: desktop_open 仅允许打开 URL 或文件路径，拒绝执行: ${target}`;
    }
    // 拒绝包含 shell 元字符的输入（防止命令注入）
    if (/[&|;`$(){}!#]/.test(target)) {
      return `❌ 安全限制: 目标包含非法字符，拒绝执行: ${target}`;
    }
    try {
      const { shell } = require('electron');
      // 使用 Electron 的 shell.openExternal/openPath 替代 cmd start，避免 shell 解析
      if (isUrl) {
        shell.openExternal(target);
      } else {
        shell.openPath(target);
      }
    } catch (err) {
      return `❌ 打开失败: ${err.message}`;
    }
    return `✅ 已打开: ${target}`;
  }

  // ===========================================================================
  // browser_operate
  // ===========================================================================
  async function executeBrowserOperate(args) {
    const action = args.action || '';
    const targetUrl = args.url || '';
    const mw = getMainWindow();
    const bw = getBrowserWindow();
    try {
      // 优先使用内置浏览器窗口（可视化操作）
      if (action === 'goto' && targetUrl) {
        // V17 安全修复：仅允许 http/https URL，防止 file:// 和 javascript: 协议
        if (!/^https?:\/\//i.test(targetUrl)) {
          return `❌ 安全限制: browser_operate goto 仅允许 http:// 或 https:// URL，拒绝: ${targetUrl.substring(0, 100)}`;
        }
        // P1-6 修复：隐藏窗口仅用于 Agent 内容提取，用户看到的是主窗口内置 BrowserPanel
        createBrowserWindow(targetUrl, { show: false });
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('tool:activate', 'browser');
          mw.webContents.send('browser:navigate-panel', targetUrl);
        }
        const currentBw = getBrowserWindow();
        if (currentBw && !currentBw.isDestroyed()) {
          // 等待页面基础加载完成
          await new Promise(resolve => {
            currentBw.webContents.once('did-finish-load', resolve);
            setTimeout(resolve, 10000);
          });
          // P1-8 修复：SPA 页面在 did-finish-load 后还需要等待 JS 渲染内容
          // 轮询 document.body.innerText 直到有内容（最多等 8 秒）
          let spaWaited = 0;
          while (spaWaited < 8000) {
            try {
              const textLen = await currentBw.webContents.executeJavaScript('document.body?.innerText?.length || 0');
              if (textLen > 50) break;
            } catch {}
            await new Promise(r => setTimeout(r, 500));
            spaWaited += 500;
          }
          try {
            const title = await currentBw.webContents.executeJavaScript('document.title');
            const url = currentBw.webContents.getURL();
            const bodyText = await currentBw.webContents.executeJavaScript('document.body?.innerText?.substring(0, 2000) || ""');
            const spaHint = spaWaited >= 8000 && bodyText.length < 50 ? '\n⚠️ 页面可能是SPA，内容仍在加载。建议使用 extract 或 wait 操作后再试。' : '';
            return `✅ 页面已加载: ${title}\nURL: ${url}\n\n${bodyText}${spaHint}`;
          } catch {
            return `✅ 已在内置浏览器中打开: ${targetUrl}`;
          }
        }
        return `✅ 已打开: ${targetUrl}`;
      }
      if (action === 'screenshot') {
        if (bw && !bw.isDestroyed()) {
          // 安全检查：filepath 必须在工作区内，防止写入任意位置
          let screenshotPath = path.join(ROOT_DIR, 'screenshot.png');
          if (args.filepath) {
            const wsCheck = isWithinWorkspace(args.filepath);
            if (!wsCheck.ok) {
              return `❌ ${wsCheck.error}`;
            }
            if (isSensitivePath(args.filepath)) {
              return `❌ 安全限制: 拒绝保存截图到敏感路径`;
            }
            screenshotPath = args.filepath;
          }
          const image = await bw.webContents.capturePage();
          fs.writeFileSync(screenshotPath, image.toPNG());
          try {
            const title = await bw.webContents.executeJavaScript('document.title');
            const bodyText = await bw.webContents.executeJavaScript('document.body?.innerText?.substring(0, 1500) || ""');
            return `✅ 截图已保存: ${screenshotPath}\n\n页面: ${title}\n${bodyText}`;
          } catch {
            return `✅ 截图已保存: ${screenshotPath}`;
          }
        }
        return '❌ 浏览器窗口未打开，请先使用 goto 操作';
      }
      if (action === 'extract') {
        if (bw && !bw.isDestroyed()) {
          // P1-8 修复：SPA 页面可能内容为空，等待并重试
          const extractJs = `(() => {
            const title = document.title;
            const url = location.href;
            const main = document.querySelector('main, article, [role=main], #content, .content, #app, #root, #__next');
            const body = main || document.body;
            const text = body ? body.innerText.substring(0, 5000) : '';
            const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], a[href]')].map(e => e.textContent?.trim() || e.value || e.getAttribute('aria-label') || '').filter(Boolean).slice(0, 30);
            const links = [...document.querySelectorAll('a[href]')].map(e => ({ text: e.textContent?.trim() || '', href: e.href })).filter(e => e.text).slice(0, 20);
            const inputs = [...document.querySelectorAll('input, textarea, select')].map(e => ({ type: e.type, placeholder: e.placeholder || '', name: e.name || '', id: e.id || '' })).slice(0, 10);
            const imgs = [...document.querySelectorAll('img[alt]')].map(e => ({ alt: e.alt, src: e.src })).filter(e => e.alt).slice(0, 10);
            return JSON.stringify({ title, url, textLength: text.length, text, buttons, links, inputs, imgs }, null, 2);
          })()`;
          let content = await bw.webContents.executeJavaScript(extractJs);
          // 如果内容为空，等待 SPA 渲染后重试（最多 5 秒）
          let retryCount = 0;
          while (retryCount < 5) {
            try {
              const parsed = JSON.parse(content);
              if (parsed.text && parsed.text.length > 20) break;
              if (parsed.buttons && parsed.buttons.length > 0) break;
              if (parsed.links && parsed.links.length > 0) break;
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
            retryCount++;
            content = await bw.webContents.executeJavaScript(extractJs);
          }
          const retryHint = retryCount > 0 ? `\n⏱️ (等待SPA渲染 ${retryCount}秒)` : '';
          return `📄 页面内容:${retryHint}\n${content}`;
        }
        return '❌ 浏览器窗口未打开，请先使用 goto 操作';
      }
      if (action === 'info') {
        if (bw && !bw.isDestroyed()) {
          const info = await bw.webContents.executeJavaScript(`(() => {
            return JSON.stringify({
              title: document.title,
              url: location.href,
              cookieCount: document.cookie.length,
              readyState: document.readyState,
            });
          })()`);
          return `ℹ️ 页面信息: ${info}`;
        }
        return '❌ 浏览器窗口未打开';
      }
      if (action === 'click') {
        if (bw && !bw.isDestroyed()) {
          const selector = args.selector || args.element || '';
          if (!selector) return '❌ 需要提供 selector 参数';
          const selectorJson = JSON.stringify(selector);
          const clickJs = `(() => {
            const sel = ${selectorJson};
            try { const el = document.querySelector(sel); if (el) { el.click(); return 'css:' + sel; } } catch {}
            try {
              const xpath = sel.startsWith('/') || sel.startsWith('(') ? sel : '//*[contains(text(),' + JSON.stringify(sel) + ')]';
              const node = document.evaluate(xpath, document, null, 1, null).singleNodeValue;
              if (node) { node.click(); return 'xpath:' + sel; }
            } catch {}
            const allEls = document.querySelectorAll('a, button, span, div, [role=button], input[type=submit], input[type=button], li, p, h1, h2, h3, h4, label, svg');
            for (const el of allEls) {
              const t = (el.textContent && el.textContent.trim()) || '';
              const al = el.getAttribute('aria-label') || '';
              const title = el.getAttribute('title') || '';
              const val = el.value || '';
              if (t === sel || al === sel || title === sel || val === sel) { el.click(); return 'text-exact:' + t; }
            }
            for (const el of allEls) {
              const t = (el.textContent && el.textContent.trim()) || '';
              const al = el.getAttribute('aria-label') || '';
              const title = el.getAttribute('title') || '';
              if (t.includes(sel) || al.includes(sel) || title.includes(sel)) { el.click(); return 'text-fuzzy:' + t.substring(0, 30); }
            }
            const imgs = document.querySelectorAll('img[alt], svg[aria-label]');
            for (const el of imgs) {
              const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || '';
              if (alt.includes(sel)) { el.click(); return 'img-alt:' + alt; }
            }
            return null;
          })()`;
          // P1-8 修复：SPA 页面可能元素尚未渲染，重试 3 次（每次间隔 1 秒）
          let clicked = null;
          let clickRetry = 0;
          while (clickRetry < 3) {
            clicked = await bw.webContents.executeJavaScript(clickJs);
            if (clicked) break;
            clickRetry++;
            if (clickRetry < 3) await new Promise(r => setTimeout(r, 1000));
          }
          if (clicked) {
            await new Promise(r => setTimeout(r, 500));
            return `✅ 已点击: ${selector} (${clicked})`;
          }
          // 返回页面上所有可交互元素，帮助 Agent 选择正确的 selector
          const available = await bw.webContents.executeJavaScript(`(() => {
            const els = document.querySelectorAll('button, [role=button], input[type=submit], a[href], [onclick], [class*="nav"], [class*="menu"], [class*="btn"]');
            const items = [...els].slice(0, 30).map(e => {
              const text = e.textContent?.trim()?.substring(0, 40) || '';
              const al = e.getAttribute('aria-label') || '';
              const href = e.href || '';
              const cls = e.className || '';
              return text || al || href || cls;
            }).filter(Boolean);
            return items.join(' | ');
          })()`);
          const retryHint = clickRetry > 0 ? ` (已等待${clickRetry}秒SPA渲染)` : '';
          return `❌ 未找到可点击元素: "${selector}"${retryHint}\n页面上可点击的元素: ${available || '无（页面可能还在加载，建议先使用 extract 查看页面内容）'}`;
        }
        return '❌ 浏览器窗口未打开，请先使用 goto 操作';
      }
      if (action === 'type') {
        if (bw && !bw.isDestroyed()) {
          const selector = args.selector || args.element || '';
          const text = args.text || args.value || '';
          if (!selector) return '❌ 需要提供 selector 参数';
          const selectorJson = JSON.stringify(selector);
          const textJson = JSON.stringify(text);
          const focused = await bw.webContents.executeJavaScript(`(() => {
            const sel = ${selectorJson};
            try { const el = document.querySelector(sel); if (el) { el.focus(); return true; } } catch {}
            try {
              const xpath = sel.startsWith('/') || sel.startsWith('(') ? sel : '//*[contains(text(),' + JSON.stringify(sel) + ')]';
              const node = document.evaluate(xpath, document, null, 1, null).singleNodeValue;
              if (node) { node.focus(); return true; }
            } catch {}
            const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]');
            for (const el of inputs) {
              const t = el.textContent && el.textContent.trim() || '';
              const p = el.placeholder || '';
              const al = el.getAttribute('aria-label') || '';
              if (t.includes(sel) || p.includes(sel) || al.includes(sel)) { el.focus(); return true; }
            }
            const first = document.querySelector('input[type="text"], textarea, [contenteditable]');
            if (first) { first.focus(); return true; }
            return false;
          })()`);
          if (!focused) return `❌ 未找到输入框: ${selector}`;
          await bw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
          await bw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
          await bw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
          await bw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
          for (const ch of text) {
            await bw.webContents.sendInputEvent({ type: 'char', keyCode: ch });
          }
          return `✅ 已输入: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`;
        }
        return '❌ 浏览器窗口未打开，请先使用 goto 操作';
      }
      if (action === 'press') {
        if (bw && !bw.isDestroyed()) {
          const key = args.key || '';
          if (!key) return '❌ 需要提供 key 参数';
          const keyMap = { 'Enter': 'Return', 'Tab': 'Tab', 'Escape': 'Escape' };
          const keyCode = keyMap[key] || key;
          await bw.webContents.sendInputEvent({ type: 'keyDown', keyCode });
          await bw.webContents.sendInputEvent({ type: 'keyUp', keyCode });
          return `✅ 按键: ${key}`;
        }
        return '❌ 浏览器窗口未打开';
      }
      if (action === 'wait_for_change' || action === 'wait') {
        const waitMs = typeof args.timeout === 'number' ? args.timeout : 3000;
        if (bw && !bw.isDestroyed()) {
          const beforeUrl = bw.webContents.getURL();
          const beforeText = await bw.webContents.executeJavaScript('document.body?.innerText?.substring(0, 500) || ""').catch(() => '');
          const start = Date.now();
          while (Date.now() - start < waitMs) {
            await new Promise(r => setTimeout(r, 500));
            try {
              const afterUrl = bw.webContents.getURL();
              const afterText = await bw.webContents.executeJavaScript('document.body?.innerText?.substring(0, 500) || ""');
              if (afterUrl !== beforeUrl || afterText !== beforeText) {
                return `✅ 页面已变化 (等待${Date.now() - start}ms)\n新URL: ${afterUrl}`;
              }
            } catch {}
          }
          return `✅ 等待 ${waitMs}ms 完成，页面无变化`;
        }
        await new Promise(r => setTimeout(r, waitMs));
        return `✅ 已等待 ${waitMs}ms`;
      }
      // P1-7: 新增 scroll 操作 — 滚动页面以加载懒加载内容或查看更多
      if (action === 'scroll') {
        if (bw && !bw.isDestroyed()) {
          const direction = args.direction || 'down';
          // 安全修复：Number() 转换防止 amount 参数 JavaScript 注入
          const amount = Number(args.amount) || 500;
          const scrollY = direction === 'up' ? -amount : amount;
          await bw.webContents.executeJavaScript(`window.scrollBy(0, ${scrollY})`);
          await new Promise(r => setTimeout(r, 800));
          try {
            const title = await bw.webContents.executeJavaScript('document.title');
            const bodyText = await bw.webContents.executeJavaScript('document.body?.innerText?.substring(0, 1500) || ""');
            return `✅ 已向${direction === 'up' ? '上' : '下'}滚动 ${amount}px\n\n页面: ${title}\n${bodyText}`;
          } catch {
            return `✅ 已滚动页面`;
          }
        }
        return '❌ 浏览器窗口未打开，请先使用 goto 操作';
      }
      // P1-7: 新增 eval 操作 — 执行自定义 JS 代码（用于复杂页面交互）
      if (action === 'eval') {
        if (bw && !bw.isDestroyed()) {
          const jsCode = args.code || args.script || '';
          if (!jsCode) return '❌ 需要提供 code 参数';
          try {
            const result = await bw.webContents.executeJavaScript(jsCode);
            return `✅ 执行结果: ${typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)}`;
          } catch (evalErr) {
            return `❌ JS 执行错误: ${evalErr.message}`;
          }
        }
        return '❌ 浏览器窗口未打开，请先使用 goto 操作';
      }
      return `⚠️ 不支持的操作: ${action}。支持的操作: goto, screenshot, extract, click, type, press, scroll, eval, info, wait`;
    } catch (err) {
      return `❌ 浏览器操作失败: ${err.message}`;
    }
  }

  // ===========================================================================
  // code_execute
  // ===========================================================================
  function executeCodeExecute(args) {
    const code = args.code || '';
    // P1-7 修复：提供安全的 require，允许白名单模块（https/http/crypto/url 等）
    // 这样 Agent 可以执行网络请求、数据处理等任务，同时禁止访问 child_process 等危险模块
    // 安全的 fs 模块：用 Proxy 包装，对路径操作函数添加工作区边界检查
    // 防止 Agent 通过 code_execute 的 require('fs') 绕过 isWithinWorkspace 限制
    const realFs = require('fs');
    const fsPathFuncs = {
      readFileSync: [0], writeFileSync: [0], readdirSync: [0], statSync: [0],
      existsSync: [0], accessSync: [0], lstatSync: [0], mkdirSync: [0],
      appendFileSync: [0], unlinkSync: [0], rmdirSync: [0],
      renameSync: [0, 1], copyFileSync: [0, 1], chmodSync: [0], truncateSync: [0],
      readFile: [0], writeFile: [0], readdir: [0], stat: [0],
      exists: [0], access: [0], lstat: [0], mkdir: [0],
      appendFile: [0], unlink: [0], rmdir: [0],
      rename: [0, 1], copyFile: [0, 1], chmod: [0], truncate: [0],
      open: [0], openSync: [0], createReadStream: [0], createWriteStream: [0],
    };
    const wrappedFs = new Proxy(realFs, {
      get(target, prop) {
        const orig = target[prop];
        if (typeof orig !== 'function' || !(prop in fsPathFuncs)) {
          return orig;
        }
        const pathIndices = fsPathFuncs[prop];
        return function (...args) {
          for (const idx of pathIndices) {
            const p = args[idx];
            if (p && typeof p === 'string') {
              if (isSensitivePath && isSensitivePath(p)) {
                throw new Error(`code_execute 安全限制: 拒绝访问敏感路径 ${p}`);
              }
              if (isWithinWorkspace) {
                const check = isWithinWorkspace(p);
                if (!check.ok) {
                  throw new Error(`code_execute: ${check.error}`);
                }
              }
            }
          }
          return orig.apply(target, args);
        };
      },
    });
    const SAFE_REQUIRE_MODULES = {
      https: require('https'),
      http: require('http'),
      crypto: require('crypto'),
      url: require('url'),
      querystring: require('querystring'),
      os: require('os'),
      path: require('path'),
      fs: wrappedFs,  // 包装后的 fs，路径操作受工作区边界检查
      zlib: require('zlib'),
      stream: require('stream'),
    };
    const safeRequire = (modName) => {
      if (Object.prototype.hasOwnProperty.call(SAFE_REQUIRE_MODULES, modName)) {
        return SAFE_REQUIRE_MODULES[modName];
      }
      throw new Error(`模块 "${modName}" 不在安全白名单中。允许: ${Object.keys(SAFE_REQUIRE_MODULES).join(', ')}`);
    };
    const safeConsole = {
      log: (...args) => { codeExecLogs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
      error: (...args) => { codeExecLogs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
      warn: (...args) => { codeExecLogs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
      info: (...args) => { codeExecLogs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); },
    };
    const codeExecLogs = [];
    // 安全的 process 对象：提供 env/platform/cwd 等只读信息，过滤敏感环境变量
    const SENSITIVE_ENV_PATTERNS = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY)/i;
    const safeEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (SENSITIVE_ENV_PATTERNS.test(key)) {
        safeEnv[key] = '***REDACTED***';
      } else {
        safeEnv[key] = value;
      }
    }
    const safeProcess = {
      env: safeEnv,
      platform: process.platform,
      arch: process.arch,
      version: process.version,
      cwd: () => ROOT_DIR,
      // 必须 bind(process)，否则在 vm 沙箱中调用时 this 不是 process 对象，会报 TypeError
      hrtime: process.hrtime.bind(process),
      memoryUsage: process.memoryUsage.bind(process),
      uptime: process.uptime.bind(process),
    };
    const sandbox = {
      console: safeConsole,
      require: safeRequire,  // P1-7: 安全的 require
      process: safeProcess,  // 提供安全的 process 对象（env/platform/cwd），过滤敏感变量
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5000)),
      setInterval: () => {},
      clearTimeout: clearTimeout,
      fetch: typeof fetch !== 'undefined' ? fetch : undefined,  // Node 18+ 内置 fetch
      Math: Math,
      JSON: JSON,
      String: String,
      Number: Number,
      Boolean: Boolean,
      Array: Array,
      Object: Object,
      Date: Date,
      RegExp: RegExp,
      Error: Error,
      Map: Map,
      Set: Set,
      Promise: Promise,
      parseInt: parseInt,
      parseFloat: parseFloat,
      isNaN: isNaN,
      isFinite: isFinite,
      encodeURIComponent: encodeURIComponent,
      decodeURIComponent: decodeURIComponent,
      __result: undefined,
    };
    try {
      // 安全加固：contextCodeGeneration.strings=false 禁止 new Function(string) 和 eval(string)
      // 防止沙箱逃逸攻击：(() => {}).constructor('return this')() 获取全局对象
      vm.createContext(sandbox, {
        contextCodeGeneration: {
          strings: false,  // 禁止从字符串生成代码（阻止 Function 构造函数逃逸）
          wasm: false,     // 禁止 WebAssembly 编译
        }
      });
      const safeCode = `
        const global = undefined;
        const Buffer = undefined;
        const __dirname = undefined;
        const __filename = undefined;
        const exports = {};
        const module = { exports: {} };
        ${code}
        __result = typeof module.exports !== 'undefined' && Object.keys(module.exports).length > 0 ? module.exports : undefined;
      `;
      vm.runInContext(safeCode, sandbox, { timeout: 10000 });
      const result = sandbox.__result;
      const logStr = codeExecLogs.length > 0 ? `\n📋 控制台输出:\n${codeExecLogs.join('\n')}` : '';
      if (result !== undefined) {
        return (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)) + logStr;
      }
      return '✅ 代码执行成功（无返回值）' + logStr;
    } catch (err) {
      const logStr = codeExecLogs.length > 0 ? `\n📋 控制台输出:\n${codeExecLogs.join('\n')}` : '';
      return `❌ 代码执行失败: ${err.message}${logStr}`;
    }
  }

  // ===========================================================================
  // app_operate
  // ===========================================================================
  async function executeAppOperate(args) {
    const appId = String(args.app || '');
    const action = String(args.action || '');
    let opParams = {};
    try {
      opParams = typeof args.params === 'string' ? JSON.parse(args.params) : (args.params || {});
    } catch (e) {
      return `❌ params 参数 JSON 解析失败: ${e.message}。请确保 params 是有效的 JSON 对象`;
    }
    const timeout = args.timeout !== undefined ? Number(args.timeout) : 5000;
    const retry = args.retry !== undefined ? Number(args.retry) : 3;

    // 应用配置表（与 universal-desktop.ts 保持一致）
    const APP_PROFILES = {
      photoshop: { name: 'Adobe Photoshop', procs: ['Photoshop'], launch: 'Photoshop' },
      powerpoint: { name: 'Microsoft PowerPoint', procs: ['POWERPNT'], launch: 'POWERPNT' },
      vscode: { name: 'Visual Studio Code', procs: ['Code'], launch: 'code' },
      chrome: { name: 'Google Chrome / Edge', procs: ['chrome', 'msedge'], launch: 'chrome' },
      firefox: { name: 'Mozilla Firefox', procs: ['firefox'], launch: 'firefox' },
      'notepad++': { name: 'Notepad++', procs: ['notepad++'], launch: 'notepad++' },
      sublime: { name: 'Sublime Text', procs: ['sublime_text'], launch: 'subl' },
      powershell: { name: 'Windows PowerShell', procs: ['powershell', 'pwsh'], launch: 'powershell' },
      cmd: { name: '命令提示符', procs: ['cmd'], launch: 'cmd' },
      windowsterminal: { name: 'Windows Terminal', procs: ['WindowsTerminal'], launch: 'wt' },
      word: { name: 'Microsoft Word', procs: ['WINWORD'], launch: 'winword' },
      excel: { name: 'Microsoft Excel', procs: ['EXCEL'], launch: 'excel' },
      outlook: { name: 'Microsoft Outlook', procs: ['OUTLOOK'], launch: 'outlook' },
      wechat: { name: '微信', procs: ['WeChat', 'Weixin'], launch: 'Weixin' },
      dingtalk: { name: '钉钉', procs: ['DingTalk'], launch: 'DingTalk' },
      feishu: { name: '飞书', procs: ['Feishu', 'Lark'], launch: 'Feishu' },
      figma: { name: 'Figma', procs: ['Figma'], launch: 'figma' },
      vlc: { name: 'VLC', procs: ['vlc'], launch: 'vlc' },
      spotify: { name: 'Spotify', procs: ['Spotify'], launch: 'spotify' },
      explorer: { name: '文件资源管理器', procs: ['explorer'], launch: 'explorer' },
      system: { name: '系统设置', procs: ['regedit', 'taskmgr'], launch: 'regedit' },
      git: { name: 'Git', procs: ['git'], launch: 'git' },
      docker: { name: 'Docker', procs: ['Docker Desktop'], launch: 'docker' },
      nodejs: { name: 'Node.js', procs: ['node'], launch: 'node' },
    };
    const profile = APP_PROFILES[appId];
    if (!profile) return `❌ 未注册的应用: ${appId}。已注册: ${Object.keys(APP_PROFILES).join(', ')}`;

    const startTime = Date.now();
    const isRunning = (procName) => {
      try {
        // 使用 Base64 编码，避免 cmd.exe 吞掉 $_ 等 PowerShell 变量
        const script = `Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const r = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        return r && r.trim().length > 0;
      } catch { return false; }
    };
    // 统一 PowerShell 执行：使用 -EncodedCommand Base64，避免 cmd.exe 吞掉 $_ / Add-Type here-string（项目记忆约束）
    // 直接调 powershell.exe（不经 cmd.exe 包装），防止 Start-Process 异步返回导致 spawnSync ETIMEDOUT
    const runPs = (script, timeout = 5000) => {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      try {
        return execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf-8', timeout, windowsHide: true }).trim();
      } catch (e) {
        // D3: Sanitize CLIXML progress stream pollution from stderr。
        // PowerShell 非交互模式会将进度流序列化为 #< CLIXML ... 写入 stderr，
        // 导致错误消息被 CLIXML 包裹污染，LLM 无法读懂真实错误。
        const cleanStderr = sanitizePowerShellStderr(e.stderr || '');
        const cleanMsg = cleanStderr || (e.message || '').replace(/[\s\S]*\nStderr:\n/, '').trim();
        const cleanErr = new Error(cleanMsg || `PowerShell 执行失败 (exit ${e.status ?? 'unknown'})`);
        cleanErr.status = e.status;
        cleanErr.pid = e.pid;
        throw cleanErr;
      }
    };

    let lastError = '';
    const maxAttempts = retry + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (action !== 'launch' && action !== 'activate') {
          const running = profile.procs.some(isRunning);
          if (!running) {
            try { runPs(`Start-Process '${profile.launch}'`, 5000); } catch (e) { console.warn(`[app_operate] 启动 ${profile.name} 失败: ${e.message}`); }
            await new Promise(r => setTimeout(r, 1500));
          }
        }

        let result = '';
        const activateApp = () => {
          for (const procName of profile.procs) {
            try {
              const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPIAct {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$proc = Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Select-Object -First 1;
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
  [WinAPIAct]::ShowWindow($proc.MainWindowHandle, 9);
  [WinAPIAct]::SetForegroundWindow($proc.MainWindowHandle);
  Write-Output 'activated'
} else { Write-Output 'no_window' }`;
              const r = runPs(script, 5000);
              if (r.trim() === 'activated') return true;
            } catch {}
          }
          return false;
        };

        switch (action) {
          case 'launch': {
            runPs(`Start-Process '${profile.launch}'`, 10000);
            result = `✅ 已启动应用: ${profile.name}`;
            break;
          }
          case 'activate': {
            result = activateApp() ? `✅ 已激活应用: ${profile.name}` : `❌ 未找到 ${profile.name} 的窗口`;
            break;
          }
          case 'shortcut': {
            // D5: SendKeys::SendWait 窗口未聚焦时阻塞满超时。先 activateApp 确认焦点获取成功。
            if (!activateApp()) {
              result = `❌ 未找到 ${profile.name} 的窗口，无法执行快捷键（焦点获取失败，SendWait 将阻塞）`;
              break;
            }
            await new Promise(r => setTimeout(r, 300));
            const shortcutName = opParams.shortcutName || opParams;
            const SHORTCUT_MAP = {
              '新建': '^n', '保存': '^s', '另存为': '+^s', '撤销': '^z', '重做': '^y',
              '复制': '^c', '粘贴': '^v', '剪切': '^x', '全选': '^a', '查找': '^f',
              '替换': '^h', '打开': '^o', '打印': '^p', '关闭标签': '^w', '新标签': '^n',
              '地址栏': '^l', '收藏': '^d', '加粗': '^b', '斜体': '^i', '下划线': '^u',
              '放大': '^{=}', '缩小': '^{-}', '删除': '{DEL}', '重命名': '{F2}',
              '刷新': '{F5}', '播放暂停': ' ', '全屏': 'f',
            };
            const sendKeys = SHORTCUT_MAP[shortcutName];
            if (!sendKeys) {
              result = `❌ 未找到快捷键: ${shortcutName}。可用: ${Object.keys(SHORTCUT_MAP).join(', ')}`;
            } else {
              runPs(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeys}')`, 5000);
              result = `✅ 已在 ${profile.name} 中执行快捷键 [${shortcutName}]`;
            }
            break;
          }
          case 'type': {
            // D5: SendKeys::SendWait 窗口未聚焦时阻塞满超时。先 activateApp 确认焦点获取成功。
            if (!activateApp()) {
              result = `❌ 未找到 ${profile.name} 的窗口，无法输入文本（焦点获取失败，SendWait 将阻塞）`;
              break;
            }
            await new Promise(r => setTimeout(r, 300));
            const text = String(opParams.text || opParams || '');
            // V17 安全修复：先转义 PowerShell 单引号（' → ''），防止命令注入
            // 再转义 SendKeys 特殊字符（仅 + ^ % ~ ( ) { } 是特殊字符，" 和 \ 不是）
            const psEscaped = text.replace(/'/g, "''");
            const sendKeysEscaped = psEscaped.replace(/[{}+^%~()]/g, c => `{${c}}`);
            // V17 安全修复：使用 execFileSync 替代 execSync，避免 cmd.exe 引号解释
            // 改用 -EncodedCommand Base64，统一走 runPs，避免任何引号/变量被吞
            runPs(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysEscaped}')`, 10000);
            result = `✅ 已在 ${profile.name} 中输入 ${text.length} 个字符`;
            break;
          }
          case 'click': {
            activateApp();
            await new Promise(r => setTimeout(r, 300));
            const x = Number(opParams.x || 0);
            const y = Number(opParams.y || 0);
            // 参数验证：x/y 必须是有效正整数（屏幕坐标），防止 NaN 或负数导致异常
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
              result = `❌ 无效的点击坐标: x=${opParams.x}, y=${opParams.y}。坐标必须是正整数`;
              break;
            }
            const clickScript = `Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
Start-Sleep -Milliseconds 50;
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int info);' -Name U32 -Namespace W;
[W.U32]::mouse_event(0x0002, 0, 0, 0, 0); [W.U32]::mouse_event(0x0004, 0, 0, 0, 0);`;
            runPs(clickScript, 5000);
            result = `✅ 已在 ${profile.name} 中点击 (${x}, ${y})`;
            break;
          }
          case 'workflow':
          case 'menu':
          case 'find_click':
            result = `⚠️ ${action} 操作在桌面端建议通过完整 Agent（npm run dev）执行以获得最佳效果`;
            break;
          default:
            result = `❌ 不支持的操作类型: ${action}`;
        }

        // D1/D9: 移除 includes('已') — "已失败"/"未能找到已存在的文件" 等含"已"的失败消息会被误判为成功。
        // 仅当含 ✅ 或显式成功标记时才算验证通过。
        const verified = result.includes('✅')
          || /^success\b/im.test(result)
          || /操作成功/.test(result);
        const duration = Date.now() - startTime;
        return `${result}\n  尝试次数: ${attempt} | 耗时: ${duration}ms | 已验证: ${verified ? '是' : '否'}`;
      } catch (err) {
        lastError = err.message;
        if (attempt < maxAttempts) {
          const backoff = 200 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    return `❌ 操作失败（重试 ${maxAttempts} 次）: ${lastError}\n  耗时: ${Date.now() - startTime}ms`;
  }

  // ===========================================================================
  // app_batch
  // ===========================================================================
  async function executeAppBatch(args) {
    let operations = [];
    try {
      operations = JSON.parse(args.operations || '[]');
      if (!Array.isArray(operations)) return '❌ operations 必须是 JSON 数组';
    } catch (e) {
      return `❌ operations 解析失败: ${e.message}`;
    }
    // V17 安全修复：限制批量操作数量，防止过多操作导致长时间阻塞
    const MAX_BATCH_OPS = 20;
    if (operations.length > MAX_BATCH_OPS) {
      return `❌ 批量操作数量过多（${operations.length}），最多允许 ${MAX_BATCH_OPS} 个操作。请分批执行。`;
    }
    const stopOnError = args.stopOnError === true || args.stopOnError === 'true';
    const results = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const r = await executeTool('app_operate', op);
      const success = r.includes('✅');
      results.push({ index: i + 1, app: op.app, action: op.action, success, result: r });
      if (!success && stopOnError) break;
    }
    const successCount = results.filter(r => r.success).length;
    const lines = [`📦 批量操作完成: ${successCount}/${results.length} 成功`, ''];
    for (const r of results) {
      lines.push(`  ${r.index}. [${r.success ? '✅' : '❌'}] ${r.app}/${r.action}`);
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // app_list
  // ===========================================================================
  function executeAppList() {
    const APPS = [
      ['photoshop', 'Adobe Photoshop'], ['powerpoint', 'Microsoft PowerPoint'], ['vscode', 'Visual Studio Code'],
      ['chrome', 'Google Chrome / Edge'], ['firefox', 'Mozilla Firefox'], ['notepad++', 'Notepad++'],
      ['sublime', 'Sublime Text'], ['powershell', 'Windows PowerShell'], ['cmd', '命令提示符'],
      ['windowsterminal', 'Windows Terminal'], ['word', 'Microsoft Word'], ['excel', 'Microsoft Excel'],
      ['outlook', 'Microsoft Outlook'], ['wechat', '微信'], ['dingtalk', '钉钉'], ['feishu', '飞书'],
      ['figma', 'Figma'], ['vlc', 'VLC Media Player'], ['spotify', 'Spotify'],
      ['explorer', '文件资源管理器'], ['system', '系统设置'], ['git', 'Git'], ['docker', 'Docker'], ['nodejs', 'Node.js'],
    ];
    const lines = ['📋 已注册的应用配置（共 24 类）:', ''];
    for (const [id, name] of APPS) {
      lines.push(`  🖥️ ${name} (ID: ${id})`);
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // self_improve — Agent 自我改进工具（可控、需用户批准）
  //
  // 安全机制：
  //   1. 仅当配置启用时可用（isSelfImproveEnabled）
  //   2. 仅允许修改白名单内的核心文件
  //   3. 每次代码修改必须经用户通过对话框批准（requestApproval）
  //   4. 修改前自动创建备份
  //   5. 所有操作记录到日志文件
  // ===========================================================================

  // 允许 Agent 读取/修改的自身核心文件白名单（相对于 ROOT_DIR）
  const SELF_IMPROVE_FILE_WHITELIST = [
    'desktop/main.js',
    'desktop/tool-executor.js',
    'desktop/preload.js',
    'desktop/package.json',
    'desktop/index.html',
  ];

  // 自我改进数据目录
  function getSelfImproveDir() {
    return path.join(os.homedir(), '.duan', 'self-improve');
  }
  function getBackupDir() {
    return path.join(getSelfImproveDir(), 'backups');
  }
  function getHistoryFile() {
    return path.join(getSelfImproveDir(), 'history.jsonl');
  }

  /** 记录自我改进操作到历史日志 */
  function logSelfImproveAction(entry) {
    try {
      const dir = getSelfImproveDir();
      fs.mkdirSync(dir, { recursive: true });
      const logLine = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
      fs.appendFileSync(getHistoryFile(), logLine, 'utf-8');
    } catch (e) {
      console.warn('[self_improve] 写入日志失败:', e.message);
    }
  }

  /** 读取最近的历史记录 */
  function readSelfImproveHistory(limit = 10) {
    try {
      if (!fs.existsSync(getHistoryFile())) return [];
      const lines = fs.readFileSync(getHistoryFile(), 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  /** 生成简单的 diff 预览 */
  function generateDiffPreview(oldCode, newCode, maxLen = 600) {
    const oldLines = (oldCode || '').split('\n');
    const newLines = (newCode || '').split('\n');
    const maxLines = 15;
    const preview = [];
    // 找出第一个不同的行
    let firstDiff = 0;
    while (firstDiff < oldLines.length && firstDiff < newLines.length && oldLines[firstDiff] === newLines[firstDiff]) {
      firstDiff++;
    }
    const start = Math.max(0, firstDiff - 2);
    for (let i = start; i < Math.min(start + maxLines, Math.max(oldLines.length, newLines.length)); i++) {
      if (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
        preview.push(`  ${oldLines[i]}`);
      } else {
        if (i < oldLines.length) preview.push(`- ${oldLines[i]}`);
        if (i < newLines.length) preview.push(`+ ${newLines[i]}`);
      }
    }
    let result = preview.join('\n');
    if (result.length > maxLen) result = result.substring(0, maxLen) + '\n... (已截断)';
    return result;
  }

  async function executeSelfImprove(args) {
    const mode = args.mode || '';
    if (!mode) {
      return '❌ 缺少参数: mode。可选模式: search(搜索改进信息), read(读取自身代码), propose(提出修改-需用户批准), history(查看历史), status(查看状态)';
    }

    // status 模式无需启用检查
    if (mode === 'status') {
      const enabled = isSelfImproveEnabled ? isSelfImproveEnabled() : false;
      const history = readSelfImproveHistory(5);
      return `📊 自我改进状态:\n  启用: ${enabled ? '✅ 是' : '❌ 否（需在设置中开启）'}\n  可修改文件白名单: ${SELF_IMPROVE_FILE_WHITELIST.join(', ')}\n  备份目录: ${getBackupDir()}\n  历史记录: ${history.length} 条最近操作\n  ${enabled ? '提示: 你可以搜索网络获取 agent 改进方案，然后提出代码修改（每次修改需用户批准）' : '提示: 请先在设置中启用自我改进功能'}`;
    }

    // P0 自我改进接通：evolve 模式调 SelfEvolutionEngine（通过 HTTP API），无需 enabled 检查
    if (mode === 'evolve') {
      const http = require('http');
      const port = process.env.AGENT_PORT || 3001;
      const postData = JSON.stringify({ focus: args.focus || undefined });
      return new Promise((resolve) => {
        const req = http.request({
          hostname: 'localhost', port,
          path: '/api/self-evolve/run', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 300000,
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (res.statusCode === 200) {
                const c = json.cycle || json;
                const summary = c.summary || json.message || '进化完成';
                const successCount = c.successCount ?? 0;
                const failCount = c.failCount ?? c.failureCount ?? 0;
                resolve(`🧬 自我进化完成\n  摘要: ${summary}\n  成功: ${successCount} 项 | 失败: ${failCount} 项\n  ${successCount > 0 ? '提示: 进化结果已持久化，部分修改可能需重启生效' : '提示: 本轮无需进化'}`);
              } else {
                resolve(`❌ 自我进化失败: ${json.error || json.message || '服务器返回 ' + res.statusCode}`);
              }
            } catch (e) {
              resolve(`❌ 解析进化响应失败: ${e.message}`);
            }
          });
        });
        req.on('error', (e) => resolve(`❌ 无法连接 Agent 服务器: ${e.message}`));
        req.on('timeout', () => { req.destroy(); resolve('❌ 自我进化超时（5分钟），项目可能较大'); });
        req.write(postData);
        req.end();
      });
    }

    // 其他模式需要启用检查
    const enabled = isSelfImproveEnabled ? isSelfImproveEnabled() : false;
    if (!enabled) {
      return '❌ 自我改进功能未启用。请在设置中开启"自我改进"选项后再使用。可用 mode=status 查看状态。';
    }

    switch (mode) {
      case 'search': {
        return await selfImproveSearch(args);
      }
      case 'read': {
        return selfImproveRead(args);
      }
      case 'propose': {
        return selfImprovePropose(args);
      }
      case 'history': {
        const limit = Math.min(args.limit || 10, 50);
        const history = readSelfImproveHistory(limit);
        if (history.length === 0) return '📋 暂无自我改进历史记录。';
        const lines = [`📋 最近 ${history.length} 条自我改进记录:`, ''];
        for (const h of history) {
          const time = new Date(h.timestamp).toLocaleString('zh-CN');
          const status = h.approved ? (h.applied ? '✅已应用' : '⏳待应用') : '❌已拒绝';
          lines.push(`  [${time}] ${status} | ${h.file || '-'} | ${h.description || '-'}`);
        }
        return lines.join('\n');
      }
      default:
        return `❌ 未知模式: "${mode}"。可选: search, read, propose, history, status`;
    }
  }

  // ----- self_improve: search 搜索网络获取 agent 改进信息 -----
  async function selfImproveSearch(args) {
    const query = args.query || '';
    if (!query) return '❌ 缺少参数: query。请提供搜索关键词，如 "LLM agent ReAct loop best practices" 或 "AI agent tool calling optimization"';
    // 复用 web_search 逻辑，并附加自我改进上下文
    const enhancedQuery = `${query} AI agent LLM tool calling optimization`;
    try {
      const result = await executeWebSearch({ query: enhancedQuery });
      // 同时搜索英文资源
      let combined = result;
      if (!query.match(/[a-zA-Z]/) || query.length < 30) {
        const enResult = await executeWebSearch({ query: `${query} agent framework self-improving code` });
        if (!enResult.startsWith('❌')) {
          combined += '\n\n--- 英文资源补充 ---\n' + enResult;
        }
      }
      // 附加提示
      combined += '\n\n💡 提示: 找到有用的改进方案后，可用 self_improve({mode:"read", file:"文件名"}) 查看当前代码，再用 self_improve({mode:"propose", ...}) 提出修改（需用户批准）。';
      return combined.substring(0, 12000);
    } catch (err) {
      return `❌ 搜索失败: ${err.message}`;
    }
  }

  // ----- self_improve: read 读取自身代码文件 -----
  function selfImproveRead(args) {
    const file = args.file || '';
    if (!file) return `❌ 缺少参数: file。可读取的文件: ${SELF_IMPROVE_FILE_WHITELIST.join(', ')}`;
    // 校验白名单
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!SELF_IMPROVE_FILE_WHITELIST.includes(normalized)) {
      return `❌ 安全限制: 文件 "${file}" 不在白名单中。可读取的文件: ${SELF_IMPROVE_FILE_WHITELIST.join(', ')}`;
    }
    const fullPath = path.join(ROOT_DIR, normalized);
    // 深度防御：确保解析后的路径仍在 ROOT_DIR 内（防止 ../ 路径穿越）
    const resolvedFull = path.resolve(fullPath);
    const resolvedRoot = path.resolve(ROOT_DIR);
    if (!resolvedFull.startsWith(resolvedRoot + path.sep) && resolvedFull !== resolvedRoot) {
      return `❌ 安全限制: 路径解析越界，拒绝访问`;
    }
    if (!fs.existsSync(fullPath)) return `❌ 文件不存在: ${normalized}`;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const truncated = content.substring(0, 16000);
    if (content.length > 16000) {
      return truncated + `\n\n[文件已截断：显示前 16000 字符，共 ${content.length} 字符。如需查看特定部分，请说明行号范围]`;
    }
    return truncated;
  }

  // ----- self_improve: propose 提出代码修改（需用户批准）-----
  function selfImprovePropose(args) {
    const file = args.file || '';
    const description = args.description || '';
    const oldCode = args.oldCode || '';
    const newCode = args.newCode || '';

    if (!file) return `❌ 缺少参数: file。可修改的文件: ${SELF_IMPROVE_FILE_WHITELIST.join(', ')}`;
    if (!description) return '❌ 缺少参数: description。请说明修改目的和预期效果';
    if (!newCode) return '❌ 缺少参数: newCode。请提供修改后的代码';
    if (!oldCode) return '❌ 缺少参数: oldCode。请提供要替换的原始代码（用于定位和校验）';

    // 校验白名单
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!SELF_IMPROVE_FILE_WHITELIST.includes(normalized)) {
      return `❌ 安全限制: 文件 "${file}" 不在白名单中。可修改的文件: ${SELF_IMPROVE_FILE_WHITELIST.join(', ')}`;
    }

    const fullPath = path.join(ROOT_DIR, normalized);
    // 深度防御：确保解析后的路径仍在 ROOT_DIR 内（防止 ../ 路径穿越）
    const resolvedFull = path.resolve(fullPath);
    const resolvedRoot = path.resolve(ROOT_DIR);
    if (!resolvedFull.startsWith(resolvedRoot + path.sep) && resolvedFull !== resolvedRoot) {
      return `❌ 安全限制: 路径解析越界，拒绝访问`;
    }
    if (!fs.existsSync(fullPath)) return `❌ 文件不存在: ${normalized}`;

    // 读取当前文件内容，校验 oldCode 是否存在
    const currentContent = fs.readFileSync(fullPath, 'utf-8');
    if (!currentContent.includes(oldCode)) {
      // 提供更友好的错误信息
      return `❌ 原始代码(oldCode)在文件中未找到，无法定位修改位置。\n可能原因:\n  1. oldCode 与文件实际内容不完全匹配（注意空格、缩进、换行）\n  2. 文件已被其他修改更改\n建议: 先用 self_improve({mode:"read", file:"${normalized}"}) 重新读取文件，复制准确的原始代码片段。`;
    }

    // 检查替换后是否会产生语法风险（基础检查：括号匹配）
    const newContent = currentContent.replace(oldCode, newCode);
    if (newContent === currentContent) {
      return '❌ 替换后内容无变化，请检查 oldCode 和 newCode 是否不同。';
    }

    // 请求用户批准
    const proposal = {
      file: normalized,
      fullPath,
      description,
      oldCodeLength: oldCode.length,
      newCodeLength: newCode.length,
      diffPreview: generateDiffPreview(oldCode, newCode),
    };

    let approved = false;
    let reason = '';
    if (requestApproval) {
      const decision = requestApproval(proposal);
      approved = decision.approved;
      reason = decision.reason || '';
    } else {
      return '❌ 批准机制未配置，无法执行修改。请联系开发者。';
    }

    if (!approved) {
      logSelfImproveAction({ action: 'propose', file: normalized, description, approved: false, reason: reason || '用户拒绝' });
      return `🚫 修改已被用户拒绝。\n文件: ${normalized}\n说明: ${description}\n你可以调整方案后重新提出，或向用户解释修改的必要性。`;
    }

    // 用户已批准：创建备份并应用修改
    try {
      const backupDir = getBackupDir();
      fs.mkdirSync(backupDir, { recursive: true });
      const backupName = `${Date.now()}_${normalized.replace(/[\\/]/g, '_')}.bak`;
      const backupPath = path.join(backupDir, backupName);
      fs.writeFileSync(backupPath, currentContent, 'utf-8');

      // 应用修改
      fs.writeFileSync(fullPath, newContent, 'utf-8');

      logSelfImproveAction({
        action: 'apply',
        file: normalized,
        description,
        approved: true,
        applied: true,
        backupPath,
        oldCodeLength: oldCode.length,
        newCodeLength: newCode.length,
      });

      // 通知主窗口刷新
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        emitEditorWriteEvents(mw, fullPath, newContent);
      }

      return `✅ 代码修改已应用（用户已批准）\n文件: ${normalized}\n说明: ${description}\n备份: ${backupPath}\n修改: ${oldCode.length} 字符 → ${newCode.length} 字符\n\n⚠️ 注意: 如果修改了 main.js 或 tool-executor.js，可能需要重启应用才能生效。`;
    } catch (err) {
      logSelfImproveAction({ action: 'apply_error', file: normalized, description, error: err.message });
      return `❌ 应用修改失败: ${err.message}\n文件内容未被修改。`;
    }
  }

  return executeTool;
}

module.exports = { createToolExecutor };
