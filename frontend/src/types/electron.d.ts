/**
 * Electron IPC 接口类型声明
 * 与 preload.js 中 contextBridge.exposeInMainWorld 暴露的接口一一对应
 * P1-1 修复：补全所有缺失的接口声明，与 preload.js 保持同步
 */

interface ElectronAPI {
  /** Agent 通信 */
  agent: {
    send: (message: any) => Promise<any>;
    chat: (
      message: string,
      history: Array<{ role: string; content: string }>,
      model?: string,
      attachments?: Array<{ name: string; path: string; isImage: boolean; base64: string; mimeType: string; ext: string }>
    ) => Promise<any>;
    onStream: (callback: (data: any) => void) => () => void;
    onStop: () => Promise<any>;
    list: () => Promise<{ success: boolean; agents?: any[]; error?: string }>;
    optimizePrompt: (text: string) => Promise<{ success: boolean; optimized?: string; error?: string }>;
    autoRoute: (message: string, configuredProviders: string[]) => Promise<any>;
    recordPerformance: (model: string, taskType: string, success: boolean, durationMs: number) => Promise<any>;
    listAvailableModels: (configuredProviders: string[]) => Promise<any>;
  };

  /** 浏览器窗口 */
  browser: {
    open: (url: string) => Promise<any>;
    navigate: (url: string) => Promise<any>;
    close: () => Promise<any>;
  };

  /** 终端（4.3：补全 hello/onInject/inject 与 cwd 参数，与 preload.js 对齐） */
  terminal: {
    execute: (command: string, cwd?: string) => Promise<{ stdout?: string; stderr?: string; error?: string; cwd?: string }>;
    /** 获取终端初始提示符与 cwd */
    hello: () => Promise<{ cwd: string; prompt: string; shell: string }>;
    /** 主动注入命令/输出到终端 */
    inject: (payload: { command?: string; output?: string; type?: string; clear?: boolean }) => Promise<any>;
    /** 订阅终端流式输出 */
    onOutput: (callback: (data: { type: string; data: string }) => void) => () => void;
    /** 订阅 terminal_operate 工具注入事件 */
    onInject: (callback: (data: { command?: string; output?: string; type?: string; clear?: boolean }) => void) => () => void;
  };

  /** 配置管理 */
  config: {
    load: () => Promise<any>;
    save: (config: any) => Promise<any>;
    /** 统一配置源（v2.0，API Key 加密存储） */
    unified: {
      load: () => Promise<any>;
      status: () => Promise<any>;
      upsertProfile: (
        profileId: string,
        provider: string,
        apiKey: string,
        model: string,
        baseUrl: string,
        label: string
      ) => Promise<any>;
      removeProfile: (profileId: string) => Promise<any>;
      setActive: (profileId: string) => Promise<any>;
    };
  };

  /** 模型管理 */
  model: {
    list: () => Promise<any>;
    switch: (modelId: string) => Promise<any>;
    /** B2 修复：供应商切换广播事件订阅 */
    onChanged: (callback: (data: any) => void) => () => void;
  };

  /** 系统状态 */
  system: {
    status: () => Promise<any>;
    onStatusChange: (callback: (data: any) => void) => () => void;
  };

  /** 窗口控制（自定义标题栏） */
  window: {
    minimize: () => Promise<any>;
    maximize: () => Promise<any>;
    close: () => Promise<any>;
    onMaximizedChange: (callback: (data: any) => void) => () => void;
  };

  /** 工具面板控制（Agent 自动激活） */
  tool: {
    onActivate: (callback: (toolId: string) => void) => () => void;
    onBrowserNavigate: (callback: (url: string) => void) => () => void;
    onEditorOpenFile: (callback: (data: any) => void) => () => void;
    /** P0 工具融合：Agent 通过 editor_operate 写文件时推送进度事件 */
    onEditorWriteStart: (callback: (data: any) => void) => () => void;
    onEditorWriteChunk: (callback: (data: any) => void) => () => void;
    onEditorWriteDone: (callback: (data: any) => void) => () => void;
  };

