import { describe, it, expect, afterEach } from 'vitest';
import { ApiKeyEncryption } from '../security-middleware.js';

// ============================================================================
// ApiKeyEncryption 单元测试
// 基于 AES-256-GCM 算法，密文格式为 `iv:authTag:encrypted`（均为 hex 编码）
// ============================================================================
describe('ApiKeyEncryption API Key 加密工具', () => {
  describe('encrypt/decrypt 往返测试', () => {
    it('普通文本加密后解密应还原原文', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'sk-abc123xyz';
      const ciphertext = enc.encrypt(plaintext);
      expect(enc.decrypt(ciphertext)).toBe(plaintext);
    });

    it('多次加密同一文本均能正确解密', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'my-secret-api-key';
      for (let i = 0; i < 5; i++) {
        const ciphertext = enc.encrypt(plaintext);
        expect(enc.decrypt(ciphertext)).toBe(plaintext);
      }
    });

    it('不同实例（同主密钥）加密的密文可互相解密', () => {
      const enc1 = new ApiKeyEncryption('shared-key');
      const enc2 = new ApiKeyEncryption('shared-key');
      const plaintext = 'cross-instance-test';
      // enc1 加密，enc2 解密
      const ciphertext = enc1.encrypt(plaintext);
      expect(enc2.decrypt(ciphertext)).toBe(plaintext);
    });
  });

  describe('不同明文产生不同密文', () => {
    it('不同明文加密后密文不同', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const c1 = enc.encrypt('plaintext-a');
      const c2 = enc.encrypt('plaintext-b');
      expect(c1).not.toBe(c2);
    });

    it('同一明文加密两次密文不同（随机 IV）', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'same-plaintext';
      const c1 = enc.encrypt(plaintext);
      const c2 = enc.encrypt(plaintext);
      // 由于每次加密使用随机 IV，密文应不同
      expect(c1).not.toBe(c2);
    });

    it('同一明文加密两次解密后均得到原文', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'same-plaintext';
      const c1 = enc.encrypt(plaintext);
      const c2 = enc.encrypt(plaintext);
      expect(enc.decrypt(c1)).toBe(plaintext);
      expect(enc.decrypt(c2)).toBe(plaintext);
    });

    it('密文不包含明文（机密性）', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'secret-value-123';
      const ciphertext = enc.encrypt(plaintext);
      // 密文为 hex 字符串，不应直接包含明文片段
      expect(ciphertext).not.toContain(plaintext);
    });
  });

  describe('错误密文应抛异常', () => {
    it('密文格式错误（缺少分隔符）应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      expect(() => enc.decrypt('invalidciphertext')).toThrow('Invalid encrypted format');
    });

    it('密文格式错误（只有 2 部分）应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      expect(() => enc.decrypt('aaaa:bbbb')).toThrow('Invalid encrypted format');
    });

    it('密文格式错误（多于 3 部分）应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      expect(() => enc.decrypt('aaaa:bbbb:cccc:dddd')).toThrow('Invalid encrypted format');
    });

    it('密文格式错误（空字符串）应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      expect(() => enc.decrypt('')).toThrow('Invalid encrypted format');
    });

    it('篡改密文部分应抛异常（GCM 认证失败）', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'original-text';
      const ciphertext = enc.encrypt(plaintext);
      const parts = ciphertext.split(':');
      // 篡改加密数据部分（翻转最后一个 hex 字符）
      const encrypted = parts[2];
      const lastChar = encrypted.charAt(encrypted.length - 1);
      const flippedChar = lastChar === '0' ? '1' : '0';
      const tamperedEncrypted = encrypted.slice(0, -1) + flippedChar;
      const tampered = `${parts[0]}:${parts[1]}:${tamperedEncrypted}`;
      expect(() => enc.decrypt(tampered)).toThrow();
    });

    it('篡改 authTag 应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'original-text';
      const ciphertext = enc.encrypt(plaintext);
      const parts = ciphertext.split(':');
      // 篡改 authTag（翻转最后一个 hex 字符）
      const authTag = parts[1];
      const lastChar = authTag.charAt(authTag.length - 1);
      const flippedChar = lastChar === '0' ? '1' : '0';
      const tamperedAuthTag = authTag.slice(0, -1) + flippedChar;
      const tampered = `${parts[0]}:${tamperedAuthTag}:${parts[2]}`;
      expect(() => enc.decrypt(tampered)).toThrow();
    });

    it('篡改 IV 应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      const plaintext = 'original-text';
      const ciphertext = enc.encrypt(plaintext);
      const parts = ciphertext.split(':');
      // 篡改 IV（翻转最后一个 hex 字符）
      const iv = parts[0];
      const lastChar = iv.charAt(iv.length - 1);
      const flippedChar = lastChar === '0' ? '1' : '0';
      const tamperedIv = iv.slice(0, -1) + flippedChar;
      const tampered = `${tamperedIv}:${parts[1]}:${parts[2]}`;
      expect(() => enc.decrypt(tampered)).toThrow();
    });

    it('使用不同 masterKey 解密应抛异常', () => {
      const enc1 = new ApiKeyEncryption('key-a');
      const enc2 = new ApiKeyEncryption('key-b');
      const ciphertext = enc1.encrypt('secret-text');
      expect(() => enc2.decrypt(ciphertext)).toThrow();
    });

    it('无效 hex 字符的密文应抛异常', () => {
      const enc = new ApiKeyEncryption('test-master-key');
      // 包含非 hex 字符 'zz'
      expect(() => enc.decrypt('zzzz:bbbb:cccc')).toThrow();
    });
  });

  describe('自定义 masterKey', () => {
    it('使用自定义 masterKey 加密解密往返', () => {
      const enc = new ApiKeyEncryption('my-custom-master-key');
      const plaintext = 'api-key-12345';
      const ciphertext = enc.encrypt(plaintext);
      expect(enc.decrypt(ciphertext)).toBe(plaintext);
    });

    it('不同 masterKey 加密的密文不能互相解密', () => {
      const enc1 = new ApiKeyEncryption('master-key-1');
      const enc2 = new ApiKeyEncryption('master-key-2');
      const ciphertext = enc1.encrypt('secret');
      expect(() => enc2.decrypt(ciphertext)).toThrow();
    });

    it('相同 masterKey 字符串派生出相同密钥（可互相解密）', () => {
      const enc1 = new ApiKeyEncryption('same-key');
      const enc2 = new ApiKeyEncryption('same-key');
      const ciphertext = enc1.encrypt('data');
      expect(enc2.decrypt(ciphertext)).toBe('data');
    });

    it('短 masterKey 也能正常工作', () => {
      const enc = new ApiKeyEncryption('a');
      const plaintext = 'short-key-test';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('长 masterKey 也能正常工作', () => {
      const longKey = 'a'.repeat(1000);
      const enc = new ApiKeyEncryption(longKey);
      const plaintext = 'long-key-test';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含 Unicode 的 masterKey 也能正常工作', () => {
      const enc = new ApiKeyEncryption('密钥-🔑-key');
      const plaintext = 'unicode-key-test';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });
  });

  describe('默认主密钥（机器特征派生）', () => {
    it('不传 masterKey 时不抛错', () => {
      expect(() => new ApiKeyEncryption()).not.toThrow();
    });

    it('默认主密钥加密解密往返', () => {
      const enc = new ApiKeyEncryption();
      const plaintext = 'default-key-test';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('两个默认实例可互相解密（同一机器派生相同密钥）', () => {
      const enc1 = new ApiKeyEncryption();
      const enc2 = new ApiKeyEncryption();
      const plaintext = 'machine-derived-key';
      const ciphertext = enc1.encrypt(plaintext);
      expect(enc2.decrypt(ciphertext)).toBe(plaintext);
    });
  });

  describe('ENCRYPTION_MASTER_KEY 环境变量', () => {
    const originalEnv = process.env.ENCRYPTION_MASTER_KEY;

    afterEach(() => {
      // 恢复环境变量
      if (originalEnv === undefined) {
        delete process.env.ENCRYPTION_MASTER_KEY;
      } else {
        process.env.ENCRYPTION_MASTER_KEY = originalEnv;
      }
    });

    it('设置环境变量时不传 masterKey 使用环境变量派生密钥', () => {
      process.env.ENCRYPTION_MASTER_KEY = 'env-master-key';
      const enc1 = new ApiKeyEncryption();
      // 用相同环境变量值作为 masterKey 构造另一个实例，应派生出相同密钥
      const enc2 = new ApiKeyEncryption('env-master-key');
      const plaintext = 'env-key-test';
      const ciphertext = enc1.encrypt(plaintext);
      expect(enc2.decrypt(ciphertext)).toBe(plaintext);
    });

    it('显式传入 masterKey 优先于环境变量', () => {
      process.env.ENCRYPTION_MASTER_KEY = 'env-key';
      const enc1 = new ApiKeyEncryption('explicit-key');
      const enc2 = new ApiKeyEncryption('explicit-key');
      // enc1 使用 explicit-key（显式传入），enc2 也使用 explicit-key
      // 两者应能互相解密，证明显式传入优先
      const plaintext = 'priority-test';
      const ciphertext = enc1.encrypt(plaintext);
      expect(enc2.decrypt(ciphertext)).toBe(plaintext);

      // 使用环境变量派生的实例应无法解密
      const encEnv = new ApiKeyEncryption('env-key');
      expect(() => encEnv.decrypt(ciphertext)).toThrow();
    });

    it('不同环境变量派生的密钥不能互相解密', () => {
      process.env.ENCRYPTION_MASTER_KEY = 'env-key-a';
      const enc1 = new ApiKeyEncryption();
      const ciphertext = enc1.encrypt('data');

      process.env.ENCRYPTION_MASTER_KEY = 'env-key-b';
      const enc2 = new ApiKeyEncryption();
      expect(() => enc2.decrypt(ciphertext)).toThrow();
    });
  });

  describe('空字符串与特殊字符', () => {
    const enc = new ApiKeyEncryption('test-master-key');

    it('空字符串加密解密往返', () => {
      const plaintext = '';
      const ciphertext = enc.encrypt(plaintext);
      expect(enc.decrypt(ciphertext)).toBe(plaintext);
    });

    it('空字符串密文格式正确（3 部分）', () => {
      const ciphertext = enc.encrypt('');
      const parts = ciphertext.split(':');
      expect(parts).toHaveLength(3);
    });

    it('特殊字符（符号）加密解密往返', () => {
      const plaintext = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('中文字符加密解密往返', () => {
      const plaintext = '这是一段中文 API 密钥测试 🔑';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('emoji 加密解密往返', () => {
      const plaintext = '🔑🔐🗝️💰💳';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('JSON 字符串加密解密往返', () => {
      const plaintext = JSON.stringify({ key: 'value', nested: { a: 1, b: [1, 2, 3] } });
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含冒号的字符串加密解密往返', () => {
      // 注意：原文中的冒号不影响，因为加密输出为 hex
      const plaintext = 'host:port:database:user:password';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含换行符的字符串加密解密往返', () => {
      const plaintext = 'line1\nline2\nline3\r\nline4';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含制表符的字符串加密解密往返', () => {
      const plaintext = 'col1\tcol2\tcol3';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含 null 字节的字符串加密解密往返', () => {
      const plaintext = 'before\0after';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含引号的字符串加密解密往返', () => {
      const plaintext = `"double" and 'single' quotes`;
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('包含反斜杠的字符串加密解密往返', () => {
      const plaintext = 'path\\to\\file and \\n \\t escapes';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });
  });

  describe('长文本与边界情况', () => {
    const enc = new ApiKeyEncryption('test-master-key');

    it('单字符加密解密往返', () => {
      const plaintext = 'a';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('正好 16 字节（AES 块大小）加密解密往返', () => {
      const plaintext = 'a'.repeat(16);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('15 字节（小于一个 AES 块）加密解密往返', () => {
      const plaintext = 'a'.repeat(15);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('17 字节（略大于一个 AES 块）加密解密往返', () => {
      const plaintext = 'a'.repeat(17);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('32 字节（两个 AES 块）加密解密往返', () => {
      const plaintext = 'a'.repeat(32);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('1000 字符加密解密往返', () => {
      const plaintext = 'x'.repeat(1000);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('10000 字符长文本加密解密往返', () => {
      const plaintext = 'A'.repeat(10000);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('长文本密文不包含明文', () => {
      const plaintext = 'SECRET-'.repeat(1000);
      const ciphertext = enc.encrypt(plaintext);
      expect(ciphertext).not.toContain('SECRET-');
    });
  });

  describe('密文格式验证', () => {
    const enc = new ApiKeyEncryption('test-master-key');

    it('密文包含两个冒号分隔符', () => {
      const ciphertext = enc.encrypt('test');
      const colonCount = (ciphertext.match(/:/g) || []).length;
      expect(colonCount).toBe(2);
    });

    it('密文分为 3 部分', () => {
      const ciphertext = enc.encrypt('test');
      expect(ciphertext.split(':')).toHaveLength(3);
    });

    it('IV 部分为 32 个 hex 字符（16 字节）', () => {
      const ciphertext = enc.encrypt('test');
      const iv = ciphertext.split(':')[0];
      expect(iv).toHaveLength(32);
      expect(iv).toMatch(/^[0-9a-f]+$/);
    });

    it('authTag 部分为 32 个 hex 字符（16 字节）', () => {
      const ciphertext = enc.encrypt('test');
      const authTag = ciphertext.split(':')[1];
      expect(authTag).toHaveLength(32);
      expect(authTag).toMatch(/^[0-9a-f]+$/);
    });

    it('加密数据部分为有效 hex 字符串', () => {
      const ciphertext = enc.encrypt('test');
      const encrypted = ciphertext.split(':')[2];
      expect(encrypted).toMatch(/^[0-9a-f]*$/);
    });

    it('每次加密 IV 不同（随机性）', () => {
      const plaintext = 'same';
      const ivs = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const ciphertext = enc.encrypt(plaintext);
        ivs.add(ciphertext.split(':')[0]);
      }
      // 10 次加密应产生 10 个不同的 IV
      expect(ivs.size).toBe(10);
    });

    it('密文均为小写 hex 字符', () => {
      const ciphertext = enc.encrypt('test-value');
      // 移除冒号后应全为小写 hex
      const hexPart = ciphertext.replace(/:/g, '');
      expect(hexPart).toMatch(/^[0-9a-f]+$/);
    });
  });
});
