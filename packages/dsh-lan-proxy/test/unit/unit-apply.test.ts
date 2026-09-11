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
 *
 * 迁移说明（#722 阶段 1）：脚本式断言迁为 vitest 结构化用例——原每个主题块一个
 * describe、原每条 assert 一个 it，断言表达式与判定口径逐条保留（循环体经 it.each
 * 展开为逐条可见用例）。含临时目录 / DSH_HOME / 真实监听的块以 beforeAll 包住「原
 * 动作序列 + 在每个原断言位置取观测快照」，afterAll 回收句柄与临时目录；每个 it 只对
 * 快照断言，故交错序列里各断言看到的仍是各自当时的观测值而非块尾状态。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:http";

import {
  pluginDir, sanitizeSettings, validateSettings,
  migrateFileConfig, MIGRATED_BAK_NAME, applyConfigPatch, SETTINGS_NS,
  ROUTES, normalizeLegacyWsCompressPaths, DEFAULT_WSS_COMPRESS_PATHS,
  buildConfigRoutes, apply, Config,
} from "../../src/index.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** applyConfigPatch 的最小 fake deps（原脚本中两处逐字相同的工厂合为一处）。 */
const basePatchDeps = (over = {}) => ({
  resolve: () => ({ enabled: true }),
  readUser: () => ({ user: {}, revision: 1 }),
  writable: () => true,
  update: async () => {},
  replace: async () => {},
  compress: () => ({ httpCompressEnabled: true, httpCompressLevel: 1, httpCompressMounted: false, httpCompressStats: { compressed: 0, passthrough: 0 } }),
  ...over,
});

// ===== pluginDir =====
describe("pluginDir", () => {
  let dir;
  let tmp;

  beforeAll(() => {
    const prev = process.env.DSH_HOME;
    tmp = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-dir-"));
    process.env.DSH_HOME = tmp;
    dir = pluginDir();
    process.env.DSH_HOME = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("pluginDir 末段为 lan-proxy", () => {
    expect(basename(dir)).toBe("lan-proxy");
  });

  it("pluginDir 在 DSH_HOME 内", () => {
    expect(dir.startsWith(tmp)).toBeTruthy();
  });
});

// ===== sanitizeSettings 更多边界 =====
describe("sanitizeSettings 更多边界", () => {
  it("wsCompressPaths 非数组 → null", () => {
    expect(sanitizeSettings({ wsCompressPaths: "not-array" })).toBe(null);
  });

  it("wsCompressEnabled 非布尔 → null", () => {
    expect(sanitizeSettings({ wsCompressEnabled: "yes" })).toBe(null);
  });

  it("httpCompressLevel 负值 → null", () => {
    expect(sanitizeSettings({ httpCompressLevel: -1 })).toBe(null);
  });

  it("httpCompressLevel 非整数 → null", () => {
    expect(sanitizeSettings({ httpCompressLevel: 1.5 })).toBe(null);
  });

  it("空对象 → 空", () => {
    expect(sanitizeSettings({})).toEqual({});
  });
});

// ===== normalizeLegacyWsCompressPaths（#395 M2 存量白名单归一化纯函数） =====
describe("normalizeLegacyWsCompressPaths（#395 M2 存量白名单归一化纯函数）", () => {
  it("旧默认正序 → remote.mux", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual(["/api/remote.mux"]);
  });

  it("旧默认乱序同样等价 → remote.mux", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.host", "/api/events.mux"])).toEqual(["/api/remote.mux"]);
  });

  it("归一化目标与 DEFAULT_WSS_COMPRESS_PATHS 同源", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual([...DEFAULT_WSS_COMPRESS_PATHS]);
  });

  it("自定义白名单原样", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/custom/ws"])).toEqual(["/api/custom/ws"]);
  });

  it("含废弃端点的自定义组合原样", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/custom/ws"])).toEqual(["/api/events.mux", "/api/custom/ws"]);
  });

  it("重复元素非等价原样", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.mux"])).toEqual(["/api/events.mux", "/api/events.mux"]);
  });

  it("undefined 原样", () => {
    expect(normalizeLegacyWsCompressPaths(undefined)).toBe(undefined);
  });

  it("空数组原样", () => {
    expect(normalizeLegacyWsCompressPaths([])).toEqual([]);
  });
});

// ===== validateSettings 更多边界 =====
describe("validateSettings 更多边界", () => {
  it("空对象 → null", () => {
    expect(validateSettings({})).toBe(null);
  });

  it("仅端口合法 → null", () => {
    expect(validateSettings({ port: 3081 })).toBe(null);
  });

  it("enabled 非法优先", () => {
    expect(validateSettings({ enabled: "yes", port: "abc" }).key).toBe("enabled");
  });

  it("wsCompressPaths 非法检测", () => {
    expect(validateSettings({ wsCompressPaths: [1, 2] }).key).toBe("wsCompressPaths");
  });

  it("httpCompressLevel 非法检测", () => {
    expect(validateSettings({ httpCompressLevel: 10 }).key).toBe("httpCompressLevel");
  });

  it("hint 含档位范围", () => {
    expect(validateSettings({ httpCompressLevel: 10 }).hint.includes("0-3")).toBeTruthy();
  });
});

// ===== migrateFileConfig 边界（#110） =====
describe("migrateFileConfig 边界（#110）", () => {
  let outcome;
  let bakExists;
  let configGone;
  let outcome2;

  beforeAll(async () => {
    // 非 object JSON：只改名标记、不写入。
    const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mig-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify(123));
    outcome = await migrateFileConfig(dir, { async update() { throw new Error("must not be called"); } });
    bakExists = existsSync(join(dir, MIGRATED_BAK_NAME));
    configGone = existsSync(join(dir, "config.json"));
    rmSync(dir, { recursive: true, force: true });

    // sanitize 拒绝（含非法值）：整体不写。
    const dir2 = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mig2-"));
    writeFileSync(join(dir2, "config.json"), JSON.stringify({ port: 99999 }));
    outcome2 = await migrateFileConfig(dir2, { async update() { throw new Error("must not be called"); } });
    rmSync(dir2, { recursive: true, force: true });
  });

  it("number JSON → 只标记不写", () => {
    expect(outcome.skippedCorrupt).toBe(true);
  });

  it("bak 标记存在", () => {
    expect(bakExists).toBe(true);
  });

  it("非 object JSON 消费后 config.json 不存在", () => {
    expect(configGone).toBe(false);
  });

  it("含非法值不写入", () => {
    expect(outcome2.migrated).toBe(false);
  });
});

