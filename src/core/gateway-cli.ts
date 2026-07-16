/**
 * Gateway CLI — 消息通道网关子命令
 *
 * 参考 OpenClaw 的 gateway 设计：
 *   duan gateway           启动消息通道网关（前台运行）
 *   duan gateway status    查看网关运行状态
 *   duan gateway stop      停止网关服务
 *   duan gateway list      列出已配置的通道
 *
 * 网关启动后会：
 *   1. 读取 ~/.duan/config.json 中的 channels 配置
 *   2. 检查 Agent 服务是否在运行（网关需要 Agent 来处理消息）
 *   3. 为每个已启用的通道启动 Bot 监听器
 *   4. 将收到的消息路由到 Agent 后端
 *   5. 将 Agent 响应回传到对应通道
 *
 * 重要：Agent 服务和网关需要同时运行（两个终端窗口）
 *   终端1: duan           (启动 Agent 服务)
 *   终端2: duan gateway   (启动消息通道网关)
 */

import * as http from 'http';

import chalk from 'chalk';
import { RemoteBridgeService } from '../server/services/remote-bridge.js';
import { UnifiedConfigManager } from './unified-config.js';
import { colors } from './cli-display.js';

const s = chalk.hex(colors.secondary);
const a = chalk.hex(colors.accent);
const t = chalk.hex(colors.text);
const d = chalk.hex(colors.textDim);
const g = chalk.hex(colors.success);
const e = chalk.hex(colors.error);
const cy = chalk.hex(colors.cyan);
const pk = chalk.hex(colors.pink);
const w = chalk.hex(colors.warning);

// 默认 Agent 端口（与 web-server.ts 保持一致）
const DEFAULT_AGENT_PORT = 7777;

// 全局网关实例（用于 status/stop 命令）
let gatewayInstance: RemoteBridgeService | null = null;

export function handleGatewayCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || '').toLowerCase();

  switch (subcommand) {
    case '':
    case 'start':
    case 'run':
      return startGateway();

    case 'status':
      showStatus();
      return Promise.resolve();

    case 'stop':
      return stopGateway();

    case 'list':
    case 'channels':
      listChannels();
      return Promise.resolve();

    case 'help':
    case '-h':
    case '--help':
      showHelp();
      return Promise.resolve();

    default:
      console.info(`  ${e('✗')} 未知子命令: ${subcommand}`);
      console.info(`  ${d('运行')} ${cy('duan gateway help')} ${d('查看可用命令')}`);
  }
  return Promise.resolve();
}

// ============ 启动网关 ============

/**
 * 检查 Agent 服务是否在指定端口运行
 * 通过 HTTP 请求 /api/health 端点检测
 */
function checkAgentRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, (res) => {
      res.resume(); // 消费响应体
      resolve(res.statusCode === 200 || res.statusCode === 404); // 404 也说明服务在运行
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startGateway(): Promise<void> {
  console.info('');
  console.info(`  ${pk.bold('🌉 消息通道网关')} ${d('启动中...')}`);
  console.info(`  ${d('─'.repeat(50))}`);
  console.info('');

  // 检查配置
  const config = UnifiedConfigManager.getInstance();
  const channels = config.getChannels();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enabledChannels = Object.entries(channels).filter(([_, c]: [string, any]) => c && c.enabled !== false);

  if (enabledChannels.length === 0) {
    console.info(`  ${w('⚠')} 未配置任何消息通道`);
    console.info(`  ${d('请先运行')} ${cy('duan setup')} ${d('配置飞书/钉钉/Telegram 等通道')}`);
    console.info('');
    return;
  }

  console.info(`  ${d('已配置通道')}: ${a(String(enabledChannels.length))} 个`);
  for (const [id, c] of enabledChannels) {
    const type = c.type || id;
    const appId = c.appId || c.accounts?.main?.appId || '';
    const masked = appId ? `${appId.substring(0, 10)}...` : d('未配置');
    console.info(`    ${g('●')} ${cy(type.padEnd(12))} ${d(`appId: ${masked}`)}`);
  }
  console.info('');

  // 获取 Agent 端口
  const webPort = config.getWebPort();
  const agentPort = webPort ? parseInt(webPort) : DEFAULT_AGENT_PORT;
  console.info(`  ${d('Agent 端口')}: ${cy(String(agentPort))}`);

  // 检查 Agent 服务是否在运行
  const agentRunning = await checkAgentRunning(agentPort);
  if (!agentRunning) {
    console.info('');
    console.info(`  ${w('⚠')} Agent 服务未在端口 ${agentPort} 运行！`);
    console.info(`  ${d('网关需要 Agent 服务来处理消息，否则无法回复飞书/钉钉消息')}`);
    console.info('');
    console.info(`  ${d('请先在另一个终端运行')} ${cy('duan')} ${d('启动智能体')}`);
    console.info(`  ${d('或者运行')} ${cy('duan web')} ${d('启动 Web 服务')}`);
    console.info('');
    console.info(`  ${d('提示：Agent 服务和网关需要同时运行（两个终端窗口）')}`);
    console.info(`  ${d('      终端1: duan           (启动 Agent 服务)')}`);
    console.info(`  ${d('      终端2: duan gateway   (启动消息通道网关)')}`);
    console.info('');
    return;
  }
  console.info(`  ${g('✓')} Agent 服务已就绪`);
  console.info('');

  // 启动网关
  try {
    gatewayInstance = new RemoteBridgeService(agentPort);
    await gatewayInstance.start();
    console.info('');
    console.info(`  ${g('✓')} 网关已启动，正在监听消息...`);
    console.info(`  ${d('按 Ctrl+C 停止网关')}`);
    console.info('');

    // 保持进程不退出（保存引用以便清理）
    const keepAlive = setInterval(() => {}, 1000);
    keepAlive.unref();

    // 合并的退出信号处理：先停止网关 → 清理 keepAlive → 退出
    const shutdown = (): void => {
      console.info(`\n  ${w('⚠')} 正在停止网关...`);
      if (gatewayInstance) {
        void gatewayInstance.stop().then(() => {
          console.info(`  ${g('✓')} 网关已停止`);
          clearInterval(keepAlive);
          process.exit(0);
        });
      } else {
        clearInterval(keepAlive);
        process.exit(0);
      }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.info(`  ${e('✗')} 网关启动失败: ${msg}`);
    console.info('');
  }
}

// ============ 查看状态 ============

function showStatus(): void {
  console.info('');
  console.info(`  ${pk.bold('◆ 网关状态')}`);
  console.info(`  ${d('─'.repeat(40))}`);

  if (!gatewayInstance) {
    console.info(`  ${w('⚠')} 网关未运行`);
    console.info(`  ${d('运行')} ${cy('duan gateway')} ${d('启动网关')}`);
    console.info('');
    return;
  }

  // 获取通道状态
  const statuses = gatewayInstance.getStatus();
  const running = statuses.filter(s => s.running).length;

  console.info(`  ${d('运行状态')}: ${g('● 运行中')}`);
  console.info(`  ${d('通道总数')}: ${a(String(statuses.length))}`);
  console.info(`  ${d('运行中')}: ${g(String(running))}  ${d('已停止')}: ${e(String(statuses.length - running))}`);
  console.info('');

  if (statuses.length > 0) {
    console.info(`  ${cy('通道详情')}:`);
    for (const s of statuses) {
      const status = s.running ? g('● 运行') : e('○ 停止');
      const count = s.messageCount > 0 ? d(` (${s.messageCount} 条消息)`) : '';
      console.info(`    ${status} ${t(s.channelId.padEnd(12))} ${count}`);
      if (s.error) {
        console.info(`      ${e('错误')}: ${s.error}`);
      }
    }
    console.info('');
  }
}

// ============ 停止网关 ============

async function stopGateway(): Promise<void> {
  if (!gatewayInstance) {
    console.info(`  ${w('⚠')} 网关未运行`);
    console.info('');
    return;
  }

  console.info(`  ${d('正在停止网关...')}`);
  await gatewayInstance.stop();
  gatewayInstance = null;
  console.info(`  ${g('✓')} 网关已停止`);
  console.info('');
}

// ============ 列出通道 ============

function listChannels(): void {
  const config = UnifiedConfigManager.getInstance();
  const channels = config.getChannels();
  const entries = Object.entries(channels);

  console.info('');
  console.info(`  ${pk.bold('◆ 已配置的消息通道')}`);
  console.info(`  ${d('─'.repeat(50))}`);

  if (entries.length === 0) {
    console.info(`  ${d('暂无配置')}`);
    console.info(`  ${d('运行')} ${cy('duan setup')} ${d('配置消息通道')}`);
    console.info('');
    return;
  }

  console.info(`  ${d('共')} ${a(String(entries.length))} ${d('个通道')}`);
  console.info('');

  for (const [id, c] of entries) {
    const cfg = c;
    const enabled = cfg.enabled !== false;
    const type = cfg.type || id;
    const status = enabled ? g('✓ 启用') : d('✗ 禁用');
    const dmPolicy = cfg.dmPolicy || 'pairing';

    // 根据通道类型显示不同的关键字段
    let keyInfo = '';
    switch (type) {
      case 'feishu':
        keyInfo = `appId: ${cfg.appId || d('未配置')}`;
        break;
      case 'wecom':
        keyInfo = `corpId: ${cfg.corpId || d('未配置')}, agentId: ${cfg.agentId || d('未配置')}`;
        break;
      case 'wechat':
        keyInfo = `bridge: ${cfg.bridgeType || 'wxauto'}, apiUrl: ${cfg.apiUrl || d('未配置')}`;
        break;
      case 'wechat_oa':
        keyInfo = `appId: ${cfg.appId || d('未配置')}`;
        break;
      case 'dingtalk':
        keyInfo = cfg.appKey ? `appKey: ${cfg.appKey.substring(0, 12)}...` : `webhook: ${cfg.webhookUrl ? '已配置' : d('未配置')}`;
        break;
      case 'telegram':
        keyInfo = `botToken: ${cfg.botToken ? '***' + cfg.botToken.substring(cfg.botToken.length - 6) : d('未配置')}`;
        break;
      case 'discord':
      case 'slack':
        keyInfo = `botToken: ${cfg.botToken ? '***' + cfg.botToken.substring(cfg.botToken.length - 6) : d('未配置')}`;
        break;
      case 'email':
        keyInfo = `smtp: ${cfg.smtpHost || d('未配置')}:${cfg.smtpPort || '465'}`;
        break;
      default:
        if (cfg.appId) {
          keyInfo = `appId: ${cfg.appId.substring(0, 10)}...`;
        } else if (cfg.webhookUrl) {
          keyInfo = 'webhook: 已配置';
        } else {
          keyInfo = d('未配置');
        }
    }

    console.info(`  ${status} ${cy(type.padEnd(12))} ${d(keyInfo)}`);
    console.info(`  ${d('  策略')}: ${t(dmPolicy)}  ${d('通道ID')}: ${t(id)}`);

    // 显示配对码提示
    if (enabled && dmPolicy === 'pairing') {
      console.info(`  ${d('  提示')}: ${w('用户需输入配对码才能使用')}`);
    }
    console.info('');
  }
}

// ============ 帮助 ============

function showHelp(): void {
  console.info('');
  console.info(`  ${pk.bold('🌉 消息通道网关 (duan gateway)')}`);
  console.info(`  ${d('管理消息通道网关，连接飞书/钉钉/Telegram 等平台')}`);
  console.info('');
  console.info(`  ${s('用法')}`);
  console.info(`  ${d('─'.repeat(60))}`);

  const cmds: [string, string][] = [
    ['start', '启动网关（前台运行，监听所有已配置通道）'],
    ['status', '查看网关运行状态和通道详情'],
    ['stop', '停止网关服务'],
    ['list', '列出所有已配置的消息通道'],
  ];

  for (const [cmd, desc] of cmds) {
    console.info(`  ${cy('duan gateway ' + cmd.padEnd(20))} ${d(desc)}`);
  }

  console.info('');
  console.info(`  ${s('示例')}`);
  console.info(`  ${d('─'.repeat(60))}`);
  console.info(`  ${cy('duan gateway')} ${d('启动网关（等同于 duan gateway start）')}`);
  console.info(`  ${cy('duan gateway status')} ${d('查看运行状态')}`);
  console.info(`  ${cy('duan gateway list')} ${d('查看已配置的通道')}`);
  console.info('');
  console.info(`  ${s('完整使用流程（参考 OpenClaw）')}`);
  console.info(`  ${d('─'.repeat(60))}`);
  console.info(`  ${d('1. 运行')} ${cy('duan setup')} ${d('配置飞书通道（App ID + App Secret）')}`);
  console.info(`  ${d('2. 终端1: 运行')} ${cy('duan')} ${d('启动 Agent 服务（处理 AI 对话）')}`);
  console.info(`  ${d('3. 终端2: 运行')} ${cy('duan gateway')} ${d('启动消息通道网关')}`);
  console.info(`  ${d('4. 运行')} ${cy('duan pairing generate')} ${d('生成 6 位配对码')}`);
  console.info(`  ${d('5. 在飞书中给机器人发消息 → 机器人提示输入配对码')}`);
  console.info(`  ${d('6. 在飞书中发送配对码 → 配对成功，即可正常对话')}`);
  console.info('');
  console.info(`  ${w('⚠')} Agent 服务和网关需要同时运行（两个终端窗口）`);
  console.info(`  ${d('   终端1: duan           (启动 Agent 服务)')}`);
  console.info(`  ${d('   终端2: duan gateway   (启动消息通道网关)')}`);
  console.info('');
}
