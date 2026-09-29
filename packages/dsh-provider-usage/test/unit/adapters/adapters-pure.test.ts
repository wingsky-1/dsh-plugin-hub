/**
 * dsh-provider-usage — unit：#732 抽出的三个内置适配器纯函数直接打面。
 *
 * 适配器是外部协议解析，本文件只打抽出的「解析 / 归一 / 渲染」三段纯函数，
 * 不碰 fetch 通道（走现有适配器用例）与宿主注入面：
 * - deepseek-official.mjs：CNY 币种筛选 / 日聚合三段 / 余额走势图刻度与除权 / 面板采样归一
 * - opencode-go.mjs：百分比域四步 / 窗口元组解析 / 趋势与重置文案 / 采样序列
 * - zai-coding-cn.mjs：主机判定 / limits 归一 / 业务层取数 / 重置外推 / 胶囊文案
 *
 * 纪律：零网络、零 I/O、零凭据；时间戳全部显式入参。
 */
import { describe, expect, it } from "vitest";
import {
  cnyBalanceInfo,
  framesByDayOf,
  applyIntervalToSlot,
  accumulateIntervals,
  dailyExclusionNotes,
  renderDailyRow,
  balanceXScale,
  topUpEvents,
  cumulativeShifts,
  calibratedDomain,
  segmentIndexes,
  samplePointOf,
  samplePointsOf,
  trendLedgerOf,
  trendBadgeHtml,
  rechargeHintOf,
  panelUtils,
  type SamplePoint,
  type DaySlot,
} from "../../../src/server/adapters/deepseek-official.mjs";
import {
  finiteValuesOf,
  valueRangeOf,
  widenToMinSpan,
  capDomainAt100,
  normalizeWindows,
  seriesViewOf,
  windowPercentOf,
  resetTextOf,
  trendBadgeHtml as ogTrendBadgeHtml,
  windowPctsOf,
  chartPointsOf,
} from "../../../src/server/adapters/opencode-go.mjs";
import {
  quotaHostOf,
  normalizeLimits,
  normalizeQuotaBody,
  resetMarksOf,
  windowLabelOf,
  windowCapsuleParts,
  levelCapsulePart,
  capsuleHtml,
} from "../../../src/server/adapters/zai-coding-cn.mjs";

/** 采样代表点（默认值可逐项 override）。 */
function pt(over: Partial<SamplePoint> = {}): SamplePoint {
  return {
    t: 1_757_180_000_000,
    balance: 100,
    toppedUp: null,
    granted: null,
    available: true,
    ...over,
  };
}

const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);

describe("deepseek CNY 币种筛选", () => {
  it("cnyBalanceInfo：只认 currency=CNY；无 CNY / 非数组皆 undefined", () => {
    expect(
      cnyBalanceInfo({
        balance_infos: [{ currency: "USD" }, { currency: "CNY", total_balance: "1" }],
      }),
    ).toEqual({
      currency: "CNY",
      total_balance: "1",
    });
    expect(cnyBalanceInfo({ balance_infos: [{ currency: "USD" }] })).toBeUndefined();
    expect(cnyBalanceInfo({})).toBeUndefined();
  });
});

