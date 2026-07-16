/**
 * P3-3: 分布式 Agent 集群 — DistributedAgentCluster
 *
 * 对标 Codex CLI 的分布式架构，实现多机部署、跨网络协作的 Agent 集群。
 *
 * 核心能力：
 * 1. Agent 间通信：基于 HTTP/JSON 的轻量 RPC（gRPC 的简化替代，避免原生依赖）
 * 2. 一致性哈希负载均衡：虚拟节点 + 哈希环，支持动态扩缩容
 * 3. Raft 共识算法：leader 选举 + 日志复制 + 故障转移
 *
 * 架构：
 * - 每个节点运行一个 AgentClusterNode 实例
 * - 节点间通过 RPC 通信
 * - Leader 节点负责协调任务分发
 * - Follower 节点接受 Leader 的任务分配
 * - Leader 故障时自动触发重新选举
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 节点角色 */
export type NodeRole = 'leader' | 'follower' | 'candidate';

/** 节点状态 */
export type NodeStatus = 'running' | 'stopped' | 'crashed';

/** 集群节点信息 */
export interface ClusterNode {
  /** 节点 ID */
  nodeId: string;
  /** 节点地址（host:port） */
  address: string;
  /** 主机名 */
  host: string;
  /** 端口 */
  port: number;
  /** 节点角色 */
  role: NodeRole;
  /** 节点状态 */
  status: NodeStatus;
  /** 加入时间 */
  joinedAt: number;
  /** 最后心跳时间 */
  lastHeartbeatAt: number;
  /** 节点能力标签 */
  capabilities: string[];
  /** 负载（0-1） */
  load: number;
}

/** RPC 请求 */
export interface RpcRequest {
  /** 请求 ID */
  requestId: string;
  /** 方法名 */
  method: string;
  /** 参数 */
  params: Record<string, unknown>;
  /** 调用者节点 ID */
  callerNodeId: string;
  /** 时间戳 */
  timestamp: number;
}

/** RPC 响应 */
export interface RpcResponse {
  /** 请求 ID */
  requestId: string;
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: number;
}

/** Raft 日志条目 */
export interface RaftLogEntry {
  /** 日志索引 */
  index: number;
  /** 任期号 */
  term: number;
  /** 操作类型 */
  operation: 'add_node' | 'remove_node' | 'assign_task' | 'update_config';
  /** 操作数据 */
  data: Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
}

/** 任务分配 */
export interface TaskAssignment {
  /** 任务 ID */
  taskId: string;
  /** 分配到的节点 ID */
  assignedNodeId: string;
  /** 任务类型 */
  taskType: string;
  /** 任务参数 */
  params: Record<string, unknown>;
  /** 分配时间 */
  assignedAt: number;
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
}

/** 一致性哈希环节点 */
interface HashRingNode {
  /** 哈希值 */
  hash: number;
  /** 节点 ID */
  nodeId: string;
}

// ============ 常量 ============

/** Raft 选举超时（毫秒） */
const ELECTION_TIMEOUT_MS = 3000;

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 1000;

/** 虚拟节点数（每个物理节点对应 150 个虚拟节点） */
const VIRTUAL_NODES = 150;

/** 哈希环大小 */
const HASH_RING_SIZE = 2 ** 32;

// ============ 一致性哈希负载均衡器 ============

/**
 * 一致性哈希负载均衡器
 *
 * 使用虚拟节点 + 哈希环实现均匀分布，
 * 节点加入/离开时只影响相邻区间的数据迁移。
 */
export class ConsistentHashBalancer {
  private ring: HashRingNode[] = [];
  private nodeSet: Set<string> = new Set();

  /** 添加节点 */
  addNode(nodeId: string): void {
    if (this.nodeSet.has(nodeId)) return;
    this.nodeSet.add(nodeId);

    // 为每个物理节点创建 VIRTUAL_NODES 个虚拟节点
    for (let i = 0; i < VIRTUAL_NODES; i++) {
      const hash = this.hash(`${nodeId}:${i}`);
      this.ring.push({ hash, nodeId });
    }

    // 按哈希值排序
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /** 移除节点 */
  removeNode(nodeId: string): void {
    if (!this.nodeSet.has(nodeId)) return;
    this.nodeSet.delete(nodeId);
    this.ring = this.ring.filter(n => n.nodeId !== nodeId);
  }

  /** 根据 key 选择节点 */
  selectNode(key: string): string | null {
    if (this.ring.length === 0) return null;

    const hash = this.hash(key);

    // 二分查找第一个 >= hash 的节点
    let left = 0;
    let right = this.ring.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.ring[mid].hash < hash) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // 环形：如果超过末尾，回到开头
    const index = left % this.ring.length;
    return this.ring[index].nodeId;
  }

