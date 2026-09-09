/**
 * dsh-mcp-manager — pipeline/timeout：调用超时兜底（#664 阶段 2 迁入）。
 *
 * 原自 middleware-utils.ts withTimeout；中间层 ws_mcp_call 与封装直呼的
 * abort 竞态处理单一实现（supervisor 路径靠 SDK timeoutMs，无此层）。
 */

/** 等待带超时（race 兜底）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}