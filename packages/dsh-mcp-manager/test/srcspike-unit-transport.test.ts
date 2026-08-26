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
import assert from "node:assert/strict";

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
} = await import("../src/index.ts");

// ---- expandEnv ----

{
  process.env.DSH_MUT_TEST_A = "va";
  delete process.env.DSH_MUT_TEST_B;
  assert.equal(expandEnv("${DSH_MUT_TEST_A}"), "va", "已设置变量展开");
  assert.equal(expandEnv("x${DSH_MUT_TEST_B}y"), "xy", "未设置变量展开为空串");
  assert.equal(expandEnv("${DSH_MUT_TEST_A}-${DSH_MUT_TEST_B}"), "va-", "混合展开");
  assert.equal(expandEnv("plain"), "plain", "无引用原样返回");
  assert.equal(expandEnv(42), "42", "非字符串 String 化");
  assert.equal(expandEnv("${1BAD}"), "${1BAD}", "非法变量名不匹配替换");
}

// ---- normalizeScope ----

{
  assert.equal(normalizeScope("project"), SCOPE_PROJECT);
  assert.equal(normalizeScope("global"), SCOPE_GLOBAL);
  assert.equal(normalizeScope(""), SCOPE_GLOBAL);
  assert.equal(normalizeScope("PROJECT"), SCOPE_GLOBAL, "大小写敏感回落 global");
  assert.equal(normalizeScope("whatever"), SCOPE_GLOBAL);
}

// ---- createTransport 分派 + StdioTransport 配置缺省 ----

{
  const stdio = createTransport({ transport: "stdio", command: "echo", url: "http://ignored/" });
  assert.ok(stdio instanceof StdioTransport, "stdio 配置 → StdioTransport");
  assert.equal(stdio.command, "echo");
  assert.deepEqual(stdio.args, [], "args ?? [] 缺省空数组");
  assert.deepEqual(stdio.env, {}, "env ?? {} 缺省空对象");
  assert.equal(stdio.cwd, undefined, "cwd '' | undefined → undefined");
  assert.equal(stdio.stderrTail, "", "stderrTail 初始为空");

  const withArgs = new StdioTransport({ command: "node", args: ["-v"], env: { K: "v" }, cwd: "/tmp" });
  assert.deepEqual(withArgs.args, ["-v"]);
  assert.deepEqual(withArgs.env, { K: "v" });
  assert.equal(withArgs.cwd, "/tmp");

  // closeReason 初始为通用退出消息；onerror 更新 closeReason。
  assert.match(withArgs.closeReason.message, /exited \(command=node\)/);
  const boom = new Error("boom");
  withArgs.sdk.onerror(boom);
  assert.equal(withArgs.closeReason, boom, "onerror 记录最近错误");

  // onClose 叠加而非覆盖：先注册 A 再注册 B，触发时两者都收到 closeReason。
  const seen = [];
  withArgs.onClose((e) => seen.push(["a", e.message]));
  withArgs.onClose((e) => seen.push(["b", e.message]));
  withArgs.sdk.onclose();
  assert.equal(seen.length, 2, "叠加链全部触发");
  assert.deepEqual(seen.map((x) => x[0]), ["a", "b"]);

  // connect() 为空操作 resolve。
  await stdio.connect();

  const http = createTransport({ transport: "streamable-http", url: "http://localhost:1/mcp" });
  assert.ok(http instanceof HttpTransport, "http 配置 → HttpTransport");
  assert.equal(http.url, "http://localhost:1/mcp");
  await http.connect();
}

// ---- HttpTransport headers ${ENV} 展开（经 SDK requestInit 面） ----

{
  process.env.DSH_MUT_TOK = "tk";
  const http = new HttpTransport("http://localhost:2/mcp", { Authorization: "Bearer ${DSH_MUT_TOK}", Plain: "p" });
  const init = http.sdk._requestInit;
  assert.ok(init && typeof init === "object", "SDK requestInit 存在");
  assert.equal(init.headers.Authorization, "Bearer tk", "headers 经 expandEnvObject 展开");
  assert.equal(init.headers.Plain, "p");
  // 默认 headers = {}
  const bare = new HttpTransport("http://localhost:3/mcp");
  assert.deepEqual(bare.headers, {});
}

