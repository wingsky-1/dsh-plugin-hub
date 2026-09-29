/**
 * dsh-mcp-manager servers/lifecycle 域（装载生命周期）单测 —— 账本 / 六态投影 / 等待窗口。
 *
 * 三块判据各自锚一个可改坏的点：
 * - 账本：键由调用方给、同键重入当场抛（不等官方那句 already in use）、release 后账本空且
 *   dispose 全部结算；
 * - 六态投影：§3.1 的六条投影规则逐态，含 reconnecting 的**可判时点**（曾 connected + 允许
 *   重连 + 工具前缀消失）与 disabled 的配置面优先级；
 * - 等待窗口：ready 的 immediate / never / deferred 三种时序（假 LoaderPort 提供），外加
 *   晚到结算守卫（dispose 后 ready 才 settle、条目已被替换两种丢弃形态）。
 *
 * 夹具是 `test/helpers.ts` 的 `fakeLoaderPort`：官方 loader 与官方 MCP 客户端都不在 catalog、
 * 仓库内不可解析，任何 import（含 import type）都会在 CI 上失败，故只按自持声明的结构形状造假件。
 * 全程禁止固定 sleep（本文件头部的防 flake 纪律，见 test/helpers.ts），等待一律用 pollUntil。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LoaderPort, OfficialPluginModule } from "../../src/server/shared/interface.ts";
import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";
import { mountLedger } from "../../src/server/servers/lifecycle/impl/ledger/index.ts";
import { projectServerState } from "../../src/server/servers/lifecycle/impl/state/index.ts";
import type { ServerStateInput } from "../../src/server/servers/lifecycle/impl/state/index.ts";
import { awaitMountWindow } from "../../src/server/servers/lifecycle/impl/timeout/index.ts";
import {
  installLifecycle,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";
import type { ServerState } from "../../src/shared/interface.ts";
import { fakeLoaderPort, pollUntil } from "../helpers.ts";

/** 被测的官方插件模块面：apply 由官方引擎调，本域只把它当不透明模块转交。 */
const OFFICIAL_MODULE: OfficialPluginModule = { name: "test:official", apply: () => {} };

/**
 * 装配本域：loader 用假件，pipeline 用真 withTimeout（窗口的被测对象在句柄等待本身）。
 *
 * 假件要经 `as unknown as LoaderPort` 收窄：helpers.ts 是结构形状夹具（S6 起带类型标注），其
 * ready 为 `Promise<unknown>`（deferred/never/immediate 三支的并集），与 `Promise<void>` 不相容，
 * 而这不是本片要修的问题——夹具的真实形状由集成探针按 `bindHost` 交付面单独验。
 */
function install(loader: LoaderPort): void {
  installLifecycle({
    loader,
    pipeline: { withTimeout },
    // 本文件只测账本 / 六态投影 / 等待窗口三块，装配仍须给全键集（注入面对账要求严格相等）。
    // 这四样是惰性假件：真装载链的字段映射、注册面探测与官方日志收集归 unit-lifecycle-mount。
    workspace: { idFor: () => "srv" },
    config: { expandServerEnv: (server) => server },
    tools: { schemas: () => [] },
    logs: { capture: () => () => {} },
  });
}

/** 构造一个已装配的假 LoaderPort 并挂一条账本条目。 */
function mountOne(key: string, ready: "immediate" | "deferred" | "never") {
  const loader = fakeLoaderPort({ ready });
  install(loader as unknown as LoaderPort);
  const entry = mountLedger.mount(key, OFFICIAL_MODULE, { command: "/bin/true" });
  return { loader, entry };
}

afterEach(async () => {
  releaseLifecycle();
  await mountLedger.flushDisposals();
});

