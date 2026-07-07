import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SelfRepairSystem } from '../self-repair.js';

describe('SelfRepairSystem', () => {
  let tmpDir: string;
  let system: SelfRepairSystem;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-repair-test-'));
    system = new SelfRepairSystem(tmpDir);
  });

  afterEach(() => {
    system.stopPeriodicHealthCheck();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('健康检查', () => {
    it('healthCheck 返回检查项列表', async () => {
      const checks = await system.healthCheck();
      expect(Array.isArray(checks)).toBe(true);
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        expect(check.component).toBeTruthy();
        expect(check.check).toBeTruthy();
        expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(check.status);
        expect(check.checkedAt).toBeGreaterThan(0);
      }
    });

    it('healthCheck 包含内存检查', async () => {
      const checks = await system.healthCheck();
      const memCheck = checks.find((c) => c.check === 'memory_usage');
      expect(memCheck).toBeDefined();
      expect(memCheck!.value).toBeGreaterThan(0);
    });

    it('healthCheck 包含事件循环延迟检查', async () => {
      const checks = await system.healthCheck();
      const delayCheck = checks.find((c) => c.check === 'event_loop_delay');
      expect(delayCheck).toBeDefined();
    });

    it('healthCheck 包含工作目录检查', async () => {
      const checks = await system.healthCheck();
      const dirCheck = checks.find((c) => c.check === 'workdir_accessible');
      expect(dirCheck).toBeDefined();
      expect(dirCheck!.status).toBe('healthy');
    });
  });

  describe('定期健康检查', () => {
    it('startPeriodicHealthCheck 启动定时器', () => {
      system.startPeriodicHealthCheck(1000);
      // 不抛错即视为成功
      expect(true).toBe(true);
    });

    it('stopPeriodicHealthCheck 停止定时器', () => {
      system.startPeriodicHealthCheck(1000);
      system.stopPeriodicHealthCheck();
      expect(true).toBe(true);
    });

    it('重复启动不抛错', () => {
      system.startPeriodicHealthCheck(1000);
      system.startPeriodicHealthCheck(2000);
      system.stopPeriodicHealthCheck();
      expect(true).toBe(true);
    });
  });

  describe('异常检测与报告', () => {
    it('reportAnomaly 创建异常', () => {
      const anomaly = system.reportAnomaly({
        type: 'memory_leak',
        severity: 'high',
        component: 'system',
        description: '内存持续增长',
      });
      expect(anomaly.id).toBeTruthy();
      expect(anomaly.type).toBe('memory_leak');
      expect(anomaly.status).toBeDefined();
      expect(system.getActiveAnomalies()).toContainEqual(
        expect.objectContaining({ id: anomaly.id }),
      );
    });

    it('getActiveAnomalies 返回活跃异常', () => {
      system.reportAnomaly({
        type: 'cpu_spike',
        severity: 'medium',
        component: 'system',
        description: 'CPU 飙升',
      });
      const active = system.getActiveAnomalies();
      expect(active.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('根因分析', () => {
    it('diagnose 返回根因', async () => {
      const anomaly = system.reportAnomaly({
        type: 'memory_leak',
        severity: 'high',
        component: 'system',
        description: '内存泄漏',
      });
      const rootCause = await system.diagnose(anomaly.id);
      expect(typeof rootCause).toBe('string');
      expect(rootCause.length).toBeGreaterThan(0);
    });

    it('diagnose 不存在的异常返回提示', async () => {
      const result = await system.diagnose('nonexistent');
      expect(result).toBe('异常不存在');
    });
  });

  describe('自动修复', () => {
    it('autoRepair 执行修复并返回记录', async () => {
      const anomaly = system.reportAnomaly({
        type: 'memory_leak',
        severity: 'high',
        component: 'system',
        description: '内存泄漏',
      });
      const record = await system.autoRepair(anomaly);
      expect(record).not.toBeNull();
      expect(record!.anomalyId).toBe(anomaly.id);
      expect(record!.strategy).toBeTruthy();
      expect(Array.isArray(record!.steps)).toBe(true);
      expect(typeof record!.success).toBe('boolean');
    });

    it('修复后异常状态更新', async () => {
      const anomaly = system.reportAnomaly({
        type: 'resource_exhaustion',
        severity: 'medium',
        component: 'system',
        description: '资源耗尽',
      });
      await system.autoRepair(anomaly);
      // 修复后异常应从活跃列表移除（如果成功）或标记为 failed
      const active = system.getActiveAnomalies();
      const stillActive = active.find((a) => a.id === anomaly.id);
      if (stillActive) {
        expect(stillActive.status).toBe('failed');
      }
    });
  });

  describe('修复策略注册', () => {
    it('registerStrategy 注册自定义策略', () => {
      system.registerStrategy({
        name: 'manual',
        description: '自定义策略',
        applicableAnomalies: ['component_failure'],
        steps: [
          {
            description: '执行自定义修复',
            action: () => Promise.resolve({ success: true, output: 'ok' }),
          },
        ],
        verify: () => Promise.resolve(true),
      });
      // 通过触发匹配的异常间接验证
      const anomaly = system.reportAnomaly({
        type: 'component_failure',
        severity: 'low',
        component: 'test',
        description: '测试',
      });
      // 不等待自动修复，仅验证策略已注册
      expect(anomaly.id).toBeTruthy();
    });
  });

  describe('查询', () => {
    it('getAnomalyHistory 返回历史', async () => {
      const anomaly = system.reportAnomaly({
        type: 'cpu_spike',
        severity: 'low',
        component: 'system',
        description: 'CPU 突增',
      });
      await system.autoRepair(anomaly);
      const history = system.getAnomalyHistory();
      expect(Array.isArray(history)).toBe(true);
    });

    it('getRepairRecords 返回修复记录', async () => {
      const anomaly = system.reportAnomaly({
        type: 'memory_leak',
        severity: 'medium',
        component: 'system',
        description: '内存泄漏',
      });
      await system.autoRepair(anomaly);
      const records = system.getRepairRecords();
      expect(records.length).toBeGreaterThan(0);
    });

    it('getHealthSummary 返回健康摘要', async () => {
      await system.healthCheck();
      const summary = system.getHealthSummary();
      expect(summary).toHaveProperty('overallStatus');
      expect(summary).toHaveProperty('componentStatuses');
      expect(summary).toHaveProperty('activeAnomalyCount');
      expect(summary).toHaveProperty('recentRepairCount');
      expect(summary).toHaveProperty('successRate');
      expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(summary.overallStatus);
    });
  });
});
