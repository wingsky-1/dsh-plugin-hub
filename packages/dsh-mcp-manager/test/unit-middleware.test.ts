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
  projectCallToolResult,
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

// ---- #412 force 受控重建：半开 connected entry 不短路 ----
{
  const servers = [{ name: "ctx", transport: "stdio", command: "npx", enabled: true }];
  const { host } = makeHost(new Map([[ROOT, servers]]));
  // 防双进程探测命中（避免真实 spawn；重建落 failed 占位 + 排重试）
  host.ctx.tools.schemas = () => [{ name: "mcp__ctx__t" }];
  const mw = new McpMiddleware(host, {});
  // 直接构造单元（不走 projectUnitFor 惰性连接，测试全程不 spawn）
  const unit = {
    root: ROOT,
    connections: new Map(),
    catalog: new Map(),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  mw.units.set(ROOT, unit);
  // 预置「半开死连接」：status 卡 connected、transport 已静默断链（模拟移动端
  // 切后台掐断 TCP 后 onClose 不触发）。
  const deadTransport = { close: () => { deadTransport.closed = true; return Promise.resolve(); }, closed: false };
  const deadEntry = {
    server: servers[0],
    client: {},
    transport: deadTransport,
    status: "connected",
    error: undefined,
    connectedAt: Date.now(),
    reconnectTimer: undefined,
    disposed: false,
    failedAttempts: 0,
  };
  unit.connections.set("ctx", deadEntry);

  // 非 force：connected 短路——entry 引用与 transport 原样保留（惰性路径防重复建连）。
  await mw.ensureConnected(ROOT, "ctx");
  assert.equal(unit.connections.get("ctx"), deadEntry, "非 force 短路保留原 entry");
  assert.equal(deadTransport.closed, false, "非 force 不 close 旧 transport");

  // force：忽略 connected 状态受控重建——旧 transport 被 close、entry 置 failed
  // + 重试排程（探测命中防双进程路径复用 entry，不再短路）。
  await mw.ensureConnected(ROOT, "ctx", { force: true });
  assert.equal(deadTransport.closed, true, "force 关闭旧 transport（半开 socket 不泄漏）");
  const after = unit.connections.get("ctx");
  assert.equal(after.status, "failed", "force 重建置 failed（防 probeRetry 对 connected 短路死循环）");
  assert.equal(after.transport, undefined, "旧 transport 已清空（重建代际）");
  assert.equal(after.probeRetried, true, "重试已排（probeRetried 一次性标记）");
  if (after.reconnectTimer !== undefined) clearTimeout(after.reconnectTimer);
  await mw.dispose();
}

// ---- #413：runtime 封装定义服务器（toolDefinitions）中间层直呼 ----
{
  const wrappedTool = {
    name: "cg_node",
    description: "查符号（封装定义）",
    parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      render: (args, value) => [{ type: "text", text: `rendered:${value.text}` }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cwd = exec?.agent?.session?.header?.cwd;
      return { text: `node(${args.symbol})@${cwd ?? "no-cwd"}` };
    },
  };
  const wrappedServer = { name: "cg", transport: "stdio", command: "codegraph", enabled: true, toolDefinitions: [wrappedTool] };
  const { host, log } = makeHost(new Map([["@global", [wrappedServer]]]));
  const mw = new McpMiddleware(host, {});
  await mw.projectUnitFor("@global");
  await mw.ensureConnected("@global", "cg");
  const unit = mw.units.get("@global");
  assert.ok(unit, "@global 单元已创建");
  const entry = unit.connections.get("cg");
  assert.ok(entry, "封装定义服务器虚拟连接已建立");
  assert.equal(entry.status, "connected", "虚拟连接状态 connected");
  assert.equal(entry.client, undefined, "不建远端 client（封装 execute 不经远端）");
  assert.equal(entry.transport, undefined, "不 spawn transport");
  // 目录从 toolDefinitions 投影（name/description/parameters → inputSchema）。
  const catalog = unit.catalog.get("cg");
  assert.ok(catalog, "目录已投影");
  assert.equal(catalog.tools.has("cg_node"), true, "封装工具名投影进目录");
  assert.equal(catalog.tools.get("cg_node").description, "查符号（封装定义）");
  assert.deepEqual(catalog.tools.get("cg_node").inputSchema, { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, "parameters 直接作 inputSchema");

  // callTool 封装直呼：execute 被调用 + output.render 投影 content + agent 透传。
  const result = await mw.callTool(fullServerName("@global", "cg"), "cg_node", { symbol: "foo" }, undefined, { session: { header: { cwd: "/proj" } } });
  assert.deepEqual(result, { content: [{ type: "text", text: "rendered:node(foo)@/proj" }], structuredContent: { text: "node(foo)@/proj" } }, "封装直呼：execute + render + agent 透传");
  // agent 缺省 → cwd 解析 undefined。
  const noAgent = await mw.callTool(fullServerName("@global", "cg"), "cg_node", { symbol: "bar" }, undefined);
  assert.deepEqual(noAgent.structuredContent, { text: "node(bar)@no-cwd" }, "agent 缺省不崩（封装侧自处理）");

  // 工具级禁用前置：禁用表命中 → 抛禁用错误（不经 execute）。
  mw.disabledTools.set("@global", new Map([["cg", new Set(["cg_node"])]]));
  await assert.rejects(
    () => mw.callTool(fullServerName("@global", "cg"), "cg_node", { symbol: "x" }, undefined, { session: { header: { cwd: "/p" } } }),
    /已被用户在「MCP」浮窗禁用/,
  );
  mw.disabledTools.delete("@global");

  // 不存在的封装工具名 → 明确报错。
  await assert.rejects(
    () => mw.callTool(fullServerName("@global", "cg"), "nope", {}, undefined),
    /不存在（封装定义服务器）/,
  );

  // persistCatalog 跳过 runtime 条目（isRuntimeServer 命中 → 不写盘）。
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-wrapped-"));
  const persistHost = {
    ...host,
    isRuntimeServer: (name) => name === "cg",
    catalogCachePath: (root) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
  };
  const mw2 = new McpMiddleware(persistHost, {});
  const unit2 = {
    root: "@global",
    connections: new Map([["cg", entry]]),
    catalog: new Map([["cg", catalog], ["storeSrv", { discoveredAt: Date.now(), tools: new Map([["t1", { description: "d", inputSchema: {} }]]) }]]),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
  mw2.units.set("@global", unit2);
  await mw2.persistCatalog("@global");
  const { readFileSync } = await import("node:fs");
  const persisted = readFileSync(persistHost.catalogCachePath("@global"), "utf8");
  assert.equal(persisted.includes("cg"), false, "runtime 条目不写盘");
  assert.equal(persisted.includes("storeSrv"), true, "store 条目照常写盘");
  await mw2.dispose();
  await mw.dispose();
}

// ---- #413：空 toolDefinitions / 封装调用超时兜底 ----
{
  // 空 toolDefinitions：连接照建、目录 0 工具、调用报「不存在」。
  const emptyWrapped = { name: "cg", transport: "stdio", command: "codegraph", enabled: true, toolDefinitions: [] };
  const { host } = makeHost(new Map([["@global", [emptyWrapped]]]));
  const mw = new McpMiddleware(host, {});
  await mw.projectUnitFor("@global");
  await mw.ensureConnected("@global", "cg");
  const unit = mw.units.get("@global");
  assert.equal(unit.connections.get("cg")?.status, "connected", "空 toolDefinitions 仍建虚拟连接");
  assert.equal(unit.catalog.get("cg")?.tools.size, 0, "空 toolDefinitions 目录 0 工具");
  await assert.rejects(
    () => mw.callTool(fullServerName("@global", "cg"), "anything", {}, undefined),
    /不存在（封装定义服务器）/,
  );
  await mw.dispose();

  // 封装 execute 挂起 → withTimeout 超时兜底（不无限等待）。
  const hangingTool = {
    name: "hang",
    description: "挂起",
    parameters: { type: "object", properties: {} },
    output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (a, v) => [{ type: "text", text: v.text }] },
    execute: async () => new Promise(() => {}), // 永不 resolve
  };
  const hangingServer = { name: "hg", transport: "stdio", command: "x", enabled: true, toolDefinitions: [hangingTool] };
  const { host: host2 } = makeHost(new Map([["@global", [hangingServer]]]));
  const mw3 = new McpMiddleware(host2, {});
  await mw3.projectUnitFor("@global");
  await mw3.ensureConnected("@global", "hg");
  await assert.rejects(
    () => mw3.callTool(fullServerName("@global", "hg"), "hang", {}, undefined),
    /封装调用超时/,
  );
  await mw3.dispose();
}

// ---- #512：callTool 远端结果投影收敛（isError/_meta 不泄漏 + 无 content 兜底）----
{
  // 模拟宿主 lossless 校验（与 #381 回归同款，递归断言无 undefined 值键/元素）。
  const assertLossless = (value, path) => {
    if (value === undefined) throw new Error(`lossless 违规：${path} 为 undefined`);
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => assertLossless(item, `${path}[${i}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) assertLossless(entry, `${path}.${key}`);
  };

  async function withFakeClient(remoteResult, { stale = false } = {}) {
    const servers = [{ name: "py", transport: "stdio", command: "python", enabled: true }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = new McpMiddleware(host, {});
    const unit = {
      root: ROOT,
      connections: new Map(),
      catalog: new Map([
        ["py", {
          discoveredAt: stale ? Date.now() - CATALOG_TTL_MS - 1000 : Date.now(),
          tools: new Map([["echo", { description: "回声", inputSchema: { type: "object" } }]]),
          unavailable: undefined,
        }],
      ]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    };
    mw.units.set(ROOT, unit);
    unit.connections.set("py", {
      server: servers[0],
      client: { callTool: async () => remoteResult },
      transport: { close: () => Promise.resolve() },
      status: "connected",
      error: undefined,
      connectedAt: Date.now(),
      reconnectTimer: undefined,
      disposed: false,
      failedAttempts: 0,
    });
    return { mw, dispose: () => mw.dispose() };
  }

  // Python SDK 形态：成功结果必带 isError:false（+ _meta）→ 不得外泄。
  {
    const { mw, dispose } = await withFakeClient({
      content: [{ type: "text", text: "你好" }],
      structuredContent: { answer: 42 },
      isError: false,
      _meta: { trace: "x" },
    });
    const out = await mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined);
    assert.deepEqual(
      { content: out.content, structuredContent: out.structuredContent },
      { content: [{ type: "text", text: "你好" }], structuredContent: { answer: 42 } },
      "#512：isError:false / _meta 不泄漏，白名单字段保留",
    );
    assert.equal(Object.hasOwn(out, "isError"), false, "无 isError 键");
    assert.equal(Object.hasOwn(out, "_meta"), false, "无 _meta 键");
    assertLossless(out, "#512 输出");
    await dispose();
  }

  // isError:true → 抛错（文案含远端错误提示与下一步引导）。
  {
    const { mw, dispose } = await withFakeClient({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    await assert.rejects(
      () => mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined),
      /远端工具返回错误：.*boom.*ws_mcp_detail/,
      "isError:true 抛错且文案可归因",
    );
    // #529：外层 catch 不再追加 detail 建议，同一条错误里「ws_mcp_detail」只出现一次。
    const dupErr = await mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(dupErr instanceof Error, "isError:true 应抛错");
    const detailCount = (dupErr.message.match(/ws_mcp_detail/g) ?? []).length;
    assert.equal(detailCount, 1, `detail 建议只出现一次（实际 ${detailCount} 次：${dupErr.message}）`);
    await dispose();
  }

  // 无 content / 非数组 content → 兜底文本（required content 不落空，lossless 合规）。
  {
    const { mw, dispose } = await withFakeClient({ toolResult: { ok: 1 } });
    const out = await mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined);
    assert.deepEqual(out.content, [{ type: "text", text: '{"ok":1}' }], "toolResult 形态渲染 JSON 兜底");
    assertLossless(out, "#512 兜底");
    await dispose();
  }
  {
    const { mw, dispose } = await withFakeClient({});
    const out = await mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined);
    assert.deepEqual(out.content, [{ type: "text", text: "(no output)" }], "空结果 → (no output) 兜底");
    await dispose();
  }

  // stale（目录过期）：前置 hint + 仍走投影（不透传 isError/_meta）。
  {
    const { mw, dispose } = await withFakeClient(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined);
    assert.equal(out.content.length, 2, "stale 前置 hint");
    assert.match(out.content[0].text, /本工具目录已过期/);
    assert.deepEqual(out.content[1], { type: "text", text: "旧结果" });
    assert.equal(Object.hasOwn(out, "isError"), false, "stale 分支也不泄漏 isError");
    assert.equal(Object.hasOwn(out, "_meta"), false, "stale 分支也不泄漏 _meta");
    assertLossless(out, "#512 stale");
    await dispose();
  }

  // 封装 execute 返回 undefined → 不落 structuredContent 键（#381 同源防御）。
  {
    const voidTool = {
      name: "void_op",
      description: "无返回值",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object", properties: {}, additionalProperties: false }, render: () => [{ type: "text", text: "done" }] },
      execute: async () => undefined,
    };
    const voidServer = { name: "vd", transport: "stdio", command: "x", enabled: true, toolDefinitions: [voidTool] };
    const { host } = makeHost(new Map([["@global", [voidServer]]]));
    const mw = new McpMiddleware(host, {});
    await mw.projectUnitFor("@global");
    await mw.ensureConnected("@global", "vd");
    const out = await mw.callTool(fullServerName("@global", "vd"), "void_op", {}, undefined);
    assert.equal(Object.hasOwn(out, "structuredContent"), false, "封装 execute 返回 undefined 不落 structuredContent 键");
    assertLossless(out, "#512 封装 undefined");
    await mw.dispose();
  }

  // 复核闸 F1：isError:true 且 content 非数组（协议违规形态）→ 走兜底分支时
  // fallbackText 保留远端原文（msgOf，与旧文案行为等价），不丢成 "(no output)"。
  // 注：no-content isError 分支不经 errorText handler（其入参契约为 content
  // 数组），文案经外层 catch 统一包装为「调用失败：<原文>」（#529：外层不再
  // 追加 detail 建议，建议由内层按场景给一次）。
  {
    const { mw, dispose } = await withFakeClient({ isError: true, content: "boom-msg" });
    await assert.rejects(
      () => mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined),
      /调用失败：.*boom-msg/,
      "isError + 非数组 content 错误原文保留",
    );
    await dispose();
  }
  {
    const { mw, dispose } = await withFakeClient({ isError: true, content: 12345 });
    await assert.rejects(
      () => mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined),
      /12345/,
      "isError + 标量 content 同样保留原文",
    );
    await dispose();
  }

  // 复核闸 F5：缺省分支（不传 handlers）——错误文案取 content 内 text 块 join，
  // 无 text 块退化兜底文本；fallbackText 惰性（正常路径零额外计算语义由实现保证）。
  {
    let fallbackCalls = 0;
    const probe = (result, handlers) => projectCallToolResult(result, handlers);
    // 缺省 errorText：text 块 join。
    let thrown;
    try {
      probe({ content: [{ type: "text", text: "e1" }, { type: "text", text: "e2" }], isError: true }, {});
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown.message, "e1\ne2", "缺省 errorText = content 内 text 块 join");
    // 缺省 errorText：无 text 块 → 退化兜底文本。
    thrown = undefined;
    try {
      probe({ content: [{ type: "image", mimeType: "image/png" }], isError: true }, {});
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown.message, "(no output)", "缺省 errorText 无 text 块退化兜底");
    // 注入 fallbackText 但正常 content 路径不消费（惰性：计数不增长）。
    const normal = probe(
      { content: [{ type: "text", text: "ok" }], isError: false },
      { fallbackText: () => { fallbackCalls += 1; return "unused"; } },
    );
    assert.equal(fallbackCalls, 0, "fallbackText 惰性：正常 content 路径不调用");
    assert.deepEqual(normal.content, [{ type: "text", text: "ok" }]);
  }
}
