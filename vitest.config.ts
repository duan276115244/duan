import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // 30000ms 给并行竞争下的冷启动用例留足余量（隔离运行均 <10s，
    // 但全量 65 文件并行时首用例 import+transform 可达 16s+，15s 会偶发 flaky 超时）
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      // B10: 扩展覆盖率范围 — 原 src/core/**/*.ts 漏掉 tools/integrations/memory 三大用户接触面
      include: [
        'src/core/**/*.ts',
        'src/tools/**/*.ts',
        'src/integrations/**/*.ts',
        'src/memory/**/*.ts',
      ],
      exclude: [
        'src/core/**/__tests__/**',
        'src/core/**/*.test.ts',
        'src/core/**/*.d.ts',
        'src/core/**/index.ts',
        // B10: 同步排除新覆盖目录的测试文件（避免把测试本身计入覆盖率）
        'src/tools/**/__tests__/**',
        'src/tools/**/*.test.ts',
        'src/tools/**/*.d.ts',
        'src/tools/**/index.ts',
        'src/integrations/**/__tests__/**',
        'src/integrations/**/*.test.ts',
        'src/integrations/**/*.d.ts',
        'src/integrations/**/index.ts',
        'src/memory/**/__tests__/**',
        'src/memory/**/*.test.ts',
        'src/memory/**/*.d.ts',
        'src/memory/**/index.ts',
      ],
      // P2-2 修复：覆盖率门槛从 5% 提到 30%（branches 20%），避免形同虚设
      // 之前 5% 门槛等于没有门槛，主循环关键路径几乎没被测试覆盖
      thresholds: {
        lines: 30,
        functions: 30,
        branches: 20,
        statements: 30,
      },
    },
  },
});
