/**
 * dsh-provider-usage — unit：#732 抽出的 schedule 域纯函数直接打面。
 *
 * 本文件只打「决策面」纯函数（每条用例直打一个被抽出的函数，断言其自身契约）：
 * - store.ts：校准决策 / schema 版本判读 / 校准事实判别
 * - tasks.ts：已结算判定
 * - retry-policy.ts：result⇔status 自洽 / 观测落位 / 落位应用
 * - retry-ledger.ts：观测序列 / 观测一致性 / 条目解析 / 文档解析 / 观测与条目等价
 * - scheduler.ts：到期键 / 到期项 / 到期集合合并 / claim 窗口与周期等价
 *
 * 纪律：零墙钟、零 I/O、零网络；入参全为显式构造。
 */
import { describe, expect, it } from "vitest";
import {
  calibrateLastRun,
  schemaVersionOf,
  isLastRunCalibrationInput,
} from "../../../src/server/schedule/store.ts";
import { isSettled } from "../../../src/server/schedule/tasks.ts";
import {
  statusAgreesWithResult,
  observationSlot,
  applyObservation,
  RETRY_MAX_ATTEMPTS,
  emptyRetryAttemptTokens,
  type RetryAttemptObservation,
  type RetryClaim,
  type RetryEntry,
} from "../../../src/server/schedule/retry-policy.ts";
import {
  collectSequentialObservations,
  hasConsistentObservationOutcome,
  parseEntry,
  parseDocument,
  parseEntryState,
  usageMatchesObservations,
  sameObservations,
  sameEntryWindow,
  sameEntryCycle,
  claimMatchesCurrent,
  RETRY_LEDGER_SCHEMA,
} from "../../../src/server/schedule/retry-ledger.ts";
import {
  mergeDueReports,
  dueReportKey,
  dueReportOf,
  sameClaimWindow,
  sameClaimCycle,
} from "../../../src/server/schedule/scheduler.ts";
import { LAST_RUN_SCHEMA, type LastRunRecord } from "../../../src/server/shared/interface.ts";
import type { DueReport } from "../../../src/server/schedule/due.ts";

const ZERO_TOKENS = emptyRetryAttemptTokens();

/** 合法观测（override 只覆盖显式给的字段）。 */
function obs(over: Partial<RetryAttemptObservation> = {}): RetryAttemptObservation {
  return {
    attempt: 1,
    result: "failure",
    code: "upstream-500",
    status: "retry",
    durationMs: 120,
    tokens: { ...ZERO_TOKENS, inputTokens: 10, totalTokens: 10 },
    ...over,
  };
}

/** 合法账本条目（默认 daily/2026-09-06 非终态 waiting）。 */
function entry(over: Partial<RetryEntry> = {}): RetryEntry {
  return {
    period: "daily",
    key: "2026-09-06",
    startDay: "2026-09-06",
    endDay: "2026-09-06",
    route: { provider: "deepseek-official", model: "deepseek-chat" },
    attempts: 1,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    nextRetryAt: 1757180000000,
    terminal: false,
    reason: null,
    cycleId: "c1",
    phase: "waiting",
    attemptObservations: [obs()],
    usage: { ...ZERO_TOKENS, inputTokens: 10, totalTokens: 10, durationMs: 120 },
    ...over,
  };
}

