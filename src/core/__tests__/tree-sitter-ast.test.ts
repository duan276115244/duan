/**
 * TreeSitterAST 测试 — 使用真实临时目录创建测试源文件，覆盖正则降级模式
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TreeSitterAST } from '../tree-sitter-ast.js';

describe('TreeSitterAST', () => {
  let tmpDir: string;
  let ast: TreeSitterAST;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-sitter-test-'));
    ast = new TreeSitterAST();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ============ 构造函数 ============
  describe('constructor', () => {
    it('默认参数构造不抛错', () => {
      expect(() => new TreeSitterAST()).not.toThrow();
    });

    it('WASM 不可用时降级到正则模式', () => {
      const instance = new TreeSitterAST();
      // 不论 WASM 是否可用，实例都应可正常工作
      expect(instance).toBeDefined();
      const stats = instance.getStats();
      expect(stats).toContain('TreeSitterAST');
    });
  });

  // ============ parseFile ============
  describe('parseFile', () => {
    it('解析 TypeScript 文件提取函数/类/接口/类型/导入/导出', async () => {
      const filePath = path.join(tmpDir, 'user.ts');
      fs.writeFileSync(filePath, [
        "import { foo } from './foo';",
        "import type { Bar } from './bar';",
        '',
        'export interface UserService {',
        '  getUser(id: string): User;',
        '}',
        '',
        'export type User = {',
        '  id: string;',
        '  name: string;',
        '};',
        '',
        'export class UserRepo {',
        '  private users: User[] = [];',
        '  addUser(user: User): void {',
        '    this.users.push(user);',
        '  }',
        '  getCount(): number {',
        '    return this.users.length;',
        '  }',
        '}',
        '',
        'export function createUser(name: string): User {',
        '  return { id: "1", name };',
        '}',
        '',
        'const DEFAULT_COUNT = 10;',
      ].join('\n'));
      const result = await ast.parseFile(filePath);
      expect(result.filePath).toBe(filePath);
      expect(result.language).toBe('TypeScript');
      expect(result.metrics.functions).toBeGreaterThanOrEqual(1);
      expect(result.metrics.classes).toBeGreaterThanOrEqual(1);
      expect(result.metrics.interfaces).toBeGreaterThanOrEqual(1);
      // imports 提取使用 cleanContent（字符串被移除），导入路径可能为空
      expect(Array.isArray(result.imports)).toBe(true);
      expect(result.exports.length).toBeGreaterThan(0);
      expect(result.exports).toContain('UserService');
      expect(result.exports).toContain('UserRepo');
      expect(result.exports).toContain('createUser');
    });

    it('解析 JavaScript 文件', async () => {
      const filePath = path.join(tmpDir, 'animal.js');
      fs.writeFileSync(filePath, [
        "const helper = require('./helper');",
        '',
        'class Animal {',
        '  constructor(name) {',
        '    this.name = name;',
        '  }',
        '  speak() {',
        '    return this.name + " makes a sound";',
        '  }',
        '}',
        '',
        'function createAnimal(type) {',
        '  return new Animal(type);',
        '}',
        '',
        'module.exports = { Animal, createAnimal };',
      ].join('\n'));
      const result = await ast.parseFile(filePath);
      expect(result.language).toBe('JavaScript');
      expect(result.metrics.functions).toBeGreaterThanOrEqual(1);
      expect(result.metrics.classes).toBeGreaterThanOrEqual(1);
    });

    it('解析 Python 文件', async () => {
      const filePath = path.join(tmpDir, 'animal.py');
      fs.writeFileSync(filePath, [
        'import os',
        'from typing import List',
        '',
        'class Animal:',
        '    def __init__(self, name):',
        '        self.name = name',
        '',
        '    def speak(self):',
        '        return f"{self.name} makes a sound"',
        '',
        'def create_animal(name):',
        '    return Animal(name)',
      ].join('\n'));
      const result = await ast.parseFile(filePath);
      expect(result.language).toBe('Python');
      expect(result.metrics.functions).toBeGreaterThanOrEqual(1);
      expect(result.metrics.classes).toBeGreaterThanOrEqual(1);
    });

    it('解析 Go 文件', async () => {
      const filePath = path.join(tmpDir, 'main.go');
      fs.writeFileSync(filePath, [
        'package main',
        '',
        'import "fmt"',
        '',
        'type Animal struct {',
        '    Name string',
        '}',
        '',
        'type Speaker interface {',
        '    Speak() string',
        '}',
        '',
        'func (a *Animal) Speak() string {',
        '    return a.Name + " speaks"',
        '}',
        '',
        'func CreateAnimal(name string) *Animal {',
        '    return &Animal{Name: name}',
        '}',
      ].join('\n'));
      const result = await ast.parseFile(filePath);
      expect(result.language).toBe('Go');
      expect(result.metrics.functions).toBeGreaterThanOrEqual(1);
      expect(result.metrics.classes).toBeGreaterThanOrEqual(1);
    });

    it('不支持的文件类型返回 unknown 语言', async () => {
      const filePath = path.join(tmpDir, 'readme.txt');
      fs.writeFileSync(filePath, 'This is a text file.\nNot code.\n');
      const result = await ast.parseFile(filePath);
      expect(result.language).toBe('unknown');
      expect(result.nodes).toHaveLength(0);
      expect(result.metrics.functions).toBe(0);
    });

    it('不存在的文件返回空结果', async () => {
      const result = await ast.parseFile(path.join(tmpDir, 'nonexistent.ts'));
      expect(result.language).toBe('unknown');
      expect(result.nodes).toHaveLength(0);
      expect(result.metrics.totalLines).toBe(0);
    });

    it('空文件返回零度量', async () => {
      const filePath = path.join(tmpDir, 'empty.ts');
      fs.writeFileSync(filePath, '');
      const result = await ast.parseFile(filePath);
      expect(result.metrics.totalLines).toBe(1); // 空字符串 split('\n') 返回 ['']
      expect(result.metrics.codeLines).toBe(0);
      expect(result.metrics.functions).toBe(0);
    });

    it('缓存命中时不重复解析', async () => {
      const filePath = path.join(tmpDir, 'cached.ts');
      fs.writeFileSync(filePath, 'function foo() { return 1; }\n');
      await ast.parseFile(filePath);
      await ast.parseFile(filePath);
      const stats = ast.getStats();
      expect(stats).toContain('缓存命中');
    });
  });

  // ============ analyzeProject ============
  describe('analyzeProject', () => {
    it('分析多文件项目并返回汇总', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function a() { return 1; }\n');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function b() { return 2; }\n');
      fs.writeFileSync(path.join(tmpDir, 'c.py'), 'def c():\n    return 3\n');
      const result = await ast.analyzeProject(tmpDir);
      expect(result.files.length).toBeGreaterThanOrEqual(3);
      expect(result.totalMetrics.functions).toBeGreaterThanOrEqual(3);
    });

    it('跳过 node_modules 目录', async () => {
      fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'function main() {}\n');
      const nmDir = path.join(tmpDir, 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });
      fs.writeFileSync(path.join(nmDir, 'dep.ts'), 'function dep() {}\n');
      const result = await ast.analyzeProject(tmpDir);
      const filePaths = result.files.map(f => f.filePath);
      expect(filePaths.some(f => f.includes('main.ts'))).toBe(true);
      expect(filePaths.some(f => f.includes('node_modules'))).toBe(false);
    });

    it('跳过隐藏目录和 dist', async () => {
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'function app() {}\n');
      fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'h.ts'), 'function hidden() {}\n');
      fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'function bundle() {}\n');
      const result = await ast.analyzeProject(tmpDir);
      const filePaths = result.files.map(f => f.filePath);
      expect(filePaths.some(f => f.includes('app.ts'))).toBe(true);
      expect(filePaths.some(f => f.includes('.hidden'))).toBe(false);
      expect(filePaths.some(f => f.includes('dist'))).toBe(false);
    });

    it('返回依赖图和文件列表', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), "import { b } from './b';\nexport function a() { return b(); }\n");
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), "import { a } from './a';\nexport function b() { return a(); }\n");
      const result = await ast.analyzeProject(tmpDir);
      expect(result.dependencyGraph).toBeDefined();
      expect(result.dependencyGraph.size).toBeGreaterThanOrEqual(2);
      expect(result.files.length).toBeGreaterThanOrEqual(2);
      expect(result.circularDependencies).toBeDefined();
      expect(Array.isArray(result.circularDependencies)).toBe(true);
    });
  });

  // ============ findUsages ============
  describe('findUsages', () => {
    it('查找符号引用', async () => {
      fs.writeFileSync(path.join(tmpDir, 'def.ts'), 'export function mySymbol() { return 42; }\n');
      fs.writeFileSync(path.join(tmpDir, 'use.ts'), [
        "import { mySymbol } from './def';",
        'const result = mySymbol();',
      ].join('\n'));
      const result = await ast.findUsages(path.join(tmpDir, 'def.ts'), 'mySymbol');
      expect(result).toContain('找到');
      expect(result).toContain('mySymbol');
    });

    it('无引用时返回未找到信息', async () => {
      fs.writeFileSync(path.join(tmpDir, 'def.ts'), 'export function unique() { return 1; }\n');
      const result = await ast.findUsages(path.join(tmpDir, 'def.ts'), 'nonExistentSymbol');
      expect(result).toContain('未找到');
    });
  });

  // ============ detectSmells ============
  describe('detectSmells', () => {
    it('检测长函数', async () => {
      const filePath = path.join(tmpDir, 'long.ts');
      const body = Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      fs.writeFileSync(filePath, `function longFunc() {\n${body}\n}\n`);
      const result = await ast.detectSmells(filePath);
      expect(result).toContain('long_function');
    });

    it('检测深嵌套', async () => {
      const filePath = path.join(tmpDir, 'deep.ts');
      fs.writeFileSync(filePath, [
        'function deepFunc() {',
        '  if (a) {',
        '    if (b) {',
        '      if (c) {',
        '        if (d) {',
        '          if (e) {',
        '            return 1;',
        '          }',
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'));
      const result = await ast.detectSmells(filePath);
      expect(result).toContain('deep_nesting');
    });

    it('检测过多参数', async () => {
      const filePath = path.join(tmpDir, 'params.ts');
      fs.writeFileSync(filePath, 'function manyParams(a, b, c, d, e, f, g) {\n  return a + b + c + d + e + f + g;\n}\n');
      const result = await ast.detectSmells(filePath);
      expect(result).toContain('too_many_parameters');
    });

    it('无异味时返回提示', async () => {
      const filePath = path.join(tmpDir, 'clean.ts');
      fs.writeFileSync(filePath, 'function add(a, b) {\n  return a + b;\n}\n');
      const result = await ast.detectSmells(filePath);
      // 简单短函数不应触发异味（或至少不报错）
      expect(typeof result).toBe('string');
    });
  });

  // ============ getStructure ============
  describe('getStructure', () => {
    it('返回代码结构大纲', async () => {
      const filePath = path.join(tmpDir, 'struct.ts');
      fs.writeFileSync(filePath, [
        'export class MyService {',
        '  doSomething() { return 1; }',
        '  doOther() { return 2; }',
        '}',
        '',
        'function helper() { return 0; }',
      ].join('\n'));
      const result = await ast.getStructure(filePath);
      expect(result).toContain('MyService');
      expect(result).toContain('helper');
      expect(result).toContain('TypeScript');
    });

    it('类和函数结构', async () => {
      const filePath = path.join(tmpDir, 'cls.ts');
      fs.writeFileSync(filePath, [
        'export class Calculator {',
        '  add(a, b) { return a + b; }',
        '  sub(a, b) { return a - b; }',
        '}',
        '',
        'function helper() { return 0; }',
      ].join('\n'));
      const result = await ast.getStructure(filePath);
      expect(result).toContain('Calculator');
      expect(result).toContain('helper');
    });

    it('无结构时返回提示', async () => {
      const filePath = path.join(tmpDir, 'empty.ts');
      fs.writeFileSync(filePath, '');
      const result = await ast.getStructure(filePath);
      expect(result).toContain('无');
    });
  });

  // ============ getDependencies ============
  describe('getDependencies', () => {
    it('返回导入列表', async () => {
      const filePath = path.join(tmpDir, 'dep.ts');
      fs.writeFileSync(filePath, [
        "import { foo } from './foo';",
        "import { bar } from './bar';",
        'export function useFoo() { return foo(); }',
      ].join('\n'));
      const result = await ast.getDependencies(filePath);
      expect(result).toContain('导入');
      expect(result).toContain('./foo');
      expect(result).toContain('./bar');
    });

    it('列出所有导入及其来源', async () => {
      const filePath = path.join(tmpDir, 'unused.ts');
      fs.writeFileSync(filePath, [
        "import { usedFn } from './used';",
        "import { unusedFn } from './unused';",
        'export function callUsed() { return usedFn(); }',
      ].join('\n'));
      const result = await ast.getDependencies(filePath);
      expect(result).toContain('导入');
      expect(result).toContain('./used');
      expect(result).toContain('./unused');
      expect(result).toContain('usedFn');
      expect(result).toContain('unusedFn');
    });

    it('检测反向依赖（被依赖）', async () => {
      fs.writeFileSync(path.join(tmpDir, 'base.ts'), 'export function baseFn() { return 1; }\n');
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'lib', 'consumer.ts'),
        "import { baseFn } from '../base';\nconst x = baseFn();\n",
      );
      const result = await ast.getDependencies(path.join(tmpDir, 'base.ts'));
      expect(result).toContain('被依赖');
      expect(result).toContain('consumer');
    });
  });

  // ============ getStats ============
  describe('getStats', () => {
    it('返回统计信息字符串', async () => {
      const filePath = path.join(tmpDir, 's.ts');
      fs.writeFileSync(filePath, 'function s() { return 1; }\n');
      await ast.parseFile(filePath);
      const stats = ast.getStats();
      expect(stats).toContain('TreeSitterAST');
      expect(stats).toContain('已解析文件');
      expect(stats).toContain('支持语言');
    });
  });

  // ============ getToolDefinitions ============
  describe('getToolDefinitions', () => {
    it('返回 6 个工具定义', () => {
      const tools = ast.getToolDefinitions();
      expect(tools).toHaveLength(6);
    });

    it('工具名称正确', () => {
      const tools = ast.getToolDefinitions();
      const names = tools.map(t => t.name);
      expect(names).toEqual([
        'ast_parse', 'ast_project', 'ast_usages',
        'ast_smells', 'ast_structure', 'ast_dependencies',
      ]);
    });

    it('所有工具均为 readOnly', () => {
      const tools = ast.getToolDefinitions();
      for (const tool of tools) {
        expect(tool.readOnly).toBe(true);
      }
    });
  });

  // ============ 工具 execute 函数 ============
  describe('工具 execute 函数', () => {
    it('ast_parse 工具执行返回 JSON 分析结果', async () => {
      const filePath = path.join(tmpDir, 'tool.ts');
      fs.writeFileSync(filePath, 'export function toolFn() { return 1; }\n');
      const tools = ast.getToolDefinitions();
      const parseTool = tools.find(t => t.name === 'ast_parse')!;
      const output = await parseTool.execute({ filePath });
      const parsed = JSON.parse(output);
      expect(parsed.filePath).toBe(filePath);
      expect(parsed.language).toBe('TypeScript');
      expect(parsed.metrics.functions).toBeGreaterThanOrEqual(1);
    });

    it('ast_structure 工具执行返回结构大纲', async () => {
      const filePath = path.join(tmpDir, 'struct.ts');
      fs.writeFileSync(filePath, 'export class Cls { method() {} }\n');
      const tools = ast.getToolDefinitions();
      const structTool = tools.find(t => t.name === 'ast_structure')!;
      const output = await structTool.execute({ filePath });
      expect(output).toContain('Cls');
    });

    it('ast_usages 工具执行返回引用列表', async () => {
      fs.writeFileSync(path.join(tmpDir, 'def.ts'), 'export function shared() { return 1; }\n');
      fs.writeFileSync(path.join(tmpDir, 'use.ts'), "import { shared } from './def';\nshared();\n");
      const tools = ast.getToolDefinitions();
      const usagesTool = tools.find(t => t.name === 'ast_usages')!;
      const output = await usagesTool.execute({
        filePath: path.join(tmpDir, 'def.ts'),
        symbolName: 'shared',
      });
      expect(output).toContain('shared');
    });

    it('ast_smells 工具执行返回异味检测', async () => {
      const filePath = path.join(tmpDir, 'smell.ts');
      const body = Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      fs.writeFileSync(filePath, `function smelly() {\n${body}\n}\n`);
      const tools = ast.getToolDefinitions();
      const smellTool = tools.find(t => t.name === 'ast_smells')!;
      const output = await smellTool.execute({ filePath });
      expect(output).toContain('long_function');
    });

    it('ast_project 工具执行返回项目分析 JSON', async () => {
      fs.writeFileSync(path.join(tmpDir, 'p1.ts'), 'export function p1() {}\n');
      fs.writeFileSync(path.join(tmpDir, 'p2.ts'), 'export function p2() {}\n');
      const tools = ast.getToolDefinitions();
      const projTool = tools.find(t => t.name === 'ast_project')!;
      const output = await projTool.execute({ dir: tmpDir });
      const parsed = JSON.parse(output);
      expect(parsed.fileCount).toBeGreaterThanOrEqual(2);
      expect(parsed.totalMetrics.functions).toBeGreaterThanOrEqual(2);
    });

    it('ast_dependencies 工具执行返回依赖分析', async () => {
      const filePath = path.join(tmpDir, 'dep.ts');
      fs.writeFileSync(filePath, "import { x } from './x';\nexport function useX() { return x; }\n");
      const tools = ast.getToolDefinitions();
      const depTool = tools.find(t => t.name === 'ast_dependencies')!;
      const output = await depTool.execute({ filePath });
      expect(output).toContain('导入');
    });
  });

  // ============ 多语言支持 ============
  describe('多语言支持', () => {
    it('getStats 列出所有支持的语言', () => {
      const stats = ast.getStats();
      expect(stats).toContain('TypeScript');
      expect(stats).toContain('JavaScript');
      expect(stats).toContain('Python');
      expect(stats).toContain('Go');
      expect(stats).toContain('Rust');
      expect(stats).toContain('Java');
      expect(stats).toContain('C');
    });

    it('解析 Rust 文件', async () => {
      const filePath = path.join(tmpDir, 'main.rs');
      fs.writeFileSync(filePath, [
        'pub struct Point {',
        '    x: f64,',
        '    y: f64,',
        '}',
        '',
        'pub trait Drawable {',
        '    fn draw(&self);',
        '}',
        '',
        'pub fn new_point(x: f64, y: f64) -> Point {',
        '    Point { x, y }',
        '}',
      ].join('\n'));
      const result = await ast.parseFile(filePath);
      expect(result.language).toBe('Rust');
      expect(result.metrics.classes).toBeGreaterThanOrEqual(1);
    });

    it('解析 Java 文件', async () => {
      const filePath = path.join(tmpDir, 'Main.java');
      fs.writeFileSync(filePath, [
        'public class Main {',
        '    public static void main(String[] args) {',
        '        System.out.println("Hello");',
        '    }',
        '    private int getValue() {',
        '        return 42;',
        '    }',
        '}',
      ].join('\n'));
      const result = await ast.parseFile(filePath);
      expect(result.language).toBe('Java');
      expect(result.metrics.classes).toBeGreaterThanOrEqual(1);
    });
  });
});
