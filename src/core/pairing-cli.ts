/**
 * Pairing CLI — 配对管理子命令
 *
 * 用法：
 *   duan pairing generate [note]              生成配对码
 *   duan pairing list                         列出已配对用户
 *   duan pairing codes                        列出待使用配对码
 *   duan pairing approve <channel> <code>     批准配对请求（对齐 OpenClaw）
 *   duan pairing unpair <channel> <userId>    解除配对
 *   duan pairing whitelist <channel> <userId> [name]  添加白名单
 *   duan pairing clear <channel>              清除某通道所有配对
 *   duan pairing status                       显示配对系统状态
 */

import chalk from 'chalk';
import { PairingManager } from './pairing-manager.js';
import { colors, displayWidth } from './cli-display.js';

// ============ 色彩快捷方式（与 entry.ts 保持一致） ============

const _p = chalk.hex(colors.primary);
const s = chalk.hex(colors.secondary);
const a = chalk.hex(colors.accent);
const t = chalk.hex(colors.text);
const d = chalk.hex(colors.textDim);
const g = chalk.hex(colors.success);
const e = chalk.hex(colors.error);
const cy = chalk.hex(colors.cyan);
const pk = chalk.hex(colors.pink);
const w = chalk.hex(colors.warning);

// ============ 工具函数 ============

/** 按显示宽度右补齐（兼容中文双宽字符） */
function padRight(str: string, width: number): string {
  const dw = displayWidth(str);
  if (dw >= width) return str;
  return str + ' '.repeat(width - dw);
}

/** 格式化剩余有效时间（返回纯文本，着色由展示层负责） */
function formatRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已过期';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${m}m ${sec}s`;
}

/** 格式化相对时间（返回纯文本，着色由展示层负责） */
function formatRelativeTime(isoStr: string): string {
  const then = new Date(isoStr).getTime();
  if (isNaN(then)) return isoStr;
  const diff = Date.now() - then;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

// ============ 主入口 ============

export function handlePairingCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || '').toLowerCase();
  const subArgs = args.slice(1);

  const pm = PairingManager.getInstance();

  switch (subcommand) {
    case 'generate':
    case 'gen':
      doGenerate(pm, subArgs);
      return Promise.resolve();

    case 'list':
    case 'users':
      doList(pm);
      return Promise.resolve();

    case 'codes':
    case 'pending':
      doCodes(pm);
      return Promise.resolve();

    case 'approve':
    case 'accept':
      doApprove(pm, subArgs);
      return Promise.resolve();

    case 'unpair':
    case 'remove':
      doUnpair(pm, subArgs);
      return Promise.resolve();

    case 'whitelist':
    case 'allow':
      doWhitelist(pm, subArgs);
      return Promise.resolve();

    case 'clear':
    case 'reset':
      doClear(pm, subArgs);
      return Promise.resolve();

    case 'status':
    case 'info':
      doStatus(pm);
      return Promise.resolve();

    case '':
    case 'help':
    case '-h':
    case '--help':
      showPairingHelp();
      return Promise.resolve();

    default:
      console.info(`  ${e('✗')} 未知子命令: ${subcommand}`);
      console.info(`  ${d('运行')} ${cy('duan pairing help')} ${d('查看可用命令')}`);
      return Promise.resolve();
  }
}

// ============ 子命令实现 ============

function doGenerate(pm: PairingManager, args: string[]): void {
  const note = args.join(' ').trim() || undefined;
  const code = pm.generateCode(note);

  console.info('');
  console.info(`  ${pk.bold('◆ 配对码已生成')}`);
  console.info(`  ${d('─'.repeat(40))}`);
  console.info('');
  // 醒目显示配对码
  console.info(`  ${d('┌─────────────────────────────┐')}`);
  console.info(`  ${d('│')}                             ${d('│')}`);
  console.info(`  ${d('│')}      ${a.bold(code.split('').join(' '))}      ${d('│')}`);
  console.info(`  ${d('│')}                             ${d('│')}`);
  console.info(`  ${d('└─────────────────────────────┘')}`);
  console.info('');
  console.info(`  ${d('有效期')}: ${g('5 分钟')}  ${d('│')}  ${d('状态')}: ${cy('待使用')}`);
  if (note) {
    console.info(`  ${d('备注')}: ${t(note)}`);
  }
  console.info('');
  console.info(`  ${d('用户在聊天中输入此码即可完成配对')}`);
  console.info('');
}

