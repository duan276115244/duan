/**
 * 智能决策引擎 — IntelligentDecisionEngine
 *
 * 核心能力：将用户意图映射到最优工具链，实现智能任务决策与执行。
 * 当用户说"帮我用PS给图片加个红色边框"时，引擎需要：
 * 1. 理解意图（Photoshop图片编辑）
 * 2. 选择工具链（app_launch photoshop → app_workflow add_border → ...）
 * 3. 执行正确序列
 * 4. 处理失败并自适应
 *
 * 设计原则：
 * - 意图 → 工具链映射：基于模式匹配 + 上下文评分
 * - 模板变量提取：从自然语言中提取结构化参数
 * - 学习系统：从成功/失败中学习，动态调整置信度
 * - 持久化：映射、历史、学习模式均落盘
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 接口定义 ============

export interface ToolChainStep {
  tool: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  waitFor?: number;
  verify?: string;
  onFailure?: 'retry' | 'skip' | 'abort' | 'ask_user' | 'try_alternative';
  maxRetries?: number;
  description: string;
}

export interface FailureHandler {
  condition: string;
  action: 'retry_with_adjustment' | 'try_alternative_chain' | 'ask_user' | 'skip_step' | 'rollback';
  details: string;
}

export interface IntentMapping {
  id: string;
  intentPattern: RegExp | string;
  domain: string;
  subDomain?: string;
  requiredTools: string[];
  toolChain: ToolChainStep[];
  alternativeChains?: ToolChainStep[][];
  prerequisites?: string[];
  successIndicators?: string[];
  failureHandlers?: FailureHandler[];
  confidence: number;
  examples: string[];
}

export interface DecisionResult {
  intent: string;
  domain: string;
  subDomain?: string;
  confidence: number;
  selectedChain: ToolChainStep[];
  chainIndex: number;
  estimatedSteps: number;
  requiredApps: string[];
  warnings: string[];
}

export interface ExecutionTrace {
  stepIndex: number;
  tool: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  result: string;
  success: boolean;
  duration: number;
  timestamp: number;
}

interface IntentStats {
  totalAnalyses: number;
  successfulMatches: number;
  failedMatches: number;
  averageConfidence: number;
  domainDistribution: Record<string, number>;
  topIntents: Array<{ intentId: string; count: number; successRate: number }>;
}

interface LearnedPattern {
  id: string;
  userInputPattern: string;
  toolSequence: string[];
  successCount: number;
  failureCount: number;
  lastUsed: number;
  proposedMapping?: Partial<IntentMapping>;
}

interface _PersistedData {
  mappings: IntentMapping[];
  history: Array<{
    userInput: string;
    intentId: string;
    chainIndex: number;
    success: boolean;
    timestamp: number;
  }>;
  learned: LearnedPattern[];
}

// ============ 中文模板变量提取模式 ============

const TEMPLATE_PATTERNS: Array<{
  pattern: RegExp;
  extractors: Record<string, (match: RegExpMatchArray) => string>;
}> = [
  {
    pattern: /给(.+?)发(.+?)说(.+)/,
    extractors: { target: (m) => m[1], medium: (m) => m[2], content: (m) => m[3] },
  },
  {
    pattern: /给(.+?)发(.+)/,
    extractors: { target: (m) => m[1], content: (m) => m[2] },
  },
  {
    pattern: /用(.+?)做(.+)/,
    extractors: { tool: (m) => m[1], task: (m) => m[2] },
  },
  {
    pattern: /用(.+?)打开(.+)/,
    extractors: { tool: (m) => m[1], target: (m) => m[2] },
  },
  {
    pattern: /用(.+?)编辑(.+)/,
    extractors: { tool: (m) => m[1], target: (m) => m[2] },
  },
  {
    pattern: /用(.+?)给(.+?)加(.+)/,
    extractors: { tool: (m) => m[1], target: (m) => m[2], addition: (m) => m[3] },
  },
  {
    pattern: /打开(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /在(.+?)里(.+)/,
    extractors: { app: (m) => m[1], action: (m) => m[2] },
  },
  {
    pattern: /搜索(.+)/,
    extractors: { query: (m) => m[1] },
  },
  {
    pattern: /写一个(.+)/,
    extractors: { subject: (m) => m[1] },
  },
  {
    pattern: /写一个关于(.+?)的(.+)/,
    extractors: { topic: (m) => m[1], type: (m) => m[2] },
  },
  {
    pattern: /做个关于(.+?)的(.+)/,
    extractors: { topic: (m) => m[1], type: (m) => m[2] },
  },
  {
    pattern: /做个(.+)/,
    extractors: { subject: (m) => m[1] },
  },
  {
    pattern: /修复(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /重构(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /分析(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /生成(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /下载(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /读取(.+)/,
    extractors: { target: (m) => m[1] },
  },
  {
    pattern: /编辑(.+)/,
    extractors: { target: (m) => m[1] },
  },
];

/** 中文磁盘路径转换：D盘的photo.jpg → D:\photo.jpg */
function normalizeChinesePath(raw: string): string {
  return raw
    .replace(/([A-Za-z])盘的?/g, '$1:\\')
    .replace(/的/g, '\\')
    .replace(/\\\\/g, '\\')
    .replace(/\\+/g, '\\');
}

/** 应用名到标准化名称的映射 */
const APP_ALIASES: Record<string, string> = {
  'PS': 'photoshop',
  'Photoshop': 'photoshop',
  'ps': 'photoshop',
  'PPT': 'powerpoint',
  'ppt': 'powerpoint',
  'PowerPoint': 'powerpoint',
  'Word': 'word',
  'word': 'word',
  'Excel': 'excel',
  'excel': 'excel',
  'VSCode': 'vscode',
  'vscode': 'vscode',
  'VS Code': 'vscode',
  'Chrome': 'chrome',
  'chrome': 'chrome',
  '浏览器': 'chrome',
  '微信': 'wechat',
  '邮箱': 'email',
  '邮件': 'email',
};

// ============ 内置意图映射 ============

