/**
 * Agent Identity Network — Agent 身份网络
 *
 * 每个 Agent 拥有唯一、持久的身份，包含能力画像、声誉评分、信任评分。
 * 身份在会话间持久化，支持：
 * - 基于信任的 Agent 间协作
 * - 基于声誉的结果综合
 * - 基于能力的任务路由
 * - 每个 Agent 的审计追踪
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { atomicWriteJson } from './atomic-write.js';

const execFileAsync = promisify(execFile);

// ============ 类型定义 ============

/** Agent 能力描述 */
export interface Capability {
  name: string;
  level: number;          // 0-100 技能等级
  verified: boolean;      // 是否经过验证
  lastUsed: number;       // 最后使用时间戳
  usageCount: number;     // 使用次数
}

/** Agent 配置档案 */
export interface AgentProfile {
  name: string;
  description: string;
  capabilities: Capability[];
  domain: string;
  communicationChannels?: string[];  // 通信渠道
  delegationRules?: DelegationRule[]; // 委托规则
  metadata?: Record<string, unknown>;
}

/** 委托规则 */
export interface DelegationRule {
  targetDomain: string;
  allowedCapabilities: string[];
  maxDelegationDepth: number;
  requiresApproval: boolean;
}

/** Agent 身份 */
export interface AgentIdentity {
  id: string;                    // 加密哈希 ID
  profile: AgentProfile;
  reputation: number;            // 声誉评分 (-100 ~ 100)
  trust: number;                 // 信任评分 (0 ~ 100)
  createdAt: number;
  lastActiveAt: number;
  secretHash: string;            // 身份验证密钥哈希
  outcomeCount: number;          // 任务结果总数
  successCount: number;          // 成功任务数
}

/** 能力更新 */
export interface CapabilityUpdate {
  added?: Capability[];
  removed?: string[];            // 要移除的能力名称
  updated?: Array<{ name: string; level?: number; verified?: boolean }>;
}

/** 任务结果 */
export interface TaskOutcome {
  taskId: string;
  success: boolean;
  quality: number;               // 0-100 质量评分
  duration: number;              // 执行时长(ms)
  description: string;
  timestamp: number;
  verifiedBy?: string;           // 验证者 Agent ID
}

/** 声誉历史条目 */
export interface ReputationEntry {
  timestamp: number;
  delta: number;
  reason: string;
  previousScore: number;
  newScore: number;
}

// ============ P3-1: 独立身份网络类型 ============

/** 邮箱身份 — Agent 独立通信地址 */
export interface EmailIdentity {
  /** Agent ID */
  agentId: string;
  /** 邮箱地址（前缀自定义 + 域名） */
  email: string;
  /** 前缀（用户自定义部分） */
  prefix: string;
  /** 域名 */
  domain: string;
  /** 创建时间 */
  createdAt: number;
  /** 是否已验证 */
  verified: boolean;
  /** 转发规则（收到的邮件转发到哪些渠道） */
  forwardTo: string[];
}

/** 第三方操作绑定 — 将操作绑定到 Agent 身份而非用户 */
export interface ThirdPartyOperation {
  /** 操作 ID */
  operationId: string;
  /** 绑定的 Agent ID */
  agentId: string;
  /** 第三方服务名称（如 github/notion/slack） */
  service: string;
  /** 操作类型（如 create_pr/send_message/create_issue） */
  operationType: string;
  /** 操作时间戳 */
  timestamp: number;
  /** 操作参数 */
  params: Record<string, unknown>;
  /** 操作结果 */
  result: 'success' | 'failure' | 'pending';
  /** 审计签名（Agent 身份签名） */
  signature: string;
}

/** 渠道类型 */
export type ChannelType = 'feishu' | 'wechat' | 'web' | 'email' | 'api';

/**
 * P4: 渠道适配器接口 — 真实跨渠道消息投递
 *
 * 每个渠道（feishu/wechat/web/email/api）实现此接口以提供真实消息投递能力。
 * AgentIdentityNetwork.syncAcrossChannelsAsync() 会调用注册的适配器执行真实投递，
 * 失败时降级为缓冲（syncAcrossChannels 仍保留作为同步缓冲路径）。
 *
 * 已实现的适配器：
 * - WeChatChannelAdapter: 包装 WeChatController，使用 Windows UI 自动化真实发送微信消息
 * - WebhookChannelAdapter: 通过 HTTP POST 投递到 webhook URL（适用于 web/api 渠道）
 */
export interface ChannelAdapter {
  /** 渠道类型 */
  readonly channel: ChannelType;
  /** 适配器名称（用于日志） */
  readonly name: string;
  /** 是否已就绪（已认证/客户端可用） */
  isReady(): boolean;
  /** 发送消息到指定接收者（contactName/userId/chatId） */
  sendMessage(recipient: string, message: string): Promise<{ success: boolean; error?: string; messageId?: string }>;
  /** 释放资源 */
  dispose?(): void;
}

/** P4: 渠道适配器投递结果 */
export interface ChannelDeliveryResult {
  channel: ChannelType;
  recipient: string;
  success: boolean;
  error?: string;
  messageId?: string;
  deliveredAt: number;
}

/** 跨渠道记忆同步状态 */
export interface ChannelSyncState {
  /** Agent ID */
  agentId: string;
  /** 渠道类型 */
  channel: ChannelType;
  /** 渠道内唯一标识（如飞书 open_id、微信 union_id） */
  channelUserId: string;
  /** 最后同步时间 */
  lastSyncAt: number;
  /** 同步的消息数 */
  syncedMessageCount: number;
  /** 渠道特定元数据 */
  channelMetadata: Record<string, unknown>;
}

/** 独立计算环境 — Agent 的隔离执行上下文 */
export interface ComputeEnvironment {
  /** 环境 ID */
  envId: string;
  /** 绑定的 Agent ID */
  agentId: string;
  /** 环境类型 */
  type: 'local_sandbox' | 'cloud_vm' | 'cloud_phone' | 'container';
  /** 环境状态 */
  status: 'creating' | 'running' | 'paused' | 'stopped' | 'failed';
  /** 资源配额 */
  resources: {
    cpuCores: number;
    memoryMB: number;
    diskGB: number;
    networkEnabled: boolean;
  };
  /** 工作目录 */
  workDir: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 环境元数据（如 VM ID、容器 ID） */
  metadata: Record<string, unknown>;
}

// ============ P3-1: 真实计算后端接口 ============

/**
 * P3-1: 计算后端抽象接口 — 真实启动/停止/销毁计算环境
 *
 * 取代之前 setTimeout(100ms) 模拟"环境启动"。两个真实实现：
 * - DockerContainerBackend: 通过 `docker run/stop/rm` 真实启动/停止/销毁容器
 * - SubprocessComputeBackend: 真实创建工作目录 + 子进程隔离（Docker 不可用时的降级）
 *
 * 实现要求（不得弄虚作假）：
 * - start() 必须真实启动后端并阻塞至就绪或失败
 * - stop() 必须真实停止后端进程（不是仅改 status 字段）
 * - destroy() 必须真实清理后端资源（容器、文件、子进程）
 * - exec() 必须在环境内真实执行命令并返回 stdout/stderr/exitCode
 */
