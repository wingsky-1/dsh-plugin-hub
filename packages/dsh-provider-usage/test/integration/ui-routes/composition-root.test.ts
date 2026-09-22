/**
 * dsh-provider-usage — integration：UI 路由域组合根四维度（#768 计划表 rev2 D12 验收）。
 *
 * 白盒直连 src（经 server/ui-routes 门面活装配 + 实现直引同一性）；落盘一律进
 * mkdtemp 隔离目录（产物零污染；路径禁令：本文件无家目录调用，走 dshHome 接缝检查由
 * gate:homedir 门禁覆盖）。离线：桩服务/趋势/ctx 全内存，不起端口、不触 DSH_HOME、
 * 不读真实凭据。
 * 四维度：
 * - D12一 经 server/ui-routes 域门面装配：一域四块（health/trend/ui-config/events）
 *   + 跨块装配形状（context）只经 server/ui-routes/interface.ts，不走旧
 *   domain2/routes 入口；apply/apply.ts 的路由消费收口新门面；旧 domain2 面已删除
 *   （#768 D13 删空锚点：dir-imports 基线 + gate-exemptions 台账 +
 *   本文件 D12一存在性断言已同步更新）；门面禁整文件 re-export；
 *   创建面不进包导出面。
 * - D12二 广播窄面 + 实例经参数传递：context 广播字段为 deps.ts 窄口
 *   （UiRoutesBroadcast，块内联双生子）；只暴露窄口的缝跑通 ui-config 写盘
 *   （多一能力即 TypeError 先红）；statsService/trend/layerErrors 实例只由组合根
 *   构造、经参数传递（实现内无 new/make）；TREND_DIR_MAX 经 collect 门面值复用；
 *   deps.ts 纯类型面运行时零出口；不设聚合 UiRoutesDeps。
 * - D12三 围栏与正路：四端点非回环 + 错方法仍 403（顺序反了即 405 泄漏）；
 *   回环 + 错方法 405 且文案逐字节锁定。
 * - D12四 健康读 errsurf + SSE 非可靠 + 路由单点 + 释放：health 响应 layerErrors
 *   段读真错误面（记录→呈现链路）；SSE 连通帧 + 断连移除 + 重连无补帧（补帧出口
 *   不存在，断线帧丢失为预期）；创建面路径即 ROUTES 单点（实现内无硬编码 /api/
 *   字面量）；拆卸期 sseClients 排空（不清即残留）。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
import {
  UiRoutesContext,
  createUiRoutes,
  handleHealth,
  clampTrendN,
  handleTrend,
  handleUiConfig,
  handleEvents,
} from "../../../src/server/ui-routes/interface.ts";
import type { UiRoutesContextOptions } from "../../../src/server/ui-routes/interface.ts";
import {
  UiRoutesContext as ImplContext,
  createUiRoutes as ImplCreate,
} from "../../../src/server/ui-routes/context.ts";
import { handleHealth as ImplHealth } from "../../../src/server/ui-routes/health.ts";
import {
  clampTrendN as ImplClamp,
  handleTrend as ImplTrend,
} from "../../../src/server/ui-routes/trend.ts";
import { handleUiConfig as ImplUiConfig } from "../../../src/server/ui-routes/ui-config.ts";
import * as uiRoutesDepsNs from "../../../src/server/ui-routes/deps.ts";
import type { UiRoutesBroadcast } from "../../../src/server/ui-routes/deps.ts";
import type { StatsService } from "../../../src/server/pipeline/interface.ts";
import type { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { makeLayerErrorSurface } from "../../../src/server/shared/interface.ts";
import type { LayerErrorSurface } from "../../../src/server/shared/interface.ts";
import { DEFAULT_UI_CONFIG } from "../../../src/shared/interface.ts";
import { ROUTES } from "../../../src/apply/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const readText = (p: string): string => readFileSync(p, "utf8");
const applySrc = readText(join(srcDir, "apply", "apply.ts"));
const applyFaceSrc = readText(join(srcDir, "apply", "index.ts"));
// #768 D13：空锚点 src/domain2/routes/interface.ts 已删，本文件不再读旧面（旧面符号改由“目录已消除”断言锁定）。
const uiFaceSrc = readText(join(srcDir, "server", "ui-routes", "interface.ts"));
const uiDepsSrc = readText(join(srcDir, "server", "ui-routes", "deps.ts"));
const contextSrc = readText(join(srcDir, "server", "ui-routes", "context.ts"));
const healthSrc = readText(join(srcDir, "server", "ui-routes", "health.ts"));
const trendSrc = readText(join(srcDir, "server", "ui-routes", "trend.ts"));
const uiConfigSrc = readText(join(srcDir, "server", "ui-routes", "ui-config.ts"));
const eventsSrc = readText(join(srcDir, "server", "ui-routes", "events.ts"));
// host-seams R2 收敛后客户端字面量只留 client/shared/contract.ts 一份（core.ts 改经具名表 import）。
const clientContractSrc = readText(join(srcDir, "client", "shared", "contract.ts"));
const topologySrc = readText(join(repoRoot, "scripts", "data", "mutation-topology.json"));
const strykerRoutesSrc = readText(
  join(repoRoot, "stryker.conf.d", "dsh-provider-usage-routes.json"),
);

/**
 * 旧门面判据：旧 domain2 门面入口、旧深相对路径或已删装配面残留即红（针脚为域事实，命中循环见 helpers）。
 * collect 同级短径：trend.ts 经 ../collect/interface.ts 取 TREND_DIR_MAX
 * （与余下消费同形，#768 跨域路径统一后长形态 ../../server/ 已消除）——本判据认全部
 * ../../server/ 深径，collect 短形态由「实现块改址」逐字锁定 import 面（见探针 describe 双向用例）。
 */
