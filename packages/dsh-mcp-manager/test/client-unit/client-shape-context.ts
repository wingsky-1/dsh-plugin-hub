/**
 * dsh-mcp-manager — client-unit：context-s2 的 fetch 假件恢复接缝。
 *
 * 保持原 vi.fn 手工赋值风格；只在 teardown 显式还原本文件替换的 globalThis.fetch。
 */
import { vi } from "vitest";

import { apply } from "../../src/client/index.ts";
import type { McpClientContext } from "../../src/client/core/state.ts";

export const realFetchRef: { current: typeof globalThis.fetch } = {
  current: globalThis.fetch,
};

export function okFetch(): void {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({}),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

type RowView = "summary" | "page";

type RowRegister = (served: ReadonlySet<string>) => () => void;

interface RowRegistration {
  item: Record<string, unknown>;
  render: (props: { view: RowView; form: unknown }) => unknown;
}

interface RowLifecycleHarness {
  watchedNamespaces: readonly string[];
  injectedSlots: readonly string[];
  ledger: readonly RowRegistration[];
  offCalls: () => number;
  watchStops: () => number;
  serve: (servedNamespaces: ReadonlySet<string>) => void;
  unserved: () => void;
  teardown: () => void;
}

/**
 * 用真实 apply 建立 row 生命周期；空 head 让样式 no-op，随后浮窗挂载在 DOM 面停止。
 * row effect 已在这两步之间建立，故夹具只观察装配与清理契约。
 */
export function bootRowLifecycle(): RowLifecycleHarness {
  const watchedNamespaces: string[] = [];
  const injectedSlots: string[] = [];
  const ledger: RowRegistration[] = [];
  const effectDisposers: (() => void)[] = [];
  let registerRow: RowRegister | undefined;
  let activeOff: (() => void) | undefined;
  let offCalls = 0;
  let watchStops = 0;

  const slots = {
    inject(name: string, setup: () => unknown): () => void {
      injectedSlots.push(name);
      const registered = setup();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        offCalls += 1;
        if (typeof registered === "function") registered();
      };
    },
    register(item: Record<string, unknown>, render: RowRegistration["render"]): () => void {
      const registration: RowRegistration = { item: { ...item }, render };
      ledger.push(registration);
      return () => {
        const index = ledger.indexOf(registration);
        if (index !== -1) ledger.splice(index, 1);
      };
    },
  };
  const unserved = (): void => {
    const off = activeOff;
    activeOff = undefined;
    off?.();
  };
  const configForms = {
    whileServed(namespaces: readonly string[], register: RowRegister): () => void {
      watchedNamespaces.push(...namespaces);
      registerRow = register;
      return () => {
        watchStops += 1;
        unserved();
      };
    },
  };
  const ctx = {
    get(name: string): unknown {
      if (name === "slots") return slots;
      if (name === "configForms") return configForms;
      return undefined;
    },
    effect(fn: () => () => void): () => void {
      const dispose = fn();
      effectDisposers.push(dispose);
      return dispose;
    },
    sessions: {},
  } as unknown as McpClientContext;

  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWarn = console.warn;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { head: null },
  });
  console.warn = () => {};
  try {
    apply(ctx);
  } finally {
    console.warn = previousWarn;
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", previousDocument);
  }

  return {
    watchedNamespaces,
    injectedSlots,
    ledger,
    offCalls: () => offCalls,
    watchStops: () => watchStops,
    serve: (servedNamespaces) => {
      if (registerRow === undefined) throw new Error("configForms did not capture row register");
      unserved();
      const intersects = [...servedNamespaces].some((namespace) =>
        watchedNamespaces.includes(namespace),
      );
      if (intersects) activeOff = registerRow(new Set(servedNamespaces));
    },
    unserved,
    teardown: () => {
      const dispose = effectDisposers[0];
      if (dispose === undefined) throw new Error("row registration was not held by ctx.effect");
      dispose();
    },
  };
}
