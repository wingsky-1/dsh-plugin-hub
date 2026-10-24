/** Manager 方法面的自然职责测试与专属fixture。 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { FakeToolEntry } from "../helpers.ts";

import {
  managerFixture,
  McpStore,
  normalizeServer,
  quietServer,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

/** 触达一台全局服务器并等它进 @global 单元（单池后唯一账本是单元表）。 */
async function withGlobalServer(name: string, extra: Record<string, unknown> = {}) {
  const fixture = managerFixture("dsh-mcp-mgr2c-");
  await fixture.manager.initMiddleware();
  fixture.store.upsert(normalizeServer(quietServer(name, extra)));
  fixture.manager.reconcileServers();
  await pollUntil(
    `${name} 进 @global 单元`,
    () => fixture.manager.middleware!.units.get("@global")?.connections.has(name) ?? false,
  );
  return fixture;
}

async function withTwoServers() {
  const fixture = managerFixture("dsh-mcp-mgr2c-");
  await fixture.manager.initMiddleware();
  fixture.store.upsert(normalizeServer(quietServer("g-one")));
  fixture.manager.reconcileServers();
  fixture.store.upsert(normalizeServer(quietServer("g-off")));
  fixture.manager.reconcileServers();
  await pollUntil(
    "两台都进 @global 单元",
    () => fixture.manager.middleware!.units.get("@global")?.connections.size === 2,
  );
  return fixture;
}

/** 全局 + 当前项目级各一台同名服务器（同名跨 root 是本笔的键形状判据）。 */
async function withScopeDuplicate() {
  const { dir, manager, store, log } = managerFixture("dsh-mcp-mgr2c-");
  store.upsert(normalizeServer(quietServer("both")));
  manager.projectStore = new McpStore(join(dir, "proj.json"));
  // 上一行刚赋值，此处断言存在。
  manager.projectStore!.data.servers.push(
    normalizeServer({ ...quietServer("both"), command: "other" }),
  );
  manager.projectStores.set(dir, manager.projectStore);
  manager.projectRoot = dir;
  await manager.initMiddleware();
  manager.reconcileServers();
  // 等**语义终点**而非代理条件（#1091）：条目在 middleware.ts:148 就带着 id: undefined
  // 入表，has() 为真早于 id 在 :173 回填——只等 has() 会读到 id 未回填的窗口，
  // 让下面「id 不同」那条用例偶发失败。断言不动，这里只把等待条件收紧到被断言的那个量。
  await pollUntil("两个 root 各有一条 both 且 id 已回填", () => {
    const globalEntry = manager.middleware!.units.get("@global")?.connections.get("both");
    const projectEntry = manager.middleware!.units.get(dir)?.connections.get("both");
    return (
      globalEntry !== undefined &&
      projectEntry !== undefined &&
      globalEntry.id !== undefined &&
      projectEntry.id !== undefined
    );
  });
  return { manager, store, dir, log };
}
setupManagerTestLifecycle();

