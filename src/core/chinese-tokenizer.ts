/**
 * 中文分词工具 — 支持中英文混合文本的智能分词
 *
 * 问题背景：多个模块使用 split(/\s+/) 处理文本，但中文没有空格分隔，
 * 导致整段中文被视为单个 token，相似度计算和关键词匹配完全失效。
 *
 * 解决方案：基于规则的分词，支持：
 * 1. 英文按空格分词
 * 2. 中文按字符 bigram + 标点断句分词
 * 3. 数字保持完整
 * 4. 混合文本正确处理
 */

/** 中文标点符号集合 */
const CJK_PUNCTUATION = /[\s,，。.!！?？;；:：、\n\r\t()（）[\]【】{}""''「」《》〈〉·…—\-_=+|\\/@#$%^&*~`"']/;

/** 判断字符是否为 CJK 字符 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0);
  if (!code) return false;
  // CJK Unified Ideographs: 4E00-9FFF
  // CJK Unified Ideographs Extension A: 3400-4DBF
  // CJK Unified Ideographs Extension B-H: 20000-323AF
  // CJK Compatibility Ideographs: F900-FAFF
  // Hiragana: 3040-309F, Katakana: 30A0-30FF
  return (code >= 0x4E00 && code <= 0x9FFF) ||
         (code >= 0x3400 && code <= 0x4DBF) ||
         (code >= 0x20000 && code <= 0x323AF) ||
         (code >= 0xF900 && code <= 0xFAFF) ||
         (code >= 0x3040 && code <= 0x309F) ||
         (code >= 0x30A0 && code <= 0x30FF);
}

/**
 * 对中英文混合文本进行智能分词
 *
 * 策略：
 * - 英文单词：按空格/标点分割
 * - 中文：生成 bigram（相邻两字组合）+ 单字，以捕获语义
 * - 数字：保持完整
 * - 过滤空字符串和纯标点
 *
 * @param text 输入文本
 * @param options 分词选项
 * @returns 分词结果数组
 *
 * @example
 * tokenize('调试代码问题')  // => ['调试', '试代', '代码', '码问', '问题', '调', '试', '代', '码', '问', '题']
 * tokenize('hello world')  // => ['hello', 'world']
 * tokenize('运行npm install')  // => ['运行', '行n', 'npm', 'install']
 */
export function tokenize(
  text: string,
  options: { minTokenLength?: number; bigramOnly?: boolean } = {}
): string[] {
  const { minTokenLength = 1, bigramOnly = false } = options;
  if (!text || typeof text !== 'string') return [];

  const tokens: string[] = [];
  let i = 0;
  const lower = text.toLowerCase();

  while (i < lower.length) {
    const char = lower[i];

    // 跳过分隔符
    if (CJK_PUNCTUATION.test(char)) {
      i++;
      continue;
    }

    // CJK 字符：生成 bigram + 单字
    if (isCJK(char)) {
      let j = i;
      // 收集连续 CJK 字符序列
      while (j < lower.length && isCJK(lower[j]) && !CJK_PUNCTUATION.test(lower[j])) {
        j++;
      }
      const cjkSegment = lower.slice(i, j);

      // 生成 bigram（CJK 分支不应用 minTokenLength：bigram 固定 2 字符，且单字是语义单元需保留）
      for (let k = 0; k < cjkSegment.length - 1; k++) {
        tokens.push(cjkSegment.slice(k, k + 2));
      }
      // 生成单字（除非 bigramOnly；CJK 单字不受 minTokenLength 限制——单字即语义单元）
      if (!bigramOnly) {
        for (let k = 0; k < cjkSegment.length; k++) {
          tokens.push(cjkSegment[k]);
        }
      }

      i = j;
      continue;
    }

    // 英文/数字：收集连续非 CJK、非分隔符字符
    let j = i;
    while (j < lower.length && !isCJK(lower[j]) && !CJK_PUNCTUATION.test(lower[j])) {
      j++;
    }
    const word = lower.slice(i, j);
    if (word.length >= minTokenLength) {
      tokens.push(word);
    }

    i = j;
  }

  return tokens;
}

/**
 * 从文本中提取关键词（去重后的分词结果）
 * 适用于搜索、相似度计算等场景
 *
 * 默认 minTokenLength=2（过滤英文单字母噪声）；CJK 单字作为语义单元始终保留。
 */
export function extractKeywords(text: string): Set<string> {
  return new Set(tokenize(text, { minTokenLength: 2 }));
}

/**
 * 计算两段文本的 Jaccard 相似度（基于分词后的关键词集合）
 *
 * 包含 CJK 单字（语义单元），使部分匹配的中文文本相似度落在 (0,1) 区间。
 */
export function textSimilarity(text1: string, text2: string): number {
  const set1 = extractKeywords(text1);
  const set2 = extractKeywords(text2);

  if (set1.size === 0 && set2.size === 0) return 1;
  if (set1.size === 0 || set2.size === 0) return 0;

  let intersection = 0;
  for (const token of set1) {
    if (set2.has(token)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return union > 0 ? intersection / union : 0;
}
