/**
 * middleware 单元测试的专属 support。
 *
 * 组合端口由各测试文件显式装卸；每个文件创建自己的 support 实例，按用例回收
 * middleware、池装载账本与临时目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { expandServerEnv } from "../../src/server/config/impl/env/index.ts";
import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";
import { McpMiddleware } from "../../src/server/connection/runtime/interface.ts";
import { registerMiddlewareTools } from "../../src/server/inject/interface.ts";
import { OFFICIAL_MCP_CLIENT_SPECIFIER } from "../../src/server/shared/interface.ts";
import {
  installLifecycle,
  mountLedger,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  fakeLoaderPort,
  fakeLogsPort,
  fakeToolsService,
  installCompositionPorts,
  releaseCompositionPorts,
  tempCatalogCache,
} from "../helpers.ts";
import type { FakeToolEntry, FakeToolsScript } from "../helpers.ts";
import type { LoaderPort, LogsPort } from "../../src/server/shared/interface.ts";
import type {
  ConnectionEntry,
  McpMiddleware as McpMiddlewareType,
  ProjectUnit,
} from "../../src/server/connection/runtime/interface.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { ToolsRegistryPort } from "../../src/server/servers/lifecycle/deps.ts";
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionToken,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { ScheduledToolDispatch, ToolExecutionSource } from "@deepseek-ai/dsh-tools/pipeline";
import type { ServerConfig } from "../../src/server/config/interface.ts";

export const MIDDLEWARE_SHAPE_ROOT = "/tmp/ws-root-a";
export const MIDDLEWARE_SHAPE_OFFICIAL_MODULE = { name: "test:official", apply: () => {} };

/** 显式装配 composition 外层端口；调用方负责在 beforeAll / afterAll 配对。 */
export function installMiddlewareShapeComposition() {
  installCompositionPorts();
}

export function releaseMiddlewareShapeComposition() {
  releaseCompositionPorts();
}

export interface SeedTool {
  description?: string;
  inputSchema?: unknown;
}

export type SeedCatalogMap = Map<string, { unavailable?: string; tools: Map<string, SeedTool> }>;

export interface DiskSeedEntry {
  discoveredAt: number;
  tools: Map<string, SeedTool>;
  unavailable?: string;
}

export interface MiddlewareShapeSupport {
  readonly root: string;
  makeHost(
    serversByRoot?: Map<string, ServerConfig[]>,
    toolsScript?: FakeToolsScript,
  ): ReturnType<typeof makeHostFactory>;
  installPoolLifecycle(): void;
  readonly poolLoader: ReturnType<typeof fakeLoaderPort>;
  readonly officialModule: typeof MIDDLEWARE_SHAPE_OFFICIAL_MODULE;
  ownTempDir(dir: string): string;
  remoteEntry(
    server: ServerConfig,
    id: string | undefined,
    overrides?: Record<string, unknown>,
  ): ConnectionEntry;
  identity(extra?: Record<string, unknown>): {
    agent?: unknown;
    callId: ToolExecutionInput["callId"];
    rootCallId?: ToolExecutionInput["rootCallId"];
    parent?: ToolExecutionToken;
  };
  trackMw(mw: McpMiddlewareType): McpMiddlewareType;
  seedRoot(root: string, entries: SeedCatalogMap): void;
  seedRootFromDisk(
    root: string,
    entries: Array<[string, DiskSeedEntry]>,
  ): ReturnType<typeof catalogDirectory.ensureRootLoaded>;
  makeUnit(options?: {
    root?: string;
    catalog?: SeedCatalogMap;
    userDisabled?: string[];
    connections?: Map<string, ConnectionEntry>;
  }): ProjectUnit;
  losslessViolation(value: unknown, path?: string): string | undefined;
  cleanup(): Promise<void>;
  readonly catalogCachePath: (root: string) => string;
}

