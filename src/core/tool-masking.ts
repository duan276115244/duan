import { logger } from './structured-logger.js';

export type AgentPhase =
  | 'reasoning'
  | 'coding'
  | 'web'
  | 'desktop'
  | 'communication'
  | 'memory'
  | 'creative'
  | 'all';

// 工具匹配：每个 pattern 同时作为精确匹配与前缀匹配
// （name === pattern || name.startsWith(pattern)）。
// 这样 'file_read' 既匹配 'file_read' 也匹配 'file_read_v2'，符合"工具名以 pattern 开头即命中"契约。
const PHASE_TOOL_PATTERNS: Record<AgentPhase, string[]> = {
  reasoning: ['self_think', 'self_assess', 'self_omni', 'self_memory_query', 'self_memory_list', 'self_project', 'current_time', 'dreaming_query', 'dreaming_status', 'user_profile', 'user_predict', 'proactive_trigger_list', 'proactive_habits'],
  coding: ['file_read', 'file_write', 'self_write', 'self_patch', 'self_read', 'shell_execute', 'code_execute', 'self_git', 'self_test', 'self_rollback', 'list_directory', 'search_files', 'self_skills', 'self_heal', 'self_cost', 'self_metrics', 'dynamic_tools_list', 'dynamic_tools_create', 'dreaming_record'],
  web: ['web_search', 'web_fetch', 'http_request', 'browser_operate', 'current_time'],
  desktop: ['screen_capture', 'screen_analyze', 'screen_find', 'screen_click', 'screen_move', 'screen_type', 'screen_key', 'screen_ocr', 'desktop_open', 'computer_use', 'screen_size'],
  communication: ['wechat_send', 'wechat_contact', 'wechat_group', 'email_send', 'email_read'],
  memory: ['self_memory', 'dreaming_query', 'dreaming_status', 'dreaming_record', 'user_profile', 'user_predict', 'proactive_trigger_list', 'proactive_habits'],
  creative: ['file_read', 'file_write', 'self_read', 'shell_execute', 'code_execute', 'browser_operate', 'screen_capture', 'screen_analyze', 'screen_click', 'screen_type', 'screen_key', 'desktop_open', 'web_search', 'web_fetch'],
  all: [],
};

export interface PhaseTransition {
  from: AgentPhase;
  to: AgentPhase;
  reason: string;
  timestamp: number;
}

export class ToolMaskingEngine {
  private currentPhase: AgentPhase = 'all';
  private transitions: PhaseTransition[] = [];
  private log = logger.child({ module: 'ToolMaskingEngine' });

  getPhase(): AgentPhase {
    return this.currentPhase;
  }

  transitionTo(phase: AgentPhase, reason: string): void {
    const from = this.currentPhase;
    this.currentPhase = phase;
    this.transitions.push({ from, to: phase, reason, timestamp: Date.now() });
    if (this.transitions.length > 100) this.transitions.shift();
    this.log.info('Phase transition', { from, to: phase, reason });
  }

  getHistory(limit: number = 5): PhaseTransition[] {
    return this.transitions.slice(-limit);
  }

  reset(): void {
    const from = this.currentPhase;
    this.currentPhase = 'all';
    this.transitions.push({ from, to: 'all', reason: 'reset', timestamp: Date.now() });
  }

  filterTools(toolNames: string[]): string[] {
    if (this.currentPhase === 'all') return toolNames;

    const allowed = PHASE_TOOL_PATTERNS[this.currentPhase];
    if (!allowed || allowed.length === 0) return toolNames;

    // 每个 pattern 同时匹配精确名与前缀（name === pattern || name.startsWith(pattern)）
    const kept = toolNames.filter(name =>
      allowed.some(pattern => name === pattern || name.startsWith(pattern))
    );

    if (kept.length < toolNames.length) {
      const filteredOut = toolNames.filter(name => !kept.includes(name));
      this.log.debug('Tools filtered out by phase mask', {
        phase: this.currentPhase,
        filteredCount: filteredOut.length,
        filteredTools: filteredOut,
        allowedCount: kept.length,
      });
    }

    return kept;
  }

  getPhaseDescription(phase: AgentPhase): string {
    const descriptions: Record<AgentPhase, string> = {
      reasoning: '🧠 推理分析阶段 — 仅暴露思考/评估/记忆查询类工具',
      coding: '💻 编码开发阶段 — 仅暴露文件/代码/Git/测试/自修工具',
      web: '🌐 网络搜索阶段 — 仅暴露搜索/抓取/浏览器工具',
      desktop: '🖥️ 桌面操控阶段 — 仅暴露截图/点击/键盘/OCR/桌面工具',
      communication: '💬 通讯阶段 — 仅暴露微信/邮件通讯工具',
      memory: '📖 记忆检索阶段 — 仅暴露记忆/画像/触发器工具',
      creative: '🎨 创意阶段 — 仅暴露文件/代码/浏览器/桌面/搜索工具',
      all: '🔓 全部工具可用 — 无限制',
    };
    return descriptions[phase] || '🔓 全部工具可用';
  }

  formatForPrompt(): string {
    return [
      `## 🔧 当前工具阶段: ${this.currentPhase}`,
      this.getPhaseDescription(this.currentPhase),
      this.currentPhase !== 'all'
        ? `可用工具: ${PHASE_TOOL_PATTERNS[this.currentPhase].join(', ')}`
        : '所有工具均可用',
    ].join('\n');
  }
}
