/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdirSync, realpathSync } from "node:fs";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import {
  makeManager,
  makeTempDir,
  managerFixture,
  McpStore,
  MIDDLEWARE_GLOBAL_ROOT,
  normalizeServer,
  poolLoader,
  quietServer,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

setupManagerTestLifecycle();

// #382 F2/F3/F4/F5：runtime 回退重连 + all 模式池接管 + 防双进程探测重试 ----
describe("#382 F2：runtime 回退重连", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  it("runtime 条目 reconnect 复活（F2 回退 runtimeRegistry）", async () => {
    const { manager } = makeManager(homeDir);
    await manager.initMiddleware();
    // F2：runtime 注入条目（不落 store）——reconnect 不再抛 not found，
    // 断开后按 runtimeRegistry 配置经 @global 单元复活（单池后唯一连接路径）。
    manager.runtimeRegistry.set("rt", normalizeServer(quietServer("rt")));
    await manager.reconnect("rt");
    expect(manager.middleware!.units.get("@global")!.connections.has("rt")).toBeTruthy();
  });

  it("F2 否定：project scope 不回退 runtime → not found", async () => {
    const { manager } = makeManager(homeDir);
    manager.runtimeRegistry.set("rt", normalizeServer(quietServer("rt")));
    // F2 否定：project scope 不回退 runtime（挂错 scope 会被下次 reconcile
    // 无声停掉）——runtime 条目按 project 查询照旧抛 not found。
    manager.projectStore = new McpStore(join(homeDir, "p.json"));
    await manager.projectStore.load();
    await expect(manager.connect("rt", "project")).rejects.toThrow(/not found/);
  });
});

describe("#382 F3/F4：all 模式池接管", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  async function allModeStarted() {
    const { manager, store, log } = makeManager(homeDir);
    // 单池（#767 笔 1a）：start 全局一律触达 @global 单元惰性连接，不注册 mcp__ 直呼工具。
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("g2")));
    manager.start("g2", "global");
    return { manager, store, log };
  }

  it("全局 start 后不存在第二本账（直连账本字段已整体退役）", async () => {
    const { manager } = await allModeStarted();
    expect("supervisors" in manager, "supervisors 字段已删").toBe(false);
  });

  it("不注册 mcp__ 前缀工具", async () => {
    const { log } = await allModeStarted();
    expect(log.registered.filter((name) => String(name).startsWith("mcp__g2__")).length).toBe(0);
  });

  it("@global 单元连接条目建立", async () => {
    const { manager } = await allModeStarted();
    await pollUntil(
      "@global 单元连接条目建立",
      () => manager.middleware!.units.get("@global")?.connections.has("g2") === true,
    );
    expect(manager.middleware!.units.get("@global")?.connections.has("g2")).toBe(true);
  });

  it("connect 走池：条目仍在 @global 单元且只有一条（无第二本账）", async () => {
    const { manager } = await allModeStarted();
    await pollUntil(
      "@global 单元连接条目建立",
      () => manager.middleware!.units.get("@global")?.connections.has("g2") === true,
    );
    // F4：connect 全局走池（userDisabled 解除 + ensureConnected 受控重建）。
    manager.middleware!.units.get("@global")!.userDisabled.add("g2");
    await manager.connect("g2");
    expect(manager.middleware!.units.get("@global")!.connections.has("g2")).toBe(true);
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(1);
  });

  it("userDisabled 已解除", async () => {
    const { manager } = await allModeStarted();
    await pollUntil(
      "@global 单元连接条目建立",
      () => manager.middleware!.units.get("@global")?.connections.has("g2") === true,
    );
    manager.middleware!.units.get("@global")!.userDisabled.add("g2");
    await manager.connect("g2");
    expect(manager.middleware!.units.get("@global")!.userDisabled.has("g2")).toBe(false);
  });
});

// #382 F5「防双进程探测重试」整段删除：换引擎后「同名服务器只能有一个实例」由官方 serverName 在
// 应用根上的活体预留承担（同 id 二次挂载当场抛，实测 §2.9-16），我方不再需要探测 + 一次性重试，
// probeRetried / reconnectTimer / scheduleProbeRetry 已随实现删除——这三例的断言对象不存在了。
// 其中第三例顺带守的「ensureConnected 对 userDisabled 短路」判据仍然成立（实现里的早返回），
// 故就地按新链路重建：驱动换成池的真 ensureConnected，观测点换成「条目没建、官方实例没挂」。
describe("#382 F5 删除后的等价判据：userDisabled 短路不装载", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  it("userDisabled 命中 → 不建连接条目、不挂官方实例（短路在装载之前）", async () => {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("g3")));
    // initMiddleware 刚建池、projectUnitFor 刚建单元（同一用例流），此处断言存在。
    const mw = manager.middleware!;
    mw.disabledByRoot.set("@global", new Set(["g3"]));
    const unit = (await mw.projectUnitFor("@global"))!;
    await mw.ensureConnected("@global", "g3");
    expect(unit.userDisabled.has("g3")).toBe(true);
    expect(unit.connections.has("g3")).toBe(false);
    expect(poolLoader!.calls.filter((call) => call[0] === "mount")).toHaveLength(0);
  });
});

