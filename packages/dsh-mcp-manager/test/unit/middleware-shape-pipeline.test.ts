/**
 * dsh-mcp-manager middleware unit：pipeline 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { FakeToolsScript } from "../helpers.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type {
  CallResultTextHandlers,
  ProjectedCallResult,
} from "../../src/server/pipeline/interface.ts";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
import type { McpMiddleware as McpMiddlewareType } from "../../src/server/connection/runtime/interface.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { DiskSeedEntry } from "./middleware-shape-support.ts";

// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");
const { normalizeArguments, createRedactor, globMatch, projectCallToolResult } =
  await import("../../src/server/pipeline/interface.ts");
const { CATALOG_TTL_MS } = await import("../../src/server/connection/runtime/interface.ts");
const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const remoteEntry = middlewareShape.remoteEntry.bind(middlewareShape);
const identity = middlewareShape.identity.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const seedRootFromDisk = middlewareShape.seedRootFromDisk.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);
const losslessViolation = middlewareShape.losslessViolation.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

describe("normalizeArguments", () => {
  it("对象原样", () => {
    expect(normalizeArguments({ a: 1 })).toEqual({ a: 1 });
  });

  it("JSON 字符串解析为对象", () => {
    expect(normalizeArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("标量保留", () => {
    expect(normalizeArguments("hello")).toBe("hello");
  });

  it("空串 → 空对象", () => {
    expect(normalizeArguments("")).toEqual({});
  });

  it("B14：数组 JSON 不应作为 arguments", () => {
    // B14 红测：arguments 按 MCP 规范应为 object，数组形态一律归一无害空态
    // （原断言 `'"[1,2]"'` → `[1,2]` 即 B14 泄漏路径，改用拒绝语义）
    expect(normalizeArguments("[1,2]")).toEqual({});
  });

  it("B14：引号包裹的数组 JSON 同样拒绝", () => {
    expect(normalizeArguments('"[1,2]"')).toEqual({});
  });

  it("B14：数组入参拒绝", () => {
    expect(normalizeArguments([1, 2])).toEqual({});
  });
});

describe("globMatch（工具名通配纯函数；#767 笔 2 后仓内零消费者，公开面保留）", () => {
  it("通配符匹配一切", () => {
    expect(globMatch("*", "anything")).toBe(true);
  });

  it("字面量相等匹配", () => {
    expect(globMatch("foo", "foo")).toBe(true);
  });

  it("字面量不等不匹配", () => {
    expect(globMatch("foo", "bar")).toBe(false);
  });

  it("前缀通配匹配", () => {
    expect(globMatch("foo*", "foobar")).toBe(true);
  });

  it("前缀通配不匹配中缀", () => {
    expect(globMatch("foo*", "barfoo")).toBe(false);
  });
});

function registerProjectionEquivalenceCases() {
  it("#767 S1-4d：远端返回与旧链路逐字节等价（工具返回值 === projectCallToolResult(value)）", async () => {
    const value = {
      content: [{ type: "text", text: "等价" }],
      structuredContent: { n: 1 },
      isError: false,
      _meta: { trace: "x" },
    };
    const mw = await withFakeExecute(value);
    const out = await echo(mw);
    // 同一份远端原文走真 pipeline 投影；换引擎后喂进投影的必须是 result.value，否则
    // isError / _meta 之类字段会外泄进工具契约（与旧链路就不再逐字节等价）。
    expect(out).toEqual(projectCallToolResult(value));
    expect(Object.hasOwn(out, "structuredContent")).toBe(true);
    expect(Object.hasOwn(out, "isError")).toBe(false);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#767 S1-4d：远端返回无 structuredContent 时不落键（条件键语义同旧链路）", async () => {
    const value = { content: [{ type: "text", text: "只有文本" }] };
    const mw = await withFakeExecute(value);
    const out = await echo(mw);
    expect(out).toEqual(projectCallToolResult(value));
    // 投影产物面为对象（键存在性断言），此处取对象面不断言其形状。
    expect(Object.hasOwn(out as object, "structuredContent")).toBe(false);
  });

  it("#512：isError:false / _meta 不泄漏，白名单字段保留", async () => {
    // Python SDK 形态：成功结果必带 isError:false（+ _meta）→ 不得外泄。
    const mw = await withFakeExecute({
      content: [{ type: "text", text: "你好" }],
      structuredContent: { answer: 42 },
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await echo(mw);
    expect({ content: out.content, structuredContent: out.structuredContent }).toEqual({
      content: [{ type: "text", text: "你好" }],
      structuredContent: { answer: 42 },
    });
  });

  it("无 isError 键", async () => {
    const mw = await withFakeExecute({
      content: [{ type: "text", text: "你好" }],
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "isError")).toBe(false);
  });

  it("无 _meta 键", async () => {
    const mw = await withFakeExecute({
      content: [{ type: "text", text: "你好" }],
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#512 输出 lossless 合规", async () => {
    const mw = await withFakeExecute({ content: [{ type: "text", text: "你好" }], isError: false });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 输出")).toBeUndefined();
  });
}

function registerProjectionErrorCases() {
  it("isError:true 抛错且文案可归因", async () => {
    // isError:true → 抛错（文案含远端错误提示与下一步引导）。
    const mw = await withFakeExecute({ content: [{ type: "text", text: "boom" }], isError: true });
    await expect(echo(mw)).rejects.toThrow(/远端工具返回错误：.*boom.*ws_mcp_detail/);
  });

  it("isError:true 应抛错（Error 实例）", async () => {
    const mw = await withFakeExecute({ content: [{ type: "text", text: "boom" }], isError: true });
    // #529：外层 catch 不再追加 detail 建议，同一条错误里「ws_mcp_detail」只出现一次。
    const dupErr = await echo(mw).then(
      () => null,
      (e: unknown) => e,
    );
    expect(dupErr instanceof Error).toBeTruthy();
  });

  it("detail 建议只出现一次", async () => {
    const mw = await withFakeExecute({ content: [{ type: "text", text: "boom" }], isError: true });
    const dupErr = await echo(mw).then(
      () => null,
      (e) => e,
    );
    // dupErr 为被测抛出的 Error（上一断言已验 instanceof），此处取文案不断言。
    const detailCount = ((dupErr as Error).message.match(/ws_mcp_detail/g) ?? []).length;
    expect(detailCount).toBe(1);
  });

  it("toolResult 形态渲染 JSON 兜底", async () => {
    // 无 content / 非数组 content → 兜底文本（required content 不落空，lossless 合规）。
    const mw = await withFakeExecute({ toolResult: { ok: 1 } });
    const out = await echo(mw);
    expect(out.content).toEqual([{ type: "text", text: '{"ok":1}' }]);
  });

  it("#512 兜底 lossless 合规", async () => {
    const mw = await withFakeExecute({ toolResult: { ok: 1 } });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 兜底")).toBeUndefined();
  });
}

function registerProjectionStaleCases() {
  it("空结果 → (no output) 兜底", async () => {
    const mw = await withFakeExecute({});
    const out = await echo(mw);
    expect(out.content).toEqual([{ type: "text", text: "(no output)" }]);
  });

  it("stale 前置 hint（内容块数为 2）", async () => {
    // stale（目录过期）：前置 hint + 仍走投影（不透传 isError/_meta）。
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(out.content.length).toBe(2);
  });

  it("stale hint 文案", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }] },
      { stale: true },
    );
    const out = await echo(mw);
    // stale hint 恒为文本块（投影构造保证），此处按测试前置收窄。
    expect((out.content[0] as { text: string }).text).toMatch(/本工具目录已过期/);
  });

  it("stale 保留远端原文", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }] },
      { stale: true },
    );
    const out = await echo(mw);
    expect(out.content[1]).toEqual({ type: "text", text: "旧结果" });
  });

  it("stale 分支也不泄漏 isError", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(Object.hasOwn(out, "isError")).toBe(false);
  });

  it("stale 分支也不泄漏 _meta", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#512 stale lossless 合规", async () => {
    const mw = await withFakeExecute(
      { content: [{ type: "text", text: "旧结果" }] },
      { stale: true },
    );
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 stale")).toBeUndefined();
  });
}

function registerProjectionFallbackCases() {
  it("封装 execute 返回 undefined 不落 structuredContent 键", async () => {
    const mw = await voidOpFixture();
    const out = await mw.callTool(
      fullServerName("@global", "vd"),
      "void_op",
      {},
      undefined,
      identity(),
    );
    // 投影产物面为对象（键存在性断言），此处取对象面不断言其形状。
    expect(Object.hasOwn(out as object, "structuredContent")).toBe(false);
  });

  it("#512 封装 undefined lossless 合规", async () => {
    const mw = await voidOpFixture();
    const out = await mw.callTool(
      fullServerName("@global", "vd"),
      "void_op",
      {},
      undefined,
      identity(),
    );
    expect(losslessViolation(out, "#512 封装 undefined")).toBeUndefined();
  });

  // 两例「isError + 非数组 content 的原文保留」整删：真链路里这条分支不可达——官方执行器在
  // isError:true 时先抛错，且把非数组 content 渲染成单个 text 块，dispatch 拿到的 value 已经
  // 没有「非数组 content」这个形态（isError 也在投影之前就收敛成单层文案）。等价判据在新链路
  // 上的住所：unit-dispatch 的「isError:true → 单层文案」与上面的 value 等价性用例。

  // 复核闸 F5：缺省分支（不传 handlers）——错误文案取 content 内 text 块 join，
  // 无 text 块退化兜底文本；fallbackText 惰性（正常路径零额外计算语义由实现保证）。
  function probe(result: unknown, handlers: CallResultTextHandlers) {
    return projectCallToolResult(result, handlers);
  }

  function thrownOf(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("缺省 errorText = content 内 text 块 join", () => {
    const thrown = thrownOf(() =>
      probe(
        {
          content: [
            { type: "text", text: "e1" },
            { type: "text", text: "e2" },
          ],
          isError: true,
        },
        {},
      ),
    );
    expect((thrown as Error).message).toBe("e1\ne2");
  });

  it("缺省 errorText 无 text 块退化兜底", () => {
    const thrown = thrownOf(() =>
      probe({ content: [{ type: "image", mimeType: "image/png" }], isError: true }, {}),
    );
    expect((thrown as Error).message).toBe("(no output)");
  });

  it("fallbackText 惰性：正常 content 路径不调用", () => {
    // 注入 fallbackText 但正常 content 路径不消费（惰性：计数不增长）。
    let fallbackCalls = 0;
    probe(
      { content: [{ type: "text", text: "ok" }], isError: false },
      {
        fallbackText: () => {
          fallbackCalls += 1;
          return "unused";
        },
      },
    );
    expect(fallbackCalls).toBe(0);
  });

  it("正常 content 路径透传投影", () => {
    const normal = probe({ content: [{ type: "text", text: "ok" }], isError: false }, {});
    expect(normal.content).toEqual([{ type: "text", text: "ok" }]);
  });
}
async function voidOpFixture() {
  // 封装 execute 返回 undefined → 不落 structuredContent 键（#381 同源防御）。
  const voidTool = {
    name: "void_op",
    description: "无返回值",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", properties: {}, additionalProperties: false },
      render: () => [{ type: "text", text: "done" }],
    },
    execute: async () => undefined,
  };
  const voidServer = {
    name: "vd",
    transport: "stdio",
    command: "x",
    enabled: true,
    toolDefinitions: [voidTool],
  };
  // 自持形状与容器一并收窄（定义本身不断言，见上）。
  const { host } = makeHost(
    new Map([["@global", [voidServer]]]) as unknown as Map<string, ServerConfig[]>,
  );
  const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
  await mw.projectUnitFor("@global");
  await mw.ensureConnected("@global", "vd");
  return mw;
}
async function withFakeExecute(value: unknown, { stale = false }: { stale?: boolean } = {}) {
  const servers: ServerConfig[] = [
    { name: "py", transport: "stdio", command: "python", enabled: true },
  ];
  const { host } = makeHost(new Map([[ROOT, servers]]), {
    execute: async () => ({ isError: false, content: [], value }),
  });
  const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
  const entries: Array<[string, DiskSeedEntry]> = [
    [
      "py",
      {
        discoveredAt: stale ? Date.now() - CATALOG_TTL_MS - 1000 : Date.now(),
        tools: new Map([["echo", { description: "回声", inputSchema: { type: "object" } }]]),
        unavailable: undefined,
      },
    ],
  ];
  // stale 分支要的是「很久以前发现的」，投影写口恒写 now → 这条走 last-good 读回。
  if (stale) await seedRootFromDisk(ROOT, entries);
  const unit = makeUnit(stale ? {} : { catalog: new Map(entries) });
  mw.units.set(ROOT, unit);
  unit.connections.set("py", remoteEntry(servers[0], "id-py"));
  return mw;
}
const echo = (mw: McpMiddlewareType): Promise<ProjectedCallResult> =>
  mw.callTool(
    fullServerName(ROOT, "py"),
    "echo",
    {},
    undefined,
    identity(),
  ) as Promise<ProjectedCallResult>;
describe("#512：callTool 远端结果投影收敛", () => {
  /** 假宿主执行面返回官方形状 `{isError, content, value}`：`value` 才是远端原始结果。 */

  // echo 的返回即投影产物面（ProjectedCallResult）：调用方只读 content/structuredContent 键。

  registerProjectionEquivalenceCases();
  registerProjectionErrorCases();
  registerProjectionStaleCases();
  registerProjectionFallbackCases();
});

