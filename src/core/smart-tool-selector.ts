/**
 * 智能工具选择器 — SmartToolSelector
 *
 * 借鉴 Claude Code 的"分层工具体系"和 Cursor 的"上下文优先"策略，
 * 不再把所有工具一次性暴露给 LLM，而是根据任务意图自动过滤和排序工具列表。
 *
 * 核心能力：
 * 1. 意图→工具类别映射：不同意图只暴露相关类别的工具
 * 2. 风险等级排序：safe > moderate > dangerous，降低误操作概率
 * 3. 失败追踪与替代建议：工具连续失败后自动降级，推荐替代方案
 * 4. 计划提示：计划步骤建议的工具提升到前面
 * 5. 上下文相关性排序：根据最近上下文对工具做相关性排序
 * 6. 智能意图推断：基于中文分词的多关键词加权评分
 */

import { tokenize } from '../utils/chinese-nlp.js';
import { CrossAttention, SimpleEmbedder } from './attention-mechanism.js';
import type { EmbeddingProvider } from './embedding-provider.js';

// ============ 类型定义 ============

/** 工具分类 */
export type ToolCategory = 'read' | 'write' | 'execute' | 'browse' | 'desktop' | 'search' | 'memory' | 'self' | 'plan' | 'meta' | 'engineering';

/** 任务意图类型 */
export type TaskIntent = 'code' | 'browse' | 'desktop' | 'search' | 'file' | 'chat' | 'self_modify' | 'mixed';

/** 工具风险等级 */
export type ToolRisk = 'safe' | 'moderate' | 'dangerous';

/** 工具元信息 */
export interface ToolMeta {
  name: string;
  category: ToolCategory;
  risk: ToolRisk;
  keywords: string[];          // 触发关键词（应尽量去重，避免与同义工具共享通用词）
  distinctKeywords?: string[]; // 区分度关键词：仅该工具独有、用于在近重复工具间提升排序区分度
  sharedKeywords?: string[];   // 共享/通用关键词：与同义工具重叠，匹配时权重应降低
  dependsOn?: string[];        // 前置工具
  conflictsWith?: string[];    // 冲突工具（不应同时出现）
  priority?: number;           // 同义工具优先序，数值越大越优先（用于在冲突时择优）
}

/** selectTools 选项 */
export interface SelectToolsOptions {
  maxTools?: number;        // 最多返回几个工具，默认15
  includeFailed?: boolean;  // 是否包含已失败的工具，默认false
  planHints?: string[];     // 计划步骤建议的工具名
  recentContext?: string;   // 最近上下文（用于相关性排序）
}

/** 工具定义（与外部注册体系兼容的轻量格式） */

export interface ToolDefinition {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: any;
}

// ============ 内置工具元信息（约40个） ============