// #1120：resumeReconnect 非强制可用性恢复（单元缺失 / entry 缺失场景） ----
describe("#1120 resumeReconnect 非强制可用性恢复", () => {
  function resumeFixture() {
    const { dir, manager, log } = managerFixture("dsh-mcp-mgr2r-");
    const projRoot = join(dir, "proj");
    mkdirSync(projRoot, { recursive: true });
    const projStore = new McpStore(join(projRoot, ".dsh", "mcp.json"));
    // 内存态配置（不落盘）：p1 启用、p2 禁用、p3 启用。
    projStore.data = {
      version: 1,
      servers: [
        normalizeServer(quietServer("p1")),
        normalizeServer(quietServer("p2", { enabled: false })),
        normalizeServer(quietServer("p3")),
      ],
    };
    manager.projectStores.set(projRoot, projStore);
    manager.projectRoot = projRoot;

    // stub 中间层：units 为空（模拟宿主重启后单元/entry 全清），记录调用面。
    const calls: Array<[string, ...unknown[]]> = [];
    const fakeMw = {
      units: new Map(),
      projectUnitFor: async (root: string) => {
        const unit = {
          root,
          connections: new Map(),
          catalog: new Map(),
          userDisabled: new Set(),
          lastTouchedAt: Date.now(),
          inFlight: new Map(),
        };
        fakeMw.units.set(root, unit);
        calls.push(["projectUnitFor", root]);
        return unit;
      },
      ensureConnected: async (root: string, name: string, opts?: unknown) => {
        calls.push(["ensureConnected", root, name, opts]);
      },
      // 部分中间层桩（只实现 resume 触达的 units/projectUnitFor/ensureConnected）：按接缝收窄。
    };
    manager.middleware = fakeMw as unknown as McpManagerType["middleware"];
    return { manager, projRoot, calls, fakeMw, log };
  }

  it("单元缺失时先 projectUnitFor 确保单元创建", async () => {
    // 单元缺失：resumeReconnect 应先 projectUnitFor 创建单元，再按配置全集恢复。
    const { manager, projRoot, calls } = resumeFixture();
    await manager.resumeReconnect();
    expect(calls.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot)).toBeTruthy();
  });

  it("目标=配置全集 enabled（排除 disabled 的 p2、不依赖已有 entry）", async () => {
    const { manager, calls } = resumeFixture();
    await manager.resumeReconnect();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    expect(recon.map((c) => c[2]).sort()).toEqual(["p1", "p3"]);
  });

  it("非强制恢复（健康/connecting/reconnecting 不强制重建）", async () => {
    const { manager, calls } = resumeFixture();
    await manager.resumeReconnect();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    // 非强制：opts 缺省或 force 非 true——现有状态投影/在途去重决定是否真建连。
    expect(recon.length).toBeGreaterThan(0);
    expect(
      recon.every((c) => (c[3] as { force?: unknown } | undefined)?.force !== true),
    ).toBeTruthy();
  });

  it("userDisabled 过滤（p3 已禁用不复活）", async () => {
    // 单元已存在但 entry 缺失：仍按配置全集恢复（不重复 projectUnitFor）。
    const { manager, projRoot, calls, fakeMw } = resumeFixture();
    await manager.resumeReconnect();
    calls.length = 0;
    fakeMw.units.get(projRoot).userDisabled.add("p3");
    await manager.resumeReconnect();
    const recon2 = calls.filter((c) => c[0] === "ensureConnected");
    expect(recon2.map((c) => c[2])).toEqual(["p1"]);
  });

  it("单元已存在不再重复创建", async () => {
    const { manager, projRoot, calls, fakeMw } = resumeFixture();
    await manager.resumeReconnect();
    calls.length = 0;
    fakeMw.units.get(projRoot).userDisabled.add("p3");
    await manager.resumeReconnect();
    expect(!calls.some((c) => c[0] === "projectUnitFor")).toBeTruthy();
  });

  it("旧无 body 回落既有绑定（undefined→projectRoot）", async () => {
    const { manager, projRoot, calls } = resumeFixture();
    await manager.resumeReconnect(undefined);
    expect(calls.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot)).toBeTruthy();
  });

  it("新请求明确无工作区固定 @global（不回落他人 projectRoot）", async () => {
    const { manager, projRoot, calls } = resumeFixture();
    await manager.resumeReconnect("");
    expect(calls.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot)).toBe(false);
    expect(
      calls.some((c) => c[0] === "projectUnitFor" && c[1] === MIDDLEWARE_GLOBAL_ROOT),
    ).toBeTruthy();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    // 全局配置为空：目标集为空但 root 固定正确（不断言目标名，只断 root 面）。
    for (const c of recon) expect(c[1]).toBe(MIDDLEWARE_GLOBAL_ROOT);
  });

  it("新请求带 cwd 固定本次 root（不读并发可变的 projectRoot）", async () => {
    const { manager, projRoot, calls } = resumeFixture();
    // .git 标记使 findProjectRoot(subdir) 收敛到 projRoot。
    mkdirSync(join(projRoot, ".git"), { recursive: true });
    const subdir = join(projRoot, "sub");
    mkdirSync(subdir, { recursive: true });
    // 并发可变字段被改成别的 root：本次调用仍须用请求 cwd 解析出的 root。
    manager.projectRoot = MIDDLEWARE_GLOBAL_ROOT;
    const expected = realpathSync(projRoot);
    await manager.resumeReconnect(subdir);
    expect(calls.some((c) => c[0] === "projectUnitFor" && c[1] === expected)).toBe(true);
    expect(calls.some((c) => c[0] === "projectUnitFor" && c[1] === MIDDLEWARE_GLOBAL_ROOT)).toBe(
      false,
    );
  });

  it("单台恢复失败记 warn 不阻断其余（真正失败不无条件吞掉）", async () => {
    const { manager, calls, fakeMw, log } = resumeFixture();
    fakeMw.ensureConnected = async (root: string, name: string, opts?: unknown) => {
      calls.push(["ensureConnected", root, name, opts]);
      if (name === "p1") throw new Error("boom-p1");
    };
    await manager.resumeReconnect();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    expect(recon.map((c) => c[2]).sort()).toEqual(["p1", "p3"]);
    expect(log.warn.some((line) => line.includes("p1"))).toBe(true);
  });
});
