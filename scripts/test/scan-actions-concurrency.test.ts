import test from "node:test";
import assert from "node:assert/strict";

import { peakConcurrency } from "../maintenance/scan-actions-concurrency.mjs";

/**
 * peakConcurrency 的离线回归（#773 遗留项 R2）。
 *
 * 为什么需要它：这个函数曾是「变异 job max-parallel 取 8」的载荷输入，却一直没有单测；
 * 而它的输入过滤语义有一个极隐蔽的失效形态——被取消的 run 里那些**从未执行**的排队 job
 * 同样带 started_at / completed_at，裸算会把排队深度当成运行并发，峰值虚高（被取消 run
 * 实测 max=35，剔除后 11）。本文件把「按 conclusion 剔除」钉死，并锁住既有口径：
 *   - 无 cancelled 输入时，逐字段结果必须与修复前的历史实现逐位一致（回归保护）；
 *   - skipped / 零宽度 / 缺时间戳的 job 不占并发（既有行为，不得因本次改动松动）；
 *   - 饱和判据（peakAt / peakUntil / maxAfterPeak / heldSeconds）在含 cancelled 输入下
 *     仍按真实执行窗口算；
 *   - 判据是 conclusion 的**精确值** "cancelled"：大小写不敏感会让 GitHub 未来的枚举扩项
 *     静默改变口径。
 *
 * 时间线全部是自造的合成数据，全程离线：不调 gh、不联网、不读工作区。
 */

