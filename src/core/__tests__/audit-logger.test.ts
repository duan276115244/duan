import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditLogger } from '../audit-logger.js';

describe('AuditLogger', () => {
  let tmpDir: string;
  let logger: AuditLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    logger = new AuditLogger(tmpDir);
  });

  afterEach(() => {
    logger.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('log', () => {
    it('记录日志，自动生成id和timestamp', async () => {
      await logger.log({
        type: 'tool_call',
        action: 'execute',
        actor: 'user1',
        resource: '/path/to/file',
        result: 'success',
        details: {},
      });

      const entries = logger.query({});
      expect(entries.length).toBe(1);
      expect(entries[0].id).toBeTruthy();
      expect(entries[0].id).toMatch(/^audit_\d+_/);
      expect(entries[0].timestamp).toBeTruthy();
      expect(new Date(entries[0].timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('riskScore: tool_call+success=1', async () => {
      await logger.log({
        type: 'tool_call',
        action: 'execute',
        actor: 'user1',
        resource: '/path/to/file',
        result: 'success',
        details: {},
      });

      const entries = logger.query({});
      expect(entries[0].riskScore).toBe(1);
    });

    it('riskScore: security_event+denied=8 (5+3)', async () => {
      await logger.log({
        type: 'security_event',
        action: 'execute',
        actor: 'user1',
        resource: '/path/to/file',
        result: 'denied',
        details: {},
      });

      const entries = logger.query({});
      expect(entries[0].riskScore).toBe(8);
    });

    it('riskScore: config_change+failure+sensitive=9 (4+2+3)', async () => {
      await logger.log({
        type: 'config_change',
        action: 'execute',
        actor: 'user1',
        resource: '/path/to/password/file',
        result: 'failure',
        details: {},
      });

      const entries = logger.query({});
      expect(entries[0].riskScore).toBe(9);
    });

    it('riskScore: data_access+success+write=5 (3+0+2)', async () => {
      await logger.log({
        type: 'data_access',
        action: 'write_file',
        actor: 'user1',
        resource: '/path/to/file',
        result: 'success',
        details: {},
      });

      const entries = logger.query({});
      expect(entries[0].riskScore).toBe(5);
    });

    it('riskScore最大为10', async () => {
      // security_event(5) + denied(3) + sensitive(3) + write(2) = 13, 封顶为10
      await logger.log({
        type: 'security_event',
        action: 'write_file',
        actor: 'user1',
        resource: '/path/to/password/file',
        result: 'denied',
        details: {},
      });

      const entries = logger.query({});
      expect(entries[0].riskScore).toBe(10);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await logger.log({
        type: 'tool_call',
        action: 'execute',
        actor: 'user1',
        resource: '/path/to/file1',
        result: 'success',
        details: {},
      });
      await logger.log({
        type: 'data_access',
        action: 'read',
        actor: 'user2',
        resource: '/path/to/file2',
        result: 'failure',
        details: {},
      });
      await logger.log({
        type: 'security_event',
        action: 'write',
        actor: 'user1',
        resource: '/path/to/password',
        result: 'denied',
        details: {},
      });
    });

    it('按type过滤', () => {
      const results = logger.query({ type: 'tool_call' });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('tool_call');
    });

    it('按actor过滤', () => {
      const results = logger.query({ actor: 'user1' });
      expect(results.length).toBe(2);
      expect(results.every(e => e.actor === 'user1')).toBe(true);
    });

    it('按resource过滤', () => {
      const results = logger.query({ resource: 'password' });
      expect(results.length).toBe(1);
      expect(results[0].resource).toContain('password');
    });

    it('按result过滤', () => {
      const results = logger.query({ result: 'failure' });
      expect(results.length).toBe(1);
      expect(results[0].result).toBe('failure');
    });

    it('按minRiskScore过滤', () => {
      // security_event(5) + denied(3) + password(3) = 11, 封顶为10
      const results = logger.query({ minRiskScore: 7 });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('security_event');
    });

    it('按limit限制', () => {
      const results = logger.query({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it('无过滤返回全部', () => {
      const results = logger.query({});
      expect(results.length).toBe(3);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await logger.log({
        type: 'tool_call',
        action: 'execute',
        actor: 'user1',
        resource: '/path/to/file1',
        result: 'success',
        details: {},
      });
      await logger.log({
        type: 'data_access',
        action: 'read',
        actor: 'user2',
        resource: '/path/to/file2',
        result: 'failure',
        details: {},
      });
      await logger.log({
        type: 'security_event',
        action: 'write',
        actor: 'user1',
        resource: '/path/to/password',
        result: 'denied',
        details: {},
      });
    });

    it('返回正确统计', () => {
      const stats = logger.getStats();
      expect(stats.totalEntries).toBe(3);
    });

    it('byType统计', () => {
      const stats = logger.getStats();
      expect(stats.byType['tool_call']).toBe(1);
      expect(stats.byType['data_access']).toBe(1);
      expect(stats.byType['security_event']).toBe(1);
    });

    it('byResult统计', () => {
      const stats = logger.getStats();
      expect(stats.byResult['success']).toBe(1);
      expect(stats.byResult['failure']).toBe(1);
      expect(stats.byResult['denied']).toBe(1);
    });

    it('highRiskCount统计', () => {
      const stats = logger.getStats();
      // security_event(5) + denied(3) + password(3) = 11, 封顶为10 → 高风险
      expect(stats.highRiskCount).toBe(1);
    });
  });

  describe('detectAnomalies', () => {
    it('高风险操作被检测', async () => {
      await logger.log({
        type: 'security_event',
        action: 'write',
        actor: 'user1',
        resource: '/path/to/password',
        result: 'denied',
        details: {},
      });

      const anomalies = logger.detectAnomalies();
      expect(anomalies.length).toBe(1);
      expect(anomalies[0].riskScore).toBeGreaterThanOrEqual(7);
    });

    it('少量失败不被检测为异常（<=10）', async () => {
      for (let i = 0; i < 10; i++) {
        await logger.log({
          type: 'tool_call',
          action: 'execute',
          actor: 'user1',
          resource: `/path/to/file${i}`,
          result: 'failure',
          details: {},
        });
      }

      const anomalies = logger.detectAnomalies();
      // 10个失败，riskScore = 1(tool_call) + 2(failure) = 3，不算高风险
      // failures.length = 10，不大于10，不触发异常
      expect(anomalies.length).toBe(0);
    });

    it('去重', async () => {
      // 创建11个高风险失败操作，同时触发"大量失败"和"高风险"两个条件
      for (let i = 0; i < 11; i++) {
        await logger.log({
          type: 'security_event',
          action: 'write',
          actor: 'user1',
          resource: `/path/to/password${i}`,
          result: 'denied',
          details: {},
        });
      }

      const anomalies = logger.detectAnomalies();
      // 11个失败 + 11个高风险 = 22，去重后应为11
      expect(anomalies.length).toBe(11);
    });
  });

  describe('stop', () => {
    it('stop后定时器清除', () => {
      logger.stop();
      // 验证 flushInterval 已被清除
      expect((logger as any).flushInterval).toBeNull();
    });
  });
});