const BUILTIN_TOOL_METAS: ToolMeta[] = [
  // read 类
  { name: 'file_read', category: 'read', risk: 'safe', keywords: ['读取', '查看', '文件', '内容', 'read', 'file', 'cat', 'open'] },
  { name: 'list_directory', category: 'read', risk: 'safe', keywords: ['目录', '列表', '文件', 'list', 'dir', 'ls'] },
  { name: 'search_files', category: 'read', risk: 'safe', keywords: ['搜索', '查找', '文件', 'search', 'find', 'grep'] },
  { name: 'extract', category: 'read', risk: 'safe', keywords: ['提取', '抽取', 'extract'] },
  { name: 'info', category: 'read', risk: 'safe', keywords: ['信息', '详情', 'info', 'detail'] },

  // write 类
  { name: 'file_write', category: 'write', risk: 'dangerous', keywords: ['写入', '修改', '保存', '创建', 'write', 'save', 'create', 'edit'] },
  { name: 'self_write', category: 'write', risk: 'dangerous', keywords: ['自我', '修改', '写入', 'self', 'write', 'evolve'] },
  { name: 'self_patch', category: 'write', risk: 'dangerous', keywords: ['补丁', '修复', 'patch', 'fix'] },

  // execute 类
  { name: 'code_execute', category: 'execute', risk: 'moderate', keywords: ['执行', '运行', '代码', 'code', 'run', 'execute', 'eval'] },
  { name: 'shell_execute', category: 'execute', risk: 'dangerous', keywords: ['命令', '终端', '执行', 'shell', 'terminal', 'cmd', 'bash'] },

  // browse 类
  { name: 'browser_operate', category: 'browse', risk: 'moderate', keywords: ['浏览器', '网页', '打开', 'browser', 'web', 'navigate', 'click'] },
  { name: 'web_fetch', category: 'browse', risk: 'safe', keywords: ['抓取', '获取', '网页', 'fetch', 'download', 'url', 'http'] },
  { name: 'http_request', category: 'browse', risk: 'moderate', keywords: ['请求', '接口', 'API', 'http', 'request', 'rest'] },

  // search 类（web_search 归入 search，search_files 已在 read 中注册，file 意图需要它）
  { name: 'web_search', category: 'search', risk: 'safe', keywords: ['搜索', '网上', '查询', 'search', 'google', 'bing', 'web'] },
  { name: 'desktop_open', category: 'desktop', risk: 'moderate', keywords: ['打开', '应用', '桌面', 'desktop', 'open', 'app', 'launch'] },
  { name: 'screen_capture', category: 'desktop', risk: 'safe', keywords: ['截图', '屏幕', 'capture', 'screenshot', 'screen'] },
  { name: 'screen_click', category: 'desktop', risk: 'moderate', keywords: ['点击', '屏幕', 'click', 'tap', 'mouse'] },
  { name: 'screen_type', category: 'desktop', risk: 'moderate', keywords: ['输入', '键盘', 'type', 'keyboard', 'input'] },
  { name: 'screen_key', category: 'desktop', risk: 'moderate', keywords: ['按键', '快捷键', 'key', 'hotkey', 'shortcut'] },
  { name: 'visual_analyze', category: 'desktop', risk: 'safe', keywords: ['视觉', '分析', '图片', 'visual', 'analyze', 'image', 'ocr'] },
  { name: 'visual_find_click', category: 'desktop', risk: 'moderate', keywords: ['查找', '点击', '视觉', 'find', 'click', 'locate'] },
  { name: 'screen_scroll', category: 'desktop', risk: 'moderate', keywords: ['滚动', '滚轮', '翻页', 'scroll', 'wheel', 'page'] },
  { name: 'screen_move', category: 'desktop', risk: 'safe', keywords: ['移动', '鼠标', 'move', 'cursor', 'hover'] },
  { name: 'screen_size', category: 'desktop', risk: 'safe', keywords: ['屏幕', '尺寸', '分辨率', 'size', 'resolution'] },
  { name: 'screen_find', category: 'desktop', risk: 'safe', keywords: ['查找', '屏幕', '定位', 'find', 'locate', '元素'] },
  { name: 'screen_open', category: 'desktop', risk: 'moderate', keywords: ['打开', '应用', '启动', 'open', 'launch', 'app'] },
  { name: 'screen_analyze', category: 'desktop', risk: 'safe', keywords: ['分析', '屏幕', '视觉', 'analyze', 'visual', '识别'] },
  { name: 'window_manage', category: 'desktop', risk: 'moderate', keywords: ['窗口', '管理', '最小化', '最大化', '关闭', 'window', 'manage', 'minimize', 'maximize'] },
  { name: 'clipboard', category: 'desktop', risk: 'safe', keywords: ['剪贴板', '复制', '粘贴', 'clipboard', 'copy', 'paste'] },

  // 微信类
  { name: 'wechat_open', category: 'desktop', risk: 'moderate', keywords: ['微信', '打开', 'wechat', 'open'] },
  { name: 'wechat_find_contact', category: 'desktop', risk: 'safe', keywords: ['微信', '查找', '联系人', 'wechat', 'find', 'contact'] },
  { name: 'wechat_send_message', category: 'desktop', risk: 'moderate', keywords: ['微信', '发送', '消息', 'wechat', 'send', 'message'] },
  { name: 'wechat_send_file', category: 'desktop', risk: 'moderate', keywords: ['微信', '发送', '文件', 'wechat', 'file'] },
  { name: 'wechat_status', category: 'desktop', risk: 'safe', keywords: ['微信', '状态', 'wechat', 'status'] },
  // P0 修复: 新增朋友圈工具元信息，否则 desktop 意图下被 smart-tool-selector 过滤掉，LLM 看不到
  { name: 'wechat_post_moments', category: 'desktop', risk: 'moderate', keywords: ['微信', '朋友圈', '发朋友圈', '发表', '动态', 'wechat', 'moments', 'post'] },

  // 应用操控类
  { name: 'app_launch', category: 'desktop', risk: 'moderate', keywords: ['应用', '启动', '打开', 'app', 'launch', 'open'] },
  { name: 'app_click', category: 'desktop', risk: 'moderate', keywords: ['应用', '点击', 'app', 'click'] },
  { name: 'app_type', category: 'desktop', risk: 'moderate', keywords: ['应用', '输入', 'app', 'type', 'input'] },
  { name: 'app_find_click', category: 'desktop', risk: 'moderate', keywords: ['应用', '查找', '点击', 'app', 'find', 'click'] },
  { name: 'app_smart', category: 'desktop', risk: 'moderate', keywords: ['应用', '智能', '操作', 'app', 'smart'] },
  { name: 'app_screenshot', category: 'desktop', risk: 'safe', keywords: ['应用', '截图', 'app', 'screenshot'] },
  { name: 'app_menu', category: 'desktop', risk: 'moderate', keywords: ['应用', '菜单', 'app', 'menu'] },

  // 图像生成类（内置能力，零配置）
  { name: 'generate_image', category: 'execute', risk: 'safe', keywords: ['图片', '生成', '画', '绘制', '图像', 'image', 'generate', 'draw', 'paint', 'create image'] },

  // 视频生成类
  { name: 'video_gen_real', category: 'execute', risk: 'moderate', keywords: ['视频', '生成', '创建', 'video', 'generate', 'create'] },
  { name: 'video_gen_from_image', category: 'execute', risk: 'moderate', keywords: ['视频', '图片', '生成', 'video', 'image'] },
  { name: 'video_gen_status', category: 'read', risk: 'safe', keywords: ['视频', '状态', '查询', 'video', 'status'] },

  // LibTV技能类（内置能力，无需外部API Key，使用callLLM+Trae内置引擎）
  { name: 'libtv_generate_image', category: 'execute', risk: 'safe', keywords: ['libtv', 'liblib', '分镜画面', '画面生成', '图片提示词优化'] },
  { name: 'libtv_generate_video', category: 'execute', risk: 'safe', keywords: ['视频方案', '视频策划', '视频制作', '分镜设计', 'video plan', 'storyboard design'] },
  { name: 'libtv_create_storyboard', category: 'execute', risk: 'safe', keywords: ['分镜', '脚本', '剧本', '镜头', 'storyboard', 'script', 'shot list'] },
  { name: 'libtv_edit_media', category: 'execute', risk: 'safe', keywords: ['编辑建议', '风格迁移', '色调调整', '局部修改', 'edit suggestion', 'style transfer'] },
  { name: 'libtv_poll_status', category: 'read', risk: 'safe', keywords: ['查询', '状态', '进度', 'libtv', 'poll', 'status'] },
  { name: 'libtv_download_result', category: 'write', risk: 'safe', keywords: ['保存', '导出', '下载', '结果', 'libtv', 'download', 'export'] },
  { name: 'libtv_list_models', category: 'read', risk: 'safe', keywords: ['模型', '能力', '列表', 'libtv', 'model', 'list', 'capability'] },

  // 语音类
  { name: 'voice_capture', category: 'desktop', risk: 'safe', keywords: ['语音', '录制', '录音', 'voice', 'capture', 'record'] },
  { name: 'voice_speak', category: 'desktop', risk: 'safe', keywords: ['语音', '朗读', '说话', 'voice', 'speak', 'tts'] },
  { name: 'voice_transcribe', category: 'read', risk: 'safe', keywords: ['语音', '转文字', '识别', 'voice', 'transcribe', 'stt'] },

  // Git类
  { name: 'git_operation', category: 'execute', risk: 'moderate', keywords: ['git', '版本', '提交', '分支', 'commit', 'branch', 'push'] },

  // Diff编辑类
  { name: 'diff_apply', category: 'write', risk: 'moderate', keywords: ['差异', '应用', '修改', 'diff', 'apply', 'patch'] },
  { name: 'diff_preview', category: 'read', risk: 'safe', keywords: ['差异', '预览', 'diff', 'preview'] },
  { name: 'diff_rollback', category: 'write', risk: 'dangerous', keywords: ['差异', '回滚', '撤销', 'diff', 'rollback', 'revert'] },

  // 护栏类
  { name: 'guardrail_check_input', category: 'self', risk: 'safe', keywords: ['护栏', '检查', '输入', 'guardrail', 'check'] },
  { name: 'guardrail_check_output', category: 'self', risk: 'safe', keywords: ['护栏', '检查', '输出', 'guardrail', 'check'] },

  // 追踪类
  { name: 'trace_start', category: 'meta', risk: 'safe', keywords: ['追踪', '开始', 'trace', 'start'] },
  { name: 'trace_view', category: 'meta', risk: 'safe', keywords: ['追踪', '查看', 'trace', 'view'] },

  // 交接类
  { name: 'handoff_to', category: 'meta', risk: 'moderate', keywords: ['交接', '转交', 'handoff', 'transfer'] },

  // memory 类
  { name: 'self_memory', category: 'memory', risk: 'safe', keywords: ['记忆', '回忆', 'memory', 'remember', 'recall'] },
  { name: 'memory_search', category: 'memory', risk: 'safe', keywords: ['搜索', '记忆', 'memory', 'search'] },
  { name: 'memory_store', category: 'memory', risk: 'moderate', keywords: ['存储', '记忆', '保存', 'memory', 'store', 'save'] },
  // v20.0 项目分层记忆工具（对标 CLAUDE.md 多层级记忆）
  { name: 'project_memory_list', category: 'memory', risk: 'safe', keywords: ['项目记忆', '约定', '规则', '记忆列表', 'project', 'memory', 'conventions', 'CLAUDE.md'] },
  { name: 'project_memory_write', category: 'memory', risk: 'moderate', keywords: ['记住', '保存约定', '写入记忆', '项目规则', 'remember', 'save', 'convention', 'project', 'memory'] },
  { name: 'project_memory_append', category: 'memory', risk: 'moderate', keywords: ['追加', '添加规则', '追加约定', 'append', 'memory', 'convention'] },
  { name: 'project_memory_delete', category: 'memory', risk: 'dangerous', keywords: ['删除记忆', '删除约定', 'delete', 'memory', 'remove'] },

  // v20.0 代码库语义索引工具（对标 Cursor codebase indexing）
  { name: 'codebase_search', category: 'search', risk: 'safe', keywords: ['代码搜索', '语义搜索', '函数在哪', '查找函数', '查找类', 'codebase', 'search', 'semantic', 'find function', 'find class'] },
  { name: 'codebase_find_references', category: 'read', risk: 'safe', keywords: ['引用', '查找引用', '谁调用了', '引用关系', 'references', 'refs', 'usage'] },
  { name: 'codebase_call_graph', category: 'read', risk: 'safe', keywords: ['调用图', '调用关系', '函数调用', 'call graph', 'call relationship', 'callee'] },
  { name: 'codebase_overview', category: 'read', risk: 'safe', keywords: ['代码概览', '项目结构', '索引概览', 'codebase overview', 'project structure', 'symbol count'] },

  // v20.0 国产系统平台与依赖查询工具（UOS/麒麟/LoongArch 适配）
  { name: 'native_status', category: 'self', risk: 'safe', keywords: ['平台', '架构', '系统', '国产', 'UOS', '麒麟', 'kylin', 'loongarch', 'ARM', 'chromium', 'ffmpeg', '依赖', 'platform', 'arch', 'native', 'system info'] },

  // v20.0 专用子代理预设工具（8 类预设 + 意图派发）
  { name: 'subagent_list', category: 'meta', risk: 'safe', keywords: ['子代理', '预设', '角色', 'subagent', 'preset', 'agent list', '可用代理', '代理列表'] },
  { name: 'subagent_dispatch', category: 'meta', risk: 'moderate', keywords: ['派发', '子代理', '审查', '测试', '架构', '调试', '文档', '安全', '性能', '调研', 'dispatch', 'code-reviewer', 'test-engineer', 'architect', 'debugger', 'doc-writer', 'security-auditor', 'perf-optimizer', 'researcher'] },

  // v20.0 斜杠命令系统工具（对标 Claude Code .claude/commands）
  { name: 'slash_command_list', category: 'meta', risk: 'safe', keywords: ['斜杠命令', '命令列表', 'slash command', '可用命令', '命令帮助', '/help', 'commands'] },
  { name: 'slash_command_execute', category: 'meta', risk: 'safe', keywords: ['执行命令', '斜杠', 'slash', '命令模板', '/init', '/review', '/test', '/deploy', '/subagent', '自定义命令', 'command execute', 'run command'] },

  // v20.0 动态上下文发现工具（对标 Cursor dynamic discovery）
  { name: 'context_discover', category: 'read', risk: 'safe', keywords: ['上下文发现', '相关文件', '动态发现', 'context discover', 'related files', 'discover context', '相关代码', '关联文件', 'import 关系', 'git diff'] },

  // v20.0 多文件协同编辑工具（原子性多文件修改 + 回滚）
  { name: 'multi_file_edit', category: 'write', risk: 'dangerous', keywords: ['多文件编辑', '批量修改', '原子编辑', 'multi file edit', 'batch edit', '协同编辑', '同时修改', '跨文件修改', 'multi edit', '原子性'] },

  // v20.0 分级许可清单工具（对标 Claude Code permissions）
  { name: 'permission_list', category: 'meta', risk: 'safe', keywords: ['许可', '权限', '清单', '查看', 'permission', 'list', 'allow', 'deny', 'ask'] },
  { name: 'permission_grant', category: 'meta', risk: 'moderate', keywords: ['授权', '许可', '允许', '放行', 'grant', 'allow', 'permit', 'approve'] },
  { name: 'permission_revoke', category: 'meta', risk: 'moderate', keywords: ['撤销', '取消', '许可', 'revoke', 'revoke permission', '取消授权'] },

  // v20.0 角色人格系统工具（对标 MetaGPT）
  { name: 'persona_list', category: 'meta', risk: 'safe', keywords: ['角色', '人格', '列表', 'persona', 'role', 'character', '产品经理', '架构师', '工程师'] },
  { name: 'persona_info', category: 'meta', risk: 'safe', keywords: ['角色详情', '人格信息', '角色技能', 'persona info', 'role detail', '角色信息'] },
  { name: 'persona_create', category: 'meta', risk: 'moderate', keywords: ['创建角色', '自定义角色', '新建人格', 'create persona', 'create role', 'add character'] },
  { name: 'persona_delete', category: 'meta', risk: 'moderate', keywords: ['删除角色', '移除人格', 'delete persona', 'remove role'] },
  { name: 'persona_send_message', category: 'meta', risk: 'safe', keywords: ['角色通信', '角色消息', '角色间', 'persona message', 'role communication', '角色协作'] },

  // v20.0 长期目标追踪工具（对标 AutoGPT）
  { name: 'goal_create', category: 'meta', risk: 'moderate', keywords: ['创建目标', '新目标', '长期目标', 'create goal', 'new goal', '目标管理'] },
  { name: 'goal_create_from_template', category: 'meta', risk: 'moderate', keywords: ['模板创建目标', '从模板创建', '重构项目', '学习新技术', '产品迭代', 'goal template', 'create from template'] },
  { name: 'goal_list', category: 'meta', risk: 'safe', keywords: ['目标列表', '查看目标', '所有目标', 'list goals', 'goal list', '目标进度'] },
  { name: 'goal_info', category: 'meta', risk: 'safe', keywords: ['目标详情', '目标信息', '里程碑', '子任务', 'goal info', 'goal detail', '目标状态'] },
  { name: 'goal_progress', category: 'meta', risk: 'safe', keywords: ['下一个任务', '推进目标', '目标进度', '待办', 'next task', 'goal progress', '继续目标'] },
  { name: 'goal_advance', category: 'meta', risk: 'moderate', keywords: ['推进', '完成子任务', '下一个', 'advance goal', 'next subtask', '目标推进'] },
  { name: 'goal_update_status', category: 'meta', risk: 'moderate', keywords: ['更新目标', '激活目标', '暂停目标', '完成目标', '放弃目标', 'update goal', 'activate', 'pause', 'complete', 'abandon'] },
  { name: 'goal_add_subtask', category: 'meta', risk: 'moderate', keywords: ['添加子任务', '新子任务', 'add subtask', 'new task', '增加任务'] },
  { name: 'goal_complete_subtask', category: 'meta', risk: 'moderate', keywords: ['完成子任务', '标记完成', 'complete subtask', 'finish task', '子任务完成'] },
  { name: 'goal_delete', category: 'meta', risk: 'dangerous', keywords: ['删除目标', '移除目标', 'delete goal', 'remove goal', '清除目标'] },
  { name: 'goal_template_list', category: 'meta', risk: 'safe', keywords: ['目标模板', '可用模板', 'goal templates', 'template list', '模板列表'] },

  // v20.0 自主工程任务工具（对标 Devin）
  { name: 'engineering_create', category: 'engineering', risk: 'moderate', keywords: ['工程任务', '自主工程', '实现功能', '开发功能', 'create engineering', 'new task', '需求实现', '端到端'] },
  { name: 'engineering_list', category: 'engineering', risk: 'safe', keywords: ['工程列表', '任务列表', 'list engineering', 'engineering tasks', '查看工程'] },
  { name: 'engineering_info', category: 'engineering', risk: 'safe', keywords: ['工程详情', '任务详情', '阶段状态', 'engineering info', 'task detail', '工程信息'] },
  { name: 'engineering_run', category: 'engineering', risk: 'moderate', keywords: ['执行工程', '启动任务', '运行工程', 'run engineering', 'start task', '执行任务', '自动开发'] },
  { name: 'engineering_pause', category: 'engineering', risk: 'moderate', keywords: ['暂停工程', '暂停任务', 'pause engineering', 'pause task'] },
  { name: 'engineering_resume', category: 'engineering', risk: 'moderate', keywords: ['恢复工程', '继续工程', 'resume engineering', 'resume task', '继续开发'] },
  { name: 'engineering_delete', category: 'engineering', risk: 'dangerous', keywords: ['删除工程', '删除任务', 'delete engineering', 'remove task'] },
  { name: 'engineering_targets', category: 'engineering', risk: 'safe', keywords: ['部署目标', 'deployment target', '部署选项', '部署方式', 'deploy'] },

  // v20.0 多模态文档解析工具（对标 Unstructured/MinerU：统一文档解析）
  { name: 'document_parse', category: 'read', risk: 'safe', keywords: ['解析文档', '文档内容', '读取文档', 'PDF', 'Word', 'Excel', 'PPT', 'parse document', 'document content', '提取文本', '文档提取', '解析表格'] },
  { name: 'document_parse_dir', category: 'read', risk: 'safe', keywords: ['批量解析', '目录文档', '批量文档', 'parse directory', 'batch parse', '解析整个目录', '文件夹文档'] },
  { name: 'document_types', category: 'read', risk: 'safe', keywords: ['文档类型', '支持类型', '支持的格式', 'document types', 'supported formats', '文档格式', '能解析什么'] },

  // v20.0 §5.4 主动提问工具（对标 ChatGPT 追问 / Khan Academy 个性化引导）
  { name: 'proactive_question_check', category: 'self', risk: 'safe', keywords: ['主动提问', '检查提问', '知识盲区', '错误模式', '兴趣信号', 'proactive question', 'check question', '引导学习', '主动追问'] },
  { name: 'proactive_question_feedback', category: 'self', risk: 'safe', keywords: ['提问反馈', '用户反馈', '记录回答', 'feedback', 'record feedback', '用户回答'] },
  { name: 'proactive_question_stats', category: 'self', risk: 'safe', keywords: ['提问统计', '回答率', '提问数据', 'stats', 'statistics', 'question stats'] },
  { name: 'proactive_question_policy', category: 'self', risk: 'moderate', keywords: ['提问策略', '频率控制', '冷却期', '每日上限', 'policy', 'cooldown', 'daily limit', '更新策略'] },

  // 技能市场类（v20.0 §5.4）
  { name: 'skill_market_search', category: 'search', risk: 'safe', keywords: ['技能市场', '搜索技能', '市场搜索', 'skill market', 'search skill', '找技能', '技能商店'] },
  { name: 'skill_market_list', category: 'read', risk: 'safe', keywords: ['技能列表', '市场列表', '推荐技能', '已安装技能', 'list skills', 'featured', '热门技能'] },
  { name: 'skill_market_info', category: 'read', risk: 'safe', keywords: ['技能详情', '技能信息', 'skill info', 'skill detail', '查看技能'] },
  { name: 'skill_market_publish', category: 'write', risk: 'moderate', keywords: ['发布技能', '上架技能', 'publish skill', 'share skill', '分享技能', '提交技能'] },
  { name: 'skill_market_install', category: 'write', risk: 'moderate', keywords: ['安装技能', '下载技能', 'install skill', 'download skill', '获取技能'] },
  { name: 'skill_market_rate', category: 'write', risk: 'safe', keywords: ['评分技能', '技能评分', 'rate skill', 'review skill', '评价技能'] },
  { name: 'skill_market_report', category: 'write', risk: 'safe', keywords: ['举报技能', 'report skill', '投诉技能', '违规技能'] },
  { name: 'skill_market_stats', category: 'read', risk: 'safe', keywords: ['市场统计', '技能统计', 'market stats', 'skill stats', '市场数据'] },

  // 离线协调器类（v20.0 §5.2）
  { name: 'offline_status', category: 'self', risk: 'safe', keywords: ['离线状态', '网络状态', 'offline status', 'network state', '离线模式状态', '本地模型数'] },
  { name: 'offline_probe', category: 'self', risk: 'safe', keywords: ['探测网络', '网络探测', '网络连通性', 'offline probe', 'network probe', '检查网络', '测试网络'] },
  { name: 'offline_mode_toggle', category: 'self', risk: 'moderate', keywords: ['离线模式', '切换离线', '启用离线', '禁用离线', 'offline mode', 'toggle offline', '断网模式'] },
  { name: 'offline_models_detect', category: 'search', risk: 'moderate', keywords: ['检测本地模型', '本地模型', 'ollama 检测', 'llama.cpp 检测', 'detect local models', 'local llm', '离线模型'] },
  { name: 'offline_models_list', category: 'read', risk: 'safe', keywords: ['本地模型列表', '列出本地模型', 'list local models', 'ollama models', '已检测模型'] },
  { name: 'offline_knowledge_query', category: 'search', risk: 'safe', keywords: ['离线知识', '离线文档', '知识库查询', 'offline knowledge', '离线查询', '断网查询'] },
  { name: 'offline_knowledge_add', category: 'write', risk: 'moderate', keywords: ['添加离线知识', '添加知识', 'offline knowledge add', '保存离线文档', '自定义知识'] },
  { name: 'offline_knowledge_list', category: 'read', risk: 'safe', keywords: ['离线知识列表', '知识库列表', 'offline knowledge list', '列出知识'] },

  // 学习进度可视化类（v20.0 §5.4）
  { name: 'progress_overview', category: 'self', risk: 'safe', keywords: ['进度总览', '学习进度', '进度概览', 'progress overview', '学习总览', '快照数'] },
  { name: 'progress_learning_curve', category: 'self', risk: 'safe', keywords: ['学习曲线', '进度曲线', 'learning curve', '时间序列', '学习趋势图', '学习记录曲线'] },
  { name: 'progress_radar_chart', category: 'self', risk: 'safe', keywords: ['能力雷达图', '雷达图', '能力图', 'radar chart', '能力维度', '能力分布'] },
  { name: 'progress_skill_tree', category: 'self', risk: 'safe', keywords: ['技能树', '技能分类', 'skill tree', '技能层级', '技能结构'] },
  { name: 'progress_knowledge_gaps', category: 'self', risk: 'safe', keywords: ['知识盲区', '错误模式', 'knowledge gaps', '盲区视图', '知识缺口'] },
  { name: 'progress_trends', category: 'self', risk: 'safe', keywords: ['趋势分析', '改进趋势', '下降趋势', 'trends', '趋势统计', '指标趋势'] },
  { name: 'progress_snapshot', category: 'self', risk: 'moderate', keywords: ['进度快照', '生成快照', 'progress snapshot', '保存进度', '记录快照'] },
  { name: 'progress_report', category: 'self', risk: 'safe', keywords: ['进度报告', '学习报告', 'progress report', '可视化报告', '综合报告'] },

  // 模型微调类（v20.0 §3.5）
  { name: 'finetune_collect_data', category: 'self', risk: 'moderate', keywords: ['收集训练数据', '训练数据', '微调数据', 'collect training data', 'finetune collect', 'Q&A 样例'] },
  { name: 'finetune_list_examples', category: 'read', risk: 'safe', keywords: ['训练样例列表', '样例池', 'list examples', 'finetune examples', '训练样本'] },
  { name: 'finetune_create_dataset', category: 'write', risk: 'moderate', keywords: ['创建数据集', '训练数据集', 'create dataset', 'finetune dataset', 'LoRA 数据', 'QLoRA 数据', 'ChatML'] },
  { name: 'finetune_list_datasets', category: 'read', risk: 'safe', keywords: ['数据集列表', '列出数据集', 'list datasets', 'finetune datasets'] },
  { name: 'finetune_create_job', category: 'execute', risk: 'moderate', keywords: ['创建训练任务', '训练任务', '微调任务', 'create training job', 'finetune job', 'ollama train', 'llama.cpp fine-tune'] },
  { name: 'finetune_start_job', category: 'execute', risk: 'moderate', keywords: ['启动训练', '开始训练', 'start training', 'finetune start', 'run training'] },
  { name: 'finetune_job_status', category: 'read', risk: 'safe', keywords: ['训练状态', '训练进度', 'job status', 'training progress', 'finetune status'] },
  { name: 'finetune_list_models', category: 'read', risk: 'safe', keywords: ['微调模型列表', '已训练模型', 'trained models', 'finetune models', '微调后的模型'] },

  // 协作类（v20.0 §5.3）
  { name: 'collab_team_register', category: 'write', risk: 'moderate', keywords: ['注册团队成员', '添加成员', '团队注册', 'team register', 'add member', '加入团队'] },
  { name: 'collab_team_list', category: 'read', risk: 'safe', keywords: ['团队成员列表', '成员列表', 'team list', 'members', '在线成员', '团队人员'] },
  { name: 'collab_session_create', category: 'write', risk: 'moderate', keywords: ['创建共享会话', '协作会话', 'session create', 'collab session', '多人会话', '实时协作'] },
  { name: 'collab_session_list', category: 'read', risk: 'safe', keywords: ['会话列表', '列出会话', 'session list', 'collab sessions', '共享会话列表'] },
  { name: 'collab_session_message', category: 'write', risk: 'moderate', keywords: ['发送协作消息', '会话消息', 'session message', 'collab message', '团队聊天', '协作消息'] },
  { name: 'collab_task_assign', category: 'write', risk: 'moderate', keywords: ['分配团队任务', '任务派发', 'task assign', 'collab task', '团队任务', '协作任务'] },
  { name: 'collab_task_list', category: 'read', risk: 'safe', keywords: ['团队任务列表', '协作任务列表', 'task list', 'collab tasks', '团队待办', '任务追踪'] },
  { name: 'collab_knowledge_share', category: 'write', risk: 'moderate', keywords: ['共享知识', '团队知识库', 'knowledge share', 'team knowledge', '协作知识', '知识共享'] },

  // self 类
  { name: 'self_read', category: 'self', risk: 'safe', keywords: ['自我', '读取', '状态', 'self', 'read', 'status'] },
  { name: 'self_evolve', category: 'self', risk: 'dangerous', keywords: ['进化', '升级', '自我', 'evolve', 'upgrade', 'self'] },
  { name: 'self_upgrade', category: 'self', risk: 'dangerous', keywords: ['升级', '自我升级', '代码升级', 'upgrade', 'improve', 'enhance'] },
  { name: 'create_tool', category: 'self', risk: 'dangerous', keywords: ['创建工具', '新工具', 'create', 'tool', '动态', '扩展能力'] },
  { name: 'list_tools', category: 'self', risk: 'safe', keywords: ['工具列表', '查看工具', 'list', 'tools', '可用'] },
  { name: 'self_heal', category: 'self', risk: 'moderate', keywords: ['修复', '自愈', 'heal', 'recover', 'fix'] },
  { name: 'self_test', category: 'self', risk: 'safe', keywords: ['测试', '自检', 'test', 'check', 'verify'] },
  { name: 'self_skills', category: 'self', risk: 'safe', keywords: ['技能', '能力', 'skill', 'ability', 'capability'] },
  { name: 'self_assessment', category: 'self', risk: 'safe', keywords: ['评估', '自评', 'assessment', 'evaluate'] },

  // plan 类
  { name: 'create_plan', category: 'plan', risk: 'safe', keywords: ['计划', '创建', 'plan', 'create', 'strategy'] },
  { name: 'update_plan_step', category: 'plan', risk: 'safe', keywords: ['计划', '更新', '步骤', 'plan', 'update', 'step'] },
  { name: 'get_plan', category: 'plan', risk: 'safe', keywords: ['计划', '获取', 'plan', 'get', 'retrieve'] },
  { name: 'complete', category: 'plan', risk: 'safe', keywords: ['完成', '结束', 'complete', 'finish', 'done'] },

  // meta 类
  { name: 'decision_analyze', category: 'meta', risk: 'safe', keywords: ['决策', '分析', 'decision', 'analyze'] },
  { name: 'decision_execute', category: 'meta', risk: 'moderate', keywords: ['决策', '执行', 'decision', 'execute'] },
  { name: 'task_execute', category: 'meta', risk: 'moderate', keywords: ['任务', '执行', 'task', 'execute'] },
  { name: 'skill_discover', category: 'meta', risk: 'safe', keywords: ['技能', '发现', 'skill', 'discover', 'find'] },
  // P0 技能管理：补全 skill 工具元信息（三步注册第 3 步），否则非 mixed 意图下被过滤
  { name: 'skill_install', category: 'self', risk: 'moderate', keywords: ['技能', '安装', 'install', 'skill', '添加', '启用'] },
  { name: 'skill_evaluate', category: 'self', risk: 'safe', keywords: ['技能', '评估', '安全', 'evaluate', 'skill', '检查'] },
  { name: 'skill_search', category: 'search', risk: 'safe', keywords: ['技能', '搜索', '查找', 'search', 'skill', 'query'] },
  { name: 'skill_list', category: 'read', risk: 'safe', keywords: ['技能', '列表', '已安装', 'list', 'skill', '查看'] },

  // 文档处理类（V20 新增）
  { name: 'file_classify', category: 'read', risk: 'safe', keywords: ['文件', '分类', '统计', '扫描', 'classify', 'category'] },
  { name: 'file_organize', category: 'write', risk: 'moderate', keywords: ['文件', '整理', '归档', '桌面', 'organize', 'archive', 'tidy', 'clean'] },
  { name: 'doc_summarize', category: 'read', risk: 'safe', keywords: ['文档', '汇总', '总结', '提取', 'summarize', 'summary', '合并', '整合'] },
  { name: 'form_fill', category: 'write', risk: 'moderate', keywords: ['表单', '填写', '填充', '模板', 'form', 'fill', 'template'] },
  { name: 'document_optimize', category: 'write', risk: 'moderate', keywords: ['文档', '优化', '润色', '排版', '格式', 'optimize', 'polish', 'format'] },

  // 多媒体类（V20 新增）
  { name: 'image_batch', category: 'execute', risk: 'moderate', keywords: ['图片', '批量', '处理', '缩放', '转换', '压缩', '水印', 'resize', 'convert', 'compress', 'watermark'] },
  { name: 'image_info', category: 'read', risk: 'safe', keywords: ['图片', '信息', '元数据', '尺寸', 'info', 'metadata', 'dimension'] },
  { name: 'photoshop_edit', category: 'desktop', risk: 'moderate', keywords: ['PS', 'Photoshop', '图层', '滤镜', '编辑', 'photoshop', 'layer', 'filter', 'edit'] },
  { name: 'poster_make', category: 'execute', risk: 'safe', keywords: ['海报', '制作', '设计', 'poster', 'make', 'design'] },

  // PPT 类（V20 新增）
  { name: 'ppt_outline', category: 'execute', risk: 'safe', keywords: ['PPT', '大纲', '演示', '幻灯片', 'outline', 'presentation', 'slide'] },
  { name: 'ppt_create', category: 'desktop', risk: 'moderate', keywords: ['PPT', '创建', '制作', '生成', 'create', 'powerpoint'] },
  { name: 'ppt_beautify', category: 'read', risk: 'safe', keywords: ['PPT', '美化', '配色', '版式', '动画', 'beautify', 'theme', 'color'] },
  { name: 'ppt_extract', category: 'read', risk: 'safe', keywords: ['PPT', '提取', '内容', 'extract', 'report'] },

  // 跨应用集成类（V20 新增）
  { name: 'cross_app_transfer', category: 'execute', risk: 'moderate', keywords: ['跨应用', '数据', '传递', '传输', 'transfer', 'cross', 'app'] },
  { name: 'cross_app_receive', category: 'read', risk: 'safe', keywords: ['跨应用', '接收', '数据', 'receive', 'channel'] },
  { name: 'app_capabilities', category: 'read', risk: 'safe', keywords: ['应用', '能力', '列表', '集成', 'capabilities', 'gateway', 'integration'] },
  { name: 'cross_app_workflow', category: 'execute', risk: 'moderate', keywords: ['跨应用', '工作流', '编排', '协同', 'workflow', 'orchestrate', 'pipeline'] },
  { name: 'cross_app_audit', category: 'read', risk: 'safe', keywords: ['跨应用', '审计', '日志', '数据流', 'audit', 'log', 'trace'] },

  // 办公场景类（V21 新增）
  { name: 'email_compose', category: 'read', risk: 'safe', keywords: ['邮件', '撰写', '写邮件', '草稿', 'email', 'compose', 'mail', 'draft'] },
  { name: 'email_template', category: 'write', risk: 'safe', keywords: ['邮件', '模板', 'template', '保存', '应用', 'email'] },
  { name: 'excel_analyze', category: 'read', risk: 'safe', keywords: ['Excel', '分析', '数据', '统计', 'CSV', 'JSON', 'analyze', 'data', 'statistics'] },
  { name: 'excel_formula', category: 'read', risk: 'safe', keywords: ['Excel', '公式', '函数', 'formula', 'function', '计算'] },
  { name: 'meeting_minutes', category: 'read', risk: 'safe', keywords: ['会议', '纪要', '记录', 'minutes', 'meeting', '总结', '决议', '待办'] },
  { name: 'file_convert', category: 'execute', risk: 'moderate', keywords: ['文件', '转换', '格式', 'convert', 'PDF', 'CSV', 'JSON', '合并'] },
  { name: 'ocr_recognize', category: 'read', risk: 'safe', keywords: ['OCR', '识别', '文字', '图片', '截图', 'recognize', 'extract', 'table', '手写'] },
  { name: 'task_manage', category: 'write', risk: 'safe', keywords: ['任务', '待办', '管理', 'task', 'todo', '优先级', '排序', 'complete'] },
  { name: 'schedule_plan', category: 'read', risk: 'safe', keywords: ['日程', '规划', '安排', '时间', 'schedule', 'plan', 'time', 'blocking', '一周'] },
  { name: 'quick_note', category: 'write', risk: 'safe', keywords: ['笔记', '记录', 'note', '快速', '搜索', '标签', 'tag', 'memo'] },

  // 扩展办公场景类（V21+ 新增）
  { name: 'translate', category: 'read', risk: 'safe', keywords: ['翻译', 'translate', '中英', '英中', '日文', '韩文', '法文', '多语言'] },
  { name: 'qrcode_gen', category: 'execute', risk: 'safe', keywords: ['二维码', '生成', 'QR', 'code', 'qrcode', '扫码'] },
  { name: 'qrcode_scan', category: 'read', risk: 'safe', keywords: ['二维码', '识别', '扫描', 'scan', 'qrcode', '条形码', 'barcode'] },
  { name: 'archive_compress', category: 'execute', risk: 'moderate', keywords: ['压缩', 'zip', '打包', 'archive', 'compress', '归档'] },
  { name: 'archive_extract', category: 'execute', risk: 'moderate', keywords: ['解压', '解压缩', 'unzip', 'extract', 'zip', '解包'] },
  { name: 'watermark_add', category: 'execute', risk: 'moderate', keywords: ['水印', 'watermark', '添加', '标记', '图片保护'] },
  { name: 'pdf_extract_text', category: 'read', risk: 'safe', keywords: ['PDF', '提取', '文字', 'extract', 'text', '解析', '读取'] },
  { name: 'url_to_markdown', category: 'read', risk: 'safe', keywords: ['网页', 'URL', '转', 'Markdown', '提取', '正文', '清洗'] },
  { name: 'snippet_manage', category: 'write', risk: 'safe', keywords: ['代码', '片段', 'snippet', '保存', '复用', '模板', '代码库'] },
  { name: 'password_gen', category: 'read', risk: 'safe', keywords: ['密码', '生成', 'password', '强密码', '随机', 'PIN'] },
  { name: 'currency_convert', category: 'read', risk: 'safe', keywords: ['汇率', '换算', '货币', 'currency', 'USD', 'CNY', 'EUR', '美元', '人民币'] },
  { name: 'unit_convert', category: 'read', risk: 'safe', keywords: ['单位', '换算', 'convert', '长度', '重量', '温度', '面积', '体积', '速度', '数据量'] },

  // P0 工具融合：终端/编辑器面板操作（让 Agent 能操控三端面板）
  { name: 'terminal_operate', category: 'execute', risk: 'moderate', keywords: ['终端', '命令', '执行', 'terminal', 'cmd', 'shell', 'run', '控制台'] },
  { name: 'editor_operate', category: 'write', risk: 'moderate', keywords: ['编辑器', '代码', '打开', '跳转', 'editor', 'code', 'goto', 'open', '文件'] },

  // P0 多 Agent 接通：子 Agent 编排工具元信息（三步注册第 3 步）
  // 缺失时 spawn_agent/wait_agents 在非 mixed 意图下被 L425 过滤，Agent 无法分解任务
  { name: 'spawn_agent', category: 'execute', risk: 'moderate', keywords: ['子agent', '子代理', '创建', 'spawn', 'agent', '分解', '并行', '协作', '委托'] },
  { name: 'wait_agents', category: 'execute', risk: 'safe', keywords: ['等待', 'agent', '结果', 'wait', '汇总', '收齐'] },
  { name: 'list_agents', category: 'read', risk: 'safe', keywords: ['子agent', '列表', '状态', 'list', 'agents', '查看', '运行中'] },

  // V21+ 进阶办公工具（office-tools-pro）三步注册第 3 步
  // 缺失时进阶办公场景在非 mixed/file 意图下被过滤，LLM 看不到这些工具
  { name: 'batch_files', category: 'execute', risk: 'moderate', keywords: ['批量', '文件', '重命名', '替换', 'batch', 'rename', '批量水印', '批量处理'] },
  { name: 'contact_manage', category: 'write', risk: 'moderate', keywords: ['联系人', '客户', 'CRM', '通讯录', 'contact', 'customer', '客户管理', '人脉'] },
  { name: 'resume_generate', category: 'write', risk: 'safe', keywords: ['简历', '生成', '优化', 'resume', 'cv', '求职', '定制简历', '工作经历'] },
  { name: 'contract_analyze', category: 'read', risk: 'safe', keywords: ['合同', '分析', '条款', '风险', 'contract', '审查', '协议', '法律'] },
  { name: 'finance_calc', category: 'read', risk: 'safe', keywords: ['财务', '计算', '贷款', '月供', '复利', '个税', 'ROI', '投资回报', '盈亏平衡', 'finance'] },
  { name: 'pdf_split', category: 'execute', risk: 'moderate', keywords: ['PDF', '拆分', '分割', 'split', '按页', '页面范围'] },
  { name: 'speech_draft', category: 'write', risk: 'safe', keywords: ['演讲', '讲稿', '提词', '发言', 'speech', '致辞', '开场白', '演讲稿'] },
  { name: 'doc_diff', category: 'read', risk: 'safe', keywords: ['文档', '对比', '差异', 'diff', '比较', '版本对比', '修订'] },
  { name: 'data_clean', category: 'execute', risk: 'moderate', keywords: ['数据', '清洗', '去重', '格式化', '缺失值', '异常值', 'clean', 'dedupe', '数据整理'] },
  { name: 'project_track', category: 'plan', risk: 'safe', keywords: ['项目', '跟踪', '里程碑', '进度', 'task', 'milestone', '项目管理', 'progress'] },

  // V22 电脑操作类（office-tools-ultimate A 类）三步注册第 3 步
  // 缺失时系统信息/进程/窗口/剪贴板/启动器/系统设置在非 desktop 意图下被过滤
  { name: 'system_info', category: 'read', risk: 'safe', keywords: ['系统', '信息', 'CPU', '内存', '磁盘', '网络', '电池', 'system', 'info', '硬件', '配置'] },
  { name: 'process_manage', category: 'execute', risk: 'dangerous', keywords: ['进程', '管理', '结束', 'kill', 'process', 'taskkill', '优先级', 'PID', '占用'] },
  { name: 'window_layout', category: 'desktop', risk: 'moderate', keywords: ['窗口', '布局', '分屏', '层叠', '最小化', '虚拟桌面', 'window', 'tile', 'cascade', 'snap', '排列'] },
  { name: 'clipboard_history', category: 'desktop', risk: 'safe', keywords: ['剪贴板', '历史', '记录', 'clipboard', 'history', '复制记录', '监听'] },
  { name: 'quick_launch', category: 'execute', risk: 'moderate', keywords: ['快速', '启动', '别名', '快捷方式', 'launch', 'shortcut', '打开应用', 'launcher'] },
  { name: 'system_settings', category: 'execute', risk: 'moderate', keywords: ['系统', '设置', '壁纸', '电源', '免打扰', '休眠', '屏保', '回收站', '磁盘清理', 'settings', 'wallpaper'] },

  // V22 办公能力类（office-tools-ultimate B 类）三步注册第 3 步
  { name: 'calendar_manage', category: 'plan', risk: 'safe', keywords: ['日历', '日程', '事件', '会议', '提醒', 'calendar', 'schedule', '冲突检测', '约会'] },
  { name: 'email_batch', category: 'write', risk: 'moderate', keywords: ['邮件', '批量', '群发', '草稿', '合并', '分类', 'mail', 'merge', 'batch', '模板'] },
  { name: 'pdf_advanced', category: 'execute', risk: 'moderate', keywords: ['PDF', '合并', '加密', '旋转', '提取', '元信息', 'pdf', 'merge', 'rotate', 'extract'] },
  { name: 'note_manage', category: 'memory', risk: 'moderate', keywords: ['笔记', '知识', '管理', 'Markdown', '标签', '双链', 'note', 'knowledge', 'obsidian', '搜索'] },
  { name: 'kanban_board', category: 'plan', risk: 'safe', keywords: ['看板', 'kanban', '卡片', '列', '泳道', '状态', 'board', 'trello', '拖拽'] },
  { name: 'automation_workflow', category: 'execute', risk: 'moderate', keywords: ['工作流', '自动化', '定时', '触发器', '动作链', 'workflow', 'automation', 'cron', 'schedule', '编排'] },

  // ===== v21.0 §1 Hooks 生命周期工具（三步注册第 3 步）=====
  // 缺失时钩子管理在非 self_modify 意图下被过滤，LLM 看不到 hooks_* 工具
  { name: 'hooks_list', category: 'read', risk: 'safe', keywords: ['钩子', '生命周期', '列表', 'hooks', 'lifecycle', '事件', '已注册'] },
  { name: 'hooks_register', category: 'write', risk: 'moderate', keywords: ['钩子', '注册', '添加', 'hooks', 'register', '订阅', '监听'] },
  { name: 'hooks_unregister', category: 'write', risk: 'moderate', keywords: ['钩子', '取消', '移除', 'hooks', 'unregister', '注销'] },
  { name: 'hooks_config_get', category: 'read', risk: 'safe', keywords: ['钩子', '配置', '查询', 'hooks', 'config', 'settings'] },
  { name: 'hooks_config_set', category: 'write', risk: 'moderate', keywords: ['钩子', '配置', '设置', 'hooks', 'config', 'settings', '更新'] },

  // ===== v21.0 §2 AGENTS.md 三层记忆工具 =====
  // 缺失时 AGENTS.md 加载/初始化在非 file/memory 意图下被过滤
  { name: 'agents_md_load', category: 'read', risk: 'safe', keywords: ['AGENTS', 'md', '加载', '记忆', '规则', '约束', 'agents', 'load', '项目规范'] },
  { name: 'agents_md_init', category: 'write', risk: 'moderate', keywords: ['AGENTS', 'md', '初始化', '生成', '创建', 'agents', 'init', 'starter', '项目规范'] },
  { name: 'agents_md_list', category: 'read', risk: 'safe', keywords: ['AGENTS', 'md', '列表', '层级', 'agents', 'list', '所有层级'] },

  // ===== v21.0 §3 文件即接口上下文工具 =====
  // 缺失时上下文文件化统计/搜索/清理在非 mixed 意图下被过滤
  { name: 'file_context_stats', category: 'read', risk: 'safe', keywords: ['上下文', '文件', '统计', 'file', 'context', 'stats', 'Token', '节省'] },
  { name: 'file_context_search', category: 'search', risk: 'safe', keywords: ['上下文', '文件', '搜索', '历史', 'file', 'context', 'search', 'grep'] },
  { name: 'file_context_history_list', category: 'read', risk: 'safe', keywords: ['上下文', '历史', '列表', 'file', 'context', 'history', '记录'] },
  { name: 'file_context_cleanup', category: 'execute', risk: 'moderate', keywords: ['上下文', '文件', '清理', '释放', 'file', 'context', 'cleanup', 'clear'] },

  // ===== v21.0 §4 异步任务托管工具 =====
  // 缺失时异步任务提交/查询/取消在非 mixed 意图下被过滤，LLM 看不到 async_task_* 工具
  { name: 'async_task_submit', category: 'execute', risk: 'moderate', keywords: ['异步', '任务', '提交', '后台', 'async', 'task', 'submit', '队列', '托管'] },
  { name: 'async_task_status', category: 'read', risk: 'safe', keywords: ['异步', '任务', '状态', '进度', 'async', 'task', 'status', '查询'] },
  { name: 'async_task_list', category: 'read', risk: 'safe', keywords: ['异步', '任务', '列表', 'async', 'task', 'list', '所有任务'] },
  { name: 'async_task_cancel', category: 'execute', risk: 'moderate', keywords: ['异步', '任务', '取消', '终止', 'async', 'task', 'cancel', 'abort'] },
  { name: 'async_task_logs', category: 'read', risk: 'safe', keywords: ['异步', '任务', '日志', 'async', 'task', 'logs', '输出'] },
  { name: 'async_task_templates', category: 'read', risk: 'safe', keywords: ['异步', '任务', '模板', 'async', 'task', 'templates', '预定义'] },
  { name: 'async_task_stats', category: 'read', risk: 'safe', keywords: ['异步', '任务', '统计', 'async', 'task', 'stats', '汇总'] },

  // ===== v21.1 P0-A: 打通已有能力最后一公里 — 补全 4 个模块的工具元信息 =====
  // 缺失时这些工具在非 mixed 意图下被过滤，LLM 看不到 ast_*/checkpoint_*/code_graph_*/worktree_*

  // shadow-git.ts — Checkpoint 快照回滚（对标 Gemini CLI /restore）
  { name: 'checkpoint_create', category: 'write', risk: 'moderate', keywords: ['检查点', '快照', '创建', 'checkpoint', 'snapshot', 'create', '保存当前状态'] },
  { name: 'checkpoint_restore', category: 'write', risk: 'dangerous', keywords: ['检查点', '恢复', '回滚', '还原', 'checkpoint', 'restore', 'rewind', 'rollback', 'revert'] },
  { name: 'checkpoint_list', category: 'read', risk: 'safe', keywords: ['检查点', '列表', '历史', 'checkpoint', 'list', 'history', '快照列表'] },
  { name: 'checkpoint_diff', category: 'read', risk: 'safe', keywords: ['检查点', '差异', '对比', 'checkpoint', 'diff', 'compare', '变更'] },

  // tree-sitter-ast.ts — AST 代码分析（对标 Aider Repo Map 解析基础）
  { name: 'ast_parse', category: 'read', risk: 'safe', keywords: ['AST', '解析', '语法树', 'parse', 'abstract syntax tree', '代码分析', '语法分析'] },
  { name: 'ast_project', category: 'read', risk: 'safe', keywords: ['AST', '项目', '全局', 'ast', 'project', '项目结构', '符号总览'] },
  { name: 'ast_usages', category: 'read', risk: 'safe', keywords: ['AST', '引用', '使用', 'usages', 'references', '谁调用了', '符号引用'] },
  { name: 'ast_smells', category: 'read', risk: 'safe', keywords: ['AST', '代码异味', '坏味道', 'smells', 'code smell', '长函数', '深嵌套', '上帝类'] },
  { name: 'ast_structure', category: 'read', risk: 'safe', keywords: ['AST', '结构', 'structure', '类层次', '继承', '代码结构'] },
  { name: 'ast_dependencies', category: 'read', risk: 'safe', keywords: ['AST', '依赖', 'dependencies', '依赖图', '循环依赖', 'import 关系'] },

  // code-knowledge-graph.ts — 代码知识图谱（对标 Cursor 代码索引）
  { name: 'code_graph_query', category: 'read', risk: 'safe', keywords: ['代码图谱', '知识图谱', '查询', 'code graph', 'query', '调用关系', '函数关系'] },
  { name: 'code_graph_stats', category: 'read', risk: 'safe', keywords: ['代码图谱', '统计', 'stats', '节点数', '边数', '图谱规模'] },
  { name: 'code_graph_analyze', category: 'read', risk: 'safe', keywords: ['代码图谱', '分析', 'analyze', '解析项目', '构建图谱', '代码索引'] },

  // git-worktree.ts — Git Worktree 多分支并行（对标 Cursor 2.0 多 Agent 并行）
  { name: 'worktree_create', category: 'execute', risk: 'moderate', keywords: ['worktree', '工作树', '创建分支', '并行开发', 'git worktree', 'create', '隔离开发'] },
  { name: 'worktree_remove', category: 'execute', risk: 'dangerous', keywords: ['worktree', '删除', '清理', 'remove', 'cleanup', '移除工作树'] },
  { name: 'worktree_list', category: 'read', risk: 'safe', keywords: ['worktree', '列表', '所有工作树', 'list', 'worktrees', '工作树列表'] },
  { name: 'worktree_exec', category: 'execute', risk: 'moderate', keywords: ['worktree', '执行', '命令', 'exec', 'run in worktree', '工作树内执行'] },
  { name: 'worktree_merge', category: 'execute', risk: 'dangerous', keywords: ['worktree', '合并', 'merge', 'squash', 'rebase', '合并工作树'] },
  { name: 'worktree_diff', category: 'read', risk: 'safe', keywords: ['worktree', '差异', 'diff', '工作树差异', '变更对比'] },
  { name: 'worktree_sync', category: 'execute', risk: 'moderate', keywords: ['worktree', '同步', 'sync', 'rebase', 'stash', '工作树同步'] },

  // ===== v21.1 P0-B: Spec-Driven Development 工件流程（对标 GitHub Spec Kit）=====
  { name: 'spec_create', category: 'plan', risk: 'moderate', keywords: ['spec', '规范', '需求', '创建规范', 'specify', '需求文档', '功能规范'] },
  { name: 'spec_plan', category: 'plan', risk: 'moderate', keywords: ['spec', '技术方案', 'plan', '架构方案', '实现方案', '技术规划'] },
  { name: 'spec_tasks', category: 'plan', risk: 'moderate', keywords: ['spec', '任务拆解', 'tasks', '任务清单', '任务列表', '可执行步骤'] },
  { name: 'spec_implement', category: 'execute', risk: 'moderate', keywords: ['spec', '实现', '执行任务', 'implement', '按任务执行', '开发实现'] },
  { name: 'spec_check', category: 'read', risk: 'safe', keywords: ['spec', '自查', '验证', 'check', '合规', '验收', 'checklist'] },
  { name: 'spec_list', category: 'read', risk: 'safe', keywords: ['spec', '列表', '所有规范', 'list specs', '规范列表'] },
  { name: 'spec_get', category: 'read', risk: 'safe', keywords: ['spec', '详情', '获取', 'get spec', '规范详情', '规范内容'] },

  // ===== v21.1 P0-C: Repo Map 重要性排序（对标 Aider RepoMap）=====
  { name: 'repo_map_generate', category: 'read', risk: 'safe', keywords: ['repo map', '代码地图', '仓库地图', '项目地图', 'generate', '代码结构', '符号地图'] },
  { name: 'repo_map_query', category: 'read', risk: 'safe', keywords: ['repo map', '查询符号', '重要性', 'query', 'symbol rank', '符号查询'] },
  { name: 'repo_map_symbols', category: 'read', risk: 'safe', keywords: ['repo map', '重要符号', 'top symbols', '关键符号', '核心 API', '符号列表'] },

  // ===== v21.1 P0-D: Plan Mode 可编辑计划（对标 Cursor Plan Mode）=====
  { name: 'plan_create', category: 'plan', risk: 'safe', keywords: ['计划', '创建计划', '方案', 'plan', 'create plan', '规划', '制定计划'] },
  { name: 'plan_update', category: 'plan', risk: 'moderate', keywords: ['计划', '更新', '修改计划', '调整', 'plan', 'update', 'modify', '调整计划'] },
  { name: 'plan_confirm', category: 'plan', risk: 'moderate', keywords: ['计划', '确认', '批准', '开始执行', 'plan', 'confirm', 'approve', 'start'] },
  { name: 'plan_cancel', category: 'plan', risk: 'moderate', keywords: ['计划', '取消', '放弃', 'plan', 'cancel', 'abort', '取消计划'] },
  { name: 'plan_list', category: 'read', risk: 'safe', keywords: ['计划', '列表', '所有计划', 'plan', 'list', '计划列表', '历史计划'] },

  // ===== v21.1 P5: Agent 团队编排工具（对标 OpenHands Planner-Executor）=====
  { name: 'team_run_template', category: 'execute', risk: 'moderate', keywords: ['团队', 'team', '模板', 'run template', '启动团队', '代码开发团队', '研究团队', 'bug修复团队'] },
  { name: 'team_list_templates', category: 'read', risk: 'safe', keywords: ['团队', 'team', '模板列表', 'list templates', '可用团队', 'team templates'] },
  { name: 'team_get_template_info', category: 'read', risk: 'safe', keywords: ['团队', 'team', '模板详情', 'template info', '模板信息'] },
  { name: 'team_get_executions', category: 'read', risk: 'safe', keywords: ['团队', 'team', '执行历史', 'executions', '执行记录', '团队执行'] },
  { name: 'team_get_execution', category: 'read', risk: 'safe', keywords: ['团队', 'team', '执行详情', 'execution', '获取执行', '执行结果'] },
  { name: 'team_get_board', category: 'read', risk: 'safe', keywords: ['团队', 'team', '上下文板', 'board', 'shared context', '共享板', '消息板'] },
  { name: 'team_clear_board', category: 'write', risk: 'moderate', keywords: ['团队', 'team', '清空板', 'clear board', '清除消息', '重置上下文板'] },

  // ===== v21.1 P6: SubAgent 编排 + 后台模式（对标 Claude Code run_in_background）=====
  { name: 'subagent_dispatch', category: 'execute', risk: 'moderate', keywords: ['子代理', 'subagent', 'dispatch', '派生', '专家代理', 'spawn agent', '同步派生'] },
  { name: 'subagent_dispatch_background', category: 'execute', risk: 'moderate', keywords: ['子代理', 'subagent', 'background', '后台', 'run_in_background', '后台派生', '异步派生', '后台任务'] },
  { name: 'subagent_get_result', category: 'read', risk: 'safe', keywords: ['子代理', 'subagent', 'result', '结果', '获取结果', '后台结果', '轮询结果'] },
  { name: 'subagent_wait_for', category: 'read', risk: 'safe', keywords: ['子代理', 'subagent', 'wait', '等待', '等待完成', '阻塞等待', 'wait for'] },
  { name: 'subagent_list_background', category: 'read', risk: 'safe', keywords: ['子代理', 'subagent', 'list background', '后台任务列表', '后台列表', 'running tasks'] },
  { name: 'subagent_cancel', category: 'write', risk: 'moderate', keywords: ['子代理', 'subagent', 'cancel', '取消', '取消任务', '终止后台'] },
  { name: 'subagent_list_agents', category: 'read', risk: 'safe', keywords: ['子代理', 'subagent', 'list agents', '已注册代理', '可用代理', 'agent list'] },
  { name: 'subagent_status', category: 'read', risk: 'safe', keywords: ['子代理', 'subagent', 'status', '状态', '状态报告', '运行状态'] },
];

