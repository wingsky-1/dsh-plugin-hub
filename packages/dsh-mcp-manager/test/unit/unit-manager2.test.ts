// @ts-nocheck
/**
 * dsh-mcp-manager — unit：McpManager 方法面 / normalize 家族 / apply 配置分支。
 *
 * 覆盖：
 * - normalizeServer：名称/传输/command/url 校验、timeout clamp、description trim、
 *   args/env/headers 映射、enabled/reconnect 默认
 * - normalizeUiConfig 三形态兼容与非法回退、buildConfigUiPatch、panelAnchor /
 *   panelTop 定位函数
 * - findProjectRoot：.git / .dsh(排除全局家) / .mcp.json 标记、向上遍历、无标记回落
 * - McpManager：uiConfig/updateUiConfig、目录缓存读写、onStatus、项目 store 缓存、
 *   catalogServersFor、setSession 幂等与切换、refreshFromDisk、reconcileServers
 *   各分支、start/stop/connect/disconnect/reconnect、summary/summarize、dispose
 * - apply：enabled:false / announceToAgent:false / announceCatalog:false 分支、
 *   settings 注入 uiUpdate、effect disposer
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNoGrowth, pollUntil } from "../helpers.ts";

const {
  apply,
  McpManager,
  McpStore,
  normalizeServer,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelAnchorForPosition,
  panelTopForAnchor,
  SERVER_NAME_PATTERN,
  DEFAULT_UI_CONFIG,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  panelZIndexFor,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  breakpointForWidth,
  clampPointToViewport,
  findProjectRoot,
} = await import("../../src/index.ts");

// 临时目录 / manager / timer 收口：用例结束后统一清理，防产物与句柄泄漏。
let tempDirs = [];
let trackedManagers = [];
let trackedTimers = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function trackManager(manager) {
  trackedManagers.push(manager);
  return manager;
}

function trackTimer(timer) {
  trackedTimers.push(timer);
  return timer;
}

afterEach(async () => {
  for (const manager of trackedManagers) {
    // 中间层连接（含 spawn 的 stdio 子进程）manager.dispose() 不关，需显式收口。
    try {
      for (const unit of manager.middleware?.units?.values?.() ?? []) {
        for (const entry of unit.connections.values()) {
          if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer);
          try {
            await entry.transport?.close?.();
          } catch {
            // 关闭失败不掩盖用例结论
          }
        }
      }
    } catch {
      // 同上
    }
    try {
      await manager.dispose();
    } catch {
      // 同上
    }
  }
  trackedManagers = [];
  for (const timer of trackedTimers) clearTimeout(timer);
  trackedTimers = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** 在独立沙箱目录内执行（DSH_HOME 原值恢复，目录删除）。 */
async function inRootSandbox(body) {
  const prevHome = process.env.DSH_HOME;
  const dir = makeTempDir("dsh-mcp-root-");
  try {
    return await body(dir);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
}

describe("normalizeServer", () => {
  const fullInput = () => ({
    name: "  web  ",
    transport: "streamable-http",
    url: "http://localhost:9/mcp ",
    headers: { A: 1 },
    toolCallTimeoutMs: 2500.9,
    description: "  custom desc  ",
    reconnect: { maxAttempts: 3 },
  });
  const full = () => normalizeServer(fullInput());
  const stdio = () => normalizeServer({ name: "s", transport: "stdio", command: " npx ", args: [1, "x"], cwd: "/w", env: { K: null } });
  const bare = () => normalizeServer({ name: "b", transport: "stdio", command: "x" });

  it("SERVER_NAME_PATTERN 是锚定正则", () => {
    expect(SERVER_NAME_PATTERN.source).toMatch(/\^/);
  });

  it("name trim", () => {
    expect(full().name).toBe("web");
  });

  it("transport 透传", () => {
    expect(full().transport).toBe("streamable-http");
  });

  it("url 不 trim（原样保留）", () => {
    expect(full().url).toBe("http://localhost:9/mcp ");
  });

  it("headers 值 String 化", () => {
    expect(full().headers).toEqual({ A: "1" });
  });

  it("正数 timeout floor", () => {
    expect(full().toolCallTimeoutMs).toBe(2500);
  });

  it("description trim", () => {
    expect(full().description).toBe("custom desc");
  });

  it("reconnect 透传", () => {
    expect(full().reconnect).toEqual({ maxAttempts: 3 });
  });

  it("enabled 默认 true", () => {
    expect(full().enabled).toBe(true);
  });

  it("stdio command 不 trim（保留空白）", () => {
    expect(stdio().command).toBe(" npx ");
  });

  it("stdio args String 化", () => {
    expect(stdio().args).toEqual(["1", "x"]);
  });

  it("stdio cwd 透传", () => {
    expect(stdio().cwd).toBe("/w");
  });

  it("stdio env 值 String 化", () => {
    expect(stdio().env).toEqual({ K: "null" });
  });

  it("缺省 toolCallTimeoutMs 为数字", () => {
    expect(typeof bare().toolCallTimeoutMs).toBe("number");
  });

  it("缺省 toolCallTimeoutMs 为正", () => {
    expect(bare().toolCallTimeoutMs > 0).toBeTruthy();
  });

  it("缺省 reconnect 为空对象", () => {
    expect(bare().reconnect).toEqual({});
  });

  it("缺省 description 为 undefined", () => {
    expect(bare().description).toBeUndefined();
  });

  it("缺省 args 为 undefined", () => {
    expect(bare().args).toBeUndefined();
  });

  it("非对象入参抛 must be an object", () => {
    expect(() => normalizeServer("str")).toThrow(/must be an object/);
  });

  it("null 入参抛 must be an object", () => {
    expect(() => normalizeServer(null)).toThrow(/must be an object/);
  });

  it("缺 name 抛 server name must match", () => {
    expect(() => normalizeServer({ transport: "stdio" })).toThrow(/server name must match/);
  });

  it("非法 name 抛 server name must match", () => {
    expect(() => normalizeServer({ name: "bad name!" })).toThrow(/server name must match/);
  });

  it("缺 transport 抛 transport must be", () => {
    expect(() => normalizeServer({ name: "n" })).toThrow(/transport must be/);
  });

  it("非法 transport 抛 transport must be", () => {
    expect(() => normalizeServer({ name: "n", transport: "rpc" })).toThrow(/transport must be/);
  });

  it("stdio 缺 command 抛 requires a command", () => {
    expect(() => normalizeServer({ name: "n", transport: "stdio" })).toThrow(/requires a command/);
  });

  it("stdio 空白 command 抛 requires a command", () => {
    expect(() => normalizeServer({ name: "n", transport: "stdio", command: "   " })).toThrow(/requires a command/);
  });

  it("http 缺 url 抛 requires a url", () => {
    expect(() => normalizeServer({ name: "n", transport: "streamable-http" })).toThrow(/requires a url/);
  });

  it("http 非法 url 抛 invalid url", () => {
    expect(() => normalizeServer({ name: "n", transport: "streamable-http", url: "::::" })).toThrow(/invalid url/);
  });

  // timeout 非法回退默认（0/负数/NaN）。
  it.each([0, -5, Number.NaN])("timeout 非法值 %s 回退为正数", (bad) => {
    const s = normalizeServer({ name: "t", transport: "stdio", command: "x", toolCallTimeoutMs: bad });
    expect(s.toolCallTimeoutMs > 0).toBe(true);
  });

  it.each([0, -5, Number.NaN])("timeout 非法值 %s 回退为有限数", (bad) => {
    const s = normalizeServer({ name: "t", transport: "stdio", command: "x", toolCallTimeoutMs: bad });
    expect(Number.isFinite(s.toolCallTimeoutMs)).toBe(true);
  });
});

describe("normalizeUiConfig / buildConfigUiPatch / panel 定位", () => {
  it("新嵌套形态归一", () => {
    expect(normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 1.6, y: -3, blankY: 0 } } })).toEqual({
      position: "bottom-right",
      offsetX: 2,
      offsetY: 0,
      blankY: 0,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("旧扁平 offset 形态归一", () => {
    expect(normalizeUiConfig({ position: "top-right", offset: { x: 7, y: 8, blankY: 9 } })).toEqual({
      position: "top-right",
      offsetX: 7,
      offsetY: 8,
      blankY: 9,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("客户端扁平 offsetX 形态优先于 offset.*", () => {
    expect(normalizeUiConfig({ offsetX: 11, offsetY: 12, blankY: 13, offset: { x: 1, y: 2, blankY: 3 } })).toEqual({
      position: "top-right",
      offsetX: 11,
      offsetY: 12,
      blankY: 13,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  // #128 四角锚点透传 + zIndexBase clamp 边界（非法回退默认 / 越界压边界）。
  it.each(["top-left", "bottom-left"])("四角 %s 透传", (position) => {
    expect(normalizeUiConfig({ position }).position).toBe(position);
  });

  it("合法层级基准透传", () => {
    expect(normalizeUiConfig({ zIndexBase: 5000 }).zIndexBase).toBe(5000);
  });

  it("低于下界压到 1", () => {
    expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase).toBe(Z_INDEX_BASE_MIN);
  });

  it("超上界压到 9000", () => {
    expect(normalizeUiConfig({ zIndexBase: 99999 }).zIndexBase).toBe(Z_INDEX_BASE_MAX);
  });

  it("非数字回退默认", () => {
    expect(normalizeUiConfig({ zIndexBase: "x" }).zIndexBase).toBe(DEFAULT_UI_CONFIG.zIndexBase);
  });

  it("子浮层派生扩展点 base+30（B5）", () => {
    expect(panelZIndexFor(10)).toBe(40);
  });

  it("undefined 回退默认", () => {
    expect(normalizeUiConfig(undefined)).toEqual({
      position: DEFAULT_UI_CONFIG.position,
      offsetX: DEFAULT_UI_CONFIG.offset.x,
      offsetY: DEFAULT_UI_CONFIG.offset.y,
      blankY: DEFAULT_UI_CONFIG.offset.blankY,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("字符串输入回退默认", () => {
    expect(normalizeUiConfig("junk")).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
  });

  it("非法 position + 非有限 offset 回退默认", () => {
    expect(normalizeUiConfig({ position: "left", offsetX: Number.NaN, offsetY: Infinity })).toEqual({
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 10,
    });
  });

  it("ui 非对象按顶层处理", () => {
    expect(normalizeUiConfig({ ui: 5 }).offsetX).toBe(8);
  });

  it("buildConfigUiPatch 组装嵌套 patch", () => {
    expect(buildConfigUiPatch({ position: "bottom-right", offsetX: 4, offsetY: 5, blankY: 6, zIndexBase: 20 })).toEqual({
      position: "bottom-right",
      offset: { x: 4, y: 5, blankY: 6 },
      zIndexBase: 20,
    });
  });

  it("panelAnchorForPosition bottom-right", () => {
    expect(panelAnchorForPosition("bottom-right")).toBe("bottom");
  });

  it("#128 左下也是底部锚点", () => {
    expect(panelAnchorForPosition("bottom-left")).toBe("bottom");
  });

  it("panelAnchorForPosition top-right", () => {
    expect(panelAnchorForPosition("top-right")).toBe("top");
  });

  it("#128 左上是顶部锚点", () => {
    expect(panelAnchorForPosition("top-left")).toBe("top");
  });

  it("panelAnchorForPosition undefined 回落 top", () => {
    expect(panelAnchorForPosition(undefined)).toBe("top");
  });

  // #128 断点判定纯函数分支翻转 + 视口终 clamp（safe-area inset 恒 0 自然退化）。
  it("320 宽归 narrow", () => {
    expect(breakpointForWidth(320)).toBe("narrow");
  });

  it("480 边界归 narrow", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX)).toBe("narrow");
  });

  it("481 翻转 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1)).toBe("tablet");
  });

  it("834 边界归 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX)).toBe("tablet");
  });

  it("835 翻转 wide", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1)).toBe("wide");
  });

  it("异常宽度按宽档兜底", () => {
    expect(breakpointForWidth(Number.NaN)).toBe("wide");
  });

  it("负坐标钳回视口原点", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667)).toEqual({ x: 0, y: 0 });
  });

  it("右/下溢出钳回视口内", () => {
    expect(clampPointToViewport(400, 700, 100, 80, 375, 667)).toEqual({ x: 275, y: 587 });
  });

  it("safeInset>0 时按安全区内缩", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10)).toEqual({ x: 10, y: 10 });
  });

  it("bottom 锚点向上弹", () => {
    expect(panelTopForAnchor("bottom", 100, 120, 50, 10)).toBe(40);
  });

  it("bottom 溢出 clamp 到 6", () => {
    expect(panelTopForAnchor("bottom", 20, 30, 50, 10)).toBe(6);
  });

  it("top 锚点向下弹", () => {
    expect(panelTopForAnchor("top", 100, 120, 50, 10)).toBe(130);
  });

  it("top 锚点无安全区偏移", () => {
    expect(panelTopForAnchor("top", 100, 120, 50, 0)).toBe(120);
  });
});

