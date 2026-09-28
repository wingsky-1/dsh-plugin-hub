/**
 * dsh-notifier api 域 service 块 —— 装配面：路径表（对客户端的完整承诺）、接线、生命周期。
 *
 * 这一层只有装配面看得见的东西才值得测：哪 8 条路径被挂上、每条路径认哪些方法、四个端点各拿到
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

import type { ApiDeps, HostCapabilities, OutgoingFrame } from "../../../src/server/api/deps.ts";
import type { StreamBuildPort } from "../../../src/server/api/impl/stream/type.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { jsonReq, makeLogger, makeRegister, pollUntil, tempDshHome, wire } from "../../helpers.ts";

const home = tempDshHome();
const { installApi, releaseApi } = await import("../../../src/server/api/interface.ts");
// 建面端口的装载/复位面：动态导入与上同纪（流实例是模块级单例，落盘路径在导入期定下）。
const { installStreamBuild, releaseStreamBuild } =
  await import("../../../src/server/api/impl/stream/index.ts");
// 端口新增的 dry-run 纯函数走真实实现（动态导入与上同纪：config 单例的落盘路径在构造时定下）。
const { resolveDraftChannels, normalizeConfig } =
  await import("../../../src/server/config/interface.ts");
const { finalizeRequest, barkTarget, browserTarget, systemTarget, webhookTarget } =
  await import("../../../src/server/pipeline/interface.ts");
const { dryRunTarget } = await import("../../../src/server/channels/interface.ts");

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
  "/api/dsh-notifier/diagnostics",
  "/api/dsh-notifier/events",
] as const;

/** 能力面夹具：本文件只验「两个自检端点拿到的是 channels 域给的那一份」，形状细节归 api/probe 的用例。 */
const CAPABILITIES: HostCapabilities = {
  verdict: "degraded",
  unknownDimensions: [],
  popup: { state: "ok", checked: ["notify-send", "dbus-name-owner", "session-bus"] },
  sound: {
    state: "degraded",
    players: ["pw-play"],
    toneFileAvailable: false,
    checked: ["players", "tone-file"],
  },
  remediation: [{ code: "host-no-tone-file" }],
};

/** 路径 → 它认的方法。`allow` 头会把这行字逐条回给客户端，故它同时是 405 判据的期望值。 */
const METHOD_TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["/api/dsh-notifier/config", ["GET", "PUT"]],
  ["/api/dsh-notifier/history", ["GET", "DELETE"]],
  ["/api/dsh-notifier/status", ["GET"]],
  ["/api/dsh-notifier/kinds", ["GET", "POST"]],
  ["/api/dsh-notifier/test", ["POST"]],
  ["/api/dsh-notifier/health", ["GET"]],
  ["/api/dsh-notifier/diagnostics", ["GET"]],
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

/**
 * 假帧入口：handler 捕获下来手动触发，退订记账。
 * order 给了就把退订也记进同一张表（与路由摘除共表，「谁先谁后」才是真的同一条序）；
 * failOnFrame 让订阅当场抛错——那是装配期才看得见的失败面，端点块与 route 块都碰不到。
 */
function makeFrameInlet(options: { order?: string[]; failOnFrame?: boolean } = {}) {
  const handlers: Array<(payload: OutgoingFrame) => void> = [];
  let disposed = 0;
  return {
    handlers,
    disposedCount: () => disposed,
    port: {
      onFrame: (handler: (payload: OutgoingFrame) => void) => {
        if (options.failOnFrame === true) throw new Error("帧订阅失败");
        handlers.push(handler);
        return () => {
          disposed += 1;
          options.order?.push("frame");
        };
      },
    },
  };
}

/**
 * 建面端口的失败面：当场抛错，造「装的第一步就失败」那一格。
 *
 * 生产真实实现抛不了（序号读回吞错、`createSseHub` 只建 Map + setInterval），所以这是**注入的**
 * 失败面而不是复现出来的：它守的是装配面的回滚边界——闸有没有被焊死、有没有把半装配留在宿主上、
 * 清理路径有没有盖掉首因。接缝见 `impl/stream/type.ts` 的 `StreamBuildPort`。
 */
