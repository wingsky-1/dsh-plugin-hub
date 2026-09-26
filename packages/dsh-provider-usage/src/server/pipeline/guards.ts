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
 * 信号合流：内部 AbortController 承担超时兜底；可选外部信号经
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
    return { error: "fetchData 已被取消" };
  }
  const scope = beginFetchScope(timeoutMs, externalSignal);
  try {
    // 合并信号下发给用户 fetchData：超时兜底与外部取消共用同一 signal，
    // 底层 fetch 收到 abort 后中断真实请求（超时文案稳定为「fetchData 超时」）
    const userP = Promise.resolve().then(() => fn(scope.signal));
    // 信号透传后，超时/外部取消判负的用户 promise 会随后收到
    // abort 拒绝——挂一个空 catch 防 unhandled rejection（错误仍经下方 catch 上报）
    userP.catch(() => {});
    const raw = await Promise.race([userP, rejectOnAbort(scope)]);
    return validateFetchedData(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  } finally {
    scope.finish();
  }
}

/**
 * 取数信号作用域：内部 controller 承担超时兜底，可选外部信号经**手动级联监听**并入
 * 同一 controller（不用 AbortSignal.any——engines node>=20 全系兼容）。finish() 幂等
 * 收口：置 done、停表、摘外部监听，防止长生命周期外部信号累积监听器泄漏。
 */
function beginFetchScope(timeoutMs: number, externalSignal: AbortSignal | undefined) {
  const controller = new AbortController();
  let done = false;
  let timedOut = false;
  const cascadeAbort = (): void => {
    if (!done) controller.abort();
  };
  if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", cascadeAbort, { once: true });
  }
  const timer = setTimeout(() => {
    if (!done) {
      timedOut = true;
      controller.abort();
    }
  }, timeoutMs);
  return {
    signal: controller.signal,
    /** 超时与外部取消的判别文案（timedOut 此刻才定，别提前冻结）。 */
    abortError: (): Error => new Error(timedOut ? "fetchData 超时" : "fetchData 已被取消"),
    finish: (): void => {
      done = true;
      clearTimeout(timer);
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", cascadeAbort);
      }
    },
  };
}

/** abort 竞速的败者分支（safeFormat 的超时文案同构复用）。 */
function rejectOnAbort(scope: ReturnType<typeof beginFetchScope>): Promise<never> {
  return new Promise<never>((_, reject) => {
    scope.signal.addEventListener("abort", () => reject(scope.abortError()), { once: true });
  });
}

/** 普通对象判定（承担类型收窄：数组与 null 都不是可落盘/下发的对象载荷）。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 序列化校验：确保可写入 JSONL / 下发客户端。JSON 往返（不可序列化的值由
 * JSON.stringify 抛错，错误经调用方 catch 上报为 error 分支）。
 */
export function validateFetchedData(raw: unknown): {
  data?: Record<string, unknown>;
  error?: string;
} {
  const parsed: unknown = JSON.parse(JSON.stringify(raw));
  if (!isPlainRecord(parsed)) return { error: "fetchData 必须返回对象" };
  return { data: parsed };
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
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new Error(`${name} 超时`));
          },
          { once: true },
        );
      }),
    ]);
    if (typeof html !== "string") return { error: `${name} 必须返回字符串` };
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
