/**
 * 能力缺口检测器 — 当 agent 遇到能力不足时，自动触发自我升级
 *
 * 核心逻辑：
 * 1. 检测任务失败是否因为"能力不足"（而非参数错误/网络问题）
 * 2. 分析缺失的能力类型
 * 3. 生成升级方案（安装包/创建工具/修改代码）
 * 4. 注入升级指令到 agent 的上下文中
 */

export type GapType =
  | 'missing_tool'            // 缺少某个工具
  | 'missing_package'         // 缺少某个 npm/pip 包
  | 'missing_knowledge'       // 缺少领域知识
  | 'insufficient_capability' // 现有工具能力不足
  | 'desktop_app_missing'     // 桌面应用未配置
  | 'api_access_denied';      // API 访问被拒绝

export interface CapabilityGap {
  type: GapType;
  description: string;           // 缺口描述
  suggestedFix: string;          // 建议修复方案
  autoFixAvailable: boolean;     // 是否可以自动修复
  fixTool: string;               // 修复用的工具名
  fixArgs: Record<string, unknown>;  // 修复参数
  priority: 'high' | 'medium' | 'low';
}

export interface GapAnalysisResult {
  hasGap: boolean;
  gaps: CapabilityGap[];
  summary: string;               // 给 LLM 的摘要
}

// ============ 内部知识库类型 ============

/** 任务→所需工具映射条目 */
interface TaskToolMapping {
  keywords: string[];            // 任务描述中的关键词
  requiredTools: string[];       // 所需工具列表
  requiredPackages: string[];    // 所需包列表
  requiredApps: string[];        // 所需桌面应用
}

/** 常见失败→修复方案映射条目 */
interface FailureFixMapping {
  errorPatterns: RegExp[];       // 错误消息匹配模式
  gapType: GapType;              // 对应的缺口类型
  fixTool: string;               // 修复工具
  autoFix: boolean;              // 是否可自动修复
}

/** Windows 常见桌面应用路径 */
interface AppPathMapping {
  appName: string;               // 应用名称
  aliases: string[];             // 别名列表
  possiblePaths: string[];       // 可能的安装路径
}

// ============ 内置知识库 ============

/** 常见任务→所需工具映射 */
const TASK_TOOL_MAPPINGS: TaskToolMapping[] = [
  {
    keywords: ['视频', 'video', '录制', '录屏', '截图', 'screenshot'],
    requiredTools: ['desktop_control', 'shell_execute'],
    requiredPackages: [],
    requiredApps: [],
  },
  {
    keywords: ['浏览器', 'browser', '网页', 'webpage', '网站', 'website'],
    requiredTools: ['browser_operate', 'web_fetch'],
    requiredPackages: ['puppeteer'],
    requiredApps: ['chrome', 'firefox'],
  },
  {
    keywords: ['微信', 'wechat', '公众号', '朋友圈'],
    requiredTools: ['wechat_open', 'wechat_find_contact', 'wechat_send_message', 'shell_execute'],
    requiredPackages: [],
    requiredApps: ['wechat'],
  },
  {
    keywords: ['数据库', 'database', 'sql', 'mysql', 'postgres', 'mongo'],
    requiredTools: ['shell_execute', 'code_execute'],
    requiredPackages: [],
    requiredApps: [],
  },
  {
    keywords: ['图片', 'image', '图片处理', '缩放', '裁剪', '压缩'],
    requiredTools: ['code_execute', 'file_write'],
    requiredPackages: ['sharp'],
    requiredApps: [],
  },
  {
    keywords: ['pdf', 'PDF', '文档', 'document'],
    requiredTools: ['code_execute', 'file_read', 'file_write'],
    requiredPackages: ['pdfkit', 'pdf-parse'],
    requiredApps: [],
  },
  {
    keywords: ['excel', 'xlsx', 'csv', '表格', 'spreadsheet'],
    requiredTools: ['code_execute', 'file_read', 'file_write'],
    requiredPackages: ['xlsx', 'csv-parse'],
    requiredApps: [],
  },
  {
    keywords: ['邮件', 'email', 'smtp', '发送邮件'],
    requiredTools: ['code_execute'],
    requiredPackages: ['nodemailer'],
    requiredApps: [],
  },
  {
    keywords: ['git', '版本控制', '提交', 'commit', '分支', 'branch'],
    requiredTools: ['shell_execute'],
    requiredPackages: [],
    requiredApps: ['git'],
  },
  {
    keywords: ['docker', '容器', 'container', '部署', 'deploy'],
    requiredTools: ['shell_execute'],
    requiredPackages: [],
    requiredApps: ['docker'],
  },
  {
    keywords: ['音频', 'audio', 'mp3', '语音', 'tts', 'stt', '转录'],
    requiredTools: ['code_execute', 'shell_execute'],
    requiredPackages: [],
    requiredApps: [],
  },
  {
    keywords: ['爬虫', 'scraping', '抓取数据', '采集'],
    requiredTools: ['browser_operate', 'web_fetch', 'code_execute'],
    requiredPackages: ['cheerio'],
    requiredApps: [],
  },
];

