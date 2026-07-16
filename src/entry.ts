#!/usr/bin/env node
import 'dotenv/config';
import * as fs from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { ConfigManager } from './config.js';
import { runSetupWizard } from './setup-wizard.js';
import { colors, modelInfoLine } from './core/cli-display.js';
// P0 可访问性：i18n — 让 CLI 文本支持中英文双语（DUAN_LANG/--lang/LANG 触发）
import { t as i18nT } from './core/i18n.js';

// P0 可访问性修复：支持 --no-color / NO_COLOR 标准约定 + --verbose 显示完整错误堆栈
// 之前非中文用户/色盲用户/屏读器用户基本不可用（颜色硬编码、错误堆栈被吞）。
const _cliArgs = process.argv.slice(2);
const _noColor = _cliArgs.includes('--no-color') || !!process.env.NO_COLOR;
const _verbose = _cliArgs.includes('--verbose') || _cliArgs.includes('--debug');
if (_noColor) {
  // chalk.level=0 禁用所有颜色转义，输出纯文本（屏读器友好）
  chalk.level = 0;
}
// 暴露给其他模块（如 duan-v19.0.ts / cli-display.ts）查询 verbose 状态
(process as { __duanVerbose?: boolean }).__duanVerbose = _verbose;
(process as { __duanNoColor?: boolean }).__duanNoColor = _noColor;

const config = new ConfigManager();

const s = chalk.hex(colors.secondary);
const a = chalk.hex(colors.accent);
const d = chalk.hex(colors.textDim);
const g = chalk.hex(colors.success);
const e = chalk.hex(colors.error);
const cy = chalk.hex(colors.cyan);
const pk = chalk.hex(colors.pink);

async function startAgent(): Promise<void> {
  const { runDuan } = await import('./duan-v19.0.js');

  await runDuan();
}

function isProjectSetupDone(): boolean {
  try { return fs.existsSync('.setup-done'); } catch { return false; }
}

function markProjectSetupDone(): void {
  try {
    fs.writeFileSync('.setup-done', new Date().toISOString(), 'utf-8');
  } catch (e) {
    console.warn('[entry] markProjectSetupDone 写入失败:', e instanceof Error ? e.message : String(e));
  }
}

