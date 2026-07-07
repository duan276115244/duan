/**
 * Profile CLI — API 配置管理子命令
 *
 * 用法：
 *   duan profile list                列出所有 API 配置
 *   duan profile switch [id]         切换默认 API 配置
 *   duan profile remove <id>         删除指定 API 配置
 *   duan profile test [id]           测试 API 配置连通性
 *   duan profile status              显示当前默认配置信息
 */

import chalk from 'chalk';
import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { ConfigManager, type ProviderProfile } from '../config.js';
import { colors, displayWidth } from './cli-display.js';

// ============ 色彩快捷方式 ============

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

function padRight(str: string, width: number): string {
  const dw = displayWidth(str);
  if (dw >= width) return str;
  return str + ' '.repeat(width - dw);
}

/** 脱敏显示 API Key（只显示前4位和后4位） */
function maskApiKey(key: string): string {
  if (!key) return d('(空)');
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

/** resolveProfile 解析结果 */
type ResolveProfileResult =
  | { ok: true; profile: ProviderProfile }
  | { ok: false; reason: 'out-of-range' | 'not-found'; profileId: string };

/** 类型守卫：收窄 ResolveProfileResult 到错误分支（`!result.ok` 在某些 TS 配置下收窄不稳定，显式守卫更可靠） */
function isResolveError(result: ResolveProfileResult): result is Extract<ResolveProfileResult, { ok: false }> {
  return result.ok === false;
}

/**
 * 根据参数（纯数字序号或 profile.id）解析对应的配置。
 * 统一处理：纯数字序号 -> 越界校验 -> 转换为 profile.id -> find
 */
function resolveProfile(profiles: ProviderProfile[], arg: string): ResolveProfileResult {
  let profileId = arg;
  // 支持序号选择
  if (/^\d+$/.test(profileId)) {
    const idx = parseInt(profileId) - 1;
    if (idx < 0 || idx >= profiles.length) {
      return { ok: false, reason: 'out-of-range', profileId };
    }
    profileId = profiles[idx].id;
  }
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) {
    return { ok: false, reason: 'not-found', profileId };
  }
  return { ok: true, profile };
}

// ============ 主入口 ============

export function handleProfileCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || '').toLowerCase();
  const subArgs = args.slice(1);
  const config = new ConfigManager();

  switch (subcommand) {
    case 'list':
    case 'ls':
      doList(config);
      return Promise.resolve();

    case 'switch':
    case 'use':
      doSwitch(config, subArgs);
      return Promise.resolve();

    case 'remove':
    case 'rm':
    case 'delete':
      doRemove(config, subArgs);
      return Promise.resolve();

    case 'test':
      return doTest(config, subArgs);

    case 'status':
    case 'info':
      doStatus(config);
      return Promise.resolve();

    case '':
    case 'help':
    case '-h':
    case '--help':
      showProfileHelp();
      return Promise.resolve();

    default:
      console.info(`  ${e('✗')} 未知子命令: ${subcommand}`);
      console.info(`  ${d('运行')} ${cy('duan profile help')} ${d('查看可用命令')}`);
      return Promise.resolve();
  }
}

// ============ 子命令实现 ============

function doList(config: ConfigManager): void {
  const profiles = config.getProfiles();
  const defaultProfile = config.getDefaultProfile();

  console.info('');
  console.info(`  ${cy.bold('◈ API 配置列表')}`);

  if (profiles.length === 0) {
    console.info(`  ${d('─'.repeat(40))}`);
    console.info(`  ${d('暂无 API 配置')}`);
    console.info(`  ${d('运行')} ${cy('duan setup')} ${d('添加 API 配置')}`);
    console.info('');
    return;
  }

  console.info(`  ${d('共')} ${a(String(profiles.length))} ${d('个 API 配置')}`);
  console.info(`  ${d('─'.repeat(90))}`);

  // 表头
  const header = `  ${s(padRight('默认', 4))}${s(padRight('供应商', 22))}${s(padRight('模型', 28))}${s(padRight('ID', 22))}${s('API Key')}`;
  console.info(header);
  console.info(`  ${d('─'.repeat(90))}`);

  for (const profile of profiles) {
    const isDefault = profile.id === defaultProfile?.id;
    const defaultMark = isDefault ? g('★') : d(' ');
    const row = `  ${defaultMark}  ${t(padRight(profile.label, 22))}${cy(padRight(profile.model, 28))}${d(padRight(profile.id, 22))}${d(maskApiKey(profile.apiKey))}`;
    console.info(row);
  }
  console.info(`  ${d('─'.repeat(90))}`);
  console.info(`  ${d('默认配置标记为')} ${g('★')}`);
  console.info('');
}

