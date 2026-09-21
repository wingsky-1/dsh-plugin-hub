/**
 * dsh-provider-usage — integration：聚合域组合根四维度（#768 计划表 rev2 D8 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/aggregate 门面活装配）；落盘一律进
 * mkdtempSync 隔离目录（产物零污染）。四维度：
 * - D8一 经 server/aggregate 域门面装配：TrendTracker/TrendStore/聚合查询纯面只经
 *   server/aggregate/interface.ts，不走旧 domain2/aggregate 入口；apply/apply.ts、
 *   apply/index.ts、server/execute 四文件、server/ui-routes/trend.ts（#768 D12 起，
 *   前为 domain2/routes/ui.ts）的聚合消费收口新门面；
 *   门面禁整文件 re-export；包导出面（apply/index.ts 转发名）收窄后集合（B波）。
 * - D8二 derive/align 聚合查询纯面经门面复用（与 D2 deriveLastRun/alignLastRun 同形）：
 *   查询投影函数显式传参不接触 this；execute 经门面复用 metricValue 纯函数与
 *   TrendTracker 类型，不调业务实例（实例只由组合根构造、经参数传递）。
 * - D8三 deps 注入面窄面：AggregateWarn/AggregateClock/AggregateResolveCwd 命名接缝与
 *   块内联双生子（TrendTrackerOptions 保留内联函数类型，不 import type 本面）；
 *   deps.ts 纯类型面运行时零出口。
 * - D8四 随行修正与冻结：deletePromises 注解文本锁已迁 gate/verify-provider-usage-shape.mjs +
 *   A4(f) 补 dir
 *   （缺键只进 agg 面）+ forgetPersisted 删除（全仓单命中死代码）；
 *   store 多错语义与 resolveCwd/性能预留冻结不动（多错分支行为锁，不改语义）。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
import {
  TrendAggregator,
  TrendTracker,
  TrendStore,
  metricValue,
  weekStartKey,
  lastNWeekKeys,
  lastNMonthKeys,
  monthRange,
  weekRange,
  mergeAggRows,
  mergeDirRows,
  mergeHourRows,
} from "../../../src/server/aggregate/interface.ts";
import { TrendAggregator as ImplAggregator } from "../../../src/server/aggregate/aggregator.ts";
import { TrendTracker as ImplTracker } from "../../../src/server/aggregate/index.ts";
import { TrendStore as ImplStore } from "../../../src/server/aggregate/store.ts";
import {
  metricValue as ImplMetricValue,
  weekStartKey as ImplWeekStartKey,
  lastNWeekKeys as ImplLastNWeekKeys,
  lastNMonthKeys as ImplLastNMonthKeys,
  monthRange as ImplMonthRange,
  weekRange as ImplWeekRange,
} from "../../../src/server/aggregate/aggregate-query.ts";
import {
  mergeAggRows as ImplMergeAgg,
  mergeDirRows as ImplMergeDir,
  mergeHourRows as ImplMergeHour,
} from "../../../src/server/aggregate/aggregate-rows.ts";
import * as aggregateDepsNs from "../../../src/server/aggregate/deps.ts";
import type {
  AggregateWarn,
  AggregateClock,
  AggregateResolveCwd,
} from "../../../src/server/aggregate/deps.ts";
import { TREND_ROW_VERSION } from "../../../src/server/shared/interface.ts";
import { TrendCollector } from "../../../src/server/collect/interface.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const runnerSrc = readFileSync(join(srcDir, "server", "execute", "runner.ts"), "utf8");
const generateSrc = readFileSync(join(srcDir, "server", "execute", "generate.ts"), "utf8");
const listDirsSrc = readFileSync(join(srcDir, "server", "execute", "list-dirs.ts"), "utf8");
const executorSrc = readFileSync(join(srcDir, "server", "execute", "executor.ts"), "utf8");
const executeDepsSrc = readFileSync(join(srcDir, "server", "execute", "deps.ts"), "utf8");
const uiRoutesSrc = readFileSync(join(srcDir, "server", "ui-routes", "trend.ts"), "utf8");
const aggregateFaceSrc = readFileSync(join(srcDir, "server", "aggregate", "interface.ts"), "utf8");
const aggregateDepsSrc = readFileSync(join(srcDir, "server", "aggregate", "deps.ts"), "utf8");
const aggregatorSrc = readFileSync(join(srcDir, "server", "aggregate", "aggregator.ts"), "utf8");
const topologySrc = readFileSync(
  join(repoRoot, "scripts", "data", "mutation-topology.json"),
  "utf8",
);

/** 旧门面判据：任一旧 domain2/aggregate 引用残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain2/aggregate"]);
}

/**
 * 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：窄面在此复用名称。
 * resolveCwd 缺省不接 store（目录恒归未识别桶）；clock 固定推进可复现。
 */
