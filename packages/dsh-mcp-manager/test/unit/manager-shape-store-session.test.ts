/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  makeManager,
  makeTempDir,
  managerFixture,
  McpStore,
  normalizeServer,
  quietServer,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

setupManagerTestLifecycle();

// #392 遗留①②③：remove/update 清目录幽灵条目 + disconnect 显式 scope 定位 ----
describe("#392 遗留①：remove 清内存目录幽灵条目", () => {
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

  /** 已 start 并手工塞入目录条目（模拟 discover 残留）。 */
  async function ghostStarted({ remove = false } = {}) {
    const { manager, store, log } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    // #392 遗留①：remove 后目录（unit.catalog）残留幽灵条目清除——此前 dropMiddleware
    // Connection 只拆 connections 不清 catalog，TTL 内 ws_mcp_list 仍显示已删服务器。
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil(
      "@global 单元连接条目建立",
      () => mw.units.get("@global")?.connections.has("ghost") === true,
    );
    // 手动塞目录条目模拟「已 discover」残留（真实 remove 前目录必然存在）。目录内存态
    // 归 catalog 域，故经域写口登记。
    catalogDirectory.projectWrappedTools({
      root: "@global",
      serverName: "ghost",
      definitions: [{ name: "t", description: "d", parameters: {} }],
    });
    if (remove) await manager.remove("ghost");
    return { manager, store, log, mw };
  }

  it("目录条目存在（模拟 discover 残留）", async () => {
    await ghostStarted();
    expect(catalogDirectory.entryFor("@global", "ghost")).toBeDefined();
  });

  it("remove 后连接被拆", async () => {
    const { mw } = await ghostStarted({ remove: true });
    expect(mw.units.get("@global")!.connections.has("ghost")).toBe(false);
  });

  it("remove 后目录条目被清（#392 幽灵条目消除）", async () => {
    await ghostStarted({ remove: true });
    expect(catalogDirectory.entryFor("@global", "ghost")).toBeUndefined();
  });

  it("remove 落盘", async () => {
    const { store } = await ghostStarted({ remove: true });
    expect(store.find("ghost")).toBeUndefined();
  });
});

describe("#392 遗留①（M1 复核）：remove 清磁盘 last-good 缓存", () => {
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

  /** 先 persistRoot 写盘（含 ghost），remove 后等待异步清盘完成。 */
  async function persistedGhost({ remove = false } = {}) {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil(
      "@global 单元连接条目建立",
      () => mw.units.get("@global")?.connections.has("ghost") === true,
    );
    catalogDirectory.projectWrappedTools({
      root: "@global",
      serverName: "ghost",
      definitions: [{ name: "t", description: "d", parameters: {} }],
    });
    await catalogDirectory.persistRoot("@global", {
      cachePath: () => mw.host.catalogCachePath("@global"),
      isRuntimeServer: (name) => manager.isRuntimeServer(name),
      warn: () => {},
    });
    const cacheFile = mw.host.catalogCachePath("@global");
    if (remove) {
      await manager.remove("ghost");
      // dropMiddlewareConnection 内 removeCatalogEntry 为 fire-and-forget，轮询磁盘收敛。
      await pollUntil("磁盘目录缓存已清除 ghost", () => {
        try {
          return !readFileSync(cacheFile, "utf8").includes("ghost");
        } catch {
          return true; // 缓存文件整体被删（目录已空）也算清除
        }
      });
    }
    return { mw, cacheFile };
  }

  it("磁盘目录缓存写入 ghost 条目", async () => {
    const { cacheFile } = await persistedGhost();
    expect(readFileSync(cacheFile, "utf8").includes("ghost")).toBeTruthy();
  });

  it("remove 后内存目录亦清", async () => {
    await persistedGhost({ remove: true });
    expect(catalogDirectory.entryFor("@global", "ghost")).toBeUndefined();
  });
});

