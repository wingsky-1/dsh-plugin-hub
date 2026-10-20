/**
 * dsh-mcp-manager — integration：并发会话的目录隔离与连接所有权（#1137 判据 C01–C03）。
 *
 * 被测对象是**真实接缝**：`registerMiddlewareTools` 注册出的 ws_mcp_* 工具，经
 * `makeResolveRoot` 路由到各自会话的活动目录，再落到中间层单元表的 (root, server) 账本。
 * 远端执行夹具收到的是注册名 `mcp__<id>__<tool>`，按同一份 id 表还原到目标 root/server。
 *
 * 时序纪律：全部用 **deferred barrier** 精确控制交错（`deferred()` 双向握手），
 * 禁止固定 sleep 猜时序（DEVELOPMENT §5）。断言的是**调用目标与调用次数**，
 * 不是「没抛错」——每个 barrier 释放点都断言调用落到哪个 root 的哪个 server。
 *
 * 全部离线：假 loader 与假宿主动作面、真实 lifecycle/中间层接线、无子进程、无网络。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
const { installLifecycle, mountLedger, releaseLifecycle } =
  await import("../../src/server/servers/lifecycle/interface.ts");
const pipelineApi = await import("../../src/server/pipeline/interface.ts");
const { expandServerEnv } = await import("../../src/server/config/interface.ts");
const { OFFICIAL_MCP_CLIENT_SPECIFIER } = await import("../../src/server/shared/interface.ts");
const { makeResolveRoot } = await import("../../src/server/workspace/interface.ts");
const { publicToolName } = await import("../../src/server/shared/interface.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const {
  fakeLogsPort,
  fakeLoaderPort,
  fakeManagerCtx,
  fakeToolsService,
  installCompositionPorts,
  releaseCompositionPorts,
} = await import("../helpers.ts");

/** 假 id 表：按 (scope, name) 稳定分配注册 id（与既有 middleware/lifecycle 夹具同配方）。 */
function makeFixtureWorkspaceIds() {
  const byKey = new Map<string, string>();
  let seq = 0;
  return {
    idFor(scope: string, name: string) {
      const key = scope + "\u0000" + name;
      let id = byKey.get(key);
      if (id === undefined) {
        seq += 1;
        id = "id-" + seq;
        byKey.set(key, id);
      }
      return id;
    },
  };
}

/** 当前 fixture 的注册面视图：装载钩子按公开名派生规则注入 `tool` 的注册名。 */
let currentToolSchemas: Array<{ name: string; description?: string; parameters?: unknown }> = [];

// 组合根六张静态端口表在整个文件内只装一次（重复装会抛）。
// 生命周期域则每例重装：afterEach 的 releaseLifecycle() 会复位端口表。

let fixtureWorkspaceIds = makeFixtureWorkspaceIds();

beforeAll(() => {
  installCompositionPorts();
});

// releaseLifecycle() 同时复位生命周期端口表，故每个用例都要重新装配；
// 组合根六张静态端口表则整个文件只装一次，afterAll 统一释放。
beforeEach(() => {
  fixtureWorkspaceIds = makeFixtureWorkspaceIds();
  currentToolSchemas = [];
  const loader = fakeLoaderPort({
    modules: { [OFFICIAL_MCP_CLIENT_SPECIFIER]: { name: "test:official", apply: () => {} } },
  });
  const mount = loader.mount.bind(loader);
  loader.mount = (module: unknown, config: unknown) => {
    const id = String((config as { serverName?: unknown }).serverName ?? "");
    currentToolSchemas.push({
      name: publicToolName(id, "tool"),
      description: "concurrency fixture tool",
      parameters: { type: "object", properties: {} },
    });
    return mount(module, config);
  };
  installLifecycle({
    loader: loader as never,
    pipeline: { withTimeout: pipelineApi.withTimeout },
    workspace: fixtureWorkspaceIds,
    config: { expandServerEnv },
    tools: { schemas: () => currentToolSchemas } as never,
    logs: fakeLogsPort() as never,
  });
});

afterAll(() => {
  releaseCompositionPorts();
});

/** 双向握手 barrier：`entered` 在目标点 resolve，`release()` 放行被挂起的那一步。 */
interface Deferred {
  entered: Promise<void>;
  release: () => void;
  wait(): Promise<void>;
  readonly released: boolean;
}

function deferred(): Deferred {
  let release!: () => void;
  let released = false;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return {
    entered,
    release,
    get released() {
      return released;
    },
    // 供目标点调用：宣告到达后等待放行。
    async wait(): Promise<void> {
      markEntered();
      await gate;
    },
  };
}

/** 两个 root 下的同名 server/tool，用 marker 区分实际落点。 */
interface RootSpec {
  root: string;
  server: string;
  tool: string;
  marker: string;
}

