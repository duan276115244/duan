/**
 * 项目记忆分层加载器 — ProjectMemoryLoader
 *
 * 对标 Claude Code 的 CLAUDE.md 多层级记忆机制，建立三级项目记忆体系：
 *   1. 用户全局层：~/.duan/project-memory/*.md（所有项目共享的通用约定）
 *   2. 仓库根层：<repo>/.duan/memory/*.md（项目级约定）
 *   3. 子目录层：<subdir>/.duan/memory/*.md（子模块级约定，向上递归查找）
 *
 * 优先级：子目录 > 仓库根 > 用户全局（后加载的追加在前，不覆盖）
 * 实际策略：所有层级的 .md 文件都会被收集，按层级顺序合并，越具体的越靠前
 *
 * 与现有模块的关系：
 *   - ProjectConfig：从 .duan/CONFIG.md 加载结构化配置（技术栈/规则/工具偏好）
 *   - ProjectKnowledge：运行时扫描项目结构生成摘要
 *   - ProjectMemoryLoader（本模块）：加载多层级 Markdown 记忆文件，补充非结构化约定
 *   三者互补，ProjectMemoryLoader 填补了"多层级自由格式约定"的空白
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './structured-logger.js';
import { getDuanDataDir } from './duan-paths.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

export interface MemoryFileEntry {
  /** 文件绝对路径 */
  filePath: string;
  /** 层级：global / repo / subdir */
  layer: 'global' | 'repo' | 'subdir';
  /** 文件名（不含扩展名），作为记忆条目标识 */
  name: string;
  /** 文件内容 */
  content: string;
  /** 最后修改时间 */
  mtimeMs: number;
}

export interface ProjectMemorySnapshot {
  /** 所有层级的记忆文件（按优先级排序：subdir > repo > global） */
  entries: MemoryFileEntry[];
  /** 合并后的完整文本（用于注入系统提示词） */
  mergedText: string;
  /** 来源目录列表 */
  sourceDirs: string[];
  /** 加载时间戳 */
  loadedAt: number;
}

// ============ 常量 ============

const MEMORY_DIR_NAME = 'memory';
const DUAN_DIR_NAME = '.duan';
const CACHE_TTL_MS = 60_000; // 60 秒缓存
const MAX_FILE_SIZE_BYTES = 64 * 1024; // 单文件最大 64KB，防止误加载大文件
const MAX_TOTAL_SIZE_BYTES = 256 * 1024; // 总计最大 256KB
const MAX_FILES = 20; // 最多加载 20 个文件

// ============ 主类 ============

export class ProjectMemoryLoader {
  private log = logger.child({ module: 'ProjectMemoryLoader' });

  /** 缓存快照 */
  private _cache: ProjectMemorySnapshot | null = null;
  private _cacheTime = 0;
  /** 文件 mtime 指纹（用于增量失效） */
  private _fingerprint = '';
  /** 全局层根目录（默认 getDuanDataDir()，可注入用于测试） */
  private readonly _globalDir: string;

  constructor(options?: { globalDir?: string }) {
    this._globalDir = options?.globalDir || path.join(getDuanDataDir(), 'project-memory');
  }

  // ========== 核心加载 ==========

