// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 无外部依赖、不发起真实网络连接。
//
// 覆盖：
//   - 契约导出（name / inject / ROUTES）
//   - normalizeServer 校验（名称模式、传输必填、http url 合法性）
//   - fromClaudeEntry / parseClaudeJson（mcpServers JSON 兼容映射）
//   - publicToolName 确定性、expandEnv
//   - McpStore 落盘/读回（临时目录）
//   - makeRoutes：GET 列表 / POST 添加 / PATCH 更新 / DELETE 删除 / import/json 导入
//   - SSE 半开防护（#268）：服务端 30s data ping 心跳 + 客户端 60s watchdog / 回前台强制重建
//   - apply：enabled:false 时不注册路由与提示词
//   - SDK 端到端（真实 stdio 子进程）与客户端产物契约（读 lib/ 构建产物）
//
// 运行：npx vitest run --project e2e packages/dsh-mcp-manager
//
// 迁移说明（#722 阶段 1）：原顶层 check 序列 → describe/it。原「每条命名 check」= 一个可见
// 用例；块内「动作 → 断言 → 新动作 → 新断言」的段落按逻辑步骤分组成用例（同文件内 vitest
// 顺序执行，顺序语义不变），所有断言逐条保留。e2e 层走真实端口/子进程/临时目录，超时由
// vitest 的 e2e project 统一给出（不在此硬编码）。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolExecutionInput,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MiddlewareHost } from "../../lib/server/connection/runtime/deps.js";
import type { ServerConfig } from "../../lib/index.js";
import {
  assertClientProductContract,
  assertClientSourceContract,
} from "../../../../test/smoke-lib.ts";
import { fakeManagerCtx, pollUntil } from "../helpers.ts";
const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
import {
  apply,
  broadcastFrame,
  buildConfigUiPatch,
  composeCatalogEntries,
  Config,
  DEFAULT_UI_CONFIG,
  digestCatalogEntries,
  escapeCatalogText,
  findCatalogMessage,
  isCatalogSource,
  fromClaudeEntry,
  expandEnv,
  inject,
  MCP_SECTION_ORDER,
  makeEventsRoute,
  makeHealthRoute,
  makeRoutes,
  McpManager,
  McpStore,
  name,
  normalizeServer,
  normalizeUiConfig,
  panelAnchorForPosition,
  panelTopForAnchor,
  parseClaudeJson,
  publicToolName,
  renderMcpCatalogMessage,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
  ROUTES,
  SCOPE_PROJECT,
  sseData,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  Z_INDEX_PANEL_DELTA,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  panelZIndexFor,
  composerDockedAtBottom,
  bottomAnchorEdge,
  summarizeToolDescriptions,
  uiConfigChangedFrame,
} from "../../lib/index.js";

// 服务契约门禁（#476）与结构化单元/集成测试由 vitest 的 unit / integration project 收集；
// 本文件（e2e project）不再以包内 glob 聚合方式执行，避免同一文件被求值两遍。

/** 假路由：fakeCtx.webServer 收到的注册项，只表达测试回读的面（path/handler）。 */
interface FakeRoute {
  path: string;
  handler: (req: FakeReq, res: FakeRes) => unknown;
}

/** 假 HTTP 请求的可观测面（与 IncomingMessage 取交集，保证 handler 调用位合法）。 */
interface FakeReqShape {
  method: string;
  url: string;
  socket: { remoteAddress: string };
  headers: Record<string, string>;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
}
type FakeReq = FakeReqShape & IncomingMessage;

/** 假 HTTP 响应的可观测面（与 ServerResponse 取交集，保证 handler 调用位合法）。 */
interface FakeResState {
  status: number;
  headers: Record<string, string>;
  body: string;
}
interface FakeResShape {
  state: FakeResState;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
}
type FakeRes = FakeResShape & ServerResponse;

/** 假 section：apply 实际传入静态文本（见 src/index.ts），测试读 name/order/text。 */
interface FakeSection {
  name: string;
  order: number;
  text: string;
}

type FakeListener = (...args: unknown[]) => unknown;

/**
 * 假 ctx 的可回读状态 + 宿主注入面。返回 FakeCtx & Context：回读走 FakeCtx，
 * 传 apply 时走 Context（假体与真实 Context 的结构差由一处 seam cast 桥接，
 * 成例：test/helpers.ts fakeManagerCtx）。
 */
interface FakeCtx {
  routes: FakeRoute[];
  sections: FakeSection[];
  effects: (string | undefined)[];
  registeredTools: ToolDefinition[];
  listeners: Map<string, FakeListener[]>;
  tools: { register: (definition: ToolDefinition) => () => void };
  webServer: { register: (route: FakeRoute) => () => void };
  systemPrompt: { section: (section: FakeSection) => () => void };
  on: (event: string, handler: FakeListener) => () => void;
  logger: LoggerService;
  effect: (fn: () => unknown, label?: string) => () => void;
}

/** 假 logger：被测体只读 warn/info/error，其余 LoggerService 面按 seam cast。 */
function fakeLogger(): LoggerService {
  return { warn: () => {}, info: () => {}, error: () => {} } as unknown as LoggerService;
}

function fakeCtx(overrides: Record<string, unknown> = {}): FakeCtx & Context {
  const state = {
    routes: [] as FakeRoute[],
    sections: [] as FakeSection[],
    effects: [] as (string | undefined)[],
    registeredTools: [] as ToolDefinition[],
    listeners: new Map<string, FakeListener[]>(),
  };
  const ctx = {
    ...state,
    tools: {
      register: (definition: ToolDefinition) => {
        state.registeredTools.push(definition);
        return () => {};
      },
    },
    webServer: {
      register: (route: FakeRoute) => {
        state.routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section: FakeSection) => {
        state.sections.push(section);
        return () => {};
      },
    },
    on: (event: string, handler: FakeListener) => {
      const handlers = state.listeners.get(event) ?? [];
      handlers.push(handler);
      state.listeners.set(event, handlers);
      return () => {};
    },
    logger: fakeLogger(),
    effect: (fn: () => unknown, label?: string) => {
      state.effects.push(label);
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    ...overrides,
  };
  return ctx as unknown as FakeCtx & Context;
}

/** 伪造 node:http res（可回读 state；传 handler 处按 ServerResponse 面兼容）。 */
function fakeRes(): FakeRes {
  const state: FakeResState = { status: 0, headers: {}, body: "" };
  const res: FakeResShape = {
    state,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      Object.assign(state.headers, headers);
    },
    end(body: string) {
      state.body = body;
    },
  };
  return res as unknown as FakeRes;
}

/**
 * 中间层装配夹具 ctx：只实现 tools.register（捕获注册的工具定义供断言）。
 * 其余宿主面按测试 seam cast 到 Context（成例：test/helpers.ts fakeManagerCtx）。
 */
function captureCtx(registered: ToolDefinition[]): Context {
  return {
    tools: {
      register: (def: ToolDefinition) => {
        registered.push(def);
        return () => {};
      },
    },
  } as unknown as Context;
}

/** 在已断言注册名的前提下按名取工具定义：缺失即抛（测试失败），顺带收窄 undefined。 */
function mustTool(registered: ToolDefinition[], name: string): ToolDefinition {
  const def = registered.find((d) => d.name === name);
  if (def === undefined) throw new Error(`中间层工具未注册: ${name}`);
  return def;
}

/** search 执行结果的可断言面（与产品 executeSearch 返回同形，只取测试回读的键）。 */
interface SmokeSearchHit {
  server: string;
  tool?: string;
}
interface SmokeSearchResult {
  results: SmokeSearchHit[];
  unavailable: unknown[];
  truncated: boolean;
}

/** list 执行结果的可断言面（与产品 executeList 返回同形，只取测试回读的键）。 */
interface SmokeListServer {
  server: string;
  tools: { name: string }[];
}
interface SmokeListResult {
  servers: SmokeListServer[];
  totalServers: number;
  totalTools: number;
  message: string;
  workspace: string;
}

/** detail 执行结果的可断言面（与产品 findToolDetail 返回同形，只取测试回读的键）。 */
interface SmokeDetailResult {
  server: string;
  tool: string;
}

/** execute 的 exec 入参桩：被测体只读 agent（工作空间反解），其余面按测试 seam cast。 */
function execWithAgent(agent: unknown): ToolRunContext {
  return { agent } as unknown as ToolRunContext;
}

