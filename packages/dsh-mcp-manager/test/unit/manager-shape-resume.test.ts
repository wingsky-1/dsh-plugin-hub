/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdirSync, realpathSync } from "node:fs";

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { FakeToolEntry } from "../helpers.ts";

import {
  loaderScript,
  managerFixture,
  McpStore,
  normalizeServer,
  poolLoader,
  quietServer,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

import {
  connectGlobal,
  disposeCount,
  liveGlobal,
  mountCount,
  prefixFor,
  registerResumeHooks,
} from "./manager-shape-resume-fixture.ts";
function registerHealthyAndConcurrentResume() {
  it("健康连接 resume：同条目对象、零新增 mount、零 dispose（代际保留）", async () => {
    const { manager } = await liveGlobal("g");
    const unit = await connectGlobal(manager, "g");
    const entry = prefixFor(manager, "@global", "g");
    const mounts = mountCount();
    const disposes = disposeCount();
    await manager.resumeReconnect();
    expect(unit.connections.get("g")).toBe(entry);
    expect(mountCount()).toBe(mounts);
    expect(disposeCount()).toBe(disposes);
    expect(manager.middleware!.statusOf("@global", "g")).toBe("connected");
  });

  it("同 root 并发重复恢复合并为单 connect attempt（在途去重）", async () => {
    // 装载窗口挂起时重复恢复必须合并：deferred 下两个 resume 共享同一 attempt。
    const { manager } = await liveGlobal("g");
    loaderScript.ready = "deferred";
    await manager.initMiddleware();
    const first = manager.resumeReconnect();
    const second = manager.resumeReconnect();
    await pollUntil("单 attempt 建连中", () => mountCount() === 1);
    // 窗口未放闸前充分排空微任务：重复 attempt 会在此现形为第 2 次 mount。
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    let readySettled = false;
    poolLoader!.handles[0]!.ready.then(() => {
      readySettled = true;
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(readySettled).toBe(false);
    expect(manager.middleware!.units.get("@global")?.connections.get("g")?.id).toBeUndefined();
    expect(mountCount()).toBe(1);
    poolLoader!.settleReady();
    await Promise.all([first, second]);
    expect(manager.middleware!.units.get("@global")?.connections.has("g")).toBe(true);
  });
}
function registerResumeRecovery() {
  it("entry 缺失恢复：release 后 resume 重建（mount+1、条目换代际）", async () => {
    const { manager } = await liveGlobal("g");
    const unit = await connectGlobal(manager, "g");
    const before = prefixFor(manager, "@global", "g");
    manager.middleware!.releaseConnection("@global", "g");
    expect(unit.connections.has("g")).toBe(false);
    const mounts = mountCount();
    await manager.resumeReconnect();
    const after = unit.connections.get("g")!;
    expect(mountCount()).toBe(mounts + 1);
    expect(after).not.toBe(before);
    // 同一 (root, name) 复用同一 id：注册面前缀仍命中，新代际照实 connected。
    expect(after.id).toBe(before.id);
    expect(manager.middleware!.statusOf("@global", "g")).toBe("connected");
  });

  it("真正失败恢复：failed 条目 resume 重建（mount+1、旧代际被 dispose）", async () => {
    const { manager } = await liveGlobal("g");
    const unit = await connectGlobal(manager, "g");
    // 注册面无前缀 → 首连即 failed（quietServer 关重连，半开语义不适用）。
    expect(manager.middleware!.statusOf("@global", "g")).toBe("failed");
    const before = unit.connections.get("g")!;
    const mounts = mountCount();
    const disposes = disposeCount();
    await manager.resumeReconnect();
    expect(mountCount()).toBe(mounts + 1);
    expect(disposeCount()).toBeGreaterThan(disposes);
    expect(unit.connections.get("g")).not.toBe(before);
  });

  it("官方 reconnecting 保留：不断开、不重建（官方退避优先）", async () => {
    // 重连开启的服务器：连上过（everConnected）后注册面前缀消失 → reconnecting。
    const fixture = managerFixture("dsh-mcp-mgr2live-");
    fixture.store.upsert(
      normalizeServer({ name: "gr", transport: "stdio", command: "dsh-noop-cmd" }),
    );
    await fixture.manager.initMiddleware();
    const { manager } = fixture;
    const unit = await connectGlobal(manager, "gr");
    // 首代 settle 时无前缀（failed，everConnected=false）：先把前缀补上再显式 force
    // 重建一代——同一 id 在窗口内即见前缀，新代际 settle 为 connected 且 everConnected。
    const first = unit.connections.get("gr")!;
    const tools = manager.ctx.tools as unknown as { entries: FakeToolEntry[] };
    tools.entries = [{ name: `mcp__${first.id}__t` }];
    await manager.connect("gr");
    const entry = unit.connections.get("gr")!;
    expect(entry).not.toBe(first);
    expect(manager.middleware!.statusOf("@global", "gr")).toBe("connected");
    tools.entries = [];
    expect(manager.middleware!.statusOf("@global", "gr")).toBe("reconnecting");
    const mounts = mountCount();
    const disposes = disposeCount();
    await manager.resumeReconnect();
    expect(unit.connections.get("gr")).toBe(entry);
    expect(mountCount()).toBe(mounts);
    expect(disposeCount()).toBe(disposes);
  });

  it("userDisabled 不复活（disconnect 后 resume 不重建）", async () => {
    const { manager } = await liveGlobal("g");
    await connectGlobal(manager, "g");
    prefixFor(manager, "@global", "g");
    await manager.disconnect("g");
    const mounts = mountCount();
    await manager.resumeReconnect();
    expect(manager.middleware!.units.get("@global")?.connections.has("g")).toBe(false);
    expect(mountCount()).toBe(mounts);
  });

  it("显式 force 仍确实重建（connect 走 force：换代际、旧代际 dispose）", async () => {
    const { manager } = await liveGlobal("g");
    const unit = await connectGlobal(manager, "g");
    const before = prefixFor(manager, "@global", "g");
    const mounts = mountCount();
    const disposes = disposeCount();
    await manager.connect("g");
    expect(mountCount()).toBe(mounts + 1);
    expect(disposeCount()).toBeGreaterThan(disposes);
    expect(unit.connections.get("g")).not.toBe(before);
  });
}
function registerCrossRootResume() {
  it("A/B root 异步交错：各回各的单元，不串 root", async () => {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2live-");
    const projA = join(dir, "projA");
    const projB = join(dir, "projB");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    mkdirSync(join(projA, ".git"), { recursive: true });
    mkdirSync(join(projB, ".git"), { recursive: true });
    const subA = join(projA, "work");
    const subB = join(projB, "work");
    mkdirSync(subA, { recursive: true });
    mkdirSync(subB, { recursive: true });
    const rootA = realpathSync(projA);
    const rootB = realpathSync(projB);
    const storeA = new McpStore(join(projA, ".dsh", "mcp.json"));
    storeA.data = { version: 1, servers: [normalizeServer(quietServer("a1"))] };
    const storeB = new McpStore(join(projB, ".dsh", "mcp.json"));
    storeB.data = { version: 1, servers: [normalizeServer(quietServer("b1"))] };
    manager.projectStores.set(rootA, storeA);
    manager.projectStores.set(rootB, storeB);
    // 并发可变字段指向 A：B 的恢复不得被带偏。
    manager.projectRoot = rootA;
    await manager.initMiddleware();
    await Promise.all([manager.resumeReconnect(subA), manager.resumeReconnect(subB)]);
    const unitA = manager.middleware!.units.get(rootA)!;
    const unitB = manager.middleware!.units.get(rootB)!;
    expect([...unitA.connections.keys()].sort()).toEqual(["a1"]);
    expect([...unitB.connections.keys()].sort()).toEqual(["b1"]);
  });

  it("A 健康 + B 在途时 resume(A)：不 dispose、不换 B 条目（跨单元零干扰）", async () => {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2live-");
    const projA = join(dir, "projA");
    const projB = join(dir, "projB");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    mkdirSync(join(projA, ".git"), { recursive: true });
    mkdirSync(join(projB, ".git"), { recursive: true });
    const subA = join(projA, "work");
    mkdirSync(subA, { recursive: true });
    const rootA = realpathSync(projA);
    const rootB = realpathSync(projB);
    const storeA = new McpStore(join(projA, ".dsh", "mcp.json"));
    storeA.data = { version: 1, servers: [normalizeServer(quietServer("a1"))] };
    const storeB = new McpStore(join(projB, ".dsh", "mcp.json"));
    storeB.data = { version: 1, servers: [normalizeServer(quietServer("b1"))] };
    manager.projectStores.set(rootA, storeA);
    manager.projectStores.set(rootB, storeB);
    manager.projectRoot = rootA;
    await manager.initMiddleware();
    // A 先真装健康（注册面前缀 → connected）。
    await manager.resumeReconnect(subA);
    const unitA = manager.middleware!.units.get(rootA)!;
    const entryA = prefixFor(manager, rootA, "a1");
    // B 挂起在途：deferred 下先建单元（后台建连卡在装载窗口）。
    loaderScript.ready = "deferred";
    const mountsBeforeB = mountCount();
    const touchB = manager.middleware!.projectUnitFor(rootB);
    await pollUntil("b1 装载在途", () => mountCount() === mountsBeforeB + 1);
    const unitB = manager.middleware!.units.get(rootB)!;
    const entryB = unitB.connections.get("b1")!;
    expect(entryB.id, "在途条目尚无 id 回填").toBe(undefined);
    const mounts = mountCount();
    const disposes = disposeCount();
    // resume(A)：A 健康短路、B 条目对象不变、零新增 mount/dispose。
    await manager.resumeReconnect(subA);
    expect(unitA.connections.get("a1")).toBe(entryA);
    expect(unitB.connections.get("b1")).toBe(entryB);
    expect(mountCount()).toBe(mounts);
    expect(disposeCount()).toBe(disposes);
    expect(manager.middleware!.statusOf(rootA, "a1")).toBe("connected");
    // 放闸：B 在途 attempt 正常结算（不断言状态，只断代际未被换过）。
    poolLoader!.settleReady();
    await touchB;
    await pollUntil("b1 在途结算且 id 回填", () => entryB.id !== undefined);
    expect(unitB.connections.get("b1")).toBe(entryB);
  });
}
setupManagerTestLifecycle();
describe("#1120 resume 真实链路接缝", () => {
  registerResumeHooks();
  registerHealthyAndConcurrentResume();
  registerResumeRecovery();
  registerCrossRootResume();
});
