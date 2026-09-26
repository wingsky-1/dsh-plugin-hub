import { describe, expect, it } from "vitest";

import {
  installSettingsNamespace,
  warnLog,
  type SettingsFormsScope,
} from "../settings-namespace.js";

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
};

interface FixtureOptions {
  readonly fiberState?: string | number;
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
  readonly context: {
    fiber: { state: string | number; await(): Promise<void> };
    logger: { warn(message: unknown): void };
    on?: (event: string, listener: Listener, options?: { global?: boolean }) => unknown;
    inject(keys: string[], setup: Setup): () => void;
  };
  emit(eventNamespace: unknown, revision: unknown): void;
  install(hooks?: {
    readonly onScope?: (scope: Scope, service: unknown) => void;
    readonly onChange?: () => void;
  }): void;
  dispose(): void;
  setDescriptor(next: Record<string, unknown>): void;
  setServed(next: boolean, emitEvent?: boolean): void;
  resolveOwnerReady(): void;
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
  const ownerFiber = {
    state: initialFiberState(options),
    await: () => ownerReady,
  };
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

  const settings = {
    describe() {
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
      writes.push({ method: "update", namespace, payload, revision });
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
      writes.push({ method: "replace", namespace, payload, revision });
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
      writes.push({ method: "mutate", namespace, payload, revision });
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
    return () => listeners.delete(id);
  };
  const scoped = {
    settings,
    ...(options.includeOn === false ? {} : { on: options.scopedOn ?? defaultOn }),
    ...(options.includeEffect === false
      ? {}
      : {
          effect(setup: () => () => void) {
            effectDisposer = setup();
            return () => {};
          },
        }),
  };
  const context = {
    fiber: ownerFiber,
    logger: { warn: (message: unknown) => warnings.push(String(message)) },
    ...(options.contextOn === undefined ? {} : { on: options.contextOn }),
    inject(keys: string[], setup: Setup) {
      expect(keys).toEqual(["settings"]);
      setup(scoped);
      return () => {};
    },
  };

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
    resolveOwnerReady() {
      ownerFiber.state = "active";
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
      { method: "update", namespace: NAMESPACE, payload: { enabled: true }, revision: undefined },
      {
        method: "replace",
        namespace: NAMESPACE,
        payload: { position: "bottom-left" },
        revision: 7,
      },
      {
        method: "mutate",
        namespace: NAMESPACE,
        payload: [{ op: "set", path: ["enabled"], value: true }],
        revision: 8,
      },
      {
        method: "mutate",
        namespace: NAMESPACE,
        payload: [{ op: "unset", path: ["enabled"] }],
        revision: undefined,
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
    await expect(missing.scope.replace({ position: "left" })).rejects.toThrow(
      "settings service unavailable: replace 缺失",
    );

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
});
