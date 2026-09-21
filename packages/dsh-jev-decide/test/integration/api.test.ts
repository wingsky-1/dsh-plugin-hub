/** api 集成单测：经真实组合根 apply（fake ctx）装配路由与工具，全程离线（fetch mock，落盘 mkdtemp）。 */
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply } from "../../src/index.ts";

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
    expect((await put({ apiKeyPlaintext: "Abcdefgh12345678" })).status).toBe(400);
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
        resultKind: "choice",
        choice: "A",
        confidence: 0.8,
        tier: 2,
        automation: 2,
        codepoints: 9,
      }),
    }));
    const keyPut = await call(routes, "/api/dsh-jev-decide/config", {
      method: "PUT",
      body: JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456", confirm: true }),
    });
    expect(keyPut.status).toBe(200);
    const decide = tools.get("ws_jev_decide");
    expect(decide).toBeDefined();
    const out = (await decide?.execute(
      { preset_id: "general", state: { text: "it-case", lang: "en" } },
      { sessionId: "it-s1", cwd: "/work/it" },
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const list = tools.get("ws_jev_list_presets");
    const presets = (await list?.execute({}, {})) as { id: string }[];
    expect(presets).toHaveLength(5);
    const got = await call(routes, "/api/dsh-jev-decide/history", {
      url: "/api/dsh-jev-decide/history?root=/work/it&sessionId=it-s1",
    });
    expect((got.json as { entries: unknown[] }).entries).toHaveLength(1);
    const del = await call(routes, "/api/dsh-jev-decide/history", {
      method: "DELETE",
      url: "/api/dsh-jev-decide/history?root=/work/it&sessionId=it-s1",
    });
    expect(del.json).toMatchObject({ ok: true, deleted: true });
  });
  it("test-connection 空体：无 key 401，有 key+mock 200", async () => {
    const { routes } = setup(async () => ({
      status: 200,
      text: JSON.stringify({ resultKind: "choice", choice: "A" }),
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
