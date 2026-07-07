import { describe, it, expect, beforeEach } from 'vitest';
import { SandboxExecutor, resetDockerCache, type SandboxConfig } from '../sandbox-executor.js';

describe('SandboxExecutor', () => {
  let executor: SandboxExecutor;

  beforeEach(() => {
    executor = new SandboxExecutor();
    resetDockerCache();
  });

  // ==================== VM 沙箱模式 ====================
  describe('VM 沙箱模式', () => {
    const vmConfig: SandboxConfig = {
      level: 'vm',
      timeout: 5000,
      maxOutput: 50000,
      workspaceRoot: '.',
    };

    it('执行简单表达式返回结果', async () => {
      const result = await executor.execute('1 + 1', vmConfig);
      expect(result.success).toBe(true);
      expect(result.output).toBe('2');
      expect(result.level).toBe('vm');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('执行 console.log 捕获输出', async () => {
      const result = await executor.execute("console.log('hello world')", vmConfig);
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello world');
    });

    it('执行多个 console.log 全部捕获', async () => {
      const result = await executor.execute(
        "console.log('line1'); console.log('line2'); console.log('line3')",
        vmConfig,
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('line1');
      expect(result.output).toContain('line2');
      expect(result.output).toContain('line3');
    });

    it('执行 console.error 输出带 [ERROR] 前缀', async () => {
      const result = await executor.execute("console.error('boom')", vmConfig);
      expect(result.success).toBe(true);
      expect(result.output).toContain('[ERROR]');
      expect(result.output).toContain('boom');
    });

    it('执行抛出异常的代码返回错误', async () => {
      const result = await executor.execute('throw new Error("test error")', vmConfig);
      expect(result.success).toBe(false);
      expect(result.error).toContain('test error');
      expect(result.level).toBe('vm');
    });

    it('执行返回对象的代码序列化为 JSON', async () => {
      const result = await executor.execute('({ name: "test", value: 42 })', vmConfig);
      expect(result.success).toBe(true);
      expect(result.output).toContain('"name"');
      expect(result.output).toContain('"test"');
      expect(result.output).toContain('42');
    });

    it('阻止访问 process 对象', async () => {
      const result = await executor.execute('process.exit(0)', vmConfig);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('阻止访问 require 函数', async () => {
      const result = await executor.execute("require('fs')", vmConfig);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('阻止通过 require 访问 fs 模块', async () => {
      const result = await executor.execute(
        "require('fs').readFileSync('/etc/passwd')",
        vmConfig,
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('阻止访问 global 对象', async () => {
      const result = await executor.execute('global.process.exit(0)', vmConfig);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('代码执行超时返回超时错误', async () => {
      const result = await executor.execute('while(true){}', {
        ...vmConfig,
        timeout: 50,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.level).toBe('vm');
    });
  });

  // ==================== None 沙箱模式 ====================
  describe('None 沙箱模式', () => {
    const noneConfig: SandboxConfig = {
      level: 'none',
      timeout: 5000,
      maxOutput: 50000,
      workspaceRoot: '.',
    };

    it('直接执行代码返回结果', async () => {
      const result = await executor.execute('return 42', noneConfig);
      expect(result.success).toBe(true);
      expect(result.output).toBe('42');
      expect(result.level).toBe('none');
    });

    it('执行抛出异常的代码返回错误', async () => {
      const result = await executor.execute('throw new Error("none error")', noneConfig);
      expect(result.success).toBe(false);
      expect(result.error).toContain('none error');
    });

    it('无返回值时代码输出为空', async () => {
      const result = await executor.execute('1 + 1', noneConfig);
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });
  });

  // ==================== 输出截断 ====================
  describe('输出截断', () => {
    it('超长输出被截断并添加提示', async () => {
      const longStr = 'x'.repeat(1000);
      const result = await executor.execute(`console.log('${longStr}')`, {
        level: 'vm',
        timeout: 5000,
        maxOutput: 100,
        workspaceRoot: '.',
      });
      expect(result.success).toBe(true);
      expect(result.output.length).toBeLessThan(longStr.length);
      expect(result.output).toContain('输出已截断');
      expect(result.output).toContain('1000');
    });

    it('短输出保持不变', async () => {
      const result = await executor.execute("console.log('short')", {
        level: 'vm',
        timeout: 5000,
        maxOutput: 50000,
        workspaceRoot: '.',
      });
      expect(result.success).toBe(true);
      expect(result.output).toBe('short');
    });
  });

  // ==================== selectLevel 级别选择 ====================
  describe('selectLevel 级别选择', () => {
    it('安全工具选择 none 级别', async () => {
      const level = await executor.selectLevel('file_read', 'safe');
      expect(level).toBe('none');
    });

    it('中等风险工具选择 vm 级别', async () => {
      const level = await executor.selectLevel('code_execute', 'moderate');
      expect(level).toBe('vm');
    });

    it('高风险工具选择 process 级别', async () => {
      const level = await executor.selectLevel('bash', 'dangerous');
      expect(level).toBe('process');
    });

    it('极高风险工具选择 docker 或 process 级别', async () => {
      const level = await executor.selectLevel('docker_exec', 'very_dangerous');
      expect(['docker', 'process']).toContain(level);
    });

    it('未知工具默认选择 vm 级别', async () => {
      const level = await executor.selectLevel('unknown_tool', 'unknown');
      expect(level).toBe('vm');
    });
  });

  // ==================== executeCommand 命令执行 ====================
  describe('executeCommand 命令执行', () => {
    it('黑名单命令被拦截', async () => {
      const result = await executor.executeCommand('rm', ['-rf', '/'], {
        level: 'process',
        timeout: 5000,
        maxOutput: 50000,
        workspaceRoot: '.',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('黑名单');
    });

    it('不在白名单的命令被拒绝', async () => {
      const result = await executor.executeCommand('python', ['--version'], {
        level: 'process',
        timeout: 5000,
        maxOutput: 50000,
        workspaceRoot: '.',
        allowedCommands: ['node'],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('白名单');
    });

    it('成功执行允许的命令', async () => {
      const result = await executor.executeCommand('node', ['--version'], {
        level: 'none',
        timeout: 10000,
        maxOutput: 50000,
        workspaceRoot: '.',
      });
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/v\d+\.\d+\.\d+/);
      expect(result.exitCode).toBe(0);
      expect(result.level).toBe('none');
    });
  });

  // ==================== resetDockerCache ====================
  describe('resetDockerCache', () => {
    it('调用不抛出异常', () => {
      expect(() => resetDockerCache()).not.toThrow();
    });
  });
});