/** tools/pre-execute guard 形态（与产品 middleware-register.ts 注册签名同形）。 */
type SmokeGuard = (
  exec: Pick<ToolExecution, "name" | "arguments" | "agent" | "parent">,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>;

/** 沿宿主约定的 session.header.cwd 形状逐层收窄；任一层不是对象即中止。 */
function nestedProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** resolveRoot 桩从 agent 取 cwd：宿主约定的 session.header.cwd 形状，此处收窄读取。 */
function agentCwd(agent: unknown): string | undefined {
  const cwd = nestedProp(nestedProp(nestedProp(agent, "session"), "header"), "cwd");
  return typeof cwd === "string" ? cwd : undefined;
}

/** 测试路由桩：/proj 会话回项目根，/no-project 回 @global（单池后组合根同款回落）。 */
function testResolveRoot(agent: unknown, globalRoot?: string): Promise<string | undefined> {
  const cwd = agentCwd(agent);
  if (cwd === "/proj") return Promise.resolve("/proj");
  if (globalRoot !== undefined && cwd === "/no-project") return Promise.resolve(globalRoot);
  return Promise.resolve(undefined);
}

/** 在临时目录建一个空 store，返回 { store, path, cleanup }。 */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-"));
  const path = join(dir, "dsh-mcp.json");
  return {
    store: new McpStore(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
it("name = mcp-manager", () => expect(name).toBe("mcp-manager"));
it("inject 包含 tools / webServer / systemPrompt", () => {
  expect(inject).toEqual(["tools", "webServer", "systemPrompt"]);
});
it("ROUTES 关键路径存在", () => {
  expect(ROUTES.servers).toBe("/api/dsh-mcp/servers");
  expect(ROUTES.importJson).toBe("/api/dsh-mcp/import/json");
});
it("client bundle 的 /api/ 路径与 host ROUTES 完全一致（防漂移）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const clientPaths = [...clientSrc.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]).sort();
  const hostPaths = [...new Set(Object.values(ROUTES))].sort();
  expect(
    clientPaths,
    `两端路由漂移：client=${clientPaths.join(",")} host=${hostPaths.join(",")}`,
  ).toEqual(hostPaths);
});
it("client source contract（load id/IIFE/use strict/load once）", () =>
  assertClientSourceContract(pkgDir));
it("client product contract（执行断言：arrive 可解析/apply/inject）", () =>
  assertClientProductContract(pkgDir));

// #767 B0 / §7.3 A12：客户端产物不得出现宿主路径字面量 `~/.dsh`——存储布局迁移后客户端
// 不应泄漏/承诺宿主路径。锚点只认 `~/.dsh` 这一个串：`scopeProjectOpt` 的项目级路径
// （<项目>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json）随项目走，是合法展示，不在本轮降级面内。
const hostPathLiteralHits = (code: string) => code.match(/~\/\.dsh/g) ?? [];
it("client 产物不含宿主路径字面量 ~/.dsh（#767 A12 存储布局迁移）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const hits = hostPathLiteralHits(clientSrc);
  expect(hits, `client 产物泄漏宿主路径字面量 ~/.dsh：${hits.length} 处`).toEqual([]);
});
it("宿主路径断言锚点有效性（反例：含 ~/.dsh 的产物必须被判出）", () => {
  expect(hostPathLiteralHits('scopeGlobalOpt: "全局（~/.dsh/dsh-mcp.json）"')).toHaveLength(1);
  expect(
    hostPathLiteralHits(
      'scopeProjectOpt: "项目级（<项目>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json）"',
    ),
  ).toEqual([]);
});
it("中间层工具注册（ws_mcp_search / ws_mcp_call / ws_mcp_list / ws_mcp_detail + 路由一致性）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, parseFullServerName } =
    await import("../../lib/index.js");
  const registered: ToolDefinition[] = [];
  const ctx = captureCtx(registered);
  const host: MiddlewareHost = {
    ctx,
    logger: fakeLogger(),
    projectServersFor: async () => [],
    redactionServers: () => [],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      cwd === "/proj" ? "/proj" : undefined,
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) => testResolveRoot(agent));
  const names = registered.map((def) => def.name).sort();
  expect(names, "四个中间层工具注册").toEqual([
    "ws_mcp_call",
    "ws_mcp_detail",
    "ws_mcp_list",
    "ws_mcp_search",
  ]);
  expect(mustTool(registered, "ws_mcp_search").description, "search 描述引导先搜后调").toMatch(
    /ws_mcp_call/,
  );
  expect(mustTool(registered, "ws_mcp_search").description, "search 描述互引完整盘点").toMatch(
    /ws_mcp_list/,
  );
  expect(mustTool(registered, "ws_mcp_call").description, "call 描述互引参数 schema 查询").toMatch(
    /ws_mcp_detail/,
  );
  expect(mustTool(registered, "ws_mcp_list").description, "list 描述互引 detail").toMatch(
    /ws_mcp_detail/,
  );
  expect(mustTool(registered, "ws_mcp_list").description, "list 描述写明不做什么").toMatch(
    /Does not return inputSchema/,
  );
  expect(mustTool(registered, "ws_mcp_detail").description, "detail 描述说明完整 schema").toMatch(
    /inputSchema/,
  );
  expect(mustTool(registered, "ws_mcp_detail").description, "detail 描述写明不做什么").toMatch(
    /Does not perform keyword search/,
  );
  // Anthropic 规范：parameters 每个字段都带 description。
  for (const def of registered) {
    const props = (def.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const [key, prop] of Object.entries(props)) {
      expect(
        typeof prop === "object" &&
          prop !== null &&
          "description" in prop &&
          typeof prop.description === "string" &&
          prop.description !== "",
        `参数 ${def.name}.${key} 带 description`,
      ).toBeTruthy();
    }
  }
  // search 输出 schema 含 truncated 字段。
  const searchSchemaProps = mustTool(registered, "ws_mcp_search").output.schema.properties;
  expect(typeof searchSchemaProps?.truncated, "search 输出含 truncated 字段").toBe("object");
  // 路由：agent-less → 显式失败
  const searchDef = mustTool(registered, "ws_mcp_search");
  const callDef = mustTool(registered, "ws_mcp_call");
  const listDef = mustTool(registered, "ws_mcp_list");
  const detailDef = mustTool(registered, "ws_mcp_detail");
  // search 输出补 truncated 字段：空目录 → false。
  const emptySearch = (await searchDef.execute(
    {},
    execWithAgent({ session: { header: { cwd: "/proj" } } }),
  )) as { truncated: boolean; unavailable: unknown[] };
  expect(emptySearch.truncated, "空目录 truncated=false").toBe(false);
  expect(emptySearch.unavailable).toEqual([]);
  await expect(() => searchDef.execute({}, execWithAgent(undefined))).rejects.toThrow(
    /无法确定工作空间/,
  );
  await expect(() => listDef.execute({}, execWithAgent(undefined))).rejects.toThrow(
    /无法确定工作空间/,
  );
  await expect(() => detailDef.execute({}, execWithAgent(undefined))).rejects.toThrow(
    /无法确定工作空间/,
  );
  // 路由：有 agent 但 cwd 无项目 → 显式失败（ws_mcp_call 缺 server 参数先报必填）
  await expect(() =>
    callDef.execute({}, execWithAgent({ session: { header: { cwd: "/other" } } })),
  ).rejects.toThrow(/无法确定工作空间|server 与 tool 均为必填/);
  // 空返回提示：无项目配置 → list 返回 message
  const emptyList = (await listDef.execute(
    {},
    execWithAgent({ session: { header: { cwd: "/proj" } } }),
  )) as {
    totalServers: number;
    totalTools: number;
    message: string;
  };
  expect(emptyList.totalServers).toBe(0);
  expect(emptyList.totalTools).toBe(0);
  expect(emptyList.message, "空返回明确提示").toMatch(/没有可用 MCP 服务器|没有项目级 MCP 配置/);
  // detail 必填校验
  await expect(() =>
    detailDef.execute({}, execWithAgent({ session: { header: { cwd: "/proj" } } })),
  ).rejects.toThrow(/server 与 tool 均为必填/);
  // server 全名解析往返
  const full = fullServerName("/proj", "ctx");
  expect(parseFullServerName(full)).toEqual({ root: "/proj", server: "ctx" });
  // @global 单 @ / 双 @ 等价（隔离验证 P0：smoke 双 @ 掩盖单 @ 被拒）
  const { MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  expect(parseFullServerName("@global/gctx"), "单 @ @global/ 归一化为 @global").toEqual({
    root: MIDDLEWARE_GLOBAL_ROOT,
    server: "gctx",
  });
  expect(parseFullServerName("@@global/gctx"), "双 @ @@global/ 归一化为 @global").toEqual({
    root: MIDDLEWARE_GLOBAL_ROOT,
    server: "gctx",
  });
  expect(
    parseFullServerName(fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")),
    "fullServerName(@global) 往返一致",
  ).toEqual({ root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" });
  dispose();
});
it("search 早退分支（unit undefined）返回 truncated=false（P1-1）", async () => {
  const { registerMiddlewareTools, McpMiddleware } = await import("../../lib/index.js");
  const registered: ToolDefinition[] = [];
  const ctx = captureCtx(registered);
  const host: MiddlewareHost = {
    ctx,
    logger: fakeLogger(),
    projectServersFor: async () => undefined, // 无项目标记 → projectUnitFor 返回 undefined
    redactionServers: () => [],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      cwd === "/proj" ? "/proj" : undefined,
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) => testResolveRoot(agent));
  const searchDef = mustTool(registered, "ws_mcp_search");
  const out = await searchDef.execute({}, execWithAgent({ session: { header: { cwd: "/proj" } } }));
  expect(out, "早退分支补 truncated=false（output.schema required）").toEqual({
    results: [],
    unavailable: [],
    truncated: false,
  });
  dispose();
});
it("中间层 all 模式：@global 覆盖（list/search 可见全局，call 放行 @global）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } =
    await import("../../lib/index.js");
  const registered: ToolDefinition[] = [];
  const ctx = captureCtx(registered);
  // 目录投影的文案随「发现完成」这一步变换：hook 住描述即可让最后一次投影成为断言面。
  const globalToolDescription = { value: "全局工具" };
  const host: MiddlewareHost = {
    ctx,
    logger: fakeLogger(),
    // 目录内存态归 catalog 域后，夹具不再能直接往单元里塞目录：改由**真实虚拟连接路径**
    // 投影（ensureConnected 的 toolDefinitions 分支），目录由产物自身的域实例写入。
    projectServersFor: async (root: string) => {
      if (root === MIDDLEWARE_GLOBAL_ROOT)
        return [
          {
            name: "gctx",
            transport: "stdio" as const,
            command: "npx",
            enabled: true,
            toolDefinitions: [
              // 每次连接都重新投影——「发现完成」那一步的目录由最后一次投影决定。
              // execute 抛「未连接」：本段 call 断言要走「调用失败」分支（原夹具是远端条目、
              // 由状态守卫给出同一类判词，搬家后由封装分支给出）。
              {
                name: "use_g",
                description: globalToolDescription.value,
                parameters: {},
                execute: async () => {
                  throw new Error("未连接");
                },
              } as unknown as ToolDefinition,
            ],
          } as unknown as ServerConfig,
        ];
      return [
        {
          name: "ctx",
          transport: "stdio" as const,
          command: "npx",
          enabled: true,
          toolDefinitions: [
            {
              name: "use_ctx",
              description: "项目工具",
              parameters: {},
            } as unknown as ToolDefinition,
          ],
        } as unknown as ServerConfig,
      ];
    },
    redactionServers: () => [],
    globalServers: () => [{ name: "gctx", transport: "stdio", command: "npx", enabled: true }],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      cwd === "/proj" ? "/proj" : undefined,
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  // 预置目录（模拟 last-good 已发现；不 spawn 子进程）：虚拟连接会把 toolDefinitions
  // 投影进目录，与真实运行时同一条路径。
  const projUnit = {
    root: "/proj",
    connections: new Map(),
    userDisabled: new Set<string>(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  const globalUnit = {
    root: MIDDLEWARE_GLOBAL_ROOT,
    connections: new Map(),
    userDisabled: new Set<string>(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  mw.units.set("/proj", projUnit);
  mw.units.set(MIDDLEWARE_GLOBAL_ROOT, globalUnit);
  await mw.ensureConnected("/proj", "ctx");
  await mw.ensureConnected(MIDDLEWARE_GLOBAL_ROOT, "gctx");
  // projUnit 是手工塞进 units 的，projectUnitFor 会原样返回它；gctx 的目录同理随后填充。
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) =>
    testResolveRoot(agent, MIDDLEWARE_GLOBAL_ROOT),
  );
  const names = registered.map((def) => def.name).sort();
  expect(names, "all 模式注册四个工具").toEqual([
    "ws_mcp_call",
    "ws_mcp_detail",
    "ws_mcp_list",
    "ws_mcp_search",
  ]);
  const searchDef = mustTool(registered, "ws_mcp_search");
  const callDef = mustTool(registered, "ws_mcp_call");
  const listDef = mustTool(registered, "ws_mcp_list");
  const detailDef = mustTool(registered, "ws_mcp_detail");
  const agent = { session: { header: { cwd: "/proj" } } };
  // list：项目 root + @global 合并可见
  const listed = (await listDef.execute({}, execWithAgent(agent))) as SmokeListResult;
  expect(
    listed.servers.some((s) => s.server === fullServerName("/proj", "ctx")),
    "list 含项目服务器",
  ).toBeTruthy();
  expect(
    listed.servers.some((s) => s.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")),
    "all 模式 list 含 @global 服务器",
  ).toBeTruthy();
  expect(Object.hasOwn(listed, "mode"), "#767 笔 2：ws_mcp_list 输出不再有 mode 字段").toBe(false);
  expect(
    listDef.output.schema.required,
    "ws_mcp_list output schema 的 required 恰好 5 项且无 mode",
  ).toEqual(["workspace", "servers", "totalServers", "totalTools", "toolsTruncated"]);
  // search：合并查询命中 @global 工具
  const found = (await searchDef.execute(
    { query: "全局" },
    execWithAgent(agent),
  )) as SmokeSearchResult;
  expect(
    found.results.some((hit) => hit.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")),
    "all 模式 search 含 @global 命中",
  ).toBeTruthy();
  expect(found.truncated, "all 模式 search 未达 limit → truncated=false").toBe(false);
  // detail：@global 可查
  const detail = (await detailDef.execute(
    { server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" },
    execWithAgent(agent),
  )) as SmokeDetailResult;
  expect(detail.server).toBe(fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"));
  expect(detail.tool).toBe("use_g");
  // call：all 模式放行 @global root（预置 client 无法调用——此处断言路由放行后
  // 落到连接/调用错误而非「不属于当前工作空间」路由拒绝）。
  await expect(() =>
    callDef.execute(
      { server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" },
      execWithAgent(agent),
    ),
  ).rejects.toThrow(/未连接|未就绪|连接失败|已禁用/);
  // call：非当前 root 的项目 root 仍拒绝（防跨空间串台）。
  await expect(() =>
    callDef.execute(
      { server: fullServerName("/other", "ctx"), tool: "use_ctx" },
      execWithAgent(agent),
    ),
  ).rejects.toThrow(/不属于当前工作空间/);
  // P1-2：all 模式无项目 cwd（root 本身为 @global）→ visibleRoots 去重不翻倍。
  const gAgent = { session: { header: { cwd: "/no-project" } } };
  const listedGlobalOnly = (await listDef.execute({}, execWithAgent(gAgent))) as SmokeListResult;
  const globalNames = listedGlobalOnly.servers.map((s) => s.server);
  expect(listedGlobalOnly.totalServers, "@global 去重：totalServers 不翻倍").toBe(1);
  expect(
    globalNames.filter((n) => n === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")).length,
    "gctx 只出现一次",
  ).toBe(1);
  // P1-3：@global 单元首次触达（无预置目录 + in-flight 发现进行中）→
  // list/search 等待 in-flight 后全局可见（8s 预算内）。
  const freshGlobal = {
    root: MIDDLEWARE_GLOBAL_ROOT,
    connections: new Map(),
    userDisabled: new Set<string>(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  // 描述先换面：目录投影在虚拟连接建立时取它。
  globalToolDescription.value = "全局工具（发现完成）";
  mw.units.set(MIDDLEWARE_GLOBAL_ROOT, freshGlobal);
  await mw.projectUnitFor(MIDDLEWARE_GLOBAL_ROOT);
  await mw.ensureConnected(MIDDLEWARE_GLOBAL_ROOT, "gctx");
  // 目录就绪后再挂「等待窗口」标记：list/search 仍必须等它结算才返回（P1-3 语义），
  // 而目录内容已是发现完成后的那一份。
  freshGlobal.inFlight.set("gctx", new Promise((resolve) => setTimeout(resolve, 100)));
  const listedAfterWait = (await listDef.execute({}, execWithAgent(gAgent))) as SmokeListResult;
  const freshEntry = listedAfterWait.servers.find(
    (s) => s.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"),
  );
  expect(freshEntry !== undefined, "@global 首次触达等待 in-flight 后可见").toBeTruthy();
  expect(freshEntry!.tools.length, "发现完成的工具列出").toBe(1);
  const foundAfterWait = (await searchDef.execute(
    { query: "发现完成" },
    execWithAgent(gAgent),
  )) as SmokeSearchResult;
  expect(
    foundAfterWait.results.some(
      (hit) => hit.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"),
    ),
    "search 等待 in-flight 后命中 @global",
  ).toBeTruthy();
  dispose();
});
it("MCP_GUIDANCE 与隐藏后的模型面一致：全局与项目级同走 ws_mcp_call 全名寻址", async () => {
  // 这条常量是模型面唯一的口径出口（apply 经 systemPrompt.section 注入）。#767 笔 1b 的隐藏面
  // 落地后 mcp__* 不再出现在任何 agent 的工具清单里，这段文本必须同步改真——它若还教模型直呼，
  // 就是一条活的假事实（模型照做只会拿到 unknown tool）。
  // 断言文本形态而不是整段快照：快照会在任何措辞微调上红，却不回答「口径是否失真」。
  const { MCP_GUIDANCE } = await import("../../lib/index.js");
  // 反面：不得再出现按服务器名可推导的直呼写法，也不得残留 id/opaque 口径（直呼面已退场）。
  expect(MCP_GUIDANCE, "不再承诺 mcp__<server>__ 可推导").not.toMatch(/mcp__<server>__/);
  expect(MCP_GUIDANCE, "不再出现 mcp__<id>__ 注册名口径").not.toMatch(/mcp__<id>__/);
  expect(MCP_GUIDANCE, "不再出现 id 不透明口径").not.toMatch(/opaque/);
  // 正面：全局服务器与项目级同路——全名寻址、经 ws_mcp_call；全局名写作 @global/<server>。
  expect(MCP_GUIDANCE, "全局服务器全名 @global/<server>").toMatch(/@global\/<server>/);
  expect(MCP_GUIDANCE, "全名寻址经 ws_mcp_call").toMatch(/ws_mcp_call/);
  // 正对照：整段被删空时上面几条会红，但这条钉住「仍在引导」本身（project-level 与检索入口）。
  expect(MCP_GUIDANCE, "正对照：project-level 引导仍在").toMatch(/ws_mcp_search/);
  expect(MCP_GUIDANCE, "正对照：project-level 那条仍在").toMatch(/Project-level servers/);
  // #922 D：不再写“NOT in your tool list”绝对口径——连接翻转期 SDK 里会短暂出现
  // mcp__ 声明，文案必须给过渡态指引（仍经中间层调用、不直呼），否则即假事实。
  expect(MCP_GUIDANCE, "过渡态仍经中间层调用").toMatch(/transiently appear/);
  expect(MCP_GUIDANCE, "过渡态不授权直呼").toMatch(/does not authorize direct calls/);
  expect(MCP_GUIDANCE, "绝对口径已改写").not.toMatch(/are NOT in your tool list/);
});
it("#362 A2 / #767 笔 1a：project root 会话下 @global 可达（「改 mcp__ 直呼」拒绝门已删）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } =
    await import("../../lib/index.js");
  const registered: ToolDefinition[] = [];
  const ctx = captureCtx(registered);
  const globalServer = {
    name: "gctx",
    transport: "stdio" as const,
    command: "npx",
    enabled: true,
    toolDefinitions: [
      {
        name: "use_g",
        description: "全局工具",
        parameters: {},
        execute: async () => ({ content: [] }),
      } as unknown as ToolDefinition,
    ],
  } as unknown as ServerConfig;
  const host: MiddlewareHost = {
    ctx,
    logger: fakeLogger(),
    projectServersFor: async (root: string) =>
      root === MIDDLEWARE_GLOBAL_ROOT ? [globalServer] : undefined,
    redactionServers: () => [globalServer],
    globalServers: () => [globalServer],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      cwd === "/proj" ? "/proj" : undefined,
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: (name: string) => name === "gctx",
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  // @global 单元 + 虚拟连接：目录投影的真实来源，detail 才能真正命中。
  await mw.projectUnitFor(MIDDLEWARE_GLOBAL_ROOT);
  await mw.ensureConnected(MIDDLEWARE_GLOBAL_ROOT, "gctx");
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) => testResolveRoot(agent));
  const detailDef = mustTool(registered, "ws_mcp_detail");
  const callDef = mustTool(registered, "ws_mcp_call");
  const agent = { session: { header: { cwd: "/proj" } } };
  const globalFull = fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx");
  // 可达性三件套之一（A.1）：project root 会话里 @global 不再被拒——detail 直接命中。
  const detail = (await detailDef.execute(
    { server: globalFull, tool: "use_g" },
    execWithAgent(agent),
  )) as SmokeDetailResult;
  expect(detail.server, "@global 全局服务器经 ws_mcp_detail 可达").toBe(globalFull);
  expect(detail.tool, "命中的是全局工具").toBe("use_g");
  // call 同样不再是路由拒绝（该走执行面）：错误里不得再出现旧的「改 mcp__ 直呼」引导词。
  const callErr = await callDef
    .execute({ server: globalFull, tool: "use_g" }, execWithAgent(agent))
    .then(
      () => "",
      (error: unknown) =>
        String(
          typeof error === "object" && error !== null && "message" in error ? error.message : error,
        ),
    );
  expect(callErr, "call 不落旧的路由引导门").not.toMatch(
    /全局级（global scope）服务器|不属于当前工作空间/,
  );
  // 非 global 其他 root 仍硬拒绝（防跨空间串台，不回归）。
  await expect(() =>
    detailDef.execute(
      { server: fullServerName("/other", "ctx"), tool: "use_ctx" },
      execWithAgent(agent),
    ),
  ).rejects.toThrow(/不属于当前工作空间/);
  // 未知 @global 服务器同理不再被路由拒绝：门打开后落**查表失败**（不再是「改直呼」引导）。
  await expect(
    () =>
      detailDef.execute(
        { server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "ghost"), tool: "x" },
        execWithAgent(agent),
      ),
    "未知 @global 服务器落查表失败（路由门已删）",
  ).rejects.toThrow(/ws_mcp_detail: server 未连接或未发现/);
  dispose();
});
it("#362 isGlobalServer 双源：runtime 注册的 codegraph 判全局（P1 修正）", async () => {
  const { McpManager, McpStore } = await import("../../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-global-"));
  try {
    const store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    const manager = new McpManager(fakeManagerCtx(), store);
    // runtime 注册（不落 store）→ isGlobalServer 必须返回 true。
    await manager.registerServer({
      name: "codegraph",
      transport: "stdio",
      command: "echo",
      args: ["x"],
      enabled: false,
    });
    expect(manager.isGlobalServer("codegraph"), "runtime 注册判全局（双源）").toBe(true);
    // store 持久化条目 → 全局。
    store.upsert({ name: "ctx", transport: "stdio", command: "echo", enabled: false });
    expect(manager.isGlobalServer("ctx"), "store 条目判全局").toBe(true);
    expect(manager.isGlobalServer("ghost"), "未注册不判全局").toBe(false);
    await manager.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("#362 A1：ws_mcp_list 带 serverFilter 过滤 0 命中 → message 可归因（不谎报未配置）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } =
    await import("../../lib/index.js");
  const registered: ToolDefinition[] = [];
  const ctx = captureCtx(registered);
  const host: MiddlewareHost = {
    ctx,
    logger: fakeLogger(),
    // 虚拟连接（toolDefinitions）让目录走真实投影路径落进产物侧的域实例。
    projectServersFor: async () => [
      {
        name: "ctx",
        transport: "stdio" as const,
        command: "npx",
        enabled: true,
        toolDefinitions: [
          { name: "use_ctx", description: "项目工具", parameters: {} } as unknown as ToolDefinition,
        ],
      } as unknown as ServerConfig,
    ],
    redactionServers: () => [],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      cwd === "/proj" ? "/proj" : undefined,
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  // 预置目录（模拟 last-good 已发现；不 spawn 子进程）：经真实虚拟连接路径投影。
  mw.units.set("/proj", {
    root: "/proj",
    connections: new Map(),
    userDisabled: new Set<string>(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  });
  await mw.ensureConnected("/proj", "ctx");
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) => testResolveRoot(agent));
  const listDef = mustTool(registered, "ws_mcp_list");
  const agent = { session: { header: { cwd: "/proj" } } };
  // 过滤不存在的 server → 0 命中 + 可归因 message。
  const out = (await listDef.execute({ server: "nope" }, execWithAgent(agent))) as SmokeListResult;
  expect(out.totalServers).toBe(0);
  expect(out.message, "A1：message 归因到过滤条件").toMatch(
    /没有匹配 server="nope" 的项目级服务器/,
  );
  expect(out.message, "A1：列出可见项目级服务器").toMatch(/可见项目级服务器：ctx/);
  expect(out.message, "A1：提示全局级不列出").toMatch(/全局级服务器不在此列出/);
  // #767 笔 1b 增补 E：隐藏面落地后，这条模型面文案不得再教模型直呼 mcp__*（模型已无从发现它）。
  expect(out.message, "E1：归因文案不再出现 mcp__ 直呼路径").not.toMatch(/mcp__/);
  expect(out.message, "E1：改教经 ws_mcp_call 按全名访问").toMatch(/ws_mcp_call/);
  expect(out.message, "E1：全局级全名写法 @global/<server>").toMatch(/@global\/<server>/);
  // 同笔：ws_mcp_detail 的 tool 形参描述不再宣传模型已无从发现的直呼名（能力仍在，只是不宣传）。
  const detailDef = mustTool(registered, "ws_mcp_detail");
  expect(
    (detailDef.parameters as { properties: Record<string, { description: string }> }).properties
      .tool.description,
    "E2：detail 的 tool 形参描述不含 mcp__",
  ).not.toMatch(/mcp__/);
  // 不带过滤 → 列出可见单元全部服务器。单池（#767 笔 1a）：可见单元恒为
  // 「项目 root + @global」——@global 不再随模式开关（旧实现 project 模式下只列项目 root）。
  const out2 = (await listDef.execute({}, execWithAgent(agent))) as SmokeListResult;
  const listed = out2.servers.map((s) => s.server);
  expect(listed, "项目 root 的服务器可见").toContain(fullServerName("/proj", "ctx"));
  expect(listed, "@global 的服务器同样可见").toContain(
    fullServerName(MIDDLEWARE_GLOBAL_ROOT, "ctx"),
  );
  dispose();
});
it("#362 P0-1：工具级禁用三入口一致（callTool / pre-execute guard / mcp__ 直呼）", async () => {
  const {
    registerMiddlewareTools,
    McpMiddleware,
    fullServerName,
    parseDisabledTools,
    isToolDenied,
    toolDisabledReason,
  } = await import("../../lib/index.js");
  // 1) isToolDenied 纯函数：项目 root 命中 + @global 回落 + 哈希超长名不误禁。
  const map = parseDisabledTools({ "/proj": { ctx: ["use_ctx"] }, "@global": { gctx: ["use_g"] } });
  expect(isToolDenied(map, fullServerName("/proj", "ctx"), "use_ctx"), "项目 root 记录命中").toBe(
    true,
  );
  expect(isToolDenied(map, fullServerName("/proj", "ctx"), "other"), "未禁用工具放行").toBe(false);
  expect(
    isToolDenied(map, fullServerName("/proj", "gctx"), "use_g"),
    "@global 共享记录回落命中",
  ).toBe(true);
  expect(
    isToolDenied(map, fullServerName("@global", "gctx"), "use_g"),
    "@global root 自身记录命中",
  ).toBe(true);
  expect(isToolDenied(map, "mcp__ctx__use_ctx_hash123456", "x"), "哈希超长名不可逆 → 不误禁").toBe(
    false,
  );
  // 2) registerMiddlewareTools 的 pre-execute guard：mcp__ 直呼被 deny。
  const registered: ToolDefinition[] = [];
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        registered.push(def);
        return () => {};
      },
      // 换引擎后远端分支改道宿主执行面：给最小形状 `{isError, content, value}`，
      // value 是远端原始结果（projectCallToolResult 吃的就是它）。
      execute: async () => ({ isError: false, content: [], value: { content: [] } }),
    },
    on: (event: string, handler: SmokeGuard) => {
      guards.set(event, handler);
      return () => {};
    },
  } as unknown as Context;
  const guards = new Map<string, SmokeGuard>();
  const host: MiddlewareHost = {
    ctx,
    logger: fakeLogger(),
    projectServersFor: async () => [
      {
        name: "ctx",
        transport: "stdio" as const,
        command: "x",
        enabled: true,
        // 目录条目（use_ctx）经真实虚拟连接路径投影，供 ws_mcp_detail 与 stats 记录消费。
        // execute 抛「未连接」是为保住原判据：本段的 call 断言就是要走到「调用失败」这条
        // 分支（原夹具是远端条目、由 status 守卫给出同一类判词）。
        toolDefinitions: [
          {
            name: "use_ctx",
            description: "封装工具",
            parameters: {},
            execute: async () => {
              throw new Error("未连接");
            },
          } as unknown as ToolDefinition,
          // 未禁用工具走正常调用：返回空 content，与「远端执行器返回空 content」同形
          // （投影后的 content 为空数组），保住该断言的原判据。
          {
            name: "other",
            description: "其他工具",
            parameters: {},
            execute: async () => ({ content: [] }),
          } as unknown as ToolDefinition,
        ],
      } as unknown as ServerConfig,
    ],
    redactionServers: () => [],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      cwd === "/proj" ? "/proj" : undefined,
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) => testResolveRoot(agent), {
    disabledTools: map,
  });
  const guard = guards.get("tools/pre-execute");
  expect(typeof guard === "function", "pre-execute guard 已注册").toBeTruthy();
  const deny = await guard!(
    {
      name: "mcp__ctx__use_ctx",
      agent: { session: { header: { cwd: "/proj" } } },
    } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(deny.kind, "mcp__ 直呼被禁用表 deny").toBe("deny");
  expect((deny as unknown as { reason: string }).reason, "拒绝原因含禁用语义声明").toMatch(
    /已被用户在「MCP」浮窗禁用/,
  );
  const allow = await guard!(
    {
      name: "mcp__ctx__other",
      agent: { session: { header: { cwd: "/proj" } } },
    } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(allow.kind, "未禁用工具放行").toBe("allow");
  // agent-less → 按最宽可见范围放行（@global 记录仍生效）。
  const gDeny = await guard!(
    { name: "mcp__gctx__use_g" } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(gDeny.kind, "agent-less 时 @global 共享记录仍 deny").toBe("deny");
  // 超长哈希名（含非法字符被替换）→ 不误禁。
  const hashed = await guard!(
    { name: "mcp__ctx__use_ctx_0123456789ab" } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(hashed.kind, "哈希后缀名按未知 server 放行").toBe("allow");
  // ws_mcp_call guard：禁用命中 → deny。
  const callDeny = await guard!(
    {
      name: "ws_mcp_call",
      arguments: { server: fullServerName("/proj", "ctx"), tool: "use_ctx" },
    } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(callDeny.kind, "ws_mcp_call guard 查禁用表").toBe("deny");
  expect(
    toolDisabledReason(fullServerName("/proj", "ctx"), "use_ctx").includes("mcp-manager 管辖"),
    "禁用原因声明覆盖 mcp__ 与中间层工具（#413）",
  ).toBe(true);

  // 3) callTool（ws_mcp_call 执行路径）：禁用工具 → 显式抛错（验收 14：三入口一致）。
  // 单元与连接条目改由真实路径建立（#767 S1-3b：目录内存态归 catalog 域，手工塞单元
  // 已无法把目录带进去）；host.projectServersFor 给的是**虚拟连接**定义服务器，
  // 它的 statusOf 恒 connected（#413 既有契约），与本段判据一致。
  await mw.projectUnitFor("/proj");
  await mw.ensureConnected("/proj", "ctx");
  // callTool 的第 5 形参换成身份对象（agent / callId / rootCallId / parent）：dispatch 要拿它
  // 合成子调用 id 并透传 parent。本用例只走本地守卫与投影，给最小身份即可。
  const IDENTITY = { callId: "smoke-call-1" as ToolExecutionInput["callId"] };
  await expect(
    () => mw.callTool(fullServerName("/proj", "ctx"), "use_ctx", {}, undefined, IDENTITY),
    "callTool 先查禁用表（三入口一致）",
  ).rejects.toThrow(/已被用户在「MCP」浮窗禁用/);
  // 未禁用工具正常放行到调用。
  const okValue = (await mw.callTool(
    fullServerName("/proj", "ctx"),
    "other",
    {},
    undefined,
    IDENTITY,
  )) as { content: unknown };
  // 判据面随夹具换面（#767 S1-3b）：原夹具是远端条目，投影后 content 为空数组；现夹具
  // 走封装直呼分支（无 output.render），渲染器把封装返回值按 JSON 文本投影成一个 text 块。
  // 夹具确定性（execute 恒返回 {content:[]}），故这里逐字钉死投影结果。
  expect(okValue.content, "未禁用工具正常调用（封装返回值按 JSON 文本投影）").toEqual([
    { type: "text", text: '{"content":[]}' },
  ]);

  // 4) stats：四个原子工具埋点与统计断言
  const { McpStatsCollector } = await import("../../lib/index.js");
  const testStatsDir = mkdtempSync(join(tmpdir(), "mcp-smoke-stats-"));
  const testStatsFile = join(testStatsDir, "smoke-stats.json");
  try {
    const statsCollector = new McpStatsCollector({ enabled: true, filePath: testStatsFile });
    // 提取注册的原子工具
    const statsRegTools: ToolDefinition[] = [];
    const statsCtx = {
      tools: {
        register: (def: ToolDefinition) => {
          statsRegTools.push(def);
          return () => {};
        },
      },
      on: () => () => {},
    } as unknown as Context;
    // 目录条目在连接路径上投影：detail/stats 段的执行前先建单元、再走一次虚拟连接
    // （ensureConnected 对未在册 root 直接返回，不会自己建单元）。
    await mw.projectUnitFor("/proj");
    await mw.ensureConnected("/proj", "ctx");
    const statsMwDispose = registerMiddlewareTools(statsCtx, mw, async () => "/proj", {
      stats: statsCollector,
    });

    const searchTool = mustTool(statsRegTools, "ws_mcp_search");
    const listTool = mustTool(statsRegTools, "ws_mcp_list");
    const detailTool = mustTool(statsRegTools, "ws_mcp_detail");
    const callTool = mustTool(statsRegTools, "ws_mcp_call");

    expect(searchTool && listTool && detailTool && callTool, "四个原子工具均已注册").toBeTruthy();

    // 执行四个原子工具
    await searchTool.execute(
      { query: "codegraph" },
      execWithAgent({ session: { header: { cwd: "/proj" } } }),
    );
    await listTool.execute({}, execWithAgent({ session: { header: { cwd: "/proj" } } }));
    await detailTool.execute(
      { server: fullServerName("/proj", "ctx"), tool: "use_ctx" },
      execWithAgent({ session: { header: { cwd: "/proj" } } }),
    );
    await callTool.execute(
      { server: fullServerName("/proj", "ctx"), tool: "other" },
      execWithAgent({ session: { header: { cwd: "/proj" } } }),
    );

    statsCollector.flushSync();
    const statsSnap = statsCollector.snapshot();
    expect(statsSnap.servers.ctx?.totalCalls, "ws_mcp_call 成功记录到 ctx 服务器").toBe(1);
    expect(statsSnap.servers.ctx?.tools.other?.calls, "other 工具调用成功记录").toBe(1);
    expect(statsSnap.disclosure.searches["codegraph"], "ws_mcp_search 记录到漏斗").toBe(1);
    expect(statsSnap.disclosure.lists["<all>"], "ws_mcp_list 记录到漏斗").toBe(1);
    expect(statsSnap.disclosure.details["ctx/use_ctx"], "ws_mcp_detail 记录到漏斗").toBe(1);

    statsMwDispose();
  } finally {
    rmSync(testStatsDir, { recursive: true, force: true });
  }
  dispose();
});
it("#362 P1：disabledTools 持久化（合并式写盘 + 重启保留）", async () => {
  const {
    McpManager,
    McpStore,
    loadDisabledTools,
    saveDisabledTools,
    parseDisabledTools,
    MIDDLEWARE_GLOBAL_ROOT,
  } = await import("../../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-tools-"));
  try {
    const file = join(dir, "dsh-mcp-user-state.json");
    // 预置磁盘记录（模拟另一工作空间已禁用），并让 manager 加载（等价
    // initMiddleware 的 loadDisabledTools 路径——进程内完整视图）。
    await saveDisabledTools(file, parseDisabledTools({ "/other": { s2: ["t2"] } }));
    const manager = new McpManager(fakeManagerCtx(), new McpStore(join(dir, "mcp.json")));
    manager.userStatePath = file;
    manager.disabledTools = await loadDisabledTools(file);
    // 多空间共存：新增 /proj 记录，/other 记录保留（不整表覆盖）。
    await manager.setToolDisabled("/proj", "ctx", "use_ctx", true);
    await manager.setToolDisabled(MIDDLEWARE_GLOBAL_ROOT, "gctx", "use_g", true);
    const reloaded = await loadDisabledTools(file);
    const hasTool = (
      state: Map<string, Map<string, Set<string>>>,
      root: string,
      s: string,
      t: string,
    ) => state.get(root)?.get(s)?.has(t) === true;
    expect(hasTool(reloaded, "/proj", "ctx", "use_ctx"), "/proj 记录落盘").toBe(true);
    expect(hasTool(reloaded, "@global", "gctx", "use_g"), "@global 记录落盘").toBe(true);
    expect(
      hasTool(reloaded, "/other", "s2", "t2"),
      "既有 /other 记录保留（合并式，绝不整表覆盖）",
    ).toBe(true);
    // 解除禁用 → 记录清除；其他记录保留。
    await manager.setToolDisabled("/proj", "ctx", "use_ctx", false);
    const after = await loadDisabledTools(file);
    const projTools = after.get("/proj")?.get("ctx");
    expect(projTools === undefined || !projTools.has("use_ctx"), "解除后记录清除").toBe(true);
    expect(after.get("/other")?.get("s2")?.has("t2"), "解除不影响其他记录").toBe(true);
    await manager.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("client 产物包含 0.1.7-rc.2 plugins.row.config canonical identity 契约", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "客户端产物注册 plugins.row.config").toContain("plugins.row.config");
  expect(clientSrc, "canonical bundle package 已入产物").toContain("@wingsky-1/dsh-mcp-manager");
  expect(clientSrc, "canonical row id 已入产物").toContain("dsh-mcp-manager");
  expect(clientSrc, "客户端产物声明 configForms 注入面").toContain("configForms");
});

it("#362 客户端：工具级禁用 checkbox + scope 分组 + 全局组工具开关（#767 笔 2：模式下拉已删）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 工具 checkbox 经 tool-disable API 持久化。
  expect(clientSrc.includes("tool-disable"), "客户端含 tool-disable API 调用").toBeTruthy();
  expect(clientSrc.includes('type: "checkbox"'), "工具开关为 checkbox").toBeTruthy();
  expect(clientSrc.includes("dm-float-tools"), "浮窗折叠式工具清单存在").toBeTruthy();
  // #767 笔 2：全局组与项目组同权渲染工具开关（`tools: true`），模式下拉与「切 all」提示已删。
  expect(
    clientSrc.includes("{ tools: true, openTools }"),
    "项目组与全局组一律渲染工具开关",
  ).toBeTruthy();
  expect(clientSrc.includes("dm-set-middleware"), "设置页模式下拉已删").toBe(false);
  expect(clientSrc.includes("globalToolHint"), "全局工具提示 key 已删").toBe(false);
  // 浮窗与管理面板均按 scope 分组。
  expect(clientSrc.includes("dm-float-group-title"), "浮窗 scope 分组标题存在").toBeTruthy();
  expect(
    clientSrc.includes("项目级") && clientSrc.includes("全局"),
    "scope 分组文案存在",
  ).toBeTruthy();
  // #401 勾选 = 禁用：勾选态自绘为红色 ×（非原生蓝色 ✓），工具名同步标红。
  expect(
    // CSS 形态归 Prettier（style.css 在格式化面内），声明两侧的空白不作判据
    /appearance\s*:\s*none/.test(clientSrc),
    "工具 checkbox 自绘（appearance:none）",
  ).toBeTruthy();
  expect(clientSrc.includes("input:checked::after"), "勾选态用 ::after 绘制 ×").toBeTruthy();
  expect(clientSrc.includes("state-error-primary"), "勾选态使用错误红主题变量").toBeTruthy();
  expect(clientSrc.includes(":has(input:checked)"), "已禁用工具名同步标红").toBeTruthy();
});
it("client i18n 接线哨兵（issue #348 → #378 抽取 shared）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes('"mcpManager"'), "i18n 命名空间 NS 进产物").toBeTruthy();
  expect(clientSrc.includes("locale.register"), "locale.register（字典注册）进产物").toBeTruthy();
  expect(clientSrc.includes("bindLocale"), "bindLocale（t 活绑定装配）进产物").toBeTruthy();
  // T4（#378）：locale.subscribe 返回值保存为 unsubLocale 并在卸载时调用——
  // 防重复 apply 后旧订阅持续重绑已停用实例（对齐 provider-usage 范式）。
  expect(
    clientSrc.includes("unsubLocale = locale.subscribe"),
    "subscribe 返回值保存（unsubLocale）进产物",
  ).toBeTruthy();
  expect(
    /unsubLocale!=null&&unsubLocale\(\)|unsubLocale\(\)/.test(clientSrc),
    "卸载调用 unsubLocale() 进产物",
  ).toBeTruthy();
  expect(clientSrc.includes("locale: NS"), "slots.register locale 参数进产物").toBeTruthy();
  expect(
    clientSrc.includes("Running") && clientSrc.includes("stConnected"),
    "en/zh 双语字典 + STATUS_TEXT key 化进产物",
  ).toBeTruthy();
});
it("#362 无游离 css：style.css 全部内联进 client.js（无独立样式请求）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8");
  const probe =
    css
      .split("\n")
      .filter((line) => line.trim() !== "")
      .pop() ?? "";
  // 样式文件末尾规则应整体出现在 client.js 产物中（text-loader 原样内联）。
  expect(
    clientSrc.includes(probe.slice(0, 40)),
    "style.css 尾部规则已内联进 client.js",
  ).toBeTruthy();
  expect(!clientSrc.includes('rel="stylesheet"'), "无独立样式表请求").toBeTruthy();
});

// ---- 阶段 7 C 类修复哨兵断言（先红后绿：断言先行，修复随 commit 转绿）----
it("C1 编辑保存链路修复：fillForm 不再清空 editingName（PATCH 分支可达）+ enabled 回填", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 链路修复：fillForm 函数体（到 saveForm 为止）不得再调用会清空 editingName 的 resetForm。
  const fillFormStart = clientSrc.indexOf("function fillForm");
  const saveFormStart = clientSrc.indexOf("function saveForm");
  expect(
    fillFormStart >= 0 && saveFormStart > fillFormStart,
    "产物含 fillForm/saveForm 标识符",
  ).toBeTruthy();
  expect(
    !clientSrc.slice(fillFormStart, saveFormStart).includes("resetForm("),
    "fillForm 内不再调用 resetForm（清空 editingName 的链路修复）",
  ).toBeTruthy();
  // enabled 回填：编辑 enabled:false 服务器时表单 checkbox 不得被强制勾选（C1 附带回填）。
  expect(
    clientSrc.includes("fill.enabled"),
    "enabled 回填进产物（formEnabled.checked = fill.enabled !== false）",
  ).toBeTruthy();
});
it("C2 SSE 轮询探测恢复：eventsRetired 后周期性探测重连（非永久轮询）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(
    clientSrc.includes("tryResumeEvents"),
    "轮询恢复探测入口 tryResumeEvents 进产物",
  ).toBeTruthy();
  expect(clientSrc, "轮询计数周期性触发探测（pollTicks % N）").toMatch(/pollTicks\s*%/);
});
/**
 * style.css 的排版归 Prettier（该文件在格式化面内），而下面多处判据是按「无空格」的紧凑
 * 形态写的。这里把声明两侧的空白归一化，让判据只认声明内容、不认排版形态。
 */
function styleCssCompact() {
  return readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8").replace(
    /\s*([{}:;,])\s*/g,
    "$1",
  );
}

it("C3 超长名溢出防护：服务器名/工具名 CSS overflow-wrap", () => {
  const css = styleCssCompact();
  expect(css, "管理面板服务器名 overflow-wrap").toMatch(
    /\.dm-server \.dm-name\{[^}]*overflow-wrap:anywhere/,
  );
  expect(css, "浮窗工具 checkbox 名 overflow-wrap").toMatch(
    /\.dm-float-tool,\.dm-tool\{[^}]*overflow-wrap:anywhere/,
  );
});
it("C4 keydown 泄漏修复：Escape 监听具名 + 卸载配对移除", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(
    clientSrc.includes('addEventListener("keydown", onKeyDown)'),
    "keydown 监听具名 onKeyDown 进产物",
  ).toBeTruthy();
  expect(
    clientSrc.includes('removeEventListener("keydown", onKeyDown)'),
    "配对 removeEventListener 进产物",
  ).toBeTruthy();
});
it("C5 设置卡成功提示 setTimeout 清理（卸载不 setState）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("msgTimer"), "msgTimer ref 进产物").toBeTruthy();
  expect(clientSrc, "卸载/重复保存前清理 msgTimer").toMatch(/clearTimeout\(msgTimer\.current\)/);
});
it("C6 tool-disable 全名形态：projectRoot 缺失防御性不提交非法 @/name", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(
    clientSrc.includes("toolDisableServerKey"),
    "tool-disable 全名拼装 helper 进产物",
  ).toBeTruthy();
  // esbuild 保留模板串形态：helper 返回 `@@global/${server.name}`。
  expect(
    clientSrc.includes("`@@global/${server.name}`"),
    "global 形态 @@global/<name> 进产物（helper 模板串）",
  ).toBeTruthy();
});
it("C7 浮窗操作带 cwd：float connect/enable/disable 与 servers 对齐（#412 自愈）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // esbuild 保留模板串形态：float `&scope=${server.scope}${cwdQuery}`；servers `${scopeQuery}${cwdQuery}`。
  expect(
    clientSrc.includes("${server.scope}${cwdQuery}"),
    "float 操作 URL 拼接 cwdQuery 进产物",
  ).toBeTruthy();
  expect(
    clientSrc.includes("${scopeQuery}${cwdQuery}"),
    "servers disconnect/disable 补齐 cwdQuery 进产物",
  ).toBeTruthy();
});
it("C8 checkbox 折叠态保留：details 按 server 记录并恢复 open", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("openTools"), "渲染前记录展开的折叠组（openTools）进产物").toBeTruthy();
  expect(clientSrc, "重建后恢复 details.open 进产物").toMatch(/details\.open\s*=/);
});
it("C10 showPanel 主动刷新：面板打开即拉最新数据（中间层热切换错配）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const showStart = clientSrc.indexOf("function showPanel");
  expect(showStart >= 0, "showPanel 标识符在产物中").toBeTruthy();
  // 修复前 showPanel 内仅头部刷新按钮 onclick 有一次 refresh；修复后打开动作
  // 主动补一次 → ≥2 次（断言区分于 onclick 单次，防误绿）。
  const showBody = clientSrc.slice(showStart, showStart + 2500);
  const refreshCount = (showBody.match(/refresh\(state, actions\)/g) ?? []).length;
  expect(
    refreshCount >= 2,
    "showPanel 内 refresh 出现≥2 次（onclick + 打开主动刷新）",
  ).toBeTruthy();
});
it("C13 未知状态按 stopped 投影：servers 列表不静默丢卡（与 float 一致）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("renderServers"), "renderServers 标识符在产物中").toBeTruthy();
  // 契约锚点更正（#732 D 路复核）：C13 真正要锁的是 bucketByStatus 里「未知状态回落 stopped 桶」
  // （src/client/float/servers.ts 的 `byStatus.get(server.status) ?? byStatus.get("stopped")`），
  // 它不在 renderServers 内。原断言从 renderServers 起截 2000 字符，是靠窗口恰好跨到相邻函数
  // 才命中——函数体一变长就失效。改为直接锚 bucketByStatus 的回落读取，契约更准也更稳。
  expect(
    clientSrc.includes("function bucketByStatus"),
    "bucketByStatus 分桶函数进产物（C13 锚点）",
  ).toBeTruthy();
  expect(
    /function bucketByStatus[\s\S]{0,600}get\("stopped"\)/.test(clientSrc),
    '未知状态回落 stopped 桶（byStatus.get(status) ?? byStatus.get("stopped")，不丢卡）',
  ).toBeTruthy();
});
it("C11 编辑改 name/scope 迁移式保存：POST 新条目 + DELETE 旧条目（宿主 PATCH 不支持改名/scope）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // C11（阶段 8 落地，依赖阶段 7 C1 修复后 PATCH 分支可达）：saveForm 检测
  // name 或 scope 变化 → 迁移分支（先 POST 后 DELETE），避免新 scope 查旧
  // name 404。
  // #732 D 路拆解：迁移判定由内联表达式抽为具名谓词 isMigratedEdit / isEditing，
  // 编辑态由 state.editing 迁到 state.editingName。契约锁的是「迁移判定存在且用旧 scope」
  // 这一行为，锚点随之从局部变量名改为具名谓词——不回退拆解去迁就旧标识符。
  expect(
    clientSrc.includes("isMigratedEdit"),
    "迁移分支判定谓词 isMigratedEdit 进产物",
  ).toBeTruthy();
  expect(
    clientSrc.includes("isEditing"),
    "编辑态判定谓词 isEditing 进产物（state.editing → state.editingName）",
  ).toBeTruthy();
});

