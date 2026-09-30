import { describe, expect, it } from "vitest";

import {
  installSettingsNamespace,
  warnLog,
  type SettingsFormsScope,
} from "../settings-namespace.ts";

const NAMESPACE = "dsh-mcp-manager";

type Listener = (eventNamespace: unknown, revision: unknown) => void;
type Scope = SettingsFormsScope;
type Setup = (value: {
  settings: unknown;
  on?: (event: string, listener: Listener, options?: { global?: boolean }) => unknown;
  effect?: (setup: () => () => void) => unknown;
}) => void;

type WriteCall = {
  readonly method: "update" | "replace" | "mutate";
  readonly namespace: string;
  readonly payload: unknown;
  readonly revision: number | undefined;
  /** 实际传给服务面的实参个数（缺席 expectedRevision 时是 2，不是 3）。 */
  readonly argCount: number;
};

interface FixtureOptions {
  readonly fiberState?: string | number;
  /** 宿主上下文的形态：plain=普通对象；callable=可调用对象（typeof "function"）；no-fiber=没有 fiber 键。 */
  readonly contextKind?: "plain" | "callable" | "no-fiber";
  /** 直接替换 ctx.fiber 的值（缺席时用夹具自带的桩 fiber）。 */
  readonly hostFiber?: unknown;
  /** 注入后的 scoped 上下文形态：plain / callable。 */
  readonly scopedKind?: "plain" | "callable";
  /** 桩 fiber 不带 state 字段（判据是「无状态机」而不是某态）。 */
  readonly omitFiberState?: boolean;
  /** scoped 注销后仍保留已注册监听器（退订器不摘监听，用于观察 disposed 门禁本身）。 */
  readonly retainSubscriptionOnDispose?: boolean;
  /** 每次 describe() 调用时触发，参数是从 1 起的调用序号。 */
  readonly duringDescribe?: (call: number) => void;
  readonly initialValue?: unknown;
  readonly entries?: unknown;
  readonly initiallyServed?: boolean;
  readonly deferOwnerReady?: boolean;
  readonly emitOnFirstServe?: boolean;
  readonly describeErrorAfterInstall?: boolean;
  readonly includeEffect?: boolean;
  readonly includeOn?: boolean;
  readonly scopedOn?: (
    event: string,
    listener: Listener,
    options?: { global?: boolean },
  ) => unknown;
  readonly contextOn?: (
    event: string,
    listener: Listener,
    options?: { global?: boolean },
  ) => unknown;
}

interface Fixture {
  /** 宿主上下文按 contextKind 成型（普通对象 / 可调用对象 / 无 fiber），故只承诺 inject 可用。 */
  readonly context: { inject(keys: string[], setup: Setup): () => void };
  emit(eventNamespace: unknown, revision: unknown): void;
  install(hooks?: {
    readonly onScope?: (scope: Scope, service: unknown) => void;
    readonly onChange?: () => void;
  }): void;
  dispose(): void;
  setDescriptor(next: Record<string, unknown>): void;
  setServed(next: boolean, emitEvent?: boolean): void;
  resolveOwnerReady(): void;
  /** 只放行 fiber.await()，不改 fiber.state（观察 await 归位时的 fiberSettled 门禁）。 */
  resolveOwnerAwaitOnly(): void;
  readonly listeners: Map<number, Listener>;
  readonly order: string[];
  readonly warnings: string[];
  readonly writes: WriteCall[];
  readonly receivers: unknown[];
  readonly scope: Scope;
  readonly service: unknown;
  readonly source: () => unknown;
  readonly changes: number;
}

/** 桩 fiber 的初始 state：deferOwnerReady 用例先落在 "loading"（就绪由测试显式放行），
 * 否则取显式 fiberState，缺席时默认 "active"。 */
function initialFiberState(options: FixtureOptions): string | number {
  if (options.deferOwnerReady === true) return "loading";
  return options.fiberState ?? "active";
}

/** ctx.fiber 的值：默认是桩 fiber，hostFiber 显式给定时直接用它（可给非普通对象）。 */
function buildHostFiber(options: FixtureOptions, ownerReady: Promise<void>): unknown {
  if ("hostFiber" in options) return options.hostFiber;
  return {
    ...(options.omitFiberState === true ? {} : { state: initialFiberState(options) }),
    await: () => ownerReady,
  };
}

/** 注入后的 scoped 上下文：默认普通对象；scopedKind="callable" 时是可调用对象。 */
function buildScopedContext(
  options: FixtureOptions,
  settings: unknown,
  subscription: (event: string, listener: Listener) => unknown,
  effect: (setup: () => () => void) => unknown,
): Parameters<Setup>[0] {
  const members = {
    settings,
    ...(options.includeOn === false ? {} : { on: options.scopedOn ?? subscription }),
    ...(options.includeEffect === false ? {} : { effect }),
  };
  return options.scopedKind === "callable"
    ? Object.assign(function scopedContext() {}, members)
    : members;
}

