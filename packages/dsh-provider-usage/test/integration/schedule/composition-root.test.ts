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
 * 扫描面 = src/apply/apply.ts + src/apply/interface.ts（装配逻辑）
 * + 各消费方源文件（执行器/读侧/路由/迁移）：src/apply/index.ts 是 lib 导出面
 * （符号转发），不是判断——它的符号集由 export-surface-snapshot 门禁锁定，
 * 不在本用例扫描面内（误扫即把转发当判断）。
 *
 * 每条附判据句（把 X 改坏必须红）；红证明见同文件“探针：脏输入必被 flag”与
 * “对照：朴素实现丢更新（链断即丢）”——同一 detector 在脏夹具上必须报出
 * 违规，detector 失明则探针先红。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  ReportScheduler,
  ReportTaskQueue,
  readLastRun,
  writeLastRun,
  updateLastRun,
  candidateWindow,
  pendingReports,
  LAST_RUN_SCHEMA,
} from "../../../src/server/schedule/interface.ts";
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
  LAST_RUN_SCHEMA as ImplSchema,
} from "../../../src/server/schedule/due.ts";
import * as scheduleDepsNs from "../../../src/server/schedule/deps.ts";
import type { ScheduleClock, ScheduleWarn } from "../../../src/server/schedule/deps.ts";
import { normalizeReportConfig } from "../../../src/server/config/interface.ts";
import type { ReportPeriod } from "../../../src/server/config/interface.ts";
import type { ReportTaskInput } from "../../../src/server/schedule/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/shared/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "interface.ts"), "utf8");
const schedulerSrc = readFileSync(join(srcDir, "server", "schedule", "scheduler.ts"), "utf8");
const storeSrc = readFileSync(join(srcDir, "server", "schedule", "store.ts"), "utf8");
const commonFaceSrc = readFileSync(join(srcDir, "domain2", "common", "interface.ts"), "utf8");
const executorSrc = readFileSync(join(srcDir, "domain2", "execute", "executor.ts"), "utf8");
const runnerSrc = readFileSync(join(srcDir, "domain2", "execute", "runner.ts"), "utf8");
const reportsSrc = readFileSync(join(srcDir, "domain2", "routes", "reports.ts"), "utf8");
const morphSrc = readFileSync(join(srcDir, "server", "upgrade", "last-run-morph.ts"), "utf8");
const storageLayoutSrc = readFileSync(
  join(srcDir, "server", "upgrade", "storage-layout.ts"),
  "utf8",
);

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
const quietWarn: ScheduleWarn = () => undefined;
const testClock: ScheduleClock = () => Date.now();

/** 根内禁入业务判断标记：判据 = 任一标记进入 apply.ts/interface.ts 即红。 */
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
      applySrc.includes('import { ReportScheduler } from "../server/schedule/interface.ts";'),
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

  it("执行器的推进经调度门面（不走旧 common 入口）", () => {
    expect(executorSrc.includes("../../server/schedule/interface.ts")).toBe(true);
    expect(executorSrc.includes("domain2/schedule")).toBe(false);
    expect(executorSrc.includes("common/interface")).toBe(false);
  });

  it("读侧 DueReport 类型经调度门面（index 解析仍走 common 纯面）", () => {
    expect(runnerSrc.includes("../../server/schedule/interface.ts")).toBe(true);
    expect(runnerSrc.includes("../common/interface.ts")).toBe(true);
    expect(runnerSrc.includes("../schedule/")).toBe(false);
  });

  it("路由写侧经调度门面（不走旧入口）", () => {
    expect(reportsSrc.includes("../../server/schedule/interface.ts")).toBe(true);
    expect(reportsSrc.includes("domain2/schedule")).toBe(false);
    expect(reportsSrc.includes("../common/interface")).toBe(false);
  });

  it("迁移步纯函数经调度门面（不调业务实例）", () => {
    expect(morphSrc.includes('"../schedule/interface.ts"')).toBe(true);
    expect(morphSrc.includes("domain2/schedule")).toBe(false);
    const morphImports = morphSrc
      .split(String.fromCharCode(10))
      .filter((l) => l.startsWith("import"));
    expect(morphImports.some((l) => l.includes("readLastRun"))).toBe(false);
    expect(morphImports.some((l) => l.includes("updateLastRun"))).toBe(false);
    expect(morphImports.some((l) => l.includes("ensureLastRunMigrated"))).toBe(false);
  });

  it("存储布局的空落盘 schema 与调度域同源（单一定义）", () => {
    expect(storageLayoutSrc.includes("server/schedule/store.ts")).toBe(true);
    expect(storageLayoutSrc.includes("LAST_RUN_SCHEMA")).toBe(true);
  });

  it("common 门面不再转发 lastRun（单答案即单入口）", () => {
    expect(commonFaceSrc.includes("last-run")).toBe(false);
    expect(commonFaceSrc.includes("readLastRun")).toBe(false);
    expect(commonFaceSrc.includes("updateLastRun")).toBe(false);
  });
});

describe("D2二 根内无业务判断（必须红）", () => {
  for (const entry of BUSINESS_MARKERS) {
    it("apply.ts 无 " + entry.marker + "（" + entry.why + "）", () => {
      expect(applySrc.includes(entry.marker)).toBe(false);
    });
    it("apply/interface.ts 无 " + entry.marker, () => {
      expect(applyFaceSrc.includes(entry.marker)).toBe(false);
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

  it("预热线路汇入 getStats（断线即红）", () => {
    expect(applySrc.includes("void statsService.getStats(provider).catch(() => {});")).toBe(true);
    expect(applySrc.includes("const timer = setInterval(warmupFn, config.warmupIntervalMs);")).toBe(
      true,
    );
  });

  it("store 唯一跨域值导入是 common 纯解析（单向边，环保持断开）", () => {
    expect(storeSrc.includes("../../domain2/common/interface.ts")).toBe(true);
    expect(storeSrc.includes("parseReportIndexLines")).toBe(true);
    const storeImports = storeSrc
      .split(String.fromCharCode(10))
      .filter((l) => l.startsWith("import"));
    expect(storeImports.some((l) => l.includes("domain2/schedule"))).toBe(false);
    expect(storeImports.some((l) => l.includes("common/last-run"))).toBe(false);
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
