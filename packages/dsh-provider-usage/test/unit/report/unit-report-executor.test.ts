// @ts-nocheck
/**
 * dsh-provider-usage — unit：D8 报告面组合收敛（阶段二）
 *
 * L2 契约（refactor-implementation-plan.md §2.1）：
 * - makeDueReportExecutor：幂等短路（index 已有成功记录且非 force → 复用，不推进
 *   lastRun）；失败/脱敏路径由 unit-apply 集成（HTTP 手动生成）覆盖
 * - ReportConfigService：内存权威 + 串行写链（并发 update 不交错）、onUpdate 回调
 *   在写盘后触发、磁盘文件 roundtrip
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "../../helpers.ts";
import { makeDueReportExecutor, ReportConfigService, readReportConfig, DEFAULT_REPORT_CONFIG, readLastRun } from "../../../lib/index.js";
import { makeListDirs } from "../../../src/domain2/execute/list-dirs.ts";

// ---- ReportConfigService：串行写链 / 内存权威 / 回调顺序 / 磁盘 roundtrip
{
  const root = mkdtempSync(join(tmpdir(), "u-report-cfg-"));
  const svc = new ReportConfigService({ root, initial: normalizeCfg({}), onUpdate: (c) => updates.push(c) });
  const updates = [];

  assert.equal(svc.get().daily.time, "08:00", "初始内存权威（默认 daily 08:00）");

  await Promise.all([
    svc.update(normalizeCfg({ daily: { enabled: true, time: "09:00" } })),
    svc.update(normalizeCfg({ daily: { enabled: true, time: "18:00" } })),
  ]);
  assert.equal(svc.get().daily.time, "18:00", "并发 update 串行后内存为最后一次");
  assert.deepEqual(updates.map((c) => c.daily.time), ["09:00", "18:00"], "onUpdate 按提交序触发（不交错）");

  const disk = await readReportConfig(root);
  assert.equal(disk.daily.time, "18:00", "磁盘 roundtrip 为最后一次（串行写链）");
}

// ---- ReportConfigService：update 失败（写盘拒绝）不污染内存权威
{
  const root = mkdtempSync(join(tmpdir(), "u-report-cfg-fail-"));
  // 用目录占用模拟写失败：把 reports 位置占为普通文件
  writeFileSync(join(root, "reports"), "x");
  const svc = new ReportConfigService({ root, initial: normalizeCfg({}) });
  let threw = false;
  try {
    await svc.update(normalizeCfg({ weekly: { enabled: true } }));
  } catch {
    threw = true;
  }
  assert.ok(threw, "写盘失败向外抛（调用方转 500）");
  assert.equal(svc.get().weekly.enabled, false, "失败不落内存（内存权威保持旧值）");
}

// ---- executor 幂等短路：index 已有成功记录且非 force → 复用，不推进 lastRun
{
  const root = mkdtempSync(join(tmpdir(), "u-exec-idem-"));
  const reportsDir = join(root, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const meta = { period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05", generatedAt: 1, ok: true };
  writeFileSync(join(reportsDir, "index.jsonl"), `${JSON.stringify(meta)}\n`);

  const executor = makeDueReportExecutor({
    trend: {},
    ctx: {},
    getReportCfg: () => normalizeCfg({}),
    historyRoot: root,
    sanitizeDiagnostic: (s) => `SAN:${s}`,
  });
  const res = await executor({ period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05" });
  assert.equal(res.reused, true, "index 已有成功记录 → 幂等复用");
  assert.deepEqual(res.meta, meta, "复用记录原样返回");
  const lastRun = await readLastRun(root);
  assert.deepEqual(lastRun, {}, "幂等短路不推进 lastRun（下轮不再重跑同一窗口）");
}

// ---- makeListDirs：目录候选查询面（净化出口 + 未识别桶归位）
{
  const trend = {
    dirTotals: () => [
      { dir: "/home/u/proj-a", calls: 3, total: 10 },
      { dir: "x/y", calls: 1, total: 2 },
      { dir: null, calls: 0, total: null },
    ],
  };
  const list = makeListDirs(trend)();
  assert.equal(list.length, 3, "全量返回");
  assert.equal(list[0].dir, "proj-a", "绝对路径净化为 basename");
  assert.equal(list[1].dir, "y", "多级路径取 basename");
  assert.equal(list[2].dir, "(unidentified)", "无目录归未识别桶");
  assert.equal(list[0].calls, 3, "calls 透传");
  assert.equal(list[0].total, 10, "total 透传");
}

// 工具：顶层平铺结构（daily/weekly/monthly 为 ReportConfig 顶层字段）
function normalizeCfg(overrides) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_REPORT_CONFIG)), ...overrides };
}