function usesOldFace(src: string): boolean {
  return (
    containsAny(src, ["domain2/routes/interface", "../../apply/interface"]) ||
    src.includes("../../server/")
  );
}

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});

// ---------------------------------------------------------------- fake 请求/响应
//
// 与 report-routes 组合根同形：loopback = 127.0.0.1 socket + 回环 host；
// readJsonBodyOutcome 经 for await 读 body，故带 async-iterator 桩。
function fakeReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080" },
    method: "GET",
    url: "/",
    [Symbol.asyncIterator]: async function* (this: unknown) {
      const body = (overrides as { body?: unknown }).body;
      if (typeof body === "string" && body !== "") {
        yield Buffer.from(body);
      }
    },
    ...overrides,
  };
  return req as unknown as IncomingMessage;
}

/** 非回环桩（smoke 实证：该 socket 即 403）。 */
function nonLoopbackReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  return fakeReq({
    socket: { remoteAddress: "10.0.0.2" },
    headers: { host: "evil.example" },
    ...overrides,
  });
}

function makeRes(): ServerResponse & { _code(): number | undefined; _body(): string } {
  const chunks: string[] = [];
  let code: number | undefined;
  const res = {
    writeHead(c: number): void {
      code = c;
    },
    end(chunk: unknown): void {
      chunks.push(String(chunk));
    },
    _code(): number | undefined {
      return code;
    },
    _body(): string {
      return chunks.join("");
    },
  };
  return res as unknown as ServerResponse & { _code(): number | undefined; _body(): string };
}

/** SSE 连通帧文案（与实现同字，改坏即红）。 */
const CONNECT_FRAME = ": connected\n\n";

/** SSE 桩：连通帧捕获 + close 可发射（handleEvents 薄 handler 的可观测面）。 */
function makeSseRes(): {
  res: ServerResponse;
  chunks: string[];
  status: () => number;
  emitClose: () => void;
} {
  const chunks: string[] = [];
  const handlers = new Map<string, Array<() => void>>();
  let status = 0;
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    write: (c: string) => {
      chunks.push(String(c));
    },
    on: (evt: string, fn: () => void) => {
      const list = handlers.get(evt) ?? [];
      list.push(fn);
      handlers.set(evt, list);
    },
  } as unknown as ServerResponse;
  return {
    res,
    chunks,
    status: () => status,
    emitClose: () => {
      for (const fn of handlers.get("close") ?? []) fn();
    },
  };
}