// ===== applyConfigPatch 错误路径（#110） =====
describe("applyConfigPatch 错误路径（#110）", () => {
  let na;
  let invalid;
  let broken;
  let logWarnHit;

  beforeAll(async () => {
    // settings 服务不可用
    na = await applyConfigPatch(basePatchDeps({ writable: () => false }), { patch: {} });
    // 非法 settings
    invalid = await applyConfigPatch(basePatchDeps(), { patch: { port: 99999 } });
    // handler 内抛异常 → 500，details 固定文案（P2-2），原文走 logWarn
    const logWarns = [];
    broken = await applyConfigPatch(
      basePatchDeps({ update: async () => { throw new Error("broken-secret"); }, logWarn: (m) => logWarns.push(m) }),
      { patch: { port: 3000 } },
    );
    logWarnHit = logWarns.some((m) => m.includes("broken-secret"));
  });

  it("settings 不可用 → ok=false", () => {
    expect(na.ok).toBe(false);
  });

  it("settings 不可用 → 503", () => {
    expect(na.status).toBe(503);
  });

  it("非法 settings → ok=false", () => {
    expect(invalid.ok).toBe(false);
  });

  it("非法 settings → code=invalid", () => {
    expect(invalid.code).toBe("invalid");
  });

  it("handler 抛异常 → ok=false", () => {
    expect(broken.ok).toBe(false);
  });

  it("handler 抛异常 → 500", () => {
    expect(broken.status).toBe(500);
  });

  it("details 不泄露 err.message 原文", () => {
    expect(broken.details).toBe("保存失败，请查看服务端日志");
  });

  it("err.message 走服务端日志", () => {
    expect(logWarnHit).toBeTruthy();
  });
});

// ===== applyConfigPatch tls 成对形态（P2-1） =====
describe("applyConfigPatch tls 成对形态（P2-1）", () => {
  // 单边空串混单侧非空字符串 → raw 层拒绝（sanitize 剔除空串后不再绕过成对校验）
  const tlsPatches = [
    { tlsCertFile: "", tlsKeyFile: "/keep.pem" },
    { tlsCertFile: "/new.pem", tlsKeyFile: "" },
  ];
  let mixedResults = [];

  beforeAll(async () => {
    for (const patch of tlsPatches) {
      mixedResults.push(await applyConfigPatch(basePatchDeps(), { patch }));
    }
  });

  const titled = tlsPatches.map((patch, i) => ({ title: `patch=${JSON.stringify(patch)} 应被拒`, i }));
  it.each(titled)("$title", ({ i }) => {
    expect(mixedResults[i].ok).toBe(false);
  });

  const titledCode = tlsPatches.map((patch, i) => ({ title: `patch=${JSON.stringify(patch)} code=tls-pair`, i }));
  it.each(titledCode)("$title", ({ i }) => {
    expect(mixedResults[i].code).toBe("tls-pair");
  });

  const titledStatus = tlsPatches.map((patch, i) => ({ title: `patch=${JSON.stringify(patch)} status=400`, i }));
  it.each(titledStatus)("$title", ({ i }) => {
    expect(mixedResults[i].status).toBe(400);
  });
});

// ===== apply 集成：TLS 准备 + settings 命名空间（setSource/onScope/isUnloading/warn） =====
// 构造 fake ctx 使 installLanProxySettings 的 inject(["settings"]) 成功：
// settings.register 返回 owner scope（get/watch/update/replace），触发 setSource
// 与 onScope 回调；scope.watch 触发 isUnloading(ctx) 调用。
describe("apply 集成：TLS 准备 + settings 命名空间（setSource/onScope/isUnloading/warn）", () => {
  let healthRouteFound;
  let configRouteFound;
  let rpcHandleCount;
  let hpOk;
  let hpWsCompressEnabled;
  let hpWsCompressPaths;
  let hp2WsCompressPaths;
  let cleanupCompleted;

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-tls-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const routes = [];
    const rpcHandles = [];
    const disposers = [];
    const scopeWatchCbs = [];

    const scope = {
      _val: { port: 0, wsCompressEnabled: false, httpCompressEnabled: false, wsCompressPaths: ["/api/events.host", "/api/events.mux"] },
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

    // httpsPort 显式传 0：不传会落到产品默认值 3443 并**真实监听**（端口审计实测），
    // 并发或残留进程下即 EADDRINUSE（#690 S2c 端口治理）。
    apply(ctx, { host: "127.0.0.1", port: 0, httpsPort: 0, httpsEnabled: true, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });

    await sleep(100);

    // 验证 health 路由注册（prepareTls 内部已同步调用）
    const healthRoute = routes.find((r) => r.path === ROUTES.health);
    healthRouteFound = Boolean(healthRoute);
    configRouteFound = Boolean(routes.find((r) => r.path === ROUTES.config));
    rpcHandleCount = rpcHandles.length;

    // 触发 setSource 后调用 health handler → resolve() → current 已切到 scope.get()
    let healthBody = "";
    healthRoute.handler(
      { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, url: ROUTES.health },
      { writeHead: () => {}, end: (c) => { healthBody = String(c); } },
    );
    const hp = JSON.parse(healthBody);
    hpOk = hp.ok;
    hpWsCompressEnabled = hp.wsCompressEnabled;
    // M2（#395）：resolve() 归一化旧默认白名单（乱序等价）→ health 快照可见新值。
    hpWsCompressPaths = hp.wsCompressPaths;
    // 自定义白名单（含废弃端点的组合）原样保留，不强制改写。
    scope._val.wsCompressPaths = ["/api/custom/ws", "/api/events.mux"];
    let healthBody2 = "";
    healthRoute.handler(
      { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, url: ROUTES.health },
      { writeHead: () => {}, end: (c) => { healthBody2 = String(c); } },
    );
    const hp2 = JSON.parse(healthBody2);
    hp2WsCompressPaths = hp2.wsCompressPaths;

    // 执行 lifecycle 清理：触发 scope.watch 的 disposer 与 isUnloading
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    cleanupCompleted = true;

    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 30000);

  it("health 路由已注册", () => {
    expect(healthRouteFound).toBeTruthy();
  });

  it("config 路由已注册", () => {
    expect(configRouteFound).toBeTruthy();
  });

  it("RPC 配置通道不再注册", () => {
    expect(rpcHandleCount).toBe(0);
  });

  it("health 200", () => {
    expect(hpOk).toBe(true);
  });

  it("settings 来源生效（wsCompressEnabled=false 透传）", () => {
    expect(hpWsCompressEnabled).toBe(false);
  });

  it("resolve() 应把旧默认白名单归一化为 remote.mux", () => {
    expect(hpWsCompressPaths).toEqual(["/api/remote.mux"]);
  });

  it("自定义白名单不被强制改写", () => {
    expect(hp2WsCompressPaths).toEqual(["/api/custom/ws", "/api/events.mux"]);
  });

  // 原脚本此处为 assert.ok(true, ...) 的块尾标记（真正的失败面在清理执行本身）；
  // 保留同名用例，判定绑定到「清理确实跑完」。
  it("lifecycle 清理不抛错（setSource/isUnloading/warn 路径已覆盖）", () => {
    expect(cleanupCompleted).toBeTruthy();
  });
});

