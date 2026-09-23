/** api 集成单测：经真实组合根 apply（fake ctx）装配路由与工具，全程离线（fetch mock，落盘 mkdtemp）。 */
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply, inject } from "../../src/index.ts";

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
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

function setup(
  fetchImpl?: (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
      readonly signal: AbortSignal;
    },
  ) => Promise<{ readonly status: number; readonly text: string }>,
  sessions?: {
    readonly get: (id: string) => { readonly header: { readonly cwd?: string } } | undefined;
  },
  sessionTitle?: {
    readonly get: (session: unknown) => { readonly title: string } | undefined;
  },
): { readonly routes: Map<string, CapturedRoute>; readonly tools: Map<string, CapturedTool> } {
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
    ...(sessions !== undefined ? { sessions } : {}),
    ...(sessionTitle !== undefined ? { sessionTitle } : {}),
  };
  apply(ctx as never, {
    home: mkdtempSync(join(tmpdir(), "jev-api-")),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
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
    readonly address?: string;
    readonly host?: string;
    readonly method?: string;
    readonly url?: string;
    readonly body?: string;
  } = {},
): Promise<{
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly json: unknown;
}> {
  const route = routes.get(path);
  expect(route).toBeDefined();
  const { res, out } = fakeRes();
  route?.handler(
    fakeReq({
      address: opts.address ?? "127.0.0.1",
      host: opts.host ?? "127.0.0.1",
      method: opts.method ?? "GET",
      url: opts.url ?? path,
      body: opts.body,
    }),
    res,
  );
  await waitForResponse(out, "response finished");
  return {
    status: out.status,
    headers: out.headers,
    json: out.body.length > 0 ? (JSON.parse(out.body) as unknown) : null,
  };
}

describe("围栏", () => {
  it("403 先于 405：非回环+错方法仍 403", async () => {
    const { routes } = setup();
    const r = await call(routes, "/api/dsh-jev-decide/presets", {
      address: "10.0.0.2",
      host: "10.0.0.2",
      method: "PUT",
    });
    expect(r.status).toBe(403);
  });
  it("回环错方法 405 且带 Allow", async () => {
    const { routes } = setup();
    const r = await call(routes, "/api/dsh-jev-decide/presets", { method: "PUT" });
    expect(r.status).toBe(405);
    expect(String(r.headers["allow"] ?? "")).toContain("GET");
  });
  it("Host 非回环即 403", async () => {
    const { routes } = setup();
    const r = await call(routes, "/api/dsh-jev-decide/health", { host: "evil.example" });
    expect(r.status).toBe(403);
  });
});

