/**
 * Phase D1: ThinkingTrace — 扩展思考流式可见性组件
 *
 * 渲染 enhanced-agent-loop 推送的 think 事件，区分两种内容：
 *
 * 1. **结构化推理阶段**（来自 extended-thinking-service）
 *    形如 `🧩 问题分解\n  1. ...`，识别 8 类阶段 emoji + 标题：
 *    - 🧩 问题分解  🎯 约束识别  💡 方案生成
 *    - 🔍 边缘情况枚举  ⚠️ 风险评估  📚 相关经验
 *    - 🌳 ToT 树搜索  🪞 自指校验（v20.0 L4 极限思考专属）
 *
 * 2. **运行时状态**（来自主循环各阶段）
 *    形如 `🔄 切换策略` / `📦 命中经验包` / `⚠️ 模型 ... 使用非流式模式`
 *    （单行，前缀为已知操作 emoji）
 *
 * 渲染策略：
 * - 头部 `💭 推理` 折叠按钮（默认折叠，点击展开）
 * - 展开后：先列结构化阶段（每个阶段独立卡片），后列运行时状态（紧凑列表）
 * - 无阶段标记时退化为纯文本（兼容历史 thinking 内容）
 *
 * 与 ThinkCard 的关系：
 * - ThinkCard 是历史组件，渲染整个 thinking 字符串为单一文本块
 * - ThinkingTrace 是 Phase D1 新增组件，能识别阶段边界并结构化展示
 * - ChatArea 同时保留两者：thinking 含阶段标记 → ThinkingTrace，否则 ThinkCard
 */
import React, { useMemo } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';

// ============ Props ============

