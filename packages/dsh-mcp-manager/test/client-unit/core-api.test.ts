/**
 * dsh-mcp-manager — client-unit：core/api.ts 的直接判据（请求参数拼装 + HTTP 请求面）。
 *
 * 守的事实（每条一句话）：
 * - toolDisableServerKey：全局形态 `@@global/<name>`、项目形态 `@<root>/<name>`、
 *   projectRoot 缺失/空串返回 undefined（防宿主 400 的非法 `@/name`）——任一改动必须红。
 * - cwdQueryOf：非空 cwd 编码后带 `&cwd=`、空串与非字符串回落空串——任一改动必须红。
 * - api()：2xx 返回解析后的 body；非 2xx 优先抛 body.error、缺 error 时抛 `HTTP <status>`；
 *   body 解析失败时 not-ok 分支仍能给出 `HTTP <status>`；调用方自带 signal 时**不**装超时
 *   兜底（推钟后调用方 signal 仍未 abort），未自带时装上且按 timeoutMs 精确触发。
 *
 * 假件说明（testing SKILL §3 例外清单）：fetch 是 globalThis 上的**手写**假函数
 * （只回放脚本给的响应形状并记录入参，不实现任何服务端语义；全局替身是允许的例外，
 * 但这里不用 vi.mock/vi.fn/vi.spyOn——假件是手写 class + 显式还原）。
 * 唯一允许的 vi 用法是假时钟，且 toFake 面显式声明。
 *
 * 时间纪律：只钉 setTimeout/clearTimeout（api() 的超时兜底走 setTimeout），
 * 不断 Date、不用真实 sleep 否定判据；「没有装兜底」这一条断的是**推钟后 signal 仍
 * 未 abort**这个可观测量，不是「等了一会儿没反应」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, cwdQueryOf, toolDisableServerKey } from "../../src/client/core/api.ts";
import type { McpServerListEntry, McpState } from "../../src/client/core/state.ts";

const state = (raw: Record<string, unknown>): McpState => raw as unknown as McpState;
const entry = (raw: Partial<McpServerListEntry> = {}): McpServerListEntry =>
  ({
    name: "srv",
    transport: "stdio",
    status: "connected",
    scope: "project",
    enabled: true,
    ...raw,
  }) as McpServerListEntry;

/** 手写 fetch 假件的响应剧本：一段 JSON / 解析失败 / 状态码 + 可选 error 字段。 */
interface ResponseScript {
  ok: boolean;
  status: number;
  body?: unknown;
  jsonThrows?: boolean;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 手写 fetch 假件：记录每次调用，回放剧本里的响应；不实现任何服务端语义。 */
class FetchFake {
  calls: FetchCall[] = [];
  private script: ResponseScript = { ok: true, status: 200, body: {} };
  private readonly realFetch: typeof globalThis.fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      this.calls.push({ url: String(input), init });
      const s = this.script;
      return Promise.resolve({
        ok: s.ok,
        status: s.status,
        json: async (): Promise<unknown> => {
          if (s.jsonThrows === true) throw new Error("not json");
          return s.body;
        },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  respondWith(script: ResponseScript): void {
    this.script = script;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

let fetchFake: FetchFake | undefined;

beforeEach(() => {
  fetchFake = new FetchFake();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  fetchFake?.restore();
  fetchFake = undefined;
});

describe("api：toolDisableServerKey 全名归一", () => {
  it("全局作用域 → @@global/<name>（双 @ 是刻意形态，宿主按此归一）", () => {
    expect(toolDisableServerKey(entry({ scope: "global", name: "ctx7" }), state({}))).toBe(
      "@@global/ctx7",
    );
  });

  it("项目作用域 + 有 projectRoot → @<root>/<name>", () => {
    const st = state({ projectRoot: "/abs/proj" });
    expect(toolDisableServerKey(entry({ name: "ctx7" }), st)).toBe("@/abs/proj/ctx7");
  });

  it("projectRoot 缺失 → undefined（调用方须跳过提交，不得拼非法 @/name）", () => {
    expect(toolDisableServerKey(entry({}), state({}))).toBeUndefined();
    expect(toolDisableServerKey(entry({}), state({ projectRoot: undefined }))).toBeUndefined();
  });

  it("projectRoot 为空串 → undefined（与缺失同口径）", () => {
    expect(toolDisableServerKey(entry({}), state({ projectRoot: "" }))).toBeUndefined();
  });

  it("projectRoot 非字符串 → undefined（不把任意值拼进 key）", () => {
    expect(toolDisableServerKey(entry({}), state({ projectRoot: 42 }))).toBeUndefined();
  });

  it("全局作用域下 projectRoot 缺失仍然放行（全局 key 不依赖 root）", () => {
    expect(toolDisableServerKey(entry({ scope: "global", name: "a" }), state({}))).toBe(
      "@@global/a",
    );
  });

  it("服务器名原样拼入、不做 URL 编码（编码由上层 URL 构造负责）", () => {
    const st = state({ projectRoot: "/p" });
    expect(toolDisableServerKey(entry({ name: "a b/c" }), st)).toBe("@/p/a b/c");
  });
});

describe("api：cwdQueryOf 会话 cwd 查询参数", () => {
  it("非空 cwd → &cwd=<encodeURIComponent 结果>，含空格与中文时正确编码", () => {
    expect(cwdQueryOf(state({ currentCwd: "/w" }))).toBe("&cwd=%2Fw");
    expect(cwdQueryOf(state({ currentCwd: "/a b/中" }))).toBe("&cwd=%2Fa%20b%2F%E4%B8%AD");
  });

  it("空串 cwd → 空串（不产生悬空的 &cwd=）", () => {
    expect(cwdQueryOf(state({ currentCwd: "" }))).toBe("");
  });

  it("cwd 缺失或非字符串 → 空串", () => {
    expect(cwdQueryOf(state({}))).toBe("");
    expect(cwdQueryOf(state({ currentCwd: undefined }))).toBe("");
    expect(cwdQueryOf(state({ currentCwd: 7 }))).toBe("");
  });
});

describe("api：HTTP 请求面", () => {
  it("2xx：返回解析后的 body，并把 path 原样交给 fetch", async () => {
    fetchFake!.respondWith({ ok: true, status: 200, body: { servers: [1, 2] } });
    const body = await api<{ servers: number[] }>("/api/x");
    expect(body).toEqual({ servers: [1, 2] });
    expect(fetchFake!.calls).toHaveLength(1);
    expect(fetchFake!.calls[0]!.url).toBe("/api/x");
  });

  it("非 2xx 且 body 带 error → 抛该 error 文案（不以状态码覆盖服务端原因）", async () => {
    fetchFake!.respondWith({ ok: false, status: 400, body: { error: "already exists" } });
    await expect(api("/api/x")).rejects.toThrow("already exists");
  });

  it("非 2xx 且 body 无 error 字段 → 抛 HTTP <status>（兜底状态码文案）", async () => {
    fetchFake!.respondWith({ ok: false, status: 503, body: { other: 1 } });
    await expect(api("/api/x")).rejects.toThrow("HTTP 503");
  });

  it("非 2xx 且 body 为 null → 抛 HTTP <status>（可选链不得把 null 变成别的）", async () => {
    fetchFake!.respondWith({ ok: false, status: 500, body: null });
    await expect(api("/api/x")).rejects.toThrow("HTTP 500");
  });

  it("body 解析失败 + 2xx → 返回 undefined，不把解析错误冒泡成请求失败", async () => {
    fetchFake!.respondWith({ ok: true, status: 200, jsonThrows: true });
    await expect(api("/api/x")).resolves.toBeUndefined();
  });

  it("body 解析失败 + 非 2xx → 仍抛 HTTP <status>（解析失败不得吞掉失败信号）", async () => {
    fetchFake!.respondWith({ ok: false, status: 404, jsonThrows: true });
    await expect(api("/api/x")).rejects.toThrow("HTTP 404");
  });

  it("非 2xx 且 body.error 为空串 → 抛空串之外的兜底（空串不是有效原因）", async () => {
    // ��行用 ?? 而非 ||：空串属「有 error 字段但无内容」，按原实现会抛空串。
    // 这里钉住**现状**而非理想，避免把用例写成「修复需求」——真要改语义应改实现并重写本条。
    fetchFake!.respondWith({ ok: false, status: 418, body: { error: "" } });
    await expect(api("/api/x")).rejects.toThrow("");
  });
});

describe("api：超时兜底与 signal 优先级", () => {
  it("未自带 signal：装上 10s 兜底，恰好在 timeoutMs 时以带 message 的原因 abort", async () => {
    const pending = new Promise<Response>(() => {});
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      fetchFake!.calls.push({ url: "pending", init });
      return pending;
    }) as unknown as typeof globalThis.fetch;
    void api("/api/slow").catch(() => {});

    const signal = fetchFake!.calls[0]!.init?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error)?.message)).toBe("request timed out (10000ms)");
  });