describe("findProjectRoot", () => {
  /** 沙箱顶棚：dir/.git 必先命中，防止向上逸出到真实仓库/真实家目录。 */
  async function withSandbox(body) {
    return inRootSandbox(async (dir) => {
      mkdirSync(join(dir, ".git"), { recursive: true });
      const fakeHome = join(dir, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      return body(dir, fakeHome);
    });
  }

  it(".git 标记命中", async () => {
    await withSandbox(async (dir) => {
      const gitProj = join(dir, "git-proj");
      mkdirSync(join(gitProj, ".git"), { recursive: true });
      expect(await findProjectRoot(gitProj)).toBe(gitProj);
    });
  });

  it(".mcp.json 标记命中", async () => {
    await withSandbox(async (dir) => {
      const mcpProj = join(dir, "mcp-proj");
      mkdirSync(mcpProj, { recursive: true });
      writeFileSync(join(mcpProj, ".mcp.json"), "{}");
      expect(await findProjectRoot(mcpProj)).toBe(mcpProj);
    });
  });

  it(".dsh 非 home 标记命中", async () => {
    await withSandbox(async (dir) => {
      const dshProj = join(dir, "dsh-proj");
      mkdirSync(join(dshProj, ".dsh"), { recursive: true });
      expect(await findProjectRoot(dshProj)).toBe(dshProj);
    });
  });

  it("全局家不算项目标记", async () => {
    // 全局家排除：模拟 ~ 下含 .dsh（= DSH_HOME），其子目录向上命中家级 .dsh 应跳过，
    // 继续向上命中顶棚 dir/.git（若误判家级 .dsh 为项目标记则返回 fake-user-home）。
    await withSandbox(async (dir) => {
      const fakeUserHome = join(dir, "fake-user-home");
      const fakeDshHome = join(fakeUserHome, ".dsh");
      mkdirSync(fakeDshHome, { recursive: true });
      process.env.DSH_HOME = fakeDshHome;
      const inHome = join(fakeUserHome, "sub");
      mkdirSync(inHome, { recursive: true });
      expect(await findProjectRoot(inHome)).toBe(dir);
    });
  });

  it("家目录自身不算项目标记", async () => {
    // cwd 恰为家目录本身：家级 .dsh 不算自身标记 → 越过它命中顶棚。
    await withSandbox(async (dir) => {
      const fakeUserHome = join(dir, "fake-user-home");
      const fakeDshHome = join(fakeUserHome, ".dsh");
      mkdirSync(fakeDshHome, { recursive: true });
      process.env.DSH_HOME = fakeDshHome;
      expect(await findProjectRoot(fakeDshHome)).toBe(dir);
    });
  });

  it("无标记普通目录向上命中顶棚", async () => {
    await withSandbox(async (dir) => {
      const plain = join(dir, "plain");
      mkdirSync(plain, { recursive: true });
      expect(await findProjectRoot(plain)).toBe(dir);
    });
  });

  it("16 级窗口内无标记 → 回落 cwd", async () => {
    // 回落 cwd：输入嵌套 16 级，向上窗口（16 层）不出沙箱、够不到任何标记 → 原样返回。
    await withSandbox(async (dir) => {
      let deep = dir;
      for (let i = 0; i < 16; i += 1) deep = join(deep, `d${i}`);
      mkdirSync(deep, { recursive: true });
      expect(await findProjectRoot(deep)).toBe(deep);
    });
  });

  it("undefined cwd → process.cwd() 兜底", async () => {
    await withSandbox(async () => {
      const fallback = await findProjectRoot(undefined);
      expect(typeof fallback).toBe("string");
    });
  });
});

// manager 工厂 ----

function makeManager(dir) {
  const log = { registered: [], disposed: [], info: [], warn: [], error: [], catalog: [] };
  const store = new McpStore(join(dir, "global.json"));
  store.data = { version: 1, servers: [] };
  const manager = new McpManager(
    {
      logger: {
        info: (m) => log.info.push(m),
        warn: (m) => log.warn.push(m),
        error: (m) => log.error.push(m),
      },
    },
    store,
  );
  manager.ctx.tools = {
    register: (def) => {
      log.registered.push(def.name);
      return () => log.disposed.push(def.name);
    },
  };
  return { manager: trackManager(manager), store, log };
}

const quietServer = (name, extra = {}) => ({ name, transport: "stdio", command: "dsh-noop-cmd", reconnect: { enabled: false }, ...extra });

function managerFixture(prefix = "dsh-mcp-mgr2a-") {
  const dir = makeTempDir(prefix);
  return { dir, ...makeManager(dir) };
}

// uiConfig / updateUiConfig / 目录缓存 ----
describe("uiConfig / updateUiConfig / 目录缓存", () => {
  it("uiConfig 默认值", () => {
    const { manager } = managerFixture();
    expect(manager.uiConfig()).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
  });

  it("写不可用抛错（not writable）", async () => {
    const { manager } = managerFixture();
    await expect(manager.updateUiConfig({})).rejects.toThrow(/not writable/);
  });

  function writableFixture() {
    const fixture = managerFixture();
    let captured;
    fixture.manager.uiUpdate = async (patch) => {
      captured = patch;
      // 模拟 settings 落盘后 setSource 更新（apply 内 installSettingsNamespace 行为）。
      fixture.manager.uiConfigSource = () => ({
        position: patch.ui.position,
        offsetX: patch.ui.offset.x,
        offsetY: patch.ui.offset.y,
        blankY: patch.ui.offset.blankY,
        zIndexBase: patch.ui.zIndexBase,
      });
    };
    return { ...fixture, captured: () => captured };
  }

  it("patch 归一化传递", async () => {
    const { manager, captured } = writableFixture();
    await manager.updateUiConfig({ position: "bottom-right", offsetX: 3.4, offsetY: -1, blankY: 100 });
    expect(captured()).toEqual({ ui: { position: "bottom-right", offset: { x: 3, y: 0, blankY: 100 }, zIndexBase: 10 } });
  });

  it("updateUiConfig 返回最新配置", async () => {
    const { manager } = writableFixture();
    const written = await manager.updateUiConfig({ position: "bottom-right", offsetX: 3.4, offsetY: -1, blankY: 100 });
    expect(written).toEqual({ position: "bottom-right", offsetX: 3, offsetY: 0, blankY: 100, zIndexBase: 10 });
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
    writeFileSync(manager.catalogCachePath, JSON.stringify({ version: 1, entries: { a: { summary: "sa" }, b: { summary: 5 }, c: {} } }));
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
    expect(manager.catalogCache.get("srv").summary).toBe("desc-a");
  });

  it("摘要变化落盘", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    expect(existsSync(manager.catalogCachePath)).toBeTruthy();
  });

  function statSafe(p) {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  }

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
    expect(manager.catalogCache.get("srv").summary).toBe("desc-b");
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

// reconcileServers：增删/scope 切换/禁用/busy 重入 ----
describe("reconcileServers", () => {
  it("首次同步启动新 supervisor", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    expect(manager.reconcileServers()).toBe(true);
  });

  it("首次同步 supervisors.size 为 1", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    manager.reconcileServers();
    expect(manager.supervisors.size).toBe(1);
  });

  it("新 supervisor scope 为 global", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    manager.reconcileServers();
    expect(manager.supervisors.get("g-one").scope).toBe("global");
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

  function withTwoServers() {
    const fixture = managerFixture("dsh-mcp-mgr2c-");
    fixture.store.upsert(normalizeServer(quietServer("g-one")));
    fixture.manager.reconcileServers();
    // 禁用：先启动再禁用 → stop 并移除，报变更。
    fixture.store.upsert(normalizeServer(quietServer("g-off")));
    fixture.manager.reconcileServers();
    return fixture;
  }

  it("g-off 启动后 supervisor 存在", () => {
    const { manager } = withTwoServers();
    expect(manager.supervisors.has("g-off")).toBeTruthy();
  });

  it("禁用已运行服务器报变更", () => {
    const { manager, store } = withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    expect(manager.reconcileServers()).toBe(true);
  });

  it("禁用后 supervisor 移除", () => {
    const { manager, store } = withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    manager.reconcileServers();
    expect(manager.supervisors.has("g-off")).toBe(false);
  });

  it("未运行的禁用项无变更", () => {
    const { manager, store } = withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    manager.reconcileServers();
    store.upsert(normalizeServer(quietServer("g-off2", { enabled: false })));
    expect(manager.reconcileServers()).toBe(false);
  });

  it("配置移除后 supervisor 同步移除", () => {
    const { manager, store } = withTwoServers();
    store.remove("g-one");
    store.remove("g-off");
    manager.reconcileServers();
    expect(manager.supervisors.size).toBe(0);
  });

  function withScopeConflict() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("both")));
    manager.projectStore = new McpStore(join(dir, "proj.json"));
    manager.projectStore.data.servers.push(normalizeServer({ ...quietServer("both"), command: "other" }));
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    manager.reconcileServers();
    return { manager };
  }

  it("同名项目级被全局顶掉（scope）", () => {
    const { manager } = withScopeConflict();
    expect(manager.supervisors.get("both").scope).toBe("global");
  });

  it("同名项目级被全局顶掉（supervisor 存在）", () => {
    const { manager } = withScopeConflict();
    expect(manager.supervisors.has("both")).toBeTruthy();
  });
});

