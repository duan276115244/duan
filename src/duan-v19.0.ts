import 'dotenv/config';
import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
import * as fs from 'fs';
import * as path from 'path';

import { setupAgentLoop, type AgentLoopCallbacks } from './core/bootstrap.js';
import { setToolRegistry } from './server/services/tools.js';
import { EmotionTracker } from './core/emotion-tracker.js';
import { duanPath } from './core/duan-paths.js';
import { handleCommand, type CLIContext } from './core/cli-commands.js';
import { ConfigManager } from './config.js';
import { getMCPSecurityGuard } from './core/mcp-security.js';
import { atomicWriteJsonSync } from './core/atomic-write.js';

// ========== 主题色 ==========
const C = {
  pri: chalk.hex('#8B5CF6'),
  sec: chalk.hex('#06B6D4'),
  suc: chalk.hex('#10B981'),
  err: chalk.hex('#EF4444'),
  warn: chalk.hex('#F59E0B'),
  txt: chalk.hex('#E2E8F0'),
  dim: chalk.hex('#64748B'),
  gray: chalk.hex('#94A3B8'),
  accent: chalk.hex('#EC4899'),
  cyan: chalk.hex('#00D4FF'),
  bg: chalk.hex('#0F172A'),
};

interface TUIState {
  connected: boolean;
  model: string;
  provider: string;
  turns: number;
  mode: string;
  level: number;
  elapsedMs?: number;
  toolCalls: Array<{ name: string; status: 'running' | 'done' | 'error' }>;
}

function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1Bc');
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function printLogo(): void {
  console.info('');
  console.info(C.pri.bold(figlet.textSync('DUAN', { font: 'ANSI Shadow', width: 80, whitespaceBreak: true })));
  console.info(`  ${C.dim('─'.repeat(60))}`);
  console.info(`  ${C.pri.bold('段先生')}  ${C.accent('·')}  ${C.txt('Mr.Duan')}  ${C.gray('v19.0 · 超级智能体')}`);
  console.info(`  ${C.dim('─'.repeat(60))}`);
  console.info('');
}

function renderStatusBar(state: TUIState): void {
  const dot = state.connected ? C.suc('●') : C.err('●');
  const status = state.connected ? C.suc('在线') : C.err('离线');
  const providerName = state.provider || 'unknown';
  const modelName = state.model || 'unknown';
  const width = 76;
  const top = `  ${C.pri('╭' + '─'.repeat(width) + '╮')}`;
  const mid = `  ${C.pri('│')} ${dot} ${status}   ${C.dim('│')}   ${C.pri('⚡ 反应模式')}   ${C.dim('│')}   ${C.accent(`Lv.${state.level}`)}   ${C.dim('│')}   ${C.txt('轮次')}: ${state.turns}${' '.repeat(Math.max(0, width - 40))}${C.pri('│')}`;
  const mid2 = `  ${C.pri('│')} ${C.dim('模型')}: ${C.cyan(providerName)} / ${C.txt(modelName)}${' '.repeat(Math.max(0, width - 20 - providerName.length - modelName.length))}${C.pri('│')}`;
  const bot = `  ${C.pri('╰' + '─'.repeat(width) + '╯')}`;
  console.info(top);
  console.info(mid);
  console.info(mid2);
  console.info(bot);
  console.info('');
}

function printWelcome(): void {
  console.info(C.pri('  ✨ 欢迎使用段先生 v19.0'));
  console.info(C.dim('  ─'.repeat(30)));
  console.info(C.txt('  我是你的超级智能体，可以帮你：'));
  console.info(C.gray('    ◈ 编程开发    ◈ 文件操作    ◈ 浏览器自动化'));
  console.info(C.gray('    ◈ 数据分析    ◈ 桌面控制    ◈ 代码生成'));
  console.info(C.gray('    ◈ 经验学习    ◈ 本地推理    ◈ 最优路径'));
  console.info('');
  console.info(C.dim('  输入 ') + C.pri('"help"') + C.dim(' 查看所有命令'));
  console.info(C.dim('  输入 ') + C.pri('"config"') + C.dim(' 重新配置 AI 模型'));
  console.info(C.dim('  输入 ') + C.pri('"exit"') + C.dim(' 退出程序'));
  console.info('');
}