it("客户端 watchdog：60s 失活重建 + 建连前先关旧（0.1.8 同款防泄漏）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "60s watchdog 常量存在").toMatch(/WATCHDOG_MS\s*=\s*(?:60_?000|6e4|60000)/);
  expect(clientSrc.includes("forceReconnect"), "受控重建入口 forceReconnect 存在").toBeTruthy();
  expect(clientSrc.includes("closeEvents"), "关旧连接入口 closeEvents 存在").toBeTruthy();
  // 关旧建新：new EventSource 前必先关旧——覆盖 source 引用不 close 会耗尽
  // 浏览器同源并发连接（dsh-notifier 0.1.8 同款事故）。
  expect(
    clientSrc.indexOf("closeEvents()") >= 0 &&
      clientSrc.indexOf("closeEvents()") < clientSrc.indexOf("new EventSource"),
    "建连前先执行关旧兜底",
  ).toBeTruthy();
  expect(clientSrc, "收到数据帧即喂狗").toMatch(/lastActivity\s*=\s*Date\.now\(\)/);
  // 心跳 ping 帧喂狗后早退，不得落入 else 触发 scheduleRefresh（否则 SSE 退化为隐性 30s 轮询）。
  // #767 B1.5a：帧名的物理定义在 src/shared/frames.ts，客户端产物须引用该常量而非自带字面量
  // （帧名取值与两端一致由 test/e2e/cross-end-lock.test.ts 的冻结表判据盯）。
  expect(clientSrc, "ping 帧仅喂狗即早退（帧名取自 shared 单点）").toMatch(
    /===\s*SSE_FRAMES\.ping\)\s*return/,
  );
  // 卸载清理：watchdog 定时器与 SSE 连接都要收掉（esbuild 产物 undefined 折叠为 void 0）。
  expect(clientSrc, "卸载清 watchdog").toMatch(
    /if\s*\(watchdog\s*!==\s*(?:void 0|undefined)\)\s*clearTimeout\(watchdog\)/,
  );
  expect(clientSrc, "卸载关 SSE 并摘监听").toMatch(
    /closeEvents\(\);\s*document\.removeEventListener\("visibilitychange"/,
  );
});
it("回前台强制重建 SSE + 受控重建连接（visibilitychange → rebindSession → forceReconnect + resume + 补拉）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "visibilitychange 监听已挂").toMatch(
    /addEventListener\("visibilitychange",\s*onVisible\)/,
  );
  expect(clientSrc, "回前台路径先强制重建 SSE").toMatch(
    /onVisible\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(document\.hidden\)\s*return;\s*forceReconnect\(\)/,
  );
  // #412：切回前台先 rebindSession（宿主重启后 projectRoot 丢失，旧页面
  // bindSession 不重跑——强制 POST /session 恢复 projectRoot + 惰性连接），
  // 再 POST resume 驱动宿主受控重建当前工作空间连接（半开死连接卡 connected
  // 时纯读 refresh 无法恢复）。
  expect(clientSrc, "回前台路径先重绑会话再 resume（#412 复报：宿主重启场景恢复）").toMatch(
    /rebindSession\(state\)\.then\(\(\)\s*=>\s*api\(state\.API\.resume,\s*\{\s*method:\s*"POST"\s*\}\)\)/,
  );
  // iOS bfcache 恢复（pageshow persisted）等价切回前台，走同一恢复路径。
  expect(clientSrc, "pageshow 监听已挂（bfcache 恢复）").toMatch(
    /addEventListener\("pageshow",\s*onPageShow\)/,
  );
  expect(clientSrc, "pageshow persisted 才触发恢复").toMatch(
    /event\?\.persisted\s*===\s*true\s*\)\s*onVisible\(\)/,
  );
  // 宿主重启而页面始终可见（无 visibilitychange）：SSE 自动重连成功即核对宿主
  // 会话状态（onopen → maybeRecoverSession → GET /servers 校验 projectRoot）。
  expect(clientSrc, "SSE 连接建立时挂 onopen 探测").toMatch(/es\.onopen\s*=\s*\(\)\s*=>\s*\{/);
  expect(clientSrc, "onopen 触发宿主会话恢复探测").toMatch(/maybeRecoverSession\(\)/);
});

