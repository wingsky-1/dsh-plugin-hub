/** 调用方取消透传（ToolRunContext.signal）：caller abort 即停、超时仍生效、无 signal 旧行为不变。
 *
 * 守的是 execute→depsFor→DecideDeps.signal→callWithRetry 融合链：
 * caller abort（模型 socket 关闭即宿主 abort 该 signal）必须取消外调且不重试；
 * 内部总预算超时仍按旧重试链生效；无 signal 时与旧语义逐字一致。
 * fetch 全注入 mock，全程离线；落盘仅 execute 端到端用 mkdtempSync。
 */
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply } from "../../src/index.ts";
import type { DecideDeps, FetchImpl } from "../../src/server/tools/deps.ts";
import { callWithRetry, combineSignals } from "../../src/server/tools/impl/client.ts";
import { toWireQuestions } from "../../src/server/tools/impl/client.ts";
import type { DecisionRequestBody } from "../../src/server/tools/impl/client.ts";
import { signalOf } from "../../src/server/tools/impl/define.ts";
import { decide } from "../../src/server/tools/impl/service.ts";

const CONNECTION = {
  timeoutMs: 8000,
  maxConcurrency: 4,
  truncBudget: 32000,
  hasPlaintextKey: false,
} as const;

function baseDeps(over: Partial<DecideDeps> = {}): DecideDeps {
  return {
    logger: { warn: () => {} },
    connection: { ...CONNECTION },
    isEnabled: () => true,
    capOf: () => 2,
    resolveKey: () => ({ key: "Abcdefgh12345678", source: "env" as const }),
    root: "/tmp/proj",
    sessionId: "sess-1",
    ...over,
  };
}

function decideArgs(): unknown {
  return {
    preset_id: "general",
    state: { text: "hello", lang: "en" },
    questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
  };
}

function sdkChoice(id: string, choice: string, confidence: number): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      [id]: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function wireBody(): DecisionRequestBody {
  return {
    model: "jev-latest",
    state: "t",
    questions: toWireQuestions([{ id: "q", text: "Q?", kind: "choice", options: ["A", "B"] }]),
  };
}

interface Seen {
  count: number;
  lastSignal?: AbortSignal;
}

function abortError(): unknown {
  return new DOMException("This operation was aborted", "AbortError");
}

/** 成功 fetch（记录所见 signal）。 */
function successFetch(seen: Seen): FetchImpl {
  return async (_url, init) => {
    seen.count += 1;
    seen.lastSignal = init.signal;
    return { status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) };
  };
}