// onStatus 订阅注销 ----
describe("onStatus 订阅注销", () => {
  it("注销后不再回调", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2b-");
    let count = 0;
    const off = manager.onStatus(() => {
      count += 1;
    });
    manager.emitStatus();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播 handler 落定（事件驱动）。
    await pollUntil("onStatus 广播落定", () => count === 1);
    off();
    // 注销后再广播：哨兵确认广播仍发生（事件驱动），原监听不再被调用。
    let sentinel = 0;
    const offSentinel = manager.onStatus(() => {
      sentinel += 1;
    });
    manager.emitStatus();
    await pollUntil("注销后广播仍发出", () => sentinel === 1);
    offSentinel();
    expect(count).toBe(1);
  });
});
describe("reconcileServers", () => {
  it("首次同步把新服务器触达进池（@global 单元）", async () => {
    const { manager } = await withGlobalServer("g-one");
    expect(manager.middleware!.units.get("@global")!.connections.has("g-one")).toBe(true);
  });

  it("池内只有一条（单元表条目数）", async () => {
    const { manager } = await withGlobalServer("g-one");
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(1);
  });

  it("池内条目带自己的 server 配置（单元 = 唯一事实源）", async () => {
    const { manager } = await withGlobalServer("g-one");
    // 刚触达的条目恒存在，此处断言存在。
    expect(manager.middleware!.units.get("@global")!.connections.get("g-one")!.server.name).toBe(
      "g-one",
    );
  });

  it("集合无变化不报变更", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    manager.reconcileServers();
    expect(manager.reconcileServers()).toBe(false);
  });

  it("busy 重入直接拒绝", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    manager.reconcileServers();
    manager.reconcileBusy = true;
    expect(manager.reconcileServers()).toBe(false);
  });

  it("g-off 进池后条目存在", async () => {
    const { manager } = await withTwoServers();
    expect(manager.middleware!.units.get("@global")!.connections.has("g-off")).toBeTruthy();
  });

  it("禁用已运行服务器报变更（释放一条池连接）", async () => {
    const { manager, store } = await withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    expect(manager.reconcileServers()).toBe(true);
  });

  it("禁用后池内条目移除（同单元其余不动）", async () => {
    const { manager, store } = await withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    manager.reconcileServers();
    expect(manager.middleware!.units.get("@global")!.connections.has("g-off")).toBe(false);
    expect(manager.middleware!.units.get("@global")!.connections.has("g-one")).toBe(true);
  });

  it("未运行的禁用项无变更", async () => {
    const { manager, store } = await withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    manager.reconcileServers();
    store.upsert(normalizeServer(quietServer("g-off2", { enabled: false })));
    expect(manager.reconcileServers()).toBe(false);
  });

  it("配置移除后池内条目同步移除", async () => {
    const { manager, store } = await withTwoServers();
    store.remove("g-one");
    store.remove("g-off");
    manager.reconcileServers();
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(0);
  });

  it("同名跨 root 各成一条（不再被全局顶掉）", async () => {
    const { manager, dir } = await withScopeDuplicate();
    expect(manager.middleware!.units.get("@global")!.connections.has("both")).toBe(true);
    expect(manager.middleware!.units.get(dir)!.connections.has("both")).toBe(true);
  });

  it("同名跨 root 各拿独立注册名（id 不同）", async () => {
    const { manager, dir } = await withScopeDuplicate();
    const globalEntry = manager.middleware!.units.get("@global")!.connections.get("both")!;
    const projectEntry = manager.middleware!.units.get(dir)!.connections.get("both")!;
    expect(globalEntry.id).not.toBe(projectEntry.id);
  });

  it("同名跨 root：禁用项目级只拆项目那条（(root, 裸名) 键）", async () => {
    const { manager, store, dir } = await withScopeDuplicate();
    // 项目 store 里那条改成 disabled → 只有项目单元的条目该被释放。
    store.upsert(normalizeServer(quietServer("both")));
    // 项目 store 由 withScopeDuplicate 装配，此处断言存在。
    manager.projectStore!.data.servers = [
      normalizeServer({ ...quietServer("both"), command: "other", enabled: false }),
    ];
    manager.reconcileServers();
    expect(manager.middleware!.units.get(dir)!.connections.has("both")).toBe(false);
    expect(manager.middleware!.units.get("@global")!.connections.has("both")).toBe(true);
  });
});