const FAILS_TO_BUILD: StreamBuildPort = {
  open() {
    throw new Error("安装失败：流面建不起来");
  },
};

/** 各能力面返回带标记的值：端点回给我的标记来自哪一份面，一读就知道有没有接错线。 */
const HISTORY = [{ ts: 1, kind: "done", title: "历史", message: "正文" }];
const STATUS = { "bark:main": { lastTs: 1, lastStatus: "ok" as const, failStreak: 0 } };
const KINDS = [{ id: "demo:x", label: "X", confirmed: false }];

/**
 * 装配期故障注入。三类失败都只在**装配面**看得见，端点块与 route 块都碰不到：
 * 宿主注册中途抛错（前 N-1 条已挂上）、帧订阅抛错（8 条全已挂上）、摘除时抛错（卸载中途失败）。
 */
interface Faults {
  /** 第 N 条注册抛错（0 起，按路径表顺序数）。 */
  readonly failRegisterAt?: number;
  /** 这些路径的摘除器在记账之后抛错。 */
  readonly failDisposePaths?: readonly string[];
  /** 帧订阅当场抛错：8 条路由此时已全部挂在宿主上，回滚表里没有它们。 */
  readonly failOnFrame?: boolean;
}

/** 造一份装配入参与它的记账夹具。入参与 `installApi` 分开是因为故障用例要在**装配抛错时**
 *  也拿得到观测物（`makeRegister` 的记账就是判据本身），组合起来的那层留给 `assemble()`。 */
function makeDeps(faults: Faults = {}) {
  const hub = makeRegister();
  // 退订序：帧退订与路由摘除记进同一张表，故「谁先谁后」是可断言的事实，而不是两个各记各的计数器。
  const order: string[] = [];
  const frames = makeFrameInlet({ order, failOnFrame: faults.failOnFrame });
  const logger = makeLogger();
  const submitted: Array<{ kind: string }> = [];
  // 注册与摘除都走记账夹具，故「摘没摘干净」永远可数；抛错点只包一层，不改记账口径。
  let registered = 0;
  const register: ApiDeps["register"] = (route) => {
    const index = registered;
    registered += 1;
    if (index === faults.failRegisterAt) throw new Error(`注册失败：${route.path}`);
    const dispose = hub.register(route);
    const tracked = (): void => {
      dispose();
      order.push(route.path);
    };
    if (faults.failDisposePaths?.includes(route.path) !== true) return tracked;
    return () => {
      tracked();
      throw new Error(`摘除失败：${route.path}`);
    };
  };
  const deps: ApiDeps = {
    register,
    frames: frames.port,
    logger,
    config: {
      readConfig: () => ({ ...DEFAULT_CONFIG }),
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
      resolveDraftChannels,
      normalizeConfig,
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
      finalizeRequest,
      barkTarget,
      browserTarget,
      systemTarget,
      webhookTarget,
    },
    kinds: {
      listKinds: () => [...KINDS],
      confirmKind: async () => ({
        ok: true,
        view: { user: {}, revision: 9, writable: true, effective: {} },
      }),
    },
    channels: {
      probeCapabilities: () => Promise.resolve(CAPABILITIES),
      hostPlatform: () => "linux",
      undeterminedCapabilities: () => CAPABILITIES,
      dryRunTarget,
    },
  };
  return { hub, frames, logger, submitted, order, deps };
}

