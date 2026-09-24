/** 调用方取消透传（ToolRunContext.signal）：caller abort 即停、超时仍生效。
 *
 * 守的是 execute→depsFor→DecideDeps.signal→callWithRetry 融合链：
 * caller abort（模型 socket 关闭即宿主 abort 该 signal）必须取消外调且不重试；
 * 内部总预算超时仍按既有重试链生效。
 * fetch 全注入 mock，全程离线；落盘仅 execute 端到端用 mkdtempSync。
 */
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { apply } from "../../src/index.ts";
import type { DecideDeps, FetchImpl } from "../../src/server/tools/deps.ts";
import { callWithRetry, combineSignals } from "../../src/server/tools/impl/client.ts";
import { toWireQuestions } from "../../src/server/tools/impl/client.ts";
import type { DecisionRequestBody } from "../../src/server/tools/impl/client.ts";
import { createSemaphore } from "../../src/server/tools/impl/semaphore.ts";
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
    signal: new AbortController().signal,
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

function secretShapedArgs(): unknown {
  return {
    preset_id: "general",
    state: { text: "key sk-Abcdef12345678 here", lang: "en" },
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 让 abort 的同步 reject 穿过 service 的 await/catch；不使用真实时间。 */
async function flushAbortSettlement(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

describe("semaphore 取消队列", () => {
  it("预取消不入队、不启动 task，并以 AbortError settle", async () => {
    const gate = createSemaphore(1);
    const caller = new AbortController();
    caller.abort();
    let taskCalls = 0;

    const result = gate.run(async () => {
      taskCalls += 1;
    }, caller.signal);

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(taskCalls).toBe(0);
  });

  it("max=1：第二项 abort 在首项释放前摘除，第三项仍按 FIFO 执行", async () => {
    const gate = createSemaphore(1);
    const releaseFirst = deferred<undefined>();
    const order: string[] = [];
    let secondCalls = 0;
    let thirdCalls = 0;

    const first = gate.run(async () => {
      order.push("first:start");
      await releaseFirst.promise;
      order.push("first:end");
    });
    const caller = new AbortController();
    const second = gate.run(async () => {
      secondCalls += 1;
      order.push("second");
    }, caller.signal);
    const third = gate.run(async () => {
      thirdCalls += 1;
      order.push("third");
    });
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    caller.abort();
    await flushAbortSettlement();
    const settledBeforeRelease = secondSettled;
    releaseFirst.resolve(undefined);
    const [firstOutcome, secondOutcome, thirdOutcome] = await Promise.allSettled([
      first,
      second,
      third,
    ]);

    expect(settledBeforeRelease).toBe(true);
    expect(firstOutcome?.status).toBe("fulfilled");
    expect(secondOutcome?.status).toBe("rejected");
    if (secondOutcome?.status === "rejected") {
      expect(secondOutcome.reason).toMatchObject({ name: "AbortError" });
    }
    expect(thirdOutcome?.status).toBe("fulfilled");
    expect(secondCalls).toBe(0);
    expect(thirdCalls).toBe(1);
    expect(order).toEqual(["first:start", "first:end", "third"]);
  });

  it("max<=0 仍按 1 串行", async () => {
    const gate = createSemaphore(0);
    const releaseFirst = deferred<undefined>();
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push("first:start");
      await releaseFirst.promise;
      order.push("first:end");
    });
    let secondStarted = false;
    const second = gate.run(async () => {
      secondStarted = true;
      order.push("second");
    });

    expect(secondStarted).toBe(false);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
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
  it("密形文本预取消：在 precheck/key/history 前短路为 ABORTED", async () => {
    const caller = new AbortController();
    caller.abort();
    let fetchCalls = 0;
    let resolveKeyCalls = 0;
    let historyCalls = 0;

    const out = await decide(
      secretShapedArgs(),
      baseDeps({
        signal: caller.signal,
        fetchImpl: async () => {
          fetchCalls += 1;
          return { status: 200, text: "{}" };
        },
        resolveKey: () => {
          resolveKeyCalls += 1;
          return { key: "Abcdefgh12345678", source: "env" as const };
        },
        recordEvent: () => {
          historyCalls += 1;
        },
      }),
    );

    expect(out).toEqual({
      ok: false,
      error: { errorCode: "ABORTED", category: "aborted", message: "caller aborted" },
    });
    expect(fetchCalls).toBe(0);
    expect(resolveKeyCalls).toBe(0);
    expect(historyCalls).toBe(0);
  });
  it("disabled + 预取消仍优先返回 PRESET_DISABLED", async () => {
    const caller = new AbortController();
    caller.abort();
    let resolveKeyCalls = 0;
    let historyCalls = 0;
    const out = await decide(
      secretShapedArgs(),
      baseDeps({
        signal: caller.signal,
        isEnabled: () => false,
        resolveKey: () => {
          resolveKeyCalls += 1;
          return { key: "Abcdefgh12345678", source: "env" as const };
        },
        recordEvent: () => {
          historyCalls += 1;
        },
      }),
    );

    expect(out).toEqual({
      ok: false,
      error: {
        errorCode: "PRESET_DISABLED",
        category: "preset-disabled",
        message: "preset disabled",
      },
    });
    expect(resolveKeyCalls).toBe(0);
    expect(historyCalls).toBe(0);
  });
  it("飞行中取消（socket 关闭同形）：外调见 abort、不重试且保留 history", async () => {
    const seen: Seen = { count: 0 };
    const events: { readonly resultKind: string; readonly errorCode?: string }[] = [];
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
    const out = await decide(
      decideArgs(),
      baseDeps({
        fetchImpl: racing,
        signal: caller.signal,
        recordEvent: (event) => {
          events.push({ resultKind: event.resultKind, errorCode: event.errorCode });
        },
      }),
    );
    expect(seen.count).toBe(1);
    expect(seen.lastSignal?.aborted).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.errorCode).toBe("ABORTED");
      expect(out.error.category).toBe("aborted");
    }
    expect(events).toEqual([{ resultKind: "upstream-error", errorCode: "ABORTED" }]);
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

describe("service 排队取消", () => {
  it("abort 在首项释放前返回 ABORTED，且第二项零 history", async () => {
    const gate = createSemaphore(1);
    const firstEntered = deferred<undefined>();
    const releaseFirst = deferred<{ readonly status: number; readonly text: string }>();
    const historySessions: string[] = [];
    let fetchCalls = 0;
    let resolveKeyCalls = 0;
    const resolveKey = (): { readonly key: string; readonly source: "env" } => {
      resolveKeyCalls += 1;
      return { key: "Abcdefgh12345678", source: "env" };
    };
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstEntered.resolve(undefined);
        return releaseFirst.promise;
      }
      return { status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) };
    };
    const recordEvent = (event: { readonly sessionId: string }): void => {
      historySessions.push(event.sessionId);
    };

    const first = decide(
      decideArgs(),
      baseDeps({ sessionId: "first", limit: gate.run, fetchImpl, recordEvent, resolveKey }),
    );
    await firstEntered.promise;
    const caller = new AbortController();
    let secondSettled = false;
    const second = decide(
      decideArgs(),
      baseDeps({
        sessionId: "second",
        limit: gate.run,
        fetchImpl,
        recordEvent,
        resolveKey,
        signal: caller.signal,
      }),
    ).then(
      (out) => {
        secondSettled = true;
        return out;
      },
      (cause: unknown) => {
        secondSettled = true;
        throw cause;
      },
    );

    caller.abort();
    await flushAbortSettlement();
    const settledBeforeRelease = secondSettled;
    releaseFirst.resolve({ status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) });
    const [firstOut, secondOut] = await Promise.all([first, second]);

    expect(settledBeforeRelease).toBe(true);
    expect(firstOut.ok).toBe(true);
    expect(secondOut).toEqual({
      ok: false,
      error: { errorCode: "ABORTED", category: "aborted", message: "caller aborted" },
    });
    expect(fetchCalls).toBe(1);
    expect(resolveKeyCalls).toBe(1);
    expect(historySessions).toEqual(["first"]);
  });

  it("密形排队项 abort：未启动 task 前不走 local-precheck", async () => {
    const gate = createSemaphore(1);
    const firstEntered = deferred<undefined>();
    const releaseFirst = deferred<{ readonly status: number; readonly text: string }>();
    const historySessions: string[] = [];
    let fetchCalls = 0;
    let resolveKeyCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstEntered.resolve(undefined);
        return releaseFirst.promise;
      }
      return { status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) };
    };
    const first = decide(
      decideArgs(),
      baseDeps({
        sessionId: "first",
        limit: gate.run,
        fetchImpl,
        recordEvent: (event) => {
          historySessions.push(event.sessionId);
        },
      }),
    );
    await firstEntered.promise;
    const caller = new AbortController();
    const second = decide(
      secretShapedArgs(),
      baseDeps({
        sessionId: "second",
        limit: gate.run,
        fetchImpl,
        recordEvent: (event) => {
          historySessions.push(event.sessionId);
        },
        resolveKey: () => {
          resolveKeyCalls += 1;
          return { key: "Abcdefgh12345678", source: "env" as const };
        },
        signal: caller.signal,
      }),
    );

    caller.abort();
    await flushAbortSettlement();
    releaseFirst.resolve({ status: 200, text: JSON.stringify(sdkChoice("q1", "A", 0.9)) });
    const [firstOut, secondOut] = await Promise.all([first, second]);

    expect(firstOut.ok).toBe(true);
    expect(secondOut).toEqual({
      ok: false,
      error: { errorCode: "ABORTED", category: "aborted", message: "caller aborted" },
    });
    expect(fetchCalls).toBe(1);
    expect(resolveKeyCalls).toBe(0);
    expect(historySessions).toEqual(["first"]);
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

describe("limit 缺席", () => {
  it("仍直行且把活跃 signal 传给 client", async () => {
    const seen: Seen = { count: 0 };
    const caller = new AbortController();
    const out = await decide(
      decideArgs(),
      baseDeps({ fetchImpl: successFetch(seen), signal: caller.signal }),
    );
    expect(seen.count).toBe(1);
    expect(seen.lastSignal?.aborted).toBe(false);
    expect(out).toMatchObject({ ok: true, tier: "high", automation: "auto" });
    if (out.ok) expect(out.retries).toBe(0);
  });
});

describe("execute 路径透传（经真实组合根）", () => {
  interface CapturedRoute {
    readonly path: string;
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  }
  interface CapturedTool {
    readonly name: string;
    readonly execute: (
      args: unknown,
      exec: Pick<ToolRunContext, "signal"> & Record<string, unknown>,
    ) => Promise<unknown>;
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
});
