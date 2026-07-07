import { describe, it, expect } from 'vitest';
import { errMsg } from '../utils.js';

describe('errMsg 错误信息转换', () => {
  describe('文件系统错误', () => {
    it('ENOENT 错误返回文件或路径不存在提示', () => {
      const err = new Error("ENOENT: no such file or directory, open '/tmp/missing.txt'");
      expect(errMsg(err)).toBe('文件或路径不存在，请检查路径是否正确');
    });

    it('EACCES 错误返回权限不足提示', () => {
      const err = new Error('EACCES: permission denied');
      expect(errMsg(err)).toBe('权限不足，无法执行此操作');
    });

    it('EPERM 错误也返回权限不足提示', () => {
      const err = new Error('EPERM: operation not permitted');
      expect(errMsg(err)).toBe('权限不足，无法执行此操作');
    });

    it('EEXIST 错误返回文件已存在提示', () => {
      const err = new Error('EEXIST: file already exists');
      expect(errMsg(err)).toBe('文件已存在');
    });

    it('EISDIR 错误返回目录提示', () => {
      const err = new Error('EISDIR: illegal operation on a directory');
      expect(errMsg(err)).toBe('指定路径是目录，不是文件');
    });

    it('ENOTDIR 错误返回路径不存在提示', () => {
      const err = new Error('ENOTDIR: not a directory');
      expect(errMsg(err)).toBe('路径不存在');
    });

    it('ENOSPC 错误返回磁盘空间不足提示', () => {
      const err = new Error('ENOSPC: no space left on device');
      expect(errMsg(err)).toBe('磁盘空间不足');
    });
  });

  describe('网络错误', () => {
    it('ECONNREFUSED 错误返回连接被拒绝提示', () => {
      const err = new Error('ECONNREFUSED: connection refused');
      expect(errMsg(err)).toBe('连接被拒绝，目标服务可能未启动');
    });

    it('ECONNRESET 错误返回连接被重置提示', () => {
      const err = new Error('ECONNRESET: connection reset by peer');
      expect(errMsg(err)).toBe('连接被重置');
    });

    it('ETIMEDOUT 错误返回操作超时提示', () => {
      const err = new Error('ETIMEDOUT: operation timed out');
      expect(errMsg(err)).toBe('操作超时，请稍后重试');
    });

    it('timeout 错误返回操作超时提示', () => {
      const err = new Error('Request timeout');
      expect(errMsg(err)).toBe('操作超时，请稍后重试');
    });

    it('AbortError 错误返回操作超时提示', () => {
      const err = new Error('AbortError: The operation was aborted');
      expect(errMsg(err)).toBe('操作超时，请稍后重试');
    });

    it('ENOTFOUND 错误返回域名解析失败提示', () => {
      const err = new Error('ENOTFOUND: getaddrinfo ENOTFOUND example.invalid');
      expect(errMsg(err)).toBe('域名解析失败，请检查网络连接');
    });

    it('fetch failed 错误返回网络请求失败提示', () => {
      const err = new Error('fetch failed');
      expect(errMsg(err)).toBe('网络请求失败，请检查网络连接');
    });
  });

  describe('代码语法错误', () => {
    it('SyntaxError 错误返回语法错误提示', () => {
      const err = new SyntaxError('Unexpected token }');
      expect(errMsg(err)).toBe('语法错误');
    });

    it('Unexpected token 错误返回语法错误提示', () => {
      const err = new Error('Unexpected token at position 5');
      expect(errMsg(err)).toBe('语法错误');
    });

    it('TypeError 错误返回类型错误提示', () => {
      const err = new Error('TypeError: Cannot read properties of undefined');
      expect(errMsg(err)).toBe('类型错误');
    });

    it('ReferenceError 错误返回引用了不存在的变量提示', () => {
      const err = new Error('ReferenceError: foo is not defined');
      expect(errMsg(err)).toBe('引用了不存在的变量');
    });
  });

  describe('Git 与命令错误', () => {
    it('not a git repository 错误返回对应提示', () => {
      const err = new Error('fatal: not a git repository (or any of the parent directories): .git');
      expect(errMsg(err)).toBe('当前目录不是Git仓库');
    });

    it('Command failed 错误返回命令执行失败提示', () => {
      const err = new Error('Command failed: npm run build');
      expect(errMsg(err)).toBe('命令执行失败');
    });
  });

  describe('非 Error 对象处理', () => {
    it('字符串错误也能正确处理', () => {
      expect(errMsg('EACCES: permission denied')).toBe('权限不足，无法执行此操作');
    });

    it('字符串 timeout 也能匹配超时提示', () => {
      expect(errMsg('request timeout')).toBe('操作超时，请稍后重试');
    });

    it('字符串 fetch failed 也能匹配网络请求失败', () => {
      expect(errMsg('fetch failed')).toBe('网络请求失败，请检查网络连接');
    });

    it('数字错误也能被处理', () => {
      expect(errMsg(42)).toBe('操作执行出错，请检查输入参数后重试');
    });
  });

  describe('未知错误', () => {
    it('未知错误返回通用错误提示', () => {
      const err = new Error('something completely unknown happened');
      expect(errMsg(err)).toBe('操作执行出错，请检查输入参数后重试');
    });

    it('空字符串错误返回通用错误提示', () => {
      expect(errMsg('')).toBe('操作执行出错，请检查输入参数后重试');
    });

    it('null 错误返回通用错误提示', () => {
      expect(errMsg(null)).toBe('操作执行出错，请检查输入参数后重试');
    });

    it('undefined 错误返回通用错误提示', () => {
      expect(errMsg(undefined)).toBe('操作执行出错，请检查输入参数后重试');
    });
  });
});
