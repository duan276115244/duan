// 提取 .docx 文件纯文本（docx 是 zip，含 word/document.xml）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('用法: node extract-docx.cjs <file.docx>');
  process.exit(1);
}

// 复制到 ASCII 临时路径，避免 PowerShell 中文路径编码问题
const tmpDocx = path.join(os.tmpdir(), 'duan-docx-extract.docx');
fs.copyFileSync(file, tmpDocx);

// 用 PowerShell 解压读取 document.xml（避免依赖第三方 zip 库）
const psScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("${tmpDocx.replace(/\\/g, '\\\\')}")
$entry = $zip.GetEntry('word/document.xml')
$reader = New-Object System.IO.StreamReader($entry.Open())
$xml = $reader.ReadToEnd()
$reader.Close()
$zip.Dispose()
[Console]::Out.Write($xml)
`;

let xml;
try {
  const tmpPs1 = path.join(os.tmpdir(), 'extract-docx.ps1');
  fs.writeFileSync(tmpPs1, psScript, 'utf8');
  xml = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
} catch (e) {
  console.error('PowerShell 解压失败:', e.message);
  process.exit(1);
}

// 解析 XML：把 <w:p> 段落转成换行，提取 <w:t> 文本，<w:tab/> 转 tab，<w:br/> 转换行
let text = xml;
// 段落结束 </w:p> → 换行
text = text.replace(/<\/w:p>/g, '\n');
// <w:br/> 或 <w:br /> → 换行
text = text.replace(/<w:br[^>]*\/>/g, '\n');
// <w:tab[^>]*\/> → tab
text = text.replace(/<w:tab[^>]*\/>/g, '\t');
// 移除所有其他标签
text = text.replace(/<[^>]+>/g, '');
// 解码 XML 实体
text = text.replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'");

// 合并多余空行
text = text.replace(/\n{3,}/g, '\n\n');

console.log(text);