describe("store 校准纯面", () => {
  it("calibrateLastRun：schema 旧全量重算，changed 为 true", () => {
    // generatedAt 所在**本地日** > endDay → 该窗口已闭环，deriveLastRun 收下。
    // dayKey 按本地时区构造（见 shared/charts.ts：禁用 toISOString 是为免东八区 00:00–08:00
    // 划入前一天），故时间戳必须对**所有时区**都成立：取 2025-09-08T12:00:00Z，
    // 任何时区（UTC-12..UTC+14）本地日都落在 09-07/09-08，均 > 09-06。
    // 原取值 1757180000000（2025-09-06）在 UTC 下 dayKey 恰为 09-06 → 不闭环，
    // 本地（UTC+8）绿而 CI（UTC）红——本条断言改为时区无关取值并加下方回归守卫。
    const records: LastRunRecord[] = [
      {
        period: "daily",
        key: "2025-09-06",
        endDay: "2025-09-06",
        generatedAt: 1757332800000, // 2025-09-08T12:00:00Z
        ok: true,
      },
    ];
    const out = calibrateLastRun(LAST_RUN_SCHEMA - 1, {}, records);
    expect(out.changed).toBe(true);
    expect(out.after.daily).toBe("2025-09-06");
  });

  // 时区回归守卫（#732 CI 教训）：闭环判定走 dayKey（本地时区），取值必须对所有时区成立。
  // 本条在本地即��把「只在 UTC+8 通过」的时间戳揪出来，不必等 CI。
  it.each([
    "UTC",
    "Asia/Shanghai",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Pacific/Auckland",
    "Pacific/Honolulu",
  ])("闭环判定在 TZ=%s 下与时区无关", (tz) => {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      // dayKey 读 Date 构造时的本地时区，改 TZ 后需重置缓存
      const out = calibrateLastRun(LAST_RUN_SCHEMA - 1, {}, [
        {
          period: "daily",
          key: "2025-09-06",
          endDay: "2025-09-06",
          generatedAt: 1757332800000,
          ok: true,
        },
      ]);
      expect(out.changed).toBe(true);
      expect(out.after.daily).toBe("2025-09-06");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("calibrateLastRun：schema 新且对齐后无变化 → changed=false", () => {
    const out = calibrateLastRun(LAST_RUN_SCHEMA, { daily: "2026-09-06" }, []);
    expect(out).toEqual({ after: { daily: "2026-09-06" }, changed: false });
  });

  it("schemaVersionOf：缺 schema 视作 1，非对象亦视作 1", () => {
    expect(schemaVersionOf({ schema: 3 })).toBe(3);
    expect(schemaVersionOf({})).toBe(1);
    expect(schemaVersionOf(null)).toBe(1);
    expect(schemaVersionOf("x")).toBe(1);
  });

  it("isLastRunCalibrationInput：带 records 才是完整校准事实", () => {
    expect(isLastRunCalibrationInput({ schema: 1, before: {}, records: [] })).toBe(true);
    expect(isLastRunCalibrationInput({ before: {} })).toBe(false);
  });
});

describe("tasks 已结算判定", () => {
  it("isSettled：done / failed 为已结算，queued / running 不是", () => {
    expect(isSettled({ status: "done" })).toBe(true);
    expect(isSettled({ status: "failed" })).toBe(true);
    expect(isSettled({ status: "running" })).toBe(false);
    expect(isSettled({ status: "queued" })).toBe(false);
  });
});

describe("retry-policy 观测纯面", () => {
  it("statusAgreesWithResult：success⇔status=success，失败不得为 success", () => {
    expect(statusAgreesWithResult(obs({ result: "success", code: null, status: "success" }))).toBe(
      true,
    );
    expect(statusAgreesWithResult(obs({ result: "success", code: null, status: "retry" }))).toBe(
      false,
    );
    expect(statusAgreesWithResult(obs({ result: "failure", status: "terminal" }))).toBe(true);
    expect(statusAgreesWithResult(obs({ result: "failure", status: "success" }))).toBe(false);
  });

  it("observationSlot：新观测落位为 -1（追加）", () => {
    const claim = { cycleId: "c1", entry: entry({ attempts: 1 }) };
    expect(observationSlot(claim, obs({ attempt: 2, code: "upstream-502" }))).toBe(-1);
  });

  it("observationSlot：跳号追加抛 attempt 不匹配", () => {
    const claim = { cycleId: "c1", entry: entry({ attempts: 1 }) };
    expect(() => observationSlot(claim, obs({ attempt: 4 }))).toThrow(
      "retry observation attempt does not match claim",
    );
  });

  it("observationSlot：覆盖非末次 attempt 抛 latest 错", () => {
    const first = obs({ attempt: 1, result: "success", code: null, status: "success" });
    const second = obs({ attempt: 2, result: "failure" });
    const claim = {
      cycleId: "c1",
      entry: entry({ attempts: 2, attemptObservations: [first, second] }),
    };
    expect(() =>
      observationSlot(claim, obs({ attempt: 1, result: "failure", code: "upstream-500" })),
    ).toThrow("retry observation replacement is not the latest attempt");
  });

  it("observationSlot：末次 success 改判 failure 合法，返回该槽位下标", () => {
    const first = obs({ attempt: 1, result: "success", code: null, status: "success" });
    const claim = {
      cycleId: "c1",
      entry: entry({ attempts: 1, attemptObservations: [first] }),
    };
    expect(observationSlot(claim, obs({ attempt: 1 }))).toBe(0);
  });

  it("applyObservation：index<0 追加，index>=0 覆盖且不改原数组", () => {
    const base = [obs({ attempt: 1 })];
    const appended = applyObservation(base, obs({ attempt: 2 }), -1);
    expect(appended).toHaveLength(2);
    expect(appended[1].attempt).toBe(2);
    const replaced = applyObservation(base, obs({ attempt: 1, code: "upstream-503" }), 0);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].code).toBe("upstream-503");
    expect(base[0].code).toBe("upstream-500");
  });
});

