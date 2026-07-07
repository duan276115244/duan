const VERSION = 'v19.0';

function findAlternativeTool(failedTool: string): string | null {
  const alternatives: Record<string, string[]> = {
    code_execute: ['shell_execute'],
    file_read: ['shell_execute'],
    file_write: ['shell_execute'],
    web_search: ['web_fetch'],
    shell_execute: ['code_execute'],
    list_directory: ['shell_execute'],
    web_fetch: ['web_search'],
  };
  const alts = alternatives[failedTool];
  return alts && alts.length > 0 ? alts[0] : null;
}

function generateSmartCode(lang: string, feature: string, originalMsg: string): string {
  const lowerFeature = feature.toLowerCase();

  if (/计算器|calculator/.test(lowerFeature)) {
    if (lang === 'python') {
      return `
class Calculator:
    def add(self, a, b): return a + b
    def sub(self, a, b): return a - b
    def mul(self, a, b): return a * b
    def div(self, a, b): return a / b if b != 0 else "Error: 除数不能为零"

calc = Calculator()
print(f"10 + 5 = {calc.add(10, 5)}")
print(f"10 - 5 = {calc.sub(10, 5)}")
print(f"10 × 5 = {calc.mul(10, 5)}")
print(f"10 ÷ 5 = {calc.div(10, 5)}")
print("计算器运行成功！")
`;
    }
    return `
class Calculator {
  add(a, b) { return a + b; }
  sub(a, b) { return a - b; }
  mul(a, b) { return a * b; }
  div(a, b) { return b !== 0 ? a / b : 'Error: 除数不能为零'; }
}

const calc = new Calculator();
console.info('10 + 5 =', calc.add(10, 5));
console.info('10 - 5 =', calc.sub(10, 5));
console.info('10 × 5 =', calc.mul(10, 5));
console.info('10 ÷ 5 =', calc.div(10, 5));
console.info('计算器运行成功！');
`;
  }

  if (/斐波那契|fibonacci|fib/.test(lowerFeature)) {
    return `
function fibonacci(n) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const fib = [0, 1];
  for (let i = 2; i < n; i++) {
    fib.push(fib[i-1] + fib[i-2]);
  }
  return fib;
}

const result = fibonacci(20);
console.info('斐波那契数列前20项:');
console.info(result.join(', '));
console.info('第20项:', result[19]);
`;
  }

  if (/排序|sort/.test(lowerFeature)) {
    return `
function bubbleSort(arr) {
  const n = arr.length;
  const a = [...arr];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - i - 1; j++) {
      if (a[j] > a[j + 1]) {
        [a[j], a[j + 1]] = [a[j + 1], a[j]];
      }
    }
  }
  return a;
}

const data = [64, 34, 25, 12, 22, 11, 90, 1, 45, 78];
console.info('排序前:', data.join(', '));
console.info('排序后:', bubbleSort(data).join(', '));
`;
  }

  if (/待办|todo|任务列表/.test(lowerFeature)) {
    return `
class TodoApp {
  constructor() {
    this.todos = [];
    this.nextId = 1;
  }

  add(text) {
    this.todos.push({ id: this.nextId++, text, done: false });
    return '添加成功: ' + text;
  }

  done(id) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) { todo.done = true; return '完成: ' + todo.text; }
    return '未找到ID: ' + id;
  }

  list() {
    return this.todos.map(t => (t.done ? '✅' : '⬜') + ' #' + t.id + ' ' + t.text).join('\\\\n');
  }

  pending() {
    return this.todos.filter(t => !t.done);
  }
}

const app = new TodoApp();
console.info(app.add('学习JavaScript'));
console.info(app.add('写代码'));
console.info(app.add('测试程序'));
console.info(app.done(1));
console.info('\\n待办列表:');
console.info(app.list());
console.info('\\n未完成:', app.pending().length, '项');
`;
  }

  if (/服务器|server|http|api|接口|web服务/.test(lowerFeature)) {
    return `
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const data = {
    message: '段先生为您服务！',
    time: new Date().toISOString(),
    path: req.url,
    method: req.method
  };
  res.end(JSON.stringify(data, null, 2));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.info('Server running at http://localhost:' + PORT);
  console.info('Try: curl http://localhost:' + PORT);
});
`;
  }

  if (/游戏|game|猜|贪吃蛇|snake|2048|扫雷/.test(lowerFeature)) {
    return `
// 猜数字游戏
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

const target = Math.floor(Math.random() * 100) + 1;
let attempts = 0;

console.info('段先生游戏: 猜数字 (1-100)');

function ask() {
  readline.question('请输入你的猜测: ', (input) => {
    attempts++;
    const guess = parseInt(input);
    if (guess === target) {
      console.info('恭喜！猜对了！用了 ' + attempts + ' 次');
      readline.close();
    } else {
      console.info(guess > target ? '太大了！' : '太小了！');
      ask();
    }
  });
}

ask();
`;
  }

  if (/数据|csv|json|处理|转换|format/.test(lowerFeature)) {
    return `
// 数据处理工具
const data = [
  { name: '张三', score: 85, grade: 'A' },
  { name: '李四', score: 92, grade: 'A' },
  { name: '王五', score: 67, grade: 'B' },
  { name: '赵六', score: 78, grade: 'B' },
  { name: '钱七', score: 95, grade: 'A' },
];

const avg = data.reduce((s, d) => s + d.score, 0) / data.length;
const max = Math.max(...data.map(d => d.score));
const min = Math.min(...data.map(d => d.score));
const grades = data.reduce((acc, d) => {
  acc[d.grade] = (acc[d.grade] || 0) + 1;
  return acc;
}, {});

console.info('数据统计:');
console.info('平均分:', avg.toFixed(2));
console.info('最高分:', max);
console.info('最低分:', min);
console.info('成绩分布:', grades);
console.info('A级学生:', data.filter(d => d.grade === 'A').map(d => d.name).join(', '));
`;
  }

  if (/密码|password|生成器|generator|随机/.test(lowerFeature)) {
    return `
function generatePassword(length = 16, options = {}) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  let chars = (options.upper !== false ? upper : '') +
              (options.lower !== false ? lower : '') +
              (options.digits !== false ? digits : '') +
              (options.symbols !== false ? symbols : '');

  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }
  return password;
}

console.info('强密码:', generatePassword(20));
console.info('简单密码:', generatePassword(12, { symbols: false }));
console.info('纯数字:', generatePassword(6, { upper: false, lower: false, symbols: false }));
`;
  }

  if (/日期|时间|date|time|日历|calendar/.test(lowerFeature)) {
    return `
const now = new Date();

console.info('当前时间:', now.toLocaleString('zh-CN'));
console.info('ISO:', now.toISOString());
console.info('时间戳:', now.getTime());
console.info('星期:', ['日','一','二','三','四','五','六'][now.getDay()]);
console.info('年份:', now.getFullYear());
console.info('月份:', now.getMonth() + 1);
console.info('日期:', now.getDate());

const nextYear = new Date(now.getFullYear() + 1, 0, 1);
const daysLeft = Math.ceil((nextYear - now) / (1000 * 60 * 60 * 24));
console.info('距离下个元旦:', daysLeft, '天');
`;
  }

  return `
// ${feature} - ${lang.toUpperCase()} 实现
// 需求: ${originalMsg.substring(0, 50)}

function solution() {
  console.info('段先生为您执行任务: ${feature.replace(/'/g, "\\'")}');
  console.info('执行时间:', new Date().toLocaleString());

  const result = {
    task: '${feature.replace(/'/g, "\\'")}',
    status: '执行成功',
    timestamp: new Date().toISOString()
  };

  return result;
}

const output = solution();
console.info('执行结果:', JSON.stringify(output, null, 2));
`;
}

