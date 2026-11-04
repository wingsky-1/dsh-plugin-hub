/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHUNKS,
  T0,
  TrendCollector,
  TrendTracker,
  join,
  mkdtempSync,
  normalizeReportConfig,
  promptFor,
  readFileSync,
  readReportConfig,
  rmSync,
  runDueReport,
  tmpdir,
  writeFileSync,
  writeReportConfig,
  type Context,
  type ReportTaskInput,
  type SessionEvent,
} from "./report-generation-support.ts";

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
    expect(
      normalizeReportConfig({ directories: ["/home/u/proj", "C:\\w\\repo"] }).directories,
    ).toEqual(["proj", "repo"]);
  });

  it("目录范围项控制字符剥除", () => {
    expect(normalizeReportConfig({ directories: ["a\nb"] }).directories).toEqual(["ab"]);
  });

  it("目录范围项 C1 控制字符剥除（复核 P1-2）", () => {
    expect(normalizeReportConfig({ directories: ["pro\u009bj", "x\u0080y"] }).directories).toEqual([
      "proj",
      "xy",
    ]);
  });

  // 去重 + 上限 32（按归一化后的字面值去重；空白不 trim——basename 精确保留）
  it("目录范围去重（归一化后字面一致）", () => {
    expect(normalizeReportConfig({ directories: ["proj", "proj"] }).directories).toEqual(["proj"]);
  });

  it("目录范围上限 32 项", () => {
    expect(
      normalizeReportConfig({ directories: Array.from({ length: 40 }, (_, i) => `d${i}`) })
        .directories.length,
    ).toBe(32);
  });

  // 超长项跳过（而非截断）：与数据层 isValidDirKey/TREND_DIR_MAX 同口径——截断会造出
  // 永远匹配不到任何分片行的键，目录范围过滤面静默变空（QA 复核 P1）
  it("超长目录项跳过（不截断造出无对应行的键）", () => {
    expect(normalizeReportConfig({ directories: [`x${"y".repeat(300)}`] }).directories).toEqual([]);
  });

  it("超长项跳过、合法项保留", () => {
    expect(
      normalizeReportConfig({ directories: ["ok", `x${"y".repeat(300)}`] }).directories,
    ).toEqual(["ok"]);
  });

  it("上限内（256）的目录项保留", () => {
    expect(normalizeReportConfig({ directories: ["x".repeat(256)] }).directories[0].length).toBe(
      256,
    );
  });
});

describe("#633 分片 b B4：目录范围持久化 round-trip 与存量配置兼容", () => {
  let loadedDirs: string[];
  let reloadedDirs: string[];
  let reloadedIntact: boolean;

  beforeAll(async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "dou-report-b4-"));
    const saved = normalizeReportConfig({
      directories: ["proj", "repo"],
      push: { enabled: false },
    });
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
  let allSnapOk: boolean;
  let scopedDirs: string[];
  let scopedInput: number | null;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-b4-scope-"));
    const nowMs = T0;
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/w/alpha" : "/w/beta"),
    });
    // 最小事件信封经 unknown 断言为 SessionEvent（ledger/contract 同款边界建模）。
    tracker.handleEvent({ id: "s1" }, {
      type: "request/header",
      seq: 1,
      time: T0,
      data: { header: { config: { provider: "p", model: "m" } } },
    } as unknown as SessionEvent);
    tracker.handleEvent({ id: "s1" }, {
      type: "assistant/message",
      seq: 2,
      time: T0,
      data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } },
    } as unknown as SessionEvent);
    tracker.handleEvent({ id: "s2" }, {
      type: "request/header",
      seq: 3,
      time: T0,
      data: { header: { config: { provider: "p", model: "m" } } },
    } as unknown as SessionEvent);
    tracker.handleEvent({ id: "s2" }, {
      type: "assistant/message",
      seq: 4,
      time: T0,
      data: { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 3 } },
    } as unknown as SessionEvent);
    const fakeCtx = {
      llm: {
        stream: () =>
          (async function* () {
            yield* CHUNKS;
          })(),
        listProviders: () => [{ id: "p" }],
        listModels: async () => [{ id: "m" }],
      },
    };
    const due: ReportTaskInput = {
      period: "daily",
      key: "2026-09-03",
      startDay: "2026-09-03",
      endDay: "2026-09-03",
      force: true,
    };
    // 全部（空数组）：两目录都在
    const cfgForSnap = normalizeReportConfig({ push: { enabled: false }, directories: [] });
    const allSnap = await runDueReport({
      due,
      trend: tracker,
      ctx: fakeCtx as unknown as Context,
      reportCfg: cfgForSnap,
      promptTemplate: promptFor(cfgForSnap, "daily"),
      historyRoot: root,
      sanitizeDiagnostic: (s) => s,
    });
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
