/**
 * CollaborationEngine — 协作能力
 *
 * v20.0 §5.3 协作能力的核心实现。
 *
 * 四大能力：
 * 1. 团队管理 — 注册/注销团队成员，维护在线状态
 * 2. 共享会话 — 多用户共享会话，实时消息广播（通过 EventBus）
 * 3. 任务派发 — 创建/分配/更新/完成团队任务，支持优先级与截止时间
 * 4. 团队知识库 — 共享知识条目，支持标签/贡献者/权限
 *
 * 设计原则：
 * - 松耦合：通过 CollaborationEventListener 回调接口对接 WebSocket 适配层
 *   （实际 WebSocket 服务器在 web-server 层接入，本模块只负责业务逻辑 + EventBus 事件）
 * - 数据本地持久化：所有团队/会话/任务/知识库数据存储在 ~/.duan/collaboration/
 * - 实时事件：通过 EventBus 广播 collab.* 事件，由 web-server 层转发给 WebSocket 客户端
 * - 隐私感知：共享知识库支持 visibility 字段（private/team/public）
 *
 * 数据存储：~/.duan/collaboration/
 *   - members.json    — 团队成员
 *   - sessions.json   — 共享会话
 *   - messages.json   — 会话消息（按 session 分组）
 *   - tasks.json      — 任务派发
 *   - knowledge.json  — 共享知识库
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 团队成员角色 */
export type MemberRole = 'admin' | 'developer' | 'reviewer' | 'viewer' | 'agent';

/** 团队成员在线状态 */
export type MemberStatus = 'online' | 'offline' | 'away' | 'busy';

/** 团队成员 */
export interface TeamMember {
  id: string;           // 成员唯一 ID
  name: string;         // 显示名
  role: MemberRole;     // 角色
  status: MemberStatus; // 在线状态
  avatar?: string;      // 头像 URL
  email?: string;       // 邮箱
  joinedAt: number;     // 加入时间
  lastSeenAt: number;   // 最后在线时间
  isAgent: boolean;     // 是否为 AI Agent（区别于真人）
}

/** 共享会话 */
export interface SharedSession {
  id: string;
  name: string;
  topic?: string;
  ownerId: string;           // 创建者成员 ID
  memberIds: string[];       // 参与成员 ID 列表
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  closed: boolean;           // 是否已关闭
}

/** 会话消息 */
export interface SessionMessage {
  id: string;
  sessionId: string;
  senderId: string;          // 发送者成员 ID
  content: string;           // 消息内容
  type: 'text' | 'system' | 'file' | 'task';
  sentAt: number;
  metadata?: Record<string, unknown>;
}

/** 任务状态 */
export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';

/** 任务优先级 */
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** 团队任务 */
export interface TeamTask {
  id: string;
  title: string;
  description: string;
  creatorId: string;         // 创建者成员 ID
  assigneeId?: string;       // 被分配者成员 ID（未分配时 undefined）
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: number;
  updatedAt: number;
  dueAt?: number;            // 截止时间
  completedAt?: number;      // 完成时间
  tags: string[];
  relatedSessionId?: string; // 关联会话
  subTasks: Array<{ id: string; title: string; done: boolean }>;
}

/** 知识库条目可见性 */
export type KnowledgeVisibility = 'private' | 'team' | 'public';

/** 团队知识库条目 */
export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  contributorId: string;     // 贡献者成员 ID
  tags: string[];
  visibility: KnowledgeVisibility;
  createdAt: number;
  updatedAt: number;
  views: number;
  likes: number;
  category: string;
}

/** 协作事件监听器（对接 WebSocket 适配层） */
export interface CollaborationEventListener {
  onMemberJoin?(member: TeamMember): void;
  onMemberLeave?(memberId: string): void;
  onMemberStatusChange?(memberId: string, status: MemberStatus): void;
  onSessionMessage?(message: SessionMessage): void;
  onSessionCreated?(session: SharedSession): void;
  onTaskAssigned?(task: TeamTask): void;
  onTaskUpdated?(task: TeamTask): void;
  onKnowledgeShared?(entry: KnowledgeEntry): void;
}

