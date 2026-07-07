/**
 * 统一操作层
 * 将浏览器、桌面、文件、网络、代码执行等操作统一为单一入口
 */

// ==================== 类型定义 ====================

/** 操作类型 */
export type OperationType = 'browser' | 'desktop' | 'file' | 'network' | 'code' | 'system';

/** 操作方法类型 */
export type OperationMethodType =
  | 'browser_operate'
  | 'desktop_control'
  | 'visual_analyze'
  | 'screen_click'
  | 'file_read'
  | 'file_write'
  | 'network_request'
  | 'code_execute'
  | 'system_call';

/** 操作定义 */
export interface Operation {
  type: OperationType;
  action: string;
  params?: Record<string, unknown>;
}

/** 操作结果 */
export interface OperationResult {
  success: boolean;
  data?: unknown;
  error?: string;
  method: OperationMethodType;
  duration: number;
}

/** 环境信息 */
export interface EnvironmentInfo {
  os: string;
  osVersion: string;
  screenResolution: string;
  dpiScale: number;
  installedBrowsers: string[];
  installedApps: string[];
  timestamp: number;
}

/** 操作方法 */
export interface OperationMethod {
  type: OperationMethodType;
  priority: number;
  description: string;
  applicable: boolean;
}

/** 物理操作结果 */
export interface PhysicalResult {
  success: boolean;
  digitalAction: string;
  physicalEffect: string;
  timestamp: number;
}

/** 操作上下文 */
export interface OperationContext {
  environment: Partial<EnvironmentInfo>;
  userPreference?: OperationMethodType;
  constraints?: string[];
  priority?: 'speed' | 'reliability' | 'stealth';
}

/** 自适应操作 */
export interface AdaptedOperation {
  operation: Operation;
  selectedMethod: OperationMethod;
  adaptations: string[];
  confidence: number;
}

// ==================== 统一操作层 ====================

export class UnifiedOperationLayer {
  private envCache: EnvironmentInfo | null = null;
  private methodRegistry: Map<OperationMethodType, OperationMethod> = new Map();

  constructor() {
    this.initMethodRegistry();
  }

  /** 初始化操作方法注册表 */
  private initMethodRegistry(): void {
    const methods: Array<[OperationMethodType, number, string]> = [
      ['browser_operate', 90, '浏览器直接操作，适用于网页任务'],
      ['desktop_control', 70, '桌面级操控，适用于窗口和应用程序'],
      ['visual_analyze', 80, '视觉分析，通过截图识别界面元素'],
      ['screen_click', 75, '屏幕点击，基于坐标的精确操作'],
      ['file_read', 95, '文件读取，直接访问文件系统'],
      ['file_write', 95, '文件写入，直接修改文件系统'],
      ['network_request', 85, '网络请求，HTTP/HTTPS协议通信'],
      ['code_execute', 80, '代码执行，运行脚本或命令'],
      ['system_call', 90, '系统调用，操作系统级接口'],
    ];

    for (const [type, priority, description] of methods) {
      this.methodRegistry.set(type, { type, priority, description, applicable: true });
    }
  }

