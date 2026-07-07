/**
 * 虚拟文件系统 (Virtual File System) — OpenViking 统一资源管理
 *
 * 核心设计：
 * 1. 统一命名空间 — viking://<domain>/<path> 管理所有 Agent 资源
 * 2. 五大域 — skills / memory / resources / scratchpad / checkpoints
 * 3. 版本管理 — 每路径最多保留 5 个版本
 * 4. 容量控制 — 全局最多 500 节点，checkpoints 域最多 50 节点
 * 5. 持久化 — 支持 JSON 序列化与磁盘读写
 * 6. 集成辅助 — 从 Scratchpad / ReflectionEngine 同步数据，格式化供 LLM 注入
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson } from './atomic-write.js';

// ============ 类型定义 ============

/** VFS 节点 */
export interface VFSNode {
  /** 完整路径，如 viking://skills/code-review/v2 */
  path: string;
  /** 序列化内容（JSON/YAML/文本） */
  content: string;
  /** 内容类型 */
  contentType: 'json' | 'yaml' | 'text' | 'markdown';
  /** 元数据 */
  metadata: {
    createdAt: number;
    updatedAt: number;
    version: number;
    tags: string[];
    /** 内容字节长度 */
    size: number;
  };
}

/** write 方法可选参数 */
export interface VFSWriteOptions {
  contentType?: 'json' | 'yaml' | 'text' | 'markdown';
  tags?: string[];
  /** 强制指定版本号（默认自动递增） */
  version?: number;
}

/** VFS 统计信息 */
export interface VFSStats {
  totalNodes: number;
  totalSize: number;
  domains: Record<string, { count: number; size: number }>;
}

// ============ 常量 ============

/** 合法域名列表 */
const VALID_DOMAINS = ['skills', 'memory', 'resources', 'scratchpad', 'checkpoints'] as const;
type ValidDomain = typeof VALID_DOMAINS[number];

/** 路径前缀 */
const VFS_PREFIX = 'viking://';

/** 每路径最大版本数 */
const MAX_VERSIONS = 5;

/** 全局最大节点数 */
const MAX_TOTAL_NODES = 500;

/** checkpoints 域最大节点数 */
const MAX_CHECKPOINT_NODES = 50;

/** 磁盘持久化子目录 */
const VFS_DISK_DIR = '.duan/vfs';

// ============ 辅助函数 ============

