/** 每路由 403/405 围栏 + 存量互斥 + 历史脱敏端到端（经真实组合根 apply，全离线）。
 *
 * 守的是 server/api/route.registerEndpoints 的 403 先于 405 顺序与各端点方法表：
 * 把某路由多加一个方法、围栏顺序调换、存量互斥删掉，本文件必红。
 * fetch 经注入，落盘走 mkdtempSync，真实网络零容忍。
 */
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply } from "../../src/index.ts";
import { ROUTES } from "../../src/shared/contract.ts";

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
    home: mkdtempSync(join(tmpdir(), "jev-fence-")),
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
  readonly extraHeaders?: Record<string, string>;
}): IncomingMessage {
  const listeners = new Map<string, ((...a: never[]) => void)[]>();
  const req = {
    socket: { remoteAddress: opts.address },
    headers: { host: opts.host, ...opts.extraHeaders },
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
    readonly extraHeaders?: Record<string, string>;
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
      extraHeaders: opts.extraHeaders,
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

describe("五路由注册与一致性", () => {
  it("宿主注册五路由且路径即共享 ROUTES 字面量", () => {
    const { routes } = setup();
    expect([...routes.keys()].sort()).toEqual(
      [ROUTES.health, ROUTES.config, ROUTES.presets, ROUTES.history, ROUTES.testConnection].sort(),
    );
    expect(ROUTES.health).toBe("/api/dsh-jev-decide/health");
    expect(ROUTES.config).toBe("/api/dsh-jev-decide/config");
    expect(ROUTES.presets).toBe("/api/dsh-jev-decide/presets");
    expect(ROUTES.history).toBe("/api/dsh-jev-decide/history");
    expect(ROUTES.testConnection).toBe("/api/dsh-jev-decide/test-connection");
  });
  it("工具双注册 ws_jev_decide/ws_jev_list_presets", () => {
    const { tools } = setup();
    expect(tools.has("ws_jev_decide")).toBe(true);
    expect(tools.has("ws_jev_list_presets")).toBe(true);
  });
});

describe("每路由 403 围栏", () => {
  it.each([ROUTES.health, ROUTES.config, ROUTES.presets, ROUTES.history, ROUTES.testConnection])(
    "非回环 %s 即 403",
    async (path) => {
      const { routes } = setup();
      const r = await call(routes, path, {
        address: "10.0.0.2",
        host: "10.0.0.2",
        method: "GET",
        url: path,
      });
      expect(r.status).toBe(403);
    },
  );
  it("403 先于 405：非回环+错方法仍 403", async () => {
    const { routes } = setup();
    const r = await call(routes, ROUTES.presets, {
      address: "10.0.0.2",
      host: "10.0.0.2",
      method: "PUT",
    });
    expect(r.status).toBe(403);
  });
  it("Host 非回环即 403；cross-site 即 403", async () => {
    const { routes } = setup();
    expect((await call(routes, ROUTES.health, { host: "evil.example" })).status).toBe(403);
    expect(
      (await call(routes, ROUTES.health, { extraHeaders: { "sec-fetch-site": "cross-site" } }))
        .status,
    ).toBe(403);
  });
});

describe("每路由 405 围栏", () => {
  it("health 仅 GET：POST 405 且 Allow 含 GET", async () => {
    const { routes } = setup();
    const r = await call(routes, ROUTES.health, { method: "POST" });
    expect(r.status).toBe(405);
    expect(String(r.headers["allow"] ?? "")).toContain("GET");
  });
  it("config 仅 GET+PUT：DELETE 405 且 Allow 含 GET,PUT", async () => {
    const { routes } = setup();
    const r = await call(routes, ROUTES.config, { method: "DELETE" });
    expect(r.status).toBe(405);
    const allow = String(r.headers["allow"] ?? "");
    expect(allow).toContain("GET");
    expect(allow).toContain("PUT");
  });
  it("presets 仅 GET：PUT 405", async () => {
    const { routes } = setup();
    const r = await call(routes, ROUTES.presets, { method: "PUT" });
    expect(r.status).toBe(405);
    expect(String(r.headers["allow"] ?? "")).toContain("GET");
  });
  it("history 仅 GET+DELETE：POST 405", async () => {
    const { routes } = setup();
    const r = await call(routes, ROUTES.history, { method: "POST" });
    expect(r.status).toBe(405);
    const allow = String(r.headers["allow"] ?? "");
    expect(allow).toContain("GET");
    expect(allow).toContain("DELETE");
  });
  it("test-connection 仅 POST：GET 405", async () => {
    const { routes } = setup();
    const r = await call(routes, ROUTES.testConnection, { method: "GET" });
    expect(r.status).toBe(405);
    expect(String(r.headers["allow"] ?? "")).toContain("POST");
  });
  it.each([
    [ROUTES.health, "GET"],
    [ROUTES.config, "GET"],
    [ROUTES.presets, "GET"],
    [ROUTES.history, "GET"],
    [ROUTES.testConnection, "POST"],
  ])("OPTIONS %s 即 405 且 Allow 含 %s（R2）", async (path, method) => {
    const { routes } = setup();
    const r = await call(routes, path, { method: "OPTIONS" });
    expect(r.status).toBe(405);
    expect(String(r.headers["allow"] ?? "")).toContain(method);
  });
});

describe("存量互斥与脱敏端到端", () => {
  it("PUT 明文与存量 ref 互斥 400（先 ref 后明文）", async () => {
    const { routes } = setup();
    const put = (body: unknown) =>
      call(routes, ROUTES.config, { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ apiKeyRef: "JEV_FENCE_KEY" })).status).toBe(200);
    const clash = await put({ apiKeyPlaintext: "Abcdefgh12345678", confirm: true });
    expect(clash.status).toBe(400);
    expect(JSON.stringify(clash.json)).toContain("MUTUALLY_EXCLUSIVE");
    // 清除引用后明文可写。
    expect((await put({ apiKeyRef: null })).status).toBe(200);
    expect((await put({ apiKeyPlaintext: "Zbcdefgh12345678", confirm: true })).status).toBe(200);
  });
  it("工具决议落史可查：snippet 无密钥原文", async () => {
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
    expect(
      (
        await call(routes, ROUTES.config, {
          method: "PUT",
          body: JSON.stringify({ apiKeyPlaintext: "ItcaseSecret123456", confirm: true }),
        })
      ).status,
    ).toBe(200);
    const decide = tools.get("ws_jev_decide");
    expect(decide).toBeDefined();
    const out = (await decide?.execute(
      {
        preset_id: "general",
        state: { text: "fence-case", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      { sessionId: "fence-s1", cwd: "/work/fence" },
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const got = await call(routes, ROUTES.history, {
      url: ROUTES.history + "?root=/work/fence&sessionId=fence-s1",
    });
    const entries = (got.json as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("ItcaseSecret123456");
    const del = await call(routes, ROUTES.history, {
      method: "DELETE",
      url: ROUTES.history + "?root=/work/fence&sessionId=fence-s1",
    });
    expect(del.json).toMatchObject({ ok: true, deleted: true });
  });
  it("DELETE 缺参即 400 结构化", async () => {
    const { routes } = setup();
    const bad = await call(routes, ROUTES.history, {
      method: "DELETE",
      url: ROUTES.history + "?root=/work",
    });
    expect(bad.status).toBe(400);
  });
});

describe("探针映射 429/超时/NETWORK（R4）", () => {
  async function probeWith(
    fetchImpl: (
      url: string,
      init: {
        readonly method: string;
        readonly headers: Record<string, string>;
        readonly body: string;
        readonly signal: AbortSignal;
      },
    ) => Promise<{ readonly status: number; readonly text: string }>,
  ): Promise<{ readonly status: number; readonly json: unknown; readonly calls: number }> {
    let calls = 0;
    const counting = async (
      url: string,
      init: {
        readonly method: string;
        readonly headers: Record<string, string>;
        readonly body: string;
        readonly signal: AbortSignal;
      },
    ): Promise<{ readonly status: number; readonly text: string }> => {
      calls += 1;
      return fetchImpl(url, init);
    };
    const { routes } = setup(counting);
    expect(
      (
        await call(routes, ROUTES.config, {
          method: "PUT",
          body: JSON.stringify({ apiKeyPlaintext: "ProbeSecretValue1234", confirm: true }),
        })
      ).status,
    ).toBe(200);
    const r = await call(routes, ROUTES.testConnection, { method: "POST", body: "{}" });
    return { status: r.status, json: r.json, calls };
  }
  it("429 初败可重试：3 次后 502 RATE_LIMITED", async () => {
    const r = await probeWith(async () => ({ status: 429, text: "limited" }));
    expect(r.calls).toBe(3);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain("RATE_LIMITED");
  });
  it("NETWORK 初败可重试：抛错 3 次后 502 NETWORK", async () => {
    const r = await probeWith(async () => {
      throw new Error("down");
    });
    expect(r.calls).toBe(3);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain("NETWORK");
  });
  it("上游 401 即 401 UNAUTHORIZED（不重试）", async () => {
    const r = await probeWith(async () => ({ status: 401, text: "{}" }));
    expect(r.calls).toBe(1);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.json)).toContain("UNAUTHORIZED");
  });
  it("超时即 504 TIMEOUT（abort 信号可重试）", async () => {
    const { routes } = setup(async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
      throw new Error("unreachable");
    });
    expect(
      (
        await call(routes, ROUTES.config, {
          method: "PUT",
          body: JSON.stringify({ timeoutMs: 1000 }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(routes, ROUTES.config, {
          method: "PUT",
          body: JSON.stringify({ apiKeyPlaintext: "ProbeSecretValue1234", confirm: true }),
        })
      ).status,
    ).toBe(200);
    const r = await call(routes, ROUTES.testConnection, { method: "POST", body: "{}" });
    expect(r.status).toBe(504);
    expect(JSON.stringify(r.json)).toContain("TIMEOUT");
  }, 15000);
});
