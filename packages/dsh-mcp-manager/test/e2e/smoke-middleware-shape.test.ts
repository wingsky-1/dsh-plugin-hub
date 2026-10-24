// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 中间层面：工具注册与 @global 覆盖。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的中间层 describe-less it 族整块迁入本文件
// （工具注册 128 eff、all 模式 @global 191 eff、#362 P0-1 三入口一致 234 eff 等），fullName 与
// 断言逐字保留（顶层 it 原名，不新增 describe 层级）。仍是 e2e 层判据：被测对象是真实
// registerMiddlewareTools + 真 McpMiddleware/McpManager/McpStore + mkdtemp 隔离目录。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MiddlewareHost } from "../../lib/server/connection/runtime/deps.js";
import type { ServerConfig } from "../../lib/index.js";
import {
  fakeManagerCtx,
  installCompositionPorts,
  releaseCompositionPorts,
  tempCatalogCache,
} from "../helpers.ts";
import {
  captureCtx,
  execWithAgent,
  fakeLogger,
  mustTool,
  releaseCatalogTempDirs,
  testResolveRoot,
} from "./remaining-smoke-support.ts";
import { makeAllModeFixture } from "./smoke-middleware-shape-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCatalogTempDirs(catalogTempDirs);
  releaseCompositionPorts();
});

/** catalogTempDirs 账本由本文件独自持一份（原 smoke 顶层 catalogTempDirs 的同形状）。 */
const catalogTempDirs: string[] = [];
it("中间层工具注册（ws_mcp_search / ws_mcp_call / ws_mcp_list / ws_mcp_detail + 路由一致性）", async () => {
  const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
  const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
  const { fullServerName, parseFullServerName } =
    await import("../../src/server/workspace/interface.ts");
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
    catalogCachePath: tempCatalogCache((dir) => catalogTempDirs.push(dir)),
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
  const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
  const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
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
    catalogCachePath: tempCatalogCache((dir) => catalogTempDirs.push(dir)),
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
  const { fullServerName } = await import("../../src/server/workspace/interface.ts");
  const { MIDDLEWARE_GLOBAL_ROOT, globalToolDescription, registered, mw, dispose } =
    await makeAllModeFixture(catalogTempDirs);
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
  const { MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
  const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
  const { fullServerName } = await import("../../src/server/workspace/interface.ts");
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
    catalogCachePath: tempCatalogCache((dir) => catalogTempDirs.push(dir)),
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
  const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
  const { McpStore } = await import("../../src/server/store/interface.ts");
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
  const { MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
  const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
  const { fullServerName } = await import("../../src/server/workspace/interface.ts");
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
    catalogCachePath: tempCatalogCache((dir) => catalogTempDirs.push(dir)),
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
