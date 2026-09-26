/**
 * dsh-provider-usage — integration：执行域组合根三维度（#768 计划表 rev2 D3 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/execute 门面活装配），落盘一律进
 * mkdtemp 隔离目录（产物零污染）。三维度（对应任务书“parseReportIndexLines +
 * runner 记忆化迁入 server/execute，执行器经 schedule/config 门面消费”）：
 * - D3一 经域门面装配：执行器/读侧/索引解析只经 server/execute/interface.ts，
 *   不直连域实现文件，不走旧 domain2 入口；schedule/store 的 lastRun 推导只复用
 *   本域纯解析；执行器经 schedule/config 双门面消费（updateLastRun 链 + 任务
 *   类型 + 配置形态，D2 口径延续）；
 * - D3二 门面收口：interface 与实现同一引用（包装即红），deps.ts 纯类型面
 *   （运行时零出口），命名接缝 ExecuteWarn/ExecuteClock 可装配；
 * - D3三 读侧记忆化：stat 失效键缓存（重复读不重解析、文件变化刷新、缺失不缓存）
 *   + 时间纪律（本文件无裸 sleep，等待面唯一是 helpers pollUntil；探针证明
 *   detector 对脏输入有效；轮询否定判据见 schedule 用例 D3三-轮询否定 toFake 面）。
 *
 * 每条附判据句（把 X 改坏必须红）；红证明见同文件“探针：脏输入必被 flag”。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  parseReportIndexLines,
  readReportIndex,
  prevWindowTotal,
  runDueReport,
  persistReport,
  reportHtmlFile,
  reportMetaFile,
  notifyReport,
  optionalNotifier,
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
  generateReport,
  applyPromptTemplate,
  buildStatsSnapshot,
  PERIOD_BUCKETS,
  reportBodyToHtml,
  makeDueReportExecutor,
  makeListDirs,
} from "../../../src/server/execute/interface.ts";
import { parseReportIndexLines as ImplParse } from "../../../src/server/execute/report-index.ts";
import {
  readReportIndex as ImplRead,
  prevWindowTotal as ImplPrev,
  runDueReport as ImplRun,
  persistReport as ImplPersist,
  reportHtmlFile as ImplHtml,
  reportMetaFile as ImplMeta,
  notifyReport as ImplNotify,
  optionalNotifier as ImplOptional,
  __clearReportIndexCacheForTests as ImplClear,
  __reportIndexCacheStatsForTests as ImplStats,
} from "../../../src/server/execute/runner.ts";
import {
  generateReport as ImplGenerate,
  applyPromptTemplate as ImplTemplate,
  buildStatsSnapshot as ImplSnapshot,
  PERIOD_BUCKETS as ImplBuckets,
} from "../../../src/server/execute/generate.ts";
import { reportBodyToHtml as ImplBody } from "../../../src/server/execute/format.ts";
import { makeDueReportExecutor as ImplExecutor } from "../../../src/server/execute/executor.ts";
import { makeListDirs as ImplListDirs } from "../../../src/server/execute/list-dirs.ts";
import * as executeDepsNs from "../../../src/server/execute/deps.ts";
import type { ExecuteClock, ExecuteWarn } from "../../../src/server/execute/deps.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const ownSrc = readFileSync(join(here, "composition-root.test.ts"), "utf8");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applySrcFlat = applySrc.replace(/\s+/g, " ").replace(/,\s*}/g, " }");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const executeFaceSrc = readFileSync(join(srcDir, "server", "execute", "interface.ts"), "utf8");
const reportIndexSrc = readFileSync(join(srcDir, "server", "execute", "report-index.ts"), "utf8");
const runnerSrc = readFileSync(join(srcDir, "server", "execute", "runner.ts"), "utf8");
const executorSrc = readFileSync(join(srcDir, "server", "execute", "executor.ts"), "utf8");
const storeSrc = readFileSync(join(srcDir, "server", "schedule", "store.ts"), "utf8");
const tasksSrc = readFileSync(join(srcDir, "server", "schedule", "tasks.ts"), "utf8");
const reportsSrc = readFileSync(join(srcDir, "server", "report-routes", "reports.ts"), "utf8");
// #768 D13：domain2/common/ 目录已消除（parse 唯一定义归 server/execute/report-index.ts），本文件不再读旧门面。

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
const quietWarn: ExecuteWarn = () => undefined;
const testClock: ExecuteClock = () => Date.now();

/** 装配面禁直连：判据 = 任一实现路径进入组合根 import 即红。 */
const FORBIDDEN_FACES = [
  "domain2/execute",
  "domain2/common/report-index",
  "domain2/common/interface",
  "server/execute/runner",
  "server/execute/executor",
  "server/execute/report-index",
  "server/execute/generate",
  "server/execute/format",
  "server/execute/list-dirs",
];

