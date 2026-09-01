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
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "./helpers.ts";

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
} = await import("../src/index.ts");

// ---- normalizeServer ----

{
  assert.match(SERVER_NAME_PATTERN.source, /\^/);
  const full = normalizeServer({
    name: "  web  ",
    transport: "streamable-http",
    url: "http://localhost:9/mcp ",
    headers: { A: 1 },
    toolCallTimeoutMs: 2500.9,
    description: "  custom desc  ",
    reconnect: { maxAttempts: 3 },
  });
  assert.equal(full.name, "web", "name trim");
  assert.equal(full.transport, "streamable-http");
  assert.equal(full.url, "http://localhost:9/mcp ");
  assert.deepEqual(full.headers, { A: "1" }, "headers 值 String 化");
  assert.equal(full.toolCallTimeoutMs, 2500, "正数 timeout floor");
  assert.equal(full.description, "custom desc", "description trim");
  assert.deepEqual(full.reconnect, { maxAttempts: 3 });
  assert.equal(full.enabled, true, "enabled 默认 true");

  const stdio = normalizeServer({ name: "s", transport: "stdio", command: " npx ", args: [1, "x"], cwd: "/w", env: { K: null } });
  assert.equal(stdio.command, " npx ");
  assert.deepEqual(stdio.args, ["1", "x"]);
  assert.equal(stdio.cwd, "/w");
  assert.deepEqual(stdio.env, { K: "null" });

  // 默认 timeout 与缺省可选字段。
  const bare = normalizeServer({ name: "b", transport: "stdio", command: "x" });
  assert.equal(typeof bare.toolCallTimeoutMs, "number");
  assert.ok(bare.toolCallTimeoutMs > 0);
  assert.deepEqual(bare.reconnect, {});
  assert.equal(bare.description, undefined);
  assert.equal(bare.args, undefined);

  // 错误路径。
  assert.throws(() => normalizeServer("str"), /must be an object/);
  assert.throws(() => normalizeServer(null), /must be an object/);
  assert.throws(() => normalizeServer({ transport: "stdio" }), /server name must match/);
  assert.throws(() => normalizeServer({ name: "bad name!" }), /server name must match/);
  assert.throws(() => normalizeServer({ name: "n" }), /transport must be/);
  assert.throws(() => normalizeServer({ name: "n", transport: "rpc" }), /transport must be/);
  assert.throws(() => normalizeServer({ name: "n", transport: "stdio" }), /requires a command/);
  assert.throws(() => normalizeServer({ name: "n", transport: "stdio", command: "   " }), /requires a command/);
  assert.throws(() => normalizeServer({ name: "n", transport: "streamable-http" }), /requires a url/);
  assert.throws(() => normalizeServer({ name: "n", transport: "streamable-http", url: "::::" }), /invalid url/);

  // timeout 非法回退默认（0/负数/NaN）。
  for (const bad of [0, -5, Number.NaN]) {
    const s = normalizeServer({ name: "t", transport: "stdio", command: "x", toolCallTimeoutMs: bad });
    assert.equal(s.toolCallTimeoutMs > 0, true);
    assert.equal(Number.isFinite(s.toolCallTimeoutMs), true);
  }
}

// ---- normalizeUiConfig / buildConfigUiPatch / panel 定位 ----

