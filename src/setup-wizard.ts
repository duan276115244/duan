import inquirer from 'inquirer';
import chalk from 'chalk';
import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import type { ConfigManager, ProviderProfile } from './config.js';
import { initWorkspace } from './workspace.js';

const C = {
  pri: chalk.hex('#6366f1'),
  sec: chalk.hex('#f97316'),
  acc: chalk.hex('#ec4899'),
  txt: chalk.hex('#e2e8f0'),
  dim: chalk.hex('#64748b'),
  suc: chalk.hex('#22c55e'),
  err: chalk.hex('#ef4444'),
  wrn: chalk.hex('#f59e0b'),
  cyan: chalk.hex('#06b6d4'),
};

function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1Bc');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printLogo(): void {
  // 不再打印大logo，避免与主界面重复
  console.info('');
  console.info(C.pri.bold('  ⚙️  配置向导'));
  console.info(C.dim('  ─'.repeat(30)));
  console.info('');
}

interface ProviderOption {
  id: string;
  label: string;
  baseURL: string;
  category: string;
  docsUrl: string;
}

const PROVIDERS: ProviderOption[] = [
  // ===== 国内 =====
  { id: 'doubao-coding', label: '火山引擎 Coding Plan', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', category: '🇨🇳 国内', docsUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'doubao', label: '字节豆包 火山引擎', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', category: '🇨🇳 国内', docsUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'doubao-agent', label: '火山引擎 Agent Plan', baseURL: 'https://ark.cn-beijing.volces.com/api/agent/v3', category: '🇨🇳 国内', docsUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', category: '🇨🇳 国内', docsUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'siliconflow', label: 'SiliconFlow 硅基流动', baseURL: 'https://api.siliconflow.cn/v1', category: '🇨🇳 国内', docsUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'aliyun', label: '阿里通义千问 Qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', category: '🇨🇳 国内', docsUrl: 'https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key' },
  { id: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', category: '🇨🇳 国内', docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'moonshot', label: 'Moonshot Kimi', baseURL: 'https://api.moonshot.cn/v1', category: '🇨🇳 国内', docsUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimax.chat/v1', category: '🇨🇳 国内', docsUrl: 'https://platform.minimaxi.com/document' },
  { id: 'ernie', label: '百度文心一言', baseURL: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', category: '🇨🇳 国内', docsUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application' },
  { id: 'stepfun', label: '阶跃星辰 StepFun', baseURL: 'https://api.stepfun.com/v1', category: '🇨🇳 国内', docsUrl: 'https://platform.stepfun.com/interface-key' },
  { id: 'baichuan', label: '百川智能 Baichuan', baseURL: 'https://api.baichuan-ai.com/v1', category: '🇨🇳 国内', docsUrl: 'https://platform.baichuan-ai.com/console/apikey' },
  { id: 'yi', label: '零一万物 Yi', baseURL: 'https://api.lingyiwanwu.com/v1', category: '🇨🇳 国内', docsUrl: 'https://platform.lingyiwanwu.com/apikeys' },
  { id: 'sensenova', label: '商汤日日新 SenseNova', baseURL: 'https://api.sensenova.cn/v1', category: '🇨🇳 国内', docsUrl: 'https://console.sensecore.cn/iam/User/AccessKey' },
  // ===== 免费 =====
  { id: 'agnes', label: 'Agnes AI（免费全模态）', baseURL: 'https://apihub.agnes-ai.com/v1', category: '🆓 免费', docsUrl: 'https://platform.agnes-ai.com/' },
  // ===== 国际 =====
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', category: '🌎 国际', docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic Claude', baseURL: 'https://api.anthropic.com/v1', category: '🌎 国际', docsUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', category: '🌎 国际', docsUrl: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', label: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', category: '🌎 国际', docsUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', label: 'xAI Grok', baseURL: 'https://api.x.ai/v1', category: '🌎 国际', docsUrl: 'https://console.x.ai' },
  { id: 'cohere', label: 'Cohere', baseURL: 'https://api.cohere.com/v2', category: '🌎 国际', docsUrl: 'https://dashboard.cohere.com/api-keys' },
  { id: 'perplexity', label: 'Perplexity', baseURL: 'https://api.perplexity.ai', category: '🌎 国际', docsUrl: 'https://www.perplexity.ai/settings/api' },
  // ===== 聚合 =====
  { id: 'groq', label: 'Groq（免费，速度快）', baseURL: 'https://api.groq.com/openai/v1', category: '🔄 聚合', docsUrl: 'https://console.groq.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', category: '🔄 聚合', docsUrl: 'https://openrouter.ai/keys' },
  { id: 'together', label: 'Together AI', baseURL: 'https://api.together.xyz/v1', category: '🔄 聚合', docsUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks AI', baseURL: 'https://api.fireworks.ai/inference/v1', category: '🔄 聚合', docsUrl: 'https://fireworks.ai/account/api-keys' },
  // ===== 本地 =====
  { id: 'ollama', label: 'Ollama 本地部署', baseURL: 'http://localhost:11434', category: '💻 本地', docsUrl: 'https://ollama.com/download' },
  // ===== 自定义 =====
  { id: 'custom', label: '自定义 API (OpenAI 兼容)', baseURL: '', category: '⚙️ 自定义', docsUrl: '' },
];

const CODING_PLAN_MODELS = [
  { id: 'ark-code-latest', name: 'Auto（控制台切换）', desc: '方舟控制台智能调度（推荐默认）', star: true },
  { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', desc: '编程旗舰，256K上下文' },
  { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', desc: '通用旗舰，256K上下文' },
  { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', desc: '轻量快速，256K上下文' },
  { id: 'doubao-seed-code', name: 'Doubao Seed Code', desc: '编程专用模型' },
  { id: 'doubao-seed-2.0-mini', name: 'Doubao Seed 2.0 Mini', desc: '轻量模型，128K上下文' },
  { id: 'glm-4-plus', name: 'GLM-4-Plus', desc: '智谱旗舰模型' },
  { id: 'glm-4-flash', name: 'GLM-4-Flash', desc: '智谱免费快速模型' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', desc: 'DeepSeek V3 对话模型' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', desc: 'DeepSeek R1 推理模型' },
  { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k', desc: '月之暗面 Kimi 长上下文' },
  { id: 'MiniMax-Text-01', name: 'MiniMax Text 01', desc: 'MiniMax 旗舰模型' },
  { id: 'abab6.5s-chat', name: 'ABAB 6.5s', desc: 'MiniMax 对话模型' },
];

const DEFAULT_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  siliconflow: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct', 'THUDM/glm-4-9b-chat'],
  aliyun: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
  zhipu: ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4-long'],
  doubao: ['__custom_endpoint__'],
  'doubao-agent': ['doubao-agent-latest'],
  minimax: ['MiniMax-Text-01'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  ernie: ['ernie-4.0-8k', 'ernie-3.5-8k'],
  stepfun: ['step-1-8k'],
  baichuan: ['Baichuan4'],
  yi: ['yi-lightning'],
  sensenova: ['SenseNova-5'],
  agnes: ['agnes-2.0-flash', 'agnes-image-2.1-flash', 'agnes-image-2.0-flash', 'agnes-video-v2.0'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022'],
  gemini: ['gemini-2.0-flash', 'gemini-2.5-pro'],
  mistral: ['mistral-small-latest', 'mistral-large-latest'],
  xai: ['grok-2', 'grok-2-vision'],
  cohere: ['command-r-plus'],
  perplexity: ['sonar-pro', 'sonar'],
  groq: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct:free'],
  together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  fireworks: ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
  ollama: ['llama3', 'qwen2.5'],
};

async function testConnection(providerId: string, baseURL: string, model: string, apiKey: string): Promise<{ success: boolean; message: string }> {
  if (!model || !apiKey) return { success: false, message: '缺少必要配置' };
  // Ollama 本地无需 Key
  if (providerId === 'ollama') {
    if (!baseURL) return { success: false, message: '缺少 baseURL' };
  } else if (!baseURL) {
    return { success: false, message: '缺少 baseURL' };
  }

  // Anthropic 使用专用 SDK（其 API 不兼容 OpenAI /v1/chat/completions）
  if (providerId === 'anthropic') {
    try {
      const client = new Anthropic({ apiKey, timeout: 15000, maxRetries: 0 });
      const resp = await client.messages.create({
        model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return resp.content ? { success: true, message: '验证通过' } : { success: false, message: '验证失败' };
    } catch (err: unknown) {
      const msg = ((err instanceof Error ? err.message : String(err)) || '').toLowerCase();
      if (msg.includes('401') || msg.includes('authentication')) return { success: false, message: 'API Key 无效(401)' };
      if (msg.includes('403')) return { success: false, message: '权限不足(403)' };
      if (msg.includes('404') || msg.includes('model_not_found')) return { success: false, message: '模型不存在(404)' };
      if (msg.includes('429')) return { success: false, message: '请求频率超限(429)，但Key有效' };
      if (msg.includes('connect') || msg.includes('network') || msg.includes('econnrefused')) return { success: false, message: '连接失败，请检查网络' };
      if (msg.includes('timeout') || msg.includes('etimedout')) return { success: false, message: '连接超时，请检查网络' };
      return { success: false, message: ((err instanceof Error ? err.message : String(err)) || '未知错误').substring(0, 80) };
    }
  }

  try {
    const client = new OpenAI({ apiKey: apiKey || 'ollama', baseURL, timeout: 15000, maxRetries: 0 });
    const resp = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
    return resp.choices?.[0]?.message ? { success: true, message: '验证通过' } : { success: false, message: '验证失败' };
  } catch (err: unknown) {
    const msg = ((err instanceof Error ? err.message : String(err)) || '').toLowerCase();
    if (msg.includes('401') || msg.includes('incorrect api key') || msg.includes('invalid api key')) return { success: false, message: 'API Key 无效(401)' };
    if (msg.includes('402') || msg.includes('balance') || msg.includes('quota')) return { success: false, message: '余额不足(402)' };
    if (msg.includes('403')) return { success: false, message: '权限不足(403)' };
    if (msg.includes('404')) return { success: false, message: '模型不存在或当前Key不支持该模型(404)' };
    if (msg.includes('429')) return { success: false, message: '请求频率超限(429)，但Key有效' };
    if (msg.includes('503') || msg.includes('no available channel') || msg.includes('service unavailable')) {
      return { success: false, message: '模型名错误或服务暂不可用(503)，请检查模型名拼写' };
    }
    if (msg.includes('connect') || msg.includes('network') || msg.includes('econnrefused')) return { success: false, message: '连接失败，请检查网络' };
    if (msg.includes('timeout') || msg.includes('etimedout')) return { success: false, message: '连接超时，请检查网络' };
    return { success: false, message: ((err instanceof Error ? err.message : String(err)) || '未知错误').substring(0, 80) };
  }
}

async function selectProvider(): Promise<ProviderOption | null> {
  clearScreen();
  printLogo();
  console.info(C.sec.bold('  ── 选择 AI 提供商 ──'));
  console.info('');

  const choices = PROVIDERS.map(p => ({
    name: `${p.category} ${C.cyan(p.label)}`,
    value: p.id,
    short: p.label,
  }));

  const { providerId } = await inquirer.prompt([{
    type: 'list',
    name: 'providerId',
    message: C.txt('请选择 AI 提供商：'),
    choices,
    pageSize: 18,
  }]);

  return PROVIDERS.find(p => p.id === providerId) || null;
}

async function configureProvider(provider: ProviderOption): Promise<{ apiKey: string; model: string; success: boolean } | null> {
  clearScreen();
  printLogo();
  console.info(C.sec.bold(`  ── 配置 ${provider.label} ──`));
  console.info('');

  if (provider.docsUrl) {
    console.info(C.wrn(`  💡 获取 API Key: ${provider.docsUrl}`));
    console.info('');
  }

  // Ollama 本地部署无需 API Key
  let apiKey = '';
  if (provider.id === 'ollama') {
    console.info(C.dim('  ℹ️  Ollama 本地部署无需 API Key'));
    console.info('');
    const { baseURL } = await inquirer.prompt([{
      type: 'input',
      name: 'baseURL',
      message: C.txt('输入 Ollama 服务地址：'),
      default: provider.baseURL,
      validate: (v: string) => v.startsWith('http') || '请输入有效的 URL',
    }]);
    provider.baseURL = baseURL;
    apiKey = 'ollama';
  } else {
    const result = await inquirer.prompt([{
      type: 'input',
      name: 'apiKey',
      message: C.txt('输入 API Key：'),
      mask: '*',
      validate: (v: string) => v.trim().length > 8 || 'API Key 长度不足',
    }]);
    apiKey = result.apiKey;
  }

  let model = '';
  if (provider.id === 'doubao-coding') {
    const choices = CODING_PLAN_MODELS.map(m => ({
      name: m.star ? `${C.suc('⭐')} ${m.name} — ${m.desc}` : `${m.name} — ${m.desc}`,
      value: m.id,
    }));
    const { selectedModel } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedModel',
      message: C.txt('选择默认模型：'),
      choices,
      pageSize: 8,
    }]);
    model = selectedModel;
  } else if (DEFAULT_MODELS[provider.id]) {
    const choices = DEFAULT_MODELS[provider.id].map(m => ({ name: m, value: m }));
    choices.push({ name: '自定义模型名', value: '__custom__' });
    const { selectedModel } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedModel',
      message: C.txt('选择默认模型：'),
      choices,
      pageSize: 6,
    }]);
    if (selectedModel === '__custom__') {
      const { customModel } = await inquirer.prompt([{
        type: 'input',
        name: 'customModel',
        message: C.txt('输入自定义模型名：'),
        validate: (v: string) => v.trim().length > 0 || '请输入模型名',
      }]);
      model = customModel;
    } else {
      model = selectedModel;
    }
  } else if (provider.id === 'custom') {
    const { customBaseURL } = await inquirer.prompt([{
      type: 'input',
      name: 'customBaseURL',
      message: C.txt('输入 API 基础 URL：'),
      validate: (v: string) => v.startsWith('http') || '请输入有效的 URL',
    }]);
    provider.baseURL = customBaseURL;
    const { customModel } = await inquirer.prompt([{
      type: 'input',
      name: 'customModel',
      message: C.txt('输入模型名：'),
      validate: (v: string) => v.trim().length > 0 || '请输入模型名',
    }]);
    model = customModel;
  } else {
    model = DEFAULT_MODELS[provider.id]?.[0] || '';
  }

  console.info('');
  console.info(C.dim('  🔍 正在验证连接...'));
  const result = await testConnection(provider.id, provider.baseURL, model, apiKey);
  if (result.success) {
    console.info(C.suc(`  ✅ ${result.message}`));
    return { apiKey, model, success: true };
  } else {
    console.info(C.err(`  ❌ ${result.message}`));
    const { retry } = await inquirer.prompt([{
      type: 'confirm',
      name: 'retry',
      message: C.wrn('验证失败，是否重新配置？'),
      default: true,
    }]);
    if (retry) {
      return configureProvider(provider);
    }
    return null;
  }
}

async function configureMobile(config: ConfigManager): Promise<void> {
  clearScreen();
  printLogo();
  console.info(C.sec.bold('  ── 移动端交互配置 ──'));
  console.info('');
  console.info(C.dim('  支持：飞书、企业微信、个人微信、微信公众号、钉钉、Telegram、Discord、Slack、QQ、邮件、WhatsApp、Teams'));
  console.info(C.dim('  参考：OpenClaw 配置方式（https://clawd.org.cn/channels/）'));
  console.info('');
  console.info(C.wrn('  ℹ️  关于配对码（重要）：'));
  console.info(C.dim('      配对码由本系统生成（非飞书/钉钉等平台生成）'));
  console.info(C.dim('      配置完通道后会立即生成配对码，用户在聊天中输入此码完成绑定'));
  console.info('');

  const { enabled } = await inquirer.prompt([{
    type: 'confirm',
    name: 'enabled',
    message: C.txt('是否配置移动端交互通道？'),
    default: false,
  }]);

  if (!enabled) return;

  // 通道平台定义：按各平台官方文档要求配置字段
  // 文档参考：
  //   飞书: https://open.feishu.cn/document/client-docs/bot-v3/bot-overview
  //   企微: https://developer.work.weixin.qq.com/document/path/91770
  //   钉钉: https://open.dingtalk.com/document/robots/robot-overview
  //   Telegram: https://core.telegram.org/bots/api
  //   Discord: https://discord.com/developers/docs/intro
  //   Slack: https://api.slack.com/docs
  //   Server酱: https://sct.ftqq.com/
  //   Bark: https://github.com/Finb/Bark
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface FieldDef { key: string; label: string; default?: string; required?: boolean; mask?: boolean; hint?: string; skipIf?: (cfg: Record<string, any>) => boolean; choices?: Array<string | { name: string; value: string }>; }
  interface PlatformDef {
    id: string;
    name: string;
    category: string;
    docsUrl: string;
    fields: FieldDef[];
  }
  const platforms: PlatformDef[] = [
    // ===== 飞书（参考 OpenClaw 实现：WebSocket 长连接模式，只需 App ID + App Secret） =====
    // 文档参考: https://clawd.org.cn/channels/feishu
    // 飞书机器人不需要在飞书后台配置配对码，配对码由本系统 PairingManager 生成
    {
      id: 'feishu', name: '飞书 Feishu (自建应用机器人，WebSocket 长连接)', category: '🇨🇳 国内', docsUrl: 'https://clawd.org.cn/channels/feishu',
      fields: [
        { key: 'appId', label: 'App ID (格式 cli_xxx)', required: true, hint: '飞书开放平台 → 凭证与基础信息 → App ID' },
        { key: 'appSecret', label: 'App Secret', required: true, mask: true, hint: '飞书开放平台 → 凭证与基础信息 → App Secret' },
        { key: 'botName', label: '机器人名称 (可选)', default: 'AI助手', hint: '显示在飞书中的机器人名称' },
        // WebSocket 长连接模式（默认，推荐）：无需 Verification Token / Encrypt Key / 公网 URL
        // 仅当用户选择 webhook 模式时才需要 Verification Token / Encrypt Key（在事件订阅页面获取）
        { key: 'connectionMode', label: '连接模式', default: 'websocket', choices: [
          { name: 'WebSocket 长连接（推荐，无需公网 URL，参考 OpenClaw）', value: 'websocket' },
          { name: 'Webhook HTTP 回调（需公网 HTTPS）', value: 'webhook' },
        ] },
        { key: 'verificationToken', label: 'Verification Token (仅 webhook 模式需要)', hint: '事件订阅页面复制；websocket 模式直接回车跳过', skipIf: (cfg) => cfg.connectionMode !== 'webhook' },
        { key: 'encryptKey', label: 'Encrypt Key (仅 webhook 模式可选)', mask: true, hint: '事件订阅页面设置加密密钥；websocket 模式直接回车跳过', skipIf: (cfg) => cfg.connectionMode !== 'webhook' },
        { key: 'domain', label: '域名版本', default: 'feishu', choices: [
          { name: '飞书（国内版 feishu.cn）', value: 'feishu' },
          { name: 'Lark（国际版 larksuite.com）', value: 'lark' },
        ] },
      ],
    },
    {
      id: 'feishu_webhook', name: '飞书群自定义机器人 (Webhook 群推送)', category: '🇨🇳 国内', docsUrl: 'https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN',
      fields: [
        { key: 'webhookUrl', label: 'Webhook URL', required: true, hint: '群设置 → 群机器人 → 自定义机器人' },
        { key: 'webhookSecret', label: '签名校验 Secret (可选)', mask: true, hint: '创建机器人时勾选"签名校验"' },
      ],
    },
    // ===== 企业微信（智能机器人，WebSocket 长连接，参考 OpenClaw） =====
    {
      id: 'wecom', name: '企业微信 (智能机器人，长连接)', category: '🇨🇳 国内', docsUrl: 'https://clawd.org.cn/channels/wecom.html',
      fields: [
        { key: 'botId', label: 'Bot ID (机器人 ID)', required: true, hint: '企业微信 → 工作台 → 智能机器人 → 创建 → API 模式 → 使用长连接' },
        { key: 'secret', label: 'Secret (机器人密钥)', required: true, mask: true, hint: '创建机器人时生成，仅显示一次' },
      ],
    },
    {
      id: 'wecom_webhook', name: '企业微信群机器人 (Webhook 推送)', category: '🇨🇳 国内', docsUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
      fields: [
        { key: 'webhookUrl', label: 'Webhook URL', required: true, hint: '群聊 → 群机器人 → 新建 → 自定义机器人' },
      ],
    },
    // ===== 钉钉 =====
    {
      id: 'dingtalk', name: '钉钉 (企业内机器人)', category: '🇨🇳 国内', docsUrl: 'https://open.dingtalk.com/document/robots/robot-overview',
      fields: [
        { key: 'appKey', label: 'AppKey (Client ID)', required: true, hint: '钉钉开放平台 → 凭证与基础信息' },
        { key: 'appSecretDing', label: 'AppSecret (Client Secret)', required: true, mask: true, hint: '钉钉开放平台 → 凭证与基础信息' },
        { key: 'robotCode', label: 'Robot Code', required: true, hint: '机器人与消息推送 → 机器人配置' },
        { key: 'aesKey', label: 'AES Key (回调加解密)', hint: '消息接收模式配置' },
      ],
    },
    {
      id: 'dingtalk_webhook', name: '钉钉群自定义机器人 (Webhook)', category: '🇨🇳 国内', docsUrl: 'https://open.dingtalk.com/document/robots/custom-robot-access',
      fields: [
        { key: 'webhookUrl', label: 'Webhook URL', required: true, hint: '群设置 → 智能群助手 → 自定义' },
        { key: 'webhookSecret', label: '加签 Secret (可选)', mask: true, hint: '创建时勾选"加签"' },
      ],
    },
    // ===== 个人微信 / 公众号 =====
    {
      id: 'wechat', name: '个人微信 (wxauto/WeChatFerry 本地桥接)', category: '🇨🇳 国内', docsUrl: 'https://github.com/cluic/wxauto',
      fields: [
        { key: 'bridgeType', label: '桥接方式', default: 'wxauto', choices: [
          { name: 'wxauto（Python 自动化，需登录 PC 微信）', value: 'wxauto' },
          { name: 'WeChatFerry（注入式，需安装 wcf-sdk）', value: 'wcf' },
          { name: 'HTTP Webhook（通用，接收第三方转发）', value: 'webhook' },
        ] },
        { key: 'apiUrl', label: '本地 Bot API 地址', default: 'http://localhost:8080', hint: 'wxauto/WeChatFerry 服务地址' },
        { key: 'apiKey', label: 'API Key (可选)', mask: true, hint: '如服务端要求鉴权则填写' },
        { key: 'botName', label: '机器人微信昵称 (可选)', hint: '用于群聊 @识别' },
      ],
    },
    {
      id: 'wechat_oa', name: '微信公众号 (服务号/订阅号)', category: '🇨🇳 国内', docsUrl: 'https://mp.weixin.qq.com/',
      fields: [
        { key: 'appId', label: 'AppID', required: true, hint: '公众号后台 → 设置与开发 → 基本配置' },
        { key: 'appSecret', label: 'AppSecret', required: true, mask: true },
        { key: 'verificationToken', label: 'Token (服务器配置)', required: true, hint: '基本配置 → 服务器配置 → 自定义 Token' },
        { key: 'encodingAESKey', label: 'EncodingAESKey', hint: '消息加解密密钥（可选）' },
      ],
    },
    // ===== 国际 =====
    {
      id: 'telegram', name: 'Telegram', category: '🌎 国际', docsUrl: 'https://core.telegram.org/bots/api',
      fields: [
        { key: 'botToken', label: 'Bot Token (格式 123456:ABC...)', required: true, mask: true, hint: '与 @BotFather 对话 → /newbot' },
        { key: 'chatId', label: 'Chat ID (目标会话/群组)', required: true, hint: '通过 @userinfobot 获取' },
      ],
    },
    {
      id: 'discord', name: 'Discord', category: '🌎 国际', docsUrl: 'https://discord.com/developers/docs/intro',
      fields: [
        { key: 'botToken', label: 'Bot Token', required: true, mask: true, hint: 'Developer Portal → Bot → Reset Token' },
        { key: 'applicationId', label: 'Application ID (Client ID)', required: true, hint: '应用 General Information' },
        { key: 'guildId', label: 'Guild ID (服务器 ID)', hint: '开启开发者模式 → 右键服务器' },
        { key: 'channelId', label: 'Channel ID (频道 ID)', required: true, hint: '右键频道 → 复制 ID' },
      ],
    },
    {
      id: 'slack', name: 'Slack', category: '🌎 国际', docsUrl: 'https://api.slack.com/docs',
      fields: [
        { key: 'botToken', label: 'Bot User OAuth Token (xoxb-)', required: true, mask: true, hint: 'OAuth & Permissions → 安装到工作区' },
        { key: 'signingSecret', label: 'Signing Secret', hint: 'Basic Information → App Credentials' },
        { key: 'appToken', label: 'App-Level Token (xapp-, Socket Mode)', mask: true, hint: 'Basic Information → App-Level Tokens' },
        { key: 'slackChannelId', label: 'Channel ID', required: true, hint: '右键频道 → 查看频道详情' },
      ],
    },
    {
      id: 'whatsapp', name: 'WhatsApp', category: '🌎 国际', docsUrl: 'https://developers.facebook.com/docs/whatsapp',
      fields: [
        { key: 'apiKey', label: 'API Key', required: true, mask: true, hint: 'WhatsApp Business API' },
        { key: 'apiUrl', label: 'API URL', default: 'https://graph.facebook.com/v18.0' },
      ],
    },
    {
      id: 'teams', name: 'Microsoft Teams', category: '🌎 国际', docsUrl: 'https://learn.microsoft.com/microsoftteams/platform/bots/what-are-bots',
      fields: [
        { key: 'appId', label: 'App ID', required: true, hint: 'Azure → 应用注册' },
        { key: 'appSecret', label: 'App Secret', required: true, mask: true },
        { key: 'botToken', label: 'Bot Token (可选)', mask: true },
      ],
    },
    // ===== 推送类 =====
    {
      id: 'serverchan', name: 'Server酱 (微信推送)', category: '🔔 推送', docsUrl: 'https://sct.ftqq.com/',
      fields: [
        { key: 'sendKey', label: 'SendKey', required: true, mask: true, hint: 'sct.ftqq.com → SendKey 页面' },
      ],
    },
    {
      id: 'bark', name: 'Bark (iOS 推送)', category: '🔔 推送', docsUrl: 'https://github.com/Finb/Bark',
      fields: [
        { key: 'deviceKey', label: 'Device Key', required: true, hint: 'Bark App 首页显示' },
        { key: 'barkServerUrl', label: '服务器地址 (默认 https://api.day.app)', default: 'https://api.day.app' },
      ],
    },
    {
      id: 'email', name: '邮件 (SMTP)', category: '🔔 推送', docsUrl: '',
      fields: [
        { key: 'smtpHost', label: 'SMTP 服务器', required: true, hint: '如 smtp.qq.com / smtp.gmail.com' },
        { key: 'smtpPort', label: 'SMTP 端口', default: '465', hint: '465=SSL, 587=STARTTLS' },
        { key: 'smtpUser', label: '用户名 (邮箱)', required: true },
        { key: 'smtpPass', label: '密码 / 授权码', required: true, mask: true, hint: 'QQ/163/Gmail 需用授权码' },
        { key: 'smtpFrom', label: '发件人邮箱', required: true },
        { key: 'smtpTo', label: '收件人邮箱', required: true },
      ],
    },
    // ===== 通用 =====
    {
      id: 'webhook', name: '通用 Webhook', category: '⚙️ 通用', docsUrl: '',
      fields: [
        { key: 'webhookUrl', label: '接收 URL', required: true },
        { key: 'webhookSecret', label: '签名 Secret (可选)', mask: true },
      ],
    },
    {
      id: 'qq', name: 'QQ (go-cqhttp)', category: '🇨🇳 国内', docsUrl: 'https://docs.go-cqhttp.org/',
      fields: [
        { key: 'apiUrl', label: 'HTTP API 地址', default: 'http://localhost:5700', hint: 'go-cqhttp 服务地址' },
        { key: 'botToken', label: 'Access Token (可选)', mask: true },
      ],
    },
  ];

  const { selected } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'selected',
    message: C.txt('选择要启用的平台（空格选中，回车确认）：'),
    choices: platforms.map(p => ({ name: `${p.category} ${p.name}`, value: p.id })),
    pageSize: 18,
  }]);

  if (!selected || selected.length === 0) {
    console.info(C.wrn('  ⚠️ 未选择任何平台'));
    return;
  }

  // 使用新的 channels.* 结构保存（对标 OpenClaw）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelsConfig: Record<string, any> = config.getChannelsConfig() || {};
  let configuredCount = 0;
  for (const platformId of selected) {
    const platform = platforms.find(p => p.id === platformId);
    if (!platform) continue;
    console.info('');
    console.info(C.cyan(`  ── ${platform.name} ──`));
    if (platform.docsUrl) {
      console.info(C.dim(`  📖 文档: ${platform.docsUrl}`));
    }

    // 飞书通道特殊处理：显示详细配置步骤
    if (platformId === 'feishu') {
      console.info('');
      console.info(C.wrn('  📋 飞书机器人配置步骤（参考 OpenClaw）：'));
      console.info(C.dim('  ─────────────────────────────────────────────'));
      console.info(C.dim('  1. 访问 https://open.feishu.cn/app 登录飞书开放平台'));
      console.info(C.dim('  2. 点击"创建企业自建应用"，填写应用名称和描述'));
      console.info(C.dim('  3. 在"凭证与基础信息"页面复制 App ID 和 App Secret'));
      console.info(C.dim('  4. 在"权限管理"页面点击"批量导入"，粘贴权限 JSON'));
      console.info(C.dim('     （包含 im:message, im:message:send_as_bot 等权限）'));
      console.info(C.dim('  5. 在"应用能力 > 机器人"页面开启机器人能力'));
      console.info(C.dim('  6. 在"事件订阅"页面选择"使用长连接接收事件"'));
      console.info(C.dim('     添加事件: im.message.receive_v1（接收消息）'));
      console.info(C.dim('  7. 在"版本管理与发布"页面创建版本并发布'));
      console.info(C.dim('  8. 回到这里输入 App ID 和 App Secret'));
      console.info(C.dim('  ─────────────────────────────────────────────'));
      console.info('');
      console.info(C.cyan('  📋 权限 JSON（复制到飞书开放平台"批量导入"）：'));
      console.info(C.dim('  ─────────────────────────────────────────────'));
      console.info(C.dim('  {'));
      console.info(C.dim('    "scopes": {'));
      console.info(C.dim('      "tenant": ['));
      console.info(C.dim('        "im:chat",'));
      console.info(C.dim('        "im:message",'));
      console.info(C.dim('        "im:message.p2p_msg:readonly",'));
      console.info(C.dim('        "im:message:send_as_bot",'));
      console.info(C.dim('        "im:message.group_at_msg:readonly",'));
      console.info(C.dim('        "im:resource"'));
      console.info(C.dim('      ]'));
      console.info(C.dim('    }'));
      console.info(C.dim('  }'));
      console.info(C.dim('  ─────────────────────────────────────────────'));
      console.info('');
    }

    // 企业微信通道特殊处理：显示详细配置步骤（参考 OpenClaw）
    if (platformId === 'wecom') {
      console.info('');
      console.info(C.wrn('  📋 企业微信智能机器人配置步骤（参考 OpenClaw）：'));
      console.info(C.dim('  ─────────────────────────────────────────────'));
      console.info(C.dim('  1. 打开企业微信客户端 → 工作台 → 智能机器人'));
      console.info(C.dim('  2. 点击"创建机器人" → 选择"API 模式创建"'));
      console.info(C.dim('  3. 选择连接方式为"使用长连接"（无需公网 IP/域名）'));
      console.info(C.dim('  4. 复制 Bot ID（页面直接显示）'));
      console.info(C.dim('  5. 点击"点击获取"生成 Secret，立即保存（仅显示一次）'));
      console.info(C.dim('  6. 配置机器人可见范围（选择可见的部门/成员）'));
      console.info(C.dim('  7. 保存机器人配置'));
      console.info(C.dim('  8. 回到这里输入 Bot ID 和 Secret'));
      console.info(C.dim('  ─────────────────────────────────────────────'));
      console.info('');
      console.info(C.dim('  💡 提示：长连接模式无需公网 URL，类似飞书 WebSocket'));
      console.info(C.dim('  📖 文档: https://clawd.org.cn/channels/wecom.html'));
      console.info('');
    }

    const channelCfg: Record<string, unknown> = {
      enabled: true,
      type: platformId.replace(/_webhook$/, '') === platformId ? platformId : platformId.split('_')[0],
      label: platform.name,
    };
    let hasRequired = true;
    for (const field of platform.fields) {
      // 支持 skipIf 条件跳过（如 websocket 模式下跳过 Verification Token）
      if (field.skipIf && field.skipIf(channelCfg)) {
        continue;
      }
      // 支持 choices 字段（列表选择）
      if (field.choices && field.choices.length > 0) {
        const firstChoice = field.choices[0];
        const firstVal = typeof firstChoice === 'string' ? firstChoice : firstChoice.value;
        const { value: choiceVal } = await inquirer.prompt([{
          type: 'list',
          name: 'choiceVal',
          message: C.txt(`${field.label}：`),
          choices: field.choices,
          default: field.default || firstVal,
        }]);
        channelCfg[field.key] = choiceVal;
        continue;
      }
      const { value } = await inquirer.prompt([{
        type: field.mask ? 'password' : 'input',
        name: 'value',
        message: C.txt(`${field.label}${field.required ? ' *' : ''}：`),
        default: field.default || '',
        validate: (v: string) => {
          if (!field.required) return true;
          return v.trim().length > 0 || `${field.label} 为必填项`;
        },
      }]);
      // 密码字段输入后显示后4位确认，避免输入错误却看不到
      if (field.mask && value && value.trim()) {
        const v = value.trim();
        const masked = v.length > 8 ? v.substring(0, 4) + '****' + v.substring(v.length - 4) : '****';
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: C.txt(`  确认 ${field.label}（${masked}，共 ${v.length} 字符）是否正确？`),
          default: true,
        }]);
        if (!confirmed) {
          // 重新输入
          const { value: retryValue } = await inquirer.prompt([{
            type: 'password',
            name: 'value',
            message: C.txt(`重新输入 ${field.label}：`),
            validate: (v2: string) => {
              if (!field.required) return true;
              return v2.trim().length > 0 || `${field.label} 为必填项`;
            },
          }]);
          if (retryValue && retryValue.trim()) {
            channelCfg[field.key] = retryValue.trim();
          } else if (field.required) {
            hasRequired = false;
          }
          continue;
        }
      }
      if (value && value.trim()) {
        channelCfg[field.key] = value.trim();
      } else if (field.default) {
        // 有默认值的字段即使用户没输入也保存默认值
        channelCfg[field.key] = field.default;
      } else if (field.required) {
        hasRequired = false;
      }
      if (field.hint && !value) {
        console.info(C.dim(`  💡 ${field.hint}`));
      }
    }
    if (!hasRequired) {
      console.info(C.wrn(`  ⚠️ ${platform.name} 必填项缺失，已跳过`));
      continue;
    }

    // ===== 授权模式配置（配对码机制） =====
    console.info('');
    console.info(C.dim('  ── 授权模式 ──'));
    const { authMode } = await inquirer.prompt([{
      type: 'list',
      name: 'authMode',
      message: C.txt('选择授权模式（控制谁能使用此机器人）：'),
      choices: [
        { name: '配对码模式（默认，推荐）：陌生用户需输入配对码才能使用', value: 'pairing' },
        { name: '开放模式：任何人都能直接使用', value: 'open' },
        { name: '白名单模式：仅允许指定用户ID列表', value: 'allowlist' },
        { name: '禁用私聊：不响应私聊消息', value: 'disabled' },
      ],
      default: 'pairing',
    }]);
    channelCfg.dmPolicy = authMode;

    if (authMode === 'allowlist') {
      const { allowList } = await inquirer.prompt([{
        type: 'input',
        name: 'allowList',
        message: C.txt('允许的用户ID列表（逗号分隔，如 ou_xxx,123456,wxid_xxx）：'),
        validate: (v: string) => v.trim().length > 0 || '请输入至少一个用户ID',
      }]);
      channelCfg.allowFrom = allowList.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (authMode === 'pairing') {
      // 配对码说明（不立即生成，等网关启动后再生成）
      console.info('');
      console.info(C.dim('  ─────────────────────────────────────────────────'));
      console.info(C.cyan.bold('  🔑 配对码机制说明'));
      console.info(C.dim('  ─────────────────────────────────────────────────'));
      console.info(C.dim('  ℹ️  配对流程：'));
      console.info(C.dim('      1. 配置完成后启动网关（下一步会询问）'));
      console.info(C.dim('      2. 在飞书中给机器人发任意消息'));
      console.info(C.dim('      3. 机器人回复"未配对，请输入配对码"'));
      console.info(C.dim('      4. 在 CLI 端运行 `duan pairing generate` 生成配对码'));
      console.info(C.dim('      5. 在飞书中发送 6 位配对码 → 配对成功'));
      console.info(C.dim('  ─────────────────────────────────────────────────'));
      console.info(C.dim('  💡 配对码由本系统生成（6位数字，5分钟有效）'));
      console.info(C.dim('  💡 必须先启动网关，飞书机器人才能收发消息'));
      console.info('');
    }

    channelsConfig[platformId] = channelCfg;
    configuredCount++;
  }

  config.setChannelsConfig(channelsConfig);
  console.info('');
  console.info(C.suc(`  ✅ 已配置 ${configuredCount} 个移动端通道`));

  // 配置完成后提示启动网关（不在此处启动，因为 setup 向导还有后续步骤）
  if (configuredCount > 0) {
    console.info('');
    console.info(C.wrn('  ⚠️  配置已保存，但消息通道还未启动！'));
    console.info('');
    console.info(C.cyan('  📋 启动步骤：'));
    console.info(C.dim('  ─────────────────────────────────────────────'));
    console.info(C.dim('  1. 完成本次配置向导'));
    console.info(C.dim('  2. 运行 `duan gateway` 启动消息通道网关'));
    console.info(C.dim('     （网关启动后飞书/钉钉等机器人才能收发消息）'));
    if (Object.values(channelsConfig).some((c: { dmPolicy?: string }) => c.dmPolicy === 'pairing')) {
      console.info(C.dim('  3. 运行 `duan pairing generate` 生成配对码'));
      console.info(C.dim('  4. 在飞书中发送配对码完成配对'));
    }
    console.info(C.dim('  ─────────────────────────────────────────────'));
    console.info('');
  }
}