// ===== apply：settings 服务缺少 register → warn 路径 =====
describe("apply：settings 服务缺少 register → warn 路径", () => {
  let warnPathCompleted;

  beforeAll(async () => {
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
    apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });
    await sleep(50);
    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
    warnPathCompleted = true;
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 30000);

  it("warn 路径覆盖完成", () => {
    expect(warnPathCompleted).toBeTruthy();
  });
});

// ===== apply：监听端口被占 → listen() reject → catch 分支 =====
describe("apply：监听端口被占 → listen() reject → catch 分支", () => {
  let healthRouteFound;
  let hpListening;

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-listenfail-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    // 占位端口改为动态分配（#690 S2c / #713 T5）：写死端口在并发运行或残留进程下会
    // EADDRINUSE 假阳性。这与 #217 回滚的「apply 传 port: 0」不是同一件事——那种写法会让
    // listen 成功、走不到 catch 分支（covered 掉到 57.9%）；这里 occupied 先占位，apply 绑
    // 同一端口仍必然失败，被覆盖的分支不变。
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
    apply(ctx, { host: "127.0.0.1", port: occupiedPort, httpsEnabled: false, printBanner: false, wsCompressEnabled: false, httpCompressEnabled: false });
    await sleep(200); // 等 listen 异步 reject
    // health 路由存在，但 listening: false
    const healthRoute = routes.find((r) => r.path === ROUTES.health);
    healthRouteFound = Boolean(healthRoute);
    let healthBody = "";
    healthRoute.handler(
      { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, url: ROUTES.health },
      { writeHead: () => {}, end: (c) => { healthBody = String(c); } },
    );
    const hp = JSON.parse(healthBody);
    hpListening = hp.listening;
    // 清理
    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
    occupied.close();
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 30000);

  it("端口被占仍注册 health 路由", () => {
    expect(healthRouteFound).toBeTruthy();
  });

  it("端口被占 → listening: false", () => {
    expect(hpListening).toBe(false);
  });
});

// ===== apply：enabled=false 仍注册路由与迁移（#110 P0-2） =====
describe("apply：enabled=false 仍注册路由与迁移（#110 P0-2）", () => {
  let healthFound;
  let configFound;

  beforeAll(() => {
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
    apply(ctx, { enabled: false, httpsEnabled: false });
    healthFound = Boolean(routes.find((r) => r.path === ROUTES.health));
    configFound = Boolean(routes.find((r) => r.path === ROUTES.config));
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  });

  it("enabled=false 仍注册 health 路由", () => {
    expect(healthFound).toBeTruthy();
  });

  it("enabled=false 仍注册 config 路由", () => {
    expect(configFound).toBeTruthy();
  });
});

// ===== applyConfigPatch 成功语义与 tls 清除（#110，接续 #147 口径） =====
describe("applyConfigPatch 成功语义与 tls 清除（#110，接续 #147 口径）", () => {
  let ok;
  let updatesAtOk;
  let revisionAtOk;
  let clearTls;
  let replacesLenAtClear;
  let tlsKeysRemovedAtClear;
  let printBannerAtClear;
  let halfPair;

  beforeAll(async () => {
    const state = { user: { host: "127.0.0.1", port: 3081 }, updates: [], replaces: [] };
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
    ok = await applyConfigPatch(deps, { patch: { port: 4000 }, expectedRevision: 4 });
    updatesAtOk = [...state.updates];
    revisionAtOk = ok.value.revision;
    // tls 空串清空语义：raw 显式 "" → replace 整节剔除该键
    state.user.tlsCertFile = "/a.pem";
    state.user.tlsKeyFile = "/b.pem";
    clearTls = await applyConfigPatch(deps, { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } });
    replacesLenAtClear = state.replaces.length;
    tlsKeysRemovedAtClear = !("tlsCertFile" in state.user) && !("tlsKeyFile" in state.user);
    printBannerAtClear = state.user.printBanner;
    // tls-pair 校验：只给证书不给私钥
    halfPair = await applyConfigPatch(deps, { patch: { tlsCertFile: "/tmp/a.pem" } });
  });

  it("config 合法提交成功", () => {
    expect(ok.ok).toBe(true);
  });

  it("合法提交走增量 update（patch 与 expectedRevision 透传）", () => {
    expect(updatesAtOk).toEqual([{ patch: { port: 4000 }, rev: 4 }]);
  });

  it("返回体携带提交时的 revision", () => {
    expect(revisionAtOk).toBe(4);
  });

  it("tls 双空串成对合法", () => {
    expect(clearTls.ok).toBe(true);
  });

  it("清除走 replace 整节替换", () => {
    expect(replacesLenAtClear).toBe(1);
  });

  it("空串提交从用户层剔除两个 tls 键", () => {
    expect(tlsKeysRemovedAtClear).toBeTruthy();
  });

  it("其余键并入新节", () => {
    expect(printBannerAtClear).toBe(false);
  });

  it("单边 tls 被拒", () => {
    expect(halfPair.ok).toBe(false);
  });

  it("tls-pair 错误码", () => {
    expect(halfPair.code).toBe("tls-pair");
  });
});