/**
 * 夹具用的两个真实绝对路径 root（同名 server/tool，marker 不同）。
 *
 * 必须是**两段以上**的绝对路径：官方 `parseFullServerName` 对 `@<root>/<server>` 的
 * root 有 `slash <= 1` 的拒绝位（`@/srv` 这类单段 root 会被判非法），故 `/root-P`
 * 那种单段路径在真实路由里根本不成立——首跑就是在这里把 root 读成空串而挂死的。
 */
const P_ROOT = "/var/tmp/dsh-mcp-c/P";
const W_ROOT = "/var/tmp/dsh-mcp-c/W";

describe("#1137 C01–C03 并发目录隔离与连接所有权", () => {
  afterEach(async () => {
    releaseLifecycle();
    await mountLedger.flushDisposals();
  });

  /** 记录每次真实工具调用的落点与次数（判据是目标与次数，不是「没抛错」）。 */
  interface CallRecord {
    root: string;
    server: string;
    tool: string;
  }

  /**
   * 装一套最小组合根：两个会话（各自 session 对象 + 各自活动目录）、同名 server/tool、
   * 中间层单元表按 root 分开记账。
   *
   * 连接必须走**真实装载链**（lifecycle.mountServer → 假 loader）才能拿到 connected 的
   * ConnectionEntry：手塞的条目会被 `ensureConnected` 重新装载，随后 dispatch 读到
   * connecting 而拒。
   */
  async function fixture(specs: readonly RootSpec[], gates: Map<string, Deferred> = new Map()) {
    const calls: CallRecord[] = [];
    const store = new McpStore("/var/tmp/dsh-mcp-concurrency-global.json");
    store.data = { version: 1, servers: [] };
    const manager = new McpManager(fakeManagerCtx(), store);

    // 活动目录读取面：按 session 归属取该会话**当前**的活动目录。
    const activeBySession = new Map<unknown, string>();
    const activeDirectory = (session: unknown): string | undefined => activeBySession.get(session);

    const resolveRoot = makeResolveRoot(manager, activeDirectory);

    // 真中间层：ws_mcp_call 经 mw.callTool → dispatch.executeMcpCall（真实路由与禁用裁决）。
    // barrier 挂在**远端执行**这一步（官方执行器位置），而不是我方路由层——
    // 判据要证明的是「在飞调用不因目录切换改投」，挂高层会绕过真实执行路径。
    // 远端执行器收到的是注册名 `mcp__<id>__<tool>`，不是 `@<root>/<server>`：
    // 先用同一份 id 表把注册名还原成 spec，确保 barrier 与落点记录仍按真实目标判定。
    const targets = specs.map((spec) => ({
      spec,
      registeredName: publicToolName(fixtureWorkspaceIds.idFor(spec.root, spec.server), spec.tool),
    }));
    const fakeCtxTools = fakeToolsService({
      execute: async (input: unknown) => {
        const fullName = String((input as { name?: unknown }).name ?? "");
        const target = targets.find((entry) => entry.registeredName === fullName);
        if (target === undefined) throw new Error(`unexpected call target ${fullName}`);
        const spec = target.spec;
        const gate = gates.get(spec.root);
        if (gate !== undefined) await gate.wait();
        calls.push({ root: spec.root, server: spec.server, tool: spec.tool });
        return {
          isError: false,
          content: [{ type: "text", text: spec.marker }],
          value: { content: [{ type: "text", text: spec.marker }] },
        };
      },
    });
    const host = {
      ctx: { tools: fakeCtxTools },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async (root: string) =>
        specs
          .filter((spec) => spec.root === root)
          .map((spec) => ({
            name: spec.server,
            transport: "stdio",
            command: "noop",
            enabled: true,
          })),
      redactionServers: () => [],
      globalServers: () => [],
      normalizedProjectRoot: async (cwd: string | undefined) => cwd,
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: (root: string) =>
        `/var/tmp/dsh-mcp-concurrency-${root.replace(/\W/g, "_")}.json`,
    };
    fakeCtxTools.entries = currentToolSchemas;
    const mw = new McpMiddleware(host as never);
    // 真实装载链的 connected 前置：单元先由 projectUnitFor 建立（不触发惰性连接），
    // 再同步 ensureConnected 到完成。随后 dispatch 才能读到就绪的条目并转发。
    for (const spec of specs) {
      await mw.projectUnitFor(spec.root);
      await mw.ensureConnected(spec.root, spec.server);
      expect(mw.statusOf(spec.root, spec.server)).toBe("connected");
    }

    const defs: ToolDefinition[] = [];
    const ctx = {
      tools: {
        register: (definition: ToolDefinition) => {
          defs.push(definition);
          return () => {};
        },
      },
      on: () => () => {},
    };
    registerMiddlewareTools(ctx as unknown as Context, mw, resolveRoot, {
      disabledTools: new Map(),
    });

    const def = (name: string) => {
      const found = defs.find((entry) => entry.name === name);
      if (found === undefined) throw new Error(`tool ${name} not registered`);
      return found;
    };

    /** 造一个会话：session 对象与活动目录绑定，后续可改活动目录模拟切换。 */
    function session(initial: string) {
      const session_ = { id: Math.random().toString(36).slice(2) };
      activeBySession.set(session_, initial);
      return {
        session: session_,
        switchTo(next: string) {
          activeBySession.set(session_, next);
        },
      };
    }

    /** 以某会话身份执行 ws_mcp_call。 */
    async function call(as: ReturnType<typeof session>, server: string, tool: string) {
      return def("ws_mcp_call").execute(
        // server 必须是 `@<root>/<name>` 全名（dispatch 契约），这里按当前活动目录拼。
        { server: `@${activeBySession.get(as.session)}/${server}`, tool, arguments: "{}" },
        { agent: { session: as.session }, signal: new AbortController().signal } as never,
      );
    }

    return { calls, session, call, def, mw };
  }

  it("C01：两个会话各自的同名 server/tool 落自己的 root，互不见对方配置", async () => {
    const { calls, session, call } = await fixture([
      { root: P_ROOT, server: "srv", tool: "tool", marker: "P" },
      { root: W_ROOT, server: "srv", tool: "tool", marker: "W" },
    ]);
    const a = session(P_ROOT);
    const b = session(W_ROOT);

    const [resA, resB] = await Promise.all([call(a, "srv", "tool"), call(b, "srv", "tool")]);

    expect((resA as { content: { text: string }[] }).content[0].text).toBe("P");
    expect((resB as { content: { text: string }[] }).content[0].text).toBe("W");
    // 落点与次数：各一次，无重复、无串台。
    expect(calls.filter((c) => c.root === P_ROOT)).toHaveLength(1);
    expect(calls.filter((c) => c.root === W_ROOT)).toHaveLength(1);
  });

  it("C02：A 的 P 连接被 barrier 挂起 → A 切 W 并完成 W 调用 → 释放 P：W 状态不被 P 结果覆盖", async () => {
    const gateP = deferred();
    const gates = new Map([[P_ROOT, gateP]]);
    const { calls, session, call } = await fixture(
      [
        { root: P_ROOT, server: "srv", tool: "tool", marker: "P" },
        { root: W_ROOT, server: "srv", tool: "tool", marker: "W" },
      ],
      gates,
    );
    const a = session(P_ROOT);

    // A 的第一次调用在 P 被挂起（已抵达 barrier，未结算）。
    const pendingP = call(a, "srv", "tool");
    await gateP.entered;
    expect(gateP.released).toBe(false);
    expect(calls).toHaveLength(0); // 挂起期间不得有任何落点记账

    // A 切到 W 并完成一次 W 调用：这一调用**不得**被 P 的挂起结果影响。
    a.switchTo(W_ROOT);
    const resW = await call(a, "srv", "tool");
    expect((resW as { content: { text: string }[] }).content[0].text).toBe("W");
    expect(calls).toEqual([{ root: W_ROOT, server: "srv", tool: "tool" }]);

    // 释放 P：迟到的 P 结果落在 P，不得写进 W 的记账。
    gateP.release();
    await pendingP;
    expect(calls.filter((c) => c.root === P_ROOT)).toHaveLength(1);
    expect(calls.filter((c) => c.root === W_ROOT)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("C03：调用开始后切目录：先前调用在原 root 完成，新调用返新 root，不自动重试改投", async () => {
    const gateP = deferred();
    const { calls, session, call } = await fixture(
      [
        { root: P_ROOT, server: "srv", tool: "tool", marker: "P" },
        { root: W_ROOT, server: "srv", tool: "tool", marker: "W" },
      ],
      new Map([[P_ROOT, gateP]]),
    );
    const a = session(P_ROOT);

    // 第一次调用在 P 开始（barrier 挂起）。
    const first = call(a, "srv", "tool");
    await gateP.entered;

    // 会话切到 W：已在飞的调用**不**改投，新调用才用新 root。
    a.switchTo(W_ROOT);
    const second = await call(a, "srv", "tool");
    expect((second as { content: { text: string }[] }).content[0].text).toBe("W");

    gateP.release();
    const firstResult = await first;
    expect((firstResult as { content: { text: string }[] }).content[0].text).toBe("P");

    // 精确落点与次数：P 一次、W 一次；无「自动重试到另一 root」的第三条记录。
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.root === P_ROOT)).toHaveLength(1);
    expect(calls.filter((c) => c.root === W_ROOT)).toHaveLength(1);
  });
});
