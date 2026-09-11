// @ts-nocheck
// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 无外部依赖、不发起真实网络连接。
//
// 覆盖：
//   - 契约导出（name / inject / ROUTES）
//   - normalizeServer 校验（名称模式、传输必填、http url 合法性）
//   - fromClaudeEntry / parseClaudeJson（mcpServers JSON 兼容映射）
//   - publicToolName 确定性、expandEnv、parseSsePayload
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
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertClientProductContract, assertClientSourceContract } from "../../../../test/smoke-lib.ts";
import { pollUntil } from "../helpers.ts";
const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
import {
  apply,
  broadcastFrame,
  buildConfigUiPatch,
  buildToolDefinition,
  composeCatalogEntries,
  Config,
  ConnectionSupervisor,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_UI_CONFIG,
  digestCatalogEntries,
  escapeCatalogText,
  findCatalogMessage,
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
  parseSsePayload,
  publicToolName,
  renderMcpCatalogMessage,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
  ROUTES,
  SCOPE_GLOBAL,
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
  truncateText,
  uiConfigChangedFrame,
  assertSupportedOutputSchema,
} from "../../lib/index.js";

// 服务契约门禁（#476）与结构化单元/集成测试由 vitest 的 unit / integration project 收集；
// 本文件（e2e project）不再以包内 glob 聚合方式执行，避免同一文件被求值两遍。