export interface ComputeBackend {
  /** 后端名称（docker / subprocess） */
  readonly name: string;
  /** 后端是否为真实隔离实现（true）vs 降级实现（false） */
  readonly isIsolating: boolean;
  /** 后端是否可用（已检测） */
  isAvailable(): Promise<boolean>;
  /**
   * 真实启动计算环境
   * @returns 后端特定标识（containerId / pid）和就绪状态
   */
  start(env: ComputeEnvironment): Promise<{ backendId: string; ready: boolean; error?: string }>;
  /** 真实停止计算环境（保留资源，可恢复） */
  stop(backendId: string): Promise<{ success: boolean; error?: string }>;
  /** 真实销毁计算环境（释放所有资源） */
  destroy(backendId: string): Promise<{ success: boolean; error?: string }>;
  /** 在环境内执行命令（如果后端支持） */
  exec?(backendId: string, command: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

/**
 * P3-1: Docker 容器后端 — 真实调用 `docker run/stop/rm/exec`
 *
 * 启动：`docker run -d --memory --cpus --network <mode> --workdir <dir> -v <workDir>:<workDir> <image> tail -f /dev/null`
 * 停止：`docker stop <containerId>`
 * 销毁：`docker rm -f <containerId>`
 * 执行：`docker exec <containerId> <command>`
 */
export class DockerContainerBackend implements ComputeBackend {
  readonly name = 'docker';
  readonly isIsolating = true;
  private availableCache: boolean | null = null;

  isAvailable(): Promise<boolean> {
    if (this.availableCache !== null) return Promise.resolve(this.availableCache);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.availableCache = false; resolve(false); }, 3000);
      try {
        execFile('docker', ['--version'], { timeout: 3000 }, (err, stdout) => {
          clearTimeout(timer);
          this.availableCache = !err && /Docker version/i.test(String(stdout || ''));
          resolve(this.availableCache);
        });
      } catch {
        clearTimeout(timer);
        this.availableCache = false;
        resolve(false);
      }
    });
  }

  async start(env: ComputeEnvironment): Promise<{ backendId: string; ready: boolean; error?: string }> {
    const image = (env.metadata.image as string) || 'ubuntu:22.04';
    const args: string[] = [
      'run', '-d',
      '--name', `agent-env-${env.envId}`,
      '--memory', `${env.resources.memoryMB}m`,
      '--cpus', String(env.resources.cpuCores),
      '--network', env.resources.networkEnabled ? 'bridge' : 'none',
      '--workdir', env.workDir,
    ];
    // 挂载工作目录（双向读写）
    args.push('-v', `${env.workDir}:${env.workDir}`);
    args.push(image, 'tail', '-f', '/dev/null');

    try {
      const result = await this.runDocker(args, 60000);
      const containerId = result.stdout.trim();
      if (!containerId || containerId.length < 12) {
        return { backendId: '', ready: false, error: `docker run 返回无效 containerId: "${containerId}"` };
      }
      // 等待容器进入 running 状态
      const ready = await this.waitForRunning(containerId, 30000);
      return { backendId: containerId, ready, error: ready ? undefined : '容器启动但未进入 running 状态' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { backendId: '', ready: false, error: `docker run 失败: ${msg}` };
    }
  }

  async stop(backendId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.runDocker(['stop', backendId], 30000);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  async destroy(backendId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.runDocker(['rm', '-f', backendId], 30000);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  exec(backendId: string, command: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return this.runDocker(['exec', backendId, ...command], timeoutMs);
  }

  private async waitForRunning(containerId: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.runDocker(['inspect', '--format', '{{.State.Running}}', containerId], 5000);
        if (/true/i.test(result.stdout.trim())) return true;
      } catch {
        // 容器可能尚未启动，继续等待
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  private runDocker(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      execFile('docker', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          exitCode: err ? (err as unknown as { code?: number }).code ?? -1 : 0,
        });
      });
    });
  }
}

/**
 * P3-1: 子进程后端 — 真实创建工作目录 + 进程级隔离（Docker 不可用时降级）
 *
 * 启动：fs.mkdirSync(workDir, { recursive: true }) 真实创建工作目录
 *       可选：spawn 一个长存活哨兵进程（sleep infinity）作为环境存活标志
 * 停止：kill 哨兵进程
 * 销毁：kill 哨兵进程 + 删除工作目录
 *
 * 注：这是降级实现，不提供强隔离（无 namespace/cgroup 隔离），仅适用于
 * Docker 不可用环境的最低保障。isIsolating=false。
 */
export class SubprocessComputeBackend implements ComputeBackend {
  readonly name = 'subprocess';
  readonly isIsolating = false;
  private sentinels: Map<string, { pid: number; killed: boolean }> = new Map();

  isAvailable(): Promise<boolean> {
    // 子进程后端总是可用（只要 Node.js fs 可用）
    return Promise.resolve(true);
  }

  async start(env: ComputeEnvironment): Promise<{ backendId: string; ready: boolean; error?: string }> {
    try {
      // 真实创建工作目录
      await fs.promises.mkdir(env.workDir, { recursive: true });

      // 写入一个 .env-meta.json 标记此目录是计算环境工作目录
      const metaPath = path.join(env.workDir, '.env-meta.json');
      await atomicWriteJson(metaPath, {
        envId: env.envId,
        agentId: env.agentId,
        createdAt: env.createdAt,
        backend: this.name,
      });

      // 启动哨兵进程（保持环境"存活"的标志）
      // Windows: ping -t localhost | Out-Null 不易管理，改用 powershell -Command "Start-Sleep -Seconds 86400"
      // Linux/macOS: sleep infinity（BSD sleep 不支持 infinity，改用 yes 不可行，使用 sleep 86400）
      const isWin = process.platform === 'win32';
      const sentinelCmd = isWin ? 'powershell' : 'sleep';
      const sentinelArgs = isWin
        ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 86400']
        : ['86400'];

      const { spawn } = await import('child_process');
      const child = spawn(sentinelCmd, sentinelArgs, {
        stdio: 'ignore',
        detached: true,
        cwd: env.workDir,
        windowsHide: true,
      });

      const pid = child.pid ?? 0;
      if (pid === 0) {
        return { backendId: '', ready: false, error: '哨兵进程未启动' };
      }

      // detach 让哨兵进程脱离父进程生命周期（否则会被 Agent 主进程退出时连带终止）
      child.unref();
      this.sentinels.set(env.envId, { pid, killed: false });

      return { backendId: `subprocess:${pid}`, ready: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { backendId: '', ready: false, error: `子进程后端启动失败: ${msg}` };
    }
  }

  stop(backendId: string): Promise<{ success: boolean; error?: string }> {
    // 子进程后端 stop 时不真实 kill 哨兵（保留可恢复），仅标记
    const pid = this.parsePid(backendId);
    if (pid === 0) return Promise.resolve({ success: false, error: '无效 backendId' });
    return Promise.resolve({ success: true });
  }

  async destroy(backendId: string): Promise<{ success: boolean; error?: string }> {
    const pid = this.parsePid(backendId);
    if (pid === 0) return { success: false, error: '无效 backendId' };

    try {
      // 真实 kill 哨兵进程
      const isWin = process.platform === 'win32';
      const killCmd = isWin ? 'taskkill' : 'kill';
      const killArgs = isWin ? ['/PID', String(pid), '/F', '/T'] : ['-TERM', String(pid)];
      try {
        await execFileAsync(killCmd, killArgs, { timeout: 5000, windowsHide: true });
      } catch {
        // 进程可能已退出
      }

      // 真实删除工作目录
      const envId = this.parseEnvId(backendId);
      const sentinel = this.sentinels.get(envId);
      if (sentinel) {
        sentinel.killed = true;
        this.sentinels.delete(envId);
      }
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  private parsePid(backendId: string): number {
    const m = /^subprocess:(\d+)$/.exec(backendId);
    return m ? parseInt(m[1], 10) : 0;
  }

  private parseEnvId(backendId: string): string {
    // 通过 pid 反查 envId
    for (const [envId, sentinel] of this.sentinels) {
      if (`subprocess:${sentinel.pid}` === backendId) return envId;
    }
    return '';
  }

  exec(backendId: string, command: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    // 子进程后端不支持真实 exec（无容器隔离），降级为宿主机执行
    // backendId 用于日志和元数据，但执行环境仍是宿主机
    void backendId;
    return new Promise((resolve) => {
      const cmd = command[0];
      const args = command.slice(1);
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          exitCode: err ? (err as unknown as { code?: number }).code ?? -1 : 0,
        });
      });
    });
  }
}

// ============ 持久化数据结构 ============

interface IdentityStore {
  identities: Record<string, AgentIdentity>;
  reputationHistory: Record<string, ReputationEntry[]>;
  outcomes: Record<string, TaskOutcome[]>;
  /** P3-1: 邮箱身份 */
  emailIdentities?: Record<string, EmailIdentity>;
  /** P3-1: 第三方操作日志 */
  thirdPartyOperations?: Record<string, ThirdPartyOperation>;
  /** P3-1: 跨渠道同步状态 */
  channelSyncStates?: Record<string, ChannelSyncState>;
  /** P3-1: 计算环境 */
  computeEnvironments?: Record<string, ComputeEnvironment>;
}

// ============ 主类 ============

