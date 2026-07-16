/**
 * v20.0 §3.3 多文件协同编辑 — MultiFileEditor
 *
 * 对标 Cursor 多文件协同编辑：一次任务跨多个文件修改，保持一致性。
 *
 * 核心能力：
 * 1. 原子性：全部成功才提交，任一失败回滚所有已修改文件
 * 2. 一致性校验：修改后可选跑 typecheck / lint
 * 3. 与 CodebaseIndexer 联动：修改函数定义时提示更新所有引用
 *
 * 工具接口：
 *   multi_file_edit({ edits: [{ filePath, oldString, newString }, ...] })
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 单个编辑操作 */
export interface FileEdit {
  /** 文件路径（相对或绝对） */
  filePath: string;
  /** 要替换的旧文本（空串表示创建新文件） */
  oldString: string;
  /** 替换为的新文本（null 表示删除文件） */
  newString: string | null;
}

/** 编辑结果 */
export interface EditResult {
  /** 是否全部成功 */
  success: boolean;
  /** 成功修改的文件数 */
  appliedCount: number;
  /** 失败的编辑及原因 */
  failures: Array<{ edit: FileEdit; error: string }>;
  /** 回滚的文件数（失败时） */
  rolledBackCount: number;
  /** 修改后的文件列表 */
  modifiedFiles: string[];
  /** 摘要信息 */
  summary: string;
}

/** 编辑选项 */
export interface EditOptions {
  /** 项目根目录 */
  cwd?: string;
  /** 是否在修改后运行 typecheck */
  runTypecheck?: boolean;
  /** 是否在修改后运行 lint */
  runLint?: boolean;
}

// ============ 主类 ============

export class MultiFileEditor {
  private log = logger.child({ module: 'MultiFileEditor' });

