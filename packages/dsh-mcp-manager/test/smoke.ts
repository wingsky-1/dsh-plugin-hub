// @ts-nocheck
// dsh-mcp-manager 冒烟测试 —— 无外部依赖、不发起真实网络连接。
//
// 覆盖：
//   - 契约导出（name / inject / ROUTES）
//   - normalizeServer 校验（名称模式、传输必填、http url 合法性）
//   - fromClaudeEntry / parseClaudeJson（mcpServers JSON 兼容映射）
//   - publicToolName 确定性、expandEnv、parseSsePayload
//   - McpStore 落盘/读回（临时目录）
//   - makeRoutes：GET 列表 / POST 添加 / PATCH 更新 / DELETE 删除 /
//     import/json 导入
//   - SSE 半开防护（#268）：服务端 30s data ping 心跳 + 客户端 60s
//     watchdog / 回前台强制重建（详见 unit-routes-sse 与下方产物断言）
//   - apply：enabled:false 时不注册路由与提示词
//
// 运行：node dsh-mcp-manager/test/smoke.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { pollUntil } from "./helpers.ts";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
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
} from "../lib/index.js";

// 结构化单元测试（#82 批次 1：清零未覆盖 CRAP 超阈热点）
import "./unit-shared.test.ts";
import "./unit-manager.test.ts";
import "./unit-apply.test.ts";
import "./unit-hotspot.test.ts";
// 中间层（#228：ws_mcp_search / ws_mcp_call + 连接池 + 目录 + 策略）
import "./unit-middleware.test.ts";
// 管理器方法面 / SSE+health 路由边界（#228 打回修复：装载断链自 PR#234 起既存，
// 缺失期间这两个文件的用例只在 mutation 跑——smoke 门禁从未执行它们）
import "./unit-manager2.test.ts";
import "./unit-routes-sse.test.ts";

const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  FAIL ${label}\n       ${error.message}`);
  }
};

const checkAsync = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  FAIL ${label}\n       ${error.message}`);
  }
};

/** 伪造 cordis ctx：只实现 apply 用到的面。 */
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

