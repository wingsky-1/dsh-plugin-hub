/**
 * dsh-mcp-manager — unit：统计落盘先脱敏再传入（#770-A4）。
 *
 * 分工锁定：McpStatsCollector 保持纯（不引 pipeline，见本文件首个用例的静态断言），
 * 脱敏是调用方（inject/middleware-register executeCall 的 catch）的职责——复用 C
 * 快照（mw.host.redactionServers()，即 manager.getRedactionServers 的展开后快照）
 * + pipeline.createRedactor，落盘 stats.json 的 lastError 无明文。
 *
 * 覆盖：
 * - 收集器不 import pipeline（纯度静态锁；有人在收集器内加脱敏，本用例失败）；
 * - ws_mcp_call 失败经 executeCall 入 stats 时含秘密的错误被抹（快照命中），
 *   snapshot 与 flushSync 落盘文件均无明文、有 [REDACTED]；
 * - 模板展开值亦被抹（快照已展开，调用方无需二次展开）；
 * - user-state.json 不动（本笔不触 userState 路径，见遗留说明；此处仅断言 stats
 *   文件形状，不读 user-state）。
 *
 * 凭据全为虚构测试串；落盘仅进 mkdtempSync 隔离目录；离线。
 * 传输执行层不动：本文件只走 inject 注册链，不触 transport/supervisor。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as readSrc } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { McpMiddleware } from "../../src/server/connection/runtime/interface.ts";
import { McpStatsCollector } from "../../src/server/stats/interface.ts";
import { fullServerName } from "../../src/server/workspace/interface.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as runtimeApi from "../../src/server/connection/runtime/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import { installInject, releaseInject } from "../../src/server/inject/interface.ts";

// I8①：unit 层不得值引组合根 src/index.ts——本文件只走 inject 注册链，
// 经 inject/interface 直引 registerMiddlewareTools 并手装四端口（与组合根同实参），
// 不经组合根求值装配。
const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");

const A4_SECRET = "a4-fake-call-secret-X7y9Z1";
const A4_ENV_SECRET = "a4-fake-env-secret-Q3w5E7";
const ENV_VAR = "DSH_MCP_MANAGER_A4_TEST_SECRET";

const ROOT = "/tmp/ws-root-a4";

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installInjectPorts(): void {
  installInject({
    catalog: catalogApi,
    runtime: runtimeApi,
    pipeline: pipelineApi,
    workspace: workspaceApi,
  });
}

afterEach(async () => {
  try {
    releaseInject();
  } catch {
    // 未装配忽略
  }
  delete process.env[ENV_VAR];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("#770-A4 收集器保持纯（不引 pipeline）", () => {
  it("collector 源码无 pipeline 引用", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readSrc(join(here, "../../src/server/stats/impl/collector.ts"), "utf8");
    expect(src.includes("pipeline")).toBe(false);
    expect(src.includes("createRedactor")).toBe(false);
  });
});

// 自然职责 fixture 与注册函数（#1174 阶段 2 形状清债）：原 124 行 describe 的两条用例
// 共用同一套「统计收集器 + 假中间层 + 收集 ctx + 执行上下文」装配面，拆成模块级具名
// fixture；两条用例各归一段职责注册函数，describe 体只按原顺序调用——fullName 的
// describe 前缀与用例注册顺序均不变。
interface StatsFixture {
  statsFile: string;
  stats: McpStatsCollector;
}

function makeStatsFixture(prefix: string): StatsFixture {
  const dir = makeTempDir(prefix);
  const statsFile = join(dir, "stats.json");
  return { statsFile, stats: new McpStatsCollector({ enabled: true, filePath: statsFile }) };
}

/** 假中间层：只实现本域触达的面，抛出的错误里带待脱敏的明文。 */
function makeRedactionMiddlewareFake(server: ServerConfig, errorMessage: string): McpMiddleware {
  return {
    host: { redactionServers: () => [server] },
    projectUnitFor: async () => ({}),
    ensureConnected: async () => {},
    callTool: async () => {
      throw new Error(errorMessage);
    },
    units: new Map(),
    disabledTools: new Map(),
  } as unknown as McpMiddleware;
}

