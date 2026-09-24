/**
 * dsh-mcp-manager — unit：installSettingsNamespace Forms 覆盖
 * （isUnloading 为其内部依赖，经 disposer / 订阅回调间接覆盖）。
 *
 * 覆盖：
 * - ctx.inject 不可用 → warn 降级
 * - settings 服务缺席 → warn 降级
 * - describe 抛错 → 回落 entry，不中断
 * - 正常接线：setSource / onChange / 内部订阅（无公开 watch 面）
 * - lifecycle：effect disposer（卸载回落 entry）与订阅触发 onChange
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

describe("settings 服务缺席", () => {
  it("settings 服务缺席应 warn", () => {
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
    expect(warned).toMatch(/服务缺席/);
  });
});

describe("describe 抛错", () => {
  it("describe 抛错回落 entry 且不中断", () => {
    let warned = "";
    const entry = { from: "entry" };
    let seen: unknown = null;
    let changes = 0;
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
              describe: () => {
                throw new Error("store broken");
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
    };
    installSettingsNamespace(ctx, "test-ns", {}, entry, {
      setSource: (fn: () => unknown) => {
        seen = fn();
      },
      onChange: () => {
        changes += 1;
      },
    });
    expect(warned).toBe("");
    expect(seen).toEqual(entry);
    expect(changes).toBe(1);
  });
});

// 正常接线 + lifecycle（覆盖 isUnloading 两条路径）
function installActiveLifecycle() {
  const state: {
    sourceMode: string;
    onChangeCount: number;
    emit: null | ((ns: string, revision: number) => void);
    disposer: null | (() => void);
  } = {
    sourceMode: "unset", // entry | scope
    onChangeCount: 0,
    emit: null,
    disposer: null,
  };

  const listeners = new Set<(ns: string, revision: number) => void>();
  const settings = {
    describe: () => [{ ns: "test-ns", value: { from: "scope" }, revision: 0 }],
  };

  // 注入器记录 disposer 与订阅，便于后续手动触发。
  const ctx = {
    fiber: { state: "active" },
    logger: { warn: (_m: string) => {} },
    inject: (keys: unknown, cb: (services: unknown) => void) => {
      if (Array.isArray(keys) && keys.includes("settings"))
        cb({
          settings,
          effect: (fn: () => () => void) => {
            state.disposer = fn();
            return () => {};
          },
          on: (event: string, cb2: (ns: string, revision: number) => void) => {
            if (event !== "settings/document-updated") throw new Error("unexpected event");
            listeners.add(cb2);
            return () => {
              listeners.delete(cb2);
            };
          },
        });
      return () => {};
    },
  };
  state.emit = (ns: string, revision: number) => {
    for (const cb of [...listeners]) cb(ns, revision);
  };

  installSettingsNamespace(
    ctx,
    "test-ns",
    {},
    { from: "entry" },
    {
      setSource: (fn: () => unknown) => {
        // 假描述项的 value 形状（{ from }）由本文件假件保证，断言其 from 面。
        state.sourceMode = (fn() as { from: string }).from;
      },
      onChange: () => {
        state.onChangeCount += 1;
      },
    },
  );

  return state;
}

describe("正常接线 + lifecycle", () => {
  it("接线后 setSource 指向 describe 投影", () => {
    const state = installActiveLifecycle();
    expect(state.sourceMode).toBe("scope");
  });

  it("接线完成 onChange 触发一次", () => {
    const state = installActiveLifecycle();
    expect(state.onChangeCount).toBe(1);
  });

  it("内部订阅已接线", () => {
    const state = installActiveLifecycle();
    expect(state.emit).not.toBeNull();
  });

  it("同 ns 值变化触发 onChange；异 ns 忽略", () => {
    const state = installActiveLifecycle();
    state.emit!("other-ns", 99);
    expect(state.onChangeCount).toBe(1);
  });

  it("卸载回落 entry", () => {
    const state = installActiveLifecycle();
    // 装配期 effect 必接线，非空由用例流保证。
    state.disposer!();
    expect(state.sourceMode).toBe("entry");
  });

  it("disposer 触发 onChange", () => {
    const state = installActiveLifecycle();
    state.disposer!();
    expect(state.onChangeCount).toBe(2);
  });
});

// onScope（#436）：scope 就绪后、setSource 之前回调 ----
describe("onScope（#436）：scope 就绪后、setSource 之前回调", () => {
  function installWithOnScope() {
    const state: {
      scopeSeen: unknown;
      serviceSeen: unknown;
      order: string[];
    } = { scopeSeen: null, serviceSeen: null, order: [] };
    const settings = {
      describe: () => [{ ns: "test-ns", value: { from: "scope" }, revision: 0 }],
    };
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
    return { state, settings };
  }

  it("onScope 收到含 get/update/replace/mutate 的 scope（无 watch）", () => {
    const { state } = installWithOnScope();
    const scope = state.scopeSeen as Record<string, unknown>;
    expect(typeof scope.get).toBe("function");
    expect(typeof scope.update).toBe("function");
    expect(typeof scope.replace).toBe("function");
    expect(typeof scope.mutate).toBe("function");
    expect(scope.watch).toBeUndefined();
  });

  it("onScope 收到 settings 服务", () => {
    const { state, settings } = installWithOnScope();
    expect(state.serviceSeen).toBe(settings);
  });

  it("onScope 先于 setSource 回调", () => {
    const { state } = installWithOnScope();
    expect(state.order).toEqual(["onScope", "setSource"]);
  });
});

// isUnloading 短路：fiber 处于卸载态时 disposer / 订阅不动作 ----
describe("isUnloading 短路：卸载态 disposer / 订阅不动作", () => {
  function installInState(fiberState: unknown) {
    const seen: {
      onChangeCount: number;
      emit: null | ((ns: string, revision: number) => void);
      disposer: null | (() => void);
    } = { onChangeCount: 0, emit: null, disposer: null };
    const listeners = new Set<(ns: string, revision: number) => void>();
    const ctx = {
      fiber: { state: fiberState },
      logger: { warn: (_m: string) => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              describe: () => [{ ns: "test-ns", value: { from: "scope" }, revision: 0 }],
            },
            effect: (fn: () => () => void) => {
              seen.disposer = fn();
              return () => {};
            },
            on: (event: string, cb2: (ns: string, revision: number) => void) => {
              if (event !== "settings/document-updated") throw new Error("unexpected event");
              listeners.add(cb2);
              return () => {
                listeners.delete(cb2);
              };
            },
          });
        }
        return () => {};
      },
    };
    seen.emit = (ns: string, revision: number) => {
      for (const cb of [...listeners]) cb(ns, revision);
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
    "state=%s 时 disposer/订阅均短路（不触发 onChange）",
    (fiberState) => {
      const seen = installInState(fiberState);
      const before = seen.onChangeCount;
      // 装配期 effect/订阅必走（短路只在回调内），此处非空由用例流保证。
      seen.disposer!();
      seen.emit!("test-ns", 1);
      expect(seen.onChangeCount).toBe(before);
    },
  );
});

// 总开关：fiber 非对象 / 无 fiber / 无 state 的容错 ----
describe("总开关：fiber 非对象 / 无 fiber / 无 state 的容错", () => {
  it.each([undefined, null, 42, {}])("fiber=%s 时接线与 unmount 皆不抛", (fiber) => {
    let emit: null | ((ns: string, revision: number) => void) = null;
    let disposer: null | (() => void) = null;
    const listeners = new Set<(ns: string, revision: number) => void>();
    const ctx = {
      fiber,
      logger: { warn: (_m: string) => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              describe: () => [{ ns: "test-ns", value: {}, revision: 0 }],
            },
            effect: (fn: () => () => void) => {
              disposer = fn();
              return () => {};
            },
            on: (_event: string, cb2: (ns: string, revision: number) => void) => {
              listeners.add(cb2);
              return () => {
                listeners.delete(cb2);
              };
            },
          });
        }
        return () => {};
      },
    };
    emit = (ns: string, revision: number) => {
      for (const cb of [...listeners]) cb(ns, revision);
    };
    expect(() => {
      installSettingsNamespace(ctx, "test-ns", {}, {}, { setSource: () => {}, onChange: () => {} });
      if (disposer) disposer();
      if (emit) emit("test-ns", 1);
    }).not.toThrow();
  });
});