describe("deepseek 日聚合三段", () => {
  const keys = ["2025-09-06"];
  const keysSet = new Set(keys);

  it("framesByDayOf：只数目标日帧数", () => {
    const out = framesByDayOf(
      [
        pt({ t: Date.parse("2025-09-06T01:00:00Z") }),
        pt({ t: Date.parse("2025-09-06T02:00:00Z") }),
        pt({ t: Date.parse("2025-09-07T01:00:00Z") }),
      ],
      dayKey,
      keysSet,
    );
    expect(out.get("2025-09-06")).toBe(2);
    expect(out.get("2025-09-07")).toBeUndefined();
  });

  it("applyIntervalToSlot：clean 记降幅，unavailable / gap / disturbed 各记各的", () => {
    const base: DaySlot = {
      sum: 0,
      topIn: 0,
      grantParts: [],
      mixed: false,
      gapSegs: 0,
      unavail: false,
    };
    expect(
      applyIntervalToSlot({ ...base }, { type: "clean", drop: 5, topup: 0, grantDelta: 0 }).sum,
    ).toBe(5);
    expect(
      applyIntervalToSlot({ ...base }, { type: "unavailable", drop: 5, topup: 0, grantDelta: 0 })
        .unavail,
    ).toBe(true);
    expect(
      applyIntervalToSlot({ ...base }, { type: "gap", drop: 5, topup: 0, grantDelta: 0 }).gapSegs,
    ).toBe(1);
    const disturbed = applyIntervalToSlot(
      { ...base, grantParts: [] },
      { type: "disturbed", drop: 5, topup: 9, grantDelta: 3.5 },
    );
    expect(disturbed.mixed).toBe(true);
    expect(disturbed.topIn).toBe(9);
    expect(disturbed.grantParts).toEqual(["赠款 +3.50"]);
  });

  it("accumulateIntervals：相邻区间计入结束端所在日", () => {
    const t0 = Date.parse("2025-09-06T01:00:00Z");
    const acc = accumulateIntervals(
      [pt({ t: t0, balance: 100 }), pt({ t: t0 + 3600_000, balance: 90 })],
      dayKey,
      keysSet,
    );
    expect(acc.get("2025-09-06")?.sum).toBe(10);
  });

  it("dailyExclusionNotes：四类未计入项按固定顺序成文", () => {
    expect(
      dailyExclusionNotes({
        sum: 0,
        topIn: 3,
        grantParts: ["赠款 +1.00"],
        mixed: true,
        gapSegs: 2,
        unavail: true,
      }),
    ).toEqual(["充值 +¥3.00 未计入", "赠款 +1.00 变动不计", "2 段中断不计", "含不可用区间不计"]);
  });

  it("renderDailyRow：无槽位时按帧数分 empty / insufficient", () => {
    expect(renderDailyRow("k", 0, undefined)).toEqual({ key: "k", status: "empty", u: 0 });
    expect(renderDailyRow("k", 2, undefined)).toEqual({ key: "k", status: "insufficient", u: 0 });
  });

  it("renderDailyRow：正常日带 u / neg / extra / toppedUpIn 四键", () => {
    const slot: DaySlot = {
      sum: -1,
      topIn: 4,
      grantParts: [],
      mixed: true,
      gapSegs: 0,
      unavail: false,
    };
    expect(renderDailyRow("k", 3, slot)).toEqual({
      key: "k",
      status: "ok",
      u: -1,
      neg: true,
      extra: "充值 +¥4.00 未计入",
      toppedUpIn: 4,
    });
  });
});

describe("deepseek 余额走势图除权面", () => {
  it("balanceXScale：时刻与区间中点都落画布内", () => {
    const s = balanceXScale(0, 1000);
    expect(s.of(0)).toBe(44);
    expect(s.of(1000)).toBeCloseTo(312, 6);
    expect(s.ofMid(0, 1000)).toBeCloseTo(178, 6);
  });

  it("topUpEvents：只收 toppedUp 涨幅超容差的相邻区间", () => {
    const xs = balanceXScale(0, 10_000);
    const events = topUpEvents(
      [pt({ t: 0, toppedUp: 10 }), pt({ t: 1000, toppedUp: 60 }), pt({ t: 2000, toppedUp: 60 })],
      xs,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.amt).toBe(50);
    expect(events[0]?.atIdx).toBe(1);
  });

  it("cumulativeShifts：事件之后的点按累计充值额整体下移", () => {
    const values = [pt({ t: 0 }), pt({ t: 1 }), pt({ t: 2 })];
    expect(cumulativeShifts(values, [{ atIdx: 1, amt: 50, xMid: 0 }])).toEqual([0, 50, 50]);
  });

  it("calibratedDomain：自适应两域 + 全平水位兜底余量", () => {
    // 下界夹到 0（余额不出现负值），上界留 15% 余量
    expect(calibratedDomain([pt({ balance: 0 }), pt({ balance: 10 })], [0, 0])).toEqual({
      lo: 0,
      hi: 11.5,
    });
    // 全平水位：dmin==dmax 时首个余量项退到 max(hi*0.1, 0.01) 兜底
    const flat = calibratedDomain([pt({ balance: 5 }), pt({ balance: 5 })], [0, 0]);
    expect(flat).toEqual({ lo: 4.5, hi: 5.5 });
  });

  it("segmentIndexes：≤300 全收，>300 降采样并补回末点", () => {
    expect(segmentIndexes(0, 2)).toEqual([0, 1, 2]);
    const big = segmentIndexes(0, 900);
    expect(big.length).toBeLessThanOrEqual(302);
    expect(big[big.length - 1]).toBe(900);
  });
});

