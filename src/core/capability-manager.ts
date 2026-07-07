/**
 * 权限与功能范围管理器
 * 管理文件系统访问权限、网页访问能力、工具使用范围和安全控制
 */

/** 文件访问权限 */
export interface FileAccessPolicy {
  allowedExtensions: string[];    // 允许的文件扩展名
  allowedPaths: string[];         // 允许的路径模式
  deniedPaths: string[];          // 禁止的路径模式
  maxFileSize: number;           // 最大文件大小(bytes)
  readOnlyPatterns: string[];     // 只读路径模式
  writeRequiresApproval: boolean; // 写入是否需要审批
}

/** 网页访问能力 */
export interface WebAccessCapability {
  canFetch: boolean;              // 是否能抓取网页
  canSearch: boolean;             // 是否能搜索
  canAutomate: boolean;           // 是否能自动化操作
  allowedDomains: string[];       // 允许的域名
  deniedDomains: string[];        // 禁止的域名
  maxConcurrentRequests: number;  // 最大并发请求数
  requestTimeout: number;         // 请求超时(ms)
  rateLimitPerMinute: number;     // 每分钟请求限制
}

/** 工具权限 */
export interface ToolPermission {
  toolName: string;
  allowed: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
  maxCallsPerSession: number;
  description: string;
  constraints: string[];
}

/** 功能清单项 */
export interface CapabilityItem {
  id: string;
  name: string;
  category: 'file' | 'web' | 'code' | 'system' | 'ai';
  enabled: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  implementation: string;       // 技术实现方式
  limitations: string[];        // 限制说明
  securityMeasures: string[];   // 安全措施
}

export class CapabilityManager {
  private filePolicy: FileAccessPolicy;
  private webCapability: WebAccessCapability;
  private toolPermissions: Map<string, ToolPermission> = new Map();
  private capabilities: CapabilityItem[] = [];

  constructor() {
    this.filePolicy = this.initFilePolicy();
    this.webCapability = this.initWebCapability();
    this.toolPermissions = this.initToolPermissions();
    this.capabilities = this.initCapabilities();
  }

  /** 初始化文件访问策略 */
  private initFilePolicy(): FileAccessPolicy {
    return {
      allowedExtensions: [
        '.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml', '.toml',
        '.css', '.html', '.svg', '.xml',
        '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h',
        '.sh', '.bash', '.ps1',
        '.sql', '.env', '.gitignore', '.dockerfile',
      ],
      allowedPaths: [
        './src/**',           // 源代码目录
        './web/**',           // Web目录
        './dist/**',          // 构建输出
        './tests/**',         // 测试目录
        './docs/**',          // 文档目录
        './*.json',           // 项目根目录配置文件
        './*.md',             // 项目根目录文档
      ],
      deniedPaths: [
        './**/.env',          // 环境变量文件
        './**/*.key',         // 密钥文件
        './**/*.pem',         // 证书文件
        './**/credentials*', // 凭证文件
        './**/.git/**',       // Git内部文件
        './**/node_modules/**', // 依赖目录
      ],
      maxFileSize: 10 * 1024 * 1024, // 10MB
      readOnlyPatterns: [
        './**/*.lock',        // 锁文件只读
        './dist/**',          // 构建输出只读
      ],
      writeRequiresApproval: false,
    };
  }

  /** 初始化网页访问能力 */
  private initWebCapability(): WebAccessCapability {
    return {
      canFetch: true,
      canSearch: true,
      canAutomate: false,        // 自动化操作默认关闭
      allowedDomains: ['*'],     // 允许所有域名（受其他限制约束）
      deniedDomains: [
        'localhost',              // 禁止访问本地服务
        '127.0.0.1',
        '0.0.0.0',
        '*.internal',            // 内部域名
        '*.local',
      ],
      maxConcurrentRequests: 5,
      requestTimeout: 30000,     // 30秒
      rateLimitPerMinute: 30,    // 每分钟30次
    };
  }

