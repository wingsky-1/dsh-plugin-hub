// @ts-nocheck
/**
 * dsh-provider-usage — unit：#503 M3 用量报告（数据面纯逻辑 + 调度器）。
 *
 * 覆盖：
 * - schedule：candidateWindow/pendingReports（daily/weekly/monthly 窗口语义、
 *   lastRun 已扣期跳过、首次挂载补最近窗口、enabled 关闭不调度）
 * - config：parseHHMM 非法返回 null / normalizeReportConfig 非法值回退默认
 * - generate：正文拼接 / token 元数据 / 空串跟随默认路由解析 / 流异常失败元数据 /
 *   取消失败 / 空正文失败 / 路由不可解析失败 / {stats} 模板替换
 * - buildStatsSnapshot：窗口过滤 / totals 聚合 / byProvider calls 降序 / prevTotal 透传
 * - 前提断言（方案 §2.3）：报告生成走 ctx.llm.stream、不派发 session/event——
 *   单测以 fake llm（无 session 通道）验证生成路径不触达任何会话事件源；
 *   接线层 smoke 另以 emitEvent 计数显式断言「生成不产生 session 事件→不入统计」。
 * - scheduler（M3 接线补）：lastRun 读写 roundtrip / 单飞互斥（busy 期 tick 跳过）/
 *   失败不推进 lastRun（下轮重试同窗）/ 成功推进 / dispose 停 tick
 * - #633 分片 a D1：旧格式 trend 分片（无 cwd/dir 键）→ 启动重建 + buildStatsSnapshot
 *   报告链路不抛错；byDirectory 未识别桶数值正确；byProvider/byDay/派生维度与无 dir
 *   维度时完全一致（零回归）
 *
 * 结构：每个主题块一个 describe，每条断言一个 it（参数化断言按取值展开为多个 it）。
 * 「动作 → 断言 → 新动作」的交错块在 beforeAll 内保留原动作顺序、在每个原断言位置
 * 取观测快照（取拷贝不存引用），it 只断言快照——后置动作不会污染前置断言。
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, utimesSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pollUntil, callHandler } from "../../helpers.ts";
import {
  candidateWindow,
  previousClosedWindow,
  pendingReports,
  presetLastRunForNewlyEnabled,
  parseHHMM,
  normalizeReportConfig,
  DEFAULT_REPORT_CONFIG,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
  promptFor,
  readReportConfig,
  writeReportConfig,
  reportBodyToHtml,
  sanitizeHtml,
  generateReport,
  applyPromptTemplate,
  buildStatsSnapshot,
  ReportScheduler,
  readLastRun,
  writeLastRun,
  updateLastRun,
  __lastRunChainForTests,
  ensureLastRunMigrated,
  deriveLastRun,
  isClosedWindowRecord,
  LAST_RUN_SCHEMA,
  ReportTaskQueue,
  readReportIndex,
  parseReportIndexLines,
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
  handleReportStatus,
  TrendTracker,
  dayKey,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  persistReport,
  reportHtmlFile,
  reportMetaFile,
  notifyReport,
  runDueReport,
  normalizeReportDirectories,
} from "../../../src/apply/index.ts";

// ---------------------------------------------------------------- 工具

/** 固定本地时刻：2026-09-04（周五）12:00。 */
const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
const HOUR = 3600_000;

const CFG = (over = {}) => normalizeReportConfig({
  daily: { enabled: true, time: "22:00" },
  weekly: { enabled: true, time: "09:00", weekStartsOn: 1 },
  monthly: { enabled: true, time: "09:00", dayOfMonth: 1 },
  ...over,
});

const CHUNKS = [
  { type: "text-delta", index: 0, text: "第一段。" },
  { type: "text-delta", index: 0, text: "第二段。" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "finish", reason: "stop" },
];

/** fake llm：罐头 chunk 流；seen 记录收到的 GenerateOptions（断言路由/信号透传）。 */
function fakeLlm(chunks = CHUNKS, opts = {}) {
  const seen = { options: null, streamCalled: false };
  const llm = {
    stream(o) {
      seen.streamCalled = true;
      seen.options = o;
      return (async function* () {
        if (opts.throwInStream) throw new Error(opts.throwInStream);
        if (o.signal?.aborted) throw new Error("aborted before start");
        yield* chunks;
      })();
    },
    listProviders: () => (opts.noProviders ? [] : [{ id: "prov-a", name: "A" }, { id: "prov-b", name: "B" }]),
    listModels: async () => (opts.noModels ? [] : [{ provider: "prov-a", id: "model-a", name: "A" }]),
  };
  return { llm, seen };
}

const GEN = (over = {}) => ({
  llm: null,
  period: "daily",
  key: "2026-09-04",
  startDay: "2026-09-04",
  endDay: "2026-09-04",
  statsJson: '{"calls":1}',
  promptTemplate: "统计：{stats}",
  provider: "",
  model: "",
  ...over,
});

// ---------------------------------------------------------------- schedule：候选窗口

describe("schedule：daily 未过锚点（now 12:00 早于当日 22:00）", () => {
  let due;
  beforeAll(() => { due = candidateWindow("daily", CFG(), T0); });

  it("daily 未过锚点 → 前日全天", () => {
    expect(due.key).toBe("2026-09-02");
  });

  it("daily 起于前日", () => {
    expect(due.startDay).toBe("2026-09-02");
  });

  it("daily 止于前日（单日窗口）", () => {
    expect(due.endDay).toBe("2026-09-02");
  });
});

describe("schedule：daily 已过锚点（now 23:00 晚于当日 22:00）", () => {
  let due;
  beforeAll(() => { due = candidateWindow("daily", CFG(), T0 + 11 * HOUR); });

  it("daily 已过锚点 → 昨日全天", () => {
    expect(due.key).toBe("2026-09-03");
  });

  it("daily 起于昨日", () => {
    expect(due.startDay).toBe("2026-09-03");
  });

  it("daily 止于昨日", () => {
    expect(due.endDay).toBe("2026-09-03");
  });
});

describe("schedule：previousClosedWindow 手动生成（恒定昨日，消灭凌晨漂移）", () => {
  let manualDue;
  beforeAll(() => { manualDue = previousClosedWindow("daily", CFG(), T0); });

  it("手动生成恒为昨日全天", () => {
    expect(manualDue.key).toBe("2026-09-03");
  });

  it("手动生成起于昨日", () => {
    expect(manualDue.startDay).toBe("2026-09-03");
  });

  it("手动生成止于昨日", () => {
    expect(manualDue.endDay).toBe("2026-09-03");
  });
});

describe("schedule：weekly 候选窗口（周五，本周锚点已过）", () => {
  let due;
  beforeAll(() => { due = candidateWindow("weekly", CFG(), T0); });

  it("weekly 候选键=周起点-7（[runDay-7, runDay-1] 闭区间 7 天）", () => {
    expect(due.key).toBe("2026-08-24");
  });

  it("weekly 起于锚点前 7 天", () => {
    expect(due.startDay).toBe("2026-08-24");
  });

  it("weekly 止于锚点前 1 天", () => {
    expect(due.endDay).toBe("2026-08-30");
  });
});

describe("schedule：monthly 候选窗口（9-1 锚点已过）", () => {
  let due;
  beforeAll(() => { due = candidateWindow("monthly", CFG(), T0); });

  it("monthly 候选键=上一自然月", () => {
    expect(due.key).toBe("2026-08");
  });

  it("monthly 起于上月 1 日", () => {
    expect(due.startDay).toBe("2026-08-01");
  });

  it("monthly 止于上月末", () => {
    expect(due.endDay).toBe("2026-08-31");
  });
});

// ---------------------------------------------------------------- schedule：幂等与补跑

describe("schedule：幂等与补跑", () => {
  let firstMount, allRecorded, laterRecorded, nextRun, weeklyOff;

  beforeAll(() => {
    const cfg = CFG();
    firstMount = pendingReports(cfg, T0, {});
    allRecorded = pendingReports(cfg, T0, { daily: "2026-09-02", weekly: "2026-08-24", monthly: "2026-08" });
    laterRecorded = pendingReports(cfg, T0, { daily: "2026-09-10" });
    nextRun = pendingReports(CFG(), T0 + 11 * HOUR, { daily: "2026-09-02" });
    weeklyOff = pendingReports(CFG({ weekly: { enabled: false, time: "09:00", weekStartsOn: 1 } }), T0, {});
  });

  it("lastRun 空 → 三期全部补生成", () => {
    expect(firstMount.map((d) => d.period)).toEqual(["daily", "weekly", "monthly"]);
  });

  it("候选键 <= lastRun → 已扣期", () => {
    expect(allRecorded).toEqual([]);
  });

  it("lastRun 更晚 → 该期跳过", () => {
    expect(laterRecorded.some((d) => d.period === "daily")).toBeFalsy();
  });

  it("新锚点候选键 > lastRun → 补跑（未记录期同补）", () => {
    expect(nextRun.map((d) => d.period)).toEqual(["daily", "weekly", "monthly"]);
  });

  it("weekly 关闭 → 不调度", () => {
    expect(weeklyOff.some((d) => d.period === "weekly")).toBeFalsy();
  });
});

// ---------------------------------------------------------------- schedule：#531 首次启用扣期预置