function doList(pm: PairingManager): void {
  const users = pm.listPairedUsers();

  console.info('');
  console.info(`  ${cy.bold('◈ 已配对用户')}`);

  if (users.length === 0) {
    console.info(`  ${d('─'.repeat(40))}`);
    console.info(`  ${d('暂无已配对用户')}`);
    console.info(`  ${d('运行')} ${cy('duan pairing generate')} ${d('生成配对码')}`);
    console.info('');
    return;
  }

  console.info(`  ${d('共')} ${a(String(users.length))} ${d('个已配对用户')}`);
  console.info(`  ${d('─'.repeat(80))}`);

  // 表头
  const header = `  ${s(padRight('通道', 14))}${s(padRight('用户ID', 28))}${s(padRight('显示名', 16))}${s(padRight('配对时间', 14))}${s('来源')}`;
  console.info(header);
  console.info(`  ${d('─'.repeat(80))}`);

  for (const u of users) {
    // 纯文本值
    const name = u.displayName || '-';
    const time = formatRelativeTime(u.pairedAt);
    // 展示层：先 padRight 再着色
    const nameCell = (u.displayName ? t : d)(padRight(name, 16));
    const source = u.pairedByCode === 'manual' ? pk('白名单') : cy('配对码');
    const row = `  ${t(padRight(u.channelType, 14))}${t(padRight(u.userId, 28))}${nameCell}${d(padRight(time, 14))}${source}`;
    console.info(row);
  }
  console.info(`  ${d('─'.repeat(80))}`);
  console.info('');
}

function doCodes(pm: PairingManager): void {
  const codes = pm.listPendingCodes();

  console.info('');
  console.info(`  ${cy.bold('◈ 待使用配对码')}`);

  if (codes.length === 0) {
    console.info(`  ${d('─'.repeat(40))}`);
    console.info(`  ${d('暂无待使用配对码')}`);
    console.info(`  ${d('运行')} ${cy('duan pairing generate')} ${d('生成新配对码')}`);
    console.info('');
    return;
  }

  console.info(`  ${d('共')} ${a(String(codes.length))} ${d('个待使用配对码')}`);
  console.info(`  ${d('─'.repeat(70))}`);

  // 表头
  const header = `  ${s(padRight('配对码', 18))}${s(padRight('剩余有效', 14))}${s(padRight('备注', 24))}${s('状态')}`;
  console.info(header);
  console.info(`  ${d('─'.repeat(70))}`);

  for (const c of codes) {
    // 纯文本值
    const remaining = formatRemaining(c.expiresAt);
    const expired = c.expiresAt - Date.now() <= 0;
    const note = c.note || '-';
    // 展示层：先 padRight 再着色
    const codeCell = a.bold(padRight(c.code, 18));
    const remainingCell = (expired ? e : g)(padRight(remaining, 14));
    const noteCell = (c.note ? t : d)(padRight(note, 24));
    const status = cy('待使用');
    const row = `  ${codeCell}${remainingCell}${noteCell}${status}`;
    console.info(row);
  }
  console.info(`  ${d('─'.repeat(70))}`);
  console.info('');
}

function doUnpair(pm: PairingManager, args: string[]): void {
  const [channel, userId] = args;

  if (!channel || !userId) {
    console.info(`  ${e('✗')} 参数不足`);
    console.info(`  ${d('用法')}: ${cy('duan pairing unpair <channel> <userId>')}`);
    return;
  }

  const removed = pm.unpair(channel, userId);
  console.info('');
  if (removed) {
    console.info(`  ${g('✓')} 已解除配对`);
    console.info(`  ${d('通道')}: ${cy(channel)}  ${d('用户ID')}: ${cy(userId)}`);
  } else {
    console.info(`  ${w('⚠')} 用户未配对，无需解除`);
    console.info(`  ${d('通道')}: ${cy(channel)}  ${d('用户ID')}: ${cy(userId)}`);
  }
  console.info('');
}