// ---- parseSsePayload ----

{
  const two = 'data: {"id":1,"m":"a"}\r\n\r\ndata: {"id":2,"m":"b"}\n\n';
  assert.deepEqual(parseSsePayload(two, 1).m, "a", "id 匹配第一个事件");
  assert.deepEqual(parseSsePayload(two, 2).m, "b", "id 匹配第二个事件（\\n 与 \\r\\n 混合分隔）");
  assert.equal(parseSsePayload(two, 9), undefined, "id 不匹配返回 undefined");
  assert.deepEqual(parseSsePayload(two, undefined).m, "a", "id undefined 返回首个 data");

  // 多行 data join + 非 data 行忽略 + 坏 JSON 事件跳过。
  const mixed = [
    "event: x",
    "data: not-json",
    "",
    "data: {\"id\":3,",
    "data:  \"ok\":true}",
    "",
  ].join("\r\n");
  assert.deepEqual(parseSsePayload(mixed, 3), { id: 3, ok: true }, "坏 JSON 跳过、多行 data 合并解析");

  assert.equal(parseSsePayload("event: only\n\n", 1), undefined, "无 data 行跳过");
  assert.equal(parseSsePayload("", 1), undefined, "空文本 undefined");
}

// ---- MCPClient.requireClient：未初始化抛错 ----

{
  const client = new MCPClient({ sdk: {} });
  await assert.rejects(() => client.listTools(), /not initialized/);
  await assert.rejects(() => client.callTool("t"), /not initialized/);
}

// ---- MCPClient.initialize：失败路径（命令不存在，stderrTail 空） ----

{
  const transport = new StdioTransport({ command: "dsh-mcp-missing-cmd-xyz" });
  const client = new MCPClient(transport);
  await assert.rejects(() => client.initialize(), (err) => {
    assert.ok(!/\(stderr:/.test(err.message), "stderrTail 为空时不附 stderr 后缀");
    return true;
  });
  assert.equal(client.client, undefined, "失败后 client 未挂载");
}

// ---- MCPClient.initialize：失败路径附 stderr 尾巴 ----

{
  const transport = new StdioTransport({
    command: "sh",
    args: ["-c", "echo dsh-stdi-boom >&2; exit 7"],
  });
  const client = new MCPClient(transport);
  await assert.rejects(() => client.initialize(), /\(stderr: .*boom/, "启动失败附 stderr 尾部");
}

// ---- listTools / callTool：参数构造（fake client 记录 request 入参） ----

{
  const client = new MCPClient({ sdk: {} });
  const calls = [];
  client.client = {
    request: async (params, schema, opts) => {
      calls.push({ params, opts });
      return { ok: true };
    },
  };

  assert.deepEqual((await client.listTools()).ok, true);
  assert.deepEqual(calls[0].params, { method: "tools/list", params: {} }, "无 cursor 时 params 省略 cursor 键");

  await client.listTools("cur-1");
  assert.deepEqual(calls[1].params, { method: "tools/list", params: { cursor: "cur-1" } });

  await client.callTool("t1", { a: 1 });
  assert.deepEqual(calls[2].params, { method: "tools/call", params: { name: "t1", arguments: { a: 1 } } });

  await client.callTool("t2");
  assert.deepEqual(calls[3].params.params, { name: "t2" }, "无 args 时省略 arguments 键");

  await client.callTool("t3", "not-object");
  assert.deepEqual(calls[4].params.params, { name: "t3" }, "非对象 args 省略 arguments 键");

  const signal = AbortSignal.abort();
  await client.callTool("t4", { b: 2 }, { signal, timeoutMs: 1234 });
  assert.equal(calls[5].opts.timeout, 1234, "timeoutMs 透传为 timeout");
  assert.equal(calls[5].opts.signal, signal);

  await client.listTools("");
  assert.deepEqual(calls[6].params.params, { cursor: "" }, "空字符串 cursor 仍显式传递");
}

console.log("  ok   unit-transport: 解析/环境过滤/协议适配全分支");
