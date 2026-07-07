/**
 * Agent 后端进程管理子系统
 * 从 desktop/main.js 抽出 — 工厂模式
 *
 * 依赖：loadConfig / updateTrayStatus / getMainWindow / ROOT_DIR /
 *       setAgentProcess / getAgentProcess / setAgentPort / getAgentPort / getIsQuitting
 *
 * 内部状态：agentRestartCount / agentIntentionalStop / isStopping / isStarting
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * @param {{
 *   loadConfig: () => any,
 *   updateTrayStatus: (state: string, detail?: string) => void,
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   ROOT_DIR: string,
 *   setAgentProcess: (p: any) => void,
 *   getAgentProcess: () => any,
 *   setAgentPort: (p: number) => void,
 *   getAgentPort: () => number,
 *   getIsQuitting: () => boolean,
 * }} deps
 */
function createAgentProcess(deps) {
  const {
    loadConfig,
    updateTrayStatus,
    getMainWindow,
    ROOT_DIR,
    setAgentProcess,
    getAgentProcess,
    setAgentPort,
    getAgentPort,
    getIsQuitting,
  } = deps;

  // P1-8 修复：Agent 进程崩溃自动重启（指数退避，最多 3 次）
  // P0-2 修复：增加 isStopping 标志防止 stop/start 竞态条件
  let agentRestartCount = 0;
  let agentIntentionalStop = false;
  let isStopping = false; // P0-2: 标记正在停止中，防止 stop 期间 start
  let isStarting = false; // P1 修复：标记正在启动中，防止竞态条件导致双进程
  const AGENT_MAX_RESTARTS = 3;
  const AGENT_RESTART_DELAYS = [2000, 5000, 10000]; // 指数退避

  /**
   * P0-2 修复：检查端口是否可用（防止端口冲突导致重启循环）
   * @param {number} port 端口号
   * @returns {Promise<boolean>} 端口是否可用
   */
  function checkPortAvailable(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const tester = net.createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port);
    });
  }

  // 使用命名函数表达式以便递归引用（startAgent 内部 setTimeout 调用 startAgent）
  const startAgent = async function startAgent() {
    // P0-2 修复：防止竞态条件
    if (getAgentProcess()) return;
    if (isStopping) {
      console.log('[Agent] 正在停止中，跳过启动请求');
      return;
    }
    // P1 修复：防止并发启动导致双进程
    if (isStarting) {
      console.log('[Agent] 正在启动中，跳过重复启动请求');
      return;
    }
    isStarting = true;

    try {

      const config = loadConfig();
      const agentPort = config.agentPort || 3001;
      setAgentPort(agentPort);

      // P0-2 修复：启动前检查端口可用性
      const portAvailable = await checkPortAvailable(agentPort);
      let resolvedPort = agentPort;
      if (!portAvailable) {
        console.error(`[Agent] 端口 ${agentPort} 已被占用，尝试使用其他端口`);
        // 尝试递增端口
        for (let offset = 1; offset <= 10; offset++) {
          const tryPort = agentPort + offset;
          if (await checkPortAvailable(tryPort)) {
            resolvedPort = tryPort;
            setAgentPort(tryPort);
            console.log(`[Agent] 使用备选端口: ${resolvedPort}`);
            break;
          }
        }
        if (!await checkPortAvailable(resolvedPort)) {
          console.error('[Agent] 无法找到可用端口，放弃启动');
          const mw = getMainWindow();
          if (mw && !mw.isDestroyed()) {
            mw.webContents.send('agent:crashed', {
              reason: 'port_in_use',
              message: `端口 ${resolvedPort} 被占用且无可用备选端口`,
            });
          }
          return;
        }
      }

      // 优先使用编译后的 dist/ 入口（快速启动），回退到 tsx（开发模式）
      // 关键：始终使用 entry.ts/entry.js 作为入口（而非 duan-v17.0.ts），
      // 因为 entry.ts 会启动 Web 服务（含消息通道网关/飞书 WebSocket）+ Agent
      const isWin = process.platform === 'win32';
      const distEntry = path.join(ROOT_DIR, 'dist', 'entry.js');
      const srcEntry = path.join(ROOT_DIR, 'src', 'entry.ts');
      const useCompiled = fs.existsSync(distEntry);
      const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'node';
      const args = isWin
        ? (useCompiled ? ['/c', 'node', distEntry] : ['/c', 'npx', 'tsx', srcEntry])
        : (useCompiled ? [distEntry] : ['--import', 'tsx', srcEntry]);

      const agentProcess = spawn(cmd, args, {
        cwd: ROOT_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PORT: String(resolvedPort),
          WEB_PORT: String(resolvedPort), // 关键：设置 WEB_PORT 让 entry.ts 启动 Web 服务（含消息通道网关）
        },
      });
      setAgentProcess(agentProcess);

      // P1-3 修复：启动时更新托盘状态
      updateTrayStatus('starting', `端口 ${resolvedPort}`);

      agentProcess.stdout.on('data', (data) => {
        const text = data.toString();
        // 检测端口号
        const portMatch = text.match(/Server running on port (\d+)/i) || text.match(/listening.*?(\d{4,5})/i);
        if (portMatch) {
          const detectedPort = parseInt(portMatch[1], 10);
          setAgentPort(detectedPort);
          console.log(`[Agent] 检测到后端端口: ${detectedPort}`);
        }
        // P0 修复：过滤 CLI 显示输出，只转发 SSE 格式的数据给前端
        // 之前的行为是将所有 stdout 转发给前端，导致 CLI 的"认知决策""意识状态"等假响应污染聊天界面
        // 现在只转发以 "data: " 开头的行（SSE 格式），其余 CLI 输出仅记录到控制台
        const lines = text.split('\n');
        const sseLines = lines.filter(line => line.startsWith('data: '));
        const mw = getMainWindow();
        if (sseLines.length > 0 && mw && !mw.isDestroyed()) {
          mw.webContents.send('agent:stream', { type: 'stdout', data: sseLines.join('\n') });
        }
        // 非 SSE 输出（CLI 显示、ANSI 控制字符等）仅记录到主进程控制台，不转发给前端
        const nonSseLines = lines.filter(line => !line.startsWith('data: ') && line.trim());
        if (nonSseLines.length > 0) {
          console.log(`[Agent CLI] ${nonSseLines.join(' | ').substring(0, 200)}`);
        }
      });

      agentProcess.stderr.on('data', (data) => {
        const text = data.toString();
        const mw = getMainWindow();
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('agent:stream', { type: 'stderr', data: text });
        }
      });

      agentProcess.on('close', (code) => {
        console.log(`Agent 进程退出，代码: ${code}`);
        setAgentProcess(null);
        isStopping = false; // 进程已退出，清除停止标志

        // P1-3 修复：更新托盘状态
        updateTrayStatus('stopped', `退出码 ${code}`);

        const mw = getMainWindow();
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('system:status-change', { agentRunning: false });
        }

        // P1-8 修复：非主动停止时自动重启
        if (!agentIntentionalStop && agentRestartCount < AGENT_MAX_RESTARTS) {
          const delay = AGENT_RESTART_DELAYS[agentRestartCount] || 10000;
          agentRestartCount++;
          console.log(`[Agent] 将在 ${delay}ms 后自动重启（第 ${agentRestartCount} 次重试）...`);
          // P1-3 修复：更新托盘为重启中状态
          updateTrayStatus('restarting', `第 ${agentRestartCount}/${AGENT_MAX_RESTARTS} 次重试，${Math.round(delay / 1000)}s 后`);
          if (mw && !mw.isDestroyed()) {
            mw.webContents.send('agent:restarting', {
              attempt: agentRestartCount,
              maxAttempts: AGENT_MAX_RESTARTS,
              delayMs: delay,
            });
          }
          setTimeout(() => {
            if (!agentIntentionalStop) {
              startAgent();
            }
          }, delay);
        } else if (!agentIntentionalStop) {
          console.error('[Agent] 已达到最大重启次数，不再重试');
          // P1-3 修复：更新托盘为崩溃状态
          updateTrayStatus('crashed', '已达最大重启次数');
          if (mw && !mw.isDestroyed()) {
            mw.webContents.send('agent:crashed', {
              reason: 'max_retries_exceeded',
              message: 'Agent 进程多次重启失败，请手动重启应用',
            });
          }
        }
      });

      agentProcess.on('error', (err) => {
        console.error('Agent 进程启动失败:', err);
        setAgentProcess(null);
        isStopping = false;
        // P1-3 修复：更新托盘为崩溃状态
        updateTrayStatus('crashed', err.message);
        const mw = getMainWindow();
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('agent:crashed', {
            reason: 'spawn_error',
            message: `Agent 启动失败: ${err.message}`,
          });
        }
      });

      // P2-1 修复：成功启动后重置重启计数（spawn 事件表示进程已创建）
      agentProcess.on('spawn', () => {
        agentRestartCount = 0;
        agentIntentionalStop = false; // P0 修复：重置主动停止标志，使后续崩溃可触发自动重启
        console.log('[Agent] 进程启动成功');
        // P1-3 修复：进程创建成功后更新托盘为运行中
        updateTrayStatus('running', `端口 ${getAgentPort()}`);
      });
    } finally {
      isStarting = false; // P1 修复：无论成功失败，清除启动标志
    }
  };

  /**
   * 停止 Agent 进程
   * P0-2 修复：增加 isStopping 标志，使用 tree-kill 清理子进程树
   * @returns {Promise<void>} 进程退出后 resolve
   */
  function stopAgent() {
    agentIntentionalStop = true; // P1-8 修复：标记为主动停止
    const agentProcess = getAgentProcess();
    if (agentProcess) {
      isStopping = true; // P0-2: 标记正在停止
      const proc = agentProcess;
      // P1-8 修复：先移除监听器，再 kill
      try { proc.removeAllListeners(); } catch (_) {}
      try {
        // P0-2 修复：Windows 下使用 taskkill 杀整个进程树，防止孤儿进程
        if (process.platform === 'win32' && proc.pid) {
          const { execSync } = require('child_process');
          try {
            execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
          } catch (_) {
            // taskkill 失败时回退到普通 kill
            try { proc.kill(); } catch (_) {}
          }
        } else {
          proc.kill();
        }
      } catch (_) {}
      setAgentProcess(null);
      // P0-2: 给进程一点时间退出，然后清除 isStopping
      setTimeout(() => { isStopping = false; }, 1000);
    }
  }

  return { startAgent, stopAgent, checkPortAvailable };
}

module.exports = { createAgentProcess };
