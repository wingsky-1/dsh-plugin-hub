/**
 * dsh-mcp-manager — unit：servers/dispatch 域（ws_mcp_call 执行器）。
 *
 * 单元层是白盒面：直引新域实现（impl/call 与 impl/redact），不经组合根。覆盖：
 * - 远端分支的参数构造与透传（工具名归一 / 参数归一 / signal / server.toolCallTimeoutMs）；
 * - 封装直呼分支（execute 的 args 与 exec 最小面 / output.render / undefined 不落键）；
 * - 结果投影调用（projectCallToolResult 实参与两个文案回调 / 目录过期前置提示）；
 * - 超时兜底预算（withTimeout 的预算 = 调用预算 + 2000，含缺省预算）；
 * - 凭据脱敏出口（调用/封装失败文案经 createRedactor 抹凭据；signal 中止原样上抛）；
 * - 路由与就绪/策略守卫的错误文案。
 */
import { describe, expect, it } from "vitest";
import { executeMcpCall } from "../../src/server/servers/dispatch/impl/call/index.ts";
import { redactMcpError } from "../../src/server/servers/dispatch/impl/redact/index.ts";
import type {
  DispatchCallInput,
  DispatchPipelinePort,
  DispatchWorkspacePort,
} from "../../src/server/servers/dispatch/deps.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";

const ROOT = "@global";
const SERVER = "srv";
const FULL = ROOT + "/" + SERVER;
const CREDENTIAL = "hunter2";

/** 假 workspace 域：root 按最后一个斜杠切分（与真实实现同形），工具名剥 mcp__ 前缀。 */
function makeWorkspace(): DispatchWorkspacePort {
  return {
    parseFullServerName(full: string) {
      if (!full.startsWith("@")) return undefined;
      const body = full.slice(1);
      const cut = body.lastIndexOf("/");
      if (cut <= 0 || cut === body.length - 1) return undefined;
      return { root: "@" + body.slice(0, cut), server: body.slice(cut + 1) };
    },
    normalizeToolName(_server: string, tool: string) {
      return tool.startsWith("mcp__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
    },
    fullServerName(root: string, server: string) {
      return root + "/" + server;
    },
  } as unknown as DispatchWorkspacePort;
}

interface PipelineCalls {
  normalize: unknown[];
  timeout: Array<{ ms: number; message: string; signal: AbortSignal | undefined }>;
  project: Array<{ result: unknown; handlers: unknown }>;
  redact: Array<ReadonlyArray<ServerConfig>>;
}

/** 假 pipeline 域：记录入参，投影只保 content / structuredContent（够断言调用面）。 */
function makePipeline(overrides: Record<string, unknown> = {}) {
  const calls: PipelineCalls = { normalize: [], timeout: [], project: [], redact: [] };
  const pipeline = {
    normalizeArguments(raw: unknown) {
      calls.normalize.push(raw);
      if (typeof raw === "string") return JSON.parse(raw);
      return raw ?? {};
    },
    async withTimeout(
      promise: Promise<unknown>,
      ms: number,
      message: string,
      signal?: AbortSignal,
    ) {
      calls.timeout.push({ ms, message, signal });
      return await promise;
    },
    msgOf(error: unknown) {
      return error instanceof Error ? error.message : String(error);
    },
    createRedactor(servers: ReadonlyArray<ServerConfig>) {
      calls.redact.push(servers);
      return (error: Error) => error.message.replaceAll(CREDENTIAL, "***");
    },
    isToolDenied() {
      return false;
    },
    policyAllows() {
      return true;
    },
    policyDenialReason() {
      return undefined;
    },
    toolDisabledReason(key: string, tool: string) {
      return "工具 " + key + "/" + tool + " 已被用户在「MCP」浮窗禁用";
    },
    projectCallToolResult(result: unknown, handlers: unknown) {
      calls.project.push({ result, handlers });
      const r = result as { content?: unknown; structuredContent?: unknown };
      return {
        content: r.content ?? [],
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
      };
    },
    defaultCallResultFallbackText() {
      return "（无内容）";
    },
    ...overrides,
  } as unknown as DispatchPipelinePort;
  return { pipeline, calls };
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    server: { name: SERVER, transport: "stdio", command: "echo", enabled: true },
    client: undefined,
    transport: undefined,
    status: "connected",
    error: undefined,
    connectedAt: Date.now(),
    reconnectTimer: undefined,
    disposed: false,
    failedAttempts: 0,
    ...overrides,
  };
}

