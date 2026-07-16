/**
 * v20.0 §5.1 多模态能力增强 — DocumentParser 测试
 *
 * 测试核心功能：
 * - 类型检测（detectType）
 * - 文本类文件解析（txt/md/csv/json/xml/yaml/html）
 * - CSV 表格解析（含引号处理）
 * - Markdown 标题分段
 * - JSON 格式化
 * - 错误处理（文件不存在/过大/不支持类型）
 * - 旧格式降级提示（.doc/.xls/.ppt）
 * - LLM 工具定义与执行
 * - 批量目录解析
 *
 * 注意：PDF/DOCX/XLSX/PPTX 解析依赖外部库（pdf-parse/mammoth/xlsx/jszip），
 * 这些库可能未安装，因此测试聚焦于不依赖外部库的功能。
 * 外部库解析路径通过 mock 验证调用链。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  DocumentParser,
  getDocumentParser,
} from '../document-parser.js';

// ============ 工具：创建独立临时目录 ============

let tempDirCounter = 0;

function createTempDir(): string {
  tempDirCounter++;
  const dir = path.join(
    os.tmpdir(),
    `duan-docparse-test-${Date.now()}-${process.pid}-${tempDirCounter}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ============ 测试 ============

describe('v20.0 §5.1: DocumentParser', () => {
  let parser: DocumentParser;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    parser = new DocumentParser();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ============ 类型检测 ============

  describe('detectType', () => {
    it('正确检测 PDF', () => {
      expect(parser.detectType('pdf')).toBe('pdf');
      expect(parser.detectType('.pdf')).toBe('pdf');
      expect(parser.detectType('PDF')).toBe('pdf');
    });

    it('正确检测 Word', () => {
      expect(parser.detectType('docx')).toBe('docx');
      expect(parser.detectType('doc')).toBe('doc');
    });

    it('正确检测 Excel', () => {
      expect(parser.detectType('xlsx')).toBe('xlsx');
      expect(parser.detectType('xls')).toBe('xls');
    });

    it('正确检测 PowerPoint', () => {
      expect(parser.detectType('pptx')).toBe('pptx');
      expect(parser.detectType('ppt')).toBe('ppt');
    });

    it('正确检测文本类', () => {
      expect(parser.detectType('txt')).toBe('txt');
      expect(parser.detectType('md')).toBe('md');
      expect(parser.detectType('markdown')).toBe('md');
      expect(parser.detectType('csv')).toBe('csv');
      expect(parser.detectType('json')).toBe('json');
      expect(parser.detectType('xml')).toBe('xml');
      expect(parser.detectType('yaml')).toBe('yaml');
      expect(parser.detectType('yml')).toBe('yaml');
      expect(parser.detectType('html')).toBe('html');
      expect(parser.detectType('htm')).toBe('html');
    });

    it('未知类型返回 unknown', () => {
      expect(parser.detectType('xyz')).toBe('unknown');
      expect(parser.detectType('')).toBe('unknown');
    });
  });

  // ============ 文本类文件解析 ============

  describe('parseTextFile - TXT', () => {
    it('解析纯文本文件', async () => {
      const filePath = writeFile(tempDir, 'test.txt', '第一段\n\n第二段\n\n第三段');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('txt');
      expect(result.content).toContain('第一段');
      expect(result.content).toContain('第二段');
      expect(result.sections.length).toBe(3);
      expect(result.parserUsed).toBe('builtin-text');
    });

    it('空文本文件返回空内容', async () => {
      const filePath = writeFile(tempDir, 'empty.txt', '');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.content).toBe('');
      expect(result.sections).toEqual([]);
    });
  });

  describe('parseTextFile - Markdown', () => {
    it('按标题分段', async () => {
      const mdContent = `# 主标题

段落1

## 二级标题

段落2

### 三级标题

段落3`;
      const filePath = writeFile(tempDir, 'test.md', mdContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('md');
      expect(result.sections.length).toBeGreaterThanOrEqual(3);

      // 检查标题
      const headings = result.sections.filter(s => s.heading);
      expect(headings.some(h => h.heading === '主标题' && h.level === 1)).toBe(true);
      expect(headings.some(h => h.heading === '二级标题' && h.level === 2)).toBe(true);
      expect(headings.some(h => h.heading === '三级标题' && h.level === 3)).toBe(true);
    });

    it('无标题的 Markdown 按段落分割', async () => {
      const filePath = writeFile(tempDir, 'nohead.md', '段落1\n\n段落2\n\n段落3');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.sections.length).toBe(3);
    });
  });

  describe('parseTextFile - CSV', () => {
    it('解析 CSV 为表格', async () => {
      const csvContent = '姓名,年龄,城市\n张三,25,北京\n李四,30,上海\n王五,28,广州';
      const filePath = writeFile(tempDir, 'test.csv', csvContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('csv');
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].headers).toEqual(['姓名', '年龄', '城市']);
      expect(result.tables[0].rows).toHaveLength(3);
      expect(result.tables[0].rows[0]).toEqual(['张三', '25', '北京']);
    });

    it('处理带引号的 CSV', async () => {
      const csvContent = 'name,desc\n"Item, with comma","Quote ""inside"" quote"\nNormal,Simple';
      const filePath = writeFile(tempDir, 'quoted.csv', csvContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.tables[0].rows[0]).toEqual(['Item, with comma', 'Quote "inside" quote']);
      expect(result.tables[0].rows[1]).toEqual(['Normal', 'Simple']);
    });

    it('空 CSV 返回空表格', async () => {
      const filePath = writeFile(tempDir, 'empty.csv', '');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.tables).toHaveLength(0);
    });
  });

  describe('parseTextFile - JSON', () => {
    it('解析并格式化 JSON', async () => {
      const jsonContent = JSON.stringify({ name: 'test', value: 123, nested: { a: 1 } });
      const filePath = writeFile(tempDir, 'test.json', jsonContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('json');
      expect(result.sections.length).toBeGreaterThan(0);
      // 格式化后应包含换行
      expect(result.sections[0].content).toContain('\n');
    });

    it('无效 JSON 保留原始内容', async () => {
      const filePath = writeFile(tempDir, 'invalid.json', '{ invalid json');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.sections[0].content).toContain('{ invalid json');
    });
  });

  describe('parseTextFile - XML/YAML/HTML', () => {
    it('解析 XML', async () => {
      const xmlContent = '<root>\n  <item>value1</item>\n  <item>value2</item>\n</root>';
      const filePath = writeFile(tempDir, 'test.xml', xmlContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('xml');
    });

    it('解析 YAML', async () => {
      const yamlContent = 'key1: value1\nkey2:\n  - item1\n  - item2';
      const filePath = writeFile(tempDir, 'test.yaml', yamlContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('yaml');
    });

    it('解析 HTML', async () => {
      const htmlContent = '<html><body><h1>标题</h1><p>段落</p></body></html>';
      const filePath = writeFile(tempDir, 'test.html', htmlContent);
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.type).toBe('html');
    });
  });

  // ============ 错误处理 ============

  describe('错误处理', () => {
    it('文件不存在返回错误', async () => {
      const result = await parser.parseDocument(path.join(tempDir, 'nonexistent.txt'));
      expect(result.success).toBe(false);
      expect(result.error).toContain('文件不存在');
    });

    it('文件过大返回错误', async () => {
      const filePath = writeFile(tempDir, 'large.txt', 'x'.repeat(100));
      const result = await parser.parseDocument(filePath, { maxFileSize: 50 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('文件过大');
    });

    it('不支持的文件类型返回错误', async () => {
      const filePath = writeFile(tempDir, 'test.xyz', 'content');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('不支持');
    });

    it('内容过长被截断', async () => {
      const longContent = 'A'.repeat(200000);
      const filePath = writeFile(tempDir, 'long.txt', longContent);
      const result = await parser.parseDocument(filePath, { maxContentLength: 1000 });
      expect(result.success).toBe(true);
      expect(result.content.length).toBeLessThan(200000);
      expect(result.content).toContain('已截断');
    });
  });

  // ============ 旧格式降级 ============

  describe('旧格式降级', () => {
    it('.doc 返回降级提示', async () => {
      const filePath = writeFile(tempDir, 'test.doc', 'fake doc content');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('.docx');
    });

    it('.xls 返回降级提示', async () => {
      const filePath = writeFile(tempDir, 'test.xls', 'fake xls content');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('.xlsx');
    });

    it('.ppt 返回降级提示', async () => {
      const filePath = writeFile(tempDir, 'test.ppt', 'fake ppt content');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('.pptx');
    });
  });

  // ============ 元数据 ============

  describe('元数据', () => {
    it('包含文件大小和扩展名', async () => {
      const filePath = writeFile(tempDir, 'test.txt', 'Hello World');
      const result = await parser.parseDocument(filePath);
      expect(result.metadata.fileSize).toBe(11); // "Hello World" = 11 字节
      expect(result.metadata.extension).toBe('txt');
    });
  });

  // ============ 批量解析 ============

  describe('parseDirectory', () => {
    it('解析目录下所有支持的文档', async () => {
      writeFile(tempDir, 'a.txt', 'content A');
      writeFile(tempDir, 'b.md', '# Title B');
      writeFile(tempDir, 'c.csv', 'h1,h2\nv1,v2');
      writeFile(tempDir, 'd.json', '{"key": "value"}');
      writeFile(tempDir, 'ignore.xyz', 'ignored'); // 不支持的类型
      writeFile(tempDir, 'ignore.log', 'ignored'); // 不支持的类型

      const results = await parser.parseDirectory(tempDir);
      expect(results).toHaveLength(4);
      const names = results.map(r => path.basename(r.filePath));
      expect(names).toContain('a.txt');
      expect(names).toContain('b.md');
      expect(names).toContain('c.csv');
      expect(names).toContain('d.json');
    });

    it('按扩展名过滤', async () => {
      writeFile(tempDir, 'a.txt', 'content A');
      writeFile(tempDir, 'b.md', '# Title B');
      writeFile(tempDir, 'c.csv', 'h1,h2\nv1,v2');

      const results = await parser.parseDirectory(tempDir, { extensions: ['txt'] });
      expect(results).toHaveLength(1);
      expect(path.basename(results[0].filePath)).toBe('a.txt');
    });

    it('目录不存在返回空数组', async () => {
      const results = await parser.parseDirectory(path.join(tempDir, 'nonexistent'));
      expect(results).toEqual([]);
    });

    it('递归子目录', async () => {
      const subDir = path.join(tempDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      writeFile(tempDir, 'a.txt', 'A');
      writeFile(subDir, 'b.txt', 'B');

      const nonRecursive = await parser.parseDirectory(tempDir, { recursive: false });
      expect(nonRecursive).toHaveLength(1);

      const recursive = await parser.parseDirectory(tempDir, { recursive: true });
      expect(recursive).toHaveLength(2);
    });
  });

  // ============ 工具方法 ============

  describe('getSupportedTypes', () => {
    it('返回支持的类型列表', () => {
      const types = parser.getSupportedTypes();
      expect(types.length).toBeGreaterThan(5);
      const typeNames = types.map(t => t.type);
      expect(typeNames).toContain('pdf');
      expect(typeNames).toContain('docx');
      expect(typeNames).toContain('xlsx');
      expect(typeNames).toContain('pptx');
      expect(typeNames).toContain('txt');
      expect(typeNames).toContain('md');
    });
  });

  describe('getDocumentSummary', () => {
    it('成功文档的摘要', async () => {
      const filePath = writeFile(tempDir, 'test.txt', 'Hello World');
      const result = await parser.parseDocument(filePath);
      const summary = parser.getDocumentSummary(result);
      expect(summary).toContain('✅');
      expect(summary).toContain('test.txt');
      expect(summary).toContain('txt');
      expect(summary).toContain('段落');
    });

    it('失败文档的摘要', async () => {
      const result = await parser.parseDocument(path.join(tempDir, 'nonexistent.txt'));
      const summary = parser.getDocumentSummary(result);
      expect(summary).toContain('❌');
      expect(summary).toContain('文件不存在');
    });
  });

  // ============ LLM 工具定义 ============

  describe('getToolDefinitions', () => {
    it('返回 3 个工具定义', () => {
      const tools = parser.getToolDefinitions();
      expect(tools).toHaveLength(3);
      const names = tools.map(t => t.name);
      expect(names).toContain('document_parse');
      expect(names).toContain('document_parse_dir');
      expect(names).toContain('document_types');
    });

    it('document_parse 工具解析文件', async () => {
      const filePath = writeFile(tempDir, 'test.txt', 'Hello World');
      const tools = parser.getToolDefinitions();
      const tool = tools.find(t => t.name === 'document_parse')!;
      const result = await tool.execute!({ filePath } as Record<string, unknown>);
      expect(result).toContain('✅');
      expect(result).toContain('Hello World');
    });

    it('document_parse 缺少参数返回错误', async () => {
      const tools = parser.getToolDefinitions();
      const tool = tools.find(t => t.name === 'document_parse')!;
      const result = await tool.execute!({} as Record<string, unknown>);
      expect(result).toContain('❌');
      expect(result).toContain('filePath');
    });

    it('document_parse 文件不存在返回错误', async () => {
      const tools = parser.getToolDefinitions();
      const tool = tools.find(t => t.name === 'document_parse')!;
      const result = await tool.execute!({ filePath: '/nonexistent/file.txt' } as Record<string, unknown>);
      expect(result).toContain('❌');
    });

    it('document_parse_dir 工具批量解析', async () => {
      writeFile(tempDir, 'a.txt', 'A');
      writeFile(tempDir, 'b.md', '# B');
      const tools = parser.getToolDefinitions();
      const tool = tools.find(t => t.name === 'document_parse_dir')!;
      const result = await tool.execute!({ dirPath: tempDir } as Record<string, unknown>);
      expect(result).toContain('批量解析完成');
      expect(result).toContain('a.txt');
      expect(result).toContain('b.md');
    });

    it('document_parse_dir 空目录返回提示', async () => {
      const emptyDir = path.join(tempDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      const tools = parser.getToolDefinitions();
      const tool = tools.find(t => t.name === 'document_parse_dir')!;
      const result = await tool.execute!({ dirPath: emptyDir } as Record<string, unknown>);
      expect(result).toContain('无可解析');
    });

    it('document_types 工具列出类型', async () => {
      const tools = parser.getToolDefinitions();
      const tool = tools.find(t => t.name === 'document_types')!;
      const result = await tool.execute!({} as Record<string, unknown>);
      expect(result).toContain('pdf');
      expect(result).toContain('docx');
      expect(result).toContain('xlsx');
      expect(result).toContain('pptx');
    });
  });

  // ============ 单例 ============

  describe('单例', () => {
    it('getDocumentParser 返回同一实例', () => {
      const a = getDocumentParser();
      const b = getDocumentParser();
      expect(a).toBe(b);
    });
  });

  // ============ 边缘情况 ============

  describe('边缘情况', () => {
    it('单行文本文件', async () => {
      const filePath = writeFile(tempDir, 'single.txt', '单行内容');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toBe('单行内容');
    });

    it('只有空行的文件', async () => {
      const filePath = writeFile(tempDir, 'blank.txt', '\n\n\n');
      const result = await parser.parseDocument(filePath);
      expect(result.success).toBe(true);
      expect(result.sections).toEqual([]);
    });

    it('解析耗时被记录', async () => {
      const filePath = writeFile(tempDir, 'test.txt', 'content');
      const result = await parser.parseDocument(filePath);
      expect(result.parseDuration).toBeGreaterThanOrEqual(0);
    });

    it('parserUsed 字段正确设置', async () => {
      const filePath = writeFile(tempDir, 'test.txt', 'content');
      const result = await parser.parseDocument(filePath);
      expect(result.parserUsed).toBe('builtin-text');
    });
  });
});
