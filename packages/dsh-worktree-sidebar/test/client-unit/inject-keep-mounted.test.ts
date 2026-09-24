/**
 * keepMounted 与同 tabId 重挂载生命周期（P1/P2 跟进 dsh 0.1.7-rc.1）。
 *
 * 官方 Tab 定义新增 `keepMounted` 后，隐藏页签不再 unmount、不走 abort：
 * 它仍在册，binding 刷新必须仍 reseed；同 tabId 以新 signal 重挂载时，旧 listener
 * 必须先解绑，旧 abort 也不能删除新 record。所有清理按注册逆序且保持幂等。
 *
 * 现有基础 abort 用例保留在 `inject-attach.test.ts` 与
 * `test/client-dom/inject-visibility.test.ts`，本文件不重复、不删除它们。
 *
 * 未验证（P0 封版待补包）：`sessions.list` / `sidebar-files` / `stat`
 * 在真机 0.1.7-rc.1 上的形态未实测；本文件只用假 view/root 驱动内存语义。
 * 业务域无版本分支：无 `if (version)`，双基线可编译（新字段全可选）。
 */
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createInjectWrapper, releaseAllSeedings } from "../../src/client/inject.ts";
import type { SessionView } from "../../src/client/shared/ports.ts";

afterEach(() => {
  releaseAllSeedings();
});

interface KeepMountedFixture {
  readonly start: (tabId: string, root: string, signal?: AbortSignal) => void;
  readonly starts: Array<{ tabId: string; root: string }>;
  readonly setPath: (path: string | null) => void;
  readonly emitBinding: () => void;
  readonly subscriptions: () => number;
}

