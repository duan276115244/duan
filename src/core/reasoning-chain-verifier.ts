/**
 * 多步推理链验证器 — ReasoningChainVerifier
 *
 * 对标 OpenCode 的推理验证和 Codex 的逐步确认模式。
 * 解决推理链错误累积导致最终结果偏差的问题。
 *
 * 核心能力：
 * 1. 逐步验证：每步推理后检查逻辑一致性和事实准确性
 * 2. 一致性检查：检测前后步骤的矛盾
 * 3. 事实核查：验证推理中的事实声明
 * 4. 逻辑验证：检查因果链和推导过程
 * 5. 回溯修正：发现错误时回溯到出错点重新推理
 * 6. 置信度评估：为每步推理和整体结论评估置信度
 *
 * 借鉴来源：
 * - OpenCode：Multi-Step Reasoning Chain Verification
 * - Codex：逐步确认模式
 * - Tree of Thoughts：多路径推理
 */

import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 推理步骤 */
export interface ReasoningStep {
  /** 步骤 ID */
  id: number;
  /** 步骤描述 */
  description: string;
  /** 推理内容 */
  content: string;
  /** 前置步骤 ID */
  dependsOn?: number[];
  /** 声明的事实 */
  claims?: string[];
  /** 推导结论 */
  conclusion?: string;
  /** 置信度 (0-1) */
  confidence?: number;
}

/** 验证结果 */
export interface StepVerification {
  /** 步骤 ID */
  stepId: number;
  /** 是否通过 */
  passed: boolean;
  /** 置信度 */
  confidence: number;
  /** 发现的问题 */
  issues: VerificationIssue[];
  /** 与前序步骤的一致性 */
  consistencyWithPrevious: 'consistent' | 'inconsistent' | 'unknown';
  /** 建议修正 */
  suggestion?: string;
}

/** 验证问题 */
export interface VerificationIssue {
  /** 问题类型 */
  type: 'logical_error' | 'factual_error' | 'contradiction' | 'missing_premise' | 'circular_reasoning' | 'unsupported_claim';
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 问题描述 */
  description: string;
  /** 相关步骤 */
  relatedStep?: number;
}

/** 推理链验证结果 */
export interface ChainVerificationResult {
  /** 整体是否通过 */
  passed: boolean;
  /** 整体置信度 */
  overallConfidence: number;
  /** 各步骤验证结果 */
  stepResults: StepVerification[];
  /** 发现的所有问题 */
  allIssues: VerificationIssue[];
  /** 关键问题（需要回溯的） */
  criticalIssues: VerificationIssue[];
  /** 建议的回溯点（步骤 ID） */
  backtrackTo?: number;
  /** 验证摘要 */
  summary: string;
}

// ============ ReasoningChainVerifier 主类 ============

export class ReasoningChainVerifier {
  private log = logger.child({ module: 'ReasoningChainVerifier' });
  /** 统计 */
  private stats = {
    totalChains: 0,
    passedChains: 0,
    failedChains: 0,
    totalIssues: 0,
    averageConfidence: 0,
    backtracks: 0,
  };

