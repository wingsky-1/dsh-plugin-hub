/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { FakeToolEntry } from "../helpers.ts";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";

import type { ConnectionEntry } from "../../src/server/connection/runtime/interface.ts";

import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  managerFixture,
  McpStore,
  MIDDLEWARE_GLOBAL_ROOT,
  normalizeServer,
  quietServer,
  setupManagerTestLifecycle,
  summarizeOf,
  summaryView,
} from "./manager-shape-support.ts";

// 池条目的态不再由测试手改 entry.status：summarize 经 statusOf 读时刷新（裁定 U），输入面是
// 「配置 + 账本句柄 + 注册面前缀」。夹具因此按新 ConnectionEntry 造，并让注册面携带该 id 前缀
// ——换引擎后「已连上」只有这一条正向证据（官方不暴露状态 API）。
const POOL_ID = "id-p1";

// 部分连接条目桩（被测读面：id/status/server；everConnected/disposed 为本文件判据自备的探测字段，
// 域形状外）：调用方只读域内面，收窄不断言。
const connectedEntry = (name = "p1", id = POOL_ID): ConnectionEntry =>
  ({
    server: { name, transport: "stdio", command: "pcmd", enabled: true },
    id,
    handle: { disposed: false },
    status: "connected",
    error: undefined,
    connectedAt: Date.now(),
    readySettled: true,
    everConnected: true,
    disposed: false,
  }) as unknown as ConnectionEntry;