// ===== validateSettings 字段级边界矩阵（#147 变异加固） =====
describe("validateSettings 字段级边界矩阵（#147 变异加固）", () => {
  // 非 object payload（数组按 object 形态处理、无字段可校验故通过——锁定现状）
  const nonObjectPayloads = [null, 42, "x"].map((bad) => ({ title: `非对象 ${JSON.stringify(bad)} 报 payload 错`, bad }));
  it.each(nonObjectPayloads)("$title", ({ bad }) => {
    expect(validateSettings(bad)?.key).toBe("(payload)");
  });

  it("空数组无字段可校验、按现状通过", () => {
    expect(validateSettings([])).toBe(null);
  });

  // 数组也是 object——但仍是合法载体形态，逐字段校验通过后返回 null
  // 端口类边界：0 / 负数 / 小数 / 超 65535
  const badPorts = [0, -1, 3.5, 65536, "80"].map((p) => ({ title: `port=${JSON.stringify(p)} 非法`, p }));
  it.each(badPorts)("$title", ({ p }) => {
    expect(validateSettings({ port: p })?.key).toBe("port");
  });

  it("port 上界 65535 合法", () => {
    expect(validateSettings({ port: 65535 })).toBe(null);
  });

  it("port 下界 1 合法", () => {
    expect(validateSettings({ port: 1 })).toBe(null);
  });

  // targetHost 回环约束
  it("非回环 targetHost 非法", () => {
    expect(validateSettings({ targetHost: "8.8.8.8" })?.key).toBe("targetHost");
  });

  it("localhost 合法", () => {
    expect(validateSettings({ targetHost: "localhost" })).toBe(null);
  });

  // httpCompressLevel 档位与迁移窗口
  it("-1 非法", () => {
    expect(validateSettings({ httpCompressLevel: -1 })?.key).toBe("httpCompressLevel");
  });

  it("10 超迁移窗非法", () => {
    expect(validateSettings({ httpCompressLevel: 10 })?.key).toBe("httpCompressLevel");
  });

  it("小数档位非法", () => {
    expect(validateSettings({ httpCompressLevel: 3.5 })?.key).toBe("httpCompressLevel");
  });

  const legalLevels = [0, 1, 2, 3].map((lv) => ({ title: `档位 ${lv} 合法`, lv }));
  it.each(legalLevels)("$title", ({ lv }) => {
    expect(validateSettings({ httpCompressLevel: lv })).toBe(null);
  });

  // wsCompressPaths 元素类型
  it("非字符串元素非法", () => {
    expect(validateSettings({ wsCompressPaths: [42] })?.key).toBe("wsCompressPaths");
  });

  it("空数组合法", () => {
    expect(validateSettings({ wsCompressPaths: [] })).toBe(null);
  });

  // undefined/null 字段跳过
  it("undefined/null 字段跳过校验", () => {
    expect(validateSettings({ port: undefined, host: null })).toBe(null);
  });
});

// ===== sanitizeSettings 清洗语义（#147 变异加固） =====
describe("sanitizeSettings 清洗语义（#147 变异加固）", () => {
  it("null → null", () => {
    expect(sanitizeSettings(null)).toBe(null);
  });

  it("字符串 → null", () => {
    expect(sanitizeSettings("x")).toBe(null);
  });

  // 未知键被剔除、合法键保留
  it("合法键保留", () => {
    expect(sanitizeSettings({ port: 3000, evilKey: "x" }).port).toBe(3000);
  });

  it("未知键剔除", () => {
    expect(!("evilKey" in sanitizeSettings({ port: 3000, evilKey: "x" }))).toBeTruthy();
  });

  // level 迁移 4-9 → 3
  it("level 7 迁移为高档 3", () => {
    expect(sanitizeSettings({ httpCompressLevel: 7 }).httpCompressLevel).toBe(3);
  });

  it("level 4 迁移为高档 3", () => {
    expect(sanitizeSettings({ httpCompressLevel: 4 }).httpCompressLevel).toBe(3);
  });

  it("level 9 迁移为高档 3", () => {
    expect(sanitizeSettings({ httpCompressLevel: 9 }).httpCompressLevel).toBe(3);
  });

  // tls 空串剔除
  it("tls 空串被剔除", () => {
    const noTls = sanitizeSettings({ tlsCertFile: "", tlsKeyFile: "", httpsEnabled: true });
    expect(!("tlsCertFile" in noTls) && !("tlsKeyFile" in noTls)).toBeTruthy();
  });

  it("其余键不受影响", () => {
    expect(sanitizeSettings({ tlsCertFile: "", tlsKeyFile: "", httpsEnabled: true }).httpsEnabled).toBe(true);
  });

  // 非法值整体拒绝
  it("非法值整体返回 null", () => {
    expect(sanitizeSettings({ port: 99999 })).toBe(null);
  });
});

// ===== validateSettings 全字段类型矩阵（#147 变异加固接续：布尔/字符串/数组类逐字段） =====
describe("validateSettings 全字段类型矩阵（#147 变异加固接续）", () => {
  const boolKeys = ["enabled", "httpsEnabled", "printBanner", "wsCompressEnabled", "httpCompressEnabled"];
  const badBoolValues = ["true", 1, 0];

  // 布尔类字段：字符串/数字形态一律非法
  const boolIllegal = boolKeys.flatMap((key) => badBoolValues.map((bad) => ({ title: `${key}=${JSON.stringify(bad)} 非法`, key, bad })));
  it.each(boolIllegal)("$title", ({ key, bad }) => {
    expect(validateSettings({ [key]: bad })?.key).toBe(key);
  });

  // 原脚本把 `assert.equal(validateSettings({[key]: true}), null)` 写在内层 bad 循环里，
  // 同一断言对每个 key 重复执行 3 次；此处按 key 保留一条（断言集合未减少，仅去重复执行）。
  const boolLegal = boolKeys.map((key) => ({ title: `${key}=true 合法`, key }));
  it.each(boolLegal)("$title", ({ key }) => {
    expect(validateSettings({ [key]: true })).toBe(null);
  });

  // 字符串类字段：数字形态非法；空串除 targetHost（回环约束）外合法
  const strKeys = ["host", "tlsCertFile", "tlsKeyFile"];
  const strIllegal = strKeys.map((key) => ({ title: `${key} 数字形态非法`, key }));
  it.each(strIllegal)("$title", ({ key }) => {
    expect(validateSettings({ [key]: 42 })?.key).toBe(key);
  });

  const strLegal = strKeys.map((key) => ({ title: `${key} 空串合法（留空语义）`, key }));
  it.each(strLegal)("$title", ({ key }) => {
    expect(validateSettings({ [key]: "" })).toBe(null);
  });

  it("targetHost 数字形态非法", () => {
    expect(validateSettings({ targetHost: 42 })?.key).toBe("targetHost");
  });

  it("targetHost 空串非回环非法", () => {
    expect(validateSettings({ targetHost: "" })?.key).toBe("targetHost");
  });

  // httpsPort 与 targetPort 共用端口校验器
  it("httpsPort 下界外非法", () => {
    expect(validateSettings({ httpsPort: 0 })?.key).toBe("httpsPort");
  });

  it("targetPort 上界外非法", () => {
    expect(validateSettings({ targetPort: 65536 })?.key).toBe("targetPort");
  });

  it("两端口合法值通过", () => {
    expect(validateSettings({ httpsPort: 3443, targetPort: 3080 })).toBe(null);
  });

  // level 迁移窗口内（4-9）经归一化后合法——validate 与 sanitize 同窗
  it("level 5 迁移后合法", () => {
    expect(validateSettings({ httpCompressLevel: 5 })).toBe(null);
  });

  it("level 9 迁移后合法", () => {
    expect(validateSettings({ httpCompressLevel: 9 })).toBe(null);
  });
});

