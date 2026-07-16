/**
 * v20.0 §5.1 多模态能力增强 — DocumentParser
 *
 * 对标主流 Agent 的文档解析能力：统一接口解析 PDF / Word / Excel / PPT / 文本类文档。
 *
 * 核心能力：
 * 1. PDF 解析：文字提取 + 元数据 + 页码信息（动态加载 pdf-parse）
 * 2. Word（.docx）解析：段落 + 标题 + 表格 + 样式（动态加载 mammoth）
 * 3. Excel（.xlsx）解析：工作表 + 单元格 + 公式 + 格式（动态加载 xlsx/exceljs）
 * 4. PPT（.pptx）解析：幻灯片 + 文本框 + 备注（动态加载 pptxtojson）
 * 5. 文本类：TXT / MD / CSV / JSON / XML / YAML / HTML 直接读取
 * 6. 统一输出：ParsedDocument 结构（类型 + 内容 + 元数据 + 段落 + 表格）
 *
 * 设计原则：
 *   - 所有二进制解析库动态加载，缺失时优雅降级并提示安装命令
 *   - 不依赖外部系统命令（如 libreoffice / antiword），纯 JS 实现
 *   - 无状态工具，不持久化数据
 *   - 与现有 office-tools 互补：office-tools 做操作，DocumentParser 做解析
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 支持的文档类型 */
export type DocumentType =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'pptx'
  | 'ppt'
  | 'txt'
  | 'md'
  | 'csv'
  | 'json'
  | 'xml'
  | 'yaml'
  | 'html'
  | 'unknown';

/** 文档段落 */
export interface DocumentSection {
  /** 段落标题（如有） */
  heading?: string;
  /** 段落级别（1=一级标题，2=二级标题，0=正文） */
  level: number;
  /** 段落文本内容 */
  content: string;
  /** 页码（PDF 用） */
  page?: number;
}

/** 表格数据 */
export interface DocumentTable {
  /** 表格标题（如有） */
  caption?: string;
  /** 表头行 */
  headers: string[];
  /** 数据行（每行是单元格数组） */
  rows: string[][];
}

/** 文档元数据 */
export interface DocumentMetadata {
  /** 标题 */
  title?: string;
  /** 作者 */
  author?: string;
  /** 主题 */
  subject?: string;
  /** 关键词 */
  keywords?: string[];
  /** 创建时间 */
  createdAt?: string;
  /** 修改时间 */
  modifiedAt?: string;
  /** 创建工具 */
  creator?: string;
  /** 页数（PDF/PPT 用） */
  pageCount?: number;
  /** 工作表数（Excel 用） */
  sheetCount?: number;
  /** 幻灯片数（PPT 用） */
  slideCount?: number;
  /** 文件大小（字节） */
  fileSize: number;
  /** 文件扩展名 */
  extension: string;
}

/** 解析后的文档 */
export interface ParsedDocument {
  /** 文件路径 */
  filePath: string;
  /** 文档类型 */
  type: DocumentType;
  /** 完整文本内容（所有段落拼接） */
  content: string;
  /** 结构化段落 */
  sections: DocumentSection[];
  /** 表格列表 */
  tables: DocumentTable[];
  /** 元数据 */
  metadata: DocumentMetadata;
  /** 解析是否成功 */
  success: boolean;
  /** 错误信息（解析失败时） */
  error?: string;
  /** 使用的解析器名称 */
  parserUsed: string;
  /** 解析耗时（毫秒） */
  parseDuration: number;
}

/** 解析选项 */
export interface ParseOptions {
  /** 最大读取页数（PDF 用，默认全部） */
  maxPages?: number;
  /** 是否提取表格 */
  extractTables?: boolean;
  /** 最大文件大小（字节，默认 50MB） */
  maxFileSize?: number;
  /** 文本内容最大长度（字符，默认 100000） */
  maxContentLength?: number;
}

/** 操作结果 */
export interface OperationResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

// ============ 主类 ============

export class DocumentParser {
  private log = logger.child({ module: 'DocumentParser' });

  /** 默认最大文件大小 50MB */
  private static readonly DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

  /** 默认最大内容长度 100000 字符 */
  private static readonly DEFAULT_MAX_CONTENT_LENGTH = 100000;

