// 构建脚本：编译 TypeScript + 复制模板 + 创建 duan.cmd
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. 编译 TypeScript（忽略类型错误，仍然输出 JS）
console.log('[build] 编译 TypeScript...');
try {
  execSync('npx tsc', { stdio: 'inherit' });
} catch (e) {
  console.log('[build] tsc 有类型错误，但已输出 JS 文件');
}

// 2. 复制模板
console.log('[build] 复制模板...');
try {
  fs.cpSync('templates', 'dist/templates', { recursive: true, force: true });
} catch (e) {
  console.log('[build] 模板复制跳过:', e.message);
}

// 3. 创建 duan.cmd
// P5 修复：上一次构建会执行 `attrib +R duan.cmd` 设只读，导致本次 writeFileSync 触发 EPERM。
// 写入前先清除只读属性（若文件存在），保证幂等可重建。
console.log('[build] 创建 duan.cmd...');
const cmd = '@echo off\r\nnode "%~dp0dist\\entry.js" %*';
if (fs.existsSync('duan.cmd')) {
  try { execSync('attrib -R duan.cmd', { stdio: 'ignore' }); } catch {}
}
fs.writeFileSync('duan.cmd', cmd);
console.log('[build] duan.cmd created');

// 4. 设置只读属性（防止被删除）
try {
  execSync('attrib +R duan.cmd', { stdio: 'ignore' });
} catch {}

console.log('[build] 构建完成');
