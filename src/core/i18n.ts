/**
 * 国际化模块 — i18n
 *
 * P0 可访问性修复：提供中英文双语支持基础设施。
 * 之前全量中文硬编码，非中文用户基本不可用。
 *
 * 用法：
 *   import { t, setLocale, getLocale } from './i18n.js';
 *   setLocale('en');
 *   console.log(t('welcome')); // "Welcome"
 *
 * 语言检测优先级：
 *   1. DUAN_LANG 环境变量
 *   2. --lang CLI 参数
 *   3. LC_ALL/LC_MESSAGES/LANG 环境变量
 *   4. 默认 'zh'
 */

// ============ 类型定义 ============

export type Locale = 'zh' | 'en';

type MessageCatalog = Record<string, string>;

// ============ 消息目录 ============

const zh_CN: MessageCatalog = {
  // CLI 启动
  'cli.welcome': '段先生 v19.0 — 超级智能体',
  'cli.starting': '正在启动...',
  'cli.new_window': '段先生 v19.0 已在新窗口中启动',
  'cli.close_hint': '关闭此窗口不会影响智能体运行',
  'cli.no_window': '无法打开新窗口，在当前终端启动...',
  'cli.no_terminal': '未找到可用的终端模拟器，在当前终端启动...',

  // 设置向导
  'wizard.title': '欢迎使用段先生设置向导',
  'wizard.api_key': '请输入 API Key',
  'wizard.base_url': '请输入 API Base URL',
  'wizard.model': '请选择模型',
  'wizard.complete': '设置完成！',

  // 错误消息
  'error.generic': '发生错误',
  'error.api_key_missing': 'API Key 未配置',
  'error.network': '网络连接失败',
  'error.model_not_found': '模型不存在',
  'error.timeout': '请求超时',
  'error.auth': '认证失败',
  'error.balance': '余额不足',

  // 状态消息
  'status.thinking': '思考中',
  'status.executing': '执行中',
  'status.completed': '已完成',
  'status.failed': '已失败',
  'status.cancelled': '已取消',

  // Agent 交互
  'agent.input_prompt': '请输入',
  'agent.task_complete': '任务完成',
  'agent.max_turns': '已达到最大轮次',
  'agent.verification_warning': '对抗验证警告',

  // 工具相关
  'tool.executing': '正在执行工具',
  'tool.success': '工具执行成功',
  'tool.failed': '工具执行失败',
  'tool.approval_required': '需要审批',
  'tool.approved': '已批准',
  'tool.denied': '已拒绝',
};

const en_US: MessageCatalog = {
  // CLI startup
  'cli.welcome': 'MrDuan v19.0 — Super Agent',
  'cli.starting': 'Starting...',
  'cli.new_window': 'MrDuan v19.0 launched in new window',
  'cli.close_hint': 'Closing this window will not affect the agent',
  'cli.no_window': 'Cannot open new window, starting in current terminal...',
  'cli.no_terminal': 'No terminal emulator found, starting in current terminal...',

  // Setup wizard
  'wizard.title': 'Welcome to MrDuan Setup Wizard',
  'wizard.api_key': 'Please enter API Key',
  'wizard.base_url': 'Please enter API Base URL',
  'wizard.model': 'Please select a model',
  'wizard.complete': 'Setup complete!',

  // Error messages
  'error.generic': 'An error occurred',
  'error.api_key_missing': 'API Key not configured',
  'error.network': 'Network connection failed',
  'error.model_not_found': 'Model not found',
  'error.timeout': 'Request timed out',
  'error.auth': 'Authentication failed',
  'error.balance': 'Insufficient balance',

  // Status messages
  'status.thinking': 'Thinking',
  'status.executing': 'Executing',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.cancelled': 'Cancelled',

  // Agent interaction
  'agent.input_prompt': 'Input',
  'agent.task_complete': 'Task complete',
  'agent.max_turns': 'Max turns reached',
  'agent.verification_warning': 'Adversarial verification warning',

  // Tool operations
  'tool.executing': 'Executing tool',
  'tool.success': 'Tool execution succeeded',
  'tool.failed': 'Tool execution failed',
  'tool.approval_required': 'Approval required',
  'tool.approved': 'Approved',
  'tool.denied': 'Denied',
};

const CATALOGS: Record<Locale, MessageCatalog> = {
  zh: zh_CN,
  en: en_US,
};

// ============ 状态管理 ============

let currentLocale: Locale = detectLocale();

/** 从环境变量和 CLI 参数检测语言 */
function detectLocale(): Locale {
  // 1. DUAN_LANG 环境变量
  const duanLang = process.env.DUAN_LANG;
  if (duanLang) {
    const normalized = duanLang.toLowerCase().trim();
    if (normalized.startsWith('en')) return 'en';
    if (normalized.startsWith('zh')) return 'zh';
  }

  // 2. --lang CLI 参数
  const cliArgs = process.argv.slice(2);
  const langIdx = cliArgs.indexOf('--lang');
  if (langIdx >= 0 && cliArgs[langIdx + 1]) {
    const lang = cliArgs[langIdx + 1].toLowerCase().trim();
    if (lang.startsWith('en')) return 'en';
    if (lang.startsWith('zh')) return 'zh';
  }

  // 3. LC_ALL / LC_MESSAGES / LANG 环境变量
  const langEnv = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  if (langEnv.toLowerCase().startsWith('en')) return 'en';
  if (langEnv.toLowerCase().startsWith('zh')) return 'zh';

  // 4. 默认中文
  return 'zh';
}

// ============ 公共 API ============

/** 获取当前语言 */
export function getLocale(): Locale {
  return currentLocale;
}

/** 设置当前语言 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/**
 * 翻译消息
 * @param key 消息键（如 'cli.welcome'）
 * @param params 插值参数（如 { name: '段先生' } 替换 {name}）
 * @returns 翻译后的字符串，找不到则返回 key
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const catalog = CATALOGS[currentLocale] || CATALOGS.zh;
  let msg = catalog[key] || CATALOGS.zh[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return msg;
}

/** 检查当前是否为英文 */
export function isEnglish(): boolean {
  return currentLocale === 'en';
}

/** 检查当前是否为中文 */
export function isChinese(): boolean {
  return currentLocale === 'zh';
}
