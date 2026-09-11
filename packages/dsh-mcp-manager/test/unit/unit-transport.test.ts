// @ts-nocheck
/**
 * dsh-mcp-manager — unit：transport 解析/环境过滤 + MCPClient 协议适配。
 *
 * 覆盖：
 * - expandEnv / expandEnvObject（经 HttpTransport headers 展开面）
 * - StdioTransport：args/env/cwd 缺省语义、onerror 记录、onClose 叠加链
 * - createTransport 分派
 * - parseSsePayload：多事件、id 匹配、坏 JSON、无 data
 * - normalizeScope
 * - MCPClient：requireClient 未初始化抛错、initialize 失败附 stderr 尾巴、
 *   listTools/callTool 参数构造与透传
 */
import { beforeAll, describe, expect, it } from "vitest";

const {
  expandEnv,
  HttpTransport,
  StdioTransport,
  createTransport,
  parseSsePayload,
  normalizeScope,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  MCPClient,
} = await import("../../src/index.ts");

describe("expandEnv", () => {
  beforeAll(() => {
    process.env.DSH_MUT_TEST_A = "va";
    delete process.env.DSH_MUT_TEST_B;
  });

  it("已设置变量展开", () => {
    expect(expandEnv("${DSH_MUT_TEST_A}")).toBe("va");
  });

  it("未设置变量展开为空串", () => {
    expect(expandEnv("x${DSH_MUT_TEST_B}y")).toBe("xy");
  });

  it("混合展开", () => {
    expect(expandEnv("${DSH_MUT_TEST_A}-${DSH_MUT_TEST_B}")).toBe("va-");
  });

  it("无引用原样返回", () => {
    expect(expandEnv("plain")).toBe("plain");
  });

  it("非字符串 String 化", () => {
    // assert.equal 宽松相等：expandEnv(42) 返回字符串 "42"，与数字 42 == 相等。
    // 这里取实现契约（String 化），按字符串断言。
    expect(expandEnv(42)).toBe("42");
  });

  it("非法变量名不匹配替换", () => {
    expect(expandEnv("${1BAD}")).toBe("${1BAD}");
  });
});

describe("normalizeScope", () => {
  it("project → SCOPE_PROJECT", () => {
    expect(normalizeScope("project")).toBe(SCOPE_PROJECT);
  });

  it("global → SCOPE_GLOBAL", () => {
    expect(normalizeScope("global")).toBe(SCOPE_GLOBAL);
  });

  it("空串 → SCOPE_GLOBAL", () => {
    expect(normalizeScope("")).toBe(SCOPE_GLOBAL);
  });

  it("大小写敏感回落 global", () => {
    expect(normalizeScope("PROJECT")).toBe(SCOPE_GLOBAL);
  });

  it("未知值回落 global", () => {
    expect(normalizeScope("whatever")).toBe(SCOPE_GLOBAL);
  });
});

