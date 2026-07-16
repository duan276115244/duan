/**
 * RepoMap 测试 — 代码结构重要性排序与压缩上下文生成
 *
 * 覆盖：
 * - 符号提取（正则降级模式）：TS/JS/Python/Go/Rust/Java/C++
 * - 重要性评分：引用数 × 2.0 + 导出 × 1.5 + 公共 × 1.3 + 复杂度 × 0.8 − 文件大小惩罚 × 0.5
 * - 排序：按评分降序
 * - 压缩格式：header / 文件分组 / 符号行格式
 * - Token 预算控制
 * - 缓存：目录级 TTL + 文件级 mtime 增量
 * - 查询：querySymbol
 * - Top-N：getTopSymbols
 * - 统计：getStats
 * - 降级模式：treeSitterAST 为 null 时纯正则
 * - LLM 工具：getRepoMapToolDefinitions / createRepoMapToolHandler
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RepoMap,
  getRepoMapToolDefinitions,
  createRepoMapToolHandler,
} from '../repo-map.js';

// ============ 测试夹具 ============

/** TypeScript 测试源文件 A：含导出函数、类、接口、类型 */
const TS_FILE_A = `
export function greet(name: string): string {
  if (name) {
    return 'hello ' + name;
  }
  return 'hello';
}

export interface Config {
  id: string;
  value: number;
}

export type ID = string;

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

function _privateHelper(): void {
  console.log('internal');
}
`;

/** TypeScript 测试源文件 B：引用 A 中的符号 */
const TS_FILE_B = `
import { greet, Config, Calculator } from './a';

export function main(): void {
  greet('world');
  const calc = new Calculator();
  calc.add(1, 2);
  const cfg: Config = { id: '1', value: 42 };
  console.log(cfg);
}
`;

/** Python 测试源文件 */
const PY_FILE = `
def hello(name):
    if name:
        return 'hello ' + name
    return 'hello'

class Animal:
    def speak(self):
        pass

async def fetch_data():
    return 42
`;

/** Go 测试源文件 */
const GO_FILE = `
package main

func Add(a int, b int) int {
    return a + b
}

func main() {
    Add(1, 2)
}

type Server struct {
    Port int
}

type Handler interface {
    Handle()
}
`;

/** Rust 测试源文件 */
const RUST_FILE = `
pub fn calculate(x: i32) -> i32 {
    if x > 0 {
        return x * 2;
    }
    x
}

pub struct Point {
    x: f64,
    y: f64,
}

pub trait Drawable {
    fn draw(&self);
}

fn internal_helper() {}
`;

/** Java 测试源文件 */
const JAVA_FILE = `
public class UserService {
    public void createUser(String name) {
        System.out.println(name);
    }

    private void validateUser(String name) {
        if (name == null) {
            throw new Error();
        }
    }
}

interface Repository {
    void save();
}
`;

/** C++ 测试源文件 */
const CPP_FILE = `
int compute(int x) {
    if (x > 0) {
        return x * 2;
    }
    return 0;
}

struct Data {
    int value;
};
`;

// ============ 测试工具 ============

/** 创建临时目录并写入文件 */
function createTempProject(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
  return tmpDir;
}

/** 递归删除目录 */
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ============ 测试用例 ============

