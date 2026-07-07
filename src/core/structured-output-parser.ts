/**
 * 结构化输出解析器 — StructuredOutputParser
 *
 * 灵感来源：LibTV 的 "best-effort parse + fallback" 模式
 * 核心能力：
 * 1. 从LLM输出中稳健解析JSON（直接解析 → 代码块提取 → 文本提取 → 修复 → 默认值）
 * 2. 解析列表（编号列表、项目符号、逗号分隔）
 * 3. 解析键值对（key: value / key=value / JSON-like）
 * 4. 提取Markdown代码块
 * 5. 修复常见JSON问题（尾逗号、未引用键、单引号、缺括号）
 * 6. Agent Loop 工具 — 通过 getToolDefinitions() 注册为可用工具
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { errMsg } from './utils.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 解析方法 */
export type ParseMethod = 'direct' | 'code_block' | 'regex_extract' | 'repaired' | 'default';

/** 解析结果 */
export interface ParseResult<T> {
  /** 是否成功解析 */
  success: boolean;
  /** 解析后的数据 */
  data: T;
  /** 使用的解析方法 */
  method: ParseMethod;
  /** 置信度 0-1 */
  confidence: number;
  /** 警告信息 */
  warnings: string[];
}


// ============ 主类 ============

export class StructuredOutputParser {
  private log = logger.child({ module: 'StructuredOutputParser' });

  // 统计数据
  private stats = {
    parseJSONCount: 0,
    parseJSONSuccess: 0,
    parseListCount: 0,
    parseKVCount: 0,
    extractCodeBlockCount: 0,
    repairJSONCount: 0,
    repairJSONSuccess: 0,
    methodStats: {
      direct: 0,
      code_block: 0,
      regex_extract: 0,
      repaired: 0,
      default: 0,
    },
  };

  constructor() {}

  // ========== 核心方法 ==========

  /**
   * 从LLM输出中解析JSON
   * 尝试链：直接解析 → 代码块提取 → 文本正则提取 → 修复后解析 → 返回默认值
   */
  parseJSON<T = any>(raw: string, defaultValue?: T): ParseResult<T> {
    this.stats.parseJSONCount++;
    const warnings: string[] = [];

    if (!raw || typeof raw !== 'string') {
      warnings.push('输入为空或非字符串');
      return this.defaultResult(defaultValue, warnings);
    }

    const trimmed = raw.trim();

    // 策略1: 直接解析
    try {
      const data = JSON.parse(trimmed) as T;
      this.stats.parseJSONSuccess++;
      this.stats.methodStats.direct++;
      return {
        success: true,
        data,
        method: 'direct',
        confidence: 1.0,
        warnings: [],
      };
    } catch { /* 继续尝试 */ }

    // 策略2: 从Markdown代码块中提取
    const codeBlockResult = this.tryParseFromCodeBlock<T>(trimmed);
    if (codeBlockResult) {
      this.stats.parseJSONSuccess++;
      this.stats.methodStats.code_block++;
      return codeBlockResult;
    }

    // 策略3: 正则提取JSON文本
    const regexResult = this.tryParseByRegex<T>(trimmed);
    if (regexResult) {
      this.stats.parseJSONSuccess++;
      this.stats.methodStats.regex_extract++;
      return regexResult;
    }

    // 策略4: 修复后解析
    const repairedResult = this.tryParseRepaired<T>(trimmed, warnings);
    if (repairedResult) {
      this.stats.parseJSONSuccess++;
      this.stats.methodStats.repaired++;
      return repairedResult;
    }

    // 策略5: 返回默认值
    warnings.push('所有解析策略均失败，返回默认值');
    return this.defaultResult(defaultValue, warnings);
  }

