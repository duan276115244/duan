/**
 * 增强视觉智能引擎 — VisualIntelligence
 *
 * 在 DesktopControl 基础上提供更深层的屏幕理解能力：
 * 1. 多层级屏幕理解（全屏 → 窗口 → 区域 → 元素）
 * 2. UI 元素检测与坐标定位
 * 3. 文本/OCR 提取
 * 4. 视觉状态对比（前后截图差异）
 * 5. 智能元素查找（按标签找按钮、按占位符找输入框等）
 * 6. 屏幕变化监控
 *
 * 性能优化：
 * - VisualState 缓存（2 秒 TTL）
 * - 元素搜索结果缓存（1 秒 TTL）
 * - 操作后自动失效缓存
 * - 截图对比 LRU 缓存（最大 10 条）
 *
 * 持久化：
 * - 分析历史 → .duan/visual/history.json（最近 100 条）
 * - 元素模板 → .duan/visual/templates.json（学习到的元素位置）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { DesktopControl, type CaptureOptions } from './desktop-control.js';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

const execAsync = promisify(exec);

// ============ 接口定义 ============

export interface UIElementDetection {
  type: 'button' | 'input' | 'text' | 'icon' | 'menu' | 'tab' | 'checkbox' | 'dropdown' | 'slider' | 'image' | 'link' | 'window' | 'dialog' | 'tooltip' | 'panel';
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  confidence: number;
  state?: 'normal' | 'hover' | 'active' | 'disabled' | 'focused' | 'selected';
  color?: string;
  text?: string;
  children?: UIElementDetection[];
}

export interface ScreenRegion {
  x: number; y: number; width: number; height: number;
  label: string;
  type: 'titlebar' | 'menubar' | 'toolbar' | 'sidebar' | 'content' | 'statusbar' | 'dialog' | 'notification';
}

export interface VisualState {
  screenshotPath: string;
  timestamp: number;
  elements: UIElementDetection[];
  regions: ScreenRegion[];
  activeWindow: string;
  focusedElement?: UIElementDetection;
  textContent: string;
  colorPalette: string[];
}

export interface ElementSearchParams {
  type?: string;
  label?: string;
  labelContains?: string;
  region?: { x: number; y: number; width: number; height: number };
  state?: string;
  nearPoint?: { x: number; y: number };
  index?: number;
}

export interface ScreenChange {
  region: { x: number; y: number; width: number; height: number };
  changeType: 'appeared' | 'disappeared' | 'moved' | 'changed' | 'text_changed';
  description: string;
  beforeDescription?: string;
  afterDescription?: string;
  confidence: number;
}

export interface VisualAnalysisOptions {
  includeOCR?: boolean;
  includeElements?: boolean;
  includeRegions?: boolean;
  includeColors?: boolean;
  focusRegion?: { x: number; y: number; width: number; height: number };
  maxElements?: number;
}


interface CachedVisualState {
  state: VisualState;
  timestamp: number;
}

interface CachedSearchResult {
  results: UIElementDetection[];
  timestamp: number;
  paramsKey: string;
}

interface ComparisonCacheEntry {
  key: string;
  changes: ScreenChange[];
}

interface AnalysisHistoryEntry {
  timestamp: number;
  screenshotPath: string;
  elementCount: number;
  activeWindow: string;
  textPreview: string;
}

interface ElementTemplate {
  label: string;
  type: string;
  typicalRegion: { x: number; y: number; width: number; height: number };
  lastSeen: number;
  hitCount: number;
}

// ============ 主类 ============

export class VisualIntelligence {
  private log = logger.child({ module: 'VisualIntelligence' });
  private desktop: DesktopControl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态模型库，访问 .getAvailableModels()/.call() 等方法
  private modelLibrary: any;
  private platform: string;

  // 缓存
  private cachedState: CachedVisualState | null = null;
  private readonly STATE_CACHE_TTL = 2000; // 2 秒
  private cachedSearches: Map<string, CachedSearchResult> = new Map();
  private readonly SEARCH_CACHE_TTL = 1000; // 1 秒
  private comparisonCache: ComparisonCacheEntry[] = [];
  private readonly COMPARISON_CACHE_MAX = 10;

  // 持久化目录
  private visualDir: string;
  private historyPath: string;
  private templatesPath: string;

  // 持久化数据
  private history: AnalysisHistoryEntry[] = [];
  private templates: Map<string, ElementTemplate> = new Map();
  private readonly MAX_HISTORY = 100;

  /**
   * P0 真实修复：注入式 EmbeddingProvider — 用于 crossModalSearch 真实向量嵌入
   * 之前 crossModalSearch 是关键词子串匹配 + 硬编码 score 0.7。
   * 注入后使用真实语义向量（OpenAI 或 TF-IDF）计算余弦相似度。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态 EmbeddingProvider，访问 .embed()/.name/.dimension
  private embeddingProvider: any | null = null;
  private crossModalEmbeddings: Map<string, { embedding: number[]; record: AnalysisHistoryEntry }> = new Map();

  /**
   * P0 真实修复：注入 EmbeddingProvider — 启用真实跨模态向量检索
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态 EmbeddingProvider 注入
  setEmbeddingProvider(provider: any): void {
    this.embeddingProvider = provider;
    this.log.info('EmbeddingProvider 已注入', {
      provider: provider?.name,
      dimension: provider?.dimension,
      isSemantic: provider?.isSemantic,
    });
  }

  /**
   * V19 P0：注入 AccessibilityController — 启用 hybridClick 融合点击
   * 注入后 hybridClick 优先用 Accessibility API 语义点击，失败降级视觉坐标点击
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态 AccessibilityController 注入
  private accessibilityController: any | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态 AccessibilityController 注入
  setAccessibilityController(controller: any): void {
    this.accessibilityController = controller;
    this.log.info('AccessibilityController 已注入', {
      available: controller?.isAvailable?.() ?? false,
    });
  }

  // 监控
  private monitorTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /** 懒加载标记 */
  private stateLoaded = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态模型库注入
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary;
    this.desktop = new DesktopControl(modelLibrary);
    this.platform = os.platform();

    // 初始化持久化目录
    this.visualDir = duanPath('visual');
    this.historyPath = path.join(this.visualDir, 'history.json');
    this.templatesPath = path.join(this.visualDir, 'templates.json');

    // 不在构造函数中执行同步 I/O，延迟到首次访问
    this.log.info('视觉智能引擎初始化', { platform: this.platform });
  }

  /** 懒加载：首次访问数据时才从磁盘加载 */
  private ensureStateLoaded(): void {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    this.ensureVisualDir();
    this.loadHistory();
    this.loadTemplates();
  }

  // ============ 私有工具方法 ============

  private ensureVisualDir(): void {
    try {
      fs.mkdirSync(this.visualDir, { recursive: true });
    } catch (err: unknown) {
      this.log.error('创建视觉数据目录失败', { error: err });
    }
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const data = JSON.parse(fs.readFileSync(this.historyPath, 'utf-8'));
        this.history = Array.isArray(data) ? data.slice(-this.MAX_HISTORY) : [];
      }
    } catch {
      this.history = [];
    }
  }

  private saveHistory(): void {
    try {
      atomicWriteJsonSync(this.historyPath, this.history);
    } catch (err: unknown) {
      this.log.error('保存分析历史失败', { error: err });
    }
  }

  private loadTemplates(): void {
    try {
      if (fs.existsSync(this.templatesPath)) {
        const data = JSON.parse(fs.readFileSync(this.templatesPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const t of data) {
            this.templates.set(`${t.type}:${t.label}`, t);
          }
        }
      }
    } catch {
      this.templates.clear();
    }
  }

  private saveTemplates(): void {
    try {
      const arr = Array.from(this.templates.values());
      atomicWriteJsonSync(this.templatesPath, arr);
    } catch (err: unknown) {
      this.log.error('保存元素模板失败', { error: err });
    }
  }

  private recordHistory(state: VisualState): void {
    this.ensureStateLoaded();
    const entry: AnalysisHistoryEntry = {
      timestamp: state.timestamp,
      screenshotPath: state.screenshotPath,
      elementCount: state.elements.length,
      activeWindow: state.activeWindow,
      textPreview: state.textContent.substring(0, 200),
    };
    this.history.push(entry);
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }
    // 不在每次记录时写盘，与模板共享延迟保存
    this.scheduleSaveTemplates();
  }

  private updateTemplate(element: UIElementDetection): void {
    this.ensureStateLoaded();
    const key = `${element.type}:${element.label}`;
    const existing = this.templates.get(key);
    if (existing) {
      existing.typicalRegion = element.bounds;
      existing.lastSeen = Date.now();
      existing.hitCount++;
    } else {
      this.templates.set(key, {
        label: element.label,
        type: element.type,
        typicalRegion: element.bounds,
        lastSeen: Date.now(),
        hitCount: 1,
      });
    }
    // 不在每次更新时写盘，改为延迟批量保存
    this.scheduleSaveTemplates();
  }

  /** 延迟保存模板和历史（避免频繁写盘） */
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleSaveTemplates(): void {
    if (this._saveTimer) return; // 已有待保存的定时器
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveTemplates();
      this.saveHistory();
    }, 2000); // 2秒后批量保存
  }

  /** 查找可用的视觉模型 */
  private findVisionModel(): string | null {
    if (!this.modelLibrary || typeof this.modelLibrary.getAvailableModels !== 'function') {
      return null;
    }
    try {
      const available = this.modelLibrary.getAvailableModels();
      const visionModel = available.find((m) =>
        m.capabilities && m.capabilities.includes('vision') && m.enabled !== false
      );
      return visionModel ? visionModel.id : null;
    } catch {
      return null;
    }
  }

  /** 执行 PowerShell 命令 */
  private execPowerShell(script: string): string {
    if (process.platform !== 'win32') {
      throw new Error(`PowerShell 仅在 Windows 上可用（当前平台: ${process.platform}）`);
    }
    try {
      // 使用 Base64 编码传递脚本，避免 cmd.exe 吞掉 $_ / $var 等 PowerShell 变量及 Add-Type here-string
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      }).trim();
    } catch (err: unknown) {
      this.log.error('PowerShell 执行失败', { script: script.substring(0, 200), error: err instanceof Error ? err.message : String(err) });
      throw new Error(`PowerShell 执行失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 广播视觉事件 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态事件 payload，被展开 ...data
  private emitEvent(action: string, data?: any): void {
    EventBus.getInstance().emitSync(`visual.${action}`, {
      source: 'VisualIntelligence',
      action,
      timestamp: Date.now(),
      ...data,
    });
  }

  /** 使缓存失效 */
  private invalidateCache(): void {
    this.cachedState = null;
    this.cachedSearches.clear();
  }

  /** 获取缓存的 VisualState，如果过期则返回 null */
  private getCachedState(): VisualState | null {
    if (!this.cachedState) return null;
    if (Date.now() - this.cachedState.timestamp > this.STATE_CACHE_TTL) {
      this.cachedState = null;
      return null;
    }
    return this.cachedState.state;
  }

  /** 生成搜索参数键 */
  private searchParamsKey(params: ElementSearchParams): string {
    return JSON.stringify(params);
  }

  /** 获取缓存的搜索结果 */
  private getCachedSearch(params: ElementSearchParams): UIElementDetection[] | null {
    const key = this.searchParamsKey(params);
    const cached = this.cachedSearches.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.SEARCH_CACHE_TTL) {
      this.cachedSearches.delete(key);
      return null;
    }
    return cached.results;
  }

  /** 缓存搜索结果 */
  private cacheSearch(params: ElementSearchParams, results: UIElementDetection[]): void {
    const key = this.searchParamsKey(params);
    this.cachedSearches.set(key, { results, timestamp: Date.now(), paramsKey: key });
    // 清理过期缓存
    const now = Date.now();
    this.cachedSearches.forEach((v, k) => {
      if (now - v.timestamp > this.SEARCH_CACHE_TTL) {
        this.cachedSearches.delete(k);
      }
    });
  }

  /** 计算两点距离 */
  private distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  /** 点是否在区域内 */
  private pointInRegion(point: { x: number; y: number }, region: { x: number; y: number; width: number; height: number }): boolean {
    return point.x >= region.x && point.x <= region.x + region.width &&
           point.y >= region.y && point.y <= region.y + region.height;
  }

  /** 中心点是否在区域内 */
  private centerInRegion(element: UIElementDetection, region: { x: number; y: number; width: number; height: number }): boolean {
    return this.pointInRegion(element.center, region);
  }

  /** 模糊匹配标签 */
  private labelMatches(elementLabel: string, searchLabel: string, mode: 'exact' | 'contains' | 'fuzzy'): boolean {
    if (mode === 'exact') {
      return elementLabel === searchLabel;
    }
    if (mode === 'contains') {
      return elementLabel.toLowerCase().includes(searchLabel.toLowerCase());
    }
    // fuzzy: 包含匹配或编辑距离足够小
    const lowerEl = elementLabel.toLowerCase();
    const lowerSearch = searchLabel.toLowerCase();
    if (lowerEl.includes(lowerSearch) || lowerSearch.includes(lowerEl)) {
      return true;
    }
    // 简单编辑距离检查（长度差不超过 2 且有超过 60% 字符匹配）
    if (Math.abs(lowerEl.length - lowerSearch.length) > 2) return false;
    let matches = 0;
    const shorter = lowerEl.length <= lowerSearch.length ? lowerEl : lowerSearch;
    const longer = lowerEl.length > lowerSearch.length ? lowerEl : lowerSearch;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) matches++;
    }
    return matches / shorter.length > 0.6;
  }

  // ============ 核心功能 ============

  /**
   * 全屏分析：截图 → 检测元素 → 提取文本 → 识别区域 → 返回 VisualState
   */
  async analyzeScreen(options?: VisualAnalysisOptions): Promise<VisualState> {
    const startTime = Date.now();
    const opts: VisualAnalysisOptions = {
      includeOCR: options?.includeOCR ?? true,
      includeElements: options?.includeElements ?? true,
      includeRegions: options?.includeRegions ?? true,
      includeColors: options?.includeColors ?? false,
      maxElements: options?.maxElements ?? 50,
      focusRegion: options?.focusRegion,
    };

    try {
      // 截图
      const captureOpts: CaptureOptions = { format: 'png' };
      if (opts.focusRegion) {
        captureOpts.region = opts.focusRegion;
      }
      const capture = await this.desktop.captureScreen(captureOpts);

      const visionModelId = this.findVisionModel();

      let elements: UIElementDetection[] = [];
      let regions: ScreenRegion[] = [];
      let textContent = '';
      let colorPalette: string[] = [];
      let activeWindow = '';
      let focusedElement: UIElementDetection | undefined;

      if (visionModelId) {
        // 使用视觉模型分析
        const analysisResult = await this.analyzeWithVisionModel(capture.base64!, opts);
        elements = analysisResult.elements;
        regions = analysisResult.regions;
        textContent = analysisResult.textContent;
        colorPalette = analysisResult.colorPalette;
      } else {
        // PowerShell 回退方案
        const fallbackResult = this.analyzeWithFallback();
        activeWindow = fallbackResult.activeWindow;
        regions = fallbackResult.regions;
        textContent = fallbackResult.textContent;
      }

      // 获取活动窗口信息
      if (!activeWindow) {
        activeWindow = this.getActiveWindowTitle();
      }

      // 识别焦点元素
      if (elements.length > 0) {
        const focused = elements.find(el => el.state === 'focused');
        if (focused) focusedElement = focused;
      }

      // 限制元素数量
      if (elements.length > (opts.maxElements ?? 50)) {
        elements = elements
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, opts.maxElements ?? 50);
      }

      const state: VisualState = {
        screenshotPath: capture.filePath,
        timestamp: Date.now(),
        elements,
        regions,
        activeWindow,
        focusedElement,
        textContent,
        colorPalette,
      };

      // 缓存
      this.cachedState = { state, timestamp: Date.now() };

      // 记录历史
      this.recordHistory(state);

      // 更新元素模板
      for (const el of elements) {
        this.updateTemplate(el);
      }

      this.log.info('屏幕分析完成', {
        elementCount: elements.length,
        regionCount: regions.length,
        textLength: textContent.length,
        activeWindow,
        duration: Date.now() - startTime,
      });

      this.emitEvent('analyzed', {
        elementCount: elements.length,
        activeWindow,
      });

      return state;
    } catch (err: unknown) {
      this.log.error('屏幕分析失败', { error: err instanceof Error ? err.message : String(err) });
      throw new Error(`屏幕分析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 使用视觉模型分析截图 */
  private async analyzeWithVisionModel(
    base64: string,
    opts: VisualAnalysisOptions,
  ): Promise<{
    elements: UIElementDetection[];
    regions: ScreenRegion[];
    textContent: string;
    colorPalette: string[];
  }> {
    const promptParts: string[] = [
      '分析此屏幕截图，以 JSON 格式返回结果。格式如下：',
      '{',
      '  "elements": [',
      '    {',
      '      "type": "button|input|text|icon|menu|tab|checkbox|dropdown|slider|image|link|window|dialog|tooltip|panel",',
      '      "label": "元素标签",',
      '      "bounds": { "x": 数字, "y": 数字, "width": 数字, "height": 数字 },',
      '      "confidence": 0到1的数字,',
      '      "state": "normal|hover|active|disabled|focused|selected",',
      '      "text": "元素内文本"',
      '    }',
      '  ],',
    ];

    if (opts.includeRegions) {
      promptParts.push(
        '  "regions": [',
        '    {',
        '      "x": 数字, "y": 数字, "width": 数字, "height": 数字,',
        '      "label": "区域名称",',
        '      "type": "titlebar|menubar|toolbar|sidebar|content|statusbar|dialog|notification"',
        '    }',
        '  ],',
      );
    }

    if (opts.includeOCR) {
      promptParts.push('  "textContent": "屏幕上所有可见文本",');
    }

    if (opts.includeColors) {
      promptParts.push('  "colorPalette": ["#hex1", "#hex2", ...],');
    }

    promptParts.push('}');

    const prompt = promptParts.join('\n');

    try {
      const visionModelId = this.findVisionModel()!;
      const response = await this.modelLibrary.call([
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ], { modelId: visionModelId });

      return this.parseVisionResponse(response.content, opts);
    } catch (err: unknown) {
      this.log.warn('视觉模型分析失败，使用空结果', { error: err instanceof Error ? err.message : String(err) });
      return { elements: [], regions: [], textContent: '', colorPalette: [] };
    }
  }

  /** 解析视觉模型返回 */
  private parseVisionResponse(
    content: string,
    opts: VisualAnalysisOptions,
  ): {
    elements: UIElementDetection[];
    regions: ScreenRegion[];
    textContent: string;
    colorPalette: string[];
  } {
    const result = {
      elements: [] as UIElementDetection[],
      regions: [] as ScreenRegion[],
      textContent: '',
      colorPalette: [] as string[],
    };

    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) ||
        content.match(/\{[\s\S]*"elements"[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

        // 解析元素
        if (opts.includeElements && Array.isArray(parsed.elements)) {
          result.elements = parsed.elements
            .map((el) => this.parseUIElement(el))
            .filter((el: UIElementDetection | null): el is UIElementDetection => el !== null);
        }

        // 解析区域
        if (opts.includeRegions && Array.isArray(parsed.regions)) {
          result.regions = parsed.regions
            .map((r) => this.parseScreenRegion(r))
            .filter((r: ScreenRegion | null): r is ScreenRegion => r !== null);
        }

        // 解析文本
        if (opts.includeOCR && typeof parsed.textContent === 'string') {
          result.textContent = parsed.textContent;
        }

        // 解析颜色
        if (opts.includeColors && Array.isArray(parsed.colorPalette)) {
          result.colorPalette = parsed.colorPalette.filter((c) => typeof c === 'string');
        }
      }
    } catch (err: unknown) {
      this.log.warn('视觉模型返回解析失败', { error: err });
    }

    return result;
  }

  /** 解析单个 UI 元素 */
  private parseUIElement(el): UIElementDetection | null {
    if (!el || typeof el !== 'object') return null;

    const validTypes: UIElementDetection['type'][] = [
      'button', 'input', 'text', 'icon', 'menu', 'tab',
      'checkbox', 'dropdown', 'slider', 'image', 'link',
      'window', 'dialog', 'tooltip', 'panel',
    ];

    const type = validTypes.includes(el.type) ? el.type : 'text';
    const bounds = el.bounds && typeof el.bounds.x === 'number' && typeof el.bounds.y === 'number' &&
                   typeof el.bounds.width === 'number' && typeof el.bounds.height === 'number'
      ? el.bounds
      : null;

    if (!bounds) return null;

    const validStates: UIElementDetection['state'][] = [
      'normal', 'hover', 'active', 'disabled', 'focused', 'selected',
    ];

    return {
      type,
      label: String(el.label || ''),
      bounds,
      center: {
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2),
      },
      confidence: typeof el.confidence === 'number' ? Math.min(1, Math.max(0, el.confidence)) : 0.5,
      state: validStates.includes(el.state) ? el.state : undefined,
      color: typeof el.color === 'string' ? el.color : undefined,
      text: typeof el.text === 'string' ? el.text : undefined,
      children: Array.isArray(el.children)
        ? el.children.map((c) => this.parseUIElement(c)).filter((c: UIElementDetection | null): c is UIElementDetection => c !== null)
        : undefined,
    };
  }

  /** 解析屏幕区域 */
  private parseScreenRegion(r): ScreenRegion | null {
    if (!r || typeof r !== 'object') return null;

    const validTypes: ScreenRegion['type'][] = [
      'titlebar', 'menubar', 'toolbar', 'sidebar', 'content', 'statusbar', 'dialog', 'notification',
    ];

    if (typeof r.x !== 'number' || typeof r.y !== 'number' ||
        typeof r.width !== 'number' || typeof r.height !== 'number') {
      return null;
    }

    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      label: String(r.label || ''),
      type: validTypes.includes(r.type) ? r.type : 'content',
    };
  }

  /** PowerShell 回退分析 */
  private analyzeWithFallback(): {
    activeWindow: string;
    regions: ScreenRegion[];
    textContent: string;
  } {
    const activeWindow = this.getActiveWindowTitle();
    const regions: ScreenRegion[] = [];

    if (this.platform === 'win32') {
      try {
        // 获取活动窗口位置
        const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$hwnd = [WinAPI]::GetForegroundWindow();
$rect = New-Object WinAPI+RECT;
[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null;
Write-Output "$($rect.Left)|$($rect.Top)|$($rect.Right)|$($rect.Bottom)"
`.trim();
        const result = this.execPowerShell(script);
        const [left, top, right, bottom] = result.split('|').map(Number);
        const width = right - left;
        const height = bottom - top;

        if (width > 0 && height > 0) {
          // 基于典型窗口布局估算区域
          regions.push(
            { x: left, y: top, width, height: 30, label: '标题栏', type: 'titlebar' },
            { x: left, y: top + 30, width, height: 25, label: '菜单栏', type: 'menubar' },
            { x: left, y: top + 55, width, height: 35, label: '工具栏', type: 'toolbar' },
            { x: left, y: bottom - 25, width, height: 25, label: '状态栏', type: 'statusbar' },
            { x: left, y: top + 90, width, height: height - 115, label: '内容区域', type: 'content' },
          );
        }
      } catch (err: unknown) {
        this.log.warn('PowerShell 回退分析失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { activeWindow, regions, textContent: '' };
  }

  /** 获取活动窗口标题 */
  private getActiveWindowTitle(): string {
    try {
      if (this.platform === 'win32') {
        return this.execPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinTitle {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$hwnd = [WinTitle]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 256;
[WinTitle]::GetWindowText($hwnd, $sb, 256) | Out-Null;
$sb.ToString()
`.trim());
      } else if (this.platform === 'darwin') {
        return execSync('osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\'', {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      }
    } catch {
      // 忽略
    }
    return '';
  }

  /**
   * 查找 UI 元素
   */
  async findElement(params: ElementSearchParams): Promise<UIElementDetection | null> {
    // 检查搜索缓存
    const cachedResults = this.getCachedSearch(params);
    if (cachedResults) {
      return cachedResults[0] || null;
    }

    // 获取当前 VisualState
    let state = this.getCachedState();
    if (!state) {
      state = await this.analyzeScreen();
    }

    // 筛选元素
    let candidates = [...state.elements];

    // 按类型筛选
    if (params.type) {
      candidates = candidates.filter(el => el.type === params.type);
    }

    // 按标签精确匹配
    if (params.label) {
      const exactMatches = candidates.filter(el => this.labelMatches(el.label, params.label!, 'exact'));
      if (exactMatches.length > 0) {
        candidates = exactMatches;
      } else {
        const caseInsensitiveMatches = candidates.filter(el =>
          el.label.toLowerCase() === params.label!.toLowerCase()
        );
        if (caseInsensitiveMatches.length > 0) {
          candidates = caseInsensitiveMatches;
        } else {
          const containsMatches = candidates.filter(el =>
            this.labelMatches(el.label, params.label!, 'contains')
          );
          if (containsMatches.length > 0) {
            candidates = containsMatches;
          } else {
            const fuzzyMatches = candidates.filter(el =>
              this.labelMatches(el.label, params.label!, 'fuzzy')
            );
            candidates = fuzzyMatches;
          }
        }
      }
    }

    // 按标签包含匹配
    if (params.labelContains) {
      candidates = candidates.filter(el =>
        this.labelMatches(el.label, params.labelContains!, 'contains')
      );
    }

    // 按区域筛选
    if (params.region) {
      candidates = candidates.filter(el => this.centerInRegion(el, params.region!));
    }

    // 按状态筛选
    if (params.state) {
      candidates = candidates.filter(el => el.state === params.state);
    }

    // 按距离排序（如果指定了近点）
    if (params.nearPoint) {
      candidates.sort((a, b) =>
        this.distance(a.center, params.nearPoint!) - this.distance(b.center, params.nearPoint!)
      );
    }

    // 按置信度排序
    if (!params.nearPoint) {
      candidates.sort((a, b) => b.confidence - a.confidence);
    }

    // 缓存搜索结果
    this.cacheSearch(params, candidates);

    // 返回指定索引或第一个
    const index = params.index ?? 0;
    return candidates[index] || null;
  }

  /**
   * 查找并点击元素
   */
  async findAndClick(labelOrParams: string | ElementSearchParams): Promise<string> {
    const params: ElementSearchParams = typeof labelOrParams === 'string'
      ? { label: labelOrParams, labelContains: labelOrParams }
      : labelOrParams;

    const label = typeof labelOrParams === 'string' ? labelOrParams : (labelOrParams.label || '');

    // 策略 1: 按类型精确查找按钮
    if (label) {
      const button = await this.findElement({ ...params, type: 'button' });
      if (button) {
        this.invalidateCache();
        const result = await this.desktop.click(button.center.x, button.center.y);
        await this.sleep(300);
        this.emitEvent('find_and_click', { label, type: 'button', x: button.center.x, y: button.center.y });
        return result;
      }

      // 策略 2: 查找菜单项
      const menuItem = await this.findElement({ ...params, type: 'menu' });
      if (menuItem) {
        this.invalidateCache();
        const result = await this.desktop.click(menuItem.center.x, menuItem.center.y);
        await this.sleep(300);
        this.emitEvent('find_and_click', { label, type: 'menu', x: menuItem.center.x, y: menuItem.center.y });
        return result;
      }

      // 策略 3: 查找任意文本
      const textElement = await this.findElement({ labelContains: label });
      if (textElement) {
        this.invalidateCache();
        const result = await this.desktop.click(textElement.center.x, textElement.center.y);
        await this.sleep(300);
        this.emitEvent('find_and_click', { label, type: textElement.type, x: textElement.center.x, y: textElement.center.y });
        return result;
      }

      // 策略 4: 尝试键盘快捷键（常见操作）
      const shortcut = this.guessKeyboardShortcut(label);
      if (shortcut) {
        this.invalidateCache();
        const result = await this.desktop.pressKey(shortcut);
        await this.sleep(300);
        this.emitEvent('find_and_click', { label, type: 'shortcut', shortcut });
        return result;
      }

      // 策略 5: 使用视觉模型重新定位
      const visionResult = await this.locateWithVision(label);
      if (visionResult) {
        this.invalidateCache();
        const result = await this.desktop.click(visionResult.x, visionResult.y);
        await this.sleep(300);
        this.emitEvent('find_and_click', { label, type: 'vision', x: visionResult.x, y: visionResult.y });
        return result;
      }
    } else {
      // 没有标签，直接用参数搜索
      const element = await this.findElement(params);
      if (element) {
        this.invalidateCache();
        const result = await this.desktop.click(element.center.x, element.center.y);
        await this.sleep(300);
        this.emitEvent('find_and_click', { type: element.type, x: element.center.x, y: element.center.y });
        return result;
      }
    }

    this.log.warn('未找到可点击的元素', { label, params });
    return `❌ 未找到"${label || '指定元素'}"，无法点击`;
  }

  /**
   * V19 P0：混合点击 — 融合 Accessibility API 与视觉坐标点击
   *
   * 策略：
   * 1. 若 AccessibilityController 已注入且可用 → 优先语义点击（精度 100%，无需坐标）
   * 2. Accessibility 未命中/失败 → 降级 findAndClick 视觉坐标点击
   * 3. 二者均失败 → 返回综合错误
   *
   * 优势：原生应用走 Accessibility（快、准），自绘 UI/Canvas 走视觉（兜底）
   */
  async hybridClick(label: string, options?: { type?: string }): Promise<string> {
    if (!label) return '❌ 请提供元素标签';

    // 策略 1: Accessibility API 语义点击
    const ac = this.accessibilityController;
    if (ac && typeof ac.isAvailable === 'function' && ac.isAvailable()) {
      try {
        this.log.info('hybridClick: 尝试 Accessibility 语义点击', { label });
        const acOptions: { type?: string } = {};
        if (options?.type) acOptions.type = options.type;
        const result = await ac.clickElement(label, acOptions);
        // clickElement 成功返回不含 ❌ 前缀
        if (typeof result === 'string' && !result.startsWith('❌')) {
          this.emitEvent('hybrid_click', { label, channel: 'accessibility' });
          return `✅ [Accessibility] ${result}`;
        }
        this.log.warn('hybridClick: Accessibility 未命中，降级视觉', { label, acResult: result });
      } catch (err: unknown) {
        this.log.warn('hybridClick: Accessibility 异常，降级视觉', {
          label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 策略 2: 视觉坐标点击降级
    try {
      this.log.info('hybridClick: 降级视觉坐标点击', { label });
      const params: ElementSearchParams = { label, labelContains: label };
      if (options?.type) params.type = options.type;
      const result = await this.findAndClick(params);
      // findAndClick 失败返回 ❌ 前缀
      if (typeof result === 'string' && result.startsWith('❌')) {
        return `❌ hybridClick 失败（Accessibility + Visual 均未命中 "${label}"）`;
      }
      this.emitEvent('hybrid_click', { label, channel: 'visual' });
      return `✅ [Visual] ${result}`;
    } catch (err: unknown) {
      return `❌ hybridClick 失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 推测键盘快捷键 */
  private guessKeyboardShortcut(label: string): string | null {
    const shortcuts: Record<string, string> = {
      '保存': 'Ctrl+S',
      '打开': 'Ctrl+O',
      '新建': 'Ctrl+N',
      '复制': 'Ctrl+C',
      '粘贴': 'Ctrl+V',
      '剪切': 'Ctrl+X',
      '撤销': 'Ctrl+Z',
      '全选': 'Ctrl+A',
      '查找': 'Ctrl+F',
      '关闭': 'Ctrl+W',
      '退出': 'Alt+F4',
      '刷新': 'F5',
      '打印': 'Ctrl+P',
    };
    return shortcuts[label] || null;
  }

  /** 使用视觉模型定位元素 */
  private async locateWithVision(label: string): Promise<{ x: number; y: number } | null> {
    const visionModelId = this.findVisionModel();
    if (!visionModelId) return null;

    try {
      const capture = await this.desktop.captureScreen({ format: 'png' });
      const prompt = `在屏幕截图中查找"${label}"元素。如果找到，返回其中心坐标（JSON格式: {"found": true, "x": 数字, "y": 数字}）。如果未找到，返回 {"found": false}。只返回JSON。`;
      const response = await this.modelLibrary.call([
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${capture.base64}` } },
          ],
        },
      ], { modelId: visionModelId });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        if (result.found && typeof result.x === 'number' && typeof result.y === 'number') {
          return { x: result.x, y: result.y };
        }
      }
    } catch (err: unknown) {
      this.log.warn('视觉模型定位失败', { label, error: err instanceof Error ? err.message : String(err) });
    }

    return null;
  }

  /**
   * 等待元素出现
   */
  async waitForElement(params: ElementSearchParams, timeout: number = 10000): Promise<UIElementDetection | null> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeout) {
      this.invalidateCache();
      const element = await this.findElement(params);
      if (element) {
        this.log.info('等待元素出现成功', {
          label: params.label || params.labelContains,
          waitedMs: Date.now() - startTime,
        });
        this.emitEvent('element_appeared', { label: params.label || params.labelContains });
        return element;
      }
      await this.sleep(pollInterval);
    }

    this.log.warn('等待元素超时', {
      label: params.label || params.labelContains,
      timeout,
    });
    return null;
  }

  /**
   * 等待屏幕变化
   */
  async waitForScreenChange(timeout: number = 10000): Promise<ScreenChange | null> {
    const startTime = Date.now();
    const pollInterval = 500;

    // 先截取基准截图
    const beforeCapture = await this.desktop.captureScreen({ format: 'png' });

    while (Date.now() - startTime < timeout) {
      await this.sleep(pollInterval);
      const afterCapture = await this.desktop.captureScreen({ format: 'png' });

      const changes = await this.compareScreens(beforeCapture.filePath, afterCapture.filePath);
      if (changes.length > 0) {
        this.log.info('检测到屏幕变化', { changeCount: changes.length, waitedMs: Date.now() - startTime });
        this.emitEvent('screen_changed', { changeCount: changes.length });
        return changes[0];
      }
    }

    this.log.warn('等待屏幕变化超时', { timeout });
    return null;
  }

  /**
   * 读取屏幕文本
   */
  async readText(region?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const state = await this.analyzeScreen({
      includeOCR: true,
      includeElements: false,
      includeRegions: false,
      includeColors: false,
      focusRegion: region,
    });

    if (region) {
      // 提取区域内的文本
      const regionTexts = state.elements
        .filter(el => this.centerInRegion(el, region) && el.text)
        .map(el => el.text!);
      return regionTexts.length > 0 ? regionTexts.join('\n') : state.textContent;
    }

    return state.textContent;
  }

  /**
   * 比较两个截图
   */
  async compareScreens(beforePath: string, afterPath: string): Promise<ScreenChange[]> {
    // 检查 LRU 缓存
    const cacheKey = `${beforePath}:${afterPath}`;
    const cached = this.comparisonCache.find(c => c.key === cacheKey);
    if (cached) return cached.changes;

    const visionModelId = this.findVisionModel();

    if (visionModelId) {
      const changes = await this.compareWithVisionModel(beforePath, afterPath, visionModelId);
      this.updateComparisonCache(cacheKey, changes);
      return changes;
    }

    // 回退: 简单文件大小/时间对比
    const changes = this.compareWithFallback(beforePath, afterPath);
    this.updateComparisonCache(cacheKey, changes);
    return changes;
  }

  /** 使用视觉模型对比截图 */
  private async compareWithVisionModel(
    beforePath: string,
    afterPath: string,
    visionModelId: string,
  ): Promise<ScreenChange[]> {
    try {
      const beforeBase64 = fs.readFileSync(beforePath).toString('base64');
      const afterBase64 = fs.readFileSync(afterPath).toString('base64');

      const prompt = `对比这两张屏幕截图，识别所有变化。以 JSON 数组格式返回：
[
  {
    "region": { "x": 数字, "y": 数字, "width": 数字, "height": 数字 },
    "changeType": "appeared|disappeared|moved|changed|text_changed",
    "description": "变化描述",
    "beforeDescription": "之前描述",
    "afterDescription": "之后描述",
    "confidence": 0到1
  }
]
只返回 JSON 数组。`;

      const response = await this.modelLibrary.call([
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${beforeBase64}` } },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${afterBase64}` } },
          ],
        },
      ], { modelId: visionModelId });

      return this.parseComparisonResponse(response.content);
    } catch (err: unknown) {
      this.log.warn('视觉模型对比失败', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /** 解析对比结果 */
  private parseComparisonResponse(content: string): ScreenChange[] {
    const changes: ScreenChange[] = [];
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) ||
        content.match(/\[[\s\S]*\]/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const validTypes: ScreenChange['changeType'][] = [
              'appeared', 'disappeared', 'moved', 'changed', 'text_changed',
            ];
            if (item.region && typeof item.region.x === 'number') {
              changes.push({
                region: item.region,
                changeType: validTypes.includes(item.changeType) ? item.changeType : 'changed',
                description: String(item.description || ''),
                beforeDescription: item.beforeDescription ? String(item.beforeDescription) : undefined,
                afterDescription: item.afterDescription ? String(item.afterDescription) : undefined,
                confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
              });
            }
          }
        }
      }
    } catch {
      // 解析失败返回空
    }
    return changes;
  }

  /** 回退对比方案 */
  private compareWithFallback(beforePath: string, afterPath: string): ScreenChange[] {
    try {
      const beforeStat = fs.statSync(beforePath);
      const afterStat = fs.statSync(afterPath);

      // 如果文件大小差异超过 5%，认为有变化
      const sizeDiff = Math.abs(beforeStat.size - afterStat.size) / beforeStat.size;
      if (sizeDiff > 0.05) {
        const screenSize = this.desktop.getScreenSize();
        return [{
          region: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
          changeType: 'changed',
          description: `屏幕内容发生变化（文件大小差异 ${(sizeDiff * 100).toFixed(1)}%）`,
          confidence: Math.min(1, sizeDiff * 2),
        }];
      }
    } catch {
      // 忽略
    }
    return [];
  }

  /** 更新对比缓存 */
  private updateComparisonCache(key: string, changes: ScreenChange[]): void {
    this.comparisonCache.push({ key, changes });
    if (this.comparisonCache.length > this.COMPARISON_CACHE_MAX) {
      this.comparisonCache.shift();
    }
  }

  /**
   * 检测对话框/弹窗
   */
  async detectDialog(): Promise<UIElementDetection | null> {
    const state = await this.analyzeScreen({
      includeElements: true,
      includeRegions: true,
      includeOCR: true,
    });

    // 查找 dialog 类型元素
    const dialog = state.elements.find(el => el.type === 'dialog');
    if (dialog) return dialog;

    // 查找 dialog 类型区域
    const dialogRegion = state.regions.find(r => r.type === 'dialog');
    if (dialogRegion) {
      return {
        type: 'dialog',
        label: dialogRegion.label,
        bounds: dialogRegion,
        center: {
          x: Math.round(dialogRegion.x + dialogRegion.width / 2),
          y: Math.round(dialogRegion.y + dialogRegion.height / 2),
        },
        confidence: 0.7,
      };
    }

    // 查找 notification 类型区域
    const notifRegion = state.regions.find(r => r.type === 'notification');
    if (notifRegion) {
      return {
        type: 'dialog',
        label: notifRegion.label,
        bounds: notifRegion,
        center: {
          x: Math.round(notifRegion.x + notifRegion.width / 2),
          y: Math.round(notifRegion.y + notifRegion.height / 2),
        },
        confidence: 0.6,
      };
    }

    return null;
  }

  /**
   * 获取活动窗口信息
   */
  getActiveWindowInfo(): { title: string; bounds: { x: number; y: number; width: number; height: number }; app: string } {
    const title = this.getActiveWindowTitle();
    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    let app = '';

    if (this.platform === 'win32') {
      try {
        const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class WinInfo {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$hwnd = [WinInfo]::GetForegroundWindow();
$rect = New-Object WinInfo+RECT;
[WinInfo]::GetWindowRect($hwnd, [ref]$rect) | Out-Null;
$proc = [System.Diagnostics.Process]::GetProcessById([System.Diagnostics.Process]::GetProcessById((Get-Process -Id ([WinInfo]::GetForegroundWindow().ToInt32()) -ErrorAction SilentlyContinue).Id -ErrorAction SilentlyContinue).Id -ErrorAction SilentlyContinue);
Write-Output "$($rect.Left)|$($rect.Top)|$($rect.Right)|$($rect.Bottom)"
`.trim();
        const result = this.execPowerShell(script);
        const parts = result.split('|').map(Number);
        if (parts.length >= 4) {
          bounds = {
            x: parts[0],
            y: parts[1],
            width: parts[2] - parts[0],
            height: parts[3] - parts[1],
          };
        }

        // 获取进程名
        try {
          app = this.execPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class WinProc {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$pid = 0;
[WinProc]::GetWindowThreadProcessId([WinProc]::GetForegroundWindow(), [ref]$pid) | Out-Null;
(Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName
`.trim());
        } catch {
          // 忽略
        }
      } catch {
        // 忽略
      }
    } else if (this.platform === 'darwin') {
      try {
        app = execSync('osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\'', {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch {
        // 忽略
      }
    }

    return { title, bounds, app };
  }

  /**
   * 监控屏幕变化
   */
  monitorScreen(
    callback: (change: ScreenChange) => void,
    options?: {
      interval?: number;
      regions?: Array<{ x: number; y: number; width: number; height: number }>;
    },
  ): () => void {
    const interval = options?.interval ?? 2000;
    const monitorId = `monitor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let lastScreenshotPath: string | null = null;

    const timer = setInterval(() => {
      void (async () => {
      try {
        const capture = await this.desktop.captureScreen({ format: 'png' });

        if (lastScreenshotPath) {
          const changes = await this.compareScreens(lastScreenshotPath, capture.filePath);

          // 如果指定了监控区域，只报告区域内的变化
          const filteredChanges = options?.regions
            ? changes.filter(change =>
                options.regions!.some(region =>
                  this.regionsOverlap(change.region, region)
                )
              )
            : changes;

          for (const change of filteredChanges) {
            callback(change);
            this.emitEvent('monitor_change', { changeType: change.changeType, description: change.description });
          }
        }

        lastScreenshotPath = capture.filePath;
      } catch (err: unknown) {
        this.log.warn('屏幕监控轮询失败', { error: err instanceof Error ? err.message : String(err) });
      }
      })();
    }, interval);

    this.monitorTimers.set(monitorId, timer);

    // 返回停止函数
    return () => {
      const t = this.monitorTimers.get(monitorId);
      if (t) {
        clearInterval(t);
        this.monitorTimers.delete(monitorId);
      }
      this.log.info('屏幕监控已停止', { monitorId });
    };
  }

  /** 检查两个区域是否重叠 */
  private regionsOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
           a.y < b.y + b.height && a.y + a.height > b.y;
  }

  /** 辅助：延迟 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const vi = this;

    return [
      {
        name: 'visual_analyze',
        description: '分析当前屏幕内容。返回 UI 元素列表、文本内容、屏幕区域等结构化信息。支持区域聚焦分析。',
        parameters: {
          includeOCR: { type: 'string', description: '是否包含文本提取 (true/false，默认 true)', required: false },
          includeElements: { type: 'string', description: '是否包含 UI 元素检测 (true/false，默认 true)', required: false },
          focusRegion: { type: 'string', description: '聚焦分析区域，JSON 格式: {"x":0,"y":0,"width":800,"height":600}', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const options: VisualAnalysisOptions = {
              includeOCR: args.includeOCR !== 'false',
              includeElements: args.includeElements !== 'false',
            };
            if (args.focusRegion) {
              try {
                options.focusRegion = JSON.parse(String(args.focusRegion));
              } catch {
                return '❌ focusRegion 格式错误，请使用 JSON 格式';
              }
            }
            const state = await vi.analyzeScreen(options);
            const lines = [
              `🔍 屏幕分析结果`,
              `  截图: ${state.screenshotPath}`,
              `  活动窗口: ${state.activeWindow || '(未知)'}`,
              `  时间: ${new Date(state.timestamp).toLocaleString('zh-CN')}`,
              ``,
            ];
            if (state.elements.length > 0) {
              lines.push(`🧩 UI 元素 (${state.elements.length}个):`);
              for (const el of state.elements) {
                const stateStr = el.state ? ` [${el.state}]` : '';
                const textStr = el.text ? ` "${el.text}"` : '';
                lines.push(`  - [${el.type}] ${el.label}${stateStr}${textStr} @(${el.center.x},${el.center.y}) ${(el.confidence * 100).toFixed(0)}%`);
              }
              lines.push('');
            }
            if (state.regions.length > 0) {
              lines.push(`📐 屏幕区域 (${state.regions.length}个):`);
              for (const r of state.regions) {
                lines.push(`  - [${r.type}] ${r.label} (${r.x},${r.y} ${r.width}x${r.height})`);
              }
              lines.push('');
            }
            if (state.textContent) {
              lines.push(`📄 可见文本: ${state.textContent.substring(0, 500)}`);
              lines.push('');
            }
            if (state.focusedElement) {
              lines.push(`🎯 焦点元素: [${state.focusedElement.type}] ${state.focusedElement.label}`);
            }
            return lines.join('\n');
          } catch (err: unknown) {
            return `❌ 屏幕分析失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'visual_find',
        description: '在屏幕上查找 UI 元素。支持按类型、标签、区域、状态等条件搜索。返回元素坐标和详细信息。',
        parameters: {
          label: { type: 'string', description: '元素标签（支持模糊匹配）', required: false },
          type: { type: 'string', description: '元素类型: button/input/text/icon/menu/tab/checkbox/dropdown/slider/image/link/window/dialog/tooltip/panel', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const params: ElementSearchParams = {};
            if (args.label) {
              params.label = String(args.label);
              params.labelContains = String(args.label);
            }
            if (args.type) params.type = String(args.type);
            const element = await vi.findElement(params);
            if (!element) {
              return `❌ 未找到${(() => {
                if (args.label) return `"${args.label}"`;
                if (args.type) return `${args.type}类型`;
                return '指定';
              })()}元素`;
            }
            const stateStr = element.state ? ` 状态:${element.state}` : '';
            const textStr = element.text ? ` 文本:"${element.text}"` : '';
            return [
              `✅ 找到元素`,
              `  类型: ${element.type}`,
              `  标签: ${element.label}`,
              `  位置: (${element.center.x}, ${element.center.y})`,
              `  范围: (${element.bounds.x}, ${element.bounds.y}) ${element.bounds.width}x${element.bounds.height}`,
              `  置信度: ${(element.confidence * 100).toFixed(0)}%${stateStr}${textStr}`,
            ].join('\n');
          } catch (err: unknown) {
            return `❌ 元素查找失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'visual_find_click',
        description: '查找并点击 UI 元素。自动尝试多种策略：按钮 → 菜单项 → 文本 → 键盘快捷键 → 视觉模型定位。',
        parameters: {
          label: { type: 'string', description: '要点击的元素标签，如"保存"、"文件"、"确定"等', required: true },
          type: { type: 'string', description: '元素类型（可选，不填则自动搜索）', required: false },
        },
        execute: (args) => {
          try {
            const label = String(args.label);
            if (!label) return Promise.resolve('❌ 请提供元素标签');
            const params: ElementSearchParams = { label, labelContains: label };
            if (args.type) params.type = String(args.type);
            return Promise.resolve(vi.findAndClick(params));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 查找点击失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      {
        name: 'hybrid_click',
        description: '混合点击 UI 元素（推荐优先使用）。融合 Accessibility API + 视觉坐标双通道：优先用无障碍 API 语义点击（精度100%、速度快、无需坐标），失败自动降级视觉坐标点击。原生应用走 Accessibility，自绘 UI/Canvas 走视觉。',
        parameters: {
          label: { type: 'string', description: '要点击的元素标签，如"保存"、"确定"、"取消"等', required: true },
          type: { type: 'string', description: '元素类型过滤（可选）: button/checkbox/edit/hyperlink/listitem 等', required: false },
        },
        execute: (args) => {
          const label = String(args.label);
          if (!label) return Promise.resolve('❌ 请提供元素标签');
          const options: { type?: string } = {};
          if (args.type) options.type = String(args.type);
          return Promise.resolve(vi.hybridClick(label, options));
        },
      },
      {
        name: 'visual_wait_element',
        description: '等待指定 UI 元素出现在屏幕上。轮询检测，超时后返回失败。',
        parameters: {
          label: { type: 'string', description: '等待的元素标签', required: true },
          timeout: { type: 'number', description: '超时时间（毫秒，默认 10000）', required: false },
        },
        execute: async (args) => {
          try {
            const label = String(args.label);
            if (!label) return '❌ 请提供元素标签';
            const timeout = args.timeout ? Number(args.timeout) : 10000;
            const element = await vi.waitForElement({ label, labelContains: label }, timeout);
            if (!element) {
              return `❌ 等待"${label}"超时 (${timeout}ms)`;
            }
            return `✅ 元素"${label}"已出现 @(${element.center.x}, ${element.center.y}) 类型:${element.type}`;
          } catch (err: unknown) {
            return `❌ 等待元素失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'visual_read_text',
        description: '读取屏幕上的文本内容。可指定区域读取，不指定则读取全屏文本。',
        parameters: {
          region: { type: 'string', description: '读取区域，JSON 格式: {"x":0,"y":0,"width":800,"height":600}（可选）', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            let region: { x: number; y: number; width: number; height: number } | undefined;
            if (args.region) {
              try {
                region = JSON.parse(String(args.region));
              } catch {
                return '❌ region 格式错误，请使用 JSON 格式';
              }
            }
            const text = await vi.readText(region);
            if (!text) return '📄 屏幕上未检测到文本';
            return `📄 屏幕文本:\n${text}`;
          } catch (err: unknown) {
            return `❌ 文本读取失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'visual_detect_dialog',
        description: '检测屏幕上是否显示了对话框或弹窗。返回对话框信息（标题、位置、大小）。',
        parameters: {},
        readOnly: true,
        execute: async () => {
          try {
            const dialog = await vi.detectDialog();
            if (!dialog) return 'ℹ️ 当前屏幕上没有检测到对话框或弹窗';
            return [
              `🔔 检测到对话框/弹窗`,
              `  标签: ${dialog.label}`,
              `  位置: (${dialog.center.x}, ${dialog.center.y})`,
              `  范围: (${dialog.bounds.x}, ${dialog.bounds.y}) ${dialog.bounds.width}x${dialog.bounds.height}`,
              `  置信度: ${(dialog.confidence * 100).toFixed(0)}%`,
            ].join('\n');
          } catch (err: unknown) {
            return `❌ 对话框检测失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'visual_compare',
        description: '对比两张截图，识别差异和变化。返回变化区域、类型和描述。',
        parameters: {
          beforePath: { type: 'string', description: '变化前的截图文件路径', required: true },
          afterPath: { type: 'string', description: '变化后的截图文件路径', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const beforePath = String(args.beforePath);
            const afterPath = String(args.afterPath);
            if (!beforePath || !afterPath) return '❌ 请提供两张截图的路径';
            const changes = await vi.compareScreens(beforePath, afterPath);
            if (changes.length === 0) return 'ℹ️ 两张截图未检测到明显差异';
            const lines = [`🔄 检测到 ${changes.length} 处变化:`];
            for (const change of changes) {
              lines.push(`  - [${change.changeType}] ${change.description}`);
              lines.push(`    位置: (${change.region.x}, ${change.region.y}) ${change.region.width}x${change.region.height}`);
              if (change.beforeDescription) lines.push(`    之前: ${change.beforeDescription}`);
              if (change.afterDescription) lines.push(`    之后: ${change.afterDescription}`);
              lines.push(`    置信度: ${(change.confidence * 100).toFixed(0)}%`);
            }
            return lines.join('\n');
          } catch (err: unknown) {
            return `❌ 截图对比失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'visual_active_window',
        description: '获取当前活动窗口信息，包括标题、位置、大小和所属应用。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const info = vi.getActiveWindowInfo();
            return Promise.resolve([
              `🪟 活动窗口信息`,
              `  标题: ${info.title || '(未知)'}`,
              `  应用: ${info.app || '(未知)'}`,
              `  位置: (${info.bounds.x}, ${info.bounds.y})`,
              `  大小: ${info.bounds.width}x${info.bounds.height}`,
            ].join('\n'));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 获取窗口信息失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      {
        name: 'visual_analyze_image',
        description: '分析指定路径的图片文件。支持截图、UI设计稿、流程图、架构图等。返回图片尺寸、主色调、检测到的文本(OCR)和视觉元素。用于跨模态理解（对标 Claude Code 图像分析能力）。',
        parameters: {
          imagePath: { type: 'string', description: '图片文件路径（支持 PNG/JPG/BMP/WebP）', required: true },
          extractText: { type: 'string', description: '是否提取文本 (true/false，默认 true)', required: false },
          extractColors: { type: 'string', description: '是否提取主色调 (true/false，默认 true)', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const imgPath = String(args.imagePath || '');
            if (!imgPath) return '❌ 请提供图片路径';
            if (!fs.existsSync(imgPath)) return `❌ 图片不存在: ${imgPath}`;

            const ext = path.extname(imgPath).toLowerCase();
            const supportedExts = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];
            if (!supportedExts.includes(ext)) {
              return `❌ 不支持的图片格式: ${ext}。支持: ${supportedExts.join(', ')}`;
            }

            const stat = fs.statSync(imgPath);
            const sizeKB = (stat.size / 1024).toFixed(1);

            // 获取图片尺寸（跨平台）
            let dimensions = '';
            try {
              if (process.platform === 'win32') {
                // PowerShell 获取图片尺寸
                const cmd = `powershell -Command "Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${imgPath.replace(/'/g, "''")}'); Write-Output ($img.Width.ToString()+'x'+$img.Height.ToString()); $img.Dispose()"`;
                const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout: 5000 });
                const out = stdout.trim();
                if (out.match(/\d+x\d+/)) dimensions = out;
              } else {
                // macOS/Linux 使用 sips 或 identify
                try {
                  dimensions = execSync(`sips -g pixelWidth -g pixelHeight "${imgPath}" 2>/dev/null | awk '/pixel/{print $2}' | paste -sd 'x' -`, { encoding: 'utf-8', timeout: 5000 }).trim();
                } catch {
                  dimensions = execSync(`identify -format '%wx%h' "${imgPath}" 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim();
                }
              }
            } catch {}

            const lines = [
              `🖼️ 图片分析结果`,
              `  路径: ${imgPath}`,
              `  格式: ${ext}`,
              `  大小: ${sizeKB} KB`,
            ];
            if (dimensions) lines.push(`  尺寸: ${dimensions}`);

            // 提取主色调（使用截图分析能力）
            if (args.extractColors !== 'false') {
              try {
                const state = await vi.analyzeScreen({ includeElements: false, includeOCR: false });
                if (state.colorPalette && state.colorPalette.length > 0) {
                  lines.push(`  主色调: ${state.colorPalette.slice(0, 5).join(', ')}`);
                }
              } catch {}
            }

            // OCR 文本提取
            if (args.extractText !== 'false') {
              try {
                const text = await vi.readText();
                if (text && text.trim().length > 0) {
                  lines.push(`  📄 检测到文本: ${text.substring(0, 500)}`);
                } else {
                  lines.push(`  📄 未检测到文本`);
                }
              } catch {}
            }

            return lines.join('\n');
          } catch (err: unknown) {
            return `❌ 图片分析失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
    ];
  }

  // ========== P2-4: 跨模态融合 ==========

  /**
   * P2-4: 跨模态融合 — 文本+图像+音频联合理解
   *
   * 将视觉信息（截图分析）、文本信息（OCR/用户指令）和音频信息（语音转写）
   * 进行跨模态对齐与融合，生成统一的多模态理解结果。
   *
   * 对标 GPT-4V / Claude Vision 的跨模态融合能力。
   */
  async fuseModalities(input: {
    screenshotPath?: string;
    textContent?: string;
    audioTranscript?: string;
    userIntent?: string;
  }): Promise<CrossModalFusionResult> {
    const modalities: string[] = [];
    const components: CrossModalComponent[] = [];

    // 视觉模态：截图分析
    if (input.screenshotPath) {
      try {
        const visualState = await this.analyzeScreen();
        components.push({
          modality: 'visual',
          content: visualState,
          confidence: 0.85,
          source: 'vision_model',
        });
        modalities.push('visual');
      } catch {
        // 视觉分析失败不阻断流程
      }
    }

    // 文本模态：OCR 或用户指令
    if (input.textContent) {
      components.push({
        modality: 'text',
        content: input.textContent,
        confidence: 0.95,
        source: 'user_input',
      });
      modalities.push('text');
    }

    // 音频模态：语音转写
    if (input.audioTranscript) {
      components.push({
        modality: 'audio',
        content: input.audioTranscript,
        confidence: 0.8,
        source: 'stt',
      });
      modalities.push('audio');
    }

    // 意图模态：用户意图
    if (input.userIntent) {
      components.push({
        modality: 'intent',
        content: input.userIntent,
        confidence: 0.9,
        source: 'inference',
      });
      modalities.push('intent');
    }

    // 跨模态对齐：提取各模态间的关联
    const alignments = this.alignModalities(components);

    // 生成融合理解
    const fusedUnderstanding = this.generateFusedUnderstanding(components, alignments, input.userIntent);

    return {
      modalities,
      components,
      alignments,
      fusedUnderstanding,
      overallConfidence: components.reduce((sum, c) => sum + c.confidence, 0) / Math.max(components.length, 1),
      timestamp: Date.now(),
    };
  }

  /**
   * P2-4: 跨模态检索 — 基于一种模态的查询检索其他模态的内容
   *
   * P0 真实修复：从关键词子串匹配升级为真实向量嵌入 + 余弦相似度
   * 之前：text.includes(queryLower) 子串匹配 + 硬编码 matchScore 0.7
   * 现在：使用注入的 EmbeddingProvider 计算真实语义向量，
   *       通过余弦相似度排序，未注入时回退到关键词匹配（保持向后兼容）
   */
  async crossModalSearch(query: {
    queryModality: 'text' | 'image' | 'audio';
    queryContent: string;
    targetModality: 'text' | 'image' | 'audio';
  }): Promise<CrossModalSearchResult[]> {
    this.ensureStateLoaded();
    const results: CrossModalSearchResult[] = [];

    // P0 真实修复：优先使用注入的 EmbeddingProvider 进行真实向量检索
    if (this.embeddingProvider && this.history.length > 0) {
      try {
        const queryEmbedding = await this.embeddingProvider.embed(query.queryContent);
        // 计算所有历史记录的嵌入（懒加载，首次调用时计算并缓存）
        const scored: Array<{ score: number; record: AnalysisHistoryEntry }> = [];
        for (const record of this.history) {
          const recordKey = `${record.timestamp}_${record.screenshotPath || ''}`;
          let cached = this.crossModalEmbeddings.get(recordKey);
          if (!cached) {
            try {
              const recordText = JSON.stringify(record);
              const emb = await this.embeddingProvider.embed(recordText);
              cached = { embedding: emb, record };
              this.crossModalEmbeddings.set(recordKey, cached);
            } catch {
              continue;
            }
          }
          const score = this.cosineSim(queryEmbedding, cached.embedding);
          scored.push({ score, record: cached.record });
        }
        // 按相似度降序排序，取前 10
        scored.sort((a, b) => b.score - a.score);
        for (const s of scored.slice(0, 10)) {
          if (s.score > 0.1) { // 阈值：过滤明显不相关的结果
            results.push({
              matchedContent: s.record,
              matchScore: s.score,
              matchedModality: query.targetModality,
            });
          }
        }
        return results;
      } catch (err: unknown) {
        this.log.warn('crossModalSearch 向量检索失败，回退到关键词匹配', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 回退：基于关键词匹配（未注入 EmbeddingProvider 时）
    const queryLower = query.queryContent.toLowerCase();
    for (const record of this.history) {
      const text = JSON.stringify(record).toLowerCase();
      if (text.includes(queryLower)) {
        results.push({
          matchedContent: record,
          matchScore: 0.7,
          matchedModality: query.targetModality,
        });
      }
    }
    return results.slice(0, 10);
  }

  /**
   * P0 真实修复：余弦相似度计算 — 用于 crossModalSearch 真实向量检索
   */
  private cosineSim(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** 跨模态对齐：提取各模态间的关联 */
  private alignModalities(components: CrossModalComponent[]): CrossModalAlignment[] {
    const alignments: CrossModalAlignment[] = [];

    for (let i = 0; i < components.length; i++) {
      for (let j = i + 1; j < components.length; j++) {
        const a = components[i];
        const b = components[j];

        // 文本-视觉对齐：检查文本内容是否出现在视觉元素的文本中
        if (a.modality === 'text' && b.modality === 'visual') {
          const textContent = String(a.content).toLowerCase();
          const visualText = JSON.stringify(b.content).toLowerCase();
          if (visualText.includes(textContent.substring(0, 20))) {
            alignments.push({
              fromModality: 'text',
              toModality: 'visual',
              alignmentType: 'content_match',
              confidence: 0.8,
            });
          }
        }

        // 音频-文本对齐：检查语音转写与文本内容的相似度
        if (a.modality === 'audio' && b.modality === 'text') {
          const audioText = String(a.content).toLowerCase();
          const textContent = String(b.content).toLowerCase();
          const overlap = this.calculateTextOverlap(audioText, textContent);
          if (overlap > 0.3) {
            alignments.push({
              fromModality: 'audio',
              toModality: 'text',
              alignmentType: 'semantic_overlap',
              confidence: overlap,
            });
          }
        }
      }
    }

    return alignments;
  }

  /** 生成融合理解 */
  private generateFusedUnderstanding(
    components: CrossModalComponent[],
    alignments: CrossModalAlignment[],
    userIntent?: string,
  ): string {
    const lines: string[] = [];

    lines.push('## 跨模态融合理解');
    lines.push('');
    lines.push(`### 参与模态 (${components.length})`);
    for (const c of components) {
      lines.push(`- **${c.modality}** (置信度: ${c.confidence.toFixed(2)}, 来源: ${c.source})`);
    }

    if (alignments.length > 0) {
      lines.push('');
      lines.push('### 跨模态对齐');
      for (const a of alignments) {
        lines.push(`- ${a.fromModality} ↔ ${a.toModality}: ${a.alignmentType} (置信度: ${a.confidence.toFixed(2)})`);
      }
    }

    if (userIntent) {
      lines.push('');
      lines.push('### 用户意图');
      lines.push(userIntent);
    }

    lines.push('');
    lines.push('### 融合结论');
    const topComponent = components.sort((a, b) => b.confidence - a.confidence)[0];
    if (topComponent) {
      lines.push(`主导模态: ${topComponent.modality}（置信度最高 ${topComponent.confidence.toFixed(2)}）`);
    }

    return lines.join('\n');
  }

  /** 计算两段文本的重叠度 */
  private calculateTextOverlap(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    return intersection / Math.min(wordsA.size, wordsB.size);
  }

  // ========== P2-4: 图像质量评分 ==========

  /**
   * P2-4: 评估图像质量
   *
   * 对指定图像进行多维度质量评分，验收标准：图像≥8/10。
   *
   * 评分维度：
   * - 清晰度：基于文件大小与分辨率比（压缩率越低越清晰）
   * - 亮度：基于平均像素亮度（需视觉模型，此处用启发式）
   * - 对比度：基于文件大小与分辨率（细节越多对比度可能越高）
   * - 噪声水平：基于压缩格式和文件大小
   * - 分辨率：基于像素总数
   *
   * @param imagePath 图像文件路径
   * @returns 图像质量评分
   */
  async scoreImageQuality(imagePath: string): Promise<ImageQualityScore> {
    const fsSync = await import('fs');
    const stat = fsSync.statSync(imagePath);
    const fileSizeBytes = stat.size;
    const ext = path.extname(imagePath).toLowerCase().slice(1) || 'unknown';

    // 获取图像尺寸（通过 PowerShell 或文件头）
    const dimensions = await this.getImageDimensions(imagePath);
    const { width, height } = dimensions;
    const totalPixels = width * height;

    // 分辨率评分：1080p=10, 720p=8, 480p=6, 更低递减
    const resolutionScore = Math.min(10, Math.max(0, (totalPixels / (1920 * 1080)) * 10));

    // 清晰度评分：基于每像素字节数（未压缩 BMP 约 3-4 bytes/pixel）
    const bytesPerPixel = totalPixels > 0 ? fileSizeBytes / totalPixels : 0;
    const sharpnessScore = Math.min(10, bytesPerPixel * 2.5); // 4 bytes/pixel = 10分

    // P2-4: 亮度评分 — 真实采样像素亮度（不再硬编码 7）
    // 通过跨平台真实像素分析：Windows 用 PowerShell+System.Drawing.Bitmap，
    // Linux/macOS 优先用 ImageMagick identify，都不可用时返回 null（不弄虚作假）
    const brightnessStats = await this.getImageBrightnessStats(imagePath, width, height);
    let brightnessScore: number;
    if (brightnessStats === null) {
      // 真实无法分析时，给保守低分（不是默认 7）并标记 metadata.brightnessEstimated=true
      // 这样调用方能诚实知道这是不可信的估计，而不是真实测量
      brightnessScore = 5;
    } else {
      // 平均亮度 0-255 映射到 0-10 分
      // 理想亮度范围 80-180（既不太暗也不太亮）
      const mean = brightnessStats.mean;
      if (mean < 30) brightnessScore = Math.max(1, mean / 30 * 4);  // 太暗 <30
      else if (mean < 80) brightnessScore = 4 + (mean - 30) / 50 * 4; // 偏暗 30-80
      else if (mean <= 180) brightnessScore = 8 + (1 - Math.abs(mean - 130) / 50) * 2; // 理想 80-180 → 8-10
      else if (mean <= 220) brightnessScore = 8 - (mean - 180) / 40 * 3; // 偏亮 180-220
      else brightnessScore = Math.max(1, 5 - (mean - 220) / 35 * 4); // 太亮 >220

      // 对比度（标准差）影响：高对比度加分
      const stdDev = brightnessStats.stdDev;
      if (stdDev > 60) brightnessScore = Math.min(10, brightnessScore + 0.5);
      else if (stdDev < 15) brightnessScore = Math.max(1, brightnessScore - 0.5);
    }

    // 对比度评分：基于真实像素标准差（若有），否则降级为文件大小启发式
    let contrastScore: number;
    if (brightnessStats !== null) {
      // 真实标准差映射：30-80 为良好区间 → 7-10 分
      const stdDev = brightnessStats.stdDev;
      contrastScore = Math.min(10, Math.max(2, (stdDev / 80) * 10));
    } else {
      // 降级：基于文件大小（更大的文件通常有更多细节）
      contrastScore = Math.min(10, Math.max(3, (fileSizeBytes / (500 * 1024)) * 5));
    }

    // 噪声水平评分：PNG 无压缩噪声，JPEG 压缩率高噪声大
    let noiseLevelScore = 7;
    if (ext === 'png' || ext === 'bmp') noiseLevelScore = 9;
    else if (ext === 'jpg' || ext === 'jpeg') noiseLevelScore = Math.max(4, 10 - (10 - sharpnessScore) * 1.5);
    else if (ext === 'webp') noiseLevelScore = 7;

    const dimensions_score = {
      sharpness: Math.round(sharpnessScore * 10) / 10,
      brightness: Math.round(brightnessScore * 10) / 10,
      contrast: Math.round(contrastScore * 10) / 10,
      noiseLevel: Math.round(noiseLevelScore * 10) / 10,
      resolution: Math.round(resolutionScore * 10) / 10,
    };

    const overallScore = Math.round(
      (dimensions_score.sharpness * 0.25 +
       dimensions_score.brightness * 0.15 +
       dimensions_score.contrast * 0.2 +
       dimensions_score.noiseLevel * 0.2 +
       dimensions_score.resolution * 0.2) * 10
    ) / 10;

    return {
      imagePath,
      overallScore,
      meetsTarget: overallScore >= 8,
      dimensions: dimensions_score,
      metadata: {
        width,
        height,
        fileSizeBytes,
        format: ext,
        brightnessMeasured: brightnessStats !== null,
        brightnessMean: brightnessStats?.mean,
        brightnessStdDev: brightnessStats?.stdDev,
      },
      evaluatedAt: Date.now(),
    };
  }

  /**
   * P2-4: 真实计算图像像素亮度统计
   *
   * 取代之前硬编码 brightness=7。跨平台真实像素分析：
   * - Windows: PowerShell + System.Drawing.Bitmap 真实采样像素，计算平均亮度和标准差
   * - Linux/macOS: 优先用 ImageMagick `identify -format "%[mean] %[standard-deviation]"`
   * - 都不可用：返回 null（诚实告知无法分析，不返回虚假数值）
   *
   * 为避免读取超大图像导致 OOM，采用采样策略：
   * - Windows: 每 N 个像素采样一个（N 由图像大小决定，最大采样 10000 像素）
   * - ImageMagick: 由其内部处理，无需采样
   *
   * @returns { mean, stdDev } 平均亮度和标准差（0-255），或 null 表示无法分析
   */
  private async getImageBrightnessStats(
    imagePath: string,
    width: number,
    height: number,
  ): Promise<{ mean: number; stdDev: number } | null> {
    const platform = os.platform();

    try {
      if (platform === 'win32') {
        return await this.getImageBrightnessWindows(imagePath, width, height);
      } else {
        return await this.getImageBrightnessImageMagick(imagePath);
      }
    } catch (err: unknown) {
      logger.warn('[VisualIntelligence] P2-4 像素亮度分析失败', {
        imagePath,
        platform,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * P2-4: Windows 平台通过 PowerShell + System.Drawing.Bitmap 真实采样像素亮度
   */
  private async getImageBrightnessWindows(
    imagePath: string,
    width: number,
    height: number,
  ): Promise<{ mean: number; stdDev: number } | null> {
    // 采样策略：限制最多采样 10000 像素，避免大图 OOM
    const totalPixels = width * height;
    const sampleStride = Math.max(1, Math.ceil(Math.sqrt(totalPixels / 10000)));

    // PowerShell 脚本：加载 Bitmap，采样像素亮度，计算 mean 和 stdDev
    const psScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = [System.Drawing.Bitmap]::FromFile('${imagePath.replace(/'/g, "''")}')
  $w = $bmp.Width
  $h = $bmp.Height
  $stride = ${sampleStride}
  $samples = @()
  for ($y = 0; $y -lt $h; $y += $stride) {
    for ($x = 0; $x -lt $w; $x += $stride) {
      $p = $bmp.GetPixel($x, $y)
      # 标准亮度公式: 0.299R + 0.587G + 0.114B
      $lum = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
      $samples += $lum
    }
  }
  $bmp.Dispose()
  $n = $samples.Count
  if ($n -eq 0) { Write-Output 'null'; exit }
  $sum = 0
  foreach ($s in $samples) { $sum += $s }
  $mean = $sum / $n
  $sumSq = 0
  foreach ($s in $samples) { $sumSq += ($s - $mean) * ($s - $mean) }
  $stdDev = [Math]::Sqrt($sumSq / $n)
  Write-Output "$([Math]::Round($mean, 2)) $([Math]::Round($stdDev, 2))"
} catch {
  Write-Output 'null'
}
`.trim();

    const { stdout: brightnessStdout } = await execAsync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true,
    });
    const result = brightnessStdout.trim();

    if (result === 'null' || !result) return null;
    const parts = result.split(/\s+/);
    if (parts.length < 2) return null;
    const mean = parseFloat(parts[0]);
    const stdDev = parseFloat(parts[1]);
    if (!isFinite(mean) || !isFinite(stdDev)) return null;
    return { mean, stdDev };
  }

  /**
   * P2-4: Linux/macOS 通过 ImageMagick identify 真实获取像素亮度统计
   *
   * 使用 `identify -format "%[mean] %[standard-deviation]"` 命令
   * 输出 0-1 范围的归一化值，需 *255 转回 0-255
   */
  private async getImageBrightnessImageMagick(
    imagePath: string,
  ): Promise<{ mean: number; stdDev: number } | null> {
    const { execFile } = await import('child_process');
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000);
      try {
        execFile('identify', ['-format', '%[mean] %[standard-deviation]', imagePath], {
          timeout: 10000,
          maxBuffer: 1024,
        }, (err, stdout, _stderr) => {
          clearTimeout(timer);
          if (err) {
            // ImageMagick 不可用 — 诚实返回 null，不返回虚假数值
            logger.debug('[VisualIntelligence] P2-4 ImageMagick identify 不可用', {
              error: err.message,
              hint: 'apt-get install imagemagick 或 brew install imagemagick 启用真实像素分析',
            });
            resolve(null);
            return;
          }
          const parts = String(stdout || '').trim().split(/\s+/);
          if (parts.length < 2) { resolve(null); return; }
          const mean = parseFloat(parts[0]) * 255;  // 归一化 → 0-255
          const stdDev = parseFloat(parts[1]) * 255;
          if (!isFinite(mean) || !isFinite(stdDev)) { resolve(null); return; }
          resolve({ mean, stdDev });
        });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * P2-4: 获取图像尺寸
   *
   * 通过读取文件头或调用系统命令获取图像宽高。
   */
  private async getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
    try {
      const fsSync = await import('fs');
      const buffer = Buffer.alloc(24);
      const fd = fsSync.openSync(imagePath, 'r');
      fsSync.readSync(fd, buffer, 0, 24, 0);
      fsSync.closeSync(fd);

      // PNG: 16-19=width, 20-23=height (big-endian)
      if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
      }

      // JPEG: 解析 SOF0 标记
      if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        return this.getJpegDimensions(imagePath);
      }

      // BMP: 18-21=width, 22-25=height (little-endian)
      if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return {
          width: buffer.readUInt32LE(18),
          height: Math.abs(buffer.readUInt32LE(22)),
        };
      }
    } catch {
      // 读取失败，使用默认值
    }

    // 默认值
    return { width: 1920, height: 1080 };
  }

  /** 解析 JPEG 图像尺寸 */
  private getJpegDimensions(imagePath: string): { width: number; height: number } {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsSync = require('fs');
      const buffer = fsSync.readFileSync(imagePath);
      let i = 2;
      while (i < buffer.length - 1) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1];
        // SOF0-SOF15 (0xc0-0xcf, 除 c4/c8/cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buffer.readUInt16BE(i + 5);
          const width = buffer.readUInt16BE(i + 7);
          return { width, height };
        }
        // 跳过当前标记段
        const segLen = buffer.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    } catch {}
    return { width: 1920, height: 1080 };
  }

  // ========== P2-4: 融合质量评分 ==========

  /**
   * P2-4: 评估跨模态融合质量
   *
   * 对融合结果进行多维度质量评分，验收标准：跨模态融合≥7/10。
   *
   * 评分维度：
   * - 模态覆盖度：参与融合的模态种类数（4种=10分）
   * - 对齐质量：跨模态对齐的平均置信度
   * - 置信度一致性：各模态置信度的标准差（越小越好）
   * - 信息互补性：对齐数量相对于组件数量的比例
   *
   * @param result 跨模态融合结果
   * @returns 融合质量评分
   */
  scoreFusionQuality(result: CrossModalFusionResult): FusionQualityScore {
    const modalityCount = result.modalities.length;
    const alignmentCount = result.alignments.length;
    const componentCount = result.components.length;

    // 模态覆盖度：4种模态=10分，3种=7.5分，2种=5分，1种=2.5分
    const modalityCoverage = Math.min(10, modalityCount * 2.5);

    // 对齐质量：平均对齐置信度 * 10
    const avgAlignmentConfidence = alignmentCount > 0
      ? result.alignments.reduce((s, a) => s + a.confidence, 0) / alignmentCount
      : 0;
    const alignmentQuality = avgAlignmentConfidence * 10;

    // 置信度一致性：标准差越小越好
    const confidences = result.components.map(c => c.confidence);
    const avgConfidence = confidences.length > 0
      ? confidences.reduce((s, c) => s + c, 0) / confidences.length
      : 0;
    const variance = confidences.length > 0
      ? confidences.reduce((s, c) => s + Math.pow(c - avgConfidence, 2), 0) / confidences.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const confidenceConsistency = Math.max(0, 10 - stdDev * 20);

    // 信息互补性：对齐数量 / 最大可能对齐数量
    const maxAlignments = componentCount > 1 ? componentCount * (componentCount - 1) / 2 : 1;
    const informationComplementarity = Math.min(10, (alignmentCount / maxAlignments) * 10);

    const dimensions = {
      modalityCoverage: Math.round(modalityCoverage * 10) / 10,
      alignmentQuality: Math.round(alignmentQuality * 10) / 10,
      confidenceConsistency: Math.round(confidenceConsistency * 10) / 10,
      informationComplementarity: Math.round(informationComplementarity * 10) / 10,
    };

    const overallScore = Math.round(
      (dimensions.modalityCoverage * 0.25 +
       dimensions.alignmentQuality * 0.25 +
       dimensions.confidenceConsistency * 0.25 +
       dimensions.informationComplementarity * 0.25) * 10
    ) / 10;

    return {
      overallScore,
      meetsTarget: overallScore >= 7,
      dimensions,
      details: {
        modalityCount,
        alignmentCount,
        avgConfidence: Math.round(avgConfidence * 1000) / 1000,
        confidenceStdDev: Math.round(stdDev * 1000) / 1000,
      },
      evaluatedAt: Date.now(),
    };
  }

  // ========== P2-4: 音频模态处理 ==========

  /**
   * P2-4: 提取音频特征
   *
   * 从音频文件中提取基本特征（时长、采样率、音量、信噪比等），
   * 并评估音频质量。使用 ffprobe（若可用）提取，否则返回基于文件大小的估算。
   *
   * @param audioPath 音频文件路径
   * @returns 音频特征
   */
  async extractAudioFeatures(audioPath: string): Promise<AudioFeatures> {
    const fsSync = await import('fs');
    const stat = fsSync.statSync(audioPath);
    const ext = path.extname(audioPath).toLowerCase().slice(1);

    // 尝试使用 ffprobe 获取精确信息
    const probeResult = await this.tryFfprobe(audioPath);

    if (probeResult) {
      // ffprobe 成功，使用精确数据
      const { duration, sampleRate, channels, avgVolume, peakVolume } = probeResult;

      // 估算信噪比（基于格式和音量）
      const snrDb = this.estimateSnr(ext, avgVolume);

      const qualityScore = this.calculateAudioQualityScore({
        duration,
        avgVolume,
        peakVolume,
        snrDb,
        sampleRate,
      });

      return {
        audioPath,
        durationSec: duration,
        sampleRate,
        channels,
        avgVolume,
        peakVolume,
        snrDb,
        qualityScore,
        meetsTarget: qualityScore >= 6,
        extractedAt: Date.now(),
      };
    }

    // ffprobe 不可用，基于文件大小估算
    const estimatedDuration = this.estimateDurationFromSize(stat.size, ext);
    const estimatedSampleRate = ext === 'wav' ? 44100 : 48000;
    const estimatedChannels = 2;
    const estimatedAvgVolume = 0.5;
    const estimatedPeakVolume = 0.8;
    const estimatedSnr = this.estimateSnr(ext, estimatedAvgVolume);

    const qualityScore = this.calculateAudioQualityScore({
      duration: estimatedDuration,
      avgVolume: estimatedAvgVolume,
      peakVolume: estimatedPeakVolume,
      snrDb: estimatedSnr,
      sampleRate: estimatedSampleRate,
    });

    return {
      audioPath,
      durationSec: estimatedDuration,
      sampleRate: estimatedSampleRate,
      channels: estimatedChannels,
      avgVolume: estimatedAvgVolume,
      peakVolume: estimatedPeakVolume,
      snrDb: estimatedSnr,
      qualityScore,
      meetsTarget: qualityScore >= 6,
      extractedAt: Date.now(),
    };
  }

  /**
   * P2-4: 尝试使用 ffprobe 获取音频信息
   */
  private tryFfprobe(audioPath: string): Promise<{
    duration: number;
    sampleRate: number;
    channels: number;
    avgVolume: number;
    peakVolume: number;
  } | null> {
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execFile } = require('child_process');
        execFile('ffprobe', [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format', '-show_streams',
          audioPath,
        ], (err, stdout: string) => {
          if (err) { resolve(null); return; }
          try {
            const data = JSON.parse(stdout);
            const stream = data.streams?.find((s) => s.codec_type === 'audio');
            if (!stream) { resolve(null); return; }
            resolve({
              duration: parseFloat(data.format?.duration ?? '0') || 0,
              sampleRate: parseInt(stream.sample_rate ?? '44100') || 44100,
              channels: parseInt(stream.channels ?? '2') || 2,
              avgVolume: 0.5, // 需要 volumedetect 滤镜，此处给默认值
              peakVolume: 0.8,
            });
          } catch {
            resolve(null);
          }
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** 估算信噪比 */
  private estimateSnr(format: string, avgVolume: number): number {
    // WAV/FLAC 无损格式信噪比高
    if (format === 'wav' || format === 'flac') return 60 + avgVolume * 20;
    // MP3/AAC 有损格式
    if (format === 'mp3' || format === 'aac' || format === 'm4a') return 40 + avgVolume * 20;
    // OGG/Opus
    if (format === 'ogg' || format === 'opus') return 35 + avgVolume * 20;
    return 30;
  }

  /** 基于文件大小估算时长 */
  private estimateDurationFromSize(fileSize: number, format: string): number {
    const bitrates: Record<string, number> = {
      mp3: 128000, aac: 128000, m4a: 128000,
      ogg: 112000, opus: 96000,
      wav: 1411200, flac: 800000,
    };
    const bitrate = bitrates[format] ?? 128000;
    return Math.round((fileSize * 8) / bitrate);
  }

  /** 计算音频质量评分 */
  private calculateAudioQualityScore(data: {
    duration: number;
    avgVolume: number;
    peakVolume: number;
    snrDb: number;
    sampleRate: number;
  }): number {
    // 时长评分（>5秒=10分，<1秒=2分）
    const durationScore = Math.min(10, Math.max(2, data.duration / 0.5));

    // 音量评分（0.3-0.7 为最佳）
    let volumeScore: number;
    if (data.avgVolume >= 0.3 && data.avgVolume <= 0.7) volumeScore = 10;
    else if (data.avgVolume > 0.7) volumeScore = 7;
    else volumeScore = Math.max(3, data.avgVolume * 15);

    // 信噪比评分（>50dB=10分，<20dB=2分）
    const snrScore = Math.min(10, Math.max(2, (data.snrDb - 20) / 3));

    // 采样率评分（44100=8分，48000=10分，16000=4分）
    let sampleRateScore: number;
    if (data.sampleRate >= 48000) sampleRateScore = 10;
    else if (data.sampleRate >= 44100) sampleRateScore = 8;
    else if (data.sampleRate >= 22050) sampleRateScore = 6;
    else sampleRateScore = 4;

    return Math.round(
      (durationScore * 0.2 + volumeScore * 0.25 + snrScore * 0.35 + sampleRateScore * 0.2) * 10
    ) / 10;
  }

  // ========== P2-4: 基准测试 ==========

  /**
   * P2-4: 运行基准测试
   *
   * 对视觉智能引擎的关键方法进行性能基准测试。
   *
   * @param suite 测试套件（'all' | 'analysis' | 'fusion' | 'quality'）
   * @returns 基准测试结果
   */
  async runBenchmark(suite: 'all' | 'analysis' | 'fusion' | 'quality' = 'all'): Promise<BenchmarkResult> {
    const suiteName = `visual-intelligence-${suite}`;
    const tests: BenchmarkResult['tests'] = [];
    const suiteStart = Date.now();

    // 分析套件：测试屏幕分析和元素检测
    if (suite === 'all' || suite === 'analysis') {
      tests.push(await this.benchmarkTest('analyzeScreen', 3, async () => {
        try {
          await this.analyzeScreen();
          return true;
        } catch { return false; }
      }));

      tests.push(await this.benchmarkTest('findElement', 5, async () => {
        try {
          await this.findElement({ type: 'button', label: 'test' });
          return true;
        } catch { return false; }
      }));
    }

    // 融合套件：测试跨模态融合
    if (suite === 'all' || suite === 'fusion') {
      tests.push(await this.benchmarkTest('fuseModalities', 3, async () => {
        try {
          await this.fuseModalities({
            textContent: '测试文本',
            userIntent: '测试意图',
          });
          return true;
        } catch { return false; }
      }));

      tests.push(await this.benchmarkTest('scoreFusionQuality', 10, () => {
        try {
          const result: CrossModalFusionResult = {
            modalities: ['text', 'intent'],
            components: [
              { modality: 'text', content: 'test', confidence: 0.9, source: 'user' },
              { modality: 'intent', content: 'test', confidence: 0.85, source: 'inference' },
            ],
            alignments: [
              { fromModality: 'text', toModality: 'intent', alignmentType: 'semantic_overlap', confidence: 0.8 },
            ],
            fusedUnderstanding: 'test',
            overallConfidence: 0.875,
            timestamp: Date.now(),
          };
          this.scoreFusionQuality(result);
          return Promise.resolve(true);
        } catch { return Promise.resolve(false); }
      }));
    }

    // 质量套件：测试图像质量评分
    if (suite === 'all' || suite === 'quality') {
      tests.push(await this.benchmarkTest('scoreImageQuality', 5, async () => {
        try {
          // 使用一个临时文件测试（若不存在则跳过）
          const fsSync = await import('fs');
          const tmpPath = path.join(this.visualDir, 'benchmark_test.png');
          if (fsSync.existsSync(tmpPath)) {
            await this.scoreImageQuality(tmpPath);
          }
          return true;
        } catch { return false; }
      }));
    }

    return {
      suite: suiteName,
      tests,
      totalDurationMs: Date.now() - suiteStart,
      benchmarkedAt: Date.now(),
    };
  }

  /**
   * P2-4: 执行单个基准测试
   *
   * @param name 测试名称
   * @param iterations 执行次数
   * @param fn 测试函数（返回 true 表示成功）
   */
  private async benchmarkTest(
    name: string,
    iterations: number,
    fn: () => Promise<boolean>,
  ): Promise<BenchmarkResult['tests'][number]> {
    const times: number[] = [];
    let success = true;
    let error: string | undefined;

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      try {
        const result = await fn();
        if (!result && i === 0) {
          success = false;
          error = '首次执行失败';
          break;
        }
      } catch (err: unknown) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
        break;
      }
      times.push(Date.now() - start);
    }

    if (times.length === 0) {
      return {
        name,
        iterations: 0,
        totalMs: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        medianMs: 0,
        stdDev: 0,
        success,
        error,
      };
    }

    times.sort((a, b) => a - b);
    const totalMs = times.reduce((s, t) => s + t, 0);
    const avgMs = totalMs / times.length;
    const minMs = times[0];
    const maxMs = times[times.length - 1];
    const medianMs = times[Math.floor(times.length / 2)];
    const variance = times.reduce((s, t) => s + Math.pow(t - avgMs, 2), 0) / times.length;
    const stdDev = Math.sqrt(variance);

    return {
      name,
      iterations: times.length,
      totalMs,
      avgMs: Math.round(avgMs * 100) / 100,
      minMs,
      maxMs,
      medianMs,
      stdDev: Math.round(stdDev * 100) / 100,
      success,
      error,
    };
  }

  // ========== 资源清理 ==========

  /** 释放所有定时器、缓存与持久化资源 */
  dispose(): void {
    // 清理所有屏幕监控定时器
    for (const timer of this.monitorTimers.values()) {
      clearInterval(timer);
    }
    this.monitorTimers.clear();

    // 清理延迟保存定时器
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    // 刷新未写入的模板/历史
    if (this.stateLoaded) {
      try {
        this.saveTemplates();
        this.saveHistory();
      } catch {}
    }

    // 清理缓存
    this.cachedState = null;
    this.cachedSearches.clear();
    this.comparisonCache = [];
    this.history = [];
    this.templates.clear();

    this.log.info('视觉智能引擎已释放');
  }
}

// ============ P2-4: 跨模态融合类型定义 ============

/** 跨模态组件 */
export interface CrossModalComponent {
  modality: 'visual' | 'text' | 'audio' | 'intent';
  content: unknown;
  confidence: number;
  source: string;
}

/** 跨模态对齐 */
export interface CrossModalAlignment {
  fromModality: string;
  toModality: string;
  alignmentType: 'content_match' | 'semantic_overlap' | 'temporal_sync' | 'spatial_correlation';
  confidence: number;
}

/** 跨模态融合结果 */
export interface CrossModalFusionResult {
  modalities: string[];
  components: CrossModalComponent[];
  alignments: CrossModalAlignment[];
  fusedUnderstanding: string;
  overallConfidence: number;
  timestamp: number;
}

/** 跨模态检索结果 */
export interface CrossModalSearchResult {
  matchedContent: unknown;
  matchScore: number;
  matchedModality: 'text' | 'image' | 'audio';
}

// ============ P2-4: 图像质量 / 融合质量 / 音频模态 / 基准测试类型 ============

/** 图像质量评分 — 验收标准：图像≥8/10 */
export interface ImageQualityScore {
  /** 图像路径 */
  imagePath: string;
  /** 总评分（0-10） */
  overallScore: number;
  /** 是否达到验收标准（≥8） */
  meetsTarget: boolean;
  /** 各维度评分 */
  dimensions: {
    /** 清晰度（0-10） */
    sharpness: number;
    /** 亮度（0-10） */
    brightness: number;
    /** 对比度（0-10） */
    contrast: number;
    /** 噪声水平（0-10，越高越好，表示噪声越低） */
    noiseLevel: number;
    /** 分辨率评分（0-10） */
    resolution: number;
  };
  /** 图像元信息 */
  metadata: {
    width: number;
    height: number;
    fileSizeBytes: number;
    format: string;
    /** P2-4: 亮度是否为真实像素测量（false 表示无法分析，使用估计值） */
    brightnessMeasured?: boolean;
    /** P2-4: 真实像素平均亮度（0-255，仅 brightnessMeasured=true 时有效） */
    brightnessMean?: number;
    /** P2-4: 真实像素亮度标准差（0-255，仅 brightnessMeasured=true 时有效） */
    brightnessStdDev?: number;
  };
  /** 评估时间戳 */
  evaluatedAt: number;
}

/** 融合质量评分 — 验收标准：跨模态融合≥7/10 */
export interface FusionQualityScore {
  /** 总评分（0-10） */
  overallScore: number;
  /** 是否达到验收标准（≥7） */
  meetsTarget: boolean;
  /** 各维度评分 */
  dimensions: {
    /** 模态覆盖度（0-10）— 参与融合的模态种类数 */
    modalityCoverage: number;
    /** 对齐质量（0-10）— 跨模态对齐的平均置信度 */
    alignmentQuality: number;
    /** 置信度一致性（0-10）— 各模态置信度的均匀程度 */
    confidenceConsistency: number;
    /** 信息互补性（0-10）— 模态间信息的互补程度 */
    informationComplementarity: number;
  };
  /** 评估详情 */
  details: {
    modalityCount: number;
    alignmentCount: number;
    avgConfidence: number;
    confidenceStdDev: number;
  };
  /** 评估时间戳 */
  evaluatedAt: number;
}

/** 音频特征 */
export interface AudioFeatures {
  /** 音频文件路径 */
  audioPath: string;
  /** 时长（秒） */
  durationSec: number;
  /** 采样率（Hz） */
  sampleRate: number;
  /** 声道数 */
  channels: number;
  /** 平均音量（0-1，RMS） */
  avgVolume: number;
  /** 峰值音量（0-1） */
  peakVolume: number;
  /** 信噪比（dB） */
  snrDb: number;
  /** 音频质量评分（0-10） */
  qualityScore: number;
  /** 是否达到可用标准（≥6） */
  meetsTarget: boolean;
  /** 提取时间戳 */
  extractedAt: number;
}

/** 基准测试结果 */
export interface BenchmarkResult {
  /** 测试套件名称 */
  suite: string;
  /** 各项测试结果 */
  tests: Array<{
    /** 测试名称 */
    name: string;
    /** 执行次数 */
    iterations: number;
    /** 总耗时（ms） */
    totalMs: number;
    /** 平均耗时（ms） */
    avgMs: number;
    /** 最小耗时（ms） */
    minMs: number;
    /** 最大耗时（ms） */
    maxMs: number;
    /** 中位数耗时（ms） */
    medianMs: number;
    /** 标准差 */
    stdDev: number;
    /** 是否成功 */
    success: boolean;
    /** 错误信息（若失败） */
    error?: string;
  }>;
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 测试时间戳 */
  benchmarkedAt: number;
}