  /**
   * 验证推理链
   */
  verifyChain(steps: ReasoningStep[]): ChainVerificationResult {
    this.stats.totalChains++;
    const stepResults: StepVerification[] = [];
    const allIssues: VerificationIssue[] = [];
    const criticalIssues: VerificationIssue[] = [];

    // 逐步验证（verifyStep 系列方法需要 Map<number, ReasoningStep> 做依赖查找）
    const stepMap = new Map(steps.map(s => [s.id, s]));
    for (const step of steps) {
      const result = this.verifyStep(step, stepMap);
      stepResults.push(result);
      allIssues.push(...result.issues);

      // 收集关键问题
      for (const issue of result.issues) {
        if (issue.severity === 'critical' || issue.severity === 'high') {
          criticalIssues.push(issue);
        }
      }
    }

    // 计算整体置信度
    const overallConfidence = this.calculateOverallConfidence(stepResults);

    // 确定回溯点
    let backtrackTo: number | undefined;
    if (criticalIssues.length > 0) {
      backtrackTo = this.determineBacktrackPoint(criticalIssues, steps);
      this.stats.backtracks++;
    }

    // 整体通过判断
    const passed = criticalIssues.length === 0 && overallConfidence >= 0.7;

    if (passed) {
      this.stats.passedChains++;
    } else {
      this.stats.failedChains++;
    }
    this.stats.totalIssues += allIssues.length;

    // 更新平均置信度
    const totalVerified = this.stats.passedChains + this.stats.failedChains;
    this.stats.averageConfidence =
      (this.stats.averageConfidence * (totalVerified - 1) + overallConfidence) / totalVerified;

    const summary = this.generateSummary(passed, overallConfidence, allIssues, criticalIssues);

    this.log.info('推理链验证完成', {
      steps: steps.length,
      passed,
      confidence: overallConfidence,
      issues: allIssues.length,
      critical: criticalIssues.length,
      backtrackTo,
    });

    return {
      passed,
      overallConfidence,
      stepResults,
      allIssues,
      criticalIssues,
      backtrackTo,
      summary,
    };
  }

  /**
   * 验证单个步骤
   * @param stepMap 由 verifyChain 入口构建一次的 id->步骤 映射，避免重复线性查找
   */
  private verifyStep(step: ReasoningStep, stepMap: Map<number, ReasoningStep>): StepVerification {
    const issues: VerificationIssue[] = [];
    let confidence = step.confidence ?? 0.8;

    // 1. 检查逻辑一致性
    const consistency = this.checkConsistency(step, stepMap);
    if (consistency === 'inconsistent') {
      issues.push({
        type: 'contradiction',
        severity: 'high',
        description: `步骤 ${step.id} 与前序步骤矛盾`,
      });
      confidence *= 0.5;
    }

    // 2. 检查循环推理
    if (this.detectCircularReasoning(step, stepMap)) {
      issues.push({
        type: 'circular_reasoning',
        severity: 'critical',
        description: `步骤 ${step.id} 存在循环推理`,
      });
      confidence *= 0.3;
    }

    // 3. 检查前提完整性
    const missingPremises = this.checkPremises(step, stepMap);
    for (const missing of missingPremises) {
      issues.push({
        type: 'missing_premise',
        severity: 'medium',
        description: missing,
      });
      confidence *= 0.8;
    }

    // 4. 检查事实声明
    if (step.claims) {
      for (const claim of step.claims) {
        const factCheck = this.factCheck(claim);
        if (!factCheck.supported) {
          issues.push({
            type: 'unsupported_claim',
            severity: factCheck.severity,
            description: `未充分支持的声明: "${claim}"`,
          });
          confidence *= 0.85;
        }
      }
    }

    // 5. 检查逻辑推导
    if (step.conclusion) {
      const logicCheck = this.checkLogic(step);
      if (!logicCheck.valid) {
        issues.push({
          type: 'logical_error',
          severity: logicCheck.severity,
          description: logicCheck.description,
        });
        confidence *= 0.6;
      }
    }

    const passed = issues.filter(i => i.severity === 'critical' || i.severity === 'high').length === 0;

    return {
      stepId: step.id,
      passed,
      confidence: Math.max(0, Math.min(1, confidence)),
      issues,
      consistencyWithPrevious: consistency,
      suggestion: passed ? undefined : this.generateSuggestion(issues),
    };
  }