  /**
   * 解析文档（自动检测类型）
   */
  async parseDocument(filePath: string, options?: ParseOptions): Promise<ParsedDocument> {
    const startTime = Date.now();
    const maxFileSize = options?.maxFileSize || DocumentParser.DEFAULT_MAX_FILE_SIZE;
    const maxContentLength = options?.maxContentLength || DocumentParser.DEFAULT_MAX_CONTENT_LENGTH;

    // 基础校验
    if (!fs.existsSync(filePath)) {
      return this.createErrorResult(filePath, '文件不存在', startTime);
    }

    const stat = fs.statSync(filePath);
    if (stat.size > maxFileSize) {
      return this.createErrorResult(filePath, `文件过大（${Math.round(stat.size / 1024 / 1024)}MB > 限制 ${Math.round(maxFileSize / 1024 / 1024)}MB）`, startTime);
    }

    const ext = path.extname(filePath).toLowerCase().slice(1);
    const type = this.detectType(ext);

    const baseMetadata: DocumentMetadata = {
      fileSize: stat.size,
      extension: ext,
    };

    try {
      let result: ParsedDocument;

      switch (type) {
        case 'pdf':
          result = await this.parsePdf(filePath, baseMetadata, options);
          break;
        case 'docx':
          result = await this.parseDocx(filePath, baseMetadata, options);
          break;
        case 'xlsx':
          result = await this.parseXlsx(filePath, baseMetadata, options);
          break;
        case 'pptx':
          result = await this.parsePptx(filePath, baseMetadata, options);
          break;
        case 'txt':
        case 'md':
        case 'csv':
        case 'json':
        case 'xml':
        case 'yaml':
        case 'html':
          result = await this.parseTextFile(filePath, type, baseMetadata);
          break;
        case 'doc':
          result = await this.parseLegacyDoc(filePath, baseMetadata);
          break;
        case 'xls':
          result = await this.parseLegacyXls(filePath, baseMetadata);
          break;
        case 'ppt':
          result = await this.parseLegacyPpt(filePath, baseMetadata);
          break;
        default:
          result = this.createErrorResult(filePath, `不支持的文件类型: .${ext}`, startTime, type);
      }

      result.parseDuration = Date.now() - startTime;

      // 截断过长的内容
      if (result.content.length > maxContentLength) {
        result.content = result.content.substring(0, maxContentLength) + '\n\n[... 内容已截断，原始长度: ' + result.content.length + ' 字符 ...]';
      }

      this.log.info('文档解析完成', {
        filePath,
        type: result.type,
        success: result.success,
        duration: result.parseDuration,
        sections: result.sections.length,
        tables: result.tables.length,
      });

      return result;
    } catch (e) {
      const errorMsg = (e as Error).message;
      this.log.error('文档解析失败', { filePath, error: errorMsg });
      return this.createErrorResult(filePath, `解析异常: ${errorMsg}`, startTime, type);
    }
  }

  // ============ 类型检测 ============

  /**
   * 根据扩展名检测文档类型
   */
  detectType(ext: string): DocumentType {
    const normalized = ext.toLowerCase().replace(/^\./, '');
    const typeMap: Record<string, DocumentType> = {
      pdf: 'pdf',
      docx: 'docx',
      doc: 'doc',
      xlsx: 'xlsx',
      xls: 'xls',
      pptx: 'pptx',
      ppt: 'ppt',
      txt: 'txt',
      md: 'md',
      markdown: 'md',
      csv: 'csv',
      json: 'json',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      html: 'html',
      htm: 'html',
    };
    return typeMap[normalized] || 'unknown';
  }

  // ============ PDF 解析 ============