async function launchNewWindow() {
  const scriptPath = process.argv[1];
  const args = process.argv.slice(2).filter(a => a !== '--new-window' && a !== '-w');
  // 安全转义参数，防止命令注入
  const safeArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const cmd = `"${process.execPath}" "${scriptPath}" ${safeArgs}`;
  const title = '段先生 v19.0 - 超级智能体';

  if (process.platform === 'win32') {
    try {
      const child = spawn('cmd', ['/c', 'start', title, 'cmd', '/k', cmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      console.info(`  ${g('✓')} 段先生 v19.0 已在新窗口中启动`);
      console.info(`  ${d('关闭此窗口不会影响智能体运行')}`);
    } catch {
      console.info(`  ${a('⚠')} 无法打开新窗口，在当前终端启动...\n`);
      await startAgent();
    }
  } else {
    try {
      spawn('x-terminal-emulator', ['-e', cmd], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      console.info(`  ${g('✓')} 段先生 v19.0 已启动`);
    } catch {
      console.info(`  ${a('⚠')} 无法打开新窗口，在当前终端启动...\n`);
      await startAgent();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  // 新窗口启动
  if (args.includes('--new-window') || args.includes('-w')) {
    void launchNewWindow();
    await sleep(2000);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) { showHelp(); return; }
  
  if (args.includes('--version') || args.includes('-v')) {
    console.info(`  ${cy('段先生')} ${a('v21.2')}`);
    return;
  }

  if (args[0] === 'web') {
    const { start } = await import('./web-server.js');
    await start();
    return;
  }

  if (args[0] === 'setup' || args[0] === 'configure') {
    await runSetupWizard(config);
    markProjectSetupDone();
    config.applyEnv(); // 确保配置写入环境变量
    console.info(`\n  ${g('✓')} 配置完成！`);
    console.info(`  ${d('正在启动智能体...')}\n`);
    await sleep(1500);
    await startAgent();
    return;
  }

  if (args[0] === 'status') {
    console.info(config.getSummary());
    return;
  }

  if (args[0] === 'pairing') {
    const { handlePairingCommand } = await import('./core/pairing-cli.js');
    await handlePairingCommand(args.slice(1));
    return;
  }

  if (args[0] === 'profile' || args[0] === 'profiles') {
    const { handleProfileCommand } = await import('./core/profile-cli.js');
    await handleProfileCommand(args.slice(1));
    return;
  }

  if (args[0] === 'gateway') {
    const { handleGatewayCommand } = await import('./core/gateway-cli.js');
    await handleGatewayCommand(args.slice(1));
    return;
  }

  if (args[0] === 'onboard') {
    // 一站式配置命令（参考 OpenClaw 的 onboard）
    // 依次完成：API 配置 → 消息通道配置 → 生成配对码 → 启动网关
    const { runSetupWizard } = await import('./setup-wizard.js');
    await runSetupWizard(config);
    return;
  }

  const needsSetup = !config.isConfigured() || !isProjectSetupDone();

  if (needsSetup && !args.includes('--no-setup')) {
    const isFirstRun = !isProjectSetupDone();
    if (isFirstRun) {
      console.info(`\n  ${a('✨')} 欢迎使用 ${pk.bold('段先生 v19.0')}！首次运行需要配置 API 密钥。\n`);
    } else {
      console.info(`\n  ${a('⚠')} API 密钥未配置。\n`);
    }
    const { start } = await inquirerConfirm();
    if (!start) {
      console.info(`\n  ${d('稍后可运行 "duan setup" 进行配置。')}\n`);
      return;
    }
    await runSetupWizard(config);
    markProjectSetupDone();
    if (!config.isConfigured()) {
      console.info(`\n  ${a('⚠')} 配置未完成，部分功能受限`);
      await sleep(1500);
    } else {
      console.info(`\n  ${g('✓')} 配置完成！`);
      await sleep(1500);
    }
  }

  config.applyEnv();

  // 自动发现免费模型（后台探测，不阻塞启动）
  const activeProvider = process.env.DEFAULT_MODEL_PROVIDER || '';
  const activeModel = process.env.DEFAULT_MODEL || '';
  if (!activeProvider || !activeModel) {
    console.info(`  ${d('🔍 正在探测免费可用模型...')}`);
    try {
      const { discoverFreeModels } = await import('./core/free-model-discovery.js');
      const discovery = await discoverFreeModels(undefined, true);
      if (discovery.ollamaAvailable) {
        console.info(`  ${g('✓')} 检测到 Ollama 本地模型${discovery.ollamaModels.length > 0 ? `: ${discovery.ollamaModels.slice(0, 3).join(', ')}` : ''}`);
      }
      if (discovery.configured.length > 0) {
        console.info(`  ${g('✓')} 已自动配置 ${discovery.configured.length} 个免费模型`);
      }
      if (discovery.discovered.length === 0) {
        console.info(`  ${a('⚠')} 未发现免费模型，请运行 ${cy('duan setup')} 配置 API Key`);
      }
    } catch {
      // 探测失败不影响启动
    }
  }

  const finalProvider = process.env.DEFAULT_MODEL_PROVIDER || '未知';
  const finalModel = process.env.DEFAULT_MODEL || '未知';
  console.info(modelInfoLine(finalProvider, finalModel));

  // 后台启动 Web 服务器
  const webPort = process.env.WEB_PORT || '';
  if (webPort && !args.includes('--no-web')) {
    import('./web-server.js').then(m => {
      m.start().catch(err => {
        console.warn(`[Web] 服务器启动失败: ${err?.message || err}`);
      });
    }).catch(err => {
      console.warn(`[Web] 服务器模块加载失败: ${err?.message || err}`);
    });
    console.info(`  ${g('●')} ${d('Web 界面:')} ${cy(`http://localhost:${webPort}`)}`);
  }

  await startAgent();
}

function showHelp() {
  console.info('');
  console.info(`  ${pk.bold('段 先 生  ·  M r . D u a n')}  ${a('v19.0')}`);
  console.info(`  ${d('超级智能体 · 经验学习 · 本地推理 · 最优路径')}`);
  console.info('');
  console.info(`  ${d('─'.repeat(50))}`);
  console.info('');
  console.info(`  ${s('用法')}`);
  console.info(`  ${d('─'.repeat(20))}`);
  console.info(`  ${cy('duan')}                 ${d('启动智能体（当前终端）')}`);
  console.info(`  ${cy('duan -w')}             ${d('在新窗口中启动')}`);
  console.info(`  ${cy('duan onboard')}       ${d('一站式配置（API + 消息通道 + 配对码 + 网关）')}`);
  console.info(`  ${cy('duan setup')}          ${d('运行配置向导')}`);
  console.info(`  ${cy('duan status')}         ${d('查看配置信息')}`);
  console.info(`  ${cy('duan pairing')}        ${d('配对码与白名单管理')}`);
  console.info(`  ${cy('duan profile')}        ${d('API 配置管理（list/switch/remove/test）')}`);
  console.info(`  ${cy('duan gateway')}        ${d('消息通道网关（飞书/钉钉/Telegram 等）')}`);
  console.info(`  ${cy('duan web')}            ${d('启动 Web 界面')}`);
  console.info(`  ${cy('duan --version')}      ${d('显示版本号')}`);
  console.info(`  ${cy('duan --help')}         ${d('显示帮助信息')}`);
  console.info('');
  console.info(`  ${s(i18nT('help.core_capabilities'))}`);
  console.info(`  ${d('─'.repeat(20))}`);
  console.info(`  ${d('◈')} ${i18nT('help.cap_multi_model')}         ${d('◈')} ${i18nT('help.cap_code_gen')}`);
  console.info(`  ${d('◈')} ${i18nT('help.cap_browser')}       ${d('◈')} ${i18nT('help.cap_desktop')}`);
  console.info(`  ${d('◈')} ${i18nT('help.cap_evolution')}           ${d('◈')} ${i18nT('help.cap_skills')}`);
  console.info('');
  console.info(`  ${d('─'.repeat(50))}`);
  console.info('');
}

async function inquirerConfirm(): Promise<{ start: boolean }> {
  const inquirer = await import('inquirer');
  return inquirer.default.prompt([{
    type: 'confirm',
    name: 'start',
    message: chalk.hex(colors.cyan)('是否现在配置 API 密钥？'),
    default: true,
  }]);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error(`\n  ${e('✗')} 错误: ${err.message}`);
  process.exit(1);
});
