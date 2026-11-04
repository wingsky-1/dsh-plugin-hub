/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  LAST_RUN_SCHEMA,
  deriveLastRun,
  ensureLastRunMigrated,
  isClosedWindowRecord,
  join,
  mkdirSync,
  mkdtempSync,
  parseReportIndexLines,
  readFileSync,
  tmpdir,
  writeFileSync,
  type ReportPeriod,
} from "./report-generation-support.ts";

type MigrateOutcome = Awaited<ReturnType<typeof ensureLastRunMigrated>>;
type MigrationState = {
  res: MigrateOutcome;
  res2: MigrateOutcome;
  res3: MigrateOutcome;
  res4: MigrateOutcome;
  res5: MigrateOutcome;
  migrated: { schema: unknown; daily: unknown };
  kept: { daily: unknown };
  kept5: { daily: unknown; weekly: unknown; monthly: unknown };
};

describe("#624 lastRun 推导/闭环判定（纯函数）", () => {
  const closed = (period: ReportPeriod, key: string, generatedAt: number, endDay: string) => ({
    period,
    key,
    generatedAt,
    endDay,
    ok: true,
  });
  // 本地时刻 2026-09-07 06:00 → dayKey = "2026-09-07"
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  // 旧语义「当天」daily 记录：发起日 = endDay 当天（09-06 06:00 生成当天窗口）→ 未闭环（#624 根因记录）
  const t606 = new Date(2026, 8, 6, 6, 0, 0).getTime();
  const legacySameDay = closed("daily", "2026-09-06", t606, "2026-09-06");
  // 新语义 daily 记录（发起日 = endDay+1）→ 已闭环
  const closedDaily = closed("daily", "2026-09-06", t607, "2026-09-05");

  let derived: Partial<Record<ReportPeriod, string>>;
  let pollutedOnly: Partial<Record<ReportPeriod, string>>;
  let y: Partial<Record<ReportPeriod, string>>;

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

function registerMigrationCoreCases(state: MigrationState): void {
  it("旧 schema + 污染键 → 发生校准", () => {
    expect(state.res.changed).toBe(true);
  });

  it("迁移后：daily 回退到最近已闭环 09-04（09-06 污染键剔除）", () => {
    expect(state.res.after).toEqual({
      daily: "2026-09-04",
      weekly: "2026-08-31",
      monthly: "2026-08",
    });
  });

  it("写回 schema 版本", () => {
    expect(state.migrated.schema).toBe(LAST_RUN_SCHEMA);
  });

  it("写回内容 = 推导结果", () => {
    expect(state.migrated.daily).toBe("2026-09-04");
  });

  it("二次运行无变化（可重放幂等）", () => {
    expect(state.res2.changed).toBe(false);
  });

  it("schema:2 遮蔽事故 → 自愈回退", () => {
    expect(state.res3.changed).toBe(true);
  });

  it("自愈后 daily 回退到最近已闭环键", () => {
    expect(state.res3.after.daily).toBe("2026-09-04");
  });

  it("无 index 事实源 → 保持原状", () => {
    expect(state.res4.changed).toBe(false);
  });

  it("原 lastRun 未被改动", () => {
    expect(state.kept.daily).toBe("2026-09-06");
  });
}

function registerMigrationPresetCases(state: MigrationState): void {
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  const line = (period: string, key: string, generatedAt: number, endDay: string): string =>
    JSON.stringify({ period, key, startDay: endDay, endDay, generatedAt, ok: true });
  it("preset 键保留 + weekly 已对齐 → 无变化", () => {
    expect(state.res5.changed).toBe(false);
  });

  it("daily preset 键不被删", () => {
    expect(state.kept5.daily).toBe("2026-09-06");
  });

  it("monthly preset 键不被删", () => {
    expect(state.kept5.monthly).toBe("2026-08");
  });

  it("weekly 对齐到最新闭环键", () => {
    expect(state.kept5.weekly).toBe("2026-08-31");
  });

  it("缺解析端口（C 波）：有 index 也不校准（changed:false 且落盘不动）", async () => {
    const root6 = mkdtempSync(join(tmpdir(), "dou-report-noport-"));
    const reports6 = join(root6, "reports");
    mkdirSync(reports6, { recursive: true });
    const lastFile6 = join(reports6, "last-run.json");
    // 旧 schema + 污染键 + 有效闭环 index：带端口必校准（同场景 1），
    // 缺端口视同无事实——覆盖 store 缺端口早返分支。
    writeFileSync(
      lastFile6,
      JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-24", monthly: "2026-08" }),
    );
    writeFileSync(
      join(reports6, "index.jsonl"),
      [line("daily", "2026-09-04", t607, "2026-09-03")].join("\n") + "\n",
    );
    const rawBefore = readFileSync(lastFile6, "utf8");
    const res6 = await ensureLastRunMigrated(root6, () => {});
    expect(res6.changed).toBe(false);
    expect(res6.after).toEqual({ daily: "2026-09-06", weekly: "2026-08-24", monthly: "2026-08" });
    expect(readFileSync(lastFile6, "utf8")).toBe(rawBefore);
  });
}

describe("#624 ensureLastRunMigrated：迁移写回 + 自愈 + 可重放", () => {
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  const t606 = new Date(2026, 8, 6, 6, 0, 0).getTime();
  const line = (period: string, key: string, generatedAt: number, endDay: string): string =>
    JSON.stringify({ period, key, startDay: endDay, endDay, generatedAt, ok: true });
  const state = {} as MigrationState;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-migrate-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const lastFile = join(reports, "last-run.json");
    const indexFile = join(reports, "index.jsonl");

    // 场景 1：旧 schema + 旧语义污染键（#624 根因现场）→ 校准写回 schema:2
    writeFileSync(
      lastFile,
      JSON.stringify({
        daily: "2026-09-06",
        weekly: "2026-08-24",
        monthly: "2026-08",
        updatedAt: 1,
      }),
    );
    writeFileSync(
      indexFile,
      [
        line("daily", "2026-09-04", t607, "2026-09-03"), // 已闭环
        line("daily", "2026-09-06", t606, "2026-09-06"), // 旧语义当天（发起日=endDay，未闭环，被剔除）
        line("weekly", "2026-08-31", t607, "2026-09-06"), // 已闭环
        line("monthly", "2026-08", t607, "2026-08-31"), // 已闭环
      ].join("\n") + "\n",
    );
    state.res = await ensureLastRunMigrated(root, () => {}, parseReportIndexLines);
    state.migrated = JSON.parse(readFileSync(lastFile, "utf8"));

    // 场景 2：schema:2 且与事实一致 → 不再变化（幂等/可重放）
    state.res2 = await ensureLastRunMigrated(root, () => {}, parseReportIndexLines);

    // 场景 3：schema:2 被旧污染键遮蔽（P0-4 自愈）→ 仍校准
    writeFileSync(
      lastFile,
      JSON.stringify({
        daily: "2026-09-06",
        weekly: "2026-08-31",
        monthly: "2026-08",
        schema: LAST_RUN_SCHEMA,
      }),
    );
    state.res3 = await ensureLastRunMigrated(root, () => {}, parseReportIndexLines);

    // 场景 4：无 index（事实源缺失）→ 不动 lastRun
    const root2 = mkdtempSync(join(tmpdir(), "dou-report-migrate2-"));
    mkdirSync(join(root2, "reports"), { recursive: true });
    writeFileSync(
      join(root2, "reports", "last-run.json"),
      JSON.stringify({ daily: "2026-09-06", schema: 1 }),
    );
    state.res4 = await ensureLastRunMigrated(root2, () => {}, parseReportIndexLines);
    state.kept = JSON.parse(readFileSync(join(root2, "reports", "last-run.json"), "utf8"));

    // 场景 5（#531 保护）：schema:2 + preset 键（index 无对应记录）→ 温和校准保留 preset 键，
    // 仅对齐「index 存在闭环记录」的期——首次启用不被启动校准删键、不被立即补跑
    const root3 = mkdtempSync(join(tmpdir(), "dou-report-migrate3-"));
    const reports3 = join(root3, "reports");
    mkdirSync(reports3, { recursive: true });
    // 模拟：保存配置时 #531 预置 daily/weekly/monthly 键（index 均无记录），之后手动生成过 weekly
    writeFileSync(
      join(reports3, "last-run.json"),
      JSON.stringify({
        daily: "2026-09-06",
        weekly: "2026-08-31",
        monthly: "2026-08",
        schema: LAST_RUN_SCHEMA,
      }),
    );
    writeFileSync(
      join(reports3, "index.jsonl"),
      [line("weekly", "2026-08-31", t607, "2026-09-06")].join("\n") + "\n",
    );
    state.res5 = await ensureLastRunMigrated(root3, () => {}, parseReportIndexLines);
    const raw5 = JSON.parse(readFileSync(join(reports3, "last-run.json"), "utf8"));
    state.kept5 = { daily: raw5.daily, weekly: raw5.weekly, monthly: raw5.monthly };
  });

  registerMigrationCoreCases(state);
  registerMigrationPresetCases(state);
});