  /**
   * 检查一致性
   */
  private checkConsistency(step: ReasoningStep, stepMap: Map<number, ReasoningStep>): 'consistent' | 'inconsistent' | 'unknown' {
    if (!step.dependsOn || step.dependsOn.length === 0) {
      return 'unknown';
    }

    // 获取依赖步骤的结论
    const dependencyConclusions: string[] = [];
    for (const depId of step.dependsOn) {
      const dep = stepMap.get(depId);
      if (dep?.conclusion) {
        dependencyConclusions.push(dep.conclusion);
      }
    }

    if (dependencyConclusions.length === 0) {
      return 'unknown';
    }

    // 增强矛盾检测：多策略语义一致性检查
    const stepContent = step.content.toLowerCase();
    for (const conclusion of dependencyConclusions) {
      const concLower = conclusion.toLowerCase();

      // 策略1：直接否定检测（原有，保留兼容）
      if (stepContent.includes('不') && concLower.includes('是')) {
        const stepNeg = stepContent.includes('不是') || stepContent.includes('不能') || stepContent.includes('不会');
        const concAffirm = !concLower.includes('不');
        if (stepNeg && concAffirm) {
          return 'inconsistent';
        }
      }

      // 策略2：反义词对检测（新增）
      const antonymPairs = [
        ['增加', '减少'], ['上升', '下降'], ['成功', '失败'],
        ['正确', '错误'], ['存在', '不存在'], ['允许', '禁止'],
        ['启用', '禁用'], ['包含', '不包含'], ['支持', '不支持'],
        ['true', 'false'], ['yes', 'no'], ['enable', 'disable'],
      ];
      for (const [wordA, wordB] of antonymPairs) {
        if ((stepContent.includes(wordA) && concLower.includes(wordB)) ||
            (stepContent.includes(wordB) && concLower.includes(wordA))) {
          return 'inconsistent';
        }
      }

      // 策略3：数值矛盾检测（新增）
      const stepNums = stepContent.match(/\d+(\.\d+)?/g) || [];
      const concNums = concLower.match(/\d+(\.\d+)?/g) || [];
      if (stepNums.length > 0 && concNums.length > 0) {
        // 检查相同数值上下文中的数值冲突
        for (const sn of stepNums) {
          for (const cn of concNums) {
            if (sn !== cn && Math.abs(parseFloat(sn) - parseFloat(cn)) > 0 &&
                this.sharesContext(stepContent, concLower, sn, cn)) {
              return 'inconsistent';
            }
          }
        }
      }

      // 策略4：模态矛盾检测（新增）
      const modalPairs = [
        ['必须', '可选'], ['必须', '不需要'], ['应当', '不应'],
        ['一定', '可能不'], ['必然', '偶然'],
      ];
      for (const [wordA, wordB] of modalPairs) {
        if ((stepContent.includes(wordA) && concLower.includes(wordB)) ||
            (stepContent.includes(wordB) && concLower.includes(wordA))) {
          return 'inconsistent';
        }
      }
    }

    return 'consistent';
  }

  /** 检查两个数值是否在相同上下文中（辅助方法） */
  private sharesContext(textA: string, textB: string, numA: string, numB: string): boolean {
    // 简化：检查数值前后是否有相同的关键词
    const getContext = (text: string, num: string) => {
      const idx = text.indexOf(num);
      if (idx === -1) return '';
      return text.substring(Math.max(0, idx - 10), idx + num.length + 10);
    };
    const ctxA = getContext(textA, numA);
    const ctxB = getContext(textB, numB);
    // 如果上下文有共同词汇（除数值外），认为可能在同一上下文
    const wordsA = ctxA.replace(/\d+/g, '').split(/\s+/).filter(w => w.length > 1);
    const wordsB = ctxB.replace(/\d+/g, '').split(/\s+/).filter(w => w.length > 1);
    return wordsA.some(w => wordsB.includes(w));
  }

  /**
   * 检测循环推理
   */
  private detectCircularReasoning(step: ReasoningStep, stepMap: Map<number, ReasoningStep>): boolean {
    const visited = new Set<number>();
    const checkDeps = (stepId: number, path: Set<number>): boolean => {
      if (path.has(stepId)) return true; // 循环
      if (visited.has(stepId)) return false;
      visited.add(stepId);

      const current = stepMap.get(stepId);
      if (!current?.dependsOn) return false;

      const newPath = new Set(path);
      newPath.add(stepId);
      for (const dep of current.dependsOn) {
        if (checkDeps(dep, newPath)) return true;
      }
      return false;
    };

    return checkDeps(step.id, new Set());
  }

  /**
   * 检查前提完整性
   */
  private checkPremises(step: ReasoningStep, stepMap: Map<number, ReasoningStep>): string[] {
    const missing: string[] = [];
    if (!step.dependsOn) return missing;

    for (const depId of step.dependsOn) {
      const dep = stepMap.get(depId);
      if (!dep) {
        missing.push(`依赖步骤 ${depId} 不存在`);
      } else if (!dep.conclusion) {
        missing.push(`依赖步骤 ${depId} 缺少结论`);
      }
    }

    return missing;
  }