// start / stop / startAll 边界 ----
describe("start / stop / startAll 边界", () => {
  it("start 未知名 no-op", () => {
    const { manager } = managerFixture("dsh-mcp-mgr2d-");
    // start：未知名 no-op。
    manager.start("ghost");
    expect(manager.supervisors.size).toBe(0);
  });

  it("projectStore 未设置时 project scope no-op", () => {
    const { manager } = managerFixture("dsh-mcp-mgr2d-");
    manager.start("any", "project");
    expect(manager.supervisors.size).toBe(0);
  });

  it("startAll 启动 svc", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    expect(manager.supervisors.has("svc")).toBeTruthy();
  });

  it("已有连接不重建", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    // 已连接（client 存在）跳过重建。
    const existing = manager.supervisors.get("svc");
    existing.client = {};
    manager.start("svc");
    expect(manager.supervisors.get("svc")).toBe(existing);
  });

  function withCrossScopeConflict() {
    const { dir, manager, store, log } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    // 已连接（client 存在）跳过重建。
    const existing = manager.supervisors.get("svc");
    existing.client = {};
    manager.start("svc");
    // 确定化：清掉 start 异步流程中的 client 引用，才能走到跨 scope 冲突检查。
    delete existing.client;
    // 跨 scope 冲突拒绝启动并 warn（需 projectStore 含同名项才能走到冲突检查）。
    manager.projectStore = new McpStore(join(dir, "p-d.json"));
    manager.projectStore.upsert(normalizeServer(quietServer("svc")));
    manager.start("svc", "project");
    return { manager, log };
  }

  it("跨 scope 冲突 warn", () => {
    const { log } = withCrossScopeConflict();
    expect(log.warn.some((m) => /already registered in scope/.test(m))).toBeTruthy();
  });

  it("跨 scope 冲突保持 global scope", () => {
    const { manager } = withCrossScopeConflict();
    expect(manager.supervisors.get("svc").scope).toBe("global");
  });

  it("stop 后 supervisors 清空", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    // stop 未知名 no-op；stop 移除 supervisor。
    manager.stop("ghost");
    manager.stop("svc");
    expect(manager.supervisors.size).toBe(0);
  });

  it("startAll 跳过后再启动 svc", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    expect(manager.supervisors.has("svc")).toBeTruthy();
  });

  it("禁用不启动", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    expect(manager.supervisors.has("off")).toBe(false);
  });
});

// connect / disconnect / reconnect（manager 面） ----
describe("connect / disconnect / reconnect（manager 面）", () => {
  it("connect 未知抛 not found", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2e-");
    await expect(manager.connect("ghost")).rejects.toThrow(/not found/);
  });

  it("connect 建立 supervisor", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    expect(manager.supervisors.has("c-one")).toBeTruthy();
  });

  it("已连接重复 connect 不增数量", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    // 已连接跳过（client 由失败流程清空，这里手动置位）。
    manager.supervisors.get("c-one").client = {};
    await manager.connect("c-one");
    expect(manager.supervisors.size).toBe(1);
  });

  it("disconnect 未知 no-op / 已知移除", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    await manager.disconnect("ghost");
    await manager.disconnect("c-one");
    expect(manager.supervisors.size).toBe(0);
  });

  it("reconnect 未知抛 not found", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2e-");
    await expect(manager.reconnect("ghost")).rejects.toThrow(/not found/);
  });

  it("跨 scope connect 抛 registered in scope", async () => {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2e-");
    // 跨 scope connect 抛错（确定化：清掉 start 异步流程中的 client 引用，
    // 避免 spawn 失败时序影响「已连接早退」判定）。
    store.upsert(normalizeServer(quietServer("c-two")));
    manager.projectStore = new McpStore(join(dir, "p.json"));
    manager.projectStore.data.servers.push(normalizeServer(quietServer("c-two")));
    manager.start("c-two", "global");
    const supCtwo = manager.supervisors.get("c-two");
    if (supCtwo !== undefined) supCtwo.client = undefined;
    await expect(manager.connect("c-two", "project")).rejects.toThrow(/registered in scope/);
  });
});

// #382 F2/F3/F4/F5：runtime 回退重连 + all 模式池接管 + 防双进程探测重试 ----
describe("#382 F2：runtime 回退重连", () => {
  let prevHome;
  let homeDir;
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
    // F2：runtime 注入条目（不落 store）——reconnect 不再抛 not found，
    // 断开后按 runtimeRegistry 配置经 supervisor 复活。
    manager.runtimeRegistry.set("rt", normalizeServer(quietServer("rt")));
    await manager.reconnect("rt");
    expect(manager.supervisors.has("rt")).toBeTruthy();
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
  let prevHome;
  let homeDir;
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
    // F3：all 模式 start 全局非 runtime → 不建 supervisor、不注册 mcp__ 工具，
    // 改触达 @global 单元惰性连接（连接条目最终出现在池中）。
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    store.upsert(normalizeServer(quietServer("g2")));
    manager.start("g2", "global");
    return { manager, store, log };
  }

  it("all 模式全局 start 不建 supervisor（F3 下沉）", async () => {
    const { manager } = await allModeStarted();
    expect(manager.supervisors.has("g2")).toBe(false);
  });

  it("不注册 mcp__ 前缀工具", async () => {
    const { log } = await allModeStarted();
    expect(log.registered.filter((name) => String(name).startsWith("mcp__g2__")).length).toBe(0);
  });

  it("@global 单元连接条目建立", async () => {
    const { manager } = await allModeStarted();
    await pollUntil("@global 单元连接条目建立", () => manager.middleware.units.get("@global")?.connections.has("g2") === true);
    expect(manager.middleware.units.get("@global")?.connections.has("g2")).toBe(true);
  });

  it("connect 不复活 supervisor（F4 走池）", async () => {
    const { manager } = await allModeStarted();
    await pollUntil("@global 单元连接条目建立", () => manager.middleware.units.get("@global")?.connections.has("g2") === true);
    // F4：all 模式 connect 全局走池（userDisabled 解除 + ensureConnected），
    // 不复活 supervisor。
    manager.middleware.units.get("@global").userDisabled.add("g2");
    await manager.connect("g2");
    expect(manager.supervisors.has("g2")).toBe(false);
  });

  it("userDisabled 已解除", async () => {
    const { manager } = await allModeStarted();
    await pollUntil("@global 单元连接条目建立", () => manager.middleware.units.get("@global")?.connections.has("g2") === true);
    manager.middleware.units.get("@global").userDisabled.add("g2");
    await manager.connect("g2");
    expect(manager.middleware.units.get("@global").userDisabled.has("g2")).toBe(false);
  });
});

describe("#382 F5：防双进程探测重试", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** F5：防双进程探测命中 → 落 failed 占位 entry + 一次性重试定时器。 */
  async function probeHitFixture() {
    const { manager, store } = makeManager(homeDir);
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    manager.ctx.tools.schemas = () => [{ name: "mcp__g3__t" }];
    store.upsert(normalizeServer(quietServer("g3")));
    manager.start("g3", "global");
    await pollUntil("探测命中占位 entry", () => {
      const probeEntry = manager.middleware.units.get("@global")?.connections.get("g3");
      return probeEntry !== undefined && probeEntry.probeRetried === true;
    });
    const probeEntry = manager.middleware.units.get("@global").connections.get("g3");
    if (probeEntry.reconnectTimer !== undefined) trackTimer(probeEntry.reconnectTimer);
    return { manager, probeEntry };
  }

  it("重试定时器已排（F5 有界重试）", async () => {
    // 首个断言紧跟 pollUntil（同一同步块内 probeRetried 置位即已排定时器），可断
    // reconnectTimer 存在；此后跨 await 的断言改用 probeRetried 持久标记——慢机 3s
    // 窗口内定时器可能已触发置 undefined，但 probeRetried 连接成功前不复位。
    const { probeEntry } = await probeHitFixture();
    expect(probeEntry.reconnectTimer !== undefined).toBeTruthy();
  });

  it("再次探测命中不重排（probeRetried 保持一次性）", async () => {
    const { manager, probeEntry } = await probeHitFixture();
    // 一次性语义：probeRetried 已置位，再次 ensureConnected 命中探测不重排。
    await manager.middleware.ensureConnected("@global", "g3");
    expect(probeEntry.probeRetried).toBe(true);
  });

  it("userDisabled 命中不重连（重试经 ensureConnected 的禁用语义保证）", async () => {
    const { manager } = await probeHitFixture();
    // 否定用例：userDisabled 已写时，重试路径（ensureConnected）不连接。
    manager.middleware.units.get("@global").userDisabled.add("g3");
    await manager.middleware.ensureConnected("@global", "g3");
    expect(manager.middleware.units.get("@global").connections.get("g3").status).toBe("failed");
  });
});

