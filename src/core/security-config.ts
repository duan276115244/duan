/**
 * 全局安全配置 - 项目唯一来源（Single Source of Truth）
 *
 * 集中管理所有安全相关模式：敏感路径、危险命令、敏感环境变量、敏感字段关键词。
 * 所有模块必须从此处导入，禁止在各自文件中维护独立列表（修复 M6: 6 套敏感路径列表不一致）。
 *
 * 修改安全规则时只需更新此文件，所有引用方自动生效。
 */

// ============================================================================
// 1. 敏感文件路径模式（正则）- 用于路径强拦截
// ============================================================================
/**
 * 敏感路径正则黑名单 - 匹配即拒绝访问（无例外）
 * 覆盖：SSH 密钥、云凭证、系统密码文件、Windows 系统目录、浏览器凭证等
 */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  // SSH / 密钥
  /\/\.ssh\//i,
  /\/id_rsa/i,
  /\/id_ed25519/i,
  /\/authorized_keys/i,
  // 环境 / 凭证文件
  /\/\.env($|\.)/i,
  /\/\.aws\/credentials/i,
  /\/\.npmrc/i,
  /\/\.pypirc/i,
  /\/\.docker\/config\.json/i,
  // Git 配置
  /\/\.git\/config/i,
  // Unix 系统密码文件
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
  /\/etc\/sudoers/i,
  // Windows 系统目录
  /[/\\]windows[/\\]system32[/\\]config/i,
  /[/\\]windows[/\\]repair/i,
  // 浏览器 / 应用凭证
  /[/\\]appdata[/\\]roaming[/\\]microsoft[/\\]credentials/i,
  // macOS / Linux 系统日志
  /\/private[/\\]etc[/\\]/i,
  /\/var[/\\]log[/\\]auth/i,
];

// ============================================================================
// 2. 敏感路径关键词（字符串）- 用于权限分类器的轻量级检测
// ============================================================================
/**
 * 敏感路径关键词 - 路径中包含即标记为 needs_review（需人工/LLM 审查）
 * 比 SENSITIVE_PATH_PATTERNS 更宽松，用于风险预警而非硬拦截
 */
export const SENSITIVE_PATH_KEYWORDS: readonly string[] = [
  '.env',
  'credentials',
  'password',
  'secret',
  'token',
  'key.json',
  'id_rsa',
  '.ssh/',
  'config.json',
];

// ============================================================================
// 3. 危险命令模式（正则）- 用于命令强拦截
// ============================================================================
/**
 * 危险命令正则黑名单 - 匹配即拒绝执行（无例外）
 * 覆盖：文件破坏、系统操作、用户管理、注册表、加密擦除、网络攻击、进程注入
 */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  // 文件破坏
  /rm\s+-rf\s+[/\\]/i,
  /rm\s+-rf\s+\*/i,
  /rm\s+-rf\s+~/i,
  /del\s+\/[sf]\s+\/[q]\s+[a-z]:/i,
  /rmdir\s+\/[sq]/i,
  /rd\s+\/[sq]/i,
  // 系统操作
  /format\s+[a-z]:/i,
  /shutdown/i,
  /reboot/i,
  /halt/i,
  /taskkill\s+\/[f]/i,
  /kill\s+-9/i,
  /killall/i,
  // 用户与权限
  /net\s+user/i,
  /useradd/i,
  /userdel/i,
  /passwd\s+/i,
  /chmod\s+777\s+\//i,
  /chown\s+-R/i,
  // 注册表与系统配置
  /reg\s+delete/i,
  /reg\s+add/i,
  /regedit/i,
  // 加密擦除
  /cipher\s+\/[w]/i,
  /shred\s+/i,
  /wipe\s+/i,
  // 网络攻击 / 后门
  /nc\s+-l/i,
  /netcat/i,
  /nmap\s+/i,
  // 进程注入
  /inject/i,
  /dll\s+inject/i,
  // 包管理器全局卸载
  /npm\s+uninstall\s+-g/i,
  /pip\s+uninstall/i,
  // fork bomb
  /:\(\)\s*\{\s*:\|:&\s*\};/i,
  // 设备级破坏
  /mkfs/i,
  />\s*\/dev\/sd[a-z]/i,
  // 远程脚本执行（curl/wget pipe to shell）
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  // PowerShell 编码执行（常见于绕过检测）
  /powershell.*-enc/i,
  /bash\s+-c/i,
];

// ============================================================================
// 4. 敏感环境变量前缀 - 用于沙箱环境变量过滤
// ============================================================================
/**
 * 敏感环境变量前缀 - 包含即从沙箱环境中剔除
 * 用于 cross-platform-sandbox.ts 的 buildSafeEnv()
 */
export const SENSITIVE_ENV_PREFIXES: readonly string[] = [
  'API_KEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'AUTH',
  'CREDENTIAL',
  'CERTIFICATE',
];

// ============================================================================
// 5. 敏感字段关键词 - 用于日志脱敏
// ============================================================================
/**
 * 敏感字段关键词 - 字段名包含即脱敏为 [REDACTED]
 * 用于 lifecycle-hooks.ts 的日志输出脱敏
 */
export const SENSITIVE_FIELD_KEYWORDS: readonly string[] = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'credential',
  'privatekey',
  'private_key',
  'auth',
];

// ============================================================================
// 6. 敏感资源关键词 - 用于审计风险评分
// ============================================================================
/**
 * 敏感资源关键词 - 资源名包含即增加风险评分
 * 用于 audit-logger.ts 的风险评分逻辑
 */
export const SENSITIVE_RESOURCE_KEYWORDS: readonly string[] = [
  'password',
  'secret',
  'key',
  'token',
  'credential',
  'api_key',
];

// ============================================================================
// 工具函数 - 供各模块复用
// ============================================================================

/**
 * 检测路径是否匹配敏感路径正则黑名单
 * @param inputPath 输入路径（原始或已规范化均可）
 * @returns 匹配的模式源（用于错误信息），未匹配返回 null
 */
export function matchSensitivePath(inputPath: string): RegExp | null {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const normalizedInput = inputPath.replace(/\\/g, '/').toLowerCase();
  const resolved = inputPath.replace(/\\/g, '/').toLowerCase();
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(normalizedInput) || pattern.test(resolved)) {
      return pattern;
    }
  }
  return null;
}

/**
 * 检测路径是否包含敏感关键词（轻量级，用于风险预警）
 */
export function containsSensitiveKeyword(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== 'string') return false;
  const lower = inputPath.replace(/\\/g, '/').toLowerCase();
  return SENSITIVE_PATH_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * 检测命令是否匹配危险命令正则黑名单
 * @param cmd 命令字符串
 * @returns 匹配的模式源（用于错误信息），未匹配返回 null
 */
export function matchDangerousCommand(cmd: string): RegExp | null {
  if (!cmd || typeof cmd !== 'string') return null;
  const trimmed = cmd.trim();
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return pattern;
    }
  }
  return null;
}

/**
 * 检测环境变量名是否敏感（用于沙箱环境过滤）
 */
export function isSensitiveEnvVar(varName: string): boolean {
  if (!varName) return false;
  const upper = varName.toUpperCase();
  return SENSITIVE_ENV_PREFIXES.some(prefix => upper.includes(prefix));
}

/**
 * 检测字段名是否敏感（用于日志脱敏）
 */
export function isSensitiveField(fieldName: string): boolean {
  if (!fieldName) return false;
  const lower = fieldName.toLowerCase();
  return SENSITIVE_FIELD_KEYWORDS.some(kw => lower.includes(kw));
}