// ============ 意图→工具类别映射 ============

/** 每种意图对应的工具类别白名单及优先级排序 */
const INTENT_CATEGORY_MAP: Record<TaskIntent, { categories: ToolCategory[]; priority: ToolCategory[] }> = {
  code: {
    categories: ['read', 'write', 'execute', 'browse', 'desktop', 'plan'],
    priority: ['execute', 'write', 'read', 'browse', 'desktop', 'plan'],
  },
  browse: {
    categories: ['browse', 'desktop', 'read', 'search'],
    priority: ['browse', 'desktop', 'read', 'search'],
  },
  desktop: {
    categories: ['desktop', 'browse', 'execute'],
    priority: ['desktop', 'browse', 'execute'],
  },
  search: {
    categories: ['search', 'read', 'browse'],
    priority: ['search', 'read', 'browse'],
  },
  file: {
    categories: ['read', 'write', 'execute'],
    priority: ['read', 'write', 'execute'],
  },
  chat: {
    categories: ['browse', 'desktop', 'search', 'read', 'execute', 'plan', 'meta'],
    priority: ['browse', 'desktop', 'search', 'read', 'execute', 'plan', 'meta'],
  },
  self_modify: {
    categories: ['self', 'read', 'write', 'execute'],
    priority: ['self', 'read', 'write', 'execute'],
  },
  mixed: {
    categories: ['read', 'write', 'execute', 'browse', 'desktop', 'search', 'memory', 'self', 'plan', 'meta'],
    priority: ['browse', 'desktop', 'read', 'search', 'execute', 'plan', 'memory', 'meta', 'write', 'self'],
  },
};