describe("retry-ledger 观测序列纯面", () => {
  it("collectSequentialObservations：attempt 连续时整体收下", () => {
    const out = collectSequentialObservations([
      obs({ attempt: 1, result: "success", code: null, status: "success" }),
      obs({ attempt: 2 }),
    ]);
    expect(out).not.toBeNull();
    expect(out?.map((o) => o.attempt)).toEqual([1, 2]);
  });

  it("collectSequentialObservations：跳号即整体拒（null）", () => {
    expect(collectSequentialObservations([obs({ attempt: 2 })])).toBeNull();
  });

  it("hasConsistentObservationOutcome：失败必带码且 status 不得为 success", () => {
    expect(hasConsistentObservationOutcome(obs())).toBe(true);
    expect(hasConsistentObservationOutcome(obs({ code: null }))).toBe(false);
    expect(hasConsistentObservationOutcome(obs({ status: "success" }))).toBe(false);
  });

  it("hasConsistentObservationOutcome：retry 超出最大尝试数判不一致", () => {
    expect(hasConsistentObservationOutcome(obs({ attempt: RETRY_MAX_ATTEMPTS + 1 }))).toBe(false);
  });

  it("usageMatchesObservations：落盘 usage 须等于按观测重算的结果", () => {
    const observations = [obs()];
    expect(usageMatchesObservations(observations[0].tokens as never, observations)).toBe(false);
    expect(
      usageMatchesObservations(
        {
          inputTokens: 10,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: 10,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          durationMs: 120,
        },
        observations,
      ),
    ).toBe(true);
  });
});

describe("retry-ledger 条目解析纯面", () => {
  it("parseEntry：合法条目原样解出（含标量与载荷）", () => {
    const out = parseEntry("daily", "2026-09-06", entry());
    expect(out?.attempts).toBe(1);
    expect(out?.cycleId).toBe("c1");
    expect(out?.attemptObservations).toHaveLength(1);
  });

  it("parseEntry：键集多一个即拒（半写账本防线）", () => {
    expect(parseEntry("daily", "2026-09-06", { ...entry(), extra: 1 })).toBeNull();
  });

  it("parseEntry：period/key 不对位即拒", () => {
    expect(parseEntry("daily", "2026-09-05", entry())).toBeNull();
  });

  it("parseEntry：maxAttempts 与常量不符即拒", () => {
    expect(parseEntry("daily", "2026-09-06", { ...entry(), maxAttempts: 99 })).toBeNull();
  });

  it("parseEntryState：终态须 terminal=true + reason 非空 + 不排期", () => {
    expect(
      parseEntryState(
        { terminal: true, nextRetryAt: null },
        { code: "permanent", kind: "permanent" },
        "terminal",
        1,
      ),
    ).toBe(true);
    expect(
      parseEntryState(
        { terminal: true, nextRetryAt: 5 },
        { code: "permanent", kind: "permanent" },
        "terminal",
        1,
      ),
    ).toBe(false);
  });

  it("parseEntryState：非终态带 reason 即拒", () => {
    expect(
      parseEntryState(
        { terminal: false, nextRetryAt: 1 },
        { code: "permanent", kind: "permanent" },
        "waiting",
        1,
      ),
    ).toBe(false);
  });

  it("parseEntryState：initial 相位必须零尝试", () => {
    expect(parseEntryState({ terminal: false, nextRetryAt: 1 }, null, "initial", 1)).toBe(false);
    expect(parseEntryState({ terminal: false, nextRetryAt: 1 }, null, "initial", 0)).toBe(true);
  });
});