/** 测试构造的作业条目：字段都是可选的，以便照实覆盖缺时间戳 / 缺结论的 API 形态。 */
interface JobRecord {
  name?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/**
 * 修复前（commit `cede125`，即本 PR 的 base）的 peakConcurrency 逐行照抄。
 *
 * 为什么留一份副本：它的唯一用途是当「旧口径真值」——用来证明本次改动在无 cancelled 输入上
 * 零行为变化，并把「含 cancelled 时裸算会虚高」这个前提做成可执行断言（而不是注释里的传说）。
 * 生产代码里只有 peakConcurrency 一个实现，这份副本不参与任何调用链。
 *
 * #732 起为过复杂度门禁，函数体拆成 referenceEvents / referenceSweep 两个等价私有函数；
 * 算法与那份实现仍逐行一致，副本「不引用生产代码」的独立性不变。
 */
function referencePeakConcurrency(jobs: readonly JobRecord[]) {
  const events = referenceEvents(jobs);
  const { peak, peakAt, peakUntil, maxAfterPeak } = referenceSweep(events);
  return {
    peak,
    peakAt,
    peakUntil,
    countedJobs: events.filter((e) => e.delta === 1).length,
    maxAfterPeak,
    heldSeconds:
      peakUntil === null || peakAt === null ? 0 : Math.round((peakUntil - peakAt) / 1000),
  };
}

/** 事件序列（照抄修复前的过滤口径：缺时间戳 / 零宽度 job 不占并发）。 */
function referenceEvents(jobs: readonly JobRecord[]) {
  const events = [];
  for (const j of jobs) {
    if (!j.started_at || !j.completed_at) continue;
    const s = Date.parse(j.started_at);
    const e = Date.parse(j.completed_at);
    if (!(e > s)) continue; // skipped / 零宽度 job 不占并发
    events.push({ at: s, delta: 1, name: j.name });
    events.push({ at: e, delta: -1, name: j.name });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  return events;
}

/** 事件扫描（照抄修复前的饱和判据口径）。 */
function referenceSweep(events: { at: number; delta: number }[]): {
  peak: number;
  peakAt: number | null;
  peakUntil: number | null;
  maxAfterPeak: number;
} {
  let cur = 0;
  let peak = 0;
  let peakAt: number | null = null;
  let peakUntil: number | null = null;
  let maxAfterPeak = 0;
  for (const ev of events) {
    cur += ev.delta;
    if (cur > peak) {
      peak = cur;
      peakAt = ev.at;
      peakUntil = null;
    } else if (peakAt !== null && cur < peak && peakUntil === null) {
      peakUntil = ev.at;
    }
    if (peakUntil !== null) maxAfterPeak = Math.max(maxAfterPeak, cur);
  }
  return { peak, peakAt, peakUntil, maxAfterPeak };
}

/** 合成时间戳：2026-09-12T09:<ss>.000Z。 */
const T = (ss: string) => `2026-09-12T09:${ss}.000Z`;

/**
 * 一条被取消 run 的作业时间线。真实峰值是 3（09:00:20–09:00:30 三个真实 job 重叠），
 * 三个 cancelled job 的排队窗口（09:00:05–09:01:00 / 09:00:20–09:02:00 / 09:00:35–09:02:02）
 * 叠加进去后裸算峰值是 5（09:00:20 一刻三个真实 + 两个排队）——时间戳看起来完全正常，
 * 却把「排队等额度」算成了并发。另含 skipped、零宽度、反向区间与缺时间戳的 job，
 * 它们在任何口径下都不占并发。
 */
const CANCELLED_INFLATED = [
  { name: "real-a", started_at: T("00:00"), completed_at: T("00:30"), conclusion: "success" },
  { name: "real-b", started_at: T("00:10"), completed_at: T("00:40"), conclusion: "success" },
  { name: "real-c", started_at: T("00:20"), completed_at: T("00:50"), conclusion: "failure" },
  { name: "queued-1", started_at: T("00:05"), completed_at: T("01:00"), conclusion: "cancelled" },
  { name: "queued-2", started_at: T("00:20"), completed_at: T("02:00"), conclusion: "cancelled" },
  { name: "queued-3", started_at: T("00:35"), completed_at: T("02:02"), conclusion: "cancelled" },
  { name: "skipped-1", started_at: T("00:25"), completed_at: T("00:25"), conclusion: "skipped" },
  { name: "zero-width", started_at: T("00:27"), completed_at: T("00:27"), conclusion: "success" },
  { name: "inverted", started_at: T("00:28"), completed_at: T("00:26"), conclusion: "success" },
  { name: "never-started", started_at: null, completed_at: T("00:29"), conclusion: "skipped" },
  { name: "never-finished", started_at: T("00:31"), completed_at: null, conclusion: null },
];

test("①被取消 job 不得抬高峰值：裸算 5，过滤后必须是真实峰值 3", () => {
  const raw = referencePeakConcurrency(CANCELLED_INFLATED);
  assert.equal(raw.peak, 5, "前提复核：不过滤时三个 cancelled 排队窗口把裸峰值抬到 5");
  assert.equal(
    raw.peakAt,
    Date.parse(T("00:20")),
    "裸算的首达时间正是 cancelled 排队窗口叠加真实 job 那一刻",
  );
  assert.equal(
    raw.countedJobs,
    6,
    "前提复核：裸算把三个排队 job 也计入了并发（3 真实 + 3 cancelled）",
  );

  const r = peakConcurrency(CANCELLED_INFLATED);
  assert.equal(r.peak, 3, "峰值必须是真实执行 job 的并发数（3），不得被排队窗口抬高");
  assert.equal(r.countedJobs, 3, "三个 cancelled job 即便时间戳完整也不得计入并发");
  assert.equal(
    r.peakAt,
    Date.parse(T("00:20")),
    "峰值首达时间是 real-c 开始那一刻，不是 cancelled 窗口",
  );
  assert.equal(
    r.peakUntil,
    Date.parse(T("00:30")),
    "峰值维持到下一个真实事件（real-a 结束），期间三个真实 job 并行",
  );
  assert.equal(r.heldSeconds, 10);
  assert.equal(r.maxAfterPeak, 2, "峰值后上界 = 峰值处结束一个 job 后的运行数");

  // 过滤的等价性：把 cancelled job 从输入里整个删掉，结果必须逐字段相同——
  // 这条断言把「过滤」与「本来就没有 cancelled」绑死，覆盖面比逐个字段写死更宽。
  const withoutCancelled = CANCELLED_INFLATED.filter((j) => j.conclusion !== "cancelled");
  assert.deepEqual(
    peakConcurrency(withoutCancelled),
    r,
    "cancelled job 的存在不得对任何返回值产生可观测影响",
  );
});

test("②无 cancelled 时逐字段等于旧口径（回归保护）", () => {
  const plain = [
    { name: "a", started_at: T("00:00"), completed_at: T("00:30"), conclusion: "success" },
    { name: "b", started_at: T("00:10"), completed_at: T("00:40"), conclusion: "success" },
    { name: "c", started_at: T("00:20"), completed_at: T("00:50"), conclusion: "failure" },
    { name: "d", started_at: T("01:10"), completed_at: T("01:20"), conclusion: "success" },
    { name: "e", started_at: T("01:05"), completed_at: T("01:40"), conclusion: null },
  ];
  assert.deepEqual(
    peakConcurrency(plain),
    referencePeakConcurrency(plain),
    "无 cancelled 输入时每一位返回值都必须与历史实现一致",
  );

  const withNoise = [
    ...plain,
    { name: "skipped", started_at: T("02:00"), completed_at: T("02:00"), conclusion: "skipped" },
    { name: "no-times", started_at: null, completed_at: null, conclusion: "skipped" },
    { name: "no-start", started_at: null, completed_at: T("02:10"), conclusion: "success" },
    { name: "no-end", started_at: T("02:10"), completed_at: null, conclusion: "success" },
    {
      name: "epoch",
      started_at: "1970-01-01T00:00:00.000Z",
      completed_at: T("02:30"),
      conclusion: "success",
    },
  ];
  assert.deepEqual(peakConcurrency(withNoise), referencePeakConcurrency(withNoise));
  assert.equal(peakConcurrency(withNoise).countedJobs, 6, "epoch 零点起算的 job 仍是有效测量");
});

test("③skipped 与零宽度 job 不占并发（锁死既有行为）", () => {
  const onlyNoOps = [
    { name: "skipped", started_at: T("00:00"), completed_at: T("00:00"), conclusion: "skipped" },
    { name: "zero", started_at: T("00:10"), completed_at: T("00:10"), conclusion: "success" },
    { name: "inverted", started_at: T("00:20"), completed_at: T("00:10"), conclusion: "success" },
    { name: "no-start", started_at: null, completed_at: T("00:30"), conclusion: "success" },
    { name: "no-end", started_at: T("00:30"), completed_at: null, conclusion: "success" },
  ];
  assert.deepEqual(peakConcurrency(onlyNoOps), {
    peak: 0,
    peakAt: null,
    peakUntil: null,
    countedJobs: 0,
    maxAfterPeak: 0,
    heldSeconds: 0,
  });

  const withReal = [
    ...onlyNoOps,
    { name: "real", started_at: T("00:40"), completed_at: T("01:00"), conclusion: "success" },
  ];
  const r = peakConcurrency(withReal);
  assert.equal(r.peak, 1, "零宽度、反向区间与 skipped 不得与真实 job 叠加");
  assert.equal(r.countedJobs, 1);
  assert.equal(r.heldSeconds, 20);
});

test("④含 cancelled 输入下饱和判据仍按真实窗口算（峰位不得被排队窗口窃取）", () => {
  const input = [
    // cancelled 的排队窗口两端都超出真实执行窗口（09:00:00–09:00:30 与 09:00:30–09:02:00）
    {
      name: "queued-early",
      started_at: T("00:00"),
      completed_at: T("00:30"),
      conclusion: "cancelled",
    },
    { name: "real-a", started_at: T("00:10"), completed_at: T("00:40"), conclusion: "success" },
    { name: "real-b", started_at: T("00:20"), completed_at: T("00:50"), conclusion: "success" },
    {
      name: "queued-late",
      started_at: T("00:30"),
      completed_at: T("02:00"),
      conclusion: "cancelled",
    },
  ];
  const r = peakConcurrency(input);
  assert.equal(r.peak, 2, "峰值只数真实执行中的 job");
  assert.equal(r.countedJobs, 2);

  // 饱和三件套的每一位都必须等于「删掉 cancelled 之后」的结果
  const baseline = peakConcurrency(input.filter((j) => j.conclusion !== "cancelled"));
  assert.deepEqual(r, baseline, "cancelled 排队窗口不得改变饱和判据的任一位");
  assert.equal(r.peakAt, Date.parse(T("00:20")), "peakAt 是 real-b 开始的时刻");
  assert.equal(r.peakUntil, Date.parse(T("00:40")), "峰值维持区间按真实事件算（real-a 结束）");
  assert.equal(r.heldSeconds, 20, "heldSeconds 不得为负，也不得受 cancelled 窗口影响");
  assert.equal(r.maxAfterPeak, 1, "峰值后上界按真实窗口算（real-a 结束后的 real-b）");
});

// 残留风险（用例无法覆盖，需人工留意）：GitHub 若改用其它大小写形态，精确匹配会静默停止过滤，
// 而本用例仍绿——它锁的是「不得扩大过滤面」，不是「未来枚举一定小写」。
test("⑤过滤判据是精确值 cancelled：大小写变体不触发过滤（防大小写不敏感改坏）", () => {
  const input = [
    { name: "real", started_at: T("00:00"), completed_at: T("00:30"), conclusion: "success" },
    { name: "queued", started_at: T("00:00"), completed_at: T("01:00"), conclusion: "Cancelled" },
  ];
  assert.equal(
    peakConcurrency(input).peak,
    2,
    '只有精确的结论值 "cancelled" 才是过滤判据；大小写不敏感会静默扩大过滤面',
  );
});