// ============ 意图推断关键词映射 ============

/** 每种意图的触发关键词及权重 */
const INTENT_KEYWORDS: Record<TaskIntent, { keywords: string[]; weight: number }> = {
  code: {
    keywords: ['代码', '编程', '开发', '函数', '变量', '类', '方法', '调试', '编译', '运行', '执行',
      'code', 'program', 'develop', 'function', 'variable', 'class', 'method', 'debug', 'compile',
      'bug', 'fix', 'implement', 'refactor', '测试', 'test', '实现', '修改代码',
      // 修复: 移除过于宽泛的 '写' —— 它会匹配"写简历"/"写邮件"/"写文章"等非 code 场景
      // 改用更精确的 '写代码'，避免抢走 chat/file/desktop 意图
      '写代码', '编写代码'],
    weight: 1.0,
  },
  browse: {
    keywords: ['浏览', '网页', '网站', '打开', '访问', 'URL', '链接', '浏览器',
      'browse', 'website', 'url', 'link', 'browser', 'navigate', '网页操作', '抓取', 'fetch',
      // V21+: 网页转 Markdown 属于 browse 意图
      '网页转', 'markdown', '正文提取'],
    weight: 1.0,
  },
  desktop: {
    keywords: ['桌面', '应用', '截图', '点击', '输入', '键盘', '鼠标', '屏幕', 'PS', 'Photoshop',
      'desktop', 'app', 'screenshot', 'click', 'type', 'keyboard', 'mouse', 'screen',
      '修图', '操作软件', '自动化操作', '视觉', 'visual', '滚动', '翻页', '窗口', '剪贴板',
      '复制粘贴', '最小化', '最大化', 'scroll', 'window', 'clipboard', '拖拽',
      // P0 修复: 社交通讯应用必须判定为 desktop 意图，否则"打开微信"会被 browse 的"打开"关键词抢走 → 误开浏览器
      '微信', 'wechat', '朋友圈', '发朋友圈', '发消息', '发送消息', '钉钉', 'dingtalk',
      '飞书', 'feishu', 'lark', 'QQ', 'telegram', '社交', 'sns', '群消息', '私聊',
      '发邮件', '邮件', 'email', 'mail', 'outlook', 'foxmail',
      // V22: 电脑操作类关键词——系统信息/进程/窗口布局/系统设置属 desktop 意图
      '系统信息', 'CPU', '内存', '磁盘', '电池', '进程', 'taskkill', '结束进程', '优先级',
      '分屏', '层叠', '虚拟桌面', '壁纸', '电源模式', '休眠', '屏保', '磁盘清理',
      '剪贴板历史', '快速启动', '别名', '快捷方式',
      // 修复: 系统设置同义词缺口——免打扰/通知/夜间模式 原先缺失导致"开启免打扰"被误判为 mixed
      '免打扰', '专注助手', '通知模式', '夜间模式', '深色模式', '勿扰模式',
      // 修复: 语音类同义词缺口——录音/语音输入 原先仅在 voice_* 工具元信息里，intent 层不识别
      '语音', '录音', '朗读', '说话', 'TTS', 'STT', '语音输入', '语音转文字',
      // 修复: 截图同义词——"截屏"与"截图"是常见交替用词
      '截屏'],
    weight: 1.2,
  },
  search: {
    keywords: ['搜索', '查找', '查询', '检索', 'google', 'bing', '百度',
      'search', 'find', 'query', 'lookup', '网上搜', '搜一下', '找一下',
      // v20.0 §5.4 技能市场关键词
      '技能市场', 'skill market', '找技能', '技能商店', '热门技能', '推荐技能',
      // v20.0 §5.2 离线协调器关键词
      '离线', 'offline', '断网', '无网络', '网络探测', '网络状态', '本地模型', 'ollama', 'llama.cpp', '离线知识', '离线模式',
      // v20.0 §5.4 学习进度可视化关键词
      '进度', '学习曲线', '雷达图', '技能树', '趋势分析', 'progress', 'radar', 'skill tree',
      // v20.0 §3.5 模型微调关键词
      '微调', 'fine-tune', 'finetune', '训练模型', 'LoRA', 'QLoRA', '训练数据', '训练任务', 'ollama train', 'llama.cpp', '微调模型',
      // v20.0 §5.3 协作关键词
      '协作', '团队', '共享会话', '任务派发', '团队知识库', 'collab', 'team', 'collaboration', '多人协作', '实时协作'],
    weight: 1.0,
  },
  file: {
    keywords: ['文件', '目录', '读取', '写入', '保存', '创建文件', '编辑文件', '查看文件',
      'file', 'directory', 'read', 'write', 'save', 'create', 'edit', 'folder', '路径',
      // V21: 办公场景关键词——会议纪要/任务待办/笔记/日程/OCR 等更贴近 file 意图
      '会议纪要', '纪要', 'minutes', '待办', '任务', 'todo', 'task', '笔记', 'note', 'memo',
      '日程', 'schedule', 'OCR', '识别', '文件转换', 'convert', 'csv', 'json', 'pdf',
      'excel', '公式', 'formula', '数据分析',
      // V21+: 扩展办公场景
      '压缩', '解压', 'zip', '水印', 'watermark', '代码片段', 'snippet', '密码', '生成',
      'PDF提取', '单位换算', '温度换算', '汇率', '换算',
      // V21+ pro: 进阶办公场景关键词
      '批量文件', '批量重命名', 'CRM', '客户管理', '联系人', '财务计算', '贷款月供',
      '个税', 'ROI', 'PDF拆分', '数据清洗', '去重', '项目跟踪', '里程碑', '进度跟踪',
      // V22 ultimate: 办公能力类关键词——日历/邮件/PDF高级/笔记/看板/工作流
      '日历', 'calendar', '日程事件', '会议邀请', '邮件批处理', '群发单显', '邮件合并',
      'PDF合并', 'PDF加密', 'PDF旋转', '笔记', '知识管理', '双链', '看板', 'kanban',
      '工作流', '自动化', '定时任务', '触发器', '动作链',
      // v20.0 §5.1: 多模态文档解析关键词——PDF/Word/Excel/PPT 解析属 file 意图
      '解析文档', '文档内容', '读取文档', '文档提取', '提取文本', '解析表格',
      'Word', 'word', 'docx', 'PPT', 'ppt', 'pptx', 'docx', 'xlsx',
      '批量解析', '目录文档', '批量文档', '文档类型', '支持的格式',
      // v21.0 §2: AGENTS.md 三层记忆体系属 file 意图（项目规范加载/初始化）
      'AGENTS.md', 'AGENTS', '项目规范', '项目规则', '项目约束', 'agents md'],
    weight: 1.0,
  },
  chat: {
    keywords: ['聊天', '对话', '闲聊', '你好', '谢谢', '再见', '怎么样',
      'chat', 'talk', 'hello', 'hi', 'thanks', 'bye', '问候', '打招呼',
      // V21+: 翻译属文本处理，更贴近 chat 意图
      '翻译', 'translate', '中英互译',
      // V21+ pro: 内容生成类（简历/合同/演讲稿/文档对比）更贴近 chat 意图
      '简历', 'resume', 'cv', '合同分析', '条款审查', '演讲稿', '提词', '讲稿',
      '文档对比', 'doc diff', '版本对比'],
    weight: 0.5,
  },
  self_modify: {
    keywords: ['自我进化', '自我修改', '自我修复', '自愈', '升级自己', '改进自己', '进化',
      'self-evolve', 'self-modify', 'self-heal', 'self-improve', '自身能力', '技能学习',
      // v21.0 §1: Hooks 生命周期管理属自我修改范畴
      '钩子', 'hooks', 'lifecycle', '生命周期', '钩子管理', '钩子配置'],
    weight: 1.2,
  },
  mixed: {
    keywords: ['同时', '并且', '以及', '还有', '另外', '然后', '接着',
      'and', 'also', 'plus', 'then', 'next', '组合', '多个',
      // v21.0 §3: 文件即接口上下文管理属 mixed 意图（统计/搜索/清理跨多类）
      '上下文文件', '上下文统计', '上下文搜索', '上下文清理', 'file context',
      // v21.0 §4: 异步任务托管属 mixed 意图（后台任务跨多类）
      '异步任务', '后台任务', 'async task', '任务队列', '任务托管', '任务进度',
      '任务取消', '任务日志', '任务模板', '任务统计',
      // v21.1 P0-A: 代码分析/检查点/worktree 属 mixed（跨 read/write/execute 多类）
      'AST', '语法树', '代码图谱', '检查点', '快照', '回滚', 'worktree', '工作树',
      // v21.1 P0-B: Spec-Driven 工件流程属 mixed（plan + execute 跨类）
      'spec', '规范', '需求文档', '技术方案', '任务拆解', 'checklist', '验收',
      // v21.1 P0-C: Repo Map 属 mixed（read + search 跨类）
      'repo map', '代码地图', '仓库地图', '符号地图', '代码结构',
      // v21.1 P0-D: Plan Mode 属 mixed（plan + execute 跨类）
      '创建计划', '确认计划', '取消计划', '计划列表', '可编辑计划',
      // v21.1 P5: Agent 团队编排属 mixed（read + execute 跨类）
      '团队', 'team', '启动团队', '团队模板', '团队执行', '共享板',
      // v21.1 P6: SubAgent + 后台模式属 mixed（read + execute 跨类）
      '子代理', 'subagent', '后台派生', 'run_in_background', '后台任务', '专家代理'],
    weight: 0.3,
  },
};

