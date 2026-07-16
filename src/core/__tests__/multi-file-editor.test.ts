/**
 * v20.0 §3.3 多文件协同编辑测试
 *
 * 测试 MultiFileEditor 的核心功能：
 * - 原子性多文件编辑（全部成功才提交）
 * - 失败回滚（任一失败恢复所有已修改文件）
 * - 替换/创建/删除操作
 * - 预检（oldString 唯一性检查）
 * - 工具定义与执行
 * - 单例
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MultiFileEditor, getMultiFileEditor, type FileEdit } from '../multi-file-editor.js';

// ============ 工具：创建临时项目 ============

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mfe-test-'));
}

function writeFile(base: string, relPath: string, content: string): string {
  const fullPath = path.join(base, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function readFile(base: string, relPath: string): string {
  return fs.readFileSync(path.join(base, relPath), 'utf-8');
}

function fileExists(base: string, relPath: string): boolean {
  return fs.existsSync(path.join(base, relPath));
}

// ============ 测试 ============

describe('v20.0 §3.3: MultiFileEditor', () => {
  let editor: MultiFileEditor;
  let tmpProject: string;

  beforeEach(() => {
    editor = new MultiFileEditor();
    tmpProject = createTempProject();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('applyEdits 基础操作', () => {
    it('空编辑数组返回成功', async () => {
      const result = await editor.applyEdits([], { cwd: tmpProject });
      expect(result.success).toBe(true);
      expect(result.appliedCount).toBe(0);
      expect(result.summary).toContain('无编辑操作');
    });

    it('单文件替换', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(result.appliedCount).toBe(1);
      expect(readFile(tmpProject, 'src/a.ts')).toContain('const x = 2;');
    });

    it('多文件替换', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\n');
      writeFile(tmpProject, 'src/b.ts', 'const y = 1;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' },
        { filePath: 'src/b.ts', oldString: 'const y = 1;', newString: 'const y = 3;' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(result.appliedCount).toBe(2);
      expect(readFile(tmpProject, 'src/a.ts')).toContain('const x = 2;');
      expect(readFile(tmpProject, 'src/b.ts')).toContain('const y = 3;');
    });

    it('创建新文件（oldString 为空）', async () => {
      const result = await editor.applyEdits([
        { filePath: 'src/new.ts', oldString: '', newString: 'export const foo = 1;\n' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(fileExists(tmpProject, 'src/new.ts')).toBe(true);
      expect(readFile(tmpProject, 'src/new.ts')).toContain('foo');
    });

    it('删除文件（newString 为 null）', async () => {
      writeFile(tmpProject, 'src/del.ts', 'content');

      const result = await editor.applyEdits([
        { filePath: 'src/del.ts', oldString: 'content', newString: null },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(fileExists(tmpProject, 'src/del.ts')).toBe(false);
    });

    it('创建嵌套目录', async () => {
      const result = await editor.applyEdits([
        { filePath: 'src/deep/nested/dir/file.ts', oldString: '', newString: 'export {};\n' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(fileExists(tmpProject, 'src/deep/nested/dir/file.ts')).toBe(true);
    });
  });

  describe('原子性与回滚', () => {
    it('一个编辑失败时回滚所有已修改文件', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\n');
      writeFile(tmpProject, 'src/b.ts', 'const y = 1;\n');

      // 第一个编辑修改 a.ts 成功
      // 第二个编辑 oldString 与 newString 相同：precheck 通过（oldString 存在且唯一），
      // 但应用阶段 applySingleEdit 检测到"替换后内容未变化"抛错 → 触发回滚
      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' },
        { filePath: 'src/b.ts', oldString: 'const y = 1;', newString: 'const y = 1;' }, // 应用阶段失败
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.rolledBackCount).toBe(2);
      // a.ts 应恢复原始内容
      expect(readFile(tmpProject, 'src/a.ts')).toBe('const x = 1;\n');
      expect(readFile(tmpProject, 'src/b.ts')).toBe('const y = 1;\n');
    });

    it('创建后失败时回滚删除新创建的文件', async () => {
      writeFile(tmpProject, 'src/existing.ts', 'content');

      const result = await editor.applyEdits([
        { filePath: 'src/new.ts', oldString: '', newString: 'new content' },
        { filePath: 'src/existing.ts', oldString: 'NOT_FOUND', newString: 'x' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      // 新创建的文件应被删除
      expect(fileExists(tmpProject, 'src/new.ts')).toBe(false);
      // existing.ts 应保持不变
      expect(readFile(tmpProject, 'src/existing.ts')).toBe('content');
    });

    it('删除后失败时回滚恢复被删除的文件', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\n');
      writeFile(tmpProject, 'src/b.ts', 'const y = 1;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'const x = 1;\n', newString: null }, // 删除 a.ts
        { filePath: 'src/b.ts', oldString: 'NOT_FOUND', newString: 'x' }, // 失败
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      // a.ts 应被恢复
      expect(fileExists(tmpProject, 'src/a.ts')).toBe(true);
      expect(readFile(tmpProject, 'src/a.ts')).toBe('const x = 1;\n');
    });

    it('modifiedFiles 在失败时为空', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'NOT_FOUND', newString: 'x' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.modifiedFiles).toEqual([]);
    });
  });

  describe('预检', () => {
    it('oldString 未找到时报错', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'NOT_EXIST', newString: 'x' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.failures[0].error).toContain('未在文件中找到');
    });

    it('oldString 多次出现时报错（要求唯一）', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\nconst x = 1;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.failures[0].error).toContain('2 次');
    });

    it('文件不存在时替换操作报错', async () => {
      const result = await editor.applyEdits([
        { filePath: 'src/nonexistent.ts', oldString: 'x', newString: 'y' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.failures[0].error).toContain('文件不存在');
    });

    it('创建已存在的文件时报错', async () => {
      writeFile(tmpProject, 'src/existing.ts', 'content');

      const result = await editor.applyEdits([
        { filePath: 'src/existing.ts', oldString: '', newString: 'new' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.failures[0].error).toContain('文件已存在');
    });

    it('删除不存在的文件时报错', async () => {
      const result = await editor.applyEdits([
        { filePath: 'src/nonexistent.ts', oldString: 'x', newString: null },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.failures[0].error).toContain('文件不存在');
    });

    it('多个预检失败全部报告', async () => {
      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'NOT_FOUND', newString: 'x' },
        { filePath: 'src/b.ts', oldString: 'ALSO_NOT_FOUND', newString: 'y' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(result.failures.length).toBe(2);
    });

    it('预检失败时不修改任何文件', async () => {
      writeFile(tmpProject, 'src/a.ts', 'original');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'NOT_FOUND', newString: 'x' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(false);
      expect(readFile(tmpProject, 'src/a.ts')).toBe('original');
    });
  });

  describe('复杂场景', () => {
    it('同一文件多次编辑（顺序应用）', async () => {
      writeFile(tmpProject, 'src/a.ts', 'const x = 1;\nconst y = 2;\n');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'const x = 1;', newString: 'const x = 10;' },
        { filePath: 'src/a.ts', oldString: 'const y = 2;', newString: 'const y = 20;' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      const content = readFile(tmpProject, 'src/a.ts');
      expect(content).toContain('const x = 10;');
      expect(content).toContain('const y = 20;');
    });

    it('混合操作：替换 + 创建 + 删除', async () => {
      writeFile(tmpProject, 'src/modify.ts', 'old content');
      writeFile(tmpProject, 'src/delete.ts', 'to delete');

      const result = await editor.applyEdits([
        { filePath: 'src/modify.ts', oldString: 'old content', newString: 'new content' },
        { filePath: 'src/create.ts', oldString: '', newString: 'created' },
        { filePath: 'src/delete.ts', oldString: 'to delete', newString: null },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(result.appliedCount).toBe(3);
      expect(readFile(tmpProject, 'src/modify.ts')).toBe('new content');
      expect(fileExists(tmpProject, 'src/create.ts')).toBe(true);
      expect(fileExists(tmpProject, 'src/delete.ts')).toBe(false);
    });

    it('绝对路径支持', async () => {
      const absPath = path.join(tmpProject, 'src/abs.ts');
      writeFile(tmpProject, 'src/abs.ts', 'content');

      const result = await editor.applyEdits([
        { filePath: absPath, oldString: 'content', newString: 'modified' },
      ], { cwd: tmpProject });

      expect(result.success).toBe(true);
      expect(readFile(tmpProject, 'src/abs.ts')).toBe('modified');
    });
  });

  describe('summary', () => {
    it('成功时包含文件数', async () => {
      writeFile(tmpProject, 'src/a.ts', 'x');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'x', newString: 'y' },
      ], { cwd: tmpProject });

      expect(result.summary).toContain('1');
      expect(result.summary).toContain('成功');
    });

    it('失败时包含错误信息和回滚数', async () => {
      writeFile(tmpProject, 'src/a.ts', 'x');

      const result = await editor.applyEdits([
        { filePath: 'src/a.ts', oldString: 'NOT_FOUND', newString: 'y' },
      ], { cwd: tmpProject });

      expect(result.summary).toContain('失败');
    });
  });

  describe('getToolDefinitions', () => {
    it('返回 1 个工具', () => {
      const tools = editor.getToolDefinitions();
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('multi_file_edit');
    });

    it('参数定义完整', () => {
      const tools = editor.getToolDefinitions();
      const tool = tools[0];
      expect(tool.parameters.edits).toBeDefined();
      expect(tool.parameters.edits.required).toBe(true);
      expect(tool.parameters.runTypecheck).toBeDefined();
      expect(tool.parameters.runTypecheck.required).toBe(false);
      expect(tool.parameters.runLint).toBeDefined();
      expect(tool.parameters.runLint.required).toBe(false);
    });

    it('缺少 edits 参数返回错误', async () => {
      const tools = editor.getToolDefinitions();
      const result = await tools[0].execute({});
      expect(result as string).toContain('缺少 edits 参数');
    });

    it('edits 为空数组返回错误', async () => {
      const tools = editor.getToolDefinitions();
      const result = await tools[0].execute({ edits: [] });
      expect(result as string).toContain('缺少 edits 参数');
    });

    it('正常执行返回结果', async () => {
      writeFile(tmpProject, 'src/a.ts', 'old');

      const tools = editor.getToolDefinitions();
      const result = await tools[0].execute({
        edits: [{ filePath: path.join(tmpProject, 'src/a.ts'), oldString: 'old', newString: 'new' }],
      });

      expect(result as string).toContain('成功');
      expect(readFile(tmpProject, 'src/a.ts')).toBe('new');
    });

    it('执行失败时返回错误详情', async () => {
      const tools = editor.getToolDefinitions();
      const result = await tools[0].execute({
        edits: [{ filePath: 'nonexistent.ts', oldString: 'x', newString: 'y' }],
      });

      expect(result as string).toContain('失败');
    });
  });

  describe('单例', () => {
    it('getMultiFileEditor 返回同一实例', () => {
      const a = getMultiFileEditor();
      const b = getMultiFileEditor();
      expect(a).toBe(b);
    });

    it('单例是 MultiFileEditor 实例', () => {
      expect(getMultiFileEditor()).toBeInstanceOf(MultiFileEditor);
    });
  });

  describe('FileEdit 类型', () => {
    it('字段完整', () => {
      const edit: FileEdit = {
        filePath: 'src/test.ts',
        oldString: 'old',
        newString: 'new',
      };
      expect(edit.filePath).toBe('src/test.ts');
      expect(edit.oldString).toBe('old');
      expect(edit.newString).toBe('new');
    });

    it('newString 为 null 表示删除', () => {
      const edit: FileEdit = {
        filePath: 'src/test.ts',
        oldString: 'content',
        newString: null,
      };
      expect(edit.newString).toBeNull();
    });
  });
});
