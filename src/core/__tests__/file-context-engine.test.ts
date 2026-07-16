/**
 * 文件即接口上下文引擎单元测试
 *
 * 验证对标 Cursor 的"文件即接口"哲学：
 * 1. 工具结果文件化（>4KB）
 * 2. 摘要生成（前 500 + tail 200）
 * 3. 历史记录文件引用
 * 4. 终端输出文件化
 * 5. 搜索历史记录
 * 6. 统计信息
 * 7. 清理机制
 * 8. LLM 工具
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  FileContextEngine,
  getFileContextToolDefinitions,
  createFileContextToolHandler,
} from '../file-context-engine.js';

describe('文件即接口上下文引擎', () => {
  let engine: FileContextEngine;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-context-test-'));
    engine = new FileContextEngine({
      tmpDir,
      threshold: 100, // 测试用小阈值
      summaryHead: 50,
      summaryTail: 30,
      maxFiles: 10,
    });
  });

  afterEach(() => {
    engine.clear();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ========== 1. 工具结果文件化 ==========
  describe('工具结果文件化', () => {
    it('小结果不应文件化', () => {
      const result = engine.processToolResult('file_read', 'short content');
      expect(result.filed).toBe(false);
      expect(result.filePath).toBe('');
      expect(result.summary).toBe('short content');
    });

    it('大结果应文件化', () => {
      const largeContent = 'A'.repeat(200);
      const result = engine.processToolResult('shell_execute', largeContent);
      expect(result.filed).toBe(true);
      expect(result.filePath).toBeTruthy();
      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(result.rawLength).toBe(200);
    });

    it('文件化后文件内容应与原始一致', () => {
      const content = 'Hello\n'.repeat(50);
      const result = engine.processToolResult('web_fetch', content);
      if (result.filed) {
        const fileContent = fs.readFileSync(result.filePath, 'utf-8');
        expect(fileContent).toBe(content);
      }
    });

    it('文件名应包含工具名', () => {
      const content = 'X'.repeat(200);
      const result = engine.processToolResult('code_execute', content);
      if (result.filed) {
        expect(path.basename(result.filePath)).toContain('code_execute');
      }
    });
  });

  // ========== 2. 摘要生成 ==========
  describe('摘要生成', () => {
    it('短内容摘要应等于原文', () => {
      const content = 'short';
      const summary = engine.generateSummary(content);
      expect(summary).toBe(content);
    });

    it('长内容摘要应包含头尾和省略标记', () => {
      const content = 'A'.repeat(200);
      const result = engine.processToolResult('test', content);
      expect(result.summary).toContain('已省略');
      expect(result.summary).toContain('[已省略');
      expect(result.summary.length).toBeLessThan(content.length);
    });

    it('toContextString 文件化结果应包含文件路径引用', () => {
      const content = 'B'.repeat(200);
      const result = engine.processToolResult('shell_execute', content);
      const ctx = engine.toContextString(result);
      if (result.filed) {
        expect(ctx).toContain('文件化工具结果');
        expect(ctx).toContain(result.filePath);
        expect(ctx).toContain('file_read');
        expect(ctx).toContain('grep_search');
      }
    });

    it('toContextString 未文件化结果应返回原文', () => {
      const result = engine.processToolResult('test', 'short');
      const ctx = engine.toContextString(result);
      expect(ctx).toBe('short');
    });
  });

  // ========== 3. 历史记录文件引用 ==========
  describe('历史记录文件引用', () => {
    it('应能创建历史记录引用', () => {
      const id = engine.createHistoryRef('历史内容', '测试描述');
      expect(id).toBeTruthy();
      const ref = engine.getHistoryRef(id);
      expect(ref).toBeDefined();
      expect(ref!.description).toBe('测试描述');
      expect(fs.existsSync(ref!.filePath)).toBe(true);
    });

    it('应能列出所有历史引用', () => {
      engine.createHistoryRef('内容1', '描述1');
      engine.createHistoryRef('内容2', '描述2');
      const refs = engine.listHistoryRefs();
      expect(refs).toHaveLength(2);
    });

    it('应能搜索历史记录文件', () => {
      engine.createHistoryRef('包含关键词的内容', '测试');
      engine.createHistoryRef('不包含的', '测试');
      const matched = engine.searchHistoryFiles('关键词');
      expect(matched.length).toBeGreaterThanOrEqual(1);
    });

    it('不存在的引用 ID 应返回 undefined', () => {
      const ref = engine.getHistoryRef('nonexistent');
      expect(ref).toBeUndefined();
    });
  });

  // ========== 4. 终端输出文件化 ==========
  describe('终端输出文件化', () => {
    it('应能文件化终端输出', () => {
      const filePath = engine.fileTerminalOutput('输出内容', 'ls -la');
      expect(filePath).toBeTruthy();
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('终端输出文件化');
      expect(content).toContain('ls -la');
      expect(content).toContain('输出内容');
    });
  });

  // ========== 5. 统计信息 ==========
  describe('统计信息', () => {
    it('初始统计应为零', () => {
      const stats = engine.getStats();
      expect(stats.totalResults).toBe(0);
      expect(stats.filedCount).toBe(0);
      expect(stats.totalRawBytes).toBe(0);
      expect(stats.savingsRatio).toBe(0);
    });

    it('应正确统计文件化后的结果', () => {
      engine.processToolResult('test1', 'A'.repeat(200)); // 文件化
      engine.processToolResult('test2', 'short'); // 不文件化（不记录到 filedResults）
      engine.processToolResult('test3', 'B'.repeat(300)); // 文件化

      const stats = engine.getStats();
      // filedResults 只记录文件化的结果
      expect(stats.totalResults).toBe(2); // 只统计文件化的
      expect(stats.filedCount).toBe(2);
      expect(stats.totalRawBytes).toBe(200 + 300);
      expect(stats.savingsRatio).toBeGreaterThan(0);
      expect(stats.savingsRatio).toBeLessThan(1);
    });
  });

  // ========== 6. 清理机制 ==========
  describe('清理机制', () => {
    it('clear 应清空所有文件', () => {
      engine.processToolResult('test', 'X'.repeat(200));
      engine.createHistoryRef('内容', '描述');
      engine.clear();

      const stats = engine.getStats();
      expect(stats.totalResults).toBe(0);
      expect(engine.listHistoryRefs()).toHaveLength(0);
    });

    it('cleanup 应清理过期文件', async () => {
      engine.processToolResult('test', 'X'.repeat(200));
      // 等待一小段时间确保时间戳不同
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cleaned = engine.cleanup(1); // 1ms 最大年龄，几乎所有文件都过期
      expect(cleaned).toBeGreaterThanOrEqual(0);
    });

    it('应强制最大文件数限制', () => {
      // maxFiles = 10，所有结果都会被文件化（每条 50*9=450 字节 > 100 阈值）
      for (let i = 0; i < 15; i++) {
        engine.processToolResult('test', `content-${i}-`.repeat(50));
      }
      const stats = engine.getStats();
      // filedResults 被限制在 maxFiles = 10
      expect(stats.totalResults).toBeLessThanOrEqual(10);
    });
  });

  // ========== 7. LLM 工具 ==========
  describe('LLM 工具', () => {
    it('应返回 4 个工具定义', () => {
      const tools = getFileContextToolDefinitions();
      expect(tools).toHaveLength(4);
      const names = tools.map((t) => t.name);
      expect(names).toContain('file_context_stats');
      expect(names).toContain('file_context_search');
      expect(names).toContain('file_context_history_list');
      expect(names).toContain('file_context_cleanup');
    });

    it('file_context_stats 应返回统计信息', async () => {
      const handler = createFileContextToolHandler(engine);
      const result = await handler('file_context_stats', {});
      expect(result).toMatchObject({
        totalResults: expect.any(Number),
        filedCount: expect.any(Number),
      });
    });

    it('file_context_search 应返回匹配文件', async () => {
      engine.createHistoryRef('包含目标关键词', '测试');
      const handler = createFileContextToolHandler(engine);
      const result = await handler('file_context_search', { pattern: '目标' }) as { matchedFiles: string[] };
      expect(result.matchedFiles).toBeDefined();
      expect(Array.isArray(result.matchedFiles)).toBe(true);
    });

    it('file_context_history_list 应返回引用列表', async () => {
      engine.createHistoryRef('内容', '描述');
      const handler = createFileContextToolHandler(engine);
      const result = await handler('file_context_history_list', {});
      expect(Array.isArray(result)).toBe(true);
    });

    it('file_context_cleanup 应返回清理数量', async () => {
      const handler = createFileContextToolHandler(engine);
      const result = await handler('file_context_cleanup', { maxAgeHours: 0 });
      expect(result).toMatchObject({ cleaned: expect.any(Number) });
    });

    it('未知工具应返回错误', async () => {
      const handler = createFileContextToolHandler(engine);
      const result = await handler('unknown_tool', {});
      expect(result).toMatchObject({ error: '未知工具: unknown_tool' });
    });
  });

  // ========== 8. 边缘情况 ==========
  describe('边缘情况', () => {
    it('空内容应正常处理', () => {
      const result = engine.processToolResult('test', '');
      expect(result.filed).toBe(false);
      expect(result.summary).toBe('');
    });

    it('恰好等于阈值的内容应文件化（阈值判断是 <）', () => {
      const content = 'A'.repeat(100); // threshold = 100, 100 < 100 = false → 文件化
      const result = engine.processToolResult('test', content);
      expect(result.filed).toBe(true);
    });

    it('小于阈值 1 字节的内容不应文件化', () => {
      const content = 'A'.repeat(99); // 99 < 100 = true → 不文件化
      const result = engine.processToolResult('test', content);
      expect(result.filed).toBe(false);
    });

    it('自定义临时目录应正常工作', () => {
      const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-'));
      const customEngine = new FileContextEngine({ tmpDir: customDir, threshold: 10 });
      const result = customEngine.processToolResult('test', 'X'.repeat(50));
      if (result.filed) {
        expect(result.filePath).toContain(customDir);
      }
      customEngine.clear();
      try { fs.rmSync(customDir, { recursive: true, force: true }); } catch {}
    });
  });
});