describe("createTransport 分派 + StdioTransport 配置缺省", () => {
  const makeStdio = () => createTransport({ transport: "stdio", command: "echo", url: "http://ignored/" });
  const makeWithArgs = () => new StdioTransport({ command: "node", args: ["-v"], env: { K: "v" }, cwd: "/tmp" });

  it("stdio 配置 → StdioTransport", () => {
    expect(makeStdio() instanceof StdioTransport).toBeTruthy();
  });

  it("stdio command 透传", () => {
    expect(makeStdio().command).toBe("echo");
  });

  it("args ?? [] 缺省空数组", () => {
    expect(makeStdio().args).toEqual([]);
  });

  it("env ?? {} 缺省空对象", () => {
    expect(makeStdio().env).toEqual({});
  });

  it("cwd '' | undefined → undefined", () => {
    expect(makeStdio().cwd).toBeUndefined();
  });

  it("stderrTail 初始为空", () => {
    expect(makeStdio().stderrTail).toBe("");
  });

  it("显式 args 透传", () => {
    expect(makeWithArgs().args).toEqual(["-v"]);
  });

  it("显式 env 透传", () => {
    expect(makeWithArgs().env).toEqual({ K: "v" });
  });

  it("显式 cwd 透传", () => {
    expect(makeWithArgs().cwd).toBe("/tmp");
  });

  it("closeReason 初始为通用退出消息", () => {
    // closeReason 初始为通用退出消息；onerror 更新 closeReason。
    expect(makeWithArgs().closeReason.message).toMatch(/exited \(command=node\)/);
  });

  it("onerror 记录最近错误", () => {
    const withArgs = makeWithArgs();
    const boom = new Error("boom");
    withArgs.sdk.onerror(boom);
    expect(withArgs.closeReason).toBe(boom);
  });

  it("onClose 叠加链全部触发", () => {
    // onClose 叠加而非覆盖：先注册 A 再注册 B，触发时两者都收到 closeReason。
    const withArgs = makeWithArgs();
    const seen = [];
    withArgs.onClose((e) => seen.push(["a", e.message]));
    withArgs.onClose((e) => seen.push(["b", e.message]));
    withArgs.sdk.onclose();
    expect(seen.length).toBe(2);
  });

  it("onClose 叠加链保持注册顺序", () => {
    const withArgs = makeWithArgs();
    const seen = [];
    withArgs.onClose((e) => seen.push(["a", e.message]));
    withArgs.onClose((e) => seen.push(["b", e.message]));
    withArgs.sdk.onclose();
    expect(seen.map((x) => x[0])).toEqual(["a", "b"]);
  });

  it("stdio connect() 为空操作 resolve（不抛）", async () => {
    // connect() 为空操作 resolve。
    await expect(makeStdio().connect()).resolves.toBeUndefined();
  });

  it("http 配置 → HttpTransport", () => {
    const http = createTransport({ transport: "streamable-http", url: "http://localhost:1/mcp" });
    expect(http instanceof HttpTransport).toBeTruthy();
  });

  it("http url 透传", () => {
    const http = createTransport({ transport: "streamable-http", url: "http://localhost:1/mcp" });
    expect(http.url).toBe("http://localhost:1/mcp");
  });

  it("http connect() 不抛", async () => {
    const http = createTransport({ transport: "streamable-http", url: "http://localhost:1/mcp" });
    await expect(http.connect()).resolves.toBeUndefined();
  });
});

describe("HttpTransport headers ${ENV} 展开（经 SDK requestInit 面）", () => {
  beforeAll(() => {
    process.env.DSH_MUT_TOK = "tk";
  });

  const makeHttp = () => new HttpTransport("http://localhost:2/mcp", { Authorization: "Bearer ${DSH_MUT_TOK}", Plain: "p" });

  it("SDK requestInit 存在", () => {
    const init = makeHttp().sdk._requestInit;
    expect(init && typeof init === "object").toBeTruthy();
  });

  it("headers 经 expandEnvObject 展开", () => {
    const init = makeHttp().sdk._requestInit;
    expect(init.headers.Authorization).toBe("Bearer tk");
  });

  it("非模板 header 原样保留", () => {
    const init = makeHttp().sdk._requestInit;
    expect(init.headers.Plain).toBe("p");
  });

  it("默认 headers = {}", () => {
    const bare = new HttpTransport("http://localhost:3/mcp");
    expect(bare.headers).toEqual({});
  });
});

describe("parseSsePayload", () => {
  const two = 'data: {"id":1,"m":"a"}\r\n\r\ndata: {"id":2,"m":"b"}\n\n';
  // 多行 data join + 非 data 行忽略 + 坏 JSON 事件跳过。
  const mixed = [
    "event: x",
    "data: not-json",
    "",
    "data: {\"id\":3,",
    "data:  \"ok\":true}",
    "",
  ].join("\r\n");

  it("id 匹配第一个事件", () => {
    expect(parseSsePayload(two, 1).m).toBe("a");
  });

  it("id 匹配第二个事件（\\n 与 \\r\\n 混合分隔）", () => {
    expect(parseSsePayload(two, 2).m).toBe("b");
  });

  it("id 不匹配返回 undefined", () => {
    expect(parseSsePayload(two, 9)).toBeUndefined();
  });

  it("id undefined 返回首个 data", () => {
    expect(parseSsePayload(two, undefined).m).toBe("a");
  });

  it("坏 JSON 跳过、多行 data 合并解析", () => {
    expect(parseSsePayload(mixed, 3)).toEqual({ id: 3, ok: true });
  });

  it("无 data 行跳过", () => {
    expect(parseSsePayload("event: only\n\n", 1)).toBeUndefined();
  });

  it("空文本 undefined", () => {
    expect(parseSsePayload("", 1)).toBeUndefined();
  });
});

