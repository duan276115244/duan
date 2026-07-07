/**
 * 敏感信息检测器 (PII Detector)
 * 检测和脱敏文本中的个人可识别信息
 */

/** PII 检测结果 */
interface PIIDetectionResult {
  hasPII: boolean;
  findings: PIIFinding[];
  redactedText: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

/** 单个 PII 发现 */
interface PIIFinding {
  type: string;
  value: string;
  start: number;
  end: number;
  confidence: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/** 脱敏级别 */
type RedactionLevel = 'mask' | 'partial' | 'replace' | 'remove';

/** PII 规则定义 */
interface PIIRule {
  type: string;
  name: string;
  patterns: RegExp[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  redactionTemplate: string;
}

export class PIIDetector {
  private rules: PIIRule[] = [];
  private customPatterns: Map<string, RegExp[]> = new Map();

  constructor() {
    this.initializeRules();
  }

  /**
   * 检测文本中的 PII
   */
  detect(text: string): PIIDetectionResult {
    const findings: PIIFinding[] = [];

    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
          findings.push({
            type: rule.type,
            value: match[0],
            start: match.index,
            end: match.index + match[0].length,
            confidence: 0.9,
            severity: rule.severity,
          });
        }
      }
    }

    // 自定义规则检测
    for (const [type, patterns] of this.customPatterns) {
      for (const pattern of patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
          findings.push({
            type,
            value: match[0],
            start: match.index,
            end: match.index + match[0].length,
            confidence: 0.8,
            severity: 'medium',
          });
        }
      }
    }

    // 去重（重叠的检测结果保留更严重的）
    const deduplicated = this.deduplicateFindings(findings);

    // 脱敏
    const redactedText = this.redact(text, deduplicated, 'partial');

    // 计算风险等级
    const riskLevel = this.calculateRiskLevel(deduplicated);