// ---------------------------------------------------------------- 装配桩
//
// statsService/trend 只暴露 handler 触达的面（多用一能力即 TypeError 先红）；
// layerErrors 用真错误面（健康读 errsurf 的记录→呈现链路不断）；
// broadcast 缝以 UiRoutesBroadcast 注解（名称链接由 tsc 编译面校验可赋值性）。
function stubUiCtx(
  historyRoot: string,
  opts: { layerErrors?: LayerErrorSurface } = {},
): { ctx: UiRoutesContext; broadcastSeen: string[] } {
  const broadcastSeen: string[] = [];
  const broadcastSeam: UiRoutesBroadcast = () => {
    broadcastSeen.push("broadcast");
  };
  const statsService = {
    registry: {
      snapshot: () => ({ infos: [], enabled: {}, errors: [] }),
    },
    config: { provider: "stub-provider", trendRetentionDays: 90 },
    cacheSize: () => 0,
    historyRoot,
  } as unknown as StatsService;
  const trend = {
    stats: () => ({ days: 0, pendingRows: 0, unpersistedRows: 0 }),
    seriesStacked: () => ({ series: [], providers: [] }),
    dirStacked: () => ({ series: [], dirs: [] }),
    windowSummary: () => ({ total: 0, calls: 0 }),
    dirWindowSummary: () => ({ total: 0, calls: 0 }),
    firstRecordedDay: () => null,
  } as unknown as TrendTracker;
  const options: UiRoutesContextOptions = {
    statsService,
    trend,
    uiConfig: { ...DEFAULT_UI_CONFIG },
    sseClients: new Set<ServerResponse>(),
    broadcastUiConfigChanged: broadcastSeam,
    layerErrors: opts.layerErrors ?? makeLayerErrorSurface(),
  };
  return { ctx: new UiRoutesContext(options), broadcastSeen };
}

type AnyHandler = (req: IncomingMessage, res: ServerResponse, ctx: object) => unknown;

async function callStatus(
  handler: AnyHandler,
  req: IncomingMessage,
  ctx: UiRoutesContext,
): Promise<{ code: number | undefined; body: unknown }> {
  const res = makeRes();
  await handler(req, res, ctx);
  return { code: res._code(), body: res._body() === "" ? undefined : JSON.parse(res._body()) };
}

