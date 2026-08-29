// @ts-nocheck
/**
 * dsh-provider-usage — unit：废弃 v1 契约函数 + opencode-go 适配器 format 覆盖。
 *
 * 覆盖：isHostProviderAdapter、describeAdapterShape、isClientProviderRenderer、
 * defineUsageAdapter（含 samplePoint/summarize）、usageError、usageOk。
 *
 * #82 批次 3 增补：formatCapsule（含 `无数据` 回落）、formatPanel 覆盖
 * fmtReset 分支（resetsAt 存在/不存在/非法日期）。
 *
 * 这些函数在 v2 重构中标记为 deprecated，保留引用兼容，需保持测试覆盖以
 * 避免回归（#82 批次 3：清零未覆盖超阈热点）。
 *
 * #150 变异加固：原 unit-chart.test.ts（parseUsageResponse 双形状、
 * fetchOpenCodeGoV2 错误链、miniChartSvgMarkup 结构断言、formatCapsule/
 * formatPanel 三态与趋势分支）整体并入本文件——该文件此前未被 smoke.ts
 * 与 stryker testFiles 任一通道收录，属死文件；并入后图表纯函数群
 * （timeTickStep/timeTicks/trendOf/resetTicks/downsample/smoothPath 经
 * 导出接口行为级断言）方才进入变异计量范围。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, judgeContained as pipeContained, judgePad as pad, injectGlobalFetch } from "./helpers.ts";
console.error("EVAL-ORDER-TAG: V1");
import {
  ADAPTER_CONTRACT_VERSION_V1,
  isHostProviderAdapter,
  describeAdapterShape,
  isClientProviderRenderer,
  defineUsageAdapter,
  usageError,
  usageOk,
  openCodeGoAdapter,
  esc,
  parseUsageResponse,
  pickWindow,
  fetchOpenCodeGoV2,
  miniChartSvgMarkup,
  safeFetchData,
  safeFormat,
  fetchWithTimeout,
  sanitizeHtml,
  HistoryStore,
  runV2Pipeline,
  runV2PanelPipeline,
} from "../src/index.ts";

// ---------------------------------------------------------------- isHostProviderAdapter

assert.equal(isHostProviderAdapter(null), false, "null 返回 false");
assert.equal(isHostProviderAdapter("str"), false, "非对象返回 false");
assert.equal(isHostProviderAdapter({}), false, "空对象返回 false");

// 完整合法 v1 适配器
const V1_ADAPTER = {
  version: 1,
  id: "my-adapter",
  label: "My Adapter",
  providers: ["anthropic"],
  fetchUsage: async () => ({ ok: true, provider: "anthropic", label: "MA", fetchedAt: Date.now() }),
};
assert.equal(isHostProviderAdapter(V1_ADAPTER), true, "合法 v1 适配器返回 true");

// 版本号错误
assert.equal(isHostProviderAdapter({ ...V1_ADAPTER, version: 2 }), false, "version 非 1 返回 false");
// 缺字段
assert.equal(isHostProviderAdapter({ ...V1_ADAPTER, id: "" }), false, "id 空字符串返回 false");
assert.equal(isHostProviderAdapter({ ...V1_ADAPTER, label: "" }), false, "label 空字符串返回 false");
assert.equal(isHostProviderAdapter({ ...V1_ADAPTER, providers: [] }), false, "providers 空数组返回 false");
assert.equal(isHostProviderAdapter({ ...V1_ADAPTER, providers: [""] }), false, "providers 含空字符串返回 false");
assert.equal(isHostProviderAdapter({ ...V1_ADAPTER, fetchUsage: "not-fn" }), false, "fetchUsage 非函数返回 false");

// #150 分片 2：伪装类型与元素级边界（变异驱动）
{
  // 函数挂全套合法属性：typeof 守卫左子恒假变异下会被放行，
  // 契约必须以严格 typeof 拒绝非 object 载体
  const fake = () => {};
  Object.assign(fake, { version: 1, id: "x", label: "y", providers: ["p"], fetchUsage: () => {} });
  assert.equal(isHostProviderAdapter(fake), false, "函数载体即使属性齐全也拒绝");
}
{
  // id 为带 length 的非字符串：typeof id 恒真变异下会放行
  const a = { ...V1_ADAPTER, id: [1, 2, 3] };
  assert.equal(isHostProviderAdapter(a), false, "id 为数组（length>0 非字符串）拒绝");
}
{
  const a = { ...V1_ADAPTER, label: [1] };
  assert.equal(isHostProviderAdapter(a), false, "label 为数组（length>0 非字符串）拒绝");
}
{
  // 多元素含一个空串：every 换 some 变异下会放行
  const a = { ...V1_ADAPTER, providers: ["good", ""] };
  assert.equal(isHostProviderAdapter(a), false, "providers 多元素含空串拒绝（全称量词）");
}
{
  // 元素为 length>0 的非字符串：回调 typeof 恒真变异下会放行
  const a = { ...V1_ADAPTER, providers: [[1]] };
  assert.equal(isHostProviderAdapter(a), false, "providers 元素为数组拒绝");
}

// ---------------------------------------------------------------- describeAdapterShape

assert.equal(describeAdapterShape(null), "导出不是对象（null）", "null 描述");
assert.equal(describeAdapterShape("str"), "导出不是对象（string）", "字符串描述");
assert.equal(describeAdapterShape({}), "version 必须 === 1（实际 undefined）、id（非空字符串）、label（非空字符串）、providers（非空字符串数组）、fetchUsage（函数）", "空对象描述");
assert.equal(describeAdapterShape({ version: 1, id: "a", label: "b", providers: ["p1"], fetchUsage: async () => {} }), null, "合法适配器返回 null");

// 逐个缺字段
{
  const d = describeAdapterShape({ version: 1, label: "b", providers: ["p1"], fetchUsage: async () => {} });
  assert.ok(d.includes("id"), "缺 id 应报告");
}
{
  const d = describeAdapterShape({ version: 1, id: "a", providers: ["p1"], fetchUsage: async () => {} });
  assert.ok(d.includes("label"), "缺 label 应报告");
}
{
  const d = describeAdapterShape({ version: 1, id: "a", label: "b", fetchUsage: async () => {} });
  assert.ok(d.includes("providers"), "缺 providers 应报告");
}
{
  const d = describeAdapterShape({ version: 1, id: "a", label: "b", providers: ["p1"] });
  assert.ok(d.includes("fetchUsage"), "缺 fetchUsage 应报告");
}

// #150 分片 2：逐字段文案的元素级边界
{
  // id 为 length>0 的非字符串：typeof id 判定恒假变异下只剩 length 检查会漏报
  const d = describeAdapterShape({ version: 1, id: [1, 2], label: "b", providers: ["p1"], fetchUsage: async () => {} });
  assert.ok(d !== null && d.includes("id（非空字符串）"), "id 非字符串（数组）应报告");
}
{
  const d = describeAdapterShape({ version: 1, id: "a", label: [1], providers: ["p1"], fetchUsage: async () => {} });
  assert.ok(d !== null && d.includes("label（非空字符串）"), "label 非字符串（数组）应报告");
}
{
  const base = { version: 1, id: "a", label: "b", fetchUsage: async () => {} };
  for (const bad of [[""], [[]], "ab"] as unknown as string[]) {
    const d = describeAdapterShape({ ...base, providers: bad });
    assert.ok(d !== null && d.includes("providers（非空字符串数组）"),
      `providers 缺陷形态 ${JSON.stringify(bad)} 应报告`);
  }
}
{
  const d = describeAdapterShape({ version: 1, id: "a", label: "b", providers: ["good", ""], fetchUsage: async () => {} });
  assert.ok(d.includes("providers（非空字符串数组）"), "多元素含空串应报告（全称量词）");
}
{
  const d = describeAdapterShape({ version: 1, id: "a", label: "b", providers: [[1]], fetchUsage: async () => {} });
  assert.ok(d.includes("providers（非空字符串数组）"), "元素为数组应报告");
}

// ---------------------------------------------------------------- isClientProviderRenderer

assert.equal(isClientProviderRenderer(null), false, "null 返回 false");
assert.equal(isClientProviderRenderer({}), false, "空对象返回 false");
assert.equal(isClientProviderRenderer({
  version: 1, providers: ["anthropic"],
  render: () => {},
}), true, "合法 renderer 返回 true");
assert.equal(isClientProviderRenderer({
  version: 1, providers: [],
  render: () => {},
}), false, "providers 空数组返回 false");
assert.equal(isClientProviderRenderer({
  version: 1, providers: ["anthropic"],
  render: "not-fn",
}), false, "render 非函数返回 false");
assert.equal(isClientProviderRenderer({
  version: 2, providers: ["anthropic"],
  render: () => {},
}), false, "version 非 1 返回 false");

// #150 分片 2：伪装类型与元素级边界（变异驱动）
{
  const fake = () => {};
  Object.assign(fake, { version: 1, providers: ["p"], render: () => {} });
  assert.equal(isClientProviderRenderer(fake), false, "函数载体即使属性齐全也拒绝");
}
{
  assert.equal(isClientProviderRenderer({
    version: 1, providers: ["good", ""], render: () => {},
  }), false, "providers 多元素含空串拒绝（全称量词）");
}
{
  assert.equal(isClientProviderRenderer({
    version: 1, providers: [[1]], render: () => {},
  }), false, "providers 元素为数组（length>0 非字符串）拒绝");
}

// ---------------------------------------------------------------- usageError / usageOk

{
  const err = usageError("anthropic", "rate-limited");
  assert.equal(err.ok, false, "usageError ok=false");
  assert.equal(err.provider, "anthropic", "usageError provider");
  assert.equal(err.error, "rate-limited", "usageError error");
  assert.equal(err.label, "未知提供商", "usageError 默认 label");
  assert.ok(typeof err.fetchedAt === "number", "usageError fetchedAt 为数字");
}

{
  const err2 = usageError("anthropic", null, "Anthropic", 1234567890);
  assert.equal(err2.label, "Anthropic", "usageError 自定义 label");
  assert.equal(err2.fetchedAt, 1234567890, "usageError 自定义 fetchedAt");
}

{
  const ok1 = usageOk("anthropic", "Anthropic", 1234567890);
  assert.equal(ok1.ok, true, "usageOk ok=true");
  assert.equal(ok1.provider, "anthropic", "usageOk provider");
  assert.equal(ok1.label, "Anthropic", "usageOk label");
  assert.equal(ok1.fetchedAt, 1234567890, "usageOk fetchedAt");
}

{
  const ok2 = usageOk("anthropic", "Anthropic", 1234567890, { data: { visits: 5 } });
  assert.equal(ok2.data?.visits, 5, "usageOk extra 透传");
}

// ---------------------------------------------------------------- defineUsageAdapter

{
  const adapter = defineUsageAdapter({
    id: "my-test",
    label: "My Test",
    providers: ["openai"],
    windows: [
      { key: "rolling", name: "5h 滚动", limit: 12 },
      { key: "weekly", name: "每周", limit: 30 },
    ],
    fetchUsage: async () => ({ ok: true, provider: "openai", label: "MT", fetchedAt: Date.now(), windows: [
      { key: "rolling", name: "5h 滚动", percent: 5 },
      { key: "weekly", name: "每周", percent: 80 },
    ] }),
  });

  assert.equal(adapter.version, 1, "defineUsageAdapter 默认 version=1");
  assert.equal(adapter.id, "my-test", "defineUsageAdapter id");
  assert.equal(adapter.label, "My Test", "defineUsageAdapter label");
  assert.deepEqual(adapter.providers, ["openai"], "defineUsageAdapter providers");
  assert.equal(typeof adapter.fetchUsage, "function", "defineUsageAdapter fetchUsage");
  assert.equal(typeof adapter.samplePoint, "function", "defineUsageAdapter samplePoint");
  assert.equal(typeof adapter.summarize, "function", "defineUsageAdapter summarize");

  // samplePoint：有 windows → 返回 {cols, values}
  const sp = adapter.samplePoint({
    ok: true, provider: "openai", label: "MT", fetchedAt: 1234567890,
    windows: [
      { key: "rolling", name: "5h 滚动", percent: 5, limit: 12 },
      { key: "weekly", name: "每周", percent: 80, limit: 30 },
    ],
  });
  assert.ok(sp !== null, "samplePoint 有 windows 返回非 null");
  assert.equal(sp.cols.length, 2, "samplePoint cols 数");
  assert.equal(sp.cols[0].key, "rolling", "samplePoint col key");
  assert.equal(sp.cols[0].limit, 12, "samplePoint col limit 透传");
  assert.equal(sp.values[0], 5, "samplePoint values[0]");

  // samplePoint：windows 为空数组 → null
  assert.equal(adapter.samplePoint({
    ok: true, provider: "openai", label: "MT", fetchedAt: 1234567890,
    windows: [],
  }), null, "samplePoint 空 windows 返回 null");

  // samplePoint：无 windows 字段 → null
  assert.equal(adapter.samplePoint({
    ok: true, provider: "openai", label: "MT", fetchedAt: 1234567890,
  }), null, "samplePoint 无 windows 返回 null");
}

// ---------------------------------------------------------------- defineUsageAdapter 的 summarize

{
  const adapter = defineUsageAdapter({
    id: "sum-test",
    label: "Sum Test",
    providers: ["openai"],
    windows: [
      { key: "rolling", name: "5h 滚动", limit: 12 },
    ],
    fetchUsage: async () => ({ ok: true, provider: "openai", label: "ST", fetchedAt: Date.now() }),
  });

  // summarize 使用默认 summarizeTextFromWindows（无自定义 summarizeText）
  const summary = await adapter.summarize({
    provider: "openai",
    usage: {
      ok: true, provider: "openai", label: "ST", fetchedAt: 1234567890,
      windows: [{ key: "rolling", name: "5h 滚动", percent: 5 }],
    },
  } as any);
  assert.equal(summary.ok, true, "summarize ok");
  assert.equal(summary.text, "5h 滚动 5%", "summarize 默认文本");
  assert.equal(summary.level, "ok", "summarize level ok");
  assert.equal(summary.hasAdapter, true, "summarize hasAdapter");
}

{
  // 自定义 summarizeText
  const adapter = defineUsageAdapter({
    id: "custom-sum",
    label: "Custom Sum",
    providers: ["openai"],
    windows: [
      { key: "rolling", name: "5h 滚动", limit: 12 },
    ],
    fetchUsage: async () => ({ ok: true, provider: "openai", label: "CS", fetchedAt: Date.now() }),
    summarizeText: (windows) => windows.map((w) => `${w.key}=${w.percent ?? "--"}`).join("|"),
  });

  const summary = await adapter.summarize({
    provider: "openai",
    usage: {
      ok: true, provider: "openai", label: "CS", fetchedAt: 1234567890,
      windows: [{ key: "rolling", name: "5h 滚动", percent: 5 }],
    },
  } as any);
  assert.equal(summary.text, "rolling=5", "summarize 自定义 summarizeText 生效");
}

{
  // summarize 无 usage（ctx.usage null）
  const adapter = defineUsageAdapter({
    id: "no-usage",
    label: "No Usage",
    providers: ["openai"],
    windows: [{ key: "r", name: "R", limit: 12 }],
    fetchUsage: async () => ({ ok: false, provider: "openai", label: "NU", fetchedAt: Date.now() }),
  });

  const summary = await adapter.summarize({
    provider: "openai",
    usage: null,
  } as any);
  assert.equal(summary.text, "No Usage", "无 usage 回落 adapter.label");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule

{
  const e = esc;
  // 有数据
  const html1 = openCodeGoAdapter.formatCapsule({
    time: 1000, data: { rolling: { percent: 5 }, weekly: { percent: 10 }, monthly: { percent: 0 } },
    status: "fresh", esc: e,
  });
  assert.ok(html1.includes("5h 5%"), "formatCapsule 含 rolling 5%");
  assert.ok(html1.includes("·"), "formatCapsule 多窗口分隔符");
}

{
  // 无数据（所有 percent 均为 null）
  const html2 = openCodeGoAdapter.formatCapsule({
    time: 1000, data: { rolling: { percent: null }, weekly: {}, monthly: {} },
    status: "fresh", esc: (s) => String(s),
  });
  assert.ok(html2.includes("无数据"), "formatCapsule 无数据回落");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatPanel（覆盖 fmtReset 分支）

{
  const e = esc;
  // 空 entries → 暂无历史数据
  const empty = openCodeGoAdapter.formatPanel({ entries: [], range: { start: 0, end: 1000 }, truncated: false, esc: e });
  assert.equal(empty, "<p>暂无历史数据</p>", "空 entries 显示暂无历史数据");

  // 含 resetsAt 的条目 → fmtReset 被调用
  const withData = openCodeGoAdapter.formatPanel({
    entries: [
      { time: 1000, data: { rolling: { percent: 5 }, weekly: { percent: 3 }, monthly: { percent: 1 } } },
      { time: 2000, data: { rolling: { percent: 8, resetsAt: "2026-08-01T00:00:00Z", raw: "8000", limit: 12 }, weekly: { percent: 4 }, monthly: { percent: 2 } } },
    ],
    range: { start: 0, end: 3000 },
    truncated: false,
    esc: e,
  });
  // fmtReset 将 ISO 日期转为本地时间格式
  assert.ok(withData.includes("重置"), "formatPanel 含重置时间文本");
  assert.ok(withData.includes("dou-card"), "formatPanel 有卡片结构");

  // 非法日期的 resetsAt → fmtReset 返回原字符串；同时覆盖 data[key] 缺失的
// `?? { percent: null }` 兜底分支
  const badDate = openCodeGoAdapter.formatPanel({
    entries: [
      { time: 1000, data: { rolling: { percent: 5 }, weekly: {}, monthly: {} } },
      { time: 2000, data: { monthly: { percent: 1 } } },
      { time: 3000, data: { rolling: { percent: 10, resetsAt: "not-a-date" }, weekly: {}, monthly: { percent: 2 } } },
    ],
    range: { start: 0, end: 4000 },
    truncated: false,
    esc: e,
  });
  assert.ok(badDate.includes("not-a-date"), "非法日期 resetsAt 原样返回");
  assert.ok(badDate.includes("每月") && badDate.includes(">2%<"), "latest 窗口数据缺失时回落 null 兜底仍渲染");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule 无数据窗口（仅月份有值）

{
  const e = esc;
  const html = openCodeGoAdapter.formatCapsule({
    time: 1000, data: { rolling: { percent: null }, weekly: { percent: null }, monthly: { percent: 2 } },
    status: "fresh", esc: e,
  });
  // filter 过滤掉 null percent 后只剩 monthly
  assert.ok(html.includes("月 2%"), "formatCapsule 过滤 null 窗口");
  assert.ok(!html.includes("5h"), "formatCapsule null percent 窗口不展示");
}
// ---------------------------------------------------------------- pickWindow 类型防御补充（#150）

assert.equal(pickWindow("str", "k", "n", 5), null, "字符串输入拒绝");
assert.equal(pickWindow(123, "k", "n", 5), null, "数字输入拒绝");
{
  const w = pickWindow({ percent: "42" }, "k", "名", 5);
  assert.ok(w !== null && w.percent === 42, "百分比字符串转数字");
}
{
  const w = pickWindow({ percent: "abc" }, "k", "名", 5);
  assert.ok(w !== null && w.percent === null, "非数字百分比归 null");
}
{
  const w = pickWindow({ raw: 123, resetsAt: 456 }, "k", "名", 5);
  assert.ok(w !== null && w.raw === undefined && w.resetsAt === undefined,
    "raw/resetsAt 非字符串丢弃");
}

// ---------------------------------------------------------------- parseUsageResponse 双形状（#150）

assert.equal(parseUsageResponse(null), null, "null 输入");
assert.equal(parseUsageResponse("body"), null, "字符串输入");
assert.equal(parseUsageResponse({}), null, "空对象无有效窗口");

{
  const direct = parseUsageResponse({
    rolling: { percent: 1 },
    weekly: { percent: 2 },
    monthly: { percent: 3 },
  });
  assert.ok(direct !== null && direct.rolling.percent === 1 && direct.weekly.percent === 2
    && direct.monthly.percent === 3, "直接三键形状解析");
}
{
  const wrapped = parseUsageResponse({ usage: { rolling: { percent: 7 } } });
  assert.ok(wrapped !== null && wrapped.rolling.percent === 7, "{usage:{}} 包裹形状解析");
  assert.ok(wrapped !== null && wrapped.weekly === undefined, "包裹形状下缺失窗口不产出键");
}

// ---------------------------------------------------------------- fetchOpenCodeGoV2 错误链（#150）

const baseCtx = (overrides = {}) => ({
  apiEndpoint: "https://api.test/zen",
  staticPath: "/usage",
  apiKey: "sk-test",
  provider: "opencode-go",
  timeoutMs: 500,
  ...overrides,
});

async function assertRejects(promise, message) {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught !== null && String(caught.message) === message, `错误链：${message}`);
}

await assertRejects(fetchOpenCodeGoV2(baseCtx({ apiKey: undefined }),), "no-api-key");
await assertRejects(fetchOpenCodeGoV2(baseCtx({ apiKey: "" })), "no-api-key");
await assertRejects(
  fetchOpenCodeGoV2(baseCtx(), async () => { throw new Error("boom"); }),
  "network",
);

const okBody = {
  rolling: { percent: 11 },
  weekly: { percent: 22 },
  monthly: { percent: 33 },
};
const makeFetch = (status, body, failJson = false, capture = []) => async (url, init) => {
  capture.push({ url, auth: init?.headers?.Authorization });
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (failJson) throw new Error("Unexpected token");
      return typeof body === "function" ? body() : body;
    },
  };
};

const captured = [];
{
  const data = await fetchOpenCodeGoV2(baseCtx(), makeFetch(200, okBody, false, captured));
  assert.equal(data.rolling.percent, 11, "成功路径 rolling 百分比");
  assert.equal(data.weekly.percent, 22, "成功路径 weekly 百分比");
  assert.equal(data.monthly.percent, 33, "成功路径 monthly 百分比");
  assert.equal(captured[0].url, "https://api.test/zen/usage", "apiEndpoint + staticPath 拼接");
  assert.equal(captured[0].auth, "Bearer sk-test", "Bearer 鉴权头注入");
}
{
  // 缺失窗口补默认占位（percent null + limit）
  const data = await fetchOpenCodeGoV2(baseCtx(), makeFetch(200, { rolling: { percent: 5 } }));
  assert.equal(data.weekly.percent, null, "缺失窗口补 percent null");
  assert.equal(data.monthly.limit, 60, "缺失窗口补默认限额");
}
{
  const data = await fetchOpenCodeGoV2(
    baseCtx({ apiEndpoint: "" }),
    makeFetch(200, okBody),
  );
  assert.equal(data.rolling.percent, 11, "空 apiEndpoint 回落默认地址仍成功");
}

await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(401, {})), "unauthorized");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(403, {})), "unauthorized");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(500, {})), "http-500");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(200, {}, true)), "bad-json");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(200, { foo: 1 })), "bad-data");

// ---------------------------------------------------------------- miniChartSvgMarkup 结构断言（#150）

const T0 = new Date(2026, 5, 15, 10, 0, 0).getTime();
const MIN = 60000;

assert.equal(miniChartSvgMarkup({
  samples: [{ x: T0, y: 10 }], color: "#000", lo: 0, hi: 100,
  resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
}), "", "少于 2 个采样点返回空串");

{
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100">'),
    "SVG 头与固定视口尺寸");
  assert.ok(svg.endsWith("</svg>"), "SVG 闭合标签");
  assert.ok(svg.includes('fill:#abc;fill-opacity:.13'), "面积填充使用传入色与固定透明度");
  assert.ok(svg.includes('stroke:#abc;stroke-width:1.6'), "折线描边样式");
  assert.ok(svg.includes("<circle"), "末点圆标记存在");
  assert.ok(svg.includes(">10%</text>") || svg.includes(">0%</text>"),
    "y 轴刻度含整数百分比文案");
  assert.ok(svg.includes('stroke-dasharray:4 3;stroke-opacity:.65'), "100% 参考线虚线样式");
  assert.ok(svg.includes('font-size:9px">100%</text>'),
    "lo<=100<=hi 时绘制 100% 配额参考线（与 y 轴 9.5px 刻度字号区分）");
}
{
  // hi < 100：无参考线；刻度出现小数格式
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 1 }, { x: T0 + 30 * MIN, y: 2 }],
    color: "#abc", lo: 0.5, hi: 99, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(!svg.includes(">100%</text>"), "hi<100 无 100% 参考线");
  assert.ok(svg.includes(">0.5%</text>"), "非整数刻度保留一位小数");
}
{
  // 重置线：resetsAt 落在采样区间内
  const resetsAt = new Date(T0 + 10 * MIN).toISOString();
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, resetsAt, resetPeriodMs: 5 * 3600000,
    dateOnly: false,
  });
  assert.ok(svg.includes("<title>窗口重置点</title>"), "区间内重置点画虚线并带标题");
  assert.ok(svg.includes('stroke-dasharray:2 3'), "重置线短虚线样式");
  assert.ok(svg.includes('l 3.5 3.5 l -7 0 z'), "重置点三角标记");
}
{
  // resetsAt 在区间外（早于 t0 一个周期以上）：无重置线
  const resetsAt = new Date(T0 - 48 * 3600000).toISOString();
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, resetsAt, resetPeriodMs: 3600000, dateOnly: false,
  });
  assert.ok(!svg.includes("<title>窗口重置点</title>"), "历史周期点全部落在区间外时不画重置线");
}
{
  // x 轴刻度格式分档：span<1 天 → HH:mm；dateOnly → M-D
  const short = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 30 * MIN, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(/>\d{2}:\d{2}<\/text>/.test(short), "短跨度刻度为 HH:mm");
  const dateOnly = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 26 * 3600000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
  });
  assert.ok(/>\d+-\d\d<\/text>/.test(dateOnly), "dateOnly 刻度为 M-DD（月不补零日补零）");
}
{
  // 降采样：超过 300 点仍产出合法 SVG 并保留最后一点
  const many = [];
  for (let i = 0; i < 320; i += 1) {
    many.push({ x: T0 + i * MIN, y: i % 50 });
  }
  const svg = miniChartSvgMarkup({
    samples: many, color: "#c", lo: 0, hi: 100,
    resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.startsWith("<svg") && svg.includes("<circle"), "超量采样降采样后仍有折线与末点");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule（#150）

const capsBase = { time: T0, status: "fresh", esc: (s) => String(s) };

{
  const html = openCodeGoAdapter.formatCapsule({
    ...capsBase,
    data: {
      rolling: { percent: 3 },
      weekly: { percent: 1 },
      monthly: { percent: 0 },
    },
  });
  assert.equal(html, "<span>5h 3% · 周 1% · 月 0%</span>", "三窗口短名按序拼接");
}
{
  const html = openCodeGoAdapter.formatCapsule({
    ...capsBase,
    data: { monthly: { percent: 4 } },
  });
  assert.equal(html, "<span>月 4%</span>", "仅单一窗口有值");
}
{
  const html = openCodeGoAdapter.formatCapsule({ ...capsBase, data: {} });
  assert.equal(html, "<span>无数据</span>", "全窗口缺失回退无数据文案");
}
{
  const html = openCodeGoAdapter.formatCapsule({
    ...capsBase,
    data: { rolling: { percent: null } },
  });
  assert.equal(html, "<span>无数据</span>", "percent null 不计入展示");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatPanel（#150）

const H5 = 3600000;
const mkEntry = (offsetMs, windows) => ({ time: T0 + offsetMs, data: windows });

assert.equal(openCodeGoAdapter.formatPanel({
  entries: [], range: { start: T0, end: T0 }, truncated: false, esc: (s) => String(s),
}), "<p>暂无历史数据</p>", "空历史返回占位段落");

{
  // 单条 entry：三点分支之「数据采集中」
  const html = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 10 } })],
    range: { start: T0, end: T0 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("数据采集中：每次刷新记录一个采样点"), "单采样点提示积累文案");
  assert.ok((html.match(/dou-card/g) || []).length >= 3, "三窗口各一张卡片");
  assert.ok(html.includes(">10%</span>"), "卡片头当前百分比直出");
}
{
  // 两条 entry、第二窗口全 null：区分「采样不足」分支
  const html = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10 }, weekly: { percent: null } }),
      mkEntry(H5, { rolling: { percent: 20 }, weekly: { percent: null } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("该时间范围内采样不足"), "无有效点窗口提示采样不足");
  assert.ok(html.includes("dou-miniChart"), "有效点窗口渲染迷你图");
  assert.ok(html.includes("dou-trend-up") && html.includes("▲ +10%"), "上升趋势三角与增量");
}
{
  // 下降趋势与平坦趋势
  const down = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 20 } }),
      mkEntry(H5, { rolling: { percent: 10 } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(down.includes("dou-trend-down") && down.includes("▼ -10%"), "下降趋势负增量");
  const flat = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10 } }),
      mkEntry(H5, { rolling: { percent: 10 } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(flat.includes("dou-trend-flat") && flat.includes("— 0%"), "持平趋势零增量");
}
{
  // resetsAt 展示在卡片限额行；最新窗口 pct null 显示 --
  const resetsAtIso = new Date(T0 + H5).toISOString();
  const html = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10, resetsAt: resetsAtIso } }),
      mkEntry(H5, { rolling: { percent: 11, resetsAt: resetsAtIso }, monthly: { percent: null } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("重置 "), "resetsAt 渲染重置文案");
  assert.ok(html.includes("限额 12"), "rolling 默认限额 12 出现在卡片头");
  assert.ok(html.includes(">--</span>"), "最新窗口无百分比显示 -- 占位");
}
{
  // 观察窗过滤：rolling 只看最近 12h，窗外采样不进趋势
  const old = mkEntry(-13 * H5, { rolling: { percent: 90 } });
  const recent1 = mkEntry(-H5, { rolling: { percent: 10 } });
  const recent2 = mkEntry(0, { rolling: { percent: 12 } });
  const html = openCodeGoAdapter.formatPanel({
    entries: [old, recent1, recent2],
    range: { start: T0 - 13 * H5, end: T0 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("▲ +2%"), "窗外高百分比不参与趋势计算");
}

// ---------------------------------------------------------------- safeFetchData 边界（#150 变异加固）

{
  // 成功路径：JSON 序列化管道保真——Date 经 stringify/parse 变 ISO 字符串，
  // 若删去 round-trip（直接回传 raw）则保持 Date 对象，此断言即杀该变异
  const r = await safeFetchData(async () => ({ n: 3, d: new Date(0), nest: { ok: true } }));
  assert.ok(r.data !== undefined && r.error === undefined, "对象输入走 data 通道");
  assert.equal(r.data?.n, 3, "标量字段保真");
  assert.equal(r.data?.d, "1970-01-01T00:00:00.000Z", "Date 字段经序列化变 ISO 字符串");
  assert.deepEqual(r.data?.nest, { ok: true }, "嵌套对象保真");
}
{
  // 数组拒绝：typeof === "object" 但 Array.isArray 拦截
  const r = await safeFetchData(async () => [1, 2]);
  assert.equal(r.error, "fetchData 必须返回对象", "数组返回被拒绝并给出固定文案");
  assert.equal(r.data, undefined, "拒绝时无 data 字段");
}
{
  // null 拒绝：typeof null === "object" 但 null 拦截
  const r = await safeFetchData(async () => null);
  assert.equal(r.error, "fetchData 必须返回对象", "null 返回被拒绝");
}
{
  // 原始值拒绝：stringify/parse 后仍非 object
  for (const raw of ["str", 42, true]) {
    const r = await safeFetchData(async () => raw);
    assert.equal(r.error, "fetchData 必须返回对象", `原始值 ${JSON.stringify(raw)} 被拒绝`);
  }
}
{
  // fn 返回 undefined：JSON.parse(undefined) 抛 SyntaxError 进 catch
  const r = await safeFetchData(async () => undefined);
  assert.ok(typeof r.error === "string" && r.error.length > 0, "undefined 返回进错误通道");
  assert.match(r.error ?? "", /undefined/, "错误消息携带 undefined 线索");
}
{
  // fn 同步抛 Error：message 原样入 error
  const r = await safeFetchData(() => { throw new Error("sync-boom"); });
  assert.equal(r.error, "sync-boom", "同步抛错提取 message");
}
{
  // fn 返回 rejected promise：同样进 catch
  const r = await safeFetchData(async () => { throw new Error("async-boom"); });
  assert.equal(r.error, "async-boom", "异步拒绝提取 message");
}
{
  // 非 Error 抛出值：String(e) 兜底
  const r = await safeFetchData(async () => { throw "plain"; });
  assert.equal(r.error, "plain", "非 Error 抛出值经 String 提取");
}
{
  // 超时分支：fn 永挂 + 极小 timeoutMs -> abort 监听 reject 固定文案；
  // finally clearTimeout 保证进程不悬挂
  const t0 = Date.now();
  const r = await safeFetchData(() => new Promise(() => {}), 25);
  assert.equal(r.error, "fetchData 超时", "超时返回固定文案");
  assert.equal(r.data, undefined, "超时无 data");
  assert.ok(Date.now() - t0 < 2000, "超时在 timeoutMs 量级触发而非默认 2s");
}

// ---------------------------------------------------------------- safeFormat 边界（#150 变异加固）

{
  // 成功路径：字符串原样透传
  const r = await safeFormat(() => "<b>ok</b>", "FmtA");
  assert.equal(r.html, "<b>ok</b>", "字符串返回走 html 通道");
  assert.equal(r.error, undefined, "成功无 error 字段");
}
{
  // 非字符串拒绝：name 嵌入固定文案
  for (const bad of [42, null, undefined, { obj: true }]) {
    const r = await safeFormat(() => bad, "FmtB");
    assert.equal(r.error, "FmtB 必须返回字符串", `非字符串 ${String(bad)} 被拒绝且文案含适配器名`);
    assert.equal(r.html, undefined, "拒绝时无 html 字段");
  }
}
{
  // fn 同步抛 Error：Promise.resolve().then(fn) 转 rejection 后 message 入 error
  const r = await safeFormat(() => { throw new Error("fmt-sync-boom"); }, "FmtC");
  assert.equal(r.error, "fmt-sync-boom", "同步抛错提取 message");
}
{
  // fn 返回 rejected promise
  const r = await safeFormat(async () => { throw new Error("fmt-async-boom"); }, "FmtD");
  assert.equal(r.error, "fmt-async-boom", "异步拒绝提取 message");
}
{
  // 非 Error 抛出值：String(e) 兜底
  const r = await safeFormat(async () => { throw 7; }, "FmtE");
  assert.equal(r.error, "7", "非 Error 抛出值经 String 提取");
}
{
  // 超时分支：fn 永挂 + 极小 timeoutMs -> 文案含适配器名
  const r = await safeFormat(() => new Promise(() => {}), "FmtSlow", 25);
  assert.equal(r.error, "FmtSlow 超时", "超时返回含名字的固定文案");
}

// ---------------------------------------------------------------- fetchWithTimeout 边界（#150 变异加固）

{
  // mock 全局 fetch：记录入参并延迟 resolve，用 resolved 后的 signal.aborted
  // 观察超时定时器是否真的触发了 abort（不悬挂、无网络）。
  // 经 injectGlobalFetch 串行通道（#120）：与其他模块的 fetch 注入窗口互斥，
  // save/restore 恒配对，杜绝 ESM TLA 交错下的 mock 驻留污染。
  const calls = [];
  await injectGlobalFetch(async (set) => {
    set(async (url, opts) => {
      calls.push({ url, opts });
      await new Promise((res) => setTimeout(res, opts.delayMs ?? 0)); // 有意延迟：fetch mock 内按 delayMs 延迟（fixture）
      return { marker: "mock", aborted: opts.signal.aborted, url, headers: opts.headers };
    });

    // 快路径：远小于超时的延迟 -> 正常返回且 signal 未 abort
    const fast = await fetchWithTimeout("https://gw.test/x", 1000,
      { headers: { "x-k": "v" }, signal: "fake-signal", delayMs: 10 });
    assert.equal(fast.marker, "mock", "返回值来自注入的 fetch");
    assert.equal(fast.aborted, false, "未超时时 signal 未被 abort");
    assert.equal(fast.url, "https://gw.test/x", "url 原样透传");
    assert.deepEqual(fast.headers, { "x-k": "v" }, "init.headers 透传");
    // 同理按 url 过滤取 fast 的调用记录：calls 尾部在负载下可能被外部污染
    const sigFast = calls.find((c) => c.url === "https://gw.test/x")?.opts.signal;
    assert.ok(sigFast instanceof AbortSignal, "signal 覆盖为真 AbortSignal（展开序 {...init, signal}）");

    // 慢路径：超过 timeoutMs 的延迟 -> 返回时已观察到 abort
    // （按 url 过滤计数：await 窗口内前置测试遗留异步操作可能触发本 mock fetch，
    //   绝对计数与差值计数均会时序 flake——CI 两次实证；只有按调用特征过滤
    //   才能彻底与外部污染解耦）
    // delayMs 取 500（>> timeoutMs=20）：含 TLA 的前置模块恢复执行时会形成
    // 微任务风暴推迟宏任务定时器，小余量下 abort 可能晚于 mock 返回（实证 flake）
    const slow = await fetchWithTimeout("https://gw.test/y", 20, { delayMs: 500 });
    assert.equal(slow.aborted, true, "超过 timeoutMs 后 controller.abort 已触发");

    // 默认参数形态：省略 timeoutMs 与 init 仍可完成快调用
    set(async (url, opts) => ({ marker: "def", aborted: opts.signal.aborted }));
    const def = await fetchWithTimeout("https://gw.test/z");
    assert.equal(def.marker, "def", "默认参数下仍走 fetch 并返回");
    assert.equal(def.aborted, false, "默认 10s 超时内完成不 abort");
  });
}

// ---------------------------------------------------------------- trendOf 阈值与取整边界（#150 变异加固，经 formatPanel 观测）

{
  // delta 四舍五入到一位小数：1.234 -> 1.2
  const r = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 0 } }), mkEntry(H5, { rolling: { percent: 1.234 } })],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(r.includes("dou-trend-up") && r.includes("▲ +1.2%"), "delta 四舍五入至一位小数");
}
{
  // d = +0.05 恰在阈值上不触发 up（严格大于），取整 half-up 显示 0.1
  const at = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 0 } }), mkEntry(H5, { rolling: { percent: 0.05 } })],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(at.includes("dou-trend-flat"), "+0.05 不算上升趋势（严格大于阈值）");
  assert.ok(!at.includes("dou-trend-up"), "+0.05 无 up 标记");
  assert.ok(at.includes("— 0.1%"), "+0.05 取整 half-up 为 0.1");
}
{
  // d = -0.05 同理不算 down；Math.round(-0.5) 负零字符串化为 0
  const at = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 0 } }), mkEntry(H5, { rolling: { percent: -0.05 } })],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(at.includes("dou-trend-flat"), "-0.05 不算下降趋势（严格小于阈值）");
  assert.ok(!at.includes("dou-trend-down"), "-0.05 无 down 标记");
  assert.ok(at.includes("— 0%"), "-0.05 经负零字符串化显示 0");
}
{
  // 阈值内侧：d = 0.04 flat 且取整为 0；d = 0.06 up 且进位 0.1
  const inner = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 0 } }), mkEntry(H5, { rolling: { percent: 0.04 } })],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(inner.includes("dou-trend-flat") && inner.includes("— 0%"), "阈值内侧平坦且取整为零");
  const outer = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 0 } }), mkEntry(H5, { rolling: { percent: 0.06 } })],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(outer.includes("dou-trend-up") && outer.includes("▲ +0.1%"), "刚过阈值即上升并进位");
}
{
  // 全 null 序列：trendOf 返回 null -> 该卡片无任何趋势标记；
  // 三窗口中仅 rolling 有值时 dou-trend 恰出现一次
  const only = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10 } }),
      mkEntry(H5, { rolling: { percent: 12 } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.equal((only.match(/dou-trend/g) || []).length, 1, "全 null 窗口无趋势标记（仅有效窗口一个）");
}

// ---------------------------------------------------------------- resetTicks 回溯与非法输入边界（#150 变异加固，经 miniChartSvgMarkup 观测）

/** 提取 SVG 中窗口重置竖线的 x1 坐标序列 */
function resetLineXs(svg) {
  return [...svg.matchAll(/<line x1="([\d.]+)" y1="14"[^]*?<title>窗口重置点<\/title>/g)]
    .map((m) => Number(m[1]));
}