it("设置卡片样式对齐官方风格（#219：12px 圆角 / bg-layer-3 底 / border-l2 / 15px 名称字 / 13px 描述字 / 14 16 padding / gap 4）", () => {
  const css = styleCssCompact();
  expect(css, "卡片圆角对齐官方 12px").toMatch(/border-radius:12px/);
  expect(css, "卡片底色对齐官方 bg-layer-3").toMatch(
    /background:var\(--dsw-alias-bg-layer-3,#fbfbfc\)/,
  );
  expect(css, "卡片边框对齐官方 border-l2").toMatch(
    /border:1px solid var\(--dsw-alias-border-l2,#e2e5ea\)/,
  );
  expect(css, "head padding 对齐官方 14px 16px").toMatch(
    /\.dm-set-head\{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px/,
  );
  expect(css, "headText gap 对齐官方 4px").toMatch(
    /\.dm-set-headText\{display:flex;flex-direction:column;gap:4px/,
  );
  expect(css, "名称字号对齐官方 15px").toMatch(
    /\.dm-set-name\{display:block;font-size:15px;font-weight:600;line-height:1\.4/,
  );
  expect(css, "描述字号对齐官方 13px").toMatch(
    /\.dm-set-description\{display:block;font-size:13px;line-height:1\.5/,
  );
  expect(css, "描述用 tertiary 层级（与官方同款）").toMatch(/--dsw-alias-label-tertiary,#8a919c/);
});

it("F1（qa 实测 #128）：浮窗面板内容更新后重定位 + toggleFloat 先渲染后定位", () => {
  const src = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // renderFloatPanel 函数体内触发 placePanel 重定位：bottom-* 锚点下内容撑高后
  // 不重排会稳定向下溢出视口（375x667 bottom-left 实测 y=561/bottom=1082 稳态）。
  const renderStart = src.indexOf("function renderFloatPanel");
  const toggleStart = src.indexOf("function toggleFloat");
  expect(
    renderStart >= 0 && toggleStart > renderStart,
    "产物含 renderFloatPanel/toggleFloat 标识符",
  ).toBeTruthy();
  expect(
    src.slice(renderStart, toggleStart).includes("placePanel(state)"),
    "renderFloatPanel 内容渲染完成即触发 placePanel 重定位（bottom 锚点防溢出）",
  ).toBeTruthy();
  // toggleFloat 内先渲染后定位：以真实内容高度定位，消除首帧小高度错位。
  const tf = src.slice(toggleStart);
  expect(
    tf.indexOf("renderFloatPanel(state, actions)") >= 0 &&
      tf.indexOf("renderFloatPanel(state, actions)") < tf.indexOf("placePanel(state)"),
    "toggleFloat 先 renderFloatPanel 后 placePanel",
  ).toBeTruthy();
});

it("Liquid Glass 失败优先 + 浮窗 Esc + 关窗时序 + 降级存在性（#938）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 失败优先：renderFloatPanel 内先挂 attention 分组（groupAttention），再走 scope 分组。
  const renderStart = clientSrc.indexOf("function renderFloatPanel");
  const toggleStart = clientSrc.indexOf("function toggleFloat");
  expect(renderStart >= 0, "renderFloatPanel 标识符在产物中").toBeTruthy();
  const renderBody = clientSrc.slice(renderStart, toggleStart);
  expect(
    renderBody.includes("groupAttention"),
    "attention 分组（失败优先置顶）进产物",
  ).toBeTruthy();
  expect(
    renderBody.indexOf("groupAttention") < renderBody.indexOf('["project", "global"]'),
    "attention 分组挂载先于 scope 分组（失败优先）",
  ).toBeTruthy();
  // 浮窗 Esc：与模态同语义，守卫 floatOpen（M3：宣称 Esc/焦点须有实现）。
  expect(
    clientSrc.includes('event.key === "Escape"') && clientSrc.includes("state.floatOpen"),
    "浮窗 Esc 关闭守卫进产物",
  ).toBeTruthy();
  // 关窗时序：JS setTimeout 300ms 与 CSS closing 300ms 对齐（源头不断即砍掉收尾动画）。
  expect(
    clientSrc.includes("setTimeout(finish, 300)"),
    "关窗 hidden 延迟 300ms 进产物",
  ).toBeTruthy();
  const css = styleCssCompact();
  expect(css, "浮窗关闭动画 300ms").toMatch(/dm-float-out 300ms/);
  expect(css, "模态关闭动画 300ms").toMatch(/dm-modal-out 300ms/);
  // 降级三件套存在（M2：缺一即红，防后续重构静默删 media 块）。
  expect(css.includes("prefers-reduced-motion"), "reduced-motion 降级存在").toBeTruthy();
  expect(css.includes("prefers-contrast"), "对比度降级存在").toBeTruthy();
  expect(css.includes("prefers-reduced-transparency"), "减透明降级存在").toBeTruthy();
  expect(css.includes('[data-color-mode="dark"]'), "深色三选择器含 data-color-mode").toBeTruthy();
  // 双主题 wash：变量定义 + 深色覆写存在（M1：深色下禁止写死浅色 wash）。
  expect(css.includes("--dm-wash:"), "主题跟随 wash 变量存在").toBeTruthy();
  expect(css.includes("--dm-card-bg:"), "卡片底变量存在").toBeTruthy();
  expect(css.includes("--dm-row-hover:"), "行 hover 变量存在").toBeTruthy();
});

it("Config 导出且含 ui 子对象（默认值与合法值域）", () => {
  expect(typeof Config === "function", "Config 是 schemastery schema（可调用）").toBeTruthy();
  const parsed = Config({} as Parameters<typeof Config>[0]);
  expect(parsed.ui.position, "ui.position 默认 top-right").toBe("top-right");
  expect(parsed.ui.offset, "ui.offset 默认 {x:8,y:8,blankY:40}").toEqual({
    x: 8,
    y: 8,
    blankY: 40,
  });
  expect(parsed.ui.zIndexBase, "#128 ui.zIndexBase 默认 10").toBe(10);
  expect(DEFAULT_UI_CONFIG.position, "DEFAULT_UI_CONFIG.position 与升级前一致").toBe("top-right");
  expect(DEFAULT_UI_CONFIG.offset).toEqual({ x: 8, y: 8, blankY: 40 });
  expect(
    DEFAULT_UI_CONFIG.zIndexBase,
    "#128 DEFAULT_UI_CONFIG.zIndexBase 与 CSS 默认 z-index 一致",
  ).toBe(10);
  // 合法值域：四角全部透传（#128 补左上/左下）
  for (const p of ["top-left", "bottom-left"] as const) {
    const parsedP = Config({ ui: { position: p } } as Parameters<typeof Config>[0]);
    expect(parsedP.ui.position, `#128 ${p} 是合法 position`).toBe(p);
  }
  const bottom = Config({ ui: { position: "bottom-right" } } as Parameters<typeof Config>[0]);
  expect(bottom.ui.position, "bottom-right 是合法 position").toBe("bottom-right");
  // #767 笔 2：两个中间层配置键删净——顶层键集恰好 6 项且不含 middleware / middlewarePolicy
  // （键集判据用逐字相等，多键少键都红；storePath 无默认值，不在其中）。
  expect(Object.keys(parsed).sort(), "Config 顶层键集（8→6）").toEqual([
    "announceCatalog",
    "announceToAgent",
    "catalogMaxEntries",
    "debug",
    "enabled",
    "ui",
  ]);
});
it("normalizeUiConfig：默认 / 合法值透传 / 非法回退（不抛）", () => {
  // 未配置 → 默认
  expect(normalizeUiConfig(undefined)).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig(null)).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  // 新 Config.ui 嵌套形态
  expect(
    normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 } } }),
  ).toEqual({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 10 });
  // 旧隐藏命名空间扁平形态（position/offset）→ 兼容
  expect(
    normalizeUiConfig({ position: "bottom-right", offset: { x: 5, y: 6, blankY: 50 } }),
  ).toEqual({ position: "bottom-right", offsetX: 5, offsetY: 6, blankY: 50, zIndexBase: 10 });
  // 客户端扁平形态（offsetX/offsetY/blankY）→ 兼容
  expect(
    normalizeUiConfig({ position: "bottom-right", offsetX: 3, offsetY: 4, blankY: 44 }),
  ).toEqual({ position: "bottom-right", offsetX: 3, offsetY: 4, blankY: 44, zIndexBase: 10 });
  // #128 zIndexBase clamp 边界：合法透传 / 越界压边界 / 非法回退默认
  expect(
    normalizeUiConfig({
      position: "top-left",
      offsetX: 1,
      offsetY: 2,
      blankY: 3,
      zIndexBase: 5000,
    }),
    "左上 + 合法层级基准透传",
  ).toEqual({ position: "top-left", offsetX: 1, offsetY: 2, blankY: 3, zIndexBase: 5000 });
  // 非法/缺失 → 安全回退默认，不抛
  expect(normalizeUiConfig({ position: "middle-left" })).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig({ ui: { position: "nope", offset: { x: "abc" } } })).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig({ offset: {} })).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase, "#128 低于下界压到 1").toBe(
    Z_INDEX_BASE_MIN,
  );
  expect(normalizeUiConfig({ zIndexBase: -50 }).zIndexBase, "#128 负数压到 1").toBe(
    Z_INDEX_BASE_MIN,
  );
  expect(normalizeUiConfig({ zIndexBase: 9000 }).zIndexBase, "#128 上界 9000 透传").toBe(
    Z_INDEX_BASE_MAX,
  );
  expect(normalizeUiConfig({ zIndexBase: 9001 }).zIndexBase, "#128 超上界压到 9000").toBe(
    Z_INDEX_BASE_MAX,
  );
  expect(normalizeUiConfig({ zIndexBase: Number.NaN }).zIndexBase, "#128 NaN 回退默认").toBe(10);
});
it("buildConfigUiPatch：客户端扁平形态 → Config.ui 嵌套补丁（写路径）", () => {
  // 客户端 POST 的扁平形态 → 宿主写入 Config.ui 的嵌套补丁
  expect(
    buildConfigUiPatch({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
  ).toEqual({ position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 10 });
  // #128 四角 + 层级基准写入嵌套补丁
  expect(
    buildConfigUiPatch({
      position: "bottom-left",
      offsetX: 12,
      offsetY: 20,
      blankY: 60,
      zIndexBase: 77,
    }),
  ).toEqual({ position: "bottom-left", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 77 });
  // 缺省 → 安全回退默认
  expect(buildConfigUiPatch(undefined)).toEqual({
    position: "top-right",
    offset: { x: 8, y: 8, blankY: 40 },
    zIndexBase: 10,
  });
  // 非法 position → 回退 top-right；负偏移 clamp 到 0
  expect(
    buildConfigUiPatch({ position: "middle-left", offsetX: -5, offsetY: 3.6, blankY: 40 }),
  ).toEqual({ position: "top-right", offset: { x: 0, y: 4, blankY: 40 }, zIndexBase: 10 });
});
it("README 含 position/offset 配置说明（键名与默认值，中英）", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = readFileSync(join(pkgDir, file), "utf8");
    expect(text.includes("position"), `${file} 未含 position 键`).toBeTruthy();
    expect(text.includes("top-right"), `${file} 未含 top-right（默认值）`).toBeTruthy();
    expect(text.includes("bottom-right"), `${file} 未含 bottom-right（合法值域）`).toBeTruthy();
    expect(text.includes("offset.x"), `${file} 未含 offset.x 键`).toBeTruthy();
    expect(text.includes("offset.y"), `${file} 未含 offset.y 键`).toBeTruthy();
    expect(text.includes("offset.blankY"), `${file} 未含 offset.blankY 键`).toBeTruthy();
    expect(text.includes("zIndexBase"), `#128 ${file} 未含 zIndexBase 键`).toBeTruthy();
    expect(
      text.includes("top-left") && text.includes("bottom-left"),
      `#128 ${file} 未含四角值域`,
    ).toBeTruthy();
    expect(/#116/.test(text), `#128 ${file} 未标注 #116 跨包避让契约`).toBeTruthy();
    const hotUpdatePhrase = file === "README.en.md" ? "without restarting" : "无需重启";
    expect(text.includes(hotUpdatePhrase), `${file} 未声明「保存即热更新无需重启」`).toBeTruthy();
  }
});

it("uiConfigChangedFrame 写出一帧 ui-config-changed", () => {
  expect(uiConfigChangedFrame()).toBe('data: {"type":"ui-config-changed"}\n\n');
  expect(sseData({ type: "ui-config-changed" }), "与 sseData 同构").toBe(uiConfigChangedFrame());
});
// #472 收敛锚定：lib/index.js 仍可 import sseData（re-export 面不漂移），
// 且输出与 shared/host-utils.js 单一事实源一致（防 re-export 链被误删/改指）。
it("lib/index.js 导出 sseData 且输出与 shared/host-utils.js 一致（#472）", async () => {
  const { sseData: libSseData } = await import("../../lib/index.js");
  const { sseData: sharedSseData } = await import("../../../../shared/host-utils.js");
  expect(typeof libSseData, "lib/index.js 可 import sseData").toBe("function");
  expect(libSseData({ type: "ui-config-changed" })).toBe(
    sharedSseData({ type: "ui-config-changed" }),
  );
  expect(libSseData({ type: "ping" })).toBe('data: {"type":"ping"}\n\n');
});
it("broadcastFrame 向全部连接写帧（掉线忽略）", () => {
  const written: string[] = [];
  const conn = {
    write: (chunk: string) => {
      written.push(chunk);
    },
  };
  const dead = {
    write: () => {
      throw new Error("closed");
    },
  };
  broadcastFrame(
    new Set([conn, dead] as unknown as ServerResponse[]),
    'data: {"type":"summary"}\n\n',
  );
  expect(written).toEqual(['data: {"type":"summary"}\n\n']);
  broadcastFrame(undefined, "x"); // 无连接不抛
});

it("panelAnchorForPosition：bottom-* → bottom，top-* / 缺省 → top（#128 四角化）", () => {
  expect(panelAnchorForPosition("bottom-right")).toBe("bottom");
  expect(panelAnchorForPosition("bottom-left"), "#128 左下也是底部锚点").toBe("bottom");
  expect(panelAnchorForPosition("top-right")).toBe("top");
  expect(panelAnchorForPosition("top-left"), "#128 左上是顶部锚点").toBe("top");
  expect(panelAnchorForPosition(undefined), "缺省按顶部锚点（历史行为）").toBe("top");
});
it("#128 断点判定纯函数分支翻转（基准=conversationHost rect 宽度）", () => {
  expect(breakpointForWidth(320), "手机竖屏 narrow").toBe("narrow");
  expect(breakpointForWidth(BREAKPOINT_NARROW_MAX), "480 边界归 narrow").toBe("narrow");
  expect(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1), "481 翻转 tablet").toBe("tablet");
  expect(breakpointForWidth(768), "平板竖屏 tablet").toBe("tablet");
  expect(breakpointForWidth(BREAKPOINT_TABLET_MAX), "834 边界归 tablet").toBe("tablet");
  expect(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1), "835 翻转 wide").toBe("wide");
  expect(breakpointForWidth(Number.NaN), "异常宽度按 wide 兜底").toBe("wide");
});
it("#128 终坐标视口 clamp 纯函数（safe-area inset 恒 0 自然退化）", () => {
  expect(clampPointToViewport(-30, -50, 100, 80, 375, 667), "负坐标钳回视口原点").toEqual({
    x: 0,
    y: 0,
  });
  expect(clampPointToViewport(400, 700, 100, 80, 375, 667), "右/下溢出钳回视口内").toEqual({
    x: 275,
    y: 587,
  });
  expect(clampPointToViewport(10, 20, 100, 80, 375, 667), "视口内坐标不改变（桌面零回归）").toEqual(
    { x: 10, y: 20 },
  );
  expect(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10), "safeInset>0 按安全区内缩").toEqual(
    { x: 10, y: 10 },
  );
  expect(clampPointToViewport(0, 0, 9999, 9999, 375, 667), "元素大于视口时钳到原点不倒挂").toEqual({
    x: 0,
    y: 0,
  });
});
it("#128 重开：zIndexBase clamp 边界、主面板与胶囊同值、composer seat 贴底纯函数", () => {
  expect(clampZIndexBase(5000, 10), "合法值透传").toBe(5000);
  expect(clampZIndexBase(0, 10), "低于下界压到 1").toBe(Z_INDEX_BASE_MIN);
  expect(clampZIndexBase(-99, 10), "负数压到 1").toBe(Z_INDEX_BASE_MIN);
  expect(clampZIndexBase(9001, 10), "超上界压到 9000").toBe(Z_INDEX_BASE_MAX);
  expect(clampZIndexBase("junk", 10), "非数字回退默认").toBe(10);
  expect(clampZIndexBase(7.6, 10), "小数四舍五入").toBe(8);
  // B1/B2：主面板与胶囊同取配置值（不再派生 +30，维护者 2026-08-28 要求）
  expect(panelZIndexFor(10), "子浮层派生扩展点 base+30（B5，不占主面板预算）").toBe(40);
  expect(Z_INDEX_PANEL_DELTA, "子浮层派生量约定值").toBe(30);
  // D1-D4：composerDockedAtBottom / bottomAnchorEdge 矩阵
  const container = { top: 0, bottom: 844 };
  expect(
    composerDockedAtBottom({ top: 670, bottom: 844 }, container),
    "seat 贴底 → docked=true",
  ).toBe(true);
  expect(
    composerDockedAtBottom({ top: 670, bottom: 843 }, { top: 0, bottom: 844 }),
    "距底缘 1px 未贴底 → false",
  ).toBe(false);
  expect(
    composerDockedAtBottom({ top: 300, bottom: 500 }, { top: 0, bottom: 844 }),
    "seat 居中未贴底 → false",
  ).toBe(false);
  expect(composerDockedAtBottom(null, container), "seat null → false").toBe(false);
  expect(composerDockedAtBottom({ top: 670, bottom: 844 }, null), "container null → false").toBe(
    false,
  );
  expect(bottomAnchorEdge(844, 670, true), "docked → seatTop").toBe(670);
  expect(bottomAnchorEdge(844, 670, false), "未 docked → containerBottom").toBe(844);
  expect(bottomAnchorEdge(844, null, true), "seatTop=null → containerBottom").toBe(844);
  expect(
    bottomAnchorEdge(844, Number.NaN, true),
    "seatTop 非有限数 → containerBottom（无 NaN）",
  ).toBe(844);
});
it("F1（qa 实测 #128）：bottom 锚点首开小高度→数据撑高→重定位后不溢出", () => {
  // 375x667 视口、bottom-right、胶囊 offsetY(blankY 同构取 8)/高 26px → 上缘 633。
  const vw = 375;
  const vh = 667;
  const pillTop = vh - 26 - 8; // 633
  const gap = 6;
  const h1 = 40; // 打开瞬间小高度
  const h2 = 500; // SSE 刷新撑高后
  const p1 = clampPointToViewport(0, Math.max(6, pillTop - h1 - gap), 340, h1, vw, vh);
  expect(p1.y + h1 <= vh, "阶段1 小高度定位在视口内").toBeTruthy();
  expect(p1.y + h2 > vh, "对照：缺重定位时同坐标撑高必溢出（锁定 F1 根因）").toBeTruthy();
  const p2 = clampPointToViewport(0, Math.max(6, pillTop - h2 - gap), 340, h2, vw, vh);
  expect(p2.y + h2 <= vh, "阶段2 内容更新后重定位，底缘不出视口").toBeTruthy();
  expect(p2.y >= 6 && p2.y < pillTop, "阶段2 保持底部锚点上弹语义").toBeTruthy();
});
it("panelTopForAnchor：底部锚点向上弹出 / 顶部锚点向下弹出", () => {
  // 底部锚点（pill 在视口下部）：面板向上，下缘贴近 pill 上缘（pTop - panelHeight - gap）
  expect(panelTopForAnchor("bottom", 600, 640, 200, 6), "底部锚点上弹").toBe(394);
  // 顶部锚点（pill 在视口上部）：面板向下（pillBottom + gap），历史行为不变
  expect(panelTopForAnchor("top", 40, 80, 200, 6), "顶部锚点下弹").toBe(86);
  // clamp：底部锚点面板过高时钳到视口上缘（不溢出）
  expect(panelTopForAnchor("bottom", 30, 70, 2000, 6), "底部锚点上弹 clamp 到视口内").toBe(6);
});