describe("D12一 经 server/ui-routes 域门面装配", () => {
  it("组合根与包入口只经新门面取 UI 路由（旧深径残留必须红）", () => {
    for (const src of [
      uiFaceSrc,
      uiDepsSrc,
      contextSrc,
      healthSrc,
      trendSrc,
      uiConfigSrc,
      eventsSrc,
    ]) {
      expect(usesOldFace(src)).toBe(false);
    }
    expect(applySrc.includes("server/ui-routes/interface")).toBe(true);
    expect(applyFaceSrc.includes("../domain2/routes/interface.ts")).toBe(false);
  });

  it("实现块改址：同级短径复用三域门面（旧深路径残留必须红）", () => {
    expect(contextSrc.includes("../pipeline/interface")).toBe(true);
    expect(contextSrc.includes("../aggregate/interface")).toBe(true);
    expect(contextSrc.includes("../shared/interface")).toBe(true);
    // #768 A波3：TREND_DIR_MAX 已下沉 shared，trend 经 shared 门面
    expect(trendSrc.includes("../collect/interface")).toBe(false);
    expect(trendSrc.includes("../shared/interface")).toBe(true);
    for (const src of [healthSrc, trendSrc, uiConfigSrc, eventsSrc]) {
      expect(src.includes("./context")).toBe(true);
    }
  });

  it("旧 domain2 面已删除（残留即装配分叉回退）", () => {
    expect(existsSync(join(srcDir, "domain2", "routes", "interface.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "domain2", "routes"))).toBe(false);
    expect(existsSync(join(srcDir, "domain2"))).toBe(false);
  });

  it("门面收口：interface 与实现同一引用（包装即红）", async () => {
    expect(UiRoutesContext).toBe(ImplContext);
    expect(createUiRoutes).toBe(ImplCreate);
    expect(handleHealth).toBe(ImplHealth);
    expect(clampTrendN).toBe(ImplClamp);
    expect(handleTrend).toBe(ImplTrend);
    expect(handleUiConfig).toBe(ImplUiConfig);
    const eventsNs = await import("../../../src/server/ui-routes/events.ts");
    expect(handleEvents).toBe(eventsNs.handleEvents);
  });

  it("块最小导出（块外加出口即公共面膨胀）", async () => {
    expect(Object.keys(await import("../../../src/server/ui-routes/context.ts")).sort()).toEqual(
      ["UiRoutesContext", "createUiRoutes"].sort(),
    );
    expect(Object.keys(await import("../../../src/server/ui-routes/health.ts"))).toEqual([
      "handleHealth",
    ]);
    expect(Object.keys(await import("../../../src/server/ui-routes/trend.ts")).sort()).toEqual(
      ["clampTrendN", "handleTrend"].sort(),
    );
    expect(Object.keys(await import("../../../src/server/ui-routes/ui-config.ts"))).toEqual([
      "handleUiConfig",
    ]);
    expect(Object.keys(await import("../../../src/server/ui-routes/events.ts"))).toEqual([
      "handleEvents",
    ]);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    for (const src of [uiFaceSrc, uiDepsSrc]) {
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
      expect(hasExportStar(codeLines)).toBe(false);
    }
  });

  it("门面值出口恰为 7 项（多一项即公共面膨胀）", async () => {
    const faceNs = await import("../../../src/server/ui-routes/interface.ts");
    expect(Object.keys(faceNs).sort()).toEqual(
      [
        "UiRoutesContext",
        "createUiRoutes",
        "handleHealth",
        "clampTrendN",
        "handleTrend",
        "handleUiConfig",
        "handleEvents",
      ].sort(),
    );
  });

  it("包导出面零扩张：UI 创建面不进 apply/index.ts（误转即红）", () => {
    for (const sym of [
      "createUiRoutes",
      "handleHealth",
      "handleTrend",
      "handleUiConfig",
      "handleEvents",
      "clampTrendN",
      "UiRoutesContext",
    ]) {
      expect(applyFaceSrc.includes(sym)).toBe(false);
    }
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    expect(topologySrc.includes("src/domain2/routes/ui.ts")).toBe(false);
    for (const p of [
      "src/server/ui-routes/context.ts",
      "src/server/ui-routes/health.ts",
      "src/server/ui-routes/trend.ts",
      "src/server/ui-routes/ui-config.ts",
      "src/server/ui-routes/events.ts",
    ]) {
      expect(topologySrc.includes(p)).toBe(true);
      expect(strykerRoutesSrc.includes(p)).toBe(true);
    }
    expect(strykerRoutesSrc.includes("src/domain2/routes/ui.ts")).toBe(false);
  });
});

describe("D12二 广播窄面 + 实例经参数传递", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(uiRoutesDepsNs)).toEqual([]);
  });

  it("不设聚合 UiRoutesDeps（设了即无消费者导出）", () => {
    expect(uiDepsSrc.includes("export interface UiRoutesDeps")).toBe(false);
    expect(uiDepsSrc.includes("export type UiRoutesDeps")).toBe(false);
  });

  it("窄面缝跑通 ui-config 读写（写盘 + 广播恰一次，确权即红）", async () => {
    const root = isolatedDir("dou-uiroutesD12-");
    const { ctx, broadcastSeen } = stubUiCtx(root);
    const got = await callStatus(handleUiConfig as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(got.code).toBe(200);
    expect((got.body as { ok?: boolean }).ok).toBe(true);
    const posted = await callStatus(
      handleUiConfig as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ placement: "bottom-left" }) }),
      ctx,
    );
    expect(posted.code).toBe(200);
    expect(broadcastSeen).toEqual(["broadcast"]);
    expect(existsSync(join(root, "ui.json"))).toBe(true);
  });

  it("ui-config 非法 body 400 且不广播（坏输入写盘即红）", async () => {
    const root = isolatedDir("dou-uiroutesD12-");
    const { ctx, broadcastSeen } = stubUiCtx(root);
    const bad = await callStatus(
      handleUiConfig as AnyHandler,
      fakeReq({ method: "POST", body: "{not-json" }),
      ctx,
    );
    expect(bad.code).toBe(400);
    expect(broadcastSeen).toEqual([]);
  });

  it("TREND_DIR_MAX 经 collect 门面值复用（自立口径即分叉）", () => {
    expect(trendSrc.includes("const TREND_DIR_MAX")).toBe(false);
    expect(trendSrc.includes("TREND_DIR_MAX")).toBe(true);
  });

  it("业务实例不自建（实现内 new/make 即装配倒灌）", () => {
    for (const src of [contextSrc, healthSrc, trendSrc, uiConfigSrc, eventsSrc]) {
      expect(src.includes("new StatsService")).toBe(false);
      expect(src.includes("new TrendTracker")).toBe(false);
      expect(src.includes("makeLayerErrorSurface(")).toBe(false);
    }
  });

  it("家目录禁令：六文件无 homedir/HOME/untildify 直调（直调即红）", () => {
    for (const src of [
      contextSrc,
      healthSrc,
      trendSrc,
      uiConfigSrc,
      eventsSrc,
      uiFaceSrc,
      uiDepsSrc,
    ]) {
      expect(src.includes("homedir(")).toBe(false);
      expect(src.includes("process.env.HOME")).toBe(false);
      expect(src.includes("untildify")).toBe(false);
    }
  });
});

