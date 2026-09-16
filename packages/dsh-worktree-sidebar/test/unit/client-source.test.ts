/**
 * 会话快照的改写源 —— 引用稳定性、最小改写、未绑定即透明。
 *
 * 三条都是「失效了也不报错」的类型：引用不稳定只会让右栏持续重渲染，
 * 改多了字段会让预览与命令面板看到被我们改过的世界，未绑定不透明则等于插件在没绑定时也改变行为。
 */
import { describe, expect, it } from "vitest";
import { createSessionsSource } from "../../src/client/source.ts";

function realOf(byId: Record<string, unknown>) {
  const listeners = new Set<() => void>();
  let snapshot: { byId: Record<string, unknown> } = { byId };
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    replace(next: Record<string, unknown>) {
      snapshot = { byId: next };
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe("未绑定时完全透明", () => {
  it("原样返回真实快照（同一个对象引用）", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    const source = createSessionsSource(real.source, "s1", () => null);
    expect(source.getSnapshot()).toBe(real.source.getSnapshot());
  });
});

describe("绑定后只改写一个字段", () => {
  it("该会话的 cwd 换成 worktree，其余字段与其它会话保持原引用", () => {
    const entry = { cwd: "/repo", title: "t", other: { deep: true } };
    const other = { cwd: "/elsewhere" };
    const real = realOf({ s1: entry, s2: other });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    const snapshot = source.getSnapshot() as { byId: Record<string, Record<string, unknown>> };
    expect(snapshot.byId["s1"]?.["cwd"]).toBe("/wt");
    expect(snapshot.byId["s1"]?.["title"]).toBe("t");
    expect(snapshot.byId["s1"]?.["other"]).toBe(entry.other);
    expect(snapshot.byId["s2"]).toBe(other);
  });

  it("byId 缺失或没有该会话时原样返回（不凭空造会话）", () => {
    const empty = { getSnapshot: () => ({}), subscribe: () => () => undefined };
    expect(createSessionsSource(empty, "s1", () => "/wt").getSnapshot()).toEqual({});

    const real = realOf({ s2: { cwd: "/x" } });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    expect(source.getSnapshot()).toBe(real.source.getSnapshot());
  });
});

describe("引用稳定性", () => {
  it("同一真实快照 + 同一路径回同一个对象", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    expect(source.getSnapshot()).toBe(source.getSnapshot());
  });

  it("真实快照换了就重算", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    const before = source.getSnapshot();
    real.replace({ s1: { cwd: "/repo" } });
    expect(source.getSnapshot()).not.toBe(before);
  });

  it("路径换了就重算", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    let path: string | null = "/wt-a";
    const source = createSessionsSource(real.source, "s1", () => path);
    const before = source.getSnapshot();
    path = "/wt-b";
    expect(source.getSnapshot()).not.toBe(before);
  });

  it("从绑定回到未绑定时回真实快照本身", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    let path: string | null = "/wt";
    const source = createSessionsSource(real.source, "s1", () => path);
    expect(source.getSnapshot()).not.toBe(real.source.getSnapshot());
    path = null;
    expect(source.getSnapshot()).toBe(real.source.getSnapshot());
  });
});

describe("订阅", () => {
  it("真实源与本地 notify 都会通知订阅者", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    let calls = 0;
    const unsubscribe = source.subscribe(() => {
      calls += 1;
    });
    real.replace({ s1: { cwd: "/repo" } });
    expect(calls).toBe(1);
    source.notify();
    expect(calls).toBe(2);
    unsubscribe();
    source.notify();
    expect(calls).toBe(2);
  });

  it("退订同时摘掉真实源的订阅（不留悬挂监听）", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    const unsubscribe = source.subscribe(() => undefined);
    expect(real.listenerCount()).toBe(1);
    unsubscribe();
    expect(real.listenerCount()).toBe(0);
  });

  it("notify 遍历副本：回调里退订不打断本轮其余订阅者", () => {
    const real = realOf({ s1: { cwd: "/repo" } });
    const source = createSessionsSource(real.source, "s1", () => "/wt");
    const seen: string[] = [];
    const first = source.subscribe(() => {
      seen.push("first");
      first();
    });
    source.subscribe(() => seen.push("second"));
    source.notify();
    expect(seen).toEqual(["first", "second"]);
  });
});