it("stdio 服务器规范化", () => {
  const server = normalizeServer({
    name: "context7-stdio",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@context7/mcp-server"],
    env: { CONTEXT7_API_KEY: "abc" },
    description: "上下文检索（自定义描述）",
  });
  expect(server.name).toBe("context7-stdio");
  expect(server.transport).toBe("stdio");
  expect(server.enabled).toBe(true);
  expect(server.command).toBe("npx");
  expect(server.args).toEqual(["-y", "@context7/mcp-server"]);
  expect(server.toolCallTimeoutMs, "超时默认下探至 15s").toBe(15_000);
  expect(server.description).toBe("上下文检索（自定义描述）");
  expect(
    normalizeServer({ name: "a", transport: "stdio", command: "x", description: "  " }).description,
    "空白描述归一为 undefined",
  ).toBe(undefined);
  expect(
    normalizeServer({ name: "a", transport: "stdio", command: "x", description: "长".repeat(200) })
      .description?.length,
    "描述完整返回不截断",
  ).toBe(200);
});
it("streamable-http 服务器规范化", () => {
  const server = normalizeServer({
    name: "context7",
    transport: "streamable-http",
    url: "https://mcp.context7.com/mcp",
    headers: { Authorization: "Bearer x" },
  });
  expect(server.transport).toBe("streamable-http");
  expect(server.url).toBe("https://mcp.context7.com/mcp");
  expect(server.headers).toEqual({ Authorization: "Bearer x" });
});
it("非法名称被拒绝", () => {
  expect(() => normalizeServer({ name: "bad name!", transport: "stdio", command: "x" })).toThrow();
  expect(() => normalizeServer({ name: "", transport: "stdio", command: "x" })).toThrow();
});
it("非法传输被拒绝", () => {
  expect(() => normalizeServer({ name: "a", transport: "sse", command: "x" })).toThrow();
});
it("stdio 缺 command 被拒绝", () => {
  expect(() => normalizeServer({ name: "a", transport: "stdio" })).toThrow();
});
it("http 缺 url / 非法 url 被拒绝", () => {
  expect(() => normalizeServer({ name: "a", transport: "streamable-http" })).toThrow();
  expect(() =>
    normalizeServer({ name: "a", transport: "streamable-http", url: "not a url" }),
  ).toThrow();
});
it("B13: http(s) 之外的协议被拒绝（ftp/file 非 streamable-http）", () => {
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "ftp://host/path" }),
    "B13：ftp 协议拒绝",
  ).toThrow(/protocol/);
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "file:///etc/passwd" }),
    "B13：file 协议拒绝",
  ).toThrow(/protocol/);
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "https://host/path" }),
    "https 放行",
  ).not.toThrow();
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "http://host/path" }),
    "http 放行",
  ).not.toThrow();
});
it("enabled: false 保留", () => {
  expect(
    normalizeServer({ name: "a", transport: "stdio", command: "x", enabled: false }).enabled,
  ).toBe(false);
});

it("stdio 条目映射", () => {
  const server = fromClaudeEntry("github", {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "tok" },
  });
  expect(server.transport).toBe("stdio");
  expect(server.command).toBe("npx");
  expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
  expect(server.env).toEqual({ GITHUB_TOKEN: "tok" });
});
it("http 条目映射", () => {
  const server = fromClaudeEntry("remote", {
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer x" },
  });
  expect(server.transport).toBe("streamable-http");
  expect(server.url).toBe("https://mcp.example.com/mcp");
});
it("sse 条目按 streamable-http 映射", () => {
  const server = fromClaudeEntry("sse-server", { type: "sse", url: "https://mcp.example.com/sse" });
  expect(server.transport).toBe("streamable-http");
  expect(server.url).toBe("https://mcp.example.com/sse");
});
it("无 command 且无 url 的条目被拒绝", () => {
  expect(() => fromClaudeEntry("bad", { type: "unknown" })).toThrow();
});
it("parseClaudeJson 解析整段 mcpServers", () => {
  const servers = parseClaudeJson(
    JSON.stringify({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      remote: { type: "http", url: "https://mcp.example.com/mcp" },
    }),
  );
  expect(servers.length).toBe(2);
  expect(servers[0].name).toBe("github");
  expect(servers[1].transport).toBe("streamable-http");
});
it("parseClaudeJson 拒绝非法 JSON", () => {
  expect(() => parseClaudeJson("[1,2]")).toThrow();
  expect(() => parseClaudeJson("not json")).toThrow();
});

it("publicToolName 确定性", () => {
  expect(publicToolName("context7", "use_context7")).toBe("mcp__context7__use_context7");
  expect(publicToolName("context7", "use_context7")).toBe(
    publicToolName("context7", "use_context7"),
  );
  expect(publicToolName("a", "b").startsWith("mcp__a__b")).toBeTruthy();
});
it("publicToolName 超长名加哈希后缀", () => {
  const longName = "tool_".repeat(20);
  const pub = publicToolName("server", longName);
  expect(pub.length <= 64).toBeTruthy();
  expect(pub).toMatch(/^[A-Za-z0-9_-]+$/);
});
it("expandEnv 展开 ${ENV}", () => {
  const before = process.env.DSH_MCP_SMOKE_VAR;
  process.env.DSH_MCP_SMOKE_VAR = "hello";
  try {
    expect(expandEnv("Bearer ${DSH_MCP_SMOKE_VAR}")).toBe("Bearer hello");
    expect(expandEnv("x ${DSH_MCP_SMOKE_MISSING_123} y")).toBe("x  y");
  } finally {
    if (before === undefined) delete process.env.DSH_MCP_SMOKE_VAR;
    else process.env.DSH_MCP_SMOKE_VAR = before;
  }
});

it("保存并读回", async () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
    await store.save();
    const reloaded = new McpStore(path);
    await reloaded.load();
    expect(reloaded.data.servers.length).toBe(1);
    expect(reloaded.data.servers[0].name).toBe("a");
  } finally {
    cleanup();
  }
});
it("upsert / remove", async () => {
  const { store, cleanup } = tempStore();
  try {
    store.upsert({ name: "a" } as ServerConfig);
    store.upsert({ name: "b" } as ServerConfig);
    expect(store.data.servers.length).toBe(2);
    store.upsert({ name: "a", extra: 1 } as unknown as ServerConfig);
    expect(store.data.servers.length).toBe(2);
    store.remove("a");
    expect(store.find("a")).toBe(undefined);
  } finally {
    cleanup();
  }
});
it("reloadIfChanged：外部修改重读 / 未变跳过 / 删除清空", async () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
    await store.save();
    expect(await store.reloadIfChanged(), "无外部变更不重读").toBe(false);
    // 外部修改（模拟 git pull / 手动编辑 mcp.json）——显式拨未来 mtime，
    // 避免与 save() 基线同毫秒导致 reloadIfChanged 检测不到（事件驱动替代固定 sleep）。
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        servers: [{ name: "b", transport: "stdio", command: "echo", enabled: true }],
      }),
    );
    utimesSync(path, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    expect(await store.reloadIfChanged(), "外部修改触发重读").toBe(true);
    expect(store.data.servers.length).toBe(1);
    expect(store.data.servers[0].name, "重读后数据来自磁盘").toBe("b");
    expect(await store.reloadIfChanged(), "重读后基线推进").toBe(false);
    // 外部删除 → 清空配置（删除后 stat 失败 current=0，与基线 mtime 恒异，无需等待）。
    rmSync(path);
    expect(await store.reloadIfChanged(), "删除触发重读").toBe(true);
    expect(store.data.servers, "删除 = 清空配置").toEqual([]);
    expect(await store.reloadIfChanged(), "删除后基线推进").toBe(false);
  } finally {
    cleanup();
  }
});