describe("D12三 越围栏必须红（403 先于 405）", () => {
  const fenceTable: { name: string; handler: AnyHandler; wrongMethod: string }[] = [
    { name: "health", handler: handleHealth as AnyHandler, wrongMethod: "POST" },
    { name: "trend", handler: handleTrend as AnyHandler, wrongMethod: "POST" },
    { name: "uiConfig", handler: handleUiConfig as AnyHandler, wrongMethod: "DELETE" },
    { name: "events", handler: handleEvents as AnyHandler, wrongMethod: "POST" },
  ];

  it.each(fenceTable.map((c) => c.name))(
    "%s 非回环 + 错方法仍 403（顺序反了即 405 泄漏）",
    async (name) => {
      const found = fenceTable.find((c) => c.name === name);
      if (found === undefined) throw new Error("fence 缺行：" + name);
      const root = isolatedDir("dou-uiroutesD12-");
      const { ctx } = stubUiCtx(root);
      // 围栏先于一切：非回环即 403，handler 不触达 res.write/on（makeRes 薄桩即够）。
      const res = makeRes();
      await found.handler(nonLoopbackReq({ method: found.wrongMethod }), res, ctx);
      expect(res._code()).toBe(403);
    },
  );

  it.each(fenceTable.map((c) => ({ name: c.name, method: c.wrongMethod })))(
    "$name 回环 + 错 $method → 405 且文案逐字节锁定（文案漂移即红）",
    async ({ name, method }) => {
      const found = fenceTable.find((c) => c.name === name);
      if (found === undefined) throw new Error("fence 缺行：" + name);
      const root = isolatedDir("dou-uiroutesD12-");
      const { ctx } = stubUiCtx(root);
      const { code, body } = await callStatus(found.handler, fakeReq({ method }), ctx);
      expect(code).toBe(405);
      expect((body as { error?: string }).error).toBe("method not allowed: " + method);
    },
  );
});