  /**
   * 从LLM输出中解析列表
   * 支持：编号列表、项目符号列表、逗号分隔
   */
  parseList(raw: string): string[] {
    this.stats.parseListCount++;

    if (!raw || typeof raw !== 'string') return [];

    const trimmed = raw.trim();
    const items: string[] = [];

    // 尝试1: 解析JSON数组
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch { /* 继续尝试 */ }

    // 尝试2: 从代码块提取JSON数组
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        if (Array.isArray(parsed)) {
          return parsed.map(String);
        }
      } catch { /* 继续尝试 */ }
    }

    // 尝试3: 编号列表 (1. 2. 3. 或 1) 2) 3))
    const numberedItems = trimmed.match(/(?:^|\n)\s*(?:\d+[.)]\s*|[-*•]\s*)(.+)/g);
    if (numberedItems && numberedItems.length > 0) {
      for (const item of numberedItems) {
        const cleaned = item.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim();
        if (cleaned) items.push(cleaned);
      }
      if (items.length > 0) return items;
    }

    // 尝试4: 逐行解析（项目符号或纯文本行）
    const lines = trimmed.split('\n');
    for (const line of lines) {
      const cleaned = line.replace(/^\s*[-*•]\s*/, '').trim();
      if (cleaned && !cleaned.startsWith('#') && !cleaned.startsWith('```')) {
        items.push(cleaned);
      }
    }
    if (items.length > 0) return items;

    // 尝试5: 逗号分隔
    if (trimmed.includes(',')) {
      const parts = trimmed.split(',').map(s => s.trim()).filter(s => s.length > 0);
      if (parts.length > 1) return parts;
    }

    // 尝试6: 中文顿号分隔
    if (trimmed.includes('、')) {
      const parts = trimmed.split('、').map(s => s.trim()).filter(s => s.length > 0);
      if (parts.length > 1) return parts;
    }

    // 单条目
    if (trimmed) return [trimmed];

    return [];
  }

  /**
   * 从LLM输出中解析键值对
   * 支持："key: value"、"key=value"、JSON-like
   */
  parseKeyValue(raw: string): Record<string, string> {
    this.stats.parseKVCount++;

    if (!raw || typeof raw !== 'string') return {};

    const trimmed = raw.trim();
    const result: Record<string, string> = {};

    // 尝试1: 解析JSON对象
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          result[key] = String(value);
        }
        return result;
      }
    } catch { /* 继续尝试 */ }

    // 尝试2: 从代码块提取JSON对象
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
          for (const [key, value] of Object.entries(parsed)) {
            result[key] = String(value);
          }
          return result;
        }
      } catch { /* 继续尝试 */ }
    }

    // 尝试3: 逐行解析 key: value 或 key=value
    const lines = trimmed.split('\n');
    const kvPatterns = [
      /^["']?([^"':=]+?)["']?\s*[:：]\s*(.+)$/,       // key: value 或 key：value
      /^["']?([^"':=]+?)["']?\s*=\s*(.+)$/,            // key=value
      /^\s*[-*•]\s*["']?([^"':=]+?)["']?\s*[:：]\s*(.+)$/, // - key: value
    ];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('```')) continue;

      for (const pattern of kvPatterns) {
        const match = trimmedLine.match(pattern);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim().replace(/^['"]|['"]$/g, '');
          if (key) {
            result[key] = value;
            break;
          }
        }
      }
    }

    return result;
  }

  /**
   * 从Markdown中提取代码块
   */
  extractCodeBlock(raw: string, language?: string): string | null {
    this.stats.extractCodeBlockCount++;

    if (!raw || typeof raw !== 'string') return null;

    // 如果指定了语言，精确匹配
    if (language) {
      const pattern = new RegExp('```' + language + '\\s*\\n?([\\s\\S]*?)\\n?```', 'i');
      const match = raw.match(pattern);
      return match ? match[1].trim() : null;
    }

    // 未指定语言，提取第一个代码块
    const match = raw.match(/```(?:\w+)?\s*\n?([\s\S]*?)\n?```/);
    return match ? match[1].trim() : null;
  }

  /**
   * 尝试修复破损的JSON
   * 修复：尾逗号、未引用键、单引号、缺括号
   */
  repairJSON(raw: string): string {
    this.stats.repairJSONCount++;

    if (!raw || typeof raw !== 'string') return raw;

    let repaired = raw.trim();

    // 1. 移除尾逗号（对象和数组中的）
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    // 2. 将单引号替换为双引号（仅键和字符串值）
    repaired = this.replaceSingleQuotes(repaired);

    // 3. 为未引用的键添加双引号
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

    // 4. 修复缺少的右括号
    repaired = this.fixMissingBrackets(repaired);

    // 5. 移除BOM和不可见字符
    repaired = repaired.replace(/^\uFEFF/, '');
    // eslint-disable-next-line no-control-regex
    repaired = repaired.replace(/[\x00-\x1F\x7F]/g, (char) => {
      // 保留换行符、制表符、回车符
      if (char === '\n' || char === '\t' || char === '\r') return char;
      return '';
    });

    // 6. 移除JSON前后的非JSON文本
    const jsonStart = repaired.search(/[{[]/);
    if (jsonStart > 0) {
      repaired = repaired.substring(jsonStart);
    }

    // 7. 修复布尔值和null的大小写
    repaired = repaired.replace(/\bTrue\b/g, 'true');
    repaired = repaired.replace(/\bFalse\b/g, 'false');
    repaired = repaired.replace(/\bNone\b/g, 'null');

    // 验证修复结果
    try {
      JSON.parse(repaired);
      this.stats.repairJSONSuccess++;
      this.log.debug('JSON修复成功');
    } catch (err: any) {
      this.log.warn('JSON修复后仍无法解析', { error: errMsg(err) });
    }

    return repaired;
  }

  /**
   * 获取统计数据
   */
  getStats(): Record<string, any> {
    return {
      parseJSONCount: this.stats.parseJSONCount,
      parseJSONSuccessRate: this.stats.parseJSONCount > 0
        ? (this.stats.parseJSONSuccess / this.stats.parseJSONCount * 100).toFixed(1) + '%'
        : 'N/A',
      parseListCount: this.stats.parseListCount,
      parseKVCount: this.stats.parseKVCount,
      extractCodeBlockCount: this.stats.extractCodeBlockCount,
      repairJSONCount: this.stats.repairJSONCount,
      repairJSONSuccessRate: this.stats.repairJSONCount > 0
        ? (this.stats.repairJSONSuccess / this.stats.repairJSONCount * 100).toFixed(1) + '%'
        : 'N/A',
      methodDistribution: { ...this.stats.methodStats },
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'parse_json',
        description: '从LLM输出文本中稳健解析JSON。尝试链：直接解析 → Markdown代码块提取 → 正则提取 → 修复后解析 → 返回默认值。返回ParseResult包含数据、解析方法、置信度和警告。',
        parameters: {
          raw: {
            type: 'string',
            description: 'LLM输出的原始文本，可能包含Markdown代码块包裹的JSON、带尾逗号的JSON等',
            required: true,
          },
          defaultValue: {
            type: 'string',
            description: '解析失败时返回的默认值（JSON字符串），不传则返回null',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            let defaultVal: any = undefined;
            if (args.defaultValue) {
              try {
                defaultVal = JSON.parse(args.defaultValue as string);
              } catch {
                defaultVal = args.defaultValue;
              }
            }

            const result = self.parseJSON(args.raw as string, defaultVal);
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return `❌ JSON解析失败: ${err.message}`;
          }
        },
      },
      {
        name: 'parse_list',
        description: '从LLM输出文本中解析列表。支持JSON数组、编号列表(1. 2. 3.)、项目符号列表(- * •)、逗号分隔、中文顿号分隔等格式。',
        parameters: {
          raw: {
            type: 'string',
            description: 'LLM输出的原始文本',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = self.parseList(args.raw as string);
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return `❌ 列表解析失败: ${err.message}`;
          }
        },
      },
      {
        name: 'parse_kv',
        description: '从LLM输出文本中解析键值对。支持JSON对象、"key: value"格式、"key=value"格式、以及Markdown列表中的键值对。',
        parameters: {
          raw: {
            type: 'string',
            description: 'LLM输出的原始文本',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = self.parseKeyValue(args.raw as string);
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return `❌ 键值对解析失败: ${err.message}`;
          }
        },
      },
      {
        name: 'parse_code',
        description: '从LLM输出的Markdown文本中提取代码块。可指定编程语言精确匹配，不指定则提取第一个代码块。',
        parameters: {
          raw: {
            type: 'string',
            description: '包含Markdown代码块的LLM输出文本',
            required: true,
          },
          language: {
            type: 'string',
            description: '要提取的代码语言（如 typescript、python、json），不传则提取第一个代码块',
            required: false,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = self.extractCodeBlock(
              args.raw as string,
              args.language as string | undefined,
            );
            if (result === null) {
              return '⚠️ 未找到代码块';
            }
            return result;
          } catch (err: any) {
            return `❌ 代码块提取失败: ${err.message}`;
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 从Markdown代码块中尝试解析JSON */
  private tryParseFromCodeBlock<T>(text: string): ParseResult<T> | null {
    // 匹配 ```json ... ``` 或 ``` ... ```
    const patterns = [
      /```json\s*\n?([\s\S]*?)\n?```/i,
      /```\s*\n?([\s\S]*?)\n?```/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1].trim()) as T;
          return {
            success: true,
            data,
            method: 'code_block',
            confidence: 0.95,
            warnings: [],
          };
        } catch { /* 继续尝试 */ }
      }
    }

    return null;
  }

  /** 通过正则提取JSON文本 */
  private tryParseByRegex<T>(text: string): ParseResult<T> | null {
    // 匹配 { ... } 或 [ ... ]
    const objectMatch = text.match(/\{[\s\S]*\}/);
    const arrayMatch = text.match(/\[[\s\S]*\]/);

    const candidates = [objectMatch, arrayMatch].filter(Boolean) as RegExpMatchArray[];

    for (const match of candidates) {
      try {
        const data = JSON.parse(match[0]) as T;
        return {
          success: true,
          data,
          method: 'regex_extract',
          confidence: 0.8,
          warnings: ['通过正则提取，可能不完整'],
        };
      } catch { /* 继续尝试 */ }
    }

    return null;
  }

  /** 修复后尝试解析 */
  private tryParseRepaired<T>(text: string, warnings: string[]): ParseResult<T> | null {
    // 先尝试修复整个文本
    const repaired = this.repairJSON(text);
    try {
      const data = JSON.parse(repaired) as T;
      warnings.push('JSON经过修复后成功解析');
      return {
        success: true,
        data,
        method: 'repaired',
        confidence: 0.7,
        warnings,
      };
    } catch { /* 继续尝试 */ }

    // 尝试从代码块中提取后修复
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      const repairedBlock = this.repairJSON(codeBlockMatch[1]);
      try {
        const data = JSON.parse(repairedBlock) as T;
        warnings.push('代码块内JSON经过修复后成功解析');
        return {
          success: true,
          data,
          method: 'repaired',
          confidence: 0.65,
          warnings,
        };
      } catch { /* 继续尝试 */ }
    }

    // 尝试正则提取后修复
    const objectMatch = text.match(/\{[\s\S]*\}/);
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    const candidates = [objectMatch, arrayMatch].filter(Boolean) as RegExpMatchArray[];

    for (const match of candidates) {
      const repairedCandidate = this.repairJSON(match[0]);
      try {
        const data = JSON.parse(repairedCandidate) as T;
        warnings.push('正则提取的JSON经过修复后成功解析');
        return {
          success: true,
          data,
          method: 'repaired',
          confidence: 0.6,
          warnings,
        };
      } catch { /* 继续尝试 */ }
    }

    return null;
  }

  /** 返回默认值结果 */
  private defaultResult<T>(defaultValue: T | undefined, warnings: string[]): ParseResult<T> {
    this.stats.methodStats.default++;
    return {
      success: false,
      data: defaultValue as T,
      method: 'default',
      confidence: 0,
      warnings,
    };
  }

  /** 替换单引号为双引号（智能替换，避免破坏内容中的单引号） */
  private replaceSingleQuotes(text: string): string {
    let result = '';
    let inDoubleQuote = false;
    let inSingleQuote = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const prevChar = i > 0 ? text[i - 1] : '';
      const nextChar = i < text.length - 1 ? text[i + 1] : '';

      if (char === '"' && prevChar !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        result += char;
      } else if (char === "'" && prevChar !== '\\') {
        if (inDoubleQuote) {
          // 在双引号字符串内，保留单引号
          result += char;
        } else if (inSingleQuote) {
          // 单引号结束，替换为双引号
          inSingleQuote = false;
          result += '"';
        } else {
          // 单引号开始，替换为双引号
          // 检查是否像键或字符串值
          if (nextChar && !/\s/.test(nextChar)) {
            inSingleQuote = true;
            result += '"';
          } else {
            result += char;
          }
        }
      } else {
        result += char;
      }
    }

    return result;
  }

  /** 修复缺少的右括号 */
  private fixMissingBrackets(text: string): string {
    const stack: string[] = [];
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const prevChar = i > 0 ? text[i - 1] : '';

      if ((char === '"' || char === "'") && prevChar !== '\\') {
        if (inString && char === stringChar) {
          inString = false;
        } else if (!inString) {
          inString = true;
          stringChar = char;
        }
      }

      if (!inString) {
        if (char === '{' || char === '[') {
          stack.push(char === '{' ? '}' : ']');
        } else if (char === '}' || char === ']') {
          if (stack.length > 0) {
            stack.pop();
          }
        }
      }
    }

    // 补充缺少的右括号
    let fixed = text;
    while (stack.length > 0) {
      fixed += stack.pop();
    }

    return fixed;
  }
}
