/**
 * dsh-provider-usage — integration：调度域组合根三维度（#768 计划表 rev2 D2 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/schedule 门面活装配），落盘一律进
 * mkdtemp 隔离目录（产物零污染）。三维度（对应任务书“组合根经门面消费”）：
 * - D2一 经域门面装配：ReportScheduler/ReportTaskQueue/lastRun 原语只经
 *   server/schedule/interface.ts，不直连域实现文件（due/scheduler/tasks/store），
 *   不走旧 domain2 入口；execute/routes/upgrade 的调度消费同样收口本门面；
 * - D2二 根内无业务判断：apply/ 装配逻辑内不得出现候选窗口/幂等/
 *   lastRun 读写链调用与 schema 常量（构造 + 提交 + 热更回调是装配，不算判断）；
 * - D2三 串行执行（锁）+ 轮询/预热汇入 getStats：队列尾链串行与同窗口去重、
 *   per-root 链防 lost-update、默认 60s tick 与 5min 预热线路保持——拆坏任一条必须红
 *   （同文件“探针 + 朴素实现对照”证明 detector 不失明）。
 *
 * 扫描面 = src/apply/apply.ts（装配逻辑；#768 D13 删空锚点 src/apply/interface.ts，模块归属随锚点消除）
 * + 各消费方源文件（执行器/读侧/路由/迁移）：src/apply/index.ts 是 lib 导出面
 * （符号转发），不是判断——它的符号集由 export-surface-snapshot 门禁锁定，
 * 不在本用例扫描面内（误扫即把转发当判断）。
 *
 * 每条附判据句（把 X 改坏必须红）；红证明见同文件“探针：脏输入必被 flag”与
 * “对照：朴素实现丢更新（链断即丢）”——同一 detector 在脏夹具上必须报出
 * 违规，detector 失明则探针先红。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  ReportScheduler,
  ReportTaskQueue,
  readLastRun,
  writeLastRun,
  updateLastRun,
  ensureLastRunMigrated,
  candidateWindow,
  pendingReports,
  beginAttempt as ImplBeginAttempt,
  createRetryLedger,
  createReportStateCoordinator,
  type RetryLedgerOptions,
  type RetryLedgerPort,
} from "../../../src/server/schedule/interface.ts";
import { LAST_RUN_SCHEMA } from "../../../src/server/shared/interface.ts";
import { ReportScheduler as ImplScheduler } from "../../../src/server/schedule/scheduler.ts";
import { ReportTaskQueue as ImplQueue } from "../../../src/server/schedule/tasks.ts";
import {
  readLastRun as ImplRead,
  writeLastRun as ImplWrite,
  updateLastRun as ImplUpdate,
} from "../../../src/server/schedule/store.ts";
import {
  candidateWindow as ImplCandidate,
  pendingReports as ImplPending,
} from "../../../src/server/schedule/due.ts";
import { beginAttempt as RetryPolicyBeginAttempt } from "../../../src/server/schedule/retry-policy.ts";
import { createRetryLedger as ImplCreateRetryLedger } from "../../../src/server/schedule/retry-ledger.ts";
import { LAST_RUN_SCHEMA as ImplSchema } from "../../../src/server/shared/last-run.ts";
import * as scheduleDepsNs from "../../../src/server/schedule/deps.ts";
import type {
  ScheduleClock,
  ScheduleIndexParser,
  ScheduleWarn,
} from "../../../src/server/schedule/deps.ts";
import {
  parseReportIndexLines,
  readReportIndex,
  __clearReportIndexCacheForTests,
} from "../../../src/server/execute/interface.ts";
import { apply } from "../../../src/apply/index.ts";
import { normalizeReportConfig } from "../../../src/server/config/interface.ts";
import type { ReportPeriod } from "../../../src/server/config/interface.ts";
import type { ReportTaskInput } from "../../../src/server/schedule/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/shared/config.ts";

/** 台账条目与 claim 入参：形状由端口签名推导，端口改了这里跟着红（勿手写镜像类型）。 */
type LedgerEntry = NonNullable<Awaited<ReturnType<RetryLedgerPort["get"]>>>;
type BeginAttemptInput = Parameters<RetryLedgerPort["beginAttempt"]>[0];

/**
 * claim 入参：已有条目沿用它自己的 route 与 cycleId（续同一次 claim），没有条目才拿本次
 * route 新开。「续用还是新开」正是 force cycle 归属的核心断言，混在 executor 里读不出来。
 */
function claimInputFor(
  input: ReportTaskInput,
  existing: LedgerEntry | undefined,
  route: BeginAttemptInput["route"],
): BeginAttemptInput {
  return {
    period: input.period,
    key: input.key,
    startDay: input.startDay,
    endDay: input.endDay,
    route: existing?.route ?? route,
    ...(existing === undefined ? {} : { cycleId: existing.cycleId }),
  };
}

/**
 * 任务完成里程碑：K0/K2 各放行一个闸门；K1 只有 force 才放行——normal 的 K1 被队列吞掉时
 * 根本不会走到 executor，放行了就是时序造错了。
 */
function signalMilestone(
  input: ReportTaskInput,
  keys: { K0: string; K1: string; K2: string },
  marks: { k0: () => void; k2: () => void; force: () => void },
): void {
  if (input.key === keys.K0) marks.k0();
  if (input.key === keys.K2) marks.k2();
  if (input.key === keys.K1 && input.force === true) marks.force();
}

interface ApplyTestContext {
  ctx: Parameters<typeof apply>[0];
  disposers: Array<() => void | Promise<void>>;
}

/** 真实 apply 组合根的最小宿主面；仅收集 effect disposer，不替调度器做判定。 */
function makeApplyTestContext(): ApplyTestContext {
  const disposers: Array<() => void | Promise<void>> = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: {
      register: (_route: Record<string, unknown>) => () => {},
    },
    on: () => () => {},
    llm: {
      listProviders: () => [],
    },
    fiber: { state: "active" },
    inject: (_deps: unknown, callback: (service: unknown) => void) => {
      callback({ settings: {} });
    },
    effect: (fn: () => unknown) => {
      const disposer = fn();
      if (typeof disposer === "function") {
        disposers.push(disposer as () => void | Promise<void>);
      }
      return typeof disposer === "function" ? disposer : () => {};
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], disposers };
}

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applySrcFlat = applySrc.replace(/\s+/g, " ").replace(/,\s*}/g, " }");
const indexSrc = readFileSync(join(srcDir, "index.ts"), "utf8");
const applyIndexSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const retryPolicySrc = readFileSync(join(srcDir, "server", "schedule", "retry-policy.ts"), "utf8");
const retryLedgerSrc = readFileSync(join(srcDir, "server", "schedule", "retry-ledger.ts"), "utf8");
// #768 D13：空锚点 src/apply/interface.ts 已删，扫描面只剩 apply.ts（本文件不再读该路径）。
const schedulerSrc = readFileSync(join(srcDir, "server", "schedule", "scheduler.ts"), "utf8");
const storeSrc = readFileSync(join(srcDir, "server", "schedule", "store.ts"), "utf8");
// #768 D13：domain2/common/ 目录已消除（消费者全切 server/shared 门面），本文件不再读旧门面。
const executorSrc = readFileSync(join(srcDir, "server", "execute", "executor.ts"), "utf8");
const runnerSrc = readFileSync(join(srcDir, "server", "execute", "runner.ts"), "utf8");
const reportsSrc = readFileSync(join(srcDir, "server", "report-routes", "reports.ts"), "utf8");
const morphSrc = readFileSync(join(srcDir, "server", "upgrade", "last-run-morph.ts"), "utf8");
const storageLayoutSrc = readFileSync(
  join(srcDir, "server", "upgrade", "storage-layout.ts"),
  "utf8",
);

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
const quietWarn: ScheduleWarn = () => undefined;
const testClock: ScheduleClock = () => Date.now();
/**
 * C 波端口锚定（tsc 双向锁定可赋值性，误配即编译红）：
 * 真实现可赋给端口（execute→schedule 注入方向），端口输出可喂推导。
 */
