/**
 * 报告生成器 — Markdown + HTML 双格式
 *
 * Markdown：输出到 output/capability-report-<ISO>.md（可 diff、可版本控制）
 * HTML：返回字符串，供前端仪表盘嵌入或独立文件查看
 */

import * as fsSync from 'fs';
import * as path from 'path';
import type { CapabilityReport } from './types.js';
import { CAPABILITY_DIMENSIONS } from './dimensions.js';

// ============ Markdown 报告 ============

export function generateMarkdownReport(report: CapabilityReport): string {
  const lines: string[] = [];
  const ts = new Date(report.timestamp).toISOString();
  const tsLocal = new Date(report.timestamp).toLocaleString('zh-CN');

  lines.push(`# 能力评估报告 — ${report.label}`);
  lines.push('');
  lines.push(`> 生成时间：${tsLocal} ｜ 时间戳：${ts}`);
  lines.push('');

  // 总分
  const baselineScore = report.baseline?.overallScore;
  const delta = baselineScore !== undefined ? report.overallScore - baselineScore : null;
  lines.push('## 总分');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 当前总分 | **${report.overallScore.toFixed(1)} / 100** |`);
  if (baselineScore !== undefined) {
    lines.push(`| Baseline 总分 | ${baselineScore.toFixed(1)} |`);
    const sign = delta! >= 0 ? '+' : '';
    lines.push(`| 变化 | ${sign}${delta!.toFixed(1)} |`);
  }
  lines.push('');

  // 10 维度记分卡
  lines.push('## 10 维度记分卡');
  lines.push('');
  lines.push('| 维度 | 当前分 | 权重 | 加权贡献 |');
  lines.push('| --- | --- | --- | --- |');
  for (const dim of report.dimensions) {
    lines.push(
      `| ${dim.name} | ${dim.score.toFixed(1)} | ${dim.weight.toFixed(2)} | ${(dim.score * dim.weight).toFixed(1)} |`,
    );
  }
  lines.push('');

  // 指标级详情
  lines.push('## 指标级详情');
  lines.push('');
  for (const dim of report.dimensions) {
    lines.push(`### ${dim.name} (${dim.score.toFixed(1)})`);
    lines.push('');
    lines.push('| 指标 | 当前值 | 评分 | 目标 | 单位 | 来源 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const m of dim.metrics) {
      const errTag = m.error ? ' ⚠️' : '';
      lines.push(
        `| ${m.spec.name}${errTag} | ${m.value.toFixed(3)} | ${m.score.toFixed(1)} | ${m.spec.target} | ${m.spec.unit} | ${m.source} |`,
      );
    }
    lines.push('');
  }

  // Top 改进 / 回归
  if (report.topImprovements.length > 0 || report.topRegressions.length > 0) {
    lines.push('## 与 Baseline 对比');
    lines.push('');
    if (report.topImprovements.length > 0) {
      lines.push('### Top 改进');
      lines.push('');
      for (const imp of report.topImprovements) {
        lines.push(`- **${imp.metricName}**：+${imp.delta.toFixed(1)}`);
      }
      lines.push('');
    }
    if (report.topRegressions.length > 0) {
      lines.push('### Top 回归');
      lines.push('');
      for (const reg of report.topRegressions) {
        lines.push(`- **${reg.metricName}**：${reg.delta.toFixed(1)}`);
      }
      lines.push('');
    }
  }

  // 跳过的指标
  if (report.skipped.length > 0) {
    lines.push('## 跳过的指标（适配器失败或未配置）');
    lines.push('');
    for (const s of report.skipped) {
      lines.push(`- \`${s.metricId}\`：${s.reason}`);
    }
    lines.push('');
  }

  // 建议
  if (report.recommendations.length > 0) {
    lines.push('## 建议');
    lines.push('');
    for (const r of report.recommendations) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*由 CapabilityAssessor 自动生成 — 段先生 v19.0 能力优化框架*`);

  return lines.join('\n');
}

// ============ HTML 报告 ============

export function generateHtmlReport(report: CapabilityReport): string {
  const tsLocal = new Date(report.timestamp).toLocaleString('zh-CN');
  const baselineScore = report.baseline?.overallScore;
  const delta = baselineScore !== undefined ? report.overallScore - baselineScore : null;

  const dimensionRows = report.dimensions
    .map(dim => {
      const baseDim = report.baseline?.dimensions.find(b => b.dimension === dim.dimension);
      const dDelta = baseDim ? dim.score - baseDim.score : null;
      const deltaStr = dDelta !== null ? (dDelta >= 0 ? `+${dDelta.toFixed(1)}` : dDelta.toFixed(1)) : '—';
      const deltaClass = dDelta === null ? '' : dDelta >= 0 ? 'positive' : 'negative';
      return `
        <tr>
          <td>${dim.name}</td>
          <td class="score">${dim.score.toFixed(1)}</td>
          <td>${baseDim ? baseDim.score.toFixed(1) : '—'}</td>
          <td class="${deltaClass}">${deltaStr}</td>
          <td>${dim.weight.toFixed(2)}</td>
          <td>
            <div class="bar"><div class="bar-fill" style="width:${dim.score}%"></div></div>
          </td>
        </tr>`;
    })
    .join('');

  const metricRows = report.dimensions
    .flatMap(dim =>
      dim.metrics.map(m => {
        const errTag = m.error ? `<span class="warn" title="${m.error}">⚠</span>` : '';
        return `
        <tr>
          <td>${dim.name}</td>
          <td>${m.spec.name}${errTag}</td>
          <td>${m.value.toFixed(3)}</td>
          <td class="score">${m.score.toFixed(1)}</td>
          <td>${m.spec.target}</td>
          <td>${m.spec.unit}</td>
          <td><span class="source">${m.source}</span></td>
        </tr>`;
      }),
    )
    .join('');

  const improvementsHtml = report.topImprovements
    .map(i => `<li class="positive">${i.metricName}：+${i.delta.toFixed(1)}</li>`)
    .join('');
  const regressionsHtml = report.topRegressions
    .map(r => `<li class="negative">${r.metricName}：${r.delta.toFixed(1)}</li>`)
    .join('');
  const recommendationsHtml = report.recommendations.map(r => `<li>${r}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>能力评估报告 — ${report.label}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; color: #1a1a1a; background: #fafafa; }
  h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
  h2 { color: #34495e; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { border: 1px solid #e0e0e0; padding: 8px 12px; text-align: left; }
  th { background: #f5f6fa; font-weight: 600; }
  .score { font-weight: 600; color: #2c3e50; }
  .positive { color: #27ae60; font-weight: 600; }
  .negative { color: #e74c3c; font-weight: 600; }
  .warn { color: #f39c12; cursor: help; }
  .source { font-family: monospace; font-size: 0.85em; color: #7f8c8d; background: #ecf0f1; padding: 2px 6px; border-radius: 3px; }
  .bar { background: #ecf0f1; border-radius: 3px; height: 18px; min-width: 100px; }
  .bar-fill { background: linear-gradient(90deg, #3498db, #2ecc71); height: 100%; border-radius: 3px; }
  .summary { display: flex; gap: 24px; margin: 16px 0; }
  .summary-card { background: white; padding: 16px 24px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); flex: 1; }
  .summary-card .label { color: #7f8c8d; font-size: 0.85em; text-transform: uppercase; }
  .summary-card .value { font-size: 2em; font-weight: 700; color: #2c3e50; margin-top: 4px; }
  ul { line-height: 1.8; }
</style>
</head>
<body>
  <h1>能力评估报告 — ${report.label}</h1>
  <p style="color:#7f8c8d">生成时间：${tsLocal}</p>

  <div class="summary">
    <div class="summary-card">
      <div class="label">当前总分</div>
      <div class="value">${report.overallScore.toFixed(1)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Baseline 总分</div>
      <div class="value">${baselineScore !== undefined ? baselineScore.toFixed(1) : '—'}</div>
    </div>
    <div class="summary-card">
      <div class="label">变化</div>
      <div class="value ${delta !== null && delta >= 0 ? 'positive' : delta !== null ? 'negative' : ''}">${
    delta !== null ? (delta >= 0 ? '+' : '') + delta.toFixed(1) : '—'
  }</div>
    </div>
  </div>

  <h2>10 维度记分卡</h2>
  <table>
    <thead><tr><th>维度</th><th>当前分</th><th>Baseline</th><th>变化</th><th>权重</th><th>进度</th></tr></thead>
    <tbody>${dimensionRows}</tbody>
  </table>

  <h2>指标级详情</h2>
  <table>
    <thead><tr><th>维度</th><th>指标</th><th>当前值</th><th>评分</th><th>目标</th><th>单位</th><th>来源</th></tr></thead>
    <tbody>${metricRows}</tbody>
  </table>

  ${improvementsHtml || regressionsHtml ? `
  <h2>与 Baseline 对比</h2>
  ${improvementsHtml ? `<h3>Top 改进</h3><ul>${improvementsHtml}</ul>` : ''}
  ${regressionsHtml ? `<h3>Top 回归</h3><ul>${regressionsHtml}</ul>` : ''}
  ` : ''}

  ${recommendationsHtml ? `
  <h2>建议</h2>
  <ul>${recommendationsHtml}</ul>
  ` : ''}

  <p style="color:#95a5a6; margin-top:48px; font-size:0.85em; border-top:1px solid #ecf0f1; padding-top:12px;">
    由 CapabilityAssessor 自动生成 — 段先生 v19.0 能力优化框架
  </p>
</body>
</html>`;
}

// ============ 文件写入 ============

/** 写入 Markdown 报告到 output/ 目录 */
export function writeMarkdownReport(report: CapabilityReport, outputDir = 'output'): string {
  if (!fsSync.existsSync(outputDir)) {
    fsSync.mkdirSync(outputDir, { recursive: true });
  }
  const ts = new Date(report.timestamp).toISOString().replace(/[:.]/g, '-');
  const filename = `capability-report-${report.label}-${ts}.md`;
  const filepath = path.join(outputDir, filename);
  fsSync.writeFileSync(filepath, generateMarkdownReport(report), 'utf-8');
  return filepath;
}

/** 写入 HTML 报告到 output/ 目录 */
export function writeHtmlReport(report: CapabilityReport, outputDir = 'output'): string {
  if (!fsSync.existsSync(outputDir)) {
    fsSync.mkdirSync(outputDir, { recursive: true });
  }
  const ts = new Date(report.timestamp).toISOString().replace(/[:.]/g, '-');
  const filename = `capability-report-${report.label}-${ts}.html`;
  const filepath = path.join(outputDir, filename);
  fsSync.writeFileSync(filepath, generateHtmlReport(report), 'utf-8');
  return filepath;
}