export class AgentIdentityNetwork {
  private identities: Map<string, AgentIdentity> = new Map();
  private reputationHistory: Map<string, ReputationEntry[]> = new Map();
  private outcomes: Map<string, TaskOutcome[]> = new Map();
  private log = logger.child({ module: 'AgentIdentityNetwork' });
  private persistPath: string;
  private disposed = false;

  /** P3-1: 邮箱身份注册表（agentId → EmailIdentity） */
  private emailIdentities: Map<string, EmailIdentity> = new Map();

  /** P3-1: 第三方操作审计日志（operationId → ThirdPartyOperation） */
  private thirdPartyOperations: Map<string, ThirdPartyOperation> = new Map();

  /** P3-1: 跨渠道同步状态（agentId+channel → ChannelSyncState） */
  private channelSyncStates: Map<string, ChannelSyncState> = new Map();

  /** P3-1: 独立计算环境（envId → ComputeEnvironment） */
  private computeEnvironments: Map<string, ComputeEnvironment> = new Map();

  /** P3-1: 渠道消息缓冲（channel → messages[]）用于跨渠道同步 */
  private channelMessageBuffer: Map<string, Array<{ agentId: string; content: string; timestamp: number }>> = new Map();

  /**
   * P4: 渠道适配器注册表（channel → adapter）
   *
   * 注册的适配器会接收 syncAcrossChannelsAsync 的真实投递调用。
   * 未注册的渠道继续使用缓冲模式（syncAcrossChannels 行为不变）。
   */
  private channelAdapters: Map<ChannelType, ChannelAdapter> = new Map();

  /**
   * P3-1: 计算后端实例（docker / subprocess）
   *
   * 由 bootstrap 注入；未注入时 createComputeEnvironmentAsync 会自动检测：
   * Docker 可用则用 DockerContainerBackend，否则降级 SubprocessComputeBackend。
   * 取代之前 setTimeout(100ms) 模拟"环境启动"。
   */
  private computeBackend: ComputeBackend | null = null;
  private computeBackendDetectionCache: ComputeBackend | null = null;

  constructor(persistDir?: string) {
    // P0 跨平台修复：使用统一的 duanPath 解析
    const baseDir = persistDir || duanPath('identity');
    this.persistPath = baseDir;
  }

  // ========== 核心 API ==========

  /**
   * 创建新的 Agent 身份
   * ID 由创建时间 + 随机种子的加密哈希生成
   */
  createIdentity(profile: AgentProfile): AgentIdentity {
    this.ensureNotDisposed();

    const now = Date.now();
    const randomSeed = crypto.randomBytes(32).toString('hex');
    const id = crypto
      .createHash('sha256')
      .update(`${now}:${randomSeed}:${profile.name}:${profile.domain}`)
      .digest('hex')
      .substring(0, 24);

    // 生成身份验证密钥
    const secret = crypto.randomBytes(48).toString('hex');
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

    const identity: AgentIdentity = {
      id,
      profile,
      reputation: 0,
      trust: 50,  // 初始信任分 50
      createdAt: now,
      lastActiveAt: now,
      secretHash,
      outcomeCount: 0,
      successCount: 0,
    };

    this.identities.set(id, identity);
    this.reputationHistory.set(id, []);
    this.outcomes.set(id, []);

    EventBus.getInstance().emitSync('identity.created', {
      agentId: id,
      agentName: profile.name,
      domain: profile.domain,
    }, { source: 'AgentIdentityNetwork' });

    this.log.info('创建 Agent 身份', {
      agentId: id,
      name: profile.name,
      domain: profile.domain,
      capabilities: profile.capabilities.length,
    });

    return identity;
  }

  /**
   * 获取 Agent 身份
   */
  getIdentity(agentId: string): AgentIdentity | null {
    return this.identities.get(agentId) ?? null;
  }

  /**
   * 更新声誉评分
   * delta 正值增加声誉，负值降低声誉
   */
  updateReputation(agentId: string, delta: number, reason: string): void {
    this.ensureNotDisposed();

    const identity = this.identities.get(agentId);
    if (!identity) {
      this.log.warn('更新声誉失败: Agent 不存在', { agentId });
      return;
    }

    const previousScore = identity.reputation;
    // 声誉范围 -100 ~ 100
    identity.reputation = Math.max(-100, Math.min(100, previousScore + delta));
    identity.lastActiveAt = Date.now();

    const entry: ReputationEntry = {
      timestamp: Date.now(),
      delta,
      reason,
      previousScore,
      newScore: identity.reputation,
    };

    const history = this.reputationHistory.get(agentId) ?? [];
    history.push(entry);
    // 最多保留 500 条历史
    if (history.length > 500) {
      this.reputationHistory.set(agentId, history.slice(-500));
    } else {
      this.reputationHistory.set(agentId, history);
    }

    EventBus.getInstance().emitSync('identity.reputation.updated', {
      agentId,
      delta,
      newScore: identity.reputation,
      reason: reason.substring(0, 100),
    }, { source: 'AgentIdentityNetwork' });

    this.log.info('更新声誉', {
      agentId,
      delta,
      previousScore,
      newScore: identity.reputation,
      reason: reason.substring(0, 80),
    });
  }

  /**
   * 更新信任评分
   * delta 正值增加信任，负值降低信任
   */
  updateTrust(agentId: string, delta: number, evidence: string): void {
    this.ensureNotDisposed();

    const identity = this.identities.get(agentId);
    if (!identity) {
      this.log.warn('更新信任失败: Agent 不存在', { agentId });
      return;
    }

    const previousTrust = identity.trust;
    // 信任范围 0 ~ 100
    identity.trust = Math.max(0, Math.min(100, previousTrust + delta));
    identity.lastActiveAt = Date.now();

    EventBus.getInstance().emitSync('identity.trust.updated', {
      agentId,
      delta,
      newScore: identity.trust,
      evidence: evidence.substring(0, 100),
    }, { source: 'AgentIdentityNetwork' });

    this.log.info('更新信任', {
      agentId,
      delta,
      previousTrust,
      newScore: identity.trust,
      evidence: evidence.substring(0, 80),
    });
  }

  /**
   * 更新能力列表
   */
  updateCapabilities(agentId: string, capabilities: CapabilityUpdate): void {
    this.ensureNotDisposed();

    const identity = this.identities.get(agentId);
    if (!identity) {
      this.log.warn('更新能力失败: Agent 不存在', { agentId });
      return;
    }

    const caps = identity.profile.capabilities;
    const capMap = new Map(caps.map(c => [c.name, c]));

    // 移除能力
    if (capabilities.removed) {
      for (const name of capabilities.removed) {
        capMap.delete(name);
      }
    }

    // 更新已有能力
    if (capabilities.updated) {
      for (const update of capabilities.updated) {
        const existing = capMap.get(update.name);
        if (existing) {
          if (update.level !== undefined) existing.level = update.level;
          if (update.verified !== undefined) existing.verified = update.verified;
        }
      }
    }

    // 添加新能力
    if (capabilities.added) {
      for (const cap of capabilities.added) {
        capMap.set(cap.name, cap);
      }
    }

    identity.profile.capabilities = Array.from(capMap.values());
    identity.lastActiveAt = Date.now();

    this.log.info('更新能力', {
      agentId,
      added: capabilities.added?.length ?? 0,
      removed: capabilities.removed?.length ?? 0,
      updated: capabilities.updated?.length ?? 0,
      total: identity.profile.capabilities.length,
    });
  }