// add / update（scope project 抛错路径在 unit-manager 已覆盖，此处补全局） ----
describe("add / update / remove（全局）", () => {
  it("add 返回名", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2f-");
    const added = await manager.add(normalizeServer(quietServer("new")));
    expect(added.name).toBe("new");
  });

  it("重复 add 抛 already exists", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await expect(manager.add(normalizeServer(quietServer("new")))).rejects.toThrow(
      /already exists/,
    );
  });

  it("update 返回新 command", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    const updated = await manager.update("new", { command: "cmd2" });
    expect(updated.command).toBe("cmd2");
  });

  it("更新落盘", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await manager.update("new", { command: "cmd2" });
    expect(store.find("new")!.command).toBe("cmd2");
  });

  it("remove 后 store 无该条目", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await manager.remove("new");
    expect(store.find("new")).toBeUndefined();
  });
});

// #767 S1-3b：组合根侧接线判据——目录投影与载入都走 catalog 域 ----
describe("#767 S1-3b：manager 接线（建单元时才载入、内存不被磁盘盖回）", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2s13b-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  it("projectUnitFor 建单元时载入读到的磁盘目录", async () => {
    // 反证：把 projectUnitFor 里的 catalog.ensureRootLoaded 调用删掉 → 本条红（目录恒空）。
    const { manager } = makeManager(homeDir);
    await manager.initMiddleware();
    const root = "@global";
    const file = manager.catalogCachePathFor(root);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        root,
        entries: {
          diskSrv: {
            discoveredAt: 1,
            tools: [{ name: "disk_tool", description: "磁盘那份", inputSchema: {} }],
          },
        },
      }),
      "utf8",
    );
    // 建单元之前目录里没有这个 root。
    expect(catalogDirectory.serversFor(root)).toBeUndefined();
    await manager.middleware!.projectUnitFor(root);
    expect(catalogDirectory.entryFor(root, "diskSrv")?.tools.has("disk_tool")).toBe(true);
    expect(catalogDirectory.entryFor(root, "diskSrv")?.discoveredAt).toBe(1);
    await catalogDirectory.ensureRootLoaded(root, file);
    // 二次载入不再读盘：内存那份仍在。
    expect(catalogDirectory.entryFor(root, "diskSrv")?.discoveredAt).toBe(1);
  });

  it("root 已在册时，磁盘那份不得盖回内存投影", async () => {
    // 反证：删掉 ensureRootLoaded 的 `if (this.byRoot.has(root)) return;` 短路 → 本条红
    // （内存条目会被磁盘内容整体替换成 diskSrv）。
    const { manager } = makeManager(homeDir);
    await manager.initMiddleware();
    const root = "@global";
    const file = manager.catalogCachePathFor(root);
    catalogDirectory.dropRoot(root);
    catalogDirectory.projectWrappedTools({
      root,
      serverName: "memSrv",
      definitions: [{ name: "mem_tool", description: "内存那份", parameters: {} }],
    });
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        root,
        entries: {
          diskSrv: {
            discoveredAt: 1,
            tools: [{ name: "disk_tool", description: "磁盘那份", inputSchema: {} }],
          },
        },
      }),
      "utf8",
    );
    // 单元已被本用例先建过（root 在册）→ 建单元不再载入、也不覆盖。
    await manager.middleware!.projectUnitFor(root);
    expect(catalogDirectory.entryFor(root, "memSrv")?.tools.has("mem_tool")).toBe(true);
    expect(catalogDirectory.entryFor(root, "diskSrv")).toBeUndefined();
  });
});

