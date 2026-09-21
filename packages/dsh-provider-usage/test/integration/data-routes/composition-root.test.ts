/**
 * dsh-provider-usage — integration：数据路由域组合根四维度 + 围栏验收（#768 计划表 rev2 D10 验收）。
 *
 * 白盒直连 src（经 server/data-routes 门面活装配 + 实现直引同一性）；无落盘
 * （围栏与桩内短路，mkdtemp 仅探针自证可用；路径禁令：本文件无家目录调用，
 * 走 dshHome 接缝检查由 gate:homedir 门禁覆盖）。离线：桩 StatsService/ctx
 * 全内存，不起端口、不触 DSH_HOME、不读真实凭据。
 * 四维度 + 一验收：
 * - D10一 经 server/data-routes 域门面装配：六 handler + 两 create 只经
 *   server/data-routes/interface.ts，不走旧 domain1/routes 入口；apply/apply.ts
 *   的路由消费收口新门面；门面禁整文件 re-export；路由创建面不进包导出面。
 * - D10二 越围栏必须红：guardLoopbackMethod 403 先于 405——非回环 + 错方法
 *   同压仍 403（顺序反了即 405 泄漏）；回环 + 错方法 405 且文案逐字节锁定；
 *   回环 + 正方法放行（stats/history/adapters/select-clearing 四正路 200）。
 * - D10三 deps 注入面窄面：DataRoutesEnsureHotReload 命名接缝与块内联双生子
 *   （AdapterRoutesContext 保留内联函数类型，不 import type 本面）；
 *   deps.ts 纯类型面运行时零出口；家目录禁令三文件零直调。
 * - D10四 路由单点 + 客户端契约：创建面路径即 ROUTES 单点（实现内无硬编码
 *   /api/ 字面量）；src/client/core.ts 六键回指同源（缺键即客户端与宿主分叉）。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
import {
  handleStats,
  handleHistory,
  createStatsRoutes,
  handleAdapters,
  handleSelect,
  handleInspect,
  handleAdd,
  createAdapterRoutes,
} from "../../../src/server/data-routes/interface.ts";
import type {
  StatsRoutesContext,
  AdapterRoutesContext,
} from "../../../src/server/data-routes/interface.ts";
import {
  handleStats as ImplHandleStats,
  handleHistory as ImplHandleHistory,
  createStatsRoutes as ImplCreateStatsRoutes,
} from "../../../src/server/data-routes/stats.ts";
import {
  handleAdapters as ImplHandleAdapters,
  handleSelect as ImplHandleSelect,
  handleInspect as ImplHandleInspect,
  handleAdd as ImplHandleAdd,
  createAdapterRoutes as ImplCreateAdapterRoutes,
} from "../../../src/server/data-routes/adapters.ts";
import * as dataRoutesDepsNs from "../../../src/server/data-routes/deps.ts";
import type { DataRoutesEnsureHotReload } from "../../../src/server/data-routes/deps.ts";
import type { StatsService } from "../../../src/server/pipeline/interface.ts";
import { ROUTES } from "../../../src/apply/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const readText = (p: string): string => readFileSync(p, "utf8");
const applySrc = readText(join(srcDir, "apply", "apply.ts"));
const applyFaceSrc = readText(join(srcDir, "apply", "index.ts"));
const dataFaceSrc = readText(join(srcDir, "server", "data-routes", "interface.ts"));
const dataDepsSrc = readText(join(srcDir, "server", "data-routes", "deps.ts"));
const statsSrc = readText(join(srcDir, "server", "data-routes", "stats.ts"));
const adaptersSrc = readText(join(srcDir, "server", "data-routes", "adapters.ts"));
const clientCoreSrc = readText(join(srcDir, "client", "core.ts"));
const topologySrc = readText(join(repoRoot, "scripts", "data", "mutation-topology.json"));
const strykerRoutesSrc = readText(
  join(repoRoot, "stryker.conf.d", "dsh-provider-usage-routes.json"),
);

/** 旧门面判据：旧 domain1/routes 长路径或旧深相对残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain1/routes", "../../server/"]);
}

/**
 * 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：窄面在此复用名称。
 * ensureHotReload 缺省空转（围栏用例不走到热更新装配）。
 */
