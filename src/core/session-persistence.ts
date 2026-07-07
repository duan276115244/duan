/**
 * 会话持久化与恢复模块 — SessionPersistence
 *
 * 为"段先生"自主 AI Agent 系统提供 JSONL 格式的会话持久化与崩溃恢复能力：
 * - JSONL 追加写入：崩溃安全的日志格式，每行一条事件
 * - 会话恢复：重放 JSONL 事件重建 Agent 状态，支持中断任务续接
 * - 状态快照：定期保存 Agent 完整状态，加速恢复过程
 * - 多格式导出：支持 JSONL / Markdown / HTML 格式导出会话
 * - 通过 EventBus 广播会话生命周期事件
 * - 通过 getToolDefinitions() 注册为 Agent Loop 可用工具
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 会话事件 */
export interface SessionEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'state_snapshot' | 'checkpoint' | 'system';
  timestamp: number;
  data: Record<string, unknown>;
}

/** 会话元数据 */
export interface SessionMetadata {
  id: string;
  startedAt: number;
  endedAt?: number;
  status: 'active' | 'completed' | 'crashed';
  eventCount: number;
  taskDescription?: string;
  version: string;
}

/** 恢复后的状态 */
export interface RecoveredState {
  sessionId: string;
  conversationHistory: Array<{ role: string; content: string }>;
  toolCallHistory: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  lastPlan?: Record<string, unknown>;
  cognitiveState?: Record<string, unknown>;
  /** 环境状态快照 — 记录执行时的环境信息（打开的资源、工作目录等） */
  environmentState?: {
    openResources?: string[];      // 已打开的资源（浏览器URL、应用等）
    workspaceRoot?: string;        // 工作区根目录
    activeTools?: string[];        // 最后使用的工具
    completedSteps?: string[];     // 已完成的计划步骤
    failedSteps?: string[];        // 失败的计划步骤
    lastWorkingDirectory?: string; // 最后的工作目录
  };
  recoveredAt: number;
  eventsReplayed: number;
}

/** 列出会话的过滤选项 */
export interface ListSessionsOptions {
  status?: 'active' | 'completed' | 'crashed';
  limit?: number;
}

/** 会话概览信息 */
export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  eventCount: number;
  status: 'active' | 'completed' | 'crashed';
  taskDescription?: string;
}


// ============ 常量 ============

/** 模块版本号 */
const MODULE_VERSION = '1.0.0';

/** 会话目录前缀 */
const SESSION_DIR_PREFIX = 'session_';

/** 事件日志文件名 */
const EVENTS_FILE = 'events.jsonl';

/** 元数据文件名 */
const METADATA_FILE = 'metadata.json';

/** 状态快照子目录 */
const STATES_DIR = 'states';

/** 最大快照数量（超过后自动清理旧快照） */
const MAX_SNAPSHOTS = 10;

// ============ 主类 ============