// setSession / catalogServersFor / projectStoreFor / refreshFromDisk ----
describe("setSession", () => {
  function sessionFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    // 项目目录：<dir>/proj/.git。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    return { dir, manager, store, proj };
  }

  it("空 → 空 幂等短路", async () => {
    const { manager } = sessionFixture();
    await manager.setSession(undefined);
    expect(manager.projectRoot).toBeUndefined();
  });

  it("切换到项目 root", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    expect(manager.projectRoot).toBe(proj);
  });

  it("projectStore 是 McpStore 实例", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    expect(manager.projectStore instanceof McpStore).toBeTruthy();
  });

  it("项目级服务器随会话启动（进当前项目单元）", async () => {
    const { manager, proj } = sessionFixture();
    await manager.initMiddleware();
    await manager.setSession(proj);
    await pollUntil(
      "项目级服务器进项目单元",
      () => manager.middleware!.units.get(proj)?.connections.has("psrv") === true,
    );
    expect(manager.middleware!.units.get(proj)!.connections.has("psrv")).toBeTruthy();
  });

  it("同项目幂等不重载", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    const sameStore = manager.projectStore;
    await manager.setSession(proj);
    expect(manager.projectStore).toBe(sameStore);
  });

  async function switchedAway() {
    const fixture = sessionFixture();
    await fixture.manager.initMiddleware();
    await fixture.manager.setSession(fixture.proj);
    const sameStore = fixture.manager.projectStore;
    // 切走：项目 supervisor 全部断开（无标记目录回落为项目根 = cwd 自身，
    // 加载出空 projectStore 属预期行为）。
    const elsewhere = join(fixture.dir, "elsewhere");
    await fixture.manager.setSession(elsewhere);
    return { ...fixture, sameStore, elsewhere };
  }

  it("切走后项目级连接常驻（单池不再随会话断开）", async () => {
    const { manager, proj } = await switchedAway();
    // 单池（#767 笔 1a）：连接按 root 常驻，切会话只切 currentRoot，不拆项目单元。
    await pollUntil(
      "项目单元仍在池",
      () => manager.middleware!.units.get(proj)?.connections.has("psrv") === true,
    );
    expect(manager.middleware!.units.get(proj)!.connections.has("psrv")).toBe(true);
  });

  it("切走后 projectRoot 更新", async () => {
    const { manager, elsewhere } = await switchedAway();
    expect(manager.projectRoot).toBe(elsewhere);
  });

  it("不再持有旧项目 store", async () => {
    const { manager, sameStore } = await switchedAway();
    expect(manager.projectStore !== sameStore).toBeTruthy();
  });

  it("切走后 catalogServersFor 无 psrv", async () => {
    const { manager, elsewhere } = await switchedAway();
    expect((await manager.catalogServersFor(elsewhere)).has("psrv")).toBe(false);
  });
});

describe("catalogServersFor", () => {
  async function catalogFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    // catalogServersFor：全局 + 项目聚合，禁用过滤，同名碰撞取项目条目（项目优先，#770-11）。
    // 上一行刚赋值，此处断言存在。
    manager.projectStore!.data.servers.push(
      normalizeServer({ ...quietServer("psrv2", { enabled: false }) }),
    );
    return { dir, manager, store, proj };
  }

  it("含全局", async () => {
    const { manager, proj } = await catalogFixture();
    expect((await manager.catalogServersFor(proj)).has("glob")).toBeTruthy();
  });

  it("含项目级", async () => {
    const { manager, proj } = await catalogFixture();
    expect((await manager.catalogServersFor(proj)).has("psrv")).toBeTruthy();
  });

  it("禁用服务器不进目录", async () => {
    const { manager, proj } = await catalogFixture();
    expect((await manager.catalogServersFor(proj)).has("psrv2")).toBe(false);
  });

  it("项目级 scope 标注", async () => {
    const { manager, proj } = await catalogFixture();
    // 聚合恒含项目级条目（上一用例同夹具已验 has），此处断言存在。
    expect((await manager.catalogServersFor(proj)).get("psrv")!.scope).toBe("project");
  });

  it("同名碰撞取项目条目（项目优先，#770-11）", async () => {
    const { manager, store, proj } = await catalogFixture();
    // 全局与项目各一台同名 dup：项目条目以不同 command 打标。
    store.upsert(normalizeServer(quietServer("dup")));
    manager.projectStore!.upsert(
      normalizeServer({ ...quietServer("dup"), command: "project-cmd" }),
    );
    const dup = (await manager.catalogServersFor(proj)).get("dup")!;
    expect(dup.scope).toBe("project");
    expect(dup.server.command).toBe("project-cmd");
  });

  it("空 cwd 只出全局", async () => {
    // 空 cwd 只出全局。
    const { manager } = await catalogFixture();
    const onlyGlobal = await manager.catalogServersFor("");
    expect([...onlyGlobal.keys()]).toEqual(["glob"]);
  });
});