describe("MCPClient.requireClient：未初始化抛错", () => {
  it("listTools 未初始化抛错", async () => {
    const client = new MCPClient({ sdk: {} });
    await expect(client.listTools()).rejects.toThrow(/not initialized/);
  });

  it("callTool 未初始化抛错", async () => {
    const client = new MCPClient({ sdk: {} });
    await expect(client.callTool("t")).rejects.toThrow(/not initialized/);
  });
});

describe("MCPClient.initialize：失败路径（命令不存在，stderrTail 空）", () => {
  it("stderrTail 为空时不附 stderr 后缀", async () => {
    const transport = new StdioTransport({ command: "dsh-mcp-missing-cmd-xyz" });
    const client = new MCPClient(transport);
    const err = await client.initialize().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(/\(stderr:/.test(err.message)).toBe(false);
  });

  it("失败后 client 未挂载", async () => {
    const transport = new StdioTransport({ command: "dsh-mcp-missing-cmd-xyz" });
    const client = new MCPClient(transport);
    await client.initialize().catch(() => {});
    expect(client.client).toBeUndefined();
  });
});

describe("MCPClient.initialize：失败路径附 stderr 尾巴", () => {
  it("启动失败附 stderr 尾部", async () => {
    const transport = new StdioTransport({
      command: "sh",
      args: ["-c", "echo dsh-stdi-boom >&2; exit 7"],
    });
    const client = new MCPClient(transport);
    await expect(client.initialize()).rejects.toThrow(/\(stderr: .*boom/);
  });
});

describe("listTools / callTool：参数构造（fake client 记录 request 入参）", () => {
  async function runSequence() {
    const client = new MCPClient({ sdk: {} });
    const calls = [];
    client.client = {
      request: async (params, schema, opts) => {
        calls.push({ params, opts });
        return { ok: true };
      },
    };
    const first = await client.listTools();
    await client.listTools("cur-1");
    await client.callTool("t1", { a: 1 });
    await client.callTool("t2");
    await client.callTool("t3", "not-object");
    const signal = AbortSignal.abort();
    await client.callTool("t4", { b: 2 }, { signal, timeoutMs: 1234 });
    await client.listTools("");
    return { calls, first, signal };
  }

  it("listTools 结果透传", async () => {
    const { first } = await runSequence();
    expect(first.ok).toBe(true);
  });

  it("无 cursor 时 params 省略 cursor 键", async () => {
    const { calls } = await runSequence();
    expect(calls[0].params).toEqual({ method: "tools/list", params: {} });
  });

  it("显式 cursor 透传", async () => {
    const { calls } = await runSequence();
    expect(calls[1].params).toEqual({ method: "tools/list", params: { cursor: "cur-1" } });
  });

  it("callTool 对象 args 构造", async () => {
    const { calls } = await runSequence();
    expect(calls[2].params).toEqual({ method: "tools/call", params: { name: "t1", arguments: { a: 1 } } });
  });

  it("无 args 时省略 arguments 键", async () => {
    const { calls } = await runSequence();
    expect(calls[3].params.params).toEqual({ name: "t2" });
  });

  it("非对象 args 省略 arguments 键", async () => {
    const { calls } = await runSequence();
    expect(calls[4].params.params).toEqual({ name: "t3" });
  });

  it("timeoutMs 透传为 timeout", async () => {
    const { calls } = await runSequence();
    expect(calls[5].opts.timeout).toBe(1234);
  });

  it("signal 透传", async () => {
    const { calls, signal } = await runSequence();
    expect(calls[5].opts.signal).toBe(signal);
  });

  it("空字符串 cursor 仍显式传递", async () => {
    const { calls } = await runSequence();
    expect(calls[6].params.params).toEqual({ cursor: "" });
  });
});
