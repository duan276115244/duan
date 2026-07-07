/**
 * 对抗验证子Agent — AdversarialVerifier
 *
 * 红队对抗验证系统：通过自动化对抗测试确保主Agent输出的高质量与可靠性。
 * 核心能力：
 * 1. 输出验证：红队LLM挑战主Agent输出，发现事实错误、逻辑矛盾、遗漏边界
 * 2. 代码对抗：发现Bug、安全漏洞、性能问题，生成破坏性测试用例
 * 3. 推理验证：检测逻辑谬误、隐含假设、反例
 * 4. 压力测试：生成边界用例与对抗输入
 * 5. 辩论对抗：生成反面论据与弱点分析
 * 6. 共识检查：多输出一致性比对
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { ModelLibrary } from './model-library.js';

// ============ 类型定义 ============

export interface VerificationResult {
  passed: boolean;
  confidence: number;
  findings: VerificationFinding[];
  overallScore: number;
  recommendation: string;
}

export interface VerificationFinding {
  category: 'factual' | 'logical' | 'security' | 'completeness' | 'edge_case' | 'bias' | 'performance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string;
  suggestion: string;
}

export interface CodeVerificationResult {
  passed: boolean;
  bugs: CodeBug[];
  securityIssues: SecurityIssue[];
  testCases: TestCase[];
  overallScore: number;
}

export interface CodeBug {
  line?: number;
  severity: string;
  description: string;
  fix: string;
}

export interface SecurityIssue {
  type: string;
  severity: string;
  description: string;
  mitigation: string;
}

export interface TestCase {
  name: string;
  input: string;
  expectedBehavior: string;
  adversarial: boolean;
}

export interface ReasoningVerificationResult {
  passed: boolean;
  fallacies: string[];
  assumptions: string[];
  counterExamples: string[];
  score: number;
}

export interface StressTestResult {
  testCases: TestCase[];
  failurePredictions: string[];
  robustnessScore: number;
}

export interface DebateResult {
  counterArguments: string[];
  weaknesses: string[];
  strongerPosition: string;
}

export interface ConsensusResult {
  agreement: number;
  disagreements: string[];
  consensusPoints: string[];
  recommendedAnswer: string;
}

/** 验证历史记录 */
interface VerificationHistoryEntry {
  timestamp: number;
  category: string;
  passed: boolean;
  score: number;
}

// ============ 主类 ============

export class AdversarialVerifier {
  private modelLibrary: ModelLibrary | null;
  private log = logger.child({ module: 'AdversarialVerifier' });
  private history: VerificationHistoryEntry[] = [];
  private readonly maxHistory = 100;

  constructor(modelLibrary?: unknown) {
    this.modelLibrary = modelLibrary instanceof ModelLibrary ? modelLibrary : null;
    this.log.info('对抗验证系统初始化', { hasModelLibrary: !!this.modelLibrary });
  }

  // ========== 核心验证方法 ==========

