// @ts-nocheck
/**
 * dsh-mcp-manager — unit：McpManager.add / update / connect 方法补齐。
 *
 * 覆盖：
 * - McpManager.add：重复名抛错、enabled:false 不 start、正常添加
 * - McpManager.update：不存在抛错、更新后 stop+start 重建
 * - McpManager.connect：不存在抛错、已连接跳过、跨 scope 冲突抛错
 * - 边缘：projectStoreOrThrow 用于 project scope
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, McpStore, SCOPE_GLOBAL, SCOPE_PROJECT, normalizeServer } from "../src/index.ts";

/** 创建一个最小 mock store（临时文件，已加载）。 */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-unit-"));
  const path = join(dir, "mcp.json");
  const store = new McpStore(path);
  store.data = { version: 1, servers: [] };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { store, path, dir, cleanup };
}

/** 创建一个最小 McpManager（暂不 startAll，不连接真实服务器）。 */
function makeManager(store) {
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const ctx = { logger };
  return new McpManager(ctx, store);
}

// ---- McpManager.add ----

{
  const { store, cleanup } = tempStore();
  try {
    const manager = makeManager(store);

    // 正常添加
    const server = await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
    assert.equal(server.name, "srv-a");
    assert.equal(server.enabled, true);
    assert.equal(store.find("srv-a").name, "srv-a", "已落盘");

    // 重复名抛错
    try {
      await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
      assert.fail("应抛错");
    } catch (err) {
      assert.match(err.message, /already exists/);
    }

    // enabled:false 不报错（不 start，但落盘）
    const disabled = await manager.add({ name: "srv-off", transport: "stdio", command: "echo", enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(store.find("srv-off").enabled, false);

    // project scope 有 projectStore 时写入项目级
    // 先构建 project store
    const projDir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-proj-"));
    try {
      const projStore = new McpStore(join(projDir, ".dsh", "mcp.json"));
      await projStore.load();
      manager.projectStores.set(projDir, projStore);
      manager.projectStore = projStore;
      manager.projectRoot = projDir;

      const projServer = await manager.add({ name: "proj-srv", transport: "stdio", command: "echo" }, SCOPE_PROJECT);
      assert.equal(projServer.name, "proj-srv");
      assert.equal(projStore.find("proj-srv").name, "proj-srv");
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }

    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---- McpManager.update ----

{
  const { store, cleanup } = tempStore();
  try {
    const manager = makeManager(store);
    await manager.add({ name: "upd", transport: "stdio", command: "echo" });

    // 正常更新
    const updated = await manager.update("upd", { command: "cat" });
    assert.equal(updated.command, "cat");
    assert.equal(store.find("upd").command, "cat", "落盘更新");

    // 不存在的名抛错
    try {
      await manager.update("nonexistent", { command: "x" });
      assert.fail("应抛错");
    } catch (err) {
      assert.match(err.message, /not found/);
    }

    // project scope 且 projectStore 存在时写入项目级
    const projDir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-upd-"));
    try {
      const projStore = new McpStore(join(projDir, ".dsh", "mcp.json"));
      await projStore.load();
      projStore.upsert(normalizeServer({ name: "p-upd", transport: "stdio", command: "echo" }));
      manager.projectStores.set(projDir, projStore);
      manager.projectStore = projStore;
      manager.projectRoot = projDir;

      const pUpdated = await manager.update("p-upd", { command: "cat" }, SCOPE_PROJECT);
      assert.equal(pUpdated.command, "cat");
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }

    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---- McpManager.connect ----

{
  const { store, cleanup } = tempStore();
  try {
    const manager = makeManager(store);
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });

    // 不存在抛错
    try {
      await manager.connect("no-such");
      assert.fail("应抛错");
    } catch (err) {
      assert.match(err.message, /not found/);
    }

    // 连接（smoke 已测 SDK 端到端，此处只验证方法不抛且 supervisor 已登记）
    await manager.connect("conn");
    const supervisor = manager.supervisors.get("conn");
    assert.ok(supervisor !== undefined, "supervisor 已登记");

    // 已连接时重复 connect 不抛（返回 early）
    await manager.connect("conn");

    // project scope 没有 projectStore 抛错
    try {
      await manager.connect("nope", SCOPE_PROJECT);
      assert.fail("应抛错");
    } catch (err) {
      assert.match(err.message, /no active project/);
    }

    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---- 通过 apply 间接覆盖 installSettingsNamespace 和 isUnloading ----

{
  // 通过 fakeCtx 模拟 apply 的 settings 注入路径
  // 覆盖 installSettingsNamespace 的 ctx.inject 不可用分支
  const noInjectCtx = {
    logger: { warn: () => {} },
    // 没有 inject 方法
    effect: () => () => {},
    on: () => () => {},
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  };
  // 不抛即可（ctx.inject 不可用时静默降级）
  const { apply } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-ni-"));
  try {
    await apply(noInjectCtx, { enabled: false, storePath: join(dir, "mcp.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 通过 apply 间接覆盖 installSettingsNamespace 的 settings.register 失败分支 ----

{
  // settings 服务存在但 register 抛错
  const failSettingsCtx = {
    logger: { warn: () => {} },
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) {
        cb({
          settings: {
            register: () => { throw new Error("register failed"); },
          },
          effect: () => () => {},
        });
      }
      return () => {};
    },
    effect: () => () => {},
    on: () => () => {},
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  };
  const { apply } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-sf-"));
  try {
    await apply(failSettingsCtx, { enabled: false, storePath: join(dir, "mcp.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 通过 apply 间接覆盖 installSettingsNamespace 的 settings 缺少 register 分支 ----

{
  // settings 服务存在但 register 不是函数
  const noRegCtx = {
    logger: { warn: () => {} },
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) {
        cb({
          settings: {},
          effect: () => () => {},
        });
      }
      return () => {};
    },
    effect: () => () => {},
    on: () => () => {},
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  };
  const { apply } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-nr-"));
  try {
    await apply(noRegCtx, { enabled: false, storePath: join(dir, "mcp.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}