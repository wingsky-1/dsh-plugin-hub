/** Manager 方法面的自然职责测试与专属fixture。 */

import { afterEach, beforeEach } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { FakeToolEntry } from "../helpers.ts";

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import {
  makeManager,
  makeTempDir,
  MIDDLEWARE_GLOBAL_ROOT,
  normalizeServer,
  poolLoader,
  quietServer,
  registerMiddlewareTools,
} from "./manager-shape-support.ts";

let prevHome: string | undefined;

let homeDir: string;

/** 调用方封装定义：execute 是调用方 JS（记录每次调用，供断言「执行的是它」）。 */
function wrappedTool(calls: unknown[]) {
  return {
    name: "cg_node",
    description: "查符号",
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
      render: (a: unknown, v: { text: unknown }) => [{ type: "text", text: v.text }],
    },
    execute: async (args: unknown) => {
      calls.push(args);
      return { text: `node(${String((args as { symbol: unknown }).symbol)})` };
    },
  };
}

/** 每种模式一套夹具：注册封装条目 + 挂中间层工具（ws_mcp_call 是它唯一的触达面）。 */
/**
 * 封装定义条目夹具。单池（#767 笔 1a）后模式轴不存在了，剩下的两档都走虚拟连接：
 * - "runtime"：registerServer 运行时注入（不落 store）；
 * - "store"：持久化在 store 里（落盘条目 + start 触达）。
 */
async function wrappedFixture(source: string) {
  const { manager, store, log } = makeManager(homeDir);
  const mw = await manager.initMiddleware();
  const calls: unknown[] = [];
  const definition = wrappedTool(calls);
  if (source === "store") {
    const config = normalizeServer(quietServer("cg"));
    // 封装定义是中间层自持形状（与官方 ToolDefinition 面不完全一致）：此处不断言其类型。
    config.toolDefinitions = [definition] as unknown as ToolDefinition[];
    store.upsert(config);
    manager.start("cg", "global");
  } else {
    await manager.registerServer({
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      args: ["serve", "--mcp"],
      toolDefinitions: [definition],
    });
  }
  const disposeTools = registerMiddlewareTools(manager.ctx, mw, async () => homeDir, {
    disabledTools: manager.disabledTools,
    stats: manager.stats,
    resolveServerId: (id) => manager.serverNameForId(id),
  });
  await pollUntil("虚拟连接建立", () => mw.units.get("@global")?.connections.has("cg") === true);
  return { manager, store, mw, log, calls, definition, disposeTools };
}

const mountCalls = () => poolLoader!.calls.filter((call) => call[0] === "mount").length;

// ---- M2 洞（本笔反转）：建单元的惰性连接范围不再按所有权收窄 ----
// 单池（#767 笔 1a）后本层是唯一连接路径，单元内**全部** enabled 服务器都归本层。
// 判据打在外面：池的 connections + 假 loader 的 mount 计数（不断言私有字段）。
/** 夹具：一个正常 transport 全局服务器 + 一个封装条目（后者触发 @global 单元创建）。 */
async function eagerFilterFixture() {
  const { manager, store } = makeManager(homeDir);
  const mw = await manager.initMiddleware();
  store.upsert(normalizeServer(quietServer("gn")));
  await manager.registerServer({
    name: "cg",
    transport: "stdio",
    command: "codegraph",
    toolDefinitions: [wrappedTool([])],
  });
  await pollUntil("@global 单元建立", () => mw.units.get("@global") !== undefined);
  return { manager, mw };
}

// ---- M3 洞：guard 的 id 反解（注册名中段 → (root, 裸名)）必须有判据 ----
// 这条链今天零覆盖，而它正是裁定 AG② 要修的工具级禁用直呼路径。
/**
 * 夹具：正常 transport 全局服务器（进 @global 单元，注册名 `mcp__<id>__<tool>`）
 * + 中间层工具与其 pre-execute guard（连 resolveServerId 一起按组合根的接线递入）。
 */
async function directGuardFixture() {
  const { manager } = makeManager(homeDir);
  // guard 回调捕获器：存取两用（ctx.on 侧存入、判据侧按 guard 形状调用），值面保持未知、调用点收窄。
  const handlers = new Map<string, unknown>();
  // 假 ctx 补 on：registerMiddlewareTools 只在 ctx.on 可用时才挂 pre-execute guard。
  manager.ctx.on = (event, handler) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  };
  const mw = await manager.initMiddleware();
  // 禁用面用仓库既有事实源（manager.disabledTools → 经 options 同步进 mw）。
  manager.disabledTools.set(MIDDLEWARE_GLOBAL_ROOT, new Map([["g1", new Set(["echo"])]]));
  registerMiddlewareTools(manager.ctx, mw, async () => homeDir, {
    disabledTools: manager.disabledTools,
    stats: manager.stats,
    resolveServerId: (id) => manager.serverNameForId(id),
  });
  await manager.registerServer({
    name: "g1",
    transport: "stdio",
    command: "dsh-noop-cmd",
    reconnect: { enabled: false },
  });
  await pollUntil(
    "池内条目拿到 id",
    () => manager.middleware!.units.get("@global")?.connections.get("g1")?.id !== undefined,
  );
  // 轮询已等到 id 写回，条目与 guard 恒存在，此处断言存在。
  const entry = manager.middleware!.units.get("@global")!.connections.get("g1")!;
  // 注册名就是 id 前缀形态（直呼路径看得见的那两个名字）。
  // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
  (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
    { name: `mcp__${entry.id}__echo` },
    { name: `mcp__${entry.id}__other` },
  ];
  return {
    entry,
    guard: handlers.get("tools/pre-execute")! as (
      exec: unknown,
      next: () => unknown,
    ) => Promise<{ kind: unknown; reason?: unknown }>,
  };
}
export {
  directGuardFixture,
  eagerFilterFixture,
  homeDir,
  mountCalls,
  prevHome,
  wrappedFixture,
  wrappedTool,
};
export function registerWrappedDispatchHooks() {
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2wr-");
    process.env.DSH_HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
}