    return {
      hasPII: deduplicated.length > 0,
      findings: deduplicated,
      redactedText,
      riskLevel,
    };
  }

  /**
   * 脱敏处理
   */
  redact(text: string, findings: PIIFinding[], level: RedactionLevel = 'partial'): string {
    // 按位置倒序排列，从后往前替换避免偏移
    const sorted = [...findings].sort((a, b) => b.start - a.start);

    let result = text;

    for (const finding of sorted) {
      const replacement = this.getRedactedValue(finding, level);
      result = result.substring(0, finding.start) + replacement + result.substring(finding.end);
    }

    return result;
  }

  /**
   * 获取脱敏后的值
   */
  private getRedactedValue(finding: PIIFinding, level: RedactionLevel): string {
    switch (level) {
      case 'mask':
        return '*'.repeat(finding.value.length);
      case 'partial':
        return this.partialMask(finding.value, finding.type);
      case 'replace':
        return `[${finding.type}已脱敏]`;
      case 'remove':
        return '';
      default:
        return '[REDACTED]';
    }
  }

  /**
   * 部分遮盖
   */
  private partialMask(value: string, type: string): string {
    switch (type) {
      case 'phone':
        // 138****1234
        if (value.length >= 7) {
          return value.substring(0, 3) + '****' + value.substring(value.length - 4);
        }
        return '****';
      case 'email': {
        // t***@example.com
        const atIndex = value.indexOf('@');
        if (atIndex > 1) {
          return value[0] + '***' + value.substring(atIndex);
        }
        return '***@***';
      }
      case 'id_card':
        // 310***********1234
        if (value.length >= 7) {
          return value.substring(0, 3) + '***********' + value.substring(value.length - 4);
        }
        return '***********';
      case 'bank_card':
        // **** **** **** 1234
        if (value.length >= 4) {
          return '**** **** **** ' + value.substring(value.length - 4);
        }
        return '****';
      case 'api_key':
      case 'secret':
        return '***[已隐藏]';
      default:
        if (value.length <= 2) return '***';
        return value[0] + '*'.repeat(value.length - 2) + value[value.length - 1];
    }
  }

  /**
   * 去重检测结果
   */
  private deduplicateFindings(findings: PIIFinding[]): PIIFinding[] {
    if (findings.length <= 1) return findings;

    // 按起始位置排序
    const sorted = [...findings].sort((a, b) => a.start - b.start);
    const result: PIIFinding[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = result[result.length - 1];
      const curr = sorted[i];

      // 如果重叠，保留更严重的
      if (curr.start < prev.end) {
        const severityOrder: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
        if (severityOrder[curr.severity] > severityOrder[prev.severity]) {
          result[result.length - 1] = curr;
        }
      } else {
        result.push(curr);
      }
    }

    return result;
  }

  /**
   * 计算风险等级
   */
  private calculateRiskLevel(findings: PIIFinding[]): 'low' | 'medium' | 'high' | 'critical' {
    if (findings.length === 0) return 'low';

    const severityOrder: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
    let maxSeverity = 0;

    for (const finding of findings) {
      const severity = severityOrder[finding.severity] || 0;
      maxSeverity = Math.max(maxSeverity, severity);
    }

    // 高风险PII数量多时升级风险
    const highSeverityCount = findings.filter(f => severityOrder[f.severity] >= 2).length;
    if (highSeverityCount >= 3) {
      maxSeverity = Math.max(maxSeverity, 3);
    }

    const levels: Array<'low' | 'medium' | 'high' | 'critical'> = ['low', 'medium', 'high', 'critical'];
    return levels[maxSeverity] || 'low';
  }

  /**
   * 添加自定义检测规则
   */
  addCustomPattern(type: string, patterns: RegExp[]): void {
    this.customPatterns.set(type, patterns);
  }

  /**
   * 初始化 PII 检测规则
   */
  private initializeRules(): void {
    this.rules = [
      // ---- 中国手机号 ----
      {
        type: 'phone',
        name: '中国手机号',
        patterns: [
          /(?<!\w)(1[3-9]\d{9})(?!\w)/g,
          /(?<!\w)(\+86[-\s]?1[3-9]\d{9})(?!\w)/g,
        ],
        severity: 'high',
        redactionTemplate: '[手机号]',
      },
      // ---- 身份证号 ----
      {
        type: 'id_card',
        name: '身份证号',
        patterns: [
          /(?<!\w)(\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\w)/g,
        ],
        severity: 'critical',
        redactionTemplate: '[身份证号]',
      },
      // ---- 银行卡号 ----
      {
        type: 'bank_card',
        name: '银行卡号',
        patterns: [
          /(?<!\w)(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})(?!\w)/g,
          /(?<!\w)(6\d{15,18})(?!\w)/g,
        ],
        severity: 'critical',
        redactionTemplate: '[银行卡号]',
      },
      // ---- 邮箱 ----
      {
        type: 'email',
        name: '电子邮箱',
        patterns: [
          /(?<!\w)([\w.-]+@[\w.-]+\.\w{2,})(?!\w)/gi,
        ],
        severity: 'medium',
        redactionTemplate: '[邮箱]',
      },
      // ---- API Key ----
      {
        type: 'api_key',
        name: 'API密钥',
        patterns: [
          /(?<!\w)(sk-[a-zA-Z0-9]{20,})(?!\w)/g,                    // OpenAI
          /(?<!\w)(sk-ant-api03-[a-zA-Z0-9-]{20,})(?!\w)/g,        // Anthropic
          /(?<!\w)(AKIA[0-9A-Z]{16})(?!\w)/g,                        // AWS
          /(?<!\w)(AIza[a-zA-Z0-9-_]{35})(?!\w)/g,                  // Google
          /(?<!\w)(ghp_[a-zA-Z0-9]{36})(?!\w)/g,                     // GitHub
          /(?<!\w)(glpat-[a-zA-Z0-9-]{20,})(?!\w)/g,                // GitLab
        ],
        severity: 'critical',
        redactionTemplate: '[API密钥]',
      },
      // ---- 密码/密钥 ----
      {
        type: 'secret',
        name: '密码/密钥',
        patterns: [
          /(?:password|passwd|pwd|secret|token|key)\s*[:=]\s*["']?([^\s"']{8,})/gi,
          /(?:密码|口令|密钥)\s*[:：]\s*["']?([^\s"']{4,})/g,
        ],
        severity: 'critical',
        redactionTemplate: '[密码]',
      },
      // ---- JWT Token ----
      {
        type: 'jwt',
        name: 'JWT令牌',
        patterns: [
          /(?<!\w)(eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)(?!\w)/g,
        ],
        severity: 'critical',
        redactionTemplate: '[JWT]',
      },
      // ---- IP地址（内网） ----
      {
        type: 'private_ip',
        name: '内网IP',
        patterns: [
          /(?<!\w)(10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\w)/g,
          /(?<!\w)(172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\w)/g,
          /(?<!\w)(192\.168\.\d{1,3}\.\d{1,3})(?!\w)/g,
        ],
        severity: 'medium',
        redactionTemplate: '[内网IP]',
      },
    ];
  }
}