describe("项目根发现（findProjectRoot / setSession）", () => {
  let base: string;
  let deep: string;
  let home: string;
  let leetcode: string;
  let proj: string;
  let projSub: string;
  let nomark: string;
  let findProjectRoot: (cwd: string | undefined) => Promise<string>;
  let manager: McpManager;
  let prevDshHome: string | undefined;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-root-"));
    deep = join(
      base,
      "d0",
      "d1",
      "d2",
      "d3",
      "d4",
      "d5",
      "d6",
      "d7",
      "d8",
      "d9",
      "d10",
      "d11",
      "d12",
      "d13",
      "d14",
    );
    home = join(deep, "home");
    leetcode = join(home, "dev", "leetcode");
    proj = join(base, "proj");
    projSub = join(proj, "sub");
    nomark = join(deep, "nomark");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    mkdirSync(leetcode, { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    mkdirSync(projSub, { recursive: true });
    mkdirSync(nomark, { recursive: true });
    // home 自身的项目级配置（空服务器列表，setSession 不会 spawn 进程）。
    // S2-b：项目级新形态（包分区），经 projectStoreFor 直读（旧扁平只走迁移读面）。
    mkdirSync(join(home, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    mkdirSync(join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    writeFileSync(
      join(home, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({ version: 1, servers: [] }),
    );
    writeFileSync(
      join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({ version: 1, servers: [] }),
    );
    prevDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(home, ".dsh");
    ({ findProjectRoot } = await import("../../lib/index.js"));
    manager = new McpManager(fakeManagerCtx(), new McpStore(join(base, "dsh-mcp.json")));
  });

  afterAll(async () => {
    await manager.dispose();
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    rmSync(base, { recursive: true, force: true });
  });

  it("home 下的空工作区不把 home 误判为项目根（回归：~/.dsh 串台）", async () => {
    const root = await findProjectRoot(leetcode);
    expect(root).toBe(leetcode);
    await manager.setSession(leetcode);
    expect(manager.projectRoot).toBe(leetcode);
    expect(manager.projectStore !== undefined).toBeTruthy();
    expect(
      (manager.summary() as unknown as { servers: { scope: string }[] }).servers.filter(
        (s: { scope: string }) => s.scope === "project",
      ).length,
    ).toBe(0);
  });

  it("子目录向上命中项目 .dsh 标记", async () => {
    const root = await findProjectRoot(projSub);
    expect(root).toBe(proj);
  });

  it("home 自身作为会话 cwd 时仍是合法项目根（fallback）", async () => {
    const root = await findProjectRoot(home);
    expect(root).toBe(home);
  });

  it("无标记目录 → cwd 本身", async () => {
    expect(await findProjectRoot(nomark)).toBe(nomark);
  });

  it("空 cwd 清空项目级会话且幂等", async () => {
    await manager.setSession("");
    expect(manager.projectRoot).toBe(undefined);
    expect(manager.projectStore).toBe(undefined);
    // 再次清空：守卫应直接返回（不抛、不重复广播）
    await manager.setSession("");
    await manager.setSession(undefined);
    expect(manager.projectStore).toBe(undefined);
  });

  it("切回带 .dsh 的项目：加载项目级 store", async () => {
    await manager.setSession(proj);
    expect(manager.projectRoot).toBe(proj);
    expect(manager.projectStore !== undefined).toBeTruthy();
  });
});

describe("目录数据源按工作区计算（切换工作区不抖动）", () => {
  let base: string;
  let rootA: string;
  let rootB: string;
  let subA: string;
  let noReconnect: { reconnect: { enabled: boolean } };
  let gstore: McpStore;
  let manager: McpManager;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-cat-"));
    rootA = join(base, "projA");
    rootB = join(base, "projB");
    subA = join(rootA, "sub");
    mkdirSync(join(rootA, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    mkdirSync(join(rootB, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    mkdirSync(subA, { recursive: true });
    noReconnect = { reconnect: { enabled: false } };
    // S2-b：项目级新形态直写（经 catalogServersFor→projectStoreFor 直读）。
    writeFileSync(
      join(rootA, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          normalizeServer({ name: "a1", transport: "stdio", command: "true", ...noReconnect }),
        ],
      }),
    );
    writeFileSync(
      join(rootB, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          normalizeServer({ name: "b1", transport: "stdio", command: "true", ...noReconnect }),
        ],
      }),
    );

    gstore = new McpStore(join(base, "dsh-mcp.json"));
    gstore.data.servers = [
      normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }),
    ];
    manager = new McpManager(fakeManagerCtx(), gstore);
  });

  afterAll(async () => {
    await manager.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it("cwd 属于 projA → 全局 + a1", async () => {
    const names = [...(await manager.catalogServersFor(subA)).keys()];
    expect(names).toEqual(["g1", "a1"]);
  });

  it("cwd 属于 projB → 全局 + b1", async () => {
    const names = [...(await manager.catalogServersFor(rootB)).keys()];
    expect(names).toEqual(["g1", "b1"]);
  });

  it("host 切换会话后 projA 的目录不变（回归：切换工作区不再抖动）", async () => {
    await manager.setSession(rootB);
    const names = [...(await manager.catalogServersFor(subA)).keys()];
    expect(names).toEqual(["g1", "a1"]);
  });

  it("空 cwd → 仅全局", async () => {
    const names = [...(await manager.catalogServersFor("")).keys()];
    expect(names).toEqual(["g1"]);
  });

  it("同名碰撞取项目条目（项目优先，#770-11）", async () => {
    // projB 里放一台与全局同名的服务器（描述打标，用于断言取的是项目条目）。
    const storeB = (await manager.projectStoreFor(rootB))!;
    storeB.upsert(
      normalizeServer({
        name: "g1",
        transport: "stdio",
        command: "true",
        description: "from-project",
        ...noReconnect,
      }),
    );
    const catalog = await manager.catalogServersFor(rootB);
    expect([...catalog.keys()]).toEqual(["g1", "b1"]);
    const g1 = catalog.get("g1")!;
    expect(g1.scope).toBe(SCOPE_PROJECT);
    expect(g1.server.description).toBe("from-project");
  });

  it("projectStoreFor 缓存复用（同 root 返回同一实例）", async () => {
    const first = await manager.projectStoreFor(rootA);
    const second = await manager.projectStoreFor(rootA);
    expect(first).toBe(second);
  });

  it("setSession 复用工作区缓存（不重复读盘）", async () => {
    await manager.setSession(rootA);
    const current = manager.projectStore;
    await manager.setSession(rootB);
    await manager.setSession(rootA);
    expect(manager.projectStore).toBe(current);
  });

  it("运行时注入（runtimeRegistry）并入目录数据源（#359）", async () => {
    await manager.registerServer(
      normalizeServer({ name: "rt1", transport: "stdio", command: "true", ...noReconnect }),
    );
    const names = [...(await manager.catalogServersFor("")).keys()];
    expect(names).toEqual(["g1", "rt1"]);
    // 同名 runtime 优先于 store（与 reconcile 双轨一致）——目录仍含该名。
    await manager.registerServer(
      normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }),
    );
    const g1 = (await manager.catalogServersFor("")).get("g1");
    expect(g1 !== undefined && g1.server !== undefined, "g1 仍在目录中").toBe(true);
  });
});