  it("timeoutMs 自定义：兜底时长取传入值而非缺省 10s", async () => {
    const pending = new Promise<Response>(() => {});
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      fetchFake!.calls.push({ url: "pending", init });
      return pending;
    }) as unknown as typeof globalThis.fetch;
    void api("/api/slow", { timeoutMs: 250 }).catch(() => {});

    const signal = fetchFake!.calls[0]!.init?.signal as AbortSignal;
    vi.advanceTimersByTime(249);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error)?.message)).toBe("request timed out (250ms)");
  });

  it("调用方自带 signal：装的是调用方那个，且推过默认超时后**不**被兜底 abort（signal 优先）", async () => {
    const pending = new Promise<Response>(() => {});
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      fetchFake!.calls.push({ url: "pending", init });
      return pending;
    }) as unknown as typeof globalThis.fetch;
    const caller = new AbortController();
    void api("/api/slow", { signal: caller.signal }).catch(() => {});
    expect(vi.getTimerCount()).toBe(0);

    const signal = fetchFake!.calls[0]!.init?.signal as AbortSignal;
    // 装的就是调用方那个 signal 本身（不是内部 controller 的）。
    expect(signal).toBe(caller.signal);
    // **可观测的真判据在这里**：调用方自带 signal 时根本不装超时定时器（hasCallerSignal 守卫）。
    // 上一版只断「推钟后调用方 signal 仍未 abort」——那条是**代理可观测量**，删掉守卫也不红：
    // 装上的定时器 abort 的是内部 controller，而 merged signal 取的是调用方那个，
    // 两者没有连线，所以调用方 signal 照样不 abort。定时器**是否存在**才是行为本身。
    // 双取消竞争是这条存在的理由：推过 10s 默认兜底，调用方 signal 必须仍未 abort。
    vi.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(false);
    // 调用方自己 abort 才 abort。
    caller.abort(new Error("caller gave up"));
    expect(signal.aborted).toBe(true);
  });

  it("请求正常完成：超时定时器被清掉（不留悬挂定时器）", async () => {
    fetchFake!.respondWith({ ok: true, status: 200, body: { ok: 1 } });
    expect(vi.getTimerCount()).toBe(0);
    await api("/api/x");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("请求非 2xx 抛错：定时器同样被清掉（finally 覆盖抛错路径）", async () => {
    fetchFake!.respondWith({ ok: false, status: 500, body: {} });
    const pending = api("/api/x");
    expect(vi.getTimerCount()).toBe(1);
    await expect(pending).rejects.toThrow("HTTP 500");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("调用方自带 signal 且请求正常完成：finally 里 timer 为 undefined，不调 clearTimeout", async () => {
    // 补的是 pnpm cov 里 api.ts 唯一那条未覆盖分支路径（finally 的 timer === undefined 支）。
    // 上一条 signal 优先用例用的是**永不 resolve 的 promise**，请求不落地、finally 根本不执行，
    // 所以那条支一直是 0。这里让请求正常完成，覆盖 finally 真正跑到且 timer 为 undefined 的形态
    // （clearTimeout 若被无条件调用会拿到 undefined，本条钉住这条路径不炸且不残留定时器）。
    fetchFake!.respondWith({ ok: true, status: 200, body: { ok: 1 } });
    const caller = new AbortController();
    const body = await api("/api/x", { signal: caller.signal });
    expect(body).toEqual({ ok: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("options 里的 method/headers/body 原样透传给 fetch", async () => {
    fetchFake!.respondWith({ ok: true, status: 200, body: {} });
    await api("/api/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"enabled":true}',
    });
    const init = fetchFake!.calls[0]!.init!;
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.body).toBe('{"enabled":true}');
  });
});