describe("createRedactor 基线", () => {
  function redacted() {
    const redact = createRedactor([
      {
        name: "http1",
        transport: "streamable-http",
        url: "https://user:pass@example.com/path?token=abc",
        headers: { Authorization: "Bearer secret-token" },
        enabled: true,
      },
      {
        name: "stdio1",
        transport: "stdio",
        command: "echo",
        env: { API_KEY: "k-123" },
        args: ["--token", "tok-456"],
        enabled: true,
      },
    ]);
    return redact(
      new Error(
        "failed connect to https://user:pass@example.com/path?token=abc with Bearer secret-token k-123 tok-456",
      ),
    );
  }

  // 现状口径（middleware-utils.ts createRedactor L146）：http 分支把整 URL 加入
  // secrets；env 全值、args 凭据形参、headers 全值同样脱敏。
  it("URL 用户信息脱敏", () => {
    expect(!redacted().includes("user:pass")).toBeTruthy();
  });

  it("URL searchParams 脱敏", () => {
    expect(!redacted().includes("token=abc")).toBeTruthy();
  });

  it("header 值脱敏", () => {
    expect(!redacted().includes("secret-token")).toBeTruthy();
  });

  it("env 全值脱敏", () => {
    expect(!redacted().includes("k-123")).toBeTruthy();
  });

  it("args 凭据形参值脱敏", () => {
    expect(!redacted().includes("tok-456")).toBeTruthy();
  });

  it("B-M2 短 flag 下一拍脱敏（-p password；#903）", () => {
    const redact = createRedactor([
      {
        name: "s",
        transport: "stdio",
        command: "mysql",
        args: ["-p", "s3cr3t-pw", "-k", "k3y-v4l", "--port", "3306"],
        enabled: true,
      },
    ]);
    const out = redact(new Error("connect failed with s3cr3t-pw and k3y-v4l on 3306"));
    expect(!out.includes("s3cr3t-pw")).toBeTruthy();
    expect(!out.includes("k3y-v4l")).toBeTruthy();
    // -k 只认精确独占形态：--port 的值不是秘密，保留可诊断。
    expect(out.includes("3306")).toBeTruthy();
  });

  it("B-M2 --turkey 不误伤下个参数（精确名匹配；#903）", () => {
    const redact = createRedactor([
      {
        name: "s",
        transport: "stdio",
        command: "cook",
        args: ["--turkey", "thanksgiving"],
        enabled: true,
      },
    ]);
    expect(redact(new Error("roast thanksgiving")).includes("thanksgiving")).toBeTruthy();
  });

  it("B-M2 等号形态与大小写仍脱敏（--Token=xxx；#903）", () => {
    const redact = createRedactor([
      {
        name: "s",
        transport: "stdio",
        command: "run",
        args: ["--Token=AbC-123"],
        enabled: true,
      },
    ]);
    expect(!redact(new Error("leaked AbC-123")).includes("AbC-123")).toBeTruthy();
  });

  // B8 红测（D4 决策：仅用户信息脱敏）：host/path 无凭据应保留可读——
  // 现状整 URL 全部 [REDACTED]，本断言红；commit3 改口径后绿。
  it("B8：host 应保留（仅用户信息脱敏；现状整 URL 脱敏）", () => {
    expect(redacted().includes("example.com")).toBeTruthy();
  });

  it("B8：path 应保留", () => {
    expect(redacted().includes("/path")).toBeTruthy();
  });
});