// #412 复报：resumeReconnect 配置全集重建（单元缺失 / entry 缺失场景） ----
describe("#412 resumeReconnect 配置全集重建", () => {
  function resumeFixture() {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2r-");
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
    manager.middlewareMode = "project";

    // stub 中间层：units 为空（模拟宿主重启后单元/entry 全清），记录调用面。
    const calls = [];
    const fakeMw = {
      units: new Map(),
      projectUnitFor: async (root) => {
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
      ensureConnected: async (root, name, opts) => {
        calls.push(["ensureConnected", root, name, opts]);
      },
    };
    manager.middleware = fakeMw;
    return { manager, projRoot, calls, fakeMw };
  }

  it("单元缺失时先 projectUnitFor 确保单元创建", async () => {
    // 单元缺失：resumeReconnect 应先 projectUnitFor 创建单元，再按配置全集 force 重建。
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

  it("全部 force 受控重建（#412）", async () => {
    const { manager, calls } = resumeFixture();
    await manager.resumeReconnect();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    expect(recon.every((c) => c[3] && c[3].force === true)).toBeTruthy();
  });

  it("userDisabled 过滤（p3 已禁用不复活）", async () => {
    // 单元已存在但 entry 缺失：仍按配置全集重建（不重复 projectUnitFor）。
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
});

// #616：reconcile/refreshFromDisk 不得拆毁中间层项目单元 ----
describe("#616 reconcile / start(项目级) / refreshFromDisk 不拆毁中间层项目单元", () => {
  function regression616() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2x-");
    const projRoot = join(dir, "proj");
    mkdirSync(projRoot, { recursive: true });
    const projStore = new McpStore(join(projRoot, ".dsh", "mcp.json"));
    projStore.data = { version: 1, servers: [normalizeServer(quietServer("p1")), normalizeServer(quietServer("p2"))] };
    manager.projectStores.set(projRoot, projStore);
    manager.projectRoot = projRoot;
    manager.projectStore = projStore;
    manager.middlewareMode = "all";

    // stub 中间层：项目单元已建且 p1/p2 均已 connected（模拟稳定运行态），
    // teardownUnit 必须零调用（回归红线：reconcile 有任何拆毁即判红）。
    const teardownRoots = [];
    const calls614 = [];
    const mkUnit = (root) => ({
      root,
      connections: new Map([
        ["p1", { server: projStore.find("p1"), client: {}, status: "connected" }],
        ["p2", { server: projStore.find("p2"), client: {}, status: "connected" }],
      ]),
      catalog: new Map(),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    });
    const fakeMw = {
      units: new Map([[projRoot, mkUnit(projRoot)]]),
      projectUnitFor: async (root) => {
        calls614.push(["projectUnitFor", root]);
        return fakeMw.units.get(root) ?? (() => {
          const unit = mkUnit(root);
          fakeMw.units.set(root, unit);
          return unit;
        })();
      },
      ensureConnected: async (root, name, opts) => {
        calls614.push(["ensureConnected", root, name, opts]);
        const unit = fakeMw.units.get(root);
        if (unit !== undefined && !unit.connections.has(name)) {
          unit.connections.set(name, { server: projStore.find(name), client: {}, status: "connected" });
        }
        return opts;
      },
      teardownUnit: (root) => teardownRoots.push(root),
    };
    manager.middleware = fakeMw;
    return { manager, store, projRoot, projStore, fakeMw, teardownRoots, calls614 };
  }

  /** 全局配置加一台 g1：reconcile 会因 supervisor 集合变化走 start("g1")。 */
  async function afterReconcile() {
    const fixture = regression616();
    // 关键断言：项目单元 connections 保持、teardownUnit 零调用（修复前此处把
    // 项目单元整个拆毁且无人重建）。
    fixture.store.upsert(normalizeServer(quietServer("g1")));
    fixture.manager.reconcileServers();
    await pollUntil("all 模式全局 g1 经池接管连接", () => fixture.fakeMw.units.get("@global")?.connections.has("g1") === true);
    return fixture;
  }

  it("reconcile 零拆毁（#616 回归红线）", async () => {
    const { teardownRoots } = await afterReconcile();
    expect(teardownRoots.length).toBe(0);
  });

  it("项目级 p1 连接保持", async () => {
    const { fakeMw, projRoot } = await afterReconcile();
    expect(fakeMw.units.get(projRoot).connections.get("p1")?.status).toBe("connected");
  });

  it("项目级 p2 连接保持", async () => {
    const { fakeMw, projRoot } = await afterReconcile();
    expect(fakeMw.units.get(projRoot).connections.get("p2")?.status).toBe("connected");
  });

  it("配置无变化 refreshFromDisk 早退、不 reconcile", async () => {
    const { manager, calls614 } = await afterReconcile();
    // refreshFromDisk 早退：配置无变化时不再 reconcile（消除 user-state 写盘
    // 误触发 reconcile 的放大器；reconcileBusy 置位可探测是否被调用）。
    calls614.length = 0;
    manager.reconcileServers = () => {
      calls614.push("reconcile");
      return false;
    };
    await manager.refreshFromDisk();
    expect(calls614.length).toBe(0);
  });

  it("start(项目级) 幂等触达零拆毁", async () => {
    // start(项目级) 幂等触达：不拆单元、对该服务器 ensureConnected（无 force）。
    const { manager, projRoot, calls614, teardownRoots } = await afterReconcile();
    calls614.length = 0;
    manager.start("p1", "project");
    await pollUntil("start(项目级) 幂等触达完成", () => calls614.some((c) => c[0] === "ensureConnected" && c[1] === projRoot && c[2] === "p1"));
    expect(teardownRoots.length).toBe(0);
  });

  it("幂等触达不带 force（connected 短路语义）", async () => {
    const { manager, calls614 } = await afterReconcile();
    calls614.length = 0;
    manager.start("p1", "project");
    await pollUntil("start(项目级) 幂等触达完成", () => calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p1"));
    expect(calls614.every((c) => c[0] !== "ensureConnected" || c[3]?.force !== true)).toBeTruthy();
  });

  it("配置漂移 force 重建仍零拆毁（单台重建不殃及单元）", async () => {
    // start(项目级) 配置漂移：entry.server 与 store 当前配置不一致 → force 单台
    // 重建（保留手工编辑 mcp.json 热生效语义，评审 P1-2 补测）。
    const { manager, projStore, calls614, teardownRoots } = await afterReconcile();
    calls614.length = 0;
    projStore.data.servers[0] = normalizeServer(quietServer("p1", { command: "dsh-noop-cmd-v2" }));
    manager.start("p1", "project");
    await pollUntil("配置漂移 force 重建完成", () => calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p1" && c[3]?.force === true));
    expect(teardownRoots.length).toBe(0);
  });

  it("userDisabled 命中不连接", async () => {
    // start(项目级) userDisabled 命中：不触发 ensureConnected（浮窗断开语义）。
    const { manager, projRoot, calls614, fakeMw } = await afterReconcile();
    calls614.length = 0;
    fakeMw.units.get(projRoot).userDisabled.add("p2");
    manager.start("p2", "project");
    await pollUntil("projectUnitFor 触达完成", () => calls614.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot));
    // 反向验证：userDisabled 命中后稳定不连接（观察窗口内持续断言，替代固定 sleep）
    await assertNoGrowth(
      "userDisabled命中不连接",
      () => calls614.filter((c) => c[0] === "ensureConnected" && c[2] === "p2").length,
      0,
    );
    expect(!calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p2")).toBeTruthy();
  });
});

// #413：all 模式 runtime 注入（toolDefinitions）归一中台 ----
describe("#413 all 模式 runtime 注入归一中台", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2w-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  function wrappedTool() {
    return {
      name: "cg_node",
      description: "查符号",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (a, v) => [{ type: "text", text: v.text }] },
      execute: async (args) => ({ text: `node(${args.symbol})` }),
    };
  }

  async function registered({ unregister = false } = {}) {
    const { manager, store, log } = makeManager(homeDir);
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    const mw = manager.middleware;
    // 经 registerServer 注入（带 toolDefinitions）→ start 内部 middlewareTakes
    // 判定接管 → 触达 @global 单元虚拟连接，不建 supervisor、不注册 mcp__ 工具。
    await manager.registerServer({ name: "cg", transport: "stdio", command: "codegraph", args: ["serve", "--mcp"], toolDefinitions: [wrappedTool()] });
    await pollUntil("@global 单元虚拟连接建立", () => mw.units.get("@global")?.connections.has("cg") === true);
    if (unregister) await manager.unregisterServer("cg");
    return { manager, store, log, mw };
  }

  it("runtime 条目已注册", async () => {
    const { manager } = await registered();
    expect(manager.runtimeRegistry.has("cg")).toBeTruthy();
  });

  it("all 模式 runtime 不建 supervisor（#413 归一）", async () => {
    const { manager } = await registered();
    expect(manager.supervisors.has("cg")).toBe(false);
  });

  it("不注册 mcp__ 前缀工具", async () => {
    const { log } = await registered();
    expect(log.registered.filter((name) => String(name).startsWith("mcp__cg__")).length).toBe(0);
  });

  it("虚拟连接 connected", async () => {
    const { mw } = await registered();
    expect(mw.units.get("@global").connections.get("cg").status).toBe("connected");
  });

  it("无远端 client（封装直呼）", async () => {
    const { mw } = await registered();
    expect(mw.units.get("@global").connections.get("cg").client).toBeUndefined();
  });

  it("目录投影封装工具", async () => {
    const { mw } = await registered();
    expect(mw.units.get("@global").catalog.get("cg")?.tools.has("cg_node")).toBeTruthy();
  });

  it("summary 投影 connected（@global 单元）", async () => {
    // 查询面：summary 从 @global 单元投影（connected + tools），不落 supervisor。
    const { manager } = await registered();
    const summaryServer = manager.summary().servers.find((s) => s.name === "cg");
    expect(summaryServer?.status).toBe("connected");
  });

  it("summary 工具列表来自目录投影", async () => {
    const { manager } = await registered();
    const summaryServer = manager.summary().servers.find((s) => s.name === "cg");
    expect([...summaryServer.tools].sort()).toEqual(["cg_node"]);
  });

  it("runtime 条目已注销", async () => {
    // unregisterServer 清理 @global 单元虚拟连接与目录（防 unregister 后幽灵残留）。
    const { manager } = await registered({ unregister: true });
    expect(manager.runtimeRegistry.has("cg")).toBe(false);
  });

  it("虚拟连接已拆", async () => {
    const { mw } = await registered({ unregister: true });
    expect(mw.units.get("@global")?.connections.has("cg")).toBe(false);
  });

  it("目录条目已清（防幽灵）", async () => {
    const { mw } = await registered({ unregister: true });
    expect(mw.units.get("@global")?.catalog.has("cg")).toBe(false);
  });
});

// #413：all 模式 runtime（toolDefinitions）注销后 project 模式保留 supervisor ----
describe("#413 project 模式 runtime 保留 supervisor", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2w2-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  async function projectRegistered() {
    const { manager } = makeManager(homeDir);
    const wrapped = {
      name: "cg_node",
      description: "查符号",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (a, v) => [{ type: "text", text: v.text }] },
      execute: async (args) => ({ text: `node(${args.symbol})` }),
    };
    manager.middlewareMode = "project";
    await manager.initMiddleware("project", {});
    await manager.registerServer({ name: "cg", transport: "stdio", command: "codegraph", args: ["serve", "--mcp"], toolDefinitions: [wrapped] });
    return { manager };
  }

  it("project 模式 runtime 仍 supervisor 路径（#413 只归一 all）", async () => {
    const { manager } = await projectRegistered();
    expect(manager.supervisors.has("cg")).toBeTruthy();
  });

  it("off 模式注销后 registry 清除", async () => {
    // off 模式注销：supervisor 销毁 + registry 清除（无中间层连接，无需 drop）。
    const { manager } = await projectRegistered();
    manager.middlewareMode = "off";
    await manager.unregisterServer("cg");
    expect(manager.runtimeRegistry.has("cg")).toBe(false);
  });

  it("off 模式注销后 supervisor 销毁", async () => {
    const { manager } = await projectRegistered();
    manager.middlewareMode = "off";
    await manager.unregisterServer("cg");
    expect(manager.supervisors.has("cg")).toBe(false);
  });
});

// #392 遗留①②③：remove/update 清目录幽灵条目 + disconnect 显式 scope 定位 ----
describe("#392 遗留①：remove 清内存目录幽灵条目", () => {
  let prevHome;
  let homeDir;
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
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    const mw = manager.middleware;
    // #392 遗留①：remove 后目录（unit.catalog）残留幽灵条目清除——此前 dropMiddleware
    // Connection 只拆 connections 不清 catalog，TTL 内 ws_mcp_list 仍显示已删服务器。
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil("@global 单元连接条目建立", () => mw.units.get("@global")?.connections.has("ghost") === true);
    // 手动塞目录条目模拟「已 discover」残留（真实 remove 前目录必然存在）。
    mw.units.get("@global").catalog.set("ghost", { discoveredAt: Date.now(), tools: new Map([["t", { description: "d", inputSchema: {} }]]) });
    if (remove) await manager.remove("ghost");
    return { manager, store, log, mw };
  }

  it("目录条目存在（模拟 discover 残留）", async () => {
    const { mw } = await ghostStarted();
    expect(mw.units.get("@global").catalog.has("ghost")).toBeTruthy();
  });

  it("remove 后连接被拆", async () => {
    const { mw } = await ghostStarted({ remove: true });
    expect(mw.units.get("@global").connections.has("ghost")).toBe(false);
  });

  it("remove 后目录条目被清（#392 幽灵条目消除）", async () => {
    const { mw } = await ghostStarted({ remove: true });
    expect(mw.units.get("@global").catalog.has("ghost")).toBe(false);
  });

  it("remove 落盘", async () => {
    const { store } = await ghostStarted({ remove: true });
    expect(store.find("ghost")).toBeUndefined();
  });
});

describe("#392 遗留①（M1 复核）：remove 清磁盘 last-good 缓存", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2m-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** 先 persistCatalog 写盘（含 ghost），remove 后等待异步清盘完成。 */
  async function persistedGhost({ remove = false } = {}) {
    const { manager, store } = makeManager(homeDir);
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    const mw = manager.middleware;
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil("@global 单元连接条目建立", () => mw.units.get("@global")?.connections.has("ghost") === true);
    mw.units.get("@global").catalog.set("ghost", { discoveredAt: Date.now(), tools: new Map([["t", { description: "d", inputSchema: {} }]]) });
    await mw.persistCatalog("@global");
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
    const { mw } = await persistedGhost({ remove: true });
    expect(mw.units.get("@global").catalog.has("ghost")).toBe(false);
  });
});

