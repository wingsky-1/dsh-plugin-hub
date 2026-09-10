// @ts-nocheck
/**
 * dsh-notifier — L2 interface 契约：ConfigPort 降级语义 + 路由错误映射直测
 * （N-16 / D19/L8-5 / L8-6；PR2 T2-4）。
 *
 * N-16（requirements §7.3）：ConfigPort 契约经 settings-bridge 实现面直测——
 * 未 attach 降级（readUser→{user:{},revision:undefined}、writable→false、
 * update/confirmKind→reject SETTINGS_UNAVAILABLE）；resolve 是 getCurrent 别名；
 * confirmKind CAS 重试 ≤2（SETTINGS_CONFLICT 回读重试、耗尽 reject，行为复用
 * 现状 confirmKindToConfig 实现）。
 * D19/L8-5：applyConfigPatch 纯函数直测（deps fake）——expectedRevision 非
 * 「非负整数或省略」→ 400 显式拒；省略/null → undefined 透传。
 * L8-6：buildRoutes fake deps 直测 handler——history.clear() 抛错 → 500 固定
 * 文案（不再恒 200）；成功仍 200 {ok:true, removed}。
 *
 * 标准红测判别：ConfigPort 类型 / 400 分支 / 500 分支落地前，本文件对应断言红
 * （改前红），T2-4 落地后全绿（改后绿）。按 §11.2-1 直测 src 域 interface.ts。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfigPatch, buildRoutes, ROUTES } from "../src/server/interface.ts";
import { createSettingsBridge } from "../src/config/interface.ts";
import { fakeReq, makeFakeCtx, makeFakeSettings, makeRes } from "./helpers.ts";

const work = mkdtempSync(join(tmpdir(), "dnotify-unit-config-port-"));
try {
  // ── N-16a：ConfigPort 降级语义（未 attach settings）──
  {
    const { ctx } = makeFakeCtx({}); // 未 provide settings
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "a.json") });
    assert.deepEqual(bridge.readUser(), { user: {}, revision: undefined }, "未 attach readUser 降级 {user:{},revision:undefined}");
    assert.equal(bridge.writable(), false, "未 attach writable=false（降级）");
    for (const call of [
      () => bridge.update({ maxConnections: 8 }),
      () => bridge.confirmKind("ext:alpha", true),
    ]) {
      let rejected = null;
      try {
        await call();
      } catch (err) {
        rejected = err;
      }
      assert.ok(rejected && rejected.code === "SETTINGS_UNAVAILABLE", "未 attach update/confirmKind 直拒 SETTINGS_UNAVAILABLE");
    }
  }

  // ── N-16b：attach 态 ConfigPort 面（resolve 别名 / readUser / writable / update / confirmKind）──
  {
    // fake settings 的 register 忽略 opts.base：attach 后 source 取 makeFakeSettings
    // 的 base（组合层 entry 的等价注入位——routes.test.ts P2-4 同构写法）。
    const fakeSettings = makeFakeSettings({ base: { maxConnections: 42 } });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "b.json") });
    assert.equal(bridge.resolve().maxConnections, 42, "resolve 读取 current（getCurrent 别名）");
    assert.equal(bridge.resolve(), bridge.getCurrent(), "resolve 与 getCurrent 同值同引用（别名语义）");
    assert.equal(bridge.writable(), true, "attach 态 writable=true");
    await bridge.update({ notifyAsk: false });
    assert.equal(fakeSettings.getUser().notifyAsk, false, "update 写 settings user 层");
    await bridge.confirmKind("ext:beta", true);
    assert.ok(fakeSettings.getUser().allowKinds.includes("ext:beta"), "confirmKind 写 allowKinds（CAS 语义）");
    await bridge.confirmKind("ext:beta", false);
    assert.ok(!fakeSettings.getUser().allowKinds.includes("ext:beta"), "confirmKind 撤销从 allowKinds 删除");
  }

  // ── N-16c：confirmKind CAS 冲突重试 ≤2——首次冲突回读重试成功 ──
  {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "c.json") });
    const origUpdate = fakeSettings.service.update;
    let conflictOnce = true;
    let conflictCalls = 0;
    fakeSettings.service.update = async (ns, patch, expectedRevision) => {
      if (conflictOnce) {
        conflictOnce = false;
        conflictCalls += 1;
        throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
      }
      return origUpdate(ns, patch, expectedRevision);
    };
    await bridge.confirmKind("ext:gamma", true);
    assert.equal(conflictCalls, 1, "第一次 update 触发 SETTINGS_CONFLICT");
    assert.ok(bridge.readUser().user.allowKinds.includes("ext:gamma"), "冲突回读重试后确认态落盘");
  }

  // ── N-16d：confirmKind CAS 耗尽（恒冲突）→ 尝试 = 首次 + 重试 ≤2 = 3 次 reject ──
  {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "d.json") });
    let conflictCalls = 0;
    fakeSettings.service.update = async () => {
      conflictCalls += 1;
      throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
    };
    let rejected = null;
    try {
      await bridge.confirmKind("ext:delta", true);
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected && rejected.code === "SETTINGS_CONFLICT", "冲突耗尽后 reject SETTINGS_CONFLICT");
    assert.equal(conflictCalls, 3, "CAS 尝试 = 首次 + 重试 ≤2 = 3 次后放弃");
  }

  // ── D19/L8-5：expectedRevision 非非负整数 → 400（applyConfigPatch 纯函数直测）──
  {
    function makeDeps() {
      const updates = [];
      return {
        updates,
        deps: {
          resolve: () => ({}),
          readUser: () => ({ user: {}, revision: 0 }),
          writable: () => true,
          update(patch, expectedRevision) {
            updates.push({ patch, expectedRevision });
            return Promise.resolve();
          },
          confirmKind: () => Promise.resolve(),
          logger: { warn: () => {}, info: () => {} },
          sse: {},
          system: {},
          history: {},
          sendTest: () => [],
          statusReader: async () => ({}),
          listKinds: () => [],
        },
      };
    }
    // 字符串/小数/负数 → 400 显式拒，且不触发 update
    for (const bad of ["abc", 1.5, -1]) {
      const { deps, updates } = makeDeps();
      const r = await applyConfigPatch(deps, { patch: { notifyAsk: false }, expectedRevision: bad });
      assert.ok(!r.ok && r.status === 400 && r.code === "invalid", `expectedRevision=${JSON.stringify(bad)} → 400 invalid`);
      assert.match(String(r.response.error), /expectedRevision/, "400 指明 expectedRevision 键");
      assert.match(String(r.response.hint), /非负整数/, "400 hint 说明必须为非负整数或省略");
      assert.equal(updates.length, 0, "400 拒绝不触发 update");
    }
    // 省略 / null → undefined 透传，正常保存
    const { deps: depsOmit, updates: updatesOmit } = makeDeps();
    const r1 = await applyConfigPatch(depsOmit, { patch: { notifyAsk: false } });
    assert.ok(r1.ok, "省略 expectedRevision 正常保存");
    assert.equal(updatesOmit[0].expectedRevision, undefined, "省略 → undefined 透传");
    const { deps: depsNull, updates: updatesNull } = makeDeps();
    const r2 = await applyConfigPatch(depsNull, { patch: { notifyAsk: false }, expectedRevision: null });
    assert.ok(r2.ok, "null expectedRevision 同省略（undefined 透传）");
    assert.equal(updatesNull[0].expectedRevision, undefined, "null → undefined 透传");
    // 合法非负整数 → 原样传给 update
    const { deps: depsOk, updates: updatesOk } = makeDeps();
    const r3 = await applyConfigPatch(depsOk, { patch: { notifyAsk: false }, expectedRevision: 7 });
    assert.ok(r3.ok, "合法非负整数正常保存");
    assert.equal(updatesOk[0].expectedRevision, 7, "合法 expectedRevision 原样传给 update");
  }

  // ── L8-6：history DELETE 失败 → 500 固定文案（buildRoutes fake deps 直测 handler）──
  {
    function makeHistoryDeps(clearImpl) {
      const warns = [];
      const deps = {
        resolve: () => ({}),
        readUser: () => ({ user: {}, revision: 0 }),
        writable: () => true,
        update: () => Promise.resolve(),
        confirmKind: () => Promise.resolve(),
        logger: { warn: (m) => warns.push(m), info: () => {} },
        sse: {},
        system: {},
        history: { read: async () => [], clear: clearImpl },
        sendTest: () => [],
        statusReader: async () => ({}),
        listKinds: () => [],
      };
      const routes = buildRoutes(deps);
      return { route: routes.find((r) => r.path === ROUTES.history), warns };
    }
    // 失败路径：500 固定文案，异常原文只进服务端日志
    {
      const { route, warns } = makeHistoryDeps(async () => {
        throw new Error("secret-lib-path /var/boom");
      });
      const { rec, res } = makeRes();
      await route.handler(fakeReq({ method: "DELETE" }), res);
      assert.equal(rec.status, 500, "clear 失败 → 500（不再恒 200）");
      const body = JSON.parse(rec.text);
      assert.equal(body.ok, false);
      assert.match(body.error.error, /历史清空失败/, "500 固定文案「历史清空失败」");
      assert.ok(!rec.text.includes("secret-lib-path"), "异常原文不进响应（P2-2 风格）");
      assert.ok(warns.some((w) => w.includes("secret-lib-path")), "异常原文进服务端日志");
    }
    // 成功路径保持：200 {ok:true, removed}
    {
      const { route } = makeHistoryDeps(async () => 3);
      const { rec, res } = makeRes();
      await route.handler(fakeReq({ method: "DELETE" }), res);
      assert.equal(rec.status, 200, "clear 成功仍 200");
      assert.deepEqual(JSON.parse(rec.text), { ok: true, removed: 3 }, "成功响应 {ok:true, removed}");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}