// ============ 替代工具映射 ============

/** 工具失败后的替代建议 */
const ALTERNATIVE_MAP: Record<string, string[]> = {
  browser_operate: ['desktop_open', 'web_search', 'web_fetch'],
  web_search: ['browser_operate', 'web_fetch'],
  shell_execute: ['code_execute'],
  file_read: ['search_files', 'shell_execute'],
  desktop_open: ['browser_operate'],
  code_execute: ['shell_execute'],
  web_fetch: ['browser_operate', 'web_search'],
  screen_click: ['visual_find_click'],
  visual_find_click: ['screen_click'],
};

// ============ 风险等级排序权重 ============

const RISK_ORDER: Record<ToolRisk, number> = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
};

// ============ 主类 ============

export class SmartToolSelector {
  private toolMetaMap: Map<string, ToolMeta> = new Map();
  private failedTools: Map<string, number> = new Map();  // 工具名 → 连续失败次数
  private recentTools: string[] = [];                     // 最近使用的工具
  /** 强化学习权重 — 从ToolLearningSystem注入 */
  private toolWeights: Map<string, number> = new Map();
  /** 用户画像 — 影响工具选择策略 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private userProfile: any = null;
  /** P1-3: 语义匹配 — 使用注意力机制计算任务-工具对齐度 */
  private crossAttention: CrossAttention;
  private embedder: SimpleEmbedder;
  /** 工具描述向量缓存 — 避免重复嵌入 */
  private toolVectorCache: Map<string, number[]> = new Map();

