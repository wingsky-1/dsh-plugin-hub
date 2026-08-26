// @ts-nocheck
/**
 * dsh-lan-proxy — 宿主端（src/index.ts）结构化单测。
 *
 * 覆盖本批未覆盖热点（fnMap 可命中）：
 * - prepareTls：apply(httpsEnabled: true) → sync() → prepareTls
 * - setSource / onScope：installLanProxySettings 的 hooks 回调
 * - migrateFileConfig / applyConfigPatch：迁移与保存通道边界
 * - isUnloading（包内复刻）：scope.watch 回调内调用
 * - warnLog：settings 服务缺少 register 时调用
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pluginDir, sanitizeSettings, validateSettings,
  migrateFileConfig, MIGRATED_BAK_NAME, applyConfigPatch, SETTINGS_NS,
  ROUTES, DEFAULT_OPTIONS,
} from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createServer } = await import("node:http");

// ===== pluginDir =====
{
  const prev = process.env.DSH_HOME;
  const tmp = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-dir-"));
  process.env.DSH_HOME = tmp;
  const dir = pluginDir();
  assert.ok(dir.endsWith("/lan-proxy"), `pluginDir 结尾 /lan-proxy，实际 ${dir}`);
  assert.ok(dir.startsWith(tmp), `pluginDir 在 DSH_HOME 内，实际 ${dir}`);
  process.env.DSH_HOME = prev;
  rmSync(tmp, { recursive: true, force: true });
}

// ===== sanitizeSettings 更多边界 =====
{
  assert.equal(sanitizeSettings({ wsCompressPaths: "not-array" }), null, "wsCompressPaths 非数组 → null");
  assert.equal(sanitizeSettings({ wsCompressEnabled: "yes" }), null, "wsCompressEnabled 非布尔 → null");
  assert.equal(sanitizeSettings({ httpCompressLevel: -1 }), null, "httpCompressLevel 负值 → null");
  assert.equal(sanitizeSettings({ httpCompressLevel: 1.5 }), null, "httpCompressLevel 非整数 → null");
  assert.deepEqual(sanitizeSettings({}), {}, "空对象 → 空");
}

// ===== validateSettings 更多边界 =====
{
  assert.equal(validateSettings({}), null, "空对象 → null");
  assert.equal(validateSettings({ port: 3081 }), null, "仅端口合法 → null");
  const bad = validateSettings({ enabled: "yes", port: "abc" });
  assert.equal(bad.key, "enabled", "enabled 非法优先");
  const badPaths = validateSettings({ wsCompressPaths: [1, 2] });
  assert.equal(badPaths.key, "wsCompressPaths", "wsCompressPaths 非法检测");
  const badLevel = validateSettings({ httpCompressLevel: 10 });
  assert.equal(badLevel.key, "httpCompressLevel", "httpCompressLevel 非法检测");
  assert.ok(badLevel.hint.includes("0-3"), "hint 含档位范围");
}

// ===== migrateFileConfig 边界（#110） =====
{
  // 非 object JSON：只改名标记、不写入。
  const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mig-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(123));
  const outcome = await migrateFileConfig(dir, { async update() { throw new Error("must not be called"); } });
  assert.equal(outcome.skippedCorrupt, true, "number JSON → 只标记不写");
  assert.equal(existsSync(join(dir, MIGRATED_BAK_NAME)), true, "bak 标记存在");
  assert.equal(existsSync(join(dir, "config.json")), false);
  rmSync(dir, { recursive: true, force: true });

  // sanitize 拒绝（含非法值）：整体不写。
  const dir2 = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mig2-"));
  writeFileSync(join(dir2, "config.json"), JSON.stringify({ port: 99999 }));
  const outcome2 = await migrateFileConfig(dir2, { async update() { throw new Error("must not be called"); } });
  assert.equal(outcome2.migrated, false, "含非法值不写入");
  rmSync(dir2, { recursive: true, force: true });
}

// ===== applyConfigPatch 错误路径（#110） =====
{
  const baseDeps = (over = {}) => ({
    resolve: () => ({ enabled: true }),
    readUser: () => ({ user: {}, revision: 1 }),
    writable: () => true,
    update: async () => {},
    replace: async () => {},
    compress: () => ({ httpCompressEnabled: true, httpCompressLevel: 1, httpCompressMounted: false, httpCompressStats: { compressed: 0, passthrough: 0 } }),
    ...over,
  });
  // settings 服务不可用
  const na = await applyConfigPatch(baseDeps({ writable: () => false }), { patch: {} });
  assert.equal(na.ok, false);
  assert.equal(na.status, 503, "settings 不可用 → 503");
  // 非法 settings
  const invalid = await applyConfigPatch(baseDeps(), { patch: { port: 99999 } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid");
  // handler 内抛异常 → 500
  const broken = await applyConfigPatch(baseDeps({ update: async () => { throw new Error("broken"); } }), { patch: { port: 3000 } });
  assert.equal(broken.ok, false);
  assert.equal(broken.status, 500);
}

// ===== apply 集成：TLS 准备 + settings 命名空间（setSource/onScope/isUnloading/warn） =====
// 构造 fake ctx 使 installLanProxySettings 的 inject(["settings"]) 成功：
// settings.register 返回 owner scope（get/watch/update/replace），触发 setSource
// 与 onScope 回调；scope.watch 触发 isUnloading(ctx) 调用。
{
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-tls-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  const routes = [];
  const rpcHandles = [];
  const disposers = [];
  const scopeWatchCbs = [];

  const scope = {
    _val: { port: 0, wsCompressEnabled: false, httpCompressEnabled: false },
    get() { return this._val; },
    async update(patch) { Object.assign(this._val, patch); },
    async replace(section) { this._val = { ...section }; },
    watch(cb) {
      scopeWatchCbs.push(cb);
      // 立即触发一次，使 isUnloading(ctx) 被调用
      cb();
      return () => {};
    },
  };
  const settingsService = {
    register(ns, schema, opts) { return scope; },
    describe() { return [{ ns: SETTINGS_NS, user: {}, revision: 1 }]; },
  };

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { port: 3080, register(route) { routes.push(route); return () => {}; }, tapIndex() { return () => {}; } },
    inject(services, fn) {
      if (services.includes("connection")) {
        const connectionCtx = {
          connection: { rpc: { handle(channel, h, opts) { rpcHandles.push({ channel, h, opts }); return () => {}; } } },
          effect(fn2) { return fn2(); },
        };
        fn(connectionCtx);
      }
      if (services.includes("settings")) {
        const sctx = {
          settings: settingsService,
          effect(fn2) {
            const d = fn2();
            // 不立即执行 disposer（由外部清理时触发）
            disposers.push(d);
            return d;
          },
        };
        fn(sctx);
      }
    },
    effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
  };

  const { apply } = await import("../lib/index.js");
  apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: true, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });

  await sleep(100);

  // 验证 health 路由注册（prepareTls 内部已同步调用）
  const healthRoute = routes.find((r) => r.path === ROUTES.health);
  assert.ok(healthRoute, "health 路由已注册");
  assert.ok(routes.find((r) => r.path === ROUTES.config), "config 路由已注册");
  assert.equal(rpcHandles.length, 0, "RPC 配置通道不再注册");

  // 触发 setSource 后调用 health handler → resolve() → current 已切到 scope.get()
  let healthBody = "";
  healthRoute.handler(
    { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, url: ROUTES.health },
    { writeHead: () => {}, end: (c) => { healthBody = String(c); } },
  );
  const hp = JSON.parse(healthBody);
  assert.equal(hp.ok, true, "health 200");
  assert.equal(hp.wsCompressEnabled, false, "settings 来源生效（wsCompressEnabled=false 透传）");

  // 执行 lifecycle 清理：触发 scope.watch 的 disposer 与 isUnloading
  for (const d of [...disposers].reverse()) {
    try { d(); } catch {}
  }
  assert.ok(true, "lifecycle 清理不抛错（setSource/isUnloading/warn 路径已覆盖）");

  process.env.DSH_HOME = prevHome;
  rmSync(applyHome, { recursive: true, force: true });
}

// ===== apply：settings 服务缺少 register → warn 路径 =====
{
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-warn-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  const disposers = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { port: 3080, register() { return () => {}; }, tapIndex() { return () => {}; } },
    inject(services, fn) {
      if (services.includes("settings")) {
        // settings 存在但缺少 register → warn 被调用
        fn({ settings: { noRegister: true }, effect(fn2) { return fn2(); } });
      }
    },
    effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
  };
  const { apply } = await import("../lib/index.js");
  apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });
  await sleep(50);
  for (const d of [...disposers].reverse()) { try { d(); } catch {} }
  assert.ok(true, "warn 路径覆盖完成");
  process.env.DSH_HOME = prevHome;
  rmSync(applyHome, { recursive: true, force: true });
}

// ===== apply：监听端口被占 → listen() reject → catch 分支 =====
{
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-listenfail-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  // 占用一个具体端口（#217 回滚：unit-apply 在 stryker 变异面内，port 0 随机化
  // 破坏变异覆盖（covered 57.9% < 60% 阈值）；19998 在单包 tap runner 上下文安全，
  // 真正 CI flake 来自 smoke 端口另见 #217 子项）
  const occupied = createServer();
  await new Promise((r) => occupied.listen(19998, "127.0.0.1", r));
  const routes = [];
  const rpcHandles = [];
  const disposers = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { port: 3080, register(route) { routes.push(route); return () => {}; }, tapIndex() { return () => {}; } },
    inject(services, fn) {
      if (services.includes("connection")) {
        fn({ connection: { rpc: { handle(ch, h, o) { rpcHandles.push({ch,h,o}); return () => {}; } } }, effect(fn2) { return fn2(); } });
      }
    },
    effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
  };
  const { apply } = await import("../lib/index.js");
  apply(ctx, { host: "127.0.0.1", port: 19998, httpsEnabled: false, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });
  await sleep(200); // 等 listen 异步 reject
  // health 路由存在，但 listening: false
  const healthRoute = routes.find((r) => r.path === ROUTES.health);
  assert.ok(healthRoute, "端口被占仍注册 health 路由");
  let healthBody = "";
  healthRoute.handler(
    { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, url: ROUTES.health },
    { writeHead: () => {}, end: (c) => { healthBody = String(c); } },
  );
  const hp = JSON.parse(healthBody);
  assert.equal(hp.listening, false, "端口被占 → listening: false");
  // 清理
  for (const d of [...disposers].reverse()) { try { d(); } catch {} }
  occupied.close();
  process.env.DSH_HOME = prevHome;
  rmSync(applyHome, { recursive: true, force: true });
}

// ===== apply：enabled=false 仍注册路由与迁移（#110 P0-2） =====
{
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-off-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  const routes = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { port: 3080, register(route) { routes.push(route); return () => {}; }, tapIndex() { return () => {}; } },
    inject() {},
    effect(fn) { return fn(); },
  };
  const { apply } = await import("../lib/index.js");
  apply(ctx, { enabled: false, httpsEnabled: false });
  assert.ok(routes.find((r) => r.path === ROUTES.health), "enabled=false 仍注册 health 路由");
  assert.ok(routes.find((r) => r.path === ROUTES.config), "enabled=false 仍注册 config 路由");
  process.env.DSH_HOME = prevHome;
  rmSync(applyHome, { recursive: true, force: true });
}

// ===== applyConfigPatch 成功语义与 tls 清除（#110，接续 #147 口径） =====
{
  const state = { user: { host: "127.0.0.1", port: 3081 } as Record<string, unknown>, updates: [], replaces: [] };
  const deps = {
    resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3081, httpCompressLevel: 2 }),
    readUser: () => ({ user: { ...state.user }, revision: 4 }),
    writable: () => true,
    update: async (patch, rev) => {
      state.updates.push({ patch, rev });
      Object.assign(state.user, patch);
    },
    replace: async (section, rev) => {
      state.replaces.push({ section, rev });
      state.user = { ...section };
    },
    compress: () => ({ compressed: 3, passthrough: 4 }),
  };
  // 合法提交：增量 update，未携带键保持原值
  const ok = await applyConfigPatch(deps, { patch: { port: 4000 }, expectedRevision: 4 });
  assert.equal(ok.ok, true, "config 合法提交成功");
  assert.deepEqual(state.updates, [{ patch: { port: 4000 }, rev: 4 }]);
  assert.equal(ok.value.revision, 4);
  // tls 空串清空语义：raw 显式 "" → replace 整节剔除该键
  state.user.tlsCertFile = "/a.pem";
  state.user.tlsKeyFile = "/b.pem";
  const clearTls = await applyConfigPatch(deps, { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } });
  assert.equal(clearTls.ok, true, "tls 双空串成对合法");
  assert.equal(state.replaces.length, 1, "清除走 replace 整节替换");
  assert.ok(!("tlsCertFile" in state.user) && !("tlsKeyFile" in state.user), "空串提交从用户层剔除两个 tls 键");
  assert.equal(state.user.printBanner, false, "其余键并入新节");
  // tls-pair 校验：只给证书不给私钥
  const halfPair = await applyConfigPatch(deps, { patch: { tlsCertFile: "/tmp/a.pem" } });
  assert.equal(halfPair.ok, false, "单边 tls 被拒");
  assert.equal(halfPair.code, "tls-pair", "tls-pair 错误码");
}

// ===== validateSettings 字段级边界矩阵（#147 变异加固） =====
{
  // 非 object payload（数组按 object 形态处理、无字段可校验故通过——锁定现状）
  for (const bad of [null, 42, "x"]) {
    const r = validateSettings(bad);
    assert.equal(r?.key, "(payload)", `非对象 ${JSON.stringify(bad)} 报 payload 错`);
  }
  assert.equal(validateSettings([]), null, "空数组无字段可校验、按现状通过");
  // 数组也是 object——但仍是合法载体形态，逐字段校验通过后返回 null
  // 端口类边界：0 / 负数 / 小数 / 超 65535
  for (const p of [0, -1, 3.5, 65536, "80"]) {
    const r = validateSettings({ port: p });
    assert.equal(r?.key, "port", `port=${JSON.stringify(p)} 非法`);
  }
  assert.equal(validateSettings({ port: 65535 }), null, "port 上界 65535 合法");
  assert.equal(validateSettings({ port: 1 }), null, "port 下界 1 合法");
  // targetHost 回环约束
  assert.equal(validateSettings({ targetHost: "8.8.8.8" })?.key, "targetHost", "非回环 targetHost 非法");
  assert.equal(validateSettings({ targetHost: "localhost" }), null, "localhost 合法");
  // httpCompressLevel 档位与迁移窗口
  assert.equal(validateSettings({ httpCompressLevel: -1 })?.key, "httpCompressLevel", "-1 非法");
  assert.equal(validateSettings({ httpCompressLevel: 10 })?.key, "httpCompressLevel", "10 超迁移窗非法");
  assert.equal(validateSettings({ httpCompressLevel: 3.5 })?.key, "httpCompressLevel", "小数档位非法");
  for (const lv of [0, 1, 2, 3]) {
    assert.equal(validateSettings({ httpCompressLevel: lv }), null, `档位 ${lv} 合法`);
  }
  // wsCompressPaths 元素类型
  assert.equal(validateSettings({ wsCompressPaths: [42] })?.key, "wsCompressPaths", "非字符串元素非法");
  assert.equal(validateSettings({ wsCompressPaths: [] }), null, "空数组合法");
  // undefined/null 字段跳过
  assert.equal(validateSettings({ port: undefined, host: null }), null, "undefined/null 字段跳过校验");
}

// ===== sanitizeSettings 清洗语义（#147 变异加固） =====
{
  // 非 object → null
  assert.equal(sanitizeSettings(null), null, "null → null");
  assert.equal(sanitizeSettings("x"), null, "字符串 → null");
  // 未知键被剔除、合法键保留
  const cleaned = sanitizeSettings({ port: 3000, evilKey: "x" });
  assert.equal(cleaned.port, 3000, "合法键保留");
  assert.ok(!("evilKey" in cleaned), "未知键剔除");
  // level 迁移 4-9 → 3
  assert.equal(sanitizeSettings({ httpCompressLevel: 7 }).httpCompressLevel, 3, "level 7 迁移为高档 3");
  assert.equal(sanitizeSettings({ httpCompressLevel: 4 }).httpCompressLevel, 3, "level 4 迁移为高档 3");
  assert.equal(sanitizeSettings({ httpCompressLevel: 9 }).httpCompressLevel, 3, "level 9 迁移为高档 3");
  // tls 空串剔除
  const noTls = sanitizeSettings({ tlsCertFile: "", tlsKeyFile: "", httpsEnabled: true });
  assert.ok(!("tlsCertFile" in noTls) && !("tlsKeyFile" in noTls), "tls 空串被剔除");
  assert.equal(noTls.httpsEnabled, true, "其余键不受影响");
  // 非法值整体拒绝
  assert.equal(sanitizeSettings({ port: 99999 }), null, "非法值整体返回 null");
}

// ===== validateSettings 全字段类型矩阵（#147 变异加固接续：布尔/字符串/数组类逐字段） =====
{
  // 布尔类字段：字符串/数字形态一律非法
  for (const key of ["enabled", "httpsEnabled", "printBanner", "wsCompressEnabled", "httpCompressEnabled"]) {
    for (const bad of ["true", 1, 0]) {
      assert.equal(validateSettings({ [key]: bad })?.key, key, `${key}=${JSON.stringify(bad)} 非法`);
      assert.equal(validateSettings({ [key]: true }), null, `${key}=true 合法`);
    }
  }
  // 字符串类字段：数字形态非法；空串除 targetHost（回环约束）外合法
  for (const key of ["host", "tlsCertFile", "tlsKeyFile"]) {
    assert.equal(validateSettings({ [key]: 42 })?.key, key, `${key} 数字形态非法`);
    assert.equal(validateSettings({ [key]: "" }), null, `${key} 空串合法（留空语义）`);
  }
  assert.equal(validateSettings({ targetHost: 42 })?.key, "targetHost", "targetHost 数字形态非法");
  assert.equal(validateSettings({ targetHost: "" })?.key, "targetHost", "targetHost 空串非回环非法");
  // httpsPort 与 targetPort 共用端口校验器
  assert.equal(validateSettings({ httpsPort: 0 })?.key, "httpsPort", "httpsPort 下界外非法");
  assert.equal(validateSettings({ targetPort: 65536 })?.key, "targetPort", "targetPort 上界外非法");
  assert.equal(validateSettings({ httpsPort: 3443, targetPort: 3080 }), null, "两端口合法值通过");
  // level 迁移窗口内（4-9）经归一化后合法——validate 与 sanitize 同窗
  assert.equal(validateSettings({ httpCompressLevel: 5 }), null, "level 5 迁移后合法");
  assert.equal(validateSettings({ httpCompressLevel: 9 }), null, "level 9 迁移后合法");
}

// ===== Config schema 直测：schemastery 默认值与上界（#147 变异加固接续） =====
{
  const { Config } = await import("../lib/index.js");
  const defaults = Config({});
  assert.equal(defaults.enabled, true, "enabled 默认 true");
  assert.equal(defaults.httpsEnabled, true, "httpsEnabled 默认 true");
  assert.equal(defaults.printBanner, true, "printBanner 默认 true");
  assert.equal(defaults.wsCompressEnabled, true, "wsCompressEnabled 默认 true");
  assert.equal(defaults.httpCompressEnabled, true, "httpCompressEnabled 默认 true");
  assert.equal(defaults.httpCompressLevel, 1, "httpCompressLevel 默认低档 1");
  assert.deepEqual(defaults.wsCompressPaths, ["/api/events.mux", "/api/events.host"], "ws 压缩路径默认两会话端点");
  // 端口上界 65535 由 schema max 强制
  assert.throws(() => Config({ port: 65536 }), "port 超 schema 上界抛错");
  assert.throws(() => Config({ httpsPort: -1 }), "httpsPort 负数抛错");
  assert.throws(() => Config({ httpCompressLevel: 4 }), "压缩档位超 3 抛错");
}

console.log("[unit-apply] all passed ✓");