  /** 初始化工具权限 */
  private initToolPermissions(): Map<string, ToolPermission> {
    const perms: ToolPermission[] = [
      { toolName: 'file_read', allowed: true, riskLevel: 'low', requiresApproval: false, maxCallsPerSession: 100, description: '读取文件内容', constraints: ['仅允许读取allowedPaths中的文件', '文件大小不超过maxFileSize'] },
      { toolName: 'file_write', allowed: true, riskLevel: 'medium', requiresApproval: true, maxCallsPerSession: 50, description: '写入文件内容', constraints: ['仅允许写入allowedPaths中的文件', '不允许覆盖系统文件', '写入前需确认路径安全性'] },
      { toolName: 'code_execute', allowed: true, riskLevel: 'medium', requiresApproval: false, maxCallsPerSession: 50, description: '在沙箱中执行JavaScript代码', constraints: ['沙箱环境，无文件/网络访问', '执行时间限制5秒', '内存限制128MB'] },
      { toolName: 'shell_execute', allowed: true, riskLevel: 'high', requiresApproval: true, maxCallsPerSession: 20, description: '执行Shell命令', constraints: ['仅允许在项目目录中执行', '禁止rm -rf等危险命令', '命令执行超时30秒'] },
      { toolName: 'web_search', allowed: true, riskLevel: 'low', requiresApproval: false, maxCallsPerSession: 30, description: '网络搜索', constraints: ['遵守rateLimitPerMinute限制', '搜索结果仅返回摘要'] },
      { toolName: 'web_fetch', allowed: true, riskLevel: 'medium', requiresApproval: false, maxCallsPerSession: 20, description: '抓取网页内容', constraints: ['遵守deniedDomains限制', '请求超时30秒', '不提交表单或执行操作'] },
      { toolName: 'http_request', allowed: true, riskLevel: 'high', requiresApproval: true, maxCallsPerSession: 10, description: '发送HTTP请求', constraints: ['禁止向内部网络发送请求', 'POST请求需要审批', '不发送敏感数据'] },
      { toolName: 'knowledge_query', allowed: true, riskLevel: 'low', requiresApproval: false, maxCallsPerSession: 100, description: '查询知识库', constraints: ['只读操作', '无安全风险'] },
      { toolName: 'list_directory', allowed: true, riskLevel: 'low', requiresApproval: false, maxCallsPerSession: 50, description: '列出目录内容', constraints: ['仅列出allowedPaths中的目录'] },
      { toolName: 'analyze_data', allowed: true, riskLevel: 'low', requiresApproval: false, maxCallsPerSession: 50, description: '分析数据', constraints: ['只读操作', '不修改原始数据'] },
    ];

    const map = new Map<string, ToolPermission>();
    for (const perm of perms) {
      map.set(perm.toolName, perm);
    }
    return map;
  }