function doSwitch(config: ConfigManager, args: string[]): void {
  const profiles = config.getProfiles();
  if (profiles.length === 0) {
    console.info(`  ${w('⚠')} 暂无 API 配置，请先运行 ${cy('duan setup')}`);
    return;
  }

  const profileId = args[0];
  if (!profileId) {
    // 列出所有配置让用户选择
    const defaultProfile = config.getDefaultProfile();
    console.info('');
    console.info(`  ${cy.bold('◈ 切换默认 API 配置')}`);
    console.info(`  ${d('当前默认')}: ${g(defaultProfile?.label || '无')} — ${cy(defaultProfile?.model || '')}`);
    console.info(`  ${d('─'.repeat(60))}`);
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const isDefault = profile.id === defaultProfile?.id;
      console.info(`  ${a(String(i + 1))}. ${isDefault ? g('★ ') : '  '}${t(profile.label)} — ${cy(profile.model)} ${d(`(${profile.id})`)}`);
    }
    console.info('');
    console.info(`  ${d('用法')}: ${cy('duan profile switch <id或序号>')}`);
    console.info(`  ${d('示例')}: ${cy('duan profile switch profile-1234567890')}`);
    console.info(`         ${cy('duan profile switch 2')}`);
    console.info('');
    return;
  }

  const result = resolveProfile(profiles, profileId);
  if (isResolveError(result)) {
    if (result.reason === 'out-of-range') {
      console.info(`  ${e('✗')} 序号超出范围（1-${profiles.length}）`);
    } else {
      console.info(`  ${e('✗')} 未找到配置 ID: ${result.profileId}`);
      console.info(`  ${d('运行')} ${cy('duan profile list')} ${d('查看所有配置')}`);
    }
    return;
  }
  const target = result.profile;

  config.setDefaultProfile(target.id);
  config.applyEnv();

  console.info('');
  console.info(`  ${g('✓')} 已切换默认 API 配置`);
  console.info(`  ${d('供应商')}: ${cy(target.label)}`);
  console.info(`  ${d('模型')}: ${cy(target.model)}`);
  console.info(`  ${d('端点')}: ${d(target.baseURL)}`);
  console.info('');
}

function doRemove(config: ConfigManager, args: string[]): void {
  const profiles = config.getProfiles();
  if (profiles.length === 0) {
    console.info(`  ${w('⚠')} 暂无 API 配置`);
    return;
  }

  const profileId = args[0];
  if (!profileId) {
    console.info('');
    console.info(`  ${cy.bold('◈ 删除 API 配置')}`);
    console.info(`  ${d('─'.repeat(60))}`);
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const isDefault = profile.id === config.getDefaultProfile()?.id;
      console.info(`  ${a(String(i + 1))}. ${isDefault ? g('★ ') : '  '}${t(profile.label)} — ${cy(profile.model)} ${d(`(${profile.id})`)}`);
    }
    console.info('');
    console.info(`  ${d('用法')}: ${cy('duan profile remove <id或序号>')}`);
    console.info('');
    return;
  }

  const result = resolveProfile(profiles, profileId);
  if (isResolveError(result)) {
    if (result.reason === 'out-of-range') {
      console.info(`  ${e('✗')} 序号超出范围（1-${profiles.length}）`);
    } else {
      console.info(`  ${e('✗')} 未找到配置 ID: ${result.profileId}`);
    }
    return;
  }
  const target = result.profile;

  const defaultProfile = config.getDefaultProfile();
  config.removeProfile(target.id);

  // 如果删除的是默认配置，自动切换到第一个
  const remaining = config.getProfiles();
  if (defaultProfile?.id === target.id && remaining.length > 0) {
    config.setDefaultProfile(remaining[0].id);
    config.applyEnv();
    console.info('');
    console.info(`  ${g('✓')} 已删除: ${cy(target.label)} — ${target.model}`);
    console.info(`  ${d('默认配置已自动切换为')}: ${cy(remaining[0].label)}`);
    console.info('');
  } else {
    config.applyEnv();
    console.info('');
    console.info(`  ${g('✓')} 已删除: ${cy(target.label)} — ${target.model}`);
    if (remaining.length === 0) {
      console.info(`  ${w('⚠')} 已无 API 配置，请运行 ${cy('duan setup')} 添加`);
    }
    console.info('');
  }
}

