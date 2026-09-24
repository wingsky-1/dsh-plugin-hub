/**
 * dsh-mcp-manager — unit：McpManager.add / update / connect 方法补齐。
 *
 * 覆盖：
 * - McpManager.add：重复名抛错、enabled:false 不 start、正常添加
 * - McpManager.update：不存在抛错、更新后 stop+start 重建
 * - McpManager.connect：不存在抛错、已连接跳过、跨 scope 冲突抛错
 * - 边缘：projectStoreOrThrow 用于 project scope
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
// S6-B2：McpManager 构造是装配依赖，留包根；纯符号改道域门面（apply 仍经包根动态导入，见下）。
import { McpManager } from "../../src/index.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import { SCOPE_PROJECT } from "../../src/shared/interface.ts";
import { normalizeServer } from "../../src/server/config/interface.ts";
import { stripMcpPrefix } from "../../src/server/connection/orchestrator/tool-names.ts";
import { fakeManagerCtx } from "../helpers.ts";

const { apply } = await import("../../src/index.ts");

let tempDirs: string[] = [];
let managers: McpManager[] = [];

function makeTempDir(prefix: string) {
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
function makeManager(store: McpStore) {
  const manager = new McpManager(fakeManagerCtx(), store);
  managers.push(manager);
  return manager;
}

function fixture() {
  const { store, path } = tempStore();
  return { store, path, manager: makeManager(store) };
}

/** 为 manager 挂上项目级 store（project scope 写入路径）。 */
async function attachProjectStore(manager: McpManager, prefix: string) {
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
    expect(store.find("srv-a")!.name).toBe("srv-a");
  });

  it("重复名抛错（already exists）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "srv-a", transport: "stdio", command: "echo" });
    await expect(
      manager.add({ name: "srv-a", transport: "stdio", command: "echo" }),
    ).rejects.toThrow(/already exists/);
  });

  it("enabled:false 不报错且返回 enabled:false", async () => {
    const { manager } = fixture();
    const disabled = await manager.add({
      name: "srv-off",
      transport: "stdio",
      command: "echo",
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
  });

  it("enabled:false 仍落盘", async () => {
    const { store, manager } = fixture();
    await manager.add({ name: "srv-off", transport: "stdio", command: "echo", enabled: false });
    expect(store.find("srv-off")!.enabled).toBe(false);
  });

  it("project scope 有 projectStore 时写入项目级（返回值）", async () => {
    const { manager } = fixture();
    await attachProjectStore(manager, "dsh-mcp-manager-proj-");
    const projServer = await manager.add(
      { name: "proj-srv", transport: "stdio", command: "echo" },
      SCOPE_PROJECT,
    );
    expect(projServer.name).toBe("proj-srv");
  });

  it("project scope 有 projectStore 时写入项目级（项目 store 落盘）", async () => {
    const { manager } = fixture();
    const { projStore } = await attachProjectStore(manager, "dsh-mcp-manager-proj-");
    await manager.add({ name: "proj-srv", transport: "stdio", command: "echo" }, SCOPE_PROJECT);
    expect(projStore.find("proj-srv")!.name).toBe("proj-srv");
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
    expect(store.find("upd")!.command).toBe("cat");
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

  it("连接后池内条目已登记（单池后唯一账本是单元表）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });
    await manager.initMiddleware();
    // 连接（smoke 已测 SDK 端到端，此处只验证方法不抛且池内条目已登记）
    await manager.connect("conn");
    const unit = manager.middleware!.units.get("@global")!;
    expect(unit.connections.get("conn")).toBeDefined();
  });

  it("已连接时重复 connect 不抛（返回 early）", async () => {
    const { manager } = fixture();
    await manager.add({ name: "conn", transport: "stdio", command: "echo" });
    await manager.initMiddleware();
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
    // 故意缺 inject 方法的残缺宿主：apply 必须静默降级。残缺形状按接缝收窄（运行时原样传入）。
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
    await expect(
      apply(noInjectCtx as unknown as Context, {
        enabled: false,
        storePath: join(dir, "mcp.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("settings.describe 抛错时降级（不抛）", async () => {
    // settings 服务存在但 describe 抛错 → 回落 entry
    const failSettingsCtx = {
      logger: { warn: () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              describe: () => {
                throw new Error("describe failed");
              },
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
    await expect(
      apply(failSettingsCtx as unknown as Context, {
        enabled: false,
        storePath: join(dir, "mcp.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("settings 缺少 register 时降级（不抛）", async () => {
    // settings 服务存在但 register 不是函数
    const noRegCtx = {
      logger: { warn: () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
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
    await expect(
      apply(noRegCtx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") }),
    ).resolves.toBeUndefined();
  });
});

// S2-b 接线判据（既有文件内选一处，不新增文件）：旧扁平夹具 + projectStoreFor →
// 新路径落内容 + 旧文件归档 .migrated.bak + store 读到条目（第九键 + settle + 读取三段一次证全）。
describe("S2-b：projectStoreFor 经 upgrade 端口落定新形态", () => {
  it("旧扁平夹具 + projectStoreFor → 新路径落内容 + 旧文件归档 + store 读到条目", async () => {
    const { manager } = fixture();
    const projDir = makeTempDir("dsh-mcp-manager-settle-");
    mkdirSync(join(projDir, ".dsh"), { recursive: true });
    const legacyPath = join(projDir, ".dsh", "mcp.json");
    const newPath = join(projDir, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        servers: [{ name: "p-settle", transport: "stdio", command: "echo" }],
      }),
    );
    const store = await manager.projectStoreFor(projDir);
    expect(store!.data.servers.map((s) => s.name)).toContain("p-settle");
    expect(JSON.parse(readFileSync(newPath, "utf8")).servers[0].name).toBe("p-settle");
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated.bak`)).toBe(true);
  });
});

// S2-D 接线判据（P4 后半）：per-root 落定失败 → 调用方失败（fail-closed，禁回落 undefined）。
describe("S2-D：projectStoreFor 经 settle 包装穿透 per-root 失败", () => {
  it("旧扁平不可读 → projectStoreFor 抛错且不缓存半成品，重试仍抛（非静默空配置）", async () => {
    const { manager } = fixture();
    const projDir = makeTempDir("dsh-mcp-manager-settle-fail-");
    mkdirSync(join(projDir, ".dsh"), { recursive: true });
    // 旧扁平落点做成目录：读源即抛 EISDIR（确定性失败，不依赖权限位）。
    mkdirSync(join(projDir, ".dsh", "mcp.json"));
    await expect(manager.projectStoreFor(projDir)).rejects.toThrow(/不可读/);
    expect(manager.projectStores.has(projDir)).toBe(false);
    await expect(manager.projectStoreFor(projDir)).rejects.toThrow(/不可读/);
  });
});
// CRAP-ZERO batch1 manager
describe("CRAP-ZERO stripMcpPrefix", () => {
  it("strips prefix", () => {
    expect(stripMcpPrefix("mcp__ctx__use_ctx", "ctx")).toBe("use_ctx");
  });
  it("non-matching returns original", () => {
    expect(stripMcpPrefix("use_ctx", "ctx")).toBe("use_ctx");
  });
  it("empty after strip returns original", () => {
    expect(stripMcpPrefix("mcp__ctx__", "ctx")).toBe("mcp__ctx__");
  });
  it("still mcp prefix returns original", () => {
    expect(stripMcpPrefix("mcp__ctx__mcp__other__t", "ctx")).toBe("mcp__ctx__mcp__other__t");
  });
});
// CRAP-ZERO batch1 setToolDisabled
describe("CRAP-ZERO setToolDisabled", () => {
  it("disables and re-enables tool", async () => {
    const prevHome = process.env.DSH_HOME;
    const homeDir = makeTempDir("dsh-mcp-home-");
    process.env.DSH_HOME = homeDir;
    try {
      const { manager } = fixture();
      await manager.setToolDisabled("/proj", "ctx", "use_ctx", true);
      expect(manager.disabledTools.get("/proj")?.get("ctx")?.has("use_ctx")).toBe(true);
      await manager.setToolDisabled("/proj", "ctx", "use_ctx", false);
      const has = manager.disabledTools.get("/proj")?.get("ctx")?.has("use_ctx") ?? false;
      expect(has).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });
});
