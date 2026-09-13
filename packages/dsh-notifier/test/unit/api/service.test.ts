/**
 * dsh-notifier api 域 service 块 —— 装配面：路径表（对客户端的完整承诺）、接线、生命周期。
 *
 * 这一层只有装配面看得见的东西才值得测：哪 7 条路径被挂上、每条路径认哪些方法、四个端点各拿到
 * 的是哪份能力面（把 stores 接到设置端点是编译期拦不住的错位）、卸载时路由与帧订阅是否真的收回。
 * 单条端点的判据在各自的块里测，这里不重复。
 *
 * 隔离纪律：序号文件的路径在**模块加载期**就被 `streamHub` 定下（`notifierFile()` 在类字段
 * 初始化里跑，见 `impl/stream`）。故临时 `DSH_HOME` 必须先于 api 模块的导入建立——用顶层 await
 * 动态导入而不是静态导入，否则 `installApi` 会去读真实 `~/.dsh` 下的 `seq.json`。
 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { ApiDeps, OutgoingFrame } from "../../../src/server/api/deps.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { jsonReq, makeLogger, makeRegister, pollUntil, tempDshHome } from "../../helpers.ts";

const home = tempDshHome();
const { installApi, releaseApi } = await import("../../../src/server/api/interface.ts");

/**
 * 客户端锁定的路径表（`src/client/index.tsx` 里的 URL 常量是同一份承诺）。独立写一遍而不是从源码
 * 导：改路径就要两端同改，两边都从同一个常量取的话，改一处会让两边一起变绿。
 */
const PATHS = [
  "/api/dsh-notifier/config",
  "/api/dsh-notifier/history",
  "/api/dsh-notifier/status",
  "/api/dsh-notifier/kinds",
  "/api/dsh-notifier/test",
  "/api/dsh-notifier/health",
  "/api/dsh-notifier/events",
] as const;

/** 路径 → 它认的方法。`allow` 头会把这行字逐条回给客户端，故它同时是 405 判据的期望值。 */
const METHOD_TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["/api/dsh-notifier/config", ["GET", "PUT"]],
  ["/api/dsh-notifier/history", ["GET", "DELETE"]],
  ["/api/dsh-notifier/status", ["GET"]],
  ["/api/dsh-notifier/kinds", ["GET", "POST"]],
  ["/api/dsh-notifier/test", ["POST"]],
  ["/api/dsh-notifier/health", ["GET"]],
  ["/api/dsh-notifier/events", ["GET"]],
];

afterEach(() => {
  releaseApi();
});

afterAll(() => {
  home.dispose();
});

/** 假请求：合法回环，body 由 async 迭代器吐出（`readJsonBody` 走的就是这条路）。 */
function makeReq(options: { method?: string; url: string; body?: unknown }): IncomingMessage {
  return jsonReq({ method: options.method ?? "GET", url: options.url, body: options.body });
}

/** 假响应：JSON 端点与 SSE 端点共用（SSE 需要 `on`/`destroy` 才能被连接表收下）。 */
function makeRes() {
  const rec = {
    status: 0,
    headers: {} as Record<string, string>,
    text: "",
    headersSent: false,
    destroyed: false,
  };
  const listeners = new Map<string, Array<() => void>>();
  const res = {
    get headersSent() {
      return rec.headersSent;
    },
    get destroyed() {
      return rec.destroyed;
    },
    get writableEnded() {
      return false;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      rec.status = status;
      rec.headers = { ...(headers ?? {}) };
      rec.headersSent = true;
      return res;
    },
    write(chunk: string) {
      rec.text += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.text += chunk;
      rec.headersSent = true;
      return res;
    },
    on(event: string, handler: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return res;
    },
    destroy() {
      rec.destroyed = true;
      for (const handler of listeners.get("close") ?? []) handler();
    },
  };
  return {
    res: res as unknown as ServerResponse,
    rec,
    json: (): Record<string, unknown> => JSON.parse(rec.text),
  };
}

/** 假帧入口：handler 捕获下来手动触发，退订记账。 */
function makeFrameInlet() {
  const handlers: Array<(payload: OutgoingFrame) => void> = [];
  let disposed = 0;
  return {
    handlers,
    disposedCount: () => disposed,
    port: {
      onFrame: (handler: (payload: OutgoingFrame) => void) => {
        handlers.push(handler);
        return () => {
          disposed += 1;
        };
      },
    },
  };
}

/** 各能力面返回带标记的值：端点回给我的标记来自哪一份面，一读就知道有没有接错线。 */
const HISTORY = [{ ts: 1, kind: "done", title: "历史", message: "正文" }];
const STATUS = { "bark:main": { lastTs: 1, lastStatus: "ok" as const, failStreak: 0 } };
const KINDS = [{ id: "demo:x", label: "X", confirmed: false }];