/**
 * 批准配对请求（对齐 OpenClaw 的 pairing approve 命令）
 *
 * OpenClaw 的配对流程：
 *   1. 陌生用户在飞书中发消息 → 机器人回复配对码
 *   2. 管理员运行 `openclaw-cn pairing approve feishu <配对码>` 批准
 *
 * 我们的配对流程（更简单）：
 *   1. 管理员运行 `duan pairing generate` 生成配对码
 *   2. 用户在飞书中发送配对码 → 自动配对
 *
 * 此命令用于查看/批准待审批的配对请求（兼容 OpenClaw 方式）
 */
function doApprove(pm: PairingManager, args: string[]): void {
  const [channel, code] = args;

  if (!channel) {
    // 列出所有待使用配对码（等待用户输入）
    const codes = pm.listPendingCodes();
    console.info('');
    console.info(`  ${cy.bold('◈ 待审批配对码')}`);
    console.info(`  ${d('─'.repeat(50))}`);

    if (codes.length === 0) {
      console.info(`  ${d('暂无待审批配对码')}`);
      console.info(`  ${d('运行')} ${cy('duan pairing generate')} ${d('生成新配对码')}`);
    } else {
      for (const c of codes) {
        const remaining = formatRemaining(c.expiresAt);
        console.info(`  ${a.bold(c.code)}  ${d('剩余')}: ${g(remaining)}  ${d('备注')}: ${t(c.note || '-')}`);
      }
    }
    console.info('');
    console.info(`  ${d('提示')}: 用户在聊天中输入配对码即可自动完成配对`);
    console.info(`  ${d('如需手动批准')}: ${cy('duan pairing approve <channel> <code>')}`);
    console.info('');
    return;
  }

  if (!code) {
    // 列出指定通道的待使用配对码
    const codes = pm.listPendingCodes();
    console.info('');
    console.info(`  ${cy.bold(`◈ 通道 ${channel} 的待审批配对码`)}`);
    console.info(`  ${d('─'.repeat(50))}`);

    const channelCodes = codes; // 配对码不区分通道，所有通道共用
    if (channelCodes.length === 0) {
      console.info(`  ${d('暂无待审批配对码')}`);
    } else {
      for (const c of channelCodes) {
        const remaining = formatRemaining(c.expiresAt);
        console.info(`  ${a.bold(c.code)}  ${d('剩余')}: ${g(remaining)}  ${d('备注')}: ${t(c.note || '-')}`);
      }
    }
    console.info('');
    return;
  }

  // 验证配对码是否有效
  const codes = pm.listPendingCodes();
  const targetCode = codes.find(c => c.code === code);

  if (!targetCode) {
    console.info(`  ${e('✗')} 配对码 ${a(code)} 无效或已过期`);
    console.info(`  ${d('运行')} ${cy('duan pairing generate')} ${d('生成新配对码')}`);
    console.info('');
    return;
  }

  // 调用 PairingManager.approve() 批准配对码
  const result = pm.approve(channel, code);

  console.info('');
  if (result.success) {
    console.info(`  ${g('✓')} ${t(result.message)}`);
    console.info(`  ${d('通道')}: ${cy(channel)}`);
    console.info(`  ${d('配对码')}: ${a.bold(code)}`);
    console.info('');
    console.info(`  ${d('用户现在可以在')} ${cy(channel)} ${d('中正常使用机器人了')}`);
  } else {
    console.info(`  ${e('✗')} ${t(result.message)}`);
    console.info(`  ${d('运行')} ${cy('duan pairing codes')} ${d('查看所有待使用配对码')}`);
  }
  console.info('');
}

function doWhitelist(pm: PairingManager, args: string[]): void {
  const [channel, userId, ...nameParts] = args;
  const name = nameParts.join(' ').trim() || undefined;

  if (!channel || !userId) {
    console.info(`  ${e('✗')} 参数不足`);
    console.info(`  ${d('用法')}: ${cy('duan pairing whitelist <channel> <userId> [name]')}`);
    return;
  }

  // 检查是否已存在
  const existing = pm.listPairedUsers().find(u => u.channelType === channel && u.userId === userId);
  pm.addWhitelist(channel, userId, name);

  console.info('');
  if (existing) {
    console.info(`  ${w('⚠')} 用户已在白名单中`);
  } else {
    console.info(`  ${g('✓')} 已添加到白名单`);
  }
  console.info(`  ${d('通道')}: ${cy(channel)}`);
  console.info(`  ${d('用户ID')}: ${cy(userId)}`);
  if (name) {
    console.info(`  ${d('显示名')}: ${t(name)}`);
  }
  console.info(`  ${d('该用户无需配对码即可使用')}`);
  console.info('');
}