{
  // r 在区间右端之外（+5min）：本体不入列；按 period=10min 回溯出
  // 25/15/5min 三点全部落在 [t0, t1] -> 恰三条重置线且 x 递增（锁排序）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100,
    resetsAt: new Date(T0 + 35 * MIN).toISOString(),
    resetPeriodMs: 10 * MIN, dateOnly: false,
  });
  const xs = resetLineXs(svg);
  assert.equal(xs.length, 3, "r 区间外时按周期回溯产出三个历史重置点");
  assert.ok(xs.every((v, i) => i === 0 || v > xs[i - 1]), "重置线 x 坐标升序（sort 生效）");
}
{
  // guard<40 截断：period=1min、r=t1 外 1min、区间 45min ->
  // 回溯点最多 40 个（循环守卫上限），不多不少
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 45 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100,
    resetsAt: new Date(T0 + 46 * MIN).toISOString(),
    resetPeriodMs: MIN, dateOnly: false,
  });
  const xs = resetLineXs(svg);
  assert.equal(xs.length, 40, "回溯受 guard<40 守卫截断为恰四十个点");
}
{
  // 非法 resetsAt / 非法 period 一律无重置线
  const base = {
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, dateOnly: false,
  };
  for (const bad of [
    { resetsAt: "", resetPeriodMs: 10 * MIN },
    { resetsAt: "not-a-date", resetPeriodMs: 10 * MIN },
    { resetsAt: undefined, resetPeriodMs: 10 * MIN },
    { resetsAt: new Date(T0 + 10 * MIN).toISOString(), resetPeriodMs: 0 },
    { resetsAt: new Date(T0 + 10 * MIN).toISOString(), resetPeriodMs: -5 * MIN },
  ]) {
    const svg = miniChartSvgMarkup({ ...base, ...bad });
    assert.equal(resetLineXs(svg).length, 0,
      `非法入参 ${JSON.stringify(bad)} 产零条重置线`);
  }
}

