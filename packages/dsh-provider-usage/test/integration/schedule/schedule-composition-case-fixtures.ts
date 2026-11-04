import { apply } from "../../../src/apply/index.ts";
import type { ScheduleWarn } from "../../../src/server/schedule/deps.ts";

interface ApplyTestContext {
  ctx: Parameters<typeof apply>[0];
  disposers: Array<() => void | Promise<void>>;
}

/** 真实 apply 组合根的最小宿主面；仅收集 effect disposer，不替调度器做判定。 */
export function makeApplyTestContext(): ApplyTestContext {
  const disposers: Array<() => void | Promise<void>> = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: {
      register: (_route: Record<string, unknown>) => () => {},
    },
    on: () => () => {},
    llm: {
      listProviders: () => [],
    },
    fiber: { state: "active" },
    inject: (_deps: unknown, callback: (service: unknown) => void) => {
      callback({ settings: {} });
    },
    effect: (fn: () => unknown) => {
      const disposer = fn();
      if (typeof disposer === "function") {
        disposers.push(disposer as () => void | Promise<void>);
      }
      return typeof disposer === "function" ? disposer : () => {};
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], disposers };
}

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
export const quietWarn: ScheduleWarn = () => undefined;