function buildBuiltinMappings(): IntentMapping[] {
  return [
    // ---- Desktop Automation ----
    {
      id: 'wechat_send_message',
      intentPattern: /给.+发微信|微信发消息|发微信给|打开微信.*发/,
      domain: 'desktop_automation',
      subDomain: 'wechat',
      requiredTools: ['app_launch', 'wechat_find_contact', 'wechat_send_message'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'wechat' }, description: '打开微信', waitFor: 2000, verify: '微信窗口已出现', onFailure: 'retry', maxRetries: 2 },
        { tool: 'wechat_find_contact', args: { name: '{{target}}' }, description: '查找联系人', waitFor: 1000, verify: '联系人已找到', onFailure: 'ask_user' },
        { tool: 'wechat_send_message', args: { contact: '{{target}}', message: '{{content}}' }, description: '发送消息', verify: '消息已发送', onFailure: 'retry' },
      ],
      alternativeChains: [
        [
          { tool: 'desktop_click', args: { position: 'wechat_icon' }, description: '点击微信图标', waitFor: 2000 },
          { tool: 'desktop_type', args: { text: '{{target}}', target: 'search_box' }, description: '搜索联系人', waitFor: 1000 },
          { tool: 'desktop_click', args: { position: 'contact_result' }, description: '点击联系人', waitFor: 500 },
          { tool: 'desktop_type', args: { text: '{{content}}', target: 'message_input' }, description: '输入消息' },
          { tool: 'desktop_key', args: { key: 'Enter' }, description: '发送消息' },
        ],
      ],
      successIndicators: ['消息已发送', '聊天窗口显示新消息'],
      failureHandlers: [
        { condition: '联系人未找到', action: 'ask_user', details: '请确认联系人名称' },
        { condition: '微信未启动', action: 'retry_with_adjustment', details: '重新启动微信' },
      ],
      confidence: 0.9,
      examples: ['给张三发微信说明天开会', '打开微信给李四发消息', '微信发消息给王五说你好'],
    },
    {
      id: 'ps_edit_image',
      intentPattern: /用PS编辑图片|PS打开.*图片|Photoshop.*编辑|用PS打开/,
      domain: 'desktop_automation',
      subDomain: 'photoshop',
      requiredTools: ['app_launch', 'app_shortcut', 'desktop_type'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动Photoshop', waitFor: 5000, verify: 'PS窗口已出现', onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+O' }, description: '打开文件对话框', waitFor: 500 },
        { tool: 'desktop_type', args: { text: '{{filePath}}' }, description: '输入文件路径' },
        { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Enter' }, description: '确认打开', waitFor: 2000, verify: '图片已在PS中打开' },
      ],
      confidence: 0.85,
      examples: ['用PS编辑图片', '用PS打开D盘的photo.jpg', 'Photoshop打开那张图片'],
    },
    {
      id: 'ps_add_text',
      intentPattern: /用PS.*加文字|PS.*添加文字|Photoshop.*文字/,
      domain: 'desktop_automation',
      subDomain: 'photoshop',
      requiredTools: ['app_launch', 'app_workflow'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动Photoshop', waitFor: 5000, onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_workflow', args: { app: 'photoshop', workflow: 'add_text', text: '{{text}}' }, description: '添加文字', waitFor: 1000, verify: '文字已添加', onFailure: 'try_alternative' },
      ],
      alternativeChains: [
        [
          { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动Photoshop', waitFor: 5000 },
          { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'T' }, description: '选择文字工具', waitFor: 300 },
          { tool: 'desktop_click', args: { position: 'canvas_center' }, description: '点击画布' },
          { tool: 'desktop_type', args: { text: '{{text}}' }, description: '输入文字' },
          { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+Enter' }, description: '确认文字' },
        ],
      ],
      confidence: 0.8,
      examples: ['用PS给图片加文字', 'PS添加文字水印', 'Photoshop加标题文字'],
    },
    {
      id: 'ps_adjust_color',
      intentPattern: /PS.*调整颜色|PS.*调色|Photoshop.*色彩|PS.*亮度|PS.*对比度|PS.*饱和度/,
      domain: 'desktop_automation',
      subDomain: 'photoshop',
      requiredTools: ['app_launch', 'app_shortcut'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动Photoshop', waitFor: 5000, onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+L' }, description: '打开色阶调整', waitFor: 500, onFailure: 'skip' },
        { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+B' }, description: '打开色彩平衡', waitFor: 500, onFailure: 'skip' },
        { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+U' }, description: '打开色相/饱和度', waitFor: 500, onFailure: 'skip' },
      ],
      confidence: 0.8,
      examples: ['用PS调整颜色', 'PS调色', 'Photoshop调整亮度', 'PS修改饱和度'],
    },
    {
      id: 'ps_export_image',
      intentPattern: /PS.*导出|PS.*保存|Photoshop.*导出|PS.*另存/,
      domain: 'desktop_automation',
      subDomain: 'photoshop',
      requiredTools: ['app_launch', 'app_workflow'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'photoshop' }, description: '确认Photoshop已启动', waitFor: 1000 },
        { tool: 'app_workflow', args: { app: 'photoshop', workflow: 'export_png' }, description: '导出为PNG', waitFor: 1000, verify: '文件已导出', onFailure: 'try_alternative' },
      ],
      alternativeChains: [
        [
          { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+Shift+S' }, description: '另存为', waitFor: 500 },
          { tool: 'desktop_type', args: { text: '{{fileName}}' }, description: '输入文件名' },
          { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Enter' }, description: '确认保存' },
        ],
      ],
      confidence: 0.85,
      examples: ['用PS导出图片', 'PS保存为PNG', 'Photoshop另存为'],
    },
    {
      id: 'ppt_create',
      intentPattern: /做个PPT|创建PPT|新建PPT|做PPT|制作PPT/,
      domain: 'desktop_automation',
      subDomain: 'ppt',
      requiredTools: ['app_launch', 'app_workflow'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'powerpoint' }, description: '启动PowerPoint', waitFor: 5000, verify: 'PPT已启动', onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_workflow', args: { app: 'powerpoint', workflow: 'new_presentation', topic: '{{topic}}' }, description: '创建新演示文稿', waitFor: 2000, verify: '演示文稿已创建' },
      ],
      confidence: 0.85,
      examples: ['做个PPT', '创建一个PPT', '做个关于AI的PPT', '制作演示文稿'],
    },
    {
      id: 'ppt_add_slide',
      intentPattern: /PPT.*添加幻灯片|PPT.*新增幻灯片|PPT.*加一页/,
      domain: 'desktop_automation',
      subDomain: 'ppt',
      requiredTools: ['app_shortcut'],
      toolChain: [
        { tool: 'app_shortcut', args: { app: 'powerpoint', keys: 'Ctrl+M' }, description: '添加新幻灯片', waitFor: 500, verify: '新幻灯片已添加' },
      ],
      confidence: 0.9,
      examples: ['PPT添加幻灯片', 'PPT新增一页', '加一张幻灯片'],
    },
    {
      id: 'ppt_insert_image',
      intentPattern: /PPT.*插入图片|PPT.*添加图片|幻灯片.*图片/,
      domain: 'desktop_automation',
      subDomain: 'ppt',
      requiredTools: ['app_workflow'],
      toolChain: [
        { tool: 'app_workflow', args: { app: 'powerpoint', workflow: 'insert_image', imagePath: '{{imagePath}}' }, description: '插入图片', waitFor: 1000, verify: '图片已插入', onFailure: 'ask_user' },
      ],
      confidence: 0.8,
      examples: ['PPT插入图片', '幻灯片添加图片', 'PPT里放张图片'],
    },
    {
      id: 'ppt_add_animation',
      intentPattern: /PPT.*动画|PPT.*添加动画|幻灯片.*动画/,
      domain: 'desktop_automation',
      subDomain: 'ppt',
      requiredTools: ['app_workflow'],
      toolChain: [
        { tool: 'app_workflow', args: { app: 'powerpoint', workflow: 'add_animation', type: '{{animationType}}' }, description: '添加动画效果', waitFor: 500, verify: '动画已添加', onFailure: 'try_alternative' },
      ],
      confidence: 0.75,
      examples: ['PPT添加动画', '给幻灯片加动画', 'PPT动画效果'],
    },
    {
      id: 'ppt_export_pdf',
      intentPattern: /PPT.*导出PDF|PPT.*转PDF|PPT.*保存PDF/,
      domain: 'desktop_automation',
      subDomain: 'ppt',
      requiredTools: ['app_workflow'],
      toolChain: [
        { tool: 'app_workflow', args: { app: 'powerpoint', workflow: 'export_pdf' }, description: '导出为PDF', waitFor: 3000, verify: 'PDF已导出', onFailure: 'retry' },
      ],
      alternativeChains: [
        [
          { tool: 'app_shortcut', args: { app: 'powerpoint', keys: 'Ctrl+P' }, description: '打开打印/导出', waitFor: 500 },
          { tool: 'desktop_click', args: { position: 'save_as_pdf' }, description: '选择保存为PDF' },
          { tool: 'app_shortcut', args: { app: 'powerpoint', keys: 'Enter' }, description: '确认导出' },
        ],
      ],
      confidence: 0.85,
      examples: ['PPT导出PDF', 'PPT转PDF', '演示文稿保存为PDF'],
    },
    {
      id: 'vscode_write_code',
      intentPattern: /用VSCode写代码|VSCode.*编码|打开VSCode.*代码/,
      domain: 'desktop_automation',
      subDomain: 'code_edit',
      requiredTools: ['app_launch', 'app_workflow'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'vscode' }, description: '启动VSCode', waitFor: 3000, verify: 'VSCode已启动', onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_workflow', args: { app: 'vscode', workflow: 'new_file' }, description: '新建文件', waitFor: 500 },
      ],
      confidence: 0.85,
      examples: ['用VSCode写代码', '打开VSCode', 'VSCode编码'],
    },
    {
      id: 'vscode_run_code',
      intentPattern: /运行代码|VSCode.*运行|执行代码/,
      domain: 'desktop_automation',
      subDomain: 'code_edit',
      requiredTools: ['app_workflow'],
      toolChain: [
        { tool: 'app_workflow', args: { app: 'vscode', workflow: 'run_terminal_command', command: '{{command}}' }, description: '在终端运行命令', waitFor: 1000, verify: '命令已执行', onFailure: 'ask_user' },
      ],
      confidence: 0.8,
      examples: ['运行代码', 'VSCode运行程序', '执行代码'],
    },
    {
      id: 'browser_search',
      intentPattern: /打开浏览器.*搜索|浏览器.*搜索|打开.*搜索/,
      domain: 'desktop_automation',
      subDomain: 'web_browse',
      requiredTools: ['app_launch', 'app_workflow', 'desktop_type'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'chrome' }, description: '打开浏览器', waitFor: 3000, verify: '浏览器已打开', onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_workflow', args: { app: 'chrome', workflow: 'open_url', url: 'https://www.google.com' }, description: '打开搜索引擎', waitFor: 2000 },
        { tool: 'desktop_type', args: { text: '{{query}}', target: 'search_box' }, description: '输入搜索内容' },
        { tool: 'app_shortcut', args: { app: 'chrome', keys: 'Enter' }, description: '执行搜索', waitFor: 2000, verify: '搜索结果已显示' },
      ],
      confidence: 0.85,
      examples: ['打开浏览器搜索AI', '浏览器搜索天气', '打开Chrome搜索新闻'],
    },
    // ---- Code Domain ----
    {
      id: 'code_write_function',
      intentPattern: /写一个.*函数|编写.*函数|实现.*函数|写.*代码/,
      domain: 'code',
      subDomain: 'code_edit',
      requiredTools: ['code_write'],
      toolChain: [
        { tool: 'code_write', args: { description: '{{subject}}', language: '{{language}}' }, description: '编写代码', verify: '代码已生成', onFailure: 'retry' },
      ],
      confidence: 0.9,
      examples: ['写一个排序函数', '编写一个HTTP请求函数', '实现二分查找代码'],
    },
    {
      id: 'code_fix_bug',
      intentPattern: /修复.*bug|修.*bug|修复.*错误|解决.*bug|debug/,
      domain: 'code',
      subDomain: 'debugging',
      requiredTools: ['code_analyze', 'code_fix'],
      toolChain: [
        { tool: 'code_analyze', args: { target: '{{target}}', mode: 'bug_detection' }, description: '分析代码问题', waitFor: 1000, verify: '问题已定位', onFailure: 'ask_user' },
        { tool: 'code_fix', args: { target: '{{target}}', fix: 'auto' }, description: '修复代码', verify: '代码已修复', onFailure: 'ask_user' },
      ],
      confidence: 0.8,
      examples: ['修复这个bug', '修一下这个错误', 'debug这段代码'],
    },
    {
      id: 'code_refactor',
      intentPattern: /重构.*代码|代码.*重构|优化.*代码|改进.*代码/,
      domain: 'code',
      subDomain: 'refactoring',
      requiredTools: ['code_analyze', 'code_refactor'],
      toolChain: [
        { tool: 'code_analyze', args: { target: '{{target}}', mode: 'refactor_suggestions' }, description: '分析重构点', waitFor: 1000, verify: '重构建议已生成', onFailure: 'ask_user' },
        { tool: 'code_refactor', args: { target: '{{target}}' }, description: '执行重构', verify: '代码已重构', onFailure: 'ask_user' },
      ],
      confidence: 0.75,
      examples: ['重构这段代码', '代码重构', '优化代码结构'],
    },
    {
      id: 'code_review',
      intentPattern: /代码审查|review.*代码|代码评审|检查代码/,
      domain: 'code',
      subDomain: 'review',
      requiredTools: ['code_review'],
      toolChain: [
        { tool: 'code_review', args: { target: '{{target}}' }, description: '代码审查', verify: '审查完成', onFailure: 'retry' },
      ],
      confidence: 0.85,
      examples: ['代码审查', 'review这段代码', '帮我检查代码'],
    },
    // ---- Web Domain ----
    {
      id: 'web_search',
      intentPattern: /搜索|search|查一下|查一下.*信息|搜索一下/,
      domain: 'web',
      subDomain: 'search',
      requiredTools: ['web_search'],
      toolChain: [
        { tool: 'web_search', args: { query: '{{query}}' }, description: '搜索信息', verify: '搜索结果已返回', onFailure: 'retry' },
      ],
      confidence: 0.9,
      examples: ['搜索AI最新进展', '查一下天气预报', 'search TypeScript best practices'],
    },
    {
      id: 'web_summarize',
      intentPattern: /总结.*网页|摘要.*网页|概括.*网页|总结.*文章/,
      domain: 'web',
      subDomain: 'summarize',
      requiredTools: ['web_fetch', 'summarize'],
      toolChain: [
        { tool: 'web_fetch', args: { url: '{{url}}' }, description: '获取网页内容', verify: '内容已获取', onFailure: 'retry', maxRetries: 2 },
        { tool: 'summarize', args: { content: '{{fetchedContent}}' }, description: '总结内容', verify: '总结已生成' },
      ],
      confidence: 0.85,
      examples: ['总结这个网页', '概括这篇文章', '帮我摘要这个链接'],
    },
    {
      id: 'web_download',
      intentPattern: /下载.*文件|下载|download/,
      domain: 'web',
      subDomain: 'download',
      requiredTools: ['web_download'],
      toolChain: [
        { tool: 'web_download', args: { url: '{{url}}', destination: '{{destination}}' }, description: '下载文件', verify: '文件已下载', onFailure: 'retry', maxRetries: 3 },
      ],
      confidence: 0.85,
      examples: ['下载这个文件', 'download this', '下载PDF'],
    },
    // ---- File Domain ----
    {
      id: 'file_read',
      intentPattern: /读取.*文件|查看.*文件|打开.*文件|读一下.*文件/,
      domain: 'file',
      subDomain: 'read',
      requiredTools: ['file_read'],
      toolChain: [
        { tool: 'file_read', args: { path: '{{filePath}}' }, description: '读取文件', verify: '文件已读取', onFailure: 'ask_user' },
      ],
      confidence: 0.9,
      examples: ['读取config.json', '查看这个文件', '打开main.ts'],
    },
    {
      id: 'file_edit',
      intentPattern: /编辑.*文件|修改.*文件|改一下.*文件/,
      domain: 'file',
      subDomain: 'edit',
      requiredTools: ['file_read', 'file_edit'],
      toolChain: [
        { tool: 'file_read', args: { path: '{{filePath}}' }, description: '先读取文件内容', verify: '文件已读取', onFailure: 'ask_user' },
        { tool: 'file_edit', args: { path: '{{filePath}}', changes: '{{changes}}' }, description: '编辑文件', verify: '文件已修改', onFailure: 'ask_user' },
      ],
      confidence: 0.85,
      examples: ['编辑main.ts', '修改配置文件', '改一下index.html'],
    },
    {
      id: 'file_create_project',
      intentPattern: /创建.*项目|新建.*项目|初始化.*项目|搭建.*项目/,
      domain: 'file',
      subDomain: 'create',
      requiredTools: ['file_create'],
      toolChain: [
        { tool: 'file_create', args: { projectName: '{{projectName}}', template: '{{template}}' }, description: '创建项目结构', verify: '项目已创建', onFailure: 'ask_user' },
      ],
      confidence: 0.8,
      examples: ['创建一个React项目', '新建Node.js项目', '初始化项目'],
    },
    // ---- Communication Domain ----
    {
      id: 'email_send',
      intentPattern: /发邮件|发送邮件|email.*给|邮件.*发送/,
      domain: 'communication',
      subDomain: 'email',
      requiredTools: ['email_send'],
      toolChain: [
        { tool: 'email_send', args: { to: '{{target}}', subject: '{{subject}}', body: '{{content}}' }, description: '发送邮件', verify: '邮件已发送', onFailure: 'retry' },
      ],
      confidence: 0.7,
      examples: ['发邮件给张三', '发送邮件说明天开会', 'email给老板'],
    },
    {
      id: 'wechat_send',
      intentPattern: /发微信|微信.*发|微信.*消息/,
      domain: 'communication',
      subDomain: 'wechat',
      requiredTools: ['wechat_send_message'],
      toolChain: [
        { tool: 'wechat_send_message', args: { contact: '{{target}}', message: '{{content}}' }, description: '发送微信消息', verify: '消息已发送', onFailure: 'retry' },
      ],
      confidence: 0.85,
      examples: ['发微信给李四', '微信发消息', '给张三发微信'],
    },
    // ---- Creative Domain ----
    {
      id: 'image_generate',
      intentPattern: /生成.*图片|AI.*画|画.*图|生成.*图像|create.*image/,
      domain: 'creative',
      subDomain: 'image_generation',
      requiredTools: ['image_generate'],
      toolChain: [
        { tool: 'image_generate', args: { prompt: '{{prompt}}', style: '{{style}}' }, description: '生成图片', waitFor: 10000, verify: '图片已生成', onFailure: 'retry', maxRetries: 2 },
      ],
      confidence: 0.85,
      examples: ['生成一张猫咪的图片', 'AI画一幅风景', '画个logo'],
    },
    {
      id: 'poster_design',
      intentPattern: /设计.*海报|做.*海报|制作.*海报|海报.*设计/,
      domain: 'creative',
      subDomain: 'design',
      requiredTools: ['image_generate', 'app_launch'],
      toolChain: [
        { tool: 'image_generate', args: { prompt: '{{topic}} 海报设计', style: 'poster' }, description: '生成海报素材', waitFor: 10000, verify: '素材已生成', onFailure: 'retry' },
        { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动PS进行精修', waitFor: 5000, onFailure: 'skip' },
      ],
      alternativeChains: [
        [
          { tool: 'image_generate', args: { prompt: '{{topic}} 海报设计 高质量', style: 'poster_professional' }, description: '直接生成高质量海报', waitFor: 15000 },
        ],
      ],
      confidence: 0.75,
      examples: ['设计一个活动海报', '做个宣传海报', '制作产品海报'],
    },
    {
      id: 'video_generate',
      intentPattern: /制作.*视频|生成.*视频|创建.*视频|video.*generate/,
      domain: 'creative',
      subDomain: 'video_generation',
      requiredTools: ['video_generate'],
      toolChain: [
        { tool: 'video_generate', args: { prompt: '{{prompt}}', duration: '{{duration}}' }, description: '生成视频', waitFor: 30000, verify: '视频已生成', onFailure: 'retry', maxRetries: 1 },
      ],
      confidence: 0.7,
      examples: ['制作一个宣传视频', '生成短视频', '创建产品介绍视频'],
    },
    // ---- Data Domain ----
    {
      id: 'data_analyze',
      intentPattern: /分析.*数据|数据.*分析|统计.*分析/,
      domain: 'data',
      subDomain: 'analysis',
      requiredTools: ['analyze_data'],
      toolChain: [
        { tool: 'analyze_data', args: { source: '{{dataSource}}', type: '{{analysisType}}' }, description: '分析数据', waitFor: 5000, verify: '分析完成', onFailure: 'ask_user' },
      ],
      confidence: 0.8,
      examples: ['分析销售数据', '数据分析', '统计分析报表'],
    },
    {
      id: 'chart_generate',
      intentPattern: /生成.*图表|画.*图表|制作.*图表|可视化/,
      domain: 'data',
      subDomain: 'visualization',
      requiredTools: ['analyze_data', 'image_generate'],
      toolChain: [
        { tool: 'analyze_data', args: { source: '{{dataSource}}', type: 'chart_data' }, description: '准备图表数据', verify: '数据已准备', onFailure: 'ask_user' },
        { tool: 'image_generate', args: { prompt: '{{chartType}} chart visualization', style: 'data_viz' }, description: '生成图表', waitFor: 5000, verify: '图表已生成', onFailure: 'retry' },
      ],
      confidence: 0.75,
      examples: ['生成销售图表', '画个饼图', '制作数据可视化'],
    },
    // ---- Additional Mappings ----
    {
      id: 'ps_add_border',
      intentPattern: /PS.*加.*边框|PS.*添加.*边框|Photoshop.*边框|PS.*描边/,
      domain: 'desktop_automation',
      subDomain: 'photoshop',
      requiredTools: ['app_launch', 'app_workflow'],
      toolChain: [
        { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动Photoshop', waitFor: 5000, onFailure: 'retry', maxRetries: 2 },
        { tool: 'app_workflow', args: { app: 'photoshop', workflow: 'add_border', color: '{{borderColor}}', width: '{{borderWidth}}' }, description: '添加边框', waitFor: 1000, verify: '边框已添加', onFailure: 'try_alternative' },
      ],
      alternativeChains: [
        [
          { tool: 'app_launch', args: { app: 'photoshop' }, description: '启动Photoshop', waitFor: 5000 },
          { tool: 'app_shortcut', args: { app: 'photoshop', keys: 'Ctrl+A' }, description: '全选', waitFor: 300 },
          { tool: 'app_workflow', args: { app: 'photoshop', workflow: 'stroke_selection', color: '{{borderColor}}' }, description: '描边选区' },
        ],
      ],
      confidence: 0.8,
      examples: ['用PS给图片加个红色边框', 'PS添加边框', 'Photoshop描边'],
    },
    {
      id: 'system_info',
      intentPattern: /系统信息|查看系统|系统状态|电脑信息|系统诊断/,
      domain: 'system',
      subDomain: 'info',
      requiredTools: ['system_info'],
      toolChain: [
        { tool: 'system_info', args: { type: '{{infoType}}' }, description: '获取系统信息', verify: '信息已获取', onFailure: 'retry' },
      ],
      confidence: 0.9,
      examples: ['查看系统信息', '系统状态', '电脑配置'],
    },
    {
      id: 'screenshot_capture',
      intentPattern: /截图|截屏|屏幕截图|截取屏幕/,
      domain: 'desktop_automation',
      subDomain: 'screenshot',
      requiredTools: ['desktop_screenshot'],
      toolChain: [
        { tool: 'desktop_screenshot', args: { region: '{{region}}' }, description: '截取屏幕', waitFor: 500, verify: '截图已保存', onFailure: 'retry' },
      ],
      confidence: 0.9,
      examples: ['截图', '截屏', '屏幕截图'],
    },
    {
      id: 'file_organize',
      intentPattern: /整理.*文件|文件.*整理|归档.*文件|清理.*文件/,
      domain: 'file',
      subDomain: 'organize',
      requiredTools: ['file_read', 'file_move'],
      toolChain: [
        { tool: 'file_read', args: { path: '{{directory}}', mode: 'list' }, description: '列出文件', verify: '文件列表已获取', onFailure: 'ask_user' },
        { tool: 'file_move', args: { source: '{{directory}}', strategy: 'organize_by_type' }, description: '按类型整理文件', verify: '文件已整理', onFailure: 'ask_user' },
      ],
      confidence: 0.7,
      examples: ['整理下载文件夹', '文件归档', '清理桌面文件'],
    },
    {
      id: 'translate_text',
      intentPattern: /翻译|translate|译成|翻成/,
      domain: 'communication',
      subDomain: 'translation',
      requiredTools: ['translate'],
      toolChain: [
        { tool: 'translate', args: { text: '{{text}}', from: '{{sourceLang}}', to: '{{targetLang}}' }, description: '翻译文本', verify: '翻译完成', onFailure: 'retry' },
      ],
      confidence: 0.9,
      examples: ['翻译这段话', 'translate to English', '翻成中文'],
    },
  ];
}