describe("#392 遗留③：disconnect 显式 scope 定位", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2m-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const projectConnect = async () => {
    const { manager, store } = makeManager(homeDir);
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    const mw = manager.middleware;
    // #392 遗留③：disconnect 显式 scope=project 定位项目单元，不误写 @global 单元。
    // 构造：全局 store 与项目 store 同名 "dup"（项目级由中间层项目单元接管）。
    store.upsert(normalizeServer(quietServer("dup")));
    // @global 单元须先存在（原脚本由更早的全局 start 触达建立），否则「不误写
    // @global」断言无对象可查。
    await mw.projectUnitFor("@global");
    const proj = join(homeDir, "proj");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "dup", transport: "stdio", command: "dcmd", enabled: true }] }),
    );
    await manager.setSession(proj);
    await manager.connect("dup", "project");
    const projUnit = mw.units.get(proj);
    return { manager, mw, proj, projUnit };
  };

  it("项目单元已创建", async () => {
    const { projUnit } = await projectConnect();
    expect(projUnit).toBeTruthy();
  });

  it("scope=project 断开写项目单元", async () => {
    // 项目级 disconnect：显式 scope=project → 写项目单元 userDisabled（此前无 scope
    // 时 all 模式全局同名会把项目级 disconnect 错定位 @global）。
    const { manager, projUnit } = await projectConnect();
    await manager.disconnect("dup", "project");
    expect(projUnit.userDisabled.has("dup")).toBeTruthy();
  });

  it("不误写 @global 单元（#392 同名跨 scope 修正）", async () => {
    const { manager, mw } = await projectConnect();
    await manager.disconnect("dup", "project");
    expect(mw.units.get("@global").userDisabled.has("dup")).toBe(false);
  });

  it("reconnect(scope=project) 不误写 @global 单元（S1）", async () => {
    // #392 遗留③（S1 复核）：reconnect 透传 scope——项目级 reconnect 不再误写 @global。
    // 此前 reconnect 内部 disconnect(name) 不带 scope，all 模式 + 全局同名时项目级
    // reconnect 会把全局同名服务器误写进 @global userDisabled 并持久化。
    const { manager, mw } = await projectConnect();
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    expect(mw.units.get("@global").userDisabled.has("dup")).toBe(false);
  });

  it("reconnect 后项目单元 userDisabled 已解除", async () => {
    const { manager, projUnit } = await projectConnect();
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    expect(projUnit.userDisabled.has("dup")).toBe(false);
  });

  it("scope=global 断开写 @global 单元", async () => {
    // 全局 disconnect 显式 scope=global → 写 @global 单元。
    const { manager, mw } = await projectConnect();
    await manager.connect("dup", "global");
    await manager.disconnect("dup", "global");
    expect(mw.units.get("@global").userDisabled.has("dup")).toBeTruthy();
  });
});

// 拆除时在途建连的 in-flight 残留（跨平台确定性回归：Windows 必现） ----
// 命令选真实存在但永不完成 MCP 握手的 node 子进程：connect() 必然 pending 到
// CONNECT_TIMEOUT_MS（10s），把「拆除时 attempt 在途」窗口拉满。此前 remove/
// disconnect 强拆 entry 后不同步废弃 inFlight 去重标记，同名后续 ensureConnected
// （含 force 的显式「连接」）被残留标记吞掉，且旧 attempt 收敛命中 disposed 守卫
// 无人补连——修复前本块必红（此前 Linux CI 靠 spawn 快速失败侥幸避开窗口）。
describe("拆除时在途建连的 in-flight 残留", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2n-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  // 挂起型服务器：子进程常驻但不吐 MCP 帧 → transport.connect() 恒 pending。
  const hangServer = (name) => ({
    name, transport: "stdio", command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1e6)"], reconnect: { enabled: false },
  });

  async function allModeFixture() {
    const { manager, store } = makeManager(homeDir);
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    return { manager, store, mw: manager.middleware };
  }

  it("remove 后重加立即重建连接条目（in-flight 残留已废弃）", async () => {
    const { manager, store, mw } = await allModeFixture();
    // remove 路径：connecting 中强拆 + 重加，连接条目须立即重建。
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil("hang 连接条目建立（connecting）", () => mw.units.get("@global")?.connections.has("hang") === true);
    await manager.remove("hang");
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil("remove 后重加立即重建连接条目（in-flight 残留已废弃）", () => mw.units.get("@global")?.connections.has("hang") === true);
    expect(mw.units.get("@global")?.connections.has("hang")).toBe(true);
  });

  it("disconnect 写 userDisabled", async () => {
    const { manager, store, mw } = await allModeFixture();
    // disconnect 路径：connecting 中断开 + 显式「连接」，force 建连不被去重吞掉。
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil("hang 连接条目建立（connecting）", () => mw.units.get("@global")?.connections.has("hang") === true);
    await manager.disconnect("hang", "global");
    expect(mw.units.get("@global").userDisabled.has("hang")).toBeTruthy();
  });

  it("disconnect 后显式连接立即重建条目", { timeout: 30_000 }, async () => {
    const { manager, store, mw } = await allModeFixture();
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil("hang 连接条目建立（connecting）", () => mw.units.get("@global")?.connections.has("hang") === true);
    await manager.disconnect("hang", "global");
    await manager.connect("hang", "global");
    await pollUntil("disconnect 后显式连接立即重建条目", () => mw.units.get("@global")?.connections.has("hang") === true);
    expect(mw.units.get("@global")?.connections.has("hang")).toBe(true);
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
    await expect(manager.add(normalizeServer(quietServer("new")))).rejects.toThrow(/already exists/);
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
    expect(store.find("new").command).toBe("cmd2");
  });

  it("remove 后 store 无该条目", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await manager.remove("new");
    expect(store.find("new")).toBeUndefined();
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
    writeFileSync(join(proj, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }] }));
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

  it("项目级服务器随会话启动", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    expect(manager.supervisors.has("psrv")).toBeTruthy();
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
    await fixture.manager.setSession(fixture.proj);
    const sameStore = fixture.manager.projectStore;
    // 切走：项目 supervisor 全部断开（无标记目录回落为项目根 = cwd 自身，
    // 加载出空 projectStore 属预期行为）。
    const elsewhere = join(fixture.dir, "elsewhere");
    await fixture.manager.setSession(elsewhere);
    return { ...fixture, sameStore, elsewhere };
  }

  it("切走后项目级断开", async () => {
    const { manager } = await switchedAway();
    expect(manager.supervisors.has("psrv")).toBe(false);
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
    writeFileSync(join(proj, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }] }));
    await manager.setSession(proj);
    // catalogServersFor：全局 + 项目聚合，禁用过滤，同名项目级被顶掉。
    manager.projectStore.data.servers.push(normalizeServer({ ...quietServer("psrv2", { enabled: false }) }));
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
    expect((await manager.catalogServersFor(proj)).get("psrv").scope).toBe("project");
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
    writeFileSync(join(proj, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }] }));
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
    writeFileSync(join(dir, "global.json"), JSON.stringify({ version: 1, servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }] }));
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播落定且无未决 coalesce
    //（statusTimer 清空 = 广播 handler 已全部执行），再取基线（事件驱动）。
    await pollUntil("配置变化广播落定", () => broadcasts() >= 1 && manager.statusTimer === undefined);
    expect(store.data.servers.some((s) => s.name === "fresh")).toBeTruthy();
  });

  it("无变化不广播", async () => {
    const { dir, manager, broadcasts } = await refreshFixture();
    const future = Date.now() / 1000 + 10;
    writeFileSync(join(dir, "global.json"), JSON.stringify({ version: 1, servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }] }));
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    await pollUntil("配置变化广播落定", () => broadcasts() >= 1 && manager.statusTimer === undefined);
    // 无变化时不广播：先取基线（上一广播已完全落定），再 refreshFromDisk
    //（无变化 → 不 emitStatus），轮询确认无未决广播后断言计数不变。
    const before = broadcasts();
    await manager.refreshFromDisk();
    await pollUntil("无变化后无未决广播", () => manager.statusTimer === undefined);
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
      JSON.stringify({ version: 1, servers: [{ name: "slow", transport: "stdio", command: "definitely-not-exist-cmd", enabled: true }] }),
    );
    // 中间层 project 模式：setSession 只切 currentRoot，不 await 连接。
    manager.middlewareMode = "project";
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
      JSON.stringify({ version: 1, servers: [{ name: "p1", transport: "stdio", command: "pcmd", enabled: true }] }),
    );
    await manager.setSession(proj);
    // 初始化中间层（模拟 apply）。
    await manager.initMiddleware("project", {});
    // 项目级 connect → 中间层连接池（userDisabled 解除 + ensureConnected）。
    await manager.connect("p1", "project");
    return { manager, store, proj, mw: manager.middleware };
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
    expect(mw.units.get(proj).userDisabled.has("p1")).toBe(false);
  });

  it("断开后 userDisabled", async () => {
    // 项目级 disconnect → userDisabled 持久化。
    const { manager, mw, proj } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(mw.units.get(proj).userDisabled.has("p1")).toBe(true);
  });

  it("连接拆毁", async () => {
    const { manager, mw, proj } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(mw.units.get(proj).connections.has("p1")).toBe(false);
  });

  it("持久化文件存在（不崩）", async () => {
    const { manager } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(existsSync(manager.userStatePath)).toBe(true);
  });

  it("全局 disconnect 不受中间层影响（supervisor 路径）", async () => {
    const { manager } = await middlewareConnected();
    // 全局 disconnect 不受中间层影响（supervisor 路径）。
    await manager.disconnect("g1");
    expect(manager.supervisors.has("g1")).toBe(false);
  });
});

