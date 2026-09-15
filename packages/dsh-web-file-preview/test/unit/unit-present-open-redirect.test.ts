/**
 * dsh-web-file-preview — 客户端装配的直连 src 单测（issue #698 重定位 + 技术债清理）。
 *
 * 与 test/client/** 的产物契约测试分工：那边用 vm 跑 lib/client.js，锁构建产物形态与
 * 顶层装配契约；这边直连 src/client/present-open-redirect.ts，锁行为分支（采集来源、
 * 「取用即清」的 pending 语义、会话工作区读不到、openResource 抛错重放、还原器身份比对）。
 *
 * 采集只读官方显式标记、不渲染任何界面，故用最小 document/window 桩即可，不需要 DOM 环境。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REDIRECT_SERVICE,
  installPresentOpenRedirect,
  type ClientContext,
  type RedirectContext,
} from "../../src/client/present-open-redirect.ts";
import { apply, inject } from "../../src/client/index.ts";

type ClickHandler = (event: unknown) => void;

type StubNode = {
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => StubNode | null;
  closest: (selector: string) => StubNode | null;
};

let clickHandlers: ClickHandler[] = [];
let removedListeners = 0;
let nativeFetchCalls = 0;
let beforeInstallFetch: unknown;

/** 带 title 的按钮（官方卡片覆盖按钮 / 正文提及都是这种形态）。 */
function button(title: string | null): StubNode {
  return {
    getAttribute: (name) => (name === "title" ? title : null),
    querySelector: () => null,
    closest: () => null,
  };
}

/** 卡片根：官方只给 data-presented-file，路径在卡内 button[title] 上。 */
function card(buttonTitle: string | null, rootTitle: string | null = null): StubNode {
  return {
    getAttribute: (name) => (name === "title" ? rootTitle : null),
    querySelector: (selector) =>
      selector === "button[title]" && buttonTitle !== null ? button(buttonTitle) : null,
    closest: () => null,
  };
}

/** 点击目标：closest 决定命中哪条采集链路（卡片 / 正文提及 / 都不是）。 */
function clickTarget(opts: { card?: StubNode | null; mention?: StubNode | null }): StubNode {
  return {
    getAttribute: () => null,
    querySelector: () => null,
    closest: (selector) => {
      if (selector === "[data-presented-file]") return opts.card ?? null;
      if (selector === "code > button[title]") return opts.mention ?? null;
      return null;
    },
  };
}

function click(target: unknown): void {
  for (const handler of [...clickHandlers]) handler({ target });
}

function callFetch(input: unknown, init?: unknown): Promise<Response> {
  const w = (globalThis as unknown as { window: { fetch: typeof fetch } }).window;
  return w.fetch(input as RequestInfo, init as RequestInit);
}

type SessionsShape = "noList" | "noSnapshot" | "noById" | "otherSession";

type CtxOptions = {
  cwd?: string;
  /** 非字符串 cwd（用于覆盖 typeof 判据）。 */
  cwdValue?: unknown;
  snapshotThrows?: boolean;
  openThrows?: boolean;
  noSessions?: boolean;
  sessionsShape?: SessionsShape;
};

/** 会话快照桩：逐级可缺，用于覆盖 sessionCwd 的每条可选链判据。 */
function sessionsFor(opts: CtxOptions): RedirectContext["sessions"] {
  if (opts.noSessions === true) return undefined;
  if (opts.sessionsShape === "noList") return {};
  if (opts.sessionsShape === "noSnapshot") return { list: {} };
  if (opts.sessionsShape === "noById") return { list: { getSnapshot: () => ({}) } };
  if (opts.sessionsShape === "otherSession") {
    return { list: { getSnapshot: () => ({ byId: { other: { cwd: "/w" } } }) } };
  }
  return {
    list: {
      getSnapshot: () => {
        if (opts.snapshotThrows === true) throw new Error("sessions unavailable");
        if (opts.cwdValue !== undefined) return { byId: { s1: { cwd: opts.cwdValue } } };
        return opts.cwd === undefined ? { byId: {} } : { byId: { s1: { cwd: opts.cwd } } };
      },
    },
  };
}

function makeCtx(opts: CtxOptions = {}): { ctx: RedirectContext; opened: string[] } {
  const opened: string[] = [];
  const ctx = {
    sessions: sessionsFor(opts),
    sidebarRight: {
      openResource: (address: string): void => {
        if (opts.openThrows === true) throw new Error("no panel owns this address");
        opened.push(address);
      },
    },
  };
  return { ctx, opened };
}

beforeEach(() => {
  clickHandlers = [];
  removedListeners = 0;
  nativeFetchCalls = 0;
  const g = globalThis as unknown as { document: unknown; window: unknown };
  g.document = {
    addEventListener: (type: string, handler: ClickHandler): void => {
      if (type === "click") clickHandlers.push(handler);
    },
    removeEventListener: (type: string, handler: ClickHandler): void => {
      if (type !== "click") return;
      clickHandlers = clickHandlers.filter((h) => h !== handler);
      removedListeners += 1;
    },
  };
  g.window = {
    fetch: (): Promise<Response> => {
      nativeFetchCalls += 1;
      return Promise.resolve(new Response("native", { status: 200 }));
    },
  };
  beforeInstallFetch = (g.window as { fetch: unknown }).fetch;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "window");
});

