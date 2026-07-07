/**
 * 跨步骤一致性守卫 — ConsistencyGuard
 *
 * 灵感来源：LibTV 的角色一致性跨场景保持
 * 核心能力：
 * 1. 约束注册：支持事实、逻辑、命名、风格、API契约、数据模式六种约束类型
 * 2. 一致性检查：每步输出与之前步骤的约束进行交叉验证
 * 3. 不一致解决：自动修复或建议修复策略
 * 4. 会话状态追踪：维护事实表和约束快照
 * 5. 统计追踪：检查次数、违规次数、自动修复率等
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 约束类型 */
export type ConstraintType = 'factual' | 'logical' | 'naming' | 'style' | 'api_contract' | 'data_schema';

/** 严重级别 */
export type Severity = 'error' | 'warning' | 'info';

/** 一致性约束 */
export interface ConsistencyConstraint {
  id: string;
  name: string;
  description: string;
  type: ConstraintType;
  check: (output: string, context: ConsistencyContext) => ConsistencyCheckResult;
  severity: Severity;
  autoFix: boolean;
}

/** 一致性上下文 */
export interface ConsistencyContext {
  previousSteps: Array<{ id: string; output: string; type: string }>;
  trackedFacts: Record<string, string>;
  sessionConstraints: string[];
}

/** 一致性检查结果 */
export interface ConsistencyCheckResult {
  consistent: boolean;
  violations: ConsistencyViolation[];
}

/** 一致性违规 */
export interface ConsistencyViolation {
  constraintId: string;
  constraintName: string;
  description: string;
  severity: Severity;
  conflictingValue: string;
  expectedValue: string;
  autoFixable: boolean;
  suggestedFix: string;
}

/** 一致性报告 */
export interface ConsistencyReport {
  stepId: string;
  consistent: boolean;
  violations: ConsistencyViolation[];
  checkedConstraints: number;
  timestamp: number;
}

/** 解决结果 */
export interface ResolutionResult {
  resolved: boolean;
  strategy: string;
  modifiedOutput?: string;
  remainingViolations: number;
}


// ============ 预注册约束 ============

/** 命名一致性约束：变量/函数名在步骤间必须保持一致 */
const NAMING_CONSISTENCY_CONSTRAINT: ConsistencyConstraint = {
  id: 'naming_consistency',
  name: '命名一致性',
  description: '变量/函数名在步骤间必须保持一致，同一概念不可使用不同名称',
  type: 'naming',
  severity: 'error',
  autoFix: true,
  check: (output: string, context: ConsistencyContext): ConsistencyCheckResult => {
    const violations: ConsistencyViolation[] = [];

    // 从之前步骤中提取变量/函数名
    const namePattern = /(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;
    const previousNames = new Map<string, string>(); // name → stepId

    for (const step of context.previousSteps) {
      let match: RegExpExecArray | null;
      const stepText = step.output;
      namePattern.lastIndex = 0;
      while ((match = namePattern.exec(stepText)) !== null) {
        previousNames.set(match[1], step.id);
      }
    }

    // 检查当前输出中是否有名称冲突
    // 检测驼峰/下划线/短横线风格的混用
    const currentNames: string[] = [];
    namePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = namePattern.exec(output)) !== null) {
      currentNames.push(match[1]);
    }

    // 检测同一概念的不同命名风格
    for (const name of currentNames) {
      // 驼峰版本
      const camelVersion = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      // 下划线版本
      const snakeVersion = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
      // 短横线版本
      const kebabVersion = snakeVersion.replace(/_/g, '-');

      for (const [prevName, stepId] of previousNames.entries()) {
        // 检测是否是同一概念的不同风格
        if (prevName !== name && (
          prevName === camelVersion ||
          prevName === snakeVersion ||
          prevName === kebabVersion ||
          camelVersion === prevName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) ||
          snakeVersion === prevName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
        )) {
          violations.push({
            constraintId: 'naming_consistency',
            constraintName: '命名一致性',
            description: `检测到命名风格不一致："${prevName}"（步骤 ${stepId}）vs "${name}"`,
            severity: 'error',
            conflictingValue: name,
            expectedValue: prevName,
            autoFixable: true,
            suggestedFix: `将 "${name}" 统一为 "${prevName}"，保持与之前步骤一致`,
          });
        }
      }
    }

    return { consistent: violations.length === 0, violations };
  },
};

