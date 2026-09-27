/**
 * 客户端绑定状态（bindings.ts）—— 逐条断言「快照什么时候变、什么时候不许变」。
 *
 * 为什么单列：这个模块的失效形态是「把根弹回 cwd」或「白刷一次渲染」，两者都不抛异常。
 * 它此前只经装配根间接覆盖，而装配根那条路径上「失败」表现为 `readBinding` 返回 undefined
 * （HTTP 非 2xx、网络异常都被它自己吞了）——于是 `refresh` 里**read 抛错**那条分支
 * 全仓没有判据：把「保持上次成功态」改成「失败就清空」，没有任何用例会红。
 */
import { describe, expect, it } from "vitest";
import { createBindingState } from "../../src/client/bindings.ts";

describe("createBindingState", () => {
  it("成功时更新快照并通知一次", async () => {
    const state = createBindingState(async () => ({ revision: 1, worktreePath: "/wt" }), "s1");
    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });

    await state.refresh();

    expect(state.getSnapshot()).toBe("/wt");
    expect(notified).toBe(1);
  });

  it("read 抛错时保持上次成功态、不通知", async () => {
    let fail = false;
    const state = createBindingState(async () => {
      if (fail) throw new Error("network down");
      return { revision: 1, worktreePath: "/wt" };
    }, "s1");
    await state.refresh();

    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });
    fail = true;
    await state.refresh();

    // 抛错与「宿主说没有绑定」是两件事：前者必须保留上一次的成功读数。
    expect(state.getSnapshot()).toBe("/wt");
    expect(notified).toBe(0);
  });

  it("read 回 undefined（宿主失败）时保持上次成功态、不通知", async () => {
    let body: { revision: number; worktreePath: string | null } | undefined = {
      revision: 1,
      worktreePath: "/wt",
    };
    const state = createBindingState(async () => body, "s1");
    await state.refresh();

    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });
    body = undefined;
    await state.refresh();

    expect(state.getSnapshot()).toBe("/wt");
    expect(notified).toBe(0);
  });

  it("revision 变小（乱序返回）时丢弃，不回退快照", async () => {
    let body = { revision: 2, worktreePath: "/new" };
    const state = createBindingState(async () => body, "s1");
    await state.refresh();

    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });
    body = { revision: 1, worktreePath: "/old" };
    await state.refresh();

    expect(state.getSnapshot()).toBe("/new");
    expect(notified).toBe(0);
  });

  it("内容没变时不通知（避免渲染层白刷）", async () => {
    const state = createBindingState(async () => ({ revision: 1, worktreePath: "/wt" }), "s1");
    await state.refresh();

    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });
    await state.refresh();

    expect(notified).toBe(0);
  });

  it("退订之后不再收到通知", async () => {
    const state = createBindingState(async () => ({ revision: 1, worktreePath: "/wt" }), "s1");
    let notified = 0;
    const off = state.subscribe(() => {
      notified += 1;
    });
    off();

    await state.refresh();

    expect(notified).toBe(0);
  });
});