/** 从 VFS 路径中提取域名，如 viking://skills/xxx → skills */
function extractDomain(vfsPath: string): string {
  if (!vfsPath.startsWith(VFS_PREFIX)) {
    throw new Error(`VFS 路径必须以 ${VFS_PREFIX} 开头，收到: ${vfsPath}`);
  }
  const rest = vfsPath.slice(VFS_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  const domain = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  return domain;
}

/** 验证域名是否合法 */
function validateDomain(domain: string): asserts domain is ValidDomain {
  if (!VALID_DOMAINS.includes(domain as ValidDomain)) {
    throw new Error(`无效域名 "${domain}"，合法域名为: ${VALID_DOMAINS.join(', ')}`);
  }
}

/** 验证完整 VFS 路径 */
function validateVFSPath(vfsPath: string): void {
  if (!vfsPath.startsWith(VFS_PREFIX)) {
    throw new Error(`VFS 路径必须以 ${VFS_PREFIX} 开头，收到: ${vfsPath}`);
  }
  const rest = vfsPath.slice(VFS_PREFIX.length);
  if (!rest) {
    throw new Error(`VFS 路径不能仅为前缀，缺少域名: ${vfsPath}`);
  }
  const domain = extractDomain(vfsPath);
  validateDomain(domain);
  // 路径中不能有连续斜杠或空段
  const afterDomain = rest.slice(domain.length);
  if (afterDomain && afterDomain.startsWith('//')) {
    throw new Error(`VFS 路径格式错误，含连续斜杠: ${vfsPath}`);
  }
}

/** 估算 token 数（粗略：4 字符 ≈ 1 token） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============ 主类 ============

export class VirtualFileSystem {
  /** 节点存储：path → VFSNode */
  private nodes: Map<string, VFSNode> = new Map();

  /** 版本历史：path → VFSNode[]（最多 MAX_VERSIONS 个） */
  private versionHistory: Map<string, VFSNode[]> = new Map();

  // ========== 核心 API ==========

  /**
   * 写入节点
   * 若路径已存在则更新内容并递增版本，旧版本存入历史
   */
  write(vfsPath: string, content: string, options?: VFSWriteOptions): VFSNode {
    validateVFSPath(vfsPath);

    const domain = extractDomain(vfsPath);
    const now = Date.now();
    const existing = this.nodes.get(vfsPath);

    // 容量检查：新增节点时检查上限
    if (!existing) {
      this.ensureCapacity(domain);
    }

    // 保存旧版本到历史
    if (existing) {
      this.pushVersion(vfsPath, existing);
    }

    const version = options?.version ?? (existing ? existing.metadata.version + 1 : 1);
    const tags = options?.tags ?? existing?.metadata.tags ?? [];
    const contentType = options?.contentType ?? existing?.contentType ?? 'text';

    const node: VFSNode = {
      path: vfsPath,
      content,
      contentType,
      metadata: {
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
        version,
        tags,
        size: Buffer.byteLength(content, 'utf-8'),
      },
    };

    this.nodes.set(vfsPath, node);
    return node;
  }

  /**
   * 读取节点
   * 返回当前版本，不存在则返回 null
   */
  read(vfsPath: string): VFSNode | null {
    return this.nodes.get(vfsPath) ?? null;
  }

  /**
   * 删除节点
   * 同时清除版本历史，返回是否成功删除
   */
  delete(vfsPath: string): boolean {
    const deleted = this.nodes.delete(vfsPath);
    this.versionHistory.delete(vfsPath);
    return deleted;
  }

  /**
   * 检查节点是否存在
   */
  exists(vfsPath: string): boolean {
    return this.nodes.has(vfsPath);
  }

  /**
   * 列出指定域下的节点
   * 可选前缀过滤，如 list('skills', 'code-review')
   */
  list(domain: string, prefix?: string): VFSNode[] {
    validateDomain(domain);
    const domainPrefix = `${VFS_PREFIX}${domain}/`;
    const results: VFSNode[] = [];

    for (const node of Array.from(this.nodes.values())) {
      if (!node.path.startsWith(domainPrefix)) continue;
      if (prefix) {
        const afterDomain = node.path.slice(domainPrefix.length);
        if (!afterDomain.startsWith(prefix)) continue;
      }
      results.push(node);
    }

    // 按路径排序
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 搜索节点
   * 按 content 和 tags 进行模糊匹配，可限定域名
   */
  search(query: string, domain?: string): VFSNode[] {
    const q = query.toLowerCase();
    let candidates = Array.from(this.nodes.values());

    if (domain) {
      validateDomain(domain);
      const domainPrefix = `${VFS_PREFIX}${domain}/`;
      candidates = candidates.filter(n => n.path.startsWith(domainPrefix));
    }

    return candidates.filter(node => {
      // 内容匹配
      const contentMatch = node.content.toLowerCase().includes(q);
      // 标签匹配
      const tagMatch = node.metadata.tags.some(t => t.toLowerCase().includes(q));
      // 路径匹配
      const pathMatch = node.path.toLowerCase().includes(q);
      return contentMatch || tagMatch || pathMatch;
    });
  }

  /**
   * 移动/重命名节点
   * 保留元数据，更新路径
   */
  move(from: string, to: string): boolean {
    validateVFSPath(from);
    validateVFSPath(to);

    const node = this.nodes.get(from);
    if (!node) return false;

    // 检查目标是否已存在
    if (this.nodes.has(to)) return false;

    // 创建新节点
    const newNode: VFSNode = {
      ...node,
      path: to,
      metadata: {
        ...node.metadata,
        updatedAt: Date.now(),
      },
    };

    this.nodes.set(to, newNode);
    this.nodes.delete(from);

    // 迁移版本历史
    const history = this.versionHistory.get(from);
    if (history) {
      this.versionHistory.set(to, history);
      this.versionHistory.delete(from);
    }

    return true;
  }

  /**
   * 获取版本历史
   * 返回最多 MAX_VERSIONS 个旧版本（不含当前版本）
   */
  getVersions(vfsPath: string): VFSNode[] {
    return this.versionHistory.get(vfsPath) ?? [];
  }

  /**
   * 导出整个域的数据
   */
  exportDomain(domain: string): Record<string, VFSNode> {
    validateDomain(domain);
    const result: Record<string, VFSNode> = {};
    const nodes = this.list(domain);
    for (const node of nodes) {
      result[node.path] = node;
    }
    return result;
  }

  /**
   * 导入数据到指定域
   * 已存在的路径会被覆盖
   */
  importDomain(domain: string, data: Record<string, VFSNode>): void {
    validateDomain(domain);
    for (const [vfsPath, node] of Object.entries(data)) {
      // 确保路径属于目标域
      const nodeDomain = extractDomain(vfsPath);
      if (nodeDomain !== domain) {
        throw new Error(`导入路径 "${vfsPath}" 不属于域 "${domain}"`);
      }
      this.nodes.set(vfsPath, node);
    }
  }

  // ========== 序列化 ==========

  /** 导出为 JSON 兼容对象 */
  toJSON(): object {
    return {
      nodes: Array.from(this.nodes.entries()),
      versionHistory: Array.from(this.versionHistory.entries()).map(
        ([key, versions]) => [key, versions] as [string, VFSNode[]]
      ),
    };
  }

  /** 从 JSON 对象恢复 */
  fromJSON(data: { nodes: [string, VFSNode][]; versionHistory: [string, VFSNode[]][] }): void {
    this.nodes = new Map(data.nodes);
    this.versionHistory = new Map(data.versionHistory);
  }

  // ========== 统计 ==========

  /** 获取 VFS 统计信息 */
  getStats(): VFSStats {
    const domains: Record<string, { count: number; size: number }> = {};

    // 初始化所有域
    for (const d of VALID_DOMAINS) {
      domains[d] = { count: 0, size: 0 };
    }

    let totalSize = 0;
    for (const node of Array.from(this.nodes.values())) {
      const domain = extractDomain(node.path);
      if (!domains[domain]) {
        domains[domain] = { count: 0, size: 0 };
      }
      domains[domain].count++;
      domains[domain].size += node.metadata.size;
      totalSize += node.metadata.size;
    }

    return {
      totalNodes: this.nodes.size,
      totalSize,
      domains,
    };
  }

  // ========== 持久化 ==========

  /**
   * 持久化到磁盘
   * 保存到 baseDir/.duan/vfs/ 目录下，按域分文件
   */
  async persistToDisk(baseDir: string): Promise<void> {
    const vfsDir = path.join(baseDir, VFS_DISK_DIR);

    // 确保目录存在
    await fs.promises.mkdir(vfsDir, { recursive: true });

    // 保存各域数据
    for (const domain of VALID_DOMAINS) {
      const data = this.exportDomain(domain);
      const filePath = path.join(vfsDir, `${domain}.json`);
      await atomicWriteJson(filePath, data);
    }

    // 保存版本历史
    const historyPath = path.join(vfsDir, '_version_history.json');
    const historyData = Array.from(this.versionHistory.entries());
    await atomicWriteJson(historyPath, historyData);
  }

  /**
   * 从磁盘加载
   * 读取 baseDir/.duan/vfs/ 目录下的域文件
   */
  async loadFromDisk(baseDir: string): Promise<void> {
    const vfsDir = path.join(baseDir, VFS_DISK_DIR);

    // 检查目录是否存在
    try {
      await fs.promises.access(vfsDir);
    } catch {
      // 目录不存在，跳过加载
      return;
    }

    // 加载各域数据
    for (const domain of VALID_DOMAINS) {
      const filePath = path.join(vfsDir, `${domain}.json`);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, VFSNode>;
        for (const [vfsPath, node] of Object.entries(data)) {
          this.nodes.set(vfsPath, node);
        }
      } catch {
        // 文件不存在或解析失败，跳过
      }
    }

    // 加载版本历史
    const historyPath = path.join(vfsDir, '_version_history.json');
    try {
      const raw = await fs.promises.readFile(historyPath, 'utf-8');
      const historyData = JSON.parse(raw) as [string, VFSNode[]][];
      this.versionHistory = new Map(historyData);
    } catch {
      // 版本历史文件不存在，跳过
    }
  }

  // ========== 集成辅助 ==========

  /**
   * 从 Scratchpad 同步事实
   * 将所有事实条目写入 scratchpad 域
   */
  syncFromScratchpad(scratchpad: { getAll(): Array<{ key: string; value: string; source: string; importance: number; createdAt: number; updatedAt: number; tags: string[] }> }): number {
    const entries = scratchpad.getAll();
    let synced = 0;

    for (const entry of entries) {
      const vfsPath = `${VFS_PREFIX}scratchpad/${entry.key}`;
      const content = JSON.stringify({
        value: entry.value,
        source: entry.source,
        importance: entry.importance,
      });

      this.write(vfsPath, content, {
        contentType: 'json',
        tags: [...entry.tags, `source:${entry.source}`],
      });
      synced++;
    }

    return synced;
  }

  /**
   * 从 ReflectionEngine 同步 SOP
   * 将所有 SOP 写入 skills 域
   */
  syncFromReflectionEngine(engine: { getAllSOPs(): Array<{ id: string; name: string; category: string; triggerCondition: string; steps: Array<{ order: number; description: string; toolHint?: string; expectedOutcome: string; alternativeAction?: string }>; pitfalls: string[]; successCount: number; failureCount: number; version: number; createdAt: number; lastUsed: number }> }): number {
    const sops = engine.getAllSOPs();
    let synced = 0;

    for (const sop of sops) {
      const vfsPath = `${VFS_PREFIX}skills/${sop.category}/${sop.name}/v${sop.version}`;
      const content = JSON.stringify({
        id: sop.id,
        name: sop.name,
        triggerCondition: sop.triggerCondition,
        steps: sop.steps,
        pitfalls: sop.pitfalls,
        successCount: sop.successCount,
        failureCount: sop.failureCount,
        lastUsed: sop.lastUsed,
      });

      this.write(vfsPath, content, {
        contentType: 'json',
        tags: [sop.category, `sop`, `v${sop.version}`],
        version: sop.version,
      });
      synced++;
    }

    return synced;
  }

  /**
   * 格式化域内容供 LLM 提示注入
   * 在 token 预算内输出，超预算时截断
   */
  formatForPrompt(domain: string, maxTokens: number = 800): string {
    validateDomain(domain);
    const nodes = this.list(domain);

    if (nodes.length === 0) {
      return `[${domain} 域为空]`;
    }

    const lines: string[] = [];
    let usedTokens = 0;

    // 标题行
    const header = `## ${domain} (${nodes.length} 条)`;
    usedTokens += estimateTokens(header);
    lines.push(header);

    for (const node of nodes) {
      // 每条摘要：路径 + 内容前 120 字符 + 标签
      const shortContent = node.content.length > 120
        ? node.content.slice(0, 120) + '…'
        : node.content;
      const tagStr = node.metadata.tags.length > 0
        ? ` [${node.metadata.tags.join(',')}]`
        : '';
      const line = `- ${node.path}${tagStr}: ${shortContent}`;

      const lineTokens = estimateTokens(line);
      if (usedTokens + lineTokens > maxTokens) break;

      lines.push(line);
      usedTokens += lineTokens;
    }

    if (lines.length < nodes.length + 1) {
      lines.push(`…（共 ${nodes.length} 条，已截断）`);
    }

    return lines.join('\n');
  }

  // ========== 内部方法 ==========

  /**
   * 将旧版本推入版本历史
   * 保留最多 MAX_VERSIONS 个
   */
  private pushVersion(vfsPath: string, node: VFSNode): void {
    let history = this.versionHistory.get(vfsPath);
    if (!history) {
      history = [];
      this.versionHistory.set(vfsPath, history);
    }
    // 新版本插入头部（最新在前）
    history.unshift(node);
    // 超出上限则移除最旧的
    if (history.length > MAX_VERSIONS) {
      history.length = MAX_VERSIONS;
    }
  }

  /**
   * 容量检查与自动淘汰
   * 全局满时淘汰最旧节点（checkpoints 域有独立上限）
   */
  private ensureCapacity(domain: string): void {
    // checkpoints 域独立容量检查
    if (domain === 'checkpoints') {
      const checkpointNodes = this.list('checkpoints');
      if (checkpointNodes.length >= MAX_CHECKPOINT_NODES) {
        // 淘汰最旧的 checkpoint
        this.evictOldest('checkpoints');
      }
    }

    // 全局容量检查
    if (this.nodes.size >= MAX_TOTAL_NODES) {
      // 优先淘汰 checkpoints 域最旧节点
      const checkpointNodes = this.list('checkpoints');
      if (checkpointNodes.length > 0) {
        this.evictOldest('checkpoints');
      } else {
        // 从其他域淘汰最旧节点
        const otherDomains: ValidDomain[] = ['skills', 'memory', 'resources', 'scratchpad'];
        for (const d of otherDomains) {
          const dNodes = this.list(d);
          if (dNodes.length > 0) {
            this.evictOldest(d);
            break;
          }
        }
      }
    }
  }

  /**
   * 淘汰指定域中最旧的节点
   */
  private evictOldest(domain: string): void {
    const domainPrefix = `${VFS_PREFIX}${domain}/`;
    let oldest: VFSNode | null = null;

    for (const node of Array.from(this.nodes.values())) {
      if (!node.path.startsWith(domainPrefix)) continue;
      if (!oldest || node.metadata.updatedAt < oldest.metadata.updatedAt) {
        oldest = node;
      }
    }

    if (oldest) {
      this.delete(oldest.path);
    }
  }
}
