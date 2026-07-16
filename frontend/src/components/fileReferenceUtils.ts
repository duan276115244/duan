/**
 * @file 引用系统工具函数与类型定义（对标 Cursor @mention）
 *
 * 从 FileReferenceMenu.tsx 拆分出来，遵循 SlashCommandMenu/slashCommands 的分离模式：
 * 组件文件只导出组件，工具函数/类型/常量放在独立文件中，避免 react-refresh 警告。
 */

/** 文件树中的单个文件条目（不含内容） */
export interface FileEntry {
  /** 文件名（含扩展名） */
  name: string;
  /** 相对于项目根目录的路径，用 / 分隔 */
  relativePath: string;
  /** 绝对路径（用于 editor.readFile） */
  path: string;
  /** 扩展名（不含 .，已转小写） */
  ext: string;
}

/** 已选中的文件引用（含读取到的内容） */
export interface FileRef extends FileEntry {
  content: string;
}

/** 每条消息最大文件引用数 */
export const MAX_FILE_REFS = 5;
/** 单个文件内容注入上限（字符数），超出则截断 */
export const MAX_FILE_CONTENT_LENGTH = 50_000;
/** 菜单最大显示条目数 */
const MAX_MENU_ITEMS = 50;

/** 扫描时跳过的目录名 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  '.cache', 'coverage', '.vscode', '.idea', '__pycache__',
  '.turbo', '.parcel-cache', '.nuxt', '.output',
]);

/** 跳过的二进制/非文本扩展名 */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff',
  'pdf', 'zip', 'gz', 'tar', '7z', 'rar', 'exe', 'dll', 'so',
  'bin', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'mp4',
  'avi', 'mov', 'wmv', 'flv', 'webm', 'wav', 'flac', 'ogg',
  'sqlite', 'db', 'lockb', 'jar', 'war', 'class', 'pyc', 'o',
]);

/** 扩展名 → markdown 代码块语言标识 */
const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', sh: 'bash', bash: 'bash', bat: 'batch', ps1: 'powershell',
  xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte',
  dockerfile: 'dockerfile', makefile: 'makefile',
};

/** 根据扩展名获取 markdown 代码块语言标识 */
export function getLanguageFromExt(ext: string): string {
  return LANG_MAP[ext.toLowerCase()] || '';
}

/** 将 readDir 返回的递归树扁平化为文件列表，跳过忽略目录和二进制文件 */
export function flattenFileTree(tree: unknown[], basePath = ''): FileEntry[] {
  const result: FileEntry[] = [];
  if (!Array.isArray(tree)) return result;
  for (const item of tree) {
    if (!item || typeof item !== 'object') continue;
    const node = item as { name?: string; path?: string; type?: string; ext?: string; children?: unknown[] };
    if (!node.name || !node.path) continue;
    if (node.type === 'directory') {
      if (IGNORED_DIRS.has(node.name)) continue;
      const dirPath = basePath ? `${basePath}/${node.name}` : node.name;
      if (node.children && Array.isArray(node.children)) {
        result.push(...flattenFileTree(node.children, dirPath));
      }
    } else if (node.type === 'file') {
      const ext = (node.ext || '').toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      const relPath = basePath ? `${basePath}/${node.name}` : node.name;
      result.push({
        name: node.name,
        relativePath: relPath,
        path: node.path,
        ext,
      });
    }
  }
  return result;
}

/** 按查询词过滤文件列表，文件名匹配优先于路径匹配，限制返回条目数 */
export function filterFiles(files: FileEntry[], query: string): FileEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return files.slice(0, MAX_MENU_ITEMS);
  const filenameMatches: FileEntry[] = [];
  const pathMatches: FileEntry[] = [];
  for (const f of files) {
    const nameLower = f.name.toLowerCase();
    if (nameLower.includes(q)) {
      filenameMatches.push(f);
    } else if (f.relativePath.toLowerCase().includes(q)) {
      pathMatches.push(f);
    }
  }
  return [...filenameMatches, ...pathMatches].slice(0, MAX_MENU_ITEMS);
}
