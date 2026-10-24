/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNoGrowth, pollUntil } from "../helpers.ts";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import {
  loaderScript,
  makeManager,
  makeTempDir,
  managerFixture,
  McpStore,
  normalizeServer,
  quietServer,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

function regression616() {
  const { dir, manager, store } = managerFixture("dsh-mcp-mgr2x-");
  const projRoot = join(dir, "proj");
  mkdirSync(projRoot, { recursive: true });
  const projStore = new McpStore(join(projRoot, ".dsh", "mcp.json"));
  projStore.data = {
    version: 1,
    servers: [normalizeServer(quietServer("p1")), normalizeServer(quietServer("p2"))],
  };
  manager.projectStores.set(projRoot, projStore);
  manager.projectRoot = projRoot;
  manager.projectStore = projStore;

  // stub 中间层：项目单元已建且 p1/p2 均已 connected（模拟稳定运行态），
  // teardownUnit 必须零调用（回归红线：reconcile 有任何拆毁即判红）。
  const teardownRoots: string[] = [];
  // 调用记录：元组与裸标记混记（"reconcile" 裸串），读侧按位置收窄。
  // 调用记录：元组与裸标记（"reconcile"）混记，读侧按位置收窄。
  const calls614: Array<unknown[] | string> = [];
  const mkUnit = (root: string) => ({
    root,
    connections: new Map([
      ["p1", { server: projStore.find("p1"), status: "connected" }],
      ["p2", { server: projStore.find("p2"), status: "connected" }],
    ]),
    catalog: new Map(),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  });
  const fakeMw = {
    units: new Map([[projRoot, mkUnit(projRoot)]]),
    projectUnitFor: async (root: string) => {
      calls614.push(["projectUnitFor", root]);
      return (
        fakeMw.units.get(root) ??
        (() => {
          const unit = mkUnit(root);
          fakeMw.units.set(root, unit);
          return unit;
        })()
      );
    },
    ensureConnected: async (root: string, name: string, opts: unknown) => {
      calls614.push(["ensureConnected", root, name, opts]);
      const unit = fakeMw.units.get(root);
      if (unit !== undefined && !unit.connections.has(name)) {
        unit.connections.set(name, { server: projStore.find(name), status: "connected" });
      }
      return opts;
    },
    teardownUnit: (root: string) => teardownRoots.push(root),
    // 部分中间层桩（teardown 回归面）：按接缝收窄。
  };
  manager.middleware = fakeMw as unknown as McpManagerType["middleware"];
  return { manager, store, projRoot, projStore, fakeMw, teardownRoots, calls614 };
}

/** 全局配置加一台 g1：reconcile 会因 supervisor 集合变化走 start("g1")。 */
async function afterReconcile() {
  const fixture = regression616();
  // 关键断言：项目单元 connections 保持、teardownUnit 零调用（修复前此处把
  // 项目单元整个拆毁且无人重建）。
  fixture.store.upsert(normalizeServer(quietServer("g1")));
  fixture.manager.reconcileServers();
  await pollUntil(
    "all 模式全局 g1 经池接管连接",
    () => fixture.fakeMw.units.get("@global")?.connections.has("g1") === true,
  );
  return fixture;
}
setupManagerTestLifecycle();
describe("#616 reconcile / start(项目级) / refreshFromDisk 不拆毁中间层项目单元", () => {
  it("reconcile 零拆毁（#616 回归红线）", async () => {
    const { teardownRoots } = await afterReconcile();
    expect(teardownRoots.length).toBe(0);
  });

  it("项目级 p1 连接保持", async () => {
    const { fakeMw, projRoot } = await afterReconcile();
    expect(fakeMw.units.get(projRoot)!.connections.get("p1")?.status).toBe("connected");
  });

  it("项目级 p2 连接保持", async () => {
    const { fakeMw, projRoot } = await afterReconcile();
    expect(fakeMw.units.get(projRoot)!.connections.get("p2")?.status).toBe("connected");
  });

  it("配置无变化 refreshFromDisk 早退、不 reconcile", async () => {
    const { manager, calls614 } = await afterReconcile();
    // refreshFromDisk 早退：配置无变化时不再 reconcile（消除 user-state 写盘
    // 误触发 reconcile 的放大器；reconcileBusy 置位可探测是否被调用）。
    calls614.length = 0;
    manager.reconcileServers = () => {
      calls614.push("reconcile");
      return false;
    };
    await manager.refreshFromDisk();
    expect(calls614.length).toBe(0);
  });

  it("start(项目级) 幂等触达零拆毁", async () => {
    // start(项目级) 幂等触达：不拆单元、对该服务器 ensureConnected（无 force）。
    const { manager, projRoot, calls614, teardownRoots } = await afterReconcile();
    calls614.length = 0;
    manager.start("p1", "project");
    await pollUntil("start(项目级) 幂等触达完成", () =>
      calls614.some((c) => c[0] === "ensureConnected" && c[1] === projRoot && c[2] === "p1"),
    );
    expect(teardownRoots.length).toBe(0);
  });

  it("幂等触达不带 force（connected 短路语义）", async () => {
    const { manager, calls614 } = await afterReconcile();
    calls614.length = 0;
    manager.start("p1", "project");
    await pollUntil("start(项目级) 幂等触达完成", () =>
      calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p1"),
    );
    // opts 为透传未知形状：只读 force 面。
    expect(
      calls614.every(
        (c) => c[0] !== "ensureConnected" || (c[3] as { force?: unknown })?.force !== true,
      ),
    ).toBeTruthy();
  });

  it("配置漂移 force 重建仍零拆毁（单台重建不殃及单元）", async () => {
    // start(项目级) 配置漂移：entry.server 与 store 当前配置不一致 → force 单台
    // 重建（保留手工编辑 mcp.json 热生效语义，评审 P1-2 补测）。
    const { manager, projStore, calls614, teardownRoots } = await afterReconcile();
    calls614.length = 0;
    projStore.data.servers[0] = normalizeServer(quietServer("p1", { command: "dsh-noop-cmd-v2" }));
    manager.start("p1", "project");
    await pollUntil("配置漂移 force 重建完成", () =>
      calls614.some(
        (c) =>
          c[0] === "ensureConnected" &&
          c[2] === "p1" &&
          (c[3] as { force?: unknown })?.force === true,
      ),
    );
    expect(teardownRoots.length).toBe(0);
  });

  it("userDisabled 命中不连接", async () => {
    // start(项目级) userDisabled 命中：不触发 ensureConnected（浮窗断开语义）。
    const { manager, projRoot, calls614, fakeMw } = await afterReconcile();
    calls614.length = 0;
    fakeMw.units.get(projRoot)!.userDisabled.add("p2");
    manager.start("p2", "project");
    await pollUntil("projectUnitFor 触达完成", () =>
      calls614.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot),
    );
    // 反向验证：userDisabled 命中后稳定不连接（观察窗口内持续断言，替代固定 sleep）
    await assertNoGrowth(
      "userDisabled命中不连接",
      () => calls614.filter((c) => c[0] === "ensureConnected" && c[2] === "p2").length,
      0,
    );
    expect(!calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p2")).toBeTruthy();
  });
});

describe("#392 遗留③：disconnect 显式 scope 定位", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2m-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const projectConnect = async () => {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    // #392 遗留③：disconnect 显式 scope=project 定位项目单元，不误写 @global 单元。
    // 构造：全局 store 与项目 store 同名 "dup"（项目级由中间层项目单元接管）。
    store.upsert(normalizeServer(quietServer("dup")));
    // @global 单元须先存在（原脚本由更早的全局 start 触达建立），否则「不误写
    // @global」断言无对象可查。
    await mw.projectUnitFor("@global");
    const proj = join(homeDir, "proj");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "dup", transport: "stdio", command: "dcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    await manager.connect("dup", "project");
    // connect 刚建项目单元，此处断言存在。
    const projUnit = mw.units.get(proj)!;
    return { manager, mw, proj, projUnit };
  };

  it("项目单元已创建", async () => {
    const { projUnit } = await projectConnect();
    expect(projUnit).toBeTruthy();
  });

  it("scope=project 断开写项目单元", async () => {
    // 项目级 disconnect：显式 scope=project → 写项目单元 userDisabled（此前无 scope
    // 时 all 模式全局同名会把项目级 disconnect 错定位 @global）。
    const { manager, projUnit } = await projectConnect();
    await manager.disconnect("dup", "project");
    expect(projUnit.userDisabled.has("dup")).toBeTruthy();
  });

  it("不误写 @global 单元（#392 同名跨 scope 修正）", async () => {
    const { manager, mw } = await projectConnect();
    await manager.disconnect("dup", "project");
    expect(mw.units.get("@global")!.userDisabled.has("dup")).toBe(false);
  });

  it("reconnect(scope=project) 不误写 @global 单元（S1）", async () => {
    // #392 遗留③（S1 复核）：reconnect 透传 scope——项目级 reconnect 不再误写 @global。
    // 此前 reconnect 内部 disconnect(name) 不带 scope，all 模式 + 全局同名时项目级
    // reconnect 会把全局同名服务器误写进 @global userDisabled 并持久化。
    const { manager, mw } = await projectConnect();
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    expect(mw.units.get("@global")!.userDisabled.has("dup")).toBe(false);
  });

  it("reconnect 后项目单元 userDisabled 已解除", async () => {
    const { manager, projUnit } = await projectConnect();
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    expect(projUnit.userDisabled.has("dup")).toBe(false);
  });

  it("scope=global 断开写 @global 单元", async () => {
    // 全局 disconnect 显式 scope=global → 写 @global 单元。
    const { manager, mw } = await projectConnect();
    await manager.connect("dup", "global");
    await manager.disconnect("dup", "global");
    expect(mw.units.get("@global")!.userDisabled.has("dup")).toBeTruthy();
  });
});

