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
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  McpMiddleware,
  CATALOG_TTL_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
  userStateFile,
  loadUserState,
  saveUserState,
} = await import("../lib/index.js");

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
  // 未连接（enabled:false 不触发连接）→ 错误含下一步提示（ws_mcp_search 或 ws_mcp_list）
  await assert.rejects(
    () => mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined),
    /未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接/,
  );
  // userDisabled → 错误含下一步提示
  mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
  const disabledUnit = await mw.projectUnitFor(ROOT);
  disabledUnit.userDisabled.add("ctx");
  await assert.rejects(
    () => mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined),
    /已被用户禁用；可先在 GUI「MCP」浮窗中重新连接/,
  );
  disabledUnit.userDisabled.delete("ctx");
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

// ---- searchCatalogMulti：多单元合并检索（all 模式） ----
{
  const unit = {
    root: ROOT,
    connections: new Map(),
    catalog: new Map([
      ["ctx", {
        discoveredAt: Date.now(),
        tools: new Map([
          ["use_ctx", { description: "查询 context7 文档", inputSchema: {} }],
          ["search", { description: "search tool", inputSchema: {} }],
        ]),
      }],
    ]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  const globalUnit = {
    ...unit,
    root: "@global",
    catalog: new Map([
      ["gctx", {
        discoveredAt: Date.now(),
        tools: new Map([
          ["use_g", { description: "全局工具", inputSchema: {} }],
          ["other", { description: "无关", inputSchema: {} }],
        ]),
      }],
    ]),
  };
  const units = new Map([[ROOT, unit], ["@global", globalUnit]]);
  // 合并查询命中两个单元（项目 root + @global）。
  const multi = searchCatalogMulti(units, [ROOT, "@global"], "use", 10);
  assert.ok(multi.results.some((hit) => hit.server === fullServerName(ROOT, "ctx")), "命中项目单元");
  assert.ok(multi.results.some((hit) => hit.server === fullServerName("@global", "gctx")), "命中 @global 单元");
  // 空查询能力摘要同样合并。
  const summary = searchCatalogMulti(units, [ROOT, "@global"], "", 10);
  assert.equal(summary.results.length, 4, "合并摘要含全部工具");
  // 单 root 包装与 multi 单元素等价（且顺序一致——multi 单 root 委托 searchCatalog，P2-2）。
  const single = searchCatalog(units, ROOT, "文档", 10);
  assert.deepEqual(single.results, searchCatalogMulti(units, [ROOT], "文档", 10).results);
  // 多 root 合并后统一按全局 limit 截断（P2-3：limit 为全局上限）。
  const capped = searchCatalogMulti(units, [ROOT, "@global"], "", 2);
  assert.equal(capped.results.length, 2, "多 root 合并后按全局 limit 截断");
  // 无此单元 → 空。
  const none = searchCatalogMulti(units, ["/no/such"], "x", 10);
  assert.equal(none.results.length, 0);
  assert.equal(none.unavailable.length, 0);
}

// ---- listCatalog：完整清单 / 过滤 / 空返回 / 截断 / unavailable / disabled ----
{
  const mkTools = (count) => {
    const tools = new Map();
    for (let i = 0; i < count; i += 1) tools.set(`t${i}`, { description: `desc${i}`, inputSchema: {} });
    return tools;
  };
  const unit = {
    root: ROOT,
    connections: new Map(),
    catalog: new Map([
      // 2 个工具（无截断）
      ["ctx", { discoveredAt: Date.now(), tools: mkTools(2) }],
      // 用户已禁用（工具来自 last-good 目录）
      ["off", { discoveredAt: Date.now(), tools: mkTools(1) }],
      // 发现失败
      ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
    ]),
    userDisabled: new Set(["off"]),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  const globalUnit = {
    ...unit,
    root: "@global",
    catalog: new Map([["gctx", { discoveredAt: Date.now(), tools: mkTools(3) }]]),
    userDisabled: new Set(),
  };
  const units = new Map([[ROOT, unit], ["@global", globalUnit]]);

  // 完整清单（project 模式：单 root）
  const listed = listCatalog(units, [ROOT], undefined, 50, "project", "empty");
  assert.equal(listed.workspace, ROOT);
  assert.equal(listed.mode, "project");
  assert.equal(listed.totalServers, 3, "全部服务器（含 disabled/unavailable）");
  assert.equal(listed.totalTools, 3, "工具数不含 unavailable 服务器");
  assert.equal(listed.toolsTruncated, false);
  const ctxEntry = listed.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));
  assert.deepEqual(ctxEntry.tools.map((t) => t.tool), ["t0", "t1"]);
  assert.equal(ctxEntry.toolsTruncated, false);
  assert.equal(ctxEntry.disabled, undefined);
  const offEntry = listed.servers.find((s) => s.server === fullServerName(ROOT, "off"));
  assert.equal(offEntry.disabled, true, "userDisabled → disabled: true");
  const downEntry = listed.servers.find((s) => s.server === fullServerName(ROOT, "down"));
  assert.equal(downEntry.unavailable, "连接失败", "发现失败附原因");
  assert.deepEqual(downEntry.tools, []);
  assert.equal(listed.message, undefined, "非空返回无 message");

  // server 过滤（裸名）
  const filteredBare = listCatalog(units, [ROOT], "ctx", 50, "project", "empty");
  assert.equal(filteredBare.totalServers, 1);
  assert.equal(filteredBare.servers[0].server, fullServerName(ROOT, "ctx"));
  // server 过滤（全名）
  const filteredFull = listCatalog(units, [ROOT], fullServerName(ROOT, "ctx"), 50, "project", "empty");
  assert.equal(filteredFull.totalServers, 1);
  // 全名 root 不属于当前 roots → 路由一致性错误
  assert.throws(() => listCatalog(units, [ROOT], "@/other/root/ctx", 50, "project", "empty"), /不属于当前工作空间/);

  // all 模式：合并 @global 单元
  const all = listCatalog(units, [ROOT, "@global"], undefined, 50, "all", "empty");
  assert.equal(all.mode, "all");
  assert.equal(all.totalServers, 4, "项目 root + @global 合并");
  assert.equal(all.workspace, ROOT);
  assert.ok(all.servers.some((s) => s.server === fullServerName("@global", "gctx")), "含 @global 服务器");
  assert.equal(all.totalTools, 6);

  // perServerLimit 截断 → toolsTruncated（per-server + 全局汇总）
  const truncated = listCatalog(units, [ROOT], undefined, 1, "project", "empty");
  const ctxT = truncated.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));
  assert.equal(ctxT.tools.length, 1, "截断到 1 条");
  assert.equal(ctxT.toolsTruncated, true, "per-server toolsTruncated");
  assert.equal(truncated.toolsTruncated, true, "全局 toolsTruncated");
  const offT = truncated.servers.find((s) => s.server === fullServerName(ROOT, "off"));
  assert.equal(offT.toolsTruncated, false, "未超限不置位");

  // 空返回 → message（project / all 区分）
  const empty = listCatalog(new Map(), [ROOT], undefined, 50, "project", "无项目级 MCP 配置提示");
  assert.equal(empty.totalServers, 0);
  assert.equal(empty.totalTools, 0);
  assert.equal(empty.message, "无项目级 MCP 配置提示");
  assert.equal(empty.toolsTruncated, false);
  // 常量值
  assert.equal(LIST_DEFAULT_TOOLS_PER_SERVER, 50);
  assert.equal(LIST_MAX_TOOLS_PER_SERVER, 500);

  // #381 回归：未禁用工具条目**不写** disabled 键（显式 undefined 键会被宿主
  // lossless JSON 输出校验判非法 → ws_mcp_list 报 "value is not lossless JSON"）。
  for (const tool of ctxEntry.tools) {
    assert.equal(Object.hasOwn(tool, "disabled"), false, `未禁用条目不写 disabled 键（${tool.tool}）`);
  }
  assert.equal(Object.hasOwn(offEntry, "disabled"), true, "服务器级禁用仍写 disabled 键");

  // #381 回归：工具级禁用路径——禁用条目写 disabled: true，未禁用条目无键。
  const disabledMap = new Map([[ROOT, new Map([["ctx", new Set(["t0"])]])]]);
  const withDisabled = listCatalog(units, [ROOT], undefined, 50, "project", "empty", disabledMap);
  const ctxWD = withDisabled.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));
  assert.equal(ctxWD.tools[0].disabled, true, "t0 被禁用 → disabled: true");
  assert.equal(Object.hasOwn(ctxWD.tools[0], "disabled"), true);
  assert.equal(Object.hasOwn(ctxWD.tools[1], "disabled"), false, "t1 未禁用 → 无 disabled 键");

  // #381 回归：模拟宿主 lossless 校验（递归断言输出树无 undefined 值键/元素）。
  const assertLossless = (value, path) => {
    if (value === undefined) throw new Error(`lossless 违规：${path} 为 undefined`);
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => assertLossless(item, `${path}[${i}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) assertLossless(entry, `${path}.${key}`);
  };
  assertLossless(listed, "listed");
  assertLossless(withDisabled, "withDisabled");
}

// ---- findToolDetail：精确命中 / 完整 schema / 错误三分 / tool 归一化 ----
{
  const schema = { type: "object", properties: { query: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } }, required: ["query"] };
  const unit = {
    root: ROOT,
    connections: new Map(),
    catalog: new Map([
      ["ctx", {
        discoveredAt: Date.now(),
        tools: new Map([
          ["use_ctx", { description: "查询 context7 文档", inputSchema: schema }],
        ]),
      }],
      ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
    ]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  const units = new Map([[ROOT, unit]]);
  // 精确命中：完整 schema + fresh + server/tool 原样
  const detail = findToolDetail(units, ROOT, fullServerName(ROOT, "ctx"), "use_ctx");
  assert.equal(detail.server, fullServerName(ROOT, "ctx"));
  assert.equal(detail.tool, "use_ctx");
  assert.equal(detail.description, "查询 context7 文档");
  assert.deepEqual(detail.inputSchema, schema, "完整 inputSchema（含 enum/required）");
  assert.equal(detail.fresh, true);
  assert.equal(detail.disabled, undefined);
  // tool 归一化（mcp__ 前缀剥离）
  const normalized = findToolDetail(units, ROOT, fullServerName(ROOT, "ctx"), "mcp__ctx__use_ctx");
  assert.equal(normalized.tool, "use_ctx");
  assert.deepEqual(normalized.inputSchema, schema);
  // 跨 server 前缀 → 疑似其他
  assert.throws(() => findToolDetail(units, ROOT, fullServerName(ROOT, "ctx"), "mcp__other__tool"), /疑似其他/);
  // 错误三分 1：server 发现失败（附原因）
  assert.throws(
    () => findToolDetail(units, ROOT, fullServerName(ROOT, "down"), "x"),
    /发现失败.*连接失败/,
  );
  // 错误三分 2：服务器未发现
  assert.throws(
    () => findToolDetail(units, ROOT, fullServerName(ROOT, "nope"), "x"),
    /未连接或未发现/,
  );
  // 错误三分 2b：单元未激活
  assert.throws(
    () => findToolDetail(units, "/no/such", fullServerName("/no/such", "ctx"), "x"),
    /未连接或未发现/,
  );
  // 错误三分 3：工具不存在
  assert.throws(
    () => findToolDetail(units, ROOT, fullServerName(ROOT, "ctx"), "nope"),
    /tool 不存在/,
  );
  // 路由一致性：参数 root ≠ 路由 root → 拒绝
  assert.throws(
    () => findToolDetail(units, ROOT, fullServerName("@global", "ctx"), "x"),
    /不属于当前工作空间/,
  );
  // 用户禁用 → detail 标注 disabled
  const disabledUnit = {
    ...unit,
    userDisabled: new Set(["ctx"]),
  };
  const disabledDetail = findToolDetail(new Map([[ROOT, disabledUnit]]), ROOT, fullServerName(ROOT, "ctx"), "use_ctx");
  assert.equal(disabledDetail.disabled, true, "用户禁用标注 disabled");
  // 禁用且目录空 → 未连接（附禁用说明）
  const disabledEmpty = {
    ...disabledUnit,
    catalog: new Map([["ctx", { discoveredAt: 0, tools: new Map() }]]),
  };
  assert.throws(
    () => findToolDetail(new Map([[ROOT, disabledEmpty]]), ROOT, fullServerName(ROOT, "ctx"), "x"),
    /已被用户禁用/,
  );
}