  /** 连续失败阈值：超过此值自动排除该工具 */
  private static readonly FAIL_THRESHOLD = 3;
  /** 最近工具记录上限 */
  private static readonly RECENT_TOOLS_LIMIT = 20;
  /** Phase D2: LLM 工具选择结果缓存 TTL（5 分钟，避免相同查询重复调用 LLM） */
  private static readonly LLM_CACHE_TTL_MS = 5 * 60 * 1000;
  /** Phase D2: LLM 工具选择缓存 — key=query+tools签名 hash, value={toolNames, timestamp} */
  private _llmSelectionCache: Map<string, { toolNames: string[]; timestamp: number }> = new Map();

  constructor() {
    // P1-3: 初始化语义匹配引擎
    this.crossAttention = new CrossAttention({ dModel: 256, heads: 8 });
    this.embedder = new SimpleEmbedder(256);
    // 注册内置工具元信息
    this.registerTools(BUILTIN_TOOL_METAS);
  }

  /**
   * 注入强化学习权重（从ToolLearningSystem获取）
   */
  injectToolWeights(weights: Map<string, number>): void {
    this.toolWeights = weights;
  }

  /**
   * P1-3: 注入真实语义嵌入提供者
   *
   * 注入后：
   * 1. embedder 切换到 provider.dimension 维度
   * 2. 重建 CrossAttention 用新维度（避免维度不匹配）
   * 3. 清空 toolVectorCache（旧向量维度已不兼容）
   * 4. 后续 selectTool() 的语义匹配路径使用真实语义嵌入
   *
   * 注意：selectTool() 当前使用同步 embed()，注入 provider 后同步路径仍用哈希嵌入。
   * 要获取真实语义匹配，需调用 selectToolAsync()（若已实现）或后续扩展。
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    if (provider) {
      // 清空工具向量缓存（旧向量维度已不兼容新 provider）
      if (this.toolVectorCache.size > 0) {
        this.toolVectorCache.clear();
      }
      // 注入 provider 并采用其维度
      this.embedder.setEmbeddingProvider(provider, true);
      // 重建 CrossAttention 用新维度
      this.crossAttention = new CrossAttention({ dModel: provider.dimension, heads: 8 });
    } else {
      this.embedder.setEmbeddingProvider(null, false);
    }
  }

  /** P1-3: 查询是否已注入真实语义嵌入提供者 */
  hasSemanticProvider(): boolean {
    return this.embedder.hasSemanticProvider();
  }

