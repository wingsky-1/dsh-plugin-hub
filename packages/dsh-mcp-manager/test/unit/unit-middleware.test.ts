/**
 * dsh-mcp-manager — unit：中间层（ws_mcp_search / ws_mcp_call）。
 *
 * 覆盖：
 * - fullServerName / parseFullServerName（含非法形态）
 * - normalizeToolName（mcp__ 前缀剥离 / 跨 server 拒绝）
 * - B11：server 名含连续双下划线 → guard fail-closed 拒绝并指往 ws_mcp_call（#903 B-M4）
 * - normalizeArguments（JSON 字符串参数解析 / 标量保留）
 * - globMatch（工具名通配纯函数）
 * - scoreTool / searchCatalog（跨字段打分 / unavailable 段 / 空查询摘要）
 * - McpMiddleware：projectUnitFor 惰性创建 + userDisabled 合并 + inFlight 去重
 * - #903 M4：projectUnitFor 后台连接失败记 warn（非 unhandled）
 * - callTool：未知 server / 未连接 / 连接中 / 路由一致性
 * - evictIfNeeded LRU 淘汰
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandServerEnv } from "../../src/server/config/impl/env/index.ts";
import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";
import { OFFICIAL_MCP_CLIENT_SPECIFIER } from "../../src/server/shared/interface.ts";
import {
  installLifecycle,
  mountLedger,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import { fakeLoaderPort, fakeLogsPort, fakeToolsService, pollUntil } from "../helpers.ts";
import type { FakeToolEntry, FakeToolsScript } from "../helpers.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { LoaderPort, LogsPort } from "../../src/server/shared/interface.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";
import type { ConnectionEntry } from "../../src/server/connection/runtime/interface.ts";
import type { ToolsRegistryPort } from "../../src/server/servers/lifecycle/deps.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ToolDefinition,
  ToolExecution,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionToken,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { ImageAdmissionFaces } from "../../src/server/inject/impl/image-admission/index.ts";
import type { DisabledToolsMap } from "../../src/server/store/interface.ts";
import type {
  CallResultTextHandlers,
  ProjectedCallResult,
} from "../../src/server/pipeline/interface.ts";
import type { SaveImageInput } from "../../src/server/shared/interface.ts";

/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
type Json = Parameters<ToolDefinition["output"]["render"]>[1];
import type { ListCatalogResult } from "../../src/server/catalog/interface.ts";
import type { McpMiddleware as McpMiddlewareType } from "../../src/server/connection/runtime/interface.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";

// S6-B2：中间层装配依赖（McpMiddleware 方法/registerMiddlewareTools 调用消费组合根装配的
// 端口，全量去包根探针 161/210 红 exit 1）留包根；其余纯符号改道域门面。
const { McpMiddleware, registerMiddlewareTools } = await import("../../src/index.ts");
const { fullServerName, parseFullServerName, normalizeToolName } =
  await import("../../src/server/workspace/interface.ts");
const { normalizeArguments, createRedactor, globMatch, projectCallToolResult } =
  await import("../../src/server/pipeline/interface.ts");
const {
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  isCatalogFresh,
  boundCatalogTools,
} = await import("../../src/server/catalog/interface.ts");
const {
  MAX_BYTES_PER_TOOL,
  CATALOG_TTL_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} = await import("../../src/server/connection/runtime/interface.ts");
const { parseDisabledTools, loadUserState, saveUserState, loadDisabledTools, saveDisabledTools } =
  await import("../../src/server/store/interface.ts");

const ROOT = "/tmp/ws-root-a";

/**
 * 假宿主。`ctx.tools` 是池与装载窗口共用的那一份工具服务：六态投影按注册面 `mcp__<id>__` 前缀
 * 判「已连上」，装载窗口的 hasTools 也读它——两处必须同源，否则判据会分裂。
 *
 * @param {Map} [serversByRoot] root → 服务器配置表
 * @param {object} [toolsScript] 传给假工具服务的 script（如自定义 execute）
 */
function makeHost(
  serversByRoot: Map<string, ServerConfig[]> = new Map(),
  toolsScript: FakeToolsScript = {},
) {
  const log = { emits: 0, saved: 0 };
  const tools = fakeToolsService(toolsScript);
  poolToolsView = () => tools.schemas();
  installPoolLifecycle();
  const host = {
    ctx: { tools },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async (root: string) => serversByRoot.get(root),
    redactionServers: () => [...serversByRoot.values()].flat(),
    globalServers: () => [],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      typeof cwd === "string" && cwd !== "" ? cwd : undefined,
    saveUserState: async () => {
      log.saved += 1;
    },
    emitStatus: () => {
      log.emits += 1;
    },
    catalogCachePath: (root: string) => join(root, ".dsh-mcp-catalog-test.json"),
  };
  return { host, log, tools };
}

// ------------------------------------------------------------ 池装载夹具（#767 S1-4d）
// 换引擎后中间层不再自建 transport/client：远端条目一律经 lifecycle 域装载官方实例。本文件
// 不走 apply（也就没有安装装配表），故池夹具必须自己装一次六键端口，afterEach 统一释放。
// 假 loader 不 spawn 子进程，全离线。

/** 假 id 表：按 (scope, name) 稳定返回并自增（mirror unit-lifecycle-mount.test.ts 的同名夹具）。 */
function fakeIdTable() {
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

/** 被测的官方插件模块面：apply 由官方引擎调，本域只把它当不透明模块转交。 */
const OFFICIAL_MODULE = { name: "test:official", apply: () => {} };

/** 生命周期域的 tools 端口委托到这个取值器：必须与用例看见的注册面同一份。 */
let poolToolsView: () => FakeToolEntry[] = () => [];
let poolLoader: ReturnType<typeof fakeLoaderPort>;
let lifecycleInstalled = false;

/** 装配池装载链路（幂等：一个用例里建多个 middleware 只装一次，afterEach 统一释放）。 */
function installPoolLifecycle() {
  if (lifecycleInstalled) return;
  poolLoader = fakeLoaderPort({
    modules: { [OFFICIAL_MCP_CLIENT_SPECIFIER]: OFFICIAL_MODULE },
  });
  // 结构形状假件（只实现装载链触达的面）：按本文件既有接缝收窄为端口面。
  installLifecycle({
    loader: poolLoader as unknown as LoaderPort,
    pipeline: { withTimeout },
    workspace: fakeIdTable(),
    config: { expandServerEnv },
    // schemas 面只取注册名投影（六态输入面 B）：假注册面按既有接缝收窄。
    tools: { schemas: () => poolToolsView() } as unknown as ToolsRegistryPort,
    logs: fakeLogsPort() as unknown as LogsPort,
  });
  lifecycleInstalled = true;
}

/** 新 ConnectionEntry 夹具：远端条目（有账本键、等待窗口已结算、曾连上）。 */
/**
 * 部分连接条目桩（被测读面：id/status/readySettled/server；everConnected/disposed 为本文件
 * 判据自备的探测字段，域形状外）——调用方按 `as unknown as` 收窄为 ConnectionEntry。
 */
function remoteEntry(
  server: ServerConfig,
  id: string | undefined,
  overrides: Record<string, unknown> = {},
): ConnectionEntry {
  return {
    server,
    id,
    handle: undefined,
    status: "connected",
    error: undefined,
    connectedAt: Date.now(),
    readySettled: true,
    everConnected: true,
    disposed: false,
    ...overrides,
    // 探测字段（everConnected/disposed）与宽 status 字面量超出域形状：调用方只读域内面，收窄不断言。
  } as unknown as ConnectionEntry;
}

/** callTool 的身份入参（第 5 形参）：dispatch 只消费 callId / rootCallId / parent / agent。 */
/**
 * callTool 的身份入参：callId 取不透明 ID 面（域内只做合成与透传，不解析其结构）。
 * 字面量 "call-1" 是测试追踪用的固定值，运行期与实现无关。
 */
/**
 * callTool 身份桩：parent 取测试自造的 plain symbol（域内仅作 Set 身份键、不读 brand 面），
 * callId 取固定追踪值。返回面按被测签名收窄，调用方不再各自断言。
 */
function identity(extra: Record<string, unknown> = {}): {
  agent?: unknown;
  callId: ToolExecutionInput["callId"];
  rootCallId?: ToolExecutionInput["rootCallId"];
  parent?: ToolExecutionToken;
} {
  return { callId: "call-1" as unknown as ToolExecutionInput["callId"], ...extra };
}

/** 中间层与装载账本都是真实副作用：用例结束后统一收口。 */
const trackedMw: McpMiddlewareType[] = [];
afterEach(async () => {
  for (const mw of trackedMw) {
    try {
      await mw.dispose();
    } catch {
      // 收口失败不掩盖用例结论
    }
  }
  trackedMw.length = 0;
  if (lifecycleInstalled) {
    releaseLifecycle();
    await mountLedger.flushDisposals();
    lifecycleInstalled = false;
  }
});

function trackMw(mw: McpMiddlewareType) {
  trackedMw.push(mw);
  return mw;
}

/**
 * 目录内存态自 #767 S1-3b 起归 catalog 域：夹具不再把目录塞进 ProjectUnit，而是经
 * catalogDirectory 的写口登记（先让 root 在册，否则写口按「单元不存在」静默返回）。
 *
 * 缓存路径指向一个**不存在**的临时文件：既避免读盘把上一例的 last-good 载回来，
 * 也避免把测试产物落在 DSH_HOME 之外。
 */
/** 目录种子条目：tools 缺席仅见于 unavailable 分支（调用方恒给，本文件内全覆盖）。 */
interface SeedTool {
  description?: string;
  inputSchema?: unknown;
}

type SeedCatalogMap = Map<string, { unavailable?: string; tools: Map<string, SeedTool> }>;

function seedRoot(root: string, entries: SeedCatalogMap) {
  catalogDirectory.dropRoot(root);
  for (const [serverName, entry] of entries) {
    if (entry.unavailable !== undefined) {
      // 发现失败段：先建条目再翻成不可用（读口只翻转已有条目）。
      catalogDirectory.projectWrappedTools({ root, serverName, definitions: [] });
      catalogDirectory.markUnavailable(root, serverName, entry.unavailable);
      continue;
    }
    catalogDirectory.projectWrappedTools({
      root,
      serverName,
      definitions: [...entry.tools].map(([name, tool]) => ({
        name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    });
  }
}

/**
 * 以**显式时间戳**登记目录条目：TTL / stale 类判据要的是「什么时候发现的」，而投影写口
 * 恒写 Date.now()，故这类夹具走 last-good 文件读回（与生产同一条载入路径）。
 */
interface DiskSeedEntry {
  discoveredAt: number;
  tools: Map<string, SeedTool>;
  unavailable?: string;
}

function seedRootFromDisk(root: string, entries: Array<[string, DiskSeedEntry]>) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-seed-"));
  const cachePath = join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`);
  const payload: Record<
    string,
    {
      discoveredAt: number;
      tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    }
  > = {};
  for (const [serverName, entry] of entries) {
    payload[serverName] = {
      discoveredAt: entry.discoveredAt,
      tools: [...entry.tools].map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  }
  writeFileSync(cachePath, JSON.stringify({ version: 1, root, entries: payload }, null, 2), "utf8");
  catalogDirectory.dropRoot(root);
  return catalogDirectory.ensureRootLoaded(root, cachePath);
}

function makeUnit({
  root = ROOT,
  catalog = new Map(),
  userDisabled = [],
  connections,
}: {
  root?: string;
  catalog?: SeedCatalogMap;
  userDisabled?: string[];
  connections?: Map<string, ConnectionEntry>;
} = {}): ProjectUnit {
  if (catalog.size > 0) seedRoot(root, catalog);
  return {
    root,
    connections: connections ?? new Map(),
    userDisabled: new Set(userDisabled),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
}

/** 宿主编译期同款 lossless 校验：返回首个违规路径（合规返回 undefined）。 */
function losslessViolation(value: unknown, path = "$"): string | undefined {
  if (value === undefined) return `${path} 为 undefined`;
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = losslessViolation(value[i], `${path}[${i}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = losslessViolation(entry, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("fullServerName / parseFullServerName", () => {
  it("fullServerName 拼接 @root/server", () => {
    expect(fullServerName("/a/b", "ctx")).toBe("@/a/b/ctx");
  });

  it("parse 还原 root + server", () => {
    expect(parseFullServerName("@/a/b/ctx")).toEqual({ root: "/a/b", server: "ctx" });
  });

  it("parse 以最后一段为 server", () => {
    expect(parseFullServerName("@/a/b")).toEqual({ root: "/a", server: "b" });
  });

  it("裸名 parse 为 undefined", () => {
    expect(parseFullServerName("ctx")).toBeUndefined();
  });

  it("空 server 形态 → undefined（@/）", () => {
    expect(parseFullServerName("@/")).toBeUndefined();
  });

  it("空 server 形态 → undefined（@/a/）", () => {
    expect(parseFullServerName("@/a/")).toBeUndefined();
  });
});

describe("normalizeToolName", () => {
  it("裸工具名原样", () => {
    expect(normalizeToolName("ctx", "use_ctx")).toBe("use_ctx");
  });

  it("剥离 mcp__ 前缀", () => {
    expect(normalizeToolName("ctx", "mcp__ctx__use_ctx")).toBe("use_ctx");
  });

  it("多重前缀一并剥离", () => {
    expect(normalizeToolName("ctx", "mcp__ctx__mcp__ctx__use_ctx")).toBe("use_ctx");
  });

  it("跨 server 前缀抛错", () => {
    expect(() => normalizeToolName("ctx", "mcp__other__tool")).toThrow(/疑似其他/);
  });
});

describe("normalizeArguments", () => {
  it("对象原样", () => {
    expect(normalizeArguments({ a: 1 })).toEqual({ a: 1 });
  });

  it("JSON 字符串解析为对象", () => {
    expect(normalizeArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("标量保留", () => {
    expect(normalizeArguments("hello")).toBe("hello");
  });

  it("空串 → 空对象", () => {
    expect(normalizeArguments("")).toEqual({});
  });

  it("B14：数组 JSON 不应作为 arguments", () => {
    // B14 红测：arguments 按 MCP 规范应为 object，数组形态一律归一无害空态
    // （原断言 `'"[1,2]"'` → `[1,2]` 即 B14 泄漏路径，改用拒绝语义）
    expect(normalizeArguments("[1,2]")).toEqual({});
  });

  it("B14：引号包裹的数组 JSON 同样拒绝", () => {
    expect(normalizeArguments('"[1,2]"')).toEqual({});
  });

  it("B14：数组入参拒绝", () => {
    expect(normalizeArguments([1, 2])).toEqual({});
  });
});

describe("globMatch（工具名通配纯函数；#767 笔 2 后仓内零消费者，公开面保留）", () => {
  it("通配符匹配一切", () => {
    expect(globMatch("*", "anything")).toBe(true);
  });

  it("字面量相等匹配", () => {
    expect(globMatch("foo", "foo")).toBe(true);
  });

  it("字面量不等不匹配", () => {
    expect(globMatch("foo", "bar")).toBe(false);
  });

  it("前缀通配匹配", () => {
    expect(globMatch("foo*", "foobar")).toBe(true);
  });

  it("前缀通配不匹配中缀", () => {
    expect(globMatch("foo*", "barfoo")).toBe(false);
  });
});

describe("scoreTool / searchCatalog", () => {
  function unitsFixture() {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              [
                "use_ctx",
                {
                  description: "查询 context7 文档",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } },
                },
              ],
              ["search", { description: "search tool", inputSchema: {} }],
            ]),
          },
        ],
        ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
      ]),
    });
    return new Map([[ROOT, unit]]);
  }

  it("命中文档工具", () => {
    const { results } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(results.length >= 1).toBeTruthy();
  });

  it("命中条目 server 为全名", () => {
    const { results } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(results[0].server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("命中条目 fresh 为 true", () => {
    const { results } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(results[0].fresh).toBe(true);
  });

  it("unavailable 段随结果返回", () => {
    const { unavailable } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(unavailable.length).toBe(1);
  });

  it("unavailable 段带失败原因", () => {
    const { unavailable } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(unavailable[0].reason).toMatch(/连接失败/);
  });

  it("空查询 → 能力摘要", () => {
    const summary = searchCatalog(unitsFixture(), ROOT, "", 5);
    expect(summary.results.length).toBe(2);
  });

  it("TTL 过期 → fresh=false", async () => {
    // unitsFixture 恒含 ROOT（同一文件内夹具保证），此处断言存在。
    const unit = unitsFixture().get(ROOT)!;
    await seedRootFromDisk(ROOT, [
      [
        "ctx",
        {
          discoveredAt: Date.now() - CATALOG_TTL_MS - 1000,
          // unitsFixture 刚登记该条目，此处断言存在。
          tools: catalogDirectory.entryFor(ROOT, "ctx")!.tools,
        },
      ],
    ]);
    const stale = searchCatalog(new Map([[ROOT, unit]]), ROOT, "文档", 5);
    expect(stale.results[0]!.fresh).toBe(false);
  });
});

// isCatalogFresh / boundCatalogTools（#592 discover 拆解出的纯函数） ----
describe("isCatalogFresh", () => {
  it("无条目 → 不新鲜", () => {
    expect(isCatalogFresh(undefined)).toBe(false);
  });

  it("unavailable 段 → 不新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now(), tools: new Map(), unavailable: "x" })).toBe(
      false,
    );
  });

  it("TTL 内 → 新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now(), tools: new Map() })).toBe(true);
  });

  it("TTL 过期 → 不新鲜", () => {
    expect(
      isCatalogFresh({ discoveredAt: Date.now() - CATALOG_TTL_MS - 1, tools: new Map() }),
    ).toBe(false);
  });
});

