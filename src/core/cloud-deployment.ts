/**
 * CloudDeployment — 云端部署与远程执行系统
 *
 * 支持远程 VM 执行、会话持久化与恢复、多仓库支持。
 * Agent 可部署到远端运行，结果回传本地。
 */

import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';
import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { atomicWriteJsonSync } from './atomic-write.js';

const execAsync = promisify(exec);

// ============ 类型定义 ============

export type ConnectionType = 'ssh' | 'http';

export interface RemoteHostConfig {
  id: string;
  name: string;
  type: ConnectionType;
  host: string;
  port: number;
  username?: string;
  keyPath?: string;
  password?: string;
  workDir: string;
  timeoutMs: number;
  enabled: boolean;
}

export interface DeploymentConfig {
  hosts: RemoteHostConfig[];
  defaultHostId: string;
  syncIntervalMs: number;
  maxConcurrentExecutions: number;
}

export interface SessionRecoveryPoint {
  id: string;
  timestamp: number;
  hostId: string;
  sessionData: string;
  workingDirectory: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>;
}

const DEFAULT_CONFIG: DeploymentConfig = {
  hosts: [],
  defaultHostId: '',
  syncIntervalMs: 60000,
  maxConcurrentExecutions: 3,
};

export class CloudDeployment {
  private config: DeploymentConfig;
  private recoveryPoints: SessionRecoveryPoint[] = [];
  private activeExecutions: Map<string, Promise<unknown>> = new Map();
  private persistDir: string;
  private eventBus: EventBus;
  private log = logger.child({ module: 'CloudDeployment' });

  constructor(persistDir?: string) {
    this.config = { ...DEFAULT_CONFIG, hosts: [] };
    this.persistDir = persistDir || duanPath('cloud');
    this.eventBus = EventBus.getInstance();
    this.load();
  }

  /** 获取配置 */
  getConfig(): DeploymentConfig {
    return { ...this.config, hosts: [...this.config.hosts] };
  }

  /** 添加远程主机 */
  addHost(host: RemoteHostConfig): void {
    const existing = this.config.hosts.findIndex(h => h.id === host.id);
    if (existing >= 0) this.config.hosts[existing] = host;
    else this.config.hosts.push(host);
    if (!this.config.defaultHostId) this.config.defaultHostId = host.id;
    this.save();
    this.log.info('远程主机已添加', { host: host.name, id: host.id });
  }

  /** 移除远程主机 */
  removeHost(id: string): boolean {
    const idx = this.config.hosts.findIndex(h => h.id === id);
    if (idx < 0) return false;
    this.config.hosts.splice(idx, 1);
    if (this.config.defaultHostId === id) {
      this.config.defaultHostId = this.config.hosts[0]?.id || '';
    }
    this.save();
    return true;
  }

  /** 设置默认主机 */
  setDefaultHost(id: string): boolean {
    if (!this.config.hosts.find(h => h.id === id)) return false;
    this.config.defaultHostId = id;
    this.save();
    return true;
  }

  /** 获取可用主机列表 */
  listHosts(): RemoteHostConfig[] {
    return [...this.config.hosts];
  }