/** 时间纪律判据：裸 sleep 字面（经拼接构造，文件内无字面残留，detector 失明则探针先红）。 */
const SLEEP_MARKER = ["new Promise((r) => set", "Timeout"].join("");

describe("D3一 经 server/execute 域门面装配", () => {
  it("组合根经同一门面构造执行器（换源即红）", () => {
    expect(applySrc.includes("../server/execute/interface.ts")).toBe(true);
    expect(applySrc.includes("makeDueReportExecutor")).toBe(true);
    expect(applySrc.includes("readReportIndex,")).toBe(true);
  });

  it("组合根经同一门面取 optionalNotifier + 纯解析注入（换源／分头即红）", () => {
    expect(
      applySrcFlat.includes(
        'import { optionalNotifier, parseReportIndexLines, resolveGenerateRoute } from "../server/execute/interface.ts";',
      ),
    ).toBe(true);
    expect(applySrc.includes("parseIndex: parseReportIndexLines")).toBe(true);
  });

  it("组合根经同一门面取 makeListDirs（换源即红）", () => {
    expect(
      applySrc.includes('import { makeListDirs } from "../server/execute/interface.ts";'),
    ).toBe(true);
  });

  for (const face of FORBIDDEN_FACES) {
    it("组合根不直连 " + face, () => {
      expect(applySrc.includes(face)).toBe(false);
    });
  }

  it("包入口不再引用旧 execute 域（删残留即红）", () => {
    expect(applyFaceSrc.includes("domain2/execute")).toBe(false);
  });

  it("包入口parse收窄后集合：parse已退役白盒直连（残留即红）", () => {
    // B波收窄后集合：parseReportIndexLines已退役（白盒直连域门面，见unit-report）。
    expect(applyFaceSrc.includes("domain2/common/interface")).toBe(false);
    expect(
      applyFaceSrc.includes(
        'export { parseReportIndexLines } from "../server/execute/interface.ts";',
      ),
    ).toBe(false);
  });

  it("执行器经 schedule/config 双门面（B1 推进注入 + B2 提示词注入，直连实现即红）", () => {
    // B1：schedule 值边清零（仅 type 复用任务类型），推进经 advanceLastRun 注入
    expect(executorSrc.includes('"../schedule/interface.ts"')).toBe(true);
    expect(executorSrc.includes("advanceLastRun")).toBe(true);
    expect(executorSrc.includes("import { updateLastRun }")).toBe(false);
    expect(executorSrc.includes("RETRY_MAX_ATTEMPTS")).toBe(false);
    expect(executorSrc.includes("claim.entry.maxAttempts")).toBe(true);
    expect(executorSrc.includes('"../config/interface.ts"')).toBe(true);
    expect(executorSrc.includes("server/schedule/scheduler")).toBe(false);
    expect(executorSrc.includes("server/schedule/tasks")).toBe(false);
    expect(executorSrc.includes("server/schedule/store")).toBe(false);
    expect(executorSrc.includes("server/config/service")).toBe(false);
    // B2：提示词模板经 getPromptTemplate 注入，执行域不直引 promptFor 值边
    expect(executorSrc.includes("getPromptTemplate")).toBe(true);
    expect(executorSrc.includes("import { promptFor }")).toBe(false);
    expect(runnerSrc.includes("promptFor")).toBe(false);
    expect(runnerSrc.includes("import type { ReportConfig, ReportPeriod }")).toBe(true);
    expect(applySrc.includes("getPromptTemplate")).toBe(true);
  });

  it("读侧同级复用索引解析（跨旧 common 即红）", () => {
    expect(runnerSrc.includes('"./report-index.ts"')).toBe(true);
    expect(runnerSrc.includes("common/interface")).toBe(false);
  });

  it("路由读侧经 execute 门面（D11 起改址 server/report-routes，同级短径，不走旧深径）", () => {
    expect(reportsSrc.includes('"../execute/interface.ts"')).toBe(true);
    expect(reportsSrc.includes("../../server/execute")).toBe(false);
  });

  it("调度存储不直取执行门面：纯解析经端口注入（C 波单向化，值环归零）", () => {
    // 调度→执行方向零值边：门面与业务实例引用一律消失（残留即环复活）。
    expect(storeSrc.includes('"../execute/interface.ts"')).toBe(false);
    expect(storeSrc.includes("parseReportIndexLines")).toBe(false);
    const storeImports = storeSrc
      .split(String.fromCharCode(10))
      .filter((l) => l.startsWith("import"));
    expect(storeImports.some((l) => l.includes("readReportIndex"))).toBe(false);
    expect(storeImports.some((l) => l.includes("persistReport"))).toBe(false);
    expect(storeImports.some((l) => l.includes("runDueReport"))).toBe(false);
    expect(storeImports.some((l) => l.includes("notifyReport"))).toBe(false);
    // 双向注入面：store 经 ScheduleIndexParser 取解析，执行器经 advanceLastRun 取推进（B1 值边清零）。
    expect(storeSrc.includes("ScheduleIndexParser")).toBe(true);
    expect(executorSrc.includes('"../schedule/interface.ts"')).toBe(true);
    expect(executorSrc.includes("advanceLastRun")).toBe(true);
    expect(executorSrc.includes("import { updateLastRun }")).toBe(false);
  });

  it("队列任务 meta 类型经 execute 门面（换源即红）", () => {
    expect(tasksSrc.includes('import type { ReportMeta } from "../execute/interface.ts";')).toBe(
      true,
    );
  });

  it("common 目录已消除（parse 单答案即单入口；复活即回退）", () => {
    expect(existsSync(join(srcDir, "domain2", "common", "interface.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "domain2", "common", "errsurf.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "domain2", "common"))).toBe(false);
  });

  it("report-index 类型直引同域物理定义（不经本域门面中转）", () => {
    expect(reportIndexSrc.includes('import type { ReportMeta } from "./generate.ts";')).toBe(true);
    expect(reportIndexSrc.includes("../execute/interface.ts")).toBe(false);
  });
});