export interface ThinkingTraceProps {
  /** 累积的思考文本（来自 SSE think 事件累积） */
  thinking: string;
  /** 消息 ID — 用于持久化展开状态 */
  msgId: string;
  /** 是否流式中（影响"思考中..."文案与图标动画） */
  isStreaming?: boolean;
  /** 是否含有工具调用（影响"思考完毕，开始执行"提示） */
  hasTools?: boolean;
  /** 各消息展开状态 map */
  expandedThinking: Record<string, boolean>;
  setExpandedThinking: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

// ============ 解析逻辑 ============

interface ThinkingPhase {
  emoji: string;
  title: string;
  body: string;
}

interface ParsedThinking {
  /** 触发语 "🧠 检测到复杂任务..." */
  intro: string | null;
  /** 结构化推理阶段 */
  phases: ThinkingPhase[];
  /** 运行时状态行（单行） */
  ops: string[];
  /** 是否检测到任何阶段标记 */
  hasPhaseMarkers: boolean;
}

/**
 * 阶段头部正则 — 严格匹配 emoji + 已知标题
 * （避免误判 `⚠️ 模型 ... 使用非流式模式` 这种运行时状态行）
 *
 * v20.0: 新增 🌳 ToT 树搜索 / 🪞 自指校验（L4 极限思考专属）
 */
const PHASE_HEADER_REGEX =
  /^(🧩|🎯|💡|🔍|⚠️|📚|🌳|🪞)\s+(问题分解|约束识别|方案生成(?:\s*\(.*\))?|边缘情况枚举|风险评估|相关经验|ToT 树搜索|自指校验)$/;

/** 触发语正则 — Extended Thinking 自动触发提示 */
const INTRO_REGEX = /^🧠\s+检测到复杂任务/;

/** 已知运行时操作 emoji 前缀 */
const OPS_PREFIXES = [
  '📦', '🔄', '🔧', '🛑', '✅', '📉', '📈',
  '⚡', '📋', '🚨', '🛠️', '💡', '📚', '🧠',
];

/**
 * 解析累积的 thinking 字符串为结构化数据
 *
 * 算法：逐行扫描，识别阶段头部 → 收集缩进正文直到下一个头部/操作行；
 * 非阶段匹配的单行（以已知操作 emoji 开头）归为运行时状态。
 */
function parseThinking(text: string): ParsedThinking {
  if (!text) {
    return { intro: null, phases: [], ops: [], hasPhaseMarkers: false };
  }

  const lines = text.split('\n');
  const phases: ThinkingPhase[] = [];
  const ops: string[] = [];
  let intro: string | null = null;
  let currentPhase: ThinkingPhase | null = null;

  const flushPhase = () => {
    if (currentPhase) {
      phases.push(currentPhase);
      currentPhase = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // 1. 触发语
    if (INTRO_REGEX.test(trimmed)) {
      flushPhase();
      intro = trimmed;
      continue;
    }

    // 2. 阶段头部（严格匹配）
    const phaseMatch = trimmed.match(PHASE_HEADER_REGEX);
    if (phaseMatch) {
      flushPhase();
      currentPhase = { emoji: phaseMatch[1], title: phaseMatch[2], body: '' };
      continue;
    }

    // 3. 缩进行 → 当前阶段正文
    if (currentPhase && (line.startsWith('  ') || line.startsWith('\t') || trimmed === '')) {
      currentPhase.body += (currentPhase.body || trimmed === '' ? '\n' : '') + line;
      continue;
    }

    // 4. 运行时操作行
    const isOp = OPS_PREFIXES.some(p => trimmed.startsWith(p));
    if (isOp) {
      flushPhase();
      if (trimmed) ops.push(trimmed);
      continue;
    }

    // 5. 孤儿文本 — 归为运行时状态
    if (trimmed) {
      flushPhase();
      ops.push(trimmed);
    }
  }
  flushPhase();

  return {
    intro,
    phases,
    ops,
    hasPhaseMarkers: phases.length > 0,
  };
}

// ============ 子组件 ============

/** 单个阶段卡片 — emoji + 标题 + 正文 */
const PhaseCard = React.memo(({ phase }: { phase: ThinkingPhase }) => (
  <div
    style={{
      marginBottom: 6,
      padding: '6px 8px',
      borderRadius: 6,
      background: 'rgba(167,139,250,.04)',
      borderLeft: '2px solid rgba(167,139,250,.25)',
    }}
  >
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 11, color: '#c4b5fd', fontWeight: 500, marginBottom: 3,
      }}
    >
      <span style={{ fontSize: 12 }}>{phase.emoji}</span>
      <span>{phase.title}</span>
    </div>
    {phase.body && (
      <div
        style={{
          fontSize: 10.5, color: '#94a3b8', lineHeight: 1.55,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: 'inherit',
        }}
      >
        {phase.body}
      </div>
    )}
  </div>
));

/** 运行时状态紧凑列表 */
const OpsList = React.memo(({ ops }: { ops: string[] }) => (
  <div
    style={{
      marginTop: 6, paddingTop: 6,
      borderTop: '1px dashed rgba(148,163,184,.15)',
    }}
  >
    <div
      style={{
        fontSize: 10, color: '#64748b', marginBottom: 4,
        letterSpacing: 0.3,
      }}
    >
      · 运行时事件 ·
    </div>
    {ops.map((op, i) => (
      <div
        key={i}
        style={{
          fontSize: 10.5, color: '#94a3b8', lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          padding: '2px 0',
        }}
      >
        {op}
      </div>
    ))}
  </div>
));

// ============ 主组件 ============