// start / stop / startAll 边界 ----
describe("start / stop / startAll 边界", () => {
  it("start 未知名 no-op（无中间层实例就不建任何连接）", () => {
    const { manager } = managerFixture("dsh-mcp-mgr2d-");
    manager.start("ghost");
    expect(manager.middleware, "未装配实例 → 无池").toBe(undefined);
  });

  it("无活动项目 root 时 project scope no-op", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    manager.start("any", "project");
    expect(manager.middleware!.units.size, "无项目 root → 不建单元").toBe(0);
  });

  it("startAll 把 svc 触达进池（@global 单元）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    expect(manager.middleware!.units.get("@global")!.connections.has("svc")).toBe(true);
  });

  it("已有连接不重建（重复 start 不换代际）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    const existing = manager.middleware!.units.get("@global")!.connections.get("svc");
    manager.start("svc");
    expect(manager.middleware!.units.get("@global")!.connections.get("svc")).toBe(existing);
  });

  it("无中间层实例时 start 打 warn 且不建连接", () => {
    const { manager, store, log } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.start("svc");
    expect(manager.middleware, "不建连接池").toBe(undefined);
    expect(
      log.warn.some((m) => /中间层未就绪/.test(m)),
      "warn 可归因",
    ).toBeTruthy();
  });

  function withScopeDuplicate() {
    const { dir, manager, store, log } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.projectStore = new McpStore(join(dir, "p-d.json"));
    manager.projectStore.upsert(normalizeServer(quietServer("svc")));
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    return { manager, dir, log };
  }

  it("同名跨 root：全局与项目级各进各的单元（不再拒绝启动）", async () => {
    const { manager, dir } = withScopeDuplicate();
    await manager.initMiddleware();
    manager.start("svc", "global");
    manager.start("svc", "project");
    await pollUntil("两个单元各有一条 svc", () => {
      return (
        manager.middleware!.units.get("@global")?.connections.has("svc") === true &&
        manager.middleware!.units.get(dir)?.connections.has("svc") === true
      );
    });
    expect(manager.middleware!.units.get("@global")!.connections.has("svc")).toBe(true);
    expect(manager.middleware!.units.get(dir)!.connections.has("svc")).toBe(true);
  });

  it("同名跨 root：不再打 already registered in scope", async () => {
    const { manager, log } = withScopeDuplicate();
    await manager.initMiddleware();
    manager.start("svc", "global");
    manager.start("svc", "project");
    expect(log.warn.some((m) => /already registered in scope/.test(m))).toBe(false);
  });

  it("startAll 跳过后再启动 svc", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    expect(manager.middleware!.units.get("@global")!.connections.has("svc")).toBeTruthy();
  });

  it("禁用不启动", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    expect(manager.middleware!.units.get("@global")!.connections.has("off")).toBe(false);
  });
});

// connect / disconnect / reconnect（manager 面） ----
describe("connect / disconnect / reconnect（manager 面）", () => {
  it("connect 未知抛 not found", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2e-");
    await expect(manager.connect("ghost")).rejects.toThrow(/not found/);
  });

  it("connect 建立池内条目（@global 单元）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    expect(manager.middleware!.units.get("@global")!.connections.has("c-one")).toBeTruthy();
  });

  it("已连接重复 connect 不增数量（force 受控重建后仍是一条）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    // 已连接跳过：注册面带该 id 前缀 = 「已连上」（官方零状态 API，前缀是唯一正向证据）。
    // 刚 connect 的条目恒存在，此处断言存在。
    const connected = manager.middleware!.units.get("@global")!.connections.get("c-one")!;
    connected.id = "id-c-one";
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
      { name: "mcp__id-c-one__t" },
    ];
    await manager.connect("c-one");
    // 单池后 connect 恒走 force 受控重建（#412：半开卡 connected 也要能恢复），
    // 故条目**换代际**但仍只有一条——重复 connect 不会长出第二条。
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(1);
    expect(manager.middleware!.units.get("@global")!.connections.has("c-one")).toBe(true);
  });

  it("disconnect 未知 no-op / 已知移除", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    await manager.disconnect("ghost");
    await manager.disconnect("c-one");
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(0);
  });

  it("disconnect 落 userDisabled（浮窗断开语义）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    await manager.disconnect("c-one");
    expect(manager.middleware!.units.get("@global")!.userDisabled.has("c-one")).toBe(true);
  });

  it("reconnect 未知抛 not found", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2e-");
    await expect(manager.reconnect("ghost")).rejects.toThrow(/not found/);
  });

  it("同名跨 root：connect(project) 不再抛 registered in scope", async () => {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-two")));
    manager.projectStore = new McpStore(join(dir, "p.json"));
    // 上一行刚赋值，此处断言存在。
    manager.projectStore!.data.servers.push(normalizeServer(quietServer("c-two")));
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    manager.start("c-two", "global");
    // 单池：单元键是 (root, 裸名)，同名跨 scope 各成一条——不再有跨 scope 拒绝。
    await manager.connect("c-two", "project");
    expect(manager.middleware!.units.get(dir)!.connections.has("c-two")).toBe(true);
  });
});
