import { describe, it, expect, beforeEach } from 'vitest';
import { PIIDetector } from '../pii-detector.js';

describe('PIIDetector', () => {
  let detector: PIIDetector;

  beforeEach(() => {
    detector = new PIIDetector();
  });

  describe('detect - 基本行为', () => {
    it('无 PII 的文本: hasPII=false, findings 空, riskLevel=low', () => {
      const result = detector.detect('这是一段普通文本，没有敏感信息。');
      expect(result.hasPII).toBe(false);
      expect(result.findings).toHaveLength(0);
      expect(result.riskLevel).toBe('low');
      expect(result.redactedText).toBe('这是一段普通文本，没有敏感信息。');
    });

    it('空字符串无 PII', () => {
      const result = detector.detect('');
      expect(result.hasPII).toBe(false);
      expect(result.findings).toHaveLength(0);
    });

    it('findings 包含 type/value/start/end/confidence/severity', () => {
      const result = detector.detect('我的手机是13812345678');
      expect(result.findings.length).toBeGreaterThan(0);
      const f = result.findings[0];
      expect(f.type).toBe('phone');
      expect(f.value).toBe('13812345678');
      expect(typeof f.start).toBe('number');
      expect(typeof f.end).toBe('number');
      expect(f.end - f.start).toBe(f.value.length);
      expect(typeof f.confidence).toBe('number');
      expect(['low', 'medium', 'high', 'critical']).toContain(f.severity);
    });
  });

  describe('detect - 手机号', () => {
    it('检测中国大陆手机号', () => {
      const result = detector.detect('联系我: 13812345678');
      expect(result.hasPII).toBe(true);
      expect(result.findings.some(f => f.type === 'phone')).toBe(true);
    });

    it('检测带 +86 前缀的手机号', () => {
      const result = detector.detect('电话: +8613812345678');
      expect(result.findings.some(f => f.type === 'phone')).toBe(true);
    });

    it('检测带 +86 和空格的手机号', () => {
      const result = detector.detect('电话: +86 13812345678');
      expect(result.findings.some(f => f.type === 'phone')).toBe(true);
    });

    it('不误检非手机号数字', () => {
      const result = detector.detect('订单号: 12345678901');
      // 12345678901 不以 1[3-9] 开头，不应被检测为手机号
      expect(result.findings.some(f => f.type === 'phone')).toBe(false);
    });

    it('手机号 severity=high', () => {
      const result = detector.detect('13812345678');
      const phone = result.findings.find(f => f.type === 'phone');
      expect(phone?.severity).toBe('high');
    });
  });

  describe('detect - 身份证号', () => {
    it('检测 18 位身份证号', () => {
      const result = detector.detect('身份证: 310101199001011234');
      expect(result.findings.some(f => f.type === 'id_card')).toBe(true);
    });

    it('检测末尾为 X 的身份证号', () => {
      const result = detector.detect('身份证: 31010119900101123X');
      expect(result.findings.some(f => f.type === 'id_card')).toBe(true);
    });

    it('身份证号 severity=critical', () => {
      const result = detector.detect('310101199001011234');
      const id = result.findings.find(f => f.type === 'id_card');
      expect(id?.severity).toBe('critical');
    });
  });

  describe('detect - 银行卡号', () => {
    it('检测 16 位银行卡号', () => {
      const result = detector.detect('卡号: 6222021234567890');
      expect(result.findings.some(f => f.type === 'bank_card')).toBe(true);
    });

    it('检测带空格分隔的银行卡号', () => {
      const result = detector.detect('卡号: 6222 0212 3456 7890');
      expect(result.findings.some(f => f.type === 'bank_card')).toBe(true);
    });

    it('银行卡号 severity=critical', () => {
      const result = detector.detect('6222021234567890');
      const card = result.findings.find(f => f.type === 'bank_card');
      expect(card?.severity).toBe('critical');
    });
  });

  describe('detect - 邮箱', () => {
    it('检测标准邮箱', () => {
      const result = detector.detect('邮箱: test@example.com');
      expect(result.findings.some(f => f.type === 'email')).toBe(true);
    });

    it('检测含子域的邮箱', () => {
      const result = detector.detect('联系: user@mail.example.com');
      expect(result.findings.some(f => f.type === 'email')).toBe(true);
    });

    it('邮箱 severity=medium', () => {
      const result = detector.detect('test@example.com');
      const email = result.findings.find(f => f.type === 'email');
      expect(email?.severity).toBe('medium');
    });
  });

  describe('detect - API Key', () => {
    it('检测 OpenAI API Key (sk-)', () => {
      const result = detector.detect('使用 sk-1234567890abcdefghijklmnopqrst 调用API');
      expect(result.findings.some(f => f.type === 'api_key')).toBe(true);
    });

    it('检测 AWS Access Key (AKIA)', () => {
      const result = detector.detect('凭证 AKIAIOSFODNN7EXAMPLE 已配置');
      expect(result.findings.some(f => f.type === 'api_key')).toBe(true);
    });

    it('检测 GitHub Token (ghp_)', () => {
      // ghp_ 后需要恰好 36 个字母数字字符
      const result = detector.detect('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(result.findings.some(f => f.type === 'api_key')).toBe(true);
    });

    it('API Key severity=critical', () => {
      const result = detector.detect('sk-1234567890abcdefghijklmnopqrst');
      const key = result.findings.find(f => f.type === 'api_key');
      expect(key?.severity).toBe('critical');
    });
  });

  describe('detect - 密码/密钥', () => {
    it('检测 password=xxx 格式', () => {
      const result = detector.detect('password=mysecret123');
      expect(result.findings.some(f => f.type === 'secret')).toBe(true);
    });

    it('检测中文密码格式', () => {
      const result = detector.detect('密码：mypassword');
      expect(result.findings.some(f => f.type === 'secret')).toBe(true);
    });

    it('检测 token=xxx 格式', () => {
      const result = detector.detect('token=abcdef12345678');
      expect(result.findings.some(f => f.type === 'secret')).toBe(true);
    });

    it('secret severity=critical', () => {
      const result = detector.detect('password=mysecret123');
      const secret = result.findings.find(f => f.type === 'secret');
      expect(secret?.severity).toBe('critical');
    });
  });

  describe('detect - JWT', () => {
    it('检测 JWT token', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = detector.detect(`Authorization: Bearer ${jwt}`);
      expect(result.findings.some(f => f.type === 'jwt')).toBe(true);
    });

    it('JWT severity=critical', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = detector.detect(jwt);
      const token = result.findings.find(f => f.type === 'jwt');
      expect(token?.severity).toBe('critical');
    });
  });

  describe('detect - 内网 IP', () => {
    it('检测 10.x.x.x', () => {
      const result = detector.detect('服务器: 10.0.0.1');
      expect(result.findings.some(f => f.type === 'private_ip')).toBe(true);
    });

    it('检测 192.168.x.x', () => {
      const result = detector.detect('内网: 192.168.1.100');
      expect(result.findings.some(f => f.type === 'private_ip')).toBe(true);
    });

    it('检测 172.16.x.x', () => {
      const result = detector.detect('地址: 172.16.0.1');
      expect(result.findings.some(f => f.type === 'private_ip')).toBe(true);
    });

    it('内网 IP severity=medium', () => {
      const result = detector.detect('10.0.0.1');
      const ip = result.findings.find(f => f.type === 'private_ip');
      expect(ip?.severity).toBe('medium');
    });
  });

  describe('detect - 多种 PII 混合', () => {
    it('同时检测多种 PII', () => {
      const text = '手机13812345678，邮箱test@example.com，IP 10.0.0.1';
      const result = detector.detect(text);
      expect(result.findings.length).toBeGreaterThanOrEqual(3);
      const types = result.findings.map(f => f.type);
      expect(types).toContain('phone');
      expect(types).toContain('email');
      expect(types).toContain('private_ip');
    });

    it('多个同类 PII 全部检测', () => {
      const text = '13812345678 和 13987654321';
      const result = detector.detect(text);
      const phones = result.findings.filter(f => f.type === 'phone');
      expect(phones.length).toBe(2);
    });
  });

  describe('风险等级计算', () => {
    it('无 PII → low', () => {
      expect(detector.detect('普通文本').riskLevel).toBe('low');
    });

    it('仅 medium PII (邮箱) → medium', () => {
      expect(detector.detect('test@example.com').riskLevel).toBe('medium');
    });

    it('含 high PII (手机号) → high', () => {
      expect(detector.detect('13812345678').riskLevel).toBe('high');
    });

    it('含 critical PII (身份证) → critical', () => {
      expect(detector.detect('310101199001011234').riskLevel).toBe('critical');
    });

    it('3个以上 high/critical PII → critical', () => {
      const text = '13812345678 13987654321 13711112222';
      const result = detector.detect(text);
      expect(result.riskLevel).toBe('critical');
    });
  });

  describe('redact - 脱敏处理', () => {
    it('partial 级别: 手机号中间4位遮盖', () => {
      const result = detector.detect('13812345678');
      expect(result.redactedText).toContain('138****5678');
    });

    it('partial 级别: 邮箱部分遮盖', () => {
      const result = detector.detect('test@example.com');
      expect(result.redactedText).toContain('t***@example.com');
    });

    it('partial 级别: 身份证部分遮盖', () => {
      const result = detector.detect('310101199001011234');
      expect(result.redactedText).toContain('310***********1234');
    });

    it('partial 级别: 银行卡只保留后4位', () => {
      const result = detector.detect('6222021234567890');
      expect(result.redactedText).toContain('**** **** **** 7890');
    });

    it('mask 级别: 全部用 * 替换', () => {
      const result = detector.detect('13812345678');
      const finding = result.findings[0];
      const masked = detector.redact('13812345678', [finding], 'mask');
      expect(masked).toBe('*'.repeat(11));
    });

    it('replace 级别: 用类型标签替换', () => {
      const result = detector.detect('13812345678');
      const finding = result.findings[0];
      const replaced = detector.redact('13812345678', [finding], 'replace');
      expect(replaced).toContain('[phone已脱敏]');
    });

    it('remove 级别: 直接删除', () => {
      const result = detector.detect('手机13812345678');
      const finding = result.findings.find(f => f.type === 'phone')!;
      const removed = detector.redact('手机13812345678', [finding], 'remove');
      expect(removed).toBe('手机');
    });
  });

  describe('redact - 多个发现的脱敏', () => {
    it('从后往前替换避免位置偏移', () => {
      const text = '13812345678 test@example.com';
      const result = detector.detect(text);
      // 确保两个 PII 都被脱敏
      expect(result.redactedText).not.toContain('13812345678');
      expect(result.redactedText).not.toContain('test@example.com');
      expect(result.redactedText).toContain('138****5678');
      expect(result.redactedText).toContain('t***@example.com');
    });
  });

  describe('addCustomPattern', () => {
    it('添加自定义检测规则', () => {
      detector.addCustomPattern('employee_id', [/EMP\d{6}/g]);
      const result = detector.detect('工号: EMP123456');
      expect(result.findings.some(f => f.type === 'employee_id')).toBe(true);
    });

    it('自定义规则 severity=medium, confidence=0.8', () => {
      detector.addCustomPattern('employee_id', [/EMP\d{6}/g]);
      const result = detector.detect('EMP123456');
      const custom = result.findings.find(f => f.type === 'employee_id');
      expect(custom?.severity).toBe('medium');
      expect(custom?.confidence).toBe(0.8);
    });

    it('自定义规则与内置规则共存', () => {
      detector.addCustomPattern('employee_id', [/EMP\d{6}/g]);
      const result = detector.detect('工号EMP123456，手机13812345678');
      expect(result.findings.some(f => f.type === 'employee_id')).toBe(true);
      expect(result.findings.some(f => f.type === 'phone')).toBe(true);
    });
  });

  describe('去重 - 重叠检测', () => {
    it('重叠的检测结果保留更严重的', () => {
      // 银行卡号 6222021234567890 也可能部分匹配其他规则
      // 确保去重后不重复
      const result = detector.detect('6222021234567890');
      const bankCards = result.findings.filter(f => f.type === 'bank_card');
      // 应该只有1个银行卡检测结果（去重后）
      expect(bankCards.length).toBe(1);
    });
  });
});