describe("外部配置变更自动重读（refreshFromDisk / reconcileServers）", () => {
  let base: string;
  let proj: string;
  let cfg: string;
  let gstore: McpStore;
  let manager: McpManager;
  let poolUnit: {
    root: string;
    connections: Map<string, Record<string, unknown>>;
    userDisabled: Set<string>;
    lastTouchedAt: number;
    inFlight: Map<string, Promise<unknown>>;
  };
  let released: string[];
  let ensured: string[];

  /** 往池替身里塞一条「已连接」的 ghost 条目（不 spawn 真实连接）。 */
  function seedGhost() {
    poolUnit.connections.set("ghost", {
      server: normalizeServer({ name: "ghost", transport: "stdio", command: "true" }),
      id: undefined,
      handle: undefined,
      status: "connected",
      error: undefined,
      connectedAt: Date.now(),
      readySettled: true,
      everConnected: true,
      disposed: false,
    });
  }

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-reload-"));
    proj = join(base, "proj");
    // S2-b：项目级新形态直写（经 setSession→projectStoreFor 直读；旧扁平只走迁移）。
    cfg = join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json");
    mkdirSync(join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
    gstore = new McpStore(join(base, "dsh-mcp.json"));
    // 全局 disabled 服务器：验证 reconcile 不会为其 spawn 进程。
    gstore.data.servers = [
      normalizeServer({ name: "g1", transport: "stdio", command: "true", enabled: false }),
    ];
    await gstore.save();
    manager = new McpManager(fakeManagerCtx(), gstore);
    await manager.setSession(proj);
    // 单池（#767 笔 1a）：连接唯一账本是中间层单元表。这里挂一个最小池替身，只回答
    // 「释放了哪条连接」「确保连接了哪条」——真正的装载/拆除语义（releaseServer 的调用序）
    // 由 unit-manager2 的真装载用例（假 loader）钉住。旧直连账本（manager.supervisors）
    // 已整体退役。
    released = [];
    ensured = [];
    poolUnit = {
      root: proj,
      connections: new Map(),
      userDisabled: new Set<string>(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    };
    manager.middleware = {
      units: new Map([[proj, poolUnit]]),
      releaseConnection: (root: string, name: string) => {
        released.push(root + "\u0000" + name);
        return poolUnit.connections.delete(name);
      },
      projectUnitFor: async () => undefined,
      ensureConnected: async (root: string, name: string) => {
        ensured.push(root + "\u0000" + name);
      },
      abandonInFlight: () => {},
      statusOf: () => undefined,
      toolCountOf: () => 0,
      dispose: async () => {},
    } as unknown as McpManager["middleware"];
    seedGhost();
  });

  afterAll(async () => {
    await manager.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it("项目级配置初始为空（setSession 后不自动 spawn）", () => {
    expect(manager.projectStore!.data.servers.length).toBe(0);
  });

  it("外部新增 disabled 服务器 → refreshFromDisk 重读并进 summary（不 spawn）", async () => {
    // 显式拨未来 mtime，避免与 setSession 基线同毫秒导致 reloadIfChanged 检测不到。
    writeFileSync(
      cfg,
      JSON.stringify({
        version: 1,
        servers: [
          normalizeServer({ name: "p1", transport: "stdio", command: "true", enabled: false }),
        ],
      }),
    );
    utimesSync(cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await manager.refreshFromDisk();
    const names = (
      manager.summary() as unknown as { servers: { scope: string; name: string }[] }
    ).servers
      .filter((s: { scope: string }) => s.scope === SCOPE_PROJECT)
      .map((s: { name: string }) => s.name);
    expect(names, "外部新增出现在面板数据").toEqual(["p1"]);
    expect(
      ensured.some((k) => k.endsWith("\u0000p1")),
      "disabled 不触达连接",
    ).toBe(false);
  });

  it("外部移除配置 → 池内已连接条目被释放", async () => {
    seedGhost();
    released.length = 0;
    writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
    utimesSync(cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await manager.refreshFromDisk();
    expect(
      released.some((k) => k.endsWith("\u0000ghost")),
      "ghost 的池连接被释放",
    ).toBe(true);
    expect(poolUnit.connections.has("ghost"), "ghost 已不在池").toBe(false);
  });

  it("无配置变化时 refreshFromDisk 不广播（防 SSE 空转循环）", async () => {
    // 前一测试的 emitStatus 是 coalesce 异步（setTimeout 0）：哨兵主动 emit 一次
    // 并轮询等其落定（事件驱动替代固定 sleep），再注册本测试计数监听，
    // 避免上一轮广播误入本测试的监听计数。
    let settled = 0;
    const offSentinel = manager.onStatus(() => {
      settled += 1;
    });
    manager.emitStatus();
    await pollUntil("coalesce 广播落定", () => settled >= 1);
    offSentinel();
    let emitted = 0;
    manager.onStatus(() => {
      emitted += 1;
    });
    await manager.refreshFromDisk();
    expect(emitted, "无变化不 emitStatus").toBe(0);
  });
});

describe("路由（makeRoutes / events / health / tool-disable / resume）", () => {
  let store: McpStore;
  let cleanup: () => void;
  let managerState: {
    sessionCwd: string | undefined;
    lastScope: string | undefined;
    resumed: number;
  };
  let uiCfg: {
    position: string;
    offsetX: number;
    offsetY: number;
    blankY: number;
    zIndexBase?: number;
  };
  let manager: {
    store: McpStore;
    logger: { warn: () => void; info: () => void; error: () => void };
    summary: () => { servers: unknown[]; counts: Record<string, unknown> };
    uiConfig: () => {
      position: string;
      offsetX: number;
      offsetY: number;
      blankY: number;
      zIndexBase?: number;
    };
    updateUiConfig: (raw: unknown) => Promise<{
      position: string;
      offsetX: number;
      offsetY: number;
      blankY: number;
      zIndexBase?: number;
    }>;
    refreshFromDisk: () => Promise<void>;
    setSession: (cwd: string | undefined) => Promise<void>;
    add: (body: Record<string, unknown>, scope?: string) => Promise<ServerConfig>;
    update: (nm: string, patch: Record<string, unknown>, scope?: string) => Promise<ServerConfig>;
    remove: (nm: string, scope?: string) => Promise<void>;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    reconnect: () => Promise<void>;
    resumeReconnect: () => Promise<void>;
  };
  let routes: WebRoute[];
  let find: (path: string) => WebRoute;
  let fakeReq: (method: string, url: string, body?: unknown) => IncomingMessage;
  let fakeFenceBroken: (method: string, url: string, body?: unknown) => IncomingMessage;

  beforeAll(async () => {
    ({ store, cleanup } = tempStore());
    managerState = { sessionCwd: undefined, lastScope: undefined, resumed: 0 };
    // 浮窗 UI 配置（可变，验证 config 读/写回传）。
    uiCfg = { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40 };
    manager = {
      store,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      summary: () => ({ servers: [], counts: {} }),
      uiConfig: () => uiCfg,
      updateUiConfig: async (raw: unknown) => {
        uiCfg = normalizeUiConfig(raw) as unknown as typeof uiCfg;
        return uiCfg;
      },
      refreshFromDisk: async () => {},
      setSession: async (cwd: string | undefined) => {
        managerState.sessionCwd = cwd;
      },
      add: async (body: Record<string, unknown>, scope?: string) => {
        managerState.lastScope = scope;
        const server = normalizeServer(body);
        if (store.find(server.name) !== undefined) {
          throw new Error(`server "${server.name}" already exists`);
        }
        store.upsert(server);
        return server;
      },
      update: async (nm: string, patch: Record<string, unknown>, scope?: string) => {
        managerState.lastScope = scope;
        const server = normalizeServer({
          ...(store.find(nm) as unknown as Record<string, unknown>),
          ...patch,
          name: nm,
        });
        store.upsert(server);
        return server;
      },
      remove: async (nm: string, scope?: string) => {
        managerState.lastScope = scope;
        store.remove(nm);
      },
      connect: async () => {},
      disconnect: async () => {},
      reconnect: async () => {},
      // #412 resume：切回前台受控重建当前工作空间连接（记录调用次数供路由断言）。
      resumeReconnect: async () => {
        managerState.resumed += 1;
      },
    };
    routes = makeRoutes(manager as unknown as Parameters<typeof makeRoutes>[0], process.cwd());
    find = (path: string) => routes.find((route) => route.path === path) as WebRoute;
    fakeReq = (method: string, url: string, body?: unknown) =>
      ({
        method,
        url,
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "localhost:3080",
          origin: "http://localhost:3080",
          "sec-fetch-site": "same-origin",
        },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      }) as unknown as IncomingMessage;
    fakeFenceBroken = (method: string, url: string, _body?: unknown) =>
      ({
        method,
        url,
        socket: { remoteAddress: "10.0.0.5" },
        headers: { host: "localhost:3080" },
        async *[Symbol.asyncIterator]() {},
      }) as unknown as IncomingMessage;
  });

  afterAll(async () => {
    cleanup();
  });

  it("注册 9 条 exact 路由（含 tool-disable / resume）", () => {
    expect(routes.length).toBe(9);
    for (const route of routes) expect(route.kind).toBe("exact");
  });

  it("GET servers → 200 + summary", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("GET", ROUTES.servers), res);
    expect(res.state.status).toBe(200);
    expect(JSON.parse(res.state.body)).toEqual({ servers: [], counts: {} });
  });

  it("POST servers → 201 + 添加", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
      res,
    );
    expect(res.state.status).toBe(201);
    expect(store.find("github")!.command).toBe("npx");
  });

  it("POST 重复名称 → 400", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
      res,
    );
    expect(res.state.status).toBe(400);
  });

  it("PATCH 更新 → 200", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("PATCH", `${ROUTES.servers}?name=github`, { args: ["-y", "x"] }),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(store.find("github")!.args).toEqual(["-y", "x"]);
  });

  it("DELETE → 200 + 移除", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=github`), res);
    expect(res.state.status).toBe(200);
    expect(store.find("github")).toBe(undefined);
  });

  it("非 loopback → 403", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeFenceBroken("GET", ROUTES.servers), res);
    expect(res.state.status).toBe(403);
  });

  it("config GET → 200 读回（默认 top-right/8/8/40）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), res);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.position).toBe("top-right");
    expect(body.offsetX).toBe(8);
    expect(body.offsetY).toBe(8);
    expect(body.blankY).toBe(40);
    // #767 笔 2：`middleware` 键已删，GET 只回 UI 配置（键集逐字相等防残留）。
    expect(Object.keys(body).sort(), "键集 = UI 配置 5 键的子集且无模式键").toEqual([
      "blankY",
      "offsetX",
      "offsetY",
      "position",
    ]);
  });

  it("config 非 loopback GET → 200（只读 UI 配置放开）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeFenceBroken("GET", ROUTES.config), res);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.position).toBe("top-right");
    expect(body.offsetX).toBe(8);
  });

  it("config POST 写 → 200 且读回更新（配置读写）", async () => {
    const write = fakeRes();
    await find(ROUTES.config).handler(
      fakeReq("POST", ROUTES.config, {
        position: "bottom-right",
        offsetX: 12,
        offsetY: 20,
        blankY: 60,
      }),
      write,
    );
    expect(write.state.status).toBe(200);
    const written = JSON.parse(write.state.body);
    expect(written.position).toBe("bottom-right");
    expect(written.offsetX).toBe(12);
    // 读回：POST 后 GET /config 应反映新值（宿主经设置命名空间持久化后的归一化结果）。
    const read = fakeRes();
    await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
    const readBack = JSON.parse(read.state.body);
    expect(readBack).toEqual({
      position: "bottom-right",
      offsetX: 12,
      offsetY: 20,
      blankY: 60,
      zIndexBase: 10,
    });
  });

  it("config POST 未知顶层键 → 400 且不落盘（M7）", async () => {
    const readNow = async () => {
      const read = fakeRes();
      await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
      return JSON.parse(read.state.body);
    };
    const before = await readNow();
    // `middleware` / `middlewarePolicy` 已删（笔 2）：它们与任意陌生键同走 400 路径。
    for (const body of [{ middleware: "off" }, { middlewarePolicy: {} }, { foo: 1 }]) {
      const write = fakeRes();
      await find(ROUTES.config).handler(fakeReq("POST", ROUTES.config, body), write);
      expect(write.state.status, `未知键 ${JSON.stringify(body)} 应 400`).toBe(400);
      expect(JSON.parse(write.state.body).error).toMatch(/unknown config key\(s\)/);
    }
    expect(await readNow(), "未知键不落盘：读回与写前逐字相等").toEqual(before);
  });

  it("config POST 非 loopback → 403（写操作不开放远程页面）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(
      fakeFenceBroken("POST", ROUTES.config, { position: "bottom-right" }),
      res,
    );
    expect(res.state.status).toBe(403);
  });

  it("config PUT → 405（仅 GET/POST 合法；方法错围栏）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(
      fakeReq("PUT", ROUTES.config, { position: "bottom-right" }),
      res,
    );
    expect(res.state.status).toBe(405);
  });

  it("events 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
    const eventsRoute = makeEventsRoute(
      manager as unknown as Parameters<typeof makeEventsRoute>[0],
    );
    const res403 = fakeRes();
    await eventsRoute.handler(fakeFenceBroken("GET", ROUTES.events), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await eventsRoute.handler(fakeReq("POST", ROUTES.events), res405);
    expect(res405.state.status).toBe(405);
  });

  it("health 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
    const healthRoute = makeHealthRoute(
      manager as unknown as Parameters<typeof makeHealthRoute>[0],
    );
    const res403 = fakeRes();
    await healthRoute.handler(fakeFenceBroken("GET", ROUTES.health), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await healthRoute.handler(fakeReq("POST", ROUTES.health), res405);
    expect(res405.state.status).toBe(405);
  });

  it("import/json 导入", async () => {
    const res = fakeRes();
    await find(ROUTES.importJson).handler(
      fakeReq("POST", ROUTES.importJson, {
        json: JSON.stringify({ alpha: { command: "npx", args: ["-y", "a"] } }),
      }),
      res,
    );
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.imported).toEqual(["alpha"]);
    expect(store.find("alpha")!.command).toBe("npx");
  });

  it("import/json 非法 JSON → 400", async () => {
    const res = fakeRes();
    await find(ROUTES.importJson).handler(
      fakeReq("POST", ROUTES.importJson, { json: "[1,2]" }),
      res,
    );
    expect(res.state.status).toBe(400);
  });

  it("tool-disable 围栏：非 loopback → 403 / GET → 405", async () => {
    const res403 = fakeRes();
    await find(ROUTES.toolDisable).handler(
      fakeFenceBroken("PATCH", ROUTES.toolDisable, { server: "@x/s", tool: "t", disabled: true }),
      res403,
    );
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await find(ROUTES.toolDisable).handler(fakeReq("GET", ROUTES.toolDisable), res405);
    expect(res405.state.status).toBe(405);
  });

  it("白名单外方法 → 405 + error 文案逐字（每端点 ≥1 锚；servers 为最大写面补缺）", async () => {
    // servers（R3 最大写面端点）：白名单 GET/POST/PATCH/DELETE 之外的方法 → 405+文案
    // 逐字——防守卫白名单误多列方法（围栏实质放宽而 403 用例仍绿）。
    for (const method of ["OPTIONS", "PUT"] as const) {
      const res = fakeRes();
      await find(ROUTES.servers).handler(fakeReq(method, ROUTES.servers), res);
      expect(res.state.status, `servers ${method} → 405`).toBe(405);
      expect(JSON.parse(res.state.body).error, `servers ${method} 405 文案逐字`).toBe(
        `method not allowed: ${method}`,
      );
    }
    // config（结构 β）：PUT 405 由 else 分支直出（不查 loopback），文案同源逐字。
    const cfgPut = fakeRes();
    await find(ROUTES.config).handler(
      fakeReq("PUT", ROUTES.config, { position: "bottom-right" }),
      cfgPut,
    );
    expect(cfgPut.state.status).toBe(405);
    expect(JSON.parse(cfgPut.state.body).error, "config PUT 405 文案逐字").toBe(
      "method not allowed: PUT",
    );
    const cfgOptions = fakeRes();
    await find(ROUTES.config).handler(fakeReq("OPTIONS", ROUTES.config), cfgOptions);
    expect(cfgOptions.state.status).toBe(405);
    expect(JSON.parse(cfgOptions.state.body).error, "config OPTIONS 405 文案逐字").toBe(
      "method not allowed: OPTIONS",
    );
    // 单方法端点：每端点 ≥1 非法方法 405+文案（守卫收口后错误文案统一出自 shared）。
    // events/health 不在 makeRoutes 返回列表（独立工厂路由），单独取 handler。
    const wrong: Array<[string, string, string]> = [
      ["session", ROUTES.session, "GET"],
      ["resume", ROUTES.resume, "GET"],
      ["connect", ROUTES.connect, "GET"],
      ["disconnect", ROUTES.disconnect, "GET"],
      ["reconnect", ROUTES.reconnect, "GET"],
      ["importJson", ROUTES.importJson, "GET"],
      ["toolDisable", ROUTES.toolDisable, "GET"],
    ];
    for (const [label, path, method] of wrong) {
      const res = fakeRes();
      await find(path).handler(fakeReq(method, path), res);
      expect(res.state.status, `${label} ${method} → 405`).toBe(405);
      expect(JSON.parse(res.state.body).error, `${label} 405 文案逐字`).toBe(
        `method not allowed: ${method}`,
      );
    }
    const eventsWrong = fakeRes();
    await makeEventsRoute(manager as unknown as Parameters<typeof makeEventsRoute>[0]).handler(
      fakeReq("POST", ROUTES.events),
      eventsWrong,
    );
    expect(eventsWrong.state.status).toBe(405);
    expect(JSON.parse(eventsWrong.state.body).error, "events 405 文案逐字").toBe(
      "method not allowed: POST",
    );
    const healthWrong = fakeRes();
    await makeHealthRoute(manager as unknown as Parameters<typeof makeHealthRoute>[0]).handler(
      fakeReq("POST", ROUTES.health),
      healthWrong,
    );
    expect(healthWrong.state.status).toBe(405);
    expect(JSON.parse(healthWrong.state.body).error, "health 405 文案逐字").toBe(
      "method not allowed: POST",
    );
  });

  it("resume：POST 合法 → 200 + 调用 resumeReconnect；围栏 403 / GET 405", async () => {
    const before = managerState.resumed;
    const res = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume), res);
    expect(res.state.status).toBe(200);
    expect(managerState.resumed, "resumeReconnect 被调用（#412 切回前台恢复入口）").toBe(
      before + 1,
    );
    const res403 = fakeRes();
    await find(ROUTES.resume).handler(fakeFenceBroken("POST", ROUTES.resume), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("GET", ROUTES.resume), res405);
    expect(res405.state.status).toBe(405);
  });

  it("tool-disable：缺 server/tool → 400；root 不属于工作空间 / setToolDisabled 未挂 → 400", async () => {
    const res1 = fakeRes();
    await find(ROUTES.toolDisable).handler(
      fakeReq("PATCH", ROUTES.toolDisable, { tool: "t", disabled: true }),
      res1,
    );
    expect(res1.state.status).toBe(400);
    const res2 = fakeRes();
    await find(ROUTES.toolDisable).handler(
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@x/s", tool: "t", disabled: true }),
      res2,
    );
    expect(res2.state.status, "root 不属于工作空间或不可写 → 400").toBe(400);
  });

  it("tool-disable：合法请求 → 200 且调用 setToolDisabled（scope=global → @global root）", async () => {
    const calls: { root: string; server: string; tool: string; disabled: boolean }[] = [];
    const tdManager = {
      ...manager,
      projectRoot: "/proj",
      setToolDisabled: async (root: string, server: string, tool: string, disabled: boolean) => {
        calls.push({ root, server, tool, disabled });
      },
    };
    const tdRoutes = makeRoutes(
      tdManager as unknown as Parameters<typeof makeRoutes>[0],
      process.cwd(),
    );
    const tdRoute = tdRoutes.find((route) => route.path === ROUTES.toolDisable)!;
    const res = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/ctx",
        tool: "use_ctx",
        disabled: true,
      }),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(calls).toEqual([{ root: "/proj", server: "ctx", tool: "use_ctx", disabled: true }]);
    // #392 遗留④：带 mcp__ 前缀的 tool 名剥前缀后入禁用表（旧客户端/手工 API 提交
    // 带前缀名仍生效；此前原样存键 → guard 查裸名不命中，禁用静默无效）。
    const resPrefix = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/ctx",
        tool: "mcp__ctx__use_ctx",
        disabled: true,
      }),
      resPrefix,
    );
    expect(resPrefix.state.status).toBe(200);
    expect(calls[calls.length - 1], "前缀名剥前缀入禁用表").toEqual({
      root: "/proj",
      server: "ctx",
      tool: "use_ctx",
      disabled: true,
    });
    // 跨 server 前缀（剥后仍 mcp__ 开头）→ 400（防错禁他 server 工具）。
    const resCross = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/ctx",
        tool: "mcp__other__t",
        disabled: true,
      }),
      resCross,
    );
    expect(resCross.state.status, "跨 server 前缀拒绝").toBe(400);
    // 全局 root：scope=global 的服务器以 @global 为 key。
    const resG = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, {
        server: "@/proj/gctx",
        tool: "use_g",
        disabled: true,
      }),
      resG,
    );
    expect(resG.state.status, "global 服务器（store 条目）以项目 root 为 key 可写").toBe(200);
  });

  it("POST session {cwd} → 200 并记录会话", async () => {
    const res = fakeRes();
    await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }), res);
    expect(res.state.status).toBe(200);
    expect(managerState.sessionCwd).toBe("C:/proj");
  });

  it("GET servers?cwd= 不触发会话切换（#324 纯读）", async () => {
    // #324：GET /servers 是纯读快照，cwd 参数被忽略（不再触发 setSession）。
    // 会话切换只走 POST /api/dsh-mcp/session。
    await find(ROUTES.session).handler(
      fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }),
      fakeRes(),
    );
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("GET", `${ROUTES.servers}?cwd=C:/other`), res);
    expect(res.state.status).toBe(200);
    expect(managerState.sessionCwd, "GET 不应改变会话 cwd").toBe("C:/proj");
  });

  it("POST servers scope=project 透传 scope", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, {
        name: "proj-mcp",
        transport: "stdio",
        command: "x",
        scope: "project",
      }),
      res,
    );
    expect(res.state.status).toBe(201);
    expect(managerState.lastScope).toBe("project");
  });

  it("DELETE ?scope=project 透传 scope", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("DELETE", `${ROUTES.servers}?name=proj-mcp&scope=project`),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(managerState.lastScope).toBe("project");
  });

  it("session 缺 cwd → 400", async () => {
    const res = fakeRes();
    await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, {}), res);
    expect(res.state.status).toBe(400);
  });
});

it("enabled:false 不注册路由/提示词", async () => {
  const ctx = fakeCtx();
  await apply(ctx, { enabled: false });
  expect(ctx.routes.length).toBe(0);
  expect(ctx.sections.length).toBe(0);
});
it("默认配置注册路由与提示词（空存储不连接）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-apply-"));
  const ctx = fakeCtx();
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    expect(ctx.routes.length).toBe(11); // 9 条业务路由 + 1 条 SSE events + 1 条 health
    expect(
      ctx.routes.some((route) => route.path === ROUTES.events),
      "SSE events 路由已注册",
    ).toBeTruthy();
    expect(ctx.sections.length).toBe(1);
    expect(ctx.sections[0].name).toBe("plugin:dsh-mcp-manager");
    expect(ctx.sections[0].text).toMatch(/dsh-mcp-manager/);
    // 分节顺序契约：官方 SECTION_ORDERS 在 0.1.2→0.1.5 期间重排（HARNESS_SOURCE/
    // WEB_SURFACE 从 -900/-800 移到 10000/10100）；本段落定位为「部署 persona 之后的
    // 补充说明」，该相对位置不变——此断言防未来官方再重排后本段落静默贬值。
    expect(ctx.sections[0].order, "分节 order 取具名常量（防裸数字漂移）").toBe(MCP_SECTION_ORDER);
    expect(
      ctx.sections[0].order > 0 && ctx.sections[0].order < 500,
      "分节位置落在官方 DEPLOYMENT_PERSONA_PREFIX(0) 与 PLAN_POLICY(500) 之间",
    ).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("#767 S1-5b：apply 恒注册中间层工具（与配置键无关）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-mwtools-"));
  const ctx = fakeCtx();
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    // 中间层实例与 ws_mcp_* 无条件装配（单池后它是唯一连接路径）；模板状态已无模式键，
    // 这条断言不再依赖任何热切换路径（#362 热切换用例随配置键一并删除）。
    const toolNames = ctx.registeredTools.map((def) => def.name);
    expect(toolNames.includes("ws_mcp_call"), "apply 恒注册中间层工具").toBeTruthy();
    expect(
      ctx.routes.some((route) => route.path === ROUTES.config),
      "config 路由已注册",
    ).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 回归 #125：保存按钮 POST /api/dsh-mcp/config 曾报 400（this.write undefined）。
// 根因：apply 的 uiUpdate sink 把 settings.update 解构后调用，丢失 cordis 服务方法
// 的 this（dsh-settings update() 内部访问 this.write）。此处注入一个「要求 this」的
// settings stub（update 内部访问 this.write），对 config 写路由做端到端断言：
// 修复后 settings.update 以正确 this 调用 → 200 + 落盘 + 通读回写值。
it("config POST 经 apply 注入 settings：update 保留 this 不再 400（回归 #125）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-settings-"));
  // 模拟 dsh-settings 服务：update 是方法（不绑 this），内部访问 this.write。
  // 若调用链解构丢 this，this 为 undefined → this.write 抛 TypeError → 路由 400。
  let scopeValue = { ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } } };
  const writeNamespaces: string[] = [];
  const settingsStub = {
    // 接缝经 describe 活读（闭包读当前 scopeValue，写后读回新值）。
    describe() {
      return [{ ns: "dsh-mcp-manager", value: { ...scopeValue }, revision: 0 }];
    },
    async write(ns: string, patch: unknown) {
      writeNamespaces.push(ns);
      scopeValue = { ...(scopeValue ?? {}), ...((patch ?? {}) as Record<string, unknown>) };
    },
    update(
      this: { write: (ns: string, patch: unknown) => Promise<unknown> },
      ns: string,
      patch: unknown,
    ) {
      if (!this || typeof this.write !== "function") {
        throw new TypeError("settings.update 被以错误 this 调用（this.write undefined）");
      }
      return this.write(ns, patch);
    },
  };
  const sctx = {
    settings: settingsStub,
    effect: (fn: () => unknown) => {
      fn();
      return () => {};
    },
  };
  const ctx = fakeCtx({
    inject: (keys: unknown, cb: (s: typeof sctx) => void) => {
      if (Array.isArray(keys) && keys.includes("settings")) cb(sctx);
      return () => {};
    },
  });
  const localReq = (method: string, url: string, body?: unknown) =>
    ({
      method,
      url,
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "localhost:3080",
        origin: "http://localhost:3080",
        "sec-fetch-site": "same-origin",
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    }) as unknown as FakeReq;
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    const configRoute = ctx.routes.find((route) => route.path === ROUTES.config);
    expect(configRoute, "config 路由已注册").toBeTruthy();
    const write = fakeRes();
    await configRoute!.handler(
      localReq("POST", ROUTES.config, {
        position: "bottom-right",
        offsetX: 12,
        offsetY: 20,
        blankY: 60,
      }),
      write,
    );
    expect(write.state.status, "settings.update 以正确 this 调用 → 写路由 200（不再 400）").toBe(
      200,
    );
    expect(writeNamespaces, "只向 canonical settings namespace 写入").toEqual(["dsh-mcp-manager"]);
    const written = JSON.parse(write.state.body);
    expect(written.position).toBe("bottom-right");
    expect(written.offsetX).toBe(12);
    expect(written.offsetY).toBe(20);
    expect(written.blankY).toBe(60);
    // 落盘：this 正确时 settings.update 内部 this.write 已把 Config.ui 补丁合并进 scope。
    expect(scopeValue.ui.offset, "settings.update 落盘（this.write 生效）").toEqual({
      x: 12,
      y: 20,
      blankY: 60,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("composeCatalogEntries 数据源（配置优先 → 缓存摘要 → 仅名字）", () => {
  const supervisors = new Map([
    ["srv-a", { server: { description: "自定义描述 A" }, tools: [], toolMeta: new Map() }],
    ["srv-b", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
  ]);
  const cache = new Map([["srv-b", { summary: "缓存摘要 B" }]]);
  const entries = composeCatalogEntries(
    supervisors as unknown as Parameters<typeof composeCatalogEntries>[0],
    6,
    cache,
  );
  expect(entries[0].text, "用户配置优先").toBe("自定义描述 A");
  expect(entries[1].text, "缓存摘要 fallback（无需用户配置）").toBe("缓存摘要 B");
  expect(entries[2].name, "无配置无缓存 → 条目按名称保留").toBe("srv-c");
  expect(
    Object.hasOwn(entries[2], "text"),
    "双缺省条目不含 text 属性（值断言防不了 text: undefined，必须查存在性）",
  ).toBe(false);
  // digest 稳定性：实时连接状态（tools/toolMeta）变化不影响目录 digest
  const connected = new Map([
    [
      "srv-a",
      {
        server: { description: "自定义描述 A" },
        tools: ["t1"],
        toolMeta: new Map([["x", { description: "实时描述" }]]),
      },
    ],
    [
      "srv-b",
      {
        server: { description: undefined },
        tools: ["t1"],
        toolMeta: new Map([["x", { description: "实时描述" }]]),
      },
    ],
    ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
  ]);
  expect(
    digestCatalogEntries(
      composeCatalogEntries(
        connected as unknown as Parameters<typeof composeCatalogEntries>[0],
        6,
        cache,
      ),
    ),
    "连接状态变化 digest 不变（不触发重复注入）",
  ).toBe(digestCatalogEntries(entries));
});
it("summarizeToolDescriptions 排序稳定与首句聚合", () => {
  const meta1 = new Map([
    ["mcp__s__b", { description: "工具 B 的说明文字" }],
    ["mcp__s__a", { description: "工具 A 的说明" }],
  ]);
  const meta2 = new Map([
    ["mcp__s__a", { description: "工具 A 的说明" }],
    ["mcp__s__b", { description: "工具 B 的说明文字" }],
    ["mcp__s__c", { description: "" }],
  ]);
  expect(summarizeToolDescriptions(meta1), "顺序变化摘要稳定").toBe(
    summarizeToolDescriptions(meta2),
  );
  expect(summarizeToolDescriptions(new Map([["x", { description: "  " }]])), "全空描述无摘要").toBe(
    undefined,
  );
  const long = summarizeToolDescriptions(new Map([["x", { description: "长".repeat(100) }]]));
  expect(long, "单句上限内完整返回不截断").toBe("长".repeat(100));
  // #569 防 crawler 回归：tavily 类多工具服务器摘要必须覆盖 search/research
  // 语义，不能被字典序第一条（tavily_crawl）误导成"爬虫服务器"。
  const tavily = new Map([
    ["tavily_search", { description: "Search the web for current information on any topic." }],
    ["tavily_crawl", { description: "Crawl a website starting from a URL." }],
    ["tavily_extract", { description: "Extract content from URLs." }],
    ["tavily_map", { description: "Map a website's structure." }],
    ["tavily_research", { description: "Perform comprehensive research on a given topic." }],
  ]);
  const tavilySummary = summarizeToolDescriptions(tavily)!;
  expect(
    tavilySummary.includes("Search the web"),
    "摘要含 search 语义（防 crawler 误导）",
  ).toBeTruthy();
  expect(tavilySummary.includes("research"), "摘要含 research 语义").toBeTruthy();
  expect(tavilySummary.startsWith("5 tools: "), "多工具前缀标注真实工具数").toBeTruthy();
});
it("recordCatalogTools 仅实质变化落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-catalog-"));
  const store = new McpStore(join(dir, "mcp.json"));
  const manager = new McpManager(fakeManagerCtx(), store);
  manager.catalogCachePath = join(dir, "catalog.json");
  await manager.loadCatalogCache();
  expect(manager.catalogCache.size, "空缓存加载").toBe(0);
  const meta = new Map([["mcp__s__a", { description: "唯一描述" }]]);
  await manager.recordCatalogTools("srv", meta);
  expect(manager.catalogCache.get("srv")?.summary).toBe("唯一描述");
  const onDisk = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
  expect(onDisk.entries.srv.summary, "缓存落盘").toBe("唯一描述");
  // 相同摘要再记录：不重复落盘（digest 不变）
  const mtime1 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
  await manager.recordCatalogTools("srv", meta);
  const mtime2 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
  expect(mtime1, "相同摘要不落盘").toBe(mtime2);
  // 摘要变化 → 落盘
  await manager.recordCatalogTools("srv", new Map([["mcp__s__a", { description: "新描述" }]]));
  expect(manager.catalogCache.get("srv")?.summary).toBe("新描述");
  // 重新加载（模拟重启）
  const manager2 = new McpManager(fakeManagerCtx(), store);
  manager2.catalogCachePath = join(dir, "catalog.json");
  await manager2.loadCatalogCache();
  expect(manager2.catalogCache.get("srv")?.summary, "重启后缓存恢复").toBe("新描述");
  rmSync(dir, { recursive: true, force: true });
});
it("composeCatalogEntries 条目上限", () => {
  const supervisors = new Map();
  for (let i = 0; i < 10; i += 1)
    supervisors.set(`s${i}`, { server: { description: "d" }, tools: [], toolMeta: new Map() });
  expect(
    composeCatalogEntries(supervisors as unknown as Parameters<typeof composeCatalogEntries>[0], 3)
      .length,
  ).toBe(3);
});
it("digestCatalogEntries 只含服务器集合（描述变化不触发注入）", () => {
  const a = [{ name: "x", text: "d1" }];
  const b = [{ name: "x", text: "d2" }];
  const c = [
    { name: "x", text: "d1" },
    { name: "y", text: "d1" },
  ];
  expect(digestCatalogEntries(a), "描述文本变化 digest 不变（不触发注入）").toBe(
    digestCatalogEntries(b),
  );
  expect(digestCatalogEntries(a), "服务器集合变化 digest 变（触发替换）").not.toBe(
    digestCatalogEntries(c),
  );
  // 顺序敏感（服务器顺序变化 = 集合变化）
  const reversed = [
    { name: "y", text: "d1" },
    { name: "x", text: "d1" },
  ];
  expect(digestCatalogEntries(c), "顺序变化 digest 变").not.toBe(digestCatalogEntries(reversed));
});
it("escapeCatalogText 转义（完整返回不截断）", () => {
  expect(escapeCatalogText("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  expect(escapeCatalogText("换行\n字符")).toBe("换行 字符");
  expect(escapeCatalogText("长".repeat(300)).length, "长文本完整返回不截断").toBe(300);
});
it("renderMcpCatalogMessage 结构与声明", () => {
  // 含 project 条目 → 引导经 ws_mcp_search/ws_mcp_call（#228 双轨迁移）
  const msg = renderMcpCatalogMessage([{ name: "code-graph", text: "代码图谱", scope: "project" }]);
  expect(msg.role).toBe("user");
  expect(msg.source).toEqual({
    kind: "plugin:@wingsky-1/dsh-mcp-manager",
    form: "snapshot",
    sections: [{ name: "mcp-catalog", text: msg.content![0]!.text }],
  });
  expect(Object.hasOwn(msg.source!, "plugin"), "V4 source 不携带旧 plugin 字段").toBe(false);
  expect(isCatalogSource(msg.source)).toBe(true);
  expect(msg.content![0]!.type).toBe("text");
  expect(msg.content![0]!.text).toMatch(/available_mcp_servers/);
  expect(msg.content![0]!.text).toMatch(/Available MCP servers \(capability snapshot\):/);
  expect(msg.content![0]!.text, "#228 目录文案引导经中间层调用").toMatch(/ws_mcp_search/);
  expect(msg.content![0]!.text).toMatch(/`code-graph`: 代码图谱/);
  expect(typeof msg.id === "string" && msg.id.length > 0).toBeTruthy();

  // 纯 global 条目 → 同样引导经中间层（#767 笔 2：`mcp__*` 已不在模型可见面，
  // 原来「全局一律直呼」的那条 mode 分支是笔 1b 之后已假的事实，随 `mode` 删除）。
  const onlyGlobal = renderMcpCatalogMessage([{ name: "ctx", scope: "global" }]);
  expect(onlyGlobal.content![0]!.text, "纯 global 引导经中间层检索").toMatch(/ws_mcp_search/);
  expect(onlyGlobal.content![0]!.text, "纯 global 用 ws_mcp_call 触达").toMatch(/ws_mcp_call/);
  expect(onlyGlobal.content![0]!.text, "不再给出 mcp__ 直呼引导").not.toMatch(/mcp__<id>__<tool>/);

  // #192 AC-3：双缺省行仅渲染名字（无冒号描述），带描述条目渲染不变
  const mixed = renderMcpCatalogMessage([
    { name: "bare-x" },
    { name: "code-graph", text: "代码图谱" },
  ]);
  expect(mixed.content![0]!.text, "双缺省行仅名字").toMatch(/^- `bare-x`$/m);
  expect(mixed.content![0]!.text).not.toMatch(/`bare-x`: /);
  expect(mixed.content![0]!.text, "带描述行保持").toMatch(/^- `code-graph`: 代码图谱$/m);
});
it("findCatalogMessage 定位既有目录", () => {
  const catalog = renderMcpCatalogMessage([{ name: "a", text: "b" }]);
  const messages = [
    { id: "m1", role: "user", content: [] },
    catalog,
    { id: "m2", role: "assistant", content: [] },
  ];
  expect(findCatalogMessage(messages)?.id).toBe(catalog.id);
  expect(
    findCatalogMessage([{ id: "x", role: "user", content: [], source: { kind: "other" } }]),
  ).toBe(undefined);
});

// ---------- pre-step 目录注入（history-based 去重，复刻官方 tool-skill 语义）

// 模拟 agent：session.snapshotEvents() 持久化 + surface 可见性（与真实 agent 同构；
// 0.1.2-rc.1 起 events getter 移除，fake 暴露方法形态）
function makeAgent(): NonNullable<Parameters<typeof resolveCatalogInjection>[5]> {
  const events: { type: string; data: unknown; seq: number }[] = [];
  const session = {
    header: { cwd: "/tmp" },
    surface: { nodes: new Set<number>() },
    snapshotEvents: () => events,
    append(type: string, data: unknown) {
      const seq = events.length;
      const event = { type, data, seq };
      events.push(event);
      if (type === "user/message") session.surface.nodes.add(seq);
      return event;
    },
  };
  return { session } as unknown as NonNullable<Parameters<typeof resolveCatalogInjection>[5]>;
}

// 模拟一轮 pre-step：调用决策并把新增目录消息持久化进 events（agent-loop 行为）
function runStep(
  decision: Parameters<typeof resolveCatalogInjection>[0],
  messages: Parameters<typeof resolveCatalogInjection>[1],
  supervisors: Parameters<typeof resolveCatalogInjection>[2],
  cache: Parameters<typeof resolveCatalogInjection>[4],
  agent: Parameters<typeof resolveCatalogInjection>[5],
) {
  const result = resolveCatalogInjection(decision, messages, supervisors, 6, cache, agent);
  const known = new Set<unknown>();
  for (const evt of agent!.session!.snapshotEvents!()) {
    if (evt.type === "user/message" && isCatalogSource(evt.data?.source))
      known.add((evt.data as unknown as { id: unknown }).id);
  }
  for (const msg of result.messages) {
    if (isCatalogSource(msg.source) && !known.has(msg.id))
      (agent!.session as unknown as { append: (type: string, data: unknown) => unknown }).append(
        "user/message",
        msg,
      );
  }
  return result;
}

it("resolveCatalogInjection：history-based 去重（核心：多轮不重复注入）", () => {
  const supervisors = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();

  // 真实语义：decision.messages 只含本轮新消息（历史在 session.snapshotEvents()）
  let historyCount = 0;
  for (let round = 1; round <= 5; round += 1) {
    const decision = {
      kind: "enter",
      messages: [{ id: `user-${round}`, role: "user", content: [] }],
    };
    const result = runStep(decision, decision.messages, supervisors, undefined, agent);
    historyCount = agent.session!.snapshotEvents!().filter(
      (e) => e.type === "user/message" && isCatalogSource(e.data?.source),
    ).length;
    const inMessages = result.messages.filter((m) => isCatalogSource(m.source)).length;
    if (round === 1) {
      expect(historyCount, "首轮注入 1 条").toBe(1);
      expect(inMessages, "首轮消息列表含目录").toBe(1);
    } else {
      expect(historyCount, `第 ${round} 轮历史目录消息恒为 1（不累积）`).toBe(1);
      expect(inMessages, `第 ${round} 轮不注入新消息`).toBe(0);
    }
  }
  expect(historyCount, "5 轮后目录消息仍只有 1 条（根治重复注入）").toBe(1);
});

it("resolveCatalogInjection：描述/缓存变化不注入、集合变化注入更新消息", () => {
  const base = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();
  let messages: Parameters<typeof resolveCatalogInjection>[1] = [
    { id: "m1", role: "user", content: [] },
  ];

  // 首次注入
  let result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    base,
    undefined,
    agent,
  );
  messages = result.messages;
  const firstId = (
    agent.session!.snapshotEvents!().find((e) => isCatalogSource(e.data?.source))!
      .data as unknown as { id: unknown }
  ).id;
  expect(firstId, "首次注入").toBeTruthy();

  // 描述变化（集合不变）→ 不注入
  const descChanged = new Map([
    ["code-graph", { server: { description: "新描述" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  result = runStep(
    { kind: "enter", messages: [...messages, { id: "u2", role: "user", content: [] }] },
    messages,
    descChanged,
    undefined,
    agent,
  );
  expect(
    agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source)).length,
    "描述变化不注入",
  ).toBe(1);

  // 集合变化（新增服务器）→ 注入"更新"消息（历史 1 + 更新 1，声明作废旧目录）
  const added = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
    ["playwright", { server: { description: "浏览器自动化" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  result = runStep(
    { kind: "enter", messages: [...messages, { id: "u3", role: "user", content: [] }] },
    messages,
    added,
    undefined,
    agent,
  );
  const afterAdd = agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source));
  expect(afterAdd.length, "集合变化注入更新消息（历史目录无法删除，新消息声明作废）").toBe(2);
  const afterAddContent = (afterAdd[1]!.data as unknown as { content: { text: string }[] }).content;
  expect(afterAddContent[0]!.text).toMatch(/replaces all previous available_mcp_servers/);
  expect(afterAddContent[0]!.text).toMatch(/playwright/);

  // 更新后同集合不再注入
  result = runStep(
    { kind: "enter", messages: [...messages, { id: "u4", role: "user", content: [] }] },
    messages,
    added,
    undefined,
    agent,
  );
  expect(
    agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source)).length,
    "更新后不再注入",
  ).toBe(2);
});

it("resolveCatalogInjection：compaction 后重建 + 门控 + reject", () => {
  const supervisors = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();
  let messages: Parameters<typeof resolveCatalogInjection>[1] = [
    { id: "m1", role: "user", content: [] },
  ];
  let result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  messages = result.messages;
  expect(
    agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source)).length,
    "首次注入",
  ).toBe(1);

  // compaction 模拟：surface 清空（旧目录不可见）→ 重新注入
  (agent.session as unknown as { surface: { nodes: Set<number> } }).surface.nodes.clear();
  result = runStep(
    { kind: "enter", messages: [{ id: "m1", role: "user", content: [] }] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  const afterCompact = agent.session!.snapshotEvents!().filter((e) =>
    isCatalogSource(e.data?.source),
  );
  expect(afterCompact.length >= 1, "compaction 后按可见性重建").toBeTruthy();
  expect(result.messages.filter((m) => isCatalogSource(m.source)).length).toBe(1);

  // 门控：从未发布且无服务器 → 不注入
  const agent2 = makeAgent();
  const decisionEmpty = resolveCatalogInjection(
    { kind: "enter", messages: [{ id: "x", role: "user", content: [] }] },
    [],
    new Map(),
    6,
    undefined,
    agent2,
  );
  expect(decisionEmpty.messages.length, "无服务器不注入").toBe(1);

  // reject 不处理
  const rejected = resolveCatalogInjection(
    { kind: "reject", messages: [] } as unknown as Parameters<typeof resolveCatalogInjection>[0],
    [],
    supervisors,
    6,
    undefined,
    agent2,
  );
  expect(rejected.kind).toBe("reject");
});

// ---------- issue #192：双缺省条目不得产出 text: undefined ----------

it("composeCatalogEntries 双缺省条目干净可序列化（#192 AC-1/AC-2）", () => {
  const supervisors = new Map([
    ["bare-a", { server: { description: "" }, tools: [], toolMeta: new Map() }],
    ["bare-b", { server: {}, tools: [], toolMeta: new Map() }],
    ["with-desc", { server: { description: "有描述" }, tools: [], toolMeta: new Map() }],
  ]);
  const entries = composeCatalogEntries(
    supervisors as unknown as Parameters<typeof composeCatalogEntries>[0],
    6,
    undefined,
  );
  expect(entries.length, "双缺省服务器按名称保留不丢弃").toBe(3);
  expect(entries.map((e) => e.name)).toEqual(["bare-a", "bare-b", "with-desc"]);
  for (const bare of [entries[0], entries[1]]) {
    expect(Object.hasOwn(bare, "text"), `双缺省条目 ${bare.name} 不含 text 属性`).toBe(false);
  }
  expect(entries[2].text).toBe("有描述");

  // AC-2：两条渲染路径的完整消息 JSON 往返后深度相等（载荷无 undefined 属性）
  for (const rendered of [renderMcpCatalogMessage(entries), renderMcpCatalogUpdate(entries)]) {
    expect(() => JSON.stringify(rendered)).not.toThrow();
    expect(JSON.parse(JSON.stringify(rendered)), "完整消息 JSON 往返深度相等").toEqual(rendered);
    // #723：source 改为宿主通用形态（plugin + snapshot sections），条目正文全在段文本里，
    // 故「双缺省条目不产出 text: undefined」的约束落在正文渲染上。
    const sections = (rendered.source as unknown as { sections: { text: string }[] }).sections;
    expect(Array.isArray(sections) && sections.length, "snapshot 只有一个目录段").toBe(1);
    for (const name of ["bare-a", "bare-b", "with-desc"]) {
      expect(sections[0].text.includes(`- \`${name}\``), `正文含条目 ${name}`).toBeTruthy();
    }
    expect(
      sections[0].text.includes("- `bare-a`\n"),
      "双缺省条目只渲染服务器名（不产出 text: undefined）",
    ).toBeTruthy();
  }
});