function makeUnit(
  options: {
    connections?: Map<string, unknown>;
    entry?: Record<string, unknown>;
    catalog?: Map<string, unknown>;
    userDisabled?: Set<string>;
  } = {},
): ProjectUnit {
  return {
    root: ROOT,
    connections: options.connections ?? new Map([[SERVER, makeEntry(options.entry)]]),
    catalog: options.catalog ?? new Map(),
    userDisabled: options.userDisabled ?? new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  } as unknown as ProjectUnit;
}

function makeServers(): ServerConfig[] {
  return [
    {
      name: SERVER,
      transport: "stdio",
      command: "echo",
      enabled: true,
      env: { TOKEN: CREDENTIAL },
    } as unknown as ServerConfig,
  ];
}

function makeInput(options: {
  unit?: ProjectUnit;
  pipeline: DispatchPipelinePort;
  overrides?: Record<string, unknown>;
}): DispatchCallInput {
  return {
    fullName: FULL,
    toolRaw: "echo",
    rawArgs: { a: 1 },
    signal: undefined,
    agent: { session: { header: { cwd: "/proj" } } },
    units: new Map([[ROOT, options.unit ?? makeUnit()]]),
    allServers: makeServers,
    disabledTools: new Map(),
    policy: {},
    catalogTtlMs: 24 * 60 * 60 * 1000,
    defaultCallTimeoutMs: 30000,
    pipeline: options.pipeline,
    workspace: makeWorkspace(),
    ...options.overrides,
  } as unknown as DispatchCallInput;
}

