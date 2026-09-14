/**
 * session 作用域标准源贡献 —— 用假 `uiSession` 驱动。
 *
 * 为什么值得单独测：这条贡献是整条「改写目录根」链路上唯一与框架接触的地方。本包曾把改写塞进
 * 组件 props 的 `hooks.sessions`，而官方正文读的是框架注入的 `useSessions`，于是接管看起来成功、
 * 树却是空的（真机 `TypeError`）。这里的假件只复刻渲染器的**契约**：
 * 名册静态声明，`resolve` 对**每个**绑定都必须给出名册里的每一项——「没有绑定就不给源」会被判成配置错误，
 * 所以未绑定的原样透传只能由源自己实现（`source.ts` 的第三条硬约束）。
 */
import { describe, expect, it } from "vitest";
import { contributeSessions } from "../../src/client/contribute.ts";
import type { SessionBindingLike, UiSessionPort } from "../../src/client/ports.ts";

interface Contribution {
  readonly hooks: readonly string[];
  readonly resolve: (binding: SessionBindingLike) => {
    readonly hooks: Readonly<Record<string, unknown>>;
  };
}

function harness() {
  const provided: Contribution[] = [];
  const asked: string[] = [];
  let disposed = 0;
  const sources = new Map<string, unknown>();
  const uiSession: UiSessionPort = {
    provide: (descriptor) => {
      provided.push(descriptor as unknown as Contribution);
      return () => {
        disposed += 1;
      };
    },
  };
  const sourceFor = (sessionId: string): never => {
    asked.push(sessionId);
    let source = sources.get(sessionId);
    if (source === undefined) {
      source = { getSnapshot: () => ({}), subscribe: () => () => undefined };
      sources.set(sessionId, source);
    }
    return source as never;
  };
  return {
    uiSession,
    sourceFor,
    provided,
    asked,
    disposed: () => disposed,
    install: () => contributeSessions({ uiSession, sourceFor }),
  };
}

describe("贡献体的形状", () => {
  it("名册只声明 sessions（渲染器据此合成 useSessions）", () => {
    const h = harness();
    h.install();
    expect(h.provided.length).toBe(1);
    expect(h.provided[0]?.hooks).toEqual(["sessions"]);
  });

  it("resolve 按绑定回该会话的源：同一 id 恒回同一对象", () => {
    const h = harness();
    h.install();
    const resolve = h.provided[0]!.resolve;
    const first = resolve({ sessionId: "s1" }).hooks["sessions"];
    const second = resolve({ sessionId: "s1" }).hooks["sessions"];
    expect(first).toBe(second);
    // 不同会话必须是不同的源：共用一份会让两个会话的目录根互相覆盖。
    expect(resolve({ sessionId: "s2" }).hooks["sessions"]).not.toBe(first);
    expect(h.asked).toEqual(["s1", "s1", "s2"]);
  });

  it("未登记的会话也必须拿到源（缺项会被渲染器判成配置错误）——透传由源自己实现", () => {
    const h = harness();
    h.install();
    const source = h.provided[0]!.resolve({ sessionId: "never-bound" }).hooks["sessions"];
    expect(source).toBeDefined();
    expect(h.asked).toEqual(["never-bound"]);
  });

  it("释放函数来自 provide，原样返回", () => {
    const h = harness();
    const dispose = h.install();
    expect(h.disposed()).toBe(0);
    dispose();
    expect(h.disposed()).toBe(1);
  });
});