/** 宿主上下文：默认普通对象；callable 时可调用（typeof "function"）；no-fiber 时没有 fiber 键。 */
function buildHostContext(
  options: FixtureOptions,
  fiber: unknown,
  warnings: string[],
  scoped: Parameters<Setup>[0],
): { inject(keys: string[], setup: Setup): () => void } {
  const members = {
    ...(options.contextKind === "no-fiber" ? {} : { fiber }),
    logger: { warn: (message: unknown) => warnings.push(String(message)) },
    ...(options.contextOn === undefined ? {} : { on: options.contextOn }),
    inject(keys: string[], setup: Setup) {
      expect(keys).toEqual(["settings"]);
      setup(scoped);
      return () => {};
    },
  };
  return options.contextKind === "callable"
    ? Object.assign(function hostContext() {}, members)
    : members;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const listeners = new Map<number, Listener>();
  const warnings: string[] = [];
  const writes: WriteCall[] = [];
  const receivers: unknown[] = [];
  const order: string[] = [];
  let resolveOwnerReadyPromise: () => void = () => {};
  const ownerReady = new Promise<void>((resolve) => {
    resolveOwnerReadyPromise = resolve;
  });
  const hostFiber = buildHostFiber(options, ownerReady);
  if (options.deferOwnerReady !== true) resolveOwnerReadyPromise();
  let nextListenerId = 0;
  let installed = false;
  let scopeRef: Scope | undefined;
  let serviceRef: unknown;
  let sourceRef: (() => unknown) | undefined;
  let effectDisposer: (() => void) | undefined;
  let changeCount = 0;
  let served = options.initiallyServed ?? true;
  let serveAnnounced = false;
  let descriptor: Record<string, unknown> = {
    ns: NAMESPACE,
    value: options.initialValue ?? { position: "top-right" },
    revision: 1,
  };

  function emit(eventNamespace: unknown, revision: unknown): void {
    for (const listener of [...listeners.values()]) listener(eventNamespace, revision);
  }

  let describeCalls = 0;
  const settings = {
    describe() {
      describeCalls += 1;
      options.duringDescribe?.(describeCalls);
      if (installed && options.describeErrorAfterInstall) throw new Error("describe unavailable");
      if (!served) return [];
      if (options.emitOnFirstServe === true && !serveAnnounced) {
        serveAnnounced = true;
        emit(NAMESPACE, descriptor.revision);
      }
      if (options.entries !== undefined) return options.entries;
      return [descriptor];
    },
    update: async function (
      this: unknown,
      namespace: string,
      payload: Record<string, unknown>,
      revision?: number,
    ) {
      receivers.push(this);
      writes.push({ method: "update", namespace, payload, revision, argCount: arguments.length });
      const current = descriptor.value;
      if (typeof current === "object" && current !== null && !Array.isArray(current)) {
        descriptor = {
          ...descriptor,
          value: { ...(current as Record<string, unknown>), ...payload },
          revision: Number(descriptor.revision) + 1,
        };
      }
      emit(NAMESPACE, descriptor.revision);
    },
    replace: async function (
      this: unknown,
      namespace: string,
      payload: Record<string, unknown>,
      revision?: number,
    ) {
      receivers.push(this);
      writes.push({ method: "replace", namespace, payload, revision, argCount: arguments.length });
      descriptor = {
        ...descriptor,
        value: { ...payload },
        revision: Number(descriptor.revision) + 1,
      };
      emit(NAMESPACE, descriptor.revision);
    },
    mutate: async function (
      this: unknown,
      namespace: string,
      payload: readonly { op: string; path: readonly string[]; value?: unknown }[],
      revision?: number,
    ) {
      receivers.push(this);
      writes.push({ method: "mutate", namespace, payload, revision, argCount: arguments.length });
      const current = descriptor.value;
      const next: Record<string, unknown> =
        typeof current === "object" && current !== null && !Array.isArray(current)
          ? { ...(current as Record<string, unknown>) }
          : {};
      for (const operation of payload) {
        const key = operation.path[0];
        if (key === undefined) continue;
        if (operation.op === "unset") delete next[key];
        else next[key] = operation.value;
      }
      descriptor = { ...descriptor, value: next, revision: Number(descriptor.revision) + 1 };
      emit(NAMESPACE, descriptor.revision);
    },
  };

  const defaultOn = (
    event: string,
    listener: Listener,
    _options?: { global?: boolean },
  ): (() => void) => {
    expect(event).toBe("settings/document-updated");
    const id = nextListenerId++;
    listeners.set(id, listener);
    return options.retainSubscriptionOnDispose === true
      ? () => undefined
      : () => listeners.delete(id);
  };
  const scoped = buildScopedContext(options, settings, defaultOn, (setup) => {
    effectDisposer = setup();
    return () => {};
  });
  const context = buildHostContext(options, hostFiber, warnings, scoped);

  return {
    context,
    emit,
    install(hooks = {}) {
      installSettingsNamespace(
        context,
        NAMESPACE,
        {},
        { position: "top-left" },
        {
          setSource(source) {
            order.push("setSource");
            sourceRef = source;
          },
          onChange() {
            changeCount += 1;
            hooks.onChange?.();
          },
          onScope(scope, service) {
            order.push("onScope");
            scopeRef = scope;
            serviceRef = service;
            hooks.onScope?.(scope, service);
          },
        },
      );
      installed = true;
    },
    dispose() {
      effectDisposer?.();
    },
    setDescriptor(next) {
      descriptor = next;
    },
    setServed(next, emitEvent = true) {
      if (served === next) return;
      served = next;
      if (served && emitEvent) emit(NAMESPACE, Number(descriptor.revision) + 1);
    },
    // 语义变更（相对 baseline）：改写的是「ctx.fiber 实际挂上去的那个对象」，不再只限于
    // 夹具自带的桩 fiber；hostFiber 显式传别的对象时（如 state 可变的 fiberRef），被改写的是
    // 传入的那一个。resolveOwnerAwaitOnly() 是新增接缝：只放行 fiber.await()，不改 state。
    resolveOwnerReady() {
      (hostFiber as { state?: unknown }).state = "active";
      resolveOwnerReadyPromise();
    },
    resolveOwnerAwaitOnly() {
      resolveOwnerReadyPromise();
    },
    listeners,
    order,
    warnings,
    writes,
    receivers,
    get scope(): Scope {
      if (scopeRef === undefined) throw new Error("scope not installed");
      return scopeRef;
    },
    get service(): unknown {
      return serviceRef;
    },
    get source(): () => unknown {
      if (sourceRef === undefined) throw new Error("source not installed");
      return sourceRef;
    },
    get changes(): number {
      return changeCount;
    },
  };
}