// ============ 智能决策引擎主类 ============

export class IntelligentDecisionEngine {
  private mappings: Map<string, IntentMapping> = new Map();
  private executionHistory: Array<{
    userInput: string;
    intentId: string;
    chainIndex: number;
    success: boolean;
    timestamp: number;
  }> = [];
  private learnedPatterns: Map<string, LearnedPattern> = new Map();
  private log = logger.child({ module: 'IntelligentDecisionEngine' });
  private eventBus: EventBus;
  private dataDir: string;

  // 统计
  private totalAnalyses = 0;
  private successfulMatches = 0;
  private failedMatches = 0;
  private confidenceSum = 0;
  private domainCounts: Record<string, number> = {};
  private intentCounts: Record<string, { count: number; successes: number }> = {};

  constructor(baseDir?: string) {
    this.eventBus = EventBus.getInstance();
    this.dataDir = baseDir ? path.join(baseDir, '.duan', 'decision') : duanPath('decision');

    // 注册内置映射
    const builtins = buildBuiltinMappings();
    for (const mapping of builtins) {
      this.mappings.set(mapping.id, mapping);
    }

    // 从磁盘加载持久化数据
    this.loadFromDisk();

    this.log.info('IntelligentDecisionEngine initialized', {
      mappingCount: this.mappings.size,
      dataDir: this.dataDir,
    });
  }

