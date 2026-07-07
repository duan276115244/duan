/**
 * 工作区安全工具：路径校验与命令校验（P0/P1 安全修复）
 * 从 desktop/main.js 抽出 — 工厂模式，依赖 getMainWindow + rootDir
 *
 * 内部状态：tempAllowedDirs（会话级临时授权目录）、deniedDirCache（拒绝缓存）
 */

const path = require('path');
const os = require('os');

/** 敏感路径黑名单（拒绝读写） */
const SENSITIVE_PATH_PATTERNS = [
  '/.ssh/', '/id_rsa', '/id_dsa', '/id_ecdsa', '/id_ed25519',
  '/.env', '/.aws/credentials', '/.aws/config',
  'c:/windows/system32/config/', '/etc/shadow', '/etc/passwd',
  '/.gnupg/', '/.docker/config.json', '/.kube/config',
  '/appdata/microsoft/protect/',  // Windows DPAPI 主密钥
  '/appdata/microsoft/credentials/',  // Windows 凭据管理器
  '/.config/google-chrome/default/login data',
  '/.mozilla/firefox/',  // Firefox 密码库
  '/library/keychains/',  // macOS Keychain
  // P0-4 修复：扩充敏感路径黑名单
  '/.git-credentials', '/.npmrc', '/.pypirc',  // 包管理器 token
  '/.gcloud/', '/.azure/',  // 云凭证目录
  '/1password/', '/lastpass/',  // 密码管理器
  '/appdata/roaming/microsoft/credentials/',  // Windows 凭据（Roaming）
  '/etc/sudoers', '/etc/sudoers.d/',  // sudo 配置
  '/.ovpn', '/openvpn/',  // VPN 配置
  '/known_hosts',  // SSH 已知主机
  '/.netrc',  // FTP/HTTP 凭证
  '/.dockercfg',  // Docker 旧版凭证
  '/.kube/',  // Kubernetes 配置目录
  '/.terraform.d/',  // Terraform 凭证
  '/.ansible/',  // Ansible 凭证
  '/.config/github-copilot/',  // GitHub Copilot token
  '/.config/gh/',  // GitHub CLI token
  '/appdata/roaming/telegram desktop/',  // Telegram 会话
  '/.config/discord/',  // Discord token
  '/.config/slack/',  // Slack token
];

/** 危险命令黑名单正则（P0-1 修复，V17 增强 Windows 覆盖） */
const DANGEROUS_CMD_REGEX = new RegExp(
  '\\b(' +
  'rm\\s+-rf\\s+(\\/|[a-z]:[\\\\\\/])' +      // rm -rf / 或 rm -rf C:\ (根目录删除)
  '|remove-item\\s+-recurse\\s+-force\\s+[a-z]:[\\\\\\/]' +  // PowerShell 根目录删除
  '|del\\s+\\/[sfq]+\\s+[a-z]:[\\\\\\/]' +     // del /s /q C:\ (Windows 递归强删)
  '|rmdir\\s+\\/[sq]+\\s+[a-z]:[\\\\\\/]' +    // rmdir /s /q C:\ (Windows 递归删目录)
  '|format\\s+[a-z]:' +                        // 格式化磁盘
  '|mkfs' +                                    // 创建文件系统
  '|dd\\s+if=' +                               // 原始磁盘写入
  '|:\\(\\)\\s*\\{' +                          // Fork bomb
  '|fork\\s+bomb' +
  '|shutdown|reboot|halt|poweroff' +           // 系统关机/重启
  '|diskpart' +                                // 磁盘分区工具（可破坏分区表）
  '|cipher\\s+\\/w' +                          // 擦除空闲空间（可破坏数据）
  '|reg\\s+delete' +                           // 注册表删除
  '|reg\\s+add\\s+.*run' +                     // 注册表 run 键（持久化后门）
  '|reg\\s+import' +                           // 注册表导入（可注入恶意条目）
  '|schtasks\\s+\\/create' +                   // 创建计划任务
  '|net\\s+user\\s+.*\\/add' +                 // 创建用户
  '|net\\s+localgroup\\s+administrators\\s+.*\\/add' +  // 提权到管理员组
  '|sc\\s+delete' +                            // 删除服务（可禁用安全软件）
  '|takeown\\s+\\/f\\s+[a-z]:[\\\\\\/]' +      // 夺取根目录所有权
  ')\\b',
  'i'
);

