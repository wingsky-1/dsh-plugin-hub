/**
 * dsh-mcp-manager middleware unit：image-admission 职责分片。
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
import type {
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { ImageAdmissionFaces } from "../../src/server/inject/impl/image-admission/index.ts";
import type { ModelInfoPort, SaveImageInput } from "../../src/server/shared/interface.ts";

/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
type Json = Parameters<ToolDefinition["output"]["render"]>[1];
import type { ServerConfig } from "../../src/server/config/interface.ts";

// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");

beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");
const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const remoteEntry = middlewareShape.remoteEntry.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

function registerImageAdmissionSwapCases() {
  it("B8 远端合法图片 + 路由声明 image + 落库成功 → finalizeContent 换入真附件块且文本保序", async () => {
    // 落库输入快照（SaveImageInput 面）：复制保留调用时刻值，引用/复制 verdict 一致。
    const saved: SaveImageInput[][] = [];
    const value = {
      content: [
        { type: "text", text: "前" },
        { type: "image", mimeType: "image/png", data: PNG },
        { type: "resource", uri: "x" },
      ],
    };
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({
          saveImages: async (inputs) => {
            saved.push([...inputs]);
            return [{ id: "att-1" }];
          },
        }),
        models: () => IMAGE_MODEL,
      },
    });
    const exec = makeExec();
    // exec 桩只实现 finalize/execute 触达的 ToolExecution 面：execute 要的后两键按接缝收窄。
    const returned = await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // render 兜底保持现状（无 exec 的既有投影 + 图片占位串）。
    // render 入参是 JSON 值面：本文件传入的字面量恒为 JSON，此处收窄不断言。
    const rendered = fixture.call.output.render({}, returned as Json);
    expect(rendered).toEqual([
      { type: "text", text: "前\n[image content]\n[resource: content discarded]" },
    ]);
    const finalized = fixture.call.finalizeContent!(exec, {
      isError: false,
      content: rendered,
      value: returned as Json,
    });
    // 文本块次序与内容保住；图片块原位换成真附件。
    expect(finalized).toEqual([
      { type: "text", text: "前" },
      { type: "image", attachment: { id: "att-1" } },
      { type: "text", text: "[resource: content discarded]" },
    ]);
    expect(saved.length).toBe(1);
    expect(saved[0][0].mediaType).toBe("image/png");
  });
}

function registerImageAdmissionIdentityCases() {
  it("B14 未命中（无图片块 / 不是本次 exec / isError）→ finalizeContent 返回 undefined", async () => {
    const value = { content: [{ type: "text", text: "只有文本" }] };
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({
          saveImages: async () => {
            throw new Error("不该被调用");
          },
        }),
        models: () => IMAGE_MODEL,
      },
    });
    const exec = makeExec();
    // exec 桩只实现 finalize/execute 触达的 ToolExecution 面：execute 要的后两键按接缝收窄。
    const returned = await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // render 入参是 JSON 值面：本文件传入的字面量恒为 JSON，此处收窄不断言。
    const rendered = fixture.call.output.render({}, returned as Json);
    expect(
      fixture.call.finalizeContent!(exec, {
        isError: false,
        content: rendered,
        value: returned as Json,
      }),
      "无图片块：不建映射，保留 render",
    ).toBe(undefined);
    expect(
      fixture.call.finalizeContent!(makeExec({ callId: "never-ran" }), {
        isError: false,
        content: rendered,
        value: returned as Json,
      }),
      "不是本次执行：弱映射无命中",
    ).toBe(undefined);
  });

  it("B14b isError 结果不吃换面（内容交回宿主）", async () => {
    const value = { content: [{ type: "image", mimeType: "image/png", data: PNG }] };
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({ saveImages: async () => [{ id: "att-1" }] }),
        models: () => IMAGE_MODEL,
      },
    });
    const exec = makeExec();
    // exec 桩只实现 finalize/execute 触达的 ToolExecution 面：execute 要的后两键按接缝收窄。
    const returned = await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // render 入参是 JSON 值面：本文件传入的字面量恒为 JSON，此处收窄不断言。
    const rendered = fixture.call.output.render({}, returned as Json);
    // isError:true 时实现短路（middleware-register 的 finalizeContent 首行即 return，不读 value）：
    // Failure 面声明 value?: never，此处不断言、整对象收窄，运行期原样传入。
    expect(
      fixture.call.finalizeContent!(exec, {
        isError: true,
        content: rendered,
        value: returned as Json,
      } as unknown as Readonly<ToolExecutionResult>),
    ).toBe(undefined);
    // 命中即删：同一个 exec 再问一次也不再有投影。
    expect(
      fixture.call.finalizeContent!(exec, {
        isError: false,
        content: rendered,
        value: returned as Json,
      }),
    ).toBe(undefined);
  });

  it("B15 两次不同 exec 的投影互不串（键是 exec 身份），且命中即删", async () => {
    const value = { content: [{ type: "image", mimeType: "image/png", data: PNG }] };
    let seq = 0;
    const fixture = await callFixture({
      value,
      faces: {
        attachments: () => ({
          saveImages: async () => {
            seq += 1;
            return [{ id: `att-${seq}` }];
          },
        }),
        models: () => IMAGE_MODEL,
      },
    });
    const e1 = makeExec({ callId: "c1" });
    const e2 = makeExec({ callId: "c2" });
    const v1 = await fixture.call.execute(callArgs, e1 as unknown as ToolRunContext);
    const v2 = await fixture.call.execute(callArgs, e2 as unknown as ToolRunContext);
    const swap = (exec: Readonly<ToolExecution>, val: unknown) =>
      fixture.call.finalizeContent!(exec, { isError: false, content: [], value: val as Json });
    // 换入的恒为图片块（实现保证），此处按测试前置收窄。
    expect((swap(e1, v1)![0] as { attachment: unknown }).attachment).toEqual({ id: "att-1" });
    expect((swap(e2, v2)![0] as { attachment: unknown }).attachment).toEqual({ id: "att-2" });
    expect(swap(e1, v1), "已消费过的 exec 不再有投影").toBe(undefined);
  });
}

function registerImageAdmissionForwardCases() {
  it("B16 F4：远端转发不带 agent，parent = 外层 token，signal 照传", async () => {
    const fixture = await callFixture({
      value: { content: [{ type: "text", text: "hi" }] },
      faces: undefined,
    });
    const exec = makeExec();
    await fixture.call.execute(callArgs, exec as unknown as ToolRunContext);
    // 发送记录的形状由宿主执行面约定（name/agent/parent/signal 四键），此处只读不断言。
    const sent = fixture.tools.executed[0] as {
      name: unknown;
      agent: unknown;
      parent: unknown;
      signal: unknown;
    };
    expect(sent.name).toBe("mcp__id-py__echo");
    expect(sent.agent, "远端分支去 agent（F4 收口）").toBe(undefined);
    expect(sent.parent).toBe("tok-1");
    expect(sent.signal).toBe(exec.signal);
  });
}
const PNG = "iVBORw0KGgo=";
const ROUTE_AGENT = {
  session: { requestHeader: () => ({ config: { provider: "p", model: "m" } }) },
  options: {},
};
const IMAGE_MODEL: ModelInfoPort = {
  resolveModelInfo: async () => ({
    provider: "p",
    id: "m",
    name: "m",
    inputModalities: ["text", "image"],
  }),
};
async function callFixture({ value, faces }: { value: unknown; faces?: ImageAdmissionFaces }) {
  const servers: ServerConfig[] = [
    { name: "py", transport: "stdio", command: "python", enabled: true },
  ];
  // 注册面必须带 `mcp__id-py__` 前缀：executeCall 会先 ensureConnected，而六态投影按注册面
  // 判「已连上」——不带前缀会走重建路径，把夹具的 connected 条目拆掉。
  const { host, tools } = makeHost(new Map([[ROOT, servers]]), {
    schemas: [{ name: "mcp__id-py__echo" }],
    execute: async () => ({ isError: false, content: [], value }),
  });
  const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
  const unit = makeUnit();
  mw.units.set(ROOT, unit);
  unit.connections.set("py", remoteEntry(servers[0], "id-py"));
  // 注册面收集的是实现传入的真 ToolDefinition（ws_mcp_call 等四工具），此处取其类型面。
  const registered: ToolDefinition[] = [];
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        registered.push(def);
        return () => {};
      },
      schemas: () => tools.schemas(),
    },
  };
  // 第 5 个位置参数就是图片准入的宿主能力面（faces === undefined 时退化成纯诊断）。
  // 部分宿主（只实现 register/schemas 面）：按接缝收窄。
  registerMiddlewareTools(
    ctx as unknown as Context,
    mw,
    async () => ROOT,
    { disabledTools: new Map() },
    faces,
  );
  return {
    // 四工具恒注册（实现保证），此处断言存在。
    call: registered.find((def) => def.name === "ws_mcp_call")!,
    tools,
  };
}
function makeExec(overrides: Record<string, unknown> = {}): Readonly<ToolExecution> {
  return {
    callId: "call-1",
    rootCallId: "call-1",
    name: "ws_mcp_call",
    arguments: {},
    signal: new AbortController().signal,
    agent: ROUTE_AGENT,
    token: "tok-1",
    ...overrides,
  } as unknown as Readonly<ToolExecution>;
}
const callArgs = { server: fullServerName(ROOT, "py"), tool: "echo" };
describe("#767 笔 1b：A+ 图片准入接线与 F4 转发去 agent", () => {
  /** canonical base64 的合法图片。 */
  /** 官方 LlmResolvedModelInfo 的最小合法形状：本组只关心模态，其余键是官方必填项。 */

  /** 注册四个中间层工具（带 faces），交回 ws_mcp_call 定义与假工具服务（看转发出去的那次 exec）。 */

  // finalizeContent 的 exec 桩：只实现判据触达的面，整体按被测签名收窄（同上）。

  registerImageAdmissionSwapCases();
  registerImageAdmissionIdentityCases();
  registerImageAdmissionForwardCases();
});
