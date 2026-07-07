interface ThoughtChain {
  steps: Array<{
    phase: 'observe' | 'think' | 'plan' | 'act' | 'reflect' | 'retry';
    content: string;
    timestamp: string;
    confidence?: number;
  }>;
  finalAnswer?: string;
  retryCount: number;
  maxRetries: number;
}

class SuperBrain {
  deepReason(message: string, context: string[]): ThoughtChain {
    const chain: ThoughtChain = { steps: [], retryCount: 0, maxRetries: 2 };
    const _lowerMsg = message.toLowerCase();

    const observation = this.observe(message, context);
    chain.steps.push({ phase: 'observe', content: observation, timestamp: new Date().toISOString() });

    const thinking = this.deepThink(message, observation);
    chain.steps.push({ phase: 'think', content: thinking.content, timestamp: new Date().toISOString(), confidence: thinking.confidence });

    const plan = this.makePlan(message, thinking);
    chain.steps.push({ phase: 'plan', content: plan, timestamp: new Date().toISOString() });

    return chain;
  }

  private observe(message: string, context: string[]): string {
    const observations: string[] = [];

    observations.push(`消息长度: ${message.length}字`);

    if (/^\w+\(/.test(message)) observations.push('可能是函数调用');
    if (/```/.test(message)) observations.push('包含代码块');
    if (/https?:\/\//.test(message)) observations.push('包含URL');
    if (/\d+/.test(message)) observations.push('包含数字');

    if (context.length > 0) {
      const lastAssistant = context.filter(m => m.includes('assistant')).pop();
      if (lastAssistant) observations.push('有上下文: 用户可能在追问');
    }

    if (/紧急|马上|立刻|快/.test(message)) observations.push('⚠️ 紧急程度: 高');
    if (/请|帮|麻烦/.test(message)) observations.push('语气: 礼貌请求');
    if (/为什么|怎么回事/.test(message)) observations.push('情绪: 疑惑/困惑');

    return observations.join(' | ');
  }

  private deepThink(message: string, _observation: string): { content: string; confidence: number } {
    const _lowerMsg = message.toLowerCase();
    const thoughts: string[] = [];
    let confidence = 0.6;

    const coreNeed = this.identifyCoreNeed(message);
    thoughts.push(`核心需求: ${coreNeed}`);
    confidence += 0.1;

    const implicitNeeds = this.identifyImplicitNeeds(message);
    if (implicitNeeds.length > 0) {
      thoughts.push(`隐含需求: ${implicitNeeds.join(', ')}`);
      confidence += 0.05;
    }

    const feasibility = this.assessFeasibility(message);
    thoughts.push(`可行性: ${feasibility}`);
    if (feasibility === '高') confidence += 0.15;
    else if (feasibility === '中') confidence += 0.05;

    const risks = this.identifyRisks(message);
    if (risks.length > 0) {
      thoughts.push(`⚠️ 风险: ${risks.join(', ')}`);
    }

    const recommendedTool = this.recommendTool(message);
    thoughts.push(`推荐工具: ${recommendedTool}`);

    return {
      content: thoughts.join('\n'),
      confidence: Math.min(confidence, 0.95),
    };
  }

  private identifyCoreNeed(message: string): string {
    if (/写|生成|创建|开发/.test(message)) return '创建/生成内容';
    if (/分析|理解|解释/.test(message)) return '分析/理解';
    if (/修复|解决|调试/.test(message)) return '解决问题';
    if (/搜索|查找|查询/.test(message)) return '获取信息';
    if (/计算|算|统计/.test(message)) return '计算/统计';
    if (/翻译|转换/.test(message)) return '转换/翻译';
    if (/优化|改进|提升/.test(message)) return '优化改进';
    if (/对比|比较|选择/.test(message)) return '比较决策';
    return '通用任务';
  }

  private identifyImplicitNeeds(message: string): string[] {
    const needs: string[] = [];
    if (/写|生成|创建.*代码/.test(message)) {
      needs.push('运行验证', '错误处理');
    }
    if (/分析|统计/.test(message)) {
      needs.push('数据展示', '结论总结');
    }
    if (/搜索|查找/.test(message)) {
      needs.push('信息整理', '来源标注');
    }
    return needs;
  }

  private assessFeasibility(message: string): string {
    const lowerMsg = message.toLowerCase();
    if (/写代码|计算|读取|创建|列出|搜索/.test(lowerMsg)) return '高';
    if (/分析|翻译|优化/.test(lowerMsg)) return '中';
    if (/设计|画|视频|音频/.test(lowerMsg)) return '低';
    return '中';
  }

  private identifyRisks(message: string): string[] {
    const risks: string[] = [];
    if (/删除|清空|格式化/.test(message)) risks.push('数据安全');
    if (/执行|运行|eval/.test(message)) risks.push('代码安全');
    if (/密码|密钥|token/.test(message)) risks.push('隐私泄露');
    return risks;
  }

  private recommendTool(message: string): string {
    if (/写.*代码|编程|开发/.test(message)) return 'code_execute → 生成并运行代码';
    if (/搜索|查找/.test(message)) return 'web_search → 网络搜索';
    if (/读取|查看|打开/.test(message)) return 'file_read → 读取文件';
    if (/创建|写入|保存/.test(message)) return 'file_write → 写入文件';
    if (/列出|目录|结构/.test(message)) return 'list_directory → 浏览目录';
    if (/抓取|网页/.test(message)) return 'web_fetch → 抓取网页';
    if (/命令|执行|运行/.test(message)) return 'shell_execute → 执行命令';
    if (/计算|算|统计/.test(message)) return 'code_execute → 执行计算';
    return '自动选择最佳工具';
  }

  private makePlan(message: string, _thinking: { content: string; confidence: number }): string {
    const lowerMsg = message.toLowerCase();
    const plans: string[] = [];

    if (/写|生成|创建|开发/.test(lowerMsg)) {
      plans.push('1. 分析需求 → 确定语言和功能');
      plans.push('2. 生成代码 → 编写完整实现');
      plans.push('3. 执行代码 → 验证运行结果');
      plans.push('4. 自我反思 → 检查是否有问题');
      plans.push('5. 如果失败 → 自动修复并重试');
    } else if (/搜索|查找|调研/.test(lowerMsg)) {
      plans.push('1. 提取关键词 → 精准搜索');
      plans.push('2. 网络搜索 → 获取信息');
      plans.push('3. 整理结果 → 提取关键信息');
      plans.push('4. 自我反思 → 信息是否充分');
    } else if (/分析|理解|解释/.test(lowerMsg)) {
      plans.push('1. 搜索背景信息');
      plans.push('2. 执行分析代码');
      plans.push('3. 总结结论');
    } else {
      plans.push('1. 识别任务类型');
      plans.push('2. 选择最佳工具执行');
      plans.push('3. 验证结果');
    }

    return plans.join('\n');
  }

  reflect(originalMessage: string, executionResults: string): { quality: number; issues: string[]; suggestions: string[]; shouldRetry: boolean } {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let quality = 0.7;
    let shouldRetry = false;

    if (/错误|失败|error|fail|undefined|null/i.test(executionResults)) {
      issues.push('执行结果包含错误信息');
      quality -= 0.2;
      shouldRetry = true;
    }

    if (!executionResults || executionResults.trim().length < 10) {
      issues.push('执行结果过短，可能不完整');
      quality -= 0.15;
      shouldRetry = true;
    }

    const lowerMsg = originalMessage.toLowerCase();
    if (/写|生成|创建/.test(lowerMsg) && !/成功|完成|created|generated/i.test(executionResults)) {
      issues.push('可能未完成创建任务');
      quality -= 0.1;
    }

    if (issues.length > 0) {
      suggestions.push('尝试用不同方式执行');
      suggestions.push('检查输入参数是否正确');
    }
    if (/代码|编程/.test(lowerMsg)) {
      suggestions.push('可以添加错误处理');
      suggestions.push('可以添加更多功能');
    }
    if (/搜索|查找/.test(lowerMsg)) {
      suggestions.push('可以尝试更具体的关键词');
    }

    return { quality: Math.max(quality, 0), issues, suggestions, shouldRetry };
  }
}

const superBrain = new SuperBrain();

export { superBrain };
