/**
 * 段先生 - 差异化精确代码编辑器 — DiffEditor
 *
 * 对标 Cursor 的 Diff-based 编辑模式：
 * 不再重写整个文件，而是生成精确的 search/replace 块，
 * 仅修改变更部分，大幅降低出错率和 Token 消耗。
 *
 * 核心能力：
 * 1. applyDiff — 将差异块原子性地应用到文件（全部成功或全部回滚）
 * 2. parseDiffFormat — 解析标准 diff 格式字符串
 * 3. generateDiff — 对比两个字符串生成差异块
 * 4. previewDiff — 预览变更内容（只读）
 * 5. rollback — 从备份恢复文件
 * 6. getStats — 统计信息
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { errMsg } from './utils.js';

// ============ 类型定义 ============

/** 差异块：精确的搜索/替换对 */
export interface DiffBlock {
  /** 需要查找的精确文本 */
  search: string;
  /** 替换后的文本 */
  replace: string;
  /** 变更的人类可读描述 */
  description?: string;
}

/** 应用差异的结果 */
export interface ApplyResult {
  /** 是否全部成功 */
  success: boolean;
  /** 目标文件路径 */
  filePath: string;
  /** 成功应用的差异块数量 */
  appliedDiffs: number;
  /** 失败的差异块详情 */
  failedDiffs: Array<{ index: number; reason: string }>;
  /** 备份文件路径 */
  backupPath?: string;
  /** 错误信息 */
  error?: string;
}

/** 差异预览 */
export interface DiffPreview {
  /** 目标文件路径 */
  filePath: string;
  /** 各差异块的预览 */
  blocks: Array<{
    index: number;
    description?: string;
    before: string;
    after: string;
    lineRange: { start: number; end: number };
  }>;
  /** 总变更数 */
  totalChanges: number;
  /** 新增行数 */
  linesAdded: number;
  /** 删除行数 */
  linesRemoved: number;
}


// ============ 常量 ============

/** 备份目录 */
const BACKUP_DIR = '.duan/backups/';

/** diff 格式标记 */
const SEARCH_MARKER = '<<<<<<< SEARCH';
const SEPARATOR_MARKER = '=======';
const REPLACE_MARKER = '>>>>>>> REPLACE';

// ============ 主类 ============

export class DiffEditor {
  private log = logger.child({ module: 'DiffEditor' });

  /** 统计数据 */
  private stats = {
    totalApplies: 0,
    successfulApplies: 0,
    failedApplies: 0,
    totalDiffsApplied: 0,
    totalRollbacks: 0,
    totalPreviews: 0,
    totalParses: 0,
    startTime: Date.now(),
  };

  constructor() {
    this.log.info('DiffEditor 初始化完成');
  }

  // ============ 核心方法 ============

  /**
   * 应用差异块到文件
   * - 验证所有 search 字符串存在（精确匹配，容许尾部空白差异）
   * - 原子性：全部成功或全部不应用
   * - 应用前自动创建备份
   */
  async applyDiff(filePath: string, diffs: DiffBlock[]): Promise<ApplyResult> {
    const startTime = Date.now();
    this.stats.totalApplies++;

    this.log.info('开始应用差异', { filePath, diffCount: diffs.length });

    // 参数校验
    if (!filePath) {
      this.stats.failedApplies++;
      return { success: false, filePath, appliedDiffs: 0, failedDiffs: [], error: '文件路径不能为空' };
    }
    if (!diffs || diffs.length === 0) {
      this.stats.failedApplies++;
      return { success: false, filePath, appliedDiffs: 0, failedDiffs: [], error: '差异块列表不能为空' };
    }

    // 读取文件
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      this.stats.failedApplies++;
      const errorMsg = `读取文件失败: ${errMsg(err)}`;
      this.log.error(errorMsg, { filePath });
      return { success: false, filePath, appliedDiffs: 0, failedDiffs: [], error: errorMsg };
    }