/** 永挂 fetch（只在 signal abort 时拒绝；供超时语义探针）。 */
function hangingFetch(seen: Seen): FetchImpl {
  return (_url, init) => {
    seen.count += 1;
    seen.lastSignal = init.signal;
    return new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
}

describe("signalOf 未知防御收窄", () => {
  it("非信号一律 undefined；真信号原样回传", () => {
    expect(signalOf(undefined)).toBeUndefined();
    expect(signalOf(null)).toBeUndefined();
    expect(signalOf({})).toBeUndefined();
    expect(signalOf({ signal: "x" })).toBeUndefined();
    expect(signalOf({ signal: { aborted: "yes" } })).toBeUndefined();
    const sig = new AbortController().signal;
    expect(signalOf({ signal: sig })).toBe(sig);
    expect(signalOf({ sessionId: "s-1" })).toBeUndefined();
  });
});

describe("combineSignals 融合", () => {
  it("调用方缺席即回内部信号原样（旧行为）", () => {
    const inner = new AbortController().signal;
    expect(combineSignals(undefined, inner)).toBe(inner);
  });
  it("已取消侧短路回传", () => {
    const caller = new AbortController();
    caller.abort();
    const inner = new AbortController().signal;
    expect(combineSignals(caller.signal, inner)).toBe(caller.signal);
    const callerLive = new AbortController().signal;
    const innerDead = new AbortController();
    innerDead.abort();
    expect(combineSignals(callerLive, innerDead.signal)).toBe(innerDead.signal);
  });
  it("双活时任一 abort 即联动", () => {
    const caller = new AbortController();
    const inner = new AbortController();
    const fused = combineSignals(caller.signal, inner.signal);
    expect(fused.aborted).toBe(false);
    caller.abort();
    expect(fused.aborted).toBe(true);
  });
  it("双活时内部超时 abort 即联动", () => {
    const caller = new AbortController();
    const inner = new AbortController();
    const fused = combineSignals(caller.signal, inner.signal);
    inner.abort();
    expect(fused.aborted).toBe(true);
  });
});

describe("caller abort 取消外调", () => {
  it("预取消：零外调即 ABORTED", async () => {
    const seen: Seen = { count: 0 };
    const caller = new AbortController();
    caller.abort();
    const out = await decide(
      decideArgs(),
      baseDeps({ fetchImpl: successFetch(seen), signal: caller.signal }),
    );
    expect(seen.count).toBe(0);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.errorCode).toBe("ABORTED");
      expect(out.error.category).toBe("aborted");
    }
  });
  it("飞行中取消（socket 关闭同形）：外调见 abort 且不重试", async () => {
    const seen: Seen = { count: 0 };
    const caller = new AbortController();
    const racing: FetchImpl = async (_url, init) => {
      seen.count += 1;
      seen.lastSignal = init.signal;
      queueMicrotask(() => caller.abort());
      await new Promise<void>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      throw new Error("unreachable");
    };
    const out = await decide(decideArgs(), baseDeps({ fetchImpl: racing, signal: caller.signal }));
    expect(seen.count).toBe(1);
    expect(seen.lastSignal?.aborted).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.errorCode).toBe("ABORTED");
      expect(out.error.category).toBe("aborted");
    }
  });
  it("callWithRetry 直调：预取消不触 fetch", async () => {
    const caller = new AbortController();
    caller.abort();
    let calls = 0;
    const r = await callWithRetry(
      wireBody(),
      "k",
      1000,
      async () => {
        calls += 1;
        return { status: 200, text: "{}" };
      },
      caller.signal,
    );
    expect(calls).toBe(0);
    expect(r.retries).toBe(0);
    expect(r.failure?.code).toBe("ABORTED");
    expect(r.failure?.retryable).toBe(false);
  });
});

describe("超时仍生效（含 signal 在场）", () => {
  it("永挂上游 + 短总预算 + 活信号：TIMEOUT（总预算耗尽后重试即时失败，单次外调）", async () => {
    const seen: Seen = { count: 0 };
    const caller = new AbortController();
    const out = await decide(
      decideArgs(),
      baseDeps({
        connection: { ...CONNECTION, timeoutMs: 60 },
        fetchImpl: hangingFetch(seen),
        signal: caller.signal,
      }),
    );
    expect(seen.count).toBe(1);
    expect(seen.lastSignal?.aborted).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.errorCode).toBe("TIMEOUT");
      expect(out.error.category).toBe("timeout");
    }
    expect(caller.signal.aborted).toBe(false);
  });
  it("可重试失败 + 活信号：重试链完整（500 后成功记 1）", async () => {
    let n = 0;
    const caller = new AbortController();
    const flaky: FetchImpl = async (_url, init) => {
      n += 1;
      if (init.signal.aborted) throw abortError();
      if (n === 1) return { status: 500, text: "err" };
      return { status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) };
    };
    const out = await decide(decideArgs(), baseDeps({ fetchImpl: flaky, signal: caller.signal }));
    expect(n).toBe(2);
    expect(out).toMatchObject({ ok: true, retries: 1 });
  });
});