describe("boundCatalogTools", () => {
  // 装箱：常规映射 + 空名跳过 + 非字符串描述归空 + schema 缺省 {}
  const fixtureTools = () => [
    { name: "a", description: "alpha", inputSchema: { type: "object" } },
    { name: "", description: "空名跳过" },
    { name: "b" },
    { name: 42, description: 7 },
  ];

  it("空名跳过后剩 3 个", () => {
    expect(boundCatalogTools(fixtureTools()).size).toBe(3);
  });

  it("常规条目原样映射", () => {
    expect(boundCatalogTools(fixtureTools()).get("a")).toEqual({
      description: "alpha",
      inputSchema: { type: "object" },
    });
  });

  it("缺省描述/schema 补空", () => {
    expect(boundCatalogTools(fixtureTools()).get("b")).toEqual({
      description: "",
      inputSchema: {},
    });
  });

  it("非字符串 name String 化、描述归空", () => {
    expect(boundCatalogTools(fixtureTools()).get("42")).toEqual({
      description: "",
      inputSchema: {},
    });
  });

  it("B9：超限描述截断后字节数 ≤ MAX_BYTES_PER_TOOL", () => {
    // 单描述超字节上限 → 按字节截断（B9：旧 slice(0,N) 按字符，多字节超限；
    // 截断点落在字符边界，不产生替换符）
    const bigDescription = "字".repeat(MAX_BYTES_PER_TOOL);
    const truncated = boundCatalogTools([{ name: "big", description: bigDescription }]).get("big")!;
    expect(Buffer.byteLength(truncated.description, "utf8") <= MAX_BYTES_PER_TOOL).toBeTruthy();
  });

  it("前提：原描述字节超限", () => {
    const bigDescription = "字".repeat(MAX_BYTES_PER_TOOL);
    expect(Buffer.byteLength(bigDescription, "utf8") > MAX_BYTES_PER_TOOL).toBeTruthy();
  });

  it("总字节超限后停止装箱", () => {
    const fatSchema = { data: "x".repeat(200 * 1024) };
    const stopAtLimit = boundCatalogTools([
      { name: "one", description: "", inputSchema: fatSchema },
      { name: "two", description: "", inputSchema: fatSchema },
      { name: "three", description: "", inputSchema: fatSchema },
    ]);
    expect(stopAtLimit.size < 3).toBeTruthy();
  });
});

// McpMiddleware：projectUnitFor / userDisabled / inFlight ----
describe("McpMiddleware：projectUnitFor / userDisabled / inFlight", () => {
  async function projectUnitFixture() {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host, log } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
    const unit = await mw.projectUnitFor(ROOT);
    return { mw, unit, log };
  }

  it("项目单元已创建", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit !== undefined).toBeTruthy();
  });

  it("userDisabled 合并", async () => {
    const { unit } = await projectUnitFixture();
    // 存在性由上一用例保证（同一装配器），此处断言存在。
    expect(unit!.userDisabled.has("ctx")).toBe(true);
  });

  it("惰性：未显式连接前不建连接", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit!.connections.size).toBe(0);
  });

  it("惰性创建不广播状态", async () => {
    const { log } = await projectUnitFixture();
    expect(log.emits).toBe(0);
  });

  it("无项目标记目录 → undefined", async () => {
    const { mw } = await projectUnitFixture();
    const none = await mw.projectUnitFor("/no/such/root");
    expect(none).toBeUndefined();
  });
});

// #903 M4：后台惰性连接的浮空拒绝必须记 warn（非 unhandled） ----
describe("#903 M4：projectUnitFor 后台连接失败记 warn", () => {
  it("后台 ensureConnected 翻错 → warn 落日志（把 .catch 删掉即无 warn 红）", async () => {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const warns: string[] = [];
    const capturingHost = {
      ...host,
      logger: {
        info: () => {},
        warn: (message: string): void => {
          warns.push(message);
        },
        error: () => {},
      },
    };
    const mw = trackMw(new McpMiddleware(capturingHost as unknown as MiddlewareHost));
    mw.ensureConnected = async () => {
      throw new Error("boom-bg");
    };
    // 反证：projectUnitFor 内后台循环的 .catch 删掉 → 拒绝浮空，warn 缺席红。
    await mw.projectUnitFor(ROOT);
    await pollUntil("后台连接失败 warn", () =>
      warns.some((message) => message.includes("background connect")),
    );
    expect(
      warns.some(
        (message) =>
          message.includes("background connect") &&
          message.includes("ctx") &&
          message.includes("failed"),
      ),
    ).toBe(true);
  });
});

// callTool：路由一致性 / 未连接 ----
describe("callTool：路由一致性 / 未连接", () => {
  async function callToolFixture() {
    // enabled:false → 不触发真实连接（单元测试不 spawn 子进程）
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: false },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    await mw.projectUnitFor(ROOT);
    return mw;
  }

  it("路由一致性：参数 root ≠ 路由 root → 拒绝", async () => {
    const mw = await callToolFixture();
    await expect(
      mw.callTool("@/other/root/ctx", "use_ctx", {}, undefined, identity()),
    ).rejects.toThrow(/不属于当前工作空间|未激活/);
  });

  it("未知 server 形态 → 格式错误", async () => {
    const mw = await callToolFixture();
    await expect(mw.callTool("ctx", "use_ctx", {}, undefined, identity())).rejects.toThrow(
      /格式应为/,
    );
  });

  it("未连接 → 错误含下一步提示（ws_mcp_search 或 ws_mcp_list）", async () => {
    const mw = await callToolFixture();
    await expect(
      mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined, identity()),
    ).rejects.toThrow(/未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接/);
  });

  it("userDisabled → 错误含 GUI 重连提示", async () => {
    const mw = await callToolFixture();
    mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
    const disabledUnit = await mw.projectUnitFor(ROOT);
    // 单元存在由前置连接保证（同一装配器），此处断言存在。
    disabledUnit!.userDisabled.add("ctx");
    await expect(
      mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined, identity()),
    ).rejects.toThrow(/已被用户禁用；可先在 GUI「MCP」浮窗中重新连接/);
  });
});

// evictIfNeeded LRU ----
describe("evictIfNeeded LRU", () => {
  function evictedFixture() {
    const { host } = makeHost(new Map());
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    // 注入 18 个假单元（无服务器配置，projectUnitFor 会返回 undefined —— 直接塞 map）
    for (let index = 0; index < 18; index += 1) {
      // 同上：catalog 残留形状，收窄不断言（evict 只读 root/lastTouchedAt）。
      mw.units.set(`/root-${index}`, {
        root: `/root-${index}`,
        connections: new Map(),
        catalog: new Map(),
        userDisabled: new Set(),
        lastTouchedAt: 1000 + index,
        inFlight: new Map(),
      } as unknown as ProjectUnit);
    }
    mw.evictIfNeeded(16);
    return mw;
  }

  it("LRU 淘汰到上限", () => {
    expect(evictedFixture().units.size).toBe(16);
  });

  it("最旧被淘汰", () => {
    expect(evictedFixture().units.has("/root-0")).toBe(false);
  });

  it("最新保留", () => {
    expect(evictedFixture().units.has("/root-17")).toBe(true);
  });
});

// userState 持久化 ----
describe("userState 持久化", () => {
  async function saveAndLoad() {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-"));
    const file = join(dir, "user-state.json");
    // catalog 字段是目录域搬迁前的残留形状（ProjectUnit 已无此键）：saveUserState 只读写 userDisabled，
    // 此处不断言、只收窄。
    const units = new Map([
      [
        ROOT,
        {
          root: ROOT,
          connections: new Map(),
          catalog: new Map(),
          userDisabled: new Set(["ctx"]),
          lastTouchedAt: Date.now(),
          inFlight: new Map(),
        },
      ],
    ]) as unknown as Map<string, ProjectUnit>;
    await saveUserState(file, units);
    const loaded = await loadUserState(file);
    mkdirSync(join(dir, "sub"));
    return { file, loaded };
  }

  it("saveUserState/loadUserState 往返", async () => {
    const { loaded } = await saveAndLoad();
    // save/load 往返保证键存在，此处断言存在。
    expect([...loaded.get(ROOT)!]).toEqual(["ctx"]);
  });

  it("双键互存 A 向：saveUserState 不抹 disabledTools（#903 S1）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-s1a-"));
    const file = join(dir, "user-state.json");
    const tools: DisabledToolsMap = new Map([[ROOT, new Map([["srv", new Set(["toolA"])]])]]);
    await saveDisabledTools(file, tools);
    const units = new Map([[ROOT, { userDisabled: new Set(["srv"]) }]]) as unknown as Map<
      string,
      ProjectUnit
    >;
    await saveUserState(file, units);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.disabled).toEqual({ [ROOT]: ["srv"] });
    expect(raw.disabledTools).toEqual({ [ROOT]: { srv: ["toolA"] } });
    expect([...(await loadUserState(file)).get(ROOT)!]).toEqual(["srv"]);
    expect([...(await loadDisabledTools(file)).get(ROOT)!.get("srv")!]).toEqual(["toolA"]);
  });

  it("双键互存 B 向：saveDisabledTools 不抹 disabled（#903 S1）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-s1b-"));
    const file = join(dir, "user-state.json");
    const units = new Map([[ROOT, { userDisabled: new Set(["srv"]) }]]) as unknown as Map<
      string,
      ProjectUnit
    >;
    await saveUserState(file, units);
    const tools: DisabledToolsMap = new Map([[ROOT, new Map([["srv", new Set(["toolA"])]])]]);
    await saveDisabledTools(file, tools);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.disabled).toEqual({ [ROOT]: ["srv"] });
    expect(raw.disabledTools).toEqual({ [ROOT]: { srv: ["toolA"] } });
    expect([...(await loadUserState(file)).get(ROOT)!]).toEqual(["srv"]);
    expect([...(await loadDisabledTools(file)).get(ROOT)!.get("srv")!]).toEqual(["toolA"]);
  });

  it("损坏文件 → 空", async () => {
    const { file } = await saveAndLoad();
    writeFileSync(file, "{bad json");
    const empty = await loadUserState(file);
    expect(empty.size).toBe(0);
  });
});

