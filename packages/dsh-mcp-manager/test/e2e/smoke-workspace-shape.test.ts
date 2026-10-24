// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 工作区面：项目根发现 / 目录数据源 / 外部配置重读。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的三个工作区 describe 整块迁入本文件
// （项目根发现 99 eff、目录数据源按工作区计算 107 eff、外部配置变更自动重读 136 eff），
// fullName 与断言逐字保留（套件名沿用原标题）。仍是 e2e 层判据：被测对象是真实
// McpManager + 真 McpStore + mkdtemp 隔离目录，DSH_HOME 由「项目根发现」describe 的
// beforeAll 设、afterAll 还原（还原链逐字保留）。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fakeManagerCtx,
  installCompositionPorts,
  pollUntil,
  releaseCompositionPorts,
} from "../helpers.ts";
import { SCOPE_PROJECT, normalizeServer } from "../../lib/index.js";
import { McpManager } from "../../src/server/connection/orchestrator/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import type { ReloadFixture } from "./smoke-workspace-shape-support.ts";
import { makeReloadFixture, seedGhost } from "./smoke-workspace-shape-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

describe("项目根发现（findProjectRoot / setSession）", () => {
  let base: string;
  let deep: string;
  let home: string;
  let leetcode: string;
  let proj: string;
  let projSub: string;
  let nomark: string;
  let findProjectRoot: (cwd: string | undefined) => Promise<string>;
  let manager: McpManager;
  let prevDshHome: string | undefined;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-root-"));
    deep = join(
      base,
      "d0",
      "d1",
      "d2",
      "d3",
      "d4",
      "d5",
      "d6",
      "d7",
      "d8",
      "d9",
      "d10",
      "d11",
      "d12",
      "d13",
      "d14",
    );
    home = join(deep, "home");
    leetcode = join(home, "dev", "leetcode");
    proj = join(base, "proj");
    projSub = join(proj, "sub");
    nomark = join(deep, "nomark");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    mkdirSync(leetcode, { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    mkdirSync(projSub, { recursive: true });
    mkdirSync(nomark, { recursive: true });
    // home 自身的项目级配置（空服务器列表，setSession 不会 spawn 进程）。
    // S2-b：项目级新形态（包分区），经 projectStoreFor 直读（旧扁平只走迁移读面）。
    mkdirSync(join(home, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    mkdirSync(join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    writeFileSync(
      join(home, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({ version: 1, servers: [] }),
    );
    writeFileSync(
      join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({ version: 1, servers: [] }),
    );
    prevDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(home, ".dsh");
    ({ findProjectRoot } = await import("../../src/server/workspace/interface.ts"));
    manager = new McpManager(fakeManagerCtx(), new McpStore(join(base, "dsh-mcp.json")));
  });

  afterAll(async () => {
    await manager.dispose();
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    rmSync(base, { recursive: true, force: true });
  });

  it("home 下的空工作区不把 home 误判为项目根（回归：~/.dsh 串台）", async () => {
    const root = await findProjectRoot(leetcode);
    expect(root).toBe(leetcode);
    await manager.setSession(leetcode);
    expect(manager.projectRoot).toBe(leetcode);
    expect(manager.projectStore !== undefined).toBeTruthy();
    expect(
      (manager.summary() as unknown as { servers: { scope: string }[] }).servers.filter(
        (s: { scope: string }) => s.scope === "project",
      ).length,
    ).toBe(0);
  });

  it("子目录向上命中项目 .dsh 标记", async () => {
    const root = await findProjectRoot(projSub);
    expect(root).toBe(proj);
  });

  it("home 自身作为会话 cwd 时仍是合法项目根（fallback）", async () => {
    const root = await findProjectRoot(home);
    expect(root).toBe(home);
  });

  it("无标记目录 → cwd 本身", async () => {
    expect(await findProjectRoot(nomark)).toBe(nomark);
  });

  it("空 cwd 清空项目级会话且幂等", async () => {
    await manager.setSession("");
    expect(manager.projectRoot).toBe(undefined);
    expect(manager.projectStore).toBe(undefined);
    // 再次清空：守卫应直接返回（不抛、不重复广播）
    await manager.setSession("");
    await manager.setSession(undefined);
    expect(manager.projectStore).toBe(undefined);
  });

  it("切回带 .dsh 的项目：加载项目级 store", async () => {
    await manager.setSession(proj);
    expect(manager.projectRoot).toBe(proj);
    expect(manager.projectStore !== undefined).toBeTruthy();
  });
});

describe("目录数据源按工作区计算（切换工作区不抖动）", () => {
  let base: string;
  let rootA: string;
  let rootB: string;
  let subA: string;
  let noReconnect: { reconnect: { enabled: boolean } };
  let gstore: McpStore;
  let manager: McpManager;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-cat-"));
    rootA = join(base, "projA");
    rootB = join(base, "projB");
    subA = join(rootA, "sub");
    mkdirSync(join(rootA, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    mkdirSync(join(rootB, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    mkdirSync(subA, { recursive: true });
    noReconnect = { reconnect: { enabled: false } };
    // S2-b：项目级新形态直写（经 catalogServersFor→projectStoreFor 直读）。
    writeFileSync(
      join(rootA, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          normalizeServer({ name: "a1", transport: "stdio", command: "true", ...noReconnect }),
        ],
      }),
    );
    writeFileSync(
      join(rootB, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          normalizeServer({ name: "b1", transport: "stdio", command: "true", ...noReconnect }),
        ],
      }),
    );

    gstore = new McpStore(join(base, "dsh-mcp.json"));
    gstore.data.servers = [
      normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }),
    ];
    manager = new McpManager(fakeManagerCtx(), gstore);
  });

  afterAll(async () => {
    await manager.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it("cwd 属于 projA → 全局 + a1", async () => {
    const names = [...(await manager.catalogServersFor(subA)).keys()];
    expect(names).toEqual(["g1", "a1"]);
  });

  it("cwd 属于 projB → 全局 + b1", async () => {
    const names = [...(await manager.catalogServersFor(rootB)).keys()];
    expect(names).toEqual(["g1", "b1"]);
  });

  it("host 切换会话后 projA 的目录不变（回归：切换工作区不再抖动）", async () => {
    await manager.setSession(rootB);
    const names = [...(await manager.catalogServersFor(subA)).keys()];
    expect(names).toEqual(["g1", "a1"]);
  });

  it("空 cwd → 仅全局", async () => {
    const names = [...(await manager.catalogServersFor("")).keys()];
    expect(names).toEqual(["g1"]);
  });

  it("同名碰撞取项目条目（项目优先，#770-11）", async () => {
    // projB 里放一台与全局同名的服务器（描述打标，用于断言取的是项目条目）。
    const storeB = (await manager.projectStoreFor(rootB))!;
    storeB.upsert(
      normalizeServer({
        name: "g1",
        transport: "stdio",
        command: "true",
        description: "from-project",
        ...noReconnect,
      }),
    );
    const catalog = await manager.catalogServersFor(rootB);
    expect([...catalog.keys()]).toEqual(["g1", "b1"]);
    const g1 = catalog.get("g1")!;
    expect(g1.scope).toBe(SCOPE_PROJECT);
    expect(g1.server.description).toBe("from-project");
  });

  it("projectStoreFor 缓存复用（同 root 返回同一实例）", async () => {
    const first = await manager.projectStoreFor(rootA);
    const second = await manager.projectStoreFor(rootA);
    expect(first).toBe(second);
  });

  it("setSession 复用工作区缓存（不重复读盘）", async () => {
    await manager.setSession(rootA);
    const current = manager.projectStore;
    await manager.setSession(rootB);
    await manager.setSession(rootA);
    expect(manager.projectStore).toBe(current);
  });

  it("运行时注入（runtimeRegistry）并入目录数据源（#359）", async () => {
    await manager.registerServer(
      normalizeServer({ name: "rt1", transport: "stdio", command: "true", ...noReconnect }),
    );
    const names = [...(await manager.catalogServersFor("")).keys()];
    expect(names).toEqual(["g1", "rt1"]);
    // 同名 runtime 优先于 store（与 reconcile 双轨一致）——目录仍含该名。
    await manager.registerServer(
      normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }),
    );
    const g1 = (await manager.catalogServersFor("")).get("g1");
    expect(g1 !== undefined && g1.server !== undefined, "g1 仍在目录中").toBe(true);
  });
});

