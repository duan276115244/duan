/**
 * ProjectMemoryLoader 单元测试 — v20.0 项目分层记忆
 *
 * 验证三级分层加载、去重、缓存、写入/追加/删除等核心功能。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectMemoryLoader } from '../project-memory-loader.js';

describe('ProjectMemoryLoader', () => {
  let loader: ProjectMemoryLoader;
  let tmpRoot: string;
  let tmpRepo: string;
  let tmpSubdir: string;
  let tmpGlobal: string;
  let originalCwd: string;

  beforeEach(() => {
    // 创建临时目录结构
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-pml-test-'));
    tmpRepo = path.join(tmpRoot, 'repo');
    tmpSubdir = path.join(tmpRepo, 'packages', 'core');
    tmpGlobal = path.join(tmpRoot, 'global');

    fs.mkdirSync(tmpRepo, { recursive: true });
    fs.mkdirSync(tmpSubdir, { recursive: true });
    fs.mkdirSync(tmpGlobal, { recursive: true });

    // 模拟仓库根（创建 .git）
    fs.mkdirSync(path.join(tmpRepo, '.git'), { recursive: true });

    // 备份并覆盖 cwd
    originalCwd = process.cwd();
    process.chdir(tmpSubdir);

    // 通过构造函数注入全局目录（避免依赖 os.homedir）
    loader = new ProjectMemoryLoader({ globalDir: tmpGlobal });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('应返回空快照当无记忆文件时', async () => {
    const snapshot = await loader.load(tmpSubdir);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.mergedText).toBe('');
  });

  it('应加载用户全局层记忆', async () => {
    fs.mkdirSync(tmpGlobal, { recursive: true });
    fs.writeFileSync(
      path.join(tmpGlobal, 'conventions.md'),
      '# 全局约定\n- 使用 ESM 模块',
      'utf-8'
    );

    const snapshot = await loader.load(tmpSubdir);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].layer).toBe('global');
    expect(snapshot.entries[0].name).toBe('conventions');
    expect(snapshot.mergedText).toContain('全局约定');
  });

  it('应加载仓库根层记忆', async () => {
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'coding-style.md'),
      '# 编码风格\n- TypeScript strict',
      'utf-8'
    );

    const snapshot = await loader.load(tmpSubdir);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].layer).toBe('repo');
    expect(snapshot.mergedText).toContain('编码风格');
  });

  it('应加载子目录层记忆', async () => {
    const subdirDir = path.join(tmpSubdir, '.duan', 'memory');
    fs.mkdirSync(subdirDir, { recursive: true });
    fs.writeFileSync(
      path.join(subdirDir, 'module-rules.md'),
      '# 模块规则\n- 仅导出函数',
      'utf-8'
    );

    const snapshot = await loader.load(tmpSubdir);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].layer).toBe('subdir');
    expect(snapshot.mergedText).toContain('模块规则');
  });

  it('应合并三级记忆并按层级排序', async () => {
    // 全局层
    fs.mkdirSync(tmpGlobal, { recursive: true });
    fs.writeFileSync(path.join(tmpGlobal, 'global.md'), '# 全局', 'utf-8');

    // 仓库根层
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'repo.md'), '# 仓库', 'utf-8');

    // 子目录层
    const subdirDir = path.join(tmpSubdir, '.duan', 'memory');
    fs.mkdirSync(subdirDir, { recursive: true });
    fs.writeFileSync(path.join(subdirDir, 'subdir.md'), '# 子目录', 'utf-8');

    const snapshot = await loader.load(tmpSubdir);
    expect(snapshot.entries).toHaveLength(3);

    // 验证合并文本包含所有层级
    expect(snapshot.mergedText).toContain('全局记忆');
    expect(snapshot.mergedText).toContain('项目记忆');
    expect(snapshot.mergedText).toContain('子目录记忆');
  });

  it('同名文件应去重，子目录层优先', async () => {
    // 三级都有 conventions.md
    fs.mkdirSync(tmpGlobal, { recursive: true });
    fs.writeFileSync(path.join(tmpGlobal, 'conventions.md'), '# 全局版', 'utf-8');

    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'conventions.md'), '# 仓库版', 'utf-8');

    const subdirDir = path.join(tmpSubdir, '.duan', 'memory');
    fs.mkdirSync(subdirDir, { recursive: true });
    fs.writeFileSync(path.join(subdirDir, 'conventions.md'), '# 子目录版', 'utf-8');

    const snapshot = await loader.load(tmpSubdir);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].layer).toBe('subdir');
    expect(snapshot.entries[0].content).toContain('子目录版');
  });

  it('应使用缓存避免重复 IO', async () => {
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'test.md'), '# Test', 'utf-8');

    // 第一次加载
    const snapshot1 = await loader.load(tmpSubdir);

    // 第二次加载（应命中缓存，返回同一引用）
    const snapshot2 = await loader.load(tmpSubdir);

    expect(snapshot2).toBe(snapshot1);
  });

  it('writeEntry 应创建记忆文件', async () => {
    await loader.writeEntry('test-convention', '# 测试约定\n- 规则1', 'repo', tmpSubdir);

    const filePath = path.join(tmpSubdir, '.duan', 'memory', 'test-convention.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('测试约定');

    // 验证缓存失效后能加载新文件
    const snapshot = await loader.load(tmpSubdir, { forceRefresh: true });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].name).toBe('test-convention');
  });

  it('appendToEntry 应追加到已有文件', async () => {
    // 先写入
    await loader.writeEntry('rules', '# 规则\n- 规则1', 'repo', tmpSubdir);
    // 再追加
    await loader.appendToEntry('rules', '- 规则2', 'repo', tmpSubdir);

    const filePath = path.join(tmpSubdir, '.duan', 'memory', 'rules.md');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('规则1');
    expect(content).toContain('规则2');
  });

  it('deleteEntry 应删除记忆文件', async () => {
    await loader.writeEntry('to-delete', '# 待删除', 'repo', tmpSubdir);
    const filePath = path.join(tmpSubdir, '.duan', 'memory', 'to-delete.md');
    expect(fs.existsSync(filePath)).toBe(true);

    const deleted = await loader.deleteEntry('to-delete', 'repo', tmpSubdir);
    expect(deleted).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deleteEntry 不存在的文件应返回 false', async () => {
    const deleted = await loader.deleteEntry('nonexistent', 'repo', tmpSubdir);
    expect(deleted).toBe(false);
  });

  it('getOverview 应返回格式化的概览', async () => {
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'style.md'), '# 编码风格\n- strict', 'utf-8');

    const overview = await loader.getOverview(tmpSubdir);
    expect(overview).toContain('项目记忆概览');
    expect(overview).toContain('style.md');
    expect(overview).toContain('仓库根层');
  });

  it('getOverview 无文件时应返回提示', async () => {
    const overview = await loader.getOverview(tmpSubdir);
    expect(overview).toContain('未找到项目记忆文件');
  });

  it('loadSync 同步加载应与异步加载结果一致', async () => {
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'sync-test.md'), '# 同步测试', 'utf-8');

    const syncSnapshot = loader.loadSync(tmpSubdir, { forceRefresh: true });
    const asyncSnapshot = await loader.load(tmpSubdir, { forceRefresh: true });

    expect(syncSnapshot.entries).toHaveLength(asyncSnapshot.entries.length);
    expect(syncSnapshot.mergedText).toBe(asyncSnapshot.mergedText);
  });

  it('getToolDefinitions 应返回 4 个工具', () => {
    const defs = loader.getToolDefinitions();
    expect(defs).toHaveLength(4);
    expect(defs.map(d => d.name)).toContain('project_memory_list');
    expect(defs.map(d => d.name)).toContain('project_memory_write');
    expect(defs.map(d => d.name)).toContain('project_memory_append');
    expect(defs.map(d => d.name)).toContain('project_memory_delete');
  });

  it('project_memory_list 工具应返回概览', async () => {
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'tool-test.md'), '# 工具测试', 'utf-8');

    const defs = loader.getToolDefinitions();
    const listTool = defs.find(d => d.name === 'project_memory_list')!;
    const result = await listTool.execute!({});
    expect(typeof result).toBe('string');
    expect(result as string).toContain('tool-test.md');
  });

  it('project_memory_write 工具应写入文件', async () => {
    const defs = loader.getToolDefinitions();
    const writeTool = defs.find(d => d.name === 'project_memory_write')!;
    const result = await writeTool.execute!({
      name: 'tool-written',
      content: '# 工具写入',
      layer: 'repo',
    });
    expect(result as string).toContain('✅');

    const filePath = path.join(tmpSubdir, '.duan', 'memory', 'tool-written.md');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('应跳过过大的文件', async () => {
    const repoDir = path.join(tmpRepo, '.duan', 'memory');
    fs.mkdirSync(repoDir, { recursive: true });
    // 写入超过 64KB 的文件
    const largeContent = '# Large\n' + 'x'.repeat(70 * 1024);
    fs.writeFileSync(path.join(repoDir, 'large.md'), largeContent, 'utf-8');

    const snapshot = await loader.load(tmpSubdir, { forceRefresh: true });
    expect(snapshot.entries).toHaveLength(0);
  });

  it('应安全处理文件名（去除非法字符）', async () => {
    await loader.writeEntry('test<>:file', '# 内容', 'repo', tmpSubdir);
    const filePath = path.join(tmpSubdir, '.duan', 'memory', 'test___file.md');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