  /**
   * 主验证入口：对Agent输出进行红队对抗验证
   */
  async verifyOutput(originalInput: string, agentOutput: string, context?: string): Promise<VerificationResult> {
    this.log.info('开始输出验证', { inputLength: originalInput.length, outputLength: agentOutput.length });

    const startTime = Date.now();

    try {
      let result: VerificationResult;

      if (this.modelLibrary) {
        result = await this.llmVerifyOutput(originalInput, agentOutput, context);
      } else {
        result = this.heuristicVerifyOutput(originalInput, agentOutput, context);
      }

      // 记录历史
      this.recordHistory('output', result.passed, result.overallScore);

      // 广播事件
      EventBus.getInstance().emitSync('adversarial.verification_complete', {
        type: 'verifyOutput',
        passed: result.passed,
        score: result.overallScore,
        findingsCount: result.findings.length,
        durationMs: Date.now() - startTime,
      });

      this.log.info('输出验证完成', {
        passed: result.passed,
        score: result.overallScore,
        findings: result.findings.length,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (err: unknown) {
      this.log.error('输出验证失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.recordHistory('output', false, 0);
      return {
        passed: false,
        confidence: 0,
        findings: [{
          category: 'logical',
          severity: 'high',
          description: '验证过程本身发生错误',
          evidence: (err instanceof Error ? err.message : String(err)),
          suggestion: '请重试验证或检查模型配置',
        }],
        overallScore: 0,
        recommendation: '验证失败，无法确定输出质量',
      };
    }
  }

  /**
   * 对抗性代码审查
   */
  async challengeCode(code: string, language: string): Promise<CodeVerificationResult> {
    this.log.info('开始代码对抗审查', { language, codeLength: code.length });

    const startTime = Date.now();

    try {
      let result: CodeVerificationResult;

      if (this.modelLibrary) {
        result = await this.llmChallengeCode(code, language);
      } else {
        result = this.heuristicChallengeCode(code, language);
      }

      this.recordHistory('code', result.passed, result.overallScore);

      EventBus.getInstance().emitSync('adversarial.code_review_complete', {
        passed: result.passed,
        score: result.overallScore,
        bugsCount: result.bugs.length,
        securityCount: result.securityIssues.length,
        durationMs: Date.now() - startTime,
      });

      this.log.info('代码对抗审查完成', {
        passed: result.passed,
        score: result.overallScore,
        bugs: result.bugs.length,
        securityIssues: result.securityIssues.length,
      });

      return result;
    } catch (err: unknown) {
      this.log.error('代码对抗审查失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.recordHistory('code', false, 0);
      return {
        passed: false,
        bugs: [],
        securityIssues: [],
        testCases: [],
        overallScore: 0,
      };
    }
  }

  /**
   * 验证逻辑推理
   */
  async challengeReasoning(premise: string, conclusion: string, reasoning: string): Promise<ReasoningVerificationResult> {
    this.log.info('开始推理验证');

    const startTime = Date.now();

    try {
      let result: ReasoningVerificationResult;

      if (this.modelLibrary) {
        result = await this.llmChallengeReasoning(premise, conclusion, reasoning);
      } else {
        result = this.heuristicChallengeReasoning(premise, conclusion, reasoning);
      }

      this.recordHistory('reasoning', result.passed, result.score);

      EventBus.getInstance().emitSync('adversarial.reasoning_verified', {
        passed: result.passed,
        score: result.score,
        fallaciesCount: result.fallacies.length,
        durationMs: Date.now() - startTime,
      });

      this.log.info('推理验证完成', {
        passed: result.passed,
        score: result.score,
        fallacies: result.fallacies.length,
      });

      return result;
    } catch (err: unknown) {
      this.log.error('推理验证失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.recordHistory('reasoning', false, 0);
      return {
        passed: false,
        fallacies: [],
        assumptions: [],
        counterExamples: [],
        score: 0,
      };
    }
  }

  /**
   * 压力测试：生成对抗性测试用例
   */
  async stressTest(task: string, solution: string): Promise<StressTestResult> {
    this.log.info('开始压力测试', { taskLength: task.length });

    const startTime = Date.now();

    try {
      let result: StressTestResult;

      if (this.modelLibrary) {
        result = await this.llmStressTest(task, solution);
      } else {
        result = this.heuristicStressTest(task, solution);
      }

      this.recordHistory('stress_test', result.robustnessScore >= 60, result.robustnessScore);

      EventBus.getInstance().emitSync('adversarial.stress_test_complete', {
        robustnessScore: result.robustnessScore,
        testCasesCount: result.testCases.length,
        failurePredictions: result.failurePredictions.length,
        durationMs: Date.now() - startTime,
      });

      this.log.info('压力测试完成', {
        robustnessScore: result.robustnessScore,
        testCases: result.testCases.length,
      });

      return result;
    } catch (err: unknown) {
      this.log.error('压力测试失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.recordHistory('stress_test', false, 0);
      return {
        testCases: [],
        failurePredictions: ['压力测试执行失败'],
        robustnessScore: 0,
      };
    }
  }

  /**
   * 辩论对抗：生成反面论据
   */
  async debate(topic: string, position: string): Promise<DebateResult> {
    this.log.info('开始辩论对抗', { topicLength: topic.length });

    const startTime = Date.now();

    try {
      let result: DebateResult;

      if (this.modelLibrary) {
        result = await this.llmDebate(topic, position);
      } else {
        result = this.heuristicDebate(topic, position);
      }

      EventBus.getInstance().emitSync('adversarial.debate_complete', {
        counterArgumentsCount: result.counterArguments.length,
        weaknessesCount: result.weaknesses.length,
        durationMs: Date.now() - startTime,
      });

      this.log.info('辩论对抗完成', {
        counterArguments: result.counterArguments.length,
        weaknesses: result.weaknesses.length,
      });

      return result;
    } catch (err: unknown) {
      this.log.error('辩论对抗失败', { error: (err instanceof Error ? err.message : String(err)) });
      return {
        counterArguments: [],
        weaknesses: ['辩论过程失败'],
        strongerPosition: position,
      };
    }
  }

  /**
   * 共识检查：比对多个输出的一致性
   */
  async consensusCheck(outputs: string[]): Promise<ConsensusResult> {
    this.log.info('开始共识检查', { outputsCount: outputs.length });

    const startTime = Date.now();

    if (outputs.length < 2) {
      return {
        agreement: 1,
        disagreements: [],
        consensusPoints: outputs.length === 1 ? [outputs[0].substring(0, 200)] : [],
        recommendedAnswer: outputs[0] || '',
      };
    }

    try {
      let result: ConsensusResult;

      if (this.modelLibrary) {
        result = await this.llmConsensusCheck(outputs);
      } else {
        result = this.heuristicConsensusCheck(outputs);
      }

      this.recordHistory('consensus', result.agreement >= 0.7, result.agreement * 100);

      EventBus.getInstance().emitSync('adversarial.consensus_checked', {
        agreement: result.agreement,
        disagreementsCount: result.disagreements.length,
        durationMs: Date.now() - startTime,
      });

      this.log.info('共识检查完成', {
        agreement: result.agreement,
        disagreements: result.disagreements.length,
      });

      return result;
    } catch (err: unknown) {
      this.log.error('共识检查失败', { error: (err instanceof Error ? err.message : String(err)) });
      return {
        agreement: 0,
        disagreements: ['共识检查执行失败'],
        consensusPoints: [],
        recommendedAnswer: outputs[0] || '',
      };
    }
  }

  // ========== LLM驱动的验证方法 ==========

  private async llmVerifyOutput(originalInput: string, agentOutput: string, context?: string): Promise<VerificationResult> {
    const contextSection = context ? `\n\n上下文信息:\n${context}` : '';

    const response = await this.modelLibrary!.call([
      {
        role: 'system',
        content: `你是一个红队对抗验证专家。你的职责是挑战和验证AI助手的输出，找出其中的问题。
你需要从以下维度严格审查：
1. 事实准确性：是否存在事实错误或过时信息
2. 逻辑一致性：是否存在自相矛盾或逻辑跳跃
3. 完整性：是否遗漏了重要的边界情况或例外
4. 安全性：是否存在安全漏洞或有害建议
5. 偏见：是否存在偏见或不公平的表述
6. 性能：是否存在性能问题或低效方案

请以JSON格式返回验证结果，格式如下：
{
  "passed": boolean,
  "confidence": number (0-1),
  "findings": [
    {
      "category": "factual|logical|security|completeness|edge_case|bias|performance",
      "severity": "low|medium|high|critical",
      "description": "问题描述",
      "evidence": "证据",
      "suggestion": "改进建议"
    }
  ],
  "overallScore": number (0-100),
  "recommendation": "总体建议"
}`,
      },
      {
        role: 'user',
        content: `请对以下AI输出进行红队对抗验证：

原始输入:
${originalInput}

AI输出:
${agentOutput}${contextSection}

请严格审查，找出所有潜在问题。`,
      },
    ], { temperature: 0.7 });

    return this.parseVerificationResult(response.content);
  }

  private async llmChallengeCode(code: string, language: string): Promise<CodeVerificationResult> {
    const response = await this.modelLibrary!.call([
      {
        role: 'system',
        content: `你是一个对抗性代码审查专家。你的任务是尽可能找出代码中的所有问题。
你需要：
1. 找出所有Bug（包括边界条件、空指针、类型错误等）
2. 找出所有安全漏洞（注入、XSS、权限绕过等）
3. 生成可能破坏代码的测试用例
4. 找出性能问题

请以JSON格式返回结果：
{
  "passed": boolean,
  "bugs": [{ "line": number|null, "severity": "low|medium|high|critical", "description": "描述", "fix": "修复方案" }],
  "securityIssues": [{ "type": "类型", "severity": "low|medium|high|critical", "description": "描述", "mitigation": "缓解方案" }],
  "testCases": [{ "name": "名称", "input": "输入", "expectedBehavior": "期望行为", "adversarial": boolean }],
  "overallScore": number (0-100)
}`,
      },
      {
        role: 'user',
        content: `请对以下${language}代码进行对抗性审查：

\`\`\`${language}
${code}
\`\`\`

请尽可能找出所有问题，包括隐藏的Bug和安全漏洞。`,
      },
    ], { temperature: 0.7 });

    return this.parseCodeVerificationResult(response.content);
  }

  private async llmChallengeReasoning(premise: string, conclusion: string, reasoning: string): Promise<ReasoningVerificationResult> {
    const response = await this.modelLibrary!.call([
      {
        role: 'system',
        content: `你是一个逻辑推理验证专家。你的任务是找出推理过程中的逻辑漏洞。
你需要：
1. 识别逻辑谬误（滑坡谬误、稻草人谬误、循环论证等）
2. 找出未声明的隐含假设
3. 提供可能推翻结论的反例

请以JSON格式返回结果：
{
  "passed": boolean,
  "fallacies": ["谬误1", "谬误2"],
  "assumptions": ["假设1", "假设2"],
  "counterExamples": ["反例1", "反例2"],
  "score": number (0-100)
}`,
      },
      {
        role: 'user',
        content: `请验证以下推理过程：

前提: ${premise}

推理过程: ${reasoning}

结论: ${conclusion}

请严格审查推理的每一步，找出所有逻辑问题。`,
      },
    ], { temperature: 0.7 });

    return this.parseReasoningVerificationResult(response.content);
  }

  private async llmStressTest(task: string, solution: string): Promise<StressTestResult> {
    const response = await this.modelLibrary!.call([
      {
        role: 'system',
        content: `你是一个压力测试专家。你的任务是生成尽可能多的边界用例和对抗性输入，来测试解决方案的鲁棒性。
你需要：
1. 生成边界条件测试用例
2. 生成对抗性输入（故意设计的刁钻输入）
3. 预测解决方案可能失败的场景

请以JSON格式返回结果：
{
  "testCases": [{ "name": "名称", "input": "输入", "expectedBehavior": "期望行为", "adversarial": boolean }],
  "failurePredictions": ["预测失败场景1", "预测失败场景2"],
  "robustnessScore": number (0-100)
}`,
      },
      {
        role: 'user',
        content: `请对以下解决方案进行压力测试：

任务: ${task}

解决方案: ${solution}

请生成尽可能多的对抗性测试用例。`,
      },
    ], { temperature: 0.7 });

    return this.parseStressTestResult(response.content);
  }

  private async llmDebate(topic: string, position: string): Promise<DebateResult> {
    const response = await this.modelLibrary!.call([
      {
        role: 'system',
        content: `你是一个辩论对抗专家。你的任务是站在对立面，找出给定立场的所有弱点。
你需要：
1. 生成强有力的反面论据
2. 找出原始立场的逻辑弱点
3. 提出一个更强的替代立场

请以JSON格式返回结果：
{
  "counterArguments": ["反面论据1", "反面论据2"],
  "weaknesses": ["弱点1", "弱点2"],
  "strongerPosition": "更强的立场描述"
}`,
      },
      {
        role: 'user',
        content: `请对以下立场进行辩论对抗：

主题: ${topic}

立场: ${position}

请站在对立面，尽可能找出该立场的所有弱点。`,
      },
    ], { temperature: 0.7 });

    return this.parseDebateResult(response.content);
  }

  private async llmConsensusCheck(outputs: string[]): Promise<ConsensusResult> {
    const outputsList = outputs.map((o, i) => `输出${i + 1}:\n${o}`).join('\n\n---\n\n');

    const response = await this.modelLibrary!.call([
      {
        role: 'system',
        content: `你是一个共识分析专家。你的任务是比对多个AI输出，分析它们之间的一致性和分歧。
你需要：
1. 计算一致程度（0-1）
2. 找出所有分歧点
3. 找出所有共识点
4. 给出推荐答案

请以JSON格式返回结果：
{
  "agreement": number (0-1),
  "disagreements": ["分歧1", "分歧2"],
  "consensusPoints": ["共识1", "共识2"],
  "recommendedAnswer": "推荐答案"
}`,
      },
      {
        role: 'user',
        content: `请比对以下多个输出，分析共识与分歧：

${outputsList}

请详细分析各输出之间的一致性和分歧。`,
      },
    ], { temperature: 0.7 });

    return this.parseConsensusResult(response.content);
  }

  // ========== 启发式验证方法（无LLM时的降级方案） ==========

  private heuristicVerifyOutput(originalInput: string, agentOutput: string, _context?: string): VerificationResult {
    const findings: VerificationFinding[] = [];
    let score = 100;

    // 检查输出是否为空或过短
    if (!agentOutput || agentOutput.trim().length === 0) {
      findings.push({
        category: 'completeness',
        severity: 'critical',
        description: '输出为空',
        evidence: 'Agent输出为空字符串',
        suggestion: '需要生成有内容的输出',
      });
      score -= 50;
    } else if (agentOutput.trim().length < 20) {
      findings.push({
        category: 'completeness',
        severity: 'high',
        description: '输出过短，可能不完整',
        evidence: `输出仅${agentOutput.trim().length}个字符`,
        suggestion: '考虑提供更详细的回答',
      });
      score -= 20;
    }

    // 检查是否包含不确定表述
    const uncertaintyPatterns = /(?:我不确定|可能|也许|大概|似乎|不确定|maybe|perhaps|possibly)/gi;
    const uncertaintyMatches = agentOutput.match(uncertaintyPatterns);
    if (uncertaintyMatches && uncertaintyMatches.length > 3) {
      findings.push({
        category: 'factual',
        severity: 'medium',
        description: '输出中包含过多不确定表述',
        evidence: `发现${uncertaintyMatches.length}处不确定表述`,
        suggestion: '减少不确定表述，提供更确定的回答',
      });
      score -= 10;
    }

    // 检查是否包含常见错误模式
    const errorPatterns = [
      { pattern: /undefined|null|NaN/gi, desc: '包含技术性错误值', category: 'logical' as const },
      { pattern: /TODO|FIXME|HACK|XXX/gi, desc: '包含未完成的标记', category: 'completeness' as const },
    ];
    for (const { pattern, desc, category } of errorPatterns) {
      if (pattern.test(agentOutput)) {
        findings.push({
          category,
          severity: 'medium',
          description: desc,
          evidence: `匹配到模式: ${pattern.source}`,
          suggestion: '修复或移除相关内容',
        });
        score -= 10;
      }
    }

    // 检查输入与输出的相关性（简单关键词匹配）
    if (originalInput.length > 0 && agentOutput.length > 0) {
      const inputWords = new Set(originalInput.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const outputLower = agentOutput.toLowerCase();
      const overlap = Array.from(inputWords).filter(w => outputLower.includes(w));
      if (inputWords.size > 3 && overlap.length / inputWords.size < 0.1) {
        findings.push({
          category: 'logical',
          severity: 'high',
          description: '输出可能与输入不相关',
          evidence: `输入关键词覆盖率仅${(overlap.length / inputWords.size * 100).toFixed(0)}%`,
          suggestion: '确保输出与原始输入相关',
        });
        score -= 20;
      }
    }

    // 检查安全相关关键词
    const securityPatterns = [
      { pattern: /password\s*[:=]\s*['"][^'"]+['"]/gi, desc: '可能包含明文密码' },
      { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi, desc: '可能包含API密钥' },
      { pattern: /eval\s*\(/gi, desc: '使用了eval函数，可能存在代码注入风险' },
    ];
    for (const { pattern, desc } of securityPatterns) {
      if (pattern.test(agentOutput)) {
        findings.push({
          category: 'security',
          severity: 'critical',
          description: desc,
          evidence: `匹配到安全风险模式: ${pattern.source}`,
          suggestion: '移除敏感信息或使用安全的替代方案',
        });
        score -= 30;
      }
    }

    // ========== P0 D3.2 强化：真实事实/逻辑核查（无 LLM 时的降级方案）==========

    // 1. 数字一致性检查：输出中出现的"权威"具体数字（百分比/年月日/大额数字）
    //    若未在输入中出现，可能是幻觉。仅检查陈述性数字，跳过明显是计算结果的部分。
    score -= this.checkNumericHallucination(originalInput, agentOutput, findings);

    // 2. 逻辑矛盾检测：同一陈述的正反两面同时出现
    score -= this.checkLogicalContradictions(originalInput, agentOutput, findings);

    // 3. 代码语法基础检查：代码块中括号/引号配平
    score -= this.checkCodeSyntaxBasics(originalInput, agentOutput, findings);

    // 4. 引用来源验证：输出声称"根据X"但 X 未在输入中出现
    score -= this.checkUnsupportedCitations(originalInput, agentOutput, findings);

    // 5. 自相矛盾数字：同一实体在输出中出现不同数字
    score -= this.checkSelfContradictoryNumbers(originalInput, agentOutput, findings);

    // 6. 翻译/复述一致性：输出含"原文是X"但输入未出现 X
    score -= this.checkUnsupportedQuotations(originalInput, agentOutput, findings);

    score = Math.max(0, Math.min(100, score));
    const passed = score >= 60;

    // P0 D3.2：置信度根据 finding 数量和严重度动态计算，而非固定 0.5
    // 基础 0.5，每个 finding 按严重度扣减，critical 额外扣减
    const severityWeight: Record<VerificationFinding['severity'], number> = {
      low: 0.03, medium: 0.06, high: 0.10, critical: 0.18,
    };
    let confidence = 0.65;
    for (const f of findings) {
      confidence -= severityWeight[f.severity];
    }
    confidence = Math.max(0.1, Math.min(0.9, confidence));

    return {
      passed,
      confidence,
      findings,
      overallScore: score,
      recommendation: passed
        ? '输出基本合格，但建议关注发现的问题'
        : '输出未通过验证，需要修正发现的问题',
    };
  }

  // ========== P0 D3.2 强化：启发式事实核查辅助方法 ==========

  /**
   * 1. 数字幻觉检测
   * 提取输出中的"权威"具体数字（百分比、年月日、>1000 的整数），
   * 检查是否在输入中出现。未出现的具体数字可能是幻觉。
   * 跳过明显的计算结果（如括号内算式、表格中的派生值）。
   */
  private checkNumericHallucination(originalInput: string, agentOutput: string, findings: VerificationFinding[]): number {
    if (!originalInput || !agentOutput) return 0;
    let penalty = 0;
    const inputLower = originalInput.toLowerCase();

    // 提取百分比（如 "85%"、"99.9%"）
    const percentages = agentOutput.match(/(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)\s*%/g) || [];
    // 提取年月日（如 "2024年"、"2024-01-15"、"1990年代"）
    const dates = agentOutput.match(/\b(?:19|20)\d{2}(?:[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?)?/g) || [];
    // 提取大整数（>1000，排除行号、版本号、时间戳）
    const bigNumbers = agentOutput.match(/(?:^|[^\d.])(\d{4,})/g) || [];

    const hallucinatedNumbers: string[] = [];
    for (const raw of [...percentages, ...dates, ...bigNumbers]) {
      const num = raw.replace(/^[^\d.]*/, '').trim();
      if (!num || num.length < 2) continue;
      // 跳过常见非事实数字（版本号如 2024.1、时间戳、端口、行号引用）
      if (/^\d{1,2}\.\d{1,2}$/.test(num)) continue;          // 版本号
      if (/^\d{5,}$/.test(num) && !inputLower.includes(num)) {
        // 5位以上纯数字，可能是内存地址/ID，仅在输入完全无此数字时标记
      }
      // 输入中若包含该数字则视为有据
      if (!inputLower.includes(num.toLowerCase())) {
        // 排除：输出中明确标注为"计算/估算/大约"的数字
        const ctx = agentOutput.toLowerCase();
        const idx = ctx.indexOf(num.toLowerCase());
        if (idx >= 0) {
          const around = ctx.slice(Math.max(0, idx - 15), idx + num.length + 15);
          if (/大约|约|估算|计算|预计|假设|例|对/.test(around)) continue;
        }
        hallucinatedNumbers.push(num);
      }
    }

    if (hallucinatedNumbers.length > 0) {
      const unique = Array.from(new Set(hallucinatedNumbers)).slice(0, 5);
      findings.push({
        category: 'factual',
        severity: hallucinatedNumbers.length >= 3 ? 'high' : 'medium',
        description: '输出中包含输入未提供的具体数字，可能是幻觉',
        evidence: `未在输入中出现的数字: ${unique.join(', ')}`,
        suggestion: '核实这些数字的来源，或明确标注为估算/示例',
      });
      penalty = hallucinatedNumbers.length >= 3 ? 18 : 10;
    }
    return penalty;
  }

  /**
   * 2. 逻辑矛盾检测
   * 检测同一陈述的正反两面同时出现（如"X 是 Y"和"X 不是 Y"）。
   * 使用简单的模式匹配，避免误判反问/否定语境。
   */
  private checkLogicalContradictions(_originalInput: string, agentOutput: string, findings: VerificationFinding[]): number {
    if (!agentOutput) return 0;
    let penalty = 0;
    const contradictions: string[] = [];

    // 模式：中文"X是Y" vs "X不是Y" / "X不是Y" vs "X是Y"
    const isNotPatterns = [
      /([^\s，。；,!?]{2,20})\s*不是\s*([^\s，。；,!?]{2,20})/g,
      /([^\s，。；,!?]{2,20})\s*is\s+not\s+([^\s，。；,!?]{2,20})/gi,
    ];
    const isPatterns = [
      /([^\s，。；,!?]{2,20})\s*是\s*([^\s，。；,!?]{2,20})/g,
      /([^\s，。；,!?]{2,20})\s*is\s+([^\s，。；,!?]{2,20})/gi,
    ];

    const negPairs: Array<[string, string]> = [];
    for (const p of isNotPatterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(agentOutput)) !== null) {
        negPairs.push([m[1], m[2]]);
      }
    }
    const posPairs: Array<[string, string]> = [];
    for (const p of isPatterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(agentOutput)) !== null) {
        posPairs.push([m[1], m[2]]);
      }
    }

    for (const [a, b] of negPairs) {
      for (const [c, d] of posPairs) {
        if (a === c && b === d) {
          contradictions.push(`${a}是${b} vs ${a}不是${b}`);
        }
      }
    }

    if (contradictions.length > 0) {
      findings.push({
        category: 'logical',
        severity: 'high',
        description: '输出中存在正反矛盾陈述',
        evidence: contradictions.slice(0, 3).join('; '),
        suggestion: '消除矛盾，明确陈述的真实性',
      });
      penalty = 20;
    }
    return penalty;
  }

  /**
   * 3. 代码语法基础检查
   * 提取 ```代码块，检查括号/引号是否配平。
   * 仅检测明显的不平衡，避免误判含字符串的代码。
   */
  private checkCodeSyntaxBasics(_originalInput: string, agentOutput: string, findings: VerificationFinding[]): number {
    if (!agentOutput) return 0;
    let penalty = 0;
    const codeBlockPattern = /```(?:\w+)?\n([\s\S]*?)```/g;
    const codeBlocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = codeBlockPattern.exec(agentOutput)) !== null) {
      codeBlocks.push(m[1]);
    }

    const imbalanced: string[] = [];
    for (let i = 0; i < codeBlocks.length; i++) {
      const code = codeBlocks[i];
      // 计算三类括号的配平（忽略字符串内的，简单近似：去除引号内内容）
      const stripped = code
        .replace(/'[^']*'/g, '')
        .replace(/"[^"]*"/g, '')
        .replace(/`[^`]*`/g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
      for (const [open, close] of pairs) {
        const openCount = (stripped.match(new RegExp('\\' + open, 'g')) || []).length;
        const closeCount = (stripped.match(new RegExp('\\' + close, 'g')) || []).length;
        if (openCount !== closeCount) {
          imbalanced.push(`代码块${i + 1}: ${open}${close} 配平 ${openCount} vs ${closeCount}`);
        }
      }
    }

    if (imbalanced.length > 0) {
      findings.push({
        category: 'logical',
        severity: 'medium',
        description: '代码块存在括号不配平',
        evidence: imbalanced.slice(0, 3).join('; '),
        suggestion: '检查代码块的括号闭合',
      });
      penalty = 12;
    }
    return penalty;
  }

  /**
   * 4. 引用来源验证
   * 输出声称"根据X" / "according to X" / "X 显示"，但 X 未在输入中出现。
   * 仅检查明确的引用标记，避免误判。
   */
  private checkUnsupportedCitations(originalInput: string, agentOutput: string, findings: VerificationFinding[]): number {
    if (!originalInput || !agentOutput) return 0;
    let penalty = 0;
    const inputLower = originalInput.toLowerCase();
    const unsupported: string[] = [];

    const citationPatterns = [
      /根据\s*([^，。；,!?\s]{2,30})/g,
      /according\s+to\s+([^,.;!?\s]{2,30})/gi,
      /依据\s*([^，。；,!?\s]{2,30})/g,
    ];

    for (const p of citationPatterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(agentOutput)) !== null) {
        const source = m[1].toLowerCase();
        // 跳过代词类（"根据上述" / "根据输入" 等）
        if (/上述|上文|输入|前面|above|previous|input|context/.test(source)) continue;
        // 检查输入是否提及该来源（部分匹配）
        const sourceKey = source.slice(0, 6);
        if (!inputLower.includes(sourceKey)) {
          unsupported.push(m[1]);
        }
      }
    }

    if (unsupported.length > 0) {
      const unique = Array.from(new Set(unsupported)).slice(0, 3);
      findings.push({
        category: 'factual',
        severity: 'medium',
        description: '输出引用了输入未提及的来源',
        evidence: `未在输入中出现的来源: ${unique.join(', ')}`,
        suggestion: '确认引用来源是否可靠，或移除无据引用',
      });
      penalty = 10;
    }
    return penalty;
  }

  /**
   * 5. 自相矛盾数字检测
   * 同一实体在输出中出现不同数字（如"延迟 50ms" 和 "延迟 100ms"）。
   * 通过提取"X 是 N 单位"模式的配对来检测。
   */
  private checkSelfContradictoryNumbers(_originalInput: string, agentOutput: string, findings: VerificationFinding[]): number {
    if (!agentOutput) return 0;
    let penalty = 0;

    // 模式：捕获"实体 + 数字 + 单位"
    const entityNumPattern = /([^\s，。；,!?]{2,15})\s*[是为]?\s*(\d+(?:\.\d+)?)\s*(ms|秒|秒级|分钟|小时|%|百分比|倍|次|个|MB|GB|KB|字节)/gi;
    const claims: Map<string, Array<{ num: string; unit: string }>> = new Map();
    let m: RegExpExecArray | null;
    while ((m = entityNumPattern.exec(agentOutput)) !== null) {
      const entity = m[1].toLowerCase();
      const num = m[2];
      const unit = m[3].toLowerCase();
      if (!claims.has(entity)) claims.set(entity, []);
      claims.get(entity)!.push({ num, unit });
    }

    const contradictions: string[] = [];
    for (const [entity, values] of claims) {
      // 同一实体、同单位、不同数字
      const byUnit = new Map<string, Set<string>>();
      for (const v of values) {
        if (!byUnit.has(v.unit)) byUnit.set(v.unit, new Set());
        byUnit.get(v.unit)!.add(v.num);
      }
      for (const [unit, nums] of byUnit) {
        if (nums.size > 1) {
          contradictions.push(`${entity}: ${Array.from(nums).join('/')} ${unit}`);
        }
      }
    }

    if (contradictions.length > 0) {
      findings.push({
        category: 'factual',
        severity: 'high',
        description: '输出中对同一指标给出不同数值',
        evidence: contradictions.slice(0, 3).join('; '),
        suggestion: '统一同一指标的数值',
      });
      penalty = 18;
    }
    return penalty;
  }

  /**
   * 6. 无据引文检测
   * 输出含"原文是X" / "原文说X" / "quote: X" 但 X 未在输入中出现。
   */
  private checkUnsupportedQuotations(originalInput: string, agentOutput: string, findings: VerificationFinding[]): number {
    if (!originalInput || !agentOutput) return 0;
    let penalty = 0;
    const inputLower = originalInput.toLowerCase();
    const unsupported: string[] = [];

    const quotePatterns = [
      /原文[是为：:]\s*"([^"]{5,80})"/g,
      /原文[是为：:]\s*'([^']{5,80})'/g,
      /原文[是为：:]\s*「([^」]{5,80})」/g,
      /quote[d]?\s*[:：]\s*"([^"]{5,80})"/gi,
    ];

    for (const p of quotePatterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(agentOutput)) !== null) {
        const quoted = m[1].toLowerCase();
        // 检查输入是否包含引文（允许部分匹配，取前 10 字符）
        const key = quoted.slice(0, 10);
        if (!inputLower.includes(key)) {
          unsupported.push(m[1]);
        }
      }
    }

    if (unsupported.length > 0) {
      findings.push({
        category: 'factual',
        severity: 'medium',
        description: '输出引用了输入中不存在的原文',
        evidence: `无据引文: ${unsupported.slice(0, 2).join('; ')}`,
        suggestion: '核实引文来源，或明确标注为转述',
      });
      penalty = 12;
    }
    return penalty;
  }

  private heuristicChallengeCode(code: string, _language: string): CodeVerificationResult {
    const bugs: CodeBug[] = [];
    const securityIssues: SecurityIssue[] = [];
    const testCases: TestCase[] = [];
    let score = 100;

    // 常见Bug模式检测
    const bugPatterns = [
      { pattern: /==\s*null\b/g, desc: '使用==而非===比较null', fix: '使用===进行严格比较', severity: 'low' },
      { pattern: /catch\s*\(\s*\w+\s*\)\s*\{\s*\}/g, desc: '空catch块，可能吞没异常', fix: '在catch块中添加错误处理逻辑', severity: 'medium' },
      { pattern: /\.then\s*\(/g, desc: '使用.then而非async/await', fix: '考虑使用async/await提高可读性', severity: 'low' },
      { pattern: /console\.log/g, desc: '包含console.info调试代码', fix: '移除或替换为正式日志', severity: 'low' },
      { pattern: /any\b/g, desc: '使用any类型，缺乏类型安全', fix: '使用具体类型替代any', severity: 'medium' },
    ];

    for (const { pattern, desc, fix, severity } of bugPatterns) {
      const matches = code.match(pattern);
      if (matches) {
        const lineNum = this.findLineNumber(code, pattern);
        bugs.push({ line: lineNum, severity, description: desc, fix });
        score -= severity === 'medium' ? 10 : 5;
      }
    }

    // 安全漏洞检测
    const secPatterns = [
      { pattern: /eval\s*\(/g, type: '代码注入', desc: '使用eval可能导致代码注入', mitigation: '使用安全的替代方案如JSON.parse', severity: 'critical' },
      { pattern: /innerHTML/g, type: 'XSS', desc: '使用innerHTML可能导致XSS攻击', mitigation: '使用textContent或DOMPurify', severity: 'high' },
      { pattern: /exec\s*\(/g, type: '命令注入', desc: '使用exec可能导致命令注入', mitigation: '使用参数化调用或输入验证', severity: 'critical' },
      { pattern: /SELECT\s+.*\s+FROM\s+/gi, type: 'SQL注入', desc: '可能存在SQL拼接', mitigation: '使用参数化查询', severity: 'high' },
    ];

    for (const { pattern, type, desc, mitigation, severity } of secPatterns) {
      if (pattern.test(code)) {
        securityIssues.push({ type, severity, description: desc, mitigation });
        score -= severity === 'critical' ? 30 : 20;
      }
    }

    // 生成基础测试用例
    testCases.push(
      { name: '空输入测试', input: 'null/undefined/空字符串', expectedBehavior: '应优雅处理空输入', adversarial: true },
      { name: '超长输入测试', input: '超长字符串或大数组', expectedBehavior: '不应内存溢出或超时', adversarial: true },
      { name: '特殊字符测试', input: '包含特殊字符的输入', expectedBehavior: '应正确处理特殊字符', adversarial: true },
      { name: '并发调用测试', input: '多线程/并发调用', expectedBehavior: '应线程安全', adversarial: false },
    );

    score = Math.max(0, Math.min(100, score));
    return {
      passed: score >= 60,
      bugs,
      securityIssues,
      testCases,
      overallScore: score,
    };
  }

  private heuristicChallengeReasoning(premise: string, conclusion: string, reasoning: string): ReasoningVerificationResult {
    const fallacies: string[] = [];
    const assumptions: string[] = [];
    const counterExamples: string[] = [];
    let score = 100;

    // 检测常见逻辑谬误模式
    const fallacyPatterns = [
      { pattern: /因此.*因此/g, name: '循环论证：推理链中存在循环' },
      { pattern: /一定|必然|绝对/g, name: '绝对化谬误：过度断言确定性' },
      { pattern: /所有人都|没有人|总是|从不/g, name: '过度概括：以偏概全' },
      { pattern: /如果.*那么.*如果/g, name: '滑坡谬误：连锁推理可能不成立' },
    ];

    for (const { pattern, name } of fallacyPatterns) {
      if (pattern.test(reasoning)) {
        fallacies.push(name);
        score -= 15;
      }
    }

    // 检测隐含假设
    if (reasoning.includes('因为') && !reasoning.includes('假设')) {
      assumptions.push('推理中存在未声明的隐含假设');
      score -= 10;
    }

    if (premise.includes('所有') && conclusion.includes('一定')) {
      assumptions.push('从"所有"推导"一定"可能依赖未验证的全称命题');
      score -= 10;
    }

    // 生成反例提示
    if (conclusion.includes('所有') || conclusion.includes('总是')) {
      counterExamples.push('寻找一个反例即可推翻全称结论');
      score -= 10;
    }

    if (reasoning.length < 20) {
      fallacies.push('推理过程过于简短，可能存在跳跃');
      score -= 20;
    }

    score = Math.max(0, Math.min(100, score));
    return {
      passed: score >= 60,
      fallacies,
      assumptions,
      counterExamples,
      score,
    };
  }

  private heuristicStressTest(task: string, solution: string): StressTestResult {
    const testCases: TestCase[] = [];
    const failurePredictions: string[] = [];

    // 生成通用边界测试用例
    testCases.push(
      { name: '空输入', input: '空值或null', expectedBehavior: '应优雅处理', adversarial: true },
      { name: '极大输入', input: '超出正常范围的大值', expectedBehavior: '不应崩溃或超时', adversarial: true },
      { name: '极小输入', input: '超出正常范围的小值', expectedBehavior: '应正确处理边界', adversarial: true },
      { name: '非法格式输入', input: '格式不符合预期的输入', expectedBehavior: '应给出有意义的错误提示', adversarial: true },
      { name: '并发场景', input: '多用户同时操作', expectedBehavior: '应保持数据一致性', adversarial: false },
    );

    // 根据任务内容生成特定预测
    if (solution.includes('sort') || solution.includes('排序')) {
      testCases.push(
        { name: '已排序输入', input: '已排序的数组', expectedBehavior: '应正确处理', adversarial: false },
        { name: '逆序输入', input: '逆序排列的数组', expectedBehavior: '应正确排序', adversarial: true },
        { name: '重复元素', input: '所有元素相同的数组', expectedBehavior: '应正确处理', adversarial: true },
      );
      failurePredictions.push('排序算法可能在极端数据分布下性能退化');
    }

    if (solution.includes('fetch') || solution.includes('http') || solution.includes('api')) {
      testCases.push(
        { name: '网络超时', input: '请求超时场景', expectedBehavior: '应有超时处理和重试机制', adversarial: true },
        { name: '服务端错误', input: '5xx错误响应', expectedBehavior: '应优雅处理服务端错误', adversarial: true },
      );
      failurePredictions.push('网络请求可能缺少超时和错误处理');
    }

    failurePredictions.push('解决方案可能未考虑所有边界条件');
    failurePredictions.push('极端输入可能导致性能问题');

    // 简单鲁棒性评分
    let robustnessScore = 70;
    if (solution.includes('try') || solution.includes('catch') || solution.includes('error')) {
      robustnessScore += 10;
    }
    if (solution.includes('null') || solution.includes('undefined')) {
      robustnessScore += 5;
    }
    if (solution.length < 50) {
      robustnessScore -= 15;
    }

    return {
      testCases,
      failurePredictions,
      robustnessScore: Math.max(0, Math.min(100, robustnessScore)),
    };
  }

  private heuristicDebate(topic: string, position: string): DebateResult {
    const counterArguments: string[] = [];
    const weaknesses: string[] = [];

    // 基于立场长度和内容生成基础对抗
    if (position.length < 30) {
      weaknesses.push('立场表述过于简短，缺乏充分论证');
    }

    // 检测绝对化表述
    if (/一定|必然|绝对|肯定|毫无疑问/.test(position)) {
      counterArguments.push('绝对化的表述通常忽略了例外情况');
      weaknesses.push('过度断言确定性，缺乏对例外情况的考虑');
    }

    // 检测因果推理
    if (/因为.*所以|由于.*因此/.test(position)) {
      counterArguments.push('因果关系可能不成立，相关不等于因果');
      weaknesses.push('因果推理可能存在混淆变量');
    }

    // 检测以偏概全
    if (/所有|每个|任何|总是|从不/.test(position)) {
      counterArguments.push('全称命题容易被单一反例推翻');
      weaknesses.push('以偏概全，忽略了个体差异');
    }

    // 默认对抗论据
    if (counterArguments.length === 0) {
      counterArguments.push('该立场可能忽略了替代解释');
      counterArguments.push('现有证据可能不足以充分支持该立场');
    }

    if (weaknesses.length === 0) {
      weaknesses.push('立场可能需要更多证据支撑');
    }

    return {
      counterArguments,
      weaknesses,
      strongerPosition: `在"${topic}"上，更审慎的立场应考虑更多证据和例外情况，避免过度概括`,
    };
  }

  private heuristicConsensusCheck(outputs: string[]): ConsensusResult {
    if (outputs.length < 2) {
      return {
        agreement: 1,
        disagreements: [],
        consensusPoints: outputs.length === 1 ? [outputs[0].substring(0, 200)] : [],
        recommendedAnswer: outputs[0] || '',
      };
    }

    // 简单的词汇重叠度计算
    const wordSets = outputs.map(o =>
      new Set(o.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    );

    let totalOverlap = 0;
    let comparisons = 0;
    for (let i = 0; i < wordSets.length; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const intersection = Array.from(wordSets[i]).filter(w => wordSets[j].has(w));
        const unionWords = Array.from(wordSets[i]);
        for (const w of wordSets[j]) {
          if (!wordSets[i].has(w)) unionWords.push(w);
        }
        totalOverlap += unionWords.length > 0 ? intersection.length / unionWords.length : 0;
        comparisons++;
      }
    }

    const agreement = comparisons > 0 ? totalOverlap / comparisons : 0;

    // 找出共识关键词
    const allWords = wordSets.flatMap(s => Array.from(s));
    const wordFreq = new Map<string, number>();
    for (const w of allWords) {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
    const consensusPoints = Array.from(wordFreq.entries())
      .filter(([, freq]) => freq >= outputs.length * 0.5)
      .map(([word]) => word)
      .slice(0, 10);

    const disagreements: string[] = [];
    if (agreement < 0.7) {
      disagreements.push('各输出之间的一致性较低');
    }
    if (agreement < 0.3) {
      disagreements.push('各输出存在显著分歧');
    }

    // 选择最长的输出作为推荐答案
    const recommendedAnswer = outputs.reduce((a, b) => a.length >= b.length ? a : b, '');

    return {
      agreement: Math.round(agreement * 100) / 100,
      disagreements,
      consensusPoints,
      recommendedAnswer: recommendedAnswer.substring(0, 500),
    };
  }

  // ========== JSON解析辅助方法 ==========

  private parseVerificationResult(content: string): VerificationResult {
    try {
      const json = this.extractJSON(content);
      const parsed = JSON.parse(json);
      return {
        passed: !!parsed.passed,
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
        findings: Array.isArray(parsed.findings)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? parsed.findings.map((f: any) => ({
              category: this.validateCategory(f.category),
              severity: this.validateSeverity(f.severity),
              description: String(f.description || ''),
              evidence: String(f.evidence || ''),
              suggestion: String(f.suggestion || ''),
            }))
          : [],
        overallScore: typeof parsed.overallScore === 'number' ? Math.max(0, Math.min(100, parsed.overallScore)) : 50,
        recommendation: String(parsed.recommendation || ''),
      };
    } catch {
      this.log.warn('解析验证结果JSON失败，使用降级结果');
      return {
        passed: false,
        confidence: 0.3,
        findings: [],
        overallScore: 50,
        recommendation: '验证结果解析失败，建议重新验证',
      };
    }
  }

  private parseCodeVerificationResult(content: string): CodeVerificationResult {
    try {
      const json = this.extractJSON(content);
      const parsed = JSON.parse(json);
      return {
        passed: !!parsed.passed,
        bugs: Array.isArray(parsed.bugs)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? parsed.bugs.map((b: any) => ({
              line: typeof b.line === 'number' ? b.line : undefined,
              severity: String(b.severity || 'medium'),
              description: String(b.description || ''),
              fix: String(b.fix || ''),
            }))
          : [],
        securityIssues: Array.isArray(parsed.securityIssues)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? parsed.securityIssues.map((s: any) => ({
              type: String(s.type || ''),
              severity: String(s.severity || 'medium'),
              description: String(s.description || ''),
              mitigation: String(s.mitigation || ''),
            }))
          : [],
        testCases: Array.isArray(parsed.testCases)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? parsed.testCases.map((t: any) => ({
              name: String(t.name || ''),
              input: String(t.input || ''),
              expectedBehavior: String(t.expectedBehavior || ''),
              adversarial: !!t.adversarial,
            }))
          : [],
        overallScore: typeof parsed.overallScore === 'number' ? Math.max(0, Math.min(100, parsed.overallScore)) : 50,
      };
    } catch {
      this.log.warn('解析代码验证结果JSON失败');
      return { passed: false, bugs: [], securityIssues: [], testCases: [], overallScore: 50 };
    }
  }

  private parseReasoningVerificationResult(content: string): ReasoningVerificationResult {
    try {
      const json = this.extractJSON(content);
      const parsed = JSON.parse(json);
      return {
        passed: !!parsed.passed,
        fallacies: Array.isArray(parsed.fallacies) ? parsed.fallacies.map(String) : [],
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String) : [],
        counterExamples: Array.isArray(parsed.counterExamples) ? parsed.counterExamples.map(String) : [],
        score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 50,
      };
    } catch {
      this.log.warn('解析推理验证结果JSON失败');
      return { passed: false, fallacies: [], assumptions: [], counterExamples: [], score: 50 };
    }
  }

  private parseStressTestResult(content: string): StressTestResult {
    try {
      const json = this.extractJSON(content);
      const parsed = JSON.parse(json);
      return {
        testCases: Array.isArray(parsed.testCases)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? parsed.testCases.map((t: any) => ({
              name: String(t.name || ''),
              input: String(t.input || ''),
              expectedBehavior: String(t.expectedBehavior || ''),
              adversarial: !!t.adversarial,
            }))
          : [],
        failurePredictions: Array.isArray(parsed.failurePredictions) ? parsed.failurePredictions.map(String) : [],
        robustnessScore: typeof parsed.robustnessScore === 'number' ? Math.max(0, Math.min(100, parsed.robustnessScore)) : 50,
      };
    } catch {
      this.log.warn('解析压力测试结果JSON失败');
      return { testCases: [], failurePredictions: [], robustnessScore: 50 };
    }
  }

  private parseDebateResult(content: string): DebateResult {
    try {
      const json = this.extractJSON(content);
      const parsed = JSON.parse(json);
      return {
        counterArguments: Array.isArray(parsed.counterArguments) ? parsed.counterArguments.map(String) : [],
        weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map(String) : [],
        strongerPosition: String(parsed.strongerPosition || ''),
      };
    } catch {
      this.log.warn('解析辩论结果JSON失败');
      return { counterArguments: [], weaknesses: [], strongerPosition: '' };
    }
  }

  private parseConsensusResult(content: string): ConsensusResult {
    try {
      const json = this.extractJSON(content);
      const parsed = JSON.parse(json);
      return {
        agreement: typeof parsed.agreement === 'number' ? Math.max(0, Math.min(1, parsed.agreement)) : 0.5,
        disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements.map(String) : [],
        consensusPoints: Array.isArray(parsed.consensusPoints) ? parsed.consensusPoints.map(String) : [],
        recommendedAnswer: String(parsed.recommendedAnswer || ''),
      };
    } catch {
      this.log.warn('解析共识结果JSON失败');
      return { agreement: 0.5, disagreements: [], consensusPoints: [], recommendedAnswer: '' };
    }
  }

  /** 从LLM输出中提取JSON（支持markdown代码块包裹） */
  private extractJSON(content: string): string {
    // 尝试提取markdown代码块中的JSON
    const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // 尝试提取花括号包裹的JSON
    const braceMatch = content.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      return braceMatch[0];
    }

    return content;
  }

  private validateCategory(category: string): VerificationFinding['category'] {
    const valid: VerificationFinding['category'][] = ['factual', 'logical', 'security', 'completeness', 'edge_case', 'bias', 'performance'];
    return valid.includes(category as VerificationFinding['category']) ? category as VerificationFinding['category'] : 'logical';
  }

  private validateSeverity(severity: string): VerificationFinding['severity'] {
    const valid: VerificationFinding['severity'][] = ['low', 'medium', 'high', 'critical'];
    return valid.includes(severity as VerificationFinding['severity']) ? severity as VerificationFinding['severity'] : 'medium';
  }

  /** 查找模式在代码中的行号 */
  private findLineNumber(code: string, pattern: RegExp): number | undefined {
    const match = code.match(pattern);
    if (!match || match.index === undefined) return undefined;
    return code.substring(0, match.index).split('\n').length;
  }

  // ========== 历史记录与统计 ==========

  private recordHistory(category: string, passed: boolean, score: number): void {
    this.history.push({ timestamp: Date.now(), category, passed, score });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  /**
   * 获取验证统计信息
   */
  getStats(): string {
    if (this.history.length === 0) {
      return '📊 对抗验证统计: 暂无验证记录';
    }

    const total = this.history.length;
    const passed = this.history.filter(h => h.passed).length;
    const passRate = ((passed / total) * 100).toFixed(1);
    const avgScore = (this.history.reduce((s, h) => s + h.score, 0) / total).toFixed(1);

    // 按类别统计
    const categories = new Map<string, { total: number; passed: number; avgScore: number }>();
    for (const h of this.history) {
      const cat = categories.get(h.category) || { total: 0, passed: 0, avgScore: 0 };
      cat.total++;
      if (h.passed) cat.passed++;
      cat.avgScore += h.score;
      categories.set(h.category, cat);
    }

    const categoryStats = Array.from(categories.entries())
      .map(([name, stat]) => {
        const rate = ((stat.passed / stat.total) * 100).toFixed(0);
        const avg = (stat.avgScore / stat.total).toFixed(0);
        return `  ${name}: ${stat.total}次, 通过率${rate}%, 平均分${avg}`;
      })
      .join('\n');

    return [
      `📊 对抗验证统计`,
      `总验证次数: ${total}`,
      `总通过率: ${passRate}%`,
      `平均分数: ${avgScore}`,
      `LLM模式: ${this.modelLibrary ? '启用' : '降级(启发式)'}`,
      ``,
      `按类别统计:`,
      categoryStats,
    ].join('\n');
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const verifier = this;

    return [
      {
        name: 'verify_output',
        description: '通过红队对抗验证Agent输出质量。检查事实错误、逻辑矛盾、安全漏洞、遗漏边界等。返回验证结果与改进建议。',
        parameters: {
          original_input: { type: 'string', description: '原始用户输入', required: true },
          agent_output: { type: 'string', description: '待验证的Agent输出', required: true },
          context: { type: 'string', description: '可选的上下文信息', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await verifier.verifyOutput(
              args.original_input as string,
              args.agent_output as string,
              args.context as string | undefined,
            );
            const findingsSummary = result.findings.length > 0
              ? result.findings.map(f =>
                  `  [${f.severity}][${f.category}] ${f.description}\n    建议: ${f.suggestion}`
                ).join('\n')
              : '  未发现问题';
            return [
              `验证结果: ${result.passed ? '✅ 通过' : '❌ 未通过'}`,
              `置信度: ${(result.confidence * 100).toFixed(0)}%`,
              `总分: ${result.overallScore}/100`,
              ``,
              `发现的问题:`,
              findingsSummary,
              ``,
              `建议: ${result.recommendation}`,
            ].join('\n');
          } catch (err: unknown) {
            return `输出验证失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'verify_code',
        description: '对抗性代码审查：发现Bug、安全漏洞、性能问题，并生成破坏性测试用例。',
        parameters: {
          code: { type: 'string', description: '待审查的代码', required: true },
          language: { type: 'string', description: '编程语言（如typescript, python, java等）', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await verifier.challengeCode(
              args.code as string,
              args.language as string,
            );
            const bugsSummary = result.bugs.length > 0
              ? result.bugs.map(b => `  [${b.severity}] ${b.description}${b.line ? ` (行${b.line})` : ''} → 修复: ${b.fix}`)
                .join('\n')
              : '  未发现Bug';
            const secSummary = result.securityIssues.length > 0
              ? result.securityIssues.map(s => `  [${s.severity}][${s.type}] ${s.description} → 缓解: ${s.mitigation}`)
                .join('\n')
              : '  未发现安全问题';
            const testsSummary = result.testCases.length > 0
              ? result.testCases.map(t => `  ${t.adversarial ? '🔴' : '🟢'} ${t.name}: ${t.input} → ${t.expectedBehavior}`)
                .join('\n')
              : '  无测试用例';
            return [
              `代码审查结果: ${result.passed ? '✅ 通过' : '❌ 未通过'}`,
              `总分: ${result.overallScore}/100`,
              ``,
              `Bug:`,
              bugsSummary,
              ``,
              `安全问题:`,
              secSummary,
              ``,
              `测试用例:`,
              testsSummary,
            ].join('\n');
          } catch (err: unknown) {
            return `代码审查失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'verify_reasoning',
        description: '验证逻辑推理：检测逻辑谬误、隐含假设、提供反例。',
        parameters: {
          premise: { type: 'string', description: '推理的前提', required: true },
          conclusion: { type: 'string', description: '推理的结论', required: true },
          reasoning: { type: 'string', description: '推理过程', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await verifier.challengeReasoning(
              args.premise as string,
              args.conclusion as string,
              args.reasoning as string,
            );
            return [
              `推理验证结果: ${result.passed ? '✅ 通过' : '❌ 未通过'}`,
              `分数: ${result.score}/100`,
              ``,
              `逻辑谬误: ${result.fallacies.length > 0 ? '' : '无'}`,
              ...result.fallacies.map(f => `  - ${f}`),
              ``,
              `隐含假设: ${result.assumptions.length > 0 ? '' : '无'}`,
              ...result.assumptions.map(a => `  - ${a}`),
              ``,
              `反例: ${result.counterExamples.length > 0 ? '' : '无'}`,
              ...result.counterExamples.map(c => `  - ${c}`),
            ].join('\n');
          } catch (err: unknown) {
            return `推理验证失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'verify_stress_test',
        description: '生成对抗性压力测试用例：边界条件、对抗输入、失败预测。',
        parameters: {
          task: { type: 'string', description: '任务描述', required: true },
          solution: { type: 'string', description: '解决方案', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await verifier.stressTest(
              args.task as string,
              args.solution as string,
            );
            const testsSummary = result.testCases.map(t =>
              `  ${t.adversarial ? '🔴' : '🟢'} ${t.name}: ${t.input} → ${t.expectedBehavior}`
            ).join('\n');
            const predictionsSummary = result.failurePredictions.map(p => `  ⚠️ ${p}`).join('\n');
            return [
              `压力测试结果`,
              `鲁棒性分数: ${result.robustnessScore}/100`,
              ``,
              `测试用例 (${result.testCases.length}个):`,
              testsSummary,
              ``,
              `失败预测:`,
              predictionsSummary,
            ].join('\n');
          } catch (err: unknown) {
            return `压力测试失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'verify_debate',
        description: '辩论对抗：生成反面论据，找出原始立场的弱点，提供更强的替代立场。',
        parameters: {
          topic: { type: 'string', description: '辩论主题', required: true },
          position: { type: 'string', description: '原始立场', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const result = await verifier.debate(
              args.topic as string,
              args.position as string,
            );
            return [
              `辩论对抗结果`,
              ``,
              `反面论据:`,
              ...result.counterArguments.map(a => `  🎯 ${a}`),
              ``,
              `立场弱点:`,
              ...result.weaknesses.map(w => `  ⚠️ ${w}`),
              ``,
              `更强的立场:`,
              `  ${result.strongerPosition}`,
            ].join('\n');
          } catch (err: unknown) {
            return `辩论对抗失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
      {
        name: 'verify_consensus',
        description: '共识检查：比对多个Agent输出的一致性，找出分歧点和共识点。',
        parameters: {
          outputs: { type: 'string', description: '多个输出，用"|||"分隔', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          try {
            const outputs = (args.outputs as string).split('|||').map(s => s.trim()).filter(s => s.length > 0);
            if (outputs.length < 2) {
              return '需要至少2个输出进行共识检查，请用"|||"分隔多个输出';
            }
            const result = await verifier.consensusCheck(outputs);
            return [
              `共识检查结果`,
              `一致度: ${(result.agreement * 100).toFixed(0)}%`,
              ``,
              `共识点:`,
              ...result.consensusPoints.map(p => `  ✅ ${p}`),
              ``,
              `分歧点:`,
              ...result.disagreements.map(d => `  ❌ ${d}`),
              ``,
              `推荐答案:`,
              `  ${result.recommendedAnswer.substring(0, 300)}`,
            ].join('\n');
          } catch (err: unknown) {
            return `共识检查失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
    ];
  }
}
