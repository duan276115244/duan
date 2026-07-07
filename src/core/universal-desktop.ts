/**
 * 通用桌面自动化框架 — UniversalDesktop
 *
 * 核心理念：一个框架操控任意桌面应用（Photoshop、PowerPoint、VS Code、浏览器等）
 *
 * 能力组合：
 * 1. 视觉识别（截图 → 分析 → 定位元素）
 * 2. 键盘/鼠标自动化（输入、点击、快捷键）
 * 3. 应用专属命令模板（PS 快捷键、PPT 操作等）
 * 4. 智能工作流编排（自然语言 → 操作序列）
 *
 * 安全设计：
 * - 操作频率限制（200ms 最小间隔）
 * - 工作流步骤间默认 300ms 等待
 * - 关键步骤后可选截图验证
 * - 错误恢复：步骤失败时截图并尝试恢复
 * - 所有操作通过 EventBus 广播事件
 */

import * as os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { DesktopControl } from './desktop-control.js';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

const execAsync = promisify(exec);

// ============ 类型定义 ============

/** 快捷键定义 */
export interface ShortcutDef {
  keys: string;                  // e.g., 'Ctrl+N', 'Ctrl+Shift+S'
  description: string;           // e.g., '新建文件', '另存为'
  category: string;              // e.g., 'file', 'edit', 'view', 'tool'
}

/** 工作流步骤 */
export interface WorkflowStep {
  action: 'shortcut' | 'type' | 'click' | 'wait' | 'screenshot' | 'menu' | 'drag' | 'condition';
  value?: string;                // shortcut: keys, type: text, wait: ms
  x?: number;                    // click/drag 起点
  y?: number;                    // click/drag 起点
  toX?: number;                  // drag 终点 X
  toY?: number;                  // drag 终点 Y
  condition?: string;            // condition step: check screenshot for something
  menuPath?: string[];           // menu: ['File', 'Save As']
  description: string;
}

/** 工作流定义 */
export interface WorkflowDef {
  name: string;
  description: string;
  steps: WorkflowStep[];
  requiredParams: string[];      // 必须提供的参数
}

/** UI 结构定义 */
export interface UIStructureDef {
  menuBar?: {
    y: number;
    items: Record<string, { x: number; submenu?: Record<string, number> }>;
  };
  toolbars?: Record<string, { bounds: { x: number; y: number; w: number; h: number } }>;
  panels?: Record<string, { bounds: { x: number; y: number; w: number; h: number } }>;
}

/** 应用配置 */
export interface ApplicationProfile {
  id: string;                    // e.g., 'photoshop', 'powerpoint', 'vscode'
  name: string;                  // 显示名称
  processNames: string[];        // 进程名检测, e.g., ['Photoshop.exe', 'photoshop']
  windowTitles: string[];        // 窗口标题模式, e.g., ['Adobe Photoshop']
  launchCommand: string;         // 启动命令, e.g., 'Photoshop'
  shortcuts: Record<string, ShortcutDef>;
  workflows: Record<string, WorkflowDef>;
  uiStructure?: UIStructureDef;
}

/** 应用运行状态 */
export interface AppStatus {
  appId: string;
  isRunning: boolean;
  processIds: number[];
  windowTitles: string[];
  isActive: boolean;
}

/** 工作流执行结果 */
export interface WorkflowResult {
  success: boolean;
  appId: string;
  workflowName: string;
  stepsCompleted: number;
  stepsTotal: number;
  duration: number;
  error?: string;
  screenshotPath?: string;
}

/** 智能操作解析结果 */
export interface ParsedInstruction {
  appId: string;
  operation: string;
  params: Record<string, unknown>;
  confidence: number;
}

/**
 * 统一应用操作接口
 * 所有应用控制操作均通过此接口发起，支持超时与重试
 */
export interface AppOperation {
  app: string;           // 应用名称（appId）
  action: string;        // 操作类型: shortcut/workflow/menu/type/click/find_click/launch/activate
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;           // 操作参数（快捷键名/工作流名/菜单路径/文本/坐标等）
  timeout?: number;      // 超时时间（毫秒），默认 5000
  retry?: number;        // 失败重试次数，默认 3
}

/** 统一操作执行结果 */
export interface AppOperationResult {
  success: boolean;
  app: string;
  action: string;
  attempts: number;       // 实际尝试次数
  duration: number;       // 耗时（毫秒）
  result: string;         // 操作返回内容
  verified?: boolean;     // 是否已后置验证
  error?: string;
}

/** 批量操作任务 */
export interface BatchOperation {
  operations: AppOperation[];   // 待执行操作列表
  stopOnError?: boolean;        // 出错是否停止后续操作（默认 false）
}


/** 操作统计 */
interface UniversalDesktopStats {
  totalLaunches: number;
  totalShortcuts: number;
  totalWorkflows: number;
  totalSmartOps: number;
  totalMenuNavs: number;
  totalFindClicks: number;
  errors: number;
  lastActionTime: number | null;
}

// ============ 内置应用配置 ============

const PHOTOSHOP_PROFILE: ApplicationProfile = {
  id: 'photoshop',
  name: 'Adobe Photoshop',
  processNames: ['Photoshop.exe', 'photoshop'],
  windowTitles: ['Adobe Photoshop'],
  launchCommand: 'Photoshop',
  shortcuts: {
    '新建': { keys: 'Ctrl+N', description: '新建文件', category: 'file' },
    '打开': { keys: 'Ctrl+O', description: '打开文件', category: 'file' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '另存为': { keys: 'Ctrl+Shift+S', description: '另存为', category: 'file' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '重做': { keys: 'Ctrl+Shift+Z', description: '重做', category: 'edit' },
    '自由变换': { keys: 'Ctrl+T', description: '自由变换', category: 'edit' },
    '复制图层': { keys: 'Ctrl+J', description: '复制图层', category: 'layer' },
    '新建图层': { keys: 'Ctrl+Shift+N', description: '新建图层', category: 'layer' },
    '合并图层': { keys: 'Ctrl+E', description: '合并图层', category: 'layer' },
    '色阶': { keys: 'Ctrl+L', description: '色阶', category: 'adjust' },
    '曲线': { keys: 'Ctrl+M', description: '曲线', category: 'adjust' },
    '色彩平衡': { keys: 'Ctrl+B', description: '色彩平衡', category: 'adjust' },
    '色相饱和度': { keys: 'Ctrl+U', description: '色相饱和度', category: 'adjust' },
    '反相': { keys: 'Ctrl+I', description: '反相', category: 'adjust' },
    '移动工具': { keys: 'V', description: '移动工具', category: 'tool' },
    '选框工具': { keys: 'M', description: '选框工具', category: 'tool' },
    '套索工具': { keys: 'L', description: '套索工具', category: 'tool' },
    '魔棒': { keys: 'W', description: '魔棒', category: 'tool' },
    '裁剪': { keys: 'C', description: '裁剪', category: 'tool' },
    '文字工具': { keys: 'T', description: '文字工具', category: 'tool' },
    '画笔': { keys: 'B', description: '画笔', category: 'tool' },
    '橡皮擦': { keys: 'E', description: '橡皮擦', category: 'tool' },
    '渐变': { keys: 'G', description: '渐变', category: 'tool' },
    '抓手': { keys: 'H', description: '抓手', category: 'tool' },
    '缩放': { keys: 'Z', description: '缩放', category: 'tool' },
    '放大': { keys: 'Ctrl+=', description: '放大', category: 'view' },
    '缩小': { keys: 'Ctrl+-', description: '缩小', category: 'view' },
    '适应屏幕': { keys: 'Ctrl+0', description: '适应屏幕', category: 'view' },
    '实际像素': { keys: 'Ctrl+1', description: '实际像素', category: 'view' },
  },
  workflows: {
    '新建画布': {
      name: '新建画布',
      description: '创建新画布，指定宽高',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '打开新建对话框' },
        { action: 'type', value: '{{width}}', description: '输入宽度' },
        { action: 'shortcut', value: 'Tab', description: '切换到高度' },
        { action: 'type', value: '{{height}}', description: '输入高度' },
        { action: 'shortcut', value: 'Enter', description: '确认创建' },
      ],
      requiredParams: ['width', 'height'],
    },
    '调整色阶': {
      name: '调整色阶',
      description: '打开色阶调整面板',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '打开色阶' },
        { action: 'wait', value: '500', description: '等待面板加载' },
        { action: 'screenshot', description: '截图确认面板已打开' },
      ],
      requiredParams: [],
    },
    '添加文字': {
      name: '添加文字',
      description: '在指定位置添加文字',
      steps: [
        { action: 'shortcut', value: 'T', description: '选择文字工具' },
        { action: 'click', x: 0, y: 0, description: '点击文字位置' },
        { action: 'type', value: '{{text}}', description: '输入文字内容' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '确认文字输入' },
      ],
      requiredParams: ['text', 'x', 'y'],
    },
    '导出PNG': {
      name: '导出PNG',
      description: '快速导出为PNG格式',
      steps: [
        { action: 'menu', menuPath: ['File', 'Export', 'Quick Export as PNG'], description: '菜单导出PNG' },
        { action: 'wait', value: '500', description: '等待导出对话框' },
        { action: 'shortcut', value: 'Enter', description: '确认导出' },
      ],
      requiredParams: [],
    },
    '批量处理': {
      name: '批量处理',
      description: '打开动作面板进行批量处理',
      steps: [
        { action: 'shortcut', value: 'Alt+F9', description: '打开动作面板' },
        { action: 'wait', value: '500', description: '等待面板加载' },
      ],
      requiredParams: [],
    },
  },
};

const POWERPOINT_PROFILE: ApplicationProfile = {
  id: 'powerpoint',
  name: 'Microsoft PowerPoint',
  processNames: ['POWERPNT.EXE', 'powerpnt'],
  windowTitles: ['PowerPoint'],
  launchCommand: 'POWERPNT',
  shortcuts: {
    '新建': { keys: 'Ctrl+N', description: '新建演示文稿', category: 'file' },
    '新建幻灯片': { keys: 'Ctrl+M', description: '新建幻灯片', category: 'slide' },
    '复制幻灯片': { keys: 'Ctrl+D', description: '复制幻灯片', category: 'slide' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '从头放映': { keys: 'F5', description: '从头放映', category: 'present' },
    '从当前放映': { keys: 'Shift+F5', description: '从当前放映', category: 'present' },
    '退出放映': { keys: 'Escape', description: '退出放映', category: 'present' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '插入超链接': { keys: 'Ctrl+K', description: '插入超链接', category: 'insert' },
    '组合': { keys: 'Ctrl+G', description: '组合对象', category: 'format' },
    '取消组合': { keys: 'Ctrl+Shift+G', description: '取消组合', category: 'format' },
    '切换对象': { keys: 'Tab', description: '切换对象', category: 'edit' },
    '插入文本': { keys: 'Ctrl+Enter', description: '插入文本', category: 'insert' },
  },
  workflows: {
    '新建演示文稿': {
      name: '新建演示文稿',
      description: '创建新的演示文稿',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建演示文稿' },
        { action: 'wait', value: '1000', description: '等待窗口加载' },
      ],
      requiredParams: [],
    },
    '添加幻灯片': {
      name: '添加幻灯片',
      description: '添加一张新幻灯片',
      steps: [
        { action: 'shortcut', value: 'Ctrl+M', description: '新建幻灯片' },
        { action: 'wait', value: '500', description: '等待幻灯片加载' },
      ],
      requiredParams: [],
    },
    '插入文本框': {
      name: '插入文本框',
      description: '插入文本框并输入内容',
      steps: [
        { action: 'menu', menuPath: ['Insert', 'TextBox'], description: '插入文本框' },
        { action: 'click', x: 0, y: 0, description: '点击文本框位置' },
        { action: 'type', value: '{{text}}', description: '输入文本' },
      ],
      requiredParams: ['text', 'x', 'y'],
    },
    '插入图片': {
      name: '插入图片',
      description: '插入图片文件',
      steps: [
        { action: 'menu', menuPath: ['Insert', 'Pictures'], description: '插入图片' },
        { action: 'wait', value: '500', description: '等待文件对话框' },
        { action: 'type', value: '{{filePath}}', description: '输入文件路径' },
        { action: 'shortcut', value: 'Enter', description: '确认插入' },
      ],
      requiredParams: ['filePath'],
    },
    '设置主题': {
      name: '设置主题',
      description: '切换设计主题',
      steps: [
        { action: 'menu', menuPath: ['Design'], description: '打开设计选项卡' },
        { action: 'click', x: 0, y: 0, description: '点击主题位置' },
      ],
      requiredParams: ['themePosition'],
    },
    '添加动画': {
      name: '添加动画',
      description: '为选中对象添加动画',
      steps: [
        { action: 'menu', menuPath: ['Animations'], description: '打开动画选项卡' },
        { action: 'click', x: 0, y: 0, description: '点击动画类型' },
      ],
      requiredParams: ['animationType'],
    },
    '导出PDF': {
      name: '导出PDF',
      description: '导出为PDF文件',
      steps: [
        { action: 'menu', menuPath: ['File', 'Export', 'Create PDF'], description: '导出PDF' },
        { action: 'shortcut', value: 'Enter', description: '确认导出' },
      ],
      requiredParams: [],
    },
  },
};

const VSCODE_PROFILE: ApplicationProfile = {
  id: 'vscode',
  name: 'Visual Studio Code',
  processNames: ['Code.exe', 'code'],
  windowTitles: ['Visual Studio Code'],
  launchCommand: 'code',
  shortcuts: {
    '快速打开': { keys: 'Ctrl+P', description: '快速打开文件', category: 'file' },
    '命令面板': { keys: 'Ctrl+Shift+P', description: '命令面板', category: 'general' },
    '新建文件': { keys: 'Ctrl+N', description: '新建文件', category: 'file' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'edit' },
    '替换': { keys: 'Ctrl+H', description: '替换', category: 'edit' },
    '跳转行': { keys: 'Ctrl+G', description: '跳转到指定行', category: 'nav' },
    '终端': { keys: 'Ctrl+`', description: '打开终端', category: 'terminal' },
    '新终端': { keys: 'Ctrl+Shift+`', description: '新建终端', category: 'terminal' },
    '侧边栏': { keys: 'Ctrl+B', description: '切换侧边栏', category: 'view' },
    '资源管理器': { keys: 'Ctrl+Shift+E', description: '资源管理器', category: 'view' },
    '选择下一个匹配': { keys: 'Ctrl+D', description: '选择下一个匹配', category: 'edit' },
    '上移行': { keys: 'Alt+Up', description: '上移行', category: 'edit' },
    '下移行': { keys: 'Alt+Down', description: '下移行', category: 'edit' },
    '注释': { keys: 'Ctrl+/', description: '切换注释', category: 'edit' },
    '删除行': { keys: 'Ctrl+Shift+K', description: '删除行', category: 'edit' },
    '调试': { keys: 'F5', description: '启动调试', category: 'debug' },
    '重命名': { keys: 'F2', description: '重命名符号', category: 'edit' },
    '智能提示': { keys: 'Ctrl+Space', description: '智能提示', category: 'edit' },
  },
  workflows: {
    '打开项目': {
      name: '打开项目',
      description: '通过快速打开打开项目/文件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+P', description: '快速打开' },
        { action: 'type', value: '{{path}}', description: '输入路径' },
        { action: 'shortcut', value: 'Enter', description: '确认打开' },
      ],
      requiredParams: ['path'],
    },
    '新建文件': {
      name: '新建文件',
      description: '新建文件并保存',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建文件' },
        { action: 'shortcut', value: 'Ctrl+S', description: '保存' },
        { action: 'type', value: '{{fileName}}', description: '输入文件名' },
        { action: 'shortcut', value: 'Enter', description: '确认保存' },
      ],
      requiredParams: ['fileName'],
    },
    '运行终端命令': {
      name: '运行终端命令',
      description: '在终端中运行命令',
      steps: [
        { action: 'shortcut', value: 'Ctrl+`', description: '打开终端' },
        { action: 'type', value: '{{command}}', description: '输入命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
    '安装扩展': {
      name: '安装扩展',
      description: '搜索并安装VS Code扩展',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Shift+X', description: '打开扩展面板' },
        { action: 'type', value: '{{extensionName}}', description: '搜索扩展' },
        { action: 'wait', value: '1000', description: '等待搜索结果' },
        { action: 'click', x: 0, y: 0, description: '点击安装按钮' },
      ],
      requiredParams: ['extensionName'],
    },
    'Git提交': {
      name: 'Git提交',
      description: '在VS Code中提交Git更改',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Shift+G', description: '打开源代码管理' },
        { action: 'type', value: '{{message}}', description: '输入提交消息' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '提交' },
      ],
      requiredParams: ['message'],
    },
  },
};

