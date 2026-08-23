// @ts-nocheck
/**
 * dsh-idle-archive — unit：apply 宿主注入路径覆盖（#82 批次 6）。
 *
 * 覆盖（均为 smoke.ts 未到达的 bundle 内路径）：
 * - installSettingsNamespace inject 回调全分支：正常注册 / 缺 register warn /
 *   register 抛错 warn / isUnloading 短路（fiber ∈ {unloading,unloaded,disposed}）/
 *   watch 回调触发
 * - persistSettingsFromStore：settingsStoreRead 缺省 / 无变化 / 有变化写盘
 * - sanitizeSettings 边界值补强
 *
 * 说明：CRAP 工具只扫描 lib bundle，bundle 内 `warn`/`isUnloading` 必须经
 * apply()（bundle 入口）触发；故本文件全部走 apply()，不直测 shared 源文件
 * （shared 模块函数覆盖已由 mcp-manager unit-shared 等批次达成 100%）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { apply, sanitizeSettings, defaultSettings } from "../lib/index.js";

/** 构造 apply() 兼容的 fake ctx（两路 inject：connection + settings）。 */
function makeApplyCtx(opts = {}) {
  const routes = [];
  let watchCb = null;
  let disposer = null;
  const scope = {
    get: () => opts.scopeGet ?? defaultSettings(),
    watch: (cb) => { watchCb = cb; },
  };
  const ctx = {
    logger: { warn: opts.warn ?? (() => {}) },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    fiber: opts.fiber === undefined ? { state: "active" } : opts.fiber,
    inject: (deps, cb) => {
      if (deps.includes("connection")) {
        cb({
          connection: { rpc: { handle: () => () => {} } },
          effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
        });
      }
      if (deps.includes("settings")) {
        if (opts.missingRegister) { cb({ settings: {} }); return; }
        if (opts.registerThrows) {
          cb({ settings: { register: () => { throw new Error(opts.registerThrows); } }, effect: () => () => {} });
          return;
        }
        const sctx = {
          settings: { register: (ns, schema, o) => scope },
          effect: (fn) => {
            disposer = fn();
            return () => {};
          },
        };
        cb(sctx);
      }
    },
    effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
  };
  return { ctx, routes, triggerWatch: () => watchCb?.(), dispose: () => disposer?.() };
}

// ---------------------------------------------------------------- 1) settings 正常注册路径
// 覆盖：inject 回调主体（register/effect/watch 注册）、setSource、onChange

{
  const { ctx } = makeApplyCtx({ scopeGet: { idleHours: 48, snoozeHours: 12, scanMinutes: 30, enabled: true, maxRows: 20 } });
  apply(ctx);
  assert.ok(true, "settings 正常注册不抛错");
}

// ---------------------------------------------------------------- 2) settings 缺 register → bundle warn
// 覆盖：bundle `warn`（settings 服务缺少 register 能力 分支）

{
  const warns = [];
  const { ctx } = makeApplyCtx({ missingRegister: true, warn: (m) => warns.push(m) });
  apply(ctx);
  assert.ok(warns.some((m) => m.includes("缺少 register")), "settings 缺 register 应 warn");
}

// ---------------------------------------------------------------- 3) settings.register 抛错 → bundle warn
// 覆盖：bundle `warn`（settings.register 失败 分支）

{
  const warns = [];
  const { ctx } = makeApplyCtx({ registerThrows: "duplicate ns", warn: (m) => warns.push(m) });
  apply(ctx);
  assert.ok(warns.some((m) => m.includes("register 失败")), "settings.register 抛错应 warn");
}

// ---------------------------------------------------------------- 4) isUnloading 短路：disposer 路径
// fiber ∈ {unloading, unloaded, disposed} → disposer 内 isUnloading true → 提前 return

for (const state of ["unloading", "unloaded", "disposed"]) {
  const { ctx, dispose } = makeApplyCtx({ fiber: { state } });
  apply(ctx);
  dispose();
  assert.ok(true, `fiber.state=${state} disposer 短路不抛错`);
}

// 5) fiber active → disposer 走 setSource 回落 + onChange