/** 协作引擎统计 */
export interface CollaborationStats {
  memberCount: number;
  onlineMemberCount: number;
  agentMemberCount: number;
  sessionCount: number;
  activeSessionCount: number;
  messageCount: number;
  taskCount: number;
  pendingTaskCount: number;
  inProgressTaskCount: number;
  completedTaskCount: number;
  knowledgeEntryCount: number;
  publicKnowledgeCount: number;
}

// ============ 主类 ============

export class CollaborationEngine {
  private static _instance: CollaborationEngine | null = null;

  private dataDir: string;
  private members: Map<string, TeamMember> = new Map();
  private sessions: Map<string, SharedSession> = new Map();
  private messages: SessionMessage[] = []; // 按时间顺序
  private tasks: Map<string, TeamTask> = new Map();
  private knowledge: Map<string, KnowledgeEntry> = new Map();

  private listeners: Set<CollaborationEventListener> = new Set();
  private initialized = false;

  /**
   * 构造函数
   * @param dataDir 数据目录，默认 ~/.duan/collaboration/
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? duanPath('collaboration');
  }

  /** 获取单例 */
  static getInstance(): CollaborationEngine {
    if (!CollaborationEngine._instance) {
      CollaborationEngine._instance = new CollaborationEngine();
    }
    return CollaborationEngine._instance;
  }

  /** 重置单例（仅供测试） */
  static _resetInstance(): void {
    CollaborationEngine._instance = null;
  }

  /** 初始化：创建目录 + 加载数据 */
  initialize(): void {
    if (this.initialized) return;

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.loadAll();
    this.initialized = true;
    logger.info('CollaborationEngine initialized', {
      dataDir: this.dataDir,
      members: this.members.size,
      sessions: this.sessions.size,
      messages: this.messages.length,
      tasks: this.tasks.size,
      knowledge: this.knowledge.size,
    });
  }

  /** 注册事件监听器 */
  addListener(listener: CollaborationEventListener): void {
    this.listeners.add(listener);
  }

  /** 注销事件监听器 */
  removeListener(listener: CollaborationEventListener): void {
    this.listeners.delete(listener);
  }

  // ============ 团队成员管理 ============

