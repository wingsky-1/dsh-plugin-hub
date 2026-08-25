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
import assert from "node:assert/strict";

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
  catalogHistory,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
} = await import("../lib/index.js");

// ---- 常量 ----

assert.equal(DEFAULT_ANNOUNCE_CATALOG, true);
assert.equal(DEFAULT_CATALOG_MAX_ENTRIES, 6);

// ---- summarizeToolDescriptions ----

{
  assert.equal(summarizeToolDescriptions(new Map()), undefined, "空集合 undefined");
  const meta = new Map([
    ["b", { description: "  beta   tool " }],
    ["c", { description: undefined }],
    ["a", { description: "alpha" }],
    ["d", {}],
  ]);
  // 排序后取第一个非空：alpha < beta tool。
  assert.equal(summarizeToolDescriptions(meta), "alpha");
  const onlyBlank = new Map([["x", { description: "   " }]]);
  assert.equal(summarizeToolDescriptions(onlyBlank), undefined, "全空白 → undefined");
}

// ---- composeCatalogEntries ----

{
  const supervisors = new Map([
    ["s1", { server: { name: "s1", description: "desc1" } }],
    ["s2", { server: { name: "s2" } }],
    ["s3", { server: { name: "s3", description: "" } }],
    ["s4", { server: { name: "s4" } }],
  ]);
  const cache = new Map([["s3", { summary: "cached-summary" }], ["s4", { summary: "" }]]);

  const entries = composeCatalogEntries(supervisors, 10, cache);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { name: "s1", text: "desc1" }, "自定义 description 优先");
  assert.deepEqual(entries[1], { name: "s2" }, "无描述无缓存 → 只显示名（不含 text 属性）");
  assert.equal(Object.hasOwn(entries[1], "text"), false, "双缺省不产出 text: undefined（#192）");
  assert.deepEqual(entries[2], { name: "s3", text: "cached-summary" }, "缓存摘要回落");
  assert.equal(entries[3].text, undefined, "空串缓存视为无");

  // maxEntries 截断；cache 缺省不抛。
  assert.equal(composeCatalogEntries(supervisors, 2, cache).length, 2);
  const noCache = composeCatalogEntries(new Map([["z", { server: { name: "z" } }]]));
  assert.equal(noCache[0].text, undefined);
  assert.equal(composeCatalogEntries(new Map()).length, 0);
}

// ---- digestCatalogEntries ----

{
  const d1 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
  const d2 = digestCatalogEntries([{ name: "a" }, { name: "b" }]);
  const d3 = digestCatalogEntries([{ name: "b" }, { name: "a" }]);
  const d4 = digestCatalogEntries([]);
  assert.equal(d1, d2, "同集合同 digest");
  assert.notEqual(d1, d3, "顺序敏感（join \\n）");
  assert.notEqual(d1, d4, "空集不同");
  assert.match(d1, /^[0-9a-f]{64}$/, "sha256 hex");
}

// ---- escapeCatalogText ----

{
  assert.equal(escapeCatalogText("a<b>&c"), "a&lt;b&gt;&amp;c");
  assert.equal(escapeCatalogText("line1\nline2\rline3"), "line1 line2 line3", "换行折叠为空格");
  assert.equal(escapeCatalogText(42), "42");
}

// ---- renderMcpCatalogMessage / findCatalogMessage / readCatalogEntries ----