async function projectionBase() {
  const { dir, manager, store } = managerFixture("dsh-mcp-mgr2mw-");
  const proj = join(dir, "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(proj, ".dsh"), { recursive: true });
  writeFileSync(
    join(proj, ".dsh", "mcp.json"),
    JSON.stringify({
      version: 1,
      servers: [{ name: "p1", transport: "stdio", command: "pcmd", enabled: true }],
    }),
  );
  // 先切中间层模式再 setSession（off 语义的 setSession 会 reconcile 启动
  // 项目级真 supervisor 并异步重连，污染后续兜底投影断言）。
  await manager.setSession(proj);
  await manager.initMiddleware();
  // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
  const mw = manager.middleware!;
  // 预置 userDisabled（initMiddleware 会以磁盘加载结果覆盖 disabledByRoot，
  // 故必须在其后设置）：单元创建即合并，惰性 ensureConnected 直接短路——
  // 连接条目完全由本测试手工注入，杜绝 spawn 真进程与后台重连污染。
  mw.disabledByRoot.set(proj, new Set(["p1"]));
  // projectUnitFor 刚建单元，此处断言存在。
  const unit = (await mw.projectUnitFor(proj))!;
  // 这条禁用只为短路惰性建连；条目改由本测试手工注入，要按真实运行态投影，故立即撤回。
  unit.userDisabled.delete("p1");
  // 注册面携带该 id 前缀 = 「已连上」；不带它 statusOf 会如实投影成 failed / reconnecting。
  // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
  (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
    { name: `mcp__${POOL_ID}__t1` },
  ];
  // 注入连接池条目 + 目录缓存（模拟已握手成功，不派官方实例）。
  unit.connections.set("p1", connectedEntry());
  catalogDirectory.projectWrappedTools({
    root: proj,
    serverName: "p1",
    definitions: [
      { name: "t1", description: "d1", parameters: {} },
      { name: "t2", description: "", parameters: {} },
    ],
  });
  // 手工注入的条目恒存在，此处断言存在。
  return { dir, manager, store, proj, mw, unit, entry: unit.connections.get("p1")! };
}

async function unavailableBase() {
  const fixture = await projectionBase();
  // connected（投影输入面不变：readySettled / everConnected / 注册面前缀都在）+ 目录发现失败
  // （unavailable）→ 0 工具且透出原因到 error。
  catalogDirectory.markUnavailable(fixture.proj, "p1", "discovery timed out");
  return fixture;
}

async function stoppedBase() {
  const fixture = await projectionBase();
  // userDisabled（手动断开，无连接条目）→ 落回兜底：无 supervisor → stopped。
  // （不做 userDisabled 短路：见 summarize 注释——all 模式 supervisor 复活场景
  // 若短路会把实际已连接反向投影成 stopped。）
  fixture.unit.connections.delete("p1");
  fixture.unit.userDisabled.add("p1");
  return fixture;
}

async function globalScopeBase() {
  const fixture = await projectionBase();
  // 单池（#767 笔 1a）：全局服务器同样从 @global 单元投影（没有「project 模式走直连」这条分支）。
  fixture.store.upsert(normalizeServer(quietServer("g1")));
  (fixture.manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
    { name: `mcp__${POOL_ID}__t1` },
    { name: "mcp__id-g1__gt" },
  ];
  catalogDirectory.projectWrappedTools({
    root: MIDDLEWARE_GLOBAL_ROOT,
    serverName: "g1",
    definitions: [{ name: "gt", description: "", parameters: {} }],
  });
  fixture.mw.units.set(MIDDLEWARE_GLOBAL_ROOT, {
    root: MIDDLEWARE_GLOBAL_ROOT,
    connections: new Map([["g1", connectedEntry("g1", "id-g1")]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  });
  return fixture;
}

async function allModeBase() {
  const fixture = await projectionBase();
  // 项目单元（p1）与 @global 单元（g1）并存：单池后两者各按 scope 投影，互不串台。
  fixture.store.upsert(normalizeServer(quietServer("g1")));
  (fixture.manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
    { name: `mcp__${POOL_ID}__t1` },
    { name: "mcp__id-g1__gt" },
  ];
  catalogDirectory.projectWrappedTools({
    root: MIDDLEWARE_GLOBAL_ROOT,
    serverName: "g1",
    definitions: [{ name: "gt", description: "", parameters: {} }],
  });
  fixture.mw.units.set(MIDDLEWARE_GLOBAL_ROOT, {
    root: MIDDLEWARE_GLOBAL_ROOT,
    connections: new Map([["g1", connectedEntry("g1", "id-g1")]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  });
  return fixture;
}

async function disabledProjectionBase() {
  const fixture = await allModeBase();
  // 断开语义（#382 F4）：池内条目被拆 + userDisabled → summarize 落兜底 stopped。
  // 单池后不存在「直连账本残留」这条会误显示连接态的分支。
  // 刚建的 @global 单元恒存在，此处断言存在。
  const globalUnit = fixture.mw.units.get(MIDDLEWARE_GLOBAL_ROOT)!;
  globalUnit.connections.delete("g1");
  globalUnit.userDisabled.add("g1");
  return fixture;
}
function registerProjectSummary() {
  it("项目级 server 在 summary 中", async () => {
    // 回归盲区主断言（#228 维护者实测补充验收）：中间层 connected →
    // summary 显示 connected、tools 从 catalog 缓存填充出**非空列表**且与
    // 目录一致（此前 summarize 只读 supervisors，项目级恒 stopped / 空数组，
    // 而 ws_mcp_search 实测目录有货）。
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(p1 !== undefined).toBeTruthy();
  });

  it("p1.scope 为 project", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(p1.scope).toBe("project");
  });

  it("p1.status 为 connected", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(p1.status).toBe("connected");
  });

  it("summary.tools 非空（catalog 有货不得返回空数组）", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(Array.isArray(p1.tools) && p1.tools.length > 0).toBeTruthy();
  });

  it("summary.tools 与 catalog 目录一致", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    // tools 恒为数组（投影构造保证），此处断言存在。
    expect([...p1.tools!].sort()).toEqual(["t1", "t2"]);
  });

  it("sum.counts.connected 为 1", async () => {
    const { manager } = await projectionBase();
    expect(summaryView(manager).counts.connected).toBe(1);
  });
}
function registerConnectionFailureProjection() {
  // 状态不再靠手改 entry.status 伪造：投影输入换成「注册面前缀 + readySettled + everConnected」。
  it("failed 态：error 详情投影（浮窗红字展示来源）", async () => {
    const { manager, entry } = await projectionBase();
    // 首连就没成功（注册面无该前缀、everConnected 为假）→ failed，error 透出官方判词。
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [];
    entry.everConnected = false;
    entry.error = new Error("官方装载失败：连接超时");
    const failed = summarizeOf(manager, manager.projectStore!.find("p1")!, "project");
    expect(failed.status).toBe("failed");
  });

  it("failed 态：error 文案投影", async () => {
    const { manager, entry } = await projectionBase();
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [];
    entry.everConnected = false;
    entry.error = new Error("官方装载失败：连接超时");
    const failed = summarizeOf(manager, manager.projectStore!.find("p1")!, "project");
    expect(failed.error).toBe("官方装载失败：连接超时");
  });

  it("connecting 态投影", async () => {
    const { manager, entry } = await projectionBase();
    // 装载等待窗口未结算（readySettled 为假）→ connecting 纯属我方动作面。
    entry.readySettled = false;
    entry.error = undefined;
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "connecting",
    );
  });
}
function registerUnavailableProjection() {
  it("unavailable → status connected", async () => {
    const { manager } = await unavailableBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "connected",
    );
  });

  it("unavailable → tools 为空", async () => {
    const { manager } = await unavailableBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").tools).toEqual([]);
  });

  it("unavailable reason 透出到 error", async () => {
    const { manager } = await unavailableBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").error).toBe(
      "discovery timed out",
    );
  });
}
function registerStoppedProjection() {
  it("userDisabled 无连接条目 → stopped", async () => {
    const { manager } = await stoppedBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "stopped",
    );
  });

  it("userDisabled → tools 为空", async () => {
    const { manager } = await stoppedBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").tools).toEqual([]);
  });

  it("userDisabled → error undefined", async () => {
    const { manager } = await stoppedBase();
    expect(
      summarizeOf(manager, manager.projectStore!.find("p1")!, "project").error,
    ).toBeUndefined();
  });
}
function registerScopedProjection() {
  it("全局 scope 经 @global 单元投影（status connected）", async () => {
    const { manager, store } = await globalScopeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("connected");
  });

  it("全局 scope tools 来自 @global 目录投影", async () => {
    const { manager, store } = await globalScopeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual(["gt"]);
  });

  it("项目单元与 @global 单元并存时各按 scope 投影", async () => {
    const { manager, store } = await allModeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("connected");
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "connected",
    );
  });

  it("同 scope 各自 tools（全局取 @global 目录，项目取项目目录）", async () => {
    const { manager, store } = await allModeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual(["gt"]);
    expect(
      [...summarizeOf(manager, manager.projectStore!.find("p1")!, "project").tools].sort(),
    ).toEqual(["t1", "t2"]);
  });
}
function registerDisabledProjection() {
  it("userDisabled 短路（#382：池接管后断开即 stopped）", async () => {
    const { manager, store } = await disabledProjectionBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("stopped");
  });

  it("userDisabled 短路 → tools 为空", async () => {
    const { manager, store } = await disabledProjectionBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual([]);
  });

  it("#413：runtime 注入条目同样只经池投影（@global 单元，断开即 stopped）", async () => {
    // #413：runtime 注入条目与 store 全局同口径（同一本池账），不因注入来源而豁免。
    const { manager, store } = await disabledProjectionBase();
    manager.runtimeRegistry.set("g1", store.find("g1")!);
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("stopped");
  });

  it("#413 runtime 投影 → tools 为空", async () => {
    const { manager, store } = await disabledProjectionBase();
    manager.runtimeRegistry.set("g1", store.find("g1")!);
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual([]);
  });

  it("条目不在池里 → 兜底 stopped（不谎报 connected）", async () => {
    const { manager, store } = await disabledProjectionBase();
    // 既拆条目又清 userDisabled：兜底分支的唯一输入就是「不在池里」。
    manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)!.userDisabled.delete("g1");
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("stopped");
  });
}
setupManagerTestLifecycle();

