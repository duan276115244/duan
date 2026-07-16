/**
 * DocumentParser 可选依赖类型声明
 *
 * 这些库（pdf-parse / mammoth / xlsx / jszip）为可选依赖，运行时通过动态 import() 加载；
 * 未安装时 DocumentParser 会优雅降级并返回提示信息。
 * 此声明文件仅为编译期类型检查，不影响运行时行为。
 */

declare module 'pdf-parse' {
  interface PdfParseInfo {
    Title?: string;
    Author?: string;
    Subject?: string;
    Keywords?: string;
    Creator?: string;
    CreationDate?: string;
    ModDate?: string;
    [key: string]: unknown;
  }
  interface PdfParseResult {
    text: string;
    numpages?: number;
    info?: PdfParseInfo;
    metadata?: Record<string, unknown>;
  }
  interface PdfParseOptions {
    max?: number;
  }
  function pdfParse(buffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>;
  export default pdfParse;
}

declare module 'mammoth' {
  interface ExtractResult {
    value: string;
    messages?: Array<{ type: string; message: string }>;
  }
  interface ConvertResult {
    value: string;
    messages?: Array<{ type: string; message: string }>;
  }
  interface ExtractOptions {
    buffer?: Buffer;
  }
  const mammoth: {
    extractRawText(options: ExtractOptions): Promise<ExtractResult>;
    convertToHtml(options: ExtractOptions): Promise<ConvertResult>;
  };
  export = mammoth;
}

declare module 'xlsx' {
  interface WorkSheet {
    [cell: string]: unknown;
    '!ref'?: string;
  }
  interface WorkBook {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  }
  interface ReadOptions {
    type?: string;
  }
  interface SheetToJsonOptions {
    header?: 1 | string[];
    raw?: boolean;
    defval?: string;
  }
  const XLSX: {
    read(data: Buffer, options?: ReadOptions): WorkBook;
    utils: {
      sheet_to_json<T = unknown>(sheet: WorkSheet, options?: SheetToJsonOptions): T[];
    };
  };
  export = XLSX;
}

declare module 'jszip' {
  type AsyncType = 'string' | 'text' | 'arraybuffer' | 'blob' | 'uint8array' | 'base64';
  interface JSZipFile {
    async(type: 'string' | 'text'): Promise<string>;
    async(type: 'arraybuffer'): Promise<ArrayBuffer>;
    async(type: 'uint8array'): Promise<Uint8Array>;
    async(type: 'blob'): Promise<Blob>;
    async(type: AsyncType): Promise<string | ArrayBuffer | Blob | Uint8Array>;
  }
  interface JSZipObject {
    files: Record<string, JSZipFile>;
    loadAsync(data: Buffer | string): Promise<JSZipObject>;
  }
  const JSZip: JSZipObject;
  export = JSZip;
}