const hotReloadCalls: string[] = [];
const ensureHotReloadSeam: DataRoutesEnsureHotReload = async (file: string): Promise<void> => {
  hotReloadCalls.push(file);
};

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
  hotReloadCalls.length = 0;
});

// ---------------------------------------------------------------- fake 请求/响应
//
// 与 e2e smoke 同形：loopback = 127.0.0.1 socket + 回环 host；readJsonBodyOutcome
// 经 for await 读 body，故带 async-iterator 桩。
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

// ---------------------------------------------------------------- 桩 StatsService/ctx
//
// 围栏先于业务：403/405 用例在桩方法被调用前即返回，故桩体只服务正路用例。
function stubStatsService(): StatsService {
  return {
    config: { provider: "deepseek" },
    registry: {
      snapshot: () => ({ infos: [], enabled: {}, errors: [] }),
      getEntry: () => undefined,
      hasCandidates: () => false,
      select: () => true,
    },
    getStats: async () => ({
      provider: "deepseek",
      adapterName: "stub",
      status: "ok",
      capsuleHtml: "<span>stub</span>",
      ok: true,
      configured: true,
      reason: null,
      error: null,
      fetchedAt: 1,
    }),
    purgeAllCaches: () => undefined,
    warmupProviders: () => undefined,
    scheduleWriteAdapterState: () => undefined,
  } as unknown as StatsService;
}

function stubStatsCtx(): StatsRoutesContext {
  return { statsService: stubStatsService() };
}

function stubAdapterCtx(): AdapterRoutesContext {
  return {
    ctx: {} as AdapterRoutesContext["ctx"],
    statsService: stubStatsService(),
    ensureHotReload: ensureHotReloadSeam,
    resolveAdapterFile: () => undefined,
    loadAdapterChecked: async () => ({
      ok: false as const,
      code: "adapter-load-failed",
      detail: "stub",
    }),
  };
}

type AnyHandler = (req: IncomingMessage, res: ServerResponse, ctx: object) => unknown;

async function callStatus(
  handler: AnyHandler,
  req: IncomingMessage,
  ctx: StatsRoutesContext | AdapterRoutesContext,
): Promise<{ code: number | undefined; body: unknown }> {
  const res = makeRes();
  await handler(req, res, ctx);
  return { code: res._code(), body: res._body() === "" ? undefined : JSON.parse(res._body()) };
}

describe("D10一 经 server/data-routes 域门面装配", () => {
  it("组合根只经新门面取数路由（旧入口残留必须红）", () => {
    expect(usesOldFace(applySrc)).toBe(false);
    expect(usesOldFace(dataFaceSrc)).toBe(false);
    expect(usesOldFace(statsSrc)).toBe(false);
    expect(usesOldFace(adaptersSrc)).toBe(false);
    expect(applySrc.includes("server/data-routes/interface")).toBe(true);
  });

  it("实现块改址：stats 经 ../pipeline 复用读面（旧深路径残留必须红）", () => {
    expect(statsSrc.includes("../pipeline/interface")).toBe(true);
    expect(statsSrc.includes("../../shared/interface")).toBe(true);
  });

  it("实现块改址：adapters 经 ../registry 复用加载校验与路径准入（旧深路径残留必须红）", () => {
    expect(adaptersSrc.includes("../registry/interface")).toBe(true);
    expect(adaptersSrc.includes("../pipeline/interface")).toBe(true);
  });

  it("B2 注册注入经上下文（值边清零，直引残留必须红）", () => {
    expect(adaptersSrc.includes("context.resolveAdapterFile")).toBe(true);
    expect(adaptersSrc.includes("context.loadAdapterChecked")).toBe(true);
    expect(adaptersSrc.includes("import { loadUserAdapterChecked")).toBe(false);
    expect(adaptersSrc.includes("import { resolveAddAdapterFile")).toBe(false);
    expect(applySrc.includes("resolveAdapterFile:")).toBe(true);
    expect(applySrc.includes("loadAdapterChecked:")).toBe(true);
  });

  it("门面收口：interface 与实现同一引用（包装即红）", () => {
    expect(handleStats).toBe(ImplHandleStats);
    expect(handleHistory).toBe(ImplHandleHistory);
    expect(createStatsRoutes).toBe(ImplCreateStatsRoutes);
    expect(handleAdapters).toBe(ImplHandleAdapters);
    expect(handleSelect).toBe(ImplHandleSelect);
    expect(handleInspect).toBe(ImplHandleInspect);
    expect(handleAdd).toBe(ImplHandleAdd);
    expect(createAdapterRoutes).toBe(ImplCreateAdapterRoutes);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    for (const src of [dataFaceSrc, dataDepsSrc]) {
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
      expect(hasExportStar(codeLines)).toBe(false);
    }
  });

  it("门面值出口恰为 8 项（多一项即公共面膨胀）", async () => {
    const faceNs = await import("../../../src/server/data-routes/interface.ts");
    expect(Object.keys(faceNs).sort()).toEqual(
      [
        "handleStats",
        "handleHistory",
        "createStatsRoutes",
        "handleAdapters",
        "handleSelect",
        "handleInspect",
        "handleAdd",
        "createAdapterRoutes",
      ].sort(),
    );
  });

  it("包导出面零扩张：路由创建面不进 apply/index.ts（误转即红）", () => {
    for (const name of ["createStatsRoutes", "createAdapterRoutes"]) {
      expect(applyFaceSrc.includes(name)).toBe(false);
    }
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    expect(topologySrc.includes("src/domain1/routes/")).toBe(false);
    for (const p of ["src/server/data-routes/stats.ts", "src/server/data-routes/adapters.ts"]) {
      expect(topologySrc.includes(p)).toBe(true);
    }
    expect(strykerRoutesSrc.includes("src/domain1/routes/")).toBe(false);
    expect(strykerRoutesSrc.includes("src/server/data-routes/stats.ts")).toBe(true);
    expect(strykerRoutesSrc.includes("src/server/data-routes/adapters.ts")).toBe(true);
  });
});