export type GuardHandler = (
  exec: Pick<ToolExecution, "callId" | "name" | "arguments" | "agent" | "parent" | "signal">,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>;

function makeHostFactory(
  support: MiddlewareShapeState,
  serversByRoot: Map<string, ServerConfig[]> = new Map(),
  toolsScript: FakeToolsScript = {},
) {
  const log = { emits: 0, saved: 0 };
  const tools = fakeToolsService(toolsScript);
  support.poolToolsView = () => tools.schemas();
  support.installPoolLifecycle();
  const host = {
    ctx: {
      tools,
      get(name: string) {
        if (name === "loader") {
          return {
            import: async (specifier: string) => {
              if (specifier !== "@deepseek-ai/dsh-tools/pipeline") {
                throw new Error(`unexpected loader import ${specifier}`);
              }
              return toolsScript.pipelineModule ?? tools.defaultPipelineModule;
            },
          };
        }
        return undefined;
      },
    },
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
    catalogCachePath: support.catalogCachePath,
  };
  return { host, log, tools };
}

class MiddlewareShapeState implements MiddlewareShapeSupport {
  readonly root: string;
  readonly trackedMw: McpMiddlewareType[] = [];
  readonly tempDirs: string[] = [];
  poolToolsView: () => FakeToolEntry[] = () => [];
  private poolLoaderValue?: ReturnType<typeof fakeLoaderPort>;
  private lifecycleInstalled = false;
  private catalogCachePathValue: (root: string) => string;

  constructor(root: string) {
    this.root = root;
    this.catalogCachePathValue = tempCatalogCache((dir) => this.ownTempDir(dir));
  }

  ownTempDir(dir: string) {
    this.tempDirs.push(dir);
    return dir;
  }

  makeHost(
    serversByRoot: Map<string, ServerConfig[]> = new Map(),
    toolsScript: FakeToolsScript = {},
  ) {
    return makeHostFactory(this, serversByRoot, toolsScript);
  }

  installPoolLifecycle() {
    if (this.lifecycleInstalled) return;
    this.poolLoaderValue = fakeLoaderPort({
      modules: {
        [OFFICIAL_MCP_CLIENT_SPECIFIER]: MIDDLEWARE_SHAPE_OFFICIAL_MODULE,
      },
    });
    installLifecycle({
      loader: this.poolLoaderValue as unknown as LoaderPort,
      pipeline: { withTimeout },
      workspace: fakeIdTable(),
      config: { expandServerEnv },
      tools: { schemas: () => this.poolToolsView() } as unknown as ToolsRegistryPort,
      logs: fakeLogsPort() as unknown as LogsPort,
    });
    this.lifecycleInstalled = true;
  }

  get poolLoader() {
    if (this.poolLoaderValue === undefined) {
      throw new Error("middleware-shape pool loader has not been installed");
    }
    return this.poolLoaderValue;
  }

  readonly officialModule = MIDDLEWARE_SHAPE_OFFICIAL_MODULE;

  remoteEntry(
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
    } as unknown as ConnectionEntry;
  }

  identity(extra: Record<string, unknown> = {}) {
    const outer = { name: "ws_mcp_call" } as ToolDefinition;
    const toolSet = {
      dispose() {},
      view() {
        return new Map([[outer.name, outer]]);
      },
    };
    return {
      callId: "call-1" as unknown as ToolExecutionInput["callId"],
      parent: Symbol("outer-call") as ToolExecutionToken,
      toolSet,
      ...extra,
    };
  }

  trackMw(mw: McpMiddlewareType) {
    this.trackedMw.push(mw);
    return mw;
  }

  seedRoot(root: string, entries: SeedCatalogMap) {
    catalogDirectory.dropRoot(root);
    for (const [serverName, entry] of entries) {
      if (entry.unavailable !== undefined) {
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

  seedRootFromDisk(root: string, entries: Array<[string, DiskSeedEntry]>) {
    const dir = this.ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-seed-")));
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
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, root, entries: payload }, null, 2),
      "utf8",
    );
    catalogDirectory.dropRoot(root);
    return catalogDirectory.ensureRootLoaded(root, cachePath);
  }

  makeUnit({
    root = this.root,
    catalog = new Map(),
    userDisabled = [],
    connections,
  }: {
    root?: string;
    catalog?: SeedCatalogMap;
    userDisabled?: string[];
    connections?: Map<string, ConnectionEntry>;
  } = {}): ProjectUnit {
    if (catalog.size > 0) this.seedRoot(root, catalog);
    return {
      root,
      connections: connections ?? new Map(),
      userDisabled: new Set(userDisabled),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    };
  }

  losslessViolation(value: unknown, path = "$"): string | undefined {
    if (value === undefined) return `${path} 为 undefined`;
    if (value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = this.losslessViolation(value[i], `${path}[${i}]`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, entry] of Object.entries(value)) {
      const found = this.losslessViolation(entry, `${path}.${key}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async cleanup() {
    for (const mw of this.trackedMw) {
      try {
        await mw.dispose();
      } catch {
        // 收口失败不掩盖用例结论
      }
    }
    this.trackedMw.length = 0;
    if (this.lifecycleInstalled) {
      releaseLifecycle();
      await mountLedger.flushDisposals();
      this.lifecycleInstalled = false;
    }
    for (const dir of this.tempDirs) rmSync(dir, { recursive: true, force: true });
    this.tempDirs.length = 0;
    this.catalogCachePathValue = tempCatalogCache((dir) => this.ownTempDir(dir));
  }

  get catalogCachePath() {
    return this.catalogCachePathValue;
  }
}

export function createMiddlewareShapeSupport(root = MIDDLEWARE_SHAPE_ROOT): MiddlewareShapeSupport {
  return new MiddlewareShapeState(root);
}

function lookupNestedDefinition(
  source: ToolExecutionSource | undefined,
  input: ToolExecutionInput,
) {
  if (source === undefined) return { definition: undefined, rejected: undefined };
  const definition = source.get?.(input.name, input.agent, input.toolSet);
  if (definition === undefined) return { definition, rejected: undefined };
  const rejected = source.reject?.(input.name, input.parent !== undefined);
  return { definition, rejected };
}

function createNestedExec(input: ToolExecutionInput): ToolRunContext {
  return {
    ...input,
    rootCallId: input.rootCallId ?? input.callId,
    token: Symbol("nested-token") as ToolExecutionToken,
    deferContext() {},
    concludeTurn() {},
  };
}

function unknownNestedResult(rejected?: Error): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message: "unknown tool",
      info: {
        name: "ToolNotFoundError",
        code: "UNKNOWN_TOOL",
        ...(rejected === undefined ? {} : { reason: rejected.message }),
      },
    },
    content: [{ type: "text", text: "unknown tool" }],
  };
}

function abortedNestedResult(): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message: "aborted",
      info: { name: "AbortError", code: "ABORTED_BEFORE_DISPATCH" },
    },
    content: [{ type: "text", text: "aborted" }],
  };
}

function pipelineFixture(
  dispatch: (input: ToolRunContext) => Promise<ToolExecutionResult> = async () => ({
    isError: false,
    content: [],
    value: { content: [] },
  }),
) {
  const inputs: ToolExecutionInput[] = [];
  const sources: Array<ToolExecutionSource | undefined> = [];
  const stages: string[] = [];
  let dispatchCalls = 0;
  const module = {
    ToolExecutionPipeline: class {
      constructor(
        _ctx: Context,
        readonly source: ToolExecutionSource | undefined,
      ) {}

      async prepare(input: ToolExecutionInput) {
        stages.push("prepare");
        inputs.push(input);
        sources.push(this.source);
        // 与官方 ToolExecutionPipeline.createExecution 同序：先完成 executor-owned lookup，
        // 只有 lookup 命中后才调用 reject。未 lookup 的兼容调度器不得被生产 source 放行。
        const { definition, rejected } = lookupNestedDefinition(this.source, input);
        const exec = createNestedExec(input);
        if (definition === undefined) {
          return { kind: "final-result" as const, exec, result: unknownNestedResult() };
        }
        if (rejected !== undefined) {
          return { kind: "final-result" as const, exec, result: unknownNestedResult(rejected) };
        }
        if (exec.signal.aborted) {
          return { kind: "final-result" as const, exec, result: abortedNestedResult() };
        }
        return { kind: "dispatch" as const, exec };
      }

      async dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch> {
        stages.push("dispatch");
        dispatchCalls += 1;
        return { kind: "post-result", result: await dispatch(exec) };
      }

      async complete(
        _exec: ToolRunContext,
        outcome: ScheduledToolDispatch,
      ): Promise<ToolExecutionResult> {
        stages.push("complete");
        return outcome.result;
      }
    },
  };
  return {
    module,
    inputs,
    sources,
    stages,
    get dispatchCalls() {
      return dispatchCalls;
    },
  };
}

/**
 * 构造 nested pipeline 的真实中间层夹具。
 *
 * 逻辑留在 support 里只为避免 crap-guard 测试文件超过 max-lines；装配顺序、fake pipeline
 * lookup/reject 次序与实际调用断言均不在本函数内，调用方仍按原用例逐条断言。
 */
export function createForwardingFixture(support: MiddlewareShapeSupport) {
  return (
    dispatch?: (input: ToolRunContext) => Promise<ToolExecutionResult>,
    projectNestedContent = false,
    toolCallTimeoutMs?: number,
  ) => {
    const root = support.root;
    const servers: ServerConfig[] = [
      {
        name: "py",
        transport: "stdio",
        command: "python",
        enabled: true,
        ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
      },
    ];
    const TOKEN = Symbol("outer-call") as unknown as ToolExecutionToken;
    let guard: GuardHandler | undefined;
    const pipeline = pipelineFixture(dispatch);
    const { host } = support.makeHost(new Map([[root, servers]]), {
      schemas: [
        {
          name: "mcp__id-py__echo",
          ...(projectNestedContent ? { projectContent: () => undefined } : {}),
        },
      ],
      pipelineModule: pipeline.module,
    });
    const mw = support.trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = support.makeUnit();
    mw.units.set(root, unit);
    unit.connections.set("py", support.remoteEntry(servers[0], "id-py"));
    const ctx = {
      tools: {
        register: host.ctx.tools.register,
        schemas: () => host.ctx.tools.schemas(),
      },
      on: (event: string, handler: GuardHandler) => {
        if (event === "tools/pre-execute") guard = handler;
        return () => {};
      },
    };
    registerMiddlewareTools(ctx as unknown as Context, mw, async () => root, {
      disabledTools: new Map(),
    });
    const call = (host.ctx.tools.registered as ToolDefinition[]).find(
      (definition) => definition.name === "ws_mcp_call",
    )!;
    const signal = new AbortController().signal;
    const agent = {
      id: "dispatch-agent",
      session: { header: { cwd: root } },
    } as unknown as NonNullable<ToolRunContext["agent"]>;
    const outerDefinition = call;
    const toolSetState = { disposed: false, admittedAgent: agent };
    const toolSet = {
      dispose() {
        toolSetState.disposed = true;
      },
      view(viewingScope: unknown) {
        if (toolSetState.disposed || viewingScope !== toolSetState.admittedAgent) return new Map();
        return new Map([[outerDefinition.name, outerDefinition]]);
      },
    } as unknown as NonNullable<ToolRunContext["toolSet"]>;
    const deferredContexts: unknown[] = [];
    let concluded = 0;
    const runContext = {
      callId: "call-b5",
      rootCallId: "call-b5",
      name: "ws_mcp_call",
      arguments: {},
      signal,
      token: TOKEN,
      agent,
      toolSet,
      deferContext: (context: unknown) => deferredContexts.push(context),
      concludeTurn: () => {
        concluded += 1;
      },
    } as unknown as ToolRunContext;
    return {
      mw,
      call,
      guard: () => guard,
      runContext,
      signal,
      TOKEN,
      pipeline,
      tools: host.ctx.tools,
      agent,
      toolSet,
      toolSetState,
      deferredContexts,
      get concluded() {
        return concluded;
      },
    };
  };
}

/** 假 id 表：按 (scope, name) 稳定返回并自增。 */
export function fakeIdTable() {
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