/** 常见失败→修复方案映射 */
const FAILURE_FIX_MAPPINGS: FailureFixMapping[] = [
  {
    errorPatterns: [/找不到工具/, /tool not found/, /no tool named/i],
    gapType: 'missing_tool',
    fixTool: 'create_tool',
    autoFix: true,
  },
  {
    errorPatterns: [/不支持的操作/, /unsupported operation/i, /not supported/i],
    gapType: 'missing_tool',
    fixTool: 'create_tool',
    autoFix: true,
  },
  {
    errorPatterns: [/模块未找到/, /Cannot find module/i, /MODULE_NOT_FOUND/],
    gapType: 'missing_package',
    fixTool: 'shell_execute',
    autoFix: true,
  },
  {
    errorPatterns: [/需要登录/, /login required/i, /authentication required/i],
    gapType: 'api_access_denied',
    fixTool: '',
    autoFix: false,
  },
  {
    errorPatterns: [/权限不足/, /permission denied/i, /access denied/i, /forbidden/i, /403/],
    gapType: 'api_access_denied',
    fixTool: '',
    autoFix: false,
  },
  {
    errorPatterns: [/应用未找到/, /application not found/i, /app not found/i],
    gapType: 'desktop_app_missing',
    fixTool: 'shell_execute',
    autoFix: true,
  },
  {
    errorPatterns: [/无法连接/, /connection refused/i, /ECONNREFUSED/, /ETIMEDOUT/],
    gapType: 'insufficient_capability',
    fixTool: 'self_evolve',
    autoFix: true,
  },
  {
    errorPatterns: [/不支持/, /not capable/i, /capability insufficient/i],
    gapType: 'insufficient_capability',
    fixTool: 'self_evolve',
    autoFix: true,
  },
  {
    errorPatterns: [/知识不足/, /don'?t know/i, /无法回答/, /no knowledge/i],
    gapType: 'missing_knowledge',
    fixTool: 'web_search',
    autoFix: true,
  },
];

/** Windows 常见桌面应用路径映射 */
const APP_PATH_MAPPINGS: AppPathMapping[] = [
  {
    appName: 'wechat',
    aliases: ['微信', 'wechat', 'weixin'],
    possiblePaths: [
      'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'D:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      'D:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
    ],
  },
  {
    appName: 'chrome',
    aliases: ['chrome', '谷歌浏览器', 'google chrome'],
    possiblePaths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    appName: 'firefox',
    aliases: ['firefox', '火狐', 'mozilla'],
    possiblePaths: [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    ],
  },
  {
    appName: 'vscode',
    aliases: ['vscode', 'code', 'visual studio code'],
    possiblePaths: [
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    ],
  },
  {
    appName: 'git',
    aliases: ['git'],
    possiblePaths: [
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
      'D:\\Program Files\\Git\\bin\\git.exe',
    ],
  },
  {
    appName: 'docker',
    aliases: ['docker', 'docker desktop'],
    possiblePaths: [
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    ],
  },
];

// ============ 主类 ============

export class CapabilityGapDetector {
  private availableTools: Set<string>;
  private installedPackages: Set<string>;
  private knownApps: Map<string, string>;          // 应用名 → 路径
  private failurePatterns: Map<string, GapType>;   // 失败模式 → 缺口类型
  private recentGaps: CapabilityGap[] = [];        // 最近检测到的缺口（用于去重）

  constructor(tools: string[]) {
    this.availableTools = new Set(tools);
    this.installedPackages = new Set();
    this.knownApps = new Map();
    // 初始化失败模式映射
    this.failurePatterns = new Map([
      ['找不到工具', 'missing_tool'],
      ['不支持的操作', 'missing_tool'],
      ['模块未找到', 'missing_package'],
      ['Cannot find module', 'missing_package'],
      ['需要登录', 'api_access_denied'],
      ['权限不足', 'api_access_denied'],
      ['应用未找到', 'desktop_app_missing'],
      ['无法连接', 'insufficient_capability'],
      ['不支持', 'insufficient_capability'],
    ]);
  }

  // ========== 核心方法 ==========

  /**
   * 分析失败原因，检测能力缺口
   *
   * 流程：
   * 1. 用失败模式映射检测缺口类型
   * 2. 根据工具名和错误消息推断缺失的能力
   * 3. 生成具体的修复方案
   * 4. 返回 GapAnalysisResult
   */
  analyzeFailure(
    toolName: string,
    args: Record<string, unknown>,
    errorMessage: string,
    context?: { userInput?: string; planSteps?: string[] }
  ): GapAnalysisResult {
    const gaps: CapabilityGap[] = [];

    // 第一步：用内置失败模式映射快速匹配
    const matchedGapType = this.matchFailurePattern(errorMessage);
    if (matchedGapType) {
      const gap = this.buildGapFromFailure(matchedGapType, toolName, args, errorMessage, context);
      if (gap) {
        gaps.push(gap);
      }
    }

    // 第二步：用正则模式做更精细的匹配
    for (const mapping of FAILURE_FIX_MAPPINGS) {
      // 跳过已经匹配过的类型
      if (matchedGapType === mapping.gapType) continue;
      if (mapping.errorPatterns.some(pattern => pattern.test(errorMessage))) {
        const gap = this.buildGapFromFailure(mapping.gapType, toolName, args, errorMessage, context);
        if (gap) {
          gaps.push(gap);
        }
      }
    }

    // 第三步：如果错误消息中提到缺失的包名，补充 missing_package 缺口
    const moduleMatch = errorMessage.match(/Cannot find module\s+['"]?([^'"\s]+)/i)
      ?? errorMessage.match(/模块未找到[:\s]*['"]?([^'"\s]+)/i);
    if (moduleMatch && !this.installedPackages.has(moduleMatch[1])) {
      const pkgName = moduleMatch[1];
      if (!gaps.some(g => g.type === 'missing_package' && g.fixArgs.package === pkgName)) {
        gaps.push({
          type: 'missing_package',
          description: `缺少 npm 包: ${pkgName}`,
          suggestedFix: `安装 ${pkgName} 包`,
          autoFixAvailable: true,
          fixTool: 'shell_execute',
          fixArgs: { package: pkgName, action: 'install' },
          priority: 'high',
        });
      }
    }

    // 第四步：如果错误消息中提到缺失的应用，补充 desktop_app_missing 缺口
    const appGap = this.detectMissingAppFromError(errorMessage);
    if (appGap && !gaps.some(g => g.type === 'desktop_app_missing' && g.description === appGap.description)) {
      gaps.push(appGap);
    }

    // 去重
    const deduplicatedGaps = this.deduplicateGaps(gaps);

    // 生成摘要
    const summary = this.generateSummary(deduplicatedGaps);

    // 记录最近的缺口
    this.recentGaps = deduplicatedGaps;

    return {
      hasGap: deduplicatedGaps.length > 0,
      gaps: deduplicatedGaps,
      summary,
    };
  }

  /**
   * 检查任务是否超出当前能力范围
   *
   * 流程：
   * 1. 分析任务描述中提到的能力需求
   * 2. 检查所需工具是否在 availableTools 中
   * 3. 检查是否需要桌面应用但未配置
   * 4. 返回缺口列表
   */
  checkCapability(
    taskDescription: string,
    requiredTools?: string[]
  ): GapAnalysisResult {
    const gaps: CapabilityGap[] = [];

    // 第一步：检查显式指定的所需工具
    if (requiredTools) {
      for (const tool of requiredTools) {
        if (!this.availableTools.has(tool)) {
          gaps.push({
            type: 'missing_tool',
            description: `缺少工具: ${tool}`,
            suggestedFix: `创建或安装 ${tool} 工具`,
            autoFixAvailable: true,
            fixTool: 'create_tool',
            fixArgs: { toolName: tool },
            priority: 'high',
          });
        }
      }
    }

    // 第二步：基于任务描述关键词匹配所需能力
    const taskLower = taskDescription.toLowerCase();
    for (const mapping of TASK_TOOL_MAPPINGS) {
      const matched = mapping.keywords.some(kw => taskLower.includes(kw.toLowerCase()));
      if (!matched) continue;

      // 检查缺失的工具
      for (const tool of mapping.requiredTools) {
        if (!this.availableTools.has(tool) && !gaps.some(g => g.type === 'missing_tool' && g.fixArgs.toolName === tool)) {
          gaps.push({
            type: 'missing_tool',
            description: `任务需要工具 ${tool}，但当前不可用`,
            suggestedFix: `创建或安装 ${tool} 工具以支持${mapping.keywords[0]}相关任务`,
            autoFixAvailable: true,
            fixTool: 'create_tool',
            fixArgs: { toolName: tool },
            priority: 'high',
          });
        }
      }

      // 检查缺失的包
      for (const pkg of mapping.requiredPackages) {
        if (!this.installedPackages.has(pkg) && !gaps.some(g => g.type === 'missing_package' && g.fixArgs.package === pkg)) {
          gaps.push({
            type: 'missing_package',
            description: `任务需要 npm 包 ${pkg}，但尚未安装`,
            suggestedFix: `安装 ${pkg} 包以支持${mapping.keywords[0]}相关任务`,
            autoFixAvailable: true,
            fixTool: 'shell_execute',
            fixArgs: { package: pkg, action: 'install' },
            priority: 'medium',
          });
        }
      }

      // 检查缺失的桌面应用
      for (const app of mapping.requiredApps) {
        if (!this.knownApps.has(app) && !gaps.some(g => g.type === 'desktop_app_missing' && g.fixArgs.appName === app)) {
          const appPath = this.findAppPath(app);
          gaps.push({
            type: 'desktop_app_missing',
            description: `任务需要桌面应用 ${app}，但未配置`,
            suggestedFix: appPath
              ? `注册应用 ${app}，路径: ${appPath}`
              : `搜索并安装桌面应用 ${app}`,
            autoFixAvailable: !!appPath,
            fixTool: 'shell_execute',
            fixArgs: { appName: app, action: appPath ? 'register' : 'search' },
            priority: 'medium',
          });
        }
      }
    }

    // 第三步：检查任务描述中是否直接提到了需要的工具名
    const toolMentionMatch = taskDescription.match(/使用\s+(\w+)\s*(?:工具)?/g);
    if (toolMentionMatch) {
      for (const mention of toolMentionMatch) {
        const toolName = mention.replace(/使用\s+/, '').replace(/\s*工具/, '').trim();
        if (toolName && !this.availableTools.has(toolName) && !gaps.some(g => g.fixArgs.toolName === toolName)) {
          gaps.push({
            type: 'missing_tool',
            description: `任务要求使用 ${toolName} 工具，但当前不可用`,
            suggestedFix: `创建 ${toolName} 工具`,
            autoFixAvailable: true,
            fixTool: 'create_tool',
            fixArgs: { toolName },
            priority: 'high',
          });
        }
      }
    }

    const summary = this.generateSummary(gaps);

    return {
      hasGap: gaps.length > 0,
      gaps,
      summary,
    };
  }

  /**
   * 生成自我升级指令
   *
   * 根据 gap.type 生成不同的升级指令，注入到 agent 上下文中
   */
  generateUpgradeInstruction(gap: CapabilityGap): string {
    switch (gap.type) {
      case 'missing_tool':
        return [
          `⚠️ 检测到能力缺口: ${gap.description}`,
          `🔧 建议操作: 请使用 create_tool 工具创建一个 "${gap.fixArgs.toolName || ''}" 的新工具。`,
          `📋 修复方案: ${gap.suggestedFix}`,
          gap.autoFixAvailable ? '✅ 此缺口可以自动修复。' : '⚠️ 此缺口需要手动处理。',
        ].join('\n');

      case 'missing_package':
        return [
          `⚠️ 检测到能力缺口: ${gap.description}`,
          `🔧 建议操作: 请使用 shell_execute 工具执行 "npm install ${gap.fixArgs.package || ''}" 安装所需包。`,
          `📦 安装命令: npm install ${gap.fixArgs.package || ''}`,
          `📋 修复方案: ${gap.suggestedFix}`,
          gap.autoFixAvailable ? '✅ 此缺口可以自动修复。' : '⚠️ 此缺口需要手动处理。',
        ].join('\n');

      case 'desktop_app_missing': {
        const appName = String(gap.fixArgs.appName || '');
        const appPath = this.knownApps.get(appName);
        if (appPath) {
          return [
            `⚠️ 检测到能力缺口: ${gap.description}`,
            `🔧 建议操作: 请使用 shell_execute 注册桌面应用 ${appName}，路径: ${appPath}`,
            `📋 修复方案: ${gap.suggestedFix}`,
            '✅ 已找到应用路径，可以自动注册。',
          ].join('\n');
        }
        return [
          `⚠️ 检测到能力缺口: ${gap.description}`,
          `🔧 建议操作: 请使用 shell_execute 搜索并打开 ${appName}`,
          `📋 修复方案: ${gap.suggestedFix}`,
          '⚠️ 未找到应用路径，可能需要先安装应用。',
        ].join('\n');
      }

      case 'api_access_denied':
        return [
          `⚠️ 检测到能力缺口: ${gap.description}`,
          `🔒 建议操作: 此操作需要额外的权限或认证。`,
          `📋 修复方案: ${gap.suggestedFix}`,
          `💡 提示: 请检查 API 密钥配置或联系用户手动授权。`,
          '❌ 此缺口无法自动修复，需要用户手动操作。',
        ].join('\n');

      case 'insufficient_capability':
        return [
          `⚠️ 检测到能力缺口: ${gap.description}`,
          `🧬 建议操作: 请使用 self_evolve 工具升级当前工具的能力。`,
          `📋 修复方案: ${gap.suggestedFix}`,
          `💡 提示: 当前工具的功能不足以完成任务，需要增强其能力。`,
          gap.autoFixAvailable ? '✅ 此缺口可以通过自我进化修复。' : '⚠️ 此缺口需要手动处理。',
        ].join('\n');

      case 'missing_knowledge':
        return [
          `⚠️ 检测到能力缺口: ${gap.description}`,
          `📚 建议操作: 请使用 web_search 工具搜索相关知识。`,
          `📋 修复方案: ${gap.suggestedFix}`,
          `💡 提示: 当前缺少完成此任务所需的领域知识，建议先搜索学习。`,
          '✅ 此缺口可以通过搜索获取知识来修复。',
        ].join('\n');

      default:
        return [
          `⚠️ 检测到未知能力缺口: ${gap.description}`,
          `📋 修复方案: ${gap.suggestedFix}`,
        ].join('\n');
    }
  }

  // ========== 注册方法 ==========

  /** 注册新工具（升级后调用） */
  registerTool(toolName: string): void {
    this.availableTools.add(toolName);
  }

  /** 注册已安装的包 */
  registerPackage(pkgName: string): void {
    this.installedPackages.add(pkgName);
  }

  /** 注册桌面应用 */
  registerApp(appName: string, appPath: string): void {
    this.knownApps.set(appName, appPath);
  }

  /** 批量注册工具 */
  registerTools(toolNames: string[]): void {
    for (const name of toolNames) {
      this.availableTools.add(name);
    }
  }

  /** 批量注册已安装的包 */
  registerPackages(pkgNames: string[]): void {
    for (const name of pkgNames) {
      this.installedPackages.add(name);
    }
  }

  /** 注销工具 */
  unregisterTool(toolName: string): void {
    this.availableTools.delete(toolName);
  }

  /** 注销包 */
  unregisterPackage(pkgName: string): void {
    this.installedPackages.delete(pkgName);
  }

  // ========== 查询方法 ==========

  /** 获取当前可用工具列表 */
  getAvailableTools(): string[] {
    return Array.from(this.availableTools);
  }

  /** 获取已安装包列表 */
  getInstalledPackages(): string[] {
    return Array.from(this.installedPackages);
  }

  /** 获取已知桌面应用列表 */
  getKnownApps(): Map<string, string> {
    return new Map(this.knownApps);
  }

  /** 获取最近检测到的缺口 */
  getRecentGaps(): CapabilityGap[] {
    return [...this.recentGaps];
  }

  /** 检查工具是否可用 */
  hasTool(toolName: string): boolean {
    return this.availableTools.has(toolName);
  }

  /** 检查包是否已安装 */
  hasPackage(pkgName: string): boolean {
    return this.installedPackages.has(pkgName);
  }

  /** 检查应用是否已注册 */
  hasApp(appName: string): boolean {
    return this.knownApps.has(appName);
  }

  // ========== 私有方法 ==========

  /** 用失败模式映射匹配缺口类型 */
  private matchFailurePattern(errorMessage: string): GapType | null {
    let result: GapType | null = null;
    this.failurePatterns.forEach((gapType, pattern) => {
      if (result !== null) return;
      if (errorMessage.includes(pattern)) {
        result = gapType;
      }
    });
    return result;
  }

  /** 根据缺口类型构建 CapabilityGap */
  private buildGapFromFailure(
    gapType: GapType,
    toolName: string,
    args: Record<string, unknown>,
    errorMessage: string,
    context?: { userInput?: string; planSteps?: string[] }
  ): CapabilityGap | null {
    switch (gapType) {
      case 'missing_tool':
        return {
          type: 'missing_tool',
          description: `工具 ${toolName} 不存在或不可用: ${errorMessage}`,
          suggestedFix: `创建一个 ${toolName} 工具来支持此操作`,
          autoFixAvailable: true,
          fixTool: 'create_tool',
          fixArgs: { toolName, args },
          priority: 'high',
        };

      case 'missing_package': {
        const pkgName = this.extractPackageName(errorMessage);
        return {
          type: 'missing_package',
          description: `缺少依赖包: ${pkgName || '未知包'}`,
          suggestedFix: `安装 ${pkgName || '缺失的'} 包`,
          autoFixAvailable: true,
          fixTool: 'shell_execute',
          fixArgs: { package: pkgName, action: 'install' },
          priority: 'high',
        };
      }

      case 'api_access_denied':
        return {
          type: 'api_access_denied',
          description: `API 访问被拒绝: ${errorMessage}`,
          suggestedFix: '检查 API 密钥配置或联系用户手动授权',
          autoFixAvailable: false,
          fixTool: '',
          fixArgs: { toolName, errorMessage },
          priority: 'high',
        };

      case 'desktop_app_missing': {
        const appName = this.extractAppName(errorMessage);
        const appPath = appName ? this.findAppPath(appName) : null;
        return {
          type: 'desktop_app_missing',
          description: `桌面应用 ${appName || ''} 未找到: ${errorMessage}`,
          suggestedFix: appPath
            ? `注册应用 ${appName}，路径: ${appPath}`
            : `搜索并安装桌面应用 ${appName || ''}`,
          autoFixAvailable: !!appPath,
          fixTool: 'shell_execute',
          fixArgs: { appName: appName || '', action: appPath ? 'register' : 'search' },
          priority: 'medium',
        };
      }

      case 'insufficient_capability':
        return {
          type: 'insufficient_capability',
          description: `工具 ${toolName} 能力不足: ${errorMessage}`,
          suggestedFix: `升级 ${toolName} 工具的能力以支持此操作`,
          autoFixAvailable: true,
          fixTool: 'self_evolve',
          fixArgs: { toolName, errorMessage },
          priority: 'medium',
        };

      case 'missing_knowledge':
        return {
          type: 'missing_knowledge',
          description: `缺少领域知识: ${errorMessage}`,
          suggestedFix: '搜索相关领域知识以补全能力',
          autoFixAvailable: true,
          fixTool: 'web_search',
          fixArgs: { query: context?.userInput || errorMessage },
          priority: 'low',
        };

      default:
        return null;
    }
  }

  /** 从错误消息中提取包名 */
  private extractPackageName(errorMessage: string): string {
    // 尝试匹配 "Cannot find module 'xxx'" 或 "模块未找到: xxx"
    const moduleMatch = errorMessage.match(/Cannot find module\s+['"]?([^'"\s]+)/i)
      ?? errorMessage.match(/模块未找到[:\s]*['"]?([^'"\s]+)/i);
    if (moduleMatch) return moduleMatch[1];

    // 尝试匹配 npm install 提示中的包名
    const npmMatch = errorMessage.match(/npm install\s+([^\s]+)/);
    if (npmMatch) return npmMatch[1];

    return '';
  }

  /** 从错误消息中提取应用名 */
  private extractAppName(errorMessage: string): string {
    // 尝试匹配 "应用未找到: xxx" 或 "application not found: xxx"
    const appMatch = errorMessage.match(/应用未找到[:\s]*['"]?([^'"\s,]+)/i)
      ?? errorMessage.match(/application not found[:\s]*['"]?([^'"\s,]+)/i);
    if (appMatch) return appMatch[1];

    // 在已知应用别名中搜索
    for (const mapping of APP_PATH_MAPPINGS) {
      for (const alias of mapping.aliases) {
        if (errorMessage.toLowerCase().includes(alias.toLowerCase())) {
          return mapping.appName;
        }
      }
    }

    return '';
  }

  /** 在内置应用路径映射中查找应用路径 */
  private findAppPath(appName: string): string | null {
    // 先查已注册的应用
    const registered = this.knownApps.get(appName);
    if (registered) return registered;

    // 在内置映射中查找
    const appLower = appName.toLowerCase();
    for (const mapping of APP_PATH_MAPPINGS) {
      if (mapping.appName === appLower || mapping.aliases.some(a => a.toLowerCase() === appLower)) {
        // 返回第一个路径（实际使用时需要检查路径是否存在）
        return mapping.possiblePaths[0] || null;
      }
    }

    return null;
  }

  /** 从错误消息中检测缺失的桌面应用 */
  private detectMissingAppFromError(errorMessage: string): CapabilityGap | null {
    for (const mapping of APP_PATH_MAPPINGS) {
      for (const alias of mapping.aliases) {
        if (errorMessage.toLowerCase().includes(alias.toLowerCase())) {
          // 检查是否已注册
          if (this.knownApps.has(mapping.appName)) continue;

          const appPath = mapping.possiblePaths[0] || null;
          return {
            type: 'desktop_app_missing',
            description: `桌面应用 ${mapping.appName} 未配置`,
            suggestedFix: appPath
              ? `注册应用 ${mapping.appName}，路径: ${appPath}`
              : `搜索并安装桌面应用 ${mapping.appName}`,
            autoFixAvailable: !!appPath,
            fixTool: 'shell_execute',
            fixArgs: { appName: mapping.appName, action: appPath ? 'register' : 'search' },
            priority: 'medium',
          };
        }
      }
    }
    return null;
  }

  /** 缺口去重 */
  private deduplicateGaps(gaps: CapabilityGap[]): CapabilityGap[] {
    const seen = new Set<string>();
    const result: CapabilityGap[] = [];

    for (const gap of gaps) {
      // 用 type + description 的组合作为去重键
      const key = `${gap.type}:${gap.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(gap);
      }
    }

    return result;
  }

  /** 生成给 LLM 的摘要 */
  private generateSummary(gaps: CapabilityGap[]): string {
    if (gaps.length === 0) {
      return '当前能力充足，未检测到缺口。';
    }

    const lines: string[] = ['检测到以下能力缺口：'];

    // 按优先级分组
    const highGaps = gaps.filter(g => g.priority === 'high');
    const mediumGaps = gaps.filter(g => g.priority === 'medium');
    const lowGaps = gaps.filter(g => g.priority === 'low');

    if (highGaps.length > 0) {
      lines.push(`🔴 高优先级(${highGaps.length}项):`);
      for (const g of highGaps) {
        lines.push(`  - [${g.type}] ${g.description} → ${g.autoFixAvailable ? '可自动修复' : '需手动处理'}`);
      }
    }

    if (mediumGaps.length > 0) {
      lines.push(`🟡 中优先级(${mediumGaps.length}项):`);
      for (const g of mediumGaps) {
        lines.push(`  - [${g.type}] ${g.description} → ${g.autoFixAvailable ? '可自动修复' : '需手动处理'}`);
      }
    }

    if (lowGaps.length > 0) {
      lines.push(`🟢 低优先级(${lowGaps.length}项):`);
      for (const g of lowGaps) {
        lines.push(`  - [${g.type}] ${g.description} → ${g.autoFixAvailable ? '可自动修复' : '需手动处理'}`);
      }
    }

    const autoFixCount = gaps.filter(g => g.autoFixAvailable).length;
    lines.push(`\n共 ${gaps.length} 项缺口，其中 ${autoFixCount} 项可自动修复。`);

    return lines.join('\n');
  }
}