describe("deepseek 面板采样归一", () => {
  it("samplePointOf：字段缺失降级为 NaN / null，isAvailable 默认可用", () => {
    expect(samplePointOf({ time: 5, data: { balance: 3, isAvailable: false } })).toEqual({
      t: 5,
      balance: 3,
      toppedUp: null,
      granted: null,
      available: false,
    });
    expect(samplePointOf({})).toEqual({
      t: NaN,
      balance: NaN,
      toppedUp: null,
      granted: null,
      available: true,
    });
  });

  it("samplePointsOf：剔无效点、剔未来点（容差一采样周期）、稳定排序", () => {
    const now = 1_757_180_000_000;
    const out = samplePointsOf(
      [
        { time: now, data: { balance: 2 } },
        { time: now - 1000, data: { balance: 3 } },
        // 未来容差一采样周期（GAP_MS = 27h）：+1h 仍在窗内，+30h 超出即剔
        { time: now + 3_600_000, data: { balance: 4 } },
        { time: now + 30 * 3_600_000, data: { balance: 5 } },
        { time: now, data: {} },
      ],
      now,
    );
    expect(out.map((p) => p.t)).toEqual([now - 1000, now, now + 3_600_000]);
  });

  it("trendLedgerOf：clean 记消费，disturbed 记充值，其余记 skipped", () => {
    const t0 = 1_757_180_000_000;
    const out = trendLedgerOf([
      pt({ t: t0, balance: 100, toppedUp: 0 }),
      pt({ t: t0 + 1000, balance: 90, toppedUp: 0 }),
      pt({ t: t0 + 2000, balance: 85, toppedUp: 50 }),
    ]);
    expect(out.spent).toBe(10);
    expect(out.topIn).toBe(50);
    expect(out.skipped).toBe(true);
    expect(out.counted).toBe(1);
  });

  it("trendBadgeHtml：无落账消费且无可计区间 → 消费未知（不谎称≈0）", () => {
    const html = trendBadgeHtml(
      [pt()],
      () => null,
      (s) => s,
    );
    expect(html).toContain("消费未知");
  });

  it("trendBadgeHtml：有落账消费 → 已用金额", () => {
    const t0 = 1_757_180_000_000;
    const html = trendBadgeHtml(
      [pt({ t: t0, balance: 100 }), pt({ t: t0 + 1000, balance: 90 })],
      (v) => v,
      (s) => s,
    );
    expect(html).toContain("已用 ¥10.00");
  });

  it("rechargeHintOf：有充值事件才提示断轴", () => {
    expect(rechargeHintOf([pt({ toppedUp: 0 }), pt({ toppedUp: 50 })])).toBe(" · 充值已断轴");
    expect(rechargeHintOf([pt({ toppedUp: 0 }), pt({ toppedUp: 0 })])).toBe("");
  });

  it("panelUtils：无注入时回退文件内兜底副本", () => {
    const out = panelUtils({
      entries: [],
      range: { start: 0, end: 0 },
      truncated: false,
      esc: (s) => String(s),
    });
    expect(typeof out.esc).toBe("function");
    expect(typeof out.escAttr).toBe("function");
    expect(typeof out.fin).toBe("function");
  });
});

