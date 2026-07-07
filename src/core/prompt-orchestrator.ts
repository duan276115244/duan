/**
 * Prompt 编排器 — PromptOrchestrator
 *
 * 5 层按需注入架构，替代 monolithic buildSystemPrompt()：
 *   Layer 1 (identity)  — 始终注入，~200 tokens
 *   Layer 2 (rules)     — 意图驱动选择，~800 tokens
 *   Layer 3 (memory)    — Top-K 相关记忆，~400 tokens
 *   Layer 4 (context)   — 项目/策略/性能，~300 tokens
 *   Layer 5 (tools)     — 意图驱动工具子集，~600 tokens
 *
 * 总目标：~2300 tokens（vs 当前 ~4000+）
 */

import type { MemoryOrchestrator } from './memory-orchestrator.js';
import { getPromptCache } from './prompt-cache.js';

// ============ 类型定义 ============

export type UserIntent =
  | 'code'       // 编码/调试/重构
  | 'desktop'    // 桌面自动化/微信
  | 'web'        // 网页搜索/抓取
  | 'memory'     // 记忆管理
  | 'general';   // 通用对话

export interface PromptLayer {
  name: string;
  priority: number;        // 1-5, 越小越先注入
  tokenBudget: number;     // 该层 token 上限
  condition: (ctx: PromptContext) => boolean;  // 是否注入
  build: (ctx: PromptContext) => string;       // 构建内容
}

export interface PromptContext {
  userMessage: string;
  intent: UserIntent;
  /** MemoryOrchestrator 实例（可选） */
  memoryOrchestrator?: MemoryOrchestrator | null;
  /** 策略引擎当前策略 */
  strategyInfo?: { name: string; description: string } | null;
  /** 性能评估分数 */
  performanceScore?: number | null;
  /** 项目规则文件内容 */
  projectRules?: string | null;
  /** 自我意识状态 */
  contextData?: {
    mood?: string;
    consciousness?: string;
    focus?: number;
    energy?: number;
    curiosity?: number;
    confidence?: number;
    creativity?: number;
    evolutionLevel?: number;
    capabilities?: string;
    goals?: string;
    insights?: string;
    values?: string;
  } | null;
  /** 已打开的资源列表 */
  openResources?: string[];
  /** 本轮经验教训 */
  lessonsLearned?: string[];
  /** 学习上下文 */
  learningContext?: string;
  /** 工具描述列表（OpenAI function 格式） */
  toolDescriptions?: Array<{ name: string; description: string; category?: string }>;
  /** 最大 token 预算 */
  maxTokens?: number;
  /** 项目知识摘要 */
  projectKnowledge?: string | null;
  /** 自定义系统提示（来自外部调用方） */
  customSystemPrompt?: string;
  /** 情感识别信息 */
  emotionInfo?: {
    primary: string;
    secondary?: string | null;
    intensity: number;
    energy: string;
    styleAdvice?: string;
    userMood?: string;
  } | null;
  /** 用户偏好 persona prompt — 个性化层（沟通风格/专业水平/语言偏好等） */
  personaPrompt?: string | null;
}

// ============ 意图推断 ============

const INTENT_KEYWORDS: Record<UserIntent, string[]> = {
  code: ['代码', '函数', '类', '调试', '重构', '编译', 'bug', 'error', '修复', '实现', 'code', 'debug', 'refactor', 'function', 'class', 'build', 'test', 'git', '文件', '目录', '读写', 'shell', '命令', '脚本', '编程', '开发', '运行', '执行', '安装', 'npm', 'python', 'typescript', 'javascript', '修个', '帮我写', '生成代码'],
  desktop: ['桌面', '微信', '浏览器', '截图', '点击', '输入', '自动化', 'desktop', 'wechat', 'screenshot', 'click', 'type', '窗口', '应用', 'PS', 'Photoshop', 'PPT', 'Word', 'Excel', '打开', '关闭', '发送消息', '发微信'],
  web: ['搜索', '网页', '抓取', 'HTTP', 'API', '网络', 'search', 'web', 'fetch', 'scrape', 'url', '链接', '查一下', '帮我查', '搜一下', '上网', '浏览器', '豆包', '视频生成'],
  memory: ['记忆', '经验', '教训', '学习', 'memory', 'remember', 'forget', 'recall', '记住', '回忆', '你记得', '上次', '之前'],
  general: [],
};

export function inferIntent(message: string): UserIntent {
  const lower = message.toLowerCase();
  let bestIntent: UserIntent = 'general';
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (intent === 'general') continue;
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent as UserIntent;
    }
  }

  return bestIntent;
}