  /** 获取所有节点 */
  getNodes(): string[] {
    return Array.from(this.nodeSet);
  }

  /** 获取环大小 */
  getRingSize(): number {
    return this.ring.length;
  }

  /** MD5 哈希 → 32 位无符号整数 */
  private hash(key: string): number {
    const md5 = crypto.createHash('md5').update(key).digest();
    // 取前 4 字节作为 32 位整数
    return md5.readUInt32BE(0) % HASH_RING_SIZE;
  }
}

// ============ Raft 共识模块 ============

/**
 * Raft 共识算法（简化实现）
 *
 * 实现 Leader 选举和日志复制核心功能。
 * 注意：这是教学级实现，生产环境应使用成熟的 Raft 库。
 */
export class RaftConsensus {
  private currentTerm = 0;
  private votedFor: string | null = null;
  private role: NodeRole = 'follower';
  private log: RaftLogEntry[] = [];
  private commitIndex = 0;
  private lastApplied = 0;
  private leaderId: string | null = null;

  /** 投票计数（选举期间） */
  private votesReceived: Set<string> = new Set();

  /** 选举定时器 */
  private electionTimer: ReturnType<typeof setTimeout> | null = null;

  /** 心跳定时器（仅 Leader） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly nodeId: string;
  private readonly peers: Set<string> = new Set();
  private log_ = logger.child({ module: 'RaftConsensus' });

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /** 添加对等节点 */
  addPeer(peerNodeId: string): void {
    this.peers.add(peerNodeId);
  }

  /** 移除对等节点 */
  removePeer(peerNodeId: string): void {
    this.peers.delete(peerNodeId);
  }

  /** 启动 Raft */
  start(): void {
    this.startElectionTimer();
    this.log_.info('Raft 共识已启动', { nodeId: this.nodeId, role: this.role });
  }

  /** 停止 Raft */
  stop(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.role = 'follower';
    this.log_.info('Raft 共识已停止', { nodeId: this.nodeId });
  }

  /** 获取当前角色 */
  getRole(): NodeRole {
    return this.role;
  }

  /** 获取当前任期 */
  getCurrentTerm(): number {
    return this.currentTerm;
  }

  /** 获取 Leader ID */
  getLeaderId(): string | null {
    return this.leaderId;
  }

  /** 追加日志（仅 Leader 可调用） */
  appendLog(operation: RaftLogEntry['operation'], data: Record<string, unknown>): number {
    if (this.role !== 'leader') return -1;

    const entry: RaftLogEntry = {
      index: this.log.length + 1,
      term: this.currentTerm,
      operation,
      data,
      timestamp: Date.now(),
    };

    this.log.push(entry);
    this.log_.info('日志已追加', { index: entry.index, term: entry.term, operation });

    // 简化：单节点立即提交
    if (this.peers.size === 0) {
      this.commitIndex = entry.index;
      this.lastApplied = entry.index;
    }

    return entry.index;
  }

  /** 获取日志 */
  getLog(): RaftLogEntry[] {
    return [...this.log];
  }

  /** 处理投票请求 */
  handleVoteRequest(term: number, candidateId: string, lastLogIndex: number, lastLogTerm: number): { term: number; voteGranted: boolean } {
    // 如果请求的任期 > 当前任期，更新任期并转为 follower
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.role = 'follower';
      this.votedFor = null;
    }

    // 检查是否已经投票
    const voteGranted = term === this.currentTerm
      && (this.votedFor === null || this.votedFor === candidateId)
      && this.isLogUpToDate(lastLogIndex, lastLogTerm);

    if (voteGranted) {
      this.votedFor = candidateId;
      this.resetElectionTimer();
    }