export class SessionPersistence {
  private sessionsDir: string;
  private currentSessionId: string | null = null;
  private currentWriteStream: fs.WriteStream | null = null;
  private currentMetadata: SessionMetadata | null = null;
  private log = logger.child({ module: 'SessionPersistence' });

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir || '.sessions';
  }

  // ============ 会话管理 ============

  /**
   * 启动新会话
   * 生成唯一会话ID，创建会话目录，初始化 JSONL 日志文件
   */
  startSession(metadata?: Record<string, unknown>): string {
    // 如果已有活跃会话，先关闭
    if (this.currentSessionId) {
      this.endSession('completed');
    }

    // 生成唯一会话 ID：时间戳 + 随机后缀
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 8);
    const sessionId = `${SESSION_DIR_PREFIX}${timestamp}_${randomSuffix}`;

    // 创建会话目录结构
    const sessionDir = this.getSessionDir(sessionId);
    const statesDir = path.join(sessionDir, STATES_DIR);

    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(statesDir, { recursive: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('创建会话目录失败', { sessionId, error: msg });
      throw new Error(`创建会话目录失败: ${msg}`);
    }

    // 初始化元数据
    this.currentMetadata = {
      id: sessionId,
      startedAt: timestamp,
      status: 'active',
      eventCount: 0,
      taskDescription: metadata?.taskDescription as string | undefined,
      version: MODULE_VERSION,
    };

    // 合并额外元数据
    if (metadata) {
      Object.assign(this.currentMetadata, metadata);
    }

    this.saveMetadata(sessionId, this.currentMetadata);

    // 创建追加写入流
    const eventsPath = path.join(sessionDir, EVENTS_FILE);
    this.currentWriteStream = fs.createWriteStream(eventsPath, { flags: 'a', encoding: 'utf-8' });
    this.currentSessionId = sessionId;

    // 记录会话启动事件
    this.logEvent({
      type: 'system',
      timestamp,
      data: {
        action: 'session_start',
        sessionId,
        version: MODULE_VERSION,
        ...metadata,
      },
    });

    // 广播会话创建事件
    EventBus.getInstance().emitSync('session.created', {
      sessionId,
      startedAt: timestamp,
      taskDescription: this.currentMetadata.taskDescription,
    }, { source: 'SessionPersistence' });

    this.log.info('会话已启动', { sessionId });
    return sessionId;
  }

  /**
   * 结束当前会话
   */
  endSession(status: 'completed' | 'crashed' = 'completed'): void {
    if (!this.currentSessionId || !this.currentMetadata) {
      return;
    }

    // 记录会话结束事件
    this.logEvent({
      type: 'system',
      timestamp: Date.now(),
      data: {
        action: 'session_end',
        status,
        durationMs: Date.now() - this.currentMetadata.startedAt,
      },
    });

    // 更新元数据
    this.currentMetadata.endedAt = Date.now();
    this.currentMetadata.status = status;
    this.saveMetadata(this.currentSessionId, this.currentMetadata);

    // 关闭写入流
    if (this.currentWriteStream) {
      this.currentWriteStream.end();
      this.currentWriteStream = null;
    }

    // 广播会话关闭事件
    EventBus.getInstance().emitSync('session.closed', {
      sessionId: this.currentSessionId,
      status,
      durationMs: this.currentMetadata.endedAt - this.currentMetadata.startedAt,
      eventCount: this.currentMetadata.eventCount,
    }, { source: 'SessionPersistence' });

    this.log.info('会话已结束', {
      sessionId: this.currentSessionId,
      status,
      eventCount: this.currentMetadata.eventCount,
    });

    this.currentSessionId = null;
    this.currentMetadata = null;
  }

  // ============ 事件日志 ============

  /**
   * 记录事件到当前会话
   * 追加写入 JSONL 格式，每次写入后自动 flush
   */
  logEvent(event: SessionEvent): boolean {
    if (!this.currentSessionId || !this.currentWriteStream) {
      this.log.warn('没有活跃会话，无法记录事件');
      return false;
    }

    try {
      const line = JSON.stringify(event) + '\n';
      this.currentWriteStream.write(line);

      // 更新事件计数
      if (this.currentMetadata) {
        this.currentMetadata.eventCount++;
      }

      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('写入事件失败', { sessionId: this.currentSessionId, error: msg });
      return false;
    }
  }

  // ============ 状态快照 ============

  /**
   * 保存 Agent 状态快照
   * 捕获对话历史、工具调用历史、当前计划、认知状态
   * 大状态对象会被压缩存储
   */
  saveState(state: Record<string, unknown>): string {
    if (!this.currentSessionId) {
      this.log.warn('没有活跃会话，无法保存状态');
      return '';
    }

    const statesDir = path.join(this.getSessionDir(this.currentSessionId), STATES_DIR);

    // 生成快照 ID
    const existingSnapshots = this.getSnapshotFiles(this.currentSessionId);
    const snapshotIndex = existingSnapshots.length + 1;
    const snapshotId = `snapshot_${String(snapshotIndex).padStart(3, '0')}`;

    // 序列化状态
    const serialized = JSON.stringify(state, null, 2);

    // 如果状态较大（>100KB），使用 gzip 压缩
    const snapshotPath = path.join(statesDir, `${snapshotId}.json`);
    const compressedPath = path.join(statesDir, `${snapshotId}.json.gz`);

    try {
      if (Buffer.byteLength(serialized) > 100 * 1024) {
        // 压缩存储
        const compressed = zlib.gzipSync(Buffer.from(serialized, 'utf-8'));
        fs.writeFileSync(compressedPath, compressed);
        this.log.info('状态快照已保存（压缩）', {
          sessionId: this.currentSessionId,
          snapshotId,
          originalSize: Buffer.byteLength(serialized),
          compressedSize: compressed.length,
          ratio: ((compressed.length / Buffer.byteLength(serialized)) * 100).toFixed(1) + '%',
        });
      } else {
        // 直接存储
        atomicWriteJsonSync(snapshotPath, state);
        this.log.info('状态快照已保存', {
          sessionId: this.currentSessionId,
          snapshotId,
          size: Buffer.byteLength(serialized),
        });
      }

      // 清理旧快照
      this.cleanupOldSnapshots(this.currentSessionId);

      // 记录快照事件
      this.logEvent({
        type: 'state_snapshot',
        timestamp: Date.now(),
        data: {
          snapshotId,
          stateKeys: Object.keys(state),
          sizeBytes: Buffer.byteLength(serialized),
        },
      });

      return snapshotId;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('保存状态快照失败', { sessionId: this.currentSessionId, error: msg });
      return '';
    }
  }

  // ============ 会话恢复 ============

  /**
   * 恢复会话
   * 如果未指定 sessionId，自动查找最近的未完成会话
   * 通过重放 JSONL 事件重建 Agent 状态
   */
  recoverSession(sessionId?: string): RecoveredState | null {
    let targetSessionId = sessionId;

    // 自动查找最近的未完成会话
    if (!targetSessionId) {
      targetSessionId = this.findMostRecentIncompleteSession() ?? undefined;
      if (!targetSessionId) {
        this.log.info('没有找到可恢复的会话');
        return null;
      }
    }

    const sessionDir = this.getSessionDir(targetSessionId);
    if (!fs.existsSync(sessionDir)) {
      this.log.warn('会话目录不存在', { sessionId: targetSessionId });
      return null;
    }

    const eventsPath = path.join(sessionDir, EVENTS_FILE);
    if (!fs.existsSync(eventsPath)) {
      this.log.warn('事件日志文件不存在', { sessionId: targetSessionId });
      return null;
    }

    // 读取并重放所有事件
    const recoveredState: RecoveredState = {
      sessionId: targetSessionId,
      conversationHistory: [],
      toolCallHistory: [],
      recoveredAt: Date.now(),
      eventsReplayed: 0,
    };

    try {
      const content = fs.readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // 先尝试从最新快照恢复（加速恢复）
      const latestSnapshot = this.loadLatestSnapshot(targetSessionId);
      if (latestSnapshot) {
        // 从快照中恢复已有状态
        if (latestSnapshot.conversationHistory) {
          recoveredState.conversationHistory = latestSnapshot.conversationHistory as Array<{ role: string; content: string }>;
        }
        if (latestSnapshot.toolCallHistory) {
          recoveredState.toolCallHistory = latestSnapshot.toolCallHistory as Array<{ name: string; args: Record<string, unknown>; result: string }>;
        }
        if (latestSnapshot.lastPlan) {
          recoveredState.lastPlan = latestSnapshot.lastPlan as Record<string, unknown>;
        }
        if (latestSnapshot.cognitiveState) {
          recoveredState.cognitiveState = latestSnapshot.cognitiveState as Record<string, unknown>;
        }
      }

      // 重放事件（从快照之后的事件开始，如果没有快照则从头开始）
      let snapshotEventIndex = 0;
      if (latestSnapshot) {
        // 找到快照事件的位置，从其后继续重放
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const event: SessionEvent = JSON.parse(lines[i]);
            if (event.type === 'state_snapshot') {
              snapshotEventIndex = i + 1;
              break;
            }
          } catch { /* 跳过解析失败的行 */ }
        }
      }

      for (let i = snapshotEventIndex; i < lines.length; i++) {
        try {
          const event: SessionEvent = JSON.parse(lines[i]);
          this.replayEvent(event, recoveredState);
          recoveredState.eventsReplayed++;
        } catch {
          // 跳过解析失败的行（可能是崩溃时写入不完整）
          this.log.warn('跳过无法解析的事件行', { sessionId: targetSessionId, lineIndex: i });
        }
      }

      // 更新原会话状态为 crashed
      this.updateSessionStatus(targetSessionId, 'crashed');

      // 从工具调用历史中重建环境状态
      recoveredState.environmentState = this.rebuildEnvironmentState(recoveredState.toolCallHistory);

      // 广播会话恢复事件
      EventBus.getInstance().emitSync('session.recovered', {
        sessionId: targetSessionId,
        eventsReplayed: recoveredState.eventsReplayed,
        conversationLength: recoveredState.conversationHistory.length,
        toolCallCount: recoveredState.toolCallHistory.length,
      }, { source: 'SessionPersistence' });

      this.log.info('会话已恢复', {
        sessionId: targetSessionId,
        eventsReplayed: recoveredState.eventsReplayed,
        conversationLength: recoveredState.conversationHistory.length,
        toolCallCount: recoveredState.toolCallHistory.length,
      });

      return recoveredState;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('恢复会话失败', { sessionId: targetSessionId, error: msg });
      return null;
    }
  }

  // ============ 会话列表 ============

  /**
   * 列出所有会话
   * 支持按状态过滤和数量限制
   */
  listSessions(options?: ListSessionsOptions): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const summaries: SessionSummary[] = [];

    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) {
          continue;
        }

        const metadataPath = path.join(this.sessionsDir, entry.name, METADATA_FILE);
        if (!fs.existsSync(metadataPath)) {
          continue;
        }

        try {
          const metadata: SessionMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
          const summary: SessionSummary = {
            id: metadata.id,
            startedAt: metadata.startedAt,
            endedAt: metadata.endedAt,
            durationMs: metadata.endedAt ? metadata.endedAt - metadata.startedAt : undefined,
            eventCount: metadata.eventCount,
            status: metadata.status,
            taskDescription: metadata.taskDescription,
          };

          // 状态过滤
          if (options?.status && summary.status !== options.status) {
            continue;
          }

          summaries.push(summary);
        } catch {
          // 跳过元数据损坏的会话
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('列出会话失败', { error: msg });
    }

    // 按开始时间降序排列
    summaries.sort((a, b) => b.startedAt - a.startedAt);

    // 数量限制
    if (options?.limit && options.limit > 0) {
      return summaries.slice(0, options.limit);
    }

    return summaries;
  }

  // ============ 会话导出 ============

  /**
   * 导出会话为指定格式
   * 支持 JSONL（原始格式）、Markdown、HTML
   */
  exportSession(sessionId: string, format: 'jsonl' | 'markdown' | 'html' = 'markdown'): string {
    const sessionDir = this.getSessionDir(sessionId);
    const eventsPath = path.join(sessionDir, EVENTS_FILE);

    if (!fs.existsSync(eventsPath)) {
      return `错误: 会话 ${sessionId} 的事件日志不存在`;
    }

    try {
      const content = fs.readFileSync(eventsPath, 'utf-8');
      const events: SessionEvent[] = content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((e): e is SessionEvent => e !== null);

      // 加载元数据
      const metadata = this.loadMetadata(sessionId);

      switch (format) {
        case 'jsonl':
          return this.exportAsJsonl(events);
        case 'markdown':
          return this.exportAsMarkdown(events, metadata);
        case 'html':
          return this.exportAsHtml(events, metadata);
        default:
          return this.exportAsMarkdown(events, metadata);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('导出会话失败', { sessionId, format, error: msg });
      return `导出失败: ${msg}`;
    }
  }

  // ============ 统计信息 ============

  /**
   * 获取模块统计信息
   */
  getStats(): {
    activeSessionId: string | null;
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    crashedSessions: number;
    currentSessionEventCount: number;
    sessionsDir: string;
  } {
    const allSessions = this.listSessions();
    return {
      activeSessionId: this.currentSessionId,
      totalSessions: allSessions.length,
      activeSessions: allSessions.filter(s => s.status === 'active').length,
      completedSessions: allSessions.filter(s => s.status === 'completed').length,
      crashedSessions: allSessions.filter(s => s.status === 'crashed').length,
      currentSessionEventCount: this.currentMetadata?.eventCount ?? 0,
      sessionsDir: this.sessionsDir,
    };
  }

  // ============ 工具定义 ============

  /**
   * 获取工具定义 — 注册到 Agent Loop
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'session_start',
        description: '启动新的会话。会话会记录所有事件到 JSONL 日志，支持崩溃后恢复。返回会话 ID。',
        parameters: {
          taskDescription: {
            type: 'string',
            description: '任务描述，用于标识会话目的',
            required: false,
          },
        },
        execute: (args) => {
          try {
            const sessionId = this.startSession({
              taskDescription: args.taskDescription as string | undefined,
            });
            return Promise.resolve(`✅ 会话已启动\n会话ID: ${sessionId}\n日志目录: ${this.getSessionDir(sessionId)}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 启动会话失败: ${msg}`);
          }
        },
      },
      {
        name: 'session_save',
        description: '保存当前 Agent 状态快照。包括对话历史、工具调用记录、当前计划和认知状态。用于崩溃恢复和断点续接。',
        parameters: {
          conversationHistory: {
            type: 'string',
            description: '对话历史的 JSON 字符串',
            required: false,
          },
          toolCallHistory: {
            type: 'string',
            description: '工具调用历史的 JSON 字符串',
            required: false,
          },
          currentPlan: {
            type: 'string',
            description: '当前执行计划的 JSON 字符串',
            required: false,
          },
          cognitiveState: {
            type: 'string',
            description: '认知状态的 JSON 字符串',
            required: false,
          },
        },
        execute: (args) => {
          if (!this.currentSessionId) {
            return Promise.resolve('❌ 没有活跃会话，请先使用 session_start 启动会话');
          }

          const state: Record<string, unknown> = {};

          // 解析对话历史
          if (args.conversationHistory) {
            try {
              state.conversationHistory = JSON.parse(args.conversationHistory as string);
            } catch { state.conversationHistory = args.conversationHistory; }
          }

          // 解析工具调用历史
          if (args.toolCallHistory) {
            try {
              state.toolCallHistory = JSON.parse(args.toolCallHistory as string);
            } catch { state.toolCallHistory = args.toolCallHistory; }
          }

          // 解析当前计划
          if (args.currentPlan) {
            try {
              state.lastPlan = JSON.parse(args.currentPlan as string);
            } catch { state.lastPlan = args.currentPlan; }
          }

          // 解析认知状态
          if (args.cognitiveState) {
            try {
              state.cognitiveState = JSON.parse(args.cognitiveState as string);
            } catch { state.cognitiveState = args.cognitiveState; }
          }

          const snapshotId = this.saveState(state);
          if (snapshotId) {
            return Promise.resolve(`✅ 状态快照已保存\n快照ID: ${snapshotId}\n会话ID: ${this.currentSessionId}`);
          }
          return Promise.resolve('❌ 保存状态快照失败');
        },
      },
      {
        name: 'session_recover',
        description: '恢复之前的会话。通过重放 JSONL 事件重建 Agent 状态。不指定 sessionId 时自动查找最近的未完成会话。',
        parameters: {
          sessionId: {
            type: 'string',
            description: '要恢复的会话 ID，不填则自动查找最近的未完成会话',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          const recovered = this.recoverSession(args.sessionId as string | undefined);
          if (!recovered) {
            return Promise.resolve('❌ 没有找到可恢复的会话');
          }

          const lines = [
            `✅ 会话已恢复`,
            `会话ID: ${recovered.sessionId}`,
            `重放事件数: ${recovered.eventsReplayed}`,
            `对话历史: ${recovered.conversationHistory.length} 条`,
            `工具调用: ${recovered.toolCallHistory.length} 次`,
            `恢复时间: ${new Date(recovered.recoveredAt).toLocaleString('zh-CN')}`,
          ];

          if (recovered.lastPlan) {
            lines.push(`当前计划: ${JSON.stringify(recovered.lastPlan).substring(0, 200)}`);
          }

          // 附加恢复的状态数据（供 Agent 解析使用）
          lines.push('');
          lines.push('--- 恢复数据 ---');
          lines.push(JSON.stringify({
            conversationHistory: recovered.conversationHistory,
            toolCallHistory: recovered.toolCallHistory,
            lastPlan: recovered.lastPlan,
            cognitiveState: recovered.cognitiveState,
          }));

          return Promise.resolve(lines.join('\n'));
        },
      },
      {
        name: 'session_list',
        description: '列出所有会话。可按状态过滤（active/completed/crashed），显示会话ID、开始时间、持续时长、事件数和状态。',
        parameters: {
          status: {
            type: 'string',
            description: '按状态过滤: active | completed | crashed',
            required: false,
          },
          limit: {
            type: 'number',
            description: '返回数量限制，默认10',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          const sessions = this.listSessions({
            status: args.status as 'active' | 'completed' | 'crashed' | undefined,
            limit: args.limit ? Number(args.limit) : 10,
          });

          if (sessions.length === 0) {
            return Promise.resolve('没有找到匹配的会话');
          }

          const lines = [`📋 会话列表 (${sessions.length} 条)\n`];
          lines.push('ID                                   | 开始时间            | 持续时长     | 事件数 | 状态');
          lines.push('-'.repeat(95));

          for (const s of sessions) {
            const startTime = new Date(s.startedAt).toLocaleString('zh-CN');
            const duration = s.durationMs
              ? this.formatDuration(s.durationMs)
              : '进行中';
            let statusEmoji: string;
            if (s.status === 'active') statusEmoji = '🟢';
            else if (s.status === 'completed') statusEmoji = '✅';
            else statusEmoji = '🔴';
            lines.push(
              `${s.id.padEnd(36)} | ${startTime.padEnd(19)} | ${duration.padEnd(12)} | ${String(s.eventCount).padEnd(6)} | ${statusEmoji} ${s.status}`
            );
            if (s.taskDescription) {
              lines.push(`  └─ ${s.taskDescription.substring(0, 80)}`);
            }
          }

          return Promise.resolve(lines.join('\n'));
        },
      },
      {
        name: 'session_export',
        description: '导出会话为可读格式。支持 markdown（默认）、jsonl（原始格式）、html 格式。',
        parameters: {
          sessionId: {
            type: 'string',
            description: '要导出的会话 ID',
            required: true,
          },
          format: {
            type: 'string',
            description: '导出格式: markdown | jsonl | html，默认 markdown',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          if (!args.sessionId) {
            return Promise.resolve('❌ 需要提供 sessionId 参数');
          }
          const format = (args.format as 'jsonl' | 'markdown' | 'html') || 'markdown';
          return Promise.resolve(this.exportSession(args.sessionId as string, format));
        },
      },
    ];
  }

  // ============ 私有方法 ============

  /** 获取会话目录路径 */
  private getSessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  /** 保存元数据到文件 */
  private saveMetadata(sessionId: string, metadata: SessionMetadata): void {
    const sessionDir = this.getSessionDir(sessionId);
    const metadataPath = path.join(sessionDir, METADATA_FILE);

    try {
      atomicWriteJsonSync(metadataPath, metadata);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('保存元数据失败', { sessionId, error: msg });
    }
  }

  /** 加载元数据 */
  private loadMetadata(sessionId: string): SessionMetadata | null {
    const metadataPath = path.join(this.getSessionDir(sessionId), METADATA_FILE);
    try {
      if (fs.existsSync(metadataPath)) {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('加载元数据失败', { sessionId, error: msg });
    }
    return null;
  }

  /** 更新会话状态 */
  private updateSessionStatus(sessionId: string, status: 'active' | 'completed' | 'crashed'): void {
    const metadata = this.loadMetadata(sessionId);
    if (metadata) {
      metadata.status = status;
      if (status === 'completed' || status === 'crashed') {
        metadata.endedAt = metadata.endedAt || Date.now();
      }
      this.saveMetadata(sessionId, metadata);
    }
  }

  /** 查找最近的未完成会话 */
  private findMostRecentIncompleteSession(): string | null {
    const sessions = this.listSessions({ status: 'active' });
    if (sessions.length > 0) {
      return sessions[0].id;
    }

    // 也检查 crashed 的会话
    const crashedSessions = this.listSessions({ status: 'crashed' });
    if (crashedSessions.length > 0) {
      return crashedSessions[0].id;
    }

    return null;
  }

  /**
   * 从工具调用历史中重建环境状态
   * 分析工具调用记录，提取打开的资源、工作目录、活跃工具等信息
   */
  private rebuildEnvironmentState(
    toolCallHistory: Array<{ name: string; args: Record<string, unknown>; result: string }>,
  ): RecoveredState['environmentState'] {
    const openResources: string[] = [];
    const activeTools: string[] = [];
    let workspaceRoot: string | undefined;
    let lastWorkingDirectory: string | undefined;

    for (const call of toolCallHistory) {
      // 记录活跃工具（最近5个）
      if (!activeTools.includes(call.name)) {
        activeTools.push(call.name);
        if (activeTools.length > 5) activeTools.shift();
      }

      // 从浏览器操作中提取打开的URL
      if (call.name === 'browser_operate' || call.name === 'web_fetch' || call.name === 'desktop_open') {
        const url = call.args.url as string || call.args.target as string;
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          if (!openResources.includes(url)) openResources.push(url);
        }
      }

      // 从文件操作中提取工作目录
      if (call.name === 'file_read' || call.name === 'file_write' || call.name === 'shell_execute') {
        const filePath = call.args.path as string || call.args.file as string || call.args.cwd as string;
        if (filePath) {
          const dir = path.dirname(filePath);
          if (dir && dir !== '.') lastWorkingDirectory = dir;
        }
      }

      // 从代码执行中提取工作区根目录
      if (call.name === 'code_execute' || call.name === 'shell_execute') {
        const cwd = call.args.cwd as string;
        if (cwd) workspaceRoot = cwd;
      }
    }

    return {
      openResources: openResources.slice(-10), // 最多记录10个资源
      workspaceRoot,
      activeTools,
      lastWorkingDirectory,
    };
  }

  /** 重放单个事件，更新恢复状态 */
  private replayEvent(event: SessionEvent, state: RecoveredState): void {
    switch (event.type) {
      case 'message': {
        const role = event.data.role as string;
        const content = event.data.content as string;
        if (role && content) {
          state.conversationHistory.push({ role, content });
        }
        break;
      }
      case 'tool_call': {
        const name = event.data.name as string;
        const args = (event.data.args as Record<string, unknown>) || {};
        if (name) {
          state.toolCallHistory.push({ name, args, result: '' });
        }
        break;
      }
      case 'tool_result': {
        const toolName = event.data.name as string;
        const result = event.data.result as string;
        // 更新最近一次同名工具调用的结果
        if (toolName && result) {
          for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
            if (state.toolCallHistory[i].name === toolName && !state.toolCallHistory[i].result) {
              state.toolCallHistory[i].result = result;
              break;
            }
          }
        }
        break;
      }
      case 'thinking': {
        // 思考事件也加入对话历史（标记为 assistant thinking）
        const content = event.data.content as string;
        if (content) {
          state.conversationHistory.push({ role: 'assistant', content: `[思考] ${content}` });
        }
        break;
      }
      case 'checkpoint': {
        // 检查点事件可能包含计划信息
        if (event.data.plan) {
          state.lastPlan = event.data.plan as Record<string, unknown>;
        }
        if (event.data.cognitiveState) {
          state.cognitiveState = event.data.cognitiveState as Record<string, unknown>;
        }
        break;
      }
      case 'error': {
        // 错误事件加入对话历史
        const errorMsg = event.data.message as string;
        if (errorMsg) {
          state.conversationHistory.push({ role: 'system', content: `[错误] ${errorMsg}` });
        }
        break;
      }
      case 'state_snapshot': {
        // 状态快照事件在恢复时已通过 loadLatestSnapshot 处理
        break;
      }
      case 'system': {
        // 系统事件一般不需要恢复
        break;
      }
    }
  }

  /** 获取快照文件列表 */
  private getSnapshotFiles(sessionId: string): string[] {
    const statesDir = path.join(this.getSessionDir(sessionId), STATES_DIR);
    if (!fs.existsSync(statesDir)) {
      return [];
    }

    try {
      return fs.readdirSync(statesDir)
        .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'))
        .sort();
    } catch {
      return [];
    }
  }

  /** 加载最新的状态快照 */
  private loadLatestSnapshot(sessionId: string): Record<string, unknown> | null {
    const snapshotFiles = this.getSnapshotFiles(sessionId);
    if (snapshotFiles.length === 0) {
      return null;
    }

    // 从最新的快照开始尝试加载
    for (let i = snapshotFiles.length - 1; i >= 0; i--) {
      const fileName = snapshotFiles[i];
      const filePath = path.join(this.getSessionDir(sessionId), STATES_DIR, fileName);

      try {
        if (fileName.endsWith('.json.gz')) {
          // 压缩快照：解压后解析
          const compressed = fs.readFileSync(filePath);
          const decompressed = zlib.gunzipSync(compressed);
          return JSON.parse(decompressed.toString('utf-8'));
        } else {
          // 普通快照：直接解析
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('加载快照失败，尝试上一个', { fileName, error: msg });
      }
    }

    return null;
  }

  /** 清理旧快照，保留最新的 MAX_SNAPSHOTS 个 */
  private cleanupOldSnapshots(sessionId: string): void {
    const snapshotFiles = this.getSnapshotFiles(sessionId);
    if (snapshotFiles.length <= MAX_SNAPSHOTS) {
      return;
    }

    const toDelete = snapshotFiles.slice(0, snapshotFiles.length - MAX_SNAPSHOTS);
    for (const fileName of toDelete) {
      const filePath = path.join(this.getSessionDir(sessionId), STATES_DIR, fileName);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 忽略删除失败
      }
    }

    this.log.debug('已清理旧快照', { sessionId, deletedCount: toDelete.length });
  }

  /** 格式化持续时间 */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60 * 1000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 60 * 60 * 1000) {
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      return `${minutes}m${seconds}s`;
    }
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h${minutes}m`;
  }

  // ============ 导出格式实现 ============

  /** 导出为 JSONL 格式（原始格式） */
  private exportAsJsonl(events: SessionEvent[]): string {
    return events.map(e => JSON.stringify(e)).join('\n');
  }

  /** 导出为 Markdown 格式 */
  private exportAsMarkdown(events: SessionEvent[], metadata: SessionMetadata | null): string {
    const lines: string[] = [];

    // 标题
    lines.push('# 会话导出');
    lines.push('');

    // 元数据
    if (metadata) {
      lines.push('## 会话信息');
      lines.push('');
      lines.push(`- **会话ID**: ${metadata.id}`);
      lines.push(`- **开始时间**: ${new Date(metadata.startedAt).toLocaleString('zh-CN')}`);
      if (metadata.endedAt) {
        lines.push(`- **结束时间**: ${new Date(metadata.endedAt).toLocaleString('zh-CN')}`);
        lines.push(`- **持续时长**: ${this.formatDuration(metadata.endedAt - metadata.startedAt)}`);
      }
      lines.push(`- **事件数量**: ${metadata.eventCount}`);
      lines.push(`- **状态**: ${metadata.status}`);
      if (metadata.taskDescription) {
        lines.push(`- **任务描述**: ${metadata.taskDescription}`);
      }
      lines.push('');
    }

    // 事件时间线
    lines.push('## 事件时间线');
    lines.push('');

    for (const event of events) {
      const time = new Date(event.timestamp).toLocaleString('zh-CN');
      const typeEmoji: Record<string, string> = {
        message: '💬',
        tool_call: '🔧',
        tool_result: '📋',
        thinking: '💭',
        error: '❌',
        state_snapshot: '📸',
        checkpoint: '🏁',
        system: '⚙️',
      };

      const emoji = typeEmoji[event.type] || '📌';
      lines.push(`### ${emoji} ${event.type} — ${time}`);
      lines.push('');

      switch (event.type) {
        case 'message': {
          const role = event.data.role as string;
          const content = event.data.content as string;
          lines.push(`**${role}**: ${content}`);
          break;
        }
        case 'tool_call': {
          lines.push(`**工具**: ${event.data.name}`);
          lines.push(`**参数**: \`\`\`json\n${JSON.stringify(event.data.args, null, 2)}\n\`\`\``);
          break;
        }
        case 'tool_result': {
          lines.push(`**工具**: ${event.data.name}`);
          const result = String(event.data.result || '');
          lines.push(`**结果**: \`\`\`\n${result.substring(0, 2000)}${result.length > 2000 ? '\n... (已截断)' : ''}\n\`\`\``);
          break;
        }
        case 'thinking': {
          lines.push(`${event.data.content}`);
          break;
        }
        case 'error': {
          lines.push(`**错误信息**: ${event.data.message}`);
          if (event.data.stack) {
            lines.push(`\`\`\`\n${event.data.stack}\n\`\`\``);
          }
          break;
        }
        case 'state_snapshot': {
          lines.push(`**快照ID**: ${event.data.snapshotId}`);
          lines.push(`**状态键**: ${JSON.stringify(event.data.stateKeys)}`);
          break;
        }
        case 'checkpoint': {
          if (event.data.plan) {
            lines.push(`**计划**: \`\`\`json\n${JSON.stringify(event.data.plan, null, 2)}\n\`\`\``);
          }
          break;
        }
        case 'system': {
          lines.push(`**动作**: ${event.data.action}`);
          if (event.data.status) {
            lines.push(`**状态**: ${event.data.status}`);
          }
          break;
        }
        default: {
          lines.push(`\`\`\`json\n${JSON.stringify(event.data, null, 2)}\n\`\`\``);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /** 导出为 HTML 格式 */
  private exportAsHtml(events: SessionEvent[], metadata: SessionMetadata | null): string {
    const escapeHtml = (str: string): string =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const lines: string[] = [];

    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="zh-CN">');
    lines.push('<head>');
    lines.push('<meta charset="UTF-8">');
    lines.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    lines.push('<title>会话导出</title>');
    lines.push('<style>');
    lines.push('body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }');
    lines.push('.header { background: #1a1a2e; color: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; }');
    lines.push('.header h1 { margin: 0 0 10px 0; }');
    lines.push('.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 14px; color: #ccc; }');
    lines.push('.event { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 12px; border-left: 4px solid #ddd; }');
    lines.push('.event.message { border-left-color: #4CAF50; }');
    lines.push('.event.tool_call { border-left-color: #2196F3; }');
    lines.push('.event.tool_result { border-left-color: #00BCD4; }');
    lines.push('.event.thinking { border-left-color: #9C27B0; }');
    lines.push('.event.error { border-left-color: #f44336; }');
    lines.push('.event.state_snapshot { border-left-color: #FF9800; }');
    lines.push('.event.checkpoint { border-left-color: #607D8B; }');
    lines.push('.event.system { border-left-color: #795548; }');
    lines.push('.event-type { font-weight: bold; font-size: 14px; color: #666; margin-bottom: 8px; }');
    lines.push('.event-time { font-size: 12px; color: #999; }');
    lines.push('.event-content { margin-top: 8px; }');
    lines.push('pre { background: #f8f8f8; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; }');
    lines.push('.role { font-weight: bold; color: #333; }');
    lines.push('</style>');
    lines.push('</head>');
    lines.push('<body>');

    // 头部
    lines.push('<div class="header">');
    lines.push('<h1>📋 会话导出</h1>');
    if (metadata) {
      lines.push('<div class="meta">');
      lines.push(`<span>会话ID: ${escapeHtml(metadata.id)}</span>`);
      lines.push(`<span>开始时间: ${new Date(metadata.startedAt).toLocaleString('zh-CN')}</span>`);
      if (metadata.endedAt) {
        lines.push(`<span>结束时间: ${new Date(metadata.endedAt).toLocaleString('zh-CN')}</span>`);
        lines.push(`<span>持续时长: ${this.formatDuration(metadata.endedAt - metadata.startedAt)}</span>`);
      }
      lines.push(`<span>事件数量: ${metadata.eventCount}</span>`);
      lines.push(`<span>状态: ${metadata.status}</span>`);
      if (metadata.taskDescription) {
        lines.push(`<span>任务: ${escapeHtml(metadata.taskDescription)}</span>`);
      }
      lines.push('</div>');
    }
    lines.push('</div>');

    // 事件列表
    for (const event of events) {
      const time = new Date(event.timestamp).toLocaleString('zh-CN');
      const typeEmoji: Record<string, string> = {
        message: '💬', tool_call: '🔧', tool_result: '📋',
        thinking: '💭', error: '❌', state_snapshot: '📸',
        checkpoint: '🏁', system: '⚙️',
      };
      const emoji = typeEmoji[event.type] || '📌';

      lines.push(`<div class="event ${escapeHtml(event.type)}">`);
      lines.push(`<div class="event-type">${emoji} ${escapeHtml(event.type)}</div>`);
      lines.push(`<div class="event-time">${escapeHtml(time)}</div>`);
      lines.push('<div class="event-content">');

      switch (event.type) {
        case 'message': {
          const role = escapeHtml(String(event.data.role || ''));
          const content = escapeHtml(String(event.data.content || ''));
          lines.push(`<span class="role">${role}:</span> ${content}`);
          break;
        }
        case 'tool_call': {
          lines.push(`<p><strong>工具:</strong> ${escapeHtml(String(event.data.name || ''))}</p>`);
          lines.push(`<pre>${escapeHtml(JSON.stringify(event.data.args, null, 2))}</pre>`);
          break;
        }
        case 'tool_result': {
          lines.push(`<p><strong>工具:</strong> ${escapeHtml(String(event.data.name || ''))}</p>`);
          const result = String(event.data.result || '');
          lines.push(`<pre>${escapeHtml(result.substring(0, 3000))}${result.length > 3000 ? '\n... (已截断)' : ''}</pre>`);
          break;
        }
        case 'thinking': {
          lines.push(`<p>${escapeHtml(String(event.data.content || ''))}</p>`);
          break;
        }
        case 'error': {
          lines.push(`<p style="color:#f44336"><strong>错误:</strong> ${escapeHtml(String(event.data.message || ''))}</p>`);
          break;
        }
        default: {
          lines.push(`<pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>`);
        }
      }

      lines.push('</div></div>');
    }

    lines.push('</body></html>');
    return lines.join('\n');
  }

  // ============ P1-5: Thread/Turn/Item 三原语（对标 Codex） ============

  /**
   * P1-5: Thread — 会话线程，支持 fork/resume/archive/rollback
   *
   * 对标 Codex 的 Thread/Turn/Item 三原语：
   * - Thread: 一个完整的对话线程
   * - Turn: 一次用户输入 + 助手响应的完整轮次
   * - Item: Turn 内的单个消息/工具调用/思考
   */
  private threads: Map<string, Thread> = new Map();
  private currentThreadId: string | null = null;
  /**
   * P0 资源消耗修复：线程持久化防抖 — 之前 addItem 每次调用都全量重写整个 thread JSON，
   * 100+ 轮会话线程增长至多 MB，每次工具调用都全量重写（I/O 放大）。
   * 现在用 200ms 防抖合并高频写入，critical 操作（create/complete/fork/rollback）仍立即写入。
   */
  private _persistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly PERSIST_DEBOUNCE_MS = 200;

  /** 创建新线程 */
  createThread(title?: string): string {
    const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const thread: Thread = {
      id: threadId,
      title: title || `Thread ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
      parentId: this.currentThreadId || undefined, // 支持分叉
      status: 'active',
    };
    this.threads.set(threadId, thread);
    this.currentThreadId = threadId;
    this.log.info('Thread 已创建', { threadId, title: thread.title });
    // P1-5: 自动持久化 — 创建后立即写入磁盘，防止崩溃丢失
    this._persistThread(threadId);
    return threadId;
  }

  /** 获取当前线程 ID */
  getCurrentThread(): string | null {
    return this.currentThreadId;
  }

  /** 切换到指定线程（resume） */
  resumeThread(threadId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) {
      this.log.warn('Thread 不存在', { threadId });
      return false;
    }
    thread.status = 'active';
    thread.updatedAt = Date.now();
    this.currentThreadId = threadId;
    this.log.info('Thread 已恢复', { threadId, turnCount: thread.turns.length });
    // P1-5: 自动持久化 — 状态变更后写入磁盘
    this._persistThread(threadId);
    return true;
  }

  /**
   * P1-5: Fork — 从指定 Turn 分叉新线程
   *
   * 对标 Codex 的 fork：从历史某个点创建分叉，不影响主线程
   */
  forkThread(sourceThreadId: string, fromTurnIndex: number, title?: string): string | null {
    const sourceThread = this.threads.get(sourceThreadId);
    if (!sourceThread) {
      this.log.warn('源 Thread 不存在', { sourceThreadId });
      return null;
    }
    if (fromTurnIndex < 0 || fromTurnIndex >= sourceThread.turns.length) {
      this.log.warn('Turn 索引越界', { fromTurnIndex, turnCount: sourceThread.turns.length });
      return null;
    }

    // 创建新线程，复制指定 Turn 之前的内容
    const newThreadId = this.createThread(title || `Fork from ${sourceThreadId}`);
    const newThread = this.threads.get(newThreadId)!;
    newThread.parentId = sourceThreadId;
    newThread.forkPoint = fromTurnIndex;

    // 复制 Turn 0 到 fromTurnIndex（含）
    for (let i = 0; i <= fromTurnIndex; i++) {
      newThread.turns.push({ ...sourceThread.turns[i], items: [...sourceThread.turns[i].items] });
    }

    this.log.info('Thread 已分叉', {
      sourceThreadId,
      newThreadId,
      fromTurnIndex,
      copiedTurns: newThread.turns.length,
    });
    // P1-5: 自动持久化 — fork 后立即持久化新线程，并记录事务日志
    this._persistThread(newThreadId);
    this._appendTransactionLog('fork', newThreadId, {
      sourceThreadId,
      fromTurnIndex,
      copiedTurns: newThread.turns.length,
    });
    return newThreadId;
  }

  /**
   * P1-5: Rollback — 回滚到指定 Turn
   *
   * 对标 Codex 的 rollback：移除指定 Turn 之后的所有内容
   */
  rollbackThread(threadId: string, toTurnIndex: number): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) return false;
    if (toTurnIndex < 0 || toTurnIndex >= thread.turns.length) return false;

    const removedTurnCount = thread.turns.length - (toTurnIndex + 1);
    // 移除 toTurnIndex 之后的所有 Turn
    thread.turns = thread.turns.slice(0, toTurnIndex + 1);
    thread.updatedAt = Date.now();
    this.log.info('Thread 已回滚', { threadId, toTurnIndex, remainingTurns: thread.turns.length });
    // P1-5: 自动持久化 — rollback 后立即写入磁盘，并记录事务日志（便于审计/恢复）
    this._persistThread(threadId);
    this._appendTransactionLog('rollback', threadId, {
      toTurnIndex,
      removedTurnCount,
      remainingTurns: thread.turns.length,
    });
    return true;
  }

  /** 归档线程 */
  archiveThread(threadId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) return false;
    thread.status = 'archived';
    thread.updatedAt = Date.now();
    this.log.info('Thread 已归档', { threadId });
    // P1-5: 自动持久化 — 状态变更后写入磁盘
    this._persistThread(threadId);
    return true;
  }

  /** 添加 Turn 到当前线程 */
  addTurn(userInput: string): string | null {
    if (!this.currentThreadId) {
      this.createThread();
    }
    const thread = this.threads.get(this.currentThreadId!);
    if (!thread) return null;

    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const turn: Turn = {
      id: turnId,
      threadId: thread.id,
      userInput,
      items: [],
      startedAt: Date.now(),
      status: 'active',
    };
    thread.turns.push(turn);
    thread.updatedAt = Date.now();
    // P1-5: 自动持久化 — 新 Turn 创建后立即写入磁盘
    this._persistThread(thread.id);
    return turnId;
  }

  /** 添加 Item 到当前 Turn */
  addItem(turnId: string, item: Omit<TurnItem, 'id' | 'timestamp'>): boolean {
    for (const thread of this.threads.values()) {
      const turn = thread.turns.find(t => t.id === turnId);
      if (turn) {
        const itemWithId: TurnItem = {
          ...item,
          id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
        };
        turn.items.push(itemWithId);
        thread.updatedAt = Date.now();
        // P0 资源消耗修复：addItem 是高频调用点（每个工具调用触发），
        // 改用防抖版本避免 I/O 放大。200ms 内的多次 addItem 合并为一次写入。
        // 关键操作（turn complete / thread close）会调用 flushPendingPersists 强制落盘。
        this._persistThreadDebounced(thread.id);
        return true;
      }
    }
    return false;
  }

  /** 完成 Turn */
  completeTurn(turnId: string, status: 'completed' | 'failed' = 'completed'): boolean {
    for (const thread of this.threads.values()) {
      const turn = thread.turns.find(t => t.id === turnId);
      if (turn) {
        turn.status = status;
        turn.completedAt = Date.now();
        thread.updatedAt = Date.now();
        // P0 资源消耗修复：取消 pending 防抖，立即写入完整状态（含 turn 完成标记）
        const pending = this._persistTimers.get(thread.id);
        if (pending) { clearTimeout(pending); this._persistTimers.delete(thread.id); }
        this._persistThread(thread.id);
        return true;
      }
    }
    return false;
  }

  /** 获取线程信息 */
  getThread(threadId: string): Thread | null {
    return this.threads.get(threadId) || null;
  }

  /** 列出所有线程 */
  listThreads(): Array<{
    id: string;
    title: string;
    turnCount: number;
    status: string;
    createdAt: number;
    updatedAt: number;
    parentId?: string;
  }> {
    return [...this.threads.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(t => ({
        id: t.id,
        title: t.title,
        turnCount: t.turns.length,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        parentId: t.parentId,
      }));
  }

  /** 持久化线程到文件 */
  persistThreads(): boolean {
    try {
      const threadsDir = path.join(this.sessionsDir, 'threads');
      fs.mkdirSync(threadsDir, { recursive: true });
      for (const thread of this.threads.values()) {
        const filePath = path.join(threadsDir, `${thread.id}.json`);
        atomicWriteJsonSync(filePath, thread);
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化 Threads 失败', { error: msg });
      return false;
    }
  }

  /**
   * P1-5: 持久化单个线程 — 比 persistThreads() 高效，仅写入受影响的线程
   * 用于自动持久化钩子（addTurn/addItem/fork/rollback 等状态变更后调用）
   *
   * @param threadId 要持久化的线程 ID
   * @returns 是否成功
   */
  private _persistThread(threadId: string): boolean {
    try {
      const thread = this.threads.get(threadId);
      if (!thread) return false;
      const threadsDir = path.join(this.sessionsDir, 'threads');
      fs.mkdirSync(threadsDir, { recursive: true });
      const filePath = path.join(threadsDir, `${threadId}.json`);
      // 原子写入：先写 .tmp 再 rename，防止写入过程中崩溃导致文件损坏
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(thread, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('单线程持久化失败', { threadId, error: msg });
      return false;
    }
  }

  /**
   * P0 资源消耗修复：防抖版 _persistThread — 用于高频调用点（addItem）
   * 200ms 内的多次调用合并为一次磁盘写入，避免 I/O 放大。
   * 关键操作（create/complete/fork/rollback）仍调用 _persistThread 立即写入。
   */
  private _persistThreadDebounced(threadId: string): void {
    const existing = this._persistTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._persistTimers.delete(threadId);
      this._persistThread(threadId);
    }, SessionPersistence.PERSIST_DEBOUNCE_MS);
    this._persistTimers.set(threadId, timer);
  }

  /** P0 资源消耗修复：强制 flush 所有 pending 防抖写入（dispose 时调用） */
  flushPendingPersists(): void {
    for (const [threadId, timer] of this._persistTimers) {
      clearTimeout(timer);
      this._persistThread(threadId);
    }
    this._persistTimers.clear();
  }

  /**
   * P1-5: 追加事务日志 — fork/rollback 等关键操作记录到 JSONL 日志
   * 用于审计、故障恢复、操作回放
   *
   * @param op 操作类型（fork/rollback/archive/create/resume）
   * @param threadId 目标线程 ID
   * @param details 操作详情
   */
  private _appendTransactionLog(
    op: 'fork' | 'rollback' | 'archive' | 'create' | 'resume',
    threadId: string,
    details: Record<string, unknown>,
  ): void {
    try {
      const threadsDir = path.join(this.sessionsDir, 'threads');
      fs.mkdirSync(threadsDir, { recursive: true });
      const logPath = path.join(threadsDir, 'transactions.jsonl');
      const entry = JSON.stringify({
        timestamp: Date.now(),
        op,
        threadId,
        details,
      });
      fs.appendFileSync(logPath, entry + '\n', 'utf-8');
    } catch (err: unknown) {
      // 事务日志失败不应影响主流程
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('事务日志写入失败', { op, threadId, error: msg });
    }
  }

  /** 从文件加载线程 */
  loadThreads(): number {
    try {
      const threadsDir = path.join(this.sessionsDir, 'threads');
      if (!fs.existsSync(threadsDir)) return 0;
      let count = 0;
      for (const file of fs.readdirSync(threadsDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(threadsDir, file), 'utf-8'));
          this.threads.set(data.id, data);
          count++;
        } catch {}
      }
      this.log.info('Threads 已加载', { count });
      return count;
    } catch {
      return 0;
    }
  }
}

// ============ P1-5: Thread/Turn/Item 类型定义 ============

/** Thread — 会话线程 */
export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
  /** 父线程 ID（分叉时记录） */
  parentId?: string;
  /** 分叉点（Turn 索引） */
  forkPoint?: number;
  status: 'active' | 'archived' | 'completed';
}

/** Turn — 一次用户输入 + 助手响应的完整轮次 */
export interface Turn {
  id: string;
  threadId: string;
  userInput: string;
  items: TurnItem[];
  startedAt: number;
  completedAt?: number;
  status: 'active' | 'completed' | 'failed';
}

/** Item — Turn 内的单个消息/工具调用/思考 */
export interface TurnItem {
  id: string;
  timestamp: number;
  type: 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'error';
  role?: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  metadata?: Record<string, unknown>;
}