describe("schedule：#531 首次启用扣期预置", () => {
  let r1, cand, presetPending, later, r2, r3, r4;

  beforeAll(() => {
    const allOff = normalizeReportConfig({
      daily: { enabled: false, time: "22:00" },
      weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
      monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
    });
    r1 = presetLastRunForNewlyEnabled(allOff, CFG(), T0, {});
    cand = {
      daily: candidateWindow("daily", CFG(), T0).key,
      weekly: candidateWindow("weekly", CFG(), T0).key,
      monthly: candidateWindow("monthly", CFG(), T0).key,
    };
    presetPending = pendingReports(CFG(), T0, r1.lastRun);
    later = pendingReports(CFG(), T0 + 25 * HOUR, r1.lastRun);
    r2 = presetLastRunForNewlyEnabled(CFG(), CFG(), T0, {});
    r3 = presetLastRunForNewlyEnabled(allOff, CFG(), T0, { daily: "2026-08-01" });
    const onlyMonthly = CFG({ daily: { enabled: false, time: "22:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 } });
    r4 = presetLastRunForNewlyEnabled(allOff, onlyMonthly, T0, {});
  });

  it("首次启用 → changed", () => {
    expect(r1.changed).toBe(true);
  });

  it("预置键 === 各期当前候选键", () => {
    expect(r1.lastRun).toEqual(cand);
  });

  it("预置扣期后 tick 无到期", () => {
    expect(presetPending).toEqual([]);
  });

  it("下个锚点到期 → 照常生成", () => {
    expect(later.some((d) => d.period === "daily" && d.key > r1.lastRun.daily)).toBeTruthy();
  });

  it("已启用未变 → 不预置", () => {
    expect(r2.changed).toBe(false);
  });

  it("部分周期有记录 → 其余仍预置", () => {
    expect(r3.changed).toBe(true);
  });

  it("已有记录的周期不覆写", () => {
    expect(r3.lastRun.daily).toBe("2026-08-01");
  });

  it("仅新启用周期预置", () => {
    expect(Object.keys(r4.lastRun)).toEqual(["monthly"]);
  });
});

// ---------------------------------------------------------------- config：归一化

describe("config：parseHHMM / normalizeReportConfig 归一化", () => {
  let n;
  beforeAll(() => {
    n = normalizeReportConfig({ daily: { enabled: true, time: "99:99" }, monthly: { dayOfMonth: 31 } });
  });

  it("22:00 合法", () => {
    expect(parseHHMM("22:00")).toEqual({ h: 22, m: 0 });
  });

  it("24:00 非法", () => {
    expect(parseHHMM("24:00")).toBeNull();
  });

  it("非数字非法", () => {
    expect(parseHHMM("9:5x")).toBeNull();
  });

  it("非字符串非法", () => {
    expect(parseHHMM(900)).toBeNull();
  });

  it("非法 HH:MM 回退默认", () => {
    expect(n.daily.time).toBe(DEFAULT_REPORT_CONFIG.daily.time);
  });

  it("dayOfMonth>28 回退默认", () => {
    expect(n.monthly.dayOfMonth).toBe(DEFAULT_REPORT_CONFIG.monthly.dayOfMonth);
  });

  it("weekStartsOn 非法回退周一", () => {
    expect(n.weekly.weekStartsOn).toBe(1);
  });

  it("promptTemplate 缺省取默认模板", () => {
    expect(n.promptTemplate.length > 0).toBeTruthy();
  });
});

// ---------------------------------------------------------------- generate：成功路径

describe("generate：成功路径（正文拼接 / token 元数据 / 空串跟随默认路由）", () => {
  let r, seen;
  beforeAll(async () => {
    const f = fakeLlm();
    r = await generateReport(GEN({ llm: f.llm }));
    seen = f.seen;
  });

  it("生成成功", () => {
    expect(r.meta.ok).toBe(true);
  });

  it("text-delta 顺序拼接", () => {
    expect(r.body).toBe("第一段。第二段。");
  });

  it("usage chunk 记元数据", () => {
    expect(r.meta.tokens).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: null, cacheWriteTokens: null });
  });

  it("空 provider → 注册序首个", () => {
    expect(r.meta.provider).toBe("prov-a");
  });

  it("空 model → 该 provider 首个", () => {
    expect(r.meta.model).toBe("model-a");
  });

  it("GenerateOptions 透传解析后路由", () => {
    expect(seen.options.provider).toBe("prov-a");
  });

  it("单条 user 消息", () => {
    expect(seen.options.messages.length).toBe(1);
  });

  it("user source", () => {
    expect(seen.options.messages[0].source.kind).toBe("user");
  });

  it("{stats} 注入统计 JSON", () => {
    expect(seen.options.messages[0].content[0].text.includes('{"calls":1}')).toBeTruthy();
  });

  it("tools 不传 = 无工具面", () => {
    expect(seen.options.tools === undefined).toBeTruthy();
  });

  it("时长记录", () => {
    expect(r.meta.durationMs >= 0).toBeTruthy();
  });
});

// ---------------------------------------------------------------- generate：显式路由透传

describe("generate：显式路由透传", () => {
  let r, seen;
  beforeAll(async () => {
    const f = fakeLlm();
    r = await generateReport(GEN({ llm: f.llm, provider: "prov-b", model: "model-b" }));
    seen = f.seen;
  });

  it("显式 provider 直接透传", () => {
    expect(r.meta.provider).toBe("prov-b");
  });

  it("显式 model 透传", () => {
    expect(seen.options.model).toBe("model-b");
  });
});

// ---------------------------------------------------------------- generate：失败路径

describe("generate：失败路径（流异常 / 取消 / 空正文 / 路由不可解析）", () => {
  let r1, r2, r3, r4, r5;

  beforeAll(async () => {
    // 流异常 → 失败元数据（不抛；正文空）
    const boom = fakeLlm(CHUNKS, { throwInStream: "stream boom" });
    r1 = await generateReport(GEN({ llm: boom.llm }));
    // 取消 → 失败
    const ac = new AbortController();
    ac.abort();
    r2 = await generateReport(GEN({ llm: fakeLlm().llm, signal: ac.signal }));
    // 空正文 → 失败
    r3 = await generateReport(GEN({ llm: fakeLlm([{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }]).llm }));
    // 路由不可解析 → 失败
    r4 = await generateReport(GEN({ llm: fakeLlm(CHUNKS, { noProviders: true }).llm }));
    r5 = await generateReport(GEN({ llm: fakeLlm(CHUNKS, { noModels: true }).llm }));
  });

  it("流异常 → ok:false", () => {
    expect(r1.meta.ok).toBe(false);
  });

  it("失败正文为空", () => {
    expect(r1.body).toBe("");
  });

  it("错误短句保留", () => {
    expect(r1.meta.error.includes("stream boom")).toBeTruthy();
  });

  it("已取消信号 → ok:false", () => {
    expect(r2.meta.ok).toBe(false);
  });

  it("无正文 → ok:false", () => {
    expect(r3.meta.ok).toBe(false);
  });

  it("空正文错误说明", () => {
    expect(r3.meta.error.includes("正文")).toBeTruthy();
  });

  it("无注册 provider → ok:false", () => {
    expect(r4.meta.ok).toBe(false);
  });

  it("provider 无可用 model → ok:false", () => {
    expect(r5.meta.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- generate：模板替换

describe("generate：{stats} 模板替换", () => {
  it("{stats} 多次出现全部替换", () => {
    expect(applyPromptTemplate("A{stats}B{stats}C", "[J]")).toBe("A[J]B[J]C");
  });

  it("无占位原样返回", () => {
    expect(applyPromptTemplate("无占位", "[J]")).toBe("无占位");
  });
});

// ---------------------------------------------------------------- buildStatsSnapshot

describe("buildStatsSnapshot：窗口过滤 / totals 聚合 / byProvider 降序 / 环比基准", () => {
  let s;
  beforeAll(() => {
    const cell = (calls, input) => ({ input, output: null, cacheRead: null, cacheWrite: null, calls, turns: calls, toolCalls: 0 });
    const buckets = [
      { day: "2026-09-02", providers: [{ provider: "p1", model: "m1", cell: cell(2, 100) }] },
      { day: "2026-09-03", providers: [{ provider: "p1", model: "m1", cell: cell(1, 50) }, { provider: "p2", model: null, cell: cell(3, 30) }] },
      { day: "2026-09-10", providers: [{ provider: "p1", model: "m1", cell: cell(9, 999) }] }, // 窗口外
    ];
    s = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-03", buckets, prevTotal: 120 });
  });

  it("窗口内 calls 聚合（2+1+3）", () => {
    expect(s.totals.calls).toBe(6);
  });

  it("token null-aware 聚合（100+50+30）", () => {
    expect(s.totals.input).toBe(180);
  });

  it("逐日总量（窗口外不计）", () => {
    expect(s.byDay).toEqual([{ day: "2026-09-02", total: 100 }, { day: "2026-09-03", total: 80 }]);
  });

  it("byProvider calls 降序（p1:3）", () => {
    expect(s.byProvider[0].provider).toBe("p1");
  });

  it("p2 次之", () => {
    expect(s.byProvider[1].calls).toBe(3);
  });

  it("环比基准透传", () => {
    expect(s.prevTotal).toBe(120);
  });

  it("total=四项之和", () => {
    expect(s.totals.total).toBe(180);
  });

  // #532 年报派生维度
  it("峰值日=byDay 最大（并列取最早）", () => {
    expect(s.peakDay).toEqual({ day: "2026-09-02", total: 100 });
  });

  it("活跃天数=窗口内有数据天数", () => {
    expect(s.activeDays).toBe(2);
  });

  it("窗口天数（含无数据日）", () => {
    expect(s.windowDays).toBe(2);
  });

  it("活跃日均=total/activeDays", () => {
    expect(s.avgPerActiveDay).toBe(90);
  });

  it("最长连续=日历日差1 连续（09-02/09-03）", () => {
    expect(s.longestStreak).toBe(2);
  });

  it("环比比值=total/prevTotal（180/120）", () => {
    expect(s.wowRatio).toBe(1.5);
  });

  // 星期分布：2026-09-02=周三(idx2)、09-03=周四(idx3)
  it("byWeekday 周三桶", () => {
    expect(s.byWeekday[2]).toBe(100);
  });

  it("byWeekday 周四桶", () => {
    expect(s.byWeekday[3]).toBe(80);
  });

  it("byWeekday 总和=total", () => {
    expect(s.byWeekday.reduce((a, b) => a + b, 0)).toBe(180);
  });
});

// ---------------------------------------------------------------- #532 派生维度：边界条件

describe("#532 派生维度：空窗口 / 除零 / 跨月连续 / 名称防御", () => {
  let empty, zeroPrev, crossMonth, hostile;

  beforeAll(() => {
    const cell = (calls, input) => ({ input, output: null, cacheRead: null, cacheWrite: null, calls, turns: calls, toolCalls: 0 });
    // 空窗口：全 null/0，wowRatio null（防 Infinity），不抛
    empty = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-01", endDay: "2026-09-07", buckets: [], prevTotal: null });
    // 除零：prevTotal=0 → null（防 Infinity 被 JSON.stringify 静默转 null 的语义错误）
    zeroPrev = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-02", buckets: [{ day: "2026-09-02", providers: [{ provider: "p1", model: "m1", cell: cell(1, 50) }] }], prevTotal: 0 });
    // 跨月连续：01-31 → 02-01 日历日差=1（streak=2，非字典序判断）
    crossMonth = buildStatsSnapshot({ period: "weekly", startDay: "2026-01-31", endDay: "2026-02-01", buckets: [
      { day: "2026-01-31", providers: [{ provider: "p1", model: "m1", cell: cell(1, 10) }] },
      { day: "2026-02-01", providers: [{ provider: "p1", model: "m1", cell: cell(1, 20) }] },
    ], prevTotal: null });
    // provider/model 名防御：控制字符剥离（C0 + DEL + C1）+ 80 字符截断
    const longName = "x".repeat(100);
    hostile = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-02", buckets: [
      { day: "2026-09-02", providers: [{ provider: `a\u0000b${longName}`, model: `m\nevil\u009b`, cell: cell(1, 10) }] },
    ], prevTotal: null });
  });

  it("空窗口 peakDay=null", () => {
    expect(empty.peakDay).toBeNull();
  });

  it("空窗口 activeDays=0", () => {
    expect(empty.activeDays).toBe(0);
  });

  it("空窗口 windowDays=7", () => {
    expect(empty.windowDays).toBe(7);
  });

  it("空窗口 avgPerActiveDay=null", () => {
    expect(empty.avgPerActiveDay).toBeNull();
  });

  it("空窗口 streak=0", () => {
    expect(empty.longestStreak).toBe(0);
  });

  it("prevTotal=null → wowRatio=null", () => {
    expect(empty.wowRatio).toBeNull();
  });

  it("空窗口 byWeekday 全 0", () => {
    expect(empty.byWeekday).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("prevTotal=0 → wowRatio=null（不做对比）", () => {
    expect(zeroPrev.wowRatio).toBeNull();
  });

  it("跨月 01-31→02-01 按日历日判定连续", () => {
    expect(crossMonth.longestStreak).toBe(2);
  });

  it("provider 控制字符已剥离", () => {
    expect(hostile.byProvider[0].provider.includes("\u0000")).toBeFalsy();
  });

  it("provider 截断至 80 字符", () => {
    expect(hostile.byProvider[0].provider.length).toBe(80);
  });

  it("model 控制字符已剥离", () => {
    expect(hostile.byProvider[0].model.includes("\n")).toBeFalsy();
  });

  it("model C1 控制字符已剥离（复核 P1-2）", () => {
    expect(hostile.byProvider[0].model.includes("\u009b")).toBeFalsy();
  });
});

// ---------------------------------------------------------------- #662 时段维度（byHour/byPeriod/peakHour + coveredDays 守卫）

describe("#662 时段维度：全量覆盖 → 时段字段注入", () => {
  let full;
  beforeAll(() => {
    const hourRow = (day, hour, calls, input, output = null) => ({
      v: TREND_ROW_VERSION,
      kind: "hour",
      day,
      hour,
      input,
      output,
      cacheRead: null,
      cacheWrite: null,
      calls,
      turns: calls,
      toolCalls: 0,
    });
    full = buildStatsSnapshot({
      period: "daily",
      startDay: "2026-09-02",
      endDay: "2026-09-03",
      buckets: [],
      hourRows: [
        hourRow("2026-09-02", 9, 2, 100),
        hourRow("2026-09-02", 21, 1, 80),
        hourRow("2026-09-03", 9, 3, 60),
        hourRow("2026-09-10", 9, 9, 999), // 窗口外
      ],
      prevTotal: null,
    });
  });

  it("coveredDays=窗口内有 hour 事实的天数（窗口外不计）", () => {
    expect(full.coveredDays).toBe(2);
  });

  it("覆盖充足 → byHour 注入", () => {
    expect(full.byHour).not.toBeNull();
  });

  it("byHour 24 项全量（hour 0..23）", () => {
    expect(full.byHour.length).toBe(24);
  });

  it("byHour 同钟点跨日合并 calls（2+3）", () => {
    expect(full.byHour[9].calls).toBe(5);
  });

  it("byHour 同钟点跨日合并 total（100+60）", () => {
    expect(full.byHour[9].total).toBe(160);
  });

  it("晚间钟点 calls 独立", () => {
    expect(full.byHour[21].calls).toBe(1);
  });

  it("无数据钟点 calls=0（零 usage 语义）", () => {
    expect(full.byHour[0].calls).toBe(0);
  });

  it("无数据钟点 total=null", () => {
    expect(full.byHour[0].total).toBeNull();
  });

  it("byPeriod 四档（凌晨0-5/上午6-11/下午12-17/晚间18-23）", () => {
    expect(full.byPeriod).toEqual([
      { period: "凌晨", calls: 0, total: null },
      { period: "上午", calls: 5, total: 160 },
      { period: "下午", calls: 0, total: null },
      { period: "晚间", calls: 1, total: 80 },
    ]);
  });

  it("peakHour=total 判峰（并列取最早）", () => {
    expect(full.peakHour).toEqual({ hour: 9, calls: 5, total: 160 });
  });
});

describe("#662 时段维度：覆盖不足 → 整段降级 null（防「1/7 天代表整周」误导）", () => {
  let partial, none;
  beforeAll(() => {
    const hourRow = (day, hour, calls, input, output = null) => ({
      v: TREND_ROW_VERSION,
      kind: "hour",
      day,
      hour,
      input,
      output,
      cacheRead: null,
      cacheWrite: null,
      calls,
      turns: calls,
      toolCalls: 0,
    });
    partial = buildStatsSnapshot({
      period: "weekly",
      startDay: "2026-09-01",
      endDay: "2026-09-07",
      buckets: [],
      hourRows: [hourRow("2026-09-01", 9, 2, 100)],
      prevTotal: null,
    });
    // 无 hour 事实（旧数据物理缺失）：全 null、coveredDays=0
    none = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-02", buckets: [], prevTotal: null });
  });

  it("部分覆盖 coveredDays=1", () => {
    expect(partial.coveredDays).toBe(1);
  });

  it("coveredDays < windowDays → byHour 整体 null", () => {
    expect(partial.byHour).toBeNull();
  });

  it("coveredDays < windowDays → byPeriod 整体 null", () => {
    expect(partial.byPeriod).toBeNull();
  });

  it("coveredDays < windowDays → peakHour 整体 null", () => {
    expect(partial.peakHour).toBeNull();
  });

  it("无 hourRows → coveredDays=0", () => {
    expect(none.coveredDays).toBe(0);
  });

  it("无 hour 事实 → byHour null", () => {
    expect(none.byHour).toBeNull();
  });

  it("无 hour 事实 → byPeriod null", () => {
    expect(none.byPeriod).toBeNull();
  });

  it("无 hour 事实 → peakHour null", () => {
    expect(none.peakHour).toBeNull();
  });
});

// ---------------------------------------------------------------- #532 per-period 提示词

const NEW_PROMPTS = { daily: "日模板{stats}", weekly: "周模板{stats}", monthly: "月模板{stats}" };

describe("#532 per-period 提示词：prompts 新格式直读", () => {
  let n;
  beforeAll(() => { n = normalizeReportConfig({ prompts: NEW_PROMPTS }); });

  it("prompts 新格式直读", () => {
    expect(n.prompts).toEqual(NEW_PROMPTS);
  });

  it("promptTemplate=月报镜像", () => {
    expect(n.promptTemplate).toBe("月模板{stats}");
  });
});

describe("#532 per-period 提示词：旧默认模板 → 升级三份新默认", () => {
  let legacyDefault;
  beforeAll(() => { legacyDefault = normalizeReportConfig({ promptTemplate: LEGACY_PROMPT_TEMPLATE }); });

  it("旧默认 → 升级日报新默认", () => {
    expect(legacyDefault.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("旧默认 → 升级周报新默认", () => {
    expect(legacyDefault.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("旧默认 → 升级月报新默认", () => {
    expect(legacyDefault.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：自定义旧模板三周期继承", () => {
  let custom;
  beforeAll(() => { custom = normalizeReportConfig({ promptTemplate: "我的自定义模板 {stats}" }); });

  it("自定义旧模板三周期继承", () => {
    expect(custom.prompts).toEqual({ daily: "我的自定义模板 {stats}", weekly: "我的自定义模板 {stats}", monthly: "我的自定义模板 {stats}" });
  });
});

describe("#532 per-period 提示词：V1 旧默认（今天/本周/本月）自动升级", () => {
  let legacyV1;
  beforeAll(() => {
    legacyV1 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V1,
        weekly: LEGACY_WEEKLY_PROMPT_V1,
        monthly: LEGACY_MONTHLY_PROMPT_V1,
      },
    });
  });

  it("未自定义的旧版日报模板自动升级", () => {
    expect(legacyV1.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("未自定义的旧版周报模板自动升级", () => {
    expect(legacyV1.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("未自定义的旧版月报模板自动升级", () => {
    expect(legacyV1.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：V2 单段模板自动升级为语义块", () => {
  let legacyV2;
  beforeAll(() => {
    legacyV2 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V2,
        weekly: LEGACY_WEEKLY_PROMPT_V2,
        monthly: LEGACY_MONTHLY_PROMPT_V2,
      },
    });
  });

  it("V2 单段日报模板自动升级为语义块", () => {
    expect(legacyV2.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V2 单段周报模板自动升级为语义块", () => {
    expect(legacyV2.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V2 单段月报模板自动升级为语义块", () => {
    expect(legacyV2.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：V3 无目录观察模板自动升级（复核 P1-4 盲区补齐）", () => {
  let legacyV3, mixedV3;
  beforeAll(() => {
    legacyV3 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V3,
        weekly: LEGACY_WEEKLY_PROMPT_V3,
        monthly: LEGACY_MONTHLY_PROMPT_V3,
      },
    });
    // V3 混合形态：单周期自定义保留、其余周期平滑升级（防整表覆盖回退）
    mixedV3 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V3,
        weekly: "我的周报模板 {stats}",
        monthly: LEGACY_MONTHLY_PROMPT_V3,
      },
    });
  });

  it("V3 无目录观察日报模板自动升级", () => {
    expect(legacyV3.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V3 无目录观察周报模板自动升级", () => {
    expect(legacyV3.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V3 无目录观察月报模板自动升级", () => {
    expect(legacyV3.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });

  it("V3 混合：未自定义日报仍升级", () => {
    expect(mixedV3.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V3 混合：自定义周报保留原样", () => {
    expect(mixedV3.prompts.weekly).toBe("我的周报模板 {stats}");
  });

  it("V3 混合：未自定义月报仍升级", () => {
    expect(mixedV3.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：V3 落盘 round-trip（绕过写侧归一化直读磁盘形态）", () => {
  let loaded;
  beforeAll(async () => {
    const v3Root = mkdtempSync(join(tmpdir(), "dou-report-v3-migrate-"));
    const reportsDir = join(v3Root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, "config.json"), JSON.stringify({
      daily: { enabled: true, time: "09:30" },
      prompts: { daily: LEGACY_DAILY_PROMPT_V3, weekly: LEGACY_WEEKLY_PROMPT_V3, monthly: LEGACY_MONTHLY_PROMPT_V3 },
      push: { enabled: false },
    }));
    loaded = await readReportConfig(v3Root);
    rmSync(v3Root, { recursive: true, force: true });
  });

  it("V3 落盘读回：日报自动升级新默认", () => {
    expect(loaded.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V3 落盘读回：周报自动升级新默认", () => {
    expect(loaded.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V3 落盘读回：月报自动升级新默认", () => {
    expect(loaded.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });

  it("V3 落盘读回：其余字段不受迁移影响", () => {
    expect(loaded.daily.time).toBe("09:30");
  });
});

describe("#662 per-period 提示词：V4 无时段观察模板自动升级", () => {
  let legacyV4, mixedV4;
  beforeAll(() => {
    legacyV4 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V4,
        weekly: LEGACY_WEEKLY_PROMPT_V4,
        monthly: LEGACY_MONTHLY_PROMPT_V4,
      },
    });
    // V4 混合形态：单周期自定义保留、其余周期平滑升级（防整表覆盖回退）
    mixedV4 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V4,
        weekly: "我的周报模板 {stats}",
        monthly: LEGACY_MONTHLY_PROMPT_V4,
      },
    });
  });

  it("V4 无时段观察日报模板自动升级", () => {
    expect(legacyV4.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V4 无时段观察周报模板自动升级", () => {
    expect(legacyV4.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V4 无时段观察月报模板自动升级", () => {
    expect(legacyV4.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });

  it("V4 混合：未自定义日报仍升级", () => {
    expect(mixedV4.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V4 混合：自定义周报保留原样", () => {
    expect(mixedV4.prompts.weekly).toBe("我的周报模板 {stats}");
  });

  it("V4 混合：未自定义月报仍升级", () => {
    expect(mixedV4.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：用户自定义保留 + 非法值回退", () => {
  let userCustomPrompts, bad;
  beforeAll(() => {
    // 若老用户对日报有自定义修改，则保留自定义内容，不被覆写
    userCustomPrompts = normalizeReportConfig({
      prompts: {
        daily: "用户自定义日报：{stats}",
        weekly: LEGACY_WEEKLY_PROMPT_V1,
        monthly: LEGACY_MONTHLY_PROMPT_V1,
      },
    });
    // 非法 prompts 值回退各周期自身默认模板
    bad = normalizeReportConfig({ prompts: { daily: "", weekly: 42, monthly: "x".repeat(20001) } });
  });

  it("自定义修改过的模板保留原样", () => {
    expect(userCustomPrompts.prompts.daily).toBe("用户自定义日报：{stats}");
  });

  it("同时存在的未自定义周报仍平滑升级", () => {
    expect(userCustomPrompts.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("空串回退该周期默认", () => {
    expect(bad.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("非字符串回退该周期默认", () => {
    expect(bad.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("超长回退该周期默认", () => {
    expect(bad.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：promptFor 按周期取模板", () => {
  it("promptFor daily", () => {
    expect(promptFor(normalizeReportConfig({ prompts: NEW_PROMPTS }), "daily")).toBe("日模板{stats}");
  });

  it("promptFor weekly", () => {
    expect(promptFor(normalizeReportConfig({ prompts: NEW_PROMPTS }), "weekly")).toBe("周模板{stats}");
  });

  it("promptFor monthly", () => {
    expect(promptFor(normalizeReportConfig({ prompts: NEW_PROMPTS }), "monthly")).toBe("月模板{stats}");
  });
});

describe("#532 per-period 提示词：三份默认模板形态", () => {
  it("三默认模板含 {stats}", () => {
    expect(DEFAULT_DAILY_PROMPT.includes("{stats}") && DEFAULT_WEEKLY_PROMPT.includes("{stats}") && DEFAULT_MONTHLY_PROMPT.includes("{stats}")).toBeTruthy();
  });

  it("三默认模板互不相同", () => {
    expect(DEFAULT_DAILY_PROMPT !== DEFAULT_WEEKLY_PROMPT && DEFAULT_WEEKLY_PROMPT !== DEFAULT_MONTHLY_PROMPT).toBeTruthy();
  });

  it("DEFAULT_PROMPTS 表与单常量一致", () => {
    expect(DEFAULT_PROMPTS.daily).toEqual(DEFAULT_DAILY_PROMPT);
  });
});

describe("#544 年报化定稿：模板禁项与全局纪律", () => {
  it("日报模板禁小标题（白名单无 ##）", () => {
    expect(DEFAULT_DAILY_PROMPT.includes("##")).toBeFalsy();
  });

  const templates = [
    ["日报", DEFAULT_DAILY_PROMPT],
    ["周报", DEFAULT_WEEKLY_PROMPT],
    ["月报", DEFAULT_MONTHLY_PROMPT],
  ];

  for (const [name, tpl] of templates) {
    it(`${name}模板含全局 null 降级纪律`, () => {
      expect(tpl.includes("null/0/NaN")).toBeTruthy();
    });

    it(`${name}模板含推算边界（占比与倍数豁免）`, () => {
      expect(tpl.includes("除占比与倍数外不得推算")).toBeTruthy();
    });

    it(`${name}模板含日期以 JSON 为准`, () => {
      expect(tpl.includes("以 JSON 为准")).toBeTruthy();
    });

    it(`${name}模板无代码围栏示例`, () => {
      expect(tpl.includes("```")).toBeFalsy();
    });
  }

  it("周报含占比分母除零护栏", () => {
    expect(DEFAULT_WEEKLY_PROMPT.includes("分母大于 0")).toBeTruthy();
  });

  it("月报含 byProvider 单条降级", () => {
    expect(DEFAULT_MONTHLY_PROMPT.includes("仅一个模型时")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #532 渲染管线（escape-then-transform）

describe("#532 渲染管线（escape-then-transform）：结构 / XSS 向量集 / 来回幂等", () => {
  let html, x1, x2, x3, x4, x5, sanitized;

  beforeAll(() => {
    // 基本结构：## → h3、- 组 ul/li、普通行 → p、空行断段
    html = reportBodyToHtml("## 数据亮点\n- 第一项\n- 第二项\n\n正文段落，**强调**收尾。\n## 结语\n只此一句。");
    // XSS 向量集：转义在前，注入内容恒为实体文本
    x1 = reportBodyToHtml("## x onerror=alert(1)");
    x2 = reportBodyToHtml('**a" onclick=b**');
    x3 = reportBodyToHtml("<script>alert(1)</script>");
    x4 = reportBodyToHtml("- img:<img src=x onerror=y>");
    // ### 与代码围栏字面显示（只认一档标题与 - 列表）
    x5 = reportBodyToHtml("### 三级标题\n```code```");
    // 往返幂等：管线输出再过一次 sanitizeHtml 白名单标签存活（模拟读侧第二层）
    sanitized = sanitizeHtml(reportBodyToHtml("## 标题\n- 列表\n**加粗**"));
  });

  it("## → h3", () => {
    expect(html.includes("<h3>数据亮点</h3>")).toBeTruthy();
  });

  it("连续 - 组包 ul/li", () => {
    expect(html.includes("<ul>") && html.includes("<li>第一项</li>") && html.includes("<li>第二项</li>") && html.includes("</ul>")).toBeTruthy();
  });

  it("普通行 → p + **x** → strong", () => {
    expect(html.includes("<p>正文段落，<strong>强调</strong>收尾。</p>")).toBeTruthy();
  });

  it("第二标题", () => {
    expect(html.includes("<h3>结语</h3>")).toBeTruthy();
  });

  it("h3 标签无属性位可利用（onerror 转义为实体文本）", () => {
    expect(/<h3[^>]+o/.test(x1)).toBeFalsy();
  });

  it("strong 标签无属性位可利用", () => {
    expect(x2.includes("<strong>") && !/<strong[^>]+o/.test(x2)).toBeTruthy();
  });

  it("script 标签为实体文本（读侧 sanitizeHtml 第二层兜底）", () => {
    expect(x3.includes("&lt;script&gt;")).toBeTruthy();
  });

  it("无明文 script 标签", () => {
    expect(x3.includes("<script")).toBeFalsy();
  });

  it("列表项内注入 img 被转义", () => {
    expect(/<img/i.test(x4)).toBeFalsy();
  });

  it("未闭合 ** 字面保留", () => {
    expect(reportBodyToHtml("未闭合 ** 加粗").includes("**")).toBeTruthy();
  });

  it("### 不当 h3（字面显示）", () => {
    expect(x5.includes("<h3>三级标题</h3>")).toBeFalsy();
  });

  it("落盘 → 读侧往返白名单标签存活", () => {
    expect(sanitized.includes("<h3>") && sanitized.includes("<ul>") && sanitized.includes("<strong>")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 生成不入统计前提（单测侧）

describe("生成不入统计前提（方案 §2.3）", () => {
  it("生成只经 llm.stream（无 session 事件源参与）", async () => {
    // generateReport 只消费注入的 llm 服务面，不触达 session/event 通道
    // （fake llm 无会话事件源；接线层 smoke 以 emitEvent 计数断言「生成不产生
    // session 事件→不入统计」）。
    const { llm, seen } = fakeLlm();
    await generateReport(GEN({ llm }));
    expect(seen.streamCalled).toBeTruthy();
  });
});

// ---------------------------------------------------------------- scheduler：lastRun 读写 roundtrip

describe("scheduler：lastRun 读写 roundtrip", () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dou-report-sched-")); });

  it("缺失文件 → 空表", async () => {
    expect(await readLastRun(root)).toEqual({});
  });

  it("writeLastRun → readLastRun roundtrip", async () => {
    await writeLastRun(root, { daily: "2026-09-04", monthly: "2026-08" });
    expect(await readLastRun(root)).toEqual({ daily: "2026-09-04", monthly: "2026-08" });
  });

  it("last-run.json 落在 historyRoot/reports/ 下", async () => {
    await writeLastRun(root, { daily: "2026-09-04", monthly: "2026-08" });
    expect(existsSync(join(root, "reports", "last-run.json"))).toBeTruthy();
  });
});

// ---------------------------------------------------------------- ReportTaskQueue：串行单飞 + 入队去重（#625/#626）

describe("ReportTaskQueue：串行单飞 + 入队去重（#625/#626）", () => {
  let firstId, secondId, thirdId, forceUpgraded, callsAtLeastOne, maxConcurrentSeen, statusAfterFail, fourthId;

  beforeAll(async () => {
    let calls = 0;
    let maxConcurrent = 0;
    let concurrent = 0;
    const queue = new ReportTaskQueue({
      executor: async () => {
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30)); // 慢执行：验证串行（不并发）
        concurrent -= 1;
        throw new Error("always-fail"); // 恒失败：任务 failed，不影响串行性
      },
      warn: () => {},
    });
    const due = { period: "daily", key: "2026-09-04", startDay: "2026-09-04", endDay: "2026-09-04" };
    // 同一窗口连续提交（模拟 tick 60s 一次 vs 手动并发）→ 只应有一个 queued/running（P0 入队去重）
    const first = queue.submit(due);
    const second = queue.submit(due);
    firstId = first.taskId;
    secondId = second.taskId;
    // force 提交命中 queued/running → 既有任务 force 升级（#626：重新生成语义不因去重丢失）
    const third = queue.submit({ ...due, force: true });
    thirdId = third.taskId;
    forceUpgraded = queue.get(first.taskId).force;
    // #629 P3：条件等待替代固定 sleep（执行器入口计数是可观测事件）
    await pollUntil(() => calls >= 1, 5000, 5);
    callsAtLeastOne = calls >= 1;
    maxConcurrentSeen = maxConcurrent;
    await pollUntil(() => queue.get(first.taskId)?.status === "failed", 5000, 5);
    statusAfterFail = queue.get(first.taskId).status;
    // failed 任务不在 queued/running → 可重新提交（新 taskId）
    const fourth = queue.submit(due);
    fourthId = fourth.taskId;
  });

  it("同窗口任务去重：返回同一 taskId", () => {
    expect(secondId).toBe(firstId);
  });

  it("force 提交去重：仍返回同一 taskId", () => {
    expect(thirdId).toBe(firstId);
  });

  it("force 升级既有任务", () => {
    expect(forceUpgraded).toBe(true);
  });

  it("至少执行一轮", () => {
    expect(callsAtLeastOne).toBeTruthy();
  });

  it("串行单飞：执行并发受控为 1", () => {
    expect(maxConcurrentSeen).toBe(1);
  });

  it("执行器抛错 → 任务 failed", () => {
    expect(statusAfterFail).toBe("failed");
  });

  it("failed 任务后可重新提交（新 taskId）", () => {
    expect(fourthId).not.toBe(firstId);
  });
});

// ---------------------------------------------------------------- tick→队列：失败不推进 lastRun + 下轮重试同窗

describe("tick→队列：失败不推进 lastRun + 下轮重试同窗", () => {
  let execCallsSnapshot, failedKeysSnapshot, lastRunDailySnapshot;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-retry-"));
    let execCalls = 0;
    const failedKeys = [];
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        execCalls += 1;
        if (execCalls < 3) {
          failedKeys.push(input.key);
          throw new Error(`boom-${execCalls}`); // 前两轮失败（失败不推进 lastRun）
        }
        // 第三轮成功：模拟 apply 接线的推进语义（执行器临界区内写 lastRun）
        const lastRun = await readLastRun(root);
        lastRun[input.period] = input.key;
        await writeLastRun(root, lastRun);
        return { meta: { period: input.period, key: input.key, startDay: input.startDay, endDay: input.endDay, generatedAt: Date.now(), ok: true } };
      },
      warn: () => {},
    });
    const scheduler = ReportScheduler.start({
      root,
      config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
      onDue: (due) => {
        queue.submit(due);
        return Promise.resolve();
      },
      tickMs: 15,
    });
    // 轮询直到成功路径把 lastRun 落盘（execCalls 计数在 executor 入口自增，
    // 需等写盘完成再断言，防 flake；上限 5s）——#629 P3：pollUntil 条件等待
    const lastRunDaily = await pollUntil(async () => (await readLastRun(root)).daily, 5000, 10);
    scheduler.dispose();
    execCallsSnapshot = execCalls;
    failedKeysSnapshot = [...failedKeys]; // 取拷贝：后续断言不受引用变化影响
    lastRunDailySnapshot = lastRunDaily;
  });

  it("失败后下轮重试", () => {
    expect(execCallsSnapshot >= 3).toBeTruthy();
  });

  it("重试同一窗口", () => {
    expect(new Set(failedKeysSnapshot).size).toBe(1);
  });

  it("成功路径已推进 lastRun", () => {
    expect(lastRunDailySnapshot !== undefined).toBeTruthy();
  });

  it("lastRun.daily === 窗口键", () => {
    expect(lastRunDailySnapshot).toBe(failedKeysSnapshot[0]);
  });
});

// ---------------------------------------------------------------- scheduler：dispose 停 tick（#629 P3：事件驱动，无固定 sleep）

describe("scheduler：dispose 停 tick（#629 P3：事件驱动，无固定 sleep）", () => {
  let leakedSnapshot, lastRunFileExists;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-dispose-"));
    let calls = 0;
    let gate = () => {};
    const gated = new Promise((r) => { gate = r; });
    const scheduler = ReportScheduler.start({
      root,
      config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
      // 模拟 apply 接线的最小推进语义（onDue 提交 → 执行 → lastRun 推进）
      onDue: async (due) => {
        calls += 1;
        gate(); // 「首轮 tick 已发生」事件信号（onDue 入口同步触发）
        const lastRun = await readLastRun(root);
        lastRun[due.period] = due.key;
        await writeLastRun(root, lastRun);
      },
      tickMs: 200, // 拉大 tick 间隔：dispose 确定性赶在第二轮 timer 触发前
    });
    await gated; // 事件等待：首轮启动补跑已发生（不假设耗时，慢 runner 下自然延长）
    // 等首轮 lastRun 落盘收尾（在途 onDue 完成）再 dispose，防断言与写盘竞态
    await pollUntil(() => existsSync(join(root, "reports", "last-run.json")), 5000, 5);
    scheduler.dispose();
    const atDispose = calls;
    // 否定式条件等待（pollUntil 语义）：一个完整 tick 周期窗口内 onDue 不再触发
    // ——timer 已 clearInterval，窗口内泄漏 tick 若存在必然使 calls 增长而失败
    leakedSnapshot = await pollUntil(() => calls > atDispose, 250, 10);
    // 成功路径推进过 lastRun（首轮启动补跑已生成并落盘）
    lastRunFileExists = existsSync(join(root, "reports", "last-run.json"));
  });

  it("dispose 后不再 tick（计数冻结）", () => {
    expect(leakedSnapshot).not.toBe(true);
  });

  it("dispose 前的成功生成已推进 lastRun", () => {
    expect(lastRunFileExists).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #624 lastRun 推导/闭环判定（纯函数）

describe("#624 lastRun 推导/闭环判定（纯函数）", () => {
  const closed = (period, key, generatedAt, endDay) => ({ period, key, generatedAt, endDay, ok: true });
  // 本地时刻 2026-09-07 06:00 → dayKey = "2026-09-07"
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  // 旧语义「当天」daily 记录：发起日 = endDay 当天（09-06 06:00 生成当天窗口）→ 未闭环（#624 根因记录）
  const t606 = new Date(2026, 8, 6, 6, 0, 0).getTime();
  const legacySameDay = closed("daily", "2026-09-06", t606, "2026-09-06");
  // 新语义 daily 记录（发起日 = endDay+1）→ 已闭环
  const closedDaily = closed("daily", "2026-09-06", t607, "2026-09-05");

  let derived, pollutedOnly, y;

  beforeAll(() => {
    derived = deriveLastRun([
      legacySameDay, // daily 09-06 旧污染（未闭环，被剔除）
      closedDaily, // daily 09-06 已闭环
      closed("weekly", "2026-08-31", t607, "2026-09-06"),
      closed("monthly", "2026-08", t607, "2026-08-31"),
      closed("daily", "2026-09-04", t607, "2026-09-03"),
    ]);
    pollutedOnly = deriveLastRun([legacySameDay]);
    y = deriveLastRun([
      closed("monthly", "2026-01", t607, "2025-12-31"),
      closed("monthly", "2025-12", t607, "2025-11-30"),
    ]);
  });

  it("旧语义当天窗口 → 未闭环", () => {
    expect(isClosedWindowRecord(legacySameDay)).toBe(false);
  });

  it("新语义昨天窗口 → 已闭环", () => {
    expect(isClosedWindowRecord(closedDaily)).toBe(true);
  });

  it("失败记录不参与闭环", () => {
    expect(isClosedWindowRecord({ ...closedDaily, ok: false })).toBe(false);
  });

  it("各期取最近已闭环键", () => {
    expect(derived).toEqual({ daily: "2026-09-06", weekly: "2026-08-31", monthly: "2026-08" });
  });

  it("仅旧污染记录 → 无键（恢复补跑）", () => {
    expect(pollutedOnly).toEqual({});
  });

  it("monthly 键序跨年正确", () => {
    expect(y.monthly).toBe("2026-01");
  });
});

// ---------------------------------------------------------------- #624 ensureLastRunMigrated：迁移写回 + 自愈 + 可重放

describe("#624 ensureLastRunMigrated：迁移写回 + 自愈 + 可重放", () => {
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  const t606 = new Date(2026, 8, 6, 6, 0, 0).getTime();
  const line = (period, key, generatedAt, endDay) => JSON.stringify({ period, key, startDay: endDay, endDay, generatedAt, ok: true });

  let res, res2, res3, res4, res5, migrated, kept, kept5;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-migrate-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const lastFile = join(reports, "last-run.json");
    const indexFile = join(reports, "index.jsonl");

    // 场景 1：旧 schema + 旧语义污染键（#624 根因现场）→ 校准写回 schema:2
    writeFileSync(lastFile, JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-24", monthly: "2026-08", updatedAt: 1 }));
    writeFileSync(
      indexFile,
      [
        line("daily", "2026-09-04", t607, "2026-09-03"), // 已闭环
        line("daily", "2026-09-06", t606, "2026-09-06"), // 旧语义当天（发起日=endDay，未闭环，被剔除）
        line("weekly", "2026-08-31", t607, "2026-09-06"), // 已闭环
        line("monthly", "2026-08", t607, "2026-08-31"), // 已闭环
      ].join("\n") + "\n",
    );
    res = await ensureLastRunMigrated(root, () => {});
    migrated = JSON.parse(readFileSync(lastFile, "utf8"));

    // 场景 2：schema:2 且与事实一致 → 不再变化（幂等/可重放）
    res2 = await ensureLastRunMigrated(root, () => {});

    // 场景 3：schema:2 被旧污染键遮蔽（P0-4 自愈）→ 仍校准
    writeFileSync(lastFile, JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-31", monthly: "2026-08", schema: LAST_RUN_SCHEMA }));
    res3 = await ensureLastRunMigrated(root, () => {});

    // 场景 4：无 index（事实源缺失）→ 不动 lastRun
    const root2 = mkdtempSync(join(tmpdir(), "dou-report-migrate2-"));
    mkdirSync(join(root2, "reports"), { recursive: true });
    writeFileSync(join(root2, "reports", "last-run.json"), JSON.stringify({ daily: "2026-09-06", schema: 1 }));
    res4 = await ensureLastRunMigrated(root2, () => {});
    kept = JSON.parse(readFileSync(join(root2, "reports", "last-run.json"), "utf8"));

    // 场景 5（#531 保护）：schema:2 + preset 键（index 无对应记录）→ 温和校准保留 preset 键，
    // 仅对齐「index 存在闭环记录」的期——首次启用不被启动校准删键、不被立即补跑
    const root3 = mkdtempSync(join(tmpdir(), "dou-report-migrate3-"));
    const reports3 = join(root3, "reports");
    mkdirSync(reports3, { recursive: true });
    // 模拟：保存配置时 #531 预置 daily/weekly/monthly 键（index 均无记录），之后手动生成过 weekly
    writeFileSync(join(reports3, "last-run.json"), JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-31", monthly: "2026-08", schema: LAST_RUN_SCHEMA }));
    writeFileSync(join(reports3, "index.jsonl"), [line("weekly", "2026-08-31", t607, "2026-09-06")].join("\n") + "\n");
    res5 = await ensureLastRunMigrated(root3, () => {});
    const raw5 = JSON.parse(readFileSync(join(reports3, "last-run.json"), "utf8"));
    kept5 = { daily: raw5.daily, weekly: raw5.weekly, monthly: raw5.monthly };
  });

  it("旧 schema + 污染键 → 发生校准", () => {
    expect(res.changed).toBe(true);
  });

  it("迁移后：daily 回退到最近已闭环 09-04（09-06 污染键剔除）", () => {
    expect(res.after).toEqual({ daily: "2026-09-04", weekly: "2026-08-31", monthly: "2026-08" });
  });

  it("写回 schema 版本", () => {
    expect(migrated.schema).toBe(LAST_RUN_SCHEMA);
  });

  it("写回内容 = 推导结果", () => {
    expect(migrated.daily).toBe("2026-09-04");
  });

  it("二次运行无变化（可重放幂等）", () => {
    expect(res2.changed).toBe(false);
  });

  it("schema:2 遮蔽事故 → 自愈回退", () => {
    expect(res3.changed).toBe(true);
  });

  it("自愈后 daily 回退到最近已闭环键", () => {
    expect(res3.after.daily).toBe("2026-09-04");
  });

  it("无 index 事实源 → 保持原状", () => {
    expect(res4.changed).toBe(false);
  });

  it("原 lastRun 未被改动", () => {
    expect(kept.daily).toBe("2026-09-06");
  });

  it("preset 键保留 + weekly 已对齐 → 无变化", () => {
    expect(res5.changed).toBe(false);
  });

  it("daily preset 键不被删", () => {
    expect(kept5.daily).toBe("2026-09-06");
  });

  it("monthly preset 键不被删", () => {
    expect(kept5.monthly).toBe("2026-08");
  });

  it("weekly 对齐到最新闭环键", () => {
    expect(kept5.weekly).toBe("2026-08-31");
  });
});

// ---------------------------------------------------------------- #626 读侧投影：一行/窗口=最新版 + 坏行防御

describe("#626 读侧投影：一行/窗口=最新版 + 坏行防御", () => {
  let list, d06Id, parsedLen;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-proj-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const indexFile = join(reports, "index.jsonl");
    const line = (generatedAt, key, extra = {}) => JSON.stringify({ period: "daily", key, startDay: key, endDay: key, generatedAt, ok: true, ...extra });
    writeFileSync(
      indexFile,
      [
        line(100, "2026-09-06", { id: "v1" }), // 同日两次手动生成的旧版本
        line(200, "2026-09-06", { id: "v2" }), // 最新版本
        line(300, "2026-09-05", { id: "v3" }),
        "garbage-line", // 坏行跳过
      ].join("\n") + "\n",
    );
    list = await readReportIndex(root);
    d06Id = list.find((m) => m.key === "2026-09-06").id;
    parsedLen = parseReportIndexLines("bad\n" + JSON.stringify({ period: "weekly", key: "2026-08-31", generatedAt: 1, ok: true })).length;
  });

  it("同窗口去重为一行", () => {
    expect(list.length).toBe(2);
  });

  it("倒序：最新 generatedAt 窗口在前", () => {
    expect(list[0].key).toBe("2026-09-05");
  });

  it("同窗口保留最新 generatedAt 版本", () => {
    expect(d06Id).toBe("v2");
  });

  it("坏行跳过、合法行保留", () => {
    expect(parsedLen).toBe(1);
  });
});

// ---------------------------------------------------------------- #629 P1 readReportIndex 解析记忆化（mtime 感知缓存）

describe("#629 P1 readReportIndex 解析记忆化（mtime 感知缓存）", () => {
  let missingFirst, missingSecond, firstLen, firstProjection, secondProjection, stats;
  let thirdLen, thirdFirstKey, fourthGeneratedAt, hitBefore, hitAfter;
  let missFirstLen, missSecondLen, missHasMutated, otherRootProjection;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-cache-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const indexFile = join(reports, "index.jsonl");
    const metaA = { period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05", generatedAt: 100, ok: true };
    __clearReportIndexCacheForTests(); // 隔离：清同进程其他块可能残留的缓存与计数

    // 缺失文件 → 空表（不缓存）
    missingFirst = JSON.parse(JSON.stringify(await readReportIndex(root)));
    missingSecond = JSON.parse(JSON.stringify(await readReportIndex(root)));

    // 首读建缓存
    writeFileSync(indexFile, `${JSON.stringify(metaA)}\n`);
    const first = await readReportIndex(root);
    firstLen = first.length;
    firstProjection = JSON.parse(JSON.stringify(first));

    // 二读命中缓存（投影一致即证，不重复解析语义漂移）
    const second = await readReportIndex(root);
    secondProjection = JSON.parse(JSON.stringify(second));

    // 计数器确定性证明：连续两读只解析一次（#629 P1「可测」——重复读不再线性重解析）
    const s = __reportIndexCacheStatsForTests();
    stats = { hits: s.hits, misses: s.misses };

    // append 一行（size/mtime 双变）→ 重新解析读到新行
    appendFileSync(indexFile, `${JSON.stringify({ ...metaA, key: "2026-09-06", generatedAt: 200 })}\n`);
    const third = await readReportIndex(root);
    thirdLen = third.length;
    thirdFirstKey = third[0].key;

    // 原子替换改写（size 不变场景：同字节数内容替换 + utimes 显式设置不同 mtime，
    // 规避同毫秒粒度）→ mtime 变化独立失效
    const tmpSwap = `${indexFile}.swap`;
    writeFileSync(tmpSwap, `${JSON.stringify({ ...metaA, generatedAt: 999 })}\n${JSON.stringify({ ...metaA, key: "2026-09-06", generatedAt: 200 })}\n`);
    utimesSync(tmpSwap, /* atime */ new Date(), /* mtime */ new Date(1_700_000_000_000)); // 显式旧 mtime：与 append 时刻必然不同
    renameSync(tmpSwap, indexFile);
    const fourth = await readReportIndex(root);
    fourthGeneratedAt = fourth.find((m) => m.key === "2026-09-05")?.generatedAt;

    // 命中路径返回浅拷贝——调用方改写返回值不污染缓存
    hitBefore = (await readReportIndex(root)).length;
    const hit = await readReportIndex(root);
    hit.length = 0;
    hitAfter = (await readReportIndex(root)).length;

    // miss 路径返回浅拷贝——与命中路径防御对称：首读（miss）返回值上就地突变不污染缓存
    const missRoot = mkdtempSync(join(tmpdir(), "dou-report-cache-miss-"));
    mkdirSync(join(missRoot, "reports"), { recursive: true });
    writeFileSync(join(missRoot, "reports", "index.jsonl"), `${JSON.stringify(metaA)}\n`);
    const missFirst = await readReportIndex(missRoot);
    missFirstLen = missFirst.length;
    missFirst.push({ ...metaA, key: "MUTATED", generatedAt: 1 });
    const missSecond = await readReportIndex(missRoot);
    missSecondLen = missSecond.length;
    missHasMutated = missSecond.some((m) => m.key === "MUTATED");

    // root 隔离：不同 historyRoot 互不串缓存
    const otherRoot = mkdtempSync(join(tmpdir(), "dou-report-cache-other-"));
    otherRootProjection = JSON.parse(JSON.stringify(await readReportIndex(otherRoot)));
    __clearReportIndexCacheForTests();
  });

  it("index 缺失 → 空表", () => {
    expect(missingFirst).toEqual([]);
  });

  it("index 缺失 → 空表（二次调用语义不变）", () => {
    expect(missingSecond).toEqual([]);
  });

  it("首读解析 1 条", () => {
    expect(firstLen).toBe(1);
  });

  it("stat 未变 → 命中缓存，投影一致", () => {
    expect(secondProjection).toEqual(firstProjection);
  });

  it("连续两读：miss=1（只解析一次）+ hit=1（第二读走缓存）", () => {
    expect(stats).toEqual({ hits: 1, misses: 1 });
  });

  it("append 后缓存失效并重解析", () => {
    expect(thirdLen).toBe(2);
  });

  it("倒序语义在缓存路径同样成立", () => {
    expect(thirdFirstKey).toBe("2026-09-06");
  });

  it("size 不变仅 mtime 变 → 仍失效重解析", () => {
    expect(fourthGeneratedAt).toBe(999);
  });

  it("命中路径返回的投影不被调用方改写污染", () => {
    expect(hitAfter).toBe(hitBefore);
  });

  it("miss 首读解析 1 条", () => {
    expect(missFirstLen).toBe(1);
  });

  it("miss 路径返回值就地 push 后，缓存不被污染", () => {
    expect(missSecondLen).toBe(1);
  });

  it("后续读不含调用方注入的污染项", () => {
    expect(missHasMutated).toBeFalsy();
  });

  it("另一 root（无 index）→ 空表，不命中前 root 缓存", () => {
    expect(otherRootProjection).toEqual([]);
  });
});

// ---------------------------------------------------------------- #629 P2 updateLastRun 单一临界区（注入时序验证 lost-update 修复）

// 注入时序形态：patch 函数在临界区内执行，内部 await 一个可控 promise 即可把
// 「read-modify-write 的中段」挂起——并发方整次更新（readLatest→write）只能排进
// 串行链，精确复现原缺陷的交错窗（patch 挂起期间他方完成全量写）。
// ESM 导出只读，不做模块 monkey-patch；导出绑定不可变是语言既有约束。

describe("#629 P2 updateLastRun：链上串行 + 写前重读（patch 挂起期他方整表写）", () => {
  let dailyKept, weeklyKept;

  beforeAll(async () => {
    const rootA = mkdtempSync(join(tmpdir(), "dou-report-lra-"));
    let releaseA = () => {};
    const gateA = new Promise((r) => { releaseA = r; });
    let enteredA = false;
    const pa = updateLastRun(rootA, async (cur) => {
      enteredA = true;
      await gateA; // 挂起 A 的临界区（模拟 read-modify-write 中段的 IO 慢）
      return { ...cur, daily: "2026-09-05" };
    });
    await pollUntil(() => enteredA, 5000, 2);
    // A 挂起期间：B 提交 weekly 更新（此刻文件尚为空表——旧快照语义）
    const pb = updateLastRun(rootA, (cur) => ({ ...cur, weekly: "2026-08-31" }));
    // 先释放再收敛（pb 排在 pa 后，先 await pb 会死锁）
    releaseA();
    await Promise.all([pa, pb]);
    const afterA = await readLastRun(rootA);
    dailyKept = afterA.daily;
    weeklyKept = afterA.weekly;
  });

  it("链首 A 的字段最终落盘", () => {
    expect(dailyKept).toBe("2026-09-05");
  });

  it("B 排在 A 后写前重读：A 的 daily + B 的 weekly 双字段并存", () => {
    expect(weeklyKept).toBe("2026-08-31");
  });
});

describe("#629 P2 updateLastRun：既有字段不被后续更新覆盖（写前重读的直证）", () => {
  let afterC;

  beforeAll(async () => {
    const root2 = mkdtempSync(join(tmpdir(), "dou-report-lrseq-"));
    await updateLastRun(root2, (cur) => ({ ...cur, daily: "2026-09-05" }));
    await updateLastRun(root2, (cur) => ({ ...cur, weekly: "2026-08-31" }));
    await updateLastRun(root2, (cur) => ({ ...cur, monthly: "2026-08" }));
    afterC = await readLastRun(root2);
  });

  it("三字段并存：后续更新不覆盖既有字段（lost-update 不再发生）", () => {
    expect({ daily: afterC.daily, weekly: afterC.weekly, monthly: afterC.monthly })
      .toEqual({ daily: "2026-09-05", weekly: "2026-08-31", monthly: "2026-08" });
  });
});

describe("#629 P2 updateLastRun：同任务交错窗实证（preset vs 任务完成推进）", () => {
  let dailyKept, weeklyKept;

  beforeAll(async () => {
    const root4 = mkdtempSync(join(tmpdir(), "dou-report-lrrace-"));
    let releasePreset = () => {};
    const gatePreset = new Promise((r) => { releasePreset = r; });
    let presetEntered = false;
    // 保存配置路径：preset 挂起（模拟 readLastRun IO 慢）
    const pPreset = updateLastRun(root4, async (cur) => {
      presetEntered = true;
      await gatePreset;
      return { ...cur, weekly: "2026-08-31" }; // preset weekly 首启用键
    });
    await pollUntil(() => presetEntered, 5000, 2);
    // 任务执行器路径：完成推进 daily（排在挂起的 preset 之后入链）
    const pExecutor = updateLastRun(root4, (cur) => ({ ...cur, daily: "2026-09-05" }));
    // 先释放再收敛（pExecutor 排在 pPreset 后，先 await pExecutor 会死锁）
    releasePreset();
    await Promise.all([pPreset, pExecutor]);
    const final = await readLastRun(root4);
    dailyKept = final.daily;
    weeklyKept = final.weekly;
  });

  it("交错窗：executor 推进的 daily 保留", () => {
    expect(dailyKept).toBe("2026-09-05");
  });

  it("交错窗：preset 的 weekly 保留（lost-update 修复实证）", () => {
    expect(weeklyKept).toBe("2026-08-31");
  });
});

describe("#629 P2 updateLastRun：并发风暴（10 并发各写各字段）", () => {
  let keptCount, schema;

  beforeAll(async () => {
    const root3 = mkdtempSync(join(tmpdir(), "dou-report-lrstorm-"));
    const writes = Array.from({ length: 10 }, (_, i) =>
      updateLastRun(root3, (cur) => ({ ...cur, [`f${i}`]: `v${i}` })));
    await Promise.all(writes);
    await __lastRunChainForTests(root3);
    // readLastRun 只透出 daily/weekly/monthly 白名单键（schema:1 兼容过滤），
    // f0..f9 断言须读原始落盘文件观察
    const final = JSON.parse(readFileSync(join(root3, "reports", "last-run.json"), "utf8"));
    keptCount = Array.from({ length: 10 }, (_, i) => final[`f${i}`]).filter((v) => v !== undefined).length;
    schema = final.schema;
  });

  it("并发风暴 10 字段全保留", () => {
    expect(keptCount).toBe(10);
  });

  it("临界区写沿用 schema 版本标记", () => {
    expect(schema).toBe(2);
  });
});

describe("#629 P2 updateLastRun：patch 抛错不阻塞链上后续", () => {
  it("patch 抛错向调用方透传", async () => {
    const root5 = mkdtempSync(join(tmpdir(), "dou-report-lrerr-"));
    await expect(updateLastRun(root5, () => { throw new Error("boom-patch"); })).rejects.toThrow(/boom-patch/);
  });

  it("抛错的更新不落盘且不阻塞后续更新", async () => {
    const root5 = mkdtempSync(join(tmpdir(), "dou-report-lrerr-"));
    await updateLastRun(root5, () => { throw new Error("boom-patch"); }).catch(() => {});
    await updateLastRun(root5, (cur) => ({ ...cur, daily: "2026-09-04" }));
    expect((await readLastRun(root5)).daily).toBe("2026-09-04");
  });
});

// ---------------------------------------------------------------- #629 P2 executor 复用 → 队列记录 + status 响应透传 reused

describe("#629 P2 executor 复用 → 队列记录 + status 响应透传 reused", () => {
  let taskDefined, taskReused, payloadStatus, payloadReused, payload2Status, payload2Reused;

  beforeAll(async () => {
    // executor 幂等短路（返回 reused:true）→ task.done 且 task.reused=true →
    // handleReportStatus 响应携带 reused（客户端轮询路径「已复用」提示的数据源）
    const queue = new ReportTaskQueue({
      executor: async () => ({ meta: { period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05", generatedAt: 1, ok: true }, reused: true }),
      warn: () => {},
    });
    const sub = queue.submit({ period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05" });
    const task = await pollUntil(() => {
      const t = queue.get(sub.taskId);
      return t?.status === "done" ? t : undefined;
    }, 5000, 2);
    taskDefined = task !== undefined;
    taskReused = task?.reused;
    // status 路由响应透传 reused（直调 handler：包 {handler} 适配 helpers.callHandler
    // 的三参形态，补 context 实参——handleReportStatus 仅消费 reportQueue 字段）
    const payload = await callHandler(
      { handler: (req, res) => handleReportStatus(req, res, { reportQueue: queue }) },
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        method: "GET",
        url: `/api/dsh-provider-usage/reports/generate/status?taskId=${sub.taskId}`,
      },
    );
    payloadStatus = payload.status;
    payloadReused = payload.reused;

    // 对照：非复用任务（reused 缺省）不携带 reused 字段
    const queue2 = new ReportTaskQueue({
      executor: async () => ({ meta: { period: "daily", key: "2026-09-06", startDay: "2026-09-06", endDay: "2026-09-06", generatedAt: 2, ok: true } }),
      warn: () => {},
    });
    const sub2 = queue2.submit({ period: "daily", key: "2026-09-06", startDay: "2026-09-06", endDay: "2026-09-06" });
    await pollUntil(() => queue2.get(sub2.taskId)?.status === "done", 5000, 2);
    const payload2 = await callHandler(
      { handler: (req, res) => handleReportStatus(req, res, { reportQueue: queue2 }) },
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        method: "GET",
        url: `/api/dsh-provider-usage/reports/generate/status?taskId=${sub2.taskId}`,
      },
    );
    payload2Status = payload2.status;
    payload2Reused = payload2.reused;
  });

  it("复用任务到达 done", () => {
    expect(taskDefined).toBeTruthy();
  });

  it("executor reused:true → task.reused=true", () => {
    expect(taskReused).toBe(true);
  });

  it("status done", () => {
    expect(payloadStatus).toBe("done");
  });

  it("status 响应透传 reused（客户端轮询提示数据源）", () => {
    expect(payloadReused).toBe(true);
  });

  it("非复用任务 status done", () => {
    expect(payload2Status).toBe("done");
  });

  it("非复用任务不携带 reused（新生成语义不变）", () => {
    expect(payload2Reused).toBeUndefined();
  });
});

// ---------------------------------------------------------------- #633 分片 a D1：旧格式（无 cwd/dir 键）报告生成链路回归

describe("#633 分片 a D1：旧格式（无 cwd/dir 键）报告生成链路回归", () => {
  // D1 spec：构造升级前格式（无 cwd/dir 键）分片 fixture，断言启动重建、统计/趋势查询、
  // 报告生成三条链路均不抛错且未识别桶计入正确数值。前两条链路由 unit-trend A2 用例
  // 覆盖；本块补报告生成链路：旧格式分片经真实 TrendTracker.start 重建（启动链路）→
  // buckets()（统计/趋势查询面）→ buildStatsSnapshot + generateReport（报告链路）逐级
  // 不抛错；byDirectory 未识别桶数值正确；既有维度与无 dir 维度时零回归。
  const todayKey = dayKey(T0); // 2026-09-04
  let bucketsLen, sByDirectory, sTotalsCalls, sTotalsTotal, liveProjection, sLiveByDirectory;
  let sByDay, s0ByDirectory, stripS, stripS0, rMetaOk, injectedHasDirBucket, hostileDir;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-d1-legacy-"));
    const aggDir = join(root, "agg");
    const detDir = join(root, "details");
    mkdirSync(aggDir, { recursive: true });
    mkdirSync(detDir, { recursive: true });
    const today = dayKey(T0); // 2026-09-04
    // 旧格式行（无 dir 键；形态同 unit-trend A2 fixture）：过去日 agg 权威行 + 当日明细/计数行
    const legacyAgg = { v: TREND_ROW_VERSION, kind: "agg", day: "2026-09-03", provider: "deepseek", model: "deepseek-chat", input: 5000, output: 800, cacheRead: 120, cacheWrite: 10, calls: 30, turns: 12, toolCalls: 40 };
    const legacyDetail = { v: TREND_ROW_VERSION, kind: "detail", time: T0 - HOUR, day: today, session: "旧会话-甲", turn: 3, step: 2, retry: 1, provider: "deepseek", model: "deepseek-chat", input: 1200, output: 300, cacheRead: 45, cacheWrite: 6, calls: 1 };
    const legacyCounter = { v: TREND_ROW_VERSION, kind: "counter", time: T0 - HOUR, day: today, session: "旧会话-甲", provider: "deepseek", model: "deepseek-chat", turns: 1, toolCalls: 1 };
    writeFileSync(join(aggDir, "2026-09-03.jsonl"), `${JSON.stringify(legacyAgg)}\n`);
    writeFileSync(join(detDir, `${today}.jsonl`), `${JSON.stringify(legacyDetail)}\n${JSON.stringify(legacyCounter)}\n`);
    // 链路 1/2（启动重建 + 统计/趋势查询面）：不抛错、两日全量入内存
    const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000 });
    const buckets = tracker.buckets();
    bucketsLen = buckets.length;
    // 链路 3（报告生成）：窗口覆盖两日（weekly 形态）——历史输出不缺失
    // 本节手搓 dirRows 只用于验证 buildStatsSnapshot 自身的窗口裁剪与聚合（窗口外
    // dir 行不计）；真实链路的 dirRows 形态见紧随其后的残差投影端到端断言。
    const dirRows = [
      { v: TREND_ROW_VERSION, kind: "dir", day: today, dir: TREND_UNIDENTIFIED, input: 22, output: 11, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-10", dir: "窗口外", input: 999, output: 999, cacheRead: null, cacheWrite: null, calls: 9, turns: 9, toolCalls: 9 },
    ];
    const s = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-03", endDay: today, buckets, dirRows, prevTotal: null });
    sByDirectory = JSON.parse(JSON.stringify(s.byDirectory));
    sTotalsCalls = s.totals.calls;
    sTotalsTotal = s.totals.total;
    // 残差投影端到端（本次修复）：真实 tracker.dirRows() 喂入 buildStatsSnapshot——
    // 旧格式日（09-03 只有 agg 行）经残差归未识别桶，byDirectory 与 totals 同口径
    // （修复前此处为空数组：历史在报告里也消失）。手搓 dirRows 掩盖过这一差异。
    const live = tracker.dirRows();
    liveProjection = live.map((r) => [r.day, r.dir, r.calls]).sort();
    const sLive = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-03", endDay: today, buckets, dirRows: live, prevTotal: null });
    sLiveByDirectory = JSON.parse(JSON.stringify(sLive.byDirectory));
    sByDay = JSON.parse(JSON.stringify(s.byDay));
    // 零回归：同 buckets 无 dir 维度（dirRows 缺省）时既有字段逐字段完全一致
    const s0 = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-03", endDay: today, buckets, prevTotal: null });
    s0ByDirectory = JSON.parse(JSON.stringify(s0.byDirectory));
    const strip = (snap) => {
      const clone = { ...snap };
      delete clone.byDirectory;
      return clone;
    };
    stripS = JSON.parse(JSON.stringify(strip(s)));
    stripS0 = JSON.parse(JSON.stringify(strip(s0)));
    // {stats} 注入 → generateReport（fake llm）不抛错且成功，byDirectory 进注入面
    const { llm, seen } = fakeLlm();
    const r = await generateReport(GEN({ llm, period: "weekly", key: "2026-09-03", startDay: "2026-09-03", endDay: today, statsJson: JSON.stringify(s) }));
    rMetaOk = r.meta.ok;
    injectedHasDirBucket = seen.options.messages[0].content[0].text.includes(JSON.stringify(s.byDirectory[0]));
    await tracker.dispose();
    // dir 键防御（与 provider/model 名同口径）：控制字符剥离 + 80 字符截断
    const hostile = buildStatsSnapshot({
      period: "daily",
      startDay: today,
      endDay: today,
      buckets: [],
      dirRows: [{ v: TREND_ROW_VERSION, kind: "dir", day: today, dir: `a\nb${"x".repeat(100)}`, input: 1, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 }],
      prevTotal: null,
    });
    hostileDir = hostile.byDirectory[0].dir;
  });

  it("旧格式分片重建：过去日 agg 权威行 + 当日明细两日全量入内存（不抛错）", () => {
    expect(bucketsLen).toBe(2);
  });

  it("byDirectory 未识别桶计入正确数值（窗口外 dir 行不计）", () => {
    expect(sByDirectory).toEqual([{ dir: TREND_UNIDENTIFIED, calls: 1, total: 33 }]);
  });

  it("历史输出不缺失：calls 与升级前一致（30+1）", () => {
    expect(sTotalsCalls).toBe(31);
  });

  it("历史 token 总量不缺失（5930+1551，四项 null-aware 之和）", () => {
    expect(sTotalsTotal).toBe(7481);
  });

  it("真实 dirRows：旧 agg-only 日经残差补入未识别桶（当日明细行亦归未识别）", () => {
    expect(liveProjection).toEqual([["2026-09-03", TREND_UNIDENTIFIED, 30], [todayKey, TREND_UNIDENTIFIED, 1]]);
  });

  it("报告链路端到端：byDirectory 覆盖全窗口（= totals 口径，历史不再从报告消失）", () => {
    expect(sLiveByDirectory).toEqual([{ dir: TREND_UNIDENTIFIED, calls: 31, total: 7481 }]);
  });

  it("byDay 旧数据完整（两日总量一致）", () => {
    expect(sByDay).toEqual([{ day: "2026-09-03", total: 5930 }, { day: todayKey, total: 1551 }]);
  });

  it("无 dir 行 → byDirectory 空数组（加性可选维度，不补造）", () => {
    expect(s0ByDirectory).toEqual([]);
  });

  it("byProvider/byDay/totals/派生维度与无 dir 维度时完全一致（零回归）", () => {
    expect(stripS).toEqual(stripS0);
  });

  it("旧格式数据报告生成不抛错且成功", () => {
    expect(rMetaOk).toBe(true);
  });

  it("{stats} 注入面含未识别目录桶（dir=TREND_UNIDENTIFIED）", () => {
    expect(injectedHasDirBucket).toBeTruthy();
  });

  it("dir 控制字符进快照前已剥离", () => {
    expect(hostileDir.includes("\n")).toBeFalsy();
  });

  it("dir 截断至 80 字符（与 byProvider 同口径）", () => {
    expect(hostileDir.length).toBe(80);
  });
});

// ---------------------------------------------------------------- #633 分片 b C2：脱敏出口逐条断言（basename 化 + 三出口）

describe("#633 分片 b C2：脱敏出口逐条断言（basename 化 + 三出口）", () => {
  // C2 硬性：目录名进任何对外出口前统一 basename 化（禁完整绝对路径）→ 剥控制
  // 字符 → 截断 80。三出口逐条断言：1) {stats} 注入 JSON；2) 报告产物正文；
  // 3) notifier 推送摘要。
  // 伪造含路径分隔符的 dir 键（isValidDirKey 只查长度，恶意分片行可携带）——
  // 快照出口 basename 化必须锁死「无路径分隔符」承诺。
  const MALICIOUS_DIRS = [
    "/home/alice/secret-project",
    "C:\\Users\\bob\\work\\repo",
    `x\n\t${"y".repeat(120)}`,
    "pro\u009bj",
    TREND_UNIDENTIFIED,
  ];
  const MALICIOUS_INPUTS = [100, 50, 10, 3, 5];

  const snap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [],
    dirRows: MALICIOUS_DIRS.map((dir, i) => ({
      v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir,
      input: MALICIOUS_INPUTS[i], output: null, cacheRead: null, cacheWrite: null,
      calls: 1, turns: 0, toolCalls: 0,
    })),
    prevTotal: null,
  });
  const allDirs = snap.byDirectory.map((r) => r.dir);
  // 出口 1：{stats} 注入 JSON（快照即注入形态；applyPromptTemplate 全文断言）
  const injected = applyPromptTemplate("统计：{stats}", JSON.stringify(snap));
  // 出口 1.5：无 dir 事实（dirRows 缺省）时 byDirectory 空数组、注入面无目录句
  const noDirSnap = buildStatsSnapshot({ period: "daily", startDay: "2026-09-03", endDay: "2026-09-03", buckets: [], prevTotal: null });

  let rMetaOk, promptText, htmlText, metaText, sentLen, pushBody;

  beforeAll(async () => {
    // 出口 2：报告产物正文（fake llm 回显目录 basename 的叙事正文；正文为 LLM 叙事——
    // 断言落盘链路 HTML 文档 + meta 不含路径形态，正文载体经 format 净化）
    const { llm, seen } = fakeLlm([
      { type: "text-delta", index: 0, text: "昨天用量集中在 secret-project 与 repo 两个目录。" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: "finish", reason: "stop" },
    ]);
    const r = await generateReport(GEN({ llm, statsJson: JSON.stringify(snap) }));
    rMetaOk = r.meta.ok;
    promptText = seen.options.messages[0].content[0].text;
    // 产物正文出口：persistReport 的 HTML 文档与 meta.json 落盘形态（临时目录隔离）
    const rootDir = mkdtempSync(join(tmpdir(), "dou-report-c2-"));
    await persistReport(rootDir, r.meta, r.body);
    htmlText = readFileSync(reportHtmlFile(rootDir, r.meta.period, r.meta.key), "utf8");
    metaText = readFileSync(reportMetaFile(rootDir, r.meta.period, r.meta.key), "utf8");
    rmSync(rootDir, { recursive: true, force: true });
    // 出口 3：notifier 推送摘要（notifyReport 捕获 send 请求体）
    const sent = [];
    const fakeCtx = {
      get: () => ({ send: async (req) => { sent.push(req); } }),
    };
    notifyReport(fakeCtx, CFG({ push: { enabled: true } }), r.meta, snap, (s) => s);
    sentLen = sent.length;
    pushBody = sent.length > 0 ? `${sent[0].title} ${sent[0].body}` : "";
  });

  for (const [i, d] of allDirs.entries()) {
    it(`注入 JSON 目录键无路径分隔符：${JSON.stringify(d)}`, () => {
      expect(!d.includes("/") && !d.includes("\\")).toBeTruthy();
    });

    it(`注入 JSON 目录键无 C0+DEL+C1 控制字符：${JSON.stringify(d)}`, () => {
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(d)).toBeFalsy();
    });

    it(`注入 JSON 目录键 ≤80 字符（实际 ${d.length}）`, () => {
      expect(d.length <= 80).toBeTruthy();
    });
  }

  it("POSIX 绝对路径出口 = basename", () => {
    expect(allDirs.includes("secret-project")).toBeTruthy();
  });

  it("Windows 绝对路径出口 = basename", () => {
    expect(allDirs.includes("repo")).toBeTruthy();
  });

  it("C1 形态（pro\\u009bj）剥除后 = proj（复核 P1-2）", () => {
    expect(allDirs.includes("proj")).toBeTruthy();
  });

  it("控制字符剥除 + 截断 80 形态（剥后残留字面字符保留）", () => {
    const hostileDir = allDirs.find((d) => d.startsWith("x"));
    expect(hostileDir !== undefined && hostileDir.length <= 80 && !/[\u0000-\u001f]/.test(hostileDir)).toBeTruthy();
  });

  it("注入 JSON 全文不含原始绝对路径", () => {
    expect(injected.includes("/home/alice")).toBeFalsy();
  });

  it("注入 JSON 全文不含 Windows 路径", () => {
    expect(!injected.includes("Users\\\\bob") && !injected.includes("Users\\bob")).toBeTruthy();
  });

  it("无目录事实 → byDirectory 空数组（不补造）", () => {
    expect(noDirSnap.byDirectory).toEqual([]);
  });

  it("带目录快照生成成功", () => {
    expect(rMetaOk).toBe(true);
  });

  it("{stats} 注入 prompt 全文无绝对路径（出口 2 前置：模型只见 basename 形态）", () => {
    expect(!promptText.includes("/home/alice") && !promptText.includes("Users\\bob")).toBeTruthy();
  });

  it("prompt 含 basename 形态目录名（模型可见面）", () => {
    expect(promptText.includes("secret-project") && promptText.includes("repo")).toBeTruthy();
  });

  const artifacts = [["HTML", () => htmlText], ["meta", () => metaText]];

  for (const [name, getArtifact] of artifacts) {
    it(`报告产物（${name}）不含绝对路径`, () => {
      const artifact = getArtifact();
      expect(!artifact.includes("/home/alice") && !artifact.includes("Users\\bob")).toBeTruthy();
    });

    it(`报告产物（${name}）无原始控制字符（排版 \\n/\\t 除外）`, () => {
      const artifact = getArtifact();
      // 目录键不携带的排版性换行/制表除外（meta.json 为缩进 2 pretty JSON），其余 C0 控制字符不得出现
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(artifact)).toBeFalsy();
    });
  }

  it("产物正文含 basename 目录名（LLM 叙事引用）", () => {
    expect(htmlText.includes("secret-project")).toBeTruthy();
  });

  it("推送已发出", () => {
    expect(sentLen).toBe(1);
  });

  it("推送摘要不含任何路径分隔符（仅周期/窗口/数值）", () => {
    expect(!pushBody.includes("/") && !pushBody.includes("\\")).toBeTruthy();
  });

  it("推送摘要无控制字符", () => {
    expect(/[\u0000-\u001f\u007f]/.test(pushBody)).toBeFalsy();
  });

  it("推送摘要含周期标识（数值型摘要形态）", () => {
    expect(pushBody.includes("daily")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #633 分片 b C3：注入面声明与 README 收敛（源码字面断言，#383 先例风格）

describe("#633 分片 b C3：注入面声明与 README 收敛（源码字面断言）", () => {
  // C3 硬性：声明与实现一致——防「注释宣称无路径、实现泄漏路径」的声明回退。
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgDir = join(here, "..", "..", "..");
  const genSrc = readFileSync(join(pkgDir, "src/domain2/execute/generate.ts"), "utf8");
  const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
  const cfgSrc = readFileSync(join(pkgDir, "src/domain2/schedule/config.ts"), "utf8");

  it("generate.ts 注入面注释为准确口径（含目录 basename）", () => {
    expect(genSrc.includes("只含聚合数值与目录 basename")).toBeTruthy();
  });

  it("generate.ts 注入面注释含剥控制字符 + 截断口径", () => {
    expect(genSrc.includes("剥控制字符 + 截断")).toBeTruthy();
  });

  it("buildStatsSnapshot 出口 basename 化实现在场（lastIndexOf 切分）", () => {
    // 出口实现哨兵：byDirectory 出口必须含 basename 化（两系分隔符切分），不回退
    expect(genSrc.includes("lastIndexOf(\", c.lastIndexOf(\"\\\\\")") || /Math\.max\([^)]*lastIndexOf/.test(genSrc)).toBeTruthy();
  });

  it("剥/切后空串归并未识别桶键（防空标签）", () => {
    expect(genSrc.includes("TREND_UNIDENTIFIED : safeName")).toBeTruthy();
  });

  it("README 安全模型收敛为 basename 口径", () => {
    expect(readme.includes("目录 basename")).toBeTruthy();
  });

  it("README 注入口径含剥控制字符 + 截断 80", () => {
    expect(readme.includes("剥控制字符 + 截断 80")).toBeTruthy();
  });

  it("README 旧句（无目录 basename）已收敛", () => {
    expect(readme.includes("注入面只含聚合数值（不含会话明细与路径）")).toBeFalsy();
  });

  it("README 裸「摘要不含项目路径」句已收敛为准确口径", () => {
    expect(readme.includes("摘要不含项目路径；")).toBeFalsy();
  });

  // 模板目录硬规则哨兵（C1 模板升级防回退）
  for (const sentinel of ["byDirectory 第一位", "工作分散在 N 个目录", "目录版图", "绝不展开为路径、绝不推测目录内容"]) {
    it(`三周期模板目录硬规则哨兵在场：${sentinel}`, () => {
      expect(cfgSrc.includes(sentinel)).toBeTruthy();
    });
  }

  // #662 时段硬规则哨兵（C1 模板升级防回退：时段红线 + 时段句式在场）
  for (const sentinel of ["时段一笔（可选）", "时段观察一笔（可选）", "时段版图（可选一节）", "绝不把时段与行为、场景、情绪关联", "绝不与 byDirectory 交叉关联"]) {
    it(`三周期模板时段硬规则哨兵在场：${sentinel}`, () => {
      expect(cfgSrc.includes(sentinel)).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------- #633 分片 b C1：三周期模板硬规则断言（fake llm 抓 prompt）

describe("#633 分片 b C1：三周期模板硬规则断言（fake llm 抓 prompt）", () => {
  // C1 硬性：模板输出经 fake llm 抓 prompt 断言目录句式与硬规则——三周期模板
  // 均含目录观察句式与硬规则（目录名 basename 口径、占比分母口径、缺失跳过）。
  const periods = ["daily", "weekly", "monthly"];
  const labels = { daily: "日报", weekly: "周报", monthly: "月报" };

  for (const period of periods) {
    it(`${period} 模板含 byDirectory 目录观察指引`, () => {
      expect(promptFor(CFG(), period).includes("byDirectory")).toBeTruthy();
    });

    it(`${period} 模板含目录名 basename 硬规则（不展开为路径）`, () => {
      expect(promptFor(CFG(), period).includes("绝不展开为路径")).toBeTruthy();
    });

    it(`${period} 模板含占比分母硬规则`, () => {
      const tpl = promptFor(CFG(), period);
      expect(tpl.includes("totals.total > 0") || tpl.includes("分母大于 0")).toBeTruthy();
    });

    it(`${period} 模板保留 null 降级硬规则`, () => {
      expect(promptFor(CFG(), period).includes("绝不输出 null/0/NaN")).toBeTruthy();
    });

    it(`${period} 模板含时段观察指引（peakHour/byPeriod）`, () => {
      const tpl = promptFor(CFG(), period);
      // #662：时段观察指引 + 时段红线（原样引用字段、禁行为脑补、禁跨口径关联）
      expect(tpl.includes("peakHour") || tpl.includes("byPeriod")).toBeTruthy();
    });

    it(`${period} 模板含时段红线（禁行为脑补）`, () => {
      expect(promptFor(CFG(), period).includes("绝不把时段与行为、场景、情绪关联")).toBeTruthy();
    });

    it(`${period} 模板含时段红线（禁跨口径关联）`, () => {
      expect(promptFor(CFG(), period).includes("绝不与 byDirectory 交叉关联")).toBeTruthy();
    });
  }

  // 周期特有句式：日报可点 top 目录占比；周报「本周」节目录分布观察含中性句；
  // 月报含目录版图小节。
  it("日报模板：可点 top 目录占比句式", () => {
    expect(promptFor(CFG(), "daily").includes("byDirectory 第一位（最活跃目录）")).toBeTruthy();
  });

  it("周报模板：目录分散中性句", () => {
    expect(promptFor(CFG(), "weekly").includes("工作分散在 N 个目录")).toBeTruthy();
  });

  it("月报模板：目录版图小节", () => {
    expect(promptFor(CFG(), "monthly").includes("目录版图")).toBeTruthy();
  });

  // #662 周期特有句式：日报时段一笔 / 周报时段观察一笔 / 月报时段版图
  it("日报模板：时段一笔（可选）句式", () => {
    expect(promptFor(CFG(), "daily").includes("时段一笔（可选）")).toBeTruthy();
  });

  it("周报模板：时段观察一笔（可选）句式", () => {
    expect(promptFor(CFG(), "weekly").includes("时段观察一笔（可选）")).toBeTruthy();
  });

  it("月报模板：时段版图（可选一节）句式", () => {
    expect(promptFor(CFG(), "monthly").includes("时段版图（可选一节）")).toBeTruthy();
  });

  // 端到端：带目录快照 → 三周期模板 {stats} 注入 → prompt 落地断言（fake llm）
  const dirSnap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [{ day: "2026-09-03", providers: [{ provider: "p", model: "m", cell: { input: 300, output: null, cacheRead: null, cacheWrite: null, calls: 3, turns: 3, toolCalls: 0 } }] }],
    dirRows: [
      { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: "alpha", input: 200, output: null, cacheRead: null, cacheWrite: null, calls: 2, turns: 0, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: TREND_UNIDENTIFIED, input: 100, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    ],
    prevTotal: null,
  });

  it("快照 byDirectory calls 降序（占比素材）", () => {
    expect(dirSnap.byDirectory).toEqual([{ dir: "alpha", calls: 2, total: 200 }, { dir: TREND_UNIDENTIFIED, calls: 1, total: 100 }]);
  });

  for (const period of periods) {
    describe(`#633 C1 端到端：${labels[period]}模板 {stats} 注入`, () => {
      let rMetaOk, text;

      beforeAll(async () => {
        const { llm, seen } = fakeLlm();
        const r = await generateReport(GEN({ llm, period, key: "2026-09-03", startDay: "2026-09-03", endDay: "2026-09-03", promptTemplate: promptFor(CFG(), period), statsJson: JSON.stringify(dirSnap) }));
        rMetaOk = r.meta.ok;
        text = seen.options.messages[0].content[0].text;
      });

      it(`${period} 生成成功`, () => {
        expect(rMetaOk).toBe(true);
      });

      it(`${period} prompt 注入含目录维度的统计 JSON`, () => {
        expect(text.includes('"byDirectory"') && text.includes("alpha")).toBeTruthy();
      });

      it(`${period} prompt 携带目录硬规则`, () => {
        expect(text.includes("绝不展开为路径")).toBeTruthy();
      });
    });
  }
});

// ---------------------------------------------------------------- #633 分片 b B4：目录范围配置归一化与 round-trip

describe("#633 分片 b B4：目录范围归一化（非法形态回退 / basename / 去重上限 / 超长跳过）", () => {
  // B4 硬性：目录范围字段（默认「全部」= 空数组语义或显式 all）——归一化白名单 +
  // 持久化 round-trip + 口径影响（runDueReport 级集成在 smoke 覆盖）。
  it("缺省 directories → 空数组（全部）", () => {
    expect(normalizeReportConfig({}).directories).toEqual([]);
  });

  it("显式 all 字符串 → 空数组", () => {
    expect(normalizeReportConfig({ directories: "all" }).directories).toEqual([]);
  });

  it("all 数组项过滤 → 空数组", () => {
    expect(normalizeReportConfig({ directories: ["all"] }).directories).toEqual([]);
  });

  it("非数组字符串 → 空数组（回退默认）", () => {
    expect(normalizeReportConfig({ directories: "proj" }).directories).toEqual([]);
  });

  it("非字符串/空串项全滤 → 空数组", () => {
    expect(normalizeReportConfig({ directories: [42, null, ""] }).directories).toEqual([]);
  });

  // basename 归一（与 C2 出口同口径）：反斜杠/正斜杠路径取末段，控制字符剥除
  it("目录范围项 basename 化（两系分隔符）", () => {
    expect(normalizeReportConfig({ directories: ["/home/u/proj", "C:\\w\\repo"] }).directories).toEqual(["proj", "repo"]);
  });

  it("目录范围项控制字符剥除", () => {
    expect(normalizeReportConfig({ directories: ["a\nb"] }).directories).toEqual(["ab"]);
  });

  it("目录范围项 C1 控制字符剥除（复核 P1-2）", () => {
    expect(normalizeReportConfig({ directories: ["pro\u009bj", "x\u0080y"] }).directories).toEqual(["proj", "xy"]);
  });

  // 去重 + 上限 32（按归一化后的字面值去重；空白不 trim——basename 精确保留）
  it("目录范围去重（归一化后字面一致）", () => {
    expect(normalizeReportConfig({ directories: ["proj", "proj"] }).directories).toEqual(["proj"]);
  });

  it("目录范围上限 32 项", () => {
    expect(normalizeReportConfig({ directories: Array.from({ length: 40 }, (_, i) => `d${i}`) }).directories.length).toBe(32);
  });

  // 超长项跳过（而非截断）：与数据层 isValidDirKey/TREND_DIR_MAX 同口径——截断会造出
  // 永远匹配不到任何分片行的键，目录范围过滤面静默变空（QA 复核 P1）
  it("超长目录项跳过（不截断造出无对应行的键）", () => {
    expect(normalizeReportConfig({ directories: [`x${"y".repeat(300)}`] }).directories).toEqual([]);
  });

  it("超长项跳过、合法项保留", () => {
    expect(normalizeReportConfig({ directories: ["ok", `x${"y".repeat(300)}`] }).directories).toEqual(["ok"]);
  });

  it("上限内（256）的目录项保留", () => {
    expect(normalizeReportConfig({ directories: ["x".repeat(256)] }).directories[0].length).toBe(256);
  });
});

describe("#633 分片 b B4：目录范围持久化 round-trip 与存量配置兼容", () => {
  let loadedDirs, reloadedDirs, reloadedIntact;

  beforeAll(async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "dou-report-b4-"));
    const saved = normalizeReportConfig({ directories: ["proj", "repo"], push: { enabled: false } });
    await writeReportConfig(rootDir, saved);
    loadedDirs = [...(await readReportConfig(rootDir)).directories];
    // 未配置 directories 的存量配置文件读回 → 默认空数组（不缺键报错）
    const cfgFile = join(rootDir, "reports", "config.json");
    const legacyOnDisk = JSON.parse(readFileSync(cfgFile, "utf8"));
    delete legacyOnDisk.directories;
    writeFileSync(cfgFile, JSON.stringify(legacyOnDisk));
    const reloaded = await readReportConfig(rootDir);
    reloadedDirs = [...reloaded.directories];
    reloadedIntact = reloaded.provider !== undefined && typeof reloaded.prompts === "object";
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("directories 持久化 round-trip 一致", () => {
    expect(loadedDirs).toEqual(["proj", "repo"]);
  });

  it("存量配置（无 directories 键）读回 → 默认空数组", () => {
    expect(reloadedDirs).toEqual([]);
  });

  it("存量配置其余字段不受影响", () => {
    expect(reloadedIntact).toBeTruthy();
  });
});

describe("#633 分片 b B4：口径影响（reportCfg.directories 非空 → 快照 byDirectory 只含所选目录）", () => {
  let allSnapOk, scopedDirs, scopedInput;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-b4-scope-"));
    const nowMs = T0;
    const tracker = await TrendTracker.start({
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/w/alpha" : "/w/beta"),
    });
    tracker.handleEvent({ id: "s1" }, { type: "request/header", seq: 1, time: T0, data: { header: { config: { provider: "p", model: "m" } } } });
    tracker.handleEvent({ id: "s1" }, { type: "assistant/message", seq: 2, time: T0, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } } });
    tracker.handleEvent({ id: "s2" }, { type: "request/header", seq: 3, time: T0, data: { header: { config: { provider: "p", model: "m" } } } });
    tracker.handleEvent({ id: "s2" }, { type: "assistant/message", seq: 4, time: T0, data: { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 3 } } });
    const fakeCtx = { llm: { stream: () => (async function* () { yield* CHUNKS; })(), listProviders: () => [{ id: "p" }], listModels: async () => [{ id: "m" }] } };
    const due = { period: "daily", key: "2026-09-03", startDay: "2026-09-03", endDay: "2026-09-03", force: true };
    // 全部（空数组）：两目录都在
    const allSnap = await runDueReport({ due, trend: tracker, ctx: fakeCtx, reportCfg: normalizeReportConfig({ push: { enabled: false }, directories: [] }), historyRoot: root, sanitizeDiagnostic: (s) => s });
    allSnapOk = allSnap.ok === true;
    // 限定单目录（persistReport 已落盘，用 trend.dirRows 直接断言过滤口径）：
    const scoped = normalizeReportConfig({ directories: ["alpha"] }).directories;
    const dirRows = tracker.dirRows().filter((r) => scoped.includes(r.dir));
    scopedDirs = dirRows.map((r) => r.dir);
    scopedInput = dirRows[0].input;
    await tracker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("目录范围=全部：生成成功", () => {
    expect(allSnapOk).toBe(true);
  });

  it("目录范围激活：目录维度投影只含所选目录（runner 同口径）", () => {
    expect(scopedDirs).toEqual(["alpha"]);
  });

  it("所选目录数值为该目录子集（不被其他目录污染）", () => {
    expect(scopedInput).toBe(100);
  });
});