// summary / summarize / dispose ----
describe("summary", () => {
  function summaryFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    return { manager, store };
  }

  it("servers 列表长度 2", () => {
    const { manager } = summaryFixture();
    expect(manager.summary().servers.length).toBe(2);
  });

  it("counts.connected 为 0", () => {
    const { manager } = summaryFixture();
    expect(manager.summary().counts.connected).toBe(0);
  });

  it("counts.disabled 为 1", () => {
    const { manager } = summaryFixture();
    expect(manager.summary().counts.disabled).toBe(1);
  });

  it("cwd 为 undefined", () => {
    const { manager } = summaryFixture();
    expect(manager.summary().cwd).toBeUndefined();
  });
});

describe("summarize", () => {
  function summarizeFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    // summarize：supervisor 状态与错误投影。
    manager.supervisors.set("s-on", { status: "failed", error: new Error("boom"), tools: ["t"] });
    return { manager, store };
  }

  it("entryOn.status 为 failed", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-on"), "global").status).toBe("failed");
  });

  it("entryOn.error 为字符串文案", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-on"), "global").error).toBe("boom");
  });

  it("entryOn.tools 透传", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-on"), "global").tools).toEqual(["t"]);
  });

  it("entryOn.scope 透传", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-on"), "global").scope).toBe("global");
  });

  it("entryOff.status 为 disabled", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-off"), "global").status).toBe("disabled");
  });

  it("entryOff.tools 为空", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-off"), "global").tools).toEqual([]);
  });

  it("entryOff.error 为 undefined", () => {
    const { manager, store } = summarizeFixture();
    expect(manager.summarize(store.find("s-off"), "global").error).toBeUndefined();
  });

  it("无 supervisor 且启用 → stopped", () => {
    const { manager, store } = summarizeFixture();
    // 无 supervisor 且启用 → stopped。
    manager.supervisors.delete("s-on");
    expect(manager.summarize(store.find("s-on"), "global").status).toBe("stopped");
  });
});

describe("dispose", () => {
  function disposeFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    const disposedNames = [];
    manager.supervisors.set("s-x", {
      disposed: false,
      reconnectTimer: trackTimer(setTimeout(() => {}, 60_000)),
      syncChain: Promise.resolve(),
      toolDisposers: new Map([["t", () => disposedNames.push("t")]]),
    });
    return { manager, disposedNames };
  }

  it("dispose 清理全部 supervisor 工具", async () => {
    // dispose：清理全部 supervisor 工具。
    const { manager, disposedNames } = disposeFixture();
    await manager.dispose();
    expect(disposedNames).toEqual(["t"]);
  });

  it("dispose 后 supervisors 清空", async () => {
    const { manager } = disposeFixture();
    await manager.dispose();
    expect(manager.supervisors.size).toBe(0);
  });
});

