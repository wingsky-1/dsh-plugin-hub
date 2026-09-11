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
 * formatPanel 三态与趋势分支）整体并入本文件——该文件此前未被 smoke.test.ts
 * 与 stryker testFiles 任一通道收录，属死文件；并入后图表纯函数群
 * （timeTickStep/timeTicks/trendOf/resetTicks/downsample/smoothPath 经
 * 导出接口行为级断言）方才进入变异计量范围。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { judgeContained as pipeContained, judgePad as pad, injectGlobalFetch } from "../../helpers.ts";
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
} from "../../../src/apply/index.ts";

// ---------------------------------------------------------------- isHostProviderAdapter

// 完整合法 v1 适配器
const V1_ADAPTER = {
  version: 1,
  id: "my-adapter",
  label: "My Adapter",
  providers: ["anthropic"],
  fetchUsage: async () => ({ ok: true, provider: "anthropic", label: "MA", fetchedAt: Date.now() }),
};

describe("isHostProviderAdapter", () => {
  it("null 返回 false", () => {
    expect(isHostProviderAdapter(null)).toBe(false);
  });

  it("非对象返回 false", () => {
    expect(isHostProviderAdapter("str")).toBe(false);
  });

  it("空对象返回 false", () => {
    expect(isHostProviderAdapter({})).toBe(false);
  });

  it("合法 v1 适配器返回 true", () => {
    expect(isHostProviderAdapter(V1_ADAPTER)).toBe(true);
  });

  // 版本号错误
  it("version 非 1 返回 false", () => {
    expect(isHostProviderAdapter({ ...V1_ADAPTER, version: 2 })).toBe(false);
  });

  // 缺字段
  it("id 空字符串返回 false", () => {
    expect(isHostProviderAdapter({ ...V1_ADAPTER, id: "" })).toBe(false);
  });

  it("label 空字符串返回 false", () => {
    expect(isHostProviderAdapter({ ...V1_ADAPTER, label: "" })).toBe(false);
  });

  it("providers 空数组返回 false", () => {
    expect(isHostProviderAdapter({ ...V1_ADAPTER, providers: [] })).toBe(false);
  });

  it("providers 含空字符串返回 false", () => {
    expect(isHostProviderAdapter({ ...V1_ADAPTER, providers: [""] })).toBe(false);
  });

  it("fetchUsage 非函数返回 false", () => {
    expect(isHostProviderAdapter({ ...V1_ADAPTER, fetchUsage: "not-fn" })).toBe(false);
  });
});

// #150 分片 2：伪装类型与元素级边界（变异驱动）
describe("isHostProviderAdapter #150 分片 2：伪装类型与元素级边界", () => {
  it("函数载体即使属性齐全也拒绝", () => {
    // 函数挂全套合法属性：typeof 守卫左子恒假变异下会被放行，
    // 契约必须以严格 typeof 拒绝非 object 载体
    const fake = () => {};
    Object.assign(fake, { version: 1, id: "x", label: "y", providers: ["p"], fetchUsage: () => {} });
    expect(isHostProviderAdapter(fake)).toBe(false);
  });

  it("id 为数组（length>0 非字符串）拒绝", () => {
    // id 为带 length 的非字符串：typeof id 恒真变异下会放行
    const a = { ...V1_ADAPTER, id: [1, 2, 3] };
    expect(isHostProviderAdapter(a)).toBe(false);
  });

  it("label 为数组（length>0 非字符串）拒绝", () => {
    const a = { ...V1_ADAPTER, label: [1] };
    expect(isHostProviderAdapter(a)).toBe(false);
  });

  it("providers 多元素含空串拒绝（全称量词）", () => {
    // 多元素含一个空串：every 换 some 变异下会放行
    const a = { ...V1_ADAPTER, providers: ["good", ""] };
    expect(isHostProviderAdapter(a)).toBe(false);
  });

  it("providers 元素为数组拒绝", () => {
    // 元素为 length>0 的非字符串：回调 typeof 恒真变异下会放行
    const a = { ...V1_ADAPTER, providers: [[1]] };
    expect(isHostProviderAdapter(a)).toBe(false);
  });
});

// ---------------------------------------------------------------- describeAdapterShape

