/**
 * dsh-provider-usage — 用户代码安全执行守卫。
 *
 * 纪律（用户明确要求）：
 * 1. 用户代码报错一定不能导致插件崩溃 —— 所有用户函数调用经本模块包装。
 * 2. 一定不能有阻塞/挂起的连接 —— 2s 超时 + AbortSignal 传递，请求不挂起。
 */

/**
 * 对用户 fetchData 的调用包装：2s 强制超时 + 序列化校验 + 错误隔离。
 *
 * @param fn 用户 fetchData
 * @param timeoutMs 超时毫秒（默认 2000）
 * @returns 成功返回 { data }；失败返回 { error }（绝不抛异常）。
 */
export async function safeFetchData(
  fn: () => Promise<unknown>,
  timeoutMs = 2000,
): Promise<{ data?: Record<string, unknown>; error?: string }> {
  const controller = new AbortController();
  let done = false;
  const timer = setTimeout(() => {
    if (!done) controller.abort();
  }, timeoutMs);
  try {
    // 用户 fetchData 入参中的 signal 由 caller 传入（见 pipeline），
    // 这里只做兜底超时 abort。
    const raw = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('fetchData 超时'));
        }, { once: true });
      }),
    ]);
    // 序列化校验：确保可写入 JSONL / 下发客户端
    const json = JSON.stringify(raw);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'fetchData 必须返回对象' };
    }
    return { data: parsed as Record<string, unknown> };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

/**
 * 对用户 formatCapsule/formatPanel 的调用包装：2s 超时 + 返回值类型校验。
 *
 * 注意：format 函数通常是同步的。同步死循环无法被真超时中断（JS 单线程），
 * 本包装的 2s 超时只对异步 format 生效；同步死循环由调用方文档化风险。
 */
export async function safeFormat(
  fn: () => string,
  name: string,
  timeoutMs = 2000,
): Promise<{ html?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const html = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`${name} 超时`));
        }, { once: true });
      }),
    ]);
    if (typeof html !== 'string') return { error: `${name} 必须返回字符串` };
    return { html };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带超时的 fetch（AbortController 实现），用于客户端轮询等场景。
 * 超时后 abort 请求，不挂起连接。
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs = 10000,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}