const warnSeam: AggregateWarn = () => undefined;
const clockSeam: AggregateClock = () => 1_700_000_000_000;
const resolveCwdSeam: AggregateResolveCwd = () => undefined;

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});

describe("D8一 经 server/aggregate 域门面装配", () => {
  it("组合根与消费方只经新门面取聚合（旧入口残留必须红）", () => {
    for (const src of [
      applySrc,
      applyFaceSrc,
      runnerSrc,
      generateSrc,
      listDirsSrc,
      executorSrc,
      executeDepsSrc,
      uiRoutesSrc,
      aggregateFaceSrc,
      aggregateDepsSrc,
    ]) {
      expect(usesOldFace(src)).toBe(false);
    }
    expect(applySrc.includes("server/aggregate/interface")).toBe(true);
    expect(applyFaceSrc.includes("server/aggregate/interface")).toBe(true);
    expect(runnerSrc.includes("../aggregate/interface")).toBe(true);
    // #768 A波5：metricValue 已下沉 shared，generate 不再经 aggregate 门面（经 shared 纯面）
    expect(generateSrc.includes("../aggregate/interface")).toBe(false);
    expect(generateSrc.includes("../shared/interface")).toBe(true);
  });

  it("门面收口：interface 与实现同一引用（包装即红）", () => {
    expect(TrendAggregator).toBe(ImplAggregator);
    expect(TrendTracker).toBe(ImplTracker);
    expect(TrendStore).toBe(ImplStore);
    expect(metricValue).toBe(ImplMetricValue);
    expect(weekStartKey).toBe(ImplWeekStartKey);
    expect(lastNWeekKeys).toBe(ImplLastNWeekKeys);
    expect(lastNMonthKeys).toBe(ImplLastNMonthKeys);
    expect(monthRange).toBe(ImplMonthRange);
    expect(weekRange).toBe(ImplWeekRange);
    expect(mergeAggRows).toBe(ImplMergeAgg);
    expect(mergeDirRows).toBe(ImplMergeDir);
    expect(mergeHourRows).toBe(ImplMergeHour);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    for (const src of [aggregateFaceSrc, aggregateDepsSrc]) {
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
      expect(hasExportStar(codeLines)).toBe(false);
    }
  });

  it("门面值出口恰为 12 项（多一项即公共面膨胀）", async () => {
    const faceNs = await import("../../../src/server/aggregate/interface.ts");
    expect(Object.keys(faceNs).sort()).toEqual(
      [
        "TrendAggregator",
        "TrendTracker",
        "TrendStore",
        "metricValue",
        "weekStartKey",
        "lastNWeekKeys",
        "lastNMonthKeys",
        "monthRange",
        "weekRange",
        "mergeAggRows",
        "mergeDirRows",
        "mergeHourRows",
      ].sort(),
    );
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    for (const p of [
      "src/domain2/aggregate/aggregator.ts",
      "src/domain2/aggregate/aggregate-rows.ts",
      "src/domain2/aggregate/aggregate-query.ts",
      "src/domain2/aggregate/store.ts",
      "src/domain2/aggregate/index.ts",
    ]) {
      expect(topologySrc.includes(p)).toBe(false);
    }
    for (const p of [
      "src/server/aggregate/aggregator.ts",
      "src/server/aggregate/aggregate-rows.ts",
      "src/server/aggregate/aggregate-query.ts",
      "src/server/aggregate/store.ts",
      "src/server/aggregate/index.ts",
    ]) {
      expect(topologySrc.includes(p)).toBe(true);
    }
  });
});

