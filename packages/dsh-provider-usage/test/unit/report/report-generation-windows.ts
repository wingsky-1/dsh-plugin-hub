/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CFG,
  T0,
  HOUR,
  DEFAULT_REPORT_CONFIG,
  candidateWindow,
  normalizeReportConfig,
  parseHHMM,
  pendingReports,
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  type DueReport,
} from "./report-generation-support.ts";

describe("schedule：daily 未过锚点（now 12:00 早于当日 22:00）", () => {
  let due: ReturnType<typeof candidateWindow>;
  beforeAll(() => {
    due = candidateWindow("daily", CFG(), T0);
  });

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
  let due: ReturnType<typeof candidateWindow>;
  beforeAll(() => {
    due = candidateWindow("daily", CFG(), T0 + 11 * HOUR);
  });

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
  let manualDue: ReturnType<typeof previousClosedWindow>;
  beforeAll(() => {
    manualDue = previousClosedWindow("daily", CFG(), T0);
  });

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
  let due: ReturnType<typeof candidateWindow>;
  beforeAll(() => {
    due = candidateWindow("weekly", CFG(), T0);
  });

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
  let due: ReturnType<typeof candidateWindow>;
  beforeAll(() => {
    due = candidateWindow("monthly", CFG(), T0);
  });

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

describe("schedule：幂等与补跑", () => {
  type DueList = ReturnType<typeof pendingReports>;
  let firstMount: DueList;
  let allRecorded: DueList;
  let laterRecorded: DueList;
  let nextRun: DueList;
  let weeklyOff: DueList;

  beforeAll(() => {
    const cfg = CFG();
    firstMount = pendingReports(cfg, T0, {});
    allRecorded = pendingReports(cfg, T0, {
      daily: "2026-09-02",
      weekly: "2026-08-24",
      monthly: "2026-08",
    });
    laterRecorded = pendingReports(cfg, T0, { daily: "2026-09-10" });
    nextRun = pendingReports(CFG(), T0 + 11 * HOUR, { daily: "2026-09-02" });
    weeklyOff = pendingReports(
      CFG({ weekly: { enabled: false, time: "09:00", weekStartsOn: 1 } }),
      T0,
      {},
    );
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

describe("schedule：#531 首次启用扣期预置", () => {
  type PresetOutcome = ReturnType<typeof presetLastRunForNewlyEnabled>;
  let r1: PresetOutcome;
  let cand: { daily: string; weekly: string; monthly: string };
  let presetPending: DueReport[];
  let later: DueReport[];
  let r2: PresetOutcome;
  let r3: PresetOutcome;
  let r4: PresetOutcome;

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
    const onlyMonthly = CFG({
      daily: { enabled: false, time: "22:00" },
      weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
    });
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
    expect(later.some((d) => d.period === "daily" && d.key > r1.lastRun.daily!)).toBeTruthy();
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

describe("config：parseHHMM / normalizeReportConfig 归一化", () => {
  let n: ReturnType<typeof normalizeReportConfig>;
  beforeAll(() => {
    n = normalizeReportConfig({
      daily: { enabled: true, time: "99:99" },
      monthly: { dayOfMonth: 31 },
    });
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
