/**
 * dsh-mcp-manager middleware unit：catalog 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
import type { ListCatalogResult } from "../../src/server/catalog/interface.ts";
// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");
const {
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  isCatalogFresh,
  boundCatalogTools,
} = await import("../../src/server/catalog/interface.ts");
const {
  MAX_BYTES_PER_TOOL,
  CATALOG_TTL_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} = await import("../../src/server/connection/runtime/interface.ts");
const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const seedRoot = middlewareShape.seedRoot.bind(middlewareShape);
const seedRootFromDisk = middlewareShape.seedRootFromDisk.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);
const losslessViolation = middlewareShape.losslessViolation.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

describe("scoreTool / searchCatalog", () => {
  function unitsFixture() {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              [
                "use_ctx",
                {
                  description: "查询 context7 文档",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } },
                },
              ],
              ["search", { description: "search tool", inputSchema: {} }],
            ]),
          },
        ],
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

  it("TTL 过期 → fresh=false", async () => {
    // unitsFixture 恒含 ROOT（同一文件内夹具保证），此处断言存在。
    const unit = unitsFixture().get(ROOT)!;
    await seedRootFromDisk(ROOT, [
      [
        "ctx",
        {
          discoveredAt: Date.now() - CATALOG_TTL_MS - 1000,
          // unitsFixture 刚登记该条目，此处断言存在。
          tools: catalogDirectory.entryFor(ROOT, "ctx")!.tools,
        },
      ],
    ]);
    const stale = searchCatalog(new Map([[ROOT, unit]]), ROOT, "文档", 5);
    expect(stale.results[0]!.fresh).toBe(false);
  });
});

describe("isCatalogFresh", () => {
  it("无条目 → 不新鲜", () => {
    expect(isCatalogFresh(undefined)).toBe(false);
  });

  it("unavailable 段 → 不新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now(), tools: new Map(), unavailable: "x" })).toBe(
      false,
    );
  });

  it("TTL 内 → 新鲜", () => {
    expect(isCatalogFresh({ discoveredAt: Date.now(), tools: new Map() })).toBe(true);
  });

  it("TTL 过期 → 不新鲜", () => {
    expect(
      isCatalogFresh({ discoveredAt: Date.now() - CATALOG_TTL_MS - 1, tools: new Map() }),
    ).toBe(false);
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
    expect(boundCatalogTools(fixtureTools()).get("a")).toEqual({
      description: "alpha",
      inputSchema: { type: "object" },
    });
  });

  it("缺省描述/schema 补空", () => {
    expect(boundCatalogTools(fixtureTools()).get("b")).toEqual({
      description: "",
      inputSchema: {},
    });
  });

  it("非字符串 name String 化、描述归空", () => {
    expect(boundCatalogTools(fixtureTools()).get("42")).toEqual({
      description: "",
      inputSchema: {},
    });
  });

  it("B9：超限描述截断后字节数 ≤ MAX_BYTES_PER_TOOL", () => {
    // 单描述超字节上限 → 按字节截断（B9：旧 slice(0,N) 按字符，多字节超限；
    // 截断点落在字符边界，不产生替换符）
    const bigDescription = "字".repeat(MAX_BYTES_PER_TOOL);
    const truncated = boundCatalogTools([{ name: "big", description: bigDescription }]).get("big")!;
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

describe("searchCatalogMulti：多单元合并检索", () => {
  function multiUnits() {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_ctx", { description: "查询 context7 文档", inputSchema: {} }],
              ["search", { description: "search tool", inputSchema: {} }],
            ]),
          },
        ],
      ]),
    });
    const globalUnit = makeUnit({
      root: "@global",
      catalog: new Map([
        [
          "gctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_g", { description: "全局工具", inputSchema: {} }],
              ["other", { description: "无关", inputSchema: {} }],
            ]),
          },
        ],
      ]),
    });
    return new Map([
      [ROOT, unit],
      ["@global", globalUnit],
    ]);
  }

  it("命中项目单元", () => {
    // 合并查询命中两个单元（项目 root + @global）。
    const multi = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "use", 10);
    expect(multi.results.some((hit) => hit.server === fullServerName(ROOT, "ctx"))).toBeTruthy();
  });

  it("命中 @global 单元", () => {
    const multi = searchCatalogMulti(multiUnits(), [ROOT, "@global"], "use", 10);
    expect(
      multi.results.some((hit) => hit.server === fullServerName("@global", "gctx")),
    ).toBeTruthy();
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

function registerCatalogListOverviewCases() {
  it("workspace 为当前 root", () => {
    expect(listed().workspace).toBe(ROOT);
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
    expect(ctxEntryOf(listed())!.tools.map((t) => t.tool)).toEqual(["t0", "t1"]);
  });

  it("条目 toolsTruncated 为 false", () => {
    expect(ctxEntryOf(listed())!.toolsTruncated).toBe(false);
  });

  it("未禁用服务器 disabled 为 undefined", () => {
    expect(ctxEntryOf(listed())!.disabled).toBeUndefined();
  });

  it("userDisabled → disabled: true", () => {
    expect(offEntryOf(listed())!.disabled).toBe(true);
  });

  it("发现失败附原因", () => {
    expect(downEntryOf(listed())!.unavailable).toBe("连接失败");
  });

  it("发现失败工具列表为空", () => {
    expect(downEntryOf(listed())!.tools).toEqual([]);
  });

  it("非空返回无 message", () => {
    expect(listed().message).toBeUndefined();
  });
}

function registerCatalogListFilterCases() {
  it("server 过滤（裸名）服务器数", () => {
    const filteredBare = listCatalog(listUnits(), [ROOT], "ctx", 50, "empty");
    expect(filteredBare.totalServers).toBe(1);
  });

  it("server 过滤（裸名）返回全名", () => {
    const filteredBare = listCatalog(listUnits(), [ROOT], "ctx", 50, "empty");
    expect(filteredBare.servers[0].server).toBe(fullServerName(ROOT, "ctx"));
  });

  it("server 过滤（全名）", () => {
    const filteredFull = listCatalog(listUnits(), [ROOT], fullServerName(ROOT, "ctx"), 50, "empty");
    expect(filteredFull.totalServers).toBe(1);
  });

  it("全名 root 不属于当前 roots → 路由一致性错误", () => {
    expect(() => listCatalog(listUnits(), [ROOT], "@/other/root/ctx", 50, "empty")).toThrow(
      /不属于当前工作空间/,
    );
  });

  it("合并项目 root + @global", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.totalServers).toBe(4);
  });

  it("两 root 时 workspace 为第一个 root", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.workspace).toBe(ROOT);
  });

  it("含 @global 服务器", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.servers.some((s) => s.server === fullServerName("@global", "gctx"))).toBeTruthy();
  });

  it("合并后工具总数为 6", () => {
    const all = listCatalog(listUnits(), [ROOT, "@global"], undefined, 50, "empty");
    expect(all.totalTools).toBe(6);
  });
}

function registerCatalogListLimitCases() {
  it("perServerLimit 截断到 1 条", () => {
    // perServerLimit 截断 → toolsTruncated（per-server + 全局汇总）
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(ctxEntryOf(truncated)!.tools.length).toBe(1);
  });

  it("per-server toolsTruncated", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(ctxEntryOf(truncated)!.toolsTruncated).toBe(true);
  });

  it("全局 toolsTruncated", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(truncated.toolsTruncated).toBe(true);
  });

  it("未超限不置位", () => {
    const truncated = listCatalog(listUnits(), [ROOT], undefined, 1, "empty");
    expect(offEntryOf(truncated)!.toolsTruncated).toBe(false);
  });
}

function registerCatalogListEmptyCases() {
  it("空返回 totalServers 为 0", () => {
    // 空返回 → message
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.totalServers).toBe(0);
  });

  it("空返回 totalTools 为 0", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.totalTools).toBe(0);
  });

  it("空返回带 message", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.message).toBe("无项目级 MCP 配置提示");
  });

  it("空返回 toolsTruncated 为 false", () => {
    const empty = listCatalog(new Map(), [ROOT], undefined, 50, "无项目级 MCP 配置提示");
    expect(empty.toolsTruncated).toBe(false);
  });

  it("LIST_DEFAULT_TOOLS_PER_SERVER 常量", () => {
    expect(LIST_DEFAULT_TOOLS_PER_SERVER).toBe(50);
  });

  it("LIST_MAX_TOOLS_PER_SERVER 常量", () => {
    expect(LIST_MAX_TOOLS_PER_SERVER).toBe(500);
  });
}

function registerCatalogListDisabledCases() {
  it.each(["t0", "t1"])("未禁用条目不写 disabled 键（%s）", (tool) => {
    // t0/t1 恒在清单内（同一夹具），此处断言存在。
    const entry = ctxEntryOf(listed())!.tools.find((t) => t.tool === tool)!;
    expect(Object.hasOwn(entry, "disabled")).toBe(false);
  });

  it("服务器级禁用仍写 disabled 键", () => {
    expect(Object.hasOwn(offEntryOf(listed())!, "disabled")).toBe(true);
  });

  // #381 回归：工具级禁用路径——禁用条目写 disabled: true，未禁用条目无键。
  function withDisabled() {
    const disabledMap = new Map([[ROOT, new Map([["ctx", new Set(["t0"])]])]]);
    return listCatalog(listUnits(), [ROOT], undefined, 50, "empty", disabledMap);
  }
  const ctxWDOf = (result: ListCatalogResult) =>
    result.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));

  it("t0 被禁用 → disabled: true", () => {
    expect(ctxWDOf(withDisabled())!.tools[0].disabled).toBe(true);
  });

  it("禁用条目存在 disabled 键", () => {
    expect(Object.hasOwn(ctxWDOf(withDisabled())!.tools[0], "disabled")).toBe(true);
  });

  it("t1 未禁用 → 无 disabled 键", () => {
    expect(Object.hasOwn(ctxWDOf(withDisabled())!.tools[1], "disabled")).toBe(false);
  });

  // #381 回归：模拟宿主 lossless 校验（递归断言输出树无 undefined 值键/元素）。
  it("listed 输出 lossless 合规", () => {
    expect(losslessViolation(listed(), "listed")).toBeUndefined();
  });

  it("withDisabled 输出 lossless 合规", () => {
    expect(losslessViolation(withDisabled(), "withDisabled")).toBeUndefined();
  });
}
const mkTools = (count: number) => {
  const tools = new Map();
  for (let i = 0; i < count; i += 1)
    tools.set(`t${i}`, { description: `desc${i}`, inputSchema: {} });
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
  return new Map([
    [ROOT, unit],
    ["@global", globalUnit],
  ]);
}
const listed = () => listCatalog(listUnits(), [ROOT], undefined, 50, "empty");
const ctxEntryOf = (result: ListCatalogResult) =>
  result.servers.find((s) => s.server === fullServerName(ROOT, "ctx"));
const offEntryOf = (result: ListCatalogResult) =>
  result.servers.find((s) => s.server === fullServerName(ROOT, "off"));
const downEntryOf = (result: ListCatalogResult) =>
  result.servers.find((s) => s.server === fullServerName(ROOT, "down"));
describe("listCatalog：完整清单 / 过滤 / 空返回 / 截断 / unavailable / disabled", () => {
  // 完整清单（单 root）

  registerCatalogListOverviewCases();
  registerCatalogListFilterCases();
  registerCatalogListLimitCases();
  registerCatalogListEmptyCases();
  registerCatalogListDisabledCases();
});

function registerCatalogDetailProjectionCases() {
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
    const normalized = findToolDetail(
      detailUnits(),
      ROOT,
      fullServerName(ROOT, "ctx"),
      "mcp__ctx__use_ctx",
    );
    expect(normalized.tool).toBe("use_ctx");
  });

  it("归一化后 schema 不变", () => {
    const normalized = findToolDetail(
      detailUnits(),
      ROOT,
      fullServerName(ROOT, "ctx"),
      "mcp__ctx__use_ctx",
    );
    expect(normalized.inputSchema).toEqual(schema);
  });
}

function registerCatalogDetailErrorCases() {
  it("跨 server 前缀 → 疑似其他", () => {
    expect(() =>
      findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "mcp__other__tool"),
    ).toThrow(/疑似其他/);
  });

  it("错误三分 1：server 发现失败（附原因）", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "down"), "x")).toThrow(
      /发现失败.*连接失败/,
    );
  });

  it("错误三分 2：服务器未发现", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "nope"), "x")).toThrow(
      /未连接或未发现/,
    );
  });

  it("错误三分 2b：单元未激活", () => {
    expect(() =>
      findToolDetail(detailUnits(), "/no/such", fullServerName("/no/such", "ctx"), "x"),
    ).toThrow(/未连接或未发现/);
  });

  it("错误三分 3：工具不存在", () => {
    expect(() => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "nope")).toThrow(
      /tool 不存在/,
    );
  });

  it("路由一致性：参数 root ≠ 路由 root → 拒绝", () => {
    expect(() =>
      findToolDetail(detailUnits(), ROOT, fullServerName("@global", "ctx"), "x"),
    ).toThrow(/不属于当前工作空间/);
  });

  it("用户禁用标注 disabled", () => {
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([
              ["use_ctx", { description: "查询 context7 文档", inputSchema: schema }],
            ]),
          },
        ],
      ]),
      userDisabled: ["ctx"],
    });
    const disabledDetail = findToolDetail(
      new Map([[ROOT, unit]]),
      ROOT,
      fullServerName(ROOT, "ctx"),
      "use_ctx",
    );
    expect(disabledDetail.disabled).toBe(true);
  });

  it("禁用且目录空 → 未连接（附禁用说明）", () => {
    const unit = makeUnit({
      catalog: new Map([["ctx", { discoveredAt: 0, tools: new Map() }]]),
      userDisabled: ["ctx"],
    });
    expect(() =>
      findToolDetail(new Map([[ROOT, unit]]), ROOT, fullServerName(ROOT, "ctx"), "x"),
    ).toThrow(/已被用户禁用/);
  });
}
const schema = {
  type: "object",
  properties: { query: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } },
  required: ["query"],
};
function detailUnits() {
  const unit = makeUnit({
    catalog: new Map([
      [
        "ctx",
        {
          discoveredAt: Date.now(),
          tools: new Map([["use_ctx", { description: "查询 context7 文档", inputSchema: schema }]]),
        },
      ],
      ["down", { discoveredAt: 0, tools: new Map(), unavailable: "连接失败" }],
    ]),
  });
  return new Map([[ROOT, unit]]);
}
const detail = () => findToolDetail(detailUnits(), ROOT, fullServerName(ROOT, "ctx"), "use_ctx");
describe("findToolDetail：精确命中 / 完整 schema / 错误三分 / tool 归一化", () => {
  registerCatalogDetailProjectionCases();
  registerCatalogDetailErrorCases();
});

describe("B9 红测：boundCatalogTools 描述截断按字节", () => {
  it("B9：截断后描述字节数 ≤ MAX_BYTES_PER_TOOL（现状 slice 按字符 → 超限，红测）", () => {
    // "字" 每字符 3 字节：2000 字 = 6000 字节 > MAX_BYTES_PER_TOOL(4096)
    const bigDesc = "字".repeat(2000);
    const bounded = boundCatalogTools([{ name: "t1", description: bigDesc, inputSchema: {} }]);
    // 刚装箱的键恒存在，此处断言存在。
    const desc = bounded.get("t1")!.description;
    expect(Buffer.byteLength(desc, "utf8") <= MAX_BYTES_PER_TOOL).toBeTruthy();
  });
});

describe("B10 红测：searchCatalogMulti 恰好 limit 命中不误报 truncated", () => {
  function multiFixture() {
    const cata = new Map([
      [
        "s1",
        {
          server: "s1",
          tools: new Map([
            ["alpha", { name: "alpha", description: "alpha tool", inputSchema: {} }],
            ["beta", { name: "beta", description: "beta tool", inputSchema: {} }],
          ]),
        },
      ],
    ]);
    // 目录内存态归 catalog 域：这里登记进域，单元只留「在册」这一层。
    seedRoot(
      ROOT,
      new Map(
        [...cata].map(([serverName, entry]) => [
          serverName,
          { discoveredAt: Date.now(), tools: entry.tools },
        ]),
      ),
    );
    const fakeUnit: ProjectUnit = {
      root: ROOT,
      connections: new Map(),
      userDisabled: new Set(),
      inFlight: new Map(),
      lastTouchedAt: Date.now(),
    };
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
