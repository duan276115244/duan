/**
 * 价值系统 — 段先生的核心价值观与决策伦理框架
 * 所有决策都基于这个价值系统
 */

export interface Value {
  name: string;
  weight: number;       // 0-1 该价值的权重
  description: string;
  rules: string[];       // 具体行为规则
}

export interface EthicalJudgment {
  score: number;         // -1 到 1, 负值表示不道德
  concerns: string[];
  violatedValues: string[];
  recommendation: string;
}

export class ValueSystem {
  private values: Value[] = [
    {
      name: '有益性',
      weight: 1.0,
      description: '始终为用户创造价值，帮助用户实现目标',
      rules: [
        '优先完成用户的明确需求',
        '主动发现并满足用户的潜在需求',
        '提供超出预期的帮助',
      ],
    },
    {
      name: '诚实透明',
      weight: 0.9,
      description: '对用户完全诚实，不隐瞒限制和错误',
      rules: [
        '不知道就说不知道',
        '出错时主动承认并修复',
        '透明展示思考过程',
        '不夸大自身能力',
      ],
    },
    {
      name: '持续进化',
      weight: 0.9,
      description: '不断学习、改进、扩展能力边界',
      rules: [
        '每次任务后反思改进',
        '主动寻找学习机会',
        '记录并推广有效的模式',
        '自我修改要谨慎验证',
      ],
    },
    {
      name: '可靠稳健',
      weight: 0.8,
      description: '提供稳定可靠的输出，避免冒险行为',
      rules: [
        '修改代码前备份',
        '验证每次修改的影响',
        '有风险的操作先问用户',
        '保持向后兼容',
      ],
    },
    {
      name: '主动负责',
      weight: 0.8,
      description: '主动承担任务，不等待被指挥',
      rules: [
        '发现问题主动报告',
        '预测可能的失败并预防',
        '任务完成后主动验证',
        '主动学习相关知识',
      ],
    },
    {
      name: '效率优先',
      weight: 0.7,
      description: '用最少的时间和资源完成任务',
      rules: [
        '避免不必要的工具调用',
        '批量处理相似操作',
        '缓存可复用的结果',
        '选择最优的解决方案',
      ],
    },
    {
      name: '安全谨慎',
      weight: 0.7,
      description: '保护用户数据和系统安全',
      rules: [
        '不执行未知来源的代码',
        '不随意修改系统配置',
        '保护敏感信息',
        '破坏性操作先确认',
      ],
    },
  ];

  private decisionLog: Array<{
    decision: string;
    valuesInvoked: string[];
    outcome: string;
    timestamp: number;
  }> = [];

  getValues(): Value[] { return this.values; }

  getValue(name: string): Value | undefined {
    return this.values.find(v => v.name === name);
  }

  judgeAction(action: string, context: string): EthicalJudgment {
    const concerns: string[] = [];
    const violatedValues: string[] = [];
    let totalWeightImpact = 0;

    for (const value of this.values) {
      const isRelevant = this.isRelevantToValue(action, value);
      if (isRelevant.violated) {
        concerns.push(isRelevant.reason);
        violatedValues.push(value.name);
        totalWeightImpact += value.weight;
      }
    }

    // 加权评分：违反高权重价值扣分更多
    const maxPossibleImpact = this.values.reduce((sum, v) => sum + v.weight, 0);
    const score = concerns.length === 0
      ? 1
      : Math.max(-1, 1 - (totalWeightImpact / maxPossibleImpact) * 2);

    // 上下文缓解：某些上下文可以降低伦理风险
    const mitigatedConcerns: string[] = [];
    const lowerContext = context.toLowerCase();
    if (concerns.length > 0) {
      if (lowerContext.includes('测试') || lowerContext.includes('test')) {
        mitigatedConcerns.push('操作在测试环境中执行');
      }
      if (lowerContext.includes('用户确认') || lowerContext.includes('用户要求')) {
        mitigatedConcerns.push('用户已明确要求此操作');
      }
    }

    const finalScore = mitigatedConcerns.length > 0
      ? Math.min(1, score + mitigatedConcerns.length * 0.2)
      : score;

    let recommendation: string;
    if (finalScore < 0) {
      recommendation = '不建议执行此操作';
    } else if (finalScore < 0.3) {
      recommendation = '强烈建议用户确认后再执行';
    } else if (finalScore < 0.6) {
      recommendation = '建议谨慎执行，并告知用户潜在风险';
    } else {
      recommendation = '可以执行';
    }

    if (mitigatedConcerns.length > 0) {
      recommendation += `（缓解因素: ${mitigatedConcerns.join('; ')}）`;
    }

    return {
      score: Math.round(finalScore * 100) / 100,
      concerns,
      violatedValues,
      recommendation,
    };
  }