  // ============ 核心方法 ============

  /**
   * 分析用户输入，返回决策结果
   */
  analyzeIntent(
    userInput: string,
    context?: { recentTools?: string[]; activeApps?: string[] }
  ): DecisionResult {
    this.totalAnalyses++;
    const startTime = Date.now();

    this.log.debug('Analyzing intent', { userInput: userInput.slice(0, 100) });

    // 1. 对所有映射评分
    const scored: Array<{ mapping: IntentMapping; score: number; extractedVars: Record<string, string> }> = [];

    for (const mapping of this.mappings.values()) {
      const { score, extractedVars } = this.scoreMapping(userInput, mapping, context);
      if (score > 0) {
        scored.push({ mapping, score, extractedVars });
      }
    }

    // 2. 按分数排序
    scored.sort((a, b) => b.score - a.score);

    // 3. 取最佳匹配
    if (scored.length === 0) {
      this.failedMatches++;
      this.log.warn('No intent mapping found', { userInput: userInput.slice(0, 100) });

      this.eventBus.emitSync('intent.ambiguous', {
        userInput,
        reason: 'no_matching_mapping',
      });

      return {
        intent: 'unknown',
        domain: 'unknown',
        confidence: 0,
        selectedChain: [],
        chainIndex: -1,
        estimatedSteps: 0,
        requiredApps: [],
        warnings: ['无法识别用户意图，请提供更详细的描述'],
      };
    }

    const best = scored[0];
    const mapping = best.mapping;
    const extractedVars = best.extractedVars;

    // 4. 填充模板变量到工具链
    const filledChain = this.fillTemplateVariables(mapping.toolChain, extractedVars);

    // 5. 确定所需应用
    const requiredApps = this.extractRequiredApps(mapping);

    // 6. 生成警告
    const warnings = this.generateWarnings(mapping, context);

    this.successfulMatches++;
    this.confidenceSum += mapping.confidence;
    this.domainCounts[mapping.domain] = (this.domainCounts[mapping.domain] || 0) + 1;

    if (!this.intentCounts[mapping.id]) {
      this.intentCounts[mapping.id] = { count: 0, successes: 0 };
    }
    this.intentCounts[mapping.id].count++;

    const result: DecisionResult = {
      intent: mapping.id,
      domain: mapping.domain,
      subDomain: mapping.subDomain,
      confidence: mapping.confidence,
      selectedChain: filledChain,
      chainIndex: 0,
      estimatedSteps: filledChain.length,
      requiredApps,
      warnings,
    };

    this.eventBus.emitSync('intent.detected', {
      userInput,
      intentId: mapping.id,
      domain: mapping.domain,
      confidence: mapping.confidence,
      score: best.score,
    });

    const duration = Date.now() - startTime;
    this.log.info('Intent analyzed', {
      intent: mapping.id,
      domain: mapping.domain,
      confidence: mapping.confidence,
      steps: filledChain.length,
      durationMs: duration,
    });

    return result;
  }

