/**
 * 安装包构建脚本 — make-package.cjs
 *
 * v20.0 明文源码模式：核心源码直接以明文形式打包，无需 _decrypt.cjs 解密步骤。
 * 安装包含：
 *   - 完整 src/ 源码（明文 .ts）
 *   - install.bat（一键安装依赖）
 *   - duan.bat（一键启动控制台）
 *   - duan-web.bat（一键启动 Web 控制台）
 *   - README-INSTALL.txt（安装指南）
 *
 * 排除：
 *   - node_modules / .git / dist 等大目录
 *   - 优化升级方案/自我介绍/追踪文件等文档
 *   - 临时调试脚本
 *   - Windows 保留名文件
 *   - 加密备份文件 (.ts.enc / .js.enc)
 *   - .env / config.json 等敏感配置
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_DIR = path.join(ROOT, 'duan-installer');

// ===== 目录排除列表 =====
const EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.duan',
  '.sessions',
  '.trae',
  '.awareness',
  '.workspace',
  'backup',
  'logs',
  'data',
  'dist',
  'dist-electron',
  'frontend-dist',
  'duan-release',
  'duan-installer',
  'release',
  'coverage',
  'output',
  'screenshots',
  'workflows',
  '__pycache__',
  '.cache',
  'tmp',
];

// ===== 文件排除模式（文件名匹配）=====
const EXCLUDE_FILE_NAMES = [
  // Windows 保留名
  'nul', 'con', 'prn', 'aux',
  'com1', 'com2', 'com3', 'com4',
  'lpt1', 'lpt2', 'lpt3',

  // 日志文件
  '.log',

  // 调试脚本与多余启动脚本
  'check-tsc.js', 'check-tsc.mjs', 'check-tsc2.mjs', 'check-tsc.ps1',
  'duan.ps1', 'duan.cmd',
  'parse-errors.ps1', 'start-web.js',
  'DUMMY',

  // 临时文件与测试数据
  'test-write.txt',
  'test_out.json', 'test_output.json',

  // 配置文件（本地）
  'config.json', '.env', '.env.local',

  // 项目图片（仅保留一张 Logo）
  'screenshot.png', 'screenshot_1782823700614.png',

  // 分发压缩包
  '.zip', '.7z', '.rar', '.tar',

  // 加密备份
  '.enc.bak', '.zip.bak',

  // 临时修复脚本
  'fix_any.mjs',
  'fix-any-batch1.cjs', 'fix-any-browserpanel.cjs', 'fix-any-chatarea.cjs', 'fix-any-useapi.cjs',
  '_fix_worktree.js',

  // 开发者专用脚本
  'encrypt-core.cjs', 'backup-source.cjs', 'publish-github.cjs',
  'find-dead-code.mjs', 'capability-check.mjs',
  '_cleanup_git.cjs',

  // 解密脚本（明文模式不需要）
  '_decrypt.cjs',
];

// ===== 按扩展名排除 =====
const EXCLUDE_EXTENSIONS = new Set([
  '.log', '.bak', '.tmp',
  '.exe', '.msi', '.msix',
  '.dmg', '.pkg', '.rpm', '.deb',
  '.nsis', '.asar',
  '.7z', '.rar', '.tar',
  '.enc', // 加密文件
]);

// ===== 按文件名模式（通配符）排除 =====
const EXCLUDE_PATTERNS = [
  // 中文文档
  '优化', '升级', '方案', '报告', '手册', '段先生',
  // 英文文档
  'ARCHITECTURE', 'COMPETITOR', 'COMPREHENSIVE', 'DECRYPTION',
  'FINAL_OPTIMIZATION', 'FIX_', 'TASK_STATUS', 'V15',
  'WEEKLY_TRACKING', 'agent_learning', 'agent_quick',
  'agent_skills_full', 'CHANGELOG',
  // 测试相关
  'test-task', 'test_',
  // vite/tsc/eslint 日志
  'tsc-step', 'eslint-step', 'vitest-', 'vitest_',
  // 服务器调试日志
  'server-new', 'server-v', 'test-server',
  // electron 调试日志
  'electron-test', 'desktop-main-',
  // 加密备份文件
  '.ts.enc', '.js.enc',
  // 开发者发布脚本
  'encrypt-core', 'backup-source', 'publish-github',
  'find-dead-code', 'capability-check',
  // 临时文件
  '.ts.tmp', '.ts.bak',
];

function shouldExcludeDir(dirName) {
  if (EXCLUDE_DIRS.includes(dirName)) return true;
  // 排除隐藏目录 (.xxx) 但允许保留必要的
  if (dirName.startsWith('.') && dirName !== '.setup-done') return true;
  return false;
}

function shouldExcludeFile(fileName) {
  const lowerName = fileName.toLowerCase();
  // 精确匹配
  if (EXCLUDE_FILE_NAMES.includes(fileName)) return true;
  if (EXCLUDE_FILE_NAMES.includes(lowerName)) return true;

  // 扩展名检查
  const ext = path.extname(fileName).toLowerCase();
  if (EXCLUDE_EXTENSIONS.has(ext)) return true;

  // 模式匹配
  for (const p of EXCLUDE_PATTERNS) {
    if (lowerName.includes(p.toLowerCase())) return true;
  }

  // 以 . 开头的隐藏文件（保留 .gitignore 和 .env.example）
  if (fileName.startsWith('.') &&
      fileName !== '.gitignore' &&
      fileName !== '.env.example' &&
      fileName !== '.setup-done') {
    return true;
  }

  return false;
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (shouldExcludeDir(entry.name)) continue;
      copyDir(srcPath, destPath);
    } else {
      if (shouldExcludeFile(entry.name)) continue;
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch (e) {
        // 复制失败继续下一个
      }
    }
  }
}

// 为安装包写入 package.json（明文模式，无 _decrypt.cjs 调用）
function writePackageJson(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 安装包的 scripts 不需要 _decrypt.cjs
  pkg.scripts = {
    'duan': 'tsx src/entry.ts',
    'duan:install': 'npm install',
    'duan:web': 'tsx src/web-server.ts',
    'duan:web-ui': 'npx serve web',
    'duan:full': 'concurrently "npm run duan:web" "npm run duan:web-ui"',
    'duan:desktop': 'electron .',
    'duan:start': 'node dist/entry.js',
    'duan:build': 'node scripts/build.cjs',
    'dev': 'npm run duan',
    'dev:web-server': 'npm run duan:web',
    'dev:web': 'npm run duan:web-ui',
    'dev:full': 'npm run duan:full',
    'dev:desktop': 'npm run duan:desktop',
    'start': 'npm run duan:start',
    'build': 'npm run duan:build',
    'build:frontend': 'cd frontend && npm run build',
    'build:all': 'npm run build && npm run build:frontend',
    'typecheck': 'tsc --noEmit --skipLibCheck',
    'lint': 'eslint src/ desktop/ --max-warnings 100',
    'lint:fix': 'eslint src/ desktop/ --fix',
    'test': 'vitest run',
    'test:watch': 'vitest',
    'test:coverage': 'vitest run --coverage',
    'verify:all': 'npm run typecheck && npm run lint && npm run test',
    'postinstall': 'echo Installation complete! Run npm run duan to start Duan Agent',
    'prepublishOnly': 'npm run build',
    'build:exe': 'npm run build:all && electron-builder --win',
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

// 为安装包写入 install.bat（明文模式）
function writeInstallBat(dir) {
  const content = [
    '@echo off',
    'title Duan Agent v20 - Installation',
    'setlocal enabledelayedexpansion',
    '',
    'echo.',
    'echo ========================================',
    'echo    Duan Agent v20 - Installation',
    'echo ========================================',
    'echo.',
    '',
    'rem === 1. Check Node.js ===',
    'where node >nul 2>nul',
    'if %errorlevel% neq 0 (',
    '    echo [ERROR] Node.js is not detected',
    '    echo.',
    '    echo Please install Node.js v18 or higher',
    '    echo Download: https://nodejs.org/',
    '    echo.',
    '    echo Run this installer again after Node.js is installed',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    '',
    'for /f "tokens=2 delims=v " %%i in (\'node -v\') do set NODE_VER=%%i',
    'echo [1/2] Node.js detected: v!NODE_VER!',
    '',
    'rem === 2. Install dependencies ===',
    'echo.',
    'echo [2/2] Installing dependencies (First run may take 2-5 minutes)...',
    'echo.',
    'call npm install',
    'if %errorlevel% neq 0 (',
    '    echo.',
    '    echo [ERROR] Dependency installation failed',
    '    echo.',
    '    echo Please check your network connection, or try:',
    '    echo   npm config set registry https://registry.npmmirror.com',
    '    echo   Then run install.bat again',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    '',
    'echo.',
    'echo ========================================',
    'echo    Installation Complete!',
    'echo ========================================',
    'echo.',
    'echo To start the agent:',
    'echo   Double-click duan.bat          - Console mode',
    'echo   Double-click duan-web.bat      - Web console mode',
    'echo   Or run:  npm run duan          - Console mode',
    'echo   Or run:  npm run duan:web      - Web console',
    'echo   Or run:  npm run duan:desktop  - Desktop app',
    'echo.',
    'echo First launch will prompt for API Key setup',
    'echo.',
    'pause',
    'endlocal',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'install.bat'), content);
}

// 为安装包写入 duan.bat（明文模式）
function writeDuanBat(dir) {
  const content = [
    '@echo off',
    'title Duan Agent v20',
    'setlocal',
    '',
    'echo.',
    'echo ========================================',
    'echo    Duan Agent v20 - Super AI Assistant',
    'echo    Starting...',
    'echo ========================================',
    'echo.',
    '',
    'echo.',
    'echo Start time: %date% %time%',
    'echo Tip: Press Ctrl+C to exit',
    'echo.',
    '',
    'call npx tsx src/entry.ts %*',
    '',
    'if %errorlevel% neq 0 (',
    '    echo.',
    '    echo [INFO] Program exited. If you see errors, make sure install.bat was completed first',
    '    echo.',
    '    pause',
    ')',
    '',
    'endlocal',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'duan.bat'), content);
}

// 为安装包写入 duan-web.bat（明文模式）
function writeDuanWebBat(dir) {
  const content = [
    '@echo off',
    'title Duan Agent v20 - Web Console',
    'setlocal',
    '',
    'echo.',
    'echo ========================================',
    'echo    Duan Agent v20 - Web Console',
    'echo ========================================',
    'echo.',
    'echo Starting web service...',
    'echo.',
    '',
    'call npx tsx src/web-server.ts',
    '',
    'echo.',
    'echo Service stopped',
    'pause',
    'endlocal',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'duan-web.bat'), content);
}

function main() {
  console.log('========================================');
  console.log('  Duan Agent v20 - Distribution Package Builder');
  console.log('  Mode: Plaintext source (no decryption needed)');
  console.log('========================================');
  console.log();

  // 1. 清理旧打包目录
  if (fs.existsSync(PACKAGE_DIR)) {
    console.log('[1/5] Cleaning old package directory...');
    try {
      fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
    } catch (e) {
      console.log('  WARN: Could not fully clean, continuing...');
    }
  }

  // 2. 复制源码（排除开发文档、日志、Windows 保留名、加密文件）
  console.log('[2/5] Copying project source (plaintext mode)...');
  copyDir(ROOT, PACKAGE_DIR);

  // 3. 为安装包写入自定义脚本和 package.json（明文模式，无 _decrypt.cjs）
  console.log('[3/5] Writing installer scripts (plaintext mode)...');
  writePackageJson(PACKAGE_DIR);
  writeInstallBat(PACKAGE_DIR);
  writeDuanBat(PACKAGE_DIR);
  writeDuanWebBat(PACKAGE_DIR);
  console.log('  OK  install.bat, duan.bat, duan-web.bat, package.json created');

  // 4. 验证关键文件
  console.log('[4/5] Verifying required files...');
  const required = [
    'install.bat', 'duan.bat', 'duan-web.bat',
    'package.json', 'README.md', 'tsconfig.json',
    'src/entry.ts', 'src/core/bootstrap.ts',
  ];
  let allOk = true;
  for (const f of required) {
    if (fs.existsSync(path.join(PACKAGE_DIR, f))) {
      console.log('  OK  ' + f);
    } else {
      console.log('  WARN ' + f + ' (not found)');
      allOk = false;
    }
  }

  // 5. 创建安装说明
  console.log('[5/5] Creating installation guide...');
  const guide = path.join(PACKAGE_DIR, 'README-INSTALL.txt');
  fs.writeFileSync(guide, [
    '========================================',
    '  Duan Agent v20 - Installation Guide',
    '========================================',
    '',
    'System Requirements:',
    '  - Windows 10 / 11 (or Linux: UOS / Kylin)',
    '  - Node.js 18 or higher (https://nodejs.org/)',
    '  - At least 2GB RAM',
    '',
    'Installation Steps:',
    '',
    '  1. Double-click install.bat -> Install dependencies (run once)',
    '  2. Double-click duan.bat    -> Start Duan Agent',
    '',
    'Alternative Launch Methods:',
    '  - duan-web.bat          -> Web console mode',
    '  - npm run duan          -> Command line start',
    '  - npm run duan:web      -> Web service mode',
    '  - npm run duan:desktop  -> Desktop app mode',
    '',
    'First Run:',
    '  - You will be prompted to set up an API key',
    '  - Configuration is saved in your user profile under .duan/',
    '',
    'Troubleshooting:',
    '  - npm install is slow: run "npm config set registry https://registry.npmmirror.com"',
    '  - Program fails to start: run install.bat again to reinstall',
    '  - Need updates: download the new version package',
    '',
    '========================================',
    '  Duan Agent v20.0 (c) Duan Xiansheng',
    '========================================',
    '',
  ].join('\r\n'));
  console.log('  OK  README-INSTALL.txt created');

  // 6. 统计文件
  let totalFiles = 0;
  let totalSize = 0;
  let tsFiles = 0;
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        totalFiles++;
        totalSize += fs.statSync(p).size;
        if (entry.name.endsWith('.ts')) tsFiles++;
      }
    }
  }
  walk(PACKAGE_DIR);

  console.log();
  console.log('========================================');
  console.log('  Package directory: duan-installer');
  console.log('  Total files:       ' + totalFiles);
  console.log('  TypeScript files:  ' + tsFiles);
  console.log('  Total size:        ' + (totalSize / 1024 / 1024).toFixed(2) + ' MB');
  console.log('========================================');
  console.log();
  console.log('Next steps:');
  console.log('  1. Zip the duan-installer folder');
  console.log('  2. Distribute to users');
  console.log('  3. Users unzip and double-click install.bat');
  console.log();
}

main();