  /**
   * 事实检查（增强版：多策略验证）
   */
  private factCheck(claim: string): { supported: boolean; severity: 'low' | 'medium' | 'high' } {
    // 策略1：绝对化声明检测（原有）
    const absolutePatterns = ['总是', '从不', '一定', '绝对', '所有', '没有', '必然', '永远', '从不', '每个'];
    for (const pattern of absolutePatterns) {
      if (claim.includes(pattern)) {
        return { supported: false, severity: 'medium' };
      }
      // 英文绝对化
      let enPattern: string | null;
      if (pattern === '总是') {
        enPattern = 'always';
      } else if (pattern === '从不') {
        enPattern = 'never';
      } else {
        enPattern = null;
      }
      if (enPattern && claim.toLowerCase().includes(enPattern)) {
        return { supported: false, severity: 'medium' };
      }
    }

    // 策略2：数值声明验证（增强：检查精确数值是否需要限定词）
    const numberPattern = /\d+%|\d+倍|\d+次|\d+个|\d+条|\d+项/;
    if (numberPattern.test(claim) && !claim.includes('约') && !claim.includes('大约') && !claim.includes('超过') && !claim.includes('至少') && !claim.includes('不超过')) {
      return { supported: false, severity: 'low' };
    }

    // 策略3：因果声明验证（新增：检测过度简化因果）
    const causalClaims = ['因为', '由于', '原因是', '导致', '造成'];
    const hasCausal = causalClaims.some(p => claim.includes(p));
    if (hasCausal) {
      // 检查是否有单一原因归因（简化因果）
      const singleCausePatterns = ['唯一原因', '根本原因', '就是因为', '完全由于'];
      for (const p of singleCausePatterns) {
        if (claim.includes(p)) {
          return { supported: false, severity: 'medium' };
        }
      }
    }

    // 策略4：比较声明验证（新增：检测无基准的比较）
    const comparativePatterns = ['更好', '更优', '更快', '更高', '更低', '更强', 'best', 'better', 'faster'];
    for (const p of comparativePatterns) {
      if (claim.toLowerCase().includes(p)) {
        // 检查是否有比较基准
        if (!claim.includes('比') && !claim.includes('相比') && !claim.includes('相对于') && !claim.toLowerCase().includes('than')) {
          return { supported: false, severity: 'low' };
        }
      }
    }

    // 策略5：技术声明验证（新增：检测可疑的技术绝对化）
    const techAbsolutePatterns = ['100%兼容', '完全支持', '零延迟', '无限制', '无限'];
    for (const p of techAbsolutePatterns) {
      if (claim.includes(p)) {
        return { supported: false, severity: 'high' };
      }
    }

    return { supported: true, severity: 'low' };
  }

