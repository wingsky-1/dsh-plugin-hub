/**
 * dsh-mcp-manager middleware unit：dispatch-runtime 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mountLedger } from "../../src/server/servers/lifecycle/interface.ts";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DisabledToolsMap } from "../../src/server/store/interface.ts";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
type Json = Parameters<ToolDefinition["output"]["render"]>[1];
import type { ServerConfig } from "../../src/server/config/interface.ts";

// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");

beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");
const { parseDisabledTools } = await import("../../src/server/store/interface.ts");

const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const remoteEntry = middlewareShape.remoteEntry.bind(middlewareShape);
const identity = middlewareShape.identity.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);
const ownTempDir = middlewareShape.ownTempDir.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

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
    const poolLoader = middlewareShape.poolLoader;
    const mountsBefore = poolLoader.calls.filter((call) => call[0] === "mount").length;
    await mw.ensureConnected(ROOT, "ctx");
    expect(unit.connections.get("ctx")).toBe(entry);
    expect(poolLoader.calls.filter((call) => call[0] === "mount").length).toBe(mountsBefore);
  });

  it("force 重建：先 disposeServer(oldId) 再 mount（旧句柄 dispose 早于新装载）", async () => {
    const { mw, unit, entry } = await halfOpenFixture();
    const poolLoader = middlewareShape.poolLoader;
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

function registerRuntimeVirtualConnectionCases() {
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
    const poolLoader = middlewareShape.poolLoader;
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
}

function registerRuntimeDirectCallCases() {
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
}

function registerRuntimeDisableErrorCases() {
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
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-wrapped-")));
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
}
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
describe("#413：runtime 封装定义服务器中间层直呼", () => {
  registerRuntimeVirtualConnectionCases();
  registerRuntimeDirectCallCases();
  registerRuntimeDisableErrorCases();
});

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
      catalogCachePath: middlewareShape.catalogCachePath,
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

describe("#1014 B5：我方转发的豁免身份由 dispatch 自然产生", () => {
  it("execute 被调用时 parent 已在 forwarding 内，调用结束后已摘除", async () => {
    const servers: ServerConfig[] = [
      { name: "py", transport: "stdio", command: "python", enabled: true },
    ];
    const TOKEN = Symbol("outer-call") as unknown as ToolExecutionToken;
    let parentSeen: unknown;
    let inSetDuringCall: boolean | undefined;
    // execute 闭包要在中间层实例建好**之前**就存在（实例依赖 makeHost 产出的 host），
    // 故经 holder 间接取；execute 被调用时实例早已就位。
    const holder: { mw?: InstanceType<typeof McpMiddleware> } = {};
    const { host } = makeHost(new Map([[ROOT, servers]]), {
      schemas: [{ name: "mcp__id-py__echo" }],
      execute: async (input: unknown) => {
        const parent = (input as { parent?: unknown }).parent;
        parentSeen = parent;
        inSetDuringCall =
          parent !== undefined && holder.mw?.forwarding.has(parent as ToolExecutionToken) === true;
        return { isError: false, content: [], value: { content: [] } };
      },
    });
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    holder.mw = mw;
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(servers[0], "id-py"));
    const registered: ToolDefinition[] = [];
    const ctx = {
      tools: {
        register: (def: ToolDefinition) => {
          registered.push(def);
          return () => {};
        },
        schemas: () => host.ctx.tools.schemas(),
      },
    };
    registerMiddlewareTools(ctx as unknown as Context, mw, async () => ROOT, {
      disabledTools: new Map(),
    });
    const call = registered.find((def) => def.name === "ws_mcp_call")!;
    await call.execute({ server: fullServerName(ROOT, "py"), tool: "echo" }, {
      callId: "call-b5",
      rootCallId: "call-b5",
      name: "ws_mcp_call",
      arguments: {},
      signal: new AbortController().signal,
      token: TOKEN,
      // ToolRunContext 在 ToolExecution 之外另带这两个面；本用例不碰，按接缝补最小实现。
      deferContext: () => {},
      concludeTurn: () => {},
      // callId/rootCallId 是品牌类型，字面量不满足；按接缝收窄到 execute 的第二参位，
      // 不去硬写 ToolRunContext（它随宿主版本变，测试不该跟着改）。
    } as unknown as Parameters<typeof call.execute>[1]);
    expect(parentSeen, "子调用必须带 parent").toBe(TOKEN);
    expect(inSetDuringCall, "execute 被调用时 parent 必须在 forwarding 内").toBe(true);
    expect(mw.forwarding.has(TOKEN), "结算后 finally 必须摘除 token").toBe(false);
  });
});

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
