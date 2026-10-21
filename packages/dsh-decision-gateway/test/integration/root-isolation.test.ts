/**
 * history 按工作目录（root）隔离的集成判据：经真实组合根 apply（fake ctx）装配路由与工具，
 * 全程离线（fetch mock，落盘 mkdtemp 隔离）。
 *
 * 三条断言锁定「不同 root 各落各目录、互不可见」：
 *   A→B 各落各目录；显式 root=A 只返 A；空 root 全量但不越界（不含未落史的 root）。
 */
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { apply } from "../../src/index.ts";

const SDK_OK = (id: string, choice: string, confidence: number): unknown => ({
  model: "jev-1.13.0",
  answers: {
    [id]: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
  },
  usage: { input_tokens: 9, output_tokens: 3 },
});

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

interface HistoryEntry {
  readonly rootHash: string;
  readonly rootDisplay: string;
  readonly sessionId: string;
  readonly snippetRedacted: string;
}

/** 组合根装配（与 api.test.ts 同源）：home 走 mkdtemp，fetch 注入离线应答。 */
function setup(): {
  readonly routes: Map<string, CapturedRoute>;
  readonly tools: Map<string, CapturedTool>;
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
    home: mkdtempSync(join(tmpdir(), "jev-root-isolation-")),
    fetchImpl: async () => ({ status: 200, text: JSON.stringify(SDK_OK("q1", "A", 0.9)) }),
  });
  return { routes, tools };
}

function fakeReq(opts: {
  readonly address: string;
  readonly host: string;
  readonly method: string;
  readonly url: string;
  readonly body?: string;
}): IncomingMessage {
  const listeners = new Map<string, ((...a: never[]) => void)[]>();
  const req = {
    socket: { remoteAddress: opts.address },
    headers: { host: opts.host },
    method: opts.method,
    url: opts.url,
    on: (event: string, cb: (...a: never[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      if (event === "data") queueMicrotask(() => cb(Buffer.from(opts.body ?? "", "utf8") as never));
      if (event === "end") queueMicrotask(() => cb());
      return req;
    },
  };
  return req as unknown as IncomingMessage;
}

function fakeRes(): {
  readonly res: ServerResponse;
  readonly out: { status: number; headers: Record<string, unknown>; body: string };
} {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const res = {
    headersSent: false,
    writeHead: (status: number, headers: Record<string, unknown>) => {
      out.status = status;
      out.headers = headers;
      (res as { headersSent: boolean }).headersSent = true;
    },
    end: (text?: unknown) => {
      out.body = typeof text === "string" ? text : "";
      (res as { headersSent: boolean }).headersSent = true;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

async function waitForResponse(out: { readonly status: number }, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (out.status !== 0) return;
    if (Date.now() > deadline) throw new Error("pollUntil: " + label + " timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function call(
  routes: Map<string, CapturedRoute>,
  path: string,
  opts: {
    readonly method?: string;
    readonly url?: string;
    readonly body?: string;
  } = {},
): Promise<{ readonly status: number; readonly json: unknown }> {
  const route = routes.get(path);
  expect(route).toBeDefined();
  const { res, out } = fakeRes();
  route?.handler(
    fakeReq({
      address: "127.0.0.1",
      host: "127.0.0.1",
      method: opts.method ?? "GET",
      url: opts.url ?? path,
      body: opts.body,
    }),
    res,
  );
  await waitForResponse(out, "response finished");
  return {
    status: out.status,
    json: out.body.length > 0 ? (JSON.parse(out.body) as unknown) : null,
  };
}

const ROUTES = {
  config: "/api/dsh-decision-gateway/config",
  history: "/api/dsh-decision-gateway/history",
} as const;

/** 注入明文密钥（服务端双轨：明文免二次确认）。 */
async function putKey(routes: Map<string, CapturedRoute>): Promise<void> {
  const r = await call(routes, ROUTES.config, {
    method: "PUT",
    body: JSON.stringify({ apiKeyPlaintext: "IsolationSecret123456" }),
  });
  expect(r.status).toBe(200);
}

/** 单次裁决（会落史），cwd 即该会话的 root。 */
async function decideOnce(
  tools: Map<string, CapturedTool>,
  sessionId: string,
  cwd: string,
  text: string,
): Promise<void> {
  const decide = tools.get("ws_request_verdict");
  expect(decide).toBeDefined();
  const out = (await decide?.execute(
    {
      preset_id: "general",
      state: { text, lang: "en" },
      questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
    },
    { sessionId, cwd, signal: new AbortController().signal },
  )) as { ok: boolean };
  expect(out.ok).toBe(true);
}

async function readHistory(
  routes: Map<string, CapturedRoute>,
  query: string,
): Promise<HistoryEntry[]> {
  const r = await call(routes, ROUTES.history, {
    url: ROUTES.history + (query.length > 0 ? "?" + query : ""),
  });
  expect(r.status).toBe(200);
  return (r.json as { entries: HistoryEntry[] }).entries;
}

const enc = encodeURIComponent;

describe("history 按 root 隔离", () => {
  it("A→B 各落各目录；显式 root=A 不返 B；空 root 全量不含未落史的 root", async () => {
    const env = setup();
    await putKey(env.routes);

    // 两个互不相同 basename 的工作目录（同 basename 走 display 形态会歧义，不在本判据范围内）。
    const rootA = mkdtempSync(join(tmpdir(), "jev-root-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "jev-root-b-"));
    const rootNever = mkdtempSync(join(tmpdir(), "jev-root-never-"));
    expect(rootA).not.toBe(rootB);

    // 1) A→B 各落各目录：A 跑两轮、B 跑一轮，各自 sessionId 独立。
    await decideOnce(env.tools, "s-a", rootA, "root A first");
    await decideOnce(env.tools, "s-a", rootA, "root A second");
    await decideOnce(env.tools, "s-b", rootB, "root B only");

    const byA = await readHistory(env.routes, "root=" + enc(rootA));
    const byB = await readHistory(env.routes, "root=" + enc(rootB));
    expect(byA.map((e) => e.sessionId)).toEqual(["s-a", "s-a"]);
    expect(byB.map((e) => e.sessionId)).toEqual(["s-b"]);
    expect(byA.every((e) => e.rootDisplay === readDisplay(rootA))).toBe(true);
    expect(byB.every((e) => e.rootDisplay === readDisplay(rootB))).toBe(true);

    // 2) 显式 root=A 只返 A：B 的会话 id 与内容都不越界（含按 sessionId 交叉查询）。
    expect(byA.some((e) => e.sessionId === "s-b")).toBe(false);
    expect(byA.some((e) => e.snippetRedacted.includes("root B"))).toBe(false);
    const aWithB = await readHistory(env.routes, "root=" + enc(rootA) + "&sessionId=s-b");
    expect(aWithB).toHaveLength(0);

    // 3) 空 root 全量：A、B 都在（3 条），但未落史的 root 一条不出现。
    const all = await readHistory(env.routes, "");
    expect(all).toHaveLength(3);
    expect(new Set(all.map((e) => e.sessionId))).toEqual(new Set(["s-a", "s-b"]));
    expect(all.some((e) => e.rootDisplay === readDisplay(rootNever))).toBe(false);
    const never = await readHistory(env.routes, "root=" + enc(rootNever));
    expect(never).toHaveLength(0);
  });
});

/** root 的 display（basename；与历史条目 rootDisplay 同口径）。 */
function readDisplay(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}
