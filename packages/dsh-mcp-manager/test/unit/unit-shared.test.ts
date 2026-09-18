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
import { describe, expect, it } from "vitest";

import { installSettingsNamespace } from "../../../../shared/settings-namespace.js";

describe("ctx.inject 不可用", () => {
  it("ctx.inject 不可用应 warn", () => {
    let warned = "";
    installSettingsNamespace(
      {
        logger: {
          warn: (m: string) => {
            warned = m;
          },
        },
      },
      "test-ns",
      {},
      {},
      { setSource: () => {}, onChange: () => {} },
    );
    expect(warned).toMatch(/ctx.inject 不可用/);
  });

  it("logger 缺失不抛（极端降级）", () => {
    expect(() => {
      installSettingsNamespace({}, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
    }).not.toThrow();
  });
});

describe("settings 服务缺失", () => {
  it("settings 服务缺失应 warn", () => {
    let warned = "";
    const ctx = {
      logger: {
        warn: (m: string) => {
          warned = m;
        },
      },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) cb({});
        return () => {};
      },
    };
    installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
    expect(warned).toMatch(/缺少 register/);
  });
});

describe("settings.register 抛错", () => {
  it("register 抛错应 warn", () => {
    let warned = "";
    const ctx = {
      logger: {
        warn: (m: string) => {
          warned = m;
        },
      },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              register: () => {
                throw new Error("duplicate ns");
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
    };
    installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
    expect(warned).toMatch(/register 失败/);
  });
});

// 正常注册 + lifecycle（覆盖 isUnloading 两条路径）
//
// 原脚本块按顺序断言依赖同一份可变状态（setSource → watch → disposer）；
// 每条断言改用一次独立装配的等价场景，避免用例间顺序耦合。
function installActiveLifecycle() {
  const state: {
    sourceMode: string;
    onChangeCount: number;
    watchCb: null | (() => void);
    disposer: null | (() => void);
    scope: null | { get: () => { from: string }; watch: (cb: () => void) => void };
    settings: null | {
      register: (_ns: unknown, _schema: unknown, _opts: unknown) => unknown;
      effect: (fn: () => () => void) => () => void;
    };
  } = {
    sourceMode: "unset", // entry | scope
    onChangeCount: 0,
    watchCb: null,
    disposer: null,
    scope: null,
    settings: null,
  };

  const scope = {
    get: () => ({ from: "scope" }),
    watch: (cb: () => void) => {
      state.watchCb = cb;
    },
  };
  state.scope = scope;

  const settings = {
    register: (_ns: unknown, _schema: unknown, _opts: unknown) => scope,
    effect: (fn: () => () => void) => {
      state.disposer = fn();
      return () => {};
    },
  };
  state.settings = settings;

  // 注入器记录 disposer，便于后续手动触发。
  const ctx = {
    fiber: { state: "active" },
    logger: { warn: (_m: string) => {} },
    inject: (keys: unknown, cb: (services: unknown) => void) => {
      if (Array.isArray(keys) && keys.includes("settings"))
        cb({ settings, effect: settings.effect });
      return () => {};
    },
  };

  installSettingsNamespace(
    ctx,
    "test-ns",
    {},
    { from: "entry" },
    {
      setSource: (fn: () => unknown) => {
        // 假 scope 的 get 形状（{ from }）由本文件假件保证，断言其 from 面。
        state.sourceMode = (fn() as { from: string }).from;
      },
      onChange: () => {
        state.onChangeCount += 1;
      },
    },
  );

  return state;
}

describe("正常注册 + lifecycle", () => {
  it("注册后 setSource 指向 scope.get()", () => {
    const state = installActiveLifecycle();
    expect(state.sourceMode).toBe("scope");
  });

  it("注册完成 onChange 触发一次", () => {
    const state = installActiveLifecycle();
    expect(state.onChangeCount).toBe(1);
  });

  it("scope.watch 已注册", () => {
    const state = installActiveLifecycle();
    expect(state.watchCb).not.toBeNull();
  });

  it("watch 变化触发 onChange", () => {
    const state = installActiveLifecycle();
    // 装配期 watch 必接线（短路只在回调内），非空由用例流保证。
    state.watchCb!();
    expect(state.onChangeCount).toBe(2);
  });

  it("卸载回落 entry", () => {
    const state = installActiveLifecycle();
    // 装配期 effect 必接线，非空由用例流保证。
    state.disposer!();
    expect(state.sourceMode).toBe("entry");
  });

  it("disposer 触发 onChange", () => {
    const state = installActiveLifecycle();
    state.watchCb!();
    state.disposer!();
    expect(state.onChangeCount).toBe(3);
  });
});

// onScope（#436）：register 成功后、setSource 之前回调 ----
// 说明：settings 服务缺失用例（上方「settings 服务缺失」describe）hooks 不含
// onScope，未对「缺失不触发」做独立断言——属不传 onScope 的兼容回归（既有 7 处
// 隐式覆盖该分支）。
describe("onScope（#436）：register 成功后、setSource 之前回调", () => {
  function installWithOnScope() {
    const state: {
      scopeSeen: unknown;
      serviceSeen: unknown;
      order: string[];
      scope: null | { get: () => { from: string }; watch: () => () => void };
      settings: null | { register: () => unknown };
    } = { scopeSeen: null, serviceSeen: null, order: [], scope: null, settings: null };
    const scope = {
      get: () => ({ from: "scope" }),
      watch: () => () => {},
    };
    const settings = { register: () => scope };
    state.scope = scope;
    state.settings = settings;
    const ctx = {
      logger: { warn: (_m: string) => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings,
            effect: (fn: () => void) => {
              fn();
              return () => {};
            },
          });
        }
        return () => {};
      },
    };
    installSettingsNamespace(
      ctx,
      "test-ns",
      {},
      { from: "entry" },
      {
        setSource: () => {
          state.order.push("setSource");
        },
        onChange: () => {},
        onScope: (s: unknown, svc: unknown) => {
          state.scopeSeen = s;
          state.serviceSeen = svc;
          state.order.push("onScope");
        },
      },
    );
    return state;
  }

  it("onScope 收到 register 返回的 owner scope", () => {
    const state = installWithOnScope();
    expect(state.scopeSeen).toBe(state.scope);
  });

  it("onScope 收到 settings 服务", () => {
    const state = installWithOnScope();
    expect(state.serviceSeen).toBe(state.settings);
  });

  it("onScope 先于 setSource 回调", () => {
    const state = installWithOnScope();
    expect(state.order).toEqual(["onScope", "setSource"]);
  });
});