function printHelp(): void {
  console.info('');
  console.info(C.pri.bold('  📖 命令帮助'));
  console.info(C.dim('  ─'.repeat(30)));
  console.info('');

  // P1-1 修复：与 cli-commands.ts 实际支持的 34 个命令保持一致
  const groups = [
    { title: '💬 对话', commands: [
      ['直接输入', '与 AI 对话'],
    ]},
    { title: '⚙️  基础', commands: [
      ['help', '显示帮助'],
      ['status', '查看系统状态'],
      ['channels', '查看通道状态'],
      ['mode', '设置思考模式'],
      ['auto', '切换自动模式'],
      ['clear', '清空对话'],
      ['exit/quit', '退出程序'],
    ]},
    { title: '🔧 配置', commands: [
      ['setup/configure', '打开配置向导'],
      ['config', '查看当前配置'],
      ['model', '切换 AI 模型'],
      ['upgrade', '系统升级'],
    ]},
    { title: '🧠 智能', commands: [
      ['think', '深度推理'],
      ['decide', '自主决策'],
      ['assess', '自我评估'],
      ['diagnose', '系统诊断'],
      ['mood', '情绪状态'],
    ]},
    { title: '📈 进化', commands: [
      ['memory', '记忆系统'],
      ['learn', '学习系统'],
      ['skills', '技能库'],
      ['strategies', '策略库'],
      ['goals', '目标追踪'],
      ['self-evolve', '自我进化'],
      ['evolve', '执行进化'],
      ['consciousness', '意识状态'],
    ]},
    { title: '🛠️  工程', commands: [
      ['test', '功能测试'],
      ['benchmark', '性能测试'],
      ['repair', '自愈修复'],
      ['optimize', '系统优化'],
      ['knowledge', '知识库'],
    ]},
  ];

  for (const group of groups) {
    console.info(`  ${C.accent(group.title)}`);
    for (const [cmd, desc] of group.commands) {
      console.info(`    ${C.pri(cmd.padEnd(16))} ${C.gray(desc)}`);
    }
    console.info('');
  }
}

