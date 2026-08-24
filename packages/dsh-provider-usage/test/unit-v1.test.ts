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
import { assert } from "./helpers.ts";
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
} from "../lib/index.js";

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
  // 观察超时定时器是否真的触发了 abort（不悬挂、无网络）
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      await new Promise((res) => setTimeout(res, opts.delayMs ?? 0));
      return { marker: "mock", aborted: opts.signal.aborted, url, headers: opts.headers };
    };

    // 快路径：远小于超时的延迟 -> 正常返回且 signal 未 abort
    const fast = await fetchWithTimeout("https://gw.test/x", 1000,
      { headers: { "x-k": "v" }, signal: "fake-signal", delayMs: 10 });
    assert.equal(fast.marker, "mock", "返回值来自注入的 fetch");
    assert.equal(fast.aborted, false, "未超时时 signal 未被 abort");
    assert.equal(fast.url, "https://gw.test/x", "url 原样透传");
    assert.deepEqual(fast.headers, { "x-k": "v" }, "init.headers 透传");
    const sigFast = calls[calls.length - 1].opts.signal;
    assert.ok(sigFast instanceof AbortSignal, "signal 覆盖为真 AbortSignal（展开序 {...init, signal}）");

    // 慢路径：超过 timeoutMs 的延迟 -> 返回时已观察到 abort
    const slow = await fetchWithTimeout("https://gw.test/y", 20, { delayMs: 80 });
    assert.equal(slow.aborted, true, "超过 timeoutMs 后 controller.abort 已触发");
    assert.equal(calls.length, 2, "两次调用均到达注入 fetch");

    // 默认参数形态：省略 timeoutMs 与 init 仍可完成快调用
    globalThis.fetch = async (url, opts) => ({ marker: "def", aborted: opts.signal.aborted });
    const def = await fetchWithTimeout("https://gw.test/z");
    assert.equal(def.marker, "def", "默认参数下仍走 fetch 并返回");
    assert.equal(def.aborted, false, "默认 10s 超时内完成不 abort");
  } finally {
    globalThis.fetch = realFetch;
  }
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
