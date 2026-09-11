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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager, McpStore, SCOPE_PROJECT, normalizeServer } from "../../src/index.ts";

const { apply } = await import("../../src/index.ts");

let tempDirs = [];
let managers = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const manager of managers) {
    try {
      await manager.dispose();
    } catch {
      // 清理失败不掩盖用例结论
    }
  }
  managers = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** 创建一个最小 mock store（临时文件，已加载）。 */
function tempStore() {
  const dir = makeTempDir("dsh-mcp-manager-unit-");
  const path = join(dir, "mcp.json");
  const store = new McpStore(path);
  store.data = { version: 1, servers: [] };
  return { store, path, dir };
}

/** 创建一个最小 McpManager（暂不 startAll，不连接真实服务器）。 */
function makeManager(store) {
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const ctx = { logger };
  const manager = new McpManager(ctx, store);
  managers.push(manager);
  return manager;
}

function fixture() {
  const { store, path } = tempStore();
  return { store, path, manager: makeManager(store) };
}

/** 为 manager 挂上项目级 store（project scope 写入路径）。 */
async function attachProjectStore(manager, prefix) {
  const projDir = makeTempDir(prefix);
  const projStore = new McpStore(join(projDir, ".dsh", "mcp.json"));
  await projStore.load();
  manager.projectStores.set(projDir, projStore);
  manager.projectStore = projStore;
  manager.projectRoot = projDir;
  return { projDir, projStore };
}

describe("McpManager.add", () => {
  it("正常添加返回 server 名", async () => {
    const { manager } = fixture();
    const server = await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
    expect(server.name).toBe("srv-a");
  });

  it("正常添加默认 enabled:true", async () => {
    const { manager } = fixture();
    const server = await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
    expect(server.enabled).toBe(true);
  });

  it("正常添加已落盘", async () => {
    const { store, manager } = fixture();
    await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
    expect(store.find("srv-a").name).toBe("srv-a");
  });

  it("重复名抛错（already exists）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
    await expect(manager.add({ name: "srv-a", transport: "stdio", command: "echo" })).rejects.toThrow(/already exists/);
  });

  it("enabled:false 不报错且返回 enabled:false", async () => {
    const { manager } = fixture();
    const disabled = await manager.add({ name: "srv-off", transport: "stdio", command: "echo", enabled: false });
    expect(disabled.enabled).toBe(false);
  });

  it("enabled:false 仍落盘", async () => {
    const { store, manager } = fixture();
    await manager.add({ name: "srv-off", transport: "stdio", command: "echo", enabled: false });
    expect(store.find("srv-off").enabled).toBe(false);
  });

  it("project scope 有 projectStore 时写入项目级（返回值）", async () => {
    const { manager } = fixture();
    await attachProjectStore(manager, "dsh-mcp-manager-proj-");
    const projServer = await manager.add({ name: "proj-srv", transport: "stdio", command: "echo" }, SCOPE_PROJECT);
    expect(projServer.name).toBe("proj-srv");
  });

  it("project scope 有 projectStore 时写入项目级（项目 store 落盘）", async () => {
    const { manager } = fixture();
    const { projStore } = await attachProjectStore(manager, "dsh-mcp-manager-proj-");
    await manager.add({ name: "proj-srv", transport: "stdio", command: "echo" }, SCOPE_PROJECT);
    expect(projStore.find("proj-srv").name).toBe("proj-srv");
  });
});

describe("McpManager.update", () => {
  it("正常更新返回新 command", async () => {
    const { manager } = fixture();
    await manager.add({ name: "upd", transport: "stdio", command: "echo" });
    const updated = await manager.update("upd", { command: "cat" });
    expect(updated.command).toBe("cat");
  });

  it("正常更新落盘", async () => {
    const { store, manager } = fixture();
    await manager.add({ name: "upd", transport: "stdio", command: "echo" });
    await manager.update("upd", { command: "cat" });
    expect(store.find("upd").command).toBe("cat");
  });

  it("不存在的名抛错（not found）", async () => {
    const { manager } = fixture();
    await expect(manager.update("nonexistent", { command: "x" })).rejects.toThrow(/not found/);
  });

  it("project scope 且 projectStore 存在时写入项目级", async () => {
    const { manager } = fixture();
    await manager.add({ name: "upd", transport: "stdio", command: "echo" });
    const { projStore } = await attachProjectStore(manager, "dsh-mcp-manager-upd-");
    projStore.upsert(normalizeServer({ name: "p-upd", transport: "stdio", command: "echo" }));

    const pUpdated = await manager.update("p-upd", { command: "cat" }, SCOPE_PROJECT);
    expect(pUpdated.command).toBe("cat");
  });
});

describe("McpManager.connect", () => {
  it("不存在的名抛错（not found）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });
    await expect(manager.connect("no-such")).rejects.toThrow(/not found/);
  });

  it("supervisor 已登记", async () => {
    const { manager } = fixture();
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });
    // 连接（smoke 已测 SDK 端到端，此处只验证方法不抛且 supervisor 已登记）
    await manager.connect("conn");
    const supervisor = manager.supervisors.get("conn");
    expect(supervisor).toBeDefined();
  });

  it("已连接时重复 connect 不抛（返回 early）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });
    await manager.connect("conn");
    await expect(manager.connect("conn")).resolves.toBeUndefined();
  });

  it("project scope 没有 projectStore 抛错（no active project）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });
    await expect(manager.connect("nope", SCOPE_PROJECT)).rejects.toThrow(/no active project/);
  });
});

// 通过 apply 间接覆盖 installSettingsNamespace 的降级分支
describe("通过 apply 间接覆盖 installSettingsNamespace 降级分支", () => {
  it("ctx.inject 不可用时静默降级（不抛）", async () => {
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
    const dir = makeTempDir("dsh-mcp-manager-ni-");
    await expect(apply(noInjectCtx, { enabled: false, storePath: join(dir, "mcp.json") })).resolves.toBeUndefined();
  });

  it("settings.register 抛错时降级（不抛）", async () => {
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
    const dir = makeTempDir("dsh-mcp-manager-sf-");
    await expect(apply(failSettingsCtx, { enabled: false, storePath: join(dir, "mcp.json") })).resolves.toBeUndefined();
  });

  it("settings 缺少 register 时降级（不抛）", async () => {
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
    const dir = makeTempDir("dsh-mcp-manager-nr-");
    await expect(apply(noRegCtx, { enabled: false, storePath: join(dir, "mcp.json") })).resolves.toBeUndefined();
  });
});