export const ThinkingTrace = React.memo(
  ({ thinking, msgId, isStreaming: isStream, hasTools, expandedThinking, setExpandedThinking }: ThinkingTraceProps) => {
    const isExpanded = expandedThinking[msgId] ?? false;
    const parsed = useMemo(() => parseThinking(thinking), [thinking]);

    // 退化路径：无阶段标记 → 渲染为简单折叠文本（兼容历史内容）
    if (!parsed.hasPhaseMarkers) {
      const summary = thinking.length > 80 ? thinking.substring(0, 80) + '...' : thinking;
      return (
        <div className="think-card" style={{ marginBottom: hasTools ? 6 : 0 }}>
          <button
            onClick={() => setExpandedThinking(prev => ({ ...prev, [msgId]: !prev[msgId] }))}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 6,
              padding: 0, background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#a78bfa', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
            }}
          >
            {isExpanded ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
            <Sparkles style={{ width: 11, height: 11 }} />
            {isStream ? '💭 推理中...' : '💭 推理'}
            {!isStream && !isExpanded && (
              <span style={{ fontSize: 10, color: '#475569', marginLeft: 4, fontWeight: 400 }}>{summary}</span>
            )}
          </button>
          {isExpanded && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingLeft: 16, borderLeft: '2px solid rgba(167,139,250,.15)' }}>
              {thinking}
            </div>
          )}
          {!isStream && hasTools && (
            <div style={{ marginTop: 3, fontSize: 10, color: '#06b6d4', display: 'flex', alignItems: 'center', gap: 3, paddingLeft: 16 }}>
              <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#06b6d4' }} />
              思考完毕，开始执行
            </div>
          )}
        </div>
      );
    }

    // 主路径：结构化渲染阶段 + 运行时事件
    const summary = parsed.phases.length > 0
      ? `${parsed.phases[0].emoji} ${parsed.phases[0].title}${parsed.phases.length > 1 ? ` 等 ${parsed.phases.length} 阶段` : ''}`
      : '';
    const phaseCount = parsed.phases.length;

    return (
      <div className="think-card" style={{ marginBottom: hasTools ? 6 : 0 }}>
        <button
          onClick={() => setExpandedThinking(prev => ({ ...prev, [msgId]: !prev[msgId] }))}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 6,
            padding: 0, background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#a78bfa', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
          }}
        >
          {isExpanded ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
          <span style={{ fontSize: 12 }}>💭</span>
          {isStream ? (
            <span>
              推理中
              {phaseCount > 0 && <span style={{ color: '#475569', fontWeight: 400, marginLeft: 4 }}>（已完成 {phaseCount} 阶段）</span>}
              <span style={{ display: 'inline-block', marginLeft: 2, animation: 'thinking-blink 1.4s infinite' }}>...</span>
            </span>
          ) : (
            <span>
              推理过程
              {phaseCount > 0 && <span style={{ color: '#475569', fontWeight: 400, marginLeft: 4 }}>（{phaseCount} 阶段）</span>}
            </span>
          )}
          {!isStream && !isExpanded && (
            <span style={{ fontSize: 10, color: '#475569', marginLeft: 4, fontWeight: 400 }}>{summary}</span>
          )}
        </button>
        {isExpanded && (
          <div style={{ marginTop: 4, paddingLeft: 16, borderLeft: '2px solid rgba(167,139,250,.15)' }}>
            {/* 触发语 */}
            {parsed.intro && (
              <div
                style={{
                  fontSize: 10.5, color: '#c4b5fd', fontStyle: 'italic',
                  marginBottom: 6, padding: '3px 0',
                }}
              >
                {parsed.intro}
              </div>
            )}
            {/* 结构化阶段 */}
            {parsed.phases.map((phase, i) => (
              <PhaseCard key={i} phase={phase} />
            ))}
            {/* 运行时状态 */}
            {parsed.ops.length > 0 && <OpsList ops={parsed.ops} />}
          </div>
        )}
        {!isStream && hasTools && (
          <div style={{ marginTop: 3, fontSize: 10, color: '#06b6d4', display: 'flex', alignItems: 'center', gap: 3, paddingLeft: 16 }}>
            <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#06b6d4' }} />
            思考完毕，开始执行
          </div>
        )}
        <style>{`
          @keyframes thinking-blink {
            0%, 80%, 100% { opacity: 0.2; }
            40% { opacity: 1; }
          }
        `}</style>
      </div>
    );
  },
);

ThinkingTrace.displayName = 'ThinkingTrace';