describe("D3二 门面收口：interface 与实现同一引用（包装即红）", () => {
  it("parseReportIndexLines 同一引用", () => {
    expect(parseReportIndexLines).toBe(ImplParse);
  });

  it("readReportIndex 同一引用", () => {
    expect(readReportIndex).toBe(ImplRead);
  });

  it("prevWindowTotal 同一引用", () => {
    expect(prevWindowTotal).toBe(ImplPrev);
  });

  it("runDueReport 同一引用", () => {
    expect(runDueReport).toBe(ImplRun);
  });

  it("persistReport 同一引用", () => {
    expect(persistReport).toBe(ImplPersist);
  });

  it("reportHtmlFile/reportMetaFile 同一引用", () => {
    expect(reportHtmlFile).toBe(ImplHtml);
    expect(reportMetaFile).toBe(ImplMeta);
  });

  it("notifyReport/optionalNotifier 同一引用", () => {
    expect(notifyReport).toBe(ImplNotify);
    expect(optionalNotifier).toBe(ImplOptional);
  });

  it("测试钩子同一引用", () => {
    expect(__clearReportIndexCacheForTests).toBe(ImplClear);
    expect(__reportIndexCacheStatsForTests).toBe(ImplStats);
  });

  it("generate 面同一引用", () => {
    expect(generateReport).toBe(ImplGenerate);
    expect(applyPromptTemplate).toBe(ImplTemplate);
    expect(buildStatsSnapshot).toBe(ImplSnapshot);
    expect(PERIOD_BUCKETS).toBe(ImplBuckets);
  });

  it("reportBodyToHtml 同一引用", () => {
    expect(reportBodyToHtml).toBe(ImplBody);
  });

  it("makeDueReportExecutor 同一引用", () => {
    expect(makeDueReportExecutor).toBe(ImplExecutor);
  });

  it("makeListDirs 同一引用", () => {
    expect(makeListDirs).toBe(ImplListDirs);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    const codeLines = executeFaceSrc
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith("*"));
    expect(codeLines.some((l) => l.startsWith("export *"))).toBe(false);
  });

  it("包入口无 ForTests 收录（钩子已退入口：深路径直连，入口重收录即红）", () => {
    expect(applyFaceSrc.includes("ForTests")).toBe(false);
  });

  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(executeDepsNs)).toEqual([]);
  });

  it("命名接缝可用（类型链接 + 运行时形状）", () => {
    expect(typeof quietWarn("x")).toBe("undefined");
    expect(typeof testClock()).toBe("number");
  });
});

