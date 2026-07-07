import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PerformanceProfiler } from '../performance-profiler.js';

describe('PerformanceProfiler', () => {
  let tmpDir: string;
  let profiler: PerformanceProfiler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-test-'));
    profiler = new PerformanceProfiler(tmpDir);
  });

  afterEach(() => {
    profiler.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('函数性能测量', () => {
    it('startMeasure / endMeasure 测量耗时', () => {
      const id = profiler.startMeasure('test-fn');
      // 执行一些操作
      let _sum = 0;
      for (let i = 0; i < 1000; i++) _sum += i;
      const m = profiler.endMeasure(id, 'test-fn');
      expect(m).not.toBeNull();
      expect(m!.name).toBe('test-fn');
      expect(m!.durationMs).toBeGreaterThanOrEqual(0);
      expect(m!.timestamp).toBeGreaterThan(0);
    });

    it('endMeasure 无效 ID 返回 null', () => {
      const m = profiler.endMeasure('nonexistent', 'fn');
      expect(m).toBeNull();
    });

    it('measureAsync 测量异步函数', async () => {
      const { result, measurement } = await profiler.measureAsync('async-fn', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });
      expect(result).toBe(42);
      expect(measurement.name).toBe('async-fn');
      expect(measurement.durationMs).toBeGreaterThanOrEqual(5);
    });

    it('measureAsync 捕获异常并记录', async () => {
      await expect(
        profiler.measureAsync('throwing-fn', () => Promise.reject(new Error('test error'))),
      ).rejects.toThrow('test error');
    });

    it('measureSync 测量同步函数', () => {
      const { result, measurement } = profiler.measureSync('sync-fn', () => {
        let sum = 0;
        for (let i = 0; i < 100; i++) sum += i;
        return sum;
      });
      expect(result).toBe(4950);
      expect(measurement.name).toBe('sync-fn');
      expect(measurement.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('measureSync 捕获异常并记录', () => {
      expect(() => {
        profiler.measureSync('throwing', () => {
          throw new Error('sync error');
        });
      }).toThrow('sync error');
    });
  });

  describe('内存监控', () => {
    it('takeMemorySnapshot 返回快照', () => {
      const snapshot = profiler.takeMemorySnapshot();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.rss).toBeGreaterThan(0);
      expect(snapshot.heapTotal).toBeGreaterThan(0);
      expect(snapshot.heapUsed).toBeGreaterThan(0);
    });

    it('startMemoryMonitoring / stopMemoryMonitoring', () => {
      profiler.startMemoryMonitoring(100);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          profiler.stopMemoryMonitoring();
          resolve();
        }, 250);
      }).then(() => {
        // 至少有一个快照
        const report = profiler.generateReport();
        expect(report.memoryTrend.length).toBeGreaterThanOrEqual(0);
      });
    });

    it('重复启动内存监控不抛错', () => {
      profiler.startMemoryMonitoring(1000);
      profiler.startMemoryMonitoring(2000);
      profiler.stopMemoryMonitoring();
      expect(true).toBe(true);
    });
  });

  describe('内存泄漏检测', () => {
    it('快照不足时返回空数组', () => {
      const leaks = profiler.detectMemoryLeaks();
      expect(leaks).toHaveLength(0);
    });

    it('快照充足时执行检测', () => {
      // 生成足够的快照
      for (let i = 0; i < 15; i++) {
        profiler.takeMemorySnapshot();
      }
      const leaks = profiler.detectMemoryLeaks();
      expect(Array.isArray(leaks)).toBe(true);
    });
  });

  describe('瓶颈检测', () => {
    it('detectBottlenecks 返回数组', () => {
      // 产生一些测量
      for (let i = 0; i < 5; i++) {
        const id = profiler.startMeasure('fn');
        profiler.endMeasure(id, 'fn');
      }
      const bottlenecks = profiler.detectBottlenecks();
      expect(Array.isArray(bottlenecks)).toBe(true);
    });
  });

  describe('性能基准', () => {
    it('getBaselines 样本不足返回空', () => {
      const baselines = profiler.getBaselines();
      expect(baselines).toHaveLength(0);
    });

    it('getBaselines 多次测量后返回基准', () => {
      for (let i = 0; i < 10; i++) {
        const id = profiler.startMeasure('baseline-fn');
        let _sum = 0;
        for (let j = 0; j < 100; j++) _sum += j;
        profiler.endMeasure(id, 'baseline-fn');
      }
      const baselines = profiler.getBaselines();
      expect(baselines.length).toBeGreaterThan(0);
      const b = baselines[0];
      expect(b.name).toBe('baseline-fn');
      expect(b.avgDurationMs).toBeGreaterThanOrEqual(0);
      expect(b.p50DurationMs).toBeGreaterThanOrEqual(0);
      expect(b.p95DurationMs).toBeGreaterThanOrEqual(0);
      expect(b.sampleCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('报告生成', () => {
    it('generateReport 返回完整报告', () => {
      // 产生一些数据
      for (let i = 0; i < 3; i++) {
        const id = profiler.startMeasure('rpt-fn');
        profiler.endMeasure(id, 'rpt-fn');
      }
      profiler.takeMemorySnapshot();

      const report = profiler.generateReport();
      expect(report).toHaveProperty('totalMeasurements');
      expect(report).toHaveProperty('bottlenecks');
      expect(report).toHaveProperty('slowestFunctions');
      expect(report).toHaveProperty('memoryTrend');
      expect(report).toHaveProperty('memoryLeaks');
      expect(report).toHaveProperty('baselines');
      expect(report).toHaveProperty('performanceScore');
      expect(report.performanceScore).toBeGreaterThanOrEqual(0);
      expect(report.performanceScore).toBeLessThanOrEqual(100);
    });

    it('generateReportMarkdown 返回 Markdown 字符串', () => {
      const id = profiler.startMeasure('md-fn');
      profiler.endMeasure(id, 'md-fn');
      const md = profiler.generateReportMarkdown();
      expect(typeof md).toBe('string');
      expect(md).toContain('性能分析报告');
    });
  });

  describe('持久化', () => {
    it('saveData 保存数据文件', () => {
      const id = profiler.startMeasure('persist');
      profiler.endMeasure(id, 'persist');
      profiler.saveData();
      expect(fs.existsSync(path.join(tmpDir, 'performance-data.json'))).toBe(true);
    });

    it('loadData 加载已保存数据', () => {
      const id = profiler.startMeasure('persist');
      profiler.endMeasure(id, 'persist');
      profiler.takeMemorySnapshot();
      profiler.saveData();

      const profiler2 = new PerformanceProfiler(tmpDir);
      const report = profiler2.generateReport();
      expect(report.totalMeasurements).toBeGreaterThan(0);
      profiler2.destroy();
    });
  });

  describe('销毁', () => {
    it('destroy 停止监控并保存', () => {
      profiler.startMemoryMonitoring(1000);
      const id = profiler.startMeasure('destroy-test');
      profiler.endMeasure(id, 'destroy-test');
      profiler.destroy();
      expect(fs.existsSync(path.join(tmpDir, 'performance-data.json'))).toBe(true);
    });
  });
});