describe("D12四 健康读 errsurf + SSE 非可靠 + 路由单点 + 释放", () => {
  it("健康读 errsurf：记录→呈现链路（少读一层即红）", async () => {
    const root = isolatedDir("dou-uiroutesD12-");
    const surface = makeLayerErrorSurface();
    surface.record("aggregate", "probe-boom");
    const { ctx } = stubUiCtx(root, { layerErrors: surface });
    const got = await callStatus(handleHealth as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(got.code).toBe(200);
    const layerErrors = (got.body as { layerErrors?: Record<string, { count?: number }> })
      .layerErrors;
    expect(layerErrors?.aggregate?.count).toBe(1);
  });

  it("trend 正路：默认面 200（封顶/留存回显，改坏即红）", async () => {
    const root = isolatedDir("dou-uiroutesD12-");
    const { ctx } = stubUiCtx(root);
    const got = await callStatus(
      handleTrend as AnyHandler,
      fakeReq({ method: "GET", url: "/" }),
      ctx,
    );
    expect(got.code).toBe(200);
    const body = got.body as {
      ok?: boolean;
      granularity?: string;
      n?: number;
      retentionDays?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.granularity).toBe("day");
    expect(body.n).toBe(30);
    expect(body.retentionDays).toBe(90);
  });

  it("SSE 注册→断连移除→重连只收连通帧（补帧即红：断线帧丢失为预期）", () => {
    const root = isolatedDir("dou-uiroutesD12-");
    const { ctx } = stubUiCtx(root);
    const first = makeSseRes();
    handleEvents(fakeReq({ method: "GET" }), first.res, ctx);
    expect(first.status()).toBe(200);
    expect(first.chunks).toEqual([CONNECT_FRAME]);
    expect(ctx.sseClients.size).toBe(1);
    first.emitClose();
    first.emitClose(); // P2：重复断连幂等（不抛错，不断言，只覆盖；抛错即本用例红）。
    expect(ctx.sseClients.size).toBe(0);
    const second = makeSseRes();
    handleEvents(fakeReq({ method: "GET" }), second.res, ctx);
    expect(second.chunks).toEqual([CONNECT_FRAME]);
    expect(ctx.sseClients.size).toBe(1);
  });

  it("创建面路径即 ROUTES 单点（自定字面量即红）", () => {
    const root = isolatedDir("dou-uiroutesD12-");
    const { ctx } = stubUiCtx(root);
    const routes = createUiRoutes(
      {
        health: ROUTES.health,
        trend: ROUTES.trend,
        uiConfig: ROUTES.uiConfig,
        events: ROUTES.events,
      },
      ctx,
    );
    expect(routes.map((r) => r.path).sort()).toEqual(
      [ROUTES.health, ROUTES.trend, ROUTES.uiConfig, ROUTES.events].sort(),
    );
    for (const src of [contextSrc, healthSrc, trendSrc, uiConfigSrc, eventsSrc]) {
      expect(src.includes("/api/")).toBe(false);
    }
  });

  it("SSE 拆卸排空（不清即残留泄漏）", () => {
    expect(applySrc.includes("for (const res of sseClients)")).toBe(true);
    expect(applySrc.includes("sseClients.clear()")).toBe(true);
  });

  it("客户端回指 ui-config（缺键即宿主与客户端分叉）", () => {
    expect(clientContractSrc.includes("/api/dsh-provider-usage/ui-config")).toBe(true);
  });
});

describe("探针：detector 失明则本段先红", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace("import { x } from ../domain2/routes/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../../server/config/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../../apply/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../server/ui-routes/interface.ts")).toBe(false);
    expect(usesOldFace("import { x } from ../collect/interface.ts")).toBe(false);
    expect(usesOldFace("import { x } from ../../server/collect/interface.ts")).toBe(true);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(["export * from ./health.ts"])).toBe(true);
    expect(hasExportStar(["export { a } from ./health.ts"])).toBe(false);
  });

  it("封顶纯函数对脏输入有效（非法回默认）", () => {
    expect(clampTrendN("abc", "day", 30)).toBe(30);
    expect(clampTrendN("50", "day", 30)).toBe(30);
  });

  it("隔离目录可用（mkdtemp 探针）", () => {
    const dir = isolatedDir("dou-uiroutesD12-");
    expect(typeof dir).toBe("string");
  });
});
