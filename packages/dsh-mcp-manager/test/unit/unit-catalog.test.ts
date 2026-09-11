// @ts-nocheck
/**
 * dsh-mcp-manager — unit：L1 能力目录与注入决策全分支。
 *
 * 覆盖：
 * - summarizeToolDescriptions：排序取首非空、trim/空白折叠、空集 undefined
 * - composeCatalogEntries：description 优先、缓存回落、maxEntries 截断
 * - digestCatalogEntries：只含 name、顺序敏感
 * - escapeCatalogText / findCatalogMessage / readCatalogEntries 坏数据面
 * - catalogHistory：倒序扫描、可见性过滤、published 标记
 * - renderMcpCatalogMessage / renderMcpCatalogUpdate 形状
 * - resolveCatalogInjection 六条决策路径
 */
import { describe, expect, it } from "vitest";

const {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  summarizeToolDescriptions,
  composeCatalogEntries,
  digestCatalogEntries,
  renderMcpCatalogMessage,
  escapeCatalogText,
  findCatalogMessage,
  readCatalogEntries,
  isCatalogSource,
  resolveCatalogEntries,
  catalogHistory,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
} = await import("../../src/index.ts");

describe("常量", () => {
  it("DEFAULT_ANNOUNCE_CATALOG 为 true", () => {
    expect(DEFAULT_ANNOUNCE_CATALOG).toBe(true);
  });

  it("DEFAULT_CATALOG_MAX_ENTRIES 为 6", () => {
    expect(DEFAULT_CATALOG_MAX_ENTRIES).toBe(6);
  });
});

describe("summarizeToolDescriptions", () => {
  it("空集合 undefined", () => {
    expect(summarizeToolDescriptions(new Map())).toBeUndefined();
  });

  it("每工具取首句、按工具名升序聚合", () => {
    // #569：每工具取首句、按工具名升序聚合（不再只取字典序第一条）。
    const meta = new Map([
      ["b", { description: "  beta   tool " }],
      ["c", { description: undefined }],
      ["d", {}],
      ["a", { description: "alpha" }],
    ]);
    expect(summarizeToolDescriptions(meta)).toBe("2 tools: alpha; beta tool");
  });

  it("全空白 → undefined", () => {
    const onlyBlank = new Map([["x", { description: "   " }]]);
    expect(summarizeToolDescriptions(onlyBlank)).toBeUndefined();
  });

  it("顺序抖动摘要稳定", () => {
    // 顺序抖动 → 摘要稳定（按工具名排序，不随 Map 插入序/描述变化）。
    const shuffled = new Map([
      ["b", { description: "beta tool" }],
      ["a", { description: "alpha" }],
    ]);
    expect(summarizeToolDescriptions(shuffled)).toBe("2 tools: alpha; beta tool");
  });

  it("句点后随大写 → 只取首句", () => {
    // 首句提取：句点后随大写开新句；"1." 编号不误切；无句读整行返回。
    expect(
      summarizeToolDescriptions(new Map([["x", { description: "Search the web. Use for facts." }]])),
    ).toBe("Search the web.");
  });

  it("1. 编号不误切（句读前置数字跳过）", () => {
    expect(
      summarizeToolDescriptions(new Map([["x", { description: "Step 1. Crawl a site. Step 2. Done." }]])),
    ).toBe("Step 1. Crawl a site.");
  });

  it("无句读整行返回", () => {
    expect(
      summarizeToolDescriptions(new Map([["x", { description: "没有标点的长句啊没有句号" }]])),
    ).toBe("没有标点的长句啊没有句号");
  });

  it("重复描述去重", () => {
    // 精确去重：同句两个工具只出现一次。
    expect(
      summarizeToolDescriptions(new Map([["a", { description: "同句" }], ["b", { description: "同句" }]])),
    ).toBe("2 tools: 同句");
  });

  it("超长摘要总长受控（≤240）", () => {
    // 超长截断：总长 ≤ 240 字符（UTF-16 安全；截断处补 …）。
    const many = new Map();
    for (let i = 0; i < 30; i += 1) many.set(`t${String(i).padStart(2, "0")}`, { description: `工具 ${i} 的功能说明`.repeat(6) });
    const long = summarizeToolDescriptions(many);
    expect(long.length <= 240).toBeTruthy();
  });

  it("超长以省略号收尾（不句中切）", () => {
    const many = new Map();
    for (let i = 0; i < 30; i += 1) many.set(`t${String(i).padStart(2, "0")}`, { description: `工具 ${i} 的功能说明`.repeat(6) });
    const long = summarizeToolDescriptions(many);
    expect(long.endsWith("…")).toBeTruthy();
  });

  it("重复描述去重后单条即完整", () => {
    // 描述去重（30 个工具同句）→ 内容一条 + 总数前缀即足够，无需省略号。
    const dedupMap = new Map();
    for (let i = 0; i < 30; i += 1) dedupMap.set(`t${String(i).padStart(2, "0")}`, { description: "同句说明" });
    expect(summarizeToolDescriptions(dedupMap)).toBe("30 tools: 同句说明");
  });

  it("极端长句截断受控", () => {
    // 极端长句（无句读超单句上限）→ 单句内截断 + 省略号。
    const single = summarizeToolDescriptions(new Map([["x", { description: "长".repeat(500) }]]));
    expect(single.length <= 240).toBeTruthy();
  });

  it("极端长句带省略号", () => {
    const single = summarizeToolDescriptions(new Map([["x", { description: "长".repeat(500) }]]));
    expect(single.endsWith("…")).toBeTruthy();
  });
});