describe("projectStoreFor", () => {
  async function cachedFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    return { manager, proj };
  }

  it("工作区缓存复用", async () => {
    // projectStoreFor 缓存命中复用。
    const { manager, proj } = await cachedFixture();
    const cached = await manager.projectStoreFor(proj);
    expect(cached).toBe(manager.projectStore);
  });

  it("空串 undefined", async () => {
    const { manager } = await cachedFixture();
    expect(await manager.projectStoreFor("")).toBeUndefined();
  });

  it("undefined undefined", async () => {
    const { manager } = await cachedFixture();
    expect(await manager.projectStoreFor(undefined)).toBeUndefined();
  });
});

describe("refreshFromDisk", () => {
  async function refreshFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    // 先建立 supervisor，使后续 reconcile 有"集合变化"可报（原脚本经 setSession
    // 启动过项目级/全局 supervisor，此处显式补上等价前置）。
    manager.reconcileServers();
    // 建立 0 基线（文件缺失 → 内存 servers 清空）。
    await store.load();
    let broadcasts = 0;
    manager.onStatus(() => {
      broadcasts += 1;
    });
    return { dir, manager, store, broadcasts: () => broadcasts };
  }

  it("重读生效", async () => {
    const { dir, manager, store, broadcasts } = await refreshFixture();
    const future = Date.now() / 1000 + 10;
    writeFileSync(
      join(dir, "global.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }],
      }),
    );
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播落定且无未决 coalesce
    //（statusTimer 清空 = 广播 handler 已全部执行），再取基线（事件驱动）。
    await pollUntil(
      "配置变化广播落定",
      () =>
        broadcasts() >= 1 &&
        (manager as unknown as { statusTimer: unknown }).statusTimer === undefined,
    );
    expect(store.data.servers.some((s) => s.name === "fresh")).toBeTruthy();
  });

  it("无变化不广播", async () => {
    const { dir, manager, broadcasts } = await refreshFixture();
    const future = Date.now() / 1000 + 10;
    writeFileSync(
      join(dir, "global.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }],
      }),
    );
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    await pollUntil(
      "配置变化广播落定",
      () =>
        broadcasts() >= 1 &&
        (manager as unknown as { statusTimer: unknown }).statusTimer === undefined,
    );
    // 无变化时不广播：先取基线（上一广播已完全落定），再 refreshFromDisk
    //（无变化 → 不 emitStatus），轮询确认无未决广播后断言计数不变。
    const before = broadcasts();
    await manager.refreshFromDisk();
    await pollUntil(
      "无变化后无未决广播",
      () => (manager as unknown as { statusTimer: unknown }).statusTimer === undefined,
    );
    expect(broadcasts()).toBe(before);
  });
});

// setSession 零连接副作用（#228：POST /session 永不挂起回归） ----
describe("setSession 零连接副作用（#228）", () => {
  async function slowProjectSession() {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2s-");
    // 项目目录含一个「连接会卡住」的服务器（stdio 命令不存在 → connect 会失败/等待，
    // 若 setSession await 连接则此测试超时）。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { name: "slow", transport: "stdio", command: "definitely-not-exist-cmd", enabled: true },
        ],
      }),
    );
    // 中间层 project 模式：setSession 只切 currentRoot，不 await 连接。
    const started = Date.now();
    await manager.setSession(proj);
    return { manager, proj, elapsed: Date.now() - started };
  }

  it("setSession 零连接副作用", async () => {
    const { elapsed } = await slowProjectSession();
    expect(elapsed < 2000).toBeTruthy();
  });

  it("projectRoot 切到项目", async () => {
    const { manager, proj } = await slowProjectSession();
    expect(manager.projectRoot).toBe(proj);
  });

  it("中间层未初始化（apply 时才建）→ 不崩", async () => {
    const { manager } = await slowProjectSession();
    expect(manager.middleware).toBeUndefined();
  });
});
