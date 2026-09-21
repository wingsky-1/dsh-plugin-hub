/**
 * tools 域实现：并发信号量（自研内联；状态收进闭包，无模块级可变状态）。
 *
 * 从 client.ts 拆出（内聚收窄）：并发控制与线协议分属不同职责。
 */

/** 并发信号量（闭包状态；max≤0 即视同 1）。 */
export function createSemaphore(max: number): {
  readonly run: <T>(task: () => Promise<T>) => Promise<T>;
} {
  const limit = Number.isInteger(max) && max > 0 ? max : 1;
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      active += 1;
      next();
    }
  };
  const run = <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
  return { run };
}