describe("D8二 derive/align 聚合查询纯面经门面复用", () => {
  it("metricValue 纯面活可用（total = 四项 token 之和；删调用即红）", () => {
    expect(
      metricValue(
        {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          calls: 9,
          turns: 0,
          toolCalls: 0,
        },
        "total",
      ),
    ).toBe(10);
    expect(
      metricValue(
        {
          input: null,
          output: 5,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
          turns: 0,
          toolCalls: 0,
        },
        "total",
      ),
    ).toBe(5);
  });

  it("mergeDirRows 同键累加经门面可达（迟到旧日行二次压实防丢防重）", () => {
    const day = "2026-09-04";
    const base = [
      {
        v: TREND_ROW_VERSION,
        kind: "dir" as const,
        day,
        dir: "x",
        input: 1,
        output: 1,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ];
    const merged = mergeDirRows(base, base);
    expect(merged).toHaveLength(1);
    expect(merged[0].input).toBe(2);
    expect(merged[0].calls).toBe(2);
  });
});

describe("D8三 deps 注入面窄面", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(aggregateDepsNs)).toEqual([]);
  });

  it("工厂漏传抛错（运行时锁，空实现即红）", async () => {
    const dir = isolatedDir("dou-aggD8-guard-");
    await expect(
      TrendTracker.start({ root: dir } as unknown as Parameters<typeof TrendTracker.start>[0]),
    ).rejects.toThrow("缺少 makeCollector");
  });

  it("命名接缝装配 TrendTracker（改名断链即红；落盘走隔离目录）", async () => {
    const dir = isolatedDir("dou-aggD8-");
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root: dir,
      now: clockSeam,
      flushDebounceMs: 60000,
      warn: warnSeam,
      resolveCwd: resolveCwdSeam,
    });
    expect(tracker.stats()).toEqual({
      days: 0,
      pendingRows: 0,
      unpersistedRows: 0,
      lastFlushAt: null,
    });
    await tracker.dispose();
  });
});

describe("D8四 随行修正与冻结", () => {
  it("tmp 残留清理成功分支：残留删、主写成（删清理即红）", async () => {
    const dir = isolatedDir("dou-aggD8-tmp-");
    const day = "2026-09-04";
    const store = new TrendStore({ root: dir });
    mkdirSync(join(dir, "agg"), { recursive: true });
    writeFileSync(join(dir, "agg", `${day}.jsonl.123.tmp`), "stale\n");
    const warns: string[] = [];
    const store2 = new TrendStore({ root: dir, warn: (m) => warns.push(m) });
    await store2.writeAggDay(day, [
      {
        v: TREND_ROW_VERSION,
        kind: "agg" as const,
        day,
        provider: "pv",
        model: null,
        input: 1,
        output: 2,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ]);
    expect(warns).toEqual([]);
    expect(await store.readAggDayShard(day)).toHaveLength(1);
  });

  it("store 多错语义冻结：清理失败仅 warn、主写照常推进（吞错/抛错即红）", async () => {
    const dir = isolatedDir("dou-aggD8-multi-");
    const day = "2026-09-04";
    // 非空目录冒充 tmp 残留：无 recursive 的 rm 必拒（清理失败分支可复现）。
    const badTmp = join(dir, "agg", `${day}.jsonl.456.tmp`);
    mkdirSync(badTmp, { recursive: true });
    writeFileSync(join(badTmp, "inner.txt"), "x");
    const warns: string[] = [];
    const store = new TrendStore({ root: dir, warn: (m) => warns.push(m) });
    await store.writeAggDay(day, [
      {
        v: TREND_ROW_VERSION,
        kind: "agg" as const,
        day,
        provider: "pv",
        model: null,
        input: 7,
        output: 8,
        cacheRead: null,
        cacheWrite: null,
        calls: 2,
        turns: 1,
        toolCalls: 1,
      },
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("tmp");
    const rows = await store.readAggDayShard(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(2);
  });

  it("forgetPersisted 已删除（定义残留/原型残留即红）", () => {
    expect(aggregatorSrc.includes("forgetPersisted")).toBe(false);
    expect("forgetPersisted" in TrendAggregator.prototype).toBe(false);
  });
});

describe("探针：detector 失明则本段先红", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace("import { x } from ../domain2/aggregate/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../server/aggregate/interface.ts")).toBe(false);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(["export * from ./store.ts"])).toBe(true);
    expect(hasExportStar(["export { a } from ./store.ts"])).toBe(false);
  });
});