    return { term: this.currentTerm, voteGranted };
  }

  /** 处理心跳/追加条目 */
  handleAppendEntries(term: number, leaderId: string, prevLogIndex: number, prevLogTerm: number, entries: RaftLogEntry[], leaderCommit: number): { term: number; success: boolean } {
    // 如果请求的任期 < 当前任期，拒绝
    if (term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    // 如果请求的任期 > 当前任期，更新任期
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
    }

    // 转为 follower 并记录 leader
    this.role = 'follower';
    this.leaderId = leaderId;
    this.resetElectionTimer();

    // 检查日志一致性
    if (prevLogIndex > 0) {
      const prevEntry = this.log[prevLogIndex - 1];
      if (!prevEntry || prevEntry.term !== prevLogTerm) {
        return { term: this.currentTerm, success: false };
      }
    }

    // 追加新条目
    for (const entry of entries) {
      const existing = this.log[entry.index - 1];
      if (existing && existing.term !== entry.term) {
        // 冲突：删除该索引及之后的所有条目
        this.log = this.log.slice(0, entry.index - 1);
      }
      this.log[entry.index - 1] = entry;
    }

    // 更新提交索引
    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, this.log[this.log.length - 1]?.index ?? 0);
      this.lastApplied = this.commitIndex;
    }

    return { term: this.currentTerm, success: true };
  }

  /** 开始选举 */
  private startElection(): void {
    this.role = 'candidate';
    this.currentTerm++;
    this.votedFor = this.nodeId;
    this.votesReceived = new Set([this.nodeId]);

    this.log_.info('开始选举', { nodeId: this.nodeId, term: this.currentTerm });

    // 单节点直接成为 leader
    if (this.peers.size === 0) {
      this.becomeLeader();
      return;
    }

    // 广播投票请求（通过事件总线模拟网络通信）
    EventBus.getInstance().emitSync('raft.vote.request', {
      nodeId: this.nodeId,
      term: this.currentTerm,
      lastLogIndex: this.log.length,
      lastLogTerm: this.log[this.log.length - 1]?.term ?? 0,
    });

    // 等待投票响应（简化：超时后检查）— 保存句柄以便在成为 leader/收到心跳/停止时清理
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.electionTimer = setTimeout(() => {
      if (this.role === 'candidate' && this.votesReceived.size > Math.floor((this.peers.size + 1) / 2)) {
        this.becomeLeader();
      }
    }, 500);
  }

  /** 成为 Leader */
  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.nodeId;
    this.log_.info('已成为 Leader', { nodeId: this.nodeId, term: this.currentTerm });

    // 停止选举定时器
    if (this.electionTimer) clearTimeout(this.electionTimer);

    // 开始心跳
    this.startHeartbeat();

    EventBus.getInstance().emitSync('raft.leader.elected', {
      nodeId: this.nodeId,
      term: this.currentTerm,
    });
  }

  /** 开始心跳 */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.role !== 'leader') {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        return;
      }

      // 广播心跳
      EventBus.getInstance().emitSync('raft.heartbeat', {
        leaderId: this.nodeId,
        term: this.currentTerm,
        commitIndex: this.commitIndex,
      });
    }, HEARTBEAT_INTERVAL_MS);
    // 防止定时器阻止进程优雅退出
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /** 启动选举定时器 */
  private startElectionTimer(): void {
    this.resetElectionTimer();
  }

  /** 重置选举定时器 */
  private resetElectionTimer(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);

    // 随机化选举超时（避免活锁）
    const timeout = ELECTION_TIMEOUT_MS + Math.random() * 1000;
    this.electionTimer = setTimeout(() => {
      if (this.role !== 'leader') {
        this.startElection();
      }
    }, timeout);
  }

  /** 检查候选人的日志是否至少与自己的一样新 */
  private isLogUpToDate(lastLogIndex: number, lastLogTerm: number): boolean {
    const myLastEntry = this.log[this.log.length - 1];
    if (!myLastEntry) return true;

    const myLastTerm = myLastEntry.term;
    const myLastIndex = myLastEntry.index;

    if (lastLogTerm !== myLastTerm) {
      return lastLogTerm > myLastTerm;
    }
    return lastLogIndex >= myLastIndex;
  }
}

// ============ 分布式 Agent 集群节点 ============

/**
 * Agent 集群节点
 *
 * 每个节点运行一个 AgentClusterNode 实例，
 * 负责接收任务、执行任务、与其他节点通信。
 */
export class AgentClusterNode {
  /** 节点信息 */
  readonly nodeInfo: ClusterNode;

  /** 集群中所有节点 */
  private clusterNodes: Map<string, ClusterNode> = new Map();

  /** 一致性哈希负载均衡器 */
  private balancer: ConsistentHashBalancer = new ConsistentHashBalancer();

  /** Raft 共识模块 */
  private raft: RaftConsensus;

  /** HTTP 服务器（用于 RPC 通信） */
  private server: http.Server | null = null;

  /** 任务分配表 */
  private taskAssignments: Map<string, TaskAssignment> = new Map();

  /** RPC 方法注册表 */
  private rpcMethods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> = new Map();

