/** Manager 方法面的自然职责测试与专属fixture。 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import {
  managerFixture,
  MIDDLEWARE_GLOBAL_ROOT,
  normalizeServer,
  poolLoader,
  quietServer,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

setupManagerTestLifecycle();

// 中间层模式 connect/disconnect 分支（#228：userDisabled 持久化） ----
describe("中间层模式 connect/disconnect 分支（#228）", () => {
  async function middlewareConnected() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2t-");
    store.upsert(normalizeServer(quietServer("g1")));
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
    await manager.setSession(proj);
    // 初始化中间层（模拟 apply）。
    await manager.initMiddleware();
    // 项目级 connect → 中间层连接池（userDisabled 解除 + ensureConnected）。
    await manager.connect("p1", "project");
    // 池由 initMiddleware 刚建，此处断言存在。
    return { manager, store, proj, mw: manager.middleware! };
  }

  it("中间层已初始化", async () => {
    const { manager } = await middlewareConnected();
    expect(manager.middleware !== undefined).toBeTruthy();
  });

  it("中间层单元已创建", async () => {
    const { mw, proj } = await middlewareConnected();
    expect(mw.units.has(proj)).toBeTruthy();
  });

  it("connect 解除 userDisabled", async () => {
    const { mw, proj } = await middlewareConnected();
    expect(mw.units.get(proj)!.userDisabled.has("p1")).toBe(false);
  });

  it("断开后 userDisabled", async () => {
    // 项目级 disconnect → userDisabled 持久化。
    const { manager, mw, proj } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(mw.units.get(proj)!.userDisabled.has("p1")).toBe(true);
  });

  it("连接拆毁", async () => {
    const { manager, mw, proj } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(mw.units.get(proj)!.connections.has("p1")).toBe(false);
  });

  it("持久化文件存在（不崩）", async () => {
    const { manager } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(existsSync(manager.userStatePath)).toBe(true);
  });

  it("全局 disconnect 也走池（写 @global 单元 userDisabled）", async () => {
    const { manager } = await middlewareConnected();
    // 单池（#767 笔 1a）：全局服务器同样在 @global 单元，断开按（store ∩ 非 runtime）定位到它。
    // 刚 connect 的 @global 单元恒存在，此处断言存在。
    const globalUnit = (await manager.middleware!.projectUnitFor("@global"))!;
    await manager.disconnect("g1");
    expect(globalUnit.userDisabled.has("g1")).toBe(true);
  });
});

describe("dispose", () => {
  async function disposeFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("s-on")));
    manager.startAll();
    return { manager };
  }

  it("dispose 释放全部池条目（官方句柄被 dispose）", async () => {
    // 工具注销自换引擎起归官方实例自己的 dispose（本地只留「逐条摘账 + 发起释放」）：
    // 句柄被释放即旧栈「逐个调用 toolDisposers」的同一判据面（撤销工具注册是 dispose 的效果）。
    const { manager } = await disposeFixture();
    await pollUntil("装载已发起", () => poolLoader!.handles.length > 0);
    const record = poolLoader!.handles[poolLoader!.handles.length - 1];
    expect(record.state.disposed).toBe(false);
    await manager.dispose();
    expect(record.state.disposed).toBe(true);
  });

  it("dispose 后池被整体拆空", async () => {
    const { manager } = await disposeFixture();
    await pollUntil("装载已发起", () => poolLoader!.handles.length > 0);
    await manager.dispose();
    expect(manager.middleware, "中间层实例已释放").toBe(undefined);
  });
});

// B5：受控重建释放旧代际 ----
// 旧直连账本的「start 替换分支（directConfig 换引用）」随账本退役；单池后同一条不变式落在
// connect 的 force 受控重建上（connectInternal：先 await disposeServer(旧 id) 再挂新实例）。
describe("B5 红测：受控重建释放旧代际", () => {
  const poolEntry = (manager: McpManagerType) =>
    manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)?.connections.get("s5");

  async function rebuiltEntry() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5a-");
    await manager.initMiddleware();
    const srv = normalizeServer(quietServer("s5"));
    store.upsert(srv);
    // 第一代走真装载链（假 loader，离线）：账本句柄就是旧代际的可观测面。
    manager.start("s5", "global");
    await pollUntil("第一代装载完成", () => poolEntry(manager)?.id !== undefined);
    // 轮询已等到条目建立，此处断言存在；旧句柄恒存在（真装载链产物）。
    const oldEntry = poolEntry(manager)!;
    const oldHandle = oldEntry.handle!;
    // 受控重建：connect 走 connectInternal 的 force 分支（先 disposeServer 旧 id 再挂新实例）。
    await manager.connect("s5", "global");
    return { manager, oldEntry, oldHandle };
  }

  it("B5：受控重建释放旧代际（旧句柄被 dispose）", async () => {
    const { oldHandle } = await rebuiltEntry();
    await pollUntil("旧代际已释放", () => oldHandle.disposed === true);
    expect(oldHandle.disposed).toBe(true);
  });

  it("新代际已替换", async () => {
    const { manager, oldEntry } = await rebuiltEntry();
    await pollUntil("新代际已装载", () => {
      const entry = poolEntry(manager);
      return entry !== undefined && entry !== oldEntry && entry.id !== undefined;
    });
    expect(poolEntry(manager) === oldEntry).toBe(false);
  });

  it("旧条目 disposed 置位", async () => {
    const { oldEntry } = await rebuiltEntry();
    expect(oldEntry.disposed).toBe(true);
  });
});

// B5（续）：重复触达不重复装载 ----
describe("B5 红测（续）：重复触达不重复装载", () => {
  const poolEntry = (manager: McpManagerType) =>
    manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)?.connections.get("s5");

  async function startedEntry() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5b-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("s5")));
    manager.start("s5", "global");
    await pollUntil("第一代装载完成", () => poolEntry(manager)?.id !== undefined);
    return { manager };
  }

  it("B5：重复 start 不重建（同 (root, 裸名) 一条条目）", async () => {
    const { manager } = await startedEntry();
    const entry = poolEntry(manager);
    manager.start("s5", "global");
    expect(poolEntry(manager)).toBe(entry);
  });

  it("B5：重复 connect 受控重建后仍只有一条条目", async () => {
    const { manager } = await startedEntry();
    const oldEntry = poolEntry(manager);
    await manager.connect("s5", "global");
    expect(poolEntry(manager) === oldEntry).toBe(false);
    expect(manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)!.connections.size).toBe(1);
  });
});

// B5（续）：顺序不变式——旧代际先释放、新代际后挂载 ----
// 换引擎后「工具注册/注销」归官方实例自己的 apply/dispose，本层能判的同一不变式落在账本键上：
// 同 id 的新代际必须在旧代际结算**之后**才挂载（否则官方 serverName 活体预留当场抛，裁定 V）。
describe("B5 红测（续）：顺序不变式（旧代际先释放）", () => {
  it("B5：顺序不变式——旧代际释放先于新代际挂载（受控重建路径）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5c-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("s5")));
    // [调用, 序号] 元组表：序号恒为 number，调用恒有 [0] 动作名。
    const mountsAt = (): Array<[unknown, number]> =>
      poolLoader!.calls
        .map((call, index): [unknown, number] => [call, index])
        .filter(([call]) => (call as unknown[])[0] === "mount");
    manager.start("s5", "global");
    await pollUntil("旧代际已挂载", () => mountsAt().length >= 1);
    const firstMount = mountsAt()[0][1];
    // 受控重建（用户显式 connect）：强制换代际。
    await manager.connect("s5", "global");
    await pollUntil("新代际已挂载", () => mountsAt().length >= 2);
    const disposeAt = poolLoader!.calls.findIndex((call) => call[0] === "dispose");
    const secondMount = mountsAt()[1][1];
    expect(firstMount >= 0 && disposeAt > firstMount && secondMount > disposeAt).toBeTruthy();
  });
});

// #903 M4/M5-A：fire-and-forget 拒绝处理 + 缓存命中 settle ----
describe("#903 M4/M5-A：浮空拒绝记 warn、缓存命中同样 settle", () => {
  function regressionFixture() {
    const { dir, manager, log } = managerFixture("dsh-mcp-m4-");
    // 项目目录：<dir>/proj/.git（findProjectRoot 的真实标记，与 setSession 用例同形）。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    return { dir, manager, log, proj };
  }

  it("M4-a：setSession 触达单元失败 → warn 落日志、调用方不抛", async () => {
    const { manager, log, proj } = regressionFixture();
    manager.middleware = {
      projectUnitFor: async () => {
        throw new Error("boom-touch");
      },
    } as unknown as McpManagerType["middleware"];
    // 反证：把 setSession 的拒绝处理删掉 → 无 warn，pollUntil 超时红。
    await manager.setSession(proj);
    await pollUntil("touch 失败 warn", () =>
      log.warn.some((message) => message.includes("setSession touch unit")),
    );
    expect(
      log.warn.some(
        (message) => message.includes("setSession touch unit") && message.includes("failed"),
      ),
    ).toBe(true);
  });

  it("M4-b：touchGlobalUnit 内层连接失败 → 外层 catch 记 warn", async () => {
    const { manager, log } = regressionFixture();
    const unit = { root: MIDDLEWARE_GLOBAL_ROOT, userDisabled: new Set<string>() };
    manager.middleware = {
      projectUnitFor: async () => unit,
      ensureConnected: async () => {
        throw new Error("boom-conn");
      },
    } as unknown as McpManagerType["middleware"];
    // 反证：把 .then 回调里的 await 改回内层 void → 外层 catch 接不到，warn 缺席红。
    (manager as unknown as { touchGlobalUnit: (name: string) => void }).touchGlobalUnit("g1");
    await pollUntil("touchGlobalUnit 失败 warn", () =>
      log.warn.some((message) => message.includes("touchGlobalUnit(g1) failed")),
    );
    expect(log.warn.some((message) => message.includes("touchGlobalUnit(g1) failed"))).toBe(true);
  });

  it("M5-A：缓存命中后旧扁平重现 → 再次 projectStoreFor 同样归位", async () => {
    const { manager, proj } = regressionFixture();
    const legacy = join(proj, ".dsh", "mcp.json");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        servers: [{ name: "p-old", transport: "stdio", command: "pcmd" }],
      }),
    );
    const first = await manager.projectStoreFor(proj);
    expect(first!.data.servers.map((server) => server.name)).toContain("p-old");
    // 降级写：旧扁平重现（切旧分支/降级写回）。
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        servers: [{ name: "p-downgraded", transport: "stdio", command: "pcmd" }],
      }),
    );
    // 反证：命中分支去掉 settle 包装 → 旧文件永不归位，existsSync(legacy) 恒真红。
    const second = await manager.projectStoreFor(proj);
    expect(second).toBe(first);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated.bak.2`)).toBe(true);
    // 目标不被历史覆盖：命中分支的 settle 只归档，读到仍是归位前的内容。
    expect(second!.data.servers.map((server) => server.name)).toContain("p-old");
  });
});