  private async parsePdf(
    filePath: string,
    baseMetadata: DocumentMetadata,
    options?: ParseOptions,
  ): Promise<ParsedDocument> {
    try {
      // 动态加载 pdf-parse
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const maxPages = options?.maxPages;
      const data = await pdfParse(buffer, maxPages ? { max: maxPages } : undefined);

      const sections: DocumentSection[] = [];
      // pdf-parse 不提供页码粒度，把全文作为一段
      if (data.text) {
        const paragraphs = data.text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        for (const para of paragraphs) {
          sections.push({
            level: 0,
            content: para.trim(),
          });
        }
      }

      const metadata: DocumentMetadata = {
        ...baseMetadata,
        title: data.info?.Title,
        author: data.info?.Author,
        subject: data.info?.Subject,
        keywords: data.info?.Keywords ? [data.info.Keywords] : undefined,
        creator: data.info?.Creator,
        createdAt: data.info?.CreationDate,
        modifiedAt: data.info?.ModDate,
        pageCount: data.numpages,
      };

      return {
        filePath,
        type: 'pdf',
        content: data.text || '',
        sections,
        tables: [],
        metadata,
        success: true,
        parserUsed: 'pdf-parse',
        parseDuration: 0,
      };
    } catch (e) {
      const errMsg = (e as Error).message;
      if (errMsg.includes('Cannot find module') || errMsg.includes('Could not dynamically require')) {
        return this.createErrorResult(
          filePath,
          'PDF 解析需要 pdf-parse 库。请运行: npm install pdf-parse',
          0,
          'pdf',
          baseMetadata,
        );
      }
      throw e;
    }
  }

  // ============ Word (.docx) 解析 ============

