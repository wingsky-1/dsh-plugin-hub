// @ts-nocheck
/**
 * dsh-mcp-manager — unit：中间层（ws_mcp_search / ws_mcp_call）。
 *
 * 覆盖：
 * - normalizeMiddlewareMode 归一化（off/project/all/非法）
 * - fullServerName / parseFullServerName（含非法形态）
 * - normalizeToolName（mcp__ 前缀剥离 / 跨 server 拒绝）
 * - B11 红测：server 名含连续双下划线 → guard 按未知 server 处理（不禁用不误禁）
 * - normalizeArguments（JSON 字符串参数解析 / 标量保留）
 * - globMatch / policyAllows / policyDenialReason（deny 优先）
 * - scoreTool / searchCatalog（跨字段打分 / unavailable 段 / 空查询摘要）
 * - McpMiddleware：projectUnitFor 惰性创建 + userDisabled 合并 + inFlight 去重
 * - callTool：未知 server / 未连接 / 连接中 / 策略拒绝 / 路由一致性
 * - evictIfNeeded LRU 淘汰
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  normalizeMiddlewareMode,
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeArguments,
  createRedactor,
  globMatch,
  policyAllows,
  policyDenialReason,
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  isCatalogFresh,
  boundCatalogTools,
  MAX_BYTES_PER_TOOL,
  McpMiddleware,
  registerMiddlewareTools,
  parseDisabledTools,
  projectCallToolResult,
  CATALOG_TTL_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
  scoreTool,
  MAX_TOTAL_CATALOG_BYTES,
  loadUserState,
  saveUserState,
} = await import("../../src/index.ts");

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

/** 中间层与重连 timer 都是真实副作用：用例结束后统一收口。 */
const trackedMw = [];
const trackedTimers = [];
afterEach(async () => {
  for (const mw of trackedMw) {
    try {
      await mw.dispose();
    } catch {
      // 收口失败不掩盖用例结论
    }
  }
  trackedMw.length = 0;
  for (const timer of trackedTimers) clearTimeout(timer);
  trackedTimers.length = 0;
});

function trackMw(mw) {
  trackedMw.push(mw);
  return mw;
}