// ============ 5 层构建器 ============

/** Layer 1: 身份层 — 始终注入 */
function buildIdentityLayer(ctx: PromptContext): string {
  let identity = '你是段先生 v19.0，一个具备经验学习能力的超级智能体。';

  const cd = ctx.contextData;
  if (cd) {
    const tags: string[] = [];
    if (cd.mood) tags.push(cd.mood);
    if (cd.focus != null) tags.push(`专注${Math.round(cd.focus * 100)}%`);
    if (cd.energy != null) tags.push(`能量${Math.round(cd.energy * 100)}%`);
    if (cd.evolutionLevel) tags.push(`Lv.${cd.evolutionLevel}`);
    if (tags.length > 0) identity += ` (${tags.join(' | ')})`;
  }

  return identity;
}

/** Layer 2: 规则层 — 意图驱动选择 */
function buildRulesLayer(ctx: PromptContext): string {
  const intent = ctx.intent;
  const rules: string[] = [];

  // 通用核心原则
  rules.push(`## 核心原则
- 理解用户真实意图，不要只看字面意思
- 先理解任务，再决定是否用工具。闲聊/问候直接回复，不需要调用工具
- 按需行动：只有需要执行操作时才调用工具，简单问答直接文字回复
- 任务完成后调用 complete 工具提交结果并结束
- 工具失败时换一种方法或直接用知识回答，不要反复重试
- 用中文回复

## 【最重要】工具调用方式
你必须通过 function_call 机制调用工具，而不是在回复文本中描述工具调用。
正确方式：在回复中使用 tool_calls 字段调用工具（API会自动处理）
错误方式：在文本中写 <tool_name>参数</tool_name> 或 <｜｜DSML｜｜tool_calls> 标签
如果你不知道如何调用工具，请先调用 list_tools 查看可用工具列表。

## 工具选择决策树
遇到任务时，按以下顺序决策：
1. **闲聊/问候/简单问答？** → 直接文字回复，不调用任何工具
2. **需要读取信息？** → file_read / search_files / web_search / extract
3. **需要修改/创建？** → file_write / code_execute / shell_execute
4. **需要操作网页？** → browser_operate（goto→wait_for_change→extract→click→type→wait_for_change）
5. **需要操作桌面应用？** → desktop_open / visual_analyze / visual_find_click / screen_click / screen_type
6. **需要搜索网络？** → web_search → web_fetch（搜索失败直接用知识回答）
6. **需要执行代码？** → code_execute（简单计算）/ shell_execute（系统命令）
7. **遇到登录/验证码？** → 暂停，提示用户手动操作后继续
8. **工具连续失败？** → 换一种完全不同的方法，不要用相同策略重试

## 浏览器操作关键规则
1. 打开网页后必须先 wait_for_change 等待加载
2. 操作前先用 extract 查看页面结构，确认选择器
3. 点击用文本内容作为选择器（如 click selector="登录"），不要用CSS伪选择器
4. 每次操作后 wait_for_change 等待页面响应
5. 如果 browser_operate 失败，改用 screen_click/screen_type 桌面操控方式`);

  // 意图特定规则
  if (intent === 'code') {
    rules.push(`## 编码规则
- 修改前先读文件，修改后验证编译
- 代码执行用 code_execute，文件操作用 file_read/file_write
- 调试时先读取错误信息，再定位问题`);
  } else if (intent === 'desktop') {
    rules.push(`## 桌面规则
- 操作前检查应用状态，截图确认结果
- 微信操作: wechat_status→wechat_find_contact→wechat_send_message
- 复杂桌面任务用 app_smart 一步完成
- 视觉定位用 visual_find_click，比猜坐标更可靠`);
  } else if (intent === 'web') {
    rules.push(`## 网络规则
- 搜索失败时用知识直接回答
- 网页操作用 browser_operate，信息获取用 web_fetch
- 搜索结果要整理后再呈现给用户
- 浏览器操作最佳实践：
  1. 先 goto 打开页面，再 extract 查看内容，最后 click/type 操作
  2. click 的 selector 优先用文本内容（如"登录"），不用 CSS 选择器
  3. 不要用 evaluate 操作 DOM，用 click/type/press 等内置操作
  4. 遇到登录页面 → 先提示用户需要登录，让用户手动登录后再继续
  5. 页面操作后用 extract 确认结果，不要猜测操作是否成功`);
  } else if (intent === 'memory') {
    rules.push(`## 记忆规则
- 记忆存储用 memory_store，记忆搜索用 memory_search
- 重要信息主动存储，用户问及历史时搜索回忆`);
  }

  rules.push(`## 工具使用规则
1. 不要重复调用同一个工具超过2次
2. 工具返回✅说明成功，不要重复调用
3. 工具返回❌分析原因后换方法，不要相同参数重试
4. 完成任务后立即回复，不要做多余验证`);

  if (ctx.projectRules) {
    rules.push(`## 项目规则\n${ctx.projectRules}`);
  }

  return rules.join('\n\n');
}