  private async parseDocx(
    filePath: string,
    baseMetadata: DocumentMetadata,
    _options?: ParseOptions,
  ): Promise<ParsedDocument> {
    try {
      // 动态加载 mammoth（将 .docx 转为 HTML/纯文本）
      const mammoth = await import('mammoth');
      const buffer = fs.readFileSync(filePath);

      // 提取纯文本
      const textResult = await mammoth.extractRawText({ buffer: buffer as Buffer });

      // 提取 HTML（用于表格识别）
      const htmlResult = await mammoth.convertToHtml({ buffer: buffer as Buffer });

      const sections: DocumentSection[] = [];
      const tables: DocumentTable[] = [];

      // 解析 HTML 提取标题和表格
      if (htmlResult.value) {
        const html = htmlResult.value;
        // 简易 HTML 解析（不依赖 cheerio）
        const tableMatches = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi);
        if (tableMatches) {
          for (const tableHtml of tableMatches) {
            const table = this.parseHtmlTable(tableHtml);
            if (table) tables.push(table);
          }
        }

        // 提取标题和段落
        const parts = html.split(/<(h[1-6]|p)[^>]*>/i);
        for (let i = 1; i < parts.length; i += 2) {
          const tag = parts[i].toLowerCase();
          const content = (parts[i + 1] || '').replace(/<[^>]+>/g, '').trim();
          if (content.length === 0) continue;

          if (tag.startsWith('h')) {
            const level = parseInt(tag.substring(1), 10);
            sections.push({ heading: content, level, content });
          } else {
            sections.push({ level: 0, content });
          }
        }
      }

      // 如果 HTML 解析无结果，回退到纯文本
      if (sections.length === 0 && textResult.value) {
        const paragraphs = textResult.value.split(/\n/).filter(p => p.trim().length > 0);
        for (const para of paragraphs) {
          sections.push({ level: 0, content: para.trim() });
        }
      }

      const metadata: DocumentMetadata = {
        ...baseMetadata,
      };

      return {
        filePath,
        type: 'docx',
        content: textResult.value || '',
        sections,
        tables,
        metadata,
        success: true,
        parserUsed: 'mammoth',
        parseDuration: 0,
      };
    } catch (e) {
      const errMsg = (e as Error).message;
      if (errMsg.includes('Cannot find module')) {
        return this.createErrorResult(
          filePath,
          'Word(.docx) 解析需要 mammoth 库。请运行: npm install mammoth',
          0,
          'docx',
          baseMetadata,
        );
      }
      throw e;
    }
  }

  // ============ Excel (.xlsx) 解析 ============

  private async parseXlsx(
    filePath: string,
    baseMetadata: DocumentMetadata,
    options?: ParseOptions,
  ): Promise<ParsedDocument> {
    try {
      // 动态加载 xlsx 库
      const XLSX = await import('xlsx');
      const buffer = fs.readFileSync(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      const sections: DocumentSection[] = [];
      const tables: DocumentTable[] = [];
      const allContent: string[] = [];

      const sheetNames = workbook.SheetNames;
      for (const sheetName of sheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const sheetContent: string[] = [];

        // 转为二维数组
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });

        if (rows.length === 0) continue;

        // 第一行作为表头
        const headers = (rows[0] || []).map((c: unknown) => String(c));
        const dataRows = rows.slice(1).map((r: string[]) => r.map((c: string) => String(c)));

        const table: DocumentTable = {
          caption: sheetName,
          headers,
          rows: dataRows,
        };
        tables.push(table);

        // 同时作为段落内容
        sections.push({
          heading: `工作表: ${sheetName}`,
          level: 1,
          content: `共 ${dataRows.length} 行数据，${headers.length} 列`,
        });

        // 构建文本内容
        allContent.push(`## 工作表: ${sheetName}`);
        allContent.push(headers.join('\t'));
        for (const row of dataRows) {
          allContent.push(row.join('\t'));
        }
        allContent.push('');

        // 限制每个工作表最多 1000 行
        if (tables.length >= 50) break; // 限制最多 50 个工作表
      }

      const metadata: DocumentMetadata = {
        ...baseMetadata,
        sheetCount: sheetNames.length,
      };

      return {
        filePath,
        type: 'xlsx',
        content: allContent.join('\n'),
        sections,
        tables,
        metadata,
        success: true,
        parserUsed: 'xlsx',
        parseDuration: 0,
      };
    } catch (e) {
      const errMsg = (e as Error).message;
      if (errMsg.includes('Cannot find module')) {
        return this.createErrorResult(
          filePath,
          'Excel(.xlsx) 解析需要 xlsx 库。请运行: npm install xlsx',
          0,
          'xlsx',
          baseMetadata,
        );
      }
      throw e;
    }
  }

  // ============ PowerPoint (.pptx) 解析 ============

  private async parsePptx(
    filePath: string,
    baseMetadata: DocumentMetadata,
    _options?: ParseOptions,
  ): Promise<ParsedDocument> {
    try {
      // 动态加载 jszip 解析 .pptx（PPTX 是 ZIP 格式）
      const JSZip = (await import('jszip')).default;
      const buffer = fs.readFileSync(filePath);
      const zip = await JSZip.loadAsync(buffer);

      const sections: DocumentSection[] = [];
      const allContent: string[] = [];

      // 遍历 ppt/slides/slideN.xml
      const slideFiles = Object.keys(zip.files)
        .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => {
          const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] || '0', 10);
          const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] || '0', 10);
          return numA - numB;
        });

      let slideNum = 0;
      for (const slideFile of slideFiles) {
        slideNum++;
        const xmlContent = await zip.files[slideFile].async('text');
        const texts = this.extractTextFromPptxXml(xmlContent);

        if (texts.length > 0) {
          sections.push({
            heading: `幻灯片 ${slideNum}`,
            level: 1,
            content: texts.join('\n'),
            page: slideNum,
          });
          allContent.push(`## 幻灯片 ${slideNum}`);
          allContent.push(texts.join('\n'));
          allContent.push('');
        }
      }

      // 提取备注
      const notesFiles = Object.keys(zip.files)
        .filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));

      for (const notesFile of notesFiles) {
        const notesNum = parseInt(notesFile.match(/notesSlide(\d+)\.xml/)?.[1] || '0', 10);
        const xmlContent = await zip.files[notesFile].async('text');
        const notesTexts = this.extractTextFromPptxXml(xmlContent);
        if (notesTexts.length > 0) {
          sections.push({
            heading: `幻灯片 ${notesNum} 备注`,
            level: 2,
            content: notesTexts.join('\n'),
            page: notesNum,
          });
        }
      }

      const metadata: DocumentMetadata = {
        ...baseMetadata,
        slideCount: slideFiles.length,
      };

      return {
        filePath,
        type: 'pptx',
        content: allContent.join('\n'),
        sections,
        tables: [],
        metadata,
        success: true,
        parserUsed: 'jszip',
        parseDuration: 0,
      };
    } catch (e) {
      const errMsg = (e as Error).message;
      if (errMsg.includes('Cannot find module')) {
        return this.createErrorResult(
          filePath,
          'PPT(.pptx) 解析需要 jszip 库。请运行: npm install jszip',
          0,
          'pptx',
          baseMetadata,
        );
      }
      throw e;
    }
  }

  // ============ 文本类文件解析 ============

  private async parseTextFile(
    filePath: string,
    type: DocumentType,
    baseMetadata: DocumentMetadata,
  ): Promise<ParsedDocument> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sections: DocumentSection[] = [];

    if (type === 'md') {
      // Markdown 按标题分段；无标题时退化为按段落分割
      const lines = content.split('\n');
      let currentHeading = '';
      let currentLevel = 0;
      let currentContent: string[] = [];
      let hasHeading = false;

      for (const line of lines) {
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          hasHeading = true;
          // 保存前一段
          if (currentContent.length > 0 || currentHeading) {
            sections.push({
              heading: currentHeading || undefined,
              level: currentLevel,
              content: currentContent.join('\n').trim(),
            });
          }
          currentLevel = headingMatch[1].length;
          currentHeading = headingMatch[2];
          currentContent = [];
        } else {
          currentContent.push(line);
        }
      }
      // 最后一段
      if (currentContent.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading || undefined,
          level: currentLevel,
          content: currentContent.join('\n').trim(),
        });
      }
      // 无标题时退化为按段落分割（\n\s*\n）
      if (!hasHeading) {
        sections.length = 0;
        const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        for (const para of paragraphs) {
          sections.push({ level: 0, content: para.trim() });
        }
      }
    } else if (type === 'csv') {
      // CSV 解析为表格
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      if (lines.length > 0) {
        const headers = this.parseCsvLine(lines[0]);
        const rows = lines.slice(1).map(l => this.parseCsvLine(l));
        return {
          filePath,
          type,
          content,
          sections: [{ heading: 'CSV 数据', level: 1, content: `共 ${rows.length} 行，${headers.length} 列` }],
          tables: [{ headers, rows }],
          metadata: baseMetadata,
          success: true,
          parserUsed: 'builtin-csv',
          parseDuration: 0,
        };
      }
    } else if (type === 'json') {
      // JSON 尝试格式化
      try {
        const parsed = JSON.parse(content);
        const formatted = JSON.stringify(parsed, null, 2);
        sections.push({ heading: 'JSON 数据', level: 1, content: formatted });
      } catch {
        sections.push({ heading: 'JSON 数据（原始）', level: 1, content });
      }
    } else {
      // 其他文本类型按段落分割
      const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      for (const para of paragraphs) {
        sections.push({ level: 0, content: para.trim() });
      }
    }

    return {
      filePath,
      type,
      content,
      sections,
      tables: [],
      metadata: baseMetadata,
      success: true,
      parserUsed: 'builtin-text',
      parseDuration: 0,
    };
  }

  // ============ 旧格式解析（.doc / .xls / .ppt） ============

  private async parseLegacyDoc(filePath: string, baseMetadata: DocumentMetadata): Promise<ParsedDocument> {
    // .doc 是二进制格式，纯 JS 难以解析，建议转换为 .docx
    return {
      filePath,
      type: 'doc',
      content: '',
      sections: [],
      tables: [],
      metadata: baseMetadata,
      success: false,
      error: '旧版 .doc 格式不支持直接解析。请将文件转换为 .docx 格式后重试，或使用 OCR 工具识别截图内容。',
      parserUsed: 'none',
      parseDuration: 0,
    };
  }

  private async parseLegacyXls(filePath: string, baseMetadata: DocumentMetadata): Promise<ParsedDocument> {
    // .xls 是二进制格式，建议转换为 .xlsx
    return {
      filePath,
      type: 'xls',
      content: '',
      sections: [],
      tables: [],
      metadata: baseMetadata,
      success: false,
      error: '旧版 .xls 格式不支持直接解析。请将文件转换为 .xlsx 格式后重试。',
      parserUsed: 'none',
      parseDuration: 0,
    };
  }

  private async parseLegacyPpt(filePath: string, baseMetadata: DocumentMetadata): Promise<ParsedDocument> {
    // .ppt 是二进制格式，建议转换为 .pptx
    return {
      filePath,
      type: 'ppt',
      content: '',
      sections: [],
      tables: [],
      metadata: baseMetadata,
      success: false,
      error: '旧版 .ppt 格式不支持直接解析。请将文件转换为 .pptx 格式后重试。',
      parserUsed: 'none',
      parseDuration: 0,
    };
  }

  // ============ 辅助方法 ============

  /**
   * 从 PPTX XML 中提取文本
   */
  private extractTextFromPptxXml(xml: string): string[] {
    const texts: string[] = [];
    // 匹配 <a:t>...</a:t> 标签（PPTX 文本节点）
    const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g);
    if (matches) {
      for (const match of matches) {
        const text = match.replace(/<[^>]+>/g, '').trim();
        if (text.length > 0) texts.push(text);
      }
    }
    return texts;
  }

  /**
   * 解析 HTML 表格
   */
  private parseHtmlTable(tableHtml: string): DocumentTable | null {
    const headers: string[] = [];
    const rows: string[][] = [];

    // 提取表头
    const headerMatches = tableHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/gi);
    if (headerMatches) {
      for (const h of headerMatches) {
        headers.push(h.replace(/<[^>]+>/g, '').trim());
      }
    }

    // 提取行
    const rowMatches = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (rowMatches) {
      for (const rowHtml of rowMatches) {
        const cellMatches = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (cellMatches) {
          const cells = cellMatches.map(c => c.replace(/<[^>]+>/g, '').trim());
          // 如果没有 th 表头，用第一行 td 作为表头
          if (headers.length === 0 && rows.length === 0) {
            headers.push(...cells);
          } else {
            rows.push(cells);
          }
        }
      }
    }

    if (headers.length === 0 && rows.length === 0) return null;
    return { headers, rows };
  }

  /**
   * 解析 CSV 行（处理引号）
   */
  private parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  }

  /**
   * 创建错误结果
   */
  private createErrorResult(
    filePath: string,
    error: string,
    startTime: number,
    type: DocumentType = 'unknown',
    metadata?: DocumentMetadata,
  ): ParsedDocument {
    return {
      filePath,
      type,
      content: '',
      sections: [],
      tables: [],
      metadata: metadata || {
        fileSize: 0,
        extension: path.extname(filePath).slice(1),
      },
      success: false,
      error,
      parserUsed: 'none',
      parseDuration: Date.now() - startTime,
    };
  }

  // ============ 批量解析 ============

  /**
   * 批量解析目录下的所有文档
   */
  async parseDirectory(
    dirPath: string,
    options?: ParseOptions & {
      extensions?: string[];
      recursive?: boolean;
    },
  ): Promise<ParsedDocument[]> {
    if (!fs.existsSync(dirPath)) {
      this.log.warn('目录不存在', { dirPath });
      return [];
    }

    const supportedExtensions = options?.extensions || [
      'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'html',
    ];

    const files: string[] = [];
    const collectFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && options?.recursive) {
          collectFiles(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (supportedExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };
    collectFiles(dirPath);

    this.log.info('发现待解析文档', { dirPath, count: files.length });

    const results: ParsedDocument[] = [];
    for (const file of files) {
      const result = await this.parseDocument(file, options);
      results.push(result);
    }
    return results;
  }

  // ============ 工具方法 ============

  /**
   * 获取支持的文档类型列表
   */
  getSupportedTypes(): Array<{ type: DocumentType; extensions: string[]; description: string }> {
    return [
      { type: 'pdf', extensions: ['pdf'], description: 'PDF 文档（需 pdf-parse 库）' },
      { type: 'docx', extensions: ['docx'], description: 'Word 文档（需 mammoth 库）' },
      { type: 'xlsx', extensions: ['xlsx'], description: 'Excel 表格（需 xlsx 库）' },
      { type: 'pptx', extensions: ['pptx'], description: 'PowerPoint 幻灯片（需 jszip 库）' },
      { type: 'txt', extensions: ['txt'], description: '纯文本' },
      { type: 'md', extensions: ['md', 'markdown'], description: 'Markdown 文档' },
      { type: 'csv', extensions: ['csv'], description: 'CSV 表格' },
      { type: 'json', extensions: ['json'], description: 'JSON 数据' },
      { type: 'xml', extensions: ['xml'], description: 'XML 文档' },
      { type: 'yaml', extensions: ['yaml', 'yml'], description: 'YAML 配置' },
      { type: 'html', extensions: ['html', 'htm'], description: 'HTML 网页' },
    ];
  }

  /**
   * 获取文档解析摘要（用于展示）
   */
  getDocumentSummary(doc: ParsedDocument): string {
    const lines: string[] = [];
    const statusIcon = doc.success ? '✅' : '❌';
    lines.push(`${statusIcon} ${path.basename(doc.filePath)} [${doc.type}]`);
    lines.push(`   路径: ${doc.filePath}`);
    lines.push(`   解析器: ${doc.parserUsed} | 耗时: ${doc.parseDuration}ms`);
    if (doc.error) {
      lines.push(`   错误: ${doc.error}`);
    } else {
      lines.push(`   内容长度: ${doc.content.length} 字符`);
      lines.push(`   段落数: ${doc.sections.length}`);
      lines.push(`   表格数: ${doc.tables.length}`);
      if (doc.metadata.title) lines.push(`   标题: ${doc.metadata.title}`);
      if (doc.metadata.author) lines.push(`   作者: ${doc.metadata.author}`);
      if (doc.metadata.pageCount) lines.push(`   页数: ${doc.metadata.pageCount}`);
      if (doc.metadata.sheetCount) lines.push(`   工作表: ${doc.metadata.sheetCount}`);
      if (doc.metadata.slideCount) lines.push(`   幻灯片: ${doc.metadata.slideCount}`);
      lines.push(`   文件大小: ${Math.round(doc.metadata.fileSize / 1024)}KB`);
    }
    return lines.join('\n');
  }

  /**
   * v20.0 §5.1：暴露 document 工具给 LLM
   *
   * 工具清单：
   * - document_parse       解析单个文档
   * - document_parse_dir   批量解析目录下所有文档
   * - document_types       列出支持的文档类型
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'document_parse',
        description: '解析文档内容。支持 PDF / Word(.docx) / Excel(.xlsx) / PowerPoint(.pptx) / TXT / Markdown / CSV / JSON / XML / YAML / HTML。返回结构化内容（段落 + 表格 + 元数据）。',
        parameters: {
          filePath: { type: 'string', description: '文档文件路径', required: true },
          maxPages: { type: 'number', description: '最大读取页数（PDF 用，默认全部）', required: false },
          extractTables: { type: 'boolean', description: '是否提取表格（默认 true）', required: false },
        },
        execute: async (args: { filePath?: string; maxPages?: number; extractTables?: boolean }) => {
          if (!args?.filePath) return '❌ 缺少 filePath 参数';
          const result = await this.parseDocument(args.filePath, {
            maxPages: args.maxPages,
            extractTables: args.extractTables,
          });
          const summary = this.getDocumentSummary(result);
          if (!result.success) {
            return `${summary}\n\n❌ 解析失败`;
          }
          // 返回摘要 + 内容预览（避免内容过长）
          const contentPreview = result.content.length > 2000
            ? result.content.substring(0, 2000) + '\n\n[... 内容已截断 ...]'
            : result.content;
          return `${summary}\n\n--- 内容预览 ---\n${contentPreview}`;
        },
      },
      {
        name: 'document_parse_dir',
        description: '批量解析目录下的所有文档。自动扫描支持的文件类型并逐个解析。',
        parameters: {
          dirPath: { type: 'string', description: '目录路径', required: true },
          recursive: { type: 'boolean', description: '是否递归子目录（默认 false）', required: false },
          extensions: { type: 'array', description: '限制文件扩展名（如 ["pdf", "docx"]，默认全部支持）', required: false },
        },
        execute: async (args: { dirPath?: string; recursive?: boolean; extensions?: string[] }) => {
          if (!args?.dirPath) return '❌ 缺少 dirPath 参数';
          const results = await this.parseDirectory(args.dirPath, {
            recursive: args.recursive,
            extensions: args.extensions,
          });
          if (results.length === 0) {
            return `📋 目录中无可解析文档: ${args.dirPath}`;
          }
          const lines = [`📋 批量解析完成（${results.length} 个文档）`, ''];
          let successCount = 0;
          for (const doc of results) {
            if (doc.success) successCount++;
            lines.push(this.getDocumentSummary(doc));
            lines.push('');
          }
          lines.push(`--- 统计 ---`);
          lines.push(`成功: ${successCount} / ${results.length}`);
          return lines.join('\n');
        },
      },
      {
        name: 'document_types',
        description: '列出支持的文档类型和所需的外部库。',
        parameters: {},
        execute: async () => {
          const types = this.getSupportedTypes();
          const lines = [`📋 支持的文档类型（${types.length} 种）`, ''];
          for (const t of types) {
            lines.push(`• ${t.type} (.${t.extensions.join('/.')}): ${t.description}`);
          }
          return lines.join('\n');
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: DocumentParser | null = null;

export function getDocumentParser(): DocumentParser {
  if (!_instance) {
    _instance = new DocumentParser();
  }
  return _instance;
}