describe("composeCatalogEntries", () => {
  function supervisorsFixture() {
    return new Map([
      ["s1", { server: { name: "s1", description: "desc1" } }],
      ["s2", { server: { name: "s2" } }],
      ["s3", { server: { name: "s3", description: "" } }],
      ["s4", { server: { name: "s4" } }],
    ]);
  }
  const cacheFixture = () => new Map([["s3", { summary: "cached-summary" }], ["s4", { summary: "" }]]);

  it("条目数与服务器数一致", () => {
    const entries = composeCatalogEntries(supervisorsFixture(), 10, cacheFixture());
    expect(entries.length).toBe(4);
  });

  it("自定义 description 优先", () => {
    const entries = composeCatalogEntries(supervisorsFixture(), 10, cacheFixture());
    expect(entries[0]).toEqual({ name: "s1", text: "desc1" });
  });

  it("无描述无缓存 → 只显示名（不含 text 属性）", () => {
    const entries = composeCatalogEntries(supervisorsFixture(), 10, cacheFixture());
    expect(entries[1]).toEqual({ name: "s2" });
  });

  it("双缺省不产出 text: undefined（#192）", () => {
    const entries = composeCatalogEntries(supervisorsFixture(), 10, cacheFixture());
    expect(Object.hasOwn(entries[1], "text")).toBe(false);
  });

  it("缓存摘要回落", () => {
    const entries = composeCatalogEntries(supervisorsFixture(), 10, cacheFixture());
    expect(entries[2]).toEqual({ name: "s3", text: "cached-summary" });
  });

  it("空串缓存视为无", () => {
    const entries = composeCatalogEntries(supervisorsFixture(), 10, cacheFixture());
    expect(entries[3].text).toBeUndefined();
  });

  it("maxEntries 截断", () => {
    // maxEntries 截断；cache 缺省不抛。
    expect(composeCatalogEntries(supervisorsFixture(), 2, cacheFixture()).length).toBe(2);
  });

  it("cache 缺省不抛且无 text", () => {
    const noCache = composeCatalogEntries(new Map([["z", { server: { name: "z" } }]]));
    expect(noCache[0].text).toBeUndefined();
  });

  it("空集合产出 0 条", () => {
    expect(composeCatalogEntries(new Map()).length).toBe(0);
  });

  it("超长 description 提取首句（防上下文膨胀）", () => {
    // 超长 description 提取首句防上下文膨胀（渐进式披露：丢弃后续多行与长说明书）。
    const verboseDesc =
      "Resolves package name to library ID. You MUST call this first. Step 1. Do something. Selection Process: very long text...";
    const verboseEntries = composeCatalogEntries(
      new Map([["context7", { server: { name: "context7", description: verboseDesc } }]]),
    );
    expect(verboseEntries[0].text).toBe("Resolves package name to library ID.");
  });
});