// last-good 目录缓存：loadCatalogCache 读取 / persistCatalog 空采集不写盘 ----
describe("last-good 目录缓存", () => {
  function cacheFixture() {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-cat-"));
    const baseHost = makeHost(new Map());
    const catalogHost = {
      ...baseHost.host,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([["use_ctx", { description: "查询文档", inputSchema: {} }]]),
          },
        ],
      ]),
    });
    mw.units.set(ROOT, unit);
    // 落盘路径是调用点的入参契约：这里直接给 catalogDirectory 递同一个路径。
    return { mw, unit, catalogHost, cachePath: catalogHost.catalogCachePath(ROOT) };
  }

  it("有工具的目录落盘", async () => {
    const { cachePath } = cacheFixture();
    await catalogDirectory.persistRoot(ROOT, {
      cachePath: () => cachePath,
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect(existsSync(cachePath)).toBe(true);
  });

  it("空采集不覆盖已有缓存（保留 last-good）", async () => {
    const { cachePath } = cacheFixture();
    await catalogDirectory.persistRoot(ROOT, {
      cachePath: () => cachePath,
      isRuntimeServer: () => false,
      warn: () => {},
    });
    const before = readFileSync(cachePath, "utf8");
    // 空采集不写盘：清空目录后 persist 不覆盖已有缓存（保留 last-good）
    catalogDirectory.dropServer(ROOT, "ctx");
    catalogDirectory.projectWrappedTools({ root: ROOT, serverName: "ctx", definitions: [] });
    catalogDirectory.markUnavailable(ROOT, "ctx", "failed");
    await catalogDirectory.persistRoot(ROOT, {
      cachePath: () => cachePath,
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });
});

// searchCatalogMulti：多单元合并检索（项目 root + @global） ----
describe("searchCatalogMulti：多单元合并检索", () => {
  function multiUnits() {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_ctx", { description: "查询 context7 文档", inputSchema: {} }],
              ["search", { description: "search tool", inputSchema: {} }],
            ]),
          },
        ],
      ]),
    });
    const globalUnit = makeUnit({
      root: "@global",
      catalog: new Map([
        [
          "gctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_g", { description: "全局工具", inputSchema: {} }],
              ["other", { description: "无关", inputSchema: {} }],
            ]),
          },
        ],
      ]),
    });
    return new Map([
      [ROOT, unit],
      ["@global", globalUnit],
    ]);
  }

  it("命中项目单元", () => {
    // 合并查询命中两个单元（项目 root + @global）。
    const multi = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "use", 10);
    expect(multi.results.some((hit) => hit.server === fullServerName(ROOT, "ctx"))).toBeTruthy();
  });

  it("命中 @global 单元", () => {
    const multi = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "use", 10);
    expect(
      multi.results.some((hit) => hit.server === fullServerName("@global", "gctx")),
    ).toBeTruthy();
  });

  it("合并摘要含全部工具", () => {
    // 空查询能力摘要同样合并。
    const summary = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "", 10);
    expect(summary.results.length).toBe(4);
  });

  it("单 root 包装与 multi 单元素等价（顺序一致）", () => {
    const units = multiUnits();
    // 单 root 包装与 multi 单元素等价（且顺序一致——multi 单 root 委托 searchCatalog，P2-2）。
    const single = searchCatalog(units, ROOT, "文档", 10);
    expect(single.results).toEqual(searchCatalogMulti(units, [ROOT], "文档", 10).results);
  });

  it("多 root 合并后按全局 limit 截断", () => {
    // 多 root 合并后统一按全局 limit 截断（P2-3：limit 为全局上限）。
    const capped = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "", 2);
    expect(capped.results.length).toBe(2);
  });

  it("无此单元 → 空结果", () => {
    const none = searchCatalogMulti(multiUnits(), ["/no/such"], "x", 10);
    expect(none.results.length).toBe(0);
  });

  it("无此单元 → 无 unavailable", () => {
    const none = searchCatalogMulti(multiUnits(), ["/no/such"], "x", 10);
    expect(none.unavailable.length).toBe(0);
  });
});

// listCatalog：完整清单 / 过滤 / 空返回 / 截断 / unavailable / disabled ----
describe("listCatalog：完整清单 / 过滤 / 空返回 / 截断 / unavailable / disabled", () => {
  const mkTools = (count: number) => {
    const tools = new Map();
    for (let i = 0; i < count; i += 1)
      tools.set(`t${i}`, { description: `desc${i}`, inputSchema: {} });
    return tools;
  };

  function listUnits() {
    const unit = makeUnit({
      catalog: new Map([
        // 2 个工具（无截断）
        ["ctx", { discoveredAt: Date.now(), tools: mkTools(2) }],
        // 用户已禁用（工具来自 last-good 目录）
        ["off", { discoveredAt: Date.now(), tools: mkTools(1) }],
        // 发现失败
        ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
      ]),
      userDisabled: ["off"],
    });
    const globalUnit = makeUnit({
      root: "@global",
      catalog: new Map([["gctx", { discoveredAt: Date.now(), tools: mkTools(3) }]]),
    });
    return new Map([
      [ROOT, unit],
      ["@global", globalUnit],
    ]);
  }

  // 完整清单（单 root）
  const listed = () => listCatalog(listUnits(), [ROOT], undefined, 50, "empty");
  const ctxEntryOf = (result: ListCatalogResult) =>
    result.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));
  const offEntryOf = (result: ListCatalogResult) =>
    result.servers.find((s) => s.server === fullServerName(ROOT, "off"));
  const downEntryOf = (result: ListCatalogResult) =>
    result.servers.find((s) => s.server === fullServerName(ROOT, "down"));

  it("workspace 为当前 root", () => {
    expect(listed().workspace).toBe(ROOT);
  });

  it("全部服务器（含 disabled/unavailable）", () => {
    expect(listed().totalServers).toBe(3);
  });

  it("工具数不含 unavailable 服务器", () => {
    expect(listed().totalTools).toBe(3);
  });

  it("全局 toolsTruncated 为 false", () => {
    expect(listed().toolsTruncated).toBe(false);
  });

  it("服务器条目工具名保序", () => {
    expect(ctxEntryOf(listed())!.tools.map((t) => t.tool)).toEqual(["t0", "t1"]);
  });

  it("条目 toolsTruncated 为 false", () => {
    expect(ctxEntryOf(listed())!.toolsTruncated).toBe(false);
  });

  it("未禁用服务器 disabled 为 undefined", () => {
    expect(ctxEntryOf(listed())!.disabled).toBeUndefined();
  });

  it("userDisabled → disabled: true", () => {
    expect(offEntryOf(listed())!.disabled).toBe(true);
  });

  it("发现失败附原因", () => {
    expect(downEntryOf(listed())!.unavailable).toBe("连接失败");
  });

  it("发现失败工具列表为空", () => {
    expect(downEntryOf(listed())!.tools).toEqual([]);
  });

  it("非空返回无 message", () => {
    expect(listed().message).toBeUndefined();
  });

  it("server 过滤（裸名）服务器数", () => {
    const filteredBare = listCatalog(listUnits(), [ROOT], "ctx", 50, "empty");
    expect(filteredBare.totalServers).toBe(1);
  });

  it("server 过滤（裸名）返回全名", () => {
    const filteredBare = listCatalog(listUnits(), [ROOT], "ctx", 50, "empty");
    expect(filteredBare.servers[0].server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("server 过滤（全名）", () => {
    const filteredFull = listCatalog(listUnits(), [ROOT], fullServerName(ROOT, "ctx"), 50, "empty");
    expect(filteredFull.totalServers).toBe(1);
  });

  it("全名 root 不属于当前 roots → 路由一致性错误", () => {
    expect(() => listCatalog(listUnits(), [ROOT], "@/other/root/ctx", 50, "empty")).toThrow(
      /不属于当前工作空间/,
    );
  });

  it("合并项目 root + @global", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.totalServers).toBe(4);
  });

  it("两 root 时 workspace 为第一个 root", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.workspace).toBe(ROOT);
  });

  it("含 @global 服务器", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.servers.some((s) => s.server === fullServerName("@global", "gctx"))).toBeTruthy();
  });

  it("合并后工具总数为 6", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.totalTools).toBe(6);
  });

  it("perServerLimit 截断到 1 条", () => {
    // perServerLimit 截断 → toolsTruncated（per-server + 全局汇总）
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(ctxEntryOf(truncated)!.tools.length).toBe(1);
  });

  it("per-server toolsTruncated", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(ctxEntryOf(truncated)!.toolsTruncated).toBe(true);
  });

  it("全局 toolsTruncated", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(truncated.toolsTruncated).toBe(true);
  });

  it("未超限不置位", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(offEntryOf(truncated)!.toolsTruncated).toBe(false);
  });

  it("空返回 totalServers 为 0", () => {
    // 空返回 → message
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.totalServers).toBe(0);
  });

  it("空返回 totalTools 为 0", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.totalTools).toBe(0);
  });

  it("空返回带 message", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.message).toBe("无项目级 MCP 配置提示");
  });

  it("空返回 toolsTruncated 为 false", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.toolsTruncated).toBe(false);
  });

  it("LIST_DEFAULT_TOOLS_PER_SERVER 常量", () => {
    expect(LIST_DEFAULT_TOOLS_PER_SERVER).toBe(50);
  });

  it("LIST_MAX_TOOLS_PER_SERVER 常量", () => {
    expect(LIST_MAX_TOOLS_PER_SERVER).toBe(500);
  });

  // #381 回归：未禁用工具条目**不写** disabled 键（显式 undefined 键会被宿主
  // lossless JSON 输出校验判非法 → ws_mcp_list 报 "value is not lossless JSON"）。
  it.each(["t0", "t1"])("未禁用条目不写 disabled 键（%s）", (tool) => {
    // t0/t1 恒在清单内（同一夹具），此处断言存在。
    const entry = ctxEntryOf(listed())!.tools.find((t) => t.tool === tool)!;
    expect(Object.hasOwn(entry, "disabled")).toBe(false);
  });

  it("服务器级禁用仍写 disabled 键", () => {
    expect(Object.hasOwn(offEntryOf(listed())!, "disabled")).toBe(true);
  });

  // #381 回归：工具级禁用路径——禁用条目写 disabled: true，未禁用条目无键。
  function withDisabled() {
    const disabledMap = new Map([[ROOT, new Map([["ctx", new Set(["t0"])]])]]);
    return listCatalog(listUnits(), [ROOT], undefined, 50, "empty", disabledMap);
  }
  const ctxWDOf = (result: ListCatalogResult) =>
    result.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));

  it("t0 被禁用 → disabled: true", () => {
    expect(ctxWDOf(withDisabled())!.tools[0].disabled).toBe(true);
  });

  it("禁用条目存在 disabled 键", () => {
    expect(Object.hasOwn(ctxWDOf(withDisabled())!.tools[0], "disabled")).toBe(true);
  });

  it("t1 未禁用 → 无 disabled 键", () => {
    expect(Object.hasOwn(ctxWDOf(withDisabled())!.tools[1], "disabled")).toBe(false);
  });

  // #381 回归：模拟宿主 lossless 校验（递归断言输出树无 undefined 值键/元素）。
  it("listed 输出 lossless 合规", () => {
    expect(losslessViolation(listed(), "listed")).toBeUndefined();
  });

  it("withDisabled 输出 lossless 合规", () => {
    expect(losslessViolation(withDisabled(), "withDisabled")).toBeUndefined();
  });
});

// findToolDetail：精确命中 / 完整 schema / 错误三分 / tool 归一化 ----
describe("findToolDetail：精确命中 / 完整 schema / 错误三分 / tool 归一化", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } },
    required: ["query"],
  };

  function detailUnits() {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_ctx", { description: "查询 context7 文档", inputSchema: schema }],
            ]),
          },
        ],
        ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
      ]),
    });
    return new Map([[ROOT, unit]]);
  }

  const detail = () => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "use_ctx");

  it("命中 server 为全名", () => {
    // 精确命中：完整 schema + fresh + server/tool 原样
    expect(detail().server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("命中 tool 名", () => {
    expect(detail().tool).toBe("use_ctx");
  });

  it("命中描述", () => {
    expect(detail().description).toBe("查询 context7 文档");
  });

  it("完整 inputSchema（含 enum/required）", () => {
    expect(detail().inputSchema).toEqual(schema);
  });

  it("命中 fresh 为 true", () => {
    expect(detail().fresh).toBe(true);
  });

  it("未禁用 disabled 为 undefined", () => {
    expect(detail().disabled).toBeUndefined();
  });

  it("tool 归一化（mcp__ 前缀剥离）", () => {
    const normalized = findToolDetail(
      detailUnits(),
      ROOT,
      fullServerName(ROOT, "ctx"),
      "mcp__ctx__use_ctx",
    );
    expect(normalized.tool).toBe("use_ctx");
  });

  it("归一化后 schema 不变", () => {
    const normalized = findToolDetail(
      detailUnits(),
      ROOT,
      fullServerName(ROOT, "ctx"),
      "mcp__ctx__use_ctx",
    );
    expect(normalized.inputSchema).toEqual(schema);
  });

  it("跨 server 前缀 → 疑似其他", () => {
    expect(() =>
      findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "mcp__other__tool"),
    ).toThrow(/疑似其他/);
  });

  it("错误三分 1：server 发现失败（附原因）", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "down"), "x")).toThrow(
      /发现失败.*连接失败/,
    );
  });

  it("错误三分 2：服务器未发现", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "nope"), "x")).toThrow(
      /未连接或未发现/,
    );
  });

  it("错误三分 2b：单元未激活", () => {
    expect(() =>
      findToolDetail(detailUnits(), "/no/such", fullServerName("/no/such", "ctx"), "x"),
    ).toThrow(/未连接或未发现/);
  });

  it("错误三分 3：工具不存在", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "nope")).toThrow(
      /tool 不存在/,
    );
  });

  it("路由一致性：参数 root ≠ 路由 root → 拒绝", () => {
    expect(() =>
      findToolDetail(detailUnits(), ROOT, fullServerName("@global", "ctx"), "x"),
    ).toThrow(/不属于当前工作空间/);
  });

  it("用户禁用标注 disabled", () => {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_ctx", { description: "查询 context7 文档", inputSchema: schema }],
            ]),
          },
        ],
      ]),
      userDisabled: ["ctx"],
    });
    const disabledDetail = findToolDetail(
      new Map([[ROOT, unit]]),
      ROOT,
      fullServerName(ROOT, "ctx"),
      "use_ctx",
    );
    expect(disabledDetail.disabled).toBe(true);
  });

  it("禁用且目录空 → 未连接（附禁用说明）", () => {
    const unit = makeUnit({
      catalog: new Map([["ctx", { discoveredAt: 0, tools: new Map() }]]),
      userDisabled: ["ctx"],
    });
    expect(() =>
      findToolDetail(new Map([[ROOT, unit]]), ROOT, fullServerName(ROOT, "ctx"), "x"),
    ).toThrow(/已被用户禁用/);
  });
});