  /** P1-3: 查询当前嵌入源信息 */
  getEmbeddingInfo() {
    return this.embedder.getEmbeddingInfo();
  }

  /**
   * 注入用户画像 — 影响工具选择策略
   * 初学者 → 优先GUI/桌面工具
   * 专家 → 优先CLI/代码工具
   */
  injectUserProfile(profile: unknown): void {
    this.userProfile = profile;
  }

  // ========== 注册 ==========

  /** 注册工具元信息 */
  registerTool(meta: ToolMeta): void {
    this.toolMetaMap.set(meta.name, meta);
  }

  /** 批量注册工具元信息 */
  registerTools(metas: ToolMeta[]): void {
    for (const meta of metas) {
      this.registerTool(meta);
    }
  }

  // ========== 核心选择逻辑 ==========

  /**
   * 根据任务意图选择工具子集
   *
   * 流程：
   * a. 根据 intent 确定工具类别白名单
   * b. 从 allTools 中过滤出白名单类别的工具
   * c. 排除已失败的工具（除非 includeFailed=true）
   * d. 添加"必备工具"（complete 始终包含）
   * e. 如果有 planHints，将计划建议的工具提升到前面
   * f. 按风险等级排序：safe > moderate > dangerous
   * g. 截断到 maxTools
   */
  selectTools(
    intent: TaskIntent,
    allTools: ToolDefinition[],
    options?: SelectToolsOptions,
  ): ToolDefinition[] {
    const maxTools = options?.maxTools ?? 15;
    const includeFailed = options?.includeFailed ?? false;
    const planHints = options?.planHints ?? [];
    const recentContext = options?.recentContext ?? '';

    // a. 获取意图对应的类别白名单
    const intentConfig = INTENT_CATEGORY_MAP[intent];
    const categorySet = new Set(intentConfig.categories);
    const priorityOrder = intentConfig.priority;

    // b. 按类别过滤
    let filtered = allTools.filter(tool => {
      const meta = this.toolMetaMap.get(tool.name);
      if (!meta) {
        // 未注册元信息的工具，在 mixed 意图下保留，其他意图下排除
        return intent === 'mixed';
      }
      return categorySet.has(meta.category);
    });

    // c. 排除已失败的工具
    if (!includeFailed) {
      filtered = filtered.filter(tool => {
        const failCount = this.failedTools.get(tool.name) ?? 0;
        return failCount < SmartToolSelector.FAIL_THRESHOLD;
      });
    }

    // d. 确保必备工具始终包含（按意图动态选择，避免 desktop 意图硬塞 browser_operate 导致误开浏览器）
    // P0 修复: 原 safeEssentials 硬塞 browser_operate 到首位，导致"打开微信"被误判为 browse 后强制开浏览器
    const essentialsByIntent: Record<TaskIntent, string[]> = {
      browse: ['complete', 'browser_operate', 'web_search'],
      // desktop 意图必须包含屏幕截图/分析/点击/输入/按键工具，否则 agent 会用 browser_operate 截图（实测 bug）
      // screen_capture 截图、screen_analyze 视觉分析、screen_click/type/key 直接操作屏幕
      // 修复: 移除死引用 'app_operate'（不在 BUILTIN_TOOL_METAS），改用真实工具 'app_smart'
      //   原代码即使 allTools 不含 app_operate 也会浪费一次 find() 查找；若 allTools 含 app_operate
      //   则会被塞回结果但无元信息，绕过 category/risk 过滤
      desktop: ['complete', 'desktop_open', 'app_smart', 'app_launch', 'screen_capture', 'screen_analyze', 'screen_click', 'screen_type', 'screen_key'],
      code: ['complete', 'file_read', 'file_write'],
      search: ['complete', 'web_search'],
      file: ['complete', 'file_read', 'file_write'],
      chat: ['complete'],
      self_modify: ['complete', 'file_read'],
      mixed: ['complete', 'browser_operate', 'desktop_open', 'screen_capture', 'web_search', 'file_read'],
    };
    const safeEssentials = essentialsByIntent[intent] ?? ['complete', 'file_read'];
    // 仅在需要执行操作的意图中暴露 shell_execute / file_write，防止提示注入滥用
    const passiveIntents: TaskIntent[] = ['chat', 'browse', 'search'];
    const dangerousEssentials = passiveIntents.includes(intent) ? [] : ['shell_execute', 'file_write'];
    const essentialTools = [...safeEssentials, ...dangerousEssentials];
    for (const essentialName of essentialTools) {
      if (!filtered.some(t => t.name === essentialName)) {
        // 修复: essentials 循环必须尊重 failedTools，否则 includeFailed=false 契约被破坏
        // 原代码：连续失败 3 次的必备工具仍被强制塞回结果（markFailed 失效）
        // 修复后：includeFailed=false 时跳过已失败工具，仅 includeFailed=true 时才塞回
        if (!includeFailed) {
          const failCount = this.failedTools.get(essentialName) ?? 0;
          if (failCount >= SmartToolSelector.FAIL_THRESHOLD) {
            continue; // 已失败超阈值，不强制塞回
          }
        }
        const tool = allTools.find(t => t.name === essentialName);
        if (tool) {
          filtered.push(tool);
        }
      }
    }

    // e. 排序：综合优先级 + 风险等级 + 计划提示 + 上下文相关性 + 强化学习权重 + 用户画像
    // 获取用户专业水平（影响工具类型偏好）
    const userLevel = this.userProfile?.cognitive?.expertiseLevel || 'intermediate';
    const isBeginner = userLevel === 'beginner';
    const isExpert = userLevel === 'advanced' || userLevel === 'expert';

    filtered.sort((a, b) => {
      // 计划提示的工具优先
      const aInPlan = planHints.includes(a.name) ? 0 : 1;
      const bInPlan = planHints.includes(b.name) ? 0 : 1;
      if (aInPlan !== bInPlan) return aInPlan - bInPlan;

      // 强化学习权重：成功率高的工具优先
      const aWeight = this.toolWeights.get(a.name) ?? 0.5;
      const bWeight = this.toolWeights.get(b.name) ?? 0.5;
      if (Math.abs(aWeight - bWeight) > 0.15) return bWeight - aWeight; // 权重差>15%才影响排序

      // 用户画像：初学者优先GUI工具，专家优先CLI工具
      const aMeta = this.toolMetaMap.get(a.name);
      const bMeta = this.toolMetaMap.get(b.name);
      if (isBeginner) {
        // 初学者：desktop类工具优先
        const aDesktop = aMeta?.category === 'desktop' ? 0 : 1;
        const bDesktop = bMeta?.category === 'desktop' ? 0 : 1;
        if (aDesktop !== bDesktop) return aDesktop - bDesktop;
      } else if (isExpert) {
        // 专家：execute/code类工具优先
        const aCode = aMeta?.category === 'execute' ? 0 : 1;
        const bCode = bMeta?.category === 'execute' ? 0 : 1;
        if (aCode !== bCode) return aCode - bCode;
      }

      // 按意图优先级排序
      const aCatIdx = aMeta ? priorityOrder.indexOf(aMeta.category) : 99;
      const bCatIdx = bMeta ? priorityOrder.indexOf(bMeta.category) : 99;
      if (aCatIdx !== bCatIdx) return aCatIdx - bCatIdx;

      // 按风险等级排序
      const aRisk = aMeta?.risk ?? 'moderate';
      const bRisk = bMeta?.risk ?? 'moderate';
      if (aRisk !== bRisk) return RISK_ORDER[aRisk] - RISK_ORDER[bRisk];

      // 上下文相关性排序（如果有最近上下文）
      if (recentContext) {
        const aScore = this.computeRelevanceScore(a, recentContext);
        const bScore = this.computeRelevanceScore(b, recentContext);
        if (aScore !== bScore) return bScore - aScore;  // 降序，高分在前
      }

      // 最近使用过的工具略优先
      const aRecent = this.recentTools.includes(a.name) ? 0 : 1;
      const bRecent = this.recentTools.includes(b.name) ? 0 : 1;
      return aRecent - bRecent;
    });

    // f. 处理冲突工具：如果高优先级的工具已入选，移除与其冲突的低优先级工具
    const selected = this.removeConflicts(filtered);

    // g. 截断到 maxTools
    return selected.slice(0, maxTools);
  }

  // ========== 失败追踪 ==========

  /** 标记工具失败 */
  markFailed(toolName: string): void {
    const count = this.failedTools.get(toolName) ?? 0;
    this.failedTools.set(toolName, count + 1);
    // 自动衰减：如果失败次数超过阈值2倍，逐步衰减（给工具恢复机会）
    // 避免因暂时性故障永久排除关键工具
    if (count + 1 > SmartToolSelector.FAIL_THRESHOLD * 2) {
      this.failedTools.set(toolName, SmartToolSelector.FAIL_THRESHOLD - 1);
    }
  }

  /** 标记工具成功 */
  markSuccess(toolName: string): void {
    // 成功后清除失败计数
    this.failedTools.delete(toolName);
    // 记录到最近使用
    this.recentTools = this.recentTools.filter(n => n !== toolName);
    this.recentTools.unshift(toolName);
    if (this.recentTools.length > SmartToolSelector.RECENT_TOOLS_LIMIT) {
      this.recentTools.pop();
    }
  }

  // ========== 替代建议 ==========

  /**
   * 获取替代工具建议
   *
   * 逻辑：
   * 1. 先查专用替代映射
   * 2. 再查同 category 的其他工具
   * 3. 过滤掉已失败和冲突的工具
   */
  suggestAlternatives(failedToolName: string): string[] {
    const alternatives: string[] = [];

    // 1. 专用替代映射
    const specific = ALTERNATIVE_MAP[failedToolName] ?? [];
    alternatives.push(...specific);

    // 2. 同 category 的其他工具
    const failedMeta = this.toolMetaMap.get(failedToolName);
    if (failedMeta) {
      const entries = Array.from(this.toolMetaMap.entries());
      for (const [name, meta] of entries) {
        if (name !== failedToolName && meta.category === failedMeta.category) {
          if (!alternatives.includes(name)) {
            alternatives.push(name);
          }
        }
      }
    }

    // 3. 过滤掉已失败的工具
    return alternatives.filter(name => {
      const failCount = this.failedTools.get(name) ?? 0;
      return failCount < SmartToolSelector.FAIL_THRESHOLD;
    });
  }

  // ========== 意图推断 ==========