{
  const message = renderMcpCatalogMessage([{ name: "m1", text: "t<1" }]);
  assert.equal(message.role, "user");
  assert.ok(message.id, "随机 id 存在");
  assert.equal(message.source.kind, "mcp-catalog");
  assert.equal(message.source.form, "catalog");
  const text = message.content[0].text;
  assert.ok(text.includes("<available_mcp_servers>"));
  assert.ok(text.includes("- `m1`: t&lt;1"), "条目转义渲染");
  assert.ok(text.includes("不代表当前连接状态"));

  assert.equal(findCatalogMessage([message]), message);
  assert.equal(findCatalogMessage([]), undefined);
  assert.equal(findCatalogMessage([{ source: { kind: "other" } }, message]), message, "定位到目录消息");
  assert.equal(findCatalogMessage([undefined, null]), undefined, "坏消息容错");

  const entries = readCatalogEntries(message.source);
  assert.deepEqual(entries, [{ name: "m1", text: "t<1" }]);
  assert.equal(readCatalogEntries(undefined), undefined);
  assert.equal(readCatalogEntries({}), undefined);
  assert.equal(readCatalogEntries({ entries: "nope" }), undefined, "entries 非 Array → undefined");
  assert.equal(readCatalogEntries({ entries: [1] }), undefined, "entry 非对象 → undefined");
  assert.equal(readCatalogEntries({ entries: [{ text: "x" }] }), undefined, "缺 name → undefined");
  assert.equal(readCatalogEntries({ entries: [{ name: "" }] }), undefined, "空 name → undefined");
  assert.deepEqual(
    readCatalogEntries({ entries: [{ name: "n", text: 5 }, { name: "m" }] }),
    [{ name: "n", text: undefined }, { name: "m", text: undefined }],
    "非字符串 text 归一为 undefined",
  );
}

// ---- renderMcpCatalogUpdate ----

{
  const update = renderMcpCatalogUpdate([{ name: "u1" }]);
  const text = update.content[0].text;
  assert.ok(text.startsWith("<system-reminder>"), "update 帧头");
  assert.ok(text.includes("本目录替换此前所有 available_mcp_servers"), "替换声明");
  assert.ok(!text.includes("不代表当前连接状态"), "内层裁掉原头部说明");
  assert.ok(update.content[0].text.split("\n").length >= 6);
}

// ---- catalogHistory ----

{
  // 无 agent / 空 events。
  assert.deepEqual(catalogHistory(undefined), { published: false });
  assert.deepEqual(catalogHistory({}), { published: false });
  assert.deepEqual(catalogHistory({ session: {} }), { published: false });

  const entry = [{ name: "h1", text: "t" }];
  const digest = digestCatalogEntries(entry);
  const event = (seq, visible) => ({
    type: "user/message",
    seq,
    data: { source: { kind: "mcp-catalog", entries: entry } },
  });

  // 可见命中：返回 visibleDigest + published。
  const agentVisible = {
    session: {
      surface: { nodes: [7] },
      events: [
        { type: "user/message", seq: 5, data: { source: { kind: "mcp-catalog", entries: entry } } },
        event(7),
        { type: "user/message", seq: 8, data: { source: { kind: "other" } } },
      ],
    },
  };
  assert.deepEqual(catalogHistory(agentVisible), { visibleDigest: digest, published: true }, "倒序找到可见目录消息");

  // 目录消息存在但不可见（compaction 后）：published=true 无 visibleDigest。
  const agentInvisible = {
    session: {
      surface: { nodes: [] },
      events: [event(3)],
    },
  };
  assert.deepEqual(catalogHistory(agentInvisible), { published: true }, "不可见时仅标记 published");

  // 坏 entries 的目录消息跳过继续向前找。
  const agentBadThenGood = {
    session: {
      surface: { nodes: [1] },
      events: [
        event(1),
        { type: "user/message", seq: 2, data: { source: { kind: "mcp-catalog", entries: "bad" } } },
      ],
    },
  };
  assert.deepEqual(catalogHistory(agentBadThenGood).visibleDigest, digest, "跳过坏数据命中更早的可见消息");

  // 只有非目录消息。
  assert.deepEqual(
    catalogHistory({ session: { events: [{ type: "user/message", seq: 1, data: { source: { kind: "x" } } }] } }),
    { published: false },
  );
}

// ---- resolveCatalogInjection：六条路径 ----

