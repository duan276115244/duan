/**
 * 高端终端 TUI 渲染引擎 — CLI Display v3
 *
 * 参考 OpenCode / Charmbracelet 设计理念：
 * - 分栏布局：左侧对话区 + 右侧信息面板
 * - 顶部状态栏：模型/连接/轮次/模式
 * - 底部输入区：独立输入行
 * - 右侧面板：任务进度/工具调用/模型信息
 * - 全中文界面
 */

import chalk from 'chalk';
import type { CognitiveState } from './cognitive-state.js';
import type { SelfAssessment } from './self-assessment.js';
import type { GoalSystem } from './goal-system.js';
import type { Heartbeat } from './heartbeat.js';
import type { SelfAwareness } from './self-awareness.js';
import type { SelfEvolve } from './self-evolve.js';
import type { ModuleRegistry } from './module-registry.js';

// ============ 色彩体系 ============

export const colors = {
  primary: '#ff6b6b',
  primaryDim: '#cc5555',
  secondary: '#ffa502',
  accent: '#ffd93d',
  success: '#2ed573',
  error: '#ff4757',
  warning: '#ffa502',
  info: '#70a1ff',
  text: '#dfe6e9',
  textDim: '#636e72',
  textMuted: '#4a5568',
  bg: '#0a0a0f',
  surface: '#12121a',
  border: '#2d3436',
  borderBright: '#636e72',
  cyan: '#00d2d3',
  purple: '#a29bfe',
  pink: '#fd79a8',
};

const p = chalk.hex(colors.primary);
const pd = chalk.hex(colors.primaryDim);
const s = chalk.hex(colors.secondary);
const a = chalk.hex(colors.accent);
const g = chalk.hex(colors.success);
const _i = chalk.hex(colors.info);
const d = chalk.hex(colors.textDim);
const m = chalk.hex(colors.textMuted);
const cy = chalk.hex(colors.cyan);
const pu = chalk.hex(colors.purple);

// ============ 终端尺寸检测 ============

export function getTermSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

// ============ 显示宽度计算 ============

export function displayWidth(str: string): number {
  const stripped = stripAnsi(str);
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x2E80 && code <= 0x2EFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0x2600 && code <= 0x27BF) ||
      (code >= 0x1F300 && code <= 0x1F9FF) ||
      (code >= 0x20000 && code <= 0x2A6DF)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function padRight(str: string, width: number): string {
  const dw = displayWidth(str);
  if (dw >= width) return str;
  return str + ' '.repeat(width - dw);
}

function centerText(text: string, width: number): string {
  const len = displayWidth(text);
  const pad = Math.max(0, Math.floor((width - len) / 2));
  return ' '.repeat(pad) + text;
}

// ============ 边框辅助函数 ============
//
// 统一处理盒式面板的边框拼接与内容填充，避免各处重复手写
// ╔╠╟╚ + padRight 的模式（容易出现对齐 bug）。

/** 顶部边框：  ╔════╗ */
function boxTop(boxW: number): string {
  return pd(`  ╔${'═'.repeat(boxW)}╗`);
}

/** 底部边框：  ╚════╝ */
function boxBottom(boxW: number): string {
  return pd(`  ╚${'═'.repeat(boxW)}╝`);
}

/**
 * 分隔线：
 * - heavy=true  →  ╠════╣
 * - heavy=false →  ╟────╢
 */
function boxDivider(boxW: number, heavy = false): string {
  return heavy
    ? d(`  ╠${'═'.repeat(boxW)}╣`)
    : d(`  ╟${'─'.repeat(boxW)}╢`);
}

/** 普通内容行（左对齐 + 右侧填充对齐边框） */
function boxRow(content: string, innerW: number): string {
  return d('  ║') + padRight(content, innerW) + d('║');
}

/** 居中内容行（居中 + 右侧填充对齐边框） */
function boxCenterRow(content: string, innerW: number): string {
  return d('  ║') + padRight(centerText(content, innerW), innerW) + d('║');
}

// ============ 欢迎画面 ============

export interface SystemState {
  autoMode: boolean;
  thinkingMode: 'reactive' | 'proactive' | 'strategic' | 'creative';
  evolutionLevel: number;
  totalTasks: number;
  successRate: number;
}

// ============ 状态面板 ============