  /**
   * 逻辑检查（增强版：多维度逻辑验证）
   */
  private checkLogic(step: ReasoningStep): { valid: boolean; severity: 'low' | 'medium' | 'high'; description: string } {
    if (!step.conclusion) {

      return { valid: true, severity: 'low', description: '' };
    }

    // 检查1：结论是否过于宽泛（原有）
    if (step.conclusion.length < 5) {
      return {
        valid: false,
        severity: 'low',
        description: '结论过于简短，缺乏充分论证',
      };
    }

    // 检查2：因果跳跃检测（增强：更全面的因果连接词）
    const causalPatterns = ['因此', '所以', '导致', '使得', '从而', '故', '由此', '可见', '于是', '结果是'];
    const hasCausal = causalPatterns.some(p => step.content.includes(p));
    if (!hasCausal && step.dependsOn?.length) {
      // 也接受英文因果词
      const enCausal = ['therefore', 'so ', 'thus', 'hence', 'consequently', 'as a result'];
      const hasEnCausal = enCausal.some(p => step.content.toLowerCase().includes(p));
      if (!hasEnCausal) {
        return {
          valid: false,
          severity: 'medium',
          description: '推理缺少明确的因果连接',
        };
      }
    }

    // 检查3：逻辑谬误检测（新增）
    // 检测滑坡谬误（slippery slope）
    if (step.content.includes('最终') && step.content.includes('导致') && !step.content.includes('可能')) {
      return {
        valid: false,
        severity: 'medium',
        description: '可能存在滑坡谬误：因果链缺少可能性限定',
      };
    }

    // 检测诉诸权威
    const authorityPatterns = ['专家说', '权威', '众所周知', '大家都知道'];
    for (const p of authorityPatterns) {
      if (step.content.includes(p) && !step.content.includes('数据') && !step.content.includes('研究')) {
        return {
          valid: false,
          severity: 'low',
          description: '可能存在诉诸权威谬误：缺少数据支撑',
        };
      }
    }

    // 检查4：结论与内容相关性（新增）
    // 如果结论包含内容中未出现的关键概念，可能存在逻辑跳跃
    const conclusionKeywords = step.conclusion.split(/[\s，。、,.]+/).filter(w => w.length > 2);
    const contentLower = step.content.toLowerCase();
    const unrelatedKeywords = conclusionKeywords.filter(kw =>
      !contentLower.includes(kw.toLowerCase()) && !step.dependsOn?.length
    );
    if (unrelatedKeywords.length > 2) {
      return {
        valid: false,
        severity: 'low',
        description: '结论包含内容中未充分讨论的概念',
      };
    }

    return { valid: true, severity: 'low', description: '' };
  }

  /**
   * 计算整体置信度
   */
  private calculateOverallConfidence(stepResults: StepVerification[]): number {
    if (stepResults.length === 0) return 0;

    // 加权平均：关键步骤权重更高
    let totalWeight = 0;
    let weightedSum = 0;
    for (const result of stepResults) {
      const weight = result.issues.some(i => i.severity === 'critical') ? 2 : 1;
      weightedSum += result.confidence * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * 确定回溯点
   */
  private determineBacktrackPoint(issues: VerificationIssue[], steps: ReasoningStep[]): number {
    // 找到最早的关键问题所在步骤
    let earliestStep = steps[0]?.id || 0;
    for (const issue of issues) {
      if (issue.relatedStep !== undefined && issue.relatedStep < earliestStep) {
        earliestStep = issue.relatedStep;
      }
    }
    return earliestStep;
  }

  /**
   * 生成修正建议
   */
  private generateSuggestion(issues: VerificationIssue[]): string {
    const suggestions: string[] = [];
    for (const issue of issues) {
      switch (issue.type) {
        case 'contradiction':
          suggestions.push('检查与前序步骤的矛盾，调整推理方向');
          break;
        case 'circular_reasoning':
          suggestions.push('打破循环依赖，引入新的前提');
          break;
        case 'missing_premise':
          suggestions.push('补充缺失的前提条件');
          break;
        case 'unsupported_claim':
          suggestions.push('为声明提供证据支持');
          break;
        case 'logical_error':
          suggestions.push('修正逻辑推导过程');
          break;
        default:
          suggestions.push('复查推理步骤');
      }
    }
    return suggestions.join('; ');
  }

  /**
   * 生成摘要
   */
  private generateSummary(
    passed: boolean,
    confidence: number,
    allIssues: VerificationIssue[],
    criticalIssues: VerificationIssue[],
  ): string {
    const parts: string[] = [];
    parts.push(passed ? '推理链验证通过' : '推理链验证未通过');
    parts.push(`整体置信度: ${(confidence * 100).toFixed(0)}%`);
    parts.push(`发现问题: ${allIssues.length} 个`);
    if (criticalIssues.length > 0) {
      parts.push(`关键问题: ${criticalIssues.length} 个`);
    }
    return parts.join(' | ');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this.stats };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      totalChains: 0,
      passedChains: 0,
      failedChains: 0,
      totalIssues: 0,
      averageConfidence: 0,
      backtracks: 0,
    };
  }
}

// ============ 单例 ============
// 注：单例工厂 getReasoningChainVerifier() 已删除（零调用），resetReasoningChainVerifier() 同步删除
