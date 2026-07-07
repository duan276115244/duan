const ERROR_MAP: [RegExp, string][] = [
  [/ENOENT[^]*?no such file or directory/i, '文件或路径不存在，请检查路径是否正确'],
  [/EACCES|EPERM/i, '权限不足，无法执行此操作'],
  [/ECONNREFUSED/i, '连接被拒绝，目标服务可能未启动'],
  [/ECONNRESET/i, '连接被重置'],
  [/ETIMEDOUT|AbortError|timeout/i, '操作超时，请稍后重试'],
  [/ENOTFOUND/i, '域名解析失败，请检查网络连接'],
  [/ENOTDIR/i, '路径不存在'],
  [/EEXIST/i, '文件已存在'],
  [/EISDIR/i, '指定路径是目录，不是文件'],
  [/ENOSPC/i, '磁盘空间不足'],
  [/SyntaxError|Unexpected token/i, '语法错误'],
  [/TypeError/i, '类型错误'],
  [/ReferenceError/i, '引用了不存在的变量'],
  [/fetch failed/i, '网络请求失败，请检查网络连接'],
  [/not a git repository/i, '当前目录不是Git仓库'],
  [/Command failed/i, '命令执行失败'],
];

export function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  for (const [pattern, friendly] of ERROR_MAP) {
    if (pattern.test(msg)) return friendly;
  }
  return `操作执行出错，请检查输入参数后重试`;
}