it("双缺省服务器目录消息可 append 为 user/message 且去重（#192 AC-4）", () => {
  const supervisors = new Map([
    ["bare-only", { server: { description: "" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();
  let messages: Parameters<typeof resolveCatalogInjection>[1] = [
    { id: "m1", role: "user", content: [] },
  ];
  let result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  messages = result.messages;
  const catalogEvents = agent.session!.snapshotEvents!().filter(
    (e) => e.type === "user/message" && isCatalogSource(e.data?.source),
  );
  expect(catalogEvents.length, "首轮注入成功（append 为 user/message 未被拒绝）").toBe(1);
  const appended = catalogEvents[0]!.data as unknown as {
    source: { kind: unknown; form: unknown; sections: { text: string }[] };
  };
  expect(appended.source.kind).toBe("plugin:@wingsky-1/dsh-mcp-manager");
  expect(appended.source.form).toBe("snapshot");
  expect(Object.hasOwn(appended.source, "plugin"), "V4 source 不携带旧 plugin 字段").toBe(false);
  expect(
    appended.source.sections[0].text.includes("- `bare-only`"),
    "正文含双缺省服务器名",
  ).toBeTruthy();
  expect(
    () => JSON.stringify(appended),
    "事件载荷可 JSON 序列化（dsh-session 序列化校验等价物）",
  ).not.toThrow();
  expect(JSON.parse(JSON.stringify(appended)), "往返深度相等").toEqual(appended);

  // digest 去重语义不变：同集合再次 pre-step 不重复注入
  result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  expect(
    agent.session!.snapshotEvents!().filter(
      (e) => e.type === "user/message" && isCatalogSource(e.data?.source),
    ).length,
    "次轮不重复注入（digest 去重不变）",
  ).toBe(1);
});

// ---- 核心化 service（#329 阶段1）：runtimeRegistry / registerServer / unregisterServer ----
// 用 enabled:false 的服务器（不连接、不 spawn 子进程，避免重连悬挂）验证登记语义。

describe("核心化 service（#329 阶段1）：runtimeRegistry / registerServer / unregisterServer", () => {
  let dir: string;
  let store: McpStore;
  let manager: McpManager;
  const quiet = () => ({
    transport: "stdio" as const,
    command: "echo",
    args: ["ok"],
    enabled: false,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-service-"));
    store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    manager = new McpManager(fakeManagerCtx(), store);
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registerServer 新注册 → existing:false 且条目进 runtimeRegistry（不落盘）", async () => {
    const r1 = await manager.registerServer({ name: "svc-a", ...quiet() });
    expect(r1.existing).toBe(false);
    expect(manager.runtimeRegistry.has("svc-a"), "runtime 条目已登记").toBeTruthy();
    expect(!store.find("svc-a"), "不落盘（store 无条目）").toBeTruthy();
  });

  it("同名再注册幂等 → existing:true 不抛错", async () => {
    const r2 = await manager.registerServer({ name: "svc-a", ...quiet() });
    expect(r2.existing, "同名幂等返回 existing").toBe(true);
  });

  it("与 store 同名冲突 → existing:true（不覆盖持久化条目）", async () => {
    store.upsert(normalizeServer({ name: "svc-store", ...quiet() }));
    const r3 = await manager.registerServer({ name: "svc-store", ...quiet() });
    expect(r3.existing, "store 同名返回 existing").toBe(true);
  });

  it("双轨合并：reconcile 后 runtime + store 条目都在 registry（不 spawn）", () => {
    manager.reconcileServers();
    expect(manager.runtimeRegistry.has("svc-a"), "runtime 条目在 registry").toBeTruthy();
    expect(store.find("svc-store") !== undefined, "store 条目保留").toBeTruthy();
  });

  it("unregisterServer 移除 runtime 条目；store 条目不受影响", async () => {
    await manager.unregisterServer("svc-a");
    expect(!manager.runtimeRegistry.has("svc-a"), "runtime 条目已移除").toBeTruthy();
    expect(store.find("svc-store") !== undefined, "store 条目保留").toBeTruthy();
  });

  it("dispose() 拆空全部池单元（含 runtime）", async () => {
    await manager.registerServer({ name: "svc-b", ...quiet() });
    expect(manager.runtimeRegistry.has("svc-b")).toBeTruthy();
    await manager.dispose();
    expect(manager.middleware, "dispose 后中间层实例已释放").toBe(undefined);
  });

  it("reconcile 不杀 runtime 条目（QA 复审回归）", async () => {
    await manager.registerServer({
      name: "svc-all",
      transport: "stdio",
      command: "echo",
      args: ["x"],
      enabled: false,
    });
    manager.reconcileServers();
    expect(manager.runtimeRegistry.has("svc-all"), "runtime 条目保留").toBeTruthy();
  });

  it("#767 笔 2：summary 不再回显 middlewareMode", () => {
    expect("middlewareMode" in manager.summary(), "/servers 的 summary 已无模式字段").toBe(false);
  });

  it("summary 并入 runtime 条目（查询面可见 / disabled 工具列表为空）", async () => {
    await manager.registerServer({ name: "svc-q", ...quiet() });
    const sum = manager.summary() as unknown as {
      servers: { name: string; scope: string; status: string; tools: unknown[] }[];
    };
    const qEntry = sum.servers.find((s: { name: string }) => s.name === "svc-q");
    expect(qEntry !== undefined, "summary 含 runtime 条目（查询面可见）").toBeTruthy();
    expect(qEntry!.scope, "runtime 条目 scope 为 global").toBe("global");
    expect(qEntry!.status, "enabled:false → disabled 状态").toBe("disabled");
    expect(qEntry!.tools, "disabled 服务器工具列表为空").toEqual([]);
  });
});
