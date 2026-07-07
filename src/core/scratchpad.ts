/**
 * 全局事实板（Scratchpad）
 *
 * 跨模块共享的事实板，在上下文压缩和切换时保留关键事实。
 * 核心设计：
 * - 通过 key-value 存储结构化事实，支持标签和重要性评分
 * - 自动从对话消息中提取事实（项目工具、凭证、端点、版本等）
 * - 在 token 预算内格式化输出，供 LLM 注入使用
 * - 支持序列化/反序列化，用于检查点和持久化
 * - 最大 100 条，满时自动淘汰最低重要性条目
 */

// ============ 类型定义 ============

/** 事实条目 */
export interface ScratchpadEntry {
  /** 唯一键 */
  key: string;
  /** 事实值 */
  value: string;
  /** 来源（模块名、Agent ID 等） */
  source: string;
  /** 重要性评分（0-1，1 最重要） */
  importance: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
  /** 标签列表，用于分类和检索 */
  tags: string[];
}

/** set 方法的可选参数 */
export interface ScratchpadSetOptions {
  /** 来源 */
  source?: string;
  /** 重要性评分（0-1） */
  importance?: number;
  /** 标签列表 */
  tags?: string[];
}

/** 聊天消息（用于 extractFromMessages） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

// ============ 事实提取模式 ============

/** 事实提取规则 */
interface ExtractionPattern {
  /** 正则匹配模式 */
  pattern: RegExp;
  /** 事实标签 */
  tag: string;
  /** 默认重要性 */
  defaultImportance: number;
}

/** 中英文事实提取模式 */
const FACT_PATTERNS: ExtractionPattern[] = [
  // 项目工具
  {
    pattern: /(?:项目(?:使用|用的是)|project\s+uses?\s+|using\s+)(pnpm|yarn|npm|bun|cargo|pip|poetry|gradle|maven|make|bazel)/i,
    tag: 'project_tool',
    defaultImportance: 0.7,
  },
  // 凭证
  {
    pattern: /(?:数据库|密码|密钥|Token|API\s*Key|Secret|credential|password)\s*(?:是|=|:)\s*(\S+)/i,
    tag: 'credential',
    defaultImportance: 0.9,
  },
  // 端点
  {
    pattern: /(?:端口|地址|URL|endpoint|host)\s*(?:是|=|:)\s*(\S+)/i,
    tag: 'endpoint',
    defaultImportance: 0.8,
  },
  // 版本
  {
    pattern: /(?:版本号?|version)\s*(?:是|=|:)\s*(\d+(?:\.\d+)*)/i,
    tag: 'version',
    defaultImportance: 0.6,
  },
  // 路径
  {
    pattern: /(?:文件|目录|路径|file|dir|path)\s*(?:是|=|:)\s*([^\s,，。.]+)/i,
    tag: 'path',
    defaultImportance: 0.6,
  },
  // 配置
  {
    pattern: /(?:配置|设置|config|setting)\s*(\S+)\s*(?:是|=|:)\s*(\S+)/i,
    tag: 'config',
    defaultImportance: 0.7,
  },
  // 错误事实
  {
    pattern: /(?:错误|报错|Error|exception|bug)\s*(?:是|=|:|为)\s*([^\n]{5,80})/i,
    tag: 'error_fact',
    defaultImportance: 0.8,
  },
  // 技术栈
  {
    pattern: /(?:技术栈|框架|语言|stack|framework)\s*(?:是|=|:)\s*([^\n]{3,60})/i,
    tag: 'tech_stack',
    defaultImportance: 0.7,
  },
  // 环境信息
  {
    pattern: /(?:环境|系统|平台|OS|environment)\s*(?:是|=|:)\s*(\S+)/i,
    tag: 'environment',
    defaultImportance: 0.6,
  },
];

// ============ 常量 ============

/** 最大条目数 */
const MAX_ENTRIES = 100;

/** 默认来源 */
const DEFAULT_SOURCE = 'unknown';

/** 默认重要性 */
const DEFAULT_IMPORTANCE = 0.5;

// ============ 主类 ============

export class Scratchpad {
  /** 事实存储 */
  private entries: Map<string, ScratchpadEntry> = new Map();

  // ========== 核心 API ==========

