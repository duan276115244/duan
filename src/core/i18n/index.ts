/**
 * 轻量 i18n 模块 — 自动检测用户语言并影响 agent 回复语言
 *
 * 设计目标：
 * - 零外部依赖（不引 i18next 等），~150 行自包含
 * - 自动检测：基于 CJK 字符比例判断 zh-CN / en-US，无需用户手动切换
 * - 影响 system prompt：检测后追加 "请用{语言}回复" 指令
 * - 默认 zh-CN（项目主语言）
 *
 * 使用方式：
 *   import { detectAndSetLocale, getLocale, getRespondInstruction, t } from './i18n/index.js';
 *   detectAndSetLocale(userMessage);  // 每轮用户消息后检测
 *   const instruction = getRespondInstruction();  // 拼入 system prompt
 */
import * as fs from 'fs';
import * as path from 'path';

// ============ 类型定义 ============

export type Locale = 'zh-CN' | 'en-US' | 'ja-JP';

interface LocaleConfig {
  /** 语言名称（用于 system prompt 指令） */
  languageName: string;
  /** "请用{语言}回复" 模板 */
  respondInstruction: string;
  /** CJK 字符占比阈值（超过则判定为该 locale） */
  cjkThreshold: number;
}

// ============ Locale 配置 ============

const LOCALE_CONFIGS: Record<Locale, LocaleConfig> = {
  'zh-CN': {
    languageName: '中文',
    respondInstruction: '请使用中文回复，保持自然流畅的中文表达。',
    cjkThreshold: 0.2, // CJK 占比 > 20% 判定为中文（纯英文为 0%，中文句夹英文术语常 ≥20%）
  },
  'en-US': {
    languageName: 'English',
    respondInstruction: 'Please respond in English with natural, fluent expression.',
    cjkThreshold: 0, // en-US 不靠 CJK 判定，走 fallback
  },
  'ja-JP': {
    languageName: '日本語',
    respondInstruction: '日本語で自然な表現で返答してください。',
    cjkThreshold: 0.3, // 与中文区分靠假名比例
  },
};

// ============ 状态（进程级单例） ============

let currentLocale: Locale = 'zh-CN';

// ============ 公开 API ============

/**
 * 获取当前 locale
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * 显式设置 locale（用户手动切换时用）
 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/**
 * 检测文本的语言 locale
 *
 * 启发式策略（无 LLM 依赖，确定性 + 快）：
 * 1. 统计 CJK 汉字、平假名、片假名、ASCII 字母占比
 * 2. 平假名+片假名占比 > 5% → ja-JP（日语假名是日语独有）
 * 3. CJK 汉字占比 > 30% → zh-CN
 * 4. 否则 → en-US（默认 fallback）
 *
 * @param text 用户输入文本
 * @returns 检测到的 locale
 */
export function detectLocale(text: string): Locale {
  if (!text || text.length === 0) return currentLocale;

  const sample = text.substring(0, 500); // 取前 500 字符采样，避免长文本性能问题
  let cjk = 0;        // CJK 统一汉字（中日韩共用，但主要见于中文）
  let hiragana = 0;   // 平假名（日语独有）
  let katakana = 0;   // 片假名（日语独有）
  let ascii = 0;      // ASCII 字母（英文）
  let total = 0;

  for (const ch of sample) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    total++;
    // 平假名 U+3040-U+309F
    if (code >= 0x3040 && code <= 0x309f) { hiragana++; continue; }
    // 片假名 U+30A0-U+30FF
    if (code >= 0x30a0 && code <= 0x30ff) { katakana++; continue; }
    // CJK 统一汉字 U+4E00-U+9FFF
    if (code >= 0x4e00 && code <= 0x9fff) { cjk++; continue; }
    // ASCII 字母
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) { ascii++; continue; }
  }

  if (total === 0) return currentLocale;

  // 日语判定：假名占比 > 5%（假名是日语独有，中文不含假名）
  const kanaRatio = (hiragana + katakana) / total;
  if (kanaRatio > 0.05) return 'ja-JP';

  // 中文判定：CJK 汉字占比 > 20%（纯英文为 0%，中文句夹英文术语常 ≥20%）
  const cjkRatio = cjk / total;
  if (cjkRatio > 0.2) return 'zh-CN';

  // 英文判定：ASCII 字母占比 > 40%
  const asciiRatio = ascii / total;
  if (asciiRatio > 0.4) return 'en-US';

  // 无法判定（数字/符号为主）→ 保持当前 locale
  return currentLocale;
}

/**
 * 检测并设置当前 locale（每轮用户消息后调用）
 * @returns 检测到的 locale（已设为当前）
 */
export function detectAndSetLocale(text: string): Locale {
  const detected = detectLocale(text);
  currentLocale = detected;
  return detected;
}

/**
 * 返回当前 locale 的"请用{语言}回复"指令（拼入 system prompt）
 * 若当前是默认 zh-CN 且用户也用中文，返回空字符串（避免冗余指令）
 */
export function getRespondInstruction(): string {
  // zh-CN 是默认，不需要额外指令（system prompt 本就是中文）
  if (currentLocale === 'zh-CN') return '';
  return LOCALE_CONFIGS[currentLocale].respondInstruction;
}

/**
 * 返回当前 locale 的语言名称
 */
export function getLanguageName(): string {
  return LOCALE_CONFIGS[currentLocale].languageName;
}

// ============ 翻译函数（轻量，用于 UI 串） ============

let translations: Record<string, Record<Locale, string>> = {};

/**
 * 加载翻译文件（从 locales/ 目录读取 JSON）
 * 文件格式：{ "key": { "zh-CN": "...", "en-US": "...", "ja-JP": "..." } }
 */
export function loadTranslations(localesDir: string): void {
  try {
    const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(localesDir, file), 'utf-8');
      const data = JSON.parse(content);
      translations = { ...translations, ...data };
    }
  } catch {
    // 目录不存在或读取失败 → 仅用 fallback
  }
}

/**
 * 翻译 key 到当前 locale
 * @param key 翻译键（如 "greeting"）
 * @param params 模板参数（如 { name: "段先生" } 替换 {name} 占位符）
 * @returns 翻译后的字符串；无翻译时返回 key 本身
 */
export function t(key: string, params?: Record<string, string>): string {
  const entry = translations[key];
  if (!entry) return key;
  let text = entry[currentLocale] ?? entry['zh-CN'] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return text;
}