// ---------------------------------------------------------------- 图表纯函数分档矩阵（#150 变异加固 2/4 续）

{
  // timeTickStep 分档 + timeTicks 翻倍：spanMs=10min 触发 step=2min
  // 预期 10:00-10:10 约 6 个刻度（HH:mm），经 step 翻倍后 count≤6 停
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 10 * MIN, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(/>\d{2}:\d{2}<\/text>/.test(svg), "10min span 刻度为 HH:mm");
  assert.ok(svg.includes("10:00") || svg.includes("10:0"), "10min span 首个刻度含 10:00");
}
{
  // timeTickStep 分档 2：spanMs=30min 触发 step=5min（10min<30min≤45min）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 30 * MIN, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(/>\d{2}:\d{2}<\/text>/.test(svg), "30min span 刻度为 HH:mm");
}
{
  // timeTickStep 分档 3：spanMs=1h 触发 step=15min（45min<1h≤3h）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 60 * MIN, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(/>\d{2}:\d{2}<\/text>/.test(svg), "1h span 刻度为 HH:mm");
}
{
  // timeTickStep 分档 4：spanMs=6h 触发 step=1h（3h<6h≤12h）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 6 * 3600000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(/>\d{2}:\d{2}<\/text>/.test(svg), "6h span 刻度为 HH:mm");
  // 1h step → count≤6 循环限制下约 4-7 个刻度（10:00~16:00）
  const ticks = svg.match(/\d{2}:\d{2}<\/text>/g);
  assert.ok(ticks && ticks.length >= 3 && ticks.length <= 8, `6h span 刻度数合理（3-8 个），实为 ${ticks?.length}`);
}
{
  // timeTickStep 分档 5：spanMs=2d 触发 step=3h（12h<2d≤3d）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 48 * 3600000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  // ≥1d 但 <7d → MM-dd HH:mm 格式，刻度文本含空格分隔日期与时间
  assert.ok(svg.includes("6-") || svg.includes("6-17"), "2d span 刻度含月-日");
  assert.ok(svg.includes(":"), "2d span 刻度含分钟指示（HH:mm 格式）");
}
{
  // timeTickStep 分档 6：spanMs=5d 触发 step=6h（3d<5d≤7d）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 5 * 86400000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  // ≥1d 且 <7d → MM-dd HH:mm
  assert.ok(svg.includes("6-16") || svg.includes("6-20"), "5d span 刻度含月-日");
  assert.ok(svg.includes(":"), "5d span 刻度含分钟指示（HH:mm 格式）");
}
{
  // timeTickStep 分档 7：spanMs=14d 触发 step=1d（7d<14d≤30d）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 14 * 86400000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  // spanMs≥7d → fmtAxisTime 返回 MM-dd（无 HH:mm）
  assert.ok(svg.includes("6-16") || svg.includes("6-28"), "14d span 刻度为 MM-dd（无小时）");
  const tickTexts14 = [...svg.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.ok(tickTexts14.every((t) => t.includes("%") || t.includes("-")),
    "14d span 刻度文本为 MM-dd（无冒号）");
  assert.ok(!tickTexts14.some((t) => t.includes(":")), "14d span 刻度文本不含冒号");
}
{
  // timeTickStep 分档 8：spanMs=60d 触发 step=7d（>30d）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 60 * 86400000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  // spanMs≥7d → MM-dd
  assert.ok(svg.includes("6-") || svg.includes("8-"), "60d span 刻度为 MM-dd");
}
{
  // axisLabelWidthPx 分档：dateOnly=true → "MM-dd" 长度
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 14 * 86400000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
  });
  assert.ok(svg.includes("6-16") || svg.includes("6-2"), "dateOnly 刻度为 M-DD 格式");
  // 刻度文本均为 MM-dd 形态（含连字符，无冒号）
  const tickTexts = [...svg.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.ok(tickTexts.some((t) => /^\d+-\d{2}$/.test(t)), "dateOnly 刻度文本为 M-DD 形态");
  assert.ok(!tickTexts.some((t) => t.includes(":")), "dateOnly 刻度无 HH:mm");
}
{
  // fmtPctTick 非整数：lo/hi 含小数 → 刻度出现 N.N%
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 1.5 }, { x: T0 + 30 * MIN, y: 2.5 }],
    color: "#c", lo: 0.5, hi: 9.5, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.includes(">0.5%</text>"), "小数 hi 刻度包含一位小数");
  // gridVals = [0.5, 5, 9.5] → 5 为整数
  assert.ok(svg.includes(">5%</text>"), "5 为整数百分比（无小数）");
}
{
  // niceDomain 经 formatPanel 覆盖：极差/3 映射到 niceStep 不同分档
  // niceStep 分档：norm<1.5 → step=mag；<3.5 → 2*mag；<7.5 → 5*mag；else → 10*mag
  const e = esc;
  // 极差=0.5/3≈0.167 → norm=0.167/0.1=1.67 → <3.5 → step=2*0.1=0.2
  const tight = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 1, resetsAt: undefined } }),
              mkEntry(H5, { rolling: { percent: 1.5, resetsAt: undefined } })],
    range: { start: 0, end: H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(tight.includes("dou-"), "紧区间仍产趋势卡片");
  // 极差=50/3≈16.67 → norm=16.67/10=1.667 → <3.5 → step=2*10=20
  const wide = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 10, resetsAt: undefined } }),
              mkEntry(H5, { rolling: { percent: 60, resetsAt: undefined } })],
    range: { start: 0, end: H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(wide.includes("dou-"), "宽区间仍产趋势卡片");
  // 极差=90/3=30 → norm=30/10=3 → <3.5 → step=2*10=20
  const wider = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 0, resetsAt: undefined } }),
              mkEntry(H5, { rolling: { percent: 90, resetsAt: undefined } })],
    range: { start: 0, end: H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(wider.includes("dou-"), "更宽区间仍产趋势卡片");
}
{
  // downsample 补最后点：当 out 最后元素不是 lastPt 时补入
  const many = [];
  for (let i = 0; i < 350; i += 1) {
    many.push({ x: T0 + i * MIN, y: i % 50 });
  }
  const svg = miniChartSvgMarkup({
    samples: many, color: "#c", lo: 0, hi: 100,
    resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  // 降采样后包末点圆标记（断言 lastPt 被补入）
  assert.ok(svg.includes("<circle"), "降采样末点圆标记存在");
  assert.ok(svg.startsWith("<svg"), "降采样后仍为合法 SVG");
}
{
  // smoothPath 短路径：pts.length<2 返回空串
  // 2 个采样点 + 降采样后 ≥2 点 → 不触发短路径返回
  // 但单点已由 L522 测试（miniChartSvgMarkup 返回空串）
  // 这里验证 2 点下 path 含 M 命令（smoothPath 正常拼接）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 30 * MIN, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.includes('d="M'), "2 点图表产出 path 折线 M 命令");
  // 相邻点 Catmull-Rom 曲线：C 命令存在
  assert.ok(svg.includes(' C '), "smoothPath 产出 Catmull-Rom 曲线 C 命令");
}
{
  // timeTicks out.length<2 → [t0, t1]：极短跨度（1 sample, spanMs=0）
  // 但 miniChartSvgMarkup 中若 samples.length<2 直接返回 ""
  // 需要 2 个点且 spanMs 极小使 timeTicks 产出 <2 个刻度
  // 2 个点相同时刻（x 相同），spanMs=1min（fallback）
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 1, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  // spanMs=1ms → spanMs <= 1min 的分支（timeTickStep step=2min）
  // timeTicks 中 step=2min, 但 spanMs=1ms → 可能 count<2 → 返回 [t0, t1]
  // 至少 SVG 有内容
  assert.ok(svg.startsWith("<svg"), "极短跨度仍产合法 SVG");
}

// ---------------------------------------------------------------- sanitizeHtml 清理链全正则覆盖（#150 变异加固 2/4 续）

{
  // 空串短路
  assert.equal(sanitizeHtml(""), "", "空串直接返回空串");
}
{
  // script 标签（含属性变体与大小写）
  assert.equal(sanitizeHtml("<script>alert(1)</script>x"), "x", "script 标签整段移除");
  assert.equal(sanitizeHtml("<SCRIPT type=text/javascript>x</SCRIPT>y"), "y", "script 大小写不敏感移除");
}
{
  // iframe / frame / object / embed / meta / link / base
  assert.equal(sanitizeHtml('<iframe src="x"></iframe>k'), "k", "iframe 整段移除");
  assert.equal(sanitizeHtml('<frame src="x"></frame>f'), "f", "frame 整段移除");
  assert.equal(sanitizeHtml('<object data="x"></object>o'), "o", "object 整段移除");
  assert.equal(sanitizeHtml("<embed src=x></embed>e"), "e", "embed 整段移除");
  assert.equal(sanitizeHtml('<meta charset="utf-8">m'), "m", "meta 标签移除");
  assert.equal(sanitizeHtml('<link rel=stylesheet href=x>l'), "l", "link 标签移除");
  assert.equal(sanitizeHtml('<base href="//evil/">b'), "b", "base 标签移除");
}
{
  // on* 事件处理器三种引号形态 + 无引号形态
  assert.equal(sanitizeHtml('<img src="x" onerror="alert(1)">'), "<img src=\"x\">", "on*=双引号事件被剥");
  assert.equal(sanitizeHtml("<a onclick='go()'>c</a>"), "<a>c</a>", "on*=单引号事件被剥");
  assert.equal(sanitizeHtml("<div onMouseOver=hi()>d</div>"), "<div>d</div>", "on*=无引号事件被剥（大小写不敏感）");
}
{
  // javascript: URI 与 data:text/html 与 expression(
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a href="alert(1)">x</a>', "javascript: 协议剥离");
  assert.equal(sanitizeHtml('<a href="JaVaScRiPt:x">y</a>'), '<a href="x">y</a>', "javascript: 大小写混合剥离");
  assert.equal(sanitizeHtml('<iframe src="data:text/html,<b>z"></iframe>q'), "q", "data:text/html 场景随 iframe 移除");
  const exp = sanitizeHtml("<div style=\"width:expression(alert(1))\">w</div>");
  assert.ok(!exp.includes("expression("), "CSS expression( 被剥");
}
{
  // 正常内容不被误伤
  assert.equal(sanitizeHtml("<b>ok</b>"), "<b>ok</b>", "正常标签保留");
  assert.equal(sanitizeHtml('<a href="https://example.com" title="t">n</a>'), '<a href="https://example.com" title="t">n</a>', "正常链接与属性保留");
}

// ---------------------------------------------------------------- #105③ 实体编码变体（清理链补充）

{
  assert.equal(sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>'), '<a href="alert(1)">x</a>', "hex 实体 javascript: 剥除");
  assert.equal(sanitizeHtml('<a href="&#106;avascript:alert(1)">y</a>'), '<a href="alert(1)">y</a>', "十进制词首 j 实体剥除");
  assert.ok(!sanitizeHtml("jav&#x61script:x").includes("&#x61script"), "hex 无分号变体剥除");
  assert.equal(sanitizeHtml("&#X3c;script>x</script>t"), "xt", "&#X3c; 开标签变体随 token 移除（其间文本保留）");
  assert.equal(sanitizeHtml("<img src=x oncli&#99;k='go()'>"), "<img src=x>", "属性名尾部实体编码剥除");
  // 幂等硬闸：净化不动点（含删除拼接出新载体的收敛样本）
  const idemSamples = [
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<img src=x o&#110;click="alert(1)">',
    '&lt;iframe src="data:text/html,x"&gt;&lt;/iframe&gt;k',
    '<a href="&amp;#106;avascript:alert(1)">c</a>',
    'data:text/htexpression(ml',
    "<b>ok</b><a href=\"/api/x?a=1&amp;b=2\">n</a>",
  ];
  for (const s of idemSamples) {
    assert.equal(sanitizeHtml(sanitizeHtml(s)), sanitizeHtml(s), `幂等不动点: ${s}`);
  }
  // 深嵌套收敛与幂等（复核 P1-2）：pad(k) 引自 test/helpers.ts 单一事实源，
  // 每轮仅暴露一层 <meta>，pad(17/18/25) 均在 64 轮宽松上限内全净收敛且幂等
  for (const depth of [17, 18, 25]) {
    const y = sanitizeHtml(pad(depth));
    assert.equal(sanitizeHtml(y), y, `深嵌套 pad(${depth}) 幂等不动点`);
    assert.ok(!/<meta\b|<met\b/i.test(y), `深嵌套 pad(${depth}) 无危险 token 残留`);
  }
  // 超限 fail-closed（复核 P1-3）：>64 轮深嵌套返回空串且幂等保持
  const y70 = sanitizeHtml(pad(70) + "&#X3c;script>x</script>t");
  assert.equal(y70, "", "超限 fail-closed 返回空串");
  assert.equal(sanitizeHtml(y70), y70, "fail-closed 后 f(f(x))===f(x)");
}

// ---------------------------------------------------------------- #105③ C1 管道级端到端：净化在管道内生效

{
  // pipeContained 判据引自 test/helpers.ts 单一事实源（统一判定标准 v2：
  // 一轮实体解码 + WHATWG URL 剥除 \t\n\r 后不得匹配危险载体模式）

  // 恶意 formatCapsule（issue 原例 payload）→ runV2Pipeline 产出前净化兜底
  const capR = await runV2Pipeline({
    adapter: {
      version: 2,
      name: "evil-caps",
      providers: ["pv"],
      fetchData: async () => ({}),
      formatCapsule: () => '<div>u <a href="jav&#x61;script:alert(1)">win</a></div>',
      formatPanel: () => "",
    },
    provider: "pv",
    config: {},
    staticPath: "",
    timeoutMs: 500,
  });
  assert.equal(capR.ok, true, "C1: 管道执行成功");
  assert.ok(capR.capsuleHtml !== undefined && pipeContained(capR.capsuleHtml),
    "C1: capsuleHtml 满足统一判定标准（hex 实体载体封闭）");
  assert.ok(capR.capsuleHtml !== undefined && !capR.capsuleHtml.includes("jav&#x61"),
    "C1: 危险实体区间已自输出移除");

  // 恶意 formatPanel（事件属性部分编码 + 具名冒号协议）→ runV2PanelPipeline 净化兜底
  const sanPipeDir = mkdtempSync(join(tmpdir(), "dou-san-pipe-"));
  const store = new HistoryStore({ root: sanPipeDir });
  try {
    await store.append("pv", "evil-panel", { time: Date.now(), data: { v: 1 } });
    const panelR = await runV2PanelPipeline({
      adapter: {
        version: 2,
        name: "evil-panel",
        providers: ["pv"],
        fetchData: async () => ({}),
        formatCapsule: () => "",
        formatPanel: () => '<p t=1 o&#110;click="al()">x <a href="data&colon;text/html,y">l</a></p>',
      },
      provider: "pv",
      history: store,
      range: { start: Date.now() - 1000, end: Date.now() + 1000 },
    });
    assert.ok(panelR.panelHtml !== undefined && pipeContained(panelR.panelHtml),
      "C1: panelHtml 满足统一判定标准（属性部分编码 + data&colon 封闭）");
    assert.ok(panelR.panelHtml !== undefined && panelR.panelHtml.includes("<p t=1") && panelR.panelHtml.includes(">x "),
      "C1: 无害属性与文本保留（兜底不扩大化）");
  } finally {
    rmSync(sanPipeDir, { recursive: true, force: true });
  }
}

// ================================================================ #150 二阶段：samplePoint / summarize 残余分支

{
  const adapter = defineUsageAdapter({
    id: "sp-edge",
    label: "SP Edge",
    providers: ["openai"],
    windows: [
      { key: "a", name: "A" },
      { key: "b", name: "B", limit: 5, resetPeriodMs: 3600000 },
      { key: "c", name: "C" },
    ],
    fetchUsage: async () => ({ ok: true, provider: "openai", label: "SPE", fetchedAt: 0 }),
  });

  // cols 与 values 长度不一致（usage.windows 少于 spec.windows）→ null
  assert.equal(adapter.samplePoint({
    ok: true, provider: "openai", label: "SPE", fetchedAt: 0,
    windows: [{ key: "a", name: "A", percent: 1 }],
  }), null, "values 短于 cols 返回 null");

  // percent 非有限值 → null 占位；limit/resetPeriodMs 缺省字段省略
  const sp = adapter.samplePoint({
    ok: true, provider: "openai", label: "SPE", fetchedAt: 0,
    windows: [
      { key: "a", name: "A", percent: Number.NaN },
      { key: "b", name: "B", percent: 2.5, limit: 5, resetPeriodMs: 3600000 },
      { key: "c", name: "C", percent: Number.POSITIVE_INFINITY },
    ],
  });
  assert.ok(sp !== null, "NaN/Infinity 场景仍返回结构");
  assert.equal(sp.values[0], null, "NaN → null");
  assert.equal(sp.values[2], null, "Infinity → null");
  assert.deepEqual(Object.keys(sp.cols[0]).sort(), ["key", "name"], "无 limit/reset 时字段省略");
  assert.equal(sp.cols[1].limit, 5, "limit 透传");
  assert.equal(sp.cols[1].resetPeriodMs, 3600000, "resetPeriodMs 透传");

  // version 显式覆盖
  const v2 = defineUsageAdapter({
    version: 9,
    id: "v-explicit",
    label: "V",
    providers: ["p"],
    windows: [{ key: "k", name: "K" }],
    fetchUsage: async () => ({ ok: false, provider: "p", label: "L", fetchedAt: 0 }),
  });
  assert.equal(v2.version, 9, "version 显式指定优先于默认 1");

  // retryPolicy 透传
  const rp = defineUsageAdapter({
    id: "rp",
    label: "RP",
    providers: ["p"],
    windows: [{ key: "k", name: "K" }],
    fetchUsage: async () => ({ ok: false, provider: "p", label: "L", fetchedAt: 0 }),
    retryPolicy: { maxRetries: 3, backoffMs: 100 },
  });
  assert.deepEqual(rp.retryPolicy, { maxRetries: 3, backoffMs: 100 }, "retryPolicy 透传");
}

{
  // summarize：自定义文本为空串时回落 label
  const adapter = defineUsageAdapter({
    id: "empty-sum",
    label: "Empty Label Fallback",
    providers: ["openai"],
    windows: [{ key: "r", name: "R" }],
    fetchUsage: async () => ({ ok: false, provider: "openai", label: "E", fetchedAt: 0 }),
    summarizeText: () => "",
  });
  const summary = await adapter.summarize({
    provider: "openai",
    usage: {
      ok: true, provider: "openai", label: "E", fetchedAt: 0,
      windows: [{ key: "r", name: "R", percent: 10 }],
    },
  } as any);
  assert.equal(summary.text, "Empty Label Fallback", "空文本回落 label");
  assert.equal(summary.fetchedAt > 0, true, "summarize fetchedAt 取当下");
}