{
  const supervisors = new Map([["s", { server: { name: "s", description: "d" } }]]);
  const baseDecision = () => ({ kind: "enter", messages: [] });
  const plainMessage = (id) => ({ id, role: "user", content: [] });

  // 1. reject 直接透传。
  const rejected = { kind: "reject", messages: [] };
  assert.equal(resolveCatalogInjection(rejected, [], supervisors, 6, new Map(), undefined), rejected);

  // 2. 历史 digest 相同 + 本轮已带目录 → 过滤掉该目录（幂等撤销）。
  const entry = [{ name: "s", text: "d" }];
  const digest = digestCatalogEntries(entry);
  const agentSame = { session: { surface: { nodes: [1] }, events: [{ type: "user/message", seq: 1, data: { source: { kind: "mcp-catalog", entries: entry } } }] } };
  const existingMsg = renderMcpCatalogMessage(entry);
  const decisionWith = { kind: "enter", messages: [plainMessage("keep"), existingMsg] };
  const filtered = resolveCatalogInjection(decisionWith, [], supervisors, 6, new Map(), agentSame);
  assert.equal(filtered.kind, "enter");
  assert.deepEqual(filtered.messages.map((m) => m.id), ["keep"], "历史相同 → 撤销本轮目录消息");

  // 3. 历史 digest 相同 + 本轮无目录 → 原样返回。
  const decisionPlain = { kind: "enter", messages: [plainMessage("k")] };
  assert.equal(resolveCatalogInjection(decisionPlain, [], supervisors, 6, new Map(), agentSame), decisionPlain);

  // 4. 本轮已带相同 digest 的目录且历史不同 → 原样返回（就地复用）。
  const freshExisting = renderMcpCatalogMessage(entry);
  const decisionReuse = { kind: "enter", messages: [freshExisting] };
  const resultReuse = resolveCatalogInjection(decisionReuse, [], supervisors, 6, new Map(), undefined);
  assert.deepEqual(resultReuse.messages.map((m) => m.id), [freshExisting.id], "existing digest 相同 → 不重复追加");

  // 5. 未发布且无服务器 → 不注入。
  const emptyResult = resolveCatalogInjection(baseDecision(), [], new Map(), 6, new Map(), undefined);
  assert.deepEqual(emptyResult.messages, [], "未发布且空目录 → 保持原样");

  // 6. 未发布且有服务器 → 注入普通目录帧（append）。
  const injected = resolveCatalogInjection(baseDecision(), [], supervisors, 6, new Map(), undefined);
  assert.equal(injected.kind, "enter");
  assert.equal(injected.messages.length, 1);
  assert.ok(injected.messages[0].content[0].text.includes("本会话已配置以下 MCP 服务器"), "首次注入用普通帧");

  // 6b. 已发布但 digest 变化 → 注入更新帧。
  const agentOther = { session: { surface: { nodes: [] }, events: [{ type: "user/message", seq: 1, data: { source: { kind: "mcp-catalog", entries: [{ name: "old" }] } } }] } };
  const updated = resolveCatalogInjection(baseDecision(), [], supervisors, 6, new Map(), agentOther);
  assert.ok(updated.messages[0].content[0].text.includes("MCP 服务器集合已变化"), "digest 变化 → 更新帧");

  // 6c. 本轮已有旧目录且 digest 变化 → 原位替换而非追加。
  const stale = renderMcpCatalogMessage([{ name: "stale" }]);
  const replaced = resolveCatalogInjection({ kind: "enter", messages: [plainMessage("k2"), stale] }, [], supervisors, 6, new Map(), agentOther);
  assert.equal(replaced.messages.length, 2, "替换不追加");
  assert.equal(replaced.messages[0].id, "k2");
  assert.ok(replaced.messages[1].content[0].text.includes("MCP 服务器集合已变化"));
  assert.notEqual(replaced.messages[1].id, stale.id);
}

console.log("  ok   unit-catalog: 能力目录与注入决策全分支");