/** 装配一次 api 域，交出全部观测面。 */
function assemble() {
  const hub = makeRegister();
  const frames = makeFrameInlet();
  const logger = makeLogger();
  const submitted: Array<{ kind: string }> = [];
  const deps: ApiDeps = {
    register: hub.register,
    frames: frames.port,
    logger,
    config: {
      readConfig: () => ({ ...DEFAULT_CONFIG, maxConnections: 4 }),
      readSettingsView: () => ({
        user: { notifyAsk: false },
        revision: 7,
        writable: true,
        effective: { notifyAsk: false },
      }),
      writeConfig: async () => ({
        ok: true,
        view: { user: {}, revision: 8, writable: true, effective: {} },
      }),
    },
    stores: {
      readHistory: async () => [...HISTORY],
      clearHistory: async () => 2,
      readStatus: async () => ({ ...STATUS }),
    },
    pipeline: {
      submit: (request) => {
        submitted.push(request);
      },
    },
    kinds: {
      listKinds: () => [...KINDS],
      confirmKind: async () => ({
        ok: true,
        view: { user: {}, revision: 9, writable: true, effective: {} },
      }),
    },
  };
  installApi(deps);
  return { hub, frames, logger, submitted };
}

/** 取一条已注册的路由；没注册就直接抛，免得后面的断言在 undefined 上假绿。 */
function routeOf(routes: WebRoute[], path: string): WebRoute {
  const route = routes.find((item) => item.path === path);
  if (route === undefined) throw new Error(`路由未注册: ${path}`);
  return route;
}

/**
 * 走一次真实路由并等响应落地。壳对异步端点的 promise 只做 `catch` 收口、不往上传（见 route 块），
 * 故 `handler()` 立刻返回 undefined——等响应只能靠轮询 `headersSent`。
 */
async function request(routes: WebRoute[], path: string, req: IncomingMessage) {
  const captured = makeRes();
  routeOf(routes, path).handler(req, captured.res);
  await pollUntil(() => captured.rec.headersSent, `${path} 未写出响应`);
  return captured;
}

describe("路径表：对客户端的完整承诺", () => {
  it("恰好 7 条路径，且全部按 exact 注册（多一条就是多开一个浏览器入口）", () => {
    const { hub } = assemble();
    expect([...hub.routes.map((route) => route.path)].sort()).toEqual([...PATHS].sort());
    expect([...new Set(hub.routes.map((route) => route.kind))]).toEqual(["exact"]);
  });

  it.each(METHOD_TABLE)("%s 的方法表由 405 的 allow 头逐条列出", async (path, methods) => {
    const { hub } = assemble();
    const { rec, json } = await request(hub.routes, path, makeReq({ method: "PATCH", url: path }));
    expect(rec.status).toBe(405);
    expect(rec.headers.allow).toBe(methods.join(", "));
    expect(json()).toEqual({ error: "method not allowed: PATCH" });
  });
});

describe("接线：端点与能力面一一对应", () => {
  it("四个端点各拿到自己那份能力面（接错线在编译期是合法的，只有装配面看得见）", async () => {
    const { hub, submitted } = assemble();

    const config = await request(
      hub.routes,
      "/api/dsh-notifier/config",
      makeReq({ url: "/api/dsh-notifier/config" }),
    );
    expect(config.json().revision).toBe(7);

    const history = await request(
      hub.routes,
      "/api/dsh-notifier/history",
      makeReq({ url: "/api/dsh-notifier/history" }),
    );
    expect(history.json().records).toEqual(HISTORY);

    const kinds = await request(
      hub.routes,
      "/api/dsh-notifier/kinds",
      makeReq({ url: "/api/dsh-notifier/kinds" }),
    );
    expect(kinds.json().kinds).toEqual(KINDS);

    const test = await request(
      hub.routes,
      "/api/dsh-notifier/test",
      makeReq({ method: "POST", url: "/api/dsh-notifier/test" }),
    );
    expect(test.rec.status).toBe(200);
    expect(submitted.map((entry) => entry.kind)).toEqual(["test"]);
  });

  it("装配同时接上帧入口：帧经 /events 回放给新连接（接线断了页面永远收不到通知）", async () => {
    const { hub, frames } = assemble();
    expect(frames.handlers).toHaveLength(1);
    frames.handlers[0]!({
      kind: "done",
      frame: {
        pop: true,
        sound: { mode: "system" },
        whenVisible: false,
        title: "标题",
        body: "正文",
      },
    });

    const { rec } = await request(
      hub.routes,
      "/api/dsh-notifier/events",
      makeReq({ url: "/api/dsh-notifier/events" }),
    );
    expect(rec.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(rec.text).toContain("标题");
  });
});

describe("生命周期", () => {
  it("release 摘掉全部路由与帧订阅（卸载后路由还在，等于插件卸载没生效）", () => {
    const { hub, frames } = assemble();
    expect(hub.disposed).toEqual([]);

    releaseApi();

    expect([...hub.disposed].sort()).toEqual([...PATHS].sort());
    expect(frames.disposedCount()).toBe(1);
  });

  it("重复装配当场抛错，release 之后可以再装配（卸载链可能走到不止一次）", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
    releaseApi();
    releaseApi();
    // 只断「没抛」不够：装上了与**静默空转**都不抛（实测把 install 改成见标记即 return，这条照样绿）。
    // 再装配的实质是「7 条路由又被挂回去」，就判这个。
    const again = assemble();
    expect(again.hub.routes.map((route) => route.path).sort()).toEqual([...PATHS].sort());
  });
});