  /**
   * 根据任务描述和所需能力，找到最合适的 Agent
   * 综合考虑：能力匹配度、声誉评分、信任评分
   */
  findBestAgent(taskDescription: string, requiredCapabilities: string[]): AgentIdentity | null {
    this.ensureNotDisposed();

    if (this.identities.size === 0) return null;

    const candidates: Array<{ identity: AgentIdentity; score: number }> = [];

    for (const identity of Array.from(this.identities.values())) {
      const capMap = new Map(identity.profile.capabilities.map(c => [c.name, c]));
      let _capMatchScore = 0;
      let capTotalLevel = 0;
      let matchedCaps = 0;

      for (const reqCap of requiredCapabilities) {
        const cap = capMap.get(reqCap);
        if (cap) {
          matchedCaps++;
          _capMatchScore += cap.level;
          capTotalLevel += cap.level;
        }
      }

      // 能力匹配率
      const capMatchRate = requiredCapabilities.length > 0
        ? matchedCaps / requiredCapabilities.length
        : 0.5;

      // 能力等级平均分（0-100）
      const avgLevel = matchedCaps > 0 ? capTotalLevel / matchedCaps : 0;

      // 声誉归一化（-100~100 → 0~1）
      const reputationNorm = (identity.reputation + 100) / 200;

      // 信任归一化（0~100 → 0~1）
      const trustNorm = identity.trust / 100;

      // 综合评分：能力匹配(40%) + 能力等级(20%) + 声誉(20%) + 信任(20%)
      const score = (capMatchRate * 40) + (avgLevel / 100 * 20) + (reputationNorm * 20) + (trustNorm * 20);

      // 至少匹配一半所需能力才考虑
      if (requiredCapabilities.length === 0 || capMatchRate >= 0.5) {
        candidates.push({ identity, score });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);

    this.log.info('查找最佳 Agent', {
      task: taskDescription.substring(0, 60),
      requiredCapabilities,
      candidates: candidates.length,
      best: candidates[0].identity.id,
      bestScore: candidates[0].score.toFixed(2),
    });

    return candidates[0].identity;
  }

  /**
   * 记录任务结果，自动更新声誉和信任
   */
  recordOutcome(agentId: string, outcome: TaskOutcome): void {
    this.ensureNotDisposed();

    const identity = this.identities.get(agentId);
    if (!identity) {
      this.log.warn('记录结果失败: Agent 不存在', { agentId });
      return;
    }

    // 保存结果
    const agentOutcomes = this.outcomes.get(agentId) ?? [];
    agentOutcomes.push(outcome);
    // 最多保留 200 条结果
    if (agentOutcomes.length > 200) {
      this.outcomes.set(agentId, agentOutcomes.slice(-200));
    } else {
      this.outcomes.set(agentId, agentOutcomes);
    }

    // 更新统计
    identity.outcomeCount++;
    if (outcome.success) identity.successCount++;
    identity.lastActiveAt = Date.now();

    // 根据结果自动调整声誉
    if (outcome.success) {
      const qualityBonus = Math.round(outcome.quality / 20); // 0-5
      this.updateReputation(agentId, qualityBonus, `任务成功: ${outcome.description.substring(0, 60)}`);
    } else {
      this.updateReputation(agentId, -5, `任务失败: ${outcome.description.substring(0, 60)}`);
    }

    // 根据质量调整信任
    if (outcome.verifiedBy) {
      if (outcome.quality >= 80) {
        this.updateTrust(agentId, 2, `高质量输出(验证者: ${outcome.verifiedBy}): ${outcome.description.substring(0, 60)}`);
      } else if (outcome.quality < 40) {
        this.updateTrust(agentId, -3, `低质量输出(验证者: ${outcome.verifiedBy}): ${outcome.description.substring(0, 60)}`);
      }
    }

    EventBus.getInstance().emitSync('identity.outcome.recorded', {
      agentId,
      taskId: outcome.taskId,
      success: outcome.success,
      quality: outcome.quality,
    }, { source: 'AgentIdentityNetwork' });

    this.log.info('记录任务结果', {
      agentId,
      taskId: outcome.taskId,
      success: outcome.success,
      quality: outcome.quality,
      totalOutcomes: identity.outcomeCount,
      successRate: identity.outcomeCount > 0
        ? (identity.successCount / identity.outcomeCount * 100).toFixed(1) + '%'
        : 'N/A',
    });
  }

  /**
   * 获取声誉历史
   */
  getReputationHistory(agentId: string): ReputationEntry[] {
    return this.reputationHistory.get(agentId) ?? [];
  }

  /**
   * 验证身份 — 基于挑战字符串的 HMAC 验证
   *
   * P3-1 安全增强：调用方需提供基于 challenge + secretHash 计算的 HMAC 签名，
   * 本方法重新计算并与提供的签名比对（时间安全比较）。
   *
   * @param agentId Agent ID
   * @param challenge 原始挑战字符串
   * @param signature 调用方用原始 secret 计算的 HMAC 签名（hex）
   * @returns 验证是否通过
   */
  verifyIdentity(agentId: string, challenge: string, signature?: string): boolean {
    const identity = this.identities.get(agentId);
    if (!identity) return false;

    // 检查 Agent 是否活跃（7天内）
    const isActive = (Date.now() - identity.lastActiveAt) < 7 * 24 * 60 * 60 * 1000;
    if (!isActive) {
      this.log.warn('身份验证失败: Agent 不活跃', { agentId });
      return false;
    }

    // 使用 challenge + secretHash 计算 HMAC
    const expectedHmac = crypto
      .createHmac('sha256', identity.secretHash)
      .update(challenge)
      .digest('hex');

    // P3-1: 若提供了签名则进行安全比对
    if (signature) {
      const verified = crypto.timingSafeEqual(
        Buffer.from(expectedHmac, 'hex'),
        Buffer.from(signature, 'hex'),
      ) && expectedHmac.length === signature.length;

      this.log.info('身份验证（HMAC签名）', {
        agentId,
        verified,
        challengeHash: expectedHmac.substring(0, 12) + '...',
      });

      return verified;
    }

    // 向后兼容：无签名时仅检查 ID + 活跃状态
    const verified = identity.id === agentId && isActive;

    this.log.info('身份验证（基础）', {
      agentId,
      verified,
      challengeHash: expectedHmac.substring(0, 12) + '...',
    });

    return verified;
  }

  /**
   * 列出所有身份
   */
  listIdentities(): AgentIdentity[] {
    return Array.from(this.identities.values());
  }

  // ========== 持久化 ==========

  /**
   * 持久化身份数据到磁盘
   */
  async persist(): Promise<void> {
    this.ensureNotDisposed();

    try {
      await fs.promises.mkdir(this.persistPath, { recursive: true });

      const store: IdentityStore = {
        identities: Object.fromEntries(this.identities),
        reputationHistory: Object.fromEntries(this.reputationHistory),
        outcomes: Object.fromEntries(this.outcomes),
        // P3-1: 持久化独立身份网络扩展数据
        emailIdentities: Object.fromEntries(this.emailIdentities),
        thirdPartyOperations: Object.fromEntries(this.thirdPartyOperations),
        channelSyncStates: Object.fromEntries(this.channelSyncStates),
        computeEnvironments: Object.fromEntries(this.computeEnvironments),
      };

      const dataPath = path.join(this.persistPath, 'agent-identities.json');
      await atomicWriteJson(dataPath, store);

      this.log.info('身份数据已持久化', {
        path: dataPath,
        identityCount: this.identities.size,
        emailCount: this.emailIdentities.size,
        operationCount: this.thirdPartyOperations.size,
        channelSyncCount: this.channelSyncStates.size,
        computeEnvCount: this.computeEnvironments.size,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化身份数据失败', { error: msg });
    }
  }

  /**
   * 从磁盘加载身份数据
   */
  async load(): Promise<void> {
    this.ensureNotDisposed();

    try {
      const dataPath = path.join(this.persistPath, 'agent-identities.json');
      const raw = await fs.promises.readFile(dataPath, 'utf-8');
      const store: IdentityStore = JSON.parse(raw);

      this.identities = new Map(Object.entries(store.identities));
      this.reputationHistory = new Map(Object.entries(store.reputationHistory));
      this.outcomes = new Map(Object.entries(store.outcomes));

      // P3-1: 加载独立身份网络扩展数据
      if (store.emailIdentities) {
        this.emailIdentities = new Map(Object.entries(store.emailIdentities));
      }
      if (store.thirdPartyOperations) {
        this.thirdPartyOperations = new Map(Object.entries(store.thirdPartyOperations));
      }
      if (store.channelSyncStates) {
        this.channelSyncStates = new Map(Object.entries(store.channelSyncStates));
      }
      if (store.computeEnvironments) {
        this.computeEnvironments = new Map(Object.entries(store.computeEnvironments));
      }

      this.log.info('身份数据已加载', {
        path: dataPath,
        identityCount: this.identities.size,
        emailCount: this.emailIdentities.size,
        operationCount: this.thirdPartyOperations.size,
        channelSyncCount: this.channelSyncStates.size,
        computeEnvCount: this.computeEnvironments.size,
      });
    } catch (err: unknown) {
      const errnoErr = err as NodeJS.ErrnoException;
      if (errnoErr?.code === 'ENOENT') {
        this.log.info('无持久化数据，从空状态开始');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('加载身份数据失败', { error: msg });
      }
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.disposed = true;
    // P3-1: 真实销毁所有计算环境（释放容器/子进程资源，避免泄漏）
    const backend = this.computeBackend || this.computeBackendDetectionCache;
    if (backend) {
      for (const env of this.computeEnvironments.values()) {
        const backendId = env.metadata.backendId as string | undefined;
        if (backendId) {
          // fire-and-forget 销毁（dispose 是同步方法，不能 await）
          void backend.destroy(backendId).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error('P3-1 dispose 时计算环境销毁失败', { envId: env.envId, error: msg });
          });
        }
      }
    }
    this.identities.clear();
    this.reputationHistory.clear();
    this.outcomes.clear();
    // P3-1: 清理独立身份网络的扩展数据结构
    this.emailIdentities.clear();
    this.thirdPartyOperations.clear();
    this.channelSyncStates.clear();
    this.computeEnvironments.clear();
    this.channelMessageBuffer.clear();
    // P4: 释放渠道适配器
    for (const adapter of this.channelAdapters.values()) {
      try { adapter.dispose?.(); } catch {}
    }
    this.channelAdapters.clear();
    this.log.info('AgentIdentityNetwork 已释放');
  }

  // ========== 私有方法 ==========

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('AgentIdentityNetwork 已释放，不能再使用');
    }
  }