function fakeCtx(overrides = {}) {
  const state = { routes: [], sections: [], effects: [], registeredTools: [], listeners: new Map() };
  const ctx = {
    ...state,
    tools: {
      register: (definition) => {
        state.registeredTools.push(definition);
        return () => {};
      },
    },
    webServer: {
      register: (route) => {
        state.routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section) => {
        state.sections.push(section);
        return () => {};
      },
    },
    on: (event, handler) => {
      if (!state.listeners.has(event)) state.listeners.set(event, []);
      state.listeners.get(event).push(handler);
      return () => {};
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn, label) => {
      state.effects.push(label);
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    ...overrides,
  };
  return ctx;
}

/** 伪造 node:http res。 */
function fakeRes() {
  const state = { status: 0, headers: {}, body: "" };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      Object.assign(state.headers, headers);
    },
    end(body) {
      state.body = body;
    },
  };
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
  expect(clientPaths, `两端路由漂移：client=${clientPaths.join(",")} host=${hostPaths.join(",")}`).toEqual(hostPaths);
});
it("client source contract（load id/IIFE/use strict/load once）", () => assertClientSourceContract(pkgDir));
it("client product contract（执行断言：arrive 可解析/apply/inject）", () => assertClientProductContract(pkgDir));
it("中间层工具注册（ws_mcp_search / ws_mcp_call / ws_mcp_list / ws_mcp_detail + 路由一致性）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, parseFullServerName } = await import("../../lib/index.js");
  const registered = [];
  const ctx = { tools: { register: (def) => { registered.push(def); return () => {}; } } };
  const host = {
    ctx,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async () => [],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
  };
  const mw = new McpMiddleware(host, {});
  const dispose = registerMiddlewareTools(ctx, mw, async (agent) => {
    const cwd = agent?.session?.header?.cwd;
    return cwd === "/proj" ? "/proj" : undefined;
  });
  const names = registered.map((def) => def.name).sort();
  expect(names, "四个中间层工具注册").toEqual(["ws_mcp_call", "ws_mcp_detail", "ws_mcp_list", "ws_mcp_search"]);
  expect(registered.find((d) => d.name === "ws_mcp_search").description, "search 描述引导先搜后调").toMatch(/ws_mcp_call/);
  expect(registered.find((d) => d.name === "ws_mcp_search").description, "search 描述互引完整盘点").toMatch(/ws_mcp_list/);
  expect(registered.find((d) => d.name === "ws_mcp_call").description, "call 描述互引参数 schema 查询").toMatch(/ws_mcp_detail/);
  expect(registered.find((d) => d.name === "ws_mcp_list").description, "list 描述互引 detail").toMatch(/ws_mcp_detail/);
  expect(registered.find((d) => d.name === "ws_mcp_list").description, "list 描述写明不做什么").toMatch(/Does not return inputSchema/);
  expect(registered.find((d) => d.name === "ws_mcp_detail").description, "detail 描述说明完整 schema").toMatch(/inputSchema/);
  expect(registered.find((d) => d.name === "ws_mcp_detail").description, "detail 描述写明不做什么").toMatch(/Does not perform keyword search/);
  // Anthropic 规范：parameters 每个字段都带 description。
  for (const def of registered) {
    const props = def.parameters?.properties ?? {};
    for (const [key, prop] of Object.entries(props)) {
      expect(typeof prop.description === "string" && prop.description !== "", `参数 ${def.name}.${key} 带 description`).toBeTruthy();
    }
  }
  // search 输出 schema 含 truncated 字段。
  const searchSchemaProps = registered.find((d) => d.name === "ws_mcp_search").output.schema.properties;
  expect(typeof searchSchemaProps.truncated, "search 输出含 truncated 字段").toBe("object");
  // 路由：agent-less → 显式失败
  const searchDef = registered.find((d) => d.name === "ws_mcp_search");
  const callDef = registered.find((d) => d.name === "ws_mcp_call");
  const listDef = registered.find((d) => d.name === "ws_mcp_list");
  const detailDef = registered.find((d) => d.name === "ws_mcp_detail");
  // search 输出补 truncated 字段：空目录 → false。
  const emptySearch = await searchDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } });
  expect(emptySearch.truncated, "空目录 truncated=false").toBe(false);
  expect(emptySearch.unavailable).toEqual([]);
  await expect(() => searchDef.execute({}, { agent: undefined })).rejects.toThrow(/无法确定工作空间/);
  await expect(() => listDef.execute({}, { agent: undefined })).rejects.toThrow(/无法确定工作空间/);
  await expect(() => detailDef.execute({}, { agent: undefined })).rejects.toThrow(/无法确定工作空间/);
  // 路由：有 agent 但 cwd 无项目 → 显式失败（ws_mcp_call 缺 server 参数先报必填）
  await expect(() => callDef.execute({}, { agent: { session: { header: { cwd: "/other" } } } })).rejects.toThrow(/无法确定工作空间|server 与 tool 均为必填/);
  // 空返回提示：无项目配置 → list 返回 message
  const emptyList = await listDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } });
  expect(emptyList.totalServers).toBe(0);
  expect(emptyList.totalTools).toBe(0);
  expect(emptyList.message, "空返回明确提示").toMatch(/没有可用 MCP 服务器|没有项目级 MCP 配置/);
  // detail 必填校验
  await expect(() => detailDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } })).rejects.toThrow(/server 与 tool 均为必填/);
  // server 全名解析往返
  const full = fullServerName("/proj", "ctx");
  expect(parseFullServerName(full)).toEqual({ root: "/proj", server: "ctx" });
  // @global 单 @ / 双 @ 等价（隔离验证 P0：smoke 双 @ 掩盖单 @ 被拒）
  const { MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  expect(parseFullServerName("@global/gctx"), "单 @ @global/ 归一化为 @global").toEqual({ root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" });
  expect(parseFullServerName("@@global/gctx"), "双 @ @@global/ 归一化为 @global").toEqual({ root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" });
  expect(parseFullServerName(fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "fullServerName(@global) 往返一致").toEqual({ root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" });
  dispose();
});
it("search 早退分支（unit undefined）返回 truncated=false（P1-1）", async () => {
  const { registerMiddlewareTools, McpMiddleware } = await import("../../lib/index.js");
  const registered = [];
  const ctx = { tools: { register: (def) => { registered.push(def); return () => {}; } } };
  const host = {
    ctx,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async () => undefined, // 无项目标记 → projectUnitFor 返回 undefined
    globalServers: () => [],
    normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
  };
  const mw = new McpMiddleware(host, {});
  const dispose = registerMiddlewareTools(ctx, mw, async (agent) => {
    const cwd = agent?.session?.header?.cwd;
    return cwd === "/proj" ? "/proj" : undefined;
  });
  const searchDef = registered.find((d) => d.name === "ws_mcp_search");
  const out = await searchDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } });
  expect(out, "早退分支补 truncated=false（output.schema required）").toEqual({ results: [], unavailable: [], truncated: false });
  dispose();
});
it("中间层 all 模式：@global 覆盖（list/search 可见全局，call 放行 @global）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const registered = [];
  const ctx = { tools: { register: (def) => { registered.push(def); return () => {}; } } };
  const host = {
    ctx,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async (root) => {
      if (root === MIDDLEWARE_GLOBAL_ROOT) return [{ name: "gctx", transport: "stdio", command: "npx", enabled: true }];
      return [{ name: "ctx", transport: "stdio", command: "npx", enabled: true }];
    },
    globalServers: () => [{ name: "gctx", transport: "stdio", command: "npx", enabled: true }],
    normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
  };
  const mw = new McpMiddleware(host, {});
  // 预置目录（模拟 last-good 已发现；不 spawn 子进程）。
  const projUnit = {
    root: "/proj",
    connections: new Map(),
    catalog: new Map([["ctx", {
      discoveredAt: Date.now(),
      tools: new Map([["use_ctx", { description: "项目工具", inputSchema: {} }]]),
    }]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  const globalUnit = {
    root: MIDDLEWARE_GLOBAL_ROOT,
    connections: new Map(),
    catalog: new Map([["gctx", {
      discoveredAt: Date.now(),
      tools: new Map([["use_g", { description: "全局工具", inputSchema: {} }]]),
    }]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  mw.units.set("/proj", projUnit);
  mw.units.set(MIDDLEWARE_GLOBAL_ROOT, globalUnit);
  const dispose = registerMiddlewareTools(ctx, mw, async (agent) => {
    const cwd = agent?.session?.header?.cwd;
    // 模拟 apply.ts 的 all 模式 fallback：cwd 无项目 → @global（全局服务器存在时）。
    if (cwd === "/no-project") return MIDDLEWARE_GLOBAL_ROOT;
    return cwd === "/proj" ? "/proj" : undefined;
  }, "all");
  const names = registered.map((def) => def.name).sort();
  expect(names, "all 模式注册四个工具").toEqual(["ws_mcp_call", "ws_mcp_detail", "ws_mcp_list", "ws_mcp_search"]);
  const searchDef = registered.find((d) => d.name === "ws_mcp_search");
  const callDef = registered.find((d) => d.name === "ws_mcp_call");
  const listDef = registered.find((d) => d.name === "ws_mcp_list");
  const detailDef = registered.find((d) => d.name === "ws_mcp_detail");
  const agent = { session: { header: { cwd: "/proj" } } };
  // list：项目 root + @global 合并可见
  const listed = await listDef.execute({}, { agent });
  expect(listed.servers.some((s) => s.server === fullServerName("/proj", "ctx")), "list 含项目服务器").toBeTruthy();
  expect(listed.servers.some((s) => s.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "all 模式 list 含 @global 服务器").toBeTruthy();
  expect(listed.mode).toBe("all");
  // search：合并查询命中 @global 工具
  const found = await searchDef.execute({ query: "全局" }, { agent });
  expect(found.results.some((hit) => hit.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "all 模式 search 含 @global 命中").toBeTruthy();
  expect(found.truncated, "all 模式 search 未达 limit → truncated=false").toBe(false);
  // detail：@global 可查
  const detail = await detailDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent });
  expect(detail.server).toBe(fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"));
  expect(detail.tool).toBe("use_g");
  // call：all 模式放行 @global root（预置 client 无法调用——此处断言路由放行后
  // 落到连接/调用错误而非「不属于当前工作空间」路由拒绝）。
  await expect(
    () => callDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent }),
  ).rejects.toThrow(/未连接|未就绪|连接失败|已禁用/);
  // call：非当前 root 的项目 root 仍拒绝（防跨空间串台）。
  await expect(
    () => callDef.execute({ server: fullServerName("/other", "ctx"), tool: "use_ctx" }, { agent }),
  ).rejects.toThrow(/不属于当前工作空间/);
  // P1-2：all 模式无项目 cwd（root 本身为 @global）→ visibleRoots 去重不翻倍。
  const gAgent = { session: { header: { cwd: "/no-project" } } };
  const listedGlobalOnly = await listDef.execute({}, { agent: gAgent });
  const globalNames = listedGlobalOnly.servers.map((s) => s.server);
  expect(listedGlobalOnly.totalServers, "@global 去重：totalServers 不翻倍").toBe(1);
  expect(globalNames.filter((n) => n === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")).length, "gctx 只出现一次").toBe(1);
  // P1-3：@global 单元首次触达（无预置目录 + in-flight 发现进行中）→
  // list/search 等待 in-flight 后全局可见（8s 预算内）。
  const freshGlobal = {
    root: MIDDLEWARE_GLOBAL_ROOT,
    connections: new Map(),
    catalog: new Map(),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map([["gctx", new Promise((resolve) => setTimeout(() => {
      // 发现完成后填充目录（模拟 ensureConnected/discover 完成）。
      freshGlobal.catalog.set("gctx", {
        discoveredAt: Date.now(),
        tools: new Map([["use_g", { description: "全局工具（发现完成）", inputSchema: {} }]]),
      });
      resolve();
    }, 100))]]),
  };
  mw.units.set(MIDDLEWARE_GLOBAL_ROOT, freshGlobal);
  const listedAfterWait = await listDef.execute({}, { agent: gAgent });
  const freshEntry = listedAfterWait.servers.find((s) => s.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"));
  expect(freshEntry !== undefined, "@global 首次触达等待 in-flight 后可见").toBeTruthy();
  expect(freshEntry.tools.length, "发现完成的工具列出").toBe(1);
  const foundAfterWait = await searchDef.execute({ query: "发现完成" }, { agent: gAgent });
  expect(foundAfterWait.results.some((hit) => hit.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "search 等待 in-flight 后命中 @global").toBeTruthy();
  dispose();
});
it("#362 A2：project 模式 detail/call 传全局级服务器 → 引导 mcp__ 直呼（不再谎报不属于工作空间）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const registered = [];
  const ctx = { tools: { register: (def) => { registered.push(def); return () => {}; } } };
  const host = {
    ctx,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async (root) => (root === MIDDLEWARE_GLOBAL_ROOT ? [{ name: "gctx", transport: "stdio", command: "npx", enabled: true }] : undefined),
    globalServers: () => [{ name: "gctx", transport: "stdio", command: "npx", enabled: true }],
    normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: (name) => name === "gctx",
  };
  const mw = new McpMiddleware(host, {});
  const dispose = registerMiddlewareTools(ctx, mw, async (agent) => agent?.session?.header?.cwd === "/proj" ? "/proj" : undefined, "project");
  const detailDef = registered.find((d) => d.name === "ws_mcp_detail");
  const callDef = registered.find((d) => d.name === "ws_mcp_call");
  const agent = { session: { header: { cwd: "/proj" } } };
  // detail 全局服务器 → 引导（project 模式全局 mcp__ 直呼可用）。
  await expect(
    () => detailDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent }),
    "project 模式 detail 全局服务器给出直呼引导",
  ).rejects.toThrow(/全局级|mcp__gctx__/);
  // call 全局服务器 → 同样引导。
  await expect(
    () => callDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent }),
    "project 模式 call 全局服务器给出直呼引导",
  ).rejects.toThrow(/全局级|mcp__gctx__/);
  // 非 global 其他 root 仍硬拒绝（防跨空间串台，不回归）。
  await expect(
    () => detailDef.execute({ server: fullServerName("/other", "ctx"), tool: "use_ctx" }, { agent }),
  ).rejects.toThrow(/不属于当前工作空间/);
  // project 模式未知 @global 服务器（非全局级）→ 硬拒绝（防经 @global 路由绕过）。
  await expect(
    () => detailDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "ghost"), tool: "x" }, { agent }),
    "project 模式未知 @global 服务器拒绝",
  ).rejects.toThrow(/不属于当前工作空间/);
  dispose();
});
it("#362 isGlobalServer 双源：runtime 注册的 codegraph 判全局（P1 修正）", async () => {
  const { McpManager, McpStore, MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-global-"));
  try {
    const store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
    // runtime 注册（不落 store）→ isGlobalServer 必须返回 true。
    await manager.registerServer({ name: "codegraph", transport: "stdio", command: "echo", args: ["x"], enabled: false });
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
  const { registerMiddlewareTools, McpMiddleware, fullServerName, parseFullServerName } = await import("../../lib/index.js");
  const registered = [];
  const ctx = { tools: { register: (def) => { registered.push(def); return () => {}; } } };
  const host = {
    ctx,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async () => [{ name: "ctx", transport: "stdio", command: "npx", enabled: true }],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
  };
  const mw = new McpMiddleware(host, {});
  // 预置目录（模拟 last-good 已发现；不 spawn 子进程）。
  mw.units.set("/proj", {
    root: "/proj",
    connections: new Map(),
    catalog: new Map([["ctx", { discoveredAt: Date.now(), tools: new Map([["use_ctx", { description: "项目工具", inputSchema: {} }]]) }]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  });
  const dispose = registerMiddlewareTools(ctx, mw, async (agent) => agent?.session?.header?.cwd === "/proj" ? "/proj" : undefined, "project");
  const listDef = registered.find((d) => d.name === "ws_mcp_list");
  const agent = { session: { header: { cwd: "/proj" } } };
  // 过滤不存在的 server → 0 命中 + 可归因 message。
  const out = await listDef.execute({ server: "nope" }, { agent });
  expect(out.totalServers).toBe(0);
  expect(out.message, "A1：message 归因到过滤条件").toMatch(/没有匹配 server="nope" 的项目级服务器/);
  expect(out.message, "A1：列出可见项目级服务器").toMatch(/可见项目级服务器：ctx/);
  expect(out.message, "A1：提示全局级不列出").toMatch(/全局级服务器不在此列出/);
  // 不带过滤的真实空目录 → 原有空返回提示（不回归）。
  const out2 = await listDef.execute({}, { agent });
  expect(out2.totalServers, "不带过滤正常列出").toBe(1);
  dispose();
});
it("#362 P0-1：工具级禁用三入口一致（callTool / pre-execute guard / mcp__ 直呼）", async () => {
  const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT, parseDisabledTools, isToolDenied, toolDisabledReason } = await import("../../lib/index.js");
  // 1) isToolDenied 纯函数：项目 root 命中 + @global 回落 + 哈希超长名不误禁。
  const map = parseDisabledTools({ "/proj": { ctx: ["use_ctx"] }, "@global": { gctx: ["use_g"] } });
  expect(isToolDenied(map, undefined, fullServerName("/proj", "ctx"), "use_ctx"), "项目 root 记录命中").toBe(true);
  expect(isToolDenied(map, undefined, fullServerName("/proj", "ctx"), "other"), "未禁用工具放行").toBe(false);
  expect(isToolDenied(map, undefined, fullServerName("/proj", "gctx"), "use_g"), "@global 共享记录回落命中").toBe(true);
  expect(isToolDenied(map, undefined, fullServerName("@global", "gctx"), "use_g"), "@global root 自身记录命中").toBe(true);
  expect(isToolDenied(map, undefined, "mcp__ctx__use_ctx_hash123456", "x"), "哈希超长名不可逆 → 不误禁").toBe(false);
  expect(isToolDenied(new Map(), { denyTools: { ctx: ["evil"] } }, fullServerName("/proj", "ctx"), "evil"), "策略 deny 仍生效").toBe(true);
  // 2) registerMiddlewareTools 的 pre-execute guard：mcp__ 直呼被 deny。
  const registered = [];
  const ctx = { tools: { register: (def) => { registered.push(def); return () => {}; } }, on: (event, handler) => { guards.set(event, handler); return () => {}; } };
  const guards = new Map();
  const host = {
    ctx,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async () => [],
    globalServers: () => [],
    normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
    saveUserState: async () => {},
    emitStatus: () => {},
    catalogCachePath: () => "/tmp/cache.json",
    isGlobalServer: () => false,
  };
  const mw = new McpMiddleware(host, {});
  const dispose = registerMiddlewareTools(ctx, mw, async (agent) => agent?.session?.header?.cwd === "/proj" ? "/proj" : undefined, "project", { disabledTools: map });
  const guard = guards.get("tools/pre-execute");
  expect(typeof guard === "function", "pre-execute guard 已注册").toBeTruthy();
  const deny = await guard({ name: "mcp__ctx__use_ctx", agent: { session: { header: { cwd: "/proj" } } } }, async () => ({ kind: "allow" }));
  expect(deny.kind, "mcp__ 直呼被禁用表 deny").toBe("deny");
  expect(deny.reason, "拒绝原因含禁用语义声明").toMatch(/已被用户在「MCP」浮窗禁用/);
  const allow = await guard({ name: "mcp__ctx__other", agent: { session: { header: { cwd: "/proj" } } } }, async () => ({ kind: "allow" }));
  expect(allow.kind, "未禁用工具放行").toBe("allow");
  // agent-less → 按最宽可见范围放行（@global 记录仍生效）。
  const gDeny = await guard({ name: "mcp__gctx__use_g" }, async () => ({ kind: "allow" }));
  expect(gDeny.kind, "agent-less 时 @global 共享记录仍 deny").toBe("deny");
  // 超长哈希名（含非法字符被替换）→ 不误禁。
  const hashed = await guard({ name: "mcp__ctx__use_ctx_0123456789ab" }, async () => ({ kind: "allow" }));
  expect(hashed.kind, "哈希后缀名按未知 server 放行").toBe("allow");
  // ws_mcp_call guard：禁用命中 → deny。
  const callDeny = await guard({ name: "ws_mcp_call", arguments: { server: fullServerName("/proj", "ctx"), tool: "use_ctx" } }, async () => ({ kind: "allow" }));
  expect(callDeny.kind, "ws_mcp_call guard 查禁用表").toBe("deny");
  expect(toolDisabledReason(fullServerName("/proj", "ctx"), "use_ctx").includes("mcp-manager 管辖"), "禁用原因声明覆盖 mcp__ 与中间层工具（#413）").toBe(true);

  // 3) callTool（ws_mcp_call 执行路径）：禁用工具 → 显式抛错（验收 14：三入口一致）。
  const callUnit = {
    root: "/proj",
    connections: new Map([["ctx", { server: { name: "ctx", transport: "stdio", command: "x", enabled: true }, status: "connected", error: undefined, client: { callTool: async () => ({ content: [] }) }, reconnectTimer: undefined, disposed: false, failedAttempts: 0 }]]),
    catalog: new Map([["ctx", { discoveredAt: Date.now(), tools: new Map([["use_ctx", { description: "d", inputSchema: {} }]]) }]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  mw.units.set("/proj", callUnit);
  await expect(
    () => mw.callTool(fullServerName("/proj", "ctx"), "use_ctx", {}, undefined),
    "callTool 先查禁用表（三入口一致）",
  ).rejects.toThrow(/已被用户在「MCP」浮窗禁用/);
  // 未禁用工具正常放行到调用。
  const okValue = await mw.callTool(fullServerName("/proj", "ctx"), "other", {}, undefined);
  expect(okValue.content, "未禁用工具正常调用").toEqual([]);

  // 4) stats：四个原子工具埋点与统计断言
  const { McpStatsCollector } = await import("../../lib/index.js");
  const testStatsDir = mkdtempSync(join(tmpdir(), "mcp-smoke-stats-"));
  const testStatsFile = join(testStatsDir, "smoke-stats.json");
  try {
    const statsCollector = new McpStatsCollector({ enabled: true, filePath: testStatsFile });
    // 提取注册的原子工具
    const statsRegTools: any[] = [];
    const statsCtx = {
      tools: { register: (def: any) => { statsRegTools.push(def); return () => {}; } },
      on: () => () => {},
    };
    const statsMwDispose = registerMiddlewareTools(
      statsCtx as any,
      mw,
      async () => "/proj",
      "project",
      { stats: statsCollector }
    );

    const searchTool = statsRegTools.find((t) => t.name === "ws_mcp_search");
    const listTool = statsRegTools.find((t) => t.name === "ws_mcp_list");
    const detailTool = statsRegTools.find((t) => t.name === "ws_mcp_detail");
    const callTool = statsRegTools.find((t) => t.name === "ws_mcp_call");

    expect(searchTool && listTool && detailTool && callTool, "四个原子工具均已注册").toBeTruthy();

    // 执行四个原子工具
    await searchTool.execute({ query: "codegraph" }, { agent: { session: { header: { cwd: "/proj" } } } });
    await listTool.execute({}, { agent: { session: { header: { cwd: "/proj" } } } });
    await detailTool.execute({ server: fullServerName("/proj", "ctx"), tool: "use_ctx" }, { agent: { session: { header: { cwd: "/proj" } } } });
    await callTool.execute({ server: fullServerName("/proj", "ctx"), tool: "other" }, { agent: { session: { header: { cwd: "/proj" } } } });

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
  const { McpManager, McpStore, loadDisabledTools, saveDisabledTools, parseDisabledTools, MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-tools-"));
  try {
    const file = join(dir, "dsh-mcp-user-state.json");
    // 预置磁盘记录（模拟另一工作空间已禁用），并让 manager 加载（等价
    // initMiddleware 的 loadDisabledTools 路径——进程内完整视图）。
    await saveDisabledTools(file, parseDisabledTools({ "/other": { s2: ["t2"] } }));
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, new McpStore(join(dir, "mcp.json")));
    manager.userStatePath = file;
    manager.disabledTools = await loadDisabledTools(file);
    // 多空间共存：新增 /proj 记录，/other 记录保留（不整表覆盖）。
    await manager.setToolDisabled("/proj", "ctx", "use_ctx", true);
    await manager.setToolDisabled(MIDDLEWARE_GLOBAL_ROOT, "gctx", "use_g", true);
    const reloaded = await loadDisabledTools(file);
    expect(reloaded.get("/proj")?.get("ctx")?.has("use_ctx"), "/proj 记录落盘").toBe(true);
    expect(reloaded.get("@global")?.get("gctx")?.has("use_g"), "@global 记录落盘").toBe(true);
    expect(reloaded.get("/other")?.get("s2")?.has("t2"), "既有 /other 记录保留（合并式，绝不整表覆盖）").toBe(true);
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
it("client 注册 settings.plugin.item 卡（id/key = 宿主命名空间 dsh-mcp-manager）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("settings.plugin.item"), "settings.plugin.item 卡已注册").toBeTruthy();
  expect(clientSrc.includes("dsh-mcp-manager"), "卡片 key/id 引用宿主命名空间 dsh-mcp-manager").toBeTruthy();
});
it("#362 客户端：工具级禁用 checkbox + scope 分组 + project 全局提示 + middleware 下拉", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 工具 checkbox 经 tool-disable API 持久化。
  expect(clientSrc.includes("tool-disable"), "客户端含 tool-disable API 调用").toBeTruthy();
  expect(clientSrc.includes('type: "checkbox"'), "工具开关为 checkbox").toBeTruthy();
  expect(clientSrc.includes("dm-float-tools"), "浮窗折叠式工具清单存在").toBeTruthy();
  expect(clientSrc.includes("切 all 模式可管理全局工具"), "project 模式全局组提示文案").toBeTruthy();
  expect(clientSrc.includes("dm-set-middleware"), "设置页中间层模式下拉存在").toBeTruthy();
  // 浮窗与管理面板均按 scope 分组。
  expect(clientSrc.includes("dm-float-group-title"), "浮窗 scope 分组标题存在").toBeTruthy();
  expect(clientSrc.includes("项目级") && clientSrc.includes("全局"), "scope 分组文案存在").toBeTruthy();
  // #401 勾选 = 禁用：勾选态自绘为红色 ×（非原生蓝色 ✓），工具名同步标红。
  expect(clientSrc.includes("appearance:none"), "工具 checkbox 自绘（appearance:none）").toBeTruthy();
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
  expect(clientSrc.includes("unsubLocale = locale.subscribe"), "subscribe 返回值保存（unsubLocale）进产物").toBeTruthy();
  expect(/unsubLocale!=null&&unsubLocale\(\)|unsubLocale\(\)/.test(clientSrc), "卸载调用 unsubLocale() 进产物").toBeTruthy();
  expect(clientSrc.includes("locale: NS"), "slots.register locale 参数进产物").toBeTruthy();
  expect(clientSrc.includes("Running") && clientSrc.includes("stConnected"), "en/zh 双语字典 + STATUS_TEXT key 化进产物").toBeTruthy();
});
it("#362 无游离 css：style.css 全部内联进 client.js（无独立样式请求）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8");
  const probe = css.split("\n").filter((line) => line.trim() !== "").pop() ?? "";
  // 样式文件末尾规则应整体出现在 client.js 产物中（text-loader 原样内联）。
  expect(clientSrc.includes(probe.slice(0, 40)), "style.css 尾部规则已内联进 client.js").toBeTruthy();
  expect(!clientSrc.includes('rel="stylesheet"'), "无独立样式表请求").toBeTruthy();
});

// ---- 阶段 7 C 类修复哨兵断言（先红后绿：断言先行，修复随 commit 转绿）----
it("C1 编辑保存链路修复：fillForm 不再清空 editingName（PATCH 分支可达）+ enabled 回填", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 链路修复：fillForm 函数体（到 saveForm 为止）不得再调用会清空 editingName 的 resetForm。
  const fillFormStart = clientSrc.indexOf("function fillForm");
  const saveFormStart = clientSrc.indexOf("function saveForm");
  expect(fillFormStart >= 0 && saveFormStart > fillFormStart, "产物含 fillForm/saveForm 标识符").toBeTruthy();
  expect(
    !clientSrc.slice(fillFormStart, saveFormStart).includes("resetForm("),
    "fillForm 内不再调用 resetForm（清空 editingName 的链路修复）",
  ).toBeTruthy();
  // enabled 回填：编辑 enabled:false 服务器时表单 checkbox 不得被强制勾选（C1 附带回填）。
  expect(clientSrc.includes("fill.enabled"), "enabled 回填进产物（formEnabled.checked = fill.enabled !== false）").toBeTruthy();
});
it("C2 SSE 轮询探测恢复：eventsRetired 后周期性探测重连（非永久轮询）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("tryResumeEvents"), "轮询恢复探测入口 tryResumeEvents 进产物").toBeTruthy();
  expect(clientSrc, "轮询计数周期性触发探测（pollTicks % N）").toMatch(/pollTicks\s*%/);
});
it("C3 超长名溢出防护：服务器名/工具名 CSS overflow-wrap", () => {
  const css = readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8");
  expect(css, "管理面板服务器名 overflow-wrap").toMatch(/\.dm-server \.dm-name\{[^}]*overflow-wrap:anywhere/);
  expect(css, "浮窗工具 checkbox 名 overflow-wrap").toMatch(/\.dm-float-tool,\.dm-tool\{[^}]*overflow-wrap:anywhere/);
});
it("C4 keydown 泄漏修复：Escape 监听具名 + 卸载配对移除", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes('addEventListener("keydown", onKeyDown)'), "keydown 监听具名 onKeyDown 进产物").toBeTruthy();
  expect(clientSrc.includes('removeEventListener("keydown", onKeyDown)'), "配对 removeEventListener 进产物").toBeTruthy();
});
it("C5 设置卡成功提示 setTimeout 清理（卸载不 setState）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("msgTimer"), "msgTimer ref 进产物").toBeTruthy();
  expect(clientSrc, "卸载/重复保存前清理 msgTimer").toMatch(/clearTimeout\(msgTimer\.current\)/);
});
it("C6 tool-disable 全名形态：projectRoot 缺失防御性不提交非法 @/name", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("toolDisableServerKey"), "tool-disable 全名拼装 helper 进产物").toBeTruthy();
  // esbuild 保留模板串形态：helper 返回 `@@global/${server.name}`。
  expect(clientSrc.includes("`@@global/${server.name}`"), "global 形态 @@global/<name> 进产物（helper 模板串）").toBeTruthy();
});
it("C7 浮窗操作带 cwd：float connect/enable/disable 与 servers 对齐（#412 自愈）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // esbuild 保留模板串形态：float `&scope=${server.scope}${cwdQuery}`；servers `${scopeQuery}${cwdQuery}`。
  expect(clientSrc.includes("${server.scope}${cwdQuery}"), "float 操作 URL 拼接 cwdQuery 进产物").toBeTruthy();
  expect(clientSrc.includes("${scopeQuery}${cwdQuery}"), "servers disconnect/disable 补齐 cwdQuery 进产物").toBeTruthy();
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
  expect(refreshCount >= 2, "showPanel 内 refresh 出现≥2 次（onclick + 打开主动刷新）").toBeTruthy();
});
it("C13 未知状态按 stopped 投影：servers 列表不静默丢卡（与 float 一致）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const renderStart = clientSrc.indexOf("function renderServers");
  expect(renderStart >= 0, "renderServers 标识符在产物中").toBeTruthy();
  expect(
    clientSrc.slice(renderStart, renderStart + 2000).includes('.get("stopped").push'),
    "servers 渲染未知状态塞入 stopped 分组（不丢卡）",
  ).toBeTruthy();
});
it("C11 编辑改 name/scope 迁移式保存：POST 新条目 + DELETE 旧条目（宿主 PATCH 不支持改名/scope）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // C11（阶段 8 落地，依赖阶段 7 C1 修复后 PATCH 分支可达）：saveForm 检测
  // name 或 scope 变化 → 迁移分支（先 POST 后 DELETE），避免新 scope 查旧
  // name 404。
  expect(clientSrc.includes("migrated"), "迁移分支检测变量 migrated 进产物").toBeTruthy();
  expect(clientSrc.includes("state.editing.scope"), "DELETE 旧条目用旧 scope 进产物").toBeTruthy();
});

