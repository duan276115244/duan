/**
 * 自我升级系统 - SelfUpgradeSystem
 *
 * 真正的Agent应该能自我升级：
 * 1. 自我分析：扫描自身代码，发现问题和改进点
 * 2. 自我改进：生成改进代码，自动替换
 * 3. 自我测试：修改后运行编译检查和功能测试
 * 4. 自我回滚：如果升级导致问题，自动回滚
 * 5. 升级历史：记录所有升级操作，可追溯
 */

import type { ModelLibrary } from './model-library.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 升级操作类型 */
export type UpgradeType =
  | 'bug_fix'          // 修复bug
  | 'performance'      // 性能优化
  | 'feature'          // 新功能
  | 'refactor'         // 重构
  | 'security'         // 安全修复
  | 'reliability';     // 可靠性改进

/** 代码分析结果 */
export interface CodeAnalysis {
  file: string;
  issues: CodeIssue[];
  suggestions: CodeSuggestion[];
  metrics: CodeMetrics;
}

/** 代码问题 */
export interface CodeIssue {
  type: 'bug' | 'performance' | 'security' | 'style' | 'complexity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  line?: number;
  description: string;
  suggestion: string;
}

/** 代码建议 */
export interface CodeSuggestion {
  type: UpgradeType;
  description: string;
  impact: string;
  risk: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
}

/** 代码指标 */
export interface CodeMetrics {
  lines: number;
  complexity: number;       // 圈复杂度估算
  duplication: number;      // 重复代码比例
  todoCount: number;        // TODO数量
  errorHandling: number;    // 错误处理覆盖率
}

/** 升级操作 */
export interface UpgradeOperation {
  id: string;
  type: UpgradeType;
  targetFile: string;
  description: string;
  beforeCode: string;
  afterCode: string;
  backupPath: string;
  status: 'pending' | 'applied' | 'tested' | 'rolled_back' | 'failed';
  testResult?: string;
  timestamp: number;
  reason: string;
}

/** 升级计划 */
export interface UpgradePlan {
  operations: UpgradeOperation[];
  estimatedImpact: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresRestart: boolean;
}

/** 升级结果 */
export interface UpgradeResult {
  success: boolean;
  operations: UpgradeOperation[];
  testResults: string[];
  rolledBack: boolean;
  summary: string;
}

// ============ 主类 ============

export class SelfUpgradeSystem {
  private modelLibrary: ModelLibrary;
  private projectRoot: string;
  private upgradeHistory: UpgradeOperation[] = [];
  private historyPath: string;

  constructor(modelLibrary: ModelLibrary, projectRoot?: string) {
    this.modelLibrary = modelLibrary;
    this.projectRoot = projectRoot || process.cwd();
    // P0 D2: 升级历史是全局状态（影响所有项目），优先用 duanPath；projectRoot 显式传入时保持兼容
    this.historyPath = projectRoot
      ? path.join(projectRoot, '.duan', 'upgrade-history.json')
      : duanPath('upgrade-history.json');
    this.loadHistory();
  }

  // ========== 自我分析 ==========

  /**
   * 扫描并分析自身代码
   */
  async analyzeSelf(): Promise<CodeAnalysis[]> {
    const srcDir = path.join(this.projectRoot, 'src');
    const analyses: CodeAnalysis[] = [];

    // 扫描核心文件
    const coreFiles = this.getCoreFiles();
    for (const file of coreFiles) {
      const fullPath = path.join(srcDir, file);
      if (fs.existsSync(fullPath)) {
        const analysis = await this.analyzeFile(fullPath);
        analyses.push(analysis);
      }
    }

    return analyses;
  }

