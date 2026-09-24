/** 并发信号量（闭包状态；max≤0 即视同 1）。 */
export function createSemaphore(max: number): {
  readonly run: <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
} {
  const limit = Number.isInteger(max) && max > 0 ? max : 1;
  let active = 0;
  const queue: { readonly start: () => void }[] = [];
  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      next.start();
    }
  };
  const abortError = (): Error => {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    return error;
  };
  const run = <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const waiter = {
        start: (): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          active += 1;
          try {
            void task()
              .then(resolve, reject)
              .finally(() => {
                active -= 1;
                pump();
              });
          } catch (cause) {
            active -= 1;
            pump();
            reject(cause);
          }
        },
      };
      const onAbort = (): void => {
        if (settled) return;
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
      pump();
    });
  };
  return { run };
}
