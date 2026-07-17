import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // 限制并发线程数：默认全量并行（118 文件）会导致 git 操作超时 + Windows EPERM 文件锁竞争。
    // 4 线程在吞吐与稳定性间取得平衡：wall-clock ≈15min，git/file 无竞争。
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
      },
    },
    // 60000ms：全量 118 文件并行下，git init/execFileSync 在 I/O 竞争下可达 30s+，
    // 加上 cognitive-state 的 105 次 setMood writeFileSync 等重 I/O 用例，
    // 30s 全局超时会在并行峰值时偶发 flaky 失败。60s 留足余量。
    testTimeout: 60000,
    hookTimeout: 60000,
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