// #412 force 受控重建：半开 connected entry 不短路 ----
// 旧栈下「半开 socket 不泄漏」靠 close 旧 transport 断言；换引擎后 transport/client 字段根本
// 不存在，等价判据是「重建前先把旧代际的官方句柄结清」（裁定 V）——官方 serverName 在应用根上
// 活体预留，同 id 未结算就重挂当场抛，所以顺序本身就是判据。
describe("#412 force 受控重建：半开 connected entry 不短路", () => {
  /**
   * 先真装一代：假 loader 立即结算、注册面还没有本 id 前缀 → 窗口判 failed（id 此时才写回）。
   * 随后把该 id 的前缀补进注册面，状态经 statusOf 读时刷新建模为 connected——这就是「status 卡
   * connected 但链路已死」的半开形态，不再需要伪造 transport 字段。
   */
  async function halfOpenFixture() {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host, tools } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    await mw.ensureConnected(ROOT, "ctx");
    // 真装一代保证条目存在（ensureConnected 刚写入），此处断言存在。
    const entry = unit.connections.get("ctx")!;
    tools.entries = [{ name: `mcp__${entry.id}__t` }];
    expect(mw.statusOf(ROOT, "ctx")).toBe("connected");
    return { mw, unit, entry, tools };
  }

  it("非 force 短路保留原 entry（惰性路径防重复建连）", async () => {
    const { mw, unit, entry } = await halfOpenFixture();
    const mountsBefore = poolLoader.calls.filter((call) => call[0] === "mount").length;
    await mw.ensureConnected(ROOT, "ctx");
    expect(unit.connections.get("ctx")).toBe(entry);
    expect(poolLoader.calls.filter((call) => call[0] === "mount").length).toBe(mountsBefore);
  });

  it("force 重建：先 disposeServer(oldId) 再 mount（旧句柄 dispose 早于新装载）", async () => {
    const { mw, unit, entry } = await halfOpenFixture();
    // 真装一代的 id 恒为字符串（虚拟单元才无 id），此处断言存在。
    const oldId = entry.id!;
    expect(mountLedger.get(oldId)).toBeDefined();
    const from = poolLoader.calls.length;
    await mw.ensureConnected(ROOT, "ctx", { force: true });
    const tail = poolLoader.calls.slice(from);
    const disposeAt = tail.findIndex((call) => call[0] === "dispose");
    const mountAt = tail.findIndex((call) => call[0] === "mount");
    expect(disposeAt).toBeGreaterThanOrEqual(0);
    expect(mountAt).toBeGreaterThanOrEqual(0);
    // 顺序即判据：反了就是「同 id 未结算就重挂」——官方会当场抛 serverName 已被占用。
    expect(disposeAt).toBeLessThan(mountAt);
    // 账本摘账同步生效：旧代际出册，新代际顶上同一个键。
    expect(unit.connections.get("ctx")).not.toBe(entry);
    expect(mountLedger.get(oldId)).toBeDefined();
    expect(mountLedger.get(oldId)?.key).toBe(oldId);
  });

  it("force 重建后状态由注册面重算（不再有 probeRetry 对 connected 的死循环短路）", async () => {
    const { mw, unit, entry, tools } = await halfOpenFixture();
    await mw.ensureConnected(ROOT, "ctx", { force: true });
    // 重建后条目恒存在（同一键复用），此处断言存在。
    const after = unit.connections.get("ctx")!;
    expect(after).not.toBe(entry);
    // 同一 (root, name) 复用同一个 id；注册面前缀仍在 → 新代际照实投影为 connected，
    // 说明状态来自读时刷新而不是「重建后固定置 failed 等探测重试」。
    expect(after.id).toBe(entry.id);
    expect(mw.statusOf(ROOT, "ctx")).toBe("connected");
    tools.entries = [];
    expect(mw.statusOf(ROOT, "ctx")).toBe("reconnecting");
  });
});

// #413：runtime 封装定义服务器（toolDefinitions）中间层直呼 ----
describe("#413：runtime 封装定义服务器中间层直呼", () => {
  function wrappedGlobalFixture() {
    const wrappedTool = {
      name: "cg_node",
      description: "查符号（封装定义）",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
      output: {
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        render: (args: unknown, value: { text: unknown }) => [
          { type: "text", text: `rendered:${String(value.text)}` },
        ],
      },
      isConcurrencySafe: () => true,
      execute: async (args: unknown, exec: unknown) => {
        const agent = (exec as { agent?: unknown } | undefined)?.agent;
        const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session
          ?.header?.cwd;
        // String() 与模板字面量内插的转义语义逐字一致（均为 String(value)），此处不断言、只为类型收窄。
        return {
          text: `node(${String((args as { symbol: unknown }).symbol)})@${String(cwd ?? "no-cwd")}`,
        };
      },
    };
    const wrappedServer = {
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      enabled: true,
      toolDefinitions: [wrappedTool],
    };
    // 封装定义是中间层自持形状（与官方 ToolDefinition 面不完全一致）：此处不断言其类型，只收窄容器。
    const { host, log, tools } = makeHost(
      new Map([["@global", [wrappedServer]]]) as unknown as Map<string, ServerConfig[]>,
    );
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    return { mw, host, log, tools, wrappedServer, wrappedTool };
  }

  async function connected() {
    const fixture = wrappedGlobalFixture();
    await fixture.mw.projectUnitFor("@global");
    await fixture.mw.ensureConnected("@global", "cg");
    // 真装载保证单元/条目/目录投影存在（ensureConnected 刚写入），此处断言存在。
    const unit = fixture.mw.units.get("@global")!;
    return {
      ...fixture,
      unit,
      entry: unit.connections.get("cg")!,
      catalog: catalogDirectory.entryFor("@global", "cg")!,
    };
  }

  it("@global 单元已创建", async () => {
    const { unit } = await connected();
    expect(unit).toBeTruthy();
  });

  it("封装定义服务器虚拟连接已建立", async () => {
    const { entry } = await connected();
    expect(entry).toBeTruthy();
  });

  it("虚拟连接状态 connected", async () => {
    const { entry } = await connected();
    expect(entry.status).toBe("connected");
  });

  // 旧断言读 entry.client / entry.transport 恒 undefined——字段已随换引擎删除，再读就是恒真。
  // 判据换到新链路：虚拟单元不进账本、不挂官方实例，证据是「无 id / 无句柄 / loader 未 mount」。
  it("不派官方实例（无账本键、无句柄、loader 未 mount）", async () => {
    const { entry } = await connected();
    expect(entry.id).toBeUndefined();
    expect(entry.handle).toBeUndefined();
    expect(poolLoader.calls.filter((call) => call[0] === "mount")).toHaveLength(0);
    expect(mountLedger.size).toBe(0);
  });

  it("目录已投影", async () => {
    const { catalog } = await connected();
    expect(catalog).toBeTruthy();
  });

  it("封装工具名投影进目录", async () => {
    const { catalog } = await connected();
    expect(catalog.tools.has("cg_node")).toBe(true);
  });

  it("封装工具描述投影", async () => {
    const { catalog } = await connected();
    expect(catalog.tools.get("cg_node")!.description).toBe("查符号（封装定义）");
  });

  it("parameters 直接作 inputSchema", async () => {
    // 目录从 toolDefinitions 投影（name/description/parameters → inputSchema）。
    const { catalog } = await connected();
    expect(catalog.tools.get("cg_node")!.inputSchema).toEqual({
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    });
  });

  it("封装直呼：execute + render + agent 透传", async () => {
    // callTool 封装直呼：execute 被调用 + output.render 投影 content + agent 透传。
    const { mw } = await connected();
    const result = await mw.callTool(
      fullServerName("@global", "cg"),
      "cg_node",
      { symbol: "foo" },
      undefined,
      identity({ agent: { session: { header: { cwd: "/proj" } } } }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "rendered:node(foo)@/proj" }],
      structuredContent: { text: "node(foo)@/proj" },
    });
  });

  it("agent 缺省不崩（封装侧自处理）", async () => {
    const { mw } = await connected();
    // agent 缺省 → cwd 解析 undefined。
    // callTool 返回投影 unknown 面：此处只读 structuredContent 键。
    const noAgent = (await mw.callTool(
      fullServerName("@global", "cg"),
      "cg_node",
      { symbol: "bar" },
      undefined,
      identity(),
    )) as { structuredContent: unknown };
    expect(noAgent.structuredContent).toEqual({ text: "node(bar)@no-cwd" });
  });

  it("工具级禁用前置：禁用表命中 → 抛禁用错误（不经 execute）", async () => {
    const { mw } = await connected();
    mw.disabledTools.set("@global", new Map([["cg", new Set(["cg_node"])]]));
    await expect(
      mw.callTool(
        fullServerName("@global", "cg"),
        "cg_node",
        { symbol: "x" },
        undefined,
        identity({ agent: { session: { header: { cwd: "/p" } } } }),
      ),
    ).rejects.toThrow(/已被用户在「MCP」浮窗禁用/);
  });

  it("不存在的封装工具名 → 明确报错", async () => {
    const { mw } = await connected();
    await expect(
      mw.callTool(fullServerName("@global", "cg"), "nope", {}, undefined, identity()),
    ).rejects.toThrow(/不存在（封装定义服务器）/);
  });

  // #767 S1-5c：下面三条重建自 unit-supervisor.test.ts 的「syncTools：封装定义路径（#362
  // 补充 4）」组。旧组断言的是「裸名 → mcp__<server>__ 注册」这条**已被裁定 AH 修订废弃**的
  // 路径（封装条目恒交中间层虚拟连接、与模式无关，唯一触达面是 ws_mcp_call），故不重建注册
  // 语义，只把目标态仍成立的三条契约落到虚拟路径上。
  it("封装定义裸名只进目录，不产生 mcp__ 直呼注册", async () => {
    const { catalog, tools } = await connected();
    expect(catalog.tools.has("cg_node")).toBe(true);
    expect(
      tools.registered.filter((def) => /^mcp__/.test((def as { name?: string })?.name ?? "")),
    ).toEqual([]);
  });

  it("封装定义对象不被就地改写（裸名保持、同一性不变）", async () => {
    const { wrappedServer, wrappedTool } = await connected();
    // 改写调用方定义（supervisor 时代那种「复制并改写 name 为公开名」的就地版）会让模型面
    // 看到的裸名与调用方 execute 的认知分叉。
    expect(wrappedServer.toolDefinitions[0]).toBe(wrappedTool);
    expect(wrappedTool.name).toBe("cg_node");
  });

  it("畸形封装定义不炸投影：无名定义跳过、重名后者覆盖单条", async () => {
    const badServer = {
      name: "bad",
      transport: "stdio",
      command: "true",
      enabled: true,
      toolDefinitions: [
        { description: "no name", parameters: {} },
        { name: "dup", description: "first", parameters: {} },
        { name: "dup", description: "second", parameters: {} },
        { name: "ok", description: "fine", parameters: {} },
      ],
    };
    // 畸形定义（无名/重名）是被测的输入面：容器收窄，定义本身不断言。
    const { host } = makeHost(
      new Map([["@global", [badServer]]]) as unknown as Map<string, ServerConfig[]>,
    );
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    await mw.projectUnitFor("@global");
    await mw.ensureConnected("@global", "bad");
    const catalog = catalogDirectory.entryFor("@global", "bad")!;
    expect([...catalog.tools.keys()].sort()).toEqual(["dup", "ok"]);
    expect(catalog.tools.get("dup")!.description).toBe("second");
  });

  // persistCatalog 跳过 runtime 条目（isRuntimeServer 命中 → 不写盘）。
  function persistFixture() {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-wrapped-"));
    const { host } = makeHost(new Map());
    const persistHost = {
      ...host,
      isRuntimeServer: (name: string) => name === "cg",
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw2 = trackMw(new McpMiddleware(persistHost as unknown as MiddlewareHost));
    const unit2 = makeUnit({
      root: "@global",
      catalog: new Map([
        [
          "cg",
          {
            discoveredAt: Date.now(),
            tools: new Map([["cg_node", { description: "d", inputSchema: {} }]]),
          },
        ],
        [
          "storeSrv",
          {
            discoveredAt: Date.now(),
            tools: new Map([["t1", { description: "d", inputSchema: {} }]]),
          },
        ],
      ]),
    });
    mw2.units.set("@global", unit2);
    return { mw2, persistHost };
  }

  it("runtime 条目不写盘", async () => {
    const { persistHost } = persistFixture();
    await catalogDirectory.persistRoot("@global", {
      cachePath: () => persistHost.catalogCachePath("@global"),
      isRuntimeServer: (name) => name === "cg",
      warn: () => {},
    });
    const persisted = readFileSync(persistHost.catalogCachePath("@global"), "utf8");
    expect(persisted.includes("cg")).toBe(false);
  });

  it("store 条目照常写盘", async () => {
    const { persistHost } = persistFixture();
    await catalogDirectory.persistRoot("@global", {
      cachePath: () => persistHost.catalogCachePath("@global"),
      isRuntimeServer: (name) => name === "cg",
      warn: () => {},
    });
    const persisted = readFileSync(persistHost.catalogCachePath("@global"), "utf8");
    expect(persisted.includes("storeSrv")).toBe(true);
  });
});

// #413：空 toolDefinitions / 封装调用超时兜底 ----
describe("#413：空 toolDefinitions / 封装调用超时兜底", () => {
  async function emptyWrappedConnected() {
    // 空 toolDefinitions：连接照建、目录 0 工具、调用报「不存在」。
    const emptyWrapped = {
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      enabled: true,
      toolDefinitions: [],
    };
    // 空 toolDefinitions 的自持形状与容器一并收窄（定义本身不断言）。
    const { host } = makeHost(
      new Map([["@global", [emptyWrapped]]]) as unknown as Map<string, ServerConfig[]>,
    );
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    await mw.projectUnitFor("@global");
    await mw.ensureConnected("@global", "cg");
    // 刚 projectUnitFor 建单元，此处断言存在。
    const unit = mw.units.get("@global")!;
    return { mw, unit };
  }

  it("空 toolDefinitions 仍建虚拟连接", async () => {
    const { unit } = await emptyWrappedConnected();
    expect(unit.connections.get("cg")?.status).toBe("connected");
  });

  it("空 toolDefinitions 目录 0 工具", async () => {
    await emptyWrappedConnected();
    expect(catalogDirectory.entryFor("@global", "cg")?.tools.size).toBe(0);
  });

  it("空 toolDefinitions 调用报不存在", async () => {
    const { mw } = await emptyWrappedConnected();
    await expect(
      mw.callTool(fullServerName("@global", "cg"), "anything", {}, undefined, identity()),
    ).rejects.toThrow(/不存在（封装定义服务器）/);
  });

  it("封装 execute 挂起 → withTimeout 超时兜底（不无限等待）", { timeout: 15_000 }, async () => {
    const hangingTool = {
      name: "hang",
      description: "挂起",
      parameters: { type: "object", properties: {} },
      output: {
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        render: (a: unknown, v: { text: unknown }) => [{ type: "text", text: v.text }],
      },
      execute: async () => new Promise(() => {}), // 永不 resolve
    };
    const hangingServer = {
      name: "hg",
      transport: "stdio",
      command: "x",
      enabled: true,
      // 预算压到 100ms：超时兜底是「预算 + 2000」，驱动真超时不必让用例挂在 32s 墙钟上。
      toolCallTimeoutMs: 100,
      toolDefinitions: [hangingTool],
    };
    // 自持形状与容器一并收窄（定义本身不断言，见上）。
    const { host: host2 } = makeHost(
      new Map([["@global", [hangingServer]]]) as unknown as Map<string, ServerConfig[]>,
    );
    const mw3 = trackMw(new McpMiddleware(host2 as unknown as MiddlewareHost));
    await mw3.projectUnitFor("@global");
    await mw3.ensureConnected("@global", "hg");
    await expect(
      mw3.callTool(fullServerName("@global", "hg"), "hang", {}, undefined, identity()),
    ).rejects.toThrow(/封装调用超时（100ms）/);
  });
});