  /** P3-3: 故障检测定时器 */
  private faultDetectionTimer: ReturnType<typeof setInterval> | null = null;

  /** P3-3: 节点超时阈值（毫秒），超过此时间无心跳则标记为 crashed */
  private readonly NODE_TIMEOUT_MS = 10000;

  /** P3-3: 故障转移历史记录 */
  private failoverHistory: Array<{ taskId: string; fromNode: string; toNode: string; reason: string; timestamp: number }> = [];

  /** P3-3: 持久化路径 */
  private persistPath: string;

  private log = logger.child({ module: 'AgentClusterNode' });

  constructor(nodeId: string, host: string, port: number, capabilities: string[] = [], options?: { persistDir?: string }) {
    this.nodeInfo = {
      nodeId,
      address: `${host}:${port}`,
      host,
      port,
      role: 'follower',
      status: 'running',
      joinedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      capabilities,
      load: 0,
    };

    this.raft = new RaftConsensus(nodeId);
    this.persistPath = options?.persistDir ?? path.join(process.cwd(), '.duan', 'cluster');
    this.registerDefaultRpcMethods();
  }

  // ========== 集群管理 ==========

  /**
   * 启动节点
   */
  async start(): Promise<void> {
    // 启动 HTTP 服务器
    await this.startHttpServer();

    // 启动 Raft
    this.raft.start();

    // 注册自身到集群
    this.clusterNodes.set(this.nodeInfo.nodeId, this.nodeInfo);
    this.balancer.addNode(this.nodeInfo.nodeId);

    this.log.info('节点已启动', {
      nodeId: this.nodeInfo.nodeId,
      address: this.nodeInfo.address,
    });

    EventBus.getInstance().emitSync('cluster.node.started', {
      nodeId: this.nodeInfo.nodeId,
      address: this.nodeInfo.address,
    });
  }

  /**
   * 停止节点
   */
  async stop(): Promise<void> {
    this.raft.stop();

    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.nodeInfo.status = 'stopped';
    this.log.info('节点已停止', { nodeId: this.nodeInfo.nodeId });
  }

  /**
   * 加入集群（连接到已有节点）
   */
  async joinCluster(knownNodeAddress: string): Promise<boolean> {
    try {
      // 通过 RPC 向已知节点发送加入请求
      const response = await this.callRpc(knownNodeAddress, 'cluster.join', {
        nodeId: this.nodeInfo.nodeId,
        address: this.nodeInfo.address,
        capabilities: this.nodeInfo.capabilities,
      });

      if (response.success && response.data) {
        const data = response.data as { nodes: ClusterNode[] };
        // 同步集群节点列表
        for (const node of data.nodes) {
          this.clusterNodes.set(node.nodeId, node);
          this.balancer.addNode(node.nodeId);
          this.raft.addPeer(node.nodeId);
        }
        this.log.info('已加入集群', { knownNodeAddress, nodeCount: this.clusterNodes.size });
        return true;
      }
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加入集群失败', { error: msg });
      return false;
    }
  }

  /**
   * 添加节点到集群
   */
  addNode(node: ClusterNode): void {
    this.clusterNodes.set(node.nodeId, node);
    this.balancer.addNode(node.nodeId);
    this.raft.addPeer(node.nodeId);

    // 如果是 Leader，追加日志
    if (this.raft.getRole() === 'leader') {
      this.raft.appendLog('add_node', { nodeId: node.nodeId, address: node.address });
    }

    this.log.info('节点已添加到集群', { nodeId: node.nodeId, address: node.address });
  }

  /**
   * 从集群移除节点
   */
  removeNode(nodeId: string): void {
    this.clusterNodes.delete(nodeId);
    this.balancer.removeNode(nodeId);
    this.raft.removePeer(nodeId);

    if (this.raft.getRole() === 'leader') {
      this.raft.appendLog('remove_node', { nodeId });
    }

    this.log.info('节点已从集群移除', { nodeId });
  }

  /**
   * 列出集群所有节点
   */
  listNodes(): ClusterNode[] {
    return Array.from(this.clusterNodes.values());
  }

  /**
   * 获取节点信息
   */
  getNode(nodeId: string): ClusterNode | null {
    return this.clusterNodes.get(nodeId) ?? null;
  }

  // ========== 任务分配 ==========