const scheduleParser: ScheduleIndexParser = parseReportIndexLines;

/** 根内禁入业务判断标记：判据 = 任一标记进入 apply.ts 即红（#768 D13 起 interface.ts 锚点已删）。 */
const BUSINESS_MARKERS = [
  { marker: "candidateWindow(", why: "候选窗口纯函数归调度域，组合根只提交到期回调" },
  { marker: "pendingReports(", why: "到期集合计算归调度器 tick，根内不得重算" },
  { marker: "presetLastRunForNewlyEnabled(", why: "扣期预置纯函数归路由写侧，根内不得直调" },
  { marker: "previousClosedWindow(", why: "手动窗口锚定归路由写侧，根内不得直调" },
  { marker: "deriveLastRun(", why: "index 推导归调度域（迁移与校准两路同源）" },
  { marker: "alignLastRun(", why: "温和校准同上" },
  { marker: "isClosedWindowRecord(", why: "闭环判定同上" },
  { marker: "readLastRun(", why: "lastRun 读面归调度域门面，根内不得直读" },
  { marker: "writeLastRun(", why: "lastRun 写面同上" },
  { marker: "updateLastRun(", why: "per-root 链唯一入口，根内不得绕过" },
  { marker: "ensureLastRunMigrated(", why: "启动校准归调度器内部，根内不得直调" },
  { marker: "LAST_RUN_SCHEMA", why: "schema 唯一定义在调度域，根内不得复述" },
  { marker: "lastRunChainByRoot", why: "per-root 链状态封在调度域 store 内" },
];

/** 装配面禁直连：判据 = 任一实现路径进入组合根 import 即红。 */
const FORBIDDEN_FACES = [
  "domain2/schedule",
  "domain2/common/last-run",
  "server/schedule/due",
  "server/schedule/scheduler",
  "server/schedule/tasks",
  "server/schedule/store",
  "server/schedule/deps",
  "schedule/config",
  "report-config-service",
];

describe("D2一 经 server/schedule 域门面装配", () => {
  it("调度器经同一门面进入（分头 import 即红）", () => {
    expect(
      applySrcFlat.includes(
        'import { ReportScheduler, createReportStateCoordinator, createRetryLedger } from "../server/schedule/interface.ts";',
      ),
    ).toBe(true);
  });

  it("队列经同一门面进入", () => {
    expect(
      applySrc.includes('import { ReportTaskQueue } from "../server/schedule/interface.ts";'),
    ).toBe(true);
  });

  for (const face of FORBIDDEN_FACES) {
    it("组合根不直连 " + face, () => {
      expect(applySrc.includes(face)).toBe(false);
    });
  }

  it("执行器的推进经注入（B1 值边清零，不走旧 common 入口）", () => {
    expect(executorSrc.includes('"../schedule/interface.ts"')).toBe(true);
    expect(executorSrc.includes("advanceLastRun")).toBe(true);
    expect(executorSrc.includes("import { updateLastRun }")).toBe(false);
    expect(executorSrc.includes("domain2/schedule")).toBe(false);
    expect(executorSrc.includes("common/interface")).toBe(false);
  });

  it("读侧 DueReport 类型经调度门面（index 解析归本域同级文件）", () => {
    expect(runnerSrc.includes('"../schedule/interface.ts"')).toBe(true);
    expect(runnerSrc.includes('"./report-index.ts"')).toBe(true);
    expect(runnerSrc.includes("common/interface")).toBe(false);
  });

  it("路由写侧经注入（B1 值边清零，同级短径，不走旧深径）", () => {
    expect(reportsSrc.includes('"../schedule/interface.ts"')).toBe(true);
    expect(reportsSrc.includes("context.presetLastRunForNewlyEnabled")).toBe(true);
    expect(reportsSrc.includes("import { presetLastRunForNewlyEnabled")).toBe(false);
    expect(reportsSrc.includes("../../server/schedule")).toBe(false);
    expect(reportsSrc.includes("domain2/schedule")).toBe(false);
    expect(reportsSrc.includes("../common/interface")).toBe(false);
  });

  it("迁移步纯函数经共享门面（#768 A波4 下沉 shared，不调业务实例）", () => {
    expect(morphSrc.includes('"../shared/interface.ts"')).toBe(true);
    expect(morphSrc.includes('"../schedule/interface.ts"')).toBe(false);
    expect(morphSrc.includes("domain2/schedule")).toBe(false);
    const morphImports = morphSrc
      .split(String.fromCharCode(10))
      .filter((l) => l.startsWith("import"));
    expect(morphImports.some((l) => l.includes("readLastRun"))).toBe(false);
    expect(morphImports.some((l) => l.includes("updateLastRun"))).toBe(false);
    expect(morphImports.some((l) => l.includes("ensureLastRunMigrated"))).toBe(false);
  });

  it("存储布局的空落盘 schema 与共享域同源（#768 A波4 单一定义）", () => {
    expect(storageLayoutSrc.includes('"../shared/interface.ts"')).toBe(true);
    expect(storageLayoutSrc.includes("LAST_RUN_SCHEMA")).toBe(true);
  });

  it("common 目录已消除（旧门面残留即回退）", () => {
    expect(existsSync(join(srcDir, "domain2", "common", "interface.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "domain2", "common", "errsurf.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "domain2", "common"))).toBe(false);
  });
});

describe("D2二 根内无业务判断（必须红）", () => {
  for (const entry of BUSINESS_MARKERS) {
    it("apply.ts 无 " + entry.marker + "（" + entry.why + "）", () => {
      expect(applySrc.includes(entry.marker)).toBe(false);
    });
  }
});

