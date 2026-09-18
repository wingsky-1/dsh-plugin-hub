import { afterEach, describe, expect, it } from "vitest";
import { createInjectWrapper, releaseAllSeedings } from "../../src/client/inject.ts";
import type { SessionView } from "../../src/client/shared/ports.ts";

/**
 * inject attach 真实闭包（CRAP 20/4 未覆盖 → 单行化后覆盖 + 复杂度 4→3）。
 * 经真实 createInjectWrapper + start 驱动 attach 的双分支：
 * 无 signal（watchAbort 空转）与带 signal abort 后清理。
 * 无文件落盘，afterEach 经 releaseAllSeedings 回收订阅，产物零污染。
 */
function viewFixture() {
  const listeners = new Set<() => void>();
  const view: SessionView = {
    source: { getSnapshot: () => ({}), subscribe: () => () => undefined },
    root: {
      getSnapshot: () => null,
      refresh: async () => {},
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const face = createInjectWrapper(() => view)(() => ({ start: () => undefined }))("s1");
  const start = face["start"];
  if (typeof start !== "function") throw new Error("Expected wrapped start");
  return {
    start: start as (tabId: string, root: string, signal?: AbortSignal) => void,
    subscriptions: () => listeners.size,
  };
}

afterEach(() => {
  releaseAllSeedings();
});

describe("inject attach 真实闭包（CRAP 覆盖）", () => {
  it("无 signal 启动不挂 abort 监听且可释放", () => {
    const f = viewFixture();
    f.start("tab-nosig", "/repo", undefined);
    expect(f.subscriptions()).toBe(1);
    releaseAllSeedings();
    expect(f.subscriptions()).toBe(0);
  });

  it("带 signal abort 后清理 watched 并释放订阅", () => {
    const f = viewFixture();
    const ctl = new AbortController();
    f.start("tab-sig", "/repo", ctl.signal);
    expect(f.subscriptions()).toBe(1);
    ctl.abort();
    expect(f.subscriptions()).toBe(0);
  });
});
