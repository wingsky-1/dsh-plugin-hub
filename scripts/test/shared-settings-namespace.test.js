/**
 * shared/settings-namespace — 版本矩阵测试（双模型 fixture）。
 *
 * 旧 Provider（有 register）/ 新 Forms（无 register、有 describe/update/replace/
 * mutate＋document-updated）下覆盖：注册、读写、热更新、迁移幂等。
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
// 旧 Provider 假件（rc.1 语义）：register 返回 owner scope，watch 手动触发。
function makeProviderFixture({ fiberState = "active", registerImpl } = {}) {
  const state = {
    sourceMode: "unset",
    onChangeCount: 0,
    watchCb: null,
    disposer: null,
    order: [],
    scopeSeen: null,
    serviceSeen: null,
  };
  const scope = {
    get: () => ({ from: "scope" }),
    watch: (cb) => {
      state.watchCb = cb;
      return () => {};
    },
    update: async () => {},
    replace: async () => {},
  };
  const settings = {
    register: registerImpl ?? ((_ns, _schema, _opts) => scope),
  };
  const sctx = {
    settings,
    effect: (fn) => {
      state.disposer = fn();
      return () => {};
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
  return { state, scope, settings, sctx, ctx, warn };
}
// 新 Forms 假件（rc.7 语义）：无 register；describe 按 entry id 定位；写经
// update/replace/mutate；热更新经 document-updated＋volatile 比对。
function makeFormsFixture({ fiberState = "active", initialValue = { v: 1 }, idField = "ns" } = {}) {
  const listeners = new Map();
  let nextListenerId = 0;
  const store = {
    ns: "test-ns",
    descriptor: { [idField]: "test-ns", value: { ...initialValue }, revision: 0 },
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
    // 无 register：能力探测走 Forms 路径的关键。
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
function installProvider(stateCtx, entry = { from: "entry" }, extraHooks = {}) {
  const { ctx } = stateCtx;
  const { state } = stateCtx;
  installSettingsNamespace(ctx, "test-ns", {}, entry, {
    setSource: (fn) => {
      const v = fn();
      state.sourceMode = v && v.from ? v.from : JSON.stringify(v);
      state.order.push("setSource");
    },
    onChange: () => {
      state.onChangeCount += 1;
    },
    ...extraHooks,
  });
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
      if (typeof extraOnScope === "function") extraOnScope(scope, svc);
    },
    ...restHooks,
  });
}
// ---- 旧 Provider 矩阵 ----
describe("矩阵：旧 Provider（有 register）", () => {
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
  it("settings 缺失 register 能力降级 warn（register mock 兼容）", () => {
    const warn = makeWarnCapture();
    const ctx = {
      logger: warn.logger,
      inject: (keys, cb) => {
        if (keys.includes("settings")) cb({});
        return () => {};
      },
    };
    installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
    assert.match(warn.messages.join("\n"), /缺少 register/);
  });
  it("register 抛错 warn 且不中断", () => {
    const f = makeProviderFixture({
      registerImpl: () => {
        throw new Error("duplicate ns");
      },
    });
    installProvider(f);
    assert.match(f.warn.messages.join("\n"), /register 失败/);
    assert.equal(f.state.onChangeCount, 0);
  });
  it("注册：setSource 指向 scope.get，onChange 一次，onScope 先于 setSource", () => {
    const f = makeProviderFixture();
    installSettingsNamespace(
      f.ctx,
      "test-ns",
      {},
      { from: "entry" },
      {
        setSource: (fn) => {
          f.state.sourceMode = fn().from;
          f.state.order.push("setSource");
        },
        onChange: () => {
          f.state.onChangeCount += 1;
        },
        onScope: (scope, svc) => {
          f.state.scopeSeen = scope;
          f.state.serviceSeen = svc;
          f.state.order.push("onScope");
        },
      },
    );
    assert.equal(f.state.sourceMode, "scope");
    assert.equal(f.state.onChangeCount, 1);
    assert.deepEqual(f.state.order, ["onScope", "setSource"]);
    assert.equal(f.state.scopeSeen, f.scope);
    assert.equal(f.state.serviceSeen, f.settings);
  });
  it("热更新：watch 触发 onChange", () => {
    const f = makeProviderFixture();
    installProvider(f);
    assert.equal(f.state.onChangeCount, 1);
    f.state.watchCb();
    assert.equal(f.state.onChangeCount, 2);
  });
  it("卸载回落 entry＋onChange；卸载态短路", () => {
    const f = makeProviderFixture();
    installProvider(f);
    f.state.disposer();
    assert.equal(f.state.sourceMode, "entry");
    assert.equal(f.state.onChangeCount, 2);
    for (const st of ["unloading", "unloaded", "disposed"]) {
      const g = makeProviderFixture({ fiberState: st });
      installProvider(g);
      const before = g.state.onChangeCount;
      g.state.disposer();
      g.state.watchCb();
      assert.equal(g.state.onChangeCount, before, `state=${st} 应短路`);
    }
  });
  it("迁移幂等：重复 update 不自发 onChange（只显式写，不扇出）", async () => {
    let updateCalls = 0;
    const f = makeProviderFixture();
    f.scope.update = async () => {
      updateCalls += 1;
    };
    let scopeSeen = null;
    installSettingsNamespace(
      f.ctx,
      "test-ns",
      {},
      {},
      {
        setSource: () => {},
        onChange: () => {
          f.state.onChangeCount += 1;
        },
        onScope: (scope) => {
          scopeSeen = scope;
        },
      },
    );
    const before = f.state.onChangeCount;
    await scopeSeen.update({ a: 1 });
    await scopeSeen.update({ a: 1 });
    assert.equal(updateCalls, 2);
    assert.equal(f.state.onChangeCount, before, "重复迁移写不应自发 onChange");
  });
});
// ---- 新 Forms 矩阵 ----
describe("矩阵：新 Forms（无 register）", () => {
  it("entry id 定位：ns 字段命中 describe", () => {
    const f = makeFormsFixture({ initialValue: { v: 7 } });
    installForms(f);
    assert.deepEqual(f.state.sourceValue, { v: 7 });
    assert.equal(f.state.onChangeCount, 1);
  });
  it("entry id 定位：id 字段命中 describe（rc.7 形态）", () => {
    const f = makeFormsFixture({ initialValue: { v: 9 }, idField: "id" });
    delete f.store.descriptor.ns;
    installForms(f);
    assert.deepEqual(f.state.sourceValue, { v: 9 });
  });
  it("volatile 投影优先于 value/user", () => {
    const f = makeFormsFixture();
    f.store.descriptor = {
      ns: "test-ns",
      volatile: { v: "volatile" },
      value: { v: "value" },
      user: { v: "user" },
      revision: 0,
    };
    installForms(f);
    assert.deepEqual(f.state.sourceValue, { v: "volatile" });
  });
  it("describe 缺席回落 entry（仍 onScope/setSource/onChange）", () => {
    const f = makeFormsFixture();
    f.store.descriptor = { ns: "other-ns", value: { v: 99 }, revision: 0 };
    const entry = { v: 0 };
    installForms(f, entry);
    assert.deepEqual(f.state.sourceValue, entry);
    assert.equal(f.state.onChangeCount, 1);
    assert.equal(typeof f.state.scopeSeen.get, "function");
    assert.equal(f.state.serviceSeen, f.settings);
  });
  it("onScope 先于 setSource，且 scope 含 update/replace/mutate", () => {
    const f = makeFormsFixture();
    installSettingsNamespace(
      f.ctx,
      "test-ns",
      {},
      { v: 0 },
      {
        setSource: (fn) => {
          f.state.sourceValue = fn();
          f.state.order.push("setSource");
        },
        onChange: () => {
          f.state.onChangeCount += 1;
        },
        onScope: (scope, svc) => {
          f.state.scopeSeen = scope;
          f.state.serviceSeen = svc;
          f.state.order.push("onScope");
        },
      },
    );
    assert.deepEqual(f.state.order, ["onScope", "setSource"]);
    assert.equal(typeof f.state.scopeSeen.get, "function");
    assert.equal(typeof f.state.scopeSeen.watch, "function");
    assert.equal(typeof f.state.scopeSeen.update, "function");
    assert.equal(typeof f.state.scopeSeen.replace, "function");
    assert.equal(typeof f.state.scopeSeen.mutate, "function");
    assert.equal(f.state.serviceSeen, f.settings);
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
  it("热更新：同 ns＋volatile 变化才 onChange；异 ns 与等值忽略", () => {
    const f = makeFormsFixture({ initialValue: { v: 1 } });
    installForms(f);
    assert.equal(f.state.onChangeCount, 1);
    // 异 ns 忽略
    f.emitDocumentUpdated("other-ns", 99);
    assert.equal(f.state.onChangeCount, 1);
    // 同 ns 但 volatile 等值（外部直接重放同值）忽略
    f.emitDocumentUpdated("test-ns", f.store.descriptor.revision);
    assert.equal(f.state.onChangeCount, 1);
    // 同 ns＋值变化 → onChange
    f.store.descriptor = { ...f.store.descriptor, value: { v: 2 }, revision: 1 };
    f.emitDocumentUpdated("test-ns", 1);
    assert.equal(f.state.onChangeCount, 2);
    assert.deepEqual(f.state.scopeSeen.get(), { v: 2 });
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
  it("迁移幂等：同 patch 写两次，第二次 volatile 等值不再 onChange", async () => {
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
    // volatile 比对发现等值 → 不再 onChange（幂等）。
    const countBeforeSecond = f.state.onChangeCount;
    // 手工把 revision 回退以模拟“值未变”：直接重放同值事件。
    f.emitDocumentUpdated("test-ns", f.store.descriptor.revision);
    assert.equal(f.state.onChangeCount, countBeforeSecond);
    // 真值变化仍触发。
    await scope.update({ migrated: true, extra: 1 });
    assert.ok(f.state.onChangeCount > countBeforeSecond);
  });
  it("validate 传入 Forms 也不抛（宿主侧校验）", () => {
    const f = makeFormsFixture();
    assert.doesNotThrow(() => {
      installSettingsNamespace(
        f.ctx,
        "test-ns",
        {},
        { v: 0 },
        {
          setSource: () => {},
          onChange: () => {},
          validate: () => {},
        },
      );
    });
  });
  it("无 register 且无 describe 降级 warn", () => {
    const warn = makeWarnCapture();
    const ctx = {
      logger: warn.logger,
      inject: (keys, cb) => {
        if (keys.includes("settings")) cb({ settings: {}, effect: () => () => {} });
        return () => {};
      },
    };
    assert.doesNotThrow(() => {
      installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
    });
    assert.match(warn.messages.join("\n"), /缺少 register/);
  });
});