  /** 注册团队成员 */
  registerMember(input: Omit<TeamMember, 'id' | 'joinedAt' | 'lastSeenAt'> & { id?: string }): TeamMember {
    const now = Date.now();
    const id = input.id ?? `member-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.members.get(id);
    if (existing) {
      throw new Error(`Member already exists: ${id}`);
    }
    const member: TeamMember = {
      ...input,
      id,
      joinedAt: now,
      lastSeenAt: now,
    };
    this.members.set(id, member);
    this.saveMembers();
    logger.info('Member registered', { id, name: member.name, role: member.role });

    // 通知监听器 + EventBus
    for (const l of this.listeners) {
      try { l.onMemberJoin?.(member); } catch { /* 忽略监听器错误 */ }
    }
    void EventBus.getInstance().emit('collab.member.join', member);

    return member;
  }

  /** 注销团队成员 */
  unregisterMember(id: string): boolean {
    const member = this.members.get(id);
    if (!member) return false;
    this.members.delete(id);
    this.saveMembers();

    // 从所有会话中移除
    for (const session of this.sessions.values()) {
      session.memberIds = session.memberIds.filter(mid => mid !== id);
    }
    this.saveSessions();

    for (const l of this.listeners) {
      try { l.onMemberLeave?.(id); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.member.leave', { memberId: id });
    logger.info('Member unregistered', { id });
    return true;
  }

  /** 更新成员状态 */
  updateMemberStatus(id: string, status: MemberStatus): boolean {
    const member = this.members.get(id);
    if (!member) return false;
    member.status = status;
    member.lastSeenAt = Date.now();
    this.saveMembers();

    for (const l of this.listeners) {
      try { l.onMemberStatusChange?.(id, status); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.member.status', { memberId: id, status });
    return true;
  }

  /** 获取成员 */
  getMember(id: string): TeamMember | null {
    return this.members.get(id) ?? null;
  }

  /** 列出所有成员 */
  listMembers(): TeamMember[] {
    return Array.from(this.members.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** 列出在线成员 */
  listOnlineMembers(): TeamMember[] {
    return this.listMembers().filter(m => m.status === 'online');
  }

  // ============ 共享会话 ============

  /** 创建共享会话 */
  createSession(name: string, ownerId: string, memberIds: string[] = [], topic?: string): SharedSession {
    if (!this.members.has(ownerId)) {
      throw new Error(`Owner not found: ${ownerId}`);
    }
    const now = Date.now();
    const id = `session-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const allMemberIds = Array.from(new Set([ownerId, ...memberIds]));
    const session: SharedSession = {
      id,
      name,
      topic,
      ownerId,
      memberIds: allMemberIds,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      closed: false,
    };
    this.sessions.set(id, session);
    this.saveSessions();
    logger.info('Session created', { id, name, ownerId, members: allMemberIds.length });

    for (const l of this.listeners) {
      try { l.onSessionCreated?.(session); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.session.created', session);
    return session;
  }

  /** 关闭会话 */
  closeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.closed = true;
    this.saveSessions();
    void EventBus.getInstance().emit('collab.session.closed', { sessionId: id });
    return true;
  }

  /** 邀请成员加入会话 */
  inviteToSession(sessionId: string, memberId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!this.members.has(memberId)) return false;
    if (session.memberIds.includes(memberId)) return true; // 已在会话中
    session.memberIds.push(memberId);
    session.lastActivityAt = Date.now();
    this.saveSessions();
    void EventBus.getInstance().emit('collab.session.member_join', { sessionId, memberId });
    return true;
  }