describe("opencode-go 百分比域四步", () => {
  it("finiteValuesOf：只留有限 number", () => {
    expect(finiteValuesOf([1, null, 2, Infinity, NaN])).toEqual([1, 2]);
  });

  it("valueRangeOf：空输入 null，否则给 min/max", () => {
    expect(valueRangeOf([])).toBeNull();
    expect(valueRangeOf([3, 1, 9])).toEqual({ dmin: 1, dmax: 9 });
  });

  it("widenToMinSpan：域过窄以中点撑开 minSpan，贴 0 边界上移 hi", () => {
    expect(widenToMinSpan(0, 1, 0, 1, 10, 1)).toEqual([0, 10]);
  });

  it("capDomainAt100：dmax≥90 抬到 100，域不得越界 0–100", () => {
    expect(capDomainAt100(0, 95, 93)).toEqual([0, 100]);
    expect(capDomainAt100(0, 150, 150)).toEqual([0, 100]);
    expect(capDomainAt100(60, 60, 60)).toEqual([55, 60]);
  });
});

describe("opencode-go 窗口元组与文案纯面", () => {
  it("normalizeWindows：缺窗口补空壳，命中窗口原样带过", () => {
    const out = normalizeWindows({ rolling: { key: "rolling", percent: 12 } });
    expect(out.rolling).toEqual({ key: "rolling", percent: 12 });
    expect(out.weekly).toEqual({
      key: "weekly",
      name: expect.any(String),
      percent: null,
      limit: expect.any(Number),
    });
  });

  it("seriesViewOf：元组下标 → 具名字段（limit 转数字）", () => {
    expect(seriesViewOf(["weekly", "周", "W", "#fff", "100", 86400000, 604800000])).toEqual({
      key: "weekly",
      name: "周",
      short: "W",
      color: "#fff",
      limit: 100,
      obsMs: 86400000,
      period: 604800000,
    });
  });

  it("windowPercentOf：非 number 视作无数据", () => {
    expect(windowPercentOf({ percent: 5 })).toBe(5);
    expect(windowPercentOf({ percent: "5" })).toBeNull();
    expect(windowPercentOf(undefined)).toBeNull();
  });

  it("resetTextOf：缺席或空串不显示", () => {
    expect(resetTextOf({ resetsAt: "2026-09-07T00:00:00Z" })).toContain("重置");
    expect(resetTextOf({ resetsAt: "" })).toBe("");
    expect(resetTextOf({})).toBe("");
  });

  it("ogTrendBadgeHtml：null 无徽标，up / down / flat 三态", () => {
    expect(ogTrendBadgeHtml(null)).toBe("");
    expect(ogTrendBadgeHtml({ up: true, down: false, delta: 3 })).toContain("▲ +3%");
    expect(ogTrendBadgeHtml({ up: false, down: true, delta: 3 })).toContain("▼ 3%");
    expect(ogTrendBadgeHtml({ up: false, down: false, delta: 0 })).toContain("— 0%");
  });
});

describe("opencode-go 采样序列纯面", () => {
  const entries = [
    { time: 0, data: { rolling: { percent: 10 } } },
    { time: 1000, data: { rolling: { percent: 20 } } },
    { time: 2000, data: { rolling: { percent: 30 } } },
  ];

  it("windowPctsOf：观察窗内取值，非有限记 null 保留位置", () => {
    expect(windowPctsOf(entries, "rolling", 0, 2000)).toEqual([10, 20, 30]);
    // 观察窗只留 tail-obsMs 之后的采样；非有限值在窗内才记 null
    expect(windowPctsOf(entries, "rolling", 1500, 2000)).toEqual([20, 30]);
    expect(
      windowPctsOf(
        [
          { time: 0, data: { rolling: { percent: "x" } } },
          { time: 1000, data: { rolling: { percent: 20 } } },
        ],
        "rolling",
        0,
        1000,
      ),
    ).toEqual([null, 20]);
  });

  it("chartPointsOf：只收有限百分比并投影成 {x,y}", () => {
    expect(chartPointsOf(entries, "rolling", 0, 2000)).toEqual([
      { x: 0, y: 10 },
      { x: 1000, y: 20 },
      { x: 2000, y: 30 },
    ]);
  });
});

