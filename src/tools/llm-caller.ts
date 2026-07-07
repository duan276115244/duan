import { ModelLibrary } from '../core/model-library.js';

let _modelLibrary: ModelLibrary | null = null;

function getLibrary(): ModelLibrary {
  if (!_modelLibrary) {
    _modelLibrary = ModelLibrary.getInstance();
  }
  return _modelLibrary;
}

export function injectLLMCallerLibrary(lib: ModelLibrary): void {
  _modelLibrary = lib;
}

/**
 * 带重试的 LLM 调用
 * 失败时抛出错误而非静默返回空字符串
 * 最多重试 2 次（共 3 次尝试）
 */
export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const lib = getLibrary();
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await lib.call(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          temperature: options?.temperature ?? 0.7,
          maxTokens: options?.maxTokens ?? 2048,
          autoFallback: true,
        },
      );
      return result.content;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        // 指数退避：500ms, 1000ms
        const delay = 500 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`callLLM 失败（已重试 ${maxRetries} 次）: ${lastError?.message || '未知错误'}`);
}