it("客户端 watchdog：60s 失活重建 + 建连前先关旧（0.1.8 同款防泄漏）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "60s watchdog 常量存在").toMatch(/WATCHDOG_MS\s*=\s*(?:60_?000|6e4|60000)/);
  expect(clientSrc.includes("forceReconnect"), "受控重建入口 forceReconnect 存在").toBeTruthy();
  expect(clientSrc.includes("closeEvents"), "关旧连接入口 closeEvents 存在").toBeTruthy();
  // 关旧建新：new EventSource 前必先关旧——覆盖 source 引用不 close 会耗尽
  // 浏览器同源并发连接（dsh-notifier 0.1.8 同款事故）。
  expect(
    clientSrc.indexOf("closeEvents()") >= 0 && clientSrc.indexOf("closeEvents()") < clientSrc.indexOf("new EventSource"),
    "建连前先执行关旧兜底",
  ).toBeTruthy();
  expect(clientSrc, "收到数据帧即喂狗").toMatch(/lastActivity\s*=\s*Date\.now\(\)/);
  // 心跳 ping 帧喂狗后早退，不得落入 else 触发 scheduleRefresh（否则 SSE 退化为隐性 30s 轮询）。
  expect(clientSrc, "ping 帧仅喂狗即早退").toMatch(/===\s*"ping"\)\s*return/);
  // 卸载清理：watchdog 定时器与 SSE 连接都要收掉（esbuild 产物 undefined 折叠为 void 0）。
  expect(clientSrc, "卸载清 watchdog").toMatch(/if\s*\(watchdog\s*!==\s*(?:void 0|undefined)\)\s*clearTimeout\(watchdog\)/);
  expect(clientSrc, "卸载关 SSE 并摘监听").toMatch(/closeEvents\(\);\s*document\.removeEventListener\("visibilitychange"/);
});
it("回前台强制重建 SSE + 受控重建连接（visibilitychange → rebindSession → forceReconnect + resume + 补拉）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "visibilitychange 监听已挂").toMatch(/addEventListener\("visibilitychange",\s*onVisible\)/);
  expect(
    clientSrc,
    "回前台路径先强制重建 SSE",
  ).toMatch(/onVisible\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(document\.hidden\)\s*return;\s*forceReconnect\(\)/);
  // #412：切回前台先 rebindSession（宿主重启后 projectRoot 丢失，旧页面
  // bindSession 不重跑——强制 POST /session 恢复 projectRoot + 惰性连接），
  // 再 POST resume 驱动宿主受控重建当前工作空间连接（半开死连接卡 connected
  // 时纯读 refresh 无法恢复）。
  expect(
    clientSrc,
    "回前台路径先重绑会话再 resume（#412 复报：宿主重启场景恢复）",
  ).toMatch(/rebindSession\(state\)\.then\(\(\)\s*=>\s*api\(state\.API\.resume,\s*\{\s*method:\s*"POST"\s*\}\)\)/);
  // iOS bfcache 恢复（pageshow persisted）等价切回前台，走同一恢复路径。
  expect(clientSrc, "pageshow 监听已挂（bfcache 恢复）").toMatch(/addEventListener\("pageshow",\s*onPageShow\)/);
  expect(clientSrc, "pageshow persisted 才触发恢复").toMatch(/event\?\.persisted\s*===\s*true\s*\)\s*onVisible\(\)/);
  // 宿主重启而页面始终可见（无 visibilitychange）：SSE 自动重连成功即核对宿主
  // 会话状态（onopen → maybeRecoverSession → GET /servers 校验 projectRoot）。
  expect(clientSrc, "SSE 连接建立时挂 onopen 探测").toMatch(/es\.onopen\s*=\s*\(\)\s*=>\s*\{/);
  expect(clientSrc, "onopen 触发宿主会话恢复探测").toMatch(/maybeRecoverSession\(\)/);
});