describe("zai-coding-cn 主机判定", () => {
  it("quotaHostOf：取 origin；缺省 / 非法 / 非 http(s) 回落默认主机", () => {
    expect(quotaHostOf("https://proxy.example.com/api/coding/paas/v4")).toBe(
      "https://proxy.example.com",
    );
    expect(quotaHostOf("   ")).toBe(quotaHostOf(undefined));
    expect(quotaHostOf("not-a-url")).toBe(quotaHostOf(undefined));
    expect(quotaHostOf("ftp://x/y")).toBe(quotaHostOf(undefined));
  });
});

describe("zai-coding-cn limits 归一纯面", () => {
  it("normalizeLimits：CREDIT_LIMIT 按 unit 定窗口，TIME_LIMIT 收工具配额", () => {
    const out = normalizeLimits([
      null,
      { type: "CREDIT_LIMIT", unit: 3, percentage: 10, usage: 1, total: 10 },
      { type: "CREDIT_LIMIT", unit: 9, percentage: 10 },
      { type: "TIME_LIMIT", percentage: 20, usage: 5 },
    ]);
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]?.key).toBe("5h");
    expect(out.windows[0]?.percent).toBe(10);
    expect(out.tools?.percent).toBe(20);
  });

  it("normalizeQuotaBody：业务码非 OK / 无 limits / 窗口为空皆 null", () => {
    expect(normalizeQuotaBody({ code: 404 })).toBeNull();
    expect(normalizeQuotaBody({ code: 200, data: {} })).toBeNull();
    expect(
      normalizeQuotaBody({ code: 200, data: { limits: [{ type: "TIME_LIMIT", percentage: 1 }] } }),
    ).toBeNull();
  });

  it("normalizeQuotaBody：合法时给出 level + windows（tools 缺席则不带该键）", () => {
    const out = normalizeQuotaBody({
      code: 200,
      data: { level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 6, percentage: 50 }] },
    });
    expect(out?.level).toBe("pro");
    expect(out?.windows[0]?.key).toBe("week");
    expect(out && "tools" in out).toBe(false);
  });
});

describe("zai-coding-cn 渲染纯面", () => {
  it("resetMarksOf：周期非正 / 时间戳不可归一化皆空表", () => {
    expect(resetMarksOf("2025-09-06T00:00:00Z", 0, 0, 1000)).toEqual([]);
    expect(resetMarksOf("nope", 1000, 0, 1000)).toEqual([]);
  });

  it("resetMarksOf：落窗口内的重置点保留，之前的按周期外推", () => {
    const marks = resetMarksOf(900, 100, 0, 1000);
    expect(marks[0]).toBe(900);
    expect(marks).toContain(800);
    expect(marks.every((m) => m >= 0)).toBe(true);
  });

  it("windowLabelOf：5h / week 走展示名，其余透传原键", () => {
    expect(windowLabelOf("5h")).toBe("5h");
    expect(windowLabelOf("week")).toBe("周");
    expect(windowLabelOf("other")).toBe("other");
  });

  it("windowCapsuleParts：非 number 窗口不出片段", () => {
    expect(
      windowCapsuleParts([
        { key: "5h", percent: 12.4 },
        { key: "week", percent: null },
      ]),
    ).toEqual(["5h 12%"]);
  });

  it("levelCapsulePart：首字母大写；非串或空串 null", () => {
    expect(levelCapsulePart("pro")).toBe("Pro");
    expect(levelCapsulePart("")).toBeNull();
    expect(levelCapsulePart(7)).toBeNull();
  });

  it("capsuleHtml：无窗口片段 → 无数据；有则拼等级并按 stale 附缓存标记", () => {
    const esc = (s: unknown): string => String(s);
    const base = {
      data: { windows: [{ key: "5h", percent: 12.4 }] },
      status: "fresh" as const,
      time: 0,
      esc,
    };
    expect(capsuleHtml(base)).toContain("5h 12%");
    expect(capsuleHtml({ ...base, status: "stale" })).toContain("(缓存)");
    expect(capsuleHtml({ ...base, data: { windows: [] } })).toBe("<span>无数据</span>");
  });
});