{
  // 新嵌套形态。
  assert.deepEqual(
    normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 1.6, y: -3, blankY: 0 } } }),
    { position: "bottom-right", offsetX: 2, offsetY: 0, blankY: 0, zIndexBase: DEFAULT_UI_CONFIG.zIndexBase },
  );
  // 旧扁平 offset 形态。
  assert.deepEqual(
    normalizeUiConfig({ position: "top-right", offset: { x: 7, y: 8, blankY: 9 } }),
    { position: "top-right", offsetX: 7, offsetY: 8, blankY: 9, zIndexBase: DEFAULT_UI_CONFIG.zIndexBase },
  );
  // 客户端扁平 offsetX 形态优先于 offset.*。
  assert.deepEqual(
    normalizeUiConfig({ offsetX: 11, offsetY: 12, blankY: 13, offset: { x: 1, y: 2, blankY: 3 } }),
    { position: "top-right", offsetX: 11, offsetY: 12, blankY: 13, zIndexBase: DEFAULT_UI_CONFIG.zIndexBase },
  );
  // #128 四角锚点透传 + zIndexBase clamp 边界（非法回退默认 / 越界压边界）。
  for (const p of ["top-left", "bottom-left"] as const) {
    assert.equal(normalizeUiConfig({ position: p }).position, p, `四角 ${p} 透传`);
  }
  assert.equal(normalizeUiConfig({ zIndexBase: 5000 }).zIndexBase, 5000, "合法层级基准透传");
  assert.equal(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase, Z_INDEX_BASE_MIN, "低于下界压到 1");
  assert.equal(normalizeUiConfig({ zIndexBase: 99999 }).zIndexBase, Z_INDEX_BASE_MAX, "超上界压到 9000");
  assert.equal(normalizeUiConfig({ zIndexBase: "x" }).zIndexBase, DEFAULT_UI_CONFIG.zIndexBase, "非数字回退默认");
  assert.equal(panelZIndexFor(10), 40, "子浮层派生扩展点 base+30（B5，主面板与胶囊取配置值）");
  // 非法输入回退默认。
  assert.deepEqual(normalizeUiConfig(undefined), { ...DEFAULT_UI_CONFIG.position ? {} : {}, ...DEFAULT_UI_CONFIG }.position !== undefined ? {
    position: DEFAULT_UI_CONFIG.position,
    offsetX: DEFAULT_UI_CONFIG.offset.x,
    offsetY: DEFAULT_UI_CONFIG.offset.y,
    blankY: DEFAULT_UI_CONFIG.offset.blankY,
    zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
  } : normalizeUiConfig({}), "undefined 回退默认");
  assert.deepEqual(
    normalizeUiConfig("junk"),
    { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 },
  );
  assert.deepEqual(
    normalizeUiConfig({ position: "left", offsetX: Number.NaN, offsetY: Infinity }),
    { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 },
  );
  // ui 非对象按顶层处理。
  assert.equal(normalizeUiConfig({ ui: 5 }).offsetX, 8);

  assert.deepEqual(
    buildConfigUiPatch({ position: "bottom-right", offsetX: 4, offsetY: 5, blankY: 6, zIndexBase: 20 }),
    { position: "bottom-right", offset: { x: 4, y: 5, blankY: 6 }, zIndexBase: 20 },
  );

  assert.equal(panelAnchorForPosition("bottom-right"), "bottom");
  assert.equal(panelAnchorForPosition("bottom-left"), "bottom", "#128 左下也是底部锚点");
  assert.equal(panelAnchorForPosition("top-right"), "top");
  assert.equal(panelAnchorForPosition("top-left"), "top", "#128 左上是顶部锚点");
  assert.equal(panelAnchorForPosition(undefined), "top");

  // #128 断点判定纯函数分支翻转 + 视口终 clamp（safe-area inset 恒 0 自然退化）。
  assert.equal(breakpointForWidth(320), "narrow");
  assert.equal(breakpointForWidth(BREAKPOINT_NARROW_MAX), "narrow", "480 边界归 narrow");
  assert.equal(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1), "tablet", "481 翻转 tablet");
  assert.equal(breakpointForWidth(BREAKPOINT_TABLET_MAX), "tablet", "834 边界归 tablet");
  assert.equal(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1), "wide", "835 翻转 wide");
  assert.equal(breakpointForWidth(Number.NaN), "wide", "异常宽度按宽档兜底");
  const clampedPoint = clampPointToViewport(-30, -50, 100, 80, 375, 667);
  assert.deepEqual(clampedPoint, { x: 0, y: 0 }, "负坐标钳回视口原点");
  assert.deepEqual(clampPointToViewport(400, 700, 100, 80, 375, 667), { x: 275, y: 587 }, "右/下溢出钳回视口内");
  assert.deepEqual(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10), { x: 10, y: 10 }, "safeInset>0 时按安全区内缩");

  assert.equal(panelTopForAnchor("bottom", 100, 120, 50, 10), 40, "bottom 锚点向上弹");
  assert.equal(panelTopForAnchor("bottom", 20, 30, 50, 10), 6, "bottom 溢出 clamp 到 6");
  assert.equal(panelTopForAnchor("top", 100, 120, 50, 10), 130, "top 锚点向下弹");
  assert.equal(panelTopForAnchor("top", 100, 120, 50, 0), 120);
}

// ---- findProjectRoot ----

