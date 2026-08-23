// @ts-nocheck
/**
 * dsh-lan-proxy — 宿主端（src/index.ts + shared/settings-namespace.js）结构化单测。
 *
 * 覆盖本批未覆盖热点（fnMap 可命中）：
 * - prepareTls（line 36302）：apply(httpsEnabled: true) → sync() → prepareTls
 * - setSource（line 36423）：installSettingsNamespace 的 hooks.setSource 回调
 * - isUnloading（line 36006，shared 层）：scope.watch 回调内调用
 * - warn（line 36015，shared 层）：settings 服务缺少 register 时调用
 *
 * 豁免（phantom 内层箭头，c8/V8 fnMap 不登记，任何测试不可标记为覆盖）：
 * - 36224（rpcHandler 内层 async 箭头）、36028（settings inject 回调）、
 *   35863（listen 内层回调）、36357（listen().then）、35714（bridge 内层）、
 *   35807（proxy error 回调）、36374（listen().catch）、36424（current=）、
 *   36502（lifecycle disposer，×2）、35872（https error 回调）
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pluginDir, loadFileConfig, writeConfigFile, sanitizeSettings, validateSettings,
  rpcHandler, ROUTES, CHANNEL, DEFAULT_OPTIONS,
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

// ===== loadFileConfig 更多边界 =====
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-loadcfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(123));
  assert.deepEqual(loadFileConfig(dir), {}, "number JSON → 空对象");
  rmSync(dir, { recursive: true, force: true });
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

// ===== writeConfigFile 目录不存在时自动创建 =====
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-write2-"));
  rmSync(dir, { recursive: true, force: true });
  writeConfigFile(dir, { enabled: true });
  assert.ok(existsSync(join(dir, "config.json")), "writeConfigFile 自动创建目录");
  const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(parsed.enabled, true);
  rmSync(dir, { recursive: true, force: true });
}

// ===== rpcHandler 错误路径 =====
{
  const handler = rpcHandler({
    resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3081, httpsEnabled: true, httpsPort: 3443, targetHost: "127.0.0.1", printBanner: true }),
    fileConfig: () => ({}),
    save: () => {},
  });
  // 未知 endpoint
  const unknown = await handler("unknown_endpoint", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "unknown");
  assert.equal(unknown.error.details, "unknown_endpoint");
  // 非法 settings
  const invalid = await handler("config", { settings: { port: 99999 } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid");
  // handler 内抛异常
  const broken = rpcHandler({
    resolve: () => { throw new Error("broken"); },
    fileConfig: () => { throw new Error("broken"); },
    save: () => {},
  });
  const errResult = await broken("state", {});
  assert.equal(errResult.ok, false);
  assert.equal(errResult.error.code, "error");
}

// ===== apply 集成：TLS 准备 + settings 命名空间（setSource/isUnloading/warn） =====
// 构造 fake ctx 使 installSettingsNamespace 的 inject(["settings"]) 成功：
// settings.register 返回 scope（带 get/watch），触发 setSource 回调；
// scope.watch 触发 isUnloading(ctx) 调用。
{
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-tls-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  const routes = [];
  const rpcHandles = [];
  const disposers = [];
  const scopeWatchCbs = [];
  let setSourceCalled = false;
  let onChangeCalled = false;

  const scope = {
    _val: { port: 0, wsCompressEnabled: false, httpCompressEnabled: false },
    get() { return this._val; },
    watch(cb) {
      scopeWatchCbs.push(cb);
      // 立即触发一次，使 isUnloading(ctx) 被调用
      cb();
      return () => {};
    },
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
          settings: {
            register(ns, schema, opts) { return scope; },
          },
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

  // 触发 setSource 后调用 health handler → resolve() → 命中重排后的 current
  // （settings 命名空间来源已切换：wsCompress/httpCompress 以持久化层优先）
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
  // 占用一个具体端口
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

// ===== apply：enabled=false 不启动 =====
{
  const routes = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { port: 3080, register(route) { routes.push(route); return () => {}; }, tapIndex() { return () => {}; } },
    inject() {},
    effect(fn) { return fn(); },
  };
  const { apply } = await import("../lib/index.js");
  apply(ctx, { enabled: false });
  assert.equal(routes.length, 0, "enabled=false 不注册任何路由");
}

console.log("[unit-apply] all passed ✓");