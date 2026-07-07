interface IntentAnalysis {
  understanding: string;
  intentions: string[];
  constraints: string[];
  approaches: string[];
  confidence: number;
  decisionQuality: {
    level: 'high' | 'medium' | 'low';
    factors: string[];
    recommendedStrategy: string;
  };
}

interface DeepUnderstandingResult {
  surfaceIntent: string;
  deepIntent: string;
  implicitNeeds: string[];
  contextFactors: string[];
  suggestedApproach: string;
  confidence: number;
}

class IntelligentBrain {
  analyzeIntent(message: string): IntentAnalysis {
    const lowerMsg = message.toLowerCase();

    const understanding = this.analyzeUnderstanding(message);
    const intentions = this.extractIntentions(lowerMsg);
    const constraints = this.extractConstraints(message, lowerMsg);
    const approaches = this.generateApproaches(lowerMsg);
    const confidence = this.calculateConfidence(message);

    const analysis = { understanding, intentions, constraints, approaches, confidence };
    const decisionQuality = this.assessDecisionQuality(message, analysis);

    return { ...analysis, decisionQuality };
  }

  private analyzeUnderstanding(message: string): string {
    if (/帮我|帮我做|帮我写|帮我生成/.test(message)) return '用户需要实际完成任务';
    if (/怎么|如何|怎么办/.test(message)) return '用户需要指导或解决方案';
    if (/为什么|什么原因/.test(message)) return '用户需要理解原因';
    if (/能不能|可以|是否/.test(message)) return '用户在询问可能性';
    if (/哪个|什么.*更好/.test(message)) return '用户在寻求建议';
    if (/不会|不行|出错|报错|失败/.test(message)) return '用户遇到问题需要帮助';
    return '用户提供了一个陈述或问题';
  }

  private extractIntentions(lowerMsg: string): string[] {
    const intentions: string[] = [];
    if (/学习|了解|知道|查询/.test(lowerMsg)) intentions.push('学习了解');
    if (/实现|完成|做出|生成|创建/.test(lowerMsg)) intentions.push('实现目标');
    if (/优化|改进|提升|改善/.test(lowerMsg)) intentions.push('优化改进');
    if (/解决|处理|修复/.test(lowerMsg)) intentions.push('解决问题');
    if (/比较|对比|选择/.test(lowerMsg)) intentions.push('比较选择');
    if (/规划|计划|安排/.test(lowerMsg)) intentions.push('规划安排');
    return intentions.length > 0 ? intentions : ['通用查询'];
  }

  private extractConstraints(message: string, lowerMsg: string): string[] {
    const constraints: string[] = [];
    if (/紧急|马上|立刻|立即/.test(lowerMsg)) constraints.push('时间紧迫');
    if (/简单|基础|入门/.test(lowerMsg)) constraints.push('需要简单方案');
    if (/复杂|高级|专业/.test(lowerMsg)) constraints.push('需要复杂方案');
    const techMatch = message.match(/(python|javascript|java|react|vue|node|typescript)/i);
    if (techMatch) constraints.push(`技术栈: ${techMatch[1]}`);
    return constraints;
  }

  private generateApproaches(lowerMsg: string): string[] {
    const approaches: string[] = [];
    if (/代码|编程|开发/.test(lowerMsg)) {
      approaches.push('提供完整代码实现', '分步骤指导开发', '分析架构方案');
    }
    if (/分析|数据|统计/.test(lowerMsg)) {
      approaches.push('提供数据分析方案', '生成可视化建议', '编写分析代码');
    }
    if (/文档|文章|报告/.test(lowerMsg)) {
      approaches.push('直接生成完整内容', '提供大纲和模板', '分段逐步完成');
    }
    if (/问题|错误|bug/.test(lowerMsg)) {
      approaches.push('诊断问题原因', '提供解决方案', '预防措施建议');
    }
    return approaches.length > 0 ? approaches : ['提供综合性回答'];
  }

  private calculateConfidence(message: string): number {
    let score = 0.7;
    if (message.length > 20) score += 0.1;
    if (message.length > 50) score += 0.1;
    if (/(?:使用|用)\s*(?:python|javascript|java)/i.test(message)) score += 0.1;
    if (/具体|详细/.test(message)) score += 0.05;
    return Math.min(score, 0.95);
  }

