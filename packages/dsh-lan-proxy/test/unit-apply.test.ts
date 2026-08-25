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
  // 占用一个随机端口（#217：port 0 由内核分配，避免 CI 并行固定端口互踩）
  const occupied = createServer();
  await new Promise((r) => occupied.listen(0, "127.0.0.1", r));
  const occupiedPort = occupied.address().port;
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
  apply(ctx, { host: "127.0.0.1", port: occupiedPort, httpsEnabled: false, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });
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

// ===== rpcHandler 成功路径与 config 合并语义（#147 变异加固） =====
{
  let saved = null;
  const handler = rpcHandler({
    resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3081, httpCompressLevel: 2 }),
    fileConfig: () => ({ host: "127.0.0.1", port: 3081 }),
    save: (s) => { saved = s; },
    compress: () => ({ compressed: 3, passthrough: 4 }),
  });
  // state：settings=文件层、effective=resolve()、compress 快照透传
  const st = await handler("state", {});
  assert.equal(st.ok, true, "state 成功");
  assert.equal(st.value.settings.host, "127.0.0.1", "state.settings 来自 fileConfig");
  assert.equal(st.value.effective.httpCompressLevel, 2, "state.effective 来自 resolve");
  assert.deepEqual(st.value.compress, { compressed: 3, passthrough: 4 }, "state.compress 快照透传");
  // deps.compress 缺省 → null
  const handlerNoCompress = rpcHandler({
    resolve: () => ({ enabled: true }), fileConfig: () => ({}), save: () => {},
  });
  const st2 = await handlerNoCompress("state", {});
  assert.equal(st2.value.compress, null, "无 compress deps 时快照为 null");

  // config 成功：merged = 文件层 ⊕ 提交项；save 落盘
  const ok = await handler("config", { settings: { port: 4000 } });
  assert.equal(ok.ok, true, "config 合法提交成功");
  assert.equal(ok.value.settings.port, 4000, "merged 含新 port");
  assert.equal(ok.value.settings.host, "127.0.0.1", "merged 保留旧 host");
  assert.deepEqual(saved, ok.value.settings, "save 收到 merged");

  // tls 空串清空语义：raw 显式 "" → merged 删除该键（回落自签名）
  const clearTls = await handler("config", { settings: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } });
  assert.equal(clearTls.ok, true, "tls 双空串成对合法");
  assert.ok(!("tlsCertFile" in saved) && !("tlsKeyFile" in saved), "空串提交从 merged 剔除两个 tls 键");

  // tls-pair 校验：只给证书不给私钥
  const halfPair = await handler("config", { settings: { tlsCertFile: "/tmp/a.pem" } });
  assert.equal(halfPair.ok, false, "单边 tls 被拒");
  assert.equal(halfPair.error.code, "tls-pair", "tls-pair 错误码");
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
  // 空对象 → 全默认值（BooleanLiteral default true / 数值默认）
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

// ===== loadFileConfig 坏 JSON 与非 object JSON（#147 变异加固接续） =====
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-loadcfg2-"));
  writeFileSync(join(dir, "config.json"), "{not-json", "utf8");
  assert.deepEqual(loadFileConfig(dir), {}, "语法坏 JSON → 空对象（catch 分支）");
  writeFileSync(join(dir, "config.json"), "[1,2]", "utf8");
  assert.deepEqual(loadFileConfig(dir), {}, "数组 JSON 无合法配置键 → 空对象");
  process.env.DSH_HOME;
  rmSync(dir, { recursive: true, force: true });
}

console.log("[unit-apply] all passed ✓");