/** 收集工具注册的假 ctx：注册表被登记进 defs，断言面从 defs 取。 */
function makeCollectingCtx(): { defs: ToolDefinition[]; ctx: Context } {
  const defs: ToolDefinition[] = [];
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        defs.push(def);
        return () => {};
      },
    },
    on: () => () => {},
  } as unknown as Context;
  return { defs, ctx };
}

function makeExecContext(callId: string): ToolRunContext {
  return {
    callId,
    rootCallId: callId,
    name: "ws_mcp_call",
    arguments: {},
    signal: new AbortController().signal,
    agent: {},
    token: "tok-a4-1",
  } as unknown as ToolRunContext;
}

function findCallTool(defs: ToolDefinition[]) {
  const call = defs.find((def) => def.name === "ws_mcp_call")!;
  expect(call).toBeDefined();
  return call;
}

function registerCallSiteRedactionCase() {
  it("失败错误经 executeCall 入 stats 时无明文，落盘文件亦无明文", async () => {
    installInjectPorts();
    const { statsFile, stats } = makeStatsFixture("dsh-mcp-a4-");
    const secretServer = {
      name: "srv",
      transport: "stdio",
      command: "echo",
      enabled: true,
      env: { HIDDEN_TOKEN: A4_SECRET },
    } as unknown as ServerConfig;
    const mwFake = makeRedactionMiddlewareFake(secretServer, "remote boom " + A4_SECRET);
    const { defs, ctx } = makeCollectingCtx();
    registerMiddlewareTools(ctx, mwFake, async () => ROOT, {
      stats,
      disabledTools: new Map(),
    });
    const call = findCallTool(defs);
    const exec = makeExecContext("call-a4-1");
    await expect(
      call.execute({ server: fullServerName(ROOT, "srv"), tool: "t" }, exec),
    ).rejects.toThrow();
    const snapshot = stats.snapshot();
    const metric = snapshot.servers["srv"]?.tools["t"];
    expect(metric).toBeDefined();
    expect(metric!.errors).toBe(1);
    expect(String(metric!.lastError ?? "")).not.toContain(A4_SECRET);
    expect(String(metric!.lastError ?? "")).toContain("[REDACTED]");
    stats.flushSync();
    expect(existsSync(statsFile)).toBe(true);
    const onDisk = readFileSync(statsFile, "utf8");
    expect(onDisk).not.toContain(A4_SECRET);
    expect(onDisk).toContain("[REDACTED]");
    stats.dispose();
  });
}

function registerTemplateExpansionRedactionCase() {
  it("模板展开值亦被抹（快照已展开，调用方无需二次展开）", async () => {
    installInjectPorts();
    process.env[ENV_VAR] = A4_ENV_SECRET;
    const { expandServerEnv } = await import("../../src/server/config/interface.ts");
    const { statsFile, stats } = makeStatsFixture("dsh-mcp-a4-tpl-");
    const tplServer = {
      name: "srv-tpl",
      transport: "stdio",
      command: "echo",
      enabled: true,
      env: { HIDDEN_TOKEN: "${" + ENV_VAR + "}" },
    } as unknown as ServerConfig;
    const expanded = expandServerEnv(tplServer);
    expect(expanded.env?.["HIDDEN_TOKEN"]).toBe(A4_ENV_SECRET);
    const mwFake = makeRedactionMiddlewareFake(expanded, "tpl boom " + A4_ENV_SECRET);
    const { defs, ctx } = makeCollectingCtx();
    registerMiddlewareTools(ctx, mwFake, async () => ROOT, {
      stats,
      disabledTools: new Map(),
    });
    const call = findCallTool(defs);
    const exec = makeExecContext("call-a4-2");
    await expect(
      call.execute({ server: fullServerName(ROOT, "srv-tpl"), tool: "t" }, exec),
    ).rejects.toThrow();
    const metric = stats.snapshot().servers["srv-tpl"]?.tools["t"];
    expect(String(metric?.lastError ?? "")).not.toContain(A4_ENV_SECRET);
    stats.flushSync();
    expect(readFileSync(statsFile, "utf8")).not.toContain(A4_ENV_SECRET);
    stats.dispose();
  });
}

describe("#770-A4 调用方先脱敏再传入", () => {
  registerCallSiteRedactionCase();
  registerTemplateExpansionRedactionCase();
});