  private isRelevantToValue(action: string, value: Value): { violated: boolean; reason: string } {
    const lower = action.toLowerCase();

    if (value.name === '安全谨慎') {
      // 破坏性操作
      const destructivePatterns = [
        { pattern: /\b(rm\s|del\s|format\s|rd\s|rmdir\s)/i, reason: '破坏性文件操作需要用户确认' },
        { pattern: /\b(drop\s+table|truncate\s+table|delete\s+from)/i, reason: '破坏性数据库操作需要用户确认' },
        { pattern: /\b(sudo\s|runas\s)/i, reason: '提权操作需要用户确认' },
        { pattern: /chmod\s+777|icacls\s+.*everyone/i, reason: '过度宽松的权限设置存在安全风险' },
        { pattern: /\b(reg\s+delete|regedit)/i, reason: '注册表修改需要用户确认' },
        { pattern: /netsh\s|iptables\s/i, reason: '网络配置修改需要用户确认' },
      ];
      for (const { pattern, reason } of destructivePatterns) {
        if (pattern.test(lower)) return { violated: true, reason };
      }
      // 敏感信息
      const sensitivePatterns = [
        { pattern: /password|passwd|pwd\s*=/i, reason: '操作涉及密码信息' },
        { pattern: /secret\s*=/i, reason: '操作涉及密钥信息' },
        { pattern: /api[_-]?key\s*=/i, reason: '操作涉及API密钥' },
        { pattern: /token\s*=/i, reason: '操作涉及认证令牌' },
        { pattern: /private[_-]?key/i, reason: '操作涉及私钥' },
        { pattern: /\.env/i, reason: '操作涉及环境变量文件' },
      ];
      for (const { pattern, reason } of sensitivePatterns) {
        if (pattern.test(lower)) return { violated: true, reason };
      }
      // 远程执行风险
      if (/\b(eval|exec|spawn|child_process)\s*\(/i.test(lower)) {
        return { violated: true, reason: '动态代码执行存在注入风险' };
      }
    }

    if (value.name === '诚实透明') {
      if (/\b(pretend|fake|lie|deceive|mislead|forge)\b/i.test(lower)) {
        return { violated: true, reason: '不允许欺骗或误导行为' };
      }
      if (/\b(hide|conceal|suppress)\b.*\b(error|failure|bug|issue)\b/i.test(lower)) {
        return { violated: true, reason: '不允许隐瞒错误或失败' };
      }
    }

    if (value.name === '可靠稳健') {
      if (/\b(force|skip\s+backup|ignore\s+error|no-?verify)\b/i.test(lower)) {
        return { violated: true, reason: '跳过安全检查或备份的操作不可靠' };
      }
      if (/\b(overwrite|replace\s+all)\b/i.test(lower) && !/\b(backup|copy)\b/i.test(lower)) {
        return { violated: true, reason: '覆盖操作应先备份' };
      }
    }

    if (value.name === '有益性') {
      if (/\b(spam|flood|ddos|harass|stalk)\b/i.test(lower)) {
        return { violated: true, reason: '操作可能对他人造成骚扰或伤害' };
      }
      if (/\b(malware|virus|trojan|exploit|backdoor)\b/i.test(lower)) {
        return { violated: true, reason: '不允许创建恶意软件' };
      }
    }

    return { violated: false, reason: '' };
  }

  logDecision(decision: string, valuesInvoked: string[], outcome: string): void {
    this.decisionLog.push({ decision, valuesInvoked, outcome, timestamp: Date.now() });
    if (this.decisionLog.length > 100) this.decisionLog.shift();
  }

  getDecisionLog(count: number = 10): Array<{ decision: string; valuesInvoked: string[]; outcome: string }> {
    return this.decisionLog.slice(-count);
  }

  getConflictingValues(): Array<{ value1: string; value2: string; conflict: string }> {
    return [
      { value1: '效率优先', value2: '安全谨慎', conflict: '快速执行 vs 检查验证' },
      { value1: '主动负责', value2: '安全谨慎', conflict: '主动行动 vs 等待确认' },
      { value1: '持续进化', value2: '可靠稳健', conflict: '尝试新方法 vs 保持稳定' },
    ];
  }

  resolveConflict(valueA: string, valueB: string, _context: string): string {
    const vA = this.getValue(valueA);
    const vB = this.getValue(valueB);
    if (!vA || !vB) return valueA;
    return vA.weight >= vB.weight ? valueA : valueB;
  }

  getValueReport(): string {
    let output = `⚖️ **价值系统报告**\n\n`;
    for (const v of this.values.sort((a, b) => b.weight - a.weight)) {
      const bar = '█'.repeat(Math.round(v.weight * 10)) + '░'.repeat(10 - Math.round(v.weight * 10));
      output += `${bar} ${v.name} (权重: ${v.weight})\n`;
      output += `  ${v.description}\n`;
    }
    if (this.decisionLog.length > 0) {
      output += `\n📋 最近决策 (${this.decisionLog.length}条):\n`;
      for (const d of this.decisionLog.slice(-5)) {
        output += `  • ${d.decision} → ${d.outcome}\n`;
      }
    }
    return output;
  }
}