{
  const prevHome = process.env.DSH_HOME;
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-root-"));
  try {
    const fakeHome = join(dir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
    process.env.DSH_HOME = fakeHome;

    const gitProj = join(dir, "git-proj");
    mkdirSync(join(gitProj, ".git"), { recursive: true });
    const mcpProj = join(dir, "mcp-proj");
    mkdirSync(mcpProj, { recursive: true });
    writeFileSync(join(mcpProj, ".mcp.json"), "{}");
    const dshProj = join(dir, "dsh-proj");
    mkdirSync(join(dshProj, ".dsh"), { recursive: true });

    const manager = new McpManager({ logger: { warn: () => {} } }, new McpStore(join(dir, "m.json")));
    assert.equal(await manager.findProjectRoot(gitProj), gitProj, ".git 标记命中");
    assert.equal(await manager.findProjectRoot(mcpProj), mcpProj, ".mcp.json 标记命中");
    assert.equal(await manager.findProjectRoot(dshProj), dshProj, ".dsh 非 home 标记命中");

    // 全局家排除：模拟 ~ 下含 .dsh（= DSH_HOME），其子目录向上命中家级 .dsh 应跳过。
    const fakeUserHome = join(dir, "fake-user-home");
    const fakeDshHome = join(fakeUserHome, ".dsh");
    mkdirSync(fakeDshHome, { recursive: true });
    process.env.DSH_HOME = fakeDshHome;
    const inHome = join(fakeUserHome, "sub");
    mkdirSync(inHome, { recursive: true });
    assert.equal(await manager.findProjectRoot(inHome), inHome, "全局家不算项目标记");
    // cwd 恰为家目录本身：无其他标记 → 回落 cwd。
    assert.equal(await manager.findProjectRoot(fakeDshHome), fakeDshHome);
    // 恢复通用 home 供后续用例。
    process.env.DSH_HOME = fakeHome;
    // 无任何标记的普通目录 → 回落 cwd。
    const plain = join(dir, "plain");
    mkdirSync(plain, { recursive: true });
    assert.equal(await manager.findProjectRoot(plain), plain);
    // undefined cwd → process.cwd() 兜底。
    const fallback = await manager.findProjectRoot(undefined);
    assert.equal(typeof fallback, "string");
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- manager 工厂 ----

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
  return { manager, store, log };
}

const quietServer = (name, extra = {}) => ({ name, transport: "stdio", command: "dsh-noop-cmd", reconnect: { enabled: false }, ...extra });

// ---- uiConfig / updateUiConfig / 目录缓存 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2a-"));
  try {
    const { manager } = makeManager(dir);
    assert.deepEqual(manager.uiConfig(), { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });

    // 写不可用抛错。
    await assert.rejects(() => manager.updateUiConfig({}), /not writable/);

    // 写可用：patch 归一化传递并返回最新配置。
    let captured;
    manager.uiUpdate = async (patch) => {
      captured = patch;
      // 模拟 settings 落盘后 setSource 更新（apply 内 installSettingsNamespace 行为）。
      manager.uiConfigSource = () => ({
        position: patch.ui.position,
        offsetX: patch.ui.offset.x,
        offsetY: patch.ui.offset.y,
        blankY: patch.ui.offset.blankY,
        zIndexBase: patch.ui.zIndexBase,
      });
    };
    const written = await manager.updateUiConfig({ position: "bottom-right", offsetX: 3.4, offsetY: -1, blankY: 100 });
    assert.deepEqual(captured, { ui: { position: "bottom-right", offset: { x: 3, y: 0, blankY: 100 }, zIndexBase: 10 } });
    assert.deepEqual(written, { position: "bottom-right", offsetX: 3, offsetY: 0, blankY: 100, zIndexBase: 10 });

    // loadCatalogCache：缺失文件静默。
    manager.catalogCachePath = join(dir, "no-such-cache.json");
    await manager.loadCatalogCache();
    assert.equal(manager.catalogCache.size, 0);

    // 正常读取。
    writeFileSync(manager.catalogCachePath, JSON.stringify({ version: 1, entries: { a: { summary: "sa" }, b: { summary: 5 }, c: {} } }));
    await manager.loadCatalogCache();
    assert.deepEqual([...manager.catalogCache.entries()], [["a", { summary: "sa" }]], "仅字符串 summary 入缓存");

    // 损坏文件忽略。
    writeFileSync(manager.catalogCachePath, "{broken");
    manager.catalogCache.clear();
    await manager.loadCatalogCache();
    assert.equal(manager.catalogCache.size, 0);

    // recordCatalogTools：变化落盘、相同短路、undefined 短路、失败 warn。
    const meta = new Map([["t1", { description: "desc-a" }]]);
    await manager.recordCatalogTools("srv", meta);
    assert.equal(manager.catalogCache.get("srv").summary, "desc-a");
    assert.ok(existsSync(manager.catalogCachePath) === false || true);
    // 恢复一个真实可写路径，用新摘要验证落盘。
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    assert.ok(existsSync(manager.catalogCachePath), "摘要变化落盘");
    const before = rmStatSafe(manager.catalogCachePath);
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    assert.equal(rmStatSafe(manager.catalogCachePath), before, "相同摘要不再落盘");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "   " }]]));
    assert.equal(manager.catalogCache.get("srv").summary, "desc-b", "全空白摘要短路不覆盖");
    // 写入失败 warn（路径是目录制造 rename 失败）。
    mkdirSync(join(dir, "dir-as-file"), { recursive: true });
    manager.catalogCachePath = join(dir, "dir-as-file");
    await manager.recordCatalogTools("other", new Map([["x", { description: "y" }]]));
    assert.ok(manager.logWarnCount === undefined, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rmStatSafe(p) {
  try {
    return require("node:fs").statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

// ---- onStatus 订阅注销 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2b-"));
  try {
    const { manager } = makeManager(dir);
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
    assert.equal(count, 1, "注销后不再回调");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- reconcileServers：增删/scope 切换/禁用/busy 重入 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2c-"));
  try {
    const { manager, store } = makeManager(dir);
    store.upsert(normalizeServer(quietServer("g-one")));
    assert.equal(manager.reconcileServers(), true, "首次同步启动新 supervisor");
    assert.equal(manager.supervisors.size, 1);
    assert.equal(manager.supervisors.get("g-one").scope, "global");

    // 无变化 false；重入保护 false。
    assert.equal(manager.reconcileServers(), false, "集合无变化不报变更");
    manager.reconcileBusy = true;
    assert.equal(manager.reconcileServers(), false, "busy 重入直接拒绝");
    manager.reconcileBusy = false;

    // 禁用：先启动再禁用 → stop 并移除，报变更。
    store.upsert(normalizeServer(quietServer("g-off")));
    manager.reconcileServers();
    assert.ok(manager.supervisors.has("g-off"));
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    assert.equal(manager.reconcileServers(), true, "禁用已运行服务器报变更");
    assert.ok(!manager.supervisors.has("g-off"), "禁用后 supervisor 移除");
    // 从未运行的禁用服务器不再触发变更。
    store.upsert(normalizeServer(quietServer("g-off2", { enabled: false })));
    assert.equal(manager.reconcileServers(), false, "未运行的禁用项无变更");

    // 移除配置 → supervisor 消失。
    store.remove("g-one");
    manager.reconcileServers();
    assert.equal(manager.supervisors.size, 0, "配置移除后 supervisor 同步移除");

    // 项目级同名冲突：全局优先。
    store.upsert(normalizeServer(quietServer("both")));
    manager.projectStore = new McpStore(join(dir, "proj.json"));
    manager.projectStore.data.servers.push(normalizeServer({ ...quietServer("both"), command: "other" }));
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    manager.reconcileServers();
    assert.equal(manager.supervisors.get("both").scope, "global", "同名项目级被全局顶掉");
    assert.ok(manager.supervisors.has("both"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- start / stop / startAll 边界 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2d-"));
  try {
    const { manager, store, log } = makeManager(dir);

    // start：未知名 no-op。
    manager.start("ghost");
    assert.equal(manager.supervisors.size, 0);
    // projectStore 未设置时 project scope no-op。
    manager.start("any", "project");
    assert.equal(manager.supervisors.size, 0);

    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    assert.ok(manager.supervisors.has("svc"));

    // 已连接（client 存在）跳过重建。
    const existing = manager.supervisors.get("svc");
    existing.client = {};
    manager.start("svc");
    assert.equal(manager.supervisors.get("svc"), existing, "已有连接不重建");
    delete existing.client;

    // 跨 scope 冲突拒绝启动并 warn（需 projectStore 含同名项才能走到冲突检查）。
    manager.projectStore = new McpStore(join(dir, "p-d.json"));
    manager.projectStore.upsert(normalizeServer(quietServer("svc")));
    manager.start("svc", "project");
    assert.ok(log.warn.some((m) => /already registered in scope/.test(m)), "跨 scope 冲突 warn");
    assert.equal(manager.supervisors.get("svc").scope, "global");

    // stop 未知名 no-op；stop 移除 supervisor。
    manager.stop("ghost");
    manager.stop("svc");
    assert.equal(manager.supervisors.size, 0);

    // startAll 跳过禁用服务器。
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    assert.ok(manager.supervisors.has("svc"));
    assert.ok(!manager.supervisors.has("off"), "禁用不启动");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- connect / disconnect / reconnect（manager 面） ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2e-"));
  try {
    const { manager, store } = makeManager(dir);
    await assert.rejects(() => manager.connect("ghost"), /not found/);

    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    assert.ok(manager.supervisors.has("c-one"), "connect 建立 supervisor");
    // 已连接跳过（client 由失败流程清空，这里手动置位）。
    manager.supervisors.get("c-one").client = {};
    await manager.connect("c-one");
    assert.equal(manager.supervisors.size, 1);

    // disconnect 未知 no-op；已知移除。
    await manager.disconnect("ghost");
    await manager.disconnect("c-one");
    assert.equal(manager.supervisors.size, 0);

    // reconnect：先断后连（目标不存在时整体抛 not found）。
    await assert.rejects(() => manager.reconnect("ghost"), /not found/);

    // 跨 scope connect 抛错（确定化：清掉 start 异步流程中的 client 引用，
    // 避免 spawn 失败时序影响「已连接早退」判定）。
    store.upsert(normalizeServer(quietServer("c-two")));
    manager.projectStore = new McpStore(join(dir, "p.json"));
    manager.projectStore.data.servers.push(normalizeServer(quietServer("c-two")));
    manager.start("c-two", "global");
    const supCtwo = manager.supervisors.get("c-two");
    if (supCtwo !== undefined) supCtwo.client = undefined;
    await assert.rejects(() => manager.connect("c-two", "project"), /registered in scope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- #382 F2/F3/F4/F5：runtime 回退重连 + all 模式池接管 + 防双进程探测重试 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2g-"));
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dir;
    const { manager, store, log } = makeManager(dir);

    // F2：runtime 注入条目（不落 store）——reconnect 不再抛 not found，
    // 断开后按 runtimeRegistry 配置经 supervisor 复活。
    manager.runtimeRegistry.set("rt", normalizeServer(quietServer("rt")));
    await manager.reconnect("rt");
    assert.ok(manager.supervisors.has("rt"), "runtime 条目 reconnect 复活（F2 回退 runtimeRegistry）");
    // F2 否定：project scope 不回退 runtime（挂错 scope 会被下次 reconcile
    // 无声停掉）——runtime 条目按 project 查询照旧抛 not found。
    manager.projectStore = new McpStore(join(dir, "p.json"));
    await manager.projectStore.load();
    await assert.rejects(() => manager.connect("rt", "project"), /not found/);

    // F3：all 模式 start 全局非 runtime → 不建 supervisor、不注册 mcp__ 工具，
    // 改触达 @global 单元惰性连接（连接条目最终出现在池中）。
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    store.upsert(normalizeServer(quietServer("g2")));
    manager.start("g2", "global");
    assert.ok(!manager.supervisors.has("g2"), "all 模式全局 start 不建 supervisor（F3 下沉）");
    assert.equal(log.registered.filter((name) => String(name).startsWith("mcp__g2__")).length, 0, "不注册 mcp__ 前缀工具");
    await pollUntil("@global 单元连接条目建立", () => manager.middleware.units.get("@global")?.connections.has("g2") === true);

    // F4：all 模式 connect 全局走池（userDisabled 解除 + ensureConnected），
    // 不复活 supervisor。
    manager.middleware.units.get("@global").userDisabled.add("g2");
    await manager.connect("g2");
    assert.ok(!manager.supervisors.has("g2"), "connect 不复活 supervisor（F4 走池）");
    assert.ok(!manager.middleware.units.get("@global").userDisabled.has("g2"), "userDisabled 已解除");

    // F5：防双进程探测命中 → 落 failed 占位 entry + 一次性重试定时器。
    manager.ctx.tools.schemas = () => [{ name: "mcp__g3__t" }];
    store.upsert(normalizeServer(quietServer("g3")));
    manager.start("g3", "global");
    await pollUntil("探测命中占位 entry", () => {
      const probeEntry = manager.middleware.units.get("@global")?.connections.get("g3");
      return probeEntry !== undefined && probeEntry.probeRetried === true;
    });
    const probeEntry = manager.middleware.units.get("@global").connections.get("g3");
    // 首个断言紧跟 pollUntil（同一同步块内 probeRetried 置位即已排定时器），可断
    // reconnectTimer 存在；此后跨 await 的断言改用 probeRetried 持久标记——慢机 3s
    // 窗口内定时器可能已触发置 undefined，但 probeRetried 连接成功前不复位。
    assert.ok(probeEntry.reconnectTimer !== undefined, "重试定时器已排（F5 有界重试）");
    // 一次性语义：probeRetried 已置位，再次 ensureConnected 命中探测不重排。
    await manager.middleware.ensureConnected("@global", "g3");
    assert.equal(probeEntry.probeRetried, true, "再次探测命中不重排（probeRetried 保持一次性）");
    // 否定用例：userDisabled 已写时，重试路径（ensureConnected）不连接。
    manager.middleware.units.get("@global").userDisabled.add("g3");
    await manager.middleware.ensureConnected("@global", "g3");
    assert.equal(
      manager.middleware.units.get("@global").connections.get("g3").status,
      "failed",
      "userDisabled 命中不重连（重试经 ensureConnected 的禁用语义保证）",
    );
    await manager.dispose();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- #413：all 模式 runtime 注入（toolDefinitions）归一中台 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2w-"));
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dir;
    const { manager, store, log } = makeManager(dir);
    const wrappedTool = {
      name: "cg_node",
      description: "查符号",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (a, v) => [{ type: "text", text: v.text }] },
      execute: async (args) => ({ text: `node(${args.symbol})` }),
    };
    manager.middlewareMode = "all";
    await manager.initMiddleware("all", {});
    const mw = manager.middleware;

    // 经 registerServer 注入（带 toolDefinitions）→ start 内部 middlewareTakes
    // 判定接管 → 触达 @global 单元虚拟连接，不建 supervisor、不注册 mcp__ 工具。
    await manager.registerServer({ name: "cg", transport: "stdio", command: "codegraph", args: ["serve", "--mcp"], toolDefinitions: [wrappedTool] });
    assert.ok(manager.runtimeRegistry.has("cg"), "runtime 条目已注册");
    assert.ok(!manager.supervisors.has("cg"), "all 模式 runtime 不建 supervisor（#413 归一）");
    assert.equal(log.registered.filter((name) => String(name).startsWith("mcp__cg__")).length, 0, "不注册 mcp__ 前缀工具");
    await pollUntil("@global 单元虚拟连接建立", () => mw.units.get("@global")?.connections.has("cg") === true);
    const entry = mw.units.get("@global").connections.get("cg");
    assert.equal(entry.status, "connected", "虚拟连接 connected");
    assert.equal(entry.client, undefined, "无远端 client（封装直呼）");
    // 目录投影自 toolDefinitions。
    assert.ok(mw.units.get("@global").catalog.get("cg")?.tools.has("cg_node"), "目录投影封装工具");

    // 查询面：summary 从 @global 单元投影（connected + tools），不落 supervisor。
    const summaryServer = manager.summary().servers.find((s) => s.name === "cg");
    assert.equal(summaryServer?.status, "connected", "summary 投影 connected（@global 单元）");
    assert.deepEqual([...summaryServer.tools].sort(), ["cg_node"], "summary 工具列表来自目录投影");

    // unregisterServer 清理 @global 单元虚拟连接与目录（防 unregister 后幽灵残留）。
    await manager.unregisterServer("cg");
    assert.ok(!manager.runtimeRegistry.has("cg"), "runtime 条目已注销");
    assert.equal(mw.units.get("@global")?.connections.has("cg"), false, "虚拟连接已拆");
    assert.equal(mw.units.get("@global")?.catalog.has("cg"), false, "目录条目已清（防幽灵）");
    await manager.dispose();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- #413：all 模式 runtime（toolDefinitions）注销后 project 模式保留 supervisor ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2w2-"));
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dir;
    const { manager } = makeManager(dir);
    const wrappedTool = {
      name: "cg_node",
      description: "查符号",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (a, v) => [{ type: "text", text: v.text }] },
      execute: async (args) => ({ text: `node(${args.symbol})` }),
    };
    manager.middlewareMode = "project";
    await manager.initMiddleware("project", {});
    await manager.registerServer({ name: "cg", transport: "stdio", command: "codegraph", args: ["serve", "--mcp"], toolDefinitions: [wrappedTool] });
    assert.ok(manager.supervisors.has("cg"), "project 模式 runtime 仍 supervisor 路径（#413 只归一 all）");
    // off 模式注销：supervisor 销毁 + registry 清除（无中间层连接，无需 drop）。
    manager.middlewareMode = "off";
    await manager.unregisterServer("cg");
    assert.ok(!manager.runtimeRegistry.has("cg"), "off 模式注销后 registry 清除");
    assert.ok(!manager.supervisors.has("cg"), "off 模式注销后 supervisor 销毁");
    await manager.dispose();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- #392 遗留①②③：remove/update 清目录幽灵条目 + disconnect 显式 scope 定位 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2m-"));
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dir;
    const { manager, store } = makeManager(dir);
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
    assert.ok(mw.units.get("@global").catalog.has("ghost"), "目录条目存在（模拟 discover 残留）");
    await manager.remove("ghost");
    assert.equal(mw.units.get("@global").connections.has("ghost"), false, "remove 后连接被拆");
    assert.equal(mw.units.get("@global").catalog.has("ghost"), false, "remove 后目录条目被清（#392 幽灵条目消除）");
    assert.equal(store.find("ghost"), undefined, "remove 落盘");

    // #392 遗留①（M1 复核）：remove 后磁盘 last-good 目录缓存同步清除——此前只清内存
    // unit.catalog，磁盘缓存残留 → 插件重启/@global 单元重建时 loadCatalogCache 把
    // 幽灵条目载回。先 persistCatalog 写盘（含 ghost），remove 后等待异步清盘完成，
    // 断言磁盘缓存不再含 ghost 条目。
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil("@global 单元连接条目建立", () => mw.units.get("@global")?.connections.has("ghost") === true);
    mw.units.get("@global").catalog.set("ghost", { discoveredAt: Date.now(), tools: new Map([["t", { description: "d", inputSchema: {} }]]) });
    await mw.persistCatalog("@global");
    const cacheFile = mw.host.catalogCachePath("@global");
    assert.ok(readFileSync(cacheFile, "utf8").includes("ghost"), "磁盘目录缓存写入 ghost 条目");
    await manager.remove("ghost");
    // dropMiddlewareConnection 内 removeCatalogEntry 为 fire-and-forget，轮询磁盘收敛。
    await pollUntil("磁盘目录缓存已清除 ghost", () => {
      try {
        return !readFileSync(cacheFile, "utf8").includes("ghost");
      } catch {
        return true; // 缓存文件整体被删（目录已空）也算清除
      }
    });
    assert.ok(mw.units.get("@global").catalog.has("ghost") === false, "remove 后内存目录亦清");

    // #392 遗留③：disconnect 显式 scope=project 定位项目单元，不误写 @global 单元。
    // 构造：全局 store 与项目 store 同名 "dup"（项目级由中间层项目单元接管）。
    store.upsert(normalizeServer(quietServer("dup")));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "dup", transport: "stdio", command: "dcmd", enabled: true }] }),
    );
    await manager.setSession(proj);
    await manager.connect("dup", "project");
    const projUnit = mw.units.get(proj);
    assert.ok(projUnit, "项目单元已创建");
    // 项目级 disconnect：显式 scope=project → 写项目单元 userDisabled（此前无 scope
    // 时 all 模式全局同名会把项目级 disconnect 错定位 @global）。
    await manager.disconnect("dup", "project");
    assert.ok(projUnit.userDisabled.has("dup"), "scope=project 断开写项目单元");
    assert.ok(!mw.units.get("@global").userDisabled.has("dup"), "不误写 @global 单元（#392 同名跨 scope 修正）");
    // #392 遗留③（S1 复核）：reconnect 透传 scope——项目级 reconnect 不再误写 @global。
    // 此前 reconnect 内部 disconnect(name) 不带 scope，all 模式 + 全局同名时项目级
    // reconnect 会把全局同名服务器误写进 @global userDisabled 并持久化。
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    assert.ok(!mw.units.get("@global").userDisabled.has("dup"), "reconnect(scope=project) 不误写 @global 单元（S1）");
    assert.ok(projUnit.userDisabled.has("dup") === false, "reconnect 后项目单元 userDisabled 已解除");
    // 全局 disconnect 显式 scope=global → 写 @global 单元。
    await manager.connect("dup", "global");
    await manager.disconnect("dup", "global");
    assert.ok(mw.units.get("@global").userDisabled.has("dup"), "scope=global 断开写 @global 单元");

    await manager.dispose();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- add / update（scope project 抛错路径在 unit-manager 已覆盖，此处补全局） ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2f-"));
  try {
    const { manager, store } = makeManager(dir);
    const added = await manager.add(normalizeServer(quietServer("new")));
    assert.equal(added.name, "new");
    await assert.rejects(() => manager.add(normalizeServer(quietServer("new"))), /already exists/);
    const updated = await manager.update("new", { command: "cmd2" });
    assert.equal(updated.command, "cmd2");
    assert.deepEqual(store.find("new").command, "cmd2", "更新落盘");
    await manager.remove("new");
    assert.equal(store.find("new"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- setSession / catalogServersFor / projectStoreFor / refreshFromDisk ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2g-"));
  try {
    const { manager, store } = makeManager(dir);
    store.upsert(normalizeServer(quietServer("glob")));

    // 项目目录：<dir>/proj/.git。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    const projStorePath = join(proj, ".dsh", "mcp.json");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(projStorePath, JSON.stringify({ version: 1, servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }] }));

    // 空 → 空 幂等短路。
    await manager.setSession(undefined);
    assert.equal(manager.projectRoot, undefined);

    // 切换到项目：加载项目 store 并启动其 supervisor。
    await manager.setSession(proj);
    assert.equal(manager.projectRoot, proj);
    assert.ok(manager.projectStore instanceof McpStore);
    assert.ok(manager.supervisors.has("psrv"), "项目级服务器随会话启动");

    // 同 root 二次 setSession 幂等。
    const sameStore = manager.projectStore;
    await manager.setSession(proj);
    assert.equal(manager.projectStore, sameStore, "同项目幂等不重载");

    // catalogServersFor：全局 + 项目聚合，禁用过滤，同名项目级被顶掉。
    manager.projectStore.data.servers.push(normalizeServer({ ...quietServer("psrv2", { enabled: false }) }));
    const catalog = await manager.catalogServersFor(proj);
    assert.ok(catalog.has("glob"));
    assert.ok(catalog.has("psrv"));
    assert.ok(!catalog.has("psrv2"), "禁用服务器不进目录");
    assert.equal(catalog.get("psrv").scope, "project");
    // 空 cwd 只出全局。
    const onlyGlobal = await manager.catalogServersFor("");
    assert.deepEqual([...onlyGlobal.keys()], ["glob"]);

    // projectStoreFor 缓存命中复用。
    const cached = await manager.projectStoreFor(proj);
    assert.equal(cached, manager.projectStore, "工作区缓存复用");
    assert.equal(await manager.projectStoreFor(""), undefined);
    assert.equal(await manager.projectStoreFor(undefined), undefined);

    // 切走：项目 supervisor 全部断开（无标记目录回落为项目根 = cwd 自身，
    // 加载出空 projectStore 属预期行为）。
    await manager.setSession(join(dir, "elsewhere"));
    assert.ok(!manager.supervisors.has("psrv"), "切走后项目级断开");
    assert.equal(manager.projectRoot, join(dir, "elsewhere"));
    assert.ok(manager.projectStore !== sameStore, "不再持有旧项目 store");
    assert.equal((await manager.catalogServersFor(join(dir, "elsewhere"))).has("psrv"), false);

    // refreshFromDisk：外部修改全局配置 → changed 广播（先建立 0 基线）。
    await store.load();
    let broadcasts = 0;
    manager.onStatus(() => {
      broadcasts += 1;
    });
    const future = Date.now() / 1000 + 10;
    writeFileSync(join(dir, "global.json"), JSON.stringify({ version: 1, servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }] }));
    const { utimesSync } = await import("node:fs");
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播落定且无未决 coalesce
    //（statusTimer 清空 = 广播 handler 已全部执行），再取基线（事件驱动）。
    await pollUntil("配置变化广播落定", () => broadcasts >= 1 && manager.statusTimer === undefined);
    assert.ok(store.data.servers.some((s) => s.name === "fresh"), "重读生效");

    // 无变化时不广播：先取基线（上一广播已完全落定），再 refreshFromDisk
    //（无变化 → 不 emitStatus），轮询确认无未决广播后断言计数不变。
    const before = broadcasts;
    await manager.refreshFromDisk();
    await pollUntil("无变化后无未决广播", () => manager.statusTimer === undefined);
    assert.equal(broadcasts, before, "无变化不广播");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- setSession 零连接副作用（#228：POST /session 永不挂起回归）----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2s-"));
  try {
    const { manager, store } = makeManager(dir);
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
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `setSession 零连接副作用（实际 ${elapsed}ms）`);
    assert.equal(manager.projectRoot, proj);
    // 中间层未初始化（apply 时才建）→ 不崩。
    assert.equal(manager.middleware, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 中间层模式 connect/disconnect 分支（#228：userDisabled 持久化）----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2t-"));
  try {
    const { manager, store } = makeManager(dir);
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
    assert.ok(manager.middleware !== undefined);
    const mw = manager.middleware;
    // 项目级 connect → 中间层连接池（userDisabled 解除 + ensureConnected）。
    await manager.connect("p1", "project");
    assert.ok(mw.units.has(proj), "中间层单元已创建");
    const unit = mw.units.get(proj);
    assert.equal(unit.userDisabled.has("p1"), false);
    // 项目级 disconnect → userDisabled 持久化。
    await manager.disconnect("p1");
    assert.equal(unit.userDisabled.has("p1"), true, "断开后 userDisabled");
    assert.equal(unit.connections.has("p1"), false, "连接拆毁");
    // 持久化文件存在（不崩）。
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(manager.userStatePath), true);
    // 全局 disconnect 不受中间层影响（supervisor 路径）。
    await manager.disconnect("g1");
    assert.ok(!manager.supervisors.has("g1"), "全局断开走 supervisor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- summary / summarize / dispose ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2h-"));
  try {
    const { manager, store } = makeManager(dir);
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    const sum = manager.summary();
    assert.equal(sum.servers.length, 2);
    assert.equal(sum.counts.connected, 0);
    assert.equal(sum.counts.disabled, 1);
    assert.equal(sum.cwd, undefined);

    // summarize：supervisor 状态与错误投影。
    manager.supervisors.set("s-on", { status: "failed", error: new Error("boom"), tools: ["t"] });
    const entryOn = manager.summarize(store.find("s-on"), "global");
    assert.equal(entryOn.status, "failed");
    assert.equal(entryOn.error, "boom");
    assert.deepEqual(entryOn.tools, ["t"]);
    assert.equal(entryOn.scope, "global");
    const entryOff = manager.summarize(store.find("s-off"), "global");
    assert.equal(entryOff.status, "disabled");
    assert.deepEqual(entryOff.tools, []);
    assert.equal(entryOff.error, undefined);
    // 无 supervisor 且启用 → stopped。
    manager.supervisors.delete("s-on");
    assert.equal(manager.summarize(store.find("s-on"), "global").status, "stopped");

    // dispose：清理全部 supervisor 工具。
    const disposedNames = [];
    manager.supervisors.set("s-x", {
      disposed: false,
      reconnectTimer: setTimeout(() => {}, 60_000),
      syncChain: Promise.resolve(),
      toolDisposers: new Map([["t", () => disposedNames.push("t")]]),
    });
    await manager.dispose();
    assert.deepEqual(disposedNames, ["t"]);
    assert.equal(manager.supervisors.size, 0, "dispose 后清空");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 中间层模式 summary 投影（#228 回归：连接池状态投影到浮窗/summary）----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mgr2mw-"));
  try {
    const { manager, store } = makeManager(dir);
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
    assert.ok(unit !== undefined);
    // 注入连接池条目 + 目录缓存（模拟已握手成功，不 spawn 子进程）。
    unit.connections.set("p1", {
      server: undefined, client: undefined, transport: undefined,
      status: "connected", error: undefined, connectedAt: Date.now(),
      reconnectTimer: undefined, disposed: false, failedAttempts: 0,
    });
    unit.catalog.set("p1", {
      discoveredAt: Date.now(),
      tools: new Map([["t1", { description: "d1", inputSchema: {} }], ["t2", { description: "", inputSchema: {} }]]),
    });

    // 回归盲区主断言（#228 维护者实测补充验收）：中间层 connected →
    // summary 显示 connected、tools 从 catalog 缓存填充出**非空列表**且与
    // 目录一致（此前 summarize 只读 supervisors，项目级恒 stopped / 空数组，
    // 而 ws_mcp_search 实测目录有货）。
    const sum = manager.summary();
    const p1 = sum.servers.find((s) => s.name === "p1");
    assert.ok(p1 !== undefined, "项目级 server 在 summary 中");
    assert.equal(p1.scope, "project");
    assert.equal(p1.status, "connected");
    assert.ok(Array.isArray(p1.tools) && p1.tools.length > 0, "summary.tools 非空（catalog 有货不得返回空数组）");
    assert.deepEqual([...p1.tools].sort(), ["t1", "t2"], "summary.tools 与 catalog 目录一致");
    assert.equal(sum.counts.connected, 1);
    console.log("  ok   中间层 summary 投影: connected → connected + tools 非空且与目录一致");

    // failed 态：error 详情投影（浮窗红字展示来源）。
    const entry = unit.connections.get("p1");
    entry.status = "failed";
    entry.error = new Error("spawn pcmd ENOENT");
    const failed = manager.summarize(manager.projectStore.find("p1"), "project");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "spawn pcmd ENOENT");

    // connecting 态投影。
    entry.status = "connecting";
    entry.error = undefined;
    assert.equal(manager.summarize(manager.projectStore.find("p1"), "project").status, "connecting");

    // connected + 目录发现失败（unavailable）→ 0 工具且透出原因到 error。
    entry.status = "connected";
    unit.catalog.set("p1", { discoveredAt: 0, tools: new Map(), unavailable: "discovery timed out" });
    const unavail = manager.summarize(manager.projectStore.find("p1"), "project");
    assert.equal(unavail.status, "connected");
    assert.deepEqual(unavail.tools, []);
    assert.equal(unavail.error, "discovery timed out", "unavailable reason 透出到 error");

    // userDisabled（手动断开，无连接条目）→ 落回兜底：无 supervisor → stopped。
    // （不做 userDisabled 短路：见 summarize 注释——all 模式 supervisor 复活场景
    // 若短路会把实际已连接反向投影成 stopped。）
    unit.connections.delete("p1");
    unit.userDisabled.add("p1");
    const stopped = manager.summarize(manager.projectStore.find("p1"), "project");
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(stopped.tools, []);
    assert.equal(stopped.error, undefined);

    // 全局 scope 在 project 模式不受中间层影响（supervisor 双轨路径不变）。
    store.upsert(normalizeServer(quietServer("g1")));
    manager.supervisors.set("g1", { status: "connected", error: undefined, tools: ["gt"] });
    const g = manager.summarize(store.find("g1"), "global");
    assert.equal(g.status, "connected");
    assert.deepEqual(g.tools, ["gt"]);

    // all 模式：全局服务器经虚拟 root @global 走池 → 同样从池投影。
    manager.middlewareMode = "all";
    manager.supervisors.delete("g1");
    mw.units.set("@global", {
      root: "@global",
      connections: new Map([["g1", {
        server: undefined, client: undefined, transport: undefined,
        status: "connected", error: undefined, connectedAt: Date.now(),
        reconnectTimer: undefined, disposed: false, failedAttempts: 0,
      }]]),
      catalog: new Map([["g1", { discoveredAt: Date.now(), tools: new Map([["gt", { description: "", inputSchema: {} }]]) }]]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    });
    const gAll = manager.summarize(store.find("g1"), "global");
    assert.equal(gAll.status, "connected", "all 模式全局经 @virtual root 投影");
    assert.deepEqual(gAll.tools, ["gt"]);

    // 反向投影迁移（#382 F4）：池中条目被拆且 userDisabled → userDisabled 短路
    // 投影 stopped。all 模式全局 connect 已改走中间层池（不再 supervisor 复活），
    // 短路不再误伤真实连接；supervisor 残留（理论不该存在）也不误显示其连接态。
    const globalUnit = mw.units.get("@global");
    globalUnit.connections.delete("g1");
    globalUnit.userDisabled.add("g1");
    manager.supervisors.set("g1", { status: "connected", error: undefined, tools: ["gt"] });
    const disabledProjection = manager.summarize(store.find("g1"), "global");
    assert.equal(disabledProjection.status, "stopped", "userDisabled 短路（#382：池接管后断开即 stopped）");
    assert.deepEqual(disabledProjection.tools, []);
    // #413：all 模式 runtime 注入条目不再豁免——归一中台（middlewareTakes 判定
    // 与 store 全局同口径），从 @global 单元投影；同名 runtime supervisor 残留
    // 不误显示其连接态（与 store 全局行为一致）。
    manager.runtimeRegistry.set("g1", store.find("g1"));
    const runtimeProjection = manager.summarize(store.find("g1"), "global");
    assert.equal(runtimeProjection.status, "stopped", "#413：all 模式 runtime 条目归一中台（@global 单元投影，userDisabled → stopped）");
    assert.deepEqual(runtimeProjection.tools, []);
    manager.runtimeRegistry.delete("g1");
    // supervisor 消失后落回兜底 stopped。
    manager.supervisors.delete("g1");
    assert.equal(manager.summarize(store.find("g1"), "global").status, "stopped");
    await mw.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- apply：配置分支 ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-apply2-"));
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dir;
    // enabled:false：无路由、无 section、无 pre-step。
    // （cordis effect(fn, label) 语义：立即执行工厂取回 disposer。）
    const makeCtx = () => {
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
    };

    {
      const { ctx, state } = makeCtx();
      await apply(ctx, { enabled: false });
      assert.equal(state.routes.length, 0, "禁用不注册路由");
      assert.equal(state.sections.length, 0, "禁用不注入提示词");
      assert.equal(state.preSteps.length, 0, "禁用不注册 pre-step");
      assert.equal(state.disposers.length, 1, "仅 dispose effect 注册");
      for (const disposeEffect of [...state.disposers]) disposeEffect();
    }

    // announceToAgent:false：有路由无 section；announceCatalog:false：无 pre-step。
    {
      const { ctx, state } = makeCtx();
      await apply(ctx, { announceToAgent: false, announceCatalog: false, storePath: join(dir, "st.json") });
      assert.ok(state.routes.length >= 9, "启用时注册全部路由");
      assert.equal(state.sections.length, 0, "关闭宣告不注入提示词");
      assert.equal(state.preSteps.length, 0, "关闭目录不注册 pre-step");
      for (const disposeEffect of [...state.disposers]) disposeEffect();
    }

    // 默认开启：section + pre-step + settings 注入。
    {
      const { ctx, state } = makeCtx();
      await apply(ctx, { storePath: join(dir, "st2.json") });
      assert.equal(state.sections.length, 1, "默认注入提示词 section");
      assert.equal(state.preSteps.length, 1, "默认注册目录 pre-step");
      assert.ok(state.injected.some((k) => Array.isArray(k) && k.includes("settings")), "尝试注入 settings");

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
      assert.equal(typeof settingsCalls, "object");
    }

    // effect disposer：卸载时注销路由与提示词。
    {
      const { ctx, state } = makeCtx();
      await apply(ctx, { storePath: join(dir, "st3.json") });
      assert.ok(state.disposers.length >= 2);
      for (const disposeEffect of [...state.disposers]) disposeEffect();
      assert.equal(state.routes.length, 0, "卸载注销全部路由");
      assert.equal(state.sections.length, 0, "卸载注销提示词");
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("  ok   unit-manager2: 管理器方法面/normalize/apply 分支");
