/**
 * schedule 组合根：D2三-链 per-root 防 lost-update + ensure 经链交错 + 60s tick/5min 预热汇入 getStats。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import {
  ReportScheduler,
  readLastRun,
  writeLastRun,
  updateLastRun,
  ensureLastRunMigrated,
  LAST_RUN_SCHEMA,
} from "../../../src/server/schedule/interface.ts";
import { normalizeReportConfig } from "../../../src/server/config/interface.ts";
import { parseReportIndexLines } from "../../../src/server/execute/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/shared/config.ts";
import type { ScheduleIndexParser, ScheduleWarn } from "../../../src/server/schedule/deps.ts";
import type { ReportPeriod } from "../../../src/server/config/interface.ts";

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
const quietWarn: ScheduleWarn = () => undefined;

/**
 * C 波端口锚定（tsc 双向锁定可赋值性，误配即编译红）：
 * 真实现可赋给端口（execute→schedule 注入方向），端口输出可喂推导。
 */
const scheduleParser: ScheduleIndexParser = parseReportIndexLines;

/** 链路段仍须原入口读出的 src 文本（判据 = store/scheduler 直写即回退）。 */
export interface ScheduleChainSources {
  schedulerSrc: string;
  storeSrc: string;
  applySrcFlat: string;
}

export function registerScheduleChainCases(src: ScheduleChainSources): void {
  registerNaiveQueueControl();
  registerSchedulePerRootCases();
  registerScheduleEnsureCases(src);
  registerSchedulePollCases(src);
}

function registerNaiveQueueControl(): void {
  // 顶层 it 对照：原入口里它注册在 D2三-锁 之后、D2三-链 per-root 之前（vitest 按
  // 注册序收集顶层 it，原 baseline index 44 即实证）。放在 register 体内而非模块顶层，
  // 是为了让父入口「先 identity（D2三-锁）后 chain」的调用时序原样兑现——模块顶层会
  // 在 import 求值期就注册，跑到全部 describe 之前。
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
}

function registerSchedulePerRootCases(): void {
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
          ) =>
            Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
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
}

function registerScheduleEnsureCases(src: ScheduleChainSources): void {
  const { schedulerSrc, storeSrc } = src;
  describe("D2三-链 ensure经链：校准与并发推进交错不丢更新（#771⑧）", () => {
    registerScheduleEnsureSourceCases(storeSrc, schedulerSrc);
    registerScheduleEnsureInterleaveCase();
    registerScheduleEnsureStartupCase();
  });
}

function registerScheduleEnsureSourceCases(storeSrc: string, schedulerSrc: string): void {
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
}

function registerScheduleEnsureInterleaveCase(): void {
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
      // holder 是否仍卡在 gate（=仍在临界区内，未提交）：交错窗是否真开着的观测量。
      let holderParked = true;
      let releaseGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      // 先占链并在 patch 内挂起：校准 patch 排到后面（#764 式交错窗）。
      const holder = updateLastRun(root, async (cur) => {
        started = true;
        await gate;
        holderParked = false;
        return { ...cur, weekly: "B" };
      });
      // 占链超时即环境病态：fail-fast 就地暴露（对齐 pollUntilJsonlReady 纪律），
      // 不带着「holder 从未进临界区」继续跑，让后面的断言错位红。
      expect(await pollUntil(() => started, 3000)).toBe(true);
      // 交错窗开在 index 解析端口上：端口被调用恰好落在「两次读完成之后、提交之前」，
      // 此刻 holder 仍卡在 gate，两个写者同时在飞。等待面只认可观测条件——固定时长
      // 等待在此等于零等待（pollUntil 对恒真条件立即返回），开窗时刻一旦交给 fs
      // 调度，慢盘上校准会在 holder 落盘之后才入链，两写根本不重叠。
      let factsRead = false;
      let openedWhileHolderParked = false;
      const openingParser: ScheduleIndexParser = (raw) => {
        factsRead = true;
        openedWhileHolderParked = holderParked;
        return scheduleParser(raw);
      };
      const ensuring = ensureLastRunMigrated(root, quietWarn, openingParser);
      // 端口缺席视同校准没读事实（#768 C 波：缺端口=无 index 事实），同样 fail-fast。
      expect(await pollUntil(() => factsRead, 3000)).toBe(true);
      releaseGate();
      const res = await ensuring;
      await holder;
      const fin = await readLastRun(root);
      expect(res.changed).toBe(true);
      // 开窗判据一：校准读事实的那一刻，并发推进仍卡在 gate（两个写者同时在飞）。
      // 缺这条，窗口塌成「holder 先落盘、校准再入链」的串行也照样绿——本用例退化成
      // 普通校准用例，#764 类 lost-update 回归对它失明。
      expect(openedWhileHolderParked).toBe(true);
      // 开窗判据二：校准的链外快照早于并发推进的落盘写（快照里还没有 weekly:"B"）。
      expect(res.before).toEqual({ daily: "2026-09-06", monthly: "2026-08" });
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
}

function registerScheduleEnsureStartupCase(): void {
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
      // 校准失败是**静默 no-op**：ensureLastRunMigrated 吞掉异常只打一行诊断就返回
      // changed:false（store.ts），而 scheduler 在 finally 里照常点首轮 tick——所以
      // 「tick 到了」并不蕴含「校准生效」。诊断必须留在这里：上一轮它被 quietWarn 吞掉，
      // CI 上只留下一个读不懂的日期不匹配，无从复盘。
      const warnings: string[] = [];
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
        warn: (msg) => warnings.push(String(msg)),
        // C 波：启动校准的 index 解析经端口注入（缺端口视同无事实）。
        parseIndex: scheduleParser,
      });
      try {
        // 等待面盯**被断言的那个事实**（校准落盘），不是等 tick：pollUntil 对恒真条件
        // 立即返回，等 tick 会在校准静默 no-op 时立刻放行，随后读到未校准的种子键。
        // pollUntil 超时返回 undefined 而不抛，故必须断言其返回值，否则失败会被吞。
        const calibrated = await pollUntil(
          async () => (await readLastRun(root)).daily === "2026-09-04",
          5000,
        );
        expect(calibrated, `校准未在 5s 内落盘（诊断：${warnings.join(" | ") || "无"}）`).toBe(
          true,
        );
        await pollUntil(() => seen.length >= 1, 5000);
        expect(
          seen.length,
          `首轮补跑未发生（诊断：${warnings.join(" | ") || "无"}）`,
        ).toBeGreaterThan(0);
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
}

function registerSchedulePollCases(src: ScheduleChainSources): void {
  const { schedulerSrc, storeSrc, applySrcFlat } = src;
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
}
