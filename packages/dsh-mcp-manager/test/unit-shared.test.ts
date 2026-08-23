// @ts-nocheck
/**
 * dsh-mcp-manager — unit：installSettingsNamespace 全分支覆盖
 * （isUnloading 为其内部依赖，经 disposer / watch 回调间接覆盖）。
 *
 * 覆盖：
 * - ctx.inject 不可用 → warn 降级
 * - settings 服务缺失 → warn 降级
 * - settings.register 抛错 → warn 降级
 * - 正常注册：setSource / onChange / scope.watch
 * - lifecycle：effect disposer（卸载回落 entry）与 watch 触发 onChange
 * - isUnloading：fiber.state ∈ {unloading, unloaded, disposed} → disposer 短路
 */
import assert from "node:assert/strict";

import { installSettingsNamespace } from "../../../shared/settings-namespace.js";

// ---- ctx.inject 不可用 ----

{
  let warned = "";
  installSettingsNamespace(
    { logger: { warn: (m) => { warned = m; } } },
    "test-ns",
    {},
    {},
    { setSource: () => {}, onChange: () => {} },
  );
  assert.match(warned, /ctx.inject 不可用/, "ctx.inject 不可用应 warn");
}

// logger 缺失不抛（极端降级）。
{
  installSettingsNamespace({}, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
}

// ---- settings 服务缺失 ----

{
  let warned = "";
  const ctx = {
    logger: { warn: (m) => { warned = m; } },
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) cb({});
      return () => {};
    },
  };
  installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
  assert.match(warned, /缺少 register/, "settings 服务缺失应 warn");
}

// ---- settings.register 抛错 ----

{
  let warned = "";
  const ctx = {
    logger: { warn: (m) => { warned = m; } },
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) {
        cb({ settings: { register: () => { throw new Error("duplicate ns"); } }, effect: () => () => {} });
      }
      return () => {};
    },
  };
  installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
  assert.match(warned, /register 失败/, "register 抛错应 warn");
}

// ---- 正常注册 + lifecycle（覆盖 isUnloading 两条路径） ----

{
  let sourceMode = "unset"; // entry | scope
  let onChangeCount = 0;
  let watchCb = null;
  let disposer = null;

  const scope = {
    get: () => ({ from: "scope" }),
    watch: (cb) => { watchCb = cb; },
  };

  // 注入器记录 disposer，便于后续手动触发。
  const ctx = {
    fiber: { state: "active" },
    logger: { warn: () => {} },
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) {
        cb({
          settings: { register: (ns, schema, opts) => scope },
          effect: (fn) => {
            disposer = fn();
            return () => {};
          },
        });
      }
      return () => {};
    },
  };

  installSettingsNamespace(ctx, "test-ns", {}, { from: "entry" }, {
    setSource: (fn) => { sourceMode = fn().from; },
    onChange: () => { onChangeCount += 1; },
  });
  assert.equal(sourceMode, "scope", "注册后 setSource 指向 scope.get()");
  assert.equal(onChangeCount, 1, "注册完成 onChange 触发一次");

  // scope.watch 回调 → onChange（ctx 非卸载）
  assert.ok(watchCb !== null, "scope.watch 已注册");
  ctx.fiber.state = "active";
  watchCb();
  assert.equal(onChangeCount, 2, "watch 变化触发 onChange");

  // disposer：ctx 非卸载 → 回落 entry + onChange
  ctx.fiber.state = "active";
  disposer();
  assert.equal(sourceMode, "entry", "卸载回落 entry");
  assert.equal(onChangeCount, 3, "disposer 触发 onChange");
}

// ---- isUnloading 短路：fiber 处于卸载态时 disposer / watch 不动作 ----

for (const state of ["unloading", "unloaded", "disposed"]) {
  let sourceCalls = 0;
  let onChangeCount = 0;
  let watchCb = null;
  let disposer = null;

  const scope = {
    get: () => ({ from: "scope" }),
    watch: (cb) => { watchCb = cb; },
  };

  const ctx = {
    fiber: { state },
    logger: { warn: () => {} },
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) {
        cb({
          settings: { register: () => scope },
          effect: (fn) => {
            disposer = fn();
            return () => {};
          },
        });
      }
      return () => {};
    },
  };

  installSettingsNamespace(ctx, "test-ns", {}, { from: "entry" }, {
    setSource: () => { sourceCalls += 1; },
    onChange: () => { onChangeCount += 1; },
  });
  const before = onChangeCount;
  disposer();
  watchCb();
  assert.equal(onChangeCount, before, `state=${state} 时 disposer/watch 均短路（不触发 onChange）`);
}

// ---- 总开关：fiber 非对象 / 无 fiber / 无 state 的容错 ----

{
  let watchCb = null;
  let disposer = null;
  const scope = {
    get: () => null,
    watch: (cb) => { watchCb = cb; },
  };
  for (const fiber of [undefined, null, 42, {}]) {
    const ctx = {
      fiber,
      logger: { warn: () => {} },
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: { register: () => scope },
            effect: (fn) => { disposer = fn(); return () => {}; },
          });
        }
        return () => {};
      },
    };
    installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
    if (disposer) disposer();
    if (watchCb) watchCb();
  }
}

console.log("  ok   unit-shared: installSettingsNamespace 全分支（含 isUnloading）");