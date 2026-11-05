/**
 * dsh-mcp-manager middleware unit：crap-guard 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createForwardingFixture,
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecutionResult,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
type Json = Parameters<ToolDefinition["output"]["render"]>[1];
type SuccessfulToolExecution = Extract<ToolExecutionResult, { isError: false }>;
type ProjectedCallValue = Json & { content: SuccessfulToolExecution["content"] };
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
const forwardingFixture = createForwardingFixture(middlewareShape);

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

function registerNestedPipelineCases() {
  it("pipeline 收到完整 nested identity，按 prepare→dispatch→complete 执行并投影结果", async () => {
    const fixture = forwardingFixture(async () => {
      return {
        isError: false,
        content: [{ type: "text", text: "pipeline-result" }],
        value: { content: [{ type: "text", text: "pipeline-result" }] },
      };
    });
    const out = (await fixture.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo", arguments: { n: 1 } },
      fixture.runContext,
    )) as { content: Array<{ text: string }> };
    expect(fixture.pipeline.inputs).toEqual([
      {
        callId: "call-b5:mcp:1",
        rootCallId: "call-b5",
        name: "mcp__id-py__echo",
        arguments: { n: 1 },
        agent: fixture.agent,
        toolSet: fixture.toolSet,
        parent: fixture.TOKEN,
        signal: fixture.signal,
      },
    ]);
    expect(fixture.toolSet.view(fixture.agent).has("ws_mcp_call")).toBe(true);
    expect(fixture.toolSet.view(fixture.agent).has("mcp__id-py__echo")).toBe(false);
    expect(fixture.pipeline.stages).toEqual(["prepare", "dispatch", "complete"]);
    expect(out.content).toEqual([{ type: "text", text: "pipeline-result" }]);
    expect(fixture.mw.forwarding.has(fixture.TOKEN)).toBe(false);
  });

  it("受控 source 只解析精确目标名，并要求真实外层 parent", async () => {
    let activeExact: ToolDefinition | undefined;
    let activeOther: ToolDefinition | undefined;
    let activeOtherAgent: ToolDefinition | undefined;
    let activeReject: Error | undefined;
    const otherAgent = {
      id: "other-agent",
      session: { header: { cwd: ROOT } },
    } as unknown as NonNullable<ToolRunContext["agent"]>;
    const fixture = forwardingFixture(async () => {
      const source = fixture.pipeline.sources[0]!;
      activeExact = source.get!("mcp__id-py__echo", fixture.agent, fixture.toolSet);
      activeOther = source.get!("mcp__id-py__other", fixture.agent, fixture.toolSet);
      activeOtherAgent = source.get!("mcp__id-py__echo", otherAgent, fixture.toolSet);
      activeReject = source.reject!("mcp__id-py__echo", true);
      return {
        isError: false,
        content: [{ type: "text", text: "pipeline-result" }],
        value: { content: [{ type: "text", text: "pipeline-result" }] },
      };
    });
    await fixture.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      fixture.runContext,
    );
    expect(activeExact).toEqual({ name: "mcp__id-py__echo" });
    expect(activeOther).toBeUndefined();
    expect(activeOtherAgent).toBeUndefined();
    expect(activeReject).toBeUndefined();

    const source = fixture.pipeline.sources[0]!;
    expect(source.get!("mcp__id-py__echo", fixture.agent, fixture.toolSet)).toBeUndefined();
    expect(source.get!("mcp__id-py__other", fixture.agent, fixture.toolSet)).toBeUndefined();
    expect(source.reject!("mcp__id-py__other", true)?.message).toContain(
      "rejected unexpected tool",
    );
    expect(source.reject!("mcp__id-py__echo", false)?.message).toContain(
      "requires an active enclosing execution token",
    );
    expect(source.reject!("mcp__id-py__echo", true)?.message).toContain(
      "requires an active enclosing execution token",
    );

    expect(source.get!("mcp__id-py__echo", otherAgent, fixture.toolSet)).toBeUndefined();

    const rejected = forwardingFixture();
    await expect(
      rejected.mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined, {
        agent: rejected.agent,
        callId: rejected.runContext.callId,
        toolSet: rejected.toolSet,
      }),
    ).rejects.toThrow(/调用失败（宿主 MCP 依赖准入拒绝）：unknown tool/);
    expect(rejected.pipeline.dispatchCalls, "无外层 parent token 时不得进入 tool body").toBe(0);
  });
}

function registerNestedRegistrationCases() {
  it("disposed toolSet 与 removed/replaced inner registration 都 fail closed", async () => {
    const disposed = forwardingFixture();
    await disposed.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      disposed.runContext,
    );
    const disposedSource = disposed.pipeline.sources[0]!;
    disposed.toolSet.dispose();
    expect(
      disposedSource.get!("mcp__id-py__echo", disposed.agent, disposed.toolSet),
    ).toBeUndefined();

    const removed = forwardingFixture();
    await removed.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      removed.runContext,
    );
    const removedSource = removed.pipeline.sources[0]!;
    removed.tools.entries = [];
    expect(removedSource.get!("mcp__id-py__echo", removed.agent, removed.toolSet)).toBeUndefined();

    const replaced = forwardingFixture();
    await replaced.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      replaced.runContext,
    );
    const replacedSource = replaced.pipeline.sources[0]!;
    replaced.tools.entries = [{ name: "mcp__id-py__echo", replacement: true }];
    expect(
      replacedSource.get!("mcp__id-py__echo", replaced.agent, replaced.toolSet),
    ).toBeUndefined();
  });

  it("真实 parent ∈ forwarding 时 guard 放行，execution identity 不依赖 callId/signal 猜测", async () => {
    let guarded: PreToolDecision | undefined;
    let inForwarding = false;
    const fixture = forwardingFixture(async (exec) => {
      inForwarding = fixture.mw.forwarding.has(fixture.TOKEN);
      guarded = await fixture.guard()!(
        {
          callId: exec.callId,
          name: exec.name,
          arguments: exec.arguments,
          agent: exec.agent,
          parent: exec.parent,
          signal: exec.signal,
        },
        async () => ({ kind: "allow" }),
      );
      return {
        isError: false,
        content: [],
        value: { content: [] },
      };
    });
    await fixture.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      fixture.runContext,
    );
    expect(inForwarding).toBe(true);
    expect(guarded?.kind).toBe("allow");
    expect(fixture.mw.forwarding.has(fixture.TOKEN)).toBe(false);
  });
}

function registerNestedContentCases() {
  it("官方 nested projectContent 已物化时，A+ 先复核硬上限后复用而不再次准入", async () => {
    const fixture = forwardingFixture(
      async () => ({
        isError: false,
        content: [{ type: "image", attachment: { id: "official-att-1" } }],
        value: {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            },
          ],
        },
      }),
      true,
    );
    const out = (await fixture.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      fixture.runContext,
    )) as ProjectedCallValue;
    const finalized = fixture.call.finalizeContent?.(fixture.runContext, {
      isError: false,
      content: out.content,
      value: out,
    });
    expect(finalized).toEqual([{ type: "image", attachment: { id: "official-att-1" } }]);
  });

  it("官方只有图片诊断文本时不发复用信号，A+ 继续执行本包准入", async () => {
    const fixture = forwardingFixture(
      async () => ({
        isError: false,
        content: [{ type: "text", text: "official diagnostic" }],
        value: {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            },
          ],
        },
      }),
      true,
    );
    const out = (await fixture.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      fixture.runContext,
    )) as ProjectedCallValue;
    const finalized = fixture.call.finalizeContent?.(fixture.runContext, {
      isError: false,
      content: out.content,
      value: out,
    });
    expect(
      finalized?.some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes("no attachment store is mounted"),
      ),
    ).toBe(true);
  });
}

function registerNestedLifecycleCases() {
  it("nested additionalContexts 与成功 concludesTurn 映射到外层 ToolRunContext", async () => {
    type UserContext = NonNullable<
      Extract<ToolExecutionResult, { isError: false }>["additionalContexts"]
    >[number];
    // rc.1 的 MessageId 是零运行时校验的 opaque brand；测试要构造协议消息，但生产实现不得值引
    // @deepseek-ai/dsh-llm。此处只做已知字段的精确品牌收窄，不把整个 fixture 转为 any/unknown。
    const contextId = "message-1" as UserContext["id"];
    const context: UserContext = {
      id: contextId,
      role: "user",
      content: [{ type: "text", text: "next" }],
      source: { kind: "user" },
    };
    const fixture = forwardingFixture(async () => ({
      isError: false,
      content: [{ type: "text", text: "rich" }],
      value: { content: [{ type: "text", text: "rich" }] },
      meta: { card: "nested" },
      additionalContexts: [context],
      concludesTurn: true,
    }));
    await fixture.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      fixture.runContext,
    );
    expect(fixture.deferredContexts).toEqual([context]);
    expect(fixture.concluded).toBe(1);
  });

  it("pipeline 抛错保留 ws_mcp_call 脱敏映射并清理 forwarding", async () => {
    const fixture = forwardingFixture(async () => {
      throw new Error("pipeline unavailable");
    });
    await expect(
      fixture.call.execute(
        { server: fullServerName(ROOT, "py"), tool: "echo" },
        fixture.runContext,
      ),
    ).rejects.toThrow(/调用失败：pipeline unavailable/);
    expect(fixture.mw.forwarding.has(fixture.TOKEN)).toBe(false);
  });

  it("pipeline canonical failure 不当作成功结果，返回远端错误映射", async () => {
    const fixture = forwardingFixture(async () => ({
      isError: true,
      error: { name: "ToolError", code: "FAILED", message: "remote failed" },
      content: [{ type: "text", text: "remote failed" }],
    }));
    await expect(
      fixture.call.execute(
        { server: fullServerName(ROOT, "py"), tool: "echo" },
        fixture.runContext,
      ),
    ).rejects.toThrow(/远端工具返回错误：remote failed/);
    expect(fixture.mw.forwarding.has(fixture.TOKEN)).toBe(false);
  });

  it(
    "外层超时摘除 parent 后迟到 complete 不再提交 nested context/conclusion",
    { timeout: 10_000 },
    async () => {
      type UserContext = NonNullable<
        Extract<ToolExecutionResult, { isError: false }>["additionalContexts"]
      >[number];
      const contextId = "late-message-1" as UserContext["id"];
      const context: UserContext = {
        id: contextId,
        role: "user",
        content: [{ type: "text", text: "must not leak" }],
        source: { kind: "user" },
      };
      let release!: () => void;
      const late = new Promise<ToolExecutionResult>((resolve) => {
        release = () =>
          resolve({
            isError: false,
            content: [{ type: "text", text: "late" }],
            value: { content: [{ type: "text", text: "late" }] },
            additionalContexts: [context],
            concludesTurn: true,
          });
      });
      const fixture = forwardingFixture(async () => await late, false, 1);
      await expect(
        fixture.call.execute(
          { server: fullServerName(ROOT, "py"), tool: "echo" },
          fixture.runContext,
        ),
      ).rejects.toThrow(/调用超时（1ms）/);
      expect(fixture.mw.forwarding.has(fixture.TOKEN)).toBe(false);

      release();
      await vi.waitFor(() => expect(fixture.pipeline.stages).toContain("complete"));
      expect(fixture.deferredContexts, "parent 已摘除时不得迟到提交上下文").toEqual([]);
      expect(fixture.concluded, "parent 已摘除时不得迟到 conclude 外层 turn").toBe(0);
    },
  );
}

function registerNestedFailureCases() {
  it("dispatch 前取消不启动 tool body，dispatch 后取消保留原 signal.reason", async () => {
    const beforeReason = new Error("cancelled before dispatch");
    const beforeController = new AbortController();
    beforeController.abort(beforeReason);
    const before = forwardingFixture();
    await expect(
      before.call.execute(
        { server: fullServerName(ROOT, "py"), tool: "echo" },
        { ...before.runContext, signal: beforeController.signal },
      ),
    ).rejects.toBe(beforeReason);
    expect(before.pipeline.dispatchCalls).toBe(0);
    expect(before.mw.forwarding.has(before.TOKEN)).toBe(false);

    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const after = forwardingFixture(async () => {
      resolveStarted?.();
      return await new Promise<ToolExecutionResult>(() => {});
    });
    const afterController = new AbortController();
    const pending = after.call.execute(
      { server: fullServerName(ROOT, "py"), tool: "echo" },
      { ...after.runContext, signal: afterController.signal },
    );
    await started;
    const afterReason = new Error("cancelled after dispatch");
    afterController.abort(afterReason);
    await expect(pending).rejects.toBe(afterReason);
    expect(after.mw.forwarding.has(after.TOKEN)).toBe(false);
  });
}

describe("0.2.2 nested execution：公开 pipeline 保留完整身份与共享生命周期边界", () => {
  registerNestedPipelineCases();
  registerNestedRegistrationCases();
  registerNestedContentCases();
  registerNestedLifecycleCases();
  registerNestedFailureCases();
});