describe("B8 红测（续）：percent-encoding raw 形态脱敏对照", () => {
  function redactedEnc() {
    // URL 用户信息带 percent-encoding：URL parse 得 decoded 形态，raw 形态
    // （错误消息中实际出现的字节串）必须同被脱敏——现状仅存 decoded，红测。
    const redactEnc = createRedactor([
      {
        name: "enc",
        transport: "streamable-http",
        url: "https://user%3Apass@example.com/p?token=abc123",
        headers: {},
        enabled: true,
      },
    ]);
    return redactEnc(new Error("failed connect to user%3Apass@example.com abc123"));
  }

  it("B8：percent-encoded 用户信息 raw 形态脱敏（现状仅存 decoded → 红测）", () => {
    expect(!redactedEnc().includes("user%3Apass")).toBeTruthy();
  });

  it("searchParams 值脱敏", () => {
    expect(!redactedEnc().includes("abc123")).toBeTruthy();
  });
});

describe("B18 红测a：callTool 应用 server.toolCallTimeoutMs", () => {
  function timeoutFixture(execute: FakeToolsScript["execute"]) {
    const server: ServerConfig = {
      name: "s1",
      transport: "stdio",
      command: "echo",
      enabled: true,
      toolCallTimeoutMs: 100,
    };
    const { host } = makeHost(new Map([[ROOT, [server]]]), { execute });
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("s1", remoteEntry(server, "id-s1"));
    return { mw, unit };
  }

  const okExecute = async () => ({
    isError: false,
    content: [{ type: "text", text: "ok" }],
    value: { content: [{ type: "text", text: "ok" }] },
  });

  it("callTool 正常", async () => {
    const { mw } = timeoutFixture(okExecute);
    // echo 工具恒回文本块（okExecute 构造保证），此处按测试前置收窄。
    const res = (await mw.callTool(
      fullServerName(ROOT, "s1"),
      "t1",
      '{"a":1}',
      undefined,
      identity(),
    )) as ProjectedCallResult;
    expect((res.content[0] as { text: string }).text).toBe("ok");
  });

  it(
    "B18：超时文案带 server.toolCallTimeoutMs（不是缺省 15000）",
    { timeout: 15_000 },
    async () => {
      const { mw } = timeoutFixture(async () => new Promise(() => {}));
      await expect(
        mw.callTool(fullServerName(ROOT, "s1"), "t1", '{"a":1}', undefined, identity()),
      ).rejects.toThrow(/调用超时（100ms）/);
    },
  );
});