  /** 列出会话 */
  listSessions(includeClosed = false): SharedSession[] {
    const all = Array.from(this.sessions.values());
    return (includeClosed ? all : all.filter(s => !s.closed))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** 获取会话 */
  getSession(id: string): SharedSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** 发送会话消息 */
  sendMessage(sessionId: string, senderId: string, content: string, type: SessionMessage['type'] = 'text', metadata?: Record<string, unknown>): SessionMessage {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.closed) throw new Error(`Session is closed: ${sessionId}`);
    if (!session.memberIds.includes(senderId)) {
      throw new Error(`Sender ${senderId} is not a member of session ${sessionId}`);
    }

    const now = Date.now();
    const message: SessionMessage = {
      id: `msg-${now}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      senderId,
      content,
      type,
      sentAt: now,
      metadata,
    };
    this.messages.push(message);
    session.messageCount++;
    session.lastActivityAt = now;
    // 每条消息立即落盘（单机协作场景消息量不大，可靠性优先于性能）
    this.saveMessages();
    this.saveSessions();

    for (const l of this.listeners) {
      try { l.onSessionMessage?.(message); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.session.message', message);
    return message;
  }

  /** 获取会话消息 */
  getSessionMessages(sessionId: string, limit = 50, before?: number): SessionMessage[] {
    let filtered = this.messages.filter(m => m.sessionId === sessionId);
    if (before) {
      filtered = filtered.filter(m => m.sentAt < before);
    }
    return filtered.slice(-limit).reverse();
  }

  // ============ 任务派发 ============

  /** 创建任务 */
  createTask(input: {
    title: string;
    description: string;
    creatorId: string;
    assigneeId?: string;
    priority?: TaskPriority;
    dueAt?: number;
    tags?: string[];
    relatedSessionId?: string;
    subTasks?: Array<{ title: string }>;
  }): TeamTask {
    if (!this.members.has(input.creatorId)) {
      throw new Error(`Creator not found: ${input.creatorId}`);
    }
    if (input.assigneeId && !this.members.has(input.assigneeId)) {
      throw new Error(`Assignee not found: ${input.assigneeId}`);
    }
    const now = Date.now();
    const id = `task-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const task: TeamTask = {
      id,
      title: input.title,
      description: input.description,
      creatorId: input.creatorId,
      assigneeId: input.assigneeId,
      status: input.assigneeId ? 'assigned' : 'pending',
      priority: input.priority ?? 'medium',
      createdAt: now,
      updatedAt: now,
      dueAt: input.dueAt,
      tags: input.tags ?? [],
      relatedSessionId: input.relatedSessionId,
      subTasks: (input.subTasks ?? []).map((st, i) => ({
        id: `${id}-sub-${i}`,
        title: st.title,
        done: false,
      })),
    };
    this.tasks.set(id, task);
    this.saveTasks();
    logger.info('Task created', { id, title: task.title, assignee: task.assigneeId });

    if (task.assigneeId) {
      for (const l of this.listeners) {
        try { l.onTaskAssigned?.(task); } catch { /* 忽略 */ }
      }
      void EventBus.getInstance().emit('collab.task.assigned', task);
    }
    return task;
  }

  /** 分配任务 */
  assignTask(taskId: string, assigneeId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (!this.members.has(assigneeId)) return false;
    task.assigneeId = assigneeId;
    if (task.status === 'pending') {
      task.status = 'assigned';
    }
    task.updatedAt = Date.now();
    this.saveTasks();

    for (const l of this.listeners) {
      try { l.onTaskAssigned?.(task); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.task.assigned', task);
    return true;
  }

  /** 更新任务状态 */
  updateTaskStatus(taskId: string, status: TaskStatus): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.status = status;
    task.updatedAt = Date.now();
    if (status === 'completed') {
      task.completedAt = Date.now();
    }
    this.saveTasks();

    for (const l of this.listeners) {
      try { l.onTaskUpdated?.(task); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.task.updated', task);
    return true;
  }

  /** 切换子任务完成状态 */
  toggleSubTask(taskId: string, subTaskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const sub = task.subTasks.find(s => s.id === subTaskId);
    if (!sub) return false;
    sub.done = !sub.done;
    task.updatedAt = Date.now();
    this.saveTasks();
    return true;
  }

  /** 获取任务 */
  getTask(id: string): TeamTask | null {
    return this.tasks.get(id) ?? null;
  }

  /** 列出任务 */
  listTasks(filter?: { assigneeId?: string; status?: TaskStatus; priority?: TaskPriority }): TeamTask[] {
    let list = Array.from(this.tasks.values());
    if (filter?.assigneeId) {
      list = list.filter(t => t.assigneeId === filter.assigneeId);
    }
    if (filter?.status) {
      list = list.filter(t => t.status === filter.status);
    }
    if (filter?.priority) {
      list = list.filter(t => t.priority === filter.priority);
    }
    return list.sort((a, b) => {
      // 按优先级降序 + 创建时间升序
      const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.createdAt - b.createdAt;
    });
  }

  /** 删除任务 */
  deleteTask(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) this.saveTasks();
    return existed;
  }

  // ============ 团队知识库 ============

  /** 共享知识条目 */
  shareKnowledge(input: {
    title: string;
    content: string;
    contributorId: string;
    tags?: string[];
    visibility?: KnowledgeVisibility;
    category?: string;
  }): KnowledgeEntry {
    if (!this.members.has(input.contributorId)) {
      throw new Error(`Contributor not found: ${input.contributorId}`);
    }
    const now = Date.now();
    const id = `kb-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: KnowledgeEntry = {
      id,
      title: input.title,
      content: input.content,
      contributorId: input.contributorId,
      tags: input.tags ?? [],
      visibility: input.visibility ?? 'team',
      createdAt: now,
      updatedAt: now,
      views: 0,
      likes: 0,
      category: input.category ?? 'general',
    };
    this.knowledge.set(id, entry);
    this.saveKnowledge();
    logger.info('Knowledge shared', { id, title: entry.title, visibility: entry.visibility });

    for (const l of this.listeners) {
      try { l.onKnowledgeShared?.(entry); } catch { /* 忽略 */ }
    }
    void EventBus.getInstance().emit('collab.knowledge.shared', entry);
    return entry;
  }

  /** 查询知识库 */
  queryKnowledge(query: string, limit = 10): KnowledgeEntry[] {
    const q = query.toLowerCase();
    const scored: Array<{ entry: KnowledgeEntry; score: number }> = [];
    for (const entry of this.knowledge.values()) {
      let score = 0;
      const title = entry.title.toLowerCase();
      const content = entry.content.toLowerCase();
      if (title.includes(q)) score += 5;
      if (content.includes(q)) score += 3;
      for (const tag of entry.tags) {
        if (tag.toLowerCase().includes(q)) score += 2;
      }
      if (entry.category.toLowerCase().includes(q)) score += 1;
      if (score > 0) scored.push({ entry, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  /** 获取知识条目 */
  getKnowledge(id: string): KnowledgeEntry | null {
    const entry = this.knowledge.get(id);
    if (entry) {
      entry.views++;
      this.saveKnowledge();
    }
    return entry ?? null;
  }

  /** 点赞知识条目 */
  likeKnowledge(id: string): boolean {
    const entry = this.knowledge.get(id);
    if (!entry) return false;
    entry.likes++;
    this.saveKnowledge();
    return true;
  }

  /** 列出知识条目 */
  listKnowledge(filter?: { visibility?: KnowledgeVisibility; contributorId?: string; category?: string }): KnowledgeEntry[] {
    let list = Array.from(this.knowledge.values());
    if (filter?.visibility) {
      list = list.filter(e => e.visibility === filter.visibility);
    }
    if (filter?.contributorId) {
      list = list.filter(e => e.contributorId === filter.contributorId);
    }
    if (filter?.category) {
      list = list.filter(e => e.category === filter.category);
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 删除知识条目 */
  deleteKnowledge(id: string): boolean {
    const existed = this.knowledge.delete(id);
    if (existed) this.saveKnowledge();
    return existed;
  }

  // ============ 持久化 ============

  private saveMembers(): void {
    atomicWriteJsonSync(path.join(this.dataDir, 'members.json'), Array.from(this.members.values()));
  }

  private saveSessions(): void {
    atomicWriteJsonSync(path.join(this.dataDir, 'sessions.json'), Array.from(this.sessions.values()));
  }

  private saveMessages(): void {
    atomicWriteJsonSync(path.join(this.dataDir, 'messages.json'), this.messages);
  }

  private saveTasks(): void {
    atomicWriteJsonSync(path.join(this.dataDir, 'tasks.json'), Array.from(this.tasks.values()));
  }

  private saveKnowledge(): void {
    atomicWriteJsonSync(path.join(this.dataDir, 'knowledge.json'), Array.from(this.knowledge.values()));
  }

  private loadAll(): void {
    const tryLoad = <T>(filename: string): T[] => {
      const filePath = path.join(this.dataDir, filename);
      if (!fs.existsSync(filePath)) return [];
      try {
        const arr = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return Array.isArray(arr) ? arr as T[] : [];
      } catch (err) {
        logger.warn(`Failed to load ${filename}`, { error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    };

    for (const m of tryLoad<TeamMember>('members.json')) {
      if (m && typeof m.id === 'string') this.members.set(m.id, m);
    }
    for (const s of tryLoad<SharedSession>('sessions.json')) {
      if (s && typeof s.id === 'string') this.sessions.set(s.id, s);
    }
    const msgs = tryLoad<SessionMessage>('messages.json');
    this.messages = msgs.filter(m => m && typeof m.id === 'string');
    for (const t of tryLoad<TeamTask>('tasks.json')) {
      if (t && typeof t.id === 'string') this.tasks.set(t.id, t);
    }
    for (const k of tryLoad<KnowledgeEntry>('knowledge.json')) {
      if (k && typeof k.id === 'string') this.knowledge.set(k.id, k);
    }
  }

  // ============ 统计 ============

  getStats(): CollaborationStats {
    let online = 0, agents = 0;
    for (const m of this.members.values()) {
      if (m.status === 'online') online++;
      if (m.isAgent) agents++;
    }
    let active = 0;
    for (const s of this.sessions.values()) {
      if (!s.closed) active++;
    }
    let pending = 0, inProgress = 0, completed = 0;
    for (const t of this.tasks.values()) {
      switch (t.status) {
        case 'pending': case 'assigned': pending++; break;
        case 'in_progress': inProgress++; break;
        case 'completed': completed++; break;
      }
    }
    let publicKb = 0;
    for (const k of this.knowledge.values()) {
      if (k.visibility === 'public') publicKb++;
    }
    return {
      memberCount: this.members.size,
      onlineMemberCount: online,
      agentMemberCount: agents,
      sessionCount: this.sessions.size,
      activeSessionCount: active,
      messageCount: this.messages.length,
      taskCount: this.tasks.size,
      pendingTaskCount: pending,
      inProgressTaskCount: inProgress,
      completedTaskCount: completed,
      knowledgeEntryCount: this.knowledge.size,
      publicKnowledgeCount: publicKb,
    };
  }

  // ============ LLM 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'collab_team_register',
        description: '注册团队成员（支持真人或 AI Agent，含角色/状态/邮箱）',
        parameters: {
          name: { type: 'string', description: '成员显示名', required: true },
          role: { type: 'string', description: '角色：admin | developer | reviewer | viewer | agent', required: true },
          isAgent: { type: 'boolean', description: '是否为 AI Agent，默认 false', required: false },
          email: { type: 'string', description: '邮箱（可选）', required: false },
          avatar: { type: 'string', description: '头像 URL（可选）', required: false },
        },
        readOnly: false,
        execute: async (args: { name: string; role: MemberRole; isAgent?: boolean; email?: string; avatar?: string }) => {
          try {
            const member = this.registerMember({
              name: args.name,
              role: args.role,
              status: 'online',
              isAgent: args.isAgent ?? false,
              email: args.email,
              avatar: args.avatar,
            });
            return JSON.stringify(member);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      {
        name: 'collab_team_list',
        description: '列出团队成员（含在线状态/角色/最后在线时间）',
        parameters: {
          onlineOnly: { type: 'boolean', description: '只列出在线成员，默认 false', required: false },
        },
        readOnly: true,
        execute: async (args: { onlineOnly?: boolean }) => {
          const list = args.onlineOnly ? this.listOnlineMembers() : this.listMembers();
          return JSON.stringify(list.map(m => ({
            id: m.id,
            name: m.name,
            role: m.role,
            status: m.status,
            isAgent: m.isAgent,
            lastSeenAt: m.lastSeenAt,
          })));
        },
      },
      {
        name: 'collab_session_create',
        description: '创建共享会话（多用户实时协作，含主题/初始成员）',
        parameters: {
          name: { type: 'string', description: '会话名称', required: true },
          ownerId: { type: 'string', description: '创建者成员 ID', required: true },
          memberIds: { type: 'array', description: '初始成员 ID 列表', required: false },
          topic: { type: 'string', description: '会话主题', required: false },
        },
        readOnly: false,
        execute: async (args: { name: string; ownerId: string; memberIds?: string[]; topic?: string }) => {
          try {
            const session = this.createSession(args.name, args.ownerId, args.memberIds ?? [], args.topic);
            return JSON.stringify(session);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      {
        name: 'collab_session_list',
        description: '列出共享会话（按最后活动时间倒序）',
        parameters: {
          includeClosed: { type: 'boolean', description: '是否包含已关闭会话，默认 false', required: false },
        },
        readOnly: true,
        execute: async (args: { includeClosed?: boolean }) => {
          return JSON.stringify(this.listSessions(args.includeClosed));
        },
      },
      {
        name: 'collab_session_message',
        description: '在共享会话中发送消息（实时广播给所有会话成员）',
        parameters: {
          sessionId: { type: 'string', description: '会话 ID', required: true },
          senderId: { type: 'string', description: '发送者成员 ID', required: true },
          content: { type: 'string', description: '消息内容', required: true },
          type: { type: 'string', description: '消息类型：text | system | file | task，默认 text', required: false },
        },
        readOnly: false,
        execute: async (args: { sessionId: string; senderId: string; content: string; type?: SessionMessage['type'] }) => {
          try {
            const message = this.sendMessage(args.sessionId, args.senderId, args.content, args.type ?? 'text');
            return JSON.stringify(message);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      {
        name: 'collab_task_assign',
        description: '创建并分配团队任务（支持优先级/截止时间/子任务/关联会话）',
        parameters: {
          title: { type: 'string', description: '任务标题', required: true },
          description: { type: 'string', description: '任务描述', required: true },
          creatorId: { type: 'string', description: '创建者成员 ID', required: true },
          assigneeId: { type: 'string', description: '被分配者成员 ID（不填则未分配）', required: false },
          priority: { type: 'string', description: '优先级：low | medium | high | urgent，默认 medium', required: false },
          dueAt: { type: 'number', description: '截止时间戳（毫秒）', required: false },
          tags: { type: 'array', description: '标签列表', required: false },
          relatedSessionId: { type: 'string', description: '关联会话 ID', required: false },
        },
        readOnly: false,
        execute: async (args: {
          title: string; description: string; creatorId: string; assigneeId?: string;
          priority?: TaskPriority; dueAt?: number; tags?: string[]; relatedSessionId?: string;
        }) => {
          try {
            const task = this.createTask(args);
            return JSON.stringify(task);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      {
        name: 'collab_task_list',
        description: '列出团队任务（支持按被分配者/状态/优先级过滤）',
        parameters: {
          assigneeId: { type: 'string', description: '被分配者 ID 过滤', required: false },
          status: { type: 'string', description: '状态过滤：pending | assigned | in_progress | completed | cancelled | blocked', required: false },
          priority: { type: 'string', description: '优先级过滤：low | medium | high | urgent', required: false },
        },
        readOnly: true,
        execute: async (args: { assigneeId?: string; status?: TaskStatus; priority?: TaskPriority }) => {
          return JSON.stringify(this.listTasks(args));
        },
      },
      {
        name: 'collab_knowledge_share',
        description: '共享知识到团队知识库（支持 private/team/public 可见性）',
        parameters: {
          title: { type: 'string', description: '标题', required: true },
          content: { type: 'string', description: '内容', required: true },
          contributorId: { type: 'string', description: '贡献者成员 ID', required: true },
          tags: { type: 'array', description: '标签列表', required: false },
          visibility: { type: 'string', description: '可见性：private | team | public，默认 team', required: false },
          category: { type: 'string', description: '分类，默认 general', required: false },
        },
        readOnly: false,
        execute: async (args: {
          title: string; content: string; contributorId: string;
          tags?: string[]; visibility?: KnowledgeVisibility; category?: string;
        }) => {
          try {
            const entry = this.shareKnowledge(args);
            return JSON.stringify(entry);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
    ];
  }
}

// ============ 便捷导出 ============

/** 获取单例便捷函数 */
export function getCollaborationEngine(): CollaborationEngine {
  return CollaborationEngine.getInstance();
}