  /**
   * 获取工具链
   */
  getToolChain(decision: DecisionResult): ToolChainStep[] {
    return decision.selectedChain;
  }

  /**
   * 记录执行结果
   */
  recordExecution(trace: ExecutionTrace): void {
    this.log.debug('Execution recorded', {
      tool: trace.tool,
      success: trace.success,
      duration: trace.duration,
    });

    this.eventBus.emitSync('decision.execution', {
      tool: trace.tool,
      success: trace.success,
      duration: trace.duration,
    });
  }

  /**
   * 从成功执行中学习
   */
  learnFromSuccess(userInput: string, chain: ToolChainStep[], _traces: ExecutionTrace[]): void {
    const toolSequence = chain.map(s => s.tool);

    // 更新意图映射的置信度
    const match = this.findBestMapping(userInput);
    if (match) {
      const mapping = this.mappings.get(match.mapping.id)!;
      // 置信度微增（上限0.99）
      mapping.confidence = Math.min(0.99, mapping.confidence + 0.01);
      this.mappings.set(mapping.id, mapping);

      if (this.intentCounts[mapping.id]) {
        this.intentCounts[mapping.id].successes++;
      }
    }

    // 记录学习模式
    const patternKey = this.buildPatternKey(toolSequence);
    const existing = this.learnedPatterns.get(patternKey);
    if (existing) {
      existing.successCount++;
      existing.lastUsed = Date.now();
    } else {
      this.learnedPatterns.set(patternKey, {
        id: `learned_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userInputPattern: userInput,
        toolSequence,
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
      });
    }

    // 如果新模式成功3次以上，提议为新映射
    const pattern = this.learnedPatterns.get(patternKey);
    if (pattern && pattern.successCount >= 3 && !pattern.proposedMapping) {
      pattern.proposedMapping = {
        id: `auto_${patternKey}`,
        intentPattern: this.inferPatternFromExamples(userInput),
        domain: this.inferDomainFromTools(toolSequence),
        requiredTools: toolSequence,
        toolChain: chain,
        confidence: 0.6,
        examples: [userInput],
      };
      this.log.info('New pattern proposed as intent mapping', {
        patternKey,
        successCount: pattern.successCount,
      });
    }

    // 记录到执行历史
    this.executionHistory.push({
      userInput,
      intentId: match?.mapping.id || 'unknown',
      chainIndex: 0,
      success: true,
      timestamp: Date.now(),
    });

    this.persistToDisk();
  }

  /**
   * 从失败执行中学习
   */
  learnFromFailure(userInput: string, chain: ToolChainStep[], _traces: ExecutionTrace[]): void {
    const toolSequence = chain.map(s => s.tool);

    // 降低意图映射的置信度
    const match = this.findBestMapping(userInput);
    if (match) {
      const mapping = this.mappings.get(match.mapping.id)!;
      mapping.confidence = Math.max(0.1, mapping.confidence - 0.02);
      this.mappings.set(mapping.id, mapping);
    }

    // 记录学习模式
    const patternKey = this.buildPatternKey(toolSequence);
    const existing = this.learnedPatterns.get(patternKey);
    if (existing) {
      existing.failureCount++;
      existing.lastUsed = Date.now();
    }

    // 记录到执行历史
    this.executionHistory.push({
      userInput,
      intentId: match?.mapping.id || 'unknown',
      chainIndex: 0,
      success: false,
      timestamp: Date.now(),
    });

    this.persistToDisk();
  }

  /**
   * 注册新的意图映射
   */
  registerIntent(mapping: IntentMapping): void {
    this.mappings.set(mapping.id, mapping);
    this.log.info('Intent mapping registered', {
      id: mapping.id,
      domain: mapping.domain,
      confidence: mapping.confidence,
    });
    this.persistToDisk();
  }

  /**
   * 当主链失败时建议替代方案
   */
  suggestAlternatives(userInput: string, failedChain: ToolChainStep[]): ToolChainStep[][] {
    const alternatives: ToolChainStep[][] = [];

    // 1. 查找匹配映射的替代链
    const match = this.findBestMapping(userInput);
    if (match && match.mapping.alternativeChains) {
      alternatives.push(...match.mapping.alternativeChains);
    }

    // 2. 查找相同领域的其他映射
    const domain = match?.mapping.domain;
    if (domain) {
      for (const mapping of this.mappings.values()) {
        if (mapping.domain === domain && mapping.id !== match?.mapping.id) {
          // 检查工具链是否有重叠但不同
          const hasOverlap = mapping.toolChain.some(s =>
            failedChain.some(f => f.tool === s.tool)
          );
          const isDifferent = mapping.toolChain.some(s =>
            !failedChain.some(f => f.tool === s.tool)
          );
          if (hasOverlap && isDifferent) {
            alternatives.push(mapping.toolChain);
          }
        }
      }
    }

    // 3. 从学习模式中查找成功替代
    for (const pattern of this.learnedPatterns.values()) {
      if (
        pattern.successCount > pattern.failureCount &&
        pattern.toolSequence.length > 0 &&
        !pattern.toolSequence.every((t, i) => t === failedChain[i]?.tool)
      ) {
        const chain: ToolChainStep[] = pattern.toolSequence.map(tool => ({
          tool,
          args: {},
          description: `Learned step: ${tool}`,
        }));
        alternatives.push(chain);
      }
    }

    this.log.info('Alternatives suggested', {
      userInput: userInput.slice(0, 50),
      alternativeCount: alternatives.length,
    });

    return alternatives.slice(0, 5);
  }

  /**
   * P0 真实修复：FailureHandler 执行器 — 真实消费 FailureHandler 数据结构
   *
   * 之前 FailureHandler 仅作为数据结构存在，5 个 action 中 3 个从未使用，
   * 且无任何执行器消费。此方法是真实的执行分支：
   * - retry_with_adjustment: 重新执行该步骤（可调整参数）
   * - try_alternative_chain: 切换到 alternativeChains 执行
   * - ask_user: 返回需要用户确认的消息（不执行）
   * - skip_step: 跳过该步骤继续后续
   * - rollback: 回滚已执行步骤（需要 rollbackFn）
   *
   * @param failedStep 失败的步骤
   * @param failureReason 失败原因
   * @param mapping 对应的 IntentMapping（可能为 null）
   * @param executedSteps 已执行的步骤（用于 rollback）
   * @param toolExecutor 工具执行器回调
   * @param rollbackFn 回滚函数（可选，用于 rollback action）
   */
  async executeFailureHandler(
    failedStep: ToolChainStep,
    failureReason: string,
    mapping: IntentMapping | null,
    executedSteps: Array<{ step: ToolChainStep; result: string }>,
    toolExecutor: (step: ToolChainStep) => Promise<string>,
    rollbackFn?: (executedSteps: Array<{ step: ToolChainStep; result: string }>) => Promise<void>,
  ): Promise<{
    action: FailureHandler['action'];
    success: boolean;
    result?: string;
    userPrompt?: string;
    skipped?: boolean;
    rolledBack?: boolean;
  }> {
    // 查找匹配的 FailureHandler
    let handler: FailureHandler | undefined;
    if (mapping?.failureHandlers && mapping.failureHandlers.length > 0) {
      // 按 condition 关键词匹配
      handler = mapping.failureHandlers.find(h =>
        failureReason.toLowerCase().includes(h.condition.toLowerCase()) ||
        h.condition.toLowerCase().includes(failureReason.toLowerCase().substring(0, 10))
      );
      // 默认使用第一个 handler
      if (!handler) handler = mapping.failureHandlers[0];
    }

    // 无 handler 时根据 onFailure 字段决定
    const action = handler?.action ?? this._inferActionFromOnFailure(failedStep.onFailure);

    this.log.info('FailureHandler 执行', {
      action,
      condition: handler?.condition,
      failedStep: failedStep.tool,
      reason: failureReason.substring(0, 100),
    });

    switch (action) {
      case 'retry_with_adjustment': {
        // 重试该步骤，最多 maxRetries 次
        const maxRetries = failedStep.maxRetries ?? 2;
        let lastError = failureReason;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            this.log.info(`重试 ${failedStep.tool} (第 ${attempt} 次)`, { attempt });
            const result = await toolExecutor(failedStep);
            return { action, success: true, result };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            lastError = msg;
            this.log.warn(`重试 ${failedStep.tool} 第 ${attempt} 次失败`, { error: lastError });
          }
        }
        return { action, success: false, result: `重试 ${maxRetries} 次后仍失败: ${lastError}` };
      }

      case 'try_alternative_chain': {
        // 尝试替代链
        if (mapping?.alternativeChains && mapping.alternativeChains.length > 0) {
          const altChain = mapping.alternativeChains[0];
          this.log.info(`切换到替代链 (${altChain.length} 步)`, { alternativeIndex: 0 });
          const altResults: string[] = [];
          for (const step of altChain) {
            try {
              const r = await toolExecutor(step);
              altResults.push(r);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return {
                action,
                success: false,
                result: `替代链在步骤 ${step.tool} 失败: ${msg}`,
              };
            }
          }
          return { action, success: true, result: altResults.join('\n') };
        }
        return { action, success: false, result: '无可用的替代链' };
      }

      case 'ask_user': {
        // 返回用户确认提示，不执行
        const prompt = handler?.details || `步骤 "${failedStep.description}" 失败（原因: ${failureReason}），请确认是否继续？`;
        return { action, success: false, userPrompt: prompt };
      }

      case 'skip_step': {
        // 跳过该步骤，继续后续
        this.log.info(`跳过步骤 ${failedStep.tool}`, { reason: failureReason });
        return { action, success: true, skipped: true, result: `已跳过步骤 ${failedStep.tool}` };
      }

      case 'rollback': {
        // 回滚已执行步骤
        if (rollbackFn) {
          try {
            await rollbackFn(executedSteps);
            return { action, success: true, rolledBack: true, result: `已回滚 ${executedSteps.length} 个步骤` };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { action, success: false, result: `回滚失败: ${msg}` };
          }
        }
        return { action, success: false, result: '未提供回滚函数，无法执行 rollback' };
      }

      default:
        return { action, success: false, result: `未知 action: ${action}` };
    }
  }

  /**
   * P0 真实修复：根据 onFailure 字段推断 FailureHandler action
   * 当映射未定义 failureHandlers 时，使用步骤的 onFailure 字段作为后备
   */
  private _inferActionFromOnFailure(onFailure?: ToolChainStep['onFailure']): FailureHandler['action'] {
    switch (onFailure) {
      case 'retry': return 'retry_with_adjustment';
      case 'try_alternative': return 'try_alternative_chain';
      case 'ask_user': return 'ask_user';
      case 'skip': return 'skip_step';
      case 'abort': return 'rollback';
      default: return 'skip_step';
    }
  }

  /**
   * 估算任务复杂度
   */
  estimateComplexity(userInput: string): 'simple' | 'moderate' | 'complex' | 'very_complex' {
    const match = this.findBestMapping(userInput);

    if (!match) return 'complex';

    const chain = match.mapping.toolChain;
    const stepCount = chain.length;
    const hasAlternatives = (match.mapping.alternativeChains?.length ?? 0) > 0;
    const hasPrerequisites = (match.mapping.prerequisites?.length ?? 0) > 0;
    const hasFailureHandlers = (match.mapping.failureHandlers?.length ?? 0) > 0;

    // 简单评分
    let complexityScore = 0;
    complexityScore += stepCount;
    if (hasAlternatives) complexityScore += 1;
    if (hasPrerequisites) complexityScore += 2;
    if (hasFailureHandlers) complexityScore += 1;
    if (match.mapping.confidence < 0.7) complexityScore += 2;

    // 检查是否包含多步骤关键词
    const complexKeywords = ['然后', '之后', '接着', '并且', '同时', '还要', '再'];
    for (const kw of complexKeywords) {
      if (userInput.includes(kw)) complexityScore += 2;
    }

    if (complexityScore <= 2) return 'simple';
    if (complexityScore <= 4) return 'moderate';
    if (complexityScore <= 7) return 'complex';
    return 'very_complex';
  }

  /**
   * 分解复杂任务为子任务
   */
  decomposeComplexTask(userInput: string): Array<{ subTask: string; decision: DecisionResult }> {
    const subTasks: Array<{ subTask: string; decision: DecisionResult }> = [];

    // 按连接词分割
    const connectors = ['然后', '之后', '接着', '并且', '再', '还有', '同时'];
    let remaining = userInput;
    const parts: string[] = [];

    for (const connector of connectors) {
      const idx = remaining.indexOf(connector);
      if (idx > 0) {
        parts.push(remaining.slice(0, idx).trim());
        remaining = remaining.slice(idx + connector.length).trim();
      }
    }
    if (remaining.trim()) {
      parts.push(remaining.trim());
    }

    // 如果没有找到连接词，尝试按逗号分割
    if (parts.length <= 1) {
      const commaParts = userInput.split(/[，,；;]/).map(p => p.trim()).filter(p => p.length > 0);
      if (commaParts.length > 1) {
        parts.length = 0;
        parts.push(...commaParts);
      }
    }

    // 如果仍然只有一个部分，返回整体
    if (parts.length <= 1) {
      return [{ subTask: userInput, decision: this.analyzeIntent(userInput) }];
    }

    // 对每个子任务分析
    for (const part of parts) {
      const decision = this.analyzeIntent(part);
      subTasks.push({ subTask: part, decision });
    }

    this.log.info('Complex task decomposed', {
      originalInput: userInput.slice(0, 50),
      subTaskCount: subTasks.length,
    });

    return subTasks;
  }

  /**
   * 获取意图匹配统计
   */
  getIntentStats(): IntentStats {
    const avgConfidence = this.totalAnalyses > 0
      ? this.confidenceSum / this.totalAnalyses
      : 0;

    const topIntents = Object.entries(this.intentCounts)
      .map(([intentId, data]) => ({
        intentId,
        count: data.count,
        successRate: data.count > 0 ? data.successes / data.count : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalAnalyses: this.totalAnalyses,
      successfulMatches: this.successfulMatches,
      failedMatches: this.failedMatches,
      averageConfidence: avgConfidence,
      domainDistribution: { ...this.domainCounts },
      topIntents,
    };
  }

  // ============ 内部方法 ============

  /**
   * 对单个映射评分
   */
  private scoreMapping(
    userInput: string,
    mapping: IntentMapping,
    context?: { recentTools?: string[]; activeApps?: string[] }
  ): { score: number; extractedVars: Record<string, string> } {
    let score = 0;
    const extractedVars: Record<string, string> = {};

    // 1. 模式匹配
    const pattern = mapping.intentPattern;
    if (pattern instanceof RegExp) {
      if (pattern.test(userInput)) {
        // 检查是否完全匹配（更长的匹配得分更高）
        const matchLength = userInput.match(pattern)?.[0]?.length ?? 0;
        const matchRatio = matchLength / userInput.length;
        if (matchRatio > 0.8) {
          score += 10; // 几乎完全匹配
        } else if (matchRatio > 0.4) {
          score += 7; // 大部分匹配
        } else {
          score += 5; // 部分匹配
        }
      }
    } else {
      // 字符串模式
      if (userInput.includes(pattern)) {
        score += 10;
      } else if (this.fuzzyMatch(userInput, pattern)) {
        score += 5;
      }
    }

    // 如果没有匹配，直接返回0
    if (score === 0) return { score: 0, extractedVars };

    // 2. 领域匹配上下文
    if (context?.activeApps) {
      const appNames = context.activeApps.map(a => a.toLowerCase());
      if (mapping.subDomain && appNames.some(a => a.includes(mapping.subDomain!))) {
        score += 3;
      }
    }

    // 3. 所需工具可用性（假设都可用，给基础分）
    score += 2;

    // 4. 近期工具重叠
    if (context?.recentTools) {
      const overlap = mapping.requiredTools.filter(t =>
        context.recentTools!.includes(t)
      ).length;
      score += Math.min(overlap * 2, 6);
    }

    // 5. 示例相似度
    for (const example of mapping.examples) {
      if (this.computeSimilarity(userInput, example) > 0.6) {
        score += 4;
        break;
      } else if (this.computeSimilarity(userInput, example) > 0.3) {
        score += 2;
        break;
      }
    }

    // 6. 乘以置信度
    score *= mapping.confidence;

    // 7. 提取模板变量
    const vars = this.extractTemplateVariables(userInput, mapping);
    Object.assign(extractedVars, vars);

    return { score, extractedVars };
  }

  /**
   * 从用户输入中提取模板变量
   */
  private extractTemplateVariables(userInput: string, mapping: IntentMapping): Record<string, string> {
    const vars: Record<string, string> = {};

    // 使用通用中文模板模式提取
    for (const tp of TEMPLATE_PATTERNS) {
      const match = userInput.match(tp.pattern);
      if (match) {
        for (const [key, extractor] of Object.entries(tp.extractors)) {
          vars[key] = extractor(match);
        }
        break;
      }
    }

    // 特定领域提取
    switch (mapping.subDomain) {
      case 'photoshop':
        if (!vars['filePath'] && /盘|路径|文件/.test(userInput)) {
          const pathMatch = userInput.match(/([A-Za-z]:[\\/][^\s，。]+|[^\s，。]+\.[a-zA-Z]{2,4})/);
          if (pathMatch) vars['filePath'] = normalizeChinesePath(pathMatch[1]);
        }
        if (/红色/.test(userInput)) vars['borderColor'] = '#FF0000';
        else if (/蓝色/.test(userInput)) vars['borderColor'] = '#0000FF';
        else if (/绿色/.test(userInput)) vars['borderColor'] = '#00FF00';
        else if (/黑色/.test(userInput)) vars['borderColor'] = '#000000';
        else if (/白色/.test(userInput)) vars['borderColor'] = '#FFFFFF';
        if (vars['addition'] && !vars['borderColor']) vars['borderColor'] = vars['addition'];
        if (vars['addition'] && !vars['text']) vars['text'] = vars['addition'];
        break;
      case 'wechat':
        // target 和 content 可能已由通用模式提取
        break;
      case 'ppt':
        if (vars['topic']) {
          // 主题已提取
        } else if (vars['subject']) {
          vars['topic'] = vars['subject'];
        }
        break;
      case 'search':
        if (vars['query']) {
          // 查询已提取
        } else if (vars['target']) {
          vars['query'] = vars['target'];
        }
        break;
    }

    // 应用名标准化
    if (vars['tool']) {
      const normalized = APP_ALIASES[vars['tool']];
      if (normalized) vars['tool'] = normalized;
    }

    return vars;
  }

  /**
   * 填充模板变量到工具链
   */
  private fillTemplateVariables(
    chain: ToolChainStep[],
    vars: Record<string, string>
  ): ToolChainStep[] {
    return chain.map(step => {
      const filledArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(step.args)) {
        if (typeof value === 'string') {
          filledArgs[key] = this.replaceTemplateVars(value, vars);
        } else if (typeof value === 'object' && value !== null) {
          filledArgs[key] = this.deepReplaceTemplateVars(value, vars);
        } else {
          filledArgs[key] = value;
        }
      }
      return { ...step, args: filledArgs };
    });
  }

  private replaceTemplateVars(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || `{{${key}}}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private deepReplaceTemplateVars(obj: Record<string, any>, vars: Record<string, string>): Record<string, any> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.replaceTemplateVars(value, vars);
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.deepReplaceTemplateVars(value, vars);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 模糊匹配
   */
  private fuzzyMatch(input: string, pattern: string): boolean {
    const inputLower = input.toLowerCase();
    const patternLower = pattern.toLowerCase();
    let pi = 0;
    for (let i = 0; i < inputLower.length && pi < patternLower.length; i++) {
      if (inputLower[i] === patternLower[pi]) pi++;
    }
    return pi === patternLower.length;
  }

  /**
   * 计算字符串相似度（简化版 Jaccard）
   */
  private computeSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(''));
    const setB = new Set(b.split(''));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 查找最佳匹配映射
   */
  private findBestMapping(userInput: string): { mapping: IntentMapping; score: number } | null {
    let best: { mapping: IntentMapping; score: number } | null = null;

    for (const mapping of this.mappings.values()) {
      const { score } = this.scoreMapping(userInput, mapping);
      if (!best || score > best.score) {
        best = { mapping, score };
      }
    }

    return best;
  }

  /**
   * 提取所需应用列表
   */
  private extractRequiredApps(mapping: IntentMapping): string[] {
    const apps = new Set<string>();
    for (const step of mapping.toolChain) {
      if (step.tool === 'app_launch' && step.args.app) {
        apps.add(step.args.app);
      }
      if (step.tool === 'app_shortcut' && step.args.app) {
        apps.add(step.args.app);
      }
      if (step.tool === 'app_workflow' && step.args.app) {
        apps.add(step.args.app);
      }
    }
    return [...apps];
  }

  /**
   * 生成警告信息
   */
  private generateWarnings(
    mapping: IntentMapping,
    context?: { recentTools?: string[]; activeApps?: string[] }
  ): string[] {
    const warnings: string[] = [];

    if (mapping.confidence < 0.7) {
      warnings.push('此意图匹配置信度较低，可能需要用户确认');
    }

    if (mapping.prerequisites && mapping.prerequisites.length > 0) {
      warnings.push(`前置条件: ${mapping.prerequisites.join(', ')}`);
    }

    if (mapping.requiredTools.length > 5) {
      warnings.push('此任务需要多个工具协作，执行时间可能较长');
    }

    // 检查所需应用是否在活跃应用中
    const requiredApps = this.extractRequiredApps(mapping);
    if (context?.activeApps && requiredApps.length > 0) {
      const missingApps = requiredApps.filter(
        app => !context.activeApps!.some(active =>
          active.toLowerCase().includes(app.toLowerCase())
        )
      );
      if (missingApps.length > 0) {
        warnings.push(`需要启动以下应用: ${missingApps.join(', ')}`);
      }
    }

    return warnings;
  }

  /**
   * 构建模式键
   */
  private buildPatternKey(toolSequence: string[]): string {
    return toolSequence.join('→');
  }

  /**
   * 从示例推断正则模式
   */
  private inferPatternFromExamples(_example: string): RegExp {
    // 简化：提取关键动词和名词
    const verbs = ['打开', '创建', '写', '编辑', '发送', '生成', '搜索', '下载', '分析', '修复', '重构'];
    const pattern = verbs.map(v => v).join('|');
    return new RegExp(`(${pattern}).+`);
  }

  /**
   * 从工具序列推断领域
   */
  private inferDomainFromTools(tools: string[]): string {
    if (tools.some(t => t.includes('app_') || t.includes('desktop_'))) return 'desktop_automation';
    if (tools.some(t => t.includes('code_'))) return 'code';
    if (tools.some(t => t.includes('web_'))) return 'web';
    if (tools.some(t => t.includes('file_'))) return 'file';
    if (tools.some(t => t.includes('wechat_') || t.includes('email'))) return 'communication';
    if (tools.some(t => t.includes('image_generate') || t.includes('video_'))) return 'creative';
    if (tools.some(t => t.includes('analyze'))) return 'data';
    return 'unknown';
  }

  // ============ 持久化 ============

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.dataDir)) return;

      // 加载映射
      const mappingsFile = path.join(this.dataDir, 'mappings.json');
      if (fs.existsSync(mappingsFile)) {
        const data = JSON.parse(fs.readFileSync(mappingsFile, 'utf-8')) as IntentMapping[];
        for (const mapping of data) {
          // 不覆盖内置映射，只添加自定义映射
          if (!this.mappings.has(mapping.id)) {
            this.mappings.set(mapping.id, mapping);
          }
        }
      }

      // 加载历史
      const historyFile = path.join(this.dataDir, 'history.json');
      if (fs.existsSync(historyFile)) {
        this.executionHistory = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        // 限制历史大小
        if (this.executionHistory.length > 1000) {
          this.executionHistory = this.executionHistory.slice(-1000);
        }
      }

      // 加载学习模式
      const learnedFile = path.join(this.dataDir, 'learned.json');
      if (fs.existsSync(learnedFile)) {
        const data = JSON.parse(fs.readFileSync(learnedFile, 'utf-8')) as LearnedPattern[];
        for (const pattern of data) {
          this.learnedPatterns.set(pattern.id, pattern);
        }
      }

      this.log.info('Data loaded from disk', {
        mappings: this.mappings.size,
        history: this.executionHistory.length,
        learned: this.learnedPatterns.size,
      });
    } catch (err: unknown) {
      this.log.error('Failed to load data from disk', { error: err });
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });

      // 保存自定义映射（排除内置映射）
      const customMappings: IntentMapping[] = [];
      const builtinIds = new Set(buildBuiltinMappings().map(m => m.id));
      for (const mapping of this.mappings.values()) {
        if (!builtinIds.has(mapping.id)) {
          customMappings.push(mapping);
        }
      }
      atomicWriteJsonSync(path.join(this.dataDir, 'mappings.json'), customMappings);

      // 保存历史（最近1000条）
      const recentHistory = this.executionHistory.slice(-1000);
      atomicWriteJsonSync(path.join(this.dataDir, 'history.json'), recentHistory);

      // 保存学习模式
      const learned = [...this.learnedPatterns.values()];
      atomicWriteJsonSync(path.join(this.dataDir, 'learned.json'), learned);
    } catch (err: unknown) {
      this.log.error('Failed to persist data to disk', { error: err });
    }
  }
}