async function doTest(config: ConfigManager, args: string[]): Promise<void> {
  const profiles = config.getProfiles();
  if (profiles.length === 0) {
    console.info(`  ${w('⚠')} 暂无 API 配置`);
    return;
  }

  let profile: ProviderProfile | undefined;
  if (args[0]) {
    const result = resolveProfile(profiles, args[0]);
    if (isResolveError(result)) {
      if (result.reason === 'out-of-range') {
        console.info(`  ${e('✗')} 序号超出范围（1-${profiles.length}）`);
      } else {
        console.info(`  ${e('✗')} 未找到配置 ID: ${result.profileId}`);
      }
      return;
    }
    profile = result.profile;
  } else {
    profile = config.getDefaultProfile();
    if (!profile) {
      console.info(`  ${e('✗')} 未设置默认配置`);
      return;
    }
  }

  console.info('');
  console.info(`  ${cy.bold('◈ 测试 API 连通性')}`);
  console.info(`  ${d('配置')}: ${t(profile.label)} — ${cy(profile.model)}`);
  console.info(`  ${d('端点')}: ${d(profile.baseURL)}`);
  console.info(`  ${d('─'.repeat(40))}`);
  console.info(`  ${d('正在测试...')}`);

  const startTime = Date.now();
  try {
    let success = false;
    let message = '';

    if (profile.provider === 'anthropic') {
      try {
        const client = new Anthropic({ apiKey: profile.apiKey, timeout: 15000, maxRetries: 0 });
        const resp = await client.messages.create({
          model: profile.model,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
        });
        success = !!resp.content;
        message = success ? '验证通过' : '验证失败';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        message = (msg || '未知错误').substring(0, 80);
      }
    } else {
      const client = new OpenAI({
        apiKey: profile.apiKey || 'ollama',
        baseURL: profile.baseURL,
        timeout: 15000,
        maxRetries: 0,
      });
      const resp = await client.chat.completions.create({
        model: profile.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      });
      success = !!resp.choices?.[0]?.message;
      message = success ? '验证通过' : '验证失败';
    }

    const elapsed = Date.now() - startTime;
    console.info('');
    if (success) {
      console.info(`  ${g('✓')} ${message}  ${d(`(${elapsed}ms)`)}`);
    } else {
      console.info(`  ${e('✗')} ${message}  ${d(`(${elapsed}ms)`)}`);
    }
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    console.info('');
    console.info(`  ${e('✗')} 测试失败: ${msg}  ${d(`(${elapsed}ms)`)}`);
  }
  console.info('');
}

function doStatus(config: ConfigManager): void {
  const profile = config.getDefaultProfile();
  const allProfiles = config.getProfiles();

  console.info('');
  console.info(`  ${pk.bold('◆ API 配置状态')}`);
  console.info(`  ${d('─'.repeat(50))}`);

  if (!profile) {
    console.info(`  ${w('⚠')} 未设置默认 API 配置`);
    console.info(`  ${d('运行')} ${cy('duan setup')} ${d('配置 API')}`);
    console.info('');
    return;
  }

  console.info(`  ${d('当前默认配置')}:`);
  console.info(`    ${d('供应商')}: ${cy(profile.label)}`);
  console.info(`    ${d('模型')}: ${cy(profile.model)}`);
  console.info(`    ${d('端点')}: ${d(profile.baseURL)}`);
  console.info(`    ${d('API Key')}: ${d(maskApiKey(profile.apiKey))}`);
  console.info(`    ${d('配置 ID')}: ${d(profile.id)}`);
  console.info('');
  console.info(`  ${d('总配置数')}: ${a(String(allProfiles.length))}`);
  console.info('');
}

// ============ 帮助 ============

function showProfileHelp(): void {
  console.info('');
  console.info(`  ${pk.bold('◆ API 配置管理 (duan profile)')}`);
  console.info(`  ${d('管理 API 供应商配置：查看、切换、删除、测试')}`);
  console.info('');
  console.info(`  ${s('用法')}`);
  console.info(`  ${d('─'.repeat(60))}`);

  const cmds: [string, string][] = [
    ['list', '列出所有 API 配置'],
    ['switch [id或序号]', '切换默认 API 配置'],
    ['remove <id或序号>', '删除指定 API 配置'],
    ['test [id或序号]', '测试 API 配置连通性（默认测试当前配置）'],
    ['status', '查看当前默认配置信息'],
  ];

  for (const [cmd, desc] of cmds) {
    console.info(`  ${cy('duan profile ' + cmd.padEnd(28))} ${d(desc)}`);
  }

  console.info('');
  console.info(`  ${s('示例')}`);
  console.info(`  ${d('─'.repeat(60))}`);
  console.info(`  ${cy('duan profile list')}                          ${d('查看所有配置')}`);
  console.info(`  ${cy('duan profile switch 2')}                     ${d('切换到列表中第 2 个配置')}`);
  console.info(`  ${cy('duan profile remove profile-1234567890')}    ${d('按 ID 删除')}`);
  console.info(`  ${cy('duan profile test')}                         ${d('测试当前默认配置')}`);
  console.info('');
}