describe("shared/settings-namespace mutation contract", () => {
  it("degrades without inject or a usable settings service", () => {
    const warnings: string[] = [];
    let hookCalls = 0;
    installSettingsNamespace(
      { logger: { warn: (message: unknown) => warnings.push(String(message)) } },
      NAMESPACE,
      {},
      {},
      {
        setSource: () => {
          hookCalls += 1;
        },
        onChange: () => {
          hookCalls += 1;
        },
      },
    );
    expect(warnings).toEqual([expect.stringContaining("ctx.inject 不可用")]);
    expect(hookCalls).toBe(0);

    const serviceWarnings: string[] = [];
    installSettingsNamespace(
      {
        logger: { warn: (message: unknown) => serviceWarnings.push(String(message)) },
        inject: (_keys, setup: (value: unknown) => void) => setup({}),
      },
      NAMESPACE,
      {},
      {},
      { setSource: () => undefined, onChange: () => undefined },
    );
    expect(serviceWarnings).toEqual([expect.stringContaining("settings 服务缺席")]);
  });

  it("derives source from the matching descriptor and exposes scope before source", () => {
    const fixture = makeFixture({
      initialValue: { position: "bottom-right", nested: { enabled: true, count: 2 } },
    });
    fixture.install();
    expect(fixture.source()).toEqual({
      position: "bottom-right",
      nested: { enabled: true, count: 2 },
    });
    expect(fixture.scope.get()).toEqual(fixture.source());
    expect(fixture.service).toBeDefined();
    expect(fixture.order).toEqual(["onScope", "setSource"]);
    expect(fixture.changes).toBe(1);
  });

  it("delivers scope after the owning fiber is active and the namespace is served", async () => {
    const fixture = makeFixture({
      initiallyServed: false,
      deferOwnerReady: true,
      emitOnFirstServe: true,
    });
    let scopeCalls = 0;

    fixture.install({ onScope: () => (scopeCalls += 1) });
    expect(scopeCalls).toBe(0);
    expect(fixture.order).toEqual(["setSource"]);
    expect(fixture.source()).toEqual({ position: "top-left" });

    fixture.setServed(true, false);
    expect(scopeCalls).toBe(0);
    fixture.resolveOwnerReady();
    await Promise.resolve();
    await Promise.resolve();

    expect(scopeCalls).toBe(1);
    expect(fixture.order).toEqual(["setSource", "onScope"]);
    expect(fixture.scope.get()).toEqual({ position: "top-right" });

    fixture.setDescriptor({ ns: NAMESPACE, value: { position: "bottom-left" }, revision: 3 });
    fixture.emit(NAMESPACE, 3);
    expect(scopeCalls).toBe(1);
  });

  it.each([
    ["a different namespace", [{ ns: "other", value: { v: 9 } }]],
    ["a missing value field", [{ ns: NAMESPACE, revision: 1 }]],
    ["a malformed descriptor list", { ns: NAMESPACE }],
    ["malformed items without a matching namespace", [null, 7, { ns: "other", value: { v: 3 } }]],
  ])("falls back to the entry for %s", (_label, entries) => {
    const fixture = makeFixture({ entries });
    fixture.install();
    expect(fixture.source()).toEqual({ position: "top-left" });
  });

  it("skips malformed descriptor items before a valid matching descriptor", () => {
    const fixture = makeFixture({
      entries: [null, 7, { ns: NAMESPACE, value: { v: 3 } }],
    });
    fixture.install();
    expect(fixture.source()).toEqual({ v: 3 });
  });

  it("delegates update, replace, and mutate with namespace, receiver, payload, and revision", async () => {
    const fixture = makeFixture({ initialValue: { position: "top-right", enabled: false } });
    fixture.install();

    await fixture.scope.update({ enabled: true });
    await fixture.scope.replace({ position: "bottom-left" }, 7);
    await fixture.scope.mutate([{ op: "set", path: ["enabled"], value: true }], 8);
    await fixture.scope.mutate([{ op: "unset", path: ["enabled"] }]);

    expect(fixture.writes).toEqual([
      {
        method: "update",
        namespace: NAMESPACE,
        payload: { enabled: true },
        revision: undefined,
        argCount: 2,
      },
      {
        method: "replace",
        namespace: NAMESPACE,
        payload: { position: "bottom-left" },
        revision: 7,
        argCount: 3,
      },
      {
        method: "mutate",
        namespace: NAMESPACE,
        payload: [{ op: "set", path: ["enabled"], value: true }],
        revision: 8,
        argCount: 3,
      },
      {
        method: "mutate",
        namespace: NAMESPACE,
        payload: [{ op: "unset", path: ["enabled"] }],
        revision: undefined,
        argCount: 2,
      },
    ]);
    expect(fixture.receivers).toHaveLength(4);
    expect(new Set(fixture.receivers).size).toBe(1);
    expect(fixture.source()).toEqual({ position: "bottom-left" });
  });

  it("rejects a missing writer and converts a synchronous writer throw to a rejection", async () => {
    const missing = makeFixture();
    missing.install();
    (missing.service as { replace?: unknown }).replace = undefined;
    // 不能只断 rejects.toThrow(msg)：被拒值不是 Error 时它照样判绿，
    // 那样「文案单点」这一事实就没被钉住。
    const rejection = await missing.scope.replace({ position: "left" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) throw new Error("rejection is not an Error");
    expect(rejection.message).toBe("settings service unavailable: replace 缺失");

    const failure = new Error("write failed");
    const calls: string[] = [];
    let scope: Scope | undefined;
    installSettingsNamespace(
      {
        fiber: { state: "active" },
        inject(keys: string[], setup: (value: unknown) => void) {
          calls.push(...keys);
          setup({
            settings: {
              describe: () => [{ ns: NAMESPACE, value: { v: 1 } }],
              update() {
                throw failure;
              },
            },
          });
        },
      },
      NAMESPACE,
      {},
      { v: 0 },
      {
        setSource: () => undefined,
        onChange: () => undefined,
        onScope: (value) => {
          scope = value as Scope;
        },
      },
    );
    if (scope === undefined) throw new Error("scope not installed");
    await expect(scope.update({ v: 2 })).rejects.toBe(failure);
    expect(calls).toEqual(["settings"]);
  });

  it("subscribes through scoped context, falls back to host context, and deduplicates one function", () => {
    const scopedListeners: Listener[] = [];
    const scoped = makeFixture({
      scopedOn: (_event, listener) => {
        scopedListeners.push(listener);
        return () => undefined;
      },
    });
    scoped.install();
    scoped.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    scopedListeners[0]?.(NAMESPACE, 2);
    expect(scoped.changes).toBe(2);

    const fallbackCalls: string[] = [];
    const fallbackListeners: Listener[] = [];
    const fallback = makeFixture({
      scopedOn: () => {
        fallbackCalls.push("scoped");
        throw new Error("scoped unavailable");
      },
      contextOn: (_event, listener) => {
        fallbackCalls.push("context");
        fallbackListeners.push(listener);
        return () => undefined;
      },
    });
    fallback.install();
    fallback.setDescriptor({ ns: NAMESPACE, value: { v: 3 }, revision: 3 });
    fallbackListeners[0]?.(NAMESPACE, 3);
    expect(fallbackCalls).toEqual(["scoped", "context"]);
    expect(fallback.changes).toBe(2);

    let sharedCalls = 0;
    const sharedOn = (_event: string, listener: Listener) => {
      sharedCalls += 1;
      listener(NAMESPACE, 1);
      return () => undefined;
    };
    const shared = makeFixture({ scopedOn: sharedOn, contextOn: sharedOn });
    shared.install();
    expect(sharedCalls).toBe(1);
  });

  it("requests global delivery for cross-context settings events", () => {
    let options: { global?: boolean } | undefined;
    const fixture = makeFixture({
      scopedOn: (_event, _listener, receivedOptions) => {
        options = receivedOptions;
        return () => undefined;
      },
    });
    fixture.install();
    expect(options).toEqual({ global: true });
  });

  it("falls back to the host context when the scoped context has no event surface", () => {
    const contextListeners: Listener[] = [];
    const fixture = makeFixture({
      includeOn: false,
      contextOn: (_event, listener) => {
        contextListeners.push(listener);
        return () => undefined;
      },
    });
    fixture.install();
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    contextListeners[0]?.(NAMESPACE, 2);
    expect(fixture.changes).toBe(2);
  });

  it("merges base and user layers when the runtime value lags a profile edit", () => {
    const fixture = makeFixture({
      initialValue: { port: 3081, nested: { enabled: false, keep: 1 }, list: [1] },
    });
    fixture.install();
    fixture.setDescriptor({
      ns: NAMESPACE,
      value: { port: 3081, nested: { enabled: false, keep: 1 }, list: [1] },
      base: { port: 3081, nested: { enabled: false, keep: 1 }, list: [1] },
      user: { port: 39181, nested: { enabled: true }, list: [2] },
      revision: 2,
    });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.source()).toEqual({
      port: 39181,
      nested: { enabled: true, keep: 1 },
      list: [2],
    });
    expect(fixture.changes).toBe(2);
  });

  it("notifies only for same-namespace semantic changes and keeps source live", () => {
    const fixture = makeFixture({ initialValue: { a: 1, nested: { b: 2, c: 3 } } });
    fixture.install();

    fixture.emit("other-namespace", 2);
    fixture.emit(NAMESPACE, 1);
    fixture.setDescriptor({
      ns: NAMESPACE,
      value: { nested: { c: 3, b: 2 }, a: 1 },
      revision: 2,
    });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(1);

    fixture.setDescriptor({
      ns: NAMESPACE,
      value: { nested: { c: 4, b: 2 }, a: 1 },
      revision: 3,
    });
    fixture.emit(NAMESPACE, 3);
    expect(fixture.changes).toBe(2);
    expect(fixture.source()).toEqual({ nested: { c: 4, b: 2 }, a: 1 });
  });

  it("compares a detached snapshot rather than the live descriptor reference", () => {
    const live = { nested: { count: 1 } };
    const fixture = makeFixture({ initialValue: live });
    fixture.install();

    live.nested.count = 2;
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(2);
    expect(fixture.source()).toEqual({ nested: { count: 2 } });
  });

  it("cleans up and falls back on scoped disposal, including a throwing disposer", () => {
    const fixture = makeFixture({
      initialValue: { v: 5 },
      scopedOn: () => () => {
        throw new Error("dispose failed");
      },
    });
    fixture.install();
    expect(fixture.changes).toBe(1);
    fixture.dispose();
    expect(fixture.changes).toBe(2);
    expect(fixture.source()).toEqual({ position: "top-left" });
  });

  it.each(["unloading", "unloaded", "disposed", 5, 4])(
    "does not publish fallback changes while fiber is %s",
    (fiberState) => {
      const fixture = makeFixture({ fiberState, initialValue: { v: 1 } });
      fixture.install();
      const before = fixture.changes;
      fixture.dispose();
      fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
      fixture.emit(NAMESPACE, 2);
      expect(fixture.changes).toBe(before);
    },
  );

  it("swallows read and observer errors during event handling", () => {
    const readFailure = makeFixture({ describeErrorAfterInstall: true });
    readFailure.install();
    expect(() => readFailure.emit(NAMESPACE, 2)).not.toThrow();
    expect(readFailure.changes).toBe(2);

    const observerFailure = makeFixture();
    observerFailure.install({
      onChange() {
        if (observerFailure.changes > 1) throw new Error("observer failed");
      },
    });
    observerFailure.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    expect(() => observerFailure.emit(NAMESPACE, 2)).not.toThrow();
    expect(observerFailure.changes).toBe(2);
  });

  it("supports installation without effect or event subscription", () => {
    const fixture = makeFixture({ includeEffect: false, includeOn: false });
    fixture.install();
    expect(fixture.source()).toEqual({ position: "top-right" });
    expect(fixture.changes).toBe(1);
  });

  it("warns only when a callable logger is available", () => {
    const messages: string[] = [];
    warnLog({ logger: { warn: (message: string) => messages.push(message) } }, "visible");
    warnLog({ logger: { warn: "not callable" } }, "hidden");
    warnLog({}, "hidden");
    expect(messages).toEqual(["visible"]);
  });

  it("reads no logger from a host context that is not a plain object", () => {
    const messages: string[] = [];
    const callableContext = Object.assign(function callableContext() {}, {
      logger: { warn: (message: string) => messages.push(message) },
    });
    warnLog(null, "hidden");
    warnLog("plain-string", "hidden");
    warnLog(callableContext, "hidden");
    expect(messages).toEqual([]);
  });

  it("degrades without throwing for a host context that is not an object", () => {
    let hookCalls = 0;
    const hooks = {
      setSource: () => {
        hookCalls += 1;
      },
      onChange: () => {
        hookCalls += 1;
      },
    };
    expect(() => installSettingsNamespace(null, NAMESPACE, {}, {}, hooks)).not.toThrow();
    expect(() => installSettingsNamespace(undefined, NAMESPACE, {}, {}, hooks)).not.toThrow();
    expect(hookCalls).toBe(0);
  });

  it("installs when the optional onScope hook is absent", () => {
    let sourceRef: (() => unknown) | undefined;
    const scoped = {
      settings: { describe: () => [{ ns: NAMESPACE, value: { v: 7 } }] },
    };
    installSettingsNamespace(
      { inject: (_keys: string[], setup: (value: unknown) => void) => setup(scoped) },
      NAMESPACE,
      {},
      { v: 0 },
      {
        setSource: (source) => {
          sourceRef = source;
        },
        onChange: () => undefined,
      },
    );
    if (sourceRef === undefined) throw new Error("setSource not called");
    expect(sourceRef()).toEqual({ v: 7 });
  });

  it("installs on a host context that exposes no fiber", () => {
    const fixture = makeFixture({ contextKind: "no-fiber" });
    fixture.install();
    expect(fixture.order).toEqual(["onScope", "setSource"]);
    expect(fixture.source()).toEqual({ position: "top-right" });
  });

  it("delivers the scope when the owning fiber exposes no state", () => {
    const fixture = makeFixture({ omitFiberState: true });
    fixture.install();
    expect(fixture.order).toEqual(["onScope", "setSource"]);
  });

  it("keeps delivering changes for a callable host context that carries a fiber", () => {
    const fixture = makeFixture({
      contextKind: "callable",
      hostFiber: { state: "unloading" },
      initialValue: { v: 1 },
    });
    fixture.install();
    expect(fixture.order).toEqual(["onScope", "setSource"]);

    const before = fixture.changes;
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(before + 1);
  });

  it("treats a callable host context as carrying no fiber", () => {
    const fixture = makeFixture({
      contextKind: "callable",
      hostFiber: { state: "loading", await: () => Promise.resolve() },
    });
    fixture.install();
    expect(fixture.order).toEqual(["onScope", "setSource"]);
  });

  it("does not read state from a fiber that is not a plain object", () => {
    const fixture = makeFixture({
      hostFiber: Object.assign(function callableFiber() {}, { state: "unloading" }),
      initialValue: { v: 1 },
    });
    fixture.install();
    const before = fixture.changes;
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(before + 1);
  });

  it("settles the owning fiber when a callable fiber exposes no readable state", () => {
    const fixture = makeFixture({
      hostFiber: Object.assign(function callableFiber() {}, {
        state: "loading",
        await: () => Promise.resolve(),
      }),
    });
    fixture.install();
    expect(fixture.order).toEqual(["onScope", "setSource"]);
  });

  it("ignores a callable scoped context as a subscription surface", () => {
    const scopedCalls: string[] = [];
    const contextListeners: Listener[] = [];
    const fixture = makeFixture({
      scopedKind: "callable",
      scopedOn: () => {
        scopedCalls.push("scoped");
        return () => undefined;
      },
      contextOn: (_event, listener) => {
        contextListeners.push(listener);
        return () => undefined;
      },
    });
    fixture.install();
    expect(scopedCalls).toEqual([]);
    expect(contextListeners).toHaveLength(1);
  });

  it("does not fall back to a callable host context as a subscription surface", () => {
    const contextListeners: Listener[] = [];
    const fixture = makeFixture({
      contextKind: "callable",
      includeOn: false,
      contextOn: (_event, listener) => {
        contextListeners.push(listener);
        return () => undefined;
      },
    });
    fixture.install();
    expect(contextListeners).toEqual([]);
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(1);
  });

  it("keeps a shared subscription face on the scoped context even when it throws there", () => {
    const receivers: unknown[] = [];
    const sharedOn = function (this: unknown, _event: string, _listener: Listener): unknown {
      receivers.push(this);
      // scoped 上下文带 settings、宿主上下文没有：同一个函数只在 scoped 接收者上失败。
      if ((this as { settings?: unknown }).settings !== undefined) {
        throw new Error("scoped receiver unavailable");
      }
      return () => undefined;
    };
    const fixture = makeFixture({ scopedOn: sharedOn, contextOn: sharedOn });
    fixture.install();
    expect(receivers).toHaveLength(1);
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(1);
  });

  it("detaches the document-updated subscription when the scoped fiber is disposed", () => {
    const fixture = makeFixture({ initialValue: { v: 1 } });
    fixture.install();
    expect(fixture.changes).toBe(1);
    fixture.dispose();
    expect(fixture.changes).toBe(2);
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(2);
  });

  it("ignores a document-updated event for another namespace even when the value changed", () => {
    const fixture = makeFixture({ initialValue: { v: 1 } });
    fixture.install();
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
    fixture.emit("other-namespace", 2);
    expect(fixture.changes).toBe(1);
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(2);
  });

  it("holds back the scope until the settings service describes the namespace", () => {
    const fixture = makeFixture({ initiallyServed: false });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    expect(delivered).toBe(0);
    expect(fixture.order).toEqual(["setSource"]);
  });

  it("delivers the scope on the first document-updated event after a late serve", () => {
    const fixture = makeFixture({ initiallyServed: false });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    expect(delivered).toBe(0);
    fixture.setServed(true);
    expect(delivered).toBe(1);
    expect(fixture.order).toEqual(["setSource", "onScope"]);
  });

  it("does not deliver a scope after the scoped fiber has been disposed", () => {
    const fixture = makeFixture({ initiallyServed: false });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    fixture.dispose();
    fixture.setServed(true);
    expect(delivered).toBe(0);
  });

  it.each(["unloading", "unloaded", "disposed", 4, 5])(
    "does not republish a changed value while the fiber is %s",
    (fiberState) => {
      const fixture = makeFixture({ fiberState, initialValue: { v: 1 } });
      fixture.install();
      expect(fixture.changes).toBe(1);
      fixture.setDescriptor({ ns: NAMESPACE, value: { v: 2 }, revision: 2 });
      fixture.emit(NAMESPACE, 2);
      expect(fixture.changes).toBe(1);
    },
  );

  it("rejects a settings service that is not a plain object", () => {
    // 与 L460/L331/L333/L400/L158 同一道信任边界：typeof === "object" 之外的服务一律降级。
    const warnings: string[] = [];
    let hookCalls = 0;
    const callableSettings = Object.assign(function callableSettings() {}, {
      describe: () => [{ ns: NAMESPACE, value: { v: 5 } }],
    });
    installSettingsNamespace(
      {
        logger: { warn: (message: unknown) => warnings.push(String(message)) },
        inject: (_keys: string[], setup: (value: unknown) => void) =>
          setup({ settings: callableSettings }),
      },
      NAMESPACE,
      {},
      { v: 0 },
      {
        setSource: () => {
          hookCalls += 1;
        },
        onChange: () => {
          hookCalls += 1;
        },
      },
    );
    expect(warnings).toEqual([expect.stringContaining("settings 服务缺席")]);
    expect(hookCalls).toBe(0);
  });

  it("matches only plain-object descriptor entries", () => {
    const callableEntry = Object.assign(function callableEntry() {}, {
      ns: NAMESPACE,
      value: { from: "callable" },
    });
    const fixture = makeFixture({ entries: [callableEntry] });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    expect(fixture.source()).toEqual({ position: "top-left" });
    expect(delivered).toBe(0);
  });

  it("treats a hostile callable entry as malformed instead of reading its ns", () => {
    // 用 defineProperty 而不是 Object.assign：后者会先读一次 getter，抛错点就跑在夹具里而不是被测面。
    function hostileEntry(): void {}
    Object.defineProperty(hostileEntry, "ns", {
      get(): never {
        throw new TypeError("ns is not readable");
      },
    });
    const fixture = makeFixture({
      entries: [hostileEntry, { ns: NAMESPACE, value: { v: 1 } }],
    });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    expect(fixture.source()).toEqual({ v: 1 });
    expect(delivered).toBe(1);
  });

  it("rejects a settings service that exposes no describe", () => {
    const warnings: string[] = [];
    let hookCalls = 0;
    installSettingsNamespace(
      {
        logger: { warn: (message: unknown) => warnings.push(String(message)) },
        inject: (_keys: string[], setup: (value: unknown) => void) => setup({ settings: {} }),
      },
      NAMESPACE,
      {},
      {},
      {
        setSource: () => {
          hookCalls += 1;
        },
        onChange: () => {
          hookCalls += 1;
        },
      },
    );
    expect(warnings).toEqual([expect.stringContaining("settings 服务缺席")]);
    expect(hookCalls).toBe(0);
  });

  it("tells an empty array apart from an empty object", () => {
    const fixture = makeFixture({ initialValue: [] });
    fixture.install();
    expect(fixture.changes).toBe(1);
    fixture.setDescriptor({ ns: NAMESPACE, value: {}, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(2);
  });

  it("falls back to the runtime value when the base layer is null", () => {
    const fixture = makeFixture();
    fixture.install();
    fixture.setDescriptor({
      ns: NAMESPACE,
      value: { position: "stale" },
      base: null,
      user: { enabled: true },
      revision: 2,
    });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.source()).toEqual({ position: "stale", enabled: true });
  });

  it("ignores a non-record runtime base instead of spreading it", () => {
    const fixture = makeFixture();
    fixture.install();
    // base 键非记录时 readFormsValue 会把 value 交给 mergeFormLayers 当 base，
    // 所以这里要落在 L261 的真分支上：base 键给标量、value 给字符串。
    fixture.setDescriptor({
      ns: NAMESPACE,
      value: "legacy",
      base: 5,
      user: { enabled: true },
      revision: 2,
    });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.source()).toEqual({ enabled: true });
  });

  it("keeps a scalar user field from being replaced by the base object", () => {
    const fixture = makeFixture();
    fixture.install();
    fixture.setDescriptor({
      ns: NAMESPACE,
      value: { v: 0 },
      base: { nested: { a: 1 } },
      user: { nested: 5 },
      revision: 2,
    });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.source()).toEqual({ nested: 5 });
  });

  it("merges a record base with a non-record user layer", () => {
    const fixture = makeFixture();
    fixture.install();
    fixture.setDescriptor({
      ns: NAMESPACE,
      value: { stale: true },
      base: { port: 1 },
      user: null,
      revision: 2,
    });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.source()).toEqual({ port: 1 });
  });

  it("delivers the scope for a numeric ACTIVE fiber state", () => {
    const fixture = makeFixture({ fiberState: 2 });
    fixture.install();
    expect(fixture.order).toEqual(["onScope", "setSource"]);
  });

  it("withholds the scope when the host starts unloading during the first read", () => {
    const fiberRef = { state: "active" as string | number, await: () => Promise.resolve() };
    const fixture = makeFixture({
      hostFiber: fiberRef,
      duringDescribe: (call) => {
        if (call === 2) fiberRef.state = "unloading";
      },
    });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    expect(delivered).toBe(0);
  });

  it("withholds the scope when the scoped fiber is disposed during the first read", () => {
    const fixture = makeFixture({
      duringDescribe: (call) => {
        if (call === 2) fixture.dispose();
      },
    });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    expect(delivered).toBe(0);
  });

  it("does not deliver a scope after disposal even when the host still holds the listener (probe-only fixture shape)", () => {
    // 探针形态，不是宿主形态：真实宿主退订会摘掉监听器，disposed 的效果会被订阅拆除盖住，
    // 只有让监听器活下来才能单独观察 disposed 门禁本身。
    const fixture = makeFixture({ initiallyServed: false, retainSubscriptionOnDispose: true });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    fixture.dispose();
    expect(fixture.changes).toBe(2);
    fixture.setServed(true);
    expect(delivered).toBe(0);
  });

  it("does not deliver the scope while the owning fiber is still loading after the await", async () => {
    const fixture = makeFixture({ deferOwnerReady: true });
    let delivered = 0;
    fixture.install({ onScope: () => (delivered += 1) });
    fixture.resolveOwnerAwaitOnly();
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toBe(0);
    expect(fixture.order).toEqual(["setSource"]);
  });

  it("keeps the comparison baseline as a structured clone, not a JSON round trip", () => {
    // 值里放一个 JSON 表达不了的类型：只有 structuredClone 能原样留下它，
    // JSON 回落会把它降级成字符串，从而虚报一次变更。
    const fixture = makeFixture({ initialValue: { v: 1, at: new Date(0) } });
    fixture.install();
    expect(fixture.changes).toBe(1);
    fixture.setDescriptor({ ns: NAMESPACE, value: { v: 1, at: new Date(0) }, revision: 2 });
    fixture.emit(NAMESPACE, 2);
    expect(fixture.changes).toBe(1);
  });
});