  /**
   * 推断任务意图
   *
   * 使用 chinese-nlp 的 tokenize 分词后匹配关键词，
   * 多关键词加权评分，支持组合意图。
   */
  inferIntent(userInput: string): TaskIntent {
    if (!userInput || userInput.trim().length === 0) {
      return 'mixed';
    }

    // 分词
    const tokens = tokenize(userInput);
    const inputLower = userInput.toLowerCase();

    // 对每种意图计算得分
    const scores: Record<TaskIntent, number> = {
      code: 0,
      browse: 0,
      desktop: 0,
      search: 0,
      file: 0,
      chat: 0,
      self_modify: 0,
      mixed: 0,
    };

    for (const [intent, config] of Object.entries(INTENT_KEYWORDS)) {
      let score = 0;

      // 关键词匹配
      for (const keyword of config.keywords) {
        // 精确匹配分词结果
        if (tokens.includes(keyword)) {
          score += 2.0 * config.weight;
        }
        // 子串匹配（对英文关键词更宽松）
        if (inputLower.includes(keyword.toLowerCase())) {
          score += 1.0 * config.weight;
        }
      }

      scores[intent as TaskIntent] = score;
    }

    // 找到最高分的意图
    let bestIntent: TaskIntent = 'chat';
    let bestScore = 0;

    for (const [intent, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent as TaskIntent;
      }
    }

    // 如果有多个意图得分接近（差距 < 15%），判定为 mixed
    const secondBest = Object.values(scores)
      .filter(s => s !== bestScore)
      .sort((a, b) => b - a)[0] ?? 0;

    if (bestScore > 0 && secondBest > 0 && secondBest / bestScore > 0.85) {
      return 'mixed';
    }

    // 如果没有明确匹配，默认 mixed（确保所有工具类别可用）
    if (bestScore === 0) {
      return 'mixed';
    }

    return bestIntent;
  }

  /**
   * Phase D2: 带置信度的意图推断
   *
   * 置信度口径：
   * - bestScore 归一化到 [0,1]，阈值 3.0（约 1 个关键词 token+substring 命中：2*1+1*1=3）
   * - 当 secondBest/bestScore > 0.85 强制 mixed 时，置信度按 secondBest/bestScore 反比衰减
   * - bestScore=0（无任何匹配）→ confidence=0，intent='mixed'
   *
   * 用于触发 LLM fallback：confidence < 0.5 OR intent='mixed' 时改走 selectToolsWithLLMFallback
   */
  inferIntentWithConfidence(userInput: string): { intent: TaskIntent; confidence: number } {
    if (!userInput || userInput.trim().length === 0) {
      return { intent: 'mixed', confidence: 0 };
    }

    const tokens = tokenize(userInput);
    const inputLower = userInput.toLowerCase();

    const scores: Record<TaskIntent, number> = {
      code: 0, browse: 0, desktop: 0, search: 0, file: 0, chat: 0, self_modify: 0, mixed: 0,
    };

    for (const [intent, config] of Object.entries(INTENT_KEYWORDS)) {
      let score = 0;
      for (const keyword of config.keywords) {
        if (tokens.includes(keyword)) score += 2.0 * config.weight;
        if (inputLower.includes(keyword.toLowerCase())) score += 1.0 * config.weight;
      }
      scores[intent as TaskIntent] = score;
    }

    let bestIntent: TaskIntent = 'chat';
    let bestScore = 0;
    for (const [intent, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent as TaskIntent;
      }
    }

    const secondBest = Object.values(scores)
      .filter(s => s !== bestScore)
      .sort((a, b) => b - a)[0] ?? 0;

    // 无匹配 → mixed + 0 置信度
    if (bestScore === 0) {
      return { intent: 'mixed', confidence: 0 };
    }

    // 多意图接近 → mixed，置信度按 secondBest/bestScore 衰减（0.85→0.15，1.0→0）
    if (secondBest > 0 && secondBest / bestScore > 0.85) {
      const ratio = secondBest / bestScore;
      return { intent: 'mixed', confidence: Math.max(0, 1 - ratio) };
    }

    // 单一意图清晰：归一化 bestScore 到 [0,1]，阈值 3.0（1 个 token+substring 关键词命中）
    const confidence = Math.min(1, bestScore / 3.0);
    return { intent: bestIntent, confidence };
  }

  /**
   * Phase D2: 工具选择 LLM fallback
   *
   * 流程：
   * 1. inferIntentWithConfidence → 高置信度（≥ minConfidence）且非 mixed → 走原 sync selectTools（快路径）
   * 2. 低置信度或 mixed + 提供了 llmCaller → 调 LLM 从工具 schema 选 3 个（慢路径，含 5min 缓存）
   * 3. LLM 失败或未提供 llmCaller → 走 selectTools('mixed', ...)（兼容回退）
   *
   * 缓存策略：
   * - key: userInput + 可用工具名签名 的 hash
   * - TTL: 5 分钟
   * - 命中缓存时跳过 LLM 调用，但仍走 failedTools 过滤
   *
   * @param userInput 用户原始输入
   * @param allTools 全量可用工具
   * @param options 含 llmCaller（可选，签名 (prompt) => Promise<string>）+ minConfidence（默认 0.5）+ 原 SelectToolsOptions
   */
  async selectToolsWithLLMFallback(
    userInput: string,
    allTools: ToolDefinition[],
    options?: SelectToolsOptions & {
      llmCaller?: (prompt: string) => Promise<string>;
      minConfidence?: number;
    },
  ): Promise<ToolDefinition[]> {
    const minConfidence = options?.minConfidence ?? 0.5;
    const { intent, confidence } = this.inferIntentWithConfidence(userInput);

    // 快路径：高置信度 + 非 mixed
    if (confidence >= minConfidence && intent !== 'mixed') {
      return this.selectTools(intent, allTools, options);
    }

    // 慢路径：LLM fallback
    if (options?.llmCaller) {
      try {
        const llmToolNames = await this._selectByLLM(userInput, allTools, options.llmCaller);
        if (llmToolNames.length > 0) {
          const toolMap = new Map(allTools.map(t => [t.name, t]));
          const selected = llmToolNames
            .map(name => toolMap.get(name))
            .filter((t): t is ToolDefinition => !!t);
          if (selected.length > 0) {
            return this._applyLLMSelectionFilters(selected, allTools, options);
          }
        }
      } catch {
        // LLM 失败 → 兼容回退到 mixed
      }
    }

    // 兼容回退：mixed intent（全类别可用）
    return this.selectTools('mixed', allTools, options);
  }

  /**
   * Phase D2: LLM 工具选择（含 5 分钟缓存）
   */
  private async _selectByLLM(
    userInput: string,
    allTools: ToolDefinition[],
    llmCaller: (prompt: string) => Promise<string>,
  ): Promise<string[]> {
    const cacheKey = this._hashQuery(userInput, allTools);
    const cached = this._llmSelectionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SmartToolSelector.LLM_CACHE_TTL_MS) {
      return cached.toolNames;
    }

    // 紧凑 schema（限制 30 个工具，描述截断 80 字符控制 prompt 大小）
    const toolsForLLM = allTools.slice(0, 30).map(t => ({
      name: t.name,
      description: (t.description || '').slice(0, 80),
    }));

    const prompt = `你是工具选择助手。从以下工具中选出 3 个最适合处理用户任务的工具，按相关度排序。

用户任务: ${userInput.slice(0, 200)}

可用工具:
${JSON.stringify(toolsForLLM, null, 2)}

只返回 JSON，格式: {"tools": ["tool1", "tool2", "tool3"], "reason": "简要说明"}
不要包含其他文字。`;

    const raw = await llmCaller(prompt);
    const parsed = this._parseLLMToolResponse(raw, allTools);

    this._llmSelectionCache.set(cacheKey, {
      toolNames: parsed,
      timestamp: Date.now(),
    });

    return parsed;
  }

  /** 安全解析 LLM 返回的 JSON（容错 markdown 围栏 + 字段校验） */
  private _parseLLMToolResponse(raw: string, allTools: ToolDefinition[]): string[] {
    if (!raw || typeof raw !== 'string') return [];
    // 提取第一个 JSON 对象（容错 ```json ... ``` 围栏）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const validNames = new Set(allTools.map(t => t.name));
      return tools.filter((t: unknown): t is string =>
        typeof t === 'string' && validNames.has(t));
    } catch {
      return [];
    }
  }

  /** query + 可用工具名签名的简单 hash（djb2 变体） */
  private _hashQuery(input: string, allTools: ToolDefinition[]): string {
    const toolSig = allTools.map(t => t.name).sort().join(',');
    const s = input + '|' + toolSig;
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  /**
   * Phase D2: 对 LLM 选出的工具应用 failedTools 过滤 + 必备工具注入
   *
   * LLM 已决定工具集，不再走 essentialsByIntent/排序逻辑（信任 LLM 顺序），
   * 但仍需：a) 排除连续失败的工具；b) 始终包含 'complete' 工具（终止信号）
   */
  private _applyLLMSelectionFilters(
    selected: ToolDefinition[],
    allTools: ToolDefinition[],
    options?: SelectToolsOptions,
  ): ToolDefinition[] {
    const includeFailed = options?.includeFailed ?? false;
    let filtered = selected;
    if (!includeFailed) {
      filtered = filtered.filter(t => {
        const failCount = this.failedTools.get(t.name) ?? 0;
        return failCount < SmartToolSelector.FAIL_THRESHOLD;
      });
    }
    // 始终注入 'complete' 工具（若存在且未包含）
    const hasComplete = filtered.some(t => t.name === 'complete');
    if (!hasComplete) {
      const complete = allTools.find(t => t.name === 'complete');
      if (complete) filtered.push(complete);
    }
    return filtered;
  }

  // ========== 辅助方法 ==========

  /**
   * 计算工具与上下文的相关性得分
   */
  private computeRelevanceScore(tool: ToolDefinition, context: string): number {
    const meta = this.toolMetaMap.get(tool.name);
    if (!meta) return 0;

    const contextLower = context.toLowerCase();
    const contextTokens = tokenize(context);
    let score = 0;

    // 工具关键词与上下文匹配
    for (const keyword of meta.keywords) {
      if (contextTokens.includes(keyword)) {
        score += 2;
      } else if (contextLower.includes(keyword.toLowerCase())) {
        score += 1;
      }
    }

    // 工具描述与上下文匹配
    const descLower = tool.description.toLowerCase();
    for (const token of contextTokens) {
      if (token.length >= 2 && descLower.includes(token.toLowerCase())) {
        score += 0.5;
      }
    }

    // P1-3: 语义匹配分数（注意力机制对齐）
    score += this.computeSemanticMatchScore(tool, context) * 3;

    return score;
  }

  /**
   * P1-3: 语义匹配分数 — 使用注意力机制计算任务与工具的语义对齐度
   * 三维匹配之一：语义匹配（替代纯关键词匹配）
   * @returns 0-1 的语义相似度分数
   */
  private computeSemanticMatchScore(tool: ToolDefinition, taskContext: string): number {
    if (!taskContext || taskContext.length < 2) return 0;

    try {
      // 获取或缓存工具描述向量
      let toolVec = this.toolVectorCache.get(tool.name);
      if (!toolVec) {
        const toolText = `${tool.name} ${tool.description}`;
        toolVec = this.embedder.embed(toolText);
        this.toolVectorCache.set(tool.name, toolVec);
      }

      // 嵌入任务上下文
      const taskVec = this.embedder.embed(taskContext);

      // 使用交叉注意力计算对齐分数
      return this.crossAttention.alignScore(taskVec, toolVec);
    } catch {
      return 0;
    }
  }

  /**
   * 移除冲突工具
   * 如果高优先级的工具已入选，移除与其冲突的低优先级工具
   */
  private removeConflicts(tools: ToolDefinition[]): ToolDefinition[] {
    // NOTE: 当前无工具定义conflictsWith，此方法暂为预留
    const result: ToolDefinition[] = [];
    const includedNames = new Set<string>();

    for (const tool of tools) {
      const meta = this.toolMetaMap.get(tool.name);
      const conflicts = meta?.conflictsWith ?? [];

      // 检查是否与已入选的工具冲突
      const hasConflict = conflicts.some(c => includedNames.has(c));
      if (!hasConflict) {
        result.push(tool);
        includedNames.add(tool.name);
      }
    }

    return result;
  }

  // ========== 查询方法 ==========

  /** 获取工具元信息 */
  getToolMeta(name: string): ToolMeta | undefined {
    return this.toolMetaMap.get(name);
  }

  /** 获取所有已注册的工具名 */
  getRegisteredToolNames(): string[] {
    return Array.from(this.toolMetaMap.keys());
  }

  /** 获取失败工具统计 */
  getFailedTools(): Map<string, number> {
    return new Map(this.failedTools);
  }

  /** 获取最近使用的工具列表 */
  getRecentTools(): string[] {
    return [...this.recentTools];
  }

  /** 重置失败计数 */
  resetFailedCount(toolName: string): void {
    this.failedTools.delete(toolName);
  }

  /** 清空所有状态 */
  reset(): void {
    this.failedTools.clear();
    this.recentTools = [];
    this._llmSelectionCache.clear();
  }
}