describe("装载账本", () => {
  it("mount 记账并发起装载：键、条目、size 与 loader.mount 实参全部可核", () => {
    const { loader, entry } = mountOne("srv-a", "immediate");

    expect(entry.key).toBe("srv-a");
    expect(entry.config).toEqual({ command: "/bin/true" });
    expect(mountLedger.get("srv-a")).toBe(entry);
    expect(mountLedger.isCurrent(entry)).toBe(true);
    expect(mountLedger.size).toBe(1);
    expect(loader.calls).toEqual([["mount", OFFICIAL_MODULE, { command: "/bin/true" }]]);
  });

  it("同一键未释放前再 mount 当场抛错，判词点名键，且账本不被写坏", () => {
    const { loader } = mountOne("srv-a", "immediate");

    expect(() => mountLedger.mount("srv-a", OFFICIAL_MODULE, {})).toThrow(/账本已有键 srv-a/);
    expect(mountLedger.size).toBe(1);
    expect(loader.handles).toHaveLength(1);
  });

  it("未知键的 get 为空、dispose 是幂等空操作", async () => {
    mountOne("srv-a", "immediate");

    expect(mountLedger.get("srv-missing")).toBeUndefined();
    await expect(mountLedger.dispose("srv-missing")).resolves.toBeUndefined();
  });

  it("dispose(key) 先摘账再等句柄结算：摘账后 isCurrent 立刻为假", async () => {
    const { loader, entry } = mountOne("srv-a", "immediate");

    const disposal = mountLedger.dispose("srv-a");
    expect(mountLedger.size).toBe(0);
    expect(mountLedger.get("srv-a")).toBeUndefined();
    expect(mountLedger.isCurrent(entry)).toBe(false);
    await disposal;

    expect(loader.handles[0].state.disposed).toBe(true);
    expect(loader.handles[0].state.disposeCalls).toBe(1);
  });

  it("release() 清空账本并逐条发起 dispose；flushDisposals() 等全部结算且不重复释放", async () => {
    const loader = fakeLoaderPort({ ready: "immediate" });
    install(loader as unknown as LoaderPort);
    mountLedger.mount("srv-a", OFFICIAL_MODULE, {});
    mountLedger.mount("srv-b", OFFICIAL_MODULE, {});

    mountLedger.release();
    expect(mountLedger.size).toBe(0);
    await mountLedger.flushDisposals();

    expect(loader.handles.map((handle) => handle.state.disposeCalls)).toEqual([1, 1]);
    await mountLedger.flushDisposals();
    expect(loader.handles.map((handle) => handle.state.disposeCalls)).toEqual([1, 1]);
  });

  it("flushDisposals() 把 dispose 的失败如实上抛（不静默吞掉泄漏）", async () => {
    const loader = fakeLoaderPort({ ready: "immediate", disposeThrows: true });
    install(loader as unknown as LoaderPort);
    mountLedger.mount("srv-a", OFFICIAL_MODULE, {});

    mountLedger.release();
    await expect(mountLedger.flushDisposals()).rejects.toThrow(/dispose 失败/);
  });
});

/** 投影输入基线：已发起 mount、ready 未结算、工具面为空、允许重连的运行态。 */
function projectionInput(overrides: Partial<ServerStateInput> = {}): ServerStateInput {
  return {
    enabled: true,
    userDisabled: false,
    tornDown: false,
    mountStarted: true,
    readySettled: false,
    windowExpired: false,
    disposed: false,
    everConnected: false,
    reconnectEnabled: true,
    hasTools: () => false,
    ...overrides,
  };
}