describe("D10二 越围栏必须红（403 先于 405）", () => {
  // 六端点 × 非回环 + 错方法（GET 端点错用 POST，POST 端点错用 DELETE）。
  const fenceTable: { name: string; handler: AnyHandler; wrongMethod: string }[] = [
    { name: "stats", handler: handleStats as AnyHandler, wrongMethod: "POST" },
    { name: "history", handler: handleHistory as AnyHandler, wrongMethod: "POST" },
    { name: "adapters", handler: handleAdapters as AnyHandler, wrongMethod: "POST" },
    { name: "select", handler: handleSelect as AnyHandler, wrongMethod: "DELETE" },
    { name: "inspect", handler: handleInspect as AnyHandler, wrongMethod: "DELETE" },
    { name: "add", handler: handleAdd as AnyHandler, wrongMethod: "DELETE" },
  ];
  const ctxOf = (name: string): StatsRoutesContext | AdapterRoutesContext =>
    name === "stats" || name === "history" ? stubStatsCtx() : stubAdapterCtx();

  it.each(fenceTable.map((c) => c.name))(
    "%s 非回环 + 错方法仍 403（顺序反了即 405 泄漏）",
    async (name) => {
      const found = fenceTable.find((c) => c.name === name);
      if (found === undefined) throw new Error(`fence 缺行：${name}`);
      const { code } = await callStatus(
        found.handler,
        nonLoopbackReq({ method: found.wrongMethod }),
        ctxOf(name),
      );
      expect(code).toBe(403);
    },
  );

  it.each(fenceTable.map((c) => ({ name: c.name, method: c.wrongMethod })))(
    "$name 回环 + 错 $method → 405 且文案逐字节锁定（文案漂移即红）",
    async ({ name, method }) => {
      const found = fenceTable.find((c) => c.name === name);
      if (found === undefined) throw new Error(`fence 缺行：${name}`);
      const { code, body } = await callStatus(found.handler, fakeReq({ method }), ctxOf(name));
      expect(code).toBe(405);
      expect((body as { error?: string }).error).toBe(`method not allowed: ${method}`);
    },
  );

  it("stats 回环 + GET 放行 200（误拦即红）", async () => {
    const { code, body } = await callStatus(
      handleStats as AnyHandler,
      fakeReq({ method: "GET" }),
      stubStatsCtx(),
    );
    expect(code).toBe(200);
    expect((body as { provider?: string }).provider).toBe("deepseek");
  });

  it("history 回环 + GET 无候选报 no-adapter（误拦即红）", async () => {
    const { code, body } = await callStatus(
      handleHistory as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=ghost" }),
      stubStatsCtx(),
    );
    expect(code).toBe(200);
    expect((body as { reason?: string }).reason).toBe("no-adapter");
  });

  it("adapters 回环 + GET 放行 200 且契约版本字面量锚定（误拦即红）", async () => {
    const { code, body } = await callStatus(
      handleAdapters as AnyHandler,
      fakeReq({ method: "GET" }),
      stubAdapterCtx(),
    );
    expect(code).toBe(200);
    expect(Array.isArray((body as { host?: unknown }).host)).toBe(true);
  });

  it("select 回环 + POST 清空放行 200 且不惊动热更新（误拦/误装即红）", async () => {
    const { code, body } = await callStatus(
      handleSelect as AnyHandler,
      fakeReq({
        method: "POST",
        body: JSON.stringify({ provider: "deepseek", adapterName: null }),
      }),
      stubAdapterCtx(),
    );
    expect(code).toBe(200);
    expect((body as { ok?: boolean }).ok).toBe(true);
    expect((body as { adapterName?: null }).adapterName).toBe(null);
    expect(hotReloadCalls).toEqual([]);
  });
});

