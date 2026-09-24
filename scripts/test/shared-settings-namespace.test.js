/**
 * shared/settings-namespace — Forms 单模型测试。
 *
 * 覆盖：注册、读写、热更新、键序无关比对、卸载回落、迁移幂等。
 * 运行：node --test scripts/test/shared-settings-namespace.test.js（或 pnpm test:scripts；零依赖，仅 Node 内置）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installSettingsNamespace } from "../../shared/settings-namespace.js";
// ---- 通用假件 ----
function makeWarnCapture() {
  const messages = [];
  return {
    messages,
    logger: { warn: (m) => messages.push(String(m)) },
  };
}
// Forms 假件：有 describe/update/replace/mutate；热更新经 document-updated＋快照比对。
function makeFormsFixture({ fiberState = "active", initialValue = { v: 1 } } = {}) {
  const listeners = new Map();
  let nextListenerId = 0;
  const store = {
    ns: "test-ns",
    descriptor: { ns: "test-ns", value: { ...initialValue }, revision: 0 },
  };
  const state = {
    sourceValue: undefined,
    onChangeCount: 0,
    disposer: null,
    order: [],
    scopeSeen: null,
    serviceSeen: null,
    writes: [],
  };
  function emitDocumentUpdated(evNs, revision) {
    for (const cb of [...listeners.values()]) cb(evNs, revision);
  }
  const settings = {
    describe: () => [{ ...store.descriptor }],
    update: async function (ns, patch, expectedRevision) {
      assert.equal(this, settings);
      state.writes.push({ method: "update", ns, patch, expectedRevision });
      store.descriptor = {
        ...store.descriptor,
        value: { ...store.descriptor.value, ...patch },
        revision: store.descriptor.revision + 1,
      };
      emitDocumentUpdated(ns, store.descriptor.revision);
    },
    replace: async function (ns, section, expectedRevision) {
      assert.equal(this, settings);
      state.writes.push({ method: "replace", ns, section, expectedRevision });
      store.descriptor = {
        ...store.descriptor,
        value: { ...section },
        revision: store.descriptor.revision + 1,
      };
      emitDocumentUpdated(ns, store.descriptor.revision);
    },
    mutate: async function (ns, ops, expectedRevision) {
      assert.equal(this, settings);
      state.writes.push({ method: "mutate", ns, ops, expectedRevision });
      const next = { ...store.descriptor.value };
      for (const op of ops) {
        if (op.op === "set") next[op.path[0]] = op.value;
        if (op.op === "unset") delete next[op.path[0]];
      }
      store.descriptor = {
        ...store.descriptor,
        value: next,
        revision: store.descriptor.revision + 1,
      };
      emitDocumentUpdated(ns, store.descriptor.revision);
    },
  };
  const sctx = {
    settings,
    effect: (fn) => {
      state.disposer = fn();
      return () => {};
    },
    on: (event, cb) => {
      assert.equal(event, "settings/document-updated");
      const id = nextListenerId++;
      listeners.set(id, cb);
      return () => listeners.delete(id);
    },
  };
  const warn = makeWarnCapture();
  const ctx = {
    fiber: { state: fiberState },
    logger: warn.logger,
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) cb(sctx);
      return () => {};
    },
  };
  return { state, store, settings, sctx, ctx, warn, emitDocumentUpdated, listeners };
}
function installForms(fixture, entry = { v: 0 }, extraHooks = {}) {
  const { ctx, state } = fixture;
  const { onScope: extraOnScope, ...restHooks } = extraHooks;
  installSettingsNamespace(ctx, "test-ns", {}, entry, {
    setSource: (fn) => {
      state.sourceValue = fn();
      state.order.push("setSource");
    },
    onChange: () => {
      state.onChangeCount += 1;
    },
    onScope: (scope, svc) => {
      state.scopeSeen = scope;
      state.serviceSeen = svc;
      state.order.push("onScope");
      if (typeof extraOnScope === "function") extraOnScope(scope, svc);
    },
    ...restHooks,
  });
}
// ---- Forms 矩阵 ----
describe("settings-namespace Forms", () => {
  it("ctx.inject 不可用降级 warn", () => {
    const warn = makeWarnCapture();
    installSettingsNamespace(
      { logger: warn.logger },
      "test-ns",
      {},
      {},
      { setSource: () => {}, onChange: () => {} },
    );
    assert.match(warn.messages.join("\n"), /ctx\.inject 不可用/);
  });
  it("settings 服务缺席降级 warn（无 describe 即空服务）", () => {
    const warn = makeWarnCapture();
    const ctx = {
      logger: warn.logger,
      inject: (keys, cb) => {
        if (keys.includes("settings")) cb({});
        return () => {};
      },
    };
    let called = false;
    assert.doesNotThrow(() => {
      installSettingsNamespace(
        ctx,
        "test-ns",
        {},
        {},
        {
          setSource: () => {
            called = true;
          },
          onChange: () => {
            called = true;
          },
        },
      );
    });
    assert.match(warn.messages.join("\n"), /服务缺席/);
    assert.equal(called, false);
  });
  it("注册：setSource 指向 scope.get，onChange 一次，onScope 先于 setSource", () => {
    const f = makeFormsFixture({ initialValue: { v: 7 } });
    installForms(f);
    assert.deepEqual(f.state.sourceValue, { v: 7 });
    assert.equal(f.state.onChangeCount, 1);
    assert.deepEqual(f.state.order, ["onScope", "setSource"]);
    assert.equal(typeof f.state.scopeSeen.get, "function");
    assert.equal(typeof f.state.scopeSeen.update, "function");
    assert.equal(typeof f.state.scopeSeen.replace, "function");
    assert.equal(typeof f.state.scopeSeen.mutate, "function");
    assert.equal(f.state.scopeSeen.watch, undefined);
    assert.equal(f.state.serviceSeen, f.settings);
  });
  it("读：异 ns 回落 entry；缺 value 字段回落 entry", () => {
    const f = makeFormsFixture();
    f.store.descriptor = { ns: "other-ns", value: { v: 99 }, revision: 0 };
    const entry = { v: 0 };
    installForms(f, entry);
    assert.deepEqual(f.state.sourceValue, entry);
    assert.equal(f.state.onChangeCount, 1);
    const g = makeFormsFixture();
    g.store.descriptor = { ns: "test-ns", revision: 0 };
    installForms(g, entry);
    assert.deepEqual(g.state.sourceValue, entry);
  });
  it("写委托：update/replace/mutate 以 ns 绑定＋this 保持＋revision 透传", async () => {
    const f = makeFormsFixture();
    installForms(f);
    // update 不带 revision（this 保持由假件内 assert.equal(this, settings) 断言）
    await f.state.scopeSeen.update({ a: 1 });
    assert.equal(f.state.writes[0].method, "update");
    assert.equal(f.state.writes[0].ns, "test-ns");
    assert.deepEqual(f.state.writes[0].patch, { a: 1 });
    assert.equal(f.state.writes[0].expectedRevision, undefined);
    // replace 带 revision；mutate 不带 revision（安装时捕获 scope）
    let scope;
    const g = makeFormsFixture();
    installSettingsNamespace(
      g.ctx,
      "test-ns",
      {},
      { v: 0 },
      {
        setSource: () => {},
        onChange: () => {
          g.state.onChangeCount += 1;
        },
        onScope: (s) => {
          scope = s;
        },
      },
    );
    await scope.replace({ v: 2 }, 3);
    await scope.mutate([{ op: "set", path: ["v"], value: 3 }]);
    const replaceCall = g.state.writes.find((w) => w.method === "replace");
    assert.equal(replaceCall.ns, "test-ns");
    assert.deepEqual(replaceCall.section, { v: 2 });
    assert.equal(replaceCall.expectedRevision, 3);
    const mutateCall = g.state.writes.find((w) => w.method === "mutate");
    assert.equal(mutateCall.ns, "test-ns");
  });
  it("热更新：同 ns＋值变化才 onChange；异 ns 与等值忽略", () => {
    const f = makeFormsFixture({ initialValue: { v: 1 } });
    installForms(f);
    assert.equal(f.state.onChangeCount, 1);
    // 异 ns 忽略
    f.emitDocumentUpdated("other-ns", 99);
    assert.equal(f.state.onChangeCount, 1);
    // 同 ns 但等值（外部直接重放同值）忽略
    f.emitDocumentUpdated("test-ns", f.store.descriptor.revision);
    assert.equal(f.state.onChangeCount, 1);
    // 同 ns＋值变化 → onChange
    f.store.descriptor = { ...f.store.descriptor, value: { v: 2 }, revision: 1 };
    f.emitDocumentUpdated("test-ns", 1);
    assert.equal(f.state.onChangeCount, 2);
    assert.deepEqual(f.state.scopeSeen.get(), { v: 2 });
  });
  it("键序无关：同值异序不触发 onChange", () => {
    const f = makeFormsFixture({ initialValue: { a: 1, b: 2 } });
    installForms(f);
    assert.equal(f.state.onChangeCount, 1);
    f.store.descriptor = { ...f.store.descriptor, value: { b: 2, a: 1 }, revision: 1 };
    f.emitDocumentUpdated("test-ns", 1);
    assert.equal(f.state.onChangeCount, 1);
    assert.deepEqual(f.state.scopeSeen.get(), { b: 2, a: 1 });
  });
  it("卸载回落 entry＋onChange；卸载态短路", () => {
    const f = makeFormsFixture({ initialValue: { v: 5 } });
    installForms(f, { v: 0 });
    f.state.disposer();
    assert.deepEqual(f.state.sourceValue, { v: 0 });
    assert.equal(f.state.onChangeCount, 2);
    for (const st of ["unloading", "unloaded", "disposed"]) {
      const g = makeFormsFixture({ fiberState: st, initialValue: { v: 1 } });
      installForms(g, { v: 0 });
      const before = g.state.onChangeCount;
      g.state.disposer();
      g.store.descriptor = { ...g.store.descriptor, value: { v: 2 }, revision: 1 };
      g.emitDocumentUpdated("test-ns", 1);
      assert.equal(g.state.onChangeCount, before, `state=${st} 应短路`);
    }
  });
  it("迁移幂等：同 patch 写两次，第二次等值不再 onChange", async () => {
    const f = makeFormsFixture({ initialValue: { v: 0 } });
    let scope;
    installSettingsNamespace(
      f.ctx,
      "test-ns",
      {},
      { v: 0 },
      {
        setSource: () => {},
        onChange: () => {
          f.state.onChangeCount += 1;
        },
        onScope: (s) => {
          scope = s;
        },
      },
    );
    assert.equal(f.state.onChangeCount, 1);
    await scope.update({ migrated: true });
    assert.equal(f.state.onChangeCount, 2);
    // 第二次同 patch：store 值不变（merge 同键同值），但 revision 自增会触发事件；
    // 快照比对发现等值 → 不再 onChange（幂等）。
    const countBeforeSecond = f.state.onChangeCount;
    // 手工把 revision 回退以模拟“值未变”：直接重放同值事件。
    f.emitDocumentUpdated("test-ns", f.store.descriptor.revision);
    assert.equal(f.state.onChangeCount, countBeforeSecond);
    // 真值变化仍触发。
    await scope.update({ migrated: true, extra: 1 });
    assert.ok(f.state.onChangeCount > countBeforeSecond);
  });
});