describe("digestCatalogEntries", () => {
  it("同集合同 digest", () => {
    const d1 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
    const d2 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
    expect(d1).toBe(d2);
  });

  it("顺序敏感（join \\n）", () => {
    const d1 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
    const d3 = digestCatalogEntries([{ name: "b" }, { name: "a" }]);
    expect(d1).not.toBe(d3);
  });

  it("空集不同", () => {
    const d1 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
    const d4 = digestCatalogEntries([]);
    expect(d1).not.toBe(d4);
  });

  it("sha256 hex", () => {
    const d1 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("escapeCatalogText", () => {
  it("转义 HTML 实体", () => {
    expect(escapeCatalogText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("换行折叠为空格", () => {
    expect(escapeCatalogText("line1\nline2\rline3")).toBe("line1 line2 line3");
  });

  it("非字符串 String 化", () => {
    expect(escapeCatalogText(42)).toBe("42");
  });
});

describe("renderMcpCatalogMessage / findCatalogMessage / readCatalogEntries", () => {
  const makeMessage = () => renderMcpCatalogMessage([{ name: "m1", text: "t<1" }]);

  it("message.role 为 user", () => {
    expect(makeMessage().role).toBe("user");
  });

  it("随机 id 存在", () => {
    expect(makeMessage().id).toBeTruthy();
  });

  it("#723 message.source 为宿主词表内的 plugin/snapshot 形态（自造 kind 会被迁移白名单拒绝）", () => {
    const source = makeMessage().source;
    expect(source.kind).toBe("plugin");
    expect(source.plugin).toBe("@wingsky-1/dsh-mcp-manager");
    expect(source.form).toBe("snapshot");
    expect(isCatalogSource(source)).toBe(true);
  });

  it("文本含 <available_mcp_servers>", () => {
    expect(makeMessage().content[0].text.includes("<available_mcp_servers>")).toBeTruthy();
  });

  it("条目转义渲染", () => {
    expect(makeMessage().content[0].text.includes("- `m1`: t&lt;1")).toBeTruthy();
  });

  it("文本含 does not reflect active connection status", () => {
    expect(makeMessage().content[0].text.includes("does not reflect active connection status")).toBeTruthy();
  });

  it("findCatalogMessage 命中目录消息", () => {
    const message = makeMessage();
    expect(findCatalogMessage([message])).toBe(message);
  });

  it("findCatalogMessage 空数组 undefined", () => {
    expect(findCatalogMessage([])).toBeUndefined();
  });

  it("定位到目录消息（混入其它来源）", () => {
    const message = makeMessage();
    expect(findCatalogMessage([{ source: { kind: "other" } }, message])).toBe(message);
  });

  it("坏消息容错", () => {
    expect(findCatalogMessage([undefined, null])).toBeUndefined();
  });

  it("#723 新形态走 resolveCatalogEntries 读回条目", () => {
    const message = makeMessage();
    expect(resolveCatalogEntries(message.source)).toEqual([{ name: "m1", text: "t<1" }]);
  });

  it("readCatalogEntries(undefined) undefined", () => {
    expect(readCatalogEntries(undefined)).toBeUndefined();
  });

  it("readCatalogEntries({}) undefined", () => {
    expect(readCatalogEntries({})).toBeUndefined();
  });

  it("entries 非 Array → undefined", () => {
    expect(readCatalogEntries({ entries: "nope" })).toBeUndefined();
  });

  it("entry 非对象 → undefined", () => {
    expect(readCatalogEntries({ entries: [1] })).toBeUndefined();
  });

  it("缺 name → undefined", () => {
    expect(readCatalogEntries({ entries: [{ text: "x" }] })).toBeUndefined();
  });

  it("空 name → undefined", () => {
    expect(readCatalogEntries({ entries: [{ name: "" }] })).toBeUndefined();
  });

  it("非字符串 text 归一为 undefined", () => {
    expect(readCatalogEntries({ entries: [{ name: "n", text: 5 }, { name: "m" }] })).toEqual([
      { name: "n", text: undefined },
      { name: "m", text: undefined },
    ]);
  });
});

describe("renderMcpCatalogUpdate", () => {
  const makeText = () => renderMcpCatalogUpdate([{ name: "u1" }]).content[0].text;

  it("update 帧头", () => {
    expect(makeText().startsWith("<system-reminder>")).toBeTruthy();
  });

  it("替换声明", () => {
    expect(makeText().includes("This catalog replaces all previous available_mcp_servers")).toBeTruthy();
  });

  it("内层裁掉原头部说明", () => {
    expect(!makeText().includes("does not reflect active connection status")).toBeTruthy();
  });

  it("update 帧至少 6 行", () => {
    expect(makeText().split("\n").length >= 6).toBeTruthy();
  });
});

describe("catalogHistory", () => {
  const entry = [{ name: "h1", text: "t" }];
  const event = (seq, visible) => ({
    type: "user/message",
    seq,
    data: { source: { kind: "mcp-catalog", entries: entry } },
  });

  it("无 agent → {published:false}", () => {
    // 无 agent / 空 events。
    expect(catalogHistory(undefined)).toEqual({ published: false });
  });

  it("空 agent → {published:false}", () => {
    expect(catalogHistory({})).toEqual({ published: false });
  });

  it("空 session → {published:false}", () => {
    expect(catalogHistory({ session: {} })).toEqual({ published: false });
  });

  it("倒序找到可见目录消息", () => {
    const digest = digestCatalogEntries(entry);
    // 可见命中：返回 visibleDigest + published。
    const agentVisible = {
      session: {
        surface: { nodes: [7] },
        snapshotEvents: () => [
          { type: "user/message", seq: 5, data: { source: { kind: "mcp-catalog", entries: entry } } },
          event(7),
          { type: "user/message", seq: 8, data: { source: { kind: "other" } } },
        ],
      },
    };
    expect(catalogHistory(agentVisible)).toEqual({ visibleDigest: digest, published: true });
  });

  it("不可见时仅标记 published", () => {
    // 目录消息存在但不可见（compaction 后）：published=true 无 visibleDigest。
    const agentInvisible = {
      session: {
        surface: { nodes: [] },
        snapshotEvents: () => [event(3)],
      },
    };
    expect(catalogHistory(agentInvisible)).toEqual({ published: true });
  });

  it("跳过坏数据命中更早的可见消息", () => {
    const digest = digestCatalogEntries(entry);
    // 坏 entries 的目录消息跳过继续向前找。
    const agentBadThenGood = {
      session: {
        surface: { nodes: [1] },
        snapshotEvents: () => [
          event(1),
          { type: "user/message", seq: 2, data: { source: { kind: "mcp-catalog", entries: "bad" } } },
        ],
      },
    };
    expect(catalogHistory(agentBadThenGood).visibleDigest).toEqual(digest);
  });

  it("只有非目录消息 → {published:false}", () => {
    expect(
      catalogHistory({ session: { snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "x" } } }] } }),
    ).toEqual({ published: false });
  });
});

describe("resolveCatalogInjection：六条路径", () => {
  const supervisors = () => new Map([["s", { server: { name: "s", description: "d" } }]]);
  const baseDecision = () => ({ kind: "enter", messages: [] });
  const plainMessage = (id) => ({ id, role: "user", content: [] });

  function sameDigestAgent() {
    const entry = [{ name: "s", text: "d" }];
    return {
      entry,
      agentSame: { session: { surface: { nodes: [1] }, snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "mcp-catalog", entries: entry } } }] } },
    };
  }

  function otherDigestAgent() {
    return { session: { surface: { nodes: [] }, snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "mcp-catalog", entries: [{ name: "old" }] } } }] } };
  }

  it("reject 直接透传", () => {
    // 1. reject 直接透传。
    const rejected = { kind: "reject", messages: [] };
    expect(resolveCatalogInjection(rejected, [], supervisors(), 6, new Map(), undefined)).toBe(rejected);
  });

  it("历史 digest 相同 + 本轮已带目录 → kind 保持 enter", () => {
    // 2. 历史 digest 相同 + 本轮已带目录 → 过滤掉该目录（幂等撤销）。
    const { entry, agentSame } = sameDigestAgent();
    const existingMsg = renderMcpCatalogMessage(entry);
    const decisionWith = { kind: "enter", messages: [plainMessage("keep"), existingMsg] };
    const filtered = resolveCatalogInjection(decisionWith, [], supervisors(), 6, new Map(), agentSame);
    expect(filtered.kind).toBe("enter");
  });

  it("历史相同 → 撤销本轮目录消息", () => {
    const { entry, agentSame } = sameDigestAgent();
    const existingMsg = renderMcpCatalogMessage(entry);
    const decisionWith = { kind: "enter", messages: [plainMessage("keep"), existingMsg] };
    const filtered = resolveCatalogInjection(decisionWith, [], supervisors(), 6, new Map(), agentSame);
    expect(filtered.messages.map((m) => m.id)).toEqual(["keep"]);
  });

  it("历史 digest 相同 + 本轮无目录 → 原样返回", () => {
    // 3. 历史 digest 相同 + 本轮无目录 → 原样返回。
    const { agentSame } = sameDigestAgent();
    const decisionPlain = { kind: "enter", messages: [plainMessage("k")] };
    expect(resolveCatalogInjection(decisionPlain, [], supervisors(), 6, new Map(), agentSame)).toBe(decisionPlain);
  });

  it("existing digest 相同 → 不重复追加", () => {
    // 4. 本轮已带相同 digest 的目录且历史不同 → 原样返回（就地复用）。
    const entry = [{ name: "s", text: "d" }];
    const freshExisting = renderMcpCatalogMessage(entry);
    const decisionReuse = { kind: "enter", messages: [freshExisting] };
    const resultReuse = resolveCatalogInjection(decisionReuse, [], supervisors(), 6, new Map(), undefined);
    expect(resultReuse.messages.map((m) => m.id)).toEqual([freshExisting.id]);
  });

  it("未发布且空目录 → 保持原样", () => {
    // 5. 未发布且无服务器 → 不注入。
    const emptyResult = resolveCatalogInjection(baseDecision(), [], new Map(), 6, new Map(), undefined);
    expect(emptyResult.messages).toEqual([]);
  });

  it("未发布且有服务器 → kind enter", () => {
    // 6. 未发布且有服务器 → 注入普通目录帧（append）。
    const injected = resolveCatalogInjection(baseDecision(), [], supervisors(), 6, new Map(), undefined);
    expect(injected.kind).toBe("enter");
  });

  it("未发布且有服务器 → 注入 1 条", () => {
    const injected = resolveCatalogInjection(baseDecision(), [], supervisors(), 6, new Map(), undefined);
    expect(injected.messages.length).toBe(1);
  });

  it("首次注入用普通帧", () => {
    const injected = resolveCatalogInjection(baseDecision(), [], supervisors(), 6, new Map(), undefined);
    expect(injected.messages[0].content[0].text.includes("Configured MCP servers in this session")).toBeTruthy();
  });

  it("digest 变化 → 更新帧", () => {
    // 6b. 已发布但 digest 变化 → 注入更新帧。
    const updated = resolveCatalogInjection(baseDecision(), [], supervisors(), 6, new Map(), otherDigestAgent());
    expect(updated.messages[0].content[0].text.includes("MCP server configuration has changed")).toBeTruthy();
  });

  it("本轮已有旧目录且 digest 变化 → 替换不追加", () => {
    // 6c. 本轮已有旧目录且 digest 变化 → 原位替换而非追加。
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection({ kind: "enter", messages: [plainMessage("k2"), stale] }, [], supervisors(), 6, new Map(), otherDigestAgent());
    expect(replaced.messages.length).toBe(2);
  });

  it("替换保留前序消息 id", () => {
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection({ kind: "enter", messages: [plainMessage("k2"), stale] }, [], supervisors(), 6, new Map(), otherDigestAgent());
    expect(replaced.messages[0].id).toBe("k2");
  });

  it("替换后的消息为更新帧", () => {
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection({ kind: "enter", messages: [plainMessage("k2"), stale] }, [], supervisors(), 6, new Map(), otherDigestAgent());
    expect(replaced.messages[1].content[0].text.includes("MCP server configuration has changed")).toBeTruthy();
  });

  it("替换后 id 与旧目录不同", () => {
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection({ kind: "enter", messages: [plainMessage("k2"), stale] }, [], supervisors(), 6, new Map(), otherDigestAgent());
    expect(replaced.messages[1].id).not.toBe(stale.id);
  });
});