  /**
   * 加载三级项目记忆
   *
   * @param cwd 当前工作目录（默认 process.cwd()）
   * @param options 可选配置
   *   - maxDepth: 向上递归查找 .duan/memory 的最大层数（默认 3）
   *   - forceRefresh: 强制刷新缓存
   */
  async load(
    cwd: string = process.cwd(),
    options?: { maxDepth?: number; forceRefresh?: boolean }
  ): Promise<ProjectMemorySnapshot> {
    const now = Date.now();
    if (!options?.forceRefresh && this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      // 增量检测：文件未变化时直接返回缓存
      const currentFingerprint = this.computeFingerprint(cwd, options?.maxDepth ?? 3);
      if (currentFingerprint === this._fingerprint) {
        return this._cache;
      }
    }

    const maxDepth = options?.maxDepth ?? 3;
    const entries = await this.collectMemoryFiles(cwd, maxDepth);
    const mergedText = this.mergeEntries(entries);
    const sourceDirs = this.extractSourceDirs(cwd, maxDepth);

    const snapshot: ProjectMemorySnapshot = {
      entries,
      mergedText,
      sourceDirs,
      loadedAt: now,
    };

    this._cache = snapshot;
    this._cacheTime = now;
    this._fingerprint = this.computeFingerprint(cwd, maxDepth);

    this.log.debug('项目记忆已加载', {
      fileCount: entries.length,
      totalSize: mergedText.length,
      layers: entries.reduce((acc, e) => {
        acc[e.layer] = (acc[e.layer] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    return snapshot;
  }

  /**
   * 同步加载（用于不便 async 的场景，如 loadProjectRules 替换）
   */
  loadSync(cwd: string = process.cwd(), options?: { maxDepth?: number; forceRefresh?: boolean }): ProjectMemorySnapshot {
    const now = Date.now();
    if (!options?.forceRefresh && this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      const currentFingerprint = this.computeFingerprint(cwd, options?.maxDepth ?? 3);
      if (currentFingerprint === this._fingerprint) {
        return this._cache;
      }
    }

    const maxDepth = options?.maxDepth ?? 3;
    const entries = this.collectMemoryFilesSync(cwd, maxDepth);
    const mergedText = this.mergeEntries(entries);
    const sourceDirs = this.extractSourceDirs(cwd, maxDepth);

    const snapshot: ProjectMemorySnapshot = { entries, mergedText, sourceDirs, loadedAt: now };
    this._cache = snapshot;
    this._cacheTime = now;
    this._fingerprint = this.computeFingerprint(cwd, maxDepth);

    return snapshot;
  }

  // ========== 查询 API ==========

  /**
   * 获取合并后的记忆文本（用于注入系统提示词）
   */
  async getMergedText(cwd?: string): Promise<string> {
    const snapshot = await this.load(cwd);
    return snapshot.mergedText;
  }

  /**
   * 获取记忆概览（用于 /memory 命令展示）
   */
  async getOverview(cwd?: string): Promise<string> {
    const snapshot = await this.load(cwd);
    if (snapshot.entries.length === 0) {
      return '📭 未找到项目记忆文件。\n\n可在以下位置创建记忆文件：\n- 用户全局：~/.duan/project-memory/conventions.md\n- 项目级：<repo>/.duan/memory/conventions.md\n- 子目录：<subdir>/.duan/memory/conventions.md';
    }

    const lines: string[] = [`📂 项目记忆概览（${snapshot.entries.length} 个文件，共 ${snapshot.mergedText.length} 字符）`, ''];

    const layerLabels: Record<MemoryFileEntry['layer'], string> = {
      subdir: '子目录层',
      repo: '仓库根层',
      global: '用户全局层',
    };

    const byLayer = new Map<MemoryFileEntry['layer'], MemoryFileEntry[]>();
    for (const entry of snapshot.entries) {
      if (!byLayer.has(entry.layer)) byLayer.set(entry.layer, []);
      byLayer.get(entry.layer)!.push(entry);
    }

    const layerOrder: MemoryFileEntry['layer'][] = ['subdir', 'repo', 'global'];
    for (const layer of layerOrder) {
      const items = byLayer.get(layer);
      if (!items || items.length === 0) continue;
      lines.push(`【${layerLabels[layer]}】`);
      for (const item of items) {
        const preview = item.content.split('\n')[0].substring(0, 60);
        lines.push(`  - ${item.name}.md (${item.content.length} 字符) — ${preview}`);
      }
      lines.push('');
    }

    lines.push(`来源目录：${snapshot.sourceDirs.join(', ')}`);
    return lines.join('\n');
  }

  /**
   * 列出所有记忆文件
   */
  async listFiles(cwd?: string): Promise<MemoryFileEntry[]> {
    const snapshot = await this.load(cwd);
    return snapshot.entries;
  }

  // ========== 写入 API ==========

  /**
   * 写入记忆条目到指定层级
   *
   * @param name 文件名（不含 .md 后缀）
   * @param content Markdown 内容
   * @param layer 目标层级
   * @param cwd 当前工作目录（用于定位 repo/subdir 层）
   */
  async writeEntry(
    name: string,
    content: string,
    layer: 'global' | 'repo' | 'subdir' = 'repo',
    cwd: string = process.cwd()
  ): Promise<string> {
    const safeName = this.sanitizeFileName(name);
    const dir = this.resolveLayerDir(layer, cwd);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${safeName}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');

    // 失效缓存
    this._cache = null;

    this.log.info('记忆条目已写入', { filePath, layer, size: content.length });
    return filePath;
  }

  /**
   * 追加内容到已有记忆文件（不存在则创建）
   */
  async appendToEntry(
    name: string,
    content: string,
    layer: 'global' | 'repo' | 'subdir' = 'repo',
    cwd: string = process.cwd()
  ): Promise<string> {
    const safeName = this.sanitizeFileName(name);
    const dir = this.resolveLayerDir(layer, cwd);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${safeName}.md`);
    let existing = '';
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf-8');
      if (!existing.endsWith('\n')) existing += '\n';
    }

    const newContent = existing + '\n' + content + '\n';
    fs.writeFileSync(filePath, newContent, 'utf-8');

    this._cache = null;
    this.log.info('记忆条目已追加', { filePath, layer, appendedSize: content.length });
    return filePath;
  }

  /**
   * 删除记忆文件
   */
  async deleteEntry(name: string, layer: 'global' | 'repo' | 'subdir', cwd: string = process.cwd()): Promise<boolean> {
    const safeName = this.sanitizeFileName(name);
    const dir = this.resolveLayerDir(layer, cwd);
    const filePath = path.join(dir, `${safeName}.md`);

    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    this._cache = null;
    this.log.info('记忆条目已删除', { filePath, layer });
    return true;
  }

  // ========== 内部方法 ==========

  /** 收集三级记忆文件（异步） */
  private async collectMemoryFiles(cwd: string, maxDepth: number): Promise<MemoryFileEntry[]> {
    const entries: MemoryFileEntry[] = [];

    // 1. 用户全局层
    entries.push(...this.readDirEntries(this._globalDir, 'global'));

    // 2. 仓库根层 + 子目录层（向上递归）
    const upwardDirs = this.findUpwardMemoryDirs(cwd, maxDepth);
    // 向上递归的结果是从 cwd 开始向上的，越靠后的越具体（子目录）
    // 按优先级：子目录 > 仓库根，所以倒序处理（最具体的最后加入会被排在前面）
    for (let i = upwardDirs.length - 1; i >= 0; i--) {
      const { dir, isRepoRoot } = upwardDirs[i];
      const layer: MemoryFileEntry['layer'] = isRepoRoot ? 'repo' : 'subdir';
      entries.push(...this.readDirEntries(dir, layer));
    }

    // 3. 去重（同名文件，子目录层优先）
    const deduped = this.dedupByName(entries);

    // 4. 限制总量
    return this.capTotal(deduped);
  }

  /** 收集三级记忆文件（同步） */
  private collectMemoryFilesSync(cwd: string, maxDepth: number): MemoryFileEntry[] {
    const entries: MemoryFileEntry[] = [];

    const globalDir = path.join(os.homedir(), DUAN_DIR_NAME, 'project-memory');
    entries.push(...this.readDirEntries(globalDir, 'global'));

    const upwardDirs = this.findUpwardMemoryDirs(cwd, maxDepth);
    for (let i = upwardDirs.length - 1; i >= 0; i--) {
      const { dir, isRepoRoot } = upwardDirs[i];
      const layer: MemoryFileEntry['layer'] = isRepoRoot ? 'repo' : 'subdir';
      entries.push(...this.readDirEntries(dir, layer));
    }

    const deduped = this.dedupByName(entries);
    return this.capTotal(deduped);
  }

  /** 读取目录下所有 .md 文件 */
  private readDirEntries(dir: string, layer: MemoryFileEntry['layer']): MemoryFileEntry[] {
    if (!fs.existsSync(dir)) return [];

    const entries: MemoryFileEntry[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
      return [];
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          this.log.warn('记忆文件过大，跳过', { filePath, size: stat.size });
          continue;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const name = file.replace(/\.md$/i, '');
        entries.push({
          filePath,
          layer,
          name,
          content,
          mtimeMs: stat.mtimeMs,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('读取记忆文件失败', { filePath, error: msg });
      }
    }

    return entries;
  }

  /** 向上递归查找 .duan/memory 目录 */
  private findUpwardMemoryDirs(cwd: string, maxDepth: number): Array<{ dir: string; isRepoRoot: boolean }> {
    const results: Array<{ dir: string; isRepoRoot: boolean }> = [];
    const resolvedCwd = path.resolve(cwd);
    const home = os.homedir();

    let current = resolvedCwd;
    let depth = 0;

    while (current && current !== path.dirname(current) && depth <= maxDepth) {
      // 停止在用户主目录（避免把 ~/.duan/memory 当成 repo 层，它应是 global 层）
      if (current === home) break;

      const memoryDir = path.join(current, DUAN_DIR_NAME, MEMORY_DIR_NAME);
      if (fs.existsSync(memoryDir)) {
        // 判断是否为仓库根：有 .git 或 package.json
        const isRepoRoot = fs.existsSync(path.join(current, '.git')) ||
                           fs.existsSync(path.join(current, 'package.json'));
        results.push({ dir: memoryDir, isRepoRoot });
      }

      current = path.dirname(current);
      depth++;
    }

    return results;
  }

  /** 去重：同名文件，优先保留子目录层 */
  private dedupByName(entries: MemoryFileEntry[]): MemoryFileEntry[] {
    const layerPriority: Record<MemoryFileEntry['layer'], number> = { subdir: 0, repo: 1, global: 2 };
    const byName = new Map<string, MemoryFileEntry>();

    // 按优先级排序后遍历，优先级高的先入 map
    const sorted = [...entries].sort((a, b) => layerPriority[a.layer] - layerPriority[b.layer]);
    for (const entry of sorted) {
      if (!byName.has(entry.name)) {
        byName.set(entry.name, entry);
      }
    }

    return Array.from(byName.values());
  }

  /** 限制总量 */
  private capTotal(entries: MemoryFileEntry[]): MemoryFileEntry[] {
    if (entries.length <= MAX_FILES) {
      const totalSize = entries.reduce((sum, e) => sum + e.content.length, 0);
      if (totalSize <= MAX_TOTAL_SIZE_BYTES) return entries;
    }

    // 按优先级排序后截断
    const layerPriority: Record<MemoryFileEntry['layer'], number> = { subdir: 0, repo: 1, global: 2 };
    const sorted = [...entries].sort((a, b) => layerPriority[a.layer] - layerPriority[b.layer]);

    const result: MemoryFileEntry[] = [];
    let totalSize = 0;
    for (const entry of sorted) {
      if (result.length >= MAX_FILES) break;
      if (totalSize + entry.content.length > MAX_TOTAL_SIZE_BYTES) {
        this.log.warn('记忆总量超限，截断', { skippedFile: entry.filePath });
        break;
      }
      result.push(entry);
      totalSize += entry.content.length;
    }

    return result;
  }

  /** 合并条目为单一文本 */
  private mergeEntries(entries: MemoryFileEntry[]): string {
    if (entries.length === 0) return '';

    const layerLabels: Record<MemoryFileEntry['layer'], string> = {
      subdir: '子目录记忆',
      repo: '项目记忆',
      global: '全局记忆',
    };

    const sections: string[] = ['## 项目记忆（分层加载）'];

    // 按层级分组
    const byLayer = new Map<MemoryFileEntry['layer'], MemoryFileEntry[]>();
    for (const entry of entries) {
      if (!byLayer.has(entry.layer)) byLayer.set(entry.layer, []);
      byLayer.get(entry.layer)!.push(entry);
    }

    const layerOrder: MemoryFileEntry['layer'][] = ['subdir', 'repo', 'global'];
    for (const layer of layerOrder) {
      const items = byLayer.get(layer);
      if (!items || items.length === 0) continue;

      sections.push(`### ${layerLabels[layer]}`);
      for (const item of items) {
        sections.push(`#### ${item.name}`);
        sections.push(item.content.trim());
      }
    }

    return sections.join('\n\n');
  }

  /** 提取来源目录列表 */
  private extractSourceDirs(cwd: string, maxDepth: number): string[] {
    const dirs: string[] = [];
    dirs.push(this._globalDir);
    const upward = this.findUpwardMemoryDirs(cwd, maxDepth);
    for (const u of upward) dirs.push(u.dir);
    return dirs;
  }

  /** 计算文件指纹（用于缓存失效检测） */
  private computeFingerprint(cwd: string, maxDepth: number): string {
    const dirs = this.extractSourceDirs(cwd, maxDepth);
    const parts: string[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        parts.push(`${dir}:missing`);
        continue;
      }
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
        for (const file of files) {
          const stat = fs.statSync(path.join(dir, file));
          parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
        }
      } catch {
        parts.push(`${dir}:error`);
      }
    }
    return parts.join('|');
  }

  /** 解析层级目录 */
  private resolveLayerDir(layer: 'global' | 'repo' | 'subdir', cwd: string): string {
    if (layer === 'global') {
      return this._globalDir;
    }
    // repo 和 subdir 都基于 cwd（repo 就是 cwd 的 .duan/memory）
    return path.join(cwd, DUAN_DIR_NAME, MEMORY_DIR_NAME);
  }

  /** 文件名安全化 */
  private sanitizeFileName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\.md$/i, '')
      .substring(0, 64);
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'project_memory_list',
        description: '列出当前项目的所有分层记忆文件（用户全局/仓库根/子目录三级）。返回每层文件的名称、大小和内容预览。用于查看项目已有的约定和记忆。',
        parameters: {},
        readOnly: true,
        execute: async () => {
          try {
            const overview = await self.getOverview();
            return overview;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 获取项目记忆失败: ${msg}`;
          }
        },
      },
      {
        name: 'project_memory_write',
        description: '写入或更新项目记忆文件。用于保存项目约定、编码规范、架构决策等。当用户说"记住这个约定"或类似指令时调用此工具。',
        parameters: {
          name: {
            type: 'string',
            description: '记忆文件名（不含 .md 后缀），如 "conventions"、"architecture"、"coding-style"',
            required: true,
          },
          content: {
            type: 'string',
            description: 'Markdown 格式的记忆内容',
            required: true,
          },
          layer: {
            type: 'string',
            description: '目标层级：global（用户全局，所有项目共享）/ repo（项目级，默认）/ subdir（子目录级）',
            required: false,
          },
        },
        execute: async (args) => {
          try {
            const layer = (args.layer as 'global' | 'repo' | 'subdir') || 'repo';
            const filePath = await self.writeEntry(
              args.name as string,
              args.content as string,
              layer
            );
            return `✅ 记忆已写入 [${layer}层] ${filePath}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 写入项目记忆失败: ${msg}`;
          }
        },
      },
      {
        name: 'project_memory_append',
        description: '追加内容到已有记忆文件（不存在则创建）。用于增量记录约定，如"在编码约定中追加一条规则"。',
        parameters: {
          name: {
            type: 'string',
            description: '记忆文件名（不含 .md 后缀）',
            required: true,
          },
          content: {
            type: 'string',
            description: '要追加的 Markdown 内容',
            required: true,
          },
          layer: {
            type: 'string',
            description: '目标层级：global / repo（默认）/ subdir',
            required: false,
          },
        },
        execute: async (args) => {
          try {
            const layer = (args.layer as 'global' | 'repo' | 'subdir') || 'repo';
            const filePath = await self.appendToEntry(
              args.name as string,
              args.content as string,
              layer
            );
            return `✅ 记忆已追加 [${layer}层] ${filePath}`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 追加项目记忆失败: ${msg}`;
          }
        },
      },
      {
        name: 'project_memory_delete',
        description: '删除指定层级的项目记忆文件。',
        parameters: {
          name: {
            type: 'string',
            description: '要删除的记忆文件名（不含 .md 后缀）',
            required: true,
          },
          layer: {
            type: 'string',
            description: '目标层级：global / repo / subdir',
            required: true,
          },
        },
        execute: async (args) => {
          try {
            const deleted = await self.deleteEntry(
              args.name as string,
              args.layer as 'global' | 'repo' | 'subdir'
            );
            return deleted ? `✅ 记忆已删除` : '⚠️ 指定的记忆文件不存在';
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 删除项目记忆失败: ${msg}`;
          }
        },
      },
    ];
  }
}