function createWorkspaceSecurity({ getMainWindow, rootDir }) {
  const ROOT_DIR = rootDir;

  /** 检查路径是否为敏感路径 */
  function isSensitivePath(resolvedPath) {
    const lower = resolvedPath.toLowerCase().replace(/\\/g, '/');
    return SENSITIVE_PATH_PATTERNS.some(p => lower.includes(p));
  }

  // ===== 临时授权目录管理 =====
  // 用户通过 request_workspace_access 工具批准的目录，可在当前会话内访问
  // 解决 Agent 遇到工作区限制时无法操作桌面/下载等用户目录的问题
  const tempAllowedDirs = new Set();
  // 用户拒绝的目录缓存：{ dirPath: deniedTimestamp }，5分钟内不重复弹窗
  const deniedDirCache = new Map();
  const DENIED_DIR_COOLDOWN_MS = 5 * 60 * 1000; // 5分钟冷却
  let deniedDirCacheLastCleanup = Date.now();
  const DENIED_DIR_CLEANUP_INTERVAL = 5 * 60 * 1000; // 每5分钟清理一次过期记录

  /** 添加临时授权目录（会话级，重启后失效） */
  function addTempAllowedDir(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') return;
    const resolved = path.resolve(dirPath).toLowerCase();
    tempAllowedDirs.add(resolved);
    // 批准后清除拒绝缓存
    deniedDirCache.delete(resolved);
    console.log(`[权限] 已添加临时授权目录: ${resolved}（当前共 ${tempAllowedDirs.size} 个）`);
  }

  /** 检查路径是否在临时授权目录内 */
  function isWithinTempAllowed(resolvedPath) {
    if (tempAllowedDirs.size === 0) return false;
    const normalized = path.resolve(resolvedPath).toLowerCase();
    for (const allowedDir of tempAllowedDirs) {
      if (normalized === allowedDir || normalized.startsWith(allowedDir + path.sep) || normalized.startsWith(allowedDir + '/')) {
        return true;
      }
    }
    return false;
  }

  /**
   * 请求用户授权访问工作区外的目录（弹出 Electron 对话框，阻塞式）
   * 当 Agent 需要访问桌面、下载、文档等用户目录时调用
   * @param {string} dirPath - 请求访问的目录路径
   * @param {string} [reason] - 访问原因（由 Agent 提供）
   * @returns {Promise<{ approved: boolean, resolved?: string, reason?: string }>}
   */
  async function requestWorkspaceAccess(dirPath, reason) {
    try {
      if (!dirPath || typeof dirPath !== 'string') {
        return { approved: false, reason: '无效的目录路径' };
      }
      const { dialog } = require('electron');
      const resolved = path.resolve(dirPath);
      const resolvedLower = resolved.toLowerCase();

      // 已在临时授权列表中，直接通过
      if (isWithinTempAllowed(resolved)) {
        return { approved: true, resolved };
      }

      // 防重复弹窗：用户拒绝后5分钟内不重复弹窗，直接返回拒绝
      // 定期清理过期的拒绝记录，防止内存泄漏
      if (Date.now() - deniedDirCacheLastCleanup > DENIED_DIR_CLEANUP_INTERVAL) {
        for (const [dir, time] of deniedDirCache) {
          if (Date.now() - time > DENIED_DIR_COOLDOWN_MS) {
            deniedDirCache.delete(dir);
          }
        }
        deniedDirCacheLastCleanup = Date.now();
      }
      const deniedAt = deniedDirCache.get(resolvedLower);
      if (deniedAt) {
        const elapsed = Date.now() - deniedAt;
        if (elapsed < DENIED_DIR_COOLDOWN_MS) {
          const remainSec = Math.ceil((DENIED_DIR_COOLDOWN_MS - elapsed) / 1000);
          return { approved: false, reason: `用户此前已拒绝该目录，${remainSec}秒内不重复弹窗。请改用工作区内路径或询问用户手动提供文件。` };
        }
        // 冷却期已过，清除记录，允许再次弹窗
        deniedDirCache.delete(resolvedLower);
      }

      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { approved: false, reason: '主窗口未就绪，无法弹出确认对话框' };
      }

      const detail = [
        `请求访问的目录: ${resolved}`,
        reason ? `访问原因: ${reason}` : 'Agent 需要访问该目录以完成任务',
        '',
        '批准后，Agent 将能够在本次会话中读取和操作该目录下的文件。',
        '拒绝则 Agent 无法访问该目录，请改用工作区内路径。',
      ].join('\n');

      const result = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        title: 'Agent 请求访问目录权限',
        message: 'Agent 请求访问工作区外的目录，是否批准？',
        detail,
        buttons: ['拒绝', '批准访问'],
        defaultId: 0,
        cancelId: 0,
      });

      if (result === 1) {
        addTempAllowedDir(resolved);
        return { approved: true, resolved };
      }
      // 记录拒绝，5分钟内不重复弹窗
      deniedDirCache.set(resolvedLower, Date.now());
      return { approved: false, reason: '用户在对话框中选择了拒绝' };
    } catch (err) {
      console.error('[权限] 请求目录访问权限异常:', err.message);
      return { approved: false, reason: `对话框异常: ${err.message}` };
    }
  }

  /**
   * 校验文件操作路径是否在工作区允许范围内（P0-1 修复）
   * 允许的目录：ROOT_DIR、用户主目录下的 .duan/、临时目录，以及用户临时授权的目录
   * @param {string} resolvedPath - 已 resolve 的绝对路径
   * @returns {{ ok: boolean, error?: string }}
   */
  function isWithinWorkspace(resolvedPath) {
    if (!resolvedPath || typeof resolvedPath !== 'string') {
      return { ok: false, error: '无效的路径' };
    }
    const homeDir = os.homedir();
    const allowedRoots = [
      ROOT_DIR,
      path.join(homeDir, '.duan'),
      path.join(homeDir, '.duan', 'workspace'),
      path.join(homeDir, '.learnings'),
      path.join(homeDir, '.awareness'),
      path.join(os.tmpdir()),
    ];
    // Windows 路径不区分大小写，需转小写比较；Linux/macOS 区分大小写保持原样
    const isWin = process.platform === 'win32';
    const norm = (p) => isWin ? path.resolve(p).toLowerCase() : path.resolve(p);
    const normalized = norm(resolvedPath);
    const isAllowed = allowedRoots.some(root => {
      const normalizedRoot = norm(root);
      return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
    });
    // 检查用户临时授权的目录（桌面、下载等）
    if (!isAllowed && isWithinTempAllowed(normalized)) {
      return { ok: true };
    }
    if (!isAllowed) {
      return {
        ok: false,
        error: `安全限制: 路径 ${resolvedPath} 不在允许的工作区范围内。允许的目录: 项目根目录、~/.duan/、~/.learnings/、~/.awareness/、系统临时目录。如需访问该目录，请调用 request_workspace_access 工具向用户请求权限。`,
      };
    }
    return { ok: true };
  }

  /**
   * 校验编辑器文件操作路径（P0-2 修复）
   * @param {string} filePath - 用户提供的文件路径
   * @returns {{ ok: boolean, resolved?: string, error?: string }}
   */
  function validateEditorPath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: '无效的文件路径' };
    }
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) {
      return { ok: false, error: `安全限制: 拒绝访问敏感路径` };
    }
    return { ok: true, resolved };
  }

  /**
   * 校验终端命令安全性（P0-1 修复）
   * @param {string} command - 用户提供的命令
   * @returns {{ ok: boolean, error?: string }}
   */
  function validateTerminalCommand(command) {
    if (!command || typeof command !== 'string') {
      return { ok: false, error: '无效的命令' };
    }
    if (command.length > 10000) {
      return { ok: false, error: '命令过长（超过 10000 字符）' };
    }
    if (DANGEROUS_CMD_REGEX.test(command)) {
      return { ok: false, error: `安全拒绝: 命令包含危险操作` };
    }
    return { ok: true };
  }

  return {
    isSensitivePath,
    requestWorkspaceAccess,
    isWithinWorkspace,
    addTempAllowedDir,
    isWithinTempAllowed,
    validateEditorPath,
    validateTerminalCommand,
  };
}

module.exports = {
  SENSITIVE_PATH_PATTERNS,
  DANGEROUS_CMD_REGEX,
  createWorkspaceSecurity,
};