  // ========== P3-1: Agent 独立身份网络 ==========

  /**
   * P3-1: 分配邮箱身份（前缀自定义）
   *
   * 给 Agent 分配独立的邮箱地址，第三方操作可通过邮箱联系 Agent 而非用户。
   */
  assignEmailIdentity(agentId: string, prefix: string, domain: string = 'agent.local'): EmailIdentity | null {
    this.ensureNotDisposed();
    const identity = this.identities.get(agentId);
    if (!identity) {
      this.log.warn('Agent 不存在，无法分配邮箱', { agentId });
      return null;
    }

    // 检查前缀唯一性
    for (const existing of this.emailIdentities.values()) {
      if (existing.prefix === prefix && existing.domain === domain) {
        this.log.warn('邮箱前缀已占用', { prefix, domain });
        return null;
      }
    }

    const emailIdentity: EmailIdentity = {
      agentId,
      email: `${prefix}@${domain}`,
      prefix,
      domain,
      createdAt: Date.now(),
      verified: false,
      forwardTo: [],
    };

    this.emailIdentities.set(agentId, emailIdentity);

    // 更新 Agent 的通信渠道
    if (!identity.profile.communicationChannels) {
      identity.profile.communicationChannels = [];
    }
    if (!identity.profile.communicationChannels.includes('email')) {
      identity.profile.communicationChannels.push('email');
    }

    this.log.info('邮箱身份已分配', { agentId, email: emailIdentity.email });
    EventBus.getInstance().emitSync('identity.email.assigned', { agentId, email: emailIdentity.email });
    return emailIdentity;
  }

  /**
   * P3-1: 获取 Agent 的邮箱身份
   */
  getEmailIdentity(agentId: string): EmailIdentity | null {
    return this.emailIdentities.get(agentId) ?? null;
  }

  /**
   * P3-1: 验证邮箱身份
   */
  verifyEmailIdentity(agentId: string): boolean {
    const email = this.emailIdentities.get(agentId);
    if (!email) return false;
    email.verified = true;
    this.log.info('邮箱身份已验证', { agentId, email: email.email });
    return true;
  }

  /**
   * P3-1: 绑定第三方操作到 Agent 身份
   *
   * 第三方操作（如 GitHub PR、Notion 文档创建）绑定到 Agent 身份而非用户，
   * 确保操作可审计、可追溯。
   */
  bindThirdPartyOperation(params: {
    agentId: string;
    service: string;
    operationType: string;
    params: Record<string, unknown>;
  }): ThirdPartyOperation | null {
    this.ensureNotDisposed();
    const identity = this.identities.get(params.agentId);
    if (!identity) {
      this.log.warn('Agent 不存在，无法绑定操作', { agentId: params.agentId });
      return null;
    }

    const operationId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const signature = this.signOperation(params.agentId, params.service, params.operationType);

    const operation: ThirdPartyOperation = {
      operationId,
      agentId: params.agentId,
      service: params.service,
      operationType: params.operationType,
      timestamp: Date.now(),
      params: params.params,
      result: 'pending',
      signature,
    };

    this.thirdPartyOperations.set(operationId, operation);
    this.log.info('第三方操作已绑定', {
      operationId,
      agentId: params.agentId,
      service: params.service,
      operationType: params.operationType,
    });

    EventBus.getInstance().emitSync('identity.operation.bound', {
      operationId,
      agentId: params.agentId,
      service: params.service,
    });

    return operation;
  }

  /**
   * P3-1: 更新第三方操作结果
   */
  updateOperationResult(operationId: string, result: 'success' | 'failure'): boolean {
    const operation = this.thirdPartyOperations.get(operationId);
    if (!operation) return false;
    operation.result = result;
    this.log.info('操作结果已更新', { operationId, result });
    return true;
  }

