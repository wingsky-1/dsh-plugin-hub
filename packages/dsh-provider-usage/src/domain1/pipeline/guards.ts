/**
 * dsh-provider-usage — 用户代码安全执行守卫。
 *
 * 纪律（用户明确要求）：
 * 1. 用户代码报错一定不能导致插件崩溃 —— 所有用户函数调用经本模块包装。
 * 2. 一定不能有阻塞/挂起的连接 —— 超时 + AbortSignal 传递，请求不挂起（取数超时固定 5s）。
 */

/**
 * 对用户 fetchData 的调用包装：强制超时（管线注入固定 5s）+ 信号合流下发 +
 * 序列化校验 + 错误隔离。
 *
 * 信号合流（issue #120 P0）：内部 AbortController 承担超时兜底；可选外部信号经
 * **手动级联监听**并入同一 controller（不用 AbortSignal.any——engines node>=20
 * 全系兼容），合并后的 signal 经 fn(signal) 下发给用户 fetchData。适配器把它
 * 透传给底层 fetch 的 RequestInit.signal 即可在超时/外部取消时真正中断请求，
 * 不再悬挂 socket；0 参声明的 fetchData 忽略入参，完全向后兼容。
 *
 * @param fn 用户 fetchData（入参为合并信号；0 参调用兼容）
 * @param timeoutMs 超时毫秒（生产管线恒传 fetchTimeoutMs=5000；签名默认值仅兜底）
 * @param externalSignal 可选外部取消信号（如宿主请求断连），abort 时立即取消取数
 * @returns 成功返回 { data }；失败返回 { error }（绝不抛异常）。
 */
export async function safeFetchData(
  fn: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs = 2000,
  externalSignal?: AbortSignal,
): Promise<{ data?: Record<string, unknown>; error?: string }> {
  // 已 abort 的外部信号：入口同步短路（不建 controller、不发起 fn），
  // 避免「abort 早于 race 监听器注册」的事件错失悬挂
  if (externalSignal !== undefined && externalSignal.aborted) {
    return { error: 'fetchData 已被取消' };
  }
  const controller = new AbortController();
  let done = false;
  let timedOut = false;
  // 手动级联监听：外部信号 abort → 内部 controller 同步 abort（合并语义）；
  // finally 中摘除监听，防止长生命周期外部信号累积监听器泄漏。
  const cascadeAbort = (): void => {
    if (!done) controller.abort();
  };
  if (externalSignal !== undefined) {
    externalSignal.addEventListener('abort', cascadeAbort, { once: true });
  }
  const timer = setTimeout(() => {
    if (!done) {
      timedOut = true;
      controller.abort();
    }
  }, timeoutMs);
  try {
    // 合并信号下发给用户 fetchData：超时兜底与外部取消共用同一 signal，
    // 底层 fetch 收到 abort 后中断真实请求（超时文案稳定为「fetchData 超时」）
    const userP = Promise.resolve().then(() => fn(controller.signal));
    // #120 接线配套：信号透传后，超时/外部取消判负的用户 promise 会随后收到
    // abort 拒绝——挂一个空 catch 防 unhandled rejection（错误仍经下方 catch 上报）
    userP.catch(() => {});
    const raw = await Promise.race([
      userP,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(timedOut ? 'fetchData 超时' : 'fetchData 已被取消'));
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
    // 摘除外部信号上的级联监听（取数已结束，后续外部 abort 与本次调用无关）
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener('abort', cascadeAbort);
    }
  }
}

/**
 * 对用户 formatCapsule/formatPanel 的调用包装：超时由调用方注入 + 返回值类型校验。
 *
 * 注意：format 函数通常是同步的。同步死循环无法被真超时中断（JS 单线程），
 * 本包装的超时只对异步 format 生效；同步死循环由调用方文档化风险。
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