/**
 * @-mention 上下文引用解析器单元测试
 *
 * 验证对标 Cursor 的 @-mention 语法解析：
 * 1. parseMentions（识别各种 @-mention 类型、多个 mention、无 mention、错误格式）
 * 2. resolveMention file（正常文件、大文件截断、二进制文件、不存在文件、路径遍历）
 * 3. resolveMention symbol（找到类/函数/接口、找不到、多个匹配）
 * 4. resolveMention folder（正常目录、空目录、不存在、深度限制）
 * 5. resolveMention search（正常搜索、无结果、超过 50 限制）
 * 6. resolveMention web（mock fetch 成功、超时、HTTP 错误、内容截断）
 * 7. resolveAll（批量解析、并发限制）
 * 8. formatContext（格式化输出、空上下文、混合类型）
 * 9. processInput（端到端、无 mention 原样返回）
 * 10. 路径安全（.. 遍历攻击拒绝）
 * 11. LLM 工具定义（getToolDefinitions 返回 2 个工具）
 * 12. 工具 handler（mention_resolve / mention_search）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MentionResolver,
  getMentionToolDefinitions,
  createMentionToolHandler,
  type ParsedMention,
} from '../mention-resolver.js';

describe('@-mention 上下文引用解析器', () => {
  let resolver: MentionResolver;
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // 创建临时项目目录
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-resolver-test-'));
    // 保存原始 fetch 以便恢复
    originalFetch = globalThis.fetch;
    // 使用短超时便于测试 web 超时场景
    resolver = new MentionResolver({
      projectRoot: tmpDir,
      webTimeoutMs: 500,
      maxFileLines: 500,
      fileHead: 100,
      fileTail: 100,
      maxSearchMatches: 50,
      maxFolderDepth: 3,
      maxFolderFiles: 100,
    });
  });

  afterEach(() => {
    // 恢复 fetch
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  // 辅助：创建测试文件
  const createFile = (relPath: string, content: string | Buffer): string => {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (typeof content === 'string') {
      fs.writeFileSync(fullPath, content, 'utf-8');
    } else {
      fs.writeFileSync(fullPath, content);
    }
    return fullPath;
  };

  // 辅助：创建目录
  const createDir = (relPath: string): string => {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(fullPath, { recursive: true });
    return fullPath;
  };

  // ========== 1. parseMentions ==========
  describe('parseMentions', () => {
    it('应识别 @file 类型', () => {
      const mentions = resolver.parseMentions('请看 @file:src/index.ts 这个文件');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].type).toBe('file');
      expect(mentions[0].query).toBe('src/index.ts');
      expect(mentions[0].raw).toBe('@file:src/index.ts');
    });

    it('应识别 @symbol 类型', () => {
      const mentions = resolver.parseMentions('查找 @symbol:TaskManager 类');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].type).toBe('symbol');
      expect(mentions[0].query).toBe('TaskManager');
    });

    it('应识别 @web / @folder / @search 类型', () => {
      const text = '看 @web:https://example.com 和 @folder:src 以及 @search:foo';
      const mentions = resolver.parseMentions(text);
      expect(mentions).toHaveLength(3);
      expect(mentions[0].type).toBe('web');
      expect(mentions[1].type).toBe('folder');
      expect(mentions[2].type).toBe('search');
    });

    it('应识别一行多个 @-mention 并记录正确位置', () => {
      const text = '@file:a.ts @symbol:Foo @search:bar';
      const mentions = resolver.parseMentions(text);
      expect(mentions).toHaveLength(3);
      // @file:a.ts 长度 10（@ + file + : + a.ts = 1+4+1+4）
      expect(mentions[0].start).toBe(0);
      expect(mentions[0].end).toBe(10);
      // 空格后是第二个 mention
      expect(mentions[1].start).toBe(11);
      // 第三个 mention 在 @symbol:Foo（长度 11）+ 空格之后
      expect(mentions[2].start).toBe(23);
    });

    it('无 @-mention 时返回空数组', () => {
      expect(resolver.parseMentions('普通文本没有引用')).toEqual([]);
      expect(resolver.parseMentions('')).toEqual([]);
    });

    it('query 遇到空格或 @ 应停止', () => {
      const mentions = resolver.parseMentions('@file:a.ts @file:b.ts');
      expect(mentions).toHaveLength(2);
      expect(mentions[0].query).toBe('a.ts');
      expect(mentions[1].query).toBe('b.ts');
    });

    it('应支持多行文本中的 @-mention', () => {
      const text = '第一行 @file:a.ts\n第二行 @symbol:Bar\n第三行无引用';
      const mentions = resolver.parseMentions(text);
      expect(mentions).toHaveLength(2);
      expect(mentions[0].type).toBe('file');
      expect(mentions[1].type).toBe('symbol');
    });

    it('不支持冒号后为空的 @-mention', () => {
      // @file: 后紧跟空格，[^\s@]+ 要求至少一个非空字符
      const mentions = resolver.parseMentions('看 @file: 文件');
      expect(mentions).toHaveLength(0);
    });
  });

  // ========== 2. resolveMention: @file ==========
  describe('resolveMention @file', () => {
    const makeMention = (query: string): ParsedMention => ({
      type: 'file',
      query,
      raw: `@file:${query}`,
      start: 0,
      end: query.length + 6,
    });

    it('正常文件应注入内容（带行号）', async () => {
      createFile('hello.txt', 'line1\nline2\nline3');
      const ctx = await resolver.resolveMention(makeMention('hello.txt'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('1: line1');
      expect(ctx.content).toContain('2: line2');
      expect(ctx.content).toContain('3: line3');
      expect(ctx.metadata?.lineCount).toBe(3);
      expect(ctx.metadata?.filePath).toBe('hello.txt');
    });

    it('大文件超过 500 行应截断（前 100 + 后 100 + 省略提示）', async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`);
      createFile('big.txt', lines.join('\n'));
      const ctx = await resolver.resolveMention(makeMention('big.txt'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.metadata?.lineCount).toBe(600);
      // 应包含前 100 行和后 100 行
      expect(ctx.content).toContain('1: line-1');
      expect(ctx.content).toContain('100: line-100');
      expect(ctx.content).toContain('600: line-600');
      expect(ctx.content).toContain('501: line-501');
      // 应包含省略提示
      expect(ctx.content).toContain('已省略');
      // 不应包含中间行
      expect(ctx.content).not.toContain('line-200');
    });

    it('二进制文件应返回二进制提示', async () => {
      // 包含 \0 字节的 buffer
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
      createFile('image.png', binaryContent);
      const ctx = await resolver.resolveMention(makeMention('image.png'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('二进制文件');
      expect(ctx.content).toContain('bytes');
      expect(ctx.metadata?.fileSize).toBe(7);
    });

    it('不存在的文件应返回错误', async () => {
      const ctx = await resolver.resolveMention(makeMention('nonexistent.txt'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('不存在');
    });

    it('路径遍历攻击 (..) 应被拒绝', async () => {
      const ctx = await resolver.resolveMention(makeMention('../../../etc/passwd'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('路径遍历');
    });
  });

  // ========== 3. resolveMention: @symbol ==========
  describe('resolveMention @symbol', () => {
    const makeMention = (query: string): ParsedMention => ({
      type: 'symbol',
      query,
      raw: `@symbol:${query}`,
      start: 0,
      end: query.length + 8,
    });

    it('应找到 class 定义', async () => {
      createFile('src/foo.ts', [
        'export class TaskManager {',
        '  private tasks: string[] = [];',
        '  add(task: string) { this.tasks.push(task); }',
        '}',
      ].join('\n'));
      const ctx = await resolver.resolveMention(makeMention('TaskManager'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('TaskManager');
      expect(ctx.metadata?.filePath).toBe(path.join('src', 'foo.ts'));
    });

    it('应找到 function 定义', async () => {
      createFile('src/utils.ts', [
        'export function atomicWriteJsonSync(path: string, data: unknown) {',
        '  fs.writeFileSync(path, JSON.stringify(data));',
        '}',
      ].join('\n'));
      const ctx = await resolver.resolveMention(makeMention('atomicWriteJsonSync'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('atomicWriteJsonSync');
    });

    it('应找到 interface 定义', async () => {
      createFile('src/types.ts', [
        'export interface UserInfo {',
        '  name: string;',
        '  age: number;',
        '}',
      ].join('\n'));
      const ctx = await resolver.resolveMention(makeMention('UserInfo'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('interface UserInfo');
    });

    it('找不到符号应返回错误', async () => {
      createFile('src/empty.ts', '// no symbols');
      const ctx = await resolver.resolveMention(makeMention('NonExistentSymbol'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('未找到');
    });

    it('多个匹配应全部展示', async () => {
      createFile('src/a.ts', 'export class Helper { }\n');
      createFile('src/b.ts', 'export class Helper { helperMethod() {} }\n');
      const ctx = await resolver.resolveMention(makeMention('Helper'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.metadata?.matchCount).toBe(2);
      // 使用 path.sep 兼容 Windows/Unix 路径分隔符
      expect(ctx.content).toContain(path.join('src', 'a.ts'));
      expect(ctx.content).toContain(path.join('src', 'b.ts'));
    });
  });

  // ========== 4. resolveMention: @folder ==========
  describe('resolveMention @folder', () => {
    const makeMention = (query: string): ParsedMention => ({
      type: 'folder',
      query,
      raw: `@folder:${query}`,
      start: 0,
      end: query.length + 8,
    });

    it('正常目录应列出树形结构（带文件大小）', async () => {
      createFile('project/a.ts', 'content1');
      createFile('project/b.ts', 'content2');
      createDir('project/sub');
      createFile('project/sub/c.ts', 'content3');
      const ctx = await resolver.resolveMention(makeMention('project'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('a.ts');
      expect(ctx.content).toContain('b.ts');
      expect(ctx.content).toContain('sub/');
      expect(ctx.content).toContain('c.ts');
      // 应包含文件大小
      expect(ctx.content).toMatch(/\(\d+B\)/);
    });

    it('空目录应正常处理', async () => {
      createDir('empty-dir');
      const ctx = await resolver.resolveMention(makeMention('empty-dir'));
      expect(ctx.resolved).toBe(true);
      // 空目录的内容应为空字符串或仅含空白
      expect(ctx.content.trim()).toBe('');
    });

    it('不存在的目录应返回错误', async () => {
      const ctx = await resolver.resolveMention(makeMention('nonexistent-dir'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('不存在');
    });

    it('深度限制应生效（最多 3 层）', async () => {
      // 创建 4 层深的目录结构
      createFile('root/level1/level2/level3/level4/deep.txt', 'deep');
      createFile('root/level1/file1.txt', 'l1');
      createFile('root/level1/level2/file2.txt', 'l2');
      const ctx = await resolver.resolveMention(makeMention('root'));
      expect(ctx.resolved).toBe(true);
      // level3 应可见（depth=3 仍允许）
      expect(ctx.content).toContain('level3');
      // level4 目录在 depth=4，超出限制不应深入列出其内容
      expect(ctx.content).not.toContain('deep.txt');
    });
  });

  // ========== 5. resolveMention: @search ==========
  describe('resolveMention @search', () => {
    const makeMention = (query: string): ParsedMention => ({
      type: 'search',
      query,
      raw: `@search:${query}`,
      start: 0,
      end: query.length + 8,
    });

    it('正常搜索应返回匹配行', async () => {
      createFile('src/code.ts', 'const foo = atomicWriteJsonSync;\n');
      createFile('src/util.ts', 'function atomicWriteJsonSync() {}\n');
      const ctx = await resolver.resolveMention(makeMention('atomicWriteJsonSync'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.metadata?.matchCount).toBeGreaterThanOrEqual(2);
      expect(ctx.content).toContain('atomicWriteJsonSync');
      // 应包含 file:line:content 格式
      expect(ctx.content).toMatch(/:\d+:/);
    });

    it('无结果应返回无匹配提示', async () => {
      createFile('src/empty.ts', '// nothing here');
      const ctx = await resolver.resolveMention(makeMention('zzz_no_match_zzz'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.content).toContain('无匹配');
      expect(ctx.metadata?.matchCount).toBe(0);
    });

    it('超过 50 个匹配应被限制', async () => {
      // 创建 60 个文件，每个含一个匹配
      for (let i = 0; i < 60; i++) {
        createFile(`src/match${i}.ts`, `const target = "FINDME_${i}";\n`);
      }
      const ctx = await resolver.resolveMention(makeMention('FINDME_'));
      expect(ctx.resolved).toBe(true);
      expect(ctx.metadata?.matchCount).toBe(50);
    });
  });

  // ========== 6. resolveMention: @web ==========
  describe('resolveMention @web', () => {
    const makeMention = (query: string): ParsedMention => ({
      type: 'web',
      query,
      raw: `@web:${query}`,
      start: 0,
      end: query.length + 5,
    });

    it('mock fetch 成功应返回提取的文本', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          '<html><body><script>alert(1)</script><style>.x{}</style><h1>标题</h1><p>正文内容</p></body></html>',
      }) as unknown as typeof globalThis.fetch;

      const ctx = await resolver.resolveMention(makeMention('https://example.com'));
      expect(ctx.resolved).toBe(true);
      // 应去除 script/style/标签
      expect(ctx.content).toContain('标题');
      expect(ctx.content).toContain('正文内容');
      expect(ctx.content).not.toContain('alert');
      expect(ctx.content).not.toContain('<h1>');
      expect(ctx.content).not.toContain('.x{}');
    });

    it('超时应返回超时错误', async () => {
      // mock fetch 永不 resolve，触发 AbortController 超时
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          // 监听 abort 信号
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }) as unknown as typeof globalThis.fetch;

      const ctx = await resolver.resolveMention(makeMention('https://slow.example.com'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('超时');
    });

    it('HTTP 错误应返回错误状态码', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
      }) as unknown as typeof globalThis.fetch;

      const ctx = await resolver.resolveMention(makeMention('https://example.com/missing'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('404');
    });

    it('内容超过 5000 字符应截断', async () => {
      const longText = 'A'.repeat(8000);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => `<p>${longText}</p>`,
      }) as unknown as typeof globalThis.fetch;

      const ctx = await resolver.resolveMention(makeMention('https://example.com/long'));
      expect(ctx.resolved).toBe(true);
      // maxWebLength 默认 5000
      expect(ctx.content.length).toBeLessThanOrEqual(5000);
    });

    it('网络异常应返回错误不崩溃', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network connection refused')) as unknown as typeof globalThis.fetch;

      const ctx = await resolver.resolveMention(makeMention('https://unreachable.example.com'));
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('Network connection refused');
    });
  });

  // ========== 7. resolveAll ==========
  describe('resolveAll', () => {
    it('应批量解析文本中所有 @-mention', async () => {
      createFile('a.txt', 'content A');
      createFile('b.txt', 'content B');
      const contexts = await resolver.resolveAll('看 @file:a.ts 和 @file:b.ts 以及 @search:foo');
      // a.ts 和 b.ts 不存在（扩展名是 .ts 不是 .txt），但 search 会执行
      expect(contexts).toHaveLength(3);
      expect(contexts[0].type).toBe('file');
      expect(contexts[1].type).toBe('file');
      expect(contexts[2].type).toBe('search');
    });

    it('无 @-mention 时返回空数组', async () => {
      const contexts = await resolver.resolveAll('普通文本没有引用');
      expect(contexts).toEqual([]);
    });

    it('并发限制应生效（最多 5 个一批）', async () => {
      // 创建 8 个文件引用，验证全部被解析
      for (let i = 0; i < 8; i++) {
        createFile(`f${i}.ts`, `file ${i}`);
      }
      const text = Array.from({ length: 8 }, (_, i) => `@file:f${i}.ts`).join(' ');
      const contexts = await resolver.resolveAll(text);
      expect(contexts).toHaveLength(8);
      // 所有都应成功解析
      for (const ctx of contexts) {
        expect(ctx.resolved).toBe(true);
      }
    });
  });

  // ========== 8. formatContext ==========
  describe('formatContext', () => {
    it('应格式化解析成功的上下文', () => {
      const contexts = [
        {
          type: 'file' as const,
          query: 'a.ts',
          resolved: true,
          content: '1: hello',
          metadata: { lineCount: 1, fileSize: 10 },
        },
      ];
      const formatted = resolver.formatContext(contexts);
      expect(formatted).toContain('@-mention 上下文');
      expect(formatted).toContain('@file:a.ts');
      expect(formatted).toContain('1: hello');
      expect(formatted).toContain('行数: 1');
    });

    it('空上下文应返回空字符串', () => {
      expect(resolver.formatContext([])).toBe('');
    });

    it('混合类型（成功+失败）应分别格式化', () => {
      const contexts = [
        {
          type: 'file' as const,
          query: 'ok.ts',
          resolved: true,
          content: '1: ok',
          metadata: { matchCount: 1 },
        },
        {
          type: 'web' as const,
          query: 'https://bad.example.com',
          resolved: false,
          content: '',
          error: '请求失败',
        },
      ];
      const formatted = resolver.formatContext(contexts);
      expect(formatted).toContain('@file:ok.ts');
      expect(formatted).toContain('1: ok');
      expect(formatted).toContain('@web:https://bad.example.com');
      expect(formatted).toContain('[解析失败]');
      expect(formatted).toContain('请求失败');
    });
  });

  // ========== 9. processInput ==========
  describe('processInput', () => {
    it('端到端：解析 + 注入上下文', async () => {
      createFile('hello.ts', 'console.log("hi");\n');
      const result = await resolver.processInput('请看 @file:hello.ts 这个文件');
      expect(result.input).toBe('请看 @file:hello.ts 这个文件');
      expect(result.contexts).toHaveLength(1);
      expect(result.contexts[0].resolved).toBe(true);
      expect(result.context).toContain('console.log');
      expect(result.context).toContain('@-mention 上下文');
    });

    it('无 @-mention 应原样返回输入，context 为空', async () => {
      const result = await resolver.processInput('普通文本');
      expect(result.input).toBe('普通文本');
      expect(result.contexts).toEqual([]);
      expect(result.context).toBe('');
    });
  });

  // ========== 10. 路径安全 ==========
  describe('路径安全', () => {
    it('.. 遍历攻击应被拒绝', async () => {
      const mention: ParsedMention = {
        type: 'file',
        query: '../../etc/passwd',
        raw: '@file:../../etc/passwd',
        start: 0,
        end: 20,
      };
      const ctx = await resolver.resolveMention(mention);
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('路径遍历');
    });

    it('绝对路径在 projectRoot 外应被拒绝', async () => {
      const mention: ParsedMention = {
        type: 'file',
        query: path.join(os.tmpdir(), 'outside-project.txt'),
        raw: '@file:' + path.join(os.tmpdir(), 'outside-project.txt'),
        start: 0,
        end: 50,
      };
      const ctx = await resolver.resolveMention(mention);
      expect(ctx.resolved).toBe(false);
      expect(ctx.error).toContain('路径遍历');
    });

    it('projectRoot 内的合法路径应允许', async () => {
      createFile('inside.txt', 'ok');
      const mention: ParsedMention = {
        type: 'file',
        query: 'inside.txt',
        raw: '@file:inside.txt',
        start: 0,
        end: 16,
      };
      const ctx = await resolver.resolveMention(mention);
      expect(ctx.resolved).toBe(true);
    });
  });

  // ========== 11. LLM 工具定义 ==========
  describe('LLM 工具定义', () => {
    it('getToolDefinitions() 应返回 2 个工具', () => {
      const tools = resolver.getToolDefinitions();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain('mention_resolve');
      expect(names).toContain('mention_search');
    });

    it('mention_resolve 应有 text 必填参数', () => {
      const tools = getMentionToolDefinitions();
      const resolveTool = tools.find((t) => t.name === 'mention_resolve');
      expect(resolveTool).toBeDefined();
      expect(resolveTool!.parameters.text.required).toBe(true);
      expect(resolveTool!.readOnly).toBe(true);
    });

    it('mention_search 应有 query 必填参数和 type 可选参数', () => {
      const tools = getMentionToolDefinitions();
      const searchTool = tools.find((t) => t.name === 'mention_search');
      expect(searchTool).toBeDefined();
      expect(searchTool!.parameters.query.required).toBe(true);
      expect(searchTool!.parameters.type.required).toBe(false);
    });

    it('getMentionToolDefinitions() 独立函数应返回相同定义', () => {
      const standalone = getMentionToolDefinitions();
      const method = resolver.getToolDefinitions();
      expect(standalone).toHaveLength(method.length);
      expect(standalone.map((t) => t.name)).toEqual(method.map((t) => t.name));
    });
  });

  // ========== 12. 工具 handler ==========
  describe('工具 handler', () => {
    it('mention_resolve 应解析 @-mention 并返回上下文', async () => {
      createFile('test.ts', 'const x = 1;\n');
      const handler = createMentionToolHandler(resolver);
      const result = (await handler('mention_resolve', {
        text: '看 @file:test.ts',
      })) as { contexts: unknown[]; formattedContext: string };
      expect(result.contexts).toHaveLength(1);
      expect(result.formattedContext).toContain('const x = 1');
    });

    it('mention_search (type=search) 应返回匹配列表', async () => {
      createFile('src/code.ts', 'const findme = 42;\n');
      const handler = createMentionToolHandler(resolver);
      const result = (await handler('mention_search', {
        query: 'findme',
        type: 'search',
      })) as { matches: { file: string; line: number; content: string }[]; count: number };
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.matches[0].file).toContain('code.ts');
      expect(result.matches[0].content).toContain('findme');
    });

    it('mention_search (type=symbol) 应返回符号定义', async () => {
      createFile('src/sym.ts', 'export class MySymbol { }\n');
      const handler = createMentionToolHandler(resolver);
      const result = (await handler('mention_search', {
        query: 'MySymbol',
        type: 'symbol',
      })) as { matches: { file: string; line: number; content: string }[]; count: number };
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.matches[0].content).toContain('MySymbol');
    });

    it('mention_search 缺少 query 应返回错误', async () => {
      const handler = createMentionToolHandler(resolver);
      const result = (await handler('mention_search', {})) as { error: string };
      expect(result.error).toContain('query');
    });

    it('未知工具应返回错误', async () => {
      const handler = createMentionToolHandler(resolver);
      const result = (await handler('unknown_tool', {})) as { error: string };
      expect(result.error).toContain('未知工具');
    });
  });
});
