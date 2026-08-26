// @ts-nocheck
/**
 * dsh-mcp-manager — unit：McpStore 持久化全分支 + mcpServers JSON 导入。
 *
 * 覆盖：
 * - McpStore.load：文件不存在重置内存态、损坏 JSON 保持内存态并推进基线、
 *   servers 非 Array 不覆盖
 * - McpStore.save：目录缺失递归创建（两层缺失区分 recursive 语义）、原子写、mtime 基线
 * - changedOnDisk / reloadIfChanged：无基线、外部修改、文件删除
 * - find / upsert（替换不追加）/ remove（未知名 no-op）
 * - fromClaudeEntry / parseClaudeJson：http/sse/stdio 全分支与错误路径
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { McpStore, fromClaudeEntry, parseClaudeJson } = await import("../lib/index.js");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-mcp-store-"));
}

// ---- 构造器初始态 ----

{
  const dir = tempDir();
  try {
    const store = new McpStore(join(dir, "mcp.json"));
    assert.equal(store.data.version, 1);
    assert.equal(store.data.servers.length, 0);
    assert.equal(store.mtimeMs, undefined);
    // 无基线时 changedOnDisk 恒 false（即便文件存在）。
    writeFileSync(join(dir, "mcp.json"), "{}");
    assert.equal(await store.changedOnDisk(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- load：文件不存在 → 重置内存态 + 0 基线 ----

{
  const dir = tempDir();
  try {
    const store = new McpStore(join(dir, "missing.json"));
    store.data.servers.push({ name: "stale", transport: "stdio", command: "x" });
    await store.load();
    assert.equal(store.data.servers.length, 0, "文件不存在应清空内存 servers");
    assert.equal(store.mtimeMs, 0, "文件不存在建立 0 基线");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- load：正常读取 + mtime 基线 ----

{
  const dir = tempDir();
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "a", transport: "stdio", command: "echo" }] }));
  try {
    const store = new McpStore(path);
    await store.load();
    assert.equal(store.data.servers.length, 1);
    assert.equal(store.data.servers[0].name, "a");
    assert.ok(typeof store.mtimeMs === "number" && store.mtimeMs > 0, "load 建立 mtime 基线");
    assert.equal(await store.changedOnDisk(), false, "基线刚建立不应视为变更");

    // 外部修改 mtime → changed；reloadIfChanged 重读并返回 true。
    const future = Date.now() / 1000 + 10;
    utimesSync(path, future, future);
    assert.equal(await store.changedOnDisk(), true);
    writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "b", transport: "stdio", command: "x" }] }));
    utimesSync(path, future, future);
    assert.equal(await store.reloadIfChanged(), true, "磁盘变更触发重读");
    assert.equal(store.data.servers[0].name, "b");
    assert.equal(await store.reloadIfChanged(), false, "基线同步后不再变更");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- load：servers 非 Array → 不覆盖内存 servers ----

{
  const dir = tempDir();
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers: "nope" }));
  try {
    const store = new McpStore(path);
    store.data.servers.push({ name: "keep", transport: "stdio", command: "x" });
    await store.load();
    assert.equal(store.data.servers.length, 1, "非法 servers 应保留内存态");
    assert.equal(store.data.servers[0].name, "keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- load：损坏 JSON → 保持内存态，仍推进基线 ----

{
  const dir = tempDir();
  const path = join(dir, "mcp.json");
  writeFileSync(path, "{broken json!");
  try {
    const store = new McpStore(path);
    store.data.servers.push({ name: "kept", transport: "stdio", command: "x" });
    await store.load();
    assert.equal(store.data.servers.length, 1, "损坏存储保持内存态");
    assert.ok(typeof store.mtimeMs === "number" && store.mtimeMs > 0, "仍推进基线避免反复重读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- save：目录两层缺失 → recursive 创建；原子写 + 基线更新 ----

{
  const dir = tempDir();
  const path = join(dir, "l1", "l2", "mcp.json");
  try {
    const store = new McpStore(path);
    store.upsert({ name: "s", transport: "stdio", command: "echo" });
    await store.save();
    assert.ok(existsSync(path), "recursive mkdir 后写入成功");
    assert.ok(JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")).servers[0].name === "s");
    assert.ok(store.mtimeMs > 0, "save 更新 mtime 基线");
    assert.equal(await store.changedOnDisk(), false);

    // 文件被删除后 current=0 !== 基线 → 变更。
    rmSync(path);
    assert.equal(await store.changedOnDisk(), true, "文件删除视为变更");
    // 删除后 reload：文件不存在分支再次清空。
    store.data.servers.push({ name: "ghost", transport: "stdio", command: "x" });
    assert.equal(await store.reloadIfChanged(), true);
    assert.equal(store.data.servers.length, 0, "删除后重读清空配置");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- find / upsert / remove ----

{
  const dir = tempDir();
  try {
    const store = new McpStore(join(dir, "mcp.json"));
    assert.equal(store.find("nope"), undefined);
    store.upsert({ name: "a", transport: "stdio", command: "1" });
    store.upsert({ name: "b", transport: "stdio", command: "2" });
    store.upsert({ name: "a", transport: "stdio", command: "3" });
    assert.equal(store.data.servers.length, 2, "upsert 已有名替换不追加");
    assert.equal(store.find("a").command, "3");
    assert.equal(store.find("b").command, "2");
    store.remove("nope");
    assert.equal(store.data.servers.length, 2, "remove 未知名 no-op");
    store.remove("a");
    assert.equal(store.data.servers.length, 1);
    assert.equal(store.find("a"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- fromClaudeEntry：http / sse / stdio 全分支 ----

{
  // type=http + url → streamable-http
  const http = fromClaudeEntry("h", { type: "http", url: "http://localhost:9/x" });
  assert.equal(http.transport, "streamable-http");
  assert.equal(http.url, "http://localhost:9/x");

  // type=sse 视为 http 族
  const sse = fromClaudeEntry("e", { type: "sse", url: "http://s/" });
  assert.equal(sse.transport, "streamable-http");

  // url 条目缺 url → 抛错
  assert.throws(() => fromClaudeEntry("bad", { type: "http" }), /missing url/);
  assert.throws(() => fromClaudeEntry("bad", { url: "" }), /missing url/);

  // headers 合入；非对象 headers 忽略
  const withHeaders = fromClaudeEntry("h2", { url: "http://h/", headers: { Authorization: "Bearer ${T}" }, env: { A: "1" } });
  assert.deepEqual(withHeaders.headers, { Authorization: "Bearer ${T}" });
  assert.deepEqual(withHeaders.sourceEnv, ["A"], "http 条目 env 记录来源 keys");
  const noEnv = fromClaudeEntry("h3", { url: "http://h/", env: {} });
  assert.equal(noEnv.sourceEnv, undefined, "空 env 不设 sourceEnv");

  // stdio：完整映射
  const stdio = fromClaudeEntry("c", { command: "npx", args: ["-y", 42], cwd: "/w", env: { K: 1, N: null } });
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.command, "npx");
  assert.deepEqual(stdio.args, ["-y", "42"], "args map String");
  assert.equal(stdio.cwd, "/w");
  assert.deepEqual(stdio.env, { K: "1", N: "null" }, "env 值 String 化");

  // stdio：可选字段缺省
  const bare = fromClaudeEntry("c2", { command: "x" });
  assert.equal(bare.cwd, undefined);
  assert.equal(bare.args, undefined);
  assert.equal(bare.env, undefined);
  const emptyCwd = fromClaudeEntry("c3", { command: "x", cwd: "" });
  assert.equal(emptyCwd.cwd, undefined, "空 cwd 不设置");
  const nonArrayArgs = fromClaudeEntry("c4", { command: "x", args: "not-array" });
  assert.equal(nonArrayArgs.args, undefined, "非数组 args 忽略");

  // 缺 command 且无 url → unsupported
  assert.throws(() => fromClaudeEntry("bad2", {}), /unsupported entry/);
  assert.throws(() => fromClaudeEntry("bad3", { command: "" }), /unsupported entry/);
}

// ---- parseClaudeJson：形状校验 ----

{
  const list = parseClaudeJson('{"a":{"command":"x"},"b":{"url":"http://b/"}}');
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "a");
  assert.equal(list[1].transport, "streamable-http");

  assert.throws(() => parseClaudeJson("[1]"), /must be an object/);
  assert.throws(() => parseClaudeJson("null"), /must be an object/);
  assert.throws(() => parseClaudeJson('"s"'), /must be an object/);
  assert.throws(() => parseClaudeJson('{"a":1}'), /entry must be an object/);
  assert.throws(() => parseClaudeJson('{"a":null}'), /entry must be an object/);
  assert.throws(() => parseClaudeJson("{oops"), SyntaxError);
}

console.log("  ok   unit-store: McpStore 全分支 + import 映射");