  /** 初始化功能清单 */
  private initCapabilities(): CapabilityItem[] {
    return [
      { id: 'file_read', name: '文件读取', category: 'file', enabled: true, riskLevel: 'low', description: '读取项目目录中的文件内容', implementation: '通过file_read工具读取，路径受allowedPaths约束', limitations: ['仅限项目目录内文件', '文件大小不超过10MB', '敏感文件（.env, .key）不可读'], securityMeasures: ['路径白名单校验', '文件扩展名检查', '大小限制'] },
      { id: 'file_write', name: '文件写入', category: 'file', enabled: true, riskLevel: 'medium', description: '向项目目录写入文件', implementation: '通过file_write工具写入，需要用户确认', limitations: ['仅限项目目录内', '不覆盖系统文件', '需用户确认'], securityMeasures: ['写入前路径校验', '用户确认机制', '扩展名白名单'] },
      { id: 'code_exec', name: '代码执行', category: 'code', enabled: true, riskLevel: 'medium', description: '在安全沙箱中执行JavaScript代码', implementation: '通过code_execute工具在VM沙箱中执行', limitations: ['仅支持JavaScript', '无文件/网络访问', '5秒超时限制'], securityMeasures: ['VM沙箱隔离', '执行超时', '内存限制'] },
      { id: 'shell_exec', name: 'Shell命令执行', category: 'system', enabled: true, riskLevel: 'high', description: '在项目目录中执行Shell/PowerShell命令', implementation: '通过shell_execute工具执行，需要用户确认', limitations: ['仅限项目目录', '禁止危险命令', '30秒超时'], securityMeasures: ['命令白名单', '用户确认', '超时保护'] },
      { id: 'web_search', name: '网络搜索', category: 'web', enabled: true, riskLevel: 'low', description: '通过DuckDuckGo搜索网络信息', implementation: '通过web_search工具调用DuckDuckGo搜索API', limitations: ['每分钟最多30次', '仅返回摘要', '不保证实时性'], securityMeasures: ['频率限制', '域名过滤', '结果过滤'] },
      { id: 'web_fetch', name: '网页抓取', category: 'web', enabled: true, riskLevel: 'medium', description: '抓取指定URL的网页内容', implementation: '通过web_fetch工具获取网页文本内容', limitations: ['禁止访问本地服务', '30秒超时', '不执行JS'], securityMeasures: ['域名黑名单', '超时保护', '内容过滤'] },
      { id: 'http_req', name: 'HTTP请求', category: 'web', enabled: true, riskLevel: 'high', description: '发送HTTP请求与外部API交互', implementation: '通过http_request工具发送GET/POST请求', limitations: ['POST需审批', '禁止内网请求', '10次/会话'], securityMeasures: ['内网IP过滤', '请求审批', '频率限制'] },
      { id: 'knowledge', name: '知识查询', category: 'ai', enabled: true, riskLevel: 'low', description: '查询系统知识库和知识图谱', implementation: '通过knowledge_query工具和KnowledgeGraph模块', limitations: ['仅查询已有知识', '知识可能不完整'], securityMeasures: ['只读操作', '无外部访问'] },
      { id: 'nlu', name: '自然语言理解', category: 'ai', enabled: true, riskLevel: 'low', description: '意图识别、实体提取、情感分析', implementation: '通过NLUEngine模块进行规则匹配和分析', limitations: ['基于规则引擎', '依赖规则库覆盖度'], securityMeasures: ['PII检测和屏蔽', '输入验证'] },
      { id: 'reasoning', name: '推理决策', category: 'ai', enabled: true, riskLevel: 'low', description: '链式推理、自我反思、多步规划', implementation: '通过ReasoningEngine模块调用LLM进行推理', limitations: ['依赖LLM能力', '推理深度有限'], securityMeasures: ['推理验证', '置信度评估', '降级策略'] },
    ];
  }

  /** 检查文件访问权限 */
  checkFileAccess(filePath: string, mode: 'read' | 'write'): { allowed: boolean; reason: string } {
    // 检查扩展名
    const ext = '.' + filePath.split('.').pop()?.toLowerCase();
    if (!this.filePolicy.allowedExtensions.includes(ext)) {
      return { allowed: false, reason: `文件扩展名 ${ext} 不在允许列表中` };
    }

    // 检查禁止路径
    for (const denied of this.filePolicy.deniedPaths) {
      if (this.matchPath(filePath, denied)) {
        return { allowed: false, reason: `路径 ${filePath} 匹配禁止模式 ${denied}` };
      }
    }

    // 检查允许路径
    const isAllowedPath = this.filePolicy.allowedPaths.some(p => this.matchPath(filePath, p));
    if (!isAllowedPath) {
      return { allowed: false, reason: `路径 ${filePath} 不在允许的路径范围内` };
    }

    // 写入模式额外检查
    if (mode === 'write') {
      // 检查只读模式
      for (const readOnly of this.filePolicy.readOnlyPatterns) {
        if (this.matchPath(filePath, readOnly)) {
          return { allowed: false, reason: `路径 ${filePath} 为只读` };
        }
      }
    }

    return { allowed: true, reason: '访问权限验证通过' };
  }