describe("executeMcpCall：远端分支", () => {
  it("工具名归一 + 参数归一 + server.toolCallTimeoutMs 透传给 client", async () => {
    const { pipeline, calls } = makePipeline();
    const seen: unknown[] = [];
    const unit = makeUnit({
      entry: {
        server: {
          name: SERVER,
          transport: "stdio",
          command: "echo",
          enabled: true,
          toolCallTimeoutMs: 5000,
        },
        client: {
          callTool: async (...args: unknown[]) => {
            seen.push(args);
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      },
    });
    const signal = new AbortController().signal;
    const out = await executeMcpCall(
      makeInput({
        unit,
        pipeline,
        overrides: { toolRaw: "mcp__srv__echo", rawArgs: '{"a":1}', signal },
      }),
    );
    expect(seen).toEqual([["echo", { a: 1 }, { signal, timeoutMs: 5000 }]]);
    expect(calls.normalize).toEqual(['{"a":1}']);
    expect(calls.timeout[0].ms).toBe(7000);
    expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("缺省预算走 defaultCallTimeoutMs，兜底 +2000ms", async () => {
    const { pipeline, calls } = makePipeline();
    let timeoutMs: unknown;
    const unit = makeUnit({
      entry: {
        client: {
          callTool: async (_tool: string, _args: unknown, opts: { timeoutMs?: number }) => {
            timeoutMs = opts.timeoutMs;
            return { content: [] };
          },
        },
      },
    });
    await executeMcpCall(makeInput({ unit, pipeline }));
    expect(timeoutMs).toBe(30000);
    expect(calls.timeout[0].ms).toBe(32000);
  });

  it("远端结果交给 projectCallToolResult，两个文案回调口径不变", async () => {
    const { pipeline, calls } = makePipeline();
    const remote = { content: [{ type: "text", text: "hi" }], structuredContent: { n: 1 } };
    const unit = makeUnit({ entry: { client: { callTool: async () => remote } } });
    const out = await executeMcpCall(makeInput({ unit, pipeline }));
    expect(calls.project).toHaveLength(1);
    expect(calls.project[0].result).toBe(remote);
    const handlers = calls.project[0].handlers as {
      errorText: (content: unknown) => string;
      fallbackText: (result: unknown) => string;
    };
    expect(handlers.errorText("boom")).toBe(
      "ws_mcp_call: 远端工具返回错误：boom；可先用 ws_mcp_detail 核对参数 schema 后重试",
    );
    expect(handlers.fallbackText({ content: "raw" })).toBe("raw");
    expect(handlers.fallbackText({})).toBe("（无内容）");
    expect(out).toEqual(remote);
  });

  it("目录过期 → 结果前置过期提示且保留 structuredContent", async () => {
    const { pipeline } = makePipeline();
    const remote = { content: [{ type: "text", text: "hi" }], structuredContent: { n: 1 } };
    const unit = makeUnit({
      catalog: new Map([[SERVER, { discoveredAt: Date.now() - 1000, tools: new Map() }]]),
      entry: { client: { callTool: async () => remote } },
    });
    const out = (await executeMcpCall(
      makeInput({ unit, pipeline, overrides: { catalogTtlMs: 0 } }),
    )) as { content: Array<{ text: string }>; structuredContent: unknown };
    expect(out.content[0].text).toContain("本工具目录已过期");
    expect(out.content[1]).toEqual(remote.content[0]);
    expect(out.structuredContent).toEqual({ n: 1 });
  });

  it("目录不可用（unavailable）不算过期：不前置提示", async () => {
    const { pipeline } = makePipeline();
    const unit = makeUnit({
      catalog: new Map([
        [SERVER, { discoveredAt: Date.now() - 1000, tools: new Map(), unavailable: "连接失败" }],
      ]),
      entry: { client: { callTool: async () => ({ content: [{ type: "text", text: "hi" }] }) } },
    });
    const out = (await executeMcpCall(
      makeInput({ unit, pipeline, overrides: { catalogTtlMs: 0 } }),
    )) as { content: Array<{ text: string }> };
    expect(out.content).toHaveLength(1);
    expect(out.content[0].text).toBe("hi");
  });

  it("client 缺失 → 未就绪错误（不经投影）", async () => {
    const { pipeline, calls } = makePipeline();
    await expect(executeMcpCall(makeInput({ unit: makeUnit(), pipeline }))).rejects.toThrow(
      /未就绪（client 缺失）/,
    );
    expect(calls.project).toHaveLength(0);
  });
});

describe("executeMcpCall：封装直呼分支", () => {
  function wrappedUnit(def: Record<string, unknown>) {
    return makeUnit({
      entry: {
        server: {
          name: SERVER,
          transport: "stdio",
          command: "codegraph",
          enabled: true,
          toolDefinitions: [def],
        },
      },
    });
  }

  it("execute 收归一化 args 与 agent 最小面，output.render 投影 content", async () => {
    const { pipeline, calls } = makePipeline();
    const seen: unknown[][] = [];
    const def = {
      name: "cg_node",
      output: {
        render: (_args: unknown, value: { text: string }) => [
          { type: "text", text: "rendered:" + value.text },
        ],
      },
      execute: async (...args: unknown[]) => {
        seen.push(args);
        return { text: "node" };
      },
    };
    const agent = { session: { header: { cwd: "/proj" } } };
    const out = await executeMcpCall(
      makeInput({
        unit: wrappedUnit(def),
        pipeline,
        overrides: { toolRaw: "cg_node", agent, rawArgs: '{"n":2}' },
      }),
    );
    expect(seen[0][0]).toEqual({ n: 2 });
    expect((seen[0][1] as { agent: unknown }).agent).toBe(agent);
    expect(calls.timeout[0].ms).toBe(32000);
    expect(out).toEqual({
      content: [{ type: "text", text: "rendered:node" }],
      structuredContent: { text: "node" },
    });
  });

  it("无 render → 文本兜底；execute 返回 undefined 时不落 structuredContent 键", async () => {
    const { pipeline } = makePipeline();
    const def = { name: "cg_node", execute: async () => undefined };
    const out = (await executeMcpCall(
      makeInput({ unit: wrappedUnit(def), pipeline, overrides: { toolRaw: "cg_node" } }),
    )) as { content: Array<{ text: string }> };
    expect(Object.hasOwn(out, "structuredContent")).toBe(false);
    expect(out.content).toEqual([{ type: "text", text: "{}" }]);
  });

  it("封装工具不存在 → 明确报错（不调 execute）", async () => {
    const { pipeline } = makePipeline();
    const def = { name: "cg_node", execute: async () => ({ text: "x" }) };
    await expect(
      executeMcpCall(
        makeInput({ unit: wrappedUnit(def), pipeline, overrides: { toolRaw: "nope" } }),
      ),
    ).rejects.toThrow(/不存在（封装定义服务器）/);
  });

  it("封装 execute 抛错 → 封装调用失败文案经脱敏", async () => {
    const { pipeline, calls } = makePipeline();
    const def = {
      name: "cg_node",
      execute: async () => {
        throw new Error("bad " + CREDENTIAL);
      },
    };
    await expect(
      executeMcpCall(
        makeInput({ unit: wrappedUnit(def), pipeline, overrides: { toolRaw: "cg_node" } }),
      ),
    ).rejects.toThrow(/封装调用失败：bad \*\*\*/);
    expect(calls.redact[0]).toEqual(makeServers());
  });
});

describe("executeMcpCall：超时兜底与脱敏出口", () => {
  it("远端调用抛错 → 「调用失败」文案经脱敏出口", async () => {
    const { pipeline, calls } = makePipeline();
    const unit = makeUnit({
      entry: {
        client: {
          callTool: async () => {
            throw new Error("上游拒绝 " + CREDENTIAL);
          },
        },
      },
    });
    await expect(executeMcpCall(makeInput({ unit, pipeline }))).rejects.toThrow(
      /调用失败：上游拒绝 \*\*\*/,
    );
    expect(calls.redact[0]).toEqual(makeServers());
  });

  it("withTimeout 超时 → 预算 +2000ms 且超时文案经脱敏", async () => {
    const { pipeline, calls } = makePipeline({
      withTimeout: async () => {
        throw new Error("ws_mcp_call: 调用超时（30000ms）" + CREDENTIAL);
      },
    });
    const unit = makeUnit({ entry: { client: { callTool: async () => ({ content: [] }) } } });
    await expect(executeMcpCall(makeInput({ unit, pipeline }))).rejects.toThrow(
      /调用超时（30000ms）\*\*\*/,
    );
    expect(calls.redact).toHaveLength(1);
  });

  it("signal 已中止 → 原样上抛 signal.reason（不脱敏）", async () => {
    const { pipeline, calls } = makePipeline();
    const reason = new Error("aborted " + CREDENTIAL);
    const controller = new AbortController();
    controller.abort(reason);
    const unit = makeUnit({
      entry: {
        client: {
          callTool: async () => {
            throw new Error("x");
          },
        },
      },
    });
    await expect(
      executeMcpCall(makeInput({ unit, pipeline, overrides: { signal: controller.signal } })),
    ).rejects.toBe(reason);
    expect(calls.redact).toHaveLength(0);
  });

  it("redactMcpError：用传入服务器表建脱敏器并抹凭据", () => {
    const { pipeline, calls } = makePipeline();
    const servers = makeServers();
    const out = redactMcpError(pipeline, servers, "token=" + CREDENTIAL);
    expect(out).toBe("token=***");
    expect(calls.redact[0]).toEqual(servers);
  });
});

describe("executeMcpCall：路由与就绪/策略守卫", () => {
  it("全名非法 → 格式错误", async () => {
    const { pipeline } = makePipeline();
    await expect(
      executeMcpCall(makeInput({ pipeline, overrides: { fullName: "srv" } })),
    ).rejects.toThrow(/格式应为/);
  });

  it("root 未激活 → 提示先搜索/列举", async () => {
    const { pipeline } = makePipeline();
    await expect(
      executeMcpCall(makeInput({ pipeline, overrides: { units: new Map() } })),
    ).rejects.toThrow(/未激活；请先 ws_mcp_search 或 ws_mcp_list/);
  });

  it("entry 缺失 → 未连接提示", async () => {
    const { pipeline } = makePipeline();
    const unit = makeUnit({ connections: new Map() });
    await expect(executeMcpCall(makeInput({ unit, pipeline }))).rejects.toThrow(
      /未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接/,
    );
  });

  it("userDisabled → GUI 重连提示", async () => {
    const { pipeline } = makePipeline();
    const unit = makeUnit({
      entry: { status: "failed" },
      userDisabled: new Set([SERVER]),
    });
    await expect(executeMcpCall(makeInput({ unit, pipeline }))).rejects.toThrow(
      /已被用户禁用；可先在 GUI「MCP」浮窗中重新连接/,
    );
  });

  it("reconnecting → 后台重连提示", async () => {
    const { pipeline } = makePipeline();
    const unit = makeUnit({ entry: { status: "reconnecting" } });
    await expect(executeMcpCall(makeInput({ unit, pipeline }))).rejects.toThrow(
      /连接失败、正在后台重连；请稍后重试或重新连接/,
    );
  });

  it("connecting → 连接进行中提示", async () => {
    const { pipeline } = makePipeline();
    const unit = makeUnit({ entry: { status: "connecting" } });
    await expect(executeMcpCall(makeInput({ unit, pipeline }))).rejects.toThrow(
      /连接仍在进行，请稍后重试；连接完成后再调用/,
    );
  });

  it("策略拒绝 → 附 middlewarePolicy 调整提示", async () => {
    const { pipeline } = makePipeline({ isToolDenied: () => true, policyAllows: () => false });
    await expect(executeMcpCall(makeInput({ pipeline }))).rejects.toThrow(
      /被策略拒绝；如需放行请调整 middlewarePolicy 配置/,
    );
  });

  it("工具级禁用（策略放行） → 禁用文案", async () => {
    const { pipeline } = makePipeline({ isToolDenied: () => true });
    await expect(executeMcpCall(makeInput({ pipeline }))).rejects.toThrow(
      /已被用户在「MCP」浮窗禁用/,
    );
  });

  it("策略拒绝优先用 policyDenialReason 给的文案", async () => {
    const { pipeline } = makePipeline({
      isToolDenied: () => true,
      policyAllows: () => false,
      policyDenialReason: () => "ws_mcp_call: 工具被细则拒绝",
    });
    await expect(executeMcpCall(makeInput({ pipeline }))).rejects.toThrow(
      /工具被细则拒绝；如需放行请调整 middlewarePolicy 配置/,
    );
  });
});