// #723：目录 source 新旧两代双识别 —— 写入侧已改宿主通用形态，读取侧必须同时认旧形态
// （升级前的会话），否则 digest 恒不等、每轮误判"目录已变"而重复注入修正帧。
describe("#723 目录 source 双形态识别", () => {
  it("resolveCatalogEntries 从快照正文单射还原条目（含反转义）", () => {
    const message = renderMcpCatalogMessage([{ name: "m1", text: "t<1" }]);
    expect(resolveCatalogEntries(message.source)).toEqual([{ name: "m1", text: "t<1" }]);
  });

  it("readCatalogEntries 仍读旧形态（跨版本兼容）", () => {
    expect(readCatalogEntries({ kind: "mcp-catalog", form: "catalog", entries: [{ name: "m1", text: "t<1" }] }))
      .toEqual([{ name: "m1", text: "t<1" }]);
  });

  it("resolveCatalogEntries 坏数据面一律 undefined", () => {
    expect(resolveCatalogEntries(undefined)).toBeUndefined();
    expect(resolveCatalogEntries({ kind: "user" })).toBeUndefined();
    expect(resolveCatalogEntries({ kind: "plugin", plugin: "other-plugin", form: "snapshot", sections: [] })).toBeUndefined();
    expect(resolveCatalogEntries({ kind: "plugin", plugin: "@wingsky-1/dsh-mcp-manager", form: "snapshot" })).toBeUndefined();
    expect(resolveCatalogEntries({ kind: "plugin", plugin: "@wingsky-1/dsh-mcp-manager", form: "snapshot", sections: [{ name: "other", text: "x" }] })).toBeUndefined();
  });
});

