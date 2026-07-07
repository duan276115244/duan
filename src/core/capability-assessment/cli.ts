/**
 * 能力评估 CLI 入口
 *
 * 用法：
 *   npx tsx src/core/capability-assessment/cli.ts baseline   # 记录 baseline
 *   npx tsx src/core/capability-assessment/cli.ts assess      # 跑评估 + 生成报告
 *   npx tsx src/core/capability-assessment/cli.ts report      # 从上次评估重生成报告
 *
 * npm 脚本：
 *   npm run capability:baseline
 *   npm run capability:assess
 *   npm run capability:report
 *
 * 数据源策略：
 * - EvolutionMetrics / LearningEvalSystem 可独立构造（从磁盘加载持久化状态）
 * - 测试套件（source='suite'）按需注册（Phase 3 完成）
 * - runtime 埋点值（source='new'）从 ~/.duan/capability-assessment/runtime-values.json 读取
 *   其他模块通过 recordRuntimeValue() 写入该文件
 * - 适配器失败的指标会被跳过（不阻断评估）
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { duanPath } from '../duan-paths.js';
import { CapabilityAssessor } from './assessor.js';
import type { CapabilityDimensionId, CapabilityTestSuite } from './types.js';
import type { MetricSources } from './adapters.js';
import { writeMarkdownReport, writeHtmlReport } from './report-generator.js';
import { loadRuntimeValues } from './runtime-values.js';

// ============ 数据源构造 ============

async function buildSources(): Promise<MetricSources> {
  const sources: MetricSources = {};

  // EvolutionMetrics — 可独立构造（构造函数从磁盘加载）
  try {
    const { EvolutionMetrics } = await import('../evolution-metrics.js');
    sources.evolutionMetrics = new EvolutionMetrics();
  } catch (err) {
    console.warn(`[capability-cli] EvolutionMetrics 加载失败：${err instanceof Error ? err.message : err}`);
  }

  // LearningEvalSystem — 可独立构造
  try {
    const { LearningEvalSystem } = await import('../learning-eval-system.js');
    sources.learningEval = new LearningEvalSystem();
  } catch (err) {
    console.warn(`[capability-cli] LearningEvalSystem 加载失败：${err instanceof Error ? err.message : err}`);
  }

  // MemoryOrchestrator 不易独立构造（需 vector store），跳过 — recall_latency 会优雅降级
  return sources;
}

// ============ 测试套件注册 ============

async function buildSuites(): Promise<Partial<Record<CapabilityDimensionId, CapabilityTestSuite>>> {
  const suites: Partial<Record<CapabilityDimensionId, CapabilityTestSuite>> = {};
  const suiteModules: Array<{ dim: CapabilityDimensionId; modulePath: string }> = [
    { dim: 'thinking', modulePath: './suites/thinking.suite.js' },
    { dim: 'execution', modulePath: './suites/execution.suite.js' },
    { dim: 'computer_ops', modulePath: './suites/computer-ops.suite.js' },
    { dim: 'code', modulePath: './suites/code.suite.js' },
    { dim: 'learning', modulePath: './suites/learning.suite.js' },
    { dim: 'memory', modulePath: './suites/memory.suite.js' },
    { dim: 'self_iteration', modulePath: './suites/self-iteration.suite.js' },
    { dim: 'self_repair', modulePath: './suites/self-repair.suite.js' },
    { dim: 'inference', modulePath: './suites/inference.suite.js' },
    { dim: 'cross_platform', modulePath: './suites/cross-platform.suite.js' },
  ];

  for (const { dim, modulePath } of suiteModules) {
    try {
      const mod = await import(modulePath);
      // 套件模块应导出 default 或 named `suite`（CapabilityTestSuite 实例）
      const suite: CapabilityTestSuite | undefined = mod.default || mod.suite;
      if (suite && typeof suite.run === 'function') {
        suites[dim] = suite;
      }
    } catch {
      // 套件尚未实现（Phase 3），静默跳过
    }
  }
  return suites;
}

// ============ 主入口 ============

async function main(): Promise<void> {
  const command = process.argv[2] as 'baseline' | 'assess' | 'report' | undefined;
  if (!command || !['baseline', 'assess', 'report'].includes(command)) {
    console.error('用法：npx tsx cli.ts <baseline|assess|report>');
    process.exit(1);
  }

  const dataPath = duanPath('capability-assessment');
  const sources = await buildSources();
  const suites = await buildSuites();
  const runtimeValues = loadRuntimeValues();

  const assessor = new CapabilityAssessor({ sources, suites, dataPath });

  // 注入 runtime 埋点值
  for (const [id, val] of Object.entries(runtimeValues)) {
    assessor.recordRuntimeValue(id, val);
  }

  if (command === 'report') {
    const last = assessor.loadLastReport();
    if (!last) {
      console.error('无上次报告，请先运行 assess');
      process.exit(1);
    }
    const md = writeMarkdownReport(last);
    const html = writeHtmlReport(last);
    console.log(`Markdown 报告：${md}`);
    console.log(`HTML 报告：${html}`);
    return;
  }

  console.log(`[capability-cli] 开始评估（label=${command}）...`);
  const availableAdapters = Object.keys(sources).filter(k => sources[k as keyof MetricSources]);
  console.log(`[capability-cli] 可用适配器：${availableAdapters.join(', ') || 'none'}`);
  console.log(`[capability-cli] 已注册套件：${Object.keys(suites).join(', ') || 'none'}`);
  console.log(`[capability-cli] runtime 埋点：${Object.keys(runtimeValues).length} 个`);

  // 'assess' 命令对应 label='current'
  const label = command === 'assess' ? 'current' : 'baseline';
  const report = await assessor.runAssessment(label);
  const md = writeMarkdownReport(report);
  const html = writeHtmlReport(report);

  console.log('');
  console.log('=== 评估完成 ===');
  console.log(`总分：${report.overallScore.toFixed(1)} / 100`);
  console.log(`跳过指标：${report.skipped.length} 个`);
  if (report.skipped.length > 0) {
    for (const s of report.skipped.slice(0, 5)) {
      console.log(`  - ${s.metricId}：${s.reason}`);
    }
    if (report.skipped.length > 5) console.log(`  ... 还有 ${report.skipped.length - 5} 个`);
  }
  if (report.baseline) {
    const delta = report.overallScore - report.baseline.overallScore;
    console.log(`Baseline 对比：${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
  }
  console.log('');
  console.log(`Markdown 报告：${path.resolve(md)}`);
  console.log(`HTML 报告：${path.resolve(html)}`);
}

main().catch(err => {
  console.error('能力评估失败：', err);
  process.exit(1);
});