  private assessDecisionQuality(message: string, analysis: { understanding: string; intentions: string[]; constraints: string[]; approaches: string[]; confidence: number }): {
    level: 'high' | 'medium' | 'low';
    factors: string[];
    recommendedStrategy: string;
  } {
    const factors: string[] = [];
    let score = 0.5;

    if (message.length > 30) { score += 0.1; factors.push('信息充分'); }
    else { factors.push('信息不足'); }

    if (analysis.constraints.length > 0) { score += 0.15; factors.push('约束明确'); }

    if (analysis.intentions.length === 1) { score += 0.1; factors.push('意图清晰'); }
    else if (analysis.intentions.length > 3) { score -= 0.1; factors.push('意图模糊'); }

    if (analysis.confidence > 0.8) { score += 0.15; factors.push('高置信度'); }

    const level = (() => {
      if (score >= 0.7) return 'high';
      if (score >= 0.5) return 'medium';
      return 'low';
    })();
    const recommendedStrategy = (() => {
      if (level === 'high') return 'direct_execution';
      if (level === 'medium') return 'clarify_then_execute';
      return 'interactive_clarification';
    })();

    return { level, factors, recommendedStrategy };
  }

  deepUnderstand(input: string, context?: Array<{ role: string; content: string }>): DeepUnderstandingResult {
    const lowerInput = input.toLowerCase();
    let surfaceIntent = 'general_query';
    if (/代码|编程|开发|写.*函数|写.*类/.test(lowerInput)) surfaceIntent = 'code_generation';
    else if (/调试|修复|bug|报错|出错|错误/.test(lowerInput)) surfaceIntent = 'code_debug';
    else if (/什么是|解释|为什么|怎么理解/.test(lowerInput)) surfaceIntent = 'question_answering';
    else if (/规划|计划|方案|步骤|流程/.test(lowerInput)) surfaceIntent = 'task_planning';
    else if (/数据|统计|分析|报表/.test(lowerInput)) surfaceIntent = 'data_analysis';

    const deepIntentMap: Record<string, string> = {
      'code_generation': '用户需要可运行的、高质量的代码解决方案',
      'code_debug': '用户需要快速定位并修复问题的方法',
      'question_answering': '用户需要准确、有深度的知识解答',
      'task_planning': '用户需要系统性的执行方案',
      'data_analysis': '用户需要从数据中提取有价值的洞察',
    };
    const deepIntent = deepIntentMap[surfaceIntent] || '用户需要综合性的帮助';

    const implicitNeeds: string[] = [];
    if (/优化|改进|提升/.test(input)) implicitNeeds.push('性能优化建议');
    if (/安全|漏洞|风险/.test(input)) implicitNeeds.push('安全评估');
    if (/测试|验证|检查/.test(input)) implicitNeeds.push('测试方案');
    if (/文档|说明|解释/.test(input)) implicitNeeds.push('文档生成');
    if (input.length > 200) implicitNeeds.push('结构化输出');

    const contextFactors: string[] = [];
    if (context && context.length > 0) {
      if (context.length > 5) contextFactors.push('长对话历史，需注意上下文连贯');
      const lastMsg = context[context.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') contextFactors.push('上一轮为AI回复，可能需要延续');
    }

    let suggestedApproach = '直接回答';
    if (/如何|怎么|步骤/.test(input)) suggestedApproach = '分步骤指导';
    if (/比较|对比|选择/.test(input)) suggestedApproach = '对比分析';
    if (/设计|架构|规划/.test(input)) suggestedApproach = '系统设计';
    if (/为什么|原因|原理/.test(input)) suggestedApproach = '深度解释';
    if (/写|生成|创建|开发/.test(input)) suggestedApproach = '代码生成+解释';

    return {
      surfaceIntent,
      deepIntent,
      implicitNeeds,
      contextFactors,
      suggestedApproach,
      confidence: surfaceIntent !== 'general_query' ? 0.85 : 0.5,
    };
  }
}

const brain = new IntelligentBrain();

export { IntelligentBrain, brain };
export type { IntentAnalysis, DeepUnderstandingResult };