// isUnloading 短路：fiber 处于卸载态时 disposer / watch 不动作 ----
describe("isUnloading 短路：卸载态 disposer / watch 不动作", () => {
  function installInState(state: unknown) {
    const seen: {
      onChangeCount: number;
      watchCb: null | (() => void);
      disposer: null | (() => void);
    } = { onChangeCount: 0, watchCb: null, disposer: null };
    const scope = {
      get: () => ({ from: "scope" }),
      watch: (cb: () => void) => {
        seen.watchCb = cb;
      },
    };
    const ctx = {
      fiber: { state },
      logger: { warn: (_m: string) => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: { register: () => scope },
            effect: (fn: () => () => void) => {
              seen.disposer = fn();
              return () => {};
            },
          });
        }
        return () => {};
      },
    };
    installSettingsNamespace(
      ctx,
      "test-ns",
      {},
      { from: "entry" },
      {
        setSource: () => {},
        onChange: () => {
          seen.onChangeCount += 1;
        },
      },
    );
    return seen;
  }

  it.each(["unloading", "unloaded", "disposed"])(
    "state=%s 时 disposer/watch 均短路（不触发 onChange）",
    (state) => {
      const seen = installInState(state);
      const before = seen.onChangeCount;
      // 装配期 effect/watch 必走（短路只在回调内），此处非空由用例流保证。
      seen.disposer!();
      seen.watchCb!();
      expect(seen.onChangeCount).toBe(before);
    },
  );
});

// 总开关：fiber 非对象 / 无 fiber / 无 state 的容错 ----
describe("总开关：fiber 非对象 / 无 fiber / 无 state 的容错", () => {
  it.each([undefined, null, 42, {}])("fiber=%s 时注册与 unmount 皆不抛", (fiber) => {
    let watchCb: null | (() => void) = null;
    let disposer: null | (() => void) = null;
    const scope = {
      get: () => null,
      watch: (cb: () => void) => {
        watchCb = cb;
      },
    };
    const ctx = {
      fiber,
      logger: { warn: (_m: string) => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: { register: () => scope },
            effect: (fn: () => () => void) => {
              disposer = fn();
              return () => {};
            },
          });
        }
        return () => {};
      },
    };
    expect(() => {
      installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
      if (disposer) disposer();
      if (watchCb) watchCb();
    }).not.toThrow();
  });
});
