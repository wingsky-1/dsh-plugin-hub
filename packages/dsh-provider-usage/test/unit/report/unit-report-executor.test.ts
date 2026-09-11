// @ts-nocheck
/**
 * dsh-provider-usage — unit：D8 报告面组合收敛
 *
 * L2 契约（refactor-implementation-plan.md §2）：
 * - makeDueReportExecutor：幂等短路（index 已有成功记录且非 force → 复用，不推进
 *   lastRun）；失败/脱敏路径由 unit-apply 集成（HTTP 手动生成）覆盖
 * - ReportConfigService：内存权威 + 串行写链（并发 update 不交错）、onUpdate 回调
 *   在写盘后触发、磁盘文件 roundtrip
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { makeDueReportExecutor, ReportConfigService, readReportConfig, DEFAULT_REPORT_CONFIG, readLastRun } from "../../../src/apply/index.ts";
import { makeListDirs } from "../../../src/domain2/execute/list-dirs.ts";

describe("ReportConfigService：串行写链 / 内存权威 / 回调顺序 / 磁盘 roundtrip", () => {
  let root: string;
  let updates: Array<{ daily: { time: string } }>;
  let svc: ReportConfigService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u-report-cfg-"));
    updates = [];
    svc = new ReportConfigService({ root, initial: normalizeCfg({}), onUpdate: (c) => updates.push(c) });
  });

  const concurrentUpdates = () => Promise.all([
    svc.update(normalizeCfg({ daily: { enabled: true, time: "09:00" } })),
    svc.update(normalizeCfg({ daily: { enabled: true, time: "18:00" } })),
  ]);

  it("初始内存权威（默认 daily 08:00）", () => {
    expect(svc.get().daily.time).toBe("08:00");
  });

  it("并发 update 串行后内存为最后一次", async () => {
    await concurrentUpdates();
    expect(svc.get().daily.time).toBe("18:00");
  });

  it("onUpdate 按提交序触发（不交错）", async () => {
    await concurrentUpdates();
    expect(updates.map((c) => c.daily.time)).toEqual(["09:00", "18:00"]);
  });

  it("磁盘 roundtrip 为最后一次（串行写链）", async () => {
    await concurrentUpdates();
    const disk = await readReportConfig(root);
    expect(disk.daily.time).toBe("18:00");
  });
});

describe("ReportConfigService：update 失败（写盘拒绝）不污染内存权威", () => {
  let svc: ReportConfigService;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "u-report-cfg-fail-"));
    // 用目录占用模拟写失败：把 reports 位置占为普通文件
    writeFileSync(join(root, "reports"), "x");
    svc = new ReportConfigService({ root, initial: normalizeCfg({}) });
  });

  it("写盘失败向外抛（调用方转 500）", async () => {
    await expect(svc.update(normalizeCfg({ weekly: { enabled: true } }))).rejects.toThrow();
  });

  it("失败不落内存（内存权威保持旧值）", async () => {
    await svc.update(normalizeCfg({ weekly: { enabled: true } })).catch(() => {});
    expect(svc.get().weekly.enabled).toBe(false);
  });
});

describe("executor 幂等短路：index 已有成功记录且非 force → 复用，不推进 lastRun", () => {
  let meta: Record<string, unknown>;
  let res: Record<string, unknown>;
  let lastRun: Record<string, unknown>;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "u-exec-idem-"));
    const reportsDir = join(root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    meta = { period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05", generatedAt: 1, ok: true };
    writeFileSync(join(reportsDir, "index.jsonl"), `${JSON.stringify(meta)}\n`);

    const executor = makeDueReportExecutor({
      trend: {},
      ctx: {},
      getReportCfg: () => normalizeCfg({}),
      historyRoot: root,
      sanitizeDiagnostic: (s) => `SAN:${s}`,
    });
    res = await executor({ period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05" });
    lastRun = await readLastRun(root);
  });

  it("index 已有成功记录 → 幂等复用", () => {
    expect(res.reused).toBe(true);
  });

  it("复用记录原样返回", () => {
    expect(res.meta).toEqual(meta);
  });

  it("幂等短路不推进 lastRun（下轮不再重跑同一窗口）", () => {
    expect(lastRun).toEqual({});
  });
});

describe("makeListDirs：目录候选查询面（净化出口 + 未识别桶归位）", () => {
  let list: Array<{ dir: string; calls: number; total: number }>;

  beforeEach(() => {
    const trend = {
      dirTotals: () => [
        { dir: "/home/u/proj-a", calls: 3, total: 10 },
        { dir: "x/y", calls: 1, total: 2 },
        { dir: null, calls: 0, total: null },
      ],
    };
    list = makeListDirs(trend)();
  });

  it("全量返回", () => {
    expect(list.length).toBe(3);
  });

  it("绝对路径净化为 basename", () => {
    expect(list[0].dir).toBe("proj-a");
  });

  it("多级路径取 basename", () => {
    expect(list[1].dir).toBe("y");
  });

  it("无目录归未识别桶", () => {
    expect(list[2].dir).toBe("(unidentified)");
  });

  it("calls 透传", () => {
    expect(list[0].calls).toBe(3);
  });

  it("total 透传", () => {
    expect(list[0].total).toBe(10);
  });
});

// 工具：顶层平铺结构（daily/weekly/monthly 为 ReportConfig 顶层字段）
function normalizeCfg(overrides) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_REPORT_CONFIG)), ...overrides };
}