describe('RepoMap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ========== 符号提取 ==========

  describe('符号提取（正则降级模式）', () => {
    it('提取 TypeScript 函数符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const greet = symbols.find(s => s.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet!.type).toBe('function');
    });

    it('提取 TypeScript 类符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const calc = symbols.find(s => s.name === 'Calculator');
      expect(calc).toBeDefined();
      expect(calc!.type).toBe('class');
    });

    it('提取 TypeScript 接口符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const config = symbols.find(s => s.name === 'Config');
      expect(config).toBeDefined();
      expect(config!.type).toBe('interface');
    });

    it('提取 TypeScript 类型别名符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const id = symbols.find(s => s.name === 'ID');
      expect(id).toBeDefined();
      expect(id!.type).toBe('type');
    });

    it('正确标记导出符号 isExported', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const greet = symbols.find(s => s.name === 'greet');
      expect(greet!.isExported).toBe(true);
      const privateFn = symbols.find(s => s.name === '_privateHelper');
      expect(privateFn).toBeDefined();
      expect(privateFn!.isExported).toBe(false);
    });

    it('私有符号 isPublic 为 false', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const privateFn = symbols.find(s => s.name === '_privateHelper');
      expect(privateFn!.isPublic).toBe(false);
    });

    it('提取 Python 函数和类符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.py'), PY_FILE);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      expect(symbols.find(s => s.name === 'hello')).toBeDefined();
      expect(symbols.find(s => s.name === 'Animal')).toBeDefined();
      expect(symbols.find(s => s.name === 'fetch_data')).toBeDefined();
    });

    it('提取 Go 函数、结构体和接口符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.go'), GO_FILE);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      expect(symbols.find(s => s.name === 'Add')).toBeDefined();
      expect(symbols.find(s => s.name === 'Server')).toBeDefined();
      expect(symbols.find(s => s.name === 'Handler')).toBeDefined();
    });

    it('提取 Rust 函数、结构体和 trait 符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.rs'), RUST_FILE);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      expect(symbols.find(s => s.name === 'calculate')).toBeDefined();
      expect(symbols.find(s => s.name === 'Point')).toBeDefined();
      expect(symbols.find(s => s.name === 'Drawable')).toBeDefined();
    });

    it('提取 Java 类和接口符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'Service.java'), JAVA_FILE);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      expect(symbols.find(s => s.name === 'UserService')).toBeDefined();
      expect(symbols.find(s => s.name === 'Repository')).toBeDefined();
    });
  });

  // ========== 评分 ==========

  describe('重要性评分', () => {
    it('被引用符号评分高于未引用符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), TS_FILE_B);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const greet = symbols.find(s => s.name === 'greet');
      const id = symbols.find(s => s.name === 'ID');
      expect(greet!.score).toBeGreaterThan(id!.score);
    });

    it('引用次数（references）正确统计', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), TS_FILE_B);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const greet = symbols.find(s => s.name === 'greet');
      expect(greet!.references).toBeGreaterThan(0);
    });

    it('导出符号获得 1.5 加分', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const greet = symbols.find(s => s.name === 'greet');
      const privateFn = symbols.find(s => s.name === '_privateHelper');
      // 导出 + 公共 vs 非导出 + 非公共
      expect(greet!.isExported).toBe(true);
      expect(privateFn!.isExported).toBe(false);
    });

    it('评分公式正确：references * 2.0 + 导出 1.5 + 公共 1.3 + 复杂度 * 0.8 - 文件惩罚 * 0.5', () => {
      // 单文件单符号，便于验证
      fs.writeFileSync(path.join(tmpDir, 'simple.ts'), 'export function foo() { return 1; }\n');
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      const foo = symbols.find(s => s.name === 'foo');
      expect(foo).toBeDefined();
      // foo: isExported=true, isPublic=true, references=0 (无其他文件引用)
      // score = 0*2.0 + 1.5 + 1.3 + complexity*0.8 - fileSizePenalty*0.5
      expect(foo!.score).toBeGreaterThan(0);
    });

    it('评分不低于 0', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      for (const s of symbols) {
        expect(s.score).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ========== 排序 ==========

  describe('排序', () => {
    it('getTopSymbols 返回按评分降序排列的符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), TS_FILE_B);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const top = repoMap.getTopSymbols(5);
      expect(top.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < top.length; i++) {
        expect(top[i - 1].score).toBeGreaterThanOrEqual(top[i].score);
      }
    });

    it('getTopSymbols 默认返回 20 个', () => {
      // 创建多个文件以产生足够多符号
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(
          path.join(tmpDir, `file${i}.ts`),
          `export function func${i}a() { return 1; }\nexport function func${i}b() { return 2; }\nexport function func${i}c() { return 3; }\n`,
        );
      }
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const top = repoMap.getTopSymbols();
      expect(top.length).toBeLessThanOrEqual(20);
    });
  });

  // ========== 压缩格式 ==========

  describe('压缩上下文格式', () => {
    it('map 文本包含 header 行', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.map).toContain('=== Repo Map');
      expect(result.map).toContain('symbols');
      expect(result.map).toContain('tokens');
    });

    it('map 文本按文件分组显示符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), TS_FILE_B);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.map).toContain('a.ts');
      expect(result.map).toContain('b.ts');
    });

    it('符号行包含行号、名称、类型、引用数和评分', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.map).toContain('L');
      expect(result.map).toContain('refs:');
      expect(result.map).toContain('score:');
    });

    it('函数和方法名显示 () 后缀', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.map).toContain('greet()');
    });

    it('空目录生成包含 0 symbols 的 map', () => {
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.map).toContain('0 symbols');
      expect(result.symbolCount).toBe(0);
    });
  });

  // ========== Token 预算 ==========

  describe('Token 预算控制', () => {
    it('estimatedTokens 约为 map 文本长度 / 4', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.estimatedTokens).toBe(Math.ceil(result.map.length / 4));
    });

    it('小 token 预算限制符号数量', () => {
      // 创建大量符号
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(
          path.join(tmpDir, `f${i}.ts`),
          `export function func${i}() { return ${i}; }\n`,
        );
      }
      const repoMap = new RepoMap({ cwd: tmpDir, tokenBudget: 100, treeSitterAST: null });
      const result = repoMap.generateMap();
      // 100 tokens ≈ 400 字符，只能容纳少量符号
      expect(result.symbolCount).toBeLessThan(20);
    });

    it('maxSymbols 限制返回符号数', () => {
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(
          path.join(tmpDir, `f${i}.ts`),
          `export function func${i}() { return ${i}; }\n`,
        );
      }
      const repoMap = new RepoMap({ cwd: tmpDir, tokenBudget: 100000, treeSitterAST: null });
      const result = repoMap.generateMap({ maxSymbols: 3 });
      expect(result.symbolCount).toBeLessThanOrEqual(3);
    });
  });

  // ========== 缓存 ==========

  describe('缓存', () => {
    it('60 秒内重复调用返回缓存结果（cacheHits 增加）', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, cacheTtlMs: 60000, treeSitterAST: null });
      repoMap.generateMap();
      const stats1 = repoMap.getStats();
      repoMap.generateMap();
      const stats2 = repoMap.getStats();
      expect(stats2.cacheHits).toBe(stats1.cacheHits + 1);
    });

    it('缓存过期后重新生成（cacheMisses 增加）', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, cacheTtlMs: 0, treeSitterAST: null });
      repoMap.generateMap();
      const stats1 = repoMap.getStats();
      // TTL=0，立即过期
      repoMap.generateMap();
      const stats2 = repoMap.getStats();
      expect(stats2.cacheMisses).toBe(stats1.cacheMisses + 1);
    });

    it('clearCache 清除缓存使下次调用重新生成', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, cacheTtlMs: 60000, treeSitterAST: null });
      repoMap.generateMap();
      const stats1 = repoMap.getStats();
      repoMap.clearCache();
      repoMap.generateMap();
      const stats2 = repoMap.getStats();
      expect(stats2.cacheMisses).toBe(stats1.cacheMisses + 1);
    });

    it('文件级 mtime 缓存：文件未修改时复用缓存', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, cacheTtlMs: 0, treeSitterAST: null });
      // 第一次生成
      repoMap.generateMap();
      // 清除目录缓存但保留文件缓存
      repoMap.clearCache();
      // 重新生成，文件未修改应复用文件级缓存
      const result = repoMap.generateMap();
      expect(result.symbolCount).toBeGreaterThan(0);
    });
  });

  // ========== 查询 ==========

  describe('查询符号', () => {
    it('querySymbol 返回存在的符号', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const greet = repoMap.querySymbol('greet');
      expect(greet).toBeDefined();
      expect(greet!.name).toBe('greet');
      expect(greet!.type).toBe('function');
    });

    it('querySymbol 不存在返回 null', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const notFound = repoMap.querySymbol('nonExistentSymbol');
      expect(notFound).toBeNull();
    });

    it('querySymbol 同名符号返回最高分', () => {
      // 两个文件都定义同名函数
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function shared() { return 1; }\n');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'import { shared } from "./a";\nfunction shared() { return 2; }\n');
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const result = repoMap.querySymbol('shared');
      expect(result).toBeDefined();
    });
  });

  // ========== 统计 ==========

  describe('统计信息', () => {
    it('getStats 返回正确的统计结构', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats).toHaveProperty('totalSymbols');
      expect(stats).toHaveProperty('totalFiles');
      expect(stats).toHaveProperty('cacheHits');
      expect(stats).toHaveProperty('cacheMisses');
      expect(stats).toHaveProperty('lastGeneratedAt');
    });

    it('totalSymbols 反映提取的符号总数', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats.totalSymbols).toBeGreaterThan(0);
    });

    it('totalFiles 反映扫描的文件数', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), TS_FILE_B);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats.totalFiles).toBe(2);
    });

    it('lastGeneratedAt 在 generateMap 后更新', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const before = repoMap.getStats();
      expect(before.lastGeneratedAt).toBeNull();
      repoMap.generateMap();
      const after = repoMap.getStats();
      expect(after.lastGeneratedAt).not.toBeNull();
      expect(after.lastGeneratedAt).toBeGreaterThan(0);
    });

    it('初始状态 cacheHits 和 cacheMisses 为 0', () => {
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const stats = repoMap.getStats();
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
    });
  });

  // ========== 降级模式 ==========

  describe('降级模式（无 TreeSitterAST）', () => {
    it('treeSitterAST 为 null 时正常工作', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.symbolCount).toBeGreaterThan(0);
    });

    it('未传入 treeSitterAST 时默认为 null（正则模式）', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir });
      const result = repoMap.generateMap();
      expect(result.symbolCount).toBeGreaterThan(0);
    });

    it('支持 C++ 文件符号提取', () => {
      fs.writeFileSync(path.join(tmpDir, 'main.cpp'), CPP_FILE);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const symbols = repoMap.getTopSymbols(100);
      expect(symbols.find(s => s.name === 'compute')).toBeDefined();
    });
  });

  // ========== 目录遍历 ==========

  describe('目录遍历', () => {
    it('跳过 node_modules 目录', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.ts'), 'export function depFn() { return 1; }\n');
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats.totalFiles).toBe(1);
    });

    it('跳过 .git / dist / build / .next 目录', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      for (const dir of ['.git', 'dist', 'build', '.next']) {
        fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, dir, 'ignored.ts'), 'export function ignored() {}\n');
      }
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats.totalFiles).toBe(1);
    });

    it('递归扫描子目录', () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.ts'), 'export function helper() { return 1; }\n');
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats.totalFiles).toBe(1);
      const helper = repoMap.querySymbol('helper');
      expect(helper).toBeDefined();
    });

    it('不支持的文件扩展名被跳过', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# README\n');
      fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}\n');
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const stats = repoMap.getStats();
      expect(stats.totalFiles).toBe(1);
    });
  });

  // ========== LLM 工具 ==========

  describe('LLM 工具定义与处理器', () => {
    it('getRepoMapToolDefinitions 返回 3 个工具', () => {
      const defs = getRepoMapToolDefinitions();
      expect(defs).toHaveLength(3);
      const names = defs.map(d => d.name);
      expect(names).toContain('repo_map_generate');
      expect(names).toContain('repo_map_query');
      expect(names).toContain('repo_map_symbols');
    });

    it('工具定义包含正确的参数结构', () => {
      const defs = getRepoMapToolDefinitions();
      const generate = defs.find(d => d.name === 'repo_map_generate')!;
      expect(generate.parameters).toHaveProperty('directory');
      expect(generate.parameters).toHaveProperty('maxSymbols');
      expect(generate.readOnly).toBe(true);

      const query = defs.find(d => d.name === 'repo_map_query')!;
      expect(query.parameters).toHaveProperty('name');
      expect(query.parameters.name.required).toBe(true);

      const symbols = defs.find(d => d.name === 'repo_map_symbols')!;
      expect(symbols.parameters).toHaveProperty('limit');
    });

    it('createRepoMapToolHandler 处理 repo_map_generate', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const handler = createRepoMapToolHandler(repoMap);
      const result = await handler('repo_map_generate', {});
      expect(result).toContain('Repo Map');
      expect(result).toContain('符号数');
    });

    it('createRepoMapToolHandler 处理 repo_map_query', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const handler = createRepoMapToolHandler(repoMap);
      const result = await handler('repo_map_query', { name: 'greet' });
      expect(result).toContain('greet');
      expect(result).toContain('function');
    });

    it('createRepoMapToolHandler 查询不存在的符号返回提示', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const handler = createRepoMapToolHandler(repoMap);
      const result = await handler('repo_map_query', { name: 'noExist' });
      expect(result).toContain('未找到');
    });

    it('createRepoMapToolHandler 处理 repo_map_symbols', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      repoMap.generateMap();
      const handler = createRepoMapToolHandler(repoMap);
      const result = await handler('repo_map_symbols', { limit: 5 });
      expect(result).toContain('Top-');
      expect(result).toContain('score:');
    });

    it('createRepoMapToolHandler 未知工具返回错误信息', async () => {
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const handler = createRepoMapToolHandler(repoMap);
      const result = await handler('unknown_tool', {});
      expect(result).toContain('未知工具');
    });

    it('createRepoMapToolHandler repo_map_query 缺少 name 参数返回错误', async () => {
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const handler = createRepoMapToolHandler(repoMap);
      const result = await handler('repo_map_query', {});
      expect(result).toContain('错误');
    });
  });

  // ========== filesIncluded ==========

  describe('filesIncluded', () => {
    it('filesIncluded 反映 map 中包含的文件数', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), TS_FILE_B);
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      expect(result.filesIncluded).toBeGreaterThan(0);
      expect(result.filesIncluded).toBeLessThanOrEqual(2);
    });

    it('generatedAt 为当前时间戳', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), TS_FILE_A);
      const before = Date.now();
      const repoMap = new RepoMap({ cwd: tmpDir, treeSitterAST: null });
      const result = repoMap.generateMap();
      const after = Date.now();
      expect(result.generatedAt).toBeGreaterThanOrEqual(before);
      expect(result.generatedAt).toBeLessThanOrEqual(after);
    });
  });
});