  /**
   * 新增或更新一条事实
   * 如果 key 已存在，更新 value 和元数据，保留原有标签（可追加）
   */
  set(key: string, value: string, options?: ScratchpadSetOptions): void {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing) {
      // 更新已有条目
      existing.value = value;
      existing.source = options?.source ?? existing.source;
      existing.importance = options?.importance ?? existing.importance;
      existing.updatedAt = now;
      if (options?.tags) {
        // 追加新标签，去重
        const tagSet = new Set([...existing.tags, ...options.tags]);
        existing.tags = Array.from(tagSet);
      }
    } else {
      // 新增条目
      const entry: ScratchpadEntry = {
        key,
        value,
        source: options?.source ?? DEFAULT_SOURCE,
        importance: options?.importance ?? DEFAULT_IMPORTANCE,
        createdAt: now,
        updatedAt: now,
        tags: options?.tags ?? [],
      };

      // 检查容量，满时淘汰最低重要性的条目
      if (this.entries.size >= MAX_ENTRIES) {
        this.evictLowestImportance();
      }

      this.entries.set(key, entry);
    }
  }

  /**
   * 获取一条事实
   */
  get(key: string): ScratchpadEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * 检查事实是否存在
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 删除一条事实
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * 获取所有事实
   */
  getAll(): ScratchpadEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * 按标签获取事实
   */
  getByTag(tag: string): ScratchpadEntry[] {
    return this.getAll().filter(entry =>
      entry.tags.some(t => t.toLowerCase() === tag.toLowerCase())
    );
  }

  /**
   * 模糊搜索：按 key/value/tags 匹配
   * 不区分大小写，支持部分匹配
   */
  search(query: string): ScratchpadEntry[] {
    const q = query.toLowerCase();
    return this.getAll().filter(entry => {
      const keyMatch = entry.key.toLowerCase().includes(q);
      const valueMatch = entry.value.toLowerCase().includes(q);
      const tagMatch = entry.tags.some(t => t.toLowerCase().includes(q));
      return keyMatch || valueMatch || tagMatch;
    });
  }

  /**
   * 格式化为文本，供 LLM 注入使用
   * 在 token 预算内，按重要性降序输出事实
   */
  formatForPrompt(maxTokens: number = 800): string {
    const all = this.getAll()
      .sort((a, b) => b.importance - a.importance);

    const lines: string[] = ['[已知事实]'];
    let usedTokens = this.estimateStringTokens('[已知事实]');

    for (const entry of all) {
      const line = `- ${entry.key}: ${entry.value}${entry.tags.length > 0 ? ` [${entry.tags.join(',')}]` : ''}`;
      const lineTokens = this.estimateStringTokens(line);

      if (usedTokens + lineTokens > maxTokens) {
        break;
      }

      lines.push(line);
      usedTokens += lineTokens;
    }

    if (lines.length <= 1) {
      return '';  // 没有事实可输出
    }

    return lines.join('\n');
  }

  /**
   * 从对话消息中自动提取事实
   * 检测中英文模式：项目工具、凭证、端点、版本、路径、配置、错误等
   */
  extractFromMessages(messages: ChatMessage[]): void {
    for (const msg of messages) {
      // 只处理用户和助手消息
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      const content = msg.content;

      for (const pattern of FACT_PATTERNS) {
        const match = content.match(pattern.pattern);
        if (!match) continue;

        // 提取关键信息作为 value
        const value = match[1] || match[0];
        // 用匹配到的完整文本的前 50 字符作为 key
        const key = this.sanitizeKey(match[0].substring(0, 50));

        // 避免重复提取相同事实
        if (this.has(key)) continue;

        this.set(key, value, {
          source: 'auto_extract',
          importance: pattern.defaultImportance,
          tags: [pattern.tag],
        });
      }
    }
  }

  /**
   * 清除过期条目
   * @param maxAge 最大存活时间（毫秒），默认 24 小时
   * @returns 清除的条目数
   */
  clearExpired(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of Array.from(this.entries)) {
      if (now - entry.updatedAt > maxAge) {
        this.entries.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * 序列化为 JSON 对象，用于检查点/持久化
   */
  toJSON(): object {
    return {
      version: 1,
      entries: this.getAll(),
    };
  }

  /**
   * 从 JSON 数据反序列化，用于恢复
   */
  fromJSON(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const obj = data as { entries?: unknown[] };
    if (!Array.isArray(obj.entries)) return;

    this.entries.clear();

    for (const entry of obj.entries) {
      if (entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string') {
        const e = entry as {
          key: string;
          value?: string;
          source?: string;
          importance?: number;
          createdAt?: number;
          updatedAt?: number;
          tags?: string[];
        };
        this.entries.set(e.key, {
          key: e.key,
          value: e.value ?? '',
          source: e.source ?? DEFAULT_SOURCE,
          importance: typeof e.importance === 'number' ? Math.max(0, Math.min(1, e.importance)) : DEFAULT_IMPORTANCE,
          createdAt: e.createdAt ?? Date.now(),
          updatedAt: e.updatedAt ?? Date.now(),
          tags: Array.isArray(e.tags) ? e.tags : [],
        });
      }
    }
  }

  /**
   * 估算当前总 token 数
   */
  estimateTokens(): number {
    let total = 0;
    for (const entry of Array.from(this.entries.values())) {
      total += this.estimateStringTokens(entry.key);
      total += this.estimateStringTokens(entry.value);
      for (const tag of entry.tags) {
        total += this.estimateStringTokens(tag);
      }
    }
    return total;
  }

  // ========== 私有方法 ==========

  /**
   * 淘汰最低重要性的条目
   * 重要性相同时，淘汰最旧的
   */
  private evictLowestImportance(): void {
    let lowestKey: string | null = null;
    let lowestImportance = Infinity;
    let oldestTime = Infinity;

    for (const [key, entry] of Array.from(this.entries)) {
      if (entry.importance < lowestImportance ||
        (entry.importance === lowestImportance && entry.updatedAt < oldestTime)) {
        lowestKey = key;
        lowestImportance = entry.importance;
        oldestTime = entry.updatedAt;
      }
    }

    if (lowestKey !== null) {
      this.entries.delete(lowestKey);
    }
  }

  /**
   * 将匹配文本转换为合法的 key
   * 去除特殊字符，用下划线连接
   */
  private sanitizeKey(raw: string): string {
    return raw
      .replace(/[^\w\u4e00-\u9fff]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 60);
  }

  /**
   * 估算字符串的 token 数
   * 中文约 1.5 字符/token，英文约 4 字符/token
   */
  private estimateStringTokens(text: string): number {
    let chineseChars = 0;
    let otherChars = 0;

    for (const char of text) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(char)) {
        chineseChars++;
      } else {
        otherChars++;
      }
    }

    // 中文约 1.5 字符/token，英文约 4 字符/token
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }
}