export function showStatus(
  systemState: SystemState,
  cognitiveState: CognitiveState,
  _goalSystem: GoalSystem,
  _heartbeat: Heartbeat,
  _selfAssessment: SelfAssessment,
  _selfAwareness: SelfAwareness,
  _selfEvolve: SelfEvolve,
  _moduleRegistry: ModuleRegistry,
) {
  const cs = cognitiveState.getState();
  const { cols } = getTermSize();
  const boxW = Math.min(60, cols - 4);
  const innerW = boxW - 2;

  console.info();
  console.info(boxTop(boxW));
  console.info(boxCenterRow(p.bold(' ◈ 系统状态 '), innerW));
  console.info(boxDivider(boxW, true));

  const verLine = `  ${d('版本')}  ${a('v19.0')}          ${d('等级')}  ${cy(String(cs.consciousness))}          ${d('模式')}  ${s(systemState.thinkingMode)}`;
  console.info(boxRow(` ${verLine}`, innerW));
  console.info(boxDivider(boxW));

  const energyBlocks = Math.round(cs.energy * 20);
  const energyBar = g('█'.repeat(energyBlocks)) + m('░'.repeat(20 - energyBlocks));
  const eLine = `  ${d('能量')}  ${energyBar}  ${a((cs.energy * 100).toFixed(0) + '%')}`;
  console.info(boxRow(` ${eLine}`, innerW));

  const moodIcons: Record<string, string> = {
    happy: '😊', calm: '😌', focused: '🎯', curious: '🤔',
    excited: '🔥', neutral: '😐', tired: '😴', anxious: '😰',
  };
  const moodLabels: Record<string, string> = {
    happy: '开心', calm: '平静', focused: '专注', curious: '好奇',
    excited: '兴奋', neutral: '中性', tired: '疲惫', anxious: '焦虑',
  };
  const moodIcon = moodIcons[cs.mood] || '😐';
  const moodLabel = moodLabels[cs.mood] || cs.mood;
  const mLine = `  ${d('心情')}  ${moodIcon} ${a(moodLabel)}`;
  console.info(boxRow(` ${mLine}`, innerW));

  console.info(boxDivider(boxW));

  const taskLine = `  ${d('任务')}  ${cy(String(systemState.totalTasks))} 已完成     ${d('成功率')}  ${g((systemState.successRate * 100).toFixed(0) + '%')}`;
  console.info(boxRow(` ${taskLine}`, innerW));

  console.info(boxRow('', innerW));
  console.info(boxBottom(boxW));
  console.info();
}

// ============ 帮助面板 ============

export function showHelp(_category?: string) {
  const { cols } = getTermSize();
  const boxW = Math.min(60, cols - 4);
  const innerW = boxW - 2;

  console.info();
  console.info(boxTop(boxW));
  console.info(boxCenterRow(p.bold(' ◈ 命令列表 '), innerW));
  console.info(boxDivider(boxW, true));

  const cmdGroups: [string, [string, string][]][] = [
    ['基础命令', [
      ['help', '显示帮助信息'],
      ['status', '查看系统状态'],
      ['channels', '查看消息通道状态'],
      ['mode', '设置思考模式 (reactive/proactive/strategic/creative)'],
      ['auto', '切换自动模式'],
      ['clear', '清空对话记录'],
      ['exit/quit', '退出系统'],
    ]],
    ['配置与模型', [
      ['setup/configure', '打开配置向导'],
      ['config', '查看当前配置'],
      ['model', '模型管理/切换'],
      ['upgrade', '系统升级'],
    ]],
    ['智能能力', [
      ['think', '深度推理分析'],
      ['decide', '自主决策'],
      ['assess', '自我评估'],
      ['diagnose', '系统诊断'],
      ['mood', '查看情绪状态'],
    ]],
    ['进化系统', [
      ['memory', '记忆系统'],
      ['learn', '学习系统'],
      ['skills', '技能库'],
      ['strategies', '策略库'],
      ['goals', '目标追踪'],
      ['self-evolve', '自我进化分析'],
      ['evolve', '执行进化'],
      ['consciousness', '意识状态'],
    ]],
    ['工程能力', [
      ['test', '功能测试'],
      ['benchmark', '性能基准测试'],
      ['repair', '自愈修复'],
      ['optimize', '系统优化'],
      ['knowledge', '知识库管理'],
    ]],
    ['高级功能', [
      ['classifier', '分类器管理'],
      ['shadow_logs', '影子日志'],
    ]],
  ];

  for (const [groupName, cmds] of cmdGroups) {
    const gLine = `  ${pu.bold(groupName)}`;
    console.info(boxRow(` ${gLine}`, innerW));
    for (const [cmd, desc] of cmds) {
      const cLine = `    ${s(cmd.padEnd(12))} ${d(desc)}`;
      console.info(boxRow(` ${cLine}`, innerW));
    }
    if (groupName !== '进化系统') {
      console.info(boxDivider(boxW));
    }
  }

  console.info(boxRow('', innerW));
  console.info(boxRow(` ${m('或直接输入您的问题开始对话')}`, innerW));
  console.info(boxRow('', innerW));
  console.info(boxBottom(boxW));
  console.info();
}

export function modelInfoLine(provider: string, model: string): string {
  return `  ${d('◈')} ${cy(provider)} ${d('/')} ${s(model)}`;
}