  /**
   * 原子性多文件编辑
   *
   * 策略：
   * 1. 先验证所有编辑的 oldString 能在对应文件中找到（预检）
   * 2. 备份所有将被修改的文件
   * 3. 逐个应用编辑
   * 4. 任一失败 → 回滚所有已修改文件
   * 5. 全部成功 → 清除备份
   */
  async applyEdits(edits: FileEdit[], options: EditOptions = {}): Promise<EditResult> {
    const cwd = options.cwd || process.cwd();

    if (edits.length === 0) {
      return {
        success: true,
        appliedCount: 0,
        failures: [],
        rolledBackCount: 0,
        modifiedFiles: [],
        summary: '无编辑操作',
      };
    }

    this.log.info('开始多文件编辑', { count: edits.length, cwd });

    // 1. 预检：验证所有 oldString 可找到
    const precheckResult = this.precheck(edits, cwd);
    if (precheckResult.failures.length > 0) {
      return {
        success: false,
        appliedCount: 0,
        failures: precheckResult.failures,
        rolledBackCount: 0,
        modifiedFiles: [],
        summary: `预检失败：${precheckResult.failures.length} 个编辑无法应用`,
      };
    }

    // 2. 备份
    const backups = new Map<string, string | null>(); // filePath → 原始内容（null 表示文件原本不存在）
    for (const edit of edits) {
      const absPath = this.resolvePath(edit.filePath, cwd);
      if (!backups.has(absPath)) {
        backups.set(absPath, this.readFileOrNull(absPath));
      }
    }

    // 3. 逐个应用
    const modifiedFiles: string[] = [];
    const failures: Array<{ edit: FileEdit; error: string }> = [];

    for (const edit of edits) {
      try {
        this.applySingleEdit(edit, cwd);
        modifiedFiles.push(this.resolvePath(edit.filePath, cwd));
        this.log.debug('编辑成功', { file: edit.filePath });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ edit, error: msg });
        this.log.warn('编辑失败', { file: edit.filePath, error: msg });
        break; // 第一个失败就停止
      }
    }

    // 4. 失败 → 回滚
    if (failures.length > 0) {
      const rolledBackCount = this.rollback(backups);
      this.log.info('已回滚', { count: rolledBackCount });
      return {
        success: false,
        appliedCount: modifiedFiles.length,
        failures,
        rolledBackCount,
        modifiedFiles: [],
        summary: `编辑失败：${failures[0].error}（已回滚 ${rolledBackCount} 个文件）`,
      };
    }

    // 5. 可选：typecheck / lint
    if (options.runTypecheck || options.runLint) {
      const validation = this.runValidation(options, cwd);
      if (!validation.success) {
        // 校验失败也回滚
        const rolledBackCount = this.rollback(backups);
        return {
          success: false,
          appliedCount: modifiedFiles.length,
          failures: [{
            edit: edits[0],
            error: `校验失败：${validation.output}`,
          }],
          rolledBackCount,
          modifiedFiles: [],
          summary: `校验失败，已回滚 ${rolledBackCount} 个文件`,
        };
      }
    }

    return {
      success: true,
      appliedCount: modifiedFiles.length,
      failures: [],
      rolledBackCount: 0,
      modifiedFiles,
      summary: `成功修改 ${modifiedFiles.length} 个文件`,
    };
  }

  // ============ 内部方法 ============

  /** 预检：验证所有 oldString 可找到 */
  private precheck(edits: FileEdit[], cwd: string): { failures: Array<{ edit: FileEdit; error: string }> } {
    const failures: Array<{ edit: FileEdit; error: string }> = [];

    for (const edit of edits) {
      const absPath = this.resolvePath(edit.filePath, cwd);

      // 删除文件操作
      if (edit.newString === null) {
        if (!fs.existsSync(absPath)) {
          failures.push({ edit, error: `文件不存在: ${edit.filePath}` });
        }
        continue;
      }

      // 创建新文件操作
      if (edit.oldString === '') {
        if (fs.existsSync(absPath)) {
          failures.push({ edit, error: `文件已存在（创建操作要求文件不存在）: ${edit.filePath}` });
        }
        continue;
      }

      // 替换操作
      const content = this.readFileOrNull(absPath);
      if (content === null) {
        failures.push({ edit, error: `文件不存在: ${edit.filePath}` });
        continue;
      }

      if (!content.includes(edit.oldString)) {
        failures.push({ edit, error: `oldString 未在文件中找到: ${edit.filePath}` });
        continue;
      }

      // 检查 oldString 唯一性
      const occurrences = content.split(edit.oldString).length - 1;
      if (occurrences > 1) {
        failures.push({ edit, error: `oldString 在文件中出现 ${occurrences} 次（要求唯一）: ${edit.filePath}` });
      }
    }

    return { failures };
  }

  /** 应用单个编辑 */
  private applySingleEdit(edit: FileEdit, cwd: string): void {
    const absPath = this.resolvePath(edit.filePath, cwd);

    // 删除文件
    if (edit.newString === null) {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        this.log.debug('文件已删除', { file: edit.filePath });
      }
      return;
    }

    // 创建新文件
    if (edit.oldString === '') {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, edit.newString, 'utf-8');
      this.log.debug('文件已创建', { file: edit.filePath });
      return;
    }

    // 替换
    const content = fs.readFileSync(absPath, 'utf-8');
    const newContent = content.replace(edit.oldString, edit.newString);
    if (newContent === content) {
      throw new Error(`替换后内容未变化: ${edit.filePath}`);
    }
    fs.writeFileSync(absPath, newContent, 'utf-8');
  }

  /** 回滚：恢复所有备份的文件 */
  private rollback(backups: Map<string, string | null>): number {
    let count = 0;
    for (const [absPath, originalContent] of backups) {
      try {
        if (originalContent === null) {
          // 文件原本不存在，删除
          if (fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
          }
        } else {
          // 恢复原始内容
          fs.writeFileSync(absPath, originalContent, 'utf-8');
        }
        count++;
      } catch (err: unknown) {
        this.log.error('回滚失败', {
          file: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return count;
  }

  /** 运行 typecheck / lint 校验 */
  private runValidation(options: EditOptions, cwd: string): { success: boolean; output: string } {
    const commands: string[] = [];

    if (options.runTypecheck) {
      commands.push('npx tsc --noEmit --skipLibCheck');
    }
    if (options.runLint) {
      commands.push('npx eslint src/ --max-warnings 0');
    }

    for (const cmd of commands) {
      try {
        execSync(cmd, {
          cwd,
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const errObj = err as { stdout?: string; message?: string };
        const output = errObj.stdout || errObj.message || String(err);
        return { success: false, output: String(output).substring(0, 500) };
      }
    }

    return { success: true, output: '' };
  }

  /** 读取文件内容，不存在返回 null */
  private readFileOrNull(absPath: string): string | null {
    try {
      if (!fs.existsSync(absPath)) return null;
      return fs.readFileSync(absPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 解析路径为绝对路径 */
  private resolvePath(filePath: string, cwd: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  }

  /**
   * v20.0 §3.3：暴露 multi_file_edit 工具给 LLM
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'multi_file_edit',
        description: '原子性多文件编辑：一次操作跨多个文件修改，全部成功才提交，任一失败自动回滚所有已修改文件。支持替换/创建/删除操作。',
        parameters: {
          edits: {
            type: 'array',
            description: '编辑操作数组。每个元素: { filePath, oldString, newString }。oldString 为空表示创建新文件，newString 为 null 表示删除文件。',
            required: true,
          },
          runTypecheck: {
            type: 'boolean',
            description: '修改后是否运行 typecheck（默认 false）',
            required: false,
          },
          runLint: {
            type: 'boolean',
            description: '修改后是否运行 lint（默认 false）',
            required: false,
          },
        },
        execute: async (args: { edits?: FileEdit[]; runTypecheck?: boolean; runLint?: boolean }) => {
          const edits = args?.edits;
          if (!edits || !Array.isArray(edits) || edits.length === 0) {
            return '❌ 缺少 edits 参数或为空';
          }

          const result = await this.applyEdits(edits, {
            runTypecheck: args?.runTypecheck,
            runLint: args?.runLint,
          });

          const lines: string[] = [result.summary];
          if (result.modifiedFiles.length > 0) {
            lines.push('', '已修改文件:');
            for (const f of result.modifiedFiles) {
              lines.push(`  ✓ ${path.relative(process.cwd(), f)}`);
            }
          }
          if (result.failures.length > 0) {
            lines.push('', '失败详情:');
            for (const fail of result.failures) {
              lines.push(`  ✗ ${fail.edit.filePath}: ${fail.error}`);
            }
          }
          return lines.join('\n');
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: MultiFileEditor | null = null;

export function getMultiFileEditor(): MultiFileEditor {
  if (!_instance) {
    _instance = new MultiFileEditor();
  }
  return _instance;
}