describe("无 signal 旧行为不变", () => {
  it("永挂上游 + 短总预算：TIMEOUT（总预算语义与 signal 在场一致）", async () => {
    const seen: Seen = { count: 0 };
    const out = await decide(
      decideArgs(),
      baseDeps({ connection: { ...CONNECTION, timeoutMs: 60 }, fetchImpl: hangingFetch(seen) }),
    );
    expect(seen.count).toBe(1);
    expect(seen.lastSignal?.aborted).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.errorCode).toBe("TIMEOUT");
      expect(out.error.category).toBe("timeout");
    }
  });
  it("成功路径：单次调用即 high/auto", async () => {
    const seen: Seen = { count: 0 };
    const out = await decide(decideArgs(), baseDeps({ fetchImpl: successFetch(seen) }));
    expect(seen.count).toBe(1);
    expect(out).toMatchObject({ ok: true, tier: "high", automation: "auto" });
    if (out.ok) expect(out.retries).toBe(0);
  });
  it("活信号成功路径与无信号一致", async () => {
    const seen: Seen = { count: 0 };
    const caller = new AbortController();
    const out = await decide(
      decideArgs(),
      baseDeps({ fetchImpl: successFetch(seen), signal: caller.signal }),
    );
    expect(seen.count).toBe(1);
    expect(seen.lastSignal?.aborted).toBe(false);
    expect(out).toMatchObject({ ok: true, tier: "high", automation: "auto" });
  });
});

describe("execute 路径透传（经真实组合根）", () => {
  interface CapturedRoute {
    readonly path: string;
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  }
  interface CapturedTool {
    readonly name: string;
    readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
  }
  function setup(seen: Seen): {
    readonly tools: Map<string, CapturedTool>;
    readonly putKey: () => Promise<number>;
  } {
    const routes = new Map<string, CapturedRoute>();
    const tools = new Map<string, CapturedTool>();
    const ctx = {
      logger: { warn: () => {} },
      webServer: {
        register: (route: CapturedRoute) => {
          routes.set(route.path, route);
          return () => {
            routes.delete(route.path);
          };
        },
      },
      tools: {
        register: (tool: CapturedTool) => {
          tools.set(tool.name, tool);
          return () => {
            tools.delete(tool.name);
          };
        },
      },
      effect: (fn: () => () => void) => fn(),
    };
    apply(ctx as never, {
      home: mkdtempSync(join(tmpdir(), "jev-signal-")),
      fetchImpl: successFetch(seen),
    });
    // 密钥经 PUT 路由写入后方能进入远端分支：等回执确认写盘完成。
    const putKey = (): Promise<number> => {
      const route = routes.get("/api/dsh-decision-gateway/config");
      if (route === undefined) throw new Error("config route missing");
      const listeners = new Map<string, ((...a: never[]) => void)[]>();
      const body = JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456" });
      const req = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1" },
        method: "PUT",
        url: "/api/dsh-decision-gateway/config",
        on: (event: string, cb: (...a: never[]) => void) => {
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
          if (event === "data") queueMicrotask(() => cb(Buffer.from(body, "utf8") as never));
          if (event === "end") queueMicrotask(() => cb());
          return req;
        },
      };
      return new Promise<number>((resolve) => {
        let status = 0;
        const res = {
          headersSent: false,
          writeHead: (code: number) => {
            status = code;
            (res as { headersSent: boolean }).headersSent = true;
          },
          end: () => {
            (res as { headersSent: boolean }).headersSent = true;
            resolve(status);
          },
        };
        route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      });
    };
    return { tools, putKey };
  }
  it("exec.signal 预取消：execute 即 ABORTED 且零外调", async () => {
    const seen: Seen = { count: 0 };
    const { tools, putKey } = setup(seen);
    expect(await putKey()).toBe(200);
    const tool = tools.get("ws_request_verdict");
    expect(tool).toBeDefined();
    const caller = new AbortController();
    caller.abort();
    const out = (await tool?.execute(decideArgs(), {
      sessionId: "s-1",
      signal: caller.signal,
    })) as { readonly ok: boolean; readonly error?: { readonly errorCode: string } };
    expect(out.ok).toBe(false);
    expect(out.error?.errorCode).toBe("ABORTED");
    expect(seen.count).toBe(0);
  });
  it("exec 无 signal：旧行为成功", async () => {
    const seen: Seen = { count: 0 };
    const { tools, putKey } = setup(seen);
    expect(await putKey()).toBe(200);
    const tool = tools.get("ws_request_verdict");
    const out = (await tool?.execute(decideArgs(), { sessionId: "s-1" })) as {
      readonly ok: boolean;
    };
    expect(out.ok).toBe(true);
    expect(seen.count).toBe(1);
  });
});