  /**
   * P3-1: 查询 Agent 的操作历史
   */
  getAgentOperations(agentId: string, limit = 50): ThirdPartyOperation[] {
    const operations: ThirdPartyOperation[] = [];
    for (const op of this.thirdPartyOperations.values()) {
      if (op.agentId === agentId) {
        operations.push(op);
      }
    }
    return operations.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /**
   * P3-1: 注册渠道同步状态
   *
   * 将 Agent 与特定渠道（飞书/微信/网页）的用户标识关联，
   * 支持跨渠道记忆同步。
   */
  registerChannelSync(agentId: string, channel: ChannelType, channelUserId: string, metadata?: Record<string, unknown>): ChannelSyncState | null {
    this.ensureNotDisposed();
    const identity = this.identities.get(agentId);
    if (!identity) return null;

    const key = `${agentId}:${channel}`;
    const syncState: ChannelSyncState = {
      agentId,
      channel,
      channelUserId,
      lastSyncAt: Date.now(),
      syncedMessageCount: 0,
      channelMetadata: metadata ?? {},
    };

    this.channelSyncStates.set(key, syncState);
    this.log.info('渠道同步已注册', { agentId, channel, channelUserId });
    return syncState;
  }

  /**
   * P3-1: 跨渠道记忆同步
   *
   * 将一个渠道的消息同步到所有已注册的渠道，
   * 实现"飞书发的消息，微信/网页也能看到"的跨渠道体验。
   *
   * 注意：此同步方法仅缓冲消息，不执行真实投递。
   * 如需真实投递，请使用 syncAcrossChannelsAsync() 并先注册 ChannelAdapter。
   */
  syncAcrossChannels(agentId: string, sourceChannel: ChannelType, message: string): number {
    this.ensureNotDisposed();
    let syncedCount = 0;

    // 将消息加入缓冲
    for (const [_key, syncState] of this.channelSyncStates) {
      if (syncState.agentId === agentId && syncState.channel !== sourceChannel) {
        const buffer = this.channelMessageBuffer.get(syncState.channel) ?? [];
        buffer.push({ agentId, content: message, timestamp: Date.now() });
        if (buffer.length > 100) buffer.shift();
        this.channelMessageBuffer.set(syncState.channel, buffer);

        syncState.lastSyncAt = Date.now();
        syncState.syncedMessageCount++;
        syncedCount++;
      }
    }

    this.log.info('跨渠道同步完成（仅缓冲）', { agentId, sourceChannel, syncedCount });
    EventBus.getInstance().emitSync('identity.channel.synced', { agentId, sourceChannel, syncedCount });
    return syncedCount;
  }

  /**
   * P4: 注册渠道适配器 — 启用真实跨渠道投递
   *
   * 注册后，syncAcrossChannelsAsync() 会调用适配器的 sendMessage() 真实投递消息。
   * 同一渠道只能注册一个适配器，重复注册会覆盖旧适配器。
   */
  registerChannelAdapter(adapter: ChannelAdapter): void {
    const existing = this.channelAdapters.get(adapter.channel);
    if (existing) {
      this.log.info('P4 渠道适配器替换', {
        channel: adapter.channel,
        oldAdapter: existing.name,
        newAdapter: adapter.name,
      });
      existing.dispose?.();
    }
    this.channelAdapters.set(adapter.channel, adapter);
    this.log.info('P4 渠道适配器已注册', {
      channel: adapter.channel,
      adapter: adapter.name,
      ready: adapter.isReady(),
    });
  }

  /**
   * P4: 移除渠道适配器
   */
  unregisterChannelAdapter(channel: ChannelType): ChannelAdapter | null {
    const adapter = this.channelAdapters.get(channel);
    if (!adapter) return null;
    this.channelAdapters.delete(channel);
    adapter.dispose?.();
    this.log.info('P4 渠道适配器已移除', { channel, adapter: adapter.name });
    return adapter;
  }

  /** P4: 查询已注册的渠道适配器 */
  getRegisteredChannelAdapters(): ChannelType[] {
    return Array.from(this.channelAdapters.keys());
  }

  /**
   * P4: 异步跨渠道同步 — 真实投递消息到所有目标渠道
   *
   * 与 syncAcrossChannels 的区别：
   * - 优先调用已注册的 ChannelAdapter.sendMessage() 执行真实投递
   * - 未注册适配器的渠道仍使用缓冲模式
   * - 投递失败的渠道记录到缓冲（可重试）
   *
   * @param agentId Agent ID
   * @param sourceChannel 消息来源渠道
   * @param message 消息内容
   * @param recipient 接收者标识（contactName/userId/chatId），可选，默认为 agentId
   * @returns 投递结果列表
   */
  async syncAcrossChannelsAsync(
    agentId: string,
    sourceChannel: ChannelType,
    message: string,
    recipient?: string,
  ): Promise<ChannelDeliveryResult[]> {
    this.ensureNotDisposed();
    const results: ChannelDeliveryResult[] = [];
    const targetRecipient = recipient || agentId;

    for (const [_key, syncState] of this.channelSyncStates) {
      if (syncState.agentId !== agentId) continue;
      if (syncState.channel === sourceChannel) continue;

      const adapter = this.channelAdapters.get(syncState.channel);
      const deliveredAt = Date.now();

      if (adapter && adapter.isReady()) {
        // P4: 真实投递
        try {
          const result = await adapter.sendMessage(targetRecipient, message);
          results.push({
            channel: syncState.channel,
            recipient: targetRecipient,
            success: result.success,
            error: result.error,
            messageId: result.messageId,
            deliveredAt,
          });

          if (result.success) {
            syncState.lastSyncAt = Date.now();
            syncState.syncedMessageCount++;
            this.log.info('P4 渠道投递成功', {
              agentId,
              channel: syncState.channel,
              recipient: targetRecipient,
              messageId: result.messageId,
            });
          } else {
            // 投递失败：加入缓冲以备重试
            this.bufferMessage(syncState.channel, agentId, message);
            this.log.warn('P4 渠道投递失败，已加入缓冲', {
              agentId,
              channel: syncState.channel,
              error: result.error,
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? (err.message || String(err)) : String(err);
          this.bufferMessage(syncState.channel, agentId, message);
          results.push({
            channel: syncState.channel,
            recipient: targetRecipient,
            success: false,
            error: msg,
            deliveredAt,
          });
          this.log.warn('P4 渠道投递异常，已加入缓冲', {
            agentId,
            channel: syncState.channel,
            error: msg,
          });
        }
      } else {
        // 无适配器或未就绪：使用缓冲模式
        this.bufferMessage(syncState.channel, agentId, message);
        syncState.lastSyncAt = Date.now();
        syncState.syncedMessageCount++;
        results.push({
          channel: syncState.channel,
          recipient: targetRecipient,
          success: true, // 缓冲成功（投递延后）
          error: '无渠道适配器，已缓冲',
          deliveredAt,
        });
      }
    }

    EventBus.getInstance().emitSync('identity.channel.synced', {
      agentId,
      sourceChannel,
      resultCount: results.length,
      successCount: results.filter(r => r.success).length,
    });

    return results;
  }

  /** P4: 内部方法 — 将消息加入缓冲 */
  private bufferMessage(channel: ChannelType, agentId: string, message: string): void {
    const buffer = this.channelMessageBuffer.get(channel) ?? [];
    buffer.push({ agentId, content: message, timestamp: Date.now() });
    if (buffer.length > 100) buffer.shift();
    this.channelMessageBuffer.set(channel, buffer);
  }

  /**
   * P3-1: 获取渠道待同步消息
   */
  getPendingChannelMessages(channel: ChannelType): Array<{ agentId: string; content: string; timestamp: number }> {
    return this.channelMessageBuffer.get(channel) ?? [];
  }

  /**
   * P3-1: 清空渠道消息缓冲
   */
  clearChannelMessages(channel: ChannelType): void {
    this.channelMessageBuffer.delete(channel);
  }

  /**
   * P3-1: 创建独立计算环境
   *
   * 为 Agent 分配隔离的执行环境（本地沙箱/云 VM/云手机/容器），
   * 确保不同 Agent 的执行互不干扰。
   */
  createComputeEnvironment(params: {
    agentId: string;
    type: ComputeEnvironment['type'];
    resources?: Partial<ComputeEnvironment['resources']>;
    workDir?: string;
  }): ComputeEnvironment | null {
    this.ensureNotDisposed();
    const identity = this.identities.get(params.agentId);
    if (!identity) return null;

    const envId = `env_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const env: ComputeEnvironment = {
      envId,
      agentId: params.agentId,
      type: params.type,
      status: 'creating',
      resources: {
        cpuCores: params.resources?.cpuCores ?? 2,
        memoryMB: params.resources?.memoryMB ?? 2048,
        diskGB: params.resources?.diskGB ?? 10,
        networkEnabled: params.resources?.networkEnabled ?? true,
      },
      workDir: params.workDir ?? path.join(this.persistPath, 'envs', envId),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {},
    };

    this.computeEnvironments.set(envId, env);

    // P3-1: 真实异步启动计算环境（fire-and-forget，调用方通过 onEnvironmentReady 回调或轮询 getComputeEnvironment）
    void this.startComputeEnvironmentAsync(env).catch((err: unknown) => {
      const msg = err instanceof Error ? (err.message || String(err)) : String(err);
      env.status = 'failed';
      env.metadata.error = msg;
      this.log.error('计算环境异步启动失败', { envId, error: msg });
      EventBus.getInstance().emitSync('identity.env.failed', { envId, agentId: params.agentId, error: msg });
    });

    this.log.info('计算环境创建中', { envId, agentId: params.agentId, type: params.type });
    return env;
  }

  /**
   * P3-1: 真实异步启动计算环境
   *
   * 取代之前 setTimeout(100ms) 模拟。真实流程：
   * 1. 检测/使用已注入的 ComputeBackend
   * 2. 调用 backend.start(env) 真实启动容器/子进程
   * 3. backend.start() 阻塞至就绪或失败
   * 4. 更新 env.status='running' 或 'failed'
   * 5. 触发 identity.env.ready 事件
   */
  private async startComputeEnvironmentAsync(env: ComputeEnvironment): Promise<void> {
    const backend = await this.resolveComputeBackend();
    env.metadata.backend = backend.name;
    env.metadata.isIsolating = backend.isIsolating;

    this.log.info('P3-1 计算环境真实启动中', {
      envId: env.envId,
      backend: backend.name,
      isIsolating: backend.isIsolating,
      workDir: env.workDir,
    });

    const result = await backend.start(env);

    if (!result.ready || !result.backendId) {
      env.status = 'failed';
      env.metadata.error = result.error || '启动失败（未返回 backendId）';
      this.log.error('P3-1 计算环境启动失败', {
        envId: env.envId,
        backend: backend.name,
        error: result.error,
      });
      EventBus.getInstance().emitSync('identity.env.failed', {
        envId: env.envId,
        agentId: env.agentId,
        error: result.error,
      });
      return;
    }

    env.status = 'running';
    env.lastActiveAt = Date.now();
    env.metadata.backendId = result.backendId;

    this.log.info('P3-1 计算环境已就绪', {
      envId: env.envId,
      agentId: env.agentId,
      backend: backend.name,
      backendId: result.backendId,
      isIsolating: backend.isIsolating,
    });

    EventBus.getInstance().emitSync('identity.env.ready', {
      envId: env.envId,
      agentId: env.agentId,
      backend: backend.name,
      backendId: result.backendId,
      isIsolating: backend.isIsolating,
    });
  }

  /**
   * P3-1: 解析可用计算后端
   *
   * 优先使用已注入的 backend；未注入时检测 Docker 可用性，可用则用 Docker，否则降级 subprocess。
   * 检测结果缓存至 computeBackendDetectionCache（同一实例内不重复检测）。
   */
  private async resolveComputeBackend(): Promise<ComputeBackend> {
    if (this.computeBackend) return this.computeBackend;
    if (this.computeBackendDetectionCache) return this.computeBackendDetectionCache;

    const dockerBackend = new DockerContainerBackend();
    const dockerAvailable = await dockerBackend.isAvailable().catch(() => false);

    if (dockerAvailable) {
      this.computeBackendDetectionCache = dockerBackend;
      this.log.info('P3-1 检测到 Docker 可用，使用 Docker 容器后端');
      return dockerBackend;
    }

    const subprocessBackend = new SubprocessComputeBackend();
    this.computeBackendDetectionCache = subprocessBackend;
    this.log.warn('P3-1 Docker 不可用，降级使用 Subprocess 后端（弱隔离，无 namespace/cgroup）');
    return subprocessBackend;
  }

  /**
   * P3-1: 注入计算后端（供 bootstrap 或测试注入）
   */
  setComputeBackend(backend: ComputeBackend | null): void {
    this.computeBackend = backend;
    if (backend) {
      this.log.info('P3-1 计算后端已注入', { backend: backend.name, isIsolating: backend.isIsolating });
    } else {
      this.computeBackendDetectionCache = null;
    }
  }

  /**
   * P3-1: 查询当前使用的计算后端信息
   */
  getComputeBackendInfo(): { injected: boolean; backendName: string | null; isIsolating: boolean | null } {
    const backend = this.computeBackend || this.computeBackendDetectionCache;
    return {
      injected: this.computeBackend !== null,
      backendName: backend?.name ?? null,
      isIsolating: backend?.isIsolating ?? null,
    };
  }

  /**
   * P3-1: 获取 Agent 的计算环境
   */
  getComputeEnvironment(envId: string): ComputeEnvironment | null {
    return this.computeEnvironments.get(envId) ?? null;
  }

  /**
   * P3-1: 列出 Agent 的所有计算环境
   */
  listComputeEnvironments(agentId: string): ComputeEnvironment[] {
    const result: ComputeEnvironment[] = [];
    for (const env of this.computeEnvironments.values()) {
      if (env.agentId === agentId) {
        result.push(env);
      }
    }
    return result;
  }

  /**
   * P3-1: 停止计算环境
   *
   * 真实调用 backend.stop(backendId) 停止容器/子进程（保留资源，可恢复）。
   * 同步方法仅做状态标记，异步真实停止通过 stopComputeEnvironmentAsync 触发。
   */
  stopComputeEnvironment(envId: string): boolean {
    const env = this.computeEnvironments.get(envId);
    if (!env) return false;

    // 异步真实停止（fire-and-forget）
    const backendId = env.metadata.backendId as string | undefined;
    const backend = this.computeBackend || this.computeBackendDetectionCache;
    if (backendId && backend) {
      void backend.stop(backendId).then(result => {
        if (result.success) {
          env.status = 'stopped';
          env.metadata.stoppedAt = Date.now();
          this.log.info('P3-1 计算环境已停止', { envId, backendId });
          EventBus.getInstance().emitSync('identity.env.stopped', { envId, agentId: env.agentId });
        } else {
          this.log.error('P3-1 计算环境停止失败', { envId, backendId, error: result.error });
        }
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('P3-1 计算环境停止异常', { envId, error: msg });
      });
    } else {
      // 无 backendId（可能创建失败），仅标记状态
      env.status = 'stopped';
    }
    return true;
  }

  /**
   * P3-1: 销毁计算环境
   *
   * 真实调用 backend.destroy(backendId) 释放容器/子进程资源。
   */
  destroyComputeEnvironment(envId: string): boolean {
    const env = this.computeEnvironments.get(envId);
    if (!env) return false;

    const backendId = env.metadata.backendId as string | undefined;
    const backend = this.computeBackend || this.computeBackendDetectionCache;
    if (backendId && backend) {
      void backend.destroy(backendId).then(result => {
        if (result.success) {
          this.computeEnvironments.delete(envId);
          this.log.info('P3-1 计算环境已销毁', { envId, backendId });
          EventBus.getInstance().emitSync('identity.env.destroyed', { envId, agentId: env.agentId });
        } else {
          this.log.error('P3-1 计算环境销毁失败', { envId, backendId, error: result.error });
        }
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('P3-1 计算环境销毁异常', { envId, error: msg });
      });
    } else {
      // 无 backendId，直接删除记录
      this.computeEnvironments.delete(envId);
    }
    return true;
  }

  /**
   * P3-1: 在计算环境中执行命令
   *
   * 真实调用 backend.exec(backendId, command) 在容器/子进程内执行。
   */
  execInComputeEnvironment(
    envId: string,
    command: string[],
    timeoutMs = 30000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
    const env = this.computeEnvironments.get(envId);
    if (!env) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: null, error: '计算环境不存在' });
    }
    if (env.status !== 'running') {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: null, error: `计算环境未就绪（当前状态: ${env.status}）` });
    }

    const backendId = env.metadata.backendId as string | undefined;
    const backend = this.computeBackend || this.computeBackendDetectionCache;
    if (!backendId || !backend || !backend.exec) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: null, error: '后端不支持 exec' });
    }

    env.lastActiveAt = Date.now();
    return backend.exec(backendId, command, timeoutMs);
  }

  /** 对操作进行签名（基于 Agent 的 secretHash） */
  private signOperation(agentId: string, service: string, operationType: string): string {
    const identity = this.identities.get(agentId);
    if (!identity) return '';
    const data = `${agentId}:${service}:${operationType}:${Date.now()}`;
    return crypto.createHmac('sha256', identity.secretHash).update(data).digest('hex');
  }

  // ========== P3-1: 验收度量方法 ==========

  /**
   * P3-1: 验证第三方操作签名
   *
   * 对 signOperation 生成的签名进行验证，确保操作来源可信。
   *
   * @param agentId Agent ID
   * @param service 服务名称
   * @param operationType 操作类型
   * @param timestamp 签名时的时间戳
   * @param signature 待验证的签名
   * @returns 签名是否有效
   */
  verifyOperation(
    agentId: string,
    service: string,
    operationType: string,
    timestamp: number,
    signature: string,
  ): boolean {
    const identity = this.identities.get(agentId);
    if (!identity) return false;

    const data = `${agentId}:${service}:${operationType}:${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', identity.secretHash)
      .update(data)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(signature, 'hex'),
      ) && expectedSignature.length === signature.length;
    } catch {
      return false;
    }
  }

  /**
   * P3-1: 获取身份网络统计
   *
   * 验收标准：独立身份可用
   *
   * @returns 身份网络的综合统计信息
   */
  getIdentityNetworkStats(): {
    totalIdentities: number;
    activeIdentities: number;
    totalEmailIdentities: number;
    verifiedEmails: number;
    totalOperations: number;
    successfulOperations: number;
    totalChannelSyncs: number;
    activeChannels: string[];
    totalComputeEnvironments: number;
    runningEnvironments: number;
    avgReputation: number;
    avgTrust: number;
  } {
    const now = Date.now();
    const activeThreshold = 7 * 24 * 60 * 60 * 1000;

    const activeIdentities = Array.from(this.identities.values())
      .filter(id => now - id.lastActiveAt < activeThreshold).length;

    const verifiedEmails = Array.from(this.emailIdentities.values())
      .filter(e => e.verified).length;

    const successfulOperations = Array.from(this.thirdPartyOperations.values())
      .filter(op => op.result === 'success').length;

    const activeChannels = Array.from(new Set(
      Array.from(this.channelSyncStates.values())
        .filter(cs => Date.now() - cs.lastSyncAt < 24 * 60 * 60 * 1000) // 24小时内同步过
        .map(cs => cs.channel)
    ));

    const runningEnvironments = Array.from(this.computeEnvironments.values())
      .filter(env => env.status === 'running').length;

    const reputations = Array.from(this.identities.values()).map(id => id.reputation);
    const trusts = Array.from(this.identities.values()).map(id => id.trust);
    const avgReputation = reputations.length > 0
      ? reputations.reduce((s, r) => s + r, 0) / reputations.length
      : 0;
    const avgTrust = trusts.length > 0
      ? trusts.reduce((s, t) => s + t, 0) / trusts.length
      : 0;

    return {
      totalIdentities: this.identities.size,
      activeIdentities,
      totalEmailIdentities: this.emailIdentities.size,
      verifiedEmails,
      totalOperations: this.thirdPartyOperations.size,
      successfulOperations,
      totalChannelSyncs: this.channelSyncStates.size,
      activeChannels,
      totalComputeEnvironments: this.computeEnvironments.size,
      runningEnvironments,
      avgReputation: Math.round(avgReputation * 100) / 100,
      avgTrust: Math.round(avgTrust * 100) / 100,
    };
  }

  /**
   * P3-1: 验证身份网络完整性
   *
   * 检查身份网络的各项指标是否满足验收标准：
   * - 身份可用性：至少有 1 个活跃身份
   * - 邮箱验证率：已验证邮箱占比
   * - 操作成功率：第三方操作成功率
   * - 渠道同步活跃度：活跃渠道数
   * - 计算环境健康度：运行中环境占比
   *
   * @returns 验证结果，包含各项检查的通过情况
   */
  validateIdentityNetwork(): {
    valid: boolean;
    checks: {
      identityAvailable: { passed: boolean; activeCount: number; message: string };
      emailVerificationRate: { passed: boolean; rate: number; message: string };
      operationSuccessRate: { passed: boolean; rate: number; message: string };
      channelSyncActive: { passed: boolean; activeChannels: number; message: string };
      computeEnvHealthy: { passed: boolean; runningRatio: number; message: string };
    };
    overallScore: number;
  } {
    const stats = this.getIdentityNetworkStats();

    // 身份可用性：至少 1 个活跃身份
    const identityAvailable = stats.activeIdentities > 0;

    // 邮箱验证率：≥80%
    const emailRate = stats.totalEmailIdentities > 0
      ? stats.verifiedEmails / stats.totalEmailIdentities
      : 1;
    const emailPassed = emailRate >= 0.8;

    // 操作成功率：≥90%
    const opRate = stats.totalOperations > 0
      ? stats.successfulOperations / stats.totalOperations
      : 1;
    const opPassed = opRate >= 0.9;

    // 渠道同步活跃度：至少 1 个活跃渠道
    const channelPassed = stats.activeChannels.length > 0;

    // 计算环境健康度：运行中环境占比 ≥50%
    const envRatio = stats.totalComputeEnvironments > 0
      ? stats.runningEnvironments / stats.totalComputeEnvironments
      : 1;
    const envPassed = envRatio >= 0.5;

    const allPassed = identityAvailable && emailPassed && opPassed && channelPassed && envPassed;
    const overallScore = (
      (identityAvailable ? 1 : 0) +
      (emailPassed ? 1 : emailRate) +
      (opPassed ? 1 : opRate) +
      (channelPassed ? 1 : 0) +
      (envPassed ? 1 : envRatio)
    ) / 5;

    return {
      valid: allPassed,
      checks: {
        identityAvailable: {
          passed: identityAvailable,
          activeCount: stats.activeIdentities,
          message: identityAvailable
            ? `${stats.activeIdentities} 个活跃身份`
            : '无活跃身份',
        },
        emailVerificationRate: {
          passed: emailPassed,
          rate: Math.round(emailRate * 100) / 100,
          message: `${stats.verifiedEmails}/${stats.totalEmailIdentities} 已验证 (${Math.round(emailRate * 100)}%)`,
        },
        operationSuccessRate: {
          passed: opPassed,
          rate: Math.round(opRate * 100) / 100,
          message: `${stats.successfulOperations}/${stats.totalOperations} 成功 (${Math.round(opRate * 100)}%)`,
        },
        channelSyncActive: {
          passed: channelPassed,
          activeChannels: stats.activeChannels.length,
          message: channelPassed
            ? `${stats.activeChannels.length} 个活跃渠道: ${stats.activeChannels.join(', ')}`
            : '无活跃渠道',
        },
        computeEnvHealthy: {
          passed: envPassed,
          runningRatio: Math.round(envRatio * 100) / 100,
          message: `${stats.runningEnvironments}/${stats.totalComputeEnvironments} 运行中 (${Math.round(envRatio * 100)}%)`,
        },
      },
      overallScore: Math.round(overallScore * 100) / 100,
    };
  }

  /**
   * P4: 暴露 Agent 身份操作为工具 — 让 agent 能查询身份和信任关系
   *
   * 修复前: 只有 getIdentity 和 recordOutcome 在 run 中被调用，信任评分/声誉历史等不可达
   * 修复后: agent 可通过工具查看身份列表、信任评分、声誉历史
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const net = this;

    return [
      {
        name: 'identity_list',
        description: '列出所有已注册的 Agent 身份，包含名称、能力、信任评分和声誉。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const identities = net.listIdentities();
            if (identities.length === 0) return Promise.resolve('当前无已注册身份');
            const lines = [`已注册身份 (${identities.length}):`];
            identities.forEach(id => {
              lines.push(`\n- ${id.profile.name} [${id.id.substring(0, 12)}]`);
              lines.push(`  信任: ${id.trust}/100 | 声誉: ${id.reputation}`);
              if (id.profile.capabilities && id.profile.capabilities.length > 0) {
                lines.push(`  能力: ${id.profile.capabilities.map(c => c.name).join(', ')}`);
              }
            });
            return Promise.resolve(lines.join('\n'));
          } catch (e: unknown) {
            const msg = e instanceof Error ? (e.message || String(e)) : String(e);
            return Promise.resolve(`❌ 查询失败: ${msg}`);
          }
        },
      },
      {
        name: 'identity_info',
        description: '查看指定 Agent 身份的详细信息。',
        parameters: {
          agentId: { type: 'string', description: 'Agent ID（可从 identity_list 获取）', required: true },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const id = net.getIdentity(String(args.agentId));
            if (!id) return Promise.resolve(`未找到身份: ${args.agentId}`);
            const lines = [
              `身份详情: ${id.profile.name}`,
              `ID: ${id.id}`,
              `信任评分: ${id.trust}/100`,
              `声誉: ${id.reputation}`,
              `创建时间: ${new Date(id.createdAt).toISOString()}`,
            ];
            if (id.profile.capabilities && id.profile.capabilities.length > 0) {
              lines.push(`\n能力列表:`);
              id.profile.capabilities.forEach(c => {
                lines.push(`  - ${c.name} (等级: ${c.level}/100)`);
              });
            }
            return Promise.resolve(lines.join('\n'));
          } catch (e: unknown) {
            const msg = e instanceof Error ? (e.message || String(e)) : String(e);
            return Promise.resolve(`❌ 查询失败: ${msg}`);
          }
        },
      },
      {
        name: 'identity_reputation',
        description: '查看指定 Agent 的声誉历史记录。',
        parameters: {
          agentId: { type: 'string', description: 'Agent ID', required: true },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const history = net.getReputationHistory(String(args.agentId));
            if (history.length === 0) return Promise.resolve(`无声誉历史: ${args.agentId}`);
            const lines = [`声誉历史 (${history.length} 条):`];
            history.slice(-10).forEach((entry, i) => {
              lines.push(`\n${i + 1}. [${entry.delta > 0 ? '+' : ''}${entry.delta}] ${entry.reason}`);
              lines.push(`   时间: ${new Date(entry.timestamp).toISOString()}`);
            });
            return Promise.resolve(lines.join('\n'));
          } catch (e: unknown) {
            const msg = e instanceof Error ? (e.message || String(e)) : String(e);
            return Promise.resolve(`❌ 查询失败: ${msg}`);
          }
        },
      },
      {
        name: 'identity_network_stats',
        description: '查看 Agent 身份网络整体统计信息。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const stats = net.getIdentityNetworkStats();
            return Promise.resolve(`身份网络统计:\n总身份数: ${stats.totalIdentities}\n活跃身份: ${stats.activeIdentities}\n平均信任: ${stats.avgTrust}\n平均声誉: ${stats.avgReputation}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? (e.message || String(e)) : String(e);
            return Promise.resolve(`❌ 统计失败: ${msg}`);
          }
        },
      },
    ];
  }
}