describe("D3三 读侧记忆化（stat 失效键，mkdtemp 隔离）", () => {
  const line = (period: string, key: string, generatedAt: number): string =>
    JSON.stringify({ period, key, startDay: key, endDay: key, generatedAt, ok: true }) + "\n";

  it("连续两次读只解析一次（缓存键命中：删缓存比较即 miss 递增必须红）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d3-memo-"));
    try {
      __clearReportIndexCacheForTests();
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(join(root, "reports", "index.jsonl"), line("daily", "2026-09-05", 2));
      const first = await readReportIndex(root);
      const second = await readReportIndex(root);
      expect(first).toEqual(second);
      expect(__reportIndexCacheStatsForTests()).toEqual({ hits: 1, misses: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("append 新行刷新缓存（旧投影残留必须红）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d3-memo-refresh-"));
    try {
      __clearReportIndexCacheForTests();
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(join(root, "reports", "index.jsonl"), line("daily", "2026-09-05", 2));
      expect((await readReportIndex(root)).length).toBe(1);
      appendFileSync(join(root, "reports", "index.jsonl"), line("daily", "2026-09-06", 3));
      const refreshed = await readReportIndex(root);
      expect(refreshed.length).toBe(2);
      expect(refreshed[0] === undefined ? undefined : refreshed[0].key).toBe("2026-09-06");
      expect(__reportIndexCacheStatsForTests().misses).toBe(2);
      await readReportIndex(root);
      expect(__reportIndexCacheStatsForTests()).toEqual({ hits: 1, misses: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("缺失文件不缓存（空表钉死必须红：两次读均 miss=0）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d3-memo-missing-"));
    try {
      __clearReportIndexCacheForTests();
      expect(await readReportIndex(root)).toEqual([]);
      expect(await readReportIndex(root)).toEqual([]);
      expect(__reportIndexCacheStatsForTests()).toEqual({ hits: 0, misses: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("坏行跳过（坏行入表必须红）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d3-memo-badline-"));
    try {
      __clearReportIndexCacheForTests();
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(
        join(root, "reports", "index.jsonl"),
        "not-json\n\n" + line("weekly", "2026-09-01", 5),
      );
      const list = await readReportIndex(root);
      expect(list.length).toBe(1);
      expect(list[0] === undefined ? undefined : list[0].period).toBe("weekly");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pollUntil 来自共享 helpers（自建等待面即红）", async () => {
    const ok = await pollUntil(() => true, 100, 5);
    expect(ok).toBe(true);
  });
});

describe("D3 时间纪律：无裸 sleep（裸 sleep 入文件必须红）", () => {
  it("本文件无裸 sleep 字面（等待面唯一是 helpers pollUntil）", () => {
    expect(ownSrc.includes(SLEEP_MARKER)).toBe(false);
    expect(ownSrc.includes('from "../../helpers.ts"')).toBe(true);
  });

  it("探针：脏输入必被 flag（detector 失明则本段先红）", () => {
    const dirty = ["await new Promise((r) => set", "Timeout(r, 200));"].join("");
    expect(dirty.includes(SLEEP_MARKER)).toBe(true);
  });

  it("探针：直连实现文件即被 flag", () => {
    const dirty = 'import { readReportIndex } from "../server/execute/runner.ts";';
    expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
  });

  it("探针：旧域引用即被 flag", () => {
    const dirty = 'import { parseReportIndexLines } from "../domain2/common/interface.ts";';
    expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
  });
});