// summary / summarize / dispose ----
describe("summary", () => {
  function summaryFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    return { manager, store };
  }

  it("servers 列表长度 2", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).servers.length).toBe(2);
  });

  it("counts.connected 为 0", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).counts.connected).toBe(0);
  });

  it("counts.disabled 为 1", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).counts.disabled).toBe(1);
  });

  it("cwd 为 undefined", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).cwd).toBeUndefined();
  });
});

describe("summarize", () => {
  function summarizeFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    // 单池（#767 笔 1a）：summarize 只从连接池单元投影（旧直连账本分支已退役）。
    // 这里挂最小池替身：statusOf 给态（真投影语义由中间层自己的用例钉住），目录读口给工具面。
    // 只实现 summarize 触达的 units/statusOf/toolCountOf：按接缝收窄。
    manager.middleware = {
      units: new Map([
        [
          "@global",
          {
            root: "@global",
            connections: new Map([
              [
                "s-on",
                {
                  server: store.find("s-on"),
                  id: "id-on",
                  handle: { disposed: false },
                  status: "failed",
                  error: new Error("boom"),
                  connectedAt: Date.now(),
                  readySettled: false,
                  everConnected: false,
                  disposed: false,
                },
              ],
            ]),
            userDisabled: new Set(),
            lastTouchedAt: Date.now(),
            inFlight: new Map(),
          },
        ],
      ]),
      statusOf: () => "failed",
      toolCountOf: () => 1,
    } as unknown as McpManagerType["middleware"];
    catalogDirectory.projectWrappedTools({
      root: "@global",
      serverName: "s-on",
      definitions: [{ name: "t", description: "d", parameters: {} }],
    });
    return { manager, store };
  }

  it("entryOn.status 为 failed", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").status).toBe("failed");
  });

  it("entryOn.error 为字符串文案", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").error).toBe("boom");
  });

  it("entryOn.tools 透传", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").tools).toEqual(["t"]);
  });

  it("entryOn.scope 透传", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").scope).toBe("global");
  });

  it("entryOff.status 为 disabled", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-off")!, "global").status).toBe("disabled");
  });

  it("entryOff.tools 为空", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-off")!, "global").tools).toEqual([]);
  });

  it("entryOff.error 为 undefined", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-off")!, "global").error).toBeUndefined();
  });

  it("不在池里且启用 → stopped", () => {
    const { manager, store } = summarizeFixture();
    manager.middleware!.units.get("@global")!.connections.delete("s-on");
    expect(summarizeOf(manager, store.find("s-on")!, "global").status).toBe("stopped");
  });
});
describe("中间层模式 summary 投影（#228）", () => {
  registerProjectSummary();
  registerConnectionFailureProjection();
  registerUnavailableProjection();
  registerStoppedProjection();
  registerScopedProjection();
  registerDisabledProjection();
});