it("设置卡片样式对齐官方风格（#219：12px 圆角 / bg-layer-3 底 / border-l2 / 15px 名称字 / 13px 描述字 / 14 16 padding / gap 4）", () => {
  const css = readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8");
  expect(css, "卡片圆角对齐官方 12px").toMatch(/border-radius:12px/);
  expect(css, "卡片底色对齐官方 bg-layer-3").toMatch(/background:var\(--dsw-alias-bg-layer-3,#fbfbfc\)/);
  expect(css, "卡片边框对齐官方 border-l2").toMatch(/border:1px solid var\(--dsw-alias-border-l2,#e2e5ea\)/);
  expect(css, "head padding 对齐官方 14px 16px").toMatch(/\.dm-set-head\{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px/);
  expect(css, "headText gap 对齐官方 4px").toMatch(/\.dm-set-headText\{display:flex;flex-direction:column;gap:4px/);
  expect(css, "名称字号对齐官方 15px").toMatch(/\.dm-set-name\{display:block;font-size:15px;font-weight:600;line-height:1\.4/);
  expect(css, "描述字号对齐官方 13px").toMatch(/\.dm-set-description\{display:block;font-size:13px;line-height:1\.5/);
  expect(css, "描述用 tertiary 层级（与官方同款）").toMatch(/--dsw-alias-label-tertiary,#8a919c/);
});

it("设置卡片展开箭头为官方 SVG chevron（#167：非文本 ▾ 字符）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes('dm-set-chevron'), "chevron class 在客户端产物中").toBeTruthy();
  expect(!/dm-set-chevron[^"]*"[^>]*>▾/.test(clientSrc), "不再使用文本 ▾ 字符作为箭头").toBeTruthy();
  expect(clientSrc.includes('M11.8486 5.5L11.4238'), "使用官方 chevron-down SVG path").toBeTruthy();
  expect(clientSrc, "SVG 尺寸 14x14（官方同款）").toMatch(/width:\s*14,\s*height:\s*14/);
});

it("F1（qa 实测 #128）：浮窗面板内容更新后重定位 + toggleFloat 先渲染后定位", () => {
  const src = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // renderFloatPanel 函数体内触发 placePanel 重定位：bottom-* 锚点下内容撑高后
  // 不重排会稳定向下溢出视口（375x667 bottom-left 实测 y=561/bottom=1082 稳态）。
  const renderStart = src.indexOf("function renderFloatPanel");
  const toggleStart = src.indexOf("function toggleFloat");
  expect(renderStart >= 0 && toggleStart > renderStart, "产物含 renderFloatPanel/toggleFloat 标识符").toBeTruthy();
  expect(
    src.slice(renderStart, toggleStart).includes("placePanel(state)"),
    "renderFloatPanel 内容渲染完成即触发 placePanel 重定位（bottom 锚点防溢出）",
  ).toBeTruthy();
  // toggleFloat 内先渲染后定位：以真实内容高度定位，消除首帧小高度错位。
  const tf = src.slice(toggleStart);
  expect(
    tf.indexOf("renderFloatPanel(state, actions)") >= 0
      && tf.indexOf("renderFloatPanel(state, actions)") < tf.indexOf("placePanel(state)"),
    "toggleFloat 先 renderFloatPanel 后 placePanel",
  ).toBeTruthy();
});

it("Config 导出且含 ui 子对象（默认值与合法值域）", () => {
  expect(typeof Config === "function", "Config 是 schemastery schema（可调用）").toBeTruthy();
  const parsed = Config({});
  expect(parsed.ui.position, "ui.position 默认 top-right").toBe("top-right");
  expect(parsed.ui.offset, "ui.offset 默认 {x:8,y:8,blankY:40}").toEqual({ x: 8, y: 8, blankY: 40 });
  expect(parsed.ui.zIndexBase, "#128 ui.zIndexBase 默认 10").toBe(10);
  expect(DEFAULT_UI_CONFIG.position, "DEFAULT_UI_CONFIG.position 与升级前一致").toBe("top-right");
  expect(DEFAULT_UI_CONFIG.offset).toEqual({ x: 8, y: 8, blankY: 40 });
  expect(DEFAULT_UI_CONFIG.zIndexBase, "#128 DEFAULT_UI_CONFIG.zIndexBase 与 CSS 默认 z-index 一致").toBe(10);
  // 合法值域：四角全部透传（#128 补左上/左下）
  for (const p of ["top-left", "bottom-left"] as const) {
    const parsedP = Config({ ui: { position: p } });
    expect(parsedP.ui.position, `#128 ${p} 是合法 position`).toBe(p);
  }
  const bottom = Config({ ui: { position: "bottom-right" } });
  expect(bottom.ui.position, "bottom-right 是合法 position").toBe("bottom-right");
});
it("normalizeUiConfig：默认 / 合法值透传 / 非法回退（不抛）", () => {
  // 未配置 → 默认
  expect(normalizeUiConfig(undefined)).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
  expect(normalizeUiConfig(null)).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
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
    normalizeUiConfig({ position: "top-left", offsetX: 1, offsetY: 2, blankY: 3, zIndexBase: 5000 }),
    "左上 + 合法层级基准透传",
  ).toEqual({ position: "top-left", offsetX: 1, offsetY: 2, blankY: 3, zIndexBase: 5000 });
  // 非法/缺失 → 安全回退默认，不抛
  expect(normalizeUiConfig({ position: "middle-left" })).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
  expect(normalizeUiConfig({ ui: { position: "nope", offset: { x: "abc" } } })).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
  expect(normalizeUiConfig({ offset: {} })).toEqual({ position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
  expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase, "#128 低于下界压到 1").toBe(Z_INDEX_BASE_MIN);
  expect(normalizeUiConfig({ zIndexBase: -50 }).zIndexBase, "#128 负数压到 1").toBe(Z_INDEX_BASE_MIN);
  expect(normalizeUiConfig({ zIndexBase: 9000 }).zIndexBase, "#128 上界 9000 透传").toBe(Z_INDEX_BASE_MAX);
  expect(normalizeUiConfig({ zIndexBase: 9001 }).zIndexBase, "#128 超上界压到 9000").toBe(Z_INDEX_BASE_MAX);
  expect(normalizeUiConfig({ zIndexBase: Number.NaN }).zIndexBase, "#128 NaN 回退默认").toBe(10);
});
it("buildConfigUiPatch：客户端扁平形态 → Config.ui 嵌套补丁（写路径）", () => {
  // 客户端 POST 的扁平形态 → 宿主写入 Config.ui 的嵌套补丁
  expect(
    buildConfigUiPatch({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
  ).toEqual({ position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 10 });
  // #128 四角 + 层级基准写入嵌套补丁
  expect(
    buildConfigUiPatch({ position: "bottom-left", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 77 }),
  ).toEqual({ position: "bottom-left", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 77 });
  // 缺省 → 安全回退默认
  expect(
    buildConfigUiPatch(undefined),
  ).toEqual({ position: "top-right", offset: { x: 8, y: 8, blankY: 40 }, zIndexBase: 10 });
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
    expect(text.includes("top-left") && text.includes("bottom-left"), `#128 ${file} 未含四角值域`).toBeTruthy();
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
  expect(libSseData({ type: "ui-config-changed" })).toBe(sharedSseData({ type: "ui-config-changed" }));
  expect(libSseData({ type: "ping" })).toBe('data: {"type":"ping"}\n\n');
});
it("broadcastFrame 向全部连接写帧（掉线忽略）", () => {
  const written = [];
  const conn = { write: (chunk) => { written.push(chunk); } };
  const dead = { write: () => { throw new Error("closed"); } };
  broadcastFrame(new Set([conn, dead]), "data: {\"type\":\"summary\"}\n\n");
  expect(written).toEqual(["data: {\"type\":\"summary\"}\n\n"]);
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
  expect(clampPointToViewport(-30, -50, 100, 80, 375, 667), "负坐标钳回视口原点").toEqual({ x: 0, y: 0 });
  expect(clampPointToViewport(400, 700, 100, 80, 375, 667), "右/下溢出钳回视口内").toEqual({ x: 275, y: 587 });
  expect(clampPointToViewport(10, 20, 100, 80, 375, 667), "视口内坐标不改变（桌面零回归）").toEqual({ x: 10, y: 20 });
  expect(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10), "safeInset>0 按安全区内缩").toEqual({ x: 10, y: 10 });
  expect(clampPointToViewport(0, 0, 9999, 9999, 375, 667), "元素大于视口时钳到原点不倒挂").toEqual({ x: 0, y: 0 });
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
  expect(composerDockedAtBottom({ top: 670, bottom: 844 }, container), "seat 贴底 → docked=true").toBe(true);
  expect(composerDockedAtBottom({ top: 670, bottom: 843 }, { top: 0, bottom: 844 }), "距底缘 1px 未贴底 → false").toBe(false);
  expect(composerDockedAtBottom({ top: 300, bottom: 500 }, { top: 0, bottom: 844 }), "seat 居中未贴底 → false").toBe(false);
  expect(composerDockedAtBottom(null, container), "seat null → false").toBe(false);
  expect(composerDockedAtBottom({ top: 670, bottom: 844 }, null), "container null → false").toBe(false);
  expect(bottomAnchorEdge(844, 670, true), "docked → seatTop").toBe(670);
  expect(bottomAnchorEdge(844, 670, false), "未 docked → containerBottom").toBe(844);
  expect(bottomAnchorEdge(844, null, true), "seatTop=null → containerBottom").toBe(844);
  expect(bottomAnchorEdge(844, Number.NaN, true), "seatTop 非有限数 → containerBottom（无 NaN）").toBe(844);
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
  expect(normalizeServer({ name: "a", transport: "stdio", command: "x", description: "  " }).description, "空白描述归一为 undefined").toBe(undefined);
  expect(normalizeServer({ name: "a", transport: "stdio", command: "x", description: "长".repeat(200) }).description.length, "描述完整返回不截断").toBe(200);
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
  expect(() => normalizeServer({ name: "a", transport: "streamable-http", url: "not a url" })).toThrow();
});
it("B13: http(s) 之外的协议被拒绝（ftp/file 非 streamable-http）", () => {
  expect(() => normalizeServer({ name: "a", transport: "streamable-http", url: "ftp://host/path" }), "B13：ftp 协议拒绝").toThrow(/protocol/);
  expect(() => normalizeServer({ name: "a", transport: "streamable-http", url: "file:///etc/passwd" }), "B13：file 协议拒绝").toThrow(/protocol/);
  expect(() => normalizeServer({ name: "a", transport: "streamable-http", url: "https://host/path" }), "https 放行").not.toThrow();
  expect(() => normalizeServer({ name: "a", transport: "streamable-http", url: "http://host/path" }), "http 放行").not.toThrow();
});
it("enabled: false 保留", () => {
  expect(normalizeServer({ name: "a", transport: "stdio", command: "x", enabled: false }).enabled).toBe(false);
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
  const servers = parseClaudeJson(JSON.stringify({
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    remote: { type: "http", url: "https://mcp.example.com/mcp" },
  }));
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
  expect(publicToolName("context7", "use_context7")).toBe(publicToolName("context7", "use_context7"));
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
it("parseSsePayload 提取匹配 id 的 JSON", () => {
  const text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
  expect(parseSsePayload(text, 7).result).toEqual({ ok: true });
  expect(parseSsePayload(text, 99)).toBe(undefined);
});

// sequential-thinking-server v0.2.0 实际返回的 inputSchema / outputSchema
const ST_INPUT = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "thought": { "type": "string", "description": "Your current thinking step" },
    "nextThoughtNeeded": { "description": "Whether another thought step is needed", "type": "boolean" },
    "thoughtNumber": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Current thought number" },
    "totalThoughts": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Estimated total thoughts" },
  },
  "required": ["thought", "thoughtNumber", "totalThoughts"],
};
const ST_OUTPUT = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "thoughtNumber": { "type": "number" },
    "totalThoughts": { "type": "number" },
    "nextThoughtNeeded": { "type": "boolean" },
    "branches": { "type": "array", "items": { "type": "string" } },
    "thoughtHistoryLength": { "type": "number" },
  },
  "required": ["thoughtNumber", "totalThoughts", "nextThoughtNeeded", "branches", "thoughtHistoryLength"],
  "additionalProperties": false,
};
// playwright 真实声明的 browser_drop inputSchema（含 propertyNames 与 schema 形式 additionalProperties）
const PWD_DROP_INPUT = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": { "type": "string", "description": "Exact target element reference from the page snapshot" },
    "data": {
      "type": "object",
      "propertyNames": { "type": "string" },
      "additionalProperties": { "type": "string" },
    },
  },
  "required": ["target"],
  "additionalProperties": false,
};
let assertSupportedJsonSchema;
// 解析 @deepseek-ai/dsh-tools(真实 schema 校验器)做交叉断言。
// 候选顺序:依赖树解析 → DSH_TOOLS_PATH 环境变量 → Volta 全局安装布局。
// 全部失败时警告而非静默跳过(避免"测试通过但覆盖缺失"的假象)。
const candidates = [];
try {
  candidates.push(import.meta.resolve("@deepseek-ai/dsh-tools"));
} catch {
  // 不在依赖树,继续尝试其他候选
}
if (typeof process.env.DSH_TOOLS_PATH === "string" && process.env.DSH_TOOLS_PATH !== "") {
  candidates.push(pathToFileURL(process.env.DSH_TOOLS_PATH).href);
}
try {
  const voltaPackages = join(dirname(dirname(dirname(process.execPath))), "packages");
  candidates.push(pathToFileURL(join(voltaPackages, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js")).href);
} catch {
  // 非 Volta 环境,跳过布局候选
}
let toolsLoadError;
for (const url of candidates) {
  try {
    const dshTools = await import(url);
    assertSupportedJsonSchema = dshTools.assertSupportedJsonSchema;
    break;
  } catch (error) {
    toolsLoadError = error;
  }
}
if (assertSupportedJsonSchema === undefined) {
  console.warn(`smoke: @deepseek-ai/dsh-tools 不可解析(${toolsLoadError?.message ?? "无可用候选"})——schema 交叉校验断言跳过;可设置 DSH_TOOLS_PATH 指向其 lib/index.js`);
}
it("output schema 带 $schema 关键字 → 校验失败（回退自由值）", () => {
  expect(assertSupportedOutputSchema(ST_OUTPUT)).toBe(undefined);
});
it("纯支持子集 output schema → 原样通过", () => {
  const clean = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  expect(assertSupportedOutputSchema(clean)).toEqual(clean);
});
it("schema 形式的 additionalProperties / propertyNames → 校验失败", () => {
  expect(assertSupportedOutputSchema(PWD_DROP_INPUT)).toBe(undefined);
  expect(assertSupportedOutputSchema({ type: "object", additionalProperties: { type: "string" } })).toBe(undefined);
  expect(assertSupportedOutputSchema({ type: "object", properties: { data: { type: "object", propertyNames: { type: "string" } } } })).toBe(undefined);
});
it("校验通过的 output 构建的 output.schema 通过真实 assertSupportedJsonSchema", () => {
  const structured = assertSupportedOutputSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false });
  expect(structured !== undefined).toBeTruthy();
  const outputSchema = {
    type: "object",
    properties: {
      content: { type: "array", items: {} },
      structuredContent: structured ?? {},
    },
    required: structured === undefined ? ["content"] : ["content", "structuredContent"],
    additionalProperties: false,
  };
  if (assertSupportedJsonSchema !== undefined) assertSupportedJsonSchema(outputSchema); // 不抛即通过
});
it("无 outputSchema / 空 schema / 注解-only 的处理", () => {
  expect(assertSupportedOutputSchema(undefined)).toBe(undefined);
  expect(assertSupportedOutputSchema({})).toEqual({});
  expect(assertSupportedOutputSchema({ type: "object" })).toEqual({ type: "object" });
  expect(assertSupportedOutputSchema({ description: "x" })).toEqual({ description: "x" });
});
it("oneOf ≥2 且无兄弟关键字；非法结构返回 undefined", () => {
  expect(assertSupportedOutputSchema({ oneOf: [{ type: "string" }, { type: "number" }] })).toEqual({ oneOf: [{ type: "string" }, { type: "number" }] });
  expect(assertSupportedOutputSchema({ oneOf: [{ type: "string" }] })).toBe(undefined);
  expect(assertSupportedOutputSchema({ type: "object", oneOf: [{ type: "string" }, { type: "number" }] })).toBe(undefined);
  expect(assertSupportedOutputSchema({ type: "object", additionalProperties: {} })).toBe(undefined); // additionalProperties 必须布尔
  expect(assertSupportedOutputSchema({ type: "object", required: ["missing"] })).toBe(undefined); // required 不在 properties
  expect(assertSupportedOutputSchema({ type: "string", enum: [1] })).toBe(undefined); // enum 值不匹配类型
});
it("parameters 原样直传（业界标准）：inputSchema 含 $schema/minimum 也直接可用", () => {
  // parameters 不再净化：任何 MCP inputSchema 都原样注册（运行时校验忽略未知键）
  expect(assertSupportedOutputSchema(undefined)).toEqual(undefined);
  expect(ST_INPUT.properties.thoughtNumber.minimum === 1).toBeTruthy(); // 原样保留
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
    store.upsert({ name: "a" });
    store.upsert({ name: "b" });
    expect(store.data.servers.length).toBe(2);
    store.upsert({ name: "a", extra: 1 });
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
    writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "b", transport: "stdio", command: "echo", enabled: true }] }));
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
  let base, deep, home, leetcode, proj, projSub, nomark, findProjectRoot, manager, prevDshHome;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-root-"));
    deep = join(base, "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12", "d13", "d14");
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
    writeFileSync(join(home, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
    writeFileSync(join(proj, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
    prevDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(home, ".dsh");
    ({ findProjectRoot } = await import("../../lib/index.js"));
    manager = new McpManager(
      { logger: { warn: () => {}, info: () => {}, error: () => {} } },
      new McpStore(join(base, "dsh-mcp.json")),
    );
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
    expect(manager.summary().servers.filter((s) => s.scope === "project").length).toBe(0);
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
  let base, rootA, rootB, subA, noReconnect, gstore, manager;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-cat-"));
    rootA = join(base, "projA");
    rootB = join(base, "projB");
    subA = join(rootA, "sub");
    mkdirSync(join(rootA, ".dsh"), { recursive: true });
    mkdirSync(join(rootB, ".dsh"), { recursive: true });
    mkdirSync(subA, { recursive: true });
    noReconnect = { reconnect: { enabled: false } };
    writeFileSync(join(rootA, ".dsh", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [normalizeServer({ name: "a1", transport: "stdio", command: "true", ...noReconnect })],
    }));
    writeFileSync(join(rootB, ".dsh", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [normalizeServer({ name: "b1", transport: "stdio", command: "true", ...noReconnect })],
    }));

    gstore = new McpStore(join(base, "dsh-mcp.json"));
    gstore.data.servers = [normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect })];
    manager = new McpManager(
      { logger: { warn: () => {}, info: () => {}, error: () => {} } },
      gstore,
    );
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

  it("同名项目级被全局顶掉", async () => {
    // projB 里放一台与全局同名的服务器
    const storeB = await manager.projectStoreFor(rootB);
    storeB.upsert(normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }));
    const names = [...(await manager.catalogServersFor(rootB)).keys()];
    expect(names).toEqual(["g1", "b1"]);
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
    await manager.registerServer(normalizeServer({ name: "rt1", transport: "stdio", command: "true", ...noReconnect }));
    const names = [...(await manager.catalogServersFor("")).keys()];
    expect(names).toEqual(["g1", "rt1"]);
    // 同名 runtime 优先于 store（与 reconcile 双轨一致）——目录仍含该名。
    await manager.registerServer(normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }));
    const g1 = (await manager.catalogServersFor("")).get("g1");
    expect(g1 !== undefined && g1.server !== undefined, "g1 仍在目录中").toBe(true);
  });
});