describe("D2 门面收口：interface 与实现同一引用（包装即红）", () => {
  it("ReportScheduler 同一引用", () => {
    expect(ReportScheduler).toBe(ImplScheduler);
  });

  it("ReportTaskQueue 同一引用", () => {
    expect(ReportTaskQueue).toBe(ImplQueue);
  });

  it("readLastRun 同一引用", () => {
    expect(readLastRun).toBe(ImplRead);
  });

  it("writeLastRun 同一引用", () => {
    expect(writeLastRun).toBe(ImplWrite);
  });

  it("updateLastRun 同一引用", () => {
    expect(updateLastRun).toBe(ImplUpdate);
  });

  it("candidateWindow 与 pendingReports 同一引用", () => {
    expect(candidateWindow).toBe(ImplCandidate);
    expect(pendingReports).toBe(ImplPending);
  });

  it("LAST_RUN_SCHEMA 同值（当期版本 2）", () => {
    expect(LAST_RUN_SCHEMA).toBe(ImplSchema);
    expect(LAST_RUN_SCHEMA).toBe(2);
  });

  it("retry policy 同一引用且零 Node 依赖", () => {
    expect(ImplBeginAttempt).toBe(RetryPolicyBeginAttempt);
    expect(retryPolicySrc.includes("node:")).toBe(false);
  });

  it("retry ledger factory 同一引用且可赋给包内 port", () => {
    const factory: (root: string, options?: RetryLedgerOptions) => RetryLedgerPort =
      createRetryLedger;
    const port = factory(join(tmpdir(), "d2-retry-ledger-not-created"));

    expect(factory).toBe(ImplCreateRetryLedger);
    expect(typeof port.beginAttempt).toBe("function");
    expect(typeof port.recordFailure).toBe("function");
    expect(typeof port.reconcile).toBe("function");
  });

  it("schedule ledger 不值引 registry，根入口不导出 retry ledger", () => {
    expect(retryLedgerSrc.includes("server/registry")).toBe(false);
    expect(indexSrc.includes("retry-ledger")).toBe(false);
    expect(indexSrc.includes("RetryLedger")).toBe(false);
    expect(applyIndexSrc.includes("retry-ledger")).toBe(false);
    expect(applyIndexSrc.includes("RetryLedger")).toBe(false);
  });

  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(scheduleDepsNs)).toEqual([]);
  });

  it("命名接缝可用（类型链接 + 运行时形状）", () => {
    expect(typeof quietWarn("x")).toBe("undefined");
    expect(typeof testClock()).toBe("number");
  });
});

describe("D2三-锁 队列串行 + 去重（拆坏尾链必须红）", () => {
  it("B 不越过 A：后提交的任务在前任务挂起期间不启动", async () => {
    const order: string[] = [];
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const q = new ReportTaskQueue({
      executor: async (input: ReportTaskInput) => {
        order.push("start-" + input.key);
        if (input.key === "K1") await gateA;
        order.push("end-" + input.key);
        return {};
      },
      warn: quietWarn,
    });
    const ra = q.submit({ period: "daily", key: "K1", startDay: "K1", endDay: "K1" });
    const rb = q.submit({ period: "daily", key: "K2", startDay: "K2", endDay: "K2" });
    expect(rb.existing).toBe(false);
    await pollUntil(() => order.includes("start-K1"), 3000);
    expect(order).toEqual(["start-K1"]);
    releaseA();
    await pollUntil(
      () => q.get(ra.taskId)?.status === "done" && q.get(rb.taskId)?.status === "done",
      5000,
    );
    expect(order).toEqual(["start-K1", "end-K1", "start-K2", "end-K2"]);
  });

  it("同窗口重复提交去重：同一 taskId + 只执行一次", async () => {
    const calls: string[] = [];
    const q = new ReportTaskQueue({
      executor: async (input: ReportTaskInput) => {
        calls.push(input.key);
        return {};
      },
      now: testClock,
      warn: quietWarn,
    });
    const first = q.submit({ period: "weekly", key: "W1", startDay: "W1", endDay: "W1" });
    const second = q.submit({ period: "weekly", key: "W1", startDay: "W1", endDay: "W1" });
    expect(first.existing).toBe(false);
    expect(second.taskId).toBe(first.taskId);
    expect(second.existing).toBe(true);
    await pollUntil(() => q.get(first.taskId)?.status === "done", 5000);
    expect(calls).toEqual(["W1"]);
  });
});

it("对照：无尾链的朴素队列在同一门控下交错（证明串行断言不失明）", async () => {
  const order: string[] = [];
  let releaseA: () => void = () => undefined;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const runUnchained = async (key: string): Promise<void> => {
    order.push("start-" + key);
    if (key === "K1") await gateA;
    order.push("end-" + key);
  };
  const pa = runUnchained("K1");
  await pollUntil(() => order.includes("start-K1"), 3000);
  const pb = runUnchained("K2");
  expect(order).toEqual(["start-K1", "start-K2", "end-K2"]);
  releaseA();
  await Promise.all([pa, pb]);
  expect(order).toEqual(["start-K1", "start-K2", "end-K2", "end-K1"]);
});