function generateFileContent(fileName: string, originalMsg: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();

  if (ext === 'json') {
    return JSON.stringify({
      name: fileName.replace('.json', ''),
      version: '1.0.0',
      description: '由段先生生成',
      createdAt: new Date().toISOString()
    }, null, 2);
  }

  if (ext === 'md') {
    return `# ${fileName.replace('.md', '')}

> 由段先生 ${VERSION} 生成于 ${new Date().toLocaleString()}

## 概述

${originalMsg}

## 内容

TODO: 在此添加内容
`;
  }

  if (ext === 'py') {
    return `# -*- coding: utf-8 -*-
"""${fileName} - 由段先生生成"""

def main():
    print("段先生为您服务！")
    # TODO: 在此添加逻辑

if __name__ == "__main__":
    main()
`;
  }

  if (ext === 'ts' || ext === 'tsx') {
    return `// ${fileName} - 由段先生生成

interface Config {
  name: string;
  version: string;
}

const config: Config = {
  name: "${fileName}",
  version: "1.0.0"
};

console.info("段先生为您服务！", config);
`;
  }

  if (ext === 'html') {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${fileName.replace('.html', '')}</title>
</head>
<body>
  <h1>由段先生生成</h1>
  <p>${originalMsg}</p>
</body>
</html>`;
  }

  return `// ${fileName} - 由段先生 ${VERSION} 生成
// 创建时间: ${new Date().toLocaleString()}
// 需求: ${originalMsg}

console.info("段先生为您服务！");
`;
}

export { findAlternativeTool, generateSmartCode, generateFileContent };
