/**
 * dsh-mcp-manager middleware unit：crap-guard 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
type Json = Parameters<ToolDefinition["output"]["render"]>[1];
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
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

function registerCrapGuardListCases() {
  it("list execute hits", async () => {
    const { defs } = crapFixture2();
    const list = defs.find((d) => d.name === "ws_mcp_list")!;
    const res = await list.execute({ perServerLimit: 50 }, {
      agent: {},
      signal: new AbortController().signal,
    } as unknown as ToolRunContext);
    // 夹具含 ctx + @global gctx 两个目录，空返回即漏报；恒真断言收紧（#903 M-C2）。
    expect((res as { servers: unknown[] }).servers.length).toBeGreaterThan(0);
  });
  it("list render hits with servers", () => {
    const { defs } = crapFixture2();
    const list = defs.find((d) => d.name === "ws_mcp_list")!;
    const out = list.output.render({}, {
      workspace: ROOT,
      servers: [
        {
          server: "s",
          tools: [{ tool: "t", description: "d" }],
          totalServers: 1,
          totalTools: 1,
          toolsTruncated: true,
        },
      ],
      totalServers: 1,
      totalTools: 1,
      toolsTruncated: true,
      message: "m",
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/s/);
  });
  it("list render empty hits", () => {
    const { defs } = crapFixture2();
    const list = defs.find((d) => d.name === "ws_mcp_list")!;
    const out = list.output.render({}, {
      workspace: ROOT,
      servers: [],
      totalServers: 0,
      totalTools: 0,
      toolsTruncated: false,
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/Workspace/);
  });
}

function registerCrapGuardDetailCases() {
  it("detail execute hits", async () => {
    const { defs } = crapFixture2();
    const detail = defs.find((d) => d.name === "ws_mcp_detail")!;
    const full = fullServerName(ROOT, "ctx");
    const res = await detail.execute({ server: full, tool: "use_ctx" }, {
      agent: {},
      signal: new AbortController().signal,
    } as unknown as ToolRunContext);
    expect((res as { server: unknown }).server).toBeDefined();
  });
  it("detail render hits", () => {
    const { defs } = crapFixture2();
    const detail = defs.find((d) => d.name === "ws_mcp_detail")!;
    const out = detail.output.render({}, {
      server: "s",
      tool: "t",
      description: "d",
      inputSchema: { type: "object" },
      fresh: true,
    } as unknown as Json);
    expect(JSON.stringify(out)).toMatch(/s\/t/);
  });
}

function registerCrapGuardCallCases() {
  it("call guard hits via ws_mcp_call deny", async () => {
    const { guards } = crapFixture2();
    const guard = guards.get("tools/pre-execute")! as (
      exec: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const disabled = parseDisabledTools({ "/tmp/ws-root-a": { ctx: ["use_ctx"] } });
    const { host } = makeHost();
    const mw2 = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const guards2 = new Map<string, (...args: unknown[]) => unknown>();
    const ctx2 = {
      tools: { register: () => () => {} },
      on: (evt: string, h: (...args: unknown[]) => unknown) => {
        guards2.set(evt, h);
        return () => {};
      },
    };
    registerMiddlewareTools(ctx2 as unknown as Context, mw2, async () => ROOT, {
      disabledTools: disabled,
    });
    const g2 = guards2.get("tools/pre-execute")! as (
      exec: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const full = fullServerName(ROOT, "ctx");
    const decision = (await g2(
      { name: "ws_mcp_call", arguments: { server: full, tool: "use_ctx" }, agent: {} },
      async () => ({ kind: "allow" }),
    )) as { kind: unknown };
    expect(decision.kind).toBe("deny");
    void guard;
  });
}
function crapFixture2() {
  const { host } = makeHost();
  const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
  const unit = makeUnit({
    catalog: new Map([
      [
        "ctx",
        {
          discoveredAt: Date.now(),
          tools: new Map([["use_ctx", { description: "d", inputSchema: { type: "object" } }]]),
        },
      ],
    ]),
  });
  mw.units.set(ROOT, unit);
  const globalUnit = makeUnit({
    root: "@global",
    catalog: new Map([
      [
        "gctx",
        {
          discoveredAt: Date.now(),
          tools: new Map([["use_g", { description: "gd", inputSchema: { type: "object" } }]]),
        },
      ],
    ]),
  });
  mw.units.set("@global", globalUnit);
  const defs: ToolDefinition[] = [];
  const guards = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    tools: {
      register: (d: ToolDefinition) => {
        defs.push(d);
        return () => {};
      },
    },
    on: (evt: string, h: (...args: unknown[]) => unknown) => {
      guards.set(evt, h);
      return () => {};
    },
  };
  registerMiddlewareTools(ctx as unknown as Context, mw, async () => ROOT, {
    disabledTools: new Map(),
  });
  return { mw, defs, guards };
}
describe("CRAP-ZERO middleware list detail guard", () => {
  registerCrapGuardListCases();
  registerCrapGuardDetailCases();
  registerCrapGuardCallCases();
});