const BROWSER_PROFILE: ApplicationProfile = {
  id: 'chrome',
  name: 'Google Chrome / Microsoft Edge',
  processNames: ['chrome.exe', 'msedge.exe', 'google-chrome', 'microsoft-edge'],
  windowTitles: ['Chrome', 'Edge'],
  launchCommand: 'chrome',
  shortcuts: {
    '新窗口': { keys: 'Ctrl+N', description: '新窗口', category: 'window' },
    '新标签': { keys: 'Ctrl+T', description: '新标签页', category: 'tab' },
    '关闭标签': { keys: 'Ctrl+W', description: '关闭当前标签', category: 'tab' },
    '地址栏': { keys: 'Ctrl+L', description: '聚焦地址栏', category: 'nav' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'nav' },
    '收藏': { keys: 'Ctrl+D', description: '添加收藏', category: 'nav' },
    '隐身': { keys: 'Ctrl+Shift+N', description: '隐身模式', category: 'window' },
    '下一标签': { keys: 'Ctrl+Tab', description: '下一标签', category: 'tab' },
    '上一标签': { keys: 'Ctrl+Shift+Tab', description: '上一标签', category: 'tab' },
    '开发者工具': { keys: 'F12', description: '开发者工具', category: 'dev' },
    '放大': { keys: 'Ctrl+=', description: '放大页面', category: 'view' },
    '缩小': { keys: 'Ctrl+-', description: '缩小页面', category: 'view' },
    '重置缩放': { keys: 'Ctrl+0', description: '重置缩放', category: 'view' },
  },
  workflows: {
    '打开网址': {
      name: '打开网址',
      description: '在浏览器中打开指定网址',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '聚焦地址栏' },
        { action: 'type', value: '{{url}}', description: '输入网址' },
        { action: 'shortcut', value: 'Enter', description: '打开网址' },
      ],
      requiredParams: ['url'],
    },
    '搜索内容': {
      name: '搜索内容',
      description: '在地址栏中搜索内容',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '聚焦地址栏' },
        { action: 'type', value: '{{query}}', description: '输入搜索词' },
        { action: 'shortcut', value: 'Enter', description: '执行搜索' },
      ],
      requiredParams: ['query'],
    },
    '截图保存': {
      name: '截图保存',
      description: '使用开发者工具截图保存',
      steps: [
        { action: 'shortcut', value: 'F12', description: '打开开发者工具' },
        { action: 'shortcut', value: 'Ctrl+Shift+P', description: '命令面板' },
        { action: 'type', value: 'screenshot', description: '输入screenshot' },
        { action: 'shortcut', value: 'Enter', description: '执行截图' },
      ],
      requiredParams: [],
    },
  },
};

// ============ 新增应用配置（扩展至 20+ 类） ============

/** Firefox 浏览器 */
const FIREFOX_PROFILE: ApplicationProfile = {
  id: 'firefox',
  name: 'Mozilla Firefox',
  processNames: ['firefox.exe', 'firefox'],
  windowTitles: ['Firefox'],
  launchCommand: 'firefox',
  shortcuts: {
    '新标签': { keys: 'Ctrl+T', description: '新标签页', category: 'tab' },
    '关闭标签': { keys: 'Ctrl+W', description: '关闭当前标签', category: 'tab' },
    '地址栏': { keys: 'Ctrl+L', description: '聚焦地址栏', category: 'nav' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'nav' },
    '收藏': { keys: 'Ctrl+D', description: '添加收藏', category: 'nav' },
    '下一标签': { keys: 'Ctrl+Tab', description: '下一标签', category: 'tab' },
    '上一标签': { keys: 'Ctrl+Shift+Tab', description: '上一标签', category: 'tab' },
    '历史': { keys: 'Ctrl+H', description: '历史记录', category: 'nav' },
    '下载': { keys: 'Ctrl+J', description: '下载管理', category: 'nav' },
    '开发者工具': { keys: 'F12', description: '开发者工具', category: 'dev' },
  },
  workflows: {
    '打开网址': {
      name: '打开网址',
      description: '在 Firefox 中打开指定网址',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '聚焦地址栏' },
        { action: 'type', value: '{{url}}', description: '输入网址' },
        { action: 'shortcut', value: 'Enter', description: '打开网址' },
      ],
      requiredParams: ['url'],
    },
    '搜索内容': {
      name: '搜索内容',
      description: '在地址栏中搜索内容',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '聚焦地址栏' },
        { action: 'type', value: '{{query}}', description: '输入搜索词' },
        { action: 'shortcut', value: 'Enter', description: '执行搜索' },
      ],
      requiredParams: ['query'],
    },
  },
};

/** Notepad++ 编辑器 */
const NOTEPADPP_PROFILE: ApplicationProfile = {
  id: 'notepad++',
  name: 'Notepad++',
  processNames: ['notepad++.exe', 'notepad++'],
  windowTitles: ['Notepad++'],
  launchCommand: 'notepad++',
  shortcuts: {
    '新建': { keys: 'Ctrl+N', description: '新建文件', category: 'file' },
    '打开': { keys: 'Ctrl+O', description: '打开文件', category: 'file' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '另存为': { keys: 'Ctrl+Alt+S', description: '另存为', category: 'file' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'edit' },
    '替换': { keys: 'Ctrl+H', description: '替换', category: 'edit' },
    '跳转行': { keys: 'Ctrl+G', description: '跳转到指定行', category: 'nav' },
    '注释': { keys: 'Ctrl+Q', description: '切换注释', category: 'edit' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '全选': { keys: 'Ctrl+A', description: '全选', category: 'edit' },
  },
  workflows: {
    '打开文件': {
      name: '打开文件',
      description: '打开指定文件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+O', description: '打开文件对话框' },
        { action: 'type', value: '{{filePath}}', description: '输入文件路径' },
        { action: 'shortcut', value: 'Enter', description: '确认打开' },
      ],
      requiredParams: ['filePath'],
    },
    '保存文件': {
      name: '保存文件',
      description: '保存当前文件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+S', description: '保存' },
      ],
      requiredParams: [],
    },
  },
};

/** Sublime Text 编辑器 */
const SUBLIME_PROFILE: ApplicationProfile = {
  id: 'sublime',
  name: 'Sublime Text',
  processNames: ['sublime_text.exe', 'sublime_text'],
  windowTitles: ['Sublime Text'],
  launchCommand: 'subl',
  shortcuts: {
    '新建': { keys: 'Ctrl+N', description: '新建文件', category: 'file' },
    '打开': { keys: 'Ctrl+O', description: '打开文件', category: 'file' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '命令面板': { keys: 'Ctrl+Shift+P', description: '命令面板', category: 'general' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'edit' },
    '替换': { keys: 'Ctrl+H', description: '替换', category: 'edit' },
    '跳转行': { keys: 'Ctrl+G', description: '跳转到指定行', category: 'nav' },
    '注释': { keys: 'Ctrl+/', description: '切换注释', category: 'edit' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
  },
  workflows: {
    '打开文件': {
      name: '打开文件',
      description: '打开指定文件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+O', description: '打开文件对话框' },
        { action: 'type', value: '{{filePath}}', description: '输入文件路径' },
        { action: 'shortcut', value: 'Enter', description: '确认打开' },
      ],
      requiredParams: ['filePath'],
    },
  },
};

