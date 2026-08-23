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