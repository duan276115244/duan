/**
 * QueryEngine 全局单例 — 让所有模块共享同一个 QueryEngine 实例
 *
 * 设计目的：
 * - 避免每个模块各自创建 QueryEngine 实例（熔断器状态应全局共享）
 * - 修复散落 LLM 调用绕过 QueryEngine 的问题
 * - 类似 checkpoint-singleton.ts 的模式
 *
 * 使用方式：
 * 1. bootstrap.ts 创建 QueryEngine 后调用 registerQueryEngine(engine)
 * 2. 其他模块通过 getQueryEngine() 获取实例
 * 3. 如果未注册，getQueryEngine() 返回 null，模块降级为直接调用
 */

import type { QueryEngine, QueryEngineStats } from './query-engine.js';

let instance: QueryEngine | null = null;

/** 注册全局 QueryEngine 实例（由 bootstrap.ts 调用） */
export function registerQueryEngine(engine: QueryEngine): void {
  instance = engine;
}

/** 获取全局 QueryEngine 实例（未注册时返回 null） */
export function getQueryEngine(): QueryEngine | null {
  return instance;
}

/**
 * 便捷方法：通过 QueryEngine 调用 LLM（如果可用）
 * 未注册 QueryEngine 时降级为直接调用
 *
 * @param client OpenAI 兼容客户端
 * @param params 请求参数
 * @param options 请求选项（如 signal）
 * @param model 模型名
 * @returns LLM 响应
 */
export function callLLMWithRecovery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { chat: { completions: { create: (params: any, options?: any) => Promise<any> } } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: { signal?: AbortSignal } & Record<string, any>,
  model: string,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const engine = instance;
  if (engine) {
    return engine.createWithRecovery(client, params, options, model);
  }
  // 降级：直接调用（无重试/熔断/降级保护）
  return client.chat.completions.create(params, options);
}

/** 获取 QueryEngine 统计（未注册时返回 null） */
export function getQueryEngineStats(): QueryEngineStats | null {
  return instance?.getStats() ?? null;
}

/** 重置单例（仅用于测试） */
export function resetQueryEngine(): void {
  instance = null;
}