/** PowerShell 终端 */
const POWERSHELL_PROFILE: ApplicationProfile = {
  id: 'powershell',
  name: 'Windows PowerShell',
  processNames: ['powershell', 'pwsh'],
  windowTitles: ['PowerShell'],
  launchCommand: 'powershell',
  shortcuts: {
    '复制': { keys: 'Enter', description: '复制选中内容（回车即复制）', category: 'edit' },
    '粘贴': { keys: 'RightClick', description: '右键粘贴', category: 'edit' },
    '清屏': { keys: 'Ctrl+L', description: '清屏', category: 'view' },
    '中断': { keys: 'Ctrl+C', description: '中断当前命令', category: 'edit' },
    '历史上一条': { keys: 'Up', description: '上一条历史命令', category: 'nav' },
    '历史下一条': { keys: 'Down', description: '下一条历史命令', category: 'nav' },
    'Tab补全': { keys: 'Tab', description: 'Tab 自动补全', category: 'edit' },
  },
  workflows: {
    '执行命令': {
      name: '执行命令',
      description: '在 PowerShell 中执行命令',
      steps: [
        { action: 'type', value: '{{command}}', description: '输入命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
  },
};

/** CMD 命令提示符 */
const CMD_PROFILE: ApplicationProfile = {
  id: 'cmd',
  name: '命令提示符 (CMD)',
  processNames: ['cmd.exe', 'cmd'],
  windowTitles: ['命令提示符', 'Command Prompt'],
  launchCommand: 'cmd',
  shortcuts: {
    '复制': { keys: 'Enter', description: '复制选中内容', category: 'edit' },
    '粘贴': { keys: 'RightClick', description: '右键粘贴', category: 'edit' },
    '中断': { keys: 'Ctrl+C', description: '中断当前命令', category: 'edit' },
    '历史上一条': { keys: 'Up', description: '上一条历史命令', category: 'nav' },
    '历史下一条': { keys: 'Down', description: '下一条历史命令', category: 'nav' },
    'Tab补全': { keys: 'Tab', description: 'Tab 自动补全', category: 'edit' },
  },
  workflows: {
    '执行命令': {
      name: '执行命令',
      description: '在 CMD 中执行命令',
      steps: [
        { action: 'type', value: '{{command}}', description: '输入命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
  },
};

/** Windows Terminal */
const WINDOWS_TERMINAL_PROFILE: ApplicationProfile = {
  id: 'windowsterminal',
  name: 'Windows Terminal',
  processNames: ['WindowsTerminal.exe', 'wt'],
  windowTitles: ['Windows Terminal', '终端'],
  launchCommand: 'wt',
  shortcuts: {
    '新标签': { keys: 'Ctrl+Shift+T', description: '新建标签页', category: 'tab' },
    '关闭标签': { keys: 'Ctrl+Shift+W', description: '关闭当前标签', category: 'tab' },
    '分屏水平': { keys: 'Alt+Shift+-', description: '水平分屏', category: 'view' },
    '分屏垂直': { keys: 'Alt+Shift++', description: '垂直分屏', category: 'view' },
    '复制': { keys: 'Ctrl+Shift+C', description: '复制', category: 'edit' },
    '粘贴': { keys: 'Ctrl+Shift+V', description: '粘贴', category: 'edit' },
    '清屏': { keys: 'Ctrl+L', description: '清屏', category: 'view' },
    '中断': { keys: 'Ctrl+C', description: '中断当前命令', category: 'edit' },
  },
  workflows: {
    '执行命令': {
      name: '执行命令',
      description: '在 Windows Terminal 中执行命令',
      steps: [
        { action: 'type', value: '{{command}}', description: '输入命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
  },
};

/** Microsoft Word */
const WORD_PROFILE: ApplicationProfile = {
  id: 'word',
  name: 'Microsoft Word',
  processNames: ['WINWORD.EXE', 'winword'],
  windowTitles: ['Word'],
  launchCommand: 'winword',
  shortcuts: {
    '新建': { keys: 'Ctrl+N', description: '新建文档', category: 'file' },
    '打开': { keys: 'Ctrl+O', description: '打开文档', category: 'file' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '另存为': { keys: 'F12', description: '另存为', category: 'file' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '重做': { keys: 'Ctrl+Y', description: '重做', category: 'edit' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'edit' },
    '替换': { keys: 'Ctrl+H', description: '替换', category: 'edit' },
    '全选': { keys: 'Ctrl+A', description: '全选', category: 'edit' },
    '加粗': { keys: 'Ctrl+B', description: '加粗', category: 'format' },
    '斜体': { keys: 'Ctrl+I', description: '斜体', category: 'format' },
    '下划线': { keys: 'Ctrl+U', description: '下划线', category: 'format' },
    '居中': { keys: 'Ctrl+E', description: '居中对齐', category: 'format' },
    '打印': { keys: 'Ctrl+P', description: '打印', category: 'file' },
  },
  workflows: {
    '新建文档': {
      name: '新建文档',
      description: '创建新 Word 文档',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建文档' },
        { action: 'wait', value: '1000', description: '等待窗口加载' },
      ],
      requiredParams: [],
    },
    '导出PDF': {
      name: '导出PDF',
      description: '导出为 PDF 文件',
      steps: [
        { action: 'menu', menuPath: ['File', 'Export', 'Create PDF/XPS'], description: '导出PDF' },
        { action: 'shortcut', value: 'Enter', description: '确认导出' },
      ],
      requiredParams: [],
    },
  },
};

/** Microsoft Excel */
const EXCEL_PROFILE: ApplicationProfile = {
  id: 'excel',
  name: 'Microsoft Excel',
  processNames: ['EXCEL.EXE', 'excel'],
  windowTitles: ['Excel'],
  launchCommand: 'excel',
  shortcuts: {
    '新建': { keys: 'Ctrl+N', description: '新建工作簿', category: 'file' },
    '打开': { keys: 'Ctrl+O', description: '打开工作簿', category: 'file' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '另存为': { keys: 'F12', description: '另存为', category: 'file' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '查找': { keys: 'Ctrl+F', description: '查找', category: 'edit' },
    '替换': { keys: 'Ctrl+H', description: '替换', category: 'edit' },
    '全选': { keys: 'Ctrl+A', description: '全选', category: 'edit' },
    '加粗': { keys: 'Ctrl+B', description: '加粗', category: 'format' },
    '求和': { keys: 'Alt+=', description: '自动求和', category: 'formula' },
    '打印': { keys: 'Ctrl+P', description: '打印', category: 'file' },
    '排序升序': { keys: 'Alt+A,SA', description: '升序排序', category: 'data' },
    '排序降序': { keys: 'Alt+A,SD', description: '降序排序', category: 'data' },
    '筛选': { keys: 'Alt+A,T', description: '切换筛选', category: 'data' },
    '插入行': { keys: 'Ctrl+Shift+=', description: '插入行/列', category: 'insert' },
    '删除行': { keys: 'Ctrl+-', description: '删除行/列', category: 'edit' },
    '单元格格式': { keys: 'Ctrl+1', description: '单元格格式对话框', category: 'format' },
    '插入图表': { keys: 'Alt+F1', description: '插入图表(默认柱状图)', category: 'chart' },
    '切换工作表': { keys: 'Ctrl+PageDown', description: '切换到下一工作表', category: 'nav' },
    '冻结窗格': { keys: 'Alt+W,F', description: '冻结窗格', category: 'view' },
  },
  workflows: {
    '新建工作簿': {
      name: '新建工作簿',
      description: '创建新 Excel 工作簿',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建工作簿' },
        { action: 'wait', value: '1000', description: '等待窗口加载' },
      ],
      requiredParams: [],
    },
    '导出PDF': {
      name: '导出PDF',
      description: '导出为 PDF 文件',
      steps: [
        { action: 'menu', menuPath: ['File', 'Export', 'Create PDF/XPS'], description: '导出PDF' },
        { action: 'shortcut', value: 'Enter', description: '确认导出' },
      ],
      requiredParams: [],
    },
    '输入数据到单元格': {
      name: '输入数据到单元格',
      description: '定位到指定单元格并输入数据。需要先用 Ctrl+G 跳转。',
      steps: [
        { action: 'shortcut', value: 'Ctrl+G', description: '打开定位对话框' },
        { action: 'type', value: '{{cellAddress}}', description: '输入单元格地址(如 A1/B5)' },
        { action: 'shortcut', value: 'Enter', description: '确认定位' },
        { action: 'wait', value: '200', description: '等待单元格激活' },
        { action: 'type', value: '{{value}}', description: '输入数据' },
        { action: 'shortcut', value: 'Enter', description: '确认输入' },
      ],
      requiredParams: ['cellAddress', 'value'],
    },
    '批量录入': {
      name: '批量录入',
      description: '从 JSON 数据批量录入到 Excel。每条记录按行录入，需要先用 LLM 生成录入序列。',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Home', description: '跳到 A1' },
        { action: 'type', value: '{{firstCell}}', description: '输入第一个单元格' },
        { action: 'shortcut', value: 'Tab', description: '切换到下一列' },
        { action: 'type', value: '{{secondCell}}', description: '输入第二个单元格' },
        { action: 'shortcut', value: 'Enter', description: '换行(下一行)' },
      ],
      requiredParams: ['firstCell', 'secondCell'],
    },
    '数据升序排序': {
      name: '数据升序排序',
      description: '对选中区域按升序排序',
      steps: [
        { action: 'shortcut', value: 'Alt+A,SA', description: '执行升序排序' },
        { action: 'wait', value: '500', description: '等待排序完成' },
      ],
      requiredParams: [],
    },
    '数据筛选': {
      name: '数据筛选',
      description: '为选中区域添加筛选器',
      steps: [
        { action: 'shortcut', value: 'Alt+A,T', description: '切换筛选' },
        { action: 'wait', value: '500', description: '等待筛选下拉出现' },
      ],
      requiredParams: [],
    },
    '插入柱状图': {
      name: '插入柱状图',
      description: '为选中数据插入柱状图',
      steps: [
        { action: 'shortcut', value: 'Alt+F1', description: '插入默认图表(柱状图)' },
        { action: 'wait', value: '800', description: '等待图表渲染' },
      ],
      requiredParams: [],
    },
    '插入饼图': {
      name: '插入饼图',
      description: '为选中数据插入饼图',
      steps: [
        { action: 'menu', menuPath: ['Insert', 'Pie Chart'], description: '打开插入饼图菜单' },
        { action: 'click', x: 0, y: 0, description: '点击饼图样式' },
        { action: 'wait', value: '800', description: '等待饼图渲染' },
      ],
      requiredParams: [],
    },
    '冻结首行': {
      name: '冻结首行',
      description: '冻结首行便于滚动浏览长表',
      steps: [
        { action: 'shortcut', value: 'Alt+W,F', description: '打开冻结窗格菜单' },
        { action: 'wait', value: '300', description: '等待菜单' },
        { action: 'type', value: 'F', description: '选择冻结首行(F)' },
      ],
      requiredParams: [],
    },
    '套用表格样式': {
      name: '套用表格样式',
      description: '为选中数据套用表格样式(快速美化)',
      steps: [
        { action: 'shortcut', value: 'Ctrl+T', description: '套用表格样式' },
        { action: 'shortcut', value: 'Enter', description: '确认默认样式' },
        { action: 'wait', value: '300', description: '等待样式应用' },
      ],
      requiredParams: [],
    },
    '条件格式高亮': {
      name: '条件格式高亮',
      description: '为选中区域添加条件格式高亮(色阶)',
      steps: [
        { action: 'menu', menuPath: ['Home', 'Conditional Formatting', 'Color Scales'], description: '打开条件格式色阶' },
        { action: 'click', x: 0, y: 0, description: '选择色阶样式' },
      ],
      requiredParams: [],
    },
  },
};

/** Microsoft Outlook */
const OUTLOOK_PROFILE: ApplicationProfile = {
  id: 'outlook',
  name: 'Microsoft Outlook',
  processNames: ['OUTLOOK.EXE', 'outlook'],
  windowTitles: ['Outlook'],
  launchCommand: 'outlook',
  shortcuts: {
    '新邮件': { keys: 'Ctrl+N', description: '新建邮件', category: 'mail' },
    '回复': { keys: 'Ctrl+R', description: '回复邮件', category: 'mail' },
    '全部回复': { keys: 'Ctrl+Shift+R', description: '全部回复', category: 'mail' },
    '转发': { keys: 'Ctrl+F', description: '转发邮件', category: 'mail' },
    '发送': { keys: 'Ctrl+Enter', description: '发送邮件', category: 'mail' },
    '保存': { keys: 'Ctrl+S', description: '保存', category: 'file' },
    '删除': { keys: 'Delete', description: '删除邮件', category: 'mail' },
    '查找': { keys: 'Ctrl+E', description: '查找邮件', category: 'nav' },
    '附加文件': { keys: 'Alt+N,A', description: '附加文件', category: 'attach' },
    '标记重要': { keys: 'Alt+H,1', description: '标记为重要', category: 'mail' },
    '日程视图': { keys: 'Ctrl+2', description: '切换到日历视图', category: 'nav' },
    '邮件视图': { keys: 'Ctrl+1', description: '切换到邮件视图', category: 'nav' },
    '新建约会': { keys: 'Ctrl+Shift+A', description: '新建约会/会议', category: 'calendar' },
    '标记跟进': { keys: 'Insert', description: '标记邮件需跟进', category: 'mail' },
  },
  workflows: {
    '新建邮件': {
      name: '新建邮件',
      description: '创建新邮件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建邮件' },
        { action: 'wait', value: '500', description: '等待窗口加载' },
      ],
      requiredParams: [],
    },
    '发送邮件': {
      name: '发送邮件',
      description: '发送当前编辑的邮件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Enter', description: '发送邮件' },
      ],
      requiredParams: [],
    },
    '撰写并发送邮件': {
      name: '撰写并发送邮件',
      description: '完整流程：新建邮件 → 输入收件人 → 主题 → 正文 → 发送。',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建邮件' },
        { action: 'wait', value: '600', description: '等待邮件窗口加载' },
        { action: 'type', value: '{{to}}', description: '输入收件人邮箱' },
        { action: 'shortcut', value: 'Tab', description: '切到抄送(可选)' },
        { action: 'shortcut', value: 'Tab', description: '切到主题' },
        { action: 'type', value: '{{subject}}', description: '输入邮件主题' },
        { action: 'shortcut', value: 'Tab', description: '切到正文' },
        { action: 'type', value: '{{body}}', description: '输入邮件正文' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '发送邮件' },
      ],
      requiredParams: ['to', 'subject', 'body'],
    },
    '回复邮件': {
      name: '回复邮件',
      description: '回复当前选中的邮件',
      steps: [
        { action: 'shortcut', value: 'Ctrl+R', description: '回复邮件' },
        { action: 'wait', value: '600', description: '等待回复窗口加载' },
        { action: 'shortcut', value: 'Tab', description: '跳到正文' },
        { action: 'type', value: '{{reply}}', description: '输入回复内容' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '发送回复' },
      ],
      requiredParams: ['reply'],
    },
    '全部回复': {
      name: '全部回复',
      description: '回复全部收件人',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Shift+R', description: '全部回复' },
        { action: 'wait', value: '600', description: '等待回复窗口加载' },
        { action: 'shortcut', value: 'Tab', description: '跳到正文' },
        { action: 'type', value: '{{reply}}', description: '输入回复内容' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '发送回复' },
      ],
      requiredParams: ['reply'],
    },
    '添加附件': {
      name: '添加附件',
      description: '为当前邮件添加附件',
      steps: [
        { action: 'shortcut', value: 'Alt+N,A', description: '打开附件对话框' },
        { action: 'wait', value: '500', description: '等待文件选择窗口' },
        { action: 'type', value: '{{filePath}}', description: '输入文件路径' },
        { action: 'shortcut', value: 'Enter', description: '确认选择附件' },
      ],
      requiredParams: ['filePath'],
    },
    '转发邮件': {
      name: '转发邮件',
      description: '转发当前邮件给指定收件人',
      steps: [
        { action: 'shortcut', value: 'Ctrl+F', description: '转发邮件' },
        { action: 'wait', value: '500', description: '等待转发窗口' },
        { action: 'type', value: '{{to}}', description: '输入转发收件人' },
        { action: 'shortcut', value: 'Tab', description: '跳到主题' },
        { action: 'shortcut', value: 'Tab', description: '跳到正文' },
        { action: 'type', value: '{{note}}', description: '输入转发备注(可选)' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '发送转发邮件' },
      ],
      requiredParams: ['to'],
    },
    '新建会议邀请': {
      name: '新建会议邀请',
      description: '创建会议邀请：切换到日历 → 新建会议 → 填写参会人/主题/时间',
      steps: [
        { action: 'shortcut', value: 'Ctrl+2', description: '切换到日历视图' },
        { action: 'wait', value: '500', description: '等待日历加载' },
        { action: 'shortcut', value: 'Ctrl+Shift+A', description: '新建约会' },
        { action: 'wait', value: '500', description: '等待会议窗口' },
        { action: 'type', value: '{{attendees}}', description: '输入参会人邮箱(分号分隔)' },
        { action: 'shortcut', value: 'Tab', description: '切到主题' },
        { action: 'type', value: '{{subject}}', description: '输入会议主题' },
        { action: 'shortcut', value: 'Tab', description: '切到地点' },
        { action: 'type', value: '{{location}}', description: '输入会议地点' },
        { action: 'shortcut', value: 'Tab', description: '切到正文' },
        { action: 'type', value: '{{body}}', description: '输入会议说明' },
        { action: 'shortcut', value: 'Ctrl+Enter', description: '发送会议邀请' },
      ],
      requiredParams: ['attendees', 'subject'],
    },
    '标记跟进': {
      name: '标记跟进',
      description: '为当前邮件标记需跟进(本周)',
      steps: [
        { action: 'shortcut', value: 'Insert', description: '标记为需跟进' },
        { action: 'wait', value: '300', description: '等待标记应用' },
      ],
      requiredParams: [],
    },
  },
};

/** 微信 */
const WECHAT_PROFILE: ApplicationProfile = {
  id: 'wechat',
  name: '微信',
  processNames: ['WeChat.exe', 'Weixin.exe', 'wechat'],
  windowTitles: ['微信', 'WeChat'],
  launchCommand: 'WeChat',
  shortcuts: {
    '搜索': { keys: 'Ctrl+F', description: '搜索联系人/聊天', category: 'nav' },
    '截图': { keys: 'Alt+A', description: '截图（微信内置）', category: 'tool' },
    '发送消息': { keys: 'Enter', description: '发送消息', category: 'msg' },
    '换行': { keys: 'Shift+Enter', description: '消息换行', category: 'msg' },
    '关闭聊天': { keys: 'Esc', description: '关闭当前聊天', category: 'nav' },
  },
  workflows: {
    '发送消息': {
      name: '发送消息',
      description: '向当前聊天发送消息',
      steps: [
        { action: 'type', value: '{{message}}', description: '输入消息内容' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['message'],
    },
    '搜索联系人': {
      name: '搜索联系人',
      description: '搜索并打开联系人聊天',
      steps: [
        { action: 'shortcut', value: 'Ctrl+F', description: '打开搜索' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人名称' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配' },
      ],
      requiredParams: ['contactName'],
    },
    '发送消息给联系人': {
      name: '发送消息给联系人',
      description: '完整流程：搜索联系人 → 打开聊天 → 输入消息 → 发送。适用于"给XX发消息"场景。',
      steps: [
        { action: 'shortcut', value: 'Ctrl+F', description: '打开微信搜索' },
        { action: 'wait', value: '500', description: '等待搜索框就绪' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人名称' },
        { action: 'wait', value: '800', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配的联系人聊天' },
        { action: 'wait', value: '800', description: '等待聊天窗口加载' },
        { action: 'type', value: '{{message}}', description: '输入消息内容' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['contactName', 'message'],
    },
    '发表朋友圈': {
      name: '发表朋友圈',
      description: '发表一条纯文本朋友圈（带可选图片描述）。进入朋友圈页面 → 长按相机图标 → 输入内容 → 发布。',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Alt+M', description: '打开朋友圈（部分微信版本可用），如无效请先手动打开朋友圈窗口' },
        { action: 'wait', value: '1200', description: '等待朋友圈窗口加载' },
        { action: 'click', x: 0, y: 0, description: '点击相机图标（长按）以打开纯文本发布界面' },
        { action: 'wait', value: '600', description: '等待发布对话框出现' },
        { action: 'type', value: '{{content}}', description: '输入朋友圈正文内容' },
        { action: 'wait', value: '400', description: '等待输入确认' },
        { action: 'shortcut', value: 'Enter', description: '点击"发表"按钮发布朋友圈' },
      ],
      requiredParams: ['content'],
    },
    '发送文件给联系人': {
      name: '发送文件给联系人',
      description: '搜索联系人 → 打开聊天 → 点击文件图标 → 粘贴文件路径 → 发送。',
      steps: [
        { action: 'shortcut', value: 'Ctrl+F', description: '打开微信搜索' },
        { action: 'wait', value: '500', description: '等待搜索框就绪' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人名称' },
        { action: 'wait', value: '800', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配的联系人聊天' },
        { action: 'wait', value: '800', description: '等待聊天窗口加载' },
        { action: 'type', value: '{{filePath}}', description: '粘贴文件路径（或直接通过文件拖拽工具发送文件）' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['contactName', 'filePath'],
    },
    '回复最近消息': {
      name: '回复最近消息',
      description: '向当前聊天窗口的对方回复消息（适用于已在对话中的快速回复）。',
      steps: [
        { action: 'wait', value: '300', description: '确认聊天窗口就绪' },
        { action: 'type', value: '{{message}}', description: '输入回复内容' },
        { action: 'shortcut', value: 'Enter', description: '发送回复' },
      ],
      requiredParams: ['message'],
    },
  },
};

/** 钉钉 */
const DINGTALK_PROFILE: ApplicationProfile = {
  id: 'dingtalk',
  name: '钉钉',
  processNames: ['DingTalk.exe', 'dingtalk'],
  windowTitles: ['钉钉', 'DingTalk'],
  launchCommand: 'DingTalk',
  shortcuts: {
    '搜索': { keys: 'Ctrl+F', description: '搜索', category: 'nav' },
    '截图': { keys: 'Ctrl+Shift+A', description: '截图', category: 'tool' },
    '发送消息': { keys: 'Enter', description: '发送消息', category: 'msg' },
    '换行': { keys: 'Shift+Enter', description: '消息换行', category: 'msg' },
    '关闭': { keys: 'Esc', description: '关闭当前窗口', category: 'nav' },
  },
  workflows: {
    '发送消息': {
      name: '发送消息',
      description: '向当前聊天发送消息',
      steps: [
        { action: 'type', value: '{{message}}', description: '输入消息内容' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['message'],
    },
    '搜索联系人': {
      name: '搜索联系人',
      description: '使用搜索功能找到联系人/群组',
      steps: [
        { action: 'shortcut', value: 'Ctrl+F', description: '打开钉钉搜索框' },
        { action: 'wait', value: '500', description: '等待搜索框就绪' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人/群组名称' },
        { action: 'wait', value: '800', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配的联系人' },
      ],
      requiredParams: ['contactName'],
    },
    '发送消息给联系人': {
      name: '发送消息给联系人',
      description: '完整流程：搜索联系人 → 打开聊天 → 输入消息 → 发送',
      steps: [
        { action: 'shortcut', value: 'Ctrl+F', description: '打开钉钉搜索框' },
        { action: 'wait', value: '500', description: '等待搜索框就绪' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人名称' },
        { action: 'wait', value: '800', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配的联系人聊天' },
        { action: 'wait', value: '800', description: '等待聊天窗口加载' },
        { action: 'type', value: '{{message}}', description: '输入消息内容' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['contactName', 'message'],
    },
    '发布DING公告': {
      name: '发布DING公告',
      description: '在钉钉中发送一个 DING 消息/公告（快捷入口）',
      steps: [
        { action: 'shortcut', value: 'Ctrl+N', description: '新建内容通用快捷键' },
        { action: 'wait', value: '600', description: '等待弹窗出现' },
        { action: 'type', value: '{{title}}', description: '输入公告标题' },
        { action: 'wait', value: '300', description: '等待确认' },
        { action: 'type', value: '{{content}}', description: '输入公告正文' },
        { action: 'shortcut', value: 'Enter', description: '发送公告' },
      ],
      requiredParams: ['title', 'content'],
    },
  },
};

/** 飞书 */
const FEISHU_PROFILE: ApplicationProfile = {
  id: 'feishu',
  name: '飞书',
  processNames: ['Feishu.exe', 'Lark.exe', 'feishu'],
  windowTitles: ['飞书', 'Lark'],
  launchCommand: 'Feishu',
  shortcuts: {
    '搜索': { keys: 'Ctrl+F', description: '搜索', category: 'nav' },
    '全局搜索': { keys: 'Ctrl+K', description: '全局快速搜索（联系人/消息/文档）', category: 'nav' },
    '截图': { keys: 'Ctrl+Shift+A', description: '截图', category: 'tool' },
    '发送消息': { keys: 'Enter', description: '发送消息', category: 'msg' },
    '换行': { keys: 'Shift+Enter', description: '消息换行', category: 'msg' },
    '关闭': { keys: 'Esc', description: '关闭当前窗口', category: 'nav' },
  },
  workflows: {
    '发送消息': {
      name: '发送消息',
      description: '向当前聊天发送消息',
      steps: [
        { action: 'type', value: '{{message}}', description: '输入消息内容' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['message'],
    },
    '搜索联系人': {
      name: '搜索联系人',
      description: '使用全局搜索找到联系人/群组',
      steps: [
        { action: 'shortcut', value: 'Ctrl+K', description: '打开飞书全局搜索' },
        { action: 'wait', value: '500', description: '等待搜索框就绪' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人/群组名称' },
        { action: 'wait', value: '800', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配的联系人' },
      ],
      requiredParams: ['contactName'],
    },
    '发送消息给联系人': {
      name: '发送消息给联系人',
      description: '完整流程：搜索联系人 → 打开聊天 → 输入消息 → 发送',
      steps: [
        { action: 'shortcut', value: 'Ctrl+K', description: '打开飞书全局搜索' },
        { action: 'wait', value: '500', description: '等待搜索框就绪' },
        { action: 'type', value: '{{contactName}}', description: '输入联系人名称' },
        { action: 'wait', value: '800', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '打开第一个匹配的联系人聊天' },
        { action: 'wait', value: '800', description: '等待聊天窗口加载' },
        { action: 'type', value: '{{message}}', description: '输入消息内容' },
        { action: 'shortcut', value: 'Enter', description: '发送消息' },
      ],
      requiredParams: ['contactName', 'message'],
    },
    '创建文档': {
      name: '创建文档',
      description: '在飞书文档中新建一个空白文档并写入标题',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Shift+N', description: '新建（若无效请先切换到文档模块）' },
        { action: 'wait', value: '800', description: '等待新文档窗口打开' },
        { action: 'type', value: '{{title}}', description: '输入文档标题' },
        { action: 'wait', value: '300', description: '等待保存' },
        { action: 'type', value: '{{content}}', description: '输入文档正文内容' },
      ],
      requiredParams: ['title', 'content'],
    },
  },
};

/** Figma 设计工具 */
const FIGMA_PROFILE: ApplicationProfile = {
  id: 'figma',
  name: 'Figma',
  processNames: ['Figma.exe', 'figma'],
  windowTitles: ['Figma'],
  launchCommand: 'figma',
  shortcuts: {
    '移动工具': { keys: 'V', description: '移动工具', category: 'tool' },
    '矩形工具': { keys: 'R', description: '矩形工具', category: 'tool' },
    '椭圆工具': { keys: 'O', description: '椭圆工具', category: 'tool' },
    '文字工具': { keys: 'T', description: '文字工具', category: 'tool' },
    '钢笔工具': { keys: 'P', description: '钢笔工具', category: 'tool' },
    '缩放': { keys: 'Z', description: '缩放工具', category: 'tool' },
    '编组': { keys: 'Ctrl+G', description: '编组', category: 'edit' },
    '取消编组': { keys: 'Ctrl+Shift+G', description: '取消编组', category: 'edit' },
    '复制': { keys: 'Ctrl+D', description: '复制选中', category: 'edit' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '放大': { keys: 'Ctrl+=', description: '放大', category: 'view' },
    '缩小': { keys: 'Ctrl+-', description: '缩小', category: 'view' },
  },
  workflows: {
    '新建矩形': {
      name: '新建矩形',
      description: '选择矩形工具并绘制',
      steps: [
        { action: 'shortcut', value: 'R', description: '选择矩形工具' },
        { action: 'click', x: 0, y: 0, description: '点击绘制位置' },
      ],
      requiredParams: ['x', 'y'],
    },
  },
};

/** VLC 媒体播放器 */
const VLC_PROFILE: ApplicationProfile = {
  id: 'vlc',
  name: 'VLC Media Player',
  processNames: ['vlc.exe', 'vlc'],
  windowTitles: ['VLC'],
  launchCommand: 'vlc',
  shortcuts: {
    '播放暂停': { keys: 'Space', description: '播放/暂停', category: 'playback' },
    '停止': { keys: 'S', description: '停止', category: 'playback' },
    '快进': { keys: 'Ctrl+Right', description: '快进', category: 'playback' },
    '快退': { keys: 'Ctrl+Left', description: '快退', category: 'playback' },
    '音量加': { keys: 'Ctrl+Up', description: '音量加', category: 'audio' },
    '音量减': { keys: 'Ctrl+Down', description: '音量减', category: 'audio' },
    '静音': { keys: 'M', description: '静音', category: 'audio' },
    '全屏': { keys: 'F', description: '全屏', category: 'view' },
    '下一个': { keys: 'N', description: '下一个媒体', category: 'playback' },
    '上一个': { keys: 'P', description: '上一个媒体', category: 'playback' },
  },
  workflows: {
    '打开文件': {
      name: '打开文件',
      description: '打开媒体文件',
      steps: [
        { action: 'menu', menuPath: ['Media', 'Open File'], description: '打开文件菜单' },
        { action: 'type', value: '{{filePath}}', description: '输入文件路径' },
        { action: 'shortcut', value: 'Enter', description: '确认打开' },
      ],
      requiredParams: ['filePath'],
    },
  },
};

/** Spotify 音乐播放器 */
const SPOTIFY_PROFILE: ApplicationProfile = {
  id: 'spotify',
  name: 'Spotify',
  processNames: ['Spotify.exe', 'spotify'],
  windowTitles: ['Spotify'],
  launchCommand: 'spotify',
  shortcuts: {
    '播放暂停': { keys: 'Space', description: '播放/暂停', category: 'playback' },
    '下一首': { keys: 'Ctrl+Right', description: '下一首', category: 'playback' },
    '上一首': { keys: 'Ctrl+Left', description: '上一首', category: 'playback' },
    '音量加': { keys: 'Ctrl+Up', description: '音量加', category: 'audio' },
    '音量减': { keys: 'Ctrl+Down', description: '音量减', category: 'audio' },
    '搜索': { keys: 'Ctrl+L', description: '聚焦搜索框', category: 'nav' },
    '新建播放列表': { keys: 'Ctrl+N', description: '新建播放列表', category: 'file' },
  },
  workflows: {
    '搜索播放': {
      name: '搜索播放',
      description: '搜索并播放歌曲',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '聚焦搜索框' },
        { action: 'type', value: '{{query}}', description: '输入搜索词' },
        { action: 'shortcut', value: 'Enter', description: '执行搜索' },
        { action: 'wait', value: '1000', description: '等待搜索结果' },
        { action: 'shortcut', value: 'Enter', description: '播放第一首' },
      ],
      requiredParams: ['query'],
    },
  },
};

/** Windows 文件资源管理器 */
const EXPLORER_PROFILE: ApplicationProfile = {
  id: 'explorer',
  name: '文件资源管理器',
  processNames: ['explorer.exe', 'explorer'],
  windowTitles: ['文件资源管理器', '资源管理器', 'Explorer'],
  launchCommand: 'explorer',
  shortcuts: {
    '地址栏': { keys: 'Ctrl+L', description: '聚焦地址栏', category: 'nav' },
    '新建文件夹': { keys: 'Ctrl+Shift+N', description: '新建文件夹', category: 'file' },
    '复制': { keys: 'Ctrl+C', description: '复制', category: 'edit' },
    '粘贴': { keys: 'Ctrl+V', description: '粘贴', category: 'edit' },
    '剪切': { keys: 'Ctrl+X', description: '剪切', category: 'edit' },
    '撤销': { keys: 'Ctrl+Z', description: '撤销', category: 'edit' },
    '删除': { keys: 'Delete', description: '删除', category: 'edit' },
    '重命名': { keys: 'F2', description: '重命名', category: 'edit' },
    '搜索': { keys: 'Ctrl+F', description: '搜索', category: 'nav' },
    '属性': { keys: 'Alt+Enter', description: '查看属性', category: 'file' },
  },
  workflows: {
    '打开路径': {
      name: '打开路径',
      description: '在地址栏输入路径并打开',
      steps: [
        { action: 'shortcut', value: 'Ctrl+L', description: '聚焦地址栏' },
        { action: 'type', value: '{{path}}', description: '输入路径' },
        { action: 'shortcut', value: 'Enter', description: '打开路径' },
      ],
      requiredParams: ['path'],
    },
    '新建文件夹': {
      name: '新建文件夹',
      description: '在当前位置新建文件夹',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Shift+N', description: '新建文件夹' },
        { action: 'type', value: '{{folderName}}', description: '输入文件夹名' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: ['folderName'],
    },
  },
};

/** 系统设置（注册表/服务/进程/窗口布局/快速操作） */
const SYSTEM_PROFILE: ApplicationProfile = {
  id: 'system',
  name: '系统设置与桌面操作（注册表/服务/进程/窗口布局/快速操作）',
  processNames: ['regedit.exe', 'services.msc', 'taskmgr.exe', 'SystemSettings.exe'],
  windowTitles: ['注册表编辑器', '服务', '任务管理器', '设置', 'Windows 设置'],
  launchCommand: 'explorer.exe ms-settings:',
  shortcuts: {
    // 系统快捷操作
    '任务管理器': { keys: 'Ctrl+Shift+Esc', description: '打开任务管理器', category: 'system' },
    '运行对话框': { keys: 'Win+R', description: '打开运行对话框', category: 'system' },
    '锁屏': { keys: 'Win+L', description: '锁定屏幕', category: 'system' },
    '显示桌面': { keys: 'Win+D', description: '最小化/还原所有窗口（显示桌面）', category: 'system' },
    '最小化所有窗口': { keys: 'Win+M', description: '最小化所有窗口（不可还原，用 Win+Shift+M 还原）', category: 'system' },
    '还原最小化窗口': { keys: 'Win+Shift+M', description: '还原被 Win+M 最小化的窗口', category: 'system' },
    '任务视图': { keys: 'Win+Tab', description: '打开任务视图（虚拟桌面切换）', category: 'system' },
    '切换应用': { keys: 'Alt+Tab', description: '在打开的应用间切换', category: 'system' },
    '关闭窗口': { keys: 'Alt+F4', description: '关闭当前窗口或弹出关机对话框', category: 'system' },
    '打开设置': { keys: 'Win+I', description: '打开 Windows 设置', category: 'system' },
    '打开搜索': { keys: 'Win+S', description: '打开搜索面板', category: 'system' },
    '打开通知中心': { keys: 'Win+A', description: '打开操作中心/通知面板', category: 'system' },
    '打开文件资源管理器': { keys: 'Win+E', description: '打开文件资源管理器', category: 'system' },
    '打开剪贴板历史': { keys: 'Win+V', description: '打开剪贴板历史（需先启用）', category: 'system' },
    '投影菜单': { keys: 'Win+P', description: '打开投影模式菜单（仅第二屏幕/扩展/复制）', category: 'system' },
    '游戏栏': { keys: 'Win+G', description: '打开游戏栏（录屏/截图）', category: 'system' },
    '快速截图': { keys: 'Win+Shift+S', description: '区域截图到剪贴板（截图工具）', category: 'system' },
    '全屏截图到文件': { keys: 'Win+PrtScn', description: '全屏截图保存到 图片/屏幕截图 目录', category: 'system' },
    '轻松使用': { keys: 'Win+U', description: '打开轻松使用设置中心', category: 'system' },
    '放大镜': { keys: 'Win++', description: '打开放大镜（缩放屏幕）', category: 'system' },
    // 窗口布局
    '最大化窗口': { keys: 'Win+Up', description: '最大化当前窗口', category: 'window' },
    '还原/最小化窗口': { keys: 'Win+Down', description: '还原最大化窗口或最小化', category: 'window' },
    '左分屏': { keys: 'Win+Left', description: '将窗口贴靠到左半屏', category: 'window' },
    '右分屏': { keys: 'Win+RIGHT', description: '将窗口贴靠到右半屏', category: 'window' },
    '左上四分屏': { keys: 'Win+LEFT;Win+UP', description: '窗口贴靠到左上象限', category: 'window' },
    '右上四分屏': { keys: 'Win+RIGHT;Win+UP', description: '窗口贴靠到右上象限', category: 'window' },
    '左下四分屏': { keys: 'Win+LEFT;Win+DOWN', description: '窗口贴靠到左下象限', category: 'window' },
    '右下四分屏': { keys: 'Win+RIGHT;Win+DOWN', description: '窗口贴靠到右下象限', category: 'window' },
    '切到左侧虚拟桌面': { keys: 'Win+Ctrl+LEFT', description: '切换到左侧虚拟桌面', category: 'window' },
    '切到右侧虚拟桌面': { keys: 'Win+Ctrl+RIGHT', description: '切换到右侧虚拟桌面', category: 'window' },
    '新建虚拟桌面': { keys: 'Win+Ctrl+D', description: '创建新的虚拟桌面', category: 'window' },
    '关闭虚拟桌面': { keys: 'Win+Ctrl+F4', description: '关闭当前虚拟桌面', category: 'window' },
  },
  workflows: {
    '打开注册表': {
      name: '打开注册表',
      description: '打开注册表编辑器',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'regedit', description: '输入 regedit' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开服务': {
      name: '打开服务',
      description: '打开服务管理器',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'services.msc', description: '输入 services.msc' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开任务管理器': {
      name: '打开任务管理器',
      description: '打开任务管理器',
      steps: [
        { action: 'shortcut', value: 'Ctrl+Shift+Esc', description: '打开任务管理器' },
      ],
      requiredParams: [],
    },
    // —— 窗口布局类 ——
    '左分屏': {
      name: '左分屏',
      description: '将当前活动窗口贴靠到屏幕左半屏（占 50% 宽度）',
      steps: [
        { action: 'shortcut', value: 'Win+LEFT', description: '左分屏' },
      ],
      requiredParams: [],
    },
    '右分屏': {
      name: '右分屏',
      description: '将当前活动窗口贴靠到屏幕右半屏（占 50% 宽度）',
      steps: [
        { action: 'shortcut', value: 'Win+RIGHT', description: '右分屏' },
      ],
      requiredParams: [],
    },
    '最大化窗口': {
      name: '最大化窗口',
      description: '最大化当前活动窗口',
      steps: [
        { action: 'shortcut', value: 'Win+UP', description: '最大化' },
      ],
      requiredParams: [],
    },
    '还原窗口': {
      name: '还原窗口',
      description: '将最大化的窗口还原为原大小',
      steps: [
        { action: 'shortcut', value: 'Win+DOWN', description: '还原窗口' },
      ],
      requiredParams: [],
    },
    '最小化所有窗口': {
      name: '最小化所有窗口',
      description: '最小化所有窗口并显示桌面（再按一次可还原）',
      steps: [
        { action: 'shortcut', value: 'Win+D', description: '显示桌面/还原' },
      ],
      requiredParams: [],
    },
    '切换虚拟桌面': {
      name: '切换虚拟桌面',
      description: '在虚拟桌面间切换。参数 direction 取值 left/right',
      steps: [
        { action: 'condition', value: '{{direction}}', description: '校验 direction 为 left/right' },
        { action: 'shortcut', value: 'Win+Ctrl+{{direction}}', description: '切换虚拟桌面' },
      ],
      requiredParams: ['direction'],
    },
    '新建虚拟桌面': {
      name: '新建虚拟桌面',
      description: '创建一个新的虚拟桌面',
      steps: [
        { action: 'shortcut', value: 'Win+Ctrl+D', description: '新建虚拟桌面' },
      ],
      requiredParams: [],
    },
    '关闭虚拟桌面': {
      name: '关闭虚拟桌面',
      description: '关闭当前虚拟桌面（所有窗口会移到上一个桌面）',
      steps: [
        { action: 'shortcut', value: 'Win+Ctrl+F4', description: '关闭虚拟桌面' },
      ],
      requiredParams: [],
    },
    '任务视图': {
      name: '任务视图',
      description: '打开任务视图，查看所有打开窗口与虚拟桌面',
      steps: [
        { action: 'shortcut', value: 'Win+Tab', description: '打开任务视图' },
      ],
      requiredParams: [],
    },
    // —— 系统设置类 ——
    '打开设置': {
      name: '打开设置',
      description: '打开 Windows 设置面板',
      steps: [
        { action: 'shortcut', value: 'Win+I', description: '打开设置' },
      ],
      requiredParams: [],
    },
    '打开设置子页': {
      name: '打开设置子页',
      description: '通过运行对话框直接跳转到指定设置子页（ms-settings:URI）。参数 page 取值如 display/sound/network-power/personalization-background',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'ms-settings:{{page}}', description: '输入 ms-settings URI' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: ['page'],
    },
    '锁屏': {
      name: '锁屏',
      description: '锁定工作站（需重新登录）',
      steps: [
        { action: 'shortcut', value: 'Win+L', description: '锁定屏幕' },
      ],
      requiredParams: [],
    },
    '打开通知中心': {
      name: '打开通知中心',
      description: '打开操作中心，查看通知与快速操作磁贴',
      steps: [
        { action: 'shortcut', value: 'Win+A', description: '打开通知中心' },
      ],
      requiredParams: [],
    },
    '打开剪贴板历史': {
      name: '打开剪贴板历史',
      description: '打开剪贴板历史面板（需先在设置中启用）',
      steps: [
        { action: 'shortcut', value: 'Win+V', description: '打开剪贴板历史' },
      ],
      requiredParams: [],
    },
    '打开文件资源管理器': {
      name: '打开文件资源管理器',
      description: '打开文件资源管理器',
      steps: [
        { action: 'shortcut', value: 'Win+E', description: '打开文件资源管理器' },
      ],
      requiredParams: [],
    },
    '打开搜索': {
      name: '打开搜索',
      description: '打开 Windows 搜索面板',
      steps: [
        { action: 'shortcut', value: 'Win+S', description: '打开搜索' },
      ],
      requiredParams: [],
    },
    '投影模式菜单': {
      name: '投影模式菜单',
      description: '打开投影菜单（仅电脑屏幕/复制/扩展/仅第二屏幕）',
      steps: [
        { action: 'shortcut', value: 'Win+P', description: '打开投影菜单' },
      ],
      requiredParams: [],
    },
    // —— 截图与多媒体 ——
    '区域截图': {
      name: '区域截图',
      description: '启动截图工具进行区域截图，结果保存到剪贴板',
      steps: [
        { action: 'shortcut', value: 'Win+Shift+S', description: '启动截图工具' },
      ],
      requiredParams: [],
    },
    '全屏截图到文件': {
      name: '全屏截图到文件',
      description: '截取整个屏幕并保存到 图片/屏幕截图 目录',
      steps: [
        { action: 'shortcut', value: 'Win+PrtScn', description: '全屏截图到文件' },
      ],
      requiredParams: [],
    },
    // —— 通过运行对话框快速启动 ——
    '运行命令': {
      name: '运行命令',
      description: '通过 Win+R 运行对话框执行命令。参数 command 为要运行的命令（如 notepad/calc/cmd/control）',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: '{{command}}', description: '输入命令' },
        { action: 'shortcut', value: 'Enter', description: '运行' },
      ],
      requiredParams: ['command'],
    },
    '打开控制面板': {
      name: '打开控制面板',
      description: '通过运行对话框打开传统控制面板',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'control', description: '输入 control' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开计算机管理': {
      name: '打开计算机管理',
      description: '打开计算机管理（包含事件查看器/性能/设备管理器/磁盘管理）',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'compmgmt.msc', description: '输入 compmgmt.msc' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开磁盘管理': {
      name: '打开磁盘管理',
      description: '打开磁盘管理控制台',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'diskmgmt.msc', description: '输入 diskmgmt.msc' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开设备管理器': {
      name: '打开设备管理器',
      description: '打开设备管理器查看硬件设备',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'devmgmt.msc', description: '输入 devmgmt.msc' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开事件查看器': {
      name: '打开事件查看器',
      description: '打开事件查看器查看系统日志',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'eventvwr.msc', description: '输入 eventvwr.msc' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开性能监视器': {
      name: '打开性能监视器',
      description: '打开性能监视器（perfmon）',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'perfmon', description: '输入 perfmon' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开电源选项': {
      name: '打开电源选项',
      description: '通过运行对话框打开电源选项',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'powercfg.cpl', description: '输入 powercfg.cpl' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开网络连接': {
      name: '打开网络连接',
      description: '打开网络连接面板（查看/编辑适配器）',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'ncpa.cpl', description: '输入 ncpa.cpl' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
    '打开程序和功能': {
      name: '打开程序和功能',
      description: '打开程序和功能（卸载/更改程序）',
      steps: [
        { action: 'shortcut', value: 'Win+R', description: '打开运行' },
        { action: 'type', value: 'appwiz.cpl', description: '输入 appwiz.cpl' },
        { action: 'shortcut', value: 'Enter', description: '确认' },
      ],
      requiredParams: [],
    },
  },
};

/** Git 版本控制 */
const GIT_PROFILE: ApplicationProfile = {
  id: 'git',
  name: 'Git 版本控制',
  processNames: ['git'],
  windowTitles: ['Git'],
  launchCommand: 'git',
  shortcuts: {},
  workflows: {
    '执行Git命令': {
      name: '执行Git命令',
      description: '在终端中执行任意 Git 命令。参数 command 为 git 后的子命令及参数（如 "log --oneline -10"）',
      steps: [
        { action: 'type', value: 'git {{command}}', description: '输入 git 命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
    '克隆仓库': {
      name: '克隆仓库',
      description: '克隆远程仓库到本地。参数 url 为仓库地址',
      steps: [
        { action: 'type', value: 'git clone {{url}}', description: '输入克隆命令' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['url'],
    },
    '提交更改': {
      name: '提交更改',
      description: '暂存所有更改并提交。参数 message 为提交信息',
      steps: [
        { action: 'type', value: 'git add .', description: '暂存所有更改' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
        { action: 'type', value: 'git commit -m "{{message}}"', description: '提交' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['message'],
    },
    '推送': {
      name: '推送',
      description: '推送本地提交到远程仓库',
      steps: [
        { action: 'type', value: 'git push', description: '推送' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '拉取': {
      name: '拉取',
      description: '拉取远程更新并合并到当前分支',
      steps: [
        { action: 'type', value: 'git pull', description: '拉取' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '查看状态': {
      name: '查看状态',
      description: '查看工作区状态（修改/暂存/未跟踪文件）',
      steps: [
        { action: 'type', value: 'git status', description: '查看状态' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '查看日志': {
      name: '查看日志',
      description: '查看最近 10 条提交日志（单行简洁模式）',
      steps: [
        { action: 'type', value: 'git log --oneline -10', description: '查看日志' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '切换分支': {
      name: '切换分支',
      description: '切换到指定分支。参数 branch 为目标分支名',
      steps: [
        { action: 'type', value: 'git checkout {{branch}}', description: '切换分支' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['branch'],
    },
    '新建分支': {
      name: '新建分支',
      description: '基于当前分支创建并切换到新分支。参数 branch 为新分支名',
      steps: [
        { action: 'type', value: 'git checkout -b {{branch}}', description: '新建并切换分支' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['branch'],
    },
    '合并分支': {
      name: '合并分支',
      description: '将指定分支合并到当前分支。参数 branch 为要合并的分支名',
      steps: [
        { action: 'type', value: 'git merge {{branch}}', description: '合并分支' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['branch'],
    },
    '查看差异': {
      name: '查看差异',
      description: '查看未暂存的修改内容',
      steps: [
        { action: 'type', value: 'git diff', description: '查看差异' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '撤销未暂存更改': {
      name: '撤销未暂存更改',
      description: '丢弃所有未暂存的修改（不可逆，谨慎使用）',
      steps: [
        { action: 'type', value: 'git checkout -- .', description: '撤销更改' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '查看远程': {
      name: '查看远程',
      description: '查看已配置的远程仓库列表',
      steps: [
        { action: 'type', value: 'git remote -v', description: '查看远程' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '查看分支列表': {
      name: '查看分支列表',
      description: '查看所有本地和远程分支',
      steps: [
        { action: 'type', value: 'git branch -a', description: '查看分支' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '暂存文件': {
      name: '暂存文件',
      description: '暂存指定文件。参数 file 为文件路径（多个用空格分隔）',
      steps: [
        { action: 'type', value: 'git add {{file}}', description: '暂存文件' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['file'],
    },
    '储藏更改': {
      name: '储藏更改',
      description: '将当前未提交的更改储藏起来（切分支前常用）',
      steps: [
        { action: 'type', value: 'git stash', description: '储藏更改' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '恢复储藏': {
      name: '恢复储藏',
      description: '恢复最近一次储藏的更改',
      steps: [
        { action: 'type', value: 'git stash pop', description: '恢复储藏' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
  },
};

/** Docker 容器 */
const DOCKER_PROFILE: ApplicationProfile = {
  id: 'docker',
  name: 'Docker 容器',
  processNames: ['Docker Desktop.exe', 'docker'],
  windowTitles: ['Docker Desktop'],
  launchCommand: 'docker',
  shortcuts: {},
  workflows: {
    '执行Docker命令': {
      name: '执行Docker命令',
      description: '在终端中执行任意 Docker 命令。参数 command 为 docker 后的子命令及参数',
      steps: [
        { action: 'type', value: 'docker {{command}}', description: '输入 docker 命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
    '列出容器': {
      name: '列出容器',
      description: '列出所有容器（包括已停止的）',
      steps: [
        { action: 'type', value: 'docker ps -a', description: '列出容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '列出镜像': {
      name: '列出镜像',
      description: '列出本地所有 Docker 镜像',
      steps: [
        { action: 'type', value: 'docker images', description: '列出镜像' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '启动容器': {
      name: '启动容器',
      description: '启动已停止的容器。参数 container 为容器名或ID',
      steps: [
        { action: 'type', value: 'docker start {{container}}', description: '启动容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['container'],
    },
    '停止容器': {
      name: '停止容器',
      description: '停止运行中的容器。参数 container 为容器名或ID',
      steps: [
        { action: 'type', value: 'docker stop {{container}}', description: '停止容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['container'],
    },
    '重启容器': {
      name: '重启容器',
      description: '重启指定容器。参数 container 为容器名或ID',
      steps: [
        { action: 'type', value: 'docker restart {{container}}', description: '重启容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['container'],
    },
    '查看容器日志': {
      name: '查看容器日志',
      description: '查看容器最近 100 行日志。参数 container 为容器名或ID',
      steps: [
        { action: 'type', value: 'docker logs --tail 100 {{container}}', description: '查看日志' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['container'],
    },
    '进入容器': {
      name: '进入容器',
      description: '在容器内启动交互式 shell。参数 container 为容器名或ID，shell 为 sh/bash（默认 bash）',
      steps: [
        { action: 'type', value: 'docker exec -it {{container}} {{shell}}', description: '进入容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['container', 'shell'],
    },
    '删除容器': {
      name: '删除容器',
      description: '删除指定容器（必须先停止）。参数 container 为容器名或ID',
      steps: [
        { action: 'type', value: 'docker rm {{container}}', description: '删除容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['container'],
    },
    '删除镜像': {
      name: '删除镜像',
      description: '删除指定镜像。参数 image 为镜像名或ID',
      steps: [
        { action: 'type', value: 'docker rmi {{image}}', description: '删除镜像' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['image'],
    },
    '构建镜像': {
      name: '构建镜像',
      description: '根据 Dockerfile 构建镜像。参数 tag 为镜像标签，path 为构建上下文路径',
      steps: [
        { action: 'type', value: 'docker build -t {{tag}} {{path}}', description: '构建镜像' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['tag', 'path'],
    },
    '拉取镜像': {
      name: '拉取镜像',
      description: '从仓库拉取镜像。参数 image 为镜像名（含 tag，如 nginx:latest）',
      steps: [
        { action: 'type', value: 'docker pull {{image}}', description: '拉取镜像' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['image'],
    },
    '推送镜像': {
      name: '推送镜像',
      description: '推送镜像到仓库。参数 image 为镜像名（含 tag）',
      steps: [
        { action: 'type', value: 'docker push {{image}}', description: '推送镜像' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['image'],
    },
    '查看资源占用': {
      name: '查看资源占用',
      description: '查看所有运行中容器的 CPU/内存/网络 IO 资源占用（单次快照）',
      steps: [
        { action: 'type', value: 'docker stats --no-stream', description: '查看资源占用' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '清理悬空资源': {
      name: '清理悬空资源',
      description: '清理未使用的镜像/容器/网络/缓存（强制模式，无需确认）',
      steps: [
        { action: 'type', value: 'docker system prune -f', description: '清理资源' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '运行容器': {
      name: '运行容器',
      description: '后台运行容器并映射端口。参数 image 为镜像名，ports 为端口映射（如 8080:80），name 为容器名',
      steps: [
        { action: 'type', value: 'docker run -d --name {{name}} -p {{ports}} {{image}}', description: '运行容器' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['name', 'ports', 'image'],
    },
  },
};

/** Node.js 运行时 */
const NODEJS_PROFILE: ApplicationProfile = {
  id: 'nodejs',
  name: 'Node.js 运行时',
  processNames: ['node.exe', 'node'],
  windowTitles: ['Node'],
  launchCommand: 'node',
  shortcuts: {},
  workflows: {
    '执行Node命令': {
      name: '执行Node命令',
      description: '在终端中执行 Node.js 命令。参数 command 为 node 后的参数',
      steps: [
        { action: 'type', value: 'node {{command}}', description: '输入 node 命令' },
        { action: 'shortcut', value: 'Enter', description: '执行命令' },
      ],
      requiredParams: ['command'],
    },
    '执行npm命令': {
      name: '执行npm命令',
      description: '执行任意 npm 命令。参数 command 为 npm 后的子命令及参数',
      steps: [
        { action: 'type', value: 'npm {{command}}', description: '输入 npm 命令' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['command'],
    },
    '安装依赖': {
      name: '安装依赖',
      description: '根据 package.json 安装所有依赖',
      steps: [
        { action: 'type', value: 'npm install', description: '安装依赖' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '安装包': {
      name: '安装包',
      description: '安装指定 npm 包。参数 package 为包名（可含版本号，如 lodash@4.17.21）',
      steps: [
        { action: 'type', value: 'npm install {{package}}', description: '安装包' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['package'],
    },
    '全局安装包': {
      name: '全局安装包',
      description: '全局安装 npm 包（添加到 PATH）。参数 package 为包名',
      steps: [
        { action: 'type', value: 'npm install -g {{package}}', description: '全局安装' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['package'],
    },
    '卸载包': {
      name: '卸载包',
      description: '卸载指定的 npm 包。参数 package 为包名',
      steps: [
        { action: 'type', value: 'npm uninstall {{package}}', description: '卸载包' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['package'],
    },
    '运行脚本': {
      name: '运行脚本',
      description: '运行 package.json 中定义的脚本。参数 script 为脚本名（如 start/build/test）',
      steps: [
        { action: 'type', value: 'npm run {{script}}', description: '运行脚本' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['script'],
    },
    '初始化项目': {
      name: '初始化项目',
      description: '使用默认值快速创建 package.json',
      steps: [
        { action: 'type', value: 'npm init -y', description: '初始化项目' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '查看已安装包': {
      name: '查看已安装包',
      description: '查看当前项目已安装的依赖（仅顶层）',
      steps: [
        { action: 'type', value: 'npm list --depth=0', description: '查看已安装' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '检查过期包': {
      name: '检查过期包',
      description: '检查哪些依赖有新版本可更新',
      steps: [
        { action: 'type', value: 'npm outdated', description: '检查过期包' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '更新依赖': {
      name: '更新依赖',
      description: '更新所有依赖到符合 semver 约束的最新版本',
      steps: [
        { action: 'type', value: 'npm update', description: '更新依赖' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '执行npx命令': {
      name: '执行npx命令',
      description: '通过 npx 执行命令（无需全局安装）。参数 command 为要执行的命令',
      steps: [
        { action: 'type', value: 'npx {{command}}', description: '执行 npx 命令' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['command'],
    },
    '执行脚本文件': {
      name: '执行脚本文件',
      description: '运行指定 JavaScript 文件。参数 file 为文件路径',
      steps: [
        { action: 'type', value: 'node {{file}}', description: '运行脚本' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: ['file'],
    },
    '查看Node版本': {
      name: '查看Node版本',
      description: '查看当前安装的 Node.js 版本',
      steps: [
        { action: 'type', value: 'node --version', description: '查看版本' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
    '查看npm版本': {
      name: '查看npm版本',
      description: '查看当前安装的 npm 版本',
      steps: [
        { action: 'type', value: 'npm --version', description: '查看版本' },
        { action: 'shortcut', value: 'Enter', description: '执行' },
      ],
      requiredParams: [],
    },
  },
};

// ============ 自然语言操作映射 ============

const OPERATION_MAPPINGS: Record<string, { keys?: string; action: string; category: string }> = {
  '新建': { keys: 'Ctrl+N', action: 'new', category: 'file' },
  '创建': { keys: 'Ctrl+N', action: 'new', category: 'file' },
  '打开': { keys: 'Ctrl+O', action: 'open', category: 'file' },
  '保存': { keys: 'Ctrl+S', action: 'save', category: 'file' },
  '另存为': { keys: 'Ctrl+Shift+S', action: 'saveAs', category: 'file' },
  '撤销': { keys: 'Ctrl+Z', action: 'undo', category: 'edit' },
  '重做': { keys: 'Ctrl+Shift+Z', action: 'redo', category: 'edit' },
  '复制': { keys: 'Ctrl+C', action: 'copy', category: 'edit' },
  '粘贴': { keys: 'Ctrl+V', action: 'paste', category: 'edit' },
  '剪切': { keys: 'Ctrl+X', action: 'cut', category: 'edit' },
  '全选': { keys: 'Ctrl+A', action: 'selectAll', category: 'edit' },
  '查找': { keys: 'Ctrl+F', action: 'find', category: 'edit' },
  '搜索': { keys: 'Ctrl+F', action: 'search', category: 'edit' },
  '替换': { keys: 'Ctrl+H', action: 'replace', category: 'edit' },
  '放大': { keys: 'Ctrl+=', action: 'zoomIn', category: 'view' },
  '缩小': { keys: 'Ctrl+-', action: 'zoomOut', category: 'view' },
  '导出': { action: 'export', category: 'file' },
  '插入文字': { action: 'insertText', category: 'insert' },
  '插入文本': { action: 'insertText', category: 'insert' },
  '插入图片': { action: 'insertImage', category: 'insert' },
  '调整颜色': { action: 'adjustColor', category: 'adjust' },
  '调整亮度': { action: 'adjustBrightness', category: 'adjust' },
  '调整对比度': { action: 'adjustContrast', category: 'adjust' },
  '添加动画': { action: 'addAnimation', category: 'effect' },
  '添加效果': { action: 'addEffect', category: 'effect' },
};

// ============ 主类 ============

export class UniversalDesktop {
  private log = logger.child({ module: 'UniversalDesktop' });
  private desktop: DesktopControl;
  private profiles: Map<string, ApplicationProfile> = new Map();
  private platform: string;
  private lastActionTime: number = 0;
  private readonly MIN_ACTION_INTERVAL = 200;   // 最小操作间隔 200ms
  private readonly DEFAULT_STEP_DELAY = 300;     // 工作流步骤间默认等待 300ms
  // 统一操作接口默认参数
  private readonly DEFAULT_OPERATION_TIMEOUT = 5000;  // 默认操作超时 5 秒
  private readonly DEFAULT_OPERATION_RETRY = 3;       // 默认失败重试 3 次
  private readonly HANDLE_CACHE_TTL = 30000;          // 窗口句柄缓存有效期 30 秒

  // 窗口句柄缓存：appId -> { handle, expireAt }
  private windowHandleCache: Map<string, { handle: string; expireAt: number }> = new Map();

  private stats: UniversalDesktopStats = {
    totalLaunches: 0,
    totalShortcuts: 0,
    totalWorkflows: 0,
    totalSmartOps: 0,
    totalMenuNavs: 0,
    totalFindClicks: 0,
    errors: 0,
    lastActionTime: null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.desktop = new DesktopControl(modelLibrary);
    this.platform = os.platform();
    this.registerBuiltInProfiles();
    this.log.info('通用桌面自动化框架初始化', { platform: this.platform, profileCount: this.profiles.size });
  }

  // ============ 应用配置管理 ============

  /** 注册内置应用配置（共 24 类主流应用） */
  private registerBuiltInProfiles(): void {
    // 原有 4 类
    this.registerApp(PHOTOSHOP_PROFILE);
    this.registerApp(POWERPOINT_PROFILE);
    this.registerApp(VSCODE_PROFILE);
    this.registerApp(BROWSER_PROFILE);
    // 新增 20 类
    this.registerApp(FIREFOX_PROFILE);
    this.registerApp(NOTEPADPP_PROFILE);
    this.registerApp(SUBLIME_PROFILE);
    this.registerApp(POWERSHELL_PROFILE);
    this.registerApp(CMD_PROFILE);
    this.registerApp(WINDOWS_TERMINAL_PROFILE);
    this.registerApp(WORD_PROFILE);
    this.registerApp(EXCEL_PROFILE);
    this.registerApp(OUTLOOK_PROFILE);
    this.registerApp(WECHAT_PROFILE);
    this.registerApp(DINGTALK_PROFILE);
    this.registerApp(FEISHU_PROFILE);
    this.registerApp(FIGMA_PROFILE);
    this.registerApp(VLC_PROFILE);
    this.registerApp(SPOTIFY_PROFILE);
    this.registerApp(EXPLORER_PROFILE);
    this.registerApp(SYSTEM_PROFILE);
    this.registerApp(GIT_PROFILE);
    this.registerApp(DOCKER_PROFILE);
    this.registerApp(NODEJS_PROFILE);
  }

  /** 注册新的应用配置 */
  registerApp(profile: ApplicationProfile): void {
    this.profiles.set(profile.id, profile);
    this.log.info('注册应用配置', { appId: profile.id, name: profile.name });
    this.emitEvent('profile_registered', { appId: profile.id, name: profile.name });
  }

  /** 获取应用配置 */
  getAppProfile(appId: string): ApplicationProfile | undefined {
    return this.profiles.get(appId);
  }

  /** 列出所有已注册应用 */
  listApps(): Array<{ id: string; name: string; shortcutCount: number; workflowCount: number }> {
    return Array.from(this.profiles.values()).map(p => ({
      id: p.id,
      name: p.name,
      shortcutCount: Object.keys(p.shortcuts).length,
      workflowCount: Object.keys(p.workflows).length,
    }));
  }

  // ============ 窗口句柄缓存（响应时间优化） ============

  /** 获取应用窗口句柄（带缓存） */
  private getCachedWindowHandle(appId: string): string | null {
    const cached = this.windowHandleCache.get(appId);
    if (cached && cached.expireAt > Date.now()) {
      return cached.handle;
    }
    // 缓存失效，清理
    if (cached) {
      this.windowHandleCache.delete(appId);
    }
    return null;
  }

  /** 写入窗口句柄缓存 */
  private setCachedWindowHandle(appId: string, handle: string): void {
    this.windowHandleCache.set(appId, {
      handle,
      expireAt: Date.now() + this.HANDLE_CACHE_TTL,
    });
  }

  /** 使指定应用的窗口句柄缓存失效 */
  invalidateWindowHandleCache(appId: string): void {
    this.windowHandleCache.delete(appId);
  }

  /** 清空所有窗口句柄缓存 */
  clearWindowHandleCache(): void {
    this.windowHandleCache.clear();
  }

  // ============ 操作成功率优化：前置验证 / 后置验证 / 重试 / 超时 ============

  /**
   * 前置验证：检查目标应用是否运行
   * @returns true 表示通过验证
   */
  private async validateOperation(appId: string, action: string): Promise<{ ok: boolean; reason?: string }> {
    const profile = this.profiles.get(appId);
    if (!profile) {
      return { ok: false, reason: `未注册的应用: ${appId}` };
    }
    // launch/activate/list_actions 操作无需检查运行状态
    // launch/activate 本身就是要启动/激活；list_actions 是只读查询（列出可用 workflow/shortcut）
    if (action === 'launch' || action === 'activate' || action === 'list_actions') {
      return { ok: true };
    }
    // 其他操作需要应用处于运行状态
    const running = await this.isAppRunning(appId);
    if (!running) {
      // 自动尝试启动应用
      this.log.info('应用未运行，尝试自动启动', { appId, action });
      try {
        await this.launchApp(appId);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const runningNow = await this.isAppRunning(appId);
        if (!runningNow) {
          return { ok: false, reason: `应用 ${profile.name} 未运行且自动启动失败` };
        }
      } catch (err: unknown) {
        return { ok: false, reason: `应用 ${profile.name} 启动失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { ok: true };
  }

  /**
   * 后置验证：检查操作执行结果
   * 通过返回内容是否包含成功标记来判断
   */
  private verifyOperation(result: string): boolean {
    if (!result) return false;
    // 错误标记优先：含 ❌ 一律视为未通过验证（防止 "✅ 已启动应用\n❌ 应用启动失败" 这类包装错误被误判）
    if (result.includes('❌')) return false;
    // 必须显式包含成功标记（移除过于宽松的 includes('已') —— "已失败" 也含 "已"）
    return result.includes('✅') || result.includes('成功');
  }

  /**
   * 带超时执行异步操作
   * @param task 异步任务
   * @param timeoutMs 超时时间
   */
  private async runWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) return task;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
    });
    try {
      return await Promise.race([task, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 带重试执行异步操作
   * @param taskFactory 任务工厂（每次重试重新构造）
   * @param retryCount 重试次数
   * @param timeoutMs 单次超时
   */
  private async runWithRetry<T>(
    taskFactory: () => Promise<T>,
    retryCount: number,
    timeoutMs: number,
  ): Promise<{ value: T; attempts: number; lastError?: string }> {
    let lastError: string | undefined;
    const maxAttempts = Math.max(1, retryCount + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const value = await this.runWithTimeout(taskFactory(), timeoutMs);
        return { value, attempts: attempt };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log.warn('操作失败，准备重试', { attempt, maxAttempts, error: lastError });
        if (attempt < maxAttempts) {
          // 指数退避：200ms, 400ms, 800ms...
          const backoff = 200 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }
    throw new Error(`重试 ${maxAttempts} 次后仍失败: ${lastError}`);
  }

  // ============ 统一操作接口 ============

  /**
   * 执行统一应用操作
   * 所有应用控制操作均通过此接口发起，自动处理前置验证、超时、重试、后置验证
   */
  async executeOperation(op: AppOperation): Promise<AppOperationResult> {
    const startTime = Date.now();
    const timeout = op.timeout ?? this.DEFAULT_OPERATION_TIMEOUT;
    const retry = op.retry ?? this.DEFAULT_OPERATION_RETRY;

    this.log.info('执行统一操作', { app: op.app, action: op.action, timeout, retry });
    this.emitEvent('operation_started', { app: op.app, action: op.action });

    // 前置验证
    const validation = await this.validateOperation(op.app, op.action);
    if (!validation.ok) {
      this.stats.errors++;
      return {
        success: false,
        app: op.app,
        action: op.action,
        attempts: 0,
        duration: Date.now() - startTime,
        result: '',
        verified: false,
        error: validation.reason,
      };
    }

    // 构造任务工厂（每次重试重新执行）
    const taskFactory = (): Promise<string> => this.dispatchOperation(op);

    try {
      const { value, attempts } = await this.runWithRetry(taskFactory, retry, timeout);
      const verified = this.verifyOperation(value);
      // 关键修复（防御深度）：dispatchOperation 返回的字符串可能以 ❌ 开头表示失败
      // （如 '❌ 不支持的操作类型'、'❌ 应用启动失败'），runWithRetry 不会 throw 这些字符串
      // 必须在此检测错误标记，否则 agent 会收到 success:true 的假成功结果
      const isErrorMessage = typeof value === 'string' && value.includes('❌');
      this.emitEvent('operation_completed', {
        app: op.app,
        action: op.action,
        attempts,
        duration: Date.now() - startTime,
        verified,
      });
      if (isErrorMessage) {
        this.stats.errors++;
        this.log.warn('操作返回错误标记', { app: op.app, action: op.action, result: value });
        return {
          success: false,
          app: op.app,
          action: op.action,
          attempts,
          duration: Date.now() - startTime,
          result: value,
          verified: false,
          error: value,
        };
      }
      return {
        success: true,
        app: op.app,
        action: op.action,
        attempts,
        duration: Date.now() - startTime,
        result: value,
        verified,
      };
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('统一操作失败', { app: op.app, action: op.action, error: err instanceof Error ? err.message : String(err) });
      return {
        success: false,
        app: op.app,
        action: op.action,
        attempts: retry + 1,
        duration: Date.now() - startTime,
        result: '',
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 分发操作到具体实现（内部方法）
   * 根据 action 类型路由到对应的方法
   */
  private async dispatchOperation(op: AppOperation): Promise<string> {
    switch (op.action) {
      case 'launch':
        return this.launchApp(op.app);
      case 'activate':
        return this.activateApp(op.app);
      case 'shortcut': {
        const shortcutName = String(op.params?.shortcutName ?? op.params ?? '');
        return this.executeShortcut(op.app, shortcutName);
      }
      case 'workflow': {
        const workflowName = String(op.params?.workflowName ?? op.params ?? '');
        const workflowParams = op.params?.params || {};
        const result = await this.executeWorkflow(op.app, workflowName, workflowParams);
        return result.success
          ? `✅ 工作流 "${workflowName}" 执行成功，完成 ${result.stepsCompleted}/${result.stepsTotal} 步`
          : `❌ 工作流 "${workflowName}" 执行失败: ${result.error}`;
      }
      case 'menu': {
        const menuPath = Array.isArray(op.params?.menuPath) ? op.params.menuPath : (op.params ?? []);
        return this.executeMenuPath(op.app, menuPath);
      }
      case 'type': {
        const text = String(op.params?.text ?? op.params ?? '');
        return this.typeInApp(op.app, text);
      }
      case 'click': {
        const x = Number(op.params?.x ?? 0);
        const y = Number(op.params?.y ?? 0);
        return this.clickInApp(op.app, x, y);
      }
      case 'find_click': {
        const description = String(op.params?.description ?? op.params ?? '');
        return this.findAndClick(op.app, description);
      }
      case 'list_actions': {
        // 发现式操作：返回该应用可用的 workflow 和 shortcut 列表，让 agent 无需猜测
        const profile = this.profiles.get(op.app);
        if (!profile) {
          const allApps = Array.from(this.profiles.keys()).join(', ');
          return `❌ 未注册的应用: ${op.app}。已注册应用: ${allApps}`;
        }
        const workflows = Object.entries(profile.workflows).map(([name, wf]) =>
          `  📋 ${name}: ${wf.description} (参数: ${wf.requiredParams.join(', ') || '无'})`,
        );
        const shortcuts = Object.entries(profile.shortcuts).map(([name, sc]) =>
          `  ⌨️ ${name}: ${sc.keys} — ${sc.description}`,
        );
        return [
          `✅ 应用 "${profile.name}" (${op.app}) 可用操作:`,
          ``,
          `工作流 (workflow):`,
          ...workflows,
          ``,
          `快捷键 (shortcut):`,
          ...shortcuts,
          ``,
          `提示: 用 action=workflow + params={"workflowName":"<名称>","params":{...}} 执行工作流；`,
          `用 action=shortcut + params={"shortcutName":"<名称>"} 执行快捷键。`,
        ].join('\n');
      }
      default:
        return `❌ 不支持的操作类型: ${op.action}。支持: launch/activate/shortcut/workflow/menu/type/click/find_click/list_actions`;
    }
  }

  /**
   * 批量执行操作（合并执行，提升响应时间）
   * 异步非阻塞并发执行，可选出错停止
   */
  async executeBatch(batch: BatchOperation): Promise<AppOperationResult[]> {
    const results: AppOperationResult[] = [];
    const stopOnError = batch.stopOnError ?? false;

    this.log.info('执行批量操作', { count: batch.operations.length, stopOnError });
    this.emitEvent('batch_started', { count: batch.operations.length });

    // 并发执行所有操作（异步非阻塞）
    if (stopOnError) {
      // 串行执行，出错即停
      for (const op of batch.operations) {
        const result = await this.executeOperation(op);
        results.push(result);
        if (!result.success) {
          this.log.warn('批量操作中出错，停止后续操作', { app: op.app, action: op.action });
          break;
        }
      }
    } else {
      // 并发执行（异步非阻塞）
      const promises = batch.operations.map(op => this.executeOperation(op));
      const settled = await Promise.allSettled(promises);
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled') {
          results.push(s.value);
        } else {
          results.push({
            success: false,
            app: batch.operations[i].app,
            action: batch.operations[i].action,
            attempts: 0,
            duration: 0,
            result: '',
            error: s.reason?.message || String(s.reason),
          });
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    this.emitEvent('batch_completed', {
      total: results.length,
      success: successCount,
      failed: results.length - successCount,
    });

    return results;
  }

  // ============ 频率限制 ============

  private rateLimitCheck(): boolean {
    const now = Date.now();
    if (now - this.lastActionTime < this.MIN_ACTION_INTERVAL) {
      this.log.warn('操作过于频繁，已限流', { elapsed: now - this.lastActionTime });
      return false;
    }
    this.lastActionTime = now;
    this.stats.lastActionTime = now;
    return true;
  }

  private async stepDelay(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.DEFAULT_STEP_DELAY));
  }

  // ============ 事件广播 ============

  private emitEvent(action: string, data?: Record<string, unknown>): void {
    EventBus.getInstance().emitSync(`universal-desktop.${action}`, {
      source: 'UniversalDesktop',
      action,
      timestamp: Date.now(),
      ...data,
    });
  }

  // ============ PowerShell 辅助 ============

  private execPowerShell(script: string): string {
    // 关键修复：PowerShell 非交互模式下会将进度流序列化为 CLIXML 写入 stderr，
    // 导致 execSync 误判为失败（即使命令本身成功）。预置 $ProgressPreference 抑制进度流。
    // 同时 $ErrorActionPreference='SilentlyContinue' 避免非终止错误导致非零退出码。
    const fullScript = `$ProgressPreference='SilentlyContinue';\n${script}`;
    const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
    try {
      return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      }).trim();
    } catch (err: unknown) {
      // execSync 在有 stderr 输出（CLIXML 进度/错误流）时会 throw，
      // 但 error.stdout 仍可能包含有效输出（如 Get-Process 找到进程时输出 PID）。
      // 容忍此类噪声：若有有效 stdout 则返回，仅在确无输出时才抛出。
      const e = err as { stdout?: string; stderr?: string; message?: string; status?: number };
      const stdout = (e.stdout ?? '').trim();
      if (stdout.length > 0) {
        return stdout;
      }
      const message = e.message ?? (err instanceof Error ? err.message : String(err));
      this.log.error('PowerShell 执行失败', { script: script.substring(0, 200), error: message });
      throw new Error(`PowerShell 执行失败: ${message}`);
    }
  }

  // ============ 快捷键映射 ============

  /** 将快捷键描述转换为 SendKeys 格式 */
  private mapShortcutToSendKeys(keys: string): string {
    // 处理 Ctrl+Shift+Key 格式
    const parts = keys.split('+');
    let result = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (part === 'Ctrl') {
        result += '^';
      } else if (part === 'Alt') {
        result += '%';
      } else if (part === 'Shift') {
        result += '+';
      } else if (part === 'Enter') {
        result += '{ENTER}';
      } else if (part === 'Tab') {
        result += '{TAB}';
      } else if (part === 'Escape') {
        result += '{ESC}';
      } else if (part === 'Space') {
        result += ' ';
      } else if (part === 'Up') {
        result += '{UP}';
      } else if (part === 'Down') {
        result += '{DOWN}';
      } else if (part === 'Left') {
        result += '{LEFT}';
      } else if (part === 'Right') {
        result += '{RIGHT}';
      } else if (part.startsWith('F') && /^\d+$/.test(part.slice(1))) {
        result += `{${part}}`;
      } else if (part === '=') {
        result += '{=}';
      } else if (part === '-') {
        result += '{-}';
      } else if (part === '`') {
        result += '{`}';
      } else if (part === '/') {
        result += '{/}';
      } else {
        result += part;
      }
    }

    return result;
  }

  // ============ 核心功能 ============

  /**
   * 启动应用程序
   */
  async launchApp(appId: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}。已注册: ${Array.from(this.profiles.keys()).join(', ')}`;
    }

    try {
      // 智能启动：若应用已在运行，直接激活现有窗口而非启动新实例
      // （避免微信/钉钉等通讯应用多开，也绕过 WeChat→Weixin 路径解析问题）
      try {
        const running = await this.isAppRunning(appId);
        if (running) {
          this.log.info('应用已在运行，改为激活现有窗口', { appId });
          const activateResult = await this.activateApp(appId);
          // activateApp 成功时返回 '✅ 已激活应用: ...'，直接透传
          if (typeof activateResult === 'string' && activateResult.includes('✅')) {
            return `${activateResult}（已跳过重复启动）`;
          }
          // 激活失败则继续走启动流程
        }
      } catch {
        // isAppRunning 失败不阻塞启动流程
      }

      this.log.info('启动应用', { appId, command: profile.launchCommand });
      const result = await this.desktop.openApplication(profile.launchCommand);
      // 关键修复：openApplication 失败时返回 '❌ 应用启动失败: ...' 字符串而非 throw
      // 必须检测错误标记，避免把错误字符串用 ✅ 前缀包装造成"伪装成功"
      const isError = typeof result === 'string' && result.includes('❌');
      if (isError) {
        this.stats.errors++;
        this.log.error('启动应用失败', { appId, command: profile.launchCommand, result });
        return result; // 直接透传错误字符串，不包装 ✅
      }
      this.stats.totalLaunches++;

      this.emitEvent('app_launched', { appId, command: profile.launchCommand });

      return `✅ 已启动应用: ${profile.name} (${appId})\n${result}`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('启动应用失败', { appId, error: err instanceof Error ? err.message : String(err) });
      return `❌ 启动应用失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 检查应用是否运行
   */
  async isAppRunning(appId: string): Promise<boolean> {
    const profile = this.profiles.get(appId);
    if (!profile) return false;

    try {
      if (this.platform === 'win32') {
        for (const procName of profile.processNames) {
          // 关键修复：每个进程名独立 try/catch，避免单个查询失败（如 CLIXML 噪声）
          // 导致整个循环中止，跳过后续变体（如 WeChat 查询失败应继续尝试 Weixin）
          try {
            const result = this.execPowerShell(
              `Get-Process -Name '${procName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }`
            );
            if (result && result.trim().length > 0) {
              return true;
            }
          } catch {
            // 该进程名查询失败，继续尝试下一个变体
          }
        }
      } else {
        for (const procName of profile.processNames) {
          try {
            await execAsync(`pgrep -x '${procName}'`, { encoding: 'utf-8', timeout: 5000 });
            return true;
          } catch {
            // 进程不存在
          }
        }
      }
      return false;
    } catch (err: unknown) {
      this.log.error('检查应用状态失败', { appId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * 激活应用窗口（置顶）
   * 优先使用缓存的窗口句柄，减少 PowerShell 调用以提升响应时间
   */
  async activateApp(appId: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    try {
      if (this.platform === 'win32') {
        // 优先尝试使用缓存的窗口句柄（快速路径）
        const cachedHandle = this.getCachedWindowHandle(appId);
        if (cachedHandle) {
          const fastScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPIFast {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$hwnd = [IntPtr]${cachedHandle}
if ([WinAPIFast]::IsIconic($hwnd)) { [WinAPIFast]::ShowWindow($hwnd, 9) }
[WinAPIFast]::SetForegroundWindow($hwnd)
Write-Output 'activated'
`.trim();
          try {
            const fastResult = this.execPowerShell(fastScript);
            if (fastResult === 'activated') {
              this.emitEvent('app_activated', { appId, cached: true });
              return `✅ 已激活应用: ${profile.name}`;
            }
          } catch {
            // 缓存句柄失效，清理后走慢速路径
            this.invalidateWindowHandleCache(appId);
          }
        }

        // 慢速路径：通过进程名找到窗口并置顶
        for (const procName of profile.processNames) {
          const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$proc = Get-Process -Name '${procName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1;
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
  $handle = $proc.MainWindowHandle.ToInt64()
  [WinAPI]::ShowWindow($proc.MainWindowHandle, 9);
  [WinAPI]::SetForegroundWindow($proc.MainWindowHandle);
  Write-Output "activated|$handle"
} else {
  Write-Output 'no_window'
}
`.trim();
          const result = this.execPowerShell(script);
          if (result.startsWith('activated')) {
            // 缓存窗口句柄
            const parts = result.split('|');
            if (parts[1]) {
              this.setCachedWindowHandle(appId, parts[1]);
            }
            this.emitEvent('app_activated', { appId, cached: false });
            return `✅ 已激活应用: ${profile.name}`;
          }
        }
        return `❌ 未找到 ${profile.name} 的窗口`;
      } else {
        // macOS / Linux: 使用 wmctrl 或 AppleScript
        for (const title of profile.windowTitles) {
          try {
            if (this.platform === 'darwin') {
              await execAsync(`osascript -e 'tell application "${title}" to activate'`, { encoding: 'utf-8', timeout: 5000 });
              this.emitEvent('app_activated', { appId });
              return `✅ 已激活应用: ${profile.name}`;
            } else {
              await execAsync(`wmctrl -a "${title}"`, { encoding: 'utf-8', timeout: 5000 });
              this.emitEvent('app_activated', { appId });
              return `✅ 已激活应用: ${profile.name}`;
            }
          } catch {
            // 继续尝试下一个标题
          }
        }
        return `❌ 未找到 ${profile.name} 的窗口`;
      }
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('激活应用失败', { appId, error: err instanceof Error ? err.message : String(err) });
      return `❌ 激活应用失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 执行命名快捷键
   */
  async executeShortcut(appId: string, shortcutName: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    const shortcut = profile.shortcuts[shortcutName];
    if (!shortcut) {
      const available = Object.keys(profile.shortcuts).join(', ');
      return `❌ 未找到快捷键: ${shortcutName}。可用快捷键: ${available}`;
    }

    try {
      this.log.info('执行快捷键', { appId, shortcutName, keys: shortcut.keys });
      await this.desktop.pressKey(shortcut.keys);
      this.stats.totalShortcuts++;

      this.emitEvent('shortcut_executed', { appId, shortcutName, keys: shortcut.keys });

      return `✅ 已在 ${profile.name} 中执行快捷键 [${shortcutName}]: ${shortcut.keys} (${shortcut.description})`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('快捷键执行失败', { appId, shortcutName, error: err instanceof Error ? err.message : String(err) });
      return `❌ 快捷键执行失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 执行预定义工作流
   */
  async executeWorkflow(
    appId: string,
    workflowName: string,
    params?: Record<string, unknown>,
  ): Promise<WorkflowResult> {
    const profile = this.profiles.get(appId);
    if (!profile) {
      return { success: false, appId, workflowName, stepsCompleted: 0, stepsTotal: 0, duration: 0, error: `未注册的应用: ${appId}` };
    }

    const workflow = profile.workflows[workflowName];
    if (!workflow) {
      const available = Object.keys(profile.workflows).join(', ');
      return { success: false, appId, workflowName, stepsCompleted: 0, stepsTotal: 0, duration: 0, error: `未找到工作流: ${workflowName}。可用: ${available}` };
    }

    // 检查必需参数
    for (const param of workflow.requiredParams) {
      if (!params || params[param] === undefined) {
        return { success: false, appId, workflowName, stepsCompleted: 0, stepsTotal: workflow.steps.length, duration: 0, error: `缺少必需参数: ${param}` };
      }
    }

    const startTime = Date.now();
    let stepsCompleted = 0;

    this.log.info('开始执行工作流', { appId, workflowName, stepCount: workflow.steps.length });
    this.emitEvent('workflow_started', { appId, workflowName, stepCount: workflow.steps.length });

    try {
      // 确保应用在前台
      const isRunning = await this.isAppRunning(appId);
      if (!isRunning) {
        await this.launchApp(appId);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      await this.activateApp(appId);
      await this.stepDelay();

      for (const step of workflow.steps) {
        this.log.info('执行工作流步骤', { appId, workflowName, step: step.description, action: step.action });

        try {
          await this.executeWorkflowStep(appId, step, params || {});
          stepsCompleted++;
          await this.stepDelay();
        } catch (err: unknown) {
          this.stats.errors++;
          this.log.error('工作流步骤失败', { appId, workflowName, step: step.description, error: err instanceof Error ? err.message : String(err) });

          // 错误恢复：截图并尝试继续
          try {
            await this.desktop.captureScreen({ format: 'png' });
          } catch {
            // 截图失败也不阻塞
          }

          return {
            success: false,
            appId,
            workflowName,
            stepsCompleted,
            stepsTotal: workflow.steps.length,
            duration: Date.now() - startTime,
            error: `步骤 "${step.description}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      this.stats.totalWorkflows++;
      const duration = Date.now() - startTime;

      this.emitEvent('workflow_completed', { appId, workflowName, stepsCompleted, duration });

      return {
        success: true,
        appId,
        workflowName,
        stepsCompleted,
        stepsTotal: workflow.steps.length,
        duration,
      };
    } catch (err: unknown) {
      this.stats.errors++;
      return {
        success: false,
        appId,
        workflowName,
        stepsCompleted,
        stepsTotal: workflow.steps.length,
        duration: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 执行单个工作流步骤 */
  private async executeWorkflowStep(
    appId: string,
    step: WorkflowStep,
    params: Record<string, unknown>,
  ): Promise<void> {
    const profile = this.profiles.get(appId);
    if (!profile) throw new Error(`未注册的应用: ${appId}`);

    switch (step.action) {
      case 'shortcut': {
        const keys = this.resolveTemplate(step.value || '', params);
        await this.desktop.pressKey(keys);
        break;
      }
      case 'type': {
        const text = this.resolveTemplate(step.value || '', params);
        await this.desktop.type(text);
        break;
      }
      case 'click': {
        const x = step.x ?? 0;
        const y = step.y ?? 0;
        await this.desktop.click(x, y);
        break;
      }
      case 'wait': {
        const ms = parseInt(step.value || '300', 10);
        await new Promise(resolve => setTimeout(resolve, ms));
        break;
      }
      case 'screenshot': {
        await this.desktop.captureScreen({ format: 'png' });
        break;
      }
      case 'menu': {
        if (step.menuPath && step.menuPath.length > 0) {
          await this.executeMenuPath(appId, step.menuPath);
        }
        break;
      }
      case 'drag': {
        // 真实拖拽：从 (x, y) 拖到 (toX, toY)
        if (step.x !== undefined && step.y !== undefined &&
            step.toX !== undefined && step.toY !== undefined) {
          await this.desktop.dragMouse(step.x, step.y, step.toX, step.toY);
        } else if (step.x !== undefined && step.y !== undefined) {
          // 缺少终点坐标，降级为点击
          this.log.warn('drag 步骤缺少 toX/toY，降级为点击', { description: step.description });
          await this.desktop.click(step.x, step.y);
        }
        break;
      }
      case 'condition': {
        // 条件步骤：截图检查
        if (step.condition) {
          const analysis = await this.desktop.analyzeScreen(
            `检查屏幕上是否存在: ${step.condition}。返回 JSON: {"found": true/false}`
          );
          if (!analysis.description.includes('true') && !analysis.description.includes('found')) {
            this.log.warn('条件步骤未满足', { condition: step.condition });
          }
        }
        break;
      }
      default:
        this.log.warn('未知工作流步骤类型', { action: step.action });
    }
  }

  /** 解析模板参数 {{paramName}} */
  private resolveTemplate(template: string, params: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return params[key] !== undefined ? String(params[key]) : `{{${key}}}`;
    });
  }

  /**
   * 通过菜单路径导航
   */
  async executeMenuPath(appId: string, menuPath: string[]): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    if (!menuPath || menuPath.length === 0) {
      return '❌ 菜单路径不能为空';
    }

    this.log.info('执行菜单导航', { appId, menuPath: menuPath.join(' > ') });

    try {
      // 确保应用在前台
      await this.activateApp(appId);
      await this.stepDelay();

      if (this.platform === 'win32') {
        // Windows: 使用 Alt 激活菜单栏，然后逐级导航
        // 先按 Alt 激活菜单
        await this.desktop.pressKey('Alt');
        await new Promise(resolve => setTimeout(resolve, 200));

        for (let i = 0; i < menuPath.length; i++) {
          const menuItem = menuPath[i];
          // 尝试使用视觉查找菜单项
          const findResult = await this.desktop.findOnScreen(`菜单项: ${menuItem}`);
          if (findResult.includes('✅')) {
            // 提取坐标并点击
            const coordMatch = findResult.match(/\((\d+),\s*(\d+)\)/);
            if (coordMatch) {
              const x = parseInt(coordMatch[1]);
              const y = parseInt(coordMatch[2]);
              await this.desktop.click(x, y);
            }
          } else {
            // 回退：直接输入菜单项的首字母或名称
            await this.desktop.type(menuItem);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } else {
        // macOS / Linux: 使用视觉方式点击菜单
        for (const menuItem of menuPath) {
          const findResult = await this.desktop.findOnScreen(`菜单项: ${menuItem}`);
          if (findResult.includes('✅')) {
            const coordMatch = findResult.match(/\((\d+),\s*(\d+)\)/);
            if (coordMatch) {
              const x = parseInt(coordMatch[1]);
              const y = parseInt(coordMatch[2]);
              await this.desktop.click(x, y);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      this.stats.totalMenuNavs++;
      this.emitEvent('menu_navigated', { appId, menuPath: menuPath.join(' > ') });

      return `✅ 已在 ${profile.name} 中导航菜单: ${menuPath.join(' > ')}`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('菜单导航失败', { appId, menuPath, error: err instanceof Error ? err.message : String(err) });
      return `❌ 菜单导航失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 在应用中输入文本
   */
  async typeInApp(appId: string, text: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    try {
      await this.activateApp(appId);
      await this.stepDelay();
      await this.desktop.type(text);

      this.emitEvent('text_typed', { appId, textLength: text.length });

      return `✅ 已在 ${profile.name} 中输入 ${text.length} 个字符`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('文本输入失败', { appId, error: err instanceof Error ? err.message : String(err) });
      return `❌ 文本输入失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 在应用中点击坐标
   */
  async clickInApp(appId: string, x: number, y: number): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    try {
      await this.activateApp(appId);
      await this.stepDelay();
      await this.desktop.click(x, y);

      this.emitEvent('clicked_in_app', { appId, x, y });

      return `✅ 已在 ${profile.name} 中点击 (${x}, ${y})`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('点击失败', { appId, x, y, error: err instanceof Error ? err.message : String(err) });
      return `❌ 点击失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 视觉查找并点击元素
   */
  async findAndClick(appId: string, elementDescription: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    try {
      await this.activateApp(appId);
      await this.stepDelay();

      // 使用视觉模型查找元素
      const findResult = await this.desktop.findOnScreen(elementDescription);

      if (!findResult.includes('✅')) {
        return `❌ 在 ${profile.name} 中未找到: ${elementDescription}`;
      }

      // 提取坐标
      const coordMatch = findResult.match(/\((\d+),\s*(\d+)\)/);
      if (!coordMatch) {
        return `❌ 无法获取元素坐标: ${findResult}`;
      }

      const x = parseInt(coordMatch[1]);
      const y = parseInt(coordMatch[2]);

      // 点击找到的元素
      await this.desktop.click(x, y);
      this.stats.totalFindClicks++;

      this.emitEvent('find_and_click', { appId, elementDescription, x, y });

      return `✅ 在 ${profile.name} 中找到并点击了 "${elementDescription}" (${x}, ${y})`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('查找点击失败', { appId, elementDescription, error: err instanceof Error ? err.message : String(err) });
      return `❌ 查找点击失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 智能操作 — 核心方法
   * 接收自然语言指令，自动解析并执行
   *
   * 示例:
   * - "在Photoshop里给图片加个红色边框"
   * - "在PowerPoint里新建一个演示文稿"
   * - "在VS Code里打开终端运行npm test"
   * - "在浏览器里打开github.com"
   */
  async smartOperation(instruction: string): Promise<string> {
    if (!this.rateLimitCheck()) {
      return '操作过于频繁，请稍后再试';
    }

    this.log.info('智能操作', { instruction });
    this.emitEvent('smart_operation_started', { instruction });

    try {
      // 第一步：解析指令
      const parsed = this.parseInstruction(instruction);
      this.log.info('指令解析结果', { parsed });

      if (!parsed.appId) {
        return `❌ 无法识别目标应用。请明确指定应用名称，例如 "在Photoshop里..."。已注册应用: ${Array.from(this.profiles.keys()).join(', ')}`;
      }

      const profile = this.profiles.get(parsed.appId);
      if (!profile) {
        return `❌ 未注册的应用: ${parsed.appId}`;
      }

      // 第二步：确保应用运行
      const isRunning = await this.isAppRunning(parsed.appId);
      if (!isRunning) {
        this.log.info('应用未运行，正在启动', { appId: parsed.appId });
        await this.launchApp(parsed.appId);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      await this.activateApp(parsed.appId);
      await this.stepDelay();

      // 第三步：匹配工作流
      const matchedWorkflow = this.matchWorkflow(parsed.appId, parsed.operation);
      if (matchedWorkflow) {
        this.log.info('匹配到工作流', { appId: parsed.appId, workflow: matchedWorkflow });
        const result = await this.executeWorkflow(parsed.appId, matchedWorkflow, parsed.params);
        this.stats.totalSmartOps++;

        if (result.success) {
          return `✅ 智能操作完成: 通过工作流 "${matchedWorkflow}" 执行了 "${instruction}"\n` +
            `   完成 ${result.stepsCompleted}/${result.stepsTotal} 步，耗时 ${result.duration}ms`;
        } else {
          return `⚠️ 工作流执行部分失败: ${result.error}\n   已完成 ${result.stepsCompleted}/${result.stepsTotal} 步`;
        }
      }

      // 第四步：匹配快捷键
      const matchedShortcut = this.matchShortcut(parsed.appId, parsed.operation);
      if (matchedShortcut) {
        this.log.info('匹配到快捷键', { appId: parsed.appId, shortcut: matchedShortcut });
        const result = await this.executeShortcut(parsed.appId, matchedShortcut);
        this.stats.totalSmartOps++;
        return `✅ 智能操作完成: 通过快捷键 "${matchedShortcut}" 执行了 "${instruction}"\n${result}`;
      }

      // 第五步：组合操作（基于操作映射）
      const mappedOp = this.mapOperation(parsed.operation);
      if (mappedOp) {
        this.log.info('映射到操作', { operation: parsed.operation, mapped: mappedOp });

        if (mappedOp.keys) {
          // 通用快捷键
          await this.desktop.pressKey(mappedOp.keys);
          this.stats.totalSmartOps++;
          this.emitEvent('smart_operation_completed', { instruction, method: 'shortcut_mapping' });
          return `✅ 智能操作完成: 通过快捷键 ${mappedOp.keys} 执行了 "${instruction}"`;
        }

        // 需要更复杂操作的场景
        const complexResult = await this.executeComplexOperation(parsed.appId, mappedOp.action, parsed.params);
        this.stats.totalSmartOps++;
        return complexResult;
      }

      // 第六步：视觉方式（截图 → 分析 → 操作 → 验证）
      this.log.info('无可直接映射的操作，使用视觉方式', { instruction });
      const visualResult = await this.executeVisualOperation(parsed.appId, instruction, parsed.params);
      this.stats.totalSmartOps++;
      return visualResult;

    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('智能操作失败', { instruction, error: err instanceof Error ? err.message : String(err) });
      return `❌ 智能操作失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 解析自然语言指令 */
  private parseInstruction(instruction: string): ParsedInstruction {
    const result: ParsedInstruction = {
      appId: '',
      operation: '',
      params: {},
      confidence: 0,
    };

    // 识别目标应用（覆盖全部 24 类已注册应用）
    const appPatterns: Record<string, RegExp[]> = {
      'photoshop': [/photoshop/i, /ps\b/i, /psd/i],
      'powerpoint': [/powerpoint/i, /ppt/i, /演示文稿/i, /幻灯片/i],
      'vscode': [/vs\s*code/i, /visual\s*studio\s*code/i, /代码编辑器/i],
      'chrome': [/chrome/i, /edge/i, /浏览器/i, /browser/i, /网页/i],
      'firefox': [/firefox/i, /火狐/i],
      'notepad++': [/notepad\+\+/i, /n\+\+/i],
      'sublime': [/sublime/i],
      'powershell': [/powershell/i, /ps\s*core/i, /pwsh/i],
      'cmd': [/cmd/i, /命令提示符/i],
      'windowsterminal': [/windows\s*terminal/i, /wt\b/i, /终端/i],
      'word': [/\bword\b/i, /文档/i],
      'excel': [/excel/i, /工作簿/i, /表格/i],
      'outlook': [/outlook/i, /邮件/i],
      'wechat': [/微信/i, /wechat/i],
      'dingtalk': [/钉钉/i, /dingtalk/i],
      'feishu': [/飞书/i, /lark/i],
      'figma': [/figma/i],
      'vlc': [/vlc/i],
      'spotify': [/spotify/i],
      'explorer': [/资源管理器/i, /explorer/i, /文件夹/i],
      'system': [/注册表/i, /regedit/i, /服务管理/i, /services\.msc/i, /任务管理器/i, /taskmgr/i],
      'git': [/\bgit\b/i],
      'docker': [/docker/i],
      'nodejs': [/node\.?js/i, /\bnode\b/i],
    };

    for (const [appId, patterns] of Object.entries(appPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(instruction)) {
          result.appId = appId;
          result.confidence += 0.3;
          break;
        }
      }
      if (result.appId) break;
    }

    // 识别操作
    for (const [opKeyword, _mapping] of Object.entries(OPERATION_MAPPINGS)) {
      if (instruction.includes(opKeyword)) {
        result.operation = opKeyword;
        result.confidence += 0.4;
        break;
      }
    }

    // 提取参数
    // URL 模式
    const urlMatch = instruction.match(/(https?:\/\/[^\s]+|[a-z]+\.[a-z]{2,})/i);
    if (urlMatch) {
      result.params.url = urlMatch[1];
      result.params.query = urlMatch[1];
    }

    // 文件路径模式
    const pathMatch = instruction.match(/([A-Za-z]:[\\/][^\s]+|[/][^\s]+\.[a-z]+)/i);
    if (pathMatch) {
      result.params.filePath = pathMatch[1];
      result.params.path = pathMatch[1];
    }

    // 数字参数（宽高、坐标等）
    const numbers = instruction.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      result.params.width = parseInt(numbers[0]);
      result.params.height = parseInt(numbers[1]);
    }

    // 文字内容（引号内）
    const textMatch = instruction.match(/["""](.+?)["""]/);
    if (textMatch) {
      result.params.text = textMatch[1];
    }

    // 如果没有识别到操作，把整个指令作为操作描述
    if (!result.operation) {
      result.operation = instruction;
      result.confidence = Math.max(result.confidence, 0.1);
    }

    return result;
  }

  /** 匹配工作流 */
  private matchWorkflow(appId: string, operation: string): string | null {
    const profile = this.profiles.get(appId);
    if (!profile) return null;

    // 精确匹配
    if (profile.workflows[operation]) {
      return operation;
    }

    // 模糊匹配
    for (const [name, workflow] of Object.entries(profile.workflows)) {
      if (operation.includes(name) || name.includes(operation)) {
        return name;
      }
      if (workflow.description.includes(operation) || operation.includes(workflow.description)) {
        return name;
      }
    }

    return null;
  }

  /** 匹配快捷键 */
  private matchShortcut(appId: string, operation: string): string | null {
    const profile = this.profiles.get(appId);
    if (!profile) return null;

    // 精确匹配
    if (profile.shortcuts[operation]) {
      return operation;
    }

    // 模糊匹配
    for (const [name, shortcut] of Object.entries(profile.shortcuts)) {
      if (operation.includes(name) || name.includes(operation)) {
        return name;
      }
      if (shortcut.description.includes(operation) || operation.includes(shortcut.description)) {
        return name;
      }
    }

    return null;
  }

  /** 映射通用操作 */
  private mapOperation(operation: string): { keys?: string; action: string; category: string } | null {
    for (const [keyword, mapping] of Object.entries(OPERATION_MAPPINGS)) {
      if (operation.includes(keyword)) {
        return mapping;
      }
    }
    return null;
  }

  /** 执行复杂操作 */
  private async executeComplexOperation(appId: string, action: string, params: Record<string, unknown>): Promise<string> {
    const profile = this.profiles.get(appId);
    if (!profile) return `❌ 未注册的应用: ${appId}`;

    switch (action) {
      case 'export': {
        // 尝试通过菜单导出
        return this.executeMenuPath(appId, ['File', 'Export']);
      }
      case 'insertText': {
        await this.activateApp(appId);
        // 尝试使用应用特定的文字工具
        if (appId === 'photoshop') {
          await this.desktop.pressKey('T');
          await this.stepDelay();
          if (params.x && params.y) {
            await this.desktop.click(Number(params.x), Number(params.y));
          }
          if (params.text) {
            await this.desktop.type(String(params.text));
          }
          await this.desktop.pressKey('Ctrl+Enter');
        } else {
          if (params.text) {
            await this.desktop.type(String(params.text));
          }
        }
        return `✅ 已在 ${profile.name} 中插入文本`;
      }
      case 'insertImage': {
        return this.executeMenuPath(appId, ['Insert', 'Image']);
      }
      case 'adjustColor':
      case 'adjustBrightness':
      case 'adjustContrast': {
        if (appId === 'photoshop') {
          const shortcutMap: Record<string, string> = {
            adjustColor: 'Ctrl+B',
            adjustBrightness: 'Ctrl+L',
            adjustContrast: 'Ctrl+L',
          };
          const keys = shortcutMap[action];
          if (keys) {
            await this.desktop.pressKey(keys);
            return `✅ 已在 Photoshop 中打开调整面板`;
          }
        }
        return `⚠️ ${profile.name} 不支持此调整操作，尝试视觉方式`;
      }
      case 'addAnimation':
      case 'addEffect': {
        if (appId === 'powerpoint') {
          return this.executeMenuPath(appId, ['Animations']);
        }
        return `⚠️ ${profile.name} 不支持动画/效果操作`;
      }
      default:
        return `⚠️ 无法自动执行操作: ${action}，请使用更具体的指令`;
    }
  }

  /** 视觉方式执行操作 */
  private async executeVisualOperation(appId: string, instruction: string, _params: Record<string, unknown>): Promise<string> {
    const profile = this.profiles.get(appId);
    if (!profile) return `❌ 未注册的应用: ${appId}`;

    try {
      // 截图分析当前状态
      const analysis = await this.desktop.analyzeScreen(
        `用户想要在 ${profile.name} 中执行: "${instruction}"。` +
        `请分析当前屏幕状态，建议下一步操作（点击坐标、输入文字、按快捷键等）。` +
        `返回 JSON: {"action": "click/type/shortcut", "x": 数字, "y": 数字, "text": "文字", "key": "按键", "reasoning": "推理过程"}`
      );

      this.emitEvent('visual_operation', { appId, instruction });

      return `🔍 视觉分析结果:\n${analysis.description}\n\n💡 建议操作:\n${analysis.suggestedActions.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}`;
    } catch (err: unknown) {
      return `❌ 视觉操作失败: ${err instanceof Error ? err.message : String(err)}。请尝试使用更具体的指令，如快捷键名称或工作流名称。`;
    }
  }

  /**
   * 获取应用运行状态
   */
  getAppStatus(appId: string): Promise<AppStatus> {
    const profile = this.profiles.get(appId);
    const status: AppStatus = {
      appId,
      isRunning: false,
      processIds: [],
      windowTitles: [],
      isActive: false,
    };

    if (!profile) return Promise.resolve(status);

    try {
      if (this.platform === 'win32') {
        for (const procName of profile.processNames) {
          const result = this.execPowerShell(
            `Get-Process -Name '${procName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`
          );
          if (result && result.trim().length > 0) {
            status.isRunning = true;
            for (const line of result.split('\n')) {
              const [idStr, title] = line.trim().split('|');
              if (idStr) status.processIds.push(parseInt(idStr));
              if (title) status.windowTitles.push(title);
            }
          }
        }

        // 检查是否是前台窗口
        if (status.isRunning && status.processIds.length > 0) {
          const activeResult = this.execPowerShell(
            `[IntPtr] $activeHwnd = (Get-Process -Id ${status.processIds[0]} -ErrorAction SilentlyContinue).MainWindowHandle; ` +
            `[IntPtr] $foregroundHwnd = (Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -Name W -Namespace W -PassThru)::GetForegroundWindow(); ` +
            `Write-Output ($activeHwnd -eq $foregroundHwnd)`
          );
          status.isActive = activeResult.trim().toLowerCase() === 'true';
        }
      }
    } catch (err: unknown) {
      this.log.error('获取应用状态失败', { appId, error: err instanceof Error ? err.message : String(err) });
    }

    return Promise.resolve(status);
  }

  /**
   * 截取应用窗口截图
   */
  async captureAppWindow(appId: string): Promise<string> {
    const profile = this.profiles.get(appId);
    if (!profile) {
      return `❌ 未注册的应用: ${appId}`;
    }

    try {
      // 尝试通过窗口标题截图
      for (const title of profile.windowTitles) {
        try {
          const capture = await this.desktop.captureWindow(title);
          this.emitEvent('app_window_captured', { appId, filePath: capture.filePath });
          return `✅ 已截取 ${profile.name} 窗口截图: ${capture.filePath} (${capture.width}x${capture.height})`;
        } catch {
          // 继续尝试下一个标题
        }
      }

      // 回退：全屏截图
      const capture = await this.desktop.captureScreen({ format: 'png' });
      this.emitEvent('app_window_captured', { appId, filePath: capture.filePath, fallback: true });
      return `✅ 已截取屏幕截图（回退模式）: ${capture.filePath} (${capture.width}x${capture.height})`;
    } catch (err: unknown) {
      this.stats.errors++;
      this.log.error('应用窗口截图失败', { appId, error: err instanceof Error ? err.message : String(err) });
      return `❌ 应用窗口截图失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ============ 统计信息 ============

  getStats(): UniversalDesktopStats & { platform: string; profileCount: number } {
    return {
      ...this.stats,
      platform: this.platform,
      profileCount: this.profiles.size,
    };
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ud = this;

    return [
      {
        name: 'app_launch',
        description: '启动桌面应用程序。支持已注册的应用ID如 photoshop、powerpoint、vscode、chrome，也可输入应用名称。',
        parameters: {
          appId: { type: 'string', description: '应用ID: photoshop, powerpoint, vscode, chrome 或自定义注册的ID', required: true },
        },
        execute: (args) => {
          return ud.launchApp(String(args.appId));
        },
      },
      {
        name: 'app_status',
        description: '检查桌面应用程序是否正在运行，返回进程ID、窗口标题和是否前台激活状态。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const appId = String(args.appId);
          const status = await ud.getAppStatus(appId);
          const profile = ud.getAppProfile(appId);
          return [
            `📊 应用状态: ${profile?.name || appId}`,
            `  运行中: ${status.isRunning ? '✅ 是' : '❌ 否'}`,
            `  进程ID: ${status.processIds.length > 0 ? status.processIds.join(', ') : '无'}`,
            `  窗口标题: ${status.windowTitles.length > 0 ? status.windowTitles.join('; ') : '无'}`,
            `  前台激活: ${status.isActive ? '✅ 是' : '❌ 否'}`,
          ].join('\n');
        },
      },
      {
        name: 'app_shortcut',
        description: '在指定应用中执行键盘快捷键。快捷键名称使用应用配置中注册的中文名称，如"新建"、"保存"、"撤销"等。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
          shortcutName: { type: 'string', description: '快捷键名称（中文），如"新建"、"保存"、"另存为"、"撤销"等', required: true },
        },
        execute: (args) => {
          return ud.executeShortcut(String(args.appId), String(args.shortcutName));
        },
      },
      {
        name: 'app_workflow',
        description: '在指定应用中执行预定义工作流。工作流是一系列自动化步骤的组合，如"新建画布"、"导出PDF"等。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
          workflowName: { type: 'string', description: '工作流名称，如"新建画布"、"导出PDF"、"打开网址"等', required: true },
          params: { type: 'string', description: '工作流参数（JSON字符串），如 {"width":1920,"height":1080}', required: false },
        },
        execute: async (args) => {
          let params: Record<string, unknown> = {};
          if (args.params) {
            try {
              params = JSON.parse(String(args.params));
            } catch {
              return '❌ params 参数必须是有效的 JSON 字符串';
            }
          }
          const result = await ud.executeWorkflow(String(args.appId), String(args.workflowName), params);
          if (result.success) {
            return `✅ 工作流 "${result.workflowName}" 执行成功\n   完成 ${result.stepsCompleted}/${result.stepsTotal} 步，耗时 ${result.duration}ms`;
          } else {
            return `❌ 工作流 "${result.workflowName}" 执行失败\n   错误: ${result.error}\n   已完成 ${result.stepsCompleted}/${result.stepsTotal} 步`;
          }
        },
      },
      {
        name: 'app_menu',
        description: '在指定应用中通过菜单路径导航。依次点击菜单项，如 ["File", "Save As"]。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
          menuPath: { type: 'string', description: '菜单路径（JSON数组字符串），如 ["File","Export","Create PDF"]', required: true },
        },
        execute: (args) => {
          let menuPath: string[];
          try {
            menuPath = JSON.parse(String(args.menuPath));
            if (!Array.isArray(menuPath)) {
              return Promise.resolve('❌ menuPath 必须是 JSON 数组字符串，如 ["File","Save"]');
            }
          } catch {
            return Promise.resolve('❌ menuPath 必须是有效的 JSON 数组字符串，如 ["File","Save"]');
          }
          return ud.executeMenuPath(String(args.appId), menuPath);
        },
      },
      {
        name: 'app_type',
        description: '在当前活动的应用窗口中输入文本。会先激活指定应用，然后输入文本。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
          text: { type: 'string', description: '要输入的文本内容', required: true },
        },
        execute: (args) => {
          return ud.typeInApp(String(args.appId), String(args.text));
        },
      },
      {
        name: 'app_click',
        description: '在指定应用中点击屏幕坐标。会先激活应用，然后点击。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
          x: { type: 'number', description: '点击的 X 坐标', required: true },
          y: { type: 'number', description: '点击的 Y 坐标', required: true },
        },
        execute: (args) => {
          return ud.clickInApp(String(args.appId), Number(args.x), Number(args.y));
        },
      },
      {
        name: 'app_find_click',
        description: '在指定应用中通过视觉识别查找并点击界面元素。使用视觉模型分析截图，定位元素后自动点击。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
          description: { type: 'string', description: '要查找的元素描述，如"保存按钮"、"文件菜单"、"搜索框"等', required: true },
        },
        execute: (args) => {
          return ud.findAndClick(String(args.appId), String(args.description));
        },
      },
      {
        name: 'app_smart',
        description: '执行自然语言桌面指令。这是最智能的操作方式，输入自然语言描述，系统自动解析目标应用、操作类型和参数，然后执行。例如："在Photoshop里新建一个1920x1080的画布"、"在浏览器里打开github.com"、"在VS Code里打开终端"。',
        parameters: {
          instruction: { type: 'string', description: '自然语言指令，如"在Photoshop里给图片加个红色边框"、"在PowerPoint里新建演示文稿"', required: true },
        },
        execute: (args) => {
          return ud.smartOperation(String(args.instruction));
        },
      },
      {
        name: 'app_screenshot',
        description: '截取指定应用窗口的截图。优先截取应用窗口，如果失败则回退到全屏截图。',
        parameters: {
          appId: { type: 'string', description: '应用ID', required: true },
        },
        readOnly: true,
        execute: (args) => {
          return ud.captureAppWindow(String(args.appId));
        },
      },
      {
        name: 'app_list',
        description: '列出所有已注册的应用配置，包括应用ID、名称、可用快捷键数量和工作流数量。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const apps = ud.listApps();
          if (apps.length === 0) {
            return Promise.resolve('📋 暂无已注册的应用配置');
          }
          const lines = ['📋 已注册的应用配置:', ''];
          for (const app of apps) {
            lines.push(`  🖥️ ${app.name} (ID: ${app.id})`);
            lines.push(`     快捷键: ${app.shortcutCount} 个 | 工作流: ${app.workflowCount} 个`);
          }
          return Promise.resolve(lines.join('\n'));
        },
      },
      {
        name: 'app_operate',
        description: '统一应用操作接口。通过此工具可控制任意已注册应用（共24类：photoshop/powerpoint/vscode/chrome/firefox/notepad++/sublime/powershell/cmd/windowsterminal/word/excel/outlook/wechat/dingtalk/feishu/figma/vlc/spotify/explorer/system/git/docker/nodejs）。自动处理前置验证、超时(默认5s)、失败重试(默认3次)和后置验证。支持操作类型: launch(启动)/activate(激活)/shortcut(快捷键)/workflow(工作流)/menu(菜单)/type(输入)/click(点击)/find_click(查找点击)。',
        parameters: {
          app: { type: 'string', description: '应用ID，如 photoshop/vscode/chrome/wechat/explorer 等', required: true },
          action: { type: 'string', description: '操作类型: launch/activate/shortcut/workflow/menu/type/click/find_click', required: true },
          params: { type: 'string', description: '操作参数（JSON字符串）。shortcut: {"shortcutName":"新建"}; workflow: {"workflowName":"打开网址","params":{"url":"..."}}; menu: {"menuPath":["File","Save"]}; type: {"text":"内容"}; click: {"x":100,"y":200}; find_click: {"description":"保存按钮"}', required: true },
          timeout: { type: 'number', description: '操作超时时间（毫秒），默认 5000', required: false },
          retry: { type: 'number', description: '失败重试次数，默认 3', required: false },
        },
        execute: async (args) => {
          let params: unknown;
          try {
            params = JSON.parse(String(args.params));
          } catch {
            return '❌ params 必须是有效的 JSON 字符串';
          }
          const op: AppOperation = {
            app: String(args.app),
            action: String(args.action),
            params,
            timeout: args.timeout !== undefined ? Number(args.timeout) : undefined,
            retry: args.retry !== undefined ? Number(args.retry) : undefined,
          };
          const result = await ud.executeOperation(op);
          const lines = [
            result.success ? `✅ 操作成功` : `❌ 操作失败`,
            `  应用: ${result.app} | 操作: ${result.action}`,
            `  尝试次数: ${result.attempts} | 耗时: ${result.duration}ms | 已验证: ${result.verified ? '是' : '否'}`,
          ];
          if (result.result) lines.push(`  结果: ${result.result}`);
          if (result.error) lines.push(`  错误: ${result.error}`);
          return lines.join('\n');
        },
      },
      {
        name: 'app_batch',
        description: '批量执行多个应用操作（合并执行，提升响应时间）。支持并发非阻塞执行或串行出错即停。每个操作遵循统一接口规范，自动处理验证/超时/重试。',
        parameters: {
          operations: { type: 'string', description: '操作列表（JSON数组字符串），每项为 {app, action, params, timeout?, retry?}。例如 [{"app":"chrome","action":"workflow","params":{"workflowName":"打开网址","params":{"url":"https://github.com"}}},{"app":"vscode","action":"shortcut","params":{"shortcutName":"保存"}}]', required: true },
          stopOnError: { type: 'boolean', description: '出错是否停止后续操作（默认 false，并发执行）', required: false },
        },
        execute: async (args) => {
          let operations: AppOperation[];
          try {
            operations = JSON.parse(String(args.operations));
            if (!Array.isArray(operations)) {
              return '❌ operations 必须是 JSON 数组字符串';
            }
          } catch {
            return '❌ operations 必须是有效的 JSON 数组字符串';
          }
          const batch: BatchOperation = {
            operations,
            stopOnError: args.stopOnError === true || args.stopOnError === 'true',
          };
          const results = await ud.executeBatch(batch);
          const successCount = results.filter(r => r.success).length;
          const lines = [
            `📦 批量操作完成: ${successCount}/${results.length} 成功`,
            '',
          ];
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            lines.push(`  ${i + 1}. [${r.success ? '✅' : '❌'}] ${r.app}/${r.action} (${r.attempts}次, ${r.duration}ms)`);
            if (r.error) lines.push(`     错误: ${r.error}`);
          }
          return lines.join('\n');
        },
      },
    ];
  }
}