/** 装配一次 api 域，交出全部观测面。 */
function assemble(faults: Faults = {}) {
  const wired = makeDeps(faults);
  installApi(wired.deps);
  return wired;
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
  it("恰好 8 条路径，且全部按 exact 注册（多一条就是多开一个浏览器入口）", () => {
    const { hub } = assemble();
    expect([...hub.routes.map((route) => route.path)].sort()).toEqual([...PATHS].sort());
    expect([...new Set(hub.routes.map((route) => route.kind))]).toEqual(["exact"]);
  });

  it.each(METHOD_TABLE)("%s 的方法表由 405 的 allow 头逐条列出", async (path, methods) => {
    const { hub } = assemble();
    const { rec, json } = await request(hub.routes, path, makeReq({ method: "PATCH", url: path }));
    expect(rec.status).toBe(405);
    expect(rec.headers.allow).toBe(methods.join(", "));
    expect(json()).toEqual({
      error: "method not allowed: PATCH",
      code: "METHOD_NOT_ALLOWED",
      status: 405,
    });
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

    // 两个自检端点都要拿到 channels 域那一份：接错线（少传 `channels`）在编译期是合法的。
    const health = await request(
      hub.routes,
      "/api/dsh-notifier/health",
      makeReq({ url: "/api/dsh-notifier/health" }),
    );
    const healthHost = wire<{ capabilities: { host: { verdict: string } } }>(health.json());
    expect(healthHost.capabilities.host.verdict).toBe("degraded");

    const diagnostics = await request(
      hub.routes,
      "/api/dsh-notifier/diagnostics",
      makeReq({ url: "/api/dsh-notifier/diagnostics" }),
    );
    const diagnosticsHost = wire<{ capabilities: { host: HostCapabilities } }>(diagnostics.json());
    // 摘要与完整面必须同源：`/diagnostics` 给的就是装配接上的那一份（含 checked 与 remediation）。
    expect(diagnosticsHost.capabilities.host).toEqual(CAPABILITIES);
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
    // 再装配的实质是「8 条路由又被挂回去」，就判这个。
    const again = assemble();
    expect(again.hub.routes.map((route) => route.path).sort()).toEqual([...PATHS].sort());
  });

  it("release 途中第 3 条摘除器抛错：其余路由与帧订阅仍全部摘除", () => {
    // 第 3 条装配序的摘除器（status）抛错。宿主摘不掉路由是真实会发生的（路由已被别人摘掉、
    // 宿主换实现），而「抛一条就跳出循环」等于把另外 7 条与帧订阅永久留在宿主上。
    const { hub, frames } = assemble({ failDisposePaths: ["/api/dsh-notifier/status"] });
    expect(hub.disposed).toEqual([]);

    releaseApi();

    // 抛错的那条自己已记账（先记账后抛），所以「全摘」与「抛错」不冲突。
    expect([...hub.disposed].sort()).toEqual([...PATHS].sort());
    expect(frames.disposedCount()).toBe(1);
  });

  it("release 途中抛错不阻断流枢纽与闸：SSE 停摆、installed 复位、下次装得上", () => {
    assemble({ failDisposePaths: ["/api/dsh-notifier/status"] });
    expect(() => releaseApi()).not.toThrow();

    // 只断「没抛」不够：闸卡在 true 时再装配会撞「api 域只能装配一次」，而半释放的域永远起不来。
    const again = assemble();
    expect(again.hub.routes.map((route) => route.path).sort()).toEqual([...PATHS].sort());
    // 流枢纽也得复位：它自己的「只能装配一次」会先于本域的闸撞上（半装配的心跳没人停）。
    expect(again.frames.handlers).toHaveLength(1);
  });

  it("注册中途失败：已挂上的前缀整单回滚，摘除器不随异常丢失", () => {
    // 第 4 条（kinds）注册抛错：前 3 条已挂在宿主上，帧订阅还没接上。摘除器只活在
    // registerEndpoints 的局部表里，不就地回滚就是永久泄漏（实测 release 摘掉 0 条）。
    const { hub, frames, deps } = makeDeps({ failRegisterAt: 3 });
    expect(() => installApi(deps)).toThrow(/注册失败/u);

    expect([...hub.disposed].sort()).toEqual([...PATHS.slice(0, 3)].sort());
    expect(frames.handlers).toEqual([]);
    // 回滚之后这次装配仍要能被撤销（afterEach 无条件调），且不重复摘。
    releaseApi();
    expect([...hub.disposed].sort()).toEqual([...PATHS.slice(0, 3)].sort());
  });

  it("注册中途失败且已挂路由的摘除器也抛错：3 条全摘干净，且首因仍是注册失败", () => {
    // 组合故障（逐项隔离的判红力在这一条）：注册第 4 条（kinds）抛错时前 3 条已挂在宿主上，
    // 而第 3 条（status）的摘除器在回滚时也抛错。去掉回滚里的逐项隔离，则 3 条里只摘 1 条、
    // 泄漏 2 条，抛给调用方的错误还会从「注册失败」变成「摘除失败」——「逐项隔离」与
    // 「清理路径不盖首因」两条承诺同时破。只断「抛的是错」的话，去掉隔离照样绿。
    const { hub, deps } = makeDeps({
      failRegisterAt: 3,
      failDisposePaths: ["/api/dsh-notifier/status"],
    });

    expect(() => installApi(deps)).toThrow(/注册失败/u);
    // 抛错的那条自己已记账（先记账后抛），所以「3 条全摘」与「有摘除器抛错」不冲突。
    expect([...hub.disposed].sort()).toEqual([...PATHS.slice(0, 3)].sort());
  });

  it("注册中途失败不把闸焊死：回滚后可以再装配（生产里对应宿主重试挂载）", () => {
    const { deps } = makeDeps({ failRegisterAt: 3 });
    expect(() => installApi(deps)).toThrow(/注册失败/u);

    const again = assemble();
    expect(again.hub.routes.map((route) => route.path).sort()).toEqual([...PATHS].sort());
  });

  it("帧订阅抛错：8 条路由全挂在宿主上，回滚一条不漏（摘除表不能只靠那条会中断的 push）", () => {
    // 展开求值 `push(...register(...), onFrame(...))` 时 onFrame 抛错，push 根本不发生：
    // 8 条路由全挂在宿主上而摘除表仍是空的（实测回滚摘掉 0 条、期望 8）。本例的判红力在这句
    // 「全部 8 条都进过 hub.disposed」——只断「抛错传上来了」的话，删掉整个回滚照样绿。
    const { hub, frames, deps } = makeDeps({ failOnFrame: true });
    expect(() => installApi(deps)).toThrow(/帧订阅失败/u);

    expect([...hub.disposed].sort()).toEqual([...PATHS].sort());
    expect(frames.handlers).toEqual([]);
    // 回滚之后这次装配仍要能被撤销（afterEach 无条件调），且不重复摘。
    releaseApi();
    expect([...hub.disposed].sort()).toEqual([...PATHS].sort());
  });

  it("帧订阅抛错不把闸焊死：回滚后可以再装配（半装配的域永远起不来是最难查的一种）", () => {
    const { deps } = makeDeps({ failOnFrame: true });
    expect(() => installApi(deps)).toThrow(/帧订阅失败/u);

    const again = assemble();
    expect(again.hub.routes.map((route) => route.path).sort()).toEqual([...PATHS].sort());
  });

  it("建面抛错：闸没焊死（可再装配）、一条路由都没挂上、抛给调用方的仍是建面失败", () => {
    // 装的第一步就失败那一格。判红力在第一条断言：闸的翻面与建面都排在 try 之外时，这次失败
    // 没人回滚，`installed` 卡在 true——之后直接再装就撞「api 域只能装配一次」（实测红在这一行）。
    const { hub, deps } = makeDeps();
    installStreamBuild(FAILS_TO_BUILD);
    try {
      // 首因上抛：清理路径（此时一条摘除器都没有）不许把「建面失败」换成别的错误。
      expect(() => installApi(deps)).toThrow(/安装失败/u);
    } finally {
      // 复位端口再走下面的再装配：让下一次装配走真实建面，否则量到的是同一个失败面。
      releaseStreamBuild();
    }
    // 建面排在挂路由之前，故失败时一条路由都不该挂在宿主上。
    expect(hub.routes).toEqual([]);

    const again = assemble();
    expect(again.hub.routes.map((route) => route.path).sort()).toEqual([...PATHS].sort());
  });

  it("release 逆序退订：帧订阅先于第一条路由被摘（后挂的先撤——先断帧的来路，再拆它的出口）", () => {
    const { order } = assemble();

    releaseApi();

    // 只判「帧排在第一条路由之前」：8 条路由彼此独立，谁先谁后没有语义差别，把整条序钉死只会
    // 让加一条端点就红一次；「逆序」真正要保的只有后挂的帧订阅先撤（把 reverse 改成正序即红）。
    expect(order[0]).toBe("frame");
    expect(order).toHaveLength(PATHS.length + 1);
  });
});