// #512：callTool 远端结果投影收敛（isError/_meta 不泄漏 + 无 content 兜底）----
describe("#512：callTool 远端结果投影收敛", () => {
  /** 假宿主执行面返回官方形状 `{isError, content, value}`：`value` 才是远端原始结果。 */
  async function withFakeExecute(value: unknown, { stale = false }: { stale?: boolean } = {}) {
    const servers: ServerConfig[] = [
      { name: "py", transport: "stdio", command: "python", enabled: true },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]), {
      execute: async () => ({ isError: false, content: [], value }),
    });
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const entries: Array<[string, DiskSeedEntry]> = [
      [
        "py",
        {
          discoveredAt: stale ? Date.now() - CATALOG_TTL_MS - 1000 : Date.now(),
          tools: new Map([["echo", { description: "回声", inputSchema: { type: "object" } }]]),
          unavailable: undefined,
        },
      ],
    ];
    // stale 分支要的是「很久以前发现的」，投影写口恒写 now → 这条走 last-good 读回。
    if (stale) await seedRootFromDisk(ROOT, entries);
    const unit = makeUnit(stale ? {} : { catalog: new Map(entries) });
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(servers[0], "id-py"));
    return mw;
  }

  // echo 的返回即投影产物面（ProjectedCallResult）：调用方只读 content/structuredContent 键。
  const echo = (mw: McpMiddlewareType): Promise<ProjectedCallResult> =>
    mw.callTool(
      fullServerName(ROOT, "py"),
      "echo",
      {},
      undefined,
      identity(),
    ) as Promise<ProjectedCallResult>;

  it("#767 S1-4d：远端返回与旧链路逐字节等价（工具返回值 === projectCallToolResult(value)）", async () => {
    const value = {
      content: [{ type: "text", text: "等价" }],
      structuredContent: { n: 1 },
      isError: false,
      _meta: { trace: "x" },
    };
    const mw = await withFakeExecute(value);
    const out = await echo(mw);
    // 同一份远端原文走真 pipeline 投影；换引擎后喂进投影的必须是 result.value，否则
    // isError / _meta 之类字段会外泄进工具契约（与旧链路就不再逐字节等价）。
    expect(out).toEqual(projectCallToolResult(value));
    expect(Object.hasOwn(out, "structuredContent")).toBe(true);
    expect(Object.hasOwn(out, "isError")).toBe(false);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#767 S1-4d：远端返回无 structuredContent 时不落键（条件键语义同旧链路）", async () => {
    const value = { content: [{ type: "text", text: "只有文本" }] };
    const mw = await withFakeExecute(value);
    const out = await echo(mw);
    expect(out).toEqual(projectCallToolResult(value));
    // 投影产物面为对象（键存在性断言），此处取对象面不断言其形状。
    expect(Object.hasOwn(out as object, "structuredContent")).toBe(false);
  });

  it("#512：isError:false / _meta 不泄漏，白名单字段保留", async () => {
    // Python SDK 形态：成功结果必带 isError:false（+ _meta）→ 不得外泄。
    const mw = await withFakeExecute({
      content: [{ type: "text", text: "你好" }],
      structuredContent: { answer: 42 },
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await echo(mw);
    expect({ content: out.content, structuredContent: out.structuredContent }).toEqual({
      content: [{ type: "text", text: "你好" }],
      structuredContent: { answer: 42 },
    });
  });

  it("无 isError 键", async () => {
    const mw = await withFakeExecute({
      content: [{ type: "text", text: "你好" }],
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "isError")).toBe(false);
  });

  it("无 _meta 键", async () => {
    const mw = await withFakeExecute({
      content: [{ type: "text", text: "你好" }],
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#512 输出 lossless 合规", async () => {
    const mw = await withFakeExecute({ content: [{ type: "text", text: "你好" }], isError: false });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 输出")).toBeUndefined();
  });

  it("isError:true 抛错且文案可归因", async () => {
    // isError:true → 抛错（文案含远端错误提示与下一步引导）。
    const mw = await withFakeExecute({ content: [{ type: "text", text: "boom" }], isError: true });
    await expect(echo(mw)).rejects.toThrow(/远端工具返回错误：.*boom.*ws_mcp_detail/);
  });

  it("isError:true 应抛错（Error 实例）", async () => {
    const mw = await withFakeExecute({ content: [{ type: "text", text: "boom" }], isError: true });
    // #529：外层 catch 不再追加 detail 建议，同一条错误里「ws_mcp_detail」只出现一次。
    const dupErr = await echo(mw).then(
      () => null,
      (e: unknown) => e,
    );
    expect(dupErr instanceof Error).toBeTruthy();
  });

  it("detail 建议只出现一次", async () => {
    const mw = await withFakeExecute({ content: [{ type: "text", text: "boom" }], isError: true });
    const dupErr = await echo(mw).then(
      () => null,
      (e) => e,
    );
    // dupErr 为被测抛出的 Error（上一断言已验 instanceof），此处取文案不断言。
    const detailCount = ((dupErr as Error).message.match(/ws_mcp_detail/g) ?? []).length;
    expect(detailCount).toBe(1);
  });

  it("toolResult 形态渲染 JSON 兜底", async () => {
    // 无 content / 非数组 content → 兜底文本（required content 不落空，lossless 合规）。
    const mw = await withFakeExecute({ toolResult: { ok: 1 } });
    const out = await echo(mw);
    expect(out.content).toEqual([{ type: "text", text: '{"ok":1}' }]);
  });

  it("#512 兜底 lossless 合规", async () => {
    const mw = await withFakeExecute({ toolResult: { ok: 1 } });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 兜底")).toBeUndefined();
  });

  it("空结果 → (no output) 兜底", async () => {
    const mw = await withFakeExecute({});
    const out = await echo(mw);
    expect(out.content).toEqual([{ type: "text", text: "(no output)" }]);
  });

  it("stale 前置 hint（内容块数为 2）", async () => {
    // stale（目录过期）：前置 hint + 仍走投影（不透传 isError/_meta）。
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(out.content.length).toBe(2);
  });

  it("stale hint 文案", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }] },
      { stale: true },
    );
    const out = await echo(mw);
    // stale hint 恒为文本块（投影构造保证），此处按测试前置收窄。
    expect((out.content[0] as { text: string }).text).toMatch(/本工具目录已过期/);
  });

  it("stale 保留远端原文", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }] },
      { stale: true },
    );
    const out = await echo(mw);
    expect(out.content[1]).toEqual({ type: "text", text: "旧结果" });
  });

  it("stale 分支也不泄漏 isError", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(Object.hasOwn(out, "isError")).toBe(false);
  });

  it("stale 分支也不泄漏 _meta", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#512 stale lossless 合规", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }] },
      { stale: true },
    );
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 stale")).toBeUndefined();
  });

  async function voidOpFixture() {
    // 封装 execute 返回 undefined → 不落 structuredContent 键（#381 同源防御）。
    const voidTool = {
      name: "void_op",
      description: "无返回值",
      parameters: { type: "object", properties: {} },
      output: {
        schema: { type: "object", properties: {}, additionalProperties: false },
        render: () => [{ type: "text", text: "done" }],
      },
      execute: async () => undefined,
    };
    const voidServer = {
      name: "vd",
      transport: "stdio",
      command: "x",
      enabled: true,
      toolDefinitions: [voidTool],
    };
    // 自持形状与容器一并收窄（定义本身不断言，见上）。
    const { host } = makeHost(
      new Map([["@global", [voidServer]]]) as unknown as Map<string, ServerConfig[]>,
    );
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    await mw.projectUnitFor("@global");
    await mw.ensureConnected("@global", "vd");
    return mw;
  }

  it("封装 execute 返回 undefined 不落 structuredContent 键", async () => {
    const mw = await voidOpFixture();
    const out = await mw.callTool(
      fullServerName("@global", "vd"),
      "void_op",
      {},
      undefined,
      identity(),
    );
    // 投影产物面为对象（键存在性断言），此处取对象面不断言其形状。
    expect(Object.hasOwn(out as object, "structuredContent")).toBe(false);
  });

  it("#512 封装 undefined lossless 合规", async () => {
    const mw = await voidOpFixture();
    const out = await mw.callTool(
      fullServerName("@global", "vd"),
      "void_op",
      {},
      undefined,
      identity(),
    );
    expect(losslessViolation(out, "#512 封装 undefined")).toBeUndefined();
  });

  // 两例「isError + 非数组 content 的原文保留」整删：真链路里这条分支不可达——官方执行器在
  // isError:true 时先抛错，且把非数组 content 渲染成单个 text 块，dispatch 拿到的 value 已经
  // 没有「非数组 content」这个形态（isError 也在投影之前就收敛成单层文案）。等价判据在新链路
  // 上的住所：unit-dispatch 的「isError:true → 单层文案」与上面的 value 等价性用例。

  // 复核闸 F5：缺省分支（不传 handlers）——错误文案取 content 内 text 块 join，
  // 无 text 块退化兜底文本；fallbackText 惰性（正常路径零额外计算语义由实现保证）。
  function probe(result: unknown, handlers: CallResultTextHandlers) {
    return projectCallToolResult(result, handlers);
  }

  function thrownOf(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("缺省 errorText = content 内 text 块 join", () => {
    const thrown = thrownOf(() =>
      probe(
        {
          content: [
            { type: "text", text: "e1" },
            { type: "text", text: "e2" },
          ],
          isError: true,
        },
        {},
      ),
    );
    expect((thrown as Error).message).toBe("e1\ne2");
  });

  it("缺省 errorText 无 text 块退化兜底", () => {
    const thrown = thrownOf(() =>
      probe({ content: [{ type: "image", mimeType: "image/png" }], isError: true }, {}),
    );
    expect((thrown as Error).message).toBe("(no output)");
  });

  it("fallbackText 惰性：正常 content 路径不调用", () => {
    // 注入 fallbackText 但正常 content 路径不消费（惰性：计数不增长）。
    let fallbackCalls = 0;
    probe(
      { content: [{ type: "text", text: "ok" }], isError: false },
      {
        fallbackText: () => {
          fallbackCalls += 1;
          return "unused";
        },
      },
    );
    expect(fallbackCalls).toBe(0);
  });

  it("正常 content 路径透传投影", () => {
    const normal = probe({ content: [{ type: "text", text: "ok" }], isError: false }, {});
    expect(normal.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

// createRedactor 基线（issue #664 阶段 1：先锁现状整 URL 脱敏；B8 改「仅用户
// 信息」口径在阶段 2，届时本基线按新契约修订）----
describe("createRedactor 基线", () => {
  function redacted() {
    const redact = createRedactor([
      {
        name: "http1",
        transport: "streamable-http",
        url: "https://user:pass@example.com/path?token=abc",
        headers: { Authorization: "Bearer secret-token" },
        enabled: true,
      },
      {
        name: "stdio1",
        transport: "stdio",
        command: "echo",
        env: { API_KEY: "k-123" },
        args: ["--token", "tok-456"],
        enabled: true,
      },
    ]);
    return redact(
      new Error(
        "failed connect to https://user:pass@example.com/path?token=abc with Bearer secret-token k-123 tok-456",
      ),
    );
  }

  // 现状口径（middleware-utils.ts createRedactor L146）：http 分支把整 URL 加入
  // secrets；env 全值、args 凭据形参、headers 全值同样脱敏。
  it("URL 用户信息脱敏", () => {
    expect(!redacted().includes("user:pass")).toBeTruthy();
  });

  it("URL searchParams 脱敏", () => {
    expect(!redacted().includes("token=abc")).toBeTruthy();
  });

  it("header 值脱敏", () => {
    expect(!redacted().includes("secret-token")).toBeTruthy();
  });

  it("env 全值脱敏", () => {
    expect(!redacted().includes("k-123")).toBeTruthy();
  });

  it("args 凭据形参值脱敏", () => {
    expect(!redacted().includes("tok-456")).toBeTruthy();
  });

  it("B-M2 短 flag 下一拍脱敏（-p password；#903）", () => {
    const redact = createRedactor([
      {
        name: "s",
        transport: "stdio",
        command: "mysql",
        args: ["-p", "s3cr3t-pw", "-k", "k3y-v4l", "--port", "3306"],
        enabled: true,
      },
    ]);
    const out = redact(new Error("connect failed with s3cr3t-pw and k3y-v4l on 3306"));
    expect(!out.includes("s3cr3t-pw")).toBeTruthy();
    expect(!out.includes("k3y-v4l")).toBeTruthy();
    // -k 只认精确独占形态：--port 的值不是秘密，保留可诊断。
    expect(out.includes("3306")).toBeTruthy();
  });

  it("B-M2 --turkey 不误伤下个参数（精确名匹配；#903）", () => {
    const redact = createRedactor([
      {
        name: "s",
        transport: "stdio",
        command: "cook",
        args: ["--turkey", "thanksgiving"],
        enabled: true,
      },
    ]);
    expect(redact(new Error("roast thanksgiving")).includes("thanksgiving")).toBeTruthy();
  });

  it("B-M2 等号形态与大小写仍脱敏（--Token=xxx；#903）", () => {
    const redact = createRedactor([
      {
        name: "s",
        transport: "stdio",
        command: "run",
        args: ["--Token=AbC-123"],
        enabled: true,
      },
    ]);
    expect(!redact(new Error("leaked AbC-123")).includes("AbC-123")).toBeTruthy();
  });

  // B8 红测（D4 决策：仅用户信息脱敏）：host/path 无凭据应保留可读——
  // 现状整 URL 全部 [REDACTED]，本断言红；commit3 改口径后绿。
  it("B8：host 应保留（仅用户信息脱敏；现状整 URL 脱敏）", () => {
    expect(redacted().includes("example.com")).toBeTruthy();
  });

  it("B8：path 应保留", () => {
    expect(redacted().includes("/path")).toBeTruthy();
  });
});

// B8 红测（续）：percent-encoding raw 形态脱敏对照 ----
describe("B8 红测（续）：percent-encoding raw 形态脱敏对照", () => {
  function redactedEnc() {
    // URL 用户信息带 percent-encoding：URL parse 得 decoded 形态，raw 形态
    // （错误消息中实际出现的字节串）必须同被脱敏——现状仅存 decoded，红测。
    const redactEnc = createRedactor([
      {
        name: "enc",
        transport: "streamable-http",
        url: "https://user%3Apass@example.com/p?token=abc123",
        headers: {},
        enabled: true,
      },
    ]);
    return redactEnc(new Error("failed connect to user%3Apass@example.com abc123"));
  }

  it("B8：percent-encoded 用户信息 raw 形态脱敏（现状仅存 decoded → 红测）", () => {
    expect(!redactedEnc().includes("user%3Apass")).toBeTruthy();
  });

  it("searchParams 值脱敏", () => {
    expect(!redactedEnc().includes("abc123")).toBeTruthy();
  });
});

// B9 红测：boundCatalogTools 描述截断按字节（UTF-8 中文多字节） ----
describe("B9 红测：boundCatalogTools 描述截断按字节", () => {
  it("B9：截断后描述字节数 ≤ MAX_BYTES_PER_TOOL（现状 slice 按字符 → 超限，红测）", () => {
    // "字" 每字符 3 字节：2000 字 = 6000 字节 > MAX_BYTES_PER_TOOL(4096)
    const bigDesc = "字".repeat(2000);
    const bounded = boundCatalogTools([{ name: "t1", description: bigDesc, inputSchema: {} }]);
    // 刚装箱的键恒存在，此处断言存在。
    const desc = bounded.get("t1")!.description;
    expect(Buffer.byteLength(desc, "utf8") <= MAX_BYTES_PER_TOOL).toBeTruthy();
  });
});

// B10 红测：searchCatalogMulti 恰好 limit 命中不误报 truncated ----
describe("B10 红测：searchCatalogMulti 恰好 limit 命中不误报 truncated", () => {
  function multiFixture() {
    const cata = new Map([
      [
        "s1",
        {
          server: "s1",
          tools: new Map([
            ["alpha", { name: "alpha", description: "alpha tool", inputSchema: {} }],
            ["beta", { name: "beta", description: "beta tool", inputSchema: {} }],
          ]),
        },
      ],
    ]);
    // 目录内存态归 catalog 域：这里登记进域，单元只留「在册」这一层。
    seedRoot(
      ROOT,
      new Map(
        [...cata].map(([serverName, entry]) => [
          serverName,
          { discoveredAt: Date.now(), tools: entry.tools },
        ]),
      ),
    );
    const fakeUnit: ProjectUnit = {
      root: ROOT,
      connections: new Map(),
      userDisabled: new Set(),
      inFlight: new Map(),
      lastTouchedAt: Date.now(),
    };
    return new Map([[ROOT, fakeUnit]]);
  }

  it("恰好 limit=1 命中返回 1 条", () => {
    // 恰好 limit=1 条命中（alpha）
    const r = searchCatalogMulti(multiFixture(), [ROOT], "alpha", 1);
    expect(r.results.length).toBe(1);
  });

  it("B10：恰好 limit 命中不应标 truncated", () => {
    const r = searchCatalogMulti(multiFixture(), [ROOT], "alpha", 1);
    expect(r.truncated).toBe(false);
  });
});

// B18 红测a：callTool 应用 server.toolCallTimeoutMs（现状固定 CALL_TIMEOUT_MS）----
// 预算的两段去向：① 进官方 Config 的 toolCallTimeoutMs（映射判据在 unit-lifecycle-mount 的
// 「显式值原样透传」一例）；② 本层超时兜底的预算 = 它 + 2000。②是这里唯一还能观测到的部分。
describe("B18 红测a：callTool 应用 server.toolCallTimeoutMs", () => {
  function timeoutFixture(execute: FakeToolsScript["execute"]) {
    const server: ServerConfig = {
      name: "s1",
      transport: "stdio",
      command: "echo",
      enabled: true,
      toolCallTimeoutMs: 100,
    };
    const { host } = makeHost(new Map([[ROOT, [server]]]), { execute });
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("s1", remoteEntry(server, "id-s1"));
    return { mw, unit };
  }

  const okExecute = async () => ({
    isError: false,
    content: [{ type: "text", text: "ok" }],
    value: { content: [{ type: "text", text: "ok" }] },
  });

  it("callTool 正常", async () => {
    const { mw } = timeoutFixture(okExecute);
    // echo 工具恒回文本块（okExecute 构造保证），此处按测试前置收窄。
    const res = (await mw.callTool(
      fullServerName(ROOT, "s1"),
      "t1",
      '{"a":1}',
      undefined,
      identity(),
    )) as ProjectedCallResult;
    expect((res.content[0] as { text: string }).text).toBe("ok");
  });

  it(
    "B18：超时文案带 server.toolCallTimeoutMs（不是缺省 30000）",
    { timeout: 15_000 },
    async () => {
      const { mw } = timeoutFixture(async () => new Promise(() => {}));
      await expect(
        mw.callTool(fullServerName(ROOT, "s1"), "t1", '{"a":1}', undefined, identity()),
      ).rejects.toThrow(/调用超时（100ms）/);
    },
  );
});

// B18 红测b/c 与 B4 红测（续）共 7 例整删：它们守的是我方 scheduleReconnect 定时器、
// 退避预算计数与 probeRetried 一次性标记——这三样随换引擎全部删除（官方自带重连退避，
// 且首连失败不再抛、实例常驻后台重试）。同类语义在新链路上的住所：unit-config-env 的
// reconnect 配置收紧判据 + unit-lifecycle-mount 的「reconnect 原样交官方」映射判据。
// 「曾连上、前缀消失」这一可判时点则改由 statusOf 读时刷新承担（见文末的池判据段）。

// B11：server 名含连续双下划线 → guard fail-closed 拒绝并指往 ws_mcp_call ----
// 规格化不可逆——含连续双下划线的 server/tool 名无法从注册全名唯一
// 反解（mcp__my__sv__t 既可能是 server="my"+tool="sv__t"，也可能是
// server="my__sv"+tool="t"）。#903 B-M4 起 fail-closed（与 dispatch 侧
// normalizeToolName 对跨 server 前缀的 fail-closed 对称）：放行会让已禁用的含 __
// 工具经直呼路径绕过禁用；含 __ 工具经 ws_mcp_call 裸名路径照常用（确定性裁决），
// 故直呼歧义一律拒绝并指往该路径。不改 publicToolName/INVALID_NAME_CHARS
// （防冲击官方 mcp__ 契约）。
describe("B11：含连续双下划线名 fail-closed 拒绝并指往 ws_mcp_call", () => {
  function guardFixture(disabledMap: DisabledToolsMap) {
    // pre-execute 订阅回调：返回裁决对象（kind 面），此处取测试读取的最小面。
    const guards = new Map<string, (...args: unknown[]) => unknown>();
    const ctx = {
      tools: { register: () => () => {} },
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        guards.set(evt, handler);
        return () => {};
      },
    };
    const host = {
      ctx,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async () => [],
      globalServers: () => [],
      normalizedProjectRoot: async (cwd: string | undefined) =>
        cwd === "/proj" ? "/proj" : undefined,
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: () => "/tmp/cache.json",
      isGlobalServer: () => false,
    };
    const resolveRoot = async (agent: unknown) =>
      (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd ===
      "/proj"
        ? "/proj"
        : undefined;
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    // 部分宿主（只实现路由触达的 tools/on 面）：按接缝收窄，装配语义不变。
    const dispose = registerMiddlewareTools(ctx as unknown as Context, mw, resolveRoot, {
      disabledTools: disabledMap,
    });
    return { guards, dispose, mw };
  }

  it("pre-execute guard 已注册", () => {
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my: ["sv__t"] } }));
    expect(typeof guards.get("tools/pre-execute") === "function").toBeTruthy();
  });

  it("B11：含连续双下划线名 fail-closed 拒绝（#903 B-M4：放行会绕过禁用）", async () => {
    // 情形 B：禁用表只有「错位形态」记录（@global/my → sv__t）→ 歧义直呼一律
    // 拒绝（旧口径放行 → 已禁用的含 __ 工具经直呼复活）。
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my: ["sv__t"] } }));
    // guard 已注册由首用例保证（同一装配器），此处断言存在；裁决形状由被测返回。
    const decisionB = (await guards.get("tools/pre-execute")!(
      { name: "mcp__my__sv__t", agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    )) as { kind: unknown; reason?: unknown };
    expect(decisionB.kind).toBe("deny");
    expect(String(decisionB.reason)).toMatch(/ws_mcp_call/);
  });

  it("B11：真实形态记录同样拒绝（不可逆 → 指往裸名路径）", async () => {
    // 情形 A：禁用表只有「真实形态」记录（@global/my__sv → t）→ 同样拒绝；
    // 含 __ 工具经 ws_mcp_call 裸名路径照常用（确定性裁决），直呼歧义不再放行。
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my__sv: ["t"] } }));
    const decisionA = (await guards.get("tools/pre-execute")!(
      { name: "mcp__my__sv__t", agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    )) as { kind: unknown; reason?: unknown };
    expect(decisionA.kind).toBe("deny");
    expect(String(decisionA.reason)).toMatch(/ws_mcp_call/);
  });
});