describe("六态投影", () => {
  it("connecting：发起 mount 到 ready settle / 我方超时之间", () => {
    expect(projectServerState("srv", projectionInput())).toBe("connecting");
  });

  it("connected：ready 已 settle 且该 id 前缀下有注册工具（查询收到的是本 id）", () => {
    const queried: string[] = [];
    const state = projectServerState(
      "srv-a",
      projectionInput({
        readySettled: true,
        hasTools: (id) => {
          queried.push(id);
          return id === "srv-a";
        },
      }),
    );

    expect(state).toBe("connected");
    expect(queried).toEqual(["srv-a"]);
  });

  it("failed ①：我方连接等待窗口耗尽（ready 未 settle）", () => {
    expect(projectServerState("srv", projectionInput({ windowExpired: true }))).toBe("failed");
  });

  it("failed ②：ready 已 settle 但工具前缀为空（首连 / 首次发现失败，官方已进后台重连）", () => {
    expect(projectServerState("srv", projectionInput({ readySettled: true }))).toBe("failed");
  });

  it("reconnecting：可判时点——曾 connected、允许重连、此刻工具前缀为空", () => {
    const state = projectServerState(
      "srv",
      projectionInput({ readySettled: true, everConnected: true, reconnectEnabled: true }),
    );

    expect(state).toBe("reconnecting");
  });

  it("failed ③：曾 connected 但 reconnect.enabled === false 时工具消失直接失败", () => {
    const state = projectServerState(
      "srv",
      projectionInput({ readySettled: true, everConnected: true, reconnectEnabled: false }),
    );

    expect(state).toBe("failed");
  });

  it("stopped：我方已发起拆除，或句柄已 dispose；未发起 mount 也投影 stopped", () => {
    expect(projectServerState("srv", projectionInput({ tornDown: true }))).toBe("stopped");
    expect(projectServerState("srv", projectionInput({ disposed: true }))).toBe("stopped");
    expect(projectServerState("srv", projectionInput({ mountStarted: false }))).toBe("stopped");
  });

  it("disabled：配置面禁用优先于一切链路信号（含工具面已有注册）", () => {
    expect(
      projectServerState(
        "srv",
        projectionInput({ enabled: false, readySettled: true, hasTools: () => true }),
      ),
    ).toBe("disabled");
    expect(projectServerState("srv", projectionInput({ userDisabled: true }))).toBe("disabled");
    expect(projectServerState("srv", projectionInput({ enabled: false, tornDown: true }))).toBe(
      "disabled",
    );
  });
});

