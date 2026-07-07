import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * 段先生后端 ESLint 配置
 * 覆盖 src/ 和 desktop/ 目录的 TypeScript/JavaScript 代码
 */
export default tseslint.config(
  // 忽略目录
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'frontend/**',
      'release/**',
      'duan-release/**',
      'web/**',
      'shop/**',
      'output/**',
      'movie-site/**',
      '*.js',  // 根目录临时 JS 文件
    ],
  },
  // TypeScript 源码规则
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.ts', 'desktop/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: true, // 启用类型信息，支持 no-floating-promises 等类型规则
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // 错误级别规则
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-debugger': 'error',
      'no-unused-vars': 'off', // 由 @typescript-eslint 处理
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn', // 逐步减少 any 使用
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // 安全相关规则
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      'no-script-url': 'error',

      // 代码质量规则
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['warn', 'smart'],
      'no-throw-literal': 'error',
      'no-duplicate-imports': 'warn',
      'no-useless-catch': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],

      // 异步规则
      'require-await': 'warn',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // 允许循环内 await（业务需要）
      // Promise 安全规则（v19 P1-W3：禁未处理 promise）
      '@typescript-eslint/no-floating-promises': 'warn', // 检测未 await/catch 的 Promise
      '@typescript-eslint/no-misused-promises': 'warn', // 检测在条件/事件中等误用 Promise
      'prefer-promise-reject-errors': 'warn', // 使用 Error 对象 reject

      // 最佳实践
      'curly': ['warn', 'multi-line'],
      'default-case-last': 'warn',
      'no-nested-ternary': 'warn',
      'no-multi-str': 'warn',
    },
  },
  // 测试文件特殊规则（tsconfig 排除了 __tests__，禁用类型信息以避免 parsing error）
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      parserOptions: {
        project: null, // 测试文件不在 tsconfig include 中，禁用类型信息
      },
    },
    rules: {
      // 禁用需要类型信息的规则（测试文件不强制 Promise 安全检查）
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      // 测试文件允许 any（mock/访问私有方法等行业惯例）
      '@typescript-eslint/no-explicit-any': 'off',
      // 测试文件不强制 require-await（mock 返回 Promise、测试 setup 等 async 无 await 是常见且合理的模式）
      'require-await': 'off',
    },
  },
  // tsconfig 排除的源文件（agent.ts / models/*.ts 等，禁用类型信息以避免 parsing error）
  {
    files: ['src/core/agent.ts', 'src/models/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: null, // 这些文件被 tsconfig exclude，禁用类型信息
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
  // desktop/main.js 特殊规则（Electron 主进程，CommonJS）
  {
    files: ['desktop/main.js', 'desktop/preload.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off', // Electron 主进程允许 console
      '@typescript-eslint/no-explicit-any': 'off', // JS 文件不检查 TS 规则
      'no-undef': 'off', // Electron 全局变量
    },
  },
);