  /**
   * 执行任意操作
   * 根据操作类型自动路由到最佳执行方法
   */
  async execute(operation: Operation): Promise<OperationResult> {
    const startTime = Date.now();

    try {
      const method = this.findBestMethod(`${operation.type}:${operation.action}`);
      const result = await this.dispatchOperation(operation, method);

      return {
        success: true,
        data: result,
        method: method.type,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      // 主方法失败时尝试降级方案
      const fallback = this.getFallbackMethod(operation.type);
      if (fallback) {
        try {
          const result = await this.dispatchOperation(operation, fallback);
          return {
            success: true,
            data: result,
            method: fallback.type,
            duration: Date.now() - startTime,
          };
        } catch {
          // 降级也失败，返回错误
        }
      }

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        method: this.findBestMethod(`${operation.type}:${operation.action}`).type,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 检测运行环境
   * 获取OS版本、屏幕分辨率、DPI缩放、已安装浏览器和应用
   */
  detectEnvironment(): Promise<EnvironmentInfo> {
    if (this.envCache) return Promise.resolve(this.envCache);

    const info: EnvironmentInfo = {
      os: this.detectOS(),
      osVersion: this.detectOSVersion(),
      screenResolution: this.detectScreenResolution(),
      dpiScale: this.detectDPIScale(),
      installedBrowsers: this.detectBrowsers(),
      installedApps: this.detectInstalledApps(),
      timestamp: Date.now(),
    };

    this.envCache = info;
    return Promise.resolve(info);
  }

  /**
   * 根据任务自动选择最佳操作方式
   * 决策树：浏览器任务→browser_operate优先，失败→desktop操控兜底
   *         桌面任务→visual_analyze+screen_click
   *         文件任务→file_read/write
   */
  findBestMethod(task: string): OperationMethod {
    const [type, action] = this.parseTask(task);

    switch (type) {
      case 'browser':
        return this.resolveBrowserMethod(action);

      case 'desktop':
        return this.resolveDesktopMethod(action);

      case 'file':
        return this.resolveFileMethod(action);

      case 'network':
        return this.getRegisteredMethod('network_request');

      case 'code':
        return this.getRegisteredMethod('code_execute');

      case 'system':
        return this.getRegisteredMethod('system_call');

      default:
        return this.getRegisteredMethod('desktop_control');
    }
  }

  /**
   * 数字-物理桥接
   * 将数字世界的操作映射到物理世界的效果
   */
  bridgeDigitalPhysical(digitalAction: string): Promise<PhysicalResult> {
    const mapping = this.getPhysicalMapping(digitalAction);

    return Promise.resolve({
      success: true,
      digitalAction,
      physicalEffect: mapping,
      timestamp: Date.now(),
    });
  }

  /**
   * 上下文自适应
   * 根据环境、用户偏好和约束条件调整操作方式
   */
  adaptToContext(context: OperationContext): AdaptedOperation {
    const adaptations: string[] = [];
    let confidence = 1.0;

    // 基础操作（使用默认方法）
    const defaultMethod = this.findBestMethod('desktop:navigate');
    let selectedMethod = { ...defaultMethod };

    // 用户偏好优先
    if (context.userPreference) {
      const preferred = this.methodRegistry.get(context.userPreference);
      if (preferred && preferred.applicable) {
        selectedMethod = { ...preferred };
        adaptations.push(`应用用户偏好方法: ${context.userPreference}`);
      }
    }

    // 环境约束适配
    if (context.environment.installedBrowsers?.length === 0) {
      if (selectedMethod.type === 'browser_operate') {
        selectedMethod = this.getRegisteredMethod('desktop_control');
        adaptations.push('无可用浏览器，降级为桌面操控');
        confidence *= 0.8;
      }
    }

    // DPI缩放适配
    if (context.environment.dpiScale && context.environment.dpiScale !== 1) {
      adaptations.push(`DPI缩放适配: ${context.environment.dpiScale}x`);
      confidence *= 0.95;
    }

    // 优先级适配
    if (context.priority === 'speed') {
      selectedMethod.priority += 10;
      adaptations.push('速度优先模式');
    } else if (context.priority === 'reliability') {
      adaptations.push('可靠性优先模式');
      confidence *= 0.9;
    } else if (context.priority === 'stealth') {
      adaptations.push('隐蔽模式');
      confidence *= 0.85;
    }

    // 约束条件检查
    if (context.constraints) {
      for (const constraint of context.constraints) {
        if (constraint === 'no_network' && selectedMethod.type === 'network_request') {
          selectedMethod = this.getRegisteredMethod('code_execute');
          adaptations.push('网络受限，切换为本地代码执行');
          confidence *= 0.75;
        }
        if (constraint === 'no_gui' && (selectedMethod.type === 'screen_click' || selectedMethod.type === 'visual_analyze')) {
          selectedMethod = this.getRegisteredMethod('system_call');
          adaptations.push('无图形界面，切换为系统调用');
          confidence *= 0.8;
        }
      }
    }

    return {
      operation: { type: 'desktop', action: 'adapted' },
      selectedMethod,
      adaptations,

      confidence: Math.max(0, Math.min(1, confidence)),
    };
  }

  // ==================== 私有方法 ====================

  /** 解析任务字符串 */
  private parseTask(task: string): [OperationType, string] {
    const separatorIndex = task.indexOf(':');
    if (separatorIndex === -1) {
      return [task as OperationType, 'default'];
    }
    return [task.slice(0, separatorIndex) as OperationType, task.slice(separatorIndex + 1)];
  }

  /** 浏览器任务决策：browser_operate优先，desktop操控兜底 */
  private resolveBrowserMethod(_action: string): OperationMethod {
    // 浏览器任务优先使用浏览器直接操作
    const browserMethod = this.getRegisteredMethod('browser_operate');
    return browserMethod;
  }

  /** 桌面任务决策：visual_analyze + screen_click */
  private resolveDesktopMethod(action: string): OperationMethod {
    if (action.includes('click') || action.includes('tap') || action.includes('press')) {
      return this.getRegisteredMethod('screen_click');
    }
    return this.getRegisteredMethod('visual_analyze');
  }

  /** 文件任务决策：file_read / file_write */
  private resolveFileMethod(action: string): OperationMethod {
    if (action.includes('write') || action.includes('save') || action.includes('create') || action.includes('delete')) {
      return this.getRegisteredMethod('file_write');
    }
    return this.getRegisteredMethod('file_read');
  }

  /** 获取已注册的方法 */
  private getRegisteredMethod(type: OperationMethodType): OperationMethod {
    const method = this.methodRegistry.get(type);
    if (!method) {
      return { type, priority: 0, description: '未知方法', applicable: false };
    }
    return { ...method };
  }

  /** 获取降级方法 */
  private getFallbackMethod(type: OperationType): OperationMethod | null {
    const fallbackMap: Partial<Record<OperationType, OperationMethodType>> = {
      browser: 'desktop_control',
      desktop: 'system_call',
      file: 'code_execute',
      network: 'code_execute',
      code: 'system_call',
      system: 'desktop_control',
    };

    const fallbackType = fallbackMap[type];
    if (!fallbackType) return null;

    return this.getRegisteredMethod(fallbackType);
  }

  /** 分发操作到具体执行器 */
  private dispatchOperation(operation: Operation, method: OperationMethod): Promise<unknown> {
    // 根据方法类型路由到不同的执行逻辑
    switch (method.type) {
      case 'browser_operate':
        return this.executeBrowserOperation(operation);
      case 'desktop_control':
        return this.executeDesktopOperation(operation);
      case 'visual_analyze':
        return this.executeVisualAnalysis(operation);
      case 'screen_click':
        return this.executeScreenClick(operation);
      case 'file_read':
        return this.executeFileRead(operation);
      case 'file_write':
        return this.executeFileWrite(operation);
      case 'network_request':
        return this.executeNetworkRequest(operation);
      case 'code_execute':
        return this.executeCode(operation);
      case 'system_call':
        return this.executeSystemCall(operation);
      default:
        return Promise.reject(new Error(`不支持的操作方法: ${method.type}`));
    }
  }

  // ==================== 操作执行器（占位实现） ====================

  private executeBrowserOperation(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '浏览器操作已执行', params: operation.params });
  }

  private executeDesktopOperation(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '桌面操作已执行', params: operation.params });
  }

  private executeVisualAnalysis(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '视觉分析已完成', params: operation.params });
  }

  private executeScreenClick(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '屏幕点击已执行', params: operation.params });
  }

  private executeFileRead(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '文件读取已完成', params: operation.params });
  }

  private executeFileWrite(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '文件写入已完成', params: operation.params });
  }

  private executeNetworkRequest(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '网络请求已完成', params: operation.params });
  }

  private executeCode(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '代码执行已完成', params: operation.params });
  }

  private executeSystemCall(operation: Operation): Promise<unknown> {
    return Promise.resolve({ action: operation.action, status: '系统调用已完成', params: operation.params });
  }

  // ==================== 环境检测方法 ====================

  private detectOS(): string {
    const platform = (globalThis as Record<string, unknown>).navigator
      ? ((globalThis as Record<string, unknown>).navigator as Record<string, unknown>).platform
      : process.platform;

    if (typeof platform === 'string') {
      if (platform.startsWith('Win')) return 'Windows';
      if (platform.startsWith('Mac')) return 'macOS';
      if (platform.startsWith('Linux')) return 'Linux';
    }
    return '未知系统';
  }

  private detectOSVersion(): string {
    const platform = (globalThis as Record<string, unknown>).navigator
      ? ((globalThis as Record<string, unknown>).navigator as Record<string, unknown>).platform
      : process.platform;

    if (typeof platform === 'string') {
      const match = platform.match(/\d+[\d.]*/);
      if (match) return match[0];
    }
    return process.version || '未知版本';
  }

  private detectScreenResolution(): string {
    const nav = (globalThis as Record<string, unknown>).navigator;
    if (nav) {
      const screen = (nav as Record<string, unknown>).screen as Record<string, unknown> | undefined;
      if (screen && typeof screen.width === 'number' && typeof screen.height === 'number') {
        return `${screen.width}x${screen.height}`;
      }
    }
    return '未知分辨率';
  }

  private detectDPIScale(): number {
    const nav = (globalThis as Record<string, unknown>).navigator;
    if (nav) {
      const win = globalThis as Record<string, unknown>;
      if (typeof win.devicePixelRatio === 'number') {
        return win.devicePixelRatio;
      }
    }
    return 1;
  }

  private detectBrowsers(): string[] {
    // 基于环境推断可能安装的浏览器
    const os = this.detectOS();
    const browsers: string[] = [];

    if (os === 'Windows') {
      browsers.push('Edge');
    } else if (os === 'macOS') {
      browsers.push('Safari');
    }

    // 通用浏览器（大多数系统都有）
    browsers.push('Chrome', 'Firefox');

    return browsers;
  }

  private detectInstalledApps(): string[] {
    const os = this.detectOS();
    const apps: string[] = [];

    if (os === 'Windows') {
      apps.push('资源管理器', '记事本', '命令提示符', 'PowerShell');
    } else if (os === 'macOS') {
      apps.push('访达', '终端', '文本编辑');
    } else {
      apps.push('文件管理器', '终端');
    }

    return apps;
  }

  /** 数字-物理映射表 */
  private getPhysicalMapping(digitalAction: string): string {
    const mappings: Record<string, string> = {
      'click': '物理点击/触摸屏幕对应位置',
      'scroll': '物理滚动鼠标滚轮或触摸板滑动',
      'type': '物理键盘按键输入',
      'screenshot': '物理屏幕像素采集',
      'drag': '物理鼠标拖拽操作',
      'hover': '物理鼠标悬停移动',
      'resize': '物理窗口尺寸调整',
      'close': '物理窗口/应用关闭',
      'open': '物理应用/文件启动',
      'download': '物理磁盘数据写入',
      'upload': '物理磁盘数据读取并发送',
      'print': '物理打印机输出',
      'notify': '物理通知栏/声音提示',
    };

    return mappings[digitalAction] || `未知物理映射: ${digitalAction}`;
  }
}