    // 预验证：检查所有 search 字符串是否存在
    const failedDiffs: Array<{ index: number; reason: string }> = [];
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      if (!diff.search) {
        failedDiffs.push({ index: i, reason: 'search 字符串不能为空' });
        continue;
      }
      if (!this.findMatch(content, diff.search)) {
        failedDiffs.push({
          index: i,
          reason: `未找到匹配的文本块。可能的原因：缩进不一致、行尾符差异、或文本已被修改`,
        });
      }
    }

    if (failedDiffs.length > 0) {
      this.stats.failedApplies++;
      this.log.warn('差异预验证失败', { filePath, failedCount: failedDiffs.length });
      return {
        success: false,
        filePath,
        appliedDiffs: 0,
        failedDiffs,
        error: `${failedDiffs.length} 个差异块未找到匹配`,
      };
    }

    // 创建备份
    let backupPath: string | undefined;
    try {
      backupPath = await this.createBackup(filePath, content);
      this.log.info('备份已创建', { backupPath });
    } catch (err: unknown) {
      this.stats.failedApplies++;
      const errorMsg = `创建备份失败: ${errMsg(err)}`;
      this.log.error(errorMsg, { filePath });
      return { success: false, filePath, appliedDiffs: 0, failedDiffs: [], error: errorMsg };
    }

    // 逐个应用差异块
    let modifiedContent = content;
    let appliedCount = 0;

    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const matchResult = this.findMatch(modifiedContent, diff.search);
      if (matchResult) {
        modifiedContent =
          modifiedContent.substring(0, matchResult.start) +
          diff.replace +
          modifiedContent.substring(matchResult.end);
        appliedCount++;
      } else {
        // 理论上不会到这里（预验证已通过），但防御性编程
        this.stats.failedApplies++;
        this.log.error('应用差异时匹配失败（预验证已通过，但实际匹配失败）', { filePath, diffIndex: i });

        // 尝试从备份恢复
        if (backupPath) {
          try {
            await fs.promises.copyFile(backupPath, filePath);
            this.log.info('已从备份恢复', { filePath, backupPath });
          } catch (restoreErr: unknown) {
            this.log.error('从备份恢复失败', { filePath, error: errMsg(restoreErr) });
          }
        }

        return {
          success: false,
          filePath,
          appliedDiffs: appliedCount,
          failedDiffs: [{ index: i, reason: '应用时匹配失败（文件可能在应用过程中被修改）' }],
          backupPath,
          error: `差异块 #${i} 应用时匹配失败`,
        };
      }
    }

    // 写入修改后的文件
    try {
      await fs.promises.writeFile(filePath, modifiedContent, 'utf-8');
    } catch (err: unknown) {
      this.stats.failedApplies++;
      const errorMsg = `写入文件失败: ${errMsg(err)}`;
      this.log.error(errorMsg, { filePath });

      // 尝试从备份恢复
      if (backupPath) {
        try {
          await fs.promises.copyFile(backupPath, filePath);
          this.log.info('已从备份恢复', { filePath, backupPath });
        } catch (restoreErr: unknown) {
          this.log.error('从备份恢复失败', { filePath, error: errMsg(restoreErr) });
        }
      }

      return {
        success: false,
        filePath,
        appliedDiffs: 0,
        failedDiffs: [],
        backupPath,
        error: errorMsg,
      };
    }

    // 成功
    this.stats.successfulApplies++;
    this.stats.totalDiffsApplied += appliedCount;

    const durationMs = Date.now() - startTime;
    this.log.info('差异应用成功', {
      filePath,
      appliedCount,
      durationMs,
    });

    // 广播事件
    EventBus.getInstance().emitSync('diff.applied', {
      filePath,
      appliedCount,
      backupPath,
      durationMs,
    });

    return {
      success: true,
      filePath,
      appliedDiffs: appliedCount,
      failedDiffs: [],
      backupPath,
    };
  }

  /**
   * 解析标准 diff 格式字符串
   * 格式：
   *   <<<<<<< SEARCH
   *   原始代码
   *   =======
   *   替换代码
   *   >>>>>>> REPLACE
   */
  parseDiffFormat(diffString: string): DiffBlock[] {
    this.stats.totalParses++;
    const blocks: DiffBlock[] = [];

    if (!diffString || !diffString.trim()) {
      return blocks;
    }

    // 按搜索标记分割
    const segments = diffString.split(SEARCH_MARKER);

    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];

      // 查找分隔符和结束标记
      const separatorIdx = segment.indexOf(SEPARATOR_MARKER);
      const replaceEndIdx = segment.indexOf(REPLACE_MARKER);

      if (separatorIdx === -1 || replaceEndIdx === -1) {
        this.log.warn('差异块格式不完整，已跳过', { segmentIndex: i });
        continue;
      }

      const searchContent = segment.substring(0, separatorIdx).trim();
      const replaceContent = segment.substring(separatorIdx + SEPARATOR_MARKER.length, replaceEndIdx).trim();

      if (!searchContent) {
        this.log.warn('差异块 search 内容为空，已跳过', { segmentIndex: i });
        continue;
      }

      blocks.push({
        search: searchContent,
        replace: replaceContent,
      });
    }

    this.log.info('差异格式解析完成', { blockCount: blocks.length });
    return blocks;
  }

  /**
   * 生成两个字符串之间的差异块
   * - 行级别差异对比
   * - 将相邻变更合并为块
   */
  generateDiff(original: string, modified: string): DiffBlock[] {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const blocks: DiffBlock[] = [];

    // 使用最长公共子序列（LCS）算法计算差异
    const lcs = this.computeLCS(originalLines, modifiedLines);

    // 根据 LCS 标记变更区域
    let oi = 0; // original index
    let mi = 0; // modified index
    let li = 0; // lcs index

    // 收集变更区域
    interface ChangeRegion {
      originalStart: number;
      originalEnd: number;
      modifiedStart: number;
      modifiedEnd: number;
    }

    const regions: ChangeRegion[] = [];
    let currentRegion: ChangeRegion | null = null;

    while (oi < originalLines.length || mi < modifiedLines.length) {
      const isOriginalInLCS = li < lcs.length && oi < originalLines.length && originalLines[oi] === lcs[li];
      const isModifiedInLCS = li < lcs.length && mi < modifiedLines.length && modifiedLines[mi] === lcs[li];

      if (isOriginalInLCS && isModifiedInLCS) {
        // 两者都匹配 LCS — 公共行
        if (currentRegion) {
          regions.push(currentRegion);
          currentRegion = null;
        }
        oi++;
        mi++;
        li++;
      } else {
        // 有差异
        if (!currentRegion) {
          currentRegion = {
            originalStart: oi,
            originalEnd: oi,
            modifiedStart: mi,
            modifiedEnd: mi,
          };
        }

        if (!isOriginalInLCS && oi < originalLines.length) {
          currentRegion.originalEnd = oi + 1;
          oi++;
        }
        if (!isModifiedInLCS && mi < modifiedLines.length) {
          currentRegion.modifiedEnd = mi + 1;
          mi++;
        }

        // 如果两边都不在 LCS 中，LCS 不前进
        if (!isOriginalInLCS && !isModifiedInLCS) {
          // 两个指针都已前进
        } else if (isOriginalInLCS) {
          // 只有 original 匹配，modified 不匹配
          // mi 已前进
        } else {
          // 只有 modified 匹配，original 不匹配
          // oi 已前进
        }
      }
    }

    // 处理最后的区域
    if (currentRegion) {
      regions.push(currentRegion);
    }

    // 合并相邻区域（间距 ≤ 2 行的合并为一个块）
    const mergedRegions: ChangeRegion[] = [];
    for (const region of regions) {
      if (mergedRegions.length > 0) {
        const last = mergedRegions[mergedRegions.length - 1];
        const gap = region.originalStart - last.originalEnd;
        if (gap <= 2) {
          // 合并
          last.originalEnd = Math.max(last.originalEnd, region.originalEnd);
          last.modifiedEnd = Math.max(last.modifiedEnd, region.modifiedEnd);
          continue;
        }
      }
      mergedRegions.push({ ...region });
    }

    // 为每个区域生成 DiffBlock，包含上下文行
    const contextLines = 2; // 上下文行数

    for (const region of mergedRegions) {
      const ctxStart = Math.max(0, region.originalStart - contextLines);
      const ctxEnd = Math.min(originalLines.length, region.originalEnd + contextLines);

      const searchLines = originalLines.slice(ctxStart, ctxEnd);
      const replaceLines: string[] = [];

      // 上下文前缀
      for (let i = ctxStart; i < region.originalStart; i++) {
        replaceLines.push(originalLines[i]);
      }
      // 替换内容
      for (let i = region.modifiedStart; i < region.modifiedEnd; i++) {
        if (i < modifiedLines.length) {
          replaceLines.push(modifiedLines[i]);
        }
      }
      // 上下文后缀
      for (let i = region.originalEnd; i < ctxEnd; i++) {
        if (i < originalLines.length) {
          replaceLines.push(originalLines[i]);
        }
      }

      blocks.push({
        search: searchLines.join('\n'),
        replace: replaceLines.join('\n'),
        description: `行 ${region.originalStart + 1}-${region.originalEnd} 变更`,
      });
    }

    this.log.info('差异生成完成', { blockCount: blocks.length });
    return blocks;
  }

  /**
   * 预览差异变更内容
   * - 展示每个差异块的变更前后对比
   * - 返回格式化的预览字符串
   */
  async previewDiff(filePath: string, diffs: DiffBlock[]): Promise<string> {
    this.stats.totalPreviews++;

    if (!filePath) {
      return '❌ 文件路径不能为空';
    }
    if (!diffs || diffs.length === 0) {
      return '❌ 差异块列表不能为空';
    }

    // 读取文件
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      return `❌ 读取文件失败: ${errMsg(err)}`;
    }

    const lines = content.split('\n');
    const preview = this.buildDiffPreview(filePath, content, lines, diffs);

    // 广播事件
    EventBus.getInstance().emitSync('diff.previewed', {
      filePath,
      blockCount: diffs.length,
      totalChanges: preview.totalChanges,
    });

    // 格式化输出
    const output: string[] = [];
    output.push(`📋 差异预览: ${filePath}`);
    output.push(`   总变更: ${preview.totalChanges} 处 | +${preview.linesAdded} 行 | -${preview.linesRemoved} 行`);
    output.push('');

    for (const block of preview.blocks) {
      output.push(`── 差异块 #${block.index} ──`);
      if (block.description) {
        output.push(`   描述: ${block.description}`);
      }
      output.push(`   位置: 第 ${block.lineRange.start}-${block.lineRange.end} 行`);
      output.push('');
      output.push('   变更前:');
      for (const line of block.before.split('\n')) {
        output.push(`   - ${line}`);
      }
      output.push('');
      output.push('   变更后:');
      for (const line of block.after.split('\n')) {
        output.push(`   + ${line}`);
      }
      output.push('');
    }

    return output.join('\n');
  }

  /**
   * 回滚文件到上一个版本
   * - 从备份目录恢复
   */
  async rollback(filePath: string): Promise<string> {
    this.stats.totalRollbacks++;

    if (!filePath) {
      return '❌ 文件路径不能为空';
    }

    const absFilePath = path.resolve(filePath);
    const backupPath = this.getBackupPath(absFilePath);

    try {
      // 检查备份是否存在
      await fs.promises.access(backupPath, fs.constants.R_OK);
    } catch {
      this.log.warn('未找到备份文件', { filePath, backupPath });
      return `❌ 未找到备份文件: ${backupPath}`;
    }

    try {
      await fs.promises.copyFile(backupPath, absFilePath);
      this.log.info('文件已回滚', { filePath, backupPath });

      EventBus.getInstance().emitSync('diff.rollback', {
        filePath,
        backupPath,
      });

      return `✅ 文件已回滚: ${filePath}\n   从备份: ${backupPath}`;
    } catch (err: unknown) {
      const errorMsg = `回滚失败: ${errMsg(err)}`;
      this.log.error(errorMsg, { filePath, backupPath });
      return `❌ ${errorMsg}`;
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<string, unknown> {
    const uptime = Date.now() - this.stats.startTime;
    return {
      ...this.stats,
      uptimeMs: uptime,
      successRate: this.stats.totalApplies > 0
        ? (this.stats.successfulApplies / this.stats.totalApplies * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const editor = this;

    return [
      {
        name: 'diff_apply',
        description: '将差异块精确应用到文件。每个差异块包含 search（要查找的文本）和 replace（替换文本）。所有差异块原子性应用：全部成功或全部不应用。应用前自动创建备份，支持回滚。',
        parameters: {
          filePath: {
            type: 'string',
            description: '目标文件路径',
            required: true,
          },
          diffs: {
            type: 'string',
            description: '差异块列表，JSON 数组格式。每项包含 search（要查找的精确文本）、replace（替换文本）、description（可选描述）。例: [{"search":"old code","replace":"new code","description":"修复bug"}]',
            required: true,
          },
        },
        execute: async (args) => {
          try {
            const filePath = args.filePath as string;
            let diffs: DiffBlock[];
            try {
              diffs = JSON.parse(args.diffs as string);
            } catch {
              return '❌ diffs 参数格式错误，需要 JSON 数组格式';
            }

            if (!Array.isArray(diffs) || diffs.length === 0) {
              return '❌ diffs 不能为空数组';
            }

            const result = await editor.applyDiff(filePath, diffs);

            if (result.success) {
              const lines: string[] = [];
              lines.push(`✅ 差异应用成功: ${result.filePath}`);
              lines.push(`   已应用: ${result.appliedDiffs} 个差异块`);
              if (result.backupPath) {
                lines.push(`   备份: ${result.backupPath}`);
              }
              return lines.join('\n');
            } else {
              const lines: string[] = [];
              lines.push(`❌ 差异应用失败: ${result.error || '未知错误'}`);
              if (result.failedDiffs.length > 0) {
                lines.push('   失败详情:');
                for (const fd of result.failedDiffs) {
                  lines.push(`   - 差异块 #${fd.index}: ${fd.reason}`);
                }
              }
              return lines.join('\n');
            }
          } catch (err: unknown) {
            editor.log.error('diff_apply 执行失败', { error: errMsg(err) });
            return `❌ 执行失败: ${errMsg(err)}`;
          }
        },
      },
      {
        name: 'diff_preview',
        description: '预览差异变更内容。展示每个差异块的变更前后对比、行号范围、新增/删除行数统计。不会实际修改文件。',
        parameters: {
          filePath: {
            type: 'string',
            description: '目标文件路径',
            required: true,
          },
          diffs: {
            type: 'string',
            description: '差异块列表，JSON 数组格式。每项包含 search 和 replace 字段',
            required: true,
          },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const filePath = args.filePath as string;
            let diffs: DiffBlock[];
            try {
              diffs = JSON.parse(args.diffs as string);
            } catch {
              return '❌ diffs 参数格式错误，需要 JSON 数组格式';
            }

            return await editor.previewDiff(filePath, diffs);
          } catch (err: unknown) {
            editor.log.error('diff_preview 执行失败', { error: errMsg(err) });
            return `❌ 执行失败: ${errMsg(err)}`;
          }
        },
      },
      {
        name: 'diff_rollback',
        description: '将文件回滚到上次应用差异前的版本。从备份目录恢复文件内容。每个文件只保留最近一次备份。',
        parameters: {
          filePath: {
            type: 'string',
            description: '要回滚的文件路径',
            required: true,
          },
        },
        execute: async (args) => {
          try {
            const filePath = args.filePath as string;
            return await editor.rollback(filePath);
          } catch (err: unknown) {
            editor.log.error('diff_rollback 执行失败', { error: errMsg(err) });
            return `❌ 执行失败: ${errMsg(err)}`;
          }
        },
      },
      {
        name: 'diff_parse',
        description: '解析标准 diff 格式字符串为结构化差异块。格式：<<<<<<< SEARCH / 原始代码 / ======= / 替换代码 / >>>>>>> REPLACE。支持多个差异块。',
        parameters: {
          diffString: {
            type: 'string',
            description: '标准 diff 格式字符串，使用 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 标记',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const diffString = args.diffString as string;
            const blocks = editor.parseDiffFormat(diffString);

            if (blocks.length === 0) {
              return Promise.resolve('未解析到有效的差异块。请检查格式是否正确：\n<<<<<<< SEARCH\n原始代码\n=======\n替换代码\n>>>>>>> REPLACE');
            }

            const lines: string[] = [];
            lines.push(`✅ 解析完成: ${blocks.length} 个差异块`);
            lines.push('');
            for (let i = 0; i < blocks.length; i++) {
              const block = blocks[i];
              lines.push(`── 差异块 #${i} ──`);
              if (block.description) {
                lines.push(`   描述: ${block.description}`);
              }
              lines.push(`   搜索文本 (${block.search.split('\n').length} 行):`);
              const searchPreview = block.search.split('\n').slice(0, 5).join('\n');
              lines.push(`   ${searchPreview}${block.search.split('\n').length > 5 ? '\n   ...' : ''}`);
              lines.push(`   替换文本 (${block.replace.split('\n').length} 行):`);
              const replacePreview = block.replace.split('\n').slice(0, 5).join('\n');
              lines.push(`   ${replacePreview}${block.replace.split('\n').length > 5 ? '\n   ...' : ''}`);
              lines.push('');
            }

            // 同时输出 JSON 格式，方便后续使用
            lines.push('--- JSON 输出 ---');
            lines.push(JSON.stringify(blocks, null, 2));

            return Promise.resolve(lines.join('\n'));
          } catch (err: unknown) {
            editor.log.error('diff_parse 执行失败', { error: errMsg(err) });
            return Promise.resolve(`❌ 执行失败: ${errMsg(err)}`);
          }
        },
      },
    ];
  }

  // ============ 私有方法 ============

  /**
   * 在内容中查找匹配文本
   * - 精确匹配，但容许尾部空白差异
   * - 返回匹配的起止位置
   */
  private findMatch(content: string, search: string): { start: number; end: number } | null {
    // 精确匹配
    const exactIdx = content.indexOf(search);
    if (exactIdx !== -1) {
      return { start: exactIdx, end: exactIdx + search.length };
    }

    // 容许尾部空白差异的匹配
    // 逐行对比，忽略每行尾部的空白字符
    const searchLines = search.split('\n');
    const contentLines = content.split('\n');

    for (let startLine = 0; startLine <= contentLines.length - searchLines.length; startLine++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[startLine + j].trimEnd() !== searchLines[j].trimEnd()) {
          match = false;
          break;
        }
      }
      if (match) {
        // 计算字符偏移
        let charStart = 0;
        for (let i = 0; i < startLine; i++) {
          charStart += contentLines[i].length + 1; // +1 for \n
        }
        // 结束位置：从 startLine 开始数 searchLines.length 行
        let charEnd = charStart;
        for (let i = 0; i < searchLines.length; i++) {
          charEnd += contentLines[startLine + i].length + 1;
        }
        // 修正：使用原始 search 文本作为替换基准
        // 但匹配位置基于内容中的行
        return { start: charStart, end: charEnd - 1 }; // -1 去掉最后一个 \n
      }
    }

    return null;
  }

  /**
   * 创建文件备份
   */
  private async createBackup(filePath: string, content: string): Promise<string> {
    const absPath = path.resolve(filePath);
    const backupPath = this.getBackupPath(absPath);

    // 确保备份目录存在
    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });

    // 写入备份
    await fs.promises.writeFile(backupPath, content, 'utf-8');

    return backupPath;
  }

  /**
   * 获取备份文件路径
   */
  private getBackupPath(absFilePath: string): string {
    // 将绝对路径转换为安全的文件名
    const safeName = absFilePath
      .replace(/[:\\/]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_/, '');

    return path.join(BACKUP_DIR, `${safeName}.bak`);
  }

  /**
   * 构建差异预览数据
   */
  private buildDiffPreview(
    filePath: string,
    content: string,
    lines: string[],
    diffs: DiffBlock[],
  ): DiffPreview {
    const blocks: DiffPreview['blocks'] = [];
    let totalChanges = 0;
    let linesAdded = 0;
    let linesRemoved = 0;

    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const matchResult = this.findMatch(content, diff.search);

      let lineRange = { start: 0, end: 0 };
      let before = diff.search;
      const after = diff.replace;

      if (matchResult) {
        // 计算行号范围
        let lineStart = 1;
        for (let c = 0; c < matchResult.start; c++) {
          if (content[c] === '\n') lineStart++;
        }
        let lineEnd = lineStart;
        for (let c = matchResult.start; c < matchResult.end; c++) {
          if (content[c] === '\n') lineEnd++;
        }
        lineRange = { start: lineStart, end: lineEnd };
      } else {
        before = diff.search + '  ⚠️ 未找到匹配';
      }

      const addedLines = diff.replace.split('\n').length;
      const removedLines = diff.search.split('\n').length;
      linesAdded += addedLines;
      linesRemoved += removedLines;
      totalChanges++;

      blocks.push({
        index: i,
        description: diff.description,
        before,
        after,
        lineRange,
      });
    }

    return {
      filePath,
      blocks,
      totalChanges,
      linesAdded,
      linesRemoved,
    };
  }

  /**
   * 计算最长公共子序列（LCS）
   * 用于行级别差异对比
   */
  private computeLCS(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;

    // 优化：对于大文件，使用滚动数组减少内存
    // dp[i][j] = LCS 长度
    // 只保留两行
    const _prev = new Array(n + 1).fill(0);
    const _curr = new Array(n + 1).fill(0);

    // 同时记录路径用于回溯
    // 对于大文件，使用 Hirschberg 算法更优，但这里用简单实现
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
      dp.push(new Array(n + 1).fill(0));
    }

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // 回溯获取 LCS
    const result: string[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return result;
  }
}