describe("retry-ledger 文档解析纯面", () => {
  it("parseDocument：schema 正确 + 合法条目 → 解出 records", () => {
    const doc = parseDocument({
      schema: RETRY_LEDGER_SCHEMA,
      records: { daily: { "2026-09-06": entry() } },
    });
    expect(Object.keys(doc.records.daily ?? {})).toEqual(["2026-09-06"]);
  });

  it("parseDocument：schema 版本不符抛 schema 错（与键集错区分）", () => {
    expect(() => parseDocument({ schema: 99, records: {} })).toThrow("invalid retry ledger schema");
    expect(() => parseDocument({ schema: RETRY_LEDGER_SCHEMA, records: {}, extra: 1 })).toThrow(
      "invalid retry ledger document",
    );
  });

  it("parseDocument：未知 period 在条目校验之后才判（错误优先级固定）", () => {
    expect(() =>
      parseDocument({
        schema: RETRY_LEDGER_SCHEMA,
        records: { daily: { bad: entry() }, yearly: {} },
      }),
    ).toThrow("invalid retry ledger entry");
  });
});

describe("retry-ledger 等价判定纯面", () => {
  it("sameObservations：逐字段等价，右侧缺席即不等价", () => {
    const a = [obs()];
    expect(sameObservations(a, [obs()])).toBe(true);
    expect(sameObservations(a, [obs({ code: "upstream-501" })])).toBe(false);
    expect(sameObservations(a, [])).toBe(false);
  });

  it("sameEntryWindow：窗口四元组全等才算等价", () => {
    expect(sameEntryWindow(entry(), entry())).toBe(true);
    expect(sameEntryWindow(entry(), entry({ endDay: "2026-09-07" }))).toBe(false);
  });

  it("sameEntryCycle：尝试/排期/终态/相位全等才算等价", () => {
    expect(sameEntryCycle(entry(), entry())).toBe(true);
    expect(sameEntryCycle(entry(), entry({ phase: "in-flight" }))).toBe(false);
  });

  it("claimMatchesCurrent：cycleId 不符即不等价（围栏生效）", () => {
    const claim: RetryClaim = { cycleId: "c1", entry: entry() };
    expect(claimMatchesCurrent(claim, entry())).toBe(true);
    expect(claimMatchesCurrent({ ...claim, cycleId: "c2" }, entry())).toBe(false);
  });
});

describe("scheduler 到期集合纯面", () => {
  const due: DueReport = {
    period: "daily",
    key: "2026-09-06",
    startDay: "2026-09-06",
    endDay: "2026-09-06",
  };

  it("dueReportKey：period:key 复合键", () => {
    expect(dueReportKey(due)).toBe("daily:2026-09-06");
  });

  it("dueReportOf：账本条目降为到期项（保留窗口）", () => {
    expect(dueReportOf(entry())).toEqual(due);
  });

  it("mergeDueReports：账本已有条目且未到期 → 不重复提交", () => {
    const out = mergeDueReports([due], [entry()], []);
    expect(out).toEqual([]);
  });

  it("mergeDueReports：账本已有条目但已到期 → 补提候选", () => {
    const out = mergeDueReports([due], [entry()], [entry()]);
    expect(out).toEqual([due]);
  });

  it("mergeDueReports：账本无对应条目 → 首次窗口直接提交", () => {
    expect(mergeDueReports([due], [], [])).toEqual([due]);
  });

  it("mergeDueReports：终态到期项不补提", () => {
    const terminal = entry({ terminal: true, reason: { code: "permanent", kind: "permanent" } });
    expect(mergeDueReports([], [], [terminal])).toEqual([]);
  });

  it("sameClaimWindow / sameClaimCycle：claim 窗口与周期分别判等", () => {
    const claim: RetryClaim = { cycleId: "c1", entry: entry() };
    expect(sameClaimWindow(claim, entry())).toBe(true);
    expect(
      sameClaimWindow(
        claim,
        entry({ key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05" }),
      ),
    ).toBe(false);
    expect(sameClaimCycle(claim, entry())).toBe(true);
    expect(sameClaimCycle(claim, entry({ attempts: 2 }))).toBe(false);
  });
});
