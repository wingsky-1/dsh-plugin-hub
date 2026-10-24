// dsh-mcp-manager 冒烟测试（vitest e2e project）—— catalog 目录纯函数族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 catalog 纯函数 it 族整块迁入本文件
// （composeCatalogEntries 数据源、summarizeToolDescriptions 排序稳定与首句聚合、
// recordCatalogTools 仅实质变化落盘、composeCatalogEntries 条目上限、
// digestCatalogEntries 只含服务器集合、escapeCatalogText 转义、
// renderMcpCatalogMessage 结构与声明、findCatalogMessage 定位既有目录）。
// fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeManagerCtx } from "../helpers.ts";
import { McpManager } from "../../src/server/connection/orchestrator/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import {
  composeCatalogEntries,
  digestCatalogEntries,
  escapeCatalogText,
  summarizeToolDescriptions,
} from "../../src/server/catalog/interface.ts";
import { findCatalogMessage, isCatalogSource, renderMcpCatalogMessage } from "../../lib/index.js";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

it("composeCatalogEntries 数据源（配置优先 → 缓存摘要 → 仅名字）", () => {
  const supervisors = new Map([
    ["srv-a", { server: { description: "自定义描述 A" }, tools: [], toolMeta: new Map() }],
    ["srv-b", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
  ]);
  const cache = new Map([["srv-b", { summary: "缓存摘要 B" }]]);
  const entries = composeCatalogEntries(
    supervisors as unknown as Parameters<typeof composeCatalogEntries>[0],
    6,
    cache,
  );
  expect(entries[0].text, "用户配置优先").toBe("自定义描述 A");
  expect(entries[1].text, "缓存摘要 fallback（无需用户配置）").toBe("缓存摘要 B");
  expect(entries[2].name, "无配置无缓存 → 条目按名称保留").toBe("srv-c");
  expect(
    Object.hasOwn(entries[2], "text"),
    "双缺省条目不含 text 属性（值断言防不了 text: undefined，必须查存在性）",
  ).toBe(false);
  // digest 稳定性：实时连接状态（tools/toolMeta）变化不影响目录 digest
  const connected = new Map([
    [
      "srv-a",
      {
        server: { description: "自定义描述 A" },
        tools: ["t1"],
        toolMeta: new Map([["x", { description: "实时描述" }]]),
      },
    ],
    [
      "srv-b",
      {
        server: { description: undefined },
        tools: ["t1"],
        toolMeta: new Map([["x", { description: "实时描述" }]]),
      },
    ],
    ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
  ]);
  expect(
    digestCatalogEntries(
      composeCatalogEntries(
        connected as unknown as Parameters<typeof composeCatalogEntries>[0],
        6,
        cache,
      ),
    ),
    "连接状态变化 digest 不变（不触发重复注入）",
  ).toBe(digestCatalogEntries(entries));
});
it("summarizeToolDescriptions 排序稳定与首句聚合", () => {
  const meta1 = new Map([
    ["mcp__s__b", { description: "工具 B 的说明文字" }],
    ["mcp__s__a", { description: "工具 A 的说明" }],
  ]);
  const meta2 = new Map([
    ["mcp__s__a", { description: "工具 A 的说明" }],
    ["mcp__s__b", { description: "工具 B 的说明文字" }],
    ["mcp__s__c", { description: "" }],
  ]);
  expect(summarizeToolDescriptions(meta1), "顺序变化摘要稳定").toBe(
    summarizeToolDescriptions(meta2),
  );
  expect(summarizeToolDescriptions(new Map([["x", { description: "  " }]])), "全空描述无摘要").toBe(
    undefined,
  );
  const long = summarizeToolDescriptions(new Map([["x", { description: "长".repeat(100) }]]));
  expect(long, "单句上限内完整返回不截断").toBe("长".repeat(100));
  // 语义，不能被字典序第一条（tavily_crawl）误导成"爬虫服务器"。
  const tavily = new Map([
    ["tavily_search", { description: "Search the web for current information on any topic." }],
    ["tavily_crawl", { description: "Crawl a website starting from a URL." }],
    ["tavily_extract", { description: "Extract content from URLs." }],
    ["tavily_map", { description: "Map a website's structure." }],
    ["tavily_research", { description: "Perform comprehensive research on a given topic." }],
  ]);
  const tavilySummary = summarizeToolDescriptions(tavily)!;
  expect(
    tavilySummary.includes("Search the web"),
    "摘要含 search 语义（防 crawler 误导）",
  ).toBeTruthy();
  expect(tavilySummary.includes("research"), "摘要含 research 语义").toBeTruthy();
  expect(tavilySummary.startsWith("5 tools: "), "多工具前缀标注真实工具数").toBeTruthy();
});
it("recordCatalogTools 仅实质变化落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-catalog-"));
  const store = new McpStore(join(dir, "mcp.json"));
  const manager = new McpManager(fakeManagerCtx(), store);
  manager.catalogCachePath = join(dir, "catalog.json");
  await manager.loadCatalogCache();
  expect(manager.catalogCache.size, "空缓存加载").toBe(0);
  const meta = new Map([["mcp__s__a", { description: "唯一描述" }]]);
  await manager.recordCatalogTools("srv", meta);
  expect(manager.catalogCache.get("srv")?.summary).toBe("唯一描述");
  const onDisk = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
  expect(onDisk.entries.srv.summary, "缓存落盘").toBe("唯一描述");
  // 相同摘要再记录：不重复落盘（digest 不变）
  const mtime1 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
  await manager.recordCatalogTools("srv", meta);
  const mtime2 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
  expect(mtime1, "相同摘要不落盘").toBe(mtime2);
  // 摘要变化 → 落盘
  await manager.recordCatalogTools("srv", new Map([["mcp__s__a", { description: "新描述" }]]));
  expect(manager.catalogCache.get("srv")?.summary).toBe("新描述");
  // 重新加载（模拟重启）
  const manager2 = new McpManager(fakeManagerCtx(), store);
  manager2.catalogCachePath = join(dir, "catalog.json");
  await manager2.loadCatalogCache();
  expect(manager2.catalogCache.get("srv")?.summary, "重启后缓存恢复").toBe("新描述");
  rmSync(dir, { recursive: true, force: true });
});
it("composeCatalogEntries 条目上限", () => {
  const supervisors = new Map();
  for (let i = 0; i < 10; i += 1)
    supervisors.set(`s${i}`, { server: { description: "d" }, tools: [], toolMeta: new Map() });
  expect(
    composeCatalogEntries(supervisors as unknown as Parameters<typeof composeCatalogEntries>[0], 3)
      .length,
  ).toBe(3);
});
it("digestCatalogEntries 只含服务器集合（描述变化不触发注入）", () => {
  const a = [{ name: "x", text: "d1" }];
  const b = [{ name: "x", text: "d2" }];
  const c = [
    { name: "x", text: "d1" },
    { name: "y", text: "d1" },
  ];
  expect(digestCatalogEntries(a), "描述文本变化 digest 不变（不触发注入）").toBe(
    digestCatalogEntries(b),
  );
  expect(digestCatalogEntries(a), "服务器集合变化 digest 变（触发替换）").not.toBe(
    digestCatalogEntries(c),
  );
  // 顺序敏感（服务器顺序变化 = 集合变化）
  const reversed = [
    { name: "y", text: "d1" },
    { name: "x", text: "d1" },
  ];
  expect(digestCatalogEntries(c), "顺序变化 digest 变").not.toBe(digestCatalogEntries(reversed));
});
it("escapeCatalogText 转义（完整返回不截断）", () => {
  expect(escapeCatalogText("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  expect(escapeCatalogText("换行\n字符")).toBe("换行 字符");
  expect(escapeCatalogText("长".repeat(300)).length, "长文本完整返回不截断").toBe(300);
});
it("renderMcpCatalogMessage 结构与声明", () => {
  // 含 project 条目 → 引导经 ws_mcp_search/ws_mcp_call（#228 双轨迁移）
  const msg = renderMcpCatalogMessage([{ name: "code-graph", text: "代码图谱", scope: "project" }]);
  expect(msg.role).toBe("user");
  expect(msg.source).toEqual({
    kind: "plugin:@wingsky-1/dsh-mcp-manager",
    form: "snapshot",
    sections: [{ name: "mcp-catalog", text: msg.content![0]!.text }],
  });
  expect(Object.hasOwn(msg.source!, "plugin"), "V4 source 不携带旧 plugin 字段").toBe(false);
  expect(isCatalogSource(msg.source)).toBe(true);
  expect(msg.content![0]!.type).toBe("text");
  expect(msg.content![0]!.text).toMatch(/available_mcp_servers/);
  expect(msg.content![0]!.text).toMatch(/Available MCP servers \(capability snapshot\):/);
  expect(msg.content![0]!.text, "#228 目录文案引导经中间层调用").toMatch(/ws_mcp_search/);
  expect(msg.content![0]!.text).toMatch(/`code-graph`: 代码图谱/);
  expect(typeof msg.id === "string" && msg.id.length > 0).toBeTruthy();

  // 原来「全局一律直呼」的那条 mode 分支是笔 1b 之后已假的事实，随 `mode` 删除）。
  const onlyGlobal = renderMcpCatalogMessage([{ name: "ctx", scope: "global" }]);
  expect(onlyGlobal.content![0]!.text, "纯 global 引导经中间层检索").toMatch(/ws_mcp_search/);
  expect(onlyGlobal.content![0]!.text, "纯 global 用 ws_mcp_call 触达").toMatch(/ws_mcp_call/);
  expect(onlyGlobal.content![0]!.text, "不再给出 mcp__ 直呼引导").not.toMatch(/mcp__<id>__<tool>/);

  // #192 AC-3：双缺省行仅渲染名字（无冒号描述），带描述条目渲染不变
  const mixed = renderMcpCatalogMessage([
    { name: "bare-x" },
    { name: "code-graph", text: "代码图谱" },
  ]);
  expect(mixed.content![0]!.text, "双缺省行仅名字").toMatch(/^- `bare-x`$/m);
  expect(mixed.content![0]!.text).not.toMatch(/`bare-x`: /);
  expect(mixed.content![0]!.text, "带描述行保持").toMatch(/^- `code-graph`: 代码图谱$/m);
});
it("findCatalogMessage 定位既有目录", () => {
  const catalog = renderMcpCatalogMessage([{ name: "a", text: "b" }]);
  const messages = [
    { id: "m1", role: "user", content: [] },
    catalog,
    { id: "m2", role: "assistant", content: [] },
  ];
  expect(findCatalogMessage(messages)?.id).toBe(catalog.id);
  expect(
    findCatalogMessage([{ id: "x", role: "user", content: [], source: { kind: "other" } }]),
  ).toBe(undefined);
});