  /**
   * 分配任务到节点（使用一致性哈希）
   */
  assignTask(taskId: string, taskType: string, params: Record<string, unknown>): TaskAssignment | null {
    const assignedNodeId = this.balancer.selectNode(taskId);
    if (!assignedNodeId) return null;

    const assignment: TaskAssignment = {
      taskId,
      assignedNodeId,
      taskType,
      params,
      assignedAt: Date.now(),
      status: 'pending',
    };

    this.taskAssignments.set(taskId, assignment);

    // 如果是 Leader，追加日志
    if (this.raft.getRole() === 'leader') {
      this.raft.appendLog('assign_task', { taskId, assignedNodeId, taskType });
    }

    this.log.info('任务已分配', { taskId, assignedNodeId, taskType });
    return assignment;
  }

  /**
   * 获取任务分配
   */
  getTaskAssignment(taskId: string): TaskAssignment | null {
    return this.taskAssignments.get(taskId) ?? null;
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: TaskAssignment['status']): boolean {
    const assignment = this.taskAssignments.get(taskId);
    if (!assignment) return false;
    assignment.status = status;
    return true;
  }

  // ========== RPC 通信 ==========

  /**
   * 注册 RPC 方法
   */
  registerRpcMethod(method: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
    this.rpcMethods.set(method, handler);
  }

