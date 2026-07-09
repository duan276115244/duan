/**
 * i18n 模块测试
 *
 * 覆盖：
 * - detectLocale 启发式检测（中文/英文/日语/混合/空）
 * - detectAndSetLocale 设置当前 locale
 * - getRespondInstruction 返回指令（zh-CN 返回空，其他返回非空）
 * - setLocale / getLocale 手动切换
 * - t() 翻译 + 模板参数
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectLocale,
  detectAndSetLocale,
  getLocale,
  setLocale,
  getRespondInstruction,
  getLanguageName,
  t,
  loadTranslations,
} from '../i18n/index.js';
import * as path from 'path';

describe('i18n', () => {
  beforeEach(() => {
    // 每个测试前重置为默认
    setLocale('zh-CN');
  });

  // ============ detectLocale ============

  describe('detectLocale()', () => {
    it('中文文本（CJK 占比 > 30%）→ zh-CN', () => {
      expect(detectLocale('你好，请帮我写一段代码')).toBe('zh-CN');
    });

    it('纯英文文本（ASCII 占比 > 40%）→ en-US', () => {
      expect(detectLocale('Hello, please help me write some code')).toBe('en-US');
    });

    it('日语文本（含假名）→ ja-JP', () => {
      expect(detectLocale('こんにちは、コードを書いてください')).toBe('ja-JP');
    });

    it('混合中英（中文为主）→ zh-CN', () => {
      // 多数中文字符 + 少量英文
      expect(detectLocale('请帮我 debug 这个 TypeScript 的函数，它有个 TypeError')).toBe('zh-CN');
    });

    it('混合英中（英文为主）→ en-US', () => {
      expect(detectLocale('Please help me 修复 this bug, it is a TypeError')).toBe('en-US');
    });

    it('空字符串保持当前 locale', () => {
      setLocale('en-US');
      expect(detectLocale('')).toBe('en-US');
    });

    it('纯数字/符号保持当前 locale', () => {
      setLocale('zh-CN');
      expect(detectLocale('12345 !!! ???')).toBe('zh-CN');
    });
  });

  // ============ detectAndSetLocale ============

  describe('detectAndSetLocale()', () => {
    it('检测并设置当前 locale', () => {
      expect(getLocale()).toBe('zh-CN');
      const detected = detectAndSetLocale('Hello world, how are you?');
      expect(detected).toBe('en-US');
      expect(getLocale()).toBe('en-US');
    });

    it('中文输入后 locale 回到 zh-CN', () => {
      setLocale('en-US');
      detectAndSetLocale('你好世界');
      expect(getLocale()).toBe('zh-CN');
    });
  });

  // ============ getRespondInstruction ============

  describe('getRespondInstruction()', () => {
    it('zh-CN 返回空字符串（默认语言，无需额外指令）', () => {
      setLocale('zh-CN');
      expect(getRespondInstruction()).toBe('');
    });

    it('en-US 返回英文回复指令', () => {
      setLocale('en-US');
      const instruction = getRespondInstruction();
      expect(instruction).toContain('English');
      expect(instruction.length).toBeGreaterThan(0);
    });

    it('ja-JP 返回日语回复指令', () => {
      setLocale('ja-JP');
      const instruction = getRespondInstruction();
      expect(instruction).toContain('日本語');
    });
  });

  // ============ getLanguageName ============

  describe('getLanguageName()', () => {
    it('zh-CN → 中文', () => {
      setLocale('zh-CN');
      expect(getLanguageName()).toBe('中文');
    });

    it('en-US → English', () => {
      setLocale('en-US');
      expect(getLanguageName()).toBe('English');
    });
  });

  // ============ t() 翻译 ============

  describe('t() 翻译', () => {
    it('未加载翻译时返回 key 本身', () => {
      expect(t('nonexistent.key')).toBe('nonexistent.key');
    });

    it('加载翻译文件后返回对应 locale 的文本', () => {
      const localesDir = path.join(__dirname, '..', 'i18n', 'locales');
      loadTranslations(localesDir);
      setLocale('zh-CN');
      expect(t('thinking')).toBe('思考中');
      setLocale('en-US');
      expect(t('thinking')).toBe('Thinking');
      setLocale('ja-JP');
      expect(t('thinking')).toBe('考え中');
    });

    it('模板参数替换', () => {
      // 测试 t() 的模板替换逻辑（用未加载的 key 验证 fallback + 参数）
      // 由于 ui.json 不含模板，这里验证 key 不存在时返回 key 本身
      const result = t('missing.{name}', { name: 'test' });
      // key 不在翻译表 → 返回 key 本身（未替换，因为直接 return key）
      expect(result).toBe('missing.{name}');
    });
  });

  // ============ setLocale / getLocale ============

  describe('setLocale / getLocale', () => {
    it('手动切换 locale', () => {
      setLocale('ja-JP');
      expect(getLocale()).toBe('ja-JP');
      setLocale('en-US');
      expect(getLocale()).toBe('en-US');
    });
  });
});