describe("#698 客户端收口装配", () => {
  it("#698 inject 与装配模块共用同一服务常量", () => {
    expect(inject).toEqual(["sessions", REDIRECT_SERVICE]);
  });

  it("#698 apply 装配后注册清理器，卸载时还原 fetch", () => {
    const { ctx } = makeCtx({ cwd: "/w" });
    let disposer: (() => void) | undefined;
    const g = globalThis as unknown as { window: { fetch: unknown } };
    const clientCtx: ClientContext = {
      ...ctx,
      effect: (setup: () => () => void): void => {
        disposer = setup();
      },
    };

    apply(clientCtx);
    expect(g.window.fetch).not.toBe(beforeInstallFetch);
    expect(typeof disposer).toBe("function");

    disposer?.();
    expect(g.window.fetch).toBe(beforeInstallFetch);
  });

  it("#698 装配失败只告警不抛（无 document 环境）", () => {
    const { ctx } = makeCtx({ cwd: "/w" });
    Reflect.deleteProperty(globalThis, "document");
    const clientCtx: ClientContext = { ...ctx, effect: (): void => {} };
    expect(() => apply(clientCtx)).not.toThrow();
  });

  it("#698 卡片路径经 cwd 折叠后交给官方侧栏，并合成 204", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/notes/a.md") }));

    const res = await callFetch("/api/present.open?sessionId=s1&seq=1&index=0", { method: "POST" });

    expect(opened).toEqual(["dsh-resource://file/session/s1/notes/a.md"]);
    expect(res.status).toBe(204);
    expect(nativeFetchCalls).toBe(0);
    restore();
  });

  it("#698 正文提及同样采集路径", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ mention: button("/w/mention.md") }));

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(opened).toEqual(["dsh-resource://file/session/s1/mention.md"]);
    restore();
  });

  it("#698 卡片根 title 是前向兼容的回退来源", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card(null, "/w/fallback.md") }));

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(opened).toEqual(["dsh-resource://file/session/s1/fallback.md"]);
    restore();
  });

  it("#698 无 pending 时原样透传且不打开预览", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(nativeFetchCalls).toBe(1);
    expect(opened).toEqual([]);
    restore();
  });

  it("#698 非文件路径的 title 不采信", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ mention: button("打开") }));

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(nativeFetchCalls).toBe(1);
    expect(opened).toEqual([]);
    restore();
  });

  it("#698 采集目标不是元素时不打断点击", () => {
    const { ctx } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    expect(() => click(undefined)).not.toThrow();
    expect(() => click({ closest: "not a function" })).not.toThrow();
    restore();
  });

  it("#698 reveal 原样透传（决策 1）", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/a.md") }));

    await callFetch("/api/present.open?sessionId=s1&action=reveal", { method: "POST" });

    expect(nativeFetchCalls).toBe(1);
    expect(opened).toEqual([]);
    restore();
  });

  it("#698 缺 sessionId 时透传", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/a.md") }));

    await callFetch("/api/present.open?seq=1", { method: "POST" });

    expect(nativeFetchCalls).toBe(1);
    expect(opened).toEqual([]);
    restore();
  });

  it("#698 会话工作区读不到时不折叠但仍然接管", async () => {
    const { ctx, opened } = makeCtx({ snapshotThrows: true });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/a.md") }));

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(opened).toEqual(["dsh-resource://file/session/s1//w/a.md"]);
    expect(nativeFetchCalls).toBe(0);
    restore();
  });

  it("#698 没有 sessions 服务时不折叠但仍然接管", async () => {
    const { ctx, opened } = makeCtx({ noSessions: true });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/a.md") }));

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(opened).toEqual(["dsh-resource://file/session/s1//w/a.md"]);
    restore();
  });

  it("#698 openResource 抛错时显式重放原生请求", async () => {
    const { ctx } = makeCtx({ cwd: "/w", openThrows: true });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/a.md") }));

    await callFetch("/api/present.open?sessionId=s1", { method: "POST" });

    expect(nativeFetchCalls).toBe(1);
    restore();
  });

  it("#698 pending 取用即清：第二次请求回落原生透传", async () => {
    const { ctx, opened } = makeCtx({ cwd: "/w" });
    const restore = installPresentOpenRedirect(ctx);
    click(clickTarget({ card: card("/w/a.md") }));

    await callFetch("/api/present.open?sessionId=s1&seq=1", { method: "POST" });
    await callFetch("/api/present.open?sessionId=s1&seq=2", { method: "POST" });

    expect(opened).toHaveLength(1);
    expect(nativeFetchCalls).toBe(1);
    restore();
  });

  it("#698 卸载后还原 fetch 与监听（身份比对）", () => {
    const { ctx } = makeCtx({ cwd: "/w" });
    const g = globalThis as unknown as { window: { fetch: unknown } };
    const restore = installPresentOpenRedirect(ctx);
    expect(g.window.fetch).not.toBe(beforeInstallFetch);

    restore();

    expect(g.window.fetch).toBe(beforeInstallFetch);
    expect(removedListeners).toBe(1);
    expect(clickHandlers).toHaveLength(0);
  });

  // 身份比对的意义：fetch 已被别人换掉时不得覆盖回去（HMR / 多次 apply / 第三方包装共存的场景）。
  it("#698 还原时若 fetch 已被他人替换则不覆盖", () => {
    const { ctx } = makeCtx({ cwd: "/w" });
    const g = globalThis as unknown as { window: { fetch: unknown } };
    const restore = installPresentOpenRedirect(ctx);
    const someoneElse = (): Promise<Response> =>
      Promise.resolve(new Response("other", { status: 200 }));
    g.window.fetch = someoneElse;

    restore();

    expect(g.window.fetch).toBe(someoneElse);
  });

  describe("#698 采集分支", () => {
    it.each([
      ["null", null],
      ["数字", 42],
      ["字符串", "text"],
      ["空对象", {}],
    ])("#698 非元素目标不采集也不抛（%s）", (_name, value) => {
      const { ctx } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      expect(() => click(value)).not.toThrow();
      restore();
    });

    it("#698 事件本身为 null 不采集", () => {
      const { ctx } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      for (const handler of [...clickHandlers]) expect(() => handler(null)).not.toThrow();
      restore();
    });

    it("#698 closest 返回 undefined 视为无节点", async () => {
      const { ctx, opened } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      click({
        closest: () => undefined,
        querySelector: () => null,
        getAttribute: () => null,
      });
      await callFetch("/api/present.open?sessionId=s1", { method: "POST" });
      expect(opened).toEqual([]);
      restore();
    });

    it("#698 提及节点没有 title 属性时不采集", async () => {
      const { ctx, opened } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      click(
        clickTarget({
          mention: { getAttribute: () => null, querySelector: () => null, closest: () => null },
        }),
      );
      await callFetch("/api/present.open?sessionId=s1", { method: "POST" });
      expect(opened).toEqual([]);
      restore();
    });

    it("#698 卡片无按钮且卡片根也无 title 时不采集", async () => {
      const { ctx, opened } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      click(clickTarget({ card: card(null, null) }));
      await callFetch("/api/present.open?sessionId=s1", { method: "POST" });
      expect(opened).toEqual([]);
      restore();
    });

    it("#698 提及路径不像文件路径时不采集", async () => {
      const { ctx, opened } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      click(clickTarget({ mention: button("   ") }));
      await callFetch("/api/present.open?sessionId=s1", { method: "POST" });
      expect(opened).toEqual([]);
      restore();
    });

    it("#698 未消费时新的点击覆盖旧路径", async () => {
      const { ctx, opened } = makeCtx({ cwd: "/w" });
      const restore = installPresentOpenRedirect(ctx);
      click(clickTarget({ card: card("/w/first.md") }));
      click(clickTarget({ card: card("/w/second.md") }));
      await callFetch("/api/present.open?sessionId=s1", { method: "POST" });
      expect(opened).toEqual(["dsh-resource://file/session/s1/second.md"]);
      restore();
    });
  });

  // 这组是**行为契约**（读不到工作区即不折叠、但仍接管），不是变异杀手：catch 兜底让
  // 「可选链直取」与「逐级判空」在结果上不可区分。真正的变异杀手在下面的「取用即清」与
  // 「openResource 抛错重放」两条。
  describe("#698 会话工作区读取分支", () => {
    it.each([
      ["sessions 服务缺失", { noSessions: true } satisfies CtxOptions],
      ["list 缺失", { sessionsShape: "noList" } satisfies CtxOptions],
      ["getSnapshot 缺失", { sessionsShape: "noSnapshot" } satisfies CtxOptions],
      ["快照无 byId", { sessionsShape: "noById" } satisfies CtxOptions],
      ["快照没有该会话", { sessionsShape: "otherSession" } satisfies CtxOptions],
      ["cwd 为空串", { cwd: "" } satisfies CtxOptions],
      ["cwd 不是字符串", { cwdValue: 123 } satisfies CtxOptions],
    ])("#698 工作区读不到时不折叠但仍接管（%s）", async (_name, opts) => {
      const { ctx, opened } = makeCtx(opts);
      const restore = installPresentOpenRedirect(ctx);
      click(clickTarget({ card: card("/w/a.md") }));
      await callFetch("/api/present.open?sessionId=s1", { method: "POST" });
      expect(opened).toEqual(["dsh-resource://file/session/s1//w/a.md"]);
      expect(nativeFetchCalls).toBe(0);
      restore();
    });
  });
});