/** Layer 3: 记忆层 — Top-K 相关记忆 */
async function buildMemoryLayer(ctx: PromptContext): Promise<string> {
  if (!ctx.memoryOrchestrator) return '';

  try {
    const entries = await ctx.memoryOrchestrator.search(ctx.userMessage, { topK: 5 });
    if (entries.length === 0) return '';
    return ctx.memoryOrchestrator.formatForPrompt(entries);
  } catch {
    return '';
  }
}

/** Layer 4: 上下文层 — 项目/策略/性能 */
function buildContextLayer(ctx: PromptContext): string {
  const items: string[] = [];

  if (ctx.strategyInfo) {
    items.push(`策略: ${ctx.strategyInfo.name}`);
  }

  if (ctx.performanceScore != null && ctx.performanceScore > 0) {
    items.push(`评分: ${ctx.performanceScore}/100`);
  }

  if (ctx.openResources && ctx.openResources.length > 0) {
    items.push(`已打开: ${ctx.openResources.join(', ')}`);
  }

  if (ctx.lessonsLearned && ctx.lessonsLearned.length > 0) {
    items.push(`经验:\n${ctx.lessonsLearned.map(l => `- ${l}`).join('\n')}`);
  }

  if (ctx.learningContext) {
    items.push(`学习:\n${ctx.learningContext}`);
  }

  if (ctx.projectKnowledge) {
    items.push(`项目:\n${ctx.projectKnowledge}`);
  }

  if (ctx.emotionInfo) {
    const e = ctx.emotionInfo;
    let emotionStr = `情绪: ${e.primary}`;
    if (e.secondary) emotionStr += `(略带${e.secondary})`;
    emotionStr += ` | 能量: ${e.energy} | 投入: ${Math.round(e.intensity * 100)}%`;
    if (e.styleAdvice) emotionStr += ` | 风格: ${e.styleAdvice}`;
    if (e.userMood) emotionStr += `\n用户画像: ${e.userMood}`;
    items.push(emotionStr);
  }

  return items.length > 0 ? '## 上下文\n' + items.join('\n') : '';
}

/** Layer 5: 工具层 — 意图驱动工具子集描述 */
function buildToolsLayer(ctx: PromptContext): string {
  if (!ctx.toolDescriptions || ctx.toolDescriptions.length === 0) return '';

  const intent = ctx.intent;

  const categoryPriority: Record<UserIntent, string[]> = {
    code:     ['code', 'file', 'system', 'memory'],
    desktop:  ['desktop', 'system', 'communication'],
    web:      ['web', 'data', 'system'],
    memory:   ['memory', 'system'],
    general:  ['system', 'memory', 'task'],
  };

  const priorities = categoryPriority[intent];

  const primaryTools = ctx.toolDescriptions.filter(t =>
    priorities.some(p => t.category === p)
  );
  const otherTools = ctx.toolDescriptions.filter(t =>
    !priorities.some(p => t.category === p)
  );

  let result = '## 工具\n';

  if (primaryTools.length > 0) {
    result += primaryTools.map(t => `${t.name}: ${t.description.split('。')[0].substring(0, 50)}`).join('\n');
  }

  if (otherTools.length > 0) {
    result += `\n其他: ${otherTools.map(t => t.name).join(', ')}`;
  }

  return result;
}

// ============ PromptOrchestrator ============

export class PromptOrchestrator {
  private layers: PromptLayer[];
  private memoryOrchestrator: MemoryOrchestrator | null = null;

