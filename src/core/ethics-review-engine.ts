/**
 * 伦理审查引擎 — EthicsReviewEngine
 *
 * 文档六·伦理框架的落地实现。在工具执行前对工具参数做规则化伦理审查：
 * - 6 类规则：暴力伤害 / 隐私泄露 / 未授权访问 / 欺诈欺骗 / 自残自伤 / 有害内容
 * - 严重度分级：low（警告放行）/ medium+（拒绝执行）
 * - 可被 LLM 主动调用（ethics_review 工具）预检请求是否合规
 * - 集成到 enhanced-agent-loop 工具执行前置管线（与 ApprovalGate 并列）
 *
 * 设计原则：
 * 1. 规则化优先 — 用正则/关键词而非 LLM，零延迟、可审计、无误判漂移
 * 2. 保守拒绝 — 严重度 ≥ medium 一律拒绝；low 仅警告不拦截
 * 3. 上下文缓解 — 已授权的安全测试/CTF/防御性研究上下文可降低风险（mitigate）
 * 4. 失败安全 — 引擎自身异常不阻塞工具执行（降级为放行 + 告警）
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

export type EthicsCategory =
  | 'violence'        // 暴力伤害：武器制造、人身伤害指导
  | 'privacy'         // 隐私泄露：PII/凭证外传、窃取凭据
  | 'unauthorized_access' // 未授权访问：越权访问系统/文件、扫描未授权目标
  | 'deception'       // 欺诈欺骗：钓鱼、社会工程、伪造身份
  | 'self_harm'       // 自残自伤：自杀/自残方法指导
  | 'harmful_content'; // 有害内容：恶意软件/勒索/钓鱼套件制造

export type EthicsSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface EthicsRule {
  id: string;
  category: EthicsCategory;
  description: string;
  severity: EthicsSeverity;
  /** 对序列化后参数文本做大小写不敏感匹配的正则 */
  pattern: RegExp;
  /** 仅对匹配的工具名生效（glob，如 'shell_*'）；undefined 表示对所有工具生效 */
  toolNamePattern?: string;
  enabled: boolean;
}

export interface EthicsViolation {
  ruleId: string;
  category: EthicsCategory;
  severity: EthicsSeverity;
  description: string;
  /** 命中的文本片段（截断到 80 字符，避免泄露完整敏感内容） */
  matchedSnippet: string;
}

export interface EthicsReviewResult {
  approved: boolean;
  violations: EthicsViolation[];
  reason: string;
  reviewedAt: number;
  /** 命中的最高严重度（无违规则为 'low'） */
  maxSeverity: EthicsSeverity;
}

export interface EthicsReviewInput {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  /** 可选任务上下文（用于缓解判定，如 "authorized pentest"） */
  context?: string;
}

export interface EthicsStats {
  totalReviews: number;
  approved: number;
  denied: number;
  byCategory: Record<EthicsCategory, number>;
  bySeverity: Record<EthicsSeverity, number>;
  ruleCount: number;
}

// ============ 辅助函数 ============

/** 简易 glob 匹配（与 ApprovalGate 一致） */
function globMatch(pattern: string, text: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(text);
}

/** 把任意参数深度序列化为字符串（含嵌套对象/数组） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stringifyArgs(args: any): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** 截取命中片段（脱敏：只保留匹配周围上下文） */
function snippet(text: string, match: RegExpMatchArray): string {
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + (match[0]?.length ?? 0) + 20);
  return text.slice(start, end).substring(0, 80);
}

const SEVERITY_ORDER: Record<EthicsSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// ============ 主类 ============

export class EthicsReviewEngine {
  private rules: Map<string, EthicsRule> = new Map();
  private log = logger.child({ module: 'EthicsReviewEngine' });

