/**
 * API Key 加密工具（与 UnifiedConfigManager / CLI 一致）
 * 从 desktop/main.js 抽出 — 纯函数，无跨模块依赖
 * 扩展能力：文件级加密/解密（用于核心代码保护 + 源代码备份）
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'enc:';
const FILE_ENCRYPTED_PREFIX = 'DUAN-ENC-V1:';
const DEFAULT_ALGO = 'aes-256-gcm';

/** 生成加密主密钥：基于机器特征派生（同一台机器三端可互通） */
function deriveMasterKey() {
  const host = os.hostname() || 'unknown-host';
  const user = (os.userInfo && os.userInfo().username) || 'unknown-user';
  const seed = `duan-unified-config:${host}:${user}`;
  return crypto.scryptSync(seed, 'duan-aes-256-salt', 32);
}

const MASTER_KEY = deriveMasterKey();

/** 从密码/口令派生密钥（跨机器一致，用户提供口令即可解密） */
function deriveKeyFromPassword(password) {
  if (!password) return MASTER_KEY;
  return crypto.scryptSync(password, 'duan-core-code-salt-v1', 32);
}

/** 加密 API Key，返回 enc: 前缀的密文 */
function encryptApiKey(plain) {
  if (!plain || plain.startsWith(ENCRYPTED_PREFIX)) return plain;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(DEFAULT_ALGO, MASTER_KEY, iv);
    let encrypted = cipher.update(plain, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return ENCRYPTED_PREFIX + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  } catch (err) {
    console.warn('[安全] API Key 加密失败，使用 base64 降级存储:', err.message);
    return ENCRYPTED_PREFIX + 'base64:' + Buffer.from(plain, 'utf8').toString('base64');
  }
}

/** 解密 API Key */
function decryptApiKey(stored) {
  if (!stored || !stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  try {
    const payload = stored.substring(ENCRYPTED_PREFIX.length);
    if (payload.startsWith('base64:')) {
      return Buffer.from(payload.substring(7), 'base64').toString('utf8');
    }
    const parts = payload.split(':');
    if (parts.length !== 3) {
      console.warn('[安全] 加密数据格式损坏，返回空值');
      return '';
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(DEFAULT_ALGO, MASTER_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.warn('[安全] API Key 解密失败，返回空值:', err.message);
    return '';
  }
}

/** 加密单个文件（同步）— 输入文件路径 + 口令，生成 .enc 文件 */
function encryptFile(srcPath, password) {
  const key = deriveKeyFromPassword(password);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(DEFAULT_ALGO, key, iv);
  const plain = fs.readFileSync(srcPath);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 格式: FILE_ENCRYPTED_PREFIX + iv(16 hex) + ':' + authTag(16 hex) + ':' + base64(ciphertext)
  const outPath = srcPath + '.enc';
  const content = FILE_ENCRYPTED_PREFIX
    + iv.toString('hex') + ':'
    + authTag.toString('hex') + ':'
    + encrypted.toString('base64');
  fs.writeFileSync(outPath, content);
  return outPath;
}

/** 解密单个 .enc 文件（同步） */
function decryptFile(encPath, password, outPath) {
  const key = deriveKeyFromPassword(password);
  const content = fs.readFileSync(encPath, 'utf8');
  if (!content.startsWith(FILE_ENCRYPTED_PREFIX)) {
    throw new Error('文件格式错误：缺少 DUAN-ENC-V1 前缀');
  }
  const payload = content.substring(FILE_ENCRYPTED_PREFIX.length);
  const [ivHex, authTagHex, cipherB64] = payload.split(':');
  if (!ivHex || !authTagHex || !cipherB64) {
    throw new Error('文件格式损坏：缺少 iv/authTag/ciphertext');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(cipherB64, 'base64');
  const decipher = crypto.createDecipheriv(DEFAULT_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const target = outPath || encPath.replace(/\.enc$/, '');
  fs.writeFileSync(target, decrypted);
  return target;
}

/** 批量加密文件列表（返回成功加密的文件路径） */
function encryptFiles(paths, password) {
  const results = [];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      if (!fs.statSync(p).isFile()) continue;
      const enc = encryptFile(p, password);
      results.push({ source: p, encrypted: enc, size: fs.statSync(enc).size });
    } catch (e) {
      console.warn(`[加密] 跳过 ${p}:`, e.message);
    }
  }
  return results;
}

/** 批量解密 .enc 文件（用于恢复开发环境） */
function decryptFiles(encPaths, password) {
  const results = [];
  for (const p of encPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const out = decryptFile(p, password);
      results.push({ encrypted: p, source: out });
    } catch (e) {
      console.warn(`[解密] 跳过 ${p}:`, e.message);
    }
  }
  return results;
}

/** 生成高熵随机口令（用于新项目的核心代码保护口令） */
function generateSecurePassword(length = 32) {
  return crypto.randomBytes(length).toString('base64url').substring(0, length);
}

/** 解密 profiles 中的所有 apiKey */
function decryptProfiles(profiles) {
  if (!profiles) return profiles;
  if (Array.isArray(profiles)) {
    return profiles.map(p => ({ ...p, apiKey: decryptApiKey(p.apiKey) }));
  }
  const result = {};
  for (const [id, p] of Object.entries(profiles)) {
    result[id] = { ...p, apiKey: decryptApiKey(p.apiKey) };
  }
  return result;
}

module.exports = {
  ENCRYPTED_PREFIX,
  FILE_ENCRYPTED_PREFIX,
  DEFAULT_ALGO,
  deriveMasterKey,
  deriveKeyFromPassword,
  encryptApiKey,
  decryptApiKey,
  decryptProfiles,
  encryptFile,
  decryptFile,
  encryptFiles,
  decryptFiles,
  generateSecurePassword,
};