function fixture(onUnsubscribe: () => void = () => undefined): KeepMountedFixture {
  const starts: Array<{ tabId: string; root: string }> = [];
  let path: string | null = null;
  const listeners = new Set<() => void>();
  const view: SessionView = {
    source: { getSnapshot: () => ({}), subscribe: () => () => undefined },
    root: {
      getSnapshot: () => path,
      refresh: async () => {},
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          onUnsubscribe();
        };
      },
    },
  };
  const face = createInjectWrapper(() => view)(() => ({
    start: (tabId: string, root: string) => {
      starts.push({ tabId, root });
    },
  }))("s1");
  const start = face["start"];
  if (typeof start !== "function") throw new Error("Expected wrapped start");
  return {
    start: start as (tabId: string, root: string, signal?: AbortSignal) => void,
    starts,
    setPath: (next: string | null) => {
      path = next;
    },
    emitBinding: () => {
      for (const listener of [...listeners]) listener();
    },
    subscriptions: () => listeners.size,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("keepMounted：隐藏无 abort 仍 reseed", () => {
  it("无 signal 启动（隐藏不 abort）：binding 刷新后仍重播新根，且不清理订阅", async () => {
    const f = fixture();
    // keepMounted 隐藏页签：启动时无 signal，隐藏时也不会 abort。
    f.start("tab-hidden", "/repo", undefined);
    await settle();
    // 首帧只按官方 cwd 播种一次（此时绑定仍是 null，无纠正重播）。
    expect(f.starts).toEqual([{ tabId: "tab-hidden", root: "/repo" }]);
    expect(f.subscriptions()).toBe(1);

    f.setPath("/wt");
    f.emitBinding();

    expect(f.starts).toEqual([
      { tabId: "tab-hidden", root: "/repo" },
      { tabId: "tab-hidden", root: "/wt" },
    ]);
    // 隐藏不是清理条件：订阅必须还在。
    expect(f.subscriptions()).toBe(1);
  });
});

describe("keepMounted 同 tabId 重挂载", () => {
  it("新 signal 替换旧 listener，旧 abort 不删除新记录且后续只由新记录 reseed", async () => {
    const f = fixture();
    const first = new AbortController();
    const second = new AbortController();

    f.start("same-tab", "/a", first.signal);
    expect(getEventListeners(first.signal, "abort")).toHaveLength(1);

    f.start("same-tab", "/b", second.signal);
    expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(second.signal, "abort")).toHaveLength(1);
    await settle();

    first.abort();
    expect(f.subscriptions()).toBe(1);

    f.setPath("/c");
    f.emitBinding();
    expect(f.starts).toEqual([
      { tabId: "same-tab", root: "/a" },
      { tabId: "same-tab", root: "/b" },
      { tabId: "same-tab", root: "/c" },
    ]);
    expect(f.subscriptions()).toBe(1);

    second.abort();
    expect(f.subscriptions()).toBe(0);
    second.abort();
    expect(f.subscriptions()).toBe(0);
  });

  it("已取消 start 不建立 listener、record 或 root subscription，dispose 保持幂等", () => {
    const f = fixture();
    const cancelled = new AbortController();
    cancelled.abort();

    f.start("cancelled", "/a", cancelled.signal);

    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
    expect(f.starts).toEqual([]);
    expect(f.subscriptions()).toBe(0);
    releaseAllSeedings();
    releaseAllSeedings();
    expect(f.subscriptions()).toBe(0);
  });

  it("同 tabId 的已取消重挂载不替换活动 record", async () => {
    const f = fixture();
    const active = new AbortController();
    const cancelled = new AbortController();
    f.start("same-tab", "/a", active.signal);
    await settle();

    cancelled.abort();
    f.start("same-tab", "/cancelled", cancelled.signal);

    expect(getEventListeners(active.signal, "abort")).toHaveLength(1);
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
    expect(f.starts).toEqual([{ tabId: "same-tab", root: "/a" }]);
    expect(f.subscriptions()).toBe(1);

    f.setPath("/b");
    f.emitBinding();
    expect(f.starts).toEqual([
      { tabId: "same-tab", root: "/a" },
      { tabId: "same-tab", root: "/b" },
    ]);

    active.abort();
    expect(f.subscriptions()).toBe(0);
  });

  it("dispose 解绑当前 listener，重复 dispose 与 abort 保持幂等", async () => {
    const f = fixture();
    const first = new AbortController();
    const second = new AbortController();
    f.start("same-tab", "/a", first.signal);
    f.start("same-tab", "/b", second.signal);
    await settle();

    releaseAllSeedings();
    expect(f.subscriptions()).toBe(0);
    expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(second.signal, "abort")).toHaveLength(0);

    releaseAllSeedings();
    first.abort();
    second.abort();
    expect(f.subscriptions()).toBe(0);
  });

  it("多个 face 按注册逆序 dispose，重复 dispose 不重复回收", () => {
    const disposed: string[] = [];
    const first = fixture(() => disposed.push("first"));
    const second = fixture(() => disposed.push("second"));
    first.start("first", "/a");
    second.start("second", "/b");

    releaseAllSeedings();
    expect(disposed).toEqual(["second", "first"]);
    releaseAllSeedings();
    expect(disposed).toEqual(["second", "first"]);
  });
});

describe("keepMounted：record 消失才清理（abort 语义保留）", () => {
  it("隐藏 tab 留表、abort 的 tab 摘表：后续刷新只重播仍在册的那条", async () => {
    const f = fixture();
    const closable = new AbortController();
    f.start("hidden", "/repo", undefined);
    f.start("closable", "/repo", closable.signal);
    await settle();
    expect(f.subscriptions()).toBe(1);

    f.setPath("/wt");
    f.emitBinding();
    expect(f.starts.filter((s) => s.root === "/wt")).toHaveLength(2);

    // record 消失：只有 abort 的那条被摘掉，隐藏的那条仍在册。
    closable.abort();
    expect(f.subscriptions()).toBe(1);

    f.setPath("/wt2");
    f.emitBinding();
    expect(f.starts).toContainEqual({ tabId: "hidden", root: "/wt2" });
    expect(f.starts.filter((s) => s.tabId === "closable" && s.root === "/wt2")).toHaveLength(0);
  });
});