describe("工作目录解析", () => {
  it("inject 声明 sessions（缺声明宿主直访即抛，目录维度静默全失）", () => {
    expect(inject).toContain("sessions");
  });
  it("inject 声明 sessionTitle（缺声明标题 enrich 无源，回落短 id）", () => {
    expect(inject).toContain("sessionTitle");
  });
  it("sessions store 优先于 exec cwd；抛错回落 exec cwd", async () => {
    const fetchOk = async (): Promise<{ readonly status: number; readonly text: string }> => ({
      status: 200,
      text: JSON.stringify(SDK_OK("q1", "A", 0.9)),
    });
    const store = {
      get: (id: string) => (id === "s-work" ? { header: { cwd: "/work/from-store" } } : undefined),
    };
    const env = setup(fetchOk, store);
    expect(
      (
        await call(env.routes, "/api/dsh-jev-decide/config", {
          method: "PUT",
          body: JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456" }),
        })
      ).status,
    ).toBe(200);
    const decide = env.tools.get("ws_request_verdict");
    const out = (await decide?.execute(
      {
        preset_id: "general",
        state: { text: "cwd case", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      { sessionId: "s-work", cwd: "/work/exec-cwd" },
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const got = await call(env.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/from-store&sessionId=s-work",
    });
    expect((got.json as { entries: unknown[] }).entries).toHaveLength(1);
    const throwing = setup(fetchOk, {
      get: () => {
        throw new Error("store down");
      },
    });
    expect(
      (
        await call(throwing.routes, "/api/dsh-jev-decide/config", {
          method: "PUT",
          body: JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456" }),
        })
      ).status,
    ).toBe(200);
    const decide2 = throwing.tools.get("ws_request_verdict");
    const out2 = (await decide2?.execute(
      {
        preset_id: "general",
        state: { text: "cwd case", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      { sessionId: "s-work", cwd: "/work/exec-cwd" },
    )) as { ok: boolean };
    expect(out2.ok).toBe(true);
    const got2 = await call(throwing.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/exec-cwd&sessionId=s-work",
    });
    expect((got2.json as { entries: unknown[] }).entries).toHaveLength(1);
  });
});

describe("会话标题 enrich", () => {
  const fetchOk = async (): Promise<{ readonly status: number; readonly text: string }> => ({
    status: 200,
    text: JSON.stringify(SDK_OK("q1", "A", 0.9)),
  });
  const putKey = async (routes: Map<string, CapturedRoute>): Promise<void> => {
    expect(
      (
        await call(routes, "/api/dsh-jev-decide/config", {
          method: "PUT",
          body: JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456" }),
        })
      ).status,
    ).toBe(200);
  };
  const decideOnce = async (
    tools: Map<string, CapturedTool>,
    sessionId: string,
    cwd: string,
  ): Promise<void> => {
    const decide = tools.get("ws_request_verdict");
    const out = (await decide?.execute(
      {
        preset_id: "general",
        state: { text: "title case", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      { sessionId, cwd },
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
  };
  it("有标题：readHistory enrich sessionTitle，落盘无该字段", async () => {
    const sessions = {
      get: (id: string) => (id === "s-title" ? { header: { cwd: "/work/title" } } : undefined),
    };
    const sessionTitle = {
      get: (session: unknown) =>
        session !== undefined && session !== null ? { title: "标题T" } : undefined,
    };
    const env = setup(fetchOk, sessions, sessionTitle);
    await putKey(env.routes);
    await decideOnce(env.tools, "s-title", "/work/exec-title");
    const got = await call(env.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/title&sessionId=s-title",
    });
    const entries = (got.json as { entries: Array<{ sessionTitle?: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionTitle).toBe("标题T");
  });
  it("服务缺席/抛错：回落短 id，状态 200 不 500", async () => {
    const sessions = {
      get: (id: string) => (id === "s-notitle" ? { header: { cwd: "/work/notitle" } } : undefined),
    };
    const env = setup(fetchOk, sessions);
    await putKey(env.routes);
    await decideOnce(env.tools, "s-notitle", "/work/notitle");
    const got = await call(env.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/notitle&sessionId=s-notitle",
    });
    const entries = (got.json as { entries: Array<{ sessionTitle?: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionTitle).toBeUndefined();
    const throwing = setup(fetchOk, sessions, {
      get: () => {
        throw new Error("title down");
      },
    });
    await putKey(throwing.routes);
    await decideOnce(throwing.tools, "s-notitle", "/work/notitle");
    const got2 = await call(throwing.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/notitle&sessionId=s-notitle",
    });
    expect(got2.status).toBe(200);
    expect((got2.json as { entries: unknown[] }).entries).toHaveLength(1);
  });
  it("无标题/已死会话：get undefined 即回落短 id", async () => {
    const sessions = {
      get: (id: string) => (id === "s-live" ? { header: { cwd: "/work/live" } } : undefined),
    };
    const sessionTitle = {
      get: () => undefined,
    };
    const env = setup(fetchOk, sessions, sessionTitle);
    await putKey(env.routes);
    await decideOnce(env.tools, "s-live", "/work/live");
    const got = await call(env.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/live&sessionId=s-live",
    });
    expect(
      (got.json as { entries: Array<{ sessionTitle?: string }> }).entries[0]?.sessionTitle,
    ).toBeUndefined();
    const dead = await call(env.routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/live&sessionId=s-dead",
    });
    expect((dead.json as { entries: unknown[] }).entries).toHaveLength(0);
  });
});

describe("端点往返", () => {
  it("health/config/presets", async () => {
    const { routes } = setup();
    const health = await call(routes, "/api/dsh-jev-decide/health");
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, templateVersion: 1 });
    const config = await call(routes, "/api/dsh-jev-decide/config");
    expect(config.status).toBe(200);
    expect(config.json).toMatchObject({ version: 1 });
    const presets = await call(routes, "/api/dsh-jev-decide/presets");
    expect(presets.status).toBe(200);
    const list = (presets.json as { presets: { id: string; enabled: boolean }[] }).presets;
    expect(list).toHaveLength(5);
    expect(list.find((p) => p.id === "secret-leak")?.enabled).toBe(false);
  });
  it("PUT config 校验面", async () => {
    const { routes } = setup();
    const put = (body: unknown) =>
      call(routes, "/api/dsh-jev-decide/config", { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ baseUrl: "https://x" })).status).toBe(400);
    expect((await put({ apiKeyRef: "lower" })).status).toBe(400);
    expect((await put({ apiKeyPlaintext: "Abcdefgh12345678" })).status).toBe(200);
    expect(
      (await put({ apiKeyRef: "JEV_IT_KEY", apiKeyPlaintext: "Abcdefgh12345678", confirm: true }))
        .status,
    ).toBe(400);
    const ok = await put({ apiKeyRef: "JEV_IT_KEY" });
    expect(ok.status).toBe(200);
    const back = await call(routes, "/api/dsh-jev-decide/config");
    expect(back.json).toMatchObject({
      connection: { apiKeyRef: "JEV_IT_KEY", hasPlaintextKey: false },
    });
    const secret = await put({ apiKeyPlaintext: "Abcdefgh12345678", confirm: true });
    expect(secret.status).toBe(400);
  });
  it("切轨一次写透：明文+apiKeyRef:null→200 且掩码去引用", async () => {
    const { routes } = setup();
    const put = (body: unknown) =>
      call(routes, "/api/dsh-jev-decide/config", { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ apiKeyRef: "JEV_IT_TRACK" })).status).toBe(200);
    const switched = await put({ apiKeyPlaintext: "Abcdefgh12345678", apiKeyRef: null });
    expect(switched.status).toBe(200);
    expect(switched.json).toMatchObject({
      connection: { hasPlaintextKey: true },
    });
    expect(JSON.stringify(switched.json)).not.toContain("JEV_IT_TRACK");
    expect(JSON.stringify(switched.json)).not.toContain("Abcdefgh12345678");
  });
  it("明文确认后掩码回显", async () => {
    const { routes } = setup();
    const r = await call(routes, "/api/dsh-jev-decide/config", {
      method: "PUT",
      body: JSON.stringify({ apiKeyPlaintext: "Zbcdefgh12345678", confirm: true }),
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("Zbcdefgh12345678");
    expect(r.json).toMatchObject({ connection: { hasPlaintextKey: true } });
  });
  it("history 空查与单会话删除守卫", async () => {
    const { routes } = setup();
    const empty = await call(routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work&sessionId=s1",
    });
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ ok: true, entries: [] });
    const bad = await call(routes, "/api/dsh-jev-decide/history", {
      method: "DELETE",
      url: "/api/dsh-jev-decide/history?root=/work",
    });
    expect(bad.status).toBe(400);
  });
  it("工具决议落史可查可删", async () => {
    const { routes, tools } = setup(async () => ({
      status: 200,
      text: JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          q1: { type: "choice", choice: "A", confidence: 0.8, probabilities: { A: 0.8, B: 0.2 } },
        },
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    }));
    const keyPut = await call(routes, "/api/dsh-jev-decide/config", {
      method: "PUT",
      body: JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456", confirm: true }),
    });
    expect(keyPut.status).toBe(200);
    const decide = tools.get("ws_request_verdict");
    expect(decide).toBeDefined();
    const out = (await decide?.execute(
      {
        preset_id: "general",
        state: { text: "it-case", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      { sessionId: "it-s1", cwd: "/work/it" },
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const list = tools.get("ws_list_verdict_guides");
    const presets = (await list?.execute({}, {})) as { id: string }[];
    expect(presets).toHaveLength(5);
    const got = await call(routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/it&sessionId=it-s1",
    });
    expect((got.json as { entries: unknown[] }).entries).toHaveLength(1);
    const first = (
      got.json as {
        entries: Array<{
          presetTitle?: string;
          questions?: Array<{ id: string; options?: string[] }>;
        }>;
      }
    ).entries[0];
    expect(first?.presetTitle).toBe("general");
    expect(first?.questions?.[0]?.options).toEqual(["A", "B"]);
    const del = await call(routes, "/api/dsh-jev-decide/history", {
      method: "DELETE",
      url: "/api/dsh-jev-decide/history?root=/work/it&sessionId=it-s1",
    });
    expect(del.json).toMatchObject({ ok: true, deleted: true });
  });
  it("test-connection 空体：无 key 401，有 key+mock 200", async () => {
    const { routes } = setup(async () => ({
      status: 200,
      text: JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          probe: {
            type: "choice",
            choice: "ok",
            confidence: 0.9,
            probabilities: { ok: 0.9, fail: 0.1 },
          },
        },
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    }));
    const noKey = await call(routes, "/api/dsh-jev-decide/test-connection", {
      method: "POST",
      body: "{}",
    });
    expect(noKey.status).toBe(401);
    process.env.JEV_IT_PROBE = "ProbeSecretValue1234";
    try {
      const put = await call(routes, "/api/dsh-jev-decide/config", {
        method: "PUT",
        body: JSON.stringify({ apiKeyRef: "JEV_IT_PROBE" }),
      });
      expect(put.status).toBe(200);
      const ok = await call(routes, "/api/dsh-jev-decide/test-connection", {
        method: "POST",
        body: "{}",
      });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ ok: true });
    } finally {
      delete process.env.JEV_IT_PROBE;
    }
  });
});