describe("describeAdapterShape", () => {
  it("null 描述", () => {
    expect(describeAdapterShape(null)).toBe("导出不是对象（null）");
  });

  it("字符串描述", () => {
    expect(describeAdapterShape("str")).toBe("导出不是对象（string）");
  });

  it("空对象描述", () => {
    expect(describeAdapterShape({})).toBe("version 必须 === 1（实际 undefined）、id（非空字符串）、label（非空字符串）、providers（非空字符串数组）、fetchUsage（函数）");
  });

  it("合法适配器返回 null", () => {
    expect(describeAdapterShape({ version: 1, id: "a", label: "b", providers: ["p1"], fetchUsage: async () => {} })).toBe(null);
  });

  // 逐个缺字段
  it("缺 id 应报告", () => {
    const d = describeAdapterShape({ version: 1, label: "b", providers: ["p1"], fetchUsage: async () => {} });
    expect(d.includes("id")).toBeTruthy();
  });

  it("缺 label 应报告", () => {
    const d = describeAdapterShape({ version: 1, id: "a", providers: ["p1"], fetchUsage: async () => {} });
    expect(d.includes("label")).toBeTruthy();
  });

  it("缺 providers 应报告", () => {
    const d = describeAdapterShape({ version: 1, id: "a", label: "b", fetchUsage: async () => {} });
    expect(d.includes("providers")).toBeTruthy();
  });

  it("缺 fetchUsage 应报告", () => {
    const d = describeAdapterShape({ version: 1, id: "a", label: "b", providers: ["p1"] });
    expect(d.includes("fetchUsage")).toBeTruthy();
  });

  // #150 分片 2：逐字段文案的元素级边界
  it("id 非字符串（数组）应报告", () => {
    // id 为 length>0 的非字符串：typeof id 判定恒假变异下只剩 length 检查会漏报
    const d = describeAdapterShape({ version: 1, id: [1, 2], label: "b", providers: ["p1"], fetchUsage: async () => {} });
    expect(d !== null && d.includes("id（非空字符串）")).toBeTruthy();
  });

  it("label 非字符串（数组）应报告", () => {
    const d = describeAdapterShape({ version: 1, id: "a", label: [1], providers: ["p1"], fetchUsage: async () => {} });
    expect(d !== null && d.includes("label（非空字符串）")).toBeTruthy();
  });

  {
    const base = { version: 1, id: "a", label: "b", fetchUsage: async () => {} };
    for (const bad of [[""], [[]], "ab"] as unknown as string[]) {
      it(`providers 缺陷形态 ${JSON.stringify(bad)} 应报告`, () => {
        const d = describeAdapterShape({ ...base, providers: bad });
        expect(d !== null && d.includes("providers（非空字符串数组）")).toBeTruthy();
      });
    }
  }

  it("多元素含空串应报告（全称量词）", () => {
    const d = describeAdapterShape({ version: 1, id: "a", label: "b", providers: ["good", ""], fetchUsage: async () => {} });
    expect(d.includes("providers（非空字符串数组）")).toBeTruthy();
  });

  it("元素为数组应报告", () => {
    const d = describeAdapterShape({ version: 1, id: "a", label: "b", providers: [[1]], fetchUsage: async () => {} });
    expect(d.includes("providers（非空字符串数组）")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- isClientProviderRenderer

describe("isClientProviderRenderer", () => {
  it("null 返回 false", () => {
    expect(isClientProviderRenderer(null)).toBe(false);
  });

  it("空对象返回 false", () => {
    expect(isClientProviderRenderer({})).toBe(false);
  });

  it("合法 renderer 返回 true", () => {
    expect(isClientProviderRenderer({
      version: 1, providers: ["anthropic"],
      render: () => {},
    })).toBe(true);
  });

  it("providers 空数组返回 false", () => {
    expect(isClientProviderRenderer({
      version: 1, providers: [],
      render: () => {},
    })).toBe(false);
  });

  it("render 非函数返回 false", () => {
    expect(isClientProviderRenderer({
      version: 1, providers: ["anthropic"],
      render: "not-fn",
    })).toBe(false);
  });

  it("version 非 1 返回 false", () => {
    expect(isClientProviderRenderer({
      version: 2, providers: ["anthropic"],
      render: () => {},
    })).toBe(false);
  });

  // #150 分片 2：伪装类型与元素级边界（变异驱动）
  it("函数载体即使属性齐全也拒绝", () => {
    const fake = () => {};
    Object.assign(fake, { version: 1, providers: ["p"], render: () => {} });
    expect(isClientProviderRenderer(fake)).toBe(false);
  });

  it("providers 多元素含空串拒绝（全称量词）", () => {
    expect(isClientProviderRenderer({
      version: 1, providers: ["good", ""], render: () => {},
    })).toBe(false);
  });

  it("providers 元素为数组（length>0 非字符串）拒绝", () => {
    expect(isClientProviderRenderer({
      version: 1, providers: [[1]], render: () => {},
    })).toBe(false);
  });
});

// ---------------------------------------------------------------- usageError / usageOk

describe("usageError", () => {
  let err;

  beforeAll(() => {
    err = usageError("anthropic", "rate-limited");
  });

  it("usageError ok=false", () => {
    expect(err.ok).toBe(false);
  });

  it("usageError provider", () => {
    expect(err.provider).toBe("anthropic");
  });

  it("usageError error", () => {
    expect(err.error).toBe("rate-limited");
  });

  it("usageError 默认 label", () => {
    expect(err.label).toBe("未知提供商");
  });

  it("usageError fetchedAt 为数字", () => {
    expect(typeof err.fetchedAt === "number").toBeTruthy();
  });

  it("usageError 自定义 label", () => {
    const err2 = usageError("anthropic", null, "Anthropic", 1234567890);
    expect(err2.label).toBe("Anthropic");
  });

  it("usageError 自定义 fetchedAt", () => {
    const err2 = usageError("anthropic", null, "Anthropic", 1234567890);
    expect(err2.fetchedAt).toBe(1234567890);
  });
});

describe("usageOk", () => {
  let ok1;

  beforeAll(() => {
    ok1 = usageOk("anthropic", "Anthropic", 1234567890);
  });

  it("usageOk ok=true", () => {
    expect(ok1.ok).toBe(true);
  });

  it("usageOk provider", () => {
    expect(ok1.provider).toBe("anthropic");
  });

  it("usageOk label", () => {
    expect(ok1.label).toBe("Anthropic");
  });

  it("usageOk fetchedAt", () => {
    expect(ok1.fetchedAt).toBe(1234567890);
  });

  it("usageOk extra 透传", () => {
    const ok2 = usageOk("anthropic", "Anthropic", 1234567890, { data: { visits: 5 } });
    expect(ok2.data?.visits).toBe(5);
  });
});

// ---------------------------------------------------------------- defineUsageAdapter

describe("defineUsageAdapter", () => {
  let adapter, sp;

  beforeAll(() => {
    adapter = defineUsageAdapter({
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

    // samplePoint：有 windows → 返回 {cols, values}
    sp = adapter.samplePoint({
      ok: true, provider: "openai", label: "MT", fetchedAt: 1234567890,
      windows: [
        { key: "rolling", name: "5h 滚动", percent: 5, limit: 12 },
        { key: "weekly", name: "每周", percent: 80, limit: 30 },
      ],
    });
  });

  it("defineUsageAdapter 默认 version=1", () => {
    expect(adapter.version).toBe(1);
  });

  it("defineUsageAdapter id", () => {
    expect(adapter.id).toBe("my-test");
  });

  it("defineUsageAdapter label", () => {
    expect(adapter.label).toBe("My Test");
  });

  it("defineUsageAdapter providers", () => {
    expect(adapter.providers).toEqual(["openai"]);
  });

  it("defineUsageAdapter fetchUsage", () => {
    expect(typeof adapter.fetchUsage).toBe("function");
  });

  it("defineUsageAdapter samplePoint", () => {
    expect(typeof adapter.samplePoint).toBe("function");
  });

  it("defineUsageAdapter summarize", () => {
    expect(typeof adapter.summarize).toBe("function");
  });

  it("samplePoint 有 windows 返回非 null", () => {
    expect(sp !== null).toBeTruthy();
  });

  it("samplePoint cols 数", () => {
    expect(sp.cols.length).toBe(2);
  });

  it("samplePoint col key", () => {
    expect(sp.cols[0].key).toBe("rolling");
  });

  it("samplePoint col limit 透传", () => {
    expect(sp.cols[0].limit).toBe(12);
  });

  it("samplePoint values[0]", () => {
    expect(sp.values[0]).toBe(5);
  });

  // samplePoint：windows 为空数组 → null
  it("samplePoint 空 windows 返回 null", () => {
    expect(adapter.samplePoint({
      ok: true, provider: "openai", label: "MT", fetchedAt: 1234567890,
      windows: [],
    })).toBe(null);
  });

  // samplePoint：无 windows 字段 → null
  it("samplePoint 无 windows 返回 null", () => {
    expect(adapter.samplePoint({
      ok: true, provider: "openai", label: "MT", fetchedAt: 1234567890,
    })).toBe(null);
  });
});

// ---------------------------------------------------------------- defineUsageAdapter 的 summarize

describe("defineUsageAdapter 的 summarize（默认 summarizeText）", () => {
  let summary;

  beforeAll(async () => {
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
    summary = await adapter.summarize({
      provider: "openai",
      usage: {
        ok: true, provider: "openai", label: "ST", fetchedAt: 1234567890,
        windows: [{ key: "rolling", name: "5h 滚动", percent: 5 }],
      },
    } as any);
  });

  it("summarize ok", () => {
    expect(summary.ok).toBe(true);
  });

  it("summarize 默认文本", () => {
    expect(summary.text).toBe("5h 滚动 5%");
  });

  it("summarize level ok", () => {
    expect(summary.level).toBe("ok");
  });

  it("summarize hasAdapter", () => {
    expect(summary.hasAdapter).toBe(true);
  });
});

describe("defineUsageAdapter 的 summarize（自定义 summarizeText）", () => {
  let summary;

  beforeAll(async () => {
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

    summary = await adapter.summarize({
      provider: "openai",
      usage: {
        ok: true, provider: "openai", label: "CS", fetchedAt: 1234567890,
        windows: [{ key: "rolling", name: "5h 滚动", percent: 5 }],
      },
    } as any);
  });

  it("summarize 自定义 summarizeText 生效", () => {
    expect(summary.text).toBe("rolling=5");
  });
});

describe("defineUsageAdapter 的 summarize（无 usage）", () => {
  let summary;

  beforeAll(async () => {
    const adapter = defineUsageAdapter({
      id: "no-usage",
      label: "No Usage",
      providers: ["openai"],
      windows: [{ key: "r", name: "R", limit: 12 }],
      fetchUsage: async () => ({ ok: false, provider: "openai", label: "NU", fetchedAt: Date.now() }),
    });

    summary = await adapter.summarize({
      provider: "openai",
      usage: null,
    } as any);
  });

  it("无 usage 回落 adapter.label", () => {
    expect(summary.text).toBe("No Usage");
  });
});

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule

describe("openCodeGoAdapter.formatCapsule", () => {
  let html1;

  beforeAll(() => {
    const e = esc;
    // 有数据
    html1 = openCodeGoAdapter.formatCapsule({
      time: 1000, data: { rolling: { percent: 5 }, weekly: { percent: 10 }, monthly: { percent: 0 } },
      status: "fresh", esc: e,
    });
  });

  it("formatCapsule 含 rolling 5%", () => {
    expect(html1.includes("5h 5%")).toBeTruthy();
  });

  it("formatCapsule 多窗口分隔符", () => {
    expect(html1.includes("·")).toBeTruthy();
  });

  it("formatCapsule 无数据回落", () => {
    // 无数据（所有 percent 均为 null）
    const html2 = openCodeGoAdapter.formatCapsule({
      time: 1000, data: { rolling: { percent: null }, weekly: {}, monthly: {} },
      status: "fresh", esc: (s) => String(s),
    });
    expect(html2.includes("无数据")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- openCodeGoAdapter.formatPanel（覆盖 fmtReset 分支）

describe("openCodeGoAdapter.formatPanel（覆盖 fmtReset 分支）", () => {
  let empty, withData, badDate;

  beforeAll(() => {
    const e = esc;
    // 空 entries → 暂无历史数据
    empty = openCodeGoAdapter.formatPanel({ entries: [], range: { start: 0, end: 1000 }, truncated: false, esc: e });

    // 含 resetsAt 的条目 → fmtReset 被调用
    withData = openCodeGoAdapter.formatPanel({
      entries: [
        { time: 1000, data: { rolling: { percent: 5 }, weekly: { percent: 3 }, monthly: { percent: 1 } } },
        { time: 2000, data: { rolling: { percent: 8, resetsAt: "2026-08-01T00:00:00Z", raw: "8000", limit: 12 }, weekly: { percent: 4 }, monthly: { percent: 2 } } },
      ],
      range: { start: 0, end: 3000 },
      truncated: false,
      esc: e,
    });

    // 非法日期的 resetsAt → fmtReset 返回原字符串；同时覆盖 data[key] 缺失的
    // `?? { percent: null }` 兜底分支
    badDate = openCodeGoAdapter.formatPanel({
      entries: [
        { time: 1000, data: { rolling: { percent: 5 }, weekly: {}, monthly: {} } },
        { time: 2000, data: { monthly: { percent: 1 } } },
        { time: 3000, data: { rolling: { percent: 10, resetsAt: "not-a-date" }, weekly: {}, monthly: { percent: 2 } } },
      ],
      range: { start: 0, end: 4000 },
      truncated: false,
      esc: e,
    });
  });

  it("空 entries 显示暂无历史数据", () => {
    expect(empty).toBe("<p>暂无历史数据</p>");
  });

  // fmtReset 将 ISO 日期转为本地时间格式
  it("formatPanel 含重置时间文本", () => {
    expect(withData.includes("重置")).toBeTruthy();
  });

  it("formatPanel 有卡片结构", () => {
    expect(withData.includes("dou-card")).toBeTruthy();
  });

  it("非法日期 resetsAt 原样返回", () => {
    expect(badDate.includes("not-a-date")).toBeTruthy();
  });

  it("latest 窗口数据缺失时回落 null 兜底仍渲染", () => {
    expect(badDate.includes("每月") && badDate.includes(">2%<")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule 无数据窗口（仅月份有值）

describe("openCodeGoAdapter.formatCapsule 无数据窗口（仅月份有值）", () => {
  let html;

  beforeAll(() => {
    const e = esc;
    html = openCodeGoAdapter.formatCapsule({
      time: 1000, data: { rolling: { percent: null }, weekly: { percent: null }, monthly: { percent: 2 } },
      status: "fresh", esc: e,
    });
  });

  // filter 过滤掉 null percent 后只剩 monthly
  it("formatCapsule 过滤 null 窗口", () => {
    expect(html.includes("月 2%")).toBeTruthy();
  });

  it("formatCapsule null percent 窗口不展示", () => {
    expect(!html.includes("5h")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- pickWindow 类型防御补充（#150）

describe("pickWindow 类型防御补充（#150）", () => {
  it("字符串输入拒绝", () => {
    expect(pickWindow("str", "k", "n", 5)).toBe(null);
  });

  it("数字输入拒绝", () => {
    expect(pickWindow(123, "k", "n", 5)).toBe(null);
  });

  it("百分比字符串转数字", () => {
    const w = pickWindow({ percent: "42" }, "k", "名", 5);
    expect(w !== null && w.percent === 42).toBeTruthy();
  });

  it("非数字百分比归 null", () => {
    const w = pickWindow({ percent: "abc" }, "k", "名", 5);
    expect(w !== null && w.percent === null).toBeTruthy();
  });

  it("raw/resetsAt 非字符串丢弃", () => {
    const w = pickWindow({ raw: 123, resetsAt: 456 }, "k", "名", 5);
    expect(w !== null && w.raw === undefined && w.resetsAt === undefined).toBeTruthy();
  });
});

// ---------------------------------------------------------------- parseUsageResponse 双形状（#150）

describe("parseUsageResponse 双形状（#150）", () => {
  it("null 输入", () => {
    expect(parseUsageResponse(null)).toBe(null);
  });

  it("字符串输入", () => {
    expect(parseUsageResponse("body")).toBe(null);
  });

  it("空对象无有效窗口", () => {
    expect(parseUsageResponse({})).toBe(null);
  });

  it("直接三键形状解析", () => {
    const direct = parseUsageResponse({
      rolling: { percent: 1 },
      weekly: { percent: 2 },
      monthly: { percent: 3 },
    });
    expect(direct !== null && direct.rolling.percent === 1 && direct.weekly.percent === 2
      && direct.monthly.percent === 3).toBeTruthy();
  });

  it("{usage:{}} 包裹形状解析", () => {
    const wrapped = parseUsageResponse({ usage: { rolling: { percent: 7 } } });
    expect(wrapped !== null && wrapped.rolling.percent === 7).toBeTruthy();
  });

  it("包裹形状下缺失窗口不产出键", () => {
    const wrapped = parseUsageResponse({ usage: { rolling: { percent: 7 } } });
    expect(wrapped !== null && wrapped.weekly === undefined).toBeTruthy();
  });
});

// ---------------------------------------------------------------- fetchOpenCodeGoV2 错误链（#150）

const baseCtx = (overrides = {}) => ({
  apiEndpoint: "https://api.test/zen",
  staticPath: "/usage",
  apiKey: "sk-test",
  provider: "opencode-go",
  timeoutMs: 500,
  ...overrides,
});

/** 断言 promise 以指定错误文案 reject（错误链判定，原文件同款语义）。 */
async function expectRejects(promise, message) {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught !== null && String(caught.message) === message, `错误链：${message}`).toBeTruthy();
}

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

describe("fetchOpenCodeGoV2 错误链（#150）", () => {
  it("错误链：no-api-key（缺 apiKey）", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx({ apiKey: undefined })), "no-api-key");
  });

  it("错误链：no-api-key（空 apiKey）", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx({ apiKey: "" })), "no-api-key");
  });

  it("错误链：network（fetch 实现抛错）", async () => {
    await expectRejects(
      fetchOpenCodeGoV2(baseCtx(), async () => { throw new Error("boom"); }),
      "network",
    );
  });

  it("错误链：unauthorized（401）", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(401, {})), "unauthorized");
  });

  it("错误链：unauthorized（403）", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(403, {})), "unauthorized");
  });

  it("错误链：http-500", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(500, {})), "http-500");
  });

  it("错误链：bad-json", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(200, {}, true)), "bad-json");
  });

  it("错误链：bad-data", async () => {
    await expectRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(200, { foo: 1 })), "bad-data");
  });
});

describe("fetchOpenCodeGoV2 成功路径（#150）", () => {
  let data, captured;

  beforeAll(async () => {
    captured = [];
    data = await fetchOpenCodeGoV2(baseCtx(), makeFetch(200, okBody, false, captured));
  });

  it("成功路径 rolling 百分比", () => {
    expect(data.rolling.percent).toBe(11);
  });

  it("成功路径 weekly 百分比", () => {
    expect(data.weekly.percent).toBe(22);
  });

  it("成功路径 monthly 百分比", () => {
    expect(data.monthly.percent).toBe(33);
  });

  it("apiEndpoint + staticPath 拼接", () => {
    expect(captured[0].url).toBe("https://api.test/zen/usage");
  });

  it("Bearer 鉴权头注入", () => {
    expect(captured[0].auth).toBe("Bearer sk-test");
  });
});

describe("fetchOpenCodeGoV2 缺失窗口补默认占位（#150）", () => {
  let data;

  beforeAll(async () => {
    data = await fetchOpenCodeGoV2(baseCtx(), makeFetch(200, { rolling: { percent: 5 } }));
  });

  it("缺失窗口补 percent null", () => {
    expect(data.weekly.percent).toBe(null);
  });

  it("缺失窗口补默认限额", () => {
    expect(data.monthly.limit).toBe(60);
  });
});

describe("fetchOpenCodeGoV2 空 apiEndpoint 回落默认地址（#150）", () => {
  let data;

  beforeAll(async () => {
    data = await fetchOpenCodeGoV2(
      baseCtx({ apiEndpoint: "" }),
      makeFetch(200, okBody),
    );
  });

  it("空 apiEndpoint 回落默认地址仍成功", () => {
    expect(data.rolling.percent).toBe(11);
  });
});

// ---------------------------------------------------------------- miniChartSvgMarkup 结构断言（#150）

const T0 = new Date(2026, 5, 15, 10, 0, 0).getTime();
const MIN = 60000;

describe("miniChartSvgMarkup 结构断言（#150）", () => {
  it("少于 2 个采样点返回空串", () => {
    expect(miniChartSvgMarkup({
      samples: [{ x: T0, y: 10 }], color: "#000", lo: 0, hi: 100,
      resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
    })).toBe("");
  });

  describe("两点基础结构（含 100% 参考线）", () => {
    let svg;

    beforeAll(() => {
      svg = miniChartSvgMarkup({
        samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
        color: "#abc", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      });
    });

    it("SVG 头与固定视口尺寸", () => {
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100">')).toBeTruthy();
    });

    it("SVG 闭合标签", () => {
      expect(svg.endsWith("</svg>")).toBeTruthy();
    });

    it("面积填充使用传入色与固定透明度", () => {
      expect(svg.includes('fill:#abc;fill-opacity:.13')).toBeTruthy();
    });

    it("折线描边样式", () => {
      expect(svg.includes('stroke:#abc;stroke-width:1.6')).toBeTruthy();
    });

    it("末点圆标记存在", () => {
      expect(svg.includes("<circle")).toBeTruthy();
    });

    it("y 轴刻度含整数百分比文案", () => {
      expect(svg.includes(">10%</text>") || svg.includes(">0%</text>")).toBeTruthy();
    });

    it("100% 参考线虚线样式", () => {
      expect(svg.includes('stroke-dasharray:4 3;stroke-opacity:.65')).toBeTruthy();
    });

    it("lo<=100<=hi 时绘制 100% 配额参考线（与 y 轴 9.5px 刻度字号区分）", () => {
      expect(svg.includes('font-size:9px">100%</text>')).toBeTruthy();
    });
  });

  describe("hi < 100：无参考线；刻度出现小数格式", () => {
    let svg;

    beforeAll(() => {
      svg = miniChartSvgMarkup({
        samples: [{ x: T0, y: 1 }, { x: T0 + 30 * MIN, y: 2 }],
        color: "#abc", lo: 0.5, hi: 99, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      });
    });

    it("hi<100 无 100% 参考线", () => {
      expect(!svg.includes(">100%</text>")).toBeTruthy();
    });

    it("非整数刻度保留一位小数", () => {
      expect(svg.includes(">0.5%</text>")).toBeTruthy();
    });
  });

  describe("重置线：resetsAt 落在采样区间内", () => {
    let svg;

    beforeAll(() => {
      const resetsAt = new Date(T0 + 10 * MIN).toISOString();
      svg = miniChartSvgMarkup({
        samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
        color: "#abc", lo: 0, hi: 100, resetsAt, resetPeriodMs: 5 * 3600000,
        dateOnly: false,
      });
    });

    it("区间内重置点画虚线并带标题", () => {
      expect(svg.includes("<title>窗口重置点</title>")).toBeTruthy();
    });

    it("重置线短虚线样式", () => {
      expect(svg.includes('stroke-dasharray:2 3')).toBeTruthy();
    });

    it("重置点三角标记", () => {
      expect(svg.includes('l 3.5 3.5 l -7 0 z')).toBeTruthy();
    });
  });

  describe("resetsAt 在区间外（早于 t0 一个周期以上）：无重置线", () => {
    let svg;

    beforeAll(() => {
      const resetsAt = new Date(T0 - 48 * 3600000).toISOString();
      svg = miniChartSvgMarkup({
        samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
        color: "#abc", lo: 0, hi: 100, resetsAt, resetPeriodMs: 3600000, dateOnly: false,
      });
    });

    it("历史周期点全部落在区间外时不画重置线", () => {
      expect(!svg.includes("<title>窗口重置点</title>")).toBeTruthy();
    });
  });

  describe("x 轴刻度格式分档", () => {
    let short, dateOnlySvg;

    beforeAll(() => {
      // span<1 天 → HH:mm；dateOnly → M-D
      short = miniChartSvgMarkup({
        samples: [{ x: T0, y: 0 }, { x: T0 + 30 * MIN, y: 5 }],
        color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      });
      dateOnlySvg = miniChartSvgMarkup({
        samples: [{ x: T0, y: 0 }, { x: T0 + 26 * 3600000, y: 5 }],
        color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
      });
    });

    it("短跨度刻度为 HH:mm", () => {
      expect(/>\d{2}:\d{2}<\/text>/.test(short)).toBeTruthy();
    });

    it("dateOnly 刻度为 M-DD（月不补零日补零）", () => {
      expect(/>\d+-\d\d<\/text>/.test(dateOnlySvg)).toBeTruthy();
    });
  });

  describe("降采样：超过 300 点仍产出合法 SVG 并保留最后一点", () => {
    let svg;

    beforeAll(() => {
      const many = [];
      for (let i = 0; i < 320; i += 1) {
        many.push({ x: T0 + i * MIN, y: i % 50 });
      }
      svg = miniChartSvgMarkup({
        samples: many, color: "#c", lo: 0, hi: 100,
        resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      });
    });

    it("超量采样降采样后仍有折线与末点", () => {
      expect(svg.startsWith("<svg") && svg.includes("<circle")).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule（#150）

const capsBase = { time: T0, status: "fresh", esc: (s) => String(s) };

describe("openCodeGoAdapter.formatCapsule（#150）", () => {
  it("三窗口短名按序拼接", () => {
    const html = openCodeGoAdapter.formatCapsule({
      ...capsBase,
      data: {
        rolling: { percent: 3 },
        weekly: { percent: 1 },
        monthly: { percent: 0 },
      },
    });
    expect(html).toBe("<span>5h 3% · 周 1% · 月 0%</span>");
  });

  it("仅单一窗口有值", () => {
    const html = openCodeGoAdapter.formatCapsule({
      ...capsBase,
      data: { monthly: { percent: 4 } },
    });
    expect(html).toBe("<span>月 4%</span>");
  });

  it("全窗口缺失回退无数据文案", () => {
    const html = openCodeGoAdapter.formatCapsule({ ...capsBase, data: {} });
    expect(html).toBe("<span>无数据</span>");
  });

  it("percent null 不计入展示", () => {
    const html = openCodeGoAdapter.formatCapsule({
      ...capsBase,
      data: { rolling: { percent: null } },
    });
    expect(html).toBe("<span>无数据</span>");
  });
});

// ---------------------------------------------------------------- openCodeGoAdapter.formatPanel（#150）

const H5 = 3600000;
const mkEntry = (offsetMs, windows) => ({ time: T0 + offsetMs, data: windows });

describe("openCodeGoAdapter.formatPanel（#150）", () => {
  let emptyHtml, singleHtml, insufficientHtml, down, flat, resetHtml, windowedHtml;

  beforeAll(() => {
    const e = (s) => String(s);

    emptyHtml = openCodeGoAdapter.formatPanel({
      entries: [], range: { start: T0, end: T0 }, truncated: false, esc: e,
    });

    // 单条 entry：三点分支之「数据采集中」
    singleHtml = openCodeGoAdapter.formatPanel({
      entries: [mkEntry(0, { rolling: { percent: 10 } })],
      range: { start: T0, end: T0 }, truncated: false, esc: e,
    });

    // 两条 entry、第二窗口全 null：区分「采样不足」分支
    insufficientHtml = openCodeGoAdapter.formatPanel({
      entries: [
        mkEntry(0, { rolling: { percent: 10 }, weekly: { percent: null } }),
        mkEntry(H5, { rolling: { percent: 20 }, weekly: { percent: null } }),
      ],
      range: { start: T0, end: T0 + H5 }, truncated: false, esc: e,
    });

    // 下降趋势与平坦趋势
    down = openCodeGoAdapter.formatPanel({
      entries: [
        mkEntry(0, { rolling: { percent: 20 } }),
        mkEntry(H5, { rolling: { percent: 10 } }),
      ],
      range: { start: T0, end: T0 + H5 }, truncated: false, esc: e,
    });
    flat = openCodeGoAdapter.formatPanel({
      entries: [
        mkEntry(0, { rolling: { percent: 10 } }),
        mkEntry(H5, { rolling: { percent: 10 } }),
      ],
      range: { start: T0, end: T0 + H5 }, truncated: false, esc: e,
    });

    // resetsAt 展示在卡片限额行；最新窗口 pct null 显示 --
    const resetsAtIso = new Date(T0 + H5).toISOString();
    resetHtml = openCodeGoAdapter.formatPanel({
      entries: [
        mkEntry(0, { rolling: { percent: 10, resetsAt: resetsAtIso } }),
        mkEntry(H5, { rolling: { percent: 11, resetsAt: resetsAtIso }, monthly: { percent: null } }),
      ],
      range: { start: T0, end: T0 + H5 }, truncated: false, esc: e,
    });

    // 观察窗过滤：rolling 只看最近 12h，窗外采样不进趋势
    const old = mkEntry(-13 * H5, { rolling: { percent: 90 } });
    const recent1 = mkEntry(-H5, { rolling: { percent: 10 } });
    const recent2 = mkEntry(0, { rolling: { percent: 12 } });
    windowedHtml = openCodeGoAdapter.formatPanel({
      entries: [old, recent1, recent2],
      range: { start: T0 - 13 * H5, end: T0 }, truncated: false, esc: e,
    });
  });

  it("空历史返回占位段落", () => {
    expect(emptyHtml).toBe("<p>暂无历史数据</p>");
  });

  it("单采样点提示积累文案", () => {
    expect(singleHtml.includes("数据采集中：每次刷新记录一个采样点")).toBeTruthy();
  });

  it("三窗口各一张卡片", () => {
    expect((singleHtml.match(/dou-card/g) || []).length >= 3).toBeTruthy();
  });

  it("卡片头当前百分比直出", () => {
    expect(singleHtml.includes(">10%</span>")).toBeTruthy();
  });

  it("无有效点窗口提示采样不足", () => {
    expect(insufficientHtml.includes("该时间范围内采样不足")).toBeTruthy();
  });

  it("有效点窗口渲染迷你图", () => {
    expect(insufficientHtml.includes("dou-miniChart")).toBeTruthy();
  });

  it("上升趋势三角与增量", () => {
    expect(insufficientHtml.includes("dou-trend-up") && insufficientHtml.includes("▲ +10%")).toBeTruthy();
  });

  it("下降趋势负增量", () => {
    expect(down.includes("dou-trend-down") && down.includes("▼ -10%")).toBeTruthy();
  });

  it("持平趋势零增量", () => {
    expect(flat.includes("dou-trend-flat") && flat.includes("— 0%")).toBeTruthy();
  });

  it("resetsAt 渲染重置文案", () => {
    expect(resetHtml.includes("重置 ")).toBeTruthy();
  });

  it("rolling 默认限额 12 出现在卡片头", () => {
    expect(resetHtml.includes("限额 12")).toBeTruthy();
  });

  it("最新窗口无百分比显示 -- 占位", () => {
    expect(resetHtml.includes(">--</span>")).toBeTruthy();
  });

  it("窗外高百分比不参与趋势计算", () => {
    expect(windowedHtml.includes("▲ +2%")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- safeFetchData 边界（#150 变异加固）

describe("safeFetchData 边界（#150 变异加固）", () => {
  let success, arrayRes, nullRes, primitiveRes, undefinedRes, syncBoom, asyncBoom, plainThrow, timeoutRes, timeoutElapsed;

  beforeAll(async () => {
    // 成功路径：JSON 序列化管道保真——Date 经 stringify/parse 变 ISO 字符串，
    // 若删去 round-trip（直接回传 raw）则保持 Date 对象，此断言即杀该变异
    success = await safeFetchData(async () => ({ n: 3, d: new Date(0), nest: { ok: true } }));

    // 数组拒绝：typeof === "object" 但 Array.isArray 拦截
    arrayRes = await safeFetchData(async () => [1, 2]);

    // null 拒绝：typeof null === "object" 但 null 拦截
    nullRes = await safeFetchData(async () => null);

    // 原始值拒绝：stringify/parse 后仍非 object
    primitiveRes = [];
    for (const raw of ["str", 42, true]) {
      primitiveRes.push(await safeFetchData(async () => raw));
    }

    // fn 返回 undefined：JSON.parse(undefined) 抛 SyntaxError 进 catch
    undefinedRes = await safeFetchData(async () => undefined);

    // fn 同步抛 Error：message 原样入 error
    syncBoom = await safeFetchData(() => { throw new Error("sync-boom"); });

    // fn 返回 rejected promise：同样进 catch
    asyncBoom = await safeFetchData(async () => { throw new Error("async-boom"); });

    // 非 Error 抛出值：String(e) 兜底
    plainThrow = await safeFetchData(async () => { throw "plain"; });

    // 超时分支：fn 永挂 + 极小 timeoutMs -> abort 监听 reject 固定文案；
    // finally clearTimeout 保证进程不悬挂
    const t0 = Date.now();
    timeoutRes = await safeFetchData(() => new Promise(() => {}), 25);
    timeoutElapsed = Date.now() - t0;
  });

  it("对象输入走 data 通道", () => {
    expect(success.data !== undefined && success.error === undefined).toBeTruthy();
  });

  it("标量字段保真", () => {
    expect(success.data?.n).toBe(3);
  });

  it("Date 字段经序列化变 ISO 字符串", () => {
    expect(success.data?.d).toBe("1970-01-01T00:00:00.000Z");
  });

  it("嵌套对象保真", () => {
    expect(success.data?.nest).toEqual({ ok: true });
  });

  it("数组返回被拒绝并给出固定文案", () => {
    expect(arrayRes.error).toBe("fetchData 必须返回对象");
  });

  it("拒绝时无 data 字段", () => {
    expect(arrayRes.data).toBe(undefined);
  });

  it("null 返回被拒绝", () => {
    expect(nullRes.error).toBe("fetchData 必须返回对象");
  });

  for (const [index, raw] of ["str", 42, true].entries()) {
    it(`原始值 ${JSON.stringify(raw)} 被拒绝`, () => {
      expect(primitiveRes[index].error).toBe("fetchData 必须返回对象");
    });
  }

  it("undefined 返回进错误通道", () => {
    expect(typeof undefinedRes.error === "string" && undefinedRes.error.length > 0).toBeTruthy();
  });

  it("错误消息携带 undefined 线索", () => {
    expect(undefinedRes.error ?? "").toMatch(/undefined/);
  });

  it("同步抛错提取 message", () => {
    expect(syncBoom.error).toBe("sync-boom");
  });

  it("异步拒绝提取 message", () => {
    expect(asyncBoom.error).toBe("async-boom");
  });

  it("非 Error 抛出值经 String 提取", () => {
    expect(plainThrow.error).toBe("plain");
  });

  it("超时返回固定文案", () => {
    expect(timeoutRes.error).toBe("fetchData 超时");
  });

  it("超时无 data", () => {
    expect(timeoutRes.data).toBe(undefined);
  });

  it("超时在 timeoutMs 量级触发而非默认 2s", () => {
    expect(timeoutElapsed < 2000).toBeTruthy();
  });
});

// ---------------------------------------------------------------- safeFormat 边界（#150 变异加固）

describe("safeFormat 边界（#150 变异加固）", () => {
  let success, badTypeRes, syncBoom, asyncBoom, plainThrow, timeoutRes;

  beforeAll(async () => {
    // 成功路径：字符串原样透传
    success = await safeFormat(() => "<b>ok</b>", "FmtA");

    // 非字符串拒绝：name 嵌入固定文案
    badTypeRes = [];
    for (const bad of [42, null, undefined, { obj: true }]) {
      badTypeRes.push(await safeFormat(() => bad, "FmtB"));
    }

    // fn 同步抛 Error：Promise.resolve().then(fn) 转 rejection 后 message 入 error
    syncBoom = await safeFormat(() => { throw new Error("fmt-sync-boom"); }, "FmtC");

    // fn 返回 rejected promise
    asyncBoom = await safeFormat(async () => { throw new Error("fmt-async-boom"); }, "FmtD");

    // 非 Error 抛出值：String(e) 兜底
    plainThrow = await safeFormat(async () => { throw 7; }, "FmtE");

    // 超时分支：fn 永挂 + 极小 timeoutMs -> 文案含适配器名
    timeoutRes = await safeFormat(() => new Promise(() => {}), "FmtSlow", 25);
  });

  it("字符串返回走 html 通道", () => {
    expect(success.html).toBe("<b>ok</b>");
  });

  it("成功无 error 字段", () => {
    expect(success.error).toBe(undefined);
  });

  for (const [index, bad] of [42, null, undefined, { obj: true }].entries()) {
    it(`非字符串 ${String(bad)} 被拒绝且文案含适配器名`, () => {
      expect(badTypeRes[index].error).toBe("FmtB 必须返回字符串");
    });

    it(`非字符串 ${String(bad)} 拒绝时无 html 字段`, () => {
      expect(badTypeRes[index].html).toBe(undefined);
    });
  }

  it("同步抛错提取 message", () => {
    expect(syncBoom.error).toBe("fmt-sync-boom");
  });

  it("异步拒绝提取 message", () => {
    expect(asyncBoom.error).toBe("fmt-async-boom");
  });

  it("非 Error 抛出值经 String 提取", () => {
    expect(plainThrow.error).toBe("7");
  });

  it("超时返回含名字的固定文案", () => {
    expect(timeoutRes.error).toBe("FmtSlow 超时");
  });
});

// ---------------------------------------------------------------- fetchWithTimeout 边界（#150 变异加固）

describe("fetchWithTimeout 边界（#150 变异加固）", () => {
  let fast, fastSigIsAbortSignal, slow, def;

  beforeAll(async () => {
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
      fast = await fetchWithTimeout("https://gw.test/x", 1000,
        { headers: { "x-k": "v" }, signal: "fake-signal", delayMs: 10 });
      // 同理按 url 过滤取 fast 的调用记录：calls 尾部在负载下可能被外部污染
      const sigFast = calls.find((c) => c.url === "https://gw.test/x")?.opts.signal;
      fastSigIsAbortSignal = sigFast instanceof AbortSignal;

      // 慢路径：超过 timeoutMs 的延迟 -> 返回时已观察到 abort
      // （按 url 过滤计数：await 窗口内前置测试遗留异步操作可能触发本 mock fetch，
      //   绝对计数与差值计数均会时序 flake——CI 两次实证；只有按调用特征过滤
      //   才能彻底与外部污染解耦）
      // delayMs 取 500（>> timeoutMs=20）：含 TLA 的前置模块恢复执行时会形成
      // 微任务风暴推迟宏任务定时器，小余量下 abort 可能晚于 mock 返回（实证 flake）
      slow = await fetchWithTimeout("https://gw.test/y", 20, { delayMs: 500 });

      // 默认参数形态：省略 timeoutMs 与 init 仍可完成快调用
      set(async (url, opts) => ({ marker: "def", aborted: opts.signal.aborted }));
      def = await fetchWithTimeout("https://gw.test/z");
    });
  });

  it("返回值来自注入的 fetch", () => {
    expect(fast.marker).toBe("mock");
  });

  it("未超时时 signal 未被 abort", () => {
    expect(fast.aborted).toBe(false);
  });

  it("url 原样透传", () => {
    expect(fast.url).toBe("https://gw.test/x");
  });

  it("init.headers 透传", () => {
    expect(fast.headers).toEqual({ "x-k": "v" });
  });

  it("signal 覆盖为真 AbortSignal（展开序 {...init, signal}）", () => {
    expect(fastSigIsAbortSignal).toBeTruthy();
  });

  it("超过 timeoutMs 后 controller.abort 已触发", () => {
    expect(slow.aborted).toBe(true);
  });

  it("默认参数下仍走 fetch 并返回", () => {
    expect(def.marker).toBe("def");
  });

  it("默认 10s 超时内完成不 abort", () => {
    expect(def.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------- trendOf 阈值与取整边界（#150 变异加固，经 formatPanel 观测）

describe("trendOf 阈值与取整边界（#150 变异加固）", () => {
  let rounded, atUp, atDown, inner, outer, only;

  beforeAll(() => {
    const e = (s) => String(s);
    const panelOf = (from, to) => openCodeGoAdapter.formatPanel({
      entries: [mkEntry(0, { rolling: { percent: from } }), mkEntry(H5, { rolling: { percent: to } })],
      range: { start: T0, end: T0 + H5 }, truncated: false, esc: e,
    });

    // delta 四舍五入到一位小数：1.234 -> 1.2
    rounded = panelOf(0, 1.234);
    // d = +0.05 恰在阈值上不触发 up（严格大于），取整 half-up 显示 0.1
    atUp = panelOf(0, 0.05);
    // d = -0.05 同理不算 down；Math.round(-0.5) 负零字符串化为 0
    atDown = panelOf(0, -0.05);
    // 阈值内侧：d = 0.04 flat 且取整为 0；d = 0.06 up 且进位 0.1
    inner = panelOf(0, 0.04);
    outer = panelOf(0, 0.06);

    // 全 null 序列：trendOf 返回 null -> 该卡片无任何趋势标记；
    // 三窗口中仅 rolling 有值时 dou-trend 恰出现一次
    only = openCodeGoAdapter.formatPanel({
      entries: [
        mkEntry(0, { rolling: { percent: 10 } }),
        mkEntry(H5, { rolling: { percent: 12 } }),
      ],
      range: { start: T0, end: T0 + H5 }, truncated: false, esc: e,
    });
  });

  it("delta 四舍五入至一位小数", () => {
    expect(rounded.includes("dou-trend-up") && rounded.includes("▲ +1.2%")).toBeTruthy();
  });

  it("+0.05 不算上升趋势（严格大于阈值）", () => {
    expect(atUp.includes("dou-trend-flat")).toBeTruthy();
  });

  it("+0.05 无 up 标记", () => {
    expect(!atUp.includes("dou-trend-up")).toBeTruthy();
  });

  it("+0.05 取整 half-up 为 0.1", () => {
    expect(atUp.includes("— 0.1%")).toBeTruthy();
  });

  it("-0.05 不算下降趋势（严格小于阈值）", () => {
    expect(atDown.includes("dou-trend-flat")).toBeTruthy();
  });

  it("-0.05 无 down 标记", () => {
    expect(!atDown.includes("dou-trend-down")).toBeTruthy();
  });

  it("-0.05 经负零字符串化显示 0", () => {
    expect(atDown.includes("— 0%")).toBeTruthy();
  });

  it("阈值内侧平坦且取整为零", () => {
    expect(inner.includes("dou-trend-flat") && inner.includes("— 0%")).toBeTruthy();
  });

  it("刚过阈值即上升并进位", () => {
    expect(outer.includes("dou-trend-up") && outer.includes("▲ +0.1%")).toBeTruthy();
  });

  it("全 null 窗口无趋势标记（仅有效窗口一个）", () => {
    expect((only.match(/dou-trend/g) || []).length).toBe(1);
  });
});

// ---------------------------------------------------------------- resetTicks 回溯与非法输入边界（#150 变异加固，经 miniChartSvgMarkup 观测）

/** 提取 SVG 中窗口重置竖线的 x1 坐标序列 */
function resetLineXs(svg) {
  return [...svg.matchAll(/<line x1="([\d.]+)" y1="14"[^]*?<title>窗口重置点<\/title>/g)]
    .map((m) => Number(m[1]));
}

describe("resetTicks 回溯与非法输入边界（#150 变异加固）", () => {
  it("r 区间外时按周期回溯产出三个历史重置点", () => {
    // r 在区间右端之外（+5min）：本体不入列；按 period=10min 回溯出
    // 25/15/5min 三点全部落在 [t0, t1] -> 恰三条重置线且 x 递增（锁排序）
    const svg = miniChartSvgMarkup({
      samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
      color: "#abc", lo: 0, hi: 100,
      resetsAt: new Date(T0 + 35 * MIN).toISOString(),
      resetPeriodMs: 10 * MIN, dateOnly: false,
    });
    expect(resetLineXs(svg).length).toBe(3);
  });

  it("重置线 x 坐标升序（sort 生效）", () => {
    const svg = miniChartSvgMarkup({
      samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
      color: "#abc", lo: 0, hi: 100,
      resetsAt: new Date(T0 + 35 * MIN).toISOString(),
      resetPeriodMs: 10 * MIN, dateOnly: false,
    });
    const xs = resetLineXs(svg);
    expect(xs.every((v, i) => i === 0 || v > xs[i - 1])).toBeTruthy();
  });

  it("回溯受 guard<40 守卫截断为恰四十个点", () => {
    // guard<40 截断：period=1min、r=t1 外 1min、区间 45min ->
    // 回溯点最多 40 个（循环守卫上限），不多不少
    const svg = miniChartSvgMarkup({
      samples: [{ x: T0, y: 10 }, { x: T0 + 45 * MIN, y: 20 }],
      color: "#abc", lo: 0, hi: 100,
      resetsAt: new Date(T0 + 46 * MIN).toISOString(),
      resetPeriodMs: MIN, dateOnly: false,
    });
    expect(resetLineXs(svg).length).toBe(40);
  });

  {
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
      it(`非法入参 ${JSON.stringify(bad)} 产零条重置线`, () => {
        const svg = miniChartSvgMarkup({ ...base, ...bad });
        expect(resetLineXs(svg).length).toBe(0);
      });
    }
  }
});

// ---------------------------------------------------------------- 图表纯函数分档矩阵（#150 变异加固 2/4 续）

describe("图表纯函数分档矩阵（#150 变异加固 2/4 续）", () => {
  let svg10m, svg30m, svg1h, svg6h, svg2d, svg5d, svg14d, svg60d, svgDateOnly, svgFrac, tight, wide, wider, svgDownsample, svgCurve, svgTiny;

  beforeAll(() => {
    const mk = (from, to, opts = {}) => miniChartSvgMarkup({
      samples: [{ x: T0, y: 0 }, { x: T0 + to, y: 5 }],
      color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      ...opts,
    });

    // timeTickStep 分档 + timeTicks 翻倍：spanMs=10min 触发 step=2min
    // 预期 10:00-10:10 约 6 个刻度（HH:mm），经 step 翻倍后 count≤6 停
    svg10m = mk(0, 10 * MIN);
    // timeTickStep 分档 2：spanMs=30min 触发 step=5min（10min<30min≤45min）
    svg30m = mk(0, 30 * MIN);
    // timeTickStep 分档 3：spanMs=1h 触发 step=15min（45min<1h≤3h）
    svg1h = mk(0, 60 * MIN);
    // timeTickStep 分档 4：spanMs=6h 触发 step=1h（3h<6h≤12h）
    svg6h = mk(0, 6 * 3600000);
    // timeTickStep 分档 5：spanMs=2d 触发 step=3h（12h<2d≤3d）
    svg2d = mk(0, 48 * 3600000);
    // timeTickStep 分档 6：spanMs=5d 触发 step=6h（3d<5d≤7d）
    svg5d = mk(0, 5 * 86400000);
    // timeTickStep 分档 7：spanMs=14d 触发 step=1d（7d<14d≤30d）
    svg14d = mk(0, 14 * 86400000);
    // timeTickStep 分档 8：spanMs=60d 触发 step=7d（>30d）
    svg60d = mk(0, 60 * 86400000);

    // axisLabelWidthPx 分档：dateOnly=true → "MM-dd" 长度
    svgDateOnly = mk(0, 14 * 86400000, { dateOnly: true });

    // fmtPctTick 非整数：lo/hi 含小数 → 刻度出现 N.N%
    svgFrac = miniChartSvgMarkup({
      samples: [{ x: T0, y: 1.5 }, { x: T0 + 30 * MIN, y: 2.5 }],
      color: "#c", lo: 0.5, hi: 9.5, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
    });

    // niceDomain 经 formatPanel 覆盖：极差/3 映射到 niceStep 不同分档
    // niceStep 分档：norm<1.5 → step=mag；<3.5 → 2*mag；<7.5 → 5*mag；else → 10*mag
    const panelOf = (from, to) => openCodeGoAdapter.formatPanel({
      entries: [mkEntry(0, { rolling: { percent: from, resetsAt: undefined } }),
                mkEntry(H5, { rolling: { percent: to, resetsAt: undefined } })],
      range: { start: 0, end: H5 }, truncated: false, esc: (s) => String(s),
    });
    // 极差=0.5/3≈0.167 → norm=0.167/0.1=1.67 → <3.5 → step=2*0.1=0.2
    tight = panelOf(1, 1.5);
    // 极差=50/3≈16.67 → norm=16.67/10=1.667 → <3.5 → step=2*10=20
    wide = panelOf(10, 60);
    // 极差=90/3=30 → norm=30/10=3 → <3.5 → step=2*10=20
    wider = panelOf(0, 90);

    // downsample 补最后点：当 out 最后元素不是 lastPt 时补入
    const many = [];
    for (let i = 0; i < 350; i += 1) {
      many.push({ x: T0 + i * MIN, y: i % 50 });
    }
    svgDownsample = miniChartSvgMarkup({
      samples: many, color: "#c", lo: 0, hi: 100,
      resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
    });

    // smoothPath 短路径：pts.length<2 返回空串
    // 2 个采样点 + 降采样后 ≥2 点 → 不触发短路径返回
    // 但单点已由「少于 2 个采样点返回空串」测试（miniChartSvgMarkup 返回空串）
    // 这里验证 2 点下 path 含 M 命令（smoothPath 正常拼接）
    svgCurve = mk(0, 30 * MIN);

    // timeTicks out.length<2 → [t0, t1]：极短跨度（2 个点 x 相同，spanMs=1min fallback）
    svgTiny = miniChartSvgMarkup({
      samples: [{ x: T0, y: 0 }, { x: T0 + 1, y: 5 }],
      color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
    });
  });

  it("10min span 刻度为 HH:mm", () => {
    expect(/>\d{2}:\d{2}<\/text>/.test(svg10m)).toBeTruthy();
  });

  it("10min span 首个刻度含 10:00", () => {
    expect(svg10m.includes("10:00") || svg10m.includes("10:0")).toBeTruthy();
  });

  it("30min span 刻度为 HH:mm", () => {
    expect(/>\d{2}:\d{2}<\/text>/.test(svg30m)).toBeTruthy();
  });

  it("1h span 刻度为 HH:mm", () => {
    expect(/>\d{2}:\d{2}<\/text>/.test(svg1h)).toBeTruthy();
  });

  it("6h span 刻度为 HH:mm", () => {
    expect(/>\d{2}:\d{2}<\/text>/.test(svg6h)).toBeTruthy();
  });

  it("6h span 刻度数合理（3-8 个）", () => {
    // 1h step → count≤6 循环限制下约 4-7 个刻度（10:00~16:00）
    const ticks = svg6h.match(/\d{2}:\d{2}<\/text>/g);
    expect(ticks && ticks.length >= 3 && ticks.length <= 8, `6h span 刻度数合理（3-8 个），实为 ${ticks?.length}`).toBeTruthy();
  });

  it("2d span 刻度含月-日", () => {
    // ≥1d 但 <7d → MM-dd HH:mm 格式，刻度文本含空格分隔日期与时间
    expect(svg2d.includes("6-") || svg2d.includes("6-17")).toBeTruthy();
  });

  it("2d span 刻度含分钟指示（HH:mm 格式）", () => {
    expect(svg2d.includes(":")).toBeTruthy();
  });

  it("5d span 刻度含月-日", () => {
    // ≥1d 且 <7d → MM-dd HH:mm
    expect(svg5d.includes("6-16") || svg5d.includes("6-20")).toBeTruthy();
  });

  it("5d span 刻度含分钟指示（HH:mm 格式）", () => {
    expect(svg5d.includes(":")).toBeTruthy();
  });

  it("14d span 刻度为 MM-dd（无小时）", () => {
    // spanMs≥7d → fmtAxisTime 返回 MM-dd（无 HH:mm）
    expect(svg14d.includes("6-16") || svg14d.includes("6-28")).toBeTruthy();
  });

  it("14d span 刻度文本为 MM-dd（无冒号）", () => {
    const tickTexts14 = [...svg14d.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
    expect(tickTexts14.every((t) => t.includes("%") || t.includes("-"))).toBeTruthy();
  });

  it("14d span 刻度文本不含冒号", () => {
    const tickTexts14 = [...svg14d.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
    expect(!tickTexts14.some((t) => t.includes(":"))).toBeTruthy();
  });

  it("60d span 刻度为 MM-dd", () => {
    // spanMs≥7d → MM-dd
    expect(svg60d.includes("6-") || svg60d.includes("8-")).toBeTruthy();
  });

  it("dateOnly 刻度为 M-DD 格式", () => {
    expect(svgDateOnly.includes("6-16") || svgDateOnly.includes("6-2")).toBeTruthy();
  });

  it("dateOnly 刻度文本为 M-DD 形态", () => {
    // 刻度文本均为 MM-dd 形态（含连字符，无冒号）
    const tickTexts = [...svgDateOnly.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
    expect(tickTexts.some((t) => /^\d+-\d{2}$/.test(t))).toBeTruthy();
  });

  it("dateOnly 刻度无 HH:mm", () => {
    const tickTexts = [...svgDateOnly.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);
    expect(!tickTexts.some((t) => t.includes(":"))).toBeTruthy();
  });

  it("小数 hi 刻度包含一位小数", () => {
    expect(svgFrac.includes(">0.5%</text>")).toBeTruthy();
  });

  it("5 为整数百分比（无小数）", () => {
    // gridVals = [0.5, 5, 9.5] → 5 为整数
    expect(svgFrac.includes(">5%</text>")).toBeTruthy();
  });

  it("紧区间仍产趋势卡片", () => {
    expect(tight.includes("dou-")).toBeTruthy();
  });

  it("宽区间仍产趋势卡片", () => {
    expect(wide.includes("dou-")).toBeTruthy();
  });

  it("更宽区间仍产趋势卡片", () => {
    expect(wider.includes("dou-")).toBeTruthy();
  });

  it("降采样末点圆标记存在", () => {
    // 降采样后包末点圆标记（断言 lastPt 被补入）
    expect(svgDownsample.includes("<circle")).toBeTruthy();
  });

  it("降采样后仍为合法 SVG", () => {
    expect(svgDownsample.startsWith("<svg")).toBeTruthy();
  });

  it("2 点图表产出 path 折线 M 命令", () => {
    expect(svgCurve.includes('d="M')).toBeTruthy();
  });

  it("smoothPath 产出 Catmull-Rom 曲线 C 命令", () => {
    // 相邻点 Catmull-Rom 曲线：C 命令存在
    expect(svgCurve.includes(' C ')).toBeTruthy();
  });

  it("极短跨度仍产合法 SVG", () => {
    // spanMs=1ms → spanMs <= 1min 的分支（timeTickStep step=2min）
    // timeTicks 中 step=2min, 但 spanMs=1ms → 可能 count<2 → 返回 [t0, t1]
    expect(svgTiny.startsWith("<svg")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- sanitizeHtml 清理链全正则覆盖（#150 变异加固 2/4 续）

describe("sanitizeHtml 清理链全正则覆盖（#150 变异加固）", () => {
  it("空串直接返回空串", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  // script 标签（含属性变体与大小写）
  it("script 标签整段移除", () => {
    expect(sanitizeHtml("<script>alert(1)</script>x")).toBe("x");
  });

  it("script 大小写不敏感移除", () => {
    expect(sanitizeHtml("<SCRIPT type=text/javascript>x</SCRIPT>y")).toBe("y");
  });

  // iframe / frame / object / embed / meta / link / base
  it("iframe 整段移除", () => {
    expect(sanitizeHtml('<iframe src="x"></iframe>k')).toBe("k");
  });

  it("frame 整段移除", () => {
    expect(sanitizeHtml('<frame src="x"></frame>f')).toBe("f");
  });

  it("object 整段移除", () => {
    expect(sanitizeHtml('<object data="x"></object>o')).toBe("o");
  });

  it("embed 整段移除", () => {
    expect(sanitizeHtml("<embed src=x></embed>e")).toBe("e");
  });

  it("meta 标签移除", () => {
    expect(sanitizeHtml('<meta charset="utf-8">m')).toBe("m");
  });

  it("link 标签移除", () => {
    expect(sanitizeHtml('<link rel=stylesheet href=x>l')).toBe("l");
  });

  it("base 标签移除", () => {
    expect(sanitizeHtml('<base href="//evil/">b')).toBe("b");
  });

  // on* 事件处理器三种引号形态 + 无引号形态
  it("on*=双引号事件被剥", () => {
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).toBe("<img src=\"x\">");
  });

  it("on*=单引号事件被剥", () => {
    expect(sanitizeHtml("<a onclick='go()'>c</a>")).toBe("<a>c</a>");
  });

  it("on*=无引号事件被剥（大小写不敏感）", () => {
    expect(sanitizeHtml("<div onMouseOver=hi()>d</div>")).toBe("<div>d</div>");
  });

  // javascript: URI 与 data:text/html 与 expression(
  it("javascript: 协议剥离", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a href="alert(1)">x</a>');
  });

  it("javascript: 大小写混合剥离", () => {
    expect(sanitizeHtml('<a href="JaVaScRiPt:x">y</a>')).toBe('<a href="x">y</a>');
  });

  it("data:text/html 场景随 iframe 移除", () => {
    expect(sanitizeHtml('<iframe src="data:text/html,<b>z"></iframe>q')).toBe("q");
  });

  it("CSS expression( 被剥", () => {
    const exp = sanitizeHtml("<div style=\"width:expression(alert(1))\">w</div>");
    expect(!exp.includes("expression(")).toBeTruthy();
  });

  // 正常内容不被误伤
  it("正常标签保留", () => {
    expect(sanitizeHtml("<b>ok</b>")).toBe("<b>ok</b>");
  });

  it("正常链接与属性保留", () => {
    expect(sanitizeHtml('<a href="https://example.com" title="t">n</a>')).toBe('<a href="https://example.com" title="t">n</a>');
  });
});

// ---------------------------------------------------------------- #105③ 实体编码变体（清理链补充）

describe("#105③ 实体编码变体（清理链补充）", () => {
  it("hex 实体 javascript: 剥除", () => {
    expect(sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>')).toBe('<a href="alert(1)">x</a>');
  });

  it("十进制词首 j 实体剥除", () => {
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">y</a>')).toBe('<a href="alert(1)">y</a>');
  });

  it("hex 无分号变体剥除", () => {
    expect(!sanitizeHtml("jav&#x61script:x").includes("&#x61script")).toBeTruthy();
  });

  it("&#X3c; 开标签变体随 token 移除（其间文本保留）", () => {
    expect(sanitizeHtml("&#X3c;script>x</script>t")).toBe("xt");
  });

  it("属性名尾部实体编码剥除", () => {
    expect(sanitizeHtml("<img src=x oncli&#99;k='go()'>")).toBe("<img src=x>");
  });

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
    it(`幂等不动点: ${s}`, () => {
      expect(sanitizeHtml(sanitizeHtml(s))).toBe(sanitizeHtml(s));
    });
  }

  // 深嵌套收敛与幂等（复核 P1-2）：pad(k) 引自 test/helpers.ts 单一事实源，
  // 每轮仅暴露一层 <meta>，pad(17/18/25) 均在 64 轮宽松上限内全净收敛且幂等
  for (const depth of [17, 18, 25]) {
    it(`深嵌套 pad(${depth}) 幂等不动点`, () => {
      const y = sanitizeHtml(pad(depth));
      expect(sanitizeHtml(y)).toBe(y);
    });

    it(`深嵌套 pad(${depth}) 无危险 token 残留`, () => {
      const y = sanitizeHtml(pad(depth));
      expect(!/<meta\b|<met\b/i.test(y)).toBeTruthy();
    });
  }

  it("超限 fail-closed 返回空串", () => {
    // 超限 fail-closed（复核 P1-3）：>64 轮深嵌套返回空串且幂等保持
    expect(sanitizeHtml(pad(70) + "&#X3c;script>x</script>t")).toBe("");
  });

  it("fail-closed 后 f(f(x))===f(x)", () => {
    const y70 = sanitizeHtml(pad(70) + "&#X3c;script>x</script>t");
    expect(sanitizeHtml(y70)).toBe(y70);
  });
});

// ---------------------------------------------------------------- #105③ C1 管道级端到端：净化在管道内生效

describe("#105③ C1 管道级端到端：净化在管道内生效", () => {
  let capR, panelR;

  beforeAll(async () => {
    // pipeContained 判据引自 test/helpers.ts 单一事实源（统一判定标准 v2：
    // 一轮实体解码 + WHATWG URL 剥除 \t\n\r 后不得匹配危险载体模式）

    // 恶意 formatCapsule（issue 原例 payload）→ runV2Pipeline 产出前净化兜底
    capR = await runV2Pipeline({
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

    // 恶意 formatPanel（事件属性部分编码 + 具名冒号协议）→ runV2PanelPipeline 净化兜底
    const sanPipeDir = mkdtempSync(join(tmpdir(), "dou-san-pipe-"));
    const store = new HistoryStore({ root: sanPipeDir });
    try {
      await store.append("pv", "evil-panel", { time: Date.now(), data: { v: 1 } });
      panelR = await runV2PanelPipeline({
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
    } finally {
      rmSync(sanPipeDir, { recursive: true, force: true });
    }
  });

  it("C1: 管道执行成功", () => {
    expect(capR.ok).toBe(true);
  });

  it("C1: capsuleHtml 满足统一判定标准（hex 实体载体封闭）", () => {
    expect(capR.capsuleHtml !== undefined && pipeContained(capR.capsuleHtml)).toBeTruthy();
  });

  it("C1: 危险实体区间已自输出移除", () => {
    expect(capR.capsuleHtml !== undefined && !capR.capsuleHtml.includes("jav&#x61")).toBeTruthy();
  });

  it("C1: panelHtml 满足统一判定标准（属性部分编码 + data&colon 封闭）", () => {
    expect(panelR.panelHtml !== undefined && pipeContained(panelR.panelHtml)).toBeTruthy();
  });

  it("C1: 无害属性与文本保留（兜底不扩大化）", () => {
    expect(panelR.panelHtml !== undefined && panelR.panelHtml.includes("<p t=1") && panelR.panelHtml.includes(">x ")).toBeTruthy();
  });
});

// ================================================================ #150 二阶段：samplePoint / summarize 残余分支

describe("#150 二阶段：samplePoint / summarize 残余分支", () => {
  let adapter, sp, v2, rp;

  beforeAll(() => {
    adapter = defineUsageAdapter({
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

    // percent 非有限值 → null 占位；limit/resetPeriodMs 缺省字段省略
    sp = adapter.samplePoint({
      ok: true, provider: "openai", label: "SPE", fetchedAt: 0,
      windows: [
        { key: "a", name: "A", percent: Number.NaN },
        { key: "b", name: "B", percent: 2.5, limit: 5, resetPeriodMs: 3600000 },
        { key: "c", name: "C", percent: Number.POSITIVE_INFINITY },
      ],
    });

    // version 显式覆盖
    v2 = defineUsageAdapter({
      version: 9,
      id: "v-explicit",
      label: "V",
      providers: ["p"],
      windows: [{ key: "k", name: "K" }],
      fetchUsage: async () => ({ ok: false, provider: "p", label: "L", fetchedAt: 0 }),
    });

    // retryPolicy 透传
    rp = defineUsageAdapter({
      id: "rp",
      label: "RP",
      providers: ["p"],
      windows: [{ key: "k", name: "K" }],
      fetchUsage: async () => ({ ok: false, provider: "p", label: "L", fetchedAt: 0 }),
      retryPolicy: { maxRetries: 3, backoffMs: 100 },
    });
  });

  // cols 与 values 长度不一致（usage.windows 少于 spec.windows）→ null
  it("values 短于 cols 返回 null", () => {
    expect(adapter.samplePoint({
      ok: true, provider: "openai", label: "SPE", fetchedAt: 0,
      windows: [{ key: "a", name: "A", percent: 1 }],
    })).toBe(null);
  });

  it("NaN/Infinity 场景仍返回结构", () => {
    expect(sp !== null).toBeTruthy();
  });

  it("NaN → null", () => {
    expect(sp.values[0]).toBe(null);
  });

  it("Infinity → null", () => {
    expect(sp.values[2]).toBe(null);
  });

  it("无 limit/reset 时字段省略", () => {
    expect(Object.keys(sp.cols[0]).sort()).toEqual(["key", "name"]);
  });

  it("limit 透传", () => {
    expect(sp.cols[1].limit).toBe(5);
  });

  it("resetPeriodMs 透传", () => {
    expect(sp.cols[1].resetPeriodMs).toBe(3600000);
  });

  it("version 显式指定优先于默认 1", () => {
    expect(v2.version).toBe(9);
  });

  it("retryPolicy 透传", () => {
    expect(rp.retryPolicy).toEqual({ maxRetries: 3, backoffMs: 100 });
  });
});

describe("#150 二阶段：summarize 自定义文本为空串时回落 label", () => {
  let summary;

  beforeAll(async () => {
    const adapter = defineUsageAdapter({
      id: "empty-sum",
      label: "Empty Label Fallback",
      providers: ["openai"],
      windows: [{ key: "r", name: "R" }],
      fetchUsage: async () => ({ ok: false, provider: "openai", label: "E", fetchedAt: 0 }),
      summarizeText: () => "",
    });
    summary = await adapter.summarize({
      provider: "openai",
      usage: {
        ok: true, provider: "openai", label: "E", fetchedAt: 0,
        windows: [{ key: "r", name: "R", percent: 10 }],
      },
    } as any);
  });

  it("空文本回落 label", () => {
    expect(summary.text).toBe("Empty Label Fallback");
  });

  it("summarize fetchedAt 取当下", () => {
    expect(summary.fetchedAt > 0).toBe(true);
  });
});

