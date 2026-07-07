import { describe, it, expect } from 'vitest';
import { tokenize, extractKeywords, textSimilarity } from '../chinese-tokenizer.js';

describe('tokenize 中英文混合分词', () => {
  describe('空值与非法输入', () => {
    it('空字符串返回空数组', () => {
      expect(tokenize('')).toEqual([]);
    });

    it('null 返回空数组', () => {
      expect(tokenize(null as unknown as string)).toEqual([]);
    });

    it('undefined 返回空数组', () => {
      expect(tokenize(undefined as unknown as string)).toEqual([]);
    });
  });

  describe('纯英文分词', () => {
    it('hello world 按空格分词', () => {
      expect(tokenize('hello world')).toEqual(['hello', 'world']);
    });

    it('单个英文单词', () => {
      expect(tokenize('hello')).toEqual(['hello']);
    });

    it('多个空格分隔的英文', () => {
      expect(tokenize('hello   world')).toEqual(['hello', 'world']);
    });
  });

  describe('纯中文分词', () => {
    it('调试代码 生成 bigram 和单字', () => {
      const result = tokenize('调试代码');
      // bigram: 调试, 试代, 代码
      // 单字: 调, 试, 代, 码
      expect(result).toEqual(['调试', '试代', '代码', '调', '试', '代', '码']);
    });

    it('调试代码问题 生成完整的 bigram 和单字', () => {
      const result = tokenize('调试代码问题');
      expect(result).toEqual([
        '调试', '试代', '代码', '码问', '问题',
        '调', '试', '代', '码', '问', '题',
      ]);
    });

    it('单个中文字符返回单字', () => {
      expect(tokenize('调')).toEqual(['调']);
    });
  });

  describe('中英混合分词', () => {
    it('运行npm install 包含中文 bigram 和英文单词', () => {
      const result = tokenize('运行npm install');
      // CJK 段 "运行" → bigram: 运行, 单字: 运, 行
      // 英文: npm, install
      expect(result).toEqual(['运行', '运', '行', 'npm', 'install']);
    });

    it('中英文交替文本正确分词', () => {
      const result = tokenize('你好world');
      // CJK 段 "你好" → bigram: 你好, 单字: 你, 好
      // 英文: world
      expect(result).toEqual(['你好', '你', '好', 'world']);
    });
  });

  describe('minTokenLength 选项', () => {
    it('minTokenLength=2 过滤短英文 token', () => {
      const result = tokenize('a bb ccc', { minTokenLength: 2 });
      expect(result).toEqual(['bb', 'ccc']);
    });

    it('minTokenLength=3 过滤长度小于 3 的英文 token', () => {
      const result = tokenize('a ab abc abcd', { minTokenLength: 3 });
      expect(result).toEqual(['abc', 'abcd']);
    });

    it('minTokenLength 不影响 CJK 单字', () => {
      // CJK 分支不检查 minTokenLength，单字仍会保留
      const result = tokenize('调试', { minTokenLength: 2 });
      expect(result).toEqual(['调试', '调', '试']);
    });
  });

  describe('bigramOnly 选项', () => {
    it('bigramOnly=true 不包含单字', () => {
      const result = tokenize('调试代码', { bigramOnly: true });
      expect(result).toEqual(['调试', '试代', '代码']);
    });

    it('bigramOnly=true 对单个中文字符返回空数组', () => {
      // 单字无法构成 bigram
      const result = tokenize('调', { bigramOnly: true });
      expect(result).toEqual([]);
    });

    it('bigramOnly=true 不影响英文分词', () => {
      const result = tokenize('hello world', { bigramOnly: true });
      expect(result).toEqual(['hello', 'world']);
    });
  });

  describe('标点符号处理', () => {
    it('英文标点正确断句', () => {
      const result = tokenize('hello, world!');
      expect(result).toEqual(['hello', 'world']);
    });

    it('中文标点正确断句', () => {
      const result = tokenize('你好。世界！');
      // "你好" → bigram: 你好, 单字: 你, 好
      // "世界" → bigram: 世界, 单字: 世, 界
      expect(result).toEqual(['你好', '你', '好', '世界', '世', '界']);
    });

    it('中英文标点混合', () => {
      const result = tokenize('hello, world! 你好。');
      expect(result).toEqual(['hello', 'world', '你好', '你', '好']);
    });

    it('括号与特殊符号正确处理', () => {
      const result = tokenize('test (abc) [def]');
      expect(result).toEqual(['test', 'abc', 'def']);
    });
  });

  describe('数字处理', () => {
    it('数字保持完整', () => {
      expect(tokenize('123 456')).toEqual(['123', '456']);
    });

    it('字母与数字混合保持完整', () => {
      expect(tokenize('test123abc')).toEqual(['test123abc']);
    });

    it('数字与中文混合', () => {
      const result = tokenize('运行123');
      // CJK 段 "运行" → bigram: 运行, 单字: 运, 行
      // 数字: 123
      expect(result).toEqual(['运行', '运', '行', '123']);
    });
  });

  describe('大小写转换', () => {
    it('英文大写转小写', () => {
      expect(tokenize('HELLO WORLD')).toEqual(['hello', 'world']);
    });

    it('混合大小写转小写', () => {
      expect(tokenize('Hello World')).toEqual(['hello', 'world']);
    });

    it('中英混合大小写转换', () => {
      const result = tokenize('运行NPM install');
      // CJK 段 "运行" → bigram: 运行, 单字: 运, 行
      // NPM → npm, install → install
      expect(result).toEqual(['运行', '运', '行', 'npm', 'install']);
    });
  });
});

