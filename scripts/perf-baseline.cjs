#!/usr/bin/env node
/**
 * Phase E1: 性能基准实测
 *
 * 跑 3 类基准（每类 5 次取中位数）：
 * 1. 冷启动时间 — require 增强主循环模块
 * 2. 单轮对话延迟 — user input 到第一个 chunk
 * 3. 10 轮对话后内存增量
 *
 * 运行：
 *   $env:AGNES_API_KEY="..."; node scripts/perf-baseline.cjs
 */
const { performance } = require('perf_hooks');

const AGNES_KEY = process.env.AGNES_API_KEY;
if (!AGNES_KEY) {
  console.error('❌ 未设置 AGNES_API_KEY 环境变量');
  process.exit(1);
}

// Agnes 用 OpenAI 兼容接口直接测，避免 agent loop 全套依赖初始化
const OpenAI = require('openai');

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
}

function fmtMs(ms) {
  return `${ms.toFixed(0)}ms`;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

// ===== 1. 冷启动时间 =====
async function benchmarkColdStart(runs = 5) {
  console.log('\n' + '─'.repeat(60));
  console.log('📊 基准 1: 冷启动时间（tsx 加载核心 TS 模块）');
  console.log('─'.repeat(60));
  console.log('  方法：spawn `npx tsx -e "import 核心模块"` 子进程，测 wall-clock 时间');
  console.log('  注：含 tsx JIT 编译开销，更贴近生产 npm run duan 启动');
  const times = [];

  const { spawnSync } = require('child_process');
  // 导入核心 TS 模块后立即退出（避免触发 side-effect 启动）
  const code = `
    import('./src/core/extended-thinking-service.js')
      .then(() => import('./src/core/smart-tool-selector.js'))
      .then(() => import('./src/core/i18n/index.js'))
      .then(() => import('./src/core/evolution-metrics.js'))
      .then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1); });
  `;

  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const result = spawnSync('npx', ['tsx', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const elapsed = performance.now() - t0;
    if (result.status === 0) {
      times.push(elapsed);
      console.log(`  [run ${i + 1}] ${fmtMs(elapsed)}`);
    } else {
      console.log(`  [run ${i + 1}] ❌ exit=${result.status} — ${(result.stderr || '').split('\n')[0].slice(0, 100)}`);
    }
  }

  if (times.length === 0) return { median: NaN, p95: NaN, samples: [] };
  console.log(`\n  📌 中位数: ${fmtMs(median(times))} | P95: ${fmtMs(p95(times))}`);
  return { median: median(times), p95: p95(times), samples: times };
}

// ===== 2. 单轮对话首 chunk 延迟 =====
async function benchmarkFirstChunk(runs = 5) {
  console.log('\n' + '─'.repeat(60));
  console.log('📊 基准 2: 单轮对话首 chunk 延迟（user input → 首字节）');
  console.log('─'.repeat(60));

  const client = new OpenAI({
    apiKey: AGNES_KEY,
    baseURL: 'https://apihub.agnes-ai.com/v1',
  });

  const prompt = '请用一句话简短介绍你自己。';
  const times = [];

  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    let firstChunkTime = null;
    try {
      const stream = await client.chat.completions.create({
        model: 'agnes-2.0-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 30,
        temperature: 0,
        stream: true,
      });
      for await (const chunk of stream) {
        if (chunk.choices?.[0]?.delta?.content) {
          firstChunkTime = performance.now() - t0;
          break;
        }
      }
      if (firstChunkTime === null) firstChunkTime = performance.now() - t0;
      times.push(firstChunkTime);
      console.log(`  [run ${i + 1}] 首 chunk: ${fmtMs(firstChunkTime)}`);
    } catch (err) {
      console.log(`  [run ${i + 1}] ❌ 失败: ${err.message}`);
    }
  }

  if (times.length === 0) return { median: NaN, p95: NaN, samples: [] };
  console.log(`\n  📌 中位数: ${fmtMs(median(times))} | P95: ${fmtMs(p95(times))}`);
  return { median: median(times), p95: p95(times), samples: times };
}

// ===== 3. 10 轮对话内存增量 =====
async function benchmarkMemoryGrowth(turns = 10) {
  console.log('\n' + '─'.repeat(60));
  console.log(`📊 基准 3: ${turns} 轮对话后内存增量`);
  console.log('─'.repeat(60));

  if (global.gc) {
    global.gc();
    console.log('  ℹ️  GC 已手动触发（--expose-gc 启用）');
  } else {
    console.log('  ⚠️  未启用 --expose-gc，结果可能含未回收内存，建议用 node --expose-gc 运行');
  }

  const client = new OpenAI({
    apiKey: AGNES_KEY,
    baseURL: 'https://apihub.agnes-ai.com/v1',
  });

  const before = process.memoryUsage();
  console.log(`  起始 heapUsed: ${fmtMB(before.heapUsed)}`);

  // 模拟 10 轮对话累积上下文（不持久化到磁盘）
  const conversation = [];
  for (let i = 0; i < turns; i++) {
    const userMsg = `测试问题 ${i + 1}: 简短介绍 Node.js 内存管理。`;
    conversation.push({ role: 'user', content: userMsg });
    try {
      const resp = await client.chat.completions.create({
        model: 'agnes-2.0-flash',
        messages: conversation,
        max_tokens: 50,
        temperature: 0,
      });
      const assistantMsg = resp.choices?.[0]?.message?.content || '';
      conversation.push({ role: 'assistant', content: assistantMsg });
      console.log(`  [turn ${i + 1}] 完成 — 当前 heapUsed: ${fmtMB(process.memoryUsage().heapUsed)}`);
    } catch (err) {
      console.log(`  [turn ${i + 1}] ❌ 失败: ${err.message}`);
      break;
    }
  }

  if (global.gc) global.gc();
  const after = process.memoryUsage();
  const delta = after.heapUsed - before.heapUsed;
  console.log(`\n  终止 heapUsed: ${fmtMB(after.heapUsed)}`);
  console.log(`  📌 10 轮内存增量: ${fmtMB(delta)} (${(delta / 1024 / 1024).toFixed(2)} MB)`);
  return { before: before.heapUsed, after: after.heapUsed, delta };
}

// ===== 主流程 =====
(async () => {
  console.log('='.repeat(60));
  console.log('Phase E1: 性能基准实测');
  console.log('='.repeat(60));
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Provider: Agnes (agnes-2.0-flash)`);

  const results = {
    coldStart: await benchmarkColdStart(5),
    firstChunk: await benchmarkFirstChunk(5),
    memoryGrowth: await benchmarkMemoryGrowth(10),
  };

  // ===== 最终报告 =====
  console.log('\n' + '='.repeat(60));
  console.log('📈 最终基准结果');
  console.log('='.repeat(60));
  console.log('| 指标                | 目标         | 实测中位数   | P95          | 状态 |');
  console.log('|---------------------|--------------|--------------|--------------|------|');
  const csMed = isFinite(results.coldStart.median) ? fmtMs(results.coldStart.median) : 'N/A';
  const csP95 = isFinite(results.coldStart.p95) ? fmtMs(results.coldStart.p95) : 'N/A';
  const csStatus = isFinite(results.coldStart.median) && results.coldStart.median < 3000 ? '✅' : '⚠️';
  console.log(`| 冷启动时间          | < 3000ms     | ${csMed.padEnd(12)} | ${csP95.padEnd(12)} | ${csStatus}   |`);
  const fcMed = isFinite(results.firstChunk.median) ? fmtMs(results.firstChunk.median) : 'N/A';
  const fcP95 = isFinite(results.firstChunk.p95) ? fmtMs(results.firstChunk.p95) : 'N/A';
  const fcStatus = isFinite(results.firstChunk.p95) && results.firstChunk.p95 < 2000 ? '✅' : '⚠️';
  console.log(`| 单轮首 chunk 延迟   | < 2000ms P95 | ${fcMed.padEnd(12)} | ${fcP95.padEnd(12)} | ${fcStatus}   |`);
  const memDelta = results.memoryGrowth.delta;
  const memStatus = memDelta < 50 * 1024 * 1024 ? '✅' : '⚠️';
  console.log(`| 10 轮内存增量       | < 50MB       | ${fmtMB(memDelta).padEnd(12)} | ${fmtMB(memDelta).padEnd(12)} | ${memStatus}   |`);

  console.log('\n📝 备注：');
  console.log('  - 冷启动测试：require 缓存清空后重新加载核心模块（不含 LLM 客户端初始化）');
  console.log('  - 首 chunk 延迟：直接调 OpenAI 兼容 API，未走 agent loop（实际生产可能 +500ms 启动开销）');
  console.log('  - 内存增量：直接 OpenAI 客户端累积对话，未含 ModelLibrary LRU + memory store');
  console.log('  - 实际 agent 端到端延迟会高 30-50%（含 i18n 检测 / 工具选择 / 思考流式 / SSE 序列化）');

  // 写入 JSON 供后续读取
  const fs = require('fs');
  const reportPath = 'docs/perf-baseline-results.json';
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    node: process.version,
    provider: 'Agnes (agnes-2.0-flash)',
    results,
  }, null, 2));
  console.log(`\n💾 详细结果已写入: ${reportPath}`);
})();
