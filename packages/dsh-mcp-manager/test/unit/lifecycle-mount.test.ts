/**
 * dsh-mcp-manager servers/lifecycle 域（装载生命周期）**真装载**单测 —— 官方 Config 逐字段 / 装载链 / 失败面。
 *
 * 三块判据各自锚一个可改坏的点：
 * - Config 映射（设计 §2.1 的逐字段表）：stdio 与 streamable-http 的键集互斥、缺省项显式补齐、env /
 *   headers 经 config 域预展开且原配置对象不被改写；
 * - 装载链：id 经 workspace 端口按 (root, name) 取（scope 传 root）、包名经共享层常量交给 loader、
 *   装载进账本、等待窗口按**该 id 的**工具注册面前缀投影六态；
 * - 失败面：装载期异常不吞、同键重挂当场抛、窗口失败与晚到结算都不 dispose 实例（官方仍在后台退避）。
 *
 * 夹具是 `test/helpers.ts` 的 `fakeLoaderPort` 与本文件的 workspace / config / tools 假件：官方
 * loader 与官方 MCP 客户端都不在 catalog、仓库内不可解析，任何 import（含 import type）都会在 CI 上
 * 直接失败，故只按自持声明的结构形状造假件。全程禁止固定 sleep（见 test/helpers.ts 头部），等待一律
 * 用 pollUntil。
 */
