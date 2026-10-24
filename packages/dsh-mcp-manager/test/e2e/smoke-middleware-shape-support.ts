// dsh-mcp-manager — e2e 中间层 all 模式夹具（#1174 shape 拆分产物）。
//
// 原 e2e/smoke.test.ts 的「中间层 all 模式：@global 覆盖」it 前 87 行装配段：目录投影 host
// （projectServersFor 按 root 分派全局/项目，toolDefinitions 走真实虚拟连接路径投影）+
// 预置 units + ensureConnected + registerMiddlewareTools。提成具名工厂后，it 回调只剩断言，
// 语义与原逐字相同（同一批实参、同一调用顺序）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  captureCtx,
  execWithAgent,
  fakeLogger,
  mustTool,
  testResolveRoot,
} from "./remaining-smoke-support.ts";
import type { SmokeGuard } from "./remaining-smoke-support.ts";
import { tempCatalogCache } from "../helpers.ts";
import type { MiddlewareHost } from "../../lib/server/connection/runtime/deps.js";
import type { ServerConfig } from "../../lib/index.js";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { MIDDLEWARE_GLOBAL_ROOT } from "../../lib/index.js";
import { registerMiddlewareTools } from "../../src/server/inject/interface.ts";
import { McpMiddleware } from "../../src/server/connection/runtime/interface.ts";

/** all 模式夹具的可回读面（原 it 内 const 的同一集合）。 */
export interface AllModeFixture {
  MIDDLEWARE_GLOBAL_ROOT: string;
  globalToolDescription: { value: string };
  registered: ToolDefinition[];
  mw: import("../../src/server/connection/runtime/interface.ts").McpMiddleware;
  dispose: () => void;
  catalogTempDirs: string[];
}

/** 原 it 的装配段（逐字保留：host 形状 / units 预置 / ensureConnected / 注册）。 */
export async function makeAllModeFixture(catalogTempDirs: string[]): Promise<AllModeFixture> {
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
    catalogCachePath: tempCatalogCache((dir) => catalogTempDirs.push(dir)),
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
  return {
    MIDDLEWARE_GLOBAL_ROOT,
    globalToolDescription,
    registered,
    mw,
    dispose,
    catalogTempDirs,
  };
}

/**
 * #362 P0-1 三入口一致 it 的 host/register 装配夹具（#1174 shape 拆分产物）。
 *
 * 原 it 内 70-133 行装配段逐字上提：captureCtx 的 register+on 面（guards 捕获
 * tools/pre-execute 处理器）+ 目录投影 host（ctx 定义服务器含 use_ctx/other 两个
 * toolDefinitions）+ registerMiddlewareTools 带 disabledTools。it 回调只留 guard
 * 断言与 stats 断言，语义与原逐字相同（同一批实参、同一调用顺序）。
 */
export interface DisableHostFixture {
  mw: import("../../src/server/connection/runtime/interface.ts").McpMiddleware;
  guard: SmokeGuard | undefined;
  dispose: () => void;
}

/** 原 it 的装配段（逐字保留：ctx 的 register/on 面、host 形状、register 实参）。 */
export async function makeDisableHostFixture(
  map: import("../../src/server/store/interface.ts").DisabledToolsMap,
  catalogTempDirs: string[],
): Promise<DisableHostFixture> {
  const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
  const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
  const registered: ToolDefinition[] = [];
  const guards = new Map<string, SmokeGuard>();
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
    catalogCachePath: tempCatalogCache((dir) => catalogTempDirs.push(dir)),
    isGlobalServer: () => false,
    isRuntimeServer: () => false,
  };
  const mw = new McpMiddleware(host);
  const dispose = registerMiddlewareTools(ctx, mw, (agent: unknown) => testResolveRoot(agent), {
    disabledTools: map,
  });
  return { mw, guard: guards.get("tools/pre-execute"), dispose };
}

/**
 * #362 P0-1 it 第 4 段「stats 埋点」的执行面（#1174 shape 拆分产物）。
 *
 * 原 it 内 149-210 行段逐字上提：mkdtemp stats 目录 + McpStatsCollector + capture 型 statsCtx +
 * 真实虚拟连接（projectUnitFor/ensureConnected）+ registerMiddlewareTools 带 stats +
 * 四个原子工具执行 + flushSync/snapshot。try/finally 清理与调用顺序逐字不变。
 */
export async function runDisableStatsAssertions(
  mw: import("../../src/server/connection/runtime/interface.ts").McpMiddleware,
): Promise<void> {
  const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");
  const { fullServerName } = await import("../../src/server/workspace/interface.ts");
  const { McpStatsCollector } = await import("../../src/server/stats/interface.ts");
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
    expect(
      statsSnap.disclosure.searches["h:c405d32b3ac2"],
      "ws_mcp_search 记录到漏斗（哈希桶）",
    ).toBe(1);
    expect(statsSnap.disclosure.lists["<all>"], "ws_mcp_list 记录到漏斗").toBe(1);
    expect(statsSnap.disclosure.details["ctx/use_ctx"], "ws_mcp_detail 记录到漏斗").toBe(1);

    statsMwDispose();
  } finally {
    rmSync(testStatsDir, { recursive: true, force: true });
  }
}