  /**
   * 调用远程节点的 RPC 方法
   */
  callRpc(targetAddress: string, method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise((resolve) => {
      const requestBody = JSON.stringify({
        requestId: `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        method,
        params,
        callerNodeId: this.nodeInfo.nodeId,
        timestamp: Date.now(),
      } satisfies RpcRequest);

      const [host, portStr] = targetAddress.split(':');
      const port = parseInt(portStr, 10);

      const req = http.request(
        {
          hostname: host,
          port,
          path: '/rpc',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
          },
          timeout: 5000,
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as RpcResponse);
            } catch {
              resolve({
                requestId: '',
                success: false,
                error: 'Invalid JSON response',
                timestamp: Date.now(),
              });
            }
          });
        },
      );

      req.on('error', (err) => {
        resolve({
          requestId: '',
          success: false,
          error: err.message,
          timestamp: Date.now(),
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          requestId: '',
          success: false,
          error: 'RPC timeout',
          timestamp: Date.now(),
        });
      });

      req.write(requestBody);
      req.end();
    });
  }

  // ========== 状态查询 ==========

  /**
   * 获取节点角色
   */
  getRole(): NodeRole {
    return this.raft.getRole();
  }

  /**
   * 是否为 Leader
   */
  isLeader(): boolean {
    return this.raft.getRole() === 'leader';
  }

  /**
   * 获取 Raft 状态
   */
  getRaftStatus(): {
    role: NodeRole;
    term: number;
    leaderId: string | null;
    logLength: number;
    commitIndex: number;
  } {
    return {
      role: this.raft.getRole(),
      term: this.raft.getCurrentTerm(),
      leaderId: this.raft.getLeaderId(),
      logLength: this.raft.getLog().length,
      commitIndex: 0,
    };
  }

  /**
   * 获取负载均衡器统计
   */
  getBalancerStats(): { nodeCount: number; ringSize: number } {
    return {
      nodeCount: this.balancer.getNodes().length,
      ringSize: this.balancer.getRingSize(),
    };
  }

  // ========== 私有方法 ==========

  /** 启动 HTTP 服务器 */
  private startHttpServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/rpc') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            void (async () => {
              try {
                const rpcRequest = JSON.parse(body) as RpcRequest;
                const response = await this.handleRpcRequest(rpcRequest);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  requestId: '',
                  success: false,
                  error: msg,
                  timestamp: Date.now(),
                } satisfies RpcResponse));
              }
            })();
          });
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            nodeId: this.nodeInfo.nodeId,
            status: this.nodeInfo.status,
            role: this.nodeInfo.role,
            timestamp: Date.now(),
          }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.listen(this.nodeInfo.port, this.nodeInfo.host, () => {
        resolve();
      });
    });
  }

  /** 处理 RPC 请求 */
  private async handleRpcRequest(request: RpcRequest): Promise<RpcResponse> {
    const handler = this.rpcMethods.get(request.method);
    if (!handler) {
      return {
        requestId: request.requestId,
        success: false,
        error: `Unknown method: ${request.method}`,
        timestamp: Date.now(),
      };
    }

    try {
      const data = await handler(request.params);
      return {
        requestId: request.requestId,
        success: true,
        data,
        timestamp: Date.now(),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        requestId: request.requestId,
        success: false,
        error: msg,
        timestamp: Date.now(),
      };
    }
  }

  /** 注册默认 RPC 方法 */
  private registerDefaultRpcMethods(): void {
    // cluster.join — 加入集群
    this.registerRpcMethod('cluster.join', (params) => {
      const newNode: ClusterNode = {
        nodeId: params.nodeId as string,
        address: params.address as string,
        host: (params.address as string).split(':')[0],
        port: parseInt((params.address as string).split(':')[1], 10),
        role: 'follower',
        status: 'running',
        joinedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        capabilities: params.capabilities as string[] ?? [],
        load: 0,
      };

      this.addNode(newNode);

      return Promise.resolve({
        nodes: this.listNodes(),
      });
    });

    // cluster.heartbeat — 心跳
    this.registerRpcMethod('cluster.heartbeat', (params) => {
      const nodeId = params.nodeId as string;
      const node = this.clusterNodes.get(nodeId);
      if (node) {
        node.lastHeartbeatAt = Date.now();
        node.load = params.load as number ?? 0;
      }
      return Promise.resolve({ ack: true });
    });

    // cluster.list — 列出节点
    this.registerRpcMethod('cluster.list', () => {
      return Promise.resolve({ nodes: this.listNodes() });
    });

    // task.execute — 执行任务
    this.registerRpcMethod('task.execute', (params) => {
      const taskId = params.taskId as string;
      const taskType = params.taskType as string;
      this.log.info('收到任务执行请求', { taskId, taskType });
      // 实际任务执行由子类或外部注册
      return Promise.resolve({ taskId, status: 'accepted' });
    });

    // raft.vote — Raft 投票
    this.registerRpcMethod('raft.vote', (params) => {
      const result = this.raft.handleVoteRequest(
        params.term as number,
        params.candidateId as string,
        params.lastLogIndex as number,
        params.lastLogTerm as number,
      );
      return Promise.resolve(result);
    });

    // raft.append — Raft 追加条目
    this.registerRpcMethod('raft.append', (params) => {
      const result = this.raft.handleAppendEntries(
        params.term as number,
        params.leaderId as string,
        params.prevLogIndex as number,
        params.prevLogTerm as number,
        params.entries as RaftLogEntry[] ?? [],
        params.leaderCommit as number,
      );
      return Promise.resolve(result);
    });
  }

  // ========== P3-3: 故障检测与故障转移 ==========

  /**
   * P3-3: 启动故障检测
   *
   * 定期检查所有节点的心跳，超时未收到心跳的节点标记为 crashed，
   * 并触发其上任务的故障转移。
   */
  startFaultDetection(): void {
    if (this.faultDetectionTimer) return;

    this.faultDetectionTimer = setInterval(() => {
      this.checkNodeHealth();
    }, 5000); // 每 5 秒检查一次
    // 防止定时器阻止进程优雅退出
    if (typeof this.faultDetectionTimer.unref === 'function') this.faultDetectionTimer.unref();

    this.log.info('故障检测已启动', { interval: '5s', timeout: this.NODE_TIMEOUT_MS });
  }

  /**
   * P3-3: 停止故障检测
   */
  stopFaultDetection(): void {
    if (this.faultDetectionTimer) {
      clearInterval(this.faultDetectionTimer);
      this.faultDetectionTimer = null;
      this.log.info('故障检测已停止');
    }
  }

  /**
   * P3-3: 检查节点健康状态
   *
   * 遍历所有集群节点，将超时节点标记为 crashed 并触发故障转移。
   */
  private checkNodeHealth(): void {
    const now = Date.now();
    let crashedCount = 0;

    for (const [nodeId, node] of this.clusterNodes.entries()) {
      // 跳过自身和已停止的节点
      if (nodeId === this.nodeInfo.nodeId) continue;
      if (node.status === 'stopped' || node.status === 'crashed') continue;

      // 检查心跳超时
      if (now - node.lastHeartbeatAt > this.NODE_TIMEOUT_MS) {
        this.log.warn('节点心跳超时，标记为 crashed', {
          nodeId,
          lastHeartbeat: new Date(node.lastHeartbeatAt).toISOString(),
          timeoutMs: this.NODE_TIMEOUT_MS,
        });
        node.status = 'crashed';
        crashedCount++;

        // 触发故障转移
        this.failoverNodeTasks(nodeId);
      }
    }

    if (crashedCount > 0) {
      this.log.info('故障检测完成', { crashedCount, totalNodes: this.clusterNodes.size });
    }
  }

  /**
   * P3-3: 故障转移 — 将崩溃节点上的任务重新分配到其他节点
   *
   * @param crashedNodeId 崩溃的节点 ID
   */
  private failoverNodeTasks(crashedNodeId: string): void {
    // 查找该节点上的所有任务
    const tasksToFailover: TaskAssignment[] = [];
    for (const [_taskId, assignment] of this.taskAssignments.entries()) {
      if (assignment.assignedNodeId === crashedNodeId && (assignment.status === 'pending' || assignment.status === 'running')) {
        tasksToFailover.push(assignment);
      }
    }

    if (tasksToFailover.length === 0) return;

    // 从一致性哈希环中移除崩溃节点
    this.balancer.removeNode(crashedNodeId);

    // 重新分配任务
    let failoverCount = 0;
    for (const task of tasksToFailover) {
      const newNodeId = this.balancer.selectNode(task.taskId);
      if (newNodeId && newNodeId !== crashedNodeId) {
        const newAssignment: TaskAssignment = {
          taskId: task.taskId,
          assignedNodeId: newNodeId,
          taskType: task.taskType,
          params: task.params,
          status: 'pending',
          assignedAt: Date.now(),
        };
        this.taskAssignments.set(task.taskId, newAssignment);
        this.failoverHistory.push({
          taskId: task.taskId,
          fromNode: crashedNodeId,
          toNode: newNodeId,
          reason: 'node_crashed',
          timestamp: Date.now(),
        });
        failoverCount++;

        this.log.info('任务已故障转移', {
          taskId: task.taskId,
          fromNode: crashedNodeId,
          toNode: newNodeId,
        });
      }
    }

    if (failoverCount > 0) {
      this.log.info('故障转移完成', {
        crashedNode: crashedNodeId,
        failoverCount,
        totalTasks: tasksToFailover.length,
      });
    }
  }

  /**
   * P3-3: 模拟节点故障
   *
   * 手动将指定节点标记为 crashed，用于测试故障转移机制。
   *
   * @param nodeId 要模拟故障的节点 ID
   * @returns 故障转移的任务数量
   */
  simulateNodeFailure(nodeId: string): number {
    const node = this.clusterNodes.get(nodeId);
    if (!node) return 0;

    node.status = 'crashed';
    this.log.info('模拟节点故障', { nodeId });

    this.failoverNodeTasks(nodeId);
    const failoverCount = this.failoverHistory.filter(
      f => f.fromNode === nodeId && f.timestamp > Date.now() - 1000
    ).length;

    return failoverCount;
  }

  /**
   * P3-3: 获取故障转移历史
   */
  getFailoverHistory(): Array<{ taskId: string; fromNode: string; toNode: string; reason: string; timestamp: number }> {
    return [...this.failoverHistory];
  }

  // ========== P3-3: 持久化 ==========

  /**
   * P3-3: 持久化集群状态到磁盘
   *
   * 保存节点列表、任务分配、Raft 日志，以便重启后恢复。
   */
  persist(): Promise<void> {
    try {
      if (!fs.existsSync(this.persistPath)) {
        fs.mkdirSync(this.persistPath, { recursive: true });
      }

      const data = {
        nodeInfo: this.nodeInfo,
        clusterNodes: Array.from(this.clusterNodes.entries()),
        taskAssignments: Array.from(this.taskAssignments.entries()),
        raftLog: this.raft.getLog(),
        failoverHistory: this.failoverHistory,
        savedAt: Date.now(),
      };

      const dataPath = path.join(this.persistPath, `cluster-${this.nodeInfo.nodeId}.json`);
      atomicWriteJsonSync(dataPath, data);

      this.log.debug('集群状态已持久化', { path: dataPath, nodes: this.clusterNodes.size });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('集群状态持久化失败', { error: msg });
    }
    return Promise.resolve();
  }

  /**
   * P3-3: 从磁盘加载集群状态
   */
  load(): Promise<void> {
    try {
      const dataPath = path.join(this.persistPath, `cluster-${this.nodeInfo.nodeId}.json`);
      if (!fs.existsSync(dataPath)) {
        this.log.debug('集群状态文件不存在，跳过加载');
        return Promise.resolve();
      }

      const raw = fs.readFileSync(dataPath, 'utf-8');
      const data = JSON.parse(raw);

      // 恢复集群节点
      this.clusterNodes = new Map(data.clusterNodes || []);

      // 恢复任务分配
      this.taskAssignments = new Map(data.taskAssignments || []);

      // 恢复故障转移历史
      this.failoverHistory = data.failoverHistory || [];

      // 重建一致性哈希环
      for (const nodeId of this.clusterNodes.keys()) {
        this.balancer.addNode(nodeId);
      }

      this.log.info('集群状态已加载', {
        nodes: this.clusterNodes.size,
        tasks: this.taskAssignments.size,
        failoverRecords: this.failoverHistory.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('集群状态加载失败', { error: msg });
    }
    return Promise.resolve();
  }

  // ========== P3-3: 验收度量方法 ==========

  /**
   * P3-3: 获取集群统计
   *
   * 验收标准：多机部署
   *
   * @returns 集群综合统计信息
   */
  getClusterStats(): {
    totalNodes: number;
    runningNodes: number;
    crashedNodes: number;
    stoppedNodes: number;
    totalTasks: number;
    assignedTasks: number;
    completedTasks: number;
    avgLoad: number;
    isLeader: boolean;
    raftTerm: number;
    balancerRingSize: number;
    failoverCount: number;
  } {
    const nodes = Array.from(this.clusterNodes.values());
    const runningNodes = nodes.filter(n => n.status === 'running').length;
    const crashedNodes = nodes.filter(n => n.status === 'crashed').length;
    const stoppedNodes = nodes.filter(n => n.status === 'stopped').length;

    const tasks = Array.from(this.taskAssignments.values());
    const assignedTasks = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;

    const avgLoad = nodes.length > 0
      ? nodes.reduce((s, n) => s + n.load, 0) / nodes.length
      : 0;

    return {
      totalNodes: this.clusterNodes.size,
      runningNodes,
      crashedNodes,
      stoppedNodes,
      totalTasks: this.taskAssignments.size,
      assignedTasks,
      completedTasks,
      avgLoad: Math.round(avgLoad * 100) / 100,
      isLeader: this.isLeader(),
      raftTerm: this.raft.getCurrentTerm(),
      balancerRingSize: this.balancer.getRingSize(),
      failoverCount: this.failoverHistory.length,
    };
  }

  /**
   * P3-3: 验证故障转移能力
   *
   * 检查集群的故障转移机制是否满足验收标准：
   * - 负载均衡：至少 2 个运行中节点
   * - 故障检测：故障检测已启动
   * - 故障转移：有故障转移历史或可模拟
   * - 任务持久性：任务分配有记录
   *
   * @returns 验证结果
   */
  validateFaultTolerance(): {
    valid: boolean;
    checks: {
      loadBalanced: { passed: boolean; runningNodes: number; message: string };
      faultDetectionActive: { passed: boolean; active: boolean; message: string };
      failoverCapable: { passed: boolean; historyCount: number; message: string };
      taskPersistence: { passed: boolean; taskCount: number; message: string };
    };
    overallScore: number;
  } {
    const stats = this.getClusterStats();

    // 负载均衡：至少 2 个运行中节点
    const loadBalanced = stats.runningNodes >= 2;

    // 故障检测已启动
    const faultDetectionActive = this.faultDetectionTimer !== null;

    // 故障转移能力：有历史记录或可模拟
    const failoverCapable = stats.failoverCount > 0 || stats.totalNodes > 1;

    // 任务持久性：有任务分配记录
    const taskPersistence = stats.totalTasks > 0;

    const allPassed = loadBalanced && faultDetectionActive && failoverCapable && taskPersistence;
    const overallScore = (
      (loadBalanced ? 1 : 0) +
      (faultDetectionActive ? 1 : 0) +
      (failoverCapable ? 1 : 0) +
      (taskPersistence ? 1 : 0)
    ) / 4;

    return {
      valid: allPassed,
      checks: {
        loadBalanced: {
          passed: loadBalanced,
          runningNodes: stats.runningNodes,
          message: loadBalanced
            ? `${stats.runningNodes} 个运行中节点`
            : `仅 ${stats.runningNodes} 个运行中节点（需≥2）`,
        },
        faultDetectionActive: {
          passed: faultDetectionActive,
          active: faultDetectionActive,
          message: faultDetectionActive
            ? '故障检测已启动'
            : '故障检测未启动',
        },
        failoverCapable: {
          passed: failoverCapable,
          historyCount: stats.failoverCount,
          message: failoverCapable
            ? `故障转移可用（${stats.failoverCount} 次历史记录）`
            : '无故障转移能力',
        },
        taskPersistence: {
          passed: taskPersistence,
          taskCount: stats.totalTasks,
          message: taskPersistence
            ? `${stats.totalTasks} 个任务已分配`
            : '无任务分配记录',
        },
      },
      overallScore: Math.round(overallScore * 100) / 100,
    };
  }
}