async function configureWeb(config: ConfigManager): Promise<void> {
  clearScreen();
  printLogo();
  console.info(C.sec.bold('  ── Web 管理界面配置 ──'));
  console.info('');

  const { enabled } = await inquirer.prompt([{
    type: 'confirm',
    name: 'enabled',
    message: C.txt('是否启用 Web 管理界面？'),
    default: true,
  }]);

  if (!enabled) {
    config.setWebPort('');
    return;
  }

  const { port } = await inquirer.prompt([{
    type: 'input',
    name: 'port',
    message: C.txt('设置管理端口（1-65535）：'),
    default: '3001',
    validate: (v: string) => {
      if (!/^\d+$/.test(v)) return '请输入数字';
      const n = parseInt(v);
      if (n <= 0 || n >= 65536) return '端口范围: 1-65535';
      return true;
    },
  }]);

  config.setWebPort(port);
  console.info('');
  console.info(C.suc(`  ✅ Web 管理界面将在端口 ${port} 启动`));
}

async function confirmAndSave(config: ConfigManager, profile: ProviderProfile): Promise<void> {
  clearScreen();
  printLogo();
  console.info(C.sec.bold('  ── 配置摘要 ──'));
  console.info('');
  console.info(`  ${C.suc('⭐')} ${C.cyan(profile.label)}`);
  console.info(`     模型: ${C.txt(profile.model)}`);
  console.info(`     端点: ${C.dim(profile.baseURL || '默认')}`);
  const webPort = config.getWebPort();
  if (webPort) console.info(`  ${C.suc('🌐')} Web管理: ${C.cyan(`http://localhost:${webPort}`)}`);
  console.info('');

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: C.txt('确认保存配置？'),
    default: true,
  }]);

  if (!confirm) {
    console.info(C.wrn('  ⚠️ 配置已取消'));
    process.exit(0);
  }

  config.addProfile(profile);
  config.setDefaultProfile(profile.id);
  config.save();
  config.applyEnv();

  console.info('');
  console.info(C.suc('  ✅ 配置已保存！'));

  if (!config.isConfigured()) {
    console.info(C.wrn('  ⚠️ API Key 未配置或无效'));
  }
}

