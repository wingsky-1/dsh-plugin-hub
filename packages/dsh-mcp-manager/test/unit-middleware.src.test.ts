// @ts-nocheck
/**
 * dsh-mcp-manager — unit：中间层（ws_mcp_search / ws_mcp_call）。
 *
 * 覆盖：
 * - normalizeMiddlewareMode 归一化（off/project/all/非法）
 * - fullServerName / parseFullServerName（含非法形态）
 * - normalizeToolName（mcp__ 前缀剥离 / 跨 server 拒绝）
 * - normalizeArguments（JSON 字符串参数解析 / 标量保留）
 * - globMatch / policyAllows / policyDenialReason（deny 优先）
 * - scoreTool / searchCatalog（跨字段打分 / unavailable 段 / 空查询摘要）
 * - McpMiddleware：projectUnitFor 惰性创建 + userDisabled 合并 + inFlight 去重
 * - callTool：未知 server / 未连接 / 连接中 / 策略拒绝 / 路由一致性
 * - evictIfNeeded LRU 淘汰
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  normalizeMiddlewareMode,
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeArguments,
  globMatch,
  policyAllows,
  policyDenialReason,
  scoreTool,
  searchCatalog,
  McpMiddleware,
  CATALOG_TTL_MS,
  userStateFile,
  loadUserState,
  saveUserState,
} = await import("../src/index.ts");

const ROOT = "/tmp/ws-root-a";

function makeHost(serversByRoot = new Map()) {
  const log = { emits: 0, saved: 0 };
  const host = {
    ctx: { tools: { register: () => () => {} } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async (root) => serversByRoot.get(root),
    globalServers: () => [],
    normalizedProjectRoot: async (cwd) => (typeof cwd === "string" && cwd !== "" ? cwd : undefined),
    saveUserState: async () => { log.saved += 1; },
    emitStatus: () => { log.emits += 1; },
    catalogCachePath: (root) => join(root, ".dsh-mcp-catalog-test.json"),
  };
  return { host, log };
}

// ---- normalizeMiddlewareMode ----
{
  assert.equal(normalizeMiddlewareMode("off"), "off");
  assert.equal(normalizeMiddlewareMode("project"), "project");
  assert.equal(normalizeMiddlewareMode("all"), "all");
  assert.equal(normalizeMiddlewareMode("bogus"), "off");
  assert.equal(normalizeMiddlewareMode(undefined), "off");
}

// ---- fullServerName / parseFullServerName ----
{
  assert.equal(fullServerName("/a/b", "ctx"), "@/a/b/ctx");
  assert.deepEqual(parseFullServerName("@/a/b/ctx"), { root: "/a/b", server: "ctx" });
  assert.deepEqual(parseFullServerName("@/a/b"), { root: "/a", server: "b" });
  assert.equal(parseFullServerName("ctx"), undefined);
  assert.equal(parseFullServerName("@/"), undefined); // 空 server
  assert.equal(parseFullServerName("@/a/"), undefined); // 空 server
}

// ---- normalizeToolName ----
{
  assert.equal(normalizeToolName("ctx", "use_ctx"), "use_ctx");
  assert.equal(normalizeToolName("ctx", "mcp__ctx__use_ctx"), "use_ctx");
  assert.equal(normalizeToolName("ctx", "mcp__ctx__mcp__ctx__use_ctx"), "use_ctx");
  assert.throws(() => normalizeToolName("ctx", "mcp__other__tool"), /疑似其他/);
}

// ---- normalizeArguments ----
{
  assert.deepEqual(normalizeArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(normalizeArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(normalizeArguments('"[1,2]"'), [1, 2]);
  assert.equal(normalizeArguments("hello"), "hello"); // 标量保留
  assert.deepEqual(normalizeArguments(""), {}); // 空串 → 空对象
}

// ---- globMatch / policy ----
{
  assert.equal(globMatch("*", "anything"), true);
  assert.equal(globMatch("foo", "foo"), true);
  assert.equal(globMatch("foo", "bar"), false);
  assert.equal(globMatch("foo*", "foobar"), true);
  assert.equal(globMatch("foo*", "barfoo"), false);
  const policy = { allowTools: { ctx: ["use_*"] }, denyTools: { ctx: ["use_secret"] } };
  assert.equal(policyAllows(policy, "ctx", "use_ctx"), true);
  assert.equal(policyAllows(policy, "ctx", "use_secret"), false); // deny 优先
  assert.equal(policyAllows(policy, "ctx", "other"), false); // 不在 allow
  assert.equal(policyAllows(policy, "other", "anything"), true); // 未配置 → 允许
  assert.equal(policyAllows(undefined, "ctx", "x"), true);
  assert.match(policyDenialReason(policy, "ctx", "use_secret"), /denyTools/);
  assert.match(policyDenialReason(policy, "ctx", "other"), /allowTools/);
}

// ---- scoreTool / searchCatalog ----
{
  const unit = {
    root: ROOT,
    connections: new Map(),
    catalog: new Map([
      ["ctx", {
        discoveredAt: Date.now(),
        tools: new Map([
          ["use_ctx", { description: "查询 context7 文档", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
          ["search", { description: "search tool", inputSchema: {} }],
        ]),
      }],
      ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
    ]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  const units = new Map([[ROOT, unit]]);
  const { results, unavailable } = searchCatalog(units, ROOT, "文档", 5);
  assert.ok(results.length >= 1, "命中文档工具");
  assert.equal(results[0].server, fullServerName(ROOT, "ctx"));
  assert.equal(results[0].fresh, true);
  assert.equal(unavailable.length, 1);
  assert.match(unavailable[0].reason, /连接失败/);
  // 空查询 → 能力摘要
  const summary = searchCatalog(units, ROOT, "", 5);
  assert.equal(summary.results.length, 2);
  // TTL 过期 → fresh=false
  const stale = searchCatalog(new Map([[ROOT, { ...unit, catalog: new Map([["ctx", { discoveredAt: Date.now() - CATALOG_TTL_MS - 1000, tools: unit.catalog.get("ctx").tools }]]) }]]), ROOT, "文档", 5);
  assert.equal(stale.results[0].fresh, false);
}

// ---- McpMiddleware：projectUnitFor / userDisabled / inFlight ----
{
  const servers = [{ name: "ctx", transport: "stdio", command: "npx", enabled: true }];
  const { host, log } = makeHost(new Map([[ROOT, servers]]));
  const mw = new McpMiddleware(host, {});
  mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
  const unit = await mw.projectUnitFor(ROOT);
  assert.ok(unit !== undefined);
  assert.equal(unit.userDisabled.has("ctx"), true, "userDisabled 合并");
  assert.equal(unit.connections.size, 0, "惰性：未显式连接前不建连接");
  assert.equal(log.emits, 0);
  // 无项目标记目录 → undefined
  const none = await mw.projectUnitFor("/no/such/root");
  assert.equal(none, undefined);
  await mw.dispose();
}

// ---- callTool：路由一致性 / 未连接 / 策略 ----
{
  // enabled:false → 不触发真实连接（单元测试不 spawn 子进程）
  const servers = [{ name: "ctx", transport: "stdio", command: "npx", enabled: false }];
  const { host } = makeHost(new Map([[ROOT, servers]]));
  const mw = new McpMiddleware(host, { denyTools: { ctx: ["secret"] } });
  await mw.projectUnitFor(ROOT);
  // 路由一致性：参数 root ≠ 路由 root → 拒绝
  await assert.rejects(
    () => mw.callTool("@/other/root/ctx", "use_ctx", {}, undefined),
    /不属于当前工作空间|未激活/,
  );
  // 未知 server 形态
  await assert.rejects(() => mw.callTool("ctx", "use_ctx", {}, undefined), /格式应为/);
  // 未连接（enabled:false 不触发连接）
  await assert.rejects(
    () => mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined),
    /未连接|连接失败/,
  );
  await mw.dispose();
}

// ---- evictIfNeeded LRU ----
{
  const { host } = makeHost(new Map());
  const mw = new McpMiddleware(host, {});
  // 注入 18 个假单元（无服务器配置，projectUnitFor 会返回 undefined —— 直接塞 map）
  for (let index = 0; index < 18; index += 1) {
    mw.units.set(`/root-${index}`, {
      root: `/root-${index}`,
      connections: new Map(),
      catalog: new Map(),
      userDisabled: new Set(),
      lastTouchedAt: 1000 + index,
      inFlight: new Map(),
    });
  }
  mw.evictIfNeeded(16);
  assert.equal(mw.units.size, 16, "LRU 淘汰到上限");
  assert.equal(mw.units.has("/root-0"), false, "最旧被淘汰");
  assert.equal(mw.units.has("/root-17"), true, "最新保留");
  await mw.dispose();
}

// ---- userState 持久化 ----
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-"));
  const file = join(dir, "user-state.json");
  const units = new Map([[ROOT, {
    root: ROOT,
    connections: new Map(),
    catalog: new Map(),
    userDisabled: new Set(["ctx"]),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  }]]);
  await saveUserState(file, units);
  const loaded = await loadUserState(file);
  assert.deepEqual([...loaded.get(ROOT)], ["ctx"]);
  // 损坏文件 → 空
  writeFileSync(file, "{bad json");
  const empty = await loadUserState(file);
  assert.equal(empty.size, 0);
  mkdirSync(join(dir, "sub"));
}

// ---- last-good 目录缓存：loadCatalogCache 读取 / persistCatalog 空采集不写盘 ----
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-cat-"));
  const baseHost = makeHost(new Map());
  const catalogHost = {
    ...baseHost.host,
    catalogCachePath: (root) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
  };
  const mw = new McpMiddleware(catalogHost, {});
  const unit = {
    root: ROOT,
    connections: new Map(),
    catalog: new Map([
      ["ctx", {
        discoveredAt: Date.now(),
        tools: new Map([["use_ctx", { description: "查询文档", inputSchema: {} }]]),
      }],
    ]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  mw.units.set(ROOT, unit);
  await mw.persistCatalog(ROOT);
  const file = catalogHost.catalogCachePath(ROOT);
  assert.equal(existsSync(file), true, "有工具的目录落盘");
  // 空采集不写盘：清空目录后 persist 不覆盖已有缓存（保留 last-good）
  const { readFileSync } = await import("node:fs");
  const before = readFileSync(file, "utf8");
  unit.catalog.get("ctx").tools.clear();
  unit.catalog.get("ctx").unavailable = "failed";
  await mw.persistCatalog(ROOT);
  assert.equal(readFileSync(file, "utf8"), before, "空采集不覆盖已有缓存（保留 last-good）");
  await mw.dispose();
}