// 中间层模式 summary 投影（#228 回归：连接池状态投影到浮窗/summary） ----
describe("中间层模式 summary 投影（#228）", () => {
  const connectedEntry = () => ({
    server: undefined, client: undefined, transport: undefined,
    status: "connected", error: undefined, connectedAt: Date.now(),
    reconnectTimer: undefined, disposed: false, failedAttempts: 0,
  });

  async function projectionBase() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2mw-");
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "p1", transport: "stdio", command: "pcmd", enabled: true }] }),
    );
    // 先切中间层模式再 setSession（off 语义的 setSession 会 reconcile 启动
    // 项目级真 supervisor 并异步重连，污染后续兜底投影断言）。
    manager.middlewareMode = "project";
    await manager.setSession(proj);
    await manager.initMiddleware("project", {});
    const mw = manager.middleware;
    // 预置 userDisabled（initMiddleware 会以磁盘加载结果覆盖 disabledByRoot，
    // 故必须在其后设置）：单元创建即合并，惰性 ensureConnected 直接短路——
    // 连接条目完全由本测试手工注入，杜绝 spawn 真进程与后台重连污染。
    mw.disabledByRoot.set(proj, new Set(["p1"]));
    const unit = await mw.projectUnitFor(proj);
    // 注入连接池条目 + 目录缓存（模拟已握手成功，不 spawn 子进程）。
    unit.connections.set("p1", connectedEntry());
    unit.catalog.set("p1", {
      discoveredAt: Date.now(),
      tools: new Map([["t1", { description: "d1", inputSchema: {} }], ["t2", { description: "", inputSchema: {} }]]),
    });
    return { dir, manager, store, proj, mw, unit, entry: unit.connections.get("p1") };
  }

  it("项目级 server 在 summary 中", async () => {
    // 回归盲区主断言（#228 维护者实测补充验收）：中间层 connected →
    // summary 显示 connected、tools 从 catalog 缓存填充出**非空列表**且与
    // 目录一致（此前 summarize 只读 supervisors，项目级恒 stopped / 空数组，
    // 而 ws_mcp_search 实测目录有货）。
    const { manager } = await projectionBase();
    const p1 = manager.summary().servers.find((s) => s.name === "p1");
    expect(p1 !== undefined).toBeTruthy();
  });

  it("p1.scope 为 project", async () => {
    const { manager } = await projectionBase();
    const p1 = manager.summary().servers.find((s) => s.name === "p1");
    expect(p1.scope).toBe("project");
  });

  it("p1.status 为 connected", async () => {
    const { manager } = await projectionBase();
    const p1 = manager.summary().servers.find((s) => s.name === "p1");
    expect(p1.status).toBe("connected");
  });

  it("summary.tools 非空（catalog 有货不得返回空数组）", async () => {
    const { manager } = await projectionBase();
    const p1 = manager.summary().servers.find((s) => s.name === "p1");
    expect(Array.isArray(p1.tools) && p1.tools.length > 0).toBeTruthy();
  });

  it("summary.tools 与 catalog 目录一致", async () => {
    const { manager } = await projectionBase();
    const p1 = manager.summary().servers.find((s) => s.name === "p1");
    expect([...p1.tools].sort()).toEqual(["t1", "t2"]);
  });

  it("sum.counts.connected 为 1", async () => {
    const { manager } = await projectionBase();
    expect(manager.summary().counts.connected).toBe(1);
  });

  it("failed 态：error 详情投影（浮窗红字展示来源）", async () => {
    const { manager, entry } = await projectionBase();
    entry.status = "failed";
    entry.error = new Error("spawn pcmd ENOENT");
    const failed = manager.summarize(manager.projectStore.find("p1"), "project");
    expect(failed.status).toBe("failed");
  });

  it("failed 态：error 文案投影", async () => {
    const { manager, entry } = await projectionBase();
    entry.status = "failed";
    entry.error = new Error("spawn pcmd ENOENT");
    const failed = manager.summarize(manager.projectStore.find("p1"), "project");
    expect(failed.error).toBe("spawn pcmd ENOENT");
  });

  it("connecting 态投影", async () => {
    const { manager, entry } = await projectionBase();
    entry.status = "connecting";
    entry.error = undefined;
    expect(manager.summarize(manager.projectStore.find("p1"), "project").status).toBe("connecting");
  });

  async function unavailableBase() {
    const fixture = await projectionBase();
    // connected + 目录发现失败（unavailable）→ 0 工具且透出原因到 error。
    fixture.entry.status = "connected";
    fixture.unit.catalog.set("p1", { discoveredAt: 0, tools: new Map(), unavailable: "discovery timed out" });
    return fixture;
  }

  it("unavailable → status connected", async () => {
    const { manager } = await unavailableBase();
    expect(manager.summarize(manager.projectStore.find("p1"), "project").status).toBe("connected");
  });

  it("unavailable → tools 为空", async () => {
    const { manager } = await unavailableBase();
    expect(manager.summarize(manager.projectStore.find("p1"), "project").tools).toEqual([]);
  });

  it("unavailable reason 透出到 error", async () => {
    const { manager } = await unavailableBase();
    expect(manager.summarize(manager.projectStore.find("p1"), "project").error).toBe("discovery timed out");
  });

  async function stoppedBase() {
    const fixture = await projectionBase();
    // userDisabled（手动断开，无连接条目）→ 落回兜底：无 supervisor → stopped。
    // （不做 userDisabled 短路：见 summarize 注释——all 模式 supervisor 复活场景
    // 若短路会把实际已连接反向投影成 stopped。）
    fixture.unit.connections.delete("p1");
    fixture.unit.userDisabled.add("p1");
    return fixture;
  }

  it("userDisabled 无连接条目 → stopped", async () => {
    const { manager } = await stoppedBase();
    expect(manager.summarize(manager.projectStore.find("p1"), "project").status).toBe("stopped");
  });

  it("userDisabled → tools 为空", async () => {
    const { manager } = await stoppedBase();
    expect(manager.summarize(manager.projectStore.find("p1"), "project").tools).toEqual([]);
  });

  it("userDisabled → error undefined", async () => {
    const { manager } = await stoppedBase();
    expect(manager.summarize(manager.projectStore.find("p1"), "project").error).toBeUndefined();
  });

  async function globalScopeBase() {
    const fixture = await projectionBase();
    // 全局 scope 在 project 模式不受中间层影响（supervisor 双轨路径不变）。
    fixture.store.upsert(normalizeServer(quietServer("g1")));
    fixture.manager.supervisors.set("g1", { status: "connected", error: undefined, tools: ["gt"] });
    return fixture;
  }

  it("全局 scope 在 project 模式 status connected", async () => {
    const { manager, store } = await globalScopeBase();
    expect(manager.summarize(store.find("g1"), "global").status).toBe("connected");
  });

  it("全局 scope 在 project 模式 tools 透传", async () => {
    const { manager, store } = await globalScopeBase();
    expect(manager.summarize(store.find("g1"), "global").tools).toEqual(["gt"]);
  });

  async function allModeBase() {
    const fixture = await globalScopeBase();
    // all 模式：全局服务器经虚拟 root @global 走池 → 同样从池投影。
    fixture.manager.middlewareMode = "all";
    fixture.manager.supervisors.delete("g1");
    fixture.mw.units.set("@global", {
      root: "@global",
      connections: new Map([["g1", connectedEntry()]]),
      catalog: new Map([["g1", { discoveredAt: Date.now(), tools: new Map([["gt", { description: "", inputSchema: {} }]]) }]]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    });
    return fixture;
  }

  it("all 模式全局经 @virtual root 投影", async () => {
    const { manager, store } = await allModeBase();
    expect(manager.summarize(store.find("g1"), "global").status).toBe("connected");
  });

  it("all 模式全局 tools 来自池", async () => {
    const { manager, store } = await allModeBase();
    expect(manager.summarize(store.find("g1"), "global").tools).toEqual(["gt"]);
  });

  async function disabledProjectionBase() {
    const fixture = await allModeBase();
    // 反向投影迁移（#382 F4）：池中条目被拆且 userDisabled → userDisabled 短路
    // 投影 stopped。all 模式全局 connect 已改走中间层池（不再 supervisor 复活），
    // 短路不再误伤真实连接；supervisor 残留（理论不该存在）也不误显示其连接态。
    const globalUnit = fixture.mw.units.get("@global");
    globalUnit.connections.delete("g1");
    globalUnit.userDisabled.add("g1");
    fixture.manager.supervisors.set("g1", { status: "connected", error: undefined, tools: ["gt"] });
    return fixture;
  }

  it("userDisabled 短路（#382：池接管后断开即 stopped）", async () => {
    const { manager, store } = await disabledProjectionBase();
    expect(manager.summarize(store.find("g1"), "global").status).toBe("stopped");
  });

  it("userDisabled 短路 → tools 为空", async () => {
    const { manager, store } = await disabledProjectionBase();
    expect(manager.summarize(store.find("g1"), "global").tools).toEqual([]);
  });

  it("#413：all 模式 runtime 条目归一中台（@global 单元投影，userDisabled → stopped）", async () => {
    // #413：all 模式 runtime 注入条目不再豁免——归一中台（middlewareTakes 判定
    // 与 store 全局同口径），从 @global 单元投影；同名 runtime supervisor 残留
    // 不误显示其连接态（与 store 全局行为一致）。
    const { manager, store } = await disabledProjectionBase();
    manager.runtimeRegistry.set("g1", store.find("g1"));
    expect(manager.summarize(store.find("g1"), "global").status).toBe("stopped");
  });

  it("#413 runtime 投影 → tools 为空", async () => {
    const { manager, store } = await disabledProjectionBase();
    manager.runtimeRegistry.set("g1", store.find("g1"));
    expect(manager.summarize(store.find("g1"), "global").tools).toEqual([]);
  });

  it("supervisor 消失后落回兜底 stopped", async () => {
    const { manager, store } = await disabledProjectionBase();
    // supervisor 消失后落回兜底 stopped。
    manager.supervisors.delete("g1");
    expect(manager.summarize(store.find("g1"), "global").status).toBe("stopped");
  });
});

// B5 红测：start 替换已连接 supervisor → 旧实例 disconnect 被调（现状只置 disposed） ----
describe("B5 红测：start 替换已连接 supervisor", () => {
  function replacedConnected() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5a-");
    const srv = normalizeServer(quietServer("s5"));
    store.upsert(srv);
    const state = { oldDisconnected: 0 };
    const oldSupervisor = {
      client: {}, // 已连接（替换分支判定入口）
      server: srv,
      scope: "global",
      disposed: false,
      disconnect: async () => {
        state.oldDisconnected += 1;
        oldSupervisor.disposed = true; // 与真实 disconnect 语义一致
      },
    };
    manager.supervisors.set("s5", oldSupervisor);
    // directConfig：与 store 版本不同引用（对象字面量）；enabled:false 防新代际真实 spawn。
    manager.start("s5", "global", { ...srv, enabled: false });
    return { manager, oldSupervisor, state };
  }

  it("B5：start 替换分支调用旧实例 disconnect（现状只置 disposed → 红测）", () => {
    const { state } = replacedConnected();
    expect(state.oldDisconnected).toBe(1);
  });

  it("新代际已替换", () => {
    const { manager, oldSupervisor } = replacedConnected();
    expect(manager.supervisors.get("s5") === oldSupervisor).toBe(false);
  });

  it("旧实例 disposed 置位", () => {
    const { oldSupervisor } = replacedConnected();
    expect(oldSupervisor.disposed).toBe(true);
  });
});

// B5 红测（续）：connect 替换未连接 supervisor → 清 timer + 注销残留工具 ----
describe("B5 红测（续）：connect 替换未连接 supervisor", () => {
  async function replacedDisconnected() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5b-");
    const srv = normalizeServer(quietServer("s5"));
    store.upsert(srv);
    const disposedTools = [];
    const oldTimer = trackTimer(setTimeout(() => {}, 60_000));
    const oldSupervisor = {
      client: undefined, // 未连接（connect 替换分支判定入口）
      scope: "global",
      server: srv,
      disposed: false,
      reconnectTimer: oldTimer,
      toolDisposers: new Map([["mcp__s5__echo", () => disposedTools.push("mcp__s5__echo")]]),
      disconnect: async function () {
        this.disposed = true;
        if (this.reconnectTimer !== undefined) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        for (const dispose of this.toolDisposers.values()) dispose();
        this.toolDisposers = new Map();
      },
    };
    manager.supervisors.set("s5", oldSupervisor);
    await manager.connect("s5", "global", { ...srv, enabled: false });
    return { manager, oldSupervisor, disposedTools };
  }

  it("B5：connect 替换分支复用 disconnect 语义注销旧代际工具（现状只置 disposed → 红测）", async () => {
    const { disposedTools } = await replacedDisconnected();
    expect(disposedTools).toEqual(["mcp__s5__echo"]);
  });

  it("新代际已替换", async () => {
    const { manager, oldSupervisor } = await replacedDisconnected();
    expect(manager.supervisors.get("s5") === oldSupervisor).toBe(false);
  });
});

// B5 红测（续）：顺序不变式——旧代际工具先注销、新代际后注册（真实 stdio 连接） ----
describe("B5 红测（续）：顺序不变式（真实 stdio 连接）", () => {
  it("B5：顺序不变式——旧代际注销先于新代际注册（现状只置 disposed、旧工具残留 → 红测）", async () => {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2b5c-");
    const serverScript = join(dir, "mini-mcp-server.mjs");
    writeFileSync(
      serverScript,
      [
        'import { createInterface } from "node:readline";',
        'const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        "  let msg; try { msg = JSON.parse(line); } catch { return; }",
        '  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.0.1" } } });',
        '  else if (msg.method === "tools/list") send({ id: msg.id, result: { tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object" } }] } });',
        '  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "method not found" } });',
        "});",
      ].join("\n"),
    );
    const events = [];
    manager.ctx.tools = {
      register: (def) => {
        events.push(`register:${def.name}`);
        return () => events.push(`dispose:${def.name}`);
      },
    };
    const srv = normalizeServer({
      name: "s5",
      transport: "stdio",
      command: process.execPath,
      args: [serverScript],
      reconnect: { enabled: false },
    });
    store.upsert(srv);
    manager.start("s5", "global");
    await pollUntil("旧代际工具已注册", () => events.includes("register:mcp__s5__echo"));
    // directConfig：同内容新引用（模拟 registerServer 直传 config 覆盖 store）。
    manager.start("s5", "global", { ...srv });
    await pollUntil("旧代际工具已注销", () => events.includes("dispose:mcp__s5__echo"));
    await pollUntil("新代际工具已注册", () => events.filter((e) => e === "register:mcp__s5__echo").length >= 2);
    const firstReg = events.indexOf("register:mcp__s5__echo");
    const disAt = events.indexOf("dispose:mcp__s5__echo");
    const secondReg = events.lastIndexOf("register:mcp__s5__echo");
    expect(firstReg >= 0 && disAt > firstReg && secondReg > disAt).toBeTruthy();
    // 清理：断开全部 supervisor（含新代际）关闭 stdio 子进程——manager.dispose()
    // 不关 transport，残留子进程句柄会让本文件独立运行时事件循环挂死
    // （CI mutation dry run 超时根因）。
    for (const sup of manager.supervisors.values()) await sup.disconnect();
  });
});