function makeUnit({ root = ROOT, catalog = new Map(), userDisabled = [], connections } = {}) {
  return {
    root,
    connections: connections ?? new Map(),
    catalog,
    userDisabled: new Set(userDisabled),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
}

/** 宿主编译期同款 lossless 校验：返回首个违规路径（合规返回 undefined）。 */
function losslessViolation(value, path = "$") {
  if (value === undefined) return `${path} 为 undefined`;
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = losslessViolation(value[i], `${path}[${i}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = losslessViolation(entry, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("normalizeMiddlewareMode", () => {
  it("off 原样", () => {
    expect(normalizeMiddlewareMode("off")).toBe("off");
  });

  it("project 原样", () => {
    expect(normalizeMiddlewareMode("project")).toBe("project");
  });

  it("all 原样", () => {
    expect(normalizeMiddlewareMode("all")).toBe("all");
  });

  it("非法值回落 off", () => {
    expect(normalizeMiddlewareMode("bogus")).toBe("off");
  });

  it("undefined 回落 off", () => {
    expect(normalizeMiddlewareMode(undefined)).toBe("off");
  });
});

describe("fullServerName / parseFullServerName", () => {
  it("fullServerName 拼接 @root/server", () => {
    expect(fullServerName("/a/b", "ctx")).toBe("@/a/b/ctx");
  });

  it("parse 还原 root + server", () => {
    expect(parseFullServerName("@/a/b/ctx")).toEqual({ root: "/a/b", server: "ctx" });
  });

  it("parse 以最后一段为 server", () => {
    expect(parseFullServerName("@/a/b")).toEqual({ root: "/a", server: "b" });
  });

  it("裸名 parse 为 undefined", () => {
    expect(parseFullServerName("ctx")).toBeUndefined();
  });

  it("空 server 形态 → undefined（@/）", () => {
    expect(parseFullServerName("@/")).toBeUndefined();
  });

  it("空 server 形态 → undefined（@/a/）", () => {
    expect(parseFullServerName("@/a/")).toBeUndefined();
  });
});

describe("normalizeToolName", () => {
  it("裸工具名原样", () => {
    expect(normalizeToolName("ctx", "use_ctx")).toBe("use_ctx");
  });

  it("剥离 mcp__ 前缀", () => {
    expect(normalizeToolName("ctx", "mcp__ctx__use_ctx")).toBe("use_ctx");
  });

  it("多重前缀一并剥离", () => {
    expect(normalizeToolName("ctx", "mcp__ctx__mcp__ctx__use_ctx")).toBe("use_ctx");
  });

  it("跨 server 前缀抛错", () => {
    expect(() => normalizeToolName("ctx", "mcp__other__tool")).toThrow(/疑似其他/);
  });
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

describe("globMatch / policy", () => {
  const policy = { allowTools: { ctx: ["use_*"] }, denyTools: { ctx: ["use_secret"] } };

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

  it("allow 命中允许", () => {
    expect(policyAllows(policy, "ctx", "use_ctx")).toBe(true);
  });

  it("deny 优先于 allow", () => {
    expect(policyAllows(policy, "ctx", "use_secret")).toBe(false);
  });

  it("不在 allow 拒绝", () => {
    expect(policyAllows(policy, "ctx", "other")).toBe(false);
  });

  it("未配置 server 允许", () => {
    expect(policyAllows(policy, "other", "anything")).toBe(true);
  });

  it("无策略允许", () => {
    expect(policyAllows(undefined, "ctx", "x")).toBe(true);
  });

  it("deny 命中理由指向 denyTools", () => {
    expect(policyDenialReason(policy, "ctx", "use_secret")).toMatch(/denyTools/);
  });

  it("不在 allow 理由指向 allowTools", () => {
    expect(policyDenialReason(policy, "ctx", "other")).toMatch(/allowTools/);
  });
});

describe("scoreTool / searchCatalog", () => {
  function unitsFixture() {
    const unit = makeUnit({
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
    });
    return new Map([[ROOT, unit]]);
  }

  it("命中文档工具", () => {
    const { results } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(results.length >= 1).toBeTruthy();
  });

  it("命中条目 server 为全名", () => {
    const { results } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(results[0].server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("命中条目 fresh 为 true", () => {
    const { results } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(results[0].fresh).toBe(true);
  });

  it("unavailable 段随结果返回", () => {
    const { unavailable } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(unavailable.length).toBe(1);
  });

  it("unavailable 段带失败原因", () => {
    const { unavailable } = searchCatalog(unitsFixture(), ROOT, "文档", 5);
    expect(unavailable[0].reason).toMatch(/连接失败/);
  });

  it("空查询 → 能力摘要", () => {
    const summary = searchCatalog(unitsFixture(), ROOT, "", 5);
    expect(summary.results.length).toBe(2);
  });

  it("TTL 过期 → fresh=false", () => {
    const unit = unitsFixture().get(ROOT);
    const stale = searchCatalog(
      new Map([[ROOT, { ...unit, catalog: new Map([["ctx", { discoveredAt: Date.now() - CATALOG_TTL_MS - 1000, tools: unit.catalog.get("ctx").tools }]]) }]]),
      ROOT,
      "文档",
      5,
    );
    expect(stale.results[0].fresh).toBe(false);
  });
});

// isCatalogFresh / boundCatalogTools（#592 discover 拆解出的纯函数） ----
describe("isCatalogFresh", () => {
  it("无条目 → 不新鲜", () => {
    expect(isCatalogFresh(undefined)).toBe(false);
  });

  it("unavailable 段 → 不新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now(), tools: new Map(), unavailable: "x" })).toBe(false);
  });

  it("TTL 内 → 新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now(), tools: new Map() })).toBe(true);
  });

  it("TTL 过期 → 不新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now() - CATALOG_TTL_MS - 1, tools: new Map() })).toBe(false);
  });
});

describe("boundCatalogTools", () => {
  // 装箱：常规映射 + 空名跳过 + 非字符串描述归空 + schema 缺省 {}
  const fixtureTools = () => [
    { name: "a", description: "alpha", inputSchema: { type: "object" } },
    { name: "", description: "空名跳过" },
    { name: "b" },
    { name: 42, description: 7 },
  ];

  it("空名跳过后剩 3 个", () => {
    expect(boundCatalogTools(fixtureTools()).size).toBe(3);
  });

  it("常规条目原样映射", () => {
    expect(boundCatalogTools(fixtureTools()).get("a")).toEqual({ description: "alpha", inputSchema: { type: "object" } });
  });

  it("缺省描述/schema 补空", () => {
    expect(boundCatalogTools(fixtureTools()).get("b")).toEqual({ description: "", inputSchema: {} });
  });

  it("非字符串 name String 化、描述归空", () => {
    expect(boundCatalogTools(fixtureTools()).get("42")).toEqual({ description: "", inputSchema: {} });
  });

  it("B9：超限描述截断后字节数 ≤ MAX_BYTES_PER_TOOL", () => {
    // 单描述超字节上限 → 按字节截断（B9：旧 slice(0,N) 按字符，多字节超限；
    // 截断点落在字符边界，不产生替换符）
    const bigDescription = "字".repeat(MAX_BYTES_PER_TOOL);
    const truncated = boundCatalogTools([{ name: "big", description: bigDescription }]).get("big");
    expect(Buffer.byteLength(truncated.description, "utf8") <= MAX_BYTES_PER_TOOL).toBeTruthy();
  });

  it("前提：原描述字节超限", () => {
    const bigDescription = "字".repeat(MAX_BYTES_PER_TOOL);
    expect(Buffer.byteLength(bigDescription, "utf8") > MAX_BYTES_PER_TOOL).toBeTruthy();
  });

  it("总字节超限后停止装箱", () => {
    const fatSchema = { data: "x".repeat(200 * 1024) };
    const stopAtLimit = boundCatalogTools([
      { name: "one", description: "", inputSchema: fatSchema },
      { name: "two", description: "", inputSchema: fatSchema },
      { name: "three", description: "", inputSchema: fatSchema },
    ]);
    expect(stopAtLimit.size < 3).toBeTruthy();
  });
});

// McpMiddleware：projectUnitFor / userDisabled / inFlight ----
describe("McpMiddleware：projectUnitFor / userDisabled / inFlight", () => {
  async function projectUnitFixture() {
    const servers = [{ name: "ctx", transport: "stdio", command: "npx", enabled: true }];
    const { host, log } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
    const unit = await mw.projectUnitFor(ROOT);
    return { mw, unit, log };
  }

  it("项目单元已创建", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit !== undefined).toBeTruthy();
  });

  it("userDisabled 合并", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit.userDisabled.has("ctx")).toBe(true);
  });

  it("惰性：未显式连接前不建连接", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit.connections.size).toBe(0);
  });

  it("惰性创建不广播状态", async () => {
    const { log } = await projectUnitFixture();
    expect(log.emits).toBe(0);
  });

  it("无项目标记目录 → undefined", async () => {
    const { mw } = await projectUnitFixture();
    const none = await mw.projectUnitFor("/no/such/root");
    expect(none).toBeUndefined();
  });
});

// callTool：路由一致性 / 未连接 / 策略 ----
describe("callTool：路由一致性 / 未连接 / 策略", () => {
  async function callToolFixture() {
    // enabled:false → 不触发真实连接（单元测试不 spawn 子进程）
    const servers = [{ name: "ctx", transport: "stdio", command: "npx", enabled: false }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, { denyTools: { ctx: ["secret"] } }));
    await mw.projectUnitFor(ROOT);
    return mw;
  }

  it("路由一致性：参数 root ≠ 路由 root → 拒绝", async () => {
    const mw = await callToolFixture();
    await expect(mw.callTool("@/other/root/ctx", "use_ctx", {}, undefined)).rejects.toThrow(
      /不属于当前工作空间|未激活/,
    );
  });

  it("未知 server 形态 → 格式错误", async () => {
    const mw = await callToolFixture();
    await expect(mw.callTool("ctx", "use_ctx", {}, undefined)).rejects.toThrow(/格式应为/);
  });

  it("未连接 → 错误含下一步提示（ws_mcp_search 或 ws_mcp_list）", async () => {
    const mw = await callToolFixture();
    await expect(mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined)).rejects.toThrow(
      /未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接/,
    );
  });

  it("userDisabled → 错误含 GUI 重连提示", async () => {
    const mw = await callToolFixture();
    mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
    const disabledUnit = await mw.projectUnitFor(ROOT);
    disabledUnit.userDisabled.add("ctx");
    await expect(mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined)).rejects.toThrow(
      /已被用户禁用；可先在 GUI「MCP」浮窗中重新连接/,
    );
  });
});

// evictIfNeeded LRU ----
describe("evictIfNeeded LRU", () => {
  function evictedFixture() {
    const { host } = makeHost(new Map());
    const mw = trackMw(new McpMiddleware(host, {}));
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
    return mw;
  }

  it("LRU 淘汰到上限", () => {
    expect(evictedFixture().units.size).toBe(16);
  });

  it("最旧被淘汰", () => {
    expect(evictedFixture().units.has("/root-0")).toBe(false);
  });

  it("最新保留", () => {
    expect(evictedFixture().units.has("/root-17")).toBe(true);
  });
});

// userState 持久化 ----
describe("userState 持久化", () => {
  async function saveAndLoad() {
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
    mkdirSync(join(dir, "sub"));
    return { file, loaded };
  }

  it("saveUserState/loadUserState 往返", async () => {
    const { loaded } = await saveAndLoad();
    expect([...loaded.get(ROOT)]).toEqual(["ctx"]);
  });

  it("损坏文件 → 空", async () => {
    const { file } = await saveAndLoad();
    writeFileSync(file, "{bad json");
    const empty = await loadUserState(file);
    expect(empty.size).toBe(0);
  });
});

// last-good 目录缓存：loadCatalogCache 读取 / persistCatalog 空采集不写盘 ----
describe("last-good 目录缓存", () => {
  function cacheFixture() {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-cat-"));
    const baseHost = makeHost(new Map());
    const catalogHost = {
      ...baseHost.host,
      catalogCachePath: (root) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost, {}));
    const unit = makeUnit({
      catalog: new Map([
        ["ctx", {
          discoveredAt: Date.now(),
          tools: new Map([["use_ctx", { description: "查询文档", inputSchema: {} }]]),
        }],
      ]),
    });
    mw.units.set(ROOT, unit);
    return { mw, unit, catalogHost };
  }

  it("有工具的目录落盘", async () => {
    const { mw, catalogHost } = cacheFixture();
    await mw.persistCatalog(ROOT);
    expect(existsSync(catalogHost.catalogCachePath(ROOT))).toBe(true);
  });

  it("空采集不覆盖已有缓存（保留 last-good）", async () => {
    const { mw, unit, catalogHost } = cacheFixture();
    await mw.persistCatalog(ROOT);
    const file = catalogHost.catalogCachePath(ROOT);
    const before = readFileSync(file, "utf8");
    // 空采集不写盘：清空目录后 persist 不覆盖已有缓存（保留 last-good）
    unit.catalog.get("ctx").tools.clear();
    unit.catalog.get("ctx").unavailable = "failed";
    await mw.persistCatalog(ROOT);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

// searchCatalogMulti：多单元合并检索（all 模式） ----
describe("searchCatalogMulti：多单元合并检索", () => {
  function multiUnits() {
    const unit = makeUnit({
      catalog: new Map([
        ["ctx", {
          discoveredAt: Date.now(),
          tools: new Map([
            ["use_ctx", { description: "查询 context7 文档", inputSchema: {} }],
            ["search", { description: "search tool", inputSchema: {} }],
          ]),
        }],
      ]),
    });
    const globalUnit = makeUnit({
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
    });
    return new Map([[ROOT, unit], ["@global", globalUnit]]);
  }

  it("命中项目单元", () => {
    // 合并查询命中两个单元（项目 root + @global）。
    const multi = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "use", 10);
    expect(multi.results.some((hit) => hit.server === fullServerName(ROOT, "ctx"))).toBeTruthy();
  });

  it("命中 @global 单元", () => {
    const multi = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "use", 10);
    expect(multi.results.some((hit) => hit.server === fullServerName("@global", "gctx"))).toBeTruthy();
  });

  it("合并摘要含全部工具", () => {
    // 空查询能力摘要同样合并。
    const summary = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "", 10);
    expect(summary.results.length).toBe(4);
  });

  it("单 root 包装与 multi 单元素等价（顺序一致）", () => {
    const units = multiUnits();
    // 单 root 包装与 multi 单元素等价（且顺序一致——multi 单 root 委托 searchCatalog，P2-2）。
    const single = searchCatalog(units, ROOT, "文档", 10);
    expect(single.results).toEqual(searchCatalogMulti(units, [ROOT], "文档", 10).results);
  });

  it("多 root 合并后按全局 limit 截断", () => {
    // 多 root 合并后统一按全局 limit 截断（P2-3：limit 为全局上限）。
    const capped = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "", 2);
    expect(capped.results.length).toBe(2);
  });

  it("无此单元 → 空结果", () => {
    const none = searchCatalogMulti(multiUnits(), ["/no/such"], "x", 10);
    expect(none.results.length).toBe(0);
  });

  it("无此单元 → 无 unavailable", () => {
    const none = searchCatalogMulti(multiUnits(), ["/no/such"], "x", 10);
    expect(none.unavailable.length).toBe(0);
  });
});

// listCatalog：完整清单 / 过滤 / 空返回 / 截断 / unavailable / disabled ----
describe("listCatalog：完整清单 / 过滤 / 空返回 / 截断 / unavailable / disabled", () => {
  const mkTools = (count) => {
    const tools = new Map();
    for (let i = 0; i < count; i += 1) tools.set(`t${i}`, { description: `desc${i}`, inputSchema: {} });
    return tools;
  };

  function listUnits() {
    const unit = makeUnit({
      catalog: new Map([
        // 2 个工具（无截断）
        ["ctx", { discoveredAt: Date.now(), tools: mkTools(2) }],
        // 用户已禁用（工具来自 last-good 目录）
        ["off", { discoveredAt: Date.now(), tools: mkTools(1) }],
        // 发现失败
        ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
      ]),
      userDisabled: ["off"],
    });
    const globalUnit = makeUnit({
      root: "@global",
      catalog: new Map([["gctx", { discoveredAt: Date.now(), tools: mkTools(3) }]]),
    });
    return new Map([[ROOT, unit], ["@global", globalUnit]]);
  }

  // 完整清单（project 模式：单 root）
  const listed = () => listCatalog(listUnits(), [ROOT], undefined, 50, "project", "empty");
  const ctxEntryOf = (result) => result.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));
  const offEntryOf = (result) => result.servers.find((s) => s.server === fullServerName(ROOT, "off"));
  const downEntryOf = (result) => result.servers.find((s) => s.server === fullServerName(ROOT, "down"));

  it("workspace 为当前 root", () => {
    expect(listed().workspace).toBe(ROOT);
  });

  it("mode 回显", () => {
    expect(listed().mode).toBe("project");
  });

  it("全部服务器（含 disabled/unavailable）", () => {
    expect(listed().totalServers).toBe(3);
  });

  it("工具数不含 unavailable 服务器", () => {
    expect(listed().totalTools).toBe(3);
  });

  it("全局 toolsTruncated 为 false", () => {
    expect(listed().toolsTruncated).toBe(false);
  });

  it("服务器条目工具名保序", () => {
    expect(ctxEntryOf(listed()).tools.map((t) => t.tool)).toEqual(["t0", "t1"]);
  });

  it("条目 toolsTruncated 为 false", () => {
    expect(ctxEntryOf(listed()).toolsTruncated).toBe(false);
  });

  it("未禁用服务器 disabled 为 undefined", () => {
    expect(ctxEntryOf(listed()).disabled).toBeUndefined();
  });

  it("userDisabled → disabled: true", () => {
    expect(offEntryOf(listed()).disabled).toBe(true);
  });

  it("发现失败附原因", () => {
    expect(downEntryOf(listed()).unavailable).toBe("连接失败");
  });

  it("发现失败工具列表为空", () => {
    expect(downEntryOf(listed()).tools).toEqual([]);
  });

  it("非空返回无 message", () => {
    expect(listed().message).toBeUndefined();
  });

  it("server 过滤（裸名）服务器数", () => {
    const filteredBare = listCatalog(listUnits(), [ROOT], "ctx", 50, "project", "empty");
    expect(filteredBare.totalServers).toBe(1);
  });

  it("server 过滤（裸名）返回全名", () => {
    const filteredBare = listCatalog(listUnits(), [ROOT], "ctx", 50, "project", "empty");
    expect(filteredBare.servers[0].server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("server 过滤（全名）", () => {
    const filteredFull = listCatalog(listUnits(), [ROOT], fullServerName(ROOT, "ctx"), 50, "project", "empty");
    expect(filteredFull.totalServers).toBe(1);
  });

  it("全名 root 不属于当前 roots → 路由一致性错误", () => {
    expect(() => listCatalog(listUnits(), [ROOT], "@/other/root/ctx", 50, "project", "empty")).toThrow(
      /不属于当前工作空间/,
    );
  });

  it("all 模式回显", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "all", "empty");
    expect(all.mode).toBe("all");
  });

  it("all 模式合并项目 root + @global", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "all", "empty");
    expect(all.totalServers).toBe(4);
  });

  it("all 模式 workspace 仍为项目 root", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "all", "empty");
    expect(all.workspace).toBe(ROOT);
  });

  it("all 模式含 @global 服务器", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "all", "empty");
    expect(all.servers.some((s) => s.server === fullServerName("@global", "gctx"))).toBeTruthy();
  });

  it("all 模式工具总数为 6", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "all", "empty");
    expect(all.totalTools).toBe(6);
  });

  it("perServerLimit 截断到 1 条", () => {
    // perServerLimit 截断 → toolsTruncated（per-server + 全局汇总）
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "project", "empty");
    expect(ctxEntryOf(truncated).tools.length).toBe(1);
  });

  it("per-server toolsTruncated", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "project", "empty");
    expect(ctxEntryOf(truncated).toolsTruncated).toBe(true);
  });

  it("全局 toolsTruncated", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "project", "empty");
    expect(truncated.toolsTruncated).toBe(true);
  });

  it("未超限不置位", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "project", "empty");
    expect(offEntryOf(truncated).toolsTruncated).toBe(false);
  });

  it("空返回 totalServers 为 0", () => {
    // 空返回 → message（project / all 区分）
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "project", "无项目级 MCP 配置提示");
    expect(empty.totalServers).toBe(0);
  });

  it("空返回 totalTools 为 0", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "project", "无项目级 MCP 配置提示");
    expect(empty.totalTools).toBe(0);
  });

  it("空返回带 message", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "project", "无项目级 MCP 配置提示");
    expect(empty.message).toBe("无项目级 MCP 配置提示");
  });

  it("空返回 toolsTruncated 为 false", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "project", "无项目级 MCP 配置提示");
    expect(empty.toolsTruncated).toBe(false);
  });

  it("LIST_DEFAULT_TOOLS_PER_SERVER 常量", () => {
    expect(LIST_DEFAULT_TOOLS_PER_SERVER).toBe(50);
  });

  it("LIST_MAX_TOOLS_PER_SERVER 常量", () => {
    expect(LIST_MAX_TOOLS_PER_SERVER).toBe(500);
  });

  // #381 回归：未禁用工具条目**不写** disabled 键（显式 undefined 键会被宿主
  // lossless JSON 输出校验判非法 → ws_mcp_list 报 "value is not lossless JSON"）。
  it.each(["t0", "t1"])("未禁用条目不写 disabled 键（%s）", (tool) => {
    const entry = ctxEntryOf(listed()).tools.find((t) => t.tool === tool);
    expect(Object.hasOwn(entry, "disabled")).toBe(false);
  });

  it("服务器级禁用仍写 disabled 键", () => {
    expect(Object.hasOwn(offEntryOf(listed()), "disabled")).toBe(true);
  });

  // #381 回归：工具级禁用路径——禁用条目写 disabled: true，未禁用条目无键。
  function withDisabled() {
    const disabledMap = new Map([[ROOT, new Map([["ctx", new Set(["t0"])]])]]);
    return listCatalog(listUnits(), [ROOT], undefined, 50, "project", "empty", disabledMap);
  }
  const ctxWDOf = (result) => result.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));

  it("t0 被禁用 → disabled: true", () => {
    expect(ctxWDOf(withDisabled()).tools[0].disabled).toBe(true);
  });

  it("禁用条目存在 disabled 键", () => {
    expect(Object.hasOwn(ctxWDOf(withDisabled()).tools[0], "disabled")).toBe(true);
  });

  it("t1 未禁用 → 无 disabled 键", () => {
    expect(Object.hasOwn(ctxWDOf(withDisabled()).tools[1], "disabled")).toBe(false);
  });

  // #381 回归：模拟宿主 lossless 校验（递归断言输出树无 undefined 值键/元素）。
  it("listed 输出 lossless 合规", () => {
    expect(losslessViolation(listed(), "listed")).toBeUndefined();
  });

  it("withDisabled 输出 lossless 合规", () => {
    expect(losslessViolation(withDisabled(), "withDisabled")).toBeUndefined();
  });
});

// findToolDetail：精确命中 / 完整 schema / 错误三分 / tool 归一化 ----
describe("findToolDetail：精确命中 / 完整 schema / 错误三分 / tool 归一化", () => {
  const schema = { type: "object", properties: { query: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } }, required: ["query"] };

  function detailUnits() {
    const unit = makeUnit({
      catalog: new Map([
        ["ctx", {
          discoveredAt: Date.now(),
          tools: new Map([
            ["use_ctx", { description: "查询 context7 文档", inputSchema: schema }],
          ]),
        }],
        ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
      ]),
    });
    return new Map([[ROOT, unit]]);
  }

  const detail = () => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "use_ctx");

  it("命中 server 为全名", () => {
    // 精确命中：完整 schema + fresh + server/tool 原样
    expect(detail().server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("命中 tool 名", () => {
    expect(detail().tool).toBe("use_ctx");
  });

  it("命中描述", () => {
    expect(detail().description).toBe("查询 context7 文档");
  });

  it("完整 inputSchema（含 enum/required）", () => {
    expect(detail().inputSchema).toEqual(schema);
  });

  it("命中 fresh 为 true", () => {
    expect(detail().fresh).toBe(true);
  });

  it("未禁用 disabled 为 undefined", () => {
    expect(detail().disabled).toBeUndefined();
  });

  it("tool 归一化（mcp__ 前缀剥离）", () => {
    const normalized = findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "mcp__ctx__use_ctx");
    expect(normalized.tool).toBe("use_ctx");
  });

  it("归一化后 schema 不变", () => {
    const normalized = findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "mcp__ctx__use_ctx");
    expect(normalized.inputSchema).toEqual(schema);
  });

  it("跨 server 前缀 → 疑似其他", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "mcp__other__tool")).toThrow(/疑似其他/);
  });

  it("错误三分 1：server 发现失败（附原因）", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "down"), "x")).toThrow(/发现失败.*连接失败/);
  });

  it("错误三分 2：服务器未发现", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "nope"), "x")).toThrow(/未连接或未发现/);
  });

  it("错误三分 2b：单元未激活", () => {
    expect(() => findToolDetail(detailUnits(), "/no/such", fullServerName("/no/such", "ctx"), "x")).toThrow(/未连接或未发现/);
  });

  it("错误三分 3：工具不存在", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "nope")).toThrow(/tool 不存在/);
  });

  it("路由一致性：参数 root ≠ 路由 root → 拒绝", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName("@global", "ctx"), "x")).toThrow(/不属于当前工作空间/);
  });

  it("用户禁用标注 disabled", () => {
    const unit = makeUnit({
      catalog: new Map([
        ["ctx", {
          discoveredAt: Date.now(),
          tools: new Map([["use_ctx", { description: "查询 context7 文档", inputSchema: schema }]]),
        }],
      ]),
      userDisabled: ["ctx"],
    });
    const disabledDetail = findToolDetail(new Map([[ROOT, unit]]), ROOT, fullServerName(ROOT, "ctx"), "use_ctx");
    expect(disabledDetail.disabled).toBe(true);
  });

  it("禁用且目录空 → 未连接（附禁用说明）", () => {
    const unit = makeUnit({
      catalog: new Map([["ctx", { discoveredAt: 0, tools: new Map() }]]),
      userDisabled: ["ctx"],
    });
    expect(() => findToolDetail(new Map([[ROOT, unit]]), ROOT, fullServerName(ROOT, "ctx"), "x")).toThrow(/已被用户禁用/);
  });
});

// #412 force 受控重建：半开 connected entry 不短路 ----
describe("#412 force 受控重建：半开 connected entry 不短路", () => {
  function forceFixture() {
    const servers = [{ name: "ctx", transport: "stdio", command: "npx", enabled: true }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    // 防双进程探测命中（避免真实 spawn；重建落 failed 占位 + 排重试）
    host.ctx.tools.schemas = () => [{ name: "mcp__ctx__t" }];
    const mw = trackMw(new McpMiddleware(host, {}));
    // 直接构造单元（不走 projectUnitFor 惰性连接，测试全程不 spawn）
    const unit = makeUnit();
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
    return { mw, unit, deadEntry, deadTransport };
  }

  async function forcedFixture() {
    const fixture = forceFixture();
    // force：忽略 connected 状态受控重建——旧 transport 被 close、entry 置 failed
    // + 重试排程（探测命中防双进程路径复用 entry，不再短路）。
    await fixture.mw.ensureConnected(ROOT, "ctx", { force: true });
    const after = fixture.unit.connections.get("ctx");
    if (after.reconnectTimer !== undefined) trackedTimers.push(after.reconnectTimer);
    return { ...fixture, after };
  }

  it("非 force 短路保留原 entry", async () => {
    const { mw, unit, deadEntry } = forceFixture();
    // 非 force：connected 短路——entry 引用与 transport 原样保留（惰性路径防重复建连）。
    await mw.ensureConnected(ROOT, "ctx");
    expect(unit.connections.get("ctx")).toBe(deadEntry);
  });

  it("非 force 不 close 旧 transport", async () => {
    const { mw, deadTransport } = forceFixture();
    await mw.ensureConnected(ROOT, "ctx");
    expect(deadTransport.closed).toBe(false);
  });

  it("force 关闭旧 transport（半开 socket 不泄漏）", async () => {
    const { deadTransport } = await forcedFixture();
    expect(deadTransport.closed).toBe(true);
  });

  it("force 重建置 failed（防 probeRetry 对 connected 短路死循环）", async () => {
    const { after } = await forcedFixture();
    expect(after.status).toBe("failed");
  });

  it("旧 transport 已清空（重建代际）", async () => {
    const { after } = await forcedFixture();
    expect(after.transport).toBeUndefined();
  });

  it("重试已排（probeRetried 一次性标记）", async () => {
    const { after } = await forcedFixture();
    expect(after.probeRetried).toBe(true);
  });
});

// #413：runtime 封装定义服务器（toolDefinitions）中间层直呼 ----
describe("#413：runtime 封装定义服务器中间层直呼", () => {
  function wrappedGlobalFixture() {
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
    const mw = trackMw(new McpMiddleware(host, {}));
    return { mw, host, log, wrappedServer, wrappedTool };
  }

  async function connected() {
    const fixture = wrappedGlobalFixture();
    await fixture.mw.projectUnitFor("@global");
    await fixture.mw.ensureConnected("@global", "cg");
    const unit = fixture.mw.units.get("@global");
    return { ...fixture, unit, entry: unit.connections.get("cg"), catalog: unit.catalog.get("cg") };
  }

  it("@global 单元已创建", async () => {
    const { unit } = await connected();
    expect(unit).toBeTruthy();
  });

  it("封装定义服务器虚拟连接已建立", async () => {
    const { entry } = await connected();
    expect(entry).toBeTruthy();
  });

  it("虚拟连接状态 connected", async () => {
    const { entry } = await connected();
    expect(entry.status).toBe("connected");
  });

  it("不建远端 client（封装 execute 不经远端）", async () => {
    const { entry } = await connected();
    expect(entry.client).toBeUndefined();
  });

  it("不 spawn transport", async () => {
    const { entry } = await connected();
    expect(entry.transport).toBeUndefined();
  });

  it("目录已投影", async () => {
    const { catalog } = await connected();
    expect(catalog).toBeTruthy();
  });

  it("封装工具名投影进目录", async () => {
    const { catalog } = await connected();
    expect(catalog.tools.has("cg_node")).toBe(true);
  });

  it("封装工具描述投影", async () => {
    const { catalog } = await connected();
    expect(catalog.tools.get("cg_node").description).toBe("查符号（封装定义）");
  });

  it("parameters 直接作 inputSchema", async () => {
    // 目录从 toolDefinitions 投影（name/description/parameters → inputSchema）。
    const { catalog } = await connected();
    expect(catalog.tools.get("cg_node").inputSchema).toEqual({ type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] });
  });

  it("封装直呼：execute + render + agent 透传", async () => {
    // callTool 封装直呼：execute 被调用 + output.render 投影 content + agent 透传。
    const { mw } = await connected();
    const result = await mw.callTool(fullServerName("@global", "cg"), "cg_node", { symbol: "foo" }, undefined, { session: { header: { cwd: "/proj" } } });
    expect(result).toEqual({ content: [{ type: "text", text: "rendered:node(foo)@/proj" }], structuredContent: { text: "node(foo)@/proj" } });
  });

  it("agent 缺省不崩（封装侧自处理）", async () => {
    const { mw } = await connected();
    // agent 缺省 → cwd 解析 undefined。
    const noAgent = await mw.callTool(fullServerName("@global", "cg"), "cg_node", { symbol: "bar" }, undefined);
    expect(noAgent.structuredContent).toEqual({ text: "node(bar)@no-cwd" });
  });

  it("工具级禁用前置：禁用表命中 → 抛禁用错误（不经 execute）", async () => {
    const { mw } = await connected();
    mw.disabledTools.set("@global", new Map([["cg", new Set(["cg_node"])]]));
    await expect(
      mw.callTool(fullServerName("@global", "cg"), "cg_node", { symbol: "x" }, undefined, { session: { header: { cwd: "/p" } } }),
    ).rejects.toThrow(/已被用户在「MCP」浮窗禁用/);
  });

  it("不存在的封装工具名 → 明确报错", async () => {
    const { mw } = await connected();
    await expect(mw.callTool(fullServerName("@global", "cg"), "nope", {}, undefined)).rejects.toThrow(
      /不存在（封装定义服务器）/,
    );
  });

  // persistCatalog 跳过 runtime 条目（isRuntimeServer 命中 → 不写盘）。
  function persistFixture() {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-mw-wrapped-"));
    const { host } = makeHost(new Map());
    const persistHost = {
      ...host,
      isRuntimeServer: (name) => name === "cg",
      catalogCachePath: (root) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw2 = trackMw(new McpMiddleware(persistHost, {}));
    const unit2 = makeUnit({
      root: "@global",
      catalog: new Map([
        ["cg", { discoveredAt: Date.now(), tools: new Map([["cg_node", { description: "d", inputSchema: {} }]]) }],
        ["storeSrv", { discoveredAt: Date.now(), tools: new Map([["t1", { description: "d", inputSchema: {} }]]) }],
      ]),
    });
    mw2.units.set("@global", unit2);
    return { mw2, persistHost };
  }

  it("runtime 条目不写盘", async () => {
    const { mw2, persistHost } = persistFixture();
    await mw2.persistCatalog("@global");
    const persisted = readFileSync(persistHost.catalogCachePath("@global"), "utf8");
    expect(persisted.includes("cg")).toBe(false);
  });

  it("store 条目照常写盘", async () => {
    const { mw2, persistHost } = persistFixture();
    await mw2.persistCatalog("@global");
    const persisted = readFileSync(persistHost.catalogCachePath("@global"), "utf8");
    expect(persisted.includes("storeSrv")).toBe(true);
  });
});

// #413：空 toolDefinitions / 封装调用超时兜底 ----
describe("#413：空 toolDefinitions / 封装调用超时兜底", () => {
  async function emptyWrappedConnected() {
    // 空 toolDefinitions：连接照建、目录 0 工具、调用报「不存在」。
    const emptyWrapped = { name: "cg", transport: "stdio", command: "codegraph", enabled: true, toolDefinitions: [] };
    const { host } = makeHost(new Map([["@global", [emptyWrapped]]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    await mw.projectUnitFor("@global");
    await mw.ensureConnected("@global", "cg");
    const unit = mw.units.get("@global");
    return { mw, unit };
  }

  it("空 toolDefinitions 仍建虚拟连接", async () => {
    const { unit } = await emptyWrappedConnected();
    expect(unit.connections.get("cg")?.status).toBe("connected");
  });

  it("空 toolDefinitions 目录 0 工具", async () => {
    const { unit } = await emptyWrappedConnected();
    expect(unit.catalog.get("cg")?.tools.size).toBe(0);
  });

  it("空 toolDefinitions 调用报不存在", async () => {
    const { mw } = await emptyWrappedConnected();
    await expect(mw.callTool(fullServerName("@global", "cg"), "anything", {}, undefined)).rejects.toThrow(
      /不存在（封装定义服务器）/,
    );
  });

  it("封装 execute 挂起 → withTimeout 超时兜底（不无限等待）", { timeout: 60_000 }, async () => {
    const hangingTool = {
      name: "hang",
      description: "挂起",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (a, v) => [{ type: "text", text: v.text }] },
      execute: async () => new Promise(() => {}), // 永不 resolve
    };
    const hangingServer = { name: "hg", transport: "stdio", command: "x", enabled: true, toolDefinitions: [hangingTool] };
    const { host: host2 } = makeHost(new Map([["@global", [hangingServer]]]));
    const mw3 = trackMw(new McpMiddleware(host2, {}));
    await mw3.projectUnitFor("@global");
    await mw3.ensureConnected("@global", "hg");
    await expect(mw3.callTool(fullServerName("@global", "hg"), "hang", {}, undefined)).rejects.toThrow(/封装调用超时/);
  });
});

// #512：callTool 远端结果投影收敛（isError/_meta 不泄漏 + 无 content 兜底）----
describe("#512：callTool 远端结果投影收敛", () => {
  async function withFakeClient(remoteResult, { stale = false } = {}) {
    const servers = [{ name: "py", transport: "stdio", command: "python", enabled: true }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    const unit = makeUnit({
      catalog: new Map([
        ["py", {
          discoveredAt: stale ? Date.now() - CATALOG_TTL_MS - 1000 : Date.now(),
          tools: new Map([["echo", { description: "回声", inputSchema: { type: "object" } }]]),
          unavailable: undefined,
        }],
      ]),
    });
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
    return mw;
  }

  const echo = (mw) => mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined);

  it("#512：isError:false / _meta 不泄漏，白名单字段保留", async () => {
    // Python SDK 形态：成功结果必带 isError:false（+ _meta）→ 不得外泄。
    const mw = await withFakeClient({
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
    const mw = await withFakeClient({ content: [{ type: "text", text: "你好" }], isError: false, _meta: { trace: "x" } });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "isError")).toBe(false);
  });

  it("无 _meta 键", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "你好" }], isError: false, _meta: { trace: "x" } });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#512 输出 lossless 合规", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "你好" }], isError: false });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 输出")).toBeUndefined();
  });

  it("isError:true 抛错且文案可归因", async () => {
    // isError:true → 抛错（文案含远端错误提示与下一步引导）。
    const mw = await withFakeClient({ content: [{ type: "text", text: "boom" }], isError: true });
    await expect(echo(mw)).rejects.toThrow(/远端工具返回错误：.*boom.*ws_mcp_detail/);
  });

  it("isError:true 应抛错（Error 实例）", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "boom" }], isError: true });
    // #529：外层 catch 不再追加 detail 建议，同一条错误里「ws_mcp_detail」只出现一次。
    const dupErr = await echo(mw).then(() => null, (e) => e);
    expect(dupErr instanceof Error).toBeTruthy();
  });

  it("detail 建议只出现一次", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "boom" }], isError: true });
    const dupErr = await echo(mw).then(() => null, (e) => e);
    const detailCount = (dupErr.message.match(/ws_mcp_detail/g) ?? []).length;
    expect(detailCount).toBe(1);
  });

  it("toolResult 形态渲染 JSON 兜底", async () => {
    // 无 content / 非数组 content → 兜底文本（required content 不落空，lossless 合规）。
    const mw = await withFakeClient({ toolResult: { ok: 1 } });
    const out = await echo(mw);
    expect(out.content).toEqual([{ type: "text", text: '{"ok":1}' }]);
  });

  it("#512 兜底 lossless 合规", async () => {
    const mw = await withFakeClient({ toolResult: { ok: 1 } });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 兜底")).toBeUndefined();
  });

  it("空结果 → (no output) 兜底", async () => {
    const mw = await withFakeClient({});
    const out = await echo(mw);
    expect(out.content).toEqual([{ type: "text", text: "(no output)" }]);
  });

  it("stale 前置 hint（内容块数为 2）", async () => {
    // stale（目录过期）：前置 hint + 仍走投影（不透传 isError/_meta）。
    const mw = await withFakeClient(
      { content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } },
      { stale: true },
    );
    const out = await echo(mw);
    expect(out.content.length).toBe(2);
  });

  it("stale hint 文案", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "旧结果" }] }, { stale: true });
    const out = await echo(mw);
    expect(out.content[0].text).toMatch(/本工具目录已过期/);
  });

  it("stale 保留远端原文", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "旧结果" }] }, { stale: true });
    const out = await echo(mw);
    expect(out.content[1]).toEqual({ type: "text", text: "旧结果" });
  });

  it("stale 分支也不泄漏 isError", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } }, { stale: true });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "isError")).toBe(false);
  });

  it("stale 分支也不泄漏 _meta", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "旧结果" }], isError: false, _meta: { t: 1 } }, { stale: true });
    const out = await echo(mw);
    expect(Object.hasOwn(out, "_meta")).toBe(false);
  });

  it("#512 stale lossless 合规", async () => {
    const mw = await withFakeClient({ content: [{ type: "text", text: "旧结果" }] }, { stale: true });
    const out = await echo(mw);
    expect(losslessViolation(out, "#512 stale")).toBeUndefined();
  });

  async function voidOpFixture() {
    // 封装 execute 返回 undefined → 不落 structuredContent 键（#381 同源防御）。
    const voidTool = {
      name: "void_op",
      description: "无返回值",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object", properties: {}, additionalProperties: false }, render: () => [{ type: "text", text: "done" }] },
      execute: async () => undefined,
    };
    const voidServer = { name: "vd", transport: "stdio", command: "x", enabled: true, toolDefinitions: [voidTool] };
    const { host } = makeHost(new Map([["@global", [voidServer]]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    await mw.projectUnitFor("@global");
    await mw.ensureConnected("@global", "vd");
    return mw;
  }

  it("封装 execute 返回 undefined 不落 structuredContent 键", async () => {
    const mw = await voidOpFixture();
    const out = await mw.callTool(fullServerName("@global", "vd"), "void_op", {}, undefined);
    expect(Object.hasOwn(out, "structuredContent")).toBe(false);
  });

  it("#512 封装 undefined lossless 合规", async () => {
    const mw = await voidOpFixture();
    const out = await mw.callTool(fullServerName("@global", "vd"), "void_op", {}, undefined);
    expect(losslessViolation(out, "#512 封装 undefined")).toBeUndefined();
  });

  // 复核闸 F1：isError:true 且 content 非数组（协议违规形态）→ 走兜底分支时
  // fallbackText 保留远端原文（msgOf，与旧文案行为等价），不丢成 "(no output)"。
  // 注：no-content isError 分支不经 errorText handler（其入参契约为 content
  // 数组），文案经外层 catch 统一包装为「调用失败：<原文>」（#529：外层不再
  // 追加 detail 建议，建议由内层按场景给一次）。
  it("isError + 非数组 content 错误原文保留", async () => {
    const mw = await withFakeClient({ isError: true, content: "boom-msg" });
    await expect(echo(mw)).rejects.toThrow(/调用失败：.*boom-msg/);
  });

  it("isError + 标量 content 同样保留原文", async () => {
    const mw = await withFakeClient({ isError: true, content: 12345 });
    await expect(echo(mw)).rejects.toThrow(/12345/);
  });

  // 复核闸 F5：缺省分支（不传 handlers）——错误文案取 content 内 text 块 join，
  // 无 text 块退化兜底文本；fallbackText 惰性（正常路径零额外计算语义由实现保证）。
  function probe(result, handlers) {
    return projectCallToolResult(result, handlers);
  }

  function thrownOf(fn) {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("缺省 errorText = content 内 text 块 join", () => {
    const thrown = thrownOf(() => probe({ content: [{ type: "text", text: "e1" }, { type: "text", text: "e2" }], isError: true }, {}));
    expect(thrown.message).toBe("e1\ne2");
  });

  it("缺省 errorText 无 text 块退化兜底", () => {
    const thrown = thrownOf(() => probe({ content: [{ type: "image", mimeType: "image/png" }], isError: true }, {}));
    expect(thrown.message).toBe("(no output)");
  });

  it("fallbackText 惰性：正常 content 路径不调用", () => {
    // 注入 fallbackText 但正常 content 路径不消费（惰性：计数不增长）。
    let fallbackCalls = 0;
    probe(
      { content: [{ type: "text", text: "ok" }], isError: false },
      { fallbackText: () => { fallbackCalls += 1; return "unused"; } },
    );
    expect(fallbackCalls).toBe(0);
  });

  it("正常 content 路径透传投影", () => {
    const normal = probe({ content: [{ type: "text", text: "ok" }], isError: false }, {});
    expect(normal.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

// createRedactor 基线（issue #664 阶段 1：先锁现状整 URL 脱敏；B8 改「仅用户
// 信息」口径在阶段 2，届时本基线按新契约修订）----
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
      new Error("failed connect to https://user:pass@example.com/path?token=abc with Bearer secret-token k-123 tok-456"),
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

  // B8 红测（D4 决策：仅用户信息脱敏）：host/path 无凭据应保留可读——
  // 现状整 URL 全部 [REDACTED]，本断言红；commit3 改口径后绿。
  it("B8：host 应保留（仅用户信息脱敏；现状整 URL 脱敏）", () => {
    expect(redacted().includes("example.com")).toBeTruthy();
  });

  it("B8：path 应保留", () => {
    expect(redacted().includes("/path")).toBeTruthy();
  });
});

// B8 红测（续）：percent-encoding raw 形态脱敏对照 ----
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

// B9 红测：boundCatalogTools 描述截断按字节（UTF-8 中文多字节） ----
describe("B9 红测：boundCatalogTools 描述截断按字节", () => {
  it("B9：截断后描述字节数 ≤ MAX_BYTES_PER_TOOL（现状 slice 按字符 → 超限，红测）", () => {
    // "字" 每字符 3 字节：2000 字 = 6000 字节 > MAX_BYTES_PER_TOOL(4096)
    const bigDesc = "字".repeat(2000);
    const bounded = boundCatalogTools([{ name: "t1", description: bigDesc, inputSchema: {} }]);
    const desc = bounded.get("t1").description;
    expect(Buffer.byteLength(desc, "utf8") <= MAX_BYTES_PER_TOOL).toBeTruthy();
  });
});

// B10 红测：searchCatalogMulti 恰好 limit 命中不误报 truncated ----
describe("B10 红测：searchCatalogMulti 恰好 limit 命中不误报 truncated", () => {
  function multiFixture() {
    const cata = new Map([
      ["s1", {
        server: "s1",
        tools: new Map([
          ["alpha", { name: "alpha", description: "alpha tool", inputSchema: {} }],
          ["beta", { name: "beta", description: "beta tool", inputSchema: {} }],
        ]),
      }],
    ]);
    const fakeUnit = { connections: new Map(), catalog: cata, userDisabled: new Set(), inFlight: new Map(), lastTouchedAt: Date.now() };
    return new Map([[ROOT, fakeUnit]]);
  }

  it("恰好 limit=1 命中返回 1 条", () => {
    // 恰好 limit=1 条命中（alpha）
    const r = searchCatalogMulti(multiFixture(), [ROOT], "alpha", 1);
    expect(r.results.length).toBe(1);
  });

  it("B10：恰好 limit 命中不应标 truncated", () => {
    const r = searchCatalogMulti(multiFixture(), [ROOT], "alpha", 1);
    expect(r.truncated).toBe(false);
  });
});

// B18 红测a：callTool 应用 server.toolCallTimeoutMs（现状固定 CALL_TIMEOUT_MS）----
describe("B18 红测a：callTool 应用 server.toolCallTimeoutMs", () => {
  async function withTimeoutServer() {
    const servers = [{ name: "s1", transport: "stdio", command: "echo", enabled: true, toolCallTimeoutMs: 5000 }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    const unit = await mw.projectUnitFor(ROOT);
    const calls = [];
    unit.connections.set("s1", {
      server: { name: "s1", transport: "stdio", command: "echo", enabled: true, toolCallTimeoutMs: 5000 },
      status: "connected",
      connectedAt: Date.now(),
      catalog: new Map(),
      client: {
        callTool: async (tool, args, opts) => {
          calls.push({ tool, args, opts });
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    });
    return { mw, calls };
  }

  it("callTool 正常", async () => {
    const { mw } = await withTimeoutServer();
    const res = await mw.callTool(fullServerName(ROOT, "s1"), "t1", '{"a":1}', undefined);
    expect(res.content[0].text).toBe("ok");
  });

  it("B18：callTool 用 server.toolCallTimeoutMs（现状固定 30000 → 红测）", async () => {
    const { mw, calls } = await withTimeoutServer();
    await mw.callTool(fullServerName(ROOT, "s1"), "t1", '{"a":1}', undefined);
    expect(calls[0].opts.timeoutMs).toBe(5000);
  });
});

// B18 红测b：scheduleReconnect 退避读 server.reconnect（现状硬编码 500 系列）----
describe("B18 红测b：scheduleReconnect 退避读 server.reconnect", () => {
  async function reconnectFixture(connectionOverrides = {}) {
    const servers = [{ name: "s1", transport: "stdio", command: "echo", enabled: true, reconnect: { initialDelayMs: 2000 } }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    const unit = await mw.projectUnitFor(ROOT);
    const entry = {
      server: { name: "s1", transport: "stdio", command: "echo", enabled: true, reconnect: { initialDelayMs: 2000 } },
      status: "failed",
      failedAttempts: 1,
      reconnectTimer: undefined,
      disposed: false,
      ...connectionOverrides,
    };
    unit.connections.set("s1", entry);
    mw.scheduleReconnect(ROOT, "s1");
    if (entry.reconnectTimer !== undefined) trackedTimers.push(entry.reconnectTimer);
    return entry;
  }

  it("scheduleReconnect 建 timer", async () => {
    const entry = await reconnectFixture();
    expect(entry.reconnectTimer !== undefined).toBeTruthy();
  });

  it("B18：退避读 server.reconnect.initialDelayMs（现状 500 → 红测）", async () => {
    const entry = await reconnectFixture();
    expect(entry.reconnectTimer._idleTimeout).toBe(2000);
  });

  it("B4：退避窗口内 entry.status 为 reconnecting", async () => {
    // B4 红测：退避窗口内 entry.status 应为 "reconnecting"（现状保持 failed）
    // summarize 投影/客户端 counts.reconnecting 依赖此态。
    const servers = [{ name: "s1", transport: "stdio", command: "echo", enabled: true, reconnect: { enabled: true, initialDelayMs: 10_000 } }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    const unit = await mw.projectUnitFor(ROOT);
    const entry = {
      server: servers[0],
      status: "failed",
      failedAttempts: 1,
      reconnectTimer: undefined,
      disposed: false,
    };
    unit.connections.set("s1", entry);
    mw.scheduleReconnect(ROOT, "s1");
    if (entry.reconnectTimer !== undefined) trackedTimers.push(entry.reconnectTimer);
    expect(entry.reconnectTimer !== undefined).toBeTruthy();
    expect(entry.status).toBe("reconnecting");
  });
});

// B4 红测（续）：预算耗尽 → failed（与 reconnecting 区分）----
describe("B4 红测（续）：预算耗尽 → failed", () => {
  async function exhaustedFixture() {
    const servers = [{ name: "s1", transport: "stdio", command: "echo", enabled: true, reconnect: { enabled: true, initialDelayMs: 10_000, maxAttempts: 1 } }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    const unit = await mw.projectUnitFor(ROOT);
    const entry = {
      server: servers[0],
      status: "failed",
      failedAttempts: 2,
      reconnectTimer: undefined,
      disposed: false,
    };
    unit.connections.set("s1", entry);
    mw.scheduleReconnect(ROOT, "s1");
    if (entry.reconnectTimer !== undefined) trackedTimers.push(entry.reconnectTimer);
    return entry;
  }

  it("预算耗尽不建 timer", async () => {
    const entry = await exhaustedFixture();
    expect(entry.reconnectTimer).toBeUndefined();
  });

  it("预算耗尽保持 failed（与退避窗口 reconnecting 区分）", async () => {
    const entry = await exhaustedFixture();
    expect(entry.status).toBe("failed");
  });
});

// B18 红测c：reconnect.enabled=false 时不安排后台重试（现状内联解析忽略
// enabled 字段，与 supervisor resolveReconnect 口径分裂）----
describe("B18 红测c：reconnect.enabled=false 不安排后台重试", () => {
  async function disabledReconnectFixture() {
    const servers = [{ name: "s1", transport: "stdio", command: "echo", enabled: true, reconnect: { enabled: false } }];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host, {}));
    const unit = await mw.projectUnitFor(ROOT);
    const entry = {
      server: servers[0],
      status: "failed",
      failedAttempts: 1,
      reconnectTimer: undefined,
      disposed: false,
    };
    unit.connections.set("s1", entry);
    mw.scheduleReconnect(ROOT, "s1");
    if (entry.reconnectTimer !== undefined) trackedTimers.push(entry.reconnectTimer);
    return entry;
  }

  it("B18：reconnect.enabled=false 不安排后台重试（与 supervisor 同口径）", async () => {
    const entry = await disabledReconnectFixture();
    expect(entry.reconnectTimer).toBeUndefined();
  });

  it("B18：enabled=false 保持 failed（不进入退避窗口）", async () => {
    const entry = await disabledReconnectFixture();
    expect(entry.status).toBe("failed");
  });
});

// B11 红测：server 名含连续双下划线 → guard 按未知 server 处理（不禁用不误禁） ----
// D5 定稿：规格化不可逆——含连续双下划线的 server/tool 名无法从注册全名唯一
// 反解（mcp__my__sv__t 既可能是 server="my"+tool="sv__t"，也可能是
// server="my__sv"+tool="t"），guard 按未知 server 处理（放行 next()，不禁用
// 不误禁）；不改 publicToolName/INVALID_NAME_CHARS（防冲击官方 mcp__ 契约）。
// 现状 handleDirectMcpGuard 用第一个 __ 分割 → 错位反解（server="my",
// tool="sv__t"），禁用表若恰有错位形态记录会**误禁**（情形 B）；真实形态记录
// （@global/my__sv → t）则**查错漏禁**（情形 A）。
describe("B11 红测：含连续双下划线 server 名按未知处理", () => {
  function guardFixture(disabledMap) {
    const guards = new Map();
    const ctx = {
      tools: { register: () => () => {} },
      on: (event, handler) => {
        guards.set(event, handler);
        return () => {};
      },
    };
    const host = {
      ctx,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async () => [],
      globalServers: () => [],
      normalizedProjectRoot: async (cwd) => (cwd === "/proj" ? "/proj" : undefined),
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: () => "/tmp/cache.json",
      isGlobalServer: () => false,
    };
    const resolveRoot = async (agent) => (agent?.session?.header?.cwd === "/proj" ? "/proj" : undefined);
    const mw = trackMw(new McpMiddleware(host, {}));
    const dispose = registerMiddlewareTools(ctx, mw, resolveRoot, "project", { disabledTools: disabledMap });
    return { guards, dispose };
  }

  it("pre-execute guard 已注册", () => {
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my: ["sv__t"] } }));
    expect(typeof guards.get("tools/pre-execute") === "function").toBeTruthy();
  });

  it("B11：含连续双下划线名按未知 server 处理，不误禁（现状错位反解会误禁 → 红测）", async () => {
    // 情形 B（红）：禁用表只有「错位形态」记录（@global/my → sv__t，恰好是第一个
    // __ 分割的产物）→ 含 __ 名按未知处理应放行（现状误禁 → 断言红）。
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my: ["sv__t"] } }));
    const decisionB = await guards.get("tools/pre-execute")(
      { name: "mcp__my__sv__t", agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    expect(decisionB.kind).toBe("allow");
  });

  it("B11：真实形态记录同样不命中（不可逆按未知 server 处理）", async () => {
    // 情形 A（防回归）：禁用表只有「真实形态」记录（@global/my__sv → t）→ 同样
    // 不可逆 → 放行（不禁用；现状查错漏禁，修复后保持不误禁不误杀）。
    const { guards } = guardFixture(parseDisabledTools({ "@global": { "my__sv": ["t"] } }));
    const decisionA = await guards.get("tools/pre-execute")(
      { name: "mcp__my__sv__t", agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    expect(decisionA.kind).toBe("allow");
  });
});