describe("装载等待窗口", () => {
  /** 连接预算取远大于测试内部等待的值：只有 ready 真不结算的用例才让它到期。 */
  const CONNECT_MS = 60;

  // 本条刻意不传 connectTimeoutMs：ready 立刻结算，走的是预算缺省（共享层 CONNECT_TIMEOUT_MS）
  // 那条支路，顺手把「缺省预算可用」也钉住。
  it("immediate：ready 结算且工具面立刻出现 → connected", async () => {
    const { entry } = mountOne("srv-fast", "immediate");
    const states: ServerState[] = [];

    const outcome = await awaitMountWindow({
      id: "srv-fast",
      handle: entry.handle,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: (id) => id === "srv-fast",
      onState: (state) => states.push(state),
    });

    expect(outcome).toEqual({ kind: "settled", state: "connected" });
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("never：连接预算耗尽 → failed 且文案点名毫秒数，实例保留不 dispose（官方仍在退避）", async () => {
    const { loader, entry } = mountOne("srv-stuck", "never");

    const outcome = await awaitMountWindow({
      id: "srv-stuck",
      handle: entry.handle,
      connectTimeoutMs: CONNECT_MS,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: () => false,
      onState: () => {},
    });

    expect(outcome).toEqual({
      kind: "settled",
      state: "failed",
      error: expect.stringMatching(new RegExp("连接超时（" + CONNECT_MS + "ms）")),
    });
    expect(entry.handle.disposed).toBe(false);
    expect(loader.handles[0].state.disposeCalls).toBe(0);
  });

  it("ready settle 但工具面为空 → failed ②，文案点名官方发现预算", async () => {
    const { entry } = mountOne("srv-notools", "immediate");

    const outcome = await awaitMountWindow({
      id: "srv-notools",
      handle: entry.handle,
      connectTimeoutMs: CONNECT_MS,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: () => false,
      onState: () => {},
    });

    expect(outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (outcome.kind === "settled") expect(outcome.error).toMatch(/官方发现预算 10000ms/);
  });

  it("超时结算把窗口内的官方原文接进 error（官方是本插件唯一的错因来源）", async () => {
    const { entry } = mountOne("srv-stuck-log", "never");

    const outcome = await awaitMountWindow({
      id: "srv-stuck-log",
      handle: entry.handle,
      connectTimeoutMs: CONNECT_MS,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: () => false,
      diagnostics: () => ["spawn /bin/echo ENOENT"],
      onState: () => {},
    });

    expect(outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (outcome.kind === "settled") {
      expect(outcome.error).toMatch(/连接超时/);
      expect(outcome.error).toMatch(/官方日志：spawn \/bin\/echo ENOENT/);
    }
  });

  it("官方一条都没说时不接空字段：error 里不出现「官方日志」", async () => {
    const { entry } = mountOne("srv-silent", "immediate");

    const outcome = await awaitMountWindow({
      id: "srv-silent",
      handle: entry.handle,
      connectTimeoutMs: CONNECT_MS,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: () => false,
      diagnostics: () => ["  ", ""],
      onState: () => {},
    });

    expect(outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (outcome.kind === "settled") expect(outcome.error).not.toMatch(/官方日志/);
  });

  it("deferred：settle 前投影 connecting，settleReady() 之后转 connected", async () => {
    const { loader, entry } = mountOne("srv-slow", "deferred");
    const states: ServerState[] = [];

    const pending = awaitMountWindow({
      id: "srv-slow",
      handle: entry.handle,
      connectTimeoutMs: 5_000,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: () => true,
      onState: (state) => states.push(state),
    });
    await pollUntil("窗口起步投影 connecting", () => states.length > 0);
    expect(states).toEqual(["connecting"]);

    loader.settleReady();
    await expect(pending).resolves.toEqual({ kind: "settled", state: "connected" });
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("晚到结算守卫：dispose 之后 ready 才 settle → discarded，不再改状态", async () => {
    const { loader, entry } = mountOne("srv-late", "deferred");
    const states: ServerState[] = [];

    const pending = awaitMountWindow({
      id: "srv-late",
      handle: entry.handle,
      connectTimeoutMs: 5_000,
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: () => true,
      onState: (state) => states.push(state),
    });
    await pollUntil("窗口起步投影 connecting", () => states.length > 0);

    const disposal = mountLedger.dispose("srv-late");
    loader.settleReady();

    await expect(pending).resolves.toEqual({ kind: "discarded" });
    expect(states).toEqual(["connecting"]);
    await disposal;
  });

  it("晚到结算守卫：账本条目已被更新的代际替换 → discarded，且不点亮 connecting", async () => {
    const { entry } = mountOne("srv-replaced", "immediate");
    const states: ServerState[] = [];

    const outcome = await awaitMountWindow({
      id: "srv-replaced",
      handle: entry.handle,
      connectTimeoutMs: CONNECT_MS,
      isCurrent: () => false,
      hasTools: () => true,
      onState: (state) => states.push(state),
    });

    expect(outcome).toEqual({ kind: "discarded" });
    // 窗口根本没跑（该代际在起点就已被顶替），故一个状态都不发：发 connecting 会留下
    // 「亮了却永不结算」的假状态（之后所有出口都是 discarded，不再回调）。
    expect(states).toEqual([]);
  });

  it("晚到结算守卫：句柄在窗口开始前已 dispose → discarded，且不点亮 connecting", async () => {
    const { entry } = mountOne("srv-dead", "immediate");
    const states: ServerState[] = [];
    await entry.handle.dispose();

    const outcome = await awaitMountWindow({
      id: "srv-dead",
      handle: entry.handle,
      connectTimeoutMs: CONNECT_MS,
      isCurrent: () => true,
      hasTools: () => true,
      onState: (state) => states.push(state),
    });

    expect(outcome).toEqual({ kind: "discarded" });
    expect(states).toEqual([]);
  });
});