describe("D2三-链 per-root 链防 lost-update（拆坏链必须红）", () => {
  it("并发 patch 按提交序串行落盘（A 与 B 双双在场）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d2-chain-"));
    try {
      await writeLastRun(root, { daily: "2026-01-01" });
      let releaseP1: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseP1 = resolve;
      });
      const p1 = updateLastRun(root, async (cur) => {
        await gate;
        return { ...cur, daily: "A" };
      });
      const p2 = updateLastRun(root, (cur) => ({ ...cur, weekly: "B" }));
      await pollUntil(() => true, 50);
      releaseP1();
      await Promise.all([p1, p2]);
      expect(await readLastRun(root)).toEqual({ daily: "A", weekly: "B" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("对照：朴素读-改-写在同一交错下丢更新（证明本 detector 不失明）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d2-naive-"));
    try {
      await writeLastRun(root, { daily: "2026-01-01" });
      let n1ReadObserved = false;
      let releaseN1: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseN1 = resolve;
      });
      const naive = async (
        patch: (
          cur: Partial<Record<ReportPeriod, string>>,
        ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
        hold: boolean,
      ): Promise<void> => {
        const cur = await readLastRun(root);
        if (hold) {
          n1ReadObserved = true;
          await gate;
        }
        await writeLastRun(root, await patch(cur));
      };
      const n1p = naive(async (cur) => ({ ...cur, daily: "A" }), true);
      await pollUntil(() => n1ReadObserved, 3000);
      await naive((cur) => ({ ...cur, weekly: "B" }), false);
      releaseN1();
      await n1p;
      const fin = await readLastRun(root);
      expect(fin.daily).toBe("A");
      expect(fin.weekly).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("D2三-链 ensure经链：校准与并发推进交错不丢更新（#771⑧）", () => {
  it("store 经 per-root 链落盘（直写即回退）", () => {
    const body = storeSrc.slice(storeSrc.indexOf("export async function ensureLastRunMigrated"));
    expect(body.includes("await updateLastRun(root")).toBe(true);
    expect(body.includes("await writeLastRun(root, after)")).toBe(false);
  });

  it("启动仍先校准后首轮（删调用即回退）", () => {
    expect(schedulerSrc.includes("ensureLastRunMigrated(s.root, s.warn, s.parseIndex)")).toBe(true);
  });

  it("调度器经端口透传解析（直取引擎门面即回退）", () => {
    expect(schedulerSrc.includes("parseIndex")).toBe(true);
    expect(schedulerSrc.includes("execute/interface")).toBe(false);
  });

  it("交错窗：校准与并发推进双双在场（只断言收敛）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d2-ensure-chain-"));
    try {
      await writeLastRun(root, { daily: "seed" });
      // schema 新但 daily 被旧污染键遮蔽；monthly 是预置键
      // （index 无对应记录，校准须保留）；index 仅 daily 闭环记录。
      writeFileSync(
        join(root, "reports", "last-run.json"),
        JSON.stringify({
          daily: "2026-09-06",
          monthly: "2026-08",
          schema: LAST_RUN_SCHEMA,
        }),
      );
      const genAt = new Date(2026, 8, 7, 6, 0, 0).getTime();
      writeFileSync(
        join(root, "reports", "index.jsonl"),
        `${JSON.stringify({
          period: "daily",
          key: "2026-09-04",
          startDay: "2026-09-04",
          endDay: "2026-09-04",
          generatedAt: genAt,
          ok: true,
        })}\n`,
      );
      let started = false;
      let releaseGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      // 先占链并在 patch 内挂起：校准 patch 排到后面（#764 式交错窗）。
      const holder = updateLastRun(root, async (cur) => {
        started = true;
        await gate;
        return { ...cur, weekly: "B" };
      });
      await pollUntil(() => started, 3000);
      const ensuring = ensureLastRunMigrated(root, quietWarn, scheduleParser);
      await pollUntil(() => true, 50);
      releaseGate();
      const res = await ensuring;
      await holder;
      const fin = await readLastRun(root);
      expect(res.changed).toBe(true);
      expect(res.after.daily).toBe("2026-09-04");
      // 收敛断言：校准值 + 并发值 + 预置键三方在场；本窗不断言丢失。
      expect(fin).toEqual({
        daily: "2026-09-04",
        weekly: "B",
        monthly: "2026-08",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("启动时序：旧 schema 校准落盘且首轮补跑正常", async () => {
    const root = mkdtempSync(join(tmpdir(), "d2-ensure-start-"));
    try {
      await writeLastRun(root, { daily: "seed" });
      writeFileSync(
        join(root, "reports", "last-run.json"),
        JSON.stringify({ daily: "2026-09-06" }),
      );
      const genAt = new Date(2026, 8, 7, 6, 0, 0).getTime();
      writeFileSync(
        join(root, "reports", "index.jsonl"),
        `${JSON.stringify({
          period: "daily",
          key: "2026-09-04",
          startDay: "2026-09-04",
          endDay: "2026-09-04",
          generatedAt: genAt,
          ok: true,
        })}\n`,
      );
      const seen: Array<{ period: string; key: string }> = [];
      const sched = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
          monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
        }),
        onDue: async (due) => {
          seen.push({ period: due.period, key: due.key });
        },
        tickMs: 20,
        warn: quietWarn,
        // C 波：启动校准的 index 解析经端口注入（缺端口视同无事实）。
        parseIndex: scheduleParser,
      });
      try {
        await pollUntil(() => seen.length >= 1, 5000);
        expect(seen[0]?.period).toBe("daily");
        // 污染键已回退到最近已闭环键，schema 已升版。
        expect((await readLastRun(root)).daily).toBe("2026-09-04");
        const raw = JSON.parse(readFileSync(join(root, "reports", "last-run.json"), "utf8"));
        expect(raw.schema).toBe(LAST_RUN_SCHEMA);
      } finally {
        sched.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
describe("D2三-轮询 60s tick + 5min 预热汇入 getStats（改坏默认/断线必须红）", () => {
  it("调度器默认 tick 60s（源码标记保持）", () => {
    expect(schedulerSrc.includes("?? 60_000")).toBe(true);
  });

  it("首轮 tick 即补跑：仅 daily 启用时一次 due（经门面活装配，短 tickMs）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d2-tick-"));
    try {
      const seen: Array<{ period: string; key: string }> = [];
      const sched = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
          monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
        }),
        onDue: async (due) => {
          seen.push({ period: due.period, key: due.key });
        },
        tickMs: 20,
        warn: quietWarn,
      });
      try {
        await pollUntil(() => seen.length >= 1, 5000);
        expect(seen[0]?.period).toBe("daily");
      } finally {
        sched.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("预热默认 5min（300000）", () => {
    expect(DEFAULT_CONFIG.warmupIntervalMs).toBe(300_000);
  });

  it("store 零跨域值导入：解析经 ScheduleDeps 端口注入（C 波单向化）", () => {
    // 调度→执行方向不再有值边（直引即环复活）：execute 门面引用彻底消失。
    expect(storeSrc.includes("execute")).toBe(false);
    expect(storeSrc.includes("parseReportIndexLines")).toBe(false);
    const storeImports = storeSrc
      .split(String.fromCharCode(10))
      .filter((l) => l.startsWith("import"));
    expect(storeImports.some((l) => l.includes("domain2/schedule"))).toBe(false);
    expect(storeImports.some((l) => l.includes("domain2/common"))).toBe(false);
  });

  it("store 经端口取解析（类型边，不入值图）", () => {
    expect(storeSrc.includes("ScheduleIndexParser")).toBe(true);
    expect(storeSrc.includes('import type { ScheduleIndexParser } from "./deps.ts";')).toBe(true);
    expect(storeSrc.includes("parseIndex === undefined")).toBe(true);
  });

  it("组合根装配期注入真实现（换源／漏接线即红）", () => {
    expect(
      applySrcFlat.includes(
        'import { optionalNotifier, parseReportIndexLines, resolveGenerateRoute } from "../server/execute/interface.ts";',
      ),
    ).toBe(true);
    expect(applySrcFlat.includes("parseIndex: parseReportIndexLines")).toBe(true);
  });
});

describe("探针：脏输入必被 flag（detector 失明则本段先红）", () => {
  it("根内调度纯函数调用即被 flag", () => {
    const dirty = "const due = candidateWindow(period, cfg, now);";
    expect(BUSINESS_MARKERS.some((b) => dirty.includes(b.marker))).toBe(true);
  });

  it("根内 lastRun 直写即被 flag", () => {
    const dirty = "await updateLastRun(root, (cur) => ({ ...cur, daily: key }));";
    expect(BUSINESS_MARKERS.some((b) => dirty.includes(b.marker))).toBe(true);
  });

  it("直连实现文件即被 flag", () => {
    const dirty = 'import { ReportScheduler } from "../server/schedule/scheduler.ts";';
    expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
  });

  it("直连旧域即被 flag", () => {
    const dirty = 'import { pendingReports } from "../domain2/schedule/interface.ts";';
    expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
  });

  it("真实装配文本注入一行调度判断即被 flag（免洗 repo）", () => {
    const injected = [applySrc, "const due = pendingReports(cfg, Date.now(), {});", ""].join(
      String.fromCharCode(10),
    );
    const hits = BUSINESS_MARKERS.filter((b) => injected.includes(b.marker)).map((b) => b.marker);
    expect(hits).toEqual(["pendingReports("]);
  });

  it("60s 默认被改即被 flag（detector 对标记有效）", () => {
    const dirty = "this.tickMs = opts.tickMs ?? 30_000;";
    expect(dirty.includes("?? 60_000")).toBe(false);
    expect(schedulerSrc.includes("?? 60_000")).toBe(true);
  });
});

describe("D3三-轮询否定 toFake 面（#768 计划表 rev2 D3 验收）", () => {
  // 时间纪律（testing skill §4）：显式声明 toFake 面，只伪造轮询定时器
  // （setInterval/clearInterval），Date 与 setTimeout 保持真实——pollUntil 的
  // 截止读真实 Date.now()，钉死 Date 它永不超时；pollUntil 内部 setTimeout
  // 保持真实才能推进等待。裸 sleep（固定时长后断言未发生）在慢盘下必然 flake，
  // 此处禁用：本文件时间纪律用例锁定无裸 sleep 字面（见末段自扫）。
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispose 后轮询停止：假时钟推进 5 个 tick 无新增到期提交", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const root = mkdtempSync(join(tmpdir(), "d3-poll-neg-"));
    try {
      const seen: Array<{ period: string; key: string }> = [];
      const sched = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
          monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
        }),
        onDue: async (due) => {
          seen.push({ period: due.period, key: due.key });
        },
        tickMs: 30,
        warn: quietWarn,
      });
      try {
        // 首达确定性（#962 flake 实证 run 35803984163：50 轮纯假时钟推进后
        // 直接断言，tick() 的 readLastRun/onDue 在飞 promise 未落定即判 seen>=1，
        // 慢盘下 `expected 0 to be >= 1` 干跑失败）。启动补跑 tick 走真实 promise
        // 链（不依赖假时钟），interval tick 的异步体同样需真实事件循环落定——
        // 每轮推进后用真实 pollUntil（Date/setTimeout 保持真实，见本段头注释）
        // 排空在飞 tick，可观测量收敛才断言；不用裸 sleep 假设静默。
        for (let i = 0; i < 50 && seen.length < 1; i += 1) {
          if (i > 0) await vi.advanceTimersByTimeAsync(30);
          const arrived = await pollUntil(() => seen.length >= 1, 300, 10);
          if (arrived) break;
        }
        expect(seen.length).toBeGreaterThanOrEqual(1);
        expect(vi.getTimerCount()).toBe(1); // 假时钟下有且仅有一个轮询句柄（空转即测失明）
        sched.dispose();
        expect(vi.getTimerCount()).toBe(0); // 句柄已释放：不清 clearInterval 即泄漏，此断言红
        // #929：dispose 前在飞 tick 可能落定在后（setInterval 丢弃 promise，假时钟跟踪不到），
        // 快照前排空旧 tick，最多 60×100ms（R2b 62% 复现率下 R4 240/240 绿实证）。
        for (let q = 0; q < 60; q += 1) {
          const n = seen.length;
          const grown = await pollUntil(() => seen.length > n, 100, 10);
          if (!grown) break;
        }
        const atDispose = seen.length;
        await vi.advanceTimersByTimeAsync(150);
        expect(seen.length).toBe(atDispose);
        // 真时钟泄漏窗：若实现另起真实定时器fallback，此窗内必触发而失败——
        // 否定式条件等待（pollUntil 语义），不用固定 sleep 假设静默。
        const leaked = await pollUntil(() => seen.length > atDispose, 200, 10);
        expect(leaked).not.toBe(true);
      } finally {
        sched.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("toFake 面显式声明（裸 useFakeTimers 入文件必须红）", () => {
    const selfSrc = readFileSync(join(here, "composition-root.test.ts"), "utf8");
    expect(selfSrc.includes('toFake: ["setInterval", "clearInterval"]')).toBe(true);
  });

  it("本文件无裸 sleep（等待面唯一是 pollUntil + 假时钟推进）", () => {
    const marker = ["new Promise((r) => set", "Timeout"].join("");
    const selfSrc = readFileSync(join(here, "composition-root.test.ts"), "utf8");
    expect(selfSrc.includes(marker)).toBe(false);
  });
});