export async function runSetupWizard(config: ConfigManager): Promise<void> {
  try {
    // ===== 检测已有 API 配置，提供跳过选项 =====
    const existingProfiles = config.getProfiles();
    let profile: ProviderProfile | null = null;

    if (existingProfiles.length > 0) {
      const defaultProfile = config.getDefaultProfile();
      clearScreen();
      printLogo();
      console.info(C.sec.bold('  ── 已检测到 API 配置 ──'));
      console.info('');
      console.info(C.dim(`  当前共 ${existingProfiles.length} 个 API 配置：`));
      for (const p of existingProfiles.slice(0, 5)) {
        const isDefault = p.id === defaultProfile?.id;
        console.info(`    ${isDefault ? C.suc('⭐') : '  '} ${C.cyan(p.label)} — ${C.dim(p.model)}`);
      }
      if (existingProfiles.length > 5) {
        console.info(C.dim(`    ...还有 ${existingProfiles.length - 5} 个`));
      }
      console.info('');

      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: C.txt('API 已配置，请选择操作：'),
        choices: [
          { name: '跳过 API 配置，直接配置消息通道（推荐）', value: 'skip' },
          { name: '重新配置 API（添加新的供应商）', value: 'reconfigure' },
          { name: '切换默认 API 配置', value: 'switch' },
          { name: '删除已有 API 配置', value: 'delete' },
          { name: '退出配置向导', value: 'exit' },
        ],
        default: 'skip',
      }]);

      if (action === 'exit') {
        console.info(C.dim('  已退出配置向导'));
        return;
      }

      if (action === 'switch') {
        const { profileId } = await inquirer.prompt([{
          type: 'list',
          name: 'profileId',
          message: C.txt('选择默认 API 配置：'),
          choices: existingProfiles.map(p => ({
            name: `${p.label} — ${p.model}`,
            value: p.id,
            short: p.label,
          })),
        }]);
        config.setDefaultProfile(profileId);
        config.applyEnv();
        const switched = existingProfiles.find(p => p.id === profileId);
        console.info(C.suc(`  ✅ 已切换默认配置为: ${switched?.label}`));
        profile = switched || null;
      } else if (action === 'delete') {
        // 删除已有 API 配置
        const { profileId } = await inquirer.prompt([{
          type: 'list',
          name: 'profileId',
          message: C.txt('选择要删除的 API 配置：'),
          choices: existingProfiles.map(p => ({
            name: `${p.label} — ${p.model}${p.id === defaultProfile?.id ? ' (当前默认)' : ''}`,
            value: p.id,
            short: p.label,
          })),
        }]);
        const toDelete = existingProfiles.find(p => p.id === profileId);
        const { confirmDel } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmDel',
          message: C.wrn(`确认删除 "${toDelete?.label} — ${toDelete?.model}" ？此操作不可撤销`),
          default: false,
        }]);
        if (confirmDel) {
          config.removeProfile(profileId);
          // 如果删除的是默认配置，自动切换到第一个
          const remaining = config.getProfiles();
          if (defaultProfile?.id === profileId && remaining.length > 0) {
            config.setDefaultProfile(remaining[0].id);
            console.info(C.suc(`  ✅ 已删除，默认配置已切换为: ${remaining[0].label}`));
            profile = remaining[0];
          } else {
            console.info(C.suc('  ✅ 已删除'));
            profile = config.getDefaultProfile() || null;
          }
          config.applyEnv();
        } else {
          console.info(C.dim('  已取消删除'));
          profile = defaultProfile || null;
        }
        await sleep(800);
      } else if (action === 'skip') {
        // 使用当前默认配置
        profile = defaultProfile || existingProfiles[0];
        console.info(C.suc(`  ✅ 跳过 API 配置，使用: ${profile.label} — ${profile.model}`));
        await sleep(800);
      }
      // action === 'reconfigure' 时继续走下面的流程
    }

    // 如果未跳过，则走完整 API 配置流程
    if (!profile) {
      const provider = await selectProvider();
      if (!provider) {
        console.info(C.err('  ❌ 未选择提供商'));
        return;
      }

      const result = await configureProvider(provider);
      if (!result) {
        console.info(C.wrn('  ⚠️ 配置未完成'));
        return;
      }

      profile = {
        id: `profile-${Date.now()}`,
        label: provider.label,
        provider: provider.id,
        baseURL: provider.baseURL,
        apiKey: result.apiKey,
        model: result.model,
      };
    }

    await configureMobile(config);
    await configureWeb(config);
    await confirmAndSave(config, profile);

    // 清理重复的profiles
    config.cleanupDupes();

    initWorkspace(config.getConfig().workspace);

    console.info('');
    console.info(C.pri.bold('  ╔══════════════════════════════════════════════════════════════════════╗'));
    console.info(C.pri.bold('  ║                            配置完成！                               ║'));
    console.info(C.pri.bold('  ╚══════════════════════════════════════════════════════════════════════╝'));
    console.info('');
    console.info(C.txt('  📖 快速命令:'));
    console.info(`     ${C.cyan('duan')}              - 启动对话`);
    console.info(`     ${C.cyan('duan setup')}       - 重新配置`);
    console.info(`     ${C.cyan('duan gateway')}     - 启动消息通道网关（飞书/钉钉等）`);
    console.info(`     ${C.cyan('duan pairing generate')} - 生成配对码`);
    const webPort = config.getWebPort();
    if (webPort) console.info(`     ${C.cyan(`http://localhost:${webPort}`)}  - 打开管理界面`);
    console.info(`     ${C.cyan('duan status')}      - 查看配置状态`);
    console.info('');
  } catch (err: unknown) {
    console.info('');
    console.info(C.err(`  ❌ 配置过程中发生错误: ${(err instanceof Error ? err.message : String(err))}`));
    console.info('');
  }
}