const main = async () => {
  console.log("契约: name / inject / ROUTES");
  check("name = mcp-manager", () => assert.equal(name, "mcp-manager"));
  check("inject 包含 tools / webServer / systemPrompt", () => {
    assert.deepEqual(inject, ["tools", "webServer", "systemPrompt"]);
  });
  check("ROUTES 关键路径存在", () => {
    assert.equal(ROUTES.servers, "/api/dsh-mcp/servers");
    assert.equal(ROUTES.importJson, "/api/dsh-mcp/import/json");
  });
  check("client bundle 的 /api/ 路径与 host ROUTES 完全一致（防漂移）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    const clientPaths = [...clientSrc.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]).sort();
    const hostPaths = [...new Set(Object.values(ROUTES))].sort();
    assert.deepEqual(clientPaths, hostPaths, `两端路由漂移：client=${clientPaths.join(",")} host=${hostPaths.join(",")}`);
  });
  check("client source contract（load id/IIFE/use strict/load once）", () => assertClientSourceContract(pkgDir));
  check("client product contract（执行断言：arrive 可解析/apply/inject）", () => assertClientProductContract(pkgDir));
  await checkAsync("中间层工具注册（ws_mcp_search / ws_mcp_call / ws_mcp_list / ws_mcp_detail + 路由一致性）", async () => {
    const { registerMiddlewareTools, McpMiddleware, fullServerName, parseFullServerName } = await import("../lib/index.js");
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
    assert.deepEqual(names, ["ws_mcp_call", "ws_mcp_detail", "ws_mcp_list", "ws_mcp_search"], "四个中间层工具注册");
    assert.match(registered.find((d) => d.name === "ws_mcp_search").description, /ws_mcp_call/, "search 描述引导先搜后调");
    assert.match(registered.find((d) => d.name === "ws_mcp_search").description, /ws_mcp_list/, "search 描述互引完整盘点");
    assert.match(registered.find((d) => d.name === "ws_mcp_call").description, /ws_mcp_detail/, "call 描述互引参数 schema 查询");
    assert.match(registered.find((d) => d.name === "ws_mcp_list").description, /ws_mcp_detail/, "list 描述互引 detail");
    assert.match(registered.find((d) => d.name === "ws_mcp_list").description, /不返回 inputSchema/, "list 描述写明不做什么");
    assert.match(registered.find((d) => d.name === "ws_mcp_detail").description, /inputSchema/, "detail 描述说明完整 schema");
    assert.match(registered.find((d) => d.name === "ws_mcp_detail").description, /不做关键词检索/, "detail 描述写明不做什么");
    // Anthropic 规范：parameters 每个字段都带 description。
    for (const def of registered) {
      const props = def.parameters?.properties ?? {};
      for (const [key, prop] of Object.entries(props)) {
        assert.ok(typeof prop.description === "string" && prop.description !== "", `参数 ${def.name}.${key} 带 description`);
      }
    }
    // search 输出 schema 含 truncated 字段。
    const searchSchemaProps = registered.find((d) => d.name === "ws_mcp_search").output.schema.properties;
    assert.equal(typeof searchSchemaProps.truncated, "object", "search 输出含 truncated 字段");
    // 路由：agent-less → 显式失败
    const searchDef = registered.find((d) => d.name === "ws_mcp_search");
    const callDef = registered.find((d) => d.name === "ws_mcp_call");
    const listDef = registered.find((d) => d.name === "ws_mcp_list");
    const detailDef = registered.find((d) => d.name === "ws_mcp_detail");
    // search 输出补 truncated 字段：空目录 → false。
    const emptySearch = await searchDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } });
    assert.equal(emptySearch.truncated, false, "空目录 truncated=false");
    assert.deepEqual(emptySearch.unavailable, []);
    await assert.rejects(() => searchDef.execute({}, { agent: undefined }), /无法确定工作空间/);
    await assert.rejects(() => listDef.execute({}, { agent: undefined }), /无法确定工作空间/);
    await assert.rejects(() => detailDef.execute({}, { agent: undefined }), /无法确定工作空间/);
    // 路由：有 agent 但 cwd 无项目 → 显式失败（ws_mcp_call 缺 server 参数先报必填）
    await assert.rejects(() => callDef.execute({}, { agent: { session: { header: { cwd: "/other" } } } }), /无法确定工作空间|server 与 tool 均为必填/);
    // 空返回提示：无项目配置 → list 返回 message
    const emptyList = await listDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } });
    assert.equal(emptyList.totalServers, 0);
    assert.equal(emptyList.totalTools, 0);
    assert.match(emptyList.message, /没有可用 MCP 服务器|没有项目级 MCP 配置/, "空返回明确提示");
    // detail 必填校验
    await assert.rejects(() => detailDef.execute({}, { agent: { session: { header: { cwd: "/proj" } } } }), /server 与 tool 均为必填/);
    // server 全名解析往返
    const full = fullServerName("/proj", "ctx");
    assert.deepEqual(parseFullServerName(full), { root: "/proj", server: "ctx" });
    // @global 单 @ / 双 @ 等价（隔离验证 P0：smoke 双 @ 掩盖单 @ 被拒）
    const { MIDDLEWARE_GLOBAL_ROOT } = await import("../lib/index.js");
    assert.deepEqual(parseFullServerName("@global/gctx"), { root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" }, "单 @ @global/ 归一化为 @global");
    assert.deepEqual(parseFullServerName("@@global/gctx"), { root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" }, "双 @ @@global/ 归一化为 @global");
    assert.deepEqual(parseFullServerName(fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), { root: MIDDLEWARE_GLOBAL_ROOT, server: "gctx" }, "fullServerName(@global) 往返一致");
    dispose();
  });
  await checkAsync("search 早退分支（unit undefined）返回 truncated=false（P1-1）", async () => {
    const { registerMiddlewareTools, McpMiddleware } = await import("../lib/index.js");
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
    assert.deepEqual(out, { results: [], unavailable: [], truncated: false }, "早退分支补 truncated=false（output.schema required）");
    dispose();
  });
  await checkAsync("中间层 all 模式：@global 覆盖（list/search 可见全局，call 放行 @global）", async () => {
    const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } = await import("../lib/index.js");
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
    assert.deepEqual(names, ["ws_mcp_call", "ws_mcp_detail", "ws_mcp_list", "ws_mcp_search"], "all 模式注册四个工具");
    const searchDef = registered.find((d) => d.name === "ws_mcp_search");
    const callDef = registered.find((d) => d.name === "ws_mcp_call");
    const listDef = registered.find((d) => d.name === "ws_mcp_list");
    const detailDef = registered.find((d) => d.name === "ws_mcp_detail");
    const agent = { session: { header: { cwd: "/proj" } } };
    // list：项目 root + @global 合并可见
    const listed = await listDef.execute({}, { agent });
    assert.ok(listed.servers.some((s) => s.server === fullServerName("/proj", "ctx")), "list 含项目服务器");
    assert.ok(listed.servers.some((s) => s.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "all 模式 list 含 @global 服务器");
    assert.equal(listed.mode, "all");
    // search：合并查询命中 @global 工具
    const found = await searchDef.execute({ query: "全局" }, { agent });
    assert.ok(found.results.some((hit) => hit.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "all 模式 search 含 @global 命中");
    assert.equal(found.truncated, false, "all 模式 search 未达 limit → truncated=false");
    // detail：@global 可查
    const detail = await detailDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent });
    assert.equal(detail.server, fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"));
    assert.equal(detail.tool, "use_g");
    // call：all 模式放行 @global root（预置 client 无法调用——此处断言路由放行后
    // 落到连接/调用错误而非「不属于当前工作空间」路由拒绝）。
    await assert.rejects(
      () => callDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent }),
      /未连接|未就绪|连接失败|已禁用/,
    );
    // call：非当前 root 的项目 root 仍拒绝（防跨空间串台）。
    await assert.rejects(
      () => callDef.execute({ server: fullServerName("/other", "ctx"), tool: "use_ctx" }, { agent }),
      /不属于当前工作空间/,
    );
    // P1-2：all 模式无项目 cwd（root 本身为 @global）→ visibleRoots 去重不翻倍。
    const gAgent = { session: { header: { cwd: "/no-project" } } };
    const listedGlobalOnly = await listDef.execute({}, { agent: gAgent });
    const globalNames = listedGlobalOnly.servers.map((s) => s.server);
    assert.equal(listedGlobalOnly.totalServers, 1, "@global 去重：totalServers 不翻倍");
    assert.equal(globalNames.filter((n) => n === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")).length, 1, "gctx 只出现一次");
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
    assert.ok(freshEntry !== undefined, "@global 首次触达等待 in-flight 后可见");
    assert.equal(freshEntry.tools.length, 1, "发现完成的工具列出");
    const foundAfterWait = await searchDef.execute({ query: "发现完成" }, { agent: gAgent });
    assert.ok(foundAfterWait.results.some((hit) => hit.server === fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx")), "search 等待 in-flight 后命中 @global");
    dispose();
  });
  await checkAsync("#362 A2：project 模式 detail/call 传全局级服务器 → 引导 mcp__ 直呼（不再谎报不属于工作空间）", async () => {
    const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT } = await import("../lib/index.js");
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
    await assert.rejects(
      () => detailDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent }),
      /全局级|mcp__gctx__/,
      "project 模式 detail 全局服务器给出直呼引导",
    );
    // call 全局服务器 → 同样引导。
    await assert.rejects(
      () => callDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "gctx"), tool: "use_g" }, { agent }),
      /全局级|mcp__gctx__/,
      "project 模式 call 全局服务器给出直呼引导",
    );
    // 非 global 其他 root 仍硬拒绝（防跨空间串台，不回归）。
    await assert.rejects(
      () => detailDef.execute({ server: fullServerName("/other", "ctx"), tool: "use_ctx" }, { agent }),
      /不属于当前工作空间/,
    );
    // project 模式未知 @global 服务器（非全局级）→ 硬拒绝（防经 @global 路由绕过）。
    await assert.rejects(
      () => detailDef.execute({ server: fullServerName(MIDDLEWARE_GLOBAL_ROOT, "ghost"), tool: "x" }, { agent }),
      /不属于当前工作空间/,
      "project 模式未知 @global 服务器拒绝",
    );
    dispose();
  });
  await checkAsync("#362 isGlobalServer 双源：runtime 注册的 codegraph 判全局（P1 修正）", async () => {
    const { McpManager, McpStore, MIDDLEWARE_GLOBAL_ROOT } = await import("../lib/index.js");
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-global-"));
    try {
      const store = new McpStore(join(dir, "mcp.json"));
      store.data = { version: 1, servers: [] };
      const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
      // runtime 注册（不落 store）→ isGlobalServer 必须返回 true。
      await manager.registerServer({ name: "codegraph", transport: "stdio", command: "echo", args: ["x"], enabled: false });
      assert.equal(manager.isGlobalServer("codegraph"), true, "runtime 注册判全局（双源）");
      // store 持久化条目 → 全局。
      store.upsert({ name: "ctx", transport: "stdio", command: "echo", enabled: false });
      assert.equal(manager.isGlobalServer("ctx"), true, "store 条目判全局");
      assert.equal(manager.isGlobalServer("ghost"), false, "未注册不判全局");
      await manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await checkAsync("#362 A1：ws_mcp_list 带 serverFilter 过滤 0 命中 → message 可归因（不谎报未配置）", async () => {
    const { registerMiddlewareTools, McpMiddleware, fullServerName, parseFullServerName } = await import("../lib/index.js");
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
    assert.equal(out.totalServers, 0);
    assert.match(out.message, /没有匹配 server="nope" 的项目级服务器/, "A1：message 归因到过滤条件");
    assert.match(out.message, /可见项目级服务器：ctx/, "A1：列出可见项目级服务器");
    assert.match(out.message, /全局级服务器不在此列出/, "A1：提示全局级不列出");
    // 不带过滤的真实空目录 → 原有空返回提示（不回归）。
    const out2 = await listDef.execute({}, { agent });
    assert.equal(out2.totalServers, 1, "不带过滤正常列出");
    dispose();
  });
  await checkAsync("#362 P0-1：工具级禁用三入口一致（callTool / pre-execute guard / mcp__ 直呼）", async () => {
    const { registerMiddlewareTools, McpMiddleware, fullServerName, MIDDLEWARE_GLOBAL_ROOT, parseDisabledTools, isToolDenied, toolDisabledReason } = await import("../lib/index.js");
    // 1) isToolDenied 纯函数：项目 root 命中 + @global 回落 + 哈希超长名不误禁。
    const map = parseDisabledTools({ "/proj": { ctx: ["use_ctx"] }, "@global": { gctx: ["use_g"] } });
    assert.equal(isToolDenied(map, undefined, fullServerName("/proj", "ctx"), "use_ctx"), true, "项目 root 记录命中");
    assert.equal(isToolDenied(map, undefined, fullServerName("/proj", "ctx"), "other"), false, "未禁用工具放行");
    assert.equal(isToolDenied(map, undefined, fullServerName("/proj", "gctx"), "use_g"), true, "@global 共享记录回落命中");
    assert.equal(isToolDenied(map, undefined, fullServerName("@global", "gctx"), "use_g"), true, "@global root 自身记录命中");
    assert.equal(isToolDenied(map, undefined, "mcp__ctx__use_ctx_hash123456", "x"), false, "哈希超长名不可逆 → 不误禁");
    assert.equal(isToolDenied(new Map(), { denyTools: { ctx: ["evil"] } }, fullServerName("/proj", "ctx"), "evil"), true, "策略 deny 仍生效");
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
    assert.ok(typeof guard === "function", "pre-execute guard 已注册");
    const deny = await guard({ name: "mcp__ctx__use_ctx", agent: { session: { header: { cwd: "/proj" } } } }, async () => ({ kind: "allow" }));
    assert.equal(deny.kind, "deny", "mcp__ 直呼被禁用表 deny");
    assert.match(deny.reason, /已被用户在「MCP」浮窗禁用/, "拒绝原因含禁用语义声明");
    const allow = await guard({ name: "mcp__ctx__other", agent: { session: { header: { cwd: "/proj" } } } }, async () => ({ kind: "allow" }));
    assert.equal(allow.kind, "allow", "未禁用工具放行");
    // agent-less → 按最宽可见范围放行（@global 记录仍生效）。
    const gDeny = await guard({ name: "mcp__gctx__use_g" }, async () => ({ kind: "allow" }));
    assert.equal(gDeny.kind, "deny", "agent-less 时 @global 共享记录仍 deny");
    // 超长哈希名（含非法字符被替换）→ 不误禁。
    const hashed = await guard({ name: "mcp__ctx__use_ctx_0123456789ab" }, async () => ({ kind: "allow" }));
    assert.equal(hashed.kind, "allow", "哈希后缀名按未知 server 放行");
    // ws_mcp_call guard：禁用命中 → deny。
    const callDeny = await guard({ name: "ws_mcp_call", arguments: { server: fullServerName("/proj", "ctx"), tool: "use_ctx" } }, async () => ({ kind: "allow" }));
    assert.equal(callDeny.kind, "deny", "ws_mcp_call guard 查禁用表");
    assert.equal(toolDisabledReason(fullServerName("/proj", "ctx"), "use_ctx").includes("mcp__ 前缀"), true, "禁用原因声明只作用于 mcp__ 前缀");
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
    await assert.rejects(
      () => mw.callTool(fullServerName("/proj", "ctx"), "use_ctx", {}, undefined),
      /已被用户在「MCP」浮窗禁用/,
      "callTool 先查禁用表（三入口一致）",
    );
    // 未禁用工具正常放行到调用。
    const okValue = await mw.callTool(fullServerName("/proj", "ctx"), "other", {}, undefined);
    assert.deepEqual(okValue.content, [], "未禁用工具正常调用");
    dispose();
  });
  await checkAsync("#362 P1：disabledTools 持久化（合并式写盘 + 重启保留）", async () => {
    const { McpManager, McpStore, loadDisabledTools, saveDisabledTools, parseDisabledTools, MIDDLEWARE_GLOBAL_ROOT } = await import("../lib/index.js");
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
      assert.equal(reloaded.get("/proj")?.get("ctx")?.has("use_ctx"), true, "/proj 记录落盘");
      assert.equal(reloaded.get("@global")?.get("gctx")?.has("use_g"), true, "@global 记录落盘");
      assert.equal(reloaded.get("/other")?.get("s2")?.has("t2"), true, "既有 /other 记录保留（合并式，绝不整表覆盖）");
      // 解除禁用 → 记录清除；其他记录保留。
      await manager.setToolDisabled("/proj", "ctx", "use_ctx", false);
      const after = await loadDisabledTools(file);
      const projTools = after.get("/proj")?.get("ctx");
      assert.equal(projTools === undefined || !projTools.has("use_ctx"), true, "解除后记录清除");
      assert.equal(after.get("/other")?.get("s2")?.has("t2"), true, "解除不影响其他记录");
      await manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  check("client 注册 settings.plugin.item 卡（id/key = 宿主命名空间 dsh-mcp-manager）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    assert.ok(clientSrc.includes("settings.plugin.item"), "settings.plugin.item 卡已注册");
    assert.ok(clientSrc.includes("dsh-mcp-manager"), "卡片 key/id 引用宿主命名空间 dsh-mcp-manager");
  });
  check("#362 客户端：工具级禁用 checkbox + scope 分组 + project 全局提示 + middleware 下拉", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    // 工具 checkbox 经 tool-disable API 持久化。
    assert.ok(clientSrc.includes("tool-disable"), "客户端含 tool-disable API 调用");
    assert.ok(clientSrc.includes('type: "checkbox"'), "工具开关为 checkbox");
    assert.ok(clientSrc.includes("dm-float-tools"), "浮窗折叠式工具清单存在");
    assert.ok(clientSrc.includes("切 all 模式可管理全局工具"), "project 模式全局组提示文案");
    assert.ok(clientSrc.includes("dm-set-middleware"), "设置页中间层模式下拉存在");
    // 浮窗与管理面板均按 scope 分组。
    assert.ok(clientSrc.includes("dm-float-group-title"), "浮窗 scope 分组标题存在");
    assert.ok(clientSrc.includes("项目级") && clientSrc.includes("全局"), "scope 分组文案存在");
    // #401 勾选 = 禁用：勾选态自绘为红色 ×（非原生蓝色 ✓），工具名同步标红。
    assert.ok(clientSrc.includes("appearance:none"), "工具 checkbox 自绘（appearance:none）");
    assert.ok(clientSrc.includes("input:checked::after"), "勾选态用 ::after 绘制 ×");
    assert.ok(clientSrc.includes("state-error-primary"), "勾选态使用错误红主题变量");
    assert.ok(clientSrc.includes(":has(input:checked)"), "已禁用工具名同步标红");
  });
  check("client i18n 接线哨兵（issue #348）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    assert.ok(clientSrc.includes('"mcpManager"'), "i18n 命名空间 NS 进产物");
    assert.ok(clientSrc.includes("locale.register"), "locale.register（字典注册）进产物");
    assert.ok(clientSrc.includes("bindLocale"), "bindLocale（t 活绑定装配）进产物");
    assert.ok(clientSrc.includes("locale: NS"), "slots.register locale 参数进产物");
    assert.ok(clientSrc.includes("Running") && clientSrc.includes("stConnected"), "en/zh 双语字典 + STATUS_TEXT key 化进产物");
  });
  check("#362 无游离 css：style.css 全部内联进 client.js（无独立样式请求）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/client/style.css", import.meta.url), "utf8");
    const probe = css.split("\n").filter((line) => line.trim() !== "").pop() ?? "";
    // 样式文件末尾规则应整体出现在 client.js 产物中（text-loader 原样内联）。
    assert.ok(clientSrc.includes(probe.slice(0, 40)), "style.css 尾部规则已内联进 client.js");
    assert.ok(!clientSrc.includes('rel="stylesheet"'), "无独立样式表请求");
  });

  console.log("SSE 半开连接防护（#268：服务端心跳 + 客户端 watchdog + 回前台重建）");
  check("客户端 watchdog：60s 失活重建 + 建连前先关旧（0.1.8 同款防泄漏）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    assert.match(clientSrc, /WATCHDOG_MS\s*=\s*(?:60_?000|6e4|60000)/, "60s watchdog 常量存在");
    assert.ok(clientSrc.includes("forceReconnect"), "受控重建入口 forceReconnect 存在");
    assert.ok(clientSrc.includes("closeEvents"), "关旧连接入口 closeEvents 存在");
    // 关旧建新：new EventSource 前必先关旧——覆盖 source 引用不 close 会耗尽
    // 浏览器同源并发连接（dsh-notifier 0.1.8 同款事故）。
    assert.ok(
      clientSrc.indexOf("closeEvents()") >= 0 && clientSrc.indexOf("closeEvents()") < clientSrc.indexOf("new EventSource"),
      "建连前先执行关旧兜底",
    );
    assert.match(clientSrc, /lastActivity\s*=\s*Date\.now\(\)/, "收到数据帧即喂狗");
    // 心跳 ping 帧喂狗后早退，不得落入 else 触发 scheduleRefresh（否则 SSE 退化为隐性 30s 轮询）。
    assert.match(clientSrc, /===\s*"ping"\)\s*return/, "ping 帧仅喂狗即早退");
    // 卸载清理：watchdog 定时器与 SSE 连接都要收掉（esbuild 产物 undefined 折叠为 void 0）。
    assert.match(clientSrc, /if\s*\(watchdog\s*!==\s*(?:void 0|undefined)\)\s*clearTimeout\(watchdog\)/, "卸载清 watchdog");
    assert.match(clientSrc, /closeEvents\(\);\s*document\.removeEventListener\("visibilitychange"/, "卸载关 SSE 并摘监听");
  });
  check("回前台强制重建 SSE + 受控重建连接（visibilitychange → forceReconnect + resume + 补拉）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    assert.match(clientSrc, /addEventListener\("visibilitychange",\s*onVisible\)/, "visibilitychange 监听已挂");
    assert.match(
      clientSrc,
      /onVisible\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(document\.hidden\)\s*return;\s*forceReconnect\(\)/,
      "回前台路径先强制重建 SSE",
    );
    // #412：切回前台额外 POST resume 驱动宿主受控重建当前工作空间连接（半开
    // 死连接卡 connected 时纯读 refresh 无法恢复）。
    assert.match(
      clientSrc,
      /api\(state\.API\.resume,\s*\{\s*method:\s*"POST"\s*\}\)/,
      "回前台路径调用 resume 驱动宿主重建当前工作空间连接",
    );
  });

  check("设置卡片样式对齐官方风格（#219：12px 圆角 / bg-layer-3 底 / border-l2 / 15px 名称字 / 13px 描述字 / 14 16 padding / gap 4）", () => {
    const css = readFileSync(new URL("../src/client/style.css", import.meta.url), "utf8");
    assert.match(css, /border-radius:12px/, "卡片圆角对齐官方 12px");
    assert.match(css, /background:var\(--dsw-alias-bg-layer-3,#fbfbfc\)/, "卡片底色对齐官方 bg-layer-3");
    assert.match(css, /border:1px solid var\(--dsw-alias-border-l2,#e2e5ea\)/, "卡片边框对齐官方 border-l2");
    assert.match(css, /\.dm-set-head\{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px/, "head padding 对齐官方 14px 16px");
    assert.match(css, /\.dm-set-headText\{display:flex;flex-direction:column;gap:4px/, "headText gap 对齐官方 4px");
    assert.match(css, /\.dm-set-name\{display:block;font-size:15px;font-weight:600;line-height:1\.4/, "名称字号对齐官方 15px");
    assert.match(css, /\.dm-set-description\{display:block;font-size:13px;line-height:1\.5/, "描述字号对齐官方 13px");
    assert.match(css, /--dsw-alias-label-tertiary,#8a919c/, "描述用 tertiary 层级（与官方同款）");
  });

  check("设置卡片展开箭头为官方 SVG chevron（#167：非文本 ▾ 字符）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    assert.ok(clientSrc.includes('dm-set-chevron'), "chevron class 在客户端产物中");
    assert.ok(!/dm-set-chevron[^"]*"[^>]*>▾/.test(clientSrc), "不再使用文本 ▾ 字符作为箭头");
    assert.ok(clientSrc.includes('M11.8486 5.5L11.4238'), "使用官方 chevron-down SVG path");
    assert.match(clientSrc, /width:\s*14,\s*height:\s*14/, "SVG 尺寸 14x14（官方同款）");
  });

  check("F1（qa 实测 #128）：浮窗面板内容更新后重定位 + toggleFloat 先渲染后定位", () => {
    const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    // renderFloatPanel 函数体内触发 placePanel 重定位：bottom-* 锚点下内容撑高后
    // 不重排会稳定向下溢出视口（375x667 bottom-left 实测 y=561/bottom=1082 稳态）。
    const renderStart = src.indexOf("function renderFloatPanel");
    const toggleStart = src.indexOf("function toggleFloat");
    assert.ok(renderStart >= 0 && toggleStart > renderStart, "产物含 renderFloatPanel/toggleFloat 标识符");
    assert.ok(src.slice(renderStart, toggleStart).includes("placePanel(state)"),
      "renderFloatPanel 内容渲染完成即触发 placePanel 重定位（bottom 锚点防溢出）");
    // toggleFloat 内先渲染后定位：以真实内容高度定位，消除首帧小高度错位。
    const tf = src.slice(toggleStart);
    assert.ok(tf.indexOf("renderFloatPanel(state, actions)") >= 0
      && tf.indexOf("renderFloatPanel(state, actions)") < tf.indexOf("placePanel(state)"),
      "toggleFloat 先 renderFloatPanel 后 placePanel");
  });

  console.log("Config schema（浮窗 UI 配置迁移到插件自身 Config.ui）");
  check("Config 导出且含 ui 子对象（默认值与合法值域）", () => {
    assert.ok(typeof Config === "function", "Config 是 schemastery schema（可调用）");
    const parsed = Config({});
    assert.equal(parsed.ui.position, "top-right", "ui.position 默认 top-right");
    assert.deepEqual(parsed.ui.offset, { x: 8, y: 8, blankY: 40 }, "ui.offset 默认 {x:8,y:8,blankY:40}");
    assert.equal(parsed.ui.zIndexBase, 10, "#128 ui.zIndexBase 默认 10");
    assert.equal(DEFAULT_UI_CONFIG.position, "top-right", "DEFAULT_UI_CONFIG.position 与升级前一致");
    assert.deepEqual(DEFAULT_UI_CONFIG.offset, { x: 8, y: 8, blankY: 40 });
    assert.equal(DEFAULT_UI_CONFIG.zIndexBase, 10, "#128 DEFAULT_UI_CONFIG.zIndexBase 与 CSS 默认 z-index 一致");
    // 合法值域：四角全部透传（#128 补左上/左下）
    for (const p of ["top-left", "bottom-left"] as const) {
      const parsedP = Config({ ui: { position: p } });
      assert.equal(parsedP.ui.position, p, `#128 ${p} 是合法 position`);
    }
    const bottom = Config({ ui: { position: "bottom-right" } });
    assert.equal(bottom.ui.position, "bottom-right", "bottom-right 是合法 position");
  });
  check("normalizeUiConfig：默认 / 合法值透传 / 非法回退（不抛）", () => {
    // 未配置 → 默认
    assert.deepEqual(normalizeUiConfig(undefined), { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
    assert.deepEqual(normalizeUiConfig(null), { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
    // 新 Config.ui 嵌套形态
    assert.deepEqual(
      normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 } } }),
      { position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 10 },
    );
    // 旧隐藏命名空间扁平形态（position/offset）→ 兼容
    assert.deepEqual(
      normalizeUiConfig({ position: "bottom-right", offset: { x: 5, y: 6, blankY: 50 } }),
      { position: "bottom-right", offsetX: 5, offsetY: 6, blankY: 50, zIndexBase: 10 },
    );
    // 客户端扁平形态（offsetX/offsetY/blankY）→ 兼容
    assert.deepEqual(
      normalizeUiConfig({ position: "bottom-right", offsetX: 3, offsetY: 4, blankY: 44 }),
      { position: "bottom-right", offsetX: 3, offsetY: 4, blankY: 44, zIndexBase: 10 },
    );
    // #128 zIndexBase clamp 边界：合法透传 / 越界压边界 / 非法回退默认
    assert.deepEqual(
      normalizeUiConfig({ position: "top-left", offsetX: 1, offsetY: 2, blankY: 3, zIndexBase: 5000 }),
      { position: "top-left", offsetX: 1, offsetY: 2, blankY: 3, zIndexBase: 5000 },
      "左上 + 合法层级基准透传",
    );
    // 非法/缺失 → 安全回退默认，不抛
    assert.deepEqual(normalizeUiConfig({ position: "middle-left" }), { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
    assert.deepEqual(normalizeUiConfig({ ui: { position: "nope", offset: { x: "abc" } } }), { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
    assert.deepEqual(normalizeUiConfig({ offset: {} }), { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 10 });
    assert.equal(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase, Z_INDEX_BASE_MIN, "#128 低于下界压到 1");
    assert.equal(normalizeUiConfig({ zIndexBase: -50 }).zIndexBase, Z_INDEX_BASE_MIN, "#128 负数压到 1");
    assert.equal(normalizeUiConfig({ zIndexBase: 9000 }).zIndexBase, Z_INDEX_BASE_MAX, "#128 上界 9000 透传");
    assert.equal(normalizeUiConfig({ zIndexBase: 9001 }).zIndexBase, Z_INDEX_BASE_MAX, "#128 超上界压到 9000");
    assert.equal(normalizeUiConfig({ zIndexBase: Number.NaN }).zIndexBase, 10, "#128 NaN 回退默认");
  });
  check("buildConfigUiPatch：客户端扁平形态 → Config.ui 嵌套补丁（写路径）", () => {
    // 客户端 POST 的扁平形态 → 宿主写入 Config.ui 的嵌套补丁
    assert.deepEqual(
      buildConfigUiPatch({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
      { position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 10 },
    );
    // #128 四角 + 层级基准写入嵌套补丁
    assert.deepEqual(
      buildConfigUiPatch({ position: "bottom-left", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 77 }),
      { position: "bottom-left", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 77 },
    );
    // 缺省 → 安全回退默认
    assert.deepEqual(
      buildConfigUiPatch(undefined),
      { position: "top-right", offset: { x: 8, y: 8, blankY: 40 }, zIndexBase: 10 },
    );
    // 非法 position → 回退 top-right；负偏移 clamp 到 0
    assert.deepEqual(
      buildConfigUiPatch({ position: "middle-left", offsetX: -5, offsetY: 3.6, blankY: 40 }),
      { position: "top-right", offset: { x: 0, y: 4, blankY: 40 }, zIndexBase: 10 },
    );
  });
  check("README 含 position/offset 配置说明（键名与默认值，中英）", () => {
    for (const file of ["README.md", "README.en.md"]) {
      const text = readFileSync(join(pkgDir, file), "utf8");
      assert.ok(text.includes("position"), `${file} 未含 position 键`);
      assert.ok(text.includes("top-right"), `${file} 未含 top-right（默认值）`);
      assert.ok(text.includes("bottom-right"), `${file} 未含 bottom-right（合法值域）`);
      assert.ok(text.includes("offset.x"), `${file} 未含 offset.x 键`);
      assert.ok(text.includes("offset.y"), `${file} 未含 offset.y 键`);
      assert.ok(text.includes("offset.blankY"), `${file} 未含 offset.blankY 键`);
      assert.ok(text.includes("zIndexBase"), `#128 ${file} 未含 zIndexBase 键`);
      assert.ok(text.includes("top-left") && text.includes("bottom-left"), `#128 ${file} 未含四角值域`);
      assert.ok(/#116/.test(text), `#128 ${file} 未标注 #116 跨包避让契约`);
      const hotUpdatePhrase = file === "README.en.md" ? "without restarting" : "无需重启";
      assert.ok(text.includes(hotUpdatePhrase), `${file} 未声明「保存即热更新无需重启」`);
    }
  });

  console.log("配置变更 SSE 帧（既有 events 通道，不新增轮询/长连接）");
  check("uiConfigChangedFrame 写出一帧 ui-config-changed", () => {
    assert.equal(uiConfigChangedFrame(), 'data: {"type":"ui-config-changed"}\n\n');
    assert.equal(sseData({ type: "ui-config-changed" }), uiConfigChangedFrame(), "与 sseData 同构");
  });
  check("broadcastFrame 向全部连接写帧（掉线忽略）", () => {
    const written = [];
    const conn = { write: (chunk) => { written.push(chunk); } };
    const dead = { write: () => { throw new Error("closed"); } };
    broadcastFrame(new Set([conn, dead]), "data: {\"type\":\"summary\"}\n\n");
    assert.deepEqual(written, ["data: {\"type\":\"summary\"}\n\n"]);
    broadcastFrame(undefined, "x"); // 无连接不抛
  });

  console.log("面板定位翻转规则（底部锚点上弹 / 顶部锚点下弹）");
  check("panelAnchorForPosition：bottom-* → bottom，top-* / 缺省 → top（#128 四角化）", () => {
    assert.equal(panelAnchorForPosition("bottom-right"), "bottom");
    assert.equal(panelAnchorForPosition("bottom-left"), "bottom", "#128 左下也是底部锚点");
    assert.equal(panelAnchorForPosition("top-right"), "top");
    assert.equal(panelAnchorForPosition("top-left"), "top", "#128 左上是顶部锚点");
    assert.equal(panelAnchorForPosition(undefined), "top", "缺省按顶部锚点（历史行为）");
  });
  check("#128 断点判定纯函数分支翻转（基准=conversationHost rect 宽度）", () => {
    assert.equal(breakpointForWidth(320), "narrow", "手机竖屏 narrow");
    assert.equal(breakpointForWidth(BREAKPOINT_NARROW_MAX), "narrow", "480 边界归 narrow");
    assert.equal(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1), "tablet", "481 翻转 tablet");
    assert.equal(breakpointForWidth(768), "tablet", "平板竖屏 tablet");
    assert.equal(breakpointForWidth(BREAKPOINT_TABLET_MAX), "tablet", "834 边界归 tablet");
    assert.equal(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1), "wide", "835 翻转 wide");
    assert.equal(breakpointForWidth(Number.NaN), "wide", "异常宽度按 wide 兜底");
  });
  check("#128 终坐标视口 clamp 纯函数（safe-area inset 恒 0 自然退化）", () => {
    assert.deepEqual(clampPointToViewport(-30, -50, 100, 80, 375, 667), { x: 0, y: 0 }, "负坐标钳回视口原点");
    assert.deepEqual(clampPointToViewport(400, 700, 100, 80, 375, 667), { x: 275, y: 587 }, "右/下溢出钳回视口内");
    assert.deepEqual(clampPointToViewport(10, 20, 100, 80, 375, 667), { x: 10, y: 20 }, "视口内坐标不改变（桌面零回归）");
    assert.deepEqual(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10), { x: 10, y: 10 }, "safeInset>0 按安全区内缩");
    assert.deepEqual(clampPointToViewport(0, 0, 9999, 9999, 375, 667), { x: 0, y: 0 }, "元素大于视口时钳到原点不倒挂");
  });
  check("#128 重开：zIndexBase clamp 边界、主面板与胶囊同值、composer seat 贴底纯函数", () => {
    assert.equal(clampZIndexBase(5000, 10), 5000, "合法值透传");
    assert.equal(clampZIndexBase(0, 10), Z_INDEX_BASE_MIN, "低于下界压到 1");
    assert.equal(clampZIndexBase(-99, 10), Z_INDEX_BASE_MIN, "负数压到 1");
    assert.equal(clampZIndexBase(9001, 10), Z_INDEX_BASE_MAX, "超上界压到 9000");
    assert.equal(clampZIndexBase("junk", 10), 10, "非数字回退默认");
    assert.equal(clampZIndexBase(7.6, 10), 8, "小数四舍五入");
    // B1/B2：主面板与胶囊同取配置值（不再派生 +30，维护者 2026-08-28 要求）
    assert.equal(panelZIndexFor(10), 40, "子浮层派生扩展点 base+30（B5，不占主面板预算）");
    assert.equal(Z_INDEX_PANEL_DELTA, 30, "子浮层派生量约定值");
    // D1-D4：composerDockedAtBottom / bottomAnchorEdge 矩阵
    const container = { top: 0, bottom: 844 };
    assert.equal(composerDockedAtBottom({ top: 670, bottom: 844 }, container), true, "seat 贴底 → docked=true");
    assert.equal(composerDockedAtBottom({ top: 670, bottom: 843 }, { top: 0, bottom: 844 }), false, "距底缘 1px 未贴底 → false");
    assert.equal(composerDockedAtBottom({ top: 300, bottom: 500 }, { top: 0, bottom: 844 }), false, "seat 居中未贴底 → false");
    assert.equal(composerDockedAtBottom(null, container), false, "seat null → false");
    assert.equal(composerDockedAtBottom({ top: 670, bottom: 844 }, null), false, "container null → false");
    assert.equal(bottomAnchorEdge(844, 670, true), 670, "docked → seatTop");
    assert.equal(bottomAnchorEdge(844, 670, false), 844, "未 docked → containerBottom");
    assert.equal(bottomAnchorEdge(844, null, true), 844, "seatTop=null → containerBottom");
    assert.equal(bottomAnchorEdge(844, Number.NaN, true), 844, "seatTop 非有限数 → containerBottom（无 NaN）");
  });
  check("F1（qa 实测 #128）：bottom 锚点首开小高度→数据撑高→重定位后不溢出", () => {
    // 375x667 视口、bottom-right、胶囊 offsetY(blankY 同构取 8)/高 26px → 上缘 633。
    const vw = 375;
    const vh = 667;
    const pillTop = vh - 26 - 8; // 633
    const gap = 6;
    const h1 = 40; // 打开瞬间小高度
    const h2 = 500; // SSE 刷新撑高后
    const p1 = clampPointToViewport(0, Math.max(6, pillTop - h1 - gap), 340, h1, vw, vh);
    assert.ok(p1.y + h1 <= vh, "阶段1 小高度定位在视口内");
    assert.ok(p1.y + h2 > vh, "对照：缺重定位时同坐标撑高必溢出（锁定 F1 根因）");
    const p2 = clampPointToViewport(0, Math.max(6, pillTop - h2 - gap), 340, h2, vw, vh);
    assert.ok(p2.y + h2 <= vh, "阶段2 内容更新后重定位，底缘不出视口");
    assert.ok(p2.y >= 6 && p2.y < pillTop, "阶段2 保持底部锚点上弹语义");
  });
  check("panelTopForAnchor：底部锚点向上弹出 / 顶部锚点向下弹出", () => {
    // 底部锚点（pill 在视口下部）：面板向上，下缘贴近 pill 上缘（pTop - panelHeight - gap）
    assert.equal(panelTopForAnchor("bottom", 600, 640, 200, 6), 394, "底部锚点上弹");
    // 顶部锚点（pill 在视口上部）：面板向下（pillBottom + gap），历史行为不变
    assert.equal(panelTopForAnchor("top", 40, 80, 200, 6), 86, "顶部锚点下弹");
    // clamp：底部锚点面板过高时钳到视口上缘（不溢出）
    assert.equal(panelTopForAnchor("bottom", 30, 70, 2000, 6), 6, "底部锚点上弹 clamp 到视口内");
  });

  console.log("normalizeServer");
  check("stdio 服务器规范化", () => {
    const server = normalizeServer({
      name: "context7-stdio",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@context7/mcp-server"],
      env: { CONTEXT7_API_KEY: "abc" },
      description: "上下文检索（自定义描述）",
    });
    assert.equal(server.name, "context7-stdio");
    assert.equal(server.transport, "stdio");
    assert.equal(server.enabled, true);
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, ["-y", "@context7/mcp-server"]);
    assert.equal(server.toolCallTimeoutMs, 15_000, "超时默认下探至 15s");
    assert.equal(server.description, "上下文检索（自定义描述）");
    assert.equal(normalizeServer({ name: "a", transport: "stdio", command: "x", description: "  " }).description, undefined, "空白描述归一为 undefined");
    assert.equal(normalizeServer({ name: "a", transport: "stdio", command: "x", description: "长".repeat(200) }).description.length, 200, "描述完整返回不截断");
  });
  check("streamable-http 服务器规范化", () => {
    const server = normalizeServer({
      name: "context7",
      transport: "streamable-http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.url, "https://mcp.context7.com/mcp");
    assert.deepEqual(server.headers, { Authorization: "Bearer x" });
  });
  check("非法名称被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "bad name!", transport: "stdio", command: "x" }));
    assert.throws(() => normalizeServer({ name: "", transport: "stdio", command: "x" }));
  });
  check("非法传输被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "a", transport: "sse", command: "x" }));
  });
  check("stdio 缺 command 被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "a", transport: "stdio" }));
  });
  check("http 缺 url / 非法 url 被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "a", transport: "streamable-http" }));
    assert.throws(() => normalizeServer({ name: "a", transport: "streamable-http", url: "not a url" }));
  });
  check("enabled: false 保留", () => {
    assert.equal(normalizeServer({ name: "a", transport: "stdio", command: "x", enabled: false }).enabled, false);
  });

  console.log("mcpServers JSON 兼容");
  check("stdio 条目映射", () => {
    const server = fromClaudeEntry("github", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    });
    assert.equal(server.transport, "stdio");
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, ["-y", "@modelcontextprotocol/server-github"]);
    assert.deepEqual(server.env, { GITHUB_TOKEN: "tok" });
  });
  check("http 条目映射", () => {
    const server = fromClaudeEntry("remote", {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.url, "https://mcp.example.com/mcp");
  });
  check("sse 条目按 streamable-http 映射", () => {
    const server = fromClaudeEntry("sse-server", { type: "sse", url: "https://mcp.example.com/sse" });
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.url, "https://mcp.example.com/sse");
  });
  check("无 command 且无 url 的条目被拒绝", () => {
    assert.throws(() => fromClaudeEntry("bad", { type: "unknown" }));
  });
  check("parseClaudeJson 解析整段 mcpServers", () => {
    const servers = parseClaudeJson(JSON.stringify({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      remote: { type: "http", url: "https://mcp.example.com/mcp" },
    }));
    assert.equal(servers.length, 2);
    assert.equal(servers[0].name, "github");
    assert.equal(servers[1].transport, "streamable-http");
  });
  check("parseClaudeJson 拒绝非法 JSON", () => {
    assert.throws(() => parseClaudeJson("[1,2]"));
    assert.throws(() => parseClaudeJson("not json"));
  });

  console.log("工具命名 / 环境展开 / SSE 解析");
  check("publicToolName 确定性", () => {
    assert.equal(publicToolName("context7", "use_context7"), "mcp__context7__use_context7");
    assert.equal(publicToolName("context7", "use_context7"), publicToolName("context7", "use_context7"));
    assert.ok(publicToolName("a", "b").startsWith("mcp__a__b"));
  });
  check("publicToolName 超长名加哈希后缀", () => {
    const longName = "tool_".repeat(20);
    const pub = publicToolName("server", longName);
    assert.ok(pub.length <= 64);
    assert.match(pub, /^[A-Za-z0-9_-]+$/);
  });
  check("expandEnv 展开 ${ENV}", () => {
    const before = process.env.DSH_MCP_SMOKE_VAR;
    process.env.DSH_MCP_SMOKE_VAR = "hello";
    try {
      assert.equal(expandEnv("Bearer ${DSH_MCP_SMOKE_VAR}"), "Bearer hello");
      assert.equal(expandEnv("x ${DSH_MCP_SMOKE_MISSING_123} y"), "x  y");
    } finally {
      if (before === undefined) delete process.env.DSH_MCP_SMOKE_VAR;
      else process.env.DSH_MCP_SMOKE_VAR = before;
    }
  });
  check("parseSsePayload 提取匹配 id 的 JSON", () => {
    const text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
    assert.deepEqual(parseSsePayload(text, 7).result, { ok: true });
    assert.equal(parseSsePayload(text, 99), undefined);
  });

  console.log("schema 校验（真实服务器声明；parameters 原样直传、output 严格校验）");
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
  check("output schema 带 $schema 关键字 → 校验失败（回退自由值）", () => {
    assert.equal(assertSupportedOutputSchema(ST_OUTPUT), undefined);
  });
  check("纯支持子集 output schema → 原样通过", () => {
    const clean = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    assert.deepEqual(assertSupportedOutputSchema(clean), clean);
  });
  check("schema 形式的 additionalProperties / propertyNames → 校验失败", () => {
    assert.equal(assertSupportedOutputSchema(PWD_DROP_INPUT), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", additionalProperties: { type: "string" } }), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", properties: { data: { type: "object", propertyNames: { type: "string" } } } }), undefined);
  });
  check("校验通过的 output 构建的 output.schema 通过真实 assertSupportedJsonSchema", () => {
    const structured = assertSupportedOutputSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false });
    assert.ok(structured !== undefined);
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
  check("无 outputSchema / 空 schema / 注解-only 的处理", () => {
    assert.equal(assertSupportedOutputSchema(undefined), undefined);
    assert.deepEqual(assertSupportedOutputSchema({}), {});
    assert.deepEqual(assertSupportedOutputSchema({ type: "object" }), { type: "object" });
    assert.deepEqual(assertSupportedOutputSchema({ description: "x" }), { description: "x" });
  });
  check("oneOf ≥2 且无兄弟关键字；非法结构返回 undefined", () => {
    assert.deepEqual(assertSupportedOutputSchema({ oneOf: [{ type: "string" }, { type: "number" }] }), { oneOf: [{ type: "string" }, { type: "number" }] });
    assert.equal(assertSupportedOutputSchema({ oneOf: [{ type: "string" }] }), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", oneOf: [{ type: "string" }, { type: "number" }] }), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", additionalProperties: {} }), undefined); // additionalProperties 必须布尔
    assert.equal(assertSupportedOutputSchema({ type: "object", required: ["missing"] }), undefined); // required 不在 properties
    assert.equal(assertSupportedOutputSchema({ type: "string", enum: [1] }), undefined); // enum 值不匹配类型
  });
  check("parameters 原样直传（业界标准）：inputSchema 含 $schema/minimum 也直接可用", () => {
    // parameters 不再净化：任何 MCP inputSchema 都原样注册（运行时校验忽略未知键）
    assert.deepEqual(assertSupportedOutputSchema(undefined), undefined);
    assert.ok(ST_INPUT.properties.thoughtNumber.minimum === 1); // 原样保留
  });

  console.log("McpStore");
  await checkAsync("保存并读回", async () => {
    const { store, path, cleanup } = tempStore();
    try {
      store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
      await store.save();
      const reloaded = new McpStore(path);
      await reloaded.load();
      assert.equal(reloaded.data.servers.length, 1);
      assert.equal(reloaded.data.servers[0].name, "a");
    } finally {
      cleanup();
    }
  });
  await checkAsync("upsert / remove", async () => {
    const { store, cleanup } = tempStore();
    try {
      store.upsert({ name: "a" });
      store.upsert({ name: "b" });
      assert.equal(store.data.servers.length, 2);
      store.upsert({ name: "a", extra: 1 });
      assert.equal(store.data.servers.length, 2);
      store.remove("a");
      assert.equal(store.find("a"), undefined);
    } finally {
      cleanup();
    }
  });
  await checkAsync("reloadIfChanged：外部修改重读 / 未变跳过 / 删除清空", async () => {
    const { store, path, cleanup } = tempStore();
    try {
      store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
      await store.save();
      assert.equal(await store.reloadIfChanged(), false, "无外部变更不重读");
      // 外部修改（模拟 git pull / 手动编辑 mcp.json）——显式拨未来 mtime，
      // 避免与 save() 基线同毫秒导致 reloadIfChanged 检测不到（事件驱动替代固定 sleep）。
      writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "b", transport: "stdio", command: "echo", enabled: true }] }));
      utimesSync(path, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
      assert.equal(await store.reloadIfChanged(), true, "外部修改触发重读");
      assert.equal(store.data.servers.length, 1);
      assert.equal(store.data.servers[0].name, "b", "重读后数据来自磁盘");
      assert.equal(await store.reloadIfChanged(), false, "重读后基线推进");
      // 外部删除 → 清空配置（删除后 stat 失败 current=0，与基线 mtime 恒异，无需等待）。
      rmSync(path);
      assert.equal(await store.reloadIfChanged(), true, "删除触发重读");
      assert.deepEqual(store.data.servers, [], "删除 = 清空配置");
      assert.equal(await store.reloadIfChanged(), false, "删除后基线推进");
    } finally {
      cleanup();
    }
  });

  console.log("项目根发现（findProjectRoot / setSession）");
  {
    // 目录树：home/.dsh 模拟 DSH 全局家目录（DSH_HOME 指向它）；
    // home/dev/leetcode 是无任何标记的空工作区；proj 是带 .dsh/mcp.json 的项目。
    const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-root-"));
    const home = join(base, "home");
    const leetcode = join(home, "dev", "leetcode");
    const proj = join(base, "proj");
    const projSub = join(proj, "sub");
    const nomark = join(base, "nomark");
    try {
      mkdirSync(join(home, ".dsh"), { recursive: true });
      mkdirSync(leetcode, { recursive: true });
      mkdirSync(join(proj, ".dsh"), { recursive: true });
      mkdirSync(projSub, { recursive: true });
      mkdirSync(nomark, { recursive: true });
      // home 自身的项目级配置（空服务器列表，setSession 不会 spawn 进程）。
      writeFileSync(join(home, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
      writeFileSync(join(proj, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));

      const prevDshHome = process.env.DSH_HOME;
      process.env.DSH_HOME = join(home, ".dsh");
      try {
        const manager = new McpManager(
          { logger: { warn: () => {}, info: () => {}, error: () => {} } },
          new McpStore(join(base, "dsh-mcp.json")),
        );

        await checkAsync("home 下的空工作区不把 home 误判为项目根（回归：~/.dsh 串台）", async () => {
          const root = await manager.findProjectRoot(leetcode);
          assert.equal(root, leetcode);
          await manager.setSession(leetcode);
          assert.equal(manager.projectRoot, leetcode);
          assert.ok(manager.projectStore !== undefined);
          assert.equal(manager.summary().servers.filter((s) => s.scope === "project").length, 0);
        });

        await checkAsync("子目录向上命中项目 .dsh 标记", async () => {
          const root = await manager.findProjectRoot(projSub);
          assert.equal(root, proj);
        });

        await checkAsync("home 自身作为会话 cwd 时仍是合法项目根（fallback）", async () => {
          const root = await manager.findProjectRoot(home);
          assert.equal(root, home);
        });

        await checkAsync("无标记目录 → cwd 本身", async () => {
          assert.equal(await manager.findProjectRoot(nomark), nomark);
        });

        await checkAsync("空 cwd 清空项目级会话且幂等", async () => {
          await manager.setSession("");
          assert.equal(manager.projectRoot, undefined);
          assert.equal(manager.projectStore, undefined);
          // 再次清空：守卫应直接返回（不抛、不重复广播）
          await manager.setSession("");
          await manager.setSession(undefined);
          assert.equal(manager.projectStore, undefined);
        });

        await checkAsync("切回带 .dsh 的项目：加载项目级 store", async () => {
          await manager.setSession(proj);
          assert.equal(manager.projectRoot, proj);
          assert.ok(manager.projectStore !== undefined);
        });

        await manager.dispose();
      } finally {
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("目录数据源按工作区计算（切换工作区不抖动）");
  {
    // 两个项目各有自己的项目级 MCP：projA → a1、projB → b1；全局 store → g1。
    // 会话目录 = 全局 + 该会话 cwd 所属项目的配置，与 host 当前 setSession 无关。
    const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-cat-"));
    const rootA = join(base, "projA");
    const rootB = join(base, "projB");
    const subA = join(rootA, "sub");
    try {
      mkdirSync(join(rootA, ".dsh"), { recursive: true });
      mkdirSync(join(rootB, ".dsh"), { recursive: true });
      mkdirSync(subA, { recursive: true });
      const noReconnect = { reconnect: { enabled: false } };
      writeFileSync(join(rootA, ".dsh", "mcp.json"), JSON.stringify({
        version: 1,
        servers: [normalizeServer({ name: "a1", transport: "stdio", command: "true", ...noReconnect })],
      }));
      writeFileSync(join(rootB, ".dsh", "mcp.json"), JSON.stringify({
        version: 1,
        servers: [normalizeServer({ name: "b1", transport: "stdio", command: "true", ...noReconnect })],
      }));

      const gstore = new McpStore(join(base, "dsh-mcp.json"));
      gstore.data.servers = [normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect })];
      const manager = new McpManager(
        { logger: { warn: () => {}, info: () => {}, error: () => {} } },
        gstore,
      );

      await checkAsync("cwd 属于 projA → 全局 + a1", async () => {
        const names = [...(await manager.catalogServersFor(subA)).keys()];
        assert.deepEqual(names, ["g1", "a1"]);
      });
      await checkAsync("cwd 属于 projB → 全局 + b1", async () => {
        const names = [...(await manager.catalogServersFor(rootB)).keys()];
        assert.deepEqual(names, ["g1", "b1"]);
      });
      await checkAsync("host 切换会话后 projA 的目录不变（回归：切换工作区不再抖动）", async () => {
        await manager.setSession(rootB);
        const names = [...(await manager.catalogServersFor(subA)).keys()];
        assert.deepEqual(names, ["g1", "a1"]);
      });
      await checkAsync("空 cwd → 仅全局", async () => {
        const names = [...(await manager.catalogServersFor("")).keys()];
        assert.deepEqual(names, ["g1"]);
      });
      await checkAsync("同名项目级被全局顶掉", async () => {
        // projB 里放一台与全局同名的服务器
        const storeB = await manager.projectStoreFor(rootB);
        storeB.upsert(normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }));
        const names = [...(await manager.catalogServersFor(rootB)).keys()];
        assert.deepEqual(names, ["g1", "b1"]);
      });
      await checkAsync("projectStoreFor 缓存复用（同 root 返回同一实例）", async () => {
        const first = await manager.projectStoreFor(rootA);
        const second = await manager.projectStoreFor(rootA);
        assert.equal(first, second);
      });
      await checkAsync("setSession 复用工作区缓存（不重复读盘）", async () => {
        await manager.setSession(rootA);
        const current = manager.projectStore;
        await manager.setSession(rootB);
        await manager.setSession(rootA);
        assert.equal(manager.projectStore, current);
      });

      // #359：运行时注入（registerServer 的 runtimeRegistry）并入目录数据源——
      // dsh-codegraph 等插件运行时注册的服务器必须在 <available_mcp_servers> 里。
      // 放在块尾：避免注入污染前面用例对"仅 store"目录的断言。
      await checkAsync("运行时注入（runtimeRegistry）并入目录数据源（#359）", async () => {
        await manager.registerServer(normalizeServer({ name: "rt1", transport: "stdio", command: "true", ...noReconnect }));
        const names = [...(await manager.catalogServersFor("")).keys()];
        assert.deepEqual(names, ["g1", "rt1"]);
        // 同名 runtime 优先于 store（与 reconcile 双轨一致）——目录仍含该名。
        await manager.registerServer(normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }));
        const g1 = (await manager.catalogServersFor("")).get("g1");
        assert.equal(g1 !== undefined && g1.server !== undefined, true, "g1 仍在目录中");
      });

      await manager.dispose();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("外部配置变更自动重读（refreshFromDisk / reconcileServers）");
  {
    const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-reload-"));
    const proj = join(base, "proj");
    const cfg = join(proj, ".dsh", "mcp.json");
    try {
      mkdirSync(join(proj, ".dsh"), { recursive: true });
      writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
      const gstore = new McpStore(join(base, "dsh-mcp.json"));
      // 全局 disabled 服务器：验证 reconcile 不会为其 spawn 进程。
      gstore.data.servers = [normalizeServer({ name: "g1", transport: "stdio", command: "true", enabled: false })];
      await gstore.save();
      const manager = new McpManager({ logger: { warn: () => {}, info: () => {}, error: () => {} } }, gstore);
      await manager.setSession(proj);
      assert.equal(manager.projectStore.data.servers.length, 0);

      // 假 supervisor：验证配置移除后被断开（不 spawn 真实连接）。
      let disconnected = 0;
      manager.supervisors.set("ghost", {
        scope: SCOPE_PROJECT,
        status: "connected",
        client: {},
        toolDisposers: new Map(),
        disconnect: async () => {
          disconnected += 1;
        },
      });

      await checkAsync("外部新增 disabled 服务器 → refreshFromDisk 重读并进 summary（不 spawn）", async () => {
        // 显式拨未来 mtime，避免与 setSession 基线同毫秒导致 reloadIfChanged 检测不到。
        writeFileSync(cfg, JSON.stringify({
          version: 1,
          servers: [normalizeServer({ name: "p1", transport: "stdio", command: "true", enabled: false })],
        }));
        utimesSync(cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
        await manager.refreshFromDisk();
        const names = manager.summary().servers.filter((s) => s.scope === SCOPE_PROJECT).map((s) => s.name);
        assert.deepEqual(names, ["p1"], "外部新增出现在面板数据");
        assert.equal(manager.supervisors.has("p1"), false, "disabled 不启动");
      });

      await checkAsync("外部移除配置 → 已连接 supervisor 被断开", async () => {
        writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
        utimesSync(cfg, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
        await manager.refreshFromDisk();
        assert.equal(disconnected, 1, "ghost 被断开");
        assert.equal(manager.supervisors.has("ghost"), false);
      });

      await checkAsync("无配置变化时 refreshFromDisk 不广播（防 SSE 空转循环）", async () => {
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
        assert.equal(emitted, 0, "无变化不 emitStatus");
      });

      await manager.dispose();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("路由");
  {
    const { store, cleanup } = tempStore();
    try {
      const managerState = { sessionCwd: undefined, lastScope: undefined, resumed: 0 };
      // 浮窗 UI 配置（可变，验证 config 读/写回传）。
      let uiCfg = { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40 };
      const manager = {
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
      const routes = makeRoutes(manager, process.cwd());
      const find = (path) => routes.find((route) => route.path === path);

      check("注册 9 条 exact 路由（含 tool-disable / resume）", () => {
        assert.equal(routes.length, 9);
        for (const route of routes) assert.equal(route.kind, "exact");
      });

      const fakeReq = (method, url, body) => ({
        method,
        url,
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      });
      const fakeFenceBroken = (method, url) => ({
        method,
        url,
        socket: { remoteAddress: "10.0.0.5" },
        headers: { host: "localhost:3080" },
        async *[Symbol.asyncIterator]() {},
      });

      await checkAsync("GET servers → 200 + summary", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("GET", ROUTES.servers), res);
        assert.equal(res.state.status, 200);
        assert.deepEqual(JSON.parse(res.state.body), { servers: [], counts: {} });
      });
      await checkAsync("POST servers → 201 + 添加", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
          res,
        );
        assert.equal(res.state.status, 201);
        assert.equal(store.find("github").command, "npx");
      });
      await checkAsync("POST 重复名称 → 400", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
          res,
        );
        assert.equal(res.state.status, 400);
      });
      await checkAsync("PATCH 更新 → 200", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("PATCH", `${ROUTES.servers}?name=github`, { args: ["-y", "x"] }),
          res,
        );
        assert.equal(res.state.status, 200);
        assert.deepEqual(store.find("github").args, ["-y", "x"]);
      });
      await checkAsync("DELETE → 200 + 移除", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=github`), res);
        assert.equal(res.state.status, 200);
        assert.equal(store.find("github"), undefined);
      });
      await checkAsync("非 loopback → 403", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeFenceBroken("GET", ROUTES.servers), res);
        assert.equal(res.state.status, 403);
      });
      await checkAsync("config GET → 200 读回（默认 top-right/8/8/40 + middleware 字段）", async () => {
        const res = fakeRes();
        await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), res);
        assert.equal(res.state.status, 200);
        const body = JSON.parse(res.state.body);
        assert.equal(body.position, "top-right");
        assert.equal(body.offsetX, 8);
        assert.equal(body.offsetY, 8);
        assert.equal(body.blankY, 40);
        assert.equal(body.middleware, "project", "config GET 附带中间层模式");
      });
      await checkAsync("config 非 loopback GET → 200（只读 UI 配置放开）", async () => {
        const res = fakeRes();
        await find(ROUTES.config).handler(fakeFenceBroken("GET", ROUTES.config), res);
        assert.equal(res.state.status, 200);
        const body = JSON.parse(res.state.body);
        assert.equal(body.position, "top-right");
        assert.equal(body.offsetX, 8);
      });
      await checkAsync("config POST 写 → 200 且读回更新（配置读写）", async () => {
        const write = fakeRes();
        await find(ROUTES.config).handler(
          fakeReq("POST", ROUTES.config, { position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
          write,
        );
        assert.equal(write.state.status, 200);
        const written = JSON.parse(write.state.body);
        assert.equal(written.position, "bottom-right");
        assert.equal(written.offsetX, 12);
        // 读回：POST 后 GET /config 应反映新值（宿主经设置命名空间持久化后的归一化结果）。
        const read = fakeRes();
        await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
        const readBack = JSON.parse(read.state.body);
        assert.deepEqual(readBack, { position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 10, middleware: "project" });
      });
      await checkAsync("config POST middleware → 热切换 + 落盘（读回 middleware 变化）", async () => {
        const write = fakeRes();
        await find(ROUTES.config).handler(fakeReq("POST", ROUTES.config, { middleware: "off" }), write);
        assert.equal(write.state.status, 200);
        const read = fakeRes();
        await find(ROUTES.config).handler(fakeReq("GET", ROUTES.config), read);
        const readBack = JSON.parse(read.state.body);
        assert.equal(readBack.middleware, "project", "fake manager 无 setMiddlewareMode → 模式不变（读回原值）");
      });
      await checkAsync("config POST 非 loopback → 403（写操作不开放远程页面）", async () => {
        const res = fakeRes();
        await find(ROUTES.config).handler(fakeFenceBroken("POST", ROUTES.config, { position: "bottom-right" }), res);
        assert.equal(res.state.status, 403);
      });
      await checkAsync("config PUT → 405（仅 GET/POST 合法；方法错围栏）", async () => {
        const res = fakeRes();
        await find(ROUTES.config).handler(fakeReq("PUT", ROUTES.config, { position: "bottom-right" }), res);
        assert.equal(res.state.status, 405);
      });
      await checkAsync("events 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
        const eventsRoute = makeEventsRoute(manager);
        const res403 = fakeRes();
        await eventsRoute.handler(fakeFenceBroken("GET", ROUTES.events), res403);
        assert.equal(res403.state.status, 403);
        const res405 = fakeRes();
        await eventsRoute.handler(fakeReq("POST", ROUTES.events), res405);
        assert.equal(res405.state.status, 405);
      });
      await checkAsync("health 非 loopback → 403 / 方法错 → 405（围栏不回归）", async () => {
        const healthRoute = makeHealthRoute(manager);
        const res403 = fakeRes();
        await healthRoute.handler(fakeFenceBroken("GET", ROUTES.health), res403);
        assert.equal(res403.state.status, 403);
        const res405 = fakeRes();
        await healthRoute.handler(fakeReq("POST", ROUTES.health), res405);
        assert.equal(res405.state.status, 405);
      });
      await checkAsync("import/json 导入", async () => {
        const res = fakeRes();
        await find(ROUTES.importJson).handler(
          fakeReq("POST", ROUTES.importJson, {
            json: JSON.stringify({ alpha: { command: "npx", args: ["-y", "a"] } }),
          }),
          res,
        );
        assert.equal(res.state.status, 200);
        const body = JSON.parse(res.state.body);
        assert.deepEqual(body.imported, ["alpha"]);
        assert.equal(store.find("alpha").command, "npx");
      });
      await checkAsync("import/json 非法 JSON → 400", async () => {
        const res = fakeRes();
        await find(ROUTES.importJson).handler(
          fakeReq("POST", ROUTES.importJson, { json: "[1,2]" }),
          res,
        );
        assert.equal(res.state.status, 400);
      });
      await checkAsync("tool-disable 围栏：非 loopback → 403 / GET → 405", async () => {
        const res403 = fakeRes();
        await find(ROUTES.toolDisable).handler(
          fakeFenceBroken("PATCH", ROUTES.toolDisable, { server: "@x/s", tool: "t", disabled: true }),
          res403,
        );
        assert.equal(res403.state.status, 403);
        const res405 = fakeRes();
        await find(ROUTES.toolDisable).handler(fakeReq("GET", ROUTES.toolDisable), res405);
        assert.equal(res405.state.status, 405);
      });
      await checkAsync("resume：POST 合法 → 200 + 调用 resumeReconnect；围栏 403 / GET 405", async () => {
        const before = managerState.resumed;
        const res = fakeRes();
        await find(ROUTES.resume).handler(fakeReq("POST", ROUTES.resume), res);
        assert.equal(res.state.status, 200);
        assert.equal(managerState.resumed, before + 1, "resumeReconnect 被调用（#412 切回前台恢复入口）");
        const res403 = fakeRes();
        await find(ROUTES.resume).handler(fakeFenceBroken("POST", ROUTES.resume), res403);
        assert.equal(res403.state.status, 403);
        const res405 = fakeRes();
        await find(ROUTES.resume).handler(fakeReq("GET", ROUTES.resume), res405);
        assert.equal(res405.state.status, 405);
      });
      await checkAsync("tool-disable：缺 server/tool → 400；root 不属于工作空间 / setToolDisabled 未挂 → 400", async () => {
        const res1 = fakeRes();
        await find(ROUTES.toolDisable).handler(
          fakeReq("PATCH", ROUTES.toolDisable, { tool: "t", disabled: true }),
          res1,
        );
        assert.equal(res1.state.status, 400);
        const res2 = fakeRes();
        await find(ROUTES.toolDisable).handler(
          fakeReq("PATCH", ROUTES.toolDisable, { server: "@x/s", tool: "t", disabled: true }),
          res2,
        );
        assert.equal(res2.state.status, 400, "root 不属于工作空间或不可写 → 400");
      });
      await checkAsync("tool-disable：合法请求 → 200 且调用 setToolDisabled（scope=global → @global root）", async () => {
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
        assert.equal(res.state.status, 200);
        assert.deepEqual(calls, [{ root: "/proj", server: "ctx", tool: "use_ctx", disabled: true }]);
        // #392 遗留④：带 mcp__ 前缀的 tool 名剥前缀后入禁用表（旧客户端/手工 API 提交
        // 带前缀名仍生效；此前原样存键 → guard 查裸名不命中，禁用静默无效）。
        const resPrefix = fakeRes();
        await tdRoute.handler(
          fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/ctx", tool: "mcp__ctx__use_ctx", disabled: true }),
          resPrefix,
        );
        assert.equal(resPrefix.state.status, 200);
        assert.deepEqual(calls[calls.length - 1], { root: "/proj", server: "ctx", tool: "use_ctx", disabled: true }, "前缀名剥前缀入禁用表");
        // 跨 server 前缀（剥后仍 mcp__ 开头）→ 400（防错禁他 server 工具）。
        const resCross = fakeRes();
        await tdRoute.handler(
          fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/ctx", tool: "mcp__other__t", disabled: true }),
          resCross,
        );
        assert.equal(resCross.state.status, 400, "跨 server 前缀拒绝");
        // 全局 root：scope=global 的服务器以 @global 为 key。
        const resG = fakeRes();
        await tdRoute.handler(
          fakeReq("PATCH", ROUTES.toolDisable, { server: "@/proj/gctx", tool: "use_g", disabled: true }),
          resG,
        );
        assert.equal(resG.state.status, 200, "global 服务器（store 条目）以项目 root 为 key 可写");
      });
      await checkAsync("POST session {cwd} → 200 并记录会话", async () => {
        const res = fakeRes();
        await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }), res);
        assert.equal(res.state.status, 200);
        assert.equal(managerState.sessionCwd, "C:/proj");
      });
      await checkAsync("GET servers?cwd= 不触发会话切换（#324 纯读）", async () => {
        // #324：GET /servers 是纯读快照，cwd 参数被忽略（不再触发 setSession）。
        // 会话切换只走 POST /api/dsh-mcp/session。
        await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }), fakeRes());
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("GET", `${ROUTES.servers}?cwd=C:/other`), res);
        assert.equal(res.state.status, 200);
        assert.equal(managerState.sessionCwd, "C:/proj", "GET 不应改变会话 cwd");
      });
      await checkAsync("POST servers scope=project 透传 scope", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("POST", ROUTES.servers, { name: "proj-mcp", transport: "stdio", command: "x", scope: "project" }),
          res,
        );
        assert.equal(res.state.status, 201);
        assert.equal(managerState.lastScope, "project");
      });
      await checkAsync("DELETE ?scope=project 透传 scope", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=proj-mcp&scope=project`), res);
        assert.equal(res.state.status, 200);
        assert.equal(managerState.lastScope, "project");
      });
      await checkAsync("session 缺 cwd → 400", async () => {
        const res = fakeRes();
        await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, {}), res);
        assert.equal(res.state.status, 400);
      });
    } finally {
      cleanup();
    }
  }

  console.log("apply");
  await checkAsync("enabled:false 不注册路由/提示词", async () => {
    const ctx = fakeCtx();
    await apply(ctx, { enabled: false });
    assert.equal(ctx.routes.length, 0);
    assert.equal(ctx.sections.length, 0);
  });
  await checkAsync("默认配置注册路由与提示词（空存储不连接）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-apply-"));
    const ctx = fakeCtx();
    try {
      await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
      assert.equal(ctx.routes.length, 11); // 9 条业务路由 + 1 条 SSE events + 1 条 health
      assert.ok(ctx.routes.some((route) => route.path === ROUTES.events), "SSE events 路由已注册");
      assert.equal(ctx.sections.length, 1);
      assert.equal(ctx.sections[0].name, "plugin:dsh-mcp-manager");
      assert.match(ctx.sections[0].text, /dsh-mcp-manager/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await checkAsync("#362 中间层模式热切换：off 启动也可切到 project（设置页下拉路径）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-hotswitch-"));
    const ctx = fakeCtx();
    try {
      await apply(ctx, { enabled: true, middleware: "off", storePath: join(dir, "dsh-mcp.json") });
      // off 启动：不注册中间层工具，但 setMiddlewareMode 已挂。
      const toolNames = ctx.registeredTools.map((def) => def.name);
      assert.ok(!toolNames.includes("ws_mcp_call"), "off 启动不注册中间层工具");
      const configRoute = ctx.routes.find((route) => route.path === ROUTES.config);
      assert.ok(configRoute, "config 路由已注册");
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
      assert.equal(res.state.status, 200);
      const body = JSON.parse(res.state.body);
      assert.equal(body.middleware, "project", "热切换后 config 读回 project");
      assert.ok(ctx.registeredTools.some((def) => def.name === "ws_mcp_call"), "热切换后注册中间层工具");
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
      assert.equal(res2.state.status, 200);
      assert.equal(JSON.parse(res2.state.body).middleware, "off", "切回 off 生效");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 回归 #125：保存按钮 POST /api/dsh-mcp/config 曾报 400（this.write undefined）。
  // 根因：apply 的 uiUpdate sink 把 settings.update 解构后调用，丢失 cordis 服务方法
  // 的 this（dsh-settings update() 内部访问 this.write）。此处注入一个「要求 this」的
  // settings stub（update 内部访问 this.write），对 config 写路由做端到端断言：
  // 修复后 settings.update 以正确 this 调用 → 200 + 落盘 + 通读回写值。
  await checkAsync("config POST 经 apply 注入 settings：update 保留 this 不再 400（回归 #125）", async () => {
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
      assert.ok(configRoute, "config 路由已注册");
      const write = fakeRes();
      await configRoute.handler(
        localReq("POST", ROUTES.config, { position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
        write,
      );
      assert.equal(write.state.status, 200, "settings.update 以正确 this 调用 → 写路由 200（不再 400）");
      const written = JSON.parse(write.state.body);
      assert.equal(written.position, "bottom-right");
      assert.equal(written.offsetX, 12);
      assert.equal(written.offsetY, 20);
      assert.equal(written.blankY, 60);
      // 落盘：this 正确时 settings.update 内部 this.write 已把 Config.ui 补丁合并进 scope。
      assert.deepEqual(scopeValue.ui.offset, { x: 12, y: 20, blankY: 60 }, "settings.update 落盘（this.write 生效）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #389：settings 用户层持久化的 middleware 模式，apply 启动后同步到运行时——
  // 保存路径（config POST middleware 分支）写 settings 用户层，而 apply 读组合层
  // config.middleware（不含用户层覆盖）→ 重启后回退 project。此处 settings 注入
  // 完成后 onChange 触发 syncMiddlewareFromSettings，把持久化值热切换生效。
  await checkAsync("#389：settings 持久化 middleware → apply 后运行时同步", async () => {
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
      assert.ok(configRoute, "config 路由已注册");
      const read = fakeRes();
      await configRoute.handler(localReq("GET", ROUTES.config), read);
      const body = JSON.parse(read.state.body);
      assert.equal(body.middleware, "all", "settings 持久化 middleware 启动后同步（#389 重启恢复）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log("感知增强（L1 目录 / L2 描述兜底 / L3 截断 / 超时下探）");
  check("truncateText 短文本不截断", () => {
    assert.equal(truncateText("短文本", 8192), "短文本");
  });
  check("truncateText 长文本截断并标注", () => {
    const text = "A".repeat(10000);
    const out = truncateText(text, 1024);
    assert.match(out, /已截断/);
    assert.match(out, /10000 字节/);
    assert.ok(Buffer.byteLength(out, "utf8") <= 1024 + 128, "截断后含标注仍受控");
    assert.ok(out.endsWith("）"), "标注完整");
  });
  check("truncateText 多字节安全（不产生替换符）", () => {
    const text = "中".repeat(5000);
    const out = truncateText(text, 1000);
    assert.ok(!out.includes("\uFFFD"), "截断点不落在多字节字符中间");
  });
  check("composeCatalogEntries 数据源（配置优先 → 缓存摘要 → 仅名字）", () => {
    const supervisors = new Map([
      ["srv-a", { server: { description: "自定义描述 A" }, tools: [], toolMeta: new Map() }],
      ["srv-b", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
      ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ]);
    const cache = new Map([
      ["srv-b", { summary: "缓存摘要 B" }],
    ]);
    const entries = composeCatalogEntries(supervisors, 6, cache);
    assert.equal(entries[0].text, "自定义描述 A", "用户配置优先");
    assert.equal(entries[1].text, "缓存摘要 B", "缓存摘要 fallback（无需用户配置）");
    assert.equal(entries[2].name, "srv-c", "无配置无缓存 → 条目按名称保留");
    assert.equal(Object.hasOwn(entries[2], "text"), false, "双缺省条目不含 text 属性（值断言防不了 text: undefined，必须查存在性）");
    // digest 稳定性：实时连接状态（tools/toolMeta）变化不影响目录 digest
    const connected = new Map([
      ["srv-a", { server: { description: "自定义描述 A" }, tools: ["t1"], toolMeta: new Map([["x", { description: "实时描述" }]]) }],
      ["srv-b", { server: { description: undefined }, tools: ["t1"], toolMeta: new Map([["x", { description: "实时描述" }]]) }],
      ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ]);
    assert.equal(
      digestCatalogEntries(composeCatalogEntries(connected, 6, cache)),
      digestCatalogEntries(entries),
      "连接状态变化 digest 不变（不触发重复注入）"
    );
  });
  check("summarizeToolDescriptions 排序稳定与截断", () => {
    const meta1 = new Map([
      ["mcp__s__b", { description: "工具 B 的说明文字" }],
      ["mcp__s__a", { description: "工具 A 的说明" }],
    ]);
    const meta2 = new Map([
      ["mcp__s__a", { description: "工具 A 的说明" }],
      ["mcp__s__b", { description: "工具 B 的说明文字" }],
      ["mcp__s__c", { description: "" }],
    ]);
    assert.equal(summarizeToolDescriptions(meta1), summarizeToolDescriptions(meta2), "顺序变化摘要稳定");
    assert.equal(summarizeToolDescriptions(new Map([["x", { description: "  " }]])), undefined, "全空描述无摘要");
    const long = summarizeToolDescriptions(new Map([["x", { description: "长".repeat(100) }]]));
    assert.equal(long, "长".repeat(100), "长描述完整返回不截断");
  });
  check("recordCatalogTools 仅实质变化落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-catalog-"));
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
    manager.catalogCachePath = join(dir, "catalog.json");
    await manager.loadCatalogCache();
    assert.equal(manager.catalogCache.size, 0, "空缓存加载");
    const meta = new Map([["mcp__s__a", { description: "唯一描述" }]]);
    await manager.recordCatalogTools("srv", meta);
    assert.equal(manager.catalogCache.get("srv")?.summary, "唯一描述");
    const onDisk = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    assert.equal(onDisk.entries.srv.summary, "唯一描述", "缓存落盘");
    // 相同摘要再记录：不重复落盘（digest 不变）
    const mtime1 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
    await manager.recordCatalogTools("srv", meta);
    const mtime2 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
    assert.equal(mtime1, mtime2, "相同摘要不落盘");
    // 摘要变化 → 落盘
    await manager.recordCatalogTools("srv", new Map([["mcp__s__a", { description: "新描述" }]]));
    assert.equal(manager.catalogCache.get("srv")?.summary, "新描述");
    // 重新加载（模拟重启）
    const manager2 = new McpManager({ logger: { warn: () => {} } }, store);
    manager2.catalogCachePath = join(dir, "catalog.json");
    await manager2.loadCatalogCache();
    assert.equal(manager2.catalogCache.get("srv")?.summary, "新描述", "重启后缓存恢复");
    rmSync(dir, { recursive: true, force: true });
  });
  check("composeCatalogEntries 条目上限", () => {
    const supervisors = new Map();
    for (let i = 0; i < 10; i += 1) supervisors.set(`s${i}`, { server: { description: "d" }, tools: [], toolMeta: new Map() });
    assert.equal(composeCatalogEntries(supervisors, 3).length, 3);
  });
  check("digestCatalogEntries 只含服务器集合（描述变化不触发注入）", () => {
    const a = [{ name: "x", text: "d1" }];
    const b = [{ name: "x", text: "d2" }];
    const c = [{ name: "x", text: "d1" }, { name: "y", text: "d1" }];
    assert.equal(digestCatalogEntries(a), digestCatalogEntries(b), "描述文本变化 digest 不变（不触发注入）");
    assert.notEqual(digestCatalogEntries(a), digestCatalogEntries(c), "服务器集合变化 digest 变（触发替换）");
    // 顺序敏感（服务器顺序变化 = 集合变化）
    const reversed = [{ name: "y", text: "d1" }, { name: "x", text: "d1" }];
    assert.notEqual(digestCatalogEntries(c), digestCatalogEntries(reversed), "顺序变化 digest 变");
  });
  check("escapeCatalogText 转义（完整返回不截断）", () => {
    assert.equal(escapeCatalogText("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
    assert.equal(escapeCatalogText("换行\n字符"), "换行 字符");
    assert.equal(escapeCatalogText("长".repeat(300)).length, 300, "长文本完整返回不截断");
  });
  check("renderMcpCatalogMessage 结构与声明", () => {
    // 含 project 条目 → 引导经 ws_mcp_search/ws_mcp_call（#228 双轨迁移）
    const msg = renderMcpCatalogMessage([{ name: "code-graph", text: "代码图谱", scope: "project" }]);
    assert.equal(msg.role, "user");
    assert.equal(msg.source.kind, "mcp-catalog");
    assert.equal(msg.content[0].type, "text");
    assert.match(msg.content[0].text, /available_mcp_servers/);
    assert.match(msg.content[0].text, /不代表当前连接状态/);
    assert.match(msg.content[0].text, /ws_mcp_search/, "#228 目录文案引导经中间层调用");
    assert.match(msg.content[0].text, /`code-graph`: 代码图谱/);
    assert.ok(typeof msg.id === "string" && msg.id.length > 0);

    // 纯 global 条目 → 保持 mcp__ 直呼引导（不误导全局服务器走中间层检索）
    const onlyGlobal = renderMcpCatalogMessage([{ name: "ctx", scope: "global" }]);
    assert.match(onlyGlobal.content[0].text, /mcp__<server>__<tool>/);
    assert.doesNotMatch(onlyGlobal.content[0].text, /ws_mcp_search/);
    // P2-4：all 模式下纯 global 条目也引导经中间层（全局走中间层，不再 mcp__ 直呼）
    const onlyGlobalAll = renderMcpCatalogMessage([{ name: "ctx", scope: "global" }], "all");
    assert.match(onlyGlobalAll.content[0].text, /ws_mcp_search/, "all 模式纯 global 引导经中间层");
    assert.doesNotMatch(onlyGlobalAll.content[0].text, /mcp__<server>__<tool>/, "all 模式不再 mcp__ 直呼引导");

    // #192 AC-3：双缺省行仅渲染名字（无冒号描述），带描述条目渲染不变
    const mixed = renderMcpCatalogMessage([{ name: "bare-x" }, { name: "code-graph", text: "代码图谱" }]);
    assert.match(mixed.content[0].text, /^- `bare-x`$/m, "双缺省行仅名字");
    assert.doesNotMatch(mixed.content[0].text, /`bare-x`: /);
    assert.match(mixed.content[0].text, /^- `code-graph`: 代码图谱$/m, "带描述行保持");
  });
  check("findCatalogMessage 定位既有目录", () => {
    const catalog = renderMcpCatalogMessage([{ name: "a", text: "b" }]);
    const messages = [{ id: "m1", role: "user", content: [] }, catalog, { id: "m2", role: "assistant", content: [] }];
    assert.equal(findCatalogMessage(messages)?.id, catalog.id);
    assert.equal(findCatalogMessage([{ id: "x", role: "user", content: [], source: { kind: "other" } }]), undefined);
  });
  check("buildToolDefinition：空描述条件拼接（L2）", () => {
    const client = { callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) };
    const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx", description: "演示服务器" });
    const def = buildToolDefinition(client, { name: "ping", description: "", inputSchema: {} }, server, { enhanceEmptyDescriptions: true });
    assert.equal(def.description, "[演示服务器]", "空描述拼接自定义描述");
    const defKeep = buildToolDefinition(client, { name: "ping", description: "原始描述", inputSchema: {} }, server, { enhanceEmptyDescriptions: true });
    assert.equal(defKeep.description, "原始描述", "非空描述不动");
    const defOff = buildToolDefinition(client, { name: "ping", description: "", inputSchema: {} }, server, { enhanceEmptyDescriptions: false });
    assert.equal(defOff.description, "", "关闭增强不拼接");
  });
  check("buildToolDefinition：超时下探与截断（L3）", async () => {
    let seenTimeout;
    const client = {
      callTool: async (_name, _args, opts) => {
        seenTimeout = opts.timeoutMs;
        return { content: [{ type: "text", text: "X".repeat(5000) }] };
      },
    };
    const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx" });
    assert.equal(DEFAULT_TOOL_CALL_TIMEOUT_MS, 15_000, "默认超时下探 15s");
    assert.equal(server.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
    const def = buildToolDefinition(client, { name: "big", description: "d", inputSchema: {} }, server, { resultTruncateBytes: 1024 });
    const value = await def.execute({}, { signal: { aborted: false } });
    assert.equal(seenTimeout, 15_000, "execute 传递下探后的超时");
    const rendered = def.output.render({}, value);
    assert.match(rendered[0].text, /已截断/, "长结果截断标注");
  });

  // ---------- pre-step 目录注入（history-based 去重，复刻官方 tool-skill 语义）

  // 模拟 agent：session.events 持久化 + surface 可见性（与真实 agent 同构）
  function makeAgent() {
    const session = {
      header: { cwd: "/tmp" },
      surface: { nodes: new Set() },
      events: [],
      append(type, data) {
        const seq = session.events.length;
        const event = { type, data, seq };
        session.events.push(event);
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
    for (const evt of agent.session.events) {
      if (evt.type === "user/message" && evt.data?.source?.kind === "mcp-catalog") known.add(evt.data.id);
    }
    for (const msg of result.messages) {
      if (msg.source?.kind === "mcp-catalog" && !known.has(msg.id)) agent.session.append("user/message", msg);
    }
    return result;
  }

  check("resolveCatalogInjection：history-based 去重（核心：多轮不重复注入）", () => {
    const supervisors = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();

    // 真实语义：decision.messages 只含本轮新消息（历史在 session.events）
    let historyCount = 0;
    for (let round = 1; round <= 5; round += 1) {
      const decision = { kind: "enter", messages: [{ id: `user-${round}`, role: "user", content: [] }] };
      const result = runStep(decision, decision.messages, supervisors, undefined, agent);
      historyCount = agent.session.events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog").length;
      const inMessages = result.messages.filter((m) => m.source?.kind === "mcp-catalog").length;
      if (round === 1) {
        assert.equal(historyCount, 1, "首轮注入 1 条");
        assert.equal(inMessages, 1, "首轮消息列表含目录");
      } else {
        assert.equal(historyCount, 1, `第 ${round} 轮历史目录消息恒为 1（不累积）`);
        assert.equal(inMessages, 0, `第 ${round} 轮不注入新消息`);
      }
    }
    assert.equal(historyCount, 1, "5 轮后目录消息仍只有 1 条（根治重复注入）");
  });

  check("resolveCatalogInjection：描述/缓存变化不注入、集合变化注入更新消息", () => {
    const base = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();
    let messages = [{ id: "m1", role: "user", content: [] }];

    // 首次注入
    let result = runStep({ kind: "enter", messages: [...messages] }, messages, base, undefined, agent);
    messages = result.messages;
    const firstId = agent.session.events.find((e) => e.data?.source?.kind === "mcp-catalog").data.id;
    assert.ok(firstId, "首次注入");

    // 描述变化（集合不变）→ 不注入
    const descChanged = new Map([["code-graph", { server: { description: "新描述" }, tools: [], toolMeta: new Map() }]]);
    result = runStep({ kind: "enter", messages: [...messages, { id: "u2", role: "user", content: [] }] }, messages, descChanged, undefined, agent);
    assert.equal(agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog").length, 1, "描述变化不注入");

    // 集合变化（新增服务器）→ 注入"更新"消息（历史 1 + 更新 1，声明作废旧目录）
    const added = new Map([
      ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
      ["playwright", { server: { description: "浏览器自动化" }, tools: [], toolMeta: new Map() }],
    ]);
    result = runStep({ kind: "enter", messages: [...messages, { id: "u3", role: "user", content: [] }] }, messages, added, undefined, agent);
    const afterAdd = agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog");
    assert.equal(afterAdd.length, 2, "集合变化注入更新消息（历史目录无法删除，新消息声明作废）");
    assert.match(afterAdd[1].data.content[0].text, /替换此前所有/);
    assert.match(afterAdd[1].data.content[0].text, /playwright/);

    // 更新后同集合不再注入
    result = runStep({ kind: "enter", messages: [...messages, { id: "u4", role: "user", content: [] }] }, messages, added, undefined, agent);
    assert.equal(agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog").length, 2, "更新后不再注入");
  });

  check("resolveCatalogInjection：compaction 后重建 + 门控 + reject", () => {
    const supervisors = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();
    let messages = [{ id: "m1", role: "user", content: [] }];
    let result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
    messages = result.messages;
    assert.equal(agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog").length, 1, "首次注入");

    // compaction 模拟：surface 清空（旧目录不可见）→ 重新注入
    agent.session.surface.nodes.clear();
    result = runStep({ kind: "enter", messages: [{ id: "m1", role: "user", content: [] }] }, messages, supervisors, undefined, agent);
    const afterCompact = agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog");
    assert.ok(afterCompact.length >= 1, "compaction 后按可见性重建");
    assert.equal(result.messages.filter((m) => m.source?.kind === "mcp-catalog").length, 1);

    // 门控：从未发布且无服务器 → 不注入
    const agent2 = makeAgent();
    const decisionEmpty = resolveCatalogInjection({ kind: "enter", messages: [{ id: "x", role: "user", content: [] }] }, [], new Map(), 6, undefined, agent2);
    assert.equal(decisionEmpty.messages.length, 1, "无服务器不注入");

    // reject 不处理
    const rejected = resolveCatalogInjection({ kind: "reject" }, [], supervisors, 6, undefined, agent2);
    assert.equal(rejected.kind, "reject");
  });

  // ---------- issue #192：双缺省条目不得产出 text: undefined ----------

  check("composeCatalogEntries 双缺省条目干净可序列化（#192 AC-1/AC-2）", () => {
    const supervisors = new Map([
      ["bare-a", { server: { description: "" }, tools: [], toolMeta: new Map() }],
      ["bare-b", { server: {}, tools: [], toolMeta: new Map() }],
      ["with-desc", { server: { description: "有描述" }, tools: [], toolMeta: new Map() }],
    ]);
    const entries = composeCatalogEntries(supervisors, 6, undefined);
    assert.equal(entries.length, 3, "双缺省服务器按名称保留不丢弃");
    assert.deepEqual(entries.map((e) => e.name), ["bare-a", "bare-b", "with-desc"]);
    for (const bare of [entries[0], entries[1]]) {
      assert.equal(Object.hasOwn(bare, "text"), false, `双缺省条目 ${bare.name} 不含 text 属性`);
    }
    assert.equal(entries[2].text, "有描述");

    // AC-2：两条渲染路径的完整消息 JSON 往返后深度相等（载荷无 undefined 属性）
    for (const rendered of [renderMcpCatalogMessage(entries), renderMcpCatalogUpdate(entries)]) {
      assert.doesNotThrow(() => JSON.stringify(rendered));
      assert.deepEqual(JSON.parse(JSON.stringify(rendered)), rendered, "完整消息 JSON 往返深度相等");
      assert.equal(
        rendered.source.entries.map((e) => Object.hasOwn(e, "text")).join(","),
        "false,false,true",
        "source.entries 全部干净",
      );
    }
  });

  check("双缺省服务器目录消息可 append 为 user/message 且去重（#192 AC-4）", () => {
    const supervisors = new Map([["bare-only", { server: { description: "" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();
    let messages = [{ id: "m1", role: "user", content: [] }];
    let result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
    messages = result.messages;
    const catalogEvents = agent.session.events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog");
    assert.equal(catalogEvents.length, 1, "首轮注入成功（append 为 user/message 未被拒绝）");
    const appended = catalogEvents[0].data;
    assert.equal(Object.hasOwn(appended.source.entries[0], "text"), false, "append 后事件载荷仍无 text 属性");
    assert.doesNotThrow(() => JSON.stringify(appended), "事件载荷可 JSON 序列化（dsh-session 序列化校验等价物）");
    assert.deepEqual(JSON.parse(JSON.stringify(appended)), appended, "往返深度相等");

    // digest 去重语义不变：同集合再次 pre-step 不重复注入
    result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
    assert.equal(
      agent.session.events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog").length,
      1,
      "次轮不重复注入（digest 去重不变）",
    );
  });

  // ---------- SDK 端到端（issue #11 PoC 契约不漂移证据：真实 stdio 连接 /
  // initialize 版本协商 / 工具注册 / callTool / 断线自动重连，全程无网络）。

  /** 轮询等待条件成立（防 flake 纪律：轮询替代固定 sleep）。 */
  async function waitFor(label, cond, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  console.log("SDK 端到端连接（连接/工具注册/callTool/断线重连）");
  {
    // 最小 stdio MCP server fixture：node 子进程，行分隔 JSON-RPC，
    // 回应 initialize / tools/list / tools/call（无任何第三方依赖；
    // 响应必须携带规范要求的 jsonrpc:"2.0" 信封——SDK 会严格校验）。
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-sdk-"));
    const serverScript = join(dir, "mini-mcp-server.mjs");
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

    const registered = [];
    const supervisor = new ConnectionSupervisor(
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

    await checkAsync("connect → SDK 版本协商 + 工具注册", async () => {
      await supervisor.connect();
      assert.equal(supervisor.status, "connected");
      assert.deepEqual(supervisor.tools, ["mcp__mini__echo"]);
      assert.equal(registered.length, 1);
      assert.equal(registered[0].name, "mcp__mini__echo");
    });

    await checkAsync("工具 execute 全链路走 SDK callTool", async () => {
      const value = await registered[0].execute({ text: "hello sdk" }, { signal: undefined });
      assert.deepEqual(value.content, [{ type: "text", text: "hello sdk" }]);
      assert.equal(value.structuredContent, undefined);
    });

    await checkAsync("子进程被杀 → 有界退避重连 → 工具重新注册", async () => {
      const oldPid = supervisor.transport.sdk.pid;
      assert.ok(oldPid > 0);
      process.kill(oldPid, "SIGTERM");
      // 新代际 transport 建立且恢复 connected（旧 pid 不复用即证明发生过重连）。
      await waitFor("reconnected with new generation", () =>
        supervisor.status === "connected" &&
        supervisor.transport !== undefined &&
        supervisor.transport.sdk.pid !== undefined &&
        supervisor.transport.sdk.pid !== oldPid &&
        supervisor.tools.length === 1,
      );
      assert.ok(registered.length >= 2, "重连后工具重新注册");
      const value = await registered.at(-1).execute({ text: "after reconnect" }, { signal: undefined });
      assert.equal(value.content[0].text, "after reconnect");
    });

    await supervisor.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- 核心化 service（#329 阶段1）：runtimeRegistry / registerServer / unregisterServer ----
  // 用 enabled:false 的服务器（不连接、不 spawn 子进程，避免重连悬挂）验证登记语义。

  {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-service-"));
    try {
      const store = new McpStore(join(dir, "mcp.json"));
      store.data = { version: 1, servers: [] };
      const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
      const quiet = () => ({ transport: "stdio", command: "echo", args: ["ok"], enabled: false });

      // registerServer：新注册 → existing:false，条目进 runtimeRegistry。
      const r1 = await manager.registerServer({ name: "svc-a", ...quiet() });
      assert.equal(r1.existing, false);
      assert.ok(manager.runtimeRegistry.has("svc-a"), "runtime 条目已登记");
      assert.ok(!store.find("svc-a"), "不落盘（store 无条目）");

      // 幂等：同名再注册 → existing:true 不抛错。
      const r2 = await manager.registerServer({ name: "svc-a", ...quiet() });
      assert.equal(r2.existing, true, "同名幂等返回 existing");

      // 与 store 同名冲突：store 已有 → existing:true（不覆盖持久化条目）。
      store.upsert(normalizeServer({ name: "svc-store", ...quiet() }));
      const r3 = await manager.registerServer({ name: "svc-store", ...quiet() });
      assert.equal(r3.existing, true, "store 同名返回 existing");

      // 双轨合并：reconcile 后 runtime + store 条目都在 registry（enabled:false 不 spawn）。
      manager.reconcileServers();
      assert.ok(manager.runtimeRegistry.has("svc-a"), "runtime 条目在 registry");
      assert.ok(store.find("svc-store") !== undefined, "store 条目保留");

      // unregisterServer：移除 runtime 条目；store 条目不受影响。
      await manager.unregisterServer("svc-a");
      assert.ok(!manager.runtimeRegistry.has("svc-a"), "runtime 条目已移除");
      assert.ok(store.find("svc-store") !== undefined, "store 条目保留");

      // 卸载清理：dispose() 清空全部 supervisor（含 runtime）。
      await manager.registerServer({ name: "svc-b", ...quiet() });
      assert.ok(manager.runtimeRegistry.has("svc-b"));
      await manager.dispose();
      assert.equal(manager.supervisors.size, 0, "dispose 清空全部 supervisor");

      // 中间层 all 模式：runtime 条目豁免中间层跳过（reconcile 不杀 runtime supervisor）。
      // 回归（QA 复审发现）：all 模式 reconcile 会把 runtime supervisor 停掉且不重建。
      manager.middlewareMode = "all";
      await manager.registerServer({ name: "svc-all", transport: "stdio", command: "echo", args: ["x"], enabled: false });
      manager.reconcileServers();
      assert.ok(manager.runtimeRegistry.has("svc-all"), "all 模式 runtime 条目保留");
      manager.middlewareMode = "off";

      // 查询面（#329 评审修正：MCP 应能感知连接状态与工具列表）：
      // summary() 并入 runtime 条目，getStatus/list 的数据源可见运行时注册的服务器。
      await manager.registerServer({ name: "svc-q", ...quiet() });
      const sum = manager.summary();
      const qEntry = (sum.servers ?? []).find((s) => s.name === "svc-q");
      assert.ok(qEntry !== undefined, "summary 含 runtime 条目（查询面可见）");
      assert.equal(qEntry.scope, "global", "runtime 条目 scope 为 global");
      assert.equal(qEntry.status, "disabled", "enabled:false → disabled 状态");
      // 工具列表：enabled:false 不 spawn → 空数组（不抛）。
      assert.deepEqual(qEntry.tools, [], "disabled 服务器工具列表为空");

      console.log("  ok   核心化 service: register/unregister/双轨/卸载清理");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- #362 补充 4：registerServer.toolDefinitions（调用方封装定义注册）----
  // 带 toolDefinitions → 该服务器工具全部用封装定义注册（execute 来自调用方，
  // 命名仍按 publicToolName mcp__ 前缀）；不带 → 现状回归（远端 schema + 通用
  // callTool）。工具级禁用/可见性/能力目录按服务器+工具名判定照常生效。

  {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-wrapped-"));
    try {
      const store = new McpStore(join(dir, "mcp.json"));
      store.data = { version: 1, servers: [] };
      const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);

      // 封装定义（裸名；模拟 dsh-codegraph 侧 codegraph_explore 形态）。
      const wrappedExecCalls = [];
      const wrapped = [
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
      const registered = [];
      const sup = new ConnectionSupervisor(
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

      await checkAsync("toolDefinitions：封装定义注册（execute 来自调用方，mcp__ 前缀命名）", async () => {
        // 封装路径不触达远端 schema 投影：伪造 listTools 抛错证明未走远端路径。
        await sup.syncTools({ listTools: async () => { throw new Error("must not reach remote schema"); } }, true);
        assert.deepEqual(sup.tools, ["mcp__codegraph__codegraph_explore", "mcp__codegraph__codegraph_status"], "公共名排序");
        assert.equal(registered.length, 2);
        assert.equal(registered[0].name, "mcp__codegraph__codegraph_explore", "命名仍按 publicToolName（mcp__ 前缀）");
        assert.equal(registered[0].description, "封装定义：查询前强制 sync + projectPath（#362 补充 4）", "自定义 description 被采用");
        // execute 来自调用方封装（不经通用 callTool）。
        const value = await registered[0].execute({ query: "X 被谁调用" }, { signal: undefined });
        assert.equal(value.text, "wrapped:X 被谁调用", "execute 来自封装定义");
        assert.equal(wrappedExecCalls.length, 1);
      });

      // 工具级禁用对封装工具照常生效（#362 既有机制：isToolDenied 按服务器+工具
      // 裸名判定；封装工具注册名仍是 mcp__ 前缀，guard 反解裸名查表与普通工具同路径）。
      const { isToolDenied, fullServerName, parseDisabledTools, MIDDLEWARE_GLOBAL_ROOT } = await import("../lib/index.js");
      const denyMap = parseDisabledTools({ "@global": { codegraph: ["codegraph_explore"] } });
      assert.equal(
        isToolDenied(denyMap, undefined, fullServerName(MIDDLEWARE_GLOBAL_ROOT, "codegraph"), "codegraph_explore"),
        true,
        "封装工具按服务器+裸名禁用命中（既有 isToolDenied 机制）",
      );
      assert.equal(
        isToolDenied(denyMap, undefined, fullServerName(MIDDLEWARE_GLOBAL_ROOT, "codegraph"), "codegraph_status"),
        false,
        "未禁用封装工具放行",
      );
      // 可见性/能力目录：summary 工具列表为裸名（#382 F4 展示口径统一：剥
      // mcp__ 前缀，与中间层投影分支/禁用表键/guard 反解口径一致）。
      const sum = manager.summarize(sup.server, SCOPE_GLOBAL);
      assert.deepEqual(sum.tools, ["codegraph_explore", "codegraph_status"], "summary 工具列表为裸名（#382 剥前缀口径）");

      // 不带 toolDefinitions → 现状回归：远端 schema + 通用 callTool 路径不变。
      const plainRegistered = [];
      const supPlain = new ConnectionSupervisor(
        {
          ctx: { tools: { register: (definition) => { plainRegistered.push(definition); return () => {}; } } },
          logger: { warn: () => {}, info: () => {}, error: () => {} },
          enhancement: {},
          emitStatus() {},
          recordCatalogTools: async () => {},
        },
        normalizeServer({ name: "mini", transport: "stdio", command: "true" }),
      );
      const plainExecCalls = [];
      const plainClient = {
        listTools: async () => ({ tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }),
        callTool: async (rawName, args) => {
          plainExecCalls.push([rawName, args]);
          return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] };
        },
      };
      await checkAsync("不带 toolDefinitions → 现状回归（远端 schema + 通用 callTool）", async () => {
        await supPlain.syncTools(plainClient, true);
        assert.deepEqual(supPlain.tools, ["mcp__mini__echo"]);
        assert.equal(plainRegistered.length, 1);
        // 通用 callTool 路径：execute 经 client.callTool 转发远端。
        const value = await plainRegistered[0].execute({ text: "hi" }, { signal: undefined });
        assert.deepEqual(value.content, [{ type: "text", text: "echo:hi" }]);
        assert.deepEqual(plainExecCalls, [["echo", { text: "hi" }]], "通用 callTool 转发远端");
      });

      console.log("  ok   封装定义注册: toolDefinitions 采用 / 现状回归 / 禁用按公开名");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall checks passed");
  // 显式退出（成功路径）：SDK 端到端块 spawn 的 stdio 子进程句柄残留会导致事件循环
  // 不空、进程挂起不退出（本地 Node 24.19 复现，基线与 CI 差异），断言全过后强制收尾，
  // 保证 `pnpm test` 与连续 10 次零 flake 验证可完成；失败路径已在上方 exit(1)。
  process.exit(0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
