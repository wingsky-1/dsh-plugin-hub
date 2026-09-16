/**
 * dsh-notifier — 清理栈（两端共享的 disposer 登记面）的判据。
 *
 * 为什么这些判据不可省：宿主 assemble() 与客户端 apply() 都靠它保证「卸载时一个资源都不落」。
 * 收口前两端各写一份实现（宿主 safeDisposeAll 逆序吞错；客户端正序、且一条抛错就跳过其余），
 * 而「登记不得晚于获取」这条不变量只写在注释里——R5 的漏清理正是这么来的。这里把三条语义钉死：
 * 未 attach 不许登记、逆序释放且单条失败不跳过、释放之后登记当场释放。
 */
import { describe, expect, it } from "vitest";

import { createDisposerStack } from "../../src/shared/interface.ts";

/** 假宿主：抓住登记进来的 ctx.effect 回调，由判据自己触发释放。 */
function harness() {
  const effects: Array<() => void> = [];
  const registered: string[] = [];
  const host = {
    effect(callback: () => () => void, id: string) {
      effects.push(callback());
      registered.push("effect:" + id);
    },
  };
  return { host, registered, effects, release: () => effects.forEach((fire) => fire()) };
}

describe("createDisposerStack：采集与登记点", () => {
  it("attach 之前就可以采集：登记点在后、清理不丢（宿主/客户端的 try-finally 形态）", () => {
    const stack = createDisposerStack();
    const { host, registered, release } = harness();
    const fired: string[] = [];
    stack.own(() => fired.push("collected-before-attach"));
    stack.acquire(
      () => "v",
      (value) => fired.push("acquired:" + value),
    );
    expect(fired).toEqual([]);
    stack.attach(host, "id");
    expect(registered).toEqual(["effect:id"]);
    release();
    expect(fired).toEqual(["acquired:v", "collected-before-attach"]);
  });

  it("attach 只能一次（第二次会顶掉先挂的那份，先挂的永远不释放）", () => {
    const stack = createDisposerStack();
    const { host } = harness();
    stack.attach(host, "a");
    expect(() => stack.attach(host, "b")).toThrow(/attach 只能调用一次/);
  });

  it("attach 只登记 ctx.effect，回调触发时才释放", () => {
    const stack = createDisposerStack();
    const { host, registered, release } = harness();
    const fired: string[] = [];
    stack.attach(host, "dsh-notifier");
    stack.own(() => fired.push("x"));
    expect(registered).toEqual(["effect:dsh-notifier"]);
    expect(fired).toEqual([]);
    release();
    expect(fired).toEqual(["x"]);
  });
});

describe("createDisposerStack：释放语义", () => {
  it("逆序释放：后获取的先释放（后装的域可能依赖先装的域还活着）", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    const order: string[] = [];
    stack.attach(host, "id");
    stack.own(() => order.push("first"));
    stack.own(() => order.push("second"));
    stack.own(() => order.push("third"));
    release();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("acquire 返回 make 的产物，释放时把产物交给 release", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    const closed: string[] = [];
    stack.attach(host, "id");
    const session = stack.acquire(
      () => ({ id: "s1" }),
      (value) => closed.push(value.id),
    );
    expect(session.id).toBe("s1");
    expect(closed).toEqual([]);
    release();
    expect(closed).toEqual(["s1"]);
  });

  it("make 抛错则不留登记、异常原样冒泡（资源没建成，就没有要释放的东西）", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    const closed: string[] = [];
    stack.attach(host, "id");
    expect(() =>
      stack.acquire(
        () => {
          throw new Error("boot");
        },
        () => closed.push("never"),
      ),
    ).toThrow("boot");
    release();
    expect(closed).toEqual([]);
  });

  it("单条清理抛错不跳过其余，错误交给 onError 留痕", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    const seen: unknown[] = [];
    const order: string[] = [];
    stack.attach(host, "id", (error) => seen.push(error));
    stack.own(() => order.push("a"));
    stack.own(() => {
      throw new Error("boom");
    });
    stack.own(() => order.push("c"));
    expect(() => release()).not.toThrow();
    expect(order).toEqual(["c", "a"]);
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("boom");
  });

  it("不传 onError 时清理失败静默（宿主端「卸载阶段不上报」的既有语义）", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    stack.attach(host, "id");
    stack.own(() => {
      throw new Error("quiet");
    });
    expect(() => release()).not.toThrow();
  });

  it("释放幂等：回调被触发两次，每条只执行一次", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    let count = 0;
    stack.attach(host, "id");
    stack.own(() => {
      count += 1;
    });
    release();
    release();
    expect(count).toBe(1);
  });

  it("释放之后再登记当场释放（晚到的资源不该留在没人再看的清单里）", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    const fired: string[] = [];
    stack.attach(host, "id");
    release();
    stack.own(() => fired.push("late"));
    expect(fired).toEqual(["late"]);
    const value = stack.acquire(
      () => "v",
      (releasedValue) => fired.push("late:" + releasedValue),
    );
    expect(value).toBe("v");
    expect(fired).toEqual(["late", "late:v"]);
  });

  it("重入释放（某条 teardown 里再触发释放）不会重复执行", () => {
    const stack = createDisposerStack();
    const { host, release } = harness();
    const order: string[] = [];
    stack.attach(host, "id");
    stack.own(() => {
      order.push("inner");
      release();
    });
    stack.own(() => order.push("outer"));
    release();
    expect(order).toEqual(["outer", "inner"]);
  });
});