// B19 红测：summarize 禁用查询合并判定（@global ∪ projectRoot） ----
describe("B19 红测：summarize 合并禁用集", () => {
  it("B19：项目级条目合并 @global 与 projectRoot 禁用集（只取其一 → 红测）", async () => {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2b19-");
    const srv = normalizeServer(quietServer("g1"));
    const proj = join(dir, "proj");
    manager.projectRoot = proj;
    manager.projectStore = new McpStore(join(proj, "mcp.json"));
    manager.projectStore!.data.servers = [srv];
    manager.projectStores.set(proj, manager.projectStore!);
    const mw = await manager.initMiddleware();
    manager.disabledTools.set(MIDDLEWARE_GLOBAL_ROOT, new Map([["g1", new Set(["toolA"])]]));
    manager.disabledTools.set(proj, new Map([["g1", new Set(["toolB"])]]));
    // 目录（裸名工具面）与池条目：项目级条目的禁用查询必须**合并**项目 root 与 @global 两个集合。
    catalogDirectory.projectWrappedTools({
      root: proj,
      serverName: "g1",
      definitions: [
        { name: "toolA", description: "", parameters: {} },
        { name: "toolB", description: "", parameters: {} },
      ],
    });
    mw.units.set(proj, {
      root: proj,
      connections: new Map([
        [
          "g1",
          {
            server: srv,
            id: "id-g1",
            handle: { disposed: false },
            status: "connected",
            error: undefined,
            connectedAt: Date.now(),
            readySettled: true,
            everConnected: true,
            disposed: false,
          },
        ],
      ]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
      // 部分单元桩（status 字面量与探测字段超出域形状）：调用方只读域内面，收窄不断言。
    } as unknown as ProjectUnit);
    const s = summarizeOf(manager, srv, "project");
    expect([...(s.disabledTools ?? [])].sort()).toEqual(["toolA", "toolB"]);
  });
});