describe("外部配置变更自动重读（refreshFromDisk / reconcileServers）", () => {
  let fixture: ReloadFixture;

  beforeAll(async () => {
    fixture = await makeReloadFixture();
  });

  afterAll(async () => {
    await fixture.manager.dispose();
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it("项目级配置初始为空（setSession 后不自动 spawn）", () => {
    expect(fixture.manager.projectStore!.data.servers.length).toBe(0);
  });

  it("外部新增 disabled 服务器 → refreshFromDisk 重读并进 summary（不 spawn）", async () => {
    // 显式拨未来 mtime，避免与 setSession 基线同毫秒导致 reloadIfChanged 检测不到。
    writeFileSync(
      fixture.cfg,
      JSON.stringify({
        version: 1,
        servers: [
          normalizeServer({ name: "p1", transport: "stdio", command: "true", enabled: false }),
        ],
      }),
    );
    utimesSync(fixture.cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await fixture.manager.refreshFromDisk();
    const names = (
      fixture.manager.summary() as unknown as { servers: { scope: string; name: string }[] }
    ).servers
      .filter((s: { scope: string }) => s.scope === SCOPE_PROJECT)
      .map((s: { name: string }) => s.name);
    expect(names, "外部新增出现在面板数据").toEqual(["p1"]);
    expect(
      fixture.ensured.some((k) => k.endsWith("\u0000p1")),
      "disabled 不触达连接",
    ).toBe(false);
  });

  it("外部移除配置 → 池内已连接条目被释放", async () => {
    seedGhost(fixture);
    fixture.released.length = 0;
    writeFileSync(fixture.cfg, JSON.stringify({ version: 1, servers: [] }));
    utimesSync(fixture.cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await fixture.manager.refreshFromDisk();
    expect(
      fixture.released.some((k) => k.endsWith("\u0000ghost")),
      "ghost 的池连接被释放",
    ).toBe(true);
    expect(fixture.poolUnit.connections.has("ghost"), "ghost 已不在池").toBe(false);
  });

  it("无配置变化时 refreshFromDisk 不广播（防 SSE 空转循环）", async () => {
    // 前一测试的 emitStatus 是 coalesce 异步（setTimeout 0）：哨兵主动 emit 一次
    // 并轮询等其落定（事件驱动替代固定 sleep），再注册本测试计数监听，
    // 避免上一轮广播误入本测试的监听计数。
    let settled = 0;
    const offSentinel = fixture.manager.onStatus(() => {
      settled += 1;
    });
    fixture.manager.emitStatus();
    await pollUntil("coalesce 广播落定", () => settled >= 1);
    offSentinel();
    let emitted = 0;
    fixture.manager.onStatus(() => {
      emitted += 1;
    });
    await fixture.manager.refreshFromDisk();
    expect(emitted, "无变化不 emitStatus").toBe(0);
  });
});