import { afterEach, describe, expect, it } from "vitest";
import { expandServerEnv } from "../../src/server/config/impl/env/index.ts";
import type { ServerConfig } from "../../src/server/config/impl/model/type.ts";
import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  OFFICIAL_MCP_CLIENT_LOG_NAME,
  OFFICIAL_MCP_CLIENT_SPECIFIER,
} from "../../src/server/shared/interface.ts";
import type {
  LoaderPort,
  LogRecord,
  LogsPort,
  OfficialPluginModule,
} from "../../src/server/shared/interface.ts";
import type { ToolsRegistryPort, WorkspacePort } from "../../src/server/servers/lifecycle/deps.ts";
import { mountLedger } from "../../src/server/servers/lifecycle/impl/ledger/index.ts";
import {
  mountServer,
  officialMcpConfig,
} from "../../src/server/servers/lifecycle/impl/mount/index.ts";
import {
  installLifecycle,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";
import type { ServerState } from "../../src/shared/interface.ts";
import { fakeLoaderPort, fakeLogsPort, pollUntil } from "../helpers.ts";

/** 被测的官方插件模块面：apply 由官方引擎调，本域只把它当不透明模块转交。 */
const OFFICIAL_MODULE: OfficialPluginModule = { name: "test:official", apply: () => {} };

/** 官方客户端落在宿主日志面上的记录：装载窗口的错因只有这一条通道（成功连接零日志）。 */
function officialRecord(...args: unknown[]): LogRecord {
  return { name: OFFICIAL_MCP_CLIENT_LOG_NAME, type: "error", level: 1, args };
}

/** 被测配置：最小 stdio 形态（归一化的产物长这样，缺省项已由 normalizeServer 补齐或由本块补）。 */
const STDIO_SERVER: ServerConfig = { name: "files", transport: "stdio", command: "/bin/echo" };

/** 宿主注册面里的一条 tool schema：映射探针只需要 `name`，其余字段取最小形状。 */
interface FakeSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function toolSchema(name: string): FakeSchema {
  return { name, description: "", parameters: {} };
}

/** 假 id 表：按 (scope, name) 稳定返回并记下调用现场，复刻 workspace 域的实例字段语义。 */
function fakeIdTable(idFactory: () => string = () => "idfix") {
  const calls: Array<[string, string]> = [];
  const byKey = new Map<string, string>();
  return {
    calls,
    idFor(scope: string, name: string): string {
      calls.push([scope, name]);
      const key = scope + "\u0000" + name;
      const assigned = byKey.get(key);
      if (assigned !== undefined) return assigned;
      const id = idFactory();
      byKey.set(key, id);
      return id;
    },
  };
}

/** 假工具注册表：`schemas()` 每次现读同一份数组，测试用 `entries` 模拟注册 / 注销。 */
function fakeTools(entries: FakeSchema[] = []) {
  let calls = 0;
  return {
    entries,
    get schemaCalls() {
      return calls;
    },
    schemas() {
      calls += 1;
      return entries;
    },
  };
}

/** 已装配的假件观测面：断言落在调用现场（id 表入参、loader 调用序列、展开入参）。 */
interface Harness {
  readonly loader: ReturnType<typeof fakeLoaderPort>;
  readonly workspace: ReturnType<typeof fakeIdTable>;
  readonly tools: ReturnType<typeof fakeTools>;
  readonly logs: ReturnType<typeof fakeLogsPort>;
  readonly expandCalls: readonly ServerConfig[];
}

/**
 * 装配本域：id / 展开 / 工具面三样用本文件假件，超时用真 withTimeout（窗口的被测对象是句柄等待本身）。
 *
 * 假件经 `as unknown as` 收窄：helpers.ts 是结构形状夹具（S6 起带类型标注），ready 为
 * `Promise<unknown>`、logs 面 handler 取 `unknown` 记录，均与端口声明不相容；夹具的真实形状
 * 由集成探针按 `bindHost` 交付面单独验。
 */
function installHarness(
  options: {
    ready?: "immediate" | "deferred" | "never";
    idFactory?: () => string;
    entries?: FakeSchema[];
    modules?: Record<string, unknown>;
  } = {},
): Harness {
  const loader = fakeLoaderPort({
    ready: options.ready ?? "immediate",
    modules: options.modules ?? { [OFFICIAL_MCP_CLIENT_SPECIFIER]: OFFICIAL_MODULE },
  });
  const workspace = fakeIdTable(options.idFactory);
  const tools = fakeTools(options.entries ?? []);
  const logs = fakeLogsPort();
  const expandCalls: ServerConfig[] = [];
  installLifecycle({
    loader: loader as unknown as LoaderPort,
    pipeline: { withTimeout },
    workspace: workspace as unknown as WorkspacePort,
    config: {
      // 记录展开入参：模板展开只许发生在交官方之前一次，入参必须是**未展开**的原配置。
      expandServerEnv: (server: ServerConfig) => {
        expandCalls.push(server);
        return expandServerEnv(server);
      },
    },
    tools: tools as unknown as ToolsRegistryPort,
    // 结构形状假件（可观测的 captured/emit）：按本文件既有接缝收窄为端口面。
    logs: logs as unknown as LogsPort,
  });
  return { loader, workspace, tools, logs, expandCalls };
}

// 账本是模块级单例：不复位会让「同键重挂」连坐后续用例。
afterEach(async () => {
  releaseLifecycle();
  await mountLedger.flushDisposals();
});

describe("官方 Config 映射（设计 §2.1 逐字段表）", () => {
  it("stdio：逐字段落位且缺省项显式补齐，键集里不夹带 streamable-http 字段", () => {
    const config = officialMcpConfig(STDIO_SERVER, "id1", expandServerEnv);

    expect(config).toEqual({
      transport: "stdio",
      serverName: "id1",
      command: "/bin/echo",
      args: [],
      env: {},
      cwd: "",
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      reconnect: {},
      failOnStartupError: false,
    });
  });

  it("streamable-http：只带 url 与 headers，键集里不夹带 stdio 字段", () => {
    const server: ServerConfig = {
      name: "remote",
      transport: "streamable-http",
      url: "https://example.test/mcp",
    };

    expect(officialMcpConfig(server, "id2", expandServerEnv)).toEqual({
      transport: "streamable-http",
      serverName: "id2",
      url: "https://example.test/mcp",
      headers: {},
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      reconnect: {},
      failOnStartupError: false,
    });
  });

  it("显式值原样透传：args / cwd / toolCallTimeoutMs / reconnect 不被缺省覆盖，也不被合并", () => {
    const server: ServerConfig = {
      ...STDIO_SERVER,
      args: ["srv.js", "--flag"],
      cwd: "/tmp/work",
      toolCallTimeoutMs: 1234,
      reconnect: { enabled: false },
    };

    expect(officialMcpConfig(server, "id3", expandServerEnv)).toMatchObject({
      args: ["srv.js", "--flag"],
      cwd: "/tmp/work",
      toolCallTimeoutMs: 1234,
      reconnect: { enabled: false },
    });
  });

  it("env / headers 经 config 域预展开成字面量，原配置对象仍是模板（凭据面不变量）", () => {
    process.env.ITEST_MCP_TOKEN = "s3cr3t";
    process.env.ITEST_MCP_AUTH = "Bearer abc";
    try {
      const stdio: ServerConfig = {
        ...STDIO_SERVER,
        env: { TOKEN: "${ITEST_MCP_TOKEN}", MISSING: "${ITEST_MCP_ABSENT}" },
      };
      const http: ServerConfig = {
        name: "remote",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        headers: { Authorization: "${ITEST_MCP_AUTH}" },
      };

      expect(officialMcpConfig(stdio, "id4", expandServerEnv)).toMatchObject({
        env: { TOKEN: "s3cr3t", MISSING: "" },
      });
      expect(officialMcpConfig(http, "id5", expandServerEnv)).toMatchObject({
        headers: { Authorization: "Bearer abc" },
      });
      // 展开的结果不得写回原对象：写盘路径拿到的必须是模板，否则明文凭据随 store.save 落盘。
      expect(stdio.env).toEqual({ TOKEN: "${ITEST_MCP_TOKEN}", MISSING: "${ITEST_MCP_ABSENT}" });
    } finally {
      delete process.env.ITEST_MCP_TOKEN;
      delete process.env.ITEST_MCP_AUTH;
    }
  });

  it("两种 transport 各自的必填字段缺失时拒绝装载，判词点名 transport", () => {
    expect(() =>
      officialMcpConfig({ name: "s", transport: "stdio" }, "id6", expandServerEnv),
    ).toThrow(/stdio 服务器缺 command/);
    expect(() =>
      officialMcpConfig({ name: "h", transport: "streamable-http" }, "id7", expandServerEnv),
    ).toThrow(/streamable-http 服务器缺 url/);
  });
});

describe("装载链", () => {
  it("id 经 workspace 端口按 (root, name) 取、scope 传 root；包名与 Config 原样交给 loader", async () => {
    const harness = installHarness({
      idFactory: () => "idseed",
      entries: [toolSchema("mcp__idseed__ping")],
    });
    const states: ServerState[] = [];

    const result = await mountServer({
      root: "/proj/a",
      server: STDIO_SERVER,
      onState: (state) => states.push(state),
    });

    expect(harness.workspace.calls).toEqual([["/proj/a", "files"]]);
    expect(result.id).toBe("idseed");
    expect(harness.loader.calls[0]).toEqual(["load", OFFICIAL_MCP_CLIENT_SPECIFIER]);
    // 假件把 `load` 内部的 `import` 也记一笔，故装载落在第 3 格；次序本身是判据（解析先于挂载）。
    expect(harness.loader.calls[2]).toEqual([
      "mount",
      OFFICIAL_MODULE,
      {
        transport: "stdio",
        serverName: "idseed",
        command: "/bin/echo",
        args: [],
        env: {},
        cwd: "",
        toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
        reconnect: {},
        failOnStartupError: false,
      },
    ]);
    expect(mountLedger.get("idseed")).toBe(result.entry);
    // 成功路径的判据是「ready 结算 + 该 id 前缀下有注册工具」，两个状态各回调一次。
    expect(result.outcome).toEqual({ kind: "settled", state: "connected" });
    expect(states).toEqual(["connecting", "connected"]);
    // 展开入参是原始配置（模板形态），展开只发生在交给官方之前一次。
    expect(harness.expandCalls).toEqual([STDIO_SERVER]);
    expect(harness.tools.schemaCalls).toBeGreaterThan(0);
    expect(result.entry.handle.disposed).toBe(false);
  });

  it("工具面前缀按 id 而不是服务器名：同名的 mcp__files__ 工具不算该实例已注册", async () => {
    installHarness({ idFactory: () => "idseed", entries: [toolSchema("mcp__files__ping")] });
    const states: ServerState[] = [];

    const result = await mountServer({
      root: "/proj/a",
      server: STDIO_SERVER,
      onState: (state) => states.push(state),
    });

    expect(result.outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (result.outcome.kind === "settled") {
      expect(result.outcome.error).toMatch(/官方发现预算/);
    }
    expect(states).toEqual(["connecting", "failed"]);
  });

  it("装载链把展开后的 env 交给官方实例（模板不落到装载配置上）", async () => {
    process.env.ITEST_MCP_TOKEN = "chain-secret";
    try {
      const harness = installHarness({ entries: [toolSchema("mcp__idfix__ping")] });

      await mountServer({
        root: "/proj/a",
        server: { ...STDIO_SERVER, env: { TOKEN: "${ITEST_MCP_TOKEN}" } },
        onState: () => {},
      });

      const mounted = harness.loader.calls[2] as [string, unknown, { env: Record<string, string> }];
      expect(mounted[2].env).toEqual({ TOKEN: "chain-secret" });
    } finally {
      delete process.env.ITEST_MCP_TOKEN;
    }
  });

  it("ready 永不结算 → 我方连接预算耗尽 failed，实例保留（官方仍在退避重连）", async () => {
    const harness = installHarness({ ready: "never" });
    const states: ServerState[] = [];

    const result = await mountServer({
      root: "/proj/a",
      server: STDIO_SERVER,
      connectTimeoutMs: 25,
      onState: (state) => states.push(state),
    });

    expect(result.outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (result.outcome.kind === "settled") {
      expect(result.outcome.error).toMatch(/连接超时（25ms）/);
    }
    expect(states).toEqual(["connecting", "failed"]);
    expect(harness.loader.handles[0].state.disposeCalls).toBe(0);
    expect(result.entry.handle.disposed).toBe(false);
  });

  it("窗口内官方发了归属本实例的失败日志 → failed 文案附上官方原文", async () => {
    const harness = installHarness({ ready: "deferred", idFactory: () => "idseed" });
    const states: ServerState[] = [];

    const pending = mountServer({
      root: "/proj/a",
      server: STDIO_SERVER,
      onState: (state) => states.push(state),
    });
    await pollUntil("装载窗口挂上日志导出器", () => harness.logs.captured === 1);
    harness.logs.emit(
      officialRecord(`${OFFICIAL_MCP_CLIENT_LOG_NAME}(idseed): spawn /bin/echo ENOENT`),
    );
    harness.loader.settleReady();

    const result = await pending;
    expect(result.outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (result.outcome.kind === "settled") {
      expect(result.outcome.error).toMatch(/spawn \/bin\/echo ENOENT/);
      expect(result.outcome.error).toMatch(/官方日志/);
    }
    expect(states).toEqual(["connecting", "failed"]);
    // 窗口结束即摘除：失败的实例不得继续占着宿主日志面。
    expect(harness.logs.captured).toBe(0);
  });

  it("别的 id 的官方日志不进 error：归属按全等前缀（另一个 id 是本 id 的前缀也不误收）", async () => {
    const harness = installHarness({ ready: "deferred", idFactory: () => "idseed" });

    const pending = mountServer({
      root: "/proj/a",
      server: STDIO_SERVER,
      onState: () => {},
    });
    await pollUntil("装载窗口挂上日志导出器", () => harness.logs.captured === 1);
    harness.logs.emit(officialRecord(`${OFFICIAL_MCP_CLIENT_LOG_NAME}(idsee): 别的实例的连接失败`));
    harness.loader.settleReady();

    const result = await pending;
    expect(result.outcome).toMatchObject({ kind: "settled", state: "failed" });
    if (result.outcome.kind === "settled") {
      expect(result.outcome.error).not.toMatch(/别的实例的连接失败/);
      expect(result.outcome.error).not.toMatch(/官方日志/);
    }
  });

  it("晚到结算守卫：窗口期间账本条目被拆 → discarded，不再改状态也不 dispose 第二遍", async () => {
    const harness = installHarness({ ready: "deferred", idFactory: () => "idseed" });
    const states: ServerState[] = [];

    const pending = mountServer({
      root: "/proj/a",
      server: STDIO_SERVER,
      onState: (state) => states.push(state),
    });
    await pollUntil("窗口起步投影 connecting", () => states.length > 0);

    const disposal = mountLedger.dispose("idseed");
    harness.loader.settleReady();

    await expect(pending).resolves.toMatchObject({ outcome: { kind: "discarded" } });
    expect(states).toEqual(["connecting"]);
    await disposal;
    expect(harness.loader.handles[0].state.disposeCalls).toBe(1);
  });
});

describe("装载失败面", () => {
  it("同 (root, name) 再装载：账本已持有该 id，当场抛而不等官方 already in use", async () => {
    installHarness({ idFactory: () => "idseed", entries: [toolSchema("mcp__idseed__ping")] });
    await mountServer({ root: "/proj/a", server: STDIO_SERVER, onState: () => {} });

    await expect(
      mountServer({ root: "/proj/a", server: STDIO_SERVER, onState: () => {} }),
    ).rejects.toThrow(/账本已有键 idseed/);
  });

  it("装载期异常不吞：官方模块解析失败时上抛，且账本不留残条", async () => {
    installHarness({ modules: {} });

    await expect(
      mountServer({ root: "/proj/a", server: STDIO_SERVER, onState: () => {} }),
    ).rejects.toThrow(/未登记的包名/);
    expect(mountLedger.size).toBe(0);
  });
});