// 拆除时在途建连的 in-flight 残留（跨平台确定性回归：Windows 必现） ----
// 「attempt 在途」改由假 loader 的 deferred ready 撑：装载窗口按在窗口内不自行结算，
// 不再 spawn 真子进程（离线纪律）。此前 remove/disconnect 强拆 entry 后不同步废弃
// inFlight 去重标记，同名后续 ensureConnected（含 force 的显式「连接」）被残留标记
// 吞掉，且旧 attempt 收敛命中 disposed 守卫无人补连——修复前本块必红。
describe("拆除时在途建连的 in-flight 残留", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2n-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** 挂起型服务器：命令永不执行（假 loader 不 spawn），挂起完全由装载窗口的 ready 时序撑。 */
  const hangServer = (name: string) => quietServer(name);

  async function allModeFixture() {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    // 装载窗口按在 deferred：attempt 一直 pending，直到本用例收口时放闸。
    loaderScript.ready = "deferred";
    // 池由 initMiddleware 刚建，此处断言存在。
    return { manager, store, mw: manager.middleware! };
  }

  it("remove 后重加立即重建连接条目（in-flight 残留已废弃）", async () => {
    const { manager, store, mw } = await allModeFixture();
    // remove 路径：connecting 中强拆 + 重加，连接条目须立即重建。
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "hang 连接条目建立（connecting）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    await manager.remove("hang");
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "remove 后重加立即重建连接条目（in-flight 残留已废弃）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    expect(mw.units.get("@global")?.connections.has("hang")).toBe(true);
  });

  it("disconnect 写 userDisabled", async () => {
    const { manager, store, mw } = await allModeFixture();
    // disconnect 路径：connecting 中断开 + 显式「连接」，force 建连不被去重吞掉。
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "hang 连接条目建立（connecting）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    await manager.disconnect("hang", "global");
    expect(mw.units.get("@global")!.userDisabled.has("hang")).toBeTruthy();
  });

  it("disconnect 后显式连接立即重建条目", { timeout: 30_000 }, async () => {
    const { manager, store, mw } = await allModeFixture();
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "hang 连接条目建立（connecting）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    await manager.disconnect("hang", "global");
    await manager.connect("hang", "global");
    await pollUntil(
      "disconnect 后显式连接立即重建条目",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    expect(mw.units.get("@global")?.connections.has("hang")).toBe(true);
  });
});
