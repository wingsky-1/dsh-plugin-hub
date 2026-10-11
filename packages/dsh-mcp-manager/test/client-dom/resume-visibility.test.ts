// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：回前台 resume 发送行为（#1120）。
 *
 * 守的事实（每条一句话）：
 * - 真实挂载 apply() 后派发 visibilitychange → POST /api/dsh-mcp/resume 且 body 携带
 *   本次会话 cwd（未知会话不带 body）；
 * - 同 cwd 成功后 5s 内重复回前台只发一次（节流合并），窗后恢复发送；
 * - 不同 cwd 不互吞（切会话的恢复 5s 内照发）；
 * - 同 cwd 真正失败后节流记录被清理，立即下一次回前台照发（失败不得被无条件抑制），
 *   成功后节流重新布防。
 *
 * 为什么挂真实 apply 而不断 helper/产物字符串：postResume 的节流状态机只活在 apply
 * 闭包里（发送/抑制/失败清理的因果全在事件 → fetch 这条真链上），helper 返回值与
 * lib 字符串断言都看不见「失败后是否还抑制」——那正是主控点名的缺口。
 *
 * 假件说明（testing SKILL §3）：fetch / EventSource 均为手写替身（只记调用、按脚本
 * 回放，不实现服务端语义；不用 vi.mock/vi.fn/vi.spyOn）。唯一 vi 用法是假时钟，
 * toFake 面显式声明（含 Date——节流窗读 Date.now，不钉它就得等真 5s）。
 * 时间纪律：只推进假时钟，不用真实 sleep；网络以微任务排空（settle）收敛，不用轮询。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apply } from "../../src/client/index.ts";
import { API } from "../../src/client/core/constants.ts";
import type { McpClientContext } from "../../src/client/core/state.ts";
import { bindLocale } from "../../../../shared/client/i18n.js";

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

interface ResumeScript {
  ok: boolean;
  status: number;
  body: unknown;
}

/** 延迟结算的 resume 剧本：fetch 永不 resolve，由用例手动 reject（模拟迟到失败）。 */
interface PendingResumeScript {
  pending: true;
}

type ResumeNext = ResumeScript | PendingResumeScript;

let calls: FetchCall[];
let resumeScript: ResumeNext[];
/** 挂起中 resume 请求的 reject 口（按发送顺序）。 */
let pendingResumeRejects: Array<(error: unknown) => void>;
let realFetch: typeof globalThis.fetch;
let realEventSource: typeof globalThis.EventSource;
let disposers: Array<() => void>;
/** bindSession 的 subscribe 回调（切会话时手动触发，模拟官方会话面推送）。 */
let sessionPush: (() => void) | undefined;
/** 当前会话快照（按官方口径 retainedBy.mainView > 0 持有当前行）。 */
let snapshotRow: { retainedBy: { mainView: number }; cwd: string | undefined; blank: boolean };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function setCwd(cwd: string | undefined): void {
  snapshotRow = { retainedBy: { mainView: 1 }, cwd, blank: cwd === "" || cwd === undefined };
}

function resumeCalls(): FetchCall[] {
  return calls.filter((call) => call.url === API.resume && call.method === "POST");
}

function resumeCwds(): Array<string | undefined> {
  return resumeCalls().map((call) =>
    call.body === undefined
      ? undefined
      : ((JSON.parse(call.body) as { cwd?: unknown }).cwd as string | undefined),
  );
}

/** 手写 EventSource 替身：只记实例、不自动触发 onopen（回前台路径只走 visibilitychange）。 */
class MockEventSource {
  static readonly CLOSED = 2;
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readonly readyState = 1;
  onopen: (() => void) | undefined;
  onmessage: ((ev: unknown) => void) | undefined;
  onerror: (() => void) | undefined;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
}

/** 记录一次 fetch 调用（请求行 + 文本 body），返回路由分流用的请求行。 */
function recordCall(
  input: unknown,
  init: RequestInit | undefined,
): { url: string; method: string } {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const rawBody = (init as { body?: unknown } | undefined)?.body;
  calls.push({
    url,
    method,
    body: typeof rawBody === "string" ? rawBody : undefined,
  });
  return { url, method };
}

/** resume 路由的剧本回放：队列逐个消费，pending 挂起由用例手动 reject，缺省成功。 */
function resumeReply(): Promise<unknown> {
  const next: ResumeNext =
    resumeScript.length > 0
      ? (resumeScript.shift() as ResumeNext)
      : { ok: true, status: 200, body: { ok: true } };
  if ("pending" in next) {
    return new Promise((_resolve, reject) => {
      pendingResumeRejects.push(reject);
    });
  }
  return Promise.resolve({
    ok: next.ok,
    status: next.status,
    json: async (): Promise<unknown> => next.body,
  });
}

/** 非 resume 路由的静态回放（GET 快照与 POST 回执，不实现服务端语义）。 */
function staticReply(url: string, method: string): Promise<unknown> | undefined {
  if (url === API.session && method === "POST") {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({ ok: true }),
    });
  }
  if (url === API.servers && method === "GET") {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({ servers: [], counts: {}, projectRoot: "/proj" }),
    });
  }
  if (url === API.config && method === "GET") {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({
        position: "top-right",
        offsetX: 8,
        offsetY: 8,
        blankY: 40,
      }),
    });
  }
  return undefined;
}