  /** 检查网页访问权限 */
  checkWebAccess(url: string, action: 'fetch' | 'search' | 'automate'): { allowed: boolean; reason: string } {
    // 检查能力开关
    if (action === 'fetch' && !this.webCapability.canFetch) {
      return { allowed: false, reason: '网页抓取功能未启用' };
    }
    if (action === 'search' && !this.webCapability.canSearch) {
      return { allowed: false, reason: '搜索功能未启用' };
    }
    if (action === 'automate' && !this.webCapability.canAutomate) {
      return { allowed: false, reason: '自动化操作功能未启用（安全考虑）' };
    }

    // 检查禁止域名
    try {
      const hostname = new URL(url).hostname;
      for (const denied of this.webCapability.deniedDomains) {
        if (denied.startsWith('*.') ? hostname.endsWith(denied.slice(1)) : hostname === denied) {
          return { allowed: false, reason: `域名 ${hostname} 在禁止列表中` };
        }
      }
    } catch {
      return { allowed: false, reason: '无效的URL格式' };
    }

    return { allowed: true, reason: '网页访问权限验证通过' };
  }

  /** 检查工具使用权限 */
  checkToolPermission(toolName: string): { allowed: boolean; riskLevel: string; requiresApproval: boolean; reason: string } {
    const perm = this.toolPermissions.get(toolName);
    if (!perm) {
      return { allowed: false, riskLevel: 'critical', requiresApproval: true, reason: `工具 ${toolName} 未注册` };
    }
    if (!perm.allowed) {
      return { allowed: false, riskLevel: perm.riskLevel, requiresApproval: true, reason: `工具 ${toolName} 已被禁用` };
    }
    return { allowed: true, riskLevel: perm.riskLevel, requiresApproval: perm.requiresApproval, reason: '工具权限验证通过' };
  }

  /** 获取完整功能清单 */
  getCapabilities(): CapabilityItem[] {
    return this.capabilities;
  }

  /** 获取文件访问策略 */
  getFilePolicy(): FileAccessPolicy {
    return { ...this.filePolicy };
  }

  /** 获取网页访问能力 */
  getWebCapability(): WebAccessCapability {
    return { ...this.webCapability };
  }

  /** 获取所有工具权限 */
  getToolPermissions(): ToolPermission[] {
    return Array.from(this.toolPermissions.values());
  }

  /** 生成功能范围报告 */
  generateReport(): { fileAccess: FileAccessPolicy; webAccess: WebAccessCapability; tools: ToolPermission[]; capabilities: CapabilityItem[]; summary: string } {
    const enabledTools = Array.from(this.toolPermissions.values()).filter(t => t.allowed).length;
    const totalTools = this.toolPermissions.size;
    const enabledCapabilities = this.capabilities.filter(c => c.enabled).length;

    return {
      fileAccess: this.filePolicy,
      webAccess: this.webCapability,
      tools: Array.from(this.toolPermissions.values()),
      capabilities: this.capabilities,
      summary: `系统具备${enabledCapabilities}项功能、${enabledTools}/${totalTools}个可用工具。文件访问受路径白名单和扩展名限制，网页访问受域名黑名单和频率限制，高危操作需用户确认。`,
    };
  }

  /** 路径模式匹配（简化版glob） */
  private matchPath(filePath: string, pattern: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    if (normalizedPattern.includes('**')) {
      const prefix = normalizedPattern.split('**')[0];
      return normalizedPath.startsWith(prefix);
    }
    if (normalizedPattern.includes('*')) {
      const regex = new RegExp('^' + normalizedPattern.replace(/\*/g, '[^/]*') + '$');
      return regex.test(normalizedPath);
    }
    return normalizedPath === normalizedPattern;
  }
}