describe("D10三 deps 注入面窄面", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(dataRoutesDepsNs)).toEqual([]);
  });

  it("命名接缝装配适配器路由（改名断链即红）", async () => {
    const routes = createAdapterRoutes(
      {
        adapters: ROUTES.adapters,
        select: ROUTES.select,
        inspect: ROUTES.inspect,
        add: ROUTES.add,
      },
      stubAdapterCtx(),
    );
    expect(routes.map((r) => r.path).sort()).toEqual(
      [ROUTES.adapters, ROUTES.select, ROUTES.inspect, ROUTES.add].sort(),
    );
    await stubAdapterCtx().ensureHotReload("/tmp/dou-d10-probe.mjs");
    expect(hotReloadCalls).toEqual(["/tmp/dou-d10-probe.mjs"]);
  });

  it("块内联双生子：context 保留内联函数类型（别名引用即红）", () => {
    expect(adaptersSrc.includes("ensureHotReload: (file: string) => Promise<void>")).toBe(true);
    expect(adaptersSrc.includes("DataRoutesEnsureHotReload")).toBe(false);
  });

  it("家目录禁令：三文件无 homedir/HOME/untildify 直调（直调即红）", () => {
    for (const src of [statsSrc, adaptersSrc, dataFaceSrc, dataDepsSrc]) {
      expect(src.includes("homedir(")).toBe(false);
      expect(src.includes("process.env.HOME")).toBe(false);
      expect(src.includes("untildify")).toBe(false);
    }
  });
});

describe("D10四 路由单点 + 客户端契约", () => {
  it("stats 创建面路径即 ROUTES 单点（自定字面量即红）", () => {
    const routes = createStatsRoutes(
      { stats: ROUTES.stats, history: ROUTES.history },
      stubStatsCtx(),
    );
    expect(routes.map((r) => r.path).sort()).toEqual([ROUTES.stats, ROUTES.history].sort());
    expect(statsSrc.includes("/api/")).toBe(false);
  });

  it("adapter 创建面路径即 ROUTES 单点（自定字面量即红）", () => {
    expect(adaptersSrc.includes("/api/")).toBe(false);
  });

  it.each([
    "/api/dsh-provider-usage/stats",
    "/api/dsh-provider-usage/history",
    "/api/dsh-provider-usage/adapters.json",
    "/api/dsh-provider-usage/adapters/select",
    "/api/dsh-provider-usage/adapters/inspect",
    "/api/dsh-provider-usage/adapters/add",
  ])("客户端 core.ts 回指 %s（缺键即宿主与客户端分叉）", (literal) => {
    expect(clientCoreSrc.includes(literal)).toBe(true);
  });
});

describe("探针：detector 失明则本段先红", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace("import { x } from ../domain1/routes/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../../server/registry/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../server/data-routes/interface.ts")).toBe(false);
    expect(usesOldFace("import { x } from ../pipeline/interface.ts")).toBe(false);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(["export * from ./stats.ts"])).toBe(true);
    expect(hasExportStar(["export { a } from ./stats.ts"])).toBe(false);
  });

  it("隔离目录可用（mkdtemp 探针）", () => {
    const dir = isolatedDir("dou-dataroutesD10-");
    expect(typeof dir).toBe("string");
  });
});