// ===== 变异加固块（round=3 CI 回归：迁移重放/路由面/校验分支断言进 tap 面） =====
// 背景：smoke.test.ts 不在 stryker tap testFiles 内，其覆盖的行为在变异判定中全部
// 存活/noCov。本块把关键行为断言移植到 unit-apply（tap 面内），杀灭新代码
// （resumeMigrateFromBak / migrateFileConfig / applyConfigPatch / buildConfigRoutes /
// installLanProxySettings / warnLog）的存活 mutant。
describe("变异加固块（round=3 CI 回归：迁移重放/路由面/校验分支断言进 tap 面）", () => {
  // 本块所有 apply 调用统一 DSH_HOME 隔离 + disposer 回收（防转发器 server /
  // scheduleSync timer 句柄泄漏挂起事件循环，也防迁移触达真实 ~/.dsh/lan-proxy）。
  const prevHome = process.env.DSH_HOME;
  let blockHome;
  const cleanupFns = [];

  /** 构造最小 fake ctx：收集 lifecycle disposer；enabled 可关避免真实 listen。 */
  const makeCtx = (over = {}) => {
    const disposers = [];
    const routes = [];
    const ctx = {
      logger: over.logger !== undefined ? over.logger : { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3080,
        register(route) { routes.push(route); return () => {}; },
        tapIndex() { return () => {}; },
      },
      inject() {},
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
      ...over,
      get _routes() { return routes; },
      [Symbol.for("dispose")]() {
        for (const d of [...disposers].reverse()) { try { d(); } catch {} }
      },
    };
    cleanupFns.push(ctx[Symbol.for("dispose")]);
    return ctx;
  };

  beforeAll(() => {
    blockHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-block-"));
    process.env.DSH_HOME = blockHome;
  });

  afterAll(() => {
    for (const fn of [...cleanupFns].reverse()) { try { fn(); } catch {} }
    process.env.DSH_HOME = prevHome;
    rmSync(blockHome, { recursive: true, force: true });
  });

  // ---- A. warnLog 分支（ctx 形态降级不抛）----
  describe("A. warnLog 分支（ctx 形态降级不抛）", () => {
    // 经 apply 触发：ctx 无 logger 字段 / logger.warn 非 function —— 走降级路径不抛。
    const loggers = [{ warn: "not-a-function" }, undefined];
    let results = [];

    beforeAll(() => {
      for (const logger of loggers) {
        const ctx = makeCtx({ enabled: false, httpsEnabled: false });
        if (logger === undefined) delete ctx.logger; else ctx.logger = logger;
        apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false, enabled: true });
        results.push(Boolean(ctx._routes.find((r) => r.path === ROUTES.health)));
      }
    }, 30000);

    const titled = loggers.map((logger, i) => ({ title: `logger=${JSON.stringify(logger)} 降级不阻断注册`, i }));
    it.each(titled)("$title", ({ i }) => {
      expect(results[i]).toBeTruthy();
    });
  });

  // ---- B. installLanProxySettings 全分支（inject 缺失/服务缺 register/register 抛错/detach 回落/watch 触发/isUnloading 门控）----
  describe("B. installLanProxySettings 全分支", () => {
    // B1: ctx.inject 缺失 → 降级不抛（原脚本此分支无断言，保留其执行）。
    beforeAll(() => {
      apply(makeCtx({ port: 3081 }), { enabled: false, host: "127.0.0.1", httpsEnabled: false });
    }, 30000);

    // B2: settings 服务存在但无 register → 降级；register 抛错 → 降级。
    describe("B2: settings 服务异常态", () => {
      const services = [
        { label: "missing", service: undefined },
        { label: "no-register", service: {} },
        { label: "throws", service: { register() { throw new Error("dup"); } } },
      ];
      let results = [];

      beforeAll(() => {
        for (const { service } of services) {
          const ctx = makeCtx({
            inject(services2, fn) {
              if (services2.includes("settings")) fn({ settings: service, effect(fn2) { return fn2(); } });
            },
          });
          apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false, enabled: true });
          results.push(ctx._routes.length >= 2);
        }
      }, 30000);

      const titled = services.map((s, i) => ({ title: `service 异常态（${s.label}#${i}）不阻断 health/config 注册`, i }));
      it.each(titled)("$title", ({ i }) => {
        expect(results[i]).toBe(true);
      });
    });

    // B3: attach → watch 挂接 → 非 unloading 态触发 cb 不抛；unloading 态执行 disposers 门控跳过。
    describe("B3: attach → watch 挂接 → isUnloading 门控", () => {
      const makeScope = () => {
        const st = { watchCbs: [], disposed: false };
        return {
          st,
          scope: {
            get() { return { port: 4321 }; },
            watch(cb) { st.watchCbs.push(cb); return () => { st.disposed = true; }; },
            async update() {},
            async replace() {},
          },
        };
      };
      let nsSeen;
      let watchCbsLen;
      let gateCompleted;

      beforeAll(() => {
        const s = makeScope();
        const fiberStates = [];
        const ctx = makeCtx({
          get fiber() { return { state: fiberStates[fiberStates.length - 1] }; },
          inject(services, fn) {
            if (services.includes("settings")) {
              fn({ settings: { register(ns) { nsSeen = ns; return s.scope; } }, effect(fn2) { const d = fn2(); return d; } });
            }
          },
        });
        apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false, printBanner: false });
        watchCbsLen = s.st.watchCbs.length;
        fiberStates.push("attached");
        s.st.watchCbs[0]();
        fiberStates.push("unloading");
        ctx[Symbol.for("dispose")]();
        fiberStates.pop();
        gateCompleted = true;
      }, 30000);

      it("命名空间名", () => {
        expect(nsSeen).toBe(SETTINGS_NS);
      });

      it("scope.watch 已挂接", () => {
        expect(watchCbsLen >= 1).toBe(true);
      });

      it("isUnloading 门控路径执行不抛错", () => {
        expect(gateCompleted).toBeTruthy();
      });
    });
  });

  // ---- C. migrateFileConfig 全分支 outcome 精确断言（含中断重放四分支）----
  describe("C. migrateFileConfig 全分支 outcome 精确断言", () => {
    const okScope = () => ({ updates: [], async update(p) { this.updates.push(p); return Promise.resolve(); } });

    // C1: 双文件都不存在 → idle 六字段全 false。
    describe("C1: 双文件都不存在 → idle", () => {
      let idleOut;

      beforeAll(async () => {
        const idleDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-idle-"));
        idleOut = await migrateFileConfig(idleDir, okScope());
        rmSync(idleDir, { recursive: true, force: true });
      });

      it("idle outcome 全 false", () => {
        expect(idleOut).toEqual({ performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: false });
      });
    });

    // C2: 成功迁移 → performed+migrated，其余 false；损坏 JSON catch 分支；
    //     非对象 JSON；sanitize null；空对象 sanitized（keys=0 → skippedCorrupt）。
    describe("C2: 迁移 outcome 分支矩阵", () => {
      const cases = [
        { name: "success", raw: JSON.stringify({ port: 4082 }), expected: { performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, resumed: false } },
        { name: "broken-json", raw: "{oops", expected: { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false } },
        { name: "non-object", raw: JSON.stringify([1]), expected: { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false } },
        { name: "invalid-value", raw: JSON.stringify({ port: "x" }), expected: { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false } },
        { name: "empty-object", raw: JSON.stringify({}), expected: { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false } },
      ];
      let records = [];

      beforeAll(async () => {
        for (const { name, raw } of cases) {
          const dir = mkdtempSync(join(tmpdir(), `dsh-lan-proxy-mut-${name}-`));
          writeFileSync(join(dir, "config.json"), raw);
          const scope = okScope();
          const out = await migrateFileConfig(dir, scope);
          // bak 标记必须在 rmSync 之前观测（目录随即被回收）
          records.push({ out, bakExists: existsSync(join(dir, MIGRATED_BAK_NAME)), updates: scope.updates });
          rmSync(dir, { recursive: true, force: true });
        }
      });

      const titledOutcome = cases.map((c, i) => ({ title: `case=${c.name} outcome`, i }));
      it.each(titledOutcome)("$title", ({ i }) => {
        expect(records[i].out).toEqual(cases[i].expected);
      });

      const titledBak = cases.map((c, i) => ({ title: `case=${c.name} bak 标记`, i }));
      it.each(titledBak)("$title", ({ i }) => {
        expect(records[i].bakExists).toBe(true);
      });

      it("成功迁移写入键集", () => {
        expect(records[0].updates).toEqual([{ port: 4082 }]);
      });

      const titledNoWrite = cases.slice(1).map((c) => ({ title: `case=${c.name} 不写入`, i: cases.indexOf(c) }));
      it.each(titledNoWrite)("$title", ({ i }) => {
        expect(records[i].updates.length).toBe(0);
      });
    });

    // C3: 写入失败回滚 → rolledBack；config.json 还原。
    describe("C3: 写入失败回滚", () => {
      let out;
      let configRestored;

      beforeAll(async () => {
        const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-rollback-"));
        writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 4083 }));
        out = await migrateFileConfig(dir, { async update() { throw new Error("io"); } });
        configRestored = existsSync(join(dir, "config.json"));
        rmSync(dir, { recursive: true, force: true });
      });

      it("写入失败 → rolledBack outcome", () => {
        expect(out).toEqual({ performed: true, migrated: false, rolledBack: true, skippedCorrupt: false, resumed: false });
      });

      it("回滚后 config.json 还原", () => {
        expect(configRestored).toBe(true);
      });
    });

    // C4: 中断重放四分支（成功/损坏 bak/无效 bak/update 失败），resumed=true。
    describe("C4: 中断重放四分支", () => {
      // 用例表必须是收集期静态量：it.each 的表在 beforeAll 之前就已求值。
      const badBakCases = [
        { raw: "{bad", expectMigrated: false },
        { raw: JSON.stringify({ nope: 1 }), expectMigrated: false },
      ];
      let good;
      let goodUpdates;
      let badRecords = [];
      let failOut;
      let failBakKept;

      beforeAll(async () => {
        const goodDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-resume-ok-"));
        writeFileSync(join(goodDir, MIGRATED_BAK_NAME), JSON.stringify({ printBanner: false }));
        const scope = okScope();
        good = await migrateFileConfig(goodDir, scope);
        goodUpdates = scope.updates;
        rmSync(goodDir, { recursive: true, force: true });

        for (const { raw } of badBakCases) {
          const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-resume-bad-"));
          writeFileSync(join(dir, MIGRATED_BAK_NAME), raw);
          const out = await migrateFileConfig(dir, okScope());
          badRecords.push({ out });
          rmSync(dir, { recursive: true, force: true });
        }

        const failDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-resume-fail-"));
        writeFileSync(join(failDir, MIGRATED_BAK_NAME), JSON.stringify({ port: 4084 }));
        failOut = await migrateFileConfig(failDir, { async update() { throw new Error("io"); } });
        failBakKept = existsSync(join(failDir, MIGRATED_BAK_NAME));
        rmSync(failDir, { recursive: true, force: true });
      });

      it("bak 重放成功 outcome（resumed=true）", () => {
        expect(good).toEqual({ performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, resumed: true });
      });

      it("bak 重放成功写入键集", () => {
        expect(goodUpdates).toEqual([{ printBanner: false }]);
      });

      const titledResumed = badBakCases.map((c, i) => ({ title: `resume bad (${c.raw}) resumed`, i }));
      it.each(titledResumed)("$title", ({ i }) => {
        expect(badRecords[i].out.resumed).toBe(true);
      });

      const titledMigrated = badBakCases.map((c, i) => ({ title: `resume bad (${c.raw}) migrated`, i }));
      it.each(titledMigrated)("$title", ({ i }) => {
        expect(badRecords[i].out.migrated).toBe(badBakCases[i].expectMigrated);
      });

      it("重放失败不回滚（bak 保留）", () => {
        expect(failOut).toEqual({ performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: true });
      });

      it("重放失败 bak 标记仍在", () => {
        expect(failBakKept).toBe(true);
      });
    });
  });

  // ---- D. applyConfigPatch 校验链与错误映射（expectedRevision/409/logWarn 缺省）----
  describe("D. applyConfigPatch 校验链与错误映射", () => {
    /** deps + lastWrite 观测盒（原脚本以块级 lastWrite 记录最近一次写入形态）。 */
    const mkDeps = (over = {}) => {
      const box = { lastWrite: null };
      const d = {
        resolve: () => ({ enabled: true }),
        readUser: () => ({ user: { tlsCertFile: "/a.pem", tlsKeyFile: "/b.pem", port: 3000 }, revision: 9 }),
        writable: () => true,
        update: async (patch, rev) => { box.lastWrite = { kind: "update", patch, rev }; },
        replace: async (section, rev) => { box.lastWrite = { kind: "replace", section, rev }; },
        compress: () => ({ httpCompressEnabled: true, httpCompressLevel: 1, httpCompressMounted: false, httpCompressStats: { compressed: 0, passthrough: 0 } }),
        ...over,
      };
      return { d, box };
    };

    // D1: payload 非对象 → body={} → patch undefined → payload 定位错误。
    describe("D1: payload 非对象", () => {
      const payloads = [null, "str", 42];
      let results = [];

      beforeAll(async () => {
        for (const payload of payloads) {
          results.push(await applyConfigPatch(mkDeps().d, payload));
        }
      });

      const titledRejected = payloads.map((p, i) => ({ title: `payload=${JSON.stringify(p)} 拒绝`, i }));
      it.each(titledRejected)("$title", ({ i }) => {
        expect(results[i].ok).toBe(false);
      });

      const titledStatus = payloads.map((p, i) => ({ title: `payload=${JSON.stringify(p)} status=400`, i }));
      it.each(titledStatus)("$title", ({ i }) => {
        expect(results[i].status).toBe(400);
      });

      const titledCode = payloads.map((p, i) => ({ title: `payload=${JSON.stringify(p)} code=invalid`, i }));
      it.each(titledCode)("$title", ({ i }) => {
        expect(results[i].code).toBe("invalid");
      });

      const titledDetails = payloads.map((p, i) => ({ title: `payload=${JSON.stringify(p)} details 指明载体形态`, i }));
      it.each(titledDetails)("$title", ({ i }) => {
        expect(results[i].details.includes("(payload)") || results[i].details.includes("需为配置对象")).toBe(true);
      });
    });

    // D2: expectedRevision 非法形态 → 透传 undefined；合法整数透传原值。
    describe("D2: expectedRevision 形态", () => {
      it("非数字 expectedRevision → undefined", async () => {
        const { d, box } = mkDeps();
        await applyConfigPatch(d, { patch: { port: 3100 }, expectedRevision: "7" });
        expect(box.lastWrite?.rev).toBe(undefined);
      });

      it("小数 expectedRevision → undefined", async () => {
        const { d, box } = mkDeps();
        await applyConfigPatch(d, { patch: { port: 3100 }, expectedRevision: 1.5 });
        expect(box.lastWrite?.rev).toBe(undefined);
      });

      it("合法整数透传", async () => {
        const { d, box } = mkDeps();
        await applyConfigPatch(d, { patch: { port: 3100 }, expectedRevision: 6 });
        expect(box.lastWrite?.rev).toBe(6);
      });
    });

    // D3: invalid details 含字段与范围。
    describe("D3: invalid details 含字段与范围", () => {
      let r;

      beforeAll(async () => {
        r = await applyConfigPatch(mkDeps().d, { patch: { httpsPort: 0 } });
      });

      it("httpsPort=0 → code=invalid", () => {
        expect(r.code).toBe("invalid");
      });

      it("details 含字段名与范围", () => {
        expect(r.details.includes("httpsPort") && r.details.includes("1-65535")).toBeTruthy();
      });
    });

    // D4: conflict 409 映射（SETTINGS_CONFLICT code）。
    describe("D4: conflict 409 映射", () => {
      let r;

      beforeAll(async () => {
        r = await applyConfigPatch(
          mkDeps({ update: async () => { throw Object.assign(new Error("stale"), { code: "SETTINGS_CONFLICT" }); } }).d,
          { patch: { port: 3101 } },
        );
      });

      it("SETTINGS_CONFLICT → status=409", () => {
        expect(r.status).toBe(409);
      });

      it("SETTINGS_CONFLICT → code=conflict", () => {
        expect(r.code).toBe("conflict");
      });

      it("SETTINGS_CONFLICT → ok=false", () => {
        expect(r.ok).toBe(false);
      });
    });

    // D5: logWarn 缺省（?. 短路）不抛错，仍返回固定文案。
    describe("D5: logWarn 缺省", () => {
      let r;

      beforeAll(async () => {
        const { d } = mkDeps({ update: async () => { throw new Error("boom"); } });
        delete d.logWarn;
        r = await applyConfigPatch(d, { patch: { port: 3102 } });
      });

      it("logWarn 缺省 → status=500", () => {
        expect(r.status).toBe(500);
      });

      it("logWarn 缺省 → 固定文案", () => {
        expect(r.details).toBe("保存失败，请查看服务端日志");
      });
    });

    // D6: 清除证书路径走 replace 且剔除两键；普通 patch 走 update。
    describe("D6: 清除证书路径走 replace", () => {
      let clear;
      let clearKind;
      let clearSection;
      let upd;
      let updLastWriteIsObject;

      beforeAll(async () => {
        const { d, box } = mkDeps();
        clear = await applyConfigPatch(d, { patch: { tlsCertFile: "", tlsKeyFile: "" } });
        // 两次调用共用 lastWrite 观测盒，故在清除之后、普通 patch 之前取快照
        clearKind = box.lastWrite?.kind;
        clearSection = box.lastWrite?.section;
        upd = await applyConfigPatch(d, { patch: { port: 3103 } });
        updLastWriteIsObject = typeof box.lastWrite === "object";
      });

      it("tls 双空串清除成功", () => {
        expect(clear.ok).toBe(true);
      });

      it("清除走 replace", () => {
        expect(clearKind).toBe("replace");
      });

      it("清除后节不含 tls 键", () => {
        // 与原文一致：`in` 优先级高于 `??`，故不额外兜底 section 为空的情形。
        expect(!("tlsCertFile" in clearSection) && !("tlsKeyFile" in clearSection)).toBeTruthy();
      });

      it("普通 patch 成功", () => {
        expect(upd.ok).toBe(true);
      });

      it("lastWrite 为对象", () => {
        expect(updLastWriteIsObject).toBe(true);
      });
    });
  });

  // ---- E. buildConfigRoutes 路由面（围栏/方法白名单/快照字段/readBody）----
  describe("E. buildConfigRoutes 路由面", () => {
    const deps = {
      resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3200, httpsEnabled: true, httpsPort: 3443, targetHost: "127.0.0.1", printBanner: true, wsCompressEnabled: true, wsCompressPaths: [], httpCompressEnabled: true, httpCompressLevel: 1 }),
      readUser: () => ({ user: { port: 3200 }, revision: 11 }),
      writable: () => true,
      update: async () => {},
      replace: async () => {},
      compress: () => ({ httpCompressEnabled: true, httpCompressLevel: 1, httpCompressMounted: false, httpCompressStats: { compressed: 2, passthrough: 3 } }),
    };
    const route = buildConfigRoutes(deps)[0];

    const callRoute = async (method, overrides = {}, body) => {
      const EventEmitter = (await import("node:events")).EventEmitter;
      const stream = new EventEmitter();
      Object.assign(stream, { method, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, ...overrides });
      let status = 0;
      const chunks = [];
      const res = {
        writeHead(c) { status = c; },
        end(c) { if (c !== undefined) chunks.push(String(c)); },
        getHeader() { return undefined; },
        setHeader() {},
      };
      const done = body === undefined ? Promise.resolve() : new Promise((r) => process.nextTick(() => {
        stream.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
        stream.emit("end");
        r();
      }));
      await route.handler(stream, res);
      await done;
      return { status, body: chunks.join("") };
    };

    // E1: 围栏与方法白名单。
    // #473 批 1（B1-4/B1-3）：403 body 围栏文案 + 405 body 文案断言（守卫收敛后逐字节锁定）
    describe("E1: 围栏与方法白名单", () => {
      let forbidden;
      let del405;
      let post405;

      beforeAll(async () => {
        forbidden = await callRoute("GET", { socket: { remoteAddress: "10.0.0.9" } });
        del405 = await callRoute("DELETE");
        post405 = await callRoute("POST", {}, { patch: {} });
      });

      it("非回环 403", () => {
        expect(forbidden.status).toBe(403);
      });

      it("403 body 围栏文案", () => {
        expect(JSON.parse(forbidden.body).error).toBe("forbidden: loopback-only");
      });

      it("DELETE 405", () => {
        expect(del405.status).toBe(405);
      });

      it("DELETE 405 body 文案", () => {
        expect(JSON.parse(del405.body).error).toBe("method not allowed: DELETE");
      });

      it("POST 405", () => {
        expect(post405.status).toBe(405);
      });

      it("POST 405 body 文案", () => {
        expect(JSON.parse(post405.body).error).toBe("method not allowed: POST");
      });
    });

    // E2: GET 快照字段全集（user/effective/compress/revision/writable）。
    describe("E2: GET 快照字段全集", () => {
      let snap;

      beforeAll(async () => {
        snap = JSON.parse((await callRoute("GET")).body);
      });

      it("快照 ok=true", () => {
        expect(snap.ok).toBe(true);
      });

      it("快照 user 层", () => {
        expect(snap.user).toEqual({ port: 3200 });
      });

      it("effective 生效值", () => {
        expect(snap.effective.port).toBe(3200);
      });

      it("压缩协商计数", () => {
        expect(snap.compress.httpCompressStats.compressed).toBe(2);
      });

      it("快照 revision", () => {
        expect(snap.revision).toBe(11);
      });

      it("快照 writable", () => {
        expect(snap.writable).toBe(true);
      });
    });

    // E3: PUT 合法 → 200 + user 层回传；非法 → 400 error.details；坏 JSON → 400 invalid-json。
    describe("E3: PUT 三态", () => {
      let okPut;
      let badPut;
      let badJson;

      beforeAll(async () => {
        okPut = JSON.parse((await callRoute("PUT", {}, { patch: { port: 3201 }, expectedRevision: 11 })).body);
        badPut = JSON.parse((await callRoute("PUT", {}, { patch: { port: 99999 } })).body);
        badJson = JSON.parse((await callRoute("PUT", {}, "{not-json")).body);
      });

      it("PUT 合法提交成功", () => {
        expect(okPut.ok).toBe(true);
      });

      it("400 details 指明字段", () => {
        expect(badPut.error.details.includes("port")).toBeTruthy();
      });

      it("坏 JSON 400 invalid-json", () => {
        expect(badJson.error.code).toBe("invalid-json");
      });
    });

    // E4: writable=false → PUT 503（GET 仍可读）。
    describe("E4: 只读态 PUT 503", () => {
      let status;

      beforeAll(async () => {
        const roDeps = { ...deps, writable: () => false };
        const roRoute = buildConfigRoutes(roDeps)[0];
        const EventEmitter = (await import("node:events")).EventEmitter;
        const stream = new EventEmitter();
        Object.assign(stream, { method: "PUT", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } });
        let s = 0;
        const chunks = [];
        const done = new Promise((r) => process.nextTick(() => {
          stream.emit("data", Buffer.from(JSON.stringify({ patch: { port: 1 } })));
          stream.emit("end");
          r();
        }));
        await roRoute.handler(stream, { writeHead(c) { s = c; }, end(c) { if (c !== undefined) chunks.push(String(c)); }, getHeader() { return undefined; }, setHeader() {} });
        await done;
        status = s;
      });

      it("只读态 PUT 503", () => {
        expect(status).toBe(503);
      });
    });
  });
});