// ============ 工具定义（供 agent loop 使用） ============

export const decisionTools = [
  {
    name: 'decision_analyze',
    description: '分析用户意图并建议最优工具链。当需要理解用户想做什么、选择正确的工具序列时使用。',
    parameters: {
      type: 'object' as const,
      properties: {
        userInput: {
          type: 'string',
          description: '用户的原始输入文本',
        },
        recentTools: {
          type: 'array',
          items: { type: 'string' },
          description: '最近使用过的工具列表（可选）',
        },
        activeApps: {
          type: 'array',
          items: { type: 'string' },
          description: '当前活跃的应用列表（可选）',
        },
      },
      required: ['userInput'] as string[],
    },
  },
  {
    name: 'decision_execute',
    description: '执行决策引擎决定的工具链。根据用户输入自动选择并执行最优工具序列。',
    parameters: {
      type: 'object' as const,
      properties: {
        userInput: {
          type: 'string',
          description: '用户的原始输入文本',
        },
        autoApprove: {
          type: 'boolean',
          description: '是否自动批准执行（默认false，需用户确认）',
          default: false,
        },
      },
      required: ['userInput'] as string[],
    },
  },
  {
    name: 'decision_alternatives',
    description: '获取替代方案。当主要工具链执行失败时，获取其他可行的工具序列。',
    parameters: {
      type: 'object' as const,
      properties: {
        userInput: {
          type: 'string',
          description: '用户的原始输入文本',
        },
      },
      required: ['userInput'] as string[],
    },
  },
  {
    name: 'decision_complexity',
    description: '估算任务复杂度。判断任务是简单、中等、复杂还是非常复杂。',
    parameters: {
      type: 'object' as const,
      properties: {
        userInput: {
          type: 'string',
          description: '用户的原始输入文本',
        },
      },
      required: ['userInput'] as string[],
    },
  },
];
