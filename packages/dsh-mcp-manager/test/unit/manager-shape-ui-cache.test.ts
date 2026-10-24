/** Manager 方法面的自然职责测试与专属fixture。 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  makeHealthRoute,
  makeManager,
  makeTempDir,
  managerFixture,
  quietServer,
  ROUTES,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

function writableFixture() {
  const fixture = managerFixture();
  let captured: unknown;
  fixture.manager.uiUpdate = async (patch) => {
    captured = patch;
    // ui 形态由调用方保证（本用例传入完整 ui 面），此处按测试前置收窄。
    const ui = patch.ui as {
      position: unknown;
      offset: { x: unknown; y: unknown; blankY: unknown };
      zIndexBase: unknown;
    };
    // 模拟 settings 落盘后 setSource 更新（apply 内 installSettingsNamespace 行为）。
    fixture.manager.uiConfigSource = () => ({
      position: ui.position,
      offsetX: ui.offset.x,
      offsetY: ui.offset.y,
      blankY: ui.offset.blankY,
      zIndexBase: ui.zIndexBase,
    });
  };
  return { ...fixture, captured: () => captured };
}

function statSafe(p: string) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}
setupManagerTestLifecycle();

// #767 S1-5b 笔 2（B4 对账）：装载路径的两条缺口服役 ----
// 缺口一（R4）：catalogCache 的写入此前只有「夹具直接 seed」与「方法级直调 recordCatalogTools」
// 两类用例，缺「挂载结算自动写入」这半边（生产侧在 manager.ts 的 mountEntry 结算分支）。
// 缺口二（R6）：/health 的顶层 payload 键集全仓零处断言，且既有 health 夹具是手工塞 map。
// 两条都走真链路：真 McpManager + 真 lifecycle + 假 loader（不 spawn 子进程，全离线）。
describe("#767 S1-5b：装载路径的 catalogCache 与 /health 口径", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2ld-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** health 路由的最小请求面：只给 isLoopbackRequest + guardLoopbackMethod 要的字段。 */
  // 最小请求面（只给路由实际读取的字段）：按接缝收窄。
  function healthReq(): IncomingMessage {
    return {
      method: "GET",
      url: ROUTES.health,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3080" },
    } as unknown as IncomingMessage;
  }

  function healthRes(): ServerResponse & { state: { status: number; body: string } } {
    const state: { status: number; body: string } = { status: 0, body: "" };
    return {
      state,
      writeHead(status: number) {
        state.status = status;
      },
      end(body: string) {
        state.body = body;
      },
    } as unknown as ServerResponse & { state: { status: number; body: string } };
  }

  /** 装一台全局服务器：经 lifecycle 真装载挂载，id 由假 id 表分配（单池：落 @global 单元）。 */
  async function mountedGlobalFixture() {
    const entry = { name: "mcp__id-1__echo", description: "回显给定的文本" };
    // 注册面必须在装载前就含该工具：挂载结算那一刻读的是注册面，事后补不进账本。
    const { manager } = makeManager(homeDir, [entry]);
    await manager.initMiddleware();
    await manager.registerServer({ ...quietServer("gn"), enabled: true });
    await pollUntil("全局服务器装载结算且注册面命中", () =>
      manager.registeredToolsFor("gn").some((tool) => tool.name === entry.name),
    );
    return { manager, entry };
  }

  it("R4：挂载结算自动把工具描述摘要写进 catalogCache", async () => {
    const { manager, entry } = await mountedGlobalFixture();
    // 判据先证明工具确实来自装载（不是夹具塞的），再看缓存。单池（#767 笔 1a）：
    // 工具面从池条目（单元 id + 注册面）取——旧直连账本 manager.supervisors 已退役。
    expect(manager.registeredToolsFor("gn").map((tool) => tool.name)).toEqual([entry.name]);
    expect(manager.catalogCache.get("gn")?.summary).toContain("回显给定的文本");
  });

  it("R6：/health 在 1 台挂载全局服务器下计数正确且顶层键集逐字相等", async () => {
    const { manager } = await mountedGlobalFixture();
    const res = healthRes();
    makeHealthRoute(manager).handler(healthReq(), res);
    expect(res.state.status, "health 200").toBe(200);
    const payload = JSON.parse(res.state.body);
    // 单池（#767 笔 1a）：三计数与 middleware 子对象都按池单元表聚合（该服务器在 @global 单元）。
    expect(payload.servers, "1 台服务器").toBe(1);
    expect(payload.connected, "已连接 1 台").toBe(1);
    expect(payload.tools, "工具计数").toBe(1);
    // 顶层键集逐字相等：键集事实源在 api/routes.ts 的 health 写出口。少键（诊断面丢字段）或多键
    // （把内部状态泄漏给诊断接口）都红，toMatchObject 这类子集断言抓不到这两类。
    expect(Object.keys(payload)).toEqual([
      "ok",
      "plugin",
      "servers",
      "connected",
      "tools",
      "catalogCacheEntries",
      "middleware",
    ]);
  });
});
describe("uiConfig / updateUiConfig / 目录缓存", () => {
  it("uiConfig 默认值", () => {
    const { manager } = managerFixture();
    expect(manager.uiConfig()).toEqual({
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 10,
    });
  });

  it("写不可用抛错（not writable）", async () => {
    const { manager } = managerFixture();
    await expect(manager.updateUiConfig({})).rejects.toThrow(/not writable/);
  });

  it("patch 归一化传递", async () => {
    const { manager, captured } = writableFixture();
    await manager.updateUiConfig({
      position: "bottom-right",
      offsetX: 3.4,
      offsetY: -1,
      blankY: 100,
    });
    expect(captured()).toEqual({
      ui: { position: "bottom-right", offset: { x: 3, y: 0, blankY: 100 }, zIndexBase: 10 },
    });
  });

  it("updateUiConfig 返回最新配置", async () => {
    const { manager } = writableFixture();
    const written = await manager.updateUiConfig({
      position: "bottom-right",
      offsetX: 3.4,
      offsetY: -1,
      blankY: 100,
    });
    expect(written).toEqual({
      position: "bottom-right",
      offsetX: 3,
      offsetY: 0,
      blankY: 100,
      zIndexBase: 10,
    });
  });

  it("loadCatalogCache：缺失文件静默", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "no-such-cache.json");
    await manager.loadCatalogCache();
    expect(manager.catalogCache.size).toBe(0);
  });

  it("仅字符串 summary 入缓存", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    writeFileSync(
      manager.catalogCachePath,
      JSON.stringify({ version: 1, entries: { a: { summary: "sa" }, b: { summary: 5 }, c: {} } }),
    );
    await manager.loadCatalogCache();
    expect([...manager.catalogCache.entries()]).toEqual([["a", { summary: "sa" }]]);
  });

  it("损坏文件忽略", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    writeFileSync(manager.catalogCachePath, "{broken");
    manager.catalogCache.clear();
    await manager.loadCatalogCache();
    expect(manager.catalogCache.size).toBe(0);
  });

  it("recordCatalogTools 更新摘要", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-a" }]]));
    // recordCatalogTools 刚写入该键，此处断言存在。
    expect(manager.catalogCache.get("srv")!.summary).toBe("desc-a");
  });

  it("摘要变化落盘", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    expect(existsSync(manager.catalogCachePath)).toBeTruthy();
  });

  it("相同摘要不再落盘", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    const before = statSafe(manager.catalogCachePath);
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    expect(statSafe(manager.catalogCachePath)).toBe(before);
  });

  it("全空白摘要短路不覆盖", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "   " }]]));
    expect(manager.catalogCache.get("srv")!.summary).toBe("desc-b");
  });

  it("写入失败触发 logger.warn", async () => {
    const { manager, dir, log } = managerFixture();
    // 写入失败 warn（路径是目录制造 rename 失败）。
    mkdirSync(join(dir, "dir-as-file"), { recursive: true });
    manager.catalogCachePath = join(dir, "dir-as-file");
    const warnBefore = log.warn.length;
    await manager.recordCatalogTools("other", new Map([["x", { description: "y" }]]));
    expect(log.warn.length > warnBefore).toBeTruthy();
  });
});