describe("#1010 B2b coordinator/scheduler/queue 纵向切片", () => {
  it("commitSuccess 在同一 root 锁内单调推进 lastRun 并清理 claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-coordinator-"));
    try {
      const now = 1_000;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-b2b",
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const claim = await coordinator.beginAttempt(
        {
          period: "daily",
          key: "2026-09-23",
          startDay: "2026-09-23",
          endDay: "2026-09-23",
          route: { provider: "generic-provider", model: "generic-model" },
        },
        now,
      );
      if (claim === null) throw new Error("expected claim");
      await writeLastRun(root, { daily: "2026-09-24" });
      expect(
        await coordinator.commitSuccess({
          claim,
          result: { meta: { period: "daily", key: "2026-09-23" } },
          persist: async () => undefined,
        }),
      ).toBe(true);
      expect((await readLastRun(root)).daily).toBe("2026-09-24");
      expect(await ledger.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcileIndex 只让同 cycle 成功事实清 waiting；异 cycle token 丢弃", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-index-cycle-"));
    try {
      const now = 1_000;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-index-success",
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const claim = await coordinator.beginAttempt(seed, now);
      if (claim === null) throw new Error("expected claim");
      const waiting = await coordinator.recordFailure(
        claim,
        { code: "transient", kind: "transient" },
        now,
      );
      if (waiting === null) throw new Error("expected waiting claim");

      expect(
        await coordinator.reconcileIndex({
          period: seed.period,
          key: seed.key,
          indexed: true,
          cycleId: "cycle-other",
        }),
      ).toBe(false);
      expect(await coordinator.get(seed.period, seed.key)).toEqual(waiting);
      expect(await readLastRun(root)).toEqual({});

      expect(
        await coordinator.reconcileIndex({
          period: seed.period,
          key: seed.key,
          indexed: true,
          cycleId: waiting.cycleId,
        }),
      ).toBe(true);
      expect((await readLastRun(root)).daily).toBe(seed.key);
      expect(await coordinator.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("周期 reconcile 的旧 index token 不能清新 force；同 cycle token 才能清", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-reconcile-cycle-"));
    try {
      const now = 1_000;
      let sequence = 0;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const oldClaim = await coordinator.beginAttempt(seed, now);
      if (oldClaim === null) throw new Error("expected old claim");
      const forced = await coordinator.beginForce(seed, now + 1);
      const before = { daily: "2026-09-22" };
      await updateLastRun(root, () => before);

      await coordinator.reconcile(before, [
        { period: seed.period, key: seed.key, cycleId: oldClaim.cycleId },
      ]);
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forced);
      expect(await readLastRun(root)).toEqual(before);

      await coordinator.reconcile(before, [
        { period: seed.period, key: seed.key, cycleId: forced.cycleId },
      ]);
      expect(await coordinator.list()).toEqual([]);
      expect((await readLastRun(root)).daily).toBe(seed.key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcile 在锁内基于最新 lastRun 合并，旧快照不能回退较新窗口", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-reconcile-monotonic-"));
    try {
      const now = 1_000;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-reconcile",
      });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const claim = await ledger.beginAttempt(seed, now);
      if (claim === null) throw new Error("expected claim");
      let current: Partial<Record<"daily" | "weekly" | "monthly", string>> = {
        daily: "2026-09-24",
      };
      const coordinator = createReportStateCoordinator({
        root,
        ledger,
        readLastRun: async () => current,
        updateLastRun: async (_root, patch) => {
          current = await patch(current);
        },
        now: () => now,
      });
      await coordinator.reconcile({ daily: "2026-09-22" }, [
        { period: "daily", key: "2026-09-23" },
      ]);
      expect(current.daily).toBe("2026-09-24");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "同 cycle",
      indexCycleId: "cycle-apply-current",
      ledgerCycleId: "cycle-apply-current",
      cleared: true,
    },
    {
      label: "异 cycle",
      indexCycleId: "cycle-apply-old",
      ledgerCycleId: "cycle-apply-current",
      cleared: false,
    },
    {
      label: "无 cycleId 的旧 index",
      indexCycleId: undefined,
      ledgerCycleId: "cycle-apply-legacy",
      cleared: false,
    },
  ])(
    "真实 apply 组合根恢复 $label：lastRun 推进且只清同 cycle",
    async ({ indexCycleId, ledgerCycleId, cleared }) => {
      const root = mkdtempSync(join(tmpdir(), "b2b-apply-index-cycle-"));
      let disposers: Array<() => void | Promise<void>> = [];
      try {
        const now = Date.UTC(2026, 8, 24, 0, 0, 0);
        const ledger = createRetryLedger(root, {
          now: () => now,
          createCycleId: () => ledgerCycleId,
        });
        const seed = {
          period: "daily" as const,
          key: "2026-09-23",
          startDay: "2026-09-23",
          endDay: "2026-09-23",
          route: { provider: "generic-provider", model: "generic-model" },
        };
        const claim = await ledger.beginAttempt(seed, now);
        if (claim === null) throw new Error("expected in-flight claim");
        expect(claim.entry.phase).toBe("in-flight");

        mkdirSync(join(root, "reports"), { recursive: true });
        // 已完成存储升级，避免 upgrade 链先行按历史 index 校准 last-run；
        // 本用例只钉 ReportScheduler recovery → coordinator.reconcile 的 cycle 门。
        writeFileSync(join(root, ".upgrade-version"), "0.2.5\n");
        writeFileSync(
          join(root, "reports", "last-run.json"),
          JSON.stringify({ schema: LAST_RUN_SCHEMA }),
        );
        writeFileSync(
          join(root, "reports", "index.jsonl"),
          `${JSON.stringify({
            period: seed.period,
            key: seed.key,
            startDay: seed.startDay,
            endDay: seed.endDay,
            provider: seed.route.provider,
            model: seed.route.model,
            generatedAt: now + 1,
            durationMs: 0,
            ok: true,
            cycleId: indexCycleId,
          })}\n`,
        );
        __clearReportIndexCacheForTests();
        expect((await readReportIndex(root))[0]?.cycleId).toBe(indexCycleId);

        const context = makeApplyTestContext();
        disposers = context.disposers;
        await apply(context.ctx, {
          autoReload: false,
          apiKey: "sk-test",
          apiEndpoint: "http://127.0.0.1:9",
          historyDir: root,
        });

        const entries = await ledger.list();
        if (cleared) {
          expect(await readLastRun(root)).toEqual({ daily: seed.key });
          expect(entries).toEqual([]);
        } else {
          expect(await readLastRun(root)).toEqual({});
          expect(entries).toHaveLength(1);
          expect(entries[0]?.cycleId).toBe(ledgerCycleId);
          expect(entries[0]?.phase).toBe("waiting");
          expect(entries[0]?.terminal).toBe(false);
        }
      } finally {
        for (const dispose of [...disposers].reverse()) {
          try {
            await dispose();
          } catch {
            // 组合根清理不应掩盖恢复断言
          }
        }
        __clearReportIndexCacheForTests();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("legacy index 无 cycleId 且无 live ledger 时只推进一次 lastRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-legacy-index-only-"));
    const now = Date.UTC(2026, 8, 24, 0, 0, 0);
    const key = "2026-09-23";
    try {
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(
        join(root, "reports", "index.jsonl"),
        `${JSON.stringify({
          period: "daily",
          key,
          startDay: key,
          endDay: key,
          provider: "generic-provider",
          model: "generic-model",
          generatedAt: now,
          durationMs: 0,
          ok: true,
        })}\n`,
      );
      const ledger = createRetryLedger(root, { now: () => now });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seen: string[] = [];
      const scheduler = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false },
          monthly: { enabled: false },
        }),
        coordinator,
        listIndexed: async () => [{ period: "daily", key }],
        now: () => now,
        onDue: async (due) => {
          seen.push(due.key);
        },
        tickMs: 60_000,
        warn: quietWarn,
      });
      try {
        await scheduler.ready;
        await scheduler.tick();
        expect(seen).toEqual([]);
        expect(await readLastRun(root)).toEqual({ daily: key });
        expect(await ledger.list()).toEqual([]);
      } finally {
        scheduler.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciliation 清掉 indexed key 后不重复提交当前候选", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-indexed-stale-"));
    try {
      const now = Date.UTC(2026, 8, 24, 0, 0, 0);
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-indexed",
      });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const claim = await ledger.beginAttempt(seed, now);
      if (claim === null) throw new Error("expected claim");
      const waiting = await ledger.recordFailure(
        claim,
        { code: "transient", kind: "transient" },
        now,
      );
      if (waiting === null) throw new Error("expected waiting");
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seen: Array<{ key: string }> = [];
      const scheduler = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false },
          monthly: { enabled: false },
        }),
        coordinator,
        listIndexed: async () => [{ period: "daily", key: "2026-09-23", cycleId: "cycle-indexed" }],
        now: () => now + 60_000,
        onDue: async (due) => {
          seen.push({ key: due.key });
        },
        tickMs: 60_000,
        warn: quietWarn,
      });
      try {
        await scheduler.ready;
        expect(seen).toEqual([]);
        await scheduler.tick();
        expect(seen).toEqual([]);
      } finally {
        scheduler.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovery 完成前 tick 不提交；ready 后跨日 waiting ledger 与当前候选合并", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-scheduler-ready-"));
    try {
      const now = Date.UTC(2026, 8, 24, 0, 0, 0);
      let cycle = 0;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(cycle += 1)}`,
      });
      const seed = {
        period: "daily" as const,
        key: "2026-09-22",
        startDay: "2026-09-22",
        endDay: "2026-09-22",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const first = await ledger.beginAttempt(seed, now);
      if (first === null) throw new Error("expected first claim");
      const failed = await ledger.recordFailure(
        first,
        { code: "transient", kind: "transient" },
        now,
      );
      if (failed === null) throw new Error("expected waiting");
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seen: Array<{ key: string }> = [];
      const scheduler = ReportScheduler.start({
        root,
        config: normalizeReportConfig({
          daily: { enabled: true, time: "00:00" },
          weekly: { enabled: false },
          monthly: { enabled: false },
        }),
        coordinator,
        listIndexed: async () => [],
        now: () => now + 60_000,
        onDue: async (due) => {
          seen.push({ key: due.key });
        },
        tickMs: 60_000,
        warn: quietWarn,
      });
      try {
        await scheduler.tick();
        expect(seen).toEqual([]);
        await scheduler.ready;
        await pollUntil(() => seen.length >= 1, 3000);
        expect(seen.map((item) => item.key)).toEqual(["2026-09-23", "2026-09-22"]);
      } finally {
        scheduler.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无 cycleId 的旧 task 不能消费 force cycle；force task 以真实 cycle 唯一单飞", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-force-cycle-race-"));
    try {
      const now = 1_000;
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => "cycle-force",
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });

      const oldTaskExisting = await coordinator.get(seed.period, seed.key);
      expect(oldTaskExisting).toBeUndefined();
      const forced = await coordinator.beginForce(seed, now);
      expect(forced).toMatchObject({ cycleId: "cycle-force", phase: "waiting" });

      const resolved = {
        status: "success" as const,
        route: { provider: "resolved-provider", model: "resolved-model" },
      };
      expect(
        await coordinator.beginAttempt(
          {
            period: seed.period,
            key: seed.key,
            startDay: seed.startDay,
            endDay: seed.endDay,
            route: resolved.route,
          },
          now + 1,
        ),
      ).toBeNull();
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forced);

      const forceTaskExisting = await coordinator.get(seed.period, seed.key);
      if (forceTaskExisting === undefined) throw new Error("expected forced cycle");
      const forceClaim = await coordinator.beginAttempt(
        {
          period: seed.period,
          key: seed.key,
          startDay: seed.startDay,
          endDay: seed.endDay,
          route: forceTaskExisting.route,
          cycleId: forceTaskExisting.cycleId,
        },
        now + 1,
      );
      if (forceClaim === null) throw new Error("expected forced claim");
      expect(forceClaim.cycleId).toBe(forced.cycleId);
      expect(forceClaim.entry.phase).toBe("in-flight");
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forceClaim.entry);
      expect((await coordinator.list()).filter((entry) => entry.phase === "in-flight")).toEqual([
        forceClaim.entry,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force 覆盖后旧 task 携带旧 cycle token 仍被真实 CAS 拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-old-cycle-cas-"));
    try {
      const now = 1_000;
      let sequence = 0;
      const ledger = createRetryLedger(root, {
        now: () => now,
        createCycleId: () => `cycle-${(sequence += 1)}`,
      });
      const coordinator = createReportStateCoordinator({ root, ledger, now: () => now });
      const seed = {
        period: "daily" as const,
        key: "2026-09-23",
        startDay: "2026-09-23",
        endDay: "2026-09-23",
        route: { provider: "generic-provider", model: "generic-model" },
      };
      const oldClaim = await coordinator.beginAttempt(seed, now);
      if (oldClaim === null) throw new Error("expected old claim");
      const forced = await coordinator.beginForce(seed, now + 1);
      expect(oldClaim.cycleId).toBe("cycle-1");
      expect(forced.cycleId).toBe("cycle-2");

      expect(
        await coordinator.beginAttempt({ ...seed, cycleId: oldClaim.cycleId }, now + 1),
      ).toBeNull();
      expect(await coordinator.get(seed.period, seed.key)).toEqual(forced);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("running 任务收到 force 时先 durable prepare，再排后续 cycle", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        order.push(`start:${input.key}:${input.force === true ? "force" : "normal"}`);
        if (order.length === 1) await gate;
        order.push(`end:${input.key}:${input.force === true ? "force" : "normal"}`);
        return {};
      },
      prepareForce: async (input) => {
        order.push(`prepare:${input.key}`);
      },
      warn: quietWarn,
    });
    const first = queue.submit({ period: "daily", key: "K1", startDay: "K1", endDay: "K1" });
    await pollUntil(() => order.includes("start:K1:normal"), 3000);
    const forced = await queue.submitForce({
      period: "daily",
      key: "K1",
      startDay: "K1",
      endDay: "K1",
      force: true,
    });
    expect(forced.taskId).not.toBe(first.taskId);
    expect(order).toEqual(["start:K1:normal", "prepare:K1"]);
    release();
    await pollUntil(() => order.includes("end:K1:force"), 3000);
    expect(order).toEqual([
      "start:K1:normal",
      "prepare:K1",
      "end:K1:normal",
      "start:K1:force",
      "end:K1:force",
    ]);
  });

  it("prepare gate 内同 key normal 不会 claim force cycle；其它 key 仍可运行", async () => {
    const root = mkdtempSync(join(tmpdir(), "b2b-force-pending-reservation-"));
    try {
      const now = 2_000;
      const claimNow = now + 2;
      const route = { provider: "generic-provider", model: "generic-model" };
      const dateKeys = {
        K0: "2026-09-01",
        K1: "2026-09-02",
        K2: "2026-09-03",
      } as const;
      const inputFor = (label: keyof typeof dateKeys): ReportTaskInput => {
        const key = dateKeys[label];
        return {
          period: "daily",
          key,
          startDay: key,
          endDay: key,
        };
      };
      const seed = {
        ...inputFor("K1"),
        route,
      };
      const ledger = createRetryLedger(root, { now: () => now });

      let markK0Started: () => void = () => undefined;
      const k0Started = new Promise<void>((resolve) => {
        markK0Started = resolve;
      });
      let releaseK0: () => void = () => undefined;
      const k0Gate = new Promise<void>((resolve) => {
        releaseK0 = resolve;
      });
      let markK0Done: () => void = () => undefined;
      const k0Done = new Promise<void>((resolve) => {
        markK0Done = resolve;
      });
      let markK2Done: () => void = () => undefined;
      const k2Done = new Promise<void>((resolve) => {
        markK2Done = resolve;
      });
      let markPrepareStarted: () => void = () => undefined;
      const prepareStarted = new Promise<void>((resolve) => {
        markPrepareStarted = resolve;
      });
      let releaseBeginForce: () => void = () => undefined;
      const beginForceGate = new Promise<void>((resolve) => {
        releaseBeginForce = resolve;
      });
      let markForceEntryCreated: () => void = () => undefined;
      const forceEntryCreated = new Promise<void>((resolve) => {
        markForceEntryCreated = resolve;
      });
      let releaseFinishForce: () => void = () => undefined;
      const finishForceGate = new Promise<void>((resolve) => {
        releaseFinishForce = resolve;
      });
      let markForceDone: () => void = () => undefined;
      const forceDone = new Promise<void>((resolve) => {
        markForceDone = resolve;
      });
      const executorCalls: Array<{ key: string; force: boolean; cycleId?: string }> = [];
      let forceCycleId: string | undefined;

      const queue = new ReportTaskQueue({
        executor: async (input) => {
          if (input.key === dateKeys.K0 && input.force !== true) {
            markK0Started();
            await k0Gate;
          }
          const existing = await ledger.get(input.period, input.key);
          const claim = await ledger.beginAttempt(claimInputFor(input, existing, route), claimNow);
          executorCalls.push({
            key: input.key,
            force: input.force === true,
            cycleId: claim?.cycleId,
          });
          if (claim === null) throw new Error("expected ledger claim");
          signalMilestone(input, dateKeys, {
            k0: markK0Done,
            k2: markK2Done,
            force: markForceDone,
          });
          return {};
        },
        prepareForce: async () => {
          markPrepareStarted();
          await beginForceGate;
          const forced = await ledger.beginForce(seed, now);
          forceCycleId = forced.cycleId;
          markForceEntryCreated();
          await finishForceGate;
        },
        warn: quietWarn,
      });

      queue.submit(inputFor("K0"));
      await k0Started;
      const queuedNormal = queue.submit(inputFor("K1"));
      const forcePromise = queue.submitForce({ ...inputFor("K1"), force: true });
      await prepareStarted;

      const normalDuringPrepare = queue.submit(inputFor("K1"));
      expect(normalDuringPrepare.taskId).toBe(queuedNormal.taskId);
      expect(normalDuringPrepare.existing).toBe(true);
      expect(queue.get(normalDuringPrepare.taskId)?.status).toBe("queued");
      const other = queue.submit(inputFor("K2"));
      expect(other.existing).toBe(false);

      // The ledger force entry exists before prepare resolves. A queued normal
      // task must not get a chance to read and consume that cycle.
      releaseBeginForce();
      await forceEntryCreated;
      expect(forceCycleId).toBeDefined();
      releaseK0();
      await k0Done;
      await k2Done;
      expect(executorCalls).toHaveLength(2);
      expect(executorCalls[0]).toMatchObject({ key: dateKeys.K0, force: false });
      expect(executorCalls[1]).toMatchObject({ key: dateKeys.K2, force: false });
      expect(executorCalls.some((call) => call.key === dateKeys.K1)).toBe(false);
      expect(executorCalls[0]?.cycleId).not.toBe(forceCycleId);

      releaseFinishForce();
      const forced = await forcePromise;
      expect(forced).toEqual({ taskId: queuedNormal.taskId, existing: true });
      await forceDone;
      await pollUntil(() => queue.get(queuedNormal.taskId)?.status === "done", 3000);
      expect(executorCalls).toHaveLength(3);
      expect(executorCalls[2]).toEqual({ key: dateKeys.K1, force: true, cycleId: forceCycleId });
      expect((await ledger.get("daily", dateKeys.K1))?.cycleId).toBe(forceCycleId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不同 key 的 force prepare 仍按 forceTail 串行", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        order.push(`execute:${input.key}`);
        return {};
      },
      prepareForce: async (input) => {
        order.push(`prepare-start:${input.key}`);
        if (input.key === "A") {
          markFirstStarted();
          await firstGate;
        }
        order.push(`prepare-end:${input.key}`);
      },
      warn: quietWarn,
    });
    const input = (key: string): ReportTaskInput => ({
      period: "daily",
      key,
      startDay: key,
      endDay: key,
      force: true,
    });

    const first = queue.submitForce(input("A"));
    await firstStarted;
    const second = queue.submitForce(input("B"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order.filter((item) => item.startsWith("prepare-"))).toEqual(["prepare-start:A"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order.filter((item) => item.startsWith("prepare-"))).toEqual([
      "prepare-start:A",
      "prepare-end:A",
      "prepare-start:B",
      "prepare-end:B",
    ]);
    await pollUntil(() => order.filter((item) => item.startsWith("execute:")).length === 2, 3000);
    expect(order.filter((item) => item.startsWith("execute:"))).toEqual(["execute:A", "execute:B"]);
  });

  it("force prepare rejection 后 normal fallback 解锁且 placeholder 不残留", async () => {
    const calls: Array<{ force: boolean }> = [];
    let releasePrepare: () => void = () => undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let markPrepareStarted: () => void = () => undefined;
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    let markNormalDone: () => void = () => undefined;
    const normalDone = new Promise<void>((resolve) => {
      markNormalDone = resolve;
    });
    const queue = new ReportTaskQueue({
      executor: async (input) => {
        calls.push({ force: input.force === true });
        markNormalDone();
        return {};
      },
      prepareForce: async () => {
        markPrepareStarted();
        await prepareGate;
        throw new Error("prepare rejected");
      },
      warn: quietWarn,
    });
    const input: ReportTaskInput = {
      period: "daily",
      key: "fallback",
      startDay: "fallback",
      endDay: "fallback",
    };

    const forcePromise = queue.submitForce({ ...input, force: true });
    const outcome = forcePromise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await prepareStarted;
    const normal = queue.submit(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(normal.existing).toBe(true);
    expect(queue.get(normal.taskId)?.status).toBe("queued");
    expect(calls).toEqual([]);

    releasePrepare();
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected force preparation rejection");
    expect(result.error).toMatchObject({ message: "prepare rejected" });
    await normalDone;
    await pollUntil(() => queue.get(normal.taskId)?.status === "done", 3000);
    expect(queue.get(normal.taskId)?.force).toBe(false);
    expect(calls).toEqual([{ force: false }]);

    const retry = queue.submit(input);
    expect(retry.taskId).not.toBe(normal.taskId);
    expect(retry.existing).toBe(false);
    await pollUntil(() => queue.get(retry.taskId)?.status === "done", 3000);
    expect(calls).toEqual([{ force: false }, { force: false }]);
  });
});