  constructor() {
    this.layers = [
      {
        name: 'identity',
        priority: 1,
        tokenBudget: 200,
        condition: () => true,  // 始终注入
        build: (ctx) => buildIdentityLayer(ctx),
      },
      {
        name: 'persona',
        priority: 1.5,
        tokenBudget: 300,
        condition: (ctx) => !!ctx.personaPrompt,  // 有 persona 时注入
        build: (ctx) => ctx.personaPrompt!,
      },
      {
        name: 'rules',
        priority: 2,
        tokenBudget: 800,
        condition: () => true,  // 始终注入（内容按意图变化）
        build: (ctx) => buildRulesLayer(ctx),
      },
      {
        name: 'memory',
        priority: 3,
        tokenBudget: 400,
        condition: (ctx) => !!ctx.memoryOrchestrator,
        build: (_ctx) => '',  // 异步构建，在 orchestrate() 中处理
      },
      {
        name: 'context',
        priority: 4,
        tokenBudget: 300,
        condition: (ctx) =>
          !!ctx.strategyInfo ||
          (ctx.performanceScore != null && ctx.performanceScore > 0) ||
          (ctx.openResources && ctx.openResources.length > 0) ||
          (ctx.lessonsLearned && ctx.lessonsLearned.length > 0) ||
          !!ctx.learningContext ||
          !!ctx.projectKnowledge,
        build: (ctx) => buildContextLayer(ctx),
      },
      {
        name: 'tools',
        priority: 5,
        tokenBudget: 600,
        condition: (ctx) => !!(ctx.toolDescriptions && ctx.toolDescriptions.length > 0),
        build: (ctx) => buildToolsLayer(ctx),
      },
  ];
  }

  /** 注入 MemoryOrchestrator */
  setMemoryOrchestrator(mo: MemoryOrchestrator): void {
    this.memoryOrchestrator = mo;
  }

  /**
   * 编排并构建完整系统提示
   *
   * 按优先级逐层构建，每层受 tokenBudget 约束。
   * memory 层是异步的，单独处理。
   */
  async orchestrate(ctx: PromptContext): Promise<string> {
    // 注入 memoryOrchestrator
    if (this.memoryOrchestrator && !ctx.memoryOrchestrator) {
      ctx.memoryOrchestrator = this.memoryOrchestrator;
    }

    // 推断意图
    if (!ctx.intent || ctx.intent === 'general') {
      ctx.intent = inferIntent(ctx.userMessage);
    }

    const maxTokens = ctx.maxTokens || 2300;
    let usedTokens = 0;
    const parts: string[] = [];

    // P0: 使用 PromptCache 缓存 stable 层（identity + rules）— 减少首字符延迟
    const promptCache = getPromptCache();

    // 按 priority 排序
    const sorted = [...this.layers].sort((a, b) => a.priority - b.priority);

    for (const layer of sorted) {
      // 检查条件
      if (!layer.condition(ctx)) continue;

      // 检查 token 预算
      if (usedTokens >= maxTokens) break;

      let content: string;

      // P0: stable 层（identity/rules）使用缓存 — 意图不变时命中缓存
      if (layer.name === 'identity' || layer.name === 'rules') {
        const cacheKey = `${layer.name}_${ctx.intent}`;
        const cached = await promptCache.getOrBuild('stable', cacheKey, () => layer.build(ctx));
        content = cached.content;
      } else if (layer.name === 'tools') {
        // P0: tools 层使用 context 缓存（5min TTL，意图不变时命中）
        const cacheKey = `tools_${ctx.intent}`;
        const cached = await promptCache.getOrBuild('context', cacheKey, () => layer.build(ctx));
        content = cached.content;
      } else if (layer.name === 'memory') {
        // memory 层异步构建（volatile，不缓存）
        content = await buildMemoryLayer(ctx);
      } else {
        // 其他层（context 等）直接构建
        content = layer.build(ctx);
      }

      if (!content) continue;

      // 粗略 token 估算（中文约 1.5 字/token，英文约 4 字符/token）
      const estimatedTokens = Math.ceil(content.length / 2.5);

      // 如果超出预算，截断
      if (usedTokens + estimatedTokens > maxTokens) {
        const remaining = maxTokens - usedTokens;
        const maxChars = remaining * 2.5;
        content = content.substring(0, Math.floor(maxChars));
      }

      parts.push(content);
      usedTokens += estimatedTokens;
    }

    return parts.join('\n\n');
  }

  /**
   * 快速构建（同步，不含 memory 层）
   * 用于不需要记忆检索的简单场景
   */
  buildSync(ctx: PromptContext): string {
    if (!ctx.intent || ctx.intent === 'general') {
      ctx.intent = inferIntent(ctx.userMessage);
    }

    const parts: string[] = [];

    for (const layer of this.layers) {
      if (layer.name === 'memory') continue;  // 跳过异步层
      if (!layer.condition(ctx)) continue;
      const content = layer.build(ctx);
      if (content) parts.push(content);
    }

    return parts.join('\n\n');
  }
}