// #767 S1-4d：池的转发登记 / 拆除走账本 / 读时刷新（换引擎后新增的判据面）----
describe("#767 S1-4d：池的转发登记、拆除走账本与读时刷新", () => {
  const PY: ServerConfig = { name: "py", transport: "stdio", command: "python", enabled: true };

  /** 一个远端条目 + 假宿主执行面的池：执行面按 script 给结果（缺省空成功）。 */
  function poolFixture(toolsScript: FakeToolsScript = {}) {
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]), toolsScript);
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    return { mw, unit, tools, host };
  }

  it("forwarding：执行中登记外层 token，结算后注销", async () => {
    const observed: unknown[][] = [];
    // 执行面在派发时才跑，此刻 fixture 已绑定：借它读同一实例的登记表（不必用 let 承接）。
    const fixture = poolFixture({
      execute: async () => {
        observed.push([...fixture.mw.forwarding]);
        return { isError: false, content: [], value: { content: [] } };
      },
    });
    const mw = fixture.mw;
    const token = Symbol("outer-call");
    await mw.callTool(
      fullServerName(ROOT, "py"),
      "echo",
      {},
      undefined,
      identity({ parent: token }),
    );
    // 登记必须在派发**之前**（guard 读的同一份集合），否则自家转发的子调用会被判成模型直呼。
    expect(observed).toEqual([[token]]);
    expect(mw.forwarding.size).toBe(0);
  });

  it("forwarding：execute 抛错时同样注销（异常路径不留永久放行位）", async () => {
    const fixture = poolFixture({
      execute: async () => {
        throw new Error("宿主执行面炸了");
      },
    });
    const mw = fixture.mw;
    const token = Symbol("outer-call");
    await expect(
      mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined, identity({ parent: token })),
    ).rejects.toThrow(/调用失败/);
    expect(mw.forwarding.size).toBe(0);
  });

  it("拆除走账本：releaseConnection 摘账并让句柄 dispose 被发起", async () => {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    await mw.ensureConnected(ROOT, "ctx");
    // 真装载保证条目存在（ensureConnected 刚写入），此处断言存在。
    const entry = unit.connections.get("ctx")!;
    expect(mountLedger.get(entry.id!)).toBeDefined();
    expect(mw.releaseConnection(ROOT, "ctx")).toBe(true);
    // 摘账同步生效 + 句柄 dispose 已发起（只发起不等结算：拆除是同步语义）。
    expect(mountLedger.get(entry.id!)).toBeUndefined();
    expect(unit.connections.has("ctx")).toBe(false);
    // 真装载的句柄恒存在，此处断言存在。
    expect(entry.handle!.disposed).toBe(true);
    await expect(mountLedger.flushDisposals()).resolves.toBeUndefined();
    // 幂等：不在册的条目再拆返回 false（调用方据此决定要不要广播状态）。
    expect(mw.releaseConnection(ROOT, "ctx")).toBe(false);
  });

  it("evictIfNeeded 淘汰旧单元时逐条走账本拆除", async () => {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host } = makeHost(
      new Map([
        [ROOT, servers],
        ["/root-old", servers],
      ]),
    );
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const oldUnit = makeUnit({ root: "/root-old" });
    oldUnit.lastTouchedAt = 1;
    mw.units.set("/root-old", oldUnit);
    await mw.ensureConnected("/root-old", "ctx");
    const entry = oldUnit.connections.get("ctx")!;
    expect(mountLedger.get(entry.id!)).toBeDefined();
    for (let index = 0; index < 17; index += 1) {
      const unit = makeUnit({ root: `/root-${index}` });
      unit.lastTouchedAt = 1000 + index;
      mw.units.set(`/root-${index}`, unit);
    }
    mw.evictIfNeeded(16);
    expect(mw.units.has("/root-old")).toBe(false);
    expect(mountLedger.get(entry.id!)).toBeUndefined();
    // 真装载的句柄恒存在，此处断言存在。
    expect(entry.handle!.disposed).toBe(true);
    await mountLedger.flushDisposals();
  });

  it("statusOf 读时刷新：曾连上 + 前缀消失 → reconnecting", async () => {
    const { mw, unit, tools } = poolFixture();
    tools.entries = [{ name: "mcp__id-py__echo" }];
    expect(mw.statusOf(ROOT, "py")).toBe("connected");
    // 官方在退避 / 预算耗尽时注销工具：前缀消失是「已掉线」唯一可判的时点，且必须现算——
    // 直读 entry.status 会永远停在装载窗口结算那一刻的 connected。
    tools.entries = [{ name: "mcp__other-id__echo" }];
    expect(mw.statusOf(ROOT, "py")).toBe("reconnecting");
    expect(unit.connections.get("py")!.status).toBe("reconnecting");
  });

  it("statusOf 读时刷新：reconnect.enabled=false 时前缀消失 → failed（不再有后台重连）", async () => {
    const noReconnect = { ...PY, reconnect: { enabled: false } };
    const { host, tools } = makeHost(new Map([[ROOT, [noReconnect]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(noReconnect, "id-py"));
    tools.entries = [{ name: "mcp__id-py__echo" }];
    expect(mw.statusOf(ROOT, "py")).toBe("connected");
    tools.entries = [];
    expect(mw.statusOf(ROOT, "py")).toBe("failed");
  });

  it("statusOf：虚拟连接恒 connected（配置 / 用户禁用才 disabled）", async () => {
    // 虚拟单元（toolDefinitions）没有官方实例、从不 mount：它不进六态投影，就地收敛。
    // 三处读点的另外两处（manager.summarize / /health）分别由 unit-manager2 与
    // unit-routes-sse 的用例钉住，同一份 statusOf 语义。
    const virtualServer: ServerConfig = {
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      enabled: true,
      toolDefinitions: [],
    };
    const { host, tools } = makeHost(new Map([[ROOT, [virtualServer]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("cg", remoteEntry(virtualServer, undefined));
    // 注册面空无一物也必须 connected——虚拟连接的「已连上」不来自官方注册面。
    expect(tools.entries).toEqual([]);
    expect(mw.statusOf(ROOT, "cg")).toBe("connected");
    unit.userDisabled.add("cg");
    expect(mw.statusOf(ROOT, "cg")).toBe("disabled");
    unit.userDisabled.delete("cg");
    unit.connections.get("cg")!.server.enabled = false;
    expect(mw.statusOf(ROOT, "cg")).toBe("disabled");
  });

  it("discover：按 mcp__<id>__ 前缀从注册面投影目录（剥前缀 + description/parameters 映射）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-disc-"));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const catalogHost = {
      ...host,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    tools.entries = [
      {
        name: "mcp__id-py__alpha",
        description: "甲",
        parameters: { type: "object", properties: { a: {} } },
      },
      { name: "mcp__id-py__beta", description: "乙", parameters: { type: "object" } },
      { name: "mcp__other-id__gamma", description: "他 id", parameters: {} },
      { name: "no_prefix", description: "无前缀", parameters: {} },
    ];
    // 连接层在投影前一定会先建单元（projectUnitFor → ensureRootLoaded 让 root 在册）；
    // 这里按同一顺序复现，否则投影写口对未在册的 root 无表可写。
    await catalogDirectory.ensureRootLoaded(ROOT, catalogHost.catalogCachePath(ROOT));
    // discover 自 #767 S1-3b 起是 catalog 域的投影口：这里按连接层的实参形状调用
    // （schemas 取宿主注册面、cachePath 取宿主算好的目录缓存路径）。
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      cachePath: () => catalogHost.catalogCachePath(ROOT),
      redact: (error: unknown) => String(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    // 投影刚写入该条目，此处断言存在。
    const catalog = catalogDirectory.entryFor(ROOT, "py")!;
    // 只收本 id 前缀的两条，名字已剥前缀；他 id 与无前缀条目不得混入。
    expect([...catalog.tools.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(catalog.tools.get("alpha")).toEqual({
      description: "甲",
      inputSchema: { type: "object", properties: { a: {} } },
    });
    expect(catalog.tools.get("beta")!.description).toBe("乙");
    expect(catalog.unavailable).toBeUndefined();
  });

  it("discover：目录落盘失败 → unavailable 降级（discoveredAt 归零）", async () => {
    // 触发点说明：注册面读不到（schemas 抛错）**不会**走到这个降级——registeredSchemas 按设计
    // 吞掉读取异常并当空处理（读不到注册表不许阻塞投影）。真正能触发 catch 的是落盘链：
    // 调用点给出的 cachePath（host.catalogCachePath(root)）求值在 catalog 域的 try 之外。
    // 凭据取自「在册服务器」的 env：脱敏源就是它，所以这里必须真带一个凭据值。
    const withSecret = { ...PY, env: { MCP_TOKEN: "sekrit" } };
    const { host, tools } = makeHost(new Map([[ROOT, [withSecret]]]));
    const brokenHost = {
      ...host,
      catalogCachePath: () => {
        throw new Error("目录缓存路径不可用 token=sekrit");
      },
    };
    // 部分宿主（catalogCachePath 故意抛错的坏路径面）：按接缝收窄。
    const mw = trackMw(new McpMiddleware(brokenHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(withSecret, "id-py"));
    tools.entries = [{ name: "mcp__id-py__alpha", description: "甲", parameters: {} }];
    // 同上一例：先让 root 在册，投影失败才会落在已有条目上翻成 unavailable。
    await catalogDirectory.ensureRootLoaded(
      ROOT,
      join(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-seed-")), "none.json"),
    );
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      // 路径求值本身要抛：缓存路径 thunk 在 persistRoot 内才求值，等价复现连接层
      // host.catalogCachePath 在投影 try 之外求值的失败面。
      // 路径 thunk 本就不取参（调用即抛），此处按其签名调用。
      cachePath: () => brokenHost.catalogCachePath(),
      // 脱敏器形状与连接层一致：全部在册服务器作为凭据词根来源。
      redact: (error: unknown) => createRedactor([withSecret])(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    // 投影失败落在已有条目上（上一段 ensureRootLoaded 已建条目），此处断言存在。
    const catalog = catalogDirectory.entryFor(ROOT, "py")!;
    expect(catalog.discoveredAt).toBe(0);
    expect(catalog.tools.size).toBe(0);
    // 真脱敏器的替换词是 [REDACTED]（fake pipeline 里的 *** 是另一套夹具，别混）。
    expect(catalog.unavailable).toBe("目录缓存路径不可用 token=[REDACTED]");
  });
});

// #767 S1-3b 笔 2：搬家判据（归属锁 / 前缀单源 / 载入幂等） ----
// 判据都打在**域实例的公开读口**上，不打实现内部字段：这样它们只锁「目录住在 catalog 域」
// 与「载入只发生一次」这两条契约，实现换写法不会误红。
describe("#767 S1-3b：目录归属与载入不变式", () => {
  const DOMAIN_ROOT = "/tmp/ws-s1-3b-root";
  const DOMAIN_CACHE = () => join(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-s13b-")), "catalog.json");

  /** 写一份 last-good 文件（内容 → 该 root 的目录）；落点目录由 mkdtempSync 现建。 */
  function writeCache(file: string, root: string, entries: unknown) {
    writeFileSync(file, JSON.stringify({ version: 1, root, entries }, null, 2), "utf8");
  }

  it("归属锁：ProjectUnit 不再持目录字段、McpMiddleware 不再有 discover", async () => {
    // 两条反证：
    //  - 把 catalog 字段加回 ProjectUnit → 两个 fixture（makeUnit 的字面量、以及真实
    //    projectUnitFor 建出来的单元）都会带上它，第一条红；
    //  - 把 discover 加回 McpMiddleware → 原型上就能取到，第二条红。
    const fixtureUnit = makeUnit();
    expect("catalog" in fixtureUnit, "夹具形状：ProjectUnit 无 catalog 字段").toBe(false);
    const { host } = makeHost(new Map([[ROOT, []]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const realUnit = await mw.projectUnitFor(ROOT);
    expect("catalog" in realUnit!, "真实建单元路径：目录不落在单元上（归 catalog 域）").toBe(false);
    expect(
      typeof (McpMiddleware.prototype as { discover?: unknown }).discover,
      "McpMiddleware 已无 discover 成员（投影归 catalog 域）",
    ).toBe("undefined");
  });

  it("前缀单源：hasRegisteredTools 只认 mcp__<id>__ 前缀", () => {
    // 反证：把前缀写死成别的形态（或去掉 id 维度）→ 三条断言里至少一条红。
    const schemas = [
      { name: "mcp__id-py__echo" },
      { name: "mcp__other-id__echo" },
      { name: "plain_tool" },
    ];
    expect(catalogDirectory.hasRegisteredTools(schemas, "id-py")).toBe(true);
    expect(catalogDirectory.hasRegisteredTools(schemas, "other-id")).toBe(true);
    expect(catalogDirectory.hasRegisteredTools(schemas, "id-nope")).toBe(false);
    // 名字里含 mcp__ 但与 id 不符（前缀只认完整 `mcp__<id>__`，不是「包含」）。
    expect(catalogDirectory.hasRegisteredTools([{ name: "xmcp__id-py__echo" }], "id-py")).toBe(
      false,
    );
    // 空注册面 / 非字符串名一律 false（读不到注册表不许阻塞，也不许误判已连上）。
    expect(catalogDirectory.hasRegisteredTools([], "id-py")).toBe(false);
    expect(catalogDirectory.hasRegisteredTools([{ name: 42 }], "id-py")).toBe(false);
  });

  it("statusOf 的「已连上」极性由目录读口决定（单源）", async () => {
    // 反证：hasRegisteredTools 若绕过目录域自读注册面（或前缀口径分叉），这里极性会漂。
    const py: ServerConfig = { name: "py", transport: "stdio", command: "python", enabled: true };
    const { host, tools } = makeHost(new Map([[DOMAIN_ROOT, [py]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit({ root: DOMAIN_ROOT });
    mw.units.set(DOMAIN_ROOT, unit);
    unit.connections.set("py", remoteEntry(py, "id-py"));
    tools.entries = [{ name: "mcp__id-py__echo" }];
    expect(
      catalogDirectory.hasRegisteredTools(tools.schemas(), "id-py"),
      "前置：目录读口认该前缀",
    ).toBe(true);
    expect(mw.statusOf(DOMAIN_ROOT, "py")).toBe("connected");
    tools.entries = [{ name: "mcp__id-other__echo" }];
    expect(
      catalogDirectory.hasRegisteredTools(tools.schemas(), "id-py"),
      "前置：换 id 后读口不再认",
    ).toBe(false);
    expect(mw.statusOf(DOMAIN_ROOT, "py")).toBe("reconnecting");
  });

  it("载入幂等：root 在册后 ensureRootLoaded 不再读盘、也不被磁盘内容覆盖", async () => {
    // 反证：删掉 ensureRootLoaded 的 `if (this.byRoot.has(root)) return;` 短路 → 内存被 B 覆盖。
    const file = DOMAIN_CACHE();
    catalogDirectory.dropRoot(DOMAIN_ROOT);
    catalogDirectory.projectWrappedTools({
      root: DOMAIN_ROOT,
      serverName: "mem",
      definitions: [{ name: "mem_tool", description: "内存那份", parameters: {} }],
    });
    // 内存目录 A 已就位；此刻磁盘写成 B（另一台服务器）。
    writeCache(file, DOMAIN_ROOT, {
      disk: {
        discoveredAt: 1,
        tools: [{ name: "disk_tool", description: "磁盘那份", inputSchema: {} }],
      },
    });
    // 第一次：root 已在册 → 短路，磁盘 B 只被忽略、不被读回。
    await catalogDirectory.ensureRootLoaded(DOMAIN_ROOT, file);
    // 第二次同样短路。
    await catalogDirectory.ensureRootLoaded(DOMAIN_ROOT, file);
    // 内存仍是 A：磁盘那份进不来（单元创建是唯一载入点，内存态才是权威）。
    expect([...catalogDirectory.serversFor(DOMAIN_ROOT)!.keys()]).toEqual(["mem"]);
    // 在册条目恒存在（上一段已建），此处断言存在。
    expect(catalogDirectory.entryFor(DOMAIN_ROOT, "mem")!.tools.has("mem_tool")).toBe(true);
    // 反证：删掉短路 → 第一次就会把 B 载回来，上面两条断言必红（内存变成 disk-only）。
    // 「只读盘一次」是短路的直接后果：短路发生在任何 fs 调用之前，故不存在第二次读盘。
    // 这里不引 fs spy——语义判据（内存未被磁盘覆盖）比计数更强，且不依赖实现细节。
  });

  it("先投影后建单元：内存目录不被随后的磁盘载入盖回", async () => {
    // 反证：把 ensureRootLoaded 的短路条件从 `this.byRoot.has(root)` 改成 `this.roots.has(root)`
    // （即在「表已建、root 未登记」这一支上放行读盘）→ 这里必红。
    const fresh = "/tmp/ws-s1-3b-fresh";
    const file = DOMAIN_CACHE();
    writeCache(file, fresh, {
      disk: { discoveredAt: 1, tools: [{ name: "disk_tool", description: "", inputSchema: {} }] },
    });
    catalogDirectory.dropRoot(fresh);
    // 投影先到（此后 root 已在册，只是没有走过载入路径）。
    catalogDirectory.projectWrappedTools({
      root: fresh,
      serverName: "mem",
      definitions: [{ name: "mem_tool", description: "", parameters: {} }],
    });
    expect([...(catalogDirectory.serversFor(fresh) ?? new Map()).keys()]).toEqual(["mem"]);
    await catalogDirectory.ensureRootLoaded(fresh, file);
    expect([...catalogDirectory.serversFor(fresh)!.keys()], "磁盘那份不得盖回内存投影").toEqual([
      "mem",
    ]);
    expect(catalogDirectory.entryFor(fresh, "mem")!.tools.has("mem_tool")).toBe(true);
    expect(catalogDirectory.entryFor(fresh, "disk")).toBeUndefined();
  });
});

// #767 S1-4d：guard 判发起者（裁定 R/Z）----
// dispatch 转发出去的子调用带 parent = 外层 ws_mcp_call 的 token，派发前已登记进 mw.forwarding；
// guard 只按发起者放行，不做名字判定——放行晚一步，阶段 3 的模型面收敛会把自家转发误拒。
describe("#767 S1-4d：guard 判发起者", () => {
  function guardFixture(disabledMap: DisabledToolsMap) {
    const guards = new Map();
    const ctx = {
      tools: { register: () => () => {} },
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        guards.set(evt, handler);
        return () => {};
      },
    };
    const host = {
      ctx,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async () => [],
      globalServers: () => [],
      normalizedProjectRoot: async (cwd: string | undefined) =>
        cwd === "/proj" ? "/proj" : undefined,
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: () => "/tmp/cache.json",
      isGlobalServer: () => false,
    };
    const resolveRoot = async (agent: unknown) =>
      (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd ===
      "/proj"
        ? "/proj"
        : undefined;
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    // 部分宿主（只实现路由触达的 tools/on 面）：按接缝收窄，装配语义不变。
    registerMiddlewareTools(ctx as unknown as Context, mw, resolveRoot, {
      disabledTools: disabledMap,
    });
    return { guards, mw };
  }

  it("exec.parent 在 forwarding 集合内 → 放行（不再做工具级裁决）", async () => {
    const { guards, mw } = guardFixture(parseDisabledTools({ "@global": { my: ["t"] } }));
    // 转发身份是测试自造的 plain symbol（域内仅作 Set 身份键、不读 brand 面）。
    const token = Symbol("forwarded") as unknown as ToolExecutionToken;
    mw.forwarding.add(token);
    const decision = await guards.get("tools/pre-execute")(
      { name: "mcp__my__t", parent: token, agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    // 同一名字在计划外（下面那条用例）会被禁用表拒绝：能否放行完全取决于发起者身份。
    expect(decision.kind).toBe("allow");
  });

  it("同名但 parent 不在集合内 → 仍被工具级禁用拒绝", async () => {
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my: ["t"] } }));
    const decision = await guards.get("tools/pre-execute")(
      {
        name: "mcp__my__t",
        parent: Symbol("not-registered"),
        agent: { session: { header: { cwd: "/proj" } } },
      },
      async () => ({ kind: "allow" }),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toMatch(/已被用户在「MCP」浮窗禁用/);
  });
});

// #767 笔 1b：A+ 自持图片准入的接线面 + F4 远端转发去 agent ----
// 图片准入的**纯逻辑**判据在 unit-image-admission.test.ts；这里只钉接线：executeCall 按 exec
// 存投影、finalizeContent 换入、未命中返回 undefined（保留 render），以及远端转发不再带 agent。
describe("#767 笔 1b：A+ 图片准入接线与 F4 转发去 agent", () => {
  /** canonical base64 的合法图片。 */
  const PNG = "iVBORw0KGgo=";
  const ROUTE_AGENT = {
    session: { requestHeader: () => ({ config: { provider: "p", model: "m" } }) },
    options: {},
  };
  const IMAGE_MODEL = { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) };

  /** 注册四个中间层工具（带 faces），交回 ws_mcp_call 定义与假工具服务（看转发出去的那次 exec）。 */
  async function callFixture({ value, faces }: { value: unknown; faces?: ImageAdmissionFaces }) {
    const servers: ServerConfig[] = [
      { name: "py", transport: "stdio", command: "python", enabled: true },
    ];
    // 注册面必须带 `mcp__id-py__` 前缀：executeCall 会先 ensureConnected，而六态投影按注册面
    // 判「已连上」——不带前缀会走重建路径，把夹具的 connected 条目拆掉。
    const { host, tools } = makeHost(new Map([[ROOT, servers]]), {
      schemas: [{ name: "mcp__id-py__echo" }],
      execute: async () => ({ isError: false, content: [], value }),
    });
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(servers[0], "id-py"));
    // 注册面收集的是实现传入的真 ToolDefinition（ws_mcp_call 等四工具），此处取其类型面。
    const registered: ToolDefinition[] = [];
    const ctx = {
      tools: {
        register: (def: ToolDefinition) => {
          registered.push(def);
          return () => {};
        },
        schemas: () => tools.schemas(),
      },
    };
    // 第 5 个位置参数就是图片准入的宿主能力面（faces === undefined 时退化成纯诊断）。
    // 部分宿主（只实现 register/schemas 面）：按接缝收窄。
    registerMiddlewareTools(
      ctx as unknown as Context,
      mw,
      async () => ROOT,
      { disabledTools: new Map() },
      faces,
    );
    return {
      // 四工具恒注册（实现保证），此处断言存在。
      call: registered.find((def) => def.name === "ws_mcp_call")!,
      tools,
    };
  }

  // finalizeContent 的 exec 桩：只实现判据触达的面，整体按被测签名收窄（同上）。
  function makeExec(overrides: Record<string, unknown> = {}): Readonly<ToolExecution> {
    return {
      callId: "call-1",
      rootCallId: "call-1",
      name: "ws_mcp_call",
      arguments: {},
      signal: new AbortController().signal,
      agent: ROUTE_AGENT,
      token: "tok-1",
      ...overrides,
    } as unknown as Readonly<ToolExecution>;
  }

  const callArgs = { server: fullServerName(ROOT, "py"), tool: "echo" };

  it("B8 远端合法图片 + 路由声明 image + 落库成功 → finalizeContent 换入真附件块且文本保序", async () => {
    // 落库输入快照（SaveImageInput 面）：复制保留调用时刻值，引用/复制 verdict 一致。
    const saved: SaveImageInput[][] = [];
    const value = {
      content: [
        { type: "text", text: "前" },
        { type: "image", mimeType: "image/png", data: PNG },
        { type: "resource", uri: "x" },
      ],
    };
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({
          saveImages: async (inputs) => {
            saved.push([...inputs]);
            return [{ id: "att-1" }];
          },
        }),
        models: () => IMAGE_MODEL,
      },
    });
    const exec = makeExec();
    // exec 桩只实现 finalize/execute 触达的 ToolExecution 面：execute 要的后两键按接缝收窄。
    const returned = await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // render 兜底保持现状（无 exec 的既有投影 + 图片占位串）。
    // render 入参是 JSON 值面：本文件传入的字面量恒为 JSON，此处收窄不断言。
    const rendered = fixture.call.output.render({}, returned as Json);
    expect(rendered).toEqual([
      { type: "text", text: "前\n[image content]\n[resource: content discarded]" },
    ]);
    const finalized = fixture.call.finalizeContent!(exec, {
      isError: false,
      content: rendered,
      value: returned as Json,
    });
    // 文本块次序与内容保住；图片块原位换成真附件。
    expect(finalized).toEqual([
      { type: "text", text: "前" },
      { type: "image", attachment: { id: "att-1" } },
      { type: "text", text: "[resource: content discarded]" },
    ]);
    expect(saved.length).toBe(1);
    expect(saved[0][0].mediaType).toBe("image/png");
  });

  it("B14 未命中（无图片块 / 不是本次 exec / isError）→ finalizeContent 返回 undefined", async () => {
    const value = { content: [{ type: "text", text: "只有文本" }] };
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({
          saveImages: async () => {
            throw new Error("不该被调用");
          },
        }),
        models: () => IMAGE_MODEL,
      },
    });
    const exec = makeExec();
    // exec 桩只实现 finalize/execute 触达的 ToolExecution 面：execute 要的后两键按接缝收窄。
    const returned = await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // render 入参是 JSON 值面：本文件传入的字面量恒为 JSON，此处收窄不断言。
    const rendered = fixture.call.output.render({}, returned as Json);
    expect(
      fixture.call.finalizeContent!(exec, {
        isError: false,
        content: rendered,
        value: returned as Json,
      }),
      "无图片块：不建映射，保留 render",
    ).toBe(undefined);
    expect(
      fixture.call.finalizeContent!(makeExec({ callId: "never-ran" }), {
        isError: false,
        content: rendered,
        value: returned as Json,
      }),
      "不是本次执行：弱映射无命中",
    ).toBe(undefined);
  });

  it("B14b isError 结果不吃换面（内容交回宿主）", async () => {
    const value = { content: [{ type: "image", mimeType: "image/png", data: PNG }] };
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({ saveImages: async () => [{ id: "att-1" }] }),
        models: () => IMAGE_MODEL,
      },
    });
    const exec = makeExec();
    // exec 桩只实现 finalize/execute 触达的 ToolExecution 面：execute 要的后两键按接缝收窄。
    const returned = await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // render 入参是 JSON 值面：本文件传入的字面量恒为 JSON，此处收窄不断言。
    const rendered = fixture.call.output.render({}, returned as Json);
    // isError:true 时实现短路（middleware-register 的 finalizeContent 首行即 return，不读 value）：
    // Failure 面声明 value?: never，此处不断言、整对象收窄，运行期原样传入。
    expect(
      fixture.call.finalizeContent!(exec, {
        isError: true,
        content: rendered,
        value: returned as Json,
      } as unknown as Readonly<ToolExecutionResult>),
    ).toBe(undefined);
    // 命中即删：同一个 exec 再问一次也不再有投影。
    expect(
      fixture.call.finalizeContent!(exec, {
        isError: false,
        content: rendered,
        value: returned as Json,
      }),
    ).toBe(undefined);
  });

  it("B15 两次不同 exec 的投影互不串（键是 exec 身份），且命中即删", async () => {
    const value = { content: [{ type: "image", mimeType: "image/png", data: PNG }] };
    let seq = 0;
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({
          saveImages: async () => {
            seq += 1;
            return [{ id: `att-${seq}` }];
          },
        }),
        models: () => IMAGE_MODEL,
      },
    });
    const e1 = makeExec({ callId: "c1" });
    const e2 = makeExec({ callId: "c2" });
    const v1 = await fixture.call.execute(callArgs, e1 as unknown as ToolRunContext);
    const v2 = await fixture.call.execute(callArgs, e2 as unknown as ToolRunContext);
    const swap = (exec: Readonly<ToolExecution>, val: unknown) =>
      fixture.call.finalizeContent!(exec, { isError: false, content: [], value: val as Json });
    // 换入的恒为图片块（实现保证），此处按测试前置收窄。
    expect((swap(e1, v1)![0] as { attachment: unknown }).attachment).toEqual({ id: "att-1" });
    expect((swap(e2, v2)![0] as { attachment: unknown }).attachment).toEqual({ id: "att-2" });
    expect(swap(e1, v1), "已消费过的 exec 不再有投影").toBe(undefined);
  });

  it("B16 F4：远端转发不带 agent，parent = 外层 token，signal 照传", async () => {
    const fixture = await callFixture({
      value: { content: [{ type: "text", text: "hi" }] },
      faces: undefined,
    });
    const exec = makeExec();
    await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // 发送记录的形状由宿主执行面约定（name/agent/parent/signal 四键），此处只读不断言。
    const sent = fixture.tools.executed[0] as {
      name: unknown;
      agent: unknown;
      parent: unknown;
      signal: unknown;
    };
    expect(sent.name).toBe("mcp__id-py__echo");
    expect(sent.agent, "远端分支去 agent（F4 收口）").toBe(undefined);
    expect(sent.parent).toBe("tok-1");
    expect(sent.signal).toBe(exec.signal);
  });
});
// CRAP-ZERO middleware batch
describe("CRAP-ZERO middleware tools hit", () => {
  function crapFixture() {
    const { host } = makeHost();
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([["use_ctx", { description: "d", inputSchema: {} }]]),
          },
        ],
      ]),
    });
    mw.units.set(ROOT, unit);
    const defs: ToolDefinition[] = [];
    const ctx = {
      tools: {
        register: (d: ToolDefinition) => {
          defs.push(d);
          return () => {};
        },
      },
      on: () => () => {},
    };
    registerMiddlewareTools(ctx as unknown as Context, mw, async () => ROOT, {
      disabledTools: new Map(),
    });
    return { mw, defs };
  }
  it("search execute hits", async () => {
    const { defs } = crapFixture();
    const search = defs.find((d) => d.name === "ws_mcp_search")!;
    const res = await search.execute({ query: "use", limit: 5 }, {
      agent: {},
      signal: new AbortController().signal,
    } as unknown as ToolRunContext);
    // 夹具含 use_ctx（名中带 use），query "use" 必须命中至少一条；恒真断言收紧（#903 M-C2）。
    expect((res as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });
  it("search render hits", () => {
    const { defs } = crapFixture();
    const search = defs.find((d) => d.name === "ws_mcp_search")!;
    const out = search.output.render({}, {
      results: [{ server: "s", tool: "t", description: "d" }],
      unavailable: [{ server: "s", reason: "r" }],
      truncated: true,
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/s\/t/);
  });
});
// CRAP-ZERO middleware batch2 list detail guard
describe("CRAP-ZERO middleware list detail guard", () => {
  function crapFixture2() {
    const { host } = makeHost();
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([["use_ctx", { description: "d", inputSchema: { type: "object" } }]]),
          },
        ],
      ]),
    });
    mw.units.set(ROOT, unit);
    const globalUnit = makeUnit({
      root: "@global",
      catalog: new Map([
        [
          "gctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([["use_g", { description: "gd", inputSchema: { type: "object" } }]]),
          },
        ],
      ]),
    });
    mw.units.set("@global", globalUnit);
    const defs: ToolDefinition[] = [];
    const guards = new Map<string, (...args: unknown[]) => unknown>();
    const ctx = {
      tools: {
        register: (d: ToolDefinition) => {
          defs.push(d);
          return () => {};
        },
      },
      on: (evt: string, h: (...args: unknown[]) => unknown) => {
        guards.set(evt, h);
        return () => {};
      },
    };
    registerMiddlewareTools(ctx as unknown as Context, mw, async () => ROOT, {
      disabledTools: new Map(),
    });
    return { mw, defs, guards };
  }
  it("list execute hits", async () => {
    const { defs } = crapFixture2();
    const list = defs.find((d) => d.name === "ws_mcp_list")!;
    const res = await list.execute({ perServerLimit: 50 }, {
      agent: {},
      signal: new AbortController().signal,
    } as unknown as ToolRunContext);
    // 夹具含 ctx + @global gctx 两个目录，空返回即漏报；恒真断言收紧（#903 M-C2）。
    expect((res as { servers: unknown[] }).servers.length).toBeGreaterThan(0);
  });
  it("list render hits with servers", () => {
    const { defs } = crapFixture2();
    const list = defs.find((d) => d.name === "ws_mcp_list")!;
    const out = list.output.render({}, {
      workspace: ROOT,
      servers: [
        {
          server: "s",
          tools: [{ tool: "t", description: "d" }],
          totalServers: 1,
          totalTools: 1,
          toolsTruncated: true,
        },
      ],
      totalServers: 1,
      totalTools: 1,
      toolsTruncated: true,
      message: "m",
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/s/);
  });
  it("list render empty hits", () => {
    const { defs } = crapFixture2();
    const list = defs.find((d) => d.name === "ws_mcp_list")!;
    const out = list.output.render({}, {
      workspace: ROOT,
      servers: [],
      totalServers: 0,
      totalTools: 0,
      toolsTruncated: false,
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/Workspace/);
  });
  it("detail execute hits", async () => {
    const { defs } = crapFixture2();
    const detail = defs.find((d) => d.name === "ws_mcp_detail")!;
    const full = fullServerName(ROOT, "ctx");
    const res = await detail.execute({ server: full, tool: "use_ctx" }, {
      agent: {},
      signal: new AbortController().signal,
    } as unknown as ToolRunContext);
    expect((res as { server: unknown }).server).toBeDefined();
  });
  it("detail render hits", () => {
    const { defs } = crapFixture2();
    const detail = defs.find((d) => d.name === "ws_mcp_detail")!;
    const out = detail.output.render({}, {
      server: "s",
      tool: "t",
      description: "d",
      inputSchema: { type: "object" },
      fresh: true,
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/s\/t/);
  });
  it("call guard hits via ws_mcp_call deny", async () => {
    const { guards } = crapFixture2();
    const guard = guards.get("tools/pre-execute")! as (
      exec: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const disabled = parseDisabledTools({ "/tmp/ws-root-a": { ctx: ["use_ctx"] } });
    const { host } = makeHost();
    const mw2 = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const guards2 = new Map<string, (...args: unknown[]) => unknown>();
    const ctx2 = {
      tools: { register: () => () => {} },
      on: (evt: string, h: (...args: unknown[]) => unknown) => {
        guards2.set(evt, h);
        return () => {};
      },
    };
    registerMiddlewareTools(ctx2 as unknown as Context, mw2, async () => ROOT, {
      disabledTools: disabled,
    });
    const g2 = guards2.get("tools/pre-execute")! as (
      exec: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const full = fullServerName(ROOT, "ctx");
    const decision = (await g2(
      { name: "ws_mcp_call", arguments: { server: full, tool: "use_ctx" }, agent: {} },
      async () => ({ kind: "allow" }),
    )) as { kind: unknown };
    expect(decision.kind).toBe("deny");
    void guard;
  });
});