/** API 契约约束：API 签名在步骤间不可改变 */
const API_CONTRACT_CONSTRAINT: ConsistencyConstraint = {
  id: 'api_contract',
  name: 'API契约一致性',
  description: 'API签名（函数名、参数、返回值）在步骤间不可改变',
  type: 'api_contract',
  severity: 'error',
  autoFix: false,
  check: (output: string, context: ConsistencyContext): ConsistencyCheckResult => {
    const violations: ConsistencyViolation[] = [];

    // 提取函数签名
    const signaturePattern = /(?:function|const|let)\s+(\w+)\s*(?:=\s*)?(?:\(|<)([^)]*?)(?:\))\s*(?::\s*([^{]+?))?\s*(?:=>|\{)/g;
    const previousSigs = new Map<string, { params: string; returnType: string; stepId: string }>();

    for (const step of context.previousSteps) {
      let match: RegExpExecArray | null;
      signaturePattern.lastIndex = 0;
      while ((match = signaturePattern.exec(step.output)) !== null) {
        previousSigs.set(match[1], {
          params: match[2]?.trim() || '',
          returnType: match[3]?.trim() || 'unknown',
          stepId: step.id,
        });
      }
    }

    // 检查当前输出中的签名变化
    let match: RegExpExecArray | null;
    signaturePattern.lastIndex = 0;
    while ((match = signaturePattern.exec(output)) !== null) {
      const name = match[1];
      const params = match[2]?.trim() || '';
      const returnType = match[3]?.trim() || 'unknown';

      const prev = previousSigs.get(name);
      if (prev) {
        // 参数变化
        if (prev.params !== params) {
          violations.push({
            constraintId: 'api_contract',
            constraintName: 'API契约一致性',
            description: `函数 "${name}" 的参数签名发生了变化`,
            severity: 'error',
            conflictingValue: `(${params})`,
            expectedValue: `(${prev.params})`,
            autoFixable: false,
            suggestedFix: `保持函数 "${name}" 的参数签名不变: (${prev.params})，或在步骤 ${prev.stepId} 中同步更新`,
          });
        }

        // 返回类型变化
        if (prev.returnType !== 'unknown' && returnType !== 'unknown' && prev.returnType !== returnType) {
          violations.push({
            constraintId: 'api_contract',
            constraintName: 'API契约一致性',
            description: `函数 "${name}" 的返回类型发生了变化`,
            severity: 'warning',
            conflictingValue: returnType,
            expectedValue: prev.returnType,
            autoFixable: false,
            suggestedFix: `保持函数 "${name}" 的返回类型不变: ${prev.returnType}`,
          });
        }
      }
    }

    return { consistent: violations.length === 0, violations };
  },
};

/** 事实一致性约束：前面陈述的事实不可被后续步骤否定 */
const FACTUAL_CONSISTENCY_CONSTRAINT: ConsistencyConstraint = {
  id: 'factual_consistency',
  name: '事实一致性',
  description: '前面步骤陈述的事实不可被后续步骤否定或矛盾',
  type: 'factual',
  severity: 'error',
  autoFix: false,
  check: (output: string, context: ConsistencyContext): ConsistencyCheckResult => {
    const violations: ConsistencyViolation[] = [];

    // 检查追踪的事实是否与当前输出矛盾
    for (const [factKey, factValue] of Object.entries(context.trackedFacts)) {
      // 检测否定表达
      const negationPatterns = [
        new RegExp(`不(是|等于|包含|支持|使用|采用)${escapeRegex(factValue)}`, 'g'),
        new RegExp(`${escapeRegex(factValue)}(是错误的|是不对的|是不正确的|已废弃|已移除)`, 'g'),
        new RegExp(`(不是|并非|非)${escapeRegex(factValue)}`, 'g'),
      ];

      for (const pattern of negationPatterns) {
        if (pattern.test(output)) {
          violations.push({
            constraintId: 'factual_consistency',
            constraintName: '事实一致性',
            description: `当前输出与已记录事实矛盾: "${factKey} = ${factValue}"`,
            severity: 'error',
            conflictingValue: `否定 "${factValue}"`,
            expectedValue: factValue,
            autoFixable: false,
            suggestedFix: `保持与已记录事实一致: ${factKey} = ${factValue}，或明确说明事实变更原因`,
          });
          break; // 每个事实只报一次
        }
      }
    }

    return { consistent: violations.length === 0, violations };
  },
};

/** 风格一致性约束：代码风格在同一任务内必须一致 */
const STYLE_CONSISTENCY_CONSTRAINT: ConsistencyConstraint = {
  id: 'style_consistency',
  name: '风格一致性',
  description: '代码风格（缩进、引号、分号等）在同一任务内必须一致',
  type: 'style',
  severity: 'warning',
  autoFix: true,
  check: (output: string, context: ConsistencyContext): ConsistencyCheckResult => {
    const violations: ConsistencyViolation[] = [];

    if (context.previousSteps.length === 0) return { consistent: true, violations };

    // 从之前步骤推断风格偏好
    const firstStep = context.previousSteps[0].output;

    // 引号风格
    const prevSingleQuotes = (firstStep.match(/'/g) || []).length;
    const prevDoubleQuotes = (firstStep.match(/"/g) || []).length;
    const currSingleQuotes = (output.match(/'/g) || []).length;
    const currDoubleQuotes = (output.match(/"/g) || []).length;

    const prevPrefersSingle = prevSingleQuotes > prevDoubleQuotes;
    const currPrefersSingle = currSingleQuotes > currDoubleQuotes;

    if (prevPrefersSingle !== currPrefersSingle && currSingleQuotes > 0 && currDoubleQuotes > 0) {
      violations.push({
        constraintId: 'style_consistency',
        constraintName: '风格一致性',
        description: '引号风格不一致',
        severity: 'warning',
        conflictingValue: currPrefersSingle ? '单引号' : '双引号',
        expectedValue: prevPrefersSingle ? '单引号' : '双引号',
        autoFixable: true,
        suggestedFix: `统一使用${prevPrefersSingle ? '单' : '双'}引号`,
      });
    }

    // 分号风格
    const prevHasSemicolons = /;\s*\n/g.test(firstStep);
    const currHasSemicolons = /;\s*\n/g.test(output);

    if (prevHasSemicolons !== currHasSemicolons && context.previousSteps[0].output.includes('function')) {
      violations.push({
        constraintId: 'style_consistency',
        constraintName: '风格一致性',
        description: '分号使用风格不一致',
        severity: 'info',
        conflictingValue: currHasSemicolons ? '使用分号' : '不使用分号',
        expectedValue: prevHasSemicolons ? '使用分号' : '不使用分号',
        autoFixable: true,
        suggestedFix: `统一${prevHasSemicolons ? '使用' : '不使用'}分号`,
      });
    }

    // 缩进风格
    const prevUsesTabs = /^\t/gm.test(firstStep);
    const currUsesTabs = /^\t/gm.test(output);
    const prevUsesSpaces = /^ {2}/gm.test(firstStep);

    if (prevUsesTabs !== currUsesTabs && prevUsesSpaces && output.includes('  ')) {
      violations.push({
        constraintId: 'style_consistency',
        constraintName: '风格一致性',
        description: '缩进风格不一致',
        severity: 'info',
        conflictingValue: currUsesTabs ? 'Tab缩进' : '空格缩进',
        expectedValue: prevUsesTabs ? 'Tab缩进' : '空格缩进',
        autoFixable: true,
        suggestedFix: `统一使用${prevUsesTabs ? 'Tab' : '空格'}缩进`,
      });
    }

    return { consistent: violations.length === 0, violations };
  },
};

/** 数据模式一致性约束：数据结构必须保持模式一致 */
const DATA_SCHEMA_CONSTRAINT: ConsistencyConstraint = {
  id: 'data_schema',
  name: '数据模式一致性',
  description: '数据结构（接口、类型、表结构）必须保持模式一致，不可随意增删字段',
  type: 'data_schema',
  severity: 'error',
  autoFix: false,
  check: (output: string, context: ConsistencyContext): ConsistencyCheckResult => {
    const violations: ConsistencyViolation[] = [];

    // 提取接口/类型定义
    const interfacePattern = /(?:interface|type)\s+(\w+)\s*(?:=|extends\s+\w+\s*)?\{([^}]+)\}/g;
    const previousSchemas = new Map<string, { fields: Set<string>; stepId: string }>();

    for (const step of context.previousSteps) {
      let match: RegExpExecArray | null;
      interfacePattern.lastIndex = 0;
      while ((match = interfacePattern.exec(step.output)) !== null) {
        const name = match[1];
        const body = match[2];
        const fields = new Set(
          body.split('\n')
            .map(l => l.trim().replace(/[?:;]/g, '').split(':')[0]?.trim())
            .filter(f => f && f.length > 0)
        );
        previousSchemas.set(name, { fields, stepId: step.id });
      }
    }

    // 检查当前输出中的模式变化
    let match: RegExpExecArray | null;
    interfacePattern.lastIndex = 0;
    while ((match = interfacePattern.exec(output)) !== null) {
      const name = match[1];
      const body = match[2];
      const currentFields = new Set(
        body.split('\n')
          .map(l => l.trim().replace(/[?:;]/g, '').split(':')[0]?.trim())
          .filter(f => f && f.length > 0)
      );

      const prev = previousSchemas.get(name);
      if (prev) {
        // 检测缺失字段
        for (const field of prev.fields) {
          if (!currentFields.has(field)) {
            violations.push({
              constraintId: 'data_schema',
              constraintName: '数据模式一致性',
              description: `接口 "${name}" 缺少字段 "${field}"`,
              severity: 'error',
              conflictingValue: `缺少 ${field}`,
              expectedValue: `包含 ${field}`,
              autoFixable: false,
              suggestedFix: `在接口 "${name}" 中恢复字段 "${field}"，或明确标注为可选`,
            });
          }
        }

        // 检测新增字段（仅警告）
        for (const field of currentFields) {
          if (!prev.fields.has(field)) {
            violations.push({
              constraintId: 'data_schema',
              constraintName: '数据模式一致性',
              description: `接口 "${name}" 新增了字段 "${field}"`,
              severity: 'warning',
              conflictingValue: `新增 ${field}`,
              expectedValue: `与步骤 ${prev.stepId} 的定义一致`,
              autoFixable: false,
              suggestedFix: `确认新增字段 "${field}" 是有意为之，并更新所有使用该接口的代码`,
            });
          }
        }
      }
    }

    return { consistent: violations.length === 0, violations };
  },
};

/** 正则转义辅助函数 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============ 主类 ============

export class ConsistencyGuard {
  private log = logger.child({ module: 'ConsistencyGuard' });
  private constraints: Map<string, ConsistencyConstraint> = new Map();
  private trackedFacts: Record<string, string> = {};
  private sessionConstraints: string[] = [];
  private stepHistory: Array<{ id: string; output: string; type: string }> = [];
  private stats = {
    totalChecks: 0,
    totalViolations: 0,
    autoFixes: 0,
    autoFixSuccesses: 0,
    constraintBreakdown: {} as Record<string, number>,
  };

  constructor() {
    // 注册内置约束
    this.registerBuiltinConstraints();
    this.log.info('一致性守卫初始化完成', {
      constraintCount: this.constraints.size,
      constraints: Array.from(this.constraints.keys()),
    });
  }

  // ========== 核心方法 ==========

  /**
   * 注册一致性约束
   */
  registerConstraint(constraint: ConsistencyConstraint): { success: boolean; message: string } {
    if (this.constraints.has(constraint.id)) {
      this.log.warn('约束已存在，将覆盖', { constraintId: constraint.id });
    }

    this.constraints.set(constraint.id, constraint);
    this.sessionConstraints.push(constraint.id);

    this.log.info('注册一致性约束', {
      id: constraint.id,
      name: constraint.name,
      type: constraint.type,
      severity: constraint.severity,
      autoFix: constraint.autoFix,
    });

    EventBus.getInstance().emitSync('consistency.constraint.registered', {
      id: constraint.id,
      name: constraint.name,
      type: constraint.type,
    });

    return { success: true, message: `约束 "${constraint.name}" (${constraint.id}) 注册成功` };
  }

  /**
   * 检查一致性
   */
  checkConsistency(stepId: string, output: string, context?: Partial<ConsistencyContext>): ConsistencyReport {
    const startTime = Date.now();
    this.log.info('开始一致性检查', { stepId, outputLength: output.length });

    // 构建完整上下文
    const fullContext: ConsistencyContext = {
      previousSteps: context?.previousSteps || this.stepHistory,
      trackedFacts: context?.trackedFacts || this.trackedFacts,
      sessionConstraints: context?.sessionConstraints || this.sessionConstraints,
    };

    const allViolations: ConsistencyViolation[] = [];
    let checkedCount = 0;

    // 遍历所有约束进行检查
    for (const [id, constraint] of this.constraints.entries()) {
      try {
        const result = constraint.check(output, fullContext);
        checkedCount++;

        if (!result.consistent) {
          allViolations.push(...result.violations);
          this.stats.constraintBreakdown[id] = (this.stats.constraintBreakdown[id] || 0) + result.violations.length;
        }
      } catch (err: unknown) {
        this.log.error('约束检查异常', { constraintId: id, error: err });
      }
    }

    const report: ConsistencyReport = {
      stepId,
      consistent: allViolations.length === 0,
      violations: allViolations,
      checkedConstraints: checkedCount,
      timestamp: Date.now(),
    };

    // 更新统计
    this.stats.totalChecks++;
    this.stats.totalViolations += allViolations.length;

    // 记录步骤到历史
    this.stepHistory.push({ id: stepId, output, type: 'step' });

    // 从输出中提取新事实
    this.extractFacts(output);

    // 广播事件
    EventBus.getInstance().emitSync('consistency.checked', {
      stepId,
      consistent: report.consistent,
      violationCount: allViolations.length,
      checkedConstraints: checkedCount,
      durationMs: Date.now() - startTime,
    });

    this.log.info('一致性检查完成', {
      stepId,
      consistent: report.consistent,
      violationCount: allViolations.length,
      checkedConstraints: checkedCount,
      durationMs: Date.now() - startTime,
    });

    return report;
  }

  /**
   * 解决不一致
   */
  resolveInconsistency(report: ConsistencyReport): ResolutionResult {
    this.log.info('尝试解决不一致', {
      stepId: report.stepId,
      violationCount: report.violations.length,
    });

    const autoFixableViolations = report.violations.filter(v => v.autoFixable);
    const nonFixableViolations = report.violations.filter(v => !v.autoFixable);

    if (autoFixableViolations.length === 0 && nonFixableViolations.length > 0) {
      // 没有可自动修复的违规
      EventBus.getInstance().emitSync('consistency.resolution.failed', {
        stepId: report.stepId,
        reason: '无可自动修复的违规',
        violationCount: report.violations.length,
      });

      return {
        resolved: false,
        strategy: 'manual',
        remainingViolations: nonFixableViolations.length,
      };
    }

    // 尝试自动修复
    let modifiedOutput: string | undefined;
    const appliedStrategies: string[] = [];

    for (const violation of autoFixableViolations) {
      const fixResult = this.applyAutoFix(violation);
      if (fixResult.applied) {
        modifiedOutput = fixResult.modifiedOutput || modifiedOutput;
        appliedStrategies.push(fixResult.strategy);
        this.stats.autoFixSuccesses++;
      }
      this.stats.autoFixes++;
    }

    const resolved = nonFixableViolations.length === 0 && appliedStrategies.length === autoFixableViolations.length;
    const strategy = resolved ? 'auto_fix_all' : `auto_fix_partial(${appliedStrategies.length}/${autoFixableViolations.length})`;

    EventBus.getInstance().emitSync('consistency.resolution.applied', {
      stepId: report.stepId,
      resolved,
      strategy,
      autoFixedCount: appliedStrategies.length,
      remainingViolations: nonFixableViolations.length,
    });

    return {
      resolved,
      strategy,
      modifiedOutput,
      remainingViolations: nonFixableViolations.length,
    };
  }

  /**
   * 获取当前会话的一致性状态
   */
  getSessionState(): {
    trackedFacts: Record<string, string>;
    constraints: Array<{ id: string; name: string; type: ConstraintType; severity: Severity }>;
    stepCount: number;
    sessionConstraints: string[];
  } {
    return {
      trackedFacts: { ...this.trackedFacts },
      constraints: Array.from(this.constraints.values()).map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        severity: c.severity,
      })),
      stepCount: this.stepHistory.length,
      sessionConstraints: [...this.sessionConstraints],
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<string, unknown> {
    return {
      totalChecks: this.stats.totalChecks,
      totalViolations: this.stats.totalViolations,
      violationsPerCheck: this.stats.totalChecks > 0
        ? (this.stats.totalViolations / this.stats.totalChecks).toFixed(2)
        : '0',
      autoFixes: this.stats.autoFixes,
      autoFixSuccesses: this.stats.autoFixSuccesses,
      autoFixSuccessRate: this.stats.autoFixes > 0
        ? (this.stats.autoFixSuccesses / this.stats.autoFixes * 100).toFixed(1) + '%'
        : '0%',
      constraintBreakdown: { ...this.stats.constraintBreakdown },
      trackedFactsCount: Object.keys(this.trackedFacts).length,
      stepCount: this.stepHistory.length,
    };
  }

  // ========== 工具定义（Agent Loop 集成） ==========

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'consistency_check',
        description: '一致性检查：检查当前步骤输出与之前步骤的一致性，包括命名、API契约、事实、风格、数据模式等维度。灵感来自 LibTV 的角色一致性跨场景保持。',
        parameters: {
          stepId: { type: 'string', description: '当前步骤ID', required: true },
          output: { type: 'string', description: '当前步骤的输出内容', required: true },
        },
        readOnly: true,
        execute: (args) => {
          const report = this.checkConsistency(
            args.stepId as string,
            args.output as string
          );
          return Promise.resolve(JSON.stringify(report, null, 2));
        },
      },
      {
        name: 'consistency_resolve',
        description: '解决不一致：尝试自动修复一致性违规，返回修复后的输出和剩余违规数。',
        parameters: {
          report: { type: 'string', description: '一致性检查报告 JSON（来自 consistency_check 的结果）', required: true },
        },
        readOnly: false,
        execute: (args) => {
          try {
            const report = JSON.parse(args.report as string) as ConsistencyReport;
            const result = this.resolveInconsistency(report);
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (e: unknown) {
            return Promise.resolve(`报告解析失败: ${(e instanceof Error ? e.message : String(e))}`);
          }
        },
      },
      {
        name: 'consistency_state',
        description: '查看一致性状态：获取当前会话的追踪事实、已注册约束和步骤历史。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const state = this.getSessionState();
          return Promise.resolve(JSON.stringify(state, null, 2));
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 注册内置约束 */
  private registerBuiltinConstraints(): void {
    const builtins: ConsistencyConstraint[] = [
      NAMING_CONSISTENCY_CONSTRAINT,
      API_CONTRACT_CONSTRAINT,
      FACTUAL_CONSISTENCY_CONSTRAINT,
      STYLE_CONSISTENCY_CONSTRAINT,
      DATA_SCHEMA_CONSTRAINT,
    ];

    for (const constraint of builtins) {
      this.constraints.set(constraint.id, constraint);
      this.sessionConstraints.push(constraint.id);
    }
  }

  /** 从输出中提取事实 */
  private extractFacts(output: string): void {
    // 提取技术选型事实
    const techPatterns: Array<{ pattern: RegExp; factKey: string }> = [
      { pattern: /使用\s*(React|Vue|Angular|Svelte|Next\.?js|Nuxt)/i, factKey: 'framework' },
      { pattern: /使用\s*(TypeScript|JavaScript|Python|Go|Rust|Java)/i, factKey: 'language' },
      { pattern: /数据库(?:使用|采用|选择)\s*(MySQL|PostgreSQL|MongoDB|Redis|SQLite)/i, factKey: 'database' },
      { pattern: /(?:采用|使用)\s*(REST|GraphQL|gRPC|WebSocket)\s*API/i, factKey: 'api_style' },
      { pattern: /(?:采用|使用)\s*(Monorepo|Polyrepo)\s*架构/i, factKey: 'repo_structure' },
      { pattern: /包管理器(?:使用|采用)\s*(npm|yarn|pnpm|bun)/i, factKey: 'package_manager' },
    ];

    for (const { pattern, factKey } of techPatterns) {
      const match = pattern.exec(output);
      if (match) {
        const value = match[1];
        if (this.trackedFacts[factKey] && this.trackedFacts[factKey] !== value) {
          this.log.warn('检测到事实变更', {
            factKey,
            oldValue: this.trackedFacts[factKey],
            newValue: value,
          });
        }
        this.trackedFacts[factKey] = value;
      }
    }

    // 提取变量/类型定义事实
    const varPattern = /(?:const|let|var)\s+(\w+)\s*=\s*([^;,\n]+)/g;
    let match: RegExpExecArray | null;
    while ((match = varPattern.exec(output)) !== null) {
      const varName = match[1];
      const varValue = match[2].trim().substring(0, 50); // 截断过长的值
      this.trackedFacts[`var:${varName}`] = varValue;
    }
  }

  /** 应用自动修复 */
  private applyAutoFix(violation: ConsistencyViolation): { applied: boolean; strategy: string; modifiedOutput?: string } {
    switch (violation.constraintId) {
      case 'naming_consistency':
        return {
          applied: true,
          strategy: 'rename',
          modifiedOutput: `建议将 "${violation.conflictingValue}" 重命名为 "${violation.expectedValue}"`,
        };

      case 'style_consistency':
        return {
          applied: true,
          strategy: 'style_unify',
          modifiedOutput: `建议统一风格: ${violation.suggestedFix}`,
        };

      default:
        return {
          applied: false,
          strategy: 'none',
        };
    }
  }

  /** 重置会话状态 */
  resetSession(): void {
    this.trackedFacts = {};
    this.stepHistory = [];
    this.log.info('一致性守卫会话已重置');
    EventBus.getInstance().emitSync('consistency.session.reset', {});
  }
}
