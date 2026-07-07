import { describe, it, expect, beforeEach } from 'vitest';
import { MCPSecurityGuard } from '../mcp-security.js';

describe('MCPSecurityGuard', () => {
  let guard: MCPSecurityGuard;

  beforeEach(() => {
    guard = new MCPSecurityGuard();
  });

  describe('registerPlugin', () => {
    it('注册可信插件时自动放宽策略', () => {
      const config = guard.registerPlugin('playwright-mcp');
      expect(config.trust).toBe('trusted');
      expect(config.approvalPolicy).toBe('auto');
      expect(config.timeoutMs).toBe(30000);
      expect(config.rateLimitPerMin).toBe(120);
    });

    it('注册未知插件时默认收紧策略', () => {
      const config = guard.registerPlugin('unknown-plugin');
      expect(config.trust).toBe('untrusted');
      expect(config.approvalPolicy).toBe('suggest');
      expect(config.timeoutMs).toBe(15000);
      expect(config.rateLimitPerMin).toBe(30);
    });

    it('允许自定义配置覆盖默认值', () => {
      const config = guard.registerPlugin('custom-plugin', {
        timeoutMs: 5000,
        rateLimitPerMin: 10,
        fileWriteAccess: true,
      });
      expect(config.timeoutMs).toBe(5000);
      expect(config.rateLimitPerMin).toBe(10);
      expect(config.fileWriteAccess).toBe(true);
    });
  });

  describe('assessRisk', () => {
    beforeEach(() => {
      guard.registerPlugin('playwright-mcp');
      guard.registerPlugin('unknown-plugin');
    });

    it('只读工具判定为 safe', () => {
      const risk = guard.assessRisk('playwright-mcp', 'read_file', { path: '/tmp/test' });
      expect(risk).toBe('safe');
    });

    it('删除类工具判定为 high', () => {
      const risk = guard.assessRisk('playwright-mcp', 'delete_file', { path: '/tmp/test' });
      expect(risk).toBe('high');
    });

    it('执行类工具判定为 high', () => {
      const risk = guard.assessRisk('playwright-mcp', 'execute_shell', { cmd: 'ls' });
      expect(risk).toBe('high');
    });

    it('未注册插件判定为 critical', () => {
      const risk = guard.assessRisk('not-registered', 'any_tool', {});
      expect(risk).toBe('critical');
    });

    it('危险参数模式判定为 critical', () => {
      const risk = guard.assessRisk('playwright-mcp', 'run', { cmd: 'rm -rf /' });
      expect(risk).toBe('critical');
    });

    it('fork bomb 参数判定为 critical', () => {
      const risk = guard.assessRisk('playwright-mcp', 'run', { cmd: ':() { :|:& };:' });
      expect(risk).toBe('critical');
    });
  });

  describe('checkPermission', () => {
    beforeEach(() => {
      guard.registerPlugin('playwright-mcp');
      guard.registerPlugin('unknown-plugin', { blockedTools: ['dangerous_tool'] });
    });

    it('安全工具自动放行', async () => {
      const result = await guard.checkPermission('playwright-mcp', 'read_file', { path: '/tmp' });
      expect(result.allowed).toBe(true);
      expect(result.risk).toBe('safe');
    });

    it('黑名单工具被阻止', async () => {
      const result = await guard.checkPermission('unknown-plugin', 'dangerous_tool', {});
      expect(result.allowed).toBe(false);
      expect(result.risk).toBe('critical');
    });

    it('危险参数被拦截', async () => {
      const result = await guard.checkPermission('playwright-mcp', 'run', { cmd: 'rm -rf /' });
      expect(result.allowed).toBe(false);
      expect(result.risk).toBe('critical');
      expect(result.reason).toContain('危险模式');
    });

    it('高危操作无审批回调时拒绝', async () => {
      // unknown-plugin 是非可信插件，delete_file 会被判定为高危且无审批通道时拒绝
      const result = await guard.checkPermission('unknown-plugin', 'delete_file', { path: '/tmp' });
      expect(result.allowed).toBe(false);
      expect(result.risk).toBe('high');
    });

    it('审批回调通过时放行高危操作', async () => {
      guard.setApprovalCallback(async () => true);
      const result = await guard.checkPermission('unknown-plugin', 'delete_file', { path: '/tmp' });
      expect(result.allowed).toBe(true);
      expect(result.risk).toBe('high');
    });

    it('审批回调拒绝时阻止高危操作', async () => {
      guard.setApprovalCallback(async () => false);
      const result = await guard.checkPermission('unknown-plugin', 'delete_file', { path: '/tmp' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('用户拒绝');
    });
  });

  describe('sanitizeArgs', () => {
    it('移除控制字符', () => {
      const result = guard.sanitizeArgs({ text: 'hello\x00\x01world\x7F' });
      expect(result.text).toBe('helloworld');
    });

    it('截断过长字符串', () => {
      const longStr = 'a'.repeat(60000);
      const result = guard.sanitizeArgs({ text: longStr });
      expect(result.text.length).toBeLessThan(60000);
      expect(result.text).toContain('truncated');
    });

    it('递归处理嵌套对象', () => {
      const result = guard.sanitizeArgs({ outer: { inner: 'safe\x00' } });
      expect(result.outer.inner).toBe('safe');
    });

    it('保留数组原样', () => {
      const result = guard.sanitizeArgs({ list: ['a', 'b', 'c'] });
      expect(result.list).toEqual(['a', 'b', 'c']);
    });

    it('保留非字符串值', () => {
      const result = guard.sanitizeArgs({ num: 42, bool: true, nil: null });
      expect(result.num).toBe(42);
      expect(result.bool).toBe(true);
      expect(result.nil).toBeNull();
    });
  });

  describe('truncateOutput', () => {
    it('短输出不截断', () => {
      const result = guard.truncateOutput('short', 100);
      expect(result).toBe('short');
    });

    it('长输出截断并标注原始长度', () => {
      const longOutput = 'x'.repeat(20000);
      const result = guard.truncateOutput(longOutput, 10000);
      expect(result.length).toBeLessThan(longOutput.length);
      expect(result).toContain('20000');
    });
  });

  describe('rate limiting', () => {
    it('超过频率限制时拒绝', async () => {
      // 使用可信插件 playwright-mcp，read_file 为 safe 风险可自动放行
      // 设置 rateLimitPerMin=3，第 4 次应被限流
      guard.registerPlugin('playwright-mcp', { rateLimitPerMin: 3 });
      // 前 3 次放行
      for (let i = 0; i < 3; i++) {
        const r = await guard.checkPermission('playwright-mcp', 'read_file', {});
        expect(r.allowed).toBe(true);
      }
      // 第 4 次被限流
      const r = await guard.checkPermission('playwright-mcp', 'read_file', {});
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('频率超限');
    });
  });

  describe('getSecurityEvents', () => {
    it('记录安全事件', async () => {
      guard.registerPlugin('test-plugin');
      await guard.checkPermission('test-plugin', 'read_file', {});
      await guard.checkPermission('not-registered', 'any', {});
      const events = guard.getSecurityEvents(10);
      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getAllPluginStatus', () => {
    it('返回所有已注册插件状态', () => {
      guard.registerPlugin('plugin-a');
      guard.registerPlugin('plugin-b');
      const status = guard.getAllPluginStatus();
      expect(status.length).toBe(2);
      expect(status.map(s => s.serverId)).toContain('plugin-a');
      expect(status.map(s => s.serverId)).toContain('plugin-b');
    });
  });
});
