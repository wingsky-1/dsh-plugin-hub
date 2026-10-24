// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 服务器规范化与条目映射纯函数族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 normalizeServer / fromClaudeEntry /
// parseClaudeJson / publicToolName / expandEnv it 族整块迁入本文件。fullName 与断言逐字保留
// （顶层 it 原名，不新增 describe 层级）。
import { expect, it } from "vitest";
import {
  fromClaudeEntry,
  normalizeServer,
  parseClaudeJson,
  publicToolName,
} from "../../lib/index.js";
import { expandEnv } from "../../src/server/config/interface.ts";

it("stdio 服务器规范化", () => {
  const server = normalizeServer({
    name: "context7-stdio",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@context7/mcp-server"],
    env: { CONTEXT7_API_KEY: "abc" },
    description: "上下文检索（自定义描述）",
  });
  expect(server.name).toBe("context7-stdio");
  expect(server.transport).toBe("stdio");
  expect(server.enabled).toBe(true);
  expect(server.command).toBe("npx");
  expect(server.args).toEqual(["-y", "@context7/mcp-server"]);
  expect(server.toolCallTimeoutMs, "超时默认下探至 15s").toBe(15_000);
  expect(server.description).toBe("上下文检索（自定义描述）");
  expect(
    normalizeServer({ name: "a", transport: "stdio", command: "x", description: "  " }).description,
    "空白描述归一为 undefined",
  ).toBe(undefined);
  expect(
    normalizeServer({ name: "a", transport: "stdio", command: "x", description: "长".repeat(200) })
      .description?.length,
    "描述完整返回不截断",
  ).toBe(200);
});
it("streamable-http 服务器规范化", () => {
  const server = normalizeServer({
    name: "context7",
    transport: "streamable-http",
    url: "https://mcp.context7.com/mcp",
    headers: { Authorization: "Bearer x" },
  });
  expect(server.transport).toBe("streamable-http");
  expect(server.url).toBe("https://mcp.context7.com/mcp");
  expect(server.headers).toEqual({ Authorization: "Bearer x" });
});
it("非法名称被拒绝", () => {
  expect(() => normalizeServer({ name: "bad name!", transport: "stdio", command: "x" })).toThrow();
  expect(() => normalizeServer({ name: "", transport: "stdio", command: "x" })).toThrow();
});
it("非法传输被拒绝", () => {
  expect(() => normalizeServer({ name: "a", transport: "sse", command: "x" })).toThrow();
});
it("stdio 缺 command 被拒绝", () => {
  expect(() => normalizeServer({ name: "a", transport: "stdio" })).toThrow();
});
it("http 缺 url / 非法 url 被拒绝", () => {
  expect(() => normalizeServer({ name: "a", transport: "streamable-http" })).toThrow();
  expect(() =>
    normalizeServer({ name: "a", transport: "streamable-http", url: "not a url" }),
  ).toThrow();
});
it("B13: http(s) 之外的协议被拒绝（ftp/file 非 streamable-http）", () => {
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "ftp://host/path" }),
    "B13：ftp 协议拒绝",
  ).toThrow(/protocol/);
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "file:///etc/passwd" }),
    "B13：file 协议拒绝",
  ).toThrow(/protocol/);
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "https://host/path" }),
    "https 放行",
  ).not.toThrow();
  expect(
    () => normalizeServer({ name: "a", transport: "streamable-http", url: "http://host/path" }),
    "http 放行",
  ).not.toThrow();
});
it("enabled: false 保留", () => {
  expect(
    normalizeServer({ name: "a", transport: "stdio", command: "x", enabled: false }).enabled,
  ).toBe(false);
});

it("stdio 条目映射", () => {
  const server = fromClaudeEntry("github", {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "tok" },
  });
  expect(server.transport).toBe("stdio");
  expect(server.command).toBe("npx");
  expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
  expect(server.env).toEqual({ GITHUB_TOKEN: "tok" });
});
it("http 条目映射", () => {
  const server = fromClaudeEntry("remote", {
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer x" },
  });
  expect(server.transport).toBe("streamable-http");
  expect(server.url).toBe("https://mcp.example.com/mcp");
});
it("sse 条目按 streamable-http 映射", () => {
  const server = fromClaudeEntry("sse-server", { type: "sse", url: "https://mcp.example.com/sse" });
  expect(server.transport).toBe("streamable-http");
  expect(server.url).toBe("https://mcp.example.com/sse");
});
it("无 command 且无 url 的条目被拒绝", () => {
  expect(() => fromClaudeEntry("bad", { type: "unknown" })).toThrow();
});
it("parseClaudeJson 解析整段 mcpServers", () => {
  const servers = parseClaudeJson(
    JSON.stringify({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      remote: { type: "http", url: "https://mcp.example.com/mcp" },
    }),
  );
  expect(servers.length).toBe(2);
  expect(servers[0].name).toBe("github");
  expect(servers[1].transport).toBe("streamable-http");
});
it("parseClaudeJson 拒绝非法 JSON", () => {
  expect(() => parseClaudeJson("[1,2]")).toThrow();
  expect(() => parseClaudeJson("not json")).toThrow();
});

it("publicToolName 确定性", () => {
  expect(publicToolName("context7", "use_context7")).toBe("mcp__context7__use_context7");
  expect(publicToolName("context7", "use_context7")).toBe(
    publicToolName("context7", "use_context7"),
  );
  expect(publicToolName("a", "b").startsWith("mcp__a__b")).toBeTruthy();
});
it("publicToolName 超长名加哈希后缀", () => {
  const longName = "tool_".repeat(20);
  const pub = publicToolName("server", longName);
  expect(pub.length <= 64).toBeTruthy();
  expect(pub).toMatch(/^[A-Za-z0-9_-]+$/);
});
it("expandEnv 展开 ${ENV}", () => {
  const before = process.env.DSH_MCP_SMOKE_VAR;
  process.env.DSH_MCP_SMOKE_VAR = "hello";
  try {
    expect(expandEnv("Bearer ${DSH_MCP_SMOKE_VAR}")).toBe("Bearer hello");
    expect(expandEnv("x ${DSH_MCP_SMOKE_MISSING_123} y")).toBe("x  y");
  } finally {
    if (before === undefined) delete process.env.DSH_MCP_SMOKE_VAR;
    else process.env.DSH_MCP_SMOKE_VAR = before;
  }
});