function installFetch(): void {
  const fake = async (input: unknown, init?: RequestInit): Promise<unknown> => {
    const { url, method } = recordCall(input, init);
    if (url === API.resume && method === "POST") return resumeReply();
    return (
      staticReply(url, method) ?? {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({}),
      }
    );
  };
  globalThis.fetch = fake as unknown as typeof fetch;
}

function mount(): void {
  const list = {
    getSnapshot: () => ({
      ids: ["s1"],
      byId: { s1: snapshotRow },
      phase: "ready",
      projectionsBySession: {},
    }),
    subscribe: (cb: () => void) => {
      sessionPush = cb;
      return () => {
        sessionPush = undefined;
      };
    },
  };
  const ctx = {
    get: (_name: string) => undefined,
    effect: (fn: () => () => void) => {
      disposers.push(fn());
    },
    sessions: { list },
  } as unknown as McpClientContext;
  apply(ctx);
}

function backToForeground(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  document.body.textContent = "";
  calls = [];
  resumeScript = [];
  pendingResumeRejects = [];
  disposers = [];
  sessionPush = undefined;
  setCwd("/proj/a");
  realFetch = globalThis.fetch;
  realEventSource = globalThis.EventSource;
  installFetch();
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  try {
    // happy-dom 下 document.hidden 可覆写；失败则沿用默认（默认非隐藏）。
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  } catch {
    // 沿用默认读数（非隐藏即满足回前台前置）。
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "mcpManager",
  );
});

afterEach(async () => {
  await settle();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  document.body.textContent = "";
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
});

describe("回前台 resume 发送行为（真实 apply）", () => {
  it("回前台发 resume 且 body 携带本次会话 cwd", async () => {
    mount();
    await settle();
    expect(resumeCalls(), "挂载本身不发 resume").toHaveLength(0);
    backToForeground();
    await settle();
    expect(resumeCalls()).toHaveLength(1);
    expect(resumeCwds()).toEqual(["/proj/a"]);
  });

  it("同 cwd 成功后 5s 内重复回前台只发一次，窗后恢复发送", async () => {
    mount();
    await settle();
    backToForeground();
    await settle();
    backToForeground();
    await settle();
    expect(resumeCalls(), "同 cwd 窗内合并").toHaveLength(1);
    vi.advanceTimersByTime(5000);
    backToForeground();
    await settle();
    expect(resumeCalls(), "窗后恢复发送").toHaveLength(2);
    expect(resumeCwds()).toEqual(["/proj/a", "/proj/a"]);
  });

  it("不同 cwd 不互吞（5s 内切会话照发）", async () => {
    mount();
    await settle();
    backToForeground();
    await settle();
    expect(resumeCalls()).toHaveLength(1);
    // 切会话：官方会话面推送新 cwd（bindSession 同步跟随）。
    setCwd("/proj/b");
    sessionPush?.();
    await settle();
    backToForeground();
    await settle();
    expect(resumeCalls(), "不同 cwd 不被节流吞掉").toHaveLength(2);
    expect(resumeCwds()).toEqual(["/proj/a", "/proj/b"]);
  });

  it("同 cwd 失败后立即重试照发，成功后节流重新布防", async () => {
    resumeScript.push({ ok: false, status: 500, body: { error: "boom" } });
    mount();
    await settle();
    backToForeground();
    await settle();
    expect(resumeCalls(), "失败请求照发").toHaveLength(1);
    // 失败清理节流记录：同一 ms 内立即回前台不得被抑制。
    backToForeground();
    await settle();
    expect(resumeCalls(), "失败后立即重试").toHaveLength(2);
    // 重试成功后节流重新布防：窗内再回前台被合并。
    backToForeground();
    await settle();
    expect(resumeCalls(), "成功后节流重新布防").toHaveLength(2);
  });

  it("A1 延迟失败不误清同毫秒 B/A2 成功窗口（attempt 身份唯一）", async () => {
    // 三次发送同毫秒（假时钟全程不推进）：A1 挂起、B 成功、切回 A2 成功，随后 A1 才失败。
    // key+stamp 在三者完全相同——清理若只认 (cwd, Date.now) 就会误清 A2 的成功窗口。
    resumeScript.push({ pending: true });
    mount();
    await settle();
    backToForeground(); // resume#1 A1（挂起）
    await settle();
    expect(resumeCalls()).toHaveLength(1);
    setCwd("/proj/b");
    sessionPush?.();
    await settle();
    backToForeground(); // resume#2 B（成功）
    await settle();
    setCwd("/proj/a");
    sessionPush?.();
    await settle();
    backToForeground(); // resume#3 A2（成功）
    await settle();
    expect(resumeCalls()).toHaveLength(3);
    // A1 延迟失败：不得误清 A2 建的成功窗口。
    for (const reject of pendingResumeRejects.splice(0)) reject(new Error("late A1 failure"));
    await settle();
    backToForeground(); // 同毫秒同 cwd → 仍受 A2 成功窗节流
    await settle();
    expect(resumeCalls(), "A1 延迟失败不得误清 A2 成功窗口").toHaveLength(3);
  });
});