describe('extractKeywords 关键词提取', () => {
  it('返回 Set 对象', () => {
    const result = extractKeywords('hello world');
    expect(result).toBeInstanceOf(Set);
  });

  it('对英文文本去重', () => {
    const result = extractKeywords('hello hello world world');
    expect(result).toEqual(new Set(['hello', 'world']));
  });

  it('对中文文本去重', () => {
    const result = extractKeywords('调试调试');
    // bigram: 调试, 试调, 调试 → 去重: 调试, 试调
    // 单字: 调, 试, 调, 试 → 去重: 调, 试
    expect(result).toEqual(new Set(['调试', '试调', '调', '试']));
  });

  it('minTokenLength=2 过滤短英文 token', () => {
    const result = extractKeywords('a bb ccc');
    // "a" 长度 1 < 2 被过滤
    expect(result).toEqual(new Set(['bb', 'ccc']));
  });

  it('空字符串返回空 Set', () => {
    expect(extractKeywords('')).toEqual(new Set());
  });

  it('中英混合文本提取关键词', () => {
    const result = extractKeywords('运行npm install');
    expect(result).toEqual(new Set(['运行', '运', '行', 'npm', 'install']));
  });
});

describe('textSimilarity 文本相似度', () => {
  it('相同文本相似度为 1', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('完全不同的英文文本相似度为 0', () => {
    expect(textSimilarity('hello', 'world')).toBe(0);
  });

  it('部分相似文本相似度在 0 和 1 之间', () => {
    const similarity = textSimilarity('hello world', 'hello foo');
    // extractKeywords('hello world') = {'hello', 'world'}
    // extractKeywords('hello foo') = {'hello', 'foo'}
    // 交集 = 1, 并集 = 3, 相似度 = 1/3
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
    expect(similarity).toBeCloseTo(1 / 3, 5);
  });

  it('两段空文本相似度为 1', () => {
    expect(textSimilarity('', '')).toBe(1);
  });

  it('一段空一段非空相似度为 0', () => {
    expect(textSimilarity('', 'hello')).toBe(0);
    expect(textSimilarity('hello', '')).toBe(0);
  });

  it('相同中文文本相似度为 1', () => {
    expect(textSimilarity('调试代码', '调试代码')).toBe(1);
  });

  it('部分相似的中文文本相似度在 0 和 1 之间', () => {
    const similarity = textSimilarity('调试代码', '调试问题');
    // extractKeywords('调试代码') = {'调试', '试代', '代码', '调', '试', '代', '码'}
    // extractKeywords('调试问题') = {'调试', '试问', '问题', '调', '试', '问', '题'}
    // 交集 = {'调试', '调', '试'} = 3
    // 并集 = 7 + 7 - 3 = 11
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
    expect(similarity).toBeCloseTo(3 / 11, 5);
  });

  it('完全不同的中文文本相似度为 0', () => {
    expect(textSimilarity('苹果', '香蕉')).toBe(0);
  });
});