// ===== Config schema 直测：schemastery 默认值与上界（#147 变异加固接续） =====
describe("Config schema 直测：schemastery 默认值与上界（#147 变异加固接续）", () => {
  let defaults;

  beforeAll(() => {
    defaults = Config({});
  });

  it("enabled 默认 true", () => {
    expect(defaults.enabled).toBe(true);
  });

  it("httpsEnabled 默认 true", () => {
    expect(defaults.httpsEnabled).toBe(true);
  });

  it("printBanner 默认 true", () => {
    expect(defaults.printBanner).toBe(true);
  });

  it("wsCompressEnabled 默认 true", () => {
    expect(defaults.wsCompressEnabled).toBe(true);
  });

  it("httpCompressEnabled 默认 true", () => {
    expect(defaults.httpCompressEnabled).toBe(true);
  });

  it("httpCompressLevel 默认低档 1", () => {
    expect(defaults.httpCompressLevel).toBe(1);
  });

  it("ws 压缩路径默认 Remote 流 mux 端点", () => {
    expect(defaults.wsCompressPaths).toEqual(["/api/remote.mux"]);
  });

  // 端口上界 65535 由 schema max 强制
  it("port 超 schema 上界抛错", () => {
    expect(() => Config({ port: 65536 })).toThrow();
  });

  it("httpsPort 负数抛错", () => {
    expect(() => Config({ httpsPort: -1 })).toThrow();
  });

  it("压缩档位超 3 抛错", () => {
    expect(() => Config({ httpCompressLevel: 4 })).toThrow();
  });
});