describe("#723 catalogHistory 双形态识别", () => {
  const entries = [{ name: "s", text: "d" }];
  const digest = digestCatalogEntries(entries);
  const body = [
    "<system-reminder>",
    "<available_mcp_servers>",
    "- `s`: d",
    "</available_mcp_servers>",
    "</system-reminder>",
  ].join("\n");
  const newSource = { kind: "plugin", plugin: "@wingsky-1/dsh-mcp-manager", form: "snapshot", sections: [{ name: "mcp-catalog", text: body }] };
  const agentOf = (nodes, source) => ({
    session: { surface: { nodes }, snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source } }] },
  });

  it("新形态可见 → digest 与条目口径一致", () => {
    expect(catalogHistory(agentOf([1], newSource))).toEqual({ visibleDigest: digest, published: true });
  });

  it("新形态被 compaction 遮蔽 → published 但无 digest", () => {
    expect(catalogHistory(agentOf([], newSource))).toEqual({ published: true });
  });

  it("旧形态仍被识别（同一 digest 口径）", () => {
    expect(catalogHistory(agentOf([1], { kind: "mcp-catalog", form: "catalog", entries })))
      .toEqual({ visibleDigest: digest, published: true });
  });

  it("他插件的 plugin 消息不得被误认", () => {
    expect(catalogHistory(agentOf([1], { kind: "plugin", plugin: "other", form: "snapshot", sections: [{ name: "mcp-catalog", text: body }] })))
      .toEqual({ published: false });
  });
});