// B19 红测：summarize supervisor 分支禁用查询合并判定（@global ∪ projectRoot） ----
describe("B19 红测：summarize 合并禁用集", () => {
  it("B19：supervisor 分支合并 @global 与 projectRoot 禁用集（现状 ?? 只取其一 → 红测；与中间层分支口径一致）", () => {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2b19-");
    const srv = normalizeServer(quietServer("g1"));
    store.upsert(srv);
    manager.projectRoot = join(dir, "proj");
    manager.disabledTools.set("@global", new Map([["g1", new Set(["toolA"])]]));
    manager.disabledTools.set(manager.projectRoot, new Map([["g1", new Set(["toolB"])]]));
    manager.supervisors.set("g1", {
      status: "connected",
      error: undefined,
      tools: ["mcp__g1__toolA", "mcp__g1__toolB"],
    });
    const s = manager.summarize(store.find("g1"), "global");
    expect([...(s.disabledTools ?? [])].sort()).toEqual(["toolA", "toolB"]);
  });
});

// apply：配置分支 ----
describe("apply：配置分支", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-apply2-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  // enabled:false：无路由、无 section、无 pre-step。
  // （cordis effect(fn, label) 语义：立即执行工厂取回 disposer。）
  function makeCtx() {
    const state = { preSteps: [], sections: [], routes: [], disposers: [], injected: [] };
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: (route) => {
        state.routes.push(route.path);
        return () => {
          const i = state.routes.indexOf(route.path);
          if (i >= 0) state.routes.splice(i, 1);
        };
      } },
      systemPrompt: { section: (opts) => {
        state.sections.push(opts.name);
        return () => {
          const i = state.sections.indexOf(opts.name);
          if (i >= 0) state.sections.splice(i, 1);
        };
      } },
      inject: (keys, cb) => {
        state.injected.push(keys);
        return () => {};
      },
      on: (event, handler) => {
        if (event === "agent/pre-step") state.preSteps.push(handler);
        return () => {};
      },
      effect: (fn) => {
        const disposer = fn();
        state.disposers.push(disposer);
        return disposer;
      },
    };
    return { ctx, state };
  }

  async function applied(options) {
    const { ctx, state } = makeCtx();
    await apply(ctx, options);
    return { ctx, state };
  }

  it("禁用不注册路由", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.routes.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注入提示词", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注册 pre-step", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用仅注册 dispose effect", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.disposers.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // announceToAgent:false：有路由无 section；announceCatalog:false：无 pre-step。
  const disabledAnnounce = () => applied({ announceToAgent: false, announceCatalog: false, storePath: join(homeDir, "st.json") });

  it("启用时注册全部路由", async () => {
    const { state } = await disabledAnnounce();
    expect(state.routes.length >= 9).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭宣告不注入提示词", async () => {
    const { state } = await disabledAnnounce();
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭目录不注册 pre-step", async () => {
    const { state } = await disabledAnnounce();
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // 默认开启：section + pre-step + settings 注入。
  const defaultOn = () => applied({ storePath: join(homeDir, "st2.json") });

  it("默认注入提示词 section", async () => {
    const { state } = await defaultOn();
    expect(state.sections.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("默认注册目录 pre-step", async () => {
    const { state } = await defaultOn();
    expect(state.preSteps.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("尝试注入 settings", async () => {
    const { state } = await defaultOn();
    expect(state.injected.some((k) => Array.isArray(k) && k.includes("settings"))).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("settings 注入回调通路（cb 收到 settings 服务即挂载成功）", async () => {
    const { ctx } = await defaultOn();
    // settings 注入回调挂 uiUpdate 的通路验证（cb 收到 settings 服务即挂载成功）。
    const settingsCalls = [];
    const settingsCtx = {
      logger: ctx.logger,
      effect: ctx.effect,
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({ settings: { update: async (ns, patch) => settingsCalls.push([ns, patch]) } });
        }
        return () => {};
      },
    };
    await apply(settingsCtx, { enabled: false });
    expect(typeof settingsCalls).toBe("object");
  });

  // effect disposer：卸载时注销路由与提示词。
  function unloadFixture() {
    return applied({ storePath: join(homeDir, "st3.json") });
  }

  it("默认注册多个 effect disposer", async () => {
    const { state } = await unloadFixture();
    expect(state.disposers.length >= 2).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("卸载注销全部路由", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.routes.length).toBe(0);
  });

  it("卸载注销提示词", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.sections.length).toBe(0);
  });
});

// #569：catalogViewFor 合成注入端目录视图（B 起步 + 中间层覆盖 + 磁盘兜底） ----
describe("#569 catalogViewFor 合成注入端目录视图", () => {
  let prevHome;
  let homeDir;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-catview-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const catalogFileFor = (root) =>
    join(homeDir, "dsh-mcp-catalog", `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
  const unitFor = (root, catalogEntries) => ({
    root,
    connections: new Map(),
    catalog: new Map(Object.entries(catalogEntries)),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  });
  const serversWith = (entries) => new Map(Object.entries(entries));

  async function catalogViewFixture() {
    // 项目 root 夹具用真实目录 + .git 标记：findProjectRoot 从该目录起步必然原样
    // 返回（跨平台确定，POSIX 字符串 "/proj" 在 Windows resolve 后形态不一致）。
    const projDir = join(homeDir, "proj");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    const { manager } = makeManager(homeDir);
    const mw = { units: new Map() };
    // B 缓存基底：supervisor 路径旧摘要（应被中间层覆盖 / 保留兜底）。
    manager.catalogCache.set("g1", { summary: "B-global-g1" });
    manager.catalogCache.set("g2", { summary: "B-global-g2" });
    manager.catalogCache.set("p1", { summary: "B-project-p1" });
    manager.catalogCache.set("p2", { summary: "B-project-p2" });
    manager.middleware = mw;
    return { manager, mw, projDir };
  }

  /** 场景 1：off 模式 → 纯 B 视图（中间层不参与；判 middlewareMode 非实例）。 */
  async function offView() {
    const { manager, mw, projDir } = await catalogViewFixture();
    manager.middlewareMode = "off";
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      p1: { server: { name: "p1" }, scope: "project" },
    });
    return { view: await manager.catalogViewFor(projDir, servers) };
  }

  it("off 模式全局走 B", async () => {
    const { view } = await offView();
    expect(view.get("g1")?.summary).toBe("B-global-g1");
  });

  it("off 模式项目走 B", async () => {
    const { view } = await offView();
    expect(view.get("p1")?.summary).toBe("B-project-p1");
  });

  /** 场景 2：all 模式 + @global 单元含 g1（内存目录）→ 覆盖 B；p1 项目单元覆盖。 */
  async function allView() {
    const { manager, mw, projDir } = await catalogViewFixture();
    manager.middlewareMode = "all";
    mw.units.set(
      "@global",
      unitFor("@global", {
        g1: { discoveredAt: 1, tools: new Map([["g_search", { description: "Global search the web for facts." }]]) },
      }),
    );
    mw.units.set(
      projDir,
      unitFor(projDir, {
        p1: { discoveredAt: 1, tools: new Map([["p_read", { description: "Project read files." }]]) },
      }),
    );
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      g2: { server: { name: "g2" }, scope: "global" },
      p1: { server: { name: "p1" }, scope: "project" },
    });
    return { view: await manager.catalogViewFor(projDir, servers) };
  }

  it("all 模式全局覆盖为中间层目录摘要", async () => {
    const { view } = await allView();
    expect(view.get("g1")?.summary).toBe("Global search the web for facts.");
  });

  it("中间层无 g2 → 保留 B", async () => {
    const { view } = await allView();
    expect(view.get("g2")?.summary).toBe("B-global-g2");
  });

  it("project scope 覆盖为项目单元摘要", async () => {
    const { view } = await allView();
    expect(view.get("p1")?.summary).toBe("Project read files.");
  });

  /** 场景 3：project 模式 + project scope → 项目单元；global scope 无 @global 残留 → B；
   *  场景 4：中间层有 unavailable → 视为无 → 磁盘兜底/保留 B。 */
  async function projectView() {
    const { manager, mw, projDir } = await catalogViewFixture();
    manager.middlewareMode = "project";
    mw.units.clear();
    mw.units.set(
      projDir,
      unitFor(projDir, {
        p1: { discoveredAt: 1, tools: new Map([["p_read", { description: "Project read files." }]]) },
        p2: { discoveredAt: 1, tools: new Map(), unavailable: "discovery failed" },
      }),
    );
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      p1: { server: { name: "p1" }, scope: "project" },
      p2: { server: { name: "p2" }, scope: "project" },
    });
    return { view: await manager.catalogViewFor(projDir, servers) };
  }

  it("project 模式项目级走中间层", async () => {
    const { view } = await projectView();
    expect(view.get("p1")?.summary).toBe("Project read files.");
  });

  it("project 模式全局无 @global 单元 → B", async () => {
    const { view } = await projectView();
    expect(view.get("g1")?.summary).toBe("B-global-g1");
  });

  it("unavailable 目录视为无 → 保留 B", async () => {
    const { view } = await projectView();
    expect(view.get("p2")?.summary).toBe("B-project-p2");
  });

  /** 场景 5：磁盘 last-good 兜底（单元缺失但 A 文件有该服务器）。 */
  async function diskView() {
    const { manager, mw } = await catalogViewFixture();
    manager.middlewareMode = "all";
    mw.units.clear(); // 单元全部缺失
    const diskRoot = "@global";
    const file = catalogFileFor(diskRoot);
    mkdirSync(join(homeDir, "dsh-mcp-catalog"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        root: diskRoot,
        entries: {
          g1: {
            discoveredAt: 1,
            tools: [{ name: "g_search", description: "Disk cached global search." }],
          },
        },
      }),
    );
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      g2: { server: { name: "g2" }, scope: "global" },
    });
    return { view: await manager.catalogViewFor(undefined, servers) };
  }

  it("单元缺失 → 磁盘 last-good 兜底", async () => {
    const { view } = await diskView();
    expect(view.get("g1")?.summary).toBe("Disk cached global search.");
  });

  it("磁盘无该服务器 → 保留 B", async () => {
    const { view } = await diskView();
    expect(view.get("g2")?.summary).toBe("B-global-g2");
  });
});