{
  const { ctx, dispose } = makeApplyCtx({ fiber: { state: "active" } });
  apply(ctx);
  dispose();
  assert.ok(true, "fiber.active disposer 回落不抛错");
}

// ---------------------------------------------------------------- 6) isUnloading：watch 回调路径
// scope.watch 回调触发：非卸载 → onChange；卸载态 → 短路

{
  const { ctx, triggerWatch } = makeApplyCtx({ fiber: { state: "active" } });
  apply(ctx);
  triggerWatch();
  assert.ok(true, "watch 回调（active）不抛错");
}

{
  const { ctx, triggerWatch } = makeApplyCtx({ fiber: { state: "unloading" } });
  apply(ctx);
  triggerWatch();
  assert.ok(true, "watch 回调（unloading）不抛错");
}

// fiber 容错：undefined / null / 非对象 / 无 state

for (const fiber of [undefined, null, 42, {}]) {
  const { ctx, dispose, triggerWatch } = makeApplyCtx({ fiber });
  apply(ctx);
  dispose();
  triggerWatch();
  assert.ok(true, "fiber 容错不抛错");
}

// ---------------------------------------------------------------- 7) persistSettingsFromStore
// 7a) settingsStoreRead 缺省（inject 不触发 settings）→ 早期 return

{
  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    inject: (deps, cb) => {
      if (deps.includes("connection")) {
        cb({
          connection: { rpc: { handle: () => () => {} } },
          effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
        });
      }
    },
    effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
  };
  apply(ctx);
  assert.ok(true, "settingsStoreRead 缺省不抛错");
}

// 7b) settings 有变化 → 写盘

{
  const home = mkdtempSync(join(tmpdir(), "dia-ps-changed-"));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, dispose } = makeApplyCtx({ scopeGet: { idleHours: 10, snoozeHours: 2, scanMinutes: 15, enabled: false, maxRows: 5 } });
    apply(ctx);
    dispose(); // disposer → onChange → persistSettingsFromStore 写盘
    assert.ok(true, "settings 有变化写盘不抛错");
  } finally {
    rmSync(home, { recursive: true, force: true });
    process.env.DSH_HOME = saved;
  }
}

// 7c) settings 无变化 → JSON 相等比较后 return

{
  const home = mkdtempSync(join(tmpdir(), "dia-ps-unchanged-"));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, dispose } = makeApplyCtx({ scopeGet: { ...defaultSettings() } });
    apply(ctx);
    dispose();
    assert.ok(true, "settings 无变化不抛错");
  } finally {
    rmSync(home, { recursive: true, force: true });
    process.env.DSH_HOME = saved;
  }
}

// ---------------------------------------------------------------- 8) sanitizeSettings 边界补强

assert.equal(sanitizeSettings({ enabled: "yes" }).enabled, true, "enabled 非 boolean 保持默认");
assert.equal(sanitizeSettings({ idleHours: 0 }).idleHours, 1, "idleHours=0 钳制到 1");
assert.equal(sanitizeSettings({ idleHours: 99999 }).idleHours, 24 * 365, "idleHours 极大值钳制上限");
assert.equal(sanitizeSettings({ idleHours: 12.7 }).idleHours, 13, "idleHours=12.7 四舍五入");
assert.equal(sanitizeSettings({ idleHours: -5 }).idleHours, 1, "idleHours=-5 钳制到 1");
assert.equal(sanitizeSettings({ idleHours: NaN }).idleHours, 72, "idleHours=NaN 忽略");
assert.equal(sanitizeSettings({ idleHours: Infinity }).idleHours, 72, "idleHours=Infinity 忽略");
{
  const s = sanitizeSettings({ idleHours: 10, unknownKey: "hello" });
  assert.equal(s.idleHours, 10, "已知键可修改");
  assert.equal("unknownKey" in s, false, "未知键忽略");
}
assert.deepEqual(sanitizeSettings({}), defaultSettings(), "空对象 = 默认");

console.log("PASS: dsh-idle-archive unit-apply（settings 命名空间 / isUnloading / warn / persistSettingsFromStore / sanitizeSettings 边界）");