export async function runDuan(): Promise<void> {
  const config = new ConfigManager();
  
  // 确保环境变量已加载
  config.applyEnv();
  
  // 启动时显示欢迎界面
  clearScreen();
  printLogo();
  
  if (!config.isConfigured()) {
    console.info(C.warn('  ⚠️  尚未配置 AI 模型'));
    console.info('');
    const { startConfig } = await inquirer.prompt([{
      type: 'confirm',
      name: 'startConfig',
      message: C.pri('是否现在运行配置向导？'),
      default: true,
    }]);
    
    if (startConfig) {
      const { runSetupWizard } = await import('./setup-wizard.js');
      await runSetupWizard(config);
      if (!config.isConfigured()) {
        console.info(C.err('\n  ✗ 配置未完成，无法启动 AI 助手'));
        await sleep(2000);
        return;
      }
    } else {
      console.info(C.dim('\n  稍后可输入 ') + C.pri('"config"') + C.dim(' 进行配置'));
      await sleep(1500);
    }
  }
  
  const tuiState: TUIState = {
    connected: true,
    model: process.env.DEFAULT_MODEL || 'unknown',
    provider: process.env.DEFAULT_MODEL_PROVIDER || '',
    turns: 0,
    mode: '⚡ 反应模式',
    level: 5,
    toolCalls: [],
  };
  
  // 显示主界面
  clearScreen();
  printLogo();
  printWelcome();
  renderStatusBar(tuiState);

  // 装配 MCP 安全审批回调（CLI 交互式审批）
  getMCPSecurityGuard().setApprovalCallback(async (serverId, toolName, args, risk) => {
    console.info('');
    console.info(C.pri.bold('  🛡️  MCP 工具审批请求'));
    console.info(C.dim('  ─'.repeat(40)));
    console.info(`  ${C.txt('插件')}: ${C.cyan(serverId)}`);
    console.info(`  ${C.txt('工具')}: ${C.cyan(toolName)}`);
    console.info(`  ${C.txt('风险')}: ${(() => {
      if (risk === 'critical') return C.err(risk);
      if (risk === 'high') return C.warn(risk);
      return C.txt(risk);
    })()}`);
    const argsStr = JSON.stringify(args).slice(0, 200);
    console.info(`  ${C.txt('参数')}: ${C.dim(argsStr)}`);
    console.info('');
    const { approved } = await inquirer.prompt([{
      type: 'confirm',
      name: 'approved',
      message: C.pri('是否批准执行此操作？'),
      default: false,
    }]);
    return approved;
  });

  const callbacks: AgentLoopCallbacks = {
    planReviewCallback: async (plan) => {
      console.info('');
      console.info(C.pri.bold('  📋 执行计划'));
      console.info(C.dim('  ─'.repeat(30)));
      console.info(`  ${C.txt('目标')}: ${C.cyan(plan.goal)}`);
      console.info('');
      
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const riskIcons: Record<string, string> = { safe: '○', moderate: '◇', dangerous: '◆' };
        const riskColor = (() => {
          if (step.estimatedRisk === 'safe') return C.suc;
          if (step.estimatedRisk === 'moderate') return C.warn;
          return C.err;
        })();
        console.info(`  ${riskColor(riskIcons[step.estimatedRisk] || '○')} ${C.dim(`${i + 1}.`)} ${C.txt(step.description)}`);
      }
      console.info('');
      
      const { action } = await inquirer.prompt([{
        type: 'list', name: 'action',
        message: C.pri('  是否批准此计划？'),
        choices: [
          { name: `${C.suc('✓')} 批准并执行`, value: 'approve' },
          { name: `${C.sec('✎')} 修改后执行`, value: 'modify' },
          { name: `${C.err('✗')} 取消`, value: 'reject' },
        ],
      }]);
      return { approved: action !== 'reject', modified: action === 'modify' };
    },
    approvalCallback: async (request) => {
      const riskIcons: Record<string, string> = { safe: '○', moderate: '◇', dangerous: '◆', critical: '⛔' };
      const riskColor = (() => {
        if (request.riskLevel === 'safe' || request.riskLevel === 'moderate') return C.suc;
        if (request.riskLevel === 'dangerous') return C.warn;
        return C.err;
      })();
      console.info('');
      console.info(`  ${riskColor(riskIcons[request.riskLevel] || '○')} ${C.cyan(request.toolName)}`);
      console.info(`  ${C.dim(request.reason)}`);
      console.info('');
      
      // safe 和 moderate 自动通过，不再询问用户
      if (request.riskLevel === 'safe' || request.riskLevel === 'moderate') return { approved: true };
      
      // dangerous 和 critical 需要用户确认
      const { action } = await inquirer.prompt([{
        type: 'list', name: 'action',
        message: C.pri('  是否允许此操作？'),
        choices: [
          { name: `${C.suc('✓')} 允许（仅此次）`, value: 'approve' },
          { name: `${C.accent('⏻')} 总是允许 ${request.toolName}`, value: 'always' },
          { name: `${C.err('✗')} 拒绝`, value: 'reject' },
        ],
      }]);
      return { approved: action !== 'reject', remember: action === 'always' };
    },
  };

  const { modules, registry, loop: enhancedAgentLoop } = await setupAgentLoop(callbacks);
  // 消灭孤岛 I-3：将 registry 注入 tools.ts，使 executeTool 走统一注册路径
  // 详见 v19 方案 §4.2 I-3
  setToolRegistry(registry);
  const emotionTracker = new EmotionTracker();

  // P0 交互自然度修复：会话历史持久化 — 跨会话恢复对话上下文
  // 之前 conversationHistory 仅内存态，进程退出即丢失，重启后"失忆"。
  // 现在持久化到磁盘，启动时自动恢复，/clear 命令清空持久化文件。
  const historyPath = duanPath('conversation-history.json');
  function loadHistory(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
    try {
      if (!fs.existsSync(historyPath)) return [];
      const raw = fs.readFileSync(historyPath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return data.filter((m: any) => m && typeof m.role === 'string' && typeof m.content === 'string');
      }
    } catch (e) {
      console.warn('[duan] 加载对话历史失败:', e instanceof Error ? e.message : String(e));
    }
    return [];
  }
  function saveHistory(): void {
    try {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      // 限制持久化大小：保留最近 50 条消息
      const toSave = conversationHistory.slice(-50);
      atomicWriteJsonSync(historyPath, toSave);
    } catch (e) {
      console.warn('[duan] 保存对话历史失败:', e instanceof Error ? e.message : String(e));
    }
  }
  const persistedHistory = loadHistory();
  const conversationHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
    {
      role: 'system',
      content: '你是段先生 v19.0，一个具备经验学习能力的超级智能体。',
    },
    ...persistedHistory,
  ];
  if (persistedHistory.length > 0) {
    console.info(chalk.dim(`  ✓ 已恢复 ${persistedHistory.length} 条历史对话`));
  }

  async function processWithAgent(
    input: string,
    images?: Array<{ url: string; mimeType?: string }>,
  ): Promise<void> {
    emotionTracker.process({ type: 'user_input', content: input });
    const emotionalPrompt = emotionTracker.getEmotionalPrompt();
    conversationHistory.push({ role: 'user', content: `${input}\n\n${emotionalPrompt}` });

    tuiState.toolCalls = [];
    const startTime = Date.now();

    const agentLoop = enhancedAgentLoop.run(
      input,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conversationHistory.slice(0, -1) as any,
      undefined,
      images && images.length > 0 ? { images } : undefined,
    );
    let fullResponse = '';
    let currentLine = '';
    let spinTimer: ReturnType<typeof setInterval> | null = null;
    const thinkDots = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let spinIdx = 0;
    let spinStartTime = Date.now();
    // P0 可访问性：屏读器/无颜色模式下禁用 Braille 动画（屏读器会逐帧朗读每个字符）
    const _accessibilityMode = (process as { __duanNoColor?: boolean }).__duanNoColor || !!process.env.NO_COLOR;
    let _spinActive = false;

    function startSpin() {
      if (spinTimer || _spinActive) return;
      _spinActive = true;
      spinStartTime = Date.now();
      if (_accessibilityMode) {
        // 屏读器友好：输出一次静态文本，不持续刷新（避免屏读器逐帧朗读）
        process.stdout.write(`  思考中...\n`);
        return;
      }
      spinTimer = setInterval(() => {
        const frame = thinkDots[spinIdx % thinkDots.length];
        const elapsed = ((Date.now() - spinStartTime) / 1000).toFixed(0);
        process.stdout.write(`\r${C.cyan(`  ${frame}`)} ${C.dim(`思考中... (${elapsed}s)`)}    `);
        spinIdx++;
      }, 80);
    }

    function stopSpin() {
      _spinActive = false;
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      if (!_accessibilityMode) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
      }
    }

    startSpin();

    try {
      for await (const event of agentLoop) {
        if (event.type === 'text') {
          stopSpin();
          currentLine += event.content;
          if (event.content.endsWith('\n')) {
            process.stdout.write(`  ${currentLine}`);
            fullResponse += currentLine;
            currentLine = '';
          }
        } else if (event.type === 'tool_call') {
          stopSpin();
          const toolName = event.toolName || '';
          console.info(`  ${C.sec('⟐')} ${C.cyan(toolName)}`);
          startSpin();
        } else if (event.type === 'tool_result') {
          stopSpin();
          const content = event.content || '';
          const ok = !content.startsWith('❌') && !content.startsWith('✗');
          const icon = ok ? C.suc('✓') : C.err('✗');
          const display = content.length > 80 ? content.substring(0, 80) + '…' : content;
          console.info(`    ${icon} ${C.dim(display)}`);
          startSpin();
        } else if (event.type === 'think') {
          stopSpin();
          console.info(`  ${C.accent('◈')} ${C.pri(event.content)}`);
          startSpin();
        } else if (event.type === 'error') {
          stopSpin();
          console.info(`  ${C.err('✗')} ${C.err(event.content)}`);
          tuiState.connected = false;
          startSpin();
        } else if (event.type === 'warning') {
          stopSpin();
          console.info(`  ${C.warn('⚠')} ${C.dim(event.content)}`);
          startSpin();
        }
      }
    } catch (err: unknown) {
      stopSpin();
      console.info(`  ${C.err('✗')} ${C.err(`处理异常: ${(err instanceof Error ? err.message : String(err)) || err}`)}`);
      // P0 可访问性：--verbose 模式输出完整错误堆栈
      const errStack = err instanceof Error ? err.stack : undefined;
      if ((process as { __duanVerbose?: boolean }).__duanVerbose && errStack) {
        console.info(C.dim(errStack));
      }
    } finally {
      stopSpin();
    }

    fullResponse += currentLine;
    if (currentLine) {
      process.stdout.write(`  ${currentLine}\n`);
    }

    tuiState.elapsedMs = Date.now() - startTime;
    tuiState.turns++;
    tuiState.connected = true;
    tuiState.model = process.env.DEFAULT_MODEL || tuiState.model;
    tuiState.provider = process.env.DEFAULT_MODEL_PROVIDER || tuiState.provider;

    if (fullResponse) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.info(`\n  ${C.dim('─'.repeat(60))} ${C.gray(`${elapsed}s`)}`);
      conversationHistory.push({ role: 'assistant', content: fullResponse });
      // P0 交互自然度修复：持久化会话历史（跨会话恢复）
      saveHistory();
    }
  }

  // 主循环
  while (true) {
    try {
      const { userInput } = await inquirer.prompt([{
        type: 'input',
        name: 'userInput',
        message: C.pri.bold('❯'),
        prefix: '',
        validate: (val) => val.trim().length > 0 || '请输入内容',
      }]);

      const input = userInput.trim();
      if (!input) continue;

      // P0 真实多模态：/image <path> [prompt] — 上传图片让 agent "看"
      // 对标 Claude Code 的图像粘贴能力。支持 jpg/png/gif/webp/bmp。
      // 用法: /image photo.png 这张图里有什么？ 或 /image photo.png
      let multimodalImages: Array<{ url: string; mimeType?: string }> | undefined;
      let effectiveInput = input;
      if (input.startsWith('/image ') || input.startsWith('/img ')) {
        const parts = input.split(/\s+/);
        if (parts.length >= 2) {
          const imgPath = parts[1];
          const prompt = parts.slice(2).join(' ') || '请描述这张图片的内容。';
          try {
            const resolved = path.resolve(imgPath);
            if (!fs.existsSync(resolved)) {
              console.info(C.err(`  ✗ 图片文件不存在: ${imgPath}`));
              continue;
            }
            const ext = path.extname(resolved).toLowerCase().slice(1);
            const mimeMap: Record<string, string> = {
              jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
              gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
            };
            const mime = mimeMap[ext];
            if (!mime) {
              console.info(C.err(`  ✗ 不支持的图片格式: ${ext}（支持 jpg/png/gif/webp/bmp）`));
              continue;
            }
            const buf = fs.readFileSync(resolved);
            // 限制 10MB 避免上下文爆炸
            if (buf.length > 10 * 1024 * 1024) {
              console.info(C.err(`  ✗ 图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB)，请压缩到 10MB 以下`));
              continue;
            }
            const b64 = buf.toString('base64');
            const dataUrl = `data:${mime};base64,${b64}`;
            multimodalImages = [{ url: dataUrl, mimeType: mime }];
            effectiveInput = prompt;
            console.info(C.dim(`  📎 已加载图片: ${path.basename(resolved)} (${(buf.length / 1024).toFixed(0)}KB)`));
          } catch (err: unknown) {
            console.info(C.err(`  ✗ 图片读取失败: ${(err instanceof Error ? err.message : String(err))}`));
            continue;
          }
        }
      }

      // 内置命令处理
      if (input === 'exit' || input === 'quit') {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: C.pri('确定要退出吗？'),
          default: false,
        }]);
        if (confirm) {
          console.info('');
          console.info(C.dim('  👋 再见！期待下次相见。'));
          await sleep(800);
          break;
        }
        continue;
      }

      if (input === 'clear' || input === 'cls') {
        clearScreen();
        printLogo();
        renderStatusBar(tuiState);
        continue;
      }

      if (input === 'help' || input === '?') {
        printHelp();
        await inquirer.prompt([{ type: 'input', name: 'ok', message: C.dim('按回车继续...'), prefix: '' }]);
        clearScreen();
        printLogo();
        renderStatusBar(tuiState);
        continue;
      }

      if (input === 'info' || input === 'status') {
        console.info('');
        console.info(C.pri.bold('  📊 系统信息'));
        console.info(C.dim('  ─'.repeat(30)));
        console.info(C.txt(config.getSummary()));
        console.info('');
        await inquirer.prompt([{ type: 'input', name: 'ok', message: C.dim('按回车继续...'), prefix: '' }]);
        continue;
      }

      if (input === 'config' || input === 'setup' || input === 'configure') {
        const { runSetupWizard } = await import('./setup-wizard.js');
        console.info('');
        await runSetupWizard(config);
        // 重新应用环境变量
        config.applyEnv();
        tuiState.model = process.env.DEFAULT_MODEL || tuiState.model;
        tuiState.provider = process.env.DEFAULT_MODEL_PROVIDER || tuiState.provider;
        renderStatusBar(tuiState);
        continue;
      }

      if (input === 'switch') {
        const profiles = config.getProfiles();
        if (profiles.length === 0) {
          console.info(C.err('\n  ✗ 没有可用的配置，请先运行 ') + C.pri('"config"') + C.err(' 进行配置'));
          await sleep(2000);
          continue;
        }
        const { selected } = await inquirer.prompt([{
          type: 'list', name: 'selected',
          message: C.pri('  选择要切换的模型'),
          choices: profiles.map(p => ({
            name: `${C.cyan(p.label)}  ${C.dim('·')}  ${C.gray(p.provider + '/' + p.model)}`,
            value: p.id,
          })),
        }]);
        config.setDefaultProfile(selected);
        config.applyEnv();
        tuiState.model = process.env.DEFAULT_MODEL || 'unknown';
        tuiState.provider = process.env.DEFAULT_MODEL_PROVIDER || '';
        console.info(C.suc(`\n  ✓ 已切换到: ${tuiState.provider}/${tuiState.model}`));
        await sleep(1000);
        renderStatusBar(tuiState);
        continue;
      }

      // 尝试作为 CLI 命令处理
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cliCtx: CLIContext = { modules, loop: enhancedAgentLoop, systemState: {} as any };
      let cmdResult: string | null = null;
      try {
        cmdResult = await handleCommand(input, cliCtx);
      } catch {
        // 忽略命令处理错误，继续作为对话处理
      }

      if (cmdResult === 'CLEAR_HISTORY') {
        conversationHistory.splice(1);
        // P0 交互自然度修复：同步清空持久化历史
        try { if (fs.existsSync(historyPath)) fs.unlinkSync(historyPath); } catch (e) { console.warn('[duan] 清空历史文件失败:', e instanceof Error ? e.message : String(e)); }
        console.info(C.dim('  ✓ 对话已清空'));
        await sleep(800);
        continue;
      }

      if (cmdResult !== null && cmdResult !== undefined) {
        if (cmdResult) console.info(`\n  ${cmdResult}`);
        continue;
      }

      // 智能体对话（传入多模态图片）
      await processWithAgent(effectiveInput, multimodalImages);
      renderStatusBar(tuiState);

    } catch (err: unknown) {
      if ((err instanceof Error ? err.message : String(err))?.includes('User force closed') || (err instanceof Error ? err.message : String(err))?.includes('SIGINT')) break;
      console.info(C.err(`  ✗ 异常: ${(err instanceof Error ? err.message : String(err)) || err}`));
      // P0 可访问性：--verbose 模式输出完整错误堆栈
      const errStack = err instanceof Error ? err.stack : undefined;
      if ((process as { __duanVerbose?: boolean }).__duanVerbose && errStack) {
        console.info(C.dim(errStack));
      }
      continue;
    }
  }
}

// 启动入口由 entry.ts 统一调用 runDuan()
// 注意：此处不能再顶层调用 runDuan()，否则当 entry.ts 动态 import 本模块时
// 会触发一次自动启动，加上 entry.ts 的显式调用 → 两个 runDuan 实例并发，
// 导致每个用户输入被处理两次（双份对话/双份状态栏/双份日志）。
// 如需独立运行此文件（如 tsx src/duan-v19.0.ts），保留下方显式入口：

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runDuan().catch(err => {
    console.error(chalk.hex('#EF4444')(`\n  ✗ 启动失败: ${err.message || err}`));
    if ((process as { __duanVerbose?: boolean }).__duanVerbose && err?.stack) {
      console.error(err.stack);
    } else {
      console.error(chalk.dim('  使用 --verbose 查看完整堆栈'));
    }
    process.exit(1);
  });
}