  /** 自动更新 */
  updater: {
    checkForUpdates: () => Promise<any>;
    onChecking: (callback: (data: any) => void) => () => void;
    onNotAvailable: (callback: (data: any) => void) => () => void;
    onError: (callback: (data: any) => void) => () => void;
    onUpdateAvailable: (callback: (info: any) => void) => () => void;
    onUpdateDownloaded: (callback: (info: any) => void) => () => void;
    onDownloadProgress: (callback: (progress: any) => void) => () => void;
    installAndRestart: () => void;
  };

  /** 代码编辑器 */
  editor: {
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    saveFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    readDir: (dirPath: string) => Promise<{ success: boolean; tree?: any[]; error?: string }>;
    /** P0 工具融合：Agent 通过 editor_operate goto 跳转行号时，主进程 send 此事件 */
    onGoto: (callback: (data: { filePath: string; line?: number; column?: number }) => void) => () => void;
  };

  /** 技能管理 */
  skill: {
    list: () => Promise<{ success: boolean; skills: any[]; error?: string }>;
    detail: (skillId: string) => Promise<{ success: boolean; quality?: any; error?: string }>;
    delete: (skillId: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    refresh: () => Promise<{ success: boolean; error?: string }>;
    /** 生成技能（LLM 生成 skill 定义） */
    generate: (description: string) => Promise<{ success: boolean; skill?: any; error?: string }>;
    /** 打包技能 */
    package: (params: any) => Promise<{ success: boolean; path?: string; error?: string }>;
    /** 从 Web 服务器获取真实技能数据 */
    remote: () => Promise<{ success: boolean; skills?: any[]; error?: string }>;
    /** E3: 技能市场 */
    marketList: () => Promise<{ success: boolean; skills?: any[]; error?: string }>;
    marketInstall: (skillId: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    marketUninstall: (skillId: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    onUpdated: (callback: (data: any) => void) => () => void;
  };

  /** 消息通道管理 */
  channel: {
    templates: () => Promise<any>;
    list: () => Promise<any>;
    save: (channel: any) => Promise<any>;
    delete: (id: string) => Promise<any>;
    test: (config: any) => Promise<any>;
  };

  /** 仪表盘数据 */
  dashboard: {
    data: () => Promise<{
      success: boolean;
      metrics?: any;
      report?: any;
      snapshots?: any[];
      profile?: any;
      sla?: any;
      predAcc?: any;
      recStats?: any;
      error?: string;
    }>;
    /** 从 Web 服务器获取真实仪表盘数据 */
    remote: () => Promise<{
      success: boolean;
      metrics?: any;
      report?: any;
      snapshots?: any[];
      profile?: any;
      sla?: any;
      predAcc?: any;
      recStats?: any;
      error?: string;
    }>;
  };

  /** 能力评估（统一 10 维度 / 31 指标评估框架） */
  capability: {
    /** 获取静态维度定义 + 指标规格 */
    dimensions: () => Promise<{
      dimensions: any[];
      metrics: any[];
      metricsByDimension: Record<string, any[]>;
      error?: string;
    }>;
    /** 最近一次评估报告（last-report.json）；无则 404 */
    report: () => Promise<any>;
    /** 触发新评估；body.label: 'current' | 'manual'，默认 'current' */
    assess: (body?: { label?: 'current' | 'manual' }) => Promise<any>;
    /** 保存当前评估为 baseline */
    saveBaseline: () => Promise<any>;
    /** 加载 baseline */
    baseline: () => Promise<any>;
    /** 历史快照（最多 200 个，前端趋势图） */
    snapshots: () => Promise<{ snapshots: any[]; count: number; error?: string }>;
    /** 当前 runtime 埋点值（source='new' 的指标） */
    runtimeValues: () => Promise<{ values: Record<string, number>; count: number; error?: string }>;
  };

  /** 语音设置与主动发声（4.2：补全类型，消除 VoiceOutput.tsx 的 (window as any).electronAPI） */
  voice: {
    load: () => Promise<any>;
    save: (config: any) => Promise<any>;
    listVoices: () => Promise<any>;
    testVoice: (config: any) => Promise<any>;
    transcribe: (args: any) => Promise<any>;
    stopRecording: () => Promise<any>;
    /** 主动发声事件订阅（main 进程在收到 proactive_announcement 时推送） */
    onProactiveAnnounce: (callback: (data: { text: string; severity?: string }) => void) => () => void;
  };

  /** API Key 验证 */
  testApiKey: (provider: string, apiKey: string, baseURL?: string) => Promise<{ valid: boolean; message: string }>;

  /** 文件对话框 */
  dialog: {
    openFile: (options?: any) => Promise<any>;
  };

  /** 自我改进（Agent 自我修复/完善能力，可控）*/
  selfImprove: {
    getStatus: () => Promise<{ success: boolean; enabled?: boolean; historyCount?: number; backupCount?: number; error?: string }>;
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    getHistory: (limit?: number) => Promise<{ success: boolean; history?: any[]; error?: string }>;
    listBackups: () => Promise<{ success: boolean; backups?: Array<{ name: string; path: string; size: number; mtime: number }>; error?: string }>;
    rollback: (backupPath: string) => Promise<{ success: boolean; restoredFile?: string; error?: string }>;
    /** F2: 前端触发执行一次 evolve cycle（含 tsc + vitest 护栏，失败自动回滚） */
    run: (focus?: string) => Promise<{ success: boolean; result?: any; error?: string }>;
    /** P0 自我改进接通：获取 SelfEvolutionEngine 进化历史（insights/推荐/指标） */
    evolutionHistory: () => Promise<{
      success: boolean;
      history?: Array<{
        id: string;
        timestamp: number;
        summary: string;
        successCount: number;
        failCount: number;
        durationMs: number;
        actions?: Array<{ name?: string; status?: string; priority?: string }>;
      }>;
      stats?: string;
      report?: string;
      error?: string;
    }>;
  };

  /** C2: SubAgent 多 Agent 编排（IPC 桥接，main 进程管理 SSE 长连接） */
  subAgent: {
    /** SSE 事件订阅（main 进程转发后端 SSE 流到 renderer） */
    onStream: (callback: (event: any) => void) => () => void;
    /** 连接 main 进程管理的 SSE 长连接 */
    connectStream: () => Promise<any>;
    /** 断开 SSE 长连接 */
    disconnectStream: () => Promise<any>;
    /** 列出所有可用 SubAgent 角色 */
    listAgents: () => Promise<{ success: boolean; agents?: Array<{ name: string; description: string }>; error?: string }>;
    /** 列出所有团队模板（内置 + 自定义，含 members 详情与 custom 标记） */
    listTemplates: () => Promise<{
      success: boolean;
      templates?: Array<{
        id: string;
        name: string;
        description: string;
        custom?: boolean;
        members?: Array<{ role: string; name: string; priority?: number; tokenBudget?: number; allowedTools?: string[] }>;
        maxConcurrent?: number;
        useWorktreeIsolation?: boolean;
      }>;
      error?: string;
    }>;
    /** 启动团队执行（fire-and-forget，进度通过 SSE 推送） */
    startTeam: (templateName: string, taskGoal: string, extraContext?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 启动自定义团队执行（fire-and-forget，进度通过 SSE 推送） */
    startCustomTeam: (config: any) => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 列出团队执行历史摘要 */
    listHistory: () => Promise<{ success: boolean; history?: Array<{ id: string; teamName: string; success: boolean; duration: number; memberCount: number }>; error?: string }>;
    /** 获取单次执行详情 */
    getExecution: (id: string) => Promise<{ success: boolean; execution?: any; error?: string }>;
    /** 列出自定义团队模板 */
    listCustomTemplates: () => Promise<{ success: boolean; templates?: any[]; error?: string }>;
    /** 保存/更新自定义团队模板 */
    saveCustomTemplate: (template: any) => Promise<{ success: boolean; template?: any; message?: string; error?: string }>;
    /** 删除自定义团队模板 */
    deleteCustomTemplate: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  };

  /** Phase 3: 工作流构建器（YAML 编辑 + DAG 预览 + 执行监控） */
  workflow: {
    /** SSE 流：订阅工作流执行事件（返回 unsubscribe 函数） */
    onStream: (callback: (event: any) => void) => () => void;
    /** 连接 SSE 流（main 进程管理长连接） */
    connectStream: () => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 断开 SSE 流 */
    disconnectStream: () => Promise<{ success: boolean }>;
    /** 列出所有已保存的工作流定义 */
    list: () => Promise<{ success: boolean; workflows?: any[]; error?: string }>;
    /** 获取单个工作流定义 */
    get: (id: string) => Promise<{ success: boolean; workflow?: any; error?: string }>;
    /** 保存/更新工作流定义（先验证再写入） */
    save: (definition: any) => Promise<{ success: boolean; id?: string; workflow?: any; warnings?: string[]; message?: string; error?: string; errors?: string[] }>;
    /** 删除工作流定义 */
    delete: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 验证工作流定义或 YAML */
    validate: (payload: { definition?: any; yaml?: string }) => Promise<{ success: boolean; valid?: boolean; errors?: string[]; warnings?: string[]; definition?: any; error?: string }>;
    /** 执行工作流（fire-and-forget，进度通过 SSE 推送） */
    execute: (payload: { id?: string; definition?: any; yaml?: string; inputs?: Record<string, unknown> }) => Promise<{ success: boolean; executionId?: string; workflowName?: string; message?: string; error?: string }>;
    /** 列出执行历史 */
    history: () => Promise<{ success: boolean; history?: any[]; error?: string }>;
  };

  /** D-IPC: MCP 插件市场（走 HTTP，Web/Electron 通用） */
  mcp: {
    /** 列出市场所有可用插件 */
    listMarketplace: () => Promise<{ success: boolean; plugins?: any[]; error?: string }>;
    /** 列出已安装插件 */
    listInstalled: () => Promise<{ success: boolean; plugins?: any[]; error?: string }>;
    /** 安装指定插件 */
    installPlugin: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 卸载指定插件 */
    uninstallPlugin: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 启用/禁用插件 */
    enablePlugin: (id: string, enabled: boolean) => Promise<{ success: boolean; message?: string; error?: string }>;
    /** 获取市场统计 */
    getStats: () => Promise<{ success: boolean; stats?: any; error?: string }>;
    /** 检查更新 */
    checkUpdates: () => Promise<{ success: boolean; updates?: any[]; error?: string }>;
  };

  /** 远程对话（飞书/企业微信等通道） */
  remoteConversations: {
    list: () => Promise<{ success: boolean; conversations?: any[]; error?: string }>;
    messages: (conversationId: string) => Promise<{ success: boolean; messages?: any[]; error?: string }>;
    onUpdated: (callback: (data: any) => void) => () => void;
  };

  /** i18n 语种管理 */
  i18n: {
    getLocale: () => Promise<{ success: boolean; locale?: string; error?: string }>;
    setLocale: (locale: string) => Promise<{ success: boolean; error?: string }>;
  };

  /** Shell 工具（安全的外部链接打开） */
  shell: {
    openExternal: (url: string) => Promise<void>;
  };

  /** 配对管理（通过 IPC 转发到 Web 服务器） */
  pairing: {
    generate: (note?: string) => Promise<{ success: boolean; code?: string; error?: string }>;
    codes: () => Promise<{ success: boolean; codes?: any[]; error?: string }>;
    users: () => Promise<{ success: boolean; users?: any[]; error?: string }>;
    status: () => Promise<{ success: boolean; status?: any; error?: string }>;
    unpair: (channel: string, userId: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  };
}

interface Window {
  electronAPI?: ElectronAPI;
}
