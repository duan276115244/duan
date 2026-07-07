/**
 * 段先生桌面应用 - 预加载脚本
 * 通过 contextBridge 安全地暴露 IPC 通信接口给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ===== Agent 通信 =====
  agent: {
    send: (message) => ipcRenderer.invoke('agent:send', message),
    chat: (message, history, model, attachments) => ipcRenderer.invoke('agent:chat', { message, history, model, attachments }),
    onStream: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('agent:stream', handler);
      return () => ipcRenderer.removeListener('agent:stream', handler);
    },
    onStop: () => ipcRenderer.invoke('agent:stop'),
    list: () => ipcRenderer.invoke('agent:list'),
    optimizePrompt: (text) => ipcRenderer.invoke('agent:optimizePrompt', text),
    autoRoute: (message, configuredProviders) => ipcRenderer.invoke('agent:autoRoute', { message, configuredProviders }),
    recordPerformance: (model, taskType, success, durationMs) => ipcRenderer.invoke('agent:recordPerformance', { model, taskType, success, durationMs }),
    listAvailableModels: (configuredProviders) => ipcRenderer.invoke('agent:listAvailableModels', { configuredProviders }),
  },

  // ===== 浏览器窗口 =====
  browser: {
    open: (url) => ipcRenderer.invoke('browser:open', url),
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    close: () => ipcRenderer.invoke('browser:close'),
  },

  // ===== 终端 =====
  terminal: {
    execute: (command, cwd) => ipcRenderer.invoke('terminal:execute', { command, cwd }),
    hello: () => ipcRenderer.invoke('terminal:hello'),
    inject: (payload) => ipcRenderer.invoke('terminal:inject', payload),
    onOutput: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('terminal:output', handler);
      return () => ipcRenderer.removeListener('terminal:output', handler);
    },
    onInject: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('terminal:inject', handler);
      return () => ipcRenderer.removeListener('terminal:inject', handler);
    },
  },

  // ===== 配置管理 =====
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    // 统一配置源（v2.0，API Key 加密存储）
    unified: {
      load: () => ipcRenderer.invoke('config:unified:load'),
      status: () => ipcRenderer.invoke('config:unified:status'),
      upsertProfile: (profileId, provider, apiKey, model, baseUrl, label) =>
        ipcRenderer.invoke('config:unified:profile:upsert', { profileId, provider, apiKey, model, baseUrl, label }),
      removeProfile: (profileId) => ipcRenderer.invoke('config:unified:profile:remove', profileId),
      setActive: (profileId) => ipcRenderer.invoke('config:unified:active:set', profileId),
    },
  },

  // ===== 模型管理 =====
  model: {
    list: () => ipcRenderer.invoke('model:list'),
    switch: (modelId) => ipcRenderer.invoke('model:switch', modelId),
    // B2 修复：暴露 model:changed 事件订阅，前端实时感知供应商切换
    onChanged: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('model:changed', handler);
      return () => ipcRenderer.removeListener('model:changed', handler);
    },
  },

  // ===== 系统状态 =====
  system: {
    status: () => ipcRenderer.invoke('system:status'),
    onStatusChange: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('system:status-change', handler);
      return () => ipcRenderer.removeListener('system:status-change', handler);
    },
  },

  // ===== 窗口控制（自定义标题栏） =====
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizedChange: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('window:maximized-change', handler);
      return () => ipcRenderer.removeListener('window:maximized-change', handler);
    },
  },

  // ===== 工具面板控制（Agent 自动激活） =====
  tool: {
    onActivate: (callback) => {
      const handler = (_event, toolId) => callback(toolId);
      ipcRenderer.on('tool:activate', handler);
      return () => ipcRenderer.removeListener('tool:activate', handler);
    },
    onBrowserNavigate: (callback) => {
      const handler = (_event, url) => callback(url);
      ipcRenderer.on('browser:navigate-panel', handler);
      return () => ipcRenderer.removeListener('browser:navigate-panel', handler);
    },
    onEditorOpenFile: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('editor:open-file', handler);
      return () => ipcRenderer.removeListener('editor:open-file', handler);
    },
    onEditorWriteStart: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('editor:write-start', handler);
      return () => ipcRenderer.removeListener('editor:write-start', handler);
    },
    onEditorWriteChunk: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('editor:write-chunk', handler);
      return () => ipcRenderer.removeListener('editor:write-chunk', handler);
    },
    onEditorWriteDone: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('editor:write-done', handler);
      return () => ipcRenderer.removeListener('editor:write-done', handler);
    },
  },

  // ===== 自动更新 =====
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    // P1 修复：补全缺失的更新事件通道
    onChecking: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('updater:checking', handler);
      return () => ipcRenderer.removeListener('updater:checking', handler);
    },
    onNotAvailable: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('updater:not-available', handler);
      return () => ipcRenderer.removeListener('updater:not-available', handler);
    },
    onError: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('updater:error', handler);
      return () => ipcRenderer.removeListener('updater:error', handler);
    },
    onUpdateAvailable: (callback) => {
      const handler = (_event, info) => callback(info);
      ipcRenderer.on('updater:available', handler);
      return () => ipcRenderer.removeListener('updater:available', handler);
    },
    onUpdateDownloaded: (callback) => {
      const handler = (_event, info) => callback(info);
      ipcRenderer.on('updater:downloaded', handler);
      return () => ipcRenderer.removeListener('updater:downloaded', handler);
    },
    onDownloadProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('updater:progress', handler);
      return () => ipcRenderer.removeListener('updater:progress', handler);
    },
    installAndRestart: () => ipcRenderer.invoke('updater:install'),
  },

  // ===== 代码编辑器 =====
  editor: {
    readFile: (filePath) => ipcRenderer.invoke('editor:readFile', filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke('editor:saveFile', filePath, content),
    readDir: (dirPath) => ipcRenderer.invoke('editor:readDir', dirPath),
    // P0 工具融合：Agent 通过 editor_operate goto 跳转行号时，主进程 send 此事件
    onGoto: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('editor:goto', handler);
      return () => ipcRenderer.removeListener('editor:goto', handler);
    },
  },

  // ===== 技能管理 =====
  skill: {
    list: () => ipcRenderer.invoke('skill:list'),
    detail: (skillId) => ipcRenderer.invoke('skill:detail', skillId),
    delete: (skillId) => ipcRenderer.invoke('skill:delete', skillId),
    refresh: () => ipcRenderer.invoke('skill:refresh'),
    generate: (description) => ipcRenderer.invoke('skill:generate', { description }),
    package: (params) => ipcRenderer.invoke('skill:package', params),
    // 从 Web 服务器获取真实技能数据
    remote: () => ipcRenderer.invoke('skills:remote'),
    // E3: 技能市场 — 桥接 main.js 的 skill:market* IPC handler
    marketList: () => ipcRenderer.invoke('skill:marketList'),
    marketInstall: (skillId) => ipcRenderer.invoke('skill:marketInstall', { skillId }),
    marketUninstall: (skillId) => ipcRenderer.invoke('skill:marketUninstall', { skillId }),
    onUpdated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('skill:updated', handler);
      return () => ipcRenderer.removeListener('skill:updated', handler);
    },
  },

  // ===== 消息通道管理 =====
  channel: {
    templates: () => ipcRenderer.invoke('channel:templates'),
    list: () => ipcRenderer.invoke('channel:list'),
    save: (channel) => ipcRenderer.invoke('channel:save', channel),
    delete: (id) => ipcRenderer.invoke('channel:delete', id),
    test: (config) => ipcRenderer.invoke('channel:test', config),
  },

  // ===== 配对管理（通过 IPC 转发到 Web 服务器） =====
  pairing: {
    generate: (note) => ipcRenderer.invoke('pairing:generate', { note }),
    codes: () => ipcRenderer.invoke('pairing:codes'),
    users: () => ipcRenderer.invoke('pairing:users'),
    status: () => ipcRenderer.invoke('pairing:status'),
    unpair: (channel, userId) => ipcRenderer.invoke('pairing:unpair', { channel, userId }),
  },

  // ===== 仪表盘数据 =====
  dashboard: {
    data: () => ipcRenderer.invoke('dashboard:data'),
    // 从 Web 服务器获取真实仪表盘数据
    remote: () => ipcRenderer.invoke('dashboard:remote'),
  },

  // ===== 能力评估（统一 10 维度 / 31 指标评估框架） =====
  capability: {
    dimensions: () => ipcRenderer.invoke('capability:dimensions'),
    report: () => ipcRenderer.invoke('capability:report'),
    assess: (body) => ipcRenderer.invoke('capability:assess', body || {}),
    saveBaseline: () => ipcRenderer.invoke('capability:save-baseline'),
    baseline: () => ipcRenderer.invoke('capability:baseline'),
    snapshots: () => ipcRenderer.invoke('capability:snapshots'),
    runtimeValues: () => ipcRenderer.invoke('capability:runtime-values'),
  },

  // ===== 远程对话（飞书/企业微信等通道） =====
  remoteConversations: {
    list: () => ipcRenderer.invoke('conversations:remote'),
    messages: (conversationId) => ipcRenderer.invoke('conversations:remote:messages', { conversationId }),
    onUpdated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('remote:conversationsUpdated', handler);
      return () => ipcRenderer.removeListener('remote:conversationsUpdated', handler);
    },
  },

  // ===== 语音设置 =====
  voice: {
    load: () => ipcRenderer.invoke('voice:load'),
    save: (config) => ipcRenderer.invoke('voice:save', config),
    listVoices: () => ipcRenderer.invoke('voice:listVoices'),
    testVoice: (config) => ipcRenderer.invoke('voice:test', config),
    transcribe: (args) => ipcRenderer.invoke('voice:transcribe', args),
    stopRecording: () => ipcRenderer.invoke('voice:stopRecording'),
    // 4.2 修复：暴露主动发声 IPC 事件（main.js:2125 发送，原仅 desktop/index.html 监听但该文件从不加载）
    onProactiveAnnounce: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('voice:proactive-announce', handler);
      return () => ipcRenderer.removeListener('voice:proactive-announce', handler);
    },
  },

  // ===== API Key 验证 =====
  testApiKey: (provider, apiKey, baseURL) => ipcRenderer.invoke('test:api_key', { provider, apiKey, baseURL }),

  // ===== 文件对话框 =====
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  },

  // ===== 自我改进（Agent 自我修复/完善能力，可控）=====
  selfImprove: {
    getStatus: () => ipcRenderer.invoke('self-improve:get'),
    setEnabled: (enabled) => ipcRenderer.invoke('self-improve:set', { enabled }),
    getHistory: (limit) => ipcRenderer.invoke('self-improve:history', { limit }),
    listBackups: () => ipcRenderer.invoke('self-improve:backups'),
    rollback: (backupPath) => ipcRenderer.invoke('self-improve:rollback', { backupPath }),
    // F2 修复：前端触发执行一次 evolve cycle（含 tsc + vitest 护栏，失败自动回滚）
    run: (focus) => ipcRenderer.invoke('self-improve:run', { focus }),
    // P0 自我改进接通：获取 SelfEvolutionEngine 进化历史（insights/推荐/指标）
    evolutionHistory: () => ipcRenderer.invoke('self-improve:evolutionHistory'),
  },

  // ===== Shell 工具（安全的外部链接打开）=====
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ===== C2: SubAgent 多 Agent 编排 =====
  subAgent: {
    // SSE 流：Electron 模式通过 main 进程 IPC 桥接，避免 renderer 跨域
    onStream: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('subagent:stream', handler);
      return () => ipcRenderer.removeListener('subagent:stream', handler);
    },
    // 连接/断开 SSE 流（main 进程管理长连接）
    connectStream: () => ipcRenderer.invoke('subagent:stream:connect'),
    disconnectStream: () => ipcRenderer.invoke('subagent:stream:disconnect'),
    // 列表
    listAgents: () => ipcRenderer.invoke('subagent:listAgents'),
    listTemplates: () => ipcRenderer.invoke('subagent:listTemplates'),
    // 启动团队执行
    startTeam: (templateName, taskGoal, extraContext) =>
      ipcRenderer.invoke('subagent:startTeam', { templateName, taskGoal, extraContext }),
  },

  // ===== D-IPC: MCP 插件市场（走 HTTP，Web/Electron 通用）=====
  mcp: {
    // 市场操作
    listMarketplace: () => ipcRenderer.invoke('mcp:marketplace:list'),
    listInstalled: () => ipcRenderer.invoke('mcp:marketplace:installed'),
    installPlugin: (id) => ipcRenderer.invoke('mcp:marketplace:install', { id }),
    uninstallPlugin: (id) => ipcRenderer.invoke('mcp:marketplace:uninstall', { id }),
    enablePlugin: (id, enabled) => ipcRenderer.invoke('mcp:marketplace:enable', { id, enabled }),
    getStats: () => ipcRenderer.invoke('mcp:marketplace:stats'),
    checkUpdates: () => ipcRenderer.invoke('mcp:marketplace:updates'),
  },
});
