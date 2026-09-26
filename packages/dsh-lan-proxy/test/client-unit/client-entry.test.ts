/**
 * dsh-lan-proxy — 客户端 row 配置入口的装配与生命周期判据。
 *
 * 本文件直连 src/client/index.ts，属于 client-unit：它验证 apply 的真实装配接线，
 * 而不是执行已经构建好的 bundle。这样 index.ts 的行为改动会进入 client 变异面。
 * test/client/client-style.test.ts 只保留 bundle 样式生命周期与 package 产物形态哨兵。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { apply, inject } from "../../src/client/index.ts";
import { LAN_PROXY_IDENTITY } from "../../src/shared/interface.ts";

type RowView = "summary" | "page";
type RowConfigRegister = (served: ReadonlySet<string>) => () => void;
type RowRender = (owner: { readonly view: RowView; readonly form?: unknown }) => unknown;

interface BehaviorEntry {
  readonly options: Record<string, unknown>;
  readonly render: RowRender;
  offCalls: number;
}

interface RenderedProps {
  readonly view: unknown;
  readonly form: unknown;
}

interface FakeContext {
  readonly remote: unknown;
  get(name: string): unknown;
  effect(execute: () => () => void, label?: string): unknown;
}

interface RowLifecycleObservation {
  readonly watchedNamespaces: readonly string[];
  readonly beforeServe: string[];
  readonly afterFirstServe: string[];
  readonly afterUnserved: string[];
  readonly afterReServed: string[];
  readonly afterTeardown: string[];
  readonly registrationsAfterFirstServe: Array<Record<string, unknown>>;
  readonly registrationsAfterReServed: Array<Record<string, unknown>>;
  readonly firstEntryOffCalls: number;
  readonly secondEntryOffCalls: number;
  readonly slotDisposerCalls: number[];
  readonly firstRegisterReturnedSlotDisposer: boolean;
  readonly secondRegisterReturnedSlotDisposer: boolean;
  readonly watchStopCallsAfterTeardown: number;
  readonly rendered: RenderedProps[];
  readonly injectedSlotNames: string[];
}

function propsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !("props" in value)) {
    throw new Error("row renderer did not return a React element");
  }
  const props = value.props;
  if (typeof props !== "object" || props === null) {
    throw new Error("React element props are not an object");
  }
  return props as Record<string, unknown>;
}

function makeRowLifecycleHarness(): RowLifecycleObservation {
  const entries: BehaviorEntry[] = [];
  const injectedSlotNames: string[] = [];
  const slotDisposers: Array<() => void> = [];
  const slotDisposerCalls: number[] = [];
  const rowRenders: RowRender[] = [];
  let watchedNamespaces: readonly string[] = [];
  let registerRowConfig: RowConfigRegister | null = null;
  let activeRegistrationOff: (() => void) | null = null;
  let watchStopCalls = 0;

  const stopActiveRegistration = (): void => {
    const off = activeRegistrationOff;
    activeRegistrationOff = null;
    off?.();
  };

  const slots = {
    inject(name: string, setup: () => () => void): () => void {
      injectedSlotNames.push(name);
      const registered = setup();
      const disposerCallIndex = slotDisposerCalls.length;
      slotDisposerCalls.push(0);
      const dispose = (): void => {
        slotDisposerCalls[disposerCallIndex] += 1;
        registered();
      };
      slotDisposers.push(dispose);
      return dispose;
    },
    register(options: Record<string, unknown>, render: RowRender): () => void {
      const entry: BehaviorEntry = { options: { ...options }, render, offCalls: 0 };
      entries.push(entry);
      rowRenders.push(render);
      return (): void => {
        entry.offCalls += 1;
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
      };
    },
  };

  const configForms = {
    whileServed(namespaces: readonly string[], register: RowConfigRegister): () => void {
      watchedNamespaces = [...namespaces];
      registerRowConfig = register;
      let stopped = false;
      return (): void => {
        if (stopped) return;
        stopped = true;
        watchStopCalls += 1;
        stopActiveRegistration();
      };
    },
    serve(served: readonly string[]): void {
      const watched = served.includes("dsh-lan-proxy");
      if (watched && activeRegistrationOff === null && registerRowConfig !== null) {
        activeRegistrationOff = registerRowConfig(new Set(served));
      } else if (!watched) {
        stopActiveRegistration();
      }
    },
  };

  const effectDisposers: Array<{ readonly label?: string; readonly dispose: () => void }> = [];
  let rowEffectDisposer: (() => void) | null = null;
  const ctx: FakeContext = {
    remote: { $host: { isLoopback: true } },
    get(name: string): unknown {
      if (name === "slots") return slots;
      if (name === "configForms") return configForms;
      if (name === "locale") return { register() {}, bind: () => () => "" };
      return undefined;
    },
    effect(execute: () => () => void, label?: string): unknown {
      const dispose = execute();
      effectDisposers.push({ label, dispose });
      if (label === "dsh-lan-proxy: row config page") rowEffectDisposer = dispose;
      return dispose;
    },
  };

  apply(ctx);

  const beforeServe = [...injectedSlotNames];
  configForms.serve(["dsh-lan-proxy"]);
  const firstEntry = entries[0];
  const afterFirstServe = entries.map((entry) => String(entry.options.name));
  const registrationsAfterFirstServe = entries.map((entry) => ({ ...entry.options }));
  const firstRegisterReturnedSlotDisposer = activeRegistrationOff === slotDisposers[0];
  const firstRender = rowRenders[0];
  if (firstRender === undefined) throw new Error("row renderer was not registered");
  const pageForm = { kind: "page-form" };
  const summaryProps = propsOf(firstRender({ view: "summary" }));
  const pageProps = propsOf(firstRender({ view: "page", form: pageForm }));
  const pageWithoutFormProps = propsOf(firstRender({ view: "page" }));
  const rendered: RenderedProps[] = [
    { view: summaryProps.view, form: summaryProps.form },
    { view: pageProps.view, form: pageProps.form },
    { view: pageWithoutFormProps.view, form: pageWithoutFormProps.form },
  ];

  configForms.serve([]);
  const afterUnserved = entries.map((entry) => String(entry.options.name));
  const firstEntryOffCalls = firstEntry?.offCalls ?? 0;

  configForms.serve(["dsh-lan-proxy"]);
  const secondEntry = entries[0];
  const afterReServed = entries.map((entry) => String(entry.options.name));
  const registrationsAfterReServed = entries.map((entry) => ({ ...entry.options }));
  const secondRegisterReturnedSlotDisposer = activeRegistrationOff === slotDisposers[1];

  const disposeRowEffect = rowEffectDisposer as (() => void) | null;
  disposeRowEffect?.();
  const afterTeardown = entries.map((entry) => String(entry.options.name));
  const secondEntryOffCalls = secondEntry?.offCalls ?? 0;

  for (const effect of effectDisposers.splice(0)) effect.dispose();
  const observation: RowLifecycleObservation = {
    watchedNamespaces,
    beforeServe,
    afterFirstServe,
    afterUnserved,
    afterReServed,
    afterTeardown,
    registrationsAfterFirstServe,
    registrationsAfterReServed,
    firstEntryOffCalls,
    secondEntryOffCalls,
    slotDisposerCalls: [...slotDisposerCalls],
    firstRegisterReturnedSlotDisposer,
    secondRegisterReturnedSlotDisposer,
    watchStopCallsAfterTeardown: watchStopCalls,
    rendered,
    injectedSlotNames: [...injectedSlotNames],
  };

  return observation;
}

let previousDocument: Document | undefined;

beforeEach(() => {
  previousDocument = globalThis.document;
  globalThis.document = {
    head: null,
    getElementById: () => null,
  } as unknown as Document;
});

afterEach(() => {
  if (previousDocument === undefined) {
    delete (globalThis as Record<string, unknown>).document;
  } else {
    globalThis.document = previousDocument;
  }
});

describe("client entry：row 配置装配", () => {
  it("namespace 未被服务时不留下 slot 页面痕迹", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.beforeServe).toEqual([]);
  });

  it("namespace 被服务后注册唯一的 plugins.row.config", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.afterFirstServe).toEqual(["plugins.row.config"]);
  });

  it("namespace 撤下后 slot ledger 变空", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.afterUnserved).toEqual([]);
  });

  it("namespace 重新服务后只恢复当前 row entry", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.afterReServed).toEqual(["plugins.row.config"]);
  });

  it("外层 teardown 后 slot ledger 变空", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.afterTeardown).toEqual([]);
  });

  it("两轮 served 周期各自重新注入 row slot", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.injectedSlotNames).toEqual(["plugins.row.config", "plugins.row.config"]);
  });

  it("whileServed 使用 canonical settings namespace", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.watchedNamespaces).toEqual(["dsh-lan-proxy"]);
  });

  it("row config 使用 bundle package 与 canonical row id 组成 key", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.registrationsAfterFirstServe).toEqual([
      {
        name: "plugins.row.config",
        key: "@wingsky-1/dsh-lan-proxy#dsh-lan-proxy",
        locale: "settings.lanProxy",
      },
    ]);
  });

  it("re-served 周期保持同一 row identity", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.registrationsAfterReServed).toEqual(
      observation.registrationsAfterFirstServe,
    );
  });

  it("whileServed register 回调交回每次 slot 注册 disposer", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.firstRegisterReturnedSlotDisposer).toBe(true);
    expect(observation.secondRegisterReturnedSlotDisposer).toBe(true);
  });

  it("unserved 与外层 teardown 各只调用对应 slot disposer 一次", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.slotDisposerCalls).toEqual([1, 1]);
  });

  it("unserved 与外层 teardown 各只调用对应 entry disposer 一次", () => {
    const observation = makeRowLifecycleHarness();

    expect([observation.firstEntryOffCalls, observation.secondEntryOffCalls]).toEqual([1, 1]);
  });

  it("页面 effect 卸载时停止 whileServed watch", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.watchStopCallsAfterTeardown).toBe(1);
  });

  it("index 按官方 optional form 语义把 summary/page view 传给 SettingsCard", () => {
    const observation = makeRowLifecycleHarness();

    expect(observation.rendered).toEqual([
      { view: "summary", form: undefined },
      { view: "page", form: { kind: "page-form" } },
      { view: "page", form: undefined },
    ]);
  });

  it("客户端 inject 精确声明当前服务依赖，不包含旧 slot", () => {
    expect(inject).toEqual(["slots", "configForms", "locale", "remote"]);
  });
});

interface PatchRow {
  readonly id: string;
  readonly name: string;
}

const EXPECTED_LAN_PROXY_PATCH_ROW: PatchRow = {
  id: "dsh-lan-proxy",
  name: "@wingsky-1/dsh-lan-proxy",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPatchRows(url: URL): PatchRow[] {
  const parsed: unknown = parse(readFileSync(url, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(`cordis patch 顶层必须是一条 insert 记录：${url.pathname}`);
  }
  const insert = parsed[0].insert;
  if (!Array.isArray(insert)) {
    throw new Error(`cordis patch 缺少 insert 数组：${url.pathname}`);
  }
  return insert.map((row: unknown, index: number) => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") {
      throw new Error(`cordis patch insert[${index}] 缺少字符串 id/name：${url.pathname}`);
    }
    return { id: row.id, name: row.name };
  });
}

describe("canonical identity：源码与 standalone/all patch", () => {
  it("canonical identity 保持固定 row id、bundle package 与派生 config key", () => {
    expect(LAN_PROXY_IDENTITY).toEqual({
      bundlePackage: "@wingsky-1/dsh-lan-proxy",
      rowId: "dsh-lan-proxy",
      settingsNamespace: "dsh-lan-proxy",
      rowConfigKey: "@wingsky-1/dsh-lan-proxy#dsh-lan-proxy",
    });
  });

  it("identity 字面量只在包内 identity 源定义，client 与 server settings 均引用该源", () => {
    const identitySource = readFileSync(
      new URL("../../src/shared/interface.ts", import.meta.url),
      "utf8",
    );
    const clientSource = readFileSync(
      new URL("../../src/client/index.ts", import.meta.url),
      "utf8",
    );
    const namespaceSource = readFileSync(
      new URL("../../src/server/config/impl/namespace.ts", import.meta.url),
      "utf8",
    );

    expect(identitySource.match(/"dsh-lan-proxy"/g)).toHaveLength(2);
    expect(identitySource).toContain("const LAN_PROXY_ROW_ID");
    expect(identitySource).toContain("const LAN_PROXY_SETTINGS_NAMESPACE");
    expect(identitySource.match(/"@wingsky-1\/dsh-lan-proxy"/g)).toHaveLength(1);
    expect(identitySource).toContain("${LAN_PROXY_BUNDLE_PACKAGE}#${LAN_PROXY_ROW_ID}");

    expect(clientSource).toContain('from "../shared/interface.ts"');
    expect(clientSource).toContain("LAN_PROXY_IDENTITY.settingsNamespace");
    expect(clientSource).toContain("LAN_PROXY_IDENTITY.rowConfigKey");
    expect(clientSource).not.toContain("const LAN_PROXY_ROW_ID");
    expect(clientSource).not.toContain("const LAN_PROXY_SETTINGS_NAMESPACE");

    expect(namespaceSource).toContain('from "../../../shared/interface.ts"');
    expect(namespaceSource).toContain(
      "export const SETTINGS_NS = LAN_PROXY_IDENTITY.settingsNamespace;",
    );
    expect(namespaceSource).not.toContain('"dsh-lan-proxy"');
  });

  it("standalone 与 dsh-plugins-all 聚合 patch 暴露同一 canonical row", () => {
    const standaloneRows = readPatchRows(new URL("../../cordis.patch.yml", import.meta.url));
    const aggregateRows = readPatchRows(
      new URL("../../../dsh-plugins-all/cordis.patch.yml", import.meta.url),
    );
    const canonicalPatchRow: PatchRow = {
      id: LAN_PROXY_IDENTITY.rowId,
      name: LAN_PROXY_IDENTITY.bundlePackage,
    };

    expect(canonicalPatchRow).toEqual(EXPECTED_LAN_PROXY_PATCH_ROW);
    expect(standaloneRows).toEqual([canonicalPatchRow]);
    expect(
      aggregateRows.filter(
        (row) => row.id === canonicalPatchRow.id || row.name === canonicalPatchRow.name,
      ),
    ).toEqual([canonicalPatchRow]);
  });
});