  /**
   * 分析单个文件
   */
  async analyzeFile(filePath: string): Promise<CodeAnalysis> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.projectRoot, filePath);

    // 本地静态分析
    const localIssues = this.localAnalyze(content, relativePath);
    const localMetrics = this.calculateMetrics(content);

    // LLM深度分析（只分析核心文件，避免过多API调用）
    let llmIssues: CodeIssue[] = [];
    let llmSuggestions: CodeSuggestion[] = [];

    if (content.length > 100 && content.length < 50000) {
      try {
        const deepAnalysis = await this.llmAnalyze(content, relativePath);
        llmIssues = deepAnalysis.issues;
        llmSuggestions = deepAnalysis.suggestions;
      } catch {
        // LLM分析失败不影响本地分析
      }
    }

    return {
      file: relativePath,
      issues: [...localIssues, ...llmIssues],
      suggestions: llmSuggestions,
      metrics: localMetrics,
    };
  }

  /**
   * 生成升级计划
   */
  async createUpgradePlan(focus?: UpgradeType): Promise<UpgradePlan> {
    const analyses = await this.analyzeSelf();
    const operations: UpgradeOperation[] = [];

    for (const analysis of analyses) {
      // 根据focus筛选
      const relevantSuggestions = focus
        ? analysis.suggestions.filter(s => s.type === focus)
        : analysis.suggestions;

      for (const suggestion of relevantSuggestions) {
        if (suggestion.risk === 'high') continue; // 跳过高风险建议

        const op: UpgradeOperation = {
          id: `upgrade-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          type: suggestion.type,
          targetFile: analysis.file,
          description: suggestion.description,
          beforeCode: '',
          afterCode: '',
          backupPath: '',
          status: 'pending',
          timestamp: Date.now(),
          reason: suggestion.impact,
        };
        operations.push(op);
      }
    }

    // 按优先级排序
    operations.sort((a, b) => {
      const priorityMap: Record<UpgradeType, number> = {
        security: 4, bug_fix: 3, reliability: 2, performance: 1, refactor: 0, feature: -1,
      };
      return (priorityMap[b.type] || 0) - (priorityMap[a.type] || 0);
    });

    const riskLevel = (() => {
      if (operations.some(o => o.type === 'security')) return 'high';
      if (operations.length > 5) return 'medium';
      return 'low';
    })();

    return {
      operations,
      estimatedImpact: `${operations.length}项改进`,
      riskLevel,
      requiresRestart: operations.some(o =>
        o.targetFile.includes('duan-v') || o.targetFile.includes('agent-loop')
      ),
    };
  }

  // ========== 自我改进 ==========

  /**
   * 执行升级
   */
  async executeUpgrade(plan: UpgradePlan): Promise<UpgradeResult> {
    const testResults: string[] = [];
    let rolledBack = false;
    const appliedOps: UpgradeOperation[] = [];

    for (const op of plan.operations) {
      try {
        // 1. 读取当前代码
        const fullPath = path.join(this.projectRoot, op.targetFile);
        if (!fs.existsSync(fullPath)) continue;

        op.beforeCode = fs.readFileSync(fullPath, 'utf-8');

        // 2. 生成改进代码
        op.afterCode = await this.generateImprovedCode(op);

        if (!op.afterCode || op.afterCode === op.beforeCode) {
          op.status = 'failed';
          continue;
        }

        // 3. 创建备份
        op.backupPath = fullPath + `.backup.${Date.now()}`;
        fs.copyFileSync(fullPath, op.backupPath);

        // 4. 应用修改
        fs.writeFileSync(fullPath, op.afterCode, 'utf-8');
        op.status = 'applied';

        // 5. 测试
        const testResult = this.runTest(fullPath);
        op.testResult = testResult;
        testResults.push(`${op.targetFile}: ${testResult}`);

        if (testResult.includes('error') || testResult.includes('Error')) {
          // 测试失败，回滚
          fs.copyFileSync(op.backupPath, fullPath);
          op.status = 'rolled_back';
          rolledBack = true;
        } else {
          op.status = 'tested';
          appliedOps.push(op);
        }

      } catch (err: unknown) {
        op.status = 'failed';
        op.testResult = (err instanceof Error ? err.message : String(err));
        testResults.push(`${op.targetFile}: FAILED - ${(err instanceof Error ? err.message : String(err))}`);

        // 回滚
        if (op.backupPath && fs.existsSync(op.backupPath)) {
          const fullPath = path.join(this.projectRoot, op.targetFile);
          fs.copyFileSync(op.backupPath, fullPath);
          op.status = 'rolled_back';
          rolledBack = true;
        }
      }

      this.upgradeHistory.push(op);
    }

    this.saveHistory();

    const successCount = appliedOps.length;
    const totalCount = plan.operations.length;

    return {
      success: !rolledBack && successCount > 0,
      operations: plan.operations,
      testResults,
      rolledBack,
      summary: `升级完成: ${successCount}/${totalCount}项成功${rolledBack ? ' (部分已回滚)' : ''}`,
    };
  }

  /**
   * 快速自我修复 - 针对特定问题
   */
  async quickFix(filePath: string, issueDescription: string): Promise<UpgradeResult> {
    const fullPath = path.join(this.projectRoot, filePath);
    if (!fs.existsSync(fullPath)) {
      return {
        success: false,
        operations: [],
        testResults: [],
        rolledBack: false,
        summary: `文件不存在: ${filePath}`,
      };
    }

    const beforeCode = fs.readFileSync(fullPath, 'utf-8');
    const afterCode = await this.generateFix(beforeCode, filePath, issueDescription);

    if (!afterCode || afterCode === beforeCode) {
      return {
        success: false,
        operations: [],
        testResults: [],
        rolledBack: false,
        summary: '无法生成修复代码',
      };
    }

    // 备份
    const backupPath = fullPath + `.backup.${Date.now()}`;
    fs.copyFileSync(fullPath, backupPath);

    // 应用
    fs.writeFileSync(fullPath, afterCode, 'utf-8');

    // 测试
    const testResult = this.runTest(fullPath);

    const op: UpgradeOperation = {
      id: `fix-${Date.now()}`,
      type: 'bug_fix',
      targetFile: filePath,
      description: issueDescription,
      beforeCode,
      afterCode,
      backupPath,
      status: 'applied',
      testResult,
      timestamp: Date.now(),
      reason: issueDescription,
    };

    if (testResult.includes('error') || testResult.includes('Error')) {
      fs.copyFileSync(backupPath, fullPath);
      op.status = 'rolled_back';
      this.upgradeHistory.push(op);
      this.saveHistory();
      return {
        success: false,
        operations: [op],
        testResults: [testResult],
        rolledBack: true,
        summary: '修复后测试失败，已回滚',
      };
    }

    op.status = 'tested';
    this.upgradeHistory.push(op);
    this.saveHistory();

    return {
      success: true,
      operations: [op],
      testResults: [testResult],
      rolledBack: false,
      summary: '修复成功',
    };
  }

  // ========== 回滚 ==========

  /**
   * 回滚最近的升级
   */
  rollback(count: number = 1): number {
    const recentOps = this.upgradeHistory
      .filter(op => op.status === 'tested' || op.status === 'applied')
      .slice(-count);

    let rolledBack = 0;
    for (const op of recentOps) {
      try {
        if (op.backupPath && fs.existsSync(op.backupPath)) {
          const fullPath = path.join(this.projectRoot, op.targetFile);
          fs.copyFileSync(op.backupPath, fullPath);
          op.status = 'rolled_back';
          rolledBack++;
        }
      } catch {
        // 回滚失败
      }
    }

    this.saveHistory();
    return rolledBack;
  }

  /**
   * 获取升级历史
   */
  getHistory(): UpgradeOperation[] {
    return [...this.upgradeHistory];
  }

  /**
   * 获取升级统计
   */
  getStats(): {
    total: number;
    successful: number;
    failed: number;
    rolledBack: number;
    byType: Record<string, number>;
  } {
    const total = this.upgradeHistory.length;
    const successful = this.upgradeHistory.filter(o => o.status === 'tested').length;
    const failed = this.upgradeHistory.filter(o => o.status === 'failed').length;
    const rolledBack = this.upgradeHistory.filter(o => o.status === 'rolled_back').length;

    const byType: Record<string, number> = {};
    for (const op of this.upgradeHistory) {
      byType[op.type] = (byType[op.type] || 0) + 1;
    }

    return { total, successful, failed, rolledBack, byType };
  }

  // ========== 私有方法 ==========

  private getCoreFiles(): string[] {
    const srcDir = path.join(this.projectRoot, 'src', 'core');
    const files: string[] = [];
    try {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(`core/${entry.name}`);
        }
      }
    } catch {
      // 回退到硬编码列表
      return [
        'core/enhanced-agent-loop.ts',
        'core/self-upgrade-system.ts',
        'core/smart-tool-selector.ts',
        'core/capability-gap-detector.ts',
        'core/desktop-control.ts',
        'core/browser-operator.ts',
      ];
    }
    return files;
  }

  /**
   * 本地静态分析
   */

  private localAnalyze(content: string, _filePath: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // TODO/FIXME/HACK
      if (/TODO|FIXME|HACK|XXX/i.test(line)) {
        issues.push({
          type: 'style',
          severity: 'low',
          line: index + 1,
          description: `待办标记: ${line.trim()}`,
          suggestion: '处理或移除TODO标记',
        });
      }

      // console.log残留
      if (/console\.(log|debug|info)\(/.test(line) && !line.includes('//')) {
        issues.push({
          type: 'style',
          severity: 'low',
          line: index + 1,
          description: '可能的调试日志残留',
          suggestion: '移除或替换为正式日志',
        });
      }

      // 空catch
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /catch\s*\{\s*\}/.test(line)) {
        issues.push({
          type: 'bug',
          severity: 'medium',
          line: index + 1,
          description: '空catch块，吞掉了异常',
          suggestion: '添加错误处理或至少记录日志',
        });
      }

      // 硬编码API Key
      if (/sk-[a-zA-Z0-9]{20,}/.test(line)) {
        issues.push({
          type: 'security',
          severity: 'critical',
          line: index + 1,
          description: '硬编码的API Key',
          suggestion: '使用环境变量替代',
        });
      }

      // any类型滥用
      if (/\bany\b/.test(line) && !line.includes('Record<string, any>') && !line.includes('//')) {
        issues.push({
          type: 'style',
          severity: 'low',
          line: index + 1,
          description: '使用了any类型',
          suggestion: '使用更具体的类型',
        });
      }
    });

    // 大函数检测
    let functionStart = -1;
    let functionDepth = 0;
    lines.forEach((line, index) => {
      if (/^\s*(async\s+)?function\s|^\s*(public|private|protected)?\s*(async\s+)?\w+\s*\(/.test(line)) {
        if (functionDepth === 0) functionStart = index;
        functionDepth++;
      }
      if (functionDepth > 0 && /^\s*\}\s*$/.test(line)) {
        functionDepth--;
        if (functionDepth === 0 && functionStart >= 0) {
          const funcLength = index - functionStart;
          if (funcLength > 100) {
            issues.push({
              type: 'complexity',
              severity: 'medium',
              line: functionStart + 1,
              description: `函数过长(${funcLength}行)`,
              suggestion: '拆分为更小的函数',
            });
          }
          functionStart = -1;
        }
      }
    });

    return issues;
  }

  private calculateMetrics(content: string): CodeMetrics {
    const lines = content.split('\n');
    const todoCount = lines.filter(l => /TODO|FIXME|HACK/i.test(l)).length;
    const tryCount = (content.match(/try\s*\{/g) || []).length;
    const catchCount = (content.match(/catch\s*[({]/g) || []).length;

    return {
      lines: lines.length,
      complexity: Math.min(10, (content.match(/if|else|for|while|switch|case/g) || []).length / 5),
      duplication: 0, // 简化，不做精确重复检测
      todoCount,
      errorHandling: tryCount > 0 ? catchCount / tryCount : 0,
    };
  }

  /**
   * LLM深度分析
   */
  private async llmAnalyze(content: string, filePath: string): Promise<{
    issues: CodeIssue[];
    suggestions: CodeSuggestion[];
  }> {
    const prompt = `分析以下TypeScript代码，找出问题和改进建议。

文件: ${filePath}
代码:
\`\`\`typescript
${content.substring(0, 15000)}
\`\`\`

请用JSON格式返回：
{
  "issues": [
    {"type": "bug|performance|security|style|complexity", "severity": "low|medium|high|critical", "line": 0, "description": "问题描述", "suggestion": "修复建议"}
  ],
  "suggestions": [
    {"type": "bug_fix|performance|feature|refactor|security|reliability", "description": "改进描述", "impact": "影响说明", "risk": "low|medium|high", "effort": "low|medium|high"}
  ]
}

只返回真正重要的问题，不要报告风格偏好。最多3个问题和2个建议，只报告最关键的。`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: '你是一个代码审查专家，专注于发现真正的bug和性能问题。' },
      { role: 'user', content: prompt },
    ]);

    try {
      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          issues: (parsed.issues || []).slice(0, 5),
          suggestions: (parsed.suggestions || []).slice(0, 3),
        };
      }
    } catch {
      // 解析失败
    }

    return { issues: [], suggestions: [] };
  }

  /**
   * 生成改进代码
   */
  private async generateImprovedCode(op: UpgradeOperation): Promise<string> {
    const fullPath = path.join(this.projectRoot, op.targetFile);
    const currentCode = fs.readFileSync(fullPath, 'utf-8');

    // 对于大文件，使用增量修改策略
    if (currentCode.length > 8000) {
      return this.generateIncrementalFix(currentCode, op.targetFile, op.description, op.type);
    }

    const prompt = `改进以下代码，只修改与"${op.description}"相关的部分。

文件: ${op.targetFile}
改进类型: ${op.type}
改进描述: ${op.description}
改进原因: ${op.reason}

当前代码:
\`\`\`typescript
${currentCode}
\`\`\`

要求：
1. 只修改与改进描述相关的部分
2. 保持其他代码不变
3. 保持TypeScript类型正确
4. 返回完整的修改后代码
5. 不要删除任何现有功能

请返回完整的修改后代码：`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: '你是一个代码改进专家。只修改必要的部分，保持其他代码不变。' },
      { role: 'user', content: prompt },
    ]);

    const codeMatch = response.content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    if (codeMatch) {
      return codeMatch[1];
    }

    return '';
  }

  /**
   * 增量修改大文件 - 定位相关代码段，只修改相关部分
   */
  private async generateIncrementalFix(currentCode: string, filePath: string, description: string, type: string): Promise<string> {
    const lines = currentCode.split('\n');
    // 先让LLM定位需要修改的行号范围
    const locatePrompt = `我需要修改文件 ${filePath}，修改描述: ${description}

文件总行数: ${lines.length}
前50行:
\`\`\`
${lines.slice(0, 50).join('\n')}
\`\`\`

请返回需要修改的代码的起始行号和结束行号（JSON格式: {"startLine": 数字, "endLine": 数字}）。只返回JSON。`;

    try {
      const locateResponse = await this.modelLibrary.call([
        { role: 'system', content: '你是代码定位专家，根据修改描述定位需要修改的代码行号范围。' },
        { role: 'user', content: locatePrompt },
      ]);

      const locateMatch = locateResponse.content.match(/\{[\s\S]*\}/);
      if (!locateMatch) return '';

      const locate = JSON.parse(locateMatch[0]);
      const startLine = Math.max(0, (locate.startLine || 1) - 10);
      const endLine = Math.min(lines.length, (locate.endLine || lines.length) + 10);

      // 提取相关代码段
      const relevantCode = lines.slice(startLine, endLine).join('\n');

      const fixPrompt = `修改以下代码段，修改描述: ${description}
修改类型: ${type}

当前代码段 (第${startLine + 1}行 - 第${endLine}行):
\`\`\`typescript
${relevantCode}
\`\`\`

要求：
1. 只修改与描述相关的部分
2. 保持其他代码不变
3. 返回完整的修改后代码段（保持相同行数范围）

请返回修改后的完整代码段：`;

      const fixResponse = await this.modelLibrary.call([
        { role: 'system', content: '你是代码修改专家。精确修改指定部分，保持其他代码不变。' },
        { role: 'user', content: fixPrompt },
      ]);

      const codeMatch = fixResponse.content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
      if (codeMatch) {
        const fixedLines = codeMatch[1].split('\n');
        const newLines = [...lines];
        newLines.splice(startLine, endLine - startLine, ...fixedLines);
        return newLines.join('\n');
      }
    } catch {
      // 增量修改失败
    }

    return '';
  }

  /**
   * 生成修复代码
   */
  private async generateFix(currentCode: string, filePath: string, issue: string): Promise<string> {
    // 对于大文件，使用增量修改策略
    if (currentCode.length > 8000) {
      return this.generateIncrementalFix(currentCode, filePath, issue, 'bug_fix');
    }

    const prompt = `修复以下代码中的问题。

文件: ${filePath}
问题: ${issue}

当前代码:
\`\`\`typescript
${currentCode}
\`\`\`

要求：
1. 只修复指定的问题
2. 保持其他代码不变
3. 返回完整的修改后代码

请返回完整的修改后代码：`;

    const response = await this.modelLibrary.call([
      { role: 'system', content: '你是一个代码修复专家。精确修复指定问题，不做其他改动。' },
      { role: 'user', content: prompt },
    ]);

    const codeMatch = response.content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    if (codeMatch) {
      return codeMatch[1];
    }

    return '';
  }

  /**
   * 运行测试
   */
  private runTest(filePath: string): string {
    try {
      // TypeScript编译检查
      const result = execSync(
        `npx tsc --noEmit --skipLibCheck "${filePath}" 2>&1 || true`,
        { cwd: this.projectRoot, encoding: 'utf-8', timeout: 60000 }
      );

      const lines = result.split('\n');
      const errors = lines.filter(l => l.includes('error TS') && !l.includes('node_modules'));

      if (errors.length === 0) {
        return '✅ 编译检查通过';
      }
      return `⚠️ ${errors.length}个编译错误:\n${errors.slice(0, 5).join('\n')}`;
    } catch (err: unknown) {
      return `❌ 测试失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const data = JSON.parse(fs.readFileSync(this.historyPath, 'utf-8'));
        this.upgradeHistory = data.operations || [];
      }
    } catch {
      this.upgradeHistory = [];
    }
  }

  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      atomicWriteJsonSync(this.historyPath, {
        operations: this.upgradeHistory.slice(-100), // 保留最近100条
      });
    } catch {
      // 保存失败不影响运行
    }
  }
}