function doClear(pm: PairingManager, args: string[]): void {
  const [channel] = args;

  if (!channel) {
    console.info(`  ${e('✗')} 参数不足`);
    console.info(`  ${d('用法')}: ${cy('duan pairing clear <channel>')}`);
    return;
  }

  const removed = pm.clearChannel(channel);
  console.info('');
  if (removed > 0) {
    console.info(`  ${g('✓')} 已清除通道 ${cy(channel)} 的 ${a(String(removed))} 个配对用户`);
  } else {
    console.info(`  ${d('通道')} ${cy(channel)} ${d('无配对用户')}`);
  }
  console.info('');
}

function doStatus(pm: PairingManager): void {
  const users = pm.listPairedUsers();
  const codes = pm.listPendingCodes();

  // 按通道统计
  const byChannel: Record<string, number> = {};
  for (const u of users) {
    byChannel[u.channelType] = (byChannel[u.channelType] || 0) + 1;
  }
  const channels = Object.keys(byChannel);

  console.info('');
  console.info(`  ${pk.bold('◆ 配对系统状态')}`);
  console.info(`  ${d('─'.repeat(40))}`);
  console.info(`  ${d('已配对用户')}: ${a(String(users.length))}`);
  console.info(`  ${d('待使用配对码')}: ${a(String(codes.length))}`);
  console.info(`  ${d('涉及通道数')}: ${a(String(channels.length))}`);
  console.info('');

  if (channels.length > 0) {
    console.info(`  ${cy('按通道分布')}:`);
    for (const ch of channels) {
      const count = byChannel[ch];
      const bar = g('█'.repeat(Math.min(count, 20))) + d('░'.repeat(Math.max(0, 20 - count)));
      console.info(`    ${t(padRight(ch, 14))} ${bar} ${a(String(count))}`);
    }
    console.info('');
  }

  console.info(`  ${d('持久化文件')}: ${d('~/.duan/paired-users.json')}`);
  console.info(`  ${d('配对码有效期')}: ${d('5 分钟')}`);
  console.info('');
}

// ============ 帮助 ============

function showPairingHelp(): void {
  console.info('');
  console.info(`  ${pk.bold('◆ 配对管理 (duan pairing)')}`);
  console.info(`  ${d('管理用户配对码与白名单，控制各通道访问授权')}`);
  console.info('');
  console.info(`  ${s('用法')}`);
  console.info(`  ${d('─'.repeat(60))}`);

  const cmds: [string, string][] = [
    ['generate [note]', '生成 6 位配对码（5 分钟有效）'],
    ['list', '列出所有已配对用户'],
    ['codes', '列出待使用配对码'],
    ['approve [channel] [code]', '查看/批准待审批配对码（对齐 OpenClaw）'],
    ['unpair <channel> <userId>', '解除指定用户的配对'],
    ['whitelist <channel> <userId> [name]', '添加白名单（无需配对码）'],
    ['clear <channel>', '清除某通道的所有配对'],
    ['status', '查看配对系统状态概览'],
  ];

  for (const [cmd, desc] of cmds) {
    console.info(`  ${cy('duan pairing ' + cmd.padEnd(38))} ${d(desc)}`);
  }

  console.info('');
  console.info(`  ${s('示例')}`);
  console.info(`  ${d('─'.repeat(60))}`);
  console.info(`  ${cy('duan pairing generate')} ${d('给张三的配对码')}`);
  console.info(`  ${cy('duan pairing list')}`);
  console.info(`  ${cy('duan pairing unpair feishu ou_abc123')}`);
  console.info(`  ${cy('duan pairing whitelist wechat wx_zhangsan 张三')}`);
  console.info(`  ${cy('duan pairing clear telegram')}`);
  console.info('');
}