  // 统计
  private totalReviews = 0;
  private approvedCount = 0;
  private deniedCount = 0;
  private byCategory: Record<EthicsCategory, number> = {
    violence: 0, privacy: 0, unauthorized_access: 0,
    deception: 0, self_harm: 0, harmful_content: 0,
  };
  private bySeverity: Record<EthicsSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };

  constructor() {
    this.registerDefaultRules();
    this.log.info('伦理审查引擎初始化完成', { defaultRules: this.rules.size });
  }

  // ========== 默认规则 ==========

  private registerDefaultRules(): void {
    // ===== 1. 暴力伤害 =====
    this.registerRule({
      id: 'violence_weapon_manufacture',
      category: 'violence',
      description: '制造武器/爆炸物/致命器具的指导',
      severity: 'critical',
      pattern: /(how\s*to\s*(make|build|manufacture))\s+(a\s+)?(bomb|explosive|firearm|gun|weapon|pipe\s+bomb|pressure\s+cooker|grenade)|(制造|制作|做)\s*(炸弹|爆炸物|枪|武器|手雷|燃烧弹)/i,
      enabled: true,
    });
    this.registerRule({
      id: 'violence_harm_instructions',
      category: 'violence',
      description: '伤害他人的具体方法指导',
      severity: 'high',
      pattern: /(how\s*to\s*(hurt|injure|kill|poison|stab))\s+(a\s+)?(person|someone|human)|(如何|怎么)\s*(伤害|杀人|投毒|刺伤)/i,
      enabled: true,
    });

    // ===== 2. 隐私泄露 =====
    this.registerRule({
      id: 'privacy_credential_exfiltration',
      category: 'privacy',
      description: '将凭证/密钥/.env 内容外传到外部端点',
      severity: 'critical',
      pattern: /(curl|wget|fetch|http_request|http_post|web_fetch).*(api[_-]?key|secret|password|token|\.env|credentials|private[_-]?key)/i,
      enabled: true,
    });
    this.registerRule({
      id: 'privacy_pii_collection',
      category: 'privacy',
      description: '批量收集/窃取个人身份信息（身份证/护照/银行卡）',
      severity: 'high',
      pattern: /(身份证|护照|银行卡|信用卡|social\s+security|ssn|credit\s+card\s+number).*(收集|批量|爬取|dump|scrape|harvest)/i,
      enabled: true,
    });
    this.registerRule({
      id: 'privacy_ssh_key_access',
      category: 'privacy',
      description: '读取 SSH/AWS 凭证文件（常用于横向移动）',
      severity: 'high',
      pattern: /(\.ssh\/id_|\.aws\/credentials|\.env\b|\/etc\/shadow|\/etc\/passwd)/i,
      enabled: true,
    });

    // ===== 3. 未授权访问 =====
    this.registerRule({
      id: 'unauth_path_traversal',
      category: 'unauthorized_access',
      description: '路径穿越访问项目外文件',
      severity: 'medium',
      pattern: /(\.\.\/){2,}|(\.\.\\){2,}|\.\.\/etc\/|\.\.\\windows\\/i,
      enabled: true,
    });
    this.registerRule({
      id: 'unauth_network_scan',
      category: 'unauthorized_access',
      description: '对未授权目标进行网络扫描/渗透',
      severity: 'medium',
      pattern: /(nmap|masscan|sqlmap|hydra|metasploit).+(-sS|-sV|--script|-T4|target|targets)/i,
      enabled: true,
    });

    // ===== 4. 欺诈欺骗 =====
    this.registerRule({
      id: 'deception_phishing',
      category: 'deception',
      description: '生成钓鱼邮件/钓鱼页面',
      severity: 'high',
      pattern: /(phishing\s+(email|page|site|kit)|钓鱼邮件|钓鱼网站|仿冒登录页)/i,
      enabled: true,
    });
    this.registerRule({
      id: 'deception_social_engineering',
      category: 'deception',
      description: '社会工程脚本/伪造身份',
      severity: 'medium',
      pattern: /(social\s+engineering\s+(script|attack)|impersonate|伪造身份|冒充).*(attack|attack|script|target)/i,
      enabled: true,
    });

    // ===== 5. 自残自伤 =====
    this.registerRule({
      id: 'self_harm_methods',
      category: 'self_harm',
      description: '自杀/自残方法指导',
      severity: 'critical',
      pattern: /(how\s*to\s*(commit\s+suicide|kill\s+myself|hurt\s+myself)|suicide\s+method|自杀方法|自残方法)/i,
      enabled: true,
    });

    // ===== 6. 有害内容（恶意软件） =====
    this.registerRule({
      id: 'harmful_malware_creation',
      category: 'harmful_content',
      description: '创建恶意软件/勒索软件/后门',
      severity: 'high',
      pattern: /(create|build|write|develop)\s+(a\s+)?(ransomware|malware|trojan|backdoor|rootkit|keylogger|worm|botnet)|(编写|开发|制作)\s*(勒索软件|恶意软件|木马|后门|rootkit|键盘记录器)/i,
      enabled: true,
    });
    this.registerRule({
      id: 'harmful_exploit_weaponize',
      category: 'harmful_content',
      description: '武器化漏洞利用（针对真实目标）',
      severity: 'medium',
      pattern: /(weaponize|weaponise|武器化).*(exploit|cve)|exploit.+(weaponize|payload)/i,
      enabled: true,
    });
  }

  // ========== 规则注册 ==========

  registerRule(rule: EthicsRule): { registered: boolean; id: string; message: string } {
    if (!rule.id || !rule.pattern) {
      return { registered: false, id: rule.id, message: '规则缺少 id 或 pattern' };
    }
    const isUpdate = this.rules.has(rule.id);
    this.rules.set(rule.id, rule);
    this.log.debug(isUpdate ? '更新伦理规则' : '注册伦理规则', { id: rule.id, category: rule.category });
    return { registered: true, id: rule.id, message: isUpdate ? `规则 ${rule.id} 已更新` : `规则 ${rule.id} 已注册` };
  }

  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  getRules(): EthicsRule[] {
    return Array.from(this.rules.values());
  }

  // ========== 审查 ==========

  /**
   * 审查工具调用是否合规
   * @returns EthicsReviewResult — approved=false 时拒绝执行
   */
  review(input: EthicsReviewInput): EthicsReviewResult {
    this.totalReviews++;
    const reviewedAt = Date.now();
    // 扫描文本 = toolName + 参数序列化 — 让基于工具名的规则（如 http_request 凭证外传）能命中
    const text = `${input.toolName || ''} ${stringifyArgs(input.args)}`;
    const ctx = (input.context || '').toLowerCase();

    const violations: EthicsViolation[] = [];

    for (const rule of Array.from(this.rules.values())) {
      if (!rule.enabled) continue;
      // 工具名过滤
      if (rule.toolNamePattern && !globMatch(rule.toolNamePattern, input.toolName)) continue;

      const match = text.match(rule.pattern);
      if (!match) continue;

      // 上下文缓解：授权安全测试/CTF/防御性研究降低一级严重度
      let effectiveSeverity = rule.severity;
      if (this.isMitigatingContext(ctx) && SEVERITY_ORDER[rule.severity] > 0) {
        const levels: EthicsSeverity[] = ['low', 'medium', 'high', 'critical'];
        effectiveSeverity = levels[SEVERITY_ORDER[rule.severity] - 1];
      }

      violations.push({
        ruleId: rule.id,
        category: rule.category,
        severity: effectiveSeverity,
        description: rule.description,
        matchedSnippet: snippet(text, match),
      });
    }

    // 统计
    let maxSeverity: EthicsSeverity = 'low';
    for (const v of violations) {
      this.byCategory[v.category]++;
      this.bySeverity[v.severity]++;
      if (SEVERITY_ORDER[v.severity] > SEVERITY_ORDER[maxSeverity]) maxSeverity = v.severity;
    }

    // 决策：severity >= medium → 拒绝
    const denied = SEVERITY_ORDER[maxSeverity] >= SEVERITY_ORDER['medium'];

    if (denied) {
      this.deniedCount++;
      const cats = Array.from(new Set(violations.map(v => v.category))).join(', ');
      const reason = `伦理审查拒绝：命中 ${violations.length} 条规则（${cats}），最高严重度 ${maxSeverity}`;

      this.log.warn('工具调用被伦理审查拒绝', {
        toolName: input.toolName,
        violations: violations.length,
        maxSeverity,
        categories: cats,
      });

      try {
        EventBus.getInstance().emitSync('ethics.violation', {
          toolName: input.toolName,
          violations: violations.map(v => ({ ruleId: v.ruleId, category: v.category, severity: v.severity })),
          maxSeverity,
          denied: true,
        }, { source: 'EthicsReviewEngine' });
      } catch { /* 事件失败不影响审查 */ }

      return { approved: false, violations, reason, reviewedAt, maxSeverity };
    }

    this.approvedCount++;
    const reason = violations.length === 0
      ? '伦理审查通过：未命中任何规则'
      : `伦理审查通过（带警告）：命中 ${violations.length} 条 low 级规则`;

    if (violations.length > 0) {
      this.log.info('伦理审查带警告放行', {
        toolName: input.toolName,
        warnings: violations.length,
      });
    }

    return { approved: true, violations, reason, reviewedAt, maxSeverity };
  }

  /** 判断上下文是否为缓解性（授权安全研究/CTF/防御） */
  private isMitigatingContext(ctx: string): boolean {
    const mitigating = [
      'authorized', 'authorised', 'pentest', 'pen-test', 'pen test',
      'ctf', 'capture the flag', 'security research', 'defensive',
      'bug bounty', 'vulnerability research', 'red team',
      '授权', '安全测试', '渗透测试', '防御性', '漏洞研究',
    ];
    return mitigating.some(kw => ctx.includes(kw));
  }

  // ========== 统计 ==========

  getStats(): EthicsStats {
    return {
      totalReviews: this.totalReviews,
      approved: this.approvedCount,
      denied: this.deniedCount,
      byCategory: { ...this.byCategory },
      bySeverity: { ...this.bySeverity },
      ruleCount: this.rules.size,
    };
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
    const engine = this;
    return [
      {
        name: 'ethics_review',
        description: '审查一个工具调用或请求是否符合伦理规则（暴力/隐私/未授权/欺诈/自残/有害内容）。返回 approved=true/false 及命中规则。只读，不改变状态。在不确定请求是否合规时主动调用。',
        parameters: {
          toolName: { type: 'string', description: '待审查的工具名或操作名', required: true },
          args: { type: 'string', description: '待审查的参数（JSON 字符串）', required: false },
          context: { type: 'string', description: '任务上下文（如 authorized pentest 可降低风险）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const toolName = String(args.toolName || '');
            let parsedArgs: unknown = {};
            if (args.args) {
              try { parsedArgs = JSON.parse(String(args.args)); }
              catch { parsedArgs = String(args.args); }
            }
            const result = engine.review({
              toolName,
              args: parsedArgs,
              context: args.context ? String(args.context) : undefined,
            });
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`伦理审查失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'ethics_rules',
        description: '查看所有已注册的伦理审查规则及其类别、严重度。只读。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const rules = engine.getRules();
          const stats = engine.getStats();
          const lines = rules.map(r =>
            `  ${r.enabled ? '✅' : '❌'} [${r.severity}] ${r.id} (${r.category})\n    ${r.description}` +
            (r.toolNamePattern ? `\n    仅工具: ${r.toolNamePattern}` : '')
          );
          return Promise.resolve([
            `🛡️ 伦理审查规则 (${rules.length}条):`,
            '',
            ...lines,
            '',
            `📊 统计: 总审查${stats.totalReviews} | 通过${stats.approved} | 拒绝${stats.denied}`,
          ].join('\n'));
        },
      },
    ];
  }
}