describe("外部配置变更自动重读（refreshFromDisk / reconcileServers）", () => {
  let base, proj, cfg, gstore, manager, disconnected;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-reload-"));
    proj = join(base, "proj");
    cfg = join(proj, ".dsh", "mcp.json");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
    gstore = new McpStore(join(base, "dsh-mcp.json"));
    // 全局 disabled 服务器：验证 reconcile 不会为其 spawn 进程。
    gstore.data.servers = [normalizeServer({ name: "g1", transport: "stdio", command: "true", enabled: false })];
    await gstore.save();
    manager = new McpManager({ logger: { warn: () => {}, info: () => {}, error: () => {} } }, gstore);
    await manager.setSession(proj);
    // 假 supervisor：验证配置移除后被断开（不 spawn 真实连接）。
    disconnected = 0;
    manager.supervisors.set("ghost", {
      scope: SCOPE_PROJECT,
      status: "connected",
      client: {},
      toolDisposers: new Map(),
      disconnect: async () => {
        disconnected += 1;
      },
    });
  });

  afterAll(async () => {
    await manager.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it("项目级配置初始为空（setSession 后不自动 spawn）", () => {
    expect(manager.projectStore.data.servers.length).toBe(0);
  });

  it("外部新增 disabled 服务器 → refreshFromDisk 重读并进 summary（不 spawn）", async () => {
    // 显式拨未来 mtime，避免与 setSession 基线同毫秒导致 reloadIfChanged 检测不到。
    writeFileSync(cfg, JSON.stringify({
      version: 1,
      servers: [normalizeServer({ name: "p1", transport: "stdio", command: "true", enabled: false })],
    }));
    utimesSync(cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await manager.refreshFromDisk();
    const names = manager.summary().servers.filter((s) => s.scope === SCOPE_PROJECT).map((s) => s.name);
    expect(names, "外部新增出现在面板数据").toEqual(["p1"]);
    expect(manager.supervisors.has("p1"), "disabled 不启动").toBe(false);
  });

  it("外部移除配置 → 已连接 supervisor 被断开", async () => {
    writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
    utimesSync(cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await manager.refreshFromDisk();
    expect(disconnected, "ghost 被断开").toBe(1);
    expect(manager.supervisors.has("ghost")).toBe(false);
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
  let store, cleanup, managerState, uiCfg, manager, routes, find, fakeReq, fakeFenceBroken;

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
      middlewareMode: "project",
      updateUiConfig: async (raw) => {
        uiCfg = normalizeUiConfig(raw);
        return uiCfg;
      },
      refreshFromDisk: async () => {},
      setSession: async (cwd) => {
        managerState.sessionCwd = cwd;
      },
      add: async (body, scope) => {
        managerState.lastScope = scope;
        const server = normalizeServer(body);
        if (store.find(server.name) !== undefined) {
          throw new Error(`server "${server.name}" already exists`);
        }
        store.upsert(server);
        return server;
      },
      update: async (nm, patch, scope) => {
        managerState.lastScope = scope;
        const server = normalizeServer({ ...store.find(nm), ...patch, name: nm });
        store.upsert(server);
        return server;
      },
      remove: async (nm, scope) => {
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
    routes = makeRoutes(manager, process.cwd());
    find = (path) => routes.find((route) => route.path === path);
    fakeReq = (method, url, body) => ({
      method,
      url,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    });
    fakeFenceBroken = (method, url) => ({
      method,
      url,
      socket: { remoteAddress: "10.0.0.5" },
      headers: { host: "localhost:3080" },
      async *[Symbol.asyncIterator]() {},
    });
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
    expect(store.find("github").command).toBe("npx");
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
    expect(store.find("github").args).toEqual(["-y", "x"]);
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

  it("config GET → 200 读回（默认 top-right/8/8/40 + middleware 字段）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), res);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.position).toBe("top-right");
    expect(body.offsetX).toBe(8);
    expect(body.offsetY).toBe(8);
    expect(body.blankY).toBe(40);
    expect(body.middleware, "config GET 附带中间层模式").toBe("project");
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
      fakeReq("POST", ROUTES.config, { position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
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
    expect(readBack).toEqual({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 10, middleware: "project" });
  });

  it("config POST middleware → 热切换 + 落盘（读回 middleware 变化）", async () => {
    const write = fakeRes();
    await find(ROUTES.config).handler(fakeReq("POST", ROUTES.config, { middleware: "off" }), write);
    expect(write.state.status).toBe(200);
    const read = fakeRes();
    await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
    const readBack = JSON.parse(read.state.body);
    expect(readBack.middleware, "fake manager 无 setMiddlewareMode → 模式不变（读回原值）").toBe("project");
  });

  it("config POST 非 loopback → 403（写操作不开放远程页面）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeFenceBroken("POST", ROUTES.config, { position: "bottom-right" }), res);
    expect(res.state.status).toBe(403);
  });

  it("config PUT → 405（仅 GET/POST 合法；方法错围栏）", async () => {
    const res = fakeRes();
    await find(ROUTES.config).handler(fakeReq("PUT", ROUTES.config, { position: "bottom-right" }), res);
    expect(res.state.status).toBe(405);
  });

  it("events 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
    const eventsRoute = makeEventsRoute(manager);
    const res403 = fakeRes();
    await eventsRoute.handler(fakeFenceBroken("GET", ROUTES.events), res403);
    expect(res403.state.status).toBe(403);
    const res405 = fakeRes();
    await eventsRoute.handler(fakeReq("POST", ROUTES.events), res405);
    expect(res405.state.status).toBe(405);
  });

  it("health 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
    const healthRoute = makeHealthRoute(manager);
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
    expect(store.find("alpha").command).toBe("npx");
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
      expect(
        JSON.parse(res.state.body).error,
        `servers ${method} 405 文案逐字`,
      ).toBe(`method not allowed: ${method}`);
    }
    // config（结构 β）：PUT 405 由 else 分支直出（不查 loopback），文案同源逐字。
    const cfgPut = fakeRes();
    await find(ROUTES.config).handler(fakeReq("PUT", ROUTES.config, { position: "bottom-right" }), cfgPut);
    expect(cfgPut.state.status).toBe(405);
    expect(JSON.parse(cfgPut.state.body).error, "config PUT 405 文案逐字").toBe("method not allowed: PUT");
    const cfgOptions = fakeRes();
    await find(ROUTES.config).handler(fakeReq("OPTIONS", ROUTES.config), cfgOptions);
    expect(cfgOptions.state.status).toBe(405);
    expect(
      JSON.parse(cfgOptions.state.body).error,
      "config OPTIONS 405 文案逐字",
    ).toBe("method not allowed: OPTIONS");
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
      expect(
        JSON.parse(res.state.body).error,
        `${label} 405 文案逐字`,
      ).toBe(`method not allowed: ${method}`);
    }
    const eventsWrong = fakeRes();
    await makeEventsRoute(manager).handler(fakeReq("POST", ROUTES.events), eventsWrong);
    expect(eventsWrong.state.status).toBe(405);
    expect(
      JSON.parse(eventsWrong.state.body).error,
      "events 405 文案逐字",
    ).toBe("method not allowed: POST");
    const healthWrong = fakeRes();
    await makeHealthRoute(manager).handler(fakeReq("POST", ROUTES.health), healthWrong);
    expect(healthWrong.state.status).toBe(405);
    expect(
      JSON.parse(healthWrong.state.body).error,
      "health 405 文案逐字",
    ).toBe("method not allowed: POST");
  });

  it("resume：POST 合法 → 200 + 调用 resumeReconnect；围栏 403 / GET 405", async () => {
    const before = managerState.resumed;
    const res = fakeRes();
    await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume), res);
    expect(res.state.status).toBe(200);
    expect(managerState.resumed, "resumeReconnect 被调用（#412 切回前台恢复入口）").toBe(before + 1);
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
    const calls = [];
    const tdManager = {
      ...manager,
      projectRoot: "/proj",
      setToolDisabled: async (root, server, tool, disabled) => {
        calls.push({ root, server, tool, disabled });
      },
    };
    const tdRoutes = makeRoutes(tdManager, process.cwd());
    const tdRoute = tdRoutes.find((route) => route.path === ROUTES.toolDisable);
    const res = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/ctx", tool: "use_ctx", disabled: true }),
      res,
    );
    expect(res.state.status).toBe(200);
    expect(calls).toEqual([{ root: "/proj", server: "ctx", tool: "use_ctx", disabled: true }]);
    // #392 遗留④：带 mcp__ 前缀的 tool 名剥前缀后入禁用表（旧客户端/手工 API 提交
    // 带前缀名仍生效；此前原样存键 → guard 查裸名不命中，禁用静默无效）。
    const resPrefix = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/ctx", tool: "mcp__ctx__use_ctx", disabled: true }),
      resPrefix,
    );
    expect(resPrefix.state.status).toBe(200);
    expect(calls[calls.length - 1], "前缀名剥前缀入禁用表").toEqual({ root: "/proj", server: "ctx", tool: "use_ctx", disabled: true });
    // 跨 server 前缀（剥后仍 mcp__ 开头）→ 400（防错禁他 server 工具）。
    const resCross = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/ctx", tool: "mcp__other__t", disabled: true }),
      resCross,
    );
    expect(resCross.state.status, "跨 server 前缀拒绝").toBe(400);
    // 全局 root：scope=global 的服务器以 @global 为 key。
    const resG = fakeRes();
    await tdRoute.handler(
      fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/gctx", tool: "use_g", disabled: true }),
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
    await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }), fakeRes());
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("GET", `${ROUTES.servers}?cwd=C:/other`), res);
    expect(res.state.status).toBe(200);
    expect(managerState.sessionCwd, "GET 不应改变会话 cwd").toBe("C:/proj");
  });

  it("POST servers scope=project 透传 scope", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(
      fakeReq("POST", ROUTES.servers, { name: "proj-mcp", transport: "stdio", command: "x", scope: "project" }),
      res,
    );
    expect(res.state.status).toBe(201);
    expect(managerState.lastScope).toBe("project");
  });

  it("DELETE ?scope=project 透传 scope", async () => {
    const res = fakeRes();
    await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=proj-mcp&scope=project`), res);
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
    expect(ctx.routes.some((route) => route.path === ROUTES.events), "SSE events 路由已注册").toBeTruthy();
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
it("#362 中间层模式热切换：off 启动也可切到 project（设置页下拉路径）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-hotswitch-"));
  const ctx = fakeCtx();
  try {
    await apply(ctx, { enabled: true, middleware: "off", storePath: join(dir, "dsh-mcp.json") });
    // off 启动：不注册中间层工具，但 setMiddlewareMode 已挂。
    const toolNames = ctx.registeredTools.map((def) => def.name);
    expect(!toolNames.includes("ws_mcp_call"), "off 启动不注册中间层工具").toBeTruthy();
    const configRoute = ctx.routes.find((route) => route.path === ROUTES.config);
    expect(configRoute, "config 路由已注册").toBeTruthy();
    // POST middleware=project → 热切换生效：中间层工具注册。
    const res = fakeRes();
    const req = {
      method: "POST",
      url: ROUTES.config,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ middleware: "project" }));
      },
    };
    await configRoute.handler(req, res);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.middleware, "热切换后 config 读回 project").toBe("project");
    expect(ctx.registeredTools.some((def) => def.name === "ws_mcp_call"), "热切换后注册中间层工具").toBeTruthy();
    // 再切回 off：中间层工具卸载。
    const res2 = fakeRes();
    const req2 = {
      method: "POST",
      url: ROUTES.config,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ middleware: "off" }));
      },
    };
    await configRoute.handler(req2, res2);
    expect(res2.state.status).toBe(200);
    expect(JSON.parse(res2.state.body).middleware, "切回 off 生效").toBe("off");
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
  const settingsStub = {
    register(ns, schema, opts) {
      return { get: () => ({ ...scopeValue }), watch: () => {} };
    },
    async write(ns, patch) {
      scopeValue = { ...(scopeValue ?? {}), ...(patch ?? {}) };
    },
    update(ns, patch) {
      if (!this || typeof this.write !== "function") {
        throw new TypeError("settings.update 被以错误 this 调用（this.write undefined）");
      }
      return this.write(ns, patch);
    },
  };
  const sctx = { settings: settingsStub, effect: (fn) => { const d = fn(); return () => {}; } };
  const ctx = fakeCtx({
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) cb(sctx);
      return () => {};
    },
  });
  const localReq = (method, url, body) => ({
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  });
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    const configRoute = ctx.routes.find((route) => route.path === ROUTES.config);
    expect(configRoute, "config 路由已注册").toBeTruthy();
    const write = fakeRes();
    await configRoute.handler(
      localReq("POST", ROUTES.config, { position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
      write,
    );
    expect(write.state.status, "settings.update 以正确 this 调用 → 写路由 200（不再 400）").toBe(200);
    const written = JSON.parse(write.state.body);
    expect(written.position).toBe("bottom-right");
    expect(written.offsetX).toBe(12);
    expect(written.offsetY).toBe(20);
    expect(written.blankY).toBe(60);
    // 落盘：this 正确时 settings.update 内部 this.write 已把 Config.ui 补丁合并进 scope。
    expect(scopeValue.ui.offset, "settings.update 落盘（this.write 生效）").toEqual({ x: 12, y: 20, blankY: 60 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #389：settings 用户层持久化的 middleware 模式，apply 启动后同步到运行时——
// 保存路径（config POST middleware 分支）写 settings 用户层，而 apply 读组合层
// config.middleware（不含用户层覆盖）→ 重启后回退 project。此处 settings 注入
// 完成后 onChange 触发 syncMiddlewareFromSettings，把持久化值热切换生效。
it("#389：settings 持久化 middleware → apply 后运行时同步", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-mw389-"));
  // scope.get() 返回 settings 合并面：含用户层保存的 middleware: "all"（config 缺省 project）。
  let scopeValue = { ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } }, middleware: "all" };
  const settingsStub = {
    register(ns, schema, opts) {
      return { get: () => ({ ...scopeValue }), watch: () => {} };
    },
    async write(ns, patch) {
      scopeValue = { ...(scopeValue ?? {}), ...(patch ?? {}) };
    },
    update(ns, patch) {
      if (!this || typeof this.write !== "function") {
        throw new TypeError("settings.update 被以错误 this 调用");
      }
      return this.write(ns, patch);
    },
  };
  const sctx = { settings: settingsStub, effect: (fn) => { const d = fn(); return () => {}; } };
  const ctx = fakeCtx({
    inject: (keys, cb) => {
      if (Array.isArray(keys) && keys.includes("settings")) cb(sctx);
      return () => {};
    },
  });
  const localReq = (method, url, body) => ({
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  });
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    const configRoute = ctx.routes.find((route) => route.path === ROUTES.config);
    expect(configRoute, "config 路由已注册").toBeTruthy();
    const read = fakeRes();
    await configRoute.handler(localReq("GET", ROUTES.config), read);
    const body = JSON.parse(read.state.body);
    expect(body.middleware, "settings 持久化 middleware 启动后同步（#389 重启恢复）").toBe("all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("truncateText 短文本不截断", () => {
  expect(truncateText("短文本", 8192)).toBe("短文本");
});
it("truncateText 长文本截断并标注", () => {
  const text = "A".repeat(10000);
  const out = truncateText(text, 1024);
  expect(out).toMatch(/已截断/);
  expect(out).toMatch(/10000 字节/);
  expect(Buffer.byteLength(out, "utf8") <= 1024 + 128, "截断后含标注仍受控").toBeTruthy();
  expect(out.endsWith("）"), "标注完整").toBeTruthy();
});
it("truncateText 多字节安全（不产生替换符）", () => {
  const text = "中".repeat(5000);
  const out = truncateText(text, 1000);
  expect(!out.includes("\uFFFD"), "截断点不落在多字节字符中间").toBeTruthy();
});
it("composeCatalogEntries 数据源（配置优先 → 缓存摘要 → 仅名字）", () => {
  const supervisors = new Map([
    ["srv-a", { server: { description: "自定义描述 A" }, tools: [], toolMeta: new Map() }],
    ["srv-b", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
  ]);
  const cache = new Map([
    ["srv-b", { summary: "缓存摘要 B" }],
  ]);
  const entries = composeCatalogEntries(supervisors, 6, cache);
  expect(entries[0].text, "用户配置优先").toBe("自定义描述 A");
  expect(entries[1].text, "缓存摘要 fallback（无需用户配置）").toBe("缓存摘要 B");
  expect(entries[2].name, "无配置无缓存 → 条目按名称保留").toBe("srv-c");
  expect(Object.hasOwn(entries[2], "text"), "双缺省条目不含 text 属性（值断言防不了 text: undefined，必须查存在性）").toBe(false);
  // digest 稳定性：实时连接状态（tools/toolMeta）变化不影响目录 digest
  const connected = new Map([
    ["srv-a", { server: { description: "自定义描述 A" }, tools: ["t1"], toolMeta: new Map([["x", { description: "实时描述" }]]) }],
    ["srv-b", { server: { description: undefined }, tools: ["t1"], toolMeta: new Map([["x", { description: "实时描述" }]]) }],
    ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
  ]);
  expect(
    digestCatalogEntries(composeCatalogEntries(connected, 6, cache)),
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
  expect(summarizeToolDescriptions(meta1), "顺序变化摘要稳定").toBe(summarizeToolDescriptions(meta2));
  expect(summarizeToolDescriptions(new Map([["x", { description: "  " }]])), "全空描述无摘要").toBe(undefined);
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
  expect(tavilySummary.includes("Search the web"), "摘要含 search 语义（防 crawler 误导）").toBeTruthy();
  expect(tavilySummary.includes("research"), "摘要含 research 语义").toBeTruthy();
  expect(tavilySummary.startsWith("5 tools: "), "多工具前缀标注真实工具数").toBeTruthy();
});
it("recordCatalogTools 仅实质变化落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-catalog-"));
  const store = new McpStore(join(dir, "mcp.json"));
  const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
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
  const manager2 = new McpManager({ logger: { warn: () => {} } }, store);
  manager2.catalogCachePath = join(dir, "catalog.json");
  await manager2.loadCatalogCache();
  expect(manager2.catalogCache.get("srv")?.summary, "重启后缓存恢复").toBe("新描述");
  rmSync(dir, { recursive: true, force: true });
});
it("composeCatalogEntries 条目上限", () => {
  const supervisors = new Map();
  for (let i = 0; i < 10; i += 1) supervisors.set(`s${i}`, { server: { description: "d" }, tools: [], toolMeta: new Map() });
  expect(composeCatalogEntries(supervisors, 3).length).toBe(3);
});
it("digestCatalogEntries 只含服务器集合（描述变化不触发注入）", () => {
  const a = [{ name: "x", text: "d1" }];
  const b = [{ name: "x", text: "d2" }];
  const c = [{ name: "x", text: "d1" }, { name: "y", text: "d1" }];
  expect(digestCatalogEntries(a), "描述文本变化 digest 不变（不触发注入）").toBe(digestCatalogEntries(b));
  expect(digestCatalogEntries(a), "服务器集合变化 digest 变（触发替换）").not.toBe(digestCatalogEntries(c));
  // 顺序敏感（服务器顺序变化 = 集合变化）
  const reversed = [{ name: "y", text: "d1" }, { name: "x", text: "d1" }];
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
  expect(msg.source.kind).toBe("mcp-catalog");
  expect(msg.content[0].type).toBe("text");
  expect(msg.content[0].text).toMatch(/available_mcp_servers/);
  expect(msg.content[0].text).toMatch(/does not reflect active connection status/);
  expect(msg.content[0].text, "#228 目录文案引导经中间层调用").toMatch(/ws_mcp_search/);
  expect(msg.content[0].text).toMatch(/`code-graph`: 代码图谱/);
  expect(typeof msg.id === "string" && msg.id.length > 0).toBeTruthy();

  // 纯 global 条目 → 保持 mcp__ 直呼引导（不误导全局服务器走中间层检索）
  const onlyGlobal = renderMcpCatalogMessage([{ name: "ctx", scope: "global" }]);
  expect(onlyGlobal.content[0].text).toMatch(/mcp__<server>__<tool>/);
  expect(onlyGlobal.content[0].text).not.toMatch(/ws_mcp_search/);
  // P2-4：all 模式下纯 global 条目也引导经中间层（全局走中间层，不再 mcp__ 直呼）
  const onlyGlobalAll = renderMcpCatalogMessage([{ name: "ctx", scope: "global" }], "all");
  expect(onlyGlobalAll.content[0].text, "all 模式纯 global 引导经中间层").toMatch(/ws_mcp_search/);
  expect(onlyGlobalAll.content[0].text, "all 模式不再 mcp__ 直呼引导").not.toMatch(/mcp__<server>__<tool>/);

  // #192 AC-3：双缺省行仅渲染名字（无冒号描述），带描述条目渲染不变
  const mixed = renderMcpCatalogMessage([{ name: "bare-x" }, { name: "code-graph", text: "代码图谱" }]);
  expect(mixed.content[0].text, "双缺省行仅名字").toMatch(/^- `bare-x`$/m);
  expect(mixed.content[0].text).not.toMatch(/`bare-x`: /);
  expect(mixed.content[0].text, "带描述行保持").toMatch(/^- `code-graph`: 代码图谱$/m);
});
it("findCatalogMessage 定位既有目录", () => {
  const catalog = renderMcpCatalogMessage([{ name: "a", text: "b" }]);
  const messages = [{ id: "m1", role: "user", content: [] }, catalog, { id: "m2", role: "assistant", content: [] }];
  expect(findCatalogMessage(messages)?.id).toBe(catalog.id);
  expect(findCatalogMessage([{ id: "x", role: "user", content: [], source: { kind: "other" } }])).toBe(undefined);
});
it("buildToolDefinition：空描述条件拼接（L2）", () => {
  const client = { callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) };
  const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx", description: "演示服务器" });
  const def = buildToolDefinition(client, { name: "ping", description: "", inputSchema: {} }, server, { enhanceEmptyDescriptions: true });
  expect(def.description, "空描述拼接自定义描述").toBe("[演示服务器]");
  const defKeep = buildToolDefinition(client, { name: "ping", description: "原始描述", inputSchema: {} }, server, { enhanceEmptyDescriptions: true });
  expect(defKeep.description, "非空描述不动").toBe("原始描述");
  const defOff = buildToolDefinition(client, { name: "ping", description: "", inputSchema: {} }, server, { enhanceEmptyDescriptions: false });
  expect(defOff.description, "关闭增强不拼接").toBe("");
});
it("buildToolDefinition：超时下探与截断（L3）", async () => {
  let seenTimeout;
  const client = {
    callTool: async (_name, _args, opts) => {
      seenTimeout = opts.timeoutMs;
      return { content: [{ type: "text", text: "X".repeat(5000) }] };
    },
  };
  const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx" });
  expect(DEFAULT_TOOL_CALL_TIMEOUT_MS, "默认超时下探 15s").toBe(15_000);
  expect(server.toolCallTimeoutMs).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
  const def = buildToolDefinition(client, { name: "big", description: "d", inputSchema: {} }, server, { resultTruncateBytes: 1024 });
  const value = await def.execute({}, { signal: { aborted: false } });
  expect(seenTimeout, "execute 传递下探后的超时").toBe(15_000);
  const rendered = def.output.render({}, value);
  expect(rendered[0].text, "长结果截断标注").toMatch(/已截断/);
});

it("buildToolDefinition：#512 投影收敛（isError 抛错 + 无 content 兜底 + 白名单）", async () => {
  const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx" });
  // isError:true → throw，文案 = extractText(content)（占位符渲染）+ 截断链路。
  const errDef = buildToolDefinition(
    { callTool: async () => ({ content: [{ type: "text", text: "远端故障" }], isError: true, _meta: { t: 1 } }) },
    { name: "err", description: "d", inputSchema: {} },
    server,
  );
  await expect(() => errDef.execute({}, { signal: { aborted: false } }), "isError:true 抛错含远端文本").rejects.toThrow(/远端故障/);
  // isError:false → 白名单收敛：isError/_meta 不进返回值（additionalProperties:false 契约）。
  const okDef = buildToolDefinition(
    { callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false, _meta: { t: 1 } }) },
    { name: "ok", description: "d", inputSchema: {} },
    server,
  );
  const okValue = await okDef.execute({}, { signal: { aborted: false } });
  expect(Object.keys(okValue).sort(), "isError:false/_meta 不外泄，仅 content").toEqual(["content"]);
  expect(Object.hasOwn(okValue, "isError")).toBe(false);
  expect(Object.hasOwn(okValue, "_meta")).toBe(false);
  // 无 content → toolResult JSON 兜底；空对象 → "(no output)"。
  const trDef = buildToolDefinition(
    { callTool: async () => ({ toolResult: { ok: 1 } }) },
    { name: "tr", description: "d", inputSchema: {} },
    server,
  );
  const trValue = await trDef.execute({}, { signal: { aborted: false } });
  expect(trValue.content[0].text, "toolResult 形态 JSON 兜底").toBe('{"ok":1}');
  const emptyDef = buildToolDefinition(
    { callTool: async () => ({}) },
    { name: "empty", description: "d", inputSchema: {} },
    server,
  );
  const emptyValue = await emptyDef.execute({}, { signal: { aborted: false } });
  expect(emptyValue.content[0].text, "空对象兜底 (no output)").toBe("(no output)");
});


// ---------- pre-step 目录注入（history-based 去重，复刻官方 tool-skill 语义）

// 模拟 agent：session.snapshotEvents() 持久化 + surface 可见性（与真实 agent 同构；
// 0.1.2-rc.1 起 events getter 移除，fake 暴露方法形态）
function makeAgent() {
  const events = [];
  const session = {
    header: { cwd: "/tmp" },
    surface: { nodes: new Set() },
    snapshotEvents: () => events,
    append(type, data) {
      const seq = events.length;
      const event = { type, data, seq };
      events.push(event);
      if (type === "user/message") session.surface.nodes.add(seq);
      return event;
    },
  };
  return { session };
}

// 模拟一轮 pre-step：调用决策并把新增目录消息持久化进 events（agent-loop 行为）
function runStep(decision, messages, supervisors, cache, agent) {
  const result = resolveCatalogInjection(decision, messages, supervisors, 6, cache, agent);
  const known = new Set();
  for (const evt of agent.session.snapshotEvents()) {
    if (evt.type === "user/message" && evt.data?.source?.kind === "mcp-catalog") known.add(evt.data.id);
  }
  for (const msg of result.messages) {
    if (msg.source?.kind === "mcp-catalog" && !known.has(msg.id)) agent.session.append("user/message", msg);
  }
  return result;
}

it("resolveCatalogInjection：history-based 去重（核心：多轮不重复注入）", () => {
  const supervisors = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
  const agent = makeAgent();

  // 真实语义：decision.messages 只含本轮新消息（历史在 session.snapshotEvents()）
  let historyCount = 0;
  for (let round = 1; round <= 5; round += 1) {
    const decision = { kind: "enter", messages: [{ id: `user-${round}`, role: "user", content: [] }] };
    const result = runStep(decision, decision.messages, supervisors, undefined, agent);
    historyCount = agent.session.snapshotEvents().filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog").length;
    const inMessages = result.messages.filter((m) => m.source?.kind === "mcp-catalog").length;
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
  const base = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
  const agent = makeAgent();
  let messages = [{ id: "m1", role: "user", content: [] }];

  // 首次注入
  let result = runStep({ kind: "enter", messages: [...messages] }, messages, base, undefined, agent);
  messages = result.messages;
  const firstId = agent.session.snapshotEvents().find((e) => e.data?.source?.kind === "mcp-catalog").data.id;
  expect(firstId, "首次注入").toBeTruthy();

  // 描述变化（集合不变）→ 不注入
  const descChanged = new Map([["code-graph", { server: { description: "新描述" }, tools: [], toolMeta: new Map() }]]);
  result = runStep({ kind: "enter", messages: [...messages, { id: "u2", role: "user", content: [] }] }, messages, descChanged, undefined, agent);
  expect(agent.session.snapshotEvents().filter((e) => e.data?.source?.kind === "mcp-catalog").length, "描述变化不注入").toBe(1);

  // 集合变化（新增服务器）→ 注入"更新"消息（历史 1 + 更新 1，声明作废旧目录）
  const added = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
    ["playwright", { server: { description: "浏览器自动化" }, tools: [], toolMeta: new Map() }],
  ]);
  result = runStep({ kind: "enter", messages: [...messages, { id: "u3", role: "user", content: [] }] }, messages, added, undefined, agent);
  const afterAdd = agent.session.snapshotEvents().filter((e) => e.data?.source?.kind === "mcp-catalog");
  expect(afterAdd.length, "集合变化注入更新消息（历史目录无法删除，新消息声明作废）").toBe(2);
  expect(afterAdd[1].data.content[0].text).toMatch(/replaces all previous available_mcp_servers/);
  expect(afterAdd[1].data.content[0].text).toMatch(/playwright/);

  // 更新后同集合不再注入
  result = runStep({ kind: "enter", messages: [...messages, { id: "u4", role: "user", content: [] }] }, messages, added, undefined, agent);
  expect(agent.session.snapshotEvents().filter((e) => e.data?.source?.kind === "mcp-catalog").length, "更新后不再注入").toBe(2);
});

it("resolveCatalogInjection：compaction 后重建 + 门控 + reject", () => {
  const supervisors = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
  const agent = makeAgent();
  let messages = [{ id: "m1", role: "user", content: [] }];
  let result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
  messages = result.messages;
  expect(agent.session.snapshotEvents().filter((e) => e.data?.source?.kind === "mcp-catalog").length, "首次注入").toBe(1);

  // compaction 模拟：surface 清空（旧目录不可见）→ 重新注入
  agent.session.surface.nodes.clear();
  result = runStep({ kind: "enter", messages: [{ id: "m1", role: "user", content: [] }] }, messages, supervisors, undefined, agent);
  const afterCompact = agent.session.snapshotEvents().filter((e) => e.data?.source?.kind === "mcp-catalog");
  expect(afterCompact.length >= 1, "compaction 后按可见性重建").toBeTruthy();
  expect(result.messages.filter((m) => m.source?.kind === "mcp-catalog").length).toBe(1);

  // 门控：从未发布且无服务器 → 不注入
  const agent2 = makeAgent();
  const decisionEmpty = resolveCatalogInjection({ kind: "enter", messages: [{ id: "x", role: "user", content: [] }] }, [], new Map(), 6, undefined, agent2);
  expect(decisionEmpty.messages.length, "无服务器不注入").toBe(1);

  // reject 不处理
  const rejected = resolveCatalogInjection({ kind: "reject" }, [], supervisors, 6, undefined, agent2);
  expect(rejected.kind).toBe("reject");
});

// ---------- issue #192：双缺省条目不得产出 text: undefined ----------

it("composeCatalogEntries 双缺省条目干净可序列化（#192 AC-1/AC-2）", () => {
  const supervisors = new Map([
    ["bare-a", { server: { description: "" }, tools: [], toolMeta: new Map() }],
    ["bare-b", { server: {}, tools: [], toolMeta: new Map() }],
    ["with-desc", { server: { description: "有描述" }, tools: [], toolMeta: new Map() }],
  ]);
  const entries = composeCatalogEntries(supervisors, 6, undefined);
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
    expect(
      rendered.source.entries.map((e) => Object.hasOwn(e, "text")).join(","),
      "source.entries 全部干净",
    ).toBe("false,false,true");
  }
});

it("双缺省服务器目录消息可 append 为 user/message 且去重（#192 AC-4）", () => {
  const supervisors = new Map([["bare-only", { server: { description: "" }, tools: [], toolMeta: new Map() }]]);
  const agent = makeAgent();
  let messages = [{ id: "m1", role: "user", content: [] }];
  let result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
  messages = result.messages;
  const catalogEvents = agent.session.snapshotEvents().filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog");
  expect(catalogEvents.length, "首轮注入成功（append 为 user/message 未被拒绝）").toBe(1);
  const appended = catalogEvents[0].data;
  expect(Object.hasOwn(appended.source.entries[0], "text"), "append 后事件载荷仍无 text 属性").toBe(false);
  expect(() => JSON.stringify(appended), "事件载荷可 JSON 序列化（dsh-session 序列化校验等价物）").not.toThrow();
  expect(JSON.parse(JSON.stringify(appended)), "往返深度相等").toEqual(appended);

  // digest 去重语义不变：同集合再次 pre-step 不重复注入
  result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
  expect(
    agent.session.snapshotEvents().filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog").length,
    "次轮不重复注入（digest 去重不变）",
  ).toBe(1);
});

// ---------- SDK 端到端（issue #11 PoC 契约不漂移证据：真实 stdio 连接 /
// initialize 版本协商 / 工具注册 / callTool / 断线自动重连，全程无网络）。

describe("SDK 端到端连接（连接/工具注册/callTool/断线重连）", () => {
  let dir, serverScript, registered, supervisor;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-sdk-"));
    serverScript = join(dir, "mini-mcp-server.mjs");
    writeFileSync(
      serverScript,
      [
        'import { createInterface } from "node:readline";',
        'const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        "  let msg;",
        "  try { msg = JSON.parse(line); } catch { return; }",
        '  if (msg.method === "initialize") {',
        '    send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.0.1" } } });',
        '  } else if (msg.method === "tools/list") {',
        "    send({ id: msg.id, result: { tools: [{ name: \"echo\", description: \"echo back\", inputSchema: { type: \"object\", properties: { text: { type: \"string\" } } } }] } });",
        '  } else if (msg.method === "tools/call") {',
        "    send({ id: msg.id, result: { content: [{ type: \"text\", text: String(msg.params?.arguments?.text ?? \"\") }] } });",
        "  } else if (msg.id !== undefined) {",
        '    send({ id: msg.id, error: { code: -32601, message: "method not found" } });',
        "  }",
        "});",
      ].join("\n"),
    );

    registered = [];
    supervisor = new ConnectionSupervisor(
      {
        ctx: { tools: { register: (definition) => { registered.push(definition); return () => {}; } } },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        enhancement: {},
        emitStatus() {},
        recordCatalogTools: async () => {},
      },
      normalizeServer({
        name: "mini",
        transport: "stdio",
        command: process.execPath,
        args: [serverScript],
        reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 5 },
      }),
    );
  });

  afterAll(async () => {
    await supervisor.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("connect → SDK 版本协商 + 工具注册", async () => {
    await supervisor.connect();
    expect(supervisor.status).toBe("connected");
    expect(supervisor.tools).toEqual(["mcp__mini__echo"]);
    expect(registered.length).toBe(1);
    expect(registered[0].name).toBe("mcp__mini__echo");
  });

  it("工具 execute 全链路走 SDK callTool", async () => {
    const value = await registered[0].execute({ text: "hello sdk" }, { signal: undefined });
    expect(value.content).toEqual([{ type: "text", text: "hello sdk" }]);
    expect(value.structuredContent).toBe(undefined);
  });

  it("子进程被杀 → 有界退避重连 → 工具重新注册", async () => {
    const oldPid = supervisor.transport.sdk.pid;
    expect(oldPid > 0).toBeTruthy();
    process.kill(oldPid, "SIGTERM");
    // 新代际 transport 建立且恢复 connected（旧 pid 不复用即证明发生过重连）。
    await pollUntil("reconnected with new generation", () =>
      supervisor.status === "connected" &&
      supervisor.transport !== undefined &&
      supervisor.transport.sdk.pid !== undefined &&
      supervisor.transport.sdk.pid !== oldPid &&
      supervisor.tools.length === 1,
      { timeoutMs: 10_000 },
    );
    expect(registered.length >= 2, "重连后工具重新注册").toBeTruthy();
    const value = await registered.at(-1).execute({ text: "after reconnect" }, { signal: undefined });
    expect(value.content[0].text).toBe("after reconnect");
  });
});


// ---- 核心化 service（#329 阶段1）：runtimeRegistry / registerServer / unregisterServer ----
// 用 enabled:false 的服务器（不连接、不 spawn 子进程，避免重连悬挂）验证登记语义。

describe("核心化 service（#329 阶段1）：runtimeRegistry / registerServer / unregisterServer", () => {
  let dir, store, manager;
  const quiet = () => ({ transport: "stdio", command: "echo", args: ["ok"], enabled: false });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-service-"));
    store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
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

  it("dispose() 清空全部 supervisor（含 runtime）", async () => {
    await manager.registerServer({ name: "svc-b", ...quiet() });
    expect(manager.runtimeRegistry.has("svc-b")).toBeTruthy();
    await manager.dispose();
    expect(manager.supervisors.size, "dispose 清空全部 supervisor").toBe(0);
  });

  it("all 模式 reconcile 不杀 runtime supervisor（QA 复审回归）", async () => {
    manager.middlewareMode = "all";
    await manager.registerServer({ name: "svc-all", transport: "stdio", command: "echo", args: ["x"], enabled: false });
    manager.reconcileServers();
    expect(manager.runtimeRegistry.has("svc-all"), "all 模式 runtime 条目保留").toBeTruthy();
    manager.middlewareMode = "off";
  });

  it("summary 并入 runtime 条目（查询面可见 / disabled 工具列表为空）", async () => {
    await manager.registerServer({ name: "svc-q", ...quiet() });
    const sum = manager.summary();
    const qEntry = (sum.servers ?? []).find((s) => s.name === "svc-q");
    expect(qEntry !== undefined, "summary 含 runtime 条目（查询面可见）").toBeTruthy();
    expect(qEntry.scope, "runtime 条目 scope 为 global").toBe("global");
    expect(qEntry.status, "enabled:false → disabled 状态").toBe("disabled");
    expect(qEntry.tools, "disabled 服务器工具列表为空").toEqual([]);
  });
});


// ---- #362 补充 4：registerServer.toolDefinitions（调用方封装定义注册）----
// 带 toolDefinitions → 该服务器工具全部用封装定义注册（execute 来自调用方，
// 命名仍按 publicToolName mcp__ 前缀）；不带 → 现状回归（远端 schema + 通用
// callTool）。工具级禁用/可见性/能力目录按服务器+工具名判定照常生效。

describe("#362 补充 4：registerServer.toolDefinitions（调用方封装定义注册）", () => {
  let dir, store, manager, wrappedExecCalls, wrapped, registered, sup, plainRegistered, supPlain, plainExecCalls, plainClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-wrapped-"));
    store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);

    // 封装定义（裸名；模拟 dsh-codegraph 侧 codegraph_explore 形态）。
    wrappedExecCalls = [];
    wrapped = [
      {
        name: "codegraph_explore",
        description: "封装定义：查询前强制 sync + projectPath（#362 补充 4）",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        output: {
          schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          render(_args, value) {
            return [{ type: "text", text: value && typeof value === "object" && "text" in value ? String(value.text) : "" }];
          },
        },
        async execute(args) {
          wrappedExecCalls.push(args);
          return { text: `wrapped:${args && typeof args === "object" ? String(args.query ?? "") : ""}` };
        },
      },
      {
        name: "codegraph_status",
        description: "封装定义：状态查询",
        parameters: { type: "object", properties: {} },
        output: {
          schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          render(_args, value) {
            return [{ type: "text", text: value && typeof value === "object" && "text" in value ? String(value.text) : "" }];
          },
        },
        execute: async () => ({ text: "ok" }),
      },
    ];
    registered = [];
    sup = new ConnectionSupervisor(
      {
        ctx: { tools: { register: (definition) => { registered.push(definition); return () => {}; } } },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        enhancement: {},
        emitStatus() {},
        recordCatalogTools: async () => {},
      },
      normalizeServer({ name: "codegraph", transport: "stdio", command: "true" }),
    );
    sup.server.toolDefinitions = wrapped;
    // 挂入 manager.supervisors：summarize 的禁用投影按 supervisor 工具列表判定。
    manager.supervisors.set("codegraph", sup);

    // 不带 toolDefinitions 的对照代际（现状回归）。
    plainRegistered = [];
    supPlain = new ConnectionSupervisor(
      {
        ctx: { tools: { register: (definition) => { plainRegistered.push(definition); return () => {}; } } },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        enhancement: {},
        emitStatus() {},
        recordCatalogTools: async () => {},
      },
      normalizeServer({ name: "mini", transport: "stdio", command: "true" }),
    );
    plainExecCalls = [];
    plainClient = {
      listTools: async () => ({ tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }),
      callTool: async (rawName, args) => {
        plainExecCalls.push([rawName, args]);
        return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] };
      },
    };
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("toolDefinitions：封装定义注册（execute 来自调用方，mcp__ 前缀命名）", async () => {
    // 封装路径不触达远端 schema 投影：伪造 listTools 抛错证明未走远端路径。
    await sup.syncTools({ listTools: async () => { throw new Error("must not reach remote schema"); } }, true);
    expect(sup.tools, "公共名排序").toEqual(["mcp__codegraph__codegraph_explore", "mcp__codegraph__codegraph_status"]);
    expect(registered.length).toBe(2);
    expect(registered[0].name, "命名仍按 publicToolName（mcp__ 前缀）").toBe("mcp__codegraph__codegraph_explore");
    expect(registered[0].description, "自定义 description 被采用").toBe("封装定义：查询前强制 sync + projectPath（#362 补充 4）");
    const value = await registered[0].execute({ query: "X 被谁调用" }, { signal: undefined });
    expect(value.text, "execute 来自封装定义").toBe("wrapped:X 被谁调用");
    expect(wrappedExecCalls.length).toBe(1);
  });

  it("封装工具按服务器+裸名禁用命中（既有 isToolDenied 机制）/ 未禁用放行", async () => {
    // 工具级禁用对封装工具照常生效（#362 既有机制：isToolDenied 按服务器+工具
    // 裸名判定；封装工具注册名仍是 mcp__ 前缀，guard 反解裸名查表与普通工具同路径）。
    const { isToolDenied, fullServerName, parseDisabledTools, MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
    const denyMap = parseDisabledTools({ "@global": { codegraph: ["codegraph_explore"] } });
    expect(
      isToolDenied(denyMap, undefined, fullServerName(MIDDLEWARE_GLOBAL_ROOT, "codegraph"), "codegraph_explore"),
      "封装工具按服务器+裸名禁用命中（既有 isToolDenied 机制）",
    ).toBe(true);
    expect(
      isToolDenied(denyMap, undefined, fullServerName(MIDDLEWARE_GLOBAL_ROOT, "codegraph"), "codegraph_status"),
      "未禁用封装工具放行",
    ).toBe(false);
  });

  it("summary 工具列表为裸名（#382 剥前缀口径）", () => {
    // 可见性/能力目录：summary 工具列表为裸名（#382 F4 展示口径统一：剥
    // mcp__ 前缀，与中间层投影分支/禁用表键/guard 反解口径一致）。
    const sum = manager.summarize(sup.server, SCOPE_GLOBAL);
    expect(sum.tools, "summary 工具列表为裸名（#382 剥前缀口径）").toEqual(["codegraph_explore", "codegraph_status"]);
  });

  it("不带 toolDefinitions → 现状回归（远端 schema + 通用 callTool）", async () => {
    await supPlain.syncTools(plainClient, true);
    expect(supPlain.tools).toEqual(["mcp__mini__echo"]);
    expect(plainRegistered.length).toBe(1);
    // 通用 callTool 路径：execute 经 client.callTool 转发远端。
    const value = await plainRegistered[0].execute({ text: "hi" }, { signal: undefined });
    expect(value.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(plainExecCalls, "通用 callTool 转发远端").toEqual([["echo", { text: "hi" }]]);
  });
});