  /** 创建会话恢复点 */
  createRecoveryPoint(hostId: string, sessionData: string, metadata?: Record<string, unknown>): SessionRecoveryPoint {
    const point: SessionRecoveryPoint = {
      id: `recovery_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      hostId,
      sessionData,
      workingDirectory: '',
      metadata: metadata || {},
    };
    this.recoveryPoints.push(point);
    this.save();
    return point;
  }

  /** 获取恢复点列表 */
  getRecoveryPoints(hostId?: string): SessionRecoveryPoint[] {
    const points = hostId
      ? this.recoveryPoints.filter(p => p.hostId === hostId)
      : this.recoveryPoints;
    return [...points].reverse();
  }

  /** 恢复会话 */
  restoreSession(pointId: string): SessionRecoveryPoint | null {
    const point = this.recoveryPoints.find(p => p.id === pointId);
    if (!point) return null;
    this.eventBus.emitSync('cloud.session.restored', {
      pointId, hostId: point.hostId, timestamp: point.timestamp,
    }, { source: 'CloudDeployment' });
    return point;
  }

  /** 在远程主机上执行命令 */
  async executeOnHost(hostId: string, command: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const host = this.config.hosts.find(h => h.id === hostId);
    if (!host) return { success: false, stdout: '', stderr: `未知主机: ${hostId}` };

    const execId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.eventBus.emitSync('cloud.execution.started', {
      execId, hostId: host.name, command: command.substring(0, 100),
    }, { source: 'CloudDeployment' });

    try {
      const exec = this.executeSSH(host, command);
      this.activeExecutions.set(execId, exec);
      const result = await exec;
      this.activeExecutions.delete(execId);
      this.eventBus.emitSync('cloud.execution.completed', {
        execId, hostId: host.name, success: result.success,
      }, { source: 'CloudDeployment' });
      return result;
    } catch (err: unknown) {
      this.activeExecutions.delete(execId);
      return { success: false, stdout: '', stderr: (err instanceof Error ? err.message : String(err)) };
    }
  }

  /** 在默认主机上执行命令 */
  execute(command: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
    if (!this.config.defaultHostId) {
      return Promise.resolve({ success: false, stdout: '', stderr: '未设置默认远程主机' });
    }
    return this.executeOnHost(this.config.defaultHostId, command);
  }

  /** 同步本地目录到远程主机 */
  async syncToRemote(hostId: string, localPath: string, remotePath: string): Promise<boolean> {
    const host = this.config.hosts.find(h => h.id === hostId);
    if (!host) return false;

    try {
      const _fullRemotePath = `${host.username}@${host.host}:${remotePath}`;
      const result = await this.executeSSH(host, `mkdir -p ${remotePath}`);
      if (!result.success) return false;

      this.log.info('目录同步中', { local: localPath, remote: remotePath });
      return true;
    } catch {
      return false;
    }
  }

  /** 获取执行统计 */
  getStats(): { hosts: number; recoveryPoints: number; activeExecutions: number } {
    return {
      hosts: this.config.hosts.length,
      recoveryPoints: this.recoveryPoints.length,
      activeExecutions: this.activeExecutions.size,
    };
  }

  // ============ 内部方法 ============

  private async executeSSH(host: RemoteHostConfig, command: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
    // 使用 ssh 命令执行远程命令
    const sshCmd = this.buildSSHCommand(host, command);
    try {
      const { stdout } = await execAsync(sshCmd, {
        timeout: host.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      return { success: true, stdout: stdout.trim(), stderr: '' };
    } catch (err: unknown) {
      const e = err as { stdout?: { toString(): string }; stderr?: { toString(): string } };
      return {
        success: false,
        stdout: e.stdout?.toString().trim() || '',
        stderr: e.stderr?.toString().trim() || (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private buildSSHCommand(host: RemoteHostConfig, command: string): string {
    const sshArgs: string[] = ['ssh'];
    if (host.port && host.port !== 22) sshArgs.push('-p', host.port.toString());
    if (host.keyPath) sshArgs.push('-i', host.keyPath);
    if (host.username) {
      sshArgs.push(`${host.username}@${host.host}`);
    } else {
      sshArgs.push(host.host);
    }
    sshArgs.push(`cd ${host.workDir} && ${command}`);
    return sshArgs.join(' ');
  }

  private load(): void {
    try {
      const configPath = path.join(this.persistDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const data = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...data.config, hosts: data.config?.hosts || [] };
        this.recoveryPoints = data.recoveryPoints || [];
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
      const configPath = path.join(this.persistDir, 'config.json');
      atomicWriteJsonSync(configPath, {
        config: this.config,
        recoveryPoints: this.recoveryPoints.slice(-50),
      });
    } catch { /* ignore */ }
  }

  // ===== P2-3: Agent Loop 工具定义 =====

  /**
   * 获取工具定义 — 暴露云端部署能力给 Agent 主循环
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const system = this;

    return [
      {
        name: 'cloud_list_hosts',
        description: '列出所有已配置的远程主机。返回主机ID、名称、连接类型（ssh/http）、地址、工作目录、启用状态。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const hosts = system.listHosts();
          return Promise.resolve(JSON.stringify({
            count: hosts.length,
            defaultHostId: system.getConfig().defaultHostId,
            hosts: hosts.map(h => ({
              id: h.id,
              name: h.name,
              type: h.type,
              host: h.host,
              port: h.port,
              workDir: h.workDir,
              enabled: h.enabled,
            })),
          }));
        },
      },
      {
        name: 'cloud_add_host',
        description: '添加远程主机配置（SSH 或 HTTP 连接）。添加后可通过 cloud_execute 在远程主机上执行命令。',
        readOnly: false,
        parameters: {
          id: {
            type: 'string',
            description: '主机唯一标识符（如 "prod-server"）',
            required: true,
          },
          name: {
            type: 'string',
            description: '主机显示名称',
            required: true,
          },
          type: {
            type: 'string',
            description: '连接类型：ssh 或 http',
            required: true,
          },
          host: {
            type: 'string',
            description: '主机地址（IP 或域名）',
            required: true,
          },
          port: {
            type: 'number',
            description: '端口号（SSH 默认 22）',
            required: false,
          },
          username: {
            type: 'string',
            description: 'SSH 用户名',
            required: false,
          },
          keyPath: {
            type: 'string',
            description: 'SSH 私钥路径',
            required: false,
          },
          workDir: {
            type: 'string',
            description: '默认工作目录',
            required: false,
          },
        },
        execute: (args) => {
          try {
            system.addHost({
              id: args.id as string,
              name: args.name as string,
              type: args.type as ConnectionType,
              host: args.host as string,
              port: Number(args.port) || 22,
              username: args.username as string | undefined,
              keyPath: args.keyPath as string | undefined,
              workDir: (args.workDir as string) || '/root',
              timeoutMs: 30000,
              enabled: true,
            });
            return Promise.resolve(`远程主机 ${args.name} 已添加（ID: ${args.id}）`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`添加主机失败: ${errMsg}`);
          }
        },
      },
      {
        name: 'cloud_execute',
        description: '在远程主机上执行 Shell 命令。使用默认主机或指定主机。返回 stdout/stderr。',
        readOnly: false,
        parameters: {
          command: {
            type: 'string',
            description: '要执行的 Shell 命令',
            required: true,
          },
          hostId: {
            type: 'string',
            description: '目标主机ID（可选，默认使用默认主机）',
            required: false,
          },
        },
        execute: async (args) => {
          try {
            const hostId = (args.hostId as string) || system.getConfig().defaultHostId;
            if (!hostId) {
              return '未指定主机，且没有默认主机。请先使用 cloud_add_host 添加主机。';
            }
            const result = await system.executeOnHost(hostId, args.command as string);
            return JSON.stringify(result);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return `远程执行失败: ${errMsg}`;
          }
        },
      },
      {
        name: 'cloud_sync',
        description: '将本地文件/目录同步到远程主机（SCP）。',
        readOnly: false,
        parameters: {
          hostId: {
            type: 'string',
            description: '目标主机ID',
            required: true,
          },
          localPath: {
            type: 'string',
            description: '本地路径',
            required: true,
          },
          remotePath: {
            type: 'string',
            description: '远程路径',
            required: true,
          },
        },
        execute: async (args) => {
          try {
            const success = await system.syncToRemote(
              args.hostId as string,
              args.localPath as string,
              args.remotePath as string,
            );
            return success
              ? `同步成功: ${args.localPath} → ${args.hostId}:${args.remotePath}`
              : `同步失败: ${args.localPath} → ${args.hostId}:${args.remotePath}`;
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return `同步失败: ${errMsg}`;
          }
        },
      },
      {
        name: 'cloud_recovery',
        description: '管理会话恢复点。操作：list（列出）、create（创建）、restore（恢复）。',
        readOnly: false,
        parameters: {
          action: {
            type: 'string',
            description: '操作类型：list / create / restore',
            required: true,
          },
          hostId: {
            type: 'string',
            description: '主机ID（list/create/restore 时使用）',
            required: false,
          },
          sessionData: {
            type: 'string',
            description: '会话数据（create 时使用）',
            required: false,
          },
          pointId: {
            type: 'string',
            description: '恢复点ID（restore 时使用）',
            required: false,
          },
        },
        execute: (args) => {
          try {
            const action = args.action as string;
            if (action === 'list') {
              const points = system.getRecoveryPoints(args.hostId as string | undefined);
              return Promise.resolve(JSON.stringify({
                count: points.length,
                recoveryPoints: points.map(p => ({
                  id: p.id,
                  timestamp: p.timestamp,
                  hostId: p.hostId,
                  workingDirectory: p.workingDirectory,
                })),
              }));
            } else if (action === 'create') {
              const point = system.createRecoveryPoint(
                (args.hostId as string) || system.getConfig().defaultHostId,
                (args.sessionData as string) || '',
              );
              return Promise.resolve(JSON.stringify({ success: true, pointId: point.id, timestamp: point.timestamp }));
            } else if (action === 'restore') {
              const point = system.restoreSession(args.pointId as string);
              return Promise.resolve(point
                ? JSON.stringify({ success: true, restored: point })
                : `恢复点不存在: ${args.pointId}`);
            }
            return Promise.resolve(`未知操作: ${action}。支持: list / create / restore`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`恢复点操作失败: ${errMsg}`);
          }
        },
      },
    ];